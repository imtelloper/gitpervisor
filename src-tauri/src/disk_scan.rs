//! 디스크 용량 분석(TreeSize류) — DOCS/disk-usage-analyzer-design.md.
//!
//! std 스레드 풀 병렬 walk(신규 크레이트 0). 병목은 디렉터리 열거뿐이라 워커 N개(코어 수)로
//! 병렬화하고, Windows는 FindFirstFileExW(LARGE_FETCH)로 FIND_DATA를 직독한다(§win_enum).
//! 트리는 Rust arena에만 상주(폴더 65만 개 ≈ 60-80MB)하고 파일 430만 개는 저장하지
//! 않는다 — 프론트가 폴더를 펼칠 때 그 폴더 1개만 live read_dir 한다(§2.3).
//! Monitor 뮤텍스와 분리 — 몇 분짜리 스캔이 2초 폴링을 막으면 안 된다.

use std::collections::BinaryHeap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;
use crate::state::AppState;

/// arena 노드 수 상한 — 병리적 볼륨(수천만 폴더)에서 메모리로 죽지 않고 정직하게 중단한다.
const NODE_CAP: usize = 4_000_000;
/// disk_children의 파일 행 상한 — 수십만 파일 폴더 방어("외 N개"로 표기).
const FILE_ROW_CAP: usize = 1000;
/// 스캔 중 수집하는 전역 최대 파일 수 — SSD 꽉참 시나리오의 "범인 지목" 목록.
const TOP_FILES_CAP: usize = 100;
/// 진행률 Channel 송신 간격 — 워커 카운터(Atomic)를 읽기만 하므로 스캔을 방해하지 않는다.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

// ── 직렬화 타입(프론트 계약 §3.1) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanPhase {
    Idle,
    Scanning,
    Done,
    Cancelled,
    Error,
}

/// disk_scan_status 응답 + Channel 진행 메시지 공용.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub phase: ScanPhase,
    pub root: Option<String>,
    pub bytes: u64,
    /// 디스크 할당 크기 합 — Windows는 압축·스파스만 실측(그 외 논리 크기와 동일 처리,
    /// 클러스터 반올림 미반영), Unix는 st_blocks 기반 실측(§2.2).
    pub alloc: u64,
    pub files: u64,
    pub dirs: u64,
    /// 권한 거부 등으로 못 들어간 폴더 수 — UI에 정직 표기.
    pub skipped: u64,
    pub elapsed_ms: u64,
    /// Channel 마지막 메시지 판별.
    pub done: bool,
    pub error: Option<String>,
}

/// disk_children의 폴더 행 — bytes는 하위 전체 합산(스캔 캐시).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirRow {
    pub name: String,
    pub bytes: u64,
    pub alloc: u64,
    pub files: u64,
    pub dirs: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    pub name: String,
    pub bytes: u64,
    pub alloc: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// 이 폴더 합산(부모 % 계산용).
    pub bytes: u64,
    pub dirs: Vec<DirRow>,
    /// live read_dir — 스캔 시점과 어긋날 수 있다(스냅샷 도구의 본질적 한계, 설계 §7).
    pub files: Vec<FileRow>,
    pub truncated_files: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopFile {
    pub path: String,
    pub bytes: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRoot {
    pub mount: String,
    pub total: u64,
    pub available: u64,
}

/// disk_treemap의 노드 — 자식은 크기순 상위 per-level개만, 나머지 합은 other_bytes
/// ("기타" 타일), 직속 파일 합은 own_bytes("[N 파일]" 타일). 설계 §3.5.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreemapNode {
    pub name: String,
    /// 스캔 루트 기준 상대경로 — 드릴다운·탐색기 열기용.
    pub rel: String,
    pub bytes: u64,
    /// 직속 파일 합(bytes − Σ전체 자식) — 트리맵의 "[N 파일]" 리프 타일.
    pub own_bytes: u64,
    pub own_files: u64,
    /// 상위 per-level에서 잘린 나머지 자식들의 합 — "기타" 타일.
    pub other_bytes: u64,
    pub children: Vec<TreemapNode>,
}

// ── 상태 ──

/// 스캔 중 워커들이 갱신하는 전역 카운터 — 진행률 리포터가 락 없이 읽는다.
#[derive(Default)]
struct Counters {
    bytes: AtomicU64,
    alloc: AtomicU64,
    files: AtomicU64,
    dirs: AtomicU64,
    skipped: AtomicU64,
}

/// arena 노드. 자식은 항상 부모보다 뒤 인덱스에 append된다 — 역순 1패스 상향 집계의 근거.
struct DirNode {
    name: String,
    parent: u32,
    /// 스캔 중엔 직속 파일 합, aggregate() 후엔 하위 전체 합.
    bytes: u64,
    /// 디스크 할당 크기 합(§file_alloc) — bytes와 같은 규약으로 집계.
    alloc: u64,
    files: u64,
    dirs: u64,
    modified: Option<i64>,
    children: Vec<u32>,
}

struct ScanResult {
    root: PathBuf,
    /// [0] = 스캔 루트.
    nodes: Vec<DirNode>,
    /// bytes 내림차순 정렬 완료.
    top_files: Vec<TopFile>,
}

pub struct DiskScanState {
    phase: ScanPhase,
    root: Option<PathBuf>,
    started: Option<Instant>,
    /// 종료 시 확정된 소요 시간(진행 중엔 started 기준 계산).
    elapsed_ms: u64,
    counters: Arc<Counters>,
    cancel: Arc<AtomicBool>,
    result: Option<ScanResult>,
    error: Option<String>,
    /// 스캔 세대 — 취소 직후 재시작 시 옛 코디네이터/리포터가 새 스캔을 덮지 않게 한다.
    epoch: u64,
}

impl Default for DiskScanState {
    fn default() -> Self {
        Self {
            phase: ScanPhase::Idle,
            root: None,
            started: None,
            elapsed_ms: 0,
            counters: Arc::new(Counters::default()),
            cancel: Arc::new(AtomicBool::new(false)),
            result: None,
            error: None,
            epoch: 0,
        }
    }
}

impl DiskScanState {
    fn status(&self) -> ScanStatus {
        let elapsed_ms = if self.phase == ScanPhase::Scanning {
            self.started.map_or(0, |t| t.elapsed().as_millis() as u64)
        } else {
            self.elapsed_ms
        };
        ScanStatus {
            phase: self.phase,
            root: self.root.as_ref().map(|p| p.display().to_string()),
            bytes: self.counters.bytes.load(Ordering::Relaxed),
            alloc: self.counters.alloc.load(Ordering::Relaxed),
            files: self.counters.files.load(Ordering::Relaxed),
            dirs: self.counters.dirs.load(Ordering::Relaxed),
            skipped: self.counters.skipped.load(Ordering::Relaxed),
            elapsed_ms,
            done: self.phase != ScanPhase::Scanning && self.phase != ScanPhase::Idle,
            error: self.error.clone(),
        }
    }

    /// sysmon 창 Destroyed 시 — 진행 중 스캔 취소 + 결과(arena 수십 MB) 반환(설계 §2.4).
    pub fn reset(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.phase = ScanPhase::Idle;
        self.root = None;
        self.started = None;
        self.elapsed_ms = 0;
        self.result = None;
        self.error = None;
        self.epoch += 1;
    }
}

// ── 스캔 엔진 ──

struct JobQueue {
    /// LIFO 스택 — DFS에 가까운 순서로 지역성을 살린다(순서 보장은 필요 없다 — 집계뿐).
    stack: Vec<(u32, PathBuf)>,
    /// 큐에 있거나 처리 중인 잡 수 — 0이 되는 순간이 스캔 완료.
    pending: usize,
}

struct Shared {
    jobs: Mutex<JobQueue>,
    cv: Condvar,
    nodes: Mutex<Vec<DirNode>>,
    counters: Arc<Counters>,
    cancel: Arc<AtomicBool>,
    /// NODE_CAP 초과 같은 치명 오류 — 첫 기록자가 cancel도 함께 세운다.
    fatal: Mutex<Option<String>>,
}

fn to_epoch_ms(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 압축·스파스 파일의 실제 디스크 점유(`GetCompressedFileSizeW`). 실패 시 None.
#[cfg(windows)]
fn compressed_size(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Storage::FileSystem::{GetCompressedFileSizeW, INVALID_FILE_SIZE};

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut high: u32 = 0;
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    // INVALID_FILE_SIZE는 "하위 32비트가 우연히 0xFFFFFFFF"와 겹친다 — GetLastError로 구분.
    if low == INVALID_FILE_SIZE && unsafe { GetLastError() } != 0 {
        return None;
    }
    Some(((high as u64) << 32) | low as u64)
}

/// 파일의 디스크 할당 크기(§2.2 후속 — TreeSize "할당된 공간").
///
/// Windows: 압축(0x800)·스파스(0x200) 속성이 있을 때만 `GetCompressedFileSizeW` 1회 —
/// 일반 파일은 논리 크기와 같다고 보고 syscall을 아낀다(383만 파일 × 추가 syscall 방지).
/// 클러스터 반올림은 반영하지 않는다(볼륨별 클러스터 조회·per-file 핸들이 필요해 비용 대비 무가치).
/// Unix: st_blocks × 512 — 홀(스파스)과 블록 반올림이 모두 실측으로 반영된다.
#[cfg(windows)]
fn file_alloc(path: &std::path::Path, md: &std::fs::Metadata) -> u64 {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
    const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
    let logical = md.len();
    if md.file_attributes() & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE) == 0 {
        return logical;
    }
    compressed_size(path).unwrap_or(logical)
}

#[cfg(unix)]
fn file_alloc(_path: &std::path::Path, md: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    md.blocks() * 512
}

#[cfg(not(any(windows, unix)))]
fn file_alloc(_path: &std::path::Path, md: &std::fs::Metadata) -> u64 {
    md.len()
}

/// 최대 파일 Top-N min-heap(스레드 로컬 — 락 경합 0, 종료 시 병합).
type TopHeap = BinaryHeap<std::cmp::Reverse<(u64, String, i64)>>;

fn top_push(heap: &mut TopHeap, bytes: u64, path: String, modified: i64) {
    heap.push(std::cmp::Reverse((bytes, path, modified)));
    if heap.len() > TOP_FILES_CAP {
        heap.pop();
    }
}

/// Top-N 후보 사전 판정 — 경로 문자열을 만들기 **전에** 크기만으로 거른다.
/// 수백만 파일 절대다수가 여기서 걸러져 파일당 힙 할당(PathBuf+String)이 사라진다.
fn top_candidate(heap: &TopHeap, bytes: u64) -> bool {
    heap.len() < TOP_FILES_CAP
        || heap
            .peek()
            .is_some_and(|std::cmp::Reverse((floor, _, _))| bytes > *floor)
}

/// 한 디렉터리 열거 결과의 직속 파일 합계.
#[derive(Default)]
struct OwnTotals {
    bytes: u64,
    alloc: u64,
    files: u64,
}

// ── Windows 고속 열거 ──
// std read_dir도 FindFirstFileExW(FindExInfoBasic)까지는 쓰지만 FIND_FIRST_EX_LARGE_FETCH는
// "사용자 프로파일을 모르니 보수적으로" 뺀다(std/src/sys/fs/windows.rs). 볼륨 전체 스캔은
// 정확히 그 플래그가 이득인 워크로드(대형 디렉터리 배치 열거)라 직접 연다. 추가 이득:
// DirEntry/Metadata/PathBuf를 만들지 않고 WIN32_FIND_DATAW에서 바로 읽는다 — 일반 파일은
// 엔트리당 힙 할당 0(이름 문자열조차 안 만든다).
#[cfg(windows)]
mod win_enum {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_FILE_NOT_FOUND, FILETIME, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
        FIND_FIRST_EX_LARGE_FETCH, WIN32_FIND_DATAW,
    };

    pub const ATTR_DIRECTORY: u32 = 0x10;
    pub const ATTR_REPARSE_POINT: u32 = 0x400;
    pub const ATTR_SPARSE: u32 = 0x200;
    pub const ATTR_COMPRESSED: u32 = 0x800;

    /// FILETIME(1601 기준 100ns) → epoch ms. 0(미기록)은 None.
    pub fn filetime_ms(ft: &FILETIME) -> Option<i64> {
        let t = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
        (t != 0).then(|| (t as i64).saturating_sub(116_444_736_000_000_000) / 10_000)
    }

    pub fn size_of(w: &WIN32_FIND_DATAW) -> u64 {
        ((w.nFileSizeHigh as u64) << 32) | w.nFileSizeLow as u64
    }

    /// symlink·정션(name-surrogate reparse) — std `FileType::is_symlink`와 같은 판정.
    /// reparse point일 때 FIND_DATA의 dwReserved0이 reparse tag다(문서 보장).
    /// OneDrive 자리표시자 등 비-surrogate tag는 일반 파일/폴더로 취급된다(std와 동일).
    pub fn is_name_surrogate(w: &WIN32_FIND_DATAW) -> bool {
        w.dwFileAttributes & ATTR_REPARSE_POINT != 0 && w.dwReserved0 & 0x2000_0000 != 0
    }

    pub fn name_of(w: &WIN32_FIND_DATAW) -> String {
        let len = w
            .cFileName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(w.cFileName.len());
        String::from_utf16_lossy(&w.cFileName[..len])
    }

    /// 검색 패턴(wide, NUL 종결) — 드라이브 절대경로·UNC는 `\\?\`로 승격해 MAX_PATH 한계를
    /// 없앤다(std maybe_verbatim과 같은 목적 — 우리 경로는 자체 join 산물이라 정규화 불요).
    fn search_pattern(dir: &Path) -> Vec<u16> {
        const SEP: u16 = b'\\' as u16;
        let raw: Vec<u16> = dir.as_os_str().encode_wide().collect();
        let mut w: Vec<u16> = Vec::with_capacity(raw.len() + 10);
        if raw.starts_with(&[SEP, SEP, b'?' as u16, SEP]) {
            w.extend(&raw); // 이미 verbatim
        } else if raw.starts_with(&[SEP, SEP]) {
            // UNC: \\server\share → \\?\UNC\server\share
            w.extend([SEP, SEP, b'?' as u16, SEP, b'U' as u16, b'N' as u16, b'C' as u16, SEP]);
            w.extend(&raw[2..]);
        } else if raw.len() >= 2 && raw[1] == b':' as u16 {
            w.extend([SEP, SEP, b'?' as u16, SEP]);
            w.extend(&raw);
        } else {
            w.extend(&raw); // 상대경로 등 — 있는 그대로(260자 한계 감수)
        }
        if w.last() != Some(&SEP) {
            w.push(SEP);
        }
        w.push(b'*' as u16);
        w.push(0);
        w
    }

    /// 콜백 열거 — "."/".."은 거른다. 열지 못하면 Err(GetLastError) — 권한 거부 등.
    pub fn enum_dir(dir: &Path, mut f: impl FnMut(&WIN32_FIND_DATAW)) -> Result<(), u32> {
        let pat = search_pattern(dir);
        unsafe {
            let mut wfd: WIN32_FIND_DATAW = std::mem::zeroed();
            let h = FindFirstFileExW(
                pat.as_ptr(),
                FindExInfoBasic,
                &mut wfd as *mut _ as *mut _,
                FindExSearchNameMatch,
                std::ptr::null(),
                FIND_FIRST_EX_LARGE_FETCH,
            );
            if h == INVALID_HANDLE_VALUE {
                let e = GetLastError();
                // 엔트리가 하나도 없는 드라이브 루트("."/".."가 없는 유일한 경우) — 빈 성공.
                return if e == ERROR_FILE_NOT_FOUND { Ok(()) } else { Err(e) };
            }
            loop {
                let n = &wfd.cFileName;
                let dot = n[0] == b'.' as u16
                    && (n[1] == 0 || (n[1] == b'.' as u16 && n[2] == 0));
                if !dot {
                    f(&wfd);
                }
                if FindNextFileW(h, &mut wfd) == 0 {
                    break; // NO_MORE_FILES — 그 외 오류도 부분 결과로 종료(하드웨어 오류 등)
                }
            }
            FindClose(h);
        }
        Ok(())
    }
}

/// 한 디렉터리를 열거해 직속 파일 합산·하위 폴더 수집·Top-N 갱신. 열지 못하면 false(skipped).
#[cfg(windows)]
fn collect_entries(
    path: &std::path::Path,
    subdirs: &mut Vec<(String, Option<i64>)>,
    top: &mut TopHeap,
    own: &mut OwnTotals,
) -> bool {
    use win_enum::*;
    enum_dir(path, |w| {
        // symlink/정션은 재귀도 계상도 하지 않는다 — 순환·이중계상 차단(설계 §7).
        if is_name_surrogate(w) {
            return;
        }
        if w.dwFileAttributes & ATTR_DIRECTORY != 0 {
            subdirs.push((name_of(w), filetime_ms(&w.ftLastWriteTime)));
        } else {
            let len = size_of(w);
            own.bytes += len;
            own.files += 1;
            let real_alloc = w.dwFileAttributes & (ATTR_COMPRESSED | ATTR_SPARSE) != 0;
            let is_top = top_candidate(top, len);
            if real_alloc || is_top {
                // 경로가 필요한 드문 갈래(압축·스파스, Top-N 후보)만 문자열을 만든다.
                let full = path.join(name_of(w));
                own.alloc += if real_alloc {
                    compressed_size(&full).unwrap_or(len)
                } else {
                    len
                };
                if is_top {
                    let m = filetime_ms(&w.ftLastWriteTime).unwrap_or(0);
                    top_push(top, len, full.display().to_string(), m);
                }
            } else {
                own.alloc += len;
            }
        }
    })
    .is_ok()
}

/// Unix 외 공통 — std read_dir(엔트리당 stat 1회 추가, 느릴 뿐 정확).
#[cfg(not(windows))]
fn collect_entries(
    path: &std::path::Path,
    subdirs: &mut Vec<(String, Option<i64>)>,
    top: &mut TopHeap,
    own: &mut OwnTotals,
) -> bool {
    let Ok(rd) = std::fs::read_dir(path) else {
        return false;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        // symlink는 재귀도 계상도 하지 않는다 — 순환·이중계상 차단(설계 §7).
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            let modified = e.metadata().ok().and_then(|m| m.modified().ok()).map(to_epoch_ms);
            subdirs.push((e.file_name().to_string_lossy().into_owned(), modified));
        } else {
            let Ok(md) = e.metadata() else { continue };
            let len = md.len();
            own.bytes += len;
            // unix file_alloc은 경로를 쓰지 않는다(st_blocks) — PathBuf 할당 회피.
            own.alloc += file_alloc(std::path::Path::new(""), &md);
            own.files += 1;
            if top_candidate(top, len) {
                let modified = md.modified().ok().map(to_epoch_ms).unwrap_or(0);
                top_push(top, len, e.path().display().to_string(), modified);
            }
        }
    }
    true
}

/// 워커 1개 — 잡(디렉터리)을 꺼내 read_dir 1회로 파일 합산 + 하위 폴더 노드 생성·잡 등록.
fn worker(shared: &Shared) -> TopHeap {
    let mut top = TopHeap::new();
    loop {
        // 잡 획득 — cancel은 wait_timeout으로 100ms마다 재확인(별도 깨우기 경로 불필요).
        let job = {
            let mut q = shared.jobs.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if shared.cancel.load(Ordering::Relaxed) {
                    return top;
                }
                if let Some(j) = q.stack.pop() {
                    break j;
                }
                if q.pending == 0 {
                    return top;
                }
                q = shared
                    .cv
                    .wait_timeout(q, Duration::from_millis(100))
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
        };

        process_dir(shared, job, &mut top);

        let mut q = shared.jobs.lock().unwrap_or_else(|e| e.into_inner());
        q.pending -= 1;
        if q.pending == 0 {
            shared.cv.notify_all();
        }
    }
}

fn process_dir(shared: &Shared, (idx, path): (u32, PathBuf), top: &mut TopHeap) {
    let mut own = OwnTotals::default();
    let mut subdirs: Vec<(String, Option<i64>)> = Vec::new();
    if !collect_entries(&path, &mut subdirs, top, &mut own) {
        // 권한 거부(System Volume Information 등) — 세지 못한 폴더로 정직하게 집계.
        shared.counters.skipped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let OwnTotals {
        bytes: own_bytes,
        alloc: own_alloc,
        files: own_files,
    } = own;

    shared.counters.bytes.fetch_add(own_bytes, Ordering::Relaxed);
    shared.counters.alloc.fetch_add(own_alloc, Ordering::Relaxed);
    shared.counters.files.fetch_add(own_files, Ordering::Relaxed);
    shared
        .counters
        .dirs
        .fetch_add(subdirs.len() as u64, Ordering::Relaxed);

    // arena 갱신 — 폴더당 락 1회(자기 노드 확정 + 자식 batch-push).
    let child_jobs: Vec<(u32, PathBuf)> = {
        let mut nodes = shared.nodes.lock().unwrap_or_else(|e| e.into_inner());
        if nodes.len() + subdirs.len() > NODE_CAP {
            let mut fatal = shared.fatal.lock().unwrap_or_else(|e| e.into_inner());
            if fatal.is_none() {
                *fatal = Some(text_files::disk_scan_node_cap_exceeded(NODE_CAP));
            }
            shared.cancel.store(true, Ordering::Relaxed);
            return;
        }
        nodes[idx as usize].bytes = own_bytes;
        nodes[idx as usize].alloc = own_alloc;
        nodes[idx as usize].files = own_files;
        nodes[idx as usize].dirs = subdirs.len() as u64;
        let mut jobs = Vec::with_capacity(subdirs.len());
        for (name, modified) in subdirs {
            let child_idx = nodes.len() as u32;
            let child_path = path.join(&name);
            nodes.push(DirNode {
                name,
                parent: idx,
                bytes: 0,
                alloc: 0,
                files: 0,
                dirs: 0,
                modified,
                children: Vec::new(),
            });
            nodes[idx as usize].children.push(child_idx);
            jobs.push((child_idx, child_path));
        }
        jobs
    };

    if !child_jobs.is_empty() {
        let mut q = shared.jobs.lock().unwrap_or_else(|e| e.into_inner());
        q.pending += child_jobs.len();
        q.stack.extend(child_jobs);
        shared.cv.notify_all();
    }
}

/// 역순 1패스 상향 집계 — 자식 인덱스 > 부모 인덱스 불변식에 기댄다(append 순서).
fn aggregate(nodes: &mut [DirNode]) {
    for i in (1..nodes.len()).rev() {
        let (b, a, f, d, p) = {
            let n = &nodes[i];
            (n.bytes, n.alloc, n.files, n.dirs, n.parent as usize)
        };
        nodes[p].bytes += b;
        nodes[p].alloc += a;
        nodes[p].files += f;
        nodes[p].dirs += d;
    }
}

/// 스캔 워커 수 — 코어 수만큼(하한 4, 상한 32). 웜 캐시에선 커널 CPU 바운드라 코어 수가
/// 정답이고, 콜드 캐시에선 아웃스탠딩 I/O가 많을수록 NVMe 큐가 차므로 코어 수 이상도 손해가
/// 없다. (구 8 캡의 실측·교체 근거는 설계 문서 §4 벤치.)
fn default_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(4, 32)
}

/// 스캔 본체(블로킹, tauri 무관 — 테스트 대상). cancel로 중단되면 부분 결과를 돌려주고
/// 호출자가 cancel/fatal을 보고 최종 phase를 정한다.
fn run_scan(
    root: PathBuf,
    counters: Arc<Counters>,
    cancel: Arc<AtomicBool>,
) -> Result<ScanResult, String> {
    run_scan_with(root, counters, cancel, default_workers())
}

fn run_scan_with(
    root: PathBuf,
    counters: Arc<Counters>,
    cancel: Arc<AtomicBool>,
    n_workers: usize,
) -> Result<ScanResult, String> {
    // 루트 접근 검증 — 여기서 실패하면 스캔 자체가 성립하지 않는다(Error).
    std::fs::read_dir(&root).map_err(text_files::disk_scan_root_open_failed)?;
    let root_modified = std::fs::metadata(&root)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(to_epoch_ms);

    let shared = Arc::new(Shared {
        jobs: Mutex::new(JobQueue {
            stack: vec![(0, root.clone())],
            pending: 1,
        }),
        cv: Condvar::new(),
        nodes: Mutex::new(vec![DirNode {
            name: root.display().to_string(),
            parent: 0,
            bytes: 0,
            alloc: 0,
            files: 0,
            dirs: 0,
            modified: root_modified,
            children: Vec::new(),
        }]),
        counters,
        cancel,
        fatal: Mutex::new(None),
    });

    let handles: Vec<_> = (0..n_workers.max(1))
        .map(|_| {
            let s = Arc::clone(&shared);
            std::thread::spawn(move || worker(&s))
        })
        .collect();

    // Top-N 병합 — 워커별 스레드 로컬 heap을 모아 다시 상위 100개로 자른다.
    let mut merged = TopHeap::new();
    for h in handles {
        if let Ok(local) = h.join() {
            for std::cmp::Reverse((bytes, path, modified)) in local {
                top_push(&mut merged, bytes, path, modified);
            }
        }
    }

    if let Some(err) = shared
        .fatal
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
    {
        return Err(err);
    }

    let mut nodes = std::mem::take(&mut *shared.nodes.lock().unwrap_or_else(|e| e.into_inner()));
    aggregate(&mut nodes);

    let mut top_files: Vec<TopFile> = merged
        .into_iter()
        .map(|std::cmp::Reverse((bytes, path, modified))| TopFile {
            path,
            bytes,
            modified: (modified != 0).then_some(modified),
        })
        .collect();
    top_files.sort_by(|a, b| b.bytes.cmp(&a.bytes));

    Ok(ScanResult {
        root,
        nodes,
        top_files,
    })
}

// ── 커맨드 ──
// 전부 (async) — 스캔 본체는 커맨드가 아니라 전용 std::thread에서 돈다. 락은 짧게
// (상태 전이·질의만) 잡아 2초 폴링(sys_metrics)과 무관하게 유지한다.

#[tauri::command(async)]
pub fn disk_scan_start(
    state: State<'_, AppState>,
    path: String,
    on_progress: Channel<String>,
) -> Result<(), IpcError> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(IpcError::new(
            ErrorCode::Io,
            text_files::disk_scan_not_a_folder(&path),
        ));
    }

    let scan = Arc::clone(&state.disk_scan);
    let (counters, cancel, epoch) = {
        let mut s = scan.lock().unwrap_or_else(|e| e.into_inner());
        if s.phase == ScanPhase::Scanning {
            return Err(IpcError::new(
                ErrorCode::OpInProgress,
                text_files::disk_scan_already_running(),
            ));
        }
        let epoch = s.epoch + 1;
        // 이전 결과(arena)는 여기서 drop — 동시 스캔 1개, 새 스캔 = 이전 결과 폐기(설계 §2.4).
        *s = DiskScanState {
            phase: ScanPhase::Scanning,
            root: Some(root.clone()),
            started: Some(Instant::now()),
            epoch,
            ..DiskScanState::default()
        };
        (Arc::clone(&s.counters), Arc::clone(&s.cancel), epoch)
    };

    // 코디네이터 — 워커 스폰·join·집계 후 결과를 상태에 넣는다.
    let scan2 = Arc::clone(&scan);
    let started = Instant::now();
    std::thread::spawn(move || {
        let cancelled = || cancel.load(Ordering::Relaxed);
        let res = run_scan(root, Arc::clone(&counters), Arc::clone(&cancel));
        let mut s = scan2.lock().unwrap_or_else(|e| e.into_inner());
        // 그 사이 reset(창 닫힘)·새 스캔이 끼어들었으면 이 결과는 폐기한다.
        if s.epoch != epoch {
            return;
        }
        s.elapsed_ms = started.elapsed().as_millis() as u64;
        match res {
            Err(e) => {
                s.phase = ScanPhase::Error;
                s.error = Some(e);
            }
            Ok(_) if cancelled() => {
                s.phase = ScanPhase::Cancelled;
            }
            Ok(result) => {
                s.phase = ScanPhase::Done;
                s.result = Some(result);
            }
        }
    });

    // 진행률 리포터 — 250ms마다 카운터 스냅샷을 채널로. 종결(phase 전이·epoch 교체) 시
    // done=true 최종 메시지 1건을 보내고 끝난다. 스캔마다 **새 Channel**(재사용 금지 함정).
    std::thread::spawn(move || loop {
        std::thread::sleep(PROGRESS_INTERVAL);
        let (status, ended) = {
            let s = scan.lock().unwrap_or_else(|e| e.into_inner());
            let ended = s.epoch != epoch || s.phase != ScanPhase::Scanning;
            let mut status = s.status();
            if s.epoch != epoch {
                // 새 세대가 시작됐다 — 이 채널의 구독자에겐 "끝났다"만 알린다.
                status.done = true;
            }
            (status, ended)
        };
        let _ = on_progress.send(serde_json::to_string(&status).unwrap_or_default());
        if ended {
            break;
        }
    });

    Ok(())
}

#[tauri::command(async)]
pub fn disk_scan_cancel(state: State<'_, AppState>) {
    let s = state.disk_scan.lock().unwrap_or_else(|e| e.into_inner());
    if s.phase == ScanPhase::Scanning {
        s.cancel.store(true, Ordering::Relaxed);
    }
}

/// 창 재오픈 시 재동기화 — 진행 중이면 진행값, 완료면 결과 요약.
#[tauri::command(async)]
pub fn disk_scan_status(state: State<'_, AppState>) -> ScanStatus {
    state
        .disk_scan
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status()
}

/// rel 경로("a/b/c")로 arena 노드 인덱스를 찾는다 — 이름 매칭이라 트리 탈출이 본질적으로 없다.
fn find_node(nodes: &[DirNode], rel: &str) -> Result<usize, IpcError> {
    let mut idx = 0usize;
    for comp in rel.split(['/', '\\']).filter(|c| !c.is_empty()) {
        idx = nodes[idx]
            .children
            .iter()
            .map(|&c| c as usize)
            .find(|&c| nodes[c].name == comp)
            .ok_or_else(|| {
                IpcError::new(ErrorCode::Io, text_files::disk_scan_folder_not_in_result())
            })?;
    }
    Ok(idx)
}

/// 스캔 결과에서 폴더 1개의 자식 목록. rel=""는 스캔 루트. 폴더 행은 캐시(합산 완료),
/// 파일 행은 live read_dir(락 밖 — 폴더 1개라 ms급).
#[tauri::command(async)]
pub fn disk_children(state: State<'_, AppState>, rel: String) -> Result<DirListing, IpcError> {
    // 캐시 트리 탐색은 이름 매칭이라 본질적으로 탈출이 없지만, 파일 read_dir이
    // root.join(rel)을 쓰므로 ".." 탈출을 명시적으로 막는다.
    if rel.split(['/', '\\']).any(|c| c == "..") {
        return Err(IpcError::new(ErrorCode::Io, text_files::invalid_path()));
    }

    let (abs, bytes, mut dirs) = {
        let s = state.disk_scan.lock().unwrap_or_else(|e| e.into_inner());
        let result = match (&s.phase, &s.result) {
            (ScanPhase::Done, Some(r)) => r,
            _ => {
                return Err(IpcError::new(
                    ErrorCode::Io,
                    text_files::disk_scan_no_completed_scan(),
                ))
            }
        };
        let idx = find_node(&result.nodes, &rel)?;
        let node = &result.nodes[idx];
        let dirs: Vec<DirRow> = node
            .children
            .iter()
            .map(|&c| {
                let n = &result.nodes[c as usize];
                DirRow {
                    name: n.name.clone(),
                    bytes: n.bytes,
                    alloc: n.alloc,
                    files: n.files,
                    dirs: n.dirs,
                    modified: n.modified,
                }
            })
            .collect();
        (result.root.join(&rel), node.bytes, dirs)
    };
    dirs.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));

    // 파일 행 — 락 밖 live read_dir. 스캔 캐시와 시점이 어긋날 수 있다(설계 §2.3 수용).
    let mut files: Vec<FileRow> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&abs) {
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() || ft.is_symlink() {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            files.push(FileRow {
                name: e.file_name().to_string_lossy().into_owned(),
                bytes: md.len(),
                alloc: file_alloc(&e.path(), &md),
                modified: md.modified().ok().map(to_epoch_ms),
            });
        }
    }
    files.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    let truncated_files = files.len().saturating_sub(FILE_ROW_CAP) as u32;
    files.truncate(FILE_ROW_CAP);

    Ok(DirListing {
        bytes,
        dirs,
        files,
        truncated_files,
    })
}

/// 스캔 전체에서 가장 큰 파일 Top-N(스캔 중 heap 수집, 내림차순 정렬 완료).
#[tauri::command(async)]
pub fn disk_top_files(state: State<'_, AppState>, limit: u32) -> Result<Vec<TopFile>, IpcError> {
    let s = state.disk_scan.lock().unwrap_or_else(|e| e.into_inner());
    match (&s.phase, &s.result) {
        (ScanPhase::Done, Some(r)) => {
            Ok(r.top_files.iter().take(limit as usize).cloned().collect())
        }
        _ => Err(IpcError::new(
            ErrorCode::Io,
            text_files::disk_scan_no_completed_scan(),
        )),
    }
}

/// 트리맵 상한 — 렌더 타일 수·페이로드를 함께 제한한다(설계 §3.5).
const TREEMAP_MAX_DEPTH: u32 = 4;
const TREEMAP_PER_LEVEL: usize = 24;
const TREEMAP_NODE_BUDGET: usize = 1500;

/// 트리맵 서브트리 구성 — 레벨당 크기순 상위 TREEMAP_PER_LEVEL개 + min_bytes(루트 대비
/// 0.05%) 미만·예산 초과분은 other_bytes("기타" 타일)로 접는다. own_bytes/files는
/// 직속 파일 몫(bytes − Σ전체 자식) — "[N 파일]" 리프 타일.
fn build_treemap(
    nodes: &[DirNode],
    idx: usize,
    rel: &str,
    depth: u32,
    min_bytes: u64,
    budget: &mut usize,
) -> TreemapNode {
    let n = &nodes[idx];
    let child_sum_bytes: u64 = n.children.iter().map(|&c| nodes[c as usize].bytes).sum();
    let child_sum_files: u64 = n.children.iter().map(|&c| nodes[c as usize].files).sum();

    let mut kids: Vec<u32> = n.children.clone();
    kids.sort_by(|&a, &b| nodes[b as usize].bytes.cmp(&nodes[a as usize].bytes));
    let mut children = Vec::new();
    let mut other_bytes = 0u64;
    for (i, &c) in kids.iter().enumerate() {
        let cn = &nodes[c as usize];
        let keep = depth > 0 && i < TREEMAP_PER_LEVEL && cn.bytes >= min_bytes && *budget > 0;
        if keep {
            *budget -= 1;
            let crel = if rel.is_empty() {
                cn.name.clone()
            } else {
                format!("{rel}/{}", cn.name)
            };
            children.push(build_treemap(
                nodes,
                c as usize,
                &crel,
                depth - 1,
                min_bytes,
                budget,
            ));
        } else {
            other_bytes += cn.bytes;
        }
    }
    TreemapNode {
        name: n.name.clone(),
        rel: rel.to_string(),
        bytes: n.bytes,
        own_bytes: n.bytes.saturating_sub(child_sum_bytes),
        own_files: n.files.saturating_sub(child_sum_files),
        other_bytes,
        children,
    }
}

/// 트리맵 데이터 — rel 하위를 depth 레벨까지, 타일 예산 안에서 잘라 보낸다(설계 §3.5).
#[tauri::command(async)]
pub fn disk_treemap(
    state: State<'_, AppState>,
    rel: String,
    depth: u32,
) -> Result<TreemapNode, IpcError> {
    if rel.split(['/', '\\']).any(|c| c == "..") {
        return Err(IpcError::new(ErrorCode::Io, text_files::invalid_path()));
    }
    let s = state.disk_scan.lock().unwrap_or_else(|e| e.into_inner());
    let result = match (&s.phase, &s.result) {
        (ScanPhase::Done, Some(r)) => r,
        _ => {
            return Err(IpcError::new(
                ErrorCode::Io,
                text_files::disk_scan_no_completed_scan(),
            ))
        }
    };
    let idx = find_node(&result.nodes, &rel)?;
    let min_bytes = result.nodes[idx].bytes / 2000; // 0.05% 미만은 보이지도 않는다
    let mut budget = TREEMAP_NODE_BUDGET;
    Ok(build_treemap(
        &result.nodes,
        idx,
        &rel,
        depth.clamp(1, TREEMAP_MAX_DEPTH),
        min_bytes,
        &mut budget,
    ))
}

/// 스캔 대상 후보 볼륨 목록 — 클릭 시 1회라 Monitor 캐시와 별도로 직접 열거한다.
#[tauri::command(async)]
pub fn disk_roots() -> Vec<DiskRoot> {
    sysinfo::Disks::new_with_refreshed_list()
        .list()
        .iter()
        .filter(|d| d.total_space() > 0)
        .map(|d| DiskRoot {
            mount: d.mount_point().display().to_string(),
            total: d.total_space(),
            available: d.available_space(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn scan(root: &Path) -> ScanResult {
        run_scan(
            root.to_path_buf(),
            Arc::new(Counters::default()),
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap()
    }

    fn write(path: &Path, len: usize) {
        std::fs::write(path, vec![0u8; len]).unwrap();
    }

    /// 합산 정확성 — 중첩 폴더의 bytes/files/dirs가 재귀 합과 일치해야 한다.
    #[test]
    fn scan_aggregates_nested_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.bin"), 100);
        std::fs::create_dir_all(root.join("sub/inner")).unwrap();
        write(&root.join("sub/b.bin"), 200);
        write(&root.join("sub/inner/c.bin"), 300);

        let r = scan(root);
        let top = &r.nodes[0];
        assert_eq!(top.bytes, 600);
        assert_eq!(top.files, 3);
        assert_eq!(top.dirs, 2);

        // sub 노드: 하위 전체 합산(200+300).
        let sub_idx = top.children[0] as usize;
        let sub = &r.nodes[sub_idx];
        assert_eq!(sub.name, "sub");
        assert_eq!(sub.bytes, 500);
        assert_eq!(sub.files, 2);
        assert_eq!(sub.dirs, 1);
    }

    /// Top 파일 수집 — 전역 최대 파일이 내림차순으로 나와야 한다.
    #[test]
    fn scan_collects_top_files_desc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("d")).unwrap();
        write(&root.join("small.bin"), 10);
        write(&root.join("d/big.bin"), 500);
        write(&root.join("mid.bin"), 100);

        let r = scan(root);
        let sizes: Vec<u64> = r.top_files.iter().map(|f| f.bytes).collect();
        assert_eq!(sizes, vec![500, 100, 10]);
        assert!(r.top_files[0].path.ends_with("big.bin"));
    }

    /// symlink는 재귀도 계상도 하지 않는다 — 순환 링크가 있어도 스캔이 끝나야 한다.
    #[cfg(unix)]
    #[test]
    fn scan_skips_symlinks_and_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.bin"), 100);
        // 자기 부모를 가리키는 순환 링크 — 따라가면 무한 재귀.
        std::os::unix::fs::symlink(root, root.join("loop")).unwrap();

        let r = scan(root);
        assert_eq!(r.nodes[0].bytes, 100);
        assert_eq!(r.nodes[0].files, 1);
        assert_eq!(r.nodes[0].dirs, 0, "symlink 디렉터리를 폴더로 세면 안 된다");
    }

    /// 취소 — cancel 플래그가 서 있으면 워커가 즉시 물러나고 run_scan이 (부분 결과로) 반환된다.
    #[test]
    fn scan_cancel_returns_promptly() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..50 {
            let d = root.join(format!("d{i}"));
            std::fs::create_dir(&d).unwrap();
            write(&d.join("f.bin"), 10);
        }
        let cancel = Arc::new(AtomicBool::new(true)); // 시작 전부터 취소
        let started = Instant::now();
        let r = run_scan(root.to_path_buf(), Arc::new(Counters::default()), cancel);
        assert!(r.is_ok());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// 할당 크기 집계 — 일반 파일에서 alloc은 논리 크기 이상(Unix 블록 반올림)이고,
    /// 부모로 자식 alloc이 합산돼야 한다. (압축/스파스 실측은 플랫폼·볼륨 의존이라 여기선
    /// "합산 계약"만 고정한다 — Windows 일반 파일은 alloc == bytes.)
    #[test]
    fn scan_aggregates_alloc() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.bin"), 100 * 1024);
        std::fs::create_dir(root.join("sub")).unwrap();
        write(&root.join("sub/b.bin"), 200 * 1024);

        let r = scan(root);
        let top = &r.nodes[0];
        let sub = &r.nodes[top.children[0] as usize];
        assert!(sub.alloc >= 200 * 1024, "sub alloc={} < 논리 크기", sub.alloc);
        // 부모 = 직속(a.bin) + 자식(sub) 합 — file_alloc과 같은 규약으로 검산.
        let a_md = std::fs::metadata(root.join("a.bin")).unwrap();
        let a_alloc = file_alloc(&root.join("a.bin"), &a_md);
        assert_eq!(top.alloc, a_alloc + sub.alloc);
        #[cfg(windows)]
        {
            // 임시 폴더가 압축 볼륨이 아닌 한 일반 파일은 alloc == bytes.
            use std::os::windows::fs::MetadataExt;
            let compressed =
                std::fs::metadata(root.join("a.bin")).unwrap().file_attributes() & 0x800 != 0;
            if !compressed {
                assert_eq!(top.alloc, top.bytes);
            }
        }
    }

    /// 트리맵 계약 — own_bytes(직속 파일 몫)·자식 크기순·rel 경로·depth 절단.
    #[test]
    fn treemap_shape_and_own_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("a.bin"), 100);
        std::fs::create_dir_all(root.join("big/inner")).unwrap();
        write(&root.join("big/b.bin"), 500);
        write(&root.join("big/inner/c.bin"), 300);
        std::fs::create_dir(root.join("small")).unwrap();
        write(&root.join("small/d.bin"), 200);

        let r = scan(root);
        let mut budget = TREEMAP_NODE_BUDGET;
        let tm = build_treemap(&r.nodes, 0, "", 3, 0, &mut budget);

        assert_eq!(tm.bytes, 1100);
        assert_eq!(tm.own_bytes, 100, "루트 직속 파일 몫은 a.bin뿐");
        assert_eq!(tm.own_files, 1);
        assert_eq!(tm.other_bytes, 0, "예산·min_bytes 안이면 잘리는 자식 없음");
        // 자식은 크기 내림차순: big(800) → small(200).
        let names: Vec<&str> = tm.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["big", "small"]);
        let big = &tm.children[0];
        assert_eq!(big.rel, "big");
        assert_eq!(big.own_bytes, 500);
        assert_eq!(big.children[0].rel, "big/inner");
        assert_eq!(big.children[0].own_bytes, 300);

        // depth=1이면 자식의 자식은 접힌다(other_bytes로).
        let mut budget = TREEMAP_NODE_BUDGET;
        let shallow = build_treemap(&r.nodes, 0, "", 1, 0, &mut budget);
        let big1 = &shallow.children[0];
        assert!(big1.children.is_empty());
        assert_eq!(big1.other_bytes, 300, "inner(300)가 기타로 접혀야 한다");
    }

    /// 수동 벤치(기본 무시) — 실기 볼륨을 스캔해 시간·규모를 출력한다. 예:
    /// `GP_BENCH_ROOT='C:\' GP_BENCH_WORKERS=24 cargo test --release bench_scan -- --ignored --nocapture`
    #[test]
    #[ignore = "실기 볼륨 수동 벤치"]
    fn bench_scan() {
        let root = std::env::var("GP_BENCH_ROOT").unwrap_or_else(|_| "C:\\".into());
        let workers = std::env::var("GP_BENCH_WORKERS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(default_workers);
        let counters = Arc::new(Counters::default());
        let t = Instant::now();
        let r = run_scan_with(
            PathBuf::from(&root),
            Arc::clone(&counters),
            Arc::new(AtomicBool::new(false)),
            workers,
        )
        .unwrap();
        println!(
            "workers={workers} elapsed={:.2}s files={} dirs={} bytes={:.1}GB alloc={:.1}GB skipped={}",
            t.elapsed().as_secs_f64(),
            counters.files.load(Ordering::Relaxed),
            r.nodes.len(),
            counters.bytes.load(Ordering::Relaxed) as f64 / 1e9,
            counters.alloc.load(Ordering::Relaxed) as f64 / 1e9,
            counters.skipped.load(Ordering::Relaxed),
        );
    }

    /// 역순 집계 불변식 — 자식 인덱스가 항상 부모보다 커야 역순 1패스가 성립한다.
    #[test]
    fn arena_children_always_after_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        std::fs::create_dir_all(root.join("x/y")).unwrap();
        let r = scan(root);
        for (i, n) in r.nodes.iter().enumerate().skip(1) {
            assert!((n.parent as usize) < i, "노드 {i}의 부모 {}가 뒤에 있다", n.parent);
        }
    }
}
