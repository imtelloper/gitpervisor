//! 리소스 모니터 PC 관리 공통(승격) 문구 — 문구 하나 = 함수 하나(DOCS/i18n-design.md §4.4, DOCS/pc-care-design.md §3).
//! 기능별 문구는 text_pccare_<탭>.rs 에 둔다.

use std::fmt::Display;

use super::{lang, Lang};

pub fn elevate_bad_arg(arg: &str) -> String {
    match lang() {
        Lang::Ko => format!("관리자 권한 실행 인자에 쓸 수 없는 문자가 있습니다: {arg}"),
        Lang::En => format!("Argument contains characters not allowed for an elevated command: {arg}"),
    }
}

pub fn elevate_cancelled() -> &'static str {
    match lang() {
        Lang::Ko => "관리자 권한 요청이 취소되었습니다",
        Lang::En => "The administrator permission request was cancelled",
    }
}

pub fn elevate_spawn_failed(program: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{program}을(를) 관리자 권한으로 실행하지 못했습니다: {err}"),
        Lang::En => format!("Failed to run {program} as administrator: {err}"),
    }
}

pub fn elevate_exit_code(program: &str, code: i64) -> String {
    match lang() {
        Lang::Ko => format!("{program}이(가) 실패했습니다 (종료 코드 {code})"),
        Lang::En => format!("{program} failed (exit code {code})"),
    }
}

pub fn elevate_timed_out(program: &str, secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{program}이(가) {secs}초 안에 끝나지 않았습니다"),
        Lang::En => format!("{program} did not finish within {secs}s"),
    }
}

#[cfg(target_os = "linux")]
pub fn elevate_pkexec_missing() -> &'static str {
    match lang() {
        Lang::Ko => "pkexec가 없어 관리자 권한으로 실행할 수 없습니다 (polkit 설치 필요)",
        Lang::En => "pkexec is not available, so the command cannot run as administrator (install polkit)",
    }
}
