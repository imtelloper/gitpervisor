//! 임베디드 브라우저 탭 — "main" 창에 붙는 자식 webview(외부 사이트 렌더용).
//!
//! 설계: DOCS/browser-feature-design.md
//! - 외부 사이트(github/google)는 네이티브 자식 webview가 그린다. localhost dev 프리뷰는
//!   프론트 `<iframe>`이 그리며 여기로 오지 않는다(하이브리드).
//! - terminal.rs와 같은 "백엔드가 자원의 단일 진실" 패턴: webview 수명은 Rust가 소유하고,
//!   프론트는 bounds/show-hide/navigate만 동기화한다. id는 프론트가 만들어 넘긴다.
//! - 탭마다 webview 1개(라벨 `gpv-browser-<id>`), lazy 생성, 활성 탭만 show. 무제한 탭.
//!
//! 보안(격리): 자식 webview는 `WebviewUrl::External`이라 Tauri IPC 브리지가 주입되지 않고,
//! 어떤 capability에도 매칭되지 않아 **권한 0**(원격 페이지의 invoke 표면 없음)이다. geometry/
//! visibility는 전부 이 모듈의 **커스텀 커맨드**로만 처리하므로 core:webview 권한도 불필요하다.
//! 쿠키/세션은 `data_directory`로 특권 main webview와 분리한다.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, WebviewUrl,
};

use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

const LABEL_PREFIX: &str = "gpv-browser-";

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
/// (브라우저 탭끼리는 로그인 세션을 공유한다.)
fn browser_data_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("browser-session")
}

/// 최상위 네비게이션 게이트: http(s)/about:blank만 허용, file:/tauri:/javascript:/data: 등 차단.
/// 임의 원격 페이지가 로컬 파일이나 특권 스킴으로 빠지는 것을 막는 1차 방어선.
fn navigation_gate(target: &Url) -> bool {
    matches!(target.scheme(), "http" | "https") || target.as_str() == "about:blank"
}

/// URL을 OS 기본 브라우저로 연다 — window.open/target=_blank/OAuth 팝업 위임용.
/// (tauri-plugin-opener는 이 repo의 Rust 의존성이 아니므로 open.rs처럼 raw Command 사용.)
#[cfg(windows)]
fn open_external(url: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}
#[cfg(target_os = "macos")]
fn open_external(url: &str) {
    let _ = std::process::Command::new("open").arg(url).spawn();
}
#[cfg(all(unix, not(target_os = "macos")))]
fn open_external(url: &str) {
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
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

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        // 특권 main과 쿠키/세션 분리 (적대적 외부 콘텐츠 격리).
        .data_directory(browser_data_dir(&app))
        .on_navigation(navigation_gate)
        // window.open/target=_blank/OAuth 팝업 → 새 webview를 만들지 않고 OS 브라우저로 위임.
        // (단일 webview 불변식 유지 + github "새 탭" 링크·외부 로그인 깨짐 방지.)
        .on_new_window(|url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                open_external(url.as_str());
            }
            NewWindowResponse::Deny
        })
        // 다운로드 정책: 인앱 다운로드는 항상 취소(특권 앱 옆 drive-by-write 방지).
        // http(s)는 OS 기본 브라우저로 위임해 사용자 동의·다운로드 폴더로 받게 한다.
        .on_download(|webview, event| {
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
        })
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
