//! 리소스 모니터 프로세스 아이콘 — exe 경로에서 아이콘을 추출해 base64 PNG data URI로.
//!
//! 아이콘은 정적이라 **경로별 1회만 추출**하고 캐시한다(스냅샷 핫패스 밖, 별도 뮤텍스라
//! 2s 폴링과 무간섭). 프론트도 경로→dataURI를 세션 캐시해 경로당 1회만 요청한다.
//! 실패(권한·아이콘 없음)는 None으로 캐시해 무한 재시도를 막는다.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::State;

use crate::state::AppState;

/// exe 경로 → base64 PNG data URI(추출 성공) / None(실패, 재시도 안 함).
#[derive(Default)]
pub struct IconCache(Mutex<HashMap<String, Option<String>>>);

/// 프로세스 아이콘 배치 조회 — 캐시에 없는 경로만 추출한다. 성공한 것만 맵에 담아 반환
/// (실패·미지원은 생략 → 프론트가 기본 아이콘으로 폴백). 스냅샷의 exePath를 키로 쓴다.
#[tauri::command]
pub fn get_process_icons(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut cache = state.icons.0.lock().unwrap();
    for path in paths {
        let entry = cache
            .entry(path.clone())
            .or_insert_with(|| extract_icon_data_uri(&path));
        if let Some(uri) = entry {
            out.insert(path, uri.clone());
        }
    }
    out
}

/// exe 경로의 작은 아이콘(16×16)을 PNG로 인코딩해 `data:image/png;base64,…`로. 실패면 None.
#[cfg(windows)]
fn extract_icon_data_uri(path: &str) -> Option<String> {
    use base64::Engine;
    let rgba = win::icon_rgba(path)?;
    let img = image::RgbaImage::from_raw(rgba.w, rgba.h, rgba.pixels)?;
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Some(format!("data:image/png;base64,{b64}"))
}

#[cfg(not(windows))]
fn extract_icon_data_uri(_path: &str) -> Option<String> {
    None // 비Windows 아이콘 추출은 미지원(앱은 Windows 우선) — 프론트 기본 아이콘 폴백.
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::Shell::ExtractIconExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    pub struct IconRgba {
        pub w: u32,
        pub h: u32,
        pub pixels: Vec<u8>, // RGBA, top-down
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// exe 경로 → 아이콘 RGBA 픽셀(top-down). 실패면 None. 모든 GDI 핸들은 사용 후 해제.
    /// ExtractIconExW로 exe에 임베드된 아이콘(index 0)의 작은 버전(보통 16×16)을 뽑는다.
    pub fn icon_rgba(path: &str) -> Option<IconRgba> {
        unsafe {
            let wpath = wide(path);
            let mut hsmall: HICON = std::ptr::null_mut();
            let n = ExtractIconExW(wpath.as_ptr(), 0, std::ptr::null_mut(), &mut hsmall, 1);
            if n == 0 || hsmall.is_null() {
                return None;
            }
            let result = hicon_to_rgba(hsmall);
            DestroyIcon(hsmall);
            result
        }
    }

    /// HICON → RGBA. GetIconInfo로 컬러 비트맵을 얻고 GetDIBits(32bpp, top-down)로 픽셀을 뽑아
    /// BGRA→RGBA 변환. 알파가 전부 0인 레거시(24bpp+마스크) 아이콘은 불투명(255)으로 폴백한다.
    // ponytail: 마스크 비트맵 합성은 생략 — 32bpp ARGB(현대 앱 아이콘)만 정확, 레거시는 불투명 폴백.
    unsafe fn hicon_to_rgba(hicon: HICON) -> Option<IconRgba> {
        let mut ii: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut ii) == 0 {
            return None;
        }
        // GetIconInfo가 만든 비트맵들은 우리가 해제한다.
        let cleanup = |ii: &ICONINFO| {
            if !ii.hbmColor.is_null() {
                DeleteObject(ii.hbmColor as _);
            }
            if !ii.hbmMask.is_null() {
                DeleteObject(ii.hbmMask as _);
            }
        };
        if ii.hbmColor.is_null() {
            cleanup(&ii);
            return None;
        }

        // 비트맵 크기 조회.
        let mut bm: BITMAP = std::mem::zeroed();
        if GetObjectW(
            ii.hbmColor as _,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bm as *mut _ as *mut _,
        ) == 0
        {
            cleanup(&ii);
            return None;
        }
        let w = bm.bmWidth.max(0) as u32;
        let h = bm.bmHeight.max(0) as u32;
        if w == 0 || h == 0 {
            cleanup(&ii);
            return None;
        }

        // 32bpp, top-down(biHeight 음수)로 GetDIBits.
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w as i32;
        bmi.bmiHeader.biHeight = -(h as i32); // 음수 = top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB as u32;

        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(std::ptr::null_mut());
        let got = GetDIBits(
            hdc,
            ii.hbmColor,
            0,
            h,
            buf.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
        cleanup(&ii);
        if got == 0 {
            return None;
        }

        // BGRA → RGBA. 알파 존재 여부 확인용으로 스캔.
        let mut any_alpha = false;
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2); // B<->R
            if px[3] != 0 {
                any_alpha = true;
            }
        }
        if !any_alpha {
            // 알파가 전부 0(레거시 24bpp) — 불투명 처리.
            for px in buf.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
        Some(IconRgba { w, h, pixels: buf })
    }
}
