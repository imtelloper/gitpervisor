use tauri::{AppHandle, Emitter, State};

use crate::error::IpcError;
use crate::git::types::Memo;
use crate::state::{self, AppState, Notes};

/// 카테고리 이름 길이 상한(글자 수). 프런트 입력칸의 maxLength 와 같은 값이다.
const MEMO_CATEGORY_MAX_CHARS: usize = 30;

/// 전체 메모(projectId → 메모 목록) — 시작 시 1회 로드해 캐시.
#[tauri::command(async)]
pub fn get_notes(state: State<'_, AppState>) -> Notes {
    state.notes.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 저장하고 다른 창에 알린다. 메모장은 메인과 모아보기 별도 창 둘에 뜨는데 프런트 캐시는 창마다 따로이고
/// staleTime 이 Infinity 다 — 알리지 않으면 한 창이 옛 캐시의 "빈 메모"를 정리하면서 다른 창이 채운 내용을 지운다.
/// 페이로드는 **바꾼 창의 라벨**: 받은 쪽이 자기 것이면 무시한다(자기 저장마다 재조회할 이유가 없다).
fn persist(app: &AppHandle, state: &AppState, origin: &tauri::Window) -> Result<(), IpcError> {
    let snapshot = state.notes.read().unwrap_or_else(|e| e.into_inner()).clone();
    state::save_notes(app, &snapshot)?;
    // 신호일 뿐 진실은 재조회다 — 실패해도 저장은 끝났고, 그 창은 다음 재조회 때 따라온다.
    let _ = app.emit("notes://changed", Some(origin.label()));
    Ok(())
}

/// 카테고리 이름 정리 — 앞뒤 공백 제거, 개행은 공백으로, 상한까지 자르기. 비면 None(미분류).
/// 거절하지 않고 고쳐 받는다: 이름은 표시용 문자열일 뿐 경로나 키로 쓰이지 않는다.
fn normalize_memo_category(raw: Option<String>) -> Option<String> {
    let cleaned: String = raw?
        .replace(['\r', '\n'], " ")
        .trim()
        .chars()
        .take(MEMO_CATEGORY_MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// 한 스코프의 메모에서 카테고리 `from` 을 `to` 로 바꾼다(None = 해제). 바뀐 개수를 돌려준다.
/// `updated_at` 은 올리지 않는다 — 분류만 옮겼는데 "수정일순" 맨 위로 튀면 안 된다.
fn rename_category_in(list: &mut [Memo], from: &str, to: Option<&str>) -> usize {
    let mut changed = 0;
    for m in list.iter_mut().filter(|m| m.category.as_deref() == Some(from)) {
        m.category = to.map(str::to_string);
        changed += 1;
    }
    changed
}

/// 새 메모 추가. memoId는 프론트가 생성해 전달(낙관적 갱신·응답 유실 대비).
/// `category` 는 필터가 걸린 채 만든 메모가 그 카테고리로 들어가게 하기 위함이다(안 주면 미분류).
#[tauri::command]
pub fn add_memo(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    project_id: String,
    memo_id: String,
    category: Option<String>,
) -> Result<Memo, IpcError> {
    let now = chrono::Utc::now().to_rfc3339();
    let memo = Memo {
        id: memo_id,
        text: String::new(),
        created_at: now.clone(),
        updated_at: now,
        category: normalize_memo_category(category),
    };
    state
        .notes
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .entry(project_id)
        .or_default()
        .push(memo.clone());
    persist(&app, &state, &window)?;
    Ok(memo)
}

/// 메모 본문 수정. 없으면 null.
#[tauri::command]
pub fn update_memo(
    app: AppHandle,
    window: tauri::Window,
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
    persist(&app, &state, &window)?;
    Ok(result)
}

/// 메모 하나의 카테고리 지정(None·빈 문자열 = 미분류). 없으면 null. `updated_at` 은 그대로 둔다.
#[tauri::command]
pub fn set_memo_category(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    project_id: String,
    memo_id: String,
    category: Option<String>,
) -> Result<Option<Memo>, IpcError> {
    let category = normalize_memo_category(category);
    let result = {
        let mut notes = state.notes.write().unwrap_or_else(|e| e.into_inner());
        notes.get_mut(&project_id).and_then(|list| {
            list.iter_mut().find(|m| m.id == memo_id).map(|m| {
                m.category = category;
                m.clone()
            })
        })
    };
    persist(&app, &state, &window)?;
    Ok(result)
}

/// 카테고리 이름 바꾸기 = 그 이름을 가진 메모 일괄 갱신(카테고리 테이블이 없다). `to` 가 None·빈 문자열이면 해제.
#[tauri::command]
pub fn rename_memo_category(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    project_id: String,
    from: String,
    to: Option<String>,
) -> Result<(), IpcError> {
    let to = normalize_memo_category(to);
    {
        let mut notes = state.notes.write().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = notes.get_mut(&project_id) {
            rename_category_in(list, &from, to.as_deref());
        }
    }
    persist(&app, &state, &window)
}

/// 드래그로 정한 메모 순서를 영속화한다 — ordered_ids 순서대로 재배열.
/// 목록에 없는 id는 상대 순서를 유지한 채 뒤로 보낸다(reorder_projects의 tail 규칙과 동일).
#[tauri::command]
pub fn reorder_memos(
    app: AppHandle,
    window: tauri::Window,
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
    persist(&app, &state, &window)
}

/// 메모 삭제. 프로젝트의 메모가 모두 없어지면 키도 제거.
#[tauri::command]
pub fn delete_memo(
    app: AppHandle,
    window: tauri::Window,
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
    persist(&app, &state, &window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo(id: &str, category: Option<&str>) -> Memo {
        Memo {
            id: id.into(),
            text: String::new(),
            created_at: "2026-11-24T00:00:00+00:00".into(),
            updated_at: "2026-11-24T00:00:00+00:00".into(),
            category: category.map(str::to_string),
        }
    }

    #[test]
    fn memo_category_is_trimmed_capped_and_empty_means_none() {
        assert_eq!(normalize_memo_category(None), None);
        assert_eq!(normalize_memo_category(Some("   ".into())), None);
        assert_eq!(normalize_memo_category(Some("  work ".into())), Some("work".into()));
        assert_eq!(normalize_memo_category(Some("a\r\nb".into())), Some("a  b".into()));
        // 바이트가 아니라 글자 수로 자른다 — 여러 바이트 문자로 확인.
        let long = "é".repeat(MEMO_CATEGORY_MAX_CHARS + 5);
        assert_eq!(
            normalize_memo_category(Some(long)).map(|s| s.chars().count()),
            Some(MEMO_CATEGORY_MAX_CHARS)
        );
    }

    #[test]
    fn rename_memo_category_touches_only_that_category_and_keeps_updated_at() {
        let mut list = vec![memo("a", Some("work")), memo("b", Some("home")), memo("c", None), memo("d", Some("work"))];
        assert_eq!(rename_category_in(&mut list, "work", Some("corp")), 2);
        let cats: Vec<_> = list.iter().map(|m| m.category.as_deref()).collect();
        assert_eq!(cats, [Some("corp"), Some("home"), None, Some("corp")]);
        assert!(list.iter().all(|m| m.updated_at == "2026-11-24T00:00:00+00:00"));
        // 해제: 메모는 남고 분류만 사라진다.
        assert_eq!(rename_category_in(&mut list, "corp", None), 2);
        assert!(list.iter().filter(|m| m.id != "b").all(|m| m.category.is_none()));
        assert_eq!(list.len(), 4);
    }

    /// 필드가 없는 옛 notes.json 이 그대로 읽히고, 미분류 메모는 저장할 때 키를 만들지 않는다.
    #[test]
    fn memo_without_category_field_round_trips() {
        let old = r#"{"id":"m1","text":"hi","createdAt":"t0","updatedAt":"t1"}"#;
        let m: Memo = serde_json::from_str(old).unwrap();
        assert_eq!(m.category, None);
        assert!(!serde_json::to_string(&m).unwrap().contains("category"));
    }
}
