use std::sync::RwLock;

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::error::{ErrorCode, IpcError};
use crate::git::types::Project;

pub const STORE_FILE: &str = "projects.json";
pub const STORE_KEY: &str = "projects";

pub struct AppState {
    pub projects: RwLock<Vec<Project>>,
}

pub fn load_projects(app: &AppHandle) -> Vec<Project> {
    let Ok(store) = app.store(STORE_FILE) else {
        return Vec::new();
    };
    let Some(value) = store.get(STORE_KEY) else {
        return Vec::new();
    };
    serde_json::from_value(value).unwrap_or_default()
}

pub fn save_projects(app: &AppHandle, projects: &[Project]) -> Result<(), IpcError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("스토어 열기 실패: {e}")))?;
    store.set(STORE_KEY, serde_json::json!(projects));
    store
        .save()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("프로젝트 목록 저장 실패: {e}")))?;
    Ok(())
}
