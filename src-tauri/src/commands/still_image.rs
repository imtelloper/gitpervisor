//! image 크레이트·웹뷰가 못 여는 사진(HEIC/HEIF·AVIF·TIFF·ICO…)을 ffmpeg로 JPEG로 바꾼다 — 폴더 창의 썸네일·라이트박스.
//!
//! iPhone HEIC 한 장은 512px 타일 수십 장(그리드 항목)이다. ffmpeg CLI는 그리드를 스스로 잇지 않고 첫 타일만 디코드한다
//! (8.0 실측: 4032×3024 사진 → 512×512 조각, `-map 0:g:0`도 타일을 따로 낸다). 그래서 ffprobe의 stream group(Tile Grid)
//! 배치대로 xstack으로 잇고 crop한다. 회전(irot)은 타일에 붙지 않고 같은 파일의 썸네일 항목에만 display matrix로 나온다 —
//! 그 값을 이은 그림에 한 번 적용한다(파일 안 EXIF Orientation과 일치 실측: 3↔-180, 6↔-90). 그리드가 아닌 사진은
//! ffmpeg의 자동 회전에 맡긴다.
//!
//! 빠르게(태스크 79, `DOCS/task/79-heic-speed.md`): 썸네일 크기는 그리드를 잇지 않고 파일 안 내장 썸네일 스트림만 푼다,
//! 디코더 스레드 풀을 끈다(`-threads 1`), probe 를 기억한다, 썸네일과 보기(뷰어·글자 인식)가 다른 줄에 선다.
//! Windows 썸네일은 그보다 먼저 WIC 가 해 본다(`still_image_wic.rs`).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

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
    width: u32,
    #[serde(default)]
    height: u32,
    /// 흑백(`gray*`)이면 깊이 맵·인물 매트·알파·게인 맵 같은 보조 항목이다 — 썸네일 후보가 아니다.
    #[serde(default)]
    pix_fmt: String,
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

/// 이 긴 변 이하는 "썸네일 크기" — 파일 안 내장 썸네일(iPhone 320×240)로 충분하다. 640 칸은 그리드를 잇는다.
pub(crate) const EMBEDDED_THUMB_MAX_EDGE: u32 = 320;

/// 변환이 서는 줄. 한 줄(FIFO)이던 때는 폴더를 열자마자 연 사진이 썸네일 수십 장 뒤에 서서 9~14초를 기다렸다(실측).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StillLane {
    /// 폴더 창 그리드·필름스트립·타이틀바 미리보기.
    Thumb,
    /// 사진 뷰어·글자 인식·편집기 — 한 번에 한두 장이다.
    View,
}

impl StillLane {
    fn slots(self) -> &'static Semaphore {
        static THUMB: OnceLock<Semaphore> = OnceLock::new();
        static VIEW: Semaphore = Semaphore::const_new(2);
        match self {
            // 코어 수를 못 읽으면 바닥(3)으로 — 종전 폭이다.
            Self::Thumb => THUMB.get_or_init(|| {
                Semaphore::new(thumb_slot_count(std::thread::available_parallelism().map_or(0, |n| n.get())))
            }),
            Self::View => &VIEW,
        }
    }
}

/// 썸네일 줄 폭. `-threads 1` 이면 ffmpeg 하나가 코어 하나 남짓이라 24코어에서 동시 6까지 처리량이 오른다(실측) —
/// 코어/4, 작은 기계도 종전(3)보다 좁히지 않는다.
fn thumb_slot_count(cores: usize) -> usize {
    (cores / 4).clamp(3, 6)
}

/// 긴 변 `max_edge` 안으로 줄인 JPEG 바이트(키우지는 않는다). `quality`는 mjpeg `-q:v`(2 = 가장 좋음 쪽).
///
/// `find_ffmpeg` 는 WIC 가 못 했을 때만 부른다 — ffmpeg 가 없는 Windows 에서도 HEIC 썸네일이 뜨게.
pub(crate) async fn still_to_jpeg(
    find_ffmpeg: impl FnOnce() -> Result<FfmpegBin, IpcError>,
    file: &Path,
    max_edge: u32,
    quality: u8,
    lane: StillLane,
) -> Result<Vec<u8>, IpcError> {
    // ffmpeg 하나가 4K HEIC 를 잇는 데 수백 MB 를 쓴다 — 3천 장 폴더를 열어도 줄마다 정한 수까지.
    let _slot = lane
        .slots()
        .acquire()
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text_files::fav_thumb_wait_failed(e)))?;
    #[cfg(windows)]
    if lane == StillLane::Thumb && max_edge <= EMBEDDED_THUMB_MAX_EDGE {
        if let Some(jpg) = super::still_image_wic::wic_thumb_jpeg(file, max_edge).await {
            return Ok(jpg);
        }
    }
    let bin = find_ffmpeg()?;
    let src = file.display().to_string();
    let probe = probe_cached(&bin, file, &src).await;
    let args = still_args(&src, &probe, max_edge, quality);
    let (code, out, err) = run_capture_bytes(&bin.ffmpeg, &args, 60).await?;
    if code != 0 || out.is_empty() {
        let line = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
        return Err(IpcError::new(ErrorCode::Io, text_files::fav_image_open_failed(line)));
    }
    Ok(out)
}

/// (경로, mtime, 크기) — 같은 파일을 썸네일 뒤에 뷰어가 또 probe 하던 ≈90ms 를 던다.
type ProbeKey = (PathBuf, SystemTime, u64);

/// ponytail: 256개 선형 탐색 — 한 번에 µs 단위라 HashMap+순서 목록은 아직 필요 없다.
struct ProbeLru(VecDeque<(ProbeKey, Arc<Probe>)>);

impl ProbeLru {
    const CAP: usize = 256;

    fn get(&mut self, key: &ProbeKey) -> Option<Arc<Probe>> {
        let at = self.0.iter().position(|(k, _)| k == key)?;
        let hit = self.0.remove(at)?;
        let probe = hit.1.clone();
        self.0.push_back(hit);
        Some(probe)
    }

    fn put(&mut self, key: ProbeKey, probe: Arc<Probe>) {
        self.0.retain(|(k, _)| *k != key);
        if self.0.len() >= Self::CAP {
            self.0.pop_front();
        }
        self.0.push_back((key, probe));
    }
}

static PROBES: Mutex<ProbeLru> = Mutex::new(ProbeLru(VecDeque::new()));

/// ffprobe 결과 — 같은 (경로, mtime, 크기)면 기억한 것. 락은 조회·기록 때만 잡는다(ffprobe 를 도는 동안 잡지 않는다).
async fn probe_cached(bin: &FfmpegBin, file: &Path, src: &str) -> Arc<Probe> {
    let Some(ffprobe) = &bin.ffprobe else { return Arc::default() };
    // 스탬프를 못 뜨면 기억하지 않고 매번 probe 한다 — 바뀐 파일에 옛 배치를 쓰는 것보다 느린 게 낫다.
    let key = tokio::fs::metadata(file)
        .await
        .ok()
        .and_then(|m| Some((file.to_path_buf(), m.modified().ok()?, m.len())));
    if let Some(hit) = key.as_ref().and_then(|k| PROBES.lock().unwrap_or_else(|e| e.into_inner()).get(k)) {
        return hit;
    }
    let args = ["-v", "error", "-show_streams", "-show_stream_groups", "-of", "json", src];
    let parsed = match run_capture_bytes(ffprobe, &args, 20).await {
        Ok((0, out, _)) => serde_json::from_slice::<Probe>(&out).ok(),
        _ => None,
    };
    // 못 읽어도 ffmpeg 가 첫 영상 스트림으로 해 본다(그리드가 아니면 그걸로 맞다) — 실패는 ffmpeg 가 말한다. 기억은 안 한다.
    let Some(probe) = parsed.map(Arc::new) else { return Arc::default() };
    if let Some(k) = key {
        PROBES.lock().unwrap_or_else(|e| e.into_inner()).put(k, probe.clone());
    }
    probe
}

fn still_args(src: &str, probe: &Probe, max_edge: u32, quality: u8) -> Vec<String> {
    let scale = format!("scale='min({max_edge},iw)':'min({max_edge},ih)':force_original_aspect_ratio=decrease");
    let thumb = grid_thumb_stream(probe, max_edge);
    let graph = match main_grid(probe).filter(|_| thumb.is_none()) {
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
        // 그리드가 아니면 본 스트림, 그리드라도 썸네일 크기면 내장 썸네일 스트림만(타일 48장을 잇지 않는다 — 5배 싸다).
        // 회전은 둘 다 ffmpeg 자동 회전(display matrix) 몫이다 — 썸네일 스트림에 transpose 를 또 걸면 두 번 돈다.
        None => format!("[0:{}]{scale}[out]", thumb.map_or_else(|| main_stream(probe), |i| i.to_string())),
    };
    // `-threads 1`: 타일 디코더마다 프레임 스레드 풀(한 장에 ~800 스레드)을 만들던 것을 끈다 — 인트라 한 장이라 쓸모가
    // 없고, 끄면 출력은 바이트까지 같고 2~3배 빠르다(실측). 입력 옵션이라 `-i` 앞이어야 한다.
    [
        "-hide_banner", "-nostdin", "-v", "error", "-threads", "1", "-filter_complex_threads", "1", "-i", src,
        "-filter_complex", &graph, "-map", "[out]", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", &quality.to_string(), "-f",
        "image2pipe", "pipe:1",
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

/// 그리드 사진 안의 내장 썸네일 스트림 — 썸네일 크기(`EMBEDDED_THUMB_MAX_EDGE` 이하) 요청이고, 타일이 아닌(의존 아닌·어느
/// 그리드에도 안 든) 영상 스트림 중 긴 변이 가장 큰 것이 `max_edge` 이상일 때만. iPhone 은 320×240 하나다(`grid_rotation`
/// 이 회전을 읽는 그 스트림). 키워서 흐린 썸네일을 만들지 않게 작으면 None — 그리드를 잇는다.
fn grid_thumb_stream(probe: &Probe, max_edge: u32) -> Option<u32> {
    if max_edge > EMBEDDED_THUMB_MAX_EDGE || main_grid(probe).is_none() {
        return None;
    }
    let tile = |i: u32| {
        probe.stream_groups.iter().flat_map(|g| &g.components).flat_map(|c| &c.subcomponents).any(|t| t.stream_index == i)
    };
    probe
        .streams
        .iter()
        // ffmpeg 의 HEIF 디먹서는 `auxl` 을 모른다 — 인물 모드 사진의 깊이 맵(≈768px)·매트가 의존 0 의 평범한 영상 스트림으로 나온다.
        // "가장 큰 것"을 고르면 그게 썸네일 자리를 차지해 회색 실루엣이 된다 → 흑백을 빼고, 칸을 채우는 것 중 **가장 작은 것**.
        .filter(|s| s.codec_type == "video" && s.disposition.dependent == 0 && !tile(s.index) && !s.pix_fmt.starts_with("gray"))
        .filter(|s| s.width.max(s.height) >= max_edge)
        .min_by_key(|s| s.width.max(s.height))
        .map(|s| s.index)
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

    /// 썸네일 크기(192·320)는 내장 썸네일 스트림만, 그보다 크면(640·4096) 그리드 — 그리드 경로가 다시 쓰이면 192 단언이
    /// xstack 으로 깨지고, 크기 조건이 빠지면 640 단언이 깨진다.
    #[test]
    fn thumb_sizes_decode_only_the_embedded_thumbnail_stream() {
        let probe: Probe = serde_json::from_str(HEIC_PROBE).unwrap();
        for edge in [192, 320] {
            let a = still_args("in.heic", &probe, edge, 4);
            assert_eq!(
                graph_of(&a),
                format!("[0:4]scale='min({edge},iw)':'min({edge},ih)':force_original_aspect_ratio=decrease[out]"),
                "edge {edge}: 썸네일 스트림(4)만, transpose 없이(ffmpeg 자동 회전)"
            );
        }
        for edge in [640, 4096] {
            assert!(graph_of(&still_args("in.heic", &probe, edge, 2)).contains("xstack"), "edge {edge}: 그리드를 잇는다");
        }
        // 썸네일 스트림이 없거나 칸보다 작으면 그리드 — 키워서 흐린 썸네일을 만들지 않는다.
        let mut none = serde_json::from_str::<Probe>(HEIC_PROBE).unwrap();
        none.streams.retain(|s| s.index != 4);
        assert!(graph_of(&still_args("in.heic", &none, 192, 4)).contains("xstack"));
        let mut small = serde_json::from_str::<Probe>(HEIC_PROBE).unwrap();
        small.streams[4].width = 160;
        small.streams[4].height = 120;
        assert!(graph_of(&still_args("in.heic", &small, 192, 4)).contains("xstack"));
        assert!(graph_of(&still_args("in.heic", &small, 128, 4)).starts_with("[0:4]scale="));
        // 옛 ffprobe(dependent 칸 없음)는 타일도 의존 0 — 그리드에 든 스트림은 썸네일 후보가 아니다.
        let mut old = serde_json::from_str::<Probe>(HEIC_PROBE).unwrap();
        for s in &mut old.streams {
            s.disposition.dependent = 0;
            (s.width, s.height) = if s.index == 4 { (320, 240) } else { (512, 512) };
        }
        assert!(graph_of(&still_args("in.heic", &old, 192, 4)).starts_with("[0:4]scale="));
        // 인물 모드 — 의존 0 인 흑백 깊이 맵(768×576)이 섞여도 320×240 썸네일을 고른다(가장 큰 것을 고르면 깊이 맵이 된다).
        let mut portrait = serde_json::from_str::<Probe>(HEIC_PROBE).unwrap();
        portrait.streams.push(serde_json::from_str(r#"{"index":6,"codec_type":"video","width":768,"height":576,"pix_fmt":"gray","disposition":{"default":0,"dependent":0}}"#).unwrap());
        // 흑백이 아닌 더 큰 보조 항목이 있어도 칸을 채우는 가장 작은 것.
        portrait.streams.push(serde_json::from_str(r#"{"index":7,"codec_type":"video","width":1024,"height":768,"pix_fmt":"yuvj420p","disposition":{"default":0,"dependent":0}}"#).unwrap());
        assert!(graph_of(&still_args("in.heic", &portrait, 192, 4)).starts_with("[0:4]scale="), "{}", graph_of(&still_args("in.heic", &portrait, 192, 4)));
        assert!(graph_of(&still_args("in.heic", &portrait, 320, 4)).starts_with("[0:4]scale="));
    }

    /// 디코더 스레드 풀을 끄는 두 플래그는 입력 옵션이라 `-i` 앞이어야 먹는다(뒤면 출력 옵션이 돼 효과가 없다).
    #[test]
    fn thread_flags_come_before_the_input() {
        let probe: Probe = serde_json::from_str(HEIC_PROBE).unwrap();
        for edge in [192, 4096] {
            let a = still_args("in.heic", &probe, edge, 2);
            let input = a.iter().position(|x| x == "-i").unwrap();
            for flag in ["-threads", "-filter_complex_threads"] {
                let at = a.iter().position(|x| x == flag).unwrap_or_else(|| panic!("{flag} 없음"));
                assert!(at < input && a[at + 1] == "1", "{flag} 1 이 -i 앞에: {a:?}");
            }
        }
    }

    /// 같은 (경로, mtime, 크기)만 맞는다 · 꺼낸 것은 최근으로 · 256개를 넘으면 가장 오래 안 쓴 것부터.
    #[test]
    fn probe_lru_keys_on_stamp_and_evicts_least_recent() {
        let t0 = SystemTime::UNIX_EPOCH;
        let key = |i: usize| (PathBuf::from(format!("p{i}.heic")), t0, 1);
        let mut lru = ProbeLru(VecDeque::new());
        for i in 0..ProbeLru::CAP {
            lru.put(key(i), Arc::default());
        }
        assert!(lru.get(&key(0)).is_some(), "0 을 꺼내 최근으로");
        assert!(lru.get(&(PathBuf::from("p1.heic"), t0 + std::time::Duration::from_millis(1), 1)).is_none(), "mtime 이 다르면 미스");
        assert!(lru.get(&(PathBuf::from("p1.heic"), t0, 2)).is_none(), "크기가 다르면 미스");
        lru.put(key(ProbeLru::CAP), Arc::default());
        assert_eq!(lru.0.len(), ProbeLru::CAP);
        assert!(lru.get(&key(1)).is_none(), "가장 오래 안 쓴 1 이 밀려난다");
        assert!(lru.get(&key(0)).is_some() && lru.get(&key(ProbeLru::CAP)).is_some());
        lru.put(key(0), Arc::default());
        assert_eq!(lru.0.iter().filter(|(k, _)| *k == key(0)).count(), 1, "같은 키는 한 벌");
    }

    #[test]
    fn thumb_lane_width_is_quarter_of_cores_within_3_to_6() {
        for (cores, want) in [(0, 3), (4, 3), (8, 3), (16, 4), (24, 6), (64, 6)] {
            assert_eq!(thumb_slot_count(cores), want, "{cores}코어");
        }
        assert_eq!(StillLane::View.slots().available_permits(), 2, "보기 줄은 둘");
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
        let jpg = still_to_jpeg(move || Ok(bin), &src, 640, 4, StillLane::View).await.unwrap_or_else(|e| panic!("{}", e.message));
        let img = image::load_from_memory(&jpg).unwrap();
        eprintln!("{}×{} {} B", img.width(), img.height(), jpg.len());
        assert_eq!(img.width().max(img.height()), 640, "긴 변이 640 이어야 한다(타일 하나면 512 정사각형)");
        assert_ne!(img.width(), img.height(), "사진은 4:3 — 정사각형이면 타일 하나만 나온 것");
    }
}
