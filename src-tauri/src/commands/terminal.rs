use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

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
    sink: Arc<Mutex<Option<Channel<Vec<u8>>>>>,
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

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        IpcError::new(
            ErrorCode::Io,
            format!("셸 실행 실패({}): {e}", shell.program),
        )
    })?;
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

    let pid = i32::try_from(child.process_id().unwrap_or(0)).unwrap_or(0);
    let child = Arc::new(Mutex::new(child));
    let closed = Arc::new(AtomicBool::new(false));
    // 출력 sink를 Arc<Mutex>로 — 플로팅 분리 시 term_attach가 이 sink를 새 창 Channel로 바꾼다.
    let sink = Arc::new(Mutex::new(Some(on_data)));

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
                        // 의도적 종료는 sink를 None으로 비워 죽은 Channel에 계속 쏘지 않게 한다.
                        if let Some(ch) = sink.lock().unwrap().as_ref() {
                            let _ = ch.send(buf[..n].to_vec());
                        }
                    }
                    // EINTR은 정상적인 시그널 인터럽트다. 여기서 루프를 끊으면 아직 살아있는 셸에
                    // 곧바로 블로킹 wait()를 걸어 child 뮤텍스를 영구 점유한다 — 반드시 재시도.
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let code = child
                .lock()
                .unwrap()
                .wait()
                .map(|s| s.exit_code() as i32)
                .unwrap_or(-1);
            // 셸이 스스로 끝난 경우(exit 입력 등)에도 레지스트리 엔트리가 남아 writer/master fd가
            // 영구 누적됐다 — 자기 엔트리를 회수한다. pid를 대조해 term_open 교체와의 레이스를 피한다.
            if let Some(state) = app.try_state::<AppState>() {
                let mut terms = state.terminals.lock().unwrap();
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
        writer,
        master: pair.master,
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
        .unwrap()
        .insert(term_id.clone(), session);
    if let Some(old) = old {
        spawn_terminate(old);
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
    *session.sink.lock().unwrap() = Some(on_data);
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

/// 단일 세션 종료(세션 트리 kill + 제거). 커맨드/창 이벤트(플로팅 창 닫힘) 공용.
pub fn close_session(state: &AppState, term_id: &str) {
    // 맵에서 먼저 꺼내고 락을 놓는다. 예전에는 `if let Some(..) = lock().remove(..)` 형태라
    // 가드가 본문 끝까지 살아 kill을 전역 락 아래에서 돌렸다.
    let session = state.terminals.lock().unwrap().remove(term_id);
    if let Some(session) = session {
        spawn_terminate(session);
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
        let mut terms = state.terminals.lock().unwrap();
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
    *session.sink.lock().unwrap() = None;

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

#[cfg(all(test, unix))]
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
