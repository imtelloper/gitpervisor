//! 정리 가능 공간(DOCS/pc-care-design.md §4.10) — 임시 파일·휴지통·크래시 덤프·썸네일·개발 캐시.
//!
//! 삭제 안전 규칙(설계 필수):
//! - 심링크·정션·재분석 지점은 따라가지 않고 링크 항목 자체만 지운다 — 링크 너머(후보 밖)는 손대지 않는다.
//! - 내려가는 폴더마다 실제 경로가 후보 루트 아래인지 확인한다.
//! - 후보 루트 폴더 자체는 남긴다(앱·OS가 그 폴더가 있다고 가정한다).
//! - 임시 파일은 14일 안에 생기거나 바뀐 것을 남긴다(실행 중인 설치 프로그램의 압축 해제본 보호).
//! - 일반 파일·링크·폴더만 다룬다 — 소켓·FIFO·장치 노드는 건드리지 않는다.
//! - 잠기거나 거부된 파일은 건너뛰고 센다.
//!   프런트는 id만 보낸다 — 지울 경로는 언제나 이 파일의 고정 후보표에서 서버가 정한다.

use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare_tools as t;

const RECENT_DAYS: u64 = 14;
/// 후보 하나를 세는 시간 상한 — npm·cargo 캐시는 파일이 수십만 개라 패널이 멈춘 것처럼 보인다.
const SCAN_BUDGET_SECS: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupKind {
    Temp,
    RecycleBin,
    CrashDumps,
    DevCache,
    Thumbnail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    pub id: String,
    pub label: String,
    pub path: Option<String>,
    pub bytes: u64,
    pub files: u64,
    pub kind: CleanupKind,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub freed_bytes: u64,
    pub deleted_files: u64,
    pub skipped_files: u64,
}

struct Target {
    id: &'static str,
    label: String,
    kind: CleanupKind,
    /// 비어 있으면 Windows 휴지통(셸 API로 다룬다).
    roots: Vec<PathBuf>,
    /// 루트 바로 아래에서 이 접두어로 시작하는 항목만(Explorer 폴더의 thumbcache_*.db).
    name_prefix: Option<&'static str>,
}

#[tauri::command(async)]
pub async fn cleanup_scan() -> Result<Vec<CleanupCandidate>, IpcError> {
    tauri::async_runtime::spawn_blocking(|| {
        let targets = targets();
        std::thread::scope(|s| {
            let handles: Vec<_> = targets.iter().map(|tg| s.spawn(move || scan_one(tg))).collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)))
                .collect()
        })
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, t::pccare_tools_task_failed(e)))
}

#[tauri::command(async)]
pub async fn cleanup_run(ids: Vec<String>) -> Result<CleanupResult, IpcError> {
    tauri::async_runtime::spawn_blocking(move || {
        let all = targets();
        let mut chosen: Vec<&Target> = Vec::new();
        for id in &ids {
            match all.iter().find(|tg| tg.id == id) {
                Some(tg) => chosen.push(tg),
                None => return Err(IpcError::new(ErrorCode::NotFound, t::cleanup_unknown_id(id))),
            }
        }
        let results: Vec<(CleanupResult, Option<String>)> = std::thread::scope(|s| {
            let handles: Vec<_> = chosen.iter().map(|tg| s.spawn(move || run_one(tg))).collect();
            handles
                .into_iter()
                .map(|h| h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)))
                .collect()
        });
        let mut total = CleanupResult::default();
        let mut first_err = None;
        for (r, err) in results {
            total.freed_bytes += r.freed_bytes;
            total.deleted_files += r.deleted_files;
            total.skipped_files += r.skipped_files;
            first_err = first_err.or(err);
        }
        // 일부라도 지웠으면 결과(건너뜀 포함)를 돌려주고, 하나도 못 지웠을 때만 사유를 오류로 올린다.
        match first_err {
            Some(e) if total.deleted_files == 0 => Err(IpcError::new(ErrorCode::Io, e)),
            _ => Ok(total),
        }
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, t::pccare_tools_task_failed(e)))?
}

fn scan_one(tg: &Target) -> CleanupCandidate {
    let mut notes: Vec<String> = Vec::new();
    if tg.kind == CleanupKind::Temp {
        notes.push(t::cleanup_note_recent_kept(RECENT_DAYS));
    }
    let mut stats = WalkStats::default();

    #[cfg(windows)]
    if tg.roots.is_empty() {
        match recycle_bin_query() {
            Ok((bytes, files)) => {
                stats.bytes = bytes;
                stats.files = files;
            }
            Err(e) => notes.push(e),
        }
    }

    let opts = WalkOpts {
        delete: false,
        keep_newer_than: keep_newer_than(tg),
        name_prefix: tg.name_prefix,
        deadline: Some(Instant::now() + Duration::from_secs(SCAN_BUDGET_SECS)),
    };
    for root in tg.roots.iter().filter(|r| r.is_dir()) {
        if let Err(e) = clean_root(root, &opts, &mut stats) {
            notes.push(t::cleanup_note_unreadable(e));
        }
    }
    if stats.timed_out {
        notes.push(t::cleanup_note_lower_bound(SCAN_BUDGET_SECS));
    }
    CleanupCandidate {
        id: tg.id.to_string(),
        label: tg.label.clone(),
        path: tg.roots.first().map(|p| p.display().to_string()),
        bytes: stats.bytes,
        files: stats.files,
        kind: tg.kind,
        note: (!notes.is_empty()).then(|| notes.join(" · ")),
    }
}

fn run_one(tg: &Target) -> (CleanupResult, Option<String>) {
    #[cfg(windows)]
    if tg.roots.is_empty() {
        return match recycle_bin_empty() {
            Ok(r) => (r, None),
            Err(e) => (CleanupResult::default(), Some(e)),
        };
    }
    let opts = WalkOpts {
        delete: true,
        keep_newer_than: keep_newer_than(tg),
        name_prefix: tg.name_prefix,
        deadline: None,
    };
    let mut stats = WalkStats::default();
    let mut err = None;
    for root in tg.roots.iter().filter(|r| r.is_dir()) {
        if let Err(e) = clean_root(root, &opts, &mut stats) {
            err = Some(format!("{}: {e}", root.display()));
        }
    }
    let r = CleanupResult {
        freed_bytes: stats.freed,
        deleted_files: stats.deleted,
        skipped_files: stats.skipped,
    };
    (r, err)
}

fn keep_newer_than(tg: &Target) -> Option<SystemTime> {
    (tg.kind == CleanupKind::Temp)
        .then(|| SystemTime::now().checked_sub(Duration::from_secs(RECENT_DAYS * 86_400)))
        .flatten()
}

// ─────────────────────────── 후보표(OS별 고정 경로) ───────────────────────────

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> Option<PathBuf> {
    env_path(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
}

fn target(id: &'static str, label: String, kind: CleanupKind, roots: Vec<PathBuf>) -> Target {
    Target { id, label, kind, roots, name_prefix: None }
}

fn dev(id: &'static str, tool: &str, root: Option<PathBuf>) -> Option<Target> {
    root.map(|r| target(id, t::cleanup_label_dev_cache(tool), CleanupKind::DevCache, vec![r]))
}

/// 있는 것만 돌려준다. 순서가 곧 화면 순서다.
fn targets() -> Vec<Target> {
    let home = home();
    let h = |rel: &str| home.as_ref().map(|p| p.join(rel));
    let cargo_home = env_path("CARGO_HOME").or_else(|| h(".cargo"));
    let gradle_home = env_path("GRADLE_USER_HOME").or_else(|| h(".gradle"));
    let mut v: Vec<Option<Target>> = vec![Some(target(
        "temp",
        t::cleanup_label_temp().into(),
        CleanupKind::Temp,
        vec![std::env::temp_dir()],
    ))];

    #[cfg(windows)]
    {
        let local = env_path("LOCALAPPDATA");
        let l = |rel: &str| local.as_ref().map(|p| p.join(rel));
        v.push(Some(target("recycleBin", t::cleanup_label_recycle_bin().into(), CleanupKind::RecycleBin, Vec::new())));
        v.push(l("CrashDumps").map(|r| target("crashDumps", t::cleanup_label_crash_dumps().into(), CleanupKind::CrashDumps, vec![r])));
        v.push(l(r"Microsoft\Windows\WER\ReportArchive").map(|r| target("werArchive", t::cleanup_label_wer_archive().into(), CleanupKind::CrashDumps, vec![r])));
        v.push(l(r"Microsoft\Windows\WER\ReportQueue").map(|r| target("werQueue", t::cleanup_label_wer_queue().into(), CleanupKind::CrashDumps, vec![r])));
        v.push(l(r"Microsoft\Windows\Explorer").map(|r| Target {
            name_prefix: Some("thumbcache_"),
            ..target("thumbnail", t::cleanup_label_thumbnail().into(), CleanupKind::Thumbnail, vec![r])
        }));
        v.push(dev("npm", "npm", l("npm-cache")));
        v.push(dev("yarn", "Yarn", l(r"Yarn\Cache")));
        v.push(dev("pnpm", "pnpm", l(r"pnpm\store")));
        v.push(dev("pip", "pip", l(r"pip\Cache")));
        v.push(dev("go", "Go", l("go-build")));
    }
    #[cfg(target_os = "linux")]
    {
        let data = env_path("XDG_DATA_HOME").or_else(|| h(".local/share"));
        let cache = env_path("XDG_CACHE_HOME").or_else(|| h(".cache"));
        let c = |rel: &str| cache.as_ref().map(|p| p.join(rel));
        v.push(data.as_ref().map(|d| {
            let trash = d.join("Trash");
            target("recycleBin", t::cleanup_label_recycle_bin().into(), CleanupKind::RecycleBin, vec![trash.join("files"), trash.join("info")])
        }));
        v.push(c("thumbnails").map(|r| target("thumbnail", t::cleanup_label_thumbnail().into(), CleanupKind::Thumbnail, vec![r])));
        v.push(dev("npm", "npm", h(".npm/_cacache")));
        v.push(dev("yarn", "Yarn", c("yarn")));
        v.push(dev("pnpm", "pnpm", data.as_ref().map(|d| d.join("pnpm/store"))));
        v.push(dev("pip", "pip", c("pip")));
        v.push(dev("go", "Go", c("go-build")));
    }
    #[cfg(target_os = "macos")]
    {
        v.push(h(".Trash").map(|r| target("recycleBin", t::cleanup_label_recycle_bin().into(), CleanupKind::RecycleBin, vec![r])));
        v.push(h("Library/Logs/DiagnosticReports").map(|r| target("crashDumps", t::cleanup_label_crash_dumps().into(), CleanupKind::CrashDumps, vec![r])));
        v.push(dev("npm", "npm", h(".npm/_cacache")));
        v.push(dev("yarn", "Yarn", h("Library/Caches/Yarn")));
        v.push(dev("pnpm", "pnpm", h("Library/pnpm/store")));
        v.push(dev("pip", "pip", h("Library/Caches/pip")));
        v.push(dev("go", "Go", h("Library/Caches/go-build")));
    }
    v.push(dev("cargo", "Cargo", cargo_home.map(|p| p.join("registry").join("cache"))));
    v.push(dev("gradle", "Gradle", gradle_home.map(|p| p.join("caches"))));

    v.into_iter()
        .flatten()
        .filter(|tg| tg.roots.is_empty() || tg.roots.iter().any(|r| r.is_dir()))
        .collect()
}

// ─────────────────────────── 휴지통(Windows 셸 API) ───────────────────────────

#[cfg(windows)]
fn recycle_bin_query() -> Result<(u64, u64), String> {
    use windows_sys::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        i64Size: 0,
        i64NumItems: 0,
    };
    // null 루트 = 모든 드라이브의 휴지통.
    let hr = unsafe { SHQueryRecycleBinW(std::ptr::null(), &mut info) };
    if hr < 0 {
        return Err(t::cleanup_recycle_query_failed(hr));
    }
    Ok((info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64))
}

#[cfg(windows)]
fn recycle_bin_empty() -> Result<CleanupResult, String> {
    use windows_sys::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
    };
    let (bytes, items) = recycle_bin_query()?;
    // 빈 휴지통에 비우기를 부르면 실패 HRESULT가 온다 — 할 일이 없을 뿐이다.
    if items == 0 {
        return Ok(CleanupResult::default());
    }
    let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
    let hr = unsafe { SHEmptyRecycleBinW(std::ptr::null_mut(), std::ptr::null(), flags) };
    if hr < 0 {
        return Err(t::cleanup_recycle_empty_failed(hr));
    }
    // 비우기 자체는 성공을 돌려줬다 — 다시 세기만 실패했으면 다 비워졌다고 보고, 그 가정을 로그에 남긴다.
    let (left_bytes, left_items) = recycle_bin_query().unwrap_or_else(|e| {
        log::warn!("[pc_care] recycle bin re-query after empty failed, assuming empty: {e}");
        (0, 0)
    });
    Ok(CleanupResult {
        freed_bytes: bytes.saturating_sub(left_bytes),
        deleted_files: items.saturating_sub(left_items),
        skipped_files: left_items,
    })
}

// ─────────────────────────── 걷기·삭제(안전 규칙의 본체) ───────────────────────────

struct WalkOpts {
    /// false면 세기만 한다(검사). 세는 것과 지우는 것이 같은 규칙을 거치게 한 함수로 둔다.
    delete: bool,
    keep_newer_than: Option<SystemTime>,
    name_prefix: Option<&'static str>,
    deadline: Option<Instant>,
}

#[derive(Debug, Default)]
struct WalkStats {
    /// 지울 대상(규칙 통과)의 크기·개수.
    bytes: u64,
    files: u64,
    deleted: u64,
    freed: u64,
    skipped: u64,
    timed_out: bool,
}

/// 링크로 다룰 항목인가. Windows는 정션·클라우드 자리표시자 등 모든 재분석 지점을 링크로 본다 —
/// std의 `is_symlink`는 이름 대리(심링크·정션)만 잡아서 나머지는 디렉터리로 따라 들어간다.
fn is_link(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// 링크 항목 자체만 지운다. Windows의 디렉터리 링크(정션 포함)는 RemoveDirectory로만 지워지고
/// 대상 내용은 건드리지 않는다.
fn remove_link(path: &Path, meta: &Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
        if meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return fs::remove_dir(path);
        }
    }
    #[cfg(not(windows))]
    let _ = meta; // 유닉스는 링크가 무엇을 가리키든 unlink 하나다
    fs::remove_file(path)
}

fn is_recent(meta: &Metadata, opts: &WalkOpts) -> bool {
    let Some(cut) = opts.keep_newer_than else { return false };
    // 수정 시각을 못 읽으면 최근으로 본다 — 모르는 것은 남긴다.
    let Ok(modified) = meta.modified() else { return true };
    // 압축 해제·복사는 원본의 수정 시각을 그대로 옮긴다 — 방금 풀린 설치 파일도 몇 년 묵어 보이므로
    // 이 디스크에 생긴 시각(Windows 생성 시각, 유닉스 ctime — 압축 해제·rename이 갱신한다)도 본다.
    let created = meta.created().ok();
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        u64::try_from(meta.ctime())
            .ok()
            .map(|s| SystemTime::UNIX_EPOCH + Duration::new(s, meta.ctime_nsec() as u32))
    };
    #[cfg(not(unix))]
    let changed: Option<SystemTime> = None;
    [Some(modified), created, changed].into_iter().flatten().any(|t| t > cut)
}

/// `root` 아래 내용을 규칙대로 세거나 지운다. 루트 자체는 남긴다. 루트를 읽을 수 없을 때만 Err.
fn clean_root(root: &Path, opts: &WalkOpts, stats: &mut WalkStats) -> io::Result<()> {
    // 루트 자체가 링크(예: 다른 드라이브로 옮긴 캐시 폴더의 정션)인 것은 사용자가 정한 위치라 따른다.
    // 그 아래로는 실제 경로 기준으로 가둔다.
    let root_real = fs::canonicalize(root)?;
    visit(&root_real, &root_real, opts, stats, true)
}

fn visit(dir: &Path, root: &Path, opts: &WalkOpts, stats: &mut WalkStats, top: bool) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        if opts.deadline.is_some_and(|d| Instant::now() >= d) {
            stats.timed_out = true;
            return Ok(());
        }
        let Ok(entry) = entry else {
            stats.skipped += 1;
            continue;
        };
        if top {
            if let Some(prefix) = opts.name_prefix {
                if !entry.file_name().to_string_lossy().starts_with(prefix) {
                    continue;
                }
            }
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            stats.skipped += 1;
            continue;
        };
        if is_link(&meta) {
            if is_recent(&meta, opts) {
                continue;
            }
            stats.files += 1;
            if opts.delete {
                match remove_link(&path, &meta) {
                    Ok(()) => stats.deleted += 1,
                    Err(_) => stats.skipped += 1,
                }
            }
        } else if meta.is_dir() {
            match fs::canonicalize(&path) {
                Ok(real) if real.starts_with(root) && real != root => {
                    if visit(&real, root, opts, stats, false).is_err() {
                        stats.skipped += 1;
                    }
                    if stats.timed_out {
                        return Ok(());
                    }
                    if opts.delete {
                        // 남긴 최근 파일·잠긴 파일이 있으면 비어 있지 않아 실패한다 — 그 파일들은 이미 셌다.
                        let _ = fs::remove_dir(&real);
                    }
                }
                _ => stats.skipped += 1,
            }
        } else if meta.file_type().is_file() {
            if is_recent(&meta, opts) {
                continue;
            }
            stats.files += 1;
            stats.bytes += meta.len();
            if opts.delete {
                match fs::remove_file(&path) {
                    Ok(()) => {
                        stats.deleted += 1;
                        stats.freed += meta.len();
                    }
                    Err(_) => stats.skipped += 1,
                }
            }
        }
        // 소켓·FIFO·장치 노드는 세지도 지우지도 않는다 — /tmp의 tmux·ssh-agent 소켓은 생성 뒤
        // 시각이 안 바뀌어 오래돼 보여도 살아 있다.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(delete: bool) -> WalkOpts {
        WalkOpts { delete, keep_newer_than: None, name_prefix: None, deadline: None }
    }

    /// 디렉터리 링크를 만든다 — Windows는 권한 없이 되는 정션, 유닉스는 심링크. 못 만들면 None.
    fn make_dir_link(link: &Path, target: &Path) -> Option<()> {
        #[cfg(windows)]
        {
            let ok = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            ok.then_some(())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).ok()
        }
    }

    fn set_age(path: &Path, days: u64) {
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(days * 86_400)).unwrap();
    }

    #[test]
    fn pccare_tools_cleanup_link_target_outside_survives() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.txt"), b"keep me").unwrap();
        fs::write(root.join("a.txt"), b"aaaa").unwrap();
        fs::write(root.join("sub").join("b.txt"), b"bb").unwrap();
        let link = root.join("link");
        let linked = make_dir_link(&link, &outside).is_some();
        if !linked {
            eprintln!("디렉터리 링크를 만들 수 없어 링크 단언은 건너뜀");
        }
        #[cfg(windows)]
        let file_linked = std::os::windows::fs::symlink_file(outside.join("precious.txt"), root.join("flink.txt")).is_ok();
        #[cfg(unix)]
        let file_linked = std::os::unix::fs::symlink(outside.join("precious.txt"), root.join("flink.txt")).is_ok();

        let mut st = WalkStats::default();
        clean_root(&root, &opts(true), &mut st).unwrap();

        assert!(root.is_dir(), "루트는 남아야 한다");
        assert!(!root.join("a.txt").exists());
        assert!(!root.join("sub").exists());
        assert_eq!(fs::read(outside.join("precious.txt")).unwrap(), b"keep me");
        if linked {
            assert!(fs::symlink_metadata(&link).is_err(), "링크 항목 자체는 지워져야 한다");
        }
        if file_linked {
            assert!(fs::symlink_metadata(root.join("flink.txt")).is_err());
        }
        assert_eq!(st.skipped, 0, "{st:?}");
    }

    #[test]
    fn pccare_tools_cleanup_keeps_recent_and_counts_old() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // 생성 시각·ctime은 되돌릴 수 없어서 "오래된" 파일을 먼저 만들고 그 뒤를 기준 시각으로 삼는다.
        // 잠깐씩 쉬는 것은 파일 시각이 타이머 틱(~16ms) 단위로 찍히는 Windows 때문이다.
        fs::write(root.join("old.log"), b"12345").unwrap();
        set_age(&root.join("old.log"), 30);
        std::thread::sleep(Duration::from_millis(100));
        let cut = Some(SystemTime::now());
        std::thread::sleep(Duration::from_millis(100));
        fs::create_dir_all(root.join("installer")).unwrap();
        fs::write(root.join("new.log"), b"1").unwrap();
        // 압축 해제본처럼 수정 시각이 오래된 새 파일 — 생성 시각/ctime 덕에 남아야 한다.
        fs::write(root.join("installer").join("running.msi"), b"1").unwrap();
        set_age(&root.join("installer").join("running.msi"), 3650);

        // 검사(세기만): 오래된 것만 세고 아무것도 지우지 않는다.
        let mut scan = WalkStats::default();
        clean_root(root, &WalkOpts { keep_newer_than: cut, ..opts(false) }, &mut scan).unwrap();
        assert_eq!((scan.files, scan.bytes), (1, 5));
        assert!(root.join("old.log").exists());

        let mut run = WalkStats::default();
        clean_root(root, &WalkOpts { keep_newer_than: cut, ..opts(true) }, &mut run).unwrap();
        assert_eq!((run.deleted, run.freed), (1, 5));
        assert!(!root.join("old.log").exists());
        assert!(root.join("new.log").exists());
        assert!(root.join("installer").join("running.msi").exists(), "수정 시각만 오래된 새 파일은 남는다");
    }

    #[cfg(unix)]
    #[test]
    fn pccare_tools_cleanup_leaves_sockets() {
        let tmp = tempfile::tempdir().unwrap();
        let sock = tmp.path().join("agent.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        fs::write(tmp.path().join("old.txt"), b"x").unwrap();
        let mut st = WalkStats::default();
        clean_root(tmp.path(), &opts(true), &mut st).unwrap();
        assert!(fs::symlink_metadata(&sock).is_ok(), "소켓은 남아야 한다");
        assert!(!tmp.path().join("old.txt").exists());
        assert_eq!((st.files, st.deleted, st.skipped), (1, 1, 0), "{st:?}");
    }

    #[test]
    fn pccare_tools_cleanup_prefix_limits_top_level() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::write(root.join("thumbcache_256.db"), b"t").unwrap();
        fs::write(root.join("iconcache_16.db"), b"i").unwrap();
        let mut st = WalkStats::default();
        clean_root(root, &WalkOpts { name_prefix: Some("thumbcache_"), ..opts(true) }, &mut st).unwrap();
        assert!(!root.join("thumbcache_256.db").exists());
        assert!(root.join("iconcache_16.db").exists());
    }

    #[test]
    fn pccare_tools_cleanup_scan_stops_at_deadline() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("x"), b"x").unwrap();
        let mut st = WalkStats::default();
        let past = Instant::now();
        clean_root(tmp.path(), &WalkOpts { deadline: Some(past), ..opts(false) }, &mut st).unwrap();
        assert!(st.timed_out);
    }
}
