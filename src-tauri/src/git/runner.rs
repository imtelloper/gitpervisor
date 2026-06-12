use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::Command;

use crate::error::{ErrorCode, IpcError};

pub const READ_TIMEOUT_SECS: u64 = 10;

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

pub fn git_path() -> Option<&'static Path> {
    GIT_PATH.get_or_init(find_git).as_deref()
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
    let out = std::process::Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if line.is_empty() {
        None
    } else {
        Some(PathBuf::from(line))
    }
}

/// 모든 git 실행의 단일 관문. 인자는 배열로만 받는다 — 셸 문자열 조합 금지.
pub async fn run_git(
    cwd: Option<&Path>,
    args: &[&str],
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
