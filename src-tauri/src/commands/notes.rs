use tauri::{AppHandle, State};

use crate::error::IpcError;
use crate::git::types::ProjectNote;
use crate::state::{self, AppState, Notes};

/// 전체 메모(projectId → 메모) — 시작 시 1회, 사이드바 인디케이터·에디터에 사용.
#[tauri::command]
pub fn get_notes(state: State<'_, AppState>) -> Notes {
    state.notes.read().unwrap().clone()
}

/// 메모 upsert. 빈(공백) 텍스트면 삭제하고 null 반환 → 인디케이터 해제.
#[tauri::command]
pub fn set_note(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    text: String,
) -> Result<Option<ProjectNote>, IpcError> {
    let result = {
        let mut notes = state.notes.write().unwrap();
        if text.trim().is_empty() {
            notes.remove(&project_id);
            None
        } else {
            let note = ProjectNote {
                text,
                updated_at: chrono::Utc::now().to_rfc3339(),
            };
            notes.insert(project_id, note.clone());
            Some(note)
        }
    };
    let snapshot = state.notes.read().unwrap().clone();
    state::save_notes(&app, &snapshot)?;
    Ok(result)
}
