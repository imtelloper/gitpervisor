//! 코딩 에이전트(OpenCode)용 로컬 모델 중계 — 앱 수명 동안 **고정된 루프백 주소 하나**로
//! llama-server(또는 설정의 외부 OpenAI 호환 서버)를 내보인다.
//!
//! 에이전트를 llama-server에 직접 붙이지 않는 이유 셋:
//! - llama-server는 기동마다 포트·API 키가 바뀐다(`server.rs` free_port·random_key). OpenCode 설정에
//!   적어 둔 주소가 서버가 한 번 내려갔다 뜨면 틀린 주소가 된다.
//! - 유휴 리퍼는 앱 안의 요청만 활동으로 센다. 에이전트가 서버에 직접 붙으면 쓰는 도중에 10분 리퍼가
//!   서버를 내린다. 중계는 요청·청크마다 `touch_activity`를 부른다.
//! - 요청이 왔을 때 서버가 꺼져 있으면 `ensure_server_ctx`로 깨운다(에이전트용 32K 컨텍스트로).
//!
//! 프리뷰 서버(`commands/preview.rs`)와 같은 모양이다 — 블로킹 accept + 연결마다 스레드 + 토큰.
//! 상류 요청은 reqwest 스트리밍이라 연결 스레드에서 `block_on`으로 돈다(tokio 워커가 아닌 스레드라 안전).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::server::{self, Endpoint, AGENT_MIN_CTX};
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_db;
use crate::state::AppState;

/// 요청 머리 상한 — 헤더 폭탄으로 메모리를 잡아먹지 않게.
const MAX_HEAD: usize = 64 * 1024;
/// 요청 본문 상한. OpenCode 첫 요청이 50KB였고 대화가 길어지면 커지지만 컨텍스트(32K 토큰)를
/// 넘는 본문은 어차피 상류가 거절한다 — 32MB는 이미지 첨부까지 넉넉한 안전판이다.
const MAX_BODY: usize = 32 * 1024 * 1024;
/// 동시 연결 상한(인증 이전 단계의 스레드 고갈 방지). 에이전트는 제목 생성 + 본 요청 정도만 동시에 연다.
const MAX_CONNS: usize = 16;

struct Relay {
    port: u16,
    token: String,
    alive: Arc<AtomicBool>,
}

static RELAY: Mutex<Option<Relay>> = Mutex::new(None);
static CONNS: AtomicUsize = AtomicUsize::new(0);

struct ConnGuard;
impl Drop for ConnGuard {
    fn drop(&mut self) {
        CONNS.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 중계를 보장하고 `(포트, 토큰)`을 돌려준다. 살아 있으면 재사용 — 토큰이 앱 수명 동안 고정이라
/// 이미 떠 있는 OpenCode 세션의 설정이 계속 맞는다. 리스너가 죽었으면 새로 띄운다(자기 치유).
pub fn ensure_relay(app: &AppHandle) -> Result<(u16, String), IpcError> {
    let mut guard = RELAY.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(r) = guard.as_ref().filter(|r| r.alive.load(Ordering::Relaxed)) {
        return Ok((r.port, r.token.clone()));
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| IpcError::new(ErrorCode::Io, text_db::llm_relay_start_failed(e)))?;
    let port = listener
        .local_addr()
        .map_err(|e| IpcError::new(ErrorCode::Io, text_db::llm_relay_start_failed(e)))?
        .port();
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let alive = Arc::new(AtomicBool::new(true));
    let (t_alive, t_token, t_app) = (alive.clone(), token.clone(), app.clone());
    std::thread::Builder::new()
        .name("llm-relay".into())
        .spawn(move || accept_loop(listener, t_token, t_app, t_alive))
        .map_err(|e| IpcError::new(ErrorCode::Io, text_db::llm_relay_start_failed(e)))?;
    log::info!("[llm-relay] 127.0.0.1:{port} 에서 대기"); // i18n-ok: 로그
    *guard = Some(Relay { port, token: token.clone(), alive });
    Ok((port, token))
}

fn accept_loop(listener: TcpListener, token: String, app: AppHandle, alive: Arc<AtomicBool>) {
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                if CONNS.fetch_add(1, Ordering::Relaxed) >= MAX_CONNS {
                    CONNS.fetch_sub(1, Ordering::Relaxed);
                    let mut s = stream;
                    // 응답을 못 보내도 연결은 곧 닫힌다 — 상한 초과를 알리는 것 이상의 의미가 없다.
                    let _ = write_simple(&mut s, 503, "too many connections");
                    continue;
                }
                let (token, app) = (token.clone(), app.clone());
                let spawned = std::thread::Builder::new().name("llm-relay-conn".into()).spawn(move || {
                    let _guard = ConnGuard;
                    let state = app.state::<AppState>();
                    // 진행(모델 로드 중)은 에이전트에게 보여 줄 길이 없다 — 첫 요청이 로드 시간만큼 늦을 뿐이다.
                    let silent = Channel::new(|_| Ok(()));
                    let resolve = || {
                        tauri::async_runtime::block_on(server::ensure_server_ctx(
                            &app,
                            state.inner(),
                            &silent,
                            None,
                            AGENT_MIN_CTX,
                        ))
                    };
                    let touch = || server::touch_activity(state.inner());
                    if let Err(e) = handle_conn(stream, &token, &resolve, &touch) {
                        log::debug!("[llm-relay] 연결 종료: {e}"); // i18n-ok: 로그
                    }
                });
                if let Err(e) = spawned {
                    // 스레드를 못 만들었으면 가드도 안 만들어졌다 — 세어 둔 1을 돌려준다.
                    CONNS.fetch_sub(1, Ordering::Relaxed);
                    log::warn!("[llm-relay] 연결 스레드 생성 실패: {e}"); // i18n-ok: 로그
                }
            }
            Err(e) => {
                // 반드시 alive를 내린다 — 안 내리면 ensure_relay가 죽은 포트를 계속 내준다(preview.rs와 같은 함정).
                log::warn!("[llm-relay] accept 실패 — 중계를 종료합니다: {e}"); // i18n-ok: 로그
                alive.store(false, Ordering::Relaxed);
                return;
            }
        }
    }
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

/// 요청 머리(요청 줄 + 헤더, 빈 줄 제외) 해석. 헤더 이름은 소문자로 둔다.
fn parse_head(lines: &[String]) -> Option<Request> {
    let mut parts = lines.first()?.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let headers = lines[1..]
        .iter()
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some(Request { method, path, headers })
}

/// 중계가 받아 주는 경로 — OpenAI 호환 API(`/v1/…`)만. 상류로 이어 붙이므로 `..`·절대 URL은 막는다.
fn allowed_path(path: &str) -> bool {
    path.starts_with("/v1/") && !path.contains("..") && !path.contains("://")
}

/// 본문의 `model`을 상류의 실제 모델 이름으로 바꾼다. OpenCode는 자기 설정의 id(`local`)를 보내는데,
/// llama-server는 무시하지만 외부 서버(Ollama 등)는 그 이름으로 모델을 찾는다. JSON이 아니면 그대로.
fn rewrite_model(body: &[u8], model: &str) -> Vec<u8> {
    match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(mut v) if v.get("model").is_some() => {
            v["model"] = serde_json::Value::String(model.to_string());
            serde_json::to_vec(&v).unwrap_or_else(|_| body.to_vec())
        }
        _ => body.to_vec(),
    }
}

/// HTTP/1.1 chunked 조각 하나.
fn chunk_frame(data: &[u8]) -> Vec<u8> {
    let mut out = format!("{:x}\r\n", data.len()).into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\r\n");
    out
}

fn reason(code: u16) -> &'static str {
    reqwest::StatusCode::from_u16(code)
        .ok()
        .and_then(|s| s.canonical_reason())
        .unwrap_or("")
}

/// OpenAI 형식 오류 본문 — OpenCode가 `error.message`를 화면에 그대로 보여 준다.
fn write_simple(stream: &mut TcpStream, code: u16, message: &str) -> std::io::Result<()> {
    let body = serde_json::json!({ "error": { "message": message, "type": "gitpervisor_relay" } }).to_string();
    write!(
        stream,
        "HTTP/1.1 {code} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        reason(code),
        body.len()
    )?;
    stream.flush()
}

/// 연결 하나 = 요청 하나(응답 후 닫는다 — keep-alive를 흉내 내지 않는다).
/// `resolve`가 상류를 정하고(필요하면 서버 기동), `touch`가 유휴 타이머를 민다 — 테스트는 가짜를 넘긴다.
fn handle_conn(
    mut stream: TcpStream,
    token: &str,
    resolve: &dyn Fn() -> Result<Endpoint, IpcError>,
    touch: &dyn Fn(),
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut lines = Vec::new();
    let mut head_bytes = 0usize;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        head_bytes += n;
        if n == 0 || head_bytes > MAX_HEAD {
            return write_simple(&mut stream, 400, "bad request");
        }
        let line = line.trim_end_matches(['\r', '\n']).to_string();
        if line.is_empty() {
            break;
        }
        lines.push(line);
    }
    let Some(req) = parse_head(&lines) else {
        return write_simple(&mut stream, 400, "bad request");
    };
    // 인증을 가장 먼저 — 토큰 없는 요청은 경로·본문을 보기 전에 끊는다(모델 기동도 하지 않는다).
    if req.headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {token}")) {
        return write_simple(&mut stream, 401, "unauthorized");
    }
    if !allowed_path(&req.path) {
        return write_simple(&mut stream, 404, "not found");
    }
    let method = match req.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return write_simple(&mut stream, 405, "method not allowed"),
    };
    if req.headers.contains_key("transfer-encoding") {
        return write_simple(&mut stream, 411, "length required");
    }
    let len: usize = req
        .headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return write_simple(&mut stream, 413, "payload too large");
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    let ep = match resolve() {
        Ok(ep) => ep,
        Err(e) => return write_simple(&mut stream, 503, &e.to_string()),
    };
    touch();
    let body = if len > 0 { rewrite_model(&body, &ep.model) } else { body };
    let url = format!("{}{}", ep.base, req.path);
    let content_type = req
        .headers
        .get("content-type")
        .cloned()
        .unwrap_or_else(|| "application/json".to_string());

    tauri::async_runtime::block_on(async {
        let mut rb = server::http()
            .request(method, &url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(body);
        if let Some(key) = &ep.key {
            rb = rb.bearer_auth(key);
        }
        let mut resp = match rb.send().await {
            Ok(r) => r,
            Err(e) => return write_simple(&mut stream, 502, &text_db::llm_relay_upstream_failed(e)),
        };
        let code = resp.status().as_u16();
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        write!(
            stream,
            "HTTP/1.1 {code} {}\r\nContent-Type: {ctype}\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            reason(code)
        )?;
        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => break,
                // 상류가 도중에 끊겼다 — 받은 데까지는 이미 보냈다. 종결 조각 없이 닫으면 클라이언트가
                // "응답이 잘렸다"로 알아챈다(정상 종료로 속이지 않는다).
                Err(e) => return Err(std::io::Error::other(e)),
            };
            // 에이전트가 요청을 취소하면 여기서 쓰기가 실패한다 — 반환하면 resp가 drop되어
            // 상류 연결이 끊기고 llama-server도 생성을 멈춘다.
            stream.write_all(&chunk_frame(&chunk))?;
            stream.flush()?;
            touch();
        }
        stream.write_all(b"0\r\n\r\n")?;
        stream.flush()
    })
}

/// 수동 종단 테스트용 — 고정 상류로 중계를 띄우고 포트를 돌려준다(`commands/opencode.rs` 수동 테스트).
#[cfg(test)]
pub(crate) fn serve_fixed_for_test(ep: Endpoint, token: &str) -> u16 {
    let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = l.local_addr().unwrap().port();
    let token = token.to_string();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let (ep, token) = (Endpoint { base: ep.base.clone(), key: ep.key.clone(), model: ep.model.clone() }, token.clone());
            std::thread::spawn(move || {
                let resolve = move || Ok(Endpoint { base: ep.base.clone(), key: ep.key.clone(), model: ep.model.clone() });
                let _ = handle_conn(s, &token, &resolve, &|| {});
            });
        }
    });
    port
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    #[test]
    fn head_parsing_lowercases_header_names() {
        let lines = vec![
            "POST /v1/chat/completions HTTP/1.1".to_string(),
            "Authorization: Bearer abc".to_string(),
            "Content-Length: 12".to_string(),
        ];
        let r = parse_head(&lines).unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/v1/chat/completions");
        assert_eq!(r.headers["authorization"], "Bearer abc");
        assert_eq!(r.headers["content-length"], "12");
        assert!(parse_head(&[]).is_none());
    }

    #[test]
    fn only_openai_paths_are_relayed() {
        assert!(allowed_path("/v1/chat/completions"));
        assert!(allowed_path("/v1/models"));
        assert!(!allowed_path("/health"));
        assert!(!allowed_path("/v1/../slots"));
        assert!(!allowed_path("/v1/http://evil"));
    }

    #[test]
    fn model_is_rewritten_only_in_json_bodies() {
        let out = rewrite_model(br#"{"model":"local","stream":true}"#, "qwen3:8b");
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["model"], "qwen3:8b");
        assert_eq!(v["stream"], true);
        assert_eq!(rewrite_model(b"not json", "x"), b"not json");
        assert_eq!(rewrite_model(br#"{"a":1}"#, "x"), br#"{"a":1}"#);
    }

    #[test]
    fn chunk_frame_is_hex_length_prefixed() {
        assert_eq!(chunk_frame(b"hello"), b"5\r\nhello\r\n");
        assert_eq!(chunk_frame(&[b'x'; 26]).split(|b| *b == b'\r').next().unwrap(), b"1a");
    }

    /// 가짜 상류(응답 한 번) — 받은 요청 원문을 돌려주고, SSE 두 줄을 chunked로 흘린다.
    fn fake_upstream() -> (u16, std::thread::JoinHandle<String>) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut reader = BufReader::new(s.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let mut body = vec![0u8; len];
            reader.read_exact(&mut body).unwrap();
            let sse = "data: {\"x\":1}\n\ndata: [DONE]\n\n";
            write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{sse}\r\n0\r\n\r\n",
                sse.len()
            )
            .unwrap();
            format!("{head}\n{}", String::from_utf8_lossy(&body))
        });
        (port, h)
    }

    /// 중계 한 번 — 클라이언트가 보낸 요청을 받아 `handle_conn`에 넘기고, 클라이언트가 받은 응답 원문을 돌려준다.
    fn relay_once(
        request: String,
        resolve: &dyn Fn() -> Result<Endpoint, IpcError>,
        touch: &dyn Fn(),
    ) -> String {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
            c.write_all(request.as_bytes()).unwrap();
            let mut out = String::new();
            c.read_to_string(&mut out).unwrap();
            out
        });
        let (s, _) = l.accept().unwrap();
        let _ = handle_conn(s, "tok", resolve, touch);
        client.join().unwrap()
    }

    fn post(token: &str, path: &str, body: &str) -> String {
        format!(
            "POST {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn relays_stream_with_upstream_key_and_real_model() {
        let (up_port, upstream) = fake_upstream();
        let touches = AtomicU32::new(0);
        let resolve = || {
            Ok(Endpoint {
                base: format!("http://127.0.0.1:{up_port}"),
                key: Some("upkey".into()),
                model: "real-model".into(),
            })
        };
        let touch = || {
            touches.fetch_add(1, Ordering::Relaxed);
        };
        let out = relay_once(post("tok", "/v1/chat/completions", r#"{"model":"local","stream":true}"#), &resolve, &touch);
        let seen = upstream.join().unwrap();

        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.contains("text/event-stream"), "{out}");
        assert!(out.contains("data: {\"x\":1}") && out.contains("data: [DONE]"), "{out}");
        assert!(out.ends_with("0\r\n\r\n"), "종결 조각이 없다: {out:?}");
        // 상류에는 에이전트 토큰이 아니라 상류 키가, 설정 id가 아니라 실제 모델 이름이 간다.
        assert!(seen.to_ascii_lowercase().contains("authorization: bearer upkey"), "{seen}");
        assert!(!seen.contains("Bearer tok"), "{seen}");
        assert!(seen.contains(r#""model":"real-model""#), "{seen}");
        assert!(touches.load(Ordering::Relaxed) >= 2, "요청 시작과 청크마다 활동을 기록해야 한다");
    }

    #[test]
    fn rejects_bad_token_without_touching_the_model_server() {
        let resolved = AtomicU32::new(0);
        let resolve = || {
            resolved.fetch_add(1, Ordering::Relaxed);
            Err(IpcError::new(ErrorCode::Io, "unreachable"))
        };
        let out = relay_once(post("wrong", "/v1/chat/completions", "{}"), &resolve, &|| {});
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        let out = relay_once(post("tok", "/slots", "{}"), &resolve, &|| {});
        assert!(out.starts_with("HTTP/1.1 404"), "{out}");
        assert_eq!(resolved.load(Ordering::Relaxed), 0, "인증·경로 검사 전에 서버를 깨우면 안 된다");
    }

    #[test]
    fn model_server_failure_reaches_the_agent_as_openai_error() {
        let resolve = || Err(IpcError::new(ErrorCode::NotFound, "model not installed"));
        let out = relay_once(post("tok", "/v1/chat/completions", "{}"), &resolve, &|| {});
        assert!(out.starts_with("HTTP/1.1 503"), "{out}");
        assert!(out.contains(r#""message":"#) && out.contains("model not installed"), "{out}");
    }
}

