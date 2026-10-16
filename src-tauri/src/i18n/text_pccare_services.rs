//! 리소스 모니터 PC 관리(services) 문구 — 문구 하나 = 함수 하나(DOCS/i18n-design.md §4.4, DOCS/pc-care-design.md).

#[cfg(any(windows, target_os = "linux"))]
use std::fmt::Display;

use super::{lang, Lang};

pub fn service_bad_name(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("서비스 이름에 쓸 수 없는 문자가 있습니다: {name}"),
        Lang::En => format!("Service name contains characters that are not allowed: {name}"),
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub fn service_access_denied(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스를 바꾸려면 관리자 권한이 필요합니다"),
        Lang::En => format!("Administrator permission is required to change the {name} service"),
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub fn service_op_failed(name: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스 작업 실패: {err}"),
        Lang::En => format!("Service operation on {name} failed: {err}"),
    }
}

#[cfg(windows)]
pub fn services_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("서비스 작업 스레드 오류: {err}"),
        Lang::En => format!("Service worker thread failed: {err}"),
    }
}

#[cfg(windows)]
pub fn services_scm_open_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("서비스 관리자를 열지 못했습니다: {err}"),
        Lang::En => format!("Failed to open the Service Control Manager: {err}"),
    }
}

#[cfg(windows)]
pub fn services_enum_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("서비스 목록을 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to list services: {err}"),
    }
}

#[cfg(windows)]
pub fn service_not_found(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스가 없습니다"),
        Lang::En => format!("Service {name} does not exist"),
    }
}

#[cfg(windows)]
pub fn service_not_win32(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name}은(는) 일반 서비스가 아니라(드라이버 등) 여기서 바꿀 수 없습니다"),
        Lang::En => format!("{name} is not a regular service (e.g. a driver) and cannot be changed here"),
    }
}

#[cfg(windows)]
pub fn service_dependents_running(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스에 의존하는 다른 서비스가 실행 중이라 중지할 수 없습니다"),
        Lang::En => format!("Cannot stop {name}: other running services depend on it"),
    }
}

#[cfg(windows)]
pub fn service_is_disabled(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스가 사용 안 함 상태입니다 — 먼저 시작 유형을 바꾸세요"),
        Lang::En => format!("Service {name} is disabled — change its startup type first"),
    }
}

#[cfg(windows)]
pub fn service_stop_timed_out(name: &str, secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스가 {secs}초 안에 중지되지 않았습니다"),
        Lang::En => format!("Service {name} did not stop within {secs}s"),
    }
}

#[cfg(windows)]
pub fn service_stopped_after_start(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스가 시작 직후 다시 중지되었습니다 (이벤트 뷰어에서 원인을 확인하세요)"),
        Lang::En => format!("Service {name} stopped right after starting (check Event Viewer for the cause)"),
    }
}

#[cfg(target_os = "linux")]
pub fn services_systemctl_missing() -> &'static str {
    match lang() {
        Lang::Ko => "systemctl이 없어 서비스를 볼 수 없습니다 (systemd가 아닌 시스템)",
        Lang::En => "systemctl is not available, so services cannot be listed (not a systemd system)",
    }
}

#[cfg(target_os = "linux")]
pub fn services_systemctl_bad_json(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("systemctl JSON 출력을 해석하지 못했습니다 (systemd 246 이상 필요): {err}"),
        Lang::En => format!("Failed to parse systemctl JSON output (systemd 246+ required): {err}"),
    }
}

#[cfg(target_os = "linux")]
pub fn service_op_timed_out(name: &str, secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{name} 서비스 작업이 {secs}초 안에 끝나지 않았습니다"),
        Lang::En => format!("Service operation on {name} did not finish within {secs}s"),
    }
}

#[cfg(target_os = "macos")]
pub fn services_control_unsupported_macos() -> &'static str {
    match lang() {
        Lang::Ko => "macOS에서는 목록만 볼 수 있습니다 — 시작·중지는 지원하지 않습니다",
        Lang::En => "On macOS services can only be listed — start/stop is not supported",
    }
}
