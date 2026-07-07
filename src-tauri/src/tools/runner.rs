// 외부 도구 러너 — ruff/biome 같은 포매터·린터 바이너리를 발견·실행한다(태스크 15 정의,
// 태스크 16 재사용). git/runner.rs는 git 전용 관문이라 일반화하지 않고, stdin/timeout/
// kill_on_drop/CREATE_NO_WINDOW 관례만 미러한 별도 모듈로 둔다.
//
// 보안: 발견 순서는 ①설정 명시 경로 → ②(옵트인, 기본 꺼짐)프로젝트 로컬 → ③PATH.
// 프로젝트 로컬(node_modules/.bin·.venv)은 레포가 심는 실행 파일이라 옵트인일 때만 본다.
// `.cmd`/`.bat`/`.ps1` 셔틀은 실행하지 않는다(cmd 경유 인젝션·콘솔 창 표면).

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::error::{ErrorCode, IpcError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Ruff,
    Biome,
}

impl Tool {
    fn exe_name(self) -> &'static str {
        match self {
            Tool::Ruff => "ruff",
            Tool::Biome => "biome",
        }
    }
    /// 프로젝트 로컬 후보 경로(옵트인 시에만 탐색). 실행 파일만 — `.cmd`/`.bat`은 제외.
    fn project_local_candidates(self, repo: &Path) -> Vec<PathBuf> {
        let win = cfg!(windows);
        match self {
            Tool::Ruff => {
                if win {
                    vec![
                        repo.join(".venv/Scripts/ruff.exe"),
                        repo.join("venv/Scripts/ruff.exe"),
                    ]
                } else {
                    vec![repo.join(".venv/bin/ruff"), repo.join("venv/bin/ruff")]
                }
            }
            Tool::Biome => {
                if win {
                    vec![repo.join("node_modules/.bin/biome.exe")]
                } else {
                    vec![repo.join("node_modules/.bin/biome")]
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolSource {
    Explicit,
    ProjectLocal,
    Path,
    Bundled,
}

impl ToolSource {
    pub fn as_str(self) -> &'static str {
        match self {
            ToolSource::Explicit => "explicit",
            ToolSource::ProjectLocal => "projectLocal",
            ToolSource::Path => "path",
            ToolSource::Bundled => "bundled",
        }
    }
}

pub struct ToolBin {
    pub path: PathBuf,
    pub source: ToolSource,
}

pub struct ToolOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

/// 실행 파일 후보인지 — 존재하는 파일이고 셸 셔틀 확장자가 아니어야 한다.
fn is_real_exe(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    !matches!(ext.as_str(), "cmd" | "bat" | "ps1")
}

/// PATH에서 도구 실행 파일을 찾는다(where.exe / command -v — git find_git 미러).
fn find_on_path(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(out) = std::process::Command::new("where.exe")
            .arg(name)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if out.status.success() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    let p = PathBuf::from(line.trim());
                    if is_real_exe(&p) {
                        return Some(p);
                    }
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        if let Ok(out) = std::process::Command::new("sh")
            .args(["-c", &format!("command -v {name}")])
            .output()
        {
            if out.status.success() {
                let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let p = PathBuf::from(line);
                if is_real_exe(&p) {
                    return Some(p);
                }
            }
        }
        None
    }
}

/// 도구 바이너리를 발견한다. 발견 순서: ①명시 경로 → ②프로젝트 로컬(옵트인) → ③PATH →
/// ④앱 번들 폴백. 발견을 먼저 하고 번들은 맨 뒤라, 사용자·프로젝트에 도구가 있으면 그걸
/// 써서 버전이 일치하고(특히 디스크에 쓰는 포매터에 중요), 없을 때만 번들로 "그냥 되는" 경험.
/// allow_project_local=false면 ②를 건너뛴다(기본). bundled_dir=None이면 ④를 건너뛴다.
pub fn discover(
    tool: Tool,
    repo: &Path,
    explicit: Option<&str>,
    allow_project_local: bool,
    bundled_dir: Option<&Path>,
) -> Option<ToolBin> {
    // ① 설정 명시 경로 — 존재하면 그것만(조용한 폴백 금지: 지정한 도구가 아닌 것으로 돌면 안 됨).
    if let Some(e) = explicit.filter(|s| !s.trim().is_empty()) {
        let p = PathBuf::from(e.trim());
        return is_real_exe(&p).then_some(ToolBin {
            path: p,
            source: ToolSource::Explicit,
        });
    }
    // ② 프로젝트 로컬(옵트인) — 레포가 심는 실행 파일.
    if allow_project_local {
        for cand in tool.project_local_candidates(repo) {
            if is_real_exe(&cand) {
                return Some(ToolBin {
                    path: cand,
                    source: ToolSource::ProjectLocal,
                });
            }
        }
    }
    // ③ PATH — 사용자/프로젝트 버전 우선.
    if let Some(path) = find_on_path(tool.exe_name()) {
        return Some(ToolBin {
            path,
            source: ToolSource::Path,
        });
    }
    // ④ 앱 번들 폴백 — 아무것도 없을 때 "그냥 되는" 경험.
    if let Some(dir) = bundled_dir {
        let name = if cfg!(windows) {
            format!("{}.exe", tool.exe_name())
        } else {
            tool.exe_name().to_string()
        };
        let cand = dir.join(name);
        if is_real_exe(&cand) {
            return Some(ToolBin {
                path: cand,
                source: ToolSource::Bundled,
            });
        }
    }
    None
}

/// 도구를 stdin 입력으로 실행하고 출력을 수집한다. run_git_with_stdin 미러.
/// cwd = 도구가 설정 파일(pyproject.toml/biome.json)을 탐색할 기준(보통 레포 루트).
pub async fn run_tool_stdin(
    bin: &ToolBin,
    args: &[&str],
    stdin: &[u8],
    cwd: Option<&Path>,
    timeout_secs: u64,
) -> Result<ToolOutput, IpcError> {
    let mut cmd = Command::new(&bin.path);
    cmd.args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW (tokio Command inherent)
    let mut child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("도구 실행 실패: {e}")))?;

    // stdin write → drop(EOF). run_git_with_stdin과 동일.
    if let Some(mut si) = child.stdin.take() {
        si.write_all(stdin)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("stdin 쓰기 실패: {e}")))?;
        drop(si);
    }

    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| IpcError::new(ErrorCode::Timeout, "도구 실행 시간 초과".to_string()))?
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("도구 출력 수집 실패: {e}")))?;

    Ok(ToolOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// 앱 번들의 도구 디렉토리(resource_dir/tools) — 존재할 때만 Some. discover의 ④ 폴백 소스.
pub fn bundled_tools_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app.path().resource_dir().ok()?.join("tools");
    dir.is_dir().then_some(dir)
}

/// 도구 실행(인자만) — 버전 조회·파일 린트 등 stdin 불필요한 경우.
pub async fn run_tool(
    bin: &ToolBin,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_secs: u64,
) -> Result<ToolOutput, IpcError> {
    run_tool_stdin(bin, args, &[], cwd, timeout_secs).await
}
