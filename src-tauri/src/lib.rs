mod commands;
mod db;
mod error;
mod fetch_scheduler;
mod git;
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
    let label = format!("float-{pane_id}");
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
            .inner_size(560.0, 640.0)
            .min_inner_size(420.0, 360.0)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        // 파일 로그(앱 로그 폴더) + stdout. log::error!·패닉·프론트 미처리 에러까지 한 파일에 모인다.
        // 무한 증가 방지: 10MB마다 회전하고 최신 8개 아카이브만 보존(= 활성 + 8 ≈ 최신 90MB).
        // 플러그인이 회전·시작 시점마다 오래된 것부터 지워 항상 "최신 내용"만 남긴다(KeepAll은 무한 누적).
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
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
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label();
                if label == "main" {
                    // 메인 창이 닫히면 열린 PTY 자식을 모두 정리한다 (좀비 셸 방지, 설계 §16.8).
                    let state = window.state::<AppState>();
                    commands::kill_all(state.inner());
                    commands::lsp_kill_all(state.inner()); // LSP 서버 좀비 방지(태스크 17)
                    commands::browser_kill_all(window.app_handle(), state.inner());
                    // 팝업만 남아 앱이 안 죽는 상태 방지 — gpv-popup-* 전 창 close.
                    commands::popup_kill_all(window.app_handle());
                } else if let Some(term_id) = label.strip_prefix("float-") {
                    // 플로팅 터미널 창이 닫히면 그 세션의 PTY만 종료한다(나머지는 메인이 유지).
                    let state = window.state::<AppState>();
                    commands::close_session(state.inner(), term_id);
                }
            }
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        let when = chrono::Local::now().to_rfc3339();
        log::error!("Tauri 런타임 실행 실패: {e:?}");
        append_crash_log(&format!(
            "\n===== RUNTIME FAILURE @ {when} =====\n{e:?}\n"
        ));
        eprintln!("error while running tauri application: {e:?}");
        std::process::exit(1);
    }
}
