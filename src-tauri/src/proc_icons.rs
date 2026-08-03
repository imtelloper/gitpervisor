//! 리소스 모니터 프로세스 아이콘 — exe 경로에서 아이콘을 추출해 base64 PNG data URI로.
//!
//! 아이콘은 정적이라 **경로별 1회만 추출**하고 캐시한다(스냅샷 핫패스 밖, 별도 뮤텍스라
//! 2s 폴링과 무간섭). 프론트도 경로→dataURI를 세션 캐시해 경로당 1회만 요청한다.
//! 실패(권한·아이콘 없음)는 None으로 캐시해 무한 재시도를 막는다.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use tauri::State;

use crate::state::AppState;

/// 캐시 상한(경로 수). 아이콘은 경로당 수 KB 수준이라 무제한이면 프로세스가 계속 갈리는
/// 머신(빌드 서버·CI 러너)에서 팝업을 오래 켜둘수록 단조 증가한다 — 되찾을 계기가 없는 메모리다.
/// 2000개면 실사용 상한(동시에 뜨는 서로 다른 exe 경로)을 크게 웃돈다.
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_ICONS: usize = 2000;

/// exe 경로 → base64 PNG data URI(추출 성공) / None(실패, 재시도 안 함).
/// **비Windows에서는 이 캐시를 아예 쓰지 않는다**(추출기가 없어 결과가 항상 비어 있음).
#[derive(Default)]
pub struct IconCache(#[cfg_attr(not(windows), allow(dead_code))] Mutex<IconStore>);

/// 상한이 있는 아이콘 저장소. 정확한 LRU 대신 **삽입 순서 FIFO**로 버린다 —
/// 아이콘은 정적이라 다시 뽑는 비용이 낮고, 상한의 목적은 재사용률 극대화가 아니라
/// "무한 증가 차단"이기 때문(간단할수록 틀릴 여지가 없다).
#[derive(Default)]
struct IconStore {
    map: HashMap<String, Option<String>>,
    /// 삽입 순서 — 상한 초과 시 앞(가장 오래된 것)부터 버린다.
    order: VecDeque<String>,
}

impl IconStore {
    /// 추출 결과를 캐시한다(성공=Some, 실패=None 둘 다 — 실패 캐시가 무한 재시도를 막는다).
    fn insert(&mut self, path: String, uri: Option<String>) {
        if self.map.insert(path.clone(), uri).is_none() {
            self.order.push_back(path);
        }
        while self.order.len() > MAX_ICONS {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }
}

/// 캐시 미스만 추출해 채우고 성공한 것만 (경로 → dataURI)로 돌려주는 본체.
/// 추출기를 인자로 받는 이유는 플랫폼 API 없이도 캐시 동작(미스만 추출·실패도 캐시·상한)을
/// 테스트할 수 있게 하기 위해서다 — Windows 전용 블록 안에 두면 Windows 밖에서는 컴파일조차
/// 되지 않아 회귀가 늦게 발견된다.
#[cfg_attr(not(windows), allow(dead_code))]
fn collect_icons(
    store: &mut IconStore,
    paths: Vec<String>,
    extract: impl Fn(&str) -> Option<String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for path in paths {
        if !store.map.contains_key(&path) {
            let uri = extract(&path);
            store.insert(path.clone(), uri);
        }
        if let Some(Some(uri)) = store.map.get(&path) {
            out.insert(path, uri.clone());
        }
    }
    out
}

/// 프로세스 아이콘 배치 조회 — 캐시에 없는 경로만 추출한다. 성공한 것만 맵에 담아 반환
/// (실패·미지원은 생략 → 프론트가 기본 아이콘으로 폴백). 스냅샷의 exePath를 키로 쓴다.
#[cfg(windows)]
#[tauri::command]
pub fn get_process_icons(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> HashMap<String, String> {
    let mut cache = state.icons.0.lock().unwrap();
    collect_icons(&mut cache, paths, extract_icon_data_uri)
}

/// 비Windows판 — 추출기 자체가 없어 결과가 **항상 빈 맵**이다. 그런데도 예전에는 경로마다
/// `None` 엔트리를 캐시에 채워 넣어, 아무 쓸모 없는 String 키가 프로세스 수만큼 쌓였다
/// (락 경합·메모리 둘 다 순손해). 락도 잡지 않고 즉시 반환한다.
#[cfg(not(windows))]
#[tauri::command]
pub fn get_process_icons(
    state: State<'_, AppState>,
    _paths: Vec<String>,
) -> HashMap<String, String> {
    // 캐시는 **잡지도 채우지도 않는다**(락 경합·메모리 순손해). 필드 참조만 남겨 두는 이유는
    // AppState(다른 영역 소유)가 플랫폼별로 갈라지지 않게 하기 위해서다 — 참조가 하나도 없으면
    // `field icons is never read` 경고가 state.rs에 뜬다. 비용은 0(주소만 잠깐 잡았다 버림).
    let _ = &state.icons;
    HashMap::new()
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

// 비Windows에는 extract_icon_data_uri 자체를 두지 않는다 — 항상 None을 주는 스텁이 있으면
// "호출은 되지만 결과는 없는" 경로가 살아남는다. 커맨드에서 조기 반환하는 편이 정직하다.

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

#[cfg(test)]
mod tests {
    use super::*;

    /// 상한 계약: MAX_ICONS를 넘으면 **가장 오래 전에 넣은 것부터** 사라지고, 총량은 상한을
    /// 넘지 않는다(맵과 순서 큐가 함께 줄어야 한다 — 한쪽만 줄면 그게 곧 새로운 누수다).
    #[test]
    fn icon_store_evicts_oldest_over_cap() {
        let mut s = IconStore::default();
        for i in 0..MAX_ICONS + 10 {
            s.insert(format!("/p/{i}"), Some(format!("uri{i}")));
        }
        assert_eq!(s.map.len(), MAX_ICONS);
        assert_eq!(s.order.len(), MAX_ICONS);
        assert!(!s.map.contains_key("/p/0"), "가장 오래된 항목이 남았다");
        assert!(!s.map.contains_key("/p/9"));
        assert!(s.map.contains_key("/p/10"), "상한 안의 항목까지 지웠다");
        assert!(s.map.contains_key(&format!("/p/{}", MAX_ICONS + 9)));
    }

    /// 같은 경로를 다시 넣어도 순서 큐가 중복으로 늘지 않는다 —
    /// 늘어나면 큐만 무한 증가해 상한이 무력화된다.
    #[test]
    fn icon_store_reinsert_does_not_grow_order() {
        let mut s = IconStore::default();
        s.insert("/a".into(), Some("x".into()));
        s.insert("/a".into(), None);
        assert_eq!(s.order.len(), 1);
        assert_eq!(s.map.len(), 1);
        assert_eq!(s.map.get("/a"), Some(&None)); // 마지막 값으로 덮어쓴다
    }

    /// 배치 조회 계약: (1) 캐시 미스만 추출한다, (2) 실패(None)도 캐시해 재시도하지 않는다,
    /// (3) 성공한 것만 응답에 담는다.
    #[test]
    fn collect_icons_extracts_each_path_once() {
        use std::cell::RefCell;
        let mut store = IconStore::default();
        let calls = RefCell::new(Vec::new());
        let extract = |p: &str| {
            calls.borrow_mut().push(p.to_string());
            if p == "/ok" {
                Some("data:png".to_string())
            } else {
                None // 아이콘 없음·권한 부족
            }
        };

        let out = collect_icons(&mut store, vec!["/ok".into(), "/bad".into()], &extract);
        assert_eq!(out.get("/ok").map(String::as_str), Some("data:png"));
        assert!(!out.contains_key("/bad"), "실패는 응답에 담지 않는다");

        // 두 번째 라운드 — 캐시 히트라 추출기를 다시 부르면 안 된다(실패였던 경로 포함).
        let out2 = collect_icons(&mut store, vec!["/ok".into(), "/bad".into()], &extract);
        assert_eq!(out2, out);
        assert_eq!(calls.borrow().len(), 2, "캐시된 경로를 다시 추출했다");
    }
}
