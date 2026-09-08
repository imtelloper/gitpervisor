use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::DirEntry;
use crate::state::AppState;

/// 프로젝트 내 한 디렉토리의 항목을 나열한다 (지연 로딩 — 폴더 펼칠 때 한 단계씩).
/// `rel_path`는 레포 루트 기준 상대 경로(빈 문자열이면 루트).
///
/// git 스폰 0회 — ignore 디밍은 레포당 캐시(§ignore-cache) 동기 조회다. 예전에는 리스팅마다
/// `git check-ignore`를 스폰했는데, 실측상 그 스폰이 폴더 펼침 지연의 전부였다
/// (바닥 60ms, 234GB 레포 1~3.5초 — DOCS/file-tree-performance-design.md §0).
#[tauri::command]
pub async fn list_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<Vec<DirEntry>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let items = read_dir_raw(&repo, &rel_path).await?;
    let entries = decorate_entries(state.inner(), &project_id, &rel_path, items);
    kick_ignore_refresh(&app, state.inner(), &project_id, repo);
    Ok(entries)
}

/// 여러 디렉토리를 invoke 1개로 배치 나열 — 프로젝트 전환/시작 시 저장된 확장 상태 워밍용
/// (설계 §3.1). 개별 실패(사라진 폴더 등)는 건너뛴다 — 배치 전체를 죽이지 않는다(roots 패턴).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub rel_path: String,
    pub entries: Vec<DirEntry>,
}

#[tauri::command]
pub async fn list_dirs(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_paths: Vec<String>,
) -> Result<Vec<DirListing>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let mut out = Vec::new();
    for rel in rel_paths.into_iter().take(200) {
        if let Ok(items) = read_dir_raw(&repo, &rel).await {
            out.push(DirListing {
                entries: decorate_entries(state.inner(), &project_id, &rel, items),
                rel_path: rel,
            });
        }
    }
    kick_ignore_refresh(&app, state.inner(), &project_id, repo);
    Ok(out)
}

/// Viewer 편집 저장 — 텍스트 파일 내용을 디스크에 쓴다. `rel_path`는 레포 루트 기준 상대 경로.
/// 경로 탈출(절대경로·`..`·`.git`)을 막고, 새 디렉토리는 만들지 않는다(기존 파일 편집 전제).
#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    content: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 상위 디렉토리를 정규화해 레포 안임을 보장(루트/드라이브 상대·정션 탈출 차단). 새 트리는 안 만든다.
    let target = resolve_in_repo(&repo, &rel_path)?;
    // 최종 경로 메타는 링크를 따라가지 않고 본다 — 기존 심볼릭/정션으로 레포 밖에 쓰지 못하게.
    if let Ok(meta) = tokio::fs::symlink_metadata(&target).await {
        if meta.file_type().is_symlink() {
            return Err(IpcError::new(ErrorCode::Io, "심볼릭 링크에는 쓸 수 없습니다"));
        }
        if meta.is_dir() {
            return Err(IpcError::new(ErrorCode::Io, "디렉토리에는 쓸 수 없습니다"));
        }
    }
    tokio::fs::write(&target, content).await.map_err(write_io_err)
}

/// 파일 쓰기 io 오류 → 사용자가 **다음 행동을 알 수 있는** IpcError.
///
/// `os error 5` 를 그대로 노출하면 원인에 도달할 방법이 없다. 실제로 이 저장소 사용자가
/// Windows 제어된 폴더 액세스(랜섬웨어 방지)에 막혔는데, 기본 보호 폴더가 문서·사진·비디오·
/// 바탕 화면이라 "비디오 폴더 밑 이미지 편집 저장"이 통째로 실패했다. 앱 로그에는 아무 단서가
/// 없고 원인은 Defender 이벤트 로그(1123)에만 남는다 — 그래서 여기서 짚어 준다.
/// dev 빌드와 설치본은 별개 exe 라 허용 목록에 각각 등록해야 한다.
fn write_io_err(e: std::io::Error) -> IpcError {
    if e.kind() != std::io::ErrorKind::PermissionDenied {
        return IpcError::new(ErrorCode::Io, format!("파일 저장 실패: {e}"));
    }
    let hint = if cfg!(windows) {
        concat!(
            "파일 저장 실패: 액세스가 거부되었습니다. Windows '제어된 폴더 액세스'",
            "(랜섬웨어 방지)가 차단했을 수 있습니다 — 문서·사진·비디오·바탕 화면이 기본 보호 대상입니다. ",
            "Windows 보안 › 랜섬웨어 방지에서 이 앱을 허용하거나 파일을 보호 폴더 밖으로 옮기세요. ",
            "(읽기 전용 파일이거나 다른 프로그램이 열고 있어도 같은 오류가 납니다.)",
        )
    } else {
        "파일 저장 실패: 권한이 없습니다. 파일·상위 폴더의 쓰기 권한을 확인하세요."
    };
    IpcError::new(ErrorCode::Io, hint)
}

/// 새 폴더 생성 — `rel_path`는 레포 루트 기준 상대 경로(만들 폴더 자신).
/// 상위 디렉토리가 존재해야 하고 같은 이름이 이미 있으면 거부한다.
/// 경로 탈출(빈 경로·절대경로·`..`·`.git`)을 막는다.
#[tauri::command]
pub async fn create_dir(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    if target.exists() {
        return Err(IpcError::new(
            ErrorCode::AlreadyExists,
            "같은 이름이 이미 있습니다",
        ));
    }
    tokio::fs::create_dir(&target)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("폴더 생성 실패: {e}")))
}

/// 새 파일 생성 — `rel_path`는 레포 루트 기준 상대 경로(만들 파일 자신, 확장자 포함).
/// 빈 파일을 만든다(에디터가 확장자로 구문강조를 구동). 상위 디렉토리가 존재해야 하고
/// 같은 이름이 이미 있으면 거부한다. 경로 탈출(빈 경로·절대경로·`..`·`.git`·예약 장치명)을 막는다.
#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    // create_new=true — 경합(TOCTOU)에서도 기존 파일을 절대 덮어쓰지 않는다(데이터 손실 방지).
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .await
    {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(IpcError::new(
            ErrorCode::AlreadyExists,
            "같은 이름이 이미 있습니다",
        )),
        Err(e) => Err(IpcError::new(ErrorCode::Io, format!("파일 생성 실패: {e}"))),
    }
}

/// 파일/폴더 삭제 — **파괴적**. 프론트의 확인 다이얼로그를 거친 뒤에만 호출된다.
/// 디렉토리는 재귀 삭제한다. 심볼릭 링크는 따라가지 않고 링크 자체만 지운다.
/// 루트(빈 경로)·`.git`·절대경로·`..`는 거부한다.
#[tauri::command]
pub async fn delete_path(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 상위 디렉토리를 정규화해 레포 안임을 보장(중간 정션/심볼릭으로 레포 밖 삭제 차단).
    let target = resolve_in_repo(&repo, &rel_path)?;
    // 링크를 따라가지 않는 메타데이터 — 링크된 디렉토리를 remove_dir_all로 따라 들어가지 않게.
    let meta = match tokio::fs::symlink_metadata(&target).await {
        Ok(m) => m,
        Err(_) => return Err(IpcError::new(ErrorCode::NotFound, "대상을 찾을 수 없습니다")),
    };
    let result = if meta.is_dir() {
        tokio::fs::remove_dir_all(&target).await
    } else {
        tokio::fs::remove_file(&target).await
    };
    result.map_err(|e| IpcError::new(ErrorCode::Io, format!("삭제 실패: {e}")))
}

/// 파일/폴더 이름 바꾸기 — **같은 상위 디렉토리 안에서 이름만** 바꾼다(다른 폴더로의 이동이 아니다).
/// 성공하면 새 레포-상대 경로(forward slash)를 돌려준다 — 프론트가 트리 펼침 상태·뷰어 탭을
/// 새 경로로 옮기는 데 쓴다. 경로 탈출(절대경로·`..`·`.git`·예약 장치명)은 원본·대상 **양쪽** 검증.
#[tauri::command]
pub async fn rename_path(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    new_name: String,
) -> Result<String, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let new_name = new_name.trim();
    // 구분자를 허용하면 이름 바꾸기가 아니라 '이동'이 된다 — 이 커맨드의 계약을 벗어나므로 거부.
    if new_name.contains('/') || new_name.contains('\\') {
        return Err(IpcError::new(
            ErrorCode::Io,
            "이름에 경로 구분자를 쓸 수 없습니다",
        ));
    }
    if new_name.is_empty() || new_name == "." || new_name == ".." {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 이름입니다"));
    }
    // 상위 디렉토리는 그대로 두고 마지막 컴포넌트만 교체한다(마지막 '/' 없으면 루트 바로 아래).
    let (parent, old_name) = match rel_path.rfind('/') {
        Some(i) => (&rel_path[..i], &rel_path[i + 1..]),
        None => ("", rel_path.as_str()),
    };
    let new_rel = join_rel(parent, new_name);
    let from = resolve_in_repo(&repo, &rel_path)?;
    let to = resolve_in_repo(&repo, &new_rel)?;
    // 존재 판정은 링크를 따라가지 않는다 — 심볼릭 링크 자체도 이름 변경 대상이다.
    if tokio::fs::symlink_metadata(&from).await.is_err() {
        return Err(IpcError::new(ErrorCode::NotFound, "대상을 찾을 수 없습니다"));
    }
    // 이름이 그대로면 파일시스템을 건드리지 않는다(대소문자까지 동일한 경우).
    if from == to {
        return Ok(new_rel);
    }
    // 상위 디렉토리가 달라지면 '이름 바꾸기'가 아니라 '이동'이다 — rel_path에 역슬래시가 섞여
    // 들어오면(`a\b.txt`) Windows에서 컴포넌트가 갈라져 parent 추출이 어긋나고 실제로 폴더를
    // 넘어간다. 조용히 옮기느니 거부한다.
    if from.parent() != to.parent() {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    if tokio::fs::symlink_metadata(&to).await.is_ok() {
        // 대소문자 무시 FS(Windows/macOS)에서는 여기서 "자기 자신"이 잡혀 정당한 대소문자
        // 변경(`Foo`→`foo`)이 막힌다. 그렇다고 대소문자만 다르면 무조건 통과시키면 대소문자
        // 구분 FS(Linux)에서 rename이 **같은 이름의 다른 파일**을 조용히 덮어써 그 파일이
        // 통째로 날아간다. 상위 디렉토리에 정확히 그 이름의 항목이 실제로 있는지로 둘을 가른다.
        let mut exact = true; // 스캔 불가(권한 등)면 충돌로 본다 — 애매할 때 덮어쓰지 않는다.
        if let Some(dir) = to.parent() {
            if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
                exact = false;
                while let Ok(Some(e)) = rd.next_entry().await {
                    if e.file_name().as_os_str() == OsStr::new(new_name) {
                        exact = true;
                        break;
                    }
                }
            }
        }
        // 이름 목록에 없는데 존재한다면 Win32 정규화(끝의 점·ADS·8.3 단축명)로 **다른** 파일에
        // 겹쳐 쓰는 경우다. 대소문자만 다른 진짜 self-match일 때만 통과시킨다.
        if exact || old_name.to_lowercase() != new_name.to_lowercase() {
            return Err(IpcError::new(
                ErrorCode::AlreadyExists,
                "같은 이름이 이미 있습니다",
            ));
        }
    }
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("이름 변경 실패: {e}")))?;
    Ok(new_rel)
}

/// 파일/폴더 이동 — **이름은 그대로**, 다른 폴더로 옮긴다(트리 드래그 앤 드롭용).
/// `dest_dir`은 레포 루트 기준 대상 폴더(빈 문자열 = 루트). 성공하면 새 레포-상대 경로를
/// 돌려준다. 기존 파일은 절대 덮어쓰지 않고(ALREADY_EXISTS), 폴더를 자기 자신/자손 안으로
/// 옮기는 것을 거부한다(rename이 소스를 통째로 삼켜 데이터가 사라지는 유형).
#[tauri::command]
pub async fn move_path(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    dest_dir: String,
) -> Result<String, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 원본 검증 + 정규화. 이름은 마지막 컴포넌트 그대로 가져간다.
    let from = resolve_in_repo(&repo, &rel_path)?;
    let name = match rel_path.rfind('/') {
        Some(i) => &rel_path[i + 1..],
        None => rel_path.as_str(),
    };
    // 자기 자신/자손 안으로의 이동 거부 — 렉시컬 선검사(정규화 전에 싸게 거른다).
    // 프론트는 항상 forward-slash 상대 경로를 보내므로 문자열 접두 비교가 성립한다.
    if dest_dir == rel_path || dest_dir.starts_with(&format!("{rel_path}/")) {
        return Err(IpcError::new(
            ErrorCode::Io,
            "폴더를 자기 자신 안으로 옮길 수 없습니다",
        ));
    }
    // 대상 폴더 검증 — 루트(빈 문자열)는 레포 자체. resolve_in_repo는 **상위까지만** 정규화하므로
    // 대상 폴더 자신이 레포 밖을 가리키는 심볼릭/정션일 수 있다 — 끝까지 정규화한 뒤 레포 안임을
    // 다시 단언한다(안 하면 그 링크 하나로 이동이 레포 밖 쓰기가 된다).
    let repo_canon = dunce::canonicalize(&repo)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("레포 경로 확인 실패: {e}")))?;
    let dest = if dest_dir.is_empty() {
        repo_canon.clone()
    } else {
        let d = resolve_in_repo(&repo, &dest_dir)?;
        let c = dunce::canonicalize(&d)
            .map_err(|_| IpcError::new(ErrorCode::NotFound, "대상 폴더를 찾을 수 없습니다"))?;
        if !c.starts_with(&repo_canon) {
            return Err(IpcError::new(ErrorCode::Io, "레포 밖 경로입니다"));
        }
        // 정규화 결과가 `.git` 아래로 떨어져도 거부 — 레포 안 심볼릭/정션이 `.git`(hooks 등)을
        // 가리키면 위 렉시컬 `.git` 검사(validate_rel_file)는 우회되고, 컨테인먼트 검사는
        // `.git`도 레포 안이라 통과한다. 훅 파일 이식은 곧 코드 실행이다.
        if c.strip_prefix(&repo_canon).is_ok_and(|r| {
            r.components()
                .any(|p| matches!(p, Component::Normal(os) if is_dotgit_component(os)))
        }) {
            return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
        }
        c
    };
    if !dest.is_dir() {
        return Err(IpcError::new(ErrorCode::Io, "대상이 폴더가 아닙니다"));
    }
    // 정규화 후 방어(심볼릭/정션으로 rel 접두 검사를 우회한 경우) — dest가 from 아래면 거부.
    if dest.starts_with(&from) {
        return Err(IpcError::new(
            ErrorCode::Io,
            "폴더를 자기 자신 안으로 옮길 수 없습니다",
        ));
    }
    if tokio::fs::symlink_metadata(&from).await.is_err() {
        return Err(IpcError::new(ErrorCode::NotFound, "대상을 찾을 수 없습니다"));
    }
    let to = dest.join(name);
    // name이 단일 컴포넌트가 아니면 거부 — rel_path에 역슬래시가 섞여 오면(`a\b.txt`)
    // Windows에서 join이 컴포넌트를 갈라 반환 경로와 실제 디스크 위치가 어긋난다.
    // rename_path와 같은 이유로 조용히 옮기느니 거부한다(Linux의 `\` 포함 파일명은 안 갈라져 통과).
    if to.parent() != Some(dest.as_path()) {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    // 같은 폴더로의 이동은 no-op — 드래그를 제자리에 놓은 경우다.
    if from == to {
        return Ok(join_rel(&dest_dir, name));
    }
    // 기존 파일 보호 — 이동은 대소문자 예외가 없다(같은 이름이 있으면 언제나 진짜 충돌).
    if tokio::fs::symlink_metadata(&to).await.is_ok() {
        return Err(IpcError::new(
            ErrorCode::AlreadyExists,
            "대상 폴더에 같은 이름이 이미 있습니다",
        ));
    }
    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("이동 실패: {e}")))?;
    Ok(join_rel(&dest_dir, name))
}

/// 바이너리 파일 쓰기 — base64 바이트를 디스크에 쓴다(이미지 변환·편집 저장용).
/// 새 파일 생성을 허용하되(상위 디렉토리는 존재해야 함), 기존 디렉토리에는 쓰지 않는다.
/// 경로 탈출(빈 경로·절대경로·`..`·`.git`)을 막는다.
///
/// `expected_stamp` 는 호출자가 **그 파일을 읽었을 때**의 정체(`read_file_base64` 가 준
/// `stamp`)다. 주면 쓰기 직전에 대조해 다르면 `Conflict` 로 거절한다 — 이미지 편집기를 열어 둔
/// 사이 외부 도구(또는 다른 편집 창)가 같은 파일을 바꿨을 때 [저장]이 그 변경을 **말없이**
/// 날리던 경로를 막는다. 생략하면 종전과 1비트도 다르지 않다(변환 저장·e2e 등 기존 호출부).
///
/// 대상이 아예 없어졌으면 충돌로 보지 않는다 — 다시 만들어 주는 쪽이 덜 놀랍고, 막아 봐야
/// 사용자가 할 수 있는 일이 저장뿐이다.
///
/// 성공하면 **쓴 직후의 새 stamp** 를 돌려준다. 저장하는 순간 파일 정체가 바뀌므로, 이걸 안 주면
/// 편집기가 다음 저장을 위해 파일을 통째로 되읽어야 한다(25MB 이미지). 메타를 못 읽는
/// 파일시스템에서는 `None`(= 이후 검사 불가, 종전과 동일).
#[tauri::command]
pub async fn write_file_bytes(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    base64: String,
    overwrite: bool,
    expected_stamp: Option<String>,
) -> Result<Option<String>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    // 최종 경로 메타는 링크를 따라가지 않고 본다 — 기존 심볼릭/정션으로 레포 밖에 쓰지 못하게.
    if let Ok(meta) = tokio::fs::symlink_metadata(&target).await {
        if meta.file_type().is_symlink() {
            return Err(IpcError::new(ErrorCode::Io, "심볼릭 링크에는 쓸 수 없습니다"));
        }
        if meta.is_dir() {
            return Err(IpcError::new(ErrorCode::Io, "디렉토리에는 쓸 수 없습니다"));
        }
        // 이미 뜬 메타를 그대로 쓴다 — 검사 때문에 파일을 되읽지 않는다.
        if let Some(want) = expected_stamp.as_deref() {
            match crate::commands::diff::stamp_of(&meta) {
                Some(now) if now != want => {
                    return Err(IpcError::new(
                        ErrorCode::Conflict,
                        "이 파일이 편집을 시작한 뒤 외부에서 바뀌었습니다",
                    ));
                }
                // 메타에서 mtime 을 못 얻는 플랫폼/파일시스템 — 검사를 포기하고 통과시킨다.
                // 저장 자체를 막으면 그런 환경에서 기능이 통째로 죽는다.
                _ => {}
            }
        }
    }
    // 덮어쓰기 미허용이면 기존 파일을 보호한다 — 변환/다른 이름 저장의 의도치 않은 데이터 손실 방지.
    if !overwrite && target.exists() {
        return Err(IpcError::new(
            ErrorCode::AlreadyExists,
            "이미 같은 이름의 파일이 있습니다",
        ));
    }
    let bytes = B64
        .decode(base64.as_bytes())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("이미지 디코딩 실패: {e}")))?;
    // base64 IPC 전송 상한 — 과대 파일로 WebView가 멈추지 않게 (이미지 변환·저장 전제).
    const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;
    if bytes.len() > MAX_WRITE_BYTES {
        return Err(IpcError::new(ErrorCode::Io, "파일이 너무 큽니다 (64MB 초과)"));
    }
    tokio::fs::write(&target, bytes).await.map_err(write_io_err)?;
    Ok(tokio::fs::metadata(&target)
        .await
        .ok()
        .as_ref()
        .and_then(crate::commands::diff::stamp_of))
}

/// 한 프로젝트 루트의 결과(또는 오류) — 배치 프리페치용.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoot {
    pub project_id: String,
    pub entries: Vec<DirEntry>,
    pub error: Option<String>,
}

/// 여러 프로젝트의 루트 디렉토리를 **병렬로** 읽는다 (WebView2 동시 invoke 응답 유실 회피 —
/// 요청 1개로 전부 처리, 내부는 join_all 동시 실행). 프론트는 결과를 dir 캐시에 시드한다.
#[tauri::command]
pub async fn list_project_roots(
    app: AppHandle,
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<ProjectRoot>, IpcError> {
    // 경로 해석은 락 안에서 끝내고, 읽기는 락 밖에서 동시 실행한다.
    let targets: Vec<(String, Option<PathBuf>)> = {
        let projects = state.projects.read().unwrap_or_else(|e| e.into_inner());
        project_ids
            .into_iter()
            .map(|id| {
                let path = projects
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| PathBuf::from(&p.path));
                (id, path)
            })
            .collect()
    };

    // 원시 나열은 동시(디스크 I/O), 디밍·킥은 뒤에서 순차(캐시 락 짧게).
    // git 스폰이 경로에서 빠져 예전의 프로세스 폭풍 문제는 없지만 동시성 캡은 유지한다
    // (수십 레포 × spawn_blocking이 블로킹 풀을 독점하지 않게).
    use futures::stream::StreamExt;
    const ROOT_CONCURRENCY: usize = 4;

    let raw: Vec<(String, Option<PathBuf>, Result<Vec<(String, bool)>, String>)> =
        futures::stream::iter(targets)
            .map(|(id, path)| async move {
                let Some(p) = path else {
                    return (id, None, Err("프로젝트 경로를 찾을 수 없습니다".to_string()));
                };
                let r = match tokio::time::timeout(
                    Duration::from_secs(15),
                    read_dir_raw(&p, ""),
                )
                .await
                {
                    Ok(Ok(items)) => Ok(items),
                    Ok(Err(e)) => Err(e.message),
                    Err(_) => Err("루트 읽기 시간 초과".to_string()),
                };
                (id, Some(p), r)
            })
            .buffer_unordered(ROOT_CONCURRENCY)
            .collect()
            .await;

    let results = raw
        .into_iter()
        .map(|(id, path, r)| match r {
            Ok(items) => {
                let entries = decorate_entries(state.inner(), &id, "", items);
                if let Some(p) = path {
                    kick_ignore_refresh(&app, state.inner(), &id, p);
                }
                ProjectRoot {
                    project_id: id,
                    entries,
                    error: None,
                }
            }
            Err(e) => ProjectRoot {
                project_id: id,
                entries: Vec::new(),
                error: Some(e),
            },
        })
        .collect();

    Ok(results)
}

/// Quick Open(파일 퍼지 검색)용 — 저장소들의 전체 파일 목록(추적+미추적, .gitignore 제외)을
/// invoke 1개로 배치 수집한다. `git ls-files --cached --others --exclude-standard`가 무시 경로를
/// git 시맨틱 그대로 제외(전역 excludes·`.git/info/exclude` 포함). 합성 id(`outer::rel`)도
/// project_path가 중첩 저장소로 해석하므로 임베디드 저장소 파일도 별도 요청으로 검색된다.
/// 사용자 입력이 git 인자로 들어가지 않아 인젝션 표면 0. 저장소별 오류 격리(배치 전체 미중단).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoFileList {
    pub project_id: String,     // 요청 id 에코(합성 id 포함)
    pub files: Vec<String>,     // 저장소 루트 기준 상대 경로, forward-slash
    pub truncated: bool,        // MAX_FILES 초과로 절단됨
    pub error: Option<String>,  // 저장소별 오류(경로 소실 등)
}

const MAX_REPO_FILES: usize = 50_000;

#[tauri::command]
pub async fn list_repo_files(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<RepoFileList>, IpcError> {
    // 경로 해석(합성 id 포함)은 락 안에서 끝내고, git 실행은 락 밖에서 동시.
    let targets: Vec<(String, Option<PathBuf>)> = project_ids
        .into_iter()
        .map(|id| {
            let path = project_path(&state, &id).ok();
            (id, path)
        })
        .collect();

    use futures::stream::StreamExt;
    const CONCURRENCY: usize = 4;

    let results: Vec<RepoFileList> = futures::stream::iter(targets)
        .map(|(id, path)| async move {
            let Some(p) = path else {
                return RepoFileList {
                    project_id: id,
                    files: Vec::new(),
                    truncated: false,
                    error: Some("프로젝트 경로를 찾을 수 없습니다".to_string()),
                };
            };
            match runner::run_git(
                Some(&p),
                &["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                runner::READ_TIMEOUT_SECS,
            )
            .await
            {
                Ok(out) => {
                    let mut files: Vec<String> = Vec::new();
                    let mut truncated = false;
                    for raw in out.stdout.split(|&b| b == 0) {
                        if raw.is_empty() {
                            continue;
                        }
                        let rel = String::from_utf8_lossy(raw).replace('\\', "/");
                        // 임베디드 저장소 디렉토리(후행 '/')는 파일이 아니므로 제외
                        if rel.ends_with('/') {
                            continue;
                        }
                        if files.len() >= MAX_REPO_FILES {
                            truncated = true;
                            break;
                        }
                        files.push(rel);
                    }
                    RepoFileList {
                        project_id: id,
                        files,
                        truncated,
                        error: None,
                    }
                }
                Err(e) => RepoFileList {
                    project_id: id,
                    files: Vec::new(),
                    truncated: false,
                    error: Some(e.message),
                },
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;

    Ok(results)
}

/// 한 디렉토리 항목 수집 — spawn_blocking 단일 패스. tokio read_dir은 엔트리마다
/// next_entry().await + file_type().await 왕복이라 수천 항목 디렉토리에서 눈에 띄게 느리다.
async fn read_dir_raw(repo: &Path, rel_path: &str) -> Result<Vec<(String, bool)>, IpcError> {
    validate_rel_dir(rel_path)?;
    let dir = if rel_path.is_empty() {
        repo.to_path_buf()
    } else {
        repo.join(rel_path)
    };
    tokio::task::spawn_blocking(move || {
        if !dir.is_dir() {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                "디렉토리를 찾을 수 없습니다",
            ));
        }
        let read = std::fs::read_dir(&dir)
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("디렉토리 읽기 실패: {e}")))?;
        let mut items: Vec<(String, bool)> = Vec::new(); // (name, is_dir)
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Windows의 read_dir 엔트리 file_type은 디렉토리 나열 데이터에서 나온다 — 추가 stat 없음.
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            items.push((name, is_dir));
        }
        Ok(items)
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("디렉토리 읽기 작업 실패: {e}")))?
}

/// (name, is_dir) 목록을 ignore 캐시로 디밍 판정해 정렬된 DirEntry로 만든다.
/// 캐시 락은 판정 동안만 짧게 잡는다 — await 없음.
fn decorate_entries(
    state: &AppState,
    project_id: &str,
    rel_path: &str,
    items: Vec<(String, bool)>,
) -> Vec<DirEntry> {
    let entries: Vec<DirEntry> = {
        let map = state.ignore_cache.lock().unwrap_or_else(|e| e.into_inner());
        let cache = map.get(project_id);
        items
            .into_iter()
            .map(|(name, is_dir)| {
                let rel = join_rel(rel_path, &name);
                DirEntry {
                    is_ignored: name == ".git"
                        || cache.map(|c| c.is_ignored(&rel)).unwrap_or(false),
                    name,
                    is_dir,
                }
            })
            .collect()
    };
    // 디렉토리 우선 + 이름순(대소문자 무시, 숫자는 값으로). 정렬 키는 엔트리당 1회만 계산
    // (비교당 to_lowercase 2회 할당하던 이전 방식 제거).
    let mut keyed: Vec<(bool, String, DirEntry)> = entries
        .into_iter()
        .map(|e| (e.is_dir, e.name.to_lowercase(), e))
        .collect();
    keyed.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| natural_cmp(&a.1, &b.1)));
    keyed.into_iter().map(|(_, _, e)| e).collect()
}

/// 사람이 기대하는 이름 순서 — **숫자 묶음은 값으로** 본다.
///
/// 사전식은 자릿수가 늘어나는 순간 뒤집힌다: `세트1, 세트10, 세트11, 세트12, 세트2 …`.
/// 폴더를 세트1~12로 나눠 쓰는 사용에서 이건 그냥 고장이다(2026-09-04 실사용 제보).
///
/// 숫자는 파싱하지 않고 **자릿수 → 사전식**으로 비교한다. u64로 파싱하면 30자리 파일명
/// 하나에 오버플로로 순서가 무너진다. 값이 같으면 선행 0이 적은 쪽(`7` < `007`)을 앞에 둬
/// 순서가 결정적이다 — 안 그러면 같은 값끼리 비교가 Equal이라 정렬이 불안정해진다.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    let take_digits = |it: &mut std::iter::Peekable<std::str::Chars<'_>>| {
        let mut s = String::new();
        while let Some(c) = it.peek() {
            if c.is_ascii_digit() {
                s.push(*c);
                it.next();
            } else {
                break;
            }
        }
        s
    };
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let (na, nb) = (take_digits(&mut ai), take_digits(&mut bi));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta
                    .len()
                    .cmp(&tb.len())
                    .then_with(|| ta.cmp(tb))
                    .then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                ai.next();
                bi.next();
                if x != y {
                    return x.cmp(&y);
                }
            }
        }
    }
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

// ── ignore 캐시 — git 스폰을 리스팅당 1회에서 레포 변경당 1회로 상각 ──
//
// `git ls-files -z --others --ignored --exclude-standard --directory` 한 번이 레포 전체의
// ignored 파일/디렉토리 집합을 준다. 시맨틱 보존 3원칙(이전 check-ignore와 동일해야 함):
//   ① 추적(tracked) 파일은 절대 ignored 아님 — --others가 추적 파일을 안 내놓으므로 자동 보존
//   ② `.git`은 코드에서 강제 ignored(decorate_entries)
//   ③ 판정 불가(캐시 없음·git 실패·상한 초과)면 디밍 없음으로 폴백
// `--directory`가 ignored 디렉토리를 접어 출력하므로(node_modules/ = 한 줄) 출력이 작다.

/// 병리적 대량 출력 상한 — 넘으면 그 레포는 디밍 폴백(정확성 대신 정직한 강등).
const MAX_IGNORE_ENTRIES: usize = 100_000;

pub struct IgnoreCache {
    files: HashSet<String>,
    /// 무시되는 디렉토리(후행 '/' 제거) — 조상 판정용.
    dirs: HashSet<String>,
    truncated: bool,
    /// false = 레포가 바뀜 — 다음 list_dir이 배경 재빌드를 킥한다(watcher.rs가 내린다).
    pub fresh: bool,
    /// 재빌드 in-flight 가드(레포당 1개).
    building: bool,
}

impl IgnoreCache {
    fn is_ignored(&self, rel: &str) -> bool {
        if self.truncated {
            return false;
        }
        if self.files.contains(rel) || self.dirs.contains(rel) {
            return true;
        }
        // 조상 디렉토리 중 하나라도 무시면 하위도 무시 — 깊이만큼의 해시 조회.
        let mut end = 0;
        while let Some(pos) = rel[end..].find('/') {
            end += pos;
            if self.dirs.contains(&rel[..end]) {
                return true;
            }
            end += 1;
        }
        false
    }
}

/// ls-files 출력 파싱 — 순수 함수(테스트 대상). 후행 '/' = 디렉토리.
fn parse_ignore_output(stdout: &[u8]) -> IgnoreCache {
    let mut files = HashSet::new();
    let mut dirs = HashSet::new();
    for raw in stdout.split(|&b| b == 0).filter(|s| !s.is_empty()) {
        if files.len() + dirs.len() >= MAX_IGNORE_ENTRIES {
            return IgnoreCache {
                files: HashSet::new(),
                dirs: HashSet::new(),
                truncated: true,
                fresh: true,
                building: false,
            };
        }
        let s = String::from_utf8_lossy(raw);
        match s.strip_suffix('/') {
            Some(d) => {
                dirs.insert(d.to_string());
            }
            None => {
                files.insert(s.into_owned());
            }
        }
    }
    IgnoreCache {
        files,
        dirs,
        truncated: false,
        fresh: true,
        building: false,
    }
}

async fn build_ignore_cache(repo: &Path) -> IgnoreCache {
    // --others는 미추적 스캔(워크트리 워크)이라 거대 레포에서 수십 초일 수 있다 —
    // status와 같은 넉넉한 타임아웃. 어차피 배경 실행이라 클릭을 막지 않는다.
    let out = runner::run_git(
        Some(repo),
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ],
        runner::STATUS_TIMEOUT_SECS,
    )
    .await;
    match out {
        // 비-git 폴더(등록 허용됨)는 exit 128 + 빈 stdout → 빈 캐시 = 디밍 없음(정상).
        Ok(out) => parse_ignore_output(&out.stdout),
        // 실패(git 없음·타임아웃) → 디밍 폴백. fresh=true로 두어 재시도 루프를 만들지
        // 않는다 — 다음 레포 변경(fresh=false)이 자연스러운 재시도다.
        Err(_) => IgnoreCache {
            files: HashSet::new(),
            dirs: HashSet::new(),
            truncated: true,
            fresh: true,
            building: false,
        },
    }
}

/// 캐시가 없거나 stale이면 배경 재빌드를 킥한다(레포당 in-flight 1개). 완료 시
/// `tree://ignore-ready`로 프론트가 펼쳐진 폴더의 디밍만 재검증한다.
/// (repo://changed 재사용은 statuses/log 재조회까지 연쇄시켜 git 스폰이 늘어난다 — 전용 신호가 싸다.)
///
/// 알려진 근사: 빌드 **도중** 레포가 또 바뀌면 그 변경분은 이번 결과에 없을 수 있고 fresh=true로
/// 덮인다 — 다음 변경 때 따라잡는다. 디밍은 장식이라 수용(설계 §8).
fn kick_ignore_refresh(app: &AppHandle, state: &AppState, project_id: &str, repo: PathBuf) {
    {
        let mut map = state.ignore_cache.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(project_id) {
            Some(c) if c.fresh || c.building => return,
            Some(c) => c.building = true,
            None => {
                // 빌드 완료까지의 자리 채움 — truncated=디밍 없음 폴백.
                map.insert(
                    project_id.to_string(),
                    IgnoreCache {
                        files: HashSet::new(),
                        dirs: HashSet::new(),
                        truncated: true,
                        fresh: false,
                        building: true,
                    },
                );
            }
        }
    }
    // 전역 동시 빌드 캡 — 앱 시작 시 루트 프리페치가 전 프로젝트를 한꺼번에 킥하는데,
    // 레포 수만큼 ls-files를 동시에 띄우면 Windows에서 git 프로세스 폭풍이 된다
    // (list_project_roots가 4로 캡한 것과 같은 이유). 배경 작업이라 2면 충분하다.
    static BUILD_SEM: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

    let app = app.clone();
    let pid = project_id.to_string();
    tauri::async_runtime::spawn(async move {
        let _permit = BUILD_SEM.acquire().await;
        let built = build_ignore_cache(&repo).await;
        if let Some(st) = app.try_state::<AppState>() {
            // 빌드 중 제거된 프로젝트면 버린다 — 안 보면 remove_project의 캐시 정리를
            // 이 늦은 삽입이 되돌려 죽은 id 아래 수 MB가 앱 수명 내내 남는다.
            let still_exists = pid.contains("::") // 합성 id는 목록에 없다 — 존재 판정 불가, 보수적으로 유지
                || st
                    .projects
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .any(|p| p.id == pid);
            if still_exists {
                let mut map = st.ignore_cache.lock().unwrap_or_else(|e| e.into_inner());
                map.insert(pid.clone(), built);
            }
        }
        #[derive(Clone, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct IgnoreReady {
            project_id: String,
        }
        let _ = app.emit("tree://ignore-ready", IgnoreReady { project_id: pid });
    });
}

/// 레포 밖 접근 차단 — 절대경로·루트/드라이브 상대(`\`·`C:`)·`..` 거부. 빈 문자열(루트)은 허용.
fn validate_rel_dir(rel: &str) -> Result<(), IpcError> {
    let p = Path::new(rel);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    Ok(())
}

// ===== Go-to-Definition (Viewer 심볼 점프) =====

/// 정의 후보 1건 — 휴리스틱 ripgrep 매칭.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefMatch {
    pub path: String,      // 레포 상대 경로(forward slash)
    pub line: u32,         // 1-based
    pub column: u32,       // 1-based
    pub signature: String, // 데코레이터/속성 + 정의줄 + 파라미터
    /// 정의 문서 블록(py 독스트링/JSDoc/`///`) — 정제 텍스트, 12줄·800자 캡. 없으면 필드 생략.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
}

/// 심볼의 정의 위치를 휴리스틱으로 찾는다(LSP 없이 언어별 "정의 패턴"을 ripgrep으로 검색).
/// 완벽하진 않으나 함수/클래스/타입 정의를 대부분 잡는다. .gitignore된 경로(node_modules·
/// target 등)는 ripgrep이 자동 제외한다. rg 미설치/타임아웃이면 조용히 빈 결과를 반환한다.
#[tauri::command]
pub async fn find_definition(
    state: State<'_, AppState>,
    project_id: String,
    symbol: String,
    ext: String,
) -> Result<Vec<DefMatch>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 식별자만 허용(빈/과길이/특수문자 거부 — 패턴 인젝션·과검색 방지).
    if symbol.is_empty()
        || symbol.len() > 128
        || !symbol.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    {
        return Ok(Vec::new());
    }
    // 정확일치: 리터럴을 이스케이프(`$`만)해 심볼 자리에 넣는다.
    let (patterns, exts) = def_query(&ext, &symbol.replace('$', "\\$"));
    if patterns.is_empty() {
        return Ok(Vec::new());
    }

    // git grep -P(PCRE, `\b` 지원)으로 정의 패턴 검색. ripgrep은 앱 프로세스 PATH에 없을 수
    // 있지만 git은 항상 가용(코어 의존, 설정된 경로 사용). --untracked로 추적 안 된 새 파일의
    // 정의도 포함. 매치 없으면 exit 1(정상) → run_git이 Ok+빈 stdout를 주므로 빈 결과가 된다.
    // 확장자 pathspec으로 대상 언어 파일만 스캔한다 — 거대 레포(데이터·미디어 포함)에서
    // 사후 필터 대비 수 배 빠르다(실측 nqvm-ais 1.4s → 0.2s). 언어 미상(exts 비면)은 전체.
    let ext_globs: Vec<String> = exts.iter().map(|e| format!("*{e}")).collect();
    let mut args: Vec<&str> = vec![
        "grep", "-P", "-n", "--column", "--no-color", "-I", "--untracked",
    ];
    for p in &patterns {
        args.push("-e");
        args.push(p);
    }
    if !ext_globs.is_empty() {
        args.push("--");
        for g in &ext_globs {
            args.push(g);
        }
    }
    let out = match runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);

    let mut matches: Vec<DefMatch> = Vec::new();
    let mut weak: Vec<DefMatch> = Vec::new(); // 대입문 매치 — 정의문(def/class 등)보다 후순위
    for line in stdout.lines() {
        // 형식: <path>:<line>:<col>:<text> (상대경로는 ':'를 안 가짐)
        let mut it = line.splitn(4, ':');
        let (Some(path), Some(ln), Some(col), Some(text)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(line_no), Ok(col_no)) = (ln.parse::<u32>(), col.parse::<u32>()) else {
            continue;
        };
        // 언어별 확장자 필터(오탐 감소). exts 비면 전부 허용(제네릭 폴백).
        if !exts.is_empty() && !exts.iter().any(|e| path.ends_with(e.as_str())) {
            continue;
        }
        let rel = path.replace('\\', "/");
        // grep --column은 패턴 매치 시작(export/def 같은 키워드)을 가리킨다 — 점프 후 커서를
        // 심볼 위에 놓을 수 있게 줄 안의 심볼 시작 열(1-based, 문자 단위)로 보정한다.
        let col_no = text
            .find(symbol.as_str())
            .map(|b| text[..b].chars().count() as u32 + 1)
            .unwrap_or(col_no);
        let (signature, doc) = extract_sig_doc(&repo, &rel, line_no, text);
        let dm = DefMatch {
            path: rel,
            line: line_no,
            column: col_no,
            signature,
            doc,
        };
        // git grep은 결과를 파일 순서로 주므로, 심볼로 시작하는 줄(=대입 폴백 매치)이
        // def/class 같은 진짜 정의를 가리지 않게 뒤로 미룬다.
        if text.starts_with(symbol.as_str()) {
            weak.push(dm);
        } else {
            matches.push(dm);
        }
        if matches.len() + weak.len() >= 12 {
            break;
        }
    }
    matches.extend(weak);
    // 패턴 정의가 없으면 "모듈 파일" 폴백 — `import threading`처럼 심볼이 레포 파일명과
    // 일치하면 그 파일로 점프한다(py의 pkg/__init__.py, ts/js의 dir/index.* 포함).
    // 언어 미상(exts 비어 있음)은 오탐이 많아 건너뛴다.
    if matches.is_empty() && !exts.is_empty() {
        matches = find_module_files(&repo, &symbol, &exts).await;
    }
    Ok(matches)
}

// ===== Go to Symbol (프로젝트 전체 심볼 부분일치 검색) =====

/// 심볼 검색 후보 1건.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolMatch {
    pub name: String,      // 매치된 심볼 식별자(하이라이트용)
    pub path: String,      // 레포 상대 경로(forward slash)
    pub line: u32,         // 1-based
    pub column: u32,       // 1-based, 심볼 시작 열
    pub signature: String, // 정의 줄 시그니처(extract 재사용, doc 없음)
}

/// 심볼명 부분일치로 정의 후보를 프로젝트 전체에서 찾는다(전 언어 def 패턴 합집합 + pathspec).
/// 쿼리 검증(2..=64자 식별자 문자만) 실패·git 오류·타임아웃은 조용히 빈 결과(find_definition 관례).
/// 랭킹(정확>접두>부분 → 정의강도 → ext 힌트 → 얕은 경로) 후 캡 100. ext_hint는 랭킹 부스트 전용.
#[tauri::command]
pub async fn find_symbols(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
    ext_hint: Option<String>,
) -> Result<Vec<SymbolMatch>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 2..=64자 식별자만 — 1자는 과검색, 특수문자는 인젝션.
    if query.len() < 2
        || query.len() > 64
        || !query.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    {
        return Ok(Vec::new());
    }
    let q_esc = query.replace('$', "\\$");
    let sym_pat = format!("[\\w$]*{q_esc}[\\w$]*");
    let smart_case = query.chars().all(|c| !c.is_uppercase());

    // 전 언어 def 패턴 + 확장자 pathspec 합집합.
    let mut patterns: Vec<String> = Vec::new();
    let mut exts: Vec<String> = Vec::new();
    for lang in ["py", "ts", "rs", "go", "java", "rb"] {
        let (pats, es) = def_query(lang, &sym_pat);
        for p in pats {
            if !patterns.contains(&p) {
                patterns.push(p);
            }
        }
        for e in es {
            if !exts.contains(&e) {
                exts.push(e);
            }
        }
    }

    let mut args: Vec<&str> = vec!["grep", "-P", "-n", "--column", "--no-color", "-I", "--untracked"];
    if smart_case {
        args.push("-i");
    }
    for p in &patterns {
        args.push("-e");
        args.push(p);
    }
    let ext_globs: Vec<String> = exts.iter().map(|e| format!("*{e}")).collect();
    if !ext_globs.is_empty() {
        args.push("--");
        for g in &ext_globs {
            args.push(g);
        }
    }
    let out = match runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);

    let q_lower = query.to_lowercase();
    let hint = ext_hint.as_deref().unwrap_or("").to_lowercase();
    struct Raw {
        name: String,
        path: String,
        line: u32,
        column: u32,
        tier: u8,   // 0=정확, 1=접두, 2=부분
        weak: bool, // 대입 폴백(정의문보다 후순위)
        ext_boost: bool,
        depth: usize,
    }
    let mut raws: Vec<Raw> = Vec::new();
    let mut seen: HashSet<(String, u32)> = HashSet::new();
    for line in stdout.lines() {
        // 원시 매치 상한 — 흔한 쿼리의 파싱 폭주 방지
        if seen.len() >= 1000 {
            break;
        }
        let mut it = line.splitn(4, ':');
        let (Some(path), Some(ln), Some(_col), Some(text)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let Ok(line_no) = ln.parse::<u32>() else {
            continue;
        };
        if !exts.is_empty() && !exts.iter().any(|e| path.ends_with(e.as_str())) {
            continue;
        }
        // 쿼리를 포함하는 식별자를 찾아 name·열을 추출
        let Some((name, byte_col)) = find_matching_ident(text, &q_lower) else {
            continue;
        };
        let rel = path.replace('\\', "/");
        if !seen.insert((rel.clone(), line_no)) {
            continue;
        }
        let name_lower = name.to_lowercase();
        let tier = if name_lower == q_lower {
            0
        } else if name_lower.starts_with(&q_lower) {
            1
        } else {
            2
        };
        let column = text[..byte_col].chars().count() as u32 + 1;
        let weak = text.trim_start().starts_with(&name);
        let ext_boost = !hint.is_empty() && rel.rsplit('.').next().unwrap_or("") == hint;
        let depth = rel.matches('/').count();
        raws.push(Raw {
            name,
            depth,
            path: rel,
            line: line_no,
            column,
            tier,
            weak,
            ext_boost,
        });
    }

    // 랭킹: 정확>접두>부분 → 정의강도 → ext 힌트 → 얕은 경로 → 경로·라인
    raws.sort_by(|a, b| {
        a.tier
            .cmp(&b.tier)
            .then(a.weak.cmp(&b.weak))
            .then(b.ext_boost.cmp(&a.ext_boost))
            .then(a.depth.cmp(&b.depth))
            .then(a.path.cmp(&b.path))
            .then(a.line.cmp(&b.line))
    });
    raws.truncate(100);

    // 시그니처는 캡 후에만 — 파일 내용 캐시로 중복 읽기 제거.
    let mut contents: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let results: Vec<SymbolMatch> = raws
        .into_iter()
        .map(|r| {
            let content = contents
                .entry(r.path.clone())
                .or_insert_with(|| std::fs::read_to_string(repo.join(&r.path)).unwrap_or_default());
            let signature = sig_from_content(content, r.line, &r.name);
            SymbolMatch {
                name: r.name,
                path: r.path,
                line: r.line,
                column: r.column,
                signature,
            }
        })
        .collect();
    Ok(results)
}

/// 매치 텍스트에서 쿼리(소문자)를 포함하는 첫 식별자를 찾아 (이름, 바이트 시작 위치)를 돌려준다.
fn find_matching_ident(text: &str, q_lower: &str) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut i = 0;
    while i < bytes.len() {
        if is_ident(bytes[i]) && (i == 0 || !is_ident(bytes[i - 1])) {
            let start = i;
            while i < bytes.len() && is_ident(bytes[i]) {
                i += 1;
            }
            let ident = &text[start..i];
            if ident.to_lowercase().contains(q_lower) {
                return Some((ident.to_string(), start));
            }
        } else {
            i += 1;
        }
    }
    None
}

/// 정의 줄 시그니처만 추출(extract_sig_doc의 시그니처 부분 — 캐시된 내용에서 계산, doc 없음).
fn sig_from_content(content: &str, line_no: u32, fallback: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let idx = (line_no as usize).saturating_sub(1);
    if idx >= lines.len() {
        return fallback.trim().to_string();
    }
    let mut top = idx;
    while top > 0 {
        let prev = lines[top - 1].trim_start();
        if prev.starts_with('@') || prev.starts_with("#[") {
            top -= 1;
        } else {
            break;
        }
    }
    let mut out: Vec<String> = Vec::new();
    for l in &lines[top..idx] {
        out.push((*l).to_string());
    }
    let mut j = idx;
    let mut taken = 0;
    while j < lines.len() && taken < 8 {
        let l = lines[j];
        out.push(l.to_string());
        taken += 1;
        let t = l.trim_end();
        if t.ends_with(':') || t.ends_with('{') || t.ends_with(';') || t.ends_with('}') {
            break;
        }
        j += 1;
    }
    let sig = out.join("\n");
    if sig.len() > 1200 {
        format!("{}…", sig.chars().take(1200).collect::<String>())
    } else {
        sig
    }
}

// ===== Find References (참조 찾기) =====

/// 참조 매치 1건.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsResult {
    pub matches: Vec<RefMatch>,
    pub truncated: bool,
}

/// 언어 확장자 목록(pathspec 소스) — 참조 검색은 정의 패턴 없이 확장자만 필요하다.
fn lang_exts(ext: &str) -> Vec<String> {
    let g = |arr: &[&str]| arr.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match ext.to_lowercase().as_str() {
        "py" | "pyi" => g(&[".py", ".pyi"]),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            g(&[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
        }
        "rs" => g(&[".rs"]),
        "go" => g(&[".go"]),
        "java" | "kt" | "kts" => g(&[".java", ".kt", ".kts"]),
        "rb" => g(&[".rb"]),
        _ => Vec::new(),
    }
}

/// 심볼의 사용처(참조)를 `git grep -F -w`(고정 문자열 + 단어 경계)로 찾는다. 정규식 해석이
/// 없어 인젝션 표면 0. 확장자 pathspec으로 같은 언어 계열만 스캔. 매치 200/파일 30 캡.
/// 심볼 검증·매치 없음·타임아웃은 find_definition 관례(조용히 빈 결과).
#[tauri::command]
pub async fn find_references(
    state: State<'_, AppState>,
    project_id: String,
    symbol: String,
    ext: String,
) -> Result<RefsResult, IpcError> {
    let repo = project_path(&state, &project_id)?;
    if symbol.is_empty()
        || symbol.len() > 128
        || !symbol.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    {
        return Ok(RefsResult {
            matches: Vec::new(),
            truncated: false,
        });
    }
    let ext_globs: Vec<String> = lang_exts(&ext).iter().map(|e| format!("*{e}")).collect();
    let mut args: Vec<&str> = vec![
        "grep", "-F", "-w", "-n", "--column", "--no-color", "-I", "--untracked", "-e", &symbol,
    ];
    if !ext_globs.is_empty() {
        args.push("--");
        for g in &ext_globs {
            args.push(g);
        }
    }
    let out = match runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await {
        Ok(o) => o,
        Err(_) => {
            return Ok(RefsResult {
                matches: Vec::new(),
                truncated: false,
            })
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut matches: Vec<RefMatch> = Vec::new();
    let mut files: HashSet<String> = HashSet::new();
    let mut truncated = false;
    for line in stdout.lines() {
        if matches.len() >= 200 {
            truncated = true;
            break;
        }
        let mut it = line.splitn(4, ':');
        let (Some(path), Some(ln), Some(col), Some(text)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(line_no), Ok(col_no)) = (ln.parse::<u32>(), col.parse::<u32>()) else {
            continue;
        };
        let rel = path.replace('\\', "/");
        if !files.contains(&rel) {
            if files.len() >= 30 {
                truncated = true;
                break;
            }
            files.insert(rel.clone());
        }
        // grep --column은 바이트 열 — 심볼 시작 문자 열로 보정(멀티바이트 안전).
        let byte_off = (col_no.saturating_sub(1)) as usize;
        let column = if byte_off <= text.len() && text.is_char_boundary(byte_off) {
            text[..byte_off].chars().count() as u32 + 1
        } else {
            col_no
        };
        matches.push(RefMatch {
            path: rel,
            line: line_no,
            column,
        });
    }
    Ok(RefsResult { matches, truncated })
}

/// `git ls-files`(추적 + 미추적, .gitignore 제외)에서 심볼과 같은 이름의 모듈 파일을 찾는다.
/// 얕은 경로 우선 정렬(루트 근처 모듈이 보통 의도한 대상) 후 최대 5건.
async fn find_module_files(repo: &Path, symbol: &str, exts: &[String]) -> Vec<DefMatch> {
    // 후보 이름을 미리 만든다 — `foo.py`류(basename)와 `foo/__init__.py`·`foo/index.ts`류(디렉터리 모듈).
    let base_names: Vec<String> = exts.iter().map(|e| format!("{symbol}{e}")).collect();
    let mut dir_modules: Vec<String> =
        exts.iter().map(|e| format!("{symbol}/index{e}")).collect();
    dir_modules.push(format!("{symbol}/__init__.py"));
    // pathspec으로 git이 후보만 나열하게 한다(전체 목록 출력·순회 회피 — 거대 레포 가속).
    // 루트(`foo.py`)와 하위(`*/foo.py`) 두 형태 모두 필요하다.
    let mut specs: Vec<String> = Vec::new();
    for n in &base_names {
        specs.push(n.clone());
        specs.push(format!("*/{n}"));
    }
    for m in &dir_modules {
        specs.push(m.clone());
        specs.push(format!("*/{m}"));
    }
    let mut args: Vec<&str> = vec!["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"];
    for s in &specs {
        args.push(s);
    }
    let out = match runner::run_git(Some(repo), &args, runner::READ_TIMEOUT_SECS).await {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    // 접두 경로가 있는 경우 경계를 지켜 매칭한다(`mysymbol/…` 오탐 방지 — `/` 포함 접미사).
    let dir_suffixes: Vec<String> = dir_modules.iter().map(|m| format!("/{m}")).collect();

    let mut found: Vec<String> = Vec::new();
    for raw in out.stdout.split(|&b| b == 0) {
        if raw.is_empty() {
            continue;
        }
        let rel = String::from_utf8_lossy(raw).replace('\\', "/");
        let base = rel.rsplit('/').next().unwrap_or(&rel);
        let is_module = base_names.iter().any(|n| base == n.as_str())
            || dir_modules.iter().any(|m| rel == *m)
            || dir_suffixes.iter().any(|s| rel.ends_with(s.as_str()));
        if is_module {
            found.push(rel);
        }
    }
    found.sort_by_key(|p| (p.matches('/').count(), p.clone()));
    found
        .into_iter()
        .take(5)
        .map(|rel| {
            // 모듈 파일 폴백은 문서 미추출(폴백 시그니처가 이미 첫 8줄을 보여줌 — §3.5).
            let (signature, _) = extract_sig_doc(repo, &rel, 1, &rel);
            DefMatch {
                path: rel,
                line: 1,
                column: 1,
                signature,
                doc: None,
            }
        })
        .collect()
}

/// (정규식 패턴들, 확장자들) — 확장자별 "정의" 패턴. `s`는 심볼 자리에 끼울 **정규식 조각**이다:
/// find_definition은 이스케이프된 리터럴(정확일치)을, find_symbols는 `[\w$]*q[\w$]*`(부분일치)를 넣는다.
fn def_query(ext: &str, s: &str) -> (Vec<String>, Vec<String>) {
    let g = |arr: &[&str]| arr.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match ext.to_lowercase().as_str() {
        "py" | "pyi" => (
            vec![
                format!(r"^\s*(async\s+)?def\s+{s}\b"),
                format!(r"^\s*class\s+{s}\b"),
                // 모듈 레벨 대입(들여쓰기 0) — 싱글턴 인스턴스/상수(`client = Client()`)도
                // 정의로 인정. `==` 비교·`+=` 증감은 [^=] 가드로 제외. 정렬에서 def/class보다 후순위.
                format!(r"^{s}\s*(:[^=\n]*)?=[^=]"),
            ],
            g(&[".py", ".pyi"]),
        ),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => (
            vec![
                format!(r"\b(export\s+)?(default\s+)?(async\s+)?function\s+{s}\b"),
                format!(r"\b(export\s+)?(const|let|var)\s+{s}\s*[=:]"),
                format!(r"\b(export\s+)?(default\s+)?(abstract\s+)?class\s+{s}\b"),
                format!(r"\b(export\s+)?interface\s+{s}\b"),
                format!(r"\b(export\s+)?type\s+{s}\b"),
                format!(r"\b(export\s+)?enum\s+{s}\b"),
            ],
            g(&[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
        ),
        "rs" => (
            vec![
                format!(r"\b(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?struct\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?enum\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?trait\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?(type|const|static)\s+{s}\b"),
                format!(r"macro_rules!\s+{s}\b"),
            ],
            g(&[".rs"]),
        ),
        "go" => (
            vec![
                format!(r"\bfunc\s+(\([^)]*\)\s*)?{s}\b"),
                format!(r"\btype\s+{s}\b"),
            ],
            g(&[".go"]),
        ),
        "java" | "kt" | "kts" => (
            vec![
                format!(r"\b(class|interface|enum|object)\s+{s}\b"),
                format!(r"\b(fun|void|[A-Za-z_][\w<>\[\].]*)\s+{s}\s*\("),
            ],
            g(&[".java", ".kt", ".kts"]),
        ),
        "rb" => (
            vec![
                format!(r"^\s*def\s+(self\.)?{s}\b"),
                format!(r"^\s*(class|module)\s+{s}\b"),
            ],
            g(&[".rb"]),
        ),
        // 언어 미상 — 제네릭 폴백(전 파일 검색)
        _ => (
            vec![
                format!(r"\b(function|def|fn|func|class|struct|interface|type|enum|trait)\s+{s}\b"),
                format!(r"\b(const|let|var|val)\s+{s}\s*[=:]"),
            ],
            Vec::new(),
        ),
    }
}

/// 매치 줄 주변에서 시그니처 블록과 문서 블록을 추출한다.
/// 시그니처: 위로 데코레이터(@)/속성(#[..]) 연속, 아래로 정의가 닫힐 때까지(`:`/`{`/`;`/`}` 또는 8줄).
/// 문서(언어별): py=정의 아래 독스트링(`:` 종결 시), ts/js=정의 위 `/**…*/`, rs=정의 위 `///` 연속.
/// 읽기 실패 시 (매치 줄, None).
fn extract_sig_doc(
    repo: &Path,
    rel: &str,
    line_no: u32,
    fallback: &str,
) -> (String, Option<String>) {
    let content = match std::fs::read_to_string(repo.join(rel)) {
        Ok(c) => c,
        Err(_) => return (fallback.trim().to_string(), None),
    };
    let lines: Vec<&str> = content.lines().collect();
    let idx = (line_no as usize).saturating_sub(1);
    if idx >= lines.len() {
        return (fallback.trim().to_string(), None);
    }
    // 위로: 연속 데코레이터/속성 → top = 포함된 최상단 인덱스
    let mut top = idx;
    while top > 0 {
        let prev = lines[top - 1].trim_start();
        if prev.starts_with('@') || prev.starts_with("#[") {
            top -= 1;
        } else {
            break;
        }
    }
    let mut out: Vec<String> = Vec::new();
    for l in &lines[top..idx] {
        out.push((*l).to_string());
    }
    // 정의줄 + 아래로
    let mut j = idx;
    let mut taken = 0;
    let mut colon_terminated = false;
    while j < lines.len() && taken < 8 {
        let l = lines[j];
        out.push(l.to_string());
        taken += 1;
        let t = l.trim_end();
        if t.ends_with(':') || t.ends_with('{') || t.ends_with(';') || t.ends_with('}') {
            colon_terminated = t.ends_with(':');
            break;
        }
        j += 1;
    }
    let sig_raw = out.join("\n");
    let signature = if sig_raw.len() > 1200 {
        format!("{}…", sig_raw.chars().take(1200).collect::<String>())
    } else {
        sig_raw
    };

    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let doc = match ext.as_str() {
        "py" | "pyi" => extract_py_docstring(&lines, j, colon_terminated),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => extract_up_block(&lines, top, false),
        "rs" => extract_up_block(&lines, top, true),
        _ => None,
    };
    (signature, doc)
}

/// 파이썬 독스트링 — 시그니처 종결(`:`) 다음 첫 실질 줄이 삼중따옴표면 닫힘까지 수집.
/// 삼중따옴표만 인정(한 줄 `"..."` 문자열은 오탐 방지로 제외).
fn extract_py_docstring(lines: &[&str], sig_end: usize, colon_terminated: bool) -> Option<String> {
    if !colon_terminated {
        return None;
    }
    let mut k = sig_end + 1;
    // 공백/주석 줄을 최대 2줄만 관대하게 스킵
    let mut skipped = 0;
    while k < lines.len() && (lines[k].trim().is_empty() || lines[k].trim_start().starts_with('#')) {
        skipped += 1;
        if skipped > 2 {
            return None;
        }
        k += 1;
    }
    if k >= lines.len() {
        return None;
    }
    let first = lines[k].trim_start();
    let after_prefix =
        first.trim_start_matches(|c| matches!(c, 'r' | 'R' | 'u' | 'U' | 'b' | 'B' | 'f' | 'F'));
    let delim = if after_prefix.starts_with("\"\"\"") {
        "\"\"\""
    } else if after_prefix.starts_with("'''") {
        "'''"
    } else {
        return None;
    };
    let open_pos = first.find(delim).unwrap();
    let rest = &first[open_pos + delim.len()..];
    let mut body: Vec<String> = Vec::new();
    // 한 줄 독스트링(같은 줄에서 닫힘)
    if let Some(close) = rest.find(delim) {
        body.push(rest[..close].to_string());
        return finalize_doc(body);
    }
    body.push(rest.to_string());
    let mut kk = k + 1;
    let mut count = 0;
    while kk < lines.len() && count < 40 {
        count += 1;
        if let Some(close) = lines[kk].find(delim) {
            body.push(lines[kk][..close].to_string());
            break;
        }
        body.push(lines[kk].to_string());
        kk += 1;
    }
    finalize_doc(body)
}

/// 정의 위의 문서 블록 — rust_doc=true면 `///` 연속, 아니면 `/**…*/` JSDoc.
/// top(데코레이터 포함 최상단)의 바로 윗줄부터 위로 스캔(사이 공백 불허 — 무관 주석 오귀속 방지).
fn extract_up_block(lines: &[&str], top: usize, rust_doc: bool) -> Option<String> {
    if top == 0 {
        return None;
    }
    if rust_doc {
        let mut k = top;
        let mut collected: Vec<String> = Vec::new();
        while k > 0 {
            let t = lines[k - 1].trim_start();
            if let Some(r) = t.strip_prefix("///") {
                collected.push(r.strip_prefix(' ').unwrap_or(r).to_string());
                k -= 1;
            } else {
                break;
            }
        }
        collected.reverse();
        finalize_doc(collected)
    } else {
        let above = lines[top - 1].trim_end();
        if !above.ends_with("*/") {
            return None;
        }
        // 위로 `/**` 시작줄까지 블록 인덱스 수집
        let mut k = top - 1;
        let mut block: Vec<usize> = Vec::new();
        loop {
            block.push(k);
            if lines[k].trim_start().starts_with("/**") {
                break;
            }
            if k == 0 {
                return None; // `/**` 없이 `*/`만 → JSDoc 아님
            }
            k -= 1;
        }
        block.reverse();
        let mut collected: Vec<String> = Vec::new();
        for &bi in &block {
            let mut s = lines[bi].trim().to_string();
            if let Some(r) = s.strip_prefix("/**") {
                s = r.to_string();
            }
            if let Some(p) = s.rfind("*/") {
                s = s[..p].to_string();
            }
            let st = s.trim_start();
            s = match st.strip_prefix('*') {
                Some(r) => r.strip_prefix(' ').unwrap_or(r).to_string(),
                None => st.to_string(),
            };
            collected.push(s.trim_end().to_string());
        }
        finalize_doc(collected)
    }
}

/// 문서 줄들을 정제 — 앞뒤 공백줄 제거, 공통 들여쓰기 제거, 12줄/800자 캡.
fn finalize_doc(raw: Vec<String>) -> Option<String> {
    let mut lines = raw;
    while lines.first().is_some_and(|l| l.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return None;
    }
    let indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    let mut out: Vec<String> = lines
        .iter()
        .map(|l| {
            if l.trim().is_empty() {
                String::new()
            } else if l.len() >= indent {
                l[indent..].to_string()
            } else {
                l.trim_start().to_string()
            }
        })
        .collect();
    let mut truncated = out.len() > 12;
    out.truncate(12);
    let mut doc = out.join("\n");
    if doc.chars().count() > 800 {
        doc = doc.chars().take(800).collect::<String>();
        truncated = true;
    }
    if truncated {
        doc.push('…');
    }
    Some(doc)
}

/// 한 경로 컴포넌트가 Windows 정규화 후 `.git` 으로 귀결되는지 — CVE-2019-1352/1353 류 우회 차단.
/// Win32 는 컴포넌트 끝의 '.'·' ' 를 떼고 ADS(`:`) 이후를 무시하므로 `.git.`·`.git `·
/// `.git::$INDEX_ALLOCATION` 가 실제 `.git` 으로 해석된다. 8.3 단축명 `git~1` 류도 막는다.
fn is_dotgit_component(os: &OsStr) -> bool {
    let s = os.to_string_lossy();
    let s = s.split(':').next().unwrap_or(""); // ADS 제거
    let s = s.trim_end_matches(|c| c == '.' || c == ' '); // 끝의 점·공백 제거
    if s.eq_ignore_ascii_case(".git") {
        return true;
    }
    // `git~1`, `GIT~2` … (NTFS 8.3 단축명) — Git의 is_ntfs_dotgit 와 동일한 방어.
    let lower = s.to_ascii_lowercase();
    lower
        .strip_prefix("git~")
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// 한 경로 컴포넌트가 Windows 예약 장치명(CON/PRN/AUX/NUL/COM1‑9/LPT1‑9)으로 귀결되는지.
/// Windows는 `CON.txt`처럼 확장자가 붙어도, 끝에 점·공백이 붙어도 콘솔/장치로 해석하므로
/// 이런 이름의 생성은 행/오작동을 유발한다 — 첫 '.' 이전 stem을 대소문자 무시로 검사한다.
fn is_reserved_win_name(os: &OsStr) -> bool {
    let s = os.to_string_lossy();
    // stem = 첫 '.' 이전 + 끝의 점·공백 제거(Win32 정규화와 동일).
    let stem = s.split('.').next().unwrap_or("");
    let stem = stem.trim_end_matches(|c| c == ' ' || c == '.');
    let u = stem.to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    // COM1‑9 / LPT1‑9 (COM0·LPT0은 예약 아님).
    let b = u.as_bytes();
    (u.starts_with("COM") || u.starts_with("LPT"))
        && b.len() == 4
        && b[3].is_ascii_digit()
        && b[3] != b'0'
}

/// 파일/폴더 작업용 경로 검증 — 빈 경로·절대경로·`..`·(모든 컴포넌트의) `.git`·예약 장치명 거부.
/// 컨테인먼트(레포 밖 탈출)는 정규화로 별도 검증한다([resolve_in_repo]).
pub(crate) fn validate_rel_file(rel: &str) -> Result<(), IpcError> {
    let p = Path::new(rel);
    if rel.is_empty()
        || p.is_absolute()
        // Prefix(`C:`)·RootDir(`\`)는 join 시 레포 루트를 통째로 대체한다 — 루트/드라이브 상대 거부.
        || p.components().any(|c| match c {
            Component::Prefix(_) | Component::RootDir | Component::ParentDir => true,
            Component::Normal(os) => is_dotgit_component(os) || is_reserved_win_name(os),
            _ => false,
        })
    {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    Ok(())
}

/// 경로 탈출 방어 — 렉시컬 검증(`validate_rel_file`) 후, 대상의 **상위 디렉토리**를 정규화해
/// (심볼릭 링크·정션 따라가서) 레포 루트 안에 있음을 단언한다. 최종 경로(상위정규화 + 파일명)를
/// 돌려준다. 최종 컴포넌트 자체는 따라가지 않으므로(symlink), 호출 측이 링크를 안전히 다룰 수 있다.
pub(crate) fn resolve_in_repo(repo: &Path, rel: &str) -> Result<PathBuf, IpcError> {
    validate_rel_file(rel)?;
    let target = repo.join(rel);
    let parent = target
        .parent()
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "상위 디렉토리를 찾을 수 없습니다"))?;
    let parent_canon = dunce::canonicalize(parent)
        .map_err(|_| IpcError::new(ErrorCode::NotFound, "상위 디렉토리를 찾을 수 없습니다"))?;
    let repo_canon = dunce::canonicalize(repo)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("레포 경로 확인 실패: {e}")))?;
    if !parent_canon.starts_with(&repo_canon) {
        return Err(IpcError::new(ErrorCode::Io, "레포 밖 경로입니다"));
    }
    let name = target
        .file_name()
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "잘못된 경로입니다"))?;
    Ok(parent_canon.join(name))
}

#[cfg(test)]
mod ignore_tests {
    use super::*;

    fn cache(files: &[&str], dirs: &[&str]) -> IgnoreCache {
        IgnoreCache {
            files: files.iter().map(|s| s.to_string()).collect(),
            dirs: dirs.iter().map(|s| s.to_string()).collect(),
            truncated: false,
            fresh: true,
            building: false,
        }
    }

    /// 조상 디렉토리 판정 — "가장 가까운 정렬 이웃만 보는" 식의 지름길은
    /// dirs={"a","a/m"} 에서 "a/z"를 놓친다. 조상 전부를 해시 조회해야 한다.
    #[test]
    fn ancestor_dirs_are_ignored_recursively() {
        let c = cache(&[], &["a", "a/m"]);
        assert!(c.is_ignored("a/z"), "a가 무시면 a/z도 무시");
        assert!(c.is_ignored("a/m/deep/x.txt"));
        assert!(c.is_ignored("a"), "무시 디렉토리 자신");
        assert!(!c.is_ignored("ab/z"), "접두사 문자열 오판 금지(a vs ab)");
        assert!(!c.is_ignored("b/z"));
    }

    #[test]
    fn exact_file_and_miss() {
        let c = cache(&["dist.log", "sub/temp.bin"], &[]);
        assert!(c.is_ignored("dist.log"));
        assert!(c.is_ignored("sub/temp.bin"));
        assert!(!c.is_ignored("src/main.rs"));
    }

    /// 상한 초과(truncated)는 디밍 전체 폴백 — 틀린 디밍보다 없는 디밍(원칙 ③).
    #[test]
    fn truncated_cache_dims_nothing() {
        let mut c = cache(&["x"], &["node_modules"]);
        c.truncated = true;
        assert!(!c.is_ignored("x"));
        assert!(!c.is_ignored("node_modules/pkg/index.js"));
    }

    /// ls-files 출력 파싱 — 후행 '/' = 디렉토리(접힘), NUL 구분, 빈 조각 무시.
    #[test]
    fn parses_ls_files_output() {
        let out = b"node_modules/\0dist/\0secret.env\0deep/cache.tmp\0";
        let c = parse_ignore_output(out);
        assert!(c.dirs.contains("node_modules"));
        assert!(c.dirs.contains("dist"));
        assert!(c.files.contains("secret.env"));
        assert!(c.files.contains("deep/cache.tmp"));
        assert!(!c.truncated && c.fresh);
        assert!(c.is_ignored("node_modules/react/index.js"));
    }

    /// 추적 파일 미디밍(원칙 ①)의 구조적 근거 — --others 출력에 추적 파일이 없으므로
    /// 캐시에 없는 경로는 ignored가 아니다(패턴이 .gitignore에 있어도).
    #[test]
    fn tracked_files_absent_from_cache_are_not_ignored() {
        // "*.log"가 .gitignore에 있어도 추적 중인 build.log는 --others에 안 나온다.
        let c = parse_ignore_output(b"other.log\0");
        assert!(c.is_ignored("other.log"));
        assert!(!c.is_ignored("build.log"), "추적 파일은 절대 미디밍");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 자릿수가 늘어나는 지점에서 사전식이 뒤집히는 것을 막는다 — 실사용 제보 그대로 재현.
    #[test]
    fn natural_cmp_orders_numbers_by_value() {
        let mut v = vec!["세트1", "세트10", "세트11", "세트12", "세트2", "세트9"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["세트1", "세트2", "세트9", "세트10", "세트11", "세트12"]);
    }

    /// 숫자가 여러 번 나오는 이름, 접두어가 다른 이름, 숫자 없는 이름이 섞여도 안정적이어야 한다.
    #[test]
    fn natural_cmp_handles_mixed_and_multi_number_names() {
        let mut v = vec!["cam10_v2.mp4", "cam2_v10.mp4", "cam2_v2.mp4", "readme.md", "cam2_v2.mkv"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            ["cam2_v2.mkv", "cam2_v2.mp4", "cam2_v10.mp4", "cam10_v2.mp4", "readme.md"]
        );
    }

    /// u64 파싱이면 오버플로로 무너지는 자릿수 — 자릿수 비교라 그냥 통과한다.
    #[test]
    fn natural_cmp_survives_numbers_beyond_u64() {
        let big_a = format!("f{}", "9".repeat(30));
        let big_b = format!("f{}", "9".repeat(31));
        assert_eq!(natural_cmp(&big_a, &big_b), std::cmp::Ordering::Less);
    }

    /// 선행 0은 값이 같으므로, 짧은 쪽을 앞에 둬 순서를 결정적으로 만든다.
    #[test]
    fn natural_cmp_is_deterministic_on_leading_zeros() {
        assert_eq!(natural_cmp("a7", "a007"), std::cmp::Ordering::Less);
        assert_eq!(natural_cmp("a007", "a7"), std::cmp::Ordering::Greater);
    }
}
