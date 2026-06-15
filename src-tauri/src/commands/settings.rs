use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::error::IpcError;
use crate::git::runner;
use crate::git::types::Settings;
use crate::state::{self, AppState};

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().unwrap().clone()
}

/// 설정 저장 + 즉시 반영. git 경로 오버라이드는 다음 git 호출부터 적용된다.
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), IpcError> {
    runner::set_git_override(settings.git_path.as_ref().map(PathBuf::from));
    *state.settings.write().unwrap() = settings.clone();
    state::save_settings(&app, &settings)
}
