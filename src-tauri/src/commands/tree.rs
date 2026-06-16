use std::collections::HashSet;
use std::path::{Component, Path};

use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::DirEntry;
use crate::state::AppState;

/// 프로젝트 내 한 디렉토리의 항목을 나열한다 (지연 로딩 — 폴더 펼칠 때 한 단계씩).
/// `rel_path`는 레포 루트 기준 상대 경로(빈 문자열이면 루트).
#[tauri::command]
pub async fn list_dir(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<Vec<DirEntry>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    validate_rel_dir(&rel_path)?;

    let dir = if rel_path.is_empty() {
        repo.clone()
    } else {
        repo.join(&rel_path)
    };
    if !dir.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "디렉토리를 찾을 수 없습니다",
        ));
    }

    // 1) 디렉토리 항목 수집
    let mut read = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("디렉토리 읽기 실패: {e}")))?;
    let mut items: Vec<(String, bool)> = Vec::new(); // (name, is_dir)
    while let Ok(Some(entry)) = read.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        items.push((name, is_dir));
    }

    // 2) gitignore 판정 (git check-ignore 배치)
    let ignored = check_ignored(&repo, &rel_path, &items).await;

    let mut entries: Vec<DirEntry> = items
        .into_iter()
        .map(|(name, is_dir)| {
            let rel = join_rel(&rel_path, &name);
            DirEntry {
                is_ignored: name == ".git" || ignored.contains(&rel),
                name,
                is_dir,
            }
        })
        .collect();

    // 3) 디렉토리 우선 + 이름순(대소문자 무시, 점 파일은 자연히 앞)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// `git check-ignore -z --stdin` 로 무시되는 경로 집합을 구한다 (추적 중인 파일은 제외됨).
async fn check_ignored(repo: &Path, rel_path: &str, items: &[(String, bool)]) -> HashSet<String> {
    if items.is_empty() {
        return HashSet::new();
    }
    let mut input = Vec::new();
    for (name, _) in items {
        input.extend_from_slice(join_rel(rel_path, name).as_bytes());
        input.push(0);
    }
    match runner::run_git_with_stdin(
        Some(repo),
        &["check-ignore", "-z", "--stdin"],
        &input,
        runner::READ_TIMEOUT_SECS,
    )
    .await
    {
        Ok(out) => out
            .stdout
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        Err(_) => HashSet::new(),
    }
}

/// 레포 밖 접근 차단 — 절대경로·`..` 거부. 빈 문자열(루트)은 허용.
fn validate_rel_dir(rel: &str) -> Result<(), IpcError> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    Ok(())
}
