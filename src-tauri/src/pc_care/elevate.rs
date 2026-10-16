//! 관리자(root) 권한으로 **고정된 시스템 프로그램 하나**를 실행한다(DOCS/pc-care-design.md §3).
//!
//! 승격은 이 파일에서만 한다 — 호출처가 `runas`·`pkexec`·`osascript`를 직접 부르면 인자 검증이 흩어진다.
//! 프로그램은 enum으로 고정(호출처가 임의 경로를 넘기지 못한다)하고, 인자는 셸을 거치지 않거나(Windows·Linux)
//! 허용 문자만 남긴다(macOS — `do shell script`는 셸 문자열이라 다른 길이 없다).

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ElevatedProgram {
    #[cfg(windows)]
    Sc,
    #[cfg(windows)]
    Schtasks,
    #[cfg(windows)]
    Reg,
    #[cfg(windows)]
    Regsvr32,
    #[cfg(target_os = "linux")]
    Systemctl,
    #[cfg(target_os = "macos")]
    Launchctl,
}

#[cfg(windows)]
const ELEVATED_TIMEOUT_SECS: u64 = 60;

impl ElevatedProgram {
    #[cfg(windows)]
    fn exe_name(self) -> &'static str {
        match self {
            Self::Sc => "sc.exe",
            Self::Schtasks => "schtasks.exe",
            Self::Reg => "reg.exe",
            Self::Regsvr32 => "regsvr32.exe",
        }
    }

    #[cfg(target_os = "linux")]
    fn path(self) -> &'static str {
        match self {
            // usrmerge 배포판은 /bin 이 /usr/bin 링크라 /usr/bin 하나로 충분하다.
            Self::Systemctl => "/usr/bin/systemctl",
        }
    }

    #[cfg(target_os = "macos")]
    fn path(self) -> &'static str {
        match self {
            Self::Launchctl => "/bin/launchctl",
        }
    }
}

/// 승격 실행. 사용자가 권한 요청을 거절하면 `Cancelled`, 프로그램이 0 아닌 코드로 끝나면 `Io`.
pub(crate) async fn run_elevated(program: ElevatedProgram, args: &[String]) -> Result<(), IpcError> {
    for a in args {
        validate_arg(a)?;
    }
    imp::run(program, args).await
}

fn validate_arg(arg: &str) -> Result<(), IpcError> {
    let bad = if cfg!(target_os = "macos") {
        !arg.chars().all(|c| c.is_ascii_alphanumeric() || "._/:@-".contains(c)) || arg.is_empty()
    } else {
        // `"`는 Windows 명령줄 따옴표 규칙을 깨는 유일한 문자다(CommandLineToArgvW). 줄바꿈·NUL은 어디서도 정상 인자가 아니다.
        arg.contains(['"', '\0', '\r', '\n'])
    };
    if bad {
        return Err(IpcError::new(ErrorCode::Io, text_pccare::elevate_bad_arg(arg)));
    }
    Ok(())
}

/// Windows 명령줄 한 인자 — 공백이 있거나 비면 따옴표로 감싸고, 닫는 따옴표 앞의 역슬래시는 두 배로 한다.
/// `"`는 `validate_arg`가 이미 막았다.
#[cfg_attr(not(windows), allow(dead_code))]
fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t']) {
        return arg.to_string();
    }
    let trailing = arg.len() - arg.trim_end_matches('\\').len();
    format!("\"{arg}{}\"", "\\".repeat(trailing))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_command_line(args: &[String]) -> String {
    args.iter().map(|a| quote_windows_arg(a)).collect::<Vec<_>>().join(" ")
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, TerminateProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use super::{windows_command_line, ElevatedProgram, ELEVATED_TIMEOUT_SECS};
    use crate::error::{ErrorCode, IpcError};
    use crate::i18n::text_pccare;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub(super) async fn run(program: ElevatedProgram, args: &[String]) -> Result<(), IpcError> {
        // %SystemRoot%\System32 의 절대경로 — PATH 탐색에 맡기면 작업 폴더의 같은 이름 실행 파일이 이긴다.
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let exe: PathBuf = PathBuf::from(root).join("System32").join(program.exe_name());
        let params = windows_command_line(args);
        let name = program.exe_name();
        tokio::task::spawn_blocking(move || run_blocking(&exe, &params, name))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text_pccare::elevate_spawn_failed(name, e)))?
    }

    fn run_blocking(exe: &std::path::Path, params: &str, name: &'static str) -> Result<(), IpcError> {
        let verb = wide("runas".as_ref());
        let file = wide(exe.as_os_str());
        let params = wide(params.as_ref());
        // SAFETY: 구조체는 전부 0으로 시작해 필요한 필드만 채운다(Win32 관례). 문자열 버퍼는 호출이 끝날 때까지 산다.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_HIDE;
        // SAFETY: info 는 위에서 유효하게 채웠다.
        if unsafe { ShellExecuteExW(&mut info) } == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_CANCELLED {
                return Err(IpcError::new(ErrorCode::Cancelled, text_pccare::elevate_cancelled()));
            }
            return Err(IpcError::new(
                ErrorCode::Io,
                text_pccare::elevate_spawn_failed(name, std::io::Error::from_raw_os_error(err as i32)),
            ));
        }
        let process = info.hProcess;
        if process.is_null() {
            // 다른 프로세스에 넘겨진 실행(DDE 등) — 시스템 콘솔 프로그램에선 생기지 않지만 결과를 알 수 없으니 실패로 둔다.
            return Err(IpcError::new(ErrorCode::Io, text_pccare::elevate_exit_code(name, -1)));
        }
        // SAFETY: process 는 SEE_MASK_NOCLOSEPROCESS 로 받은 유효 핸들이고 아래에서 한 번만 닫는다.
        let waited = unsafe { WaitForSingleObject(process, (ELEVATED_TIMEOUT_SECS * 1000) as u32) };
        let result = if waited != WAIT_OBJECT_0 {
            unsafe { TerminateProcess(process, 1) };
            Err(IpcError::new(ErrorCode::Timeout, text_pccare::elevate_timed_out(name, ELEVATED_TIMEOUT_SECS)))
        } else {
            let mut code: u32 = 0;
            unsafe { GetExitCodeProcess(process, &mut code) };
            if code == 0 {
                Ok(())
            } else {
                Err(IpcError::new(ErrorCode::Io, text_pccare::elevate_exit_code(name, code as i64)))
            }
        };
        unsafe { CloseHandle(process) };
        result
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::ElevatedProgram;
    use crate::error::{ErrorCode, IpcError};
    use crate::i18n::text_pccare;

    pub(super) async fn run(program: ElevatedProgram, args: &[String]) -> Result<(), IpcError> {
        let status = tokio::process::Command::new("pkexec")
            .arg(program.path())
            .args(args)
            .stdin(std::process::Stdio::null())
            .status()
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => {
                    IpcError::new(ErrorCode::ToolNotFound, text_pccare::elevate_pkexec_missing())
                }
                _ => IpcError::new(ErrorCode::Io, text_pccare::elevate_spawn_failed("pkexec", e)),
            })?;
        match status.code() {
            Some(0) => Ok(()),
            // pkexec: 126 = 인증 창을 닫음, 127 = 인증 실패/권한 없음.
            Some(126) | Some(127) => Err(IpcError::new(ErrorCode::Cancelled, text_pccare::elevate_cancelled())),
            other => Err(IpcError::new(
                ErrorCode::Io,
                text_pccare::elevate_exit_code(program.path(), other.map(i64::from).unwrap_or(-1)),
            )),
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ElevatedProgram;
    use crate::error::{ErrorCode, IpcError};
    use crate::i18n::text_pccare;

    pub(super) async fn run(program: ElevatedProgram, args: &[String]) -> Result<(), IpcError> {
        // 인자는 validate_arg 가 [A-Za-z0-9._/:@-] 로 제한했다 — 작은따옴표로 감싸면 셸이 해석할 것이 없고,
        // AppleScript 문자열 리터럴을 깨는 `"`·`\`도 없다.
        let mut line = format!("'{}'", program.path());
        for a in args {
            line.push_str(&format!(" '{a}'"));
        }
        let script = format!("do shell script \"{line}\" with administrator privileges");
        let out = tokio::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text_pccare::elevate_spawn_failed("osascript", e)))?;
        if out.status.success() {
            return Ok(());
        }
        // 사용자가 암호 창을 취소하면 AppleScript 오류 -128.
        if String::from_utf8_lossy(&out.stderr).contains("-128") {
            return Err(IpcError::new(ErrorCode::Cancelled, text_pccare::elevate_cancelled()));
        }
        Err(IpcError::new(
            ErrorCode::Io,
            text_pccare::elevate_exit_code(program.path(), out.status.code().map(i64::from).unwrap_or(-1)),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_elevate_windows_quoting_keeps_argv_boundaries() {
        assert_eq!(quote_windows_arg("stop"), "stop");
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(quote_windows_arg("My Service"), "\"My Service\"");
        // 닫는 따옴표 앞의 역슬래시는 두 배 — 안 하면 `\"`가 따옴표 이스케이프로 읽혀 다음 인자와 붙는다.
        assert_eq!(quote_windows_arg("C:\\Program Files\\"), "\"C:\\Program Files\\\\\"");
        assert_eq!(
            windows_command_line(&["config".into(), "a b".into(), "start=".into(), "auto".into()]),
            "config \"a b\" start= auto"
        );
    }

    #[test]
    fn pccare_elevate_rejects_quote_and_control_chars() {
        assert!(validate_arg("x\" & calc").is_err());
        assert!(validate_arg("a\nb").is_err());
        assert!(validate_arg("a\0b").is_err());
        assert!(validate_arg("Spooler").is_ok());
        if cfg!(target_os = "macos") {
            assert!(validate_arg("a b").is_err());
            assert!(validate_arg("$(id)").is_err());
            assert!(validate_arg("gui/501/com.example.agent").is_ok());
        }
    }
}
