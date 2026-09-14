// 동영상 프로브·내보내기·ffmpeg 획득 (DOCS/video-editor-design.md).
//
// 구조는 기존 선례의 조합이다 — 새 발명 없음:
// - 발견 체인:   tools/runner.rs discover (①설정 명시 경로 → ②PATH → ③관리 설치본)
// - 다운로드:    lsp/acquire.rs ensure_native (+ 대용량이라 스트리밍·바이트 진행률만 확장)
// - 장기 잡:     sync.rs (진행 이벤트 + 종결 이벤트 — 응답 유실 대비)
// - 취소:        http.rs (프론트 생성 job id + 레지스트리 + RAII 가드 + 멱등 cancel)
// - 스폰 규약:   git/runner.rs (args 배열, CREATE_NO_WINDOW, process_group(0), kill_group)
//
// 프로젝트 로컬(레포 안) ffmpeg는 **의도적으로 발견하지 않는다** — 레포가 심은 실행 파일을
// 여는 것만으로 돌리는 공급망 구멍이 된다(tools/runner.rs 모듈 doc과 같은 이유).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Command;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

// ══════════════════════════ 잡 레지스트리 (취소·종료 회수) ══════════════════════════

/// http.rs HttpReg와 동형 — Arc를 클론해 RAII 가드가 AppState 빌림과 무관하게 정리한다.
#[derive(Default, Clone)]
pub struct VideoReg {
    pub jobs: Arc<Mutex<HashMap<String, VideoJob>>>,
}

pub struct VideoJob {
    /// select! 취소 신호. kill_all이 send 후 pid 직접 kill로 이중 보장한다.
    pub cancel: Option<tokio::sync::oneshot::Sender<()>>,
    pub pid: Option<u32>,
}

/// RAII: drop 시점에 레지스트리에서 job을 제거 (성공/실패/취소/패닉 모두 — http.rs InflightGuard).
struct JobGuard {
    jobs: Arc<Mutex<HashMap<String, VideoJob>>>,
    job_id: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.job_id);
    }
}

/// 앱 종료 시 실행 중 ffmpeg 회수 — lib.rs shutdown_children의 shutdown_step에서 호출.
/// 취소 신호(임시파일 정리 경로)와 pid 직접 kill(런타임이 이미 멈춘 경우) 둘 다 보낸다.
pub fn video_kill_all(state: &AppState) {
    let jobs = {
        let reg = state.video.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(&reg.jobs)
    };
    let entries: Vec<VideoJob> = {
        let mut map = jobs.lock().unwrap_or_else(|e| e.into_inner());
        map.drain().map(|(_, v)| v).collect()
    };
    for mut job in entries {
        if let Some(tx) = job.cancel.take() {
            let _ = tx.send(());
        }
        if let Some(pid) = job.pid {
            kill_pid(pid);
        }
    }
}

/// ffmpeg는 자식을 만들지 않지만, unix는 spawn 시 process_group(0)을 줬으므로 그룹째 거둔다.
#[allow(unused_variables)]
fn kill_pid(pid: u32) {
    #[cfg(unix)]
    if pid > 1 {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(0x0800_0000)
            .status();
    }
}

// ══════════════════════════ 발견 체인 ══════════════════════════

pub(crate) struct FfmpegBin {
    pub ffmpeg: PathBuf,
    pub ffprobe: Option<PathBuf>,
    pub source: &'static str, // "explicit" | "path" | "managed"
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// ffprobe는 ffmpeg와 같은 폴더에서만 찾는다(배포 단위가 같다).
fn sibling_probe(ffmpeg: &Path) -> Option<PathBuf> {
    let p = ffmpeg.parent()?.join(exe_name("ffprobe"));
    p.is_file().then_some(p)
}

fn managed_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("tools"))
}

fn managed_ffmpeg(app: &AppHandle) -> Option<PathBuf> {
    let spec = ffmpeg_spec()?;
    let p = managed_root(app)?
        .join(format!("ffmpeg-{}", spec.version))
        .join(spec.exe_rel);
    p.is_file().then_some(p)
}

pub(crate) fn find_ffmpeg(app: &AppHandle, state: &AppState) -> Result<FfmpegBin, IpcError> {
    // ① 설정 명시 경로 — 지정했으면 그것만(조용한 폴백 금지, tools/runner.rs와 동일 원칙).
    let explicit = {
        let s = state.settings.read().unwrap_or_else(|e| e.into_inner());
        s.video_ffmpeg_path.clone()
    };
    if let Some(e) = explicit.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(e.trim());
        if crate::tools::runner::is_real_exe(&p) {
            return Ok(FfmpegBin {
                ffprobe: sibling_probe(&p),
                ffmpeg: p,
                source: "explicit",
            });
        }
        return Err(IpcError::new(
            ErrorCode::ToolNotFound,
            "설정한 ffmpeg 경로에 실행 파일이 없습니다 — 설정 › 코드 도구를 확인하세요",
        ));
    }
    // ② PATH (60초 미스 캐시, 셸 스폰 없음 — tools/runner.rs).
    if let Some(p) = crate::tools::runner::find_on_path("ffmpeg") {
        let ffprobe = sibling_probe(&p).or_else(|| crate::tools::runner::find_on_path("ffprobe"));
        return Ok(FfmpegBin {
            ffprobe,
            ffmpeg: p,
            source: "path",
        });
    }
    // ②′ 관례 설치 경로 — **PATH만 보면 GUI로 띄운 앱은 못 찾는다.**
    // Finder/독/시작메뉴로 띄운 프로세스의 PATH는 launchd(macOS: /usr/bin:/bin:/usr/sbin:/sbin)나
    // systemd가 주는 최소 집합이라, 셸 프로필이 넣어 주던 Homebrew 경로가 통째로 빠진다.
    // 그래서 "터미널에선 ffmpeg -version이 되는데 앱은 못 찾는다"가 된다 — 실제로 이 기계가
    // 그 상태였다(/usr/local/bin/ffmpeg 존재, 앱에서는 편집·변환 기능이 통째로 비활성).
    // CLAUDE.md의 "dev는 되는데 설치본만 이상하다 = 런치 환경변수 차이"와 같은 부류다.
    if let Some(p) = crate::tools::runner::find_in_wellknown_dirs("ffmpeg") {
        return Ok(FfmpegBin {
            ffprobe: sibling_probe(&p),
            ffmpeg: p,
            source: "wellknown",
        });
    }
    // ③ 관리 설치본 (설정에서 다운로드).
    if let Some(p) = managed_ffmpeg(app) {
        return Ok(FfmpegBin {
            ffprobe: sibling_probe(&p),
            ffmpeg: p,
            source: "managed",
        });
    }
    Err(IpcError::new(
        ErrorCode::ToolNotFound,
        "ffmpeg를 찾을 수 없습니다 — 설정 › 코드 도구에서 다운로드하거나 PATH에 설치하세요",
    ))
}

// ══════════════════════════ 공용 실행 헬퍼 ══════════════════════════

/// ffprobe·버전 조회 같은 짧은 실행 — run_git 골격 미러(타임아웃 시 그룹째 kill).
///
/// stdout은 **바이트 그대로** 돌려준다. 필름스트립 JPEG·PCM 파형처럼 바이너리를 파이프로
/// 받는 호출자가 있어서, from_utf8_lossy를 여기서 걸면 그 바이트가 U+FFFD로 망가진다.
async fn run_capture_bytes<S: AsRef<std::ffi::OsStr>>(
    bin: &Path,
    args: &[S],
    timeout_secs: u64,
) -> Result<(i32, Vec<u8>, String), IpcError> {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("실행 실패({}): {e}", bin.display())))?;
    let pid = child.id();
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| {
            if let Some(pid) = pid {
                kill_pid(pid);
            }
            IpcError::new(ErrorCode::Timeout, format!("실행 시간 초과 ({timeout_secs}초)"))
        })?
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("출력 수집 실패: {e}")))?;
    Ok((
        out.status.code().unwrap_or(-1),
        out.stdout,
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
}

/// 텍스트 stdout(ffprobe JSON·-version)용 얇은 래퍼.
async fn run_capture(
    bin: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(i32, String, String), IpcError> {
    let (code, out, err) = run_capture_bytes(bin, args, timeout_secs).await?;
    Ok((code, String::from_utf8_lossy(&out).into_owned(), err))
}

// ══════════════════════════ 도구 상태 ══════════════════════════

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoToolStatus {
    pub found: bool,
    pub source: Option<String>,
    pub path: Option<String>,
    pub probe_found: bool,
    pub version: Option<String>,
    /// 이 플랫폼에 앱 내 다운로드 스펙이 있는가 (없으면 UI가 패키지 관리자 안내).
    pub managed_supported: bool,
}

/// "ffmpeg version 9.0.1-essentials_build-www.gyan.dev ..." → "9.0.1-essentials_build-…" 첫 토큰.
fn parse_version(first_line: &str) -> Option<String> {
    let mut it = first_line.split_whitespace();
    (it.next()? == "ffmpeg" && it.next()? == "version").then(|| it.next())??
        .split('-')
        .next()
        .map(str::to_string)
}

#[tauri::command]
pub async fn video_tool_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VideoToolStatus, IpcError> {
    let managed_supported = ffmpeg_spec().is_some();
    match find_ffmpeg(&app, state.inner()) {
        Ok(bin) => {
            let version = run_capture(&bin.ffmpeg, &["-version"], 5)
                .await
                .ok()
                .and_then(|(_, out, _)| parse_version(out.lines().next().unwrap_or("")));
            Ok(VideoToolStatus {
                found: true,
                source: Some(bin.source.to_string()),
                path: Some(bin.ffmpeg.display().to_string()),
                probe_found: bin.ffprobe.is_some(),
                version,
                managed_supported,
            })
        }
        Err(_) => Ok(VideoToolStatus {
            found: false,
            source: None,
            path: None,
            probe_found: false,
            version: None,
            managed_supported,
        }),
    }
}

// ══════════════════════════ 프로브 ══════════════════════════

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMeta {
    pub duration_ms: u64,
    /// 회전 메타데이터를 반영한 **표시 기준** 크기 — 크롭 좌표계가 이것과 일치한다
    /// (재인코딩 시 ffmpeg가 autorotate 하므로 crop 필터도 표시 기준 프레임에 적용된다).
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub bitrate_kbps: Option<u64>,
    pub rotation: i64,
    pub has_audio: bool,
    pub has_video: bool,
}

/// "30000/1001" → 29.97. "0/0"(미상)은 None.
fn parse_rate(s: &str) -> Option<f64> {
    let (num, den) = s.split_once('/')?;
    let (num, den): (f64, f64) = (num.parse().ok()?, den.parse().ok()?);
    (den != 0.0 && num > 0.0).then_some(num / den)
}

fn parse_probe(json: &str) -> Result<VideoMeta, IpcError> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("ffprobe 출력 파싱 실패: {e}")))?;
    let empty = Vec::new();
    let streams = v["streams"].as_array().unwrap_or(&empty);
    let vs = streams.iter().find(|s| s["codec_type"] == "video");
    let audio = streams.iter().find(|s| s["codec_type"] == "audio");

    let (mut width, mut height, mut fps, mut rotation, mut vcodec) = (0u32, 0u32, 0f64, 0i64, None);
    if let Some(vs) = vs {
        width = vs["width"].as_u64().unwrap_or(0) as u32;
        height = vs["height"].as_u64().unwrap_or(0) as u32;
        vcodec = vs["codec_name"].as_str().map(str::to_string);
        fps = vs["avg_frame_rate"]
            .as_str()
            .and_then(parse_rate)
            .or_else(|| vs["r_frame_rate"].as_str().and_then(parse_rate))
            .unwrap_or(0.0);
        // 회전: side_data_list의 rotation(신식) 또는 tags.rotate(구식).
        rotation = vs["side_data_list"]
            .as_array()
            .and_then(|l| l.iter().find_map(|d| d["rotation"].as_i64()))
            .or_else(|| vs["tags"]["rotate"].as_str().and_then(|r| r.parse().ok()))
            .unwrap_or(0);
        if rotation.rem_euclid(180) == 90 {
            std::mem::swap(&mut width, &mut height);
        }
    }

    let duration_ms = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .map(|s| (s * 1000.0) as u64)
        .unwrap_or(0);
    let bitrate_kbps = v["format"]["bit_rate"]
        .as_str()
        .and_then(|b| b.parse::<u64>().ok())
        .map(|b| b / 1000);

    Ok(VideoMeta {
        duration_ms,
        width,
        height,
        fps,
        vcodec,
        acodec: audio.and_then(|a| a["codec_name"].as_str()).map(str::to_string),
        bitrate_kbps,
        rotation,
        has_audio: audio.is_some(),
        has_video: vs.is_some(),
    })
}

fn need_probe(bin: &FfmpegBin) -> Result<PathBuf, IpcError> {
    bin.ffprobe.clone().ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "ffprobe를 찾을 수 없습니다 — ffmpeg와 같은 폴더에 있어야 합니다",
        )
    })
}

/// ffprobe 1회 → VideoMeta. video_probe·필름스트립(길이를 알아야 fps를 정한다)과
/// HLS 폴백(hls.rs — 조각 수를 정하려면 길이가, 인코딩 인자를 정하려면 크기·fps가 필요하다)이 공유한다.
pub(crate) async fn probe_meta(probe: &Path, src: &str) -> Result<VideoMeta, IpcError> {
    let (code, stdout, stderr) = run_capture(
        probe,
        &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", src],
        15,
    )
    .await?;
    if code != 0 {
        return Err(IpcError {
            code: ErrorCode::Io,
            message: "미디어 정보를 읽지 못했습니다 (손상되었거나 지원하지 않는 형식)".into(),
            stderr: Some(stderr),
        });
    }
    parse_probe(&stdout)
}

/// 레포 안 미디어 원본 해석 — 존재 확인까지. 프로브·필름스트립·파형이 공유한다.
fn resolve_media(
    state: &State<'_, AppState>,
    project_id: &str,
    rel_path: &str,
) -> Result<String, IpcError> {
    let repo = project_path(state, project_id)?;
    let src = super::tree::resolve_in_repo(&repo, rel_path)?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"));
    }
    Ok(src.display().to_string())
}

#[tauri::command]
pub async fn video_probe(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<VideoMeta, IpcError> {
    let bin = find_ffmpeg(&app, state.inner())?;
    let probe = need_probe(&bin)?;
    let src = resolve_media(&state, &project_id, &rel_path)?;
    probe_meta(&probe, &src).await
}

// ══════════════════════════ 내보내기 스펙 → ffmpeg 인자 ══════════════════════════

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeMs {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub src_rel: String,
    pub out_rel: String,
    pub overwrite: bool,
    pub range: Option<RangeMs>,
    /// "copy"(무손실 스트림 카피 — 키프레임 스냅) | "encode"(재인코딩).
    pub mode: String,
    pub speed: Option<f64>,
    pub crop: Option<CropRect>,
    pub crf: Option<u8>,
    pub max_height: Option<u32>,
    pub remove_audio: bool,
    /// 가릴 영역들 — **원본 프레임 좌표계**(crop과 동일 기준). crop/scale **이전**에 적용된다.
    /// 비었거나 없으면 마스킹 없음. copy 모드와는 양립 불가(validate_spec이 막는다).
    #[serde(default)]
    pub masks: Option<Vec<CropRect>>,
    /// "mosaic"(픽셀화) | "blur"(박스 블러). masks가 없으면 무시. 기본 mosaic.
    #[serde(default)]
    pub mask_kind: Option<String>,
    /// 진행률 분모 — 프론트가 probe에서 넘긴다(백엔드 재프로브 생략).
    pub duration_ms: u64,
    pub has_audio: bool,
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// 확장자 → 명시 muxer. 임시파일(.tmp)에 쓰므로 ffmpeg의 확장자 추론에 기댈 수 없다.
fn muxer_for_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "m4v" => "mp4",
        "mov" => "mov",
        "gif" => "gif",
        "m4a" => "ipod",
        "mp3" => "mp3",
        _ => return None,
    })
}

/// ms → ffmpeg 초 표기 ("12.345").
fn fmt_secs(ms: u64) -> String {
    format!("{}.{:03}", ms / 1000, ms % 1000)
}

/// yuv420p+libx264는 홀수 크기에서 실패한다 — x/y/w/h 전부 짝수로 내림(크로마 정렬).
fn evenize(c: &CropRect) -> (u32, u32, u32, u32) {
    let e = |v: u32| v & !1;
    (e(c.x), e(c.y), e(c.w).max(2), e(c.h).max(2))
}

/// 마스크 그래프 — `(그래프, 출력라벨)`. 마스크가 없으면 None.
///
/// `-vf`(선형 체인)로는 표현할 수 없다: 원본을 split해서 한 갈래만 흐리고 다시 overlay로
/// 합쳐야 하므로 세미콜론 그래프(=filter_complex)가 필요하다. 그래서 마스크가 있으면
/// 일반 mp4 경로도 `-vf` 대신 filter_complex + 명시적 `-map`으로 넘어간다.
///
/// 좌표는 원본 프레임 기준이라 **crop/scale보다 먼저** 걸려야 한다 — 순서가 뒤집히면
/// crop된 프레임에 원본 좌표를 적용해 엉뚱한 데를 가린다.
fn build_mask_graph(spec: &ExportSpec) -> Option<(String, String)> {
    let masks = spec.masks.as_ref()?;
    if masks.is_empty() {
        return None;
    }
    let mosaic = spec.mask_kind.as_deref() != Some("blur");
    let n = masks.len();
    let mut parts: Vec<String> = Vec::new();
    // split은 원본 1갈래(배경) + 마스크당 1갈래.
    let srcs: String = (0..n).map(|i| format!("[s{i}]")).collect();
    parts.push(format!("[0:v]split={}[bg]{srcs}", n + 1));

    let mut base = "[bg]".to_string();
    for (i, m) in masks.iter().enumerate() {
        let (x, y, w, h) = evenize(m);
        let effect = if mosaic {
            // 짧은 변 기준 ~16블록. 다운스케일 후 neighbor 업스케일 = 픽셀화.
            let bw = (w / 16).max(1);
            let bh = (h / 16).max(1);
            format!("scale={bw}:{bh}:flags=neighbor,scale={w}:{h}:flags=neighbor")
        } else {
            // boxblur 반경은 영역보다 작아야 한다 — 짧은 변의 1/8, 최소 2.
            let r = (w.min(h) / 8).max(2);
            format!("boxblur={r}:2")
        };
        parts.push(format!("[s{i}]crop={w}:{h}:{x}:{y},{effect}[e{i}]"));
        parts.push(format!("{base}[e{i}]overlay={x}:{y}[o{i}]"));
        base = format!("[o{i}]");
    }
    Some((parts.join(";"), base))
}

/// atempo는 필터 하나당 0.5~2.0 범위만 안전하다 — 범위 밖은 체인으로 분해.
fn atempo_chain(speed: f64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut s = speed;
    while s > 2.0 {
        parts.push("atempo=2.0".into());
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push("atempo=0.5".into());
        s /= 0.5;
    }
    parts.push(format!("atempo={s}"));
    parts.join(",")
}

fn validate_spec(spec: &ExportSpec) -> Result<(), IpcError> {
    let bad = |m: &str| Err(IpcError::new(ErrorCode::Io, format!("내보내기 스펙 오류: {m}")));
    let ext = ext_of(&spec.out_rel);
    if muxer_for_ext(&ext).is_none() {
        return bad(&format!("지원하지 않는 출력 형식 .{ext}"));
    }
    if let Some(r) = &spec.range {
        if r.start_ms >= r.end_ms {
            return bad("구간 시작이 끝보다 늦습니다");
        }
    }
    if let Some(s) = spec.speed {
        if !(0.25..=4.0).contains(&s) {
            return bad("배속은 0.25~4배만 지원합니다");
        }
    }
    if let Some(c) = spec.crf {
        if c > 51 {
            return bad("CRF 범위(0~51) 초과");
        }
    }
    match spec.mode.as_str() {
        "copy" => {
            // 스트림 카피와 양립 불가한 옵션 — 프론트가 자동 전환하지만 백엔드도 방어한다.
            if spec.speed.is_some_and(|s| (s - 1.0).abs() > f64::EPSILON)
                || spec.crop.is_some()
                || spec.crf.is_some()
                || spec.max_height.is_some()
                || spec.masks.as_ref().is_some_and(|m| !m.is_empty())
                || ext == "gif"
            {
                return bad(
                    "무손실 복사는 배속·크롭·모자이크·화질·GIF와 함께 쓸 수 없습니다 (재인코딩 필요)",
                );
            }
        }
        "encode" => {}
        _ => return bad("mode는 copy|encode"),
    }
    Ok(())
}

/// 순수 인자 생성기 — 유닛테스트 대상. src/tmp_out은 절대경로 문자열.
fn build_export_args(src: &str, tmp_out: &str, spec: &ExportSpec) -> Vec<String> {
    let ext = ext_of(&spec.out_rel);
    let muxer = muxer_for_ext(&ext).unwrap_or("mp4");
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1"]
        .map(String::from)
        .to_vec();

    // -ss는 -i **앞**(입력 시킹 — 키프레임 고속 점프), 길이는 -t(지속시간).
    // ⚠ -to를 쓰면 안 된다: 입력 시킹 후 -to는 출력 타임스탬프 기준이라 구간이 어긋난다.
    if let Some(r) = &spec.range {
        a.extend(["-ss".into(), fmt_secs(r.start_ms), "-t".into(), fmt_secs(r.end_ms - r.start_ms)]);
    }
    a.extend(["-i".into(), src.to_string()]);

    let audio_only = matches!(ext.as_str(), "m4a" | "mp3");
    let speed = spec.speed.unwrap_or(1.0);
    let speeding = (speed - 1.0).abs() > f64::EPSILON;

    if spec.mode == "copy" {
        if audio_only {
            a.extend(["-vn".into(), "-c:a".into(), "copy".into()]);
        } else {
            a.extend(["-c".into(), "copy".into()]);
            if spec.remove_audio {
                a.push("-an".into());
            }
        }
        a.extend(["-avoid_negative_ts".into(), "make_zero".into()]);
    } else {
        // 마스크(있으면)가 맨 앞 — 원본 좌표계라 crop보다 먼저 걸려야 한다.
        let mask = build_mask_graph(spec);
        let vin = mask.as_ref().map(|(_, l)| l.as_str()).unwrap_or("[0:v]");
        let mprefix = mask.as_ref().map(|(g, _)| format!("{g};")).unwrap_or_default();

        // 비디오 필터 체인: crop → scale → setpts (→ gif면 fps/scale/palette).
        let mut vf: Vec<String> = Vec::new();
        if let Some(c) = &spec.crop {
            let (x, y, w, h) = evenize(c);
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
        if let Some(mh) = spec.max_height {
            // min(mh, ih) — 업스케일 방지. 필터 인자 안 콤마는 이스케이프.
            vf.push(format!("scale=-2:min({mh}\\,ih)"));
        }
        if speeding {
            vf.push(format!("setpts=PTS/{speed}"));
        }

        if ext == "gif" {
            vf.push("fps=12".into());
            vf.push("scale=min(480\\,iw):-2:flags=lanczos".into());
            // 팔레트 1패스(split) — 임시 팔레트 파일 없음. -vf는 세미콜론 그래프 불가라 filter_complex.
            a.extend([
                "-filter_complex".into(),
                format!(
                    "{mprefix}{vin}{},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
                    vf.join(",")
                ),
                "-an".into(),
            ]);
        } else if audio_only {
            // 코덱은 출력 확장자를 따라간다 — mp3 muxer는 AAC를 못 담아 `-c:a aac -f mp3`가
            // 100% 실패한다(사용자가 파일명을 .mp3로 고쳐 쓰는 경로가 실재).
            let ac = if ext == "mp3" { "libmp3lame" } else { "aac" };
            a.extend(["-vn".into(), "-c:a".into(), ac.into(), "-b:a".into(), "192k".into()]);
            if speeding {
                a.extend(["-af".into(), atempo_chain(speed)]);
            }
        } else {
            if mask.is_some() {
                // filter_complex를 쓰면 자동 스트림 선택이 꺼진다 — 오디오도 명시로 매핑한다.
                let chain = if vf.is_empty() { "null".to_string() } else { vf.join(",") };
                a.extend([
                    "-filter_complex".into(),
                    format!("{mprefix}{vin}{chain}[v]"),
                    "-map".into(),
                    "[v]".into(),
                ]);
                if spec.has_audio && !spec.remove_audio {
                    a.extend(["-map".into(), "0:a?".into()]);
                }
            } else if !vf.is_empty() {
                a.extend(["-vf".into(), vf.join(",")]);
            }
            a.extend([
                "-c:v".into(), "libx264".into(),
                "-crf".into(), spec.crf.unwrap_or(23).to_string(),
                "-preset".into(), "veryfast".into(),
                "-pix_fmt".into(), "yuv420p".into(),
            ]);
            if spec.has_audio && !spec.remove_audio {
                a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
                if speeding {
                    a.extend(["-af".into(), atempo_chain(speed)]);
                }
            } else {
                a.push("-an".into());
            }
        }
    }

    if muxer == "mp4" || muxer == "mov" {
        // 스트리밍 재생 가능한 moov 선두 배치 — 웹뷰·브라우저에 바로 물릴 수 있게.
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.extend(["-f".into(), muxer.into(), tmp_out.to_string()]);
    a
}

/// 예상 출력 길이(µs) — 진행률 분모. 배속 재인코딩은 출력이 D/speed로 줄어든다.
fn expected_out_us(spec: &ExportSpec) -> u64 {
    let base_ms = spec
        .range
        .as_ref()
        .map(|r| r.end_ms.saturating_sub(r.start_ms))
        .unwrap_or(spec.duration_ms);
    let speed = if spec.mode == "encode" { spec.speed.unwrap_or(1.0) } else { 1.0 };
    ((base_ms as f64) * 1000.0 / speed.max(0.01)) as u64
}

/// `-progress pipe:1` 라인 파싱. ffmpeg의 out_time_ms는 이름과 달리 **µs**다(알려진 버그,
/// out_time_us와 항상 같은 값) — 둘 다 µs로 읽는다.
fn parse_out_time_us(line: &str) -> Option<u64> {
    line.strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?
        .trim()
        .parse()
        .ok()
}

// ══════════════════════════ 내보내기 실행 ══════════════════════════

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    job_id: String,
    project_id: String,
    percent: f64,
    out_time_ms: u64,
    speed: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportFinished {
    job_id: String,
    project_id: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
    out_rel: String,
}

/// Windows 제어된 폴더 액세스(랜섬웨어 방지) 안내.
///
/// ffmpeg는 OS가 파일 생성을 막아도 그냥 "Error opening output files: No such file or directory"
/// 라고만 말한다. 기본 보호 폴더가 문서·사진·**비디오**·바탕 화면이라 거기 있는 영상을 편집해
/// 저장하면 통째로 실패하는데, 원인은 앱 어디에도 안 남고 Defender 이벤트 로그(1123)에만 있다.
/// 2026-09-03에 `%userprofile%\Videos\...` 영상의 모자이크 내보내기가 정확히 이걸로 죽었다.
/// 허용 목록은 **exe 단위**라 ffmpeg.exe와 앱 exe를 각각 등록해야 하고, dev 빌드와 설치본도 별개다.
/// (tree.rs write_io_err가 파일 저장 경로에 대해 같은 안내를 한다.)
#[cfg(windows)]
fn cfa_hint(line: &str, out: &Path) -> String {
    let looks_blocked = line.contains("Error opening output")
        || line.contains("Permission denied")
        || line.contains("Operation not permitted");
    if !looks_blocked {
        return String::new();
    }
    let protected = ["Videos", "Documents", "Pictures", "Desktop", "Music"];
    let in_protected = std::env::var("USERPROFILE").ok().is_some_and(|home| {
        let home = Path::new(&home);
        protected.iter().any(|d| out.starts_with(home.join(d)))
    });
    if !in_protected {
        return String::new();
    }
    " — 저장 폴더가 Windows '제어된 폴더 액세스' 보호 대상입니다. Windows 보안 › 바이러스 및 위협 방지 › 랜섬웨어 방지 › 폴더 액세스 제어에서 ffmpeg.exe와 이 앱을 허용 목록에 추가하거나, 다른 폴더에 저장하세요."
        .into()
}

#[cfg(not(windows))]
fn cfa_hint(_line: &str, _out: &Path) -> String {
    String::new()
}

/// stderr에서 사람이 읽을 마지막 오류 줄을 뽑는다.
fn last_error_line(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("(상세 메시지 없음)")
        .to_string()
}

/// 종결 이벤트는 **모든** 결과에 대해 여기 한 곳에서 emit한다 — 검증·발견·스폰 실패까지.
/// 예외는 AlreadyExists 하나(프론트가 덮어쓰기 확인 다이얼로그로 처리하는 대화형 경로라
/// "실패" 토스트가 뜨면 안 된다). 프론트는 이 계약 덕에 메시지 문자열을 보고 토스트를
/// 걸러내는 짓을 하지 않아도 된다.
#[tauri::command]
pub async fn video_export(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    job_id: String,
    spec: ExportSpec,
) -> Result<(), IpcError> {
    let outcome = video_export_inner(&app, &state, &project_id, &job_id, &spec).await;
    let interactive = matches!(&outcome, Err(e) if e.code == ErrorCode::AlreadyExists);
    if !interactive {
        let cancelled = matches!(&outcome, Err(e) if e.code == ErrorCode::Cancelled);
        let _ = app.emit(
            "video://export-finished",
            ExportFinished {
                job_id,
                project_id,
                ok: outcome.is_ok(),
                cancelled,
                error: outcome.as_ref().err().map(|e| e.message.clone()),
                out_rel: spec.out_rel.clone(),
            },
        );
    }
    outcome
}

async fn video_export_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    project_id: &str,
    job_id: &str,
    spec: &ExportSpec,
) -> Result<(), IpcError> {
    validate_spec(spec)?;
    let repo = project_path(state, project_id)?;
    let bin = find_ffmpeg(app, state.inner())?;
    let src = super::tree::resolve_in_repo(&repo, &spec.src_rel)?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, "원본 파일을 찾을 수 없습니다"));
    }
    let out = super::tree::resolve_in_repo(&repo, &spec.out_rel)?;
    // 자기 자신 덮어쓰기 방지 — 바이트 비교만으로는 부족하다: NTFS/APFS는 대소문자
    // 무시라 "Clip.mp4"→"clip.mp4"가 다른 PathBuf지만 같은 파일이고, 통과시키면
    // 아래 성공 경로의 remove_file(&out)이 **원본을 지운다**. 존재하는 out은 정규화 비교.
    if out == src
        || (out.exists()
            && dunce::canonicalize(&out).ok().is_some_and(|o| Some(o) == dunce::canonicalize(&src).ok()))
    {
        return Err(IpcError::new(ErrorCode::Io, "원본과 같은 파일로 내보낼 수 없습니다"));
    }
    if out.exists() && !spec.overwrite {
        return Err(IpcError::new(
            ErrorCode::AlreadyExists,
            format!("{} 파일이 이미 있습니다", spec.out_rel),
        ));
    }

    // 산출물은 임시 이름으로 쓰고 성공 시 rename — 실패·취소가 기존 파일을 파괴하지 않게.
    let tmp = out.with_file_name(format!(".gpv-export-{job_id}.tmp"));
    let args = build_export_args(&src.display().to_string(), &tmp.display().to_string(), spec);

    // 취소 등록은 spawn **전** — invoke 응답이 유실돼도 이미 등록된 id로 취소 가능(http.rs 정책).
    let jobs = {
        let reg = state.video.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(&reg.jobs)
    };
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut map = jobs.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(job_id.to_string(), VideoJob { cancel: Some(cancel_tx), pid: None });
    }
    let _guard = JobGuard { jobs: Arc::clone(&jobs), job_id: job_id.to_string() };

    let mut cmd = Command::new(&bin.ffmpeg);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("ffmpeg 실행 실패: {e}")))?;
    if let Some(pid) = child.id() {
        let mut map = jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(j) = map.get_mut(job_id) {
            j.pid = Some(pid);
        }
    }

    // 진행률 리더(stdout `-progress pipe:1`) — % 정수 변화 시에만 emit(초당 수 회 수준).
    let stdout = child.stdout.take();
    let expected_us = expected_out_us(spec);
    let (p_app, p_job, p_proj) = (app.clone(), job_id.to_string(), project_id.to_string());
    let progress_task = tauri::async_runtime::spawn(async move {
        let Some(stdout) = stdout else { return };
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut last_pct: i64 = -1;
        let mut speed: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(s) = line.strip_prefix("speed=") {
                speed = Some(s.trim().to_string());
            } else if let Some(us) = parse_out_time_us(&line) {
                let pct = if expected_us > 0 {
                    ((us as f64) / (expected_us as f64) * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };
                if pct as i64 != last_pct {
                    last_pct = pct as i64;
                    let _ = p_app.emit(
                        "video://export-progress",
                        ExportProgress {
                            job_id: p_job.clone(),
                            project_id: p_proj.clone(),
                            percent: pct,
                            out_time_ms: us / 1000,
                            speed: speed.clone(),
                        },
                    );
                }
            }
        }
    });

    // stderr 수집(오류 진단용) — 마지막 8KB만 유지.
    let stderr = child.stderr.take();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let Some(stderr) = stderr else { return String::new() };
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = tokio::io::BufReader::new(stderr).read_to_end(&mut buf).await;
        let start = buf.len().saturating_sub(8 * 1024);
        String::from_utf8_lossy(&buf[start..]).into_owned()
    });

    let mut cancelled = false;
    // ?를 쓰지 않는다 — wait 실패 경로에서도 임시파일 정리가 돌아야 한다.
    let status_res: Result<std::process::ExitStatus, IpcError> = tokio::select! {
        s = child.wait() => {
            s.map_err(|e| IpcError::new(ErrorCode::Io, format!("ffmpeg 종료 대기 실패: {e}")))
        }
        _ = &mut cancel_rx => {
            cancelled = true;
            let _ = child.start_kill();
            child.wait().await
                .map_err(|e| IpcError::new(ErrorCode::Io, format!("ffmpeg 종료 대기 실패: {e}")))
        }
    };
    let stderr_tail = stderr_task.await.unwrap_or_default();
    let _ = progress_task.await;
    let status = match status_res {
        Ok(s) => s,
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            return Err(e);
        }
    };

    if cancelled {
        std::fs::remove_file(&tmp).ok();
        Err(IpcError::new(ErrorCode::Cancelled, "내보내기가 취소되었습니다"))
    } else if status.success() {
        // Windows rename은 기존 파일을 덮지 못한다 — overwrite 확정 상태이므로 먼저 지운다.
        let replace = || -> Result<(), IpcError> {
            if out.exists() {
                std::fs::remove_file(&out)
                    .map_err(|e| IpcError::new(ErrorCode::Io, format!("기존 파일 교체 실패: {e}")))?;
            }
            std::fs::rename(&tmp, &out)
                .map_err(|e| IpcError::new(ErrorCode::Io, format!("산출물 이동 실패: {e}")))
        };
        let r = replace();
        if r.is_err() {
            std::fs::remove_file(&tmp).ok();
        }
        r
    } else {
        std::fs::remove_file(&tmp).ok();
        // 실패한 명령을 남긴다 — 토스트는 stderr 마지막 한 줄뿐이라(예: "Error opening output
        // files: No such file or directory") 어떤 인자로 죽었는지 사후에 알 길이 없었다.
        // 필터 그래프가 길어질수록(마스크/GIF 팔레트) 이게 유일한 단서다.
        log::error!(
            "[video] 내보내기 실패 job={job_id}
  ffmpeg: {}
  args: {:?}
  stderr(tail):
{}",
            bin.ffmpeg.display(),
            args,
            stderr_tail
        );
        let line = last_error_line(&stderr_tail);
        Err(IpcError {
            code: ErrorCode::Io,
            message: format!("ffmpeg 실패: {}{}", line, cfa_hint(&line, &out)),
            stderr: Some(stderr_tail),
        })
    }
}

/// 멱등 취소 — 모르는 id는 no-op(http_cancel과 동형).
#[tauri::command]
pub fn video_export_cancel(state: State<'_, AppState>, job_id: String) -> Result<(), IpcError> {
    let jobs = {
        let reg = state.video.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(&reg.jobs)
    };
    let job = {
        let mut map = jobs.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&job_id)
    };
    // 락 밖에서 신호 — kill을 락 안에서 하지 않는다(terminal.rs 교훈).
    if let Some(mut job) = job {
        if let Some(tx) = job.cancel.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

// ══════════════════════════ 프레임 캡처 ══════════════════════════

/// ffprobe `-show_entries format=start_time -of json` → 초. 없거나 N/A면 0.
fn parse_start_time(json: &str) -> f64 {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v["format"]["start_time"].as_str()?.parse::<f64>().ok())
        .filter(|s| s.is_finite())
        .unwrap_or(0.0)
}

/// ffprobe `-show_entries packet=pts_time -of json` → pts(초) 목록. N/A 패킷은 버린다.
fn parse_packet_pts(json: &str) -> Vec<f64> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    v["packets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p["pts_time"].as_str()?.parse::<f64>().ok())
                .filter(|t| t.is_finite())
                .collect()
        })
        .unwrap_or_default()
}

/// 웹뷰가 그리는 프레임 = pts ≤ 재생 시각인 **마지막** 프레임. 비교는 µs 단위로 엄격하다 —
/// Chromium은 시각을 µs로 자르고 프레임 pts는 µs로 반올림해 비교하므로, "." 두 번(2/30초)은
/// 0.066666 이 되어 pts 0.066667 인 프레임 2가 아니라 프레임 1을 그린다(실측). ffprobe의 pts_time도
/// µs 반올림이라 같은 기준이다. 0.5µs 여유는 ms→초 왕복의 부동소수 잡음 몫일 뿐이다.
fn pick_displayed_pts(pts: &[f64], at_abs: f64) -> Option<f64> {
    pts.iter().copied().filter(|&p| p <= at_abs + 0.000_000_5).reduce(f64::max)
}

/// 캡처용 입력 시크(초, 파일 시작 기준).
///
/// ffmpeg 입력 `-ss`는 pts ≥ ss 인 **첫** 프레임을 내는데 웹뷰는 pts ≤ currentTime 인 **마지막**
/// 프레임을 그린다. 재생 시각을 그대로 넘기면 멈춘 위치가 두 프레임 사이일 때(= 거의 항상) 저장본이
/// 화면보다 1~2프레임 뒤였고, 영상 끝(currentTime = duration)에서는 ss 뒤에 프레임이 없어 ffmpeg가
/// 아무것도 안 쓰고 exit 0 했다. 그래서 at 부근 패킷 pts를 읽어 화면 프레임을 고르고 그 pts
/// **0.5ms 앞**으로 시크한다 — pts ≥ ss 인 첫 프레임이 곧 그 프레임이다.
///
/// 패킷만 읽고 디코드하지 않아 싸다. read_intervals 시작은 그 앞 키프레임으로 시크되므로 "at 이하
/// 마지막 프레임"이 반드시 포함되고, 끝을 1초 더 읽는 것은 B프레임 재정렬로 뒤에 오는 패킷 몫이다.
/// ffprobe가 없으면 예전처럼 재생 시각 그대로, at 이하 pts를 못 읽으면 start만 맞춰 시크한다.
///
/// **시각의 기준이 재생 경로마다 다르다.** 원본을 직접 재생하면 Chromium의 currentTime은 컨테이너
/// pts 그대로다(ffmpeg_demuxer가 비디오 타임스탬프를 start_time만큼 옮기지 않는다 — Chrome 실측:
/// start 1.5초 webm은 로드 직후 currentTime 1.5에 첫 프레임). 코덱 폴백(hls.rs)은 `-output_ts_offset`
/// 으로 **start 기준 상대** 시각을 만든다. ffprobe pts는 절대, ffmpeg -ss는 start 기준 상대라서
/// 둘 사이를 start로 옮긴다. start가 0인 대부분의 파일은 어느 쪽이든 같지만, Opus webm(-0.007)·
/// edit list 없는 B프레임 mp4(+0.067)·방송 녹화 ts(+1.4)는 이 구분이 없으면 프레임이 밀린다.
async fn frame_seek_secs(probe: Option<&Path>, src: &str, at_secs: f64, relative: bool) -> f64 {
    let Some(probe) = probe else { return at_secs };
    let start = match run_capture(
        probe,
        &["-v", "error", "-show_entries", "format=start_time", "-of", "json", src],
        5,
    )
    .await
    {
        Ok((0, out, _)) => parse_start_time(&out),
        _ => return at_secs,
    };
    let at_abs = if relative { start + at_secs } else { at_secs };
    // start 를 안 뒤의 폴백은 **start 기준으로 옮긴** 재생 시각이다(-ss 는 start 기준 상대).
    // at 이 키프레임 pts 바로 아래(µs 로 잘린 "." 스텝)면 read_intervals 가 그 키프레임으로 반올림
    // 시크해 at 이하 패킷이 없는데, 그때 웹뷰도 그 키프레임을 그리므로 pts ≥ ss 첫 프레임이 맞다.
    let fallback = (at_abs - start).max(0.0);
    let interval = format!("{:.6}%{:.6}", at_abs, at_abs + 1.0);
    let pts = match run_capture(
        probe,
        &[
            // V(대문자) = 커버 아트·썸네일(attached pic)을 뺀 영상 스트림. v:0 이면 썸네일을 품은
            // mp4(yt-dlp --embed-thumbnail 등)에서 pts 0 짜리 그림 한 장을 골라 늘 첫 프레임이 된다.
            "-v", "error", "-select_streams", "V:0", "-read_intervals", &interval,
            "-show_entries", "packet=pts_time", "-of", "json", src,
        ],
        5,
    )
    .await
    {
        Ok((0, out, _)) => parse_packet_pts(&out),
        _ => return fallback,
    };
    match pick_displayed_pts(&pts, at_abs) {
        Some(p) => (p - start - 0.000_5).max(0.0),
        None => fallback,
    }
}

#[tauri::command]
pub async fn video_capture_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    // 소수 ms 그대로 받는다 — ms로 반올림하면 프레임 경계를 넘어가는 경우가 있었다.
    at_ms: f64,
    out_rel: String,
    overwrite: bool,
    // at_ms가 코덱 폴백(HLS) 재생의 시각인가 — frame_seek_secs의 "시각의 기준" 참고.
    hls: Option<bool>,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let bin = find_ffmpeg(&app, state.inner())?;
    let src = super::tree::resolve_in_repo(&repo, &rel_path)?;
    let out = super::tree::resolve_in_repo(&repo, &out_rel)?;
    if out.exists() && !overwrite {
        return Err(IpcError::new(
            ErrorCode::AlreadyExists,
            format!("{out_rel} 파일이 이미 있습니다"),
        ));
    }
    let tmp = out.with_file_name(format!(".gpv-frame-{}.tmp", uuid::Uuid::new_v4().simple()));
    let (src_s, tmp_s) = (src.display().to_string(), tmp.display().to_string());
    let at_secs = if at_ms.is_finite() { at_ms.max(0.0) / 1000.0 } else { 0.0 };
    let relative = hls.unwrap_or(false);
    let seek = format!("{:.6}", frame_seek_secs(bin.ffprobe.as_deref(), &src_s, at_secs, relative).await);
    // -c:v png 명시 — 임시 이름(.tmp)이라 image2 muxer가 확장자로 인코더를 못 고른다.
    let args = [
        "-hide_banner", "-nostdin", "-y",
        "-ss", &seek, "-i", &src_s,
        "-frames:v", "1", "-update", "1", "-c:v", "png", "-f", "image2", &tmp_s,
    ];
    // ?를 쓰지 않는다 — 타임아웃 경로에서도 레포 안 임시파일을 지워야 한다.
    let (code, _, stderr) = match run_capture(&bin.ffmpeg, &args, 60).await {
        Ok(v) => v,
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            return Err(e);
        }
    };
    if code != 0 {
        std::fs::remove_file(&tmp).ok();
        return Err(IpcError {
            code: ErrorCode::Io,
            message: format!("프레임 캡처 실패: {}", last_error_line(&stderr)),
            stderr: Some(stderr),
        });
    }
    // ss 뒤에 프레임이 없으면 ffmpeg는 아무것도 안 쓰고도 exit 0 이다("Output file is empty").
    // 그대로 rename 하면 "산출물 이동 실패(os error 2)"라는 엉뚱한 말이 나갔다.
    if !tmp.is_file() {
        return Err(IpcError {
            code: ErrorCode::Io,
            message: "이 위치에서 저장할 프레임을 찾지 못했습니다 — 한 프레임 앞으로 옮긴 뒤 다시 시도하세요".into(),
            stderr: Some(stderr),
        });
    }
    if out.exists() {
        std::fs::remove_file(&out)
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("기존 파일 교체 실패: {e}")))?;
    }
    std::fs::rename(&tmp, &out)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("산출물 이동 실패: {e}")))
}

// ══════════════════════════ 타임라인 필름스트립·파형 ══════════════════════════

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFilmstrip {
    /// `data:image/jpeg;base64,…` — 폭 cols*tile_w, 높이 tile_h.
    pub data_uri: String,
    pub cols: u32,
    pub tile_w: u32,
    pub tile_h: u32,
}

/// 필름스트립 인자 — ffmpeg **한 번**에 스프라이트 **한 장**. tile 필터가 N프레임을 가로로
/// 이어 붙이므로 N번 스폰·N번 JPEG 헤더·N번 IPC가 통째로 사라진다.
///
/// `fps=cols/duration`이 구간을 정확히 cols등분한다(0, D/N, …, (N-1)D/N에서 샘플).
///
/// 출력은 **파이프**다. 임시파일 경로는 두 가지가 걸린다: ① Windows '제어된 폴더 액세스'가
/// 비디오·문서 폴더 쓰기를 조용히 막고(cfa_hint 참고 — 실제로 내보내기가 이걸로 죽었다)
/// ② 타임아웃·취소·실패마다 정리 코드가 붙는다. 파이프는 둘 다 없다.
/// `image2`는 파일명 패턴 muxer라 파이프에는 `image2pipe`를 쓴다.
fn build_filmstrip_args(src: &str, cols: u32, height: u32, duration_ms: u64) -> Vec<String> {
    let fps = cols as f64 / (duration_ms.max(1) as f64 / 1000.0);
    vec![
        "-hide_banner".into(), "-nostdin".into(), "-v".into(), "error".into(),
        "-i".into(), src.into(),
        "-vf".into(), format!("fps={fps:.6},scale=-2:{height},tile={cols}x1"),
        "-frames:v".into(), "1".into(),
        "-an".into(), "-sn".into(),
        "-c:v".into(), "mjpeg".into(), "-q:v".into(), "4".into(),
        "-f".into(), "image2pipe".into(), "pipe:1".into(),
    ]
}

/// JPEG SOF 마커에서 **실제** 픽셀 크기. scale=-2의 반올림 규칙을 여기서 재구현해 추정하면
/// 1~2px 오차가 셀마다 누적돼 프론트 background-position이 끝에서 크게 어긋난다.
fn jpeg_size(buf: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2; // SOI 다음부터. SOF는 SOS보다 앞이라 길이 없는 마커를 만날 일이 없다.
    while i + 9 < buf.len() {
        if buf[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = buf[i + 1];
        // 0xC0~0xCF 중 C4(DHT)·C8(JPG)·CC(DAC)는 프레임 헤더가 아니다 — 크기가 안 들어 있다.
        if (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC) {
            let h = u16::from_be_bytes([buf[i + 5], buf[i + 6]]) as u32;
            let w = u16::from_be_bytes([buf[i + 7], buf[i + 8]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        let len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

#[tauri::command]
pub async fn video_filmstrip(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    cols: u32,
    height: u32,
) -> Result<VideoFilmstrip, IpcError> {
    // 프레임 수·타일 높이는 곧 디코딩 비용이자 data URI 크기다 — 프론트 계산 사고(cols=100000)가
    // 앱을 통째로 멈추게 두지 않는다(validate_spec과 같은 방어선).
    if !(1..=240).contains(&cols) || !(8..=240).contains(&height) {
        return Err(IpcError::new(
            ErrorCode::Io,
            "필름스트립 인자 범위를 벗어났습니다 (cols 1~240, height 8~240)",
        ));
    }
    let bin = find_ffmpeg(&app, state.inner())?;
    let probe = need_probe(&bin)?;
    let src = resolve_media(&state, &project_id, &rel_path)?;
    let meta = probe_meta(&probe, &src).await?;
    if !meta.has_video || meta.duration_ms == 0 {
        return Err(IpcError::new(
            ErrorCode::Io,
            "영상 스트림이 없거나 길이를 알 수 없어 필름스트립을 만들 수 없습니다",
        ));
    }
    let args = build_filmstrip_args(&src, cols, height, meta.duration_ms);
    let (code, jpeg, stderr) = run_capture_bytes(&bin.ffmpeg, &args, 120).await?;
    if code != 0 || jpeg.is_empty() {
        return Err(IpcError {
            code: ErrorCode::Io,
            message: format!("필름스트립 생성 실패: {}", last_error_line(&stderr)),
            stderr: Some(stderr),
        });
    }
    let (w, h) = jpeg_size(&jpeg)
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "필름스트립 이미지를 해석하지 못했습니다"))?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
    Ok(VideoFilmstrip {
        data_uri: format!("data:image/jpeg;base64,{b64}"),
        cols,
        // 마지막 열이 검게 채워졌더라도 스프라이트 폭은 cols*tile_w로 고정이다.
        tile_w: (w / cols).max(1),
        tile_h: h,
    })
}

/// 파형용 오디오 디코드 인자 — 8kHz 모노 s16le 원시 PCM을 파이프로. 8kHz면 1시간짜리도
/// 57MB라 메모리에 들고 줄일 수 있고, 피크 포락선에는 그 이상 필요 없다.
fn build_waveform_args(src: &str) -> Vec<String> {
    vec![
        "-hide_banner".into(), "-nostdin".into(), "-v".into(), "error".into(),
        "-i".into(), src.into(),
        "-vn".into(), "-f".into(), "s16le".into(), "-ac".into(), "1".into(), "-ar".into(), "8000".into(),
        "pipe:1".into(),
    ]
}

/// s16le 모노 PCM → buckets개 피크(각 0..1). 최대 피크로 정규화해 조용한 소스도 보이게 한다.
fn reduce_peaks(pcm: &[u8], buckets: usize) -> Vec<f32> {
    let n = pcm.len() / 2;
    if n == 0 || buckets == 0 {
        return Vec::new();
    }
    let mut peaks = vec![0f32; buckets];
    for (i, s) in pcm.chunks_exact(2).enumerate() {
        // 샘플 수가 buckets보다 적어도(아주 짧은 파일) 0으로 나누지 않는다 — 비율로 배치한다.
        let b = (i * buckets / n).min(buckets - 1);
        let v = i16::from_le_bytes([s[0], s[1]]).unsigned_abs() as f32;
        if v > peaks[b] {
            peaks[b] = v;
        }
    }
    let max = peaks.iter().copied().fold(0f32, f32::max);
    if max > 0.0 {
        for p in &mut peaks {
            *p /= max;
        }
    }
    peaks
}

#[tauri::command]
pub async fn video_waveform(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    buckets: u32,
) -> Result<Vec<f32>, IpcError> {
    if !(1..=4096).contains(&buckets) {
        return Err(IpcError::new(ErrorCode::Io, "파형 버킷 수 범위를 벗어났습니다 (1~4096)"));
    }
    let bin = find_ffmpeg(&app, state.inner())?;
    let src = resolve_media(&state, &project_id, &rel_path)?;
    let args = build_waveform_args(&src);
    let (code, pcm, stderr) = run_capture_bytes(&bin.ffmpeg, &args, 120).await?;
    // 오디오가 없는 영상은 ffmpeg가 "Output file does not contain any stream"으로 죽는다.
    // 그건 **정상 파일의 정상 결과**지 오류가 아니다 — Err로 올리면 무음 영상을 열 때마다
    // 실패 토스트가 뜬다. 빈 벡터가 프론트의 "파형 없음" 계약이다(ipc.ts).
    if pcm.len() < 2 {
        if code != 0 {
            log::debug!("[video] 파형: 오디오 없음 또는 디코드 실패 — {}", last_error_line(&stderr));
        }
        return Ok(Vec::new());
    }
    Ok(reduce_peaks(&pcm, buckets as usize))
}

// ══════════════════════════ ffmpeg 획득 (앱 내 다운로드) ══════════════════════════
//
// lsp/acquire.rs ensure_native의 파이프라인(다운로드→sha256→해제→.tmp+rename 원자 설치)에
// 두 가지만 다르다: ① 대용량(40~111MB)이라 메모리 버퍼 대신 디스크 스트리밍 + 바이트 진행률,
// ② 릴리스 교체로 URL이 이동할 수 있는 공급원(johnvansickle)은 후보 URL을 여러 개 둔다(sha 동일).
//
// sha256은 2026-08-27 다운로드 시점 채록. **전 플랫폼 핀 필수** — 실행 파일을 받아 실행하는
// 경로라 핀 없는 다운로드는 두지 않는다(acquire.rs의 None-생략 약점을 여기선 허용 안 함).
// 플랫폼별 버전이 다른 것은 의도다(공급원별 최신 안정 릴리스): win/mac 9.0.1, linux 7.0.2.

#[derive(Clone, Copy)]
enum FfArchive {
    Zip,
    TarXz, // 시스템 tar로 해제(in-process xz 디코더 없음) — linux 전용 경로
}

struct FfArtifact {
    /// 순서대로 시도 — 앞이 죽으면 다음(공급원이 릴리스 교체 시 old-releases로 옮기는 경우).
    urls: &'static [&'static str],
    sha256: &'static str,
    kind: FfArchive,
}

struct FfmpegSpec {
    version: &'static str,
    artifacts: &'static [FfArtifact],
    /// 아카이브 최상위에서 dest로 올릴 서브디렉토리(없으면 해제 결과 전체).
    inner_dir: Option<&'static str>,
    exe_rel: &'static str,
    probe_rel: &'static str,
}

fn ffmpeg_spec() -> Option<FfmpegSpec> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        // gyan.dev essentials — 버전 고정 URL은 불변. ffmpeg/ffprobe 포함, ~111MB.
        Some(FfmpegSpec {
            version: "9.0.1",
            artifacts: &[FfArtifact {
                urls: &["https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.1-essentials_build.zip"],
                sha256: "fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9",
                kind: FfArchive::Zip,
            }],
            inner_dir: Some("ffmpeg-9.0.1-essentials_build"),
            exe_rel: "bin/ffmpeg.exe",
            probe_rel: "bin/ffprobe.exe",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        // johnvansickle static — 릴리스 교체 시 releases/ → old-releases/로 이동(sha 동일).
        Some(FfmpegSpec {
            version: "7.0.2",
            artifacts: &[FfArtifact {
                urls: &[
                    "https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz",
                    "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-7.0.2-amd64-static.tar.xz",
                ],
                sha256: "abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67",
                kind: FfArchive::TarXz,
            }],
            inner_dir: Some("ffmpeg-7.0.2-amd64-static"),
            exe_rel: "ffmpeg",
            probe_rel: "ffprobe",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(FfmpegSpec {
            version: "7.0.2",
            artifacts: &[FfArtifact {
                urls: &[
                    "https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-arm64-static.tar.xz",
                    "https://johnvansickle.com/ffmpeg/old-releases/ffmpeg-7.0.2-arm64-static.tar.xz",
                ],
                sha256: "f4149bb2b0784e30e99bdda85471c9b5930d3402014e934a5098b41d0f7201b1",
                kind: FfArchive::TarXz,
            }],
            inner_dir: Some("ffmpeg-7.0.2-arm64-static"),
            exe_rel: "ffmpeg",
            probe_rel: "ffprobe",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        // martin-riedl.de — 빌드 id 고정 URL(불변). ffmpeg/ffprobe가 zip 두 개(flat 단일 바이너리).
        Some(FfmpegSpec {
            version: "9.0.1",
            artifacts: &[
                FfArtifact {
                    urls: &["https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1/ffmpeg.zip"],
                    sha256: "8287a1b2229e05eb41859f073e18e6c52c60a778f2f5e6881070fe51b79407fe",
                    kind: FfArchive::Zip,
                },
                FfArtifact {
                    urls: &["https://ffmpeg.martin-riedl.de/download/macos/arm64/1787073674_9.0.1/ffprobe.zip"],
                    sha256: "102a26b8940a053298d9929bfaae71e4b6ef65ba5f19a99a88c433108560741a",
                    kind: FfArchive::Zip,
                },
            ],
            inner_dir: None,
            exe_rel: "ffmpeg",
            probe_rel: "ffprobe",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some(FfmpegSpec {
            version: "9.0.1",
            artifacts: &[
                FfArtifact {
                    urls: &["https://ffmpeg.martin-riedl.de/download/macos/amd64/1787081194_9.0.1/ffmpeg.zip"],
                    sha256: "5bdead62ff504ab9b447cc72b212c4fb481e3f7de5877d427a51bee8136dda40",
                    kind: FfArchive::Zip,
                },
                FfArtifact {
                    urls: &["https://ffmpeg.martin-riedl.de/download/macos/amd64/1787081194_9.0.1/ffprobe.zip"],
                    sha256: "34511bbcf1988ad2886023bf5ace4f44cf62e6defeb3d194d6f7619e5b061f7f",
                    kind: FfArchive::Zip,
                },
            ],
            inner_dir: None,
            exe_rel: "ffmpeg",
            probe_rel: "ffprobe",
        })
    } else {
        // win-arm64 등 — 공식 빌드가 사실상 없다. PATH/명시 경로로만.
        None
    }
}

fn send_progress(ch: &Channel<String>, phase: &str, percent: Option<u64>, message: Option<&str>) {
    let payload = serde_json::json!({
        "name": "ffmpeg", "phase": phase, "percent": percent, "message": message,
    });
    let _ = ch.send(payload.to_string());
}

/// 후보 URL을 순서대로 시도해 디스크로 스트리밍 다운로드 + sha256 검증.
async fn download_verified(
    client: &reqwest::Client,
    art: &FfArtifact,
    dest_file: &Path,
    ch: &Channel<String>,
) -> Result<(), IpcError> {
    let io = |e: String| IpcError::new(ErrorCode::Io, e);
    let mut last_err = io("다운로드 후보 URL 없음".into());
    for url in art.urls {
        let attempt: Result<(), IpcError> = async {
            let mut resp = client
                .get(*url)
                .send()
                .await
                .map_err(|e| io(format!("다운로드 실패: {e}")))?
                .error_for_status()
                .map_err(|e| io(format!("다운로드 상태 오류: {e}")))?;
            let total = resp.content_length();
            let mut file =
                std::fs::File::create(dest_file).map_err(|e| io(format!("임시 파일 생성 실패: {e}")))?;
            let mut hasher = Sha256::new();
            let mut got: u64 = 0;
            let mut last_pct: u64 = u64::MAX;
            while let Some(chunk) = resp.chunk().await.map_err(|e| io(format!("본문 수신 실패: {e}")))? {
                hasher.update(&chunk);
                file.write_all(&chunk).map_err(|e| io(format!("임시 파일 쓰기 실패: {e}")))?;
                got += chunk.len() as u64;
                if let Some(t) = total.filter(|t| *t > 0) {
                    let pct = got * 100 / t;
                    if pct != last_pct {
                        last_pct = pct;
                        send_progress(ch, "download", Some(pct), None);
                    }
                }
            }
            drop(file);
            let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if hex != art.sha256 {
                return Err(io("무결성 검증 실패 — 다운로드 변조 의심".into()));
            }
            Ok(())
        }
        .await;
        match attempt {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn extract_archive(kind: FfArchive, archive: &Path, temp: &Path) -> Result<(), IpcError> {
    let io = |e: String| IpcError::new(ErrorCode::Io, e);
    match kind {
        FfArchive::Zip => {
            let file = std::fs::File::open(archive).map_err(|e| io(format!("아카이브 열기 실패: {e}")))?;
            zip::ZipArchive::new(file)
                .map_err(|e| io(format!("zip 열기 실패: {e}")))?
                .extract(temp)
                .map_err(|e| io(format!("zip 해제 실패: {e}")))?;
            Ok(())
        }
        FfArchive::TarXz => {
            // 유닉스 tar는 .tar.xz를 투명 처리한다(acquire.rs TarXz와 동일 — xz-utils 필요).
            let ok = std::process::Command::new("tar")
                .arg("-xf")
                .arg(archive)
                .arg("-C")
                .arg(temp)
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok {
                Ok(())
            } else {
                Err(io("tar.xz 해제 실패 — 시스템 tar/xz 필요".into()))
            }
        }
    }
}

async fn ensure_ffmpeg(app: &AppHandle, ch: &Channel<String>) -> Result<(), IpcError> {
    let io = |e: String| IpcError::new(ErrorCode::Io, e);
    let spec = ffmpeg_spec().ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "이 플랫폼은 앱 내 다운로드를 지원하지 않습니다 — 패키지 관리자(brew/apt 등)로 ffmpeg를 설치하세요",
        )
    })?;
    let root = managed_root(app).ok_or_else(|| io("앱 데이터 경로 오류".into()))?;
    std::fs::create_dir_all(&root).ok();
    let dest = root.join(format!("ffmpeg-{}", spec.version));
    if dest.join(spec.exe_rel).is_file() && dest.join(spec.probe_rel).is_file() {
        send_progress(ch, "done", None, None);
        return Ok(()); // 멱등 — 이미 설치됨(ffmpeg·ffprobe 둘 다)
    }

    let client = reqwest::Client::builder()
        .user_agent("gitpervisor-video")
        .build()
        .map_err(|e| io(format!("HTTP 클라이언트 오류: {e}")))?;

    let temp = root.join(format!(".tmp-ffmpeg-{}", spec.version));
    std::fs::remove_dir_all(&temp).ok();
    std::fs::create_dir_all(&temp).map_err(|e| io(format!("temp 생성 실패: {e}")))?;

    for (i, art) in spec.artifacts.iter().enumerate() {
        send_progress(ch, "download", Some(0), None);
        let archive = temp.join(format!("archive-{i}"));
        download_verified(&client, art, &archive, ch).await?;
        send_progress(ch, "extract", None, None);
        extract_archive(art.kind, &archive, &temp)?;
        std::fs::remove_file(&archive).ok();
    }

    // .tmp → dest 원자 이동, 마커는 맨 마지막 (acquire.rs 계약).
    let src = match spec.inner_dir {
        Some(inner) => temp.join(inner),
        None => temp.clone(),
    };
    std::fs::remove_dir_all(&dest).ok();
    std::fs::rename(&src, &dest).map_err(|e| io(format!("설치 이동 실패: {e}")))?;
    std::fs::remove_dir_all(&temp).ok();

    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        for rel in [spec.exe_rel, spec.probe_rel] {
            let bin = dest.join(rel);
            if let Ok(meta) = std::fs::metadata(&bin) {
                let mut perm = meta.permissions();
                perm.set_mode(0o755);
                let _ = std::fs::set_permissions(&bin, perm);
            }
        }
    }
    std::fs::write(dest.join(".ok"), spec.version).map_err(|e| io(format!("마커 쓰기 실패: {e}")))?;
    send_progress(ch, "done", None, None);
    Ok(())
}

/// ffmpeg 앱 내 다운로드 — 설정 버튼 클릭으로만 호출된다("클릭이 곧 동의", lsp_ensure 정책).
#[tauri::command]
pub async fn video_tool_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<String>,
) -> Result<VideoToolStatus, IpcError> {
    if let Err(e) = ensure_ffmpeg(&app, &on_progress).await {
        let msg = e.to_string().replace('"', "'");
        send_progress(&on_progress, "error", None, Some(&msg));
        return Err(e);
    }
    video_tool_status(app, state).await
}

// ══════════════════════════ 테스트 ══════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn base_spec() -> ExportSpec {
        ExportSpec {
            src_rel: "a.mp4".into(),
            out_rel: "a.clip.mp4".into(),
            overwrite: false,
            range: None,
            mode: "copy".into(),
            speed: None,
            crop: None,
            crf: None,
            max_height: None,
            remove_audio: false,
            masks: None,
            mask_kind: None,
            duration_ms: 60_000,
            has_audio: true,
        }
    }

    /// 프레임 캡처가 고르는 프레임 = 웹뷰가 그리는 프레임(pts ≤ 재생 시각인 마지막).
    /// 실측(ffmpeg 8.0, 30fps B프레임 mp4)에서 재생 시각을 -ss 로 그대로 넘기면 저장본이 1~2프레임
    /// 뒤였고 영상 끝에서는 아무것도 안 나왔다 — 그 두 경우를 고정한다.
    #[test]
    fn capture_picks_last_frame_at_or_before_playhead() {
        // B프레임 재정렬로 패킷 순서가 pts 순서와 다르다(실제 ffprobe 출력 순서).
        let json = r#"{"packets":[{"pts_time":"0.500000"},{"pts_time":"0.633333"},
            {"pts_time":"0.566667"},{"pts_time":"0.533333"},{"pts_time":"0.600000"},
            {"pts_time":"N/A"},{"pts_time":"0.966667"},{"pts_time":"0.933333"}],
            "format":{}}"#;
        let pts = parse_packet_pts(json);
        assert_eq!(pts.len(), 7, "N/A 패킷은 버린다");
        // 두 프레임 사이(0.51)에 멈추면 앞 프레임(0.5)이 화면에 있다.
        assert_eq!(pick_displayed_pts(&pts, 0.51), Some(0.5));
        // "." 두 번(2/30)은 Chromium이 µs로 잘라 0.066666 — pts 0.066667 보다 앞이라 프레임 1이 보인다.
        assert_eq!(pick_displayed_pts(&[0.033333, 0.066667, 0.1], 0.066666), Some(0.033333));
        // 정확히 pts 에 멈추면 그 프레임 — ms→초 왕복이 pts 보다 **작게** 떨어지는 값(µs 의 약 1%)으로
        // 0.5µs 여유를 실제로 거치게 한다.
        let at = (0.001309_f64 * 1000.0) / 1000.0;
        assert!(at < 0.001309, "왕복 잡음이 아래로 떨어지는 값이어야 이 단언이 의미 있다");
        assert_eq!(pick_displayed_pts(&[0.0, 0.001309, 0.0015], at), Some(0.001309));
        // B프레임이 뒤에 와도 최댓값을 고른다.
        assert_eq!(pick_displayed_pts(&pts, 0.6), Some(0.6));
        // 영상 끝(duration 1.0)은 마지막 프레임.
        assert_eq!(pick_displayed_pts(&pts, 1.0), Some(0.966667));
        // at 이하 프레임이 없으면 None → 호출자가 재생 시각으로 폴백.
        assert_eq!(pick_displayed_pts(&pts, 0.4), None);
        assert!(parse_packet_pts("not json").is_empty());
    }

    /// 실제 ffmpeg·ffprobe(PATH)로 캡처 시크를 끝까지 돌려 본다 — 인자 조합까지 검증하는 수동 테스트.
    /// `cargo test --lib capture_real_ffmpeg -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "PATH의 ffmpeg·ffprobe 필요"]
    async fn capture_real_ffmpeg_matches_displayed_frame() {
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let probe = crate::tools::runner::find_on_path("ffprobe").expect("ffprobe");
        let dir = std::env::temp_dir().join(format!("gpv-cap-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("a.mp4").display().to_string();
        // 30fps 1초, 프레임 N의 밝기 N*7+24(전부 구분됨), B프레임 있음.
        let gen = [
            "-v", "error", "-y", "-f", "lavfi",
            "-i", "color=black:s=64x36:r=30:d=1,geq=lum='N*7+24':cb=128:cr=128",
            "-c:v", "libx264", "-bf", "3", "-g", "15", "-pix_fmt", "yuv420p", &src,
        ];
        assert_eq!(run_capture(&ffmpeg, &gen, 30).await.unwrap().0, 0);
        // format=gray 먼저 — yuv420p 에서 폭 1 crop 은 크로마 정렬로 0이 된다.
        let gray = ["-vf", "format=gray,crop=1:1:10:10", "-f", "rawvideo", "-"];
        let mut all = vec!["-v", "error", "-i", src.as_str()];
        all.extend(gray);
        let (code, reference, err) = run_capture_bytes(&ffmpeg, &all, 30).await.unwrap();
        assert_eq!(reference.len(), 30, "code={code} stderr={err}");
        assert!(reference.windows(2).all(|w| w[0] < w[1]), "프레임이 구분돼야 단언이 의미 있다");

        // 같은 프레임을 start_time 1.5초로 옮긴 mkv(ms 타임베이스) — 직접 재생의 currentTime 은 절대 pts,
        // HLS 폴백은 start 기준 상대 시각이다.
        let offset = dir.join("b.mkv").display().to_string();
        let remux = ["-v", "error", "-y", "-i", src.as_str(), "-c", "copy", "-output_ts_offset", "1.5", offset.as_str()];
        assert_eq!(run_capture(&ffmpeg, &remux, 30).await.unwrap().0, 0);

        let cases = [
            (&src, false, 0.0, 0), (&src, false, 0.05, 1), (&src, false, 0.066666, 1),
            (&src, false, 0.0666667, 2), (&src, false, 0.51, 15), (&src, false, 0.95, 28),
            (&src, false, 1.0, 29),
            (&offset, false, 1.5, 0), (&offset, false, 1.55, 1), (&offset, false, 2.0, 15),
            (&offset, false, 2.5, 29),
            // 키프레임(2.0) µs 아래 — read_intervals 가 키프레임으로 반올림 시크해 at 이하 패킷이 없는
            // 폴백 경로. 웹뷰도 키프레임을 그린다(Chrome 실측). 폴백이 start 를 안 빼면 끝을 넘어 None.
            (&offset, false, 1.999989, 15),
            (&offset, true, 0.05, 1), (&offset, true, 0.5, 15), (&offset, true, 1.0, 29),
        ];
        for (file, hls, at, want) in cases {
            let seek = format!("{:.6}", frame_seek_secs(Some(&probe), file, at, hls).await);
            let mut one = vec!["-v", "error", "-ss", seek.as_str(), "-i", file.as_str(), "-frames:v", "1"];
            one.extend(gray);
            let got = run_capture_bytes(&ffmpeg, &one, 30).await.unwrap().1;
            assert_eq!(
                got.first(),
                Some(&reference[want]),
                "{file} hls={hls} at={at} seek={seek} → 프레임 {want} 이어야 한다"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn capture_parses_ffprobe_start_time() {
        assert_eq!(parse_start_time(r#"{"format":{"start_time":"1.500000"}}"#), 1.5);
        assert_eq!(parse_start_time(r#"{"format":{"start_time":"N/A"}}"#), 0.0);
        assert_eq!(parse_start_time(r#"{"format":{}}"#), 0.0);
        assert_eq!(parse_start_time(""), 0.0);
    }

    /// 무손실 구간 추출 — -ss는 -i 앞(입력 시킹), 길이는 -t. -to를 쓰면 입력 시킹 후
    /// 출력 타임스탬프 기준이라 구간이 어긋나는 고전 버그가 있다(회귀 방지).
    #[test]
    fn copy_trim_uses_input_seek_and_duration_not_to() {
        let mut s = base_spec();
        s.range = Some(RangeMs { start_ms: 12_300, end_ms: 47_800 });
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        let i_pos = a.iter().position(|x| x == "-i").unwrap();
        let ss_pos = a.iter().position(|x| x == "-ss").unwrap();
        assert!(ss_pos < i_pos, "-ss가 -i 앞(입력 시킹)이어야 한다");
        assert_eq!(a[ss_pos + 1], "12.300");
        let t_pos = a.iter().position(|x| x == "-t").unwrap();
        assert_eq!(a[t_pos + 1], "35.500", "-t는 지속시간(B-A)");
        assert!(!a.iter().any(|x| x == "-to"), "-to 금지");
        assert!(a.windows(2).any(|w| w[0] == "-c" && w[1] == "copy"));
        assert!(a.iter().any(|x| x == "-avoid_negative_ts"));
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "mp4"), "임시 이름이라 muxer 명시 필수");
    }

    /// 홀수 크롭은 yuv420p+libx264에서 실패한다 — 짝수 내림 회귀 방지.
    #[test]
    fn crop_is_evenized() {
        let mut s = base_spec();
        s.mode = "encode".into();
        s.crop = Some(CropRect { x: 101, y: 51, w: 333, h: 201 });
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        let vf = a.iter().position(|x| x == "-vf").map(|i| a[i + 1].clone()).unwrap();
        assert!(vf.contains("crop=332:200:100:50"), "vf={vf}");
    }

    /// 마스크는 `-vf`로 표현할 수 없다 — split/overlay 그래프 + 명시적 -map으로 나가야 하고,
    /// crop보다 **앞**에 걸려야 한다(원본 좌표계). 순서가 뒤집히면 엉뚱한 데를 가린다.
    #[test]
    fn masks_build_overlay_graph_before_crop() {
        let mut spec = base_spec();
        spec.mode = "encode".into();
        spec.has_audio = true;
        spec.masks = Some(vec![
            CropRect { x: 100, y: 50, w: 320, h: 200 },
            CropRect { x: 10, y: 11, w: 64, h: 64 },
        ]);
        spec.mask_kind = Some("mosaic".into());
        spec.crop = Some(CropRect { x: 0, y: 0, w: 640, h: 480 });
        let a = build_export_args("/r/in.mp4", "/r/.t.tmp", &spec);

        assert!(!a.iter().any(|x| x == "-vf"), "마스크가 있으면 -vf가 아니라 filter_complex다: {a:?}");
        let fc = a.iter().position(|x| x == "-filter_complex").map(|i| a[i + 1].clone()).unwrap();
        // 원본 1갈래 + 마스크 2갈래
        assert!(fc.starts_with("[0:v]split=3[bg][s0][s1];"), "fc={fc}");
        // 픽셀화: 다운스케일 → neighbor 업스케일
        assert!(fc.contains("[s0]crop=320:200:100:50,scale=20:12:flags=neighbor,scale=320:200:flags=neighbor[e0]"), "fc={fc}");
        assert!(fc.contains("[bg][e0]overlay=100:50[o0]"), "fc={fc}");
        assert!(fc.contains("[o0][e1]overlay=10:10[o1]"), "fc={fc}");
        // crop은 마스크 **뒤**에 붙는다
        let mask_end = fc.find("[o1]crop=640:480:0:0").unwrap_or_else(|| panic!("fc={fc}"));
        assert!(fc.find("overlay=10:10").unwrap() < mask_end, "crop이 overlay보다 앞이다: {fc}");
        assert!(fc.ends_with("[v]"), "fc={fc}");
        // filter_complex는 자동 스트림 선택을 끈다 — 오디오까지 명시 매핑돼야 한다.
        let maps: Vec<&String> =
            a.iter().enumerate().filter(|(i, x)| *x == "-map" && *i + 1 < a.len()).map(|(i, _)| &a[i + 1]).collect();
        assert_eq!(maps, vec!["[v]", "0:a?"], "a={a:?}");
    }

    /// 블러는 boxblur, 반경은 짧은 변의 1/8(영역보다 커지면 ffmpeg가 거부한다).
    #[test]
    fn blur_mask_uses_boxblur_scaled_to_region() {
        let mut spec = base_spec();
        spec.mode = "encode".into();
        spec.masks = Some(vec![CropRect { x: 8, y: 8, w: 64, h: 32 }]);
        spec.mask_kind = Some("blur".into());
        let a = build_export_args("/r/in.mp4", "/r/.t.tmp", &spec);
        let fc = a.iter().position(|x| x == "-filter_complex").map(|i| a[i + 1].clone()).unwrap();
        assert!(fc.contains("[s0]crop=64:32:8:8,boxblur=4:2[e0]"), "fc={fc}");
        // 다른 필터가 없으면 null로 이어 붙여 라벨을 만든다.
        assert!(fc.ends_with("[o0]null[v]"), "fc={fc}");
    }

    /// 무손실 복사와 마스크는 양립 불가 — 백엔드도 막는다(프론트 자동 전환의 이중 방어).
    #[test]
    fn copy_mode_rejects_masks() {
        let mut spec = base_spec();
        spec.mode = "copy".into();
        spec.masks = Some(vec![CropRect { x: 0, y: 0, w: 32, h: 32 }]);
        assert!(validate_spec(&spec).is_err());
    }

    /// atempo는 0.5~2 범위만 안전 — 4x/0.25x는 체인으로 분해된다.
    #[test]
    fn atempo_chains_outside_safe_range() {
        assert_eq!(atempo_chain(4.0), "atempo=2.0,atempo=2");
        assert_eq!(atempo_chain(0.25), "atempo=0.5,atempo=0.5");
        assert_eq!(atempo_chain(3.0), "atempo=2.0,atempo=1.5");
        assert_eq!(atempo_chain(1.5), "atempo=1.5");
    }

    /// 배속 재인코딩 — setpts는 영상, atempo는 오디오에 함께 걸려야 한다(한쪽만 걸면 A/V 어긋남).
    #[test]
    fn speed_applies_setpts_and_atempo_together() {
        let mut s = base_spec();
        s.mode = "encode".into();
        s.speed = Some(2.0);
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        let vf = a.iter().position(|x| x == "-vf").map(|i| a[i + 1].clone()).unwrap();
        assert!(vf.contains("setpts=PTS/2"));
        let af = a.iter().position(|x| x == "-af").map(|i| a[i + 1].clone()).unwrap();
        assert!(af.contains("atempo=2"));
    }

    /// 무손실 복사와 양립 불가 옵션은 백엔드도 거절한다(프론트 자동 전환의 방어선).
    #[test]
    fn copy_mode_rejects_reencode_options() {
        let mut s = base_spec();
        s.crop = Some(CropRect { x: 0, y: 0, w: 100, h: 100 });
        assert!(validate_spec(&s).is_err());
        let mut s = base_spec();
        s.speed = Some(2.0);
        assert!(validate_spec(&s).is_err());
        let mut s = base_spec();
        s.out_rel = "a.gif".into();
        assert!(validate_spec(&s).is_err(), "gif는 재인코딩 필수");
        // 음소거 제거는 copy와 양립한다.
        let mut s = base_spec();
        s.remove_audio = true;
        assert!(validate_spec(&s).is_ok());
    }

    /// gif는 -vf가 아니라 filter_complex(팔레트 split 그래프) + -an.
    #[test]
    fn gif_uses_filter_complex_palette() {
        let mut s = base_spec();
        s.mode = "encode".into();
        s.out_rel = "a.gif".into();
        s.range = Some(RangeMs { start_ms: 0, end_ms: 3000 });
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        let fc = a.iter().position(|x| x == "-filter_complex").map(|i| a[i + 1].clone()).unwrap();
        assert!(fc.contains("palettegen") && fc.contains("paletteuse") && fc.contains("fps=12"));
        assert!(a.iter().any(|x| x == "-an"));
        assert!(!a.iter().any(|x| x == "-vf"));
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "gif"));
    }

    /// 오디오 추출 copy — -vn + -c:a copy + ipod muxer(m4a).
    #[test]
    fn audio_extract_copy() {
        let mut s = base_spec();
        s.out_rel = "a.m4a".into();
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        assert!(a.iter().any(|x| x == "-vn"));
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "copy"));
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "ipod"));
    }

    /// 오디오 인코딩 코덱은 출력 확장자를 따른다 — mp3 muxer에 AAC를 넣으면 100% 실패(회귀 방지).
    #[test]
    fn audio_encode_codec_follows_extension() {
        let mut s = base_spec();
        s.mode = "encode".into();
        s.out_rel = "a.mp3".into();
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "libmp3lame"), "{a:?}");
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "mp3"));
        s.out_rel = "a.m4a".into();
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s);
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
    }

    /// 진행률 파싱 — ffmpeg의 out_time_ms는 이름과 달리 µs다(out_time_us와 동값).
    #[test]
    fn progress_line_parses_both_us_keys() {
        assert_eq!(parse_out_time_us("out_time_us=1234567"), Some(1_234_567));
        assert_eq!(parse_out_time_us("out_time_ms=1234567"), Some(1_234_567));
        assert_eq!(parse_out_time_us("frame=42"), None);
    }

    /// 배속 내보내기의 진행률 분모 — 출력 길이는 D/speed로 줄어든다.
    #[test]
    fn expected_output_scales_with_speed() {
        let mut s = base_spec();
        s.mode = "encode".into();
        s.speed = Some(2.0);
        s.range = Some(RangeMs { start_ms: 0, end_ms: 10_000 });
        assert_eq!(expected_out_us(&s), 5_000_000);
        s.mode = "copy".into(); // copy는 speed 무시
        s.speed = None;
        assert_eq!(expected_out_us(&s), 10_000_000);
    }

    #[test]
    fn version_line_parses() {
        assert_eq!(
            parse_version("ffmpeg version 9.0.1-essentials_build-www.gyan.dev Copyright"),
            Some("9.0.1".into())
        );
        assert_eq!(parse_version("garbage"), None);
    }

    /// 회전 90/270 소스는 표시 기준으로 폭·높이를 교환해야 크롭 좌표계와 일치한다.
    #[test]
    fn probe_swaps_dimensions_on_rotation() {
        let json = r#"{
          "streams": [
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
             "avg_frame_rate":"30000/1001",
             "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]},
            {"codec_type":"audio","codec_name":"aac"}
          ],
          "format": {"duration":"12.5","bit_rate":"4000000"}
        }"#;
        let m = parse_probe(json).unwrap();
        assert_eq!((m.width, m.height), (1080, 1920));
        assert!((m.fps - 29.97).abs() < 0.01);
        assert_eq!(m.duration_ms, 12_500);
        assert_eq!(m.bitrate_kbps, Some(4000));
        assert!(m.has_audio);
        assert_eq!(m.acodec.as_deref(), Some("aac"));
    }

    /// avg_frame_rate가 "0/0"(미상)이면 r_frame_rate로 폴백한다.
    #[test]
    fn probe_falls_back_to_r_frame_rate() {
        let json = r#"{"streams":[{"codec_type":"video","width":10,"height":10,
          "avg_frame_rate":"0/0","r_frame_rate":"25/1"}],"format":{}}"#;
        assert_eq!(parse_probe(json).unwrap().fps, 25.0);
    }

    /// 필름스트립은 ffmpeg **1회·이미지 1장**이다 — fps는 cols/길이(초)로 구간을 등분하고,
    /// tile=colsx1이 그걸 가로 스프라이트로 합친다. 출력은 파일이 아니라 파이프(image2pipe).
    #[test]
    fn filmstrip_tiles_whole_clip_in_one_sprite() {
        // 12초 · 40칸 → 3.333333fps(= 0.3초마다 한 장).
        let a = build_filmstrip_args("/r/a.mp4", 40, 48, 12_000);
        let vf = a.iter().position(|x| x == "-vf").map(|i| a[i + 1].clone()).unwrap();
        assert_eq!(vf, "fps=3.333333,scale=-2:48,tile=40x1", "vf={vf}");
        assert!(a.windows(2).any(|w| w[0] == "-frames:v" && w[1] == "1"), "타일 1장만: {a:?}");
        assert!(a.windows(2).any(|w| w[0] == "-c:v" && w[1] == "mjpeg"));
        // image2는 파일명 패턴 muxer라 파이프에 못 쓴다.
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "image2pipe"), "a={a:?}");
        assert_eq!(a.last().unwrap(), "pipe:1");
        // -i **뒤**에 필터가 와야 한다(입력 옵션으로 새면 무시된다).
        let i_pos = a.iter().position(|x| x == "-i").unwrap();
        assert!(i_pos < a.iter().position(|x| x == "-vf").unwrap());
    }

    /// 길이 0(프로브 실패 잔재)이 fps를 무한대로 만들지 않는다 — 명령 자체가 깨진다.
    #[test]
    fn filmstrip_fps_survives_zero_duration() {
        let a = build_filmstrip_args("/r/a.mp4", 10, 48, 0);
        let vf = a.iter().position(|x| x == "-vf").map(|i| a[i + 1].clone()).unwrap();
        assert!(vf.starts_with("fps=10000.000000,"), "vf={vf}");
    }

    /// tile_w는 scale=-2 반올림을 재구현해 추정하지 않고 산출물 JPEG의 SOF에서 읽는다.
    /// DHT(0xC4)도 0xC0~0xCF 범위라 프레임 헤더로 오인하면 엉뚱한 값이 나온다(회귀 방지).
    #[test]
    fn jpeg_size_reads_sof_and_skips_dht() {
        let jpg: Vec<u8> = vec![
            0xFF, 0xD8, // SOI
            0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, // APP0(len 4)
            0xFF, 0xC4, 0x00, 0x03, 0x00, // DHT(len 3) — SOF 아님
            0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x38, 0x03, 0xC0, // SOF0 h=56 w=960
            0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        ];
        assert_eq!(jpeg_size(&jpg), Some((960, 56)));
        assert_eq!(jpeg_size(&[0xFF, 0xD8]), None);
        // 960 / 40칸 = 24px 타일.
        assert_eq!(960u32 / 40, 24);
    }

    /// 파형은 8kHz 모노 s16le 원시 PCM을 파이프로 받는다 — 컨테이너·비디오 없이.
    #[test]
    fn waveform_args_decode_mono_s16le_pcm() {
        let a = build_waveform_args("/r/a.mp4");
        assert!(a.iter().any(|x| x == "-vn"), "a={a:?}");
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "s16le"));
        assert!(a.windows(2).any(|w| w[0] == "-ac" && w[1] == "1"));
        assert!(a.windows(2).any(|w| w[0] == "-ar" && w[1] == "8000"));
        assert_eq!(a.last().unwrap(), "pipe:1");
    }

    /// 버킷별 절대 피크 → 최대값 정규화. 샘플이 버킷보다 적어도 나눗셈이 0으로 가지 않는다.
    #[test]
    fn peaks_normalise_and_handle_short_input() {
        // 4샘플 · 2버킷 → [max(1000,-2000), max(500,4000)] → [2000,4000] → [0.5, 1.0]
        let pcm: Vec<u8> = [1000i16, -2000, 500, 4000].iter().flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(reduce_peaks(&pcm, 2), vec![0.5, 1.0]);
        // 샘플 1개 · 버킷 4개 — 패닉·0나눗셈 없이 첫 칸만 채운다.
        assert_eq!(reduce_peaks(&100i16.to_le_bytes(), 4), vec![1.0, 0.0, 0.0, 0.0]);
        // 완전 무음은 정규화 분모가 0 — NaN을 만들지 않는다.
        assert_eq!(reduce_peaks(&[0, 0, 0, 0], 2), vec![0.0, 0.0]);
        // 오디오 없음(빈 PCM)은 빈 벡터 = 프론트의 "파형 없음" 계약.
        assert!(reduce_peaks(&[], 8).is_empty());
    }
}
