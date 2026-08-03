// LSP 세션 브리지 (태스크 17 M1) — 언어 서버를 stdio로 스폰하고, 다운스트림은 Channel로
// 순서 보장 스트리밍(term_open 미러), 업스트림 lsp_send는 fire-and-forget(term_write 미러).
// Content-Length 프레이밍은 Rust가 처리 — 프론트는 "완결 JSON-RPC 1건 = Channel 이벤트 1건"만 본다.
//
// JSON-RPC id 상관관계·취소는 전적으로 프론트 어댑터(src/lib/lsp/client.ts). 여기선 바이트만 나른다.

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::lsp::acquire;
use crate::state::AppState;

const IDLE_TIMEOUT: Duration = Duration::from_secs(600); // 10분(§3.4)
const REAPER_INTERVAL: Duration = Duration::from_secs(60);
/// 강제 종료 전 `shutdown`→`exit`에 주는 유예. LSP 스펙상 서버는 exit 알림을 받으면 스스로
/// 나가야 하지만 jdtls(JVM)처럼 느린 서버가 있어 무한 대기는 금물 — 이 안에 안 나가면 그룹째 SIGKILL.
const GRACEFUL_TIMEOUT: Duration = Duration::from_millis(400);
/// 동시 유지 세션 상한. 언어 서버 1개가 수백 MB(tsserver·jdtls)를 상주시키므로 프로젝트·언어를
/// 옮겨 다니면 무한정 쌓인다 — 앱 cgroup이 oomd 사정권에 들어가는 경로다(2026-08-01 사건).
/// 넘치면 가장 오래 안 쓴 세션부터 정리(LRU). 재오픈 시 콜드 스타트 비용은 감수한다.
const MAX_SESSIONS: usize = 4;

/// 살아있는 언어 서버 세션. 키는 "{projectId}:{lang}"(state.rs lsp 레지스트리).
pub struct LspSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    /// 서버→프론트 sink. Arc<Mutex>라 웹뷰 리로드 시 새 Channel로 교체 가능(term_attach 미러).
    sink: Arc<Mutex<Channel<String>>>,
    last_activity: Arc<Mutex<Instant>>,
    /// 서버 프로세스 pid. unix에선 spawn 시 `process_group(0)`으로 새 그룹을 만들었기에
    /// **그룹 id와 값이 같다** — 종료 시 killpg로 손자(tsserver·JVM 워커)까지 거둔다.
    pid: u32,
    /// 종료 절차가 이미 돌았는가. 명시 종료 뒤 Drop이 또 죽이지 않게 하는 재진입 래치.
    terminated: AtomicBool,
}

impl LspSession {
    /// 종료의 단일 진입점. `graceful`이면 LSP 스펙대로 shutdown→exit를 먼저 보내고 유예를 준다.
    /// 어느 경로로 오든 **반드시 `wait()`로 좀비를 회수**한다(사후조치 P1 — kill 후 wait 누락).
    fn terminate(&self, graceful: bool) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return; // 이미 거둠 — Drop 안전망과 중복 방지
        }
        terminate_child(&self.child, self.pid, graceful.then(|| self.stdin.clone()));
    }
}

impl Drop for LspSession {
    /// 안전망 — 레지스트리에서 조용히 빠지거나(insert 교체·reader EOF) 에러 경로로 버려지는
    /// 세션도 자식을 남기지 않게 한다. 여기선 유예 없이 즉시 거둔다(호출자가 기다리는 자리일 수
    /// 있으므로). 명시 terminate가 먼저 돌았으면 래치 덕에 no-op.
    fn drop(&mut self) {
        self.terminate(false);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerInfo {
    pub binary: String,
    pub version: Option<String>,
    pub session_key: String,
    /// 레포 절대경로 — 프론트가 rootUri·문서 file URI를 만드는 데 쓴다(Windows 경로 조합 일원화).
    pub root_path: String,
    /// 탐지된 파이썬 인터프리터 절대경로(py 세션) — 프론트가 workspace/configuration의 python
    /// 섹션에 pythonPath로 응답해 basedpyright가 그 venv/site-packages로 import를 해석하게 한다.
    pub python_path: Option<String>,
    /// tsserver.js 절대경로(ts 세션) — 프론트가 initializationOptions.tsserver.path로 넘긴다.
    pub tsserver_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    session_key: String,
    code: Option<i32>,
}

/// 서버 스폰 + stdio 연결. initialize 핸드셰이크는 프론트가 수행한다(여기선 프로세스만).
/// 이미 세션이 있으면 멱등 — 기존 sink를 새 Channel로 교체(리로드 대응).
#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    lang: String,
    on_msg: Channel<String>,
) -> Result<LspServerInfo, IpcError> {
    let key = format!("{project_id}:{lang}");

    // 멱등 재부착 — 이미 떠 있으면 sink만 교체.
    {
        let sessions = state.lsp.lock().unwrap();
        if let Some(s) = sessions.get(&key) {
            *s.sink.lock().unwrap() = on_msg;
            *s.last_activity.lock().unwrap() = Instant::now();
            let repo = project_path(&state, &project_id).ok();
            return Ok(LspServerInfo {
                binary: "(running)".to_string(),
                version: None,
                session_key: key,
                python_path: repo
                    .as_deref()
                    .filter(|_| lang == "py")
                    .and_then(acquire::detect_python),
                tsserver_path: None, // 재부착 — 서버가 이미 tsserver를 물고 있음
                root_path: repo.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            });
        }
    }

    let repo = project_path(&state, &project_id)?;
    let workspace_tsserver = state.settings.read().unwrap().lsp_workspace_tsserver;
    let resolved = acquire::resolve(&app, &lang, &repo, workspace_tsserver)?;
    let python_path = if lang == "py" {
        acquire::detect_python(&repo)
    } else {
        None
    };
    let tsserver_path = resolved.tsserver.clone();

    let mut cmd = Command::new(&resolved.program);
    cmd.args(&resolved.args)
        .current_dir(&repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        // 서버를 새 프로세스 그룹의 리더로 띄운다. 언어 서버는 자기 자식을 두는 경우가 흔한데
        // (typescript-language-server→tsserver, jdtls→JVM 워커) 직계 pid만 죽이면 그놈들이
        // 고아로 살아남아 앱 cgroup에 영구 잔류한다 — git/runner.rs가 같은 이유로 쓰는 방침이다.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("언어 서버 실행 실패: {e}")))?;
    let pid = child.id(); // process_group(0)이라 이 값이 곧 그룹 id다(unix).

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "stdin 연결 실패".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| IpcError::new(ErrorCode::Io, "stdout 연결 실패".to_string()))?;
    let stderr = child.stderr.take();

    let sink = Arc::new(Mutex::new(on_msg));

    // 리더 스레드 — Content-Length 프레이밍 해제 후 완결 메시지를 sink로. EOF 시 정리+exit.
    {
        let sink = sink.clone();
        let app = app.clone();
        let key = key.clone();
        thread::spawn(move || reader_loop(stdout, sink, app, key, pid));
    }
    // stderr 소비(안 읽으면 파이프 버퍼가 차 서버가 멈춘다). 로그로만.
    if let Some(mut se) = stderr {
        thread::spawn(move || {
            let mut b = [0u8; 4096];
            while let Ok(n) = se.read(&mut b) {
                if n == 0 {
                    break;
                }
            }
        });
    }

    let session = LspSession {
        stdin: Arc::new(Mutex::new(stdin)),
        child: Arc::new(Mutex::new(child)),
        sink,
        last_activity: Arc::new(Mutex::new(Instant::now())),
        pid,
        terminated: AtomicBool::new(false),
    };
    // 등록 + 상한 초과분 축출(LRU). 축출 대상은 락 밖에서 종료한다 — 종료 절차는 유예 때문에
    // 최대 GRACEFUL_TIMEOUT이 걸리므로 전역 레지스트리를 쥔 채 돌리면 다른 세션까지 멈춘다.
    let evicted: Vec<LspSession> = {
        let mut sessions = state.lsp.lock().unwrap();
        // 같은 키에 이미 세션이 있었다면(재부착 검사와 spawn 사이의 레이스) 그 놈도 정리 대상이다.
        // 락 안에서 그냥 떨구면 Drop(kill+wait)이 전역 락 아래서 도니 밖으로 들고 나간다.
        let mut out: Vec<LspSession> = sessions.insert(key.clone(), session).into_iter().collect();
        let snapshot: Vec<(String, Instant)> = sessions
            .iter()
            .map(|(k, s)| (k.clone(), *s.last_activity.lock().unwrap()))
            .collect();
        out.extend(
            lru_victims(&snapshot, &key, MAX_SESSIONS)
                .into_iter()
                .filter_map(|k| sessions.remove(&k)),
        );
        out
    };
    for s in evicted {
        spawn_terminate(s); // 리더 EOF → lsp://exit → 프론트가 휴리스틱으로 폴백
    }

    Ok(LspServerInfo {
        binary: resolved.label,
        version: resolved.version,
        session_key: key,
        root_path: repo.to_string_lossy().into_owned(),
        python_path,
        tsserver_path,
    })
}

/// 완결 JSON-RPC 문자열을 Content-Length 프레이밍해 stdin에 쓴다. payload 없는 ack —
/// 프론트는 재시도 금지(중복 id 오염). 세션이 없으면 조용히 무시(폴백 중 — 다음 상호작용이 재기동).
///
/// `user_initiated`(기본 true)는 유휴 리퍼용 표식이다. 생략하면 기존 동작과 같다.
#[tauri::command]
pub fn lsp_send(
    state: State<'_, AppState>,
    session_key: String,
    msg: String,
    user_initiated: Option<bool>,
) -> Result<(), IpcError> {
    // 전역 레지스트리 락은 **핸들을 꺼내는 동안만** 쥔다. 예전에는 write_all까지 이 락 아래에서
    // 했는데, 서버가 stdin을 안 읽고 멈추면(파이프 버퍼 포화) 이 커맨드가 락을 쥔 채 영원히
    // 막혀 lsp_stop·유휴 리퍼·앱 종료의 lsp_kill_all까지 전부 물린다 — 시그널을 받아도 자식을
    // 못 거두고 안 죽는 앱이 된다(이번 사건이 딱 그 모양이었다).
    let (stdin, last_activity) = {
        let sessions = state.lsp.lock().unwrap();
        let Some(s) = sessions.get(&session_key) else {
            return Ok(()); // 폴백 중 — 다음 상호작용이 재기동
        };
        (s.stdin.clone(), s.last_activity.clone())
    };
    // 유휴 판정은 **사용자 기점 트래픽으로만** 갱신한다. 서버가 먼저 건 요청에 대한 응답
    // (workspace/configuration·client/registerCapability·workDoneProgress/create …)과 우리
    // 타임아웃이 쏘는 $/cancelRequest까지 activity로 세면, 서버가 주기적으로 말을 거는 것만으로
    // 10분 리퍼가 영원히 발동하지 않아 유휴 서버가 무한 상주한다(사후조치 P1).
    if user_initiated.unwrap_or(true) {
        *last_activity.lock().unwrap() = Instant::now();
    }
    let mut stdin = stdin.lock().unwrap();
    write_frame(&mut *stdin, &msg)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("lsp stdin 쓰기 실패: {e}")))?;
    Ok(())
}

/// Content-Length 프레임 1건을 쓴다 — LSP 프레이밍의 단일 지점(lsp_send·종료 절차 공용).
fn write_frame(w: &mut impl Write, msg: &str) -> std::io::Result<()> {
    // Content-Length는 바이트 수 — Rust String.len()이 바이트 길이라 그대로.
    w.write_all(format!("Content-Length: {}\r\n\r\n", msg.len()).as_bytes())?;
    w.write_all(msg.as_bytes())?;
    w.flush()
}

/// 언어 서버 획득 — 필요한 tarball을 앱 내에서 다운로드+검증+설치(태스크 17 M2). 진행률은 Channel.
/// 설정에서 명시 다운로드 버튼이 호출(클릭이 곧 동의). 이미 설치돼 있으면 즉시 ready.
#[tauri::command]
pub async fn lsp_ensure(
    app: AppHandle,
    lang: String,
    on_progress: Channel<String>,
) -> Result<acquire::EnsureResult, IpcError> {
    acquire::ensure_installed(&app, &lang, &on_progress).await
}

/// 세션 종료 — 프론트 어댑터가 파일을 다 닫았거나 명시 정리 시 호출. 레지스트리에서 빼고
/// shutdown→exit 유예 후 그룹째 정리. lsp://exit 이벤트는 리더 스레드가 EOF 시 단일 발행.
#[tauri::command]
pub fn lsp_stop(state: State<'_, AppState>, session_key: String) -> Result<(), IpcError> {
    // 맵에서 먼저 꺼내고 락을 놓는다(뒤의 spawn_terminate가 락 없이 돈다).
    let session = state.lsp.lock().unwrap().remove(&session_key);
    if let Some(s) = session {
        spawn_terminate(s);
    }
    Ok(())
}

/// 앱 종료 시 전 세션 정리(lib.rs Destroyed 훅 / health 시그널 핸들러 — terminal kill_all 미러).
/// **시그니처 고정** — lib.rs·health/mod.rs가 이 형태로 부른다.
pub fn lsp_kill_all(state: &AppState) {
    let sessions: Vec<LspSession> = {
        let mut map = state.lsp.lock().unwrap();
        map.drain().map(|(_, s)| s).collect()
    };
    // 여기서는 정리 완료를 보장해야 한다(앱이 곧 사라지므로 스레드를 던져만 두면 유예 중에
    // 프로세스가 죽어 서버가 고아로 남는다). 순차로 돌리면 세션 N개 × 유예만큼 종료가 늦어지니
    // 병렬로 던지고 한 번만 기다린다(terminal.rs kill_all과 같은 구조 — 최대 GRACEFUL_TIMEOUT).
    let handles: Vec<_> = sessions
        .into_iter()
        .map(|s| thread::spawn(move || s.terminate(true)))
        .collect();
    for h in handles {
        let _ = h.join();
    }
}

/// 유휴 리퍼 — 10분간 사용자 기점 트래픽이 없던 세션을 종료(§3.4). 앱 setup에서 1회 스폰.
pub fn lsp_spawn_idle_reaper(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(REAPER_INTERVAL);
        let state = app.state::<AppState>();
        let stale: Vec<String> = {
            let sessions = state.lsp.lock().unwrap();
            sessions
                .iter()
                .filter(|(_, s)| s.last_activity.lock().unwrap().elapsed() > IDLE_TIMEOUT)
                .map(|(k, _)| k.clone())
                .collect()
        };
        for k in stale {
            // 맵에서 꺼낸 뒤 **락 밖에서** 종료 — 유예를 전역 락 아래서 돌리면 그동안 모든
            // 세션의 lsp_send가 멈춘다(타자 중 입력 지연).
            let session = state.lsp.lock().unwrap().remove(&k);
            if let Some(s) = session {
                spawn_terminate(s); // 리더 EOF → lsp://exit
            }
        }
    });
}

/// 종료를 별도 스레드로 넘긴다.
///
/// `lsp_stop`은 동기 `#[tauri::command]`라 GTK 메인 이벤트 루프에서 실행되는데, 종료 절차는
/// shutdown 유예 때문에 최대 GRACEFUL_TIMEOUT이 걸린다. 여기서 기다리면 그동안 앱 전체가
/// 얼어붙는다(terminal.rs spawn_terminate와 같은 이유). 맵에서 이미 제거했으므로 재기동과의
/// 레이스는 이 시점에 해소돼 있다.
fn spawn_terminate(session: LspSession) {
    thread::spawn(move || session.terminate(true));
}

/// 자식 종료 본체 — 세션 구조체와 분리해 테스트에서 직접 부를 수 있게 뒀다.
/// `graceful_stdin`이 Some이면 shutdown→exit를 먼저 보내고 GRACEFUL_TIMEOUT만큼 기다린다.
fn terminate_child(child: &Mutex<Child>, pid: u32, graceful_stdin: Option<Arc<Mutex<ChildStdin>>>) {
    let mut exited = false;
    if let Some(stdin) = graceful_stdin {
        // 쓰기는 **별도 스레드**에서 한다 — 서버가 stdin을 안 읽으면 파이프 버퍼가 차 write_all이
        // 무한정 막히는데, 종료 절차 본체가 거기 물리면 강제 종료조차 못 하게 된다. 아래에서
        // SIGKILL이 나가면 이 스레드는 EPIPE로 스스로 풀린다.
        thread::spawn(move || {
            if let Ok(mut w) = stdin.lock() {
                // id는 프론트 시퀀스(1부터 증가)와 절대 안 겹치게 i32 최대값으로.
                let _ = write_frame(
                    &mut *w,
                    r#"{"jsonrpc":"2.0","id":2147483647,"method":"shutdown"}"#,
                );
                let _ = write_frame(&mut *w, r#"{"jsonrpc":"2.0","method":"exit"}"#);
            }
        });
        let deadline = Instant::now() + GRACEFUL_TIMEOUT;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
            if matches!(lock_child(child).try_wait(), Ok(Some(_))) {
                exited = true; // 스스로 나갔고 try_wait이 이미 거뒀다 — 좀비 없음
                break;
            }
        }
    }
    if exited {
        // 스펙대로 exit에 응해 나간 서버는 자기 자식(tsserver 등)을 스스로 정리한다. 게다가 이미
        // reap한 pid를 그룹 id로 써서 killpg를 쏘는 것은 위험하므로 여기서는 더 손대지 않는다.
        return;
    }
    // 강제 — 손자까지 그룹째. **반드시 wait 전에** 보낸다(거둔 뒤엔 pid가 재사용될 수 있다).
    kill_group(pid);
    let mut c = lock_child(child);
    let _ = c.kill();
    let _ = c.wait(); // 좀비 회수 — SIGKILL 뒤라 즉시 반환한다(사후조치 P1의 핵심)
}

/// 자식 뮤텍스를 **poison까지 복구해서** 잡는다. 여기서 락을 포기하면 wait()를 못 해 좀비가
/// 그대로 남는다 — 정리 경로에서는 오염된 상태라도 거두는 편이 낫다.
fn lock_child(child: &Mutex<Child>) -> std::sync::MutexGuard<'_, Child> {
    child.lock().unwrap_or_else(|e| e.into_inner())
}

/// 언어 서버가 만든 **손자까지** 그룹째 정리한다.
///
/// typescript-language-server는 tsserver를, jdtls는 JVM 워커를 자식으로 둔다. 직계 pid만
/// SIGKILL하면 그놈들이 살아남아 PID 1로 재부모화돼도 **cgroup 소속은 그대로**라 앱 scope에
/// 영구 잔류한다 — 2026-08-01 systemd-oomd 강제 종료와 같은 구조다. spawn 시
/// `process_group(0)`으로 새 그룹을 만들어 뒀기에 그룹 id == 자식 pid다.
/// (git/runner.rs의 동명 헬퍼와 같은 패턴이지만 그 파일은 다른 영역이라 여기 별도로 둔다.)
#[allow(unused_variables)]
fn kill_group(pid: u32) {
    #[cfg(unix)]
    if pid > 1 {
        // 그룹 id == 리더 pid. 리더가 이미 죽었어도 멤버가 남아 있으면 유효하다.
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    // Windows는 프로세스 그룹 의미가 달라(손자 회수는 Job Object가 필요) 직계만 종료한다.
}

/// 상한 초과 시 내보낼 세션 키 — `last_activity`가 오래된 순. `keep`(방금 만든 세션)은 제외한다.
/// 순수 함수라 테스트 가능(스폰 없이 정책만 검증).
fn lru_victims(entries: &[(String, Instant)], keep: &str, max: usize) -> Vec<String> {
    if entries.len() <= max {
        return Vec::new();
    }
    let excess = entries.len() - max;
    let mut rest: Vec<&(String, Instant)> = entries.iter().filter(|(k, _)| k != keep).collect();
    rest.sort_by_key(|(_, t)| *t);
    rest.into_iter().take(excess).map(|(k, _)| k.clone()).collect()
}

/// 리더 스레드 본체 — stdout에서 프레임을 뽑아 sink로. 서버 종료(EOF/에러) 시 정리 + lsp://exit.
fn reader_loop(
    stdout: ChildStdout,
    sink: Arc<Mutex<Channel<String>>>,
    app: AppHandle,
    key: String,
    pid: u32,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        match reader.read(&mut tmp) {
            Ok(0) | Err(_) => break, // EOF 또는 파이프 에러 → 종료
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
        while let Some(msg) = extract_frame(&mut buf) {
            if sink.lock().unwrap().send(msg).is_err() {
                // 수신 측(웹뷰)이 사라짐 — 세션은 유지(재부착 대비)하되 이 메시지는 버린다.
            }
        }
    }
    // 서버 사망 — 레지스트리 정리 + 프론트에 폴백 신호.
    //
    // **키만 보고 지우면 안 된다.** 같은 키로 세션이 이미 교체됐다면(서버가 죽어 재기동된 흔한
    // 경우) 이 리더는 자기 것이 아닌 **새 세션을 지우고** 살아 있는 서버에 대해 lsp://exit를
    // 쏜다 — 프론트가 멀쩡한 세션을 죽은 것으로 처리한다. pid를 대조해 자기 세션일 때만 회수한다
    // (terminal.rs의 리더 스레드가 쓰는 것과 같은 방식).
    //
    // 꺼낸 세션은 **락 밖에서** 떨군다. Drop이 kill+wait을 돌리는데(좀비 회수) 그걸 전역
    // 레지스트리 락 아래에서 하면 다른 세션의 lsp_send까지 그동안 멈춘다.
    let state = app.state::<AppState>();
    let session = {
        let mut map = state.lsp.lock().unwrap();
        match map.get(&key) {
            Some(cur) if cur.pid == pid => map.remove(&key),
            // 내 것이 아니다(이미 교체됨) — 아무것도 건드리지 않고 조용히 물러난다.
            _ => return,
        }
    };
    // 명시 종료(교체·리퍼·앱 종료)로 죽은 것이면 프론트에 알리지 않는다 — 지연된 exit가
    // 새 세션을 "죽음"으로 오염시키는 레이스를 막는다.
    let intentional = session
        .as_ref()
        .is_some_and(|s| s.terminated.load(Ordering::SeqCst));
    drop(session);
    if intentional {
        return;
    }
    let _ = app.emit(
        "lsp://exit",
        ExitPayload {
            session_key: key,
            code: None,
        },
    );
}

/// buf 앞부분에서 완결된 Content-Length 프레임 1건을 떼어내 본문 문자열로 반환.
/// 아직 헤더/본문이 덜 왔으면 None(다음 read를 기다린다). 소비한 바이트는 buf에서 제거.
fn extract_frame(buf: &mut Vec<u8>) -> Option<String> {
    // 헤더 끝(\r\n\r\n) 탐색
    let sep = b"\r\n\r\n";
    let header_end = buf.windows(4).position(|w| w == sep)?;
    let header = String::from_utf8_lossy(&buf[..header_end]);
    let len: usize = header
        .lines()
        .find_map(|l| {
            let l = l.trim();
            let lower = l.to_ascii_lowercase();
            lower
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse().ok())
        })?;
    let body_start = header_end + 4;
    if buf.len() < body_start + len {
        return None; // 본문 미완 — 더 읽어야 함
    }
    let body = String::from_utf8_lossy(&buf[body_start..body_start + len]).into_owned();
    buf.drain(..body_start + len);
    Some(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_matches_extract() {
        let mut out: Vec<u8> = Vec::new();
        write_frame(&mut out, r#"{"a":1}"#).unwrap();
        assert_eq!(out, b"Content-Length: 7\r\n\r\n{\"a\":1}".to_vec());
        let mut buf = out;
        assert_eq!(extract_frame(&mut buf).as_deref(), Some(r#"{"a":1}"#));
        assert!(buf.is_empty(), "프레임을 소비하고 나면 버퍼가 비어야 한다");
    }

    /// Content-Length는 **문자 수가 아니라 바이트 수**다 — 한글 본문에서 어긋나면 뒤 프레임이
    /// 통째로 밀려 세션이 영구히 깨진다(종료 요청조차 못 나간다).
    #[test]
    fn frame_length_counts_bytes_not_chars() {
        let mut out: Vec<u8> = Vec::new();
        write_frame(&mut out, "\"한글\"").unwrap();
        let mut buf = out;
        assert_eq!(extract_frame(&mut buf).as_deref(), Some("\"한글\""));
    }

    #[test]
    fn lru_victims_evicts_oldest_and_never_the_new_one() {
        let t0 = Instant::now();
        let e = |k: &str, ms: u64| (k.to_string(), t0 + Duration::from_millis(ms));

        // 5개(상한 4) — 가장 오래된 "a" 하나만 나간다.
        let entries = vec![e("a", 0), e("b", 10), e("c", 20), e("d", 30), e("new", 40)];
        assert_eq!(lru_victims(&entries, "new", 4), vec!["a".to_string()]);

        // 상한 이하면 아무도 안 나간다.
        assert!(lru_victims(&entries[..4], "new", 4).is_empty());

        // 방금 만든 세션은 last_activity가 가장 오래됐어도 절대 축출 대상이 아니다
        // (그랬다간 lsp_start가 스스로 죽인 서버를 프론트에 돌려준다).
        let entries = vec![e("new", 0), e("b", 10), e("c", 20), e("d", 30), e("e", 40)];
        assert_eq!(lru_victims(&entries, "new", 4), vec!["b".to_string()]);
    }
}

/// 실제 프로세스로 검증하는 종료 테스트. `/proc` 기반이라 리눅스에서만 돈다
/// (terminal.rs terminate_tests와 같은 방침 — 사건이 난 플랫폼이 리눅스다).
#[cfg(all(test, target_os = "linux"))]
mod terminate_tests {
    use super::*;

    /// 살아있는가. **좀비(Z)는 죽은 것으로 본다** — 이미 종료했고 부모의 wait만 남은 상태다.
    fn alive(pid: i32) -> bool {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        // `pid (comm) state ...` — comm에 공백·괄호가 들어갈 수 있어 마지막 ')' 뒤부터 읽는다.
        stat.rfind(')')
            .and_then(|cut| stat[cut + 1..].split_whitespace().next())
            .and_then(|f| f.chars().next())
            .is_some_and(|st| st != 'Z')
    }

    fn wait_gone(pid: i32, ms: u64) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(ms) {
            if !alive(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        !alive(pid)
    }

    /// wait()로 거뒀으면 `/proc` 엔트리 자체가 사라진다(좀비는 엔트리가 남는다).
    fn reaped(pid: u32) -> bool {
        !std::path::Path::new(&format!("/proc/{pid}")).exists()
    }

    /// lsp_start와 같은 조건으로 가짜 서버를 띄운다(자기 프로세스 그룹의 리더).
    fn spawn_server(script: &str) -> Child {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        cmd.process_group(0);
        cmd.spawn().expect("sh 실행 실패")
    }

    /// 손자(tsserver·JVM 워커에 해당)까지 죽고, 자식은 좀비로 남지 않아야 한다.
    /// 예전 코드는 `child.kill()` 한 줄뿐이라 둘 다 실패했다.
    #[test]
    fn terminate_kills_grandchild_and_reaps_child() {
        let mut child = spawn_server("sleep 60 & echo $!; sleep 60");
        let pid = child.id();
        let mut out = child.stdout.take().expect("stdout");
        let mut buf = [0u8; 32];
        let n = out.read(&mut buf).expect("손자 pid 읽기 실패");
        let grand: i32 = String::from_utf8_lossy(&buf[..n])
            .trim()
            .parse()
            .expect("손자 pid 파싱 실패");
        assert!(alive(grand), "테스트 전제 실패: 손자가 안 생겼다");

        let m = Mutex::new(child);
        terminate_child(&m, pid, None); // Drop 안전망과 같은 경로(유예 없음)

        assert!(wait_gone(grand, 2000), "손자가 살아남았다 (pid={grand}) — killpg 누락");
        assert!(reaped(pid), "자식이 좀비로 남았다 (pid={pid}) — kill 후 wait 누락");
    }

    /// shutdown→exit를 받으면 서버가 스스로 나가고, 유예를 다 쓰지 않는다.
    /// (첫 줄만 읽고 종료하는 가짜 서버 — shutdown 프레임의 헤더 한 줄이면 나간다.)
    #[test]
    fn graceful_shutdown_lets_server_exit_itself() {
        let mut child = spawn_server("read line; exit 0");
        let pid = child.id();
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("stdin")));
        let m = Mutex::new(child);

        let t0 = Instant::now();
        terminate_child(&m, pid, Some(stdin));

        assert!(
            t0.elapsed() < GRACEFUL_TIMEOUT,
            "유예를 다 쓰기 전에 스스로 나가야 한다 ({:?})",
            t0.elapsed()
        );
        assert!(reaped(pid), "자식이 좀비로 남았다 (pid={pid})");
    }

    /// 유예 안에 안 나가는 서버(jdtls 같은 JVM)는 강제 종료된다 — 무한 대기 금지.
    #[test]
    fn graceful_timeout_falls_back_to_force_kill() {
        let mut child = spawn_server("sleep 60");
        let pid = child.id();
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("stdin")));
        let m = Mutex::new(child);

        let t0 = Instant::now();
        terminate_child(&m, pid, Some(stdin));

        assert!(
            t0.elapsed() < GRACEFUL_TIMEOUT + Duration::from_secs(2),
            "유예를 넘기면 즉시 강제 종료해야 한다 ({:?})",
            t0.elapsed()
        );
        assert!(reaped(pid), "자식이 좀비로 남았다 (pid={pid})");
    }
}
