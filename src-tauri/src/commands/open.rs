use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;
use tauri::State;

use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

// ─────────────────────────────────────────────────────────────────────────────
// 외부 프로그램 실행(런처) 공용 경로 — 이 파일·diagnostics.rs·browser.rs가 모두 여기를 지난다.
//
// 예전 코드는 전부 `Command::new(..).spawn().map(|_| ())` 로 Child를 즉시 버렸다. 그래서
//  (1) 부모(앱)가 살아있는 한 리핑되지 않는 좀비가 쌓이고,
//  (2) 리눅스에서 xdg-open/gio가 띄운 핸들러(브라우저·에디터·파일매니저)가 앱의 systemd
//      cgroup을 그대로 상속해 앱 scope에 눌러앉았다. 이 머신 GLib 2.72.4에는 transient
//      scope를 만드는 코드가 없어 reparent가 일어나도 cgroup은 그대로다(조사에서 확인).
//
// 2026-08-01 systemd-oomd 강제종료 사후조치(DOCS/process-leak-postmortem.md §4.2)의
// "앱이 생명주기를 모르는 프로세스(=사용자 것)는 앱 cgroup 밖으로 내보낸다" 원칙을 구현한다.
// VTE가 vte-spawn-*.scope 로 이미 하는 일과 같다.
//
// **보안**: 인자는 언제나 argv 배열로만 흐른다. 셸 문자열을 조립하지 않으므로 URL·파일명의
// `& | ^ ( ) !` 같은 메타문자가 명령으로 해석될 여지가 없다(systemd-run 위임 시에도 `--` 뒤에
// 배열로 넘긴다). 기존 코드가 지키던 성질이며 여기서도 유지한다.
// ─────────────────────────────────────────────────────────────────────────────

/// 외부 프로그램을 띄우는 **유일한 경로**. 호출부는 program/args/(필요 시)current_dir·
/// creation_flags만 채운 `Command`를 넘긴다.
///
/// 공통으로 하는 일:
/// - stdin/stdout/stderr 를 전부 `Stdio::null()` — 핸들러 출력이 앱 stdio로 새지 않게.
/// - unix: `process_group(0)` — 앱 그룹에 대한 killpg/Ctrl+C가 사용자 프로그램까지 끌고
///   내려가지 않게 분리한다(사용자 소유 프로세스이므로).
/// - 리눅스: `systemd-run --user` 위임 우선(아래 `try_delegate_to_systemd`).
/// - 회수: 위임에 성공하면 systemd가 소유하므로 우리 자식은 systemd-run 하나뿐이고 여기서
///   바로 거둔다. 직접 spawn한 경우엔 detach 리퍼 스레드가 거둔다 — 어느 쪽이든 좀비 없음.
///
/// `what`은 로그용 사람 읽는 이름("탐색기"·"터미널"…)이다. 반환 Err는 "정말로 못 띄웠다"를
/// 뜻하므로 호출부가 폴백 판단(run_file → xdg-open, wt → cmd)에 그대로 쓸 수 있다.
pub(crate) fn spawn_launcher(mut cmd: Command, what: &str) -> std::io::Result<()> {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if try_delegate_to_systemd(&cmd, what) {
            return Ok(());
        }
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    match cmd.spawn() {
        Ok(child) => {
            log::info!("{what} 실행(직접 spawn) pid={}", child.id());
            reap_detached(child);
            Ok(())
        }
        Err(e) => {
            log::warn!("{what} 실행 실패: {e}");
            Err(e)
        }
    }
}

/// 자식을 detach 스레드에서 `wait`으로 회수한다(좀비 방지).
///
/// 런처가 띄우는 것은 대개 오래 사는 GUI 앱이라 호출부에서 기다릴 수 없다. 스레드는 waitpid에
/// 블록된 채 자식이 끝날 때까지만 살고, 하는 일이 wait 하나뿐이라 스택을 64KB로 줄여 둔다.
/// 전역 `signal(SIGCHLD, SIG_IGN)` 은 **금지** — git/lsp/PTY의 `wait()`·`output()` 이 ECHILD로
/// 깨진다(사후조치 문서 P1 주석).
fn reap_detached(mut child: std::process::Child) {
    // Windows에는 좀비가 없다 — Child를 drop하면 핸들만 닫히고 끝이다. 여기서 스레드를 띄우면
    // 탐색기·터미널 창 하나당 스레드 하나가 그 창이 닫힐 때까지 살아남는 순수 낭비가 된다.
    #[cfg(windows)]
    {
        drop(child);
        return;
    }
    #[cfg(not(windows))]
    {
    let spawned = std::thread::Builder::new()
        .name("launcher-reap".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            let _ = child.wait();
        });
    if spawned.is_err() {
        // 스레드조차 못 만드는 상황(자원 고갈)에서는 예전과 동일하게 Child를 버린다 —
        // 더 나빠지지는 않는다.
        log::warn!("런처 리퍼 스레드 생성 실패 — 자식 회수를 건너뛴다");
    }
    }
}

/// systemd 위임 응답을 기다리는 상한. systemd-run은 D-Bus 왕복 한 번이라 실측 ~30ms에 끝난다.
/// 동기 `#[tauri::command]` 는 메인 스레드에서 돌기 때문에(browser.rs 상단 주석 참고) 이 값이
/// 곧 최악의 UI 프리즈 시간이다 — 넉넉하되 짧게 잡는다.
#[cfg(all(unix, not(target_os = "macos")))]
const SYSTEMD_RUN_WAIT_MS: u64 = 300;

/// systemd-run 바이너리 자체가 없는 환경(컨테이너·비-systemd)에서 매 호출마다 spawn을
/// 시도하지 않도록 한 번 확인하면 기억한다. 종료코드 실패는 캐시하지 않는다 — 일시적일 수
/// 있고, 사용자 조작 빈도가 낮아 재시도 비용(프로세스 1개)이 무의미하다.
#[cfg(all(unix, not(target_os = "macos")))]
static SYSTEMD_RUN_MISSING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 위임된 유닛에 명시로 넘겨줄 세션 환경변수.
///
/// systemd --user 매니저의 환경은 로그인 매니저가 `import-environment` 한 것이라 세션 구성에
/// 따라 DISPLAY/WAYLAND_DISPLAY/XDG_CURRENT_DESKTOP 이 비어 있을 수 있다. 비어 있으면 GUI
/// 핸들러가 **조용히** 못 뜬다(사용자 눈엔 "아무 일도 안 일어남"). 세션 안에서 돌고 있는 우리
/// 프로세스의 값을 그대로 전달해 이 함정을 막는다. xdg-open은 XDG_CURRENT_DESKTOP으로 핸들러를
/// 고르므로 특히 중요하다.
#[cfg(all(unix, not(target_os = "macos")))]
const LAUNCH_ENV_KEYS: [&str; 10] = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "PATH",
    "LANG",
];

#[cfg(all(unix, not(target_os = "macos")))]
fn launch_env() -> Vec<(&'static str, std::ffi::OsString)> {
    LAUNCH_ENV_KEYS
        .iter()
        .filter_map(|k| std::env::var_os(k).map(|v| (*k, v)))
        .collect()
}

/// systemd-run 위임 argv를 만든다. 순수 함수 — 단위 테스트 대상.
///
/// `-- <program> <args...>` 형태로 **배열 그대로** 넘기므로 셸 파싱이 개입하지 않는다.
/// **반드시 `--scope`여야 한다. service 유닛을 쓰면 방금 띄운 프로그램이 즉시 죽는다.**
/// service 유닛은 `ExitType=main` + `KillMode=control-group`(둘 다 기본값)이라 메인 프로세스가
/// 끝나는 순간 cgroup에 남은 프로세스를 전부 SIGTERM 한다. 그런데 `xdg-open`은 `gio open`으로
/// 핸들러를 spawn한 뒤 **즉시 종료**하는 런처다 — 브라우저가 뜨자마자 systemd에 살해당한다.
/// 게다가 `--service-type=exec`는 execve 성공만 보므로 systemd-run이 exit 0을 돌려줘
/// **로그에는 성공으로 남고 폴백도 발동하지 않는** 무성 실패가 된다(실측 재현 확인).
/// scope는 수명을 관리하지 않고 cgroup만 옮기며(= VTE의 `vte-spawn-*.scope`와 같은 방식),
/// 호출자의 환경변수도 그대로 상속한다.
/// (`-p ExitType=cgroup`은 systemd ≥250 필요 — 이 머신은 249라 쓸 수 없다.)
/// `--collect` 는 끝난(또는 실패한) 유닛을 즉시 회수해 유닛 누적을 막는다.
#[cfg(all(unix, not(target_os = "macos")))]
fn systemd_run_argv(
    program: &Path,
    args: &[std::ffi::OsString],
    cwd: Option<&Path>,
    env: &[(&'static str, std::ffi::OsString)],
) -> Vec<std::ffi::OsString> {
    use std::ffi::OsString;

    let mut v: Vec<OsString> = [
        "systemd-run",
        "--user",
        "--quiet",
        "--collect",
        "--scope",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    if let Some(dir) = cwd {
        // 유닛의 기본 WorkingDirectory는 홈이다 — current_dir을 준 호출부(터미널 열기 등)의
        // 의미가 사라지지 않도록 명시 전달한다.
        let mut opt = OsString::from("--working-directory=");
        opt.push(dir.as_os_str());
        v.push(opt);
    }
    for (k, val) in env {
        let mut opt = OsString::from("--setenv=");
        opt.push(k);
        opt.push("=");
        opt.push(val);
        v.push(opt);
    }
    v.push(OsString::from("--"));
    v.push(program.as_os_str().to_os_string());
    v.extend(args.iter().cloned());
    v
}

/// PATH에서 실행 가능한 **절대경로**를 찾는다. `sh -c` 를 쓰지 않는다(셸 파싱·프로세스 추가 회피).
///
/// 못 찾으면 None → 호출부는 위임을 포기하고 직접 spawn한다. 이게 중요한 이유: systemd-run에
/// 없는 프로그램을 넘기면 실패가 비동기로 흩어져 사용자에게 오류를 못 돌려준다. 직접 spawn은
/// ENOENT/EACCES를 그대로 돌려주고, run_file의 "직접 실행 실패 → xdg-open 폴백" 분기도 산다.
#[cfg(all(unix, not(target_os = "macos")))]
fn resolve_program(program: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;

    fn executable(p: &Path) -> bool {
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    // 경로 구분자가 있으면 PATH 탐색 대상이 아니다(execvp와 동일 규칙).
    if program.as_bytes().contains(&b'/') {
        let p = Path::new(program);
        // 상대경로는 위임하지 않는다 — 유닛의 WorkingDirectory 기준으로 해석돼 우리가 의도한
        // 경로와 달라질 수 있다. (현재 호출부는 전부 절대경로를 넘긴다.)
        return (p.is_absolute() && executable(p)).then(|| p.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(program))
        .find(|c| c.is_absolute() && executable(c))
}

/// 리눅스: 핸들러를 앱 cgroup 밖(자체 transient 유닛)에서 띄우도록 systemd-run에 위임한다.
/// 위임에 성공하면 true. systemd-run이 없거나(컨테이너·비-systemd) 실패하면 false를 돌려
/// 호출부가 직접 spawn으로 폴백하게 한다 — 위임은 어디까지나 최적화이지 필수 경로가 아니다.
#[cfg(all(unix, not(target_os = "macos")))]
fn try_delegate_to_systemd(cmd: &Command, what: &str) -> bool {
    use std::ffi::OsString;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    if SYSTEMD_RUN_MISSING.load(Ordering::Relaxed) {
        return false;
    }
    // 위임 경로는 Command에 실린 env를 옮기지 않는다(유닛 환경은 --setenv로만 구성된다).
    // 지금은 env를 세팅하는 호출부가 없지만, 생기면 조용히 무시되느니 직접 spawn으로 내려보낸다.
    if cmd.get_envs().next().is_some() {
        return false;
    }
    let Some(program) = resolve_program(cmd.get_program()) else {
        return false;
    };
    let args: Vec<OsString> = cmd.get_args().map(|a| a.to_os_string()).collect();
    let argv = systemd_run_argv(&program, &args, cmd.get_current_dir(), &launch_env());

    let mut runner = Command::new(&argv[0]);
    runner
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    {
        use std::os::unix::process::CommandExt;
        runner.process_group(0);
    }

    let mut child = match runner.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            SYSTEMD_RUN_MISSING.store(true, Ordering::Relaxed);
            log::info!("systemd-run 없음 — 이후 런처는 직접 spawn한다");
            return false;
        }
        Err(e) => {
            log::warn!("systemd-run 실행 실패({e}) — 직접 spawn으로 폴백");
            return false;
        }
    };

    // `--scope`는 systemd-run이 **대상 프로그램으로 exec 해버리므로**, 살아 있다는 것이
    // 곧 "떴다"는 뜻이다. 반대로 짧은 상한 안에 실패 코드로 끝났다면 버스 연결 실패·유닛 생성
    // 거부처럼 위임 자체가 안 된 경우다(실측: D-Bus 없는 환경에서 2~3ms 만에 rc≠0).
    // 그러니 "빨리 실패로 끝남"만 폴백 신호로 쓰고, 나머지는 전부 위임 성공으로 본다.
    // 실행 가능 여부는 이미 resolve_program()이 PATH·실행권한으로 사전 확인했다.
    let deadline = Instant::now() + Duration::from_millis(SYSTEMD_RUN_WAIT_MS);
    loop {
        match child.try_wait() {
            // scope에서는 대상이 곧 이 프로세스다 — 상한 안에 끝났다면 아주 짧은 프로그램이거나
            // 위임 실패다. 성공 코드면 전자로 보고 정상 처리한다.
            Ok(Some(st)) if st.success() => {
                log::info!("{what} 실행(systemd-run scope 위임) — 앱 cgroup 밖");
                return true;
            }
            Ok(Some(st)) => {
                log::warn!("{what} systemd-run 위임 실패({st}) — 직접 spawn으로 폴백");
                return false;
            }
            Ok(None) if Instant::now() >= deadline => {
                // 상한 초과 = 대상이 살아서 돌고 있다는 뜻(정상 경로). 여기서 직접 spawn하면
                // **이중 실행**이 되므로 위임 성공으로 확정하고 회수만 리퍼에 맡긴다.
                log::info!("{what} 실행(systemd-run scope 위임) — 앱 cgroup 밖");
                reap_detached(child);
                return true;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                // 상태를 못 읽으면 성패를 알 수 없다 — 위와 같은 이유로 이중 실행을 피한다.
                log::warn!("systemd-run 상태 확인 실패({e}) — 위임된 것으로 간주");
                reap_detached(child);
                return true;
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenTarget {
    Explorer,
    Terminal,
}

/// 프로젝트 폴더를 탐색기/터미널로 연다 (설계 F11 · §5.2).
#[tauri::command]
pub fn open_in(
    state: State<'_, AppState>,
    project_id: String,
    target: OpenTarget,
) -> Result<(), IpcError> {
    let path = project_path(&state, &project_id)?;
    if !path.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "프로젝트 경로를 찾을 수 없습니다",
        ));
    }
    match target {
        OpenTarget::Explorer => open_explorer(&path),
        OpenTarget::Terminal => open_terminal(&path),
    }
}

fn spawn_err(what: &str, e: std::io::Error) -> IpcError {
    IpcError::new(ErrorCode::Io, format!("{what} 열기 실패: {e}"))
}

/// 임의 파일을 탐색기에서 "폴더 열고 그 파일 선택"으로 연다 (리소스 모니터 → 파일 위치 열기).
/// 경로는 우리 프로세스 스냅샷(exePath)에서 오며 임의 사용자 입력이 아니다.
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), IpcError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(IpcError::new(ErrorCode::NotFound, "경로를 찾을 수 없습니다"));
    }
    reveal(p)
}

#[cfg(windows)]
fn reveal(path: &Path) -> Result<(), IpcError> {
    // explorer /select,<path> — 폴더를 열고 그 파일을 선택 표시한다.
    let mut cmd = Command::new("explorer");
    cmd.arg(format!("/select,{}", path.display()));
    spawn_launcher(cmd, "탐색기").map_err(|e| spawn_err("탐색기", e))
}

#[cfg(target_os = "macos")]
fn reveal(path: &Path) -> Result<(), IpcError> {
    let mut cmd = Command::new("open");
    cmd.args(["-R"]).arg(path);
    spawn_launcher(cmd, "탐색기").map_err(|e| spawn_err("탐색기", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal(path: &Path) -> Result<(), IpcError> {
    // 파일 선택 표준이 없어 부모 폴더를 연다.
    let dir = path.parent().unwrap_or(path);
    let mut cmd = Command::new("xdg-open");
    cmd.arg(dir);
    spawn_launcher(cmd, "탐색기").map_err(|e| spawn_err("탐색기", e))
}

/// 파일트리에서 실행 파일을 더블클릭 → OS 기본 실행기로 띄운다(탐색기 더블클릭과 동일).
/// 경로는 resolve_in_repo로 레포 안임을 보장한다(프론트가 실행 가능 확장자만 호출하지만 방어적).
/// 프론트는 호출 전에 확인 다이얼로그를 띄운다 — 임의 실행 파일 구동의 안전장치.
#[tauri::command]
pub fn run_executable(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    let target = resolve_in_repo(&repo, &rel_path)?;
    // 최종 경로가 심볼릭/정션이면 레포 밖을 가리킬 수 있어 거부(다른 쓰기 커맨드와 동일 가드).
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err(IpcError::new(
                ErrorCode::Io,
                "심볼릭 링크는 실행할 수 없습니다",
            ));
        }
    }
    if !target.is_file() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "실행 파일을 찾을 수 없습니다",
        ));
    }
    run_file(&target)
}

#[cfg(windows)]
fn run_file(target: &Path) -> Result<(), IpcError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // OsStr → UTF-16 널종단 (Win32 와이드 문자열).
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    let file = wide(target.as_os_str());
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let dir = target.parent().map(|p| wide(p.as_os_str()));
    let dir_ptr = dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr());

    // ShellExecuteW 는 경로를 cmd 셸 파싱 없이 그대로 ShellExecute 로 넘긴다(탐색기 더블클릭과 동일).
    // → 파일명의 &,^,%,(),! 같은 cmd 메타문자가 명령으로 해석되는 인젝션(BatBadBut류)을 근본 차단.
    let h = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            dir_ptr,
            SW_SHOWNORMAL,
        )
    };
    // 반환 HINSTANCE 값이 32 이하이면 실패다(WinAPI 규약).
    if (h as isize) <= 32 {
        return Err(IpcError::new(
            ErrorCode::Io,
            format!("실행 실패 (코드 {})", h as isize),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_file(target: &Path) -> Result<(), IpcError> {
    // open 은 .app 번들·확장자 핸들러로 실행한다.
    let mut cmd = Command::new("open");
    cmd.arg(target);
    spawn_launcher(cmd, "실행").map_err(|e| spawn_err("실행", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn run_file(target: &Path) -> Result<(), IpcError> {
    let dir = target.parent().unwrap_or(target);
    // 실행권한 있는 바이너리/스크립트는 직접 실행, 실패하면 기본 핸들러(xdg-open)로 폴백.
    // spawn_launcher는 실행권한이 없거나 exec에 실패하면 Err를 돌려주므로(위임 경로도
    // resolve_program이 PATH·실행권한을 사전 확인한다) 이 폴백 분기의 의미가 그대로 보존된다.
    let mut direct = Command::new(target);
    direct.current_dir(dir);
    if spawn_launcher(direct, "실행").is_ok() {
        return Ok(());
    }
    let mut fallback = Command::new("xdg-open");
    fallback.arg(target);
    spawn_launcher(fallback, "실행").map_err(|e| spawn_err("실행", e))
}

#[cfg(windows)]
fn open_explorer(path: &Path) -> Result<(), IpcError> {
    // explorer는 성공해도 비정상 종료코드를 반환할 수 있어 spawn 성공 여부만 본다.
    let mut cmd = Command::new("explorer");
    cmd.arg(path);
    spawn_launcher(cmd, "탐색기").map_err(|e| spawn_err("탐색기", e))
}

#[cfg(windows)]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Windows Terminal 우선, 없으면 새 cmd 창으로 폴백.
    let mut wt = Command::new("wt");
    wt.arg("-d").arg(path);
    if spawn_launcher(wt, "터미널").is_ok() {
        return Ok(());
    }
    // `start "" cmd` 는 별도 콘솔 창을 띄운다 — 런처 cmd 자체의 깜빡임은 CREATE_NO_WINDOW로 숨긴다.
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "start", "", "cmd"])
        .current_dir(path)
        .creation_flags(CREATE_NO_WINDOW);
    spawn_launcher(cmd, "터미널").map_err(|e| spawn_err("터미널", e))
}

#[cfg(target_os = "macos")]
fn open_explorer(path: &Path) -> Result<(), IpcError> {
    let mut cmd = Command::new("open");
    cmd.arg(path);
    spawn_launcher(cmd, "탐색기").map_err(|e| spawn_err("탐색기", e))
}

#[cfg(target_os = "macos")]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    let mut cmd = Command::new("open");
    cmd.args(["-a", "Terminal"]).arg(path);
    spawn_launcher(cmd, "터미널").map_err(|e| spawn_err("터미널", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_explorer(path: &Path) -> Result<(), IpcError> {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path);
    spawn_launcher(cmd, "탐색기").map_err(|e| spawn_err("탐색기", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    // 데스크톱 터미널을 앱 cgroup 밖으로 내보내는 것이 특히 중요한 자리다 — 터미널 마스터가
    // 아직 없을 때 앱이 그 주인이 되면 사용자가 그 안에서 돌린 모든 워크로드(dev 서버·에이전트)가
    // 앱 scope에 얹힌다(2026-08-01 사건의 구조적 지뢰, 사후조치 문서 §2 판정).
    let mut cmd = Command::new("x-terminal-emulator");
    cmd.current_dir(path);
    spawn_launcher(cmd, "터미널").map_err(|e| spawn_err("터미널", e))
}

/// 런처 헬퍼의 인자 처리 회귀 테스트.
///
/// 여기서 지키는 계약은 **보안 계약**이다: 인자는 셸을 거치지 않고 argv 배열 원소로 그대로
/// 전달돼야 한다. 이 성질이 깨지면 URL 쿼리의 `& | ^ ( )` 가 명령으로 해석돼 원격 페이지가
/// 유발한 다운로드/window.open URL로 임의 명령이 실행될 수 있다(browser.rs open_external 주석).
#[cfg(all(test, unix, not(target_os = "macos")))]
mod launcher_tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    fn os(v: &str) -> OsString {
        OsString::from(v)
    }

    /// `--` 뒤에는 프로그램·인자만, 그것도 원문 그대로 와야 한다.
    #[test]
    fn systemd_argv_passes_args_verbatim_after_dashdash() {
        // 셸 메타문자·공백·따옴표가 모두 든 실제 공격 형태의 URL.
        let evil = "https://evil.example/?x=1&calc.exe|whoami;`id`$(id) \"q\" 'p'";
        let args = vec![os(evil)];
        let argv = systemd_run_argv(Path::new("/usr/bin/xdg-open"), &args, None, &[]);

        let dash = argv.iter().position(|a| a == "--").expect("-- 구분자 필요");
        assert_eq!(argv[dash + 1], os("/usr/bin/xdg-open"));
        assert_eq!(argv[dash + 2], os(evil), "인자는 원문 그대로여야 한다");
        assert_eq!(argv.len(), dash + 3, "`--` 뒤에 잉여 인자가 붙으면 안 된다");
        // 셸 조립의 흔적(한 원소에 프로그램+인자가 합쳐진 형태)이 없어야 한다.
        let joined = OsString::from(format!("/usr/bin/xdg-open {evil}"));
        assert!(argv.iter().all(|a| a != &joined));
        assert_eq!(argv[0], os("systemd-run"));
        assert!(argv.iter().any(|a| a == "--user"));
        assert!(argv.iter().any(|a| a == "--collect"));
        // **scope 여야 한다.** service 유닛은 런처(xdg-open)가 종료하는 순간 cgroup을
        // 통째로 SIGTERM 해서 방금 띄운 브라우저를 죽인다(실측 재현). 이 단언이 그 회귀를 막는다.
        assert!(argv.iter().any(|a| a == "--scope"));
        assert!(
            !argv.iter().any(|a| a.to_string_lossy().starts_with("--service-type")),
            "service 유닛으로 되돌아가면 띄운 프로그램이 즉시 죽는다"
        );
    }

    /// current_dir을 준 호출부(터미널 열기)만 --working-directory를 받는다.
    #[test]
    fn systemd_argv_sets_working_directory_only_when_given() {
        let none = systemd_run_argv(Path::new("/usr/bin/xdg-open"), &[], None, &[]);
        assert!(!none
            .iter()
            .any(|a| a.to_string_lossy().starts_with("--working-directory=")));

        let with = systemd_run_argv(
            Path::new("/usr/bin/x-terminal-emulator"),
            &[],
            Some(Path::new("/home/u/my repo")),
            &[],
        );
        assert!(with.iter().any(|a| a == "--working-directory=/home/u/my repo"));
    }

    /// 세션 환경변수는 `--setenv=K=V` 한 원소로, 값이 `=`·공백을 포함해도 쪼개지지 않는다.
    #[test]
    fn systemd_argv_encodes_env_as_single_elements() {
        let env = vec![
            ("DISPLAY", os(":0")),
            ("XDG_DATA_DIRS", os("/a:/b c")),
            ("DBUS_SESSION_BUS_ADDRESS", os("unix:path=/run/user/1000/bus")),
        ];
        let argv = systemd_run_argv(Path::new("/bin/true"), &[], None, &env);
        assert!(argv.iter().any(|a| a == "--setenv=DISPLAY=:0"));
        assert!(argv.iter().any(|a| a == "--setenv=XDG_DATA_DIRS=/a:/b c"));
        assert!(argv
            .iter()
            .any(|a| a == "--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus"));
        // env 옵션은 반드시 `--` 앞에 있어야 한다(뒤로 가면 대상 프로그램의 인자가 된다).
        let dash = argv.iter().position(|a| a == "--").unwrap();
        assert!(argv[..dash]
            .iter()
            .filter(|a| a.to_string_lossy().starts_with("--setenv="))
            .count()
            == 3);
    }

    /// PATH 탐색: 이름은 절대경로로 확정되고, 없는 이름은 None(→ 위임 포기, 직접 spawn).
    #[test]
    fn resolve_program_finds_path_binary() {
        let sh = resolve_program(std::ffi::OsStr::new("sh")).expect("sh는 PATH에 있어야 한다");
        assert!(sh.is_absolute());
        assert!(sh.ends_with("sh"));
        assert!(resolve_program(std::ffi::OsStr::new("gpv-no-such-binary-xyz")).is_none());
    }

    /// 실행권한 없는 파일은 위임 대상이 아니다 — run_file의 xdg-open 폴백이 살아야 한다.
    #[test]
    fn resolve_program_rejects_non_executable() {
        let p = std::env::temp_dir().join(format!("gpv-launch-test-{}", std::process::id()));
        std::fs::write(&p, b"#!/bin/sh\n").expect("임시 파일 생성");
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(resolve_program(p.as_os_str()).is_none());

        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(resolve_program(p.as_os_str()).as_deref(), Some(p.as_path()));
        let _ = std::fs::remove_file(&p);
    }

    /// 상대경로는 위임하지 않는다(유닛 WorkingDirectory 기준으로 해석돼 대상이 바뀔 수 있다).
    #[test]
    fn resolve_program_rejects_relative_path() {
        assert!(resolve_program(std::ffi::OsStr::new("./sh")).is_none());
    }

    /// 실제 spawn 경로 회귀: 자식이 좀비로 남지 않아야 한다.
    /// (위임되면 systemd-run을, 폴백이면 대상 프로세스를 우리가 거둔다 — 어느 쪽이든 리핑됨.)
    #[test]
    fn spawn_launcher_leaves_no_zombie() {
        let mut cmd = Command::new("true");
        assert!(spawn_launcher(cmd, "테스트").is_ok());
        // 리퍼 스레드가 wait할 시간을 준다. 좀비가 남았다면 /proc/self/task/*/children 에
        // 잡히지만, 여기서는 "실행이 성공하고 패닉 없이 끝난다"까지만 확정한다.
        std::thread::sleep(std::time::Duration::from_millis(200));

        // 없는 프로그램은 반드시 Err — 위임이 무성 성공으로 삼키면 안 된다.
        cmd = Command::new("gpv-no-such-binary-xyz");
        assert!(spawn_launcher(cmd, "테스트").is_err());
    }
}
