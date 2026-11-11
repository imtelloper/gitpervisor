//! 화면 녹화 — 캡쳐 오버레이로 영역을 고르고 ffmpeg 가 녹화한다(`DOCS/screen-capture-design.md` M-R1·M-R2).
//!
//! 새 캡쳐 코드는 없다. 영역 선택은 정지 캡쳐 오버레이(`capture.rs`, `CaptureMode::Record`)를 그대로 쓰고,
//! 픽셀은 ffmpeg `ddagrab`(DXGI Desktop Duplication → GPU 인코더)이 잡는다. 이 파일은 인자 조립과 상태 기계다.
//! 선택이 끝나면 **그 오버레이 창이 작은 컨트롤 바로 줄어든다** — 이미 데워 둔 창이라 새 창(실측 1.3초)을 안 만든다.
//!
//! **정지는 kill 이 아니라 stdin 의 `q` 다.** mp4 는 끝에 moov 를 써야 재생된다 — 죽이면 파일이 통째로 깨진다(R11).
//!
//! **ffmpeg 엔 일시정지가 없다 — 조각으로 나눈다.** 일시정지 = 지금 ffmpeg 를 `q` 로 끝내 조각 하나를 닫고, 재개 =
//! 같은 인자로 다음 조각을 새로 띄운다. 정지하면 조각을 concat demuxer(`-c copy`, 재인코딩 없음)로 잇는다.
//! 카운트다운도 같은 상태 기계 안이다 — 그동안은 ffmpeg 가 없고, 거기서 멈추면 파일 없이 취소다.
//!
//! **ffmpeg 는 임시 폴더에 쓰고, 끝난 뒤 이 앱이 `동영상\Screen Recordings` 로 옮긴다.** 이 개발기처럼 Defender
//! "제어된 폴더 액세스"가 켜져 있으면 서명 없는 도구는 보호 폴더에 파일을 못 만든다(node·powershell 로 실측,
//! 2026-11-10). 반쯤 쓴 파일이 사용자 폴더에 보이지 않는 덤도 있다.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::capture::{CaptureMode, RectPx, CAPTURE_OVERLAY_LABEL};
use crate::error::{ErrorCode, IpcError};
use crate::git::types::Settings;
use crate::i18n::text_system as text;

/// 녹화 영역 테두리 창 라벨 — `lib.rs` 의 `ensure_rec_frame`·종료 정리(`AUX_WINDOW_LABELS`)와 같은 문자열.
pub const REC_FRAME_LABEL: &str = "rec-frame";

/// 자동 정지 크기(모든 조각 합) — 이 저장소는 무한 증가로 여러 번 데었다(설계 §4.8). 길이 한도는 설정 `record_max_minutes`.
const MAX_BYTES: u64 = 4 << 30;
/// 임시 폴더 드라이브 여유가 이보다 적으면 시작하지 않고, 녹화 중 내려가면 멈춘다.
const MIN_FREE_BYTES: u64 = 1 << 30;
/// `q` 뒤 ffmpeg 가 moov 를 쓰고 끝낼 때까지 기다리는 한도. 넘기면 kill 하고 그 파일은 깨졌을 수 있다고 알린다.
const STOP_GRACE: Duration = Duration::from_secs(10);
/// 조각 잇기 한도 — `-c copy` 라 디스크 복사 속도다(4GB 도 HDD 에서 1분 안쪽). 넘기면 멈춘 것으로 보고 조각을 남긴다.
const CONCAT_LIMIT: Duration = Duration::from_secs(300);
/// DirectShow 장치 나열 한도 — 보통 1초 안에 끝난다.
const DEVICE_LIST_LIMIT: Duration = Duration::from_secs(10);
/// 컨트롤 바 크기(CSS px) — `CaptureOverlay.tsx` 의 `RecordBar` 가 이 상자를 채운다.
const BAR_CSS: (f64, f64) = (380.0, 44.0);

// ─────────────────────────── 설정 ───────────────────────────

/// 설정에서 녹화가 쓰는 값만, 범위를 고쳐서 — 설정 저장은 값을 검사하지 않으므로 여기서 한 번에 정리한다.
#[derive(Debug, Clone, PartialEq)]
struct RecordOptions {
    fps: u32,
    draw_mouse: bool,
    audio: Option<String>,
    countdown: u32,
    max_duration: Duration,
}

impl RecordOptions {
    fn from_settings(s: &Settings) -> Self {
        Self {
            fps: if s.record_fps == 30 { 30 } else { 60 },
            draw_mouse: s.record_draw_mouse,
            // DirectShow 는 Windows 에만 있다. 이름은 다듬지 않는다 — 장치 이름과 한 글자라도 다르면 dshow 가 못 연다.
            audio: s.record_audio_device.clone().filter(|d| cfg!(windows) && !d.trim().is_empty()),
            countdown: s.record_countdown_secs.min(10),
            max_duration: Duration::from_secs(u64::from(s.record_max_minutes.clamp(1, 120)) * 60),
        }
    }
}

// ─────────────────────────── ffmpeg 조합 ───────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pipeline {
    DdaNvenc,
    DdaAmf,
    DdaQsv,
    DdaX264,
    /// ddagrab 이 안 되는 환경(RDP·다른 GPU 에 붙은 모니터) — 실측 2560×1440 에서 23fps 라 성능 저하를 알린다.
    GdiX264,
}

impl Pipeline {
    /// GPU 인코더 → CPU 순(설계 §4.1b). `-encoders` 에 이름이 있어도 드라이버·GPU 세대 때문에 실제로는 실패하는
    /// 조합이 흔해 **시험 인코딩을 통과한 첫 번째**를 쓴다(R10). gdigrab 은 시험하지 않는 최후 폴백이다.
    const PROBE_ORDER: [Pipeline; 4] = [Pipeline::DdaNvenc, Pipeline::DdaAmf, Pipeline::DdaQsv, Pipeline::DdaX264];

    fn gpu(self) -> bool {
        matches!(self, Self::DdaNvenc | Self::DdaAmf | Self::DdaQsv)
    }

    /// CPU 인코딩은 4K 60fps 를 못 따라간다(설계 §2.4) — 프레임을 흘리느니 30 으로 고르게 찍는다.
    fn fps(self, want: u32) -> u32 {
        if self.gpu() {
            want
        } else {
            want.min(30)
        }
    }

    fn input_args(self, src: &Source, fps: u32, draw_mouse: bool) -> Vec<String> {
        let (w, h, mouse) = (src.w, src.h, u8::from(draw_mouse));
        match (self, src.output_idx) {
            (Self::GdiX264, _) | (_, None) => [
                "-f", "gdigrab", "-framerate", &fps.to_string(), "-draw_mouse", &mouse.to_string(),
                "-offset_x", &src.vx.to_string(), "-offset_y", &src.vy.to_string(),
                "-video_size", &format!("{w}x{h}"), "-i", "desktop",
            ]
            .map(String::from)
            .to_vec(),
            // offset 은 그 출력(모니터) 로컬 좌표다 — 프리즈 프레임 좌표(RectPx)와 같은 기준이라 환산이 없다.
            (_, Some(idx)) => vec![
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "ddagrab=output_idx={idx}:framerate={fps}:offset_x={}:offset_y={}:video_size={w}x{h}:draw_mouse={mouse}",
                    src.ox, src.oy
                ),
            ],
        }
    }

    fn encoder_args(self) -> &'static [&'static str] {
        match self {
            // vbr+cq — 기본(고정 비트레이트)이면 4K 화면 글자가 뭉개진다. 실측 1280×720 3초 59fps·165KB(2026-11-10).
            Self::DdaNvenc => &["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "25", "-b:v", "0"],
            Self::DdaAmf => &["-c:v", "h264_amf"],
            Self::DdaQsv => &["-vf", "hwmap=derive_device=qsv,format=qsv", "-c:v", "h264_qsv"],
            // ddagrab 은 GPU 프레임을 낸다 — CPU 인코더 앞에서 내려받아야 한다.
            Self::DdaX264 => &["-vf", "hwdownload,format=bgra", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
            Self::GdiX264 => &["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"],
        }
    }
}

/// 녹화 한 조각의 ffmpeg 인자 — 출력 경로만 빼고 전부. 재개한 조각도 **같은 인자**여야 `-c copy` 로 이어진다.
fn record_args(p: Pipeline, src: &Source, opts: &RecordOptions) -> Vec<String> {
    let mut args = p.input_args(src, p.fps(opts.fps), opts.draw_mouse);
    if let Some(dev) = &opts.audio {
        // 장치 이름은 argv 한 칸 — 셸을 안 거치니 괄호·공백·한글을 따옴표로 감싸지 않는다(실측 2026-11-10).
        // dshow 기본 버퍼(500ms)면 소리가 화면보다 그만큼 늦게 붙는다.
        args.extend(["-f", "dshow", "-audio_buffer_size", "50", "-i"].map(String::from));
        args.push(format!("audio={dev}"));
    }
    args.extend(p.encoder_args().iter().map(|s| s.to_string()));
    if opts.audio.is_some() {
        args.extend(["-c:a", "aac", "-b:a", "160k"].map(String::from));
    }
    args
}

/// 녹화 영역. `vx·vy` 는 가상 데스크톱 좌표(gdigrab), `ox·oy` 는 그 모니터 로컬 좌표(ddagrab).
struct Source {
    output_idx: Option<u32>,
    vx: i32,
    vy: i32,
    ox: u32,
    oy: u32,
    w: u32,
    h: u32,
}

fn ffmpeg_raw(bin: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn ffmpeg_cmd(bin: &Path) -> std::process::Command {
    let mut cmd = ffmpeg_raw(bin);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    cmd
}

fn wait_deadline(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let end = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return Some(s),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// `q` 로 끝내고 기다린다. 한도를 넘기면 kill — 그 조각은 moov 가 없어 깨졌을 수 있다. (종료 상태, kill 했나)
fn stop_child(child: &mut Child) -> (Option<ExitStatus>, bool) {
    // `q` 를 받으면 ffmpeg 가 입력을 끊고 moov 를 쓴 뒤 스스로 끝난다. stdin 은 여기서 닫힌다.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
    }
    match wait_deadline(child, STOP_GRACE) {
        Some(s) => (Some(s), false),
        None => {
            let _ = child.kill();
            (child.wait().ok(), true)
        }
    }
}

/// ffmpeg 경로별 시험 결과. 안쪽 None = ddagrab 조합이 하나도 안 됐다(→ gdigrab).
static PROBED: Mutex<Option<(PathBuf, Option<Pipeline>)>> = Mutex::new(None);
/// 시험을 한 번만 돌린다 — 단축키 때 시작한 시험이 안 끝났으면 `record_start` 가 기다렸다가 그 결과를 쓴다.
static PROBE_LOCK: Mutex<()> = Mutex::new(());

fn best_dda(ffmpeg: &Path) -> Option<Pipeline> {
    let _one = PROBE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((p, best)) = PROBED.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if p == ffmpeg {
            return *best;
        }
    }
    let t0 = Instant::now();
    // 같은 GPU 에 붙은 출력이면 인코더 가용성은 같다 — 0번 출력 구석 256×256 으로 시험한다. 오디오는 빼고 본다.
    let src = Source { output_idx: Some(0), vx: 0, vy: 0, ox: 0, oy: 0, w: 256, h: 256 };
    let best = Pipeline::PROBE_ORDER.into_iter().find(|p| {
        let spawned = ffmpeg_cmd(ffmpeg)
            .args(p.input_args(&src, p.fps(60), true))
            .args(["-frames:v", "10"])
            .args(p.encoder_args())
            .args(["-f", "null", "-"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = spawned else { return false };
        let status = wait_deadline(&mut child, Duration::from_secs(15));
        if status.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        status.is_some_and(|s| s.success())
    });
    log::info!("[record] 인코더 시험 {}ms → {best:?}", t0.elapsed().as_millis());
    *PROBED.lock().unwrap_or_else(|e| e.into_inner()) = Some((ffmpeg.to_path_buf(), best));
    best
}

/// `-list_devices` 출력에서 오디오 장치 표시 이름만 뽑는다 — `[dshow @ 0000…] "마이크 배열(Realtek(R) Audio)" (audio)`.
/// 바로 아래 `Alternative name "@device_cm_…"` 줄과 `(video)` 장치는 건너뛴다. 캡처 카드는 `(audio, video)` 로 나온다.
fn parse_dshow_audio_devices(stderr: &str) -> Vec<String> {
    stderr
        .lines()
        .filter(|l| !l.contains("Alternative name"))
        .filter_map(|l| {
            let start = l.find('"')? + 1;
            let end = l.rfind('"')?;
            if end <= start {
                return None;
            }
            let kinds = l[end + 1..].trim().strip_prefix('(')?.strip_suffix(')')?;
            kinds.split(',').any(|k| k.trim() == "audio").then(|| l[start..end].to_string())
        })
        .collect()
}

/// concat demuxer 목록. 경로는 작은따옴표로 감싸고 안의 `'` 는 `'\''`(닫고·이스케이프·다시 열기) — 따옴표 안에선
/// 역슬래시가 글자 그대로라 Windows 경로를 손대지 않는다.
fn concat_list(parts: &[PathBuf]) -> String {
    parts
        .iter()
        .map(|p| format!("file '{}'\n", p.to_string_lossy().replace('\'', r"'\''")))
        .collect()
}

/// 일시정지로 나뉜 조각을 재인코딩 없이(`-c copy`) 하나로 잇는다 — 조각마다 인자가 같아 스트림 형식이 같다.
/// 실패하면 결과 파일만 지우고 조각·목록은 둔다(호출자가 그 폴더를 알린다). Err = ffmpeg 의 마지막 오류 줄.
fn concat_segments(ffmpeg: &Path, parts: &[PathBuf], out: &Path) -> Result<(), String> {
    let list = out.with_extension("txt");
    let log = out.with_extension("concat.log");
    std::fs::write(&list, concat_list(parts)).map_err(|e| format!("{}: {e}", list.display()))?;
    let stderr = std::fs::File::create(&log).map_err(|e| format!("{}: {e}", log.display()))?;
    let spawned = ffmpeg_cmd(ffmpeg)
        .args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy"])
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn();
    let result = match spawned {
        Err(e) => Err(format!("{}: {e}", ffmpeg.display())),
        Ok(mut child) => match wait_deadline(&mut child, CONCAT_LIMIT) {
            Some(s) if s.success() && std::fs::metadata(out).is_ok_and(|m| m.len() > 0) => Ok(()),
            status => {
                if status.is_none() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                Err(std::fs::read_to_string(&log)
                    .map(|s| super::video::last_error_line(&s))
                    .unwrap_or_else(|e| format!("{}: {e}", log.display())))
            }
        },
    };
    let _ = std::fs::remove_file(&log);
    match &result {
        Ok(()) => {
            let _ = std::fs::remove_file(&list);
        }
        Err(_) => {
            let _ = std::fs::remove_file(out);
        }
    }
    result
}

// ─────────────────────────── 플랫폼 ───────────────────────────

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::Path;

    /// 가상 데스크톱 원점이 `(mx, my)` 인 모니터의 DXGI 출력 번호(ddagrab `output_idx`).
    ///
    /// **해상도로 맞추면 안 된다** — 이 개발기는 출력 5개 중 둘이 3840×2160 이다. 순서도 Windows 디스플레이 번호와
    /// 다르다(R13). ffmpeg 는 기본 어댑터(0번)에 D3D11 장치를 만들므로 같은 어댑터의 출력만 센다. 다른 GPU 에
    /// 붙은 모니터면 None → gdigrab.
    pub fn dxgi_output_index(mx: i32, my: i32) -> Option<u32> {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
            let adapter = factory.EnumAdapters1(0).ok()?;
            for i in 0u32.. {
                let output = adapter.EnumOutputs(i).ok()?; // 끝까지 셌다
                let Ok(desc) = output.GetDesc() else { continue };
                let r = desc.DesktopCoordinates;
                if r.left == mx && r.top == my {
                    return Some(i);
                }
            }
        }
        None
    }

    pub fn free_bytes(dir: &Path) -> Option<u64> {
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
        (ok != 0).then_some(free)
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::Path;

    pub fn dxgi_output_index(_mx: i32, _my: i32) -> Option<u32> {
        None
    }
    pub fn free_bytes(_dir: &Path) -> Option<u64> {
        None
    }
}

// ─────────────────────────── 녹화 상태 ───────────────────────────

enum Phase {
    /// 카운트다운 — ffmpeg 를 아직 안 띄웠다. 여기서 멈추면 파일 없이 취소다.
    Countdown,
    /// 마지막 조각을 쓰는 중.
    Running { child: Child, since: Instant },
    /// 조각 사이 — 도는 ffmpeg 가 없다.
    Paused,
}

struct Recording {
    id: u64,
    phase: Phase,
    ffmpeg: PathBuf,
    /// 조각마다 같은 인자(`record_args`) — 출력 경로만 다르다.
    args: Vec<String>,
    tmp_dir: PathBuf,
    /// 이 녹화의 임시 파일 이름 머리 — 조각 `<stem>-1.mp4`, `<stem>-2.mp4` …, 이은 결과 `<stem>.mp4`.
    stem: String,
    segments: Vec<PathBuf>,
    /// ffmpeg stderr(모든 조각이 이어 쓴다) — 실패했을 때 마지막 줄을 사용자에게 보인다.
    log: PathBuf,
    /// 단축키를 누른 시각 — 파일 이름이 된다(스크린샷과 같은 규칙).
    taken: chrono::NaiveDateTime,
    /// 끝난 조각들의 녹화 시간 합. 카운트다운·일시정지는 경과 표시에도 길이 한도에도 안 들어간다.
    active: Duration,
    max_duration: Duration,
    /// 시작할 때 해석한 저장 폴더 — 녹화 도중 설정을 바꿔도 이 녹화는 처음 폴더로 간다.
    save_dir: Option<PathBuf>,
    /// 어느 조각이든 ffmpeg 가 정상 종료하지 않았다.
    broken: bool,
}

impl Recording {
    fn elapsed(&self) -> Duration {
        match &self.phase {
            Phase::Running { since, .. } => self.active + since.elapsed(),
            _ => self.active,
        }
    }
}

static REC: Mutex<Option<Recording>> = Mutex::new(None);
/// 상태 전이(첫 조각·일시정지·재개·정지)를 한 줄로 세운다. 일시정지는 ffmpeg 가 moov 를 다 쓸 때까지(최대 10초)
/// `REC` 를 놓고 기다리는데 — 그동안 감시 스레드가 경과를 흘려야 한다 — 그사이 정지가 끼어들어 덜 쓴 조각을
/// 이으면 결과가 깨진다. 잡는 순서는 늘 CONTROL → REC 다(REC 를 쥔 채 CONTROL 을 기다리지 않는다).
static CONTROL: Mutex<()> = Mutex::new(());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 카운트다운·일시정지 중에도 true — 그동안에도 오버레이 창은 컨트롤 바다.
pub fn is_recording() -> bool {
    REC.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

fn is_current(rid: u64) -> bool {
    REC.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|r| r.id == rid)
}

/// 녹화를 꺼낸다. `only` 면 그 녹화일 때만(감시 스레드가 다음 녹화를 끄지 않게).
fn take_rec(only: Option<u64>) -> Option<Recording> {
    let mut cur = REC.lock().unwrap_or_else(|e| e.into_inner());
    if only.is_some_and(|id| cur.as_ref().is_none_or(|r| r.id != id)) {
        None
    } else {
        cur.take()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum StopReason {
    User,
    MaxDuration,
    MaxSize,
    DiskLow,
    /// ffmpeg 가 스스로 끝났다(인코더 오류·디스플레이 변경 등).
    Exited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordStarted {
    width: u32,
    height: u32,
    /// GPU 인코더를 못 써 CPU 로 녹화한다 — 바에 표시한다(조용히 내려가지 않는다, 설계 §4.1b).
    cpu: bool,
    /// 이만큼 센 뒤에 ffmpeg 를 띄운다 — 바가 3·2·1 을 그린다. 0 = 바로.
    countdown_secs: u32,
    /// 마이크도 같이 녹음한다(설정 `record_audio_device`).
    audio: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordProgress {
    elapsed_ms: u64,
    bytes: u64,
    paused: bool,
}

/// 저장 결과 — 메인 창이 토스트([폴더 열기])로 알린다(`App.tsx`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordSaved {
    path: String,
    file_name: String,
    reason: StopReason,
    /// ffmpeg 가 정상 종료하지 않았다 — 파일은 남기되 재생되지 않을 수 있다고 알린다(버리면 녹화를 통째로 잃는다).
    broken: bool,
    detail: String,
}

/// 설정 화면의 자리표시 — 저장 폴더를 비워 두면 쓰는 OS 기본 폴더.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDefaultDirs {
    screenshots: Option<String>,
    recordings: Option<String>,
}

/// OS 기본 녹화 폴더 — Windows 캡처 도구와 같은 `동영상\Screen Recordings`.
fn os_recordings_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        super::favorites::screen_recordings_dir()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 컨트롤 바 자리(가상 데스크톱 물리 px). 녹화 영역 바로 아래 → 자리가 없으면 위 → 그래도 없으면 영역 안쪽 아래.
/// 바는 화면 녹화에서 빠지게 해 두므로(`set_content_protected`) 안쪽에 놓여도 결과물에 찍히지 않는다.
fn bar_position(mon: (i32, i32, u32, u32), r: (u32, u32, u32, u32), bar: (u32, u32), gap: u32) -> (i32, i32) {
    let (mx, my, mw, mh) = mon;
    let (rx, ry, rw, rh) = r;
    let (bw, bh) = bar;
    let y = if ry + rh + gap + bh <= mh {
        ry + rh + gap
    } else if ry >= bh + gap {
        ry - bh - gap
    } else {
        (ry + rh).saturating_sub(bh + gap)
    };
    let x = (rx + rw / 2).saturating_sub(bw / 2).min(mw.saturating_sub(bw));
    (mx + x as i32, my + y as i32)
}

/// 테두리 창 자리(가상 데스크톱 물리 px) — 녹화 영역을 사방 CSS 2px 만큼 키워 테두리가 영역 **바깥**에 그려지게 한다.
fn frame_rect(region: (i32, i32, u32, u32), scale: f64) -> (i32, i32, u32, u32) {
    let m = ((2.0 * scale).round() as u32).max(1);
    let (x, y, w, h) = region;
    (x - m as i32, y - m as i32, w + 2 * m, h + 2 * m)
}

/// 테두리 창을 띄운다. 못 만들어도 녹화는 계속한다(보조 표시일 뿐이다). **메인 스레드에서 부른다.**
fn show_rec_frame(app: &AppHandle, rid: u64, scale: f64, region: (i32, i32, u32, u32)) {
    if !is_current(rid) {
        return;
    }
    let win = match crate::ensure_rec_frame(app) {
        Ok(w) => w,
        Err(e) => {
            log::warn!("[record] 테두리 창을 만들지 못했습니다: {e}");
            return;
        }
    };
    let (x, y, w, h) = frame_rect(region, scale);
    // 자리 먼저 — 배율이 다른 모니터로 옮기면 Windows 가 창 크기를 그 배율로 다시 잡는다. 크기는 그 뒤에 물리 px 로 박는다.
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.show();
    // 그사이 녹화가 끝났으면(카운트다운 0 + 즉시 실패) `finish` 가 이 창이 생기기 전에 지나갔을 수 있다.
    if !is_current(rid) {
        close_rec_frame(app);
    }
}

fn close_rec_frame(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(REC_FRAME_LABEL) {
        if let Err(e) = w.destroy() {
            log::warn!("[record] 테두리 창 닫기 실패: {e}");
        }
    }
}

/// 영역 확정 — 동기로 검사(세션·ffmpeg·디스크·임시 폴더)하고 카운트다운 상태로 녹화를 세운 뒤 바·테두리를 놓는다.
/// ffmpeg 는 `spawn_launch` 가 카운트다운 뒤에 띄운다.
fn start_inner(app: &AppHandle, id: &str, rect: RectPx) -> Result<RecordStarted, IpcError> {
    // Windows 밖에선 여기까지 오지 않는다 — 정지 캡쳐가 세션을 못 만들어(`capture.rs` imp) take_for_record 가 실패한다.
    if is_recording() {
        return Err(IpcError::new(ErrorCode::Busy, text::record_already_running()));
    }
    let (mx, my, mw, mh, taken) = super::capture::take_for_record(id, rect)?;
    let state = app.state::<crate::state::AppState>();
    let bin = super::video::find_ffmpeg(app, &state)?;
    let (opts, save_dir) = {
        let s = state.settings.read().unwrap_or_else(|e| e.into_inner());
        let dir = super::capture::resolve_save_dir("recordings", s.record_save_dir.as_deref(), os_recordings_dir);
        (RecordOptions::from_settings(&s), dir)
    };
    // yuv420p 는 가로·세로가 짝수여야 한다 — 홀수면 인코더가 시작하자마자 거부한다.
    let (w, h) = (rect.w & !1, rect.h & !1);
    let output_idx = imp::dxgi_output_index(mx, my);
    let pipeline = output_idx.and_then(|_| best_dda(&bin.ffmpeg)).unwrap_or(Pipeline::GdiX264);

    let tmp_dir = std::env::temp_dir().join("gitpervisor-rec");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| IpcError::new(ErrorCode::Io, text::record_spawn_failed(format!("{}: {e}", tmp_dir.display()))))?;
    if let Some(free) = imp::free_bytes(&tmp_dir).filter(|f| *f < MIN_FREE_BYTES) {
        return Err(IpcError::new(ErrorCode::Io, text::record_disk_low(free >> 20)));
    }
    let stem = uuid::Uuid::new_v4().to_string();
    let log = tmp_dir.join(format!("{stem}.log"));
    // 여기서 한 번 만들어 본다 — 임시 폴더에 못 쓰면 카운트다운이 끝난 뒤가 아니라 지금 실패를 돌려준다.
    std::fs::File::create(&log)
        .map_err(|e| IpcError::new(ErrorCode::Io, text::record_spawn_failed(format!("{}: {e}", log.display()))))?;
    let src = Source { output_idx, vx: mx + rect.x as i32, vy: my + rect.y as i32, ox: rect.x, oy: rect.y, w, h };
    let args = record_args(pipeline, &src, &opts);

    let rid = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    {
        let mut cur = REC.lock().unwrap_or_else(|e| e.into_inner());
        if cur.is_some() {
            let _ = std::fs::remove_file(&log);
            return Err(IpcError::new(ErrorCode::Busy, text::record_already_running()));
        }
        *cur = Some(Recording {
            id: rid,
            phase: Phase::Countdown,
            ffmpeg: bin.ffmpeg.clone(),
            args,
            tmp_dir,
            stem,
            segments: Vec::new(),
            log,
            taken,
            active: Duration::ZERO,
            max_duration: opts.max_duration,
            save_dir,
            broken: false,
        });
    }
    log::info!(
        "[record] {w}x{h} @({},{}) {pipeline:?} {}fps 커서={} 오디오={:?} output_idx={output_idx:?} 카운트다운 {}초", // i18n-ok: 로그
        src.vx,
        src.vy,
        pipeline.fps(opts.fps),
        opts.draw_mouse,
        opts.audio,
        opts.countdown
    );

    let app2 = app.clone();
    let region = (src.vx, src.vy, w, h);
    let _ = app.run_on_main_thread(move || {
        let Some(win) = app2.get_webview_window(CAPTURE_OVERLAY_LABEL) else { return };
        // 녹화에서 뺀다(Windows WDA_EXCLUDEFROMCAPTURE) — 바가 영역 안·경계에 겹쳐도 결과물에 안 찍힌다(R14).
        // 정지 캡쳐는 오버레이를 띄우기 **전에** 찍으므로 켜 둔 채여도 무관하다.
        if let Err(e) = win.set_content_protected(true) {
            log::warn!("[record] 컨트롤 바 녹화 제외 실패: {e}");
        }
        let scale = win.scale_factor().unwrap_or(1.0);
        let bar = ((BAR_CSS.0 * scale).round() as u32, (BAR_CSS.1 * scale).round() as u32);
        let (x, y) = bar_position((mx, my, mw, mh), (rect.x, rect.y, w, h), bar, (8.0 * scale).round() as u32);
        let _ = win.set_size(tauri::PhysicalSize::new(bar.0, bar.1));
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        show_rec_frame(&app2, rid, scale, region);
    });
    spawn_launch(app.clone(), rid, opts.countdown);
    Ok(RecordStarted { width: w, height: h, cpu: !pipeline.gpu(), countdown_secs: opts.countdown, audio: opts.audio.is_some() })
}

/// 다음 조각을 띄운다(첫 조각·재개 공용). 실패하면 상태는 그대로다 — 재개 실패면 일시정지에 머문다.
fn start_segment(r: &mut Recording) -> Result<(), String> {
    let path = r.tmp_dir.join(format!("{}-{}.mp4", r.stem, r.segments.len() + 1));
    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&r.log)
        .map_err(|e| text::record_spawn_failed(format!("{}: {e}", r.log.display())))?;
    let child = ffmpeg_cmd(&r.ffmpeg)
        .args(&r.args)
        .arg(&path)
        .stdin(Stdio::piped()) // 정지 `q` 를 보낼 통로 — `-nostdin` 을 붙이면 kill 말고 멈출 방법이 없다
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn()
        .map_err(|e| text::record_spawn_failed(format!("{}: {e}", r.ffmpeg.display())))?;
    log::info!("[record] 조각 {} 시작 → {}", r.segments.len() + 1, path.display());
    r.segments.push(path);
    r.phase = Phase::Running { child, since: Instant::now() };
    Ok(())
}

/// 카운트다운을 세고 첫 조각을 띄운다. 그사이 정지가 와서 `finish` 가 녹화를 꺼내 갔으면 아무것도 안 한다.
fn spawn_launch(app: AppHandle, rid: u64, countdown: u32) {
    let app2 = app.clone();
    let spawned = std::thread::Builder::new().name("record-launch".into()).stack_size(256 * 1024).spawn(move || {
        let end = Instant::now() + Duration::from_secs(countdown.into());
        while Instant::now() < end {
            std::thread::sleep(Duration::from_millis(100));
            if !is_current(rid) {
                return;
            }
        }
        let started = {
            let _ctl = CONTROL.lock().unwrap_or_else(|e| e.into_inner());
            let mut cur = REC.lock().unwrap_or_else(|e| e.into_inner());
            match cur.as_mut() {
                Some(r) if r.id == rid && matches!(r.phase, Phase::Countdown) => match start_segment(r) {
                    Ok(()) => Ok(()),
                    Err(msg) => {
                        if let Some(rec) = cur.take() {
                            let _ = std::fs::remove_file(&rec.log);
                        }
                        Err(msg)
                    }
                },
                _ => return, // 카운트다운 중에 취소됐다
            }
        };
        match started {
            Ok(()) => spawn_watch(app, rid),
            Err(msg) => fail_start(&app, msg),
        }
    });
    if let Err(e) = spawned {
        if let Some(rec) = take_rec(Some(rid)) {
            let _ = std::fs::remove_file(&rec.log);
        }
        fail_start(&app2, text::record_spawn_failed(e));
    }
}

/// 카운트다운 뒤 첫 조각을 못 띄웠다 — `record_start` 가 동기로 실패할 때처럼 바·테두리를 닫고 메인 창에 알린다.
fn fail_start(app: &AppHandle, msg: String) {
    log::warn!("[record] 시작 실패: {msg}");
    super::capture::hide_overlay(app);
    close_rec_frame(app);
    let _ = app.emit("record://failed", msg);
}

/// 경과·크기를 바에 흘리고, 한도·ffmpeg 이탈을 감시한다. 첫 조각이 뜬 뒤부터 정지까지 하나만 돈다.
fn spawn_watch(app: AppHandle, rid: u64) {
    let _ = std::thread::Builder::new().name("record-watch".into()).stack_size(256 * 1024).spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let (elapsed, max_duration, segments, paused, exited) = {
            let mut cur = REC.lock().unwrap_or_else(|e| e.into_inner());
            match cur.as_mut() {
                Some(r) if r.id == rid => {
                    // 일시정지 중엔 ffmpeg 가 없다 — 조각을 닫는 중(`record_pause`)이어도 이미 Paused 다.
                    let (paused, exited) = match &mut r.phase {
                        Phase::Running { child, .. } => (false, matches!(child.try_wait(), Ok(Some(_)))),
                        Phase::Countdown | Phase::Paused => (true, false),
                    };
                    (r.elapsed(), r.max_duration, r.segments.clone(), paused, exited)
                }
                _ => return, // 이미 정지됐다
            }
        };
        if exited {
            finish(&app, StopReason::Exited, Some(rid));
            return;
        }
        let bytes: u64 = segments.iter().filter_map(|p| std::fs::metadata(p).ok()).map(|m| m.len()).sum();
        let elapsed_ms = elapsed.as_millis() as u64;
        let _ = app.emit_to(CAPTURE_OVERLAY_LABEL, "record://progress", RecordProgress { elapsed_ms, bytes, paused });
        let limit = if elapsed >= max_duration {
            Some(StopReason::MaxDuration)
        } else if bytes >= MAX_BYTES {
            Some(StopReason::MaxSize)
        } else if segments.last().and_then(|p| p.parent()).and_then(imp::free_bytes).is_some_and(|f| f < MIN_FREE_BYTES) {
            Some(StopReason::DiskLow)
        } else {
            None
        };
        if let Some(reason) = limit {
            finish(&app, reason, Some(rid));
            return;
        }
    });
}

/// 정지 — 바·테두리를 닫고, ffmpeg 를 `q` 로 끝내고, 조각을 이어 저장 폴더로 옮긴 뒤 결과를 이벤트로 알린다.
/// 여러 경로(바 버튼·단축키·한도·앱 종료)가 겹쳐 불러도 녹화를 꺼내는 쪽은 하나다. 카운트다운 중이면 취소다.
fn finish(app: &AppHandle, reason: StopReason, only: Option<u64>) {
    let _ctl = CONTROL.lock().unwrap_or_else(|e| e.into_inner());
    let Some(mut rec) = take_rec(only) else { return };
    super::capture::hide_overlay(app);
    close_rec_frame(app);

    let status = match std::mem::replace(&mut rec.phase, Phase::Paused) {
        Phase::Countdown => {
            log::info!("[record] 카운트다운 중 취소");
            let _ = std::fs::remove_file(&rec.log);
            let _ = app.emit("record://cancelled", ());
            return;
        }
        Phase::Running { mut child, since } => {
            rec.active += since.elapsed();
            let (status, forced) =
                if reason == StopReason::Exited { (child.wait().ok(), false) } else { stop_child(&mut child) };
            rec.broken |= forced || !status.is_some_and(|s| s.success());
            status
        }
        Phase::Paused => None,
    };
    let detail = std::fs::read_to_string(&rec.log)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| super::video::last_error_line(&s))
        .unwrap_or_default();
    let _ = std::fs::remove_file(&rec.log);
    // 빈 조각(띄우자마자 멈춘 것)은 버린다 — 이을 때 ffmpeg 가 그 파일에서 실패한다.
    let mut parts = Vec::new();
    let mut bytes = 0u64;
    for p in std::mem::take(&mut rec.segments) {
        match std::fs::metadata(&p).map(|m| m.len()) {
            Ok(n) if n > 0 => {
                bytes += n;
                parts.push(p);
            }
            _ => {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    log::info!(
        "[record] 정지 {reason:?} {}ms {bytes}B 조각 {}개 종료={status:?} 깨짐={} {detail}", // i18n-ok: 로그
        rec.active.as_millis(),
        parts.len(),
        rec.broken
    );

    let out = match parts.as_slice() {
        [] => {
            let _ = app.emit("record://failed", text::record_failed(&detail));
            return;
        }
        [one] => one.clone(),
        _ => {
            let out = rec.tmp_dir.join(format!("{}.mp4", rec.stem));
            if let Err(why) = concat_segments(&rec.ffmpeg, &parts, &out) {
                // 조각은 지우지 않는다 — 지우면 녹화를 통째로 잃는다. 폴더를 알려 손으로라도 살리게 한다.
                let msg = text::record_concat_failed(rec.tmp_dir.display(), why);
                log::warn!("[record] {msg}");
                let _ = app.emit("record://failed", msg);
                return;
            }
            for p in &parts {
                let _ = std::fs::remove_file(p);
            }
            out
        }
    };
    match commit(&out, rec.taken, rec.save_dir.as_deref()) {
        Ok(path) => {
            log::info!("[record] 저장 {}", path.display());
            let file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let saved =
                RecordSaved { path: path.to_string_lossy().into_owned(), file_name, reason, broken: rec.broken, detail };
            let _ = app.emit("record://saved", saved);
        }
        Err(msg) => {
            log::warn!("[record] {msg}");
            let _ = app.emit("record://failed", msg);
        }
    }
}

/// 임시 파일 → `<저장 폴더>\화면 녹화 2026-11-10 135521.mp4`. 실패하면 임시 파일을 **남기고** 그 경로를 알린다 —
/// 지우면 녹화를 통째로 잃는다.
fn commit(tmp: &Path, taken: chrono::NaiveDateTime, dir: Option<&Path>) -> Result<PathBuf, String> {
    let dir = dir.ok_or_else(|| text::record_dir_unknown(tmp.display()))?;
    let (dst, file) = super::capture::reserve_dated_file(dir, text::record_file_prefix(), taken, "mp4")
        .map_err(|e| text::record_move_failed(tmp.display(), format!("{}: {e}", dir.display())))?;
    drop(file); // 자리 파일 — rename 이 교체한다(Windows 도 MoveFileExW REPLACE_EXISTING)
    // 저장 폴더가 다른 드라이브면 rename 이 안 된다 → 복사 후 임시 파일 삭제.
    let moved = std::fs::rename(tmp, &dst).or_else(|_| {
        std::fs::copy(tmp, &dst).map(|_| {
            let _ = std::fs::remove_file(tmp);
        })
    });
    moved.map_err(|e| {
        let _ = std::fs::remove_file(&dst);
        text::record_move_failed(tmp.display(), e)
    })?;
    Ok(dst)
}

// ─────────────────────────── 진입점 ───────────────────────────

/// 녹화 단축키(Ctrl+Shift+Alt+X)·`record_trigger` — 녹화 중이면 정지(카운트다운 중이면 취소), 아니면 영역 선택을 연다.
pub fn record_hotkey(app: &AppHandle) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("record-hotkey".into()).spawn(move || {
        if is_recording() {
            finish(&app, StopReason::User, None);
            return;
        }
        // ffmpeg 가 없으면 영역을 고르게 하기 전에 말한다 — 다 고른 뒤에 "못 한다"면 헛수고다.
        let bin = match super::video::find_ffmpeg(&app, &app.state::<crate::state::AppState>()) {
            Ok(b) => b,
            Err(e) => {
                let _ = app.emit("record://failed", e.message);
                return;
            }
        };
        super::capture::run_capture(&app, CaptureMode::Record);
        // 고르는 동안 인코더 시험을 끝내 둔다 — 확정 뒤에 하면 그 1~3초 동안 아무 반응이 없다.
        if cfg!(windows) {
            best_dda(&bin.ffmpeg);
        }
    });
}

/// 단축키와 같은 동작을 IPC 로 — e2e 가 쓴다.
#[tauri::command(async)]
pub fn record_trigger(app: AppHandle) {
    record_hotkey(&app);
}

/// 오버레이에서 녹화 영역을 확정했다 — 세션을 소모하고 카운트다운에 들어간 뒤 오버레이를 컨트롤 바로 줄인다.
/// 실패하면 `record://failed` 로도 알린다 — 오버레이 창엔 토스트가 없어 메인 창이 보여 줘야 한다. 카운트다운 뒤
/// ffmpeg 를 못 띄운 실패도 같은 이벤트로 온다.
#[tauri::command(async)]
pub fn record_start(app: AppHandle, id: String, rect: RectPx) -> Result<RecordStarted, IpcError> {
    start_inner(&app, &id, rect).inspect_err(|e| {
        log::warn!("[record] 시작 실패: {}", e.message);
        super::capture::hide_overlay(&app);
        let _ = app.emit("record://failed", e.message.clone());
    })
}

/// 정지(바의 정지 버튼). 결과는 `record://saved`·`record://failed`, 카운트다운 중이면 `record://cancelled` 로 온다.
#[tauri::command(async)]
pub fn record_stop(app: AppHandle) {
    finish(&app, StopReason::User, None);
}

/// 일시정지(`paused: true`)·재개(`false`) — 결과 상태를 돌려준다. 이미 그 상태면 아무것도 안 한다.
/// 일시정지는 지금 조각을 `q` 로 닫으므로 최대 `STOP_GRACE` 걸릴 수 있다.
#[tauri::command(async)]
pub fn record_pause(app: AppHandle, paused: bool) -> Result<bool, IpcError> {
    let _ctl = CONTROL.lock().unwrap_or_else(|e| e.into_inner());
    let mut cur = REC.lock().unwrap_or_else(|e| e.into_inner());
    let Some(r) = cur.as_mut() else {
        return Err(IpcError::new(ErrorCode::Busy, text::record_not_running()));
    };
    let rid = r.id;
    match (std::mem::replace(&mut r.phase, Phase::Paused), paused) {
        (Phase::Countdown, _) => {
            r.phase = Phase::Countdown;
            return Err(IpcError::new(ErrorCode::Busy, text::record_pause_in_countdown()));
        }
        (Phase::Paused, true) => return Ok(true),
        (running @ Phase::Running { .. }, false) => {
            r.phase = running;
            return Ok(false);
        }
        (Phase::Paused, false) => {
            start_segment(r).map_err(|msg| IpcError::new(ErrorCode::Io, msg))?;
            drop(cur);
            log::info!("[record] 재개");
        }
        (Phase::Running { mut child, since }, true) => {
            r.active += since.elapsed();
            // 조각을 닫는 동안 REC 를 놓는다 — 감시 스레드가 그사이에도 경과를 흘린다(CONTROL 주석).
            drop(cur);
            let (status, forced) = stop_child(&mut child);
            log::info!("[record] 일시정지 — 조각 종료={status:?} 강제={forced}");
            if forced || !status.is_some_and(|s| s.success()) {
                if let Some(r) = REC.lock().unwrap_or_else(|e| e.into_inner()).as_mut().filter(|r| r.id == rid) {
                    r.broken = true;
                }
            }
        }
    }
    let _ = app.emit_to(CAPTURE_OVERLAY_LABEL, "record://paused", serde_json::json!({ "paused": paused }));
    Ok(paused)
}

/// 설정 화면의 마이크 목록 — DirectShow 오디오 장치 표시 이름(설정 `record_audio_device` 에 그대로 넣는다).
#[tauri::command(async)]
pub fn record_audio_devices(app: AppHandle) -> Result<Vec<String>, IpcError> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }
    let bin = super::video::find_ffmpeg(&app, &app.state::<crate::state::AppState>())?;
    let failed = |e: String| IpcError::new(ErrorCode::Io, text::record_audio_devices_failed(e));
    let dir = std::env::temp_dir().join("gitpervisor-rec");
    std::fs::create_dir_all(&dir).map_err(|e| failed(format!("{}: {e}", dir.display())))?;
    // 파이프로 받으면 다 읽기 전에 버퍼가 차 ffmpeg 가 멈출 수 있다 — 녹화 로그처럼 파일로 받는다.
    let log = dir.join(format!("{}.devices.log", uuid::Uuid::new_v4()));
    let stderr = std::fs::File::create(&log).map_err(|e| failed(format!("{}: {e}", log.display())))?;
    // `-loglevel error`(ffmpeg_cmd)를 붙이면 안 된다 — 장치 목록은 info 수준으로 찍힌다. 입력이 가짜라 종료 코드는 늘 실패다.
    let spawned = ffmpeg_raw(&bin.ffmpeg)
        .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&log);
            return Err(failed(format!("{}: {e}", bin.ffmpeg.display())));
        }
    };
    let done = wait_deadline(&mut child, DEVICE_LIST_LIMIT).is_some();
    if !done {
        let _ = child.kill();
        let _ = child.wait();
    }
    let raw = std::fs::read(&log);
    let _ = std::fs::remove_file(&log);
    if !done {
        return Err(IpcError::new(ErrorCode::Timeout, text::record_audio_devices_timeout(DEVICE_LIST_LIMIT.as_secs())));
    }
    let raw = raw.map_err(|e| failed(format!("{}: {e}", log.display())))?;
    // ffmpeg 는 장치 이름을 UTF-8 로 찍는다. 깨진 바이트를 치환해 넘기면 그 이름으로는 장치가 안 열린다.
    let out = String::from_utf8(raw).map_err(|e| failed(e.to_string()))?;
    Ok(parse_dshow_audio_devices(&out))
}

/// 저장 폴더를 비워 두면 쓰는 OS 기본 폴더 — 설정값은 보지 않는다(설정 화면의 자리표시용).
#[tauri::command(async)]
pub fn record_default_dirs() -> Result<RecordDefaultDirs, IpcError> {
    let shown = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    Ok(RecordDefaultDirs {
        screenshots: shown(super::favorites::screenshots_dir()),
        recordings: shown(os_recordings_dir()),
    })
}

/// 앱 종료 — 녹화 중이던 파일도 `q` 로 정상 마무리해 저장한다(설계 M-R1 수용 기준 7). `shutdown_children` 에서 부른다.
pub fn record_shutdown(app: &AppHandle) {
    finish(app, StopReason::User, None);
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: (i32, i32, u32, u32) = (-2560, 0, 2560, 1440);

    fn opts(fps: u32, draw_mouse: bool, audio: Option<&str>) -> RecordOptions {
        RecordOptions {
            fps,
            draw_mouse,
            audio: audio.map(String::from),
            countdown: 0,
            max_duration: Duration::from_secs(600),
        }
    }

    /// 영역 아래에 자리가 있으면 아래, 가운데 정렬 — 음수 원점 모니터에서도 가상 데스크톱 좌표로 돌려준다.
    #[test]
    fn bar_goes_below_the_region_centered() {
        assert_eq!(bar_position(MON, (1000, 200, 400, 300), (320, 44), 8), (-2560 + 1040, 508));
    }

    #[test]
    fn bar_goes_above_when_no_room_below() {
        assert_eq!(bar_position(MON, (1000, 1000, 400, 420), (320, 44), 8), (-2560 + 1040, 948));
    }

    /// 전체 화면이면 안쪽 아래 — 바는 녹화에서 빠지므로 결과물엔 안 찍힌다. 오른쪽 끝을 넘지 않는다.
    #[test]
    fn bar_goes_inside_for_fullscreen_and_stays_on_screen() {
        assert_eq!(bar_position(MON, (0, 0, 2560, 1440), (320, 44), 8), (-2560 + 1120, 1388));
        assert_eq!(bar_position(MON, (2500, 100, 60, 60), (320, 44), 8), (-2560 + 2240, 168));
    }

    /// ddagrab 은 모니터 로컬 좌표, gdigrab 은 가상 데스크톱 좌표 — 섞으면 다른 모니터 쪽이 찍힌다.
    #[test]
    fn input_args_use_the_right_coordinate_space() {
        let src = Source { output_idx: Some(2), vx: -2460, vy: 50, ox: 100, oy: 50, w: 640, h: 360 };
        let dda = record_args(Pipeline::DdaNvenc, &src, &opts(60, true, None)).join(" ");
        assert!(dda.contains("output_idx=2:framerate=60:offset_x=100:offset_y=50:video_size=640x360:draw_mouse=1"), "{dda}");
        let gdi = record_args(Pipeline::GdiX264, &src, &opts(60, true, None)).join(" ");
        assert!(gdi.contains("-framerate 30") && gdi.contains("-offset_x -2460 -offset_y 50 -video_size 640x360"), "{gdi}");
        // 출력 번호를 못 찾았으면 ddagrab 조합이어도 gdigrab 인자가 나간다.
        let none = Source { output_idx: None, ..src };
        assert!(record_args(Pipeline::DdaNvenc, &none, &opts(60, true, None)).join(" ").contains("gdigrab"));
    }

    /// GPU 는 설정 fps 그대로, CPU(x264·gdigrab)는 30 이 상한.
    #[test]
    fn fps_is_capped_at_30_for_cpu_pipelines() {
        let src = Source { output_idx: Some(0), vx: 0, vy: 0, ox: 0, oy: 0, w: 640, h: 360 };
        let dda = |p: Pipeline, fps| record_args(p, &src, &opts(fps, true, None)).join(" ");
        assert!(dda(Pipeline::DdaNvenc, 60).contains("framerate=60:"));
        assert!(dda(Pipeline::DdaNvenc, 30).contains("framerate=30:"));
        assert!(dda(Pipeline::DdaX264, 60).contains("framerate=30:"));
        assert!(dda(Pipeline::GdiX264, 60).contains("-framerate 30 "));
        assert!(dda(Pipeline::GdiX264, 30).contains("-framerate 30 "));
    }

    #[test]
    fn draw_mouse_reaches_both_grabbers() {
        let src = Source { output_idx: Some(0), vx: 0, vy: 0, ox: 0, oy: 0, w: 640, h: 360 };
        for (mouse, flag) in [(true, "1"), (false, "0")] {
            let dda = record_args(Pipeline::DdaNvenc, &src, &opts(60, mouse, None)).join(" ");
            assert!(dda.contains(&format!(":draw_mouse={flag}")), "{dda}");
            let gdi = record_args(Pipeline::GdiX264, &src, &opts(60, mouse, None)).join(" ");
            assert!(gdi.contains(&format!("-draw_mouse {flag} ")), "{gdi}");
        }
    }

    /// 오디오는 영상 입력 **뒤**의 두 번째 입력이고, 장치 이름은 따옴표 없이 argv 한 칸이다. 없으면 흔적도 없다.
    #[test]
    fn audio_device_adds_a_second_input_and_aac() {
        let src = Source { output_idx: Some(0), vx: 0, vy: 0, ox: 0, oy: 0, w: 640, h: 360 };
        let name = "마이크 배열(Realtek(R) Audio)";
        let a = record_args(Pipeline::DdaNvenc, &src, &opts(60, true, Some(name)));
        let at = |s: &str| a.iter().position(|x| x == s).unwrap_or_else(|| panic!("{s} 없음: {a:?}"));
        let dev = at(&format!("audio={name}"));
        assert_eq!(&a[dev - 5..dev], ["-f", "dshow", "-audio_buffer_size", "50", "-i"]);
        assert!(a[..dev - 5].iter().any(|x| x.starts_with("ddagrab=")), "영상 입력이 먼저: {a:?}");
        assert!(at("-c:v") > dev);
        let ca = at("-c:a");
        assert_eq!(&a[ca..ca + 4], ["-c:a", "aac", "-b:a", "160k"]);

        let silent = record_args(Pipeline::DdaNvenc, &src, &opts(60, true, None));
        assert!(!silent.iter().any(|x| x == "dshow" || x == "-c:a"), "{silent:?}");
    }

    /// 실측 출력(2026-11-10 이 개발기) — 웹캠·대체 이름 줄은 빠지고 한글 장치 이름이 그대로 나온다.
    #[test]
    fn parses_dshow_audio_devices() {
        let out = concat!(
            "[dshow @ 000002014e704a40] \"ASUS FHD webcam\" (video)\r\n",
            "[dshow @ 000002014e704a40]   Alternative name \"@device_pnp_\\\\?\\usb#vid_3277&pid_0018&mi_00#6&1391d9d&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global\"\r\n",
            "[dshow @ 000002014e704a40] \"마이크 배열(Realtek(R) Audio)\" (audio)\r\n",
            "[dshow @ 000002014e704a40]   Alternative name \"@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{790F4550-0234-4F82-9A68-1BEE18DBBE4F}\"\r\n",
            "[dshow @ 000002014e704a40] \"스테레오 믹스(Realtek(R) Audio)\" (audio)\r\n",
            "[dshow @ 000002014e704a40] \"Capture Card\" (audio, video)\r\n",
            "[dshow @ 000002014e704a40] \"Odd\" (none)\r\n",
            "Error opening input file dummy.\r\n",
        );
        assert_eq!(
            parse_dshow_audio_devices(out),
            ["마이크 배열(Realtek(R) Audio)", "스테레오 믹스(Realtek(R) Audio)", "Capture Card"]
        );
        assert!(parse_dshow_audio_devices("").is_empty());
    }

    /// 작은따옴표는 `'\''` — 그대로 두면 ffmpeg 가 경로를 거기서 끊는다. 역슬래시는 손대지 않는다.
    #[test]
    fn concat_list_escapes_single_quotes() {
        let parts = [PathBuf::from(r"C:\Temp\gitpervisor-rec\a-1.mp4"), PathBuf::from(r"C:\Users\it's\a-2.mp4")];
        assert_eq!(
            concat_list(&parts),
            "file 'C:\\Temp\\gitpervisor-rec\\a-1.mp4'\nfile 'C:\\Users\\it'\\''s\\a-2.mp4'\n"
        );
    }

    #[test]
    fn options_from_settings_fix_out_of_range_values() {
        let d = RecordOptions::from_settings(&Settings::default());
        assert_eq!(d, RecordOptions { fps: 60, draw_mouse: true, audio: None, countdown: 3, max_duration: Duration::from_secs(600) });

        let mut s = Settings::default();
        for (fps, want) in [(30, 30), (60, 60), (45, 60), (0, 60), (120, 60)] {
            s.record_fps = fps;
            assert_eq!(RecordOptions::from_settings(&s).fps, want, "fps {fps}");
        }
        for (secs, want) in [(0, 0), (5, 5), (10, 10), (99, 10)] {
            s.record_countdown_secs = secs;
            assert_eq!(RecordOptions::from_settings(&s).countdown, want, "countdown {secs}");
        }
        for (min, want) in [(0, 1), (1, 1), (30, 30), (120, 120), (500, 120)] {
            s.record_max_minutes = min;
            assert_eq!(RecordOptions::from_settings(&s).max_duration, Duration::from_secs(want * 60), "minutes {min}");
        }
        s.record_audio_device = Some("   ".into());
        assert_eq!(RecordOptions::from_settings(&s).audio, None);
        s.record_audio_device = Some("마이크 배열(Realtek(R) Audio)".into());
        assert_eq!(RecordOptions::from_settings(&s).audio.is_some(), cfg!(windows));
        s.record_draw_mouse = false;
        assert!(!RecordOptions::from_settings(&s).draw_mouse);
    }

    /// 옛 settings.json(녹화 키 없음)도 그대로 읽히고 기본값이 채워진다.
    #[test]
    fn old_settings_json_gets_record_defaults() {
        let s: Settings = serde_json::from_str(r#"{"theme":"nord","captureAutoSave":false}"#).unwrap();
        assert_eq!((s.record_fps, s.record_countdown_secs, s.record_max_minutes), (60, 3, 10));
        assert!(s.record_draw_mouse && s.capture_save_dir.is_none() && s.record_audio_device.is_none());
    }

    /// 테두리는 영역 바깥 — 150% 배율이면 사방 3px.
    #[test]
    fn frame_surrounds_the_region() {
        assert_eq!(frame_rect((-2460, 50, 640, 360), 1.5), (-2463, 47, 646, 366));
        assert_eq!(frame_rect((0, 0, 100, 100), 1.0), (-2, -2, 104, 104));
    }
}
