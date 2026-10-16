//! 파일 잠금 찾기(DOCS/pc-care-design.md §4.9) — 파일·폴더를 붙잡고 있는 프로세스를 찾는다.
//! GoClean의 "파일 강제삭제"는 남의 핸들을 강제로 닫는 방식으로 추정되는데(프로세스가 깨진다), 여기서는
//! 찾기만 하고 끝내기는 기존 `kill_processes`(앱 자신 제외 규칙 포함)에 맡긴다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare_tools as t;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocker {
    pub pid: u32,
    pub name: String,
    pub exe_path: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLockReport {
    pub lockers: Vec<FileLocker>,
    /// 폴더 안 파일이 상한(`MAX_FOLDER_FILES`)을 넘어 일부만 확인했다.
    pub truncated: bool,
    /// 확인하지 못한 부분의 사유(권한 없는 프로세스 등) — 빈 결과가 "아무도 안 잡음"으로 읽히지 않게.
    pub notes: Vec<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
const MAX_FOLDER_FILES: usize = 2000;

#[tauri::command(async)]
pub async fn file_lockers(path: String) -> Result<FileLockReport, IpcError> {
    let target = PathBuf::from(&path);
    let meta = std::fs::metadata(&target)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, t::file_locks_path_missing(&path, e)))?;
    let is_dir = meta.is_dir();

    #[cfg(any(windows, target_os = "linux"))]
    return tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        return windows_lockers(&target, is_dir);
        #[cfg(target_os = "linux")]
        return Ok::<_, IpcError>(linux_lockers(&target, is_dir));
    })
    .await
    .map_err(|e| IpcError::new(ErrorCode::Io, t::pccare_tools_task_failed(e)))?;
    #[cfg(target_os = "macos")]
    return macos_lockers(&target, is_dir).await;
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (target, is_dir); // 미지원 OS — 쓰지 않는 값 경고만 막는다
        Err(IpcError::new(ErrorCode::Unsupported, t::file_locks_unsupported()))
    }
}

/// 비교 키. Windows는 대소문자를 가리지 않고, sysinfo·대화상자가 `\\?\`·`/` 표기를 섞어 돌려준다.
fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    let s = s
        .strip_prefix(r"\\?\")
        .unwrap_or(&s)
        .replace('/', "\\")
        .to_lowercase();
    s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string()
}

fn is_same_or_under(child: &Path, root: &Path) -> bool {
    let c = path_key(child);
    let r = path_key(root);
    c == r
        || (c.len() > r.len()
            && c.starts_with(&r)
            && c[r.len()..].starts_with(std::path::MAIN_SEPARATOR))
}

/// 같은 pid가 여러 이유로 잡히면(파일 열림 + 작업 폴더) 한 행에 이유를 잇는다.
fn add_locker(
    map: &mut BTreeMap<u32, FileLocker>,
    pid: u32,
    name: String,
    exe_path: Option<String>,
    reason: String,
) {
    match map.get_mut(&pid) {
        Some(l) => {
            if !l.reason.contains(&reason) {
                l.reason = format!("{} · {reason}", l.reason);
            }
        }
        None => {
            map.insert(pid, FileLocker { pid, name, exe_path, reason });
        }
    }
}

/// `lsof -F pcn` 출력 → (pid, 명령 이름). 필드 하나가 한 줄이고 `p`가 프로세스 묶음을 연다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof_pcn(out: &str) -> Vec<(u32, String)> {
    let mut res: Vec<(u32, String)> = Vec::new();
    let mut pid: Option<u32> = None;
    let mut name = String::new();
    for line in out.lines() {
        let (tag, val) = match line.chars().next() {
            Some(c) => (c, &line[c.len_utf8()..]),
            None => continue,
        };
        match tag {
            'p' => {
                pid = val.parse().ok();
                name.clear();
            }
            'c' => name = val.to_string(),
            'n' => {
                if let Some(p) = pid {
                    if !res.iter().any(|(q, _)| *q == p) {
                        res.push((p, name.clone()));
                    }
                }
            }
            _ => {}
        }
    }
    res
}

#[cfg(windows)]
fn windows_lockers(target: &Path, is_dir: bool) -> Result<FileLockReport, IpcError> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let mut report = FileLockReport::default();
    let files = if is_dir {
        let mut v = Vec::new();
        report.truncated = collect_files(target, &mut v, MAX_FOLDER_FILES);
        v
    } else {
        vec![target.to_path_buf()]
    };
    let rm = rm_lockers(&files)?;

    let mut kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::Always);
    if is_dir {
        kind = kind.with_cwd(UpdateKind::Always);
    }
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let info = |pid: u32| {
        sys.process(sysinfo::Pid::from_u32(pid)).map(|p| {
            (
                p.name().to_string_lossy().into_owned(),
                p.exe().map(|e| e.display().to_string()),
            )
        })
    };

    let mut map = BTreeMap::new();
    for (pid, app_name, svc) in rm {
        let (name, exe) = info(pid).unwrap_or((app_name, None));
        let reason = if svc.is_empty() {
            t::file_locks_reason_open_file().to_string()
        } else {
            t::file_locks_reason_service(&svc)
        };
        add_locker(&mut map, pid, name, exe, reason);
    }
    if is_dir {
        for (pid, p) in sys.processes() {
            let exe = p.exe().map(|e| e.display().to_string());
            let name = p.name().to_string_lossy().into_owned();
            if p.exe().is_some_and(|e| is_same_or_under(e, target)) {
                add_locker(&mut map, pid.as_u32(), name.clone(), exe.clone(), t::file_locks_reason_exe_inside().into());
            }
            if p.cwd().is_some_and(|c| is_same_or_under(c, target)) {
                add_locker(&mut map, pid.as_u32(), name, exe, t::file_locks_reason_cwd_inside().into());
            }
        }
    }
    report.lockers = map.into_values().collect();
    Ok(report)
}

/// 폴더 안 파일을 `max`개까지 모은다. 링크·정션은 따라가지 않는다(순환·폴더 밖 파일 등록 방지).
/// 상한에 걸렸으면 true.
#[cfg(windows)]
fn collect_files(root: &Path, out: &mut Vec<PathBuf>, max: usize) -> bool {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // 읽을 수 없는 하위 폴더는 등록할 파일이 없을 뿐이다 — 나머지는 계속 본다.
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            // Windows의 FileType::is_dir()는 심링크·정션(이름 대리 재분석 지점)이면 false다.
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file() {
                if out.len() >= max {
                    return true;
                }
                out.push(e.path());
            }
        }
    }
    false
}

/// Restart Manager로 파일을 연 프로세스 목록 → (pid, 앱 이름, 서비스 이름).
#[cfg(windows)]
fn rm_lockers(files: &[PathBuf]) -> Result<Vec<(u32, String, String)>, IpcError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::core::PCWSTR;
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };

    struct Session(u32);
    impl Drop for Session {
        fn drop(&mut self) {
            // 세션은 사용자당 64개 한도라 오류 경로에서도 반드시 닫는다.
            unsafe { RmEndSession(self.0) };
        }
    }
    let rm_err = |step: &str, code: u32| IpcError::new(ErrorCode::Io, t::file_locks_rm_failed(step, code));

    if files.is_empty() {
        return Ok(Vec::new());
    }
    let mut handle = 0u32;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    let rc = unsafe { RmStartSession(&mut handle, 0, key.as_mut_ptr()) };
    if rc != ERROR_SUCCESS {
        return Err(rm_err("RmStartSession", rc));
    }
    let _session = Session(handle);

    let wide: Vec<Vec<u16>> = files
        .iter()
        .map(|p| p.as_os_str().encode_wide().chain(std::iter::once(0)).collect())
        .collect();
    let ptrs: Vec<PCWSTR> = wide.iter().map(|w| w.as_ptr()).collect();
    let rc = unsafe {
        RmRegisterResources(handle, ptrs.len() as u32, ptrs.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null())
    };
    if rc != ERROR_SUCCESS {
        return Err(rm_err("RmRegisterResources", rc));
    }

    let mut infos: Vec<RM_PROCESS_INFO> = Vec::new();
    let mut attempts = 0;
    loop {
        let mut needed = 0u32;
        let mut count = infos.len() as u32;
        let mut reasons = 0u32;
        let buf = if infos.is_empty() { std::ptr::null_mut() } else { infos.as_mut_ptr() };
        let rc = unsafe { RmGetList(handle, &mut needed, &mut count, buf, &mut reasons) };
        if rc == ERROR_SUCCESS {
            infos.truncate(count as usize);
            break;
        }
        attempts += 1;
        // 두 호출 사이에 목록이 늘 수 있어 다시 묻는다 — 끝없이 늘어나는 경우만 끊는다.
        if rc != ERROR_MORE_DATA || attempts > 5 {
            return Err(rm_err("RmGetList", rc));
        }
        // SAFETY: RM_PROCESS_INFO는 정수·배열뿐인 POD라 0으로 채운 값이 유효하다.
        infos = vec![unsafe { std::mem::zeroed() }; needed as usize + 4];
    }

    let utf16 = |s: &[u16]| {
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        String::from_utf16_lossy(&s[..end])
    };
    Ok(infos
        .iter()
        .map(|i| (i.Process.dwProcessId, utf16(&i.strAppName), utf16(&i.strServiceShortName)))
        .collect())
}

#[cfg(target_os = "linux")]
fn linux_lockers(target: &Path, is_dir: bool) -> FileLockReport {
    use std::fs;

    // 대화상자 경로가 심링크를 거칠 수 있다 — /proc 링크 대상은 언제나 실제 경로다.
    let target = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let mut report = FileLockReport::default();
    let mut map = BTreeMap::new();
    let mut unreadable = 0usize;
    let rd = match fs::read_dir("/proc") {
        Ok(rd) => rd,
        Err(e) => {
            report.notes.push(e.to_string());
            return report;
        }
    };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let base = e.path();
        let name = fs::read_to_string(base.join("comm")).map(|s| s.trim().to_string()).unwrap_or_default();
        let exe = fs::read_link(base.join("exe")).ok();
        let exe_str = exe.as_ref().map(|p| p.display().to_string());
        if is_dir {
            if exe.as_deref().is_some_and(|p| is_same_or_under(p, &target)) {
                add_locker(&mut map, pid, name.clone(), exe_str.clone(), t::file_locks_reason_exe_inside().into());
            }
            if fs::read_link(base.join("cwd")).is_ok_and(|p| is_same_or_under(&p, &target)) {
                add_locker(&mut map, pid, name.clone(), exe_str.clone(), t::file_locks_reason_cwd_inside().into());
            }
        }
        match fs::read_dir(base.join("fd")) {
            Ok(fds) => {
                for fd in fds.flatten() {
                    if fs::read_link(fd.path()).is_ok_and(|p| is_same_or_under(&p, &target)) {
                        add_locker(&mut map, pid, name.clone(), exe_str.clone(), t::file_locks_reason_open_file().into());
                        break;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => unreadable += 1,
            // 그사이 끝난 프로세스 — 셀 것이 없다.
            Err(_) => {}
        }
    }
    if unreadable > 0 {
        report.notes.push(t::file_locks_unreadable_procs(unreadable));
    }
    report.lockers = map.into_values().collect();
    report
}

#[cfg(target_os = "macos")]
async fn macos_lockers(target: &Path, is_dir: bool) -> Result<FileLockReport, IpcError> {
    use std::process::Stdio;
    use std::time::Duration;
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    const LSOF: &str = "/usr/sbin/lsof";
    const TIMEOUT_SECS: u64 = 20;
    if !Path::new(LSOF).exists() {
        return Err(IpcError::new(ErrorCode::ToolNotFound, t::file_locks_lsof_missing()));
    }
    // run_capture를 쓰지 않는다 — 그쪽은 빈 stdout을 오류로 보는데, lsof의 "아무도 안 잡음"이
    // 바로 빈 stdout + 종료 코드 1이다.
    let mut cmd = tokio::process::Command::new(LSOF);
    cmd.args(["-F", "pcn"]);
    if is_dir {
        cmd.arg("+D").arg(target);
    } else {
        cmd.arg("--").arg(target);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, t::file_locks_lsof_failed(e)))?;
    let out = tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), child.wait_with_output())
        .await
        .map_err(|_| IpcError::new(ErrorCode::Timeout, t::file_locks_lsof_timed_out(TIMEOUT_SECS)))?
        .map_err(|e| IpcError::new(ErrorCode::Io, t::file_locks_lsof_failed(e)))?;

    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    let mut map = BTreeMap::new();
    for (pid, name) in parse_lsof_pcn(&String::from_utf8_lossy(&out.stdout)) {
        let exe = sys
            .process(sysinfo::Pid::from_u32(pid))
            .and_then(|p| p.exe().map(|e| e.display().to_string()));
        add_locker(&mut map, pid, name, exe, t::file_locks_reason_open_file().into());
    }
    Ok(FileLockReport { lockers: map.into_values().collect(), truncated: false, notes: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_tools_locks_under_matches_on_separator_boundary() {
        let root = std::env::temp_dir().join("gpv-root");
        assert!(is_same_or_under(&root, &root));
        assert!(is_same_or_under(&root.join("a").join("b.txt"), &root));
        // 접두어만 같은 형제 폴더는 아래가 아니다.
        let sibling = std::env::temp_dir().join("gpv-root2").join("x");
        assert!(!is_same_or_under(&sibling, &root));
        assert!(!is_same_or_under(&std::env::temp_dir(), &root));
    }

    #[cfg(windows)]
    #[test]
    fn pccare_tools_locks_windows_key_ignores_case_prefix_and_slashes() {
        assert!(is_same_or_under(Path::new(r"\\?\C:\Users\A\Proj\x.exe"), Path::new(r"c:/users/a/proj/")));
        assert!(is_same_or_under(Path::new(r"C:\Windows"), Path::new(r"C:\")));
        assert!(!is_same_or_under(Path::new(r"C:\ProjX\a"), Path::new(r"C:\Proj")));
    }

    #[test]
    fn pccare_tools_locks_parse_lsof_groups_by_pid() {
        let out = "p123\ncnode\nn/tmp/a.txt\nn/tmp/b.txt\np456\ncVim Helper\nn/tmp/a.txt\np789\ncidle\n";
        assert_eq!(
            parse_lsof_pcn(out),
            vec![(123, "node".to_string()), (456, "Vim Helper".to_string())]
        );
        assert!(parse_lsof_pcn("").is_empty());
    }

    #[test]
    fn pccare_tools_locks_merges_reasons_per_pid() {
        let mut m = BTreeMap::new();
        add_locker(&mut m, 7, "a".into(), None, "r1".into());
        add_locker(&mut m, 7, "a".into(), None, "r2".into());
        add_locker(&mut m, 7, "a".into(), None, "r1".into());
        assert_eq!(m.len(), 1);
        assert_eq!(m[&7].reason, "r1 · r2");
    }

    /// 실동작: 자식 PowerShell이 FileStream으로 연 임시 파일을 Restart Manager가 그 pid로 찾는다.
    #[cfg(windows)]
    #[test]
    fn pccare_tools_locks_windows_finds_child_holding_file() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("held.txt");
        std::fs::write(&file, b"x").unwrap();
        let script = format!(
            "$f=[IO.File]::Open('{}','Open','Read','None'); Write-Output ready; Start-Sleep 20",
            file.display()
        );
        let mut child = match Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("powershell 없음 — 건너뜀: {e}");
                return;
            }
        };
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "ready");

        let file_report = windows_lockers(&file, false).unwrap();
        let dir_report = windows_lockers(dir.path(), true).unwrap();
        let _ = child.kill();
        let _ = child.wait();

        assert!(file_report.lockers.iter().any(|l| l.pid == child.id()), "{file_report:?}");
        assert!(dir_report.lockers.iter().any(|l| l.pid == child.id()), "{dir_report:?}");
        assert!(!dir_report.truncated);
    }
}
