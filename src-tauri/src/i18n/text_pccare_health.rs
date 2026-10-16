//! 리소스 모니터 PC 관리(health) 문구 — 문구 하나 = 함수 하나(DOCS/i18n-design.md §4.4, DOCS/pc-care-design.md).

#[cfg(windows)]
use std::fmt::Display;

use super::{lang, Lang};

// ─────────────────────────── 디스크 건강(pc_care/disk_health.rs) ───────────────────────────

#[cfg(windows)]
pub fn disk_health_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("디스크 건강 정보 수집 작업이 실패했습니다: {err}"),
        Lang::En => format!("The disk health collection task failed: {err}"),
    }
}

#[cfg(windows)]
pub fn disk_open_failed(path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{path}를 열지 못했습니다: {err}"),
        Lang::En => format!("Could not open {path}: {err}"),
    }
}

#[cfg(windows)]
pub fn disk_ata_smart_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "Windows에서는 아직 SATA 디스크의 S.M.A.R.T. 값을 읽지 않습니다 (NVMe만 지원)",
        Lang::En => "S.M.A.R.T. data for SATA disks is not read on Windows yet (NVMe only)",
    }
}

#[cfg(windows)]
pub fn disk_health_not_exposed(os_error: u32) -> String {
    match lang() {
        Lang::Ko => format!("이 연결 방식(USB 등)은 건강 정보를 내주지 않습니다 (오류 {os_error})"),
        Lang::En => format!("This connection (USB etc.) does not expose health data (error {os_error})"),
    }
}

#[cfg(not(windows))]
pub fn smartctl_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "smartctl이 없어 디스크 건강 정보를 읽을 수 없습니다 (smartmontools 설치 필요)",
        Lang::En => "smartctl was not found, so disk health cannot be read (install smartmontools)",
    }
}

#[cfg(not(windows))]
pub fn smartctl_bad_json(err: impl std::fmt::Display) -> String {
    match lang() {
        Lang::Ko => format!("smartctl 출력을 해석하지 못했습니다: {err}"),
        Lang::En => format!("Could not parse smartctl output: {err}"),
    }
}

// ─────────────────────────── GPU 온도(pc_care/gpu_temp.rs) ───────────────────────────

#[cfg(windows)]
pub fn gpu_temp_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("GPU 온도 수집 작업이 실패했습니다: {err}"),
        Lang::En => format!("The GPU temperature task failed: {err}"),
    }
}

#[cfg(windows)]
pub fn gpu_enum_failed(status: i32) -> String {
    match lang() {
        Lang::Ko => format!("그래픽 어댑터를 열거하지 못했습니다 (NTSTATUS 0x{status:08X})"),
        Lang::En => format!("Could not enumerate graphics adapters (NTSTATUS 0x{status:08X})"),
    }
}

#[cfg(target_os = "linux")]
pub fn gpu_temp_none_found() -> &'static str {
    match lang() {
        Lang::Ko => "온도를 내주는 GPU 드라이버(hwmon·nvidia-smi)를 찾지 못했습니다",
        Lang::En => "No GPU driver exposing temperature (hwmon or nvidia-smi) was found",
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn gpu_temp_unsupported_os() -> &'static str {
    match lang() {
        Lang::Ko => "이 운영체제에서는 GPU 온도를 읽을 수 없습니다",
        Lang::En => "GPU temperature is not available on this operating system",
    }
}

// ─────────────────────────── 비정상 종료 이력(pc_care/crash_history.rs) ───────────────────────────

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn crash_source_unreadable(source: &str, err: impl std::fmt::Display) -> String {
    match lang() {
        Lang::Ko => format!("{source}을(를) 읽지 못해 이력이 빠졌을 수 있습니다: {err}"),
        Lang::En => format!("Could not read {source}, so some history may be missing: {err}"),
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn crash_history_unsupported_os() -> &'static str {
    match lang() {
        Lang::Ko => "이 운영체제에서는 비정상 종료 이력을 읽을 수 없습니다",
        Lang::En => "Crash history is not available on this operating system",
    }
}

// ─────────────────────────── CPU 온도(pc_care/cpu_temp.rs) ───────────────────────────

#[cfg(windows)]
pub fn cpu_temp_needs_hwinfo() -> &'static str {
    match lang() {
        Lang::Ko => "Windows는 관리자 드라이버 없이 CPU 온도를 알려 주지 않습니다. HWiNFO를 '공유 메모리 지원'을 켠 채로 실행해 두면 여기 표시됩니다",
        Lang::En => "Windows does not expose CPU temperature without an administrator driver. Run HWiNFO with 'Shared Memory Support' enabled to show it here",
    }
}

#[cfg(windows)]
pub fn cpu_temp_hwinfo_no_cpu() -> &'static str {
    match lang() {
        Lang::Ko => "HWiNFO 센서 목록에 CPU 온도가 없습니다",
        Lang::En => "HWiNFO does not report a CPU temperature sensor",
    }
}

#[cfg(target_os = "linux")]
pub fn cpu_temp_linux_none() -> &'static str {
    match lang() {
        Lang::Ko => "CPU 온도 센서(coretemp·k10temp)를 찾지 못했습니다",
        Lang::En => "No CPU temperature sensor (coretemp/k10temp) was found",
    }
}

#[cfg(target_os = "macos")]
pub fn cpu_temp_macos_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "macOS에서는 CPU 온도를 읽을 수 없습니다(비공개 API)",
        Lang::En => "CPU temperature is not available on macOS (private API)",
    }
}
