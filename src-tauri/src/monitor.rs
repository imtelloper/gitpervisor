use std::path::Path;

use serde::Serialize;
use sysinfo::{Disks, System};
use tauri::State;

use crate::state::AppState;

/// 타이틀바 시스템 모니터 페이로드 (퍼센트 + 절대값 툴팁용).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysMetrics {
    pub cpu: f32,
    /// GPU는 PDH 미지원 시 null
    pub gpu: Option<f32>,
    pub ram: f32,
    pub storage: f32,
    pub ram_used: u64,
    pub ram_total: u64,
    pub storage_used: u64,
    pub storage_total: u64,
}

pub struct Monitor {
    sys: System,
    gpu: gpu::GpuCounter,
}

impl Monitor {
    pub fn new() -> Self {
        let mut sys = System::new();
        // CPU 사용률은 두 샘플 사이 델타라 첫 샘플로 기준점을 잡는다.
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            sys,
            gpu: gpu::GpuCounter::new(),
        }
    }

    pub fn sample(&mut self) -> SysMetrics {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();

        let cpu = self.sys.global_cpu_usage();

        let ram_total = self.sys.total_memory();
        let ram_used = ram_total.saturating_sub(self.sys.available_memory());
        let ram = pct(ram_used, ram_total);

        // 시스템 드라이브(C:) 우선, 없으면 가장 큰 디스크.
        let disks = Disks::new_with_refreshed_list();
        let disk = disks
            .iter()
            .find(|d| d.mount_point() == Path::new("C:\\"))
            .or_else(|| disks.iter().max_by_key(|d| d.total_space()));
        let (storage_total, storage_used) = match disk {
            Some(d) => {
                let total = d.total_space();
                (total, total.saturating_sub(d.available_space()))
            }
            None => (0, 0),
        };

        SysMetrics {
            cpu,
            gpu: self.gpu.read(),
            ram,
            storage: pct(storage_used, storage_total),
            ram_used,
            ram_total,
            storage_used,
            storage_total,
        }
    }
}

fn pct(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64 * 100.0) as f32
    }
}

/// 타이틀바가 ~2초 간격으로 폴링하는 시스템 사용률.
#[tauri::command]
pub fn sys_metrics(state: State<'_, AppState>) -> SysMetrics {
    state.monitor.lock().unwrap().sample()
}

// ---- GPU: Windows PDH "GPU Engine" 사용률(전 어댑터 집계) ----
#[cfg(windows)]
mod gpu {
    use windows_sys::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
        PDH_FMT_COUNTERVALUE_ITEM_W,
    };

    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;
    const PDH_CSTATUS_VALID_DATA: u32 = 0x0000_0000;

    pub struct GpuCounter {
        query: isize,
        /// GPU Engine 사용률(전 어댑터·엔진)
        engine_counter: isize,
        /// GPU Adapter Memory 전용 VRAM 한도 — dGPU 식별용
        mem_counter: isize,
        ok: bool,
        /// 표시 대상 dGPU의 (HighPart, LowPart) LUID. 최초 read 시 1회 확정.
        target_luid: Option<(u32, u32)>,
        luid_resolved: bool,
    }

    // PDH 핸들(isize)은 스레드 이동 가능 — AppState Mutex 안에서만 접근한다.
    unsafe impl Send for GpuCounter {}

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// "…luid_0xHHHHHHHH_0xLLLLLLLL_phys_…"에서 (HighPart, LowPart)를 16진수로 파싱.
    /// 대소문자·제로패딩 차이를 피하려 문자열 비교 대신 수치로 비교한다.
    fn parse_luid(name: &str) -> Option<(u32, u32)> {
        let rest = name.split("luid_").nth(1)?;
        let mut parts = rest.split('_');
        let high = parts.next()?.trim_start_matches("0x").trim_start_matches("0X");
        let low = parts.next()?.trim_start_matches("0x").trim_start_matches("0X");
        Some((
            u32::from_str_radix(high, 16).ok()?,
            u32::from_str_radix(low, 16).ok()?,
        ))
    }

    impl GpuCounter {
        pub fn new() -> Self {
            unsafe {
                let mut query: isize = 0;
                if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                    return Self {
                        query: 0,
                        engine_counter: 0,
                        mem_counter: 0,
                        ok: false,
                        target_luid: None,
                        luid_resolved: false,
                    };
                }
                // 영어 카운터로 로케일 독립. 3D 렌더 엔진만(engtype_3D) 수집한다 —
                // DisplayLink USB 디스플레이의 copy 엔진은 화면 전송으로 상시 포화돼
                // 전체/최대 집계를 오염시키므로 제외(3D는 실제 렌더 부하를 반영).
                let path = wide("\\GPU Engine(*engtype_3D)\\Utilization Percentage");
                let mut engine_counter: isize = 0;
                if PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut engine_counter) != 0 {
                    return Self {
                        query,
                        engine_counter: 0,
                        mem_counter: 0,
                        ok: false,
                        target_luid: None,
                        luid_resolved: false,
                    };
                }
                // 어댑터별 전용 VRAM 한도 — 가장 큰 어댑터를 dGPU로 본다(iGPU는 ~0).
                // 추가 실패해도 치명적이지 않다(없으면 전 어댑터 최댓값으로 폴백).
                let mem_path = wide("\\GPU Adapter Memory(*)\\Dedicated Usage Limit");
                let mut mem_counter: isize = 0;
                if PdhAddEnglishCounterW(query, mem_path.as_ptr(), 0, &mut mem_counter) != 0 {
                    mem_counter = 0;
                }
                // 첫 수집(델타 기준점)
                PdhCollectQueryData(query);
                Self {
                    query,
                    engine_counter,
                    mem_counter,
                    ok: true,
                    target_luid: None,
                    luid_resolved: false,
                }
            }
        }

        pub fn read(&mut self) -> Option<f32> {
            if !self.ok {
                return None;
            }
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                // 표시 대상 dGPU LUID를 1회 확정(하드웨어는 바뀌지 않음).
                if !self.luid_resolved {
                    self.target_luid = self.resolve_dgpu_luid();
                    self.luid_resolved = true;
                }

                let (buf, count) = match formatted_array(self.engine_counter) {
                    Some(v) => v,
                    None => return Some(0.0),
                };
                // 인스턴스는 (프로세스 × 물리 엔진)당 1개. 물리 엔진별로 합산한 뒤
                // 가장 바쁜 엔진을 GPU 사용률로 본다(Task Manager 방식). 전체 합산은
                // 어댑터·엔진이 많아 100%로 과대계상되므로 쓰지 않는다.
                let items = buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W;
                let mut by_engine: std::collections::HashMap<String, f64> =
                    std::collections::HashMap::new();
                for i in 0..count as usize {
                    let item = &*items.add(i);
                    if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA {
                        continue;
                    }
                    let name = read_pwstr(item.szName);
                    // dGPU를 식별했으면 그 어댑터의 엔진만 집계(iGPU·기타 어댑터 제외).
                    if let Some(target) = self.target_luid {
                        if parse_luid(&name) != Some(target) {
                            continue;
                        }
                    }
                    // "pid_… luid_… phys_… eng_… engtype_…" — luid 이후가 물리 엔진 식별자
                    let key = name
                        .find("luid_")
                        .map(|i| name[i..].to_string())
                        .unwrap_or(name);
                    *by_engine.entry(key).or_insert(0.0) +=
                        item.FmtValue.Anonymous.doubleValue;
                }
                let max = by_engine.values().copied().fold(0.0f64, f64::max);
                Some(max.min(100.0) as f32)
            }
        }

        /// 전용 VRAM 한도가 가장 큰 어댑터의 LUID를 반환(= 외장 dGPU).
        /// 카운터가 없거나 어댑터가 없으면 None → 전 어댑터 최댓값으로 폴백.
        unsafe fn resolve_dgpu_luid(&self) -> Option<(u32, u32)> {
            if self.mem_counter == 0 {
                return None;
            }
            let (buf, count) = formatted_array(self.mem_counter)?;
            let items = buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W;
            let mut best: Option<((u32, u32), f64)> = None;
            for i in 0..count as usize {
                let item = &*items.add(i);
                if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA {
                    continue;
                }
                let name = read_pwstr(item.szName);
                let Some(luid) = parse_luid(&name) else {
                    continue;
                };
                let val = item.FmtValue.Anonymous.doubleValue;
                if best.map_or(true, |(_, b)| val > b) {
                    best = Some((luid, val));
                }
            }
            best.map(|(luid, _)| luid)
        }
    }

    /// PDH 포맷 카운터 배열을 (버퍼, 항목 수)로 수집. 데이터 없으면 None.
    unsafe fn formatted_array(counter: isize) -> Option<(Vec<u8>, u32)> {
        // 1) 버퍼 크기 조회
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let st = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            std::ptr::null_mut(),
        );
        if st != PDH_MORE_DATA || size == 0 {
            return None;
        }
        // 2) 실제 수집
        let mut buf = vec![0u8; size as usize];
        let st = PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W,
        );
        if st != 0 {
            return None;
        }
        Some((buf, count))
    }

    unsafe fn read_pwstr(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

#[cfg(not(windows))]
mod gpu {
    pub struct GpuCounter;
    impl GpuCounter {
        pub fn new() -> Self {
            Self
        }
        pub fn read(&self) -> Option<f32> {
            None
        }
    }
}
