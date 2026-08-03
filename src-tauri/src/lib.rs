mod claude_usage;
mod commands;
mod db;
mod error;
mod fetch_scheduler;
mod git;
mod health;
mod lsp;
mod monitor;
mod notifications;
mod proc_icons;
mod state;
mod tools;
mod watcher;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use state::AppState;

/// 패닉이 나도 어딘가에 흔적을 남긴다 — 메인 스레드/스폰 스레드 어디서 패닉해도 크래시 로그가
/// 남도록 전역 패닉 훅을 건다. 로그 플러그인이 떠 있으면 거기에도, 항상 크래시 파일(append)에도
/// 패닉 메시지+위치+백트레이스를 기록한 뒤 기본 훅(stderr)을 호출한다.
static CRASH_LOG: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        let bt = std::backtrace::Backtrace::force_capture();
        let when = chrono::Local::now().to_rfc3339();
        let body = format!("\n===== PANIC @ {when} =====\n{info}\n--- backtrace ---\n{bt}\n");
        log::error!("패닉: {info}");
        let path = CRASH_LOG
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("gitpervisor-crash.log"));
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(body.as_bytes());
        }
        default(info);
    }));
}

/// 프로세스 AUMID(AppUserModelID)를 명시 설정 — Windows 토스트 알림 아이콘 해석에 필요.
/// 설치본의 시작메뉴 바로가기가 같은 AUMID·아이콘을 가지면 토스트가 앱 아이콘으로 뜬다.
#[cfg(windows)]
fn set_app_user_model_id(id: &str) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let wide: Vec<u16> = std::ffi::OsStr::new(id)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // 실패해도 무해(알림이 일반 아이콘으로 뜰 뿐) — best-effort.
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(wide.as_ptr());
    }
}

/// 패닉 훅과 동일한 형식으로 크래시 로그(panic.log)에 한 줄 남긴다 — 런타임 실행 실패처럼
/// 패닉이 아닌 치명적 종료도 같은 파일에서 사후 디버깅되게 한다.
fn append_crash_log(body: &str) {
    use std::io::Write;
    let Some(path) = CRASH_LOG.get().cloned() else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(body.as_bytes());
    }
}

/// WebView2 스로틀링 억제 인자 (최소화/백그라운드에서도 watcher·타이머 정상 동작). 전 빌드 공통.
const BASE_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtocol,msSleepingTabs,IntensiveWakeUpThrottling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";

/// 모든 창이 동일한 WebView2 환경 인자를 써야 한다 — 같은 user-data 폴더를 공유하는 웹뷰는
/// 환경 인자가 일치하지 않으면 추가 웹뷰가 초기화에 실패해 빈 창이 된다. 메인·플로팅 공용.
fn browser_args() -> String {
    let mut s = String::from(BASE_BROWSER_ARGS);
    #[cfg(debug_assertions)]
    s.push_str(" --remote-debugging-port=29222");
    s
}

/// 터미널 패널을 별도 OS 창으로 띄운다(플로팅). JS의 new WebviewWindow는 기본 인자로 생성돼
/// 메인 창과 환경 인자가 어긋나 웹뷰가 로드되지 않으므로, 같은 인자로 Rust에서 생성한다.
/// paneId는 창 라벨(`float-<paneId>`)로 전달한다 — WebviewUrl::App은 쿼리스트링을 지원하지
/// 않아(쿼리를 넣으면 about:blank로 떨어진다) URL 대신 라벨에서 프론트가 paneId를 읽는다.
// async 커맨드 — 워커 스레드에서 실행돼 메인 이벤트 루프를 막지 않는다. 그래야 run_on_main_thread
// 가 보낸 창 생성 클로저를 루프가 정상 펌프하며 처리해 웹뷰가 끝까지 초기화된다(아니면 webview가
// about:blank로 멈춘다 — tao/wry 메인스레드 펌프 이슈, 메모리 노트).
#[tauri::command]
async fn open_float_window(
    app: tauri::AppHandle,
    pane_id: String,
    origin: String,
) -> Result<(), String> {
    let label = format!("{FLOAT_LABEL_PREFIX}{pane_id}");
    // 메인 창이 이미 떠 있는 origin을 그대로 로드한다 — dev(localhost devUrl)·prod(tauri://localhost)
    // 모두에서 같은 index를 띄운다. 런타임의 WebviewUrl::App은 dev에서 about:blank로 떨어진다.
    let url = tauri::Url::parse(&origin).map_err(|e| format!("잘못된 origin: {e}"))?;
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let r = WebviewWindowBuilder::new(&app2, &label, WebviewUrl::External(url))
            .title("터미널")
            .inner_size(900.0, 600.0)
            .min_inner_size(360.0, 240.0)
            .center()
            // OS 기본 타이틀바 제거 — 프론트의 커스텀 FloatTitleBar로 대체 (리사이즈 유지)
            .decorations(false)
            .background_color(tauri::window::Color(30, 31, 34, 255))
            .additional_browser_args(&browser_args())
            .build();
        if let Err(e) = r {
            log::error!("플로팅 창 생성 실패: {e}");
        }
    })
    .map_err(|e| format!("플로팅 창 예약 실패: {e}"))?;
    Ok(())
}

/// 리소스 모니터 팝업 창(태스크 05) — open_float_window와 같은 검증된 레시피를 그대로 미러:
/// async 커맨드 + run_on_main_thread + WebviewUrl::External(origin) + browser_args() 일치.
/// 라벨 "sysmon" 싱글턴 — 이미 떠 있으면 새로 만들지 않고 포커스만 준다. Destroyed 핸들러는
/// main/float-* 전용이라 이 창은 정리 코드가 필요 없다(그 외 라벨 no-op).
#[tauri::command]
async fn open_sysmon_window(app: tauri::AppHandle, origin: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("sysmon") {
        let _ = win.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse(&origin).map_err(|e| format!("잘못된 origin: {e}"))?;
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let r = WebviewWindowBuilder::new(&app2, "sysmon", WebviewUrl::External(url))
            .title("리소스 모니터")
            .inner_size(660.0, 640.0)
            .min_inner_size(480.0, 360.0)
            .center()
            // OS 기본 타이틀바 제거 — 프론트의 커스텀 FloatTitleBar로 대체 (리사이즈 유지)
            .decorations(false)
            .background_color(tauri::window::Color(30, 31, 34, 255))
            .additional_browser_args(&browser_args())
            .build();
        if let Err(e) = r {
            log::error!("리소스 모니터 창 생성 실패: {e}");
        }
    })
    .map_err(|e| format!("리소스 모니터 창 예약 실패: {e}"))?;
    Ok(())
}

/// 터미널 모아보기를 별도 OS 창으로 띄운다(보조 모니터용 터미널 벽). sysmon과 같은 패턴 —
/// 라벨 "aggregate" 싱글턴, 이미 떠 있으면 포커스만.
///
/// 라벨이 `float-`로 시작하지 **않는** 것이 중요하다: Destroyed 핸들러의 float 분기가 PTY를
/// 종료시키는데, 이 창은 메인이 만든 PTY에 붙기만 하므로 닫혀도 세션이 살아 있어야 한다
/// (닫으면 메인 창이 다시 이어받는다).
#[tauri::command]
async fn open_aggregate_window(app: tauri::AppHandle, origin: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("aggregate") {
        let _ = win.set_focus();
        return Ok(());
    }
    let url = tauri::Url::parse(&origin).map_err(|e| format!("잘못된 origin: {e}"))?;
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let r = WebviewWindowBuilder::new(&app2, "aggregate", WebviewUrl::External(url))
            .title("터미널 모아보기")
            .inner_size(1100.0, 720.0)
            .min_inner_size(520.0, 320.0)
            .center()
            // OS 기본 타이틀바 제거 — 프론트의 FloatTitleBar로 대체 (리사이즈 유지)
            .decorations(false)
            .background_color(tauri::window::Color(30, 31, 34, 255))
            .additional_browser_args(&browser_args())
            .build();
        if let Err(e) = r {
            log::error!("모아보기 창 생성 실패: {e}");
        }
    })
    .map_err(|e| format!("모아보기 창 예약 실패: {e}"))?;
    Ok(())
}

/// 플로팅 터미널 창 라벨 접두사 — 라벨이 곧 paneId 전달 통로다(open_float_window 주석 참고).
const FLOAT_LABEL_PREFIX: &str = "float-";

/// 메인 창과 수명을 같이 하는 보조 창 라벨.
/// 메인이 사라졌는데 이 창들만 남으면 앱이 종료되지 않고 창 하나짜리 잔여 상태가 된다
/// (macOS는 Dock에도 남는다). 팝업(`gpv-popup-*`)은 browser.rs의 popup_kill_all이 맡는다.
const AUX_WINDOW_LABELS: [&str; 2] = ["sysmon", "aggregate"];

/// 메인 창이 사라질 때 같이 닫아야 하는 창인가.
///
/// `aggregate`가 `float-`로 시작하지 **않는** 것이 중요하다 — Destroyed 훅의 float 분기가
/// PTY를 종료시키는데 모아보기 창은 메인이 만든 PTY에 붙기만 하기 때문이다
/// (open_aggregate_window 주석). 그 불변식을 아래 테스트가 지킨다.
fn is_secondary_window(label: &str) -> bool {
    label.starts_with(FLOAT_LABEL_PREFIX) || AUX_WINDOW_LABELS.contains(&label)
}

/// 종료 정리가 이미 돌았는가 — 종료 경로가 여러 개라 중복 실행을 막는다.
static SHUTDOWN_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 정리 권한을 딱 한 번만 준다. 두 경로가 동시에 들어와도 CAS에 성공한 쪽만 true를 받는다.
/// (테스트에서 임의의 플래그를 넘길 수 있게 인자로 받는다.)
fn claim_shutdown(done: &std::sync::atomic::AtomicBool) -> bool {
    use std::sync::atomic::Ordering;
    done.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// 정리 한 단계를 실행하고 패닉을 여기서 삼킨다.
///
/// 한 단계가 패닉하면(예: 다른 스레드가 패닉해 오염된 뮤텍스의 `lock().unwrap()`) 나머지
/// 단계가 통째로 건너뛰어져 PTY 셸·LSP 서버가 그대로 남는다. 종료 정리는 "가능한 만큼 최대한"이
/// 목적이므로 단계별로 격리한다. 패닉 내용 자체는 전역 패닉 훅이 crash 로그에 남긴다.
/// (릴리스 프로필도 panic=unwind라 catch_unwind가 실제로 동작한다 — Cargo.toml 주석 참고.)
fn shutdown_step(name: &str, f: impl FnOnce()) {
    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
        log::error!("[shutdown] '{name}' 단계 패닉 — 나머지 단계는 계속 진행한다");
    }
}

/// 로그용 카운트 — 락을 못 잡았으면 "?"(정리 자체는 그대로 진행한다).
fn fmt_count(v: Option<usize>) -> String {
    v.map_or_else(|| "?".to_string(), |n| n.to_string())
}

/// 앱 종료 시 자식 자원 정리의 **단일 진입점**.
///
/// 예전에는 메인 창 `WindowEvent::Destroyed` 훅 하나뿐이었는데, 실제 종료 경로는 최소 셋이다.
///
/// 1. 메인 창 닫기 → `Destroyed`
/// 2. 이벤트 루프 종료 → `RunEvent::Exit`
/// 3. 업데이터 재시작(`AppHandle::request_restart`) → Destroyed 없이 `RunEvent::Exit`만 지나간다
///    (tauri-2.11.2 app.rs: 재시작은 `cleanup_before_exit` → `process::restart`이고 창
///    Destroyed를 emit하지 않는다)
///
/// (2)·(3)이 비어 있으면 PTY 셸·LSP 서버가 그대로 남아 다음 실행의 자식과 겹친다 —
/// 2026-08-01 "프로세스 387개 + systemd-oomd SIGKILL" 사건의 누적 경로 중 하나다.
/// 어느 입구로 들어오든 같은 순서로 정리하도록 여기 한 곳에 모은다.
///
/// **한 번만** 돈다(`SHUTDOWN_DONE`). 여러 경로가 연달아 불러도 두 번째부터는 즉시 반환한다 —
/// `kill_all`은 자식 종료를 join으로 기다리므로(세션당 최대 300ms) 중복 실행은 종료를 그만큼 늦춘다.
pub(crate) fn shutdown_children(app: &tauri::AppHandle) {
    if !claim_shutdown(&SHUTDOWN_DONE) {
        return;
    }
    let t0 = std::time::Instant::now();
    let mut n_term = None;
    let mut n_lsp = None;
    let mut closed = 0usize;

    if let Some(state) = app.try_state::<AppState>() {
        let state = state.inner();
        // 규모는 정리 전에 읽어 둔다(로그 전용). try_lock — 여기서 기다리면 종료만 늦어진다.
        n_term = state.terminals.try_lock().ok().map(|g| g.len());
        n_lsp = state.lsp.try_lock().ok().map(|g| g.len());
        // 자식 **프로세스**부터 보낸다(좀비 셸/서버 방지, 설계 §16.8 + 태스크 17).
        shutdown_step("terminals", || commands::kill_all(state));
        shutdown_step("lsp", || commands::lsp_kill_all(state));
        shutdown_step("browser", || commands::browser_kill_all(app, state));
    } else {
        // setup 실패 등으로 manage 전에 끝난 경우 — 정리할 자식도 아직 없다.
        log::warn!("[shutdown] AppState 미등록 — 자식 프로세스 정리 생략");
    }

    // 그다음 창. 팝업은 전용 헬퍼가, float-*/보조 창은 라벨로 판별해 한 번에 닫는다.
    // 창 정리는 자식 프로세스 종료 뒤에 해야 한다 — float 창의 Destroyed 훅이 close_session을
    // 부르는데, kill_all이 이미 레지스트리를 비워서 중복 종료가 no-op이 되기 때문이다.
    shutdown_step("popups", || commands::popup_kill_all(app));
    shutdown_step("windows", || {
        for (label, win) in app.webview_windows() {
            if is_secondary_window(&label) && win.close().is_ok() {
                closed += 1;
            }
        }
    });

    // 정상 종료 표시는 **반드시 맨 마지막**. 위 단계 도중에 죽으면 다음 실행이 "비정상 종료"로
    // 판정해야 한다 — mark_clean이 먼저 찍히면 사후 진단이 통째로 거짓말이 된다.
    shutdown_step("session", health::end_session);

    log::info!(
        "[shutdown] 자식 정리 완료 {}ms — 터미널 {} · LSP {} · 창 {}개 닫음",
        t0.elapsed().as_millis(),
        fmt_count(n_term),
        fmt_count(n_lsp),
        closed,
    );
}

/// 업데이터가 재실행하기 직전에 프론트가 await 하는 정리 커맨드(src/stores/updater.ts).
///
/// `relaunch()`는 `request_restart()` → 이벤트 루프 종료 → `RunEvent::Exit` → `exec` 순서라
/// 정리 자체는 아래 RunEvent 경로도 잡는다. 다만 그 시점엔 루프가 이미 내려가는 중이라 창
/// close 메시지가 펌프되지 않는다. 프론트가 미리 await 하면 정리가 **끝난 것을 확인한 뒤**
/// 새 프로세스가 뜬다(구·신 프로세스의 PTY·LSP가 겹치는 창이 사라진다).
///
/// `async` 필수 — kill_all이 자식 종료를 join으로 기다리므로 동기 커맨드로 두면 그 수백 ms
/// 동안 GTK 메인 루프가 멈춘다(terminal.rs spawn_terminate와 같은 이유).
#[tauri::command(async)]
fn prepare_relaunch(app: tauri::AppHandle) {
    shutdown_children(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 클립보드 보정 (macOS): Finder/Launchpad로 띄운 .app 은 셸의 로케일(LANG/LC_*)을 물려받지
    // 못한다(터미널에서 직접 띄울 때만 상속). 그러면 CoreFoundation 의 +[NSString
    // defaultCStringEncoding] 이 UTF-8 이 아니라 MacRoman 으로 폴백하고, WKWebView 의 네이티브
    // Cmd+C(copy:)가 선택 텍스트를 그 인코딩으로 pasteboard 에 써 한글이 UTF-8→MacRoman 이중
    // 인코딩으로 깨진다("이제" → "Ïù¥Ï†ú"). CF/AppKit 이 인코딩을 캐시하기 전에 UTF-8 로케일을
    // 심어 항상 정상 동작하게 한다(§1 TERM·§3 IME 와 같은 "메뉴/Finder 실행 = 환경변수 없음" 부류).
    // 실측: 같은 바이너리를 LANG 없이 vs LANG=UTF-8 로 띄워 pbpaste|xxd 로 확인 — DOCS/TROUBLESHOOTING.md §7.
    #[cfg(target_os = "macos")]
    {
        let empty = |k: &str| std::env::var_os(k).map_or(true, |v| v.is_empty());
        if empty("LANG") && empty("LC_ALL") && empty("LC_CTYPE") {
            std::env::set_var("LC_CTYPE", "UTF-8");
        }
    }

    // IME 보정 (Linux/X11): GNOME 메뉴·세션에서 앱을 띄우면 GTK_IM_MODULE 가 비어 있어
    // WebKitGTK 의 한글(IME) 조합이 깨진다(같은 바이너리도 터미널에서 직접 띄우면 정상).
    // GTK init 전에(=Tauri 빌드 전에) 시스템 기본 입력기 ibus 를 명시해 항상 동일 동작하게 한다.
    #[cfg(target_os = "linux")]
    {
        let empty = |k: &str| std::env::var_os(k).map_or(true, |v| v.is_empty());
        if empty("GTK_IM_MODULE") {
            std::env::set_var("GTK_IM_MODULE", "ibus");
        }
        if empty("XMODIFIERS") {
            std::env::set_var("XMODIFIERS", "@im=ibus");
        }
        if empty("QT_IM_MODULE") {
            std::env::set_var("QT_IM_MODULE", "ibus");
        }
        // WebKitGTK 가 NVIDIA 등 일부 GPU/드라이버에서 DMABUF 렌더러로 웹뷰 렌더러 프로세스를
        // 크래시(화면이 통째로 까맣게 먹통)시키는 사례가 잦다. DMABUF 렌더러를 끄면 안정화된다
        // (약간의 가속 손실 — 터미널 WebGL 렌더러는 어차피 Linux에서 끈다). GTK init 전에 설정.
        if empty("WEBKIT_DISABLE_DMABUF_RENDERER") {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    install_panic_hook();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 파일 로그(앱 로그 폴더) + stdout. log::error!·패닉·프론트 미처리 에러까지 한 파일에 모인다.
        // 무한 증가 방지: 10MB마다 회전하고 최신 8개 아카이브만 보존(= 활성 + 8 ≈ 최신 90MB).
        // 플러그인이 회전·시작 시점마다 오래된 것부터 지워 항상 "최신 내용"만 남긴다(KeepAll은 무한 누적).
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                // 의존 크레이트의 연결/핸드셰이크 INFO 노이즈를 잘라낸다. 이게 없으면 알림 1건마다
                // 6줄씩 쌓이는 zbus SASL 핸드셰이크가 로그를 채워 정작 앱 신호가 묻힌다
                // — 2026-08 OOM 사건 당시 5주치 로그 160줄 중 84줄(52%)이 zbus였고
                // 앱 자신의 기록은 "시작 v0.x" 9줄이 전부라 사후 진단이 불가능했다.
                .level_for("zbus", log::LevelFilter::Warn)
                .level_for("tracing", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .level_for("notify", log::LevelFilter::Warn)
                .level_for("notify_debouncer_full", log::LevelFilter::Warn)
                .max_file_size(10_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(8))
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 크래시 로그 경로 확정(패닉 훅이 여기에 남긴다) + 시작 로그.
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = CRASH_LOG.set(dir.join("panic.log"));
                // 무한 증가 차단 — 패닉 로그 1세대 보존 + 로그 폴더 총량 상한(best-effort).
                commands::prune_logs(&dir);
            }
            // Windows 토스트 알림이 앱 아이콘으로 뜨도록 프로세스 AUMID를 식별자에 맞춘다.
            // 설치본은 NSIS가 같은 AUMID·아이콘의 시작메뉴 바로가기를 등록 → 토스트가 그 아이콘을
            // 사용한다. dev는 바로가기가 없어 일반 아이콘이 정상 — 실제 아이콘은 설치본에서 확인.
            #[cfg(windows)]
            set_app_user_model_id("com.greathoon.gitpervisor");
            log::info!("Gitpervisor 시작 v{}", env!("CARGO_PKG_VERSION"));
            // "갑자기 꺼짐" 조기경보 — 이전 세션이 비정상 종료였는지 먼저 판정하고(하트비트
            // 센티널), 이번 세션의 감시를 시작한다. systemd-oomd는 SIGKILL이라 종료 훅이
            // 돌지 않으므로 살아있는 동안 미리 적어 두는 것 말고는 진단할 방법이 없다.
            health::begin_session(app.handle(), env!("CARGO_PKG_VERSION"));
            health::spawn_watchdog(
                app.handle().clone(),
                env!("CARGO_PKG_VERSION").to_string(),
                chrono::Local::now().to_rfc3339(),
            );

            // 메인 창을 코드에서 생성한다 — 원격 디버깅 포트(CDP)는 debug 빌드에서만 열고
            // release 빌드에는 노출하지 않기 위함 (정적 config로는 빌드별 분기가 불가).
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Gitpervisor")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1100.0, 700.0)
                .center()
                // OS 기본 타이틀바 제거 — 프론트의 커스텀 TitleBar로 대체 (리사이즈는 유지)
                .decorations(false)
                // OS 레벨 드래그-드롭을 끈다 — Windows(WebView2)에서 이게 켜져 있으면 OS 핸들러가
                // 웹뷰 안의 HTML5 drag&drop 이벤트를 가로채, PROJECTS 사이드바 드래그 정렬이 안 먹는다.
                // 앱은 OS 파일 드롭을 쓰지 않으므로(전부 다이얼로그/클릭) 꺼도 잃는 기능이 없다.
                .disable_drag_drop_handler()
                .background_color(tauri::window::Color(30, 31, 34, 255))
                .additional_browser_args(&browser_args())
                // main webview의 window.open(localhost 프리뷰 iframe 포함) — wry 기본은 침묵
                // 차단이라 아무 반응이 없다 → 명시적 OS 위임으로 개선. 플로팅 승격은 금지:
                // 오프너 environment가 특권 프로필이라 팝업이 임의 사이트로 가면 특권 쿠키를
                // 공유하는 원격 창이 된다(06 설계 §3.2 — 별도 프로필 검토 후 후속).
                .on_new_window(|url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        commands::open_external(url.as_str());
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                // 창/작업표시줄 아이콘을 런타임에 새 로고로 명시 설정 — Windows 아이콘 캐시나
                // exe 리소스 임베드 상태와 무관하게 살아 있는 창에 즉시 반영(dev·설치본 공통).
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/128x128.png"
                ))?)?
                .build()?;

            let projects = state::load_projects(app.handle());
            let settings = state::load_settings(app.handle());
            let notes = state::load_notes(app.handle());
            // 저장된 git 경로를 부팅 시 적용 (이후 set_settings로 갱신)
            git::runner::set_git_override(settings.git_path.as_ref().map(PathBuf::from));
            app.manage(AppState::new(projects.clone(), settings, notes));
            // LSP 유휴 서버 리퍼 — 10분 방치된 언어 서버 종료(태스크 17 §3.4).
            commands::lsp_spawn_idle_reaper(app.handle().clone());
            // DB 탐색기 — 연결 메타 로드 + 활성 연결 상태 (M6 §17)
            let db_conns = db::load_connections(app.handle());
            app.manage(db::DbState::new(db_conns));
            // 파일 감시 등록을 백그라운드 스레드로 미룬다. 재귀 감시 + 캐시 인덱싱이 거대 레포는
            // 레포당 수 초씩 걸려, 메인 스레드(setup)에서 하면 이벤트 루프가 시작도 못 해 시작 시
            // 창이 수십 초 멈춘다("응답 없음"). 등록 전까지는 수동/포커스 새로고침이 상태를 채운다.
            let watch_handle = app.handle().clone();
            std::thread::spawn(move || {
                for project in &projects {
                    watcher::register(&watch_handle, project);
                }
            });
            // 원격 최신상태 배경 fetch 스케줄러 — 주기 실행에 invoke가 없다 (태스크 04 §3.1).
            fetch_scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_git,
            commands::list_projects,
            commands::add_project,
            commands::create_project_folder,
            commands::update_project_path,
            commands::remove_project,
            commands::reorder_projects,
            commands::get_statuses,
            commands::get_log,
            commands::get_branches,
            commands::get_commit_detail,
            commands::get_file_diff,
            commands::get_file_diffs,
            commands::read_file_base64,
            commands::stage_files,
            commands::unstage_files,
            commands::discard_files,
            commands::commit,
            commands::push,
            commands::pull,
            commands::fetch,
            fetch_scheduler::refresh_remotes,
            commands::get_settings,
            commands::set_settings,
            commands::open_in,
            commands::run_executable,
            commands::preview_local_url,
            commands::reveal_path,
            commands::list_dir,
            commands::list_project_roots,
            commands::list_repo_files,
            commands::write_file,
            commands::create_dir,
            commands::create_file,
            commands::delete_path,
            commands::write_file_bytes,
            commands::find_definition,
            commands::find_symbols,
            commands::find_references,
            commands::search_in_project,
            commands::format_source,
            commands::format_tool_status,
            commands::lint_file,
            commands::lsp_start,
            commands::lsp_send,
            commands::lsp_stop,
            commands::lsp_ensure,
            commands::get_notes,
            commands::add_memo,
            commands::update_memo,
            commands::delete_memo,
            open_float_window,
            open_sysmon_window,
            open_aggregate_window,
            prepare_relaunch,
            commands::term_open,
            commands::term_attach,
            commands::term_project,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
            commands::term_paste,
            commands::browser_open,
            commands::browser_navigate,
            commands::browser_set_bounds,
            commands::browser_set_visible,
            commands::browser_back,
            commands::browser_forward,
            commands::browser_reload,
            commands::browser_stop,
            commands::browser_focus,
            commands::browser_blur,
            commands::browser_close,
            commands::browser_scan_dev_ports,
            commands::browser_clear_data,
            commands::http_request,
            commands::http_cancel,
            commands::get_target_sizes,
            commands::get_project_sizes,
            commands::clean_target,
            commands::scan_quarantined_tools,
            commands::clear_quarantine,
            commands::open_logs_folder,
            commands::get_log_status,
            commands::read_crash_log,
            commands::clear_crash_log,
            monitor::sys_metrics,
            monitor::sys_process_snapshot,
            monitor::kill_processes,
            proc_icons::get_process_icons,
            claude_usage::claude_usage,
            claude_usage::last_agent_message,
            db::db_list_connections,
            db::db_save_connection,
            db::db_delete_connection,
            db::db_connect,
            db::db_disconnect,
            db::db_databases,
            db::db_tables,
            db::db_query,
            db::db_table_meta,
            db::db_explain,
            db::db_update_cell,
            db::db_delete_row,
            db::db_insert_row,
            db::db_procedures,
            db::db_proc_params,
            notifications::notify_set_secret,
            notifications::notify_has_secret,
            notifications::notify_external,
            notifications::notify_test,
            notifications::notify_os,
            health::health_snapshot,
            health::health_prev_session,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if label == "main" {
                    // 메인 창이 닫히면 자식 자원을 전부 정리한다(좀비 셸 방지, 설계 §16.8).
                    // 순서·재진입 방지는 shutdown_children 한 곳에 모여 있다.
                    shutdown_children(window.app_handle());
                } else if let Some(term_id) = label.strip_prefix(FLOAT_LABEL_PREFIX) {
                    // 플로팅 터미널 창이 닫히면 그 세션의 PTY만 종료한다(나머지는 메인이 유지).
                    let state = window.state::<AppState>();
                    commands::close_session(state.inner(), term_id);
                }
            }
        })
        // `.run(context)`는 `build(context)?.run(|_, _| {})`의 축약이라 RunEvent를 못 받는다.
        // build/run을 갈라 이벤트 루프 종료를 직접 잡는다 — 업데이터 재시작은 창 Destroyed 없이
        // 여기만 지나가므로(shutdown_children 주석 §3) 이 경로가 없으면 재시작 때 자식이 남는다.
        // build()가 돌려주는 Err는 예전 `.run()`이 돌려주던 Err와 동일하다(setup 실패는 build가
        // 아니라 RunEvent::Ready에서 패닉 → 전역 패닉 훅이 crash 로그에 남긴다). 따라서 아래
        // 실패 처리(append_crash_log + exit 1)는 이전과 정확히 같은 조건에서 돈다.
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_children(app);
            }
        }),
        Err(e) => {
            let when = chrono::Local::now().to_rfc3339();
            log::error!("Tauri 런타임 실행 실패: {e:?}");
            append_crash_log(&format!("\n===== RUNTIME FAILURE @ {when} =====\n{e:?}\n"));
            eprintln!("error while running tauri application: {e:?}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// 종료 정리는 경로가 여럿이라(창 Destroyed / RunEvent::Exit / 업데이터 커맨드)
    /// 반드시 한 번만 돌아야 한다 — kill_all이 join으로 기다리므로 중복은 종료 지연이 된다.
    #[test]
    fn shutdown_is_claimed_only_once() {
        let done = AtomicBool::new(false);
        assert!(claim_shutdown(&done), "첫 호출은 정리를 수행해야 한다");
        assert!(!claim_shutdown(&done), "두 번째 호출은 건너뛰어야 한다");
        assert!(!claim_shutdown(&done));
    }

    /// 두 종료 경로가 동시에 들어와도(예: Destroyed가 다른 스레드에서 처리되는 런타임)
    /// 정확히 하나만 통과해야 한다. `load`+`store`였다면 여기서 깨진다.
    #[test]
    fn concurrent_shutdown_claims_exactly_one_winner() {
        static DONE: AtomicBool = AtomicBool::new(false);
        let winners: usize = std::thread::scope(|s| {
            let hs: Vec<_> = (0..8)
                .map(|_| s.spawn(|| usize::from(claim_shutdown(&DONE))))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).sum()
        });
        assert_eq!(winners, 1, "정리는 정확히 한 경로만 수행해야 한다");
    }

    /// 메인이 사라지면 같이 닫아야 하는 창 / 아닌 창.
    /// 특히 `aggregate`가 float 접두사에 걸리면 Destroyed 훅의 float 분기가 살아있는 PTY를
    /// 죽인다(모아보기 창은 메인의 PTY에 붙기만 한다) — 라벨을 바꿀 때 여기서 걸린다.
    #[test]
    fn secondary_window_labels() {
        assert!(is_secondary_window("float-abc123"));
        assert!(is_secondary_window("sysmon"));
        assert!(is_secondary_window("aggregate"));
        assert!(!is_secondary_window("main"), "메인은 대상이 아니다");
        assert!(
            !is_secondary_window("gpv-popup-1"),
            "팝업은 popup_kill_all이 맡는다"
        );
        assert!(!"aggregate".starts_with(FLOAT_LABEL_PREFIX));
        assert!(!"sysmon".starts_with(FLOAT_LABEL_PREFIX));
    }

    /// 한 단계가 패닉해도 나머지 단계가 계속 돌아야 한다(정리는 "가능한 만큼 최대한").
    #[test]
    fn shutdown_step_swallows_panic() {
        let mut after = false;
        shutdown_step("panicking", || panic!("일부러"));
        shutdown_step("next", || after = true);
        assert!(after, "앞 단계 패닉이 뒤 단계를 막으면 안 된다");
    }

    #[test]
    fn fmt_count_marks_unknown() {
        assert_eq!(fmt_count(Some(3)), "3");
        assert_eq!(fmt_count(None), "?", "락 실패는 0이 아니라 미상으로 남긴다");
    }
}
