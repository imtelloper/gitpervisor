//! Claude 사용량(rate_limits) — 우측 하단 상태바의 usage 바.
//!
//! 1순위는 계정 사용량 API(Claude Code 의 `/usage` 가 묻는 그 엔드포인트) — 로그인 토큰은 Claude Code 가 저장해 둔 것을
//! 읽기만 한다. 예전엔 사용자의 `~/.claude/statusline.js` 가 rate_limits 를 `~/.claude/gitpervisor-usage.json` 으로 떨궈
//! 두는 다리에만 기댔는데, statusline.js 를 바꾸면서 다리가 빠져 바가 2026-09-04 이후 조용히 사라져 있었다(2026-11-04
//! 발견). 다리 파일은 API 를 못 쓸 때(토큰 없음·네트워크)의 폴백으로 남긴다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 한 사용량 창(5시간·주간·모델별 등) — 사용률%와 리셋 시각(epoch초).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// 원본 키 (five_hour / seven_day / seven_day_opus …) — 프론트가 라벨 매핑에 사용.
    pub key: String,
    pub used_percentage: f32,
    /// 리셋까지 남은 시간 계산용 epoch초. 없으면 시간 대신 키 라벨을 보인다.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub windows: Vec<UsageWindow>,
    /// 파일이 마지막으로 갱신된 epoch초 — 프론트가 오래된 데이터를 숨기는 데 쓴다.
    pub updated_at: i64,
}

#[derive(Deserialize)]
struct WindowJson {
    used_percentage: Option<f32>,
    resets_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageFile {
    #[serde(default)]
    rate_limits: HashMap<String, WindowJson>,
    #[serde(default)]
    updated_at: i64,
}

/// pub(crate): 작업 리포트(report.rs)가 같은 전사 경로 규약을 쓴다.
pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 표시 순서 — 세션(5h) → 주간(7d) → 모델별, 그 외는 뒤로.
const ORDER: &[&str] = &["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth"];

/// 상태바가 폴링하는 커맨드. API → 다리 파일 순. 둘 다 없으면 None(바를 숨긴다).
#[tauri::command(async)]
pub async fn claude_usage() -> Option<ClaudeUsage> {
    match api_usage().await {
        Some(u) => Some(u),
        None => bridge_file_usage(),
    }
}

// ── 계정 사용량 API ─────────────────────────────────────────────────────────

/// 문서화되지 않은 엔드포인트다 — 바뀌면 조회가 실패하고 다리 파일로 떨어질 뿐 앱은 멀쩡하다.
const USAGE_API: &str = "https://api.anthropic.com/api/oauth/usage";
/// 사용률은 대화 한 번에 1~2%씩 움직인다 — 1분이면 충분하고, 이 엔드포인트를 자주 치면 429 가 난다.
const API_TTL: Duration = Duration::from_secs(60);
/// 실패는 곧 다시 묻는다 — 앱을 켠 직후 첫 요청이 연결 오류로 떨어지는 일이 실제로 있었다(2026-11-04, 바로 다음 요청은 성공).
const API_RETRY: Duration = Duration::from_secs(15);
/// 응답 가운데 보이는 창 — 나머지 키(내부 코드명·크레딧)는 버린다.
const API_WINDOWS: &[&str] = &["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];

#[derive(Default)]
struct ApiCache {
    /// 이때까지는 다시 묻지 않는다.
    next: Option<Instant>,
    /// 마지막 성공 — 한 번 실패했다고(네트워크 순단) 바를 지우지 않는다. 오래되면 프론트가 숨긴다(updated_at).
    last: Option<ClaudeUsage>,
    /// 같은 실패를 1분마다 로그에 쌓지 않게 — 달라졌을 때만 남긴다.
    last_err: Option<String>,
}

static API_CACHE: Mutex<ApiCache> = Mutex::new(ApiCache { next: None, last: None, last_err: None });

async fn api_usage() -> Option<ClaudeUsage> {
    {
        let c = API_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if c.next.is_some_and(|t| Instant::now() < t) {
            return c.last.clone();
        }
    }
    let fetched = fetch_api_usage().await;
    let mut c = API_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    c.next = Some(Instant::now() + if fetched.is_ok() { API_TTL } else { API_RETRY });
    match fetched {
        Ok(u) => {
            c.last = Some(u);
            c.last_err = None;
        }
        Err(e) => {
            if c.last_err.as_deref() != Some(e.as_str()) {
                log::info!("[claude-usage] 사용량 API 조회 실패 — {e}");
                c.last_err = Some(e);
            }
        }
    }
    c.last.clone()
}

async fn fetch_api_usage() -> Result<ClaudeUsage, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let token = oauth_token().await?;
    let client = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .user_agent(concat!("gitpervisor/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    });
    let resp = client
        .get(USAGE_API)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        // Claude Code 가 토큰을 새로 받았을 수 있다 — 다음 조회 때 다시 읽는다.
        *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| format!("body: {e}"))?;
    Ok(parse_api_usage(&body, chrono::Utc::now().timestamp()))
}

/// `{"five_hour":{"utilization":78.0,"resets_at":"2026-11-05T23:00:00.08+00:00"},"seven_day":null,…}` → 창 목록.
fn parse_api_usage(body: &serde_json::Value, now: i64) -> ClaudeUsage {
    let windows = API_WINDOWS
        .iter()
        .filter_map(|key| {
            let w = body.get(*key)?;
            Some(UsageWindow {
                key: (*key).to_string(),
                used_percentage: w.get("utilization")?.as_f64()? as f32,
                resets_at: w
                    .get("resets_at")
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| d.timestamp()),
            })
        })
        .collect();
    ClaudeUsage { windows, updated_at: now }
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OauthCreds {
    access_token: String,
    /// epoch ms
    #[serde(default)]
    expires_at: Option<i64>,
}

#[derive(Deserialize)]
struct CredsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<OauthCreds>,
}

/// 읽어 둔 토큰 — 만료되거나 401 이 나면 다시 읽는다. macOS 키체인은 읽을 때마다 허락 창이 뜰 수 있어 자주 읽지 않는다.
static TOKEN: Mutex<Option<OauthCreds>> = Mutex::new(None);

fn token_fresh(c: &OauthCreds, now_ms: i64) -> bool {
    c.expires_at.is_none_or(|t| now_ms < t - 60_000)
}

async fn oauth_token() -> Result<String, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    if let Some(c) = TOKEN.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|c| token_fresh(c, now_ms)) {
        return Ok(c.access_token.clone());
    }
    let creds = read_creds().await?;
    if !token_fresh(&creds, now_ms) {
        // 갱신은 Claude Code 몫이다 — 우리가 refresh token 을 돌리면 Claude Code 쪽 로그인이 끊긴다.
        return Err("token expired (refreshed when Claude Code runs next)".into());
    }
    *TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(creds.clone());
    Ok(creds.access_token)
}

fn parse_creds(json: &str) -> Result<OauthCreds, String> {
    serde_json::from_str::<CredsFile>(json)
        .map_err(|e| format!("credentials: {e}"))?
        .oauth
        .filter(|o| !o.access_token.is_empty())
        .ok_or_else(|| "credentials: not logged in to claude.ai".into())
}

/// Claude Code 의 설정 폴더 — `CLAUDE_CONFIG_DIR` 이 있으면 그것.
fn claude_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| home_dir().map(|h| h.join(".claude")))
}

async fn read_creds() -> Result<OauthCreds, String> {
    let file = claude_config_dir().ok_or("no home dir")?.join(".credentials.json");
    match tokio::fs::read_to_string(&file).await {
        Ok(s) => parse_creds(&s),
        #[cfg(target_os = "macos")]
        Err(_) => keychain_creds().await,
        #[cfg(not(target_os = "macos"))]
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

/// macOS 의 Claude Code 는 토큰을 파일이 아니라 로그인 키체인에 둔다(항목 이름 `Claude Code-credentials`).
#[cfg(target_os = "macos")]
async fn keychain_creds() -> Result<OauthCreds, String> {
    let mut cmd = tokio::process::Command::new("/usr/bin/security");
    cmd.args(["find-generic-password", "-s", "Claude Code-credentials", "-w"]).kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(30), cmd.output())
        .await
        .map_err(|_| "keychain: timed out".to_string())?
        .map_err(|e| format!("keychain: {e}"))?;
    if !out.status.success() {
        return Err(format!("keychain: exit {}", out.status));
    }
    parse_creds(String::from_utf8_lossy(&out.stdout).trim())
}

// ── statusline.js 다리 파일(폴백) ────────────────────────────────────────────

fn bridge_file_usage() -> Option<ClaudeUsage> {
    let path = home_dir()?.join(".claude").join("gitpervisor-usage.json");
    let data = std::fs::read_to_string(&path).ok()?;
    let file: UsageFile = serde_json::from_str(&data).ok()?;

    let mut windows: Vec<UsageWindow> = file
        .rate_limits
        .into_iter()
        .filter_map(|(key, w)| {
            w.used_percentage.map(|p| UsageWindow {
                key,
                used_percentage: p,
                resets_at: w.resets_at,
            })
        })
        .collect();
    windows.sort_by_key(|w| ORDER.iter().position(|k| *k == w.key).unwrap_or(usize::MAX));
    Some(ClaudeUsage {
        windows,
        updated_at: file.updated_at,
    })
}

// ── 작업 완료 알림 본문: 마지막 AI 메시지 ─────────────────────────────────────

/// 프로젝트 cwd → Claude Code 트랜스크립트 디렉토리명(경로 구분자·콜론·점을 `-`로).
/// 예: `C:\Users\a\proj` → `C--Users-a-proj` (Claude Code 규약).
/// pub(crate): 작업 리포트(report.rs)의 프롬프트 수집이 같은 규약을 쓴다.
pub(crate) fn encode_project_dir(path: &str) -> String {
    path.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c })
        .collect()
}

/// 알림 본문용 요약 — 앞부분(약 220자)만 잘라 말줄임. 줄 끝 공백은 정리.
fn snippet(s: &str) -> String {
    let collapsed = s
        .split('\n')
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    let mut out: String = collapsed.chars().take(220).collect();
    if collapsed.chars().count() > 220 {
        out.push('…');
    }
    out
}

/// 프로젝트의 마지막 AI(assistant) 텍스트 메시지 — 작업 완료 알림 본문용. 최신 세션 트랜스크립트
/// (`~/.claude/projects/<encoded>/<newest>.jsonl`)의 끝에서부터 첫 assistant 텍스트를 뽑아 요약한다.
/// 트랜스크립트 없음·파싱 실패면 None(알림은 기본 문구로 폴백).
///
/// **async + 끝에서부터 읽기.** 예전엔 동기 커맨드(= UI 스레드)가 트랜스크립트를 통째로 읽었다 —
/// 파일이 11~32MB 라 에이전트가 끝날 때마다 UI 스레드가 수십 MB 를 할당·파싱했고, 메모리가 빠듯하면
/// 창 응답이 멈출 수 있었다(2026-09-17 설치본 멈춤 조사에서 후보로 꼽힘). 답은 거의 항상 마지막 몇 줄이다.
#[tauri::command(async)]
pub fn last_agent_message(project_path: String) -> Option<String> {
    let dir = home_dir()?
        .join(".claude")
        .join("projects")
        .join(encode_project_dir(&project_path));
    // 이 프로젝트의 세션 중 가장 최근에 수정된 트랜스크립트(방금 끝난 세션).
    let newest = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |x| x == "jsonl"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))?
        .path();
    scan_lines_from_end(&newest, assistant_snippet)
}

/// 트랜스크립트 한 줄이 텍스트가 있는 assistant 메시지면 그 요약.
fn assistant_snippet(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    let text = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let text = text.trim();
    (!text.is_empty()).then(|| snippet(text))
}

/// 파일을 **끝에서부터** 한 줄씩(뒤→앞) `f` 에 넘기고 처음 `Some` 을 돌려준다. 64KB 블록으로 거꾸로
/// 읽으므로 답이 끝 근처에 있으면 파일 크기와 무관하게 몇 블록만 읽는다. 블록 경계에 걸친 줄은 앞
/// 블록과 이어 붙인 뒤에야 넘긴다(한 줄이 수 MB 인 tool_result 도 온전히 한 줄로 본다).
fn scan_lines_from_end<T>(
    path: &std::path::Path,
    mut f: impl FnMut(&str) -> Option<T>,
) -> Option<T> {
    use std::io::{Read, Seek, SeekFrom};
    const BLOCK: u64 = 64 * 1024;
    // 이보다 긴 줄(수십 MB tool_result)은 통째로 건너뛴다 — 블록마다 이어 붙이면 복사가 줄 길이의 제곱으로
    // 늘고, 프론트 시한(3s)이 지나도 Rust 쪽은 계속 돈다. assistant 텍스트 줄은 이만큼 크지 않다.
    const MAX_LINE: usize = 8 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let mut pos = file.metadata().ok()?.len();
    // 아직 줄머리를 못 본 조각(파일의 더 뒤쪽 바이트). 줄바꿈이 없음이 보장된다.
    let mut carry: Vec<u8> = Vec::new();
    // 너무 긴 줄의 앞부분을 버리는 중 — 그 줄의 머리(앞 줄바꿈)를 찾을 때까지 바이트를 모으지 않는다.
    let mut skipping = false;
    loop {
        let start = pos.saturating_sub(BLOCK);
        let mut buf = vec![0u8; (pos - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut buf).ok()?;
        // 줄바꿈은 새로 읽은 블록 안에만 있다(carry 에는 없다) — 거기만 훑는다.
        let mut search_end = buf.len();
        let mut end = if skipping { buf.len() } else { buf.extend_from_slice(&carry); buf.len() };
        let mut first = true;
        while let Some(nl) = buf[..search_end].iter().rposition(|&b| b == b'\n') {
            if !(skipping && first) {
                let line = std::str::from_utf8(&buf[nl + 1..end]).unwrap_or("");
                if let Some(hit) = f(line.trim_end_matches('\r')) {
                    return Some(hit);
                }
            }
            first = false;
            skipping = false;
            end = nl;
            search_end = nl;
        }
        if start == 0 {
            // 파일 첫 줄 — 앞에 줄바꿈이 없다.
            if skipping {
                return None;
            }
            let line = std::str::from_utf8(&buf[..end]).unwrap_or("");
            return f(line.trim_end_matches('\r'));
        }
        if skipping || end > MAX_LINE {
            skipping = true;
            carry.clear();
        } else {
            buf.truncate(end);
            carry = buf;
        }
        pos = start;
    }
}

#[cfg(test)]
mod api_tests {
    use super::*;

    /// 2026-11-04 실제 응답에서 줄인 것 — null 창·내부 코드명 키가 섞여 온다.
    #[test]
    fn api_usage_keeps_known_windows_in_order() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{"seven_day_opus":null,"five_hour":{"utilization":12.5,"resets_at":"2026-11-04T09:00:00+00:00"},
                "seven_day":{"utilization":81.0,"resets_at":"2026-11-05T23:00:00.085337+00:00","limit_dollars":null},
                "iguana_necktie":{"utilization":100.0,"resets_at":"2026-11-05T07:59:00+00:00"},
                "seven_day_sonnet":{"utilization":3.0}}"#,
        )
        .unwrap();
        let u = parse_api_usage(&body, 42);
        let got: Vec<_> = u.windows.iter().map(|w| (w.key.as_str(), w.used_percentage, w.resets_at)).collect();
        assert_eq!(
            got,
            [
                ("five_hour", 12.5, Some(1_793_782_800)),
                ("seven_day", 81.0, Some(1_793_919_600)),
                ("seven_day_sonnet", 3.0, None),
            ]
        );
        assert_eq!(u.updated_at, 42);
    }

    #[test]
    fn creds_need_a_claude_ai_token() {
        let c = parse_creds(r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":1000000},"mcpOAuth":{}}"#).unwrap();
        assert_eq!((c.access_token.as_str(), c.expires_at), ("t", Some(1_000_000)));
        assert!(token_fresh(&c, 900_000) && !token_fresh(&c, 950_000), "만료 1분 전부터는 다시 읽는다");
        assert!(parse_creds(r#"{"mcpOAuth":{}}"#).is_err(), "API 키 로그인(claude.ai 아님)이면 계정 사용량이 없다");
        assert!(parse_creds("not json").is_err());
    }
}

#[cfg(test)]
mod tail_tests {
    use super::*;

    #[test]
    fn scan_lines_from_end_matches_whole_file_reverse_across_blocks() {
        let dir = std::env::temp_dir().join(format!("gpv-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        // 블록(64KB) 경계를 여러 번 넘도록: 긴 줄(200KB) + CRLF 줄 + 한글 + 마지막 줄 개행 없음.
        let long = "x".repeat(200_000);
        let lines = vec![
            "first".to_string(),
            long.clone(),
            "가나다\r".to_string(),
            "mid".to_string(),
            long,
            "last-no-newline".to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let mut seen = Vec::new();
        let none: Option<()> = scan_lines_from_end(&path, |l| {
            seen.push(l.to_string());
            None
        });
        assert!(none.is_none());
        let want: Vec<String> = lines.iter().rev().map(|l| l.trim_end_matches('\r').to_string()).collect();
        assert_eq!(seen, want, "전체를 뒤에서부터 한 줄씩, 경계 조각 없이");

        // 처음 Some 에서 멈춘다 — 더 앞 줄은 읽지 않는다.
        let mut visited = 0;
        let hit = scan_lines_from_end(&path, |l| {
            visited += 1;
            (l == "mid").then(|| l.to_string())
        });
        assert_eq!(hit.as_deref(), Some("mid"));
        assert_eq!(visited, 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_lines_from_end_skips_lines_longer_than_cap() {
        let dir = std::env::temp_dir().join(format!("gpv-tail-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let huge = "y".repeat(9 * 1024 * 1024); // MAX_LINE(8MB) 초과
        std::fs::write(&path, format!("before\n{huge}\nafter")).unwrap();
        let mut seen = Vec::new();
        let none: Option<()> = scan_lines_from_end(&path, |l| {
            seen.push(if l.len() > 16 { format!("<{}B>", l.len()) } else { l.to_string() });
            None
        });
        assert!(none.is_none());
        // 초대형 줄은 건너뛰고 그 앞뒤 줄은 온전히 본다.
        assert_eq!(seen, vec!["after".to_string(), "before".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn assistant_snippet_picks_text_blocks_only() {
        let a = r#"{"type":"assistant","message":{"content":[{"type":"tool_use"},{"type":"text","text":"완료했습니다"}]}}"#;
        let u = r#"{"type":"user","message":{"content":[{"type":"text","text":"x"}]}}"#;
        let t = r#"{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#;
        assert_eq!(assistant_snippet(a).as_deref(), Some("완료했습니다"));
        assert_eq!(assistant_snippet(u), None);
        assert_eq!(assistant_snippet(t), None);
        assert_eq!(assistant_snippet("not json"), None);
    }
}
