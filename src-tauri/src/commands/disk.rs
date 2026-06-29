use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 프로젝트당 Rust 빌드 산출물(target) 용량.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSize {
    project_id: String,
    /// Cargo.toml 이 하나라도 있으면 true (사이드바 표시 여부 판단)
    is_rust: bool,
    /// 모든 cargo target 디렉토리 합산 바이트
    bytes: u64,
    /// 청소 대상 target 디렉토리 수 (워크스페이스/하위 크레이트 다중일 수 있음)
    target_count: usize,
    /// 청소 시 삭제될 정확한 절대 경로들 (확인 다이얼로그에 그대로 표시 — 사용자 안심용)
    paths: Vec<String>,
}

/// `clean_target` 결과 — 회수 용량과 삭제한 target 수.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanResult {
    freed_bytes: u64,
    removed: usize,
}

// Cargo.toml 탐색 깊이 상한. melkyway 의 APPLICATION/src-tauri 같은 중첩 매니페스트까지
// 닿되, 거대 트리를 무한정 훑지 않도록 제한한다.
const MAX_DEPTH: usize = 4;

/// 프로젝트 안의 cargo target 디렉토리들을 찾는다.
/// 반환: (Rust 프로젝트 여부, target 디렉토리 목록).
///
/// 안전장치: **이름이 정확히 `target` 이고 같은 폴더에 `Cargo.toml` 이 있는** 디렉토리만
/// 대상으로 삼는다. 무관한 'target' 폴더(빌드 산출물이 아닌)나 워크스페이스 밖 폴더는
/// 절대 건드리지 않는다 — `clean_target` 의 삭제 안전성이 여기에 달려 있다.
fn find_cargo_targets(root: &Path) -> (bool, Vec<PathBuf>) {
    let mut is_rust = false;
    let mut targets = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if dir.join("Cargo.toml").is_file() {
            is_rust = true;
            let t = dir.join("target");
            if t.is_dir() {
                targets.push(t);
            }
        }
        if depth >= MAX_DEPTH {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            // Cargo.toml 탐색 가지치기 — target 안으론 안 들어가고(거대), .git/node_modules/
            // 숨김 폴더도 건너뛴다.
            if name == "target"
                || name == ".git"
                || name == "node_modules"
                || name.starts_with('.')
            {
                continue;
            }
            stack.push((entry.path(), depth + 1));
        }
    }
    targets.sort();
    targets.dedup();
    (is_rust, targets)
}

/// 디렉토리 전체 크기(바이트). 심볼릭 링크는 따라가지 않는다(순환 방지).
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(m) = entry.metadata() {
                    total += m.len();
                }
            }
        }
    }
    total
}

/// 전 프로젝트의 target 용량을 배치로 계산한다 (사이드바 표시용).
/// 큰 target 디렉토리 열거는 수 초 걸릴 수 있어 프로젝트별 스레드로 병렬화하고,
/// 전체를 blocking 풀에서 돌려 async 런타임을 막지 않는다.
#[tauri::command]
pub async fn get_target_sizes(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<TargetSize>, IpcError> {
    // State 는 스레드로 넘길 수 없으니 경로를 먼저 스냅샷한다.
    let jobs: Vec<(String, PathBuf)> = {
        let projects = state.projects.read().unwrap();
        project_ids
            .iter()
            .filter_map(|id| {
                projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| (id.clone(), PathBuf::from(&p.path)))
            })
            .collect()
    };

    tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = jobs
            .into_iter()
            .map(|(id, path)| {
                std::thread::spawn(move || {
                    let (is_rust, targets) = find_cargo_targets(&path);
                    let bytes = targets.iter().map(|t| dir_size(t)).sum();
                    let paths = targets.iter().map(|t| t.display().to_string()).collect();
                    TargetSize {
                        project_id: id,
                        is_rust,
                        bytes,
                        target_count: targets.len(),
                        paths,
                    }
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("용량 계산 실패: {e}")))
}

/// 프로젝트 폴더 전체 용량(바이트) — 사이드바 표시용.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSize {
    project_id: String,
    bytes: u64,
    /// 경로 소실 등 — 값이 있으면 배지를 표시하지 않는다.
    error: Option<String>,
}

/// 전 프로젝트의 폴더 전체 용량을 배치로 계산한다(사이드바 표시).
/// 거대 트리(node_modules/.git/target 포함) 워크는 수 초 걸릴 수 있어 프로젝트별 스레드로
/// 병렬화하고 blocking 풀에서 돌려 async 런타임을 막지 않는다. 프론트는 background 레인 +
/// staleTime:Infinity로 1회만 계산하고 수동 새로고침으로 갱신한다(get_target_sizes와 동형).
#[tauri::command]
pub async fn get_project_sizes(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<ProjectSize>, IpcError> {
    let jobs: Vec<(String, Option<PathBuf>)> = {
        let projects = state.projects.read().unwrap();
        project_ids
            .iter()
            .map(|id| {
                let path = projects
                    .iter()
                    .find(|p| &p.id == id)
                    .map(|p| PathBuf::from(&p.path));
                (id.clone(), path)
            })
            .collect()
    };

    tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = jobs
            .into_iter()
            .map(|(id, path)| {
                std::thread::spawn(move || match path {
                    Some(p) if p.is_dir() => ProjectSize {
                        project_id: id,
                        bytes: dir_size(&p),
                        error: None,
                    },
                    Some(_) => ProjectSize {
                        project_id: id,
                        bytes: 0,
                        error: Some("경로를 찾을 수 없습니다".into()),
                    },
                    None => ProjectSize {
                        project_id: id,
                        bytes: 0,
                        error: Some("프로젝트를 찾을 수 없습니다".into()),
                    },
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("용량 계산 실패: {e}")))
}

/// 한 프로젝트의 cargo target 디렉토리를 통째로 삭제한다(= `cargo clean` 의미).
/// 명시적 사용자 액션이므로 최근/현재 toolchain 산출물도 함께 비운다 — 다음 빌드는
/// 처음부터지만 즉시 최대치를 회수한다.
#[tauri::command]
pub async fn clean_target(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<CleanResult, IpcError> {
    let path = project_path(&state, &project_id)?;

    let (freed, removed, total, last_err) = tauri::async_runtime::spawn_blocking(move || {
        let (_is_rust, targets) = find_cargo_targets(&path);
        let total = targets.len();
        let mut freed = 0u64;
        let mut removed = 0usize;
        let mut last_err: Option<String> = None;
        for t in &targets {
            let sz = dir_size(t);
            match fs::remove_dir_all(t) {
                Ok(()) => {
                    freed += sz;
                    removed += 1;
                }
                Err(e) => last_err = Some(format!("{}: {e}", t.display())),
            }
        }
        (freed, removed, total, last_err)
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("청소 실패: {e}")))?;

    // 대상이 있는데 하나도 못 지웠다면(빌드 중 파일 잠금 등) 오류로 표면화한다.
    if total > 0 && removed == 0 {
        return Err(IpcError::new(
            ErrorCode::Io,
            last_err.unwrap_or_else(|| {
                "target 디렉토리를 삭제하지 못했습니다 (빌드/에디터가 사용 중일 수 있음)".into()
            }),
        ));
    }

    Ok(CleanResult {
        freed_bytes: freed,
        removed,
    })
}
