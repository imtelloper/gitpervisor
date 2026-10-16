//! 디스크 건강(S.M.A.R.T./NVMe 건강 로그) — DOCS/pc-care-design.md §4.1.
//!
//! Windows는 비관리자로 읽히는 NVMe 건강 로그만 직접 읽고(접근 권한 0으로 연 핸들 + IOCTL_STORAGE_QUERY_PROPERTY),
//! Linux·macOS는 smartctl JSON을 쓴다. 읽지 못한 디스크도 목록에서 빼지 않고 `unreadable_reason`으로 이유를 보인다.

use serde::Serialize;
#[cfg(not(windows))]
use serde_json::Value;

use crate::error::IpcError;
#[cfg(not(windows))]
use crate::error::ErrorCode;
use crate::i18n::text_pccare_health as text;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum DiskKind {
    Nvme,
    Ata,
    #[default]
    Other,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum HealthStatus {
    Ok,
    Warning,
    Critical,
    #[default]
    Unknown,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiskHealth {
    pub index: u32,
    pub model: String,
    pub serial: Option<String>,
    pub bus: String,
    pub size_bytes: Option<u64>,
    pub kind: DiskKind,
    pub status: HealthStatus,
    pub temperature_c: Option<i32>,
    pub percentage_used: Option<u32>,
    pub available_spare_pct: Option<u32>,
    pub available_spare_threshold_pct: Option<u32>,
    pub power_on_hours: Option<u64>,
    pub power_cycles: Option<u64>,
    pub unsafe_shutdowns: Option<u64>,
    pub media_errors: Option<u64>,
    pub error_log_entries: Option<u64>,
    pub data_read_bytes: Option<u64>,
    pub data_written_bytes: Option<u64>,
    pub critical_warning: Option<u32>,
    pub unreadable_reason: Option<String>,
}

/// 판정 기준(설계 §4.1): 제조사 경고 비트·예비 영역 고갈은 위험, 수명 90%·미디어 오류·70℃ 이상은 주의.
pub fn classify_disk_status(d: &DiskHealth) -> HealthStatus {
    let spare_exhausted = matches!(
        (d.available_spare_pct, d.available_spare_threshold_pct),
        (Some(s), Some(t)) if s < t
    );
    if d.critical_warning.is_some_and(|c| c != 0) || spare_exhausted {
        return HealthStatus::Critical;
    }
    if d.percentage_used.is_some_and(|p| p >= 90)
        || d.media_errors.is_some_and(|m| m > 0)
        || d.temperature_c.is_some_and(|t| t >= 70)
    {
        return HealthStatus::Warning;
    }
    let any = d.temperature_c.is_some()
        || d.percentage_used.is_some()
        || d.available_spare_pct.is_some()
        || d.power_on_hours.is_some()
        || d.power_cycles.is_some()
        || d.media_errors.is_some()
        || d.critical_warning.is_some();
    if any {
        HealthStatus::Ok
    } else {
        HealthStatus::Unknown
    }
}

/// NVMe SMART/Health Information 로그(512B, NVMe 1.4 그림 194)를 채운다. 128비트 카운터는 u64로 포화시킨다 —
/// JS 숫자로 넘어가니 그 이상은 어차피 정밀도가 없다.
pub fn apply_nvme_health_log(d: &mut DiskHealth, log: &[u8]) -> bool {
    if log.len() < 192 {
        return false;
    }
    let u128_at = |off: usize| {
        let mut b = [0u8; 16];
        b.copy_from_slice(&log[off..off + 16]);
        u128::from_le_bytes(b)
    };
    let sat = |v: u128| u64::try_from(v).unwrap_or(u64::MAX);
    // 데이터 단위 = 1000 × 512바이트(NVMe 규격).
    let units_to_bytes = |v: u128| sat(v.saturating_mul(512_000));

    d.critical_warning = Some(u32::from(log[0]));
    let kelvin = u16::from_le_bytes([log[1], log[2]]);
    // 0K는 "보고 안 함" — 실제 온도일 수 없다.
    d.temperature_c = (kelvin > 0).then(|| i32::from(kelvin) - 273);
    d.available_spare_pct = Some(u32::from(log[3]));
    d.available_spare_threshold_pct = Some(u32::from(log[4]));
    d.percentage_used = Some(u32::from(log[5]));
    d.data_read_bytes = Some(units_to_bytes(u128_at(32)));
    d.data_written_bytes = Some(units_to_bytes(u128_at(48)));
    d.power_cycles = Some(sat(u128_at(112)));
    d.power_on_hours = Some(sat(u128_at(128)));
    d.unsafe_shutdowns = Some(sat(u128_at(144)));
    d.media_errors = Some(sat(u128_at(160)));
    d.error_log_entries = Some(sat(u128_at(176)));
    true
}

/// STORAGE_DEVICE_DESCRIPTOR(바이트) → (모델, 시리얼, BusType). 문자열은 오프셋이 가리키는 NUL 종료 ASCII, 0이면 없음.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn decode_device_descriptor(buf: &[u8]) -> Option<(String, Option<String>, u32)> {
    let u32_at = |off: usize| buf.get(off..off + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let str_at = |off: u32| -> Option<String> {
        let start = usize::try_from(off).ok().filter(|&o| o > 0 && o < buf.len())?;
        let end = buf[start..].iter().position(|&b| b == 0).map_or(buf.len(), |p| start + p);
        let s = String::from_utf8_lossy(&buf[start..end]).trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    let vendor = str_at(u32_at(12)?);
    let product = str_at(u32_at(16)?);
    let serial = str_at(u32_at(24)?);
    let bus = u32_at(28)?;
    let model = match (vendor, product) {
        (Some(v), Some(p)) if !p.starts_with(&v) => format!("{v} {p}"),
        (_, Some(p)) => p,
        (Some(v), None) => v,
        (None, None) => String::new(),
    };
    Some((model, serial, bus))
}

/// STORAGE_BUS_TYPE → 표시 이름(규격 이름이라 번역하지 않는다).
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn bus_name(bus: u32) -> (String, DiskKind) {
    let (name, kind) = match bus {
        1 => ("SCSI", DiskKind::Other),
        2 => ("ATAPI", DiskKind::Ata),
        3 => ("ATA", DiskKind::Ata),
        4 => ("1394", DiskKind::Other),
        7 => ("USB", DiskKind::Other),
        8 => ("RAID", DiskKind::Other),
        9 => ("iSCSI", DiskKind::Other),
        10 => ("SAS", DiskKind::Other),
        11 => ("SATA", DiskKind::Ata),
        12 => ("SD", DiskKind::Other),
        13 => ("MMC", DiskKind::Other),
        14 | 15 => ("Virtual", DiskKind::Other),
        16 => ("Storage Spaces", DiskKind::Other),
        17 => ("NVMe", DiskKind::Nvme),
        18 => ("SCM", DiskKind::Other),
        19 => ("UFS", DiskKind::Other),
        _ => return (format!("#{bus}"), DiskKind::Other),
    };
    (name.to_string(), kind)
}

#[tauri::command(async)]
pub async fn disk_health_list() -> Result<Vec<DiskHealth>, IpcError> {
    imp::list().await
}

#[cfg(windows)]
mod imp {
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::{IOCTL_STORAGE_QUERY_PROPERTY, StorageDeviceProperty, StorageDeviceProtocolSpecificProperty};

    use super::*;
    use crate::error::ErrorCode;

    // FILE_ANY_ACCESS라 접근 권한 0 핸들로 된다(IOCTL_DISK_GET_LENGTH_INFO는 읽기 권한이 필요해 비관리자는 거부).
    const IOCTL_DISK_GET_DRIVE_GEOMETRY_EX: u32 = 0x0007_00A0;
    const NVME_PROTOCOL: u32 = 3;
    const NVME_DATA_TYPE_LOG_PAGE: u32 = 2;
    const NVME_LOG_PAGE_HEALTH_INFO: u32 = 2;
    const NVME_LOG_LEN: usize = 512;
    // STORAGE_PROPERTY_QUERY(8) 바로 뒤의 STORAGE_PROTOCOL_SPECIFIC_DATA(40) 다음에 로그가 온다 — 입출력 모두 같은 자리.
    const NVME_LOG_OFFSET: usize = 8 + 40;

    pub async fn list() -> Result<Vec<DiskHealth>, IpcError> {
        tauri::async_runtime::spawn_blocking(scan)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::disk_health_task_failed(e)))
    }

    fn scan() -> Vec<DiskHealth> {
        // 번호가 비어 있을 수 있어(분리한 USB) 32까지 다 열어 본다 — 없으면 ERROR_FILE_NOT_FOUND라 비용이 없다.
        (0..32u32).filter_map(read_disk).collect()
    }

    fn read_disk(index: u32) -> Option<DiskHealth> {
        let path = format!(r"\\.\PhysicalDrive{index}");
        // 접근 권한 0: GENERIC_READ로 열면 비관리자는 5(거부). 질의 IOCTL은 FILE_ANY_ACCESS라 이것으로 충분하다.
        let file = match OpenOptions::new().access_mode(0).share_mode(3).open(&path) {
            Ok(f) => f,
            Err(e) if e.raw_os_error() == Some(2) => return None,
            Err(e) => {
                let mut d = DiskHealth { index, ..Default::default() };
                d.unreadable_reason = Some(text::disk_open_failed(&path, e));
                return Some(d);
            }
        };
        let mut d = DiskHealth { index, ..Default::default() };
        if let Some((model, serial, bus)) = query_descriptor(&file) {
            let (bus_name, kind) = bus_name(bus);
            d.model = model;
            d.serial = serial;
            d.bus = bus_name;
            d.kind = kind;
        }
        d.size_bytes = query_size(&file);
        match query_nvme_health(&file) {
            Ok(log) => {
                apply_nvme_health_log(&mut d, &log);
            }
            Err(code) => {
                d.unreadable_reason = Some(if d.kind == DiskKind::Ata {
                    text::disk_ata_smart_unsupported().to_string()
                } else {
                    text::disk_health_not_exposed(code)
                });
            }
        }
        d.status = classify_disk_status(&d);
        Some(d)
    }

    fn ioctl(file: &File, code: u32, input: &[u8], output: &mut [u8]) -> Result<usize, u32> {
        let mut returned = 0u32;
        // SAFETY: 핸들은 file이 살아 있는 동안 유효하고, 버퍼 포인터·길이는 슬라이스 그대로다(동기 호출, OVERLAPPED 없음).
        let ok = unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                code,
                input.as_ptr().cast(),
                input.len() as u32,
                output.as_mut_ptr().cast(),
                output.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32);
        }
        Ok(returned as usize)
    }

    fn query_descriptor(file: &File) -> Option<(String, Option<String>, u32)> {
        let mut input = [0u8; 12];
        input[0..4].copy_from_slice(&(StorageDeviceProperty as u32).to_le_bytes());
        let mut out = vec![0u8; 1024];
        let n = ioctl(file, IOCTL_STORAGE_QUERY_PROPERTY, &input, &mut out).ok()?;
        out.truncate(n);
        decode_device_descriptor(&out)
    }

    fn query_size(file: &File) -> Option<u64> {
        let mut out = [0u8; 256];
        let n = ioctl(file, IOCTL_DISK_GET_DRIVE_GEOMETRY_EX, &[], &mut out).ok()?;
        // DISK_GEOMETRY_EX: DISK_GEOMETRY(24바이트) 뒤에 DiskSize(i64).
        let b = out.get(24..32).filter(|_| n >= 32)?;
        let size = i64::from_le_bytes(b.try_into().ok()?);
        u64::try_from(size).ok().filter(|&s| s > 0)
    }

    fn query_nvme_health(file: &File) -> Result<Vec<u8>, u32> {
        let mut buf = vec![0u8; NVME_LOG_OFFSET + NVME_LOG_LEN];
        let put = |buf: &mut [u8], off: usize, v: u32| buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
        put(&mut buf, 0, StorageDeviceProtocolSpecificProperty as u32);
        put(&mut buf, 4, 0); // PropertyStandardQuery
        put(&mut buf, 8, NVME_PROTOCOL);
        put(&mut buf, 12, NVME_DATA_TYPE_LOG_PAGE);
        put(&mut buf, 16, NVME_LOG_PAGE_HEALTH_INFO);
        put(&mut buf, 20, 0);
        put(&mut buf, 24, 40); // ProtocolDataOffset — STORAGE_PROTOCOL_SPECIFIC_DATA 시작 기준
        put(&mut buf, 28, NVME_LOG_LEN as u32);
        let input = buf.clone();
        let n = ioctl(file, IOCTL_STORAGE_QUERY_PROPERTY, &input, &mut buf)?;
        if n < NVME_LOG_OFFSET + 192 {
            // ERROR_INVALID_DATA — 성공이라 했지만 로그가 잘려 왔다.
            return Err(13);
        }
        Ok(buf[NVME_LOG_OFFSET..n.min(buf.len())].to_vec())
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::PathBuf;

    use super::*;
    use crate::sysinfo_static::run_capture;

    const SMARTCTL_TIMEOUT_SECS: u64 = 20;

    /// GUI로 띄운 앱의 PATH에는 sbin이 없는 경우가 많다(smartctl은 /usr/sbin) — 흔한 설치 위치를 같이 본다.
    fn find_smartctl() -> Option<PathBuf> {
        let extra = ["/usr/sbin", "/usr/local/sbin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/sbin"];
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .chain(extra.iter().map(PathBuf::from))
            .map(|dir| dir.join("smartctl"))
            .find(|p| p.is_file())
    }

    pub async fn list() -> Result<Vec<DiskHealth>, IpcError> {
        let Some(smartctl) = find_smartctl() else {
            #[cfg(target_os = "linux")]
            {
                let disks = linux_sysfs_nvme();
                if !disks.is_empty() {
                    return Ok(disks);
                }
            }
            return Err(IpcError::new(ErrorCode::ToolNotFound, text::smartctl_not_found()));
        };
        let exe = smartctl.to_string_lossy().into_owned();
        let scan = run_capture(&exe, &["--scan", "--json"], SMARTCTL_TIMEOUT_SECS)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, e))?;
        let scan: Value = serde_json::from_str(&scan)
            .map_err(|e| IpcError::new(ErrorCode::Io, text::smartctl_bad_json(e)))?;
        let devices = scan["devices"].as_array().cloned().unwrap_or_default();
        let exe = exe.as_str();
        // 한꺼번에 돈다 — 차례로 돌면 디스크당 최대 20초가 쌓여 IPC 60초를 넘길 수 있다.
        let jobs = devices.iter().enumerate().filter_map(|(i, dev)| {
            let name = dev["name"].as_str()?;
            let dtype = dev["type"].as_str().unwrap_or("auto");
            Some(read_device(exe, i as u32, name, dtype))
        });
        Ok(futures::future::join_all(jobs).await)
    }

    async fn read_device(exe: &str, index: u32, name: &str, dtype: &str) -> DiskHealth {
        let mut d = DiskHealth { index, model: name.to_string(), ..Default::default() };
        // -n standby: 탭을 열 때마다 잠든 HDD를 깨우지 않는다 — 그 디스크는 smartctl의 대기 상태 메시지가 이유로 남는다.
        match run_capture(exe, &["--json", "-a", "-n", "standby", "-d", dtype, name], SMARTCTL_TIMEOUT_SECS).await {
            Ok(json) => match serde_json::from_str::<Value>(&json) {
                Ok(v) => apply_smartctl_json(&mut d, &v),
                Err(e) => d.unreadable_reason = Some(text::smartctl_bad_json(e)),
            },
            Err(e) => d.unreadable_reason = Some(e),
        }
        // 비루트 GUI 앱이면 /dev/nvme*가 0600이라 smartctl은 거부만 받는다 — 커널이 공개하는 모델·온도라도 채운다.
        #[cfg(target_os = "linux")]
        if smart_data_missing(&d) {
            if let Some(ctrl) = nvme_controller_of(name) {
                fill_from_sysfs_nvme(&mut d, &std::path::Path::new("/sys/class/nvme").join(ctrl));
            }
        }
        d.status = classify_disk_status(&d);
        d
    }

    /// smartctl 없이도 커널이 내놓는 NVMe 모델·온도는 보인다(설계 §4.1).
    #[cfg(target_os = "linux")]
    fn linux_sysfs_nvme() -> Vec<DiskHealth> {
        let Ok(dir) = std::fs::read_dir("/sys/class/nvme") else { return Vec::new() };
        let mut names: Vec<_> = dir.flatten().map(|e| e.path()).collect();
        names.sort();
        names
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let mut d = DiskHealth {
                    index: i as u32,
                    unreadable_reason: Some(text::smartctl_not_found().to_string()),
                    ..Default::default()
                };
                fill_from_sysfs_nvme(&mut d, p);
                d.status = classify_disk_status(&d);
                d
            })
            .collect()
    }

    #[cfg(target_os = "linux")]
    fn fill_from_sysfs_nvme(d: &mut DiskHealth, ctrl_dir: &std::path::Path) {
        let read = |f: &str| {
            std::fs::read_to_string(ctrl_dir.join(f)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
        };
        let temp = std::fs::read_dir(ctrl_dir)
            .ok()
            .and_then(|it| it.flatten().find(|e| e.file_name().to_string_lossy().starts_with("hwmon")))
            .and_then(|h| std::fs::read_to_string(h.path().join("temp1_input")).ok())
            .and_then(|s| s.trim().parse::<i32>().ok())
            .map(|milli| milli / 1000);
        if let Some(m) = read("model") {
            d.model = m;
        }
        d.serial = d.serial.take().or_else(|| read("serial"));
        d.bus = "NVMe".to_string();
        d.kind = DiskKind::Nvme;
        d.temperature_c = d.temperature_c.or(temp);
    }
}

/// smartctl 장치 이름 → /sys/class/nvme의 컨트롤러 이름(`/dev/nvme0n1` → `nvme0`). NVMe가 아니면 None.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn nvme_controller_of(dev: &str) -> Option<&str> {
    let base = dev.rsplit('/').next()?;
    let digits = base.strip_prefix("nvme")?.bytes().take_while(u8::is_ascii_digit).count();
    (digits > 0).then(|| &base[..4 + digits])
}

#[cfg_attr(windows, allow(dead_code))]
fn smart_data_missing(d: &DiskHealth) -> bool {
    d.temperature_c.is_none() && d.power_on_hours.is_none() && d.critical_warning.is_none()
}

/// `smartctl --json -a` 결과를 채운다. NVMe는 건강 로그 그대로, ATA는 온도·시간·횟수와 재할당/보류/교정불가 섹터 합을
/// 미디어 오류로 본다. smartctl이 장치를 못 열면(권한 등) 그 메시지를 이유로 남긴다.
#[cfg_attr(windows, allow(dead_code))]
fn apply_smartctl_json(d: &mut DiskHealth, v: &serde_json::Value) {
    let u = |x: &serde_json::Value| x.as_u64();
    if let Some(m) = v["model_name"].as_str() {
        d.model = m.to_string();
    }
    d.serial = v["serial_number"].as_str().map(str::to_string).or(d.serial.take());
    d.size_bytes = u(&v["user_capacity"]["bytes"]).or(d.size_bytes);
    let protocol = v["device"]["protocol"].as_str().unwrap_or("");
    d.bus = protocol.to_string();
    d.kind = match protocol {
        "NVMe" => DiskKind::Nvme,
        "ATA" => DiskKind::Ata,
        _ => DiskKind::Other,
    };
    d.temperature_c = v["temperature"]["current"].as_i64().map(|t| t as i32);
    d.power_on_hours = u(&v["power_on_time"]["hours"]);
    d.power_cycles = u(&v["power_cycle_count"]);

    let nvme = &v["nvme_smart_health_information_log"];
    if nvme.is_object() {
        let small = |k: &str| nvme[k].as_u64().map(|x| x as u32);
        d.critical_warning = small("critical_warning");
        d.available_spare_pct = small("available_spare");
        d.available_spare_threshold_pct = small("available_spare_threshold");
        d.percentage_used = small("percentage_used");
        d.data_read_bytes = u(&nvme["data_units_read"]).map(|x| x.saturating_mul(512_000));
        d.data_written_bytes = u(&nvme["data_units_written"]).map(|x| x.saturating_mul(512_000));
        d.unsafe_shutdowns = u(&nvme["unsafe_shutdowns"]);
        d.media_errors = u(&nvme["media_errors"]);
        d.error_log_entries = u(&nvme["num_err_log_entries"]);
        d.power_on_hours = u(&nvme["power_on_hours"]).or(d.power_on_hours);
        d.power_cycles = u(&nvme["power_cycles"]).or(d.power_cycles);
    } else if let Some(attrs) = v["ata_smart_attributes"]["table"].as_array() {
        let raw = |id: u64| {
            attrs
                .iter()
                .find(|a| a["id"].as_u64() == Some(id))
                .and_then(|a| a["raw"]["value"].as_u64())
        };
        let bad = [5, 197, 198].iter().filter_map(|&id| raw(id)).collect::<Vec<_>>();
        d.media_errors = (!bad.is_empty()).then(|| bad.iter().sum());
        d.unsafe_shutdowns = raw(192);
    }
    // ATA는 경고 비트가 없다 — 드라이브 자체 판정(SMART overall FAILED)을 같은 "위험" 신호로 옮긴다.
    if let Some(passed) = v["smart_status"]["passed"].as_bool() {
        if d.critical_warning.is_none() {
            d.critical_warning = Some(u32::from(!passed));
        }
    }
    if smart_data_missing(d) {
        let msgs: Vec<(&str, &str)> = v["smartctl"]["messages"]
            .as_array()
            .map(|m| m.iter().filter_map(|x| Some((x["severity"].as_str().unwrap_or(""), x["string"].as_str()?))).collect())
            .unwrap_or_default();
        let errors: Vec<&str> = msgs.iter().filter(|(s, _)| *s == "error").map(|(_, m)| *m).collect();
        // 대기 상태(-n standby)는 information 등급으로만 남는다 — 오류가 없으면 남은 메시지라도 이유로 보인다.
        let shown: Vec<&str> = if errors.is_empty() { msgs.iter().map(|(_, m)| *m).collect() } else { errors };
        if !shown.is_empty() {
            d.unreadable_reason = Some(shown.join("; "));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health_log() -> Vec<u8> {
        let mut log = vec![0u8; 512];
        log[0] = 0;
        log[1..3].copy_from_slice(&326u16.to_le_bytes()); // 53℃
        log[3] = 100;
        log[4] = 10;
        log[5] = 9;
        log[32..48].copy_from_slice(&1000u128.to_le_bytes());
        log[48..64].copy_from_slice(&2000u128.to_le_bytes());
        log[112..128].copy_from_slice(&120u128.to_le_bytes());
        log[128..144].copy_from_slice(&5066u128.to_le_bytes());
        log[144..160].copy_from_slice(&56u128.to_le_bytes());
        log[160..176].copy_from_slice(&0u128.to_le_bytes());
        log[176..192].copy_from_slice(&7u128.to_le_bytes());
        log
    }

    #[test]
    fn pccare_health_nvme_log_decodes_fields() {
        let mut d = DiskHealth::default();
        assert!(apply_nvme_health_log(&mut d, &health_log()));
        assert_eq!(d.temperature_c, Some(53));
        assert_eq!(d.percentage_used, Some(9));
        assert_eq!(d.available_spare_pct, Some(100));
        assert_eq!(d.available_spare_threshold_pct, Some(10));
        assert_eq!(d.power_on_hours, Some(5066));
        assert_eq!(d.power_cycles, Some(120));
        assert_eq!(d.unsafe_shutdowns, Some(56));
        assert_eq!(d.media_errors, Some(0));
        assert_eq!(d.error_log_entries, Some(7));
        assert_eq!(d.data_read_bytes, Some(512_000_000));
        assert_eq!(d.data_written_bytes, Some(1_024_000_000));
        assert_eq!(classify_disk_status(&d), HealthStatus::Ok);
    }

    #[test]
    fn pccare_health_nvme_log_saturates_and_rejects_short() {
        let mut log = health_log();
        log[48..64].copy_from_slice(&u128::MAX.to_le_bytes());
        log[1..3].copy_from_slice(&0u16.to_le_bytes());
        let mut d = DiskHealth::default();
        assert!(apply_nvme_health_log(&mut d, &log));
        assert_eq!(d.data_written_bytes, Some(u64::MAX));
        assert_eq!(d.temperature_c, None);
        assert!(!apply_nvme_health_log(&mut DiskHealth::default(), &log[..100]));
    }

    #[test]
    fn pccare_health_classify_status() {
        let base = || {
            let mut d = DiskHealth::default();
            apply_nvme_health_log(&mut d, &health_log());
            d
        };
        assert_eq!(classify_disk_status(&DiskHealth::default()), HealthStatus::Unknown);
        let mut d = base();
        d.critical_warning = Some(4);
        assert_eq!(classify_disk_status(&d), HealthStatus::Critical);
        let mut d = base();
        d.available_spare_pct = Some(5);
        assert_eq!(classify_disk_status(&d), HealthStatus::Critical);
        let mut d = base();
        d.percentage_used = Some(90);
        assert_eq!(classify_disk_status(&d), HealthStatus::Warning);
        let mut d = base();
        d.media_errors = Some(1);
        assert_eq!(classify_disk_status(&d), HealthStatus::Warning);
        let mut d = base();
        d.temperature_c = Some(70);
        assert_eq!(classify_disk_status(&d), HealthStatus::Warning);
        let d = DiskHealth { temperature_c: Some(40), ..Default::default() };
        assert_eq!(classify_disk_status(&d), HealthStatus::Ok);
    }

    #[test]
    fn pccare_health_device_descriptor_decodes() {
        let mut buf = vec![0u8; 128];
        buf[12..16].copy_from_slice(&0u32.to_le_bytes()); // vendor 없음
        buf[16..20].copy_from_slice(&64u32.to_le_bytes());
        buf[24..28].copy_from_slice(&96u32.to_le_bytes());
        buf[28..32].copy_from_slice(&17u32.to_le_bytes());
        buf[64..64 + 13].copy_from_slice(b"Samsung SSD  ");
        buf[96..96 + 8].copy_from_slice(b" S4EWN0 ");
        let (model, serial, bus) = decode_device_descriptor(&buf).unwrap();
        assert_eq!(model, "Samsung SSD");
        assert_eq!(serial.as_deref(), Some("S4EWN0"));
        assert_eq!(bus_name(bus), ("NVMe".to_string(), DiskKind::Nvme));
        assert!(decode_device_descriptor(&buf[..20]).is_none());
    }

    #[test]
    fn pccare_health_smartctl_json() {
        let nvme: serde_json::Value = serde_json::from_str(
            r#"{"device":{"protocol":"NVMe"},"model_name":"WD SN850","serial_number":"X1",
                "user_capacity":{"bytes":1000204886016},"temperature":{"current":41},
                "smart_status":{"passed":true},
                "nvme_smart_health_information_log":{"critical_warning":0,"available_spare":100,
                "available_spare_threshold":10,"percentage_used":3,"data_units_read":10,"data_units_written":20,
                "power_cycles":5,"power_on_hours":99,"unsafe_shutdowns":2,"media_errors":0,"num_err_log_entries":1}}"#,
        )
        .unwrap();
        let mut d = DiskHealth::default();
        apply_smartctl_json(&mut d, &nvme);
        assert_eq!(d.kind, DiskKind::Nvme);
        assert_eq!(d.model, "WD SN850");
        assert_eq!(d.percentage_used, Some(3));
        assert_eq!(d.data_written_bytes, Some(10_240_000));
        assert_eq!(d.power_on_hours, Some(99));
        assert_eq!(classify_disk_status(&d), HealthStatus::Ok);

        let ata: serde_json::Value = serde_json::from_str(
            r#"{"device":{"protocol":"ATA"},"temperature":{"current":35},"power_on_time":{"hours":10},
                "smart_status":{"passed":false},
                "ata_smart_attributes":{"table":[{"id":5,"raw":{"value":3}},{"id":197,"raw":{"value":1}},{"id":192,"raw":{"value":8}}]}}"#,
        )
        .unwrap();
        let mut d = DiskHealth::default();
        apply_smartctl_json(&mut d, &ata);
        assert_eq!(d.media_errors, Some(4));
        assert_eq!(d.unsafe_shutdowns, Some(8));
        assert_eq!(classify_disk_status(&d), HealthStatus::Critical);

        let denied: serde_json::Value = serde_json::from_str(
            r#"{"smartctl":{"messages":[{"string":"Smartctl open device: /dev/sda failed: Permission denied","severity":"error"}]}}"#,
        )
        .unwrap();
        let mut d = DiskHealth::default();
        apply_smartctl_json(&mut d, &denied);
        assert!(d.unreadable_reason.unwrap().contains("Permission denied"));

        let standby: serde_json::Value = serde_json::from_str(
            r#"{"smartctl":{"messages":[{"string":"Device is in STANDBY mode, exit(2)","severity":"information"}],"exit_status":2}}"#,
        )
        .unwrap();
        let mut d = DiskHealth::default();
        apply_smartctl_json(&mut d, &standby);
        assert!(d.unreadable_reason.unwrap().contains("STANDBY"));
    }

    #[test]
    fn pccare_health_nvme_controller_of() {
        assert_eq!(nvme_controller_of("/dev/nvme0"), Some("nvme0"));
        assert_eq!(nvme_controller_of("/dev/nvme12n1"), Some("nvme12"));
        assert_eq!(nvme_controller_of("/dev/sda"), None);
        assert_eq!(nvme_controller_of("/dev/nvme"), None);
    }
}
