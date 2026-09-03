use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::mpsc;
use std::time::Duration;

#[cfg(target_os = "linux")]
use notify_debouncer_full::notify::event::{ModifyKind, RenameMode};
#[cfg(target_os = "linux")]
use notify_debouncer_full::notify::EventKind;
use notify_debouncer_full::notify::{Config, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::git::types::Project;
use crate::state::AppState;

/// 파일 ID 캐시는 **쓰지 않는다**(`NoCache`). 기본값인 `RecommendedCache`는 Windows/macOS에서
/// `FileIdMap`이라 감시 대상 **파일마다** CreateFile로 ID를 읽어 ~180B씩 상주시킨다
/// (개발기 24프로젝트 ≈ 60MB, 2026-09-03 실측). 그 캐시는 rename From/To 짝맞추기 전용인데
/// 우리는 페이로드 없는 "이 레포 바뀜" 신호만 쓰므로(§4, 위 `RepoChanged`) 쓸모가 없다.
/// Linux의 `RecommendedCache`는 원래 `NoCache`라 통일해도 동작 변화가 없다.
pub type RepoWatcher = Debouncer<RecommendedWatcher, NoCache>;

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
    // 새로 생긴 디렉토리를 증분 등록하는 통로 — **inotify(디렉토리별 비재귀) 전용**이다.
    // Windows/macOS는 루트 하나에 재귀 감시를 걸어 새 디렉토리를 커널이 자동 상속하므로
    // 채널도 스레드도 만들지 않는다. 콜백에서 직접 watch()를 부르면 디바운서가 이벤트
    // 스레드에서 쥐고 있는 캐시 락과 교착할 수 있어, 전용 스레드로 넘겨 처리한다.
    #[cfg(target_os = "linux")]
    let (new_dir_tx, new_dir_rx) = mpsc::channel::<PathBuf>();
    let debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
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
            #[cfg(target_os = "linux")]
            {
                // 비재귀 등록이라 새 디렉토리는 자동 상속되지 않는다 — 생성 이벤트를 보고 직접 건다.
                // 이걸 빠뜨리면 "새로 만든 폴더 안의 변경이 UI에 안 뜨는" 조용한 회귀가 된다.
                // 생성뿐 아니라 **이동해 들어온 경우(rename)** 도 잡아야 한다. inotify는 MOVED_TO를
                // Modify(Name(To|Both))로 보고하므로 Create만 보면 통째로 놓친다.
                for e in &events {
                    let is_new_dir = matches!(
                        e.kind,
                        EventKind::Create(_)
                            | EventKind::Modify(ModifyKind::Name(
                                RenameMode::To | RenameMode::Both | RenameMode::Any
                            ))
                    );
                    if !is_new_dir {
                        continue;
                    }
                    for p in &e.paths {
                        if !under_ignored_dir(p) && p.is_dir() {
                            let _ = new_dir_tx.send(p.clone());
                        }
                    }
                }
            }
            // 커널 이벤트 큐 오버플로(inotify Q_OVERFLOW, FSEvents MustScanSubDirs)는
            // **경로가 비어 있는** Rescan 이벤트로 온다 — is_relevant로는 절대 걸리지 않는다.
            // 놓치면 npm install·git checkout 직후 상태가 영영 안 갱신되는 조용한 회귀가 된다.
            // (Windows notify 8.2.0은 오버플로를 아예 보고하지 않는다 — windows.rs의 완료
            //  루틴이 0바이트 완료를 그냥 흘린다. 그쪽은 포커스 갱신·수동 새로고침이 보험.)
            let relevant = events
                .iter()
                .any(|e| e.need_rescan() || e.paths.iter().any(|p| is_relevant(p)));
            if relevant {
                // 파일트리 ignore 캐시 무효화 — .gitignore 편집 포함 모든 레포 변경이
                // 다음 list_dir에서 배경 재빌드를 킥하게 한다(tree.rs kick_ignore_refresh).
                if let Some(st) = emit_app.try_state::<crate::state::AppState>() {
                    let mut map = st
                        .ignore_cache
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if let Some(c) = map.get_mut(&project_id) {
                        c.fresh = false;
                    }
                }
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
        NoCache::new(),
        Config::default(),
    );

    let mut debouncer = match debouncer {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[watcher] 생성 실패 {}: {e}", project.path);
            return;
        }
    };
    let n = watch_pruned(&mut debouncer, path);
    if n == 0 {
        eprintln!("[watcher] watch 실패 {}", project.path);
        return;
    }
    log::info!(
        "[watcher] {} 감시 {n}개 ({})",
        project.path,
        if cfg!(target_os = "linux") {
            "디렉토리별 비재귀"
        } else {
            "루트 재귀"
        }
    );

    let state = app.state::<AppState>();
    state
        .watchers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(project.id.clone(), debouncer);
    drop(state);

    // 증분 등록 스레드(Linux 전용). 워처가 해제(unregister/교체)되면 디바운서 → 콜백 → 송신단이
    // 드롭되어 수신이 끊기고 이 스레드도 스스로 끝난다.
    #[cfg(target_os = "linux")]
    {
        let add_app = app.clone();
        let add_id = project.id.clone();
        std::thread::spawn(move || {
            while let Ok(first) = new_dir_rx.recv() {
                // 쌓인 것을 한 번에 비우고 중복·포함 관계를 정리한다. npm install·git clone은
                // 디렉토리를 수천 개 만들어 이벤트를 폭주시키므로, 건건이 처리하면 같은 트리를
                // 반복 순회하며 O(n²)가 된다.
                let mut dirs = vec![first];
                while let Ok(more) = new_dir_rx.try_recv() {
                    dirs.push(more);
                }
                dirs.sort();
                dirs.dedup();
                let snapshot = dirs.clone();
                dirs.retain(|p| !snapshot.iter().any(|q| q != p && p.starts_with(q)));

                // 파일시스템 순회는 **반드시 락 밖에서** 한다. 이 안에서 state.watchers 락을 쥐면
                // remove_project 같은 동기 커맨드(GTK 메인 스레드 실행)가 그동안 통째로 막혀
                // 큰 트리에서 창 전체가 수 초간 얼어붙는다.
                let mut targets = Vec::new();
                for dir in &dirs {
                    targets.append(&mut collect_watch_targets(dir));
                }
                if targets.len() > MAX_INCREMENTAL_WATCHES {
                    log::warn!(
                        "[watcher] 새 디렉토리 {}개는 상한({})을 넘어 일부만 감시합니다",
                        targets.len(),
                        MAX_INCREMENTAL_WATCHES
                    );
                    targets.truncate(MAX_INCREMENTAL_WATCHES);
                }
                if targets.is_empty() {
                    continue;
                }

                // 락은 inotify 등록(syscall)만 감싼다.
                let state = add_app.state::<AppState>();
                let mut guard = state.watchers.lock().unwrap_or_else(|e| e.into_inner());
                match guard.get_mut(&add_id) {
                    Some(d) => {
                        apply_watches(d, &targets);
                    }
                    None => break, // 워처가 해제됨
                }
            }
        });
    }
}

/// 증분 등록 1회 상한 — 필터를 빠져나간 거대 트리가 통째로 들어오는 것을 막는다.
#[cfg(target_os = "linux")]
const MAX_INCREMENTAL_WATCHES: usize = 5_000;

/// 감시를 등록하고 등록한 개수를 돌려준다. 플랫폼별 전략은 `collect_watch_targets` 참고.
fn watch_pruned(d: &mut RepoWatcher, root: &Path) -> usize {
    apply_watches(d, &collect_watch_targets(root))
}

/// 감시할 디렉토리 목록을 만든다 — **파일시스템 순회만** 하고 워처는 건드리지 않는다.
/// 락을 쥐지 않은 채 호출할 수 있도록 등록(`apply_watches`)과 분리돼 있다.
///
/// **Windows/macOS는 루트 하나에 재귀 감시 1개만** 건다(.git 도 루트 안이라 자동 포함).
/// Windows의 ReadDirectoryChangesW는 **감시 1개당 16KB 커널 버퍼를 Box로 상주**시키는데
/// (notify-8.2.0 `windows.rs`의 `BUF_SIZE`), 디렉토리별 비재귀로 걸면 개발기 24프로젝트에서
/// 23,885개 ≈ 400MB가 gitpervisor.exe private에 잡혔다(2026-09-03 실측 — 물리 RAM 7.7GB
/// 머신에서 앱이 통째로 사라진 2026-09-02 사건의 주 원인). macOS FSEvents는 스트림 자체가
/// 재귀 네이티브라 쪼갤 이유가 없다. 산출물 트리 이벤트는 `is_relevant`가 경로로 거른다.
///
/// **Linux(inotify)만 디렉토리별 비재귀**로 남긴다. 재귀 watch는 node_modules·target 같은
/// 산출물 트리까지 전부 감시한다 — 실측으로 12개 레포에 184,001개가 걸렸고 그중 95.2%가
/// 낭비였다. inotify watch 하나는 커널 메모리 ~1KB를 고정하므로 약 180MB가 cgroup
/// memory.current에 잡혔고, 이것이 systemd-oomd가 이 앱을 희생자로 고르게 만든 압박의
/// 큰 몫이었다(2026-08 사건 P0-3). 즉 Windows는 "감시를 쪼개면" 커지고 Linux는 "감시를
/// 합치면" 커진다 — 그래서 전략이 갈린다.
fn collect_watch_targets(root: &Path) -> Vec<(PathBuf, RecursiveMode)> {
    if !cfg!(target_os = "linux") {
        return vec![(root.to_path_buf(), RecursiveMode::Recursive)];
    }

    let mut out = vec![(root.to_path_buf(), RecursiveMode::NonRecursive)];
    // .git 은 상태 마커(HEAD/index/MERGE_HEAD…)와 refs/ 만 있으면 된다.
    // objects/ 는 gc·fetch 가 수만 개 파일을 쓰는 곳이라 통째로 제외한다.
    let git = root.join(".git");
    if git.is_dir() {
        out.push((git.clone(), RecursiveMode::NonRecursive));
        let refs = git.join("refs");
        if refs.is_dir() {
            out.push((refs, RecursiveMode::Recursive));
        }
    }

    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // 심볼릭 링크는 is_dir()이 false — 따라가지 않으므로 순환 위험이 없다.
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == ".git" || IGNORED_DIRS.contains(&name.as_ref()) {
                continue;
            }
            let child = entry.path();
            out.push((child.clone(), RecursiveMode::NonRecursive));
            stack.push(child);
        }
    }
    out
}

/// 준비된 목록을 실제로 등록한다(감시 등록 syscall만). 호출자가 워처 락을 쥔 구간이므로 짧아야 한다.
fn apply_watches(d: &mut RepoWatcher, targets: &[(PathBuf, RecursiveMode)]) -> usize {
    targets
        .iter()
        .filter(|(p, mode)| d.watch(p, *mode).is_ok())
        .count()
}

/// 경로에 무시 대상 디렉토리 세그먼트가 하나라도 있는지 (정확 세그먼트 일치).
///
/// 구분자를 정규화한 뒤 판정한다. `Path::components()`만 쓰면 Linux에서 Windows 스타일 경로
/// (`C:\repo\node_modules\pkg\index.js`)가 통째로 한 세그먼트가 되어 필터를 그대로 빠져나간다
/// — 원래 있던 결함이고 `build_dirs_are_ignored` 테스트가 이를 잡아냈다.
fn under_ignored_dir(path: &Path) -> bool {
    path.to_string_lossy()
        .replace('\\', "/")
        .split('/')
        .any(|seg| IGNORED_DIRS.contains(&seg))
}

/// 워처 해제 — 드롭이 감시를 중지한다.
pub fn unregister(app: &AppHandle, project_id: &str) {
    let state = app.state::<AppState>();
    state.watchers.lock().unwrap_or_else(|e| e.into_inner()).remove(project_id);
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
    if under_ignored_dir(path) {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{
        collect_watch_targets, is_relevant, Debouncer, NoCache, RecommendedWatcher, RecursiveMode,
        RepoWatcher,
    };
    use std::path::Path;

    /// **`NoCache`는 최적화가 아니라 재귀 감시의 전제조건이다** — 컴파일 타임 단언.
    ///
    /// 누가 rename 정확도를 이유로 `RecommendedCache`(Windows/macOS에서 `FileIdMap`)를
    /// 되살리면 여기서 타입이 안 맞아 빌드가 깨진다. 그게 없으면 **무계 누수가 조용히
    /// 부활한다.** 기전(notify-debouncer-full 0.7 소스로 확인):
    ///
    /// `DebounceDataInner::add_event`가 `Create`마다, 그리고 폴백 `_` 갈래에서도
    /// `cache.add_path(path, self.recursive_mode(path))`를 부른다. `recursive_mode()`는
    /// `roots`에서 그 경로를 포함하는 루트의 모드를 **그대로 상속**시키므로, 루트가
    /// `Recursive`면 그 아래 전부 `Recursive`가 된다. 그러면 `FileIdMap::add_path`가
    /// `dir_scan_depth(true) == usize::MAX`로 **`WalkDir` 전 트리 순회 + 엔트리마다
    /// `CreateFile`** 을 돌린 뒤 `paths` HashMap에 **영구 삽입**한다(비우는 건 `Remove`뿐).
    /// 게다가 `Debouncer::add_root`가 `roots.push` 직후 **그 자리에서** 같은 일을 해,
    /// `npm install`을 기다릴 것도 없이 **등록 시점에** 전 트리가 캐시에 들어온다.
    ///
    /// 즉 재귀 감시 + `FileIdMap`은 **유계 431MB를 무계 누수와 바꾸는 거래**다
    /// (2026-09-03 개발기 실측: 감시 23,885개 = 버퍼 373MB, FileIdMap 334,716엔트리 ≈ 57MB,
    /// gitpervisor.exe private 554MB의 78%). `NoCache`는 세 메서드가 전부 no-op이고,
    /// 잃는 것도 없다 — 콜백은 rename 짝을 쓰지 않고 "이 레포 바뀜" 신호만 쏜다.
    #[test]
    fn cache_type_is_nocache() {
        fn only_nocache(_: &Debouncer<RecommendedWatcher, NoCache>) {}
        let _: fn(&RepoWatcher) = only_nocache;
    }

    /// 임시 레포 뼈대 — 하위 소스 디렉토리 + 산출물 트리 + .git/refs.
    fn make_repo() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for sub in ["src/deep", "node_modules/pkg", ".git/refs/heads"] {
            std::fs::create_dir_all(tmp.path().join(sub)).unwrap();
        }
        tmp
    }

    /// Windows/macOS: 감시 1개당 16KB 커널 버퍼가 상주하므로 루트 재귀 1개여야 한다.
    #[test]
    #[cfg(not(target_os = "linux"))]
    fn recursive_platforms_watch_root_only() {
        let tmp = make_repo();
        let targets = collect_watch_targets(tmp.path());
        assert_eq!(targets.len(), 1, "루트 재귀 1개여야 함: {targets:?}");
        assert_eq!(targets[0].0, tmp.path().to_path_buf());
        assert!(matches!(targets[0].1, RecursiveMode::Recursive));
    }

    /// Linux(inotify): 디렉토리별 비재귀 + 산출물 트리 가지치기 + .git/refs만 재귀.
    #[test]
    #[cfg(target_os = "linux")]
    fn linux_prunes_build_dirs() {
        let tmp = make_repo();
        let root = tmp.path();
        let targets = collect_watch_targets(root);
        let has = |p: &str| targets.iter().any(|(t, _)| *t == root.join(p));
        assert!(has("src/deep"), "소스 디렉토리는 감시해야 함: {targets:?}");
        assert!(!has("node_modules"), "산출물 트리는 제외해야 함");
        assert!(!has("node_modules/pkg"));
        assert!(targets
            .iter()
            .any(|(t, m)| *t == root.join(".git/refs") && matches!(m, RecursiveMode::Recursive)));
    }

    /// **`.git`이 없는 루트도 감시해야 한다.** 프로젝트 목록에는 git 레포가 아닌 루트가 있다 —
    /// 사용자가 이미지 파일 경로를 빨리 집으려고 `C:\Users\GreatHoon\Downloads`를 일부러
    /// 등록해 뒀고, 그것 하나가 감시 3,420개(54MB)였다(2026-09-03 실측).
    ///
    /// 감시 수를 줄이려고 "git 레포만 감시" 같은 게이트를 넣으면 **그 루트의 파일트리가
    /// 영영 갱신되지 않는다** — 비-git 루트에서도 `repo://changed`의 ignore 캐시 무효화와
    /// 트리 갱신은 그대로 필요하다. 다운로드가 끝나도 화면이 안 바뀌는 조용한 회귀다.
    #[test]
    fn non_git_root_is_still_watched() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("2026/08")).unwrap();
        let targets = collect_watch_targets(root);
        assert!(
            targets.iter().any(|(t, _)| t == root),
            "비-git 루트가 빠졌다: {targets:?}"
        );
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!(targets.len(), 1, "루트 재귀 1개여야 함: {targets:?}");
            assert!(matches!(targets[0].1, RecursiveMode::Recursive));
        }
        #[cfg(target_os = "linux")]
        assert!(
            targets.iter().any(|(t, _)| *t == root.join("2026/08")),
            "하위 디렉토리도 감시해야 함: {targets:?}"
        );
    }

    /// 루트 재귀 감시는 산출물·objects 이벤트를 통째로 받는다 — 깊이와 무관하게 걸러져야
    /// git fetch 한 번에 수천 건이 "바뀜"으로 새지 않는다.
    #[test]
    fn deep_recursive_noise_is_ignored() {
        for p in [
            r"C:\repo\packages\app\node_modules\.bin\tsc",
            r"C:\repo\.git\objects\pack\tmp_pack_ab12",
            "/repo/apps/web/.next/static/chunk.js",
        ] {
            assert!(!is_relevant(Path::new(p)), "{p}는 무시해야 함");
        }
    }

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
