//! macOS 크래시 리포트(`~/Library/Logs/DiagnosticReports/gitpervisor-*.ips`) 상관 조회 —
//! Windows 이벤트 로그(`winlog`)의 macOS 짝이다.
//!
//! 배경(2026-11-11): 6일 켜 둔 앱이 macOS WebKit 안에서 SIGSEGV로 죽었다
//! (`WebCore::ScrollingTree::takePendingScrollUpdates`). 앱 로그에는 아무것도 없어 재시작 배너가
//! "원인을 특정하지 못했습니다"만 띄웠는데, OS는 예외 종류·크래시 위치를 전부 리포트로 남겨 두고 있었다.
//!
//! **리포트는 크래시보다 늦게 써진다.** ReportCrash가 심볼을 붙인 뒤에 파일을 쓰기 때문이다 —
//! 위 사건은 크래시 21:45:56, 파일 21:46:48(52초)였고 사용자는 11초 만에 앱을 다시 켰다. 그래서 시작 때
//! 한 번 보고 없으면 [`spawn_report_waiter`]가 잠시 더 기다렸다가 판정을 고친다.
//!
//! 판정 갈래는 Windows Application Error와 같은 자리에 둔다 — `id`를 1000으로 주면 `session::classify`가
//! 그대로 "crash"로 확정하고, pid 대조로 dev 인스턴스(같은 실행 파일 이름)의 리포트를 걸러 낸다.

use chrono::{DateTime, Local, Utc};
use serde_json::Value;

use super::winlog::{EventSource, OsEvent};

/// 리포트 한 건에서 사용자에게 보여 줄 것만 추린 것. 문장은 [`render`]가 부를 때마다 지금 UI 언어로 만든다.
#[derive(Debug, Clone)]
pub struct MacCrashReport {
    /// `EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS at 0x…` — OS가 준 그대로(언어와 무관한 식별자다).
    exception: String,
    /// 크래시한 스레드의 첫 의미 있는 프레임 — `심볼 (이미지)` 또는 심볼이 없으면 `이미지 +0x오프셋`.
    location: String,
    origin: CrashOrigin,
    /// abort 류가 남기는 Application Specific Information 첫 줄(있을 때만).
    abort_message: Option<String>,
}

/// 크래시 위치가 누구 코드인가 — 사용자가 "앱을 고쳐야 하나, OS 문제인가"를 가르는 근거다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum CrashOrigin {
    /// macOS 시스템 웹 엔진(WebKit·WebCore·JavaScriptCore) — 앱 코드로 직접 막을 수 없다.
    WebKit,
    /// 우리 실행 파일.
    App,
    #[default]
    Other,
}

/// 지난 세션(pid)의 크래시 리포트를 찾는다. macOS가 아니면 항상 빈 목록.
#[cfg(not(target_os = "macos"))]
pub fn query_around(_pid: u32, _updated_at: DateTime<Local>) -> Vec<OsEvent> {
    Vec::new()
}

#[cfg(target_os = "macos")]
pub fn query_around(pid: u32, updated_at: DateTime<Local>) -> Vec<OsEvent> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    let dir = std::path::Path::new(&home).join("Library/Logs/DiagnosticReports");
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("[health] 크래시 리포트 폴더를 읽지 못함 {}: {e}", dir.display());
            return Vec::new();
        }
    };
    // 하트비트는 30초마다라 크래시는 updated_at 뒤에 난다. 하한만 넉넉히 두고, 나머지는 pid로 가른다.
    let floor: std::time::SystemTime = (updated_at - chrono::Duration::seconds(120)).into();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("gitpervisor") || !name.ends_with(".ips") {
            continue;
        }
        let fresh = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| t >= floor);
        if !fresh {
            continue;
        }
        let path = entry.path();
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("[health] 크래시 리포트를 읽지 못함 {}: {e}", path.display());
                continue;
            }
        };
        if let Some(ev) = parse(&text).filter(|ev| ev.pid == Some(pid)) {
            log::info!("[health] 지난 실행의 크래시 리포트: {}", path.display());
            out.push(ev);
        }
    }
    out
}

/// 시작 때 리포트가 아직 없었으면 잠시 기다렸다가, 찾는 순간 판정을 고치고 배너에 알린다.
///
/// 5초 간격으로 3분 — 리포트가 아예 안 생기는 종료(전원 차단·강제 종료·메모리 압박 SIGKILL)도 있으니
/// 끝없이 기다리지 않는다. 디렉터리 목록 한 번이라 간격당 비용은 무시할 만하다.
#[cfg(target_os = "macos")]
pub fn spawn_report_waiter(app: tauri::AppHandle, pid: u32, updated_at: DateTime<Local>) {
    use tauri::Emitter;
    let spawned = std::thread::Builder::new()
        .name("crash-report-wait".into())
        .spawn(move || {
            for _ in 0..36 {
                std::thread::sleep(std::time::Duration::from_secs(5));
                let found = query_around(pid, updated_at);
                if found.is_empty() {
                    continue;
                }
                super::session::add_late_events(found);
                if let Err(e) = app.emit("health://prev-session", ()) {
                    log::warn!("[health] 지난 실행 판정 갱신 알림 실패: {e}");
                }
                return;
            }
            log::info!("[health] 3분 동안 pid {pid} 의 크래시 리포트가 생기지 않음 — 리포트를 남기지 않는 종료로 본다");
        });
    if let Err(e) = spawned {
        log::warn!("[health] 크래시 리포트 대기 스레드 시작 실패: {e}");
    }
}

/// `.ips` 한 파일을 판정용 이벤트로. 크래시 리포트(bug_type 309)가 아니거나 깨졌으면 None.
///
/// 형식: 첫 줄이 헤더 JSON, 나머지가 본문 JSON이다.
// 비-macOS에선 query_around가 부르지 않지만 파서 테스트는 모든 타깃에서 돈다(winlog::parse와 같은 이유).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse(text: &str) -> Option<OsEvent> {
    let (head, body) = text.split_once('\n')?;
    let head: Value = serde_json::from_str(head).ok()?;
    // 309 = 크래시. 288(스택샷)·211(분석) 같은 다른 종류는 앱 종료의 근거가 아니다.
    if head.get("bug_type")?.as_str()? != "309" {
        return None;
    }
    let body: Value = serde_json::from_str(body).ok()?;
    let pid = body.get("pid")?.as_u64().and_then(|p| u32::try_from(p).ok())?;
    // captureTime 이 크래시 시각이다. 헤더 timestamp 는 파일을 쓴 시각이라 수십 초 늦다(모듈 주석).
    let at = body
        .get("captureTime")
        .and_then(Value::as_str)
        .and_then(parse_time)
        .or_else(|| head.get("timestamp").and_then(Value::as_str).and_then(parse_time));

    let exc = body.get("exception");
    let field = |v: Option<&Value>, k: &str| {
        v.and_then(|v| v.get(k))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let kind = field(exc, "type");
    let signal = field(exc, "signal");
    let subtype = field(exc, "subtype");
    let mut exception = match (kind.is_empty(), signal.is_empty()) {
        (false, false) => format!("{kind} ({signal})"),
        (false, true) => kind,
        (true, false) => signal,
        // 예외 정보가 없으면 종료 사유("Segmentation fault: 11" 등)라도 보여 준다.
        (true, true) => field(body.get("termination"), "indicator"),
    };
    if !subtype.is_empty() {
        exception.push(' ');
        exception.push_str(&subtype);
    }

    let proc_name = body.get("procName").and_then(Value::as_str).unwrap_or("gitpervisor");
    let (location, origin) = crash_location(&body, proc_name).unwrap_or_default();
    Some(OsEvent {
        id: 1000,
        own_app: true,
        at,
        pid: Some(pid),
        source: EventSource::MacCrash(MacCrashReport {
            exception,
            location,
            origin,
            abort_message: abort_message(&body),
        }),
    })
}

/// `2026-11-11 21:45:56.3202 +0900` 꼴.
fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S%.f %z")
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// 크래시한 스레드의 첫 의미 있는 프레임. libsystem·libc++ 같은 바닥 라이브러리는 건너뛴다 —
/// abort 류는 맨 위가 늘 `__pthread_kill`이라 그걸 보여 주면 아무것도 알려 주지 않는다.
fn crash_location(body: &Value, proc_name: &str) -> Option<(String, CrashOrigin)> {
    let images = body.get("usedImages")?.as_array()?;
    let threads = body.get("threads")?.as_array()?;
    let thread = match body.get("faultingThread").and_then(Value::as_u64) {
        Some(i) => threads.get(usize::try_from(i).ok()?)?,
        None => threads
            .iter()
            .find(|t| t.get("triggered").and_then(Value::as_bool) == Some(true))?,
    };
    let frames = thread.get("frames")?.as_array()?;
    let named = frames.iter().map(|f| {
        let image = f
            .get("imageIndex")
            .and_then(Value::as_u64)
            .and_then(|i| images.get(usize::try_from(i).ok()?))
            .and_then(|im| im.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("?");
        (f, image)
    });
    let mut first = None;
    for (frame, image) in named {
        first.get_or_insert((frame, image));
        if !is_runtime_floor(image) {
            return Some(describe(frame, image, proc_name));
        }
    }
    // 전부 바닥 라이브러리면 맨 위 프레임이라도.
    first.map(|(frame, image)| describe(frame, image, proc_name))
}

fn describe(frame: &Value, image: &str, proc_name: &str) -> (String, CrashOrigin) {
    let text = match frame.get("symbol").and_then(Value::as_str) {
        Some(sym) => format!("{sym} ({image})"),
        // 우리 릴리스 바이너리는 심볼이 벗겨져 있다 — 오프셋이 있어야 나중에 dSYM 없이도 같은 자리인지 맞춰 본다.
        None => {
            let off = frame.get("imageOffset").and_then(Value::as_u64).unwrap_or(0);
            format!("{image} +0x{off:x}")
        }
    };
    (text, origin_of(image, proc_name))
}

fn is_runtime_floor(image: &str) -> bool {
    ["libsystem_", "libc++", "libobjc", "libdispatch", "libdyld", "dyld"]
        .iter()
        .any(|p| image.starts_with(p))
}

fn origin_of(image: &str, proc_name: &str) -> CrashOrigin {
    if ["WebCore", "WebKit", "JavaScriptCore", "WebGPU", "WebKitLegacy"].contains(&image) {
        CrashOrigin::WebKit
    } else if image == proc_name || image.starts_with("gitpervisor") {
        CrashOrigin::App
    } else {
        CrashOrigin::Other
    }
}

/// `"asi": {"libsystem_c.dylib": ["abort() called"]}` 의 첫 줄. 길면 자른다(배너 한 줄이다).
fn abort_message(body: &Value) -> Option<String> {
    let line = body
        .get("asi")?
        .as_object()?
        .values()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .find(|s| !s.is_empty())?;
    Some(line.chars().take(160).collect())
}

/// 사용자에게 보여 줄 한 줄 — 지금 UI 언어.
pub fn render(r: &MacCrashReport, at: Option<DateTime<Utc>>) -> String {
    let mut exception = r.exception.clone();
    if let Some(m) = &r.abort_message {
        exception.push_str(&format!(" \"{m}\""));
    }
    let note = match r.origin {
        CrashOrigin::WebKit => format!(" — {}", crate::i18n::text_system::maccrash_note_webkit()),
        CrashOrigin::App => format!(" — {}", crate::i18n::text_system::maccrash_note_app_code()),
        CrashOrigin::Other => String::new(),
    };
    crate::i18n::text_system::maccrash_report_event(&exception, &r.location, &note, &super::winlog::stamp(at))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실물 축약 — 2026-11-11 21:45:56 이 맥(macOS 26.5)에서 설치본 v0.16.0 이 남긴
    /// `gitpervisor-2026-11-11-214648.ips`. 판정에 쓰는 필드만 남기고 기기 식별자는 뺐다.
    /// usedImages 는 프레임이 가리키는 셋만 남기며 번호를 0·1·2로 다시 매겼다.
    const REAL_WEBKIT_SEGV: &str = concat!(
        r#"{"app_name":"gitpervisor","timestamp":"2026-11-11 21:46:48.00 +0900","app_version":"0.16.6","bug_type":"309","os_version":"macOS 26.5 (25F71)","name":"gitpervisor"}"#,
        "\n",
        r#"{"captureTime":"2026-11-11 21:45:56.3202 +0900","pid":33518,"procName":"gitpervisor","procPath":"\/Applications\/Gitpervisor.app\/Contents\/MacOS\/gitpervisor","exception":{"codes":"0x0000000000000001, 0x0000000000000122","rawCodes":[1,290],"type":"EXC_BAD_ACCESS","signal":"SIGSEGV","subtype":"KERN_INVALID_ADDRESS at 0x0000000000000122"},"termination":{"flags":0,"code":11,"namespace":"SIGNAL","indicator":"Segmentation fault: 11","byProc":"exc handler","byPid":33518},"faultingThread":0,"threads":[{"triggered":true,"id":1,"queue":"com.apple.main-thread","frames":[{"imageOffset":41907620,"symbol":"WebCore::ScrollingTree::takePendingScrollUpdates()","symbolLocation":32,"imageIndex":1},{"imageOffset":14248812,"symbol":"WebKit::RemoteScrollingCoordinatorProxy::sendScrollingTreeNodeUpdate()","symbolLocation":88,"imageIndex":2},{"imageOffset":1231284,"imageIndex":0}]}],"usedImages":[{"name":"gitpervisor","path":"\/Applications\/Gitpervisor.app\/Contents\/MacOS\/gitpervisor"},{"name":"WebCore","CFBundleIdentifier":"com.apple.WebCore"},{"name":"WebKit","CFBundleIdentifier":"com.apple.WebKit"}]}"#,
    );

    /// 위 리포트가 그대로 "crash"로 확정되고, 예외·위치·WebKit 내부라는 해석이 문구에 실려야 한다.
    #[test]
    fn real_webkit_segv_becomes_crash_with_location() {
        let ev = parse(REAL_WEBKIT_SEGV).expect("실물 리포트를 못 읽었다");
        assert_eq!(ev.pid, Some(33518));
        assert!(ev.own_app);
        assert_eq!(
            ev.at.map(|t| t.to_rfc3339()),
            Some("2026-11-11T12:45:56.320200+00:00".into()),
            "captureTime(크래시 시각)을 써야 한다 — 헤더 timestamp 는 52초 늦은 파일 기록 시각이다"
        );
        let text = ev.text();
        assert!(text.contains("EXC_BAD_ACCESS (SIGSEGV) KERN_INVALID_ADDRESS at 0x0000000000000122"), "{text}");
        assert!(text.contains("WebCore::ScrollingTree::takePendingScrollUpdates() (WebCore)"), "{text}");
        assert!(text.contains("WebKit"), "{text}");

        let rec = super::super::session::SessionRecord {
            pid: 33518,
            clean_exit: false,
            level: "ok".into(),
            updated_at: "2026-11-11T21:45:49.498685+09:00".into(),
            ..Default::default()
        };
        let v = super::super::session::classify(Some(&rec), false, None, &[ev]);
        assert_eq!(v.verdict, "crash", "{}", v.message);
        assert!(v.message.contains("takePendingScrollUpdates"), "{}", v.message);
    }

    /// dev 인스턴스도 실행 파일 이름이 같다 — pid가 다른 리포트로 지난 세션을 판정하면 안 된다.
    #[test]
    fn report_from_other_pid_does_not_decide_crash() {
        let ev = parse(REAL_WEBKIT_SEGV).unwrap();
        let rec = super::super::session::SessionRecord {
            pid: 4242,
            clean_exit: false,
            level: "ok".into(),
            ..Default::default()
        };
        let v = super::super::session::classify(Some(&rec), false, None, &[ev]);
        assert_eq!(v.verdict, "unknown", "{}", v.message);
    }

    /// abort 류는 맨 위가 늘 libsystem 이다 — 그 아래 우리 프레임(심볼 없음)을 오프셋으로 짚어야 한다.
    #[test]
    fn abort_skips_libsystem_frames_and_shows_app_offset() {
        let text = concat!(
            r#"{"bug_type":"309","timestamp":"2026-11-12 10:00:05.00 +0900"}"#,
            "\n",
            r#"{"pid":7,"procName":"gitpervisor","exception":{"type":"EXC_CRASH","signal":"SIGABRT"},"asi":{"libsystem_c.dylib":["abort() called"]},"faultingThread":1,"threads":[{"frames":[]},{"frames":[{"imageOffset":1,"symbol":"__pthread_kill","imageIndex":1},{"imageOffset":2,"symbol":"abort","imageIndex":2},{"imageOffset":74565,"imageIndex":0}]}],"usedImages":[{"name":"gitpervisor"},{"name":"libsystem_kernel.dylib"},{"name":"libsystem_c.dylib"}]}"#,
        );
        let ev = parse(text).unwrap();
        let s = ev.text();
        assert!(s.contains("EXC_CRASH (SIGABRT) \"abort() called\""), "{s}");
        assert!(s.contains("gitpervisor +0x12345"), "{s}");
        assert!(!s.contains("WebKit"), "{s}");
        assert!(ev.at.is_some(), "captureTime 이 없으면 헤더 timestamp 로 물러나야 한다");
    }

    /// 크래시가 아닌 리포트(스택샷 288 등)는 종료의 근거가 아니다.
    #[test]
    fn non_crash_report_is_ignored() {
        let text = REAL_WEBKIT_SEGV.replacen("\"bug_type\":\"309\"", "\"bug_type\":\"288\"", 1);
        assert!(parse(&text).is_none());
    }

    /// 시작 경로(창 생성 전)에서 도는 파서다 — 쓰레기 입력에 패닉하면 앱이 안 뜬다.
    #[test]
    fn malformed_report_never_panics() {
        for s in [
            "",
            "{}",
            "{\"bug_type\":\"309\"}",
            "{\"bug_type\":\"309\"}\n{}",
            "{\"bug_type\":\"309\"}\n{\"pid\":1,\"faultingThread\":9,\"threads\":[]}",
            "{\"bug_type\":\"309\"}\n{\"pid\":1,\"threads\":[{\"frames\":[{\"imageIndex\":99}]}],\"usedImages\":[]}",
            "not json\nnot json",
        ] {
            let _ = parse(s).map(|e| e.text());
        }
    }
}
