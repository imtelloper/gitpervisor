//! API 클라이언트 HTTP 엔진 — 백엔드 reqwest로 임의 HTTP 요청을 직접 소켓에서 쏜다.
//!
//! 설계: DOCS/api-client-design.md §4 (특히 §4.9 Rust 모델), §10.3, §11.2.
//! - CORS-free: 프론트 fetch가 아니라 reqwest가 직접 소켓을 열어 Set-Cookie·Date 등 forbidden
//!   response header까지 원본 그대로 확보하고, scheme allowlist(http/https)로 file:// 등을 거부한다.
//! - browser.rs / terminal.rs 미러: "백엔드가 자원의 단일 진실", requestId는 프론트가 생성(응답
//!   유실돼도 아는 id로 http_cancel 가능 → 고아 in-flight 방지).
//! - 취소: futures::future::abortable + AppState.http.inflight(requestId → AbortHandle). RAII 가드로
//!   패닉 경로도 정리하되, std Mutex는 insert/remove 순간에만 짧게 잠그고 .await 경계를 넘지 않는다.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use futures::future::{AbortHandle, Abortable, Aborted};
use futures::StreamExt;
use reqwest::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{redirect, Method, Url};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_REDIRECTS: usize = 10;
const DEFAULT_MAX_BODY_BYTES: usize = 25 * 1024 * 1024; // 25MB (§4.7)
const MAX_UPLOAD_FILE_BYTES: u64 = 100 * 1024 * 1024; // 멀티파트/바이너리 파일 상한 (§4.A.2)

// ===== 요청 모델 (§4.9) =====

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub query: Vec<KvPair>,
    #[serde(default)]
    pub headers: Vec<HeaderKv>,
    #[serde(default)]
    pub body: BodyKind,
    pub timeout_ms: Option<u64>,
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    pub max_redirects: Option<usize>,
    #[serde(default = "default_true")]
    pub verify_tls: bool,
    pub max_body_bytes: Option<usize>,
    /// https→http 다운그레이드 리다이렉트 허용 (기본 false — §10.3 보안).
    #[serde(default)]
    pub allow_insecure_redirect: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KvPair {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderKv {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BodyKind {
    None,
    Json { text: String },
    Raw { text: String },
    FormUrlencoded { fields: Vec<KvPair> },
    FormData { parts: Vec<MultipartPart> },
    Binary {
        #[serde(default)]
        base64: Option<String>,
        #[serde(default)]
        file_path: Option<String>,
        content_type: Option<String>,
    },
}

impl Default for BodyKind {
    fn default() -> Self {
        BodyKind::None
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartPart {
    pub field: String,
    pub value: Option<String>,
    pub file_path: Option<String>,
    pub file_name: Option<String>,
    pub content_type: Option<String>,
}

fn default_true() -> bool {
    true
}

// ===== 응답 모델 (§4.9) =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub http_version: String,
    pub headers: Vec<HeaderKv>,
    pub cookies: Vec<SetCookie>,
    pub timing: HttpTiming,
    pub body: ResponseBody,
    pub redirects: Vec<RedirectHop>,
    pub remote_addr: Option<String>,
    /// 실제 사용된 verifyTls 값 echo (UI "검증 꺼짐" 경고용 — §4.A).
    pub verify_tls: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseBody {
    pub base64: String,
    pub content_type: Option<String>,
    pub size: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpTiming {
    pub dns_ms: f64,
    pub connect_ms: f64,
    pub tls_ms: f64,
    pub ttfb_ms: f64,
    pub download_ms: f64,
    pub total_ms: f64,
    pub timing_exact: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedirectHop {
    pub status: u16,
    pub url: String,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCookie {
    pub name: String,
    pub value: String,
    pub domain: Option<String>,
    pub path: Option<String>,
    pub expires: Option<String>,
    pub max_age: Option<i64>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<String>,
}

// ===== 취소 레지스트리 (AppState.http) =====
//
// ⚠️ 동시성 규칙: inflight는 std Mutex(기존 state.rs 패턴과 일치)다. http_request는 send를 길게
// .await 하므로 inflight.lock()은 insert/remove 순간에만 짧게 획득하고 .await 경계를 넘기지 않는다.
// std MutexGuard는 !Send라 .await를 가로지르면 컴파일 거부/데드락 위험.

/// inflight 맵은 Arc<Mutex>로 감싸 RAII 가드가 AppState 빌림과 무관하게 정리할 수 있게 한다
/// (state.rs OpGuard가 Arc<Mutex<HashSet>>를 clone해 drop 시 remove하는 패턴과 동형).
#[derive(Default, Clone)]
pub struct HttpReg {
    pub inflight: Arc<Mutex<HashMap<String, AbortHandle>>>,
}

/// RAII: drop 시점에 inflight에서 requestId를 제거 (성공/실패/취소/패닉 모두 정리 — OpGuard 철학).
struct InflightGuard {
    inflight: Arc<Mutex<HashMap<String, AbortHandle>>>,
    request_id: String,
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.inflight.lock() {
            map.remove(&self.request_id);
        }
    }
}

// ===== 커맨드 =====

#[tauri::command]
pub async fn http_request(
    state: State<'_, AppState>,
    request_id: String,
    req: HttpRequest,
) -> Result<HttpResponse, IpcError> {
    // 1) scheme allowlist (§10.5) — file:/tauri:/data: 등 거부.
    let parsed = Url::parse(req.url.trim())
        .map_err(|e| IpcError::new(ErrorCode::InvalidUrl, format!("잘못된 URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(IpcError::new(
            ErrorCode::InvalidUrl,
            format!("지원하지 않는 스킴입니다: {} (http/https만 허용)", parsed.scheme()),
        ));
    }

    let method = Method::from_bytes(req.method.trim().as_bytes())
        .map_err(|e| IpcError::new(ErrorCode::InvalidUrl, format!("잘못된 메서드: {e}")))?;

    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let max_body = req.max_body_bytes.unwrap_or(DEFAULT_MAX_BODY_BYTES);

    // 2) 클라이언트 빌드: TLS 토글 + 리다이렉트 정책(hop 수집 + 다운그레이드 거부).
    let redirects: Arc<Mutex<Vec<RedirectHop>>> = Arc::new(Mutex::new(Vec::new()));
    let client = build_client(&req, redirects.clone())?;

    // 3) 요청 조립.
    let mut builder = client.request(method, parsed.clone());
    if !req.query.is_empty() {
        let pairs: Vec<(&str, &str)> = req
            .query
            .iter()
            .map(|kv| (kv.key.as_str(), kv.value.as_str()))
            .collect();
        builder = builder.query(&pairs);
    }
    builder = apply_headers(builder, &req.headers);
    builder = apply_body(builder, req.body, &req.headers).await?;

    // 4) abortable로 감싸 inflight 등록 (RAII drop이 remove 책임). inflight Arc만 짧게 잡는다.
    let inflight = {
        let reg = state
            .http
            .lock()
            .map_err(|_| IpcError::new(ErrorCode::Network, "내부 레지스트리 잠금 실패"))?;
        Arc::clone(&reg.inflight)
    };
    let (abort_handle, abort_reg) = AbortHandle::new_pair();
    {
        let mut map = inflight
            .lock()
            .map_err(|_| IpcError::new(ErrorCode::Network, "내부 레지스트리 잠금 실패"))?;
        map.insert(request_id.clone(), abort_handle);
    }
    let _guard = InflightGuard {
        inflight: Arc::clone(&inflight),
        request_id: request_id.clone(),
    };

    let started = Instant::now();

    // 5) send (이중 타임아웃 가드: reqwest builder.timeout + tokio::time::timeout).
    let send_fut = async {
        let resp = tokio::time::timeout(timeout, builder.send())
            .await
            .map_err(|_| IpcError::new(ErrorCode::Timeout, "요청이 시간 초과되었습니다"))?
            .map_err(classify_err)?;
        Ok::<reqwest::Response, IpcError>(resp)
    };

    let resp = match Abortable::new(send_fut, abort_reg).await {
        Ok(inner) => inner?,
        Err(Aborted) => {
            return Err(IpcError::new(ErrorCode::Cancelled, "요청이 취소되었습니다"))
        }
    };

    let ttfb_ms = started.elapsed().as_secs_f64() * 1000.0;

    // 6) 메타 수집.
    let status = resp.status();
    let status_code = status.as_u16();
    let status_text = status
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let http_version = format!("{:?}", resp.version());
    let remote_addr = resp.remote_addr().map(|a| a.to_string());

    let mut headers: Vec<HeaderKv> = Vec::with_capacity(resp.headers().len());
    let mut cookies: Vec<SetCookie> = Vec::new();
    let mut content_type: Option<String> = None;
    for (name, value) in resp.headers().iter() {
        let nm = name.as_str().to_string();
        let val = String::from_utf8_lossy(value.as_bytes()).to_string();
        if name == CONTENT_TYPE && content_type.is_none() {
            content_type = Some(val.clone());
        }
        if name.as_str().eq_ignore_ascii_case("set-cookie") {
            if let Some(c) = parse_set_cookie(&val) {
                cookies.push(c);
            }
        }
        headers.push(HeaderKv { name: nm, value: val });
    }

    // 7) 본문 누적 (상한 초과 시 truncate). 압축은 reqwest가 자동 해제 → size는 디코드 기준(§4.B.3).
    let download_start = Instant::now();
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    let body_result = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(classify_err)?;
            if buf.len() + chunk.len() > max_body {
                let remaining = max_body.saturating_sub(buf.len());
                buf.extend_from_slice(&chunk[..remaining]);
                truncated = true;
                break;
            }
            buf.extend_from_slice(&chunk);
        }
        Ok::<(), IpcError>(())
    }
    .await;
    body_result?;

    let download_ms = download_start.elapsed().as_secs_f64() * 1000.0;
    let total_ms = started.elapsed().as_secs_f64() * 1000.0;
    let size = buf.len();
    let base64_body = B64.encode(&buf);

    // dns/connect/tls 사전 프로빙 근사 (best-effort, 실패 무시 — §4.B.1). timingExact=false.
    let (dns_ms, connect_ms, tls_ms) = probe_timing(&parsed).await;

    let hops = redirects.lock().map(|v| v.clone()).unwrap_or_default();

    Ok(HttpResponse {
        status: status_code,
        status_text,
        http_version,
        headers,
        cookies,
        timing: HttpTiming {
            dns_ms,
            connect_ms,
            tls_ms,
            ttfb_ms,
            download_ms,
            total_ms,
            timing_exact: false,
        },
        body: ResponseBody {
            base64: base64_body,
            content_type,
            size,
            truncated,
        },
        redirects: hops,
        remote_addr,
        verify_tls: req.verify_tls,
    })
}

#[tauri::command]
pub fn http_cancel(state: State<'_, AppState>, request_id: String) -> Result<(), IpcError> {
    // 멱등: 없으면 no-op(이미 끝난 요청).
    let inflight = {
        let reg = state
            .http
            .lock()
            .map_err(|_| IpcError::new(ErrorCode::Network, "내부 레지스트리 잠금 실패"))?;
        Arc::clone(&reg.inflight)
    };
    if let Ok(mut map) = inflight.lock() {
        if let Some(handle) = map.remove(&request_id) {
            handle.abort();
        }
    }
    Ok(())
}

// ===== 클라이언트 빌드 =====

fn build_client(
    req: &HttpRequest,
    redirects: Arc<Mutex<Vec<RedirectHop>>>,
) -> Result<reqwest::Client, IpcError> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)));

    if !req.verify_tls {
        builder = builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }

    // 리다이렉트 정책. reqwest 0.13은 cross-host 시 Authorization/Cookie/Proxy-Authorization/
    // WWW-Authenticate를 자동 strip(redirect::remove_sensitive_headers)하므로 헤더 strip은 보장된다.
    // 커스텀 정책은 (a) hop 수집, (b) https→http 다운그레이드 거부(기본), (c) max 제한을 더한다.
    if req.follow_redirects {
        let max = req.max_redirects.unwrap_or(DEFAULT_MAX_REDIRECTS);
        let allow_insecure = req.allow_insecure_redirect;
        let hops = redirects;
        let policy = redirect::Policy::custom(move |attempt| {
            // 직전(현재) URL → 다음 URL 로의 hop 기록.
            let next = attempt.url().clone();
            let prev_scheme = attempt
                .previous()
                .last()
                .map(|u| u.scheme().to_string())
                .unwrap_or_default();
            if let Ok(mut v) = hops.lock() {
                v.push(RedirectHop {
                    status: attempt.status().as_u16(),
                    url: attempt
                        .previous()
                        .last()
                        .map(|u| u.to_string())
                        .unwrap_or_default(),
                    location: Some(next.to_string()),
                });
            }
            if attempt.previous().len() > max {
                return attempt.error(TooManyRedirects);
            }
            // https→http 다운그레이드 거부 (§10.3).
            if !allow_insecure && prev_scheme == "https" && next.scheme() == "http" {
                return attempt.error(InsecureRedirect);
            }
            attempt.follow()
        });
        builder = builder.redirect(policy);
    } else {
        builder = builder.redirect(redirect::Policy::none());
    }

    builder
        .build()
        .map_err(|e| IpcError::new(ErrorCode::Network, format!("HTTP 클라이언트 생성 실패: {e}")))
}

#[derive(Debug)]
struct TooManyRedirects;
impl std::fmt::Display for TooManyRedirects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("too many redirects")
    }
}
impl std::error::Error for TooManyRedirects {}

#[derive(Debug)]
struct InsecureRedirect;
impl std::fmt::Display for InsecureRedirect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("insecure https→http redirect blocked")
    }
}
impl std::error::Error for InsecureRedirect {}

// ===== 요청 조립 헬퍼 =====

fn apply_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &[HeaderKv],
) -> reqwest::RequestBuilder {
    for h in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(h.name.as_bytes()),
            HeaderValue::from_str(&h.value),
        ) {
            builder = builder.header(name, value);
        }
    }
    builder
}

fn has_header(headers: &[HeaderKv], name: &str) -> bool {
    headers.iter().any(|h| h.name.eq_ignore_ascii_case(name))
}

async fn apply_body(
    builder: reqwest::RequestBuilder,
    body: BodyKind,
    headers: &[HeaderKv],
) -> Result<reqwest::RequestBuilder, IpcError> {
    let has_ct = has_header(headers, "content-type");
    match body {
        BodyKind::None => Ok(builder),
        BodyKind::Json { text } => {
            let mut b = builder.body(text);
            if !has_ct {
                b = b.header(CONTENT_TYPE, "application/json");
            }
            Ok(b)
        }
        BodyKind::Raw { text } => Ok(builder.body(text)),
        BodyKind::FormUrlencoded { fields } => {
            let pairs: Vec<(String, String)> = fields
                .into_iter()
                .map(|kv| (kv.key, kv.value))
                .collect();
            let encoded = serde_urlencoded::to_string(&pairs)
                .map_err(|e| IpcError::new(ErrorCode::Io, format!("폼 인코딩 실패: {e}")))?;
            let mut b = builder.body(encoded);
            if !has_ct {
                b = b.header(CONTENT_TYPE, "application/x-www-form-urlencoded");
            }
            Ok(b)
        }
        BodyKind::FormData { parts } => {
            // multipart는 reqwest가 boundary를 생성하므로 사용자 Content-Type을 무시한다(§4.A.1).
            let mut form = reqwest::multipart::Form::new();
            for p in parts {
                if let Some(path) = p.file_path.clone() {
                    let data = read_upload_file(&path).await?;
                    let file_name = p
                        .file_name
                        .clone()
                        .or_else(|| {
                            std::path::Path::new(&path)
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|s| s.to_string())
                        })
                        .unwrap_or_else(|| "file".to_string());
                    let mut part = reqwest::multipart::Part::bytes(data).file_name(file_name);
                    if let Some(ct) = p.content_type {
                        part = part
                            .mime_str(&ct)
                            .map_err(|e| IpcError::new(ErrorCode::Io, format!("MIME 파싱 실패: {e}")))?;
                    }
                    form = form.part(p.field, part);
                } else {
                    form = form.text(p.field, p.value.unwrap_or_default());
                }
            }
            Ok(builder.multipart(form))
        }
        BodyKind::Binary {
            base64,
            file_path,
            content_type,
        } => {
            let data: Vec<u8> = if let Some(path) = file_path {
                read_upload_file(&path).await?
            } else if let Some(b64) = base64 {
                B64.decode(b64.trim())
                    .map_err(|e| IpcError::new(ErrorCode::Io, format!("base64 디코드 실패: {e}")))?
            } else {
                Vec::new()
            };
            let mut b = builder.body(data);
            if !has_ct {
                b = b.header(
                    CONTENT_TYPE,
                    content_type.unwrap_or_else(|| "application/octet-stream".to_string()),
                );
            }
            Ok(b)
        }
    }
}

async fn read_upload_file(path: &str) -> Result<Vec<u8>, IpcError> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 열기 실패: {e}")))?;
    if meta.len() > MAX_UPLOAD_FILE_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            format!(
                "업로드 파일이 너무 큽니다 ({} bytes, 상한 {} bytes)",
                meta.len(),
                MAX_UPLOAD_FILE_BYTES
            ),
        ));
    }
    tokio::fs::read(path)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 읽기 실패: {e}")))
}

// ===== 타이밍 사전 프로빙 (근사) =====

/// dns/connect/tls 근사값 (best-effort, 실패는 0.0). 본 요청과 별개 소켓이라 참고용(§4.B.1).
async fn probe_timing(url: &Url) -> (f64, f64, f64) {
    use tokio::net::TcpStream;

    let host = match url.host_str() {
        Some(h) => h.to_string(),
        None => return (0.0, 0.0, 0.0),
    };
    let port = url.port_or_known_default().unwrap_or(80);

    // DNS
    let dns_start = Instant::now();
    let addrs = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(it) => it.collect::<Vec<_>>(),
        Err(_) => return (0.0, 0.0, 0.0),
    };
    let dns_ms = dns_start.elapsed().as_secs_f64() * 1000.0;
    let addr = match addrs.into_iter().next() {
        Some(a) => a,
        None => return (dns_ms, 0.0, 0.0),
    };

    // TCP connect
    let connect_start = Instant::now();
    let connect_res =
        tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(addr)).await;
    let connect_ms = connect_start.elapsed().as_secs_f64() * 1000.0;
    let stream = match connect_res {
        Ok(Ok(s)) => s,
        _ => return (dns_ms, connect_ms, 0.0),
    };
    drop(stream);

    // TLS 핸드셰이크는 본 요청과 별개 소켓이라 여기서는 측정하지 않는다(과한 커스텀 Connector 금지 — §13).
    // https면 connect 이후 TLS 비용이 별도로 있음을 UI가 timingExact=false로 안내한다.
    let _ = url.scheme();
    (dns_ms, connect_ms, 0.0)
}

// ===== Set-Cookie 파싱 =====

fn parse_set_cookie(raw: &str) -> Option<SetCookie> {
    let mut parts = raw.split(';');
    let first = parts.next()?.trim();
    let (name, value) = match first.split_once('=') {
        Some((n, v)) => (n.trim().to_string(), v.trim().to_string()),
        None => return None,
    };
    if name.is_empty() {
        return None;
    }
    let mut cookie = SetCookie {
        name,
        value,
        domain: None,
        path: None,
        expires: None,
        max_age: None,
        http_only: false,
        secure: false,
        same_site: None,
    };
    for attr in parts {
        let attr = attr.trim();
        let (k, v) = match attr.split_once('=') {
            Some((k, v)) => (k.trim(), Some(v.trim().to_string())),
            None => (attr, None),
        };
        match k.to_ascii_lowercase().as_str() {
            "domain" => cookie.domain = v,
            "path" => cookie.path = v,
            "expires" => cookie.expires = v,
            "max-age" => cookie.max_age = v.and_then(|s| s.parse::<i64>().ok()),
            "samesite" => cookie.same_site = v,
            "httponly" => cookie.http_only = true,
            "secure" => cookie.secure = true,
            _ => {}
        }
    }
    Some(cookie)
}

// ===== 에러 분류 (§4.8, classify_failure 동형) =====

/// reqwest 에러의 source 체인을 끝까지 이어붙인다. reqwest::Error의 Display(`{e:#}` 포함)는
/// 내부 hyper/rustls 원인을 안 드러낼 때가 많아(예: 자가서명 인증서 → "client error (Connect)"만
/// 표시), source()를 직접 순회해야 "invalid peer certificate: UnknownIssuer" 같은 진짜 원인을 얻는다.
fn full_chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    let mut depth = 0;
    while let Some(inner) = src {
        s.push_str(" | ");
        s.push_str(&inner.to_string());
        src = inner.source();
        depth += 1;
        if depth > 12 {
            break;
        }
    }
    s
}

fn classify_err(e: reqwest::Error) -> IpcError {
    let chain = full_chain(&e);
    let lower = chain.to_lowercase();

    // TLS/DNS/연결거부는 모두 connect 단계에서 나므로 e.is_connect()로는 못 가른다.
    // source 체인의 키워드로 분류한다(순서 주의: TLS·DNS·refused 먼저, 그 외 connect는 Network).
    let code = if e.is_timeout() {
        ErrorCode::Timeout
    } else if lower.contains("certificate")
        || lower.contains("tls")
        || lower.contains("handshake")
        || lower.contains("unknownissuer")
        || lower.contains("self-signed")
        || lower.contains("selfsigned")
        || lower.contains("self signed")
        || lower.contains("not trusted")
        || lower.contains("certificate verify failed")
        || lower.contains("certificateunknown")
        || lower.contains("badcertificate")
    {
        ErrorCode::TlsError
    } else if lower.contains("dns")
        || lower.contains("failed to lookup")
        || lower.contains("name resolution")
        || lower.contains("no such host")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        ErrorCode::DnsFailure
    } else if lower.contains("connection refused")
        || lower.contains("os error 10061")
        || lower.contains("(os error 111)")
        || lower.contains("actively refused")
    {
        ErrorCode::ConnectionRefused
    } else if e.is_connect() {
        ErrorCode::Network
    } else if e.is_body() || e.is_decode() {
        ErrorCode::Io
    } else {
        ErrorCode::Network
    };

    let message = match code {
        ErrorCode::Timeout => "요청이 시간 초과되었습니다".to_string(),
        ErrorCode::TlsError => "TLS 인증서 검증 실패 — 검증 토글 또는 인증서 확인".to_string(),
        ErrorCode::DnsFailure => "호스트를 찾을 수 없습니다".to_string(),
        ErrorCode::ConnectionRefused => {
            "연결이 거부되었습니다 — 서버/포트 확인".to_string()
        }
        ErrorCode::Io => "응답 본문 처리 실패".to_string(),
        _ => "네트워크 오류".to_string(),
    };

    IpcError {
        code,
        message,
        stderr: Some(chain),
    }
}
