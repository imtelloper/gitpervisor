//! 서비스 탭 — 목록 · 시작/중지/다시 시작 · 시작 유형(DOCS/pc-care-design.md §4.6).
//! Windows = SCM, Linux = systemctl, macOS = `launchctl list`(목록만).

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare_services as text;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceState {
    Running,
    Stopped,
    StartPending,
    StopPending,
    Paused,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStartType {
    Auto,
    AutoDelayed,
    Manual,
    Disabled,
    Boot,
    System,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    name: String,
    display_name: String,
    description: Option<String>,
    state: ServiceState,
    start_type: ServiceStartType,
    pid: Option<u32>,
    binary_path: Option<String>,
    is_microsoft: bool,
    can_stop: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicesList {
    services: Vec<ServiceInfo>,
    /// includeMicrosoft=false 로 뺀 개수 — "N개 숨김"을 보여 빈 목록이 고장처럼 보이지 않게 한다.
    hidden_microsoft: usize,
    /// Microsoft 판정이 의미 있는 OS(Windows)인가 — 아니면 프런트가 체크박스를 숨긴다.
    filters_microsoft: bool,
    control_supported: bool,
    unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStartTypeChoice {
    Auto,
    Manual,
    Disabled,
}

#[tauri::command(async)]
pub async fn services_list(include_microsoft: bool) -> Result<ServicesList, IpcError> {
    let all = imp::list().await?;
    let total = all.len();
    let mut services: Vec<ServiceInfo> =
        all.into_iter().filter(|s| include_microsoft || !s.is_microsoft).collect();
    let hidden_microsoft = total - services.len();
    services.sort_by_cached_key(|s| s.display_name.to_lowercase());
    #[cfg(target_os = "macos")]
    let unsupported_reason = Some(text::services_control_unsupported_macos().to_string());
    #[cfg(not(target_os = "macos"))]
    let unsupported_reason = None;
    Ok(ServicesList {
        services,
        hidden_microsoft,
        filters_microsoft: cfg!(windows),
        control_supported: cfg!(not(target_os = "macos")),
        unsupported_reason,
    })
}

#[tauri::command(async)]
pub async fn service_control(name: String, action: ServiceAction, elevate: bool) -> Result<(), IpcError> {
    check_name(&name, elevate)?;
    imp::control(name, action, elevate).await
}

#[tauri::command(async)]
pub async fn service_set_start_type(
    name: String,
    start_type: ServiceStartTypeChoice,
    elevate: bool,
) -> Result<(), IpcError> {
    check_name(&name, elevate)?;
    imp::set_start_type(name, start_type, elevate).await
}

fn check_name(name: &str, elevate: bool) -> Result<(), IpcError> {
    if is_valid_service_name(name, elevate) {
        Ok(())
    } else {
        Err(IpcError::new(ErrorCode::Io, text::service_bad_name(name)))
    }
}

/// Linux: 승격과 무관하게 systemctl 인자로 가므로 systemd 유닛 이름 문자 집합(`\x2d` 이스케이프 포함) +
/// `.service` 만 — `reboot.target`·`*.mount` 같은 다른 유닛을 이 탭으로 건드리지 못하게. 앞 `-`는 옵션으로 읽힌다.
/// Windows: 직접 경로는 OpenServiceW 에 넓은 문자열로 가서 명령줄이 없으니 길이·제어 문자만 본다. 승격(sc.exe 명령줄)일
/// 때만 실제 이름에 있는 문자로 좁힌다(`MSSQL$SQLEXPRESS`, `Intel(R) TPM Provisioning Service`) — 셸을 거치지 않고
/// (ShellExecuteExW) 공백은 elevate 가 따옴표로 감싼다. macOS 는 제어 자체가 Unsupported 다.
fn is_valid_service_name(name: &str, elevate: bool) -> bool {
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return false;
    }
    if cfg!(target_os = "linux") {
        !name.starts_with('-')
            && name.ends_with(".service")
            && name.chars().all(|c| c.is_ascii_alphanumeric() || r":_.\@-".contains(c))
    } else if cfg!(windows) && elevate {
        !name.starts_with('-')
            && name.trim() == name
            && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.@-$ ()+,".contains(c))
    } else {
        true
    }
}

/// SCM 의 ImagePath(따옴표·인자·커널 표기 섞임)에서 실행 파일 경로만 꺼낸다. 환경 변수는 펼치지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
fn service_exe_from_binary_path(raw: &str) -> Option<String> {
    let s = raw.trim();
    let s = s.strip_prefix(r"\??\").unwrap_or(s);
    let path = if let Some(rest) = s.strip_prefix('"') {
        rest.split('"').next().unwrap_or(rest)
    } else {
        // 따옴표 없는 `C:\Program Files\X\y.exe -k` — 공백으로 자르면 `C:\Program`이 된다. `.exe` 뒤 경계로 자른다.
        let lower = s.to_ascii_lowercase();
        lower
            .match_indices(".exe")
            .map(|(i, _)| i + 4)
            .find(|&end| end == s.len() || s[end..].starts_with(char::is_whitespace))
            .map(|end| &s[..end])
            .unwrap_or_else(|| s.split_whitespace().next().unwrap_or(""))
    };
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let lower = path.to_ascii_lowercase();
    // `\SystemRoot\…`·`System32\…`는 커널(드라이버 로더) 표기 — 사용자 모드 경로로 바꿔야 파일을 연다.
    if lower.starts_with(r"\systemroot\") {
        Some(format!("%SystemRoot%\\{}", &path[r"\systemroot\".len()..]))
    } else if lower.starts_with(r"system32\") {
        Some(format!("%SystemRoot%\\{path}"))
    } else {
        Some(path.to_string())
    }
}

/// `%NAME%`을 lookup 값으로 펼친다. 모르는 변수는 그대로 둔다(ExpandEnvironmentStrings 와 같은 규칙).
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_env_vars(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%').and_then(|end| lookup(&after[..end]).map(|v| (end, v))) {
            Some((end, v)) => {
                out.push_str(&v);
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

// ─────────────────────────── Linux: systemctl JSON ───────────────────────────

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Deserialize)]
struct SystemdUnit {
    unit: String,
    load: String,
    active: String,
    description: Option<String>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Deserialize)]
struct SystemdUnitFile {
    unit_file: String,
    state: String,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn systemd_state(active: &str) -> ServiceState {
    match active {
        // oneshot 의 active(exited)도 systemd 기준으론 활성이다 — 중지하면 비활성으로 돌아간다.
        "active" | "reloading" => ServiceState::Running,
        "inactive" | "failed" => ServiceState::Stopped,
        "activating" => ServiceState::StartPending,
        "deactivating" => ServiceState::StopPending,
        _ => ServiceState::Unknown,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn systemd_start_type(file_state: &str) -> ServiceStartType {
    match file_state {
        "enabled" | "enabled-runtime" | "alias" => ServiceStartType::Auto,
        // static·indirect 는 의존으로만 켜진다 — 사용자 입장에선 수동.
        "disabled" | "static" | "indirect" | "generated" | "transient" => ServiceStartType::Manual,
        "masked" | "masked-runtime" => ServiceStartType::Disabled,
        _ => ServiceStartType::Unknown,
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_systemctl(units: &str, files: &str) -> Result<Vec<ServiceInfo>, serde_json::Error> {
    let units: Vec<SystemdUnit> = serde_json::from_str(units)?;
    let files: Vec<SystemdUnitFile> = serde_json::from_str(files)?;
    let file_state: std::collections::HashMap<&str, &str> =
        files.iter().map(|f| (f.unit_file.as_str(), f.state.as_str())).collect();
    Ok(units
        .into_iter()
        // 다른 유닛이 참조만 하고 파일은 없는 것 — 제어할 대상이 아니다.
        .filter(|u| u.load != "not-found")
        .map(|u| {
            // 인스턴스(`getty@tty1.service`)의 시작 유형은 템플릿(`getty@.service`) 파일에 있다.
            let template = u.unit.split_once('@').map(|(head, _)| format!("{head}@.service"));
            let start = file_state
                .get(u.unit.as_str())
                .or_else(|| template.as_deref().and_then(|t| file_state.get(t)))
                .map_or(ServiceStartType::Unknown, |s| systemd_start_type(s));
            let state = systemd_state(&u.active);
            let display_name = u.description.filter(|d| !d.is_empty()).unwrap_or_else(|| u.unit.clone());
            ServiceInfo {
                name: u.unit,
                display_name,
                description: None,
                state,
                start_type: start,
                pid: None,
                binary_path: None,
                is_microsoft: false,
                can_stop: state == ServiceState::Running,
            }
        })
        .collect())
}

/// systemctl 거부 문구(polkit) — 이 둘이면 승격으로 다시 시도할 수 있다.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn systemctl_denied(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("access denied") || s.contains("interactive authentication required")
}

// ─────────────────────────── macOS: launchctl list ───────────────────────────

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_launchctl_list(out: &str) -> Vec<ServiceInfo> {
    out.lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let pid = cols.next()?.trim();
            let _status = cols.next()?;
            let label = cols.next()?.trim();
            if label.is_empty() || label == "Label" {
                return None;
            }
            let pid = pid.parse::<u32>().ok();
            Some(ServiceInfo {
                name: label.to_string(),
                display_name: label.to_string(),
                description: None,
                state: if pid.is_some() { ServiceState::Running } else { ServiceState::Stopped },
                start_type: ServiceStartType::Unknown,
                pid,
                binary_path: None,
                is_microsoft: false,
                can_stop: false,
            })
        })
        .collect()
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_ACCESS_DENIED, ERROR_DEPENDENT_SERVICES_RUNNING, ERROR_INSUFFICIENT_BUFFER,
        ERROR_MORE_DATA, ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_DISABLED, ERROR_SERVICE_DOES_NOT_EXIST,
        ERROR_SERVICE_NOT_ACTIVE,
    };
    use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
    use windows_sys::Win32::System::Services::{
        ChangeServiceConfig2W, ChangeServiceConfigW, CloseServiceHandle, ControlService, EnumServicesStatusExW, OpenSCManagerW,
        OpenServiceW, QueryServiceConfig2W, QueryServiceConfigW, QueryServiceStatus, StartServiceW,
        ENUM_SERVICE_STATUS_PROCESSW, QUERY_SERVICE_CONFIGW, SC_ENUM_PROCESS_INFO, SC_HANDLE,
        SC_MANAGER_CONNECT, SC_MANAGER_ENUMERATE_SERVICE, SERVICE_ACCEPT_STOP, SERVICE_AUTO_START,
        SERVICE_BOOT_START, SERVICE_CHANGE_CONFIG, SERVICE_CONFIG_DELAYED_AUTO_START_INFO,
        SERVICE_CONFIG_DESCRIPTION, SERVICE_CONTINUE_PENDING, SERVICE_CONTROL_STOP,
        SERVICE_DELAYED_AUTO_START_INFO, SERVICE_DEMAND_START, SERVICE_DESCRIPTIONW, SERVICE_DISABLED,
        SERVICE_NO_CHANGE, SERVICE_PAUSED, SERVICE_PAUSE_PENDING, SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS,
        SERVICE_RUNNING, SERVICE_START, SERVICE_START_PENDING, SERVICE_STATE_ALL, SERVICE_STATUS,
        SERVICE_STOP, SERVICE_STOPPED, SERVICE_STOP_PENDING, SERVICE_SYSTEM_START, SERVICE_WIN32,
    };

    use super::{
        expand_env_vars, service_exe_from_binary_path, text, ServiceAction, ServiceInfo, ServiceStartType,
        ServiceStartTypeChoice, ServiceState,
    };
    use crate::error::{ErrorCode, IpcError};
    use crate::pc_care::elevate::{run_elevated, ElevatedProgram};

    /// 다시 시작에서 중지를 기다리는 한도. 대부분 1~2초, 느린 서비스(SQL·VM)가 10초대다.
    const WAIT_SECS: u64 = 20;

    struct Handle(SC_HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: Open* 가 돌려준 null 아닌 핸들만 Handle 로 감싼다.
            unsafe { CloseServiceHandle(self.0) };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// SAFETY: p 는 null 이거나 NUL 로 끝나는 UTF-16 문자열이어야 한다.
    unsafe fn from_wide_ptr(p: *const u16) -> Option<String> {
        if p.is_null() {
            return None;
        }
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, len)))
    }

    fn last_error() -> u32 {
        unsafe { GetLastError() }
    }

    fn os_err(code: u32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code as i32)
    }

    fn map_err(name: &str, e: u32) -> IpcError {
        match e {
            ERROR_ACCESS_DENIED => IpcError::new(ErrorCode::PermissionDenied, text::service_access_denied(name)),
            ERROR_SERVICE_DOES_NOT_EXIST => IpcError::new(ErrorCode::NotFound, text::service_not_found(name)),
            ERROR_DEPENDENT_SERVICES_RUNNING => {
                IpcError::new(ErrorCode::Io, text::service_dependents_running(name))
            }
            ERROR_SERVICE_DISABLED => IpcError::new(ErrorCode::Io, text::service_is_disabled(name)),
            _ => IpcError::new(ErrorCode::Io, text::service_op_failed(name, os_err(e))),
        }
    }

    fn open_scm(access: u32) -> Result<Handle, IpcError> {
        // SAFETY: null 머신·DB 이름 = 로컬 기본 SCM.
        let h = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), access) };
        if h.is_null() {
            return Err(IpcError::new(ErrorCode::Io, text::services_scm_open_failed(os_err(last_error()))));
        }
        Ok(Handle(h))
    }

    fn open_service(scm: &Handle, name: &str, access: u32) -> Result<Handle, IpcError> {
        let w = wide(name);
        // SAFETY: scm 은 열린 핸들, w 는 NUL 로 끝난다.
        let h = unsafe { OpenServiceW(scm.0, w.as_ptr(), access) };
        if h.is_null() {
            return Err(map_err(name, last_error()));
        }
        Ok(Handle(h))
    }

    async fn blocking<T: Send + 'static>(
        f: impl FnOnce() -> Result<T, IpcError> + Send + 'static,
    ) -> Result<T, IpcError> {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::services_task_failed(e)))?
    }

    // ── 목록 ──

    pub(super) async fn list() -> Result<Vec<ServiceInfo>, IpcError> {
        blocking(list_blocking).await
    }

    fn list_blocking() -> Result<Vec<ServiceInfo>, IpcError> {
        let scm = open_scm(SC_MANAGER_CONNECT | SC_MANAGER_ENUMERATE_SERVICE)?;
        let mut out = Vec::new();
        let mut resume = 0u32;
        // u64 버퍼 = 8바이트 정렬 — 안의 구조체(포인터 포함)를 그 자리에서 읽는다.
        let mut buf: Vec<u64> = vec![0; 64 * 1024 / 8];
        loop {
            let mut needed = 0u32;
            let mut count = 0u32;
            // SAFETY: buf 크기를 바이트로 정확히 넘긴다. resume 핸들로 나눠 받는다(ERROR_MORE_DATA).
            let ok = unsafe {
                EnumServicesStatusExW(
                    scm.0,
                    SC_ENUM_PROCESS_INFO,
                    SERVICE_WIN32,
                    SERVICE_STATE_ALL,
                    buf.as_mut_ptr().cast(),
                    (buf.len() * 8) as u32,
                    &mut needed,
                    &mut count,
                    &mut resume,
                    std::ptr::null(),
                )
            } != 0;
            let err = if ok { 0 } else { last_error() };
            if !ok && err != ERROR_MORE_DATA {
                return Err(IpcError::new(ErrorCode::Io, text::services_enum_failed(os_err(err))));
            }
            // SAFETY: 성공(또는 MORE_DATA)이면 버퍼 앞에 count 개의 항목이 있고, 문자열은 같은 버퍼 안을 가리킨다.
            let entries =
                unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>(), count as usize) };
            out.extend(entries.iter().map(|e| read_entry(&scm, e)));
            if ok {
                break;
            }
            if count == 0 {
                // 한 항목도 못 담았다 — 키우지 않으면 같은 호출을 영원히 반복한다.
                let want = (needed as usize).div_ceil(8).max(buf.len() * 2);
                buf = vec![0; want];
            }
        }
        Ok(out)
    }

    fn map_state(s: u32) -> ServiceState {
        match s {
            SERVICE_RUNNING => ServiceState::Running,
            SERVICE_STOPPED => ServiceState::Stopped,
            SERVICE_START_PENDING | SERVICE_CONTINUE_PENDING => ServiceState::StartPending,
            SERVICE_STOP_PENDING => ServiceState::StopPending,
            SERVICE_PAUSED | SERVICE_PAUSE_PENDING => ServiceState::Paused,
            _ => ServiceState::Unknown,
        }
    }

    fn read_entry(scm: &Handle, e: &ENUM_SERVICE_STATUS_PROCESSW) -> ServiceInfo {
        // SAFETY: SCM 이 채운 NUL 종료 문자열.
        let name = unsafe { from_wide_ptr(e.lpServiceName) }.unwrap_or_default();
        let display_name = unsafe { from_wide_ptr(e.lpDisplayName) }
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| name.clone());
        let st = e.ServiceStatusProcess;
        let state = map_state(st.dwCurrentState);
        let (start_type, binary_path, description) = read_config(scm, &name);
        let is_microsoft = binary_path
            .as_deref()
            .and_then(service_exe_from_binary_path)
            .map(|p| expand_env_vars(&p, |k| std::env::var(k).ok()))
            .is_some_and(|p| is_microsoft_exe(&p));
        ServiceInfo {
            name,
            display_name,
            description,
            state,
            start_type,
            pid: (st.dwProcessId != 0).then_some(st.dwProcessId),
            binary_path,
            is_microsoft,
            can_stop: state == ServiceState::Running && st.dwControlsAccepted & SERVICE_ACCEPT_STOP != 0,
        }
    }

    /// 크기 탐색 → 할당 → 다시 호출. 실패는 None — 일부 서비스는 비관리자에게 설정 조회를 막아 두는데,
    /// 그건 목록 전체의 실패가 아니라 그 칸이 비는 것이다.
    fn query_buf(f: impl Fn(*mut u8, u32, &mut u32) -> i32) -> Option<Vec<u64>> {
        let mut needed = 0u32;
        if f(std::ptr::null_mut(), 0, &mut needed) == 0 {
            let e = last_error();
            if e != ERROR_INSUFFICIENT_BUFFER && e != ERROR_MORE_DATA {
                return None;
            }
        }
        let mut buf = vec![0u64; (needed as usize).div_ceil(8).max(1)];
        let size = (buf.len() * 8) as u32;
        if f(buf.as_mut_ptr().cast(), size, &mut needed) == 0 {
            return None;
        }
        Some(buf)
    }

    /// svc 는 SERVICE_QUERY_CONFIG 로 열려 있어야 한다. 조회 실패는 None(모름).
    fn is_delayed(svc: &Handle) -> Option<bool> {
        let h = svc.0;
        // SAFETY: 버퍼는 query_buf 가 크기를 맞춰 할당했다.
        query_buf(|p, n, need| unsafe { QueryServiceConfig2W(h, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, p, n, need) })
            .map(|buf| unsafe { (*buf.as_ptr().cast::<SERVICE_DELAYED_AUTO_START_INFO>()).fDelayedAutostart != 0 })
    }

    fn read_config(scm: &Handle, name: &str) -> (ServiceStartType, Option<String>, Option<String>) {
        let Ok(svc) = open_service(scm, name, SERVICE_QUERY_CONFIG) else {
            // 조회 거부(보호된 서비스) — 칸을 비워 보인다. 목록 자체는 계속.
            return (ServiceStartType::Unknown, None, None);
        };
        let h = svc.0;
        // SAFETY(아래 세 블록): 버퍼는 query_buf 가 크기를 맞춰 할당했고, 안의 포인터는 같은 버퍼를 가리킨다.
        let cfg = query_buf(|p, n, need| unsafe { QueryServiceConfigW(h, p.cast(), n, need) });
        let (mut start_type, binary_path) = match &cfg {
            Some(buf) => {
                let c = unsafe { &*buf.as_ptr().cast::<QUERY_SERVICE_CONFIGW>() };
                let t = match c.dwStartType {
                    SERVICE_AUTO_START => ServiceStartType::Auto,
                    SERVICE_DEMAND_START => ServiceStartType::Manual,
                    SERVICE_DISABLED => ServiceStartType::Disabled,
                    SERVICE_BOOT_START => ServiceStartType::Boot,
                    SERVICE_SYSTEM_START => ServiceStartType::System,
                    _ => ServiceStartType::Unknown,
                };
                (t, unsafe { from_wide_ptr(c.lpBinaryPathName) }.filter(|s| !s.is_empty()))
            }
            None => (ServiceStartType::Unknown, None),
        };
        if start_type == ServiceStartType::Auto && is_delayed(&svc) == Some(true) {
            start_type = ServiceStartType::AutoDelayed;
        }
        if let Some(d) = DESCRIPTIONS.lock().unwrap_or_else(|e| e.into_inner()).get(name) {
            return (start_type, binary_path, d.clone());
        }
        let description = query_buf(|p, n, need| unsafe {
            QueryServiceConfig2W(h, SERVICE_CONFIG_DESCRIPTION, p, n, need)
        })
        .and_then(|buf| unsafe { from_wide_ptr((*buf.as_ptr().cast::<SERVICE_DESCRIPTIONW>()).lpDescription) })
        // 풀리지 않은 `@%SystemRoot%\…dll,-101` 리소스 참조는 보여 봐야 뜻이 없다.
        .filter(|d| !d.is_empty() && !d.starts_with('@'));
        DESCRIPTIONS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_string(), description.clone());
        (start_type, binary_path, description)
    }

    /// 설명 조회는 SCM 이 MUI 리소스 문자열을 DLL 에서 풀어 오느라 목록 시간의 대부분을 쓴다(실측 362개, 디버그 빌드: 매번 읽기 643ms → 캐시 후 170~220ms).
    /// 설명은 설치 때 정해져 바뀌지 않으니 이름별로 한 번만 읽는다 — 5초 폴링이 매번 수백 개를 다시 풀지 않게.
    static DESCRIPTIONS: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(Default::default);

    /// 실행 파일 경로(소문자) → CompanyName 이 Microsoft 로 시작하는가. svchost 호스팅 서비스는 이미지가
    /// System32\svchost.exe 라 그대로 Microsoft 로 판정된다. 5초 폴링마다 수백 개를 다시 읽지 않게 경로별로 기억한다.
    static MICROSOFT_EXE: LazyLock<Mutex<HashMap<String, bool>>> = LazyLock::new(Default::default);

    fn is_microsoft_exe(path: &str) -> bool {
        let key = path.to_lowercase();
        if let Some(&v) = MICROSOFT_EXE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return v;
        }
        let v = company_name(path).is_some_and(|c| c.starts_with("Microsoft"));
        MICROSOFT_EXE.lock().unwrap_or_else(|e| e.into_inner()).insert(key, v);
        v
    }

    fn company_name(path: &str) -> Option<String> {
        let w = wide(path);
        let mut handle = 0u32;
        // SAFETY: w 는 NUL 로 끝나는 경로.
        let size = unsafe { GetFileVersionInfoSizeW(w.as_ptr(), &mut handle) };
        if size == 0 {
            return None;
        }
        let mut data = vec![0u64; (size as usize).div_ceil(8)];
        // SAFETY: data 는 size 바이트 이상.
        if unsafe { GetFileVersionInfoW(w.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
            return None;
        }
        let query = |sub: &str| -> Option<(*const u16, usize)> {
            let key = wide(sub);
            let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut len = 0u32;
            // SAFETY: data 는 GetFileVersionInfoW 가 채운 블록, 결과 포인터는 그 안을 가리킨다.
            let ok = unsafe { VerQueryValueW(data.as_ptr().cast(), key.as_ptr(), &mut p, &mut len) } != 0;
            (ok && !p.is_null() && len > 0).then_some((p.cast_const().cast::<u16>(), len as usize))
        };
        let mut langs: Vec<(u16, u16)> = Vec::new();
        if let Some((p, bytes)) = query(r"\VarFileInfo\Translation") {
            // SAFETY: Translation 은 (언어 u16, 코드페이지 u16) 쌍의 배열, len 은 바이트 수.
            let words = unsafe { std::slice::from_raw_parts(p, bytes / 2) };
            langs.extend(words.chunks_exact(2).map(|c| (c[0], c[1])));
        }
        // Translation 이 없거나 틀린 파일이 있다 — 흔한 영어(유니코드/1252) 블록을 마지막으로 본다.
        langs.extend([(0x0409, 0x04B0), (0x0409, 0x04E4)]);
        langs.into_iter().find_map(|(l, cp)| {
            let (p, chars) = query(&format!(r"\StringFileInfo\{l:04x}{cp:04x}\CompanyName"))?;
            // SAFETY: 문자열 값의 len 은 UTF-16 글자 수(종료 NUL 포함).
            let s = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(p, chars) });
            let s = s.trim_end_matches('\0').trim().to_string();
            (!s.is_empty()).then_some(s)
        })
    }

    // ── 제어 ──

    fn query_status(svc: &Handle) -> Option<SERVICE_STATUS> {
        // SAFETY: SERVICE_STATUS 는 POD, 0 초기화 후 SCM 이 채운다.
        let mut st: SERVICE_STATUS = unsafe { std::mem::zeroed() };
        (unsafe { QueryServiceStatus(svc.0, &mut st) } != 0).then_some(st)
    }

    fn query_state(svc: &Handle) -> Option<u32> {
        query_status(svc).map(|st| st.dwCurrentState)
    }

    /// 목록은 SERVICE_WIN32 만 보인다 — 이름을 직접 넘겨 커널 드라이버(같은 SCM 이름 공간)를 멈추지 못하게
    /// 제어 전에 같은 기준으로 다시 거른다. 상태 조회 권한은 비관리자도 있어 승격 전 검사에도 쓴다.
    fn open_win32_service(scm: &Handle, name: &str, access: u32) -> Result<Handle, IpcError> {
        let svc = open_service(scm, name, access | SERVICE_QUERY_STATUS)?;
        let st = query_status(&svc).ok_or_else(|| map_err(name, last_error()))?;
        if st.dwServiceType & SERVICE_WIN32 == 0 {
            return Err(IpcError::new(ErrorCode::NotFound, text::service_not_win32(name)));
        }
        Ok(svc)
    }

    async fn ensure_win32_service(name: &str) -> Result<(), IpcError> {
        let n = name.to_string();
        blocking(move || {
            let scm = open_scm(SC_MANAGER_CONNECT)?;
            open_win32_service(&scm, &n, 0).map(drop)
        })
        .await
    }

    /// target 이 될 때까지(최대 WAIT_SECS) 기다린 뒤 마지막 상태를 돌려준다. 시작을 기다리다 STOPPED 로
    /// 돌아오면 바로 멈춘다 — 그건 "아직"이 아니라 시작 실패다.
    fn wait_for(svc: &Handle, target: u32) -> Option<u32> {
        let deadline = Instant::now() + Duration::from_secs(WAIT_SECS);
        loop {
            let s = query_state(svc)?;
            if s == target || (target == SERVICE_RUNNING && s == SERVICE_STOPPED) || Instant::now() >= deadline {
                return Some(s);
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    pub(super) async fn control(name: String, action: ServiceAction, elevate: bool) -> Result<(), IpcError> {
        if elevate {
            return control_elevated(name, action).await;
        }
        blocking(move || control_direct(&name, action)).await
    }

    fn control_direct(name: &str, action: ServiceAction) -> Result<(), IpcError> {
        let scm = open_scm(SC_MANAGER_CONNECT)?;
        let access = match action {
            ServiceAction::Start => SERVICE_START,
            ServiceAction::Stop => SERVICE_STOP,
            ServiceAction::Restart => SERVICE_START | SERVICE_STOP,
        };
        let svc = open_win32_service(&scm, name, access)?;
        if matches!(action, ServiceAction::Stop | ServiceAction::Restart) {
            // SAFETY: SERVICE_STATUS 는 POD.
            let mut st: SERVICE_STATUS = unsafe { std::mem::zeroed() };
            if unsafe { ControlService(svc.0, SERVICE_CONTROL_STOP, &mut st) } == 0 {
                let e = last_error();
                if e != ERROR_SERVICE_NOT_ACTIVE {
                    return Err(map_err(name, e));
                }
            }
            let stopped = wait_for(&svc, SERVICE_STOPPED) == Some(SERVICE_STOPPED);
            if matches!(action, ServiceAction::Restart) && !stopped {
                return Err(IpcError::new(ErrorCode::Timeout, text::service_stop_timed_out(name, WAIT_SECS)));
            }
        }
        if matches!(action, ServiceAction::Start | ServiceAction::Restart) {
            // SAFETY: 인자 없이 시작.
            if unsafe { StartServiceW(svc.0, 0, std::ptr::null()) } == 0 {
                let e = last_error();
                if e != ERROR_SERVICE_ALREADY_RUNNING {
                    return Err(map_err(name, e));
                }
            }
            if wait_for(&svc, SERVICE_RUNNING) == Some(SERVICE_STOPPED) {
                return Err(IpcError::new(ErrorCode::Io, text::service_stopped_after_start(name)));
            }
        }
        Ok(())
    }

    async fn sc(args: &[&str]) -> Result<(), IpcError> {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        run_elevated(ElevatedProgram::Sc, &args).await
    }

    async fn control_elevated(name: String, action: ServiceAction) -> Result<(), IpcError> {
        ensure_win32_service(&name).await?;
        match action {
            ServiceAction::Start => sc(&["start", &name]).await,
            ServiceAction::Stop => sc(&["stop", &name]).await,
            ServiceAction::Restart => {
                // sc.exe 에는 restart 가 없고 `sc stop`은 중지를 기다리지 않는다 — 중지가 끝나기 전의 `sc start`는
                // 1056(이미 실행 중)으로 실패한다. 상태 조회는 비관리자도 되므로 여기서 직접 기다린다.
                let n = name.clone();
                let running = blocking(move || {
                    let scm = open_scm(SC_MANAGER_CONNECT)?;
                    let svc = open_service(&scm, &n, SERVICE_QUERY_STATUS)?;
                    Ok(query_state(&svc) != Some(SERVICE_STOPPED))
                })
                .await?;
                if running {
                    sc(&["stop", &name]).await?;
                    let n = name.clone();
                    blocking(move || {
                        let scm = open_scm(SC_MANAGER_CONNECT)?;
                        let svc = open_service(&scm, &n, SERVICE_QUERY_STATUS)?;
                        match wait_for(&svc, SERVICE_STOPPED) {
                            Some(SERVICE_STOPPED) => Ok(()),
                            _ => Err(IpcError::new(ErrorCode::Timeout, text::service_stop_timed_out(&n, WAIT_SECS))),
                        }
                    })
                    .await?;
                }
                sc(&["start", &name]).await
            }
        }
    }

    pub(super) async fn set_start_type(
        name: String,
        choice: ServiceStartTypeChoice,
        elevate: bool,
    ) -> Result<(), IpcError> {
        // "자동"을 고르면 지연 시작 플래그도 끈다 — 시작 유형만 바꾸면 "자동(지연)"이 그대로 남아 아무 일도 안 한 것처럼 보인다.
        if elevate {
            ensure_win32_service(&name).await?;
            let v = match choice {
                ServiceStartTypeChoice::Auto => "auto",
                ServiceStartTypeChoice::Manual => "demand",
                ServiceStartTypeChoice::Disabled => "disabled",
            };
            sc(&["config", &name, "start=", v]).await?;
            if matches!(choice, ServiceStartTypeChoice::Auto) {
                // sc.exe 가 지연 플래그를 같이 끄는지는 버전 문서에 없다 — 남아 있을 때만 레지스트리로 끈다(두 번째 UAC).
                let n = name.clone();
                let still_delayed = blocking(move || {
                    let scm = open_scm(SC_MANAGER_CONNECT)?;
                    let svc = open_service(&scm, &n, SERVICE_QUERY_CONFIG)?;
                    Ok(is_delayed(&svc) == Some(true))
                })
                .await?;
                if still_delayed {
                    let key = format!(r"HKLM\SYSTEM\CurrentControlSet\Services\{name}");
                    let args: Vec<String> = [key.as_str(), "/v", "DelayedAutostart", "/t", "REG_DWORD", "/d", "0", "/f"]
                        .iter()
                        .map(|a| a.to_string())
                        .collect();
                    run_elevated(ElevatedProgram::Reg, &args).await?;
                }
            }
            return Ok(());
        }
        blocking(move || {
            let scm = open_scm(SC_MANAGER_CONNECT)?;
            let svc = open_win32_service(&scm, &name, SERVICE_CHANGE_CONFIG)?;
            let t = match choice {
                ServiceStartTypeChoice::Auto => SERVICE_AUTO_START,
                ServiceStartTypeChoice::Manual => SERVICE_DEMAND_START,
                ServiceStartTypeChoice::Disabled => SERVICE_DISABLED,
            };
            let null = std::ptr::null();
            // SAFETY: 바꾸지 않을 값은 SERVICE_NO_CHANGE/null.
            let ok = unsafe {
                ChangeServiceConfigW(
                    svc.0,
                    SERVICE_NO_CHANGE,
                    t,
                    SERVICE_NO_CHANGE,
                    null,
                    null,
                    std::ptr::null_mut(),
                    null,
                    null,
                    null,
                    null,
                )
            } != 0;
            if !ok {
                return Err(map_err(&name, last_error()));
            }
            if matches!(choice, ServiceStartTypeChoice::Auto) {
                let info = SERVICE_DELAYED_AUTO_START_INFO { fDelayedAutostart: 0 };
                // SAFETY: info 는 호출 동안 살아 있는 SERVICE_DELAYED_AUTO_START_INFO.
                let ok = unsafe {
                    ChangeServiceConfig2W(svc.0, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, (&info as *const SERVICE_DELAYED_AUTO_START_INFO).cast())
                } != 0;
                if !ok {
                    return Err(map_err(&name, last_error()));
                }
            }
            Ok(())
        })
        .await
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::time::Duration;

    use super::{parse_systemctl, systemctl_denied, text, ServiceAction, ServiceInfo, ServiceStartTypeChoice};
    use crate::error::{ErrorCode, IpcError};
    use crate::pc_care::elevate::{run_elevated, ElevatedProgram};

    /// start/stop 은 작업이 끝날 때까지 기다린다 — 느린 서비스도 이 안에 끝난다.
    const CONTROL_TIMEOUT_SECS: u64 = 90;

    fn systemctl() -> Result<&'static str, IpcError> {
        ["/usr/bin/systemctl", "/bin/systemctl"]
            .into_iter()
            .find(|p| std::path::Path::new(p).exists())
            .ok_or_else(|| IpcError::new(ErrorCode::ToolNotFound, text::services_systemctl_missing()))
    }

    pub(super) async fn list() -> Result<Vec<ServiceInfo>, IpcError> {
        let exe = systemctl()?;
        let capture = |args: &'static [&'static str]| async move {
            crate::sysinfo_static::run_capture(exe, args, 15)
                .await
                .map_err(|e| IpcError::new(ErrorCode::Io, e))
        };
        let units = capture(&["list-units", "--type=service", "--all", "--no-pager", "-o", "json"]).await?;
        let files = capture(&["list-unit-files", "--type=service", "--no-pager", "-o", "json"]).await?;
        parse_systemctl(&units, &files)
            .map_err(|e| IpcError::new(ErrorCode::Io, text::services_systemctl_bad_json(e)))
    }

    async fn run(verb: &str, name: &str, elevate: bool) -> Result<(), IpcError> {
        if elevate {
            return run_elevated(ElevatedProgram::Systemctl, &[verb.to_string(), name.to_string()]).await;
        }
        let exe = systemctl()?;
        // polkit 에이전트가 있으면 systemctl 이 직접 암호를 묻는다. 없거나 거부면 stderr 로 알 수 있다.
        let out = tokio::time::timeout(
            Duration::from_secs(CONTROL_TIMEOUT_SECS),
            tokio::process::Command::new(exe)
                .args([verb, name])
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| IpcError::new(ErrorCode::Timeout, text::service_op_timed_out(name, CONTROL_TIMEOUT_SECS)))?
        .map_err(|e| IpcError::new(ErrorCode::Io, text::service_op_failed(name, e)))?;
        if out.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        if systemctl_denied(&stderr) {
            return Err(IpcError::new(ErrorCode::PermissionDenied, text::service_access_denied(name)));
        }
        let head: String = stderr.trim().chars().take(200).collect();
        Err(IpcError::new(ErrorCode::Io, text::service_op_failed(name, head)))
    }

    pub(super) async fn control(name: String, action: ServiceAction, elevate: bool) -> Result<(), IpcError> {
        let verb = match action {
            ServiceAction::Start => "start",
            ServiceAction::Stop => "stop",
            ServiceAction::Restart => "restart",
        };
        run(verb, &name, elevate).await
    }

    pub(super) async fn set_start_type(
        name: String,
        choice: ServiceStartTypeChoice,
        elevate: bool,
    ) -> Result<(), IpcError> {
        let verb = match choice {
            ServiceStartTypeChoice::Auto => "enable",
            ServiceStartTypeChoice::Manual => "disable",
            ServiceStartTypeChoice::Disabled => "mask",
        };
        if !matches!(choice, ServiceStartTypeChoice::Disabled) {
            // "사용 안 함"=mask 라 되돌리려면 unmask 가 먼저다 — masked 유닛엔 enable 이 거부되고 disable 은 mask 를 남긴다.
            // 동사 둘을 한 번에 줄 수 없어 승격이면 암호를 두 번 묻는다(masked 일 때만).
            let state = crate::sysinfo_static::run_capture(systemctl()?, &["is-enabled", &name], 15)
                .await
                .map_err(|e| IpcError::new(ErrorCode::Io, text::service_op_failed(&name, e)))?;
            if state.trim().starts_with("masked") {
                run("unmask", &name, elevate).await?;
            }
        }
        run(verb, &name, elevate).await
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{parse_launchctl_list, text, ServiceAction, ServiceInfo, ServiceStartTypeChoice};
    use crate::error::{ErrorCode, IpcError};

    pub(super) async fn list() -> Result<Vec<ServiceInfo>, IpcError> {
        let out = crate::sysinfo_static::run_capture("/bin/launchctl", &["list"], 15)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, e))?;
        Ok(parse_launchctl_list(&out))
    }

    pub(super) async fn control(_name: String, _action: ServiceAction, _elevate: bool) -> Result<(), IpcError> {
        Err(IpcError::new(ErrorCode::Unsupported, text::services_control_unsupported_macos()))
    }

    pub(super) async fn set_start_type(
        _name: String,
        _choice: ServiceStartTypeChoice,
        _elevate: bool,
    ) -> Result<(), IpcError> {
        Err(IpcError::new(ErrorCode::Unsupported, text::services_control_unsupported_macos()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_services_name_charset() {
        let ok = |n: &str| is_valid_service_name(n, true) && is_valid_service_name(n, false);
        for bad in ["", "a\nb", "a\0b", &"a".repeat(257)] {
            assert!(!is_valid_service_name(bad, true) && !is_valid_service_name(bad, false), "{bad:?}");
        }
        if cfg!(target_os = "linux") {
            assert!(ok("getty@tty1.service"));
            assert!(ok(r"systemd-fsck@dev-disk-by\x2duuid-1234.service"));
            // 서비스가 아닌 유닛·옵션처럼 읽히는 이름은 승격 여부와 무관하게 막는다.
            for bad in ["reboot.target", "ssh.socket", "Spooler", "--force.service", "a b.service", "a&b.service"] {
                assert!(!is_valid_service_name(bad, false) && !is_valid_service_name(bad, true), "{bad}");
            }
        }
        if cfg!(windows) {
            for n in ["Spooler", "CDPUserSvc_3a7b1", "MSSQL$SQLEXPRESS", "Apple Mobile Device Service", "Intel(R) TPM Provisioning Service", "a+b,c"] {
                assert!(ok(n), "{n}");
            }
            // 직접 경로(OpenServiceW)는 명령줄이 없어 문자 제한이 없고, 승격(sc.exe 명령줄)만 좁힌다.
            for n in ["--force", "a\"b", "a&calc", " Spooler", "a%PATH%"] {
                assert!(is_valid_service_name(n, false) && !is_valid_service_name(n, true), "{n}");
            }
        }
    }

    #[test]
    fn pccare_services_exe_from_binary_path() {
        let f = |s: &str| service_exe_from_binary_path(s);
        assert_eq!(f(r"C:\WINDOWS\system32\svchost.exe -k netsvcs -p").as_deref(), Some(r"C:\WINDOWS\system32\svchost.exe"));
        assert_eq!(
            f(r#""C:\Program Files\Foo Bar\svc.exe" --run"#).as_deref(),
            Some(r"C:\Program Files\Foo Bar\svc.exe")
        );
        // 따옴표 없이 공백 경로 + 인자.
        assert_eq!(
            f(r"C:\Program Files\NVIDIA\nvcontainer.exe -s NvContainer").as_deref(),
            Some(r"C:\Program Files\NVIDIA\nvcontainer.exe")
        );
        // 경로 중간의 `.exe`(폴더 이름)에서 자르지 않는다.
        assert_eq!(f(r"C:\tools\app.exed\run.exe /x").as_deref(), Some(r"C:\tools\app.exed\run.exe"));
        assert_eq!(f(r"\SystemRoot\System32\drivers\x.sys").as_deref(), Some(r"%SystemRoot%\System32\drivers\x.sys"));
        assert_eq!(f(r"System32\drivers\y.sys").as_deref(), Some(r"%SystemRoot%\System32\drivers\y.sys"));
        assert_eq!(f(r"\??\C:\x\z.exe").as_deref(), Some(r"C:\x\z.exe"));
        assert_eq!(f(r"%SystemRoot%\System32\lsass.exe").as_deref(), Some(r"%SystemRoot%\System32\lsass.exe"));
        assert_eq!(f("   ").as_deref(), None);
        assert_eq!(f(r#""""#).as_deref(), None);
    }

    #[test]
    fn pccare_services_expand_env() {
        let look = |k: &str| (k.eq_ignore_ascii_case("SystemRoot")).then(|| r"C:\Windows".to_string());
        assert_eq!(expand_env_vars(r"%SystemRoot%\System32\a.exe", look), r"C:\Windows\System32\a.exe");
        assert_eq!(expand_env_vars(r"%systemroot%\b", look), r"C:\Windows\b");
        assert_eq!(expand_env_vars(r"%NOPE%\c", look), r"%NOPE%\c");
        assert_eq!(expand_env_vars("100% sure", look), "100% sure");
        assert_eq!(expand_env_vars("plain", look), "plain");
    }

    #[test]
    fn pccare_services_systemctl_json() {
        let units = r#"[
            {"unit":"ssh.service","load":"loaded","active":"active","sub":"running","description":"OpenBSD Secure Shell server"},
            {"unit":"getty@tty1.service","load":"loaded","active":"inactive","sub":"dead","description":""},
            {"unit":"ghost.service","load":"not-found","active":"inactive","sub":"dead","description":"ghost"},
            {"unit":"up.service","load":"loaded","active":"activating","sub":"start","description":"Up"}
        ]"#;
        let files = r#"[
            {"unit_file":"ssh.service","state":"enabled","preset":"enabled"},
            {"unit_file":"getty@.service","state":"static","preset":null},
            {"unit_file":"up.service","state":"masked","preset":null}
        ]"#;
        let v = parse_systemctl(units, files).unwrap();
        assert_eq!(v.len(), 2 + 1);
        assert_eq!(v[0].name, "ssh.service");
        assert_eq!(v[0].display_name, "OpenBSD Secure Shell server");
        assert_eq!(v[0].state, ServiceState::Running);
        assert_eq!(v[0].start_type, ServiceStartType::Auto);
        assert!(v[0].can_stop);
        assert_eq!(v[1].display_name, "getty@tty1.service");
        assert_eq!(v[1].state, ServiceState::Stopped);
        assert_eq!(v[1].start_type, ServiceStartType::Manual);
        assert!(!v[1].can_stop);
        assert_eq!(v[2].state, ServiceState::StartPending);
        assert_eq!(v[2].start_type, ServiceStartType::Disabled);
        assert!(parse_systemctl("not json", "[]").is_err());
    }

    #[test]
    fn pccare_services_systemctl_denied() {
        assert!(systemctl_denied("Failed to start x.service: Access denied\nSee system logs"));
        assert!(systemctl_denied("Failed to stop x.service: Interactive authentication required."));
        assert!(!systemctl_denied("Failed to start x.service: Unit x.service not found."));
    }

    #[test]
    fn pccare_services_launchctl_list() {
        let out = "PID\tStatus\tLabel\n-\t0\tcom.apple.SafariHistoryServiceAgent\n812\t0\tcom.apple.Finder\n-\t-9\tcom.example.crashy\n";
        let v = parse_launchctl_list(out);
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].state, ServiceState::Stopped);
        assert_eq!(v[0].pid, None);
        assert_eq!(v[1].name, "com.apple.Finder");
        assert_eq!(v[1].pid, Some(812));
        assert_eq!(v[1].state, ServiceState::Running);
        assert!(v.iter().all(|s| !s.can_stop && !s.is_microsoft));
    }
}
