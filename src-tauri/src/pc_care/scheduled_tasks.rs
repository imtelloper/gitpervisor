//! 예약 작업 목록·켜기/끄기(DOCS/pc-care-design.md §4.5).
//!
//! Windows = 작업 스케줄러 COM, Linux = systemd 사용자 타이머(+crontab 읽기 전용), macOS = crontab 읽기 전용
//! (launchd 주기 작업은 시작프로그램 목록에 이미 나온다).

use serde::Serialize;

use crate::error::IpcError;
use crate::i18n::text_pccare_startup as text;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Ready,
    Running,
    Disabled,
    Queued,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub path: String,
    pub name: String,
    pub enabled: bool,
    pub state: TaskState,
    pub last_run_ms: Option<i64>,
    pub next_run_ms: Option<i64>,
    /// 마지막 실행 결과(HRESULT 를 부호 없는 32비트로) — 화면은 0x%08X 로 보인다.
    pub last_result: Option<u32>,
    pub author: Option<String>,
    pub command: Option<String>,
    /// crontab 줄처럼 여기서 켜고 끌 수 없는 항목은 false — 토글을 숨긴다.
    pub can_toggle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskList {
    pub tasks: Vec<ScheduledTask>,
    pub unreadable: Vec<String>,
}

/// 작업 스케줄러의 DATE(1899-12-30 기준 일수, **현지 시각**) → 현지 NaiveDateTime. 2000년 이전은 "실행 안 함" 표식이다
/// (실행된 적 없는 작업의 LastRunTime 은 1999-11-30, 다음 실행 없음은 0).
#[cfg_attr(not(windows), allow(dead_code))]
fn ole_date_local(date: f64) -> Option<chrono::NaiveDateTime> {
    if !date.is_finite() || date < 36526.0 {
        return None;
    }
    let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    base.checked_add_signed(chrono::Duration::milliseconds((date * 86_400_000.0).round() as i64))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn task_state(raw: i32) -> TaskState {
    match raw {
        1 => TaskState::Disabled,
        2 => TaskState::Queued,
        3 => TaskState::Ready,
        4 => TaskState::Running,
        _ => TaskState::Unknown,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_microsoft_path(path: &str) -> bool {
    path.get(..11).is_some_and(|p| p.eq_ignore_ascii_case("\\Microsoft\\")) || path.eq_ignore_ascii_case("\\Microsoft")
}

/// `\a\b\task` → (`\a\b`, `task`), 루트 바로 아래면 부모는 `\`.
#[cfg_attr(not(windows), allow(dead_code))]
fn split_task_path(path: &str) -> Option<(&str, &str)> {
    if !path.starts_with('\\') {
        return None;
    }
    let (parent, name) = path.rsplit_once('\\')?;
    if name.is_empty() {
        return None;
    }
    Some((if parent.is_empty() { "\\" } else { parent }, name))
}

/// `systemctl --user list-unit-files --type=timer --no-legend` → (유닛, 상태).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_unit_files(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let unit = it.next()?;
            let state = it.next()?;
            unit.ends_with(".timer").then(|| (unit.to_string(), state.to_string()))
        })
        .collect()
}

/// `systemctl --user list-timers --all -o json` → (유닛, 다음 ms, 지난 ms, 실행할 유닛). 시각은 마이크로초.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_timers_json(out: &str) -> Vec<(String, Option<i64>, Option<i64>, Option<String>)> {
    let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(out) else {
        return Vec::new();
    };
    let ms = |v: &serde_json::Value| v.as_i64().filter(|n| *n > 0).map(|us| us / 1000);
    rows.iter()
        .filter_map(|r| {
            Some((
                r.get("unit")?.as_str()?.to_string(),
                r.get("next").and_then(ms),
                r.get("last").and_then(ms),
                r.get("activates").and_then(|v| v.as_str()).map(str::to_string),
            ))
        })
        .collect()
}

/// `crontab -l` → (일정, 명령). 주석·빈 줄·환경 변수 줄(`NAME=value`)은 뺀다.
#[cfg_attr(windows, allow(dead_code))]
fn parse_crontab(out: &str) -> Vec<(String, String)> {
    out.lines()
        .filter_map(|l| {
            let t = l.trim();
            if t.is_empty() || t.starts_with('#') {
                return None;
            }
            let first = t.split_whitespace().next()?;
            if first.contains('=') {
                return None;
            }
            let fields = if first.starts_with('@') { 1 } else { 5 };
            let words: Vec<&str> = t.split_whitespace().collect();
            if words.len() <= fields {
                return None;
            }
            let schedule = words[..fields].join(" ");
            // 명령 부분은 원래 공백을 살린다 — 일정 단어만 앞에서 하나씩 벗긴다.
            let mut rest = t;
            for w in &words[..fields] {
                rest = rest.trim_start().strip_prefix(w)?;
            }
            Some((schedule, rest.trim().to_string()))
        })
        .collect()
}

#[tauri::command(async)]
pub async fn scheduled_tasks_list(include_microsoft: bool) -> Result<ScheduledTaskList, IpcError> {
    imp::list(include_microsoft).await
}

#[tauri::command(async)]
pub async fn scheduled_task_set_enabled(path: String, enabled: bool, elevate: bool) -> Result<(), IpcError> {
    imp::set_enabled(path, enabled, elevate).await
}

#[cfg(unix)]
async fn crontab_tasks(tasks: &mut Vec<ScheduledTask>, unreadable: &mut Vec<String>) {
    let out = match capture("crontab", &["-l"]).await {
        Ok(o) => o,
        Err(e) => {
            unreadable.push(text::startup_read_failed("crontab", e));
            return;
        }
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // 사용자 crontab 이 아직 없으면 1로 끝난다 — 오류가 아니라 "항목 없음"이다.
        if !err.contains("no crontab") {
            unreadable.push(text::startup_read_failed("crontab", err.trim()));
        }
        return;
    }
    for (i, (schedule, command)) in parse_crontab(&stdout).into_iter().enumerate() {
        tasks.push(ScheduledTask {
            path: format!("crontab:{}", i + 1),
            name: schedule,
            enabled: true,
            state: TaskState::Ready,
            last_run_ms: None,
            next_run_ms: None,
            last_result: None,
            author: None,
            command: Some(command),
            can_toggle: false,
        });
    }
}

#[cfg(unix)]
async fn capture(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
    const SECS: u64 = 15;
    let fut = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(std::time::Duration::from_secs(SECS), fut).await {
        Ok(Ok(o)) => Ok(o),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(text::tasks_timed_out(program, SECS)),
    }
}

#[cfg(windows)]
mod imp {
    use chrono::TimeZone;
    use windows::core::{Interface, BSTR};
    use windows::Win32::Foundation::{E_ACCESSDENIED, RPC_E_CHANGED_MODE, VARIANT_FALSE, VARIANT_TRUE};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::TaskScheduler::{
        IExecAction, IRegisteredTask, ITaskFolder, ITaskService, TaskScheduler, TASK_ACTION_EXEC, TASK_ACTION_TYPE,
        TASK_ENUM_HIDDEN,
    };
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4};

    use super::{
        is_microsoft_path, ole_date_local, split_task_path, task_state, text, ScheduledTask, ScheduledTaskList,
    };
    use crate::error::{ErrorCode, IpcError};
    use crate::pc_care::elevate::{run_elevated, ElevatedProgram};

    /// 이 스레드의 COM 초기화 짝. spawn_blocking 스레드는 재사용되니 init 마다 uninit 을 맞춘다.
    struct ComGuard(bool);

    impl ComGuard {
        fn init() -> windows::core::Result<Self> {
            // SAFETY: 예약 인자 None, 같은 스레드에서 Drop 이 짝을 맞춘다.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            if hr == RPC_E_CHANGED_MODE {
                // 이미 STA 로 초기화된 스레드 — 그대로 쓸 수 있고, 남의 초기화라 해제하지 않는다.
                return Ok(Self(false));
            }
            hr.ok()?;
            Ok(Self(true))
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: init 이 성공한 같은 스레드.
                unsafe { CoUninitialize() };
            }
        }
    }

    fn connect() -> windows::core::Result<ITaskService> {
        // SAFETY: COM 이 이 스레드에서 초기화된 뒤에만 부른다(ComGuard).
        unsafe {
            let svc: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
            let empty = VARIANT::default();
            svc.Connect(&empty, &empty, &empty, &empty)?;
            Ok(svc)
        }
    }

    /// 컬렉션 get_Item 은 1부터 세는 VT_I4 인덱스를 받는다(windows 크레이트엔 i32→VARIANT 변환이 없다).
    fn index(i: i32) -> VARIANT {
        VARIANT {
            Anonymous: VARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                    vt: VT_I4,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: VARIANT_0_0_0 { lVal: i },
                }),
            },
        }
    }

    fn date_ms(date: windows::core::Result<f64>) -> Option<i64> {
        let local = ole_date_local(date.ok()?)?;
        chrono::Local.from_local_datetime(&local).earliest().map(|d| d.timestamp_millis())
    }

    fn author_and_command(task: &IRegisteredTask) -> (Option<String>, Option<String>) {
        // SAFETY: 유효한 COM 인터페이스에 대한 조회 호출. BSTR 은 Drop 이 해제한다.
        unsafe {
            let Ok(def) = task.Definition() else { return (None, None) };
            let author = def.RegistrationInfo().ok().and_then(|info| {
                let mut b = BSTR::new();
                info.Author(&mut b).ok()?;
                Some(b.to_string()).filter(|s| !s.is_empty())
            });
            let command = def.Actions().ok().and_then(|actions| {
                let first = actions.get_Item(1).ok()?;
                let mut ty = TASK_ACTION_TYPE::default();
                first.Type(&mut ty).ok()?;
                if ty != TASK_ACTION_EXEC {
                    return None;
                }
                let exec: IExecAction = first.cast().ok()?;
                let (mut path, mut args) = (BSTR::new(), BSTR::new());
                exec.Path(&mut path).ok()?;
                // 인자가 없는 작업은 Arguments 가 실패할 수 있다 — 경로만으로도 쓸모 있다.
                let _ = exec.Arguments(&mut args);
                let (path, args) = (path.to_string(), args.to_string());
                Some(if args.is_empty() { path } else { format!("{path} {args}") })
            });
            (author, command)
        }
    }

    fn read_task(task: &IRegisteredTask) -> Option<ScheduledTask> {
        // SAFETY: 유효한 COM 인터페이스에 대한 조회 호출.
        unsafe {
            let path = task.Path().ok()?.to_string();
            let (author, command) = author_and_command(task);
            Some(ScheduledTask {
                name: task.Name().map(|b| b.to_string()).unwrap_or_else(|_| path.clone()),
                enabled: task.Enabled().map(|v| v.as_bool()).unwrap_or(false),
                state: task.State().map(|s| task_state(s.0)).unwrap_or(super::TaskState::Unknown),
                last_run_ms: date_ms(task.LastRunTime()),
                next_run_ms: date_ms(task.NextRunTime()),
                last_result: task.LastTaskResult().ok().map(|r| r as u32),
                author,
                command,
                can_toggle: true,
                path,
            })
        }
    }

    /// 열 수 없는 폴더·작업은 건너뛰고 센다 — 권한 없는 폴더 하나로 목록 전체가 실패하면 안 된다.
    fn walk(folder: &ITaskFolder, include_microsoft: bool, out: &mut Vec<ScheduledTask>, skipped: &mut u32) {
        // SAFETY: 유효한 COM 인터페이스에 대한 조회 호출.
        unsafe {
            match folder.GetTasks(TASK_ENUM_HIDDEN.0).and_then(|c| Ok((c.Count()?, c))) {
                Ok((n, tasks)) => {
                    for i in 1..=n {
                        match tasks.get_Item(&index(i)).ok().and_then(|t| read_task(&t)) {
                            Some(t) => out.push(t),
                            None => *skipped += 1,
                        }
                    }
                }
                Err(_) => *skipped += 1,
            }
            match folder.GetFolders(0).and_then(|c| Ok((c.Count()?, c))) {
                Ok((n, subs)) => {
                    for i in 1..=n {
                        let Ok(sub) = subs.get_Item(&index(i)) else {
                            *skipped += 1;
                            continue;
                        };
                        // Microsoft 폴더는 수백 개라 숨길 때는 아예 내려가지 않는다.
                        let is_ms = sub.Path().map(|p| is_microsoft_path(&p.to_string())).unwrap_or(false);
                        if is_ms && !include_microsoft {
                            continue;
                        }
                        walk(&sub, include_microsoft, out, skipped);
                    }
                }
                Err(_) => *skipped += 1,
            }
        }
    }

    fn list_blocking(include_microsoft: bool) -> Result<ScheduledTaskList, IpcError> {
        let fail = |e: windows::core::Error| IpcError::new(ErrorCode::Io, text::tasks_list_failed(e.message()));
        let _com = ComGuard::init().map_err(fail)?;
        let svc = connect().map_err(fail)?;
        // SAFETY: 연결된 서비스에 대한 조회 호출.
        let root = unsafe { svc.GetFolder(&BSTR::from("\\")) }.map_err(fail)?;
        let mut tasks = Vec::new();
        let mut skipped = 0;
        walk(&root, include_microsoft, &mut tasks, &mut skipped);
        tasks.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        let unreadable = if skipped > 0 { vec![text::tasks_skipped(skipped)] } else { Vec::new() };
        Ok(ScheduledTaskList { tasks, unreadable })
    }

    pub(super) async fn list(include_microsoft: bool) -> Result<ScheduledTaskList, IpcError> {
        tokio::task::spawn_blocking(move || list_blocking(include_microsoft))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::tasks_list_failed(e)))?
    }

    fn set_blocking(path: &str, enabled: bool) -> Result<(), IpcError> {
        let Some((parent, name)) = split_task_path(path) else {
            return Err(IpcError::new(ErrorCode::NotFound, text::tasks_bad_path(path)));
        };
        let map = |e: windows::core::Error| {
            if e.code() == E_ACCESSDENIED {
                IpcError::new(ErrorCode::PermissionDenied, text::startup_needs_admin())
            } else if e.code().0 as u32 == 0x8007_0002 || e.code().0 as u32 == 0x8007_0003 {
                IpcError::new(ErrorCode::NotFound, text::tasks_bad_path(path))
            } else {
                IpcError::new(ErrorCode::Io, text::tasks_set_failed(path, e.message()))
            }
        };
        let _com = ComGuard::init().map_err(map)?;
        let svc = connect().map_err(map)?;
        // SAFETY: 연결된 서비스에 대한 호출, 인자 BSTR 은 호출 동안 산다.
        unsafe {
            let folder = svc.GetFolder(&BSTR::from(parent)).map_err(map)?;
            let task = folder.GetTask(&BSTR::from(name)).map_err(map)?;
            task.SetEnabled(if enabled { VARIANT_TRUE } else { VARIANT_FALSE }).map_err(map)
        }
    }

    pub(super) async fn set_enabled(path: String, enabled: bool, elevate: bool) -> Result<(), IpcError> {
        if split_task_path(&path).is_none() {
            return Err(IpcError::new(ErrorCode::NotFound, text::tasks_bad_path(&path)));
        }
        if elevate {
            let flag = if enabled { "/ENABLE" } else { "/DISABLE" };
            let args = ["/Change".to_string(), "/TN".to_string(), path, flag.to_string()];
            return run_elevated(ElevatedProgram::Schtasks, &args).await;
        }
        let p = path.clone();
        tokio::task::spawn_blocking(move || set_blocking(&p, enabled))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::tasks_set_failed(&path, e)))?
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{capture, crontab_tasks, parse_timers_json, parse_unit_files, text, ScheduledTask, ScheduledTaskList, TaskState};
    use crate::error::{ErrorCode, IpcError};

    pub(super) async fn list(_include_microsoft: bool) -> Result<ScheduledTaskList, IpcError> {
        let mut tasks = Vec::new();
        let mut unreadable = Vec::new();
        let files = match capture("systemctl", &["--user", "list-unit-files", "--type=timer", "--no-legend", "--no-pager"]).await {
            Ok(o) if o.status.success() => parse_unit_files(&String::from_utf8_lossy(&o.stdout)),
            Ok(o) => {
                unreadable.push(text::startup_read_failed("systemctl --user", String::from_utf8_lossy(&o.stderr).trim()));
                Vec::new()
            }
            Err(e) => {
                unreadable.push(text::startup_read_failed("systemctl --user", e));
                Vec::new()
            }
        };
        // 다음·지난 실행 시각은 덤이다 — 옛 systemd 는 -o json 을 모르니 실패해도 목록은 그대로 낸다.
        let timers = match capture("systemctl", &["--user", "list-timers", "--all", "--no-pager", "-o", "json"]).await {
            Ok(o) if o.status.success() => parse_timers_json(&String::from_utf8_lossy(&o.stdout)),
            _ => Vec::new(),
        };
        for (unit, state) in files {
            let t = timers.iter().find(|t| t.0 == unit);
            let enabled = state == "enabled";
            tasks.push(ScheduledTask {
                name: unit.clone(),
                enabled,
                state: if enabled { TaskState::Ready } else { TaskState::Disabled },
                last_run_ms: t.and_then(|t| t.2),
                next_run_ms: t.and_then(|t| t.1),
                last_result: None,
                author: None,
                command: t.and_then(|t| t.3.clone()),
                // static·generated 유닛은 enable/disable 대상이 아니다.
                can_toggle: state == "enabled" || state == "disabled",
                path: unit,
            });
        }
        crontab_tasks(&mut tasks, &mut unreadable).await;
        Ok(ScheduledTaskList { tasks, unreadable })
    }

    pub(super) async fn set_enabled(path: String, enabled: bool, _elevate: bool) -> Result<(), IpcError> {
        if !path.ends_with(".timer") || path.starts_with('-') || path.contains('/') {
            return Err(IpcError::new(ErrorCode::Io, text::tasks_not_toggleable()));
        }
        let verb = if enabled { "enable" } else { "disable" };
        let out = capture("systemctl", &["--user", verb, "--now", &path])
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::tasks_set_failed(&path, e)))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(IpcError::new(ErrorCode::Io, text::tasks_set_failed(&path, String::from_utf8_lossy(&out.stderr).trim())))
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{crontab_tasks, text, ScheduledTaskList};
    use crate::error::{ErrorCode, IpcError};

    pub(super) async fn list(_include_microsoft: bool) -> Result<ScheduledTaskList, IpcError> {
        let mut tasks = Vec::new();
        let mut unreadable = Vec::new();
        crontab_tasks(&mut tasks, &mut unreadable).await;
        Ok(ScheduledTaskList { tasks, unreadable })
    }

    pub(super) async fn set_enabled(_path: String, _enabled: bool, _elevate: bool) -> Result<(), IpcError> {
        Err(IpcError::new(ErrorCode::Io, text::tasks_not_toggleable()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_startup_tasks_ole_date_and_state() {
        let d = ole_date_local(45000.5).unwrap();
        assert_eq!(d.to_string(), "2023-03-15 12:00:00");
        assert_eq!(ole_date_local(0.0), None);
        // 실행된 적 없는 작업의 표식 1999-11-30
        assert_eq!(ole_date_local(36494.0), None);
        assert_eq!(ole_date_local(f64::NAN), None);
        assert_eq!(task_state(3), TaskState::Ready);
        assert_eq!(task_state(4), TaskState::Running);
        assert_eq!(task_state(1), TaskState::Disabled);
        assert_eq!(task_state(9), TaskState::Unknown);
    }

    #[test]
    fn pccare_startup_tasks_paths() {
        assert!(is_microsoft_path("\\Microsoft\\Windows\\Defrag\\ScheduledDefrag"));
        assert!(is_microsoft_path("\\microsoft"));
        assert!(!is_microsoft_path("\\MicrosoftEdgeUpdateTaskMachineCore"));
        assert_eq!(split_task_path("\\GoogleUpdate"), Some(("\\", "GoogleUpdate")));
        assert_eq!(split_task_path("\\A\\B\\task x"), Some(("\\A\\B", "task x")));
        assert_eq!(split_task_path("task"), None);
        assert_eq!(split_task_path("\\A\\"), None);
    }

    #[test]
    fn pccare_startup_tasks_unix_parsers() {
        let files = "backup.timer   enabled  enabled\nfoo.timer disabled enabled\nx.service enabled enabled\n";
        assert_eq!(
            parse_unit_files(files),
            vec![("backup.timer".into(), "enabled".into()), ("foo.timer".into(), "disabled".into())]
        );
        let json = r#"[{"next":1700000000000000,"left":1,"last":null,"passed":null,"unit":"backup.timer","activates":"backup.service"}]"#;
        assert_eq!(
            parse_timers_json(json),
            vec![("backup.timer".into(), Some(1_700_000_000_000), None, Some("backup.service".into()))]
        );
        assert!(parse_timers_json("not json").is_empty());

        let cron = "# comment\nMAILTO=me\n\n*/5 * * * *  /usr/bin/backup --fast\n@reboot   ~/start.sh arg\nbroken\n";
        assert_eq!(
            parse_crontab(cron),
            vec![
                ("*/5 * * * *".into(), "/usr/bin/backup --fast".into()),
                ("@reboot".into(), "~/start.sh arg".into()),
            ]
        );
    }
}
