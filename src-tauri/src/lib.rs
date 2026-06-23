mod commands;
mod db;
mod error;
mod git;
mod monitor;
mod state;
mod watcher;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use state::AppState;

/// WebView2 스로틀링 억제 인자 (최소화/백그라운드에서도 watcher·타이머 정상 동작). 전 빌드 공통.
const BASE_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtocol,msSleepingTabs,IntensiveWakeUpThrottling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";

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
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // 메인 창을 코드에서 생성한다 — 원격 디버깅 포트(CDP)는 debug 빌드에서만 열고
            // release 빌드에는 노출하지 않기 위함 (정적 config로는 빌드별 분기가 불가).
            let mut browser_args = String::from(BASE_BROWSER_ARGS);
            #[cfg(debug_assertions)]
            browser_args.push_str(" --remote-debugging-port=29222");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Gitpervisor")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1100.0, 700.0)
                .center()
                // OS 기본 타이틀바 제거 — 프론트의 커스텀 TitleBar로 대체 (리사이즈는 유지)
                .decorations(false)
                .background_color(tauri::window::Color(30, 31, 34, 255))
                .additional_browser_args(&browser_args)
                .build()?;

            let projects = state::load_projects(app.handle());
            let settings = state::load_settings(app.handle());
            let notes = state::load_notes(app.handle());
            // 저장된 git 경로를 부팅 시 적용 (이후 set_settings로 갱신)
            git::runner::set_git_override(settings.git_path.as_ref().map(PathBuf::from));
            app.manage(AppState::new(projects.clone(), settings, notes));
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_git,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::get_statuses,
            commands::get_log,
            commands::get_branches,
            commands::get_commit_detail,
            commands::get_file_diff,
            commands::get_file_diffs,
            commands::stage_files,
            commands::unstage_files,
            commands::discard_files,
            commands::commit,
            commands::push,
            commands::pull,
            commands::fetch,
            commands::get_settings,
            commands::set_settings,
            commands::open_in,
            commands::list_dir,
            commands::list_project_roots,
            commands::write_file,
            commands::find_definition,
            commands::get_notes,
            commands::add_memo,
            commands::update_memo,
            commands::delete_memo,
            commands::term_open,
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
            commands::http_request,
            commands::http_cancel,
            commands::get_target_sizes,
            commands::clean_target,
            monitor::sys_metrics,
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
        ])
        .on_window_event(|window, event| {
            // 창이 닫히면 열린 PTY 자식을 모두 정리한다 (좀비 셸 방지, 설계 §16.8).
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AppState>();
                commands::kill_all(state.inner());
                commands::browser_kill_all(window.app_handle(), state.inner());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
