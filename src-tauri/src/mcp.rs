//! 로컬 MCP 서버 — 앱이 켜져 있는 동안 에이전트(Claude Code·Cursor)에게 **읽기 전용** 도구를 연다.
//! 설계·보안 근거: `DOCS/mcp-server-design.md`.
//!
//! 별도 프로세스(stdio)가 아니라 앱 안에서 받는 이유: 프로젝트·메모·터미널의 정본은 이 프로세스 메모리에만 있고,
//! 릴리스 빌드는 single-instance라 `gitpervisor.exe --mcp`는 첫 창으로 넘겨지고 끝난다.
//! 모양은 `llm/relay.rs`와 같다 — 블로킹 accept + 연결마다 스레드 + 동시 연결 상한, 연결 하나 = 요청 하나.

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::git::types::{Project, Settings};
use crate::llm::relay::{read_head, Request};
use crate::state::AppState;

const MAX_BODY: usize = 1024 * 1024;
/// 인증 이전 단계의 스레드 고갈 방지. 에이전트 한두 개가 도구를 순서대로 부르는 정도다.
const MAX_CONNS: usize = 8;
/// 우리가 쓰는 부분(tools)은 이 버전들에서 같다 — 클라이언트 값이 여기 있으면 그대로 돌려준다.
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_FILES_PER_KIND: usize = 30;
const MAX_SEARCH_LINES: usize = 200;
const TERMINAL_SCROLLBACK: usize = 5000;

const INSTRUCTIONS: &str = "Gitpervisor is the user's multi-repository Git dashboard running on this machine. \
These tools are read-only views of its live state: registered projects, git status of every repo, \
code search across repos, the user's other open terminals, and project memos. \
Call list_projects first; `project` arguments accept a project id or name.";

struct Running {
    port: u16,
    token: String,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

static SERVER: Mutex<Option<Running>> = Mutex::new(None);
/// 마지막 시작 실패(포트 사용 중 등) — 설정 화면이 `mcp_status`로 보여 준다.
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);
static CONNS: AtomicUsize = AtomicUsize::new(0);

struct ConnGuard;
impl Drop for ConnGuard {
    fn drop(&mut self) {
        CONNS.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 설정대로 서버를 맞춘다 — 시작 시 한 번, `set_settings` 뒤마다. 이미 같은 포트·토큰으로 떠 있으면 그대로 둔다.
pub fn apply(app: &AppHandle, s: &Settings) {
    let want = (s.mcp_enabled && !s.mcp_token.is_empty()).then(|| (s.mcp_port, s.mcp_token.clone()));
    let mut guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(r), Some((port, token))) = (guard.as_ref(), want.as_ref()) {
        if r.port == *port && r.token == *token && !r.stop.load(Ordering::Relaxed) {
            return;
        }
    }
    if let Some(r) = guard.take() {
        stop(r);
    }
    *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let Some((port, token)) = want else {
        if s.mcp_enabled {
            log::warn!("[mcp] 토큰이 비어 있어 서버를 띄우지 않습니다"); // i18n-ok: 로그
        }
        return;
    };
    match start(app, port, token) {
        Ok(r) => *guard = Some(r),
        Err(e) => {
            log::warn!("[mcp] 127.0.0.1:{port} 시작 실패: {e}"); // i18n-ok: 로그
            *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.to_string());
        }
    }
}

fn start(app: &AppHandle, port: u16, token: String) -> std::io::Result<Running> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let stop = Arc::new(AtomicBool::new(false));
    let (t_stop, t_token, t_app) = (stop.clone(), token.clone(), app.clone());
    let thread = std::thread::Builder::new()
        .name("mcp-server".into())
        .spawn(move || accept_loop(listener, port, t_token, t_app, t_stop))?;
    log::info!("[mcp] 127.0.0.1:{port}/mcp 에서 대기"); // i18n-ok: 로그
    Ok(Running { port, token, stop, thread })
}

/// 블로킹 accept를 자기 포트 접속으로 깨워 리스너를 닫게 한다. 바로 같은 포트로 다시 띄울 수 있게
/// 스레드가 끝날 때(= 리스너 drop)까지 기다린다 — 깨우기에 실패했으면 기다리지 않는다(영구 대기 방지).
fn stop(r: Running) {
    r.stop.store(true, Ordering::Relaxed);
    let woke = TcpStream::connect_timeout(&([127, 0, 0, 1], r.port).into(), Duration::from_secs(1)).is_ok();
    if woke {
        if r.thread.join().is_err() {
            log::warn!("[mcp] accept 스레드가 패닉으로 끝났습니다"); // i18n-ok: 로그
        }
    } else if !r.thread.is_finished() {
        log::warn!("[mcp] accept 스레드를 깨우지 못했습니다 — 포트가 잠시 남을 수 있습니다"); // i18n-ok: 로그
    }
    log::info!("[mcp] 127.0.0.1:{} 중지", r.port); // i18n-ok: 로그
}

fn accept_loop(listener: TcpListener, port: u16, token: String, app: AppHandle, stop: Arc<AtomicBool>) {
    loop {
        let accepted = listener.accept();
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let stream = match accepted {
            Ok((s, _)) => s,
            Err(e) => {
                log::warn!("[mcp] accept 실패 — 서버를 종료합니다: {e}"); // i18n-ok: 로그
                *LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.to_string());
                stop.store(true, Ordering::Relaxed);
                return;
            }
        };
        if CONNS.fetch_add(1, Ordering::Relaxed) >= MAX_CONNS {
            CONNS.fetch_sub(1, Ordering::Relaxed);
            let mut s = stream;
            // 응답을 못 보내도 연결은 곧 닫힌다 — 상한 초과를 알리는 것 이상의 의미가 없다.
            let _ = respond(&mut s, 503, None);
            continue;
        }
        let (token, app) = (token.clone(), app.clone());
        let spawned = std::thread::Builder::new().name("mcp-conn".into()).spawn(move || {
            let _guard = ConnGuard;
            let call = |name: &str, args: &Value| tauri::async_runtime::block_on(call_tool(&app, name, args));
            if let Err(e) = handle_conn(stream, port, &token, &call) {
                log::debug!("[mcp] 연결 종료: {e}"); // i18n-ok: 로그
            }
        });
        if let Err(e) = spawned {
            CONNS.fetch_sub(1, Ordering::Relaxed);
            log::warn!("[mcp] 연결 스레드 생성 실패: {e}"); // i18n-ok: 로그
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    running: bool,
    port: Option<u16>,
    error: Option<String>,
}

#[tauri::command(async)]
pub fn mcp_status() -> McpStatus {
    let guard = SERVER.lock().unwrap_or_else(|e| e.into_inner());
    let live = guard.as_ref().filter(|r| !r.stop.load(Ordering::Relaxed));
    McpStatus {
        running: live.is_some(),
        port: live.map(|r| r.port),
        error: LAST_ERROR.lock().unwrap_or_else(|e| e.into_inner()).clone(),
    }
}

// ---- HTTP ----

type ToolCall<'a> = &'a dyn Fn(&str, &Value) -> Result<String, String>;

fn handle_conn(mut stream: TcpStream, port: u16, token: &str, call: ToolCall) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let Some(req) = read_head(&mut reader)? else {
        return respond(&mut stream, 400, None);
    };
    if let Some(code) = gate(&req, port, token) {
        return respond(&mut stream, code, None);
    }
    if req.headers.contains_key("transfer-encoding") {
        return respond(&mut stream, 411, None);
    }
    let len: usize = req.headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return respond(&mut stream, 413, None);
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    match dispatch(&body, call) {
        Some(reply) => respond(&mut stream, 200, Some(&reply)),
        None => respond(&mut stream, 202, None),
    }
}

/// 본문을 읽기 전의 문지기. 통과면 None, 막으면 상태 코드(§4).
fn gate(req: &Request, port: u16, token: &str) -> Option<u16> {
    // MCP 클라이언트(비브라우저)는 Origin을 보내지 않는다 — 브라우저발 요청을 통째로 막는다.
    if req.headers.contains_key("origin") {
        return Some(403);
    }
    // DNS rebinding 2차 방어 — 공격 페이지의 도메인이 Host로 온다.
    let host = req.headers.get("host").map(String::as_str).unwrap_or("");
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Some(403);
    }
    if !token_matches(req.headers.get("authorization"), token) {
        return Some(401);
    }
    if req.path.split('?').next() != Some("/mcp") {
        return Some(404);
    }
    // GET(SSE 스트림 열기)·DELETE(세션 종료) — 서버 발신 메시지도 세션도 없다(스펙이 405를 허용).
    if req.method != "POST" {
        return Some(405);
    }
    None
}

/// 상수 시간 비교 — 응답 시간으로 토큰을 한 글자씩 맞혀 보는 것을 막는다.
fn token_matches(header: Option<&String>, token: &str) -> bool {
    let Some(got) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return false;
    };
    got.len() == token.len() && got.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn respond(stream: &mut TcpStream, code: u16, body: Option<&Value>) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        _ => "Service Unavailable",
    };
    let body = body.map(Value::to_string).unwrap_or_default();
    let allow = if code == 405 { "Allow: POST\r\n" } else { "" };
    write!(
        stream,
        "HTTP/1.1 {code} {reason}\r\n{allow}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    stream.flush()
}

// ---- JSON-RPC ----

/// 요청 하나를 처리한다. None = 응답 본문 없음(알림·클라이언트의 응답 → 202).
fn dispatch(body: &[u8], call: ToolCall) -> Option<Value> {
    let msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return Some(rpc_error(Value::Null, -32700, "parse error")),
    };
    // 배열(배치)은 최신 스펙에서 빠졌고 MCP 클라이언트도 보내지 않는다.
    if !msg.is_object() {
        return Some(rpc_error(Value::Null, -32600, "expected a single JSON-RPC object"));
    }
    let id = msg.get("id").cloned();
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        // 우리가 보낸 요청에 대한 응답일 수 있다 — 요청을 보내지 않으므로 받고 버린다.
        return match id {
            Some(_) if msg.get("result").is_some() || msg.get("error").is_some() => None,
            _ => Some(rpc_error(id.unwrap_or(Value::Null), -32600, "missing method")),
        };
    };
    let id = id?; // id 없는 메시지는 알림이다(notifications/initialized 등).
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str);
            let version = asked.filter(|v| PROTOCOL_VERSIONS.contains(v)).unwrap_or(PROTOCOL_VERSIONS[0]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "gitpervisor", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tool_defs() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if !tool_defs().iter().any(|t| t["name"] == name) {
                return Some(rpc_error(id, -32602, &format!("unknown tool: {name}")));
            }
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            // 도구 실패는 프로토콜 오류가 아니라 결과다 — 모델이 메시지를 읽고 인자를 고친다.
            let (text, is_error) = match call(name, &args) {
                Ok(t) => (t, false),
                Err(e) => (e, true),
            };
            json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
        }
        _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn rpc_error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_defs() -> Vec<Value> {
    let project = json!({ "type": "string", "description": "Project id or name (from list_projects)." });
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "name": name,
            "description": description,
            "inputSchema": { "type": "object", "properties": properties, "required": required },
            "annotations": { "readOnlyHint": true },
        })
    };
    vec![
        tool("list_projects", "List the repositories registered in Gitpervisor (id, name, path).", json!({}), &[]),
        tool(
            "repo_status",
            "Git status of one project, or of every project when `project` is omitted: branch, upstream, \
ahead/behind, in-progress merge/rebase, staged/unstaged/untracked/conflicted files, last background fetch. \
Embedded repositories inside a project are included. All projects can take 20-30 s — pass `project` when you can.",
            json!({ "project": project }),
            &[],
        ),
        tool(
            "git_log",
            "Recent commits of a project: sha, date, author, subject, refs.",
            json!({
                "project": project,
                "limit": { "type": "integer", "description": "Default 20, max 100." },
                "all_refs": { "type": "boolean", "description": "Include all branches, not just HEAD." },
            }),
            &["project"],
        ),
        tool(
            "search_code",
            "git grep across one project, or every registered project when `project` is omitted. \
Returns `project:path:line: text`, at most 200 lines.",
            json!({
                "query": { "type": "string", "description": "2-512 characters." },
                "project": project,
                "regex": { "type": "boolean", "description": "Perl regex instead of a literal string." },
                "case_sensitive": { "type": "boolean" },
                "include": { "type": "array", "items": { "type": "string" }, "description": "Pathspec globs, e.g. [\"*.rs\"]." },
            }),
            &["query"],
        ),
        tool(
            "list_terminals",
            "Terminals open in Gitpervisor (often other coding agents, dev servers or builds) with the last line on screen.",
            json!({}),
            &[],
        ),
        tool(
            "read_terminal",
            "Text currently on a terminal's screen plus its recent scrollback (about the last 256 KB of output).",
            json!({
                "term_id": { "type": "string", "description": "From list_terminals; a unique prefix is enough." },
                "lines": { "type": "integer", "description": "Last N lines. Default 100, max 2000." },
            }),
            &["term_id"],
        ),
        tool("read_memos", "The user's memos for one project, or all projects.", json!({ "project": project }), &[]),
    ]
}

// ---- 도구 ----

async fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Result<String, String> {
    let state = app.state::<AppState>();
    let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_string);
    let b = |k: &str| args.get(k).and_then(Value::as_bool).unwrap_or(false);
    let n = |k: &str, default: u64, max: u64| args.get(k).and_then(Value::as_u64).unwrap_or(default).clamp(1, max);
    match name {
        "list_projects" => {
            let list: Vec<Value> = projects(&state)
                .iter()
                .map(|p| json!({ "id": p.id, "name": p.name, "path": p.path }))
                .collect();
            pretty(&list)
        }
        "repo_status" => {
            let targets = resolve(&state, s("project").as_deref())?;
            let names = name_map(&projects(&state));
            let ids = targets.iter().map(|p| p.id.clone()).collect();
            let statuses = crate::commands::get_statuses(app.state(), ids).await.map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for st in &statuses {
                let mut v = serde_json::to_value(st).map_err(|e| e.to_string())?;
                v["project"] = json!(display_name(&names, &st.project_id));
                compact_status(&mut v);
                out.push(v);
            }
            pretty(&out)
        }
        "git_log" => {
            let p = resolve_one(&state, s("project").as_deref())?;
            let limit = n("limit", 20, 100) as u32;
            let commits = crate::commands::get_log(app.state(), p.id, Some(limit), None, Some(b("all_refs")))
                .await
                .map_err(|e| e.to_string())?;
            if commits.is_empty() {
                return Ok("no commits".into());
            }
            Ok(commits
                .iter()
                .map(|c| {
                    let refs = if c.refs.is_empty() { String::new() } else { format!(" ({})", c.refs.join(", ")) };
                    let date = c.authored_at.get(..10).unwrap_or(&c.authored_at);
                    let sha = c.sha.get(..10).unwrap_or(&c.sha);
                    format!("{sha} {date} {}: {}{refs}", c.author_name, c.subject)
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "search_code" => {
            let query = s("query").ok_or("`query` is required")?;
            let include: Vec<String> = args
                .get("include")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let targets = resolve(&state, s("project").as_deref())?;
            let (regex, case) = (b("regex"), b("case_sensitive"));
            let runs = targets.iter().map(|p| {
                let (query, include) = (query.clone(), include.clone());
                async move {
                    let r = crate::commands::search_in_project(app.state(), p.id.clone(), query, regex, case, false, include)
                        .await;
                    (p.name.clone(), r)
                }
            });
            let single = targets.len() == 1;
            let mut lines = Vec::new();
            let mut failed = Vec::new();
            let mut truncated = false;
            for (project, r) in futures::future::join_all(runs).await {
                match r {
                    Ok(res) => {
                        truncated |= res.truncated;
                        for f in &res.files {
                            for m in &f.matches {
                                lines.push(format!("{project}:{}:{}: {}", f.path, m.line, m.text.trim()));
                            }
                        }
                    }
                    // 하나만 찍었으면 그 실패가 답이다(잘못된 정규식 등).
                    Err(e) if single => return Err(e.to_string()),
                    Err(e) => failed.push(format!("{project} ({e})")),
                }
            }
            if lines.len() > MAX_SEARCH_LINES {
                truncated = true;
                lines.truncate(MAX_SEARCH_LINES);
            }
            if lines.is_empty() {
                lines.push("no matches".into());
            }
            if truncated {
                lines.push("… truncated — narrow with `project` or `include`".into());
            }
            // 전체 검색에서는 git 저장소가 아닌 등록 폴더(다운로드 등)가 흔하다 — 줄마다 섞지 않고 끝에 한 줄로.
            if !failed.is_empty() {
                lines.push(format!("not searched: {}", failed.join("; ")));
            }
            Ok(lines.join("\n"))
        }
        "list_terminals" => {
            let names = name_map(&projects(&state));
            let terms = crate::commands::term_snapshots(&state);
            if terms.is_empty() {
                return Ok("no terminals open".into());
            }
            Ok(terms
                .iter()
                .map(|t| {
                    let last = render_terminal_lines(&t.tail, t.rows, t.cols).pop().unwrap_or_default();
                    let last: String = last.trim().chars().take(160).collect();
                    let shell = std::path::Path::new(&t.shell).file_name().map_or(t.shell.clone(), |f| {
                        f.to_string_lossy().into_owned()
                    });
                    format!(
                        "{}  project={}  shell={shell}  size={}x{}  last: {last}",
                        t.term_id,
                        display_name(&names, &t.project_id),
                        t.cols,
                        t.rows
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "read_terminal" => {
            let id = s("term_id").ok_or("`term_id` is required")?;
            let mut hits: Vec<_> =
                crate::commands::term_snapshots(&state).into_iter().filter(|t| t.term_id.starts_with(&id)).collect();
            let t = match (hits.pop(), hits.is_empty()) {
                (Some(t), true) if !id.is_empty() => t,
                (Some(_), false) => return Err(format!("`{id}` matches several terminals — give more characters")),
                _ => return Err(format!("no terminal `{id}` — call list_terminals")),
            };
            let lines = render_terminal_lines(&t.tail, t.rows, t.cols);
            let keep = n("lines", 100, 2000) as usize;
            let text = lines[lines.len().saturating_sub(keep)..].join("\n");
            Ok(if text.is_empty() { "(no output yet)".into() } else { text })
        }
        "read_memos" => {
            let targets = resolve(&state, s("project").as_deref())?;
            let notes = state.notes.read().unwrap_or_else(|e| e.into_inner()).clone();
            let mut out = Vec::new();
            for p in &targets {
                let Some(memos) = notes.get(&p.id).filter(|m| !m.is_empty()) else { continue };
                out.push(format!("## {}", p.name));
                for m in memos {
                    out.push(format!("- ({}) {}", m.updated_at, m.text));
                }
            }
            Ok(if out.is_empty() { "no memos".into() } else { out.join("\n") })
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn pretty<T: Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string_pretty(v).map_err(|e| e.to_string())
}

fn projects(state: &AppState) -> Vec<Project> {
    state.projects.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn name_map(projects: &[Project]) -> HashMap<String, String> {
    projects.iter().map(|p| (p.id.clone(), p.name.clone())).collect()
}

/// 임베디드 저장소는 합성 id(`<바깥 id>::<상대경로>`)다 — 바깥 이름 + 경로로 보여 준다.
fn display_name(names: &HashMap<String, String>, id: &str) -> String {
    match id.split_once("::") {
        Some((outer, rel)) => format!("{}/{rel}", names.get(outer).map_or(outer, String::as_str)),
        None => names.get(id).cloned().unwrap_or_else(|| id.to_string()),
    }
}

/// `project` 인자 해석 — 없으면 전체, 있으면 id 또는 이름(대소문자 무시) 하나.
fn resolve(state: &AppState, arg: Option<&str>) -> Result<Vec<Project>, String> {
    let all = projects(state);
    let Some(q) = arg.map(str::trim).filter(|q| !q.is_empty()) else {
        return Ok(all);
    };
    let lower = q.to_lowercase();
    all.into_iter()
        .find(|p| p.id == q || p.name.to_lowercase() == lower)
        .map(|p| vec![p])
        .ok_or_else(|| format!("no project matches `{q}` — call list_projects"))
}

fn resolve_one(state: &AppState, arg: Option<&str>) -> Result<Project, String> {
    if arg.map_or(true, |a| a.trim().is_empty()) {
        return Err("`project` is required".into());
    }
    resolve(state, arg).map(|mut v| v.remove(0))
}

/// 에이전트 컨텍스트를 아끼려고 null 필드를 빼고, 파일은 `"<종류> <경로>"` 한 줄로(종류별 30개까지만 + 남은 수).
fn compact_status(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else { return };
    obj.retain(|k, val| !val.is_null() && k != "projectId");
    for key in ["staged", "unstaged", "untracked", "conflicted"] {
        let Some(list) = obj.get_mut(key).and_then(Value::as_array_mut) else { continue };
        if list.is_empty() {
            obj.remove(key);
            continue;
        }
        let more = list.len().saturating_sub(MAX_FILES_PER_KIND);
        list.truncate(MAX_FILES_PER_KIND);
        for f in list.iter_mut() {
            let field = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let mut line = format!("{} {}", field("kind"), field("path"));
            if let Some(orig) = f.get("origPath").and_then(Value::as_str) {
                line.push_str(&format!(" (from {orig})"));
            }
            *f = json!(line);
        }
        if more > 0 {
            obj.insert(format!("{key}More"), json!(more));
        }
    }
}

/// 원시 PTY 출력을 화면으로 다시 그려 줄 목록(스크롤백 → 화면 순)으로 돌려준다.
/// ANSI만 지우면 안 된다 — Windows ConPTY는 평범한 셸 출력도 커서 이동으로 다시 그린다(설계 §5.1).
fn render_terminal_lines(bytes: &[u8], rows: u16, cols: u16) -> Vec<String> {
    let (rows, cols) = (rows.max(2), cols.max(2));
    let mut parser = vt100::Parser::new(rows, cols, TERMINAL_SCROLLBACK);
    parser.process(bytes);
    let screen = parser.screen_mut();
    screen.set_scrollback(usize::MAX);
    let mut offset = screen.scrollback();
    let mut lines: Vec<String> = Vec::new();
    // 오프셋 o에서 보이는 첫 min(o, rows)줄이 스크롤백이다 — 위에서부터 그만큼씩 내려온다.
    while offset > 0 {
        screen.set_scrollback(offset);
        let take = offset.min(rows as usize);
        lines.extend(screen.rows(0, cols).take(take));
        offset -= take;
    }
    screen.set_scrollback(0);
    lines.extend(screen.rows(0, cols));
    for l in &mut lines {
        l.truncate(l.trim_end().len());
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, path: &str, headers: &[(&str, &str)]) -> Request {
        Request {
            method: method.into(),
            path: path.into(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    #[test]
    fn mcp_gate_blocks_browsers_wrong_host_and_missing_token() {
        let ok = [("host", "127.0.0.1:47820"), ("authorization", "Bearer tok")];
        assert_eq!(gate(&req("POST", "/mcp", &ok), 47820, "tok"), None);
        assert_eq!(gate(&req("POST", "/mcp", &[("host", "localhost:47820"), ok[1]]), 47820, "tok"), None);
        let with_origin = [ok[0], ok[1], ("origin", "http://127.0.0.1:47820")];
        assert_eq!(gate(&req("POST", "/mcp", &with_origin), 47820, "tok"), Some(403));
        assert_eq!(gate(&req("POST", "/mcp", &[("host", "evil.example:47820"), ok[1]]), 47820, "tok"), Some(403));
        assert_eq!(gate(&req("POST", "/mcp", &[ok[0], ("authorization", "Bearer tox")]), 47820, "tok"), Some(401));
        assert_eq!(gate(&req("POST", "/mcp", &[ok[0], ("authorization", "Bearer tokk")]), 47820, "tok"), Some(401));
        assert_eq!(gate(&req("POST", "/mcp", &[ok[0]]), 47820, "tok"), Some(401));
        assert_eq!(gate(&req("POST", "/other", &ok), 47820, "tok"), Some(404));
        assert_eq!(gate(&req("GET", "/mcp", &ok), 47820, "tok"), Some(405));
    }

    #[test]
    fn mcp_dispatch_handles_lifecycle_and_tool_errors() {
        let call = |name: &str, _: &Value| if name == "list_projects" { Ok("[]".into()) } else { Err("boom".into()) };
        let send = |v: Value| dispatch(v.to_string().as_bytes(), &call);

        let init = send(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}))
            .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        let unknown_ver = send(json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}))
            .unwrap();
        assert_eq!(unknown_ver["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);

        assert!(send(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        assert!(send(json!({"jsonrpc":"2.0","id":9,"result":{}})).is_none());

        let list = send(json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).unwrap();
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            ["list_projects", "repo_status", "git_log", "search_code", "list_terminals", "read_terminal", "read_memos"]
        );

        let ok = send(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_projects"}})).unwrap();
        assert_eq!(ok["result"]["isError"], false);
        assert_eq!(ok["result"]["content"][0]["text"], "[]");
        let failed = send(json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"git_log","arguments":{}}}))
            .unwrap();
        assert_eq!(failed["result"]["isError"], true);
        assert_eq!(failed["result"]["content"][0]["text"], "boom");

        let bad_tool = send(json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"rm_rf"}})).unwrap();
        assert_eq!(bad_tool["error"]["code"], -32602);
        assert_eq!(send(json!({"jsonrpc":"2.0","id":7,"method":"nope"})).unwrap()["error"]["code"], -32601);
        assert_eq!(dispatch(b"{not json", &call).unwrap()["error"]["code"], -32700);
        assert_eq!(dispatch(b"[]", &call).unwrap()["error"]["code"], -32600);
    }

    #[test]
    fn terminal_render_follows_cursor_moves_and_keeps_scrollback() {
        // ConPTY 식 다시 그리기: 2행에 쓰고, 커서를 1행으로 옮겨 덮어쓴다. ANSI만 지우면 "old"가 남는다.
        let bytes = b"\x1b[2J\x1b[Hold line\r\nsecond\x1b[1;1Hnew line\x1b[K";
        assert_eq!(render_terminal_lines(bytes, 5, 20), ["new line", "second"]);

        // 화면(3행)보다 많은 줄 — 넘친 줄은 스크롤백에서 순서대로 나온다.
        let many: Vec<u8> = (1..=10).flat_map(|i| format!("l{i}\r\n").into_bytes()).collect();
        let lines = render_terminal_lines(&many, 3, 10);
        assert_eq!(lines, (1..=10).map(|i| format!("l{i}")).collect::<Vec<_>>());
    }

    #[test]
    fn compact_status_drops_nulls_and_caps_file_lists() {
        let mut files: Vec<Value> =
            (0..35).map(|i| json!({ "path": format!("f{i}"), "origPath": null, "kind": "modified", "staged": false })).collect();
        files[0] = json!({ "path": "new.rs", "origPath": "old.rs", "kind": "renamed", "staged": true });
        let mut v = json!({ "projectId": "x", "branch": "main", "error": null, "staged": [], "untracked": files });
        compact_status(&mut v);
        assert!(v.get("projectId").is_none() && v.get("error").is_none() && v.get("staged").is_none());
        assert_eq!(v["untracked"].as_array().unwrap().len(), MAX_FILES_PER_KIND);
        assert_eq!(v["untrackedMore"], 5);
        assert_eq!(v["untracked"][0], "renamed new.rs (from old.rs)");
        assert_eq!(v["untracked"][1], "modified f1");
        assert_eq!(v["branch"], "main");
    }
}
