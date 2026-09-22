//! 하트비트 센티널 — "지난번에 왜 갑자기 꺼졌는가"를 다음 실행에서 답하기 위한 장치.
//!
//! systemd-oomd나 커널 OOM Killer가 SIGKILL로 죽이면 **어떤 종료 훅도 돌지 않는다.**
//! 패닉이 아니므로 `panic.log`도 생기지 않는다 — 기존 크래시 배너가 이번 사건을 한 번도
//! 잡지 못한 이유다. 유일한 해법은 살아있는 동안 상태를 미리 적어 두고, 다음 시작에서
//! "깨끗하게 끝났다는 표시가 없다"를 근거로 역추론하는 것이다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::probe::{Sample, TopProc};
use super::winlog::OsEvent;
use super::T_PROCS;

pub const CURRENT: &str = "session.json";
pub const PREVIOUS: &str = "session.prev.json";
/// 할당 실패 표식(`alloc_guard`가 abort 직전에 남긴다)과 그 1세대 보관본.
/// 판정에 쓴 표식은 곧바로 밀어낸다 — 그러지 않으면 다음 실행마다 같은 사고를 재판정한다.
pub const ALLOC_FAIL: &str = "alloc-fail.txt";
pub const ALLOC_FAIL_PREV: &str = "alloc-fail.prev.txt";

static SESSION_PATH: OnceLock<PathBuf> = OnceLock::new();
static PREV: OnceLock<PrevSession> = OnceLock::new();
/// 정상 종료가 기록된 뒤로는 하트비트가 파일을 다시 건드리지 못하게 막는 빗장.
///
/// 이게 없으면 종료 훅이 `clean_exit: true`를 쓴 직후 감시 스레드의 30초 하트비트가
/// `false`로 되돌려, **정상 종료가 다음 실행에서 "비정상 종료"로 오진된다.**
/// 앱 종료는 PTY 세션 정리 때문에 수백 ms가 걸릴 수 있어 실제로 겹칠 수 있는 창이다.
static CLOSED: AtomicBool = AtomicBool::new(false);
/// 쓰기 직렬화 — 하트비트와 종료 기록이 겹쳐 순서가 뒤바뀌는 것을 막는다.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// `default`가 중요하다 — 나중에 필드를 추가했을 때 옛 파일 파싱이 실패하면 `prev`가 None이 되어
/// **비정상 종료 감지가 조용히 무력화된다**(경고 없이 기능만 사라지는 최악의 실패 모드).
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionRecord {
    pub pid: u32,
    pub version: String,
    pub started_at: String,
    pub updated_at: String,
    /// 정상 종료 훅이 돌았는지. false로 남아 있으면 비정상 종료다.
    pub clean_exit: bool,
    pub level: String,
    pub last: Sample,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrevSession {
    /// 지난 실행이 비정상 종료되었는가.
    pub crashed: bool,
    /// "oom" | "panic" | "crash" | "power" | "reboot" | "unknown" | "clean"
    pub verdict: String,
    /// 사용자에게 보여줄 진단 문구(판정 시점의 UI 언어).
    pub message: String,
    pub record: Option<SessionRecord>,
    /// Windows 이벤트 로그에서 건진 상관 이벤트(이미 UI 언어 한 줄로 포맷됨).
    /// 앱 로그에 아무것도 없는 종료(할당 실패 abort·강제 종료·전원 차단)의 유일한 외부 근거다.
    pub os_events: Vec<String>,
}

/// 시작 시 1회. 이전 세션 파일을 판정해 보관하고, 이번 세션 기록을 새로 연다.
pub fn begin(log_dir: &Path, version: &str) {
    let _ = std::fs::create_dir_all(log_dir);
    let current = log_dir.join(CURRENT);
    let _ = SESSION_PATH.set(current.clone());

    let prev = std::fs::read_to_string(&current)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionRecord>(&s).ok());

    // 할당 실패 표식은 판정 근거 중 가장 강하다(다른 어떤 신호보다 직접적이다). 읽고 밀어낸 뒤
    // 이번 세션용 경로를 등록한다 — 순서가 바뀌면 방금 읽은 표식을 다시 판정하게 된다.
    let alloc_fail = take_alloc_marker(log_dir, prev.as_ref());
    super::alloc_guard::install(log_dir);

    // 비정상 종료였을 때만 이벤트 로그를 본다 — 정상 시작 경로에 자식 프로세스를 붙이지 않는다.
    // 창 생성 전 메인 스레드이므로 동기 호출이지만 상한 3초(채널당)라 체감되지 않는다.
    let crashed = prev.as_ref().is_some_and(|r| !r.clean_exit);
    let events = if crashed {
        prev.as_ref()
            .and_then(|r| chrono::DateTime::parse_from_rfc3339(&r.updated_at).ok())
            .map(|t| super::winlog::query_around(t.with_timezone(&chrono::Local)))
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let verdict = classify(
        prev.as_ref(),
        panic_log_near(log_dir, prev.as_ref()),
        alloc_fail,
        &events,
    );
    if verdict.crashed {
        // 사후 분석용으로 보관 — prune_logs가 지우지 않도록 보존 목록에 있다.
        let _ = std::fs::rename(&current, log_dir.join(PREVIOUS));
        log::warn!(
            "[health] 지난 실행 비정상 종료 감지: {} — {}", // i18n-ok: 로그
            verdict.verdict,
            verdict.message
        );
        for line in &verdict.os_events {
            log::warn!("[health] OS 이벤트: {line}");
        }
    }
    let _ = PREV.set(verdict);

    write(&SessionRecord {
        pid: std::process::id(),
        version: version.to_string(),
        started_at: now(),
        updated_at: now(),
        clean_exit: false,
        level: "ok".into(),
        last: Sample::default(),
    });
}

/// 메모리 원인 진단 문구 — **실제로 채워진 신호만** 나열한다.
///
/// 예전에는 항상 "프로세스 N개, 메모리 압박 M%"를 찍었는데, Windows에는 압박(PSI) 신호가 없어
/// 늘 "메모리 압박이 0%였습니다"라는 거짓 문장이 붙었다. 플랫폼별로 읽히는 값이 다르므로
/// 값이 있는 것만 모아 쓴다.
fn oom_message(s: &Sample) -> String {
    // 죽인 주체가 다르다 — 리눅스는 oomd/OOM 킬러가 골라 죽이고, Windows는 그런 주체 없이
    // 할당 실패·렌더러 크래시로 무너진다. 단정 문구를 플랫폼에 맞춘다.
    let head = if cfg!(windows) {
        crate::i18n::text_system::prev_session_oom_head_windows()
    } else {
        crate::i18n::text_system::prev_session_oom_head_os_killed()
    };
    let mut bits: Vec<String> = Vec::new();
    if s.scope_procs > 0 {
        bits.push(crate::i18n::text_system::prev_session_bit_scope_procs(s.scope_procs));
    }
    if s.anchor_full_avg10 > 0.0 {
        bits.push(crate::i18n::text_system::prev_session_bit_memory_pressure(s.anchor_full_avg10));
    }
    if s.available {
        bits.push(crate::i18n::text_system::prev_session_bit_free_memory(s.mem_available_pct));
    }
    if s.swap_used_pct > 0.0 {
        bits.push(format!("{} {:.0}%", super::swap_label(), s.swap_used_pct));
    }
    let base = if bits.is_empty() {
        head.to_string()
    } else {
        crate::i18n::text_system::prev_session_oom_with_bits(head, &bits.join(", "))
    };
    match top_summary(&s.top) {
        Some(t) => format!("{base} {t}."),
        None => base,
    }
}

/// 종료 직전 상위 프로세스를 **이름별로 묶어** 위에서 4개까지.
///
/// 개별 나열하면 안 된다 — WebView2는 4~6개, pwsh는 터미널 수만큼 뜨므로 상위 8개가 전부
/// 같은 이름으로 차서 정작 "우리 프로세스가 1.1GB였다"가 목록 밖으로 밀린다.
fn top_summary(top: &[TopProc]) -> Option<String> {
    if top.is_empty() {
        return None;
    }
    let mut groups: Vec<(&str, u64, u32)> = Vec::new();
    for p in top {
        match groups.iter_mut().find(|(n, _, _)| *n == p.name) {
            Some(g) => {
                g.1 += p.bytes;
                g.2 += 1;
            }
            None => groups.push((&p.name, p.bytes, 1)),
        }
    }
    groups.sort_by(|a, b| b.1.cmp(&a.1));
    let listed = groups
        .iter()
        .take(4)
        .map(|(name, bytes, count)| {
            let gb = *bytes as f32 / 1_073_741_824.0;
            if *count > 1 {
                crate::i18n::text_system::prev_session_top_group_entry(name, gb, *count)
            } else {
                format!("{name} {gb:.1}GB")
            }
        })
        .collect::<Vec<_>>()
        .join(" · ");
    Some(crate::i18n::text_system::prev_session_top_procs(&listed))
}

/// 할당 실패 표식을 읽고 밀어낸다 — 지난 세션의 것인지는 mtime으로 가른다.
///
/// 하트비트는 최대 30초 낡을 수 있고 표식은 그 **뒤에** 쓰이므로, 하한만 둔다(−180초).
/// 다음 실행에서 같은 표식을 다시 판정하지 않도록 읽었든 아니든 곧바로 rename 한다.
fn take_alloc_marker(log_dir: &Path, prev: Option<&SessionRecord>) -> Option<u64> {
    let path = log_dir.join(ALLOC_FAIL);
    let meta = std::fs::metadata(&path).ok()?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::rename(&path, log_dir.join(ALLOC_FAIL_PREV));

    let updated = chrono::DateTime::parse_from_rfc3339(&prev?.updated_at).ok()?;
    let mtime: chrono::DateTime<chrono::Local> = meta.modified().ok()?.into();
    if (mtime - updated.with_timezone(&chrono::Local)).num_seconds() < -180 {
        return None; // 지난 세션보다 한참 앞선 표식 — 그 세션의 것이 아니다.
    }
    text.split("bytes=").nth(1)?.trim().parse::<u64>().ok()
}

/// 이전 세션 기록으로 비정상 종료 여부와 원인을 판정한다(순수 함수 — 테스트 대상).
///
/// `clean_exit == false`가 유일한 "비정상" 근거다. systemd-oomd나 커널 OOM Killer는 SIGKILL을
/// 쓰므로 어떤 종료 훅도 돌지 않고, 패닉이 아니라 `panic.log`도 남지 않는다 — 살아있는 동안
/// 미리 적어둔 이 플래그 말고는 사후에 알 방법이 없다.
///
/// 근거의 우선순위는 **직접적일수록 위**다:
/// 할당 실패 표식 > 패닉 로그 > OS가 기록한 앱 크래시 > 전원/재부팅 > 죽기 직전 지표(oom) > 불명.
/// 지표(맨 아래)는 정황일 뿐이라 위의 직접 증거가 있으면 뒤로 물러나야 한다 — 전원 차단으로
/// 꺼진 앱을 "메모리 부족"으로 단정하면 사용자가 엉뚱한 곳을 손보게 된다.
fn classify(
    prev: Option<&SessionRecord>,
    panicked: bool,
    alloc_fail: Option<u64>,
    events: &[OsEvent],
) -> PrevSession {
    let clean = |()| PrevSession {
        crashed: false,
        verdict: "clean".into(),
        message: String::new(),
        record: None,
        os_events: Vec::new(),
    };
    let Some(rec) = prev else { return clean(()) };
    if rec.clean_exit {
        return clean(());
    }
    // 죽기 직전 지표가 "메모리 때문"을 가리키는가.
    //
    // 예전엔 리눅스 전용 신호(`anchor_full_avg10`)와 프로세스 수만 봤다. Windows에는 PSI가
    // 없어 그 값이 **항상 0**이었고, 결과적으로 Windows 크래시는 프로세스 폭주가 아닌 한
    // 전부 "unknown"으로 떨어졌다 — 사후 진단이 유일한 안전망인 플랫폼에서 그게 늘 "모르겠다"고
    // 답한 것이다. Windows 프로브가 채우는 신호(여유 물리 메모리·커밋 차지)를 함께 본다.
    // **0.0은 "여유 0%"가 아니라 "측정 못 함"이다.** 이걸 구분하지 않으면 지표가 하나도 없는
    // 기록(구 버전 세션, 프로브 실패)이 전부 메모리 원인으로 오진된다.
    let mem = rec.last.mem_available_pct;
    let mem_measured = rec.last.available && mem > 0.0;
    let pressured = rec.level == "warn"
        || rec.level == "danger"
        || rec.last.anchor_full_avg10 >= 15.0
        // 임계는 살아있는 판정과 **같은 상수**에서 가져온다. 여기에 리눅스 값(120)을 박아 두면
        // Windows 평상치(Claude 세션 8개 = 164~253개)가 사후 진단에서만 계속 "프로세스 폭주"로
        // 읽힌다 — 태스크 69가 T_PROCS를 플랫폼별로 가른 뒤 이 자리만 남아 있었다.
        || rec.last.scope_procs >= T_PROCS[1]
        // 여유 메모리가 경고선(8%) 아래였거나, 빠듯한 채로 커밋/스왑이 위험선을 넘고 있었다.
        || (mem_measured && mem <= 8.0)
        || (mem_measured && mem <= 15.0 && rec.last.swap_used_pct >= 85.0);
    // OS 이벤트에서 근거를 골라낸다. 크래시는 **우리 프로세스 것만** 인정한다 —
    // WebView2 렌더러가 죽어도 앱 프로세스는 살아 있으므로 그것으로 종료를 단정할 수 없다.
    //
    // 그리고 "우리 프로세스"는 exe 이름만으로 못 가른다. dev 인스턴스와 설치본은 같은
    // gitpervisor.exe이고 이 저장소는 둘을 나란히 띄우는 게 기본 워크플로다(CLAUDE.md) —
    // 이벤트 로그는 머신 전역이라 남의 인스턴스 크래시가 그대로 걸린다(dev는 재빌드마다
    // 죽으므로 그쪽 이벤트가 훨씬 흔하다). 1000의 faulting process id를 지난 세션 pid와
    // 대조해 가른다(pid를 못 읽은 옛 이벤트는 지금처럼 통과).
    //
    // **1001(WER)은 판정 근거에서 뺀다.** EventData에 pid 필드가 없어 같은 방식으로 가를 수
    // 없는데, 실제 크래시는 1000을 항상 함께 남기므로 1001이 더 주는 정보가 없다. 근거
    // 목록(os_events)에는 그대로 남아 사용자에게 보인다.
    let crash_ev = events
        .iter()
        .find(|e| e.own_app && e.id == 1000 && e.pid.is_none_or(|p| p == rec.pid));
    let power_ev = events.iter().find(|e| e.id == 6008 || e.id == 41);
    let reboot_ev = events.iter().find(|e| e.id == 1074);
    let exhaust: Vec<&OsEvent> = events.iter().filter(|e| e.id == 2004).collect();

    let (verdict, message) = if let Some(bytes) = alloc_fail {
        (
            "oom",
            crate::i18n::text_system::prev_session_alloc_failed(bytes),
        )
    } else if panicked {
        (
            "panic",
            crate::i18n::text_system::prev_session_panic().to_string(),
        )
    } else if let Some(e) = crash_ev {
        (
            "crash",
            crate::i18n::text_system::prev_session_crash(&e.text),
        )
    } else if let Some(e) = power_ev {
        (
            "power",
            crate::i18n::text_system::prev_session_power(&e.text),
        )
    } else if let Some(e) = reboot_ev {
        (
            "reboot",
            crate::i18n::text_system::prev_session_windows_restart(&e.text),
        )
    } else if pressured || !exhaust.is_empty() {
        let mut m = oom_message(&rec.last);
        for e in &exhaust {
            m.push(' ');
            m.push_str(&e.text);
        }
        ("oom", m)
    } else {
        (
            "unknown",
            crate::i18n::text_system::prev_session_unknown().to_string(),
        )
    };
    PrevSession {
        crashed: true,
        verdict: verdict.into(),
        message,
        record: Some(rec.clone()),
        os_events: events.iter().map(|e| e.text.clone()).collect(),
    }
}

/// 30초마다 현재 상태를 갱신한다(원자적 쓰기 — 부분 기록으로 파일이 깨지지 않는다).
/// 종료가 이미 기록됐으면 아무것도 하지 않는다(정상 종료 표시를 되돌리지 않기 위해).
pub fn heartbeat(level: &str, sample: &Sample, version: &str, started_at: &str) {
    if CLOSED.load(Ordering::Acquire) {
        return;
    }
    write(&SessionRecord {
        pid: std::process::id(),
        version: version.to_string(),
        started_at: started_at.to_string(),
        updated_at: now(),
        clean_exit: false,
        level: level.to_string(),
        last: sample.clone(),
    });
}

/// 정상 종료 표시. 이게 찍혀 있으면 다음 실행에서 경고를 띄우지 않는다.
/// 표시 후에는 빗장을 걸어 하트비트가 되돌리지 못하게 한다.
pub fn mark_clean() {
    // 빗장을 먼저 건다 — 이 뒤로 시작되는 하트비트는 즉시 반환한다.
    CLOSED.store(true, Ordering::Release);
    let Some(path) = SESSION_PATH.get() else {
        return;
    };
    // 이미 진행 중이던 하트비트가 끝나기를 기다린 뒤 마지막 상태를 읽는다.
    let guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rec = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<SessionRecord>(&t).ok())
        .unwrap_or_default();
    rec.clean_exit = true;
    rec.updated_at = now();
    write_locked(&rec, path);
    drop(guard);
}

pub fn previous() -> PrevSession {
    PREV.get().cloned().unwrap_or(PrevSession {
        crashed: false,
        verdict: "clean".into(),
        message: String::new(),
        record: None,
        os_events: Vec::new(),
    })
}

fn write(rec: &SessionRecord) {
    let Some(path) = SESSION_PATH.get() else {
        return;
    };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_locked(rec, path);
}

/// 실제 쓰기. 호출자가 WRITE_LOCK을 쥐고 있어야 한다.
fn write_locked(rec: &SessionRecord, path: &Path) {
    let Ok(json) = serde_json::to_string_pretty(rec) else {
        return;
    };
    // tmp에 쓰고 rename — SIGKILL이 쓰기 도중에 떨어져도 기존 파일이 온전하게 남는다.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn now() -> String {
    chrono::Local::now().to_rfc3339()
}

/// panic.log가 지난 세션의 마지막 기록 시각 근처(±3분)에 쓰였는지 — 패닉/OOM 구분용.
fn panic_log_near(log_dir: &Path, prev: Option<&SessionRecord>) -> bool {
    let Some(updated_at) = prev.map(|r| r.updated_at.as_str()) else {
        return false;
    };
    let Ok(meta) = std::fs::metadata(log_dir.join("panic.log")) else {
        return false;
    };
    let Ok(mtime) = meta.modified() else {
        return false;
    };
    let Ok(updated) = chrono::DateTime::parse_from_rfc3339(updated_at) else {
        return false;
    };
    let mtime: chrono::DateTime<chrono::Local> = mtime.into();
    (mtime - updated.with_timezone(&chrono::Local))
        .num_seconds()
        .abs()
        < 180
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 이벤트 없이 판정 — 기존 테스트가 쓰던 2인자 형태를 유지한다.
    fn classify(prev: Option<&SessionRecord>, panicked: bool) -> PrevSession {
        super::classify(prev, panicked, None, &[])
    }

    fn ev(id: u32, own_app: bool, text: &str) -> OsEvent {
        OsEvent {
            id,
            own_app,
            at: None,
            pid: None,
            text: text.into(),
        }
    }

    fn rec(clean: bool, level: &str, procs: u32, pressure: f32) -> SessionRecord {
        SessionRecord {
            pid: 1234,
            version: "0.3.3".into(),
            started_at: "2026-08-02T15:00:00+09:00".into(),
            updated_at: "2026-08-02T15:40:00+09:00".into(),
            clean_exit: clean,
            level: level.into(),
            last: Sample {
                anchor_full_avg10: pressure,
                scope_procs: procs,
                available: true,
                ..Sample::default()
            },
        }
    }

    /// 기록이 없으면(첫 실행) 경고하지 않는다.
    #[test]
    fn no_record_is_clean() {
        assert!(!classify(None, false).crashed);
    }

    /// 정상 종료 표시가 있으면 경고하지 않는다.
    #[test]
    fn clean_exit_is_clean() {
        assert!(!classify(Some(&rec(true, "ok", 3, 0.0)), false).crashed);
    }

    /// **핵심**: systemd-oomd의 SIGKILL은 종료 훅을 못 돌리므로 clean_exit=false가 남는다.
    /// 그때 압박·프로세스 지표가 높으면 OOM으로 판정해야 한다(2026-08-01 사건 재현).
    #[test]
    fn oom_kill_is_detected() {
        let v = classify(Some(&rec(false, "danger", 371, 44.0)), false);
        assert!(v.crashed);
        assert_eq!(v.verdict, "oom");
        assert!(v.message.contains("371"), "{}", v.message);
    }

    /// 지표가 한가했는데 clean_exit만 없으면 원인 불명으로 — 과잉 단정 금지.
    #[test]
    fn quiet_metrics_are_unknown_not_oom() {
        let v = classify(Some(&rec(false, "ok", 3, 0.0)), false);
        assert!(v.crashed);
        assert_eq!(v.verdict, "unknown");
    }

    /// panic.log가 같은 시각대에 있으면 패닉으로 분류(OOM보다 우선).
    #[test]
    fn panic_takes_precedence() {
        let v = classify(Some(&rec(false, "danger", 371, 44.0)), true);
        assert_eq!(v.verdict, "panic");
    }

    /// 프로세스 폭주만으로도(레벨이 ok로 기록됐어도) OOM으로 본다.
    /// 기준은 `T_PROCS`에서 가져온다 — 플랫폼 평상치가 다르므로 숫자를 박으면 한쪽에서 오진한다.
    #[test]
    fn process_explosion_alone_implies_oom() {
        let v = classify(Some(&rec(false, "ok", T_PROCS[1], 0.0)), false);
        assert_eq!(v.verdict, "oom");
    }

    /// 그 플랫폼의 평상치(경고 기준 바로 아래)는 폭주가 아니다 — Windows에서 Claude 세션 몇
    /// 개가 곧 "메모리 부족으로 종료됨" 배너가 되던 자리다.
    #[test]
    fn ordinary_process_count_is_not_an_explosion() {
        let v = classify(Some(&rec(false, "ok", T_PROCS[1] - 1, 0.0)), false);
        assert_eq!(v.verdict, "unknown", "{}", v.message);
    }

    /// Windows 신호(여유 물리 메모리)만으로도 원인을 짚어야 한다.
    /// Windows엔 PSI가 없어 예전에는 프로세스 폭주가 아닌 한 전부 "unknown"이었다.
    #[test]
    fn low_available_memory_implies_oom_without_psi() {
        let mut r = rec(false, "ok", 12, 0.0);
        r.last.mem_available_pct = 3.0; // 여유 3% — 위험선 아래
        let v = classify(Some(&r), false);
        assert_eq!(v.verdict, "oom", "{}", v.message);
        assert!(
            !v.message.contains("압박"),
            "측정되지 않은 신호를 문구에 넣으면 안 된다: {}",
            v.message
        );
        assert!(v.message.contains("여유 메모리 3%"), "{}", v.message);
    }

    /// 커밋(스왑)이 높아도 여유 메모리가 넉넉하면 원인으로 단정하지 않는다.
    /// Windows는 평상시에도 커밋이 높게 유지되므로 단독 판정하면 상시 오진이 된다.
    #[test]
    fn high_commit_alone_is_not_oom() {
        let mut r = rec(false, "ok", 12, 0.0);
        r.last.mem_available_pct = 55.0;
        r.last.swap_used_pct = 92.0;
        assert_eq!(classify(Some(&r), false).verdict, "unknown");
    }

    /// 지표가 하나도 없는 기록(구 버전 세션·프로브 실패)은 메모리 원인으로 몰면 안 된다.
    /// `mem_available_pct == 0.0`은 "여유 0%"가 아니라 "측정 못 함"이다.
    #[test]
    fn unmeasured_metrics_are_not_read_as_zero_percent() {
        let mut r = rec(false, "ok", 3, 0.0);
        r.last.mem_available_pct = 0.0;
        r.last.swap_used_pct = 0.0;
        assert_eq!(
            classify(Some(&r), false).verdict,
            "unknown",
            "측정 안 된 0%를 위험으로 읽었다"
        );
    }

    /// 할당 실패 표식은 모든 근거를 이긴다 — 가장 직접적인 증거다.
    #[test]
    fn alloc_marker_outranks_everything() {
        let r = rec(false, "danger", 371, 44.0);
        let v = super::classify(
            Some(&r),
            true, // 패닉 로그까지 있어도
            Some(1_073_741_824),
            &[ev(6008, false, "시스템이 예기치 않게 종료됨(6008)")],
        );
        assert_eq!(v.verdict, "oom");
        assert!(v.message.contains("1073741824"), "{}", v.message);
    }

    /// 전원 차단으로 꺼졌는데 죽기 직전 지표가 빠듯했다고 "메모리 부족"으로 단정하면
    /// 사용자가 엉뚱한 곳(메모리)을 손보게 된다 — OS 기록이 정황보다 우선한다.
    #[test]
    fn power_event_outranks_pressure_metrics() {
        let mut r = rec(false, "warn", 12, 0.0);
        r.last.mem_available_pct = 3.0;
        let v = super::classify(
            Some(&r),
            false,
            None,
            &[ev(41, false, "커널 전원 이벤트(41) BugcheckCode=0 (0이면 전원 차단·강제 리셋)")],
        );
        assert_eq!(v.verdict, "power", "{}", v.message);
        assert!(v.message.contains("앱 문제가 아닐 수 있습니다"), "{}", v.message);
        assert_eq!(v.os_events.len(), 1);
    }

    /// 우리 프로세스의 크래시 기록이 있으면 "crash"로 확정하고 예외 코드를 그대로 보여준다.
    #[test]
    fn own_app_crash_event_wins_over_metrics() {
        let mut r = rec(false, "warn", 12, 0.0);
        r.last.mem_available_pct = 3.0;
        let v = super::classify(
            Some(&r),
            false,
            None,
            &[ev(
                1000,
                true,
                "앱 크래시(1000) gitpervisor.exe 예외 코드 0xc0000409 — abort/fastfail(Rust 할당 실패 포함)",
            )],
        );
        assert_eq!(v.verdict, "crash");
        assert!(v.message.contains("0xc0000409"), "{}", v.message);
    }

    /// **다른 인스턴스의 크래시를 가져오면 안 된다.** dev와 설치본은 같은 exe 이름이라
    /// 이벤트 로그에서는 pid로만 갈린다 — 남의 1000이 crash로 확정되면 진짜 원인(저메모리)이
    /// 통째로 가려지고 남의 예외 코드가 사용자 문구에 박힌다.
    #[test]
    fn crash_event_from_other_instance_is_ignored() {
        let mut r = rec(false, "warn", 12, 0.0); // pid 1234
        r.last.mem_available_pct = 3.0;
        let mut e = ev(1000, true, "앱 크래시(1000) gitpervisor.exe 예외 코드 0x80000003");
        e.pid = Some(9999); // dev 인스턴스
        let v = super::classify(Some(&r), false, None, &[e]);
        assert_eq!(v.verdict, "oom", "{}", v.message);
        assert_eq!(v.os_events.len(), 1, "근거는 그대로 남겨야 한다");
    }

    /// pid가 일치하면 그대로 crash로 확정한다.
    #[test]
    fn crash_event_with_matching_pid_is_ours() {
        let r = rec(false, "warn", 12, 0.0); // pid 1234
        let mut e = ev(1000, true, "앱 크래시(1000) gitpervisor.exe 예외 코드 0xc0000409");
        e.pid = Some(1234);
        assert_eq!(super::classify(Some(&r), false, None, &[e]).verdict, "crash");
    }

    /// WER 1001은 pid를 담지 않아 인스턴스를 가를 수 없다 — 판정 근거에서 뺀다.
    /// 실제 크래시는 1000을 항상 함께 남기므로 잃는 정보가 없다.
    #[test]
    fn wer_1001_alone_does_not_decide_crash() {
        let r = rec(false, "ok", 3, 0.0);
        let v = super::classify(
            Some(&r),
            false,
            None,
            &[ev(1001, true, "오류 보고(WER 1001) gitpervisor.exe APPCRASH")],
        );
        assert_eq!(v.verdict, "unknown", "{}", v.message);
        assert_eq!(v.os_events.len(), 1);
    }

    /// WebView2 렌더러 크래시(own_app=false)로 앱 종료를 단정하면 안 된다 —
    /// 렌더러가 죽어도 앱 프로세스는 살아 있다.
    #[test]
    fn webview_crash_alone_does_not_become_app_crash() {
        let r = rec(false, "ok", 3, 0.0);
        let v = super::classify(
            Some(&r),
            false,
            None,
            &[ev(1000, false, "WebView2 프로세스 크래시(1000) msedgewebview2.exe …")],
        );
        assert_eq!(v.verdict, "unknown", "{}", v.message);
        assert_eq!(v.os_events.len(), 1, "근거는 그대로 남겨야 한다");
    }

    /// 커밋 고갈(2004)은 지표가 한가해 보여도 oom을 확정하고 상위 소비자를 덧붙인다.
    #[test]
    fn commit_exhaustion_event_implies_oom() {
        let r = rec(false, "ok", 3, 0.0);
        let v = super::classify(
            Some(&r),
            false,
            None,
            &[ev(2004, false, "커밋 한도 고갈(2004): 상위 소비 warp.exe 28.4GB")],
        );
        assert_eq!(v.verdict, "oom");
        assert!(v.message.contains("warp.exe 28.4GB"), "{}", v.message);
    }

    /// 상위 프로세스는 **이름별로 묶여야** 한다. 안 묶으면 WebView2 6개가 목록을 다 채워
    /// 정작 우리 프로세스가 밖으로 밀린다(2026-09-02 NTS 사건의 실제 구성).
    #[test]
    fn oom_message_groups_top_processes_by_name() {
        let mut r = rec(false, "danger", 15, 0.0);
        r.last.mem_available_pct = 6.0;
        r.last.top = vec![
            TopProc { name: "gitpervisor.exe".into(), pid: 100, bytes: 1_181_116_006 },
            TopProc { name: "msedgewebview2.exe".into(), pid: 101, bytes: 322_122_547 },
            TopProc { name: "msedgewebview2.exe".into(), pid: 102, bytes: 214_748_364 },
            TopProc { name: "msedgewebview2.exe".into(), pid: 103, bytes: 107_374_182 },
            TopProc { name: "pwsh.exe".into(), pid: 104, bytes: 104_857_600 },
            TopProc { name: "pwsh.exe".into(), pid: 105, bytes: 104_857_600 },
        ];
        let v = classify(Some(&r), false);
        assert_eq!(v.verdict, "oom");
        assert!(v.message.contains("gitpervisor.exe 1.1GB"), "{}", v.message);
        assert!(v.message.contains("msedgewebview2.exe 0.6GB(3개)"), "{}", v.message);
        assert!(v.message.contains("pwsh.exe 0.2GB(2개)"), "{}", v.message);
    }

    /// 옛 세션 파일(top 없음)에서도 문구가 그대로 나와야 한다 — serde default 회귀 방지.
    #[test]
    fn missing_top_field_keeps_old_message() {
        let mut r = rec(false, "ok", 12, 0.0);
        r.last.mem_available_pct = 3.0;
        let v = classify(Some(&r), false);
        assert_eq!(v.verdict, "oom");
        assert!(!v.message.contains("가장 큰 프로세스"), "{}", v.message);
    }
}
