//! Claude Code 세션 기록(태스크 77, DOCS/task/77-claude-session-history.md) — `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/projects/
//! <인코딩된 cwd>/<id>.jsonl` 을 훑어 지난 세션 목록·상세를 만든다. 프런트는 고른 세션을 `claude --resume <id>` 로 연다.
//!
//! 전사는 이 기계에서 56개 1.1GB(최대 40MB)다(2026-11-05). 줄마다 JSON 을 파싱하지 않고 `"type":"…"` 를 바이트로 찾아
//! 줄 종류만 가린다 — 문자열 값 안의 따옴표는 `\"` 로 이스케이프되므로 맨 따옴표 `"type":"user"` 는 JSON 구조에만
//! 나온다(실측: 56개 파일 전부 부분 문자열 수 = 파싱한 줄 수). 파싱은 사람 프롬프트·제목 줄(드물고 작다)과 끝쪽
//! assistant 줄에만 한다. 결과는 (경로, mtime, 크기)로 캐시해 다시 열 때는 바뀐 파일(진행 중 세션)만 읽는다.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use memchr::memmem;
use serde::Serialize;
use serde_json::Value;

use crate::claude_usage::{claude_config_dir, scan_lines_from_end};
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_tools;

const LIST_PROMPT_CHARS: usize = 300;
const LIST_AGENT_CHARS: usize = 400;
const TITLE_FROM_PROMPT_CHARS: usize = 80;
const DETAIL_FIRST_PROMPT_CHARS: usize = 4000;
const DETAIL_RECENT_COUNT: usize = 8;
const DETAIL_RECENT_CHARS: usize = 1500;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub id: String,
    /// `projects` 아래 인코딩된 폴더 이름 — 상세·위치 열기에서 그대로 돌려받는다.
    pub project_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_agent_text: Option<String>,
    pub message_count: u32,
    pub human_prompt_count: u32,
    pub subagent_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionList {
    pub sessions: Vec<ClaudeSession>,
    pub scanned_files: u32,
    pub scanned_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeSessionRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionMessage {
    pub role: ClaudeSessionRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSubagent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSessionDetail {
    pub first_prompt: String,
    pub recent: Vec<ClaudeSessionMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 작업 경로 폴더가 지금도 있는가 — 없으면 프런트가 이어서 하기를 막는다(D2).
    pub cwd_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_uuid: Option<String>,
    pub subagents: Vec<ClaudeSubagent>,
}

struct CachedSession {
    modified: SystemTime,
    size: u64,
    /// None = 사람 프롬프트가 없는 세션 — 목록에서 빠지지만 다시 읽지 않도록 캐시는 한다.
    session: Option<ClaudeSession>,
}

/// 경로 → 마지막으로 읽은 결과. 목록 호출 전체가 이 락을 쥔다 — 동시에 두 번 열려도 GB 단위 스캔은 한 번만 돈다.
static LIST_CACHE: Mutex<BTreeMap<PathBuf, CachedSession>> = Mutex::new(BTreeMap::new());

#[tauri::command(async)]
pub async fn claude_sessions_list() -> Result<ClaudeSessionList, IpcError> {
    let root = projects_root()?;
    tokio::task::spawn_blocking(move || {
        let mut cache = LIST_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        list_in(&root, &mut cache)
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, text_tools::claude_sessions_scan_failed(&e)))?
}

#[tauri::command(async)]
pub async fn claude_session_detail(project_dir: String, id: String) -> Result<ClaudeSessionDetail, IpcError> {
    let root = projects_root()?;
    tokio::task::spawn_blocking(move || detail_in(&root, &project_dir, &id))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_tools::claude_sessions_scan_failed(&e)))?
}

#[tauri::command(async)]
pub fn claude_session_reveal(project_dir: String, id: String) -> Result<(), IpcError> {
    let path = session_path(&projects_root()?, &project_dir, &id)?;
    if !path.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, text_tools::claude_session_not_found(&id)));
    }
    crate::commands::reveal(&path)
}

fn projects_root() -> Result<PathBuf, IpcError> {
    claude_config_dir()
        .map(|d| d.join("projects"))
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, text_tools::claude_config_dir_not_found()))
}

// ── 경로 성분 검증 ──────────────────────────────────────────────────────────

/// 프런트가 돌려준 폴더 이름이 `projects` 밖을 가리키지 못하게 한다. 끝 점·공백도 거부한다 — Windows 는 경로를 풀 때
/// 그것들을 떼어 내 `...` 같은 이름이 다른 성분이 된다.
fn is_path_component(s: &str) -> bool {
    !s.is_empty()
        && !s.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0'))
        && !s.ends_with('.')
        && !s.ends_with(' ')
}

/// Claude Code 세션 id 는 하이픈 넣은 UUID(8-4-4-4-12) 꼴이다.
fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn session_path(root: &Path, project_dir: &str, id: &str) -> Result<PathBuf, IpcError> {
    if !is_path_component(project_dir) || !is_session_id(id) {
        return Err(IpcError::new(ErrorCode::Io, text_tools::claude_session_bad_path()));
    }
    Ok(root.join(project_dir).join(format!("{id}.jsonl")))
}

// ── 줄 분류·텍스트 추출 ────────────────────────────────────────────────────

#[derive(Default)]
struct LineKinds {
    user: bool,
    assistant: bool,
    tool_result: bool,
    ai_title: bool,
    custom_title: bool,
    session_owner: bool,
}

/// 줄에 나오는 모든 `"type":"…"` 를 한 번에 훑는다. tool_result 는 사용자 줄 안의 블록 — 사람이 쓴 글이 아니다.
fn line_kinds(line: &[u8]) -> LineKinds {
    const KEY: &[u8] = br#""type":""#;
    let mut k = LineKinds::default();
    for at in memmem::find_iter(line, KEY) {
        let rest = &line[at + KEY.len()..];
        let is = |name: &[u8]| rest.len() > name.len() && rest.starts_with(name) && rest[name.len()] == b'"';
        k.user |= is(b"user");
        k.assistant |= is(b"assistant");
        k.tool_result |= is(b"tool_result");
        k.ai_title |= is(b"ai-title");
        k.custom_title |= is(b"custom-title");
        k.session_owner |= is(b"session-owner");
    }
    k
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn timestamp_ms(v: &Value) -> Option<i64> {
    parse_rfc3339_ms(v.get("timestamp")?.as_str()?)
}

fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// 파싱 없이 줄의 첫 `"timestamp":"…"` — 시작 시각은 맨 앞 몇 줄에서 나오므로 그때까지만 부른다.
fn raw_timestamp_ms(line: &[u8]) -> Option<i64> {
    const KEY: &[u8] = br#""timestamp":""#;
    let start = memmem::find(line, KEY)? + KEY.len();
    let len = memchr::memchr(b'"', &line[start..])?;
    parse_rfc3339_ms(std::str::from_utf8(&line[start..start + len]).ok()?)
}

/// `message.content` 의 글 — 문자열이거나 블록 배열(text 블록만 잇는다).
fn message_text(v: &Value) -> Option<String> {
    match v.pointer("/message/content")? {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => Some(
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

struct Prompt {
    /// 잡음 태그를 걷은 글 — 줄바꿈은 살려 둔다(상세 화면). 목록은 `collapse_ws` 로 한 줄로 만든다.
    text: String,
    at_ms: Option<i64>,
    cwd: Option<String>,
    git_branch: Option<String>,
    version: Option<String>,
}

/// 사람이 친 프롬프트면 Some. `turnOrigin` 은 새 버전에만 있다 — 없는 줄(옛 버전·VS Code 확장의 `promptSource:"sdk"`)도
/// 사람 프롬프트로 본다. 실측(2026-11-05): `turnOrigin:"human"` 만 세면 56개 중 40MB 짜리를 포함한 7개 세션이 통째로
/// 빠졌다. 있으면 human·sdk 만 받는다(task_notification·peer·scheduled 등은 앱이 끼운 차례다).
fn human_prompt(v: &Value) -> Option<Prompt> {
    if v.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let flag = |k: &str| v.get(k).and_then(Value::as_bool) == Some(true);
    if flag("isSidechain") || flag("isMeta") || flag("isCompactSummary") || flag("isVisibleInTranscriptOnly") {
        return None;
    }
    if let Some(origin) = v.get("turnOrigin").and_then(Value::as_str) {
        if origin != "human" && origin != "sdk" {
            return None;
        }
    }
    if v
        .pointer("/message/content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| blocks.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")))
    {
        return None;
    }
    Some(Prompt {
        text: clean_prompt(&message_text(v)?)?,
        at_ms: timestamp_ms(v),
        cwd: str_field(v, "cwd"),
        git_branch: str_field(v, "gitBranch"),
        version: str_field(v, "version"),
    })
}

/// 프롬프트 안에 끼어드는 것 — 통째로 들어낸다. 닫는 쪽이 없으면 끝까지.
const NOISE_SPANS: &[(&str, &str)] = &[
    ("<system-reminder>", "</system-reminder>"),
    // 붙여 넣은 글은 사용자가 쓴 것이라 여닫는 태그만 뗀다. 닫는 태그에도 id 가 붙어 온다(`</pasted_content id="3f34">`, 실측).
    ("<pasted_content", ">"),
    ("</pasted_content", ">"),
    ("[Image #", "]"),
];
const NOISE_TAGS: &[&str] = &["<bash-input>", "</bash-input>"];

/// 앱이 끼운 줄(작업 알림·명령 출력·인자 없는 슬래시 명령)은 None — `report::typed_request` 와 같은 판정이다.
/// 이미지만 붙인 프롬프트처럼 걷고 나면 빈 글이면 걷기 전 글을 남긴다(사람 프롬프트이긴 하다).
fn clean_prompt(raw: &str) -> Option<String> {
    let typed = crate::report::typed_request(raw.trim())?;
    let mut s = typed.clone();
    for (open, close) in NOISE_SPANS {
        s = remove_spans(&s, open, close);
    }
    for tag in NOISE_TAGS {
        s = s.replace(tag, "");
    }
    let s = s.trim();
    // 이미지 표시를 걷으면 그걸 가리키던 화살표만 남는다("[Image #2] <- 이거" → "<- 이거") — 앞머리 화살표는 같이 뗀다.
    let s = s.strip_prefix("<-").or_else(|| s.strip_prefix('←')).map_or(s, str::trim_start);
    Some(if s.is_empty() { typed } else { s.to_string() })
}

fn remove_spans(s: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(open) {
        out.push_str(&rest[..i]);
        let after = &rest[i + open.len()..];
        rest = after.find(close).map_or("", |j| &after[j + close.len()..]);
    }
    out.push_str(rest);
    out
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 말줄임표를 포함해 `max` 자 이하.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().nth(max).is_none() {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 텍스트가 있는 assistant 줄 → (모델, 글). `<synthetic>` 모델은 Claude Code 가 지어낸 줄(API 오류·"No response
/// requested.")이라 대화로 치지 않는다.
fn assistant_text(v: &Value) -> Option<(Option<String>, String)> {
    let model = v.pointer("/message/model").and_then(Value::as_str);
    if model == Some("<synthetic>") {
        return None;
    }
    let text = message_text(v)?;
    let text = text.trim();
    (!text.is_empty()).then(|| (model.map(str::to_owned), text.to_string()))
}

// ── 목록 ────────────────────────────────────────────────────────────────────

struct Transcript {
    path: PathBuf,
    project_dir: String,
    id: String,
    size: u64,
    modified: SystemTime,
}

fn list_in(root: &Path, cache: &mut BTreeMap<PathBuf, CachedSession>) -> Result<ClaudeSessionList, IpcError> {
    let found = find_transcripts(root)?;
    // 바뀐 것(새 파일·mtime·크기)만 다시 읽는다. 큰 것부터 나눠 줘야 마지막 스레드 하나가 큰 파일을 붙잡고 늦지 않는다.
    let mut stale: Vec<&Transcript> = found
        .iter()
        .filter(|t| !cache.get(&t.path).is_some_and(|c| c.modified == t.modified && c.size == t.size))
        .collect();
    stale.sort_by_key(|t| std::cmp::Reverse(t.size));
    for (t, read) in read_parallel(&stale) {
        match read {
            Ok(session) => {
                cache.insert(t.path.clone(), CachedSession { modified: t.modified, size: t.size, session });
            }
            Err(e) => {
                // 쓰는 중 잠김·권한 — 이번 목록에서만 빠지고 캐시하지 않아 다음에 다시 읽는다.
                log::warn!("[claude-sessions] {} 읽기 실패: {e}", t.path.display());
                cache.remove(&t.path);
            }
        }
    }

    let mut sessions = Vec::new();
    let mut fresh = BTreeMap::new();
    for t in &found {
        let Some(entry) = cache.remove(&t.path) else { continue };
        if let Some(s) = &entry.session {
            let mut s = s.clone();
            // 서브에이전트 파일은 전사와 따로 생긴다 — 캐시하지 않고 매번 센다(폴더 하나 읽기).
            s.subagent_count = count_subagents(&root.join(&t.project_dir).join(&t.id).join("subagents"));
            sessions.push(s);
        }
        fresh.insert(t.path.clone(), entry);
    }
    // 지워진 전사의 캐시는 버린다.
    *cache = fresh;
    sessions.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(ClaudeSessionList {
        sessions,
        scanned_files: found.len() as u32,
        scanned_at_ms: chrono::Utc::now().timestamp_millis(),
    })
}

/// `projects/<폴더>/<uuid>.jsonl` 만 — 같은 폴더의 `memory/`·서브에이전트 폴더·다른 파일은 세션이 아니다.
fn find_transcripts(root: &Path) -> Result<Vec<Transcript>, IpcError> {
    let projects = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        // Claude Code 를 한 번도 안 쓴 머신 — 오류가 아니라 0개다.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(IpcError::new(
                ErrorCode::Io,
                text_tools::claude_session_read_failed(&root.display().to_string(), &e),
            ))
        }
    };
    let mut found = Vec::new();
    for project in projects.flatten() {
        let Some(project_dir) = project.file_name().to_str().map(str::to_owned) else { continue };
        if !project.file_type().is_ok_and(|t| t.is_dir()) || !is_path_component(&project_dir) {
            continue;
        }
        let files = match std::fs::read_dir(project.path()) {
            Ok(rd) => rd,
            Err(e) => {
                // 폴더 하나를 못 읽어도 나머지 세션은 보여 준다.
                log::warn!("[claude-sessions] {} 읽기 실패: {e}", project.path().display());
                continue;
            }
        };
        for file in files.flatten() {
            let path = file.path();
            let Some(id) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".jsonl")) else {
                continue;
            };
            if !is_session_id(id) {
                continue;
            }
            match file.metadata().and_then(|m| Ok((m.is_file(), m.len(), m.modified()?))) {
                Ok((true, size, modified)) => {
                    found.push(Transcript { id: id.to_string(), path, project_dir: project_dir.clone(), size, modified })
                }
                Ok(_) => {}
                Err(e) => log::warn!("[claude-sessions] {} 메타데이터 실패: {e}", path.display()),
            }
        }
    }
    Ok(found)
}

/// 파일별로 나눠 병렬로 읽는다. 첫 스캔은 GB 단위다 — 실측(2026-11-05, 1.2GB·56개, OS 캐시 따뜻함): 한 스레드로
/// 디버그 빌드 5.6s, 그중 4.2s 가 줄 종류 찾기 CPU 였다(같은 파일 `cat` 은 0.34s).
fn read_parallel<'a>(todo: &[&'a Transcript]) -> Vec<(&'a Transcript, std::io::Result<Option<ClaudeSession>>)> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8).min(todo.len());
    std::thread::scope(|s| {
        let workers: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    while let Some(&t) = todo.get(next.fetch_add(1, Ordering::Relaxed)) {
                        out.push((t, read_session(&t.path, &t.id, &t.project_dir, t.modified, t.size)));
                    }
                    out
                })
            })
            .collect();
        workers
            .into_iter()
            .flat_map(|w| w.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic)))
            .collect()
    })
}

/// 전사 하나를 읽는다 — 앞에서 끝까지 한 번(메시지 수·사람 프롬프트·제목·시작 시각), 끝에서 조금(마지막 에이전트 글·
/// 모델·브랜치). 사람 프롬프트가 없으면 None.
fn read_session(
    path: &Path,
    id: &str,
    project_dir: &str,
    modified: SystemTime,
    size: u64,
) -> std::io::Result<Option<ClaudeSession>> {
    let mut rd = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(path)?);
    let mut line = Vec::new();
    let (mut message_count, mut human_prompt_count) = (0u32, 0u32);
    let (mut first, mut last): (Option<Prompt>, Option<Prompt>) = (None, None);
    let (mut ai_title, mut custom_title): (Option<String>, Option<String>) = (None, None);
    let mut started_at_ms = None;
    loop {
        line.clear();
        if rd.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if started_at_ms.is_none() {
            started_at_ms = raw_timestamp_ms(&line);
        }
        let k = line_kinds(&line);
        if k.user || k.assistant {
            message_count += 1;
        }
        // 잘린 줄(Claude Code 가 쓰는 중인 마지막 줄)·깨진 줄은 읽을 수 없으니 건너뛴다.
        if k.user && !k.tool_result {
            if let Some(p) = serde_json::from_slice::<Value>(&line).ok().as_ref().and_then(human_prompt) {
                human_prompt_count += 1;
                if first.is_none() {
                    first = Some(p);
                } else {
                    last = Some(p);
                }
            }
        } else if k.ai_title || k.custom_title {
            if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                if let Some(t) = str_field(&v, "aiTitle") {
                    ai_title = Some(t);
                }
                if let Some(t) = str_field(&v, "customTitle") {
                    custom_title = Some(t);
                }
            }
        }
    }
    let Some(first) = first else { return Ok(None) };

    let (mut model, mut agent_text, mut branch, mut version) = (None, None, None, None);
    let _: Option<()> = scan_lines_from_end(path, |l| {
        if !line_kinds(l.as_bytes()).assistant {
            return None;
        }
        // 쓰는 중인 마지막 줄은 잘려 있을 수 있다 — 못 읽는 줄은 건너뛰고 더 앞을 본다.
        let v: Value = serde_json::from_str(l).ok()?;
        if branch.is_none() {
            branch = str_field(&v, "gitBranch");
            version = str_field(&v, "version");
        }
        if let Some((m, text)) = assistant_text(&v) {
            if model.is_none() {
                model = m;
            }
            agent_text.get_or_insert(text);
        } else if model.is_none() {
            model = v.pointer("/message/model").and_then(Value::as_str).filter(|m| *m != "<synthetic>").map(str::to_owned);
        }
        (model.is_some() && agent_text.is_some()).then_some(())
    });

    let newest = last.as_ref().unwrap_or(&first);
    let first_prompt = collapse_ws(&first.text);
    Ok(Some(ClaudeSession {
        id: id.to_string(),
        project_dir: project_dir.to_string(),
        // `/rename` 이 남기는 custom-title 은 사용자가 고른 이름이다(옛 버전은 자동 제목도 이 키로 썼다) — ai-title 보다 앞선다.
        title: custom_title.or(ai_title).or_else(|| Some(truncate_chars(&first_prompt, TITLE_FROM_PROMPT_CHARS))),
        cwd: first.cwd.clone(),
        git_branch: branch.or_else(|| newest.git_branch.clone()),
        model,
        version: version.or_else(|| newest.version.clone()),
        last_prompt: Some(truncate_chars(&collapse_ws(&newest.text), LIST_PROMPT_CHARS)),
        first_prompt: Some(truncate_chars(&first_prompt, LIST_PROMPT_CHARS)),
        last_agent_text: agent_text.map(|t| truncate_chars(&collapse_ws(&t), LIST_AGENT_CHARS)),
        message_count,
        human_prompt_count,
        subagent_count: 0,
        started_at_ms: started_at_ms.or(first.at_ms),
        updated_at_ms: chrono::DateTime::<chrono::Utc>::from(modified).timestamp_millis(),
        size_bytes: size,
    }))
}

fn count_subagents(dir: &Path) -> u32 {
    match std::fs::read_dir(dir) {
        Ok(rd) => rd.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "jsonl")).count() as u32,
        // 서브에이전트를 안 띄운 세션은 폴더가 없다.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => {
            log::warn!("[claude-sessions] {} 읽기 실패: {e}", dir.display());
            0
        }
    }
}

// ── 상세 ────────────────────────────────────────────────────────────────────

fn detail_in(root: &Path, project_dir: &str, id: &str) -> Result<ClaudeSessionDetail, IpcError> {
    let path = session_path(root, project_dir, id)?;
    let read_err = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => IpcError::new(ErrorCode::NotFound, text_tools::claude_session_not_found(id)),
        _ => IpcError::new(ErrorCode::Io, text_tools::claude_session_read_failed(&path.display().to_string(), &e)),
    };
    let mut rd = std::io::BufReader::with_capacity(1 << 20, std::fs::File::open(&path).map_err(read_err)?);
    let mut line = Vec::new();
    let mut first: Option<Prompt> = None;
    let mut account_uuid: Option<String> = None;
    let owner = |line: &[u8]| serde_json::from_slice::<Value>(line).ok().and_then(|v| str_field(&v, "accountUuid"));
    while first.is_none() {
        line.clear();
        if rd.read_until(b'\n', &mut line).map_err(read_err)? == 0 {
            break;
        }
        let k = line_kinds(&line);
        if k.session_owner && account_uuid.is_none() {
            account_uuid = owner(&line);
        }
        if k.user && !k.tool_result {
            first = serde_json::from_slice::<Value>(&line).ok().as_ref().and_then(human_prompt);
        }
    }

    // 끝에서부터 모은다(최신 → 오래된). 에이전트가 길게 일한 세션은 끝 8개가 전부 Claude 말이라 "내가 마지막에 뭘
    // 시켰나"가 안 보인다 — 그래서 8개 안에 사람 프롬프트가 없으면 더 거슬러 올라가 마지막 사람 프롬프트 하나를 찾아
    // 가장 오래된 칸과 바꾼다(실측: 이 기계에서 가장 긴 세션의 끝 8개가 전부 Claude 였다).
    let mut recent = Vec::new();
    let mut has_user = false;
    let mut last_user: Option<ClaudeSessionMessage> = None;
    let (mut cwd, mut git_branch) = (None, None);
    let _: Option<()> = scan_lines_from_end(&path, |l| {
        let k = line_kinds(l.as_bytes());
        if k.session_owner && account_uuid.is_none() {
            account_uuid = owner(l.as_bytes());
        }
        let full = recent.len() >= DETAIL_RECENT_COUNT;
        if !(k.assistant || (k.user && !k.tool_result)) || (full && k.assistant) {
            return None;
        }
        let v: Value = serde_json::from_str(l).ok()?;
        if git_branch.is_none() {
            git_branch = str_field(&v, "gitBranch");
            cwd = str_field(&v, "cwd");
        }
        let (role, text) = if k.assistant {
            (ClaudeSessionRole::Assistant, assistant_text(&v)?.1)
        } else {
            (ClaudeSessionRole::User, human_prompt(&v)?.text)
        };
        let msg = ClaudeSessionMessage {
            role,
            text: truncate_chars(&text, DETAIL_RECENT_CHARS),
            timestamp_ms: timestamp_ms(&v),
        };
        if full {
            last_user = Some(msg);
            return Some(());
        }
        has_user |= role == ClaudeSessionRole::User;
        recent.push(msg);
        (recent.len() >= DETAIL_RECENT_COUNT && has_user).then_some(())
    });
    if let Some(u) = last_user {
        recent.pop();
        recent.push(u);
    }
    recent.reverse();

    let first_prompt = first.as_ref().map_or_else(String::new, |p| truncate_chars(&p.text, DETAIL_FIRST_PROMPT_CHARS));
    let cwd = first.and_then(|p| p.cwd).or(cwd);
    Ok(ClaudeSessionDetail {
        first_prompt,
        recent,
        cwd_exists: cwd.as_deref().is_some_and(|c| Path::new(c).is_dir()),
        cwd,
        git_branch,
        account_uuid,
        subagents: subagents_in(&root.join(project_dir).join(id).join("subagents")),
    })
}

/// `agent-<id>.jsonl` + `agent-<id>.meta.json`(description). 띄운 순서로 보이게 전사 mtime 순.
fn subagents_in(dir: &Path) -> Vec<ClaudeSubagent> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!("[claude-sessions] {} 읽기 실패: {e}", dir.display());
            return Vec::new();
        }
    };
    let mut found: Vec<(Option<SystemTime>, ClaudeSubagent)> = rd
        .flatten()
        .filter_map(|e| {
            let stem = e.file_name().to_str()?.strip_suffix(".jsonl")?.to_string();
            // meta.json 이 없는(옛 버전) 서브에이전트도 목록엔 둔다.
            let description = std::fs::read(dir.join(format!("{stem}.meta.json")))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| str_field(&v, "description"));
            let id = stem.strip_prefix("agent-").unwrap_or(&stem).to_string();
            // mtime 은 정렬 키일 뿐이다 — 못 읽으면 앞으로 보낸다.
            Some((e.metadata().and_then(|m| m.modified()).ok(), ClaudeSubagent { id, description }))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    found.into_iter().map(|(_, s)| s).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";
    const C: &str = "33333333-3333-4333-8333-333333333333";
    const D: &str = "44444444-4444-4444-8444-444444444444";

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gpv-claude-sessions-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_jsonl(path: &Path, lines: &[Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(path, body).unwrap();
    }

    fn set_mtime(path: &Path, t: SystemTime) {
        std::fs::File::options().write(true).open(path).unwrap().set_modified(t).unwrap();
    }

    fn user(content: Value, extra: Value) -> Value {
        let mut v = json!({"parentUuid": null, "isSidechain": false, "type": "user",
            "message": {"role": "user", "content": content},
            "timestamp": "2026-11-01T00:01:00.000Z", "cwd": "F:\\repo", "version": "2.1.300", "gitBranch": "main"});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    fn assistant(model: &str, blocks: Value, extra: Value) -> Value {
        let mut v = json!({"parentUuid": "x", "isSidechain": false,
            "message": {"model": model, "id": "msg", "type": "message", "role": "assistant", "content": blocks},
            "type": "assistant", "timestamp": "2026-11-01T00:02:00.000Z", "cwd": "F:\\repo", "version": "2.1.300", "gitBranch": "main"});
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        v
    }

    fn session_a() -> Vec<Value> {
        vec![
            json!({"type": "mode", "mode": "normal", "sessionId": A}),
            // 문자열 안의 따옴표는 이스케이프되므로 대화 줄로 세지 않는다.
            json!({"parentUuid": null, "attachment": {"type": "hook_success", "content": "{\"type\":\"assistant\"}"},
                   "type": "attachment", "timestamp": "2026-11-01T00:00:00.000Z", "cwd": "F:\\repo"}),
            json!({"type": "ai-title", "aiTitle": "Old title", "sessionId": A}),
            user(json!("첫   요청 [Image #1] 입니다\n<system-reminder>noise</system-reminder>"), json!({"turnOrigin": "human", "promptSource": "typed"})),
            assistant("claude-opus-5-5", json!([{"type": "thinking", "thinking": "..."}, {"type": "text", "text": "첫 답"}]), json!({})),
            user(json!([{"type": "tool_result", "tool_use_id": "t", "content": "{\"type\":\"user\"} quoted"}]), json!({})),
            user(json!("<task-notification>\n<task-id>w</task-id>\n</task-notification>"), json!({"turnOrigin": "task_notification"})),
            user(json!("This session is being continued from a previous conversation"), json!({"isCompactSummary": true, "turnOrigin": "human"})),
            user(json!("<command-message>clear</command-message>\n<command-name>/clear</command-name>\n<command-args></command-args>"), json!({})),
            user(json!("peer says hi"), json!({"turnOrigin": "peer"})),
            json!({"type": "ai-title", "aiTitle": "New title", "sessionId": A}),
            // 옛 버전: turnOrigin 없음, 블록 배열(이미지 + 글).
            user(json!([{"type": "image", "source": {"type": "base64", "data": "AAAA"}}, {"type": "text", "text": "마지막\n  요청"}]),
                 json!({"gitBranch": "feat", "timestamp": "2026-11-01T00:05:00.000Z"})),
            assistant("claude-sonnet-5", json!([{"type": "text", "text": "마지막\n\n답"}]), json!({"gitBranch": "feat", "version": "2.1.316"})),
            assistant("<synthetic>", json!([{"type": "text", "text": "No response requested."}]), json!({"gitBranch": "feat", "version": "2.1.316"})),
            json!({"type": "last-prompt", "leafUuid": "x", "sessionId": A}),
        ]
    }

    #[test]
    fn claude_sessions_list_reads_fields_and_skips_sessions_without_human_prompts() {
        let root = temp_root("list");
        let proj = root.join("F--repo");
        write_jsonl(&proj.join(format!("{A}.jsonl")), &session_a());
        // 사람 프롬프트 없음(/clear 와 그 caveat 뿐) → 빠진다.
        write_jsonl(
            &proj.join(format!("{B}.jsonl")),
            &[
                user(json!("<local-command-caveat>Caveat: run directly</local-command-caveat>"), json!({"isMeta": true})),
                user(json!("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"), json!({})),
            ],
        );
        // custom-title(사용자 이름)이 ai-title 을 이긴다.
        write_jsonl(
            &proj.join(format!("{C}.jsonl")),
            &[
                json!({"type": "custom-title", "customTitle": "내가 붙인 이름", "sessionId": C}),
                user(json!("hello"), json!({"promptSource": "sdk"})),
                json!({"type": "ai-title", "aiTitle": "AI title", "sessionId": C}),
            ],
        );
        // 제목 줄이 없으면 첫 프롬프트 앞부분. 슬래시 명령은 인자가 곧 요청이다.
        let long = "가".repeat(500);
        write_jsonl(
            &root.join("C--other").join(format!("{D}.jsonl")),
            &[user(json!(format!("<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args>{long}</command-args>")), json!({}))],
        );
        // 세션이 아닌 것들은 무시한다.
        write_jsonl(&proj.join("notes.jsonl"), &[user(json!("not a session"), json!({}))]);
        std::fs::create_dir_all(proj.join("memory")).unwrap();
        std::fs::write(proj.join("empty.txt"), "").unwrap();
        let subs = proj.join(A).join("subagents");
        write_jsonl(&subs.join("agent-abc.jsonl"), &[json!({"type": "user"})]);
        std::fs::write(subs.join("agent-abc.meta.json"), r#"{"description":"리뷰"}"#).unwrap();
        write_jsonl(&subs.join("agent-def.jsonl"), &[json!({"type": "user"})]);

        let list = list_in(&root, &mut BTreeMap::new()).unwrap();
        assert_eq!(list.scanned_files, 4, "uuid 꼴 .jsonl 만 센다");
        let ids: Vec<_> = list.sessions.iter().map(|s| s.id.as_str()).collect();
        assert!(!ids.contains(&B), "사람 프롬프트 없는 세션은 빠진다: {ids:?}");
        assert_eq!(ids.len(), 3);

        let a = list.sessions.iter().find(|s| s.id == A).unwrap();
        assert_eq!(a.project_dir, "F--repo");
        assert_eq!(a.title.as_deref(), Some("New title"), "마지막 ai-title");
        assert_eq!(a.first_prompt.as_deref(), Some("첫 요청 입니다"), "잡음 걷고 공백 접기");
        assert_eq!(a.last_prompt.as_deref(), Some("마지막 요청"));
        assert_eq!(a.last_agent_text.as_deref(), Some("마지막 답"), "<synthetic> 줄은 대화가 아니다");
        assert_eq!(a.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(a.git_branch.as_deref(), Some("feat"));
        assert_eq!(a.version.as_deref(), Some("2.1.316"));
        assert_eq!(a.cwd.as_deref(), Some("F:\\repo"));
        assert_eq!((a.message_count, a.human_prompt_count, a.subagent_count), (10, 2, 2));
        assert_eq!(a.started_at_ms, parse_rfc3339_ms("2026-11-01T00:00:00.000Z"), "첫 timestamp(첨부 줄)");
        assert_eq!(a.size_bytes, std::fs::metadata(proj.join(format!("{A}.jsonl"))).unwrap().len());

        let c = list.sessions.iter().find(|s| s.id == C).unwrap();
        assert_eq!(c.title.as_deref(), Some("내가 붙인 이름"));
        assert_eq!(c.subagent_count, 0);

        let d = list.sessions.iter().find(|s| s.id == D).unwrap();
        let first = d.first_prompt.as_deref().unwrap();
        assert!(first.starts_with("/x 가가"), "{first}");
        assert_eq!(first.chars().count(), LIST_PROMPT_CHARS);
        assert!(first.ends_with('…'));
        assert_eq!(d.title.as_ref().unwrap().chars().count(), TITLE_FROM_PROMPT_CHARS);

        // 직렬화 키는 DOCS/task/77 D1 의 계약 그대로, 없는 값은 키째 빠진다.
        let j = serde_json::to_value(a).unwrap();
        for key in ["id", "projectDir", "title", "cwd", "gitBranch", "model", "version", "firstPrompt", "lastPrompt",
            "lastAgentText", "messageCount", "humanPromptCount", "subagentCount", "startedAtMs", "updatedAtMs", "sizeBytes"] {
            assert!(j.get(key).is_some(), "{key} 없음: {j}");
        }
        assert!(serde_json::to_value(c).unwrap().get("model").is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn claude_sessions_cache_hits_until_mtime_or_size_changes() {
        let root = temp_root("cache");
        let path = root.join("F--repo").join(format!("{A}.jsonl"));
        let body = |title: &str| vec![json!({"type": "ai-title", "aiTitle": title}), user(json!("hi"), json!({}))];
        write_jsonl(&path, &body("AAAA"));
        let t0 = SystemTime::now() - Duration::from_secs(3600);
        set_mtime(&path, t0);
        let mut cache = BTreeMap::new();
        let title = |cache: &mut BTreeMap<PathBuf, CachedSession>| list_in(&root, cache).unwrap().sessions[0].title.clone();
        assert_eq!(title(&mut cache).as_deref(), Some("AAAA"));

        // 같은 크기·같은 mtime → 다시 읽지 않는다(내용이 바뀌었어도 캐시 값).
        write_jsonl(&path, &body("BBBB"));
        set_mtime(&path, t0);
        assert_eq!(title(&mut cache).as_deref(), Some("AAAA"), "캐시 적중");

        let t1 = t0 + Duration::from_secs(10);
        set_mtime(&path, t1);
        assert_eq!(title(&mut cache).as_deref(), Some("BBBB"), "mtime 이 바뀌면 다시 읽는다");

        let mut lines = body("BBBB");
        lines.push(json!({"type": "ai-title", "aiTitle": "CCCC"}));
        write_jsonl(&path, &lines);
        set_mtime(&path, t1);
        assert_eq!(title(&mut cache).as_deref(), Some("CCCC"), "크기가 바뀌면 다시 읽는다");

        std::fs::remove_file(&path).unwrap();
        assert!(list_in(&root, &mut cache).unwrap().sessions.is_empty());
        assert!(cache.is_empty(), "지워진 전사의 캐시는 버린다");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn claude_session_detail_returns_recent_turns_in_order_with_limits() {
        let root = temp_root("detail");
        let proj = root.join("F--repo");
        let work = root.join("work");
        let mut lines = vec![
            json!({"type": "session-owner", "accountUuid": "acc-1", "sessionId": A}),
            user(
                json!(format!("{}<system-reminder>r</system-reminder>", "첫".repeat(5000))),
                json!({"turnOrigin": "human", "cwd": work.to_str().unwrap()}),
            ),
        ];
        for i in 0..6 {
            lines.push(user(json!(format!("질문 {i}")), json!({"turnOrigin": "human", "timestamp": format!("2026-11-01T01:0{i}:00.000Z")})));
            lines.push(assistant("m", json!([{"type": "tool_use", "id": "t", "name": "Read", "input": {}}]), json!({})));
            lines.push(user(json!([{"type": "tool_result", "tool_use_id": "t", "content": "out"}]), json!({})));
            let text = if i == 5 { "답".repeat(2000) } else { format!("답 {i}") };
            lines.push(assistant("m", json!([{"type": "text", "text": text}]), json!({"gitBranch": "feat"})));
        }
        write_jsonl(&proj.join(format!("{A}.jsonl")), &lines);
        let subs = proj.join(A).join("subagents");
        write_jsonl(&subs.join("agent-b2.jsonl"), &[json!({})]);
        write_jsonl(&subs.join("agent-a1.jsonl"), &[json!({})]);
        std::fs::write(subs.join("agent-b2.meta.json"), r#"{"agentType":"implementer","description":"먼저 띄운 것"}"#).unwrap();
        let t = SystemTime::now() - Duration::from_secs(60);
        set_mtime(&subs.join("agent-b2.jsonl"), t);
        set_mtime(&subs.join("agent-a1.jsonl"), t + Duration::from_secs(1));

        let d = detail_in(&root, "F--repo", A).unwrap();
        assert_eq!(d.first_prompt.chars().count(), DETAIL_FIRST_PROMPT_CHARS);
        assert!(d.first_prompt.starts_with("첫첫") && d.first_prompt.ends_with('…'));
        assert_eq!(d.recent.len(), DETAIL_RECENT_COUNT);
        let got: Vec<_> = d.recent.iter().map(|m| (m.role, m.text.chars().take(4).collect::<String>())).collect();
        use ClaudeSessionRole::{Assistant as As, User as Us};
        let want: Vec<_> = [(Us, "질문 2"), (As, "답 2"), (Us, "질문 3"), (As, "답 3"), (Us, "질문 4"), (As, "답 4"), (Us, "질문 5"), (As, "답답답답")]
            .iter()
            .map(|(r, t)| (*r, t.to_string()))
            .collect();
        assert_eq!(got, want, "오래된 것 → 최근 순, 텍스트 없는 도구 줄은 빠진다");
        assert_eq!(d.recent[7].text.chars().count(), DETAIL_RECENT_CHARS);
        assert_eq!(d.recent[6].timestamp_ms, parse_rfc3339_ms("2026-11-01T01:05:00.000Z"));
        assert_eq!(d.account_uuid.as_deref(), Some("acc-1"));
        assert_eq!(d.git_branch.as_deref(), Some("feat"));
        assert_eq!(d.cwd.as_deref(), work.to_str(), "첫 프롬프트 줄의 cwd");
        assert!(!d.cwd_exists, "작업 폴더가 사라진 세션");
        std::fs::create_dir_all(&work).unwrap();
        assert!(detail_in(&root, "F--repo", A).unwrap().cwd_exists);
        assert_eq!(
            d.subagents,
            [ClaudeSubagent { id: "b2".into(), description: Some("먼저 띄운 것".into()) }, ClaudeSubagent { id: "a1".into(), description: None }]
        );
        let j = serde_json::to_value(&d).unwrap();
        assert_eq!(j["recent"][0]["role"], "user");
        assert!(j["recent"][0].get("timestampMs").is_some());
        assert!(j.get("accountUuid").is_some() && j.get("firstPrompt").is_some());
        assert_eq!(j["cwdExists"], false);

        // 끝 8개가 전부 Claude 말이면 마지막 사람 프롬프트를 맨 앞(가장 오래된 칸)에 끼운다.
        let mut agentic = vec![user(json!("길게 일해 줘"), json!({"turnOrigin": "human"}))];
        for i in 0..10 {
            agentic.push(assistant("m", json!([{"type": "text", "text": format!("진행 {i}")}]), json!({})));
        }
        write_jsonl(&proj.join(format!("{B}.jsonl")), &agentic);
        let d2 = detail_in(&root, "F--repo", B).unwrap();
        let got2: Vec<_> = d2.recent.iter().map(|m| (m.role, m.text.clone())).collect();
        assert_eq!(got2.len(), DETAIL_RECENT_COUNT);
        assert_eq!(got2[0], (Us, "길게 일해 줘".to_string()), "마지막 사람 프롬프트가 남는다");
        assert_eq!(got2[1], (As, "진행 3".to_string()));
        assert_eq!(got2[7], (As, "진행 9".to_string()));
        std::fs::remove_file(proj.join(format!("{B}.jsonl"))).unwrap();

        let missing = detail_in(&root, "F--repo", B).unwrap_err();
        assert!(matches!(missing.code, ErrorCode::NotFound));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn claude_session_path_rejects_anything_but_single_components() {
        let root = Path::new("projects");
        assert!(session_path(root, "F--gitpervisor", A).is_ok());
        for bad_dir in ["", ".", "..", "...", "a/b", "a\\b", "..\\x", "C:", "x.", "x ", "a\0b"] {
            assert!(session_path(root, bad_dir, A).is_err(), "{bad_dir:?}");
        }
        for bad_id in ["", "..", "../11111111-1111-4111-8111-111111111111", "11111111111141118111111111111111",
            "1111111-11111-4111-8111-111111111111", "1111111g-1111-4111-8111-111111111111", "11111111-1111-4111-8111-1111111111111"] {
            assert!(session_path(root, "F--x", bad_id).is_err(), "{bad_id:?}");
        }
        let e = detail_in(root, "..", A).unwrap_err();
        assert!(matches!(e.code, ErrorCode::Io));
    }

    #[test]
    fn claude_sessions_clean_prompt_strips_noise() {
        assert_eq!(clean_prompt("[Image #2] <- 이거 [Image #13] 봐").as_deref(), Some("이거  봐"));
        assert_eq!(clean_prompt("[Image #12]").as_deref(), Some("[Image #12]"), "이미지만 보낸 것도 사람 프롬프트");
        assert_eq!(clean_prompt("요청\n<system-reminder>a\nb</system-reminder>").as_deref(), Some("요청"));
        assert_eq!(clean_prompt("설명\n<pasted_content id=\"42e8\">\n붙임\n</pasted_content>").as_deref(), Some("설명\n\n붙임"));
        assert_eq!(clean_prompt("요약해줘 </pasted_content id=\"3f34\">").as_deref(), Some("요약해줘"));
        assert_eq!(clean_prompt("<bash-input>ls -la</bash-input>").as_deref(), Some("ls -la"));
        assert_eq!(clean_prompt("<task-notification>\n<task-id>x</task-id>"), None);
        assert_eq!(clean_prompt("<local-command-stdout>Set model</local-command-stdout>"), None);
        assert_eq!(clean_prompt("<bash-stdout>{}</bash-stdout><bash-stderr></bash-stderr>"), None);
        assert_eq!(clean_prompt("[Request interrupted by user]"), None);
        assert_eq!(
            clean_prompt("<command-message>sc:design</command-message>\n<command-name>/sc:design</command-name>\n<command-args>설계해봐</command-args>").as_deref(),
            Some("/sc:design 설계해봐")
        );
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars("abcd", 3), "ab…");
    }

    /// 실제 `~/.claude/projects` 로 첫 스캔·재스캔 시간을 잰다(읽기만 한다).
    /// `cargo test --lib claude_sessions_real_projects_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn claude_sessions_real_projects_timing() {
        let root = projects_root().unwrap();
        let mut cache = BTreeMap::new();
        let t = Instant::now();
        let cold = list_in(&root, &mut cache).unwrap();
        let cold_ms = t.elapsed().as_millis();
        let t = Instant::now();
        let warm = list_in(&root, &mut cache).unwrap();
        let warm_ms = t.elapsed().as_millis();
        let bytes: u64 = cache.values().map(|c| c.size).sum();
        println!(
            "files={} sessions={} bytes={} cold={cold_ms}ms warm={warm_ms}ms",
            cold.scanned_files,
            cold.sessions.len(),
            bytes
        );
        assert_eq!(cold.sessions, warm.sessions);
        for s in cold.sessions.iter().take(8) {
            println!(
                "{} {} | {:?} | msgs={} human={} subs={} model={:?} branch={:?}\n   first={:?}\n   last={:?}\n   agent={:?}",
                s.project_dir, s.id, s.title, s.message_count, s.human_prompt_count, s.subagent_count, s.model, s.git_branch,
                s.first_prompt, s.last_prompt, s.last_agent_text.as_deref().map(|t| truncate_chars(t, 80))
            );
        }
        if let Some(big) = cold.sessions.iter().max_by_key(|s| s.size_bytes) {
            let t = Instant::now();
            let d = detail_in(&root, &big.project_dir, &big.id).unwrap();
            println!(
                "detail {} ({}B): {}ms recent={} subagents={} account={:?}",
                big.id,
                big.size_bytes,
                t.elapsed().as_millis(),
                d.recent.len(),
                d.subagents.len(),
                d.account_uuid
            );
        }
    }
}
