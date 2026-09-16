use std::path::{Component, Path};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::{DiffTarget, FileDiff};
use crate::state::AppState;
use crate::text::encoding;

/// 한쪽이 이 크기를 넘으면 내용 전송을 생략한다 (뷰어 멈춤 방지).
const MAX_DIFF_BYTES: usize = 1_572_864; // 1.5MB

/// 한 번의 배치 프리페치에서 읽는 최대 파일 수 — 거대 변경 목록의 spawn 폭주 방지
const MAX_BATCH_FILES: usize = 30;

/// `encoding` 은 사용자가 상태바에서 **직접 고른** 인코딩(B-K6). 생략하면 자동 탐지다.
/// 탐지가 틀렸을 때 사람이 뒤집을 유일한 수단이므로, 여기 없으면 오탐이 곧 저장 사고가 된다.
#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    target: DiffTarget,
    encoding: Option<String>,
) -> Result<FileDiff, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let enc = encoding.as_deref().filter(|e| !e.is_empty());
    match target {
        DiffTarget::Worktree { path } => worktree_diff(&repo, path, enc).await,
        DiffTarget::Index { path } => index_diff(&repo, path, enc).await,
        DiffTarget::Commit { sha, path } => commit_diff(&repo, sha, path, enc).await,
        DiffTarget::File { path } => file_content(&repo, path, enc).await,
    }
}

/// 워크트리 파일 읽기 결과.
enum Blob {
    /// 파일이 없다 — 워크트리에서 삭제됐거나 아직 없다.
    Missing,
    /// 상한 초과 — **내용을 읽지 않았다.**
    TooLarge,
    Bytes(Vec<u8>),
}

/// 워크트리 파일을 읽되 **크기를 먼저 확인한다.**
///
/// 예전엔 `tokio::fs::read`로 전량을 읽은 뒤 `build_diff`에서 상한을 적용했다. 초과분은 곧바로
/// `too_large` 판정으로 버려지므로 그 읽기는 통째로 낭비였고, 프리페치(`usePrefetchDiffs`)가
/// status 갱신마다 untracked까지 포함해 자동으로 던지기 때문에 **레포에 큰 파일을 복사해 넣기만
/// 해도** 클릭 한 번 없이 수 GB를 읽었다. metadata로 먼저 걸러 아예 읽지 않는다.
///
/// metadata와 read 사이에 파일이 커질 수 있지만, `build_diff`의 길이 검사가 그대로 남아 있어
/// 최종 판정은 어차피 정확하다 — 여기서 막는 것은 "확실히 큰 것"의 낭비다.
async fn read_capped(path: &Path) -> Result<Blob, IpcError> {
    match tokio::fs::metadata(path).await {
        Ok(m) if m.len() > MAX_DIFF_BYTES as u64 => return Ok(Blob::TooLarge),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Blob::Missing),
        Err(e) => {
            return Err(IpcError::new(
                ErrorCode::Io,
                format!("파일 정보 조회 실패: {e}"),
            ))
        }
    }
    match tokio::fs::read(path).await {
        Ok(b) => Ok(Blob::Bytes(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Blob::Missing),
        Err(e) => Err(IpcError::new(ErrorCode::Io, format!("파일 읽기 실패: {e}"))),
    }
}

/// 내용 없이 "너무 큼"만 알리는 응답 — 뷰어가 안내 문구를 띄운다.
fn too_large_diff(path: String) -> FileDiff {
    FileDiff {
        path,
        old_content: None,
        new_content: None,
        is_binary: false,
        too_large: true,
        encoding: "UTF-8".to_string(),
        bom: false,
        lossy: false,
    }
}

/// 단일 파일 보기 — 워크트리 내용만 new_content로 반환(old=None). 트리 클릭용.
async fn file_content(repo: &Path, path: String, enc: Option<&str>) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;
    match read_capped(&repo.join(&path)).await? {
        Blob::TooLarge => Ok(too_large_diff(path)),
        Blob::Missing => Ok(build_diff(path, None, None, enc)),
        Blob::Bytes(b) => Ok(build_diff(path, None, Some(b), enc)),
    }
}

/// diff 프리페치용 배치 — 단일 invoke로 여러 파일을 백엔드 병렬 조회 (§10 패턴).
/// 실패한 항목은 조용히 건너뛴다 — 클릭 시 단건 경로가 오류를 표면화한다.
#[tauri::command]
pub async fn get_file_diffs(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<Vec<FileDiff>, IpcError> {
    let repo = project_path(&state, &project_id)?;

    // 동시 실행은 제한하지 않는다(원래대로). status.rs에서 같은 제한을 실측해 봤더니 편차에
    // 묻혀 이득이 확인되지 않았고(그쪽 주석에 수치), 여기는 위의 크기 사전 게이트가 큰 파일에
    // 대해 `git show` 자체를 없애 herd를 이미 줄여 놓았다. 근거 없이 동작을 바꾸지 않는다.
    let futures = paths.into_iter().take(MAX_BATCH_FILES).map(|path| {
        let repo = repo.clone();
        // 프리페치는 언제나 자동 탐지다 — 수동 인코딩은 "지금 보고 있는 한 파일"의 이야기다.
        async move { worktree_diff(&repo, path, None).await.ok() }
    });
    let results = futures::future::join_all(futures).await;

    // 단일 IPC 응답 크기 예산 — 초과하는 큰 파일은 제외하고 클릭 시 단건 조회에 맡긴다
    const BATCH_BYTE_BUDGET: usize = 4 * 1024 * 1024;
    let mut budget = BATCH_BYTE_BUDGET;
    let mut out = Vec::new();
    for diff in results.into_iter().flatten() {
        let size = diff.old_content.as_ref().map_or(0, String::len)
            + diff.new_content.as_ref().map_or(0, String::len);
        if size > budget {
            continue;
        }
        budget -= size;
        out.push(diff);
    }
    Ok(out)
}

/// old = 인덱스 버전(`git show :<path>`, 없으면 None) / new = 워크트리 파일.
async fn worktree_diff(
    repo: &Path,
    path: String,
    enc: Option<&str>,
) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;

    // 워크트리 쪽을 **먼저** 판정한다 — 초과면 인덱스 버전을 뜨는 `git show` 자식 프로세스도
    // 띄우지 않는다(프리페치가 배치로 던지므로 이 절약이 그대로 곱해진다).
    let new = read_capped(&repo.join(&path)).await?;
    if matches!(new, Blob::TooLarge) {
        return Ok(too_large_diff(path));
    }

    let old_bytes = content_at(repo, &format!(":{path}")).await?;
    let new_bytes = match new {
        Blob::Bytes(b) => Some(b),
        _ => None, // 워크트리에서 삭제됨
    };

    Ok(build_diff(path, old_bytes, new_bytes, enc))
}

/// staged 변경 검토: HEAD 버전 ↔ 인덱스 버전. (설계 §7 index 모드)
async fn index_diff(repo: &Path, path: String, enc: Option<&str>) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;
    let old_bytes = content_at(repo, &format!("HEAD:{path}")).await?;
    let new_bytes = content_at(repo, &format!(":{path}")).await?;
    Ok(build_diff(path, old_bytes, new_bytes, enc))
}

/// 커밋 기준 diff: 첫 부모 버전 ↔ 해당 커밋 버전. root 커밋은 부모가 없어 old = None.
async fn commit_diff(
    repo: &Path,
    sha: String,
    path: String,
    enc: Option<&str>,
) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;
    if !runner::is_valid_sha(&sha) {
        return Err(IpcError::new(ErrorCode::GitError, "잘못된 커밋 해시입니다"));
    }
    let old_bytes = content_at(repo, &format!("{sha}^:{path}")).await?;
    let new_bytes = content_at(repo, &format!("{sha}:{path}")).await?;
    Ok(build_diff(path, old_bytes, new_bytes, enc))
}

/// `git show <spec>` 내용 — 존재하지 않으면(없는 경로/없는 부모) None으로 added/deleted를 표현.
async fn content_at(repo: &Path, spec: &str) -> Result<Option<Vec<u8>>, IpcError> {
    match runner::run_git(Some(repo), &["show", spec], runner::READ_TIMEOUT_SECS).await {
        Ok(out) if out.code == 0 => Ok(Some(out.stdout)),
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 양쪽 바이트에서 바이너리/크기 가드를 적용해 FileDiff를 만든다 (모든 diff 모드 공용).
///
/// **여기가 원본 바이트를 잃던 자리다**(설계 B.1). `from_utf8_lossy` 는 유효하지 않은 바이트를
/// `U+FFFD` 로 비가역 치환했고, 그 문자열을 그대로 저장하면 CP949 주석이 영구 소실됐다.
/// 이제 인코딩을 탐지해 디코드하고, **무엇으로 읽었는지를 FileDiff 로 실어 보낸다** —
/// 저장 경로가 그걸 되돌려 줘야 왕복이 성립한다(B-K1).
fn build_diff(
    path: String,
    old_bytes: Option<Vec<u8>>,
    new_bytes: Option<Vec<u8>>,
    enc: Option<&str>,
) -> FileDiff {
    let too_large = [&old_bytes, &new_bytes]
        .iter()
        .any(|b| b.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES));
    let is_binary = !too_large
        && [&old_bytes, &new_bytes]
            .iter()
            .any(|b| b.as_ref().is_some_and(|b| looks_binary(b)));

    if too_large || is_binary {
        return FileDiff {
            path,
            old_content: None,
            new_content: None,
            is_binary,
            too_large,
            encoding: "UTF-8".to_string(),
            bom: false,
            lossy: false,
        };
    }

    let decode = |b: Vec<u8>| {
        enc.and_then(|e| encoding::decode_as(&b, e))
            .unwrap_or_else(|| encoding::decode(&b))
    };
    let old = old_bytes.map(&decode);
    let new = new_bytes.map(&decode);
    // 인코딩 정체는 **저장 대상**(new = 워크트리 파일)을 따른다. 저장은 그쪽으로만 간다.
    let of = new.as_ref().or(old.as_ref());
    FileDiff {
        path,
        encoding: of.map_or("UTF-8", |d| d.encoding).to_string(),
        bom: of.is_some_and(|d| d.bom),
        lossy: of.is_some_and(|d| d.lossy),
        old_content: old.map(|d| d.text),
        new_content: new.map(|d| d.text),
        is_binary: false,
        too_large: false,
    }
}

/// 경로는 항상 우리 status 출력에서 오지만, 방어적으로 레포 밖 접근을 차단한다.
/// Prefix(`C:`)·RootDir(`\`)는 join 시 레포 루트를 통째로 대체한다 — 윈도우에서 `\Windows\...`는
/// is_absolute()==false지만 드라이브 루트로 튀므로 반드시 함께 거부한다(tree.rs의 쓰기 게이트와 동일).
fn validate_rel_path(path: &str) -> Result<(), IpcError> {
    let p = Path::new(path);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 파일 경로입니다"));
    }
    Ok(())
}

/// NUL 바이트가 보이면 바이너리 — 단 **BOM 이 있으면 텍스트다**(B-K5).
///
/// UTF-16 은 ASCII 문자마다 NUL 이 끼므로 NUL 검사만 하면 `.rc`·일부 로그처럼 실무에서 흔한
/// UTF-16 파일이 전부 "바이너리 파일"로 빠진다. BOM 은 추측이 아니라 선언이므로 먼저 본다.
fn looks_binary(bytes: &[u8]) -> bool {
    !encoding::has_bom(bytes) && bytes.iter().take(8192).any(|&b| b == 0)
}

/// 이미지 뷰어용 파일 한도 — base64로 IPC 전송하므로 과대 파일을 막는다.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024; // 25MB

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBytes {
    pub mime: String,
    pub base64: String,
    /// 읽은 시점의 파일 정체 — `"<mtime_ms>:<len>"`. 프론트는 해석하지 않고 그대로 들고 있다가
    /// 되돌려 준다(`write_file_bytes` 의 `expected_stamp`). 그 사이 남이 파일을 바꿨는지
    /// 판정하는 유일한 근거다. 내용 해시가 아닌 이유: 25MB 를 매 저장마다 되읽지 않으려는 것이고,
    /// mtime 하나로 안 하는 이유는 파일시스템에 따라 해상도가 초 단위(FAT 는 2초)라
    /// 같은 초 안의 재기록을 못 잡기 때문이다. 길이가 그 구멍을 메운다.
    pub stamp: Option<String>,
}

/// 파일 메타 → 스탬프 문자열. 메타를 못 읽으면 None(=검사 불가, 통과시킨다).
pub(crate) fn stamp_of(meta: &std::fs::Metadata) -> Option<String> {
    let ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(format!("{ms}:{}", meta.len()))
}

/// 워크트리의 파일을 그대로 읽어 (mime, base64)로 반환 — 이미지(png/jpg/webp/svg…) 미리보기용.
#[tauri::command]
pub async fn read_file_base64(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<FileBytes, IpcError> {
    let repo = project_path(&state, &project_id)?;
    validate_rel_path(&rel_path)?;
    let full = repo.join(&rel_path);
    // 크기를 먼저 본다 — 읽고 나서 거절하면 25GB 파일도 일단 메모리에 올렸다가 버린다
    // (read_capped와 같은 이유). 아래 길이 검사는 metadata 이후 커진 경우의 백스톱으로 남긴다.
    let mut stamp = None;
    if let Ok(m) = tokio::fs::metadata(&full).await {
        if m.len() > MAX_IMAGE_BYTES as u64 {
            return Err(IpcError::new(
                ErrorCode::Io,
                "파일이 너무 큽니다 (25MB 초과)",
            ));
        }
        // 읽기 **전** 메타로 찍는다. 읽은 뒤에 찍으면 읽는 동안의 변경을 스탬프가 흡수해
        // "안 바뀐 것처럼" 보인다 — 그 창이 정확히 막으려는 대상이다.
        stamp = stamp_of(&m);
    }
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 읽기 실패: {e}")))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            "파일이 너무 큽니다 (25MB 초과)",
        ));
    }
    Ok(FileBytes {
        mime: mime_of(&rel_path),
        base64: B64.encode(&bytes),
        stamp,
    })
}

pub(crate) fn mime_of(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        // MIME이 틀리면 디코드 가능한 플랫폼에서도 브라우저가 시도조차 하지 않는다.
        // (language-map.ts의 IMAGE_EXT와 짝 — 한쪽만 늘리면 조용히 깨진다)
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 이미지 뷰어가 여는 확장자는 전부 MIME이 매핑돼야 한다.
    /// data URL의 MIME이 틀리면 디코드 가능한 플랫폼에서도 브라우저가 시도조차 하지 않는다
    /// (프론트 `IMAGE_EXT`와 짝 — 한쪽만 늘리면 조용히 깨진다).
    #[test]
    fn image_mime_covers_viewer_extensions() {
        for (name, want) in [
            ("a.png", "image/png"),
            ("a.jpg", "image/jpeg"),
            ("a.jpeg", "image/jpeg"),
            ("a.gif", "image/gif"),
            ("a.webp", "image/webp"),
            ("a.bmp", "image/bmp"),
            ("a.ico", "image/x-icon"),
            ("a.avif", "image/avif"),
            ("a.svg", "image/svg+xml"),
            ("a.tif", "image/tiff"),
            ("a.tiff", "image/tiff"),
            ("a.heic", "image/heic"),
            ("a.heif", "image/heif"),
        ] {
            assert_eq!(mime_of(name), want, "{name}의 MIME이 빠지면 표시가 조용히 실패한다");
        }
        // 대소문자 무관
        assert_eq!(mime_of("A.TIFF"), "image/tiff");
    }

    /// 상한 초과 파일은 **읽지 않고** 걸러야 한다.
    ///
    /// 이 게이트가 없으면 프리페치가 status 갱신마다 자동으로(클릭 한 번 없이) 거대 파일을
    /// 전량 읽고, 읽은 내용은 too_large 판정으로 통째로 버려진다.
    #[tokio::test]
    async fn oversized_file_is_gated_before_read() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.bin");
        // 스파스 파일 — 실제로 채우지 않고 길이만 늘려 metadata만 크게 만든다.
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_DIFF_BYTES as u64 + 1)
            .unwrap();
        assert!(matches!(
            read_capped(&big).await.unwrap(),
            Blob::TooLarge
        ));
    }

    /// 상한 이하는 그대로 읽고, 없는 파일은 Missing(삭제된 파일의 diff 표현).
    #[tokio::test]
    async fn small_reads_and_absent_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("s.txt");
        std::fs::write(&small, b"hello").unwrap();
        match read_capped(&small).await.unwrap() {
            Blob::Bytes(b) => assert_eq!(b, b"hello".to_vec()),
            _ => panic!("Bytes를 기대했다"),
        }
        assert!(matches!(
            read_capped(&dir.path().join("nope")).await.unwrap(),
            Blob::Missing
        ));
    }
}
