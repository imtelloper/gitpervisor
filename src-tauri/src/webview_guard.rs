//! WebView2 프로세스 감시 + 메모리 압박 시 웹뷰가 쥔 메모리 회수.
//!
//! **왜 필요한가.** WebView2는 렌더러/GPU/브라우저가 전부 별도 프로세스다(실측 설치본:
//! gpu 590MB, renderer 273MB, browser 125MB — gitpervisor.exe 자신보다 훨씬 크다).
//! 그래서 두 가지 일이 벌어진다.
//!
//! 1. **그중 하나가 죽어도 `gitpervisor.exe`는 멀쩡히 살아 있다.** 화면만 빈 창이 된다.
//!    wry 0.55.1도 tauri 2.11.2도 `add_ProcessFailed`를 등록하지 않아서 예외도, 로그도,
//!    아무 흔적도 남지 않는다. 2026-09-02 NTS(물리 RAM 7.7GB) 사건에서 "앱이 사라졌다"의
//!    후보 중 하나가 정확히 이것이었는데, 다른 경로(할당 실패 abort·작업관리자 종료·전원)와
//!    구분할 근거가 로그에 한 줄도 없었다. 최소한 원인을 남긴다.
//! 2. **압박이 오면 제일 먼저 놓아야 할 메모리도 저쪽에 있다.** health가 경보를 올리면
//!    웹뷰에 메모리 목표 LOW를 지시하고(캐시 폐기·스왑아웃 유도), 순수 사치인 플로팅
//!    프리워밍 풀(숨김 창 = 렌더러 1벌)을 비운다.
//!
//! Windows 전용 본체다 — 다른 플랫폼에서는 install/set_memory_target_low가 빈 함수이고,
//! 풀 비우기(플랫폼 무관)만 동작한다.

use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::*;

/// 지금 웹뷰 메모리 목표가 LOW인지. 같은 상태를 두 번 적용하지 않으려는 기억 —
/// 레벨 전이는 Warn→Danger처럼 LOW 구간 **안에서도** 일어난다.
static LOW_TARGET: AtomicBool = AtomicBool::new(false);

/// health 감시가 **메모리 레벨** 전이를 알릴 때마다 호출된다(`health::watchdog_tick`).
///
/// Warn 이상에서 하는 일은 둘. (1) 포커스 창을 뺀 웹뷰에 메모리 목표 LOW를 지시해 캐시를
/// 놓게 하고, (2) 플로팅 프리워밍 풀을 비운다. 둘 다 "지금 안 써도 되는 메모리"만 겨냥한다 —
/// 사용자가 실제로 쓰고 있는 창은 건드리지 않는다. 전체 레벨(프로세스 수·앱 메모리 비율
/// 포함)이 아니라 메모리 레벨을 받는 이유는 태스크 69 §2에 있다 — 보이는 메인 창의 캐시를
/// 버리는 조치가 "Claude 세션이 많다"에 반응하면 안 된다.
pub fn on_health_level(app: &tauri::AppHandle, level: crate::health::Level) {
    use crate::health::Level;
    if level >= Level::Warn {
        if !LOW_TARGET.swap(true, Ordering::Relaxed) {
            set_memory_target_low(app, true);
        }
        // 풀은 전이마다 비운다 — Warn 진입 뒤에도 claim 보충(open_float_window)이 채울 수 있다.
        crate::float_pool_drain(app);
    } else if LOW_TARGET.swap(false, Ordering::Relaxed) {
        // Warn 아래로 내려오면 NORMAL로 되돌린다. **`Ok`만으로 조건을 걸면 안 된다** —
        // `Machine::settle`의 강등은 60초 안정 후 관측 목표 레벨로 곧장 내려가므로
        // Warn→Notice가 흔하고, 여유가 상시 빠듯한 머신(이 브랜치가 겨냥한 물리 RAM 7.7GB
        // NTS)에서는 Ok 60초 연속을 못 채워 LOW가 영구히 굳는다. Notice는 배너도 없어
        // 사용자에게 단서가 남지 않는다.
        //
        // Notice가 아무것도 하지 않는다는 성질(상태바 칩만 뜨는 단계 — 되돌리기 비용이
        // 이득보다 크다)은 그대로다: Ok→Notice에서는 LOW_TARGET이 이미 false라 swap이
        // false를 돌려주고 이 갈래를 타지 않는다. Warn→Notice에서만 복구가 돈다.
        set_memory_target_low(app, false);
    }
}

/// 창의 WebView2에 `ProcessFailed` 핸들러를 건다. 창 생성 직후 1회.
#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    use webview2_com::ProcessFailedEventHandler;

    let label = window.label().to_string();
    let label_for_handler = label.clone();
    let scheduled = window.with_webview(move |pw| {
        // SAFETY: with_webview 클로저는 메인(UI) 스레드에서 실행된다 — WebView2는 STA라
        // 인터페이스 호출이 허용되는 유일한 스레드다. controller()가 돌려주는 핸들은 창이
        // 살아 있는 동안 유효하고, add_ProcessFailed는 토큰만 남기고 즉시 반환한다.
        // 토큰은 보관하지 않는다 — 해제 시점(창 소멸)에 웹뷰와 함께 사라진다.
        unsafe {
            let webview = match pw.controller().CoreWebView2() {
                Ok(w) => w,
                Err(e) => {
                    log::warn!("[webview] CoreWebView2 획득 실패 label={label}: {e}");
                    return;
                }
            };
            let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                // 이 클로저는 COM 콜백(extern "system" = nounwind ABI) 안에서 돈다 —
                // 여기서 패닉이 새면 unwind 설정과 무관하게 프로세스가 즉시 abort한다
                // (Cargo.toml [profile.release] 주석의 그 경로). 전부 Result를 무시한다.
                if let Some(args) = args {
                    log_process_failed(&label_for_handler, &args);
                }
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = webview.add_ProcessFailed(&handler, &mut token) {
                log::warn!("[webview] ProcessFailed 등록 실패 label={label}: {e}");
            }
        }
    });
    if let Err(e) = scheduled {
        log::warn!("[webview] ProcessFailed 등록 예약 실패: {e}");
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {
    // WebKitGTK/WKWebView에는 대응 이벤트가 없다(웹 프로세스가 죽으면 창이 통째로 죽는다).
}

/// 실패 사건 한 건을 로그 한 줄로. 게터가 실패해도 얻은 것까지는 남긴다.
#[cfg(windows)]
fn log_process_failed(label: &str, args: &ICoreWebView2ProcessFailedEventArgs) {
    use webview2_com::take_pwstr;
    use windows_core::{Interface, PWSTR};

    // SAFETY: COM 콜백이 넘겨준 args는 이 호출 동안 유효하다. 전부 out 파라미터를 채우는
    // 게터라 실패하면 out을 건드리지 않고, 그러면 초기값(Default/null)이 그대로 남는다.
    // ProcessDescription이 준 PWSTR은 CoTaskMem 할당이라 take_pwstr이 읽고 해제한다.
    unsafe {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        let _ = args.ProcessFailedKind(&mut kind);
        // UNRESPONSIVE는 **죽은 게 아니라 잠깐 멈춘** 상태이고, 런타임은 렌더러가 응답을
        // 되찾을 때까지 이 이벤트를 주기적으로 반복 발화한다. 스왑 스래싱(=이 모듈이 겨냥한
        // 바로 그 국면)에서는 수십 초씩 이어지므로, error로 남기면 아무것도 죽지 않았는데
        // 크래시 신호가 로그에 쌓여 사후 분석이 통째로 오염된다. warn 1회로 줄인다.
        // 래치는 실제 종료 이벤트가 오면 풀린다 — 회복 후 재발한 hang은 다시 한 줄 남는다.
        // ponytail: 래치 1개. hang이 얼마나 이어졌는지까지 알고 싶으면 시간 기반 rate limit로.
        if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
            if !UNRESPONSIVE_LOGGED.swap(true, Ordering::Relaxed) {
                log::warn!("[webview] 렌더러 응답 없음 label={label} — 회복 대기");
            }
            return;
        }
        UNRESPONSIVE_LOGGED.store(false, Ordering::Relaxed);
        // Args2(런타임 1.0.1108.44+)가 있어야 이유·종료코드·프로세스 설명이 나온다.
        let (reason, exit, desc) = match args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
            Ok(a2) => {
                let mut r = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                let _ = a2.Reason(&mut r);
                let mut code = 0i32;
                let _ = a2.ExitCode(&mut code);
                let mut d = PWSTR::null();
                let desc = if a2.ProcessDescription(&mut d).is_ok() {
                    take_pwstr(d)
                } else {
                    String::new()
                };
                (reason_name(r), code, desc)
            }
            Err(_) => ("(구버전 런타임)", 0, String::new()), // i18n-ok: 로그 전용
        };
        // 브라우저 프로세스가 죽으면 그 환경의 **모든 웹뷰가 통째로 무효**가 된다 —
        // 리로드로 살아나지 않는다. 자동 복구는 이번 범위 밖이라 안내만 남긴다.
        let hint = if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
            " — 이 창의 웹뷰가 전부 무효가 됐습니다. 창을 다시 열어야 합니다." // i18n-ok: 로그 전용
        } else {
            ""
        };
        log::error!(
            "[webview] 프로세스 실패 label={label} kind={} reason={reason} exit={exit} desc={desc}{hint}", // i18n-ok: 로그
            kind_name(kind)
        );
    }
}

#[cfg(windows)]
fn kind_name(k: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match k {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "BROWSER_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "RENDER_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            "RENDER_PROCESS_UNRESPONSIVE"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            "FRAME_RENDER_PROCESS_EXITED"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "GPU_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "UTILITY_PROCESS_EXITED",
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => {
            "SANDBOX_HELPER_PROCESS_EXITED"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => {
            "PPAPI_BROKER_PROCESS_EXITED"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => {
            "PPAPI_PLUGIN_PROCESS_EXITED"
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED => "UNKNOWN_PROCESS_EXITED",
        other => {
            // 새 런타임이 추가한 kind — 숫자라도 남겨야 조사할 수 있다.
            log::debug!("[webview] 미확인 ProcessFailedKind={}", other.0);
            "(미확인)" // i18n-ok: 로그 전용
        }
    }
}

#[cfg(windows)]
fn reason_name(r: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match r {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "UNEXPECTED",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "UNRESPONSIVE",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "TERMINATED",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "CRASHED",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "LAUNCH_FAILED",
        // 이번 사건에서 찾던 바로 그 값 — 이게 찍히면 원인이 메모리라는 직접 증거다.
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "OUT_OF_MEMORY",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "PROFILE_DELETED",
        _ => "(미확인)", // i18n-ok: 로그 전용
    }
}

/// 구 런타임(ICoreWebView2_19 미지원) 경고를 한 번만 남기기 위한 표식.
#[cfg(windows)]
static CAST_WARNED: AtomicBool = AtomicBool::new(false);

/// 렌더러 "응답 없음"을 이미 한 줄 남겼는지 — 이 이벤트는 회복될 때까지 반복 발화된다.
#[cfg(windows)]
static UNRESPONSIVE_LOGGED: AtomicBool = AtomicBool::new(false);

/// 모든 웹뷰의 메모리 사용 목표를 LOW/NORMAL로 지시한다 — **LOW는 포커스 창을 뺀다.**
///
/// `MemoryUsageTargetLevel(LOW)`는 best-effort 힌트다 — 런타임이 캐시를 폐기하고 쓰지 않는
/// 페이지를 스왑아웃하도록 유도한다(ICoreWebView2_19, WebView2 런타임 1.0.1823.32+).
/// **NORMAL 복귀는 자동이 아니다** — 우리가 되돌리지 않으면 평시에도 계속 LOW로 남는다.
/// `TrySuspend`는 쓸 수 없다: 보이지 않는 웹뷰에만 적용되는데 메인 창은 항상 보인다.
///
/// 포커스 창을 빼는 이유: 이 API는 **비활성 앱**용이다(MS 문서 — 스왑아웃된 메모리는 스크립트가
/// 돌 때 다시 읽혀 성능이 떨어지니 활성화되면 NORMAL로 되돌리라고 한다). 예전엔 메모리 경보 때
/// 지금 타이핑 중인 창까지 LOW가 걸렸다 — 메모리가 모자란 바로 그 순간 입력 창의 렌더러가
/// 디스크에서 페이지를 다시 읽게 되는 구조였다. 포커스가 옮겨 가면 [`on_window_focus`]가 따라간다.
#[cfg(windows)]
pub fn set_memory_target_low(app: &tauri::AppHandle, low: bool) {
    use tauri::Manager;

    let mut asked = 0usize;
    let mut kept_focused = 0usize;
    for win in app.webview_windows().into_values() {
        // 포커스 여부를 못 읽으면 포커스로 친다 — 틀려도 메모리를 덜 아낄 뿐 입력은 안 막힌다.
        if low && win.is_focused().unwrap_or(true) {
            kept_focused += 1;
            continue;
        }
        if set_window_target(&win, low) {
            asked += 1;
        }
    }
    log::info!(
        "[webview] 메모리 목표 {} 요청 — 창 {asked}개{}", // i18n-ok: 로그
        if low { "LOW" } else { "NORMAL" },
        if kept_focused > 0 { format!(" (포커스 창 {kept_focused}개는 NORMAL 유지)") } else { String::new() } // i18n-ok: 로그
    );
}

/// 창 포커스가 바뀔 때 — 메모리 경보(LOW) 중이면 포커스를 얻은 창은 NORMAL로, 잃은 창은 LOW로.
/// 경보가 아니면 아무것도 하지 않는다(모든 창이 이미 NORMAL이다).
#[cfg(windows)]
pub fn on_window_focus(window: &tauri::Window, focused: bool) {
    use tauri::Manager;

    if !LOW_TARGET.load(Ordering::Relaxed) {
        return;
    }
    if let Some(win) = window.app_handle().get_webview_window(window.label()) {
        set_window_target(&win, !focused);
    }
}

#[cfg(not(windows))]
pub fn on_window_focus(_window: &tauri::Window, _focused: bool) {}

/// 창 하나에 LOW/NORMAL을 예약한다. 예약에 성공하면 true.
#[cfg(windows)]
fn set_window_target(win: &tauri::WebviewWindow, low: bool) -> bool {
    use windows_core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    // with_webview는 메인 스레드 큐에 넣는 "예약"이다 — health 감시 스레드에서 불러도 된다.
    win.with_webview(move |pw| {
        // SAFETY: 클로저는 메인(UI) 스레드에서 실행된다(WebView2 STA 규약). 구 런타임에는
        // ICoreWebView2_19가 없어 cast가 E_NOINTERFACE로 실패할 뿐 UB가 아니다.
        unsafe {
            let Ok(webview) = pw.controller().CoreWebView2() else {
                return;
            };
            match webview.cast::<ICoreWebView2_19>() {
                Ok(w19) => {
                    let _ = w19.SetMemoryUsageTargetLevel(level);
                }
                Err(_) => {
                    if !CAST_WARNED.swap(true, Ordering::Relaxed) {
                        log::debug!(
                            "[webview] ICoreWebView2_19 미지원 런타임 — 메모리 목표 조절 생략" // i18n-ok: 로그
                        );
                    }
                }
            }
        }
    })
    .is_ok()
}

#[cfg(not(windows))]
pub fn set_memory_target_low(_app: &tauri::AppHandle, _low: bool) {
    // WebKitGTK/WKWebView에는 대응 API가 없다.
}
