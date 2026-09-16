//! 이미지 편집기 벡터 문서 사이드카 — 앱 데이터 영속 (태스크 41 §3.1).
//!
//! **레포에는 새 파일을 만들지 않는다.** `git status --untracked-files=all`(status.rs)이 사이드카를
//! 매번 변경 목록에 올리고, 그걸 자동으로 감추는 데 필요한 `.git/info/exclude` 쓰기는 모든 쓰기
//! 커맨드의 `.git` 거부([super::tree::validate_rel_file], CVE 방어)와 정면충돌한다. 그래서
//! 사용자 데이터 루트(projects/settings와 같은 곳)에
//! `image-docs/<sha256(projectId \0 relPath)>.json` 으로 둔다 — 키가 **경로 정체**라 같은 이미지를
//! 다시 열면 문서가 그대로 이어지고, 레포는 1바이트도 오염되지 않는다.
//! 명명 스냅샷은 같은 키의 `.snapshots.json` 으로 갈라 둔다: 1초 디바운스 자동저장이 매번
//! 스냅샷 20벌까지 다시 쓰지 않게 하려는 것이다.
//!
//! 쓰기는 state.rs와 **같은 락·같은 tmp+rename**([crate::state::save_bytes_at])을 탄다.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::diff::{mime_of, stamp_of};
use super::projects::project_path;
use super::tree::validate_rel_file;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 사이드카 1개의 상한 — 에셋 base64 16MB + 문서 본문. 에셋 획득 시점에 프론트가 이미 16MB로
/// 거르므로 여기 걸리는 것은 계약 위반이다. 그래도 막는다: 이 문자열은 IPC를 통째로 건너오고,
/// 상한이 없으면 WebView가 문자열 하나에 멈춘다.
const MAX_DOC_BYTES: usize = 32 * 1024 * 1024;

/// 레포 밖 이미지 1개의 상한 — 고른 바이트가 문서 `assets` 에 base64로 내장되므로
/// [MAX_DOC_BYTES] 안쪽이어야 한다.
const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;

/// 사이드카 1개의 내용과 정체.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDocRead {
    /// 저장된 적이 없으면 `None` — 오류가 아니라 "아직 편집하지 않은 이미지"라는 정상 상태다.
    pub json: Option<String>,
    /// 읽은 시점의 사이드카 정체(`"<mtime_ms>:<len>"`). 프론트는 해석하지 않고 들고 있다가
    /// [image_doc_write] 의 `expected_stamp` 로 되돌려 준다 — 다중 창 충돌 판정의 유일한 근거다.
    pub stamp: Option<String>,
}

/// 레포 밖에서 고른 이미지 바이트. **경로는 담지 않는다** (§3.2).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBytes {
    pub mime: String,
    pub base64: String,
}

/// 사이드카 파일명 키 — `sha256(projectId \0 relPath)` 의 hex.
///
/// 구분자 `\0` 이 있어야 `("ab", "c")` 와 `("a", "bc")` 가 같은 문서를 가리키지 않는다.
/// 내용 해시가 아니라 **경로 정체** 해시인 이유(§3.1 대안 C): e2e 픽스처 이미지들이 바이트까지
/// 동일해 내용 해시면 서로 문서를 공유하고, 평탄화 저장으로 내용이 바뀌는 순간 키가 사라진다.
fn doc_key(project_id: &str, rel_path: &str) -> String {
    let mut h = Sha256::new();
    h.update(project_id.as_bytes());
    h.update(b"\0");
    h.update(rel_path.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `kind` → 파일 접미사. 알 수 없는 값은 거절한다(오타가 조용히 새 파일을 만들면 안 된다).
fn kind_suffix(kind: &str) -> Result<&'static str, IpcError> {
    match kind {
        "doc" => Ok("json"),
        "snapshots" => Ok("snapshots.json"),
        _ => Err(IpcError::new(ErrorCode::Io, "알 수 없는 문서 종류입니다")),
    }
}

/// `app_data_dir/image-docs/<key>.<접미사>`.
///
/// `rel_path` 는 키를 만드는 데만 쓰지만 레포 쓰기 커맨드와 **같은 검증**을 통과시킨다 —
/// 여기서만 통과하는 경로가 생기면 문서가 붙는 파일과 저장이 가능한 파일이 갈라진다.
fn doc_path(
    app: &AppHandle,
    project_id: &str,
    rel_path: &str,
    kind: &str,
) -> Result<PathBuf, IpcError> {
    validate_rel_file(rel_path)?;
    let suffix = kind_suffix(kind)?;
    // `app_data_dir()` 를 직접 부르지 않는다 — e2e 샤딩의 `GPV_DATA_DIR` 오버라이드를 타야
    // 샤드마다 사이드카가 갈린다(`state::data_root` 주석).
    let dir = crate::state::data_root(app).ok_or_else(|| {
        IpcError::new(ErrorCode::Io, "데이터 폴더를 찾을 수 없습니다".to_string())
    })?;
    let key = doc_key(project_id, rel_path);
    Ok(dir.join("image-docs").join(format!("{key}.{suffix}")))
}

/// 사이드카 1개 읽기(경로를 직접 받는 순수 코어 — 테스트 대상).
fn read_doc_at(path: &Path) -> ImageDocRead {
    let Ok(json) = std::fs::read_to_string(path) else {
        return ImageDocRead {
            json: None,
            stamp: None,
        }; // 파일 없음 = 아직 편집한 적 없음, 정상
    };
    ImageDocRead {
        json: Some(json),
        stamp: std::fs::metadata(path).ok().as_ref().and_then(stamp_of),
    }
}

/// 사이드카 1개 원자적 쓰기(경로를 직접 받는 순수 코어 — 테스트 대상). 새 stamp를 돌려준다.
///
/// `expected_stamp` 는 호출자가 그 사이드카를 **읽었을 때**의 정체다. 다르면 다른 창이 그 사이에
/// 저장한 것이므로 `Conflict` 로 거절한다 — 조용히 덮으면 저쪽 창의 편집이 통째로 날아간다.
/// 대상이 아예 없으면 충돌로 보지 않는다(`write_file_bytes` 와 같은 규칙): 문서가 지워졌을 뿐이고,
/// 막아 봐야 사용자가 할 수 있는 일이 저장뿐이다.
///
/// 반환값이 빈 문자열이면 "정체를 알 수 없음"이다(mtime을 못 주는 파일시스템). 그 값이 다음
/// `expected_stamp` 로 돌아와도 [stamp_of] 가 다시 `None` 이라 검사를 건너뛰므로 영구 충돌은 없다.
fn write_doc_at(path: &Path, json: &str, expected_stamp: Option<&str>) -> Result<String, IpcError> {
    if json.len() > MAX_DOC_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            "편집 문서가 너무 큽니다 (32MB 초과)",
        ));
    }
    if let (Some(want), Ok(meta)) = (expected_stamp, std::fs::metadata(path)) {
        // 메타에서 mtime을 못 얻는 파일시스템은 검사를 포기하고 통과시킨다(막으면 그런 환경에서
        // 저장 기능이 통째로 죽는다 — write_file_bytes와 같은 판단).
        if let Some(now) = stamp_of(&meta) {
            if now != want {
                return Err(IpcError::new(
                    ErrorCode::Conflict,
                    "이 이미지의 편집 문서를 다른 창이 먼저 저장했습니다",
                ));
            }
        }
    }
    crate::state::save_bytes_at(path, json.as_bytes())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("편집 문서 저장 실패: {e}")))?;
    Ok(std::fs::metadata(path)
        .ok()
        .as_ref()
        .and_then(stamp_of)
        .unwrap_or_default())
}

/// 벡터 문서(또는 스냅샷 목록)를 읽는다 — 없으면 `json: null`(오류 아님).
#[tauri::command]
pub async fn image_doc_read(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    kind: String,
) -> Result<ImageDocRead, IpcError> {
    project_path(&state, &project_id)?; // 등록된 프로젝트인지만 확인 — 레포는 건드리지 않는다
    Ok(read_doc_at(&doc_path(&app, &project_id, &rel_path, &kind)?))
}

/// 벡터 문서(또는 스냅샷 목록)를 원자적으로 저장하고 새 stamp를 돌려준다.
/// 다른 창이 먼저 저장했으면 `Conflict`, 32MB를 넘으면 `Io`.
#[tauri::command]
pub async fn image_doc_write(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    kind: String,
    json: String,
    expected_stamp: Option<String>,
) -> Result<String, IpcError> {
    project_path(&state, &project_id)?;
    let path = doc_path(&app, &project_id, &rel_path, &kind)?;
    write_doc_at(&path, &json, expected_stamp.as_deref())
}

/// 앱 안에서 이미지를 이름변경·이동했을 때 문서를 따라 옮긴다(문서·스냅샷 둘 다).
/// 한 번도 편집하지 않은 이미지를 옮기는 것이 정상 경로이므로, 없으면 조용히 no-op.
#[tauri::command]
pub async fn image_doc_move(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    from: String,
    to: String,
) -> Result<(), IpcError> {
    project_path(&state, &project_id)?;
    for kind in ["doc", "snapshots"] {
        let src = doc_path(&app, &project_id, &from, kind)?;
        if !src.exists() {
            continue;
        }
        let dst = doc_path(&app, &project_id, &to, kind)?;
        if let Some(dir) = dst.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| IpcError::new(ErrorCode::Io, format!("편집 문서 이동 실패: {e}")))?;
        }
        std::fs::rename(&src, &dst)
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("편집 문서 이동 실패: {e}")))?;
    }
    Ok(())
}

/// 이미지를 지웠거나 제자리 평탄화 저장이 끝났을 때 문서를 버린다(문서·스냅샷 둘 다).
#[tauri::command]
pub async fn image_doc_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<(), IpcError> {
    project_path(&state, &project_id)?;
    for kind in ["doc", "snapshots"] {
        let path = doc_path(&app, &project_id, &rel_path, kind)?;
        if !path.exists() {
            continue;
        }
        std::fs::remove_file(&path)
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("편집 문서 삭제 실패: {e}")))?;
    }
    Ok(())
}

/// 레포 **밖** 이미지 1개를 사용자가 고르게 하고 바이트만 돌려준다(취소 = `None`).
///
/// 경로를 프론트에 넘기지 않는 것이 핵심이다 — 프론트가 절대경로를 들고 있으면 다음 요구는
/// 반드시 "그 경로에 저장"이 되고, 그런 커맨드는 이 저장소에 만들지 않는다(INDEX §10.4).
/// 고른 바이트는 문서 `assets` 에 base64로 내장되므로 여기서 종류·크기 상한을 건다.
#[tauri::command]
pub async fn asset_pick_file(app: AppHandle) -> Result<Option<AssetBytes>, IpcError> {
    // blocking_pick_file 은 다이얼로그가 닫힐 때까지 이 async 워커를 통째로 붙잡는다 — 콜백+oneshot.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("이미지 선택")
        .add_filter(
            "이미지",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "tif", "tiff", "svg",
            ],
        )
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx
        .await
        .map_err(|_| IpcError::new(ErrorCode::Io, "파일 선택 창이 응답하지 않았습니다"))?;
    let Some(file) = picked else {
        return Ok(None); // 사용자가 취소 — 정상
    };
    let path = file
        .into_path()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 경로를 읽지 못했습니다: {e}")))?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let mime = mime_of(&name);
    if !mime.starts_with("image/") {
        return Err(IpcError::new(
            ErrorCode::Io,
            "이미지 파일이 아닙니다 (png·jpg·gif·webp·bmp·avif·tiff·svg)",
        ));
    }
    // 크기를 먼저 본다 — 읽고 나서 거절하면 거대 파일도 일단 메모리에 올렸다가 버린다.
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일을 읽지 못했습니다: {e}")))?;
    if meta.len() > MAX_ASSET_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            "이미지가 너무 큽니다 (16MB 초과)",
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일을 읽지 못했습니다: {e}")))?;
    Ok(Some(AssetBytes {
        mime,
        base64: B64.encode(&bytes),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 키는 결정적이어야 한다 — 같은 이미지를 다시 열었을 때 같은 파일을 찾지 못하면
    /// 이 기능의 존재 이유(닫아도 문서가 남는다)가 통째로 사라진다. 그리고 다른 경로는 갈라져야
    /// 한다: 구분자 없이 이어 붙이면 ("ab","c")와 ("a","bc")가 한 문서를 덮어쓴다.
    #[test]
    fn doc_key_is_deterministic_and_path_scoped() {
        let key = doc_key("p1", "img/a.png");
        assert_eq!(key, doc_key("p1", "img/a.png"), "같은 입력 → 같은 파일명");
        assert_eq!(key.len(), 64, "sha256 hex 64자");
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(key, doc_key("p1", "img/b.png"), "다른 파일은 다른 문서");
        assert_ne!(key, doc_key("p2", "img/a.png"), "다른 프로젝트는 다른 문서");
        assert_ne!(doc_key("ab", "c"), doc_key("a", "bc"), "구분자 없는 충돌");
    }

    /// 32MB 상한 — 넘으면 **쓰지도 않고** 거절한다. 반쯤 쓴 파일을 남기면 다음 로드가
    /// 손상으로 보고 사용자 작업을 통째로 버린다.
    #[test]
    fn oversized_doc_is_rejected_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        let huge = "x".repeat(MAX_DOC_BYTES + 1);
        let err = write_doc_at(&path, &huge, None).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        assert!(!path.exists(), "거절했는데 파일이 생겼다");
    }

    /// 낡은 stamp로 쓰면 `Conflict` — 조용히 덮으면 다른 창의 편집이 통째로 날아간다.
    /// (길이가 다른 내용을 쓴다: stamp는 `<mtime_ms>:<len>` 이라 같은 밀리초·같은 길이면
    ///  두 stamp가 같아져 시험 자체가 성립하지 않는다.)
    #[test]
    fn stale_stamp_is_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.json");
        let first = write_doc_at(&path, "{}", None).unwrap();
        let second = write_doc_at(&path, "{\"a\":1}", Some(&first)).unwrap();
        assert_ne!(first, second);

        let err = write_doc_at(&path, "{\"bb\":22}", Some(&first)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);

        let now = read_doc_at(&path);
        assert_eq!(now.json.as_deref(), Some("{\"a\":1}"), "거절이 파일을 건드렸다");
        assert_eq!(now.stamp.as_deref(), Some(second.as_str()));

        // 최신 stamp면 통과한다(충돌 판정이 영구 고착되지 않는다).
        write_doc_at(&path, "{\"ccc\":333}", Some(&second)).unwrap();
    }
}
