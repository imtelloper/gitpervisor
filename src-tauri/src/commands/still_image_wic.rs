//! Windows 네이티브 HEIC/HEIF/AVIF 썸네일 — WIC 로 파일 안 내장 썸네일(iPhone 320×240)을 꺼낸다(태스크 79 B2).
//!
//! 같은 썸네일을 ffmpeg 로 풀면 프로세스 둘(ffprobe+ffmpeg)에 ≈170ms, WIC `GetThumbnail` 은 14~22ms 다(실측). 디코더는
//! OS 의 HEIF·HEVC(AVIF 는 AV1) 확장이 준다 — 없거나 실패하면 None 이고 호출부(`still_to_jpeg`)가 ffmpeg 로 간다.
//! 방향은 디코더가 이미 바로 세워 준다(irot 적용 — 0·±90·180 파일을 ffmpeg 결과와 대조) — 여기서 다시 돌리지 않는다.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use windows::core::{Interface, HRESULT, HSTRING};
use windows::Win32::Foundation::{
    E_FAIL, GENERIC_READ, REGDB_E_CLASSNOTREG, RPC_E_CHANGED_MODE, WINCODEC_ERR_CODECNOTHUMBNAIL,
    WINCODEC_ERR_COMPONENTINITIALIZEFAILURE, WINCODEC_ERR_COMPONENTNOTFOUND,
};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_ContainerFormatHeif, GUID_WICPixelFormat24bppBGR, IWICBitmapSource, IWICImagingFactory, WICConvertBitmapSource,
    WICBitmapInterpolationModeFant, WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

/// 썸네일 JPEG 품질(image 크레이트 1~100). 192 칸 썸네일 한 장이 수 KB 다.
const WIC_THUMB_JPEG_QUALITY: u8 = 85;

/// 코덱 갈래별 "이 세션엔 WIC 를 쓸 수 없다" — [HEVC(HEIC·HEIF), AV1(AVIF)]. 확장이 따로 깔리므로(HEVC 는 유료) 한쪽이
/// 없다고 다른 쪽까지 끄지 않는다. 코덱이 없다는 HRESULT 에만 선다 — 파일 하나가 깨진 것으로는 서지 않는다.
static WIC_UNUSABLE: [AtomicBool; 2] = [AtomicBool::new(false), AtomicBool::new(false)];

/// 긴 변 `max_edge` 안의 썸네일 JPEG. ISO-BMFF 가 아니거나, 내장 썸네일이 없거나 칸보다 작거나, WIC 가 실패하면 None.
pub(crate) async fn wic_thumb_jpeg(file: &Path, max_edge: u32) -> Option<Vec<u8>> {
    if wic_forced_off() {
        return None;
    }
    let path = file.to_path_buf();
    match tokio::task::spawn_blocking(move || wic_thumb_or_none(&path, max_edge)).await {
        Ok(jpg) => jpg,
        Err(e) => {
            log::warn!("[wic] 썸네일 작업이 끝나지 못해 ffmpeg 로 넘긴다: {} {e}", file.display());
            None
        }
    }
}

fn wic_thumb_or_none(file: &Path, max_edge: u32) -> Option<Vec<u8>> {
    let unusable = &WIC_UNUSABLE[heif_codec_family(file)?];
    if unusable.load(Ordering::Relaxed) {
        return None;
    }
    match wic_thumb_blocking(file, max_edge) {
        Ok(jpg) => Some(jpg),
        Err(e) => {
            let code = e.code().0 as u32;
            if is_codec_missing(e.code()) && !heif_decoder_registered(e.code()) {
                if !unusable.swap(true, Ordering::Relaxed) {
                    log::warn!("[wic] 코덱을 쓸 수 없어 이 세션의 썸네일은 ffmpeg 로 만든다: {code:#010x} {} ({})", e.message(), file.display());
                }
            } else {
                log::debug!("[wic] 썸네일 실패 → ffmpeg: {code:#010x} {} ({})", e.message(), file.display());
            }
            None
        }
    }
}

/// HEIF 계열이면 코덱 갈래(`WIC_UNUSABLE` 의 칸: 0 = HEVC, 1 = AV1), 아니면 None.
/// **알려진 HEIF·AVIF 브랜드만** — ftyp 만 보고 받으면 이름만 .heic 인 MP4·MOV(isom·mp42·qt)도 들어와, WIC 가 "맞는 디코더 없음
/// (COMPONENTNOTFOUND)" 으로 거절하는 것을 코덱이 없다고 읽어 이 세션의 HEIC 썸네일을 통째로 ffmpeg 로 돌렸다(검토에서 재현).
fn heif_codec_family(file: &Path) -> Option<usize> {
    use std::io::Read;
    let mut head = Vec::with_capacity(64);
    // 못 읽으면 WIC 몫이 아니다 — 같은 실패를 ffmpeg 가 메시지로 말한다.
    std::fs::File::open(file).and_then(|f| f.take(64).read_to_end(&mut head)).ok()?;
    heif_family_of_head(&head)
}

fn heif_family_of_head(head: &[u8]) -> Option<usize> {
    if head.get(4..8) != Some(b"ftyp") {
        return None;
    }
    if super::favorites::ftyp_is_avif(head) {
        return Some(1);
    }
    let declared = head.get(..4).map_or(0, |s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as usize);
    // 대표 브랜드(8..12) + 호환 브랜드(16..상자 끝) — 사이의 minor_version(12..16)도 4바이트라 함께 훑어도 브랜드와 겹치지 않는다.
    let brands = head.get(8..declared.min(head.len())).unwrap_or(&[]);
    const HEVC_BRANDS: [&[u8; 4]; 8] = [b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"];
    brands.chunks_exact(4).any(|b| HEVC_BRANDS.iter().any(|h| b == h.as_slice())).then_some(0)
}

/// 코덱이 없다는 실패를 이 세션 전체에 적용하기 전에 한 번 더 확인한다 — HEIF 컨테이너 디코더가 등록돼 있으면 그 실패는 파일 탓이다.
/// Media Foundation 의 "코덱 없음"(HEVC 확장이 빠짐)은 컨테이너 디코더가 있어도 나므로 그대로 믿는다.
fn heif_decoder_registered(code: HRESULT) -> bool {
    const MF_E_TOPO_CODEC_NOT_FOUND: HRESULT = HRESULT(0xC00D5212_u32 as i32);
    if code == MF_E_TOPO_CODEC_NOT_FOUND {
        return false;
    }
    let probe = || -> windows::core::Result<()> {
        let _com = ComGuard::init()?;
        // SAFETY: ComGuard 가 이 스레드의 COM 을 초기화한 뒤, 만든 객체는 이 클로저 안에서만 쓴다.
        unsafe {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            factory.CreateDecoder(&GUID_ContainerFormatHeif, std::ptr::null())?;
        }
        Ok(())
    };
    probe().is_ok()
}

/// 코덱(확장) 자체가 없다는 실패 — 이 세션엔 다시 시도하지 않는다. 그 밖(썸네일 없음·깨진 파일)은 파일 탓이다.
fn is_codec_missing(code: HRESULT) -> bool {
    // MF_E_TOPO_CODEC_NOT_FOUND — HEIF 디코더가 HEVC/AV1 을 Media Foundation 으로 풀 때 확장이 없으면 나올 값이다(확장 없는
    // 실기에서 미확인). MediaFoundation 기능을 켜지 않으려고 값으로 둔다.
    const MF_E_TOPO_CODEC_NOT_FOUND: HRESULT = HRESULT(0xC00D5212_u32 as i32);
    [WINCODEC_ERR_COMPONENTNOTFOUND, REGDB_E_CLASSNOTREG, WINCODEC_ERR_COMPONENTINITIALIZEFAILURE, MF_E_TOPO_CODEC_NOT_FOUND]
        .contains(&code)
}

/// 강제 실패 훅(디버그 빌드만) — `GPV_DISABLE_WIC_THUMBS=1` 로 띄운 dev 앱은 WIC 를 건너뛰어 ffmpeg 폴백을 보여 준다.
fn wic_forced_off() -> bool {
    static OFF: OnceLock<bool> = OnceLock::new();
    cfg!(debug_assertions) && *OFF.get_or_init(|| std::env::var_os("GPV_DISABLE_WIC_THUMBS").is_some_and(|v| v == "1"))
}

/// 이 스레드의 COM 초기화 짝(`pc_care/scheduled_tasks.rs` 와 같은 꼴). spawn_blocking 스레드는 재사용되니 init 마다 uninit 을 맞춘다.
struct ComGuard(bool);

impl ComGuard {
    fn init() -> windows::core::Result<Self> {
        // SAFETY: 예약 인자 None, 같은 스레드에서 Drop 이 짝을 맞춘다.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == RPC_E_CHANGED_MODE {
            // 이미 STA 로 초기화된 스레드 — 그대로 쓸 수 있고, 남의 초기화라 해제하지 않는다.
            return Ok(Self(false));
        }
        hr.ok()?;
        Ok(Self(true))
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: init 이 성공한 같은 스레드.
            unsafe { CoUninitialize() };
        }
    }
}

fn wic_size(src: &IWICBitmapSource) -> windows::core::Result<(u32, u32)> {
    let (mut w, mut h) = (0, 0);
    // SAFETY: 살아 있는 소스, 출력 칸 둘.
    unsafe { src.GetSize(&mut w, &mut h)? };
    Ok((w, h))
}

fn wic_thumb_blocking(file: &Path, max_edge: u32) -> windows::core::Result<Vec<u8>> {
    let _com = ComGuard::init()?;
    // SAFETY: COM 이 이 스레드에서 초기화된 뒤(ComGuard)에만 부르고, 만든 객체는 이 함수 안에서만 쓴다.
    let (bgr, w, h) = unsafe {
        let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
        let decoder =
            factory.CreateDecoderFromFilename(&HSTRING::from(file), None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)?;
        let mut src = decoder.GetFrame(0)?.GetThumbnail()?;
        let (tw, th) = wic_size(&src)?;
        let long = tw.max(th);
        if long < max_edge {
            // 칸보다 작은 썸네일을 키우면 흐리다 — ffmpeg 가 큰 그림에서 줄인다.
            return Err(WINCODEC_ERR_CODECNOTHUMBNAIL.into());
        }
        if long > max_edge {
            let k = f64::from(max_edge) / f64::from(long);
            let fit = |v: u32| ((f64::from(v) * k).round() as u32).max(1);
            let scaler = factory.CreateBitmapScaler()?;
            scaler.Initialize(&src, fit(tw), fit(th), WICBitmapInterpolationModeFant)?;
            src = scaler.cast()?;
        }
        // 24bppBGR 로 바꾼 뒤 읽는다 — 원래 형식(32bpp)으로 읽거나 메모리 비트맵을 거치면 몇 배 느렸다(실측).
        let bgr = WICConvertBitmapSource(&GUID_WICPixelFormat24bppBGR, &src)?;
        let (w, h) = wic_size(&bgr)?;
        let mut px = vec![0u8; (w * 3 * h) as usize];
        bgr.CopyPixels(std::ptr::null(), w * 3, &mut px)?;
        (px, w, h)
    };
    let mut rgb = bgr;
    for p in rgb.chunks_exact_mut(3) {
        p.swap(0, 2);
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, WIC_THUMB_JPEG_QUALITY)
        .encode(&rgb, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| windows::core::Error::new(E_FAIL, format!("jpeg encode: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::still_image::{still_to_jpeg, StillLane};
    use crate::commands::video::FfmpegBin;
    use std::time::Instant;

    #[test]
    fn codec_missing_is_only_the_no_codec_family() {
        assert!(is_codec_missing(WINCODEC_ERR_COMPONENTNOTFOUND));
        assert!(is_codec_missing(REGDB_E_CLASSNOTREG));
        assert!(is_codec_missing(HRESULT(0xC00D5212_u32 as i32)));
        // 파일 탓 — 한 장이 깨졌다고 세션 전체를 끄면 안 된다.
        assert!(!is_codec_missing(WINCODEC_ERR_CODECNOTHUMBNAIL));
        assert!(!is_codec_missing(E_FAIL));
        assert!(!is_codec_missing(windows::Win32::Foundation::WINCODEC_ERR_BADHEADER));
    }

    #[test]
    fn heif_family_comes_from_the_ftyp_brand() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.path().join(name);
            std::fs::write(&p, bytes).unwrap();
            p
        };
        let heic = write("a.heic", b"\0\0\0\x18ftypheic\0\0\0\0mif1heic");
        let avif = write("b.avif", b"\0\0\0\x1cftypavif\0\0\0\0avifmif1miaf");
        let png = write("c.png", b"\x89PNG\r\n\x1a\n\0\0\0\0");
        assert_eq!(heif_codec_family(&heic), Some(0));
        assert_eq!(heif_codec_family(&avif), Some(1));
        assert_eq!(heif_codec_family(&png), None, "ISO-BMFF 가 아니면 WIC 몫이 아니다");
        assert_eq!(heif_codec_family(&dir.path().join("none.heic")), None);
        // 이름만 .heic 인 MP4·MOV — ftyp 은 있지만 HEIF 브랜드가 아니다. 받아들이면 WIC 의 "맞는 디코더 없음"이 세션 전체를 끈다.
        for (name, bytes) in [
            ("mp4.heic", &b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2"[..]),
            ("mov.jpg", &b"\0\0\0\x14ftypqt  \0\0\x02\0qt  "[..]),
            ("3gp.heic", &b"\0\0\0\x14ftyp3gp4\0\0\x02\03gp4"[..]),
        ] {
            assert_eq!(heif_codec_family(&write(name, bytes)), None, "{name}");
        }
        // 대표 브랜드가 mif1 이고 호환 브랜드에 heic — HEVC.
        assert_eq!(heif_codec_family(&write("m.heic", b"\0\0\0\x18ftypmif1\0\0\0\0mif1heic")), Some(0));
    }

    /// 이 기계엔 HEIF 컨테이너 디코더가 있다 — "맞는 디코더 없음"은 파일 탓으로 읽혀 세션을 끄지 않는다. MF 의 코덱 없음은 그대로 믿는다.
    #[test]
    #[ignore = "HEIF 이미지 확장이 깔린 Windows 에서만 — cargo test --lib -- --ignored component_not_found"]
    fn component_not_found_does_not_latch_when_heif_decoder_is_registered() {
        assert!(heif_decoder_registered(WINCODEC_ERR_COMPONENTNOTFOUND), "HEIF 확장이 깔린 기계에서 돈다");
        assert!(!heif_decoder_registered(HRESULT(0xC00D5212_u32 as i32)));
    }

    fn ffmpeg_bin() -> FfmpegBin {
        FfmpegBin {
            ffmpeg: crate::tools::runner::find_on_path("ffmpeg").expect("PATH 에 ffmpeg"),
            ffprobe: crate::tools::runner::find_on_path("ffprobe"),
            source: "path",
        }
    }

    fn dims(jpg: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory(jpg).expect("JPEG");
        (img.width(), img.height())
    }

    /// 실제 사진으로 시간·방향·폴백 — `GPV_HEIC_DIR=<HEIC 복사본 폴더> cargo test --lib heic_real_speed -- --ignored --nocapture`.
    /// (a) WIC 썸네일 192 (b) ffmpeg 내장 썸네일 192(probe 포함) (c) ffmpeg 그리드 4096(probe 는 (b) 가 기억) 의 ms·크기,
    /// 세 결과의 방향(가로/세로)이 같은지, WIC 를 못 쓰면 썸네일 줄이 ffmpeg 와 바이트까지 같은 결과를 내는지,
    /// ffmpeg 가 없어도 WIC 로 썸네일이 나오는지.
    #[tokio::test]
    #[ignore = "실제 HEIC·PATH 의 ffmpeg·HEIF/HEVC 확장 필요"]
    async fn heic_real_speed_orientation_and_fallback() {
        let dir = std::env::var("GPV_HEIC_DIR").expect("GPV_HEIC_DIR");
        let mut files: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("heic")))
            .collect();
        files.sort();
        assert!(!files.is_empty(), "{dir} 에 HEIC 가 없다");
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1e3;
        let landscape = |(w, h): (u32, u32)| w > h;
        for f in &files {
            let name = f.file_name().unwrap().to_string_lossy().to_string();
            let t = Instant::now();
            let wic = wic_thumb_jpeg(f, 192).await.unwrap_or_else(|| panic!("{name}: WIC 썸네일 실패"));
            let a = (ms(t), dims(&wic));
            let t = Instant::now();
            let thumb = still_to_jpeg(|| Ok(ffmpeg_bin()), f, 192, 4, StillLane::View).await.unwrap();
            let b = (ms(t), dims(&thumb));
            let t = Instant::now();
            let full = still_to_jpeg(|| Ok(ffmpeg_bin()), f, 4096, 2, StillLane::View).await.unwrap();
            let c = (ms(t), dims(&full));
            println!(
                "{name}: (a) WIC 192 {:.0}ms {:?} | (b) ffmpeg 썸네일 스트림 192 {:.0}ms {:?} | (c) ffmpeg 그리드 4096 {:.0}ms {:?}",
                a.0, a.1, b.0, b.1, c.0, c.1
            );
            assert_eq!(a.1.0.max(a.1.1), 192, "{name}: WIC 긴 변");
            assert_eq!(b.1.0.max(b.1.1), 192, "{name}: ffmpeg 긴 변");
            assert!(
                landscape(a.1) == landscape(b.1) && landscape(b.1) == landscape(c.1),
                "{name}: 방향이 갈린다 — WIC {:?} · 썸네일 스트림 {:?} · 그리드 {:?}",
                a.1,
                b.1,
                c.1
            );

            // ffmpeg 가 없어도 썸네일 줄은 WIC 로 낸다(ffmpeg 를 찾지도 않는다).
            let no_ffmpeg = || Err(crate::error::IpcError::new(crate::error::ErrorCode::NotFound, "no ffmpeg"));
            let via_wic = still_to_jpeg(no_ffmpeg, f, 192, 4, StillLane::Thumb).await.expect("ffmpeg 없이 WIC");
            assert_ne!(via_wic, thumb, "{name}: 썸네일 줄이 WIC 를 탔어야 한다");

            // WIC 를 못 쓰게 되면 같은 요청이 ffmpeg 로 — 결과가 ffmpeg 경로와 바이트까지 같다.
            WIC_UNUSABLE[0].store(true, Ordering::Relaxed);
            let fell_back = still_to_jpeg(|| Ok(ffmpeg_bin()), f, 192, 4, StillLane::Thumb).await;
            let without_any = still_to_jpeg(no_ffmpeg, f, 192, 4, StillLane::Thumb).await;
            WIC_UNUSABLE[0].store(false, Ordering::Relaxed);
            assert_eq!(fell_back.unwrap(), thumb, "{name}: WIC 를 못 쓰면 ffmpeg 결과 그대로");
            assert!(without_any.is_err(), "{name}: 둘 다 없으면 ffmpeg 를 못 찾았다는 오류");
        }
    }
}
