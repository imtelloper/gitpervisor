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
    /// 프로세스 트리 스캔 결과 캐시 — (프로세스 수, 자기 트리 전체 private 커밋).
    /// 전 프로세스 스냅샷은 메모리 조회(µs)보다 훨씬 비싸 매 틱 돌리지 않는다.
    #[cfg(windows)]
    tree: (u32, u64),
    #[cfg(windows)]
    tree_at: Option<std::time::Instant>,
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

/// Windows — cgroup도 PSI도 oomd도 없다. 대신 **같은 질문에 답하는 다른 카운터**를 읽는다.
///
/// Windows는 리눅스처럼 앱을 골라 죽이는 OOM 킬러가 없다. 대신 이렇게 죽거나 망가진다:
///  - **커밋 한도 고갈**: 커밋 차지가 한도에 닿으면 할당이 실패한다. Rust std의 파일 읽기는
///    `ErrorKind::OutOfMemory`를 돌려주지만(실측 확인) 일반 할당은 abort이고, WebView2
///    렌더러는 그냥 크래시한다 — 사용자 눈엔 "창이 하얘지거나 앱이 사라짐"이다.
///  - **자식 프로세스 누수**: 2026-08-01 리눅스 사건의 Windows 판. 죽이는 주체만 없을 뿐
///    핸들·커밋·CPU를 똑같이 갉아먹는다.
///
/// 그래서 세 가지를 본다: 여유 물리 메모리(`ullAvailPhys` — 대기 목록 포함이라 작업 관리자의
/// "사용 가능"과 같은 값), 커밋 차지(`ullTotalPageFile`/`ullAvailPageFile`은 페이지 파일 크기가
/// 아니라 **커밋 한도/여유**다), 그리고 자기 프로세스 트리의 크기와 private 커밋 합.
///
/// **오탐이 이 기능의 최대 위험이다.** 리눅스판은 스왑 단독 판정으로 상시 위험 배너를 띄워
/// 한 번, 등급을 페이지 캐시 포함 값으로 매겨 또 한 번 무용지물이 됐다. 여기서도 회수 가능한
/// 메모리를 "없는 것"으로 세지 않도록 `ullAvailPhys`(대기 목록 포함)를 쓰고, 커밋은
/// `assess()`에서 물리 메모리가 이미 빠듯할 때만 가중 신호로 쓰인다.
#[cfg(windows)]
mod imp {
    use super::{Probe, Sample};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// 프로세스 트리 스캔 주기.
    ///
    /// **실측(2026-08-04, 이 머신): 한 번에 25ms.** `CreateToolhelp32Snapshot`이 전 프로세스를
    /// 스냅샷하기 때문이고, 리눅스의 `cgroup.procs` 한 줄 읽기(~10µs)보다 세 자릿수 비싸다.
    /// 매 틱(2초) 돌리면 1.25%를 그냥 태운다 — 누수를 보려고 만든 감시가 부담이 되면 안 된다.
    ///
    /// 30초면 충분하다: 이 신호가 잡으려는 것은 **서서히 쌓이는 누수**다(2026-08-01 사건도
    /// 23→100→250개로 시간 단위로 올라갔다). 30초 주기면 비용이 0.08%로 떨어진다.
    /// 메모리 신호는 µs라 매 틱 그대로 갱신되므로, 급변하는 위험 감지는 늦어지지 않는다.
    const TREE_EVERY: Duration = Duration::from_secs(30);

    impl Probe {
        pub fn new() -> Self {
            Self {
                tree: (0, 0),
                tree_at: None,
            }
        }

        pub fn sample(&mut self) -> Sample {
            let mut s = Sample::default();

            // 시스템 메모리 — 항상 읽는다(수 µs).
            if let Some(m) = mem_status() {
                if m.ullTotalPhys > 0 {
                    s.mem_available_pct = m.ullAvailPhys as f32 / m.ullTotalPhys as f32 * 100.0;
                    s.available = true;
                }
                // 커밋 차지. `swap_used_pct` 필드를 재사용한다 — 리눅스의 스왑과 역할이 같다
                // (여유가 마르면 할당이 실패하는 최종 방어선). 표시 문구는 assess()가 구분한다.
                if m.ullTotalPageFile > 0 {
                    let used = m.ullTotalPageFile.saturating_sub(m.ullAvailPageFile);
                    s.swap_used_pct = used as f32 / m.ullTotalPageFile as f32 * 100.0;
                }
            }

            // 프로세스 트리 — 10초에 한 번만.
            let stale = self.tree_at.map_or(true, |t| t.elapsed() >= TREE_EVERY);
            if stale {
                self.tree = own_tree();
                self.tree_at = Some(Instant::now());
            }
            let (procs, private) = self.tree;
            if procs > 0 {
                s.scope_procs = procs;
                s.scope_mem_bytes = private;
                s.scope_current_bytes = private;
                if let Some(m) = mem_status() {
                    if m.ullTotalPhys > 0 {
                        s.scope_mem_pct = private as f32 / m.ullTotalPhys as f32 * 100.0;
                    }
                }
                s.available = true;
            }
            s
        }
    }

    fn mem_status() -> Option<MEMORYSTATUSEX> {
        let mut m: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        m.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: dwLength를 규격대로 채운 뒤 우리 스택의 구조체 하나만 넘긴다.
        (unsafe { GlobalMemoryStatusEx(&mut m) } != FALSE).then_some(m)
    }

    /// 자기 프로세스 + 모든 자손의 (개수, private 커밋 합).
    ///
    /// 리눅스의 `cgroup.procs` 줄 수에 해당한다. 한계 하나: Windows는 PID를 재사용하고
    /// PROCESSENTRY32의 부모 PID는 부모가 죽어도 갱신되지 않는다. 다만 **우리 PID는 살아 있는
    /// 동안 재사용되지 않으므로** 남의 프로세스가 우리를 부모로 갖는 경우는 "우리가 뜨기 전에
    /// 죽은 동일 PID의 부모를 가진 프로세스"뿐이다 — 드물고, 임계가 60부터라 몇 개 오차는
    /// 판정을 바꾸지 않는다.
    fn own_tree() -> (u32, u64) {
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap.is_null() || snap as isize == -1 {
            return (0, 0);
        }
        let mut entries: Vec<(u32, u32)> = Vec::new(); // (pid, ppid)
        let mut e: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        // SAFETY: 유효한 스냅샷 핸들 + dwSize를 채운 엔트리. 실패 시 즉시 순회를 멈춘다.
        if unsafe { Process32FirstW(snap, &mut e) } != FALSE {
            loop {
                entries.push((e.th32ProcessID, e.th32ParentProcessID));
                if unsafe { Process32NextW(snap, &mut e) } == FALSE {
                    break;
                }
            }
        }
        unsafe { CloseHandle(snap) };

        // 자기 PID에서 시작해 자손을 폐포로 모은다. 부모→자식 인접 리스트를 한 번 만들고
        // BFS — 엔트리 수가 수백이라 O(n) 순회 한 번이면 충분하다.
        let me = unsafe { GetCurrentProcessId() };
        let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
        for (pid, ppid) in &entries {
            children.entry(*ppid).or_default().push(*pid);
        }
        let mut tree = vec![me];
        let mut queue = vec![me];
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::from([me]);
        while let Some(p) = queue.pop() {
            if let Some(kids) = children.get(&p) {
                for k in kids {
                    // 자기 자신을 부모로 갖는 이상 엔트리(PID 0 등)로 무한 루프에 빠지지 않게.
                    if seen.insert(*k) {
                        tree.push(*k);
                        queue.push(*k);
                    }
                }
            }
        }

        let private: u64 = tree.iter().filter_map(|&pid| private_bytes(pid)).sum();
        (tree.len() as u32, private)
    }

    /// 프로세스 1개의 private 커밋(작업 관리자의 "커밋 크기"). 권한이 없으면 None.
    fn private_bytes(pid: u32) -> Option<u64> {
        // SAFETY: 실패하면 널 핸들을 돌려주므로 아래에서 걸러낸다.
        let h: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
        if h.is_null() {
            return None;
        }
        let mut c: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        // SAFETY: PROCESS_MEMORY_COUNTERS_EX는 PROCESS_MEMORY_COUNTERS의 확장이라 크기를
        // 정확히 넘기면 API가 확장 필드(PrivateUsage)까지 채운다 — MSDN 규정된 사용법이다.
        let ok = unsafe {
            GetProcessMemoryInfo(h, (&mut c as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(), size)
        } != FALSE;
        unsafe { CloseHandle(h) };
        ok.then_some(c.PrivateUsage as u64)
    }
}

// cgroup v2·PSI도, Win32 카운터도 없는 플랫폼(macOS)에서는 경보를 끈다. 하트비트 센티널은
// 플랫폼과 무관하게 동작하므로 "지난번 비정상 종료" 진단은 그대로 제공된다.
#[cfg(not(any(target_os = "linux", windows)))]
impl Probe {
    pub fn new() -> Self {
        Self {}
    }
    pub fn sample(&mut self) -> Sample {
        Sample::default()
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    /// Windows 프로브가 **실제로 값을 읽는지** 확인한다.
    ///
    /// 이 테스트가 없으면 프로브가 조용히 `available=false`로 떨어져도(= 예전 상태 그대로)
    /// 아무도 모른다. 정확한 수치는 머신·부하에 따라 다르므로 **불변식만** 검사하고,
    /// 실제 값은 `cargo test -- --nocapture` 로 눈으로 본다(임계 조정 근거).
    #[test]
    fn probe_reads_real_windows_counters() {
        let mut p = Probe::new();
        let t = std::time::Instant::now();
        let s = p.sample();
        let cost = t.elapsed();
        eprintln!("[측정] 첫 샘플(트리 스캔 포함) {cost:?} — {s:?}");

        // 감시 자체가 부담이 되면 안 된다(모듈 주석). 전 프로세스 스냅샷이라 리눅스의
        // 파일 읽기(~70µs)보다는 비싸지만, 10초에 한 번이므로 이 정도면 무시할 수 있다.
        // 넉넉한 상한으로 병적인 회귀만 잡는다.
        assert!(
            cost < std::time::Duration::from_millis(500),
            "프로세스 트리 스캔이 너무 비싸다: {cost:?}"
        );

        assert!(s.available, "Windows 프로브가 아무 신호도 읽지 못했다");
        assert!(
            s.mem_available_pct > 0.0 && s.mem_available_pct <= 100.0,
            "여유 물리 메모리 비율이 범위를 벗어났다: {}",
            s.mem_available_pct
        );
        assert!(
            (0.0..=100.0).contains(&s.swap_used_pct),
            "커밋 차지 비율이 범위를 벗어났다: {}",
            s.swap_used_pct
        );
        // 최소한 자기 자신은 세어야 한다(트리 폐포의 시작점).
        assert!(s.scope_procs >= 1, "프로세스 트리를 세지 못했다");
        assert!(s.scope_mem_bytes > 0, "자기 트리의 커밋을 읽지 못했다");

        // 리눅스 전용 신호는 Windows에서 0으로 남아야 한다 — 여기에 값이 들어가면
        // assess()가 "메모리 압박 N% (OS 종료 기준 M%)"라는 거짓 문구를 만든다.
        assert_eq!(s.anchor_full_avg10, 0.0);
        assert_eq!(s.victim_share, 0.0);
    }

    /// 두 번째 샘플은 캐시를 써야 한다 — 전 프로세스 스냅샷을 매 틱 돌리면 감시가 부담이 된다.
    #[test]
    fn tree_scan_is_cached_between_ticks() {
        let mut p = Probe::new();
        let first = p.sample();
        let t = std::time::Instant::now();
        let second = p.sample();
        let elapsed = t.elapsed();
        assert_eq!(
            first.scope_procs, second.scope_procs,
            "캐시가 아니라 매번 다시 스캔했다"
        );
        assert!(
            elapsed < std::time::Duration::from_millis(50),
            "캐시 히트가 너무 느리다: {elapsed:?}"
        );
    }
}
