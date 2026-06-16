use tauri::{AppHandle, State};

use crate::error::IpcError;
use crate::git::types::Memo;
use crate::state::{self, AppState, Notes};

/// 전체 메모(projectId → 메모 목록) — 시작 시 1회 로드해 캐시.
#[tauri::command]
pub fn get_notes(state: State<'_, AppState>) -> Notes {
    state.notes.read().unwrap().clone()
}

fn persist(app: &AppHandle, state: &AppState) -> Result<(), IpcError> {
    let snapshot = state.notes.read().unwrap().clone();
    state::save_notes(app, &snapshot)
}

/// 새 메모 추가. memoId는 프론트가 생성해 전달(낙관적 갱신·응답 유실 대비).
#[tauri::command]
pub fn add_memo(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    memo_id: String,
) -> Result<Memo, IpcError> {
    let now = chrono::Utc::now().to_rfc3339();
    let memo = Memo {
        id: memo_id,
        text: String::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    state
        .notes
        .write()
        .unwrap()
        .entry(project_id)
        .or_default()
        .push(memo.clone());
    persist(&app, &state)?;
    Ok(memo)
}

/// 메모 본문 수정. 없으면 null.
#[tauri::command]
pub fn update_memo(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    memo_id: String,
    text: String,
) -> Result<Option<Memo>, IpcError> {
    let result = {
        let mut notes = state.notes.write().unwrap();
        notes.get_mut(&project_id).and_then(|list| {
            list.iter_mut().find(|m| m.id == memo_id).map(|m| {
                m.text = text;
                m.updated_at = chrono::Utc::now().to_rfc3339();
                m.clone()
            })
        })
    };
    persist(&app, &state)?;
    Ok(result)
}

/// 메모 삭제. 프로젝트의 메모가 모두 없어지면 키도 제거.
#[tauri::command]
pub fn delete_memo(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    memo_id: String,
) -> Result<(), IpcError> {
    {
        let mut notes = state.notes.write().unwrap();
        if let Some(list) = notes.get_mut(&project_id) {
            list.retain(|m| m.id != memo_id);
            if list.is_empty() {
                notes.remove(&project_id);
            }
        }
    }
    persist(&app, &state)
}
