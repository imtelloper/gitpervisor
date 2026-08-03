// 외부 도구 러너 — ruff/biome 같은 포매터·린터 바이너리를 발견·실행한다(태스크 15 정의,
// 태스크 16 재사용). git/runner.rs는 git 전용 관문이라 일반화하지 않고, stdin/timeout/
// kill_on_drop/CREATE_NO_WINDOW 관례만 미러한 별도 모듈로 둔다.
//
// 보안: 발견 순서는 ①설정 명시 경로 → ②(옵트인, 기본 꺼짐)프로젝트 로컬 → ③PATH.
// 프로젝트 로컬(node_modules/.bin·.venv)은 레포가 심는 실행 파일이라 옵트인일 때만 본다.
// `.cmd`/`.bat`/`.ps1` 셔틀은 실행하지 않는다(cmd 경유 인젝션·콘솔 창 표면).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

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

/// 실행 권한 비트 확인(unix) — PATH의 어느 디렉토리에 도구와 같은 이름의 **비실행** 파일이
/// 있으면 그것을 도구로 잘못 집는 것을 막는다. `sh -c "command -v"`는 이 검사를 셸이 해줬는데,
/// PATH를 직접 훑기로 하면서 우리가 해야 한다.
#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}
#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file() // Windows는 실행 여부가 확장자로 정해진다(exe_candidates가 거른다)
}

/// PATH에서 시도할 파일 이름들. Windows는 확장자 없는 이름이 실행되지 않으므로 붙여서 본다.
/// `.cmd`/`.bat`/`.ps1` 셔틀은 **의도적으로 제외**한다(모듈 doc 보안: cmd 경유 인젝션·콘솔 창).
/// `#[cfg]` 대신 `cfg!`를 쓴 이유: 양쪽 가지가 모두 컴파일돼 리눅스 빌드에서도 Windows 경로가
/// 타입 검사를 받는다(플랫폼 한쪽만 깨지는 사고를 막는다).
fn exe_candidates(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.com"), name.to_string()]
    } else {
        vec![name.to_string()]
    }
}

/// 주어진 디렉토리들을 순서대로 훑어 실행 파일을 찾는다 — **셸을 띄우지 않는다**. 순수 함수라
/// 유닛테스트로 우선순위·필터를 고정한다.
fn find_in_dirs(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    for dir in dirs {
        // PATH의 빈 항목은 POSIX상 "현재 디렉토리"를 뜻한다 — 앱 CWD(사용자 레포일 수 있다)에
        // 놓인 동명 파일을 도구로 실행하는 것은 명백한 위험이라 건너뛴다.
        if dir.as_os_str().is_empty() {
            continue;
        }
        for cand in exe_candidates(name) {
            let p = dir.join(&cand);
            if is_real_exe(&p) && is_executable(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// PATH 탐색 결과 캐시 — 도구 이름 → (결과, 기록 시각).
///
/// 왜 캐시하나: 린트는 **편집 중 500ms 디바운스마다** discover를 다시 돈다. 예전 구현은 그때마다
/// `sh -c "command -v ruff"`로 **셸 프로세스를 띄웠다** — 타자 치는 내내 초당 두 개씩 프로세스가
/// 나고 죽는 구조라, 프로세스 누수 사후조치의 정리 대상이 됐다. 이제 셸 스폰은 0회이고, 남은
/// 디렉토리 stat조차 캐시가 흡수한다. `git/runner.rs`의 `GIT_PATH: OnceLock`과 같은 취지지만
/// 도구가 여럿이라 이름별 맵으로 둔다.
static PATH_CACHE: OnceLock<RwLock<HashMap<String, (Option<PathBuf>, Instant)>>> = OnceLock::new();

/// "못 찾음" 캐시 수명. git처럼 프로세스 수명 내내 캐시하면 **앱을 켠 뒤 ruff를 설치한 사용자가
/// 재시작 전까지 계속 "미설치"를 본다** — 설정 화면의 설치 확인이 그 자리에서 틀리는 셈이라
/// 캐시가 버그가 된다. 60초면 디바운스 버스트(초당 2회 × 60초 = 120회)는 전부 흡수하면서
/// 새로 설치한 도구는 1분 안에 잡힌다.
const MISS_TTL: Duration = Duration::from_secs(60);

/// 캐시 항목을 그대로 써도 되는지 — 순수 판정(테스트 대상).
/// - `Some(경로)`: 아직 실행 가능하면 유효(stat 1회). 도구를 지우거나 옮겼으면 다시 탐색한다.
/// - `None`(못 찾음): MISS_TTL 이내만 유효.
fn cache_usable(hit: &Option<PathBuf>, recorded_ago: Duration) -> bool {
    match hit {
        Some(p) => is_real_exe(p) && is_executable(p),
        None => recorded_ago < MISS_TTL,
    }
}

/// PATH에서 도구 실행 파일을 찾는다(캐시 경유, 셸 스폰 없음).
fn find_on_path(name: &str) -> Option<PathBuf> {
    let cache = PATH_CACHE.get_or_init(Default::default);
    // 읽기 락은 조회에만 — is_real_exe/is_executable의 stat을 락 안에서 돌리지 않는다.
    let cached = cache.read().unwrap().get(name).cloned();
    if let Some((hit, at)) = cached {
        if cache_usable(&hit, at.elapsed()) {
            return hit;
        }
    }
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let found = find_in_dirs(&dirs, name);
    cache
        .write()
        .unwrap()
        .insert(name.to_string(), (found.clone(), Instant::now()));
    found
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
    // ③ PATH — 사용자/프로젝트 버전 우선. PATH를 직접 훑고 결과를 캐시한다(셸 스폰 0회).
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_candidates_excludes_shell_shuttles() {
        let c = exe_candidates("ruff");
        // 어느 플랫폼이든 셸 셔틀은 후보에 없다(cmd 경유 인젝션·콘솔 창 표면 차단).
        assert!(!c.iter().any(|n| n.ends_with(".cmd")
            || n.ends_with(".bat")
            || n.ends_with(".ps1")));
        if cfg!(windows) {
            assert_eq!(c[0], "ruff.exe", "Windows는 확장자 붙은 이름을 먼저 본다");
        } else {
            assert_eq!(c, vec!["ruff".to_string()], "unix는 이름 그대로만");
        }
    }

    /// PATH 순회 규칙 고정 — 셸을 띄우지 않고도 `command -v`와 같은 결과를 내야 한다.
    /// (실행 권한·빈 PATH 항목 처리는 셸이 해주던 몫이라 회귀가 나기 쉽다.)
    #[cfg(unix)]
    #[test]
    fn find_in_dirs_picks_first_executable_and_skips_traps() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("gpv-tools-{}", std::process::id()));
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        // a/ 에는 같은 이름의 **비실행** 파일(문서·데이터 등) — 집으면 안 된다.
        std::fs::write(a.join("ruff"), b"not an exe").unwrap();
        std::fs::set_permissions(a.join("ruff"), std::fs::Permissions::from_mode(0o644)).unwrap();
        // b/ 에 진짜 실행 파일.
        std::fs::write(b.join("ruff"), b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(b.join("ruff"), std::fs::Permissions::from_mode(0o755)).unwrap();

        let dirs = vec![a.clone(), b.clone()];
        assert_eq!(find_in_dirs(&dirs, "ruff"), Some(b.join("ruff")));
        // 빈 PATH 항목(= CWD)은 건너뛴다 — 레포에 심어둔 동명 파일 실행 방지.
        let dirs_with_empty = vec![PathBuf::new(), b.clone()];
        assert_eq!(find_in_dirs(&dirs_with_empty, "ruff"), Some(b.join("ruff")));
        // 없는 도구는 None(셸 스폰 없이).
        assert_eq!(find_in_dirs(&dirs, "definitely-not-installed"), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 캐시 유효성 판정 회귀 — "못 찾음"을 영구 캐시하면 앱 실행 중 설치한 도구를 영영 못 본다.
    #[cfg(unix)]
    #[test]
    fn cache_expires_misses_but_keeps_live_hits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("gpv-cache-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("biome");
        std::fs::write(&exe, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

        // 살아있는 경로는 오래돼도 유효 — stat 1회로 확인하니 TTL이 필요 없다.
        assert!(cache_usable(&Some(exe.clone()), Duration::from_secs(86_400)));
        // 도구가 사라지면 캐시를 버리고 다시 찾는다(업그레이드로 경로가 바뀌는 경우).
        std::fs::remove_file(&exe).unwrap();
        assert!(!cache_usable(&Some(exe.clone()), Duration::from_secs(0)));
        // "못 찾음"은 TTL 이내만 유효.
        assert!(cache_usable(&None, MISS_TTL - Duration::from_secs(1)));
        assert!(!cache_usable(&None, MISS_TTL));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 같은 이름을 반복 조회해도 결과가 흔들리지 않는다(캐시 왕복 스모크).
    #[test]
    fn find_on_path_is_stable_across_calls() {
        let first = find_on_path("gpv-nonexistent-tool");
        assert_eq!(first, None);
        assert_eq!(find_on_path("gpv-nonexistent-tool"), None);
    }
}
