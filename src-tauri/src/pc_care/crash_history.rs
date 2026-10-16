//! 비정상 종료 이력(블루스크린·전원 끊김·커널 패닉) — DOCS/pc-care-design.md §4.3.

use serde::Serialize;

use crate::error::IpcError;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CrashKind {
    Bugcheck,
    UnexpectedShutdown,
    #[cfg_attr(windows, allow(dead_code))]
    KernelPanic,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrashEvent {
    pub time_ms: i64,
    pub kind: CrashKind,
    pub code: Option<String>,
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrashHistory {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub events: Vec<CrashEvent>,
}

/// 같은 부팅에서 Kernel-Power 41과 EventLog 6008이 함께 남는다 — 이 간격 안이면 한 건으로 친다.
const SAME_BOOT_MS: i64 = 2 * 60 * 1000;
/// WER 1001은 재부팅 뒤 덤프를 처리하고서야 남아 41보다 늦다 — 코드가 같을 때만 쓰는 창이라 넉넉히 잡는다.
const BUGCHECK_REPORT_MS: i64 = 10 * 60 * 1000;

#[tauri::command(async)]
pub async fn crash_history_list() -> Result<CrashHistory, IpcError> {
    imp::list().await
}

/// `<tag ...>값</tag>` 또는 `<tag .../>`의 (속성 문자열, 값). 이벤트 XML은 wevtutil이 만든 고정 모양이라
/// 범용 파서 대신 문자열로 훑는다.
fn elements<'a>(xml: &'a str, tag: &str) -> Vec<(&'a str, &'a str)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        // `<DataX`처럼 이름이 더 긴 태그는 건너뛴다.
        if !after.starts_with([' ', '>', '/']) {
            rest = after;
            continue;
        }
        let Some(gt) = after.find('>') else { break };
        let attrs = &after[..gt];
        if let Some(attrs) = attrs.strip_suffix('/') {
            out.push((attrs, ""));
            rest = &after[gt + 1..];
            continue;
        }
        let body = &after[gt + 1..];
        let Some(end) = body.find(&close) else { break };
        out.push((attrs, &body[..end]));
        rest = &body[end + close.len()..];
    }
    out
}

fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    for q in ['\'', '"'] {
        let key = format!("{name}={q}");
        if let Some(i) = attrs.find(&key) {
            let v = &attrs[i + key.len()..];
            return v.find(q).map(|e| &v[..e]);
        }
    }
    None
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// `wevtutil qe System /f:xml` 출력(루트 없이 `<Event>`가 이어진다) → 최신순 이벤트. 같은 사건의 중복은 하나만 남긴다:
/// 6008은 ±2분 안의 41·1001에, 코드 있는 41은 같은 코드의 1001에 흡수된다.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
fn parse_wevtutil_xml(xml: &str) -> Vec<CrashEvent> {
    let mut raw: Vec<(u32, CrashEvent)> = Vec::new();
    for (_, ev) in elements(xml, "Event") {
        let Some(id) = elements(ev, "EventID").first().and_then(|(_, v)| v.trim().parse::<u32>().ok()) else {
            continue;
        };
        let Some(time_ms) = elements(ev, "TimeCreated")
            .first()
            .and_then(|(a, _)| attr(a, "SystemTime"))
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
        else {
            continue;
        };
        let data: Vec<(Option<&str>, String)> =
            elements(ev, "Data").into_iter().map(|(a, v)| (attr(a, "Name"), unescape(v.trim()))).collect();
        let named = |n: &str| data.iter().find(|(k, _)| *k == Some(n)).map(|(_, v)| v.as_str());
        let event = match id {
            41 => {
                let code = named("BugcheckCode")
                    .and_then(|c| c.parse::<u64>().ok())
                    .filter(|&c| c != 0)
                    .map(|c| format!("0x{c:08X}"));
                CrashEvent { time_ms, kind: CrashKind::UnexpectedShutdown, code, detail: None }
            }
            1001 => {
                // 첫 Data = "0x0000009f (0x…, 0x…, 0x…, 0x…)".
                let first = data.first().map(|(_, v)| v.as_str()).unwrap_or("");
                let (code, params) = first.split_once(' ').unwrap_or((first, ""));
                CrashEvent {
                    time_ms,
                    kind: CrashKind::Bugcheck,
                    code: (!code.is_empty()).then(|| code.to_string()),
                    detail: (!params.trim().is_empty()).then(|| params.trim().to_string()),
                }
            }
            6008 => CrashEvent { time_ms, kind: CrashKind::UnexpectedShutdown, code: None, detail: None },
            _ => continue,
        };
        raw.push((id, event));
    }
    let near = |id: u32, e: &CrashEvent, window: i64| {
        raw.iter().any(|(other, o)| *other == id && (o.time_ms - e.time_ms).abs() <= window)
    };
    // 블루스크린 한 번 = 1001 + (코드 있는) 41 [+ 6008]. 1001이 버그체크 인자를 가진 대표 행이다.
    let same_bugcheck = |e: &CrashEvent| {
        raw.iter().any(|(id, o)| {
            *id == 1001
                && (o.time_ms - e.time_ms).abs() <= BUGCHECK_REPORT_MS
                && matches!((&o.code, &e.code), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b))
        })
    };
    let keep: Vec<bool> = raw
        .iter()
        .map(|(id, e)| match id {
            41 => !same_bugcheck(e),
            6008 => !near(41, e, SAME_BOOT_MS) && !near(1001, e, SAME_BOOT_MS),
            _ => true,
        })
        .collect();
    let mut out: Vec<CrashEvent> =
        raw.into_iter().zip(keep).filter(|(_, k)| *k).map(|((_, e), _)| e).collect();
    out.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
    out
}

/// `last -x -F reboot shutdown`(최신순) → 정상 종료(shutdown) 없이 다음 부팅이 온 시점들. 시각은 그 부팅 시각이다
/// (끊긴 시각은 wtmp에 남지 않는다). `to_ms`는 로컬 시각 해석 — 테스트가 시간대에 묶이지 않게 밖에서 받는다.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_last_reboots(out: &str, to_ms: impl Fn(chrono::NaiveDateTime) -> Option<i64>) -> Vec<CrashEvent> {
    let mut records: Vec<(bool, i64)> = out
        .lines()
        .filter_map(|line| {
            let t: Vec<&str> = line.split_whitespace().collect();
            let is_boot = match t.first() {
                Some(&"reboot") => true,
                Some(&"shutdown") => false,
                _ => return None,
            };
            let when = t.get(4..9)?.join(" ");
            let dt = chrono::NaiveDateTime::parse_from_str(&when, "%a %b %d %H:%M:%S %Y").ok()?;
            Some((is_boot, to_ms(dt)?))
        })
        .collect();
    records.reverse();
    let mut events: Vec<CrashEvent> = records
        .windows(2)
        .filter(|w| w[0].0 && w[1].0)
        .map(|w| CrashEvent { time_ms: w[1].1, kind: CrashKind::UnexpectedShutdown, code: None, detail: None })
        .collect();
    events.reverse();
    events
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::error::ErrorCode;
    use crate::i18n::text_system;
    use crate::sysinfo_static::run_capture;

    const WEVTUTIL: &str = "wevtutil";
    const QUERY: &str = "/q:*[System[(EventID=1001 and Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting']) or (EventID=41 and Provider[@Name='Microsoft-Windows-Kernel-Power']) or EventID=6008]]";

    pub async fn list() -> Result<CrashHistory, IpcError> {
        let xml = match run_capture(WEVTUTIL, &["qe", "System", QUERY, "/f:xml", "/c:100", "/rd:true"], 20).await {
            Ok(x) => x,
            // 일치하는 이벤트가 없으면 wevtutil은 아무것도 쓰지 않고 0으로 끝난다 — run_capture는 이것을
            // stderr 빈 "출력 없음"으로만 알려 주므로 같은 문구로 가려낸다(진짜 실패는 stderr가 붙는다).
            Err(e) if e == text_system::sysinfo_program_no_output(WEVTUTIL, "") => String::new(),
            Err(e) => return Err(IpcError::new(ErrorCode::Io, e)),
        };
        Ok(CrashHistory { supported: true, unsupported_reason: None, events: parse_wevtutil_xml(&xml) })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use crate::sysinfo_static::run_capture;

    pub async fn list() -> Result<CrashHistory, IpcError> {
        let mut notes = Vec::new();
        // wtmp가 없거나(컨테이너·wtmpdb 전환 배포판) last가 없으면 그 부분만 비고 pstore는 그대로 본다 —
        // 대신 못 읽은 이유를 남겨 "기록 없음"으로 오인하지 않게 한다.
        let mut events = match run_capture("last", &["-x", "-F", "reboot", "shutdown"], 10).await {
            Ok(out) => parse_last_reboots(&out, |dt| {
                dt.and_local_timezone(chrono::Local).earliest().map(|t| t.timestamp_millis())
            }),
            Err(e) => {
                notes.push(crate::i18n::text_pccare_health::crash_source_unreadable("last", e));
                Vec::new()
            }
        };
        match files_as_panics(std::path::Path::new("/var/lib/systemd/pstore"), |_| true) {
            Ok(ev) => events.extend(ev),
            Err(e) => notes.push(e),
        }
        Ok(finish(events, notes))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    pub async fn list() -> Result<CrashHistory, IpcError> {
        let is_panic = |p: &std::path::Path| p.extension().is_some_and(|e| e == "panic");
        let root = std::path::Path::new("/Library/Logs/DiagnosticReports");
        let (mut events, mut notes) = (Vec::new(), Vec::new());
        for dir in [root.to_path_buf(), root.join("Retired")] {
            match files_as_panics(&dir, is_panic) {
                Ok(ev) => events.extend(ev),
                Err(e) => notes.push(e),
            }
        }
        Ok(finish(events, notes))
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod imp {
    use super::*;

    pub async fn list() -> Result<CrashHistory, IpcError> {
        Ok(CrashHistory {
            supported: false,
            unsupported_reason: Some(crate::i18n::text_pccare_health::crash_history_unsupported_os().to_string()),
            events: Vec::new(),
        })
    }
}

/// 일부 출처를 못 읽었으면 `unsupported_reason`에 이유를 싣는다(supported는 그대로) — 빈 목록이 "기록 없음"으로 읽히지 않게.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn finish(mut events: Vec<CrashEvent>, notes: Vec<String>) -> CrashHistory {
    events.sort_by(|a, b| b.time_ms.cmp(&a.time_ms));
    CrashHistory { supported: true, unsupported_reason: (!notes.is_empty()).then(|| notes.join("; ")), events }
}

/// 폴더 안 항목 하나 = 커널 패닉 한 건, 시각은 수정 시각.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn files_as_panics(dir: &std::path::Path, keep: impl Fn(&std::path::Path) -> bool) -> Result<Vec<CrashEvent>, String> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        // 폴더가 없으면 패닉 기록이 없는 것이다(pstore를 안 쓰는 시스템·패닉이 한 번도 없던 Mac).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(crate::i18n::text_pccare_health::crash_source_unreadable(&dir.display().to_string(), e)),
    };
    Ok(rd
        .flatten()
        .filter(|e| keep(&e.path()))
        .filter_map(|e| {
            let mtime = e.metadata().ok()?.modified().ok()?;
            let ms = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64;
            Some(CrashEvent {
                time_ms: ms,
                kind: CrashKind::KernelPanic,
                code: None,
                detail: Some(e.file_name().to_string_lossy().into_owned()),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-WER-SystemErrorReporting' Guid='{ABCE23E7-DE45-4366-8631-84FA6C525952}' EventSourceName='BugCheck'/><EventID Qualifiers='16384'>1001</EventID><Version>0</Version><Level>2</Level><TimeCreated SystemTime='2026-09-20T03:02:10.1234567Z'/><EventRecordID>900</EventRecordID></System><EventData><Data>0x0000009f (0x0000000000000003, 0xffffa00000000000, 0xfffff80000000000, 0xffffa00000001000)</Data><Data>C:\\Windows\\Minidump\\092026-12345-01.dmp</Data><Data>abc-1</Data></EventData></Event>\
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='EventLog'/><EventID Qualifiers='32768'>6008</EventID><TimeCreated SystemTime='2026-09-20T03:01:05.0000000Z'/></System><EventData><Data>12:00:00</Data><Data>2026-09-20</Data><Data/></EventData></Event>\
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>41</EventID><TimeCreated SystemTime='2026-09-20T03:00:30.5000000Z'/></System><EventData><Data Name='BugcheckCode'>159</Data><Data Name='BugcheckParameter1'>0x3</Data><Data Name='SleepInProgress'>0</Data><Data Name='PowerButtonTimestamp'>0</Data></EventData></Event>\
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='EventLog'/><EventID Qualifiers='32768'>6008</EventID><TimeCreated SystemTime='2026-09-01T10:00:00.0000000Z'/></System><EventData><Data>x</Data></EventData></Event>\
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power'/><EventID>41</EventID><TimeCreated SystemTime='2026-08-01T00:00:00Z'/></System><EventData><Data Name='BugcheckCode'>0</Data></EventData></Event>\r\n";

    #[test]
    fn pccare_health_wevtutil_xml_parses_and_merges() {
        let ev = parse_wevtutil_xml(SAMPLE);
        assert_eq!(ev.len(), 3, "{ev:?}");
        // 최신순: 1001(같은 코드의 41·6008을 흡수) → 단독 6008 → 코드 없는 41.
        assert_eq!(ev[0].kind, CrashKind::Bugcheck);
        assert_eq!(ev[0].code.as_deref(), Some("0x0000009f"));
        assert!(ev[0].detail.as_deref().unwrap().starts_with("(0x0000000000000003"));
        assert_eq!(ev[1].kind, CrashKind::UnexpectedShutdown);
        assert_eq!(ev[1].code, None);
        assert_eq!(ev[1].time_ms, chrono::DateTime::parse_from_rfc3339("2026-09-01T10:00:00Z").unwrap().timestamp_millis());
        assert_eq!(ev[2].kind, CrashKind::UnexpectedShutdown);
        assert_eq!(ev[2].code, None);
        assert!(ev.windows(2).all(|w| w[0].time_ms >= w[1].time_ms));
        assert!(parse_wevtutil_xml("").is_empty());
    }

    #[test]
    fn pccare_health_wevtutil_keeps_41_when_code_differs() {
        // 1001 없이 41(코드)+6008 → 41 하나, 코드가 다른 1001 옆의 41은 별개 사건으로 남는다.
        let xml = "<Event><System><EventID>41</EventID><TimeCreated SystemTime='2026-09-20T03:00:30Z'/></System><EventData><Data Name='BugcheckCode'>159</Data></EventData></Event>\
<Event><System><EventID>6008</EventID><TimeCreated SystemTime='2026-09-20T03:01:00Z'/></System></Event>\
<Event><System><EventID>1001</EventID><TimeCreated SystemTime='2026-09-20T03:02:00Z'/></System><EventData><Data>0x000000d1 (0x1, 0x2, 0x3, 0x4)</Data></EventData></Event>";
        let ev = parse_wevtutil_xml(xml);
        assert_eq!(ev.len(), 2, "{ev:?}");
        assert_eq!(ev[0].kind, CrashKind::Bugcheck);
        assert_eq!(ev[1].code.as_deref(), Some("0x0000009F"));
    }

    #[test]
    fn pccare_health_last_output_finds_unclean_boots() {
        let out = "reboot   system boot  6.8.0-45-generic Mon Oct 14 09:01:23 2024   still running\n\
shutdown system down  6.8.0-45-generic Sun Oct 13 23:00:01 2024 - Mon Oct 14 09:01:23 2024 (10:01)\n\
reboot   system boot  6.8.0-45-generic Sun Oct 13 08:00:00 2024 - Sun Oct 13 23:00:01 2024 (15:00)\n\
reboot   system boot  6.8.0-45-generic Sat Oct  5 07:30:00 2024 - crash (1+00:00)\n\
\n\
wtmp begins Tue Oct  1 00:00:00 2024\n";
        let ev = parse_last_reboots(out, |dt| Some(dt.and_utc().timestamp_millis()));
        assert_eq!(ev.len(), 1);
        let expect = chrono::NaiveDateTime::parse_from_str("2024-10-13 08:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(ev[0].time_ms, expect.and_utc().timestamp_millis());
        assert_eq!(ev[0].kind, CrashKind::UnexpectedShutdown);
    }
}
