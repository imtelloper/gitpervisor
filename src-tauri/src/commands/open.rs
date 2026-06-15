use std::path::Path;
use std::process::Command;

use serde::Deserialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenTarget {
    Explorer,
    Terminal,
}

/// 프로젝트 폴더를 탐색기/터미널로 연다 (설계 F11 · §5.2).
#[tauri::command]
pub fn open_in(
    state: State<'_, AppState>,
    project_id: String,
    target: OpenTarget,
) -> Result<(), IpcError> {
    let path = project_path(&state, &project_id)?;
    if !path.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "프로젝트 경로를 찾을 수 없습니다",
        ));
    }
    match target {
        OpenTarget::Explorer => open_explorer(&path),
        OpenTarget::Terminal => open_terminal(&path),
    }
}

fn spawn_err(what: &str, e: std::io::Error) -> IpcError {
    IpcError::new(ErrorCode::Io, format!("{what} 열기 실패: {e}"))
}

#[cfg(windows)]
fn open_explorer(path: &Path) -> Result<(), IpcError> {
    // explorer는 성공해도 비정상 종료코드를 반환할 수 있어 spawn 성공 여부만 본다.
    Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("탐색기", e))
}

#[cfg(windows)]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Windows Terminal 우선, 없으면 새 cmd 창으로 폴백.
    if Command::new("wt")
        .arg("-d")
        .arg(path)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    // `start "" cmd` 는 별도 콘솔 창을 띄운다 — 런처 cmd 자체의 깜빡임은 CREATE_NO_WINDOW로 숨긴다.
    Command::new("cmd")
        .args(["/C", "start", "", "cmd"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("터미널", e))
}

#[cfg(target_os = "macos")]
fn open_explorer(path: &Path) -> Result<(), IpcError> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("탐색기", e))
}

#[cfg(target_os = "macos")]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    Command::new("open")
        .args(["-a", "Terminal"])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("터미널", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_explorer(path: &Path) -> Result<(), IpcError> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("탐색기", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    Command::new("x-terminal-emulator")
        .current_dir(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("터미널", e))
}
