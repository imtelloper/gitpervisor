// LSP 세션 브리지 (태스크 17 M1) — 언어 서버를 stdio로 스폰하고, 다운스트림은 Channel로
// 순서 보장 스트리밍(term_open 미러), 업스트림 lsp_send는 fire-and-forget(term_write 미러).
// Content-Length 프레이밍은 Rust가 처리 — 프론트는 "완결 JSON-RPC 1건 = Channel 이벤트 1건"만 본다.
//
// JSON-RPC id 상관관계·취소는 전적으로 프론트 어댑터(src/lib/lsp/client.ts). 여기선 바이트만 나른다.

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
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

/// 살아있는 언어 서버 세션. 키는 "{projectId}:{lang}"(state.rs lsp 레지스트리).
pub struct LspSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    /// 서버→프론트 sink. Arc<Mutex>라 웹뷰 리로드 시 새 Channel로 교체 가능(term_attach 미러).
    sink: Arc<Mutex<Channel<String>>>,
    last_activity: Arc<Mutex<Instant>>,
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
    let mut child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("언어 서버 실행 실패: {e}")))?;

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
        thread::spawn(move || reader_loop(stdout, sink, app, key));
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
    };
    state.lsp.lock().unwrap().insert(key.clone(), session);

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
#[tauri::command]
pub fn lsp_send(
    state: State<'_, AppState>,
    session_key: String,
    msg: String,
) -> Result<(), IpcError> {
    let sessions = state.lsp.lock().unwrap();
    let Some(s) = sessions.get(&session_key) else {
        return Ok(());
    };
    *s.last_activity.lock().unwrap() = Instant::now();
    // Content-Length는 바이트 수 — Rust String.len()이 바이트 길이라 그대로.
    let header = format!("Content-Length: {}\r\n\r\n", msg.len());
    let mut stdin = s.stdin.lock().unwrap();
    stdin
        .write_all(header.as_bytes())
        .and_then(|_| stdin.write_all(msg.as_bytes()))
        .and_then(|_| stdin.flush())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("lsp stdin 쓰기 실패: {e}")))?;
    Ok(())
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

/// 세션 종료 — 어댑터가 shutdown/exit를 먼저 보낸 뒤 호출. 레지스트리에서 빼고 kill.
/// lsp://exit 이벤트는 리더 스레드가 EOF 시 단일 발행(중복 방지).
#[tauri::command]
pub fn lsp_stop(state: State<'_, AppState>, session_key: String) -> Result<(), IpcError> {
    let session = state.lsp.lock().unwrap().remove(&session_key);
    if let Some(s) = session {
        let _ = s.child.lock().unwrap().kill();
    }
    Ok(())
}

/// 앱 종료 시 전 세션 정리(lib.rs Destroyed 훅 — kill_all 미러).
pub fn lsp_kill_all(state: &AppState) {
    let mut sessions = state.lsp.lock().unwrap();
    for (_, s) in sessions.drain() {
        let _ = s.child.lock().unwrap().kill();
    }
}

/// 유휴 리퍼 — 10분간 lsp_send가 없던 세션을 종료(§3.4). 앱 setup에서 1회 스폰.
pub fn lsp_spawn_idle_reaper(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(REAPER_INTERVAL);
        let state = app.state::<AppState>();
        let mut stale = Vec::new();
        {
            let sessions = state.lsp.lock().unwrap();
            for (k, s) in sessions.iter() {
                if s.last_activity.lock().unwrap().elapsed() > IDLE_TIMEOUT {
                    stale.push(k.clone());
                }
            }
        }
        for k in stale {
            if let Some(s) = state.lsp.lock().unwrap().remove(&k) {
                let _ = s.child.lock().unwrap().kill(); // 리더 EOF → lsp://exit
            }
        }
    });
}

/// 리더 스레드 본체 — stdout에서 프레임을 뽑아 sink로. 서버 종료(EOF/에러) 시 정리 + lsp://exit.
fn reader_loop(stdout: ChildStdout, sink: Arc<Mutex<Channel<String>>>, app: AppHandle, key: String) {
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
    app.state::<AppState>().lsp.lock().unwrap().remove(&key);
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
