//! 리소스 모니터 PC 관리(startup) 문구 — 문구 하나 = 함수 하나(DOCS/i18n-design.md §4.4, DOCS/pc-care-design.md).
//! 시작프로그램(§4.4)과 예약 작업(§4.5) 둘 다 여기 둔다 — 한 탭이다.

use std::fmt::Display;

use super::{lang, Lang};

pub fn startup_bad_id(id: &str) -> String {
    match lang() {
        Lang::Ko => format!("알 수 없는 시작프로그램 항목입니다: {id}"),
        Lang::En => format!("Unknown startup item: {id}"),
    }
}

#[cfg(windows)]
pub fn startup_item_missing(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("시작프로그램 항목이 더 이상 없습니다: {name} (목록을 새로 고치세요)"),
        Lang::En => format!("The startup item no longer exists: {name} (refresh the list)"),
    }
}

#[cfg(windows)]
pub fn startup_list_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("시작프로그램 목록을 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to read startup items: {err}"),
    }
}

pub fn startup_read_failed(location: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{location}을(를) 읽지 못했습니다: {err}"),
        Lang::En => format!("Could not read {location}: {err}"),
    }
}

pub fn startup_write_failed(target: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{target}에 쓰지 못했습니다: {err}"),
        Lang::En => format!("Failed to write {target}: {err}"),
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub fn startup_needs_admin() -> &'static str {
    match lang() {
        Lang::Ko => "관리자 권한이 필요합니다",
        Lang::En => "Administrator permission is required",
    }
}

#[cfg(windows)]
pub fn tasks_list_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("작업 스케줄러에서 목록을 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to read the Task Scheduler list: {err}"),
    }
}

#[cfg(windows)]
pub fn tasks_skipped(count: u32) -> String {
    match lang() {
        Lang::Ko => format!("권한이 없거나 열 수 없는 폴더·작업 {count}개는 건너뛰었습니다"),
        Lang::En => format!("Skipped {count} folders or tasks that could not be opened"),
    }
}

#[cfg(windows)]
pub fn tasks_bad_path(path: &str) -> String {
    match lang() {
        Lang::Ko => format!("예약 작업을 찾을 수 없습니다: {path}"),
        Lang::En => format!("Scheduled task not found: {path}"),
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub fn tasks_set_failed(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("예약 작업 상태를 바꾸지 못했습니다: {path} ({err})"),
        Lang::En => format!("Failed to change the scheduled task: {path} ({err})"),
    }
}

#[cfg(unix)]
pub fn tasks_not_toggleable() -> &'static str {
    match lang() {
        Lang::Ko => "이 항목은 여기서 켜고 끌 수 없습니다",
        Lang::En => "This item cannot be turned on or off here",
    }
}

#[cfg(unix)]
pub fn tasks_timed_out(program: &str, secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{program}이(가) {secs}초 안에 끝나지 않았습니다"),
        Lang::En => format!("{program} did not finish within {secs}s"),
    }
}
