use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::parse_log::{
    parse_commit_files, parse_local_branches, parse_log, parse_remote_branches,
};
use crate::git::runner;
use crate::git::types::{Branches, Commit, CommitDetail};
use crate::state::AppState;

/// 로그 출력 포맷 — 필드는 US(0x1f), 커밋은 `-z`(NUL)로 구분 (parse_log와 한 쌍).
/// 필드 순서: sha, parents, author, email, ISO date, subject, body, refs.
const LOG_FORMAT: &str = "--pretty=format:%H\x1f%P\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f%b\x1f%D";

const DEFAULT_LIMIT: u32 = 200;
const MAX_LIMIT: u32 = 1000;

/// 커밋 로그 페이지 조회 (설계 §7). unborn 브랜치(커밋 0개)는 빈 목록.
#[tauri::command]
pub async fn get_log(
    state: State<'_, AppState>,
    project_id: String,
    limit: Option<u32>,
    skip: Option<u32>,
    all_refs: Option<bool>,
) -> Result<Vec<Commit>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let max_arg = format!("--max-count={limit}");
    let skip_arg = format!("--skip={}", skip.unwrap_or(0));

    let mut args = vec!["log", "-z", LOG_FORMAT, &max_arg, &skip_arg];
    if all_refs.unwrap_or(false) {
        args.push("--all");
    }

    let out = runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await?;
    if out.code != 0 {
        // 커밋이 아직 없는 레포는 오류가 아니라 빈 히스토리로 취급한다.
        let err = out.stderr.to_lowercase();
        if err.contains("does not have any commits") || err.contains("bad default revision") {
            return Ok(Vec::new());
        }
        return Err(IpcError::git("git log 실패", out.stderr));
    }
    Ok(parse_log(&out.stdout))
}

/// 로컬/리모트 브랜치 + 현재 HEAD (설계 §7).
#[tauri::command]
pub async fn get_branches(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Branches, IpcError> {
    let repo = project_path(&state, &project_id)?;

    let local_out = runner::run_git(
        Some(&repo),
        &[
            "for-each-ref",
            "--format=%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track)",
            "refs/heads",
        ],
        runner::READ_TIMEOUT_SECS,
    )
    .await?;

    let remote_out = runner::run_git(
        Some(&repo),
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        runner::READ_TIMEOUT_SECS,
    )
    .await?;

    // detached HEAD면 code != 0 + 빈 stdout → head None (run_git은 비정상 종료를 에러로 보지 않음).
    let head_out = runner::run_git(
        Some(&repo),
        &["symbolic-ref", "--short", "-q", "HEAD"],
        runner::READ_TIMEOUT_SECS,
    )
    .await?;
    let head = head_out.stdout_str().trim().to_string();

    Ok(Branches {
        head: (!head.is_empty()).then_some(head),
        local: parse_local_branches(&local_out.stdout_str()),
        remote: parse_remote_branches(&remote_out.stdout_str()),
    })
}

/// 단일 커밋의 메타 + 변경 파일 목록 (설계 §7). 첫 커밋(root)도 `--root`로 표시.
#[tauri::command]
pub async fn get_commit_detail(
    state: State<'_, AppState>,
    project_id: String,
    sha: String,
) -> Result<CommitDetail, IpcError> {
    let repo = project_path(&state, &project_id)?;
    if !runner::is_valid_sha(&sha) {
        return Err(IpcError::new(ErrorCode::GitError, "잘못된 커밋 해시입니다"));
    }

    let meta_out = runner::run_git(
        Some(&repo),
        &["log", "-1", "-z", LOG_FORMAT, &sha],
        runner::READ_TIMEOUT_SECS,
    )
    .await?;
    if meta_out.code != 0 {
        return Err(IpcError::git("커밋을 찾을 수 없습니다", meta_out.stderr));
    }
    let commit = parse_log(&meta_out.stdout)
        .into_iter()
        .next()
        .ok_or_else(|| IpcError::new(ErrorCode::GitError, "커밋 메타 파싱 실패"))?;

    let files_out = runner::run_git(
        Some(&repo),
        &[
            "diff-tree",
            "--no-commit-id",
            "-r",
            "-M",
            "--root",
            "--name-status",
            "-z",
            &sha,
        ],
        runner::READ_TIMEOUT_SECS,
    )
    .await?;

    Ok(CommitDetail {
        commit,
        files: parse_commit_files(&files_out.stdout),
    })
}
