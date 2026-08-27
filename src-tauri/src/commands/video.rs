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
async fn run_capture(
    bin: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<(i32, String, String), IpcError> {
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
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    ))
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

#[tauri::command]
pub async fn video_probe(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<VideoMeta, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let bin = find_ffmpeg(&app, state.inner())?;
    let probe = bin.ffprobe.ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "ffprobe를 찾을 수 없습니다 — ffmpeg와 같은 폴더에 있어야 합니다",
        )
    })?;
    let src = super::tree::resolve_in_repo(&repo, &rel_path)?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"));
    }
    let src_s = src.display().to_string();
    let (code, stdout, stderr) = run_capture(
        &probe,
        &["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &src_s],
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
                || ext == "gif"
            {
                return bad("무손실 복사는 배속·크롭·화질·GIF와 함께 쓸 수 없습니다 (재인코딩 필요)");
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
                    "[0:v]{},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5",
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
            if !vf.is_empty() {
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
        Err(IpcError {
            code: ErrorCode::Io,
            message: format!("ffmpeg 실패: {}", last_error_line(&stderr_tail)),
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

#[tauri::command]
pub async fn video_capture_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    at_ms: u64,
    out_rel: String,
    overwrite: bool,
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
    // -c:v png 명시 — 임시 이름(.tmp)이라 image2 muxer가 확장자로 인코더를 못 고른다.
    let args = [
        "-hide_banner", "-nostdin", "-y",
        "-ss", &fmt_secs(at_ms), "-i", &src_s,
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
    if out.exists() {
        std::fs::remove_file(&out)
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("기존 파일 교체 실패: {e}")))?;
    }
    std::fs::rename(&tmp, &out)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("산출물 이동 실패: {e}")))
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
            duration_ms: 60_000,
            has_audio: true,
        }
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
}
