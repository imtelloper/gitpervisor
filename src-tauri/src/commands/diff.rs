use std::path::{Component, Path};

use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::{DiffTarget, FileDiff};
use crate::state::AppState;

/// 한쪽이 이 크기를 넘으면 내용 전송을 생략한다 (뷰어 멈춤 방지).
const MAX_DIFF_BYTES: usize = 1_572_864; // 1.5MB

/// 한 번의 배치 프리페치에서 읽는 최대 파일 수 — 거대 변경 목록의 spawn 폭주 방지
const MAX_BATCH_FILES: usize = 30;

#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    target: DiffTarget,
) -> Result<FileDiff, IpcError> {
    let repo = project_path(&state, &project_id)?;
    match target {
        DiffTarget::Worktree { path } => worktree_diff(&repo, path).await,
        DiffTarget::Index { .. } | DiffTarget::Commit { .. } => Err(IpcError::new(
            ErrorCode::GitError,
            "index/commit diff는 M3에서 지원 예정입니다",
        )),
    }
}

/// diff 프리페치용 배치 — 단일 invoke로 여러 파일을 백엔드 병렬 조회 (§10 패턴).
/// 실패한 항목은 조용히 건너뛴다 — 클릭 시 단건 경로가 오류를 표면화한다.
#[tauri::command]
pub async fn get_file_diffs(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<Vec<FileDiff>, IpcError> {
    let repo = project_path(&state, &project_id)?;

    let futures = paths.into_iter().take(MAX_BATCH_FILES).map(|path| {
        let repo = repo.clone();
        async move { worktree_diff(&repo, path).await.ok() }
    });
    let results = futures::future::join_all(futures).await;

    // 단일 IPC 응답 크기 예산 — 초과하는 큰 파일은 제외하고 클릭 시 단건 조회에 맡긴다
    const BATCH_BYTE_BUDGET: usize = 4 * 1024 * 1024;
    let mut budget = BATCH_BYTE_BUDGET;
    let mut out = Vec::new();
    for diff in results.into_iter().flatten() {
        let size = diff.old_content.as_ref().map_or(0, String::len)
            + diff.new_content.as_ref().map_or(0, String::len);
        if size > budget {
            continue;
        }
        budget -= size;
        out.push(diff);
    }
    Ok(out)
}

/// old = 인덱스 버전(`git show :<path>`, 없으면 None) / new = 워크트리 파일.
async fn worktree_diff(repo: &Path, path: String) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;

    let spec = format!(":{path}");
    let old_bytes = match runner::run_git(Some(repo), &["show", &spec], runner::READ_TIMEOUT_SECS)
        .await
    {
        Ok(out) if out.code == 0 => Some(out.stdout),
        Ok(_) => None, // untracked/added — 인덱스에 없음
        Err(e) => return Err(e),
    };

    let new_bytes = match tokio::fs::read(repo.join(&path)).await {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, // 워크트리에서 삭제됨
        Err(e) => {
            return Err(IpcError::new(
                ErrorCode::Io,
                format!("파일 읽기 실패: {e}"),
            ))
        }
    };

    let too_large = [&old_bytes, &new_bytes]
        .iter()
        .any(|b| b.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES));
    let is_binary = !too_large
        && [&old_bytes, &new_bytes]
            .iter()
            .any(|b| b.as_ref().is_some_and(|b| looks_binary(b)));

    if too_large || is_binary {
        return Ok(FileDiff {
            path,
            old_content: None,
            new_content: None,
            is_binary,
            too_large,
        });
    }

    Ok(FileDiff {
        path,
        old_content: old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        new_content: new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        is_binary: false,
        too_large: false,
    })
}

/// 경로는 항상 우리 status 출력에서 오지만, 방어적으로 레포 밖 접근을 차단한다.
fn validate_rel_path(path: &str) -> Result<(), IpcError> {
    let p = Path::new(path);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 파일 경로입니다"));
    }
    Ok(())
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}
