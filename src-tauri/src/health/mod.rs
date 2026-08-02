//! "갑자기 꺼짐" 조기경보.
//!
//! 배경: 2026-08-01, 이 앱은 systemd-oomd에 의해 프로세스 387개와 함께 통째로 SIGKILL 됐다.
//! 사용자는 아무 예고도 받지 못했고, 로그에도 단서가 없었다. 이 모듈은 두 가지를 보장한다.
//!
//!  1. **죽기 전에 알린다.** oomd가 판정에 쓰는 바로 그 파일(`user@N.service/memory.pressure`)을
//!     같이 읽어, 사망선(기본 50%가 20초 지속)에 닿기 전에 단계적으로 경고한다.
//!  2. **죽은 뒤엔 이유를 남긴다.** 30초마다 상태를 스냅샷으로 적어 두고(하트비트 센티널),
//!     다음 실행에서 "깨끗하게 끝났다는 표시가 없다"를 근거로 비정상 종료를 진단한다.
//!
//! 설계 원칙: 감시 자체가 부담이 되면 안 된다. 전부 파일 read이고 자식 프로세스를 하나도
//!만들지 않는다(실측 샘플 1회 ~70µs = CPU 0.0035%).

pub mod probe;
pub mod session;

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use probe::{Probe, Sample};

/// 현재 레벨(다른 모듈이 잠금 없이 읽을 수 있게 원자값으로 둔다).
static LEVEL: AtomicU8 = AtomicU8::new(0);
/// 최신 스냅샷 — `health_snapshot` 커맨드가 읽는다.
static LATEST: Mutex<Option<Snapshot>> = Mutex::new(None);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok = 0,
    /// 주의 — 상태바 칩만. 토스트는 띄우지 않는다(늑대소년 방지).
    Notice = 1,
    /// 경고 — OS 토스트 1회 + 인앱 배너. 지금 저장하라고 알린다.
    Warn = 2,
    /// 위험 — 수십 초 내 강제 종료될 수 있다. 배너를 닫을 수 없게 한다.
    Danger = 3,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Notice => "notice",
            Level::Warn => "warn",
            Level::Danger => "danger",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub level: Level,
    pub sample: Sample,
    /// 이 레벨이 된 이유(사용자에게 그대로 보여준다).
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub level: Level,
    pub prev: Level,
    pub sample: Sample,
    pub reasons: Vec<String>,
}

/// 신호별 임계 — (주의, 경고, 위험).
///
/// 근거: oomd는 앵커 압박이 50%를 20초 지속하면 죽인다. 위험 판정을 35%에 두어
/// 사망선의 70% 지점에서 확실히 알린다. 프로세스 수는 정상 4~6개, 사망 시 387개였고
/// LSP·터미널·브라우저를 활발히 쓰면 40~50까지는 정상이라 60부터 센다(오탐 방지).
const T_FULL: [f32; 3] = [8.0, 20.0, 35.0];
const T_SOME: [f32; 3] = [15.0, 30.0, 45.0];
const T_MEM_PCT: [f32; 3] = [15.0, 30.0, 45.0]; // 회수 불가 상주분(anon) 기준
const T_PROCS: [u32; 3] = [60, 120, 200];
const T_AVAIL_PCT: [f32; 3] = [15.0, 8.0, 4.0];
const T_SWAP_PCT: [f32; 3] = [60.0, 75.0, 85.0];

/// 승격에 필요한 연속 충족 횟수. 위험은 짧게 잡는다 — oomd가 20초에 죽이므로
/// 6초(위험 시 500ms 주기면 1.5초) 안에 판정해야 저장할 시간이 남는다.
const DWELL: [u32; 3] = [3, 5, 3];
/// 강등은 60초 연속 안정 후에만(플래핑 방지).
const COOL_DOWN: Duration = Duration::from_secs(60);

struct Machine {
    probe: Probe,
    level: Level,
    streak: u32,
    candidate: Level,
    calm_since: Option<Instant>,
}

impl Machine {
    fn new() -> Self {
        Self {
            probe: Probe::new(),
            level: Level::Ok,
            streak: 0,
            candidate: Level::Ok,
            calm_since: None,
        }
    }

    fn evaluate(&mut self) -> (Sample, Level, Vec<String>) {
        let s = self.probe.sample();
        let (level, reasons) = assess(&s);
        (s, level, reasons)
    }
}

/// 한 신호를 임계 배열과 비교해 레벨을 낸다. `higher_is_worse=false`면 작을수록 나쁘다.
fn rate(value: f32, t: [f32; 3], higher_is_worse: bool) -> Level {
    let hit = |x: f32| {
        if higher_is_worse {
            value >= x
        } else {
            value <= x
        }
    };
    if hit(t[2]) {
        Level::Danger
    } else if hit(t[1]) {
        Level::Warn
    } else if hit(t[0]) {
        Level::Notice
    } else {
        Level::Ok
    }
}

/// 스냅샷 하나를 레벨로 환산한다(순수 함수 — 테스트 대상).
fn assess(s: &Sample) -> (Level, Vec<String>) {
    if !s.available {
        return (Level::Ok, Vec::new());
    }

    let mut worst = Level::Ok;
    let mut reasons: Vec<String> = Vec::new();
    let consider = |lv: Level, why: String, worst: &mut Level, reasons: &mut Vec<String>| {
        if lv > Level::Ok {
            if lv > *worst {
                *worst = lv;
            }
            reasons.push(why);
        }
    };

    let lv = rate(s.anchor_full_avg10, T_FULL, true);
    consider(
        lv,
        format!(
            "메모리 압박 {:.0}% (OS 종료 기준 {:.0}%)",
            s.anchor_full_avg10, s.kill_threshold
        ),
        &mut worst,
        &mut reasons,
    );

    let lv = rate(s.anchor_some_avg10, T_SOME, true);
    consider(
        lv,
        format!("메모리 지연 {:.0}%", s.anchor_some_avg10),
        &mut worst,
        &mut reasons,
    );

    let lv = rate(s.scope_mem_pct, T_MEM_PCT, true);
    consider(
        lv,
        format!(
            "앱 메모리 {:.1}GB (시스템의 {:.0}%)",
            s.scope_mem_bytes as f32 / 1_073_741_824.0,
            s.scope_mem_pct
        ),
        &mut worst,
        &mut reasons,
    );

    let lv = rate(
        s.scope_procs as f32,
        [T_PROCS[0] as f32, T_PROCS[1] as f32, T_PROCS[2] as f32],
        true,
    );
    consider(
        lv,
        format!("앱에 딸린 프로세스 {}개 (정상 5~40개)", s.scope_procs),
        &mut worst,
        &mut reasons,
    );

    let lv = rate(s.mem_available_pct, T_AVAIL_PCT, false);
    consider(
        lv,
        format!("시스템 여유 메모리 {:.0}%", s.mem_available_pct),
        &mut worst,
        &mut reasons,
    );

    // 스왑은 **단독으로는 위험 신호가 되지 못한다.** oomd의 스왑 경로는 "메모리 사용률과
    // 스왑 사용률이 **둘 다**" 임계를 넘을 때만 발동한다(oomd.conf(5) SwapUsedLimit).
    // 실측(2026-08-02): 이 머신은 여유 메모리 68%·압박 0%인 평상시에도 스왑이 100% 차 있다
    // — 리눅스가 콜드 페이지를 스왑에 남겨두는 정상 동작이다. 단독 판정하면 상시 위험 배너가
    // 떠서 기능이 통째로 무용지물이 된다(첫 설치 검증에서 실제로 발생).
    // 그래서 시스템 메모리가 이미 빠듯할 때만 가중 신호로 쓴다.
    if s.mem_available_pct <= T_AVAIL_PCT[0] {
        let lv = rate(s.swap_used_pct, T_SWAP_PCT, true);
        consider(
            lv,
            format!(
                "스왑 사용 {:.0}% (여유 메모리 {:.0}%)",
                s.swap_used_pct, s.mem_available_pct
            ),
            &mut worst,
            &mut reasons,
        );
    }

    // 처형 1순위 판정 — 압박이 실재할 때만 의미가 있다(평시엔 비율이 튀어도 무해).
    if s.victim_share >= 0.5 && s.anchor_full_avg10 >= T_FULL[0] {
        let lv = if s.anchor_full_avg10 >= 20.0 {
            Level::Danger
        } else {
            Level::Warn
        };
        consider(
            lv,
            format!(
                "메모리 회수 부담의 {:.0}%가 이 앱 — 종료 대상 1순위입니다",
                s.victim_share * 100.0
            ),
            &mut worst,
            &mut reasons,
        );
    }

    (worst, reasons)
}

impl Machine {
    /// dwell·히스테리시스를 적용해 실제 레벨 전이를 결정한다.
    fn settle(&mut self, target: Level) -> Option<Level> {
        if target > self.level {
            self.calm_since = None;
            // streak는 "특정 레벨의 연속"이 아니라 "현재 레벨을 넘어선 상태의 연속"으로 센다.
            // 레벨이 바뀔 때마다 1로 리셋하면, 압박이 경계에서 Warn↔Danger로 흔들릴 때
            // (OOM 램프업의 전형적 모습) 카운터가 매번 초기화돼 **경보가 영원히 안 뜬다.**
            // 후보는 그 구간에서 관측된 가장 낮은 목표로 잡아 과잉 승격을 막는다.
            if self.streak == 0 || target < self.candidate {
                self.candidate = target;
            }
            self.streak += 1;
            let need = DWELL[(self.candidate as usize).saturating_sub(1).min(2)];
            if self.streak >= need {
                self.level = self.candidate;
                self.streak = 0;
                return Some(self.level);
            }
            return None;
        }

        // 목표가 더 낮음 — 60초 연속 안정된 뒤에만 강등한다.
        self.streak = 0;
        self.candidate = target;
        if target == self.level {
            self.calm_since = None;
            return None;
        }
        match self.calm_since {
            None => {
                self.calm_since = Some(Instant::now());
                None
            }
            Some(since) if since.elapsed() >= COOL_DOWN => {
                self.level = target;
                self.calm_since = None;
                Some(target)
            }
            _ => None,
        }
    }
}

/// 종료 신호 수신 표시. 시그널 핸들러 안에서는 이것만 건드린다.
static TERM_REQUESTED: AtomicBool = AtomicBool::new(false);

/// SIGTERM/SIGINT/SIGHUP을 받으면 플래그만 세운다.
///
/// **핸들러 안에서 파일 쓰기·뮤텍스·할당을 하면 안 된다**(async-signal-safe 아님).
/// 하트비트 스레드가 쓰기 락을 쥔 순간 신호가 오면 핸들러 안에서 교착하고, 그러면 종료가
/// 멈춰 systemd가 90초 뒤 SIGKILL로 강제 종료한다. 실제 정리는 감시 스레드가 정상 문맥에서 한다.
#[cfg(unix)]
extern "C" fn on_term(_sig: libc::c_int) {
    TERM_REQUESTED.store(true, Ordering::Relaxed);
}

/// 종료 신호 핸들러를 건다.
///
/// 이게 없으면 **로그아웃·재부팅 때마다 "지난 실행 비정상 종료" 배너가 뜬다.** systemd는 세션
/// 종료 시 SIGTERM을 보내는데 Tauri/tao/GTK 어느 계층도 이를 처리하지 않아(실측: `/proc/PID/status`의
/// SigCgt에 SIGTERM 비트 없음) 창 Destroyed 훅이 돌지 않고 `clean_exit`가 false로 남기 때문이다.
/// systemd-oomd가 쓰는 SIGKILL은 잡을 수 없으므로 진짜 강제 종료 감지는 그대로 유지된다.
#[cfg(unix)]
fn install_signal_handlers() {
    unsafe {
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, on_term as *const () as libc::sighandler_t);
        }
    }
}

#[cfg(not(unix))]
fn install_signal_handlers() {}

/// 종료 신호를 받았을 때의 정리 — 정상 문맥(감시 스레드)에서 실행된다.
fn shutdown_on_signal(app: &AppHandle) -> ! {
    log::info!("[health] 종료 신호 수신 — 자식 프로세스 정리 후 종료");
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        crate::commands::kill_all(state.inner());
        crate::commands::lsp_kill_all(state.inner());
    }
    session::mark_clean();
    std::process::exit(0);
}

/// 감시 스레드 시작. setup에서 1회 호출한다.
pub fn spawn_watchdog(app: AppHandle, version: String, started_at: String) {
    install_signal_handlers();
    std::thread::Builder::new()
        .name("health-watchdog".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut m = Machine::new();
            let mut last_beat = Instant::now();
            let mut last_diag = Instant::now();
            loop {
                // 위험할수록 자주 본다 — 평시 2초, 경고 이상 500ms.
                // 종료 신호에 빠르게 반응하도록 잘게 쪼개 자며 플래그를 확인한다.
                let tick = if m.level >= Level::Warn { 500 } else { 2000 };
                let mut slept = 0u64;
                while slept < tick {
                    if TERM_REQUESTED.load(Ordering::Relaxed) {
                        shutdown_on_signal(&app);
                    }
                    std::thread::sleep(Duration::from_millis(100));
                    slept += 100;
                }

                let prev_level = m.level;
                let (sample, target, reasons) = m.evaluate();
                let transition = m.settle(target);

                LEVEL.store(m.level as u8, Ordering::Relaxed);
                *LATEST.lock().unwrap() = Some(Snapshot {
                    level: m.level,
                    sample: sample.clone(),
                    reasons: reasons.clone(),
                });

                if let Some(level) = transition {
                    if level > Level::Ok {
                        log::warn!("[health] 레벨 상승 → {} 원인={:?}", level.as_str(), reasons);
                    } else {
                        log::info!("[health] 레벨 정상 복귀");
                    }
                    let _ = app.emit(
                        "health://level",
                        Transition {
                            level,
                            prev: prev_level,
                            sample: sample.clone(),
                            reasons: reasons.clone(),
                        },
                    );
                    // 경고 이상이면 미저장 초안을 즉시 flush하라고 프론트에 알린다.
                    if level >= Level::Warn {
                        let _ = app.emit("health://flush-drafts", ());
                    }
                }

                // 평시 30초. 경보 중에는 5초로 줄인다 — oomd가 SIGKILL을 날리면 마지막 하트비트가
                // 그대로 사후 진단의 전부가 되는데, 30초 낡은 스냅샷이면 압박이 한창일 때 죽어도
                // "한가했다"로 기록돼 원인이 `unknown`으로 떨어진다.
                let beat_every = if m.level >= Level::Notice { 5 } else { 30 };
                if last_beat.elapsed() >= Duration::from_secs(beat_every) {
                    last_beat = Instant::now();
                    session::heartbeat(m.level.as_str(), &sample, &version, &started_at);
                }
                // 5분마다 한 줄. 평시에도 남는 유일한 정기 기록 — 프로세스 수가 23→100→250으로
                // 가는 궤적이 로그에 그대로 보이게 하는 것이 목적이다(이번 사건의 재발 방지 핵심).
                if last_diag.elapsed() >= Duration::from_secs(300) {
                    last_diag = Instant::now();
                    if sample.available {
                        log::info!(
                            "[health] lv={} procs={} mem={:.1}GB({:.0}%) press_full10={:.1}% \
                             press_some10={:.1}% victim={:.2} avail={:.0}% swap={:.0}%",
                            m.level.as_str(),
                            sample.scope_procs,
                            sample.scope_mem_bytes as f32 / 1_073_741_824.0,
                            sample.scope_mem_pct,
                            sample.anchor_full_avg10,
                            sample.anchor_some_avg10,
                            sample.victim_share,
                            sample.mem_available_pct,
                            sample.swap_used_pct,
                        );
                    }
                }
            }
        })
        .ok();
}

/// 시작 시 1회 — 이전 세션 판정 + 이번 세션 기록 시작.
pub fn begin_session(app: &AppHandle, version: &str) {
    if let Ok(dir) = app.path().app_log_dir() {
        session::begin(&dir, version);
    }
}

/// 정상 종료 표시(종료 훅에서 호출).
pub fn end_session() {
    session::mark_clean();
}

#[tauri::command(async)]
pub fn health_snapshot() -> Option<Snapshot> {
    LATEST.lock().unwrap().clone()
}

/// 지난 실행이 비정상 종료였는지 + 그 시점 스냅샷. 시작 시 배너가 이걸 읽는다.
#[tauri::command(async)]
pub fn health_prev_session() -> session::PrevSession {
    session::previous()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-08-02 첫 설치 검증에서 실제로 관측된 평상시 스냅샷.
    /// 스왑만 100%이고 나머지는 모두 한가한 상태다.
    fn idle_sample() -> Sample {
        Sample {
            anchor_full_avg10: 0.0,
            anchor_some_avg10: 0.0,
            kill_threshold: 50.0,
            victim_share: 0.0,
            scope_mem_bytes: 279_683_072,
            scope_mem_pct: 0.834,
            scope_current_bytes: 451_481_600,
            scope_procs: 3,
            mem_available_pct: 68.4,
            swap_used_pct: 99.86,
            available: true,
        }
    }

    /// 스왑이 꽉 차 있어도 메모리가 넉넉하면 경보를 올리면 안 된다.
    /// (이 머신은 평상시에도 스왑이 100%다 — 리눅스가 콜드 페이지를 스왑에 남긴다.
    ///  oomd의 스왑 경로도 "메모리와 스왑이 둘 다" 높을 때만 발동한다.)
    #[test]
    fn full_swap_alone_is_not_an_alarm() {
        let (level, reasons) = assess(&idle_sample());
        assert_eq!(level, Level::Ok, "평상시 오경보: {reasons:?}");
    }

    /// 메모리까지 빠듯해지면 그때는 스왑이 가중 신호로 동작해야 한다.
    #[test]
    fn swap_counts_once_memory_is_tight() {
        let mut s = idle_sample();
        s.mem_available_pct = 6.0; // 여유 메모리 6% — 이미 경고 영역
        let (level, _) = assess(&s);
        assert!(level >= Level::Warn);
    }

    /// 실제 사망 신호(앵커 압박)는 확실히 잡아야 한다.
    #[test]
    fn real_pressure_escalates() {
        let mut s = idle_sample();
        s.anchor_full_avg10 = 36.0; // oomd 사망선 50%의 72% 지점
        let (level, reasons) = assess(&s);
        assert_eq!(level, Level::Danger, "{reasons:?}");
    }

    /// 프로세스 폭주(이번 사건의 387개)도 잡아야 한다.
    #[test]
    fn process_explosion_escalates() {
        let mut s = idle_sample();
        s.scope_procs = 387;
        let (level, _) = assess(&s);
        assert_eq!(level, Level::Danger);
    }

    /// 신호를 못 읽는 환경(비 cgroup v2)에서는 조용히 비활성.
    #[test]
    fn unavailable_never_alarms() {
        let s = Sample::default();
        assert_eq!(assess(&s).0, Level::Ok);
    }

    /// 두 경보 레벨 사이에서 흔들려도 승격이 막히면 안 된다(streak 리셋 버그 회귀 방지).
    #[test]
    fn oscillating_targets_still_promote() {
        let mut m = Machine {
            probe: Probe::new(),
            level: Level::Ok,
            streak: 0,
            candidate: Level::Ok,
            calm_since: None,
        };
        // Warn/Danger를 번갈아 5틱 — DWELL[Warn]=5 이므로 Warn으로 승격돼야 한다.
        let seq = [Level::Warn, Level::Danger, Level::Warn, Level::Danger, Level::Warn];
        let mut promoted = None;
        for t in seq {
            if let Some(l) = m.settle(t) {
                promoted = Some(l);
            }
        }
        assert_eq!(promoted, Some(Level::Warn), "흔들림에 승격이 막혔다");
    }
}
