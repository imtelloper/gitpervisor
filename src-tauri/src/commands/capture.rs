//! 화면 영역 캡쳐 — 프리즈 프레임 + 오버레이 (`DOCS/screen-capture-design.md` M1).
//!
//! **지연이 기능의 전부다.** 사용자가 윈도우 기본 캡쳐를 버린 이유가 그것이고, 설계의 예산은
//! 단축키에서 선택 가능까지 100ms다. 그 예산을 지키는 결정 넷이 이 파일과 `lib.rs`에 흩어져 있다.
//!
//!  - **D1 커서가 있는 모니터 1장만 잡는다.** 가상 데스크톱 전체는 이 개발기 실측 299ms(5대,
//!    8960×3251)로 예산을 3배 넘긴다. 1대(2560×1440)는 38ms다.
//!  - **D2 표시용은 JPEG다.** 같은 프레임 PNG 인코드가 667ms/9.75MB — 그것만으로 예산이 끝난다.
//!  - **D3 원본 픽셀은 IPC를 안 건넌다.** 원시 BGRA는 1대에 14.7MB다. 프론트에는 표시용 JPEG
//!    (~0.4MB)만 주고, 클립보드로 나가는 최종 이미지는 여기 남은 **무손실 원본**에서 자른다.
//!  - **D4 오버레이 창을 재사용한다**(`lib.rs`). 새로 만들면 내용이 뜰 때까지 실측 1367ms다.
//!
//! **순서를 뒤집지 마라 — 오버레이를 띄우기 *전에* 캡쳐한다.** 반대로 하면 오버레이가 자기
//! 자신을 찍는다. 지금 구조에서는 그게 구조적으로 불가능하다.

use std::sync::Mutex;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{ErrorCode, IpcError};

/// 캡쳐 오버레이 창 라벨. `lib.rs`의 창 생성·`capabilities/default.json`과 같은 문자열이어야 한다.
pub const CAPTURE_OVERLAY_LABEL: &str = "capture";

/// 세션이 방치될 때 버퍼를 놓는 시각(초).
///
/// 오버레이가 정상 종료하면 즉시 해제되지만, **정리 경로가 하나뿐이면 언젠가 샌다**는 것은 이
/// 저장소가 비싸게 배운 교훈이다(`DOCS/process-leak-postmortem.md`). 1대에 14.7MB라 방치되면
/// 눈에 띄지 않게 상주한다.
const SESSION_TTL_SECS: u64 = 60;

/// 프리즈 프레임 원본. **이 구조체는 IPC로 나가지 않는다** — 나가는 것은 `SessionInfo`뿐이다.
struct Session {
    id: String,
    /// 모니터 로컬 top-down BGRA. 길이 = w*h*4.
    bgra: Vec<u8>,
    w: u32,
    h: u32,
    /// 이 프레임을 뜬 모니터의 가상 데스크톱 위치(오버레이를 올릴 자리). **음수일 수 있다.**
    mx: i32,
    my: i32,
    /// 표시용 JPEG data URL — **한 번만 인코딩한다.**
    ///
    /// 필요할 때마다 다시 만들면 `capture_current`를 부를 때마다 4K 프레임을 재인코딩한다
    /// (릴리스 벤치로도 120ms, 디버그는 초 단위). 원본 33MB 옆의 0.7MB는 사실상 공짜다.
    preview: String,
    born: Instant,
}

static CURRENT: Mutex<Option<Session>> = Mutex::new(None);

/// 오버레이에 넘기는 세션 정보 — 표시용 프레임과 그 크기뿐이다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    /// 프리즈 프레임의 실제 픽셀 크기(모니터 물리 해상도). 프론트의 좌표 환산 분모다.
    pub width: u32,
    pub height: u32,
    /// 표시 **전용** JPEG(q85) data URL. 최종 결과물은 여기서 뜨지 않는다(D3).
    pub preview: String,
}

/// 잘라낼 영역 — **모니터 로컬 픽셀**이다(가상 데스크톱 좌표가 아니다).
///
/// 가상 데스크톱 원점은 음수일 수 있고(이 개발기 실측 `(-2560, 0)`) 모니터마다 배율이 다르다.
/// 크롭 좌표를 프레임 버퍼 기준으로 고정하면 그 두 함정이 크롭 경로에 아예 들어오지 않는다.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct RectPx {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

// ─────────────────────────── 플랫폼 구현 ───────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    /// 커서가 올라가 있는 모니터의 가상 데스크톱 사각형(물리 픽셀).
    ///
    /// **좌표가 음수일 수 있다.** 주 모니터 왼쪽에 배치된 화면은 x가 음수다 — 부호 없는 타입으로
    /// 받으면 그 모니터에서 통째로 어긋난다.
    pub fn cursor_monitor() -> Result<(i32, i32, i32, i32), IpcError> {
        let mut pt = POINT { x: 0, y: 0 };
        // SAFETY: 우리 스택의 POINT 하나를 넘긴다.
        if unsafe { GetCursorPos(&mut pt) } == 0 {
            return Err(IpcError::new(ErrorCode::Io, "커서 위치를 읽지 못했습니다"));
        }
        // SAFETY: 반환 핸들은 소유하지 않는 모니터 핸들(해제 불필요).
        let mon = unsafe { MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST) };
        let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        // SAFETY: cbSize를 규격대로 채운 뒤 우리 스택 구조체를 넘긴다.
        if unsafe { GetMonitorInfoW(mon, &mut mi) } == 0 {
            return Err(IpcError::new(ErrorCode::Io, "모니터 정보를 읽지 못했습니다"));
        }
        let r = mi.rcMonitor;
        Ok((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }

    /// 화면 DC에서 사각형 하나를 top-down BGRA로 긁어온다.
    ///
    /// `biHeight`를 **음수**로 줘 top-down DIB을 받는다 — 기본(bottom-up)으로 받으면 행을 뒤집는
    /// 복사가 한 번 더 필요하다(1대에 14.7MB를 다시 만지는 셈).
    ///
    /// `CAPTUREBLT`는 쓰지 않는다. DWM 합성 환경에서는 화면 DC가 이미 레이어드 창을 포함하고,
    /// 저 플래그는 느린 데다 일부 구성에서 화면이 한 번 깜빡인다.
    pub fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, IpcError> {
        if w <= 0 || h <= 0 {
            return Err(IpcError::new(ErrorCode::Io, "캡쳐 크기가 올바르지 않습니다"));
        }
        let px = (w as usize) * (h as usize) * 4;
        let mut buf = vec![0u8; px];

        // SAFETY: 아래 블록은 GDI 객체를 만들고 반드시 같은 경로에서 되돌린다. 실패 시에도
        // 조기 반환 없이 정리 후 결과를 판정한다 — 중간에 return하면 DC/비트맵이 샌다.
        let ok = unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(IpcError::new(ErrorCode::Io, "화면 DC를 얻지 못했습니다"));
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let mut done = false;
            if !mem.is_null() && !bmp.is_null() {
                let old = SelectObject(mem, bmp as *mut c_void);
                if BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY) != 0 {
                    let mut bi: BITMAPINFO = std::mem::zeroed();
                    bi.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -h, // 음수 = top-down (위 주석)
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        biSizeImage: 0,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 0,
                        biClrImportant: 0,
                    };
                    let got = GetDIBits(
                        mem,
                        bmp,
                        0,
                        h as u32,
                        buf.as_mut_ptr() as *mut c_void,
                        &mut bi,
                        DIB_RGB_COLORS,
                    );
                    done = got == h;
                }
                SelectObject(mem, old);
            }
            if !bmp.is_null() {
                DeleteObject(bmp as *mut c_void);
            }
            if !mem.is_null() {
                DeleteDC(mem);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            done
        };

        if !ok {
            return Err(IpcError::new(ErrorCode::Io, "화면을 읽지 못했습니다"));
        }
        Ok(buf)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    fn unsupported<T>() -> Result<T, IpcError> {
        Err(IpcError::new(
            ErrorCode::Io,
            "화면 캡쳐는 아직 Windows에서만 지원합니다",
        ))
    }
    pub fn cursor_monitor() -> Result<(i32, i32, i32, i32), IpcError> {
        unsupported()
    }
    pub fn grab(_x: i32, _y: i32, _w: i32, _h: i32) -> Result<Vec<u8>, IpcError> {
        unsupported()
    }
}

// ─────────────────────────── 픽셀 변환 ───────────────────────────

/// 프리뷰 긴 변 상한. 넘으면 정수배로 축소한다. **4K 이상만 걸린다**(2560은 그대로).
///
/// **이 상수의 근거는 실측이다.** 두 가지를 이번에 알게 됐다.
///
///  1. 이 개발기의 주 모니터는 DPI 인식 프로세스에서 **3840×2160**이다(150% 배율). 설계
///     §2.3의 숫자는 DPI 비인식 PowerShell로 잰 것이라 픽셀 수를 2.25배 과소평가했다.
///  2. `image` 크레이트의 JPEG 인코더는 OS 코덱(GDI+/WIC)보다 5~10배 느리다. 릴리스 벤치
///     (고대비 합성 이미지 = 최악): 1920×1080 91ms, 2560×1440 159ms, 3840×2160 **357ms**.
///
/// 그래서 4K만 절반으로 줄인다 — 3840×2160을 원본 해상도로 인코딩하면 그것만으로 예산의
/// 3배를 쓴다. 2560 이하는 그대로 둔다: 실제 화면은 합성 벤치보다 훨씬 평탄해서(같은 프레임
/// GDI+ 실측 0.39MB vs 벤치 3.11MB) 인코드가 몇 배 싸고, 축소하면 눈에 띄게 흐려진다.
///
/// 표시본을 줄여도 결과물은 안 상한다 — 최종 크롭은 항상 무손실 원본에서 뜬다. 줄어드는 것은
/// **조준용 그림의 선명도**뿐이고, 픽셀 단위 조준(루페·색상)은 원본을 직접 읽는다(M2).
///
/// 이게 부족하면 다음 수는 Windows **WIC**로 인코딩하는 것이다(OS 코덱, SIMD). 순수 Rust
/// 인코더를 계속 쓰면서 해상도를 더 깎는 것보다 그쪽이 옳다.
const PREVIEW_MAX_EDGE: u32 = 2600;

/// BGRA(top-down) → JPEG q85 data URL. **표시 전용**이다.
///
/// 손실 압축이어도 결과물 품질은 안 떨어진다 — 최종 크롭은 항상 원본 버퍼에서 뜬다. 표시본은
/// 사람이 조준하는 용도이고 q85면 충분하다. 반대로 PNG를 쓰면 예산이 통째로 날아간다(D2 —
/// 같은 프레임 실측 667ms).
fn preview_data_url(bgra: &[u8], w: u32, h: u32) -> Result<String, IpcError> {
    let step = (w.max(h).div_ceil(PREVIEW_MAX_EDGE)).max(1);
    let (ow, oh) = (w / step, h / step);
    if ow == 0 || oh == 0 {
        return Err(IpcError::new(ErrorCode::Io, "프리뷰 크기가 0입니다"));
    }

    // 미리 채운 버퍼에 인덱스로 쓴다. `push`로 바이트마다 용량을 확인하면 800만 픽셀 × 3에서
    // 그 검사만으로 디버그 빌드가 초 단위로 늘어난다.
    let mut rgb = vec![0u8; (ow as usize) * (oh as usize) * 3];
    let sw = w as usize;
    for oy in 0..oh as usize {
        let dst_row = oy * ow as usize * 3;
        let src_row0 = oy * step as usize;
        for ox in 0..ow as usize {
            let sx0 = ox * step as usize;
            // 박스 필터 — 단순 서브샘플링은 글자가 성기게 끊겨 창 경계를 못 읽는다.
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for dy in 0..step as usize {
                let base = ((src_row0 + dy) * sw + sx0) * 4;
                for dx in 0..step as usize {
                    let p = base + dx * 4;
                    b += bgra[p] as u32;
                    g += bgra[p + 1] as u32;
                    r += bgra[p + 2] as u32;
                }
            }
            let n = (step * step) as u32;
            let d = dst_row + ox * 3;
            rgb[d] = (r / n) as u8;
            rgb[d + 1] = (g / n) as u8;
            rgb[d + 2] = (b / n) as u8;
        }
    }

    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    enc.encode(&rgb, ow, oh, image::ExtendedColorType::Rgb8)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("프리뷰 인코딩 실패: {e}")))?;
    Ok(format!("data:image/jpeg;base64,{}", B64.encode(&out)))
}

/// 원본 버퍼에서 사각형을 잘라 RGBA로 만든다(클립보드·PNG 공용).
///
/// GDI가 준 32bpp BI_RGB의 알파 바이트는 **정의되지 않는다**(대개 0). 그대로 넘기면 클립보드
/// 이미지가 통째로 투명해진다 — 반드시 255로 채운다.
fn crop_rgba(s: &Session, r: RectPx) -> Result<(Vec<u8>, u32, u32), IpcError> {
    let (x, y, w, h) = (r.x, r.y, r.w, r.h);
    // checked_add — 프론트가 보낸 값이므로 x+w가 u32를 넘겨 감싸면 경계 검사가 통과해 버린다.
    let within = |a: u32, len: u32, max: u32| a.checked_add(len).is_some_and(|e| e <= max);
    if w == 0 || h == 0 || !within(x, w, s.w) || !within(y, h, s.h) {
        return Err(IpcError::new(
            ErrorCode::Io,
            "선택 영역이 화면 범위를 벗어났습니다",
        ));
    }
    let mut out = Vec::with_capacity((w as usize) * (h as usize) * 4);
    for row in 0..h {
        let start = (((y + row) as usize) * (s.w as usize) + x as usize) * 4;
        for p in s.bgra[start..start + (w as usize) * 4].chunks_exact(4) {
            out.push(p[2]);
            out.push(p[1]);
            out.push(p[0]);
            out.push(255);
        }
    }
    Ok((out, w, h))
}

// ─────────────────────────── 세션 ───────────────────────────

fn take_session(id: &str) -> Result<Session, IpcError> {
    let mut cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    // id가 다르면 **건드리지 않는다** — 늦게 도착한 이전 세션의 확정이 새 세션을 뺏으면
    // 방금 찍은 화면이 조용히 사라진다.
    if cur.as_ref().is_some_and(|s| s.id == id) {
        return Ok(cur.take().expect("바로 위에서 확인했다"));
    }
    Err(IpcError::new(
        ErrorCode::NotFound,
        "캡쳐 세션이 만료되었습니다",
    ))
}

/// TTL 감시 — 오버레이가 비정상 종료해도 14.7MB가 영구 잔류하지 않게 한다.
fn arm_ttl(id: String) {
    std::thread::Builder::new()
        .name("capture-ttl".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(SESSION_TTL_SECS));
            let mut cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
            if cur.as_ref().is_some_and(|s| s.id == id) {
                log::warn!("[capture] 세션 {id}이 {SESSION_TTL_SECS}초간 방치돼 해제합니다");
                *cur = None;
            }
        })
        .ok();
}

/// 오버레이를 그 모니터 위에 올리고 띄운다. 세션이 이미 바뀌었으면 아무것도 안 한다.
///
/// **반드시 메인 스레드에서 부른다.**
fn show_overlay_for(app: &AppHandle, id: &str) {
    let pos = {
        let cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
        match cur.as_ref() {
            Some(s) if s.id == id => (s.mx, s.my, s.w, s.h),
            _ => return, // 이미 확정·취소됐거나 다음 캡쳐로 넘어갔다
        }
    };
    let Some(win) = app.get_webview_window(CAPTURE_OVERLAY_LABEL) else {
        return;
    };
    let (x, y, w, h) = pos;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.show();
    crate::focus_window(&win);
}

/// 오버레이가 프레임을 못 그려도 창은 뜨게 하는 최후 보루.
///
/// 정상 경로는 `capture_overlay_ready`다. 그게 안 오는 경우(웹뷰 로드 실패, JS 예외)에 아무
/// 일도 안 일어나면 사용자에겐 **단축키가 고장 난 것**으로 보인다 — 원인을 알 방법이 없는
/// 가장 나쁜 실패 모드다. 늦게라도 띄우면 최소한 무슨 일이 있었는지 보인다.
fn arm_show_fallback(app: AppHandle, id: String) {
    std::thread::Builder::new()
        .name("capture-show-fallback".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let still = CURRENT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .as_ref()
                .is_some_and(|s| s.id == id);
            if !still {
                return;
            }
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || show_overlay_for(&app2, &id));
        })
        .ok();
}

/// 앱 종료 정리 — `shutdown_children`에서 부른다.
pub fn capture_release_all() {
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

// ─────────────────────────── 진입점 ───────────────────────────

/// 전역 단축키가 부르는 본체. **작업 스레드로 넘긴다.**
///
/// 전역 단축키 핸들러는 메인(이벤트 루프) 스레드에서 돈다. 거기서 BitBlt + JPEG 인코딩
/// (실측 합계 ~55ms)을 하면 그동안 앱의 모든 창이 멈춘다 — 캡쳐를 빠르게 만들려다 앱을
/// 끊기게 하는 셈이다. 창 조작만 `run_on_main_thread`로 되돌린다.
pub fn run_capture(app: &AppHandle) {
    let app = app.clone();
    std::thread::Builder::new()
        .name("capture".into())
        .spawn(move || {
            if let Err(e) = trigger_inner(&app) {
                log::error!("[capture] 캡쳐 실패: {}", e.message);
                // 오버레이가 이미 떠 있었다면 닫아 준다 — 빈 오버레이를 남기지 않는다.
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || hide_overlay(&app2));
            }
        })
        .ok();
}

fn trigger_inner(app: &AppHandle) -> Result<(), IpcError> {
    // **이미 캡쳐 중이면 아무것도 하지 않는다.** 오버레이가 화면을 덮고 있는데 다시 캡쳐하면
    // 그 오버레이가 그대로 프레임에 찍힌다(R8의 다른 얼굴). 세션은 60초 TTL이 있어 어떤
    // 경우에도 영구히 막히지 않는다.
    if CURRENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
    {
        log::debug!("[capture] 이미 선택 중 — 단축키 무시");
        return Ok(());
    }

    let t0 = Instant::now();
    let (mx, my, mw, mh) = imp::cursor_monitor()?;
    let bgra = imp::grab(mx, my, mw, mh)?;
    let t_grab = t0.elapsed();

    let (w, h) = (mw as u32, mh as u32);
    let preview = preview_data_url(&bgra, w, h)?;
    let id = uuid::Uuid::new_v4().to_string();
    let info = SessionInfo {
        id: id.clone(),
        width: w,
        height: h,
        preview: preview.clone(),
    };
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Session {
        id: id.clone(),
        bgra,
        w,
        h,
        mx,
        my,
        preview,
        born: Instant::now(),
    });
    arm_ttl(id.clone());

    // 창 조작은 메인 스레드에서. 창이 아직 없으면 여기서 만들어지므로 첫 호출만 느리다(설계 §4.4).
    //
    // **여기서 창을 띄우지 않는다.** 띄우는 것은 오버레이가 새 프레임을 실제로 그린 뒤
    // (`capture_overlay_ready`)다. 지금 띄우면 두 가지가 보인다: 창을 처음 만든 경우엔 웹뷰가
    // 로드될 때까지 1초 남짓 **검은 전체화면**, 두 번째부터는 React가 새 프레임을 칠하기 전
    // 수십 ms 동안 **직전 캡쳐 화면**. 후자가 특히 나쁘다 — 방금 찍은 것과 다른 그림이다.
    let app2 = app.clone();
    let t_ready = t0.elapsed();
    app.run_on_main_thread(move || {
        match crate::ensure_capture_overlay(&app2) {
            // 창이 방금 만들어졌다면 아직 리스너가 없다 — 오버레이가 마운트 시 capture_current를
            // 한 번 당겨 가므로(양쪽 경로) 이 emit이 유실돼도 화면은 뜬다.
            Ok(_) => {
                let _ = app2.emit("capture://begin", &info);
            }
            Err(e) => log::error!("[capture] 오버레이 준비 실패: {e}"),
        }
    })
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("메인 스레드 예약 실패: {e}")))?;

    arm_show_fallback(app.clone(), id);

    log::info!(
        "[capture] {mw}x{mh} @({mx},{my}) 캡쳐 {}ms · 프리뷰까지 {}ms",
        t_grab.as_millis(),
        t_ready.as_millis()
    );
    Ok(())
}

// ─────────────────────────── 커맨드 ───────────────────────────

/// 단축키와 같은 동작을 IPC로도 연다 — 설정 화면의 "지금 캡쳐"와 e2e가 쓴다.
#[tauri::command(async)]
pub fn capture_trigger(app: AppHandle) {
    run_capture(&app);
}

/// 오버레이가 마운트 직후 현재 세션을 당겨 간다(emit 유실 대비 — `trigger_inner` 주석).
#[tauri::command(async)]
pub fn capture_current() -> Option<SessionInfo> {
    let cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    let s = cur.as_ref()?;
    Some(SessionInfo {
        id: s.id.clone(),
        width: s.w,
        height: s.h,
        preview: s.preview.clone(), // 캐시본(Session::preview 주석)
    })
}

/// 오버레이가 **새 프레임을 실제로 그린 뒤** 부른다 → 그때 창을 띄운다.
///
/// 이 한 단계가 두 가지 잘못된 그림을 없앤다: 첫 캡쳐의 검은 전체화면(웹뷰 로딩 중)과, 두 번째
/// 부터의 직전 캡쳐 잔상. 대가는 IPC 왕복 몇 ms이고, 그건 예산 안이다(`trigger_inner` 주석).
#[tauri::command(async)]
pub fn capture_overlay_ready(app: AppHandle, id: String) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || show_overlay_for(&app2, &id));
}

/// 확정 — 원본에서 잘라 클립보드에 넣고 오버레이를 닫는다. **픽셀이 프론트를 거치지 않는다.**
#[tauri::command(async)]
pub fn capture_to_clipboard(app: AppHandle, id: String, rect: RectPx) -> Result<(), IpcError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    // **세션은 전부 성공한 뒤에 소모한다.** 먼저 꺼내 놓고 크롭이나 클립보드 쓰기가 실패하면
    // 방금 찍은 화면이 조용히 사라진다 — 다시 찍을 수도 없다(이미 화면이 바뀌었다).
    // e2e 31 ⑤가 이 순서를 고정한다.
    let (rgba, w, h, held) = {
        let cur = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
        let s = cur
            .as_ref()
            .filter(|s| s.id == id)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "캡쳐 세션이 만료되었습니다"))?;
        let (rgba, w, h) = crop_rgba(s, rect)?; // 실패해도 세션은 그대로 남는다
        (rgba, w, h, s.born.elapsed())
    };

    // **클립보드는 재시도해야 한다.** Windows에서 `OpenClipboard`는 다른 프로세스가 잠깐이라도
    // 쥐고 있으면 실패한다("held by another party") — 클립보드 매니저·브라우저·터미널이 복사
    // 직후 수십 ms 동안 흔히 쥔다. 실측으로 첫 시도가 그대로 깨졌다(e2e가 잡았다).
    // 한 번 실패했다고 포기하면 방금 찍은 화면을 버리는 셈이라, 짧게 여러 번 두드린다.
    let img = tauri::image::Image::new(&rgba, w, h);
    let mut last = None;
    for i in 0..8 {
        match app.clipboard().write_image(&img) {
            Ok(()) => {
                last = None;
                break;
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 + i * 10));
            }
        }
    }
    if let Some(e) = last {
        // 세션은 살려 둔다(위 주석) — 사용자가 Enter를 다시 누르면 같은 그림을 다시 시도한다.
        log::warn!("[capture] 클립보드 복사 실패(8회 재시도): {e}");
        return Err(IpcError::new(
            ErrorCode::Io,
            "다른 프로그램이 클립보드를 쓰고 있습니다 — 잠시 후 다시 시도하세요",
        ));
    }

    // 여기까지 왔으면 결과물이 클립보드에 있다 — 이제 원본(최대 33MB)을 놓는다.
    let _ = take_session(&id);
    hide_overlay(&app);
    log::info!("[capture] {w}x{h} 클립보드 복사 (세션 {}ms)", held.as_millis());
    Ok(())
}

/// 취소 — 버퍼를 놓고 오버레이를 닫는다.
#[tauri::command(async)]
pub fn capture_cancel(app: AppHandle, id: String) -> Result<(), IpcError> {
    let _ = take_session(&id); // 이미 없어도 취소는 성공이다
    hide_overlay(&app);
    Ok(())
}

fn hide_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CAPTURE_OVERLAY_LABEL) {
        let _ = w.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(w: u32, h: u32) -> Session {
        // 픽셀 (x,y) 의 B 채널에 x, G 채널에 y 를 심어 크롭 위치를 검증한다.
        let mut bgra = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                bgra.extend_from_slice(&[x as u8, y as u8, 0, 0]);
            }
        }
        Session {
            id: "t".into(),
            bgra,
            w,
            h,
            mx: 0,
            my: 0,
            preview: String::new(),
            born: Instant::now(),
        }
    }

    /// 크롭이 요청한 자리를 정확히 집는가 — 행 스트라이드를 한 번이라도 틀리면 이미지가 비스듬해진다.
    #[test]
    fn crop_picks_the_requested_rect() {
        let s = sample(16, 8);
        let (px, w, h) = crop_rgba(
            &s,
            RectPx {
                x: 3,
                y: 2,
                w: 4,
                h: 3,
            },
        )
        .unwrap();
        assert_eq!((w, h), (4, 3));
        // 첫 픽셀은 원본 (3,2) — RGBA 순서라 R=원본B(=x), G=원본G(=y).
        assert_eq!(&px[0..3], &[0, 2, 3], "좌상단이 (3,2)가 아니다");
        // 마지막 픽셀은 원본 (6,4).
        let last = px.len() - 4;
        assert_eq!(&px[last..last + 3], &[0, 4, 6], "우하단이 (6,4)가 아니다");
    }

    /// GDI가 준 알파(대개 0)를 그대로 넘기면 클립보드 이미지가 통째로 투명해진다.
    #[test]
    fn crop_forces_opaque_alpha() {
        let s = sample(4, 4);
        let (px, ..) = crop_rgba(
            &s,
            RectPx {
                x: 0,
                y: 0,
                w: 4,
                h: 4,
            },
        )
        .unwrap();
        assert!(px.chunks_exact(4).all(|p| p[3] == 255));
    }

    /// 범위를 벗어난 사각형은 패닉이 아니라 에러여야 한다(동기 커맨드 패닉은 프로세스를 죽인다).
    #[test]
    fn crop_rejects_out_of_bounds() {
        let s = sample(8, 8);
        for r in [
            RectPx { x: 6, y: 0, w: 4, h: 1 },
            RectPx { x: 0, y: 6, w: 1, h: 4 },
            RectPx { x: 0, y: 0, w: 0, h: 4 },
        ] {
            assert!(crop_rgba(&s, r).is_err(), "{r:?}가 통과했다");
        }
    }
}
