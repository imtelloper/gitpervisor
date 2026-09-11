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

// ---- 게이트 -------------------------------------------------------------------------

/// 주어진 절대경로가 즐겨찾기 루트 **안**인지 확인하고, canonical 경로를 돌려준다.
///
/// 아래 커맨드 넷은 전부 첫 줄에서 이것을 부른다. 하나라도 빠뜨리면 그 커맨드가 파일시스템
/// 전체를 읽는 통로가 된다 — 프론트를 믿고 검사를 생략하지 마라.
fn allowed(state: &State<'_, AppState>, path: &str) -> Result<PathBuf, IpcError> {
    let target = dunce::canonicalize(path)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, format!("경로를 찾을 수 없습니다: {e}")))?;
    let roots: Vec<String> = state
        .settings
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .favorite_folders
        .iter()
        .map(|f| f.path.clone())
        .collect();
    for r in &roots {
        // 루트도 canonicalize 한다 — 등록된 문자열이 심링크나 8.3 단축 경로일 수 있다.
        if let Ok(root) = dunce::canonicalize(r) {
            if target.starts_with(&root) {
                return Ok(target);
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
/// ponytail: 캐시 용량 무제한 — 항목당 수 KB 라 당장은 문제가 아니다. 커지면 설정의 유지보수
/// 섹션에 "썸네일 캐시 비우기"(이 폴더 삭제 한 줄)를 붙인다.
#[tauri::command(async)]
pub fn fav_thumb(
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

    let cache = app
        .path()
        .app_cache_dir()
        .map(|d| d.join("thumbs").join(format!("{key}.jpg")));
    if let Ok(p) = &cache {
        if let Ok(bytes) = std::fs::read(p) {
            return Ok(data_url("image/jpeg", &bytes));
        }
    }

    let img = image::open(&file)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("이미지를 열지 못했습니다: {e}")))?
        .thumbnail(edge, edge);
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut std::io::Cursor::new(&mut buf), 80)
        .encode_image(&img)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("썸네일 인코딩 실패: {e}")))?;

    // 캐시 기록 실패는 치명적이지 않다 — 다음번에 다시 만들 뿐이다.
    if let Ok(p) = &cache {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, &buf);
    }
    Ok(data_url("image/jpeg", &buf))
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
/// **`open.rs` 의 것을 그대로 쓴다.** 새로 `Command::new("explorer")` 를 부르면 안 된다 —
/// 거기엔 `spawn_launcher` 의 systemd-run 위임과 좀비 회수가 들어 있고, 그게 없어서
/// 2026-08-01 에 프로세스가 387개까지 쌓여 앱이 통째로 SIGKILL 당했다(CLAUDE.md).
#[tauri::command(async)]
pub fn fav_open(state: State<'_, AppState>, path: String, how: String) -> Result<(), IpcError> {
    let p = allowed(&state, &path)?;
    if how == "reveal" {
        super::open::reveal(&p)
    } else {
        super::open::run_file(&p)
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
    push("바탕화면", home().map(|h| h.join("Desktop")));
    out
}

fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

#[cfg(windows)]
fn shell_folder(guid: &str) -> Option<PathBuf> {
    // `User Shell Folders` 는 사용자가 옮긴 위치를 반영하고 값에 `%USERPROFILE%` 가 그대로
    // 들어 있을 수 있다 — 그래서 확장이 필요하다(`Shell Folders` 는 확장된 값이지만 옛 캐시라
    // 이동을 못 따라가는 경우가 있다).
    let key = windows_registry::CURRENT_USER
        .open("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders")
        .ok()?;
    let raw = key.get_string(guid).ok()?;
    let home = home()?;
    Some(PathBuf::from(raw.replace(
        "%USERPROFILE%",
        &home.to_string_lossy(),
    )))
}

#[cfg(windows)]
fn screenshots_dir() -> Option<PathBuf> {
    shell_folder("{B7BEDE81-DF94-4682-A7D8-57A52620B86F}")
        .or_else(|| home().map(|h| h.join("Pictures").join("Screenshots")))
}

#[cfg(windows)]
fn downloads_dir() -> Option<PathBuf> {
    shell_folder("{374DE290-123F-4565-9164-39C4925E467B}")
        .or_else(|| home().map(|h| h.join("Downloads")))
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

#[cfg(all(unix, not(target_os = "macos")))]
fn screenshots_dir() -> Option<PathBuf> {
    let h = home()?;
    let shots = h.join("Pictures").join("Screenshots"); // GNOME 42+
    Some(if shots.is_dir() {
        shots
    } else {
        h.join("Pictures")
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn downloads_dir() -> Option<PathBuf> {
    let h = home()?;
    // XDG 사용자 디렉터리는 로케일에 따라 이름이 다르다(한국어 세션이면 "다운로드").
    // `user-dirs.dirs` 가 그 단일 출처다.
    if let Ok(txt) = std::fs::read_to_string(h.join(".config").join("user-dirs.dirs")) {
        for line in txt.lines() {
            let line = line.trim();
            if let Some(v) = line.strip_prefix("XDG_DOWNLOAD_DIR=") {
                let v = v.trim().trim_matches('"');
                let v = v.replace("$HOME", &h.to_string_lossy());
                if !v.is_empty() {
                    return Some(PathBuf::from(v));
                }
            }
        }
    }
    Some(h.join("Downloads"))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 게이트의 핵심 성질 — 루트 밖은 거부, 루트 자신과 하위는 허용.
    /// `allowed` 는 `State` 를 요구해 단위 테스트에서 만들 수 없으므로, 그것이 쓰는 판정
    /// (canonicalize 후 `starts_with`)을 같은 형태로 검증한다.
    #[test]
    fn canonical_prefix_check_rejects_parent_escape() {
        let tmp = std::env::temp_dir();
        let root = tmp.join("gpv-fav-test-root");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        let root_c = dunce::canonicalize(&root).unwrap();
        assert!(dunce::canonicalize(&inner).unwrap().starts_with(&root_c));
        assert!(dunce::canonicalize(&root).unwrap().starts_with(&root_c));
        // `..` 는 canonicalize 가 풀어 버리므로 루트 밖으로 나간다.
        let escaped = dunce::canonicalize(root.join("..")).unwrap();
        assert!(!escaped.starts_with(&root_c));
        let _ = std::fs::remove_dir_all(&root);
    }
}
