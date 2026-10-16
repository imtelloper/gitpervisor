//! GPU 온도 — DOCS/pc-care-design.md §4.2. 건강 탭이 보이는 동안 5초마다 불린다.
//!
//! 설계의 배열 대신 `supported`를 가진 봉투로 돌려준다 — macOS처럼 못 읽는 OS를 빈 목록과 구별해야 해서다.

use serde::Serialize;

use crate::error::IpcError;
#[cfg(not(windows))]
use crate::i18n::text_pccare_health as text;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuTemperature {
    pub name: String,
    pub temperature_c: Option<f64>,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuTemperatures {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub gpus: Vec<GpuTemperature>,
}

/// `nvidia-smi --query-gpu=name,temperature.gpu --format=csv,noheader,nounits` 한 줄 = GPU 하나.
/// 온도 칸이 `[N/A]`면 이름만 남긴다.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_nvidia_smi(out: &str) -> Vec<GpuTemperature> {
    out.lines()
        .filter_map(|line| {
            let (name, temp) = line.rsplit_once(',')?;
            let name = name.trim();
            (!name.is_empty()).then(|| GpuTemperature {
                name: name.to_string(),
                temperature_c: temp.trim().parse::<f64>().ok(),
                source: "nvidia-smi".to_string(),
            })
        })
        .collect()
}

#[tauri::command(async)]
pub async fn gpu_temperatures() -> Result<GpuTemperatures, IpcError> {
    imp::read().await
}

#[cfg(windows)]
mod imp {
    use windows_sys::Wdk::Graphics::Direct3D::{
        D3DKMTCloseAdapter, D3DKMTEnumAdapters2, D3DKMTQueryAdapterInfo, D3DKMT_ADAPTERINFO,
        D3DKMT_ADAPTERREGISTRYINFO, D3DKMT_ADAPTERTYPE, D3DKMT_ADAPTER_PERFDATA, D3DKMT_CLOSEADAPTER,
        D3DKMT_ENUMADAPTERS2, D3DKMT_QUERYADAPTERINFO, KMTQAITYPE_ADAPTERPERFDATA, KMTQAITYPE_ADAPTERREGISTRYINFO,
        KMTQAITYPE_ADAPTERTYPE, KMTQUERYADAPTERINFOTYPE,
    };

    use super::*;
    use crate::error::ErrorCode;
    use crate::i18n::text_pccare_health as text;

    // D3DKMT_ADAPTERTYPE 비트필드: RenderSupported(0), SoftwareDevice(2).
    const RENDER_SUPPORTED: u32 = 1 << 0;
    const SOFTWARE_DEVICE: u32 = 1 << 2;

    pub async fn read() -> Result<GpuTemperatures, IpcError> {
        let gpus = tauri::async_runtime::spawn_blocking(enumerate)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::gpu_temp_task_failed(e)))?
            .map_err(|status| IpcError::new(ErrorCode::Io, text::gpu_enum_failed(status)))?;
        Ok(GpuTemperatures { supported: true, unsupported_reason: None, gpus })
    }

    fn query<T>(adapter: u32, kind: KMTQUERYADAPTERINFOTYPE, data: &mut T) -> bool {
        let mut q = D3DKMT_QUERYADAPTERINFO {
            hAdapter: adapter,
            Type: kind,
            pPrivateDriverData: (data as *mut T).cast(),
            PrivateDriverDataSize: std::mem::size_of::<T>() as u32,
        };
        // SAFETY: data는 kind가 요구하는 구조체이고 크기를 정확히 넘긴다.
        unsafe { D3DKMTQueryAdapterInfo(&mut q) >= 0 }
    }

    fn enumerate() -> Result<Vec<GpuTemperature>, i32> {
        // 작업 관리자와 같은 경로라 관리자 권한이 필요 없다. 첫 호출은 개수만, 두 번째가 핸들을 연다.
        let mut e = D3DKMT_ENUMADAPTERS2 { NumAdapters: 0, pAdapters: std::ptr::null_mut() };
        // SAFETY: pAdapters가 null이면 개수만 채운다.
        let st = unsafe { D3DKMTEnumAdapters2(&mut e) };
        if st < 0 {
            return Err(st);
        }
        // SAFETY: D3DKMT_ADAPTERINFO는 정수·LUID뿐인 POD라 0으로 채워도 유효하다.
        let mut adapters: Vec<D3DKMT_ADAPTERINFO> = vec![unsafe { std::mem::zeroed() }; e.NumAdapters as usize];
        e.pAdapters = adapters.as_mut_ptr();
        // SAFETY: 버퍼 길이 = NumAdapters.
        let st = unsafe { D3DKMTEnumAdapters2(&mut e) };
        if st < 0 {
            return Err(st);
        }
        adapters.truncate(e.NumAdapters as usize);

        let mut out = Vec::new();
        for a in &adapters {
            if let Some(g) = read_adapter(a.hAdapter) {
                out.push(g);
            }
            let close = D3DKMT_CLOSEADAPTER { hAdapter: a.hAdapter };
            // SAFETY: EnumAdapters2가 연 핸들 — 하나씩 정확히 한 번 닫는다. 실패해도 할 수 있는 일이 없다.
            unsafe { D3DKMTCloseAdapter(&close) };
        }
        Ok(out)
    }

    fn read_adapter(h: u32) -> Option<GpuTemperature> {
        // SAFETY: 아래 셋 다 정수·배열뿐인 POD.
        let mut ty: D3DKMT_ADAPTERTYPE = unsafe { std::mem::zeroed() };
        if query(h, KMTQAITYPE_ADAPTERTYPE, &mut ty) {
            // SAFETY: 유니온의 두 갈래 모두 같은 u32다.
            let bits = unsafe { ty.Anonymous.Value };
            // Microsoft 기본 렌더러(소프트웨어)·디스플레이 전용 어댑터에는 온도가 없다.
            if bits & SOFTWARE_DEVICE != 0 || bits & RENDER_SUPPORTED == 0 {
                return None;
            }
        }
        let mut perf: D3DKMT_ADAPTER_PERFDATA = unsafe { std::mem::zeroed() };
        // 0.1℃ 단위, 0 = 드라이버가 보고하지 않음.
        let temp = (query(h, KMTQAITYPE_ADAPTERPERFDATA, &mut perf) && perf.Temperature > 0)
            .then(|| f64::from(perf.Temperature) / 10.0);
        let mut reg: D3DKMT_ADAPTERREGISTRYINFO = unsafe { std::mem::zeroed() };
        let name = if query(h, KMTQAITYPE_ADAPTERREGISTRYINFO, &mut reg) {
            let s = &reg.AdapterString;
            let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
            String::from_utf16_lossy(&s[..end]).trim().to_string()
        } else {
            String::new()
        };
        if name.is_empty() && temp.is_none() {
            return None;
        }
        Some(GpuTemperature { name, temperature_c: temp, source: "D3DKMT".to_string() })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use crate::sysinfo_static::run_capture;

    pub async fn read() -> Result<GpuTemperatures, IpcError> {
        let mut gpus = sysfs();
        // NVIDIA 독점 드라이버는 hwmon을 내놓지 않는다. 시간 제한은 IPC 4초보다 짧게 — 느린 nvidia-smi
        // (지속 데몬 없는 첫 호출·멈춘 드라이버) 때문에 이미 읽은 hwmon 값까지 잃지 않게.
        if let Ok(out) = run_capture(
            "nvidia-smi",
            &["--query-gpu=name,temperature.gpu", "--format=csv,noheader,nounits"],
            2,
        )
        .await
        {
            gpus.extend(parse_nvidia_smi(&out));
        }
        let unsupported_reason = gpus.is_empty().then(|| text::gpu_temp_none_found().to_string());
        Ok(GpuTemperatures { supported: true, unsupported_reason, gpus })
    }

    /// amdgpu·i915 등 hwmon을 내놓는 드라이버 — 이름은 hwmon의 `name`(드라이버명).
    fn sysfs() -> Vec<GpuTemperature> {
        let Ok(cards) = std::fs::read_dir("/sys/class/drm") else { return Vec::new() };
        let mut paths: Vec<_> = cards
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("card") && !n.contains('-')))
            .collect();
        paths.sort();
        let mut out = Vec::new();
        for card in paths {
            let Ok(hw) = std::fs::read_dir(card.join("device/hwmon")) else { continue };
            for h in hw.flatten() {
                let p = h.path();
                let Some(milli) = std::fs::read_to_string(p.join("temp1_input")).ok().and_then(|s| s.trim().parse::<f64>().ok())
                else {
                    continue;
                };
                let driver = std::fs::read_to_string(p.join("name")).map(|s| s.trim().to_string()).unwrap_or_default();
                let card_name = card.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                out.push(GpuTemperature {
                    name: if driver.is_empty() { card_name } else { format!("{card_name} ({driver})") },
                    temperature_c: Some(milli / 1000.0),
                    source: "hwmon".to_string(),
                });
            }
        }
        out
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::*;

    pub async fn read() -> Result<GpuTemperatures, IpcError> {
        // SMC 온도는 비공개 API뿐이다(설계 §4.2).
        Ok(GpuTemperatures {
            supported: false,
            unsupported_reason: Some(text::gpu_temp_unsupported_os().to_string()),
            gpus: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_health_nvidia_smi_parses() {
        let out = "NVIDIA GeForce RTX 4090, 45\nNVIDIA A100-SXM4-40GB, [N/A]\n\n";
        let g = parse_nvidia_smi(out);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].name, "NVIDIA GeForce RTX 4090");
        assert_eq!(g[0].temperature_c, Some(45.0));
        assert_eq!(g[1].temperature_c, None);
    }
}
