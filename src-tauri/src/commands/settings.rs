use std::path::PathBuf;

use tauri::{AppHandle, Emitter, State};

use crate::error::IpcError;
use crate::git::runner;
use crate::git::types::Settings;
use crate::state::{self, AppState};

#[tauri::command(async)]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 지금 UI 언어("ko" | "en") — 설정이 "system"이면 OS 판정 결과(`i18n.rs`). 프런트는 이 값만 쓴다.
#[tauri::command(async)]
pub fn ui_language_resolved() -> Result<String, IpcError> {
    Ok(crate::i18n::lang().code().to_string())
}

/// 설정 저장 + 즉시 반영. git 경로 오버라이드는 다음 git 호출부터 적용된다.
#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), IpcError> {
    runner::set_git_override(settings.git_path.as_ref().map(PathBuf::from));
    *state.settings.write().unwrap_or_else(|e| e.into_inner()) = settings.clone();
    state::save_settings(&app, &settings)?;
    // 아래 이벤트를 받은 창들이 `ui_language_resolved`를 다시 묻는다 — 그 전에 걸어 둬야 새 값을 받는다.
    crate::i18n::apply_setting(&settings.ui_language);
    // 다른 창에도 알린다 — 설정 편집은 메인 창에서만 하는데 `["settings"]`는 창마다 별개이고
    // staleTime이 Infinity라(queries/index.ts), 별도 리포트 창(67)은 자기 사본이 창을 연 시점에
    // 얼어붙는다. 그러면 "메인 창의 설정 › AI에서 준비하세요" 안내를 따라와도 그 창은 영영 모른다.
    // 이벤트는 신호일 뿐이고 진실은 재조회다(events.ts §10) — 페이로드를 싣지 않는다.
    let _ = app.emit("settings://changed", ());
    Ok(())
}
