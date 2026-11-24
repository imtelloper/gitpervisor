//! 할 일 — 메모와 분리된 전역 목록 하나(todos.json). 설계: DOCS/memo-todo-category-image-design.md §2.2·§5.
//!
//! "오늘 목록"은 여기서 만들지 않는다. 항목에는 만든 시각과 완료 시각만 있고, 무엇이 오늘 보일지는 프런트가
//! 계산한다(`src/lib/todo-day.ts`) — 그래서 자정에 도는 이월 작업도, 그걸 두 창이 동시에 실행하는 경쟁도 없다.

use tauri::{AppHandle, Emitter, State};

use crate::error::IpcError;
use crate::git::types::Todo;
use crate::state::{self, AppState};

/// 전체 할 일(배열 순서 = 표시 순서) — 프런트가 1회 로드해 캐시.
#[tauri::command(async)]
pub fn get_todos(state: State<'_, AppState>) -> Vec<Todo> {
    state.todos.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 저장하고 다른 창에 알린다(페이로드 = 바꾼 창의 라벨, 받은 쪽이 자기 것이면 무시). 이유는 notes.rs 의 persist 와 같다.
fn persist(app: &AppHandle, state: &AppState, origin: &tauri::Window) -> Result<(), IpcError> {
    let snapshot = state.todos.read().unwrap_or_else(|e| e.into_inner()).clone();
    state::save_todos(app, &snapshot)?;
    // 신호일 뿐 진실은 재조회다 — 실패해도 저장은 끝났다.
    let _ = app.emit("todos://changed", Some(origin.label()));
    Ok(())
}

/// 완료 표시를 켜고 끈다. 이미 완료인 항목을 다시 완료로 불러도 **처음 완료한 시각을 지킨다** —
/// 그 시각이 "어느 날의 기록인가"를 정하므로, 덮어쓰면 지난 날의 완료가 오늘로 옮겨 온다.
fn apply_todo_done(todo: &mut Todo, done: bool, now: &str) {
    match (done, todo.done_at.is_some()) {
        (true, false) => todo.done_at = Some(now.to_string()),
        (false, true) => todo.done_at = None,
        _ => {}
    }
}

/// 새 할 일을 맨 아래에 추가. todoId는 프론트가 생성해 전달(낙관적 갱신·응답 유실 대비 — 메모와 같다).
#[tauri::command]
pub fn add_todo(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    todo_id: String,
    text: String,
) -> Result<Todo, IpcError> {
    let todo = Todo {
        id: todo_id,
        text,
        created_at: chrono::Utc::now().to_rfc3339(),
        done_at: None,
    };
    state.todos.write().unwrap_or_else(|e| e.into_inner()).push(todo.clone());
    persist(&app, &state, &window)?;
    Ok(todo)
}

/// 할 일 글자 수정. 없으면 null.
#[tauri::command]
pub fn update_todo_text(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    todo_id: String,
    text: String,
) -> Result<Option<Todo>, IpcError> {
    let result = {
        let mut todos = state.todos.write().unwrap_or_else(|e| e.into_inner());
        todos.iter_mut().find(|t| t.id == todo_id).map(|t| {
            t.text = text;
            t.clone()
        })
    };
    persist(&app, &state, &window)?;
    Ok(result)
}

/// 완료/해제. 없으면 null.
#[tauri::command]
pub fn set_todo_done(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    todo_id: String,
    done: bool,
) -> Result<Option<Todo>, IpcError> {
    let now = chrono::Utc::now().to_rfc3339();
    let result = {
        let mut todos = state.todos.write().unwrap_or_else(|e| e.into_inner());
        todos.iter_mut().find(|t| t.id == todo_id).map(|t| {
            apply_todo_done(t, done, &now);
            t.clone()
        })
    };
    persist(&app, &state, &window)?;
    Ok(result)
}

/// 할 일 삭제.
#[tauri::command]
pub fn delete_todo(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    todo_id: String,
) -> Result<(), IpcError> {
    state
        .todos
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|t| t.id != todo_id);
    persist(&app, &state, &window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(done_at: Option<&str>) -> Todo {
        Todo {
            id: "t1".into(),
            text: "x".into(),
            created_at: "2026-11-20T00:00:00+00:00".into(),
            done_at: done_at.map(str::to_string),
        }
    }

    #[test]
    fn todo_done_keeps_first_completion_time_and_clears_on_undo() {
        let mut t = todo(None);
        apply_todo_done(&mut t, true, "2026-11-24T01:00:00+00:00");
        assert_eq!(t.done_at.as_deref(), Some("2026-11-24T01:00:00+00:00"));
        // 이미 완료 — 다시 완료로 불러도 처음 시각이 남는다.
        apply_todo_done(&mut t, true, "2026-11-25T09:00:00+00:00");
        assert_eq!(t.done_at.as_deref(), Some("2026-11-24T01:00:00+00:00"));
        apply_todo_done(&mut t, false, "2026-11-25T09:00:00+00:00");
        assert_eq!(t.done_at, None);
        // 미완료를 다시 해제해도 그대로.
        apply_todo_done(&mut t, false, "2026-11-25T09:00:00+00:00");
        assert_eq!(t.done_at, None);
    }

    /// 미완료 항목은 저장할 때 doneAt 키를 만들지 않고, 키가 없는 JSON 은 미완료로 읽힌다.
    #[test]
    fn todo_without_done_at_round_trips() {
        let json = serde_json::to_string(&todo(None)).unwrap();
        assert!(!json.contains("doneAt"), "{json}");
        let back: Todo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.done_at, None);
        assert_eq!(back.created_at, "2026-11-20T00:00:00+00:00");
    }
}
