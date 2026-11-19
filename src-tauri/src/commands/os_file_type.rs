//! OS 파일 유형 — 폴더 창 목록·그리드가 탐색기·Finder·파일 관리자와 같은 **아이콘과 유형 이름**을 보이게 한다
//! (사용자 요청 2026-11-16). 플랫폼 구현은 크레이트에 기대지 않는 파일 셋으로 나눠 둔다 — 그래야 이 Windows
//! 개발기에서도 macOS·Linux 쪽을 작은 검사 크레이트로 따로 컴파일해 볼 수 있다(`scripts/check-os-file-type-cross.sh`):
//!   Windows `os_file_type_windows.rs` — SHGetFileInfo(시스템 이미지 목록) → HICON → PNG
//!   macOS   `os_file_type_macos.rs`   — NSWorkspace iconForFile → 비트맵에 그려 PNG, 유형은 NSURL localizedTypeDescription
//!   Linux   `os_file_type_linux.rs`   — GIO 콘텐츠 유형 → GTK 아이콘 테마 → PNG
//!
//! 질의는 프론트가 **유형 하나에 하나만** 보낸다(`lib/os-file-type.ts` — 확장자 하나·폴더 하나, 실행 파일·바로가기처럼
//! 파일마다 아이콘이 다른 것만 파일 단위). 그래서 수천 장 폴더도 한 번에 수십 개다.
//!
//! 경로는 다른 `fav_*` 와 같은 `allowed` 를 지난다 — 루트 밖 파일의 존재·유형을 떠보는 통로가 되지 않게.
//! 항목 하나가 실패하면(그새 지워짐·OS 가 못 줌) 그 자리만 비우고 나머지는 준다 — 프론트는 빈 자리에 앱 아이콘과
//! "EXT 파일" 을 그린다. 스크린샷 폴더는 목록을 읽은 뒤 질의 전에 파일이 사라지는 일이 흔하다.

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use image::ImageEncoder as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::favorites::allowed;
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;
use crate::state::AppState;

#[cfg(windows)]
#[path = "os_file_type_windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "os_file_type_macos.rs"]
mod platform;
#[cfg(target_os = "linux")]
#[path = "os_file_type_linux.rs"]
mod platform;

/// 받는 아이콘 크기(px) — 목록 행(32)·그리드 칸(256) 둘뿐이다. 크기마다 OS 가 다른 이미지를 고르고 프론트가 크기별로 기억한다.
const OS_FILE_TYPE_PX: [u32; 2] = [32, 256];
/// 한 번에 받는 질의 수 상한 — 프론트는 256 개씩 나눠 보낸다.
const MAX_OS_FILE_TYPE_QUERIES: usize = 512;

/// 무엇의 유형인가 — 폴더 일반, 확장자(그 확장자의 아무 파일이나 대표로), 이 파일 자체(실행 파일 내장 아이콘 등).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OsTypeKind {
    Folder,
    Ext,
    File,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsTypeQuery {
    path: String,
    kind: OsTypeKind,
}

/// 플랫폼 구현이 돌려주는 날것 — 못 구한 칸은 None.
#[derive(Debug, Default)]
pub struct OsTypeFound {
    pub type_name: Option<String>,
    pub icon_png: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsFileType {
    type_name: Option<String>,
    /// `data:image/png;base64,…` — 수십 개뿐이고 작아서(32px ≈ 1~3KB) 스킴을 따로 두지 않는다.
    icon: Option<String>,
}

#[tauri::command(async)]
pub async fn fav_os_file_types(
    app: AppHandle,
    state: State<'_, AppState>,
    queries: Vec<OsTypeQuery>,
    px: u32,
) -> Result<Vec<OsFileType>, IpcError> {
    if !OS_FILE_TYPE_PX.contains(&px) || queries.len() > MAX_OS_FILE_TYPE_QUERIES {
        return Err(IpcError::new(ErrorCode::Io, text_files::invalid_path()));
    }
    // 루트 밖·없는 파일은 묻지 않고 빈 자리로 둔다(모듈 주석 — 하나 때문에 목록 전체 아이콘을 잃지 않게).
    // 묻는 경로는 게이트가 푼 것(canonicalize)이다 — Windows 셸은 `C:/…` 처럼 `/` 가 섞인 실제 경로를 못 찾는다.
    let checked: Vec<Option<(PathBuf, OsTypeKind)>> = queries
        .into_iter()
        .map(|q| allowed(&state, &q.path).ok().map(|p| (p, q.kind)))
        .collect();
    let asks: Vec<(PathBuf, OsTypeKind)> = checked.iter().flatten().cloned().collect();
    let mut found = lookup_on_platform_thread(app, asks, px).await?.into_iter();
    Ok(checked
        .iter()
        .map(|q| {
            let f = if q.is_some() { found.next().unwrap_or_default() } else { OsTypeFound::default() };
            OsFileType {
                type_name: f.type_name.filter(|s| !s.trim().is_empty()),
                icon: f.icon_png.map(|png| format!("data:image/png;base64,{}", B64.encode(png))),
            }
        })
        .collect())
}

/// Windows 셸 호출은 COM 을 쓰고 디스크(실행 파일 아이콘)를 읽으므로 blocking 풀에서 돈다.
#[cfg(windows)]
async fn lookup_on_platform_thread(
    _app: AppHandle,
    asks: Vec<(PathBuf, OsTypeKind)>,
    px: u32,
) -> Result<Vec<OsTypeFound>, IpcError> {
    tokio::task::spawn_blocking(move || platform::lookup_batch(&asks, px))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::os_file_type_failed(e)))
}

/// AppKit 그리기와 GTK 아이콘 테마는 메인 스레드 몫이다. 크레이트 안의 패닉이 메인 이벤트 루프로 새면 프로세스가
/// 통째로 abort 하므로 여기서 가둔다(`start_native_file_drag` 와 같은 이유).
#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn lookup_on_platform_thread(
    app: AppHandle,
    asks: Vec<(PathBuf, OsTypeKind)>,
    px: u32,
) -> Result<Vec<OsTypeFound>, IpcError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| platform::lookup_batch(&asks, px)));
        let _ = tx.send(r.map_err(|_| "panic".to_string()));
    })
    .map_err(|e| IpcError::new(ErrorCode::Io, text_files::os_file_type_failed(e)))?;
    match rx.await {
        Ok(Ok(found)) => Ok(found),
        Ok(Err(e)) => Err(IpcError::new(ErrorCode::Io, text_files::os_file_type_failed(e))),
        Err(_) => Err(IpcError::new(
            ErrorCode::Io,
            text_files::os_file_type_failed("main thread dropped the request"),
        )),
    }
}

/// 그 밖의 OS — 전부 빈 자리(프론트가 앱 아이콘을 그린다).
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn lookup_on_platform_thread(
    _app: AppHandle,
    asks: Vec<(PathBuf, OsTypeKind)>,
    _px: u32,
) -> Result<Vec<OsTypeFound>, IpcError> {
    Ok(asks.iter().map(|_| OsTypeFound::default()).collect())
}

/// RGBA 픽셀(위→아래 행)을 PNG 로. 셸 큰 아이콘(256)은 48px 짜리만 가진 옛 유형이면 **왼쪽 위 48 칸에만** 그려
/// 오고 나머지가 투명하다 — 그대로 늘려 그리면 아이콘이 칸 구석에 작게 박힌다. 그 경우 48 로 잘라 낸다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn rgba_icon_to_png(w: u32, h: u32, rgba: Vec<u8>) -> Option<Vec<u8>> {
    if w == 0 || h == 0 || rgba.len() != (w * h * 4) as usize {
        return None;
    }
    let mut img = image::RgbaImage::from_raw(w, h, rgba)?;
    let (mut max_x, mut max_y) = (0, 0);
    for (x, y, p) in img.enumerate_pixels() {
        if p[3] != 0 {
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    if w > 48 && h > 48 && max_x < 48 && max_y < 48 {
        img = image::imageops::crop_imm(&img, 0, 0, 48, 48).to_image();
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(png: &[u8]) -> image::RgbaImage {
        image::load_from_memory(png).expect("PNG 로 풀린다").to_rgba8()
    }

    #[test]
    fn pixels_survive_the_png_round_trip() {
        let png = rgba_icon_to_png(1, 1, vec![0, 0, 255, 255]).unwrap();
        assert_eq!(decode(&png).get_pixel(0, 0).0, [0, 0, 255, 255]);
    }

    #[test]
    fn jumbo_with_only_a_48px_icon_in_the_corner_is_cropped() {
        let mut px = vec![0u8; 256 * 256 * 4];
        let put = |px: &mut Vec<u8>, x: usize, y: usize| px[(y * 256 + x) * 4 + 3] = 255;
        put(&mut px, 10, 10);
        put(&mut px, 47, 47);
        let img = decode(&rgba_icon_to_png(256, 256, px.clone()).unwrap());
        assert_eq!(img.dimensions(), (48, 48), "왼쪽 위 48 칸만 그려졌으면 잘라 낸다");
        // 대조: 48 밖에 한 점이라도 있으면 진짜 256 아이콘이다 — 그대로 둔다.
        put(&mut px, 48, 10);
        let img = decode(&rgba_icon_to_png(256, 256, px).unwrap());
        assert_eq!(img.dimensions(), (256, 256));
    }

    #[test]
    fn malformed_pixels_are_rejected() {
        assert!(rgba_icon_to_png(0, 0, vec![]).is_none());
        assert!(rgba_icon_to_png(2, 2, vec![0; 15]).is_none(), "길이가 w*h*4 가 아니다");
    }

    #[test]
    fn query_kind_comes_in_lowercase() {
        let q: OsTypeQuery = serde_json::from_str(r#"{"path":"C:/x/a.pdf","kind":"ext"}"#).unwrap();
        assert_eq!(q.kind, OsTypeKind::Ext);
        assert!(serde_json::from_str::<OsTypeQuery>(r#"{"path":"a","kind":"Ext"}"#).is_err());
    }
}
