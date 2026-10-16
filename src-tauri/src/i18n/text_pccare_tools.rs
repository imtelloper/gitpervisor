//! 리소스 모니터 PC 관리(tools) 문구 — 문구 하나 = 함수 하나(DOCS/i18n-design.md §4.4, DOCS/pc-care-design.md).
//! 파일 잠금 찾기(§4.9)·정리 가능 공간(§4.10). 한 플랫폼에서만 부르는 문구는 호출처와 같은 `#[cfg]`를 단다.

use std::fmt::Display;

use super::{lang, Lang};

pub fn pccare_tools_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("작업 실행 실패: {err}"),
        Lang::En => format!("Task failed: {err}"),
    }
}

// ─────────────────────────── 파일 잠금 찾기(file_locks.rs) ───────────────────────────

pub fn file_locks_path_missing(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("경로를 찾을 수 없습니다: {path} ({err})"),
        Lang::En => format!("Path not found: {path} ({err})"),
    }
}

#[cfg(any(windows, target_os = "linux", target_os = "macos"))]
pub fn file_locks_reason_open_file() -> &'static str {
    match lang() {
        Lang::Ko => "파일을 열어 두고 있음",
        Lang::En => "Has the file open",
    }
}

#[cfg(windows)]
pub fn file_locks_reason_service(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("서비스 {name}이(가) 파일을 사용 중"),
        Lang::En => format!("Service {name} is using the file"),
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub fn file_locks_reason_exe_inside() -> &'static str {
    match lang() {
        Lang::Ko => "실행 파일이 이 폴더 안에 있음",
        Lang::En => "Its executable is inside this folder",
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub fn file_locks_reason_cwd_inside() -> &'static str {
    match lang() {
        Lang::Ko => "작업 폴더가 이 폴더 안에 있음",
        Lang::En => "Its working folder is inside this folder",
    }
}

#[cfg(windows)]
pub fn file_locks_rm_failed(step: &str, code: u32) -> String {
    match lang() {
        Lang::Ko => format!("Restart Manager {step} 실패 (코드 {code})"),
        Lang::En => format!("Restart Manager {step} failed (code {code})"),
    }
}

#[cfg(target_os = "linux")]
pub fn file_locks_unreadable_procs(count: usize) -> String {
    match lang() {
        Lang::Ko => format!("권한이 없어 프로세스 {count}개는 확인하지 못했습니다(다른 사용자·시스템 프로세스)"),
        Lang::En => format!("Could not inspect {count} processes without permission (other users or system)"),
    }
}

#[cfg(target_os = "macos")]
pub fn file_locks_lsof_missing() -> &'static str {
    match lang() {
        Lang::Ko => "lsof를 찾을 수 없습니다(/usr/sbin/lsof)",
        Lang::En => "lsof was not found (/usr/sbin/lsof)",
    }
}

#[cfg(target_os = "macos")]
pub fn file_locks_lsof_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("lsof 실행 실패: {err}"),
        Lang::En => format!("lsof failed: {err}"),
    }
}

#[cfg(target_os = "macos")]
pub fn file_locks_lsof_timed_out(secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("lsof 시간 초과 ({secs}초) — 폴더가 너무 크면 하위 폴더를 골라 주세요"),
        Lang::En => format!("lsof timed out ({secs}s) — pick a smaller subfolder"),
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn file_locks_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "이 OS에서는 파일 잠금 찾기를 지원하지 않습니다",
        Lang::En => "Finding file locks is not supported on this OS",
    }
}

// ─────────────────────────── 정리 가능 공간(cleanup.rs) ───────────────────────────

pub fn cleanup_label_temp() -> &'static str {
    match lang() {
        Lang::Ko => "사용자 임시 파일",
        Lang::En => "User temporary files",
    }
}

pub fn cleanup_label_recycle_bin() -> &'static str {
    match lang() {
        Lang::Ko => "휴지통",
        Lang::En => "Recycle bin",
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub fn cleanup_label_crash_dumps() -> &'static str {
    match lang() {
        Lang::Ko => "크래시 덤프",
        Lang::En => "Crash dumps",
    }
}

#[cfg(windows)]
pub fn cleanup_label_wer_archive() -> &'static str {
    match lang() {
        Lang::Ko => "Windows 오류 보고(보관됨)",
        Lang::En => "Windows Error Reporting (archived)",
    }
}

#[cfg(windows)]
pub fn cleanup_label_wer_queue() -> &'static str {
    match lang() {
        Lang::Ko => "Windows 오류 보고(대기 중)",
        Lang::En => "Windows Error Reporting (queued)",
    }
}

#[cfg(any(windows, target_os = "linux"))]
pub fn cleanup_label_thumbnail() -> &'static str {
    match lang() {
        Lang::Ko => "썸네일 캐시",
        Lang::En => "Thumbnail cache",
    }
}

/// `tool`은 npm·yarn·pnpm·pip·Cargo·Gradle·Go 같은 도구 이름(번역하지 않는다).
pub fn cleanup_label_dev_cache(tool: &str) -> String {
    match lang() {
        Lang::Ko => format!("{tool} 캐시"),
        Lang::En => format!("{tool} cache"),
    }
}

pub fn cleanup_note_recent_kept(days: u64) -> String {
    match lang() {
        Lang::Ko => format!("최근 {days}일 안에 바뀐 파일은 건드리지 않습니다(실행 중인 설치 프로그램 보호)"),
        Lang::En => format!("Files changed in the last {days} days are left alone (protects running installers)"),
    }
}

pub fn cleanup_note_lower_bound(secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{secs}초 안에 다 세지 못했습니다 — 실제 크기는 이보다 큽니다"),
        Lang::En => format!("Could not finish counting in {secs}s — the real size is larger"),
    }
}

pub fn cleanup_note_unreadable(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("읽을 수 없음: {err}"),
        Lang::En => format!("Cannot read: {err}"),
    }
}

pub fn cleanup_unknown_id(id: &str) -> String {
    match lang() {
        Lang::Ko => format!("알 수 없는 정리 항목입니다: {id}"),
        Lang::En => format!("Unknown cleanup item: {id}"),
    }
}

#[cfg(windows)]
pub fn cleanup_recycle_query_failed(hr: i32) -> String {
    match lang() {
        Lang::Ko => format!("휴지통 크기를 읽지 못했습니다 (HRESULT 0x{hr:08X})"),
        Lang::En => format!("Could not read the recycle bin size (HRESULT 0x{hr:08X})"),
    }
}

#[cfg(windows)]
pub fn cleanup_recycle_empty_failed(hr: i32) -> String {
    match lang() {
        Lang::Ko => format!("휴지통을 비우지 못했습니다 (HRESULT 0x{hr:08X})"),
        Lang::En => format!("Could not empty the recycle bin (HRESULT 0x{hr:08X})"),
    }
}
