use std::path::{Component, Path};
use std::time::Duration;

use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::types::Project;
use crate::state::AppState;

pub type RepoWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoChanged {
    project_id: String,
}

/// 프로젝트 워치 등록. 이벤트는 "이 레포 바뀜" 신호일 뿐이며 페이로드에 상태를 싣지 않는다 (설계 §4).
/// 실패해도 앱 동작에는 지장 없다 — 수동 새로고침과 포커스 갱신이 보험.
pub fn register(app: &AppHandle, project: &Project) {
    let path = Path::new(&project.path);
    if !path.is_dir() {
        return;
    }

    let emit_app = app.clone();
    let project_id = project.id.clone();
    let debouncer = new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errors) => {
                    eprintln!("[watcher] 이벤트 오류: {errors:?}");
                    return;
                }
            };
            let relevant = events
                .iter()
                .any(|e| e.paths.iter().any(|p| is_relevant(p)));
            if relevant {
                let emit_result = emit_app.emit(
                    "repo://changed",
                    RepoChanged {
                        project_id: project_id.clone(),
                    },
                );
                if let Err(e) = emit_result {
                    eprintln!("[watcher] emit 실패: {e}");
                }
            }
        },
    );

    let mut debouncer = match debouncer {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[watcher] 생성 실패 {}: {e}", project.path);
            return;
        }
    };
    if let Err(e) = debouncer.watch(path, RecursiveMode::Recursive) {
        eprintln!("[watcher] watch 실패 {}: {e}", project.path);
        return;
    }

    let state = app.state::<AppState>();
    state
        .watchers
        .lock()
        .unwrap()
        .insert(project.id.clone(), debouncer);
}

/// 워처 해제 — 드롭이 감시를 중지한다.
pub fn unregister(app: &AppHandle, project_id: &str) {
    let state = app.state::<AppState>();
    state.watchers.lock().unwrap().remove(project_id);
}

/// 빌드/의존성 산출물 디렉토리 — gitignore 대상이라 status에 안 잡히고, 대량 쓰기로
/// watcher를 폭주시킨다(dev 빌드의 target/, node_modules/ 등). 이 안의 이벤트는 무시.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".vite",
    ".turbo",
    ".cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".venv",
    "venv",
    ".gradle",
    "coverage",
];

/// .git 내부는 상태 변화 마커만 통과시킨다 — objects/·*.lock 폭주(gc·fetch·빌드)는 무시.
/// 빌드/의존성 디렉토리도 무시한다. 그 외 워크트리 파일 이벤트는 신호로 취급(status 재실행).
fn is_relevant(path: &Path) -> bool {
    let s = path.to_string_lossy().replace('\\', "/");

    if let Some(idx) = s.find("/.git/") {
        let inner = &s[idx + "/.git/".len()..];
        if inner.starts_with("objects/") || inner.ends_with(".lock") {
            return false;
        }
        return inner == "HEAD"
            || inner == "index"
            || inner == "MERGE_HEAD"
            || inner == "CHERRY_PICK_HEAD"
            || inner == "ORIG_HEAD"
            || inner == "FETCH_HEAD"
            || inner == "BISECT_LOG"
            || inner.starts_with("refs/")
            || inner.starts_with("rebase-merge")
            || inner.starts_with("rebase-apply");
    }
    if s.ends_with("/.git") {
        return false;
    }
    // 빌드/의존성 디렉토리 내부 이벤트는 무시 (경로 세그먼트 정확 일치)
    if path.components().any(|c| {
        matches!(c, Component::Normal(n) if IGNORED_DIRS.contains(&n.to_string_lossy().as_ref()))
    }) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::is_relevant;
    use std::path::Path;

    #[test]
    fn worktree_files_are_relevant() {
        assert!(is_relevant(Path::new(r"C:\repo\src\main.rs")));
        assert!(is_relevant(Path::new("/repo/README.md")));
    }

    #[test]
    fn git_markers_are_relevant() {
        for p in [
            r"C:\repo\.git\HEAD",
            r"C:\repo\.git\index",
            r"C:\repo\.git\MERGE_HEAD",
            r"C:\repo\.git\FETCH_HEAD",
            r"C:\repo\.git\refs\heads\main",
            r"C:\repo\.git\rebase-merge\done",
        ] {
            assert!(is_relevant(Path::new(p)), "{p}는 통과해야 함");
        }
    }

    #[test]
    fn build_dirs_are_ignored() {
        for p in [
            r"C:\repo\node_modules\pkg\index.js",
            r"C:\repo\target\debug\app.exe",
            r"/repo/dist/bundle.js",
            r"/repo/__pycache__/mod.pyc",
            r"/repo/.venv/lib/foo.py",
        ] {
            assert!(!is_relevant(Path::new(p)), "{p}는 무시해야 함");
        }
        // 비슷한 이름은 통과 (정확 세그먼트 매칭)
        assert!(is_relevant(Path::new(r"C:\repo\src\mytarget\x.rs")));
        assert!(is_relevant(Path::new(r"C:\repo\targets\x.rs")));
    }

    #[test]
    fn git_noise_is_ignored() {
        for p in [
            r"C:\repo\.git\objects\ab\cdef123456",
            r"C:\repo\.git\index.lock",
            r"C:\repo\.git\refs\heads\main.lock",
            r"C:\repo\.git",
        ] {
            assert!(!is_relevant(Path::new(p)), "{p}는 무시해야 함");
        }
    }
}
