//! 프로젝트별 원격 최신상태 자동 반영 — 백그라운드 fetch 스케줄러 (태스크 04).
//!
//! 주기 실행에 프론트 invoke가 전혀 없다(WebView2 응답 유실 원천 차단, §3.1). fetch가 refs를
//! 갱신하면 기존 watcher → `repo://changed` → statuses 무효화 경로가 UI를 자동 갱신하고,
//! 이 모듈의 `repo://remote-freshness` 이벤트는 오류 발생/해소 "전이" 신호 전용이다(§3.5).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Semaphore;

use crate::error::IpcError;
use crate::git::runner;
use crate::state::AppState;

/// 틱은 짧게 — 매 틱마다 설정 주기 도달 여부만 판정해, 주기 변경이 재시작 없이 즉시 반영된다.
const TICK_SECS: u64 = 30;
/// 배경 fetch 타임아웃 — NETWORK_TIMEOUT_SECS(120)보다 짧게 잡아 op 락 보유 시간을 줄인다(§3.2).
const FETCH_TIMEOUT_SECS: u64 = 45;
/// 동시 fetch 상한 — 수십 프로젝트여도 네트워크 폭주 없음(§3.5).
const MAX_CONCURRENT_FETCHES: usize = 3;
/// 원격 없는 repo의 재확인 주기(사이클 수) — 원격 추가 대비(§3.5).
const REMOTE_RECHECK_CYCLES: u32 = 10;
/// 연속 실패 백오프 상한 — 30분(§3.5).
const BACKOFF_CAP_SECS: u64 = 30 * 60;
/// 포커스 복귀 트리거 스로틀 — 마지막 사이클로부터 60초 이내면 no-op(§3.5).
const FOCUS_RATE_LIMIT_SECS: u64 = 60;

/// 레포별 원격 확인 결과 — get_statuses가 조인해 RepoStatus로 실어 보낸다(별도 조회 invoke 없음).
#[derive(Debug, Clone, Default)]
pub struct RemoteFreshness {
    /// ISO 8601 — 마지막 fetch 성공 시각.
    pub last_checked_at: Option<String>,
    /// 마지막 실패 사유(분류 메시지). None=정상.
    pub error: Option<String>,
    /// 백오프 지수 — 연속 실패 횟수.
    pub failure_streak: u32,
    /// None=미확인, Some(false)=원격 없음(스킵 대상).
    pub has_remote: Option<bool>,
}

/// 스케줄러 내부 메타(계약 밖 — freshness와 분리 보관).
#[derive(Default)]
struct SchedMeta {
    /// 마지막 fetch 시도 시각(성공/실패 무관) — 백오프 대기 계산 기준.
    last_attempt: Option<Instant>,
    /// 원격 없음으로 캐시된 뒤 지난 사이클 수 — REMOTE_RECHECK_CYCLES마다 재확인.
    cycles_since_remote_check: u32,
}

/// 마지막 전체 사이클 시각 — 포커스 트리거 스로틀 판정용.
static LAST_CYCLE: Mutex<Option<Instant>> = Mutex::new(None);
/// git <2.29 폴백 캐시 — `--no-write-fetch-head` 미지원을 1회 감지하면 프로세스 수명 동안 제거.
static NO_WRITE_FETCH_HEAD_UNSUPPORTED: AtomicBool = AtomicBool::new(false);
static SCHED: OnceLock<Mutex<HashMap<String, SchedMeta>>> = OnceLock::new();

fn sched() -> &'static Mutex<HashMap<String, SchedMeta>> {
    SCHED.get_or_init(Default::default)
}

/// 동시 fetch 상한 세마포어 — **프로세스 전역 1개**.
///
/// 사이클마다 새로 만들면 사이클이 겹칠 때(스케줄러 틱 + 창 포커스 복귀 + 수동 새로고침)
/// 상한이 사이클 수만큼 곱해진다 — 3개 제한이 실제로는 9개, 12개가 되어 git 프로세스가
/// 한꺼번에 뜬다. 프로세스 폭주 사후조치의 취지대로 상한은 전역이어야 의미가 있다.
static FETCH_SEM: OnceLock<Semaphore> = OnceLock::new();

fn fetch_sem() -> &'static Semaphore {
    FETCH_SEM.get_or_init(|| Semaphore::new(MAX_CONCURRENT_FETCHES))
}

/// 사이클 실행권을 **선점**한다 — `min_interval` 이내에 사이클이 돌았으면 false(스킵),
/// 아니면 `LAST_CYCLE`을 지금으로 갱신하고 true.
///
/// 판정과 갱신을 **한 락 구간**에서 하는 것이 핵심이다. 예전에는 호출부가 락을 잡아 값을 읽고
/// (락 해제) → `run_cycle`을 spawn → run_cycle이 다시 락을 잡아 갱신하는 구조라, 그 사이에
/// 들어온 두 번째 트리거(포커스 복귀 vs 스케줄러 틱)가 아직 낡은 `LAST_CYCLE`을 보고 함께
/// 통과했다. 스로틀이 있는데도 사이클이 두 겹으로 돌아 fetch가 배로 나가던 경로다.
fn claim_cycle(min_interval: Duration) -> bool {
    let mut last = LAST_CYCLE.lock().unwrap();
    if last.is_some_and(|t| t.elapsed() < min_interval) {
        return false;
    }
    *last = Some(Instant::now());
    true
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FreshnessChanged {
    project_id: String,
}

/// setup에서 1회 spawn. 매 틱: 설정 주기(0=끔) 도달 여부 판정 → 도달 시 전체 사이클 실행.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(TICK_SECS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let minutes = {
                let state = app.state::<AppState>();
                let m = state.settings.read().unwrap().remote_refresh_minutes;
                m
            };
            if minutes == 0 {
                continue; // 0 = 끔 — 다음 틱에 설정을 다시 본다(재시작 불요)
            }
            // 주기 도달 판정과 LAST_CYCLE 갱신을 원자적으로 — 포커스 트리거와 동시에 통과해
            // 사이클이 두 겹으로 도는 것을 막는다(claim_cycle 주석).
            if claim_cycle(Duration::from_secs(u64::from(minutes) * 60)) {
                run_cycle(app.clone(), None, false).await;
            }
        }
    });
}

/// 수동(컨텍스트 메뉴)/포커스 복귀 트리거 — 즉시 반환하고 백그라운드에서 진행한다.
/// project_ids 비면 전체. force=false면 마지막 사이클 60초 이내 no-op(스로틀은 백엔드 소관).
#[tauri::command]
pub async fn refresh_remotes(
    app: AppHandle,
    state: State<'_, AppState>,
    project_ids: Vec<String>,
    force: bool,
) -> Result<(), IpcError> {
    if state.projects.read().unwrap().is_empty() {
        return Ok(());
    }
    if !force {
        // 사용자가 배경 갱신을 껐으면(0) 포커스 복귀 트리거도 돌면 안 된다. 이 가드가 없으면
        // 스케줄러만 멈추고 창 포커스마다 60초 스로틀 한도까지 fetch가 돌아, 오히려 5분
        // 주기보다 잦아진다(시간당 최대 60사이클 × 레포 수). 우클릭 수동 새로고침은
        // force=true로 오므로 그대로 동작한다.
        if state.settings.read().unwrap().remote_refresh_minutes == 0 {
            return Ok(());
        }
        // 스로틀 판정과 LAST_CYCLE 갱신을 한 락 구간에서 — 읽고 나서 spawn한 run_cycle이
        // 갱신하던 예전 구조는 그 틈에 들어온 두 번째 포커스 이벤트가 함께 통과했다.
        if !claim_cycle(Duration::from_secs(FOCUS_RATE_LIMIT_SECS)) {
            return Ok(());
        }
    }
    let only = (!project_ids.is_empty()).then_some(project_ids);
    tauri::async_runtime::spawn(run_cycle(app, only, force));
    Ok(())
}

/// 한 사이클: 대상 스냅샷 → 스킵 규칙 판정(§3.5) → Semaphore(3)로 병렬 fetch.
/// 대상은 state.projects 최상위 전부 — 중첩 repo 자동 포함은 후속(§3.8).
async fn run_cycle(app: AppHandle, only: Option<Vec<String>>, force: bool) {
    let state = app.state::<AppState>();
    let targets: Vec<(String, PathBuf)> = {
        let projects = state.projects.read().unwrap();
        projects
            .iter()
            .filter(|p| {
                only.as_ref()
                    .map_or(true, |ids| ids.iter().any(|id| id == &p.id))
            })
            .map(|p| (p.id.clone(), PathBuf::from(&p.path)))
            .collect()
    };
    if targets.is_empty() {
        return;
    }
    let period = state.settings.read().unwrap().remote_refresh_minutes;

    if only.is_none() {
        // force 전체 새로고침은 claim_cycle을 거치지 않으므로 여기서 시각을 남긴다 —
        // 수동 새로고침 직후 스케줄러 틱이 곧바로 또 도는 것을 막는다. 스로틀 경로는 이미
        // claim_cycle이 찍었고 여기서 한 번 더 찍혀도 사이클 시작 시각으로 갱신될 뿐이다.
        *LAST_CYCLE.lock().unwrap() = Some(Instant::now());
        // 제거된 프로젝트의 잔여 항목 정리 — 좀비 백오프/캐시가 남지 않게.
        let live: HashSet<&str> = targets.iter().map(|(id, _)| id.as_str()).collect();
        state
            .freshness
            .write()
            .unwrap()
            .retain(|k, _| live.contains(k.as_str()));
        sched()
            .lock()
            .unwrap()
            .retain(|k, _| live.contains(k.as_str()));
    }

    // 스킵 규칙 판정 — 원격 없음 캐시는 여기서 사이클 카운트를 올린다.
    let mut planned: Vec<(String, PathBuf)> = Vec::new();
    {
        let freshness = state.freshness.read().unwrap();
        let mut sched = sched().lock().unwrap();
        for (id, path) in targets {
            let f = freshness.get(&id);
            let meta = sched.entry(id.clone()).or_default();
            let attempt = should_attempt(
                f.and_then(|f| f.has_remote),
                meta.cycles_since_remote_check,
                f.map_or(0, |f| f.failure_streak),
                meta.last_attempt.map(|t| t.elapsed().as_secs()),
                period,
                force,
            );
            if attempt {
                planned.push((id, path));
            } else if f.and_then(|f| f.has_remote) == Some(false) {
                meta.cycles_since_remote_check = meta.cycles_since_remote_check.saturating_add(1);
            }
        }
    }
    if planned.is_empty() {
        return;
    }

    // 전역 세마포어로 동시 fetch를 제한한다 — 사이클이 겹쳐도 git 프로세스는 3개를 넘지 않는다.
    let tasks: Vec<_> = planned
        .into_iter()
        .map(|(id, path)| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(_permit) = fetch_sem().acquire().await else {
                    return; // 세마포어가 닫힘(종료 중) — 조용히 양보
                };
                fetch_one(&app, &id, &path).await;
            })
        })
        .collect();
    for t in tasks {
        let _ = t.await;
    }
}

/// 한 레포의 배경 fetch: op 락 논블로킹(실패=사용자 작업 우선 스킵, §3.4) → 원격 유무 확인 →
/// 자격증명 억제 env로 `fetch --quiet --no-write-fetch-head` → freshness 갱신.
async fn fetch_one(app: &AppHandle, project_id: &str, path: &Path) {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.try_begin_op(project_id) else {
        return; // 사용자 커밋/pull 등이 락 보유 중 — 이번 사이클은 조용히 양보
    };

    // 시도 시각 기록(성공/실패 무관) — 백오프 대기의 기준점.
    {
        let mut sched = sched().lock().unwrap();
        let meta = sched.entry(project_id.to_string()).or_default();
        meta.last_attempt = Some(Instant::now());
        meta.cycles_since_remote_check = 0;
    }

    // 원격 유무 확인 — 미확인이거나 "없음" 캐시의 재확인 시점일 때만 실행.
    let known_remote = {
        let map = state.freshness.read().unwrap();
        map.get(project_id).and_then(|f| f.has_remote)
    };
    if known_remote != Some(true) {
        match runner::run_git(Some(path), &["remote"], runner::READ_TIMEOUT_SECS).await {
            Ok(out) if out.code == 0 => {
                if out.stdout_str().trim().is_empty() {
                    // 원격 없음은 오류가 아니다 — 스킵 대상으로 캐시(10사이클마다 재확인).
                    apply_outcome(app, project_id, Outcome::NoRemote);
                    return;
                }
            }
            // git 실패(레포 아님·경로 소실 등)는 status 쪽 error와 중복 — freshness는 건드리지 않는다.
            _ => return,
        }
    }

    match run_fetch(path).await {
        Ok(out) if out.code == 0 => apply_outcome(app, project_id, Outcome::Success),
        Ok(out) => apply_outcome(
            app,
            project_id,
            Outcome::Failure(classify_fetch_error(&out.stderr)),
        ),
        Err(e) => apply_outcome(app, project_id, Outcome::Failure(e.message)),
    }
}

/// fetch 실행. 자격증명 3중 억제(§3.2): GIT_TERMINAL_PROMPT=0은 runner 전역이고, 여기서
/// GCM_INTERACTIVE=never(env) + credential.interactive=false(-c 인자)를 함께 건다.
/// `--no-write-fetch-head`(git ≥2.29)는 무변화 사이클의 FETCH_HEAD 쓰기 → watcher 소음을 막는다.
async fn run_fetch(path: &Path) -> Result<runner::GitOutput, IpcError> {
    let use_no_fetch_head = !NO_WRITE_FETCH_HEAD_UNSUPPORTED.load(Ordering::Relaxed);
    let mut args: Vec<&str> = vec!["-c", "credential.interactive=false", "fetch", "--quiet"];
    if use_no_fetch_head {
        args.push("--no-write-fetch-head");
    }
    let mut env: Vec<(&str, &str)> = vec![("GCM_INTERACTIVE", "never")];
    // ssh passphrase 프롬프트 억제 — 사용자 env에 이미 있으면 미설정(커스텀 ssh 래퍼 보호).
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        env.push(("GIT_SSH_COMMAND", "ssh -oBatchMode=yes"));
    }
    let out = runner::run_git_env(Some(path), &args, &env, FETCH_TIMEOUT_SECS).await?;
    // git <2.29 폴백 — "unknown option" 1회 감지 후 프로세스 수명 동안 플래그 제거(§6).
    if out.code != 0 && use_no_fetch_head && out.stderr.contains("unknown option") {
        NO_WRITE_FETCH_HEAD_UNSUPPORTED.store(true, Ordering::Relaxed);
        let args: Vec<&str> = vec!["-c", "credential.interactive=false", "fetch", "--quiet"];
        return runner::run_git_env(Some(path), &args, &env, FETCH_TIMEOUT_SECS).await;
    }
    Ok(out)
}

enum Outcome {
    Success,
    NoRemote,
    Failure(String),
}

/// freshness 갱신 + 오류 발생/해소 "전이" 시에만 `repo://remote-freshness` emit —
/// 무변화 사이클에 statuses 재조회를 유발하지 않는다(§3.5).
fn apply_outcome(app: &AppHandle, project_id: &str, outcome: Outcome) {
    let state = app.state::<AppState>();
    let had_error;
    let now_error;
    {
        let mut map = state.freshness.write().unwrap();
        let entry = map.entry(project_id.to_string()).or_default();
        had_error = entry.error.is_some();
        match outcome {
            Outcome::Success => {
                entry.last_checked_at = Some(chrono::Utc::now().to_rfc3339());
                entry.error = None;
                entry.failure_streak = 0;
                entry.has_remote = Some(true);
            }
            Outcome::NoRemote => {
                entry.error = None;
                entry.failure_streak = 0;
                entry.has_remote = Some(false);
            }
            Outcome::Failure(msg) => {
                entry.error = Some(msg);
                entry.failure_streak = entry.failure_streak.saturating_add(1);
                entry.has_remote = Some(true); // fetch까지 갔다 = 원격은 있다
            }
        }
        now_error = entry.error.is_some();
    }
    if had_error != now_error {
        let _ = app.emit(
            "repo://remote-freshness",
            FreshnessChanged {
                project_id: project_id.to_string(),
            },
        );
    }
}

/// 배경 fetch 실패 사유를 짧은 메시지로 분류 — 조용한 배지 툴팁용(sync.rs 분류의 축약판.
/// 수동 push/pull은 계속 sync.rs 경로 — 배경 fetch만 이걸 쓴다).
fn classify_fetch_error(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let reason = if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied")
        || lower.contains("access denied")
    {
        "인증 실패 — credential manager / ssh-agent 설정을 확인하세요".to_string()
    } else if lower.contains("could not resolve host")
        || lower.contains("network is unreachable")
        || lower.contains("connection timed out")
        || lower.contains("failed to connect")
    {
        "네트워크 연결 실패 — 인터넷/원격 호스트를 확인하세요".to_string()
    } else if lower.contains("couldn't find remote ref")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("repository not found")
    {
        "원격 저장소/브랜치를 찾을 수 없음 — 원격 URL을 확인하세요".to_string()
    } else {
        // 분류 실패 시 stderr의 첫 error/fatal 라인(없으면 첫 비어있지 않은 라인)을 그대로.
        stderr
            .lines()
            .map(str::trim)
            .find(|l| {
                let lc = l.to_ascii_lowercase();
                !l.is_empty() && (lc.starts_with("error") || lc.starts_with("fatal"))
            })
            .or_else(|| stderr.lines().map(str::trim).find(|l| !l.is_empty()))
            .unwrap_or("(상세 메시지 없음)")
            .to_string()
    };
    format!("배경 fetch 실패: {reason}")
}

/// 연속 실패 백오프 대기시간(초) — 2^streak × 주기, 상한 30분(§3.5). streak=0이면 0.
/// 주기 0(수동 트리거만 쓰는 상태)은 최소 1분으로 계산해 0초 백오프 폭주를 막는다.
fn backoff_secs(period_minutes: u32, failure_streak: u32) -> u64 {
    if failure_streak == 0 {
        return 0;
    }
    let period = u64::from(period_minutes.max(1)) * 60;
    let factor = 2u64.saturating_pow(failure_streak.min(20));
    period.saturating_mul(factor).min(BACKOFF_CAP_SECS)
}

/// 한 레포의 이번 사이클 fetch 시도 여부(§3.5 스킵 규칙). 순수 로직 — 유닛테스트 대상.
/// op 락 점유 스킵(§3.4)은 fetch 직전 try_begin_op 논블로킹으로 별도 처리된다.
fn should_attempt(
    has_remote: Option<bool>,
    cycles_since_remote_check: u32,
    failure_streak: u32,
    secs_since_attempt: Option<u64>,
    period_minutes: u32,
    force: bool,
) -> bool {
    if force {
        return true;
    }
    // 원격 없는 repo는 스킵하되 10사이클마다 재확인(원격 추가 대비).
    if has_remote == Some(false) {
        return cycles_since_remote_check >= REMOTE_RECHECK_CYCLES;
    }
    // 연속 실패 백오프 — 마지막 시도 후 2^n × 주기(상한 30분)가 지나야 재시도.
    if failure_streak > 0 {
        let wait = backoff_secs(period_minutes, failure_streak);
        return secs_since_attempt.map_or(true, |s| s >= wait);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_secs(5, 0), 0, "실패 없음 = 백오프 없음");
        assert_eq!(backoff_secs(5, 1), 600, "2^1 × 5분");
        assert_eq!(backoff_secs(5, 2), 1200, "2^2 × 5분");
        assert_eq!(backoff_secs(5, 3), 1800, "2400초 → 상한 30분");
        assert_eq!(
            backoff_secs(5, 63),
            1800,
            "큰 streak도 오버플로 없이 상한 유지"
        );
        assert_eq!(backoff_secs(0, 1), 120, "주기 0은 최소 1분으로 계산");
    }

    #[test]
    fn skips_no_remote_until_recheck_cycle() {
        assert!(!should_attempt(Some(false), 0, 0, None, 5, false));
        assert!(!should_attempt(Some(false), 9, 0, None, 5, false));
        assert!(
            should_attempt(Some(false), 10, 0, None, 5, false),
            "10사이클마다 원격 재확인"
        );
    }

    #[test]
    fn skips_during_backoff_window() {
        // 실패 1회(주기 5분) → 10분 대기: 9분 경과면 스킵, 10분 경과면 재시도.
        assert!(!should_attempt(Some(true), 0, 1, Some(9 * 60), 5, false));
        assert!(should_attempt(Some(true), 0, 1, Some(10 * 60), 5, false));
        // 시도 기록이 없으면(프로세스 재시작 등) 곧장 시도.
        assert!(should_attempt(Some(true), 0, 3, None, 5, false));
    }

    #[test]
    fn force_overrides_all_skips() {
        assert!(
            should_attempt(Some(false), 0, 0, None, 5, true),
            "원격 없음 캐시 무시"
        );
        assert!(
            should_attempt(Some(true), 0, 5, Some(0), 5, true),
            "백오프 무시"
        );
    }

    /// 회귀 방지(TOCTOU): 동시 트리거가 여럿이어도 사이클을 여는 쪽은 **정확히 하나**여야 한다.
    /// 판정과 LAST_CYCLE 갱신이 갈라져 있던 예전 구조에서는 전원이 통과해 fetch가 배로 나갔다.
    ///
    /// LAST_CYCLE은 전역이라 이 테스트만 손댄다(다른 테스트는 순수 함수만 쓴다).
    #[test]
    fn claim_cycle_admits_exactly_one_concurrent_trigger() {
        use std::sync::atomic::AtomicUsize;
        *LAST_CYCLE.lock().unwrap() = None; // "아직 사이클 없음" 상태에서 시작
        let winners = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    if claim_cycle(Duration::from_secs(60)) {
                        winners.fetch_add(1, Ordering::Relaxed);
                    }
                });
            }
        });
        assert_eq!(winners.load(Ordering::Relaxed), 1, "동시 트리거 중 하나만 통과");
        // 방금 사이클이 돌았으므로 이후 트리거는 스로틀에 걸린다.
        assert!(!claim_cycle(Duration::from_secs(60)));
        // 간격 0이면 항상 통과(force 경로가 아니라 "주기가 다 찼다"는 뜻).
        assert!(claim_cycle(Duration::from_secs(0)));
        *LAST_CYCLE.lock().unwrap() = None; // 실제 스케줄러에 영향이 남지 않게 복원
    }

    #[test]
    fn unknown_or_present_remote_attempts() {
        assert!(
            should_attempt(None, 0, 0, None, 5, false),
            "미확인 원격은 확인 겸 시도"
        );
        assert!(should_attempt(Some(true), 0, 0, Some(0), 5, false));
    }
}
