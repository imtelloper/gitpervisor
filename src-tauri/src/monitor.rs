use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{
    DiskRefreshKind, Disks, Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System,
    UpdateKind,
};
use tauri::State;

use crate::error::{ErrorCode, IpcError};
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
    /// 실제로 측정한 볼륨의 마운트 지점("C:\\", "/" 등) — 툴팁이 드라이브 문자를 지어내지
    /// 않도록 백엔드가 알려준다. 디스크를 못 찾으면 빈 문자열.
    pub storage_mount: String,
}

/// 리소스 모니터 팝업의 프로세스 단위 표본 (태스크 05 §4.1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    /// 실행 파일명 (Windows "chrome.exe", macOS "Google Chrome Helper" 등 — 플랫폼별 basename)
    pub name: String,
    /// 0-100 — cpu_usage()/코어수 정규화(전역 스케일, 작업 관리자 방식)
    pub cpu: f32,
    /// bytes (Process::memory)
    pub ram: u64,
    /// 0-100 — Windows PDH 3D 엔진 pid 집계, 그 외 플랫폼/비대상 프로세스는 null
    pub gpu: Option<f32>,
    /// 프로그램별 합산 행이면 묶인 프로세스 수, 개별 모드에선 null
    pub group_count: Option<u32>,
    /// exe 절대경로 — 아이콘 캐시 키 + "파일 위치 열기". 못 읽으면(시스템 프로세스 등) None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exe_path: Option<String>,
    /// 이번 collect 간격의 디스크 read+write 바이트/초. 측정 불가면 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_bps: Option<u64>,
    /// 그룹 모드에서만 — 묶인 멤버 pid 전체("작업 끝내기"가 앱 전체를 종료).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_pids: Option<Vec<u32>>,
}

/// 팝업이 틱당 커맨드 1개만 폴링하도록 totals까지 실어 보내는 배치 응답 (§3.3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    /// 팝업 헤더 게이지 — 별도 sys_metrics 호출 불필요(배치)
    pub totals: SysMetrics,
    /// 정렬·Top-N 절단 완료
    pub processes: Vec<ProcessSample>,
    /// 절단 전 행 수 — 개별 모드는 전체 프로세스 수, 그룹 모드는 그룹 수
    /// ("… 외 N개" 산술이 표시 행 단위와 맞도록).
    pub total_count: u32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcSortKey {
    Cpu,
    Ram,
    /// Gpu 정렬 시 None(측정 대상 아님)은 항상 뒤로
    Gpu,
    /// Disk(read+write bps) 정렬 — None은 뒤로
    Disk,
}

/// 작업 끝내기 결과 — 종료 성공 수 + 실패(권한 부족·이미 종료 등) pid 목록.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillOutcome {
    pub killed: u32,
    pub failed: Vec<u32>,
    /// 자기보호로 **시도조차 하지 않은** pid — 앱 자신과 앱 번들/설치 폴더 안의 프로세스.
    /// failed(권한 부족)와 성격이 달라 분리한다(프론트 안내 문구가 갈린다).
    pub skipped: Vec<u32>,
}

/// 종료 1단계가 2단계에 넘기는 계획 — 소유 데이터만 담아 **락을 놓고** 정착 대기를 할 수 있게 한다.
#[derive(Debug, Clone)]
pub struct KillPlan {
    /// 자기보호로 시도조차 하지 않은 pid — 그대로 KillOutcome.skipped가 된다.
    skipped: Vec<u32>,
    /// kill()을 쏜 pid — 2단계에서 생존 여부를 재확인할 대상.
    targets: Vec<u32>,
}

/// 근접 폴링(타이틀바 2s + 팝업 2s) 시 PDH·CPU 델타 표본이 겹치지 않게 하는 스로틀 —
/// 이 간격 안의 재호출은 직전 집계 결과를 재사용한다(두 커맨드가 같은 표본 공유,
/// sysinfo MINIMUM_CPU_UPDATE_INTERVAL 200ms 충족 겸용 — 태스크 05 §3.4).
const COLLECT_THROTTLE: Duration = Duration::from_millis(500);

/// 마운트 **목록** 재조회 주기. 목록 조회는 /proc/mounts(또는 드라이브 열거) 전수 파싱 +
/// 마운트마다 statvfs라 폴링(2s)마다 돌리면 네트워크·자동마운트 볼륨에서 수십 ms씩 멎는다.
/// 마운트 구성이 바뀌는 일은 드무니 목록은 60초에 한 번만 갱신하고, 그 사이에는 실제로
/// 표시하는 볼륨 1개만 갱신한다(§P1 리소스 모니터 비용).
const DISK_LIST_TTL: Duration = Duration::from_secs(60);

/// 종료 요청이 실제로 반영될 때까지 주는 정착 시간(Windows TerminateProcess는 비동기).
/// 이 대기 동안 **Monitor 락을 놓는다** — 예전엔 락을 쥔 채 std::thread::sleep 해서
/// 타이틀바·팝업 폴링이 통째로 멈췄다.
const KILL_SETTLE: Duration = Duration::from_millis(80);

pub struct Monitor {
    sys: System,
    gpu: gpu::GpuCounter,
    /// 마운트 목록 — 매 collect마다 `Disks::new_with_refreshed_list()`로 새로 만들지 않고
    /// 구조체가 들고 있는다(§DISK_LIST_TTL).
    disks: Disks,
    /// 마지막 마운트 목록 재조회 시각.
    last_disk_list: Option<Instant>,
    /// 표시 대상 볼륨의 `disks` 내 인덱스 — 목록을 재조회할 때만 다시 고른다.
    disk_idx: Option<usize>,
    /// 마지막 전역 collect(CPU/RAM/디스크/PDH) 시각 — 스로틀 기준점.
    last_collect: Option<Instant>,
    /// 마지막 프로세스 refresh 시각 — 팝업이 폴링할 때만 갱신(타이틀바 단독이면 비용 0).
    last_proc_collect: Option<Instant>,
    /// 직전 전역 집계 캐시 — 스로틀 안 재호출이 그대로 반환.
    totals: Option<SysMetrics>,
    /// 직전 PDH collect의 pid별 GPU(3D) 사용률 — 프로세스 표본에 조인.
    gpu_by_pid: HashMap<u32, f32>,
    /// 직전 프로세스 표본 캐시(개별, 정렬·그룹 전).
    procs: Vec<ProcessSample>,
    /// 직전 refresh에서 본 pid 집합 — 이번에 처음 등장한 프로세스의 disk_usage() 델타는
    /// "생애 누적치"라 초당 환산이 무의미해서(§refresh_procs) 그런 행만 골라내는 데 쓴다.
    seen_pids: HashSet<u32>,
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
            // 비어 있는 상태로 시작 — 첫 collect가 목록을 채운다(생성자에서 statvfs를 돌지 않는다).
            disks: Disks::new(),
            last_disk_list: None,
            disk_idx: None,
            last_collect: None,
            last_proc_collect: None,
            totals: None,
            gpu_by_pid: HashMap::new(),
            procs: Vec::new(),
            seen_pids: HashSet::new(),
        }
    }

    /// 전역 표본(CPU/RAM/디스크/PDH) 수집. 500ms 안의 재호출은 직전 집계를 재사용한다 —
    /// sys_metrics(타이틀바)와 sys_process_snapshot(팝업)이 근접 폴링해도 같은 델타 표본을 공유.
    fn collect(&mut self) {
        if self
            .last_collect
            .map_or(false, |t| t.elapsed() < COLLECT_THROTTLE)
        {
            return;
        }
        self.last_collect = Some(Instant::now());

        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();

        let cpu = self.sys.global_cpu_usage();

        let ram_total = self.sys.total_memory();
        // `total - available_memory()`가 아니라 sysinfo의 used_memory()를 쓴다 — macOS의
        // available_memory()는 사실상 free 페이지(≈0)라 그 뺄셈이 **항상 100%**를 만든다
        // (실측: total 32.0GB, available 0B). used_memory()는 플랫폼별로 올바른 "사용 중"
        // 정의를 쓴다 — macOS는 active+wired+compressed(=활성 상태 보기 수치), Windows는
        // total-available이라 기존 값과 동일하다.
        let ram_used = self.sys.used_memory().min(ram_total);
        let ram = pct(ram_used, ram_total);

        let (storage_total, storage_used, storage_mount) = self.storage();

        // GPU는 같은 PDH collect에서 전역 max와 pid별 값을 동시 산출한다 (§3.4).
        let (gpu, gpu_by_pid) = self.gpu.read();
        self.gpu_by_pid = gpu_by_pid;

        self.totals = Some(SysMetrics {
            cpu,
            gpu,
            ram,
            storage: pct(storage_used, storage_total),
            ram_used,
            ram_total,
            storage_used,
            storage_total,
            storage_mount,
        });
    }

    /// 표시 대상 볼륨의 (total, used, mount 지점).
    ///
    /// 목록 재조회는 DISK_LIST_TTL(60초)에 한 번만 — 그 사이에는 이미 고른 볼륨 **1개만**
    /// storage 갱신(statvfs 1회)한다. 예전에는 매 collect(=2초 폴링)마다
    /// `Disks::new_with_refreshed_list()`로 전 마운트를 다시 훑었다.
    /// 대가: 60초 안에 마운트가 붙거나 빠지면 그만큼 반영이 늦다(게이지 지표라 무해).
    fn storage(&mut self) -> (u64, u64, String) {
        let stale = self
            .last_disk_list
            .map_or(true, |t| t.elapsed() >= DISK_LIST_TTL);
        if stale {
            // 목록 재조회 + 표시 대상 재선정. remove_not_listed_disks=true — 언마운트된
            // 볼륨이 유령으로 남아 선정 후보가 되지 않게 한다.
            // kind(HDD/SSD)·io_usage는 쓰지 않으므로 storage만 요청해 비용을 줄인다.
            self.disks
                .refresh_specifics(true, DiskRefreshKind::nothing().with_storage());
            self.last_disk_list = Some(Instant::now());
            self.disk_idx = pick_disk(&self.disks);
        } else if let Some(i) = self.disk_idx {
            // 목록은 그대로 두고 표시 중인 볼륨의 용량만 갱신(statvfs 1회).
            if let Some(d) = self.disks.list_mut().get_mut(i) {
                d.refresh_specifics(DiskRefreshKind::nothing().with_storage());
            }
        }
        match self.disk_idx.and_then(|i| self.disks.list().get(i)) {
            Some(d) => {
                let total = d.total_space();
                (
                    total,
                    total.saturating_sub(d.available_space()),
                    d.mount_point().display().to_string(),
                )
            }
            None => (0, 0, String::new()),
        }
    }

    pub fn sample(&mut self) -> SysMetrics {
        self.collect();
        self.totals.clone().expect("collect가 totals를 채운다")
    }

    /// 프로세스 표본 수집 — 팝업 폴링 시에만 호출된다. 전역과 별도의 500ms 가드로
    /// 정렬 전환 연타 같은 근접 재호출을 흡수한다(캐시 재사용).
    fn refresh_procs(&mut self) {
        if self
            .last_proc_collect
            .map_or(false, |t| t.elapsed() < COLLECT_THROTTLE)
        {
            return;
        }
        // 디스크 바이트/초 환산용 실측 간격 — 직전 refresh_procs와의 경과 시간.
        // 첫 호출은 기준 간격이 없다(=델타가 아니라 생애 누적치) → 이번 틱은 디스크 측정 불가.
        let first_tick = self.last_proc_collect.is_none();
        let secs = self
            .last_proc_collect
            .map_or(0.0, |t| t.elapsed().as_secs_f64())
            .max(0.001);
        self.last_proc_collect = Some(Instant::now());

        // CPU·메모리에 더해 exe 경로(불변이라 1회만)와 디스크 I/O를 갱신한다. remove_dead=true —
        // 죽은 프로세스를 목록에서 정리해 다음 표본에 유령이 남지 않게 한다.
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .with_cpu()
                .with_memory()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_disk_usage(),
        );

        // Process::cpu_usage()는 코어 1개 기준 %(멀티코어에서 100 초과 가능) —
        // 코어수로 나눠 전역 스케일(작업 관리자 방식)로 정규화한다.
        let ncores = self.sys.cpus().len().max(1) as f32;
        let mut out = Vec::with_capacity(self.sys.processes().len());
        let mut now_pids = HashSet::with_capacity(self.sys.processes().len());
        for (pid, p) in self.sys.processes() {
            let pid = pid.as_u32();
            now_pids.insert(pid);
            // 이번 간격의 read+written(누적이 아닌 델타)을 초당으로 환산.
            // 단 **이번에 처음 본 프로세스**는 그 델타가 곧 생애 누적 I/O라 초당 환산이
            // 터무니없어진다(실측: 첫 틱 1.2 PB/s). 그런 행은 다음 틱까지 측정 불가로 둔다.
            let du = p.disk_usage();
            let bytes = du.read_bytes + du.written_bytes;
            let disk_measurable = !first_tick && self.seen_pids.contains(&pid);
            out.push(ProcessSample {
                pid,
                name: p.name().to_string_lossy().into_owned(),
                cpu: p.cpu_usage() / ncores,
                ram: p.memory(),
                // GPU를 안 쓴 프로세스는 PDH 인스턴스 자체가 없다 → None
                gpu: self.gpu_by_pid.get(&pid).copied(),
                group_count: None,
                exe_path: p.exe().map(|e| e.display().to_string()),
                disk_bps: disk_measurable.then(|| (bytes as f64 / secs) as u64),
                group_pids: None,
            });
        }
        self.procs = out;
        self.seen_pids = now_pids;
    }

    /// 자기보호 대상 판정 — 앱 자신의 pid이거나, 실행 파일이 앱 실행 파일과 같은 디렉터리
    /// (=번들 `Contents/MacOS` · 설치 폴더) 안에 있는 프로세스.
    ///
    /// **한계(macOS)**: WKWebView 렌더러는 `/System/Library/Frameworks/WebKit.framework`
    /// 아래 **공용 XPC 서비스**이고 launchd가 부모(ppid=1)라, 우리 창의 렌더러와 다른 앱의
    /// 렌더러를 경로로도 부모로도 구분할 수 없다(실측: 우리 것과 남의 것 모두 ppid=1,
    /// 동일 exe 경로). 따라서 "프로그램별" 그룹 종료가 동명 프로세스를 앱 경계 너머로 함께
    /// 잡는 것은 여기서 막지 못한다 — 프론트 확인 모달이 대상 pid를 그대로 보여 사용자가
    /// 판단하게 한다.
    fn is_self_owned(&self, raw: u32, self_pid: u32, own_dir: Option<&Path>) -> bool {
        if raw == self_pid {
            return true;
        }
        let Some(dir) = own_dir else { return false };
        self.sys
            .process(Pid::from_u32(raw))
            .and_then(|p| p.exe())
            .and_then(|e| e.parent())
            .is_some_and(|d| d == dir)
    }

    /// pid 목록을 종료한다(작업 끝내기) — **1단계**. 자기보호 대상을 걸러내고 나머지에 kill()을 쏜다.
    /// 성공 판정은 kill() 반환값이 아니라 **실제로 사라졌는지**로 한다(→ [`Monitor::kill_finish`]) —
    /// 그룹 종료 시 부모를 죽이면 자식이 연쇄 종료돼 개별 kill()이 false를 줘도 목표(프로세스 없음)는
    /// 달성되기 때문.
    ///
    /// 1·2단계로 쪼갠 이유: 그 사이의 정착 대기(KILL_SETTLE)를 **락 밖에서** 하기 위해서다.
    /// 반환하는 KillPlan은 전부 소유 데이터라 락을 놓고 들고 있을 수 있다.
    pub fn kill_begin(&mut self, pids: &[u32]) -> KillPlan {
        let self_pid = std::process::id();
        let own_dir: Option<PathBuf> = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let all: Vec<Pid> = pids.iter().map(|&p| Pid::from_u32(p)).collect();
        // 최신 상태(존재·핸들·exe 경로)로 갱신 후 자기보호 대상을 걸러낸다.
        // exe는 자기보호 판정에 필요하므로 여기서만 함께 읽는다(OnlyIfNotSet — 캐시되면 무비용).
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&all),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );

        let mut skipped = Vec::new();
        let mut targets = Vec::new();
        for &raw in pids {
            if self.is_self_owned(raw, self_pid, own_dir.as_deref()) {
                skipped.push(raw);
            } else {
                targets.push(raw);
            }
        }

        // 현재 살아있는 것들만 종료 시도.
        for &raw in &targets {
            if let Some(p) = self.sys.process(Pid::from_u32(raw)) {
                p.kill();
            }
        }
        KillPlan { skipped, targets }
    }

    /// **2단계** — 정착 대기 뒤 재조회해 아직 살아있는 것만 실패(진짜 권한 부족)로 돌려준다.
    pub fn kill_finish(&mut self, plan: KillPlan) -> KillOutcome {
        let KillPlan { skipped, targets } = plan;
        let pids: Vec<Pid> = targets.iter().map(|&p| Pid::from_u32(p)).collect();
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing(),
        );
        let mut killed = 0u32;
        let mut failed = Vec::new();
        for (&raw, pid) in targets.iter().zip(&pids) {
            // 좀비(<defunct>)는 프로세스 테이블에 남아 있어 "아직 살아있다"로 오판되기 쉽다.
            // 종료 목적은 달성됐으므로 좀비도 killed로 센다.
            let alive = self
                .sys
                .process(*pid)
                .is_some_and(|p| p.status() != ProcessStatus::Zombie);
            if alive {
                failed.push(raw);
            } else {
                killed += 1;
            }
        }
        KillOutcome {
            killed,
            failed,
            skipped,
        }
    }

    /// 팝업용 프로세스 스냅샷 — Rust에서 그룹 합산·정렬·Top-N 절단까지 끝내 보낸다 (§3.3).
    pub fn snapshot(
        &mut self,
        sort_by: ProcSortKey,
        limit: u32,
        group_by_name: bool,
    ) -> ProcessSnapshot {
        self.collect();
        self.refresh_procs();
        let totals = self.totals.clone().expect("collect가 totals를 채운다");
        let limit = limit as usize;
        let (processes, total_count) = if group_by_name {
            // 그룹 모드는 이미 이름 단위로 접혀(수백 → 수십) 있어 그대로 정렬·절단한다.
            let mut rows = group_samples(&self.procs, sort_by);
            sort_samples(&mut rows, sort_by);
            let total = rows.len() as u32;
            rows.truncate(limit);
            (rows, total)
        } else {
            // 개별 모드는 전체(수백 개)를 clone 하면 **표시하지도 않을 행**의 String 두 개
            // (name·exe_path)까지 매 틱(2초) 복제된다 — 프로세스가 많을수록 비싸지는,
            // 정확히 "관측이 관측 대상을 무겁게 하는" 비용. 인덱스만 정렬해 상위 limit개만 clone.
            (top_n(&self.procs, sort_by, limit), self.procs.len() as u32)
        };
        ProcessSnapshot {
            totals,
            processes,
            total_count,
        }
    }
}

/// 정렬 기준 지표값 — Gpu/Disk에서 None은 항상 최소(뒤로).
fn metric(r: &ProcessSample, key: ProcSortKey) -> f64 {
    match key {
        ProcSortKey::Cpu => r.cpu as f64,
        ProcSortKey::Ram => r.ram as f64,
        ProcSortKey::Gpu => r.gpu.map_or(-1.0, |g| g as f64),
        ProcSortKey::Disk => r.disk_bps.map_or(-1.0, |d| d as f64),
    }
}

/// 내림차순 비교자. Gpu 기준일 때 gpu=None(측정 대상 아님)은 항상 뒤로 보낸다.
///
/// 동률은 cpu → ram → pid로 확정한다(결정론). 이게 없으면 **GPU 미지원 플랫폼
/// (macOS/Linux)에서 모든 행의 gpu가 None이라 1차 비교가 전부 Equal**이 되고, 안정 정렬은
/// 입력 순서 — 즉 sysinfo `processes()`의 HashMap 순회 순서 — 를 그대로 남긴다. 그 상태로
/// Top-N을 자르면 매 틱 임의의 N개가 뽑혀 목록이 2초마다 무의미하게 뒤바뀐다.
/// Disk/Gpu의 None끼리도 마찬가지라 같은 폴백이 필요하다.
///
/// pid까지 내려가면 전순서(total order)라, 값 정렬이든 인덱스 정렬이든 결과가 같다
/// (top_n이 sort_samples와 동일한 순서를 내는 근거).
fn cmp_samples(a: &ProcessSample, b: &ProcessSample, key: ProcSortKey) -> std::cmp::Ordering {
    let primary = match key {
        ProcSortKey::Cpu => b.cpu.total_cmp(&a.cpu),
        ProcSortKey::Ram => b.ram.cmp(&a.ram),
        ProcSortKey::Gpu => match (a.gpu, b.gpu) {
            (Some(x), Some(y)) => y.total_cmp(&x),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        },
        ProcSortKey::Disk => b.disk_bps.cmp(&a.disk_bps),
    };
    primary
        .then_with(|| b.cpu.total_cmp(&a.cpu))
        .then_with(|| b.ram.cmp(&a.ram))
        .then_with(|| a.pid.cmp(&b.pid))
}

/// 제자리 내림차순 정렬(그룹 모드 · 테스트용).
fn sort_samples(rows: &mut [ProcessSample], key: ProcSortKey) {
    rows.sort_by(|a, b| cmp_samples(a, b, key));
}

/// 정렬 후 **상위 limit개만** 복제한다 — 전체 Vec을 clone 한 뒤 truncate 하지 않는다.
/// 인덱스(usize)만 정렬하므로 표시하지 않을 행의 String 복제가 사라진다.
fn top_n(rows: &[ProcessSample], key: ProcSortKey, limit: usize) -> Vec<ProcessSample> {
    let mut idx: Vec<usize> = (0..rows.len()).collect();
    idx.sort_by(|&a, &b| cmp_samples(&rows[a], &rows[b], key));
    idx.truncate(limit);
    idx.into_iter().map(|i| rows[i].clone()).collect()
}

/// 표시 대상 볼륨의 인덱스를 고른다 — 시스템 볼륨을 마운트 지점으로 직접 지목(Windows `C:\`,
/// 유닉스 `/`). "가장 큰 디스크" 단독 폴백은 위험하다 — macOS엔 `C:\`가 없어 항상 폴백을 타는데,
/// 외장 USB나 마운트된 DMG가 내장 디스크보다 크면 게이지가 조용히 그쪽으로 옮겨간다
/// (실측: 3.7TB 외장이 뽑혀 4.9%로 표시, 실제 시스템 디스크는 ~91% 사용).
/// 그래서 폴백도 착탈식(is_removable)을 먼저 제외한다.
fn pick_disk(disks: &Disks) -> Option<usize> {
    let root = Path::new(if cfg!(windows) { "C:\\" } else { "/" });
    let list = disks.list();
    list.iter()
        .position(|d| d.mount_point() == root)
        .or_else(|| {
            list.iter()
                .enumerate()
                .filter(|(_, d)| !d.is_removable())
                .max_by_key(|(_, d)| d.total_space())
                .map(|(i, _)| i)
        })
        .or_else(|| {
            list.iter()
                .enumerate()
                .max_by_key(|(_, d)| d.total_space())
                .map(|(i, _)| i)
        })
}

/// 같은 이름 프로세스 합산("프로그램별" 보기) — cpu·ram·gpu·disk는 합(gpu는 100 캡),
/// pid는 정렬 기준 값이 가장 큰 최대 기여자, group_count는 묶인 프로세스 수, group_pids는
/// 묶인 pid 전체("작업 끝내기"가 앱 전체를 종료) (§4.1).
fn group_samples(rows: &[ProcessSample], key: ProcSortKey) -> Vec<ProcessSample> {
    struct Acc {
        out: ProcessSample,
        pids: Vec<u32>,
        /// 최대 기여자 판정용 — 지금까지의 개별(비합산) 최대 지표값.
        best: f64,
    }
    let mut by_name: HashMap<String, Acc> = HashMap::new();
    for r in rows {
        let m = metric(r, key);
        match by_name.get_mut(&r.name) {
            None => {
                let mut out = r.clone();
                out.group_count = Some(1);
                by_name.insert(
                    r.name.clone(),
                    Acc {
                        out,
                        pids: vec![r.pid],
                        best: m,
                    },
                );
            }
            Some(acc) => {
                acc.out.cpu += r.cpu;
                acc.out.ram += r.ram;
                acc.out.disk_bps = Some(
                    acc.out.disk_bps.unwrap_or(0) + r.disk_bps.unwrap_or(0),
                );
                // 하나라도 측정값이 있으면 합산(100 캡), 전부 None이면 None 유지.
                acc.out.gpu = match (acc.out.gpu, r.gpu) {
                    (None, None) => None,
                    (a, b) => Some((a.unwrap_or(0.0) + b.unwrap_or(0.0)).min(100.0)),
                };
                acc.out.group_count = Some(acc.out.group_count.unwrap_or(1) + 1);
                acc.pids.push(r.pid);
                if m > acc.best {
                    acc.best = m;
                    acc.out.pid = r.pid;
                    // 최대 기여자의 exe 경로를 대표로(아이콘·파일 위치가 그 프로세스 기준).
                    acc.out.exe_path = r.exe_path.clone();
                }
            }
        }
    }
    by_name
        .into_values()
        .map(|mut a| {
            a.out.group_pids = Some(a.pids);
            a.out
        })
        .collect()
}

fn pct(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        (used as f64 / total as f64 * 100.0) as f32
    }
}

/// 타이틀바가 ~2초 간격으로 폴링하는 시스템 사용률.
///
/// **`(async)`인 이유**: 동기 `#[tauri::command]`는 UI 이벤트 루프(GTK/Win32 메인 스레드)에서
/// 실행된다. 이 커맨드는 /proc·statvfs·PDH를 훑으므로 프로세스가 늘수록 비용이 선형으로 커지고,
/// 그 지연이 그대로 창 렌더 지연이 된다 — 누수를 보려고 켠 창이 누수의 대가를 가장 크게 치르는
/// 구조였다(2026-08 OOM 사후조치 P1). 시그니처(이름·인자)는 그대로라 invoke_handler·프론트는
/// 손댈 필요가 없다.
#[tauri::command(async)]
pub fn sys_metrics(state: State<'_, AppState>) -> SysMetrics {
    state.monitor.lock().unwrap().sample()
}

/// 리소스 모니터 팝업이 ~2초 간격으로 폴링하는 프로세스 스냅샷. sys_metrics와 같은
/// Monitor 뮤텍스를 공유하며, PDH collect·CPU refresh는 500ms 스로틀 캐시로 이중 호출 무해화.
/// `(async)` 근거는 sys_metrics와 동일 — 전 PID `/proc` 순회는 UI 스레드에서 돌면 안 된다.
#[tauri::command(async)]
pub fn sys_process_snapshot(
    state: State<'_, AppState>,
    sort_by: ProcSortKey,
    limit: u32,
    group_by_name: bool,
) -> ProcessSnapshot {
    state
        .monitor
        .lock()
        .unwrap()
        .snapshot(sort_by, limit, group_by_name)
}

/// 작업 끝내기 — pid 목록을 종료한다. 프론트가 파괴적 확인을 거친 뒤 호출한다.
/// 실패 pid가 있으면(권한 부족·이미 종료) 그대로 반환해 프론트가 토스트로 안내한다.
///
/// 정착 대기는 `tokio::time::sleep`으로 **락을 놓고** 기다린다 — 예전엔 UI 스레드에서
/// `std::thread::sleep(80ms)`을 Monitor 락을 쥔 채 돌려 창 자체가 그동안 멈췄다.
#[tauri::command]
pub async fn kill_processes(
    state: State<'_, AppState>,
    pids: Vec<u32>,
) -> Result<KillOutcome, IpcError> {
    if pids.is_empty() {
        return Err(IpcError::new(
            ErrorCode::Io,
            "종료할 프로세스가 없습니다",
        ));
    }
    // 앱 자신·앱 번들 안 프로세스 제외는 kill_begin이 exe 경로를 보고 판정한다(skipped).
    // 락 스코프를 블록으로 명시한다 — MutexGuard가 await를 넘어가면 future가 Send가 아니게 되고
    // (컴파일 에러), 넘어가지 않더라도 대기 동안 폴링을 막는다.
    let plan = {
        let mut mon = state.monitor.lock().unwrap();
        mon.kill_begin(&pids)
    };
    tokio::time::sleep(KILL_SETTLE).await;
    let outcome = {
        let mut mon = state.monitor.lock().unwrap();
        mon.kill_finish(plan)
    };
    Ok(outcome)
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

    /// "pid_1234_luid_…"에서 프로세스 id를 파싱 — 인스턴스명 형식은 read()의 주석 참고.
    fn parse_pid(name: &str) -> Option<u32> {
        name.strip_prefix("pid_")?.split('_').next()?.parse().ok()
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

        /// 한 번의 PDH collect에서 (전역 max, pid별 max-over-engines)를 동시 산출한다.
        /// pid별 값은 해당 프로세스 3D 엔진 사용률의 최댓값 — 작업 관리자 GPU 열과 같은 규약.
        pub fn read(&mut self) -> (Option<f32>, std::collections::HashMap<u32, f32>) {
            if !self.ok {
                return (None, std::collections::HashMap::new());
            }
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return (None, std::collections::HashMap::new());
                }
                // 표시 대상 dGPU LUID를 1회 확정(하드웨어는 바뀌지 않음).
                if !self.luid_resolved {
                    self.target_luid = self.resolve_dgpu_luid();
                    self.luid_resolved = true;
                }

                let (buf, count) = match formatted_array(self.engine_counter) {
                    Some(v) => v,
                    None => return (Some(0.0), std::collections::HashMap::new()),
                };
                // 인스턴스는 (프로세스 × 물리 엔진)당 1개. 물리 엔진별로 합산한 뒤
                // 가장 바쁜 엔진을 GPU 사용률로 본다(Task Manager 방식). 전체 합산은
                // 어댑터·엔진이 많아 100%로 과대계상되므로 쓰지 않는다.
                let items = buf.as_ptr() as *const PDH_FMT_COUNTERVALUE_ITEM_W;
                let mut by_engine: std::collections::HashMap<String, f64> =
                    std::collections::HashMap::new();
                let mut by_pid: std::collections::HashMap<u32, f64> =
                    std::collections::HashMap::new();
                for i in 0..count as usize {
                    let item = &*items.add(i);
                    if item.FmtValue.CStatus != PDH_CSTATUS_VALID_DATA {
                        continue;
                    }
                    let name = read_pwstr(item.szName);
                    // dGPU를 식별했으면 그 어댑터의 엔진만 집계(iGPU·기타 어댑터 제외).
                    // pid별 집계에도 같은 필터 — 전역 지표와 수치 일관성 유지 (§3.4).
                    if let Some(target) = self.target_luid {
                        if parse_luid(&name) != Some(target) {
                            continue;
                        }
                    }
                    let v = item.FmtValue.Anonymous.doubleValue;
                    // "pid_… luid_… phys_… eng_… engtype_…" — luid 이후가 물리 엔진 식별자
                    let key = name
                        .find("luid_")
                        .map(|i| name[i..].to_string())
                        .unwrap_or_else(|| name.clone());
                    *by_engine.entry(key).or_insert(0.0) += v;
                    // pid별: 해당 pid의 3D 엔진 중 최댓값. GPU를 안 쓴 프로세스는
                    // 인스턴스 자체가 없어 맵에 생기지 않는다(→ 프론트 null).
                    if let Some(pid) = parse_pid(&name) {
                        let e = by_pid.entry(pid).or_insert(0.0);
                        if v > *e {
                            *e = v;
                        }
                    }
                }
                let max = by_engine.values().copied().fold(0.0f64, f64::max);
                let by_pid = by_pid
                    .into_iter()
                    .map(|(pid, v)| (pid, v.min(100.0) as f32))
                    .collect();
                (Some(max.min(100.0) as f32), by_pid)
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
        /// 비Windows는 전역·프로세스별 GPU 모두 미지원 — (None, 빈 맵). 후속(태스크 05 §3.4).
        pub fn read(&mut self) -> (Option<f32>, std::collections::HashMap<u32, f32>) {
            (None, std::collections::HashMap::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(pid: u32, name: &str, cpu: f32, ram: u64, gpu: Option<f32>) -> ProcessSample {
        ProcessSample {
            pid,
            name: name.to_string(),
            cpu,
            ram,
            gpu,
            group_count: None,
            exe_path: None,
            disk_bps: None,
            group_pids: None,
        }
    }

    /// 그룹 합산 계약(§4.1): cpu·ram·gpu 합(gpu 100 캡), pid=최대 기여자, group_count=묶인 수.
    #[test]
    fn group_samples_aggregates_by_name() {
        let rows = vec![
            s(10, "chrome.exe", 5.0, 100, Some(60.0)),
            s(11, "chrome.exe", 9.0, 200, Some(70.0)),
            s(20, "solo.exe", 1.0, 50, None),
        ];
        let mut out = group_samples(&rows, ProcSortKey::Cpu);
        sort_samples(&mut out, ProcSortKey::Cpu);

        assert_eq!(out.len(), 2);
        let chrome = &out[0];
        assert_eq!(chrome.name, "chrome.exe");
        assert_eq!(chrome.pid, 11); // cpu 최대 기여자
        assert!((chrome.cpu - 14.0).abs() < 1e-6);
        assert_eq!(chrome.ram, 300);
        assert_eq!(chrome.gpu, Some(100.0)); // 60+70=130 → 100 캡
        assert_eq!(chrome.group_count, Some(2));

        let solo = &out[1];
        assert_eq!(solo.gpu, None); // 전부 None이면 None 유지
        assert_eq!(solo.group_count, Some(1));
    }

    /// Gpu 정렬 계약(§4.1): 내림차순, None은 항상 뒤로.
    #[test]
    fn sort_samples_gpu_puts_none_last() {
        let mut rows = vec![
            s(1, "a.exe", 90.0, 1, None),
            s(2, "b.exe", 0.0, 2, Some(5.0)),
            s(3, "c.exe", 0.0, 3, Some(80.0)),
        ];
        sort_samples(&mut rows, ProcSortKey::Gpu);
        let pids: Vec<u32> = rows.iter().map(|r| r.pid).collect();
        assert_eq!(pids, vec![3, 2, 1]);
    }

    /// GPU 미지원 플랫폼(macOS/Linux) 계약: 전 행 gpu=None이면 1차 비교가 모두 Equal이라
    /// 입력 순서(sysinfo HashMap 순회 = 매 틱 임의)가 그대로 남으면 안 된다. cpu→ram→pid
    /// 폴백으로 **입력 순서와 무관하게 같은 결과**가 나와야 Top-N 절단이 안정적이다.
    #[test]
    fn sort_samples_gpu_all_none_is_deterministic() {
        let mk = || {
            vec![
                s(30, "c", 1.0, 10, None),
                s(10, "a", 5.0, 30, None),
                s(20, "b", 1.0, 20, None),
            ]
        };
        let mut rows = mk();
        sort_samples(&mut rows, ProcSortKey::Gpu);
        // cpu 내림차순(5.0) → 동률(1.0)은 ram 내림차순(20 > 10)
        assert_eq!(rows.iter().map(|r| r.pid).collect::<Vec<_>>(), vec![10, 20, 30]);

        // 입력 순서를 뒤집어도 같은 결과여야 한다.
        let mut reversed = mk();
        reversed.reverse();
        sort_samples(&mut reversed, ProcSortKey::Gpu);
        assert_eq!(
            reversed.iter().map(|r| r.pid).collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
    }

    /// cpu·ram까지 완전 동률이면 pid로 확정한다(틱 간 순서 흔들림 방지).
    #[test]
    fn sort_samples_full_tie_falls_back_to_pid() {
        let mut rows = vec![s(9, "x", 0.0, 0, None), s(3, "y", 0.0, 0, None)];
        sort_samples(&mut rows, ProcSortKey::Cpu);
        assert_eq!(rows.iter().map(|r| r.pid).collect::<Vec<_>>(), vec![3, 9]);
    }

    /// 전체 clone → 정렬 → truncate 를 "인덱스 정렬 → 상위 N만 clone"으로 바꿨다.
    /// 결과 순서가 예전 방식과 **모든 정렬 키에서** 같아야 한다(순수 최적화라는 증명).
    #[test]
    fn top_n_matches_sort_then_truncate() {
        let rows = vec![
            s(1, "a", 3.0, 300, Some(10.0)),
            s(2, "b", 3.0, 100, None),
            s(3, "c", 9.0, 200, Some(50.0)),
            s(4, "d", 0.0, 900, Some(50.0)),
            s(5, "e", 3.0, 300, None),
        ];
        for key in [
            ProcSortKey::Cpu,
            ProcSortKey::Ram,
            ProcSortKey::Gpu,
            ProcSortKey::Disk,
        ] {
            for limit in [0usize, 1, 3, 5, 99] {
                let mut expect = rows.clone();
                sort_samples(&mut expect, key);
                expect.truncate(limit);
                let got = top_n(&rows, key, limit);
                assert_eq!(
                    got.iter().map(|r| r.pid).collect::<Vec<_>>(),
                    expect.iter().map(|r| r.pid).collect::<Vec<_>>(),
                    "limit={limit}"
                );
            }
        }
    }

    /// 디스크 캐시 계약: 첫 호출이 목록을 훑고 볼륨을 고르면, TTL 안의 재호출은
    /// **목록을 다시 훑지 않으면서도** 같은 볼륨의 값을 준다.
    /// (인덱스 관리를 틀리면 두 번째 호출이 0/빈 마운트를 돌려주거나 매번 재열거한다.)
    #[test]
    fn storage_reuses_disk_list_within_ttl() {
        let mut m = Monitor::new();
        let first = m.storage();
        let listed_at = m.last_disk_list;
        assert!(listed_at.is_some(), "첫 호출이 목록을 채워야 한다");

        let second = m.storage();
        assert_eq!(m.last_disk_list, listed_at, "TTL 안인데 목록을 다시 훑었다");
        assert_eq!(first.2, second.2, "표시 볼륨이 바뀌었다");
        assert_eq!(first.0, second.0, "총 용량이 바뀌었다");
    }

    /// Top-N 절단은 표시할 행만 복제한다 — 입력이 몇 개든 결과 길이는 limit 이하.
    #[test]
    fn top_n_clones_at_most_limit_rows() {
        let rows: Vec<ProcessSample> = (0..500)
            .map(|i| s(i, "p", i as f32, i as u64, None))
            .collect();
        assert_eq!(top_n(&rows, ProcSortKey::Cpu, 10).len(), 10);
        // cpu 내림차순이라 가장 큰 pid부터.
        assert_eq!(top_n(&rows, ProcSortKey::Cpu, 3)[0].pid, 499);
    }
}
