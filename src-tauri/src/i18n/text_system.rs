//! 시스템 정보·OS 알림·health(경보 사유·세션·이벤트 로그)·웹뷰 가드·화면 캡쳐·진단 문구 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.
//! 한 플랫폼에서만 부르는 문구는 호출처와 같은 `#[cfg]`를 단다 — `mod i18n`이 비공개라 안 쓰이면 경고가 난다.

use std::fmt::Display;

use super::{lang, Lang};

// ─────────────────────────── 시스템 정보(sysinfo_static.rs) ───────────────────────────

pub fn sysinfo_program_spawn_failed(program: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{program} 실행 실패: {err}"),
        Lang::En => format!("Failed to run {program}: {err}"),
    }
}

pub fn sysinfo_program_timed_out(program: &str, timeout_secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{program} 시간 초과 ({timeout_secs}초)"),
        Lang::En => format!("{program} timed out ({timeout_secs}s)"),
    }
}

pub fn sysinfo_program_output_failed(program: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{program} 출력 수집 실패: {err}"),
        Lang::En => format!("Failed to collect {program} output: {err}"),
    }
}

pub fn sysinfo_program_no_output(program: &str, stderr_head: &str) -> String {
    match lang() {
        Lang::Ko => format!("{program} 출력 없음 ({stderr_head})"),
        Lang::En => format!("{program} produced no output ({stderr_head})"),
    }
}

/// `source`는 "CIM" · "system_profiler" 같은 수집원 이름(번역하지 않는다).
#[cfg(any(windows, target_os = "macos"))]
pub fn sysinfo_json_parse_failed(source: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{source}: JSON 해석 실패 ({err})"),
        Lang::En => format!("{source}: failed to parse JSON ({err})"),
    }
}

pub fn sysinfo_memory_module_slot_fallback() -> &'static str {
    match lang() {
        Lang::Ko => "모듈",
        Lang::En => "Module",
    }
}

#[cfg(target_os = "linux")]
pub fn sysinfo_dmi_unreadable() -> &'static str {
    match lang() {
        Lang::Ko => "DMI: /sys/class/dmi/id를 읽지 못했습니다",
        Lang::En => "DMI: failed to read /sys/class/dmi/id",
    }
}

// ─────────────────────────── 외부 알림(notifications.rs) ───────────────────────────

pub fn unknown_secret_kind() -> &'static str {
    match lang() {
        Lang::Ko => "알 수 없는 시크릿 종류입니다",
        Lang::En => "Unknown secret kind",
    }
}

pub fn keychain_access_failed() -> &'static str {
    match lang() {
        Lang::Ko => "키체인 접근 실패",
        Lang::En => "Keychain access failed",
    }
}

pub fn secret_delete_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("시크릿 삭제 실패: {err}"),
        Lang::En => format!("Failed to delete secret: {err}"),
    }
}

pub fn secret_save_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("시크릿 저장 실패: {err}"),
        Lang::En => format!("Failed to save secret: {err}"),
    }
}

#[cfg(not(windows))]
pub fn notify_os_uses_plugin() -> &'static str {
    match lang() {
        Lang::Ko => "이 플랫폼은 플러그인 알림을 사용합니다",
        Lang::En => "This platform uses plugin notifications",
    }
}

#[cfg(windows)]
pub fn os_toast_show_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("알림 표시 실패: {err}"),
        Lang::En => format!("Failed to show notification: {err}"),
    }
}

pub fn notify_test_title() -> &'static str {
    match lang() {
        Lang::Ko => "gitpervisor 테스트 알림",
        Lang::En => "gitpervisor test notification",
    }
}

pub fn notify_test_body() -> &'static str {
    match lang() {
        Lang::Ko => "외부 알림이 정상적으로 설정되었습니다.",
        Lang::En => "External notifications are set up correctly.",
    }
}

pub fn notify_unknown_channel() -> &'static str {
    match lang() {
        Lang::Ko => "알 수 없는 채널입니다",
        Lang::En => "Unknown channel",
    }
}

pub fn slack_webhook_url_not_set() -> &'static str {
    match lang() {
        Lang::Ko => "Slack 웹훅 URL이 설정되지 않았습니다",
        Lang::En => "Slack webhook URL is not set",
    }
}

pub fn slack_send_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("전송 실패: {err}"),
        Lang::En => format!("Failed to send: {err}"),
    }
}

pub fn slack_response_error(status: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("Slack 응답 오류: {status}"),
        Lang::En => format!("Slack response error: {status}"),
    }
}

pub fn smtp_host_empty() -> &'static str {
    match lang() {
        Lang::Ko => "SMTP 호스트가 비었습니다",
        Lang::En => "SMTP host is empty",
    }
}

pub fn smtp_from_empty() -> &'static str {
    match lang() {
        Lang::Ko => "보내는 주소(from)가 비었습니다",
        Lang::En => "Sender address (from) is empty",
    }
}

pub fn smtp_to_empty() -> &'static str {
    match lang() {
        Lang::Ko => "받는 주소(to)가 비었습니다",
        Lang::En => "Recipient address (to) is empty",
    }
}

pub fn smtp_from_address_invalid(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("from 주소 오류: {err}"),
        Lang::En => format!("Invalid from address: {err}"),
    }
}

pub fn smtp_to_address_invalid(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("to 주소 오류: {err}"),
        Lang::En => format!("Invalid to address: {err}"),
    }
}

pub fn email_build_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("메일 생성 실패: {err}"),
        Lang::En => format!("Failed to build email: {err}"),
    }
}

pub fn smtp_tls_setup_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("SMTP TLS 설정 실패: {err}"),
        Lang::En => format!("Failed to set up SMTP TLS: {err}"),
    }
}

pub fn smtp_starttls_setup_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("SMTP STARTTLS 설정 실패: {err}"),
        Lang::En => format!("Failed to set up SMTP STARTTLS: {err}"),
    }
}

pub fn email_send_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("메일 전송 실패: {err}"),
        Lang::En => format!("Failed to send email: {err}"),
    }
}

// ─────────────────────────── Windows 이벤트 로그(health/winlog.rs) ───────────────────────────

pub fn winlog_exception_abort_fastfail() -> &'static str {
    match lang() {
        Lang::Ko => "abort/fastfail(Rust 할당 실패 포함)",
        Lang::En => "abort/fastfail (incl. Rust allocation failure)",
    }
}

pub fn winlog_exception_access_violation() -> &'static str {
    match lang() {
        Lang::Ko => "접근 위반",
        Lang::En => "Access violation",
    }
}

pub fn winlog_exception_breakpoint() -> &'static str {
    match lang() {
        Lang::Ko => "중단점(Chromium CHECK)",
        Lang::En => "Breakpoint (Chromium CHECK)",
    }
}

pub fn winlog_exception_stack_overflow() -> &'static str {
    match lang() {
        Lang::Ko => "스택 오버플로",
        Lang::En => "Stack overflow",
    }
}

pub fn winlog_webview2_crash_head() -> &'static str {
    match lang() {
        Lang::Ko => "WebView2 프로세스 크래시(1000)",
        Lang::En => "WebView2 process crash (1000)",
    }
}

pub fn winlog_app_crash_head() -> &'static str {
    match lang() {
        Lang::Ko => "앱 크래시(1000)",
        Lang::En => "App crash (1000)",
    }
}

/// `note`·`when`은 앞 공백까지 포함한 꼬리표다(비어 있을 수 있다).
pub fn winlog_app_error_event(head: &str, exe: &str, code: &str, note: &str, when: &str) -> String {
    match lang() {
        Lang::Ko => format!("{head} {exe} 예외 코드 0x{code}{note}{when}"),
        Lang::En => format!("{head} {exe} exception code 0x{code}{note}{when}"),
    }
}

pub fn winlog_wer_event(exe: &str, kind: &str, when: &str) -> String {
    match lang() {
        Lang::Ko => format!("오류 보고(WER 1001) {exe} {kind}{when}"),
        Lang::En => format!("Error report (WER 1001) {exe} {kind}{when}"),
    }
}

pub fn winlog_hang_event(exe: &str, when: &str) -> String {
    match lang() {
        Lang::Ko => format!("응답 없음으로 종료(1002) {exe}{when}"),
        Lang::En => format!("Terminated for not responding (1002) {exe}{when}"),
    }
}

pub fn winlog_unexpected_shutdown_event(when: &str) -> String {
    match lang() {
        Lang::Ko => format!("시스템이 예기치 않게 종료됨(6008){when}"),
        Lang::En => format!("System shut down unexpectedly (6008){when}"),
    }
}

pub fn winlog_bugcheck_zero_note() -> &'static str {
    match lang() {
        Lang::Ko => " (0이면 전원 차단·강제 리셋)",
        Lang::En => " (0 means power loss or hard reset)",
    }
}

pub fn winlog_bugcheck_bluescreen_note() -> &'static str {
    match lang() {
        Lang::Ko => " (블루스크린)",
        Lang::En => " (blue screen)",
    }
}

pub fn winlog_kernel_power_event(bugcheck: &str, note: &str, when: &str) -> String {
    match lang() {
        Lang::Ko => format!("커널 전원 이벤트(41) BugcheckCode={bugcheck}{note}{when}"),
        Lang::En => format!("Kernel power event (41) BugcheckCode={bugcheck}{note}{when}"),
    }
}

pub fn winlog_shutdown_reason(reason: &str) -> String {
    match lang() {
        Lang::Ko => format!(" 사유 {reason}"),
        Lang::En => format!(" reason {reason}"),
    }
}

pub fn winlog_shutdown_request_event(who: &str, reason: &str, when: &str) -> String {
    match lang() {
        Lang::Ko => format!("종료/재부팅 요청(1074) {who}{reason}{when}"),
        Lang::En => format!("Shutdown/restart request (1074) {who}{reason}{when}"),
    }
}

pub fn winlog_commit_exhausted_event(top: &str, when: &str) -> String {
    match lang() {
        Lang::Ko => format!("커밋 한도 고갈(2004): 상위 소비 {top}{when}"),
        Lang::En => format!("Commit limit exhausted (2004): top consumers {top}{when}"),
    }
}

pub fn winlog_no_info() -> &'static str {
    match lang() {
        Lang::Ko => "정보 없음",
        Lang::En => "unavailable",
    }
}

// ─────────────────────────── 지난 세션 판정(health/session.rs) ───────────────────────────

pub fn prev_session_oom_head_windows() -> &'static str {
    match lang() {
        Lang::Ko => "메모리가 부족해 종료된 것으로 보입니다.",
        Lang::En => "The app appears to have closed because memory ran out.",
    }
}

pub fn prev_session_oom_head_os_killed() -> &'static str {
    match lang() {
        Lang::Ko => "메모리 부족으로 OS가 앱을 강제 종료한 것으로 보입니다.",
        Lang::En => "The OS appears to have force-closed the app due to low memory.",
    }
}

pub fn prev_session_bit_scope_procs(count: u32) -> String {
    match lang() {
        Lang::Ko => format!("앱에 딸린 프로세스 {count}개"),
        Lang::En => format!("{count} app processes"),
    }
}

pub fn prev_session_bit_memory_pressure(pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("메모리 압박 {pct:.0}%"),
        Lang::En => format!("memory pressure {pct:.0}%"),
    }
}

pub fn prev_session_bit_free_memory(pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("여유 메모리 {pct:.0}%"),
        Lang::En => format!("free memory {pct:.0}%"),
    }
}

/// `bits`는 ", "로 이미 이은 지표 목록.
pub fn prev_session_oom_with_bits(head: &str, bits: &str) -> String {
    match lang() {
        Lang::Ko => format!("{head} 종료 직전 {bits}."),
        Lang::En => format!("{head} Just before exit: {bits}."),
    }
}

pub fn prev_session_top_group_entry(name: &str, gb: f32, count: u32) -> String {
    match lang() {
        Lang::Ko => format!("{name} {gb:.1}GB({count}개)"),
        Lang::En => format!("{name} {gb:.1}GB ({count} processes)"),
    }
}

pub fn prev_session_top_procs(listed: &str) -> String {
    match lang() {
        Lang::Ko => format!("종료 직전 가장 큰 프로세스: {listed}"),
        Lang::En => format!("Largest processes before exit: {listed}"),
    }
}

pub fn prev_session_alloc_failed(bytes: u64) -> String {
    match lang() {
        Lang::Ko => format!(
            "메모리 할당 실패로 앱이 종료됐습니다(요청 {bytes}바이트). \
             더 이상 메모리를 확보할 수 없어 OS가 프로세스를 중단시켰습니다."
        ),
        Lang::En => format!(
            "The app closed because a memory allocation failed ({bytes} bytes requested). \
             The OS stopped the process because no more memory could be obtained."
        ),
    }
}

pub fn prev_session_panic() -> &'static str {
    match lang() {
        Lang::Ko => "앱 내부 오류(패닉)로 종료된 것으로 보입니다. 진단 로그를 확인해 주세요.",
        Lang::En => "The app appears to have closed due to an internal error (panic). Check the diagnostic log.",
    }
}

pub fn prev_session_crash(event: &str) -> String {
    match lang() {
        Lang::Ko => format!("앱이 크래시로 종료됐습니다. {event}"),
        Lang::En => format!("The app crashed. {event}"),
    }
}

pub fn prev_session_power(event: &str) -> String {
    match lang() {
        Lang::Ko => format!(
            "시스템이 예기치 않게 종료·재부팅됐습니다 — 앱 문제가 아닐 수 있습니다. {event}"
        ),
        Lang::En => format!(
            "The system shut down or restarted unexpectedly — this may not be an app problem. {event}"
        ),
    }
}

pub fn prev_session_windows_restart(event: &str) -> String {
    match lang() {
        Lang::Ko => format!("Windows 종료·재시작 요청으로 앱이 함께 종료됐습니다. {event}"),
        Lang::En => format!("The app closed along with a Windows shutdown/restart request. {event}"),
    }
}

pub fn prev_session_unknown() -> &'static str {
    match lang() {
        Lang::Ko => "원인을 특정하지 못했습니다(전원 차단·세션 종료 등일 수 있습니다).",
        Lang::En => "Could not determine the cause (possibly power loss or sign-out).",
    }
}

// ─────────────────────────── 메모리 경보 사유(health/mod.rs) ───────────────────────────

/// Windows의 `swap_used_pct` 자리 — 커밋 차지.
pub fn health_commit_usage_label() -> &'static str {
    match lang() {
        Lang::Ko => "커밋 사용",
        Lang::En => "Commit usage",
    }
}

pub fn health_swap_usage_label() -> &'static str {
    match lang() {
        Lang::Ko => "스왑 사용",
        Lang::En => "Swap usage",
    }
}

pub fn health_reason_memory_pressure(pct: f32, kill_threshold: f32) -> String {
    match lang() {
        Lang::Ko => format!("메모리 압박 {pct:.0}% (OS 종료 기준 {kill_threshold:.0}%)"),
        Lang::En => format!("Memory pressure {pct:.0}% (OS kill threshold {kill_threshold:.0}%)"),
    }
}

pub fn health_reason_memory_stall(pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("메모리 지연 {pct:.0}%"),
        Lang::En => format!("Memory stall {pct:.0}%"),
    }
}

pub fn health_reason_app_memory_split(total_gb: f32, system_pct: f32, core_gb: f32, terminal_gb: f32) -> String {
    match lang() {
        Lang::Ko => format!(
            "앱 메모리 {total_gb:.1}GB (시스템의 {system_pct:.0}%; 앱 자체 {core_gb:.1}GB, 터미널 프로그램 {terminal_gb:.1}GB)"
        ),
        Lang::En => format!(
            "App memory {total_gb:.1}GB ({system_pct:.0}% of system; app itself {core_gb:.1}GB, terminal programs {terminal_gb:.1}GB)"
        ),
    }
}

pub fn health_reason_app_memory(total_gb: f32, system_pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("앱 메모리 {total_gb:.1}GB (시스템의 {system_pct:.0}%)"),
        Lang::En => format!("App memory {total_gb:.1}GB ({system_pct:.0}% of system)"),
    }
}

pub fn health_reason_app_processes(count: u32, warn_at: u32) -> String {
    match lang() {
        Lang::Ko => format!("앱에 딸린 프로세스 {count}개 (주의 기준 {warn_at}개)"),
        Lang::En => format!("App processes: {count} (warning at {warn_at})"),
    }
}

pub fn health_reason_system_free_memory(pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("시스템 여유 메모리 {pct:.0}%"),
        Lang::En => format!("System free memory {pct:.0}%"),
    }
}

/// `label`은 `health_commit_usage_label`/`health_swap_usage_label`.
pub fn health_reason_swap(label: &str, used_pct: f32, free_pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("{label} {used_pct:.0}% (여유 메모리 {free_pct:.0}%)"),
        Lang::En => format!("{label} {used_pct:.0}% (free memory {free_pct:.0}%)"),
    }
}

pub fn health_reason_oom_victim(share_pct: f32) -> String {
    match lang() {
        Lang::Ko => format!("메모리 회수 부담의 {share_pct:.0}%가 이 앱 — 종료 대상 1순위입니다"),
        Lang::En => format!("This app accounts for {share_pct:.0}% of memory reclaim pressure — first in line to be killed"),
    }
}

// ─────────────────────────── 리소스 모니터(monitor.rs) ───────────────────────────

pub fn kill_processes_empty() -> &'static str {
    match lang() {
        Lang::Ko => "종료할 프로세스가 없습니다",
        Lang::En => "No processes to end",
    }
}

// ─────────────────────────── 진단(commands/diagnostics.rs) ───────────────────────────

pub fn log_dir_resolve_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("로그 폴더 경로 확인 실패: {err}"),
        Lang::En => format!("Failed to resolve log folder path: {err}"),
    }
}

pub fn crash_log_delete_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("크래시 로그 삭제 실패: {err}"),
        Lang::En => format!("Failed to delete crash log: {err}"),
    }
}

pub fn log_folder_open_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("폴더 열기 실패: {err}"),
        Lang::En => format!("Failed to open folder: {err}"),
    }
}

// ─────────────────────────── 화면 캡쳐(commands/capture.rs) ───────────────────────────

#[cfg(windows)]
pub fn capture_cursor_pos_failed() -> &'static str {
    match lang() {
        Lang::Ko => "커서 위치를 읽지 못했습니다",
        Lang::En => "Failed to read cursor position",
    }
}

#[cfg(windows)]
pub fn capture_monitor_info_failed() -> &'static str {
    match lang() {
        Lang::Ko => "모니터 정보를 읽지 못했습니다",
        Lang::En => "Failed to read monitor info",
    }
}

#[cfg(windows)]
pub fn capture_invalid_size() -> &'static str {
    match lang() {
        Lang::Ko => "캡쳐 크기가 올바르지 않습니다",
        Lang::En => "Invalid capture size",
    }
}

#[cfg(windows)]
pub fn capture_screen_dc_failed() -> &'static str {
    match lang() {
        Lang::Ko => "화면 DC를 얻지 못했습니다",
        Lang::En => "Failed to get screen DC",
    }
}

#[cfg(windows)]
pub fn capture_screen_read_failed() -> &'static str {
    match lang() {
        Lang::Ko => "화면을 읽지 못했습니다",
        Lang::En => "Failed to read the screen",
    }
}

#[cfg(not(windows))]
pub fn capture_windows_only() -> &'static str {
    match lang() {
        Lang::Ko => "화면 캡쳐는 아직 Windows에서만 지원합니다",
        Lang::En => "Screen capture is only supported on Windows for now",
    }
}

pub fn capture_preview_size_zero() -> &'static str {
    match lang() {
        Lang::Ko => "프리뷰 크기가 0입니다",
        Lang::En => "Preview size is 0",
    }
}

pub fn capture_preview_encode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("프리뷰 인코딩 실패: {err}"),
        Lang::En => format!("Failed to encode preview: {err}"),
    }
}

pub fn capture_selection_out_of_bounds() -> &'static str {
    match lang() {
        Lang::Ko => "선택 영역이 화면 범위를 벗어났습니다",
        Lang::En => "Selection is outside the screen",
    }
}

pub fn capture_session_expired() -> &'static str {
    match lang() {
        Lang::Ko => "캡쳐 세션이 만료되었습니다",
        Lang::En => "Capture session expired",
    }
}

pub fn capture_main_thread_schedule_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("메인 스레드 예약 실패: {err}"),
        Lang::En => format!("Failed to schedule on main thread: {err}"),
    }
}

pub fn capture_clipboard_busy() -> &'static str {
    match lang() {
        Lang::Ko => "다른 프로그램이 클립보드를 쓰고 있습니다 — 잠시 후 다시 시도하세요",
        Lang::En => "Another app is using the clipboard — try again in a moment",
    }
}
