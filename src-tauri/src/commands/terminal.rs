use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// 의도적 종료(term_close/replace/kill_all) 표시 — true면 리더가 term://exit를 억제한다.
    /// 재시작 시 옛 PTY를 kill하면 그 리더가 지연된 exit를 쏘아 새 PTY를 "exited"로 잘못
    /// 표시하는 레이스를 막는다.
    closed: Arc<AtomicBool>,
    /// 출력 sink — 현재 이 PTY를 그리는 웹뷰의 Channel. term_attach가 이 sink를 다른 창의
    /// Channel로 교체해 살아있는 세션을 별도 OS 창(플로팅)으로 옮긴다.
    sink: Arc<Mutex<Channel<Vec<u8>>>>,
    /// 이 PTY가 속한 프로젝트 — 플로팅 창이 이 값으로 새 분할 패널의 cwd를 잡는다.
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
    // 터미널 에뮬레이터는 PTY 셸의 TERM 을 직접 지정해야 한다(모든 터미널이 그렇게 한다).
    // 지정하지 않으면 앱을 GNOME 메뉴/systemd 로 띄울 때 그 환경에 TERM 이 없어
    // (터미널에서 띄울 때만 TERM=xterm-256color 를 물려받음) 셸이 빈 TERM 으로 떠서,
    // zsh-syntax-highlighting·zsh-autosuggestions 가 terminfo 능력을 잘못 판정해
    // 어긋난 커서 이동·clear escape 를 보내 입력줄이 깨진다(고스트 잔상·한글 커서 드리프트).
    // → 같은 바이너리도 "dev/터미널 실행은 정상, 메뉴 설치본은 깨짐"의 진짜 원인.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

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
    let closed = Arc::new(AtomicBool::new(false));
    // 출력 sink를 Arc<Mutex>로 — 플로팅 분리 시 term_attach가 이 sink를 새 창 Channel로 바꾼다.
    let sink = Arc::new(Mutex::new(on_data));

    // 전용 std 스레드에서 블로킹 read 루프 — tokio 실행기/메인스레드를 막지 않는다(설계 §16.2).
    {
        let app = app.clone();
        let child = Arc::clone(&child);
        let closed = Arc::clone(&closed);
        let sink = Arc::clone(&sink);
        let term_id = term_id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — 셸 종료
                    Ok(n) => {
                        // 현재 sink로 전송. 창이 닫혀 send가 실패해도 PTY는 살린다 —
                        // 플로팅 분리 중(detach↔attach 사이)의 짧은 공백을 위해 루프를 끊지 않는다.
                        // 의도적 종료는 term_close가 child를 kill해 EOF로 루프를 끝낸다.
                        let _ = sink.lock().unwrap().send(buf[..n].to_vec());
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
            // 의도적으로 닫힌(재시작/교체/앱종료) 세션은 exit 이벤트를 쏘지 않는다 — 레이스 방지.
            if !closed.load(Ordering::Relaxed) {
                let _ = app.emit("term://exit", TermExit { term_id, code });
            }
        });
    }

    let session = TerminalSession {
        writer,
        master: pair.master,
        child,
        closed,
        sink,
        project_id,
    };
    // 같은 id의 옛 세션이 남아있으면(비정상 경로) 먼저 억제+kill 후 교체한다.
    let old = state.terminals.lock().unwrap().insert(term_id.clone(), session);
    if let Some(old) = old {
        old.closed.store(true, Ordering::Relaxed);
        let _ = old.child.lock().unwrap().kill();
    }
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

/// 살아있는 PTY의 출력 sink를 새 웹뷰 Channel로 교체 — 별도 OS 창(플로팅)이 기존 세션에 재연결.
/// PTY/프로세스는 그대로 유지되고 출력만 새 창으로 흐른다(스크롤백은 옮겨지지 않음).
#[tauri::command]
pub fn term_attach(
    state: State<'_, AppState>,
    term_id: String,
    on_data: Channel<Vec<u8>>,
) -> Result<(), IpcError> {
    let terms = state.terminals.lock().unwrap();
    let session = terms
        .get(&term_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, "터미널 세션을 찾을 수 없습니다"))?;
    *session.sink.lock().unwrap() = on_data;
    Ok(())
}

/// 살아있는 PTY의 프로젝트 id를 돌려준다 — 플로팅 창이 새 분할 패널을 같은 프로젝트로 열 때 사용.
#[tauri::command]
pub fn term_project(state: State<'_, AppState>, term_id: String) -> Option<String> {
    state
        .terminals
        .lock()
        .unwrap()
        .get(&term_id)
        .map(|s| s.project_id.clone())
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
    close_session(state.inner(), &term_id);
    Ok(())
}

/// 단일 세션 종료(child kill + 제거). 커맨드/창 이벤트(플로팅 창 닫힘) 공용.
pub fn close_session(state: &AppState, term_id: &str) {
    if let Some(session) = state.terminals.lock().unwrap().remove(term_id) {
        // 의도적 종료 표시 → 리더가 지연된 term://exit를 쏘지 않는다(재시작 레이스 방지).
        session.closed.store(true, Ordering::Relaxed);
        let _ = session.child.lock().unwrap().kill();
    }
}

/// 앱 종료 시 모든 PTY 자식을 정리한다 (좀비 셸 방지, 설계 §16.8).
pub fn kill_all(state: &AppState) {
    let mut terms = state.terminals.lock().unwrap();
    for (_, session) in terms.drain() {
        session.closed.store(true, Ordering::Relaxed);
        let _ = session.child.lock().unwrap().kill();
    }
}

/// 터미널 붙여넣기용 클립보드 판별:
/// 1) 파일 목록(탐색기/폴더에서 복사) → 인용된 경로(여러 개면 공백 구분)
/// 2) 이미지 데이터(스크린샷 등) → 임시 파일로 저장 후 그 경로
/// 3) 일반 텍스트 → 그대로
#[cfg(windows)]
#[tauri::command]
pub fn term_paste() -> String {
    use clipboard_win::{formats, get_clipboard};

    let files: Vec<String> = get_clipboard(formats::FileList).unwrap_or_default();
    if !files.is_empty() {
        return files
            .iter()
            .map(|p| shell_quote(p))
            .collect::<Vec<_>>()
            .join(" ");
    }

    let bmp: Vec<u8> = get_clipboard(formats::Bitmap).unwrap_or_default();
    if bmp.len() > 64 {
        if let Some(path) = save_temp_image(&bmp) {
            return shell_quote(&path);
        }
    }

    get_clipboard(formats::Unicode).unwrap_or_default()
}

/// Linux(X11/XWayland)·macOS: arboard로 이미지→임시 PNG 경로, 그 외 텍스트.
/// (파일 목록(text/uri-list)은 arboard 미지원 — 파일 매니저 복사는 대부분 텍스트 폴백으로 경로가 온다.)
///
/// 반드시 async 커맨드로 메인 스레드 밖에서 실행한다: 동기 커맨드는 GTK 메인루프에서 돌고,
/// X11 클립보드는 "소유자가 요청에 응답"하는 모델이라 웹뷰(이 앱 자신)가 복사 주체일 때
/// 메인루프가 막혀 있으면 자기 자신을 기다리는 데드락이 된다(tauri plugins-workspace#2267과 동일 기전).
/// 여기에 더해 소유자가 끝내 응답하지 않는 경우를 대비해 워커 스레드 + 2초 타임아웃으로 감싼다
/// — 실패 시 빈 문자열(붙여넣기 no-op)로 강등되며 UI는 절대 매달리지 않는다.
#[cfg(not(windows))]
#[tauri::command(async)]
pub fn term_paste() -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(read_clipboard_unix());
    });
    rx.recv_timeout(std::time::Duration::from_millis(2000))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn read_clipboard_unix() -> String {
    let mut cb = match arboard::Clipboard::new() {
        Ok(cb) => cb,
        Err(_) => return String::new(),
    };
    // Windows 구현과 같은 우선순위: 이미지(스크린샷) 먼저, 아니면 텍스트.
    if let Ok(img) = cb.get_image() {
        if let Some(path) = save_temp_png(&img) {
            return shell_quote(&path);
        }
    }
    cb.get_text().unwrap_or_default()
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
