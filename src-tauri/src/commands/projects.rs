use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::Project;
use crate::state::{self, AppState};

pub(crate) fn project_path(
    state: &State<'_, AppState>,
    project_id: &str,
) -> Result<PathBuf, IpcError> {
    let projects = state.projects.read().unwrap();
    projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| PathBuf::from(&p.path))
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "프로젝트를 찾을 수 없습니다"))
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Vec<Project> {
    let mut projects = state.projects.read().unwrap().clone();
    projects.sort_by_key(|p| p.order);
    projects
}

#[tauri::command]
pub async fn add_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Project, IpcError> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            format!("폴더를 찾을 수 없습니다: {path}"),
        ));
    }

    // git 레포 검증 + 서브디렉토리를 골라도 레포 루트로 정규화해 등록한다
    let out = runner::run_git(
        Some(&dir),
        &["rev-parse", "--show-toplevel"],
        runner::READ_TIMEOUT_SECS,
    )
    .await?;
    if out.code != 0 {
        return Err(IpcError {
            code: ErrorCode::NotARepo,
            message: format!("git 레포가 아닙니다: {path}"),
            stderr: Some(out.stderr),
        });
    }
    let toplevel = out.stdout_str().trim().to_string();
    let canonical = dunce::canonicalize(&toplevel)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("경로 정규화 실패: {e}")))?;
    let canonical_str = canonical.display().to_string();

    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| canonical_str.clone());

    let project = {
        let mut projects = state.projects.write().unwrap();
        if projects
            .iter()
            .any(|p| p.path.eq_ignore_ascii_case(&canonical_str))
        {
            return Err(IpcError::new(
                ErrorCode::DuplicateProject,
                format!("이미 등록된 프로젝트입니다: {canonical_str}"),
            ));
        }
        let order = projects.iter().map(|p| p.order + 1).max().unwrap_or(0);
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: canonical_str,
            order,
            added_at: chrono::Utc::now().to_rfc3339(),
        };
        projects.push(project.clone());
        project
    };

    state::save_projects(&app, &state.projects.read().unwrap())?;
    crate::watcher::register(&app, &project);
    Ok(project)
}

#[tauri::command]
pub fn remove_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), IpcError> {
    {
        let mut projects = state.projects.write().unwrap();
        let before = projects.len();
        projects.retain(|p| p.id != id);
        if projects.len() == before {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                "프로젝트를 찾을 수 없습니다",
            ));
        }
    }
    crate::watcher::unregister(&app, &id);
    state::save_projects(&app, &state.projects.read().unwrap())
}
