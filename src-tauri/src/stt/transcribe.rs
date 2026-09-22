// 전사 잡(태스크 72 §3.1) — `video_export` 잡 틀을 그대로 쓴다: 프론트 생성 job id(uuid 검증) · `state.video`
// 레지스트리에 **spawn 전** 등록(앱 종료 때 `video_kill_all`이 거둔다) · 진행 이벤트 `stt://progress` ·
// 종결 이벤트 `stt://finished`는 모든 결과에 한 곳에서.
//
//   1. ffprobe → 길이·start_time·오디오 유무
//   2. [extract]    ffmpeg → 앱 데이터 stt/gpv-stt-<job>.wav (16kHz mono s16le)   진행 0~10%
//   3. [transcribe] whisper-cli --vad -nfa -dtw -ojf -pp                           진행 10~95%
//   4. [parse]      -ojf + stderr VAD 대응표 → CaptionDoc → 앱 데이터에 저장
//   5. 임시 WAV·JSON은 결과와 무관하게 Drop 가드로 지운다
//
// **whisper-cli는 cwd = 앱 데이터 폴더, 인자는 ASCII 상대 경로로만** 준다. b5130 Windows 빌드는 ANSI
// `main(argc, argv)`라 비ASCII 경로가 시스템 코드 페이지로 깨진다(2026-09-22 실측: 한글 폴더의 모델을
// `'�ѱ۰��/m.bin'`으로 읽고 exit 127). 사용자 이름이 한글이면 앱 데이터 경로 전체가 그렇다. 그래서 임시
// 파일도 설계의 캐시 폴더가 아니라 모델과 같은 앱 로컬 데이터 폴더 아래(`stt/`)에 둔다.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::process::Command;
use tokio::sync::oneshot;

use crate::commands::{JobGuard, VideoJob};
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::llm::acquire as llm_acquire;
use crate::state::AppState;
use crate::stt::acquire::{self, WhisperBin, VAD_MODEL};
use crate::stt::doc::{build_doc, strip_invisible, DocEngine, DocSource};
use crate::stt::store::{self, CaptionLoaded};
use crate::stt::whisper_json::{parse_vad_line, parse_whisper_json, VadSpan, WhisperParseError};

/// 앱 로컬 데이터 폴더 아래 임시 폴더(위 머리 주석의 ANSI argv 이유).
/// 편집본 내보내기의 긴 필터 그래프 파일(commands/video.rs)도 여기 둔다 — 고아 청소를 같이 탄다.
pub(crate) const TEMP_DIR: &str = "stt";
pub(crate) const TEMP_PREFIX: &str = "gpv-stt-";
/// 16kHz mono s16le = 32KB/s(1시간 ≈ 115MB).
const WAV_BYTES_PER_SEC: u64 = 32_000;
const PROMPT_MAX_CHARS: usize = 500;
const TAIL_LINES: usize = 80;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeReq {
    pub job_id: String,
    pub project_id: String,
    pub rel_path: String,
    pub model_id: String,
    pub language: String,
    #[serde(default)]
    pub prompt: Option<String>,
    /// 전사할 오디오 트랙 — ffmpeg `-map 0:a:<n>`(probe `audioStreams[].index`). OBS 다중 트랙 녹화에서 마이크 트랙만
    /// 고를 때. 문서에 남아 편집본·자막 입힌 영상 내보내기도 이 트랙의 소리를 쓴다.
    #[serde(default)]
    pub audio_stream: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SttPhase {
    Extract,
    Transcribe,
    Parse,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SttProgress {
    job_id: String,
    phase: SttPhase,
    /// 전체 진행(0~100) — 정수가 바뀔 때만 보낸다.
    percent: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SttFinished {
    job_id: String,
    ok: bool,
    /// 취소는 실패 토스트를 띄우지 않는다(ExportFinished와 같은 이유).
    cancelled: bool,
    error: Option<String>,
}

fn io(m: String) -> IpcError {
    IpcError::new(ErrorCode::Io, m)
}

// ══════════════════════════ 앱 전체에서 전사 하나 ══════════════════════════

/// (job_id, model_id). 두 번째 전사는 Busy — CPU를 이미 절반 쓰는 잡이 둘이면 터미널까지 느려진다(태스크 71).
static ACTIVE: Mutex<Option<(String, String)>> = Mutex::new(None);

#[derive(Debug)]
struct ActiveGuard;

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

fn begin_active(job_id: &str, model_id: &str) -> Result<ActiveGuard, IpcError> {
    let mut a = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if a.is_some() {
        return Err(IpcError::new(ErrorCode::Busy, text_stt::stt_already_running()));
    }
    *a = Some((job_id.to_string(), model_id.to_string()));
    Ok(ActiveGuard)
}

/// 지금 전사에 쓰이는 모델 id — 모델 삭제가 Busy를 판정한다.
pub(crate) fn active_model() -> Option<String> {
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|(_, m)| m.clone())
}

/// 임시 파일 — 성공·실패·취소·패닉 어느 쪽으로 끝나도 지운다. 지우지 못한 것은 `sweep_stale_temp`가 거둔다.
/// 폴더(번인 ASS 폴더, stt/video_subs.rs)는 앞 항목의 파일을 지운 **뒤** 비었을 때만 지운다(순서대로 처리한다).
pub(crate) struct TempFiles(pub(crate) Vec<PathBuf>);

impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let r = if p.is_dir() { std::fs::remove_dir(p) } else { std::fs::remove_file(p) };
            // 없으면 정상(그 단계 전에 끝났다).
            if let Err(e) = r {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("[stt] 임시 파일 삭제 실패 {}: {e}", p.display());
                }
            }
        }
    }
}

/// 앱 로컬 데이터 `stt/`(없으면 만든다) — 전사 임시 파일·편집본의 긴 필터 그래프·자막 입힌 영상의 자막 파일.
pub(crate) fn temp_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| io(text_stt::stt_app_data_path_error(&e)))?
        .join(TEMP_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| io(text_stt::stt_temp_dir_create_failed(&dir.display(), &e)))?;
    Ok(dir)
}

/// 앱이 전사 중에 죽으면 남는 WAV(1시간 ≈ 115MB)를 거둔다. **하루 넘은 것만** — e2e 샤드는 앱 로컬 데이터
/// 폴더를 공유해서 방금 만든 남의 파일일 수 있다(와일드카드 삭제 사고, 메모리 노트).
pub(crate) fn sweep_stale_temp(app: &AppHandle) {
    if ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        return;
    }
    let Ok(dir) = app.path().app_local_data_dir().map(|d| d.join(TEMP_DIR)) else { return };
    // 폴더가 없으면 전사한 적이 없다.
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let day = std::time::Duration::from_secs(24 * 3600);
    for e in entries.flatten() {
        let meta = e.metadata().ok();
        let old = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
        if old && e.file_name().to_str().is_some_and(|n| n.starts_with(TEMP_PREFIX)) {
            // 번인 ASS 폴더(`gpv-stt-burn-<uuid>/`)는 폴더째 — 우리 접두어·하루 지난 것만이라 남의 파일이 아니다.
            let r = if meta.is_some_and(|m| m.is_dir()) {
                std::fs::remove_dir_all(e.path())
            } else {
                std::fs::remove_file(e.path())
            };
            if let Err(err) = r {
                log::warn!("[stt] 고아 임시 파일 삭제 실패 {}: {err}", e.path().display());
            }
        }
    }
}

// ══════════════════════════ 입력 검증·인자 (순수) ══════════════════════════

/// whisper `-l` 값 — "auto" 또는 소문자 2~3자 코드. `-l`은 **항상** 넘긴다(기본값이 en이라 한국어가 영어로 나온다).
pub(crate) fn validate_language(lang: &str) -> Result<String, IpcError> {
    let l = lang.trim().to_ascii_lowercase();
    let ok = l == "auto" || ((2..=3).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase()));
    if ok {
        Ok(l)
    } else {
        Err(io(text_stt::stt_unsupported_language(lang)))
    }
}

/// 용어 힌트(`--prompt`) — 보이지 않는 문자 제거·한 줄·500자 이하. `windows_argv`면 ASCII만: whisper-cli가
/// Windows에서 명령줄을 시스템 코드 페이지로 읽어 한글 힌트가 엉뚱한 바이트가 된다(머리 주석의 실측과 같은 원인).
pub(crate) fn validate_prompt(prompt: Option<&str>, windows_argv: bool) -> Result<Option<String>, IpcError> {
    let Some(p) = prompt else { return Ok(None) };
    let p = strip_invisible(p).replace('\n', " ").trim().to_string();
    if p.is_empty() {
        return Ok(None);
    }
    if p.chars().count() > PROMPT_MAX_CHARS {
        return Err(io(text_stt::stt_prompt_too_long(PROMPT_MAX_CHARS)));
    }
    if windows_argv && !p.is_ascii() {
        return Err(io(text_stt::stt_prompt_ascii_only().into()));
    }
    Ok(Some(p))
}

/// 스레드 기본값 `min(8, 논리 코어/2)` — 태스크 71(부하 중 타이핑)과 겹치지 않게 코어를 다 쓰지 않는다.
fn default_threads() -> usize {
    // 코어 수를 모르면 보수적으로 1(= 2/2).
    let logical = std::thread::available_parallelism().map_or(2, |n| n.get());
    (logical / 2).clamp(1, 8)
}

/// 추출 인자 — `audio_stream`번째 오디오 스트림(`0:a:<n>`)을 16kHz mono s16le WAV로. 입력이 출력보다 앞.
///
/// **WAV 0초 = 컨테이너 `format.start_time`**(문서 시각의 기준, §3.3). 오디오가 영상보다 늦게 시작하는 파일(방송 TS·
/// OBS 녹화)은 그 앞을 무음으로 채운다 — 안 채우면 whisper 시각이 그 차이만큼 이르게 나와 오버레이·컷 구간·편집본
/// SRT가 전부 어긋난다(2026-09-22 실측: 오디오 0.976초 늦은 mp4에서 WAV가 첫 오디오 표본부터 시작).
/// - `-copyts`: 기본 동작은 TS 같은 불연속 형식에서 시각을 **켠 스트림**(여기선 오디오뿐)의 시작으로 옮긴다
///   (8.0 실측: 영상 2.8초·오디오 4.189초 TS의 첫 오디오 pts가 0). 편집본 내보내기는 영상·오디오를 둘 다 켜
///   format.start_time 기준이 되므로, 절대 시각을 받아 `first_pts`로 format.start_time부터 채운다.
/// - 16kHz 변환과 채우기를 aresample 둘로 나눈다: 한 인스턴스에서 표본률을 바꾸며 채우면 `first_pts`가 입력
///   표본률 단위로 읽힌다(실측: 2.8초를 44.1kHz 기준 1.016초로 읽어 1.8초를 더 채웠다).
pub(crate) fn build_stt_audio_args(src: &str, wav: &str, start_time_ms: i64, audio_stream: u32) -> Vec<String> {
    // 1ms = 16표본(16kHz). 음수 start_time(Opus webm −7ms)은 첫 pts와 같아 채울 것이 없다.
    let pad = format!("aresample=16000,aresample=async=1:first_pts={}", start_time_ms * 16);
    let map = format!("0:a:{audio_stream}");
    [
        "-hide_banner", "-nostdin", "-y", "-nostats", "-progress", "pipe:1",
        "-copyts", "-i", src,
        "-map", &map, "-vn", "-af", &pad, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav,
    ]
    .map(String::from)
    .to_vec()
}

pub(crate) struct WhisperArgs<'a> {
    pub model: &'a str,
    pub vad_model: &'a str,
    pub wav: &'a str,
    /// 확장자 없는 출력 경로. **절대 `-`가 아니다** — `-of -`면 진행률이 꺼진다(§2.2).
    pub out_stem: &'a str,
    pub language: &'a str,
    pub prompt: Option<&'a str>,
    pub threads: usize,
    pub dtw: &'a str,
    /// 깨진 UTF-8 재시도용 greedy(`-bs 1 -bo 1`) — 실측에서 greedy는 깨끗했다(§2.2).
    pub greedy: bool,
}

/// whisper-cli 인자(부록 B 판정): VAD + `-nfa -dtw`(단어 시각 방식 d). `-np`는 넣지 않는다 — stderr의 VAD
/// 대응표까지 사라진다(부록 B.3).
pub(crate) fn build_whisper_args(a: &WhisperArgs) -> Vec<String> {
    let mut v: Vec<String> = [
        "-m", a.model, "-f", a.wav, "-l", a.language,
        "--vad", "-vm", a.vad_model,
        "-nfa", "-dtw", a.dtw,
        "-sns", "-ojf", "-pp",
        "-of", a.out_stem,
    ]
    .map(String::from)
    .to_vec();
    v.extend(["-t".into(), a.threads.to_string()]);
    if a.greedy {
        v.extend(["-bs", "1", "-bo", "1"].map(String::from));
    }
    if let Some(p) = a.prompt {
        v.extend(["--prompt".into(), p.to_string()]);
    }
    v
}

/// `whisper_print_progress_callback: progress =  44%` → 44.
pub(crate) fn parse_whisper_progress(line: &str) -> Option<u32> {
    let v: u32 = line.split_once("progress =")?.1.trim().strip_suffix('%')?.trim().parse().ok()?;
    (v <= 100).then_some(v)
}

/// whisper-cli에 넘길 상대 경로(위 머리 주석) — `base` 아래 ASCII여야 한다.
fn rel_arg(base: &Path, p: &Path) -> Result<String, IpcError> {
    p.strip_prefix(base)
        .ok()
        .and_then(|r| r.to_str())
        .filter(|s| s.is_ascii())
        .map(|s| s.replace('\\', "/"))
        .ok_or_else(|| io(text_stt::stt_path_not_ascii(&p.display())))
}

// ══════════════════════════ 프로세스 한 단계 ══════════════════════════

pub(crate) struct StepOut {
    pub ok: bool,
    pub stderr_tail: String,
    /// stderr의 `vad_segment_info` 줄 전부(긴 파일은 수천 줄이라 tail과 따로 모은다).
    pub vad_lines: Vec<String>,
}

/// 파이프 한 줄씩 — 안 읽으면 파이프가 차서 자식이 멈춘다. 진행률·진단용이라 lossy로 읽는다(자막 텍스트는
/// JSON 파일에서 엄격하게 읽는다). whisper stdout에는 인식 텍스트가 흘러 깨진 UTF-8일 수 있어 `lines()`를
/// 쓰지 않는다 — 그건 첫 깨진 줄에서 읽기를 멈춰 결국 자식을 멈춰 세운다.
fn read_lines<R>(
    r: Option<R>,
    mut on_line: impl FnMut(&str) + Send + 'static,
) -> tokio::task::JoinHandle<(VecDeque<String>, Vec<String>)>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut tail = VecDeque::with_capacity(TAIL_LINES);
        let mut vad = Vec::new();
        let Some(r) = r else { return (tail, vad) };
        let mut rd = tokio::io::BufReader::new(r);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match rd.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => {
                    // 파이프 오류는 결과를 바꾸지 않는다 — 성패는 종료 코드가 정한다.
                    log::warn!("[stt] 출력 파이프 읽기 실패: {e}");
                    break;
                }
            }
            let line = String::from_utf8_lossy(&buf);
            let line = line.trim_end();
            on_line(line);
            if line.contains("vad_segment_info:") {
                vad.push(line.to_string());
            }
            if tail.len() >= TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line.to_string());
        }
        (tail, vad)
    })
}

/// 프로세스 하나를 끝까지 — video_export와 같은 스폰 규약(args 배열, CREATE_NO_WINDOW, process_group(0),
/// kill_on_drop, 파이프 드레인, select!로 종료·취소 경합, 반드시 wait).
async fn run_step(
    mut cmd: Command,
    what: &str,
    jobs: &Arc<Mutex<HashMap<String, VideoJob>>>,
    job_id: &str,
    cancel_rx: &mut oneshot::Receiver<()>,
    on_stdout: impl FnMut(&str) + Send + 'static,
    on_stderr: impl FnMut(&str) + Send + 'static,
) -> Result<StepOut, IpcError> {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = cmd.spawn().map_err(|e| io(text_stt::stt_process_spawn_failed(what, &e)))?;
    let set_pid = |pid: Option<u32>| {
        if let Some(j) = jobs.lock().unwrap_or_else(|e| e.into_inner()).get_mut(job_id) {
            j.pid = pid;
        }
    };
    set_pid(child.id());
    let out_task = read_lines(child.stdout.take(), on_stdout);
    let err_task = read_lines(child.stderr.take(), on_stderr);

    let mut cancelled = false;
    let status = tokio::select! {
        s = child.wait() => s,
        _ = &mut *cancel_rx => {
            cancelled = true;
            let _ = child.start_kill();
            child.wait().await
        }
    }
    .map_err(|e| io(text_stt::stt_process_wait_failed(what, &e)));
    // 끝난 자식의 pid를 레지스트리에 남기지 않는다 — Child를 놓으면 핸들이 닫혀 OS가 pid를 다시 쓸 수 있는데,
    // 잡은 파싱·저장(1시간 영상의 -ojf는 수십 MB)이 끝나야 빠진다. 그 사이 앱을 끄면 video_kill_all이 남의
    // 프로세스 트리를 taskkill /T·killpg 한다.
    set_pid(None);
    let status = status?;
    let join = |r: Result<(VecDeque<String>, Vec<String>), tokio::task::JoinError>| {
        r.unwrap_or_else(|e| {
            log::warn!("[stt] {what} 출력 리더가 끝나지 못했습니다: {e}");
            Default::default()
        })
    };
    let (tail, vad_lines) = join(err_task.await);
    join(out_task.await);
    if cancelled {
        return Err(IpcError::new(ErrorCode::Cancelled, text_stt::stt_cancelled()));
    }
    Ok(StepOut { ok: status.success(), stderr_tail: Vec::from(tail).join("\n"), vad_lines })
}

/// 단계 사이(파싱·저장 직전)의 취소 확인 — select! 밖에서 온 취소를 놓치지 않는다.
fn check_cancel(cancel_rx: &mut oneshot::Receiver<()>) -> Result<(), IpcError> {
    match cancel_rx.try_recv() {
        Err(oneshot::error::TryRecvError::Empty) => Ok(()),
        _ => Err(IpcError::new(ErrorCode::Cancelled, text_stt::stt_cancelled())),
    }
}

/// 실패한 명령을 남긴다 — 토스트는 stderr 마지막 한 줄뿐이라 어떤 인자로 죽었는지 사후에 알 길이 없다.
fn step_failed(what: &str, exe: &Path, args: &[String], step: StepOut) -> IpcError {
    log::error!(
        "[stt] {what} 실패\n  exe: {}\n  args: {:?}\n  stderr(tail):\n{}", // i18n-ok: 로그
        exe.display(),
        args,
        step.stderr_tail
    );
    IpcError {
        code: ErrorCode::Io,
        message: text_stt::stt_step_failed(what, &crate::commands::last_error_line(&step.stderr_tail)),
        stderr: Some(step.stderr_tail),
    }
}

fn progress_emitter(app: &AppHandle, job_id: &str, phase: SttPhase, lo: u32, hi: u32) -> impl FnMut(u32) + Send + 'static {
    let (app, job_id) = (app.clone(), job_id.to_string());
    let mut last = u32::MAX;
    move |p| {
        let percent = lo + (hi - lo) * p.min(100) / 100;
        if percent != last {
            last = percent;
            let _ = app.emit("stt://progress", SttProgress { job_id: job_id.clone(), phase, percent });
        }
    }
}

struct WhisperRun<'a> {
    app: &'a AppHandle,
    bin: &'a WhisperBin,
    base: &'a Path,
    jobs: &'a Arc<Mutex<HashMap<String, VideoJob>>>,
    job_id: &'a str,
}

impl WhisperRun<'_> {
    /// whisper-cli 한 번 → (JSON 바이트, VAD 대응표).
    async fn run(
        &self,
        args: &WhisperArgs<'_>,
        json_abs: &Path,
        cancel_rx: &mut oneshot::Receiver<()>,
    ) -> Result<(Vec<u8>, Vec<VadSpan>), IpcError> {
        let argv = build_whisper_args(args);
        // 리눅스: 수백 MB 모델을 수 분간 앱 cgroup에 올리면 2026-08 oomd 사고와 같은 조건이다 — scope 위임.
        let (program, prefix) = crate::llm::server::systemd_scope_wrap(&self.bin.exe);
        let mut cmd = Command::new(program);
        cmd.args(prefix).args(&argv).current_dir(self.base);
        let mut emit = progress_emitter(self.app, self.job_id, SttPhase::Transcribe, 10, 95);
        emit(0);
        let step = run_step(cmd, "whisper-cli", self.jobs, self.job_id, cancel_rx, |_| {}, move |l| {
            if let Some(p) = parse_whisper_progress(l) {
                emit(p);
            }
        })
        .await?;
        if !step.ok {
            return Err(step_failed(text_stt::stt_step_speech_recognition(), &self.bin.exe, &argv, step));
        }
        let vad = step.vad_lines.iter().filter_map(|l| parse_vad_line(l)).collect();
        let bytes = std::fs::read(json_abs)
            .map_err(|e| io(text_stt::stt_result_read_failed(&json_abs.display(), &e)))?;
        Ok((bytes, vad))
    }
}

// ══════════════════════════ 커맨드 ══════════════════════════

/// 종결 이벤트는 **모든** 결과에 대해 여기 한 곳에서 보낸다(검증·발견·스폰 실패까지) — 프론트는 invoke 응답과
/// 이 이벤트 중 먼저 온 쪽을 한 번만 처리한다(Windows 응답 유실, videoSplit.ts 패턴).
#[tauri::command(async)]
pub async fn stt_transcribe(
    app: AppHandle,
    state: State<'_, AppState>,
    req: TranscribeReq,
) -> Result<CaptionLoaded, IpcError> {
    let outcome = transcribe_inner(&app, &state, &req).await;
    let cancelled = matches!(&outcome, Err(e) if e.code == ErrorCode::Cancelled);
    let _ = app.emit(
        "stt://finished",
        SttFinished {
            job_id: req.job_id.clone(),
            ok: outcome.is_ok(),
            cancelled,
            error: outcome.as_ref().err().map(|e| e.message.clone()),
        },
    );
    outcome
}

/// 멱등 취소 — `video_export_cancel`과 같은 레지스트리 함수(검색성을 위한 얇은 래퍼).
#[tauri::command(async)]
pub fn stt_transcribe_cancel(state: State<'_, AppState>, job_id: String) -> Result<(), IpcError> {
    crate::commands::video_export_cancel(state, job_id)
}

async fn transcribe_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    req: &TranscribeReq,
) -> Result<CaptionLoaded, IpcError> {
    // 1. 입력 경계 — job id는 임시 파일 이름에 들어가므로 uuid로 검증한다.
    let job = uuid::Uuid::parse_str(&req.job_id)
        .map_err(|_| io(text_stt::stt_invalid_job_id(&req.job_id)))?
        .simple()
        .to_string();
    let model = acquire::stt_model(&req.model_id).ok_or_else(|| {
        IpcError::new(ErrorCode::NotFound, text_stt::stt_unknown_model(&req.model_id))
    })?;
    let language = validate_language(&req.language)?;
    let prompt = validate_prompt(req.prompt.as_deref(), cfg!(windows))?;
    let _active = begin_active(&req.job_id, model.spec.id)?;

    // 취소 등록은 느린 단계(비관리 엔진의 첫 확인은 최대 40초·ffprobe) **전** — 그 사이 누른 취소가 레지스트리에
    // 없는 id로 가면 조용히 버려지고, 전사가 끝까지 돌아 문서를 덮는다. spawn 전 등록이기도 하다(invoke 응답이
    // 유실돼도 등록된 id로 취소할 수 있다 — video_export 정책).
    let jobs = {
        let reg = state.video.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(&reg.jobs)
    };
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    jobs.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(req.job_id.clone(), VideoJob { cancel: Some(cancel_tx), pid: None });
    let _guard = JobGuard { jobs: Arc::clone(&jobs), job_id: req.job_id.clone() };

    let not_ready = |m: String| IpcError::new(ErrorCode::ToolNotFound, m);
    let bin = acquire::find_whisper(app)
        .ok_or_else(|| not_ready(text_stt::stt_engine_missing().into()))?;
    let build = {
        let bin = bin.clone();
        tauri::async_runtime::spawn_blocking(move || acquire::ensure_usable(&bin))
            .await
            .map_err(|e| io(text_stt::stt_engine_check_task_failed(&e)))??
    };
    check_cancel(&mut cancel_rx)?;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| io(text_stt::stt_app_data_path_error(&e)))?;
    let model_path = llm_acquire::installed_model(app, &model.spec)
        .ok_or_else(|| not_ready(text_stt::stt_model_missing(model.spec.label)))?;
    let vad_path = llm_acquire::installed_model(app, &VAD_MODEL)
        .ok_or_else(|| not_ready(text_stt::stt_vad_model_missing().into()))?;
    let (model_rel, vad_rel) = (rel_arg(&base, &model_path)?, rel_arg(&base, &vad_path)?);

    let ff = crate::commands::find_ffmpeg(app, state.inner())?;
    let probe = crate::commands::need_probe(&ff)?;
    let repo = crate::commands::project_path(state, &req.project_id)?;
    let src = crate::commands::resolve_in_repo(&repo, &req.rel_path)?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, text_stt::stt_source_not_found()));
    }
    let src_s = src.display().to_string();
    let meta = crate::commands::probe_meta(&probe, &src_s).await?;
    if !meta.has_audio {
        return Err(io(text_stt::stt_no_audio_track().into()));
    }
    if req.audio_stream as usize >= meta.audio_streams.len() {
        return Err(io(text_stt::stt_audio_track_missing(req.audio_stream + 1, meta.audio_streams.len())));
    }
    if meta.duration_ms == 0 {
        return Err(io(text_stt::stt_unknown_duration().into()));
    }
    let (size_bytes, mtime_ms) = store::file_stamp(&src)
        .ok_or_else(|| io(text_stt::stt_source_stat_failed(&src.display())))?;

    // 2. 공간 · 임시 파일
    let tmp_dir = temp_dir(app)?;
    llm_acquire::check_free_space(&tmp_dir, meta.duration_ms * WAV_BYTES_PER_SEC / 1000 + 16 * 1024 * 1024)?;
    let stem = format!("{TEMP_PREFIX}{job}");
    let wav_abs = tmp_dir.join(format!("{stem}.wav"));
    let json_abs = tmp_dir.join(format!("{stem}.json"));
    let _files = TempFiles(vec![wav_abs.clone(), json_abs.clone()]);
    check_cancel(&mut cancel_rx)?;

    let threads = default_threads();
    log::info!(
        "[stt] 전사 시작 job={} model={} lang={language} threads={threads} dur={}ms engine={} ({:?})", // i18n-ok: 로그
        req.job_id,
        model.spec.id,
        meta.duration_ms,
        bin.exe.display(),
        bin.source,
    );

    // 3. [extract]
    let audio_args =
        build_stt_audio_args(&src_s, &wav_abs.display().to_string(), meta.start_time_ms, req.audio_stream);
    let mut cmd = Command::new(&ff.ffmpeg);
    cmd.args(&audio_args);
    let mut emit = progress_emitter(app, &req.job_id, SttPhase::Extract, 0, 10);
    emit(0);
    let dur_us = meta.duration_ms * 1000;
    let step = run_step(cmd, "ffmpeg", &jobs, &req.job_id, &mut cancel_rx, move |l| {
        if let Some(us) = crate::commands::parse_out_time_us(l) {
            emit((us.min(dur_us) * 100 / dur_us) as u32);
        }
    }, |_| {})
    .await?;
    if !step.ok {
        return Err(step_failed(text_stt::stt_step_audio_extraction(), &ff.ffmpeg, &audio_args, step));
    }

    // 4. [transcribe] — 결과가 깨진 UTF-8이면 greedy로 한 번만 다시(§3.1).
    let wav_rel = format!("{TEMP_DIR}/{stem}.wav");
    let out_rel = format!("{TEMP_DIR}/{stem}");
    let mut args = WhisperArgs {
        model: &model_rel,
        vad_model: &vad_rel,
        wav: &wav_rel,
        out_stem: &out_rel,
        language: &language,
        prompt: prompt.as_deref(),
        threads,
        dtw: model.dtw,
        greedy: false,
    };
    let runner = WhisperRun { app, bin: &bin, base: &base, jobs: &jobs, job_id: &req.job_id };
    let (bytes, vad) = runner.run(&args, &json_abs, &mut cancel_rx).await?;
    let mut parse_progress = progress_emitter(app, &req.job_id, SttPhase::Parse, 95, 100);
    parse_progress(0);
    let parsed = match parse_whisper_json(&bytes, &vad, true) {
        Ok(out) => out,
        Err(WhisperParseError::InvalidUtf8) => {
            log::warn!("[stt] 인식 결과에 깨진 UTF-8 — greedy로 한 번 다시 인식 job={}", req.job_id);
            args.greedy = true;
            let (bytes, vad) = runner.run(&args, &json_abs, &mut cancel_rx).await?;
            // 그래도 깨지면 U+FFFD + cue suspect로 드러낸다(관대 모드는 InvalidUtf8을 내지 않는다).
            parse_whisper_json(&bytes, &vad, false).map_err(|e| io(text_stt::stt_result_parse_failed(&e)))?
        }
        Err(WhisperParseError::Malformed(m)) => return Err(io(m)),
    };
    check_cancel(&mut cancel_rx)?;

    // 5. [parse] → 문서 → 앱 데이터
    let doc = build_doc(
        DocSource {
            rel: store::normalize_rel(&req.rel_path),
            size_bytes,
            mtime_ms,
            duration_ms: meta.duration_ms,
            start_time_ms: meta.start_time_ms,
            audio_stream: req.audio_stream,
        },
        DocEngine {
            name: "whisper.cpp".into(),
            build,
            model_id: model.spec.id.to_string(),
            detected_language: if language == "auto" { parsed.detected_language } else { None },
            language,
            vad: true,
            prompt,
            word_timing: parsed.word_timing,
        },
        parsed.words,
    );
    let loaded = store::write_transcribed(app, &req.project_id, &req.rel_path, doc)?;
    log::info!(
        "[stt] 전사 완료 job={} cues={} tokens={} wordTiming={:?}", // i18n-ok: 로그
        req.job_id,
        loaded.doc.cues.len(),
        loaded.doc.tokens.len(),
        loaded.doc.engine.word_timing,
    );
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(greedy: bool, prompt: Option<&str>) -> Vec<String> {
        build_whisper_args(&WhisperArgs {
            model: "llm/models/ggml-large-v3-turbo-q5_0.bin",
            vad_model: "llm/models/ggml-silero-v6.2.0.bin",
            wav: "stt/gpv-stt-x.wav",
            out_stem: "stt/gpv-stt-x",
            language: "auto",
            prompt,
            threads: 4,
            dtw: "large.v3.turbo",
            greedy,
        })
    }

    fn value_after<'a>(v: &'a [String], flag: &str) -> Option<&'a str> {
        v.iter().position(|a| a == flag).and_then(|i| v.get(i + 1)).map(String::as_str)
    }

    #[test]
    fn stt_audio_args_are_mono_16k_wav_input_first() {
        let a = build_stt_audio_args("/in/a.mp4", "/tmp/o.wav", 0, 0);
        let joined = a.join(" ");
        assert!(joined.contains("-map 0:a:0 -vn"), "{joined}");
        // 고른 오디오 트랙(OBS 다중 트랙) — 오디오 스트림 안 순번.
        assert_eq!(value_after(&build_stt_audio_args("/in/a.mp4", "/tmp/o.wav", 0, 2), "-map"), Some("0:a:2"));
        assert!(joined.contains("-ac 1 -ar 16000 -c:a pcm_s16le -f wav"), "{joined}");
        let i = a.iter().position(|x| x == "/in/a.mp4").unwrap();
        let o = a.iter().position(|x| x == "/tmp/o.wav").unwrap();
        assert_eq!(a[i - 1], "-i");
        assert!(i < o && o == a.len() - 1, "입력이 출력보다 앞, 출력이 마지막");
        assert_eq!(value_after(&a, "-progress"), Some("pipe:1"));
    }

    /// WAV 0초 = format.start_time — 절대 시각(-copyts, 입력 옵션)을 받아 16kHz로 바꾼 **뒤** start_time부터 채운다.
    #[test]
    fn stt_audio_args_pad_from_container_start() {
        let a = build_stt_audio_args("/in/a.ts", "/tmp/o.wav", 2800, 0);
        let i = a.iter().position(|x| x == "-i").unwrap();
        assert!(a[..i].contains(&"-copyts".to_string()), "-copyts는 입력 옵션");
        assert_eq!(value_after(&a, "-af"), Some("aresample=16000,aresample=async=1:first_pts=44800"));
        assert_eq!(value_after(&build_stt_audio_args("a", "b", -7, 0), "-af"), Some("aresample=16000,aresample=async=1:first_pts=-112"));
    }

    /// 실제 ffmpeg(PATH): 오디오가 늦게 시작하는 mp4(`-itsoffset`)·TS에서 WAV 앞의 무음 = 오디오 시작 − format.start_time.
    /// 수정 전에는 둘 다 무음 없이 첫 오디오 표본부터였다(오버레이·컷이 그만큼 이르다).
    /// `cargo test --lib stt_audio_extract_real_ffmpeg -- --ignored --nocapture`
    #[test]
    #[ignore = "PATH의 ffmpeg·ffprobe 필요"]
    fn stt_audio_extract_real_ffmpeg_keeps_container_clock() {
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let ffprobe = crate::tools::runner::find_on_path("ffprobe").expect("ffprobe");
        let dir = std::env::temp_dir().join(format!("gpv-stt-offset-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |exe: &Path, args: &[&str]| {
            let o = std::process::Command::new(exe).args(args).output().unwrap();
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).into_owned()
        };
        // TS는 program·stream 두 곳에 같은 값을 찍는다 — 첫 값.
        let secs = |s: &str| -> f64 {
            let v = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            v.parse().unwrap_or_else(|_| panic!("숫자 아님: {s:?}"))
        };
        // (이름, 인코딩 인자) — 영상 5초 + 1초 늦은 사인 4초. TS는 불연속 형식이라 기본 동작이 다르다(위 인자 주석).
        let cases: [(&str, &[&str]); 2] = [
            ("off.mp4", &["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"]),
            ("off.ts", &["-c:v", "mpeg2video", "-c:a", "mp2", "-output_ts_offset", "1.4"]),
        ];
        for (name, enc) in cases {
            let src = dir.join(name).display().to_string();
            let mut gen = vec![
                "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=5",
                "-itsoffset", "1.0", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-map", "0:v", "-map", "1:a",
            ];
            gen.extend_from_slice(enc);
            gen.push(&src);
            run(&ffmpeg, &gen);
            let start = |sel: &str| {
                secs(&run(&ffprobe, &["-v", "error", "-select_streams", sel, "-show_entries", "stream=start_time", "-of", "csv=p=0", &src]))
            };
            let fmt_start = secs(&run(&ffprobe, &["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", &src]));
            let lead = start("a:0") - fmt_start;
            let wav = dir.join(format!("{name}.wav")).display().to_string();
            let args = build_stt_audio_args(&src, &wav, (fmt_start * 1000.0).round() as i64, 0);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            run(&ffmpeg, &args);
            // silencedetect는 stderr(info)에 찍는다 — 첫 무음 구간의 끝.
            let o = std::process::Command::new(&ffmpeg)
                .args(["-hide_banner", "-nostdin", "-i", &wav, "-af", "silencedetect=noise=-50dB:d=0.1", "-f", "null", "-"])
                .output()
                .unwrap();
            let log = String::from_utf8_lossy(&o.stderr);
            let silence_end = log
                .lines()
                .find_map(|l| l.split_once("silence_end: ").map(|(_, r)| secs(r.split(' ').next().unwrap_or(""))))
                .unwrap_or(0.0);
            println!("{name}: format.start={fmt_start} 오디오 앞 {lead:.3}s · WAV 앞 무음 {silence_end:.3}s");
            assert!(lead > 0.9, "{name}: 픽스처의 오디오가 늦게 시작하지 않는다({lead})");
            assert!((silence_end - lead).abs() < 0.06, "{name}: WAV 앞 무음 {silence_end} ≠ 오디오 지연 {lead}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `-l`은 항상(기본 en), `-of`는 절대 `-`가 아니다(진행률이 꺼진다), VAD·DTW·-ojf·-pp, `-np` 없음.
    #[test]
    fn stt_whisper_args_pin_the_contract() {
        let a = args(false, None);
        assert_eq!(value_after(&a, "-l"), Some("auto"));
        let of = value_after(&a, "-of").unwrap();
        assert_ne!(of, "-");
        assert!(!of.ends_with(".json"), "-of는 확장자 없는 경로");
        assert!(a.contains(&"--vad".to_string()));
        assert_eq!(value_after(&a, "-vm"), Some("llm/models/ggml-silero-v6.2.0.bin"));
        assert_eq!(value_after(&a, "-dtw"), Some("large.v3.turbo"));
        for f in ["-nfa", "-ojf", "-pp", "-sns"] {
            assert!(a.contains(&f.to_string()), "{f} 없음");
        }
        assert!(!a.contains(&"-np".to_string()), "-np는 VAD 대응표를 없앤다");
        assert!(!a.contains(&"-bs".to_string()), "기본은 beam");
        let g = args(true, Some("Gitpervisor"));
        assert_eq!(value_after(&g, "-bs"), Some("1"));
        assert_eq!(value_after(&g, "-bo"), Some("1"));
        assert_eq!(value_after(&g, "--prompt"), Some("Gitpervisor"));
        // 우리가 넘기는 플래그는 전부 비관리 바이너리 플래그 검사 목록에 있어야 한다 — 빠지면 옛 brew 빌드가
        // "unknown argument"로 죽는데 검사는 통과시킨다.
        for f in g.iter().filter(|x| x.starts_with('-')) {
            assert!(acquire::REQUIRED_FLAGS.contains(&f.as_str()), "{f} 가 플래그 검사 목록에 없다");
        }
    }

    #[test]
    fn stt_progress_line_parses() {
        assert_eq!(parse_whisper_progress("whisper_print_progress_callback: progress =  11%"), Some(11));
        assert_eq!(parse_whisper_progress("whisper_print_progress_callback: progress = 100%"), Some(100));
        assert_eq!(parse_whisper_progress("whisper_vad: vad_segment_info: orig_start: 1.09"), None);
        assert_eq!(parse_whisper_progress("progress = 250%"), None);
        assert_eq!(parse_whisper_progress("[00:00:00.000 --> 00:00:10.500]   And so"), None);
    }

    #[test]
    fn stt_validates_language_and_prompt() {
        assert_eq!(validate_language(" KO ").unwrap(), "ko");
        assert_eq!(validate_language("auto").unwrap(), "auto");
        assert_eq!(validate_language("yue").unwrap(), "yue");
        for bad in ["", "k", "korean", "k1", "-l", "en us"] {
            assert!(validate_language(bad).is_err(), "{bad:?}");
        }
        assert_eq!(validate_prompt(None, true).unwrap(), None);
        assert_eq!(validate_prompt(Some(" \u{200B} "), true).unwrap(), None);
        assert_eq!(validate_prompt(Some("Tauri,\nGitpervisor"), true).unwrap().as_deref(), Some("Tauri, Gitpervisor"));
        assert!(validate_prompt(Some(&"a".repeat(501)), false).is_err());
        assert!(validate_prompt(Some("깃퍼바이저"), true).is_err(), "Windows는 ASCII만");
        assert_eq!(validate_prompt(Some("깃퍼바이저"), false).unwrap().as_deref(), Some("깃퍼바이저"));
        assert!((1..=8).contains(&default_threads()));
    }

    #[test]
    fn stt_single_job_and_model_busy() {
        let g = begin_active("j1", "turbo-q5").unwrap();
        assert_eq!(active_model().as_deref(), Some("turbo-q5"));
        assert_eq!(begin_active("j2", "base-q5").unwrap_err().code, ErrorCode::Busy);
        drop(g);
        assert_eq!(active_model(), None);
    }

    /// 번인 ASS 폴더: 파일 → 폴더 순으로 지운다. 비지 않은 폴더는 남긴다(모르는 파일까지 지우지 않는다).
    #[test]
    fn stt_temp_files_remove_file_then_empty_dir() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("gpv-stt-burn-x");
        let ass = dir.join("subs.ass");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(&ass, "x").unwrap();
        drop(TempFiles(vec![ass.clone(), dir.clone()]));
        assert!(!dir.exists(), "빈 폴더가 남았다");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("other"), "x").unwrap();
        drop(TempFiles(vec![ass, dir.clone()]));
        assert!(dir.join("other").exists());
    }

    #[test]
    fn stt_rel_arg_stays_ascii_under_base() {
        let base = Path::new("/data/app");
        assert_eq!(rel_arg(base, Path::new("/data/app/llm/models/x.bin")).unwrap(), "llm/models/x.bin");
        assert!(rel_arg(base, Path::new("/elsewhere/x.bin")).is_err());
        assert!(rel_arg(base, Path::new("/data/app/모델/x.bin")).is_err());
    }

    fn real_env() -> Option<(PathBuf, PathBuf)> {
        let dir = PathBuf::from(std::env::var_os("GPV_STT_TEST_DIR")?);
        let name = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
        let exe = [dir.join(name), dir.join("wx").join("Release").join(name)].into_iter().find(|p| p.is_file())?;
        Some((dir, exe))
    }

    /// 실제 whisper-cli로 jfk.wav(11초)를 끝까지 — 인자 빌더 · 스폰·파이프 드레인 · 진행률 · stderr VAD 대응표 ·
    /// -ojf 파서 · 문서 조립을 한 번에 본다. 취소 경로(시작 전 취소 → Cancelled)도.
    ///
    /// `GPV_STT_TEST_DIR`: whisper-cli(또는 `wx/Release/whisper-cli.exe`)·`ggml-tiny.bin`·`silero.bin`·`jfk.wav`가 있는 폴더.
    /// `GPV_STT_TEST_DIR=… cargo test --lib stt_real_whisper -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "실제 whisper-cli·모델 필요 — GPV_STT_TEST_DIR"]
    async fn stt_real_whisper_transcribes_jfk() {
        let (dir, exe) = real_env().expect("GPV_STT_TEST_DIR에 whisper-cli가 없다");
        let stem = format!("{TEMP_PREFIX}test-{}", uuid::Uuid::new_v4().simple());
        let wa = WhisperArgs {
            model: "ggml-tiny.bin",
            vad_model: "silero.bin",
            wav: "jfk.wav",
            out_stem: &stem,
            language: "auto",
            prompt: None,
            threads: default_threads(),
            dtw: "tiny",
            greedy: false,
        };
        let jobs: Arc<Mutex<HashMap<String, VideoJob>>> = Arc::default();
        let (tx, mut rx) = oneshot::channel();
        jobs.lock().unwrap_or_else(|e| e.into_inner()).insert("t".into(), VideoJob { cancel: Some(tx), pid: None });
        let seen = Arc::new(Mutex::new(Vec::<u32>::new()));
        let seen2 = Arc::clone(&seen);
        let mut cmd = Command::new(&exe);
        cmd.args(build_whisper_args(&wa)).current_dir(&dir);
        let step = run_step(cmd, "whisper-cli", &jobs, "t", &mut rx, |_| {}, move |l| {
            if let Some(p) = parse_whisper_progress(l) {
                seen2.lock().unwrap_or_else(|e| e.into_inner()).push(p);
            }
        })
        .await
        .unwrap();
        let json_path = dir.join(format!("{stem}.json"));
        let bytes = std::fs::read(&json_path);
        std::fs::remove_file(&json_path).ok();
        assert!(step.ok, "{}", step.stderr_tail);
        let bytes = bytes.unwrap();
        assert!(!seen.lock().unwrap_or_else(|e| e.into_inner()).is_empty(), "진행률 줄을 못 읽었다");
        assert!(jobs.lock().unwrap_or_else(|e| e.into_inner())["t"].pid.is_some(), "pid를 레지스트리에 올리지 않았다");

        let vad: Vec<VadSpan> = step.vad_lines.iter().filter_map(|l| parse_vad_line(l)).collect();
        assert!(!vad.is_empty(), "stderr에 VAD 대응표가 없다");
        let out = parse_whisper_json(&bytes, &vad, true).unwrap();
        assert_eq!(out.word_timing, crate::stt::doc::WordTiming::Dtw);
        assert_eq!(out.detected_language.as_deref(), Some("en"));
        let mut doc = build_doc(
            crate::stt::doc::tests::source(11_000),
            crate::stt::doc::tests::engine("auto"),
            out.words,
        );
        crate::stt::doc::validate_doc(&mut doc).unwrap();
        let cues = crate::stt::subs::source_cues(&doc).unwrap();
        let text = cues.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(" ").to_lowercase();
        println!("{text}\n{}", crate::stt::subs::build_srt(&cues));
        assert!(text.contains("country"), "{text}");
        assert!(cues.windows(2).all(|w| w[0].start_ms <= w[1].start_ms));
        assert!(cues.iter().all(|c| c.start_ms < c.end_ms && c.end_ms <= 11_000));

        // 시작 전에 취소가 와 있으면 spawn 직후 죽이고 Cancelled.
        let (tx, mut rx) = oneshot::channel();
        tx.send(()).unwrap();
        let mut cmd = Command::new(&exe);
        cmd.args(build_whisper_args(&wa)).current_dir(&dir);
        let err = run_step(cmd, "whisper-cli", &jobs, "t", &mut rx, |_| {}, |_| {}).await.err().unwrap();
        std::fs::remove_file(&json_path).ok();
        assert_eq!(err.code, ErrorCode::Cancelled);
    }
}
