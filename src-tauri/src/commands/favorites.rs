//! 즐겨찾기 폴더 (태스크 66) — 스크린샷·다운로드 폴더를 앱 안에서 바로 훑어본다.
//!
//! 설계: `DOCS/task/66-favorite-folders-window.md`.
//!
//! **이 파일의 커맨드만 절대경로를 받는다.** 나머지 파일 커맨드(`tree.rs`·`diff.rs`)는 전부
//! `project_id` + 레포 상대경로라 "어디까지 읽어도 되는가"가 프로젝트 목록으로 이미 정해져 있다.
//! 여기는 그 울타리가 없으므로 스스로 정한다 — 답은 `Settings.favorite_folders` 이고,
//! **사용자가 명시적으로 등록한 폴더의 하위만** 허용한다(`allowed`). 그 판정은 반드시
//! canonicalize 뒤에 한다: `..` 와 심볼릭/정션 링크로 루트 밖을 가리키는 경로가 문자열 비교만으로는
//! 통과하기 때문이다.
//!
//! 썸네일이 필수인 이유는 이 앱에 asset protocol 이 없다는 것이다(`tauri.conf.json` 의 csp —
//! `img-src 'self' data: blob:`). 이미지는 base64 로 IPC 를 타므로, 스크린샷 폴더의 원본
//! 수백 장을 그대로 보내면 창이 그 자리에서 죽는다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::error::{ErrorCode, IpcError};
use crate::git::types::FavoriteFolder;
use crate::state::AppState;

/// 라이트박스 원본 한도 — `read_file_base64`(diff.rs)와 같은 이유·같은 값이다.
const MAX_READ_BYTES: u64 = 25 * 1024 * 1024;

/// 썸네일 한 변으로 허용하는 값. **셋만 받는다** — 프론트의 그리드 S/M/L 이고, 임의의 수를
/// 받으면 캐시 디렉터리가 크기마다 한 벌씩 불어난다.
const EDGES: [u32; 3] = [128, 192, 320];

/// 썸네일 디코드 한도 — 헤더만 부풀린 파일 하나가 수 GB 를 할당하게 두지 않는다.
/// 8K 스크린샷(7680×4320 RGBA ≈ 127MiB)은 넉넉히 통과한다. `MAX_DECODE_ALLOC` 은 **입력 파일
/// 크기** 상한도 겸한다 — `Limits` 는 디코더를 만든 뒤에야 걸리는데 JPEG 디코더는 만들면서 파일
/// 전체를 메모리로 읽기 때문이다(`decode_thumb`).
const MAX_DECODE_EDGE: u32 = 16384;
const MAX_DECODE_ALLOC: u64 = 256 * 1024 * 1024;

/// 프로세스 전체의 동시 디코드 상한. 프론트 큐는 **창마다** 8개라 창을 여럿 띄우면 곱해진다 —
/// 디코드 하나가 수백 MiB(픽셀 버퍼 `MAX_DECODE_ALLOC` 에 JPEG 는 입력 전체까지)를 쥘 수 있으므로
/// 여기서 끊는다.
static DECODE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

/// 이보다 오래 다시 기록되지 않은 썸네일은 거둔다(`prune_thumb_cache`).
const THUMB_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// 기록 도중 죽어 남은 임시 파일 — 쓰기는 수 ms 라 한 시간이면 확실히 고아다.
const TMP_MAX_AGE: Duration = Duration::from_secs(60 * 60);

// ---- 게이트 -------------------------------------------------------------------------

/// 주어진 절대경로가 즐겨찾기 루트 **안**인지 확인하고, canonical 경로를 돌려준다.
///
/// 아래 커맨드 넷은 전부 첫 줄에서 이것을 부른다. 하나라도 빠뜨리면 그 커맨드가 파일시스템
/// 전체를 읽는 통로가 된다 — 프론트를 믿고 검사를 생략하지 마라.
fn allowed(state: &State<'_, AppState>, path: &str) -> Result<PathBuf, IpcError> {
    let roots: Vec<String> = state
        .settings
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .favorite_folders
        .iter()
        .map(|f| f.path.clone())
        .collect();
    contained(Path::new(path), &roots)
}

/// `allowed` 의 판정 본체 — `State` 없이 테스트할 수 있게 떼어 냈다.
///
/// **양쪽 다 `std::fs::canonicalize` 로 푼다(`dunce` 가 아니다).** Windows 에서 std 판은 늘
/// `\\?\C:\…`(VerbatimDisk)를 돌려주는데 `dunce` 는 그 접두를 260자 이하일 때만 벗긴다. 그러면
/// 짧은 루트는 `C:\…`(Disk), 깊은 하위 파일은 `\\?\C:\…` 로 갈려 `starts_with` 가 첫 성분(접두)부터
/// 어긋나고, 루트 안의 정당한 파일이 거부된다. 같은 함수로 풀면 접두 종류도 디스크상 대소문자도
/// 같아진다. 비교는 성분 단위라 `<root>-2` 같은 형제 폴더가 문자열 접두로 새지 않는다.
///
/// 돌려주는 값만 `dunce::simplified` 로 벗긴다 — 짧은 경로는 예전과 같은 모양이라 썸네일 캐시
/// 키가 바뀌지 않는다.
fn contained(target: &Path, roots: &[String]) -> Result<PathBuf, IpcError> {
    let target = std::fs::canonicalize(target)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, format!("경로를 찾을 수 없습니다: {e}")))?;
    for r in roots {
        // 루트도 canonicalize 한다 — 등록된 문자열이 심링크나 8.3 단축 경로일 수 있다.
        if let Ok(root) = std::fs::canonicalize(r) {
            if target.starts_with(&root) {
                return Ok(dunce::simplified(&target).to_path_buf());
            }
        }
    }
    Err(IpcError::new(
        ErrorCode::Io,
        "즐겨찾기에 등록되지 않은 폴더입니다",
    ))
}

// ---- 목록 ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
    /// 확장자로 가른 종류 — 프론트가 아이콘·썸네일 대상·라이트박스 순서를 이걸로 정한다.
    pub kind: &'static str,
}

fn kind_of(name: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "dir";
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => "image",
        "mp4" | "mov" | "webm" | "mkv" | "avi" => "video",
        _ => "other",
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 한 폴더의 항목을 나열한다. 정렬·필터는 프론트가 한다(보기 설정이 거기 있다).
///
/// 숨김 파일은 제외한다 — 이 창의 목적은 "방금 찍은 스크린샷 찾기"이지 파일 관리가 아니다.
#[tauri::command(async)]
pub fn fav_list(state: State<'_, AppState>, path: String) -> Result<Vec<FavEntry>, IpcError> {
    let dir = allowed(&state, &path)?;
    let rd = std::fs::read_dir(&dir)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("폴더를 읽지 못했습니다: {e}")))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || is_hidden(&entry) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let is_dir = meta.is_dir();
        out.push(FavEntry {
            kind: kind_of(&name, is_dir),
            name,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            mtime_ms: mtime_ms(&meta),
        });
    }
    Ok(out)
}

#[cfg(windows)]
fn is_hidden(entry: &std::fs::DirEntry) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    entry
        .metadata()
        .map(|m| m.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_hidden(_entry: &std::fs::DirEntry) -> bool {
    false // 유닉스의 숨김은 점 파일뿐이고 그건 호출부가 이미 걸렀다
}

// ---- 썸네일 -------------------------------------------------------------------------

/// 축소본을 만들어 data URL(`image/jpeg`)로 돌려준다. 같은 (경로·mtime·크기·edge) 조합은
/// 디스크 캐시에서 즉시 나온다 — 스크린샷 폴더를 다시 열 때 디코딩을 반복하지 않는다.
///
/// 디코드는 async 워커가 아니라 blocking 풀에서, 동시에 `DECODE_SLOTS` 개까지만 돈다 —
/// 수백 ms 짜리 CPU 작업이 다른 IPC 를 막지 않게. 캐시 히트는 슬롯을 기다리지 않는다.
///
/// ponytail: 캐시는 나이로만 거둔다 — 30일 넘게 다시 기록되지 않은 항목을 프로세스당 첫 호출 때
/// 지운다(`prune_thumb_cache`). 항목당 수 KB 라 당장은 이걸로 충분하다. 한 달 안에 수만 장을 훑어
/// 용량이 문제가 되면 총량 상한 + 오래된 순 삭제(LRU)로 올린다.
#[tauri::command]
pub async fn fav_thumb(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    edge: u32,
) -> Result<String, IpcError> {
    if !EDGES.contains(&edge) {
        return Err(IpcError::new(
            ErrorCode::Io,
            "지원하지 않는 썸네일 크기입니다",
        ));
    }
    let file = allowed(&state, &path)?;
    let meta = std::fs::metadata(&file)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, format!("파일을 읽지 못했습니다: {e}")))?;

    let mut h = Sha256::new();
    h.update(file.to_string_lossy().as_bytes());
    h.update(format!("|{}|{}|{edge}", mtime_ms(&meta), meta.len()).as_bytes());
    let key = format!("{:x}", h.finalize());

    let thumbs = app.path().app_cache_dir().ok().map(|d| d.join("thumbs"));
    static PRUNE: std::sync::Once = std::sync::Once::new();
    if let Some(dir) = &thumbs {
        // 기다리지 않는다 — 치우기가 첫 썸네일을 늦출 이유가 없다.
        PRUNE.call_once(|| {
            let dir = dir.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let n = prune_thumb_cache(&dir, SystemTime::now());
                if n > 0 {
                    log::info!("썸네일 캐시 {n}개를 정리했습니다");
                }
            });
        });
    }
    let cache = thumbs.map(|d| d.join(format!("{key}.jpg")));
    if let Some(p) = &cache {
        if let Ok(bytes) = std::fs::read(p) {
            return Ok(data_url("image/jpeg", &bytes));
        }
    }

    let buf = in_decode_slot(move || decode_thumb(&file, edge)).await??;
    // 캐시 기록 실패는 치명적이지 않다 — 다음번에 다시 만들 뿐이다. 수 KB 라 위의 캐시 읽기처럼
    // 여기서 바로 쓴다(슬롯을 쥘 이유가 없다).
    if let Some(p) = &cache {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = write_atomic(p, &buf);
    }
    Ok(data_url("image/jpeg", &buf))
}

/// `work` 를 디코드 슬롯 하나를 쥔 채 blocking 풀에서 돌린다.
///
/// 슬롯은 blocking 작업 안으로 옮겨 쥔다 — 호출 쪽 future 가 먼저 사라져도 작업이 끝날 때까지
/// 상한이 지켜진다. (`let _ = acquire()` 로 받으면 그 자리에서 놓아 상한이 사라진다.)
async fn in_decode_slot<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, IpcError> {
    // 세마포어를 닫지 않으므로 acquire 는 실패하지 않는다.
    let permit = DECODE_SLOTS
        .acquire()
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("썸네일 대기 실패: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("썸네일 작업 실패: {e}")))
}

/// 파일 하나를 `edge` 안에 들어가게 줄여 JPEG q80 바이트로 만든다(blocking — 호출부가 풀에서 돌린다).
///
/// 디코더는 **내용으로** 고른다(`with_guessed_format`) — 확장자만 믿으면 `.png` 로 저장된 JPEG 가
/// 열리지 않는다. 한도(파일 크기·치수·할당)는 디코드 **전에** 걸고, 걸리면 일반 디코드 실패와 다른
/// 문장으로 알린다.
fn decode_thumb(file: &Path, edge: u32) -> Result<Vec<u8>, IpcError> {
    let open_err =
        |e: String| IpcError::new(ErrorCode::Io, format!("이미지를 열지 못했습니다: {e}"));
    let too_big = |what: String| {
        IpcError::new(
            ErrorCode::Io,
            format!("이미지가 너무 큽니다 ({what}) — 기본 앱으로 열어 보세요"),
        )
    };
    // 입력 크기는 `Limits` 가 못 막는다 — image 0.25 는 `decode()` 에서 디코더를 먼저 만들고 그 뒤에
    // 한도를 거는데, JPEG 디코더는 생성자에서 파일 전체를 `read_to_end` 한다. 내용 스니핑이라
    // 확장자와 무관하게 FF D8 FF 로 시작하면 전부 그 길을 탄다.
    let len = std::fs::metadata(file)
        .map_err(|e| open_err(e.to_string()))?
        .len();
    if len > MAX_DECODE_ALLOC {
        return Err(too_big(format!("파일 {} MiB", len >> 20)));
    }
    let mut reader = image::ImageReader::open(file)
        .and_then(|r| r.with_guessed_format())
        .map_err(|e| open_err(e.to_string()))?;
    // `Limits` 는 non_exhaustive — 기본값에서 필드만 바꾼다.
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_EDGE);
    limits.max_image_height = Some(MAX_DECODE_EDGE);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let img = reader
        .decode()
        .map_err(|e| match e {
            image::ImageError::Limits(l) => too_big(l.to_string()),
            e => open_err(e.to_string()),
        })?
        .thumbnail(edge, edge);
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut std::io::Cursor::new(&mut buf), 80)
        .encode_image(&img)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("썸네일 인코딩 실패: {e}")))?;
    Ok(buf)
}

/// `path` 를 원자적으로 쓴다 — 같은 폴더의 고유 임시 파일에 쓰고 rename 한다.
///
/// 제자리 `fs::write` 는 도중에 죽으면 잘린 `<key>.jpg` 를 남기고, 키가 원본 mtime 이라 원본이
/// 바뀌기 전까지 캐시 히트가 그 깨진 바이트를 계속 내준다. 임시 이름의 pid·순번은 같은 키를
/// 동시에 만드는 두 호출(두 창, 같은 identifier 로 뜬 두 프로세스)이 서로를 밟지 않게 한다.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let r = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if r.is_err() {
        // 대상은 건드리지 않는다 — 다른 쪽이 먼저 확정했으면 그걸로 충분하다.
        let _ = std::fs::remove_file(&tmp);
    }
    r
}

/// 썸네일 캐시 폴더를 나이로 거두고 지운 개수를 돌려준다.
///
/// - `*.tmp` 가 `TMP_MAX_AGE` 보다 오래됐으면 — `write_atomic` 도중 죽은 고아다.
/// - `*.jpg` 가 `THUMB_MAX_AGE` 보다 오래 기록되지 않았으면. 캐시 히트는 mtime 을 건드리지 않아
///   자주 보는 썸네일도 한 달에 한 번은 다시 만들어진다 — 디코드 한 번 값이라 싸다.
///
/// 그 밖의 파일과 미래 mtime(시계 되감김 — 나이를 모른다)은 남긴다.
fn prune_thumb_cache(dir: &Path, now: SystemTime) -> usize {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for entry in rd.flatten() {
        let path = entry.path();
        let max_age = match path.extension().and_then(|e| e.to_str()) {
            Some("tmp") => TMP_MAX_AGE,
            Some("jpg") => THUMB_MAX_AGE,
            _ => continue,
        };
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if now.duration_since(mtime).is_ok_and(|age| age > max_age)
            && std::fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", B64.encode(bytes))
}

// ---- 원본 읽기 ----------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavBytes {
    pub mime: String,
    pub base64: String,
}

/// 라이트박스가 쓰는 원본. 썸네일과 달리 파일 그대로이므로 한도를 건다.
#[tauri::command(async)]
pub fn fav_read(state: State<'_, AppState>, path: String) -> Result<FavBytes, IpcError> {
    let file = allowed(&state, &path)?;
    let meta = std::fs::metadata(&file)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, format!("파일을 읽지 못했습니다: {e}")))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            "파일이 너무 큽니다 (25MB 초과) — 기본 앱으로 열어 보세요",
        ));
    }
    let bytes = std::fs::read(&file)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일을 읽지 못했습니다: {e}")))?;
    Ok(FavBytes {
        mime: mime_of(&file).to_string(),
        base64: B64.encode(&bytes),
    })
}

fn mime_of(p: &Path) -> &'static str {
    match p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

// ---- OS 로 넘기기 -------------------------------------------------------------------

/// 기본 앱으로 열거나(`default`) 탐색기에서 위치를 보여준다(`reveal`).
///
/// 폴더의 `default` 는 **그 폴더 자체**를 탐색기로 연다(`open_explorer`) — 창 툴바의 "탐색기에서
/// 이 폴더 열기"가 이것이다. `reveal` 은 부모를 열고 항목을 선택하므로 폴더에 쓰면 한 단계 위가
/// 열린다. 파일의 `default` 만 `run_file` 로 간다(리눅스 `run_file` 은 먼저 직접 exec 를 시도하므로
/// 폴더를 넘기면 안 된다).
///
/// **`open.rs` 의 것을 그대로 쓴다.** 새로 `Command::new("explorer")` 를 부르면 안 된다 —
/// 거기엔 `spawn_launcher` 의 systemd-run 위임과 좀비 회수가 들어 있고, 그게 없어서
/// 2026-08-01 에 프로세스가 387개까지 쌓여 앱이 통째로 SIGKILL 당했다(CLAUDE.md).
#[tauri::command(async)]
pub fn fav_open(state: State<'_, AppState>, path: String, how: String) -> Result<(), IpcError> {
    let p = allowed(&state, &path)?;
    match launch_for(&how, p.is_dir()) {
        Launch::Reveal => super::open::reveal(&p),
        Launch::Explorer => super::open::open_explorer(&p),
        Launch::Run => super::open::run_file(&p),
    }
}

/// 즐겨찾기 폴더 안의 항목을 **휴지통으로 보낸다**(영구 삭제가 아니다).
///
/// 미리보기 패널(FolderPeek)의 삭제는 확인창 없이 한 번에 나가는 동선이다 — 그래야 "스크린샷
/// 찍고 바로 정리"가 성립한다. 그 대가로 **되돌릴 수 있어야 한다**: 오발 한 번에 스크린샷이
/// 영영 사라지면 안 되므로 `std::fs::remove_file` 이 아니라 OS 휴지통으로 보낸다
/// (Windows 휴지통 / macOS 휴지통 / freedesktop Trash — `trash` 크레이트가 세 경로를 덮는다).
///
/// 허용 루트 검사는 다른 `fav_*` 와 **같은 `allowed`** 를 쓴다. 이 커맨드만 따로 검사하면
/// 루트 규칙이 두 벌이 되고, 파괴적인 쪽이 느슨해지는 건 시간 문제다.
#[tauri::command(async)]
pub fn fav_delete(state: State<'_, AppState>, path: String) -> Result<(), IpcError> {
    let p = allowed(&state, &path)?;
    trash::delete(&p)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("휴지통으로 보내지 못했습니다: {e}")))
}

/// `fav_open` 의 분기 — 프로세스를 띄우지 않고 테스트할 수 있게 떼어 냈다.
#[derive(Debug, PartialEq)]
enum Launch {
    Reveal,
    Explorer,
    Run,
}

fn launch_for(how: &str, is_dir: bool) -> Launch {
    match (how, is_dir) {
        ("reveal", _) => Launch::Reveal,
        (_, true) => Launch::Explorer,
        (_, false) => Launch::Run,
    }
}

// ---- 프리셋 -------------------------------------------------------------------------

/// OS 별 스크린샷·다운로드·바탕화면 후보 중 **실제로 존재하는 것만** 돌려준다.
/// 드롭다운이 "아직 등록 안 된 것"만 골라 보여 준다(등록은 프론트가 설정에 쓴다).
#[tauri::command(async)]
pub fn fav_presets() -> Vec<FavoriteFolder> {
    let mut out: Vec<FavoriteFolder> = Vec::new();
    let mut push = |name: &str, p: Option<PathBuf>| {
        if let Some(p) = p {
            if p.is_dir() && !out.iter().any(|f| f.path == p.to_string_lossy()) {
                out.push(FavoriteFolder {
                    path: p.to_string_lossy().to_string(),
                    name: name.to_string(),
                });
            }
        }
    };
    push("스크린샷", screenshots_dir());
    push("다운로드", downloads_dir());
    push("바탕화면", desktop_dir());
    out
}

fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

/// `%NAME%` 토큰을 전부 `lookup` 으로 치환한다. 모르는 이름은 그대로 두고, 그 닫는 `%` 는 다음
/// 토큰의 여는 `%` 후보로 다시 본다(ExpandEnvironmentStrings 와 같은 규칙).
///
/// `User Shell Folders` 값에는 `%USERPROFILE%` 만 오지 않는다 — 폴더 리디렉션·OneDrive 이동은
/// `%USERNAME%`·`%HOMEDRIVE%%HOMEPATH%`·`%OneDrive%` 같은 다른 변수를 쓸 수 있다.
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_env_vars(raw: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(open) = rest.find('%') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('%') else { break };
        out.push_str(&rest[..open]);
        match lookup(&after[..close]) {
            Some(v) => {
                out.push_str(&v);
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(&rest[open..=open + close]);
                rest = &after[close..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// `User Shell Folders` 의 값 하나를 경로로 푼다. `name` 은 값 이름 — 옛 폴더는 `Desktop`·
/// `My Pictures` 같은 이름이고, 새 폴더(다운로드·스크린샷)는 KNOWNFOLDERID GUID 다.
#[cfg(windows)]
fn shell_folder(name: &str) -> Option<PathBuf> {
    // `User Shell Folders` 는 사용자가 옮긴 위치를 반영하고 값에 환경변수가 그대로 들어 있을 수
    // 있다 — 그래서 확장이 필요하다(`Shell Folders` 는 확장된 값이지만 옛 캐시라 이동을 못 따라가는
    // 경우가 있다).
    let key = windows_registry::CURRENT_USER
        .open("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders")
        .ok()?;
    let raw = key.get_string(name).ok()?;
    Some(PathBuf::from(expand_env_vars(&raw, |n| std::env::var(n).ok())))
}

#[cfg(windows)]
fn screenshots_dir() -> Option<PathBuf> {
    // GUID 값이 없으면 **사진 폴더** 아래를 본다 — 스크린샷은 사진의 하위 알려진 폴더라, 사진이
    // OneDrive 등으로 옮겨졌으면 그 아래에 생긴다. `home\Pictures` 는 마지막 폴백이다.
    shell_folder("{B7BEDE81-DF94-4682-A7D8-57A52620B86F}")
        .or_else(|| shell_folder("My Pictures").map(|p| p.join("Screenshots")))
        .or_else(|| home().map(|h| h.join("Pictures").join("Screenshots")))
}

#[cfg(windows)]
fn downloads_dir() -> Option<PathBuf> {
    shell_folder("{374DE290-123F-4565-9164-39C4925E467B}")
        .or_else(|| home().map(|h| h.join("Downloads")))
}

#[cfg(windows)]
fn desktop_dir() -> Option<PathBuf> {
    shell_folder("Desktop").or_else(|| home().map(|h| h.join("Desktop")))
}

#[cfg(target_os = "macos")]
fn screenshots_dir() -> Option<PathBuf> {
    // 사용자가 위치를 바꿨으면 그것을 쓴다(`defaults` 가 유일한 출처다).
    let out = std::process::Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && !s.is_empty() {
        let expanded = if let Some(rest) = s.strip_prefix("~") {
            home()?.join(rest.trim_start_matches('/'))
        } else {
            PathBuf::from(s)
        };
        return Some(expanded);
    }
    home().map(|h| h.join("Desktop"))
}

#[cfg(target_os = "macos")]
fn downloads_dir() -> Option<PathBuf> {
    home().map(|h| h.join("Downloads"))
}

#[cfg(target_os = "macos")]
fn desktop_dir() -> Option<PathBuf> {
    home().map(|h| h.join("Desktop"))
}

/// `user-dirs.dirs` 본문에서 `XDG_<key>_DIR` 을 찾아 경로로 푼다(`$HOME` 치환). 없거나 비었으면 None.
///
/// XDG 사용자 디렉터리는 로케일에 따라 이름이 다르다(한국어 세션이면 "다운로드"·"바탕화면"·"사진").
/// 이 파일이 그 단일 출처다.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn parse_user_dirs(txt: &str, key: &str, home: &Path) -> Option<PathBuf> {
    let prefix = format!("XDG_{key}_DIR=");
    txt.lines().find_map(|line| {
        let v = line.trim().strip_prefix(&prefix)?.trim().trim_matches('"');
        let v = v.replace("$HOME", &home.to_string_lossy());
        (!v.is_empty()).then(|| PathBuf::from(v))
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn xdg_user_dir(key: &str) -> Option<PathBuf> {
    let h = home()?;
    let txt = std::fs::read_to_string(h.join(".config").join("user-dirs.dirs")).ok()?;
    parse_user_dirs(&txt, key, &h)
}

/// GNOME 의 스크린샷 폴더를 고른다. `xdg_pictures` 는 `user-dirs.dirs` 의 사진 폴더(항목이 있으면).
///
/// gnome-shell 42+ 는 `<사진>/<번역된 "Screenshots">` 에 저장한다(`js/ui/screenshot.js`) — 사진 폴더
/// 이름뿐 아니라 **하위 폴더 이름도 번역**돼 한국어 세션이면 `~/사진/스크린샷` 이다. 영어
/// `Screenshots` 가 없으면 사진 폴더 자체를 준다(창에서 한 번 들어가면 된다). `~/Pictures` 는 사진
/// 폴더를 모르거나 그 자리에 없을 때만 쓴다.
///
/// ponytail: 번역된 하위 폴더 이름은 모른다 — 사진 폴더에서 멈춘다. 곧장 들어가야 하면 gnome-shell
/// 번역 카탈로그에서 "Screenshots" 의 번역을 조회한다.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn gnome_screenshots_dir(xdg_pictures: Option<PathBuf>, home: &Path) -> PathBuf {
    let pics = xdg_pictures
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| home.join("Pictures"));
    let shots = pics.join("Screenshots");
    if shots.is_dir() {
        shots
    } else {
        pics
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn screenshots_dir() -> Option<PathBuf> {
    Some(gnome_screenshots_dir(xdg_user_dir("PICTURES"), &home()?))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn downloads_dir() -> Option<PathBuf> {
    xdg_user_dir("DOWNLOAD").or_else(|| home().map(|h| h.join("Downloads")))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn desktop_dir() -> Option<PathBuf> {
    xdg_user_dir("DESKTOP").or_else(|| home().map(|h| h.join("Desktop")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트마다 고유한 빈 임시 폴더 — 이름에 테스트명·pid 를 넣어 병렬 실행·이전 잔재와 섞이지 않게.
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gpv-fav-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn kind_is_decided_by_extension_and_dir_flag() {
        assert_eq!(kind_of("a.PNG", false), "image");
        assert_eq!(kind_of("a.mp4", false), "video");
        assert_eq!(kind_of("a.txt", false), "other");
        assert_eq!(kind_of("a.png", true), "dir", "폴더면 확장자를 보지 않는다");
    }

    #[test]
    fn only_three_thumbnail_edges_are_accepted() {
        // 프론트의 그리드 S/M/L 과 짝이다 — 여기가 열리면 캐시가 크기마다 한 벌씩 늘어난다.
        assert!(EDGES.contains(&128) && EDGES.contains(&192) && EDGES.contains(&320));
        assert!(!EDGES.contains(&256));
    }

    #[test]
    fn mime_covers_every_kind_image_extension() {
        for ext in ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] {
            let p = PathBuf::from(format!("x.{ext}"));
            assert_ne!(
                mime_of(&p),
                "application/octet-stream",
                "{ext} 는 kind_of 가 image 로 분류하는데 mime 이 없다"
            );
        }
    }

    /// 게이트의 핵심 성질 — `allowed` 가 부르는 `contained` 를 직접 친다.
    #[test]
    fn contained_allows_root_and_children_only() {
        const DENIED: &str = "즐겨찾기에 등록되지 않은 폴더입니다";
        let base = scratch("contained");
        let root = base.join("root");
        let child = root.join("inner").join("a.png");
        let sibling = base.join("root-2");
        std::fs::create_dir_all(child.parent().unwrap()).unwrap();
        std::fs::write(&child, b"x").unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let roots = vec![root.to_string_lossy().to_string()];

        assert!(contained(&root, &roots).is_ok(), "루트 자신은 허용");
        assert_eq!(
            contained(&child, &roots).unwrap(),
            dunce::canonicalize(&child).unwrap(),
            "짧은 경로는 예전(dunce)과 같은 모양이어야 썸네일 캐시 키가 안 바뀐다"
        );
        // `..` 는 canonicalize 가 풀어 버리므로 루트 밖으로 나간다.
        assert_eq!(contained(&root.join(".."), &roots).unwrap_err().message, DENIED);
        // 문자열 접두 비교였다면 통과했을 형제 폴더 — 성분 단위라 거부된다.
        assert_eq!(contained(&sibling, &roots).unwrap_err().message, DENIED);
        assert_eq!(
            contained(&root.join("nope"), &roots).unwrap_err().code,
            ErrorCode::NotFound
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 전체 경로가 260자를 넘는 깊은 파일도 루트 안이면 허용해야 한다.
    ///
    /// 옛 코드(양쪽 `dunce::canonicalize`)에서는 실패한다: dunce 는 `\\?\` 접두를 260자 이하일 때만
    /// 벗기므로 짧은 루트는 `C:\…`(Prefix::Disk), 이 파일은 `\\?\C:\…`(Prefix::VerbatimDisk)로 남고
    /// `Path::starts_with` 가 첫 성분부터 다르다며 거부한다. 유닉스에는 접두가 없어 옛 코드도
    /// 통과한다 — 이 회귀는 Windows 에서만 잡힌다.
    #[test]
    fn contained_allows_long_paths_under_root() {
        let base = scratch("contained-long");
        let seg = "d".repeat(60);
        let deep = base.join(&seg).join(&seg).join(&seg).join(&seg);
        std::fs::create_dir_all(&deep).unwrap();
        let file = deep.join("shot.png");
        std::fs::write(&file, b"x").unwrap();
        assert!(
            std::fs::canonicalize(&file).unwrap().as_os_str().len() > 260,
            "전제: MAX_PATH 를 넘어야 이 테스트가 의미 있다"
        );
        #[cfg(windows)]
        assert!(
            !dunce::canonicalize(&file)
                .unwrap()
                .starts_with(dunce::canonicalize(&base).unwrap()),
            "전제: 옛 판정(dunce 양쪽)은 이 파일을 거부한다"
        );
        let roots = vec![base.to_string_lossy().to_string()];
        let got = contained(&file, &roots).expect("루트 안의 깊은 파일은 허용해야 한다");
        assert!(got.ends_with("shot.png"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 확장자가 거짓말해도 내용으로 디코더를 고른다. 옛 코드(`image::open`)는 `.png` 를 보고 PNG
    /// 디코더를 골라 시그니처 오류로 실패했다.
    #[test]
    fn decode_thumb_sniffs_content_not_extension() {
        let dir = scratch("sniff");
        let mut jpeg = Vec::new();
        image::DynamicImage::new_rgb8(300, 200)
            .write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .unwrap();
        let file = dir.join("x.png");
        std::fs::write(&file, &jpeg).unwrap();
        let out = decode_thumb(&file, 128).expect("JPEG 내용이면 이름이 .png 여도 열려야 한다");
        assert_eq!(image::guess_format(&out).unwrap(), image::ImageFormat::Jpeg);
        let thumb = image::load_from_memory(&out).unwrap();
        assert_eq!(thumb.width(), 128, "긴 변이 edge 로 줄어야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 치수 한도는 디코드 전에 걸려 구분되는 문장으로 나온다. 옛 코드(`image::open`, 치수 한도
    /// 없음)는 이 파일을 그대로 디코드해 Ok 를 돌려줬다.
    #[test]
    fn decode_thumb_rejects_oversized_dimensions() {
        let dir = scratch("oversize");
        let mut png = Vec::new();
        // 20000×1 — 한 변만 한도(16384)를 넘는다. 픽셀은 6만 바이트라 테스트가 가볍다.
        image::DynamicImage::new_rgb8(20000, 1)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let file = dir.join("wide.png");
        std::fs::write(&file, &png).unwrap();
        let err = decode_thumb(&file, 128).unwrap_err();
        assert!(
            err.message.starts_with("이미지가 너무 큽니다"),
            "한도 위반은 일반 디코드 실패와 구분돼야 한다: {}",
            err.message
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 입력 파일 크기 한도는 파일을 읽기 전에 걸린다. 크기 검사가 없으면 JPEG 디코더가 생성자에서
    /// 이 파일 256MiB 를 통째로 읽은 뒤(한도는 그 뒤에야 적용) 헤더 파싱 오류로 실패해,
    /// "이미지를 열지 못했습니다" 가 나온다.
    #[test]
    fn decode_thumb_rejects_oversized_file_before_reading_it() {
        let dir = scratch("bigfile");
        let file = dir.join("big.jpg");
        std::fs::write(&file, [0xFF, 0xD8, 0xFF, 0xE0]).unwrap();
        // 끝만 옮긴다 — ext4 는 sparse, NTFS 는 유효 데이터 길이 뒤라 실제로 쓰지 않아 즉시 끝난다.
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(MAX_DECODE_ALLOC + 1)
            .unwrap();
        let err = decode_thumb(&file, 128).unwrap_err();
        assert!(
            err.message.starts_with("이미지가 너무 큽니다"),
            "큰 입력은 읽기 전에 한도로 거부해야 한다: {}",
            err.message
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 디코드 슬롯은 프로세스 전체에서 3개다. 세마포어를 빼거나 슬롯을 즉시 놓으면 8개가 한꺼번에
    /// 돌고(peak 8), blocking 풀을 거치지 않고 제자리에서 돌리면 이 테스트 스레드에서 하나씩 돈다(peak 1).
    #[tokio::test]
    async fn decode_slots_cap_concurrency_at_three() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let jobs = (0..8).map(|_| {
            let (live, peak) = (live.clone(), peak.clone());
            in_decode_slot(move || {
                let n = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(50));
                live.fetch_sub(1, Ordering::SeqCst);
            })
        });
        for r in futures::future::join_all(jobs).await {
            r.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn prune_removes_only_stale_entries() {
        let dir = scratch("prune");
        let now = SystemTime::now();
        let hours_ago = |h: u64| now - Duration::from_secs(h * 3600);
        let make = |name: &str, mtime: SystemTime| {
            let p = dir.join(name);
            std::fs::write(&p, b"x").unwrap();
            std::fs::File::options()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(mtime)
                .unwrap();
        };
        make("old.jpg", hours_ago(40 * 24)); // 30일 초과 → 삭제
        make("recent.jpg", hours_ago(2)); // tmp 기준(1h)을 jpg 에 쓰면 지워진다 → 남아야 한다
        make("old.1-0.tmp", hours_ago(2)); // 1시간 넘은 고아 → 삭제
        make("fresh.1-1.tmp", now); // 지금 쓰는 중일 수 있다 → 남긴다
        make("keep.txt", hours_ago(40 * 24)); // 우리 것이 아닌 파일은 나이와 무관하게 둔다
        assert_eq!(prune_thumb_cache(&dir, now), 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["fresh.1-1.tmp", "keep.txt", "recent.jpg"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 대상을 제자리에서 덮지 않고 **교체**해야 한다 — 끝 상태만 보면 제자리 `fs::write` 도 같으므로
    /// 하드 링크로 가른다. rename 은 디렉터리 항목만 바꿔 링크가 옛 파일("first")을 계속 가리키고,
    /// 제자리 쓰기는 두 이름이 공유하는 파일 자체를 잘라 쓰므로 링크도 "second" 가 된다.
    #[test]
    fn write_atomic_replaces_instead_of_truncating() {
        let dir = scratch("atomic");
        let target = dir.join("k.jpg");
        let alias = dir.join("alias.jpg");
        write_atomic(&target, b"first").unwrap();
        std::fs::hard_link(&target, &alias).unwrap();
        write_atomic(&target, b"second").unwrap(); // 기존 대상 위로도 교체돼야 한다
        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        assert_eq!(
            std::fs::read(&alias).unwrap(),
            b"first",
            "제자리 쓰기면 공유 파일이 잘려 링크까지 바뀐다"
        );
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["alias.jpg", "k.jpg"], "임시 파일이 남으면 안 된다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 폴더의 "기본 앱으로 열기"는 폴더 자신을 연다. 옛 코드는 폴더도 `run_file` 로 보냈다
    /// (리눅스에선 폴더를 exec 하려 든다).
    #[test]
    fn folders_open_themselves_unless_revealed() {
        assert_eq!(launch_for("default", true), Launch::Explorer);
        assert_eq!(launch_for("default", false), Launch::Run);
        assert_eq!(launch_for("reveal", true), Launch::Reveal);
        assert_eq!(launch_for("reveal", false), Launch::Reveal);
    }

    #[test]
    fn expand_env_vars_expands_every_known_token() {
        let env = |n: &str| match n {
            "USERPROFILE" => Some(r"C:\Users\u".to_string()),
            "HOMEDRIVE" => Some("C:".to_string()),
            "HOMEPATH" => Some(r"\Users\u".to_string()),
            "OneDrive" => Some(r"C:\Users\u\OneDrive".to_string()),
            _ => None,
        };
        // 옛 코드는 %USERPROFILE% 만 바꿨다 — 아래 둘은 그대로 남아 없는 경로가 됐다.
        assert_eq!(expand_env_vars(r"%OneDrive%\Pictures", env), r"C:\Users\u\OneDrive\Pictures");
        assert_eq!(expand_env_vars(r"%HOMEDRIVE%%HOMEPATH%\Desktop", env), r"C:\Users\u\Desktop");
        assert_eq!(expand_env_vars(r"%USERPROFILE%\Downloads", env), r"C:\Users\u\Downloads");
        // 모르는 이름은 그대로 — 그 닫는 `%` 는 다음 토큰의 여는 `%` 가 될 수 있다.
        assert_eq!(expand_env_vars(r"%NOPE%\x", env), r"%NOPE%\x");
        assert_eq!(expand_env_vars(r"D:\50%-%USERPROFILE%", env), r"D:\50%-C:\Users\u");
        // 변수 없음 · 짝 없는 `%`
        assert_eq!(expand_env_vars(r"D:\Shots", env), r"D:\Shots");
        assert_eq!(expand_env_vars("100%", env), "100%");
    }

    #[test]
    fn user_dirs_parser_reads_any_key() {
        let txt = "# This file is written by xdg-user-dirs-update\n\
                   XDG_DESKTOP_DIR=\"$HOME/바탕화면\"\n\
                   XDG_DOWNLOAD_DIR=\"$HOME/다운로드\"\n\
                   XDG_PICTURES_DIR=\"/mnt/data/사진\"\n\
                   XDG_MUSIC_DIR=\"\"\n";
        let home = Path::new("/home/u");
        assert_eq!(parse_user_dirs(txt, "DESKTOP", home), Some(PathBuf::from("/home/u/바탕화면")));
        assert_eq!(parse_user_dirs(txt, "DOWNLOAD", home), Some(PathBuf::from("/home/u/다운로드")));
        assert_eq!(parse_user_dirs(txt, "PICTURES", home), Some(PathBuf::from("/mnt/data/사진")));
        assert_eq!(parse_user_dirs(txt, "MUSIC", home), None, "빈 값은 없는 것으로 친다");
        assert_eq!(parse_user_dirs(txt, "VIDEOS", home), None);
    }

    /// 한국어 GNOME 은 `~/사진/스크린샷` 에 저장해 영어 `Screenshots` 가 없다. 옛 판정(사진 아래
    /// `Screenshots` 가 없으면 `~/Pictures`)은 첫 단언에서 `home/Pictures` 를 돌려줘 실패한다 —
    /// 한국어 세션엔 그 폴더도 없어 프리셋이 통째로 빠지던 결함이다.
    #[test]
    fn gnome_screenshots_stay_in_localized_pictures_dir() {
        let base = scratch("gnome-shots");
        let home = base.join("home");
        let pics = home.join("사진");
        std::fs::create_dir_all(pics.join("스크린샷")).unwrap();
        assert_eq!(gnome_screenshots_dir(Some(pics.clone()), &home), pics);
        std::fs::create_dir_all(pics.join("Screenshots")).unwrap();
        assert_eq!(
            gnome_screenshots_dir(Some(pics.clone()), &home),
            pics.join("Screenshots")
        );
        // 사진 폴더를 모르거나(항목 없음) 그 자리에 없을 때만 ~/Pictures
        assert_eq!(gnome_screenshots_dir(None, &home), home.join("Pictures"));
        assert_eq!(
            gnome_screenshots_dir(Some(base.join("gone")), &home),
            home.join("Pictures")
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
