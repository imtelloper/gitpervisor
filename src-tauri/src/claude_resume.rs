//! 재시작해도 하던 그대로 — 터미널마다 돌던 Claude Code 세션을 다음 실행에서 이어서 연다(태스크 78,
//! DOCS/task/78-restart-restore.md D1).
//!
//! 실행 중인 Claude 는 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/sessions/<pid>.json` 에 자기 sessionId·cwd 를 두고, 죽으면
//! 지운다. 같은 폴더에 세션이 여럿일 수 있어 cwd 로는 못 가른다 — Claude 프로세스에서 부모를 거슬러 올라가 우리 PTY
//! 셸을 만나는지로 터미널을 정한다. `/resume`·`/clear` 하면 같은 pid 의 sessionId 가 바뀌므로 **살아 있는 동안 주기로**
//! 다시 읽고, 종료 직전(PTY 를 죽이기 전)에 한 번 더 찍는다. 같은 폴더의 `.key` 는 비밀 값이라 열지 않는다.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::claude_usage::claude_config_dir;
use crate::error::IpcError;
use crate::state::AppState;

const RESUME_FILE: &str = "claude-resume.json";
const FILE_VERSION: u32 = 1;
const SNAPSHOT_EVERY: Duration = Duration::from_secs(20);
/// 꺼내 간 뒤 재개 명령(`cd` → `claude --resume`)이 돌아 레지스트리에 다시 나타날 때까지 — 그 사이 스냅샷이
/// "PTY 는 떠 있는데 Claude 가 없다"로 보고 지우지 않게 한다.
const INFLIGHT_TTL: Duration = Duration::from_secs(90);
/// 닫힌 터미널(`forget` 을 못 받은 것)의 찌꺼기 상한.
/// ponytail: 기준이 Claude 의 `updatedAt` 이라 14일 넘게 손대지 않은 채 살아 있던 세션도 재시작 때 빠진다 — 문제 되면 "마지막으로 살아 있음을 본 시각"을 파일에 따로 둔다.
const PENDING_MAX_AGE_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// `pwsh → claude.exe` 1단, npm 설치 `pwsh → cmd → node` 2단, npx 3~4단(실측) — 여유를 둔다.
const MAX_HOPS: usize = 6;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRec {
    pub session_id: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub updated_at_ms: i64,
}

// ── 레지스트리 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegEntry {
    pid: u32,
    session_id: String,
    cwd: String,
    #[serde(default)]
    kind: Option<String>,
    /// Windows 프로세스 생성 FILETIME(100ns, 10진 문자열). Unix 는 `started_at` 으로 신원을 본다.
    #[serde(default)]
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    proc_start: Option<String>,
    #[serde(default)]
    started_at: Option<i64>,
    #[serde(default)]
    updated_at: Option<i64>,
    #[serde(default)]
    name: Option<String>,
}

impl RegEntry {
    fn updated_ms(&self) -> i64 {
        self.updated_at.or(self.started_at).unwrap_or(0)
    }

    fn to_rec(&self) -> ResumeRec {
        ResumeRec {
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone(),
            name: self.name.clone().filter(|n| !n.is_empty()),
            updated_at_ms: self.updated_ms(),
        }
    }
}

fn sessions_dir() -> Option<PathBuf> {
    claude_config_dir().map(|d| d.join("sessions"))
}

/// `-p` 같은 비대화 실행은 이어서 열 대상이 아니다.
fn parse_registry(bytes: &[u8]) -> Option<RegEntry> {
    serde_json::from_slice::<RegEntry>(bytes).ok().filter(|r| r.kind.as_deref() == Some("interactive"))
}

fn read_registry(dir: &Path) -> Vec<RegEntry> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        // Claude Code 를 한 번도 안 띄웠으면 폴더가 없다.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!("[claude-resume] {} 읽기 실패: {e}", dir.display());
            return Vec::new();
        }
    };
    rd.flatten()
        .map(|e| e.path())
        // 확장자가 정확히 `json` 인 `<pid>.json` 만 — 같은 폴더의 `<pid>.<hash>.key` 는 열지도 않는다.
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        // 못 읽거나 깨진 파일은 Claude 가 다시 쓰는 중이다 — 이번 회차만 건너뛰고 다음 회차에 다시 본다.
        .filter_map(|p| std::fs::read(&p).ok())
        .filter_map(|b| parse_registry(&b))
        .collect()
}

// ── 프로세스 신원·계보 ─────────────────────────────────────────────────────

/// 프로세스 표 한 줄. `start` 의 단위는 OS 마다 다르다(Windows FILETIME 100ns · Unix 초) — 같은 표 안에서만 비교한다.
#[derive(Debug, Clone, Copy)]
struct ProcInfo {
    ppid: u32,
    start: u64,
}

/// 레지스트리의 pid 가 지금 그 Claude 인가 — 죽은 Claude 의 파일이 남아 있고 번호가 재사용됐으면 남이다.
#[cfg(windows)]
fn same_process(reg: &RegEntry, start: u64) -> bool {
    filetime_matches(reg.proc_start.as_deref(), start)
}

#[cfg(not(windows))]
fn same_process(reg: &RegEntry, start: u64) -> bool {
    start_secs_match(reg.started_at, start)
}

/// `procStart` 는 `GetProcessTimes` 생성 시각과 정확히 같다(실측 2026-11-06).
#[cfg(any(windows, test))]
fn filetime_matches(proc_start: Option<&str>, filetime: u64) -> bool {
    proc_start.and_then(|s| s.parse::<u64>().ok()) == Some(filetime)
}

/// 프로세스 시작(초)은 Claude 가 적는 `startedAt`(ms)보다 조금 앞선다(node·번들 기동, 실측 ~5초). 60초 넘게 앞서거나
/// 1초 넘게 뒤면 번호만 같은 남이다.
#[cfg(any(not(windows), test))]
fn start_secs_match(started_at_ms: Option<i64>, start_secs: u64) -> bool {
    let Ok(start) = i64::try_from(start_secs) else { return false };
    started_at_ms.is_some_and(|ms| (-60..=1).contains(&(start - ms.div_euclid(1000))))
}

/// 부모를 최대 [`MAX_HOPS`]단 올라가 우리 셸을 만나면 (termId, 단수). 부모가 자식보다 늦게 태어났으면 그 ppid 는 죽은
/// 부모의 번호를 재사용한 남이다(Windows 는 부모가 죽어도 ppid 를 고치지 않는다) — 거기서 멈춘다. tmux·ssh·WSL 너머는
/// 계보가 끊긴다 — 추측으로 잇지 않는다.
fn owning_term<'a>(
    me: (u32, ProcInfo),
    shells: &HashMap<u32, &'a str>,
    table: &dyn Fn(u32) -> Option<ProcInfo>,
) -> Option<(&'a str, usize)> {
    let (mut pid, mut info) = me;
    for hops in 1..=MAX_HOPS {
        let ppid = info.ppid;
        if ppid == 0 || ppid == pid {
            return None;
        }
        let parent = table(ppid)?;
        if parent.start > info.start {
            return None;
        }
        if let Some(&term) = shells.get(&ppid) {
            return Some((term, hops));
        }
        (pid, info) = (ppid, parent);
    }
    None
}

/// 레지스트리 × 프로세스 표 → 터미널별 지금 도는 Claude. 한 터미널에 둘(Claude 안에서 띄운 Claude)이면 셸에 가까운 쪽,
/// 같은 sessionId 가 두 터미널에 잡히면 `updatedAt` 이 최신인 쪽 하나만.
fn map_live(
    regs: &[RegEntry],
    shells: &HashMap<u32, &str>,
    table: &dyn Fn(u32) -> Option<ProcInfo>,
    same: &dyn Fn(&RegEntry, u64) -> bool,
) -> BTreeMap<String, ResumeRec> {
    let mut per_term: HashMap<&str, (usize, &RegEntry)> = HashMap::new();
    for reg in regs {
        let Some(me) = table(reg.pid) else { continue };
        if !same(reg, me.start) {
            continue;
        }
        let Some((term, hops)) = owning_term((reg.pid, me), shells, table) else { continue };
        let closer = per_term
            .get(term)
            .is_none_or(|(h, old)| hops < *h || (hops == *h && reg.updated_ms() > old.updated_ms()));
        if closer {
            per_term.insert(term, (hops, reg));
        }
    }
    let mut by_session: HashMap<&str, (&str, &RegEntry)> = HashMap::new();
    for (term, (_, reg)) in per_term {
        // 동률이면 termId 로 정해 회차마다 같은 답을 낸다(HashMap 순회 순서는 매번 다르다).
        let newer = by_session
            .get(reg.session_id.as_str())
            .is_none_or(|(t, old)| (reg.updated_ms(), term) > (old.updated_ms(), *t));
        if newer {
            by_session.insert(reg.session_id.as_str(), (term, reg));
        }
    }
    by_session.into_values().map(|(t, r)| (t.to_string(), r.to_rec())).collect()
}

#[cfg(windows)]
struct ProcTable {
    ppid: HashMap<u32, u32>,
}

#[cfg(windows)]
impl ProcTable {
    /// Toolhelp 스냅샷 한 번(실측 16ms). 생성 시각은 물어볼 pid 만 따로 연다(회차당 수십 개).
    fn new() -> Self {
        Self {
            ppid: crate::health::probe::process_entries().into_iter().map(|(p, pp, _)| (p, pp)).collect(),
        }
    }

    fn get(&self, pid: u32) -> Option<ProcInfo> {
        Some(ProcInfo { ppid: *self.ppid.get(&pid)?, start: creation_filetime(pid)? })
    }
}

#[cfg(windows)]
fn creation_filetime(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, FILETIME};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    // SAFETY: 실패하면 널 핸들이라 아래에서 거른다. 얻은 핸들은 이 함수 안에서 닫는다.
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
    if h.is_null() {
        return None;
    }
    let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: 유효한 핸들과 쓰기 가능한 FILETIME 네 개.
    let ok = unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) } != FALSE;
    unsafe { CloseHandle(h) };
    ok.then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// Linux·macOS — 물어볼 pid 만 하나씩 갱신한다(시스템 전체를 읽지 않는다). Windows 테스트에서도 컴파일·실행해 API 를 확인한다.
#[cfg(any(not(windows), test))]
struct SysinfoTable(std::cell::RefCell<sysinfo::System>);

#[cfg(any(not(windows), test))]
impl SysinfoTable {
    fn new() -> Self {
        Self(std::cell::RefCell::new(sysinfo::System::new()))
    }

    fn get(&self, pid: u32) -> Option<ProcInfo> {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate};
        let pid = Pid::from_u32(pid);
        let mut sys = self.0.borrow_mut();
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), false, ProcessRefreshKind::nothing());
        let p = sys.process(pid)?;
        Some(ProcInfo { ppid: p.parent().map_or(0, |pp| pp.as_u32()), start: p.start_time() })
    }
}

#[cfg(not(windows))]
type ProcTable = SysinfoTable;

/// 지금 도는 Claude 를 터미널에 붙인다. `terms` = (termId, 셸 pid — 0 은 모름).
fn live_claude_by_term(terms: &[(String, u32)]) -> BTreeMap<String, ResumeRec> {
    let shells: HashMap<u32, &str> = terms.iter().filter(|(_, p)| *p != 0).map(|(t, p)| (*p, t.as_str())).collect();
    if shells.is_empty() {
        return BTreeMap::new();
    }
    let Some(dir) = sessions_dir() else { return BTreeMap::new() };
    let regs = read_registry(&dir);
    if regs.is_empty() {
        return BTreeMap::new();
    }
    let table = ProcTable::new();
    map_live(&regs, &shells, &|pid| table.get(pid), &same_process)
}

/// 이 sessionId 가 지금 어느 Claude 프로세스에서 살아 있는가 — 그러면 다른 터미널에서 또 열면 같은 대화를 둘이 쓴다.
fn session_live_anywhere(session_id: &str) -> bool {
    let Some(dir) = sessions_dir() else { return false };
    let regs: Vec<RegEntry> = read_registry(&dir).into_iter().filter(|r| r.session_id == session_id).collect();
    if regs.is_empty() {
        return false;
    }
    let table = ProcTable::new();
    regs.iter().any(|r| table.get(r.pid).is_some_and(|p| same_process(r, p.start)))
}

// ── 저장 ────────────────────────────────────────────────────────────────────

struct Resume {
    /// None = 데이터 폴더를 못 정함(시작 전·실패) — 계산은 하되 쓰지 않는다.
    path: Option<PathBuf>,
    /// 지난 실행에서 넘어와 아직 안 꺼낸 것(termId → 기록).
    pending: BTreeMap<String, ResumeRec>,
    /// 꺼낸 지 [`INFLIGHT_TTL`] 안 — 재개 명령이 도는 사이.
    inflight: BTreeMap<String, (ResumeRec, Instant)>,
    /// 마지막으로 파일에 쓴 내용 — 같으면 다시 쓰지 않는다.
    written: Option<BTreeMap<String, ResumeRec>>,
    /// 종료 직전 마지막 회차를 찍었다 — 그 뒤 주기 회차는 PTY 가 죽은 뒤라 빈 표로 덮어쓰게 된다.
    frozen: bool,
}

impl Resume {
    const fn new() -> Self {
        Self { path: None, pending: BTreeMap::new(), inflight: BTreeMap::new(), written: None, frozen: false }
    }
}

static RESUME: Mutex<Resume> = Mutex::new(Resume::new());

fn fresh(rec: &ResumeRec, now_ms: i64) -> bool {
    now_ms - rec.updated_at_ms <= PENDING_MAX_AGE_MS
}

/// 스냅샷 = 지금 도는 것 ∪ (재개 중인데 아직 안 뜬 것) ∪ (지난 실행에서 넘어왔는데 PTY 가 아직 안 뜬 터미널).
/// PTY 가 떠 있는데 Claude 가 없으면 뺀다 — 사용자가 Claude 를 끄고 셸로 돌아온 것이다.
/// **세션 하나는 터미널 하나에만** 남긴다(지금 도는 쪽이 이긴다). 안 연 탭 A 에 S1 이 남아 있는데 사용자가 S1 을 다른 터미널 B 에서
/// 이어 열면 둘 다 기록돼, 다음 부팅에 A·B 가 같은 대화를 동시에 `--resume` 한다 — 그때는 둘 다 아직 안 떠서 레지스트리 검사로도 못 막는다.
fn merge_snapshot(
    live: &BTreeMap<String, ResumeRec>,
    open: &HashSet<&str>,
    pending: &BTreeMap<String, ResumeRec>,
    inflight: &BTreeMap<String, (ResumeRec, Instant)>,
    now_ms: i64,
) -> BTreeMap<String, ResumeRec> {
    let mut out = live.clone();
    let mut sessions: HashSet<String> = live.values().map(|r| r.session_id.clone()).collect();
    let carried = inflight
        .iter()
        .map(|(t, (r, _))| (t, r))
        .chain(pending.iter().filter(|(t, r)| !open.contains(t.as_str()) && fresh(r, now_ms)));
    for (term, rec) in carried {
        if !out.contains_key(term) && sessions.insert(rec.session_id.clone()) {
            out.insert(term.clone(), rec.clone());
        }
    }
    out
}

/// 스냅샷 한 회차(락 안). 써야 할 내용이 있으면 돌려준다 — 안 바뀌었거나 이미 동결됐으면 None.
fn snapshot_in(
    st: &mut Resume,
    live: &BTreeMap<String, ResumeRec>,
    open: &HashSet<&str>,
    now: Instant,
    now_ms: i64,
    freeze: bool,
) -> Option<BTreeMap<String, ResumeRec>> {
    if st.frozen {
        return None;
    }
    st.frozen = freeze;
    // 재개가 실제로 떴으면(live 에 잡힘) inflight 는 할 일을 다 했다 — 남겨 두면 사용자가 그 Claude 를 끈 뒤에도 기록이 살아 다음 부팅에 또 연다.
    st.inflight.retain(|t, (_, at)| !live.contains_key(t) && now.duration_since(*at) < INFLIGHT_TTL);
    let merged = merge_snapshot(live, open, &st.pending, &st.inflight, now_ms);
    (st.written.as_ref() != Some(&merged)).then_some(merged)
}

/// 터미널·세션 구성이 같은가 — `updatedAt` 만 바뀐 회차(Claude 가 busy↔idle 할 때마다)는 로그를 남기지 않는다.
fn same_sessions(a: &BTreeMap<String, ResumeRec>, b: &BTreeMap<String, ResumeRec>) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|((ta, ra), (tb, rb))| ta == tb && ra.session_id == rb.session_id)
}

#[derive(Deserialize)]
struct ResumeFileIn {
    version: u32,
    panes: BTreeMap<String, ResumeRec>,
}

fn load_pending_at(path: &Path, now_ms: i64) -> BTreeMap<String, ResumeRec> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        // 첫 실행이거나 이 기능 이전 버전에서 올라왔다.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(e) => {
            log::warn!("[claude-resume] {} 읽기 실패: {e}", path.display());
            return BTreeMap::new();
        }
    };
    match serde_json::from_slice::<ResumeFileIn>(&bytes) {
        Ok(f) if f.version == FILE_VERSION => f.panes.into_iter().filter(|(_, r)| fresh(r, now_ms)).collect(),
        Ok(f) => {
            log::warn!("[claude-resume] {} 모르는 버전 {} — 무시", path.display(), f.version);
            BTreeMap::new()
        }
        // 잃어도 "터미널마다 손으로 다시 켜기"로 돌아갈 뿐이라 격리하지 않는다 — 다음 스냅샷이 덮는다.
        Err(e) => {
            log::warn!("[claude-resume] {} 파싱 실패 — 무시: {e}", path.display());
            BTreeMap::new()
        }
    }
}

fn write_file_at(path: &Path, panes: &BTreeMap<String, ResumeRec>, now_ms: i64) -> std::io::Result<()> {
    let body = serde_json::json!({ "version": FILE_VERSION, "savedAtMs": now_ms, "panes": panes });
    crate::state::save_bytes_at(path, &serde_json::to_vec_pretty(&body)?)
}

fn snapshot(state: &AppState, freeze: bool) {
    let terms = crate::commands::term_shell_pids(state);
    let live = live_claude_by_term(&terms);
    let open: HashSet<&str> = terms.iter().map(|(t, _)| t.as_str()).collect();
    let now_ms = chrono::Utc::now().timestamp_millis();
    // 쓰기까지 락 안에서 한다 — 주기 회차가 종료 회차를 앞질러 덮어쓰지 못하게(동결 판정과 쓰기가 한 덩어리).
    let mut st = RESUME.lock().unwrap_or_else(|e| e.into_inner());
    let Some(merged) = snapshot_in(&mut st, &live, &open, Instant::now(), now_ms, freeze) else {
        // 종료 회차가 남긴 흔적 — 바뀐 게 없어 안 썼어도 "종료 직전에 돌았다"는 건 로그로 남겨야 재개가 안 됐을 때 원인을 가른다.
        if freeze {
            log::info!("[claude-resume] 종료 직전 — 바뀐 것 없음(저장된 {}개 그대로)", st.written.as_ref().map_or(0, BTreeMap::len));
        }
        return;
    };
    let Some(path) = st.path.clone() else { return };
    match write_file_at(&path, &merged, now_ms) {
        Ok(()) => {
            if freeze || st.written.as_ref().is_none_or(|w| !same_sessions(w, &merged)) {
                log::info!("[claude-resume] 저장 {}개(지금 도는 Claude {}개){}", merged.len(), live.len(), if freeze { " — 종료 직전" } else { "" });
            }
            st.written = Some(merged);
        }
        // 다음 회차가 다시 쓴다(written 을 안 바꿨으니 "바뀜"으로 본다).
        Err(e) => log::warn!("[claude-resume] {} 쓰기 실패: {e}", path.display()),
    }
}

/// 부팅 — 지난 실행의 기록을 읽고 주기 스냅샷을 시작한다. `AppState` 를 manage 한 뒤에 부른다.
pub(crate) fn start(app: &AppHandle) {
    let path = crate::state::data_root(app).map(|d| d.join(RESUME_FILE));
    {
        let mut st = RESUME.lock().unwrap_or_else(|e| e.into_inner());
        match &path {
            Some(p) => {
                st.pending = load_pending_at(p, chrono::Utc::now().timestamp_millis());
                log::info!("[claude-resume] 부팅: 이어서 열 세션 {}개", st.pending.len());
            }
            None => log::warn!("[claude-resume] 데이터 폴더를 못 정했습니다 — 이번 실행은 기록하지 않습니다"),
        }
        st.path = path;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("claude-resume".into()).spawn(move || loop {
        std::thread::sleep(SNAPSHOT_EVERY);
        if let Some(state) = app.try_state::<AppState>() {
            snapshot(state.inner(), false);
        }
    });
    if let Err(e) = spawned {
        log::error!("[claude-resume] 스냅샷 스레드 시작 실패 — 종료 직전 기록만 남습니다: {e}");
    }
}

/// `shutdown_children` 맨 앞(PTY 를 죽이기 전) — 동기, 실패는 로그만 남긴다. 이 뒤로는 기록을 바꾸지 않는다.
pub(crate) fn snapshot_for_shutdown(state: &AppState) {
    snapshot(state, true);
}

// ── 커맨드 ──────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
enum SkipReason {
    Disabled,
    CwdMissing,
    LiveElsewhere,
}

#[derive(Debug, PartialEq)]
enum TakeOutcome {
    Nothing,
    Skipped(ResumeRec, SkipReason),
    Resume(ResumeRec),
}

/// 꺼내기는 건너뛸 때도 한다 — 한 번 판정한 기록이 다음 PTY 열기에서 되살아나면 안 된다.
fn take_in(
    st: &mut Resume,
    term_id: &str,
    enabled: bool,
    is_dir: &dyn Fn(&str) -> bool,
    live_elsewhere: &dyn Fn(&str) -> bool,
    now: Instant,
) -> TakeOutcome {
    let Some(rec) = st.pending.remove(term_id) else { return TakeOutcome::Nothing };
    let skip = if !enabled {
        Some(SkipReason::Disabled)
    } else if !is_dir(&rec.cwd) {
        Some(SkipReason::CwdMissing)
    } else if live_elsewhere(&rec.session_id)
        // 다른 터미널이 방금 같은 세션을 꺼내 갔다 — 그쪽 Claude 는 아직 안 떠서 레지스트리엔 없다.
        || st.inflight.iter().any(|(t, (r, _))| t != term_id && r.session_id == rec.session_id)
    {
        Some(SkipReason::LiveElsewhere)
    } else {
        None
    };
    match skip {
        Some(why) => TakeOutcome::Skipped(rec, why),
        None => {
            st.inflight.insert(term_id.to_string(), (rec.clone(), now));
            TakeOutcome::Resume(rec)
        }
    }
}

fn forget_in(st: &mut Resume, term_id: &str) -> bool {
    let pending = st.pending.remove(term_id).is_some();
    st.inflight.remove(term_id).is_some() || pending
}

/// 새로 뜬 PTY 가 이어서 열 Claude 세션을 꺼낸다 — 터미널마다 한 번만 준다(상태를 바꾸므로 프런트는 재시도하지 않는다).
#[tauri::command(async)]
pub fn claude_resume_take(state: State<'_, AppState>, term_id: String) -> Result<Option<ResumeRec>, IpcError> {
    let enabled = state.settings.read().unwrap_or_else(|e| e.into_inner()).resume_claude_on_restart;
    let outcome = {
        let mut st = RESUME.lock().unwrap_or_else(|e| e.into_inner());
        take_in(&mut st, &term_id, enabled, &|cwd: &str| Path::new(cwd).is_dir(), &session_live_anywhere, Instant::now())
    };
    Ok(match outcome {
        TakeOutcome::Nothing => None,
        TakeOutcome::Skipped(rec, why) => {
            log::info!("[claude-resume] {term_id} 건너뜀({why:?}): {} {}", rec.session_id, rec.cwd);
            None
        }
        TakeOutcome::Resume(rec) => {
            log::info!("[claude-resume] {term_id} 이어서 엶: {} {}", rec.session_id, rec.cwd);
            Some(rec)
        }
    })
}

/// 터미널을 영구히 닫았다(`dropPane`) — 남은 기록을 지운다.
#[tauri::command(async)]
pub fn claude_resume_forget(term_id: String) -> Result<(), IpcError> {
    if forget_in(&mut RESUME.lock().unwrap_or_else(|e| e.into_inner()), &term_id) {
        log::info!("[claude-resume] {term_id} 기록 지움");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const S1: &str = "11111111-1111-4111-8111-111111111111";
    const S2: &str = "22222222-2222-4222-8222-222222222222";
    const S3: &str = "33333333-3333-4333-8333-333333333333";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gpv-claude-resume-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn reg(pid: u32, session: &str, start: u64, updated: i64) -> RegEntry {
        RegEntry {
            pid,
            session_id: session.into(),
            cwd: format!("C:\\work\\{pid}"),
            kind: Some("interactive".into()),
            proc_start: Some(start.to_string()),
            started_at: None,
            updated_at: Some(updated),
            name: None,
        }
    }

    fn rec(session: &str, updated: i64) -> ResumeRec {
        ResumeRec { session_id: session.into(), cwd: "C:\\work".into(), name: None, updated_at_ms: updated }
    }

    fn by_start(reg: &RegEntry, start: u64) -> bool {
        filetime_matches(reg.proc_start.as_deref(), start)
    }

    #[test]
    fn claude_resume_registry_reads_interactive_json_only() {
        let dir = temp_dir("registry");
        let body = |pid: u32, kind: &str| {
            format!(
                r#"{{"pid":{pid},"sessionId":"{S1}","cwd":"F:\\gitpervisor","startedAt":1793922958089,"procStart":"134383965533917087",
                "kind":"{kind}","name":"gitpervisor-6b","status":"busy","updatedAt":1793924469893}}"#
            )
        };
        std::fs::write(dir.join("100.json"), body(100, "interactive")).unwrap();
        std::fs::write(dir.join("101.json"), body(101, "print")).unwrap();
        std::fs::write(dir.join("102.json"), format!(r#"{{"pid":102,"sessionId":"{S2}","cwd":"x"}}"#)).unwrap();
        std::fs::write(dir.join("103.json"), &body(103, "interactive")[..40]).unwrap();
        // `.key`·임시 파일은 내용이 멀쩡해도 열지 않는다.
        std::fs::write(dir.join("104.3259b2ad.key"), body(104, "interactive")).unwrap();
        std::fs::write(dir.join("105.json.tmp"), body(105, "interactive")).unwrap();
        std::fs::write(dir.join("106.JSON"), body(106, "interactive")).unwrap();

        let regs = read_registry(&dir);
        let pids: Vec<u32> = regs.iter().map(|r| r.pid).collect();
        assert_eq!(pids, [100], "{pids:?}");
        let r = &regs[0];
        assert_eq!(r.session_id, S1);
        assert_eq!(r.cwd, "F:\\gitpervisor");
        assert_eq!(r.proc_start.as_deref(), Some("134383965533917087"));
        assert_eq!(r.to_rec(), ResumeRec { session_id: S1.into(), cwd: "F:\\gitpervisor".into(), name: Some("gitpervisor-6b".into()), updated_at_ms: 1793924469893 });
        assert!(read_registry(&dir.join("없음")).is_empty(), "폴더가 없으면 0개");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn claude_resume_identity_rejects_reused_pids() {
        assert!(filetime_matches(Some("134383965533917087"), 134383965533917087));
        assert!(!filetime_matches(Some("134383965533917087"), 134383965533917088));
        assert!(!filetime_matches(None, 134383965533917087));
        assert!(!filetime_matches(Some("abc"), 0));
        // 실측: 프로세스 시작이 startedAt 보다 ~5초 앞선다.
        let started = Some(1_793_922_958_089);
        assert!(start_secs_match(started, 1_793_922_953));
        assert!(start_secs_match(started, 1_793_922_958 - 60));
        assert!(start_secs_match(started, 1_793_922_958 + 1));
        assert!(!start_secs_match(started, 1_793_922_958 - 61));
        assert!(!start_secs_match(started, 1_793_922_958 + 2));
        assert!(!start_secs_match(None, 1_793_922_958));
    }

    /// 가짜 프로세스 표: 앱 1 아래 셸 10(A)·20(B)·30(C)·40(D)·50(E).
    #[test]
    fn claude_resume_chain_walk_maps_claude_to_its_terminal() {
        let mut t: HashMap<u32, ProcInfo> = HashMap::new();
        let mut add = |pid: u32, ppid: u32, start: u64| t.insert(pid, ProcInfo { ppid, start });
        add(1, 0, 1);
        for s in [10, 20, 30, 40, 50] {
            add(s, 1, 100);
        }
        add(100, 10, 200); // A: pwsh → claude.exe (1단)
        add(21, 20, 200); // B: pwsh → cmd → node (2단)
        add(22, 21, 201);
        add(300, 30, 200); // C: claude 안에서 띄운 claude — 셸에 가까운 바깥쪽이 이긴다
        add(301, 300, 201);
        add(302, 301, 202);
        add(400, 40, 50); // D: ppid 40 이 자기보다 늦게 태어남 → 재사용된 번호, 못 잇는다
        add(500, 50, 200); // E: 신원 불일치(procStart 다름)
        add(600, 999, 200); // 부모가 이미 사라짐
        let mut deep = 50; // E 아래 7단 — 상한 밖
        for (i, pid) in (700..707).enumerate() {
            add(pid, deep, 300 + i as u64);
            deep = pid;
        }
        let table = |pid: u32| t.get(&pid).copied();
        let shells: HashMap<u32, &str> = [(10, "A"), (20, "B"), (30, "C"), (40, "D"), (50, "E")].into_iter().collect();
        let regs = vec![
            reg(100, S1, 200, 1),
            reg(22, S2, 201, 1),
            reg(302, "inner", 202, 9),
            reg(300, S3, 200, 1),
            reg(400, "reused", 50, 1),
            reg(500, "wrong", 999, 1),
            reg(600, "orphan", 200, 1),
            reg(706, "deep", 306, 1),
        ];
        let live = map_live(&regs, &shells, &table, &by_start);
        let got: Vec<(&str, &str)> = live.iter().map(|(t, r)| (t.as_str(), r.session_id.as_str())).collect();
        assert_eq!(got, [("A", S1), ("B", S2), ("C", S3)]);
        assert_eq!(owning_term((22, t[&22]), &shells, &table), Some(("B", 2)));
        assert_eq!(owning_term((302, t[&302]), &shells, &table), Some(("C", 3)));
        assert_eq!(owning_term((705, t[&705]), &shells, &table), Some(("E", 6)), "6단까지는 닿는다");
    }

    #[test]
    fn claude_resume_same_session_in_two_terminals_keeps_newest() {
        let t: HashMap<u32, ProcInfo> =
            [(10, ProcInfo { ppid: 1, start: 1 }), (20, ProcInfo { ppid: 1, start: 1 }), (100, ProcInfo { ppid: 10, start: 5 }), (200, ProcInfo { ppid: 20, start: 5 })]
                .into_iter()
                .collect();
        let shells: HashMap<u32, &str> = [(10, "A"), (20, "B")].into_iter().collect();
        let live = map_live(&[reg(100, S1, 5, 9), reg(200, S1, 5, 3)], &shells, &|p| t.get(&p).copied(), &by_start);
        assert_eq!(live.keys().collect::<Vec<_>>(), ["A"], "updatedAt 최신 하나만");
        let tie = map_live(&[reg(100, S1, 5, 3), reg(200, S1, 5, 3)], &shells, &|p| t.get(&p).copied(), &by_start);
        assert_eq!(tie.len(), 1);
    }

    #[test]
    fn claude_resume_snapshot_merge_rules() {
        let now_ms = 1_800_000_000_000;
        let live: BTreeMap<String, ResumeRec> = [("A".to_string(), rec(S1, now_ms))].into_iter().collect();
        let open: HashSet<&str> = ["A", "B", "C"].into_iter().collect();
        let pending: BTreeMap<String, ResumeRec> = [
            ("A".to_string(), rec("old-a", now_ms)), // 지금 도는 것이 이긴다
            ("B".to_string(), rec("b", now_ms)),     // PTY 는 떴는데 Claude 가 없다 → 사용자가 끈 것
            ("D".to_string(), rec("d", now_ms - PENDING_MAX_AGE_MS)), // 아직 안 뜬 터미널 → 넘긴다
            ("E".to_string(), rec("e", now_ms - PENDING_MAX_AGE_MS - 1)), // 14일 넘음
        ]
        .into_iter()
        .collect();
        let inflight: BTreeMap<String, (ResumeRec, Instant)> = [("C".to_string(), (rec("c", now_ms), Instant::now()))].into_iter().collect();
        let merged = merge_snapshot(&live, &open, &pending, &inflight, now_ms);
        let got: Vec<(&str, &str)> = merged.iter().map(|(t, r)| (t.as_str(), r.session_id.as_str())).collect();
        assert_eq!(got, [("A", S1), ("C", "c"), ("D", "d")]);

        // 세션 하나는 터미널 하나에만 — 안 연 탭 D 에 남은 S1 을 사용자가 A 에서 이어 열었으면 D 는 빠진다.
        let dup_pending: BTreeMap<String, ResumeRec> =
            [("D".to_string(), rec(S1, now_ms)), ("F".to_string(), rec("f", now_ms)), ("G".to_string(), rec("f", now_ms))]
                .into_iter()
                .collect();
        let dup_inflight: BTreeMap<String, (ResumeRec, Instant)> =
            [("C".to_string(), (rec(S1, now_ms), Instant::now()))].into_iter().collect();
        let merged = merge_snapshot(&live, &open, &dup_pending, &dup_inflight, now_ms);
        let got: Vec<(&str, &str)> = merged.iter().map(|(t, r)| (t.as_str(), r.session_id.as_str())).collect();
        assert_eq!(got, [("A", S1), ("F", "f")], "live 가 이기고, 같은 세션의 inflight·pending 은 하나만");
    }

    #[test]
    fn claude_resume_snapshot_writes_only_on_change_and_freezes() {
        let now = Instant::now();
        let now_ms = 1_800_000_000_000;
        let mut st = Resume::new();
        let live: BTreeMap<String, ResumeRec> = [("A".to_string(), rec(S1, now_ms))].into_iter().collect();
        let open: HashSet<&str> = ["A"].into_iter().collect();
        let first = snapshot_in(&mut st, &live, &open, now, now_ms, false).expect("처음엔 쓴다");
        st.written = Some(first);
        assert!(snapshot_in(&mut st, &live, &open, now, now_ms, false).is_none(), "안 바뀌면 안 쓴다");

        // 꺼낸 지 90초가 지난 재개는 더 붙들지 않는다.
        st.inflight.insert("B".into(), (rec(S2, now_ms), now));
        assert!(snapshot_in(&mut st, &live, &open, now + INFLIGHT_TTL - Duration::from_secs(1), now_ms, false).is_some());
        assert!(st.inflight.contains_key("B"));
        snapshot_in(&mut st, &live, &open, now + INFLIGHT_TTL, now_ms, false);
        assert!(st.inflight.is_empty());

        // 재개가 실제로 뜨면(live 에 잡힘) TTL 전이라도 inflight 를 놓는다 — 그 뒤 사용자가 Claude 를 끄면 기록도 사라져야 한다.
        st.inflight.insert("A".into(), (rec(S1, now_ms), now));
        snapshot_in(&mut st, &live, &open, now, now_ms, false);
        assert!(!st.inflight.contains_key("A"));

        // 종료 회차 뒤로는 PTY 가 죽어 빈 표가 나와도 쓰지 않는다.
        let empty = BTreeMap::new();
        assert!(snapshot_in(&mut st, &empty, &HashSet::new(), now, now_ms, false).is_some(), "동결 전엔 빈 표도 바뀜이다");
        assert!(snapshot_in(&mut st, &live, &open, now, now_ms, true).is_none(), "마지막으로 쓴 것과 같으면 종료 회차도 안 쓴다");
        assert!(st.frozen);
        assert!(snapshot_in(&mut st, &empty, &HashSet::new(), now, now_ms, false).is_none(), "동결 뒤엔 안 쓴다");
    }

    #[test]
    fn claude_resume_take_skips_and_forget() {
        let now = Instant::now();
        let mut st = Resume::new();
        for (t, s) in [("off", "s-off"), ("gone", "s-gone"), ("busy", "s-busy"), ("ok", "s-ok"), ("drop", "s-drop")] {
            st.pending.insert(t.into(), rec(s, 1));
        }
        st.pending.get_mut("gone").unwrap().cwd = "C:\\없는 폴더".into();
        let is_dir = |c: &str| !c.contains("없는");
        let live_elsewhere = |s: &str| s == "s-busy";
        let take = |st: &mut Resume, t: &str, on: bool| take_in(st, t, on, &is_dir, &live_elsewhere, now);

        assert_eq!(take(&mut st, "off", false), TakeOutcome::Skipped(rec("s-off", 1), SkipReason::Disabled));
        assert!(matches!(take(&mut st, "gone", true), TakeOutcome::Skipped(_, SkipReason::CwdMissing)));
        assert!(matches!(take(&mut st, "busy", true), TakeOutcome::Skipped(_, SkipReason::LiveElsewhere)));
        assert_eq!(take(&mut st, "ok", true), TakeOutcome::Resume(rec("s-ok", 1)));
        for t in ["off", "gone", "busy", "ok", "nope"] {
            assert_eq!(take(&mut st, t, true), TakeOutcome::Nothing, "{t}: 한 번만 준다");
        }
        assert!(st.inflight.contains_key("ok") && st.inflight.len() == 1, "건너뛴 것은 재개 중으로 잡지 않는다");

        // 다른 터미널이 방금 같은 세션을 꺼냈다(그쪽 Claude 는 아직 레지스트리에 없다) → 이쪽은 건너뛴다.
        st.pending.insert("twin".into(), rec("s-ok", 1));
        assert!(matches!(take(&mut st, "twin", true), TakeOutcome::Skipped(_, SkipReason::LiveElsewhere)));

        assert!(forget_in(&mut st, "ok"), "재개 중인 것도 지운다");
        assert!(forget_in(&mut st, "drop"));
        assert!(!forget_in(&mut st, "drop"));
        assert!(st.pending.is_empty() && st.inflight.is_empty());
    }

    #[test]
    fn claude_resume_file_roundtrip_and_expiry() {
        let dir = temp_dir("file");
        let path = dir.join(RESUME_FILE);
        let now_ms = 1_800_000_000_000;
        assert!(load_pending_at(&path, now_ms).is_empty(), "파일 없음 = 0개");

        let mut panes = BTreeMap::new();
        panes.insert("pane-a".to_string(), ResumeRec { name: Some("gitpervisor-6b".into()), ..rec(S1, now_ms - 1000) });
        panes.insert("pane-b".to_string(), rec(S2, now_ms - PENDING_MAX_AGE_MS - 1));
        write_file_at(&path, &panes, now_ms).unwrap();
        let loaded = load_pending_at(&path, now_ms);
        assert_eq!(loaded.keys().collect::<Vec<_>>(), ["pane-a"], "14일 지난 것은 버린다");
        assert_eq!(loaded["pane-a"], panes["pane-a"]);
        assert!(!dir.join("claude-resume.json.tmp").exists(), "임시 파일이 남지 않는다");

        let j: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(j["version"], 1);
        assert_eq!(j["savedAtMs"], now_ms);
        let a = &j["panes"]["pane-a"];
        for key in ["sessionId", "cwd", "name", "updatedAtMs"] {
            assert!(a.get(key).is_some(), "{key} 없음: {a}");
        }
        assert!(j["panes"]["pane-b"].get("name").is_none(), "None 은 키째 빠진다");

        std::fs::write(&path, r#"{"version":2,"panes":{}}"#).unwrap();
        assert!(load_pending_at(&path, now_ms).is_empty());
        std::fs::write(&path, r#"{"version":1,"panes":{"#).unwrap();
        assert!(load_pending_at(&path, now_ms).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Linux·macOS 경로(sysinfo)를 이 OS 에서도 한 번 돌려 본다 — 자기 자신은 부모가 있고 방금 시작했다.
    #[test]
    fn claude_resume_sysinfo_table_reads_self() {
        let me = SysinfoTable::new().get(std::process::id()).expect("자기 자신");
        assert_ne!(me.ppid, 0);
        let now = chrono::Utc::now().timestamp();
        let start = i64::try_from(me.start).unwrap();
        assert!((now - 3600..=now).contains(&start), "시작 {start} / 지금 {now}");
    }

    #[cfg(windows)]
    #[test]
    fn claude_resume_windows_table_matches_sysinfo() {
        let me = std::process::id();
        let win = ProcTable::new().get(me).expect("자기 자신");
        let sys = SysinfoTable::new().get(me).unwrap();
        assert_eq!(win.ppid, sys.ppid);
        // FILETIME(1601-01-01 기준 100ns) → 유닉스 초.
        let secs = (win.start - 116_444_736_000_000_000) / 10_000_000;
        assert!(secs.abs_diff(sys.start) <= 1, "{secs} vs {}", sys.start);
    }

    /// 이 기계의 실제 `~/.claude/sessions/*.json`(`.key` 는 열지 않는다)과 프로세스 표로 파싱·신원 확인·계보를 본다(읽기만).
    /// 앱의 셸 = 떠 있는 gitpervisor.exe 들의 직계 자식으로 놓고 대응표를 만든다.
    /// `cargo test --lib claude_resume_real_registry -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn claude_resume_real_registry() {
        let dir = sessions_dir().unwrap();
        let files = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).count();
        let regs = read_registry(&dir);
        let entries = crate::health::probe::process_entries();
        let names: HashMap<u32, (u32, String)> = entries.iter().map(|(p, pp, n)| (*p, (*pp, n.clone()))).collect();
        let table = ProcTable::new();
        let mut identity_ok = 0;
        for r in &regs {
            let info = table.get(r.pid);
            let ok = info.is_some_and(|i| same_process(r, i.start));
            identity_ok += usize::from(ok);
            let mut chain = Vec::new();
            let mut p = r.pid;
            while let Some((pp, n)) = names.get(&p) {
                chain.push(n.clone());
                if chain.len() > 6 || *pp == p {
                    break;
                }
                p = *pp;
            }
            println!("pid={} identity={ok} session={} cwd={} chain={}", r.pid, &r.session_id[..8.min(r.session_id.len())], r.cwd, chain.join(" ← "));
        }
        let apps: HashSet<u32> = entries.iter().filter(|(_, _, n)| n.eq_ignore_ascii_case("gitpervisor.exe")).map(|(p, _, _)| *p).collect();
        let shell_ids: Vec<(u32, String)> =
            entries.iter().filter(|(_, pp, _)| apps.contains(pp)).map(|(p, _, n)| (*p, format!("{n}#{p}"))).collect();
        let shells: HashMap<u32, &str> = shell_ids.iter().map(|(p, t)| (*p, t.as_str())).collect();
        let t0 = Instant::now();
        let live = map_live(&regs, &shells, &|p| table.get(p), &same_process);
        println!(
            "json files={files} interactive={} identity ok={identity_ok} gitpervisor procs={} → mapped terminals={} ({}ms)",
            regs.len(),
            apps.len(),
            live.len(),
            t0.elapsed().as_millis()
        );
        for (t, r) in &live {
            println!("  {t} → {} {}", &r.session_id[..8.min(r.session_id.len())], r.cwd);
        }
    }
}
