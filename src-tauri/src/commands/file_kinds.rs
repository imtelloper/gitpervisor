// 파일 트리 아래 "종류별" 탭(실행 파일·PDF·엑셀 …) — 프로젝트 전체에서 확장자로 고른 파일 목록.
//
// list_repo_files(`git ls-files`)를 쓰지 않는다: .gitignore된 산출물(빌드한 exe·내보낸 pdf)이 빠지고, git이 아닌
// 등록 폴더(다운로드 폴더 — 일부러 등록한 브라우즈 루트)에서는 아예 실패한다. 이 탭이 제일 쓰일 곳이 거기다.
// 그래서 디스크를 직접 걷되, 의존성 덩어리(node_modules 등)만 건너뛰고 링크·정션은 따라가지 않는다(순환·레포 밖).
// watcher의 IGNORED_DIRS(target·build·dist …)를 그대로 쓰지 않는 것도 의도다 — exe가 사는 곳이 바로 거기다.
//
// 목록은 **고른 탭의 확장자만** 돌려주고, 다른 탭은 개수만 센다. 처음엔 모든 탭의 파일을 한 상한(1만)으로 같이
// 받았는데, 데이터셋 폴더(학습 이미지 수만 장)가 그 상한을 혼자 채워 실행·PDF 탭이 비어 보였다(2026-10-15 실측).
//
// 걷기는 **너비 우선**이다. 깊이 우선(스택)일 때 `ML/test-data`(이미지 19만 장)가 걷기 상한을 혼자 다 써서,
// 이름순으로 먼저 쌓인 `APPLICATION/vis-service-manager/*.exe`(깊이 2)에 끝내 닿지 못했다(2026-10-27 실측).
// 실행·설치 파일은 대개 얕은 곳에 있고 상한에 걸려 잘리는 것은 깊은 데이터 더미 쪽이어야 한다.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;
use crate::state::AppState;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "__pycache__", ".venv"];
/// 걷는 항목 상한 — 등록 폴더가 드라이브 루트처럼 거대해도 수 초 안에 끝나게.
const MAX_VISITED: usize = 300_000;
/// 목록 상한 — 한 탭에 이보다 많으면 앞의 것만(개수는 끝까지 센다).
const MAX_FILES: usize = 5_000;
const MAX_EXTS: usize = 200;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KindFile {
    /// 프로젝트 루트 기준 `/` 구분 상대 경로(트리 행 경로와 같은 표기).
    pub path: String,
    pub size: u64,
    /// 0 = 파일 시스템이 수정 시각을 주지 않음.
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindFileList {
    /// `list_exts`에 든 파일, 경로순, 최대 MAX_FILES.
    pub files: Vec<KindFile>,
    /// `count_exts`(+ `list_exts`)의 확장자별 개수 — 탭 개수 표시용.
    pub counts: BTreeMap<String, u64>,
    /// 걷기 상한에 걸렸다 — 목록도 개수도 전부가 아니다.
    pub truncated: bool,
    /// 목록만 상한에 걸렸다 — 개수는 정확하고 목록이 앞부분뿐이다.
    pub files_truncated: bool,
}

fn ext_lower(name: &str) -> Option<String> {
    let dot = name.rfind('.')?;
    // ".env"처럼 점으로 시작하는 이름은 확장자가 없다(프론트 fileKindOf와 같은 규칙).
    (dot > 0).then(|| name[dot + 1..].to_ascii_lowercase())
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

/// 순수 코어 — `root` 아래를 걸어 `list_exts` 파일을 모으고 `count_exts` 개수를 센다(둘 다 소문자).
pub fn walk_files_by_ext(
    root: &Path,
    list_exts: &HashSet<String>,
    count_exts: &HashSet<String>,
) -> std::io::Result<KindFileList> {
    walk_files_by_ext_capped(root, list_exts, count_exts, MAX_VISITED)
}

fn walk_files_by_ext_capped(
    root: &Path,
    list_exts: &HashSet<String>,
    count_exts: &HashSet<String>,
    max_visited: usize,
) -> std::io::Result<KindFileList> {
    // 루트를 못 읽는 것은 오류다(빈 목록으로 숨기지 않는다). 하위 폴더 실패는 아래에서 건너뛴다.
    std::fs::read_dir(root)?;
    let mut out = KindFileList { files: Vec::new(), counts: BTreeMap::new(), truncated: false, files_truncated: false };
    let mut visited = 0usize;
    let mut queue: VecDeque<(PathBuf, String)> = VecDeque::from([(root.to_path_buf(), String::new())]);
    'walk: while let Some((dir, rel)) = queue.pop_front() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            // 권한 없는 하위 폴더(시스템 폴더·다른 사용자 소유)는 목록에서 빠질 뿐이다 — 탭 전체를 실패시키지 않는다.
            Err(e) => {
                log::debug!("[file-kinds] 폴더 건너뜀 {}: {e}", dir.display());
                continue;
            }
        };
        for entry in read.flatten() {
            visited += 1;
            if visited > max_visited {
                out.truncated = true;
                break 'walk;
            }
            // 경로가 UTF-8이 아니면 트리·뷰어 IPC가 그 경로를 되돌려 열 수 없다 — 목록에 올리지 않는다.
            let Ok(name) = entry.file_name().into_string() else { continue };
            let Ok(ft) = entry.file_type() else { continue };
            // Windows 정션도 is_symlink다 — 순환과 레포 밖 탈출을 막는다.
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    let child_rel = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                    queue.push_back((entry.path(), child_rel));
                }
                continue;
            }
            let Some(ext) = ext_lower(&name) else { continue };
            let listed = list_exts.contains(&ext);
            if !listed && !count_exts.contains(&ext) {
                continue;
            }
            if listed {
                if out.files.len() < MAX_FILES {
                    let (size, mtime) = entry.metadata().map_or((0, 0), |m| (m.len(), mtime_ms(&m)));
                    let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
                    out.files.push(KindFile { path, size, mtime_ms: mtime });
                } else {
                    out.files_truncated = true;
                }
            }
            *out.counts.entry(ext).or_default() += 1;
        }
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn ext_set(exts: Vec<String>) -> Result<HashSet<String>, IpcError> {
    if exts.len() > MAX_EXTS {
        return Err(IpcError::new(ErrorCode::Io, text_files::file_kinds_bad_ext(&exts.len())));
    }
    exts.into_iter()
        .map(|e| {
            if e.is_empty() || e.len() > 12 || !e.bytes().all(|b| b.is_ascii_alphanumeric()) {
                Err(IpcError::new(ErrorCode::Io, text_files::file_kinds_bad_ext(&e)))
            } else {
                Ok(e.to_ascii_lowercase())
            }
        })
        .collect()
}

#[tauri::command(async)]
pub async fn tree_files_by_ext(
    state: State<'_, AppState>,
    project_id: String,
    list_exts: Vec<String>,
    count_exts: Vec<String>,
) -> Result<KindFileList, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let (list, count) = (ext_set(list_exts)?, ext_set(count_exts)?);
    tokio::task::spawn_blocking(move || walk_files_by_ext(&repo, &list, &count))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::directory_read_task_failed(e)))?
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::directory_read_failed(e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 대소문자 무시 확장자 매칭 · 하위 폴더 · 의존성 폴더와 .git 건너뜀 · 점으로 시작하는 이름은 확장자 없음 ·
    /// 목록은 고른 확장자만, 개수는 세는 확장자 전부.
    #[test]
    fn file_kinds_walk_lists_one_kind_and_counts_all() {
        let root = std::env::temp_dir().join(format!("gpv-file-kinds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for (rel, body) in [
            ("a.exe", "xx"),
            ("sub/deep/B.PDF", "pdf!"),
            ("build/out.exe", ""),
            ("node_modules/pkg/c.exe", ""),
            (".git/d.exe", ""),
            ("notes.txt", ""),
            (".exe", ""),
            ("img/1.png", ""),
            ("img/2.PNG", ""),
        ] {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
        }
        let got = walk_files_by_ext(&root, &set(&["exe"]), &set(&["pdf", "png"])).unwrap();
        let paths: Vec<(&str, u64)> = got.files.iter().map(|f| (f.path.as_str(), f.size)).collect();
        assert_eq!(paths, vec![("a.exe", 2), ("build/out.exe", 0)]);
        assert!(got.files.iter().all(|f| f.mtime_ms > 0));
        let counts: Vec<(&str, u64)> = got.counts.iter().map(|(k, v)| (k.as_str(), *v)).collect();
        assert_eq!(counts, vec![("exe", 2), ("pdf", 1), ("png", 2)]);
        assert!(!got.truncated && !got.files_truncated);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(walk_files_by_ext(&root, &set(&["exe"]), &set(&[])).is_err(), "없는 루트는 빈 목록이 아니라 오류");
        assert!(ext_set(vec!["../x".into()]).is_err());
    }

    /// 걷기 상한에 걸려도 얕은 실행 파일은 목록에 남는다 — 깊은 데이터 더미가 상한을 다 먹어도.
    /// 깊이 우선이던 때는 NTFS 이름순으로 `app`이 먼저 쌓이고 `data`가 먼저 꺼내져 `app/tool/x.exe`가 빠졌다.
    #[test]
    fn file_kinds_walk_reaches_shallow_exe_before_deep_data_hits_cap() {
        let root = std::env::temp_dir().join(format!("gpv-file-kinds-bfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let deep = root.join("data/a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        for i in 0..50 {
            std::fs::write(deep.join(format!("{i}.png")), "").unwrap();
        }
        std::fs::create_dir_all(root.join("app/tool")).unwrap();
        std::fs::write(root.join("app/tool/x.exe"), "").unwrap();
        // 폴더 6개(app·data·tool·a·b·c) + x.exe 1개 = 7 — 그 뒤 png 몇 장에서 상한에 걸린다.
        let got = walk_files_by_ext_capped(&root, &set(&["exe"]), &set(&["png"]), 10).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert!(got.truncated);
        let paths: Vec<&str> = got.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["app/tool/x.exe"]);
    }
}
