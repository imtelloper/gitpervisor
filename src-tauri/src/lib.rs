mod commands;
mod error;
mod git;
mod state;
mod watcher;

use std::path::PathBuf;

use tauri::Manager;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let projects = state::load_projects(app.handle());
            let settings = state::load_settings(app.handle());
            // 저장된 git 경로를 부팅 시 적용 (이후 set_settings로 갱신)
            git::runner::set_git_override(settings.git_path.as_ref().map(PathBuf::from));
            app.manage(AppState::new(projects.clone(), settings));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
