//! 온디맨드 HLS 트랜스코딩 — 웹뷰가 못 푸는 코덱을 재생 가능한 H.264로 바꿔 흘린다.
//!
//! ## 왜 필요한가
//! 뷰어의 재생은 WKWebView/WebView2 안의 `<video>`다. 디코더 목록을 **웹뷰 엔진이** 정하므로
//! 앱이 자기 디코더를 끼워 넣을 수 없다. macOS WebKit은 AV1을 **하드웨어 디코더가 있는
//! 기기(M3·A17 Pro 이상)에서만** 켜므로, M1/M2/Intel 맥에서는 AV1 mp4가 통째로 재생 불가다
//! (WebCodecs도 같은 VideoToolbox 백엔드라 `av01`을 거절한다 — 실측). Movist·VLC가 되는 건
//! 그들이 dav1d를 **번들해 자기 화면에 직접 그리기** 때문이지 파일이 특별해서가 아니다.
//!
//! 그래서 우회로는 하나뿐이다: **디코딩을 ffmpeg가 하고 웹뷰에는 H.264만 준다.**
//!
//! ## 왜 통째 변환이 아니라 HLS인가
//! 전체를 mp4로 변환하는 폴백은 이미 있다(VideoPlayer의 "mp4로 변환해 열기"). 하지만 300MB
//! 강의 영상 하나에 수 분을 기다리고 디스크에 사본을 남긴다. HLS는 **재생하는 구간만** 그때
//! 그때 만든다 — 즉시 시작하고, 탐색한 곳부터 만들고, 원본 옆에 파일을 남기지 않는다.
//! WKWebView는 HLS를 네이티브로 문다(`canPlayType('application/vnd.apple.mpegurl')` = "maybe"),
//! 그래서 `<video src=…m3u8>` 한 줄이면 **기존 플레이어 UI(타임라인·구간 반복·단축키)가 그대로
//! 산다.** MSE + fMP4로 직접 먹이는 길도 있지만 그쪽은 JS 로더를 새로 써야 한다.
//!
//! ## 구조
//! - 세그먼트는 **독립 ffmpeg 호출**로 만든다(`-ss`로 시작점 seek → `-t`로 길이 제한).
//!   연속 트랜스코드 프로세스를 유지하는 방식(Jellyfin)이 선형 재생엔 낫지만, 탐색마다 프로세스를
//!   죽이고 되살리는 수명 관리가 붙는다. 독립 호출은 **캐시·병렬 선반입·재시도가 전부 공짜**고,
//!   재인코딩 비용은 앞선 키프레임부터 버리는 디코드분(GOP 절반 남짓)뿐이다.
//! - 타임스탬프는 `-output_ts_offset`으로 절대 위치에 맞춘다. 안 맞추면 세그먼트마다 0에서
//!   시작해 재생기가 이어 붙이지 못한다.
//! - 완성 판정은 **원자적 rename**이다(`N.ts.part` → `N.ts`). 쓰는 중인 파일을 길이만 보고
//!   내보내면 잘린 세그먼트가 재생기에 가고, 그건 조용한 재생 정지로 나타난다.
//! - 같은 세그먼트를 동시에 요청하면(선반입 + 실제 재생) 한 쪽만 굽고 나머지는 Condvar로 기다린다.
//!
//! ## 보안
//! 라우트는 preview.rs 서버에 얹는다 — 토큰 인증·127.0.0.1 바인드·유휴 종료를 그대로 쓴다.
//! 경로 접두사를 `/.hls/`로 잡은 이유는 `resolve_request_path`가 **`.`으로 시작하는 세그먼트를
//! 무조건 거부**하기 때문이다(dotfile 차단). 즉 레포에 `.hls`라는 파일이 있어도 충돌하지 않는다.
//! 세그먼트 URI에는 토큰을 직접 박는다 — 미디어 서브리소스의 Referer는 엔진마다 달라 못 믿는다.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 세그먼트 길이. 짧을수록 탐색 응답이 빠르지만 호출당 고정비(프로세스 기동 + 앞선 키프레임까지
/// 되감아 버리는 디코드)가 그만큼 자주 붙는다. 6초는 HLS 관례이자 그 타협점이다.
const SEG_SECS: f64 = 6.0;
/// 동시에 돌릴 ffmpeg 수. 선반입은 이 상한에 걸리면 **줄 서지 않고 포기**한다(대기열이 쌓이면
/// 사용자가 탐색한 지점이 옛 선반입 뒤로 밀린다). 실제 재생이 요구한 세그먼트는 상한과 무관하게 진행.
const MAX_TRANSCODES: usize = 2;
/// 선반입 깊이 — 재생 중인 세그먼트 다음 2개.
const PREFETCH: u32 = 2;
/// 세그먼트 하나를 기다릴 최대 시간. 넘으면 재생기에 500을 준다(재생기가 재요청한다).
const SEG_WAIT: Duration = Duration::from_secs(180);
/// 세션당 캐시 상한. 넘으면 오래 안 쓴 세그먼트부터 지운다.
const SESSION_CAP_BYTES: u64 = 1536 * 1024 * 1024;
/// 요청이 이만큼 끊기면 세션을 걷어낸다(창을 닫았거나 다른 파일로 옮겼다).
const SESSION_IDLE_SECS: u64 = 45 * 60;
/// 동시에 유지할 세션 수 — 넘으면 가장 오래 조용한 것부터 버린다.
const MAX_SESSIONS: usize = 4;

// ══════════════════════════ 세션 ══════════════════════════

#[derive(Default)]
struct SegSlot {
    state: Mutex<SegState>,
    cv: Condvar,
}

#[derive(Default, Clone, PartialEq)]
enum SegState {
    #[default]
    Running,
    Ready,
    Failed(String),
}

pub struct HlsSession {
    sid: String,
    src: PathBuf,
    dir: PathBuf,
    ffmpeg: PathBuf,
    duration_ms: u64,
    seg_count: u32,
    has_audio: bool,
    /// `-vf scale=…` 대상 크기(표시 기준, 짝수). 회전 메타는 ffmpeg autorotate가 먼저 적용한다.
    dims: (u32, u32),
    /// 완성된 비디오 인코더 인자 — 하드웨어 가능 여부는 세션 생성 때 한 번 판정한다.
    vargs: Vec<String>,
    /// 마지막 요청 시각(epoch 초). 유휴 회수 판정용.
    last_hit: AtomicU64,
    segs: Mutex<HashMap<u32, Arc<SegSlot>>>,
}

impl HlsSession {
    fn touch(&self) {
        self.last_hit.store(now_secs(), Ordering::Relaxed);
    }

    /// 세그먼트 n의 [시작, 길이] (초). 마지막 조각은 짧다.
    fn span(&self, n: u32) -> (f64, f64) {
        let total = self.duration_ms as f64 / 1000.0;
        let start = n as f64 * SEG_SECS;
        (start, (total - start).min(SEG_SECS).max(0.001))
    }

    /// VOD 재생목록. 전체 구간을 미리 적어 주므로 재생기가 **아직 굽지 않은 곳으로도 탐색**한다.
    fn playlist(&self, token: &str) -> String {
        let mut s = String::with_capacity(64 + self.seg_count as usize * 32);
        s.push_str("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n");
        s.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", SEG_SECS.ceil() as u64));
        s.push_str("#EXT-X-MEDIA-SEQUENCE:0\n");
        for n in 0..self.seg_count {
            let (_, dur) = self.span(n);
            s.push_str(&format!("#EXTINF:{dur:.6},\n{n}.ts?t={token}\n"));
        }
        s.push_str("#EXT-X-ENDLIST\n");
        s
    }
}

#[derive(Default)]
struct Reg {
    by_sid: HashMap<String, Arc<HlsSession>>,
    /// `경로|mtime|크기` → sid. 같은 파일을 다시 열면 구운 세그먼트를 재사용한다.
    by_key: HashMap<String, String>,
}

fn reg() -> &'static Mutex<Reg> {
    static R: OnceLock<Mutex<Reg>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Reg::default()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn get_session(sid: &str) -> Option<Arc<HlsSession>> {
    reg()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .by_sid
        .get(sid)
        .cloned()
}

// ══════════════════════════ 라우팅 (preview.rs 서버가 호출) ══════════════════════════

pub(crate) enum Route {
    /// 재생목록 본문 — 작아서 인라인으로 쓴다.
    Playlist(String),
    /// 구운 세그먼트 파일 + 강제 Content-Type. 확장자 추론에 맡기지 않는다: `.ts`는
    /// TypeScript 소스이기도 해서 preview.rs의 MIME 표에 넣으면 HTML 프리뷰 쪽이 오염된다.
    Segment(PathBuf, &'static str),
    NotFound,
    Failed(String),
}

/// `/.hls/{sid}/index.m3u8` · `/.hls/{sid}/{n}.ts` 를 처리한다. 그 외 경로면 NotFound.
///
/// `sid`는 레지스트리 조회 키로만 쓰고 경로에는 **세션이 들고 있는 dir**을 쓴다 — URL 문자열이
/// 파일 경로로 흘러 들어가지 않으므로 탈출 시도가 성립하지 않는다.
pub(crate) fn route(path_part: &str, token: &str) -> Route {
    let rest = match path_part.strip_prefix("/.hls/") {
        Some(r) => r,
        None => return Route::NotFound,
    };
    let mut it = rest.splitn(2, '/');
    let sid = it.next().unwrap_or("");
    let file = it.next().unwrap_or("");
    let sess = match get_session(sid) {
        Some(s) => s,
        None => return Route::NotFound,
    };
    sess.touch();

    if file == "index.m3u8" {
        return Route::Playlist(sess.playlist(token));
    }
    let n = match file.strip_suffix(".ts").and_then(|s| s.parse::<u32>().ok()) {
        Some(n) if n < sess.seg_count => n,
        _ => return Route::NotFound,
    };
    match ensure_segment(&sess, n) {
        Ok(p) => {
            spawn_prefetch(&sess, n);
            Route::Segment(p, "video/mp2t")
        }
        Err(e) => Route::Failed(e),
    }
}

// ══════════════════════════ 세그먼트 생성 ══════════════════════════

static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

struct InflightGuard;
impl Drop for InflightGuard {
    fn drop(&mut self) {
        INFLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 세그먼트 파일을 보장한다 — 이미 있으면 즉시, 남이 굽는 중이면 기다리고, 아니면 직접 굽는다.
fn ensure_segment(sess: &Arc<HlsSession>, n: u32) -> Result<PathBuf, String> {
    let out = sess.dir.join(format!("{n}.ts"));
    if out.is_file() {
        return Ok(out);
    }

    // 굽는 주체를 정한다 — 맵에 슬롯을 처음 넣은 쪽이 굽고, 나머지는 그 슬롯을 기다린다.
    let (slot, i_run) = {
        let mut m = sess.segs.lock().unwrap_or_else(|e| e.into_inner());
        match m.get(&n) {
            Some(s) => (s.clone(), false),
            None => {
                let s = Arc::new(SegSlot::default());
                m.insert(n, s.clone());
                (s, true)
            }
        }
    };

    if !i_run {
        let mut st = slot.state.lock().unwrap_or_else(|e| e.into_inner());
        while *st == SegState::Running {
            let (g, timeout) = slot
                .cv
                .wait_timeout(st, SEG_WAIT)
                .unwrap_or_else(|e| e.into_inner());
            st = g;
            if timeout.timed_out() {
                return Err(format!("세그먼트 {n} 대기 시간 초과"));
            }
        }
        return match &*st {
            SegState::Ready => Ok(out),
            SegState::Failed(e) => Err(e.clone()),
            SegState::Running => Err("세그먼트 상태 불명".into()),
        };
    }

    INFLIGHT.fetch_add(1, Ordering::Relaxed);
    let _guard = InflightGuard;
    let result = transcode_segment(sess, n, &out);

    let mut st = slot.state.lock().unwrap_or_else(|e| e.into_inner());
    *st = match &result {
        Ok(()) => SegState::Ready,
        Err(e) => SegState::Failed(e.clone()),
    };
    slot.cv.notify_all();
    drop(st);

    if result.is_err() {
        // 실패는 붙잡아 두지 않는다 — 일시적 원인(디스크·경합)이면 다음 요청이 다시 시도해야 한다.
        sess.segs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&n);
    } else {
        enforce_cap(sess);
    }
    result.map(|_| out)
}

/// 다음 세그먼트를 미리 굽는다 — 실패해도 조용히 접는다(어차피 재생기가 곧 직접 요청한다).
fn spawn_prefetch(sess: &Arc<HlsSession>, from: u32) {
    for k in 1..=PREFETCH {
        let n = from + k;
        if n >= sess.seg_count || sess.dir.join(format!("{n}.ts")).is_file() {
            continue;
        }
        // 이미 누가 굽고 있으면 스레드를 만들지 않는다. ensure_segment는 남의 작업을 **기다리는**
        // 함수라, 이 검사가 없으면 탐색을 연타할 때 조건변수 앞에 스레드가 쌓인다.
        if sess
            .segs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(&n)
        {
            continue;
        }
        let s = sess.clone();
        let _ = std::thread::Builder::new()
            .name("hls-prefetch".into())
            .spawn(move || {
                // 상한에 걸리면 줄 서지 않고 포기한다(§MAX_TRANSCODES).
                if INFLIGHT.load(Ordering::Relaxed) >= MAX_TRANSCODES {
                    return;
                }
                let _ = ensure_segment(&s, n);
            });
    }
}

/// 세그먼트 하나를 ffmpeg로 굽는다. `.part`에 쓰고 성공했을 때만 rename — 잘린 파일이
/// 완성본으로 보이는 창을 없앤다.
fn transcode_segment(sess: &HlsSession, n: u32, out: &Path) -> Result<(), String> {
    let (start, dur) = sess.span(n);
    let part = out.with_extension("ts.part");
    let _ = std::fs::remove_file(&part);

    let (w, h) = sess.dims;
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        // 입력 seek — 앞선 키프레임부터 디코드해 정확히 start에서 출력을 시작한다.
        "-ss".into(),
        format!("{start:.6}"),
        "-i".into(),
        sess.src.display().to_string(),
        "-t".into(),
        format!("{dur:.6}"),
        "-map".into(),
        "0:v:0".into(),
    ];
    if sess.has_audio {
        args.push("-map".into());
        args.push("0:a:0".into());
    }
    args.push("-vf".into());
    args.push(format!("scale={w}:{h}"));
    args.extend(sess.vargs.iter().cloned());
    if sess.has_audio {
        args.extend(
            ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]
                .iter()
                .map(|s| s.to_string()),
        );
    }
    args.extend(
        [
            // 절대 위치로 타임스탬프를 옮긴다 — 없으면 세그먼트마다 0에서 시작해 이어지지 않는다.
            "-output_ts_offset",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(format!("{start:.6}"));
    // mpegts 머서의 기본 선지연(0.7+0.7초)을 없앤다 — 세그먼트 경계에 그만큼 빈틈이 생긴다.
    args.extend(
        ["-muxdelay", "0", "-muxpreload", "0", "-f", "mpegts", "-y"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(part.display().to_string());

    let mut cmd = std::process::Command::new(&sess.ffmpeg);
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 종료 시 그룹째 거둔다(video.rs와 같은 스폰 규약)
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("ffmpeg 실행 실패: {e}"))?;
    let pid = child.id();
    children().lock().unwrap_or_else(|e| e.into_inner()).insert(pid);
    let out_res = child.wait_with_output();
    children().lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);

    let done = out_res.map_err(|e| format!("ffmpeg 대기 실패: {e}"))?;
    if !done.status.success() {
        let _ = std::fs::remove_file(&part);
        let err = String::from_utf8_lossy(&done.stderr);
        return Err(format!(
            "세그먼트 {n} 인코딩 실패: {}",
            err.lines().last().unwrap_or("(출력 없음)")
        ));
    }
    if std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("세그먼트 {n}이 비어 있습니다"));
    }
    std::fs::rename(&part, out).map_err(|e| format!("세그먼트 {n} 확정 실패: {e}"))?;
    Ok(())
}

/// 캐시 상한 초과분을 **가장 오래 안 쓴 것부터** 지운다. 재생 중인 구간은 방금 만들어져
/// mtime이 가장 새것이라 자연히 살아남는다.
fn enforce_cap(sess: &HlsSession) {
    let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    let rd = match std::fs::read_dir(&sess.dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("ts") {
            continue;
        }
        if let Ok(m) = e.metadata() {
            total += m.len();
            files.push((m.modified().unwrap_or(UNIX_EPOCH), m.len(), p));
        }
    }
    if total <= SESSION_CAP_BYTES {
        return;
    }
    files.sort_by_key(|(t, _, _)| *t);
    for (_, len, p) in files {
        if total <= SESSION_CAP_BYTES {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
            // 슬롯도 지운다 — 안 지우면 Ready로 남아 없는 파일을 가리킨다.
            if let Some(n) = p
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.parse::<u32>().ok())
            {
                sess.segs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&n);
            }
        }
    }
}

// ══════════════════════════ 자식 회수 ══════════════════════════

fn children() -> &'static Mutex<HashSet<u32>> {
    static C: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 앱 종료 시 돌고 있는 세그먼트 인코딩을 거둔다 — lib.rs shutdown_children에서 호출.
/// 세그먼트는 짧지만(<수 초) 종료 순간에 걸린 것이 남으면 그대로 고아가 된다.
pub fn hls_kill_all() {
    let pids: Vec<u32> = children()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .copied()
        .collect();
    for pid in pids {
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
}

// ══════════════════════════ 인코더 선택 ══════════════════════════

/// `ffmpeg -encoders` 1회 조회 캐시. 같은 프로세스에서 ffmpeg 경로가 바뀌는 경우는 설정을
/// 고쳤을 때뿐이고, 그때는 앱을 다시 열면 된다(오판의 대가가 소프트웨어 인코딩뿐이다).
fn has_encoder(ffmpeg: &Path, name: &str) -> bool {
    static LIST: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    let cell = LIST.get_or_init(|| Mutex::new(None));
    let mut slot = cell.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-encoders"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let out = cmd
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        // **빈 결과는 캐시하지 않는다.** 실행 실패(경로가 틀렸다·아직 다운로드 중이다)를
        // 영구히 굳히면, 경로를 고친 뒤에도 앱을 재시작할 때까지 하드웨어 인코더를 못 쓴다.
        if out.is_empty() {
            return false;
        }
        *slot = Some(out);
    }
    slot.as_deref().unwrap_or_default().contains(name)
}

/// 표시 크기 → 인코딩 대상 크기. 1080p로 상한을 두는 건 코덱 폴백이 **재생을 위한 것**이지
/// 원본 보존이 아니기 때문이다(원본 편집·내보내기는 계속 원본을 쓴다).
fn target_dims(w: u32, h: u32) -> (u32, u32) {
    let (mut tw, mut th) = (w.max(2), h.max(2));
    if th > 1080 {
        tw = (tw as u64 * 1080 / th as u64) as u32;
        th = 1080;
    }
    ((tw & !1).max(2), (th & !1).max(2))
}

/// 원본 코덱 → H.264 환산 계수. **같은 화질을 H.264로 내려면 몇 배의 비트가 필요한가.**
///
/// 이 보정이 없으면 폴백이 조용히 화질을 깎는다: 실측한 강의 파일이 1080p30 AV1 354kbps인데,
/// 원본 비트레이트를 그대로 상한으로 쓰면 H.264도 354kbps로 굽는다 — AV1이 그 비트로 하던 일을
/// H.264는 절반도 못 한다. 애초에 원본이 **더 효율적인 코덱이라서** 폴백이 필요한 상황이라,
/// 여기서 계수를 빼먹는 것은 거의 항상 틀린 쪽으로 틀린다.
fn codec_factor(vcodec: Option<&str>) -> f64 {
    match vcodec.unwrap_or("").to_ascii_lowercase().as_str() {
        "av1" | "libaom-av1" | "libdav1d" => 2.0,
        "hevc" | "h265" | "vp9" | "vp09" => 1.6,
        _ => 1.0,
    }
}

/// 목표 비트레이트(kbps). videotoolbox는 CRF가 없어 명시 비트레이트가 필요하다.
///
/// 전송 구간이 루프백이라 **대역폭은 제약이 아니다** — 비트레이트를 조이는 이유는 CPU와 캐시
/// 디스크뿐이다. 그래서 해상도 기준값을 상한으로 두되, 원본이 확실히 가벼우면 그만큼만 쓴다.
fn target_kbps(w: u32, h: u32, fps: f64, src_kbps: Option<u64>, vcodec: Option<&str>) -> u64 {
    let f = if fps > 1.0 { fps.min(60.0) } else { 30.0 };
    // 픽셀당 0.09비트 — 1080p30에서 약 5.6Mbps로, 강의·화면녹화 화질에 충분하다.
    let res_based = (((w as f64 * h as f64 * f * 0.09) / 1000.0).round() as u64).clamp(800, 12_000);
    let Some(src) = src_kbps.filter(|s| *s > 0) else {
        return res_based;
    };
    // 환산 후 1.5배 여유 — 재인코딩은 세대 손실이 있어 원본과 동률로는 원본만 못하다.
    let equiv = ((src as f64) * codec_factor(vcodec) * 1.5) as u64;
    // 하한 — 슬라이드 강의의 글자가 뭉개지지 않을 최소선(해상도가 클수록 높게).
    let floor = if h >= 720 { 2000 } else { 800 };
    res_based.min(equiv.max(floor))
}

fn video_args(ffmpeg: &Path, kbps: u64) -> Vec<String> {
    // 하드웨어 인코더가 있으면 그쪽이 압도적으로 싸다. 이 폴백의 병목은 원본(AV1 등)
    // **소프트웨어 디코딩**이라, 인코딩까지 CPU로 하면 실시간을 못 따라가는 기기가 생긴다.
    let hw = if cfg!(target_os = "macos") {
        Some("h264_videotoolbox")
    } else if cfg!(target_os = "windows") {
        ["h264_nvenc", "h264_qsv", "h264_amf"]
            .into_iter()
            .find(|e| has_encoder(ffmpeg, e))
    } else {
        // Linux VAAPI/QSV는 `-vaapi_device` 등 장치 지정이 필요하고 실패 양상이 기기마다 다르다.
        // 애초에 이 폴백이 필요한 쪽은 macOS라(§모듈 doc) 여기서는 소프트웨어로 간다.
        None
    };
    match hw.filter(|e| has_encoder(ffmpeg, e)) {
        Some(enc) => vec![
            "-c:v".into(),
            enc.into(),
            "-b:v".into(),
            format!("{kbps}k"),
            "-maxrate".into(),
            format!("{}k", kbps * 3 / 2),
            "-bufsize".into(),
            format!("{}k", kbps * 2),
            "-profile:v".into(),
            "high".into(),
            // 하드웨어가 바쁘거나 없으면 조용히 소프트웨어로 — 실패보다 느린 편이 낫다.
            "-allow_sw".into(),
            "1".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
        None => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ],
    }
}

// ══════════════════════════ 세션 생성 (IPC) ══════════════════════════

/// 캐시 루트. 프로세스당 한 번 통째로 비운다 — 비정상 종료가 남긴 조각과 원본이 바뀐 파일의
/// 낡은 세그먼트를 한 번에 정리한다(재시작 간 캐시 재사용을 포기하는 대신 규칙이 단순해진다).
fn cache_root(app: &AppHandle) -> PathBuf {
    static WIPED: OnceLock<()> = OnceLock::new();
    let root = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("hls");
    WIPED.get_or_init(|| {
        let _ = std::fs::remove_dir_all(&root);
    });
    root
}

/// 버릴 세션 목록 — `(sid, last_hit)` 스냅샷에서 정한다. 유휴 초과분을 먼저 버리고,
/// 그러고도 MAX_SESSIONS를 넘으면 **가장 오래 조용한 것부터** 채운다.
/// 락·파일시스템과 분리해 순수 함수로 둔다(경계 조건을 테스트로 고정하기 위해).
fn doomed_sessions(mut snapshot: Vec<(String, u64)>, now: u64) -> Vec<String> {
    let mut doomed: Vec<String> = snapshot
        .iter()
        .filter(|(_, hit)| now.saturating_sub(*hit) > SESSION_IDLE_SECS)
        .map(|(k, _)| k.clone())
        .collect();
    snapshot.retain(|(k, _)| !doomed.contains(k));
    if snapshot.len() > MAX_SESSIONS {
        snapshot.sort_by_key(|(_, hit)| *hit);
        let over = snapshot.len() - MAX_SESSIONS;
        doomed.extend(snapshot.into_iter().take(over).map(|(k, _)| k));
    }
    doomed
}

/// 유휴·초과 세션을 걷어낸다. 세션 디렉터리도 함께 지운다.
fn prune_sessions() {
    let mut r = reg().lock().unwrap_or_else(|e| e.into_inner());
    let snapshot: Vec<(String, u64)> = r
        .by_sid
        .iter()
        .map(|(k, s)| (k.clone(), s.last_hit.load(Ordering::Relaxed)))
        .collect();
    for sid in doomed_sessions(snapshot, now_secs()) {
        if let Some(s) = r.by_sid.remove(&sid) {
            let _ = std::fs::remove_dir_all(&s.dir);
        }
    }
    let live: HashSet<String> = r.by_sid.keys().cloned().collect();
    r.by_key.retain(|_, v| live.contains(v));
}

/// 재생 불가 코덱 폴백 — 이 파일을 H.264 HLS로 흘릴 재생목록 URL을 발급한다.
///
/// 멱등이다: 같은 파일(경로+mtime+크기)이면 같은 세션을 돌려주므로 이미 구운 세그먼트가 산다.
#[tauri::command]
pub async fn video_hls_url(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<String, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let src = resolve_in_repo(&repo, &rel_path)?;
    let src = dunce::canonicalize(&src)
        .map_err(|_| IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"))?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, "파일을 찾을 수 없습니다"));
    }
    let meta_fs = std::fs::metadata(&src)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 정보를 읽지 못했습니다: {e}")))?;
    let key = format!(
        "{}|{}|{}",
        src.display(),
        meta_fs
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
        meta_fs.len()
    );

    let bin = super::video::find_ffmpeg(&app, state.inner())?;
    let probe = bin.ffprobe.clone().ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "ffprobe를 찾을 수 없습니다 — ffmpeg와 같은 폴더에 있어야 합니다",
        )
    })?;

    // 서빙은 미디어 파일의 상위 폴더 서버가 맡는다 — 토큰·유휴 종료를 프리뷰와 공유한다.
    let base = src
        .parent()
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "상위 폴더를 찾을 수 없습니다"))?
        .to_path_buf();
    let (port, token) = super::preview::ensure_server(state.inner(), &base)?;

    // 이미 있는 세션이면 프로브 없이 즉시 돌려준다(keep-alive 핑도 이 경로로 온다).
    if let Some(sid) = {
        let r = reg().lock().unwrap_or_else(|e| e.into_inner());
        r.by_key.get(&key).cloned().filter(|s| r.by_sid.contains_key(s))
    } {
        if let Some(s) = get_session(&sid) {
            s.touch();
            return Ok(format!("http://127.0.0.1:{port}/.hls/{sid}/index.m3u8?t={token}"));
        }
    }

    let meta = super::video::probe_meta(&probe, &src.display().to_string()).await?;
    if !meta.has_video || meta.duration_ms == 0 {
        return Err(IpcError::new(
            ErrorCode::Io,
            "동영상 스트림을 찾지 못했습니다 — 변환할 수 없는 파일입니다",
        ));
    }

    let dims = target_dims(meta.width, meta.height);
    let kbps = target_kbps(dims.0, dims.1, meta.fps, meta.bitrate_kbps, meta.vcodec.as_deref());
    let vargs = video_args(&bin.ffmpeg, kbps);
    let sid = Uuid::new_v4().simple().to_string();
    let dir = cache_root(&app).join(&sid);
    std::fs::create_dir_all(&dir)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("캐시 폴더 생성 실패: {e}")))?;

    let seg_count = ((meta.duration_ms as f64 / 1000.0) / SEG_SECS).ceil().max(1.0) as u32;
    let sess = Arc::new(HlsSession {
        sid: sid.clone(),
        src,
        dir,
        ffmpeg: bin.ffmpeg.clone(),
        duration_ms: meta.duration_ms,
        seg_count,
        has_audio: meta.has_audio,
        dims,
        vargs,
        last_hit: AtomicU64::new(now_secs()),
        segs: Mutex::new(HashMap::new()),
    });

    {
        let mut r = reg().lock().unwrap_or_else(|e| e.into_inner());
        r.by_sid.insert(sid.clone(), sess.clone());
        r.by_key.insert(key, sid.clone());
    }
    // 정리는 **삽입 뒤에** 한다 — 앞에서 하면 비교 대상에 새 세션이 빠져 실제 유지 개수가
    // MAX_SESSIONS+1이 된다(4개일 때 `4 - 0 > 4`가 false라 정리 없이 5번째가 들어간다).
    // 방금 넣은 세션은 last_hit이 가장 새것이라 자기 자신이 쫓겨나지 않는다.
    prune_sessions();
    log::info!(
        "[hls] 세션 {} — {}x{} {:.2}fps {}kbps · {}조각 · {}",
        &sess.sid[..8],
        dims.0,
        dims.1,
        meta.fps,
        kbps,
        seg_count,
        meta.vcodec.as_deref().unwrap_or("?")
    );
    Ok(format!("http://127.0.0.1:{port}/.hls/{sid}/index.m3u8?t={token}"))
}

/// 테스트용 세션 등록 — preview.rs의 라우팅 통합 테스트가 쓴다. 프로덕션 경로(video_hls_url)는
/// AppHandle과 ffprobe가 필요해 유닛 테스트에서 부를 수 없다.
#[cfg(test)]
pub(crate) fn register_test_session(
    src: PathBuf,
    dir: PathBuf,
    ffmpeg: PathBuf,
    duration_ms: u64,
    has_audio: bool,
) -> String {
    let sid = Uuid::new_v4().simple().to_string();
    let seg_count = ((duration_ms as f64 / 1000.0) / SEG_SECS).ceil().max(1.0) as u32;
    let sess = Arc::new(HlsSession {
        sid: sid.clone(),
        src,
        dir,
        ffmpeg: ffmpeg.clone(),
        duration_ms,
        seg_count,
        has_audio,
        dims: (320, 240),
        vargs: video_args(&ffmpeg, 800),
        last_hit: AtomicU64::new(now_secs()),
        segs: Mutex::new(HashMap::new()),
    });
    reg()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .by_sid
        .insert(sid.clone(), sess);
    sid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(duration_ms: u64, seg_count: u32) -> HlsSession {
        HlsSession {
            sid: "s".into(),
            src: PathBuf::from("/tmp/a.mp4"),
            dir: PathBuf::from("/tmp/hls"),
            ffmpeg: PathBuf::from("ffmpeg"),
            duration_ms,
            seg_count,
            has_audio: true,
            dims: (1920, 1080),
            vargs: vec![],
            last_hit: AtomicU64::new(0),
            segs: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn playlist_covers_whole_duration_and_carries_token() {
        // 20초 = 6+6+6+2 → 4조각. 마지막 EXTINF는 짧아야 하고 합이 원본 길이와 같아야 한다.
        let s = mk(20_000, 4);
        let pl = s.playlist("tok");
        assert!(pl.starts_with("#EXTM3U\n"));
        assert!(pl.contains("#EXT-X-PLAYLIST-TYPE:VOD"));
        assert!(pl.trim_end().ends_with("#EXT-X-ENDLIST"));
        assert_eq!(pl.matches("?t=tok").count(), 4, "세그먼트마다 토큰이 박혀야 한다");
        let sum: f64 = pl
            .lines()
            .filter_map(|l| l.strip_prefix("#EXTINF:"))
            .filter_map(|l| l.trim_end_matches(',').parse::<f64>().ok())
            .sum();
        assert!((sum - 20.0).abs() < 0.01, "조각 길이 합 {sum} != 20");
    }

    #[test]
    fn last_segment_is_clamped_not_negative() {
        let s = mk(6_500, 2);
        let (start, dur) = s.span(1);
        assert_eq!(start, 6.0);
        assert!((dur - 0.5).abs() < 1e-6, "마지막 조각은 0.5초여야 하는데 {dur}");
        // 범위를 넘는 조각을 물어도 음수 길이가 나오면 안 된다(ffmpeg가 -t 음수로 실패한다).
        assert!(s.span(99).1 > 0.0);
    }

    #[test]
    fn target_dims_are_even_and_capped() {
        assert_eq!(target_dims(1920, 1080), (1920, 1080)); // 이미 상한 이하면 그대로
        assert_eq!(target_dims(3840, 2160), (1920, 1080)); // 4K는 1080p로 — 폴백은 재생용이다
        // 홀수 크기는 반드시 짝수로 내려야 한다: yuv420p 크로마 서브샘플링이 홀수를 못 받아
        // libx264/videotoolbox가 "width not divisible by 2"로 실패한다(세그먼트 전멸).
        for (w, h) in [(1921, 1081), (641, 361), (1999, 1999)] {
            let (tw, th) = target_dims(w, h);
            assert_eq!(tw % 2, 0, "{w}x{h} → 가로 {tw}가 홀수");
            assert_eq!(th % 2, 0, "{w}x{h} → 세로 {th}가 홀수");
            assert!(th <= 1080);
            // 종횡비는 1% 안에서 보존된다(레터박스 없이 그대로 그려야 한다).
            let (src, dst) = (w as f64 / h as f64, tw as f64 / th as f64);
            assert!((src - dst).abs() / src < 0.01, "{w}x{h} → {tw}x{th} 비율 이탈");
        }
    }

    #[test]
    fn bitrate_tracks_a_light_source_without_starving_it() {
        // 가벼운 h264 원본은 해상도 기준값까지 부풀리지 않는다.
        assert!(target_kbps(1920, 1080, 30.0, Some(1000), Some("h264")) < 3000);
        // 원본 정보가 없으면 해상도 기준값.
        assert!(target_kbps(1920, 1080, 30.0, None, None) > 3000);
        // 하한/상한.
        assert!(target_kbps(64, 64, 30.0, None, None) >= 800);
        assert!(target_kbps(7680, 4320, 60.0, None, None) <= 12_000);
    }

    #[test]
    fn efficient_codecs_get_more_bits_than_their_source_had() {
        // 실측 파일: 1080p30 AV1 354kbps. 원본 수치를 그대로 상한으로 쓰면 화질이 무너진다 —
        // 같은 그림을 H.264로 그리려면 훨씬 많은 비트가 필요하다(§codec_factor).
        let av1 = target_kbps(1920, 1080, 30.0, Some(354), Some("av1"));
        assert!(av1 >= 2000, "AV1 354kbps 원본 → {av1}kbps는 너무 낮다");
        // 같은 수치라도 원본이 h264면 그만큼 필요하지 않다.
        let h264 = target_kbps(1920, 1080, 30.0, Some(354), Some("h264"));
        assert!(h264 <= av1, "h264 {h264} > av1 {av1} — 계수가 뒤집혔다");
        // 어느 쪽이든 해상도 기준 상한은 넘지 않는다.
        assert!(av1 <= target_kbps(1920, 1080, 30.0, None, None));
    }

    #[test]
    fn session_pruning_keeps_exactly_max_and_drops_the_quietest() {
        let now = 1_000_000u64;
        // 삽입 **뒤에** 부르므로 스냅샷에 새 세션이 포함된다 — MAX+1개면 정확히 1개를 버린다.
        let snap: Vec<(String, u64)> = (0..=MAX_SESSIONS)
            .map(|i| (format!("s{i}"), now - (MAX_SESSIONS - i) as u64))
            .collect();
        let doomed = doomed_sessions(snap, now);
        assert_eq!(doomed, vec!["s0".to_string()], "가장 오래 조용한 것부터 버려야 한다");

        // 딱 MAX개면 아무것도 안 버린다.
        let snap: Vec<(String, u64)> = (0..MAX_SESSIONS).map(|i| (format!("s{i}"), now)).collect();
        assert!(doomed_sessions(snap, now).is_empty());

        // 유휴 초과분은 개수와 무관하게 버린다(그러고 남은 게 MAX 이하면 추가 축출 없음).
        let snap = vec![
            ("old".to_string(), now - SESSION_IDLE_SECS - 1),
            ("fresh".to_string(), now),
        ];
        assert_eq!(doomed_sessions(snap, now), vec!["old".to_string()]);
    }

    #[test]
    fn route_rejects_unknown_prefix_and_bad_segment_names() {
        assert!(matches!(route("/index.m3u8", "t"), Route::NotFound));
        assert!(matches!(route("/.hls/nope/index.m3u8", "t"), Route::NotFound));
        assert!(matches!(route("/.hls/nope/../../etc/passwd", "t"), Route::NotFound));
    }
}
