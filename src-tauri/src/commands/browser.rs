//! 임베디드 브라우저 탭 — "main" 창에 붙는 자식 webview(외부 사이트 렌더용).
//!
//! 설계: DOCS/browser-feature-design.md
//! - 외부 사이트(github/google)는 네이티브 자식 webview가 그린다. localhost dev 프리뷰는
//!   프론트 `<iframe>`이 그리며 여기로 오지 않는다(하이브리드).
//! - terminal.rs와 같은 "백엔드가 자원의 단일 진실" 패턴: webview 수명은 Rust가 소유하고,
//!   프론트는 bounds/show-hide/navigate만 동기화한다. id는 프론트가 만들어 넘긴다.
//! - 탭마다 webview 1개(라벨 `gpv-browser-<id>`), lazy 생성, 활성 탭만 show. 무제한 탭.
//! - window.open/target=_blank는 플로팅 팝업 창(`gpv-popup-<seq>`)으로 승격한다 — 오프너
//!   environment를 상속해 탭과 세션을 공유하고 opener/postMessage 관계를 유지한다(OAuth).
//!
//! 보안(격리): 자식 webview는 `WebviewUrl::External`이라 Tauri IPC 브리지가 주입되지 않고,
//! 어떤 capability에도 매칭되지 않아 **권한 0**(원격 페이지의 invoke 표면 없음)이다. geometry/
//! visibility는 전부 이 모듈의 **커스텀 커맨드**로만 처리하므로 core:webview 권한도 불필요하다.
//! 쿠키/세션은 `data_directory`로 특권 main webview와 분리한다(팝업도 같은 프로필).
//!
//! 창 여러 개: 모아보기 별도 창(`aggregate`)·분리한 브라우저 창도 같은 id의 webview를 보여 준다. webview는
//! 한 번에 한 창의 자식이라, "보여 달라"고 한 창들(`BrowserReg::wants`)에서 `pick_host`로 고른 창으로
//! **reparent**한다. 창을 옮길 때마다 `browser://host`를 내보내 빼앗긴 창이 "다른 곳에서 표시 중"을 띄운다.
//! reparent는 **메인 스레드에서만** 한다(`place`) — 대상 창이 닫히는 중이면 tauri-runtime-wry가 응답 채널을
//! 버린 채 `recv().unwrap()`으로 패닉하는데, 닫힘(CloseRequested)도 메인 스레드라 거기서만 순서가 보장된다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;

use serde::{Deserialize, Serialize};
use tauri::webview::{
    DownloadEvent, NewWindowFeatures, NewWindowResponse, PageLoadEvent, WebviewBuilder,
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_git_net;
use crate::state::AppState;

const LABEL_PREFIX: &str = "gpv-browser-";
/// 팝업 플로팅 창 라벨 — 어떤 capability에도 매칭되지 않아 child와 동일하게 권한 0.
const POPUP_LABEL_PREFIX: &str = "gpv-popup-";
/// 팝업 폭탄 방어 상한 — 초과분은 OS 위임으로도 넘기지 않는다(브라우저 스팸 방지).
const MAX_POPUPS: usize = 8;
/// 동시 다중 팝업의 라벨 충돌 방지용 시퀀스.
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 활성 탭 콘텐츠 영역의 위치·크기 (CSS=Logical 픽셀 계약 — DPR을 곱하지 않는다).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 브라우저 webview 레지스트리 — 마지막 적용 bounds를 기억해 동일값 set을 생략(jank/IPC 절감).
#[derive(Default)]
pub struct BrowserReg {
    pub last_bounds: HashMap<String, Bounds>,
    /// browserId → 그 webview를 지금 보이고 싶어 하는 창들(오래된 것부터).
    wants: HashMap<String, Vec<Want>>,
    /// CloseRequested를 지난 창 — reparent 대상에서 뺀다(위 모듈 주석의 패닉).
    closing: std::collections::HashSet<String>,
    /// 생성 중인 browserId — 두 창이 같은 탭을 동시에 처음 보여 주면(재시작 직후 메인 활성 탭 + 모아보기 셀)
    /// 둘 다 "없음"을 보고 add_child를 부른다. Tauri의 라벨 중복 검사는 생성과 원자적이지 않아 같은 라벨
    /// webview가 둘 생기고, 레지스트리에서 밀린 쪽은 닫을 수도 옮길 수도 없이 창에 남는다.
    creating: std::collections::HashSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Want {
    window: String,
    bounds: Option<Bounds>,
}

/// webview를 둘 창 — 보조 창(모아보기·분리 창)이 메인보다 먼저, 같은 급이면 가장 최근에 보여 달라고 한 창.
/// 메인이 이기면 모아보기 셀이 메인의 모달·탭 전환 때마다 비어 버린다(터미널도 별도 창이 가져가고 메인은
/// "다른 창에서 표시 중"으로 접는다).
fn pick_host<'a>(wants: &'a [Want], alive: impl Fn(&str) -> bool) -> Option<&'a Want> {
    let live = || wants.iter().rev().filter(|w| alive(&w.window));
    live().find(|w| w.window != "main").or_else(|| live().next())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEvent {
    browser_id: String,
    /// 지금 webview를 가진 창 라벨 — 빈 문자열이면 어느 창에도 없다(창이 닫히며 같이 사라짐).
    window: String,
}

fn emit_host(app: &AppHandle, browser_id: &str, window: &str) {
    let _ = app.emit(
        "browser://host",
        HostEvent { browser_id: browser_id.to_string(), window: window.to_string() },
    );
}

/// `wants`대로 webview를 옮기고 보이거나(원하는 창이 있으면) 숨긴다. 반환 = webview가 있는가.
/// **메인 스레드에서만 부른다**(모듈 주석) — sync 커맨드·`run_on_main_thread`·창 이벤트 훅.
fn place(app: &AppHandle, browser_id: &str) -> Result<bool, IpcError> {
    let Some(wv) = app.get_webview(&label_of(browser_id)) else { return Ok(false) };
    let Some(state) = app.try_state::<AppState>() else { return Ok(true) };
    let host = {
        let reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
        reg.wants
            .get(browser_id)
            .and_then(|ws| {
                pick_host(ws, |l| !reg.closing.contains(l) && app.get_window(l).is_some())
            })
            .cloned()
    };
    let Some(host) = host else {
        wv.hide().map_err(map_err)?;
        return Ok(true);
    };
    if wv.window().label() != host.window {
        let Some(win) = app.get_window(&host.window) else { return Ok(true) };
        wv.reparent(&win).map_err(map_err)?;
        emit_host(app, browser_id, &host.window);
    }
    if let Some(b) = host.bounds {
        let _ = apply_bounds(&wv, b);
        state
            .browser
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_bounds
            .insert(browser_id.to_string(), b);
    }
    wv.show().map_err(map_err)?;
    Ok(true)
}

/// 위치·크기를 **한 번에** 놓는다. set_position·set_size를 따로 보내면 런타임의 SetSize가 현재 위치를 wry
/// `bounds()`로 다시 읽어 함께 쓰는데, wry는 자식 webview 위치를 **reparent 전 원래 부모 기준**으로 계산한다
/// (자식 모드에선 부모를 갱신하지 않는다). 그래서 옮겨 간 창에서 두 창 원점 차이만큼 밀려 놓였다
/// (분리 창 실측: (0,105)에 놓아야 할 컨테이너가 (169,128) — 2026-10-27).
fn apply_bounds(wv: &Webview, b: Bounds) -> tauri::Result<()> {
    wv.set_bounds(tauri::Rect {
        position: LogicalPosition::new(b.x, b.y).into(),
        size: LogicalSize::new(b.width.max(1.0), b.height.max(1.0)).into(),
    })
}

/// 커맨드를 부른 React webview가 속한 창 라벨.
fn caller_window(caller: &Webview) -> String {
    caller.window().label().to_string()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavEvent {
    browser_id: String,
    url: String,
    loading: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TitleEvent {
    browser_id: String,
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadInfo {
    url: String,
    /// true = OS 기본 브라우저로 위임됨, false = 지원 안 되는 스킴이라 차단됨
    delegated: bool,
}

fn label_of(id: &str) -> String {
    format!("{LABEL_PREFIX}{id}")
}

fn id_of(label: &str) -> String {
    label.strip_prefix(LABEL_PREFIX).unwrap_or(label).to_string()
}

fn map_err(e: tauri::Error) -> IpcError {
    IpcError::new(ErrorCode::Io, text_git_net::browser_error(e))
}

fn parse_url(s: &str) -> Result<Url, IpcError> {
    Url::parse(s).map_err(|e| IpcError::new(ErrorCode::Io, text_git_net::invalid_url(e)))
}

/// 모든 브라우저 webview가 공유하는 분리된 데이터 폴더 — 특권 main webview의 쿠키/세션과 격리.
/// (브라우저 탭·팝업 창끼리는 로그인 세션을 공유한다.) temp 폴백 금지 — 조용히 임시 프로필로
/// 새어 세션이 증발하느니 browser_open이 에러를 반환하는 게 낫다(07 F1).
fn browser_data_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    // 샤드 테스트 앱은 자기 폴더 안에 둔다(디버그 전용 GPV_WEBVIEW_DIR). 인스턴스끼리 한 프로필을
    // 동시에 열면 CDP 포트 인자가 달라 WebView2 가 두 번째 환경을 거부한다(lib.rs webview_data_dir).
    if let Some(dir) = crate::webview_data_dir() {
        return Ok(dir.join("browser-session"));
    }
    let base = app.path().app_local_data_dir().map_err(|e| {
        IpcError::new(ErrorCode::Io, text_git_net::browser_app_data_dir_not_found(e))
    })?;
    Ok(base.join("browser-session"))
}

/// 지연 삭제 marker 경로 — 프로필 폴더의 형제 파일(폴더 안에 두면 삭제와 함께 사라진다).
fn clear_marker_path(dir: &Path) -> PathBuf {
    let mut s = dir.as_os_str().to_owned();
    s.push(".clear-pending");
    PathBuf::from(s)
}

/// browser_clear_data 시점에 프로필이 파일 락으로 안 지워졌으면 marker가 남아 있다 —
/// 다음 시작 시 첫 webview 생성 전(프로필 파일 락이 없는 유일한 시점)에 여기서 지운다.
static PENDING_CLEAR_CHECK: Once = Once::new();
fn process_pending_clear(app: &AppHandle) {
    PENDING_CLEAR_CHECK.call_once(|| {
        let Ok(dir) = browser_data_dir(app) else { return };
        let marker = clear_marker_path(&dir);
        if !marker.exists() {
            return;
        }
        if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
            let _ = std::fs::remove_file(&marker);
            log::info!("브라우저 프로필 지연 삭제 완료");
        } else {
            // 여전히 실패 — marker를 남겨 다음 시작에 재시도(best-effort).
            log::warn!("브라우저 프로필 지연 삭제 실패 — 다음 시작 시 재시도");
        }
    });
}

/// 최상위 네비게이션 게이트: http(s)/about:blank만 허용, file:/tauri:/javascript:/data: 등 차단.
/// 임의 원격 페이지가 로컬 파일이나 특권 스킴으로 빠지는 것을 막는 1차 방어선.
fn navigation_gate(target: &Url) -> bool {
    matches!(target.scheme(), "http" | "https") || target.as_str() == "about:blank"
}

/// URL을 OS 기본 브라우저로 연다 — 다운로드 위임·팝업 생성 실패 폴백·main 창 window.open용.
/// **보안**: `cmd /C start "" <url>` 는 URL 쿼리의 `& | ^ ( )` 를 cmd 메타문자로 해석해,
/// 인앱 브라우저에서 로드한 원격 페이지가 유발한 다운로드/window.open URL(예:
/// `https://evil/?x=1&calc.exe`)로 임의 명령이 실행된다(원격 트리거 RCE). ShellExecuteW "open"은
/// URL을 셸에 그대로(별도 파싱 없이) 넘기므로 이 인젝션이 불가능하다(open.rs run_file와 동일 방식).
#[cfg(windows)]
pub(crate) fn open_external(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let url = escape_for_shell_handler(url);
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}
/// **보안(인자 주입)**: ShellExecuteW는 셸 파싱은 없지만, 프로토콜 핸들러의 레지스트리 명령
/// (예: 전통 Outlook `OUTLOOK.EXE -c IPM.Note /m "%1"`)의 `%1`에 문자열을 **원문 그대로** 치환한다.
/// url crate는 mailto 같은 opaque path의 `"`·공백을 인코딩하지 않으므로, PDF 링크
/// `mailto:a@b" /a "C:/secret`가 핸들러 명령줄에 `/a C:/secret` 인자를 끼워 넣는다(CVE-2007-3845 류).
/// Chromium EscapeExternalHandlerValue와 같은 집합(제어문자·공백·`"<>\^`{|}`·비ASCII)을 %XX로 바꾼다.
/// 기존 `%XX`는 건드리지 않고(이중 인코딩 없음), 합법 URL은 핸들러가 디코드하므로 뜻이 같다.
#[cfg_attr(not(windows), allow(dead_code))]
fn escape_for_shell_handler(url: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(url.len());
    for b in url.bytes() {
        if b <= 0x20 || b >= 0x7F || matches!(b, b'"' | b'<' | b'>' | b'\\' | b'^' | b'`' | b'{' | b'|' | b'}') {
            let _ = write!(out, "%{b:02X}");
        } else {
            out.push(b as char);
        }
    }
    out
}
/// unix 계열은 open.rs의 공용 런처를 지난다 — URL은 argv 배열 원소로만 전달되고(셸 미개입),
/// 자식은 반드시 회수되며(좀비 방지), 리눅스에서는 systemd-run 위임으로 **기본 브라우저가 앱
/// cgroup 밖에서** 뜬다. 이 자리는 특히 중요하다: 여기서 뜨는 것은 사용자의 상시 브라우저이고,
/// 예전엔 그 프로세스 트리 전체가 앱 scope에 얹혀 앱의 메모리 압력으로 계산됐다.
#[cfg(target_os = "macos")]
pub(crate) fn open_external(url: &str) {
    let mut cmd = std::process::Command::new("open");
    cmd.arg(url);
    let _ = super::open::spawn_launcher(cmd, "외부 브라우저"); // i18n-ok: 로그 라벨
}
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_external(url: &str) {
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(url);
    let _ = super::open::spawn_launcher(cmd, "외부 브라우저"); // i18n-ok: 로그 라벨
}

/// 문서 창(PDF 링크)이 OS로 넘겨도 되는 스킴 — http/https/mailto만. file:/javascript:/tauri: 등은
/// 로컬 실행·특권 스킴이라 신뢰 경계(여기)에서 막는다. 프론트 1차 필터와 별개로 반드시 재검증.
pub(crate) fn external_url_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// PDF 뷰어 외부 링크 열기. 문서 창에는 on_new_window가 없어 window.open이 조용히 막히므로
/// 전용 커맨드로 연다. OS 런처가 실제로 떴는지는 보장하지 않는다(open_external과 동일).
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), IpcError> {
    let parsed =
        Url::parse(&url).map_err(|_| IpcError::new(ErrorCode::InvalidUrl, text_git_net::external_link_invalid()))?;
    if !external_url_allowed(&parsed) {
        return Err(IpcError::new(ErrorCode::InvalidUrl, text_git_net::external_link_not_allowed()));
    }
    open_external(parsed.as_str());
    Ok(())
}

/// 다운로드 정책 — child·popup 공용. 인앱 다운로드는 항상 취소(특권 앱 옆 drive-by-write 방지),
/// http(s)는 OS 기본 브라우저로 위임해 사용자 동의·다운로드 폴더로 받게 한다.
fn handle_download(webview: &Webview, event: DownloadEvent<'_>) -> bool {
    if let DownloadEvent::Requested { url, .. } = event {
        let delegated = matches!(url.scheme(), "http" | "https");
        if delegated {
            open_external(url.as_str());
        }
        let _ = webview.emit(
            "browser://download",
            DownloadInfo {
                url: url.to_string(),
                delegated,
            },
        );
    }
    false // 인앱 다운로드 취소
}

/// window.open/target=_blank/OAuth 팝업 공용 정책 — child·popup 빌더 양쪽 .on_new_window 본문(재귀).
/// http(s) 외 스킴·한도 초과는 Deny, 창 생성 성공 시에만 Create.
/// ⚠ build 실패 후 Create 반환 금지 — tauri-runtime-wry가 창의 첫 webview를 unwrap 체인으로
/// 꺼내다 앱이 패닉한다(06 설계 §2.5 R2). 실패는 open_external + Deny 폴백.
fn handle_new_window(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
    if !matches!(url.scheme(), "http" | "https") {
        return NewWindowResponse::Deny;
    }
    let alive = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with(POPUP_LABEL_PREFIX))
        .count();
    if alive >= MAX_POPUPS {
        log::warn!("팝업 한도({MAX_POPUPS}) 초과 — 요청 거부: {url}");
        return NewWindowResponse::Deny;
    }
    match build_popup_window(app, features) {
        Ok(window) => NewWindowResponse::Create { window },
        Err(e) => {
            log::warn!("팝업 창 생성 실패 — OS 브라우저로 위임: {e}");
            open_external(url.as_str());
            NewWindowResponse::Deny
        }
    }
}

/// 팝업 플로팅 창 생성. `window_features`가 오프너 environment(=browser-session 프로필)·크기·
/// 위치를 자동 배선하므로 data_directory/additional_browser_args를 다시 지정하지 않는다
/// (환경은 이미 오프너 것으로 고정 — 07 세션 공유 계약). 콘텐츠는 WebView2가 SetNewWindow로
/// 채우므로 about:blank로 시작하고, decorations는 기본(true) — 원격 페이지라 커스텀 크롬 불가.
/// wry가 NewWindowRequested를 메인 메시지 루프에 재디스패치한 뒤 이 핸들러를 부르므로
/// 동기 build()가 올바른 패턴이다(IPC 커맨드의 run_on_main_thread 우회와 다른 경로).
fn build_popup_window(
    app: &AppHandle,
    features: NewWindowFeatures,
) -> tauri::Result<WebviewWindow<Wry>> {
    let label = format!(
        "{POPUP_LABEL_PREFIX}{}",
        POPUP_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let has_size = features.size().is_some();
    let has_pos = features.position().is_some();
    let mut builder = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::External(Url::parse("about:blank").expect("정적 URL")), // i18n-ok: expect(내부용)
    )
    .window_features(features)
    .on_navigation(navigation_gate)
    // 팝업이 또 팝업을 열 수 있다 — 동일 정책 재귀 부착(한도 카운트가 폭주를 막는다).
    .on_new_window({
        let app = app.clone();
        move |url, features| handle_new_window(&app, url, features)
    })
    .on_download(|webview, event| handle_download(&webview, event))
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    });
    if !has_size {
        builder = builder.inner_size(900.0, 700.0);
        if !has_pos {
            builder = builder.center();
        }
    }
    builder.build()
}

/// main 창 Destroyed 시 모든 팝업 창 정리 — 팝업만 남아 앱이 안 죽는 상태 방지.
/// lib.rs Destroyed 훅에서 호출. 개별 팝업 닫힘은 정리할 자원이 없어 별도 훅 불필요.
pub fn popup_kill_all(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with(POPUP_LABEL_PREFIX) {
            let _ = win.close();
        }
    }
}

/// 부른 창의 자식 webview를 만든다(없을 때만 — 있으면 아무 것도 안 한다).
///
/// **async 필수**: `Window::add_child`는 클로저를 메인 스레드에 올린 뒤 빌드 완료를 채널로
/// 기다린다(blocking recv). 동기 커맨드는 메인 스레드에서 실행되므로, 메인이 recv로 막혀
/// 클로저를 못 돌리는 데드락이 된다. async 커맨드는 워커 스레드에서 돌아 메인이 자유로워진다.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    browser_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), IpcError> {
    let label = label_of(&browser_id);
    let target = parse_url(&url)?;

    // 이미 있으면 그대로 둔다 — 이 경로로 오는 것은 **다른 창이 만든** webview를 이 창이 처음 보여 줄 때다
    // (모아보기 별도 창·분리한 탭 창). 여기서 navigate하면 그때마다 페이지가 새로 고쳐지고, SPA가 pushState로
    // 옮겨 간 주소는 저장된 URL과 달라 엉뚱한 곳으로 돌아간다. 주소 변경은 browser_navigate가 맡는다.
    {
        let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
        if app.get_webview(&label).is_some() || !reg.creating.insert(browser_id.clone()) {
            return Ok(());
        }
    }
    let built = build_browser_webview(&app, &webview, &label, target, bounds);
    state.browser.lock().unwrap_or_else(|e| e.into_inner()).creating.remove(&browser_id);
    let win = built?;
    state
        .browser
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_bounds
        .insert(browser_id.clone(), bounds);
    emit_host(&app, &browser_id, win.label());
    // 새 webview는 보이는 채로 생긴다. 그 사이 도착한 표시/숨김 요청(wants)대로 맞춘다 — 숨김 요청뿐이었으면
    // (예: 생성 중 모달이 떴다) 모달 위에 페이지가 떠 있게 된다. reparent가 있을 수 있어 메인 스레드에서.
    let app2 = app.clone();
    // 실패는 이벤트 루프가 이미 끝난(앱 종료 중) 때뿐이다 — 배치할 창도 없다.
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = place(&app2, &browser_id) {
            log::warn!("[browser] 생성 직후 배치 실패 {browser_id}: {}", e.message);
        }
    });
    Ok(())
}

/// browser_open의 생성부 — 부른 창의 자식 webview를 만들고 그 창을 돌려준다.
fn build_browser_webview(
    app: &AppHandle,
    caller: &Webview,
    label: &str,
    target: Url,
    bounds: Bounds,
) -> Result<tauri::Window, IpcError> {
    let app = app.clone();
    // 부른 창의 자식으로 만든다 — 별도 창(모아보기·분리 창)의 셀이 메인 창 좌표에 그려지던 원인이 이것이었다.
    let win = caller.window();

    // 프로필 지연 삭제가 예약돼 있으면 첫 webview 생성 전에 처리(파일 락 없는 유일한 시점).
    process_pending_clear(&app);

    let builder = WebviewBuilder::new(label, WebviewUrl::External(target))
        // 특권 main과 쿠키/세션 분리 (적대적 외부 콘텐츠 격리).
        .data_directory(browser_data_dir(&app)?)
        .on_navigation(navigation_gate)
        // window.open/target=_blank/OAuth 팝업 → 플로팅 팝업 창으로 승격(06).
        // 스킴 밖·한도 초과·생성 실패는 handle_new_window가 Deny/OS 위임으로 처리한다.
        .on_new_window({
            let app = app.clone();
            move |url, features| handle_new_window(&app, url, features)
        })
        .on_download(|webview, event| handle_download(&webview, event))
        .on_page_load(|webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            let _ = webview.emit(
                "browser://nav",
                NavEvent {
                    browser_id: id_of(webview.label()),
                    url: payload.url().to_string(),
                    loading,
                },
            );
        })
        .on_document_title_changed(|webview, title| {
            let _ = webview.emit(
                "browser://title",
                TitleEvent {
                    browser_id: id_of(webview.label()),
                    title,
                },
            );
        });

    let pos = LogicalPosition::new(bounds.x, bounds.y);
    let size = LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0));
    // add_child는 내부적으로 메인 스레드에서 빌드한다(메인 펌프 게이트 준수).
    win.add_child(builder, pos, size).map_err(map_err)?;
    Ok(win)
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    browser_id: String,
    url: String,
) -> Result<(), IpcError> {
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        wv.navigate(parse_url(&url)?).map_err(map_err)?;
    }
    Ok(())
}

/// 위치+크기를 한 번에 적용. 직전과 동일하면 네이티브 호출 없이 즉시 Ok(반복 통지 흡수).
/// 다른 창이 그 webview를 가진 동안에는 기억만 한다 — 돌려받을 때(`place`) 이 값으로 놓인다.
#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    browser_id: String,
    bounds: Bounds,
) -> Result<(), IpcError> {
    let caller = caller_window(&webview);
    let wv = app.get_webview(&label_of(&browser_id));
    {
        let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = reg
            .wants
            .get_mut(&browser_id)
            .and_then(|ws| ws.iter_mut().find(|w| w.window == caller))
        {
            w.bounds = Some(bounds);
        }
        if wv.as_ref().is_some_and(|wv| wv.window().label() != caller) {
            return Ok(());
        }
        if reg.last_bounds.get(&browser_id) == Some(&bounds) {
            return Ok(());
        }
        reg.last_bounds.insert(browser_id.clone(), bounds);
    }
    if let Some(wv) = wv {
        apply_bounds(&wv, bounds).map_err(map_err)?;
    }
    Ok(())
}

/// 표시/숨김 — 멱등·즉시. 점유(occlusion) 제어의 핵심. 부른 창의 바람을 `wants`에 적고 `place`로 맞춘다
/// (다른 창도 보이고 싶어 하면 숨기라는 요청은 그 창으로 넘기는 것이 된다).
/// 반환 = 그 webview를 가질 창 라벨, 없으면 None(생성 전·그 webview를 가졌던 창이 닫혀 같이 사라짐 —
/// 바람만 남고 프론트가 다시 만든다, `lib/browser.ts` setVisible).
#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    browser_id: String,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<Option<String>, IpcError> {
    let caller = caller_window(&webview);
    let host = {
        let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
        let ws = reg.wants.entry(browser_id.clone()).or_default();
        ws.retain(|w| w.window != caller);
        if visible {
            ws.push(Want { window: caller, bounds });
        } else if ws.is_empty() {
            reg.wants.remove(&browser_id);
        }
        reg.wants
            .get(&browser_id)
            .and_then(|ws| {
                pick_host(ws, |l| !reg.closing.contains(l) && app.get_window(l).is_some())
            })
            .map(|w| w.window.clone())
    };
    let Some(wv) = app.get_webview(&label_of(&browser_id)) else { return Ok(None) };
    let current = wv.window().label().to_string();
    if host.as_deref().is_some_and(|h| h != current) {
        // 창을 옮기는 것은 이 커맨드가 끝난 뒤 이벤트 루프에서 한다 — sync 커맨드는 WebView2 IPC 콜백 안에서
        // 돈다. 콜백 안 SetParent가 문제였는지는 확정 못 했지만(2026-10-27 분리 창 메인 스레드 멈춤의 실제 원인은
        // 넘겨받은 webview를 StrictMode 언마운트가 닫아 버린 것 — stores/browser.ts adoptItem), 굳이 콜백 안에서
        // 다른 창의 자식을 옮길 이유가 없다. 반환값(가질 창)은 이미 정해졌다.
        let app2 = app.clone();
        let id = browser_id.clone();
        // 실패는 이벤트 루프가 이미 끝난(앱 종료 중) 때뿐이다.
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = place(&app2, &id) {
                log::warn!("[browser] 창 옮기기 실패 {id}: {}", e.message);
            }
        });
    } else {
        // 같은 창 안의 표시/숨김은 지금 바로 — 미루면 모달이 뜨는 순간 webview가 한 틱 위에 남는다.
        place(&app, &browser_id)?;
    }
    Ok(Some(host.unwrap_or(current)))
}

/// 창이 닫히기 직전(CloseRequested) — 그 창의 바람을 지우고, 그 창이 가진 브라우저 webview는 아직 원하는
/// 창(메인)으로 넘긴다(페이지 상태 유지). 원하는 창이 없으면 닫는다 — 창과 함께 사라질 webview를 메인에
/// 숨겨 두면 분리 창의 브라우저처럼 아무도 참조하지 않는 것이 남는다. 메인이 나중에 다시 보이려 하면
/// `browser_set_visible`이 "없음"을 돌려주고 프론트가 다시 만든다. lib.rs 창 이벤트 훅에서 부른다.
pub fn browser_window_closing(app: &AppHandle, window: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };
    {
        let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
        reg.closing.insert(window.to_string());
        for ws in reg.wants.values_mut() {
            ws.retain(|w| w.window != window);
        }
        reg.wants.retain(|_, ws| !ws.is_empty());
    }
    for (label, wv) in app.webviews() {
        if !label.starts_with(LABEL_PREFIX) || wv.window().label() != window {
            continue;
        }
        let id = id_of(&label);
        let wanted = state
            .browser
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .wants
            .contains_key(&id);
        if wanted {
            if let Err(e) = place(app, &id) {
                log::warn!("[browser] 닫히는 창 {window} 에서 {id} 넘기기 실패: {}", e.message);
            }
        } else {
            state.browser.lock().unwrap_or_else(|e| e.into_inner()).last_bounds.remove(&id);
            let _ = wv.close(); // 창과 함께 어차피 사라진다 — 실패해도 결과가 같다
            emit_host(app, &id, "");
        }
    }
}

/// 창이 사라졌다(Destroyed) — 닫힘 표식과 남은 바람을 지운다. `browser_window_closing`을 거치지 않은
/// 닫힘(`destroy()`)도 여기서 정리된다.
pub fn browser_window_destroyed(app: &AppHandle, window: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
    reg.closing.remove(window);
    for ws in reg.wants.values_mut() {
        ws.retain(|w| w.window != window);
    }
    reg.wants.retain(|_, ws| !ws.is_empty());
}

fn eval_js(app: &AppHandle, browser_id: &str, js: &str) -> Result<(), IpcError> {
    if let Some(wv) = app.get_webview(&label_of(browser_id)) {
        wv.eval(js).map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_back(app: AppHandle, browser_id: String) -> Result<(), IpcError> {
    eval_js(&app, &browser_id, "history.back()")
}

#[tauri::command]
pub fn browser_forward(app: AppHandle, browser_id: String) -> Result<(), IpcError> {
    eval_js(&app, &browser_id, "history.forward()")
}

#[tauri::command]
pub fn browser_reload(app: AppHandle, browser_id: String) -> Result<(), IpcError> {
    eval_js(&app, &browser_id, "location.reload()")
}

#[tauri::command]
pub fn browser_stop(app: AppHandle, browser_id: String) -> Result<(), IpcError> {
    eval_js(&app, &browser_id, "window.stop()")
}

/// 포커스를 자식 webview로 — 키보드 트랩 탈출(메인 복귀)은 프론트가 DOM 포커스로 처리.
/// 다른 창이 가진 webview면 하지 않는다(그 창이 앞으로 튀어나온다).
#[tauri::command]
pub fn browser_focus(app: AppHandle, webview: Webview, browser_id: String) -> Result<(), IpcError> {
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        if wv.window().label() == caller_window(&webview) {
            wv.set_focus().map_err(map_err)?;
        }
    }
    Ok(())
}

/// 포커스를 부른 창의 React webview로 환원 — 네이티브 webview에 갇힌 키보드 탈출용.
/// (webview 포커스 중엔 앱 단축키 Ctrl+`·Ctrl+Shift+D/E/W 가 죽으므로 명시 복귀 경로.)
#[tauri::command]
pub fn browser_blur(webview: Webview) -> Result<(), IpcError> {
    webview.set_focus().map_err(map_err)
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
) -> Result<(), IpcError> {
    {
        let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
        reg.last_bounds.remove(&browser_id);
        reg.wants.remove(&browser_id);
    }
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        // 파괴는 이 커맨드가 끝난 뒤 이벤트 루프에서 한다. sync 커맨드는 WebView2 IPC 콜백 안에서 도는데,
        // 다른 창으로 막 옮겨 붙은 webview를 콜백 안에서 닫은 직후 메인 스레드가 영영 멈춘 적이 있다
        // (2026-10-27 — StrictMode가 넘겨받은 webview를 닫던 흐름, 멈춘 Win32 지점은 미확정). 같은 id를 곧바로
        // 다시 열면 그 사이 "있음"으로 보일 수 있는데, 닫힌 뒤 표시 요청이 "없음"을 받아 프론트가 다시 만든다.
        let id = browser_id.clone();
        // 실패는 이벤트 루프가 이미 끝난(앱 종료 중) 때뿐이다.
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = wv.close() {
                log::warn!("[browser] webview 닫기 실패 {id}: {e}");
            }
        });
    }
    Ok(())
}

fn default_dev_ports() -> Vec<u16> {
    vec![3000, 3001, 3333, 3777, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 9000]
}

/// localhost dev 서버 빠른 접속용 — 흔한 포트가 리스닝 중인지 병렬 탐지(외부 의존 없음).
#[tauri::command]
pub async fn browser_scan_dev_ports(ports: Option<Vec<u16>>) -> Result<Vec<u16>, IpcError> {
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    let candidates = ports.unwrap_or_else(default_dev_ports);
    let checks = candidates.into_iter().map(|p| async move {
        let ok = timeout(Duration::from_millis(150), TcpStream::connect(("127.0.0.1", p)))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
        (p, ok)
    });
    let results = futures::future::join_all(checks).await;
    Ok(results.into_iter().filter(|(_, ok)| *ok).map(|(p, _)| p).collect())
}

/// 브라우저 프로필의 쿠키·스토리지 전부 삭제 — 북마크/방문기록(main webview의 store)은 별개
/// 데이터라 유지한다(일반 브라우저의 "쿠키 삭제 ≠ 방문기록 삭제" 관행). 살아있는 브라우저
/// webview(탭 child·팝업 창 — 같은 프로필)가 있으면 라이브 API로 지우고 전부 reload, 없으면
/// 폴더를 지운다. 폴더가 파일 락으로 안 지워지면 marker를 남겨 다음 시작 시 지연 삭제한다.
#[tauri::command]
pub async fn browser_clear_data(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    // 탭 child는 레지스트리(단일 진실)에서, 팝업 창은 라벨 스캔으로 수집.
    let ids: Vec<String> = state
        .browser
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_bounds
        .keys()
        .cloned()
        .collect();
    let mut webviews: Vec<Webview> = ids
        .iter()
        .filter_map(|id| app.get_webview(&label_of(id)))
        .collect();
    for (label, wv) in app.webviews() {
        if label.starts_with(POPUP_LABEL_PREFIX) {
            webviews.push(wv);
        }
    }

    if let Some(first) = webviews.first() {
        // Windows에선 프로필 전체 삭제(ICoreWebView2Profile2::ClearBrowsingDataAll).
        // 완료가 비동기라 직후 reload의 첫 요청은 옛 쿠키를 볼 수 있으나 곧 수렴한다.
        first.clear_all_browsing_data().map_err(map_err)?;
        for wv in &webviews {
            let _ = wv.reload();
        }
        return Ok(());
    }

    let dir = browser_data_dir(&app)?;
    let marker = clear_marker_path(&dir);
    if !dir.exists() {
        let _ = std::fs::remove_file(&marker);
        return Ok(());
    }
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => {
            let _ = std::fs::remove_file(&marker);
            Ok(())
        }
        Err(e) => {
            // WebView2 브라우저 프로세스가 프로필 파일을 아직 잡고 있는 경우 — 지금은 못
            // 지우니 marker를 남기고 성공 처리한다(다음 시작 시 확정 삭제).
            log::warn!("브라우저 프로필 즉시 삭제 실패({e}) — 다음 시작 시 지연 삭제 예약");
            std::fs::write(&marker, b"").map_err(|e2| {
                IpcError::new(ErrorCode::Io, text_git_net::browser_profile_clear_schedule_failed(e2))
            })?;
            Ok(())
        }
    }
}

/// 창이 닫힐 때 살아있는 모든 브라우저 webview를 정리(누수 방지). lib.rs Destroyed 훅에서 호출.
pub fn browser_kill_all(app: &AppHandle, state: &AppState) {
    let ids: Vec<String> = state
        .browser
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last_bounds
        .keys()
        .cloned()
        .collect();
    for id in ids {
        if let Some(wv) = app.get_webview(&label_of(&id)) {
            let _ = wv.close();
        }
    }
    let mut reg = state.browser.lock().unwrap_or_else(|e| e.into_inner());
    reg.last_bounds.clear();
    reg.wants.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_allowlist() {
        let ok = |s: &str| external_url_allowed(&Url::parse(s).unwrap());
        assert!(ok("http://example.com/"));
        assert!(ok("https://example.com/a?b=1&c=2"));
        assert!(ok("mailto:someone@example.com"));
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("file:///C:/Windows/System32/calc.exe"));
        assert!(!ok("ftp://example.com/f"));
        assert!(!ok("tauri://localhost/"));
        assert!(!ok("data:text/html,<script>1</script>"));
    }

    #[test]
    fn shell_handler_escape_blocks_argument_injection() {
        // 실제 호출 경로: Url::parse → 허용목록 통과 → as_str() 가 `"`·공백을 그대로 남긴다(전제 확인)
        let u = Url::parse("mailto:a@b.c\" /a \"C:/Users/x/secret.txt").unwrap();
        assert!(external_url_allowed(&u));
        assert!(u.as_str().contains('"') && u.as_str().contains(' '));
        let esc = escape_for_shell_handler(u.as_str());
        assert!(!esc.contains('"') && !esc.contains(' '), "{esc}");
        assert_eq!(escape_for_shell_handler("mailto:a@b.c\" /a \"C:/x"), "mailto:a@b.c%22%20/a%20%22C:/x");
        assert_eq!(escape_for_shell_handler("mailto:a\tb\u{7f}é"), "mailto:a%09b%7F%C3%A9");
        // 반증: 합법 URL 은 바이트 그대로 — 기존 %XX 이중 인코딩 없음
        for s in [
            "mailto:a@b.c?subject=hi",
            "https://example.com/a%20b?q=1&r=%222%22#frag",
            "http://example.com/",
        ] {
            assert_eq!(escape_for_shell_handler(s), s);
        }
    }

    #[test]
    fn browser_pick_host_prefers_secondary_window_then_latest() {
        let w = |window: &str| Want { window: window.into(), bounds: None };
        let all = |_: &str| true;
        let host = |ws: &[Want], alive: &dyn Fn(&str) -> bool| {
            pick_host(ws, alive).map(|w| w.window.clone())
        };
        assert_eq!(host(&[], &all), None);
        assert_eq!(host(&[w("main")], &all).as_deref(), Some("main"));
        // 메인이 나중에 보여 달라고 해도 보조 창이 계속 가진다(메인의 모달·탭 전환이 셀을 비우지 않게).
        assert_eq!(host(&[w("aggregate"), w("main")], &all).as_deref(), Some("aggregate"));
        // 보조 창끼리는 가장 최근 것.
        assert_eq!(host(&[w("aggregate"), w("doc-1")], &all).as_deref(), Some("doc-1"));
        // 닫히는(살아 있지 않은) 창은 건너뛴다 — 메인으로 돌아온다.
        let not_agg = |l: &str| l != "aggregate";
        assert_eq!(host(&[w("main"), w("aggregate")], &not_agg).as_deref(), Some("main"));
        assert_eq!(host(&[w("aggregate")], &not_agg), None);
    }
}
