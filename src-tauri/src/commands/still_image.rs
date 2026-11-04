//! image 크레이트·웹뷰가 못 여는 사진(HEIC/HEIF·AVIF·TIFF·ICO…)을 ffmpeg로 JPEG로 바꾼다 — 폴더 창의 썸네일·라이트박스.
//!
//! iPhone HEIC 한 장은 512px 타일 수십 장(그리드 항목)이다. ffmpeg CLI는 그리드를 스스로 잇지 않고 첫 타일만 디코드한다
//! (8.0 실측: 4032×3024 사진 → 512×512 조각, `-map 0:g:0`도 타일을 따로 낸다). 그래서 ffprobe의 stream group(Tile Grid)
//! 배치대로 xstack으로 잇고 crop한다. 회전(irot)은 타일에 붙지 않고 같은 파일의 썸네일 항목에만 display matrix로 나온다 —
//! 그 값을 이은 그림에 한 번 적용한다(파일 안 EXIF Orientation과 일치 실측: 3↔-180, 6↔-90). 그리드가 아닌 사진은
//! ffmpeg의 자동 회전에 맡긴다.

use std::path::Path;
use std::sync::OnceLock;

use serde::Deserialize;
use tokio::sync::Semaphore;

use super::video::{run_capture_bytes, FfmpegBin};
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;

#[derive(Deserialize, Default)]
struct Probe {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    #[serde(default)]
    stream_groups: Vec<ProbeGroup>,
}

#[derive(Deserialize, Default)]
struct ProbeStream {
    #[serde(default)]
    index: u32,
    #[serde(default)]
    codec_type: String,
    #[serde(default)]
    disposition: Disposition,
    #[serde(default)]
    side_data_list: Vec<SideData>,
}

#[derive(Deserialize, Default)]
struct Disposition {
    #[serde(default)]
    default: u8,
    /// 그리드의 타일 — 홀로는 그림이 아니다(7.0 이전 ffprobe엔 없다 → 0).
    #[serde(default)]
    dependent: u8,
}

#[derive(Deserialize, Default)]
struct SideData {
    rotation: Option<f64>,
}

#[derive(Deserialize, Default)]
struct ProbeGroup {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    disposition: Disposition,
    #[serde(default)]
    components: Vec<GridComponent>,
}

#[derive(Deserialize, Default)]
struct GridComponent {
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    horizontal_offset: u32,
    #[serde(default)]
    vertical_offset: u32,
    #[serde(default)]
    subcomponents: Vec<GridTile>,
}

#[derive(Deserialize, Default)]
struct GridTile {
    stream_index: u32,
    tile_horizontal_offset: u32,
    tile_vertical_offset: u32,
}

/// 긴 변 `max_edge` 안으로 줄인 JPEG 바이트(키우지는 않는다). `quality`는 mjpeg `-q:v`(2 = 가장 좋음 쪽).
pub(crate) async fn still_to_jpeg(bin: &FfmpegBin, file: &Path, max_edge: u32, quality: u8) -> Result<Vec<u8>, IpcError> {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    // ffmpeg 하나가 4K HEIC 를 잇는 데 코어 여럿·수백 MB 를 쓴다 — 3천 장 폴더를 열어도 동시에 셋까지.
    let _slot = SLOTS
        .get_or_init(|| Semaphore::new(3))
        .acquire()
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::fav_thumb_wait_failed(e)))?;
    let src = file.display().to_string();
    let probe = match &bin.ffprobe {
        Some(ffprobe) => {
            let args = ["-v", "error", "-show_streams", "-show_stream_groups", "-of", "json", src.as_str()];
            match run_capture_bytes(ffprobe, &args, 20).await {
                Ok((0, out, _)) => serde_json::from_slice(&out).unwrap_or_default(),
                // 못 읽어도 ffmpeg 가 첫 영상 스트림으로 해 본다(그리드가 아니면 그걸로 맞다) — 실패는 ffmpeg 가 말한다.
                _ => Probe::default(),
            }
        }
        None => Probe::default(),
    };
    let args = still_args(&src, &probe, max_edge, quality);
    let (code, out, err) = run_capture_bytes(&bin.ffmpeg, &args, 60).await?;
    if code != 0 || out.is_empty() {
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
        return Err(IpcError::new(ErrorCode::Io, text_files::fav_image_open_failed(line)));
    }
    Ok(out)
}

fn still_args(src: &str, probe: &Probe, max_edge: u32, quality: u8) -> Vec<String> {
    let scale = format!("scale='min({max_edge},iw)':'min({max_edge},ih)':force_original_aspect_ratio=decrease");
    let graph = match main_grid(probe) {
        Some(g) => {
            let crop = format!("crop={}:{}:{}:{}", g.width, g.height, g.horizontal_offset, g.vertical_offset);
            let tiles: String = g.subcomponents.iter().map(|t| format!("[0:{}]", t.stream_index)).collect();
            let stitched = if g.subcomponents.len() == 1 {
                format!("{tiles}{crop}")
            } else {
                let layout: Vec<String> = g
                    .subcomponents
                    .iter()
                    .map(|t| format!("{}_{}", t.tile_horizontal_offset, t.tile_vertical_offset))
                    .collect();
                format!("{tiles}xstack=inputs={}:layout={},{crop}", g.subcomponents.len(), layout.join("|"))
            };
            format!("{stitched}{},{scale}[out]", rotate_filter(grid_rotation(probe)))
        }
        None => format!("[0:{}]{scale}[out]", main_stream(probe)),
    };
    [
        "-hide_banner", "-nostdin", "-v", "error", "-i", src, "-filter_complex", &graph, "-map", "[out]", "-frames:v", "1",
        "-c:v", "mjpeg", "-q:v", &quality.to_string(), "-f", "image2pipe", "pipe:1",
    ]
    .map(String::from)
    .to_vec()
}

/// 본 그림의 그리드 — 기본(default) 그리드, 없으면 첫 그리드. 두 번째 그리드는 대개 HDR 게인 맵(회색)이다.
fn main_grid(probe: &Probe) -> Option<&GridComponent> {
    let grids = || probe.stream_groups.iter().filter(|g| g.kind == "Tile Grid");
    grids()
        .find(|g| g.disposition.default != 0)
        .or_else(|| grids().next())
        .and_then(|g| g.components.first())
        .filter(|c| !c.subcomponents.is_empty() && c.width > 0 && c.height > 0)
}

/// 그리드가 아닐 때 디코드할 스트림 — 기본 스트림, 없으면 첫 영상 스트림(보통 0번).
fn main_stream(probe: &Probe) -> String {
    let video = || probe.streams.iter().filter(|s| s.codec_type == "video");
    video()
        .find(|s| s.disposition.default != 0)
        .or_else(|| video().next())
        .map_or_else(|| "V:0".into(), |s| s.index.to_string())
}

/// 그리드의 회전 — 타일이 아닌 영상 스트림(썸네일 항목)의 display matrix 회전(도, ffprobe 부호).
fn grid_rotation(probe: &Probe) -> f64 {
    probe
        .streams
        .iter()
        .filter(|s| s.codec_type == "video" && s.disposition.dependent == 0)
        .find_map(|s| s.side_data_list.iter().find_map(|d| d.rotation))
        .unwrap_or(0.0)
}

/// ffmpeg 의 자동 회전과 같은 규칙 — display matrix 회전 r 에 대해 θ = -r 만큼 시계 방향으로 돌린다.
fn rotate_filter(rotation: f64) -> &'static str {
    match ((-rotation.round() as i64) % 360 + 360) % 360 {
        90 => ",transpose=clock",
        180 => ",hflip,vflip",
        270 => ",transpose=cclock",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실제 iPhone HEIC 의 ffprobe 출력에서 줄인 것 — 2×2 타일 그리드(+게인 맵 그리드) + 회전 -90 인 썸네일 항목.
    const HEIC_PROBE: &str = r#"{
      "streams": [
        {"index":0,"codec_type":"video","disposition":{"default":0,"dependent":1}},
        {"index":1,"codec_type":"video","disposition":{"default":0,"dependent":1}},
        {"index":2,"codec_type":"video","disposition":{"default":0,"dependent":1}},
        {"index":3,"codec_type":"video","disposition":{"default":0,"dependent":1}},
        {"index":4,"codec_type":"video","width":320,"height":240,"disposition":{"default":0,"dependent":0},
         "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]},
        {"index":5,"codec_type":"video","disposition":{"default":0,"dependent":1}}
      ],
      "stream_groups": [
        {"index":1,"type":"Tile Grid","disposition":{"default":0},"components":[{"nb_tiles":1,"width":256,"height":256,
          "subcomponents":[{"stream_index":5,"tile_horizontal_offset":0,"tile_vertical_offset":0}]}]},
        {"index":0,"type":"Tile Grid","disposition":{"default":1},"components":[{"nb_tiles":4,"coded_width":1024,
          "coded_height":1024,"horizontal_offset":0,"vertical_offset":0,"width":1000,"height":900,"subcomponents":[
          {"stream_index":0,"tile_horizontal_offset":0,"tile_vertical_offset":0},
          {"stream_index":1,"tile_horizontal_offset":512,"tile_vertical_offset":0},
          {"stream_index":2,"tile_horizontal_offset":0,"tile_vertical_offset":512},
          {"stream_index":3,"tile_horizontal_offset":512,"tile_vertical_offset":512}]}]}
      ]
    }"#;

    fn graph_of(args: &[String]) -> &str {
        &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1]
    }

    #[test]
    fn heic_grid_is_stitched_cropped_then_rotated_once() {
        let probe: Probe = serde_json::from_str(HEIC_PROBE).unwrap();
        let a = still_args("in.heic", &probe, 640, 4);
        assert_eq!(
            graph_of(&a),
            "[0:0][0:1][0:2][0:3]xstack=inputs=4:layout=0_0|512_0|0_512|512_512,crop=1000:900:0:0,transpose=clock,\
             scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease[out]",
            "기본 그리드를 고르고(게인 맵 아님), 회전은 썸네일 항목의 값으로 이은 뒤 한 번"
        );
        assert!(a.windows(2).any(|w| w == ["-i", "in.heic"]) && a.windows(2).any(|w| w == ["-q:v", "4"]));
    }

    #[test]
    fn non_grid_uses_default_stream_and_ffmpeg_autorotate() {
        let single: Probe = serde_json::from_str(
            r#"{"streams":[{"index":0,"codec_type":"video","disposition":{"default":0}},
                {"index":1,"codec_type":"video","disposition":{"default":1},"side_data_list":[{"rotation":-90}]}]}"#,
        )
        .unwrap();
        let g = still_args("a.avif", &single, 4096, 2);
        assert!(graph_of(&g).starts_with("[0:1]scale="), "{}", graph_of(&g));
        assert!(!graph_of(&g).contains("transpose"), "그리드가 아니면 회전은 ffmpeg 자동 회전 몫(두 번 돌지 않게)");
        // ffprobe 를 못 돌렸으면 첫 영상 스트림
        assert!(graph_of(&still_args("a.tif", &Probe::default(), 640, 4)).starts_with("[0:V:0]scale="));
    }

    #[test]
    fn rotation_matches_ffmpeg_autorotate() {
        assert_eq!(rotate_filter(-90.0), ",transpose=clock");
        assert_eq!(rotate_filter(90.0), ",transpose=cclock");
        assert_eq!(rotate_filter(-180.0), ",hflip,vflip");
        assert_eq!(rotate_filter(180.0), ",hflip,vflip");
        assert_eq!(rotate_filter(0.0), "");
    }

    /// 실제 사진으로 — `GPV_HEIC_SAMPLE=<HEIC 경로> cargo test --lib still_real -- --ignored --nocapture`.
    /// 이은 그림이 타일(512)이 아니라 사진 크기 비율이어야 한다.
    #[tokio::test]
    #[ignore = "실제 HEIC 와 PATH 의 ffmpeg 필요"]
    async fn still_real_heic_is_whole_photo() {
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let ffprobe = crate::tools::runner::find_on_path("ffprobe");
        let src = std::path::PathBuf::from(std::env::var("GPV_HEIC_SAMPLE").expect("GPV_HEIC_SAMPLE"));
        let bin = FfmpegBin { ffmpeg: ffmpeg.clone(), ffprobe, source: "path" };
        let jpg = still_to_jpeg(&bin, &src, 640, 4).await.unwrap_or_else(|e| panic!("{}", e.message));
        let img = image::load_from_memory(&jpg).unwrap();
        eprintln!("{}×{} {} B", img.width(), img.height(), jpg.len());
        assert_eq!(img.width().max(img.height()), 640, "긴 변이 640 이어야 한다(타일 하나면 512 정사각형)");
        assert_ne!(img.width(), img.height(), "사진은 4:3 — 정사각형이면 타일 하나만 나온 것");
    }
}
