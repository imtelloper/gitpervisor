use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::IpcError;
use crate::git::parse_status::parse_porcelain_v2;
use crate::git::runner;
use crate::git::types::{RepoOpState, RepoStatus};
use crate::state::AppState;

/// 전 프로젝트 상태를 단일 invoke로 일괄 조회한다.
///
/// 페이지 로드 직후 다수의 동시 invoke 응답이 유실되는 WebView2 이슈를 피하면서
/// (요청 1개 = 응답 1개), 레포별 git 실행은 백엔드에서 병렬로 유지한다 (NF1).
#[tauri::command]
pub async fn get_statuses(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<RepoStatus>, IpcError> {
    let targets: Vec<(String, Option<PathBuf>)> = {
        let projects = state.projects.read().unwrap();
        project_ids
            .into_iter()
            .map(|id| {
                let path = projects
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| PathBuf::from(&p.path));
                (id, path)
            })
            .collect()
    };

    let futures = targets.into_iter().map(|(id, path)| async move {
        match path {
            None => RepoStatus::with_error(&id, "프로젝트를 찾을 수 없습니다"),
            Some(path) => status_of(&id, &path).await,
        }
    });

    Ok(futures::future::join_all(futures).await)
}

/// 한 레포의 상태 조회. 실패는 RepoStatus.error로 표현한다 (사이드바 회색 상태).
async fn status_of(project_id: &str, path: &Path) -> RepoStatus {
    if !path.is_dir() {
        return RepoStatus::with_error(project_id, "프로젝트 경로를 찾을 수 없습니다");
    }

    let out = match runner::run_git(
        Some(path),
        &["status", "--porcelain=v2", "--branch", "-z"],
        runner::STATUS_TIMEOUT_SECS,
    )
    .await
    {
        Ok(out) => out,
        Err(e) => return RepoStatus::with_error(project_id, e.message),
    };
    if out.code != 0 {
        return RepoStatus::with_error(
            project_id,
            format!("git status 실패: {}", out.stderr.trim()),
        );
    }

    let mut status = RepoStatus::empty(project_id);
    parse_porcelain_v2(&out.stdout, &mut status);
    status.op_state = detect_op_state(path).await;
    status
}

/// merge/rebase/cherry-pick/bisect 진행 중인지 .git 디렉토리 마커 파일로 감지.
async fn detect_op_state(repo: &Path) -> RepoOpState {
    let Ok(out) = runner::run_git(
        Some(repo),
        &["rev-parse", "--git-dir"],
        runner::READ_TIMEOUT_SECS,
    )
    .await
    else {
        return RepoOpState::Normal;
    };
    if out.code != 0 {
        return RepoOpState::Normal;
    }

    let mut git_dir = PathBuf::from(out.stdout_str().trim());
    if git_dir.is_relative() {
        git_dir = repo.join(git_dir);
    }

    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        RepoOpState::Rebasing
    } else if git_dir.join("MERGE_HEAD").exists() {
        RepoOpState::Merging
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        RepoOpState::CherryPicking
    } else if git_dir.join("BISECT_LOG").exists() {
        RepoOpState::Bisecting
    } else {
        RepoOpState::Normal
    }
}
