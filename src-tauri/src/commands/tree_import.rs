// 앱 밖(탐색기·바탕화면)에서 파일 트리로 끌어 놓은 파일을 프로젝트 폴더 안에 복사한다.
//
// 경로가 아니라 **내용**을 받는다: 창들이 OS 드롭 핸들러를 끄고 있어(lib.rs `disable_drag_drop_handler` — 켜면 웹뷰 안의
// HTML5 드래그가 죽는다) 드롭은 웹뷰의 `File` 객체로만 오고, 웹뷰는 원본 경로를 알려 주지 않는다. 그래서 프론트가 파일을
// 조각(raw IPC 본문)으로 읽어 보내고 여기서 이어 쓴다 — 세 OS 공통이고 수 GB 영상도 메모리에 통째로 올리지 않는다.
//
// 같은 폴더의 임시 파일(`.이름.gpv-tmp-…`)에 다 쓰고 fsync 한 뒤 rename 한다 — 복사 도중 앱이 죽거나 디스크가 차도
// 반쯤 쓴 파일이 진짜 이름으로 남지 않는다(raw_file.rs 쓰기와 같은 이유).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;
use crate::state::AppState;

struct Upload {
    target: PathBuf,
    tmp: PathBuf,
    file: File,
    written: u64,
    size: u64,
    overwrite: bool,
}

/// 진행 중인 복사. 조각을 쓰는 동안은 맵에서 꺼내 두므로 락은 짧게만 잡힌다.
/// ponytail: 창이 복사 도중 닫히면 임시 파일이 남는다 — 이름이 `.…gpv-tmp-…`라 눈에 띄고, 다음에 같은 파일을 놓으면 새 임시 파일을 쓴다.
static UPLOADS: LazyLock<Mutex<HashMap<String, Upload>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn io_err(e: std::io::Error) -> IpcError {
    // Windows 32 = 공유 위반(다른 프로그램이 대상 파일을 열고 있음) — 덮어쓰기 rename 이 여기서 막힌다.
    if cfg!(windows) && e.raw_os_error() == Some(32) {
        return IpcError::new(ErrorCode::Io, text_files::file_locked_by_other_program());
    }
    IpcError::new(ErrorCode::Io, text_files::file_save_failed(e))
}

fn missing_upload(id: &str) -> IpcError {
    IpcError::new(ErrorCode::NotFound, text_files::tree_import_unknown_upload(&id))
}

fn take(id: &str) -> Result<Upload, IpcError> {
    UPLOADS.lock().unwrap_or_else(|e| e.into_inner()).remove(id).ok_or_else(|| missing_upload(id))
}

/// 대상 검사 — 링크·폴더 위에는 쓰지 않고, 덮어쓰기를 허락하지 않았으면 이미 있는 이름을 거절한다(ALREADY_EXISTS →
/// 프론트가 모아서 한 번에 묻는다).
fn check_target(target: &std::path::Path, overwrite: bool) -> Result<(), IpcError> {
    if let Ok(m) = fs::symlink_metadata(target) {
        if m.file_type().is_symlink() {
            return Err(IpcError::new(ErrorCode::Io, text_files::cannot_write_symlink()));
        }
        if m.is_dir() {
            return Err(IpcError::new(ErrorCode::AlreadyExists, text_files::cannot_write_directory()));
        }
        if !overwrite {
            return Err(IpcError::new(ErrorCode::AlreadyExists, text_files::file_same_name_exists()));
        }
    }
    Ok(())
}

#[tauri::command(async)]
pub async fn tree_import_begin(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    size: u64,
    overwrite: bool,
) -> Result<String, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    check_target(&target, overwrite)?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let tmp = target.with_file_name(format!(".{name}.gpv-tmp-{id}"));
    let file = OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io_err)?;
    UPLOADS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), Upload { target, tmp, file, written: 0, size, overwrite });
    Ok(id)
}

/// 조각 하나 — 본문은 raw, 헤더 `x-gpv-upload`(id)·`x-gpv-offset`(이미 쓴 바이트 수와 같아야 한다: 순서가 꼬인 조각을
/// 이어 붙이면 파일이 조용히 깨진다).
#[tauri::command(async)]
pub async fn tree_import_chunk(request: Request<'_>) -> Result<(), IpcError> {
    let h = request.headers();
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let id = get("x-gpv-upload").unwrap_or_default();
    let offset: u64 = get("x-gpv-offset").and_then(|s| s.parse().ok()).ok_or_else(|| missing_upload(&id))?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(IpcError::new(ErrorCode::Io, text_files::raw_body_required()));
    };
    let body = body.clone();
    let mut up = take(&id)?;
    let r = tokio::task::spawn_blocking(move || {
        let res = if offset != up.written || up.written + body.len() as u64 > up.size {
            Err(IpcError::new(ErrorCode::Io, text_files::tree_import_bad_chunk(offset, up.written)))
        } else {
            up.file.write_all(&body).map_err(io_err).map(|()| up.written += body.len() as u64)
        };
        (up, res)
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, text_files::raw_write_task_failed(e)))?;
    let (up, res) = r;
    if res.is_err() {
        discard(up);
    } else {
        UPLOADS.lock().unwrap_or_else(|e| e.into_inner()).insert(id, up);
    }
    res
}

fn discard(up: Upload) {
    let Upload { tmp, file, .. } = up;
    drop(file);
    if let Err(e) = fs::remove_file(&tmp) {
        log::warn!("[tree-import] 임시 파일 정리 실패 {}: {e}", tmp.display());
    }
}

#[tauri::command(async)]
pub async fn tree_import_finish(upload_id: String) -> Result<(), IpcError> {
    let Upload { target, tmp, file, written, size, overwrite } = take(&upload_id)?;
    tokio::task::spawn_blocking(move || {
        let res = (|| {
            if written != size {
                return Err(IpcError::new(ErrorCode::Io, text_files::tree_import_bad_chunk(written, size)));
            }
            file.sync_all().map_err(io_err)?;
            // 열린 핸들을 먼저 닫는다 — Windows 는 열려 있는 파일의 rename 을 공유 위반으로 거절한다.
            drop(file);
            // begin 이후에 같은 이름이 생겼을 수 있다 — rename 은 말없이 덮으므로 한 번 더 본다.
            check_target(&target, overwrite)?;
            fs::rename(&tmp, &target).map_err(io_err)
        })();
        if res.is_err() {
            if let Err(e) = fs::remove_file(&tmp) {
                log::warn!("[tree-import] 임시 파일 정리 실패 {}: {e}", tmp.display());
            }
        }
        res
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, text_files::raw_write_task_failed(e)))?
}

#[tauri::command(async)]
pub async fn tree_import_abort(upload_id: String) -> Result<(), IpcError> {
    if let Ok(up) = take(&upload_id) {
        tokio::task::spawn_blocking(move || discard(up))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text_files::raw_write_task_failed(e)))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 대상 검사: 없는 이름 통과 · 있는 파일은 덮어쓰기 허락 때만 · 폴더 위에는 안 됨.
    #[test]
    fn tree_import_check_target_rules() {
        let root = std::env::temp_dir().join(format!("gpv-tree-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dir")).unwrap();
        fs::write(root.join("a.txt"), "x").unwrap();
        assert!(check_target(&root.join("new.txt"), false).is_ok());
        assert_eq!(check_target(&root.join("a.txt"), false).unwrap_err().code, ErrorCode::AlreadyExists);
        assert!(check_target(&root.join("a.txt"), true).is_ok());
        assert!(check_target(&root.join("dir"), true).is_err(), "폴더는 덮어쓰기 허락이어도 거절");
        fs::remove_dir_all(&root).unwrap();
    }
}
