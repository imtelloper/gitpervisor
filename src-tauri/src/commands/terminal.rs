use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 열려 있는 PTY 세션. Rust가 수명의 단일 진실 — 프론트 탭/프로젝트 전환과 무관하게 살아있다.
/// 필드는 같은 모듈(term_write/resize/close)에서만 접근한다.
pub struct TerminalSession {
    /// 키 입력을 PTY stdin으로
    writer: Box<dyn Write + Send>,
    /// 리사이즈용 마스터 핸들
    master: Box<dyn MasterPty + Send>,
    /// kill용 자식 프로세스 (리더 스레드와 공유 — EOF 시 wait로 종료코드 수집)
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    #[allow(dead_code)]
    project_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    term_id: String,
    code: i32,
}

struct ShellSpec {
    program: String,
    args: Vec<String>,
}

/// 프로젝트 경로에 PTY 셸을 띄우고 출력 스트림(Channel)을 연결한다 (설계 §16.3).
/// termId는 프론트가 생성해 전달 — 응답이 유실돼도 고아 PTY가 남지 않는다(아는 id로 close).
#[tauri::command]
pub fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    term_id: String,
    project_id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<Vec<u8>>,
) -> Result<(), IpcError> {
    let path = project_path(&state, &project_id)?;
    if !path.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "프로젝트 경로를 찾을 수 없습니다",
        ));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 생성 실패: {e}")))?;

    let shell = resolve_shell(&state);
    let mut cmd = CommandBuilder::new(&shell.program);
    for a in &shell.args {
        cmd.arg(a);
    }
    cmd.cwd(&path);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("셸 실행 실패({}): {e}", shell.program)))?;
    // 슬레이브를 닫아 자식 종료 시 리더가 EOF를 받도록 한다.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 리더 생성 실패: {e}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 라이터 생성 실패: {e}")))?;

    let child = Arc::new(Mutex::new(child));

    // 전용 std 스레드에서 블로킹 read 루프 — tokio 실행기/메인스레드를 막지 않는다(설계 §16.2).
    {
        let app = app.clone();
        let child = Arc::clone(&child);
        let term_id = term_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — 셸 종료
                    Ok(n) => {
                        if on_data.send(buf[..n].to_vec()).is_err() {
                            break; // 프론트 채널 소멸
                        }
                    }
                    Err(_) => break,
                }
            }
            let code = child
                .lock()
                .unwrap()
                .wait()
                .map(|s| s.exit_code() as i32)
                .unwrap_or(-1);
            let _ = app.emit("term://exit", TermExit { term_id, code });
        });
    }

    let session = TerminalSession {
        writer,
        master: pair.master,
        child,
        project_id,
    };
    state.terminals.lock().unwrap().insert(term_id, session);
    Ok(())
}

/// 키 입력을 PTY stdin에 raw로 전달 — 셸 문자열 조립 없음(인젝션 표면 없음).
#[tauri::command]
pub fn term_write(
    state: State<'_, AppState>,
    term_id: String,
    data: String,
) -> Result<(), IpcError> {
    let mut terms = state.terminals.lock().unwrap();
    let session = terms
        .get_mut(&term_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "터미널 세션을 찾을 수 없습니다"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("터미널 입력 실패: {e}")))
}

/// ConPTY 리사이즈 — xterm fit 결과(cols/rows)를 반영.
#[tauri::command]
pub fn term_resize(
    state: State<'_, AppState>,
    term_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), IpcError> {
    let terms = state.terminals.lock().unwrap();
    let session = terms
        .get(&term_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "터미널 세션을 찾을 수 없습니다"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("터미널 리사이즈 실패: {e}")))
}

/// 세션 종료 — child kill 후 레지스트리에서 제거(드롭이 writer·master를 닫는다).
#[tauri::command]
pub fn term_close(state: State<'_, AppState>, term_id: String) -> Result<(), IpcError> {
    if let Some(session) = state.terminals.lock().unwrap().remove(&term_id) {
        let _ = session.child.lock().unwrap().kill();
    }
    Ok(())
}

/// 앱 종료 시 모든 PTY 자식을 정리한다 (좀비 셸 방지, 설계 §16.8).
pub fn kill_all(state: &AppState) {
    let mut terms = state.terminals.lock().unwrap();
    for (_, session) in terms.drain() {
        let _ = session.child.lock().unwrap().kill();
    }
}

fn resolve_shell(state: &AppState) -> ShellSpec {
    let configured = state.settings.read().unwrap().terminal_shell.clone();
    if let Some(program) = configured.filter(|s| !s.trim().is_empty()) {
        return ShellSpec {
            program,
            args: Vec::new(),
        };
    }
    default_shell()
}

#[cfg(windows)]
fn default_shell() -> ShellSpec {
    // pwsh(7+) → powershell(5) → cmd 순. -NoLogo로 배너 억제.
    for program in ["pwsh.exe", "powershell.exe"] {
        if on_path(program) {
            return ShellSpec {
                program: program.to_string(),
                args: vec!["-NoLogo".to_string()],
            };
        }
    }
    ShellSpec {
        program: "cmd.exe".to_string(),
        args: Vec::new(),
    }
}

#[cfg(windows)]
fn on_path(program: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("where")
        .arg(program)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn default_shell() -> ShellSpec {
    let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    ShellSpec {
        program,
        args: Vec::new(),
    }
}
