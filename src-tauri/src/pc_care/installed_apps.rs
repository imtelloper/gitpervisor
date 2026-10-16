//! 설치된 프로그램 목록·제거(DOCS/pc-care-design.md §4.7).
//!
//! 제거는 프로그램이 등록해 둔 제거 프로그램을 **셸 없이** 실행만 한다 — 진행·확인·UAC는 제거 프로그램이 스스로 띄운다.
//! 프런트는 불투명한 `id`만 넘기고, 실행할 명령은 매번 레지스트리에서 다시 읽는다(프런트 문자열을 실행하지 않는다).

use serde::Serialize;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare_programs as text;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum AppCategory {
    Security,
    Finance,
    Other,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum AppScope {
    User,
    Machine,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub publisher: Option<String>,
    pub version: Option<String>,
    pub install_date_ms: Option<i64>,
    pub size_bytes: Option<u64>,
    pub location: Option<String>,
    pub category: AppCategory,
    pub scope: AppScope,
    pub can_uninstall: bool,
    /// Linux 전용 — 앱이 대신 지우지 않고 사용자가 터미널에서 칠 명령(의존성 연쇄 삭제를 앱이 결정하지 않는다).
    pub uninstall_command: Option<String>,
}

#[tauri::command(async)]
pub async fn installed_apps_list() -> Result<Vec<InstalledApp>, IpcError> {
    let mut apps = imp::list().await?;
    apps.sort_by_key(|a| a.name.to_lowercase());
    Ok(apps)
}

#[tauri::command(async)]
pub async fn installed_app_uninstall(id: String) -> Result<(), IpcError> {
    imp::uninstall(&id).await
}

// ── 분류 ──
// GoClean 의 금융보안 제품명 목록(문자열 관찰)과 국내외 백신 이름. 금융보안을 먼저 본다 — "AhnLab Safe Transaction"은
// 게시자가 AhnLab 이라 백신 키워드에도 걸린다.
const FINANCE_KEYWORDS: &[&str] = &[
    "Veraport",
    "Wizvera",
    "AnySign",
    "TouchEn",
    "nxKey",
    "nProtect",
    "INISAFE",
    "MagicLine",
    "KSign",
    "XecureWeb",
    "IPinside",
    "Delfino",
    "ASTx",
    "AhnLab Safe Transaction",
    "CrossEx",
    "CrossWeb",
    "SignKorea",
    "UniSign",
    "K-Defense",
    "Interezen",
    "KICA",
    "Initech",
    "raonsecure",
    "공인인증", // i18n-ok: 제품명 일치용 분류 키워드
    "보안모듈", // i18n-ok: 제품명 일치용 분류 키워드
    // 영문 제품명이 키워드에 안 걸리는 인증서 모듈은 게시자의 한글 회사명으로 잡는다(실측: SecuKit NXS / 한국정보인증(주)).
    "SecuKit",
    "yessign",
    "한국정보인증", // i18n-ok: 게시자 일치용 분류 키워드
    "한국전자인증", // i18n-ok: 게시자 일치용 분류 키워드
    "금융결제원", // i18n-ok: 게시자 일치용 분류 키워드
];

const SECURITY_KEYWORDS: &[&str] = &[
    "V3",
    "AhnLab",
    "알약", // i18n-ok: 제품명 일치용 분류 키워드
    "ALYac",
    "Avast",
    "AVG",
    "Kaspersky",
    "Norton",
    "McAfee",
    "Bitdefender",
    "ESET",
    "Malwarebytes",
    "Trend Micro",
    "바이로봇", // i18n-ok: 제품명 일치용 분류 키워드
    "네이버 백신", // i18n-ok: 제품명 일치용 분류 키워드
];

/// 대소문자 무시 부분 일치. 4자 이하 영문 키워드는 단어 경계를 요구한다 — "ESET"이 "Reset", "KICA"가 "KiCad",
/// "V3"이 버전 표기 안의 글자에 걸리지 않게.
fn keyword_hit(hay_lower: &str, keyword: &str) -> bool {
    let kw = keyword.to_lowercase();
    if !kw.is_ascii() || kw.len() > 4 {
        return hay_lower.contains(&kw);
    }
    hay_lower.match_indices(&kw).any(|(i, m)| {
        let before = hay_lower[..i].chars().next_back();
        let after = hay_lower[i + m.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

pub(crate) fn classify_app(name: &str, publisher: Option<&str>) -> AppCategory {
    let hay = format!("{name} {}", publisher.unwrap_or("")).to_lowercase();
    if FINANCE_KEYWORDS.iter().any(|k| keyword_hit(&hay, k)) {
        AppCategory::Finance
    } else if SECURITY_KEYWORDS.iter().any(|k| keyword_hit(&hay, k)) {
        AppCategory::Security
    } else {
        AppCategory::Other
    }
}

// ── Windows 순수 규칙(테스트가 모든 OS에서 돈다) ──

/// 레지스트리 `InstallDate`(yyyymmdd) → UTC 자정 ms. 날짜뿐이라 프런트도 UTC로 그린다.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_install_date(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() != 8 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let date = chrono::NaiveDate::from_ymd_opt(s[..4].parse().ok()?, s[4..6].parse().ok()?, s[6..].parse().ok()?)?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

/// 업데이트·시스템 구성 요소·이름 없는 항목은 "프로그램 추가/제거"도 숨긴다 — 같은 규칙.
#[cfg_attr(not(windows), allow(dead_code))]
fn should_list_entry(name: Option<&str>, system_component: bool, has_parent: bool, release_type: Option<&str>) -> bool {
    let is_update = release_type
        .is_some_and(|r| ["update", "hotfix", "security update", "update rollup"].contains(&r.to_ascii_lowercase().as_str()));
    name.is_some_and(|n| !n.trim().is_empty()) && !system_component && !has_parent && !is_update
}

/// `<hive>|<view>|<subkey>` — hive HKLM/HKCU, view 64/32. 하위 키 이름에는 `\`가 올 수 없다.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_registry_app_id(id: &str) -> Option<(&str, &str, &str)> {
    let mut it = id.splitn(3, '|');
    let (hive, view, sub) = (it.next()?, it.next()?, it.next()?);
    let ok = matches!(hive, "HKLM" | "HKCU")
        && matches!(view, "64" | "32")
        && !sub.is_empty()
        && !sub.contains(['\\', '\0']);
    ok.then_some((hive, view, sub))
}

/// `{8-4-4-4-12}` 중괄호 GUID — Windows Installer 제품 코드·ActiveX CLSID 형식.
pub(crate) fn is_braced_guid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 38 || b[0] != b'{' || b[37] != b'}' {
        return false;
    }
    b[1..37].iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    })
}

/// `%NAME%` 치환(REG_EXPAND_SZ). 없는 변수는 Windows와 같이 글자 그대로 둔다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn expand_env_vars(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        let Some(len) = rest[start + 1..].find('%') else { break };
        let name = &rest[start + 1..start + 1 + len];
        out.push_str(&rest[..start]);
        match (!name.is_empty()).then(|| lookup(name)).flatten() {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[start..start + len + 2]),
        }
        rest = &rest[start + len + 2..];
    }
    out.push_str(rest);
    out
}

/// 제거 명령 → (프로그램, 나머지 인자 문자열). 따옴표 없는 `C:\Program Files\X\unins.exe /S`가 흔해서
/// 공백 분리 대신 `.exe`로 끝나는 가장 짧은 **존재하는** 앞부분을 찾고, 없으면 첫 토큰(`MsiExec.exe`처럼 이름만)을 쓴다.
#[cfg_attr(not(windows), allow(dead_code))]
fn split_program(cmd: &str, exists: impl Fn(&str) -> bool) -> Option<(String, String)> {
    let cmd = cmd.trim();
    if let Some(quoted) = cmd.strip_prefix('"') {
        let end = quoted.find('"')?;
        return Some((quoted[..end].to_string(), quoted[end + 1..].trim().to_string()));
    }
    let lower = cmd.to_ascii_lowercase();
    for (i, _) in lower.match_indices(".exe") {
        let end = i + 4;
        let at_boundary = lower[end..].chars().next().is_none_or(char::is_whitespace);
        if at_boundary && exists(&cmd[..end]) {
            return Some((cmd[..end].to_string(), cmd[end..].trim().to_string()));
        }
    }
    let first = cmd.split_whitespace().next()?;
    Some((first.to_string(), cmd[first.len()..].trim().to_string()))
}

/// MsiExec `/I{GUID}`(설치·수리)를 `/X{GUID}`(제거)로. 많은 MSI 제품이 UninstallString 에 `/I`를 적어 둔다.
#[cfg_attr(not(windows), allow(dead_code))]
fn normalize_msiexec_params(params: &str) -> String {
    params
        .split_whitespace()
        .map(|t| {
            let upper = t.to_ascii_uppercase();
            let is_install = (upper.starts_with("/I") || upper.starts_with("-I")) && (upper.len() == 2 || t[2..].starts_with('{'));
            if is_install {
                format!("/X{}", &t[2..])
            } else {
                t.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Linux 순수 파서 ──

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty() && *s != "(none)").map(str::to_string)
}

/// `dpkg-query -W -f '${db:Status-Abbrev}\t${Package}\t${Version}\t${Installed-Size}\t${Maintainer}\n'`.
/// 지웠지만 설정이 남은(rc) 패키지도 나오므로 `ii`만 남긴다.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_dpkg(out: &str) -> Vec<InstalledApp> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 4 || !f[0].starts_with("ii") || f[1].is_empty() {
                return None;
            }
            let publisher = non_empty(f.get(4).copied());
            Some(InstalledApp {
                id: format!("dpkg|{}", f[1]),
                name: f[1].to_string(),
                category: classify_app(f[1], publisher.as_deref()),
                publisher,
                version: non_empty(Some(f[2])),
                install_date_ms: None,
                size_bytes: f[3].trim().parse::<u64>().ok().map(|kb| kb * 1024),
                location: None,
                scope: AppScope::Machine,
                can_uninstall: false,
                uninstall_command: Some(format!("sudo apt remove {}", f[1])),
            })
        })
        .collect()
}

/// `rpm -qa --qf '%{NAME}\t%{VERSION}-%{RELEASE}\t%{SIZE}\t%{VENDOR}\t%{INSTALLTIME}\n'`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_rpm(out: &str) -> Vec<InstalledApp> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 5 || f[0].is_empty() || f[0] == "gpg-pubkey" {
                return None;
            }
            let publisher = non_empty(Some(f[3]));
            Some(InstalledApp {
                id: format!("rpm|{}", f[0]),
                name: f[0].to_string(),
                category: classify_app(f[0], publisher.as_deref()),
                publisher,
                version: non_empty(Some(f[1])),
                install_date_ms: f[4].trim().parse::<i64>().ok().map(|s| s * 1000),
                size_bytes: f[2].trim().parse().ok(),
                location: None,
                scope: AppScope::Machine,
                can_uninstall: false,
                // ponytail: dnf 가정 — zypper(openSUSE)·yum(구 RHEL)은 같은 자리에 이름만 바꿔 치면 된다.
                uninstall_command: Some(format!("sudo dnf remove {}", f[0])),
            })
        })
        .collect()
}

/// `flatpak list --app --columns=application,name,version,origin`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_flatpak(out: &str, user: bool) -> Vec<InstalledApp> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            let app_id = f.first().map(|s| s.trim()).filter(|s| !s.is_empty())?;
            let name = non_empty(f.get(1).copied()).unwrap_or_else(|| app_id.to_string());
            Some(InstalledApp {
                id: format!("flatpak|{app_id}"),
                category: classify_app(&name, None),
                name,
                publisher: None,
                version: non_empty(f.get(2).copied()),
                install_date_ms: None,
                size_bytes: None,
                location: None,
                scope: if user { AppScope::User } else { AppScope::Machine },
                can_uninstall: false,
                uninstall_command: Some(format!("flatpak uninstall {}{app_id}", if user { "--user " } else { "" })),
            })
        })
        .collect()
}

// ── macOS 순수 파서 ──

/// XML Info.plist 에서 `<key>K</key><string>V</string>` 값. 이진 plist면 None(버전 칸만 빈다).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn plist_xml_string(xml: &str, key: &str) -> Option<String> {
    let at = xml.find(&format!("<key>{key}</key>"))?;
    let rest = xml[at..].split_once("</key>")?.1.trim_start();
    let value = rest.strip_prefix("<string>")?.split_once("</string>")?.0.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(windows)]
/// 문자열 값(선택 필드) — 값이 없는 게 정상인 필드라 없음·형식 다름은 None.
/// 잘못된 UTF-16 하나로 항목 전체를 잃지 않게 lossy 로 읽는다.
pub(crate) fn reg_string(key: &windows_registry::Key, name: &str) -> Option<String> {
    let v = key.get_value(name).ok()?;
    if !matches!(v.ty(), windows_registry::Type::String | windows_registry::Type::ExpandString) {
        return None;
    }
    let w = v.as_wide();
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    let s = String::from_utf16_lossy(&w[..end]);
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use windows_registry::{Key, CURRENT_USER, LOCAL_MACHINE};
    use windows_sys::Win32::System::Registry::{KEY_WOW64_32KEY, KEY_WOW64_64KEY};

    use super::*;

    const UNINSTALL_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    // HKCU\Software 는 64/32 뷰가 같은 곳이라 한 번만 읽는다.
    const SOURCES: [(&str, &str); 3] = [("HKLM", "64"), ("HKLM", "32"), ("HKCU", "64")];
    const HRESULT_FILE_NOT_FOUND: i32 = 0x8007_0002_u32 as i32;

    fn open_uninstall_root(hive: &str, view: &str) -> windows_registry::Result<Key> {
        let root = if hive == "HKLM" { LOCAL_MACHINE } else { CURRENT_USER };
        let flag = if view == "32" { KEY_WOW64_32KEY } else { KEY_WOW64_64KEY };
        root.options().read().access(flag).open(UNINSTALL_PATH)
    }

    fn read_entry(root: &Key, hive: &str, view: &str, sub: &str) -> Option<InstalledApp> {
        // 열 수 없는 하위 키(권한·경합 삭제)는 그 항목만 빠진다 — 목록 전체를 실패시킬 이유가 아니다.
        let key = root.open(sub).ok()?;
        let name = reg_string(&key, "DisplayName");
        let listed = should_list_entry(
            name.as_deref(),
            key.get_u32("SystemComponent").ok() == Some(1),
            reg_string(&key, "ParentKeyName").is_some(),
            reg_string(&key, "ReleaseType").as_deref(),
        );
        if !listed {
            return None;
        }
        let name = name?;
        let publisher = reg_string(&key, "Publisher");
        let msi = key.get_u32("WindowsInstaller").ok() == Some(1) && is_braced_guid(sub);
        let lookup = |n: &str| std::env::var(n).ok();
        Some(InstalledApp {
            id: format!("{hive}|{view}|{sub}"),
            category: classify_app(&name, publisher.as_deref()),
            publisher,
            version: reg_string(&key, "DisplayVersion"),
            install_date_ms: reg_string(&key, "InstallDate").and_then(|d| parse_install_date(&d)),
            size_bytes: key.get_u32("EstimatedSize").ok().filter(|kb| *kb > 0).map(|kb| u64::from(kb) * 1024),
            // 따옴표로 감싸 등록하는 설치 프로그램이 있다.
            location: reg_string(&key, "InstallLocation").map(|l| expand_env_vars(l.trim_matches('"'), lookup)),
            scope: if hive == "HKCU" { AppScope::User } else { AppScope::Machine },
            can_uninstall: reg_string(&key, "UninstallString").is_some() || msi,
            uninstall_command: None,
            name,
        })
    }

    fn list_blocking() -> Result<Vec<InstalledApp>, IpcError> {
        let mut apps: Vec<InstalledApp> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (hive, view) in SOURCES {
            let root = match open_uninstall_root(hive, view) {
                Ok(k) => k,
                // HKCU 에 Uninstall 키가 아예 없는 계정이 흔하다.
                Err(e) if e.code().0 == HRESULT_FILE_NOT_FOUND => continue,
                Err(e) => {
                    let path = format!(r"{hive}\{UNINSTALL_PATH}");
                    return Err(IpcError::new(ErrorCode::Io, text::app_registry_read_failed(&path, e)));
                }
            };
            let subs: Vec<String> = root
                .keys()
                .map_err(|e| IpcError::new(ErrorCode::Io, text::app_registry_read_failed(UNINSTALL_PATH, e)))?
                .collect();
            for sub in subs {
                if let Some(app) = read_entry(&root, hive, view, &sub) {
                    // 64·32비트 뷰에 같은 제품이 둘 다 등록되는 설치 프로그램이 있다.
                    if seen.insert((app.name.to_lowercase(), app.version.clone())) {
                        apps.push(app);
                    }
                }
            }
        }
        Ok(apps)
    }

    pub(super) async fn list() -> Result<Vec<InstalledApp>, IpcError> {
        tokio::task::spawn_blocking(list_blocking)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_registry_read_failed(UNINSTALL_PATH, e)))?
    }

    /// 경로 없는 이름(`MsiExec.exe`, `rundll32`)은 System32 에서 찾는다 — 작업 폴더의 같은 이름이 이기지 않게.
    fn resolve_program(program: &str) -> PathBuf {
        let p = Path::new(program);
        if program.contains(['\\', '/']) {
            return p.to_path_buf();
        }
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let mut exe = PathBuf::from(root).join("System32").join(p);
        if exe.extension().is_none() {
            exe.set_extension("exe");
        }
        exe
    }

    /// 관리자 매니페스트(requireAdministrator)가 붙은 제거 프로그램은 CreateProcess 가 740 으로 거절한다.
    /// 셸의 기본 동사(open)로 실행하면 Windows 가 그 매니페스트대로 UAC 를 띄운다 — 우리가 승격하는 게 아니라
    /// 제거 프로그램이 원래 요구하는 권한 창이다(그래서 elevate.rs 의 runas 경로가 아니다).
    fn shell_open(program: &Path, params: &str) -> Result<(), IpcError> {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_CANCELLED};
        use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW};
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
        let file = wide(program.as_os_str());
        let params_w = wide(params.as_ref());
        let dir = program.parent().map(|d| wide(d.as_os_str()));
        // SAFETY: 0 으로 시작해 필요한 필드만 채운다. 버퍼들은 호출이 끝날 때까지 산다.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.lpFile = file.as_ptr();
        info.lpParameters = params_w.as_ptr();
        info.lpDirectory = dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr());
        info.nShow = SW_SHOWNORMAL;
        if unsafe { ShellExecuteExW(&mut info) } != 0 {
            return Ok(());
        }
        let err = unsafe { GetLastError() };
        if err == ERROR_CANCELLED {
            return Err(IpcError::new(ErrorCode::Cancelled, text::app_uninstall_cancelled()));
        }
        Err(IpcError::new(
            ErrorCode::Io,
            text::app_uninstall_spawn_failed(&program.to_string_lossy(), std::io::Error::from_raw_os_error(err as i32)),
        ))
    }

    fn uninstall_blocking(id: &str) -> Result<(), IpcError> {
        use windows_sys::Win32::Foundation::ERROR_ELEVATION_REQUIRED;
        let (hive, view, sub) =
            parse_registry_app_id(id).ok_or_else(|| IpcError::new(ErrorCode::Io, text::app_bad_id(id)))?;
        let missing = || IpcError::new(ErrorCode::NotFound, text::app_entry_missing(id));
        let key = open_uninstall_root(hive, view).and_then(|r| r.open(sub)).map_err(|_| missing())?;
        let msi_fallback = (key.get_u32("WindowsInstaller").ok() == Some(1) && is_braced_guid(sub))
            .then(|| format!("MsiExec.exe /X{sub}"));
        let cmd = reg_string(&key, "UninstallString")
            .or(msi_fallback)
            .ok_or_else(|| IpcError::new(ErrorCode::NotFound, text::app_no_uninstall_command(id)))?;
        let cmd = expand_env_vars(&cmd, |n| std::env::var(n).ok());
        let (program, params) = split_program(&cmd, |p| Path::new(p).is_file())
            .ok_or_else(|| IpcError::new(ErrorCode::Io, text::app_uninstall_parse_failed(&cmd)))?;
        let program = resolve_program(&program);
        if !program.is_file() {
            return Err(IpcError::new(ErrorCode::NotFound, text::app_uninstaller_missing(&program.to_string_lossy())));
        }
        let is_msi = program
            .file_stem()
            .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("msiexec"));
        let params = if is_msi { normalize_msiexec_params(&params) } else { params };

        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(&program);
        // 쪼갰다 다시 따옴표로 묶으면 `INSTALLDIR="C:\a b"`·NSIS `_?=C:\a b` 처럼 일부만 묶인 인자가
        // `"INSTALLDIR=C:\a b"` 로 바뀌어 msiexec·NSIS 가 못 알아본다 — 등록된 문자열 그대로(셸 없이) 넘긴다.
        command.raw_arg(&params);
        if let Some(dir) = program.parent() {
            command.current_dir(dir);
        }
        // 끝날 때까지 기다리지 않는다 — 제거 프로그램은 자기 창·확인·재부팅 안내를 띄우고, 결과는 목록을 다시 읽어 본다.
        match command.spawn() {
            Ok(_child) => Ok(()),
            Err(e) if e.raw_os_error() == Some(ERROR_ELEVATION_REQUIRED as i32) => shell_open(&program, &params),
            Err(e) => Err(IpcError::new(ErrorCode::Io, text::app_uninstall_spawn_failed(&program.to_string_lossy(), e))),
        }
    }

    pub(super) async fn uninstall(id: &str) -> Result<(), IpcError> {
        let id = id.to_string();
        tokio::task::spawn_blocking(move || uninstall_blocking(&id))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_uninstall_spawn_failed("", e)))?
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use crate::sysinfo_static::run_capture;

    fn on_path(tool: &str) -> bool {
        std::env::var_os("PATH")
            .is_some_and(|p| std::env::split_paths(&p).any(|d| d.join(tool).is_file()))
    }

    async fn capture(tool: &str, args: &[&str]) -> Result<String, IpcError> {
        run_capture(tool, args, 30)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_list_tool_failed(tool, &e)))
    }

    pub(super) async fn list() -> Result<Vec<InstalledApp>, IpcError> {
        let mut apps = Vec::new();
        let mut any_tool = false;
        if on_path("dpkg-query") {
            any_tool = true;
            let fmt = "${db:Status-Abbrev}\t${Package}\t${Version}\t${Installed-Size}\t${Maintainer}\n";
            apps.extend(parse_dpkg(&capture("dpkg-query", &["-W", "-f", fmt]).await?));
        } else if on_path("rpm") {
            any_tool = true;
            let fmt = "%{NAME}\t%{VERSION}-%{RELEASE}\t%{SIZE}\t%{VENDOR}\t%{INSTALLTIME}\n";
            apps.extend(parse_rpm(&capture("rpm", &["-qa", "--qf", fmt]).await?));
        }
        if on_path("flatpak") {
            any_tool = true;
            for (scope, user) in [("--system", false), ("--user", true)] {
                // 설치한 앱이 없는 범위는 출력이 비어 run_capture 가 Err 를 낸다 — 앱이 0개라는 뜻이라 건너뛴다.
                if let Ok(out) = run_capture("flatpak", &["list", "--app", scope, "--columns=application,name,version,origin"], 30).await {
                    apps.extend(parse_flatpak(&out, user));
                }
            }
        }
        if !any_tool {
            return Err(IpcError::new(ErrorCode::ToolNotFound, text::app_no_package_manager()));
        }
        Ok(apps)
    }

    pub(super) async fn uninstall(_id: &str) -> Result<(), IpcError> {
        Err(IpcError::new(ErrorCode::Io, text::app_uninstall_use_package_manager()))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::{Path, PathBuf};
    use std::time::UNIX_EPOCH;

    use super::*;

    fn roots() -> Vec<(PathBuf, AppScope)> {
        let mut r = vec![(PathBuf::from("/Applications"), AppScope::Machine)];
        if let Some(home) = std::env::var_os("HOME") {
            r.push((PathBuf::from(home).join("Applications"), AppScope::User));
        }
        r
    }

    fn read_app(path: &Path, scope: AppScope) -> Option<InstalledApp> {
        let name = path.file_stem()?.to_string_lossy().into_owned();
        let plist = std::fs::read_to_string(path.join("Contents/Info.plist")).unwrap_or_default();
        let version = plist_xml_string(&plist, "CFBundleShortVersionString")
            .or_else(|| plist_xml_string(&plist, "CFBundleVersion"));
        let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        let path_s = path.to_string_lossy().into_owned();
        Some(InstalledApp {
            id: format!("app|{path_s}"),
            category: classify_app(&name, None),
            name,
            publisher: None,
            version,
            install_date_ms: modified.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
            // ponytail: .app 크기는 재귀 합산이 수 초 걸려 뺐다 — 필요하면 행 펼칠 때 따로 잰다.
            size_bytes: None,
            location: Some(path_s),
            scope,
            can_uninstall: true,
            uninstall_command: None,
        })
    }

    pub(super) async fn list() -> Result<Vec<InstalledApp>, IpcError> {
        tokio::task::spawn_blocking(|| {
            let mut apps = Vec::new();
            for (root, scope) in roots() {
                let entries = match std::fs::read_dir(&root) {
                    Ok(e) => e,
                    // ~/Applications 는 없는 계정이 대부분이다.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => {
                        return Err(IpcError::new(ErrorCode::Io, text::app_read_dir_failed(&root.to_string_lossy(), e)))
                    }
                };
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().is_some_and(|e| e == "app") {
                        apps.extend(read_app(&p, scope));
                    }
                }
            }
            Ok(apps)
        })
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, text::app_read_dir_failed("/Applications", e)))?
    }

    pub(super) async fn uninstall(id: &str) -> Result<(), IpcError> {
        let bad = || IpcError::new(ErrorCode::Io, text::app_bad_id(id));
        let path = PathBuf::from(id.strip_prefix("app|").ok_or_else(bad)?);
        // 목록에 나온 자리(두 Applications 폴더 바로 아래의 .app)만 지운다 — id 를 조작해 다른 경로를 넘겨도 거절.
        let allowed = path.extension().is_some_and(|e| e == "app")
            && roots().iter().any(|(r, _)| path.parent() == Some(r.as_path()))
            && path.is_dir();
        if !allowed {
            return Err(bad());
        }
        let p = path.clone();
        tokio::task::spawn_blocking(move || trash::delete(&p))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_trash_failed(&path.to_string_lossy(), e)))?
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_trash_failed(&path.to_string_lossy(), e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_programs_classify_finance_security_other() {
        assert_eq!(classify_app("TouchEn nxKey with E2E for 32bit", Some("RaonSecure Co., Ltd.")), AppCategory::Finance);
        assert_eq!(classify_app("AhnLab Safe Transaction", Some("AhnLab, Inc.")), AppCategory::Finance);
        assert_eq!(classify_app("Veraport G3", Some("Wizvera")), AppCategory::Finance);
        assert_eq!(classify_app("공인인증서 관리 프로그램", None), AppCategory::Finance);
        assert_eq!(classify_app("SecuKit NXS", Some("한국정보인증(주)")), AppCategory::Finance);
        assert_eq!(classify_app("AhnLab V3 Lite", Some("AhnLab, Inc.")), AppCategory::Security);
        assert_eq!(classify_app("알약", Some("ESTsoft Corp.")), AppCategory::Security);
        assert_eq!(classify_app("ESET Security", Some("ESET, spol. s r.o.")), AppCategory::Security);
        assert_eq!(classify_app("Microsoft Defender", Some("Microsoft Corporation")), AppCategory::Other);
        // 짧은 키워드는 단어 경계 — 다른 단어 안에서 걸리면 안 된다.
        assert_eq!(classify_app("KiCad 8.0", Some("KiCad")), AppCategory::Other);
        assert_eq!(classify_app("Reset Tool", None), AppCategory::Other);
        assert_eq!(classify_app("Foo V3X", None), AppCategory::Other);
    }

    #[test]
    fn pccare_programs_install_date_and_filter() {
        assert_eq!(parse_install_date("20240115"), Some(1_705_276_800_000));
        assert_eq!(parse_install_date("2024-01-15"), None);
        assert_eq!(parse_install_date("20241345"), None);
        assert!(should_list_entry(Some("7-Zip"), false, false, None));
        assert!(!should_list_entry(None, false, false, None));
        assert!(!should_list_entry(Some("  "), false, false, None));
        assert!(!should_list_entry(Some("x"), true, false, None));
        assert!(!should_list_entry(Some("KB123"), false, true, None));
        assert!(!should_list_entry(Some("KB123"), false, false, Some("Security Update")));
    }

    #[test]
    fn pccare_programs_id_and_guid_validation() {
        assert_eq!(parse_registry_app_id("HKLM|32|7-Zip"), Some(("HKLM", "32", "7-Zip")));
        assert_eq!(parse_registry_app_id("HKCU|64|a|b"), Some(("HKCU", "64", "a|b")));
        assert_eq!(parse_registry_app_id("HKCR|64|x"), None);
        assert_eq!(parse_registry_app_id("HKLM|16|x"), None);
        assert_eq!(parse_registry_app_id("HKLM|64|..\\Run"), None);
        assert_eq!(parse_registry_app_id("HKLM|64|"), None);
        assert!(is_braced_guid("{23170F69-40C1-2702-2301-000001000000}"));
        assert!(!is_braced_guid("23170F69-40C1-2702-2301-000001000000"));
        assert!(!is_braced_guid("{23170F69-40C1-2702-2301-00000100000G}"));
        assert!(!is_braced_guid("{23170F69440C1-2702-2301-000001000000}"));
    }

    #[test]
    fn pccare_programs_split_uninstall_command() {
        let exists = |p: &str| p == r"C:\Program Files\Foo Bar\unins000.exe";
        assert_eq!(
            split_program(r"C:\Program Files\Foo Bar\unins000.exe /SILENT", exists),
            Some((r"C:\Program Files\Foo Bar\unins000.exe".into(), "/SILENT".into()))
        );
        assert_eq!(
            split_program(r#""C:\Program Files\X\u.exe" --uninstall "a b""#, |_| false),
            Some((r"C:\Program Files\X\u.exe".into(), r#"--uninstall "a b""#.into()))
        );
        assert_eq!(
            split_program("MsiExec.exe /I{23170F69-40C1-2702-2301-000001000000}", |_| false),
            Some(("MsiExec.exe".into(), "/I{23170F69-40C1-2702-2301-000001000000}".into()))
        );
        assert_eq!(split_program(r#""unterminated"#, |_| false), None);
        assert_eq!(split_program("   ", |_| false), None);
    }

    #[test]
    fn pccare_programs_msiexec_and_env_expansion() {
        assert_eq!(normalize_msiexec_params("/I{ABC} /qb"), "/X{ABC} /qb");
        assert_eq!(normalize_msiexec_params("/i {ABC}"), "/X {ABC}");
        assert_eq!(normalize_msiexec_params("/X{ABC}"), "/X{ABC}");
        assert_eq!(normalize_msiexec_params("/INSTALLDIR=x"), "/INSTALLDIR=x");
        let env = |n: &str| (n == "ProgramFiles").then(|| r"C:\Program Files".to_string());
        assert_eq!(expand_env_vars(r"%ProgramFiles%\X\u.exe", env), r"C:\Program Files\X\u.exe");
        assert_eq!(expand_env_vars("%NOPE%\\a 100%", env), "%NOPE%\\a 100%");
    }

    #[test]
    fn pccare_programs_linux_and_macos_parsers() {
        let dpkg = "ii \tcurl\t8.5.0-2\t500\tUbuntu Devs <u@x>\nrc \told\t1\t10\t\nii \tnolen\t1\t\t\n";
        let apps = parse_dpkg(dpkg);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].size_bytes, Some(512_000));
        assert_eq!(apps[0].uninstall_command.as_deref(), Some("sudo apt remove curl"));
        assert_eq!(apps[1].size_bytes, None);
        let rpm = parse_rpm("bash\t5.2-1\t8000\t(none)\t1700000000\ngpg-pubkey\t1-1\t0\t(none)\t0\n");
        assert_eq!(rpm.len(), 1);
        assert_eq!(rpm[0].publisher, None);
        assert_eq!(rpm[0].install_date_ms, Some(1_700_000_000_000));
        let fp = parse_flatpak("org.gimp.GIMP\tGNU Image Manipulation Program\t2.10\tflathub\n", true);
        assert_eq!(fp[0].uninstall_command.as_deref(), Some("flatpak uninstall --user org.gimp.GIMP"));
        assert_eq!(fp[0].scope, AppScope::User);
        let xml = "<dict>\n<key>CFBundleShortVersionString</key>\n\t<string>1.2.3</string>\n</dict>";
        assert_eq!(plist_xml_string(xml, "CFBundleShortVersionString").as_deref(), Some("1.2.3"));
        assert_eq!(plist_xml_string(xml, "CFBundleVersion"), None);
    }
}
