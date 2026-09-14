//! 큰 바이너리 파일의 raw IPC 읽기·원자적 쓰기 — PDF 뷰어/편집기(DOCS/pdf-viewer-editor-design.md §9).
//!
//! `read_file_base64`(25MB)·`write_file_bytes`(64MB)는 base64 문자열을 오가므로 사본이 두 벌 생기고
//! 상한이 낮다. 여기는 `ipc::Response`(응답)와 `InvokeBody::Raw`(요청 본문)로 바이트를 그대로 넘긴다.
//!
//! 쓰기는 **같은 폴더의 임시 파일에 다 쓰고 fsync 한 뒤 rename** 한다. `tokio::fs::write` 직행은
//! 쓰는 도중 죽거나 디스크가 차면 원본이 반쯤 잘린 채 남는다 — 사용자 문서(PDF)에서는 그게 곧 손실이다.
//!
//! `append` 모드는 PDF 증분 업데이트 전용이다. 증분의 xref 오프셋과 `/Prev` 는 **호출자가 읽은
//! 바이트 길이 기준의 절대값**이라, 다른 내용 뒤에 붙으면 파일이 조용히 깨진다. 그래서 stamp 와
//! 길이 둘 다 필수이고, 복사 직후에 한 번 더 대조한다(검사와 복사 사이에 파일이 바뀌는 창을 닫는다).

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

use super::diff::stamp_of;
use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// raw IPC 상한. base64 경로와 달리 문자열 사본이 없지만, 프론트에서 pdf.js 워커 사본과
/// pdf-lib 파싱 그래프가 붙는다(설계 §14). ponytail: 추정치 — S0-3 실측 뒤 조정.
const MAX_RAW_BYTES: u64 = 256 * 1024 * 1024;

fn too_large() -> IpcError {
    IpcError::new(ErrorCode::Io, "파일이 너무 큽니다 (256MB 초과)")
}

/// 읽기 전 메타의 stamp. 파일이 아니거나 메타를 못 읽으면 None.
#[tauri::command]
pub async fn file_stamp(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<Option<String>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    Ok(tokio::fs::metadata(&target)
        .await
        .ok()
        .filter(|m| m.is_file())
        .as_ref()
        .and_then(stamp_of))
}

/// 워크트리 파일을 raw 바이트로. 크기를 먼저 보고 읽는다(`read_file_base64` 와 같은 순서).
#[tauri::command]
pub async fn read_file_raw(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<Response, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|_| IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"))?;
    if !meta.is_file() {
        return Err(IpcError::new(ErrorCode::Io, "파일이 아닙니다"));
    }
    if meta.len() > MAX_RAW_BYTES {
        return Err(too_large());
    }
    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 읽기 실패: {e}")))?;
    if bytes.len() as u64 > MAX_RAW_BYTES {
        return Err(too_large()); // 메타 이후 커진 경우의 백스톱
    }
    Ok(Response::new(bytes))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawWriteMode {
    Append,
    Replace,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RawWriteArgs {
    pub project_id: String,
    pub rel_path: String,
    pub mode: RawWriteMode,
    pub expected_stamp: Option<String>,
    pub base_len: Option<u64>,
    pub overwrite: bool,
}

/// 헤더 → 인자. 헤더 값은 ASCII 만 허용되므로 한글 경로는 `x-gpv-path-b64`(UTF-8 base64)로 받는다.
pub(crate) fn parse_write_headers(h: &tauri::http::HeaderMap) -> Result<RawWriteArgs, IpcError> {
    let bad = |m: &str| IpcError::new(ErrorCode::Io, format!("write_file_raw: {m}"));
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let project_id = get("x-gpv-project").ok_or_else(|| bad("x-gpv-project 헤더 누락"))?;
    let rel_path = get("x-gpv-path-b64")
        .ok_or_else(|| bad("x-gpv-path-b64 헤더 누락"))
        .and_then(|b| B64.decode(b).map_err(|_| bad("경로 base64 디코딩 실패")))
        .and_then(|v| String::from_utf8(v).map_err(|_| bad("경로가 UTF-8 이 아닙니다")))?;
    let mode = match get("x-gpv-mode").as_deref() {
        Some("append") => RawWriteMode::Append,
        Some("replace") => RawWriteMode::Replace,
        _ => return Err(bad("x-gpv-mode 는 append | replace")),
    };
    let expected_stamp = get("x-gpv-expected-stamp").filter(|s| !s.is_empty());
    let base_len = match get("x-gpv-base-len") {
        Some(s) => Some(s.parse::<u64>().map_err(|_| bad("x-gpv-base-len 이 숫자가 아닙니다"))?),
        None => None,
    };
    let overwrite = get("x-gpv-overwrite").as_deref() == Some("1");
    if mode == RawWriteMode::Append && (expected_stamp.is_none() || base_len.is_none()) {
        return Err(bad("append 에는 x-gpv-expected-stamp 와 x-gpv-base-len 이 필요합니다"));
    }
    Ok(RawWriteArgs { project_id, rel_path, mode, expected_stamp, base_len, overwrite })
}

/// 원자적 raw 쓰기. 본문은 `InvokeBody::Raw` 여야 한다. 성공하면 쓴 직후의 새 stamp.
#[tauri::command]
pub async fn write_file_raw(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<Option<String>, IpcError> {
    let args = parse_write_headers(request.headers())?;
    let InvokeBody::Raw(body) = request.body() else {
        return Err(IpcError::new(ErrorCode::Io, "write_file_raw: raw 본문이 필요합니다"));
    };
    if body.len() as u64 > MAX_RAW_BYTES {
        return Err(too_large());
    }
    let repo = project_path(&state, &args.project_id)?;
    let target = resolve_in_repo(&repo, &args.rel_path)?;
    let body = body.clone();
    tokio::task::spawn_blocking(move || write_raw_at(&target, &body, &args))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("쓰기 작업 실패: {e}")))?
}

fn conflict() -> IpcError {
    IpcError::new(ErrorCode::Conflict, "이 파일이 편집을 시작한 뒤 외부에서 바뀌었습니다")
}

fn io_err(e: std::io::Error) -> IpcError {
    // Windows: 32 = 공유 위반(다른 프로그램이 열고 있음). rename 이 여기서 가장 흔히 막힌다.
    if cfg!(windows) && e.raw_os_error() == Some(32) {
        return IpcError::new(ErrorCode::Io, "다른 프로그램이 이 파일을 열고 있어 저장하지 못했습니다");
    }
    IpcError::new(ErrorCode::Io, format!("파일 저장 실패: {e}"))
}

fn tmp_path(target: &Path) -> PathBuf {
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!(".{name}.gpv-tmp-{}", uuid::Uuid::new_v4().simple()))
}

/// 동기 코어 — 단위 테스트가 `State` 없이 부른다.
pub(crate) fn write_raw_at(target: &Path, body: &[u8], a: &RawWriteArgs) -> Result<Option<String>, IpcError> {
    let meta = fs::symlink_metadata(target).ok();
    if let Some(m) = &meta {
        if m.file_type().is_symlink() {
            return Err(IpcError::new(ErrorCode::Io, "심볼릭 링크에는 쓸 수 없습니다"));
        }
        if m.is_dir() {
            return Err(IpcError::new(ErrorCode::Io, "디렉토리에는 쓸 수 없습니다"));
        }
    }
    // 대조 규칙: append 는 stamp(가능하면)·길이 **둘 다** 필수, replace 는 stamp 를 줬을 때만.
    let matches = |m: &fs::Metadata| -> bool {
        let stamp_ok = match (a.expected_stamp.as_deref(), stamp_of(m)) {
            (Some(want), Some(now)) => want == now,
            _ => true, // mtime 을 못 얻는 파일시스템 — 길이 대조에 맡긴다
        };
        stamp_ok && a.base_len.is_none_or(|len| m.len() == len)
    };
    match a.mode {
        RawWriteMode::Append => {
            let m = meta.as_ref().ok_or_else(|| IpcError::new(ErrorCode::NotFound, "대상 파일이 없습니다"))?;
            if !matches(m) {
                return Err(conflict());
            }
        }
        RawWriteMode::Replace => match &meta {
            Some(_) if !a.overwrite => {
                return Err(IpcError::new(ErrorCode::AlreadyExists, "이미 같은 이름의 파일이 있습니다"))
            }
            Some(m) if a.expected_stamp.is_some() && !matches(m) => return Err(conflict()),
            _ => {}
        },
    }

    let tmp = tmp_path(target);
    let run = || -> Result<(), IpcError> {
        let mut f = match a.mode {
            RawWriteMode::Append => {
                fs::copy(target, &tmp).map_err(io_err)?;
                // 검사와 복사 사이에 바뀌었는지 — 복사본 길이와 원본 메타를 한 번 더 본다.
                let copied = fs::metadata(&tmp).map_err(io_err)?.len();
                let now = fs::symlink_metadata(target).map_err(io_err)?;
                if Some(copied) != a.base_len || !matches(&now) {
                    return Err(conflict());
                }
                OpenOptions::new().append(true).open(&tmp).map_err(io_err)?
            }
            RawWriteMode::Replace => File::create(&tmp).map_err(io_err)?,
        };
        f.write_all(body).map_err(io_err)?;
        f.sync_all().map_err(io_err)?;
        drop(f);
        fs::rename(&tmp, target).map_err(io_err)
    };
    if let Err(e) = run() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(fs::metadata(target).ok().as_ref().and_then(stamp_of))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{HeaderMap, HeaderValue};

    fn args(mode: RawWriteMode, stamp: Option<String>, base_len: Option<u64>, overwrite: bool) -> RawWriteArgs {
        RawWriteArgs { project_id: "p".into(), rel_path: "a.pdf".into(), mode, expected_stamp: stamp, base_len, overwrite }
    }
    fn tmp_leftovers(dir: &Path) -> usize {
        fs::read_dir(dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".gpv-tmp-")).count()
    }

    #[test]
    fn append_writes_original_then_body() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.pdf");
        fs::write(&p, b"%PDF-orig").unwrap();
        let st = stamp_of(&fs::metadata(&p).unwrap());
        let new = write_raw_at(&p, b"+inc", &args(RawWriteMode::Append, st, Some(9), false)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"%PDF-orig+inc");
        assert!(new.is_some());
        assert_eq!(tmp_leftovers(d.path()), 0);
    }

    #[test]
    fn append_rejects_length_mismatch_and_leaves_file_untouched() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.pdf");
        fs::write(&p, b"%PDF-orig").unwrap();
        let st = stamp_of(&fs::metadata(&p).unwrap());
        let e = write_raw_at(&p, b"+inc", &args(RawWriteMode::Append, st, Some(8), false)).unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(fs::read(&p).unwrap(), b"%PDF-orig");
        assert_eq!(tmp_leftovers(d.path()), 0);
    }

    #[test]
    fn append_rejects_stamp_mismatch() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("a.pdf");
        fs::write(&p, b"%PDF-orig").unwrap();
        let e = write_raw_at(&p, b"+inc", &args(RawWriteMode::Append, Some("1:9".into()), Some(9), false)).unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(fs::read(&p).unwrap(), b"%PDF-orig");
    }

    #[test]
    fn append_requires_existing_target() {
        let d = tempfile::tempdir().unwrap();
        let e = write_raw_at(&d.path().join("none.pdf"), b"x", &args(RawWriteMode::Append, Some("1:0".into()), Some(0), false)).unwrap_err();
        assert_eq!(e.code, ErrorCode::NotFound);
        assert_eq!(tmp_leftovers(d.path()), 0);
    }

    #[test]
    fn replace_creates_new_and_guards_existing() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("b.pdf");
        write_raw_at(&p, b"new", &args(RawWriteMode::Replace, None, None, false)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new");
        let e = write_raw_at(&p, b"again", &args(RawWriteMode::Replace, None, None, false)).unwrap_err();
        assert_eq!(e.code, ErrorCode::AlreadyExists);
        write_raw_at(&p, b"again", &args(RawWriteMode::Replace, None, None, true)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"again");
        assert_eq!(tmp_leftovers(d.path()), 0);
    }

    #[test]
    fn headers_decode_korean_path_and_require_append_guards() {
        let mut h = HeaderMap::new();
        h.insert("x-gpv-project", HeaderValue::from_static("p1"));
        h.insert("x-gpv-path-b64", HeaderValue::from_str(&B64.encode("문서/보고서.pdf")).unwrap());
        h.insert("x-gpv-mode", HeaderValue::from_static("append"));
        let e = parse_write_headers(&h).unwrap_err();
        assert!(e.message.contains("append"), "{}", e.message);
        h.insert("x-gpv-expected-stamp", HeaderValue::from_static("123:45"));
        h.insert("x-gpv-base-len", HeaderValue::from_static("45"));
        let a = parse_write_headers(&h).unwrap();
        assert_eq!(a.rel_path, "문서/보고서.pdf");
        assert_eq!(a.mode, RawWriteMode::Append);
        assert_eq!(a.base_len, Some(45));
        h.insert("x-gpv-mode", HeaderValue::from_static("delete"));
        assert!(parse_write_headers(&h).is_err());
    }
}
