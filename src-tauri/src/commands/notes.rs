use tauri::{AppHandle, State};

use crate::error::IpcError;
use crate::git::types::Memo;
use crate::state::{self, AppState, Notes};

/// 전체 메모(projectId → 메모 목록) — 시작 시 1회 로드해 캐시.
#[tauri::command(async)]
pub fn get_notes(state: State<'_, AppState>) -> Notes {
    state.notes.read().unwrap_or_else(|e| e.into_inner()).clone()
}

fn persist(app: &AppHandle, state: &AppState) -> Result<(), IpcError> {
    let snapshot = state.notes.read().unwrap_or_else(|e| e.into_inner()).clone();
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
        .unwrap_or_else(|e| e.into_inner())
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
        let mut notes = state.notes.write().unwrap_or_else(|e| e.into_inner());
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

/// 드래그로 정한 메모 순서를 영속화한다 — ordered_ids 순서대로 재배열.
/// 목록에 없는 id는 상대 순서를 유지한 채 뒤로 보낸다(reorder_projects의 tail 규칙과 동일).
#[tauri::command]
pub fn reorder_memos(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), IpcError> {
    {
        let mut notes = state.notes.write().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = notes.get_mut(&project_id) {
            let rank: std::collections::HashMap<&str, usize> = ordered_ids
                .iter()
                .enumerate()
                .map(|(i, id)| (id.as_str(), i))
                .collect();
            let tail = ordered_ids.len();
            // sort_by_key는 안정 정렬 — ordered_ids에 없는 메모끼리의 순서는 그대로 남는다.
            list.sort_by_key(|m| rank.get(m.id.as_str()).copied().unwrap_or(tail));
        }
    }
    persist(&app, &state)
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
        let mut notes = state.notes.write().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = notes.get_mut(&project_id) {
            list.retain(|m| m.id != memo_id);
            if list.is_empty() {
                notes.remove(&project_id);
            }
        }
    }
    persist(&app, &state)
}
