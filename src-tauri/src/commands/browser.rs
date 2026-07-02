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
    IpcError::new(ErrorCode::Io, format!("브라우저 오류: {e}"))
}

fn parse_url(s: &str) -> Result<Url, IpcError> {
    Url::parse(s).map_err(|e| IpcError::new(ErrorCode::Io, format!("잘못된 URL: {e}")))
}

/// 모든 브라우저 webview가 공유하는 분리된 데이터 폴더 — 특권 main webview의 쿠키/세션과 격리.
/// (브라우저 탭·팝업 창끼리는 로그인 세션을 공유한다.) temp 폴백 금지 — 조용히 임시 프로필로
/// 새어 세션이 증발하느니 browser_open이 에러를 반환하는 게 낫다(07 F1).
fn browser_data_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    let base = app.path().app_local_data_dir().map_err(|e| {
        IpcError::new(ErrorCode::Io, format!("앱 데이터 폴더를 찾을 수 없습니다: {e}"))
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
/// (tauri-plugin-opener는 이 repo의 Rust 의존성이 아니므로 open.rs처럼 raw Command 사용.)
#[cfg(windows)]
pub(crate) fn open_external(url: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}
#[cfg(target_os = "macos")]
pub(crate) fn open_external(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_external(url: &str) {
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
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
        WebviewUrl::External(Url::parse("about:blank").expect("정적 URL")),
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

/// 자식 webview를 만든다(없을 때만). 있으면 navigate로 멱등 처리.
///
/// **async 필수**: `Window::add_child`는 클로저를 메인 스레드에 올린 뒤 빌드 완료를 채널로
/// 기다린다(blocking recv). 동기 커맨드는 메인 스레드에서 실행되므로, 메인이 recv로 막혀
/// 클로저를 못 돌리는 데드락이 된다. async 커맨드는 워커 스레드에서 돌아 메인이 자유로워진다.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), IpcError> {
    let label = label_of(&browser_id);
    let target = parse_url(&url)?;

    // 이미 있으면 새 webview를 만들지 않고 이동만(멱등).
    if let Some(wv) = app.get_webview(&label) {
        wv.navigate(target).map_err(map_err)?;
        return Ok(());
    }

    let win = app
        .get_window("main")
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "메인 창을 찾을 수 없습니다"))?;

    // 프로필 지연 삭제가 예약돼 있으면 첫 webview 생성 전에 처리(파일 락 없는 유일한 시점).
    process_pending_clear(&app);

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
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
    state
        .browser
        .lock()
        .unwrap()
        .last_bounds
        .insert(browser_id, bounds);
    Ok(())
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
#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
    bounds: Bounds,
) -> Result<(), IpcError> {
    {
        let mut reg = state.browser.lock().unwrap();
        if reg.last_bounds.get(&browser_id) == Some(&bounds) {
            return Ok(());
        }
        reg.last_bounds.insert(browser_id.clone(), bounds);
    }
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        wv.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(map_err)?;
        wv.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)))
            .map_err(map_err)?;
    }
    Ok(())
}

/// 표시/숨김 — 멱등·즉시. 점유(occlusion) 제어의 핵심. webview가 아직 없으면 no-op.
#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    browser_id: String,
    visible: bool,
    bounds: Option<Bounds>,
) -> Result<(), IpcError> {
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        if visible {
            if let Some(b) = bounds {
                let _ = wv.set_position(LogicalPosition::new(b.x, b.y));
                let _ = wv.set_size(LogicalSize::new(b.width.max(1.0), b.height.max(1.0)));
            }
            wv.show().map_err(map_err)?;
        } else {
            wv.hide().map_err(map_err)?;
        }
    }
    Ok(())
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
#[tauri::command]
pub fn browser_focus(app: AppHandle, browser_id: String) -> Result<(), IpcError> {
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        wv.set_focus().map_err(map_err)?;
    }
    Ok(())
}

/// 포커스를 메인 webview(React)로 환원 — 네이티브 webview에 갇힌 키보드 탈출용.
/// (webview 포커스 중엔 앱 단축키 Ctrl+`·Ctrl+Shift+D/E/W 가 죽으므로 명시 복귀 경로.)
#[tauri::command]
pub fn browser_blur(app: AppHandle) -> Result<(), IpcError> {
    if let Some(wv) = app.get_webview("main") {
        wv.set_focus().map_err(map_err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_close(
    app: AppHandle,
    state: State<'_, AppState>,
    browser_id: String,
) -> Result<(), IpcError> {
    state.browser.lock().unwrap().last_bounds.remove(&browser_id);
    if let Some(wv) = app.get_webview(&label_of(&browser_id)) {
        wv.close().map_err(map_err)?;
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
        .unwrap()
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
                IpcError::new(ErrorCode::Io, format!("지연 삭제 예약 실패: {e2}"))
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
        .unwrap()
        .last_bounds
        .keys()
        .cloned()
        .collect();
    for id in ids {
        if let Some(wv) = app.get_webview(&label_of(&id)) {
            let _ = wv.close();
        }
    }
    state.browser.lock().unwrap().last_bounds.clear();
}
