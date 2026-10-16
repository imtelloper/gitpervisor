//! CPU 온도 — 리소스 모니터 프로세스 탭 머리에 2초마다 보인다(GPU 온도는 gpu_temp.rs 재사용).
//!
//! Windows는 CPU 코어 온도를 **관리자 커널 드라이버 없이** 내주지 않는다. 공식 경로인 ACPI 열 영역
//! (`\Thermal Zone Information`)은 비관리자로 읽히지만 메인보드·케이스 영역이라(실측 2026-10-16: TZ00 = 28℃,
//! CPU는 60℃대) CPU 온도로 보이면 거짓말이 된다 — 쓰지 않는다. 대신 이미 드라이버를 가진 HWiNFO가
//! "공유 메모리 지원"으로 내놓는 값을 읽는다(비관리자로 열린다). 없으면 이유를 돌려준다.
//! Linux는 hwmon(coretemp·k10temp)이 root 없이 읽힌다. macOS는 SMC/IOHID가 비공개 API라 미지원.

use serde::Serialize;

use crate::error::IpcError;
use crate::i18n::text_pccare_health as text;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuTemperature {
    pub temperature_c: Option<f64>,
    /// "HWiNFO · CPU Package" / "coretemp · Package id 0" — 툴팁용 출처.
    pub source: Option<String>,
    pub unavailable_reason: Option<String>,
}

impl CpuTemperature {
    fn found(c: f64, source: String) -> Self {
        Self { temperature_c: Some(c), source: Some(source), unavailable_reason: None }
    }
    fn missing(reason: String) -> Self {
        Self { temperature_c: None, source: None, unavailable_reason: Some(reason) }
    }
}

#[tauri::command(async)]
pub async fn cpu_temperature() -> Result<CpuTemperature, IpcError> {
    Ok(imp::read())
}

// ─────────────────────────── HWiNFO 공유 메모리(Windows) ───────────────────────────
// HWiNFO SDK의 `HWiNFO_SENSORS_SHARED_MEM2`(#pragma pack(1)). 머리:
//   0 dwSignature("HWiS", 꺼지면 "DEAD") · 4 dwVersion · 8 dwRevision · 12 poll_time(i64) ·
//   20 dwOffsetOfSensorSection · 24 dwSizeOfSensorElement · 28 dwNumSensorElements ·
//   32 dwOffsetOfReadingSection · 36 dwSizeOfReadingElement · 40 dwNumReadingElements
// 읽음 원소: 0 tReading(1=온도) · 4 dwSensorIndex · 8 dwReadingID · 12 szLabelOrig[128] ·
//   140 szLabelUser[128] · 268 szUnit[16] · 284 Value(f64)
const HWINFO_SIGNATURE: u32 = u32::from_le_bytes(*b"HWiS");
const HWINFO_READING_TEMP: u32 = 1;
const HWINFO_LABEL_ORIG: usize = 12;
const HWINFO_UNIT: usize = 268;
const HWINFO_VALUE: usize = 284;

// 앞의 것일수록 "CPU 온도"에 가깝다 — Intel 패키지, AMD Tctl/Tdie, 그다음 코어 최댓값.
const CPU_LABELS: &[&str] = &["CPU Package", "CPU (Tctl/Tdie)", "CPU Die (average)", "Core Max", "CPU (Tdie)", "CPU (Tctl)"];

enum HwinfoRead {
    Inactive,
    NoCpuSensor,
    Found(f64, String),
}

fn le_u32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn c_str(b: &[u8]) -> &str {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    std::str::from_utf8(&b[..end]).unwrap_or("")
}

#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_hwinfo(mem: &[u8]) -> HwinfoRead {
    if le_u32(mem, 0) != Some(HWINFO_SIGNATURE) {
        return HwinfoRead::Inactive;
    }
    let (Some(off), Some(size), Some(count)) = (le_u32(mem, 32), le_u32(mem, 36), le_u32(mem, 40)) else {
        return HwinfoRead::Inactive;
    };
    let (off, size) = (off as usize, size as usize);
    if size < HWINFO_VALUE + 8 {
        return HwinfoRead::Inactive;
    }
    let mut best: Option<(usize, f64, &str)> = None;
    for i in 0..count as usize {
        let Some(el) = mem.get(off + i * size..off + (i + 1) * size) else { break };
        if le_u32(el, 0) != Some(HWINFO_READING_TEMP) {
            continue;
        }
        let label = c_str(&el[HWINFO_LABEL_ORIG..HWINFO_LABEL_ORIG + 128]);
        let Some(rank) = CPU_LABELS.iter().position(|l| *l == label) else { continue };
        let raw = f64::from_le_bytes(el[HWINFO_VALUE..HWINFO_VALUE + 8].try_into().unwrap_or([0; 8]));
        // 사용자가 HWiNFO를 화씨로 설정했으면 단위 칸이 "°F"다(CP-1252 0xB0 + 'F').
        let unit = &el[HWINFO_UNIT..HWINFO_UNIT + 16];
        let c = if unit.contains(&b'F') { (raw - 32.0) * 5.0 / 9.0 } else { raw };
        if best.is_none_or(|(r, _, _)| rank < r) {
            best = Some((rank, c, label));
        }
    }
    match best {
        Some((_, c, label)) if c.is_finite() && c > 0.0 => HwinfoRead::Found(c, format!("HWiNFO · {label}")),
        _ => HwinfoRead::NoCpuSensor,
    }
}

// ─────────────────────────── hwmon(Linux) ───────────────────────────

/// (칩 이름, 라벨, 밀리℃) 목록에서 CPU 온도 하나를 고른다 — 패키지/Tctl 라벨이 있으면 그것, 없으면 CPU 칩의 최댓값.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn pick_hwmon(readings: &[(String, Option<String>, i64)]) -> Option<(f64, String)> {
    const CHIPS: &[&str] = &["coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal"];
    const PREFERRED: &[&str] = &["Package id 0", "Tctl", "Tdie"];
    let cpu: Vec<_> = readings.iter().filter(|(chip, _, _)| CHIPS.contains(&chip.as_str())).collect();
    let preferred = PREFERRED
        .iter()
        .find_map(|p| cpu.iter().find(|(_, l, _)| l.as_deref() == Some(*p)));
    let chosen = preferred.or_else(|| cpu.iter().max_by_key(|(_, _, m)| *m))?;
    let (chip, label, milli) = chosen;
    let source = match label {
        Some(l) => format!("{chip} · {l}"),
        None => chip.clone(),
    };
    Some((*milli as f64 / 1000.0, source))
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Memory::{
        MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ, MEMORY_BASIC_INFORMATION,
    };

    use super::*;

    pub fn read() -> CpuTemperature {
        match read_hwinfo() {
            HwinfoRead::Found(c, source) => CpuTemperature::found(c, source),
            HwinfoRead::NoCpuSensor => CpuTemperature::missing(text::cpu_temp_hwinfo_no_cpu().to_string()),
            HwinfoRead::Inactive => CpuTemperature::missing(text::cpu_temp_needs_hwinfo().to_string()),
        }
    }

    fn read_hwinfo() -> HwinfoRead {
        let name: Vec<u16> = "Global\\HWiNFO_SENS_SM2".encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: 이름은 NUL 종료 UTF-16. 실패(HWiNFO 꺼짐·공유 메모리 꺼짐)는 null 핸들로 온다.
        let handle = unsafe { OpenFileMappingW(FILE_MAP_READ, 0, name.as_ptr()) };
        if handle.is_null() {
            return HwinfoRead::Inactive;
        }
        // SAFETY: 읽기 전용 전체 뷰. 크기는 VirtualQuery로 잰 영역을 넘지 않게 슬라이스한다.
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0) };
        let result = if view.Value.is_null() {
            HwinfoRead::Inactive
        } else {
            let mut info: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
            let got = unsafe {
                VirtualQuery(view.Value, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>())
            };
            let r = if got == 0 {
                HwinfoRead::Inactive
            } else {
                // SAFETY: 매핑된 영역의 시작과 그 영역 크기 — 뷰가 살아 있는 동안만 쓴다.
                let mem = unsafe { std::slice::from_raw_parts(view.Value as *const u8, info.RegionSize) };
                parse_hwinfo(mem)
            };
            unsafe { UnmapViewOfFile(view) };
            r
        };
        unsafe { CloseHandle(handle) };
        result
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    pub fn read() -> CpuTemperature {
        let mut readings = Vec::new();
        let Ok(dirs) = std::fs::read_dir("/sys/class/hwmon") else {
            return CpuTemperature::missing(text::cpu_temp_linux_none().to_string());
        };
        for dir in dirs.flatten() {
            let path = dir.path();
            let Ok(chip) = std::fs::read_to_string(path.join("name")) else { continue };
            let chip = chip.trim().to_string();
            let Ok(files) = std::fs::read_dir(&path) else { continue };
            for f in files.flatten() {
                let fname = f.file_name().to_string_lossy().into_owned();
                let Some(stem) = fname.strip_suffix("_input").filter(|s| s.starts_with("temp")) else { continue };
                let Some(milli) = std::fs::read_to_string(f.path()).ok().and_then(|v| v.trim().parse::<i64>().ok())
                else {
                    continue;
                };
                let label = std::fs::read_to_string(path.join(format!("{stem}_label"))).ok().map(|l| l.trim().to_string());
                readings.push((chip.clone(), label, milli));
            }
        }
        match pick_hwmon(&readings) {
            Some((c, source)) => CpuTemperature::found(c, source),
            None => CpuTemperature::missing(text::cpu_temp_linux_none().to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    pub fn read() -> CpuTemperature {
        CpuTemperature::missing(text::cpu_temp_macos_unsupported().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(kind: u32, label: &str, unit: &[u8], value: f64) -> Vec<u8> {
        let mut el = vec![0u8; 316];
        el[0..4].copy_from_slice(&kind.to_le_bytes());
        el[HWINFO_LABEL_ORIG..HWINFO_LABEL_ORIG + label.len()].copy_from_slice(label.as_bytes());
        el[HWINFO_UNIT..HWINFO_UNIT + unit.len()].copy_from_slice(unit);
        el[HWINFO_VALUE..HWINFO_VALUE + 8].copy_from_slice(&value.to_le_bytes());
        el
    }

    fn shared_mem(sig: &[u8; 4], els: &[Vec<u8>]) -> Vec<u8> {
        let mut mem = vec![0u8; 64];
        mem[0..4].copy_from_slice(sig);
        mem[32..36].copy_from_slice(&64u32.to_le_bytes());
        mem[36..40].copy_from_slice(&316u32.to_le_bytes());
        mem[40..44].copy_from_slice(&(els.len() as u32).to_le_bytes());
        for e in els {
            mem.extend_from_slice(e);
        }
        mem
    }

    #[test]
    fn pccare_health_hwinfo_picks_cpu_package_over_core_max() {
        let mem = shared_mem(
            b"HWiS",
            &[
                reading(1, "Core Max", b"\xB0C", 71.0),
                reading(2, "CPU Package", b"V", 1.2), // 전압 — 온도가 아니다
                reading(1, "CPU Package", b"\xB0C", 64.5),
                reading(1, "GPU Temperature", b"\xB0C", 55.0),
            ],
        );
        match parse_hwinfo(&mem) {
            HwinfoRead::Found(c, src) => {
                assert_eq!(c, 64.5);
                assert_eq!(src, "HWiNFO · CPU Package");
            }
            _ => panic!("expected a CPU reading"),
        }
    }

    #[test]
    fn pccare_health_hwinfo_converts_fahrenheit_and_handles_dead_or_missing() {
        let f = shared_mem(b"HWiS", &[reading(1, "CPU (Tctl/Tdie)", b"\xB0F", 158.0)]);
        assert!(matches!(parse_hwinfo(&f), HwinfoRead::Found(c, _) if (c - 70.0).abs() < 1e-9));
        assert!(matches!(parse_hwinfo(&shared_mem(b"DEAD", &[])), HwinfoRead::Inactive));
        let gpu_only = shared_mem(b"HWiS", &[reading(1, "GPU Temperature", b"\xB0C", 55.0)]);
        assert!(matches!(parse_hwinfo(&gpu_only), HwinfoRead::NoCpuSensor));
        // 원소 개수가 실제 크기보다 커도 경계 밖을 읽지 않는다.
        let mut short = shared_mem(b"HWiS", &[reading(1, "CPU Package", b"\xB0C", 60.0)]);
        short[40..44].copy_from_slice(&99u32.to_le_bytes());
        assert!(matches!(parse_hwinfo(&short), HwinfoRead::Found(c, _) if c == 60.0));
        assert!(matches!(parse_hwinfo(&[0u8; 8]), HwinfoRead::Inactive));
    }

    #[test]
    fn pccare_health_hwmon_prefers_package_then_cpu_chip_max() {
        let r = |chip: &str, label: Option<&str>, m: i64| (chip.to_string(), label.map(str::to_string), m);
        let intel = [r("acpitz", None, 28_000), r("coretemp", Some("Core 0"), 66_000), r("coretemp", Some("Package id 0"), 64_000)];
        assert_eq!(pick_hwmon(&intel), Some((64.0, "coretemp · Package id 0".to_string())));
        let amd = [r("k10temp", Some("Tccd1"), 70_000), r("k10temp", Some("Tctl"), 72_500)];
        assert_eq!(pick_hwmon(&amd), Some((72.5, "k10temp · Tctl".to_string())));
        let arm = [r("cpu_thermal", None, 51_000), r("nvme", Some("Composite"), 40_000)];
        assert_eq!(pick_hwmon(&arm), Some((51.0, "cpu_thermal".to_string())));
        assert_eq!(pick_hwmon(&[r("acpitz", None, 28_000)]), None);
    }
}
