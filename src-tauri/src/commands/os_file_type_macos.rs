//! OS 파일 유형 — macOS. Finder 와 같은 아이콘(`NSWorkspace iconForFile`)과 "종류"(`NSURL` localizedTypeDescription).
//! **메인 스레드에서 부른다**(`os_file_type.rs` — AppKit 그리기). 아이콘은 여러 해상도 표현을 가진 NSImage 라, 원하는
//! 픽셀 크기의 비트맵을 만들어 거기 그린 뒤 PNG 로 뽑는다 — TIFFRepresentation 은 1024px 표현까지 통째로 담아 무겁다.
//! 이 파일을 고치면 Windows 개발기에서도 `bash scripts/check-os-file-type-cross.sh` 로 형식 검사한다. 실기 동작은 macOS 에서 봐야 한다.

use std::path::PathBuf;

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::AllocAnyThread;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    NSWorkspace,
};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString, NSURL, NSURLLocalizedTypeDescriptionKey};

use super::{OsTypeFound, OsTypeKind};

pub(super) fn lookup_batch(asks: &[(PathBuf, OsTypeKind)], px: u32) -> Vec<OsTypeFound> {
    let ws = NSWorkspace::sharedWorkspace();
    asks.iter()
        .map(|(path, kind)| {
            autoreleasepool(|_| {
                let p = NSString::from_str(&path.to_string_lossy());
                let icon = match kind {
                    // 폴더 일반 아이콘 — 대표로 받은 폴더에 사용자 지정 아이콘이 있으면 모든 폴더가 그걸로 보인다.
                    #[allow(deprecated)] // iconForContentType 은 UniformTypeIdentifiers 바인딩이 따로 필요하다 — 동작은 같다
                    OsTypeKind::Folder => ws.iconForFileType(&NSString::from_str("public.folder")),
                    OsTypeKind::Ext | OsTypeKind::File => ws.iconForFile(&p),
                };
                OsTypeFound { type_name: type_name(&p), icon_png: icon_png(&icon, px) }
            })
        })
        .collect()
}

fn type_name(path: &NSString) -> Option<String> {
    let url = NSURL::fileURLWithPath(path);
    let mut value: Option<Retained<AnyObject>> = None;
    unsafe { url.getResourceValue_forKey_error(&mut value, NSURLLocalizedTypeDescriptionKey) }.ok()?;
    let s = value?.downcast::<NSString>().ok()?;
    Some(s.to_string())
}

fn icon_png(image: &NSImage, px: u32) -> Option<Vec<u8>> {
    let side = px as isize;
    // planes = null → 비트맵이 버퍼를 스스로 잡는다. 8bit × RGBA, 행 바이트·픽셀 비트는 0 = 알아서.
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            side,
            side,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }?;
    let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&ctx));
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(px as f64, px as f64));
    // fromRect = ZERO → 이미지 전체를 rect 에 맞춰 그린다(가장 알맞은 해상도 표현을 AppKit 이 고른다).
    image.drawInRect_fromRect_operation_fraction(rect, NSRect::ZERO, NSCompositingOperation::Copy, 1.0);
    ctx.flushGraphics();
    NSGraphicsContext::restoreGraphicsState_class();
    let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(data.to_vec())
}
