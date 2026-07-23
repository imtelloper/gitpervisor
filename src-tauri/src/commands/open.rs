use std::path::Path;
use std::process::Command;

use serde::Deserialize;
use tauri::State;

use super::projects::project_path;
use super::tree::resolve_in_repo;
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

/// 임의 파일을 탐색기에서 "폴더 열고 그 파일 선택"으로 연다 (리소스 모니터 → 파일 위치 열기).
/// 경로는 우리 프로세스 스냅샷(exePath)에서 오며 임의 사용자 입력이 아니다.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), IpcError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(IpcError::new(ErrorCode::NotFound, "경로를 찾을 수 없습니다"));
    }
    reveal(p)
}

#[cfg(windows)]
fn reveal(path: &Path) -> Result<(), IpcError> {
    // explorer /select,<path> — 폴더를 열고 그 파일을 선택 표시한다.
    Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("탐색기", e))
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> Result<(), IpcError> {
    Command::new("open")
        .args(["-R"])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("탐색기", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal(path: &Path) -> Result<(), IpcError> {
    // 파일 선택 표준이 없어 부모 폴더를 연다.
    let dir = path.parent().unwrap_or(path);
    Command::new("xdg-open")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("탐색기", e))
}

/// 파일트리에서 실행 파일을 더블클릭 → OS 기본 실행기로 띄운다(탐색기 더블클릭과 동일).
/// 경로는 resolve_in_repo로 레포 안임을 보장한다(프론트가 실행 가능 확장자만 호출하지만 방어적).
/// 프론트는 호출 전에 확인 다이얼로그를 띄운다 — 임의 실행 파일 구동의 안전장치.
#[tauri::command]
pub fn run_executable(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    // 최종 경로가 심볼릭/정션이면 레포 밖을 가리킬 수 있어 거부(다른 쓰기 커맨드와 동일 가드).
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err(IpcError::new(
                ErrorCode::Io,
                "심볼릭 링크는 실행할 수 없습니다",
            ));
        }
    }
    if !target.is_file() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "실행 파일을 찾을 수 없습니다",
        ));
    }
    run_file(&target)
}

#[cfg(windows)]
fn run_file(target: &Path) -> Result<(), IpcError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // OsStr → UTF-16 널종단 (Win32 와이드 문자열).
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    let file = wide(target.as_os_str());
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let dir = target.parent().map(|p| wide(p.as_os_str()));
    let dir_ptr = dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr());

    // ShellExecuteW 는 경로를 cmd 셸 파싱 없이 그대로 ShellExecute 로 넘긴다(탐색기 더블클릭과 동일).
    // → 파일명의 &,^,%,(),! 같은 cmd 메타문자가 명령으로 해석되는 인젝션(BatBadBut류)을 근본 차단.
    let h = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            dir_ptr,
            SW_SHOWNORMAL,
        )
    };
    // 반환 HINSTANCE 값이 32 이하이면 실패다(WinAPI 규약).
    if (h as isize) <= 32 {
        return Err(IpcError::new(
            ErrorCode::Io,
            format!("실행 실패 (코드 {})", h as isize),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_file(target: &Path) -> Result<(), IpcError> {
    // open 은 .app 번들·확장자 핸들러로 실행한다.
    Command::new("open")
        .arg(target)
        .spawn()
        .map(|_| ())
        .map_err(|e| spawn_err("실행", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn run_file(target: &Path) -> Result<(), IpcError> {
    let dir = target.parent().unwrap_or(target);
    // 실행권한 있는 바이너리/스크립트는 직접 spawn, 실패하면 기본 핸들러(xdg-open)로 폴백.
    match Command::new(target).current_dir(dir).spawn() {
        Ok(_) => Ok(()),
        Err(_) => Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map(|_| ())
            .map_err(|e| spawn_err("실행", e)),
    }
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
