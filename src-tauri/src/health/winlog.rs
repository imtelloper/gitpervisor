//! Windows 이벤트 로그 상관 조회 — "앱이 흔적 없이 사라졌다"의 유일한 외부 증거.
//!
//! 배경(2026-09-02 NTS 사건): 앱이 사라졌는데 앱 로그에는 아무것도 없었다. 앱이 흔적 없이
//! 없어지는 경로는 여럿인데 하트비트 센티널만으로는 전부 "oom"으로 뭉뚱그려진다.
//!
//!  - Rust 할당 실패 → std가 stderr(GUI라 버려진다)에 찍고 abort. 패닉 훅도 안 돌고 로그도 없다.
//!    OS에는 **예외 코드 0xC0000409**로 남는다.
//!  - 작업관리자 강제 종료 / 전원 차단 / 재부팅 → 앱 쪽에는 어떤 흔적도 없다.
//!  - WebView2 렌더러 크래시 → 창만 하얘지고 앱 프로세스는 살아 있다.
//!
//! 이 셋을 가르는 근거는 Windows 이벤트 로그뿐이다. 크래시 뒤 첫 시작에서 **한 번만**
//! `wevtutil`로 사건 시각 주변을 조회한다(실측 70~300ms, 상한 3초).
//!
//! **wevtutil 출력은 UTF-8이 아니다**(콘솔 OEM 코드페이지 — 한국어 Windows는 CP949).
//! 인코딩 크레이트를 붙일 만한 값이 아니라 `from_utf8_lossy`로 읽는다. XML 구조·exe명·예외
//! 코드·숫자는 전부 ASCII라 파싱에는 지장이 없고, 지역화된 문장(1074의 사유 등)만 깨진다 —
//! 깨진 문자가 섞인 필드는 사용자 문구에 넣지 않는다(`ascii_only`).

use chrono::{DateTime, Local, Utc};

/// 이벤트 로그에서 건진 한 건.
#[derive(Debug, Clone)]
pub struct OsEvent {
    pub id: u32,
    /// 이 앱(gitpervisor.exe) 자신에 대한 이벤트인가. WebView2 자식 크래시는 false —
    /// 렌더러가 죽어도 앱 프로세스는 살아 있으므로 "앱이 크래시했다"고 단정하면 안 된다.
    pub own_app: bool,
    /// 사건 시각(UTC). 파싱 실패 시 None.
    pub at: Option<DateTime<Utc>>,
    /// 사고를 낸 프로세스의 PID(Application Error 1000의 `Data[8]`, 16진). 그 외 이벤트는 None.
    ///
    /// **이게 없으면 dev와 설치본의 크래시를 서로 가져간다.** 둘은 같은 exe 이름
    /// (gitpervisor.exe)을 쓰고 이 저장소는 나란히 띄우는 게 기본 워크플로다(CLAUDE.md) —
    /// 이벤트 로그는 머신 전역이라 exe 이름만으로는 절대 가를 수 없다.
    pub pid: Option<u32>,
    /// 사용자에게 그대로 보여줄 한 줄(파싱 시점의 UI 언어).
    pub text: String,
}

/// 사건 시각 주변의 Application/System 이벤트를 조회해 UI 언어 한 줄들로 돌려준다.
/// Windows가 아니면 항상 빈 목록.
#[cfg(not(windows))]
pub fn query_around(_updated_at: DateTime<Local>) -> Vec<OsEvent> {
    Vec::new()
}

#[cfg(windows)]
pub fn query_around(updated_at: DateTime<Local>) -> Vec<OsEvent> {
    let at = updated_at.with_timezone(&Utc);
    let from = fmt_utc(at - chrono::Duration::minutes(10));
    let to = fmt_utc(at + chrono::Duration::minutes(15));

    let mut out = Vec::new();
    // 앱/WebView2 크래시 — 사건 시각 ±(10분, 15분).
    let q = format!(
        "*[System[(EventID=1000 or EventID=1001 or EventID=1002) and \
         TimeCreated[@SystemTime>='{from}' and @SystemTime<='{to}']]]"
    );
    if let Some(xml) = run("Application", &q) {
        out.extend(parse(&xml));
    }
    // 시스템 종료·전원·커밋 고갈 — 6008/41은 **다음 부팅 때** 기록되므로 XPath에는 상한을
    // 걸 수 없다(걸면 진짜 전원 사고를 놓친다). 상한은 `narrow`가 넉넉하게 준다.
    let q = format!(
        "*[System[(EventID=6008 or EventID=41 or EventID=1074 or EventID=2004) and \
         TimeCreated[@SystemTime>='{from}']]]"
    );
    if let Some(xml) = run("System", &q) {
        out.extend(parse(&xml));
    }
    narrow(out, at)
}

/// 사건 시각(`at`)에서 너무 먼 이벤트를 버리고 **시각 오름차순**으로 정렬한다.
///
/// 두 가지 오진을 함께 막는다.
///
/// 1. **상한 없는 System 질의.** 6008/41/2004에 시각 제약이 없으면 사건 며칠 뒤의 무관한
///    정전 한 번이 `classify`의 power 갈래를 타 "앱 문제가 아닐 수 있습니다"로 진단을
///    뒤집는다(power는 지표 기반 oom보다 상위다). 2004도 마찬가지로 남의 커밋 고갈이
///    이번 사건의 문구에 상위 소비자 목록을 덧붙인다. 상한 48시간은 "PC를 하룻밤 꺼 뒀다
///    다음날 켠" 경우까지 잡으면서 며칠 뒤 사건은 배제하는 절충이다.
/// 2. **최신 우선 정렬.** `run()`이 `/rd:true`로 읽어 목록이 최신순이라, `classify`의
///    `find()`가 사건에서 **가장 먼** 이벤트를 집는다. 오름차순으로 뒤집어 사건에 가장
///    가까운 것이 먼저 오게 한다.
///
/// Application 채널(1000/1001/1002)은 XPath가 이미 양쪽 경계를 걸었으므로 시각을 못 읽어도 남긴다.
pub fn narrow(mut events: Vec<OsEvent>, at: DateTime<Utc>) -> Vec<OsEvent> {
    events.retain(|e| match e.id {
        1000 | 1001 | 1002 => true,
        // 1074(종료/재부팅 요청)는 사건 당시에 기록된다 — 사건 3시간 뒤의 정상 재부팅을
        // "이때 종료됐다"고 읽으면 진단이 통째로 틀어진다.
        1074 => e.at.is_some_and(|t| (t - at).num_seconds().abs() <= 15 * 60),
        _ => e
            .at
            .is_some_and(|t| (-600..=48 * 3600).contains(&(t - at).num_seconds())),
    });
    events.sort_by_key(|e| e.at);
    events
}

#[cfg(windows)]
fn fmt_utc(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `wevtutil qe <채널> /q:<XPath> /f:xml /rd:true /c:30` — 3초 상한.
///
/// git/runner.rs와 같은 규약: 인자는 배열로만(셸 문자열 조합 금지), CREATE_NO_WINDOW로
/// 콘솔 깜빡임 방지. 크래시 뒤 첫 시작에서 창 생성 **전에** 딱 두 번 도는 동기 호출이다.
#[cfg(windows)]
fn run(channel: &str, query: &str) -> Option<String> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;

    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let exe = std::path::Path::new(&root).join(r"System32\wevtutil.exe");
    let mut child = std::process::Command::new(exe)
        .args([
            "qe",
            channel,
            &format!("/q:{query}"),
            "/f:xml",
            "/rd:true",
            "/c:30",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .ok()?;

    // 읽기 전용 스레드 + recv_timeout. 파이프를 계속 비우므로 출력이 64KB를 넘어도 교착하지
    // 않고, 시간을 넘기면 자식을 죽인다 — 시작 경로를 3초 넘게 붙잡으면 안 된다.
    let mut pipe = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(buf) => {
            let _ = child.wait();
            Some(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => {
            log::warn!("[health] wevtutil {channel} 조회 3초 초과 — 중단");
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

// ── 최소 XML 파서 ───────────────────────────────────────────────────────────
// 크레이트를 붙이지 않는다. 다루는 문서가 wevtutil의 고정 스키마 하나뿐이고, 필요한 것은
// `<EventID>`·`TimeCreated`·`<Data>`·`<Process_N>` 넷이라 문자열 검색으로 충분하다.

/// `<Open>값</Open>` 중 첫 값.
fn tag(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}");
    let i = xml.find(&open)?;
    let rest = &xml[i + open.len()..];
    // `<EventID Qualifiers='32768'>6008</EventID>` 처럼 속성이 붙을 수 있다.
    let j = rest.find('>')?;
    let val = &rest[j + 1..];
    let k = val.find('<')?;
    Some(val[..k].to_string())
}

/// `<... key='값' ...>` 의 값.
fn attr(xml: &str, key: &str) -> Option<String> {
    let pat = format!("{key}='");
    let i = xml.find(&pat)?;
    let rest = &xml[i + pat.len()..];
    let j = rest.find('\'')?;
    Some(rest[..j].to_string())
}

/// EventData의 `<Data>` 들을 (Name 속성, 값)으로. 이름 없는 것은 빈 문자열.
fn data_items(xml: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<Data") {
        rest = &rest[i + 5..];
        let Some(j) = rest.find('>') else { break };
        let head = &rest[..j];
        let body = &rest[j + 1..];
        let Some(k) = body.find("</Data>") else { break };
        let name = attr(head, "Name").unwrap_or_default();
        out.push((name, body[..k].to_string()));
        rest = &body[k..];
    }
    out
}

/// 이름 기준 조회(없으면 빈 문자열).
fn named(items: &[(String, String)], key: &str) -> String {
    items
        .iter()
        .find(|(n, _)| n == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// 순번 기준 조회 — Application Error(1000)는 `<Data>`에 이름이 없다.
fn nth(items: &[(String, String)], i: usize) -> String {
    items.get(i).map(|(_, v)| v.clone()).unwrap_or_default()
}

/// 깨진 문자(대체문자)가 섞이지 않은 값만 통과 — wevtutil 출력이 UTF-8이 아니라
/// 지역화된 문장은 읽을 수 없는 상태로 온다(모듈 주석).
fn readable(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty() && !t.contains('\u{FFFD}')).then_some(t)
}

/// 예외 코드 해석표 — 이 다섯이 "왜 사라졌나"의 대부분을 가른다.
fn exception_note(code: &str) -> &'static str {
    match code
        .trim()
        .trim_start_matches("0x")
        .to_ascii_lowercase()
        .as_str()
    {
        "c0000409" => crate::i18n::text_system::winlog_exception_abort_fastfail(),
        "e0000008" => "Chromium OOM",
        "c0000005" => crate::i18n::text_system::winlog_exception_access_violation(),
        "80000003" => crate::i18n::text_system::winlog_exception_breakpoint(),
        "c00000fd" => crate::i18n::text_system::winlog_exception_stack_overflow(),
        _ => "",
    }
}

fn is_ours(exe: &str) -> bool {
    exe.to_ascii_lowercase().contains("gitpervisor")
}

fn is_webview(exe: &str) -> bool {
    exe.to_ascii_lowercase().contains("msedgewebview2")
}

/// 시각 꼬리표. 로그 타임스탬프는 UTC, 세션 기록은 로컬이라 9시간이 어긋나기 쉽다 —
/// 사용자에게 보이는 문구는 항상 로컬 시각 + 오프셋으로 못박는다.
fn stamp(at: Option<DateTime<Utc>>) -> String {
    match at {
        Some(t) => format!(" @ {}", t.with_timezone(&Local).format("%Y-%m-%d %H:%M %z")),
        None => String::new(),
    }
}

/// wevtutil `/f:xml` 출력을 이벤트 목록으로. 관심 없는 이벤트(남의 앱 크래시 등)는 버린다.
// 비-Windows에선 query_around가 부르지 않지만 파서 테스트는 모든 타깃에서 돈다. allow가 이 함수를
// 살아 있는 뿌리로 만들어, 여기서만 부르는 i18n 문구 함수까지 dead_code 경고가 번지지 않게 한다.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse(xml: &str) -> Vec<OsEvent> {
    let mut out = Vec::new();
    for chunk in xml.split("</Event>") {
        if !chunk.contains("<EventID") {
            continue;
        }
        let Some(id) = tag(chunk, "EventID").and_then(|v| v.trim().parse::<u32>().ok()) else {
            continue;
        };
        let at = attr(chunk, "SystemTime")
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|t| t.with_timezone(&Utc));
        let d = data_items(chunk);
        let when = stamp(at);

        let (own_app, text) = match id {
            // Application Error — `<Data>`에 이름이 없다. [0]=exe, [6]=예외 코드.
            1000 => {
                let exe = nth(&d, 0);
                if !is_ours(&exe) && !is_webview(&exe) {
                    continue;
                }
                // 실물은 "c0000409"처럼 0x 없이 온다. 붙어 오는 경우도 있어 한 번 벗겨 둔다.
                let code = nth(&d, 6);
                let code = code.trim().trim_start_matches("0x").to_string();
                let note = exception_note(&code);
                let head = if is_webview(&exe) {
                    crate::i18n::text_system::winlog_webview2_crash_head()
                } else {
                    crate::i18n::text_system::winlog_app_crash_head()
                };
                let note = if note.is_empty() {
                    String::new()
                } else {
                    format!(" — {note}")
                };
                (
                    is_ours(&exe),
                    crate::i18n::text_system::winlog_app_error_event(head, &exe, &code, &note, &when),
                )
            }
            // Windows Error Reporting — P1=exe, EventName=버킷 종류(APPCRASH 등).
            1001 => {
                let exe = named(&d, "P1");
                if !is_ours(&exe) && !is_webview(&exe) {
                    continue;
                }
                let kind = named(&d, "EventName");
                (
                    is_ours(&exe),
                    crate::i18n::text_system::winlog_wer_event(&exe, &kind, &when).replace("  ", " "),
                )
            }
            // Application Hang — [0]=exe.
            1002 => {
                let exe = nth(&d, 0);
                if !is_ours(&exe) && !is_webview(&exe) {
                    continue;
                }
                (
                    is_ours(&exe),
                    crate::i18n::text_system::winlog_hang_event(&exe, &when),
                )
            }
            6008 => (
                false,
                crate::i18n::text_system::winlog_unexpected_shutdown_event(&when),
            ),
            41 => {
                let bug = named(&d, "BugcheckCode");
                let note = if bug.trim() == "0" {
                    crate::i18n::text_system::winlog_bugcheck_zero_note()
                } else {
                    crate::i18n::text_system::winlog_bugcheck_bluescreen_note()
                };
                (
                    false,
                    crate::i18n::text_system::winlog_kernel_power_event(&bug, note, &when),
                )
            }
            1074 => {
                let who = named(&d, "param1");
                let reason = named(&d, "param3");
                let reason = readable(&reason)
                    .map(crate::i18n::text_system::winlog_shutdown_reason)
                    .unwrap_or_default();
                (
                    false,
                    crate::i18n::text_system::winlog_shutdown_request_event(&who, &reason, &when),
                )
            }
            // Resource-Exhaustion-Detector — 커밋 한도 고갈. 상위 소비 프로세스가 함께 실린다.
            2004 => (
                false,
                crate::i18n::text_system::winlog_commit_exhausted_event(&top_consumers(chunk), &when),
            ),
            _ => continue,
        };
        // Application Error 1000의 [8] = faulting process id(16진). 같은 exe 이름을 쓰는
        // 다른 인스턴스(dev ↔ 설치본)의 크래시를 가려내는 유일한 판별자다.
        let pid = (id == 1000)
            .then(|| u32::from_str_radix(nth(&d, 8).trim().trim_start_matches("0x"), 16).ok())
            .flatten();
        out.push(OsEvent {
            id,
            own_app,
            at,
            pid,
            text,
        });
    }
    out
}

/// 2004의 `<ProcessInfo><Process_N><Name>…<CommitCharge>…` 에서 상위 소비자 3개.
fn top_consumers(chunk: &str) -> String {
    let Some(i) = chunk.find("<ProcessInfo>") else {
        return crate::i18n::text_system::winlog_no_info().into();
    };
    let block = &chunk[i..];
    let mut items: Vec<(String, u64)> = Vec::new();
    for seg in block.split("<Process_").skip(1) {
        let name = tag(seg, "Name").unwrap_or_default();
        let bytes = tag(seg, "CommitCharge")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(0);
        // 빈 슬롯(Name="" / CommitCharge=0)이 항상 뒤에 붙는다.
        if !name.trim().is_empty() && bytes > 0 {
            items.push((name, bytes));
        }
    }
    if items.is_empty() {
        return crate::i18n::text_system::winlog_no_info().into();
    }
    items.sort_by(|a, b| b.1.cmp(&a.1));
    items
        .iter()
        .take(3)
        .map(|(n, b)| format!("{n} {:.1}GB", *b as f64 / 1_073_741_824.0))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실물 조각 — 이 개발기(DESKTOP-T8J1GNM)에서 2026-09-03에
    /// `wevtutil qe System /q:"*[System[(EventID=2004)]]" /c:1 /rd:true /f:xml` 로 받은 XML.
    /// 길이 때문에 PagedPool/NonPagedPool 블록만 잘라냈다.
    const REAL_2004: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Resource-Exhaustion-Detector' Guid='{9988748e-c2e8-4054-85f6-0c3e1cad2470}'/><EventID>2004</EventID><Version>0</Version><Level>3</Level><Task>3</Task><Opcode>33</Opcode><Keywords>0x8000000020000000</Keywords><TimeCreated SystemTime='2026-04-16T23:59:47.3308179Z'/><EventRecordID>71517</EventRecordID><Correlation ActivityID='{50342021-9be3-49de-a735-805629872208}'/><Execution ProcessID='12636' ThreadID='77276'/><Channel>System</Channel><Computer>DESKTOP-T8J1GNM</Computer><Security UserID='S-1-5-18'/></System><UserData><MemoryExhaustionInfo xmlns='http://www.microsoft.com/Windows/Resource/Exhaustion/Detector/Events'><SystemInfo><SystemCommitLimit>136749981696</SystemCommitLimit><SystemCommitCharge>136744210432</SystemCommitCharge><ProcessCommitCharge>124781793280</ProcessCommitCharge><PagedPoolUsage>1526272000</PagedPoolUsage><PhysicalMemorySize>33670766592</PhysicalMemorySize><PhysicalMemoryUsage>30886457344</PhysicalMemoryUsage><NonPagedPoolUsage>1709928448</NonPagedPoolUsage><Processes>824</Processes></SystemInfo><ProcessInfo><Process_1><Name>warp.exe</Name><ID>41972</ID><CreationTime>2026-04-15T07:43:32.5901929Z</CreationTime><CommitCharge>30486663168</CommitCharge><HandleCount>2679</HandleCount><Version>1.0.0.0</Version><TypeInfo>201</TypeInfo></Process_1><Process_2><Name>python.exe</Name><ID>8644</ID><CreationTime>2026-04-16T06:03:11.0046647Z</CreationTime><CommitCharge>8124440576</CommitCharge><HandleCount>638</HandleCount><Version>3.10.16150.1013</Version><TypeInfo>210</TypeInfo></Process_2><Process_3><Name>vmmemWSL</Name><ID>59872</ID><CreationTime>2026-04-16T07:04:23.7920316Z</CreationTime><CommitCharge>7621857280</CommitCharge><HandleCount>0</HandleCount><Version>0.0.0.0</Version><TypeInfo>67</TypeInfo></Process_3><Process_4><Name></Name><ID>0</ID><CreationTime>1601-01-01T00:00:00.0000000Z</CreationTime><CommitCharge>0</CommitCharge><HandleCount>0</HandleCount><Version>0.0.0.0</Version><TypeInfo>0</TypeInfo></Process_4></ProcessInfo><ExhaustionEventInfo><Time>2026-04-16T23:59:45.9487634Z</Time></ExhaustionEventInfo></MemoryExhaustionInfo></UserData></Event>"#;

    /// 실물 조각 — 같은 머신의 41(Kernel-Power) + 6008 + 1074(User32). 셋을 한 응답으로 받았다.
    /// **지역화 문장(6008의 시각, 1074의 사유)은 실제로 이렇게 깨져서 온다** — wevtutil 출력이
    /// CP949인데 UTF-8로 읽기 때문이다(모듈 주석). 그 깨진 모습 그대로 fixture에 담았다.
    const REAL_SYSTEM: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-2005-44c2-ac5e-77220c37d6b4}'/><EventID>41</EventID><TimeCreated SystemTime='2026-09-02T23:57:16.4191967Z'/><Channel>System</Channel></System><EventData><Data Name='BugcheckCode'>0</Data><Data Name='BugcheckParameter1'>0x0</Data><Data Name='SleepInProgress'>0</Data></EventData></Event><Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='EventLog'/><EventID Qualifiers='32768'>6008</EventID><TimeCreated SystemTime='2026-09-02T23:57:30.0945289Z'/><Channel>System</Channel></System><EventData><Data>�� 8:31:11</Data><Data>?2026-?09-?03</Data><Data></Data></EventData></Event><Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='User32' Guid='{b0aa8734-56f7-41cc-b2f4-de228e98b946}' EventSourceName='User32'/><EventID Qualifiers='32768'>1074</EventID><TimeCreated SystemTime='2026-08-17T23:44:48.9906606Z'/><Channel>System</Channel></System><EventData><Data Name='param1'>C:\WINDOWS\SystemApps\StartMenuExperienceHost.exe (DESKTOP-T8J1GNM)</Data><Data Name='param2'>DESKTOP-T8J1GNM</Data><Data Name='param3'>��Ÿ(��ȹ���� ����)</Data><Data Name='param4'>0x0</Data></EventData></Event>"#;

    /// Application Error 1000 — 이 머신에는 최근 기록이 없어 스키마대로 만든 조각이다
    /// (이름 없는 `<Data>` 15개, [0]=exe, [6]=예외 코드 — 실제 이벤트와 같은 배치).
    const APPCRASH_1000: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-09-02T14:18:03.0000000Z'/><Channel>Application</Channel></System><EventData><Data>gitpervisor.exe</Data><Data>0.4.2.0</Data><Data>68b6f0a1</Data><Data>ntdll.dll</Data><Data>10.0.26200.1</Data><Data>68a11c33</Data><Data>c0000409</Data><Data>00000000000a1234</Data><Data>3f10</Data><Data>01dc1c0e</Data><Data>C:\Program Files\Gitpervisor\gitpervisor.exe</Data><Data>C:\WINDOWS\SYSTEM32\ntdll.dll</Data><Data>b15247c5-2ce9-4cf0-85c3-20775411eccb</Data><Data></Data><Data></Data></EventData></Event>"#;

    #[test]
    fn parses_real_2004_commit_exhaustion() {
        let ev = parse(REAL_2004);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0].id, 2004);
        // 상위 3개가 커밋 큰 순으로, 빈 슬롯(Name="")은 빠져야 한다.
        assert!(ev[0].text.contains("warp.exe 28.4GB"), "{}", ev[0].text);
        assert!(ev[0].text.contains("python.exe 7.6GB"), "{}", ev[0].text);
        assert!(!ev[0].text.contains("정보 없음"), "{}", ev[0].text);
        assert!(ev[0].at.is_some());
    }

    /// `<EventID Qualifiers='32768'>6008</EventID>` — 속성이 붙은 형태를 놓치면
    /// 6008/1074가 통째로 사라진다(실물이 그렇게 온다).
    #[test]
    fn parses_real_system_events_with_qualifiers() {
        let ev = parse(REAL_SYSTEM);
        let ids: Vec<u32> = ev.iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![41, 6008, 1074], "{ev:?}");
        assert!(ev[0].text.contains("전원 차단"), "{}", ev[0].text);
        assert!(ev[1].text.contains("예기치 않게"), "{}", ev[1].text);
        // 깨진 한국어 사유는 문구에 넣지 않는다(모듈 주석 — wevtutil 출력은 UTF-8이 아니다).
        assert!(ev[2].text.contains("StartMenuExperienceHost.exe"), "{}", ev[2].text);
        assert!(!ev[2].text.contains('\u{FFFD}'), "{}", ev[2].text);
    }

    /// 0xC0000409 = Rust 할당 실패 abort. 이 해석이 없으면 "그냥 크래시"로만 보인다.
    #[test]
    fn parses_app_crash_with_exception_note() {
        let ev = parse(APPCRASH_1000);
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert!(ev[0].own_app, "우리 앱 이벤트인데 own_app이 false다");
        assert!(ev[0].text.contains("0xc0000409"), "{}", ev[0].text);
        assert!(ev[0].text.contains("Rust 할당 실패"), "{}", ev[0].text);
        // [8]="3f10" = faulting process id(16진). dev/설치본을 가르는 유일한 판별자다.
        assert_eq!(ev[0].pid, Some(0x3f10), "{ev:?}");
    }

    /// `at`을 넣어 만든 이벤트 — narrow 테스트용.
    fn at_ev(id: u32, offset_secs: i64) -> OsEvent {
        OsEvent {
            id,
            own_app: false,
            at: Some(base() + chrono::Duration::seconds(offset_secs)),
            pid: None,
            text: format!("{id}@{offset_secs}s"),
        }
    }

    fn base() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-02T14:18:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    /// **사건 며칠 뒤의 무관한 전원 이벤트는 버려야 한다.** System 질의에는 상한이 없어
    /// (6008/41은 다음 부팅 때 기록되므로 XPath로는 못 건다) 그대로 두면 9/2 저메모리 종료가
    /// 9/5 정전으로 덮여 "앱 문제가 아닐 수 있습니다"가 뜬다 — 이 브랜치가 겨냥한 진단이
    /// 정확히 반대로 나간다.
    #[test]
    fn narrow_drops_power_events_days_after_incident() {
        let ev = narrow(
            vec![
                at_ev(41, 3 * 86_400), // 3일 뒤 정전 — 무관
                at_ev(6008, 3 * 86_400 + 14),
                at_ev(2004, 5 * 86_400), // 5일 뒤 커밋 고갈 — 무관
            ],
            base(),
        );
        assert!(ev.is_empty(), "{ev:?}");
    }

    /// 반대로 **다음 부팅 때 기록되는 진짜 전원 사고는 살아남아야 한다** — PC를 하룻밤
    /// 꺼 뒀다 켠 경우가 정상 경로다. 상한을 너무 좁게 잡으면 이쪽을 놓친다.
    #[test]
    fn narrow_keeps_power_event_on_next_day_boot() {
        let ev = narrow(vec![at_ev(41, 20 * 3600)], base());
        assert_eq!(ev.len(), 1, "{ev:?}");
    }

    /// `/rd:true`(최신 우선)로 읽은 목록을 그대로 두면 classify의 `find()`가 사건에서
    /// **가장 먼** 이벤트를 집는다. 오름차순 정렬로 가장 가까운 것이 먼저 오게 한다.
    #[test]
    fn narrow_sorts_nearest_first() {
        let ev = narrow(vec![at_ev(41, 40 * 3600), at_ev(41, 600)], base());
        assert_eq!(ev.len(), 2, "{ev:?}");
        assert!(ev[0].text.starts_with("41@600s"), "{ev:?}");
    }

    /// 1074는 사건 당시에 기록된다 — ±15분 밖은 버린다(기존 규칙 유지).
    #[test]
    fn narrow_keeps_shutdown_request_only_near_incident() {
        let ev = narrow(vec![at_ev(1074, 3 * 3600), at_ev(1074, 60)], base());
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert!(ev[0].text.starts_with("1074@60s"), "{ev:?}");
    }

    /// Application 이벤트는 XPath가 이미 양쪽 경계를 걸었으므로 시각을 못 읽어도 남긴다.
    #[test]
    fn narrow_keeps_application_events_without_timestamp() {
        let mut e = at_ev(1000, 0);
        e.at = None;
        assert_eq!(narrow(vec![e], base()).len(), 1);
    }

    /// 남의 앱 크래시는 버린다 — 이벤트 로그에는 무관한 크래시가 계속 쌓인다.
    #[test]
    fn ignores_unrelated_applications() {
        let xml = APPCRASH_1000.replace("gitpervisor.exe", "sqlservr.exe");
        assert!(parse(&xml).is_empty());
    }

    /// WebView2 크래시는 "앱이 죽었다"가 아니다 — 렌더러만 죽고 앱은 살아 있을 수 있다.
    #[test]
    fn webview_crash_is_not_own_app() {
        let xml = APPCRASH_1000
            .replace("gitpervisor.exe", "msedgewebview2.exe")
            .replace("c0000409", "e0000008");
        let ev = parse(&xml);
        assert_eq!(ev.len(), 1);
        assert!(!ev[0].own_app);
        assert!(ev[0].text.contains("Chromium OOM"), "{}", ev[0].text);
    }

    /// 파서가 쓰레기 입력에 패닉하면 시작 경로가 통째로 죽는다(창 생성 전이다).
    #[test]
    fn malformed_xml_never_panics() {
        for s in ["", "<Event>", "<EventID>", "<Event><EventID>abc</EventID>", "</Event>"] {
            let _ = parse(s);
        }
    }
}
