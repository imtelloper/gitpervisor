//! 리소스 모니터 PC 관리(programs) 문구 — 문구 하나 = 함수 하나(DOCS/i18n-design.md §4.4, DOCS/pc-care-design.md).

#[cfg(not(target_os = "linux"))]
use std::fmt::Display;

use super::{lang, Lang};

pub fn app_bad_id(id: &str) -> String {
    match lang() {
        Lang::Ko => format!("알 수 없는 프로그램 항목입니다: {id}"),
        Lang::En => format!("Unknown program entry: {id}"),
    }
}

#[cfg(windows)]
pub fn app_entry_missing(id: &str) -> String {
    match lang() {
        Lang::Ko => format!("프로그램 항목이 더 이상 없습니다 (이미 제거되었을 수 있습니다): {id}"),
        Lang::En => format!("The program entry no longer exists (it may already be removed): {id}"),
    }
}

#[cfg(windows)]
pub fn app_registry_read_failed(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("레지스트리를 읽지 못했습니다 ({path}): {err}"),
        Lang::En => format!("Failed to read the registry ({path}): {err}"),
    }
}

#[cfg(windows)]
pub fn app_no_uninstall_command(id: &str) -> String {
    match lang() {
        Lang::Ko => format!("이 프로그램에는 제거 명령이 등록되어 있지 않습니다: {id}"),
        Lang::En => format!("This program has no registered uninstall command: {id}"),
    }
}

#[cfg(windows)]
pub fn app_uninstaller_missing(path: &str) -> String {
    match lang() {
        Lang::Ko => format!("제거 프로그램 파일이 없습니다: {path}"),
        Lang::En => format!("The uninstaller file does not exist: {path}"),
    }
}

#[cfg(windows)]
pub fn app_uninstall_parse_failed(command: &str) -> String {
    match lang() {
        Lang::Ko => format!("제거 명령을 해석하지 못했습니다: {command}"),
        Lang::En => format!("Could not parse the uninstall command: {command}"),
    }
}

#[cfg(windows)]
pub fn app_uninstall_spawn_failed(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("제거 프로그램을 실행하지 못했습니다 ({path}): {err}"),
        Lang::En => format!("Failed to start the uninstaller ({path}): {err}"),
    }
}

#[cfg(windows)]
pub fn app_uninstall_cancelled() -> &'static str {
    match lang() {
        Lang::Ko => "제거 프로그램의 관리자 권한 요청이 취소되었습니다",
        Lang::En => "The uninstaller's administrator permission request was cancelled",
    }
}

#[cfg(target_os = "linux")]
pub fn app_uninstall_use_package_manager() -> &'static str {
    match lang() {
        Lang::Ko => "Linux 패키지는 앱에서 제거하지 않습니다 — 복사한 명령을 터미널에서 실행하세요",
        Lang::En => "Linux packages are not removed by the app — run the copied command in a terminal",
    }
}

#[cfg(target_os = "linux")]
pub fn app_no_package_manager() -> &'static str {
    match lang() {
        Lang::Ko => "설치된 프로그램을 읽을 도구가 없습니다 (dpkg-query·rpm·flatpak 중 하나 필요)",
        Lang::En => "No tool to list installed programs (dpkg-query, rpm or flatpak is required)",
    }
}

#[cfg(target_os = "linux")]
pub fn app_list_tool_failed(tool: &str, err: &str) -> String {
    match lang() {
        Lang::Ko => format!("{tool}로 설치된 프로그램을 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to list installed programs with {tool}: {err}"),
    }
}

#[cfg(target_os = "macos")]
pub fn app_read_dir_failed(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("폴더를 읽지 못했습니다 ({path}): {err}"),
        Lang::En => format!("Failed to read folder ({path}): {err}"),
    }
}

#[cfg(target_os = "macos")]
pub fn app_trash_failed(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("앱을 휴지통으로 옮기지 못했습니다 ({path}): {err}"),
        Lang::En => format!("Failed to move the app to the Trash ({path}): {err}"),
    }
}

pub fn activex_bad_clsid(clsid: &str) -> String {
    match lang() {
        Lang::Ko => format!("CLSID 형식이 아닙니다: {clsid}"),
        Lang::En => format!("Not a valid CLSID: {clsid}"),
    }
}

#[cfg(windows)]
pub fn activex_not_found(clsid: &str) -> String {
    match lang() {
        Lang::Ko => format!("ActiveX 항목이 더 이상 없습니다: {clsid}"),
        Lang::En => format!("The ActiveX entry no longer exists: {clsid}"),
    }
}

#[cfg(not(windows))]
pub fn activex_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "ActiveX는 Windows에만 있습니다",
        Lang::En => "ActiveX exists only on Windows",
    }
}
