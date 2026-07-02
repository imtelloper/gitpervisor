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
            None => vec![RepoStatus::with_error(&id, "프로젝트를 찾을 수 없습니다")],
            Some(path) => statuses_for_project(&id, &path).await,
        }
    });

    // 각 프로젝트는 자기 status + (있으면) 임베디드 저장소 status들을 반환한다 — 평탄화해 한 배열로.
    let statuses: Vec<RepoStatus> = futures::future::join_all(futures)
        .await
        .into_iter()
        .flatten()
        .collect();
    Ok(statuses)
}

/// 한 프로젝트에 대해: 자기 status + 그 안에서 발견한 모든 임베디드(중첩) 저장소들의 status를
/// 반환한다. 임베디드 저장소는 자체 `.git`을 가진, 서브모듈로 등록되지 않은 폴더로,
/// `git status -uall`도 내부를 재귀하지 않고 `? dir/` 한 줄로만 보고한다(그래서 예전엔 Changes에
/// 폴더 한 줄만 떴다). 이를 감지해 별도 저장소처럼 상태를 조회하고, 합성 id
/// `<outer_id>::<rel>` 를 부여한다 — project_path 가 이 id를 중첩 경로로 되풀어, 기존의 모든
/// git 커맨드(stage/diff/commit 등)가 그대로 중첩 저장소를 대상으로 동작한다.
async fn statuses_for_project(outer_id: &str, root: &std::path::Path) -> Vec<RepoStatus> {
    /// 한 프로젝트에서 조회할 저장소(자기 + 중첩) 최대 개수 — 병적인 트리에서 폭주 방지.
    const MAX_REPOS: usize = 64;

    let mut out: Vec<RepoStatus> = Vec::new();
    // (합성 id, 절대 경로, outer 기준 상대경로(None=루트), 부모 id(None=루트))
    let mut queue: Vec<(String, PathBuf, Option<String>, Option<String>)> =
        vec![(outer_id.to_string(), root.to_path_buf(), None, None)];

    while let Some((id, abs, rel, parent)) = queue.pop() {
        if out.len() >= MAX_REPOS {
            break;
        }
        let mut status = status_of(&id, &abs).await;
        status.parent_id = parent;
        status.rel_path = rel.clone();

        // untracked 중 임베디드 저장소(`dir/` + 내부 `.git` 존재)를 골라내 outer 목록에서 제거하고
        // 별도 저장소로 큐에 넣는다.
        let mut keep = Vec::with_capacity(status.untracked.len());
        for entry in std::mem::take(&mut status.untracked) {
            let sub = entry.path.strip_suffix('/');
            if let Some(sub) = sub {
                if abs.join(sub).join(".git").exists() {
                    let rel_from_outer = match &rel {
                        Some(r) => format!("{r}/{sub}"),
                        None => sub.to_string(),
                    };
                    let child_id = format!("{outer_id}::{rel_from_outer}");
                    let child_abs = abs.join(sub);
                    queue.push((child_id, child_abs, Some(rel_from_outer), Some(id.clone())));
                    continue;
                }
            }
            keep.push(entry);
        }
        status.untracked = keep;
        out.push(status);
    }

    // 루트(out[0])에 하위 임베디드 저장소들의 변경 총합을 적재한다 — 사이드바 점/뱃지가
    // "이 프로젝트 안 중첩 저장소에 변경 있음"을 반영하도록.
    if !out.is_empty() {
        let nested: u32 = out.iter().skip(1).map(count_changes).sum();
        out[0].nested_changes = nested;
    }
    out
}

/// 한 저장소의 작업트리 변경 개수(staged+unstaged+untracked+conflicted).
fn count_changes(s: &RepoStatus) -> u32 {
    (s.staged.len() + s.unstaged.len() + s.untracked.len() + s.conflicted.len()) as u32
}

/// 한 레포의 상태 조회. 실패는 RepoStatus.error로 표현한다 (사이드바 회색 상태).
async fn status_of(project_id: &str, path: &Path) -> RepoStatus {
    if !path.is_dir() {
        return RepoStatus::with_error(project_id, "프로젝트 경로를 찾을 수 없습니다");
    }

    let out = match runner::run_git(
        Some(path),
        // --untracked-files=all: 새 폴더를 한 줄("? src/")로 접지 말고 그 안의 파일을 모두
        // 개별 나열한다(git 기본 normal은 폴더만 보고 → Changes에 폴더가 파일처럼 한 줄로 뜸).
        // .gitignore된 경로는 여전히 제외되므로 node_modules 등은 나열되지 않는다.
        &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
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

#[cfg(test)]
mod tests {
    use super::*;

    async fn sh(dir: &Path, args: &[&str]) {
        let out = runner::run_git(Some(dir), args, 30).await.unwrap();
        assert_eq!(out.code, 0, "git {args:?} 실패: {}", out.stderr);
    }

    async fn init(dir: &Path) {
        sh(dir, &["init", "-b", "main"]).await;
        sh(dir, &["config", "user.email", "t@t"]).await;
        sh(dir, &["config", "user.name", "t"]).await;
    }

    /// 자체 `.git`을 가진(서브모듈 아님) 폴더는 outer의 untracked 한 줄에서 빠지고,
    /// 합성 id `<outer>::<rel>` 를 가진 별도 status로 나온다.
    #[tokio::test]
    async fn embedded_repo_becomes_nested_status() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        init(root).await;
        std::fs::write(root.join("top.txt"), "a").unwrap();
        sh(root, &["add", "top.txt"]).await;
        sh(root, &["commit", "-m", "init"]).await;
        std::fs::write(root.join("top.txt"), "b").unwrap(); // outer 워크트리 변경

        // 하위 폴더 안 임베디드 저장소 (자체 .git)
        let sub = root.join("vendor").join("lib");
        std::fs::create_dir_all(&sub).unwrap();
        init(&sub).await;
        std::fs::write(sub.join("inner.txt"), "x").unwrap();

        let out = statuses_for_project("proj1", root).await;
        assert_eq!(out.len(), 2, "최상위 + 임베디드 저장소 = 2개 status");

        let top = out.iter().find(|s| s.project_id == "proj1").unwrap();
        assert!(top.parent_id.is_none());
        assert_eq!(top.unstaged.len(), 1, "top.txt 워크트리 변경");
        assert!(
            top.untracked.iter().all(|c| !c.path.contains("vendor")),
            "임베디드 폴더는 outer untracked에서 빠져야 한다"
        );
        assert!(top.nested_changes >= 1, "중첩 변경 총합 반영");

        let nested = out.iter().find(|s| s.parent_id.is_some()).unwrap();
        assert_eq!(nested.project_id, "proj1::vendor/lib");
        assert_eq!(nested.parent_id.as_deref(), Some("proj1"));
        assert_eq!(nested.rel_path.as_deref(), Some("vendor/lib"));
        assert_eq!(nested.branch.as_deref(), Some("main"));
        assert!(
            nested.untracked.iter().any(|c| c.path == "inner.txt"),
            "임베디드 저장소의 새 파일은 그 저장소 untracked로 잡힌다"
        );
    }
}
