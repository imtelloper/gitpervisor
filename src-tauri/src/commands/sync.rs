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

    // 인증
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied")
        || lower.contains("access denied")
    {
        return IpcError {
            code: ErrorCode::AuthFailed,
            message: format!("{op} 인증 실패 — credential manager / ssh-agent 설정을 확인하세요"),
            stderr: Some(stderr.to_string()),
        };
    }

    // 자주 만나는 거부 사유를 사람이 읽을 메시지로 분류
    let reason: Option<&str> = if lower.contains("would be overwritten by merge")
        || lower.contains("would be overwritten by checkout")
    {
        Some("로컬에 커밋되지 않은 변경이 있어 머지가 거부됨 — 먼저 커밋하거나 stash하세요")
    } else if lower.contains("no tracking information") || lower.contains("no upstream") {
        Some("현재 브랜치에 추적 원격이 설정되어 있지 않음 (git branch --set-upstream-to ...)")
    } else if lower.contains("couldn't find remote ref")
        || lower.contains("does not appear to be a git repository")
    {
        Some("원격 저장소/브랜치를 찾을 수 없음 — 원격 URL과 브랜치 이름을 확인하세요")
    } else if lower.contains("merge conflict") || lower.contains("conflict") {
        Some("병합 충돌 발생 — 충돌을 해결하고 커밋을 완료하세요")
    } else if lower.contains("you have divergent branches")
        || lower.contains("need to specify how to reconcile divergent branches")
    {
        Some("로컬과 원격이 분기됨 — git config pull.rebase 또는 pull.ff 설정이 필요합니다")
    } else if lower.contains("non-fast-forward") || lower.contains("updates were rejected") {
        Some("원격에 먼저 들어간 커밋이 있어 push가 거부됨 — 먼저 pull/fetch & rebase 하세요")
    } else if lower.contains("could not resolve host") || lower.contains("network is unreachable") {
        Some("네트워크 연결 실패 — 인터넷/원격 호스트를 확인하세요")
    } else if lower.contains("dubious ownership") {
        Some("git이 레포 소유자를 신뢰하지 않음 — git config --global --add safe.directory <경로>")
    } else if lower.contains("you are not currently on a branch")
        || lower.contains("detached head")
    {
        Some("현재 detached HEAD 상태 — 브랜치로 전환 후 다시 시도하세요")
    } else if lower.contains("refusing to merge unrelated histories") {
        Some("관련 없는 히스토리 머지가 거부됨 — 의도라면 --allow-unrelated-histories 필요")
    } else if lower.contains("local changes") && lower.contains("commit") {
        Some("로컬에 커밋되지 않은 변경이 있어 작업이 거부됨 — 먼저 커밋하거나 stash하세요")
    } else {
        None
    };

    // 분류 실패 시: stderr에서 첫 'error:'/'fatal:'/'hint:' 라인을 추출해 메시지에 첨부
    let snippet = reason.map(str::to_string).unwrap_or_else(|| {
        stderr
            .lines()
            .map(str::trim)
            .find(|l| {
                let lc = l.to_ascii_lowercase();
                !l.is_empty()
                    && (lc.starts_with("error")
                        || lc.starts_with("fatal")
                        || lc.starts_with("hint")
                        || lc.starts_with("remote:"))
            })
            .map(str::to_string)
            .unwrap_or_else(|| {
                stderr
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .unwrap_or("(상세 메시지 없음)")
                    .to_string()
            })
    });

    IpcError::git(format!("git {op} 실패: {snippet}"), stderr)
}
