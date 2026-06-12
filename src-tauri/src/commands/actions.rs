use std::path::Path;

use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::state::AppState;

#[tauri::command]
pub async fn stage_files(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let _guard = state.try_begin_op(&project_id)?;
    stage_core(&repo, &paths).await
}

#[tauri::command]
pub async fn unstage_files(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let _guard = state.try_begin_op(&project_id)?;
    unstage_core(&repo, &paths).await
}

/// 파괴적 작업 — 프론트엔드에서 확인 다이얼로그를 거친 뒤에만 호출된다 (설계 F10).
#[tauri::command]
pub async fn discard_files(
    state: State<'_, AppState>,
    project_id: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let _guard = state.try_begin_op(&project_id)?;
    discard_core(&repo, &tracked, &untracked).await
}

#[tauri::command]
pub async fn commit(
    state: State<'_, AppState>,
    project_id: String,
    message: String,
    amend: bool,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let _guard = state.try_begin_op(&project_id)?;
    commit_core(&repo, &message, amend).await
}

/// `git <base..> -- <paths..>` 실행. 경로는 항상 `--` 뒤에 배치한다 (NF3).
async fn run_action(repo: &Path, base: &[&str], paths: &[String]) -> Result<(), IpcError> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = base.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));

    let out = runner::run_git(Some(repo), &args, runner::ACTION_TIMEOUT_SECS).await?;
    if out.code != 0 {
        return Err(IpcError::git(
            format!("git {} 실패", base.join(" ")),
            out.stderr,
        ));
    }
    Ok(())
}

pub(crate) async fn stage_core(repo: &Path, paths: &[String]) -> Result<(), IpcError> {
    run_action(repo, &["add"], paths).await
}

pub(crate) async fn unstage_core(repo: &Path, paths: &[String]) -> Result<(), IpcError> {
    match run_action(repo, &["restore", "--staged"], paths).await {
        // unborn branch(첫 커밋 전)에는 HEAD가 없어 restore가 불가 — 인덱스에서 직접 제거
        Err(e)
            if e.stderr
                .as_deref()
                .is_some_and(|s| s.contains("could not resolve HEAD")) =>
        {
            run_action(repo, &["rm", "--cached", "-q", "-r"], paths).await
        }
        result => result,
    }
}

pub(crate) async fn discard_core(
    repo: &Path,
    tracked: &[String],
    untracked: &[String],
) -> Result<(), IpcError> {
    // tracked: 인덱스 내용으로 워크트리 복원 — unstaged 변경만 되돌리고 staged는 보존.
    // 주의: `--source=HEAD` + --worktree 단독 조합은 autocrlf=true에서 파일이 영원히
    // modified로 남는다 (M2 구현 중 실측) — 인덱스 소스는 stat 캐시가 갱신되어 안전.
    run_action(repo, &["restore", "--worktree"], tracked).await?;
    // untracked: 파일/디렉토리 삭제 (-x 없음 — ignored 파일은 건드리지 않는다)
    run_action(repo, &["clean", "-fd", "-q"], untracked).await
}

pub(crate) async fn commit_core(repo: &Path, message: &str, amend: bool) -> Result<(), IpcError> {
    if message.trim().is_empty() {
        return Err(IpcError::new(
            ErrorCode::GitError,
            "커밋 메시지가 비어 있습니다",
        ));
    }

    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }

    let out =
        runner::run_git_with_stdin(Some(repo), &args, message.as_bytes(), runner::ACTION_TIMEOUT_SECS)
            .await?;
    if out.code != 0 {
        // "nothing to commit" 등은 stdout으로 나온다 — 둘 다 합쳐 전달
        let detail = format!("{}\n{}", out.stdout_str().trim(), out.stderr.trim());
        return Err(IpcError::git("git commit 실패", detail.trim().to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::parse_status::parse_porcelain_v2;
    use crate::git::types::RepoStatus;

    /// 테스트 헬퍼: 임시 레포에서 git 명령 실행 (성공 단언)
    async fn sh(repo: &Path, args: &[&str]) {
        let out = runner::run_git(Some(repo), args, 30).await.unwrap();
        assert_eq!(out.code, 0, "git {args:?} 실패: {}", out.stderr);
    }

    async fn status_of(repo: &Path) -> RepoStatus {
        let out = runner::run_git(
            Some(repo),
            &["status", "--porcelain=v2", "--branch", "-z"],
            30,
        )
        .await
        .unwrap();
        let mut s = RepoStatus::empty("test");
        parse_porcelain_v2(&out.stdout, &mut s);
        s
    }

    async fn init_repo(dir: &Path) {
        sh(dir, &["init", "-b", "main"]).await;
        sh(dir, &["config", "user.email", "test@test"]).await;
        sh(dir, &["config", "user.name", "test"]).await;
    }

    #[tokio::test]
    async fn stage_commit_modify_discard_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo).await;

        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        stage_core(repo, &["a.txt".into()]).await.unwrap();
        let s = status_of(repo).await;
        assert_eq!(s.staged.len(), 1);

        commit_core(repo, "첫 커밋", false).await.unwrap();
        let s = status_of(repo).await;
        assert!(s.staged.is_empty() && s.unstaged.is_empty() && s.untracked.is_empty());

        std::fs::write(repo.join("a.txt"), "changed\n").unwrap();
        let s = status_of(repo).await;
        assert_eq!(s.unstaged.len(), 1);

        discard_core(repo, &["a.txt".into()], &[]).await.unwrap();
        let s = status_of(repo).await;
        assert!(s.unstaged.is_empty(), "discard 후 워킹트리가 깨끗해야 함");
    }

    #[tokio::test]
    async fn discard_untracked_removes_file() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo).await;

        std::fs::write(repo.join("junk.txt"), "x").unwrap();
        assert_eq!(status_of(repo).await.untracked.len(), 1);

        discard_core(repo, &[], &["junk.txt".into()]).await.unwrap();
        assert!(status_of(repo).await.untracked.is_empty());
        assert!(!repo.join("junk.txt").exists());
    }

    #[tokio::test]
    async fn unstage_on_unborn_branch_falls_back() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo).await;

        std::fs::write(repo.join("first.txt"), "x").unwrap();
        stage_core(repo, &["first.txt".into()]).await.unwrap();
        assert_eq!(status_of(repo).await.staged.len(), 1);

        // HEAD가 없는 상태 — rm --cached 폴백 경로
        unstage_core(repo, &["first.txt".into()]).await.unwrap();
        let s = status_of(repo).await;
        assert!(s.staged.is_empty());
        assert_eq!(s.untracked.len(), 1);
    }

    #[tokio::test]
    async fn commit_amend_rewrites_message() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo).await;

        std::fs::write(repo.join("a.txt"), "1").unwrap();
        stage_core(repo, &["a.txt".into()]).await.unwrap();
        commit_core(repo, "원래 메시지", false).await.unwrap();
        commit_core(repo, "고친 메시지", true).await.unwrap();

        let out = runner::run_git(Some(repo), &["log", "--format=%s", "-1"], 30)
            .await
            .unwrap();
        assert_eq!(out.stdout_str().trim(), "고친 메시지");
        let count = runner::run_git(Some(repo), &["rev-list", "--count", "HEAD"], 30)
            .await
            .unwrap();
        assert_eq!(count.stdout_str().trim(), "1", "amend는 커밋 수를 늘리지 않는다");
    }

    #[tokio::test]
    async fn empty_message_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        init_repo(repo).await;
        let err = commit_core(repo, "   ", false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::GitError);
    }
}
