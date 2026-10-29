//! PDF 한글 임베드용 시스템 폰트 — 후보 탐색과 raw 읽기(DOCS/task/74-pdf-annotate-m2.md).
//!
//! 읽기는 **OS 폰트 폴더 하위의 ttf/otf/ttc 로만** 허용한다. 프론트가 넘기는 경로를 그대로 믿으면
//! 임의 파일 읽기 커맨드가 되므로, canonicalize(심볼릭 링크·`..` 해소) 뒤 폴더 포함 여부로 판정한다.
//! 굴림·바탕(EBDT 비트맵, 임베드 실패)과 가변 폰트는 후보에서 일부러 뺀다.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Response;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;

const MAX_FONT_BYTES: u64 = 64 * 1024 * 1024;
/// Linux 는 폰트가 `truetype/noto/` 처럼 하위에 흩어져 있다. Windows/macOS 는 평평하다.
const LINUX_SCAN_DEPTH: u32 = 4;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FontCandidate {
    pub path: String,
    pub family: String,
    pub collection: bool,
}

fn env_dir(var: &str, sub: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(|v| PathBuf::from(v).join(sub))
}

/// (폴더, 재귀 깊이). 존재 여부는 호출자가 걸러낸다.
fn font_roots() -> Vec<(PathBuf, u32)> {
    let mut v: Vec<(PathBuf, u32)> = Vec::new();
    if cfg!(windows) {
        v.extend(env_dir("WINDIR", "Fonts").map(|p| (p, 0)));
        v.extend(env_dir("LOCALAPPDATA", "Microsoft\\Windows\\Fonts").map(|p| (p, 0)));
    } else if cfg!(target_os = "macos") {
        v.push((PathBuf::from("/System/Library/Fonts"), 0));
        v.push((PathBuf::from("/Library/Fonts"), 0));
        v.extend(env_dir("HOME", "Library/Fonts").map(|p| (p, 0)));
    } else {
        v.push((PathBuf::from("/usr/share/fonts"), LINUX_SCAN_DEPTH));
        v.push((PathBuf::from("/usr/local/share/fonts"), LINUX_SCAN_DEPTH));
        v.extend(env_dir("HOME", ".local/share/fonts").map(|p| (p, LINUX_SCAN_DEPTH)));
        v.extend(env_dir("HOME", ".fonts").map(|p| (p, LINUX_SCAN_DEPTH)));
    }
    v
}

/// 파일명(소문자) → (우선순위, CSS family, ttc 여부). 우선순위가 작을수록 먼저.
fn rank_font_file(name_lower: &str) -> Option<(u8, &'static str, bool)> {
    // 가변 폰트는 pdf-lib/fontkit 서브셋이 깨진다.
    if name_lower.contains("vf") || name_lower.contains('[') || name_lower.contains("variable") {
        return None;
    }
    let rank = match name_lower {
        "pretendard-regular.otf" | "pretendard-regular.ttf" => (0, "Pretendard", false),
        "malgun.ttf" => (1, "Malgun Gothic", false), // malgunbd/malgunsl 은 이름이 달라 자연히 제외
        "notosanskr-regular.otf" | "notosanskr-regular.ttf" => (2, "Noto Sans KR", false),
        "applesdgothicneo.ttc" => (3, "Apple SD Gothic Neo", true),
        "notosanscjk-regular.ttc" => (4, "Noto Sans CJK KR", true),
        "notosanscjkkr-regular.otf" => (4, "Noto Sans CJK KR", false),
        "nanumgothic.ttf" | "nanumgothic-regular.ttf" => (5, "NanumGothic", false),
        _ => return None,
    };
    Some(rank)
}

/// 순수 정렬 코어: 파일 경로 목록 → 우선순위 순 후보. 같은 우선순위는 경로순(결정적).
fn rank_candidates(files: &[PathBuf]) -> Vec<FontCandidate> {
    let mut hits: Vec<(u8, &PathBuf, &'static str, bool)> = files
        .iter()
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().to_lowercase();
            let (r, fam, ttc) = rank_font_file(&name)?;
            Some((r, p, fam, ttc))
        })
        .collect();
    hits.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    hits.into_iter()
        .map(|(_, p, fam, ttc)| FontCandidate {
            path: p.to_string_lossy().into_owned(),
            family: fam.to_string(),
            collection: ttc,
        })
        .collect()
}

fn collect_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    // 읽을 수 없는 폴더는 후보가 없을 뿐 오류가 아니다 — 폰트 폴더는 OS마다 있고 없고가 정상.
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() && depth > 0 => collect_files(&p, depth - 1, out),
            Ok(t) if t.is_file() || t.is_symlink() => out.push(p),
            _ => {}
        }
    }
}

fn scan_candidates() -> Vec<FontCandidate> {
    let mut files = Vec::new();
    for (root, depth) in font_roots() {
        collect_files(&root, depth, &mut files);
    }
    rank_candidates(&files)
}

#[tauri::command(async)]
pub fn pdf_font_candidates() -> Result<Vec<FontCandidate>, IpcError> {
    Ok(scan_candidates())
}

/// 보안 경계의 순수 코어. canonical 경로와 canonical 루트들로 판정한다.
fn check_font_path(canon: &Path, canon_roots: &[PathBuf]) -> Result<(), IpcError> {
    let shown = canon.to_string_lossy();
    if !canon_roots.iter().any(|r| canon.starts_with(r)) {
        return Err(IpcError::new(ErrorCode::Io, text_files::font_path_outside_font_dirs(&shown)));
    }
    let ext_ok = canon
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .is_some_and(|e| matches!(e.as_str(), "ttf" | "otf" | "ttc"));
    if !ext_ok {
        return Err(IpcError::new(ErrorCode::Io, text_files::font_extension_not_allowed(&shown)));
    }
    Ok(())
}

fn read_font_checked(path: &str, roots: &[PathBuf]) -> Result<Vec<u8>, IpcError> {
    let canon = std::fs::canonicalize(path)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, text_files::font_read_failed(path, e)))?;
    let canon_roots: Vec<PathBuf> = roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).collect();
    check_font_path(&canon, &canon_roots)?;
    let shown = canon.to_string_lossy();
    let meta = std::fs::metadata(&canon)
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::font_read_failed(&shown, e)))?;
    if !meta.is_file() {
        return Err(IpcError::new(ErrorCode::Io, text_files::not_a_file()));
    }
    if meta.len() > MAX_FONT_BYTES {
        return Err(IpcError::new(ErrorCode::Io, text_files::font_too_large_64mb(&shown)));
    }
    std::fs::read(&canon).map_err(|e| IpcError::new(ErrorCode::Io, text_files::font_read_failed(&shown, e)))
}

#[tauri::command(async)]
pub fn font_read_raw(path: String) -> Result<Response, IpcError> {
    let roots: Vec<PathBuf> = font_roots().into_iter().map(|(p, _)| p).collect();
    read_font_checked(&path, &roots).map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn ranking_orders_by_priority_and_drops_variable_bitmap_and_bold() {
        let files = vec![
            p("/f/NanumGothic.ttf"),
            p("/f/malgunbd.ttf"),
            p("/f/gulim.ttc"),
            p("/f/batang.ttc"),
            p("/f/NotoSansKR[wght].ttf"),
            p("/f/NotoSansKR-VF.ttf"),
            p("/f/NotoSansKR-Regular.otf"),
            p("/f/malgun.ttf"),
            p("/f/Pretendard-Regular.otf"),
            p("/f/Pretendard-Bold.otf"),
            p("/f/AppleSDGothicNeo.ttc"),
            p("/f/NotoSansCJK-Regular.ttc"),
        ];
        let got: Vec<String> = rank_candidates(&files).into_iter().map(|c| c.family).collect();
        assert_eq!(
            got,
            ["Pretendard", "Malgun Gothic", "Noto Sans KR", "Apple SD Gothic Neo", "Noto Sans CJK KR", "NanumGothic"]
        );
        assert!(rank_candidates(&[p("/f/AppleSDGothicNeo.ttc")])[0].collection);
    }

    #[test]
    fn read_rejects_outside_root_and_bad_extension_and_dotdot() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let ok = root.path().join("a.ttf");
        fs::write(&ok, b"font").unwrap();
        let txt = root.path().join("a.txt");
        fs::write(&txt, b"x").unwrap();
        let outside = other.path().join("b.ttf");
        fs::write(&outside, b"font").unwrap();
        let roots = vec![root.path().to_path_buf()];

        assert_eq!(read_font_checked(ok.to_str().unwrap(), &roots).unwrap(), b"font");
        assert!(read_font_checked(txt.to_str().unwrap(), &roots).is_err());
        assert!(read_font_checked(outside.to_str().unwrap(), &roots).is_err());
        let sneaky = root.path().join("..").join(other.path().file_name().unwrap()).join("b.ttf");
        assert!(read_font_checked(sneaky.to_str().unwrap(), &roots).is_err());
        assert!(read_font_checked(root.path().join("none.ttf").to_str().unwrap(), &roots).is_err());
    }

    #[test]
    fn diagnostic_print_real_candidates() {
        for c in scan_candidates() {
            println!("font-candidate: {} | {} | ttc={}", c.family, c.path, c.collection);
        }
    }
}
