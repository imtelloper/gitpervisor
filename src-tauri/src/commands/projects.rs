use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, State};

use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::Project;
use crate::state::{self, AppState};

/// 프로젝트 id → 저장소 경로.
///
/// 임베디드(중첩) 저장소는 `<outer_id>::<rel>` 형태의 합성 id를 쓴다(status.rs 참조).
/// `::`가 있으면 outer 프로젝트 경로에 상대경로를 이어 붙여 중첩 저장소 경로를 돌려준다 —
/// 이 덕분에 stage/unstage/discard/commit/diff/log 등 모든 git 커맨드가 별도 코드 없이
/// 중첩 저장소를 대상으로 동작한다. 프로젝트 id(uuid)는 `::`를 포함하지 않으므로 첫 `::`로 가른다.
pub(crate) fn project_path(
    state: &State<'_, AppState>,
    project_id: &str,
) -> Result<PathBuf, IpcError> {
    if let Some((outer_id, rel)) = project_id.split_once("::") {
        let base = lookup_path(state, outer_id)?;
        return resolve_nested(&base, rel);
    }
    lookup_path(state, project_id)
}

fn lookup_path(state: &State<'_, AppState>, project_id: &str) -> Result<PathBuf, IpcError> {
    let projects = state.projects.read().unwrap();
    projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| PathBuf::from(&p.path))
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "프로젝트를 찾을 수 없습니다"))
}

/// 중첩 저장소 경로 해석 + 컨테인먼트 가드. rel은 우리 자신의 git status 출력에서 오지만,
/// 방어적으로 절대경로·`..` 이탈을 막고 정규화 후 base 안에 있는지 확인한다.
fn resolve_nested(base: &Path, rel: &str) -> Result<PathBuf, IpcError> {
    let relp = Path::new(rel);
    // RootDir까지 막는다 — Windows에서 "/x"는 is_absolute()가 false지만 join 시 드라이브 루트로
    // 튀어 컨테인먼트를 우회할 수 있다(Component::RootDir로 확실히 차단).
    if rel.is_empty()
        || relp.is_absolute()
        || relp.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "잘못된 중첩 저장소 경로입니다",
        ));
    }
    let joined = base.join(relp);
    // 존재하면 정규화해 base 컨테인먼트를 확인한다. 정규화 실패(경로 없음 등)면 렉시컬 결과를
    // 그대로 쓴다 — 위에서 `..`/절대경로를 이미 배제해 base 밖으로 나갈 수 없다.
    match (dunce::canonicalize(&joined), dunce::canonicalize(base)) {
        (Ok(j), Ok(b)) => {
            if j.starts_with(&b) {
                Ok(j)
            } else {
                Err(IpcError::new(
                    ErrorCode::NotFound,
                    "저장소 경계를 벗어난 경로입니다",
                ))
            }
        }
        _ => Ok(joined),
    }
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

    // git 레포면 서브디렉토리를 골라도 레포 루트로 정규화해 등록한다.
    // 비-git 폴더는 초안 단계로 그대로 허용 — 사용자가 나중에 `git init`하면 watcher가
    // .git 생성을 감지해 상태가 자동 갱신된다.
    let target = match runner::run_git(
        Some(&dir),
        &["rev-parse", "--show-toplevel"],
        runner::READ_TIMEOUT_SECS,
    )
    .await
    {
        Ok(out) if out.code == 0 => PathBuf::from(out.stdout_str().trim()),
        _ => dir.clone(),
    };
    let canonical = dunce::canonicalize(&target)
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
    // 파일 감시 등록을 백그라운드로 — 거대 레포는 재귀 감시 + 캐시 인덱싱이 수 초 걸려
    // 추가 응답이 그만큼 늦어진다. 등록은 미루고 프로젝트를 즉시 반환한다.
    let watch_app = app.clone();
    let watch_project = project.clone();
    std::thread::spawn(move || {
        crate::watcher::register(&watch_app, &watch_project);
    });
    Ok(project)
}

/// 임의의 부모 디렉토리 아래에 새 프로젝트 폴더를 만든다(옵션으로 git init). 절대경로를 돌려주며,
/// 프론트가 이어서 add_project로 등록한다(등록·중복·watcher는 add_project가 처리 — DRY).
#[tauri::command]
pub async fn create_project_folder(
    parent_dir: String,
    name: String,
    git_init: bool,
) -> Result<String, IpcError> {
    // 1) 이름 검증 — 빈 이름·경로 구분자·. / .. 거부(프론트 validateName와 동형).
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains("..")
    {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 폴더 이름입니다"));
    }
    // 2) 부모 디렉토리 존재 확인.
    let parent = PathBuf::from(&parent_dir);
    if !parent.is_dir() {
        return Err(IpcError::new(ErrorCode::NotFound, "부모 폴더를 찾을 수 없습니다"));
    }
    let dir = parent.join(trimmed);
    // 3) 폴더 생성(create_new 시맨틱 — 이미 있으면 AlreadyExists).
    match tokio::fs::create_dir(&dir).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(IpcError::new(
                ErrorCode::AlreadyExists,
                "같은 이름의 폴더가 이미 있습니다",
            ));
        }
        Err(e) => return Err(IpcError::new(ErrorCode::Io, format!("폴더 생성 실패: {e}"))),
    }
    // 4) 선택적 git init.
    if git_init {
        let out = runner::run_git(Some(&dir), &["init"], runner::ACTION_TIMEOUT_SECS).await?;
        if out.code != 0 {
            return Err(IpcError::git("git init 실패".to_string(), out.stderr));
        }
    }
    // 5) 절대경로 반환(프론트가 add_project로 넘김).
    let canonical = dunce::canonicalize(&dir)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("경로 정규화 실패: {e}")))?;
    Ok(canonical.display().to_string())
}

/// 사이드바 드래그로 정한 새 순서를 영속화한다 — 주어진 순서대로 order를 0..n 재할당.
/// 목록에 없는 id는 무시하고, ordered_ids에 빠진 프로젝트는 뒤로 보낸다(기존 상대순서 유지).
#[tauri::command]
pub fn reorder_projects(
    app: AppHandle,
    state: State<'_, AppState>,
    ordered_ids: Vec<String>,
) -> Result<(), IpcError> {
    {
        let mut projects = state.projects.write().unwrap();
        let rank: std::collections::HashMap<&str, u32> = ordered_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (id.as_str(), i as u32))
            .collect();
        let tail = ordered_ids.len() as u32;
        for p in projects.iter_mut() {
            p.order = rank.get(p.id.as_str()).copied().unwrap_or(tail);
        }
    }
    state::save_projects(&app, &state.projects.read().unwrap())
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
    // 메모도 함께 정리 (있을 때만 저장)
    let removed_note = state.notes.write().unwrap().remove(&id).is_some();
    if removed_note {
        let snapshot = state.notes.read().unwrap().clone();
        let _ = state::save_notes(&app, &snapshot);
    }
    state::save_projects(&app, &state.projects.read().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_nested_rejects_traversal() {
        let base = Path::new("/repo");
        assert!(resolve_nested(base, "").is_err(), "빈 경로 거부");
        assert!(resolve_nested(base, "../evil").is_err(), ".. 이탈 거부");
        assert!(resolve_nested(base, "a/../../b").is_err(), "중간 .. 거부");
        assert!(resolve_nested(base, "/etc/passwd").is_err(), "루트 경로 거부");
    }

    #[test]
    fn resolve_nested_joins_subpath() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let sub = base.join("a").join("b");
        std::fs::create_dir_all(&sub).unwrap();
        // 슬래시 상대경로가 base 안 하위경로로 해석돼야 한다.
        let got = resolve_nested(base, "a/b").unwrap();
        assert_eq!(got, dunce::canonicalize(&sub).unwrap());
    }
}
