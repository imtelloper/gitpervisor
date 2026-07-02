use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use tokio::process::Command;

use crate::error::{ErrorCode, IpcError};

pub const READ_TIMEOUT_SECS: u64 = 10;
/// git status 전용 — 거대한 레포에서 AI CLI 등이 격렬히 파일을 바꾸면 status가
/// 디스크 I/O 경합으로 10초를 넘길 수 있어 더 넉넉히 잡는다.
pub const STATUS_TIMEOUT_SECS: u64 = 45;
/// 훅 실행 여유를 포함한 로컬 변경 작업(add/commit 등) 타임아웃
pub const ACTION_TIMEOUT_SECS: u64 = 60;
/// push/pull/fetch 등 네트워크 작업 타임아웃 (설계 §8)
pub const NETWORK_TIMEOUT_SECS: u64 = 120;

pub struct GitOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl GitOutput {
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

static GIT_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
/// 설정에서 지정한 git 경로 오버라이드 (None이면 PATH 자동 탐색으로 폴백).
static GIT_OVERRIDE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// 설정의 git 경로를 적용한다. 빈 값은 무시(자동 탐색).
pub fn set_git_override(path: Option<PathBuf>) {
    *GIT_OVERRIDE.write().unwrap() = path.filter(|p| !p.as_os_str().is_empty());
}

pub fn git_path() -> Option<PathBuf> {
    if let Some(p) = GIT_OVERRIDE.read().unwrap().clone() {
        return Some(p);
    }
    GIT_PATH.get_or_init(find_git).clone()
}

/// 커밋 해시 인자 검증 — hex만 허용해 `-`로 시작하는 플래그 인젝션·잘못된 rev를 차단한다.
pub fn is_valid_sha(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(windows)]
fn find_git() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if let Ok(out) = std::process::Command::new("where.exe")
        .arg("git")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    [
        r"C:\Program Files\Git\cmd\git.exe",
        r"C:\Program Files (x86)\Git\cmd\git.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

#[cfg(not(windows))]
fn find_git() -> Option<PathBuf> {
    if let Ok(out) = std::process::Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
    {
        if out.status.success() {
            let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !line.is_empty() {
                let p = PathBuf::from(line);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    // GUI에서 launchd로 실행될 때 PATH가 빈약해 `command -v`가 실패하는 케이스 대비
    [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
        "/usr/local/git/current/bin/git",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

/// 모든 git 실행의 단일 관문. 인자는 배열로만 받는다 — 셸 문자열 조합 금지.
pub async fn run_git(
    cwd: Option<&Path>,
    args: &[&str],
    timeout_secs: u64,
) -> Result<GitOutput, IpcError> {
    run_git_env(cwd, args, &[], timeout_secs).await
}

/// 추가 환경변수를 주입하는 변형 (배경 fetch의 자격증명 프롬프트 억제 등, 태스크 04 §3.2).
/// 기존 run_git과 같은 단일 관문 — run_git이 빈 env로 이 함수에 위임한다.
pub async fn run_git_env(
    cwd: Option<&Path>,
    args: &[&str],
    extra_env: &[(&str, &str)],
    timeout_secs: u64,
) -> Result<GitOutput, IpcError> {
    let git = git_path().ok_or_else(|| {
        IpcError::new(
            ErrorCode::GitNotFound,
            "git 실행 파일을 찾을 수 없습니다 (PATH 또는 Git 설치 확인)",
        )
    })?;

    let mut cmd = Command::new(git);
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: 콘솔 창 깜빡임 방지

    let child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("git 실행 실패: {e}")))?;

    // 타임아웃 시 future drop → kill_on_drop이 프로세스를 정리한다.
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| {
            IpcError::new(
                ErrorCode::Timeout,
                format!(
                    "git {} 시간 초과 ({timeout_secs}초)",
                    args.first().unwrap_or(&"")
                ),
            )
        })?
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("git 출력 수집 실패: {e}")))?;

    Ok(GitOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// stdin으로 데이터를 전달하는 변형 — 커밋 메시지 등 사용자 입력을 인자 대신 stdin으로 보낸다.
pub async fn run_git_with_stdin(
    cwd: Option<&Path>,
    args: &[&str],
    stdin_data: &[u8],
    timeout_secs: u64,
) -> Result<GitOutput, IpcError> {
    let git = git_path().ok_or_else(|| {
        IpcError::new(
            ErrorCode::GitNotFound,
            "git 실행 파일을 찾을 수 없습니다 (PATH 또는 Git 설치 확인)",
        )
    })?;

    let mut cmd = Command::new(git);
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("git 실행 실패: {e}")))?;

    let mut stdin = child.stdin.take().expect("stdin piped");
    let data = stdin_data.to_vec();
    let write_stdin = async move {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(&data).await; // drop이 stdin을 닫아 EOF 전달
    };

    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), async {
        let (_, out) = tokio::join!(write_stdin, child.wait_with_output());
        out
    })
    .await
    .map_err(|_| {
        IpcError::new(
            ErrorCode::Timeout,
            format!(
                "git {} 시간 초과 ({timeout_secs}초)",
                args.first().unwrap_or(&"")
            ),
        )
    })?
    .map_err(|e| IpcError::new(ErrorCode::Io, format!("git 출력 수집 실패: {e}")))?;

    Ok(GitOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// stderr를 라인 단위로 콜백에 흘려보내며 실행한다 (push/pull/fetch `--progress`).
/// git 진행 출력은 CR 갱신이라 라인 단위(=단계 단위) 정도의 granularity를 가진다.
pub async fn run_git_streaming(
    cwd: &Path,
    args: &[&str],
    timeout_secs: u64,
    mut on_stderr_line: impl FnMut(String),
) -> Result<GitOutput, IpcError> {
    let git = git_path().ok_or_else(|| {
        IpcError::new(
            ErrorCode::GitNotFound,
            "git 실행 파일을 찾을 수 없습니다 (PATH 또는 Git 설치 확인)",
        )
    })?;

    let mut cmd = Command::new(git);
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("git 실행 실패: {e}")))?;

    let stderr = child.stderr.take().expect("stderr piped");
    let mut stdout = child.stdout.take().expect("stdout piped");

    let (status, stdout_buf, err_lines) =
        tokio::time::timeout(Duration::from_secs(timeout_secs), async {
            let stdout_task = async {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let _ = stdout.read_to_end(&mut buf).await;
                buf
            };
            let stderr_task = async {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                let mut collected = Vec::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    on_stderr_line(line.clone());
                    collected.push(line);
                }
                collected
            };
            let (stdout_buf, err_lines) = tokio::join!(stdout_task, stderr_task);
            let status = child.wait().await;
            (status, stdout_buf, err_lines)
        })
        .await
        .map_err(|_| {
            IpcError::new(
                ErrorCode::Timeout,
                format!(
                    "git {} 시간 초과 ({timeout_secs}초)",
                    args.first().unwrap_or(&"")
                ),
            )
        })?;

    let status =
        status.map_err(|e| IpcError::new(ErrorCode::Io, format!("git 종료 대기 실패: {e}")))?;

    Ok(GitOutput {
        code: status.code().unwrap_or(-1),
        stdout: stdout_buf,
        stderr: err_lines.join("\n"),
    })
}
