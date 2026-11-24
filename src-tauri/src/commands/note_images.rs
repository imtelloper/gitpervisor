//! 메모 이미지 — `data_root/note-images/<uuid>.avif` 파일 + 본문 토큰 `memo-img/<uuid>.avif`
//! (DOCS/memo-todo-category-image-design.md §2.3·§3·§7.4).
//!
//! **id 가 곧 경로다.** 소문자 하이픈 정규형 UUID 만 받는다 — 대소문자를 섞어 받으면 NTFS·APFS 에서는 같은 파일인데
//! 정리(§7.4)의 참조 대조는 다른 문자열로 봐서, 쓰이는 이미지를 보관함으로 옮긴다.
//!
//! 정리는 지우는 판단이 휴리스틱(원문 바이트의 UUID 스캔)이라 두 단계다: 안 쓰이는 파일은 `orphan/` 으로 옮기고,
//! 거기서 30일이 지난 것만 지운다. `note_image_get` 은 보관함에서 찾으면 본 폴더로 되돌린다.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::AppHandle;

use super::favorites::ftyp_is_avif;
use crate::error::{ErrorCode, IpcError};
use crate::i18n::{text_files, text_git_net};
use crate::state;

const NOTE_IMAGES_DIR: &str = "note-images";
const ORPHAN_DIR: &str = "orphan";
const MAX_NOTE_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const ORPHAN_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const ID_HEADER: &str = "x-gpv-note-image-id";

/// `uuid` 는 중괄호·urn·하이픈 없는 꼴·대문자도 파싱한다 — 정규형으로 되돌린 문자열과 같을 때만 받는다.
fn is_canonical_note_image_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|u| u.hyphenated().to_string() == id)
}

fn checked_id(id: &str) -> Result<(), IpcError> {
    if is_canonical_note_image_id(id) {
        Ok(())
    } else {
        Err(IpcError::new(ErrorCode::Io, text_git_net::note_image_id_invalid(id)))
    }
}

fn images_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    state::data_root(app)
        .map(|d| d.join(NOTE_IMAGES_DIR))
        .ok_or_else(|| IpcError::new(ErrorCode::Io, text_git_net::data_folder_not_found()))
}

fn save_err(e: impl std::fmt::Display) -> IpcError {
    IpcError::new(ErrorCode::Io, text_git_net::data_save_failed(text_git_net::data_label_note_image(), e))
}

/// 본문은 `InvokeBody::Raw`(AVIF 바이트), id 는 헤더 — `write_file_raw` 와 같은 방식.
#[tauri::command]
pub async fn note_image_put(app: AppHandle, request: Request<'_>) -> Result<(), IpcError> {
    let id = request
        .headers()
        .get(ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    checked_id(&id)?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(IpcError::new(ErrorCode::Io, text_git_net::note_image_body_required()));
    };
    let body = body.clone();
    let dir = images_dir(&app)?;
    tokio::task::spawn_blocking(move || put_note_image_at(&dir, &id, &body))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::raw_write_task_failed(e)))?
}

fn put_note_image_at(dir: &Path, id: &str, body: &[u8]) -> Result<(), IpcError> {
    checked_id(id)?;
    if body.len() > MAX_NOTE_IMAGE_BYTES {
        return Err(IpcError::new(ErrorCode::Io, text_git_net::note_image_too_large_8mb()));
    }
    if body.get(4..8) != Some(&b"ftyp"[..]) || !ftyp_is_avif(body) {
        return Err(IpcError::new(ErrorCode::Io, text_git_net::note_image_not_avif()));
    }
    let name = format!("{id}.avif");
    let exists = || IpcError::new(ErrorCode::AlreadyExists, text_git_net::note_image_exists(id));
    // 보관함에 있는 id 도 재사용이다 — get 이 되돌리면서 이 파일을 덮는다.
    if dir.join(ORPHAN_DIR).join(&name).exists() {
        return Err(exists());
    }
    fs::create_dir_all(dir).map_err(save_err)?;
    let target = dir.join(&name);
    // tmp+rename 이 아니라 create_new 로 최종 경로에 직접 — rename 은 대상을 덮어 "같은 id 재사용 금지"를 못 지킨다.
    // 쓰다 죽어 잘린 파일은 "이미지 없음"으로 보일 뿐이다.
    let mut f = match OpenOptions::new().write(true).create_new(true).open(&target) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Err(exists()),
        Err(e) => return Err(save_err(e)),
    };
    let written = f.write_all(body).and_then(|()| f.sync_all());
    drop(f);
    if let Err(e) = written {
        // 여기까지 왔으면 이 파일은 방금 우리가 만든 것이다(create_new) — 지워도 남의 것을 지우지 않는다.
        if let Err(re) = fs::remove_file(&target) {
            log::warn!("[note-images] failed to remove partial file {}: {re}", target.display());
        }
        return Err(save_err(e));
    }
    Ok(())
}

/// 원시 바이트 응답(`read_file_raw` 방식). 본 폴더에 없으면 보관함에서 되돌린 뒤 돌려준다.
#[tauri::command]
pub async fn note_image_get(app: AppHandle, id: String) -> Result<Response, IpcError> {
    checked_id(&id)?;
    let dir = images_dir(&app)?;
    tokio::task::spawn_blocking(move || get_note_image_at(&dir, &id))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::file_read_failed(e)))?
        .map(Response::new)
}

fn get_note_image_at(dir: &Path, id: &str) -> Result<Vec<u8>, IpcError> {
    checked_id(id)?;
    let name = format!("{id}.avif");
    let main = dir.join(&name);
    let orphan = dir.join(ORPHAN_DIR).join(&name);
    let path = if main.is_file() || !orphan.is_file() {
        main
    } else {
        match fs::rename(&orphan, &main) {
            Ok(()) => main,
            Err(e) => {
                // 되돌리지 못해도 보여 주는 건 된다 — 다음 정리 때까지는 보관함에 남는다.
                log::warn!("[note-images] failed to restore {} from orphan: {e}", orphan.display());
                orphan
            }
        }
    };
    fs::read(&path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => IpcError::new(ErrorCode::NotFound, text_git_net::note_image_not_found(id)),
        _ => IpcError::new(ErrorCode::Io, text_files::file_read_failed(format!("{}: {e}", path.display()))),
    })
}

/// 원문 바이트에서 소문자 정규형 UUID 꼴 문자열 전부. 토큰 정규식이 아니라 UUID 로 본다 — 반쯤 지워진 토큰
/// (`memo-img/<uuid>.av`)도 참조로 쳐야 한다(넓게 잡는 쪽이 안전하다).
fn uuids_in(bytes: &[u8]) -> HashSet<String> {
    const LEN: usize = 36;
    let uuid_at = |w: &[u8]| {
        w.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
    };
    bytes
        .windows(LEN)
        .filter(|w| uuid_at(w))
        .map(|w| String::from_utf8_lossy(w).into_owned())
        .collect()
}

/// 본 폴더에서 보관함으로 옮길 파일 이름. `<정규형 uuid>.avif` 가 아닌 이름은 절대 내놓지 않는다.
fn orphan_note_images(file_names: &[String], referenced: &HashSet<String>) -> Vec<String> {
    file_names
        .iter()
        .filter(|n| {
            n.strip_suffix(".avif")
                .is_some_and(|id| is_canonical_note_image_id(id) && !referenced.contains(id))
        })
        .cloned()
        .collect()
}

/// 미래 시각(시계가 되돌아감)은 만료가 아니다.
fn orphan_expired(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified).is_ok_and(|age| age > ORPHAN_TTL)
}

fn file_names_in(dir: &Path) -> Result<Vec<String>, std::io::Error> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            // 비 UTF-8 이름은 우리가 만든 파일이 아니다 — 건드리지 않는다.
            if let Ok(n) = entry.file_name().into_string() {
                names.push(n);
            }
        }
    }
    Ok(names)
}

/// 앱 시작 뒤 별도 스레드에서 한 번. 실패는 로그로만 남긴다 — 정리가 안 되는 건 디스크를 조금 더 쓸 뿐이다.
pub fn sweep_note_images(app: &AppHandle) {
    let Some(root) = state::data_root(app) else {
        log::warn!("[note-images] sweep skipped: data folder not found");
        return;
    };
    sweep_note_images_at(&root, SystemTime::now());
}

fn sweep_note_images_at(root: &Path, now: SystemTime) {
    let notes_path = root.join(state::NOTES_FILE);
    let notes = match fs::read(&notes_path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => return, // 메모가 없다 = 참조를 모른다 — 아무것도 하지 않는다
        Err(e) => {
            log::warn!("[note-images] sweep skipped: cannot read {}: {e}", notes_path.display());
            return;
        }
    };
    // 파싱 결과가 아니라 원문을 본다: 손상된 notes.json 은 state::load_json_at 이 `with_extension("corrupt")` 로
    // 옮기고 빈 목록으로 부팅한다 — 그 뒤 메모 하나만 써도 새 notes.json 이 "정상"으로 보여, 격리본만 믿던 이미지를 지운다.
    let corrupt_path = notes_path.with_extension("corrupt");
    let corrupt = match fs::read(&corrupt_path) {
        Ok(b) => b,
        Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
        Err(e) => {
            log::warn!("[note-images] sweep skipped: cannot read {}: {e}", corrupt_path.display());
            return;
        }
    };
    let mut referenced = uuids_in(&notes);
    referenced.extend(uuids_in(&corrupt));

    let dir = root.join(NOTE_IMAGES_DIR);
    let names = match file_names_in(&dir) {
        Ok(n) => n,
        Err(e) if e.kind() == ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("[note-images] sweep skipped: cannot list {}: {e}", dir.display());
            return;
        }
    };
    let orphan_dir = dir.join(ORPHAN_DIR);
    let moving = orphan_note_images(&names, &referenced);
    let mut moved = HashSet::new();
    if !moving.is_empty() {
        if let Err(e) = fs::create_dir_all(&orphan_dir) {
            log::warn!("[note-images] cannot create {}: {e}", orphan_dir.display());
            return;
        }
    }
    for name in moving {
        let to = orphan_dir.join(&name);
        if let Err(e) = fs::rename(dir.join(&name), &to) {
            log::warn!("[note-images] failed to move {name} to orphan: {e}");
            continue;
        }
        // 만료는 "보관함에 들어온 때"부터 센다 — 원본 생성 시각이면 오래된 이미지가 옮겨지자마자 지워진다.
        if let Err(e) = File::options().write(true).open(&to).and_then(|f| f.set_modified(now)) {
            log::warn!("[note-images] failed to touch {}: {e}", to.display());
        }
        moved.insert(name);
    }

    let orphans = match file_names_in(&orphan_dir) {
        Ok(n) => n,
        Err(e) if e.kind() == ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("[note-images] cannot list {}: {e}", orphan_dir.display());
            return;
        }
    };
    for name in orphans {
        // 방금 옮긴 것은 시각 갱신이 실패했어도 이번 회차에 지우지 않는다.
        let ours = name.strip_suffix(".avif").is_some_and(is_canonical_note_image_id);
        if !ours || moved.contains(&name) {
            continue;
        }
        let path = orphan_dir.join(&name);
        match fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(m) if orphan_expired(m, now) => {
                if let Err(e) = fs::remove_file(&path) {
                    log::warn!("[note-images] failed to delete expired {}: {e}", path.display());
                }
            }
            Ok(_) => {}
            Err(e) => log::warn!("[note-images] cannot read mtime of {}: {e}", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const B: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const C: &str = "16fd2706-8baf-433b-82eb-8c7fada847da";
    const D: &str = "886313e1-3b8a-5372-9b90-0c9aee199e5d";

    fn avif() -> Vec<u8> {
        let mut v = vec![0, 0, 0, 0x1c];
        v.extend_from_slice(b"ftypavif\0\0\0\0avifmif1miaf");
        v.extend_from_slice(b"rest-of-file");
        v
    }

    #[test]
    fn note_image_id_rejects_non_canonical_forms() {
        assert!(is_canonical_note_image_id(A));
        let bads: Vec<String> = vec![
            "".into(),
            "..".into(),
            "../x".into(),
            "a/b".into(),
            "a\\b".into(),
            A.to_uppercase(),
            format!("{{{A}}}"),
            format!("urn:uuid:{A}"),
            A.replace('-', ""),
            A[..35].into(),
            format!("{A}0"),
            format!(" {A}"),
            format!("{A}/../x"),
            format!("../{A}"),
        ];
        for bad in &bads {
            assert!(!is_canonical_note_image_id(bad), "accepted {bad:?}");
        }
    }

    #[test]
    fn note_image_uuids_in_scans_raw_bytes_and_half_deleted_tokens() {
        let text = format!(r#"{{"p":[{{"text":"![x](memo-img/{A}.avif#w=320) memo-img/{B}.av {}"}}]}}"#, C.to_uppercase());
        let got = uuids_in(text.as_bytes());
        assert!(got.contains(A) && got.contains(B));
        assert_eq!(got.len(), 2, "uppercase is not a reference form: {got:?}");
        assert!(uuids_in(b"\xff\xfe garbage").is_empty());
    }

    #[test]
    fn note_image_orphans_exclude_referenced_corrupt_only_and_foreign_names() {
        let notes = format!("memo-img/{A}.avif");
        let corrupt = format!("broken json ... {B}");
        let mut referenced = uuids_in(notes.as_bytes());
        referenced.extend(uuids_in(corrupt.as_bytes()));
        let files = vec![
            format!("{A}.avif"),
            format!("{B}.avif"),
            format!("{C}.avif"),
            format!("{D}.png"),
            format!("{}.avif", D.to_uppercase()),
            "notes.avif".to_string(),
            format!("{D}.avif.tmp"),
            format!("../{D}.avif"),
        ];
        assert_eq!(orphan_note_images(&files, &referenced), vec![format!("{C}.avif")]);
    }

    #[test]
    fn note_image_orphan_expiry_is_30_days_from_now() {
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        assert!(!orphan_expired(now - day * 29, now));
        assert!(orphan_expired(now - day * 31, now));
        assert!(!orphan_expired(now + day, now), "future mtime is not expired");
    }

    #[test]
    fn note_image_put_validates_and_never_reuses_an_id() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(NOTE_IMAGES_DIR);
        put_note_image_at(&dir, A, &avif()).unwrap();
        assert_eq!(fs::read(dir.join(format!("{A}.avif"))).unwrap(), avif());
        assert_eq!(put_note_image_at(&dir, A, b"other").unwrap_err().code, ErrorCode::Io);
        assert_eq!(put_note_image_at(&dir, A, &avif()).unwrap_err().code, ErrorCode::AlreadyExists);
        assert_eq!(fs::read(dir.join(format!("{A}.avif"))).unwrap(), avif(), "existing file untouched");

        let mut heic = avif();
        heic[8..12].copy_from_slice(b"heic");
        heic[16..20].copy_from_slice(b"heic");
        assert!(put_note_image_at(&dir, B, &heic).is_err());
        assert!(put_note_image_at(&dir, B, &vec![0u8; MAX_NOTE_IMAGE_BYTES + 1]).is_err());
        assert!(put_note_image_at(&dir, "../escape", &avif()).is_err());
        assert!(!dir.join(format!("{B}.avif")).exists());

        fs::create_dir_all(dir.join(ORPHAN_DIR)).unwrap();
        fs::write(dir.join(ORPHAN_DIR).join(format!("{C}.avif")), avif()).unwrap();
        assert_eq!(put_note_image_at(&dir, C, &avif()).unwrap_err().code, ErrorCode::AlreadyExists);
    }

    #[test]
    fn note_image_get_restores_from_orphan_and_reports_missing() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join(NOTE_IMAGES_DIR);
        fs::create_dir_all(dir.join(ORPHAN_DIR)).unwrap();
        fs::write(dir.join(ORPHAN_DIR).join(format!("{A}.avif")), avif()).unwrap();
        assert_eq!(get_note_image_at(&dir, A).unwrap(), avif());
        assert!(dir.join(format!("{A}.avif")).is_file());
        assert!(!dir.join(ORPHAN_DIR).join(format!("{A}.avif")).exists());

        let e = get_note_image_at(&dir, B).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert!(e.message.contains(B), "{}", e.message);
        assert!(get_note_image_at(&dir, &A.to_uppercase()).is_err());
    }

    #[test]
    fn note_image_sweep_moves_unreferenced_and_deletes_only_expired_orphans() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let dir = root.join(NOTE_IMAGES_DIR);
        let orphan = dir.join(ORPHAN_DIR);
        fs::create_dir_all(&orphan).unwrap();
        for id in [A, B, C] {
            fs::write(dir.join(format!("{id}.avif")), avif()).unwrap();
        }
        let upper = format!("{}.avif", D.to_uppercase());
        fs::write(dir.join(&upper), avif()).unwrap();
        let now = SystemTime::now();
        let old = now - Duration::from_secs(40 * 86_400);
        // C 는 오래전에 만들어졌다 — 옮겨진 회차에 바로 지워지면 안 된다.
        File::options().write(true).open(dir.join(format!("{C}.avif"))).unwrap().set_modified(old).unwrap();
        fs::write(orphan.join(format!("{D}.avif")), avif()).unwrap();
        File::options().write(true).open(orphan.join(format!("{D}.avif"))).unwrap().set_modified(old).unwrap();
        fs::write(orphan.join("keep.txt"), b"x").unwrap();
        File::options().write(true).open(orphan.join("keep.txt")).unwrap().set_modified(old).unwrap();

        // notes.json 이 없으면 아무것도 하지 않는다.
        sweep_note_images_at(root, now);
        assert!(dir.join(format!("{C}.avif")).exists());
        assert!(orphan.join(format!("{D}.avif")).exists());

        fs::write(root.join(state::NOTES_FILE), format!("memo-img/{A}.avif")).unwrap();
        fs::write(root.join("notes.corrupt"), format!("memo-img/{B}.avif")).unwrap();
        sweep_note_images_at(root, now);
        assert!(dir.join(format!("{A}.avif")).exists());
        assert!(dir.join(format!("{B}.avif")).exists(), "referenced only by the quarantined copy");
        assert!(dir.join(&upper).exists(), "non-canonical names are never touched");
        assert!(!dir.join(format!("{C}.avif")).exists());
        let moved = orphan.join(format!("{C}.avif"));
        assert!(moved.exists(), "moved, not deleted, even though it was old");
        assert!(!orphan_expired(fs::metadata(&moved).unwrap().modified().unwrap(), now));
        assert!(!orphan.join(format!("{D}.avif")).exists(), "expired orphan deleted");
        assert!(orphan.join("keep.txt").exists(), "foreign files in orphan are kept");
    }
}
