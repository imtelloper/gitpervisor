// 진단/로그 관측 — 패닉 로그(panic.log)·플러그인 로그 폴더를 사용자가 찾고·보고·비우게 한다.
// 엔진단 크래시 내성(전역 패닉 훅 + 파일 로깅 + 프론트 ErrorBoundary)은 이미 갖춰져 있고,
// 여기서는 그 산출물을 "디버깅 가능"하게 노출(열기/보기)하고, 무한 증가를 막는다(시작 시 prune).
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::error::{ErrorCode, IpcError};

const PANIC_LOG: &str = "panic.log";
const PANIC_LOG_ROT: &str = "panic.log.1";
/// 로그 폴더 총량 하드 상한(시작 시) — 100MB. 평소엔 플러그인 로그(KeepSome ≈90MB) + 패닉 로그
/// (≈8MB) ≈ 98MB로 이 아래를 유지하므로 발화하지 않지만, 어떤 경우에도 폴더가 100MB를
/// 넘지 않도록 가장 오래된 것부터 정리하는 하드 천장으로 둔다("최신 내용으로 100MB까지만").
const LOG_DIR_BUDGET: u64 = 100 * 1024 * 1024;
/// 패닉 로그 단일 파일 상한 — 넘으면 1세대만 보존(panic.log.1)하고 새로 시작.
const PANIC_LOG_MAX: u64 = 4 * 1024 * 1024;
/// read_crash_log 단일 응답 상한(IPC/뷰어 보호).
const READ_CAP: u64 = 2 * 1024 * 1024;

fn log_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    app.path()
        .app_log_dir()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("로그 폴더 경로 확인 실패: {e}")))
}

/// 로그 폴더를 OS 파일 탐색기로 연다(설정 "로그 폴더 열기").
#[tauri::command]
pub fn open_logs_folder(app: AppHandle) -> Result<(), IpcError> {
    let dir = log_dir(&app)?;
    let _ = fs::create_dir_all(&dir);
    open_dir(&dir)
}

/// 로그 상태 — 패닉 로그 크기/최종시각 + 폴더 경로. 시작 시 크래시 감지 배너에 쓰인다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    log_dir: String,
    panic_log_bytes: u64,
    /// panic.log 최종 수정 시각(RFC3339) — 없으면 None. 프론트가 직전 확인 시점과 비교해
    /// "이전 실행에서 오류 감지" 배너를 한 번만 띄운다(localStorage 마커).
    last_crash_at: Option<String>,
}

#[tauri::command]
pub fn get_log_status(app: AppHandle) -> Result<LogStatus, IpcError> {
    let dir = log_dir(&app)?;
    let (bytes, last) = match fs::metadata(dir.join(PANIC_LOG)) {
        Ok(m) => {
            let when = m.modified().ok().map(|t| {
                let dt: chrono::DateTime<chrono::Local> = t.into();
                dt.to_rfc3339()
            });
            (m.len(), when)
        }
        Err(_) => (0, None),
    };
    Ok(LogStatus {
        log_dir: dir.display().to_string(),
        panic_log_bytes: bytes,
        last_crash_at: last,
    })
}

/// 패닉 로그 꼬리(최대 max_bytes, 상한 2MB) 읽기 — 인앱 뷰어용. 큰 파일은 끝부분만 돌려준다.
#[tauri::command]
pub fn read_crash_log(app: AppHandle, max_bytes: u64) -> Result<String, IpcError> {
    let data = match fs::read(log_dir(&app)?.join(PANIC_LOG)) {
        Ok(d) => d,
        Err(_) => return Ok(String::new()),
    };
    let cap = max_bytes.min(READ_CAP) as usize;
    let start = data.len().saturating_sub(cap);
    Ok(String::from_utf8_lossy(&data[start..]).into_owned())
}

/// 패닉 로그 비우기 — 확인 후 호출. 현재본·1세대 회전본을 함께 지운다(다음 패닉이 새로 만든다).
#[tauri::command]
pub fn clear_crash_log(app: AppHandle) -> Result<(), IpcError> {
    let dir = log_dir(&app)?;
    for name in [PANIC_LOG, PANIC_LOG_ROT] {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(IpcError::new(
                    ErrorCode::Io,
                    format!("크래시 로그 삭제 실패: {e}"),
                ))
            }
        }
    }
    Ok(())
}

/// 시작 시 로그 정리 — 패닉 로그가 크면 1세대만 보존, 로그 폴더 총량을 상한 아래로.
/// best-effort: 실패는 무해(로그를 못 지워도 앱은 정상). lib.rs setup에서 1회 호출.
pub fn prune_logs(dir: &Path) {
    // 1) panic.log 단일 상한 — 넘으면 panic.log.1로 밀어내고 새로 시작.
    if let Ok(m) = fs::metadata(dir.join(PANIC_LOG)) {
        if m.len() > PANIC_LOG_MAX {
            let _ = fs::rename(dir.join(PANIC_LOG), dir.join(PANIC_LOG_ROT));
        }
    }
    // 2) 로그 폴더 총량 — 가장 오래된 파일부터 삭제해 budget 이하로.
    //    패닉 로그(현재본/회전본)는 디버깅의 핵심이라 보존 — 회전된 플러그인 로그만 정리한다.
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total = 0u64;
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        total += meta.len();
        files.push((
            e.path(),
            meta.len(),
            meta.modified().unwrap_or(std::time::UNIX_EPOCH),
        ));
    }
    if total <= LOG_DIR_BUDGET {
        return;
    }
    files.sort_by_key(|(_, _, t)| *t); // 오래된 것 먼저
    for (path, len, _) in files {
        if total <= LOG_DIR_BUDGET {
            break;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == PANIC_LOG || name == PANIC_LOG_ROT {
            continue; // 패닉 로그는 보존
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

// OS 파일 탐색기로 디렉토리 열기 (open.rs의 탐색기 열기와 동일한 플랫폼별 처리).
#[cfg(windows)]
fn open_dir(dir: &Path) -> Result<(), IpcError> {
    // explorer는 성공해도 비정상 종료코드를 반환할 수 있어 spawn 성공 여부만 본다.
    Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("폴더 열기 실패: {e}")))
}

#[cfg(target_os = "macos")]
fn open_dir(dir: &Path) -> Result<(), IpcError> {
    Command::new("open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("폴더 열기 실패: {e}")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_dir(dir: &Path) -> Result<(), IpcError> {
    Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("폴더 열기 실패: {e}")))
}
