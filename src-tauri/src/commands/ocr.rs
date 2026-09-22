//! 이미지 뷰어 글자 추출(OCR) — OS 내장 엔진 3종을 커맨드 하나 뒤에 (태스크 68).
//!
//! 엔진은 OS 것을 쓴다: Windows `Windows.Media.Ocr`, macOS Vision, Linux 시스템 `tesseract` CLI.
//! 자산 0·CSP 0·npm 0이 그 선택의 이유다 — 웹뷰 안 WASM OCR(tesseract.js)은 실측 품질이
//! 복사용으로 못 쓸 수준인 데다 CSP에 `'wasm-unsafe-eval'`을 열어야 한다(DOCS/task/68-image-ocr.md §3.1).
//!
//! 엔진 차이는 여기서 끝난다. 프론트가 보는 것은 [`OcrResult`] 하나이고, 디코드·확대 재인식·
//! 읽기 순서 정렬은 세 백엔드가 **같은 코드**를 탄다.

use serde::Serialize;
use tauri::State;

use super::diff::MAX_IMAGE_BYTES;
use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 디코드·×2 버퍼의 상한(50MP RGBA = 200MB). macOS·Linux 엔진에는 치수 한계가 없어
/// **이 상수만이** 8K 이미지의 ×2 확대가 메모리를 통째로 먹는 것을 막는다.
/// 편집기의 `MAX_INPUT_PIXELS`(ImageEditor.tsx)와 같은 뜻이지만 그쪽은 TS 상수라 공유가 안 된다.
const OCR_MAX_PIXELS: u64 = 50_000_000;

/// 글자 높이 중앙값이 이 값 이하일 때만 ×2로 다시 읽는다.
/// 실측(설계 §3.4): 13px 다크 스크린샷은 ×2로 CER 0.27→0.10으로 좋아지지만 **16px 밝은 산문은
/// 0.053→0.112로 되레 나빠진다.** 14~15px 구간은 미실측이라 실기에서 조정할 자리다.
const UPSCALE_MAX_GLYPH_PX: f32 = 14.0;

/// 확대 재인식 경고 — 상한을 숨기지 않기 위해 사용자에게 그대로 보인다(설계 R1).
const UPSCALED_WARNING: &str = "글자가 작아 2배 확대해 다시 읽음";

/// 인식된 상자 — **원본 이미지 px, 좌상단 원점**. 뷰어가 `<img>`와 같은 transform을 준 형제 div에
/// 그대로 얹으므로 좌표 변환 코드가 프론트에 없다.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// 글줄 하나 — UI가 쓰는 건 이 둘뿐이다.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLine {
    pub text: String,
    /// `box`는 Rust 예약어라 raw 식별자로 두되, IPC 계약상 이름은 `box` 그대로다.
    #[serde(rename = "box")]
    pub r#box: OcrBox,
}

/// 어느 엔진이 읽었는지 — 계약은 세 OS 공통이라, 어느 타깃에서 컴파일하든 나머지 둘은
/// 생성되지 않는다. 변종별로 해당 플랫폼에서만 dead_code 검사를 살려 둔다.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
pub enum OcrEngineKind {
    #[cfg_attr(not(windows), allow(dead_code))]
    WindowsOcr,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    AppleVision,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    TesseractCli,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub engine: OcrEngineKind,
    /// 실제로 **요청한** 언어 태그. 엔진마다 표기가 다르다(ko-KR / kor).
    pub languages: Vec<String>,
    /// 읽기 순서로 정렬된 글줄.
    pub lines: Vec<OcrLine>,
    /// `lines`의 텍스트를 `\n`으로 이은 것 — 클립보드는 이것만 쓴다.
    pub text: String,
    pub warnings: Vec<String>,
}

/// 엔진 한 패스의 결과. 단어 상자와 신뢰도는 여기까지만 산다 — IPC로 내보내면 엔진마다
/// 비는 필드를 프론트가 분기해야 한다(설계 §3.2).
struct EnginePass {
    engine: OcrEngineKind,
    languages: Vec<String>,
    lines: Vec<OcrLine>,
    /// 확대 판정용 글자 높이 — Windows·tesseract는 단어 상자, Vision은 줄 상자 높이.
    glyph_heights: Vec<f32>,
    warnings: Vec<String>,
    /// 엔진이 받아들이는 한 변의 최대 px. Windows만 유한(`MaxImageDimension`, 이 빌드 10000이고
    /// 구형 Win10은 2600 보고가 있어 **런타임에 읽는다**), 나머지는 `u32::MAX`.
    dimension_limit: u32,
}

// ════════════════════════════ 순수 함수 (테스트로 고정) ════════════════════════════

fn median_of(values: &mut [f32]) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}

/// ×2 재인식을 할지. 작은 글자에서만 이득이고(§3.4), 2배 결과가 엔진 치수 한계와
/// [`OCR_MAX_PIXELS`] 안에 들어와야 한다. 줄이 하나도 없으면 중앙값이 0이라 false다.
fn needs_upscale(median_glyph_h: f32, w: u32, h: u32, limit: u32) -> bool {
    median_glyph_h > 0.0
        && median_glyph_h <= UPSCALE_MAX_GLYPH_PX
        && (w as u64) * 2 <= limit as u64
        && (h as u64) * 2 <= limit as u64
        && 4 * (w as u64) * (h as u64) <= OCR_MAX_PIXELS
}

/// 읽기 순서로 정렬 — `y`로 행을 묶고(허용치 = 줄 높이 중앙값 × 0.5) 같은 행 안은 `x` 오름차순.
///
/// Windows·tesseract는 대개 이미 읽기 순서로 주지만, Windows 엔진이 코드 스크린샷에서 줄 조각을
/// **뒤에 붙여** 순서를 어긋나게 한 실측이 있고 Vision은 순서 자체가 문서화돼 있지 않다.
/// 그래서 엔진을 가리지 않고 전부 여기를 통과시킨다.
fn order_lines(mut lines: Vec<OcrLine>) -> Vec<OcrLine> {
    if lines.len() < 2 {
        return lines;
    }
    let mut heights: Vec<f32> = lines.iter().map(|l| l.r#box.h).collect();
    let tolerance = median_of(&mut heights) * 0.5;
    lines.sort_by(|a, b| a.r#box.y.total_cmp(&b.r#box.y));

    let mut out: Vec<OcrLine> = Vec::with_capacity(lines.len());
    let mut row: Vec<OcrLine> = Vec::new();
    let mut row_top = 0.0f32;
    for line in lines {
        // 행 기준은 그 행의 **첫(가장 위) 줄** — y 오름차순이라 뒤로 갈수록 벌어지는 것을 누적하지 않는다.
        if row.is_empty() {
            row_top = line.r#box.y;
        } else if line.r#box.y - row_top > tolerance {
            row.sort_by(|a, b| a.r#box.x.total_cmp(&b.r#box.x));
            out.append(&mut row);
            row_top = line.r#box.y;
        }
        row.push(line);
    }
    row.sort_by(|a, b| a.r#box.x.total_cmp(&b.r#box.x));
    out.append(&mut row);
    out
}

/// 한 줄을 마감한다 — level 4 상자가 있고 단어가 하나라도 있을 때만 줄이 된다.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn flush_tsv_line(open: &mut Option<OcrBox>, words: &mut Vec<(i32, String)>, out: &mut Vec<OcrLine>) {
    let taken = open.take();
    if words.is_empty() {
        return;
    }
    // 단어는 tesseract가 준 순서가 아니라 x 오름차순으로 잇는다 — 방출 순서가 어긋난 줄이
    // 통째로 뒤섞인 텍스트가 되는 것을 막는다. 정상 출력에서는 정렬이 무연산이다.
    words.sort_by_key(|(left, _)| *left);
    let text = words.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join(" ");
    words.clear();
    if let Some(b) = taken {
        out.push(OcrLine { text, r#box: b });
    }
}

/// tesseract `tsv` 출력 → 글줄. 헤더 1줄 + 12열
/// (`level page block par line word left top width height conf text`)이고 level 4 = 줄 상자,
/// 5 = 단어다. 그 밖의 level은 구조 행이라 `conf`가 -1이고 text가 비어 있다.
///
/// Linux 백엔드만 쓰지만 `#[cfg]`로 가두지 않는다 — 이 저장소의 개발·검증 머신은 Windows라
/// 가두는 순간 `cargo test --lib ocr`에서 이 파서의 검증이 통째로 사라진다.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_tsv(tsv: &str) -> Vec<OcrLine> {
    let mut out: Vec<OcrLine> = Vec::new();
    let mut words: Vec<(i32, String)> = Vec::new();
    let mut open: Option<OcrBox> = None;

    for row in tsv.lines().skip(1) {
        let f: Vec<&str> = row.split('\t').collect();
        if f.len() < 12 {
            continue;
        }
        let Ok(level) = f[0].parse::<i32>() else {
            continue;
        };
        match level {
            4 => {
                flush_tsv_line(&mut open, &mut words, &mut out);
                let (Ok(x), Ok(y), Ok(w), Ok(h)) = (
                    f[6].parse::<f32>(),
                    f[7].parse::<f32>(),
                    f[8].parse::<f32>(),
                    f[9].parse::<f32>(),
                ) else {
                    continue;
                };
                open = Some(OcrBox { x, y, w, h });
            }
            5 => {
                // conf < 0 은 구조 행(text 없음). 실패한 파싱도 같은 취급 — 좌표 없는 단어는
                // 줄 조립에 못 쓴다.
                let (Ok(conf), Ok(left)) = (f[10].parse::<f32>(), f[6].parse::<i32>()) else {
                    continue;
                };
                let text = f[11].trim();
                if conf < 0.0 || text.is_empty() {
                    continue;
                }
                words.push((left, text.to_string()));
            }
            // page·block·paragraph — 여기서 새 블록이 시작되므로 열려 있던 줄을 닫는다.
            _ => flush_tsv_line(&mut open, &mut words, &mut out),
        }
    }
    flush_tsv_line(&mut open, &mut words, &mut out);
    out
}

// ════════════════════════════ 공용 파이프라인 ════════════════════════════

fn join_err(e: tokio::task::JoinError) -> IpcError {
    IpcError::new(ErrorCode::Io, format!("글자 추출 작업이 중단됐습니다: {e}"))
}

fn decode_err(e: image::ImageError) -> IpcError {
    match e {
        image::ImageError::Unsupported(_) => IpcError::new(
            ErrorCode::Io,
            "OCR이 지원하지 않는 형식입니다 (png·jpeg·gif·webp·bmp)",
        ),
        e => IpcError::new(ErrorCode::Io, format!("이미지 디코드 실패: {e}")),
    }
}

/// 바이트 → RGBA. **헤더만 먼저 읽어** 픽셀 수를 거른다 — 디코드하고 나서 거절하면 50MP짜리
/// 200MB 버퍼를 일단 잡았다가 버리게 된다(read_file_base64가 크기를 먼저 보는 것과 같은 이유).
fn decode_rgba(bytes: &[u8]) -> Result<image::RgbaImage, IpcError> {
    let reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("이미지 형식 판별 실패: {e}")))?;
    let (w, h) = reader.into_dimensions().map_err(decode_err)?;
    if (w as u64) * (h as u64) > OCR_MAX_PIXELS {
        return Err(IpcError::new(
            ErrorCode::Io,
            format!(
                "이미지가 너무 큽니다 — {w}×{h}px (OCR 상한 {}MP)",
                OCR_MAX_PIXELS / 1_000_000
            ),
        ));
    }
    Ok(image::load_from_memory(bytes)
        .map_err(decode_err)?
        .into_rgba8())
}

/// 엔진에 넘길 PNG. 1× 패스도 원본 바이트 대신 이걸 쓴다 — 2× 패스는 픽셀이 바뀌어 어차피
/// 재인코드가 필요하므로, 경로를 하나로 두면 "1×는 원본, 2×는 재인코드" 분기가 없어진다.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, IpcError> {
    use image::ImageEncoder as _;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("PNG 인코딩 실패: {e}")))?;
    Ok(png)
}

/// 1차 인식 → 글자가 작으면 ×2로 재인식(§3.3·§3.4). 상자는 항상 **원본 px**로 되돌린다.
/// 자막 번인 실측 테스트(commands/video.rs `caption_burn_real_ffmpeg_renders_hangul`)도 이 엔진으로 한글을 읽는다.
pub(crate) async fn recognize_two_pass(img: image::RgbaImage) -> Result<OcrResult, IpcError> {
    let (w, h) = (img.width(), img.height());
    let src = std::sync::Arc::new(img);
    let first = engine_pass(src.clone()).await?;

    let mut glyphs = first.glyph_heights.clone();
    let median = median_of(&mut glyphs);
    // 확대와 축소는 같은 패스에 함께 나올 수 없다 — 원본이 엔진 한계를 넘어 축소됐다면
    // `2w ≤ limit`이 거짓이라 여기 들어오지 못한다. 그래서 이긴 패스의 warnings만 들고 간다.
    let mut pass = if needs_upscale(median, w, h, first.dimension_limit) {
        let up = tokio::task::spawn_blocking(move || {
            std::sync::Arc::new(image::imageops::resize(
                &*src,
                w * 2,
                h * 2,
                image::imageops::FilterType::CatmullRom,
            ))
        })
        .await
        .map_err(join_err)?;
        let mut second = engine_pass(up).await?;
        for line in &mut second.lines {
            line.r#box = OcrBox {
                x: line.r#box.x / 2.0,
                y: line.r#box.y / 2.0,
                w: line.r#box.w / 2.0,
                h: line.r#box.h / 2.0,
            };
        }
        second.warnings.push(UPSCALED_WARNING.to_string());
        second
    } else {
        first
    };

    let lines = order_lines(std::mem::take(&mut pass.lines));
    let text = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
    Ok(OcrResult {
        engine: pass.engine,
        languages: pass.languages,
        lines,
        text,
        warnings: pass.warnings,
    })
}

// ════════════════════════════ Windows — Windows.Media.Ocr ════════════════════════════

#[cfg(windows)]
async fn engine_pass(img: std::sync::Arc<image::RgbaImage>) -> Result<EnginePass, IpcError> {
    // WinRT의 `IAsyncOperation::get()`은 이벤트 대기라 호출 스레드를 막는다. 커맨드가 async여도
    // tokio 워커를 통째로 잡으므로 blocking 풀로 보낸다.
    tokio::task::spawn_blocking(move || windows_recognize(&img))
        .await
        .map_err(join_err)?
}

#[cfg(windows)]
fn windows_recognize(img: &image::RgbaImage) -> Result<EnginePass, IpcError> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Security::Cryptography::CryptographicBuffer;

    fn win_err(e: windows::core::Error) -> IpcError {
        IpcError::new(ErrorCode::Io, format!("Windows OCR 실패: {e}"))
    }

    let lang = Language::CreateLanguage(&HSTRING::from("ko-KR")).map_err(win_err)?;
    // 태그가 `ko`인 빌드도 있어 문자열 비교로는 못 맞춘다 — 엔진에게 직접 묻는다.
    if !OcrEngine::IsLanguageSupported(&lang).map_err(win_err)? {
        return Err(IpcError::new(
            ErrorCode::ToolNotFound,
            "한국어 OCR 팩이 없습니다 — 설정 › 시간 및 언어 › 언어 및 지역 › 언어 추가 › 한국어를 \
             설치하세요 (케이퍼빌리티 Language.OCR~~~ko-KR~0.0.1.0)",
        ));
    }
    let engine = OcrEngine::TryCreateFromLanguage(&lang).map_err(win_err)?;
    // 사용자 프로필 언어 폴백은 **두지 않는다** — 한국어 팩 없이 영어 엔진으로 한글 이미지를
    // 읽으면 쓰레기가 나오는데, 그게 설계 §1이 금지한 "무반응"의 다른 얼굴이다.

    let limit = OcrEngine::MaxImageDimension().map_err(win_err)?;
    let (w, h) = (img.width(), img.height());
    let mut warnings = Vec::new();
    let shrunk = if w > limit || h > limit {
        let scale = limit as f32 / w.max(h) as f32;
        warnings.push(format!(
            "엔진 한계로 {}% 축소함",
            ((1.0 - scale) * 100.0).round() as i32
        ));
        Some(image::imageops::resize(
            img,
            ((w as f32 * scale) as u32).max(1),
            ((h as f32 * scale) as u32).max(1),
            image::imageops::FilterType::CatmullRom,
        ))
    } else {
        None
    };
    let src = shrunk.as_ref().unwrap_or(img);
    // 상자는 호출자가 준 이미지의 px로 돌려준다 — 축소했으면 그만큼 되돌린다.
    let back = w as f32 / src.width() as f32;

    let mut bgra = src.as_raw().clone();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(win_err)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        src.width() as i32,
        src.height() as i32,
    )
    .map_err(win_err)?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(win_err)?
        .get()
        .map_err(win_err)?;

    let mut lines = Vec::new();
    let mut glyph_heights = Vec::new();
    for line in result.Lines().map_err(win_err)? {
        // `OcrResult.Text`는 줄을 공백으로 이어 버린다 — 줄 단위는 여기서 재조립해야 한다.
        let text = line.Text().map_err(win_err)?.to_string();
        // 줄에는 상자가 없다(단어에만 있다). 줄 상자 = 단어 상자 합집합.
        let mut union: Option<OcrBox> = None;
        for word in line.Words().map_err(win_err)? {
            let r = word.BoundingRect().map_err(win_err)?;
            glyph_heights.push(r.Height * back);
            let b = OcrBox {
                x: r.X * back,
                y: r.Y * back,
                w: r.Width * back,
                h: r.Height * back,
            };
            union = Some(match union {
                None => b,
                Some(u) => union_box(u, b),
            });
        }
        if text.trim().is_empty() {
            continue;
        }
        // 상자 없는 줄은 강조를 못 그린다 — 내보내지 않는다.
        if let Some(b) = union {
            lines.push(OcrLine { text, r#box: b });
        }
    }

    Ok(EnginePass {
        engine: OcrEngineKind::WindowsOcr,
        languages: vec!["ko-KR".to_string()],
        lines,
        glyph_heights,
        warnings,
        dimension_limit: limit,
    })
}

#[cfg(windows)]
fn union_box(a: OcrBox, b: OcrBox) -> OcrBox {
    let (x, y) = (a.x.min(b.x), a.y.min(b.y));
    let right = (a.x + a.w).max(b.x + b.w);
    let bottom = (a.y + a.h).max(b.y + b.h);
    OcrBox {
        x,
        y,
        w: right - x,
        h: bottom - y,
    }
}

// ════════════════════════════ macOS — Vision ════════════════════════════

#[cfg(target_os = "macos")]
async fn engine_pass(img: std::sync::Arc<image::RgbaImage>) -> Result<EnginePass, IpcError> {
    // `Retained<VN*>`는 !Send다 — 생성·실행·결과 읽기를 **한 클로저 안에서** 끝내고 평범한
    // 구조체만 돌려준다. `performRequests`도 동기라 어차피 blocking 풀이 맞다.
    tokio::task::spawn_blocking(move || {
        let (w, h) = (img.width() as f32, img.height() as f32);
        let png = encode_png(&img)?;
        vision_recognize(&png, w, h)
    })
    .await
    .map_err(join_err)?
}

#[cfg(target_os = "macos")]
fn vision_recognize(png: &[u8], width: f32, height: f32) -> Result<EnginePass, IpcError> {
    use objc2::AnyThread;
    use objc2_foundation::{
        NSArray, NSData, NSDictionary, NSOperatingSystemVersion, NSProcessInfo, NSString,
    };
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    // **Vision 심볼을 건드리기 전에** OS 버전을 본다. 앱 최소 macOS는 10.13인데 거기서
    // VNRecognizeTextRequest 클래스를 조회하면 objc2가 패닉하거나(10.13~14) ObjC 예외로
    // 프로세스가 abort한다(10.15~11 — catch-all 피처를 안 쓴다). 언어 목록 질의로 게이트하면
    // 그 질의 자체가 macOS 12+라 이미 늦다.
    let at_least_13 = NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(
        NSOperatingSystemVersion {
            majorVersion: 13,
            minorVersion: 0,
            patchVersion: 0,
        },
    );
    if !at_least_13 {
        return Err(IpcError::new(
            ErrorCode::ToolNotFound,
            "한국어 인식은 macOS 13 이상이 필요합니다",
        ));
    }

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);

    // 2차 가드 — 13+에서만 안전하게 부를 수 있다. 여기까지 왔으면 위 검사가 통과한 것이다.
    let supported = unsafe { request.supportedRecognitionLanguagesAndReturnError() }
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("Vision 언어 목록 조회 실패: {e}")))?;
    // `to_vec`로 받는다 — `iter()`는 objc2-foundation의 `NSEnumerator` 피처를 요구하는데,
    // 이 짧은 목록 하나 때문에 피처를 늘릴 이유가 없다.
    let tags: Vec<String> = supported.to_vec().iter().map(|s| s.to_string()).collect();
    if !tags.iter().any(|t| t == "ko-KR") {
        return Err(IpcError::new(
            ErrorCode::ToolNotFound,
            format!(
                "이 macOS의 Vision에 한국어가 없습니다 (지원: {})",
                tags.join(", ")
            ),
        ));
    }
    let wanted = NSArray::from_retained_slice(&[
        NSString::from_str("ko-KR"),
        NSString::from_str("en-US"),
    ]);
    request.setRecognitionLanguages(&wanted);

    let data = NSData::with_bytes(png);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );
    let request_ref: &VNRequest = &request;
    handler
        .performRequests_error(&NSArray::from_slice(&[request_ref]))
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("Vision 인식 실패: {e}")))?;

    let mut lines = Vec::new();
    let mut glyph_heights = Vec::new();
    // 결과가 `None`인 것은 실패가 아니라 "글자를 하나도 못 찾았다"이다 — 빈 패널로 보여 준다.
    let observations = match request.results() {
        Some(r) => r.to_vec(),
        None => Vec::new(),
    };
    for observation in observations {
        let candidates = observation.topCandidates(1);
        let Some(top) = candidates.to_vec().into_iter().next() else {
            continue;
        };
        let text = top.string().to_string();
        if text.trim().is_empty() {
            continue;
        }
        // boundingBox는 정규화 [0,1]에 **원점이 좌하단**이다 — 위에서부터 재는 우리 좌표로 뒤집는다.
        let bb = unsafe { observation.boundingBox() };
        let b = OcrBox {
            x: bb.origin.x as f32 * width,
            y: (1.0 - bb.origin.y as f32 - bb.size.height as f32) * height,
            w: bb.size.width as f32 * width,
            h: bb.size.height as f32 * height,
        };
        // Vision은 단어 상자를 주지 않으므로 글자 높이 = 줄 상자 높이. 임계값(14px)이 그만큼
        // 여유 있어 ÷1.2 같은 보정을 따로 하지 않는다.
        glyph_heights.push(b.h);
        lines.push(OcrLine { text, r#box: b });
    }

    Ok(EnginePass {
        engine: OcrEngineKind::AppleVision,
        languages: vec!["ko-KR".to_string(), "en-US".to_string()],
        lines,
        glyph_heights,
        warnings: Vec::new(),
        dimension_limit: u32::MAX,
    })
}

// ════════════════════════════ Linux — 시스템 tesseract CLI ════════════════════════════

#[cfg(target_os = "linux")]
async fn engine_pass(img: std::sync::Arc<image::RgbaImage>) -> Result<EnginePass, IpcError> {
    let png = tokio::task::spawn_blocking(move || encode_png(&img))
        .await
        .map_err(join_err)??;
    tesseract_recognize(&png).await
}

/// `run_tool_stdin`이 이미 async(tokio 프로세스 + 타임아웃 + kill_on_drop)라 blocking 풀로
/// 보내지 않는다. 단발 프로세스라 `spawn_launcher`(cgroup 위임)도 필요 없다 — `output()`이 회수한다.
#[cfg(target_os = "linux")]
async fn tesseract_recognize(png: &[u8]) -> Result<EnginePass, IpcError> {
    use crate::tools::runner::{find_on_path, run_tool_stdin, ToolBin, ToolSource};

    let Some(path) = find_on_path("tesseract") else {
        return Err(IpcError::new(
            ErrorCode::ToolNotFound,
            "tesseract가 없습니다 — Debian/Ubuntu: sudo apt install tesseract-ocr tesseract-ocr-kor · \
             Fedora: sudo dnf install tesseract tesseract-langpack-kor · \
             Arch: sudo pacman -S tesseract tesseract-data-kor",
        ));
    };
    let bin = ToolBin {
        path,
        source: ToolSource::Path,
    };
    // `stdin`/`stdout`은 파일명이 아니라 tesseract가 아는 예약어다(이미지를 std::cin에서 읽고
    // 결과를 stdout으로). 임시 파일을 만들지 않아도 되는 이유.
    let out = run_tool_stdin(
        &bin,
        &["stdin", "stdout", "-l", "kor+eng", "--psm", "3", "tsv"],
        png,
        None,
        60,
    )
    .await?;
    if out.code != 0 {
        if out.stderr.contains("Error opening data file") {
            return Err(IpcError::new(
                ErrorCode::ToolNotFound,
                "tesseract 한국어 데이터(kor)가 없습니다 — Debian/Ubuntu: sudo apt install \
                 tesseract-ocr-kor · Fedora: sudo dnf install tesseract-langpack-kor · \
                 Arch: sudo pacman -S tesseract-data-kor",
            ));
        }
        return Err(IpcError::new(
            ErrorCode::Io,
            format!("tesseract 실패 (종료 코드 {}): {}", out.code, out.stderr.trim()),
        ));
    }
    let tsv = String::from_utf8(out.stdout).map_err(|_| {
        IpcError::new(ErrorCode::Io, "tesseract 출력이 UTF-8이 아닙니다")
    })?;
    let lines = parse_tsv(&tsv);
    let glyph_heights = lines.iter().map(|l| l.r#box.h).collect();

    Ok(EnginePass {
        engine: OcrEngineKind::TesseractCli,
        languages: vec!["kor".to_string(), "eng".to_string()],
        lines,
        glyph_heights,
        warnings: Vec::new(),
        dimension_limit: u32::MAX,
    })
}

// ════════════════════════════ 그 외 OS ════════════════════════════

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
async fn engine_pass(_img: std::sync::Arc<image::RgbaImage>) -> Result<EnginePass, IpcError> {
    Err(IpcError::new(
        ErrorCode::ToolNotFound,
        "이 운영체제에는 쓸 수 있는 내장 OCR 엔진이 없습니다",
    ))
}

// ════════════════════════════ 커맨드 ════════════════════════════

/// 레포 안 이미지 한 장의 글자를 뽑는다. 프롤로그는 `read_file_base64`와 같은 순서지만
/// 경로 검증만 [`resolve_in_repo`]로 한 단계 더 조인다(canonicalize로 심볼릭 링크 탈출까지 차단).
#[tauri::command(async)]
pub async fn ocr_image(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<OcrResult, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let full = resolve_in_repo(&repo, &rel_path)?;
    // 크기를 먼저 본다 — 읽고 나서 거절하면 거대 파일도 일단 메모리에 올렸다가 버린다.
    let meta = tokio::fs::metadata(&full)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("{rel_path} 정보 읽기 실패: {e}")))?;
    if meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err(IpcError::new(
            ErrorCode::Io,
            "파일이 너무 큽니다 (25MB 초과)",
        ));
    }
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("{rel_path} 읽기 실패: {e}")))?;
    let img = tokio::task::spawn_blocking(move || decode_rgba(&bytes))
        .await
        .map_err(join_err)??;
    recognize_two_pass(img).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, x: f32, y: f32) -> OcrLine {
        OcrLine {
            text: text.to_string(),
            r#box: OcrBox {
                x,
                y,
                w: 180.0,
                h: 20.0,
            },
        }
    }

    /// IPC 경계는 컴파일러가 못 본다 — 필드 이름이 하나라도 어긋나면 양쪽 다 빌드에 성공하고
    /// 프론트에서 `undefined`로만 드러난다. 직렬화된 모양을 여기서 고정한다.
    #[test]
    fn ocr_result_serializes_to_the_ipc_contract() {
        let json = serde_json::to_value(OcrResult {
            engine: OcrEngineKind::WindowsOcr,
            languages: vec!["ko-KR".to_string()],
            lines: vec![line("릴리스", 1.0, 2.0)],
            text: "릴리스".to_string(),
            warnings: vec![UPSCALED_WARNING.to_string()],
        })
        .expect("OcrResult 직렬화");
        assert_eq!(json["engine"], "windows_ocr");
        assert_eq!(json["languages"][0], "ko-KR");
        assert_eq!(json["lines"][0]["text"], "릴리스");
        // `r#box`가 `box`로 나가야 한다 — 여기가 어긋나면 강조 상자가 통째로 안 그려진다.
        assert_eq!(json["lines"][0]["box"]["x"], 1.0);
        assert_eq!(json["lines"][0]["box"]["h"], 20.0);
        assert!(json["warnings"][0].as_str().is_some_and(|w| w.contains("2배")));
    }

    #[test]
    fn median_of_picks_middle_and_survives_empty() {
        assert_eq!(median_of(&mut []), 0.0);
        assert_eq!(median_of(&mut [30.0, 10.0, 20.0]), 20.0);
    }

    /// 임계값 경계는 실측점(13px 이득 / 16px 손해) 사이라 상수 하나가 품질을 가른다.
    #[test]
    fn needs_upscale_boundary() {
        assert!(needs_upscale(14.0, 100, 100, u32::MAX), "14px는 확대 대상");
        assert!(!needs_upscale(15.0, 100, 100, u32::MAX), "15px는 원본 유지");
        // 줄이 하나도 없으면 중앙값이 0 — 확대해도 얻을 게 없다.
        assert!(!needs_upscale(0.0, 100, 100, u32::MAX));
        // 엔진 치수 한계(Windows MaxImageDimension)를 2배가 넘으면 안 한다.
        assert!(!needs_upscale(10.0, 6000, 100, 10_000));
        assert!(needs_upscale(10.0, 4000, 100, 10_000));
        // OCR_MAX_PIXELS(50MP) — 4000×4000의 2배는 64MP라 거절.
        assert!(!needs_upscale(10.0, 4000, 4000, u32::MAX));
        assert!(needs_upscale(10.0, 3000, 3000, u32::MAX));
    }

    /// 두 단 배치 — 오른쪽 단의 y가 왼쪽보다 **살짝 작게** 두었다. y만으로 정렬하면
    /// 각 행이 우→좌로 뒤집혀 나오므로, 이 단언은 행 묶기 + x 정렬이 실제로 돌 때만 통과한다.
    #[test]
    fn order_lines_groups_rows_then_sorts_by_x() {
        let shuffled = vec![
            line("우1", 200.0, 40.0),
            line("좌2", 0.0, 82.0),
            line("우0", 200.0, 0.0),
            line("좌0", 0.0, 3.0),
            line("우2", 200.0, 80.0),
            line("좌1", 0.0, 41.0),
        ];
        let got: Vec<String> = order_lines(shuffled).into_iter().map(|l| l.text).collect();
        assert_eq!(got, ["좌0", "우0", "좌1", "우1", "좌2", "우2"]);
    }

    /// 헤더 1줄 · 구조 행(level 1~3, conf -1) · 방출 순서가 어긋난 단어 · 읽기 순서와
    /// 어긋난 줄이 모두 들어 있는 고정 입력.
    const TSV: &str = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0\t0\t800\t200\t-1\t
2\t1\t1\t0\t0\t0\t10\t10\t780\t180\t-1\t
3\t1\t1\t1\t0\t0\t10\t10\t780\t180\t-1\t
4\t1\t1\t1\t1\t0\t10\t120\t300\t24\t-1\t
5\t1\t1\t1\t1\t2\t210\t120\t100\t24\t91\t푸시에서
5\t1\t1\t1\t1\t1\t110\t120\t90\t24\t95\t태그
5\t1\t1\t1\t1\t0\t10\t120\t90\t24\t96\t릴리스는
4\t1\t1\t1\t2\t0\t10\t20\t400\t24\t-1\t
5\t1\t1\t1\t2\t1\t120\t20\t200\t24\t88\tjson
5\t1\t1\t1\t2\t0\t10\t20\t100\t24\t90\tlatest
5\t1\t1\t1\t2\t2\t0\t0\t0\t0\t-1\t
";

    #[test]
    fn parse_tsv_joins_words_and_drops_structural_rows() {
        let lines = parse_tsv(TSV);
        assert_eq!(lines.len(), 2, "구조 행·헤더가 줄로 새어 나왔다: {lines:?}");
        assert_eq!(lines[0].text, "릴리스는 태그 푸시에서");
        assert_eq!(
            lines[0].r#box,
            OcrBox {
                x: 10.0,
                y: 120.0,
                w: 300.0,
                h: 24.0
            }
        );
        assert_eq!(lines[1].text, "latest json");
    }

    #[test]
    fn parse_tsv_output_orders_into_reading_order() {
        let got: Vec<String> = order_lines(parse_tsv(TSV))
            .into_iter()
            .map(|l| l.text)
            .collect();
        assert_eq!(got, ["latest json", "릴리스는 태그 푸시에서"]);
    }
}
