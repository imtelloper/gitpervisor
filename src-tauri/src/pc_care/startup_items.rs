//! 시작프로그램 목록·켜기/끄기(DOCS/pc-care-design.md §4.4).
//!
//! 끄기는 삭제가 아니라 **되돌릴 수 있는 표시**다 — Windows는 작업 관리자와 같은 StartupApproved 값, Linux는 사용자
//! 폴더의 `Hidden=true` 사본, macOS는 `launchctl disable`. 원본(Run 값·시스템 .desktop·plist)은 어느 OS에서도 건드리지 않는다.

use serde::Serialize;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare_startup as text;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StartupScope {
    User,
    Machine,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub id: String,
    pub name: String,
    pub command: String,
    pub location: String,
    pub scope: StartupScope,
    pub enabled: bool,
    pub publisher: Option<String>,
    pub exe_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupList {
    pub items: Vec<StartupItem>,
    /// 읽지 못한 위치마다 한 줄 — 빈 목록이 "없음"인지 "못 읽음"인지 화면이 구분하게 한다.
    pub unreadable: Vec<String>,
}

/// `id` 조립·해체는 여기 한 곳 — 프런트는 불투명 값으로만 다룬다. 위치(경로)에는 `|`가 들어갈 수 없어 첫 `|`에서 자른다.
fn make_id(location: &str, name: &str) -> String {
    format!("{location}|{name}")
}

fn split_id(id: &str) -> Option<(&str, &str)> {
    id.split_once('|').filter(|(l, n)| !l.is_empty() && !n.is_empty())
}

/// 폴더 항목의 이름은 그 폴더 바로 아래 파일 이름이어야 한다 — 프런트가 준 id 라서 `C:\…`·`..\` 를 넣으면
/// `dir.join` 이 폴더 밖 아무 파일이나 가리켜 존재 검사를 통과하고 그 이름으로 값이 써진다.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn is_bare_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', ':'])
}

/// 명령줄에서 실행 파일 경로만 — 따옴표로 감쌌으면 그 안, 아니면 `.exe`까지 또는 첫 공백까지.
#[cfg_attr(not(windows), allow(dead_code))]
fn command_exe_path(command: &str) -> Option<String> {
    let c = command.trim();
    if let Some(rest) = c.strip_prefix('"') {
        return rest.split('"').next().filter(|s| !s.is_empty()).map(str::to_string);
    }
    let lower = c.to_ascii_lowercase();
    let end = lower.find(".exe").map(|i| i + 4).unwrap_or_else(|| c.find(' ').unwrap_or(c.len()));
    Some(c[..end].to_string()).filter(|s| !s.is_empty())
}

/// StartupApproved 12바이트 값 → 켜짐 여부. 작업 관리자 규칙: 첫 바이트 짝수 = 켜짐(02·06), 홀수 = 꺼짐(03·07), 값 없음 = 켜짐.
#[cfg_attr(not(windows), allow(dead_code))]
fn approved_is_enabled(bytes: Option<&[u8]>) -> bool {
    bytes.and_then(|b| b.first()).is_none_or(|b| b % 2 == 0)
}

/// 켜기 = `02` + 0×11, 끄기 = `03 00 00 00` + 끈 시각 FILETIME(작업 관리자가 "사용 안 함 시각"으로 쓰는 자리).
#[cfg_attr(not(windows), allow(dead_code))]
fn approved_bytes(enabled: bool, filetime_now: u64) -> [u8; 12] {
    let mut out = [0u8; 12];
    if enabled {
        out[0] = 0x02;
    } else {
        out[0] = 0x03;
        out[4..].copy_from_slice(&filetime_now.to_le_bytes());
    }
    out
}

#[cfg_attr(not(windows), allow(dead_code))]
fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// XDG .desktop 의 `[Desktop Entry]` 그룹에서 키 하나(지역화 키 `Name[ko]`는 무시).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_value<'a>(content: &'a str, key: &str) -> Option<&'a str> {
    let mut in_entry = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_entry = t == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.trim() == key {
                return Some(v.trim());
            }
        }
    }
    None
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_is_enabled(content: &str) -> bool {
    !desktop_value(content, "Hidden").is_some_and(|v| v.eq_ignore_ascii_case("true"))
        && !desktop_value(content, "X-GNOME-Autostart-enabled").is_some_and(|v| v.eq_ignore_ascii_case("false"))
}

/// `[Desktop Entry]`의 `Hidden`을 바꾼(없으면 넣은) 사본. 켤 때는 GNOME 전용 끄기 키도 지운다 — 남아 있으면 계속 꺼져 있다.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_set_hidden(content: &str, hidden: bool) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_entry = false;
    let mut written = false;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            if in_entry && !written {
                out.push(format!("Hidden={hidden}"));
                written = true;
            }
            in_entry = t == "[Desktop Entry]";
            out.push(line.to_string());
            continue;
        }
        if in_entry {
            let key = t.split_once('=').map(|(k, _)| k.trim());
            if key == Some("Hidden") {
                if !written {
                    out.push(format!("Hidden={hidden}"));
                    written = true;
                }
                continue;
            }
            if key == Some("X-GNOME-Autostart-enabled") && !hidden {
                continue;
            }
        }
        out.push(line.to_string());
    }
    if !written {
        if !in_entry {
            out.push("[Desktop Entry]".to_string());
        }
        out.push(format!("Hidden={hidden}"));
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// 최소 XML plist 추출 — `Label`·`Program`·`ProgramArguments`·`Disabled`만 본다(전체 파서는 필요 없다).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Default, PartialEq)]
struct PlistInfo {
    label: Option<String>,
    program: Option<String>,
    arguments: Vec<String>,
    disabled: bool,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_plist(xml: &str) -> PlistInfo {
    let mut info = PlistInfo::default();
    let mut rest = xml;
    while let Some(at) = rest.find("<key>") {
        rest = &rest[at + 5..];
        let Some(end) = rest.find("</key>") else { break };
        let key = rest[..end].trim().to_string();
        rest = rest[end + 6..].trim_start();
        let string_val = |r: &str| -> Option<String> {
            let r = r.strip_prefix("<string>")?;
            Some(xml_unescape(&r[..r.find("</string>")?]))
        };
        match key.as_str() {
            "Label" => info.label = string_val(rest),
            "Program" => info.program = string_val(rest),
            "Disabled" => info.disabled = rest.starts_with("<true"),
            "ProgramArguments" if rest.starts_with("<array>") => {
                let body = &rest[..rest.find("</array>").unwrap_or(rest.len())];
                let mut b = body;
                while let Some(s) = b.find("<string>") {
                    b = &b[s + 8..];
                    let Some(e) = b.find("</string>") else { break };
                    info.arguments.push(xml_unescape(&b[..e]));
                    b = &b[e + 9..];
                }
            }
            _ => {}
        }
    }
    info
}

/// `launchctl print-disabled <domain>` 출력에서 끈 라벨들. 줄 모양: `"com.x.y" => disabled`(새) 또는 `=> true`(옛).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_print_disabled(out: &str) -> Vec<(String, bool)> {
    out.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once("=>")?;
            let label = k.trim().trim_matches('"').to_string();
            let v = v.trim();
            let disabled = v.starts_with("disabled") || v.starts_with("true");
            let enabled = v.starts_with("enabled") || v.starts_with("false");
            (!label.is_empty() && (disabled || enabled)).then_some((label, disabled))
        })
        .collect()
}

#[tauri::command(async)]
pub async fn startup_list() -> Result<StartupList, IpcError> {
    imp::list().await
}

#[tauri::command(async)]
pub async fn startup_set_enabled(id: String, enabled: bool, elevate: bool) -> Result<(), IpcError> {
    let Some((location, name)) = split_id(&id) else {
        return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(&id)));
    };
    imp::set_enabled(location, name, enabled, elevate).await
}

#[cfg(windows)]
mod imp {
    use windows_registry::{Key, Type, CURRENT_USER, LOCAL_MACHINE};

    use super::{
        approved_bytes, approved_is_enabled, command_exe_path, hex_upper, make_id, text, StartupItem, StartupList,
        StartupScope,
    };
    use crate::error::{ErrorCode, IpcError};
    use crate::pc_care::elevate::{run_elevated, ElevatedProgram};

    const RUN: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const RUN32: &str = "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run";
    const APPROVED: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved";
    const E_FILE_NOT_FOUND: u32 = 0x8007_0002;
    const E_PATH_NOT_FOUND: u32 = 0x8007_0003;
    const E_ACCESSDENIED: u32 = 0x8007_0005;

    /// 위치 5곳. `location` 문자열이 곧 id 앞부분이라 바꾸면 이미 화면에 있던 id가 어긋난다(목록을 다시 받으면 된다).
    #[derive(Clone, Copy)]
    enum Source {
        UserRun,
        MachineRun,
        MachineRun32,
        UserFolder,
        CommonFolder,
    }

    const SOURCES: [Source; 5] =
        [Source::UserRun, Source::MachineRun, Source::MachineRun32, Source::UserFolder, Source::CommonFolder];

    impl Source {
        fn location(self) -> &'static str {
            match self {
                Self::UserRun => "HKCU\\…\\Run",
                Self::MachineRun => "HKLM\\…\\Run",
                Self::MachineRun32 => "HKLM\\…\\WOW6432Node\\…\\Run",
                Self::UserFolder => "%APPDATA%\\…\\Startup",
                Self::CommonFolder => "%ProgramData%\\…\\StartUp",
            }
        }

        fn from_location(loc: &str) -> Option<Self> {
            SOURCES.into_iter().find(|s| s.location() == loc)
        }

        fn scope(self) -> StartupScope {
            match self {
                Self::UserRun | Self::UserFolder => StartupScope::User,
                _ => StartupScope::Machine,
            }
        }

        fn root(self) -> &'static Key {
            match self.scope() {
                StartupScope::User => CURRENT_USER,
                StartupScope::Machine => LOCAL_MACHINE,
            }
        }

        fn approved_leaf(self) -> &'static str {
            match self {
                Self::UserRun | Self::MachineRun => "Run",
                Self::MachineRun32 => "Run32",
                Self::UserFolder | Self::CommonFolder => "StartupFolder",
            }
        }

        fn run_key(self) -> Option<&'static str> {
            match self {
                Self::UserRun | Self::MachineRun => Some(RUN),
                Self::MachineRun32 => Some(RUN32),
                _ => None,
            }
        }

        fn folder(self) -> Option<std::path::PathBuf> {
            let (var, tail) = match self {
                Self::UserFolder => ("APPDATA", "Microsoft\\Windows\\Start Menu\\Programs\\Startup"),
                Self::CommonFolder => ("ProgramData", "Microsoft\\Windows\\Start Menu\\Programs\\StartUp"),
                _ => return None,
            };
            std::env::var_os(var).map(|v| std::path::PathBuf::from(v).join(tail))
        }
    }

    fn is_missing(hresult: i32) -> bool {
        matches!(hresult as u32, E_FILE_NOT_FOUND | E_PATH_NOT_FOUND)
    }

    pub(super) async fn list() -> Result<StartupList, IpcError> {
        tokio::task::spawn_blocking(list_blocking)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::startup_list_failed(e)))
    }

    fn list_blocking() -> StartupList {
        let mut out = StartupList { items: Vec::new(), unreadable: Vec::new() };
        for src in SOURCES {
            let approved = src.root().open(format!("{APPROVED}\\{}", src.approved_leaf())).ok();
            let is_enabled = |name: &str| {
                let v = approved.as_ref().and_then(|k| k.get_value(name).ok());
                approved_is_enabled(v.as_deref())
            };
            let mut push = |name: String, command: String, exe_path: Option<String>| {
                out.items.push(StartupItem {
                    id: make_id(src.location(), &name),
                    enabled: is_enabled(&name),
                    name,
                    command,
                    location: src.location().to_string(),
                    scope: src.scope(),
                    publisher: None,
                    exe_path,
                });
            };
            if let Some(run) = src.run_key() {
                let key = match src.root().open(run) {
                    Ok(k) => k,
                    Err(e) if is_missing(e.code().0) => continue,
                    Err(e) => {
                        out.unreadable.push(text::startup_read_failed(src.location(), e));
                        continue;
                    }
                };
                let values = match key.values() {
                    Ok(v) => v,
                    Err(e) => {
                        out.unreadable.push(text::startup_read_failed(src.location(), e));
                        continue;
                    }
                };
                for (name, value) in values {
                    // 이름 없는 기본값·문자열이 아닌 값은 Windows도 실행하지 않는다.
                    if name.is_empty() || !matches!(value.ty(), Type::String | Type::ExpandString) {
                        continue;
                    }
                    let Ok(cmd) = String::try_from(value) else { continue };
                    let exe = command_exe_path(&cmd);
                    push(name, cmd, exe);
                }
            } else if let Some(dir) = src.folder() {
                let entries = match std::fs::read_dir(&dir) {
                    Ok(e) => e,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        out.unreadable.push(text::startup_read_failed(&dir.display().to_string(), e));
                        continue;
                    }
                };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.eq_ignore_ascii_case("desktop.ini") || entry.path().is_dir() {
                        continue;
                    }
                    let path = entry.path().display().to_string();
                    let exe = Some(path.clone());
                    push(name, path, exe);
                }
            }
        }
        out
    }

    fn item_exists(src: Source, name: &str) -> bool {
        match (src.run_key(), src.folder()) {
            (Some(run), _) => src.root().open(run).and_then(|k| k.get_value(name)).is_ok(),
            (None, Some(dir)) => super::is_bare_file_name(name) && dir.join(name).is_file(),
            _ => false,
        }
    }

    pub(super) async fn set_enabled(location: &str, name: &str, enabled: bool, elevate: bool) -> Result<(), IpcError> {
        let Some(src) = Source::from_location(location) else {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(location)));
        };
        // 목록에 있는 항목에만 쓴다 — 임의 이름으로 StartupApproved 에 쓰레기 값을 만들지 않게.
        if !item_exists(src, name) {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_item_missing(name)));
        }
        let filetime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64 / 100 + 116_444_736_000_000_000)
            .unwrap_or(0);
        let bytes = approved_bytes(enabled, filetime);
        let subkey = format!("{APPROVED}\\{}", src.approved_leaf());

        if elevate && src.scope() == StartupScope::Machine {
            let args: Vec<String> = [
                "add",
                &format!("HKLM\\{subkey}"),
                "/v",
                name,
                "/t",
                "REG_BINARY",
                "/d",
                &hex_upper(&bytes),
                "/f",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            return run_elevated(ElevatedProgram::Reg, &args).await;
        }

        let name = name.to_string();
        // Key 는 원시 핸들이라 스레드를 못 넘는다 — Source(Copy)를 넘겨 그 스레드에서 꺼낸다.
        let res = tokio::task::spawn_blocking(move || {
            src.root().options().read().write().create().open(&subkey).and_then(|k| k.set_bytes(&name, Type::Bytes, &bytes))
        })
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text::startup_write_failed(location, e)))?;
        res.map_err(|e| {
            if e.code().0 as u32 == E_ACCESSDENIED {
                IpcError::new(ErrorCode::PermissionDenied, text::startup_needs_admin())
            } else {
                IpcError::new(ErrorCode::Io, text::startup_write_failed(location, e))
            }
        })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::path::PathBuf;

    use super::{desktop_is_enabled, desktop_set_hidden, desktop_value, make_id, text, StartupItem, StartupList, StartupScope};
    use crate::error::{ErrorCode, IpcError};

    const SYSTEM_DIR: &str = "/etc/xdg/autostart";

    fn user_dir() -> Option<PathBuf> {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| crate::claude_usage::home_dir().map(|h| h.join(".config")))
            .map(|c| c.join("autostart"))
    }

    fn read_desktops(dir: &std::path::Path, unreadable: &mut Vec<String>) -> Vec<(String, String)> {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
            Err(e) => {
                unreadable.push(text::startup_read_failed(&dir.display().to_string(), e));
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".desktop") {
                continue;
            }
            match std::fs::read_to_string(entry.path()) {
                Ok(c) => out.push((name, c)),
                Err(e) => unreadable.push(text::startup_read_failed(&entry.path().display().to_string(), e)),
            }
        }
        out
    }

    pub(super) async fn list() -> Result<StartupList, IpcError> {
        let mut unreadable = Vec::new();
        let user = user_dir();
        let user_files = user.as_deref().map(|d| read_desktops(d, &mut unreadable)).unwrap_or_default();
        let system_files = read_desktops(std::path::Path::new(SYSTEM_DIR), &mut unreadable);
        let mut items = Vec::new();
        let mut push = |dir: String, scope, file: &str, content: &str| {
            let command = desktop_value(content, "Exec").unwrap_or_default().to_string();
            items.push(StartupItem {
                id: make_id(&dir, file),
                name: desktop_value(content, "Name").unwrap_or(file).to_string(),
                exe_path: command.split_whitespace().next().map(str::to_string),
                command,
                location: dir,
                scope,
                enabled: desktop_is_enabled(content),
                publisher: None,
            });
        };
        let user_loc = user.as_ref().map(|d| d.display().to_string()).unwrap_or_default();
        for (file, content) in &user_files {
            push(user_loc.clone(), StartupScope::User, file, content);
        }
        // 같은 파일 이름의 사용자 사본이 시스템 것을 덮는다(XDG Autostart 규칙) — 시스템 쪽은 사본이 없을 때만 보인다.
        for (file, content) in &system_files {
            if !user_files.iter().any(|(f, _)| f == file) {
                push(SYSTEM_DIR.to_string(), StartupScope::Machine, file, content);
            }
        }
        Ok(StartupList { items, unreadable })
    }

    pub(super) async fn set_enabled(location: &str, name: &str, enabled: bool, _elevate: bool) -> Result<(), IpcError> {
        if !super::is_bare_file_name(name) || !name.ends_with(".desktop") {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(name)));
        }
        let Some(user) = user_dir() else {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(location)));
        };
        let source = PathBuf::from(location).join(name);
        if location != SYSTEM_DIR && PathBuf::from(location) != user {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(location)));
        }
        let content = std::fs::read_to_string(&source)
            .map_err(|e| IpcError::new(ErrorCode::NotFound, text::startup_read_failed(&source.display().to_string(), e)))?;
        // 시스템 파일은 그대로 두고 사용자 폴더에 Hidden 사본을 쓴다 — 켜기는 그 사본의 Hidden=false.
        let target = user.join(name);
        std::fs::create_dir_all(&user)
            // 사용자 사본이 심볼릭 링크(stow·dotfiles)면 write 가 링크 대상(폴더 밖, 시스템 파일일 수도)을 고친다 —
            // 링크만 지우고 일반 파일로 바꿔 쓴다. 메타데이터 오류(대개 NotFound)는 뒤의 write 가 다시 드러낸다.
            .and_then(|_| match std::fs::symlink_metadata(&target) {
                Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&target),
                _ => Ok(()),
            })
            .and_then(|_| std::fs::write(&target, desktop_set_hidden(&content, !enabled)))
            .map_err(|e| IpcError::new(ErrorCode::Io, text::startup_write_failed(&target.display().to_string(), e)))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::{Path, PathBuf};

    use super::{make_id, parse_plist, parse_print_disabled, text, StartupItem, StartupList, StartupScope};
    use crate::error::{ErrorCode, IpcError};
    use crate::pc_care::elevate::{run_elevated, ElevatedProgram};
    use crate::sysinfo_static::run_capture;

    // (폴더, 표시 범위, launchd 도메인). /Library/LaunchAgents 는 모든 사용자 것이지만 각 사용자의
    // gui/<uid> 도메인에서 뜬다 — system 도메인에 disable 을 쓰면 아무 효과 없이 성공하고 관리자 암호만 묻는다.
    // 그래서 범위(표시)와 도메인(토글 대상)을 따로 둔다. 관리자가 필요한 건 system 도메인뿐이다.
    fn dirs() -> Vec<(PathBuf, StartupScope, String)> {
        let gui = format!("gui/{}", uid());
        let mut v = Vec::new();
        if let Some(h) = crate::claude_usage::home_dir() {
            v.push((h.join("Library/LaunchAgents"), StartupScope::User, gui.clone()));
        }
        v.push((PathBuf::from("/Library/LaunchAgents"), StartupScope::Machine, gui));
        v.push((PathBuf::from("/Library/LaunchDaemons"), StartupScope::Machine, "system".to_string()));
        v
    }

    fn uid() -> u32 {
        // SAFETY: getuid 는 실패하지 않는다.
        unsafe { libc::getuid() }
    }

    async fn read_plist(path: &Path) -> Result<String, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        if bytes.starts_with(b"bplist") {
            // 바이너리 plist 는 시스템 plutil 로 XML 로 바꿔 같은 추출기를 쓴다.
            let p = path.to_string_lossy().into_owned();
            return run_capture("/usr/bin/plutil", &["-convert", "xml1", "-o", "-", p.as_str()], 10).await;
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub(super) async fn list() -> Result<StartupList, IpcError> {
        let mut out = StartupList { items: Vec::new(), unreadable: Vec::new() };
        // 덮어쓰기는 도메인별로 따로 둔다 — 같은 레이블이라도 system 쪽 값은 LaunchAgent 에 적용되지 않는다.
        let mut overrides: Vec<(String, Vec<(String, bool)>)> = Vec::new();
        for d in [format!("gui/{}", uid()), "system".to_string()] {
            match run_capture("/bin/launchctl", &["print-disabled", &d], 10).await {
                Ok(s) => overrides.push((d, parse_print_disabled(&s))),
                Err(e) => out.unreadable.push(text::startup_read_failed(&d, e)),
            }
        }
        for (dir, scope, domain) in dirs() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    out.unreadable.push(text::startup_read_failed(&dir.display().to_string(), e));
                    continue;
                }
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("plist") {
                    continue;
                }
                let xml = match read_plist(&path).await {
                    Ok(x) => x,
                    Err(e) => {
                        out.unreadable.push(text::startup_read_failed(&path.display().to_string(), e));
                        continue;
                    }
                };
                let info = parse_plist(&xml);
                let Some(label) = info.label.clone() else { continue };
                let exe = info.program.clone().or_else(|| info.arguments.first().cloned());
                let command = if info.arguments.is_empty() {
                    info.program.clone().unwrap_or_default()
                } else {
                    info.arguments.join(" ")
                };
                let overridden = overrides
                    .iter()
                    .find(|(d, _)| *d == domain)
                    .and_then(|(_, o)| o.iter().rev().find(|(l, _)| *l == label))
                    .map(|(_, d)| *d);
                let location = dir.display().to_string();
                out.items.push(StartupItem {
                    id: make_id(&location, &label),
                    name: label,
                    command,
                    location,
                    scope,
                    enabled: !overridden.unwrap_or(info.disabled),
                    publisher: None,
                    exe_path: exe,
                });
            }
        }
        Ok(out)
    }

    pub(super) async fn set_enabled(location: &str, name: &str, enabled: bool, elevate: bool) -> Result<(), IpcError> {
        let Some((_, _, domain)) = dirs().into_iter().find(|(d, _, _)| d.display().to_string() == location) else {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(location)));
        };
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err(IpcError::new(ErrorCode::NotFound, text::startup_bad_id(name)));
        }
        let verb = if enabled { "enable" } else { "disable" };
        let target = format!("{domain}/{name}");
        if domain == "system" {
            if !elevate {
                return Err(IpcError::new(ErrorCode::PermissionDenied, text::startup_needs_admin()));
            }
            return run_elevated(ElevatedProgram::Launchctl, &[verb.to_string(), target]).await;
        }
        let out = tokio::process::Command::new("/bin/launchctl")
            .args([verb, &target])
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::startup_write_failed(&target, e)))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(IpcError::new(
                ErrorCode::Io,
                text::startup_write_failed(&target, String::from_utf8_lossy(&out.stderr).trim()),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_startup_id_roundtrip_splits_at_first_bar() {
        let id = make_id("HKCU\\…\\Run", "a|b");
        assert_eq!(split_id(&id), Some(("HKCU\\…\\Run", "a|b")));
        assert_eq!(split_id("noBar"), None);
        assert_eq!(split_id("|x"), None);
        assert_eq!(split_id("loc|"), None);
    }

    #[test]
    fn pccare_startup_folder_name_must_stay_in_folder() {
        assert!(is_bare_file_name("Notion.lnk"));
        assert!(is_bare_file_name("my app.desktop"));
        assert!(!is_bare_file_name("C:\\Windows\\notepad.exe"));
        assert!(!is_bare_file_name("..\\x.lnk"));
        assert!(!is_bare_file_name("../x.desktop"));
        assert!(!is_bare_file_name("C:x.exe"));
        assert!(!is_bare_file_name(".."));
        assert!(!is_bare_file_name(""));
    }

    #[test]
    fn pccare_startup_approved_bytes_decode_and_encode() {
        assert!(approved_is_enabled(None));
        assert!(approved_is_enabled(Some(&[])));
        assert!(approved_is_enabled(Some(&[0x02, 0, 0, 0])));
        assert!(approved_is_enabled(Some(&[0x06])));
        assert!(!approved_is_enabled(Some(&[0x03, 0, 0, 0])));
        assert!(!approved_is_enabled(Some(&[0x07])));

        let on = approved_bytes(true, 0x0102_0304_0506_0708);
        assert_eq!(on, [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let off = approved_bytes(false, 0x0102_0304_0506_0708);
        assert_eq!(off, [3, 0, 0, 0, 8, 7, 6, 5, 4, 3, 2, 1]);
        assert!(approved_is_enabled(Some(&on)) && !approved_is_enabled(Some(&off)));
        assert_eq!(hex_upper(&off), "030000000807060504030201");
    }

    #[test]
    fn pccare_startup_exe_path_from_command() {
        assert_eq!(
            command_exe_path("\"C:\\Program Files\\App\\app.exe\" --tray").as_deref(),
            Some("C:\\Program Files\\App\\app.exe")
        );
        assert_eq!(command_exe_path("C:\\Tools\\x.EXE /min").as_deref(), Some("C:\\Tools\\x.EXE"));
        assert_eq!(command_exe_path("rundll32 foo.dll,Bar").as_deref(), Some("rundll32"));
        assert_eq!(command_exe_path("  "), None);
    }

    #[test]
    fn pccare_startup_desktop_hidden_roundtrip() {
        let src = "[Desktop Entry]\nName=Foo\nExec=foo --bg\nX-GNOME-Autostart-enabled=false\n[Desktop Action x]\nHidden=keep\n";
        assert_eq!(desktop_value(src, "Exec"), Some("foo --bg"));
        assert!(!desktop_is_enabled(src));
        let on = desktop_set_hidden(src, false);
        assert!(desktop_is_enabled(&on));
        assert!(on.contains("Hidden=keep"), "other groups stay untouched: {on}");
        let off = desktop_set_hidden(&on, true);
        assert!(!desktop_is_enabled(&off));
        assert_eq!(off.matches("Hidden=true").count(), 1);
        assert!(desktop_is_enabled("[Desktop Entry]\nName=Bar\n"));
        assert!(!desktop_is_enabled(&desktop_set_hidden("[Desktop Entry]\nName=Bar", true)));
    }

    #[test]
    fn pccare_startup_plist_and_print_disabled() {
        let xml = r#"<?xml version="1.0"?><plist><dict>
            <key>Label</key><string>com.example.agent</string>
            <key>ProgramArguments</key><array><string>/usr/bin/x</string><string>a&amp;b</string></array>
            <key>Disabled</key><true/>
        </dict></plist>"#;
        let p = parse_plist(xml);
        assert_eq!(p.label.as_deref(), Some("com.example.agent"));
        assert_eq!(p.arguments, vec!["/usr/bin/x".to_string(), "a&b".to_string()]);
        assert!(p.disabled);
        assert!(!parse_plist("<dict><key>Label</key><string>x</string></dict>").disabled);

        let out = "disabled services = {\n\t\"com.a\" => disabled\n\t\"com.b\" => enabled\n\t\"com.c\" => true\n}\n";
        assert_eq!(
            parse_print_disabled(out),
            vec![("com.a".to_string(), true), ("com.b".to_string(), false), ("com.c".to_string(), true)]
        );
    }
}
