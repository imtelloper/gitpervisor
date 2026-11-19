//! OS 파일 유형 — Windows. 탐색기가 쓰는 것과 같은 **시스템 이미지 목록**에서 아이콘을 꺼낸다(`os_file_type.rs` 주석).
//!
//! `SHGetFileInfoW(SHGFI_SYSICONINDEX | SHGFI_TYPENAME)` 로 목록 안 번호와 유형 이름("Chrome PDF Document")을 받고,
//! `SHGetImageList` 로 크기별 목록(32 = SHIL_LARGE, 256 = SHIL_JUMBO)에서 그 번호의 HICON 을 꺼내 PNG 로 굽는다.
//! 폴더·확장자 질의는 `SHGFI_USEFILEATTRIBUTES` 로 디스크를 안 건드리고 유형 등록만 본다. 파일 질의(exe·lnk·ico)는
//! 실제 경로로 묻는다 — 그래야 실행 파일 안 아이콘·바로가기 대상 아이콘이 나온다.

use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows_sys::core::GUID;
use windows_sys::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
use windows_sys::Win32::UI::Controls::{ImageList_GetIcon, HIMAGELIST, ILD_TRANSPARENT};
use windows_sys::Win32::UI::Shell::{
    SHGetFileInfoW, SHGetImageList, SHFILEINFOW, SHGFI_SYSICONINDEX, SHGFI_TYPENAME, SHGFI_USEFILEATTRIBUTES, SHIL_JUMBO,
    SHIL_LARGE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

use super::{rgba_icon_to_png, OsTypeFound, OsTypeKind};
use crate::proc_icons::win::hicon_to_rgba;

/// IID_IImageList — `SHGetImageList` 가 돌려줄 인터페이스. 그 포인터는 HIMAGELIST 로 그대로 쓸 수 있다(문서화된 호환).
const IID_IMAGE_LIST: GUID = GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);

pub(super) fn lookup_batch(asks: &[(PathBuf, OsTypeKind)], px: u32) -> Vec<OsTypeFound> {
    // 셸 API 는 COM 이 초기화된 스레드를 요구한다. 이미 다른 모드로 초기화된 풀 스레드면 그대로 쓰고 해제하지 않는다.
    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    let we_initialized = hr.is_ok();
    if !we_initialized && hr != RPC_E_CHANGED_MODE {
        log::warn!("[os-file-type] COM 초기화 실패 {hr:?} — 아이콘 없이 돌려준다"); // i18n-ok: 로그
        return asks.iter().map(|_| OsTypeFound::default()).collect();
    }
    let list = ImageList::get(if px >= 256 { SHIL_JUMBO } else { SHIL_LARGE });
    let out = asks
        .iter()
        .map(|(path, kind)| {
            let (index, type_name) = shell_info(path, *kind);
            let icon_png = list.as_ref().zip(index).and_then(|(l, i)| l.icon_png(i));
            OsTypeFound { type_name, icon_png }
        })
        .collect();
    drop(list); // CoUninitialize 전에 Release
    if we_initialized {
        unsafe { CoUninitialize() };
    }
    out
}

/// 시스템 이미지 목록 안 번호와 유형 이름.
fn shell_info(path: &Path, kind: OsTypeKind) -> (Option<i32>, Option<String>) {
    let (query, attrs, flags): (OsString, u32, u32) = match kind {
        // 이름만 넘긴다 — USEFILEATTRIBUTES 면 경로가 실제로 무엇이든 "이 속성의 이 이름"으로만 판정한다.
        OsTypeKind::Folder => ("folder".into(), FILE_ATTRIBUTE_DIRECTORY, SHGFI_USEFILEATTRIBUTES),
        OsTypeKind::Ext => (
            path.file_name().map(|n| n.to_owned()).unwrap_or_default(),
            FILE_ATTRIBUTE_NORMAL,
            SHGFI_USEFILEATTRIBUTES,
        ),
        OsTypeKind::File => (path.as_os_str().to_owned(), 0, 0),
    };
    let wide: Vec<u16> = query.encode_wide().chain(std::iter::once(0)).collect();
    let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            attrs,
            &mut info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags | SHGFI_SYSICONINDEX | SHGFI_TYPENAME,
        )
    };
    if ok == 0 {
        return (None, None);
    }
    let end = info.szTypeName.iter().position(|&c| c == 0).unwrap_or(info.szTypeName.len());
    (Some(info.iIcon), Some(String::from_utf16_lossy(&info.szTypeName[..end])))
}

/// `SHGetImageList` 가 AddRef 해서 준 목록 — 다 쓰면 Release 한다.
struct ImageList(*mut c_void);

impl ImageList {
    fn get(which: u32) -> Option<Self> {
        let mut p: *mut c_void = std::ptr::null_mut();
        let hr = unsafe { SHGetImageList(which as i32, &IID_IMAGE_LIST, &mut p) };
        (hr >= 0 && !p.is_null()).then_some(Self(p))
    }

    fn icon_png(&self, index: i32) -> Option<Vec<u8>> {
        let icon = unsafe { ImageList_GetIcon(self.0 as HIMAGELIST, index, ILD_TRANSPARENT) };
        if icon.is_null() {
            return None;
        }
        let rgba = unsafe { hicon_to_rgba(icon) };
        unsafe { DestroyIcon(icon) };
        rgba.and_then(|r| rgba_icon_to_png(r.w, r.h, r.pixels))
    }
}

impl Drop for ImageList {
    fn drop(&mut self) {
        // IUnknown::Release — vtable 세 번째 칸. windows-sys 엔 인터페이스 래퍼가 없어 직접 부른다.
        unsafe {
            let vtbl = *(self.0 as *const *const [usize; 3]);
            let release: unsafe extern "system" fn(*mut c_void) -> u32 = std::mem::transmute((*vtbl)[2]);
            release(self.0);
        }
    }
}
