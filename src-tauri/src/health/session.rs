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

use super::probe::Sample;

pub const CURRENT: &str = "session.json";
pub const PREVIOUS: &str = "session.prev.json";

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
    /// "oom" | "panic" | "unknown" | "clean"
    pub verdict: String,
    /// 사용자에게 보여줄 한국어 진단 문구.
    pub message: String,
    pub record: Option<SessionRecord>,
}

/// 시작 시 1회. 이전 세션 파일을 판정해 보관하고, 이번 세션 기록을 새로 연다.
pub fn begin(log_dir: &Path, version: &str) {
    let _ = std::fs::create_dir_all(log_dir);
    let current = log_dir.join(CURRENT);
    let _ = SESSION_PATH.set(current.clone());

    let prev = std::fs::read_to_string(&current)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionRecord>(&s).ok());

    let verdict = classify(prev.as_ref(), panic_log_near(log_dir, prev.as_ref()));
    if verdict.crashed {
        // 사후 분석용으로 보관 — prune_logs가 지우지 않도록 보존 목록에 있다.
        let _ = std::fs::rename(&current, log_dir.join(PREVIOUS));
        log::warn!(
            "[health] 지난 실행 비정상 종료 감지: {} — {}",
            verdict.verdict,
            verdict.message
        );
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

/// 이전 세션 기록으로 비정상 종료 여부와 원인을 판정한다(순수 함수 — 테스트 대상).
///
/// `clean_exit == false`가 유일한 "비정상" 근거다. systemd-oomd나 커널 OOM Killer는 SIGKILL을
/// 쓰므로 어떤 종료 훅도 돌지 않고, 패닉이 아니라 `panic.log`도 남지 않는다 — 살아있는 동안
/// 미리 적어둔 이 플래그 말고는 사후에 알 방법이 없다.
fn classify(prev: Option<&SessionRecord>, panicked: bool) -> PrevSession {
    let clean = |()| PrevSession {
        crashed: false,
        verdict: "clean".into(),
        message: String::new(),
        record: None,
    };
    let Some(rec) = prev else { return clean(()) };
    if rec.clean_exit {
        return clean(());
    }
    let pressured = rec.level == "warn"
        || rec.level == "danger"
        || rec.last.anchor_full_avg10 >= 15.0
        || rec.last.scope_procs >= 120;
    let (verdict, message) = if panicked {
        (
            "panic",
            "앱 내부 오류(패닉)로 종료된 것으로 보입니다. 진단 로그를 확인해 주세요.".to_string(),
        )
    } else if pressured {
        (
            "oom",
            format!(
                "메모리 부족으로 OS가 앱을 강제 종료한 것으로 보입니다. \
                 종료 직전 앱에 딸린 프로세스가 {}개, 메모리 압박이 {:.0}%였습니다.",
                rec.last.scope_procs, rec.last.anchor_full_avg10
            ),
        )
    } else {
        (
            "unknown",
            "원인을 특정하지 못했습니다(전원 차단·세션 종료 등일 수 있습니다).".to_string(),
        )
    };
    PrevSession {
        crashed: true,
        verdict: verdict.into(),
        message,
        record: Some(rec.clone()),
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
    #[test]
    fn process_explosion_alone_implies_oom() {
        let v = classify(Some(&rec(false, "ok", 200, 0.0)), false);
        assert_eq!(v.verdict, "oom");
    }
}
