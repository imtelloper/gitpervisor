use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::state::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpProgress {
    project_id: String,
    op: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpFinished {
    project_id: String,
    op: &'static str,
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn push(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    set_upstream: bool,
) -> Result<(), IpcError> {
    let mut args = vec!["push", "--progress"];
    if set_upstream {
        args.extend(["-u", "origin", "HEAD"]);
    }
    sync_op(app, state, project_id, "push", args).await
}

#[tauri::command]
pub async fn pull(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), IpcError> {
    sync_op(app, state, project_id, "pull", vec!["pull", "--progress"]).await
}

#[tauri::command]
pub async fn fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<(), IpcError> {
    sync_op(app, state, project_id, "fetch", vec!["fetch", "--progress"]).await
}

/// 네트워크 작업 공통: stderr 진행을 이벤트로 스트리밍하고, 종료를 op-finished로 알린다.
/// 응답 유실(§10) 대비 — 프론트는 op-finished 이벤트만으로도 UI를 정리할 수 있다.
async fn sync_op(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    op: &'static str,
    args: Vec<&str>,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let _guard = state.try_begin_op(&project_id)?;

    let progress_app = app.clone();
    let progress_id = project_id.clone();
    let result = runner::run_git_streaming(
        &repo,
        &args,
        runner::NETWORK_TIMEOUT_SECS,
        move |line| {
            let _ = progress_app.emit(
                "repo://op-progress",
                OpProgress {
                    project_id: progress_id.clone(),
                    op,
                    line,
                },
            );
        },
    )
    .await;

    let outcome = match result {
        Ok(out) if out.code == 0 => Ok(()),
        Ok(out) => Err(classify_failure(op, &out.stderr)),
        Err(e) => Err(e),
    };

    let _ = app.emit(
        "repo://op-finished",
        OpFinished {
            project_id,
            op,
            ok: outcome.is_ok(),
            error: outcome.as_ref().err().map(|e| e.message.clone()),
        },
    );
    outcome
}

fn classify_failure(op: &str, stderr: &str) -> IpcError {
    let lower = stderr.to_lowercase();
    let auth = lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied")
        || lower.contains("access denied");
    if auth {
        IpcError {
            code: ErrorCode::AuthFailed,
            message: format!("{op} 인증 실패 — credential manager / ssh-agent 설정을 확인하세요"),
            stderr: Some(stderr.to_string()),
        }
    } else {
        IpcError::git(format!("git {op} 실패"), stderr)
    }
}
