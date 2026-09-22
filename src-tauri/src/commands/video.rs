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
use crate::stt::subs::{SubText, SubTimeline};
use crate::stt::video_subs::{CaptionSubs, SubsFile, SubsMode, BURN_FILTER};

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
/// 전사 잡(stt/transcribe.rs)도 같은 레지스트리에 올라가 `video_kill_all`이 앱 종료 때 함께 거둔다.
pub(crate) struct JobGuard {
    pub(crate) jobs: Arc<Mutex<HashMap<String, VideoJob>>>,
    pub(crate) job_id: String,
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
pub(crate) fn kill_pid(pid: u32) {
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
    /// 자막 번인(libass `subtitles` 필터)이 되는 빌드인가 — 없으면 UI가 소프트 자막으로 안내(태스크 72 §3.6-5).
    pub has_subtitles_filter: bool,
}

/// `ffmpeg -filters` 목록에 `name` 필터가 있는가. 줄 모양: ` ..C subtitles         V->V       Render text …`.
fn filters_list_has(listing: &str, name: &str) -> bool {
    listing.lines().any(|l| {
        let mut it = l.split_whitespace().skip(1);
        it.next() == Some(name) && it.next().is_some_and(|io| io.contains("->"))
    })
}

/// 경로별 `subtitles` 필터 유무 — 빌드마다 다르므로(gyan essentials·johnvansickle에는 있고, 시스템 ffmpeg는 모른다)
/// 경로마다 한 번만 묻는다. 실패(실행·시간 초과)는 캐시하지 않는다.
static SUBTITLES_FILTER: Mutex<Option<HashMap<PathBuf, bool>>> = Mutex::new(None);

pub(crate) async fn has_subtitles_filter(ffmpeg: &Path) -> Result<bool, IpcError> {
    let cached = SUBTITLES_FILTER.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(ffmpeg).copied());
    if let Some(v) = cached {
        return Ok(v);
    }
    let (code, out, err) = run_capture(ffmpeg, &["-hide_banner", "-filters"], 10).await?;
    if code != 0 {
        return Err(IpcError {
            code: ErrorCode::Io,
            message: format!("ffmpeg 필터 목록을 읽지 못했습니다({}, 종료 코드 {code})", ffmpeg.display()),
            stderr: Some(err),
        });
    }
    let has = filters_list_has(&out, "subtitles");
    SUBTITLES_FILTER
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(ffmpeg.to_path_buf(), has);
    Ok(has)
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
            // 상태 조회는 실패해도 "번인 불가"로 보인다 — 내보내기가 같은 검사를 다시 하고 그때 진짜 오류를 알린다.
            let has_subtitles_filter = has_subtitles_filter(&bin.ffmpeg).await.unwrap_or_else(|e| {
                log::warn!("[video] 자막 번인 필터 확인 실패 {}: {}", bin.ffmpeg.display(), e.message);
                false
            });
            Ok(VideoToolStatus {
                found: true,
                source: Some(bin.source.to_string()),
                path: Some(bin.ffmpeg.display().to_string()),
                probe_found: bin.ffprobe.is_some(),
                version,
                managed_supported,
                has_subtitles_filter,
            })
        }
        Err(_) => Ok(VideoToolStatus {
            found: false,
            source: None,
            path: None,
            probe_found: false,
            version: None,
            managed_supported,
            has_subtitles_filter: false,
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
    /// ffprobe `format.start_time`(ms, 음수 가능 — Opus webm −7ms). 직접 재생의 currentTime은 컨테이너
    /// 절대 pts, ffmpeg `-ss`·HLS·자막 문서 시각은 start_time 상대라 그 사이를 이 값으로 옮긴다
    /// (frame_seek_secs의 "시각의 기준", 태스크 72 §3.5).
    pub start_time_ms: i64,
    /// 오디오 트랙 목록(파일 순) — 자막을 만들 트랙 고르기(OBS 다중 트랙 녹화, 태스크 72 P3).
    pub audio_streams: Vec<AudioStreamInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    /// 오디오 스트림 안 순번 — ffmpeg `-map 0:a:<index>`, 전사 요청 `audioStream`이 이 값이다(전체 스트림 번호가 아니다).
    pub index: u32,
    pub codec: Option<String>,
    pub channels: Option<u32>,
    /// 컨테이너 태그 그대로(`kor`·`und` 등).
    pub language: Option<String>,
    pub title: Option<String>,
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
    // 없거나 "N/A"면 0 — parse_start_time과 같은 규칙.
    let start_time_ms = v["format"]["start_time"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|s| s.is_finite())
        .map_or(0, |s| (s * 1000.0).round() as i64);

    let text = |v: &serde_json::Value| v.as_str().map(str::to_string);
    let audio_streams = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .enumerate()
        .map(|(i, s)| AudioStreamInfo {
            index: i as u32,
            codec: text(&s["codec_name"]),
            channels: s["channels"].as_u64().map(|c| c as u32),
            language: text(&s["tags"]["language"]),
            title: text(&s["tags"]["title"]),
        })
        .collect();

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
        start_time_ms,
        audio_streams,
    })
}

pub(crate) fn need_probe(bin: &FfmpegBin) -> Result<PathBuf, IpcError> {
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

/// 자막 편집 계획(stt/plan.rs `CaptionPlan.keep`)이 같은 모양으로 IPC에 내보낸다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
    /// 대본 편집본(태스크 72 §3.6-1) — 저장된 자막 문서로 `caption_plan`을 계산해 남는 구간만 이어 붙인다.
    /// 남길 구간은 IPC로 받지 않는다(계획 구현이 하나여야 한다). 재인코딩·영상 컨테이너 전용, `range`와 배타.
    #[serde(default)]
    pub caption_cut: bool,
    /// 자막 입힌 영상(태스크 72 §3.6 4~6) — 저장된 자막 문서의 자막을 번인(libass)하거나 자막 스트림(mov_text)으로
    /// 싣는다. 영상 컨테이너 전용, 번인은 재인코딩 전용, 편집본 시각은 `caption_cut`과 짝.
    #[serde(default)]
    pub caption_subs: Option<CaptionSubs>,
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

/// ms → 필터 그래프 안 초 표기 — 소수 6자리 숫자만("12.345000", §3.6-1). 정수 연산이라 부동소수 표기(1e-5 등)가 없다.
fn fmt_secs6(ms: u64) -> String {
    format!("{}.{:03}000", ms / 1000, ms % 1000)
}

/// 인라인 `-filter_complex`가 이보다 길면 파일로 넘긴다. 부록 B.2: 구간당 ≈192자, 150구간(29.0K자)도 Windows
/// 명령줄 한도(32,767자) 안에서 됐다 — 24KB는 입·출력 경로 몫까지 남긴 경계.
const INLINE_GRAPH_MAX: usize = 24 * 1024;

/// 대본 편집본 그래프 — 남길 구간마다 trim/atrim 후 concat. 출력 라벨 `[vc]`(+ 오디오면 `[ac]`).
/// 입력 탐색(-ss)은 쓰지 않는다: 구간이 여럿이라 전부 한 디코드 타임라인(start_time 상대 = 자막 문서 시각)에서 자른다.
/// 이음매의 딸깍 소리를 막으려 구간마다 10ms 페이드 인·아웃. `audio`는 오디오 입력 스트림(`0:a`·`0:a:<n>`), 없으면 영상만.
fn build_cut_graph(keep: &[RangeMs], audio: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(keep.len() * 2 + 1);
    let mut inputs = String::new();
    for (i, r) in keep.iter().enumerate() {
        let (a, b) = (fmt_secs6(r.start_ms), fmt_secs6(r.end_ms));
        parts.push(format!("[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}]"));
        inputs.push_str(&format!("[v{i}]"));
        if let Some(ain) = audio {
            let fade_out = fmt_secs6((r.end_ms - r.start_ms).saturating_sub(10));
            parts.push(format!(
                "[{ain}]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st={fade_out}:d=0.01[a{i}]"
            ));
            inputs.push_str(&format!("[a{i}]"));
        }
    }
    let n = keep.len();
    if audio.is_some() {
        parts.push(format!("{inputs}concat=n={n}:v=1:a=1[vc][ac]"));
    } else {
        parts.push(format!("{inputs}concat=n={n}:v=1:a=0[vc]"));
    }
    parts.join(";")
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
/// crop된 프레임에 원본 좌표를 적용해 엉뚱한 데를 가린다. `input`은 원본(`[0:v]`) 또는 대본 컷 출력(`[vc]`) —
/// 컷은 시간만 바꾸므로 좌표계가 같다.
fn build_mask_graph(spec: &ExportSpec, input: &str) -> Option<(String, String)> {
    let masks = spec.masks.as_ref()?;
    if masks.is_empty() {
        return None;
    }
    let mosaic = spec.mask_kind.as_deref() != Some("blur");
    let n = masks.len();
    let mut parts: Vec<String> = Vec::new();
    // split은 원본 1갈래(배경) + 마스크당 1갈래.
    let srcs: String = (0..n).map(|i| format!("[s{i}]")).collect();
    parts.push(format!("{input}split={}[bg]{srcs}", n + 1));

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
    if spec.caption_cut {
        // 구간 여럿을 이어 붙이려면 디코드가 필요하고, 남길 구간은 이미 원본 전체 타임라인 기준이다.
        if spec.mode != "encode" {
            return bad("대본 편집본은 재인코딩으로만 만들 수 있습니다 (무손실 복사 불가)");
        }
        if spec.range.is_some() {
            return bad("대본 편집본은 구간(In/Out)과 함께 쓸 수 없습니다");
        }
        if !matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
            return bad(&format!("대본 편집본은 mp4·mov로만 내보냅니다 (.{ext})"));
        }
    }
    if let Some(cs) = &spec.caption_subs {
        // mov_text 자막 스트림을 담을 수 있는 컨테이너만(gif·오디오 전용은 자막을 실을 곳이 없다).
        if !matches!(ext.as_str(), "mp4" | "m4v" | "mov") {
            return bad(&format!("자막 입힌 영상은 mp4·mov로만 내보냅니다 (.{ext})"));
        }
        if cs.mode == SubsMode::Burn && spec.mode != "encode" {
            return bad("자막 번인은 재인코딩으로만 만들 수 있습니다 (무손실 복사 불가)");
        }
        match (cs.timeline, spec.caption_cut) {
            (SubTimeline::Edited, false) => return bad("편집본 시각 자막은 대본 편집본과 함께만 넣을 수 있습니다"),
            (SubTimeline::Source, true) => return bad("대본 편집본에는 편집본 시각 자막만 넣을 수 있습니다"),
            _ => {}
        }
        if cs.text != SubText::Caption && cs.lang.as_deref().is_none_or(|l| l.trim().is_empty()) {
            return bad("번역 자막의 언어가 지정되지 않았습니다");
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

/// 자막 문서에서 온 내보내기 입력 — video_export_inner가 저장본으로 채운다. 문서가 없는 내보내기는 기본값.
#[derive(Default, Clone, Copy)]
struct DocInputs<'a> {
    /// `caption_cut`의 남길 구간(stt/store.rs `load_export_doc` → plan.keep).
    keep: Option<&'a [RangeMs]>,
    /// 문서가 전사한 오디오 트랙(`0:a:<n>`) — 편집본·자막 입힌 영상의 소리도 이 트랙이다. None = ffmpeg 자동 선택.
    audio_stream: Option<u32>,
    subs: Option<&'a SubsFile>,
}

/// 순수 인자 생성기 — 유닛테스트 대상. src/tmp_out은 절대경로 문자열.
fn build_export_args(src: &str, tmp_out: &str, spec: &ExportSpec, doc: &DocInputs) -> Vec<String> {
    let ext = ext_of(&spec.out_rel);
    let muxer = muxer_for_ext(&ext).unwrap_or("mp4");
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1"]
        .map(String::from)
        .to_vec();
    let cut = doc.keep;

    // -ss는 -i **앞**(입력 시킹 — 키프레임 고속 점프), 길이는 -t(지속시간).
    // ⚠ -to를 쓰면 안 된다: 입력 시킹 후 -to는 출력 타임스탬프 기준이라 구간이 어긋난다.
    // 대본 컷은 구간을 그래프가 자르므로 입력 탐색이 없다(validate_spec이 range와 함께 쓰는 것도 막는다).
    if let (Some(r), None) = (&spec.range, cut) {
        a.extend(["-ss".into(), fmt_secs(r.start_ms), "-t".into(), fmt_secs(r.end_ms - r.start_ms)]);
    }
    a.extend(["-i".into(), src.to_string()]);
    // 소프트 자막 = 입력 1번(위 -ss/-t는 입력 0에만 걸린다 — 자막 시각은 video_subs::shift_cues가 이미 옮겼다).
    let soft = match doc.subs {
        Some(SubsFile::Soft { srt }) => {
            a.extend(["-i".into(), srt.display().to_string()]);
            true
        }
        _ => false,
    };
    let burn = matches!(doc.subs, Some(SubsFile::Burn { .. }));
    // 문서가 있으면 자동 선택 대신 명시 매핑 — 자동 선택은 문서가 전사한 오디오 트랙(다중 트랙의 "가장 좋은" 트랙이
    // 아닐 수 있다)도, 자막 입력도 모른다.
    let a_stream = doc.audio_stream.map_or_else(|| "0:a".to_string(), |n| format!("0:a:{n}"));
    let explicit = doc.audio_stream.is_some() || soft;
    let audio_in = spec.has_audio && !spec.remove_audio;

    let audio_only = matches!(ext.as_str(), "m4a" | "mp3");
    let speed = spec.speed.unwrap_or(1.0);
    let speeding = (speed - 1.0).abs() > f64::EPSILON;

    if spec.mode == "copy" {
        if audio_only {
            a.extend(["-vn".into(), "-c:a".into(), "copy".into()]);
        } else if explicit {
            a.extend(["-map".into(), "0:v:0".into()]);
            if audio_in {
                a.extend(["-map".into(), format!("{a_stream}?")]);
            }
            if soft {
                // -c copy 뒤의 더 구체적인 -c:s가 자막 스트림에만 이긴다(SRT는 mp4에 복사로 못 담는다).
                a.extend(["-map".into(), "1".into(), "-c".into(), "copy".into(), "-c:s".into(), "mov_text".into()]);
            } else {
                a.extend(["-c".into(), "copy".into()]);
            }
        } else {
            a.extend(["-c".into(), "copy".into()]);
            if spec.remove_audio {
                a.push("-an".into());
            }
        }
        a.extend(["-avoid_negative_ts".into(), "make_zero".into()]);
    } else {
        // 체인 순서: 대본 컷 → 마스크 → crop → scale → 자막 번인 → setpts(§3.6-2). 마스크는 원본 좌표계라 crop보다
        // 먼저, 자막은 scale 뒤(글자 크기가 출력 해상도 기준)·setpts 앞(자막 시각이 배속 전 타임라인)이다.
        let cut_graph = cut.map(|k| build_cut_graph(k, audio_in.then_some(a_stream.as_str())));
        let v0 = if cut_graph.is_some() { "[vc]" } else { "[0:v]" };
        let mask = build_mask_graph(spec, v0);
        let vin = mask.as_ref().map_or(v0, |(_, l)| l.as_str());
        let mprefix: String =
            cut_graph.iter().chain(mask.as_ref().map(|(g, _)| g)).map(|g| format!("{g};")).collect();

        // 비디오 필터 체인: crop → scale → subtitles → setpts (→ gif면 fps/scale/palette).
        let mut vf: Vec<String> = Vec::new();
        if let Some(c) = &spec.crop {
            let (x, y, w, h) = evenize(c);
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
        if let Some(mh) = spec.max_height {
            // min(mh, ih) — 업스케일 방지. 필터 인자 안 콤마는 이스케이프.
            vf.push(format!("scale=-2:min({mh}\\,ih)"));
        }
        if burn {
            // 상수 — ASS 경로·자막 텍스트는 필터 문자열에 들어오지 않는다(ffmpeg cwd = ASS 폴더, stt/video_subs.rs).
            vf.push(BURN_FILTER.into());
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
            if mask.is_some() || cut_graph.is_some() {
                // filter_complex를 쓰면 자동 스트림 선택이 꺼진다 — 오디오도 명시로 매핑한다.
                let chain = if vf.is_empty() { "null".to_string() } else { vf.join(",") };
                let mut graph = format!("{mprefix}{vin}{chain}[v]");
                // 컷 오디오는 그래프 출력([ac])이라 -af를 함께 걸 수 없다 — 배속도 그래프 안에서.
                let amap = match (audio_in, cut_graph.is_some()) {
                    (false, _) => None,
                    (true, false) => Some(format!("{a_stream}?")),
                    (true, true) if speeding => {
                        graph.push_str(&format!(";[ac]{}[a]", atempo_chain(speed)));
                        Some("[a]".to_string())
                    }
                    (true, true) => Some("[ac]".to_string()),
                };
                a.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into()]);
                if let Some(m) = amap {
                    a.extend(["-map".into(), m]);
                }
            } else {
                if !vf.is_empty() {
                    a.extend(["-vf".into(), vf.join(",")]);
                }
                if explicit {
                    a.extend(["-map".into(), "0:v:0".into()]);
                    if audio_in {
                        a.extend(["-map".into(), format!("{a_stream}?")]);
                    }
                }
            }
            if soft {
                a.extend(["-map".into(), "1".into()]);
            }
            a.extend([
                "-c:v".into(), "libx264".into(),
                "-crf".into(), spec.crf.unwrap_or(23).to_string(),
                "-preset".into(), "veryfast".into(),
                "-pix_fmt".into(), "yuv420p".into(),
            ]);
            if audio_in {
                a.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
                if speeding && cut_graph.is_none() {
                    a.extend(["-af".into(), atempo_chain(speed)]);
                }
            } else {
                a.push("-an".into());
            }
            if soft {
                a.extend(["-c:s".into(), "mov_text".into()]);
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

/// 출력 프레임 크기(번인 ASS의 PlayResX/Y) — 인자 빌더와 같은 규칙: crop(짝수 내림) → `scale=-2:min(mh,ih)`
/// (-2 = 비율 유지 짝수 폭, ffmpeg는 `round(h·iw/ih/2)·2`). `src_w/h`는 probe의 표시 기준 크기(회전 반영).
fn export_out_size(src_w: u32, src_h: u32, spec: &ExportSpec) -> (u32, u32) {
    let (w, h) = spec.crop.as_ref().map_or((src_w, src_h), |c| {
        let (_, _, w, h) = evenize(c);
        (w, h)
    });
    match spec.max_height {
        Some(mh) if h > 0 => {
            let oh = h.min(mh);
            let ow = ((f64::from(oh) * f64::from(w) / f64::from(h) / 2.0).round() as u32 * 2).max(2);
            (ow, oh)
        }
        _ => (w.max(1), h.max(1)),
    }
}

/// 자막 입힌 영상(§3.6 4~6)의 자막 파일 — 번인은 libass 확인·출력 크기 계산 뒤 ASS 폴더, 소프트는 SRT.
async fn caption_subs_file(
    app: &AppHandle,
    bin: &FfmpegBin,
    src: &str,
    spec: &ExportSpec,
    subs: &CaptionSubs,
    loaded: &crate::stt::store::CaptionLoaded,
) -> Result<(SubsFile, crate::stt::transcribe::TempFiles), IpcError> {
    use crate::stt::video_subs::{export_cues, write_burn_ass, write_soft_srt};
    let cues = export_cues(loaded, subs, spec.range, spec.speed.unwrap_or(1.0))?;
    match subs.mode {
        SubsMode::Soft => write_soft_srt(app, &cues),
        SubsMode::Burn => {
            if !has_subtitles_filter(&bin.ffmpeg).await? {
                return Err(IpcError::new(
                    ErrorCode::ToolNotFound,
                    format!(
                        "이 ffmpeg({})에는 자막 번인 필터(libass `subtitles`)가 없습니다 — 소프트 자막으로 내보내거나 libass가 든 ffmpeg를 쓰세요",
                        bin.ffmpeg.display()
                    ),
                ));
            }
            let meta = probe_meta(&need_probe(bin)?, src).await?;
            if !meta.has_video {
                return Err(IpcError::new(ErrorCode::Io, "영상 트랙이 없는 파일에는 자막을 입힐 수 없습니다"));
            }
            let (w, h) = export_out_size(meta.width, meta.height, spec);
            write_burn_ass(app, &cues, subs.preset, w, h)
        }
    }
}

/// 예상 출력 길이(µs) — 진행률 분모. 배속 재인코딩은 출력이 D/speed로 줄어든다. 대본 컷이면 D = Σkeep.
fn expected_out_us(spec: &ExportSpec, cut: Option<&[RangeMs]>) -> u64 {
    let base_ms = match (cut, &spec.range) {
        (Some(k), _) => k.iter().map(|r| r.end_ms.saturating_sub(r.start_ms)).sum(),
        (None, Some(r)) => r.end_ms.saturating_sub(r.start_ms),
        (None, None) => spec.duration_ms,
    };
    let speed = if spec.mode == "encode" { spec.speed.unwrap_or(1.0) } else { 1.0 };
    ((base_ms as f64) * 1000.0 / speed.max(0.01)) as u64
}

/// 인라인 한도를 넘는 `-filter_complex` 그래프 값의 인자 위치.
fn long_graph_at(args: &[String]) -> Option<usize> {
    let i = args.iter().position(|a| a == "-filter_complex")? + 1;
    (args.get(i)?.len() > INLINE_GRAPH_MAX).then_some(i)
}

/// `-filter_complex <그래프>` → `-/filter_complex <파일>`(옵션 값을 파일에서 읽는 ffmpeg 7.0+ 문법, 부록 B.2 —
/// `-filter_complex_script`는 gyan 9.0.1에서 사라져 쓰지 않는다). 파일에 쓸 그래프를 돌려준다.
fn externalize_graph(args: &mut [String], at: usize, file: &Path) -> String {
    args[at - 1] = "-/filter_complex".into();
    std::mem::replace(&mut args[at], file.display().to_string())
}

/// `parse_version` 결과가 `-/` 문법(7.0+)을 아는 ffmpeg인가. Arch식 "n7.1"도 읽는다. 못 읽는 버전(git 빌드 "N")은
/// 최근 빌드라 시도한다 — 틀렸다면 ffmpeg가 "Unrecognized option"으로 스스로 말한다.
fn graph_file_supported(version: Option<&str>) -> bool {
    version
        .map(|v| v.trim_start_matches('n'))
        .and_then(|v| v.split('.').next()?.parse::<u32>().ok())
        .map_or(true, |major| major >= 7)
}

/// 긴 그래프를 앱 로컬 데이터 `stt/` 임시 파일로 넘긴다(전사 임시 파일과 같은 고아 청소를 탄다).
/// 돌려준 가드가 잡이 어떻게 끝나든 파일을 지운다.
async fn graph_to_file(
    app: &AppHandle,
    ffmpeg: &Path,
    args: &mut [String],
    at: usize,
) -> Result<crate::stt::transcribe::TempFiles, IpcError> {
    use crate::stt::transcribe::{temp_dir, TempFiles, TEMP_PREFIX};
    let io = |m: String| IpcError::new(ErrorCode::Io, m);
    // -version 실행 실패는 삼키고 시도한다 — 여기서 막으면 뒤따를 ffmpeg의 진짜 오류를 가린다.
    let version = run_capture(ffmpeg, &["-version"], 5)
        .await
        .ok()
        .and_then(|(_, out, _)| parse_version(out.lines().next().unwrap_or("")));
    if !graph_file_supported(version.as_deref()) {
        return Err(IpcError::new(
            ErrorCode::TooManyRanges,
            format!(
                "남길 구간이 너무 많아 명령줄에 다 들어가지 않고, ffmpeg {}는 그래프 파일을 읽지 못합니다(7.0 이상 필요) — 무음 줄이기 목표를 늘려 구간을 줄이거나 ffmpeg 7 이상을 쓰세요",
                version.as_deref().unwrap_or("?")
            ),
        ));
    }
    let file = temp_dir(app)?.join(format!("{TEMP_PREFIX}graph-{}.txt", uuid::Uuid::new_v4().simple()));
    let graph = externalize_graph(args, at, &file);
    let guard = TempFiles(vec![file.clone()]);
    std::fs::write(&file, graph).map_err(|e| io(format!("필터 그래프 파일 쓰기 실패({}): {e}", file.display())))?;
    Ok(guard)
}

/// `-progress pipe:1` 라인 파싱. ffmpeg의 out_time_ms는 이름과 달리 **µs**다(알려진 버그,
/// out_time_us와 항상 같은 값) — 둘 다 µs로 읽는다.
pub(crate) fn parse_out_time_us(line: &str) -> Option<u64> {
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

/// libass가 어떤 글꼴에서도 찾지 못한 글자 — 번인 영상에 네모 칸으로 그려지는데 ffmpeg는 그래도 0으로 끝난다
/// (2026-09-22 실측: CJK 글꼴이 없는 Ubuntu(WSL) + 관리형 johnvansickle 7.0.2에서 `Noto Sans CJK KR` → DejaVu Sans,
/// 한글 전부 네모 칸). libass 경고 `fontselect: failed to find any fallback with glyph 0xC790 for font: (…)`에서 뽑는다.
fn burn_missing_glyphs(stderr: &str) -> Vec<char> {
    let mut out: Vec<char> = stderr
        .lines()
        .filter_map(|l| l.split_once("failed to find any fallback with glyph 0x"))
        .filter_map(|(_, rest)| {
            let hex: String = rest.chars().take_while(char::is_ascii_hexdigit).collect();
            char::from_u32(u32::from_str_radix(&hex, 16).ok()?)
        })
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// stderr에서 사람이 읽을 마지막 오류 줄을 뽑는다.
pub(crate) fn last_error_line(stderr: &str) -> String {
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
    // 아래 성공 경로의 rename(tmp → out)이 **원본을 덮는다**. 존재하는 out은 정규화 비교.
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

    // 취소 등록은 spawn **전**, 느린 준비 단계(번인 ffprobe·필터 확인, 그래프 파일의 -version)보다도 앞 — invoke 응답이
    // 유실돼도 이미 등록된 id로 취소 가능하고(http.rs 정책), 준비 중에 누른 취소도 버려지지 않는다(아래 select!가
    // 이미 와 있는 신호를 spawn 직후 받는다, 태스크 72 9절 56과 같은 이유).
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

    // 대본 편집본·자막 입힌 영상 — 남길 구간·자막은 저장된 자막 문서로 여기서 계산한다(§3.4: IPC로 받지 않는다).
    let caption = if spec.caption_cut || spec.caption_subs.is_some() {
        Some(crate::stt::store::load_export_doc(app, project_id, &spec.src_rel, &src, spec.caption_cut)?)
    } else {
        None
    };
    let cut = caption.as_ref().filter(|_| spec.caption_cut).map(|l| l.plan.keep.as_slice());
    let src_s = src.display().to_string();
    // 문서가 전사한 오디오 트랙이 지금 파일에 없으면 거절한다 — `-map 0:a:<n>?`의 `?`가 없는 트랙을 말없이 건너뛰어
    // 소리 없는 영상이 "성공"한다. 원본을 바꿔 끼운 stale 문서(원본 시각 자막은 stale도 받는다, 9절 72)에서만
    // 생긴다 — 같은 파일이면 전사할 때 트랙 범위를 확인했다(stt/transcribe.rs).
    if let Some(l) = caption.as_ref().filter(|l| l.stale && spec.has_audio && !spec.remove_audio) {
        let tracks = probe_meta(&need_probe(&bin)?, &src_s).await?.audio_streams.len();
        let n = l.doc.source.audio_stream;
        if n as usize >= tracks {
            return Err(IpcError::new(
                ErrorCode::Io,
                format!(
                    "자막을 만든 오디오 트랙 {}번이 이 파일에 없습니다(오디오 트랙 {tracks}개) — 원본이 바뀌었습니다. 대본에서 다시 인식하거나 소리 빼기로 내보내세요",
                    n + 1
                ),
            ));
        }
    }
    // 가드(`_`로 버리지 않는다)가 잡이 끝날 때 자막 임시 파일을 지운다.
    let subs_file = match (&spec.caption_subs, &caption) {
        (Some(cs), Some(loaded)) => Some(caption_subs_file(app, &bin, &src_s, spec, cs, loaded).await?),
        _ => None,
    };
    let doc_in = DocInputs {
        keep: cut,
        audio_stream: caption.as_ref().map(|l| l.doc.source.audio_stream),
        subs: subs_file.as_ref().map(|(f, _)| f),
    };

    // 산출물은 임시 이름으로 쓰고 성공 시 rename — 실패·취소가 기존 파일을 파괴하지 않게.
    let tmp = out.with_file_name(format!(".gpv-export-{job_id}.tmp"));
    let mut args = build_export_args(&src_s, &tmp.display().to_string(), spec, &doc_in);
    let _graph_file = match long_graph_at(&args) {
        Some(at) => Some(graph_to_file(app, &bin.ffmpeg, &mut args, at).await?),
        None => None,
    };

    let mut cmd = Command::new(&bin.ffmpeg);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some((SubsFile::Burn { dir }, _)) = &subs_file {
        // 번인 필터가 상대 이름(subs.ass)으로 읽는다 — 입·출력은 절대 경로라 cwd와 무관하다.
        cmd.current_dir(dir);
    }
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
    let expected_us = expected_out_us(spec, cut);
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

    // stderr 수집(오류 진단용) — 마지막 8KB만 유지. 번인이 못 그린 글자는 앞쪽에 찍히므로 잘라 내기 전에 전체에서 찾는다.
    let stderr = child.stderr.take();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let Some(stderr) = stderr else { return (String::new(), Vec::new()) };
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let _ = tokio::io::BufReader::new(stderr).read_to_end(&mut buf).await;
        let missing = burn_missing_glyphs(&String::from_utf8_lossy(&buf));
        let start = buf.len().saturating_sub(8 * 1024);
        (String::from_utf8_lossy(&buf[start..]).into_owned(), missing)
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
    let (stderr_tail, missing_glyphs) = stderr_task.await.unwrap_or_default();
    let _ = progress_task.await;
    let status = match status_res {
        Ok(s) => s,
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            return Err(e);
        }
    };
    let burned = matches!(subs_file, Some((SubsFile::Burn { .. }, _)));

    if cancelled {
        std::fs::remove_file(&tmp).ok();
        Err(IpcError::new(ErrorCode::Cancelled, "내보내기가 취소되었습니다"))
    } else if status.success() && burned && !missing_glyphs.is_empty() {
        // ffmpeg는 성공으로 끝나지만 그 글자들은 네모 칸으로 그려졌다 — 그런 영상을 결과로 남기지 않는다.
        std::fs::remove_file(&tmp).ok();
        let shown = missing_glyphs.iter().take(12).map(|c| format!("'{c}'")).collect::<Vec<_>>().join(" ");
        Err(IpcError {
            code: ErrorCode::ToolNotFound,
            message: format!(
                "자막 글꼴에 없는 글자 {}개가 네모 칸으로 그려져 내보내지 않았습니다({shown}) — '{}' 글꼴(Linux: fonts-noto-cjk 패키지)을 설치하거나 소프트 자막으로 내보내세요",
                missing_glyphs.len(),
                crate::stt::video_subs::caption_font()
            ),
            stderr: Some(stderr_tail),
        })
    } else if status.success() {
        commit_tmp_output(&tmp, &out)
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
    commit_tmp_output(&tmp, &out)
}

/// 임시 산출물 → 최종 이름(내보내기·프레임 캡처·자막 파일). rename 한 번이 세 OS 모두 기존 파일을 바꾼다 — Windows도
/// std가 MoveFileExW(REPLACE_EXISTING)/POSIX 교체로 덮는다(state.rs `save_bytes_at`이 같은 전제). **먼저 지우지 않는다**:
/// 지운 뒤 rename이 실패하면(백신·인덱서가 새 임시 파일을 공유 삭제 없이 잡음) 옛 파일과 새 파일을 둘 다 잃는다.
/// 실패하면 임시 파일만 지운다.
pub(crate) fn commit_tmp_output(tmp: &Path, out: &Path) -> Result<(), IpcError> {
    std::fs::rename(tmp, out).map_err(|e| {
        std::fs::remove_file(tmp).ok(); // 정리 실패는 원래 오류를 가리지 않는다
        IpcError::new(ErrorCode::Io, format!("산출물 이동 실패({}): {e}", out.display()))
    })
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
        // gyan.dev essentials — ffmpeg/ffprobe 포함, ~111MB. "버전 고정 URL은 불변"이라 믿었지만 9.0.2가 나오자
        // gyan.dev/packages 의 9.0.1이 404가 됐다(2026-09-22 실측) — 새 Windows 사용자가 ffmpeg를 못 받고 있었다.
        // 같은 파일(sha256 동일)이 gyan 공식 GitHub 미러에 태그별로 남으므로 그쪽을 먼저 시도한다.
        Some(FfmpegSpec {
            version: "9.0.1",
            artifacts: &[FfArtifact {
                urls: &[
                    "https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip",
                    "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.1-essentials_build.zip",
                ],
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
            caption_cut: false,
            caption_subs: None,
        }
    }

    fn cut_spec() -> ExportSpec {
        ExportSpec { mode: "encode".into(), out_rel: "a.cut.mp4".into(), caption_cut: true, ..base_spec() }
    }

    fn cut_in(k: &[RangeMs]) -> DocInputs<'_> {
        DocInputs { keep: Some(k), ..Default::default() }
    }

    fn subs_spec(mode: SubsMode, timeline: SubTimeline) -> CaptionSubs {
        CaptionSubs {
            mode,
            timeline,
            text: SubText::Caption,
            lang: None,
            preset: crate::stt::video_subs::CaptionStylePreset::Basic,
        }
    }

    /// 번인·자막 없는 재인코딩 스펙(원본 시각).
    fn burn_spec() -> ExportSpec {
        ExportSpec {
            mode: "encode".into(),
            out_rel: "a.sub.mp4".into(),
            caption_subs: Some(subs_spec(SubsMode::Burn, SubTimeline::Source)),
            ..base_spec()
        }
    }

    fn vfilter(a: &[String]) -> String {
        a.iter()
            .position(|x| x == "-vf" || x == "-filter_complex")
            .map(|i| a[i + 1].clone())
            .unwrap_or_else(|| panic!("필터 없음: {a:?}"))
    }

    /// 번인 체인: (컷 →) 마스크 → crop → scale → subtitles → setpts. 자막은 scale 뒤(출력 해상도 기준 글자 크기)·
    /// setpts 앞(배속 전 시각). 마스크·컷이 없으면 -vf + 문서 오디오 트랙 명시 매핑.
    #[test]
    fn caption_subs_burn_chain_order() {
        let burn = SubsFile::Burn { dir: PathBuf::from("/data/stt/gpv-stt-burn-x") };
        let mut s = burn_spec();
        s.crop = Some(CropRect { x: 0, y: 0, w: 640, h: 480 });
        s.max_height = Some(360);
        s.speed = Some(2.0);
        let doc = DocInputs { audio_stream: Some(1), subs: Some(&burn), ..Default::default() };
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &doc);
        assert_eq!(value_after(&a, "-vf"), "crop=640:480:0:0,scale=-2:min(360\\,ih),subtitles=f=subs.ass,setpts=PTS/2");
        assert_eq!(maps(&a), vec!["0:v:0", "0:a:1?"], "문서가 전사한 오디오 트랙");
        assert_eq!(value_after(&a, "-af"), "atempo=2");
        assert!(!a.iter().any(|x| x == "-c:s"), "번인은 자막 스트림이 없다");

        // 마스크 + 컷: concat → mask → crop → scale → subtitles → setpts, 컷 오디오도 문서 트랙.
        let mut c = ExportSpec { caption_cut: true, ..s.clone() };
        c.caption_subs = Some(subs_spec(SubsMode::Burn, SubTimeline::Edited));
        c.masks = Some(vec![CropRect { x: 10, y: 10, w: 64, h: 64 }]);
        let k = keep(&[(0, 1000), (2000, 3000)]);
        let doc = DocInputs { keep: Some(&k), audio_stream: Some(1), subs: Some(&burn) };
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &c, &doc);
        let fc = value_after(&a, "-filter_complex");
        let at = |needle: &str| fc.find(needle).unwrap_or_else(|| panic!("{needle} 없음: {fc}"));
        assert!(at("concat=n=2") < at("[vc]split=2"), "fc={fc}");
        assert!(at("[vc]split") < at("crop=640:480"), "fc={fc}");
        assert!(at("crop=640:480") < at("scale=-2") && at("scale=-2") < at(BURN_FILTER), "fc={fc}");
        assert!(at(BURN_FILTER) < at("setpts=PTS/2[v]"), "fc={fc}");
        assert!(fc.contains("[0:a:1]atrim=start=0.000000"), "fc={fc}");
        assert!(!fc.contains("[0:a]"), "fc={fc}");
    }

    /// **반증**: 번인·소프트 자막 어디에서도 필터 문자열에 경로·사용자 텍스트가 들어가지 않는다. 입력·출력·자막 파일
    /// 경로는 argv 원소 하나 그대로이고, 필터에 있는 자막 항목은 상수 하나뿐이다. 경로를 필터에 넣도록 바꾸면
    /// (예: `subtitles=f='C\:/…/subs.ass'`) 여기서 빨개진다.
    #[test]
    fn caption_subs_filter_carries_no_path_or_text() {
        let src = r"C:\Users\홍길동\영상's clip, [1];a.mp4";
        let tmp = r"C:\Users\홍길동\.gpv-export-x.tmp";
        let dir = PathBuf::from(r"C:\Users\홍길동\AppData\Local\app\stt\gpv-stt-burn-0123");
        let evil = "'; [0:v]drawtext=text=pwn,subtitles=f=C\\:/x.ass {\\an8}";
        let ass = crate::stt::video_subs::build_ass(
            &[crate::stt::plan::OutCue { cue_id: "c1".into(), start_ms: 0, end_ms: 900, text: evil.into() }],
            crate::stt::video_subs::CaptionStylePreset::Box,
            640,
            360,
        );
        assert!(!ass.contains("{\\an8}"), "ASS 본문의 태그가 살아 있다: {ass}");

        let burn = SubsFile::Burn { dir: dir.clone() };
        let srt = PathBuf::from(r"C:\Users\홍길동\AppData\Local\app\stt\gpv-stt-subs-0123.srt");
        let soft = SubsFile::Soft { srt: srt.clone() };
        let k = keep(&[(0, 1000), (2000, 3000)]);
        let masked = ExportSpec { masks: Some(vec![CropRect { x: 0, y: 0, w: 32, h: 32 }]), ..burn_spec() };
        let cut_burn = ExportSpec {
            caption_cut: true,
            caption_subs: Some(subs_spec(SubsMode::Burn, SubTimeline::Edited)),
            ..burn_spec()
        };
        let soft_copy = ExportSpec {
            mode: "copy".into(),
            range: Some(RangeMs { start_ms: 1000, end_ms: 4000 }),
            caption_subs: Some(subs_spec(SubsMode::Soft, SubTimeline::Source)),
            ..burn_spec()
        };
        let cases: [(&ExportSpec, DocInputs); 4] = [
            (&burn_spec(), DocInputs { audio_stream: Some(0), subs: Some(&burn), ..Default::default() }),
            (&masked, DocInputs { audio_stream: Some(0), subs: Some(&burn), ..Default::default() }),
            (&cut_burn, DocInputs { keep: Some(&k), audio_stream: Some(0), subs: Some(&burn) }),
            (&soft_copy, DocInputs { audio_stream: Some(0), subs: Some(&soft), ..Default::default() }),
        ];
        let srt_s = srt.display().to_string();
        for (spec, doc) in cases {
            let a = build_export_args(src, tmp, spec, &doc);
            let joined = a.join("\u{1}");
            assert!(!joined.contains(evil) && !joined.contains("drawtext"), "사용자 텍스트가 인자에 있다: {a:?}");
            for p in [src, tmp, srt_s.as_str()] {
                let whole = a.iter().filter(|x| x.as_str() == p).count();
                let partial = a.iter().filter(|x| x.contains(p)).count();
                assert_eq!(whole, partial, "{p} 가 다른 인자 안에 섞였다: {a:?}");
            }
            assert_eq!(a.iter().filter(|x| x.as_str() == src).count(), 1);
            for flag in ["-vf", "-filter_complex"] {
                if let Some(i) = a.iter().position(|x| x == flag) {
                    let f = &a[i + 1];
                    assert!(f.is_ascii(), "필터에 비ASCII(경로·텍스트) {f}");
                    assert!(!f.contains("홍길동") && !f.contains(":/") && !f.contains(":\\") && !f.contains('\''), "{f}");
                    // "subtitles"·".ass"는 전부 상수 안에서만 나온다.
                    let consts = f.matches(BURN_FILTER).count();
                    assert_eq!(f.matches("subtitles").count(), consts, "번인 항목이 상수가 아니다: {f}");
                    assert_eq!(f.matches(".ass").count(), consts, "{f}");
                }
            }
            if matches!(doc.subs, Some(SubsFile::Burn { .. })) {
                assert_eq!(vfilter(&a).matches(BURN_FILTER).count(), 1, "{a:?}");
                assert!(!joined.contains(&dir.display().to_string()), "번인 폴더는 argv가 아니라 cwd로 간다: {a:?}");
            }
        }
    }

    /// 소프트 자막: 입력 1번 SRT(구간 -ss/-t는 입력 0에만) · 명시 매핑 0:v:0 · 문서 오디오 · 1 · `-c:s mov_text`.
    /// 무손실 복사와 함께 되고(`-c copy` 뒤 `-c:s`), 컷 그래프와도 된다.
    #[test]
    fn caption_subs_soft_maps_subtitle_input() {
        let soft = SubsFile::Soft { srt: PathBuf::from("/data/stt/gpv-stt-subs-x.srt") };
        let copy = ExportSpec {
            mode: "copy".into(),
            range: Some(RangeMs { start_ms: 1000, end_ms: 4000 }),
            caption_subs: Some(subs_spec(SubsMode::Soft, SubTimeline::Source)),
            ..burn_spec()
        };
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &copy, &DocInputs { audio_stream: Some(2), subs: Some(&soft), ..Default::default() });
        let inputs: Vec<usize> = a.iter().enumerate().filter(|(_, x)| *x == "-i").map(|(i, _)| i).collect();
        assert_eq!(inputs.len(), 2);
        assert_eq!((a[inputs[0] + 1].as_str(), a[inputs[1] + 1].as_str()), ("/r/a.mp4", "/data/stt/gpv-stt-subs-x.srt"));
        let ss = a.iter().position(|x| x == "-ss").unwrap();
        assert!(ss < inputs[0], "구간 탐색은 입력 0 앞");
        assert_eq!(maps(&a), vec!["0:v:0", "0:a:2?", "1"]);
        let (c, cs) = (a.iter().position(|x| x == "-c").unwrap(), a.iter().position(|x| x == "-c:s").unwrap());
        assert!(c < cs && a[c + 1] == "copy" && a[cs + 1] == "mov_text", "{a:?}");
        assert!(validate_spec(&copy).is_ok(), "소프트 자막은 무손실 복사와 된다");

        // 재인코딩 + 소리 빼기: 오디오 매핑 없이 -an, 자막은 그대로.
        let enc = ExportSpec { mode: "encode".into(), remove_audio: true, range: None, ..copy.clone() };
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &enc, &DocInputs { audio_stream: Some(0), subs: Some(&soft), ..Default::default() });
        assert_eq!(maps(&a), vec!["0:v:0", "1"]);
        assert!(a.iter().any(|x| x == "-an") && value_after(&a, "-c:s") == "mov_text");
        assert!(!a.iter().any(|x| x == "-vf"), "자막 스트림은 필터가 아니다: {a:?}");

        // 컷 그래프 + 소프트: [v]·[ac]·1.
        let k = keep(&[(0, 1000), (2000, 3000)]);
        let cut = ExportSpec {
            caption_cut: true,
            caption_subs: Some(subs_spec(SubsMode::Soft, SubTimeline::Edited)),
            ..cut_spec()
        };
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &cut, &DocInputs { keep: Some(&k), audio_stream: Some(0), subs: Some(&soft) });
        assert_eq!(maps(&a), vec!["[v]", "[ac]", "1"]);
        assert!(value_after(&a, "-filter_complex").contains("[0:a:0]atrim"));
    }

    /// 자막 입힌 영상의 스펙 규칙: 영상 컨테이너만 · 번인은 재인코딩만 · 편집본 시각 ⇔ caption_cut · 번역은 언어 필수.
    #[test]
    fn caption_subs_validate_rules() {
        assert!(validate_spec(&burn_spec()).is_ok());
        let burn_copy = ExportSpec { mode: "copy".into(), ..burn_spec() };
        assert!(validate_spec(&burn_copy).unwrap_err().message.contains("재인코딩"));
        for out in ["a.gif", "a.m4a", "a.mp3"] {
            assert!(validate_spec(&ExportSpec { out_rel: out.into(), ..burn_spec() }).is_err(), "{out}");
        }
        assert!(validate_spec(&ExportSpec { out_rel: "a.sub.mov".into(), ..burn_spec() }).is_ok());
        let edited_no_cut = ExportSpec { caption_subs: Some(subs_spec(SubsMode::Burn, SubTimeline::Edited)), ..burn_spec() };
        assert!(validate_spec(&edited_no_cut).unwrap_err().message.contains("편집본"));
        let source_with_cut = ExportSpec { caption_subs: Some(subs_spec(SubsMode::Soft, SubTimeline::Source)), ..cut_spec() };
        assert!(validate_spec(&source_with_cut).is_err());
        let edited_cut = ExportSpec { caption_subs: Some(subs_spec(SubsMode::Burn, SubTimeline::Edited)), ..cut_spec() };
        assert!(validate_spec(&edited_cut).is_ok());
        let mut tr = subs_spec(SubsMode::Soft, SubTimeline::Source);
        tr.text = SubText::Both;
        assert!(validate_spec(&ExportSpec { caption_subs: Some(tr.clone()), ..burn_spec() }).is_err());
        tr.lang = Some("en".into());
        assert!(validate_spec(&ExportSpec { caption_subs: Some(tr), ..burn_spec() }).is_ok());
    }

    /// 번인 PlayRes = 출력 크기 — crop(짝수) → scale(-2:min(mh,ih)), 업스케일 없음.
    #[test]
    fn export_out_size_follows_crop_and_scale() {
        let s = burn_spec();
        assert_eq!(export_out_size(1920, 1080, &s), (1920, 1080));
        assert_eq!(export_out_size(1920, 1080, &ExportSpec { max_height: Some(720), ..s.clone() }), (1280, 720));
        assert_eq!(export_out_size(1920, 1080, &ExportSpec { max_height: Some(2160), ..s.clone() }), (1920, 1080));
        let crop = ExportSpec { crop: Some(CropRect { x: 1, y: 1, w: 1001, h: 501 }), max_height: Some(360), ..s.clone() };
        assert_eq!(export_out_size(1920, 1080, &crop), (720, 360));
        assert_eq!(export_out_size(1080, 1920, &ExportSpec { max_height: Some(1280), ..s }), (720, 1280), "세로 영상");
    }

    /// 번인이 못 그린 글자 = libass fallback 실패 경고(실측 stderr 그대로). 다른 줄·중복은 무시.
    #[test]
    fn burn_missing_glyphs_parses_libass_fallback_failures() {
        let stderr = "[Parsed_subtitles_0 @ 0x730fc4003100] Using font provider fontconfig\n\
            [Parsed_subtitles_0 @ 0x730fc4003100] fontselect: (Noto Sans CJK KR, 400, 0) -> /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf, 0, DejaVuSans\n\
            [Parsed_subtitles_0 @ 0x730fc4003100] Glyph 0xC790 not found, selecting one more font for (Noto Sans CJK KR, 400, 0)\n\
            [Parsed_subtitles_0 @ 0x730fc4003100] fontselect: failed to find any fallback with glyph 0xC790 for font: (Noto Sans CJK KR, 400, 0)\n\
            [Parsed_subtitles_0 @ 0x730fc4003100] fontselect: failed to find any fallback with glyph 0xB9C9 for font: (Noto Sans CJK KR, 400, 0)\n\
            [Parsed_subtitles_0 @ 0x730fc4003100] fontselect: failed to find any fallback with glyph 0xC790 for font: (Noto Sans CJK KR, 700, 0)\n";
        assert_eq!(burn_missing_glyphs(stderr), vec!['막', '자']);
        assert!(burn_missing_glyphs("[Parsed_subtitles_0 @ 0x1] Using font provider directwrite\n").is_empty());
    }

    /// `-filters` 목록에서 이름 칸만 본다(설명 속 단어·`ass`와 헷갈리지 않게).
    #[test]
    fn filters_listing_detects_subtitles() {
        let with = "Filters:\n  T.. = Timeline support\n ... ass               V->V       Render ASS subtitles onto input video using the libass library.\n ..C subtitles         V->V       Render text subtitles onto input video using the libass library.\n";
        assert!(filters_list_has(with, "subtitles"));
        let without = "Filters:\n ... ass               V->V       Render ASS subtitles onto input video.\n ... scale             V->V       Scale the input video size and/or convert the image format.\n";
        assert!(!filters_list_has(without, "subtitles"), "설명 속 'subtitles'는 필터가 아니다");
        assert!(!filters_list_has("", "subtitles"));
    }

    /// probe의 오디오 트랙 목록 — 오디오 스트림 안 순번(`0:a:<n>`), 코덱·채널·언어·제목. 영상·자막 스트림은 세지 않는다.
    #[test]
    fn probe_lists_audio_streams_in_order() {
        let json = r#"{"streams":[
            {"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30/1"},
            {"codec_type":"audio","codec_name":"aac","channels":2,"tags":{"language":"kor","title":"데스크톱"}},
            {"codec_type":"subtitle","codec_name":"mov_text"},
            {"codec_type":"audio","codec_name":"opus","channels":1}
          ],"format":{"duration":"3.0"}}"#;
        let m = parse_probe(json).unwrap();
        assert_eq!(
            m.audio_streams,
            vec![
                AudioStreamInfo {
                    index: 0,
                    codec: Some("aac".into()),
                    channels: Some(2),
                    language: Some("kor".into()),
                    title: Some("데스크톱".into()),
                },
                AudioStreamInfo { index: 1, codec: Some("opus".into()), channels: Some(1), language: None, title: None },
            ]
        );
        assert_eq!(m.acodec.as_deref(), Some("aac"), "acodec은 첫 트랙 그대로");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["audioStreams"][1]["index"], 1, "TS 계약 camelCase");
    }

    /// rename 한 번이 기존 파일을 바꾼다(먼저 지우지 않아도 된다는 전제) · 실패하면 임시 파일만 지운다.
    #[test]
    fn commit_tmp_output_replaces_existing_and_cleans_tmp_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (tmp, out) = (dir.path().join(".t.tmp"), dir.path().join("a.srt"));
        std::fs::write(&out, "old").unwrap();
        std::fs::write(&tmp, "new").unwrap();
        commit_tmp_output(&tmp, &out).unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "new");
        assert!(!tmp.exists());

        let target_dir = dir.path().join("d.srt");
        std::fs::create_dir(&target_dir).unwrap();
        std::fs::write(&tmp, "new").unwrap();
        assert!(commit_tmp_output(&tmp, &target_dir).is_err());
        assert!(!tmp.exists(), "실패하면 임시 파일을 지운다");
        assert!(target_dir.is_dir());
    }

    /// 백신·인덱서가 새 임시 파일을 공유 삭제 없이 잡은 사이 교체가 실패해도 **기존 파일은 남는다**. 먼저 지우던
    /// 옛 순서는 여기서 옛 파일과 새 파일을 둘 다 잃었다(리뷰 후 수정).
    #[cfg(windows)]
    #[test]
    fn commit_tmp_output_keeps_existing_when_rename_is_blocked() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (tmp, out) = (dir.path().join(".t.tmp"), dir.path().join("a.srt"));
        std::fs::write(&out, "old").unwrap();
        std::fs::write(&tmp, "new").unwrap();
        // FILE_SHARE_READ만 — 다른 쪽의 삭제·이름 바꾸기를 막는다.
        let hold = std::fs::OpenOptions::new().read(true).share_mode(0x1).open(&tmp).unwrap();
        assert!(commit_tmp_output(&tmp, &out).is_err());
        drop(hold);
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "old", "기존 파일을 잃었다");
    }

    fn keep(v: &[(u64, u64)]) -> Vec<RangeMs> {
        v.iter().map(|&(start_ms, end_ms)| RangeMs { start_ms, end_ms }).collect()
    }

    fn value_after(a: &[String], flag: &str) -> String {
        a.iter().position(|x| x == flag).map(|i| a[i + 1].clone()).unwrap_or_else(|| panic!("{flag} 없음: {a:?}"))
    }

    fn maps(a: &[String]) -> Vec<&str> {
        a.windows(2).filter(|w| w[0] == "-map").map(|w| w[1].as_str()).collect()
    }

    /// 대본 컷: 입력 탐색(-ss/-t) 없이 구간마다 trim/atrim(+10ms 페이드) → concat=n=N. 초 값은 소수 6자리 숫자만.
    #[test]
    fn caption_cut_concats_keep_ranges_without_input_seek() {
        let s = cut_spec();
        let k = keep(&[(500, 1500), (2000, 2600), (4000, 5200)]);
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &cut_in(&k));
        assert!(!a.iter().any(|x| x == "-ss" || x == "-t"), "입력 탐색 금지: {a:?}");
        let fc = value_after(&a, "-filter_complex");
        assert!(fc.starts_with("[0:v]trim=start=0.500000:end=1.500000,setpts=PTS-STARTPTS[v0];"), "fc={fc}");
        assert!(
            fc.contains("[0:a]atrim=start=2.000000:end=2.600000,asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st=0.590000:d=0.01[a1]"),
            "fc={fc}"
        );
        assert!(fc.contains("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[vc][ac];[vc]null[v]"), "fc={fc}");
        assert_eq!(maps(&a), vec!["[v]", "[ac]"]);
        assert!(!a.iter().any(|x| x == "-af" || x == "-vf"), "그래프 출력에 -af/-vf를 함께 걸 수 없다: {a:?}");
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "aac"));
        // 필터 문자열의 초 값 = 숫자.6자리 — 경로·사용자 텍스트가 섞일 자리가 없다.
        for key in ["start=", "end=", "st="] {
            for part in fc.split(key).skip(1) {
                let v: String = part.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                let (int, frac) = v.split_once('.').unwrap_or_else(|| panic!("{key}{part}"));
                assert!(!int.is_empty() && frac.len() == 6, "{key}{v}");
            }
        }
        assert_eq!(fmt_secs6(0), "0.000000");
        assert_eq!(fmt_secs6(3_600_042), "3600.042000");
    }

    /// 오디오가 없거나 소리 빼기면 concat a=0 — atrim도 [ac]도 없고 -an.
    #[test]
    fn caption_cut_without_audio_concats_video_only() {
        let mut s = cut_spec();
        s.remove_audio = true;
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &cut_in(&keep(&[(0, 1000), (2000, 3000)])));
        let fc = value_after(&a, "-filter_complex");
        assert!(fc.contains("[v0][v1]concat=n=2:v=1:a=0[vc];[vc]null[v]"), "fc={fc}");
        assert!(!fc.contains("[0:a]") && !fc.contains("[ac]"), "fc={fc}");
        assert_eq!(maps(&a), vec!["[v]"]);
        assert!(a.iter().any(|x| x == "-an"));
    }

    /// 체인 순서 concat → mask → crop → scale → setpts, 마스크 입력 라벨은 [vc]. 배속 오디오는 그래프 안 atempo.
    #[test]
    fn caption_cut_chain_order_and_mask_input_label() {
        let mut s = cut_spec();
        s.masks = Some(vec![CropRect { x: 10, y: 10, w: 64, h: 64 }]);
        s.crop = Some(CropRect { x: 0, y: 0, w: 640, h: 480 });
        s.max_height = Some(360);
        s.speed = Some(2.0);
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &cut_in(&keep(&[(0, 1000), (2000, 3000)])));
        let fc = value_after(&a, "-filter_complex");
        let at = |needle: &str| fc.find(needle).unwrap_or_else(|| panic!("{needle} 없음: {fc}"));
        assert!(at("concat=n=2") < at("[vc]split=2[bg][s0]"), "fc={fc}");
        assert!(at("[vc]split") < at("[o0]crop=640:480:0:0"), "fc={fc}");
        assert!(at("crop=640:480") < at("scale=-2:min(360\\,ih)"), "fc={fc}");
        assert!(at("scale=-2") < at("setpts=PTS/2[v]"), "fc={fc}");
        assert!(!fc.contains("[0:v]split"), "마스크가 컷 전 원본을 받으면 잘린 부분이 되살아난다: {fc}");
        assert!(fc.ends_with(";[ac]atempo=2[a]"), "fc={fc}");
        assert_eq!(maps(&a), vec!["[v]", "[a]"]);
        assert!(!a.iter().any(|x| x == "-af"), "{a:?}");
        // 마스크만(컷 없음)은 예전처럼 원본 [0:v]에서 시작한다.
        let mut m = s.clone();
        m.caption_cut = false;
        let fc = value_after(&build_export_args("/r/a.mp4", "/r/.t.tmp", &m, &DocInputs::default()), "-filter_complex");
        assert!(fc.starts_with("[0:v]split=2[bg][s0];"), "fc={fc}");
    }

    /// 편집본은 재인코딩·영상 컨테이너 전용이고 range와 배타.
    #[test]
    fn caption_cut_validate_rejects_copy_range_and_non_video() {
        assert!(validate_spec(&cut_spec()).is_ok());
        assert!(validate_spec(&ExportSpec { out_rel: "a.cut.mov".into(), ..cut_spec() }).is_ok());
        let copy = ExportSpec { mode: "copy".into(), ..cut_spec() };
        assert!(validate_spec(&copy).unwrap_err().message.contains("재인코딩"));
        let ranged = ExportSpec { range: Some(RangeMs { start_ms: 0, end_ms: 1000 }), ..cut_spec() };
        assert!(validate_spec(&ranged).unwrap_err().message.contains("구간"));
        for out in ["a.gif", "a.m4a", "a.mp3"] {
            assert!(validate_spec(&ExportSpec { out_rel: out.into(), ..cut_spec() }).is_err(), "{out}");
        }
    }

    /// 진행률 분모 = Σkeep ÷ 배속.
    #[test]
    fn caption_cut_expected_output_is_sum_of_keep_over_speed() {
        let k = keep(&[(500, 1500), (2000, 2600), (4000, 5200)]);
        let mut s = cut_spec();
        assert_eq!(expected_out_us(&s, Some(&k)), 2_800_000);
        s.speed = Some(2.0);
        assert_eq!(expected_out_us(&s, Some(&k)), 1_400_000);
    }

    /// 인라인 24KB를 넘는 그래프는 `-/filter_complex <파일>`로(ffmpeg 7+), 짧으면 그대로. 7 미만은 TooManyRanges 대상.
    #[test]
    fn caption_cut_long_graph_falls_back_to_file() {
        let many: Vec<(u64, u64)> = (0..200).map(|i| (i * 180, i * 180 + 100)).collect();
        let mut a = build_export_args("/r/a.mp4", "/r/.t.tmp", &cut_spec(), &cut_in(&keep(&many)));
        let inline = value_after(&a, "-filter_complex");
        assert!(inline.len() > INLINE_GRAPH_MAX, "200구간 ≈ {}자", inline.len());
        let at = long_graph_at(&a).expect("긴 그래프");
        let file = Path::new("/data/stt/gpv-stt-graph-x.txt");
        let graph = externalize_graph(&mut a, at, file);
        assert_eq!(graph, inline, "파일에는 인라인이었을 그래프가 그대로 간다");
        assert!(!a.iter().any(|x| x == "-filter_complex"), "{a:?}");
        assert_eq!(value_after(&a, "-/filter_complex"), file.display().to_string());
        assert!(long_graph_at(&a).is_none());
        // 3구간·마스크만은 인라인.
        let short = build_export_args("/r/a.mp4", "/r/.t.tmp", &cut_spec(), &cut_in(&keep(&[(0, 1000)])));
        assert!(long_graph_at(&short).is_none());

        for (v, ok) in [
            (Some("6.1.1"), false),
            (Some("n6.0"), false),
            (Some("7.0.2"), true),
            (Some("9.0.1"), true),
            (Some("n7.1"), true),
            (Some("N"), true), // git 빌드 — 시도한다
            (None, true),
        ] {
            assert_eq!(graph_file_supported(v), ok, "{v:?}");
        }
    }

    /// 실제 ffmpeg(PATH)로 대본 컷을 끝까지 돌려 출력 길이 ≈ Σkeep(±1프레임)을 본다 — 3구간(인라인)과
    /// 200구간(그래프 파일 `-/filter_complex`). 관리형 빌드로 재려면 그 bin 폴더를 PATH 앞에 둔다.
    /// `cargo test --lib caption_cut_real_ffmpeg -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "PATH의 ffmpeg·ffprobe 필요"]
    async fn caption_cut_real_ffmpeg_output_matches_keep() {
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let probe = crate::tools::runner::find_on_path("ffprobe").expect("ffprobe");
        let dir = std::env::temp_dir().join(format!("gpv-cut-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.mp4").display().to_string();
        let gen = [
            "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=40",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=40",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", &src,
        ];
        let (code, _, err) = run_capture(&ffmpeg, &gen, 120).await.unwrap();
        assert_eq!(code, 0, "{err}");
        let version = run_capture(&ffmpeg, &["-version"], 5).await.unwrap().1;
        println!("ffmpeg: {}", version.lines().next().unwrap_or(""));

        let spec = ExportSpec { duration_ms: 40_000, ..cut_spec() };
        let many: Vec<(u64, u64)> = (0..200).map(|i| (i * 180, i * 180 + 100)).collect();
        for (name, ranges) in [("three", vec![(500, 1500), (2000, 2600), (4000, 5200)]), ("many", many)] {
            let k = keep(&ranges);
            let want: u64 = k.iter().map(|r| r.end_ms - r.start_ms).sum();
            let out = dir.join(format!("{name}.mp4"));
            let mut args = build_export_args(&src, &out.display().to_string(), &spec, &cut_in(&k));
            if let Some(at) = long_graph_at(&args) {
                let file = dir.join(format!("{name}.graph.txt"));
                let graph = externalize_graph(&mut args, at, &file);
                std::fs::write(&file, graph).unwrap();
                println!("{name}: 그래프 파일 {}", file.display());
            }
            let (code, _, err) = run_capture_bytes(&ffmpeg, &args, 300).await.unwrap();
            assert_eq!(code, 0, "{name}: {}", last_error_line(&err));
            let (_, dur, _) = run_capture(
                &probe,
                &["-v", "error", "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json",
                  &out.display().to_string()],
                30,
            )
            .await
            .unwrap();
            let v: serde_json::Value = serde_json::from_str(&dur).unwrap();
            let got = v["format"]["duration"].as_str().unwrap().parse::<f64>().unwrap();
            println!("{name}: Σkeep {want}ms → 출력 {got:.3}s, streams {}", v["streams"]);
            assert!((got * 1000.0 - want as f64).abs() <= 34.0, "{name}: Σkeep {want}ms인데 {got}s");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 실제 ffmpeg(PATH, libass)로 한국어 cue를 번인하고 프레임을 OS OCR(이미지 뷰어 OCR과 같은 엔진 — Windows.Media.Ocr·
    /// Vision·tesseract)로 읽는다: 한글이 네모 칸(글꼴 없음)이 아니라 글자로 그려지는지(§3.6-6, §8 Q6). 프리셋 셋 × 구간
    /// 시프트(자막이 나올 때만 한글) + 소프트 자막(무손실 복사 + 키프레임 스냅 구간)의 글·시각.
    /// `cargo test --lib caption_burn_real_ffmpeg -- --ignored --nocapture` — Windows는 한국어 OCR 팩 필요.
    /// `GPV_BURN_TEST_KEEP=1`이면 산출물 폴더(프레임 PNG·ASS)를 지우지 않는다.
    #[tokio::test]
    #[ignore = "PATH의 ffmpeg(libass)·ffprobe + OS OCR 필요"]
    async fn caption_burn_real_ffmpeg_renders_hangul() {
        use crate::stt::plan::OutCue;
        use crate::stt::video_subs::{build_ass, shift_cues, CaptionStylePreset};
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let probe = crate::tools::runner::find_on_path("ffprobe").expect("ffprobe");
        println!("ffmpeg: {}", run_capture(&ffmpeg, &["-version"], 5).await.unwrap().1.lines().next().unwrap_or(""));
        assert!(has_subtitles_filter(&ffmpeg).await.unwrap(), "이 ffmpeg에는 libass(subtitles)가 없다");
        let dir = std::env::temp_dir().join(format!("gpv-burn-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let run_err = |args: &[String], cwd: &Path| {
            let o = std::process::Command::new(&ffmpeg).args(args).current_dir(cwd).output().unwrap();
            let err = String::from_utf8_lossy(&o.stderr).into_owned();
            assert!(o.status.success(), "{}", last_error_line(&err));
            (o.stdout, err)
        };
        let run = |args: &[String], cwd: &Path| run_err(args, cwd).0;
        let owned = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let src = dir.join("src.mp4").display().to_string();
        run(
            &owned(&[
                "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=6",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-preset", "ultrafast",
                "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", &src,
            ]),
            &dir,
        );
        let hangul = |s: &str| s.chars().filter(|c| ('가'..='힣').contains(c)).collect::<std::collections::BTreeSet<char>>();
        let text = "자막 번인 시험\n한글 글자 확인";
        let want = hangul(text);
        let cues = vec![OutCue { cue_id: "c1".into(), start_ms: 1500, end_ms: 4500, text: text.into() }];
        let range = RangeMs { start_ms: 1000, end_ms: 5000 };
        // 출력 0.5~3.5초에 자막.
        let shifted = shift_cues(cues.clone(), Some(range), 1.0);
        let ocr_at = |out: &Path, secs: &str, name: &str| {
            let png = run(
                &owned(&[
                    "-v", "error", "-ss", secs, "-i", &out.display().to_string(), "-frames:v", "1",
                    "-vf", "crop=iw:ih*0.45:0:ih*0.55", "-f", "image2pipe", "-c:v", "png", "-",
                ]),
                &dir,
            );
            std::fs::write(dir.join(format!("{name}-{secs}.png")), &png).unwrap();
            image::load_from_memory(&png).unwrap().to_rgba8()
        };

        for preset in [CaptionStylePreset::Basic, CaptionStylePreset::Box, CaptionStylePreset::Large] {
            let name = format!("{preset:?}").to_lowercase();
            let spec = ExportSpec {
                mode: "encode".into(),
                out_rel: "a.sub.mp4".into(),
                range: Some(range),
                caption_subs: Some(CaptionSubs { preset, ..subs_spec(SubsMode::Burn, SubTimeline::Source) }),
                duration_ms: 6000,
                ..base_spec()
            };
            validate_spec(&spec).unwrap();
            let (w, h) = export_out_size(1280, 720, &spec);
            let burn_dir = dir.join(format!("burn-{name}"));
            std::fs::create_dir_all(&burn_dir).unwrap();
            std::fs::write(burn_dir.join(crate::stt::video_subs::BURN_ASS_NAME), build_ass(&shifted, preset, w, h)).unwrap();
            let out = dir.join(format!("{name}.mp4"));
            let sf = SubsFile::Burn { dir: burn_dir.clone() };
            let doc = DocInputs { audio_stream: Some(0), subs: Some(&sf), ..Default::default() };
            let (_, err) = run_err(&build_export_args(&src, &out.display().to_string(), &spec, &doc), &burn_dir);
            let missing = burn_missing_glyphs(&err);
            assert!(missing.is_empty(), "{name}: libass가 못 그린 글자 {missing:?}");

            let got = crate::commands::recognize_two_pass(ocr_at(&out, "2.0", &name)).await.expect("OCR");
            let hits = want.iter().filter(|c| hangul(&got.text).contains(c)).count();
            println!("{name}: OCR {:?} → 한글 {hits}/{}", got.text, want.len());
            assert!(hits * 10 >= want.len() * 6, "{name}: 한글이 글자로 읽히지 않는다(네모 칸?) — OCR {:?}", got.text);
            // 출력은 4.0초(구간 길이) — 자막 전(0.2)과 자막이 끝난 뒤(3.8).
            for secs in ["0.2", "3.8"] {
                let off = crate::commands::recognize_two_pass(ocr_at(&out, secs, &name)).await.expect("OCR");
                assert!(hangul(&off.text).is_empty(), "{name} {secs}초: 자막이 나올 때가 아니다 — {:?}", off.text);
            }
        }

        // 어떤 글꼴에도 없는 글자(U+0378 미할당) — ffmpeg는 0으로 끝나지만 네모 칸이다. video_export는 이 경고로 거절한다
        // (Windows gyan은 DirectWrite, johnvansickle은 fontconfig — 경고 문구는 같다).
        let tofu_dir = dir.join("burn-tofu");
        std::fs::create_dir_all(&tofu_dir).unwrap();
        let tofu = [OutCue { cue_id: "c1".into(), start_ms: 0, end_ms: 2000, text: "한글 \u{378}".into() }];
        let ass = build_ass(&tofu, CaptionStylePreset::Basic, 1280, 720);
        std::fs::write(tofu_dir.join(crate::stt::video_subs::BURN_ASS_NAME), ass).unwrap();
        let sf = SubsFile::Burn { dir: tofu_dir.clone() };
        let doc = DocInputs { subs: Some(&sf), ..Default::default() };
        let out = dir.join("tofu.mp4").display().to_string();
        let (_, err) = run_err(&build_export_args(&src, &out, &burn_spec(), &doc), &tofu_dir);
        assert_eq!(burn_missing_glyphs(&err), vec!['\u{378}'], "libass 경고를 못 읽었다");

        // 소프트 자막 + 무손실 복사 + 구간: 키프레임(1초 간격)으로 스냅되어 영상이 1.0초부터 시작해도 자막은 같은 만큼
        // 밀려(-avoid_negative_ts make_zero는 모든 스트림에 같은 이동) 원본 1.5초 = 출력 0.5초에 맞는다.
        let range = RangeMs { start_ms: 1400, end_ms: 5000 };
        let spec = ExportSpec {
            mode: "copy".into(),
            out_rel: "a.sub.mp4".into(),
            range: Some(range),
            caption_subs: Some(subs_spec(SubsMode::Soft, SubTimeline::Source)),
            duration_ms: 6000,
            ..base_spec()
        };
        validate_spec(&spec).unwrap();
        let srt = dir.join("soft.srt");
        std::fs::write(&srt, crate::stt::subs::build_srt(&shift_cues(cues, Some(range), 1.0))).unwrap();
        let out = dir.join("soft.mp4");
        let sf = SubsFile::Soft { srt };
        let doc = DocInputs { audio_stream: Some(0), subs: Some(&sf), ..Default::default() };
        run(&build_export_args(&src, &out.display().to_string(), &spec, &doc), &dir);
        let streams = run_capture(
            &probe,
            &["-v", "error", "-show_entries", "stream=codec_type,codec_name,start_time", "-of", "json", &out.display().to_string()],
            30,
        )
        .await
        .unwrap()
        .1;
        println!("soft streams: {streams}");
        assert!(streams.contains("\"mov_text\""), "자막 스트림 없음: {streams}");
        let back = String::from_utf8(run(
            &owned(&["-v", "error", "-i", &out.display().to_string(), "-map", "0:s:0", "-f", "srt", "-"]),
            &dir,
        ))
        .unwrap();
        println!("soft srt:\n{back}");
        assert!(back.contains("자막 번인 시험"), "{back}");
        // 실측(gyan 8.0): 영상 첫 프레임(원본 1.0초 키프레임)이 출력 0.000977초, 자막 0.502초 — 1프레임(33ms) 안이면 맞다.
        let ms = |t: &str| -> i64 {
            let (hms, f) = t.trim().split_once(',').unwrap();
            let p: Vec<i64> = hms.split(':').map(|x| x.parse().unwrap()).collect();
            ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000 + f.parse::<i64>().unwrap()
        };
        let line = back.lines().find(|l| l.contains("-->")).expect("시각 줄");
        let (a, b) = line.split_once("-->").unwrap();
        assert!((ms(a) - 500).abs() <= 33 && (ms(b) - 3500).abs() <= 33, "원본 1.5~4.5초 = 출력 0.5~3.5초여야 한다: {line}");

        if std::env::var_os("GPV_BURN_TEST_KEEP").is_some() {
            println!("산출물: {}", dir.display());
        } else {
            std::fs::remove_dir_all(&dir).ok();
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
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
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
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
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
        let a = build_export_args("/r/in.mp4", "/r/.t.tmp", &spec, &DocInputs::default());

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
        let a = build_export_args("/r/in.mp4", "/r/.t.tmp", &spec, &DocInputs::default());
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
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
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
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
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
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
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
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "libmp3lame"), "{a:?}");
        assert!(a.windows(2).any(|w| w[0] == "-f" && w[1] == "mp3"));
        s.out_rel = "a.m4a".into();
        let a = build_export_args("/r/a.mp4", "/r/.t.tmp", &s, &DocInputs::default());
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
        assert_eq!(expected_out_us(&s, None), 5_000_000);
        s.mode = "copy".into(); // copy는 speed 무시
        s.speed = None;
        assert_eq!(expected_out_us(&s, None), 10_000_000);
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
          "format": {"duration":"12.5","bit_rate":"4000000","start_time":"-0.007000"}
        }"#;
        let m = parse_probe(json).unwrap();
        assert_eq!((m.width, m.height), (1080, 1920));
        assert!((m.fps - 29.97).abs() < 0.01);
        assert_eq!(m.duration_ms, 12_500);
        assert_eq!(m.bitrate_kbps, Some(4000));
        assert!(m.has_audio);
        assert_eq!(m.acodec.as_deref(), Some("aac"));
        assert_eq!(m.start_time_ms, -7, "start_time은 음수도 그대로(Opus webm)");
    }

    /// avg_frame_rate가 "0/0"(미상)이면 r_frame_rate로 폴백한다.
    #[test]
    fn probe_falls_back_to_r_frame_rate() {
        let json = r#"{"streams":[{"codec_type":"video","width":10,"height":10,
          "avg_frame_rate":"0/0","r_frame_rate":"25/1"}],"format":{}}"#;
        assert_eq!(parse_probe(json).unwrap().fps, 25.0);
        assert_eq!(parse_probe(json).unwrap().start_time_ms, 0, "start_time 없음 = 0");
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
