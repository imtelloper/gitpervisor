use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
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
    read_dir_entries(&repo, &rel_path).await
}

/// 한 프로젝트 루트의 결과(또는 오류) — 배치 프리페치용.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoot {
    pub project_id: String,
    pub entries: Vec<DirEntry>,
    pub error: Option<String>,
}

/// 여러 프로젝트의 루트 디렉토리를 **병렬로** 읽는다 (WebView2 동시 invoke 응답 유실 회피 —
/// 요청 1개로 전부 처리, 내부는 join_all 동시 실행). 프론트는 결과를 dir 캐시에 시드한다.
#[tauri::command]
pub async fn list_project_roots(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<ProjectRoot>, IpcError> {
    // 경로 해석은 락 안에서 끝내고, 읽기는 락 밖에서 동시 실행한다.
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

    // 동시성 제한(buffer_unordered) — Windows에서 git 프로세스를 한꺼번에 수십 개
    // 띄우면(Defender 스캔·프로세스 생성 폭주) 서로를 굶겨 타임아웃 난다. 소수씩 동시 실행.
    use futures::stream::StreamExt;
    const ROOT_CONCURRENCY: usize = 4;

    let results: Vec<ProjectRoot> = futures::stream::iter(targets)
        .map(|(id, path)| async move {
            let Some(p) = path else {
                return ProjectRoot {
                    project_id: id,
                    entries: Vec::new(),
                    error: Some("프로젝트 경로를 찾을 수 없습니다".to_string()),
                };
            };
            match tokio::time::timeout(Duration::from_secs(15), read_dir_entries(&p, "")).await {
                Ok(Ok(entries)) => ProjectRoot {
                    project_id: id,
                    entries,
                    error: None,
                },
                Ok(Err(e)) => ProjectRoot {
                    project_id: id,
                    entries: Vec::new(),
                    error: Some(e.message),
                },
                Err(_) => ProjectRoot {
                    project_id: id,
                    entries: Vec::new(),
                    error: Some("루트 읽기 시간 초과".to_string()),
                },
            }
        })
        .buffer_unordered(ROOT_CONCURRENCY)
        .collect()
        .await;

    Ok(results)
}

/// 한 디렉토리의 항목을 읽어 정렬한다 (list_dir·배치 프리페치 공통).
async fn read_dir_entries(repo: &Path, rel_path: &str) -> Result<Vec<DirEntry>, IpcError> {
    validate_rel_dir(rel_path)?;

    let dir = if rel_path.is_empty() {
        repo.to_path_buf()
    } else {
        repo.join(rel_path)
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
    let ignored = check_ignored(repo, rel_path, &items).await;

    let mut entries: Vec<DirEntry> = items
        .into_iter()
        .map(|(name, is_dir)| {
            let rel = join_rel(rel_path, &name);
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
