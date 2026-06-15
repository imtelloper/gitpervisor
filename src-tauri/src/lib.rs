mod commands;
mod error;
mod git;
mod state;
mod watcher;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let projects = state::load_projects(app.handle());
            app.manage(AppState::new(projects.clone()));
            // 등록된 모든 레포에 파일 감시 시작 (F7: 외부 수정 자동 반영)
            for project in &projects {
                watcher::register(app.handle(), project);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_git,
            commands::list_projects,
            commands::add_project,
            commands::remove_project,
            commands::get_statuses,
            commands::get_file_diff,
            commands::get_file_diffs,
            commands::stage_files,
            commands::unstage_files,
            commands::discard_files,
            commands::commit,
            commands::push,
            commands::pull,
            commands::fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
