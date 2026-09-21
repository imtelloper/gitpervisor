use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::health::Level;
use crate::state::AppState;

mod shell;

/// PTY 출력 상한(초당 바이트) — 평시.
///
/// 80x24 화면 한 장이 ≈2KB다. 8MB/s면 사람이 읽을 수 있는 양의 수천 배라 정상 사용
/// (빌드 로그·테스트 출력)에는 절대 걸리지 않는다. `yes`, 크래시 루프에 빠진 dev 서버,
/// 거대 파일 `cat` 처럼 **끝없이 쏟아내는** 경우에만 발동한다.
const PTY_BYTES_PER_SEC: usize = 8 * 1024 * 1024;

/// 펌프가 PTY 출력을 모으는 시간(ms) — 이 시간이 지나면 모인 만큼 한 번에 Channel로 보낸다.
///
/// **키우지 마라. 이 값이 곧 에코 지연의 하한이 된다.** 터미널에는 로컬 에코가 없어 사용자가
/// 보는 지연은 왕복 전체인데, 그 왕복 p50이 실측 3~5ms다. 4ms는 이미 있는 지연보다 작아
/// 대화형 입력에서 체감되지 않으면서, 1MB 출력의 IPC 메시지 수를 수천 개에서 수십 개로 줄인다
/// (16ms를 넘기면 사람이 느낀다 — 태스크 63 §6).
const FLUSH_MS: u64 = 4;

/// 한 Channel 메시지의 상한. 여기 닿으면 `FLUSH_MS`를 기다리지 않고 즉시 보낸다.
/// 리더의 읽기 버퍼와 같은 크기라 "읽은 것 하나"는 절대 쪼개지지 않는다.
const MAX_CHUNK: usize = 65536;

/// 리더→펌프 큐 깊이. **무제한으로 두면 안 된다.** Pacer가 상한을 넘겨 펌프를 재우는 동안
/// 리더가 계속 읽어 큐에 쌓으면, 적체 장소가 Tauri의 `ChannelDataIpcQueue`에서 이 큐로 옮겨질
/// 뿐 메모리는 똑같이 무한히 는다. 큐가 차면 리더의 `send`가 막히고 → PTY 버퍼가 차고 →
/// 셸의 write가 막힌다(기존과 같은 유닉스 흐름 제어). 32 × 최대 64KB = 최악 2MB.
const PUMP_QUEUE: usize = 32;

/// 지금 써도 되는 예산. 메모리 경보 중에는 조인다.
///
/// 렌더러가 메모리 압박으로 멈추면(스왑·GC 스톨·프로세스 실패) Channel 페이로드가 소비되지
/// 않은 채 Tauri의 `ChannelDataIpcQueue`(Rust 힙, 원시 바이트의 ~3.5배짜리 JSON 배열)에
/// 무한 적체된다. 즉 **가장 메모리가 없을 때 앱이 메모리를 제일 빨리 먹는다.** 유입을 줄이면
/// 적체 상한이 그만큼 내려간다 — 줄이는 방식은 평시와 같아서(버리지 않고 OS 파이프 역압으로
/// 셸의 write를 막는다) ANSI 시퀀스가 잘리지 않는다.
///
/// Warn 1MB/s는 화면 500장/초라 사람이 읽는 용도로는 여전히 과하고, Danger 128KB/s는
/// 살아있음이 보이는 최소치다(그 시점엔 수십 초 내 강제 종료가 목표라 체감 지연은 부차적).
///
/// **전체 레벨이 아니라 메모리 레벨을 읽는다**(태스크 69 §2). 전체 레벨에는 프로세스 수가
/// 섞여 있어, Claude 세션 몇 개만 열어도 모든 터미널이 128KB/s로 조여졌다(실측: 큰 출력
/// 0.2초 → 120초+). 여기서 조여야 할 상황은 "시스템 메모리가 모자라다" 하나뿐이다.
fn pty_budget() -> usize {
    match crate::health::memory_level() {
        crate::health::Level::Warn => 1024 * 1024,
        crate::health::Level::Danger => 128 * 1024,
        _ => PTY_BYTES_PER_SEC,
    }
}

/// PTY 출력 속도 제한기(토큰 버킷).
///
/// Tauri Channel에는 ack가 없어 "프론트가 얼마나 밀렸는지"를 알 방법이 없다. 그래서 **보내는
/// 쪽에서** 속도를 잡는다. 상한을 넘기면 리더 스레드가 잠깐 자고, 그러면 PTY 버퍼가 차고,
/// 결국 셸의 write가 막힌다 — 유닉스 흐름 제어 그대로이고 실제 터미널이 하는 일이다.
/// 출력을 **버리지 않으므로** ANSI 이스케이프 시퀀스가 중간에 잘려 화면이 깨지지 않는다.
///
/// 상한이 없으면 무한 출력이 전부 Tauri의 `ChannelDataIpcQueue`에 쌓여 앱이 메모리로 죽는다.
/// 잠자는 대신 "얼마나 자야 하는지"를 돌려주어 시간 없이 테스트할 수 있게 했다.
///
/// **빚 기반이다.** 예전에는 1초 창에서 예산을 넘기는 순간 창의 남은 시간(최대 1초)을 통째로
/// 잤다 — 출력이 1Hz 톱니로 끊겨 보였다. 지금은 보낸 바이트가 곧 "갚아야 할 시간"이고
/// (`bytes / budget`초) 그게 이미 흐른 시간 + `PACER_BURST`를 넘은 만큼만 잔다. 평균 속도는
/// 예산 그대로인데 정지 단위가 ~100ms로 줄어든다.
struct Pacer {
    /// 크레딧 기준점. 재운 뒤에는 **미래 시각**이 들어간다(그만큼은 이미 갚은 것이다).
    window_start: Instant,
    bytes: usize,
}

/// 이만큼의 빚은 자지 않고 넘긴다. 대화형 출력이 잘게 끊기지 않게 하는 여유이자
/// 정지 단위의 하한이다(100ms = 사람이 "끊겼다"고 느끼기 직전).
const PACER_BURST: Duration = Duration::from_millis(100);

/// 쌓을 수 있는 크레딧 상한 = 1초치. 유휴 뒤 한꺼번에 몰아 보내는 것을 이만큼으로 막는다.
const PACER_WINDOW: Duration = Duration::from_secs(1);

impl Pacer {
    fn new(now: Instant) -> Self {
        Self {
            window_start: now,
            bytes: 0,
        }
    }

    /// n바이트를 보냈다고 기록하고, 갚아야 할 시간이 남았으면 잘 시간을 돌려준다.
    /// `budget`은 호출자가 매번 넘긴다(`pty_budget()`) — 메모리 상태에 따라 바뀌기 때문이고,
    /// 덕분에 테스트는 고정값을 주입해 전역 상태 없이 돈다.
    fn take(&mut self, n: usize, now: Instant, budget: usize) -> Option<Duration> {
        // window_start가 미래일 수 있어 saturating — 그 경우 흐른 시간은 0이다.
        let mut elapsed = now.saturating_duration_since(self.window_start);
        if elapsed >= PACER_WINDOW {
            self.window_start = now;
            self.bytes = 0;
            elapsed = Duration::ZERO;
        }
        self.bytes = self.bytes.saturating_add(n);
        // budget 0은 호출 경로상 없지만(pty_budget의 최솟값이 128KB) 나눗셈이 inf가 되면
        // Duration::from_secs_f64가 패닉하고 그 패닉이 펌프 스레드를 통째로 죽인다.
        let owed = Duration::from_secs_f64(self.bytes as f64 / budget.max(1) as f64);
        if owed <= elapsed + PACER_BURST {
            return None;
        }
        let sleep = (owed - elapsed).min(PACER_WINDOW);
        self.window_start = now + sleep;
        self.bytes = 0;
        Some(sleep)
    }
}

/// 펌프가 Pacer 때문에 잔 것을 60초 단위로 모은다 — "터미널이 느리다"의 원인이 우리가 건
/// 브레이크인지 아닌지를 로그만 보고 가르기 위한 기록이다(태스크 69 §2).
struct ThrottleTally {
    since: Instant,
    sleeps: u32,
    slept: Duration,
    out_bytes: u64,
    /// 잔 **그 시점**의 가장 조인 예산과 그때의 메모리 레벨.
    ///
    /// 줄을 낼 때 `memory_level()`을 다시 읽으면 안 된다: 조임이 끝나고 레벨이 내려간 뒤에
    /// 줄이 나가면 `mem_lv=ok budget_kb=8192`로 찍혀 판별표(§5 "throttle 줄이 있고 mem_lv≥warn")가
    /// 정반대로 읽힌다. 예산은 레벨이 나쁠수록 작으므로 최솟값 하나면 최악 레벨도 함께 남는다.
    tightest: Option<(usize, Level)>,
}

/// 집계 창 길이. 줄에 `span_s=`로 함께 찍는다 — 세션이 닫히거나 조용해져 60초가 덜 찬 창도
/// 내보내므로, 길이를 모르면 sleeps·out_kb를 속도로 읽을 수 없다.
const TALLY_SPAN: Duration = Duration::from_secs(60);

impl ThrottleTally {
    fn new(now: Instant) -> Self {
        Self {
            since: now,
            sleeps: 0,
            slept: Duration::ZERO,
            out_bytes: 0,
            tightest: None,
        }
    }

    /// Pacer 때문에 잔 것을 기록한다(예산·레벨은 **그 순간의 값**으로 박아 둔다).
    fn slept_for(&mut self, d: Duration, budget: usize, mem_lv: Level) {
        self.sleeps += 1;
        self.slept += d;
        if self.tightest.is_none_or(|(b, _)| budget < b) {
            self.tightest = Some((budget, mem_lv));
        }
    }

    /// 지금까지 모인 것을 한 줄로. **잔 적이 없으면 줄을 만들지 않는다** — 평시 로그를 터미널
    /// 개수만큼 채우면 정작 신호가 묻힌다.
    fn line(&self, now: Instant, term: &str) -> Option<String> {
        let (budget, mem_lv) = self.tightest?;
        Some(format!(
            "[term-perf] pty-throttle term={term} span_s={} mem_lv={} budget_kb={} \
             sleeps={} slept_ms={} out_kb={}",
            now.saturating_duration_since(self.since).as_secs(),
            mem_lv.as_str(),
            budget / 1024,
            self.sleeps,
            self.slept.as_millis(),
            self.out_bytes / 1024,
        ))
    }

    /// 창 하나가 찼으면 줄을 내고 스스로 리셋한다.
    fn due(&mut self, now: Instant, term: &str) -> Option<String> {
        if now.saturating_duration_since(self.since) < TALLY_SPAN {
            return None;
        }
        let line = self.line(now, term);
        *self = Self::new(now);
        line
    }

    /// 다음 창 경계. 출력이 멎어도 이 시각엔 깨어나 줄을 내야 한다(아래 펌프 루프).
    fn window_end(&self) -> Instant {
        self.since + TALLY_SPAN
    }
}

/// 열려 있는 PTY 세션. Rust가 수명의 단일 진실 — 프론트 탭/프로젝트 전환과 무관하게 살아있다.
/// 필드는 같은 모듈(term_write/resize/close)에서만 접근한다.
pub struct TerminalSession {
    /// 키 입력을 PTY stdin으로.
    ///
    /// **Arc로 감싸 전역 세션 락 밖에서 쓴다**(태스크 63 §4 P2). 예전에는 `term_write`가
    /// `state.terminals`의 전역 뮤텍스를 쥔 채 `write_all`+`flush`를 했다 — 한 세션의 ConPTY
    /// 입력 버퍼가 차서 write가 막히면 **나머지 터미널 전부의 키 입력이 함께 막혔다.**
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// 리사이즈용 마스터 핸들. writer와 같은 이유로 Arc — `term_resize`도 전역 락을 짧게만 쥔다.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// kill용 자식 프로세스 (리더 스레드와 공유 — EOF 시 wait로 종료코드 수집)
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// 셸의 pid. portable-pty가 spawn 시 setsid()를 하므로 이 값이 곧 세션 id이자 프로세스 그룹 id다.
    /// 종료할 때 child 뮤텍스를 거치지 않고 이 값만으로 세션 전체를 죽이기 위해 따로 보관한다
    /// — 리더 스레드가 wait()로 그 뮤텍스를 잡고 있으면 종료 경로가 영구히 막히기 때문.
    pid: i32,
    /// 의도적 종료(term_close/replace/kill_all) 표시 — true면 리더가 term://exit를 억제한다.
    /// 재시작 시 옛 PTY를 kill하면 그 리더가 지연된 exit를 쏘아 새 PTY를 "exited"로 잘못
    /// 표시하는 레이스를 막는다.
    closed: Arc<AtomicBool>,
    /// 출력 sink — 현재 이 PTY를 그리는 웹뷰의 Channel. term_attach가 이 sink를 다른 창의
    /// Channel로 교체해 살아있는 세션을 별도 OS 창(플로팅)으로 옮긴다.
    ///
    /// 페이로드는 `Response`(= `InvokeResponseBody::Raw`)다. `Vec<u8>`이면 serde가 **JSON 숫자
    /// 배열**(`[27,91,...]`, 원시의 ~3.5배)을 만들고, 그게 8,192자를 넘는 순간 fetch 경로로
    /// 다시 실려 최악 조합이 된다. Raw면 1KB 미만은 지금처럼 eval 1홉, 그 이상은 fetch로
    /// **ArrayBuffer 그대로** 간다 — JSON 직렬화·파싱이 통째로 사라진다(태스크 63 §4 P0).
    sink: Arc<Mutex<Option<Channel<Response>>>>,
    /// 이 PTY가 속한 프로젝트 — 플로팅 창이 이 값으로 새 분할 패널의 cwd를 잡는다.
    project_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    term_id: String,
    code: i32,
}

/// `term_open` 응답 — 지금 이 프로세스가 어떤 ConPTY를 쓰는지 알린다(태스크 33 §3.2).
/// 프론트 동작에는 쓰지 않는다(`windowsPty`는 Terminal 생성자 옵션이라 이 응답으로는 늦다) —
/// 로그·e2e에서 번들 사이드로드가 실제로 먹었는지 확인하는 신호다. Windows 외에서는 None.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermOpened {
    conpty: Option<&'static str>, // "bundled" | "os"
    /// 실제로 띄운 셸 프로그램(경로) — 폴백(shell.rs)이 무엇을 골랐는지 로그·e2e에서 확인한다.
    shell: String,
}

/// 프로젝트 경로에 PTY 셸을 띄우고 출력 스트림(Channel)을 연결한다 (설계 §16.3).
/// termId는 프론트가 생성해 전달 — 응답이 유실돼도 고아 PTY가 남지 않는다(아는 id로 close).
#[tauri::command(async)]
pub fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    term_id: String,
    project_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
) -> Result<TermOpened, IpcError> {
    let path = project_path(&state, &project_id)?;
    if !path.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "프로젝트 경로를 찾을 수 없습니다",
        ));
    }

    // 셸 선택·실행은 shell.rs — 후보를 사전 검사·시간 제한으로 시도하고 막히면 다음 후보로 내려간다
    // (TERM/COLORTERM 명시 설정도 거기서 한다).
    let configured = state
        .settings
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .terminal_shell
        .clone();
    let shell::Opened {
        master,
        child,
        program: shell,
    } = shell::open(
        configured.as_deref(),
        &path,
        PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        },
    )?;

    let mut reader = master
        .try_clone_reader()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 리더 생성 실패: {e}")))?;
    let writer = master
        .take_writer()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 라이터 생성 실패: {e}")))?;

    let pid = i32::try_from(child.process_id().unwrap_or(0)).unwrap_or(0);
    let child = Arc::new(Mutex::new(child));
    let closed = Arc::new(AtomicBool::new(false));
    // 출력 sink를 Arc<Mutex>로 — 플로팅 분리 시 term_attach가 이 sink를 새 창 Channel로 바꾼다.
    let sink = Arc::new(Mutex::new(Some(on_data)));

    // 출력은 **리더 + 펌프** 두 스레드로 나눈다(태스크 63 §4 P0).
    //
    // 리더는 지금처럼 블로킹 read만 하고 큐에 넘기고, 펌프가 `FLUSH_MS` 동안 모아 한 번만
    // Channel::send 한다. 왜 스레드를 더 쓰는가: portable_pty의 리더에는 타임아웃 read가 없어
    // "시간축 합치기"를 리더 안에서 할 수 없다(폴링은 CPU를 태우고 플랫폼별 분기가 생긴다).
    // 대기만 하는 스레드라 실질 비용이 없고, 기존 "세션당 스레드 1개" 모델의 자연스러운 확장이다.
    let (tx, rx) = sync_channel::<Vec<u8>>(PUMP_QUEUE);
    {
        let sink = Arc::clone(&sink);
        // 로그 한 줄에 전체 id를 싣지 않는다 — 터미널 여러 개를 한눈에 훑을 때만 쓰는 꼬리표다.
        let log_term: String = term_id.chars().take(8).collect();
        std::thread::spawn(move || {
            let mut pacer = Pacer::new(Instant::now());
            let mut tally = ThrottleTally::new(Instant::now());
            let mut buf: Vec<u8> = Vec::with_capacity(MAX_CHUNK);
            let mut deadline = Instant::now();
            // 모아 둔 것을 한 번에 보낸다. sink가 None(의도적 종료)이면 조용히 버린다 — 기존과 같다.
            // tally를 클로저가 가두면 루프(유휴 경계·EOF)에서 못 쓰므로 인자로 받는다.
            let mut flush = |buf: &mut Vec<u8>, tally: &mut ThrottleTally| {
                if buf.is_empty() {
                    return;
                }
                let n = buf.len();
                let chunk = std::mem::replace(buf, Vec::with_capacity(MAX_CHUNK));
                if let Some(ch) = sink.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    // 창이 닫혀 send가 실패해도 루프를 끊지 않는다 — 플로팅 분리 중
                    // (detach↔attach 사이)의 짧은 공백을 위해서다.
                    let _ = ch.send(Response::new(chunk));
                }
                // 속도 제한(Pacer 주석 참고) — 넘치면 여기서 잠깐 잔다. 그동안 리더는 큐가
                // 차면 막히고, PTY 버퍼가 차고, 셸의 write가 막힌다(역압 경로는 예전 그대로).
                // 예산은 매번 읽는다(원자값 1회 로드) — 경보가 뜨면 즉시 조여진다.
                let budget = pty_budget();
                if let Some(d) = pacer.take(n, Instant::now(), budget) {
                    std::thread::sleep(d);
                    tally.slept_for(d, budget, crate::health::memory_level());
                }
                tally.out_bytes += n as u64;
                if let Some(line) = tally.due(Instant::now(), &log_term) {
                    log::info!("{line}");
                }
            };
            loop {
                // 모은 게 없으면 무한 대기(빈 채로 깨어날 이유가 없다), 있으면 남은 창 시간만.
                // 예외: 이미 조여진 세션은 **창 경계에서도** 깨운다 — 조임이 끝나고 조용해지면
                // 그 집계가 다음 출력(몇 분 뒤일 수 있다)까지 미뤄져 엉뚱한 시각에 찍힌다.
                let got = if buf.is_empty() {
                    if tally.sleeps == 0 {
                        rx.recv().ok()
                    } else {
                        let until = tally.window_end().saturating_duration_since(Instant::now());
                        match rx.recv_timeout(until) {
                            Ok(v) => Some(v),
                            Err(RecvTimeoutError::Timeout) => {
                                if let Some(line) = tally.due(Instant::now(), &log_term) {
                                    log::info!("{line}");
                                }
                                continue;
                            }
                            Err(RecvTimeoutError::Disconnected) => None,
                        }
                    }
                } else {
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(v) => Some(v),
                        Err(RecvTimeoutError::Timeout) => {
                            flush(&mut buf, &mut tally);
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => None,
                    }
                };
                let Some(v) = got else {
                    // 리더가 EOF로 끝났다 — **남은 버퍼를 마저 보내고** 끝낸다(마지막 출력 유실 금지).
                    flush(&mut buf, &mut tally);
                    // 60초가 덜 찬 창도 여기서 내보낸다 — 조여지던 터미널을 바로 닫으면
                    // 그 조임 기록이 통째로 사라진다.
                    if let Some(line) = tally.line(Instant::now(), &log_term) {
                        log::info!("{line}");
                    }
                    break;
                };
                if buf.is_empty() {
                    deadline = Instant::now() + Duration::from_millis(FLUSH_MS);
                }
                buf.extend_from_slice(&v);
                if buf.len() >= MAX_CHUNK {
                    flush(&mut buf, &mut tally);
                }
            }
        });
    }

    // 전용 std 스레드에서 블로킹 read 루프 — tokio 실행기/메인스레드를 막지 않는다(설계 §16.2).
    {
        let app = app.clone();
        let child = Arc::clone(&child);
        let closed = Arc::clone(&closed);
        let term_id = term_id.clone();
        std::thread::spawn(move || {
            // 64KB — 상한일 뿐이다. read()는 "그 순간 있는 만큼"만 돌려주므로 이 크기가
            // Channel send 횟수를 줄여주지는 않는다(그 일은 위 펌프의 시간축 합치기가 한다).
            let mut buf = [0u8; MAX_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — 셸 종료
                    Ok(n) => {
                        // 큐가 차면 여기서 막힌다 — 그게 역압이다(PTY 버퍼 → 셸의 write).
                        // send 실패는 펌프가 사라진 경우뿐이라 더 읽을 이유가 없다.
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    // EINTR은 정상적인 시그널 인터럽트다. 여기서 루프를 끊으면 아직 살아있는 셸에
                    // 곧바로 블로킹 wait()를 걸어 child 뮤텍스를 영구 점유한다 — 반드시 재시도.
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            // 펌프에게 즉시 종료를 알린다 — 이 drop이 늦으면(아래 wait()가 오래 걸린다)
            // 셸의 마지막 출력이 최대 wait 시간만큼 화면에 늦게 뜬다.
            drop(tx);
            let code = child
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .wait()
                .map(|s| s.exit_code() as i32)
                .unwrap_or(-1);
            // 셸이 스스로 끝난 경우(exit 입력 등)에도 레지스트리 엔트리가 남아 writer/master fd가
            // 영구 누적됐다 — 자기 엔트리를 회수한다. pid를 대조해 term_open 교체와의 레이스를 피한다.
            if let Some(state) = app.try_state::<AppState>() {
                let mut terms = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
                if terms.get(&term_id).map(|s| s.pid) == Some(pid) {
                    terms.remove(&term_id);
                }
            }
            // 의도적으로 닫힌(재시작/교체/앱종료) 세션은 exit 이벤트를 쏘지 않는다 — 레이스 방지.
            if !closed.load(Ordering::Relaxed) {
                let _ = app.emit("term://exit", TermExit { term_id, code });
            }
        });
    }

    let session = TerminalSession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(master)),
        child,
        pid,
        closed,
        sink,
        project_id,
    };
    // 같은 id의 옛 세션이 남아있으면(비정상 경로) 먼저 억제+kill 후 교체한다.
    // 락은 insert까지만 — 종료는 락 밖에서(최대 300ms 소요, 전역 락을 물고 있으면 UI가 멈춘다).
    let old = state
        .terminals
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(term_id.clone(), session);
    if let Some(old) = old {
        spawn_terminate(old);
    }
    // portable-pty의 conpty.dll 로드는 **첫 PTY 생성 시점**(lazy_static)이라 여기서부터 판정이
    // 확정된다. GetModuleHandleW가 non-null이면 우리가 번들한 DLL이 실제로 실린 것.
    #[cfg(windows)]
    let conpty = Some(if crate::conpty_sideloaded() {
        "bundled"
    } else {
        "os"
    });
    #[cfg(not(windows))]
    let conpty: Option<&'static str> = None;
    #[cfg(windows)]
    log::info!(
        "ConPTY: {}",
        if conpty == Some("bundled") {
            "사이드로드 확인"
        } else {
            "OS 내장"
        }
    );
    Ok(TermOpened { conpty, shell })
}

/// 키 입력을 PTY stdin에 raw로 전달 — 셸 문자열 조립 없음(인젝션 표면 없음).
#[tauri::command(async)]
pub fn term_write(
    state: State<'_, AppState>,
    term_id: String,
    data: String,
) -> Result<(), IpcError> {
    // 전역 락은 **Arc 복제까지만** 쥔다. 예전에는 이 락 아래에서 write_all+flush를 했고,
    // 한 세션의 ConPTY 입력 버퍼가 차면 터미널 13개의 키 입력이 함께 막혔다(태스크 63 §3.4).
    let writer = {
        let terms = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
        terms
            .get(&term_id)
            .map(|s| Arc::clone(&s.writer))
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "터미널 세션을 찾을 수 없습니다"))?
    };
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    w.write_all(data.as_bytes())
        .and_then(|_| w.flush())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("터미널 입력 실패: {e}")))
}

/// 살아있는 PTY의 출력 sink를 새 웹뷰 Channel로 교체 — 별도 OS 창(플로팅)이 기존 세션에 재연결.
/// PTY/프로세스는 그대로 유지되고 출력만 새 창으로 흐른다(스크롤백은 옮겨지지 않음).
#[tauri::command]
pub fn term_attach(
    state: State<'_, AppState>,
    term_id: String,
    on_data: Channel<Response>,
) -> Result<(), IpcError> {
    let terms = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
    let session = terms
        .get(&term_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "터미널 세션을 찾을 수 없습니다"))?;
    *session.sink.lock().unwrap_or_else(|e| e.into_inner()) = Some(on_data);
    Ok(())
}

/// 살아있는 PTY의 프로젝트 id를 돌려준다 — 플로팅 창이 새 분할 패널을 같은 프로젝트로 열 때 사용.
#[tauri::command]
pub fn term_project(state: State<'_, AppState>, term_id: String) -> Option<String> {
    state
        .terminals
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&term_id)
        .map(|s| s.project_id.clone())
}

/// ConPTY 리사이즈 — xterm fit 결과(cols/rows)를 반영.
#[tauri::command(async)]
pub fn term_resize(
    state: State<'_, AppState>,
    term_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    // term_write와 같은 이유로 전역 락은 Arc 복제까지만 쥔다.
    let master = {
        let terms = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
        terms
            .get(&term_id)
            .map(|s| Arc::clone(&s.master))
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "터미널 세션을 찾을 수 없습니다"))?
    };
    let m = master.lock().unwrap_or_else(|e| e.into_inner());
    m.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("터미널 리사이즈 실패: {e}")))
}

/// 세션 종료 — child kill 후 레지스트리에서 제거(드롭이 writer·master를 닫는다).
#[tauri::command(async)]
pub fn term_close(state: State<'_, AppState>, term_id: String) -> Result<(), IpcError> {
    close_session(state.inner(), &term_id);
    Ok(())
}

/// 단일 세션 종료(세션 트리 kill + 제거). 커맨드/창 이벤트(플로팅 창 닫힘) 공용.
pub fn close_session(state: &AppState, term_id: &str) {
    // 맵에서 먼저 꺼내고 락을 놓는다. 예전에는 `if let Some(..) = lock().remove(..)` 형태라
    // 가드가 본문 끝까지 살아 kill을 전역 락 아래에서 돌렸다.
    let session = state.terminals.lock().unwrap_or_else(|e| e.into_inner()).remove(term_id);
    if let Some(session) = session {
        spawn_terminate(session);
    }
}

/// 프로젝트 하나에 딸린 PTY를 전부 거둔다 — `remove_project`가 부른다.
///
/// **대상 term_id를 먼저 모으고 락을 놓은 뒤** `close_session`을 부른다. 가드를 쥔 채 부르면
/// `close_session`이 같은 `state.terminals` 뮤텍스를 다시 잠가 그 자리에서 데드락이다.
/// 프론트에도 같은 정리가 있지만(`useRemoveProjectFull`), 이 함수가 정본이다 — 이유는
/// `remove_project` 쪽 주석 참조.
pub(crate) fn close_project_sessions(state: &AppState, project_id: &str) {
    let term_ids: Vec<String> = {
        let terms = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
        terms
            .iter()
            .filter(|(_, s)| s.project_id == project_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for term_id in term_ids {
        close_session(state, &term_id);
    }
}

/// 종료를 별도 스레드로 넘긴다.
///
/// `term_close`는 `#[tauri::command]` 동기 커맨드라 **GTK 메인 이벤트 루프에서 실행된다.**
/// 세션 트리 종료는 유예 시간 때문에 최대 300ms가 걸리므로 여기서 기다리면 그동안 앱 전체
/// (사이드바·에디터·다른 터미널 입력)가 얼어붙는다. 프로젝트 제거처럼 PTY 여러 개를 한 번에
/// 닫는 경로에서는 수 초 프리즈가 된다. 맵에서 이미 제거했으므로 `term_open` 교체와의
/// 레이스는 그 시점에 이미 해소돼 있어 완료를 기다릴 이유가 없다.
fn spawn_terminate(session: TerminalSession) {
    std::thread::spawn(move || terminate(&session));
}

/// 앱 종료 시 모든 PTY 세션 트리를 정리한다 (고아 프로세스 방지, 설계 §16.8).
pub fn kill_all(state: &AppState) {
    let sessions: Vec<TerminalSession> = {
        let mut terms = state.terminals.lock().unwrap_or_else(|e| e.into_inner());
        terms.drain().map(|(_, s)| s).collect()
    };
    // 여기서는 정리 완료를 보장해야 한다(앱이 곧 사라지므로). 다만 순차로 돌리면
    // 세션 N개 × 300ms 만큼 종료가 늦어지므로 병렬로 던지고 한 번만 기다린다.
    let handles: Vec<_> = sessions
        .into_iter()
        .map(|s| std::thread::spawn(move || terminate(&s)))
        .collect();
    for h in handles {
        let _ = h.join();
    }
}

/// 세션 종료의 단일 진입점 — 의도적 종료 표시 + sink 차단 + 세션 트리 종료.
fn terminate(session: &TerminalSession) {
    // 리더가 지연된 term://exit를 쏘지 않게 하고(재시작 레이스 방지),
    // 죽은 Channel로 계속 IPC를 쏘지 않도록 sink를 비운다.
    session.closed.store(true, Ordering::Relaxed);
    *session.sink.lock().unwrap_or_else(|e| e.into_inner()) = None;

    #[cfg(unix)]
    if session.pid > 0 {
        terminate_tree(session.pid);
        return;
    }
    // 폴백(Windows 또는 pid 미확보): 자식만 종료. try_lock으로 절대 매달리지 않는다 —
    // 리더 스레드가 wait()로 이 뮤텍스를 쥐고 있을 수 있다.
    if let Ok(mut child) = session.child.try_lock() {
        let _ = child.kill();
    }
}

/// PTY 셸이 만든 **세션 전체**를 종료한다.
///
/// portable-pty는 spawn 시 `setsid()`로 셸을 세션 리더로 만든다(pid == sid == pgid).
/// 그런데 셸이 띄운 job들(`npm run dev`, 워처, CLI 에이전트…)은 **서로 다른 프로세스 그룹**에
/// 산다. 예전 코드는 `libc::kill(pid, SIGHUP)`으로 셸 PID 하나만 때렸고, 200ms 안에 안 죽으면
/// SIGKILL로 즉사시켜 셸이 자기 job에 HUP을 전파할 기회조차 없앴다 — job 트리 전체가 고아가
/// 되고, 고아는 PID 1로 재부모화돼도 **cgroup 소속은 그대로**라 앱 scope에 영구 잔류했다.
/// 이것이 2026-08 systemd-oomd 강제 종료(387 프로세스, CPU 4일치)의 주범이다.
#[cfg(unix)]
fn terminate_tree(pid: i32) {
    use std::time::Duration;

    // pid 1/0/음수에 대한 방어 — `kill(-1, SIGKILL)`은 보낼 수 있는 모든 프로세스를 죽인다.
    if pid <= 1 {
        return;
    }

    // 1) 대상을 **시그널을 보내기 전에** 확정한다. 죽고 나면 init으로 재부모화되어 ppid 링크가
    //    끊기므로, 나중에 스캔하면 자손 폐포를 만들 수 없다.
    let mut victims = session_tree(pid);

    // 2) 셸의 프로세스 그룹에 정중히 — 셸이 자기 job에 HUP을 전파할 기회를 준다.
    //    SIGCONT를 함께 보내는 이유: Ctrl+Z로 정지(T)된 프로세스는 시그널을 대기열에만 넣고
    //    핸들러를 실행하지 못한다. 깨우지 않으면 vim 같은 편집기가 복구 파일을 쓸 기회 없이
    //    300ms 뒤 SIGKILL로 즉사해 미저장 편집분이 사라진다.
    unsafe {
        libc::kill(-pid, libc::SIGHUP);
        libc::kill(-pid, libc::SIGTERM);
        libc::kill(-pid, libc::SIGCONT);
    }
    // 3) 셸의 프로세스 그룹 밖(자기 job 그룹, setsid로 갈라진 자손)은 위 신호를 못 받는다.
    for p in &victims {
        unsafe {
            libc::kill(*p, libc::SIGTERM);
            libc::kill(*p, libc::SIGCONT);
        }
    }
    // 4) 최대 300ms 유예. 전원이 사라지면 조기 탈출한다.
    //    `kill(pid, 0)`으로 판정하면 안 된다 — **좀비(Z)에도 0을 반환**하므로, 자식이 남아
    //    리더가 reap하지 못한 흔한 경우에 조기 탈출이 영영 발동하지 않고 매번 300ms를 다 쓴다.
    //    reap 자체는 리더 스레드의 wait()가 담당하므로 여기서 waitpid를 하면 ECHILD로 어긋난다.
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(20));
        if !alive(pid) && !victims.iter().any(|p| alive(*p)) {
            break;
        }
    }
    // 5) 잔존 전원 SIGKILL. 유예 중 새로 생긴 자손까지 다시 훑는다.
    //    여기서 슬레이브 fd가 모두 닫혀야 리더가 EOF를 받고 wait()로 셸을 회수한다 —
    //    하나라도 살아남으면 리더가 영원히 블록되고 셸이 좀비로 남는다.
    victims.extend(session_tree(pid));
    victims.sort_unstable();
    victims.dedup();
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    for p in &victims {
        unsafe {
            libc::kill(*p, libc::SIGKILL);
        }
    }
}

/// 살아있는가. **좀비(Z)는 죽은 것으로 본다** — 이미 종료했고 부모의 wait만 남은 상태다.
#[cfg(unix)]
fn alive(pid: i32) -> bool {
    proc_stat(pid).is_some_and(|(state, _, _)| state != 'Z')
}

/// `/proc/<pid>/stat`에서 (state, ppid, session)을 뽑는다.
///
/// `pid (comm) state ppid pgrp session ...` 형식인데 comm에 공백·괄호가 들어갈 수 있어
/// **마지막 ')' 뒤부터** 파싱해야 한다. 그 뒤 필드: [0]=state [1]=ppid [2]=pgrp [3]=session
#[cfg(unix)]
fn proc_stat(pid: i32) -> Option<(char, i32, i32)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let cut = stat.rfind(')')?;
    let f: Vec<&str> = stat[cut + 1..].split_whitespace().collect();
    Some((
        f.first()?.chars().next()?,
        f.get(1)?.parse().ok()?,
        f.get(3)?.parse().ok()?,
    ))
}

/// 종료 대상 전체 = (세션 id가 `root`인 프로세스) ∪ (`root`의 ppid 자손 폐포). `root` 자신은 제외.
///
/// 두 집합이 모두 필요하다. 세션 스캔만으로는 **`setsid()`로 자기 세션을 만든 자손**
/// (`pm2`, 데몬화하는 dev 서버 등 — 이 머신에서 `next-server`가 실제로 그렇다)을 놓치고,
/// 그놈이 pty 슬레이브 fd를 쥔 채 살아남으면 리더 스레드가 EOF를 못 받아 셸이 영구 좀비가 되고
/// 마스터 fd·스레드가 통째로 누수된다. 반대로 ppid 폐포만으로는 이미 재부모화된 손자를 놓친다.
#[cfg(unix)]
fn session_tree(root: i32) -> Vec<i32> {
    use std::collections::HashMap;

    let mut info: HashMap<i32, (i32, i32)> = HashMap::new(); // pid -> (ppid, sid)
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<i32>().ok()) else {
            continue;
        };
        if let Some((_, ppid, sid)) = proc_stat(pid) {
            info.insert(pid, (ppid, sid));
        }
    }

    let mut out: Vec<i32> = info
        .iter()
        .filter(|(pid, (_, sid))| **pid != root && *sid == root)
        .map(|(pid, _)| *pid)
        .collect();

    // ppid 자손 폐포 — 부모별 자식 색인을 만들어 BFS.
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, (ppid, _)) in &info {
        children.entry(*ppid).or_default().push(*pid);
    }
    let mut queue = vec![root];
    while let Some(p) = queue.pop() {
        if let Some(kids) = children.get(&p) {
            for k in kids {
                if *k != root && !out.contains(k) {
                    out.push(*k);
                    queue.push(*k);
                }
            }
        }
    }

    out.retain(|p| *p > 1 && *p != root);
    out.sort_unstable();
    out.dedup();
    out
}

/// 터미널 붙여넣기용 클립보드 판별:
/// 1) 파일 목록(탐색기/폴더에서 복사) → 인용된 경로(여러 개면 공백 구분)
/// 2) 이미지 데이터(스크린샷 등) → 임시 파일로 저장 후 그 경로
/// 3) 일반 텍스트 → 그대로
///
/// **반환은 세 갈래다**(A-K5). 예전엔 전부 빈 문자열이라 "클립보드가 비었다"와 "읽지 못했다"가
/// 구분되지 않았고, 프론트는 둘 다 조용한 no-op으로 삼켰다 — 사용자에겐 "눌렀는데 아무 일도
/// 안 일어남"이고 로그도 없었다.
/// - `Ok(Some(text))` — 붙여넣을 것이 있다
/// - `Ok(None)` — 클립보드가 비었다(정상. 프론트는 info 토스트)
/// - `Err(사유)` — 못 읽었다(타임아웃·OS 오류. 프론트는 사유 토스트 + [다시 시도])
///
/// **async.** 클립보드는 null HWND 로 열어 스레드 친화가 없다. 동기(= UI 스레드)이면 이미지가 든
/// 클립보드에서 포맷 변환 + 수 MB BMP 쓰기가 창 메시지 루프를 붙잡는다(2026-09-17 멈춤 조사 후보).
#[cfg(windows)]
#[tauri::command(async)]
pub fn term_paste() -> Result<Option<String>, String> {
    use clipboard_win::{formats, get_clipboard, raw};

    let files: Vec<String> = get_clipboard(formats::FileList).unwrap_or_default();
    if !files.is_empty() {
        return Ok(Some(
            files
                .iter()
                .map(|p| shell_quote(p))
                .collect::<Vec<_>>()
                .join(" "),
        ));
    }

    let bmp: Vec<u8> = get_clipboard(formats::Bitmap).unwrap_or_default();
    if bmp.len() > 64 {
        if let Some(path) = save_temp_image(&bmp) {
            return Ok(Some(shell_quote(&path)));
        }
    }

    match get_clipboard::<String, _>(formats::Unicode) {
        Ok(s) if s.is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        // `get_clipboard`는 "텍스트 형식이 아예 없다"와 "클립보드를 못 열었다"를 둘 다 Err로 준다.
        // 둘을 가르는 건 `IsClipboardFormatAvailable`이다 — OpenClipboard가 필요 없어 경합의
        // 영향을 받지 않는다. 형식이 없으면 그냥 빈 클립보드다(이미지도 파일도 아닌 무언가 포함).
        Err(_) if !raw::is_format_avail(formats::CF_UNICODETEXT) => Ok(None),
        Err(e) => Err(format!("클립보드를 읽지 못했습니다 ({e})")),
    }
}

/// Linux(X11/XWayland)·macOS: 파일→경로, 이미지→임시 PNG 경로, 그 외 텍스트.
/// (macOS 파일 목록은 NSPasteboard로 직접 읽는다 — macos_clipboard_files. Linux의 text/uri-list는
/// arboard 미지원이라 여전히 텍스트 폴백에 기댄다 — 파일 매니저 복사는 대부분 경로가 함께 온다.)
///
/// 반드시 async 커맨드로 메인 스레드 밖에서 실행한다: 동기 커맨드는 GTK 메인루프에서 돌고,
/// X11 클립보드는 "소유자가 요청에 응답"하는 모델이라 웹뷰(이 앱 자신)가 복사 주체일 때
/// 메인루프가 막혀 있으면 자기 자신을 기다리는 데드락이 된다(tauri plugins-workspace#2267과 동일 기전).
/// 여기에 더해 소유자가 끝내 응답하지 않는 경우를 대비해 워커 스레드 + 타임아웃으로 감싼다
/// — 타임아웃은 `Err`로 올라가고(Windows판 주석의 세 갈래) UI는 절대 매달리지 않는다.
///
/// **타임아웃은 플랫폼별로 다르다.** Linux의 2초는 위 X11 "소유자 무응답" 대비다. macOS는
/// 15.4+/26의 페이스트보드 프라이버시 프롬프트("~에서 붙여넣으려고 합니다")가 읽기를 **사용자가
/// 응답할 때까지** 블록한다 — 2초면 사람이 누르기 전에 끝나서 (1) 결과를 버리고 (2) 프론트가
/// 빈 값을 보고 재시도해 프롬프트를 하나 더 띄운다. ⌘V 연타와 겹치면 프롬프트가 줄줄이 쌓였다가
/// Allow 순간 쌓인 붙여넣기가 한꺼번에 발사되는 폭주가 됐다(2026-08-28 실사례). 사람이 프롬프트를
/// 읽고 누를 시간으로 120초를 준다 — 데드락 기전 자체가 macOS엔 없으므로 길어도 안전하다.
#[cfg(not(windows))]
#[tauri::command(async)]
pub fn term_paste() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    const TIMEOUT_MS: u64 = 120_000;
    #[cfg(not(target_os = "macos"))]
    const TIMEOUT_MS: u64 = 2000;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(read_clipboard_unix());
    });
    match rx.recv_timeout(std::time::Duration::from_millis(TIMEOUT_MS)) {
        Ok(r) => r,
        // 소유자가 끝내 응답하지 않았다. 워커는 그대로 두고(다음 요청과 경쟁하지 않는다) 사유만 올린다.
        Err(_) => Err("클립보드 소유자가 응답하지 않습니다".into()),
    }
}

/// `Ok(None)` = 클립보드가 비었다 · `Err` = 읽지 못했다(term_paste의 세 갈래 주석 참조).
#[cfg(not(windows))]
fn read_clipboard_unix() -> Result<Option<String>, String> {
    // macOS는 파일 목록을 **이미지보다 먼저** 본다 — 이유는 macos_clipboard_files 주석 참조.
    // 이로써 세 플랫폼 모두 "파일 → 이미지 → 텍스트" 우선순위로 일치한다.
    #[cfg(target_os = "macos")]
    {
        let files = macos_clipboard_files();
        if !files.is_empty() {
            return Ok(Some(
                files
                    .iter()
                    .map(|p| shell_quote(p))
                    .collect::<Vec<_>>()
                    .join(" "),
            ));
        }
    }

    // Linux에서 여기가 Err면 흔히 `DISPLAY` 없는 세션이다 — 앱 수명 내내 재발하므로
    // 조용한 no-op이 아니라 사유로 올린다(clipboard.ts의 "플러그인 영구 실패"와 같은 함정).
    let mut cb = arboard::Clipboard::new()
        .map_err(|e| format!("클립보드를 열지 못했습니다 ({e})"))?;
    // Windows 구현과 같은 우선순위: 이미지(스크린샷) 먼저, 아니면 텍스트.
    if let Ok(img) = cb.get_image() {
        if let Some(path) = save_temp_png(&img) {
            return Ok(Some(shell_quote(&path)));
        }
    }
    match cb.get_text() {
        Ok(s) if s.is_empty() => Ok(None),
        Ok(s) => Ok(Some(s)),
        // 요청한 형식이 없거나 클립보드가 비었다 — arboard가 둘을 한 변형으로 준다(common.rs:24).
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(format!("클립보드를 읽지 못했습니다 ({e})")),
    }
}

/// macOS: Finder ⌘C가 올린 `public.file-url`을 실제 파일 경로로 읽는다(Windows FileList 대응).
///
/// **`get_image()`보다 먼저 호출해야 한다.** Finder는 파일을 복사할 때 URL과 **함께 파일 아이콘
/// TIFF**를 페이스트보드에 올린다. arboard는 `public.file-url`을 못 읽는 반면 그 아이콘은 이미지로
/// 집어 들기 때문에, 순서가 뒤바뀌면 붙여넣기 결과가 **1024×1024 범용 문서 아이콘을 저장한
/// `gitpervisor-paste-*.png` 경로**가 된다 — 실제 파일 경로는 영영 나오지 않는다.
///
/// **`types()` 확인을 빼지 마라.** 이 확인 없이 `readObjectsForClasses:[NSURL]`를 부르면 AppKit이
/// 평범한 텍스트(`public.utf8-plain-string`)에서 NSURL을 **합성**해, URL처럼 생긴 문자열을 복사한
/// 일반 텍스트 붙여넣기까지 경로로 바꿔 버린다.
///
/// 워커 스레드에서 불린다(term_paste 참조). NSPasteboard 읽기는 메인 스레드 전용이 아니며
/// (objc2가 MainThreadMarker를 요구하지 않는다), 같은 스레드에서 arboard도 이미 이 API를 쓴다.
#[cfg(target_os = "macos")]
fn macos_clipboard_files() -> Vec<String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSArray, NSURL};

    let pb = NSPasteboard::generalPasteboard();
    // extern "C" static — 접근 자체가 unsafe다.
    let file_url_ty = unsafe { NSPasteboardTypeFileURL };
    let declares_file_url = pb
        .types()
        .is_some_and(|ts| ts.iter().any(|t| *t == *file_url_ty));
    if !declares_file_url {
        return Vec::new();
    }

    let classes = NSArray::from_slice(&[NSURL::class()]);
    // SAFETY: class_array는 NSPasteboardReading을 구현하는 NSURL 하나뿐이고, options는 None.
    let Some(objs) = (unsafe { pb.readObjectsForClasses_options(&classes, None) }) else {
        return Vec::new();
    };

    objs.iter()
        .filter_map(|o: Retained<AnyObject>| o.downcast::<NSURL>().ok())
        // types() 확인을 통과해도 배열에 비-파일 URL이 섞일 수 있다(다중 아이템 페이스트보드).
        .filter(|u| u.isFileURL())
        .filter_map(|u| u.path().map(|p| p.to_string()))
        .collect()
}

/// 클립보드 RGBA 이미지를 임시 PNG로 저장하고 경로를 돌려준다 (Windows save_temp_image의 unix 대응).
#[cfg(not(windows))]
fn save_temp_png(img: &arboard::ImageData<'_>) -> Option<String> {
    let buf = image::RgbaImage::from_raw(
        u32::try_from(img.width).ok()?,
        u32::try_from(img.height).ok()?,
        img.bytes.clone().into_owned(),
    )?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let mut path = std::env::temp_dir();
    path.push(format!("gitpervisor-paste-{nanos}.png"));
    buf.save(&path).ok()?;
    Some(path.to_string_lossy().into_owned())
}

fn shell_quote(p: &str) -> String {
    if p.chars().any(|c| c.is_whitespace()) {
        format!("\"{p}\"")
    } else {
        p.to_string()
    }
}

#[cfg(windows)]
fn save_temp_image(bytes: &[u8]) -> Option<String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let mut path = std::env::temp_dir();
    path.push(format!("gitpervisor-paste-{nanos}.bmp"));
    std::fs::write(&path, bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

// Linux 한정 — macOS는 unix지만 이 테스트의 전제 둘이 다 없다: 검증 대상인 세션 스캔
// (session_tree/alive)이 /proc를 읽는 Linux 전용 구현이고, 픽스처가 실행하는 setsid(1)
// 명령도 macOS에 없다. macOS에서 terminate_tree는 killpg + pid 가드까지만 동작하고
// 세션 스캔·ppid 폐포는 빈손이 된다(알려진 갭 — /proc 부재).
#[cfg(all(test, target_os = "linux"))]
mod terminate_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn alive_pid(pid: i32) -> bool {
        super::alive(pid)
    }

    /// 지정 pid가 사라질 때까지 최대 `ms` 대기.
    fn wait_gone(pid: i32, ms: u64) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(ms) {
            if !alive_pid(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !alive_pid(pid)
    }

    /// PTY 셸을 흉내내는 세션 리더를 만들고, 그 안에 (a) 같은 그룹의 자식과
    /// (b) `setsid`로 자기 세션을 만든 손자를 띄운다.
    ///
    /// (b)가 핵심이다 — 예전 코드(`kill(pid, SIGHUP)` 단건)는 물론이고 killpg만으로도
    /// 닿지 않아 앱 cgroup에 영구 잔류했다. 이것이 2026-08-01 OOM 사건의 주범 경로다.
    fn spawn_session_tree() -> (i32, Vec<i32>) {
        // setsid로 세션 리더를 만들고, 그 안에서 두 종류의 자손을 띄운 뒤 pid를 뱉게 한다.
        let out = std::process::Command::new("setsid")
            .arg("--wait")
            .arg("sh")
            .arg("-c")
            .arg(
                // 세션 리더(sh)가 자기 pid와 자손 pid들을 파일로 남기고 오래 산다.
                "sleep 60 & echo child=$!; setsid sh -c 'sleep 60' & echo grand=$!; \
                 echo leader=$$; sleep 60",
            )
            .stdout(std::process::Stdio::piped())
            .spawn()
            .expect("setsid 실행 실패");
        // stdout에서 pid들을 읽는다(파이프가 열려 있으므로 논블로킹 대신 짧게 읽는다).
        std::thread::sleep(Duration::from_millis(300));
        let leader = out.id() as i32;
        // setsid --wait 는 자식을 기다리므로 out.id()는 setsid 자신. 실제 세션 리더는 그 자식.
        let members = super::session_tree(leader);
        (leader, members)
    }

    /// 세션 트리 전체가 종료되어야 한다 — setsid로 갈라진 손자까지.
    #[test]
    fn terminate_tree_kills_setsid_descendants() {
        let (leader, _) = spawn_session_tree();
        // 종료 전: 트리에 자손이 실제로 존재해야 테스트가 의미 있다.
        let before = super::session_tree(leader);
        assert!(
            !before.is_empty(),
            "테스트 전제 실패: 자손이 안 생겼다 (leader={leader})"
        );

        super::terminate_tree(leader);

        assert!(wait_gone(leader, 2000), "세션 리더가 남았다");
        for p in &before {
            assert!(
                wait_gone(*p, 2000),
                "자손 {p}가 살아남았다 — cgroup에 영구 잔류하는 누수 경로"
            );
        }
    }

    /// pid 0/1/음수에는 절대 시그널을 보내면 안 된다.
    /// `kill(-1, SIGKILL)`은 보낼 수 있는 **모든 프로세스**를 죽인다.
    #[test]
    fn terminate_tree_refuses_dangerous_pids() {
        for pid in [-1, 0, 1] {
            super::terminate_tree(pid); // 패닉 없이 즉시 반환해야 한다
        }
        // 우리 자신이 살아있으면 통과(위 호출이 아무 것도 죽이지 않았다는 뜻).
        assert!(alive_pid(std::process::id() as i32));
    }

    /// 좀비는 "죽은 것"으로 봐야 한다 — kill(pid,0)은 좀비에도 성공하므로
    /// 그걸로 판정하면 유예 루프가 매번 최대치를 다 쓴다.
    #[test]
    fn zombie_counts_as_dead() {
        let mut child = std::process::Command::new("true").spawn().expect("spawn");
        let pid = child.id() as i32;
        // wait 하지 않고 종료를 기다리면 좀비가 된다.
        std::thread::sleep(Duration::from_millis(200));
        assert!(!alive_pid(pid), "좀비를 살아있다고 판정했다");
        let _ = child.wait();
    }
}

/// Pacer·ThrottleTally는 플랫폼 무관 순수 로직이라 위 unix 전용 모듈과 분리한다 —
/// 안에 넣으면 정작 이 코드를 매일 쓰는 Windows에서 한 번도 검증되지 않는다.
#[cfg(test)]
mod pacer_tests {
    use super::*;

    /// 정상적인 출력량에는 절대 브레이크가 걸리면 안 된다.
    /// (빌드 로그가 화면에 늦게 뜨면 그게 곧 버그 리포트가 된다.)
    #[test]
    fn pacer_never_throttles_normal_output() {
        let t0 = Instant::now();
        let mut p = Pacer::new(t0);
        // 1초 동안 64KB씩 100번 = 6.4MB — 빌드 로그로도 과한 양인데 상한(8MB) 아래다.
        for i in 0..100 {
            let now = t0 + Duration::from_millis(i * 10);
            assert!(
                p.take(64 * 1024, now, PTY_BYTES_PER_SEC).is_none(),
                "정상 출력에 브레이크가 걸렸다({}번째)",
                i
            );
        }
    }

    /// 무한 출력(`yes` 등)의 **평균 속도**가 예산을 넘으면 안 된다 — 넘기면 Tauri Channel
    /// 큐가 무한히 커진다. 지시받은 만큼 실제로 잤다고 치고 가상 시계를 돌린다.
    #[test]
    fn pacer_average_rate_stays_within_budget() {
        let budget = 1024 * 1024; // 1MB/s
        let t0 = Instant::now();
        let mut p = Pacer::new(t0);
        let mut now = t0;
        let mut sent = 0usize;
        for _ in 0..500 {
            sent += 64 * 1024;
            if let Some(d) = p.take(64 * 1024, now, budget) {
                now += d; // 펌프가 실제로 자는 만큼 시간이 흐른다
            }
        }
        let secs = now.duration_since(t0).as_secs_f64();
        let allowed = budget as f64 * (secs + PACER_BURST.as_secs_f64());
        assert!(
            sent as f64 <= allowed,
            "평균 {:.0}B/s로 예산 {budget}B/s를 넘겼다 ({sent}B / {secs:.2}s)",
            sent as f64 / secs
        );
    }

    /// 버스트 100ms치까지는 재우지 않는다 — 대화형 출력이 잘게 끊기면 그게 곧 "버벅임"이다.
    /// 그 위(200ms치)는 재워야 평균 속도가 지켜진다.
    #[test]
    fn pacer_lets_a_100ms_burst_through() {
        let budget = 1024 * 1024;
        let t0 = Instant::now();
        assert!(
            Pacer::new(t0).take(budget / 10, t0, budget).is_none(),
            "버스트 여유 안쪽인데 브레이크가 걸렸다"
        );
        let d = Pacer::new(t0)
            .take(budget / 5, t0, budget)
            .expect("버스트 2배인데 브레이크가 안 걸렸다");
        // 갚을 빚은 200ms - 버스트 100ms가 아니라 200ms 전부다(버스트는 문턱일 뿐).
        assert!(
            d >= Duration::from_millis(150) && d <= Duration::from_millis(250),
            "정지 단위가 ~200ms여야 하는데 {d:?}"
        );
    }

    /// 유휴 뒤에 몰아 보내도 크레딧은 **1초치까지만** 쌓인다 — 예전 창 기반 구현은 창이
    /// 지나기만 하면 그 호출을 통째로 통과시켜 유휴 직후 한 방에 예산 몇 배를 내보냈다.
    #[test]
    fn pacer_idle_credit_caps_at_one_second() {
        let budget = 1024 * 1024;
        let t0 = Instant::now();
        let mut p = Pacer::new(t0);
        let after_idle = t0 + Duration::from_secs(30);
        let d = p
            .take(3 * budget, after_idle, budget) // 3초치를 한 번에
            .expect("유휴 뒤 무제한 통과 — 크레딧 상한이 없다");
        assert_eq!(d, Duration::from_secs(1), "크레딧 상한이 1초치가 아니다");
    }

    /// 메모리 경보 예산(1MB/s)에서는 평시라면 그냥 통과할 양에도 브레이크가 걸려야 한다 —
    /// 이게 안 걸리면 압박 중 Channel 큐 적체를 줄이려던 목적이 통째로 사라진다.
    #[test]
    fn pacer_honors_tightened_budget() {
        let t0 = Instant::now();
        // 512KB: 평시 예산(8MB/s)이면 64ms치라 버스트 안쪽 — 통과.
        assert!(Pacer::new(t0)
            .take(512 * 1024, t0, PTY_BYTES_PER_SEC)
            .is_none());
        // 같은 양, Warn 예산(1MB/s)이면 512ms치 — 잡혀야 한다.
        let d = Pacer::new(t0)
            .take(512 * 1024, t0, 1024 * 1024)
            .expect("조인 예산이 무시됐다");
        assert!(d >= Duration::from_millis(450), "{d:?}");
    }

    /// 잔 적이 없으면 줄을 만들지 않는다 — 터미널마다 60초에 한 줄씩 평시 로그를 채우면
    /// 정작 신호가 묻힌다.
    #[test]
    fn throttle_tally_stays_quiet_without_sleeps() {
        let t0 = Instant::now();
        let mut t = ThrottleTally::new(t0);
        t.out_bytes = 10 * 1024 * 1024;
        assert!(
            t.due(t0 + Duration::from_secs(30), "ab12cd34").is_none(),
            "60초 전에 줄이 나왔다"
        );
        assert!(
            t.due(t0 + Duration::from_secs(61), "ab12cd34").is_none(),
            "잔 적 없는데 줄이 나왔다"
        );
    }

    /// 잔 적이 있으면 그 60초치를 한 줄로 내고 창을 리셋한다.
    ///
    /// `mem_lv`·`budget_kb`는 **잔 시점**의 값이어야 한다 — 테스트에서 전역 `memory_level()`은
    /// ok(0)이므로, 줄을 낼 때 그걸 다시 읽는 구현이면 여기서 빨개진다.
    #[test]
    fn throttle_tally_reports_the_level_it_slept_under() {
        let t0 = Instant::now();
        let mut t = ThrottleTally::new(t0);
        for _ in 0..12 {
            t.slept_for(Duration::from_millis(450), 1024 * 1024, Level::Warn);
        }
        t.out_bytes = 61_234 * 1024;
        let line = t
            .due(t0 + Duration::from_secs(61), "ab12cd34")
            .expect("줄이 없다");
        assert!(line.contains("term=ab12cd34"), "{line}");
        assert!(line.contains("span_s=61"), "{line}");
        assert!(line.contains("mem_lv=warn budget_kb=1024"), "{line}");
        assert!(
            line.contains("sleeps=12 slept_ms=5400 out_kb=61234"),
            "{line}"
        );
        // 같은 정지가 다음 창에 또 보고되면 안 된다.
        assert!(
            t.due(t0 + Duration::from_secs(122), "ab12cd34").is_none(),
            "리셋되지 않았다"
        );
    }

    /// 창이 덜 찼어도(세션 종료) 조임 기록은 남아야 한다 — 조여지던 터미널을 60초 안에 닫으면
    /// 예전에는 한 줄도 남지 않았다. 창 길이는 `span_s`로 구분한다.
    #[test]
    fn throttle_tally_line_reports_an_unfinished_window() {
        let t0 = Instant::now();
        let mut t = ThrottleTally::new(t0);
        assert!(
            t.line(t0 + Duration::from_secs(5), "ab12cd34").is_none(),
            "잔 적 없는데 줄이 나왔다"
        );
        t.slept_for(Duration::from_millis(900), 1024 * 1024, Level::Warn);
        // 나중에 더 조여졌다면 그쪽(최악)이 남아야 한다.
        t.slept_for(Duration::from_millis(900), 128 * 1024, Level::Danger);
        let line = t
            .line(t0 + Duration::from_secs(5), "ab12cd34")
            .expect("줄이 없다");
        assert!(line.contains("span_s=5"), "{line}");
        assert!(line.contains("mem_lv=danger budget_kb=128"), "{line}");
        assert!(line.contains("sleeps=2 slept_ms=1800"), "{line}");
    }
}
