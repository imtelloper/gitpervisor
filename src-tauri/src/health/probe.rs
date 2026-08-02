//! 저비용 메모리 압박 신호 수집 — systemd-oomd와 **같은 입력**을 읽는다.
//!
//! Linux(cgroup v2 + systemd) 사망 규칙은 실측으로 확정돼 있다(`oomctl`):
//!   - `user@<uid>.service`의 memory PSI가 임계(기본 50%)를 20초 넘게 초과하면
//!   - oomd가 그 **하위 cgroup 중 페이지 회수(pgscan) 활동이 가장 큰 것**을 골라
//!   - `cgroup.procs`를 순회하며 전원 SIGKILL 한다.
//!
//! 그래서 이 모듈은 (1) 앵커(user@N.service)의 `memory.pressure`를 읽어 사망선까지 얼마나
//! 남았는지 보고, (2) 자기 scope의 pgscan 증가분 비율로 **자기가 희생자 1순위인지**까지
//! 계산한다. 추정이 아니라 oomd 판정의 미러링이다.
//!
//! 비용(실측): 파일 1개 읽기 ~9µs, 전체 샘플 ~70µs = 2초 주기에서 CPU 0.0035%.
//! 자식 프로세스를 하나도 만들지 않는다 — 프로세스 과다가 병인데 진단기가 프로세스를
//! 만들면 안 된다.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sample {
    /// 앵커 cgroup의 memory PSI `full avg10` (%). oomd가 임계와 비교하는 값.
    pub anchor_full_avg10: f32,
    /// 같은 곳의 `some avg10` (%). full의 선행 지표라 더 일찍 오른다.
    pub anchor_some_avg10: f32,
    /// oomd 사망 임계(%). 읽어낼 수 없으면 기본값 50.
    pub kill_threshold: f32,
    /// 앵커 전체 페이지 회수 중 이 앱 scope의 몫(0~1). 1에 가까울수록 처형 1순위.
    pub victim_share: f32,
    /// 이 앱 scope의 **회수 불가 상주 메모리**(anon + sock + unevictable)와 시스템 대비 비율(%).
    ///
    /// `memory.current`를 쓰면 안 된다 — 그 값의 대부분은 커널이 압박 시 즉시 회수하는 페이지
    /// 캐시다. 실측: 같은 cgroup에서 memory.current 12.5GB(시스템의 40%) 중 11.0GB가 file 캐시이고
    /// 실제 상주는 0.72GB(2.3%)였다. 캐시 기준으로 등급을 매기면 평상시에 계속 위험 배너가 뜬다.
    pub scope_mem_bytes: u64,
    pub scope_mem_pct: f32,
    /// 표시·로깅 참고용 원값(`memory.current`). 등급 판정에는 쓰지 않는다.
    pub scope_current_bytes: u64,
    /// 이 앱 scope의 **살아있는 프로세스 수**.
    ///
    /// 반드시 `cgroup.procs`의 줄 수여야 한다. `pids.current`는 스레드를 세므로 값이 크게
    /// 다르다(실측: 98 vs 14). oomd가 죽이며 보고하는 개수도 `cgroup.procs` 기준이다.
    pub scope_procs: u32,
    /// 시스템 여유 메모리 비율(%)과 스왑 사용률(%).
    pub mem_available_pct: f32,
    pub swap_used_pct: f32,
    /// 신호를 하나도 못 읽었으면 false — 이 환경에서는 경보를 끈다(오탐 방지).
    pub available: bool,
}

pub struct Probe {
    #[cfg(target_os = "linux")]
    own: Option<std::path::PathBuf>,
    #[cfg(target_os = "linux")]
    anchor: Option<std::path::PathBuf>,
    #[cfg(target_os = "linux")]
    last_own_pgscan: u64,
    #[cfg(target_os = "linux")]
    last_anchor_pgscan: u64,
    #[cfg(target_os = "linux")]
    mem_total_kb: u64,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{Probe, Sample};
    use std::path::{Path, PathBuf};

    /// oomd 기본 임계. `/etc/systemd/oomd.conf`가 비어 있으면(대부분) 이 값이 쓰인다.
    /// user@.service 드롭인은 보통 50%로 더 낮춘다 — 확인 불가 시 보수적으로 50을 쓴다.
    const DEFAULT_KILL_THRESHOLD: f32 = 50.0;

    impl Probe {
        pub fn new() -> Self {
            let (own, anchor) = cgroup_paths().unzip();
            Self {
                own,
                anchor,
                last_own_pgscan: 0,
                last_anchor_pgscan: 0,
                mem_total_kb: meminfo_kb("MemTotal").unwrap_or(0),
            }
        }

        pub fn sample(&mut self) -> Sample {
            let mut s = Sample {
                kill_threshold: DEFAULT_KILL_THRESHOLD,
                ..Default::default()
            };

            if let Some(anchor) = &self.anchor {
                if let Some((some, full)) = pressure_avg10(anchor) {
                    s.anchor_some_avg10 = some;
                    s.anchor_full_avg10 = full;
                    s.available = true;
                }
            }

            // pgscan 증가분 비율 = oomd의 희생자 선정 기준.
            let own_pg = self.own.as_deref().and_then(|p| memory_stat(p, "pgscan"));
            let anchor_pg = self
                .anchor
                .as_deref()
                .and_then(|p| memory_stat(p, "pgscan"));
            if let (Some(own_pg), Some(anchor_pg)) = (own_pg, anchor_pg) {
                let d_own = own_pg.saturating_sub(self.last_own_pgscan);
                let d_anchor = anchor_pg.saturating_sub(self.last_anchor_pgscan);
                // 첫 샘플은 기준선만 잡는다(누적값 전체를 비율로 쓰면 왜곡).
                if self.last_anchor_pgscan != 0 && d_anchor > 0 {
                    s.victim_share = (d_own as f32 / d_anchor as f32).clamp(0.0, 1.0);
                }
                self.last_own_pgscan = own_pg;
                self.last_anchor_pgscan = anchor_pg;
            }

            if let Some(own) = &self.own {
                if let Some(bytes) = read_u64(&own.join("memory.current")) {
                    s.scope_current_bytes = bytes;
                    s.available = true;
                }
                // 등급 판정은 회수 불가 상주분으로만 한다(위 필드 주석 참고).
                let anon = memory_stat(own, "anon").unwrap_or(0)
                    + memory_stat(own, "sock").unwrap_or(0)
                    + memory_stat(own, "unevictable").unwrap_or(0);
                if anon > 0 {
                    s.scope_mem_bytes = anon;
                    if self.mem_total_kb > 0 {
                        s.scope_mem_pct = anon as f32 / (self.mem_total_kb as f32 * 1024.0) * 100.0;
                    }
                    s.available = true;
                }
                if let Some(n) = procs_count(own) {
                    s.scope_procs = n;
                    s.available = true;
                }
            }

            if self.mem_total_kb > 0 {
                if let Some(avail) = meminfo_kb("MemAvailable") {
                    s.mem_available_pct = avail as f32 / self.mem_total_kb as f32 * 100.0;
                }
            }
            if let (Some(total), Some(free)) = (meminfo_kb("SwapTotal"), meminfo_kb("SwapFree")) {
                if total > 0 {
                    s.swap_used_pct = (total - free) as f32 / total as f32 * 100.0;
                }
            }
            s
        }
    }

    /// `/proc/self/cgroup` → (자기 scope 경로, `user@<uid>.service` 앵커 경로).
    ///
    /// 앵커가 필요한 이유: oomd 정책(`ManagedOOMMemoryPressure=kill`)은 user@N.service에
    /// 걸려 있고, 압박 판정도 거기서 한다. 자기 scope의 압박만 봐서는 사망 시점을 못 맞춘다.
    fn cgroup_paths() -> Option<(PathBuf, PathBuf)> {
        let raw = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        // cgroup v2는 한 줄: `0::/user.slice/.../app.slice/app-....scope`
        let rel = raw.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
        let root = Path::new("/sys/fs/cgroup");
        let own = root.join(rel.trim_start_matches('/'));

        let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        let idx = parts
            .iter()
            .position(|s| s.starts_with("user@") && s.ends_with(".service"))?;
        let anchor = root.join(parts[..=idx].join("/"));
        Some((own, anchor))
    }

    /// `memory.pressure`의 some/full `avg10`을 (%)로 돌려준다.
    fn pressure_avg10(dir: &Path) -> Option<(f32, f32)> {
        let text = std::fs::read_to_string(dir.join("memory.pressure")).ok()?;
        let pick = |prefix: &str| -> f32 {
            text.lines()
                .find(|l| l.starts_with(prefix))
                .and_then(|l| {
                    l.split_whitespace()
                        .find_map(|f| f.strip_prefix("avg10="))
                        .and_then(|v| v.parse::<f32>().ok())
                })
                .unwrap_or(0.0)
        };
        Some((pick("some"), pick("full")))
    }

    fn memory_stat(dir: &Path, key: &str) -> Option<u64> {
        let text = std::fs::read_to_string(dir.join("memory.stat")).ok()?;
        text.lines().find_map(|l| {
            let mut it = l.split_whitespace();
            (it.next()? == key).then(|| it.next()?.parse::<u64>().ok())?
        })
    }

    fn read_u64(path: &Path) -> Option<u64> {
        std::fs::read_to_string(path).ok()?.trim().parse().ok()
    }

    fn procs_count(dir: &Path) -> Option<u32> {
        let text = std::fs::read_to_string(dir.join("cgroup.procs")).ok()?;
        u32::try_from(text.lines().filter(|l| !l.trim().is_empty()).count()).ok()
    }

    fn meminfo_kb(key: &str) -> Option<u64> {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        text.lines().find_map(|l| {
            let rest = l.strip_prefix(key)?.strip_prefix(':')?;
            rest.split_whitespace().next()?.parse::<u64>().ok()
        })
    }
}

// cgroup v2·PSI가 없는 플랫폼(Windows/macOS)에서는 경보를 끈다. 하트비트 센티널은
// 플랫폼과 무관하게 동작하므로 "지난번 비정상 종료" 진단은 그대로 제공된다.
#[cfg(not(target_os = "linux"))]
impl Probe {
    pub fn new() -> Self {
        Self {}
    }
    pub fn sample(&mut self) -> Sample {
        Sample::default()
    }
}
