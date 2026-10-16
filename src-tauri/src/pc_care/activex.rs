//! ActiveX 컨트롤 목록·제거(DOCS/pc-care-design.md §4.8), Windows 전용.
//!
//! 제거는 항상 승격이다(HKLM) — 컨트롤 구현 파일 하나만 `regsvr32 /u /s` 후 Distribution Units 키를 지운다. 파일 자체는 남긴다.
//! 대상은 매번 레지스트리에서 다시 고른다(프런트가 넘긴 경로를 등록 해제하지 않는다) — `unregister_target` 참고.

use serde::Serialize;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_pccare_programs as text;
use crate::pc_care::installed_apps::is_braced_guid;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveXControl {
    pub clsid: String,
    pub name: String,
    pub version: Option<String>,
    pub codebase: Option<String>,
    pub files: Vec<String>,
    /// 포함 파일의 마지막 접근 시각 중 가장 최근 — "N일 동안 사용 안 함"의 근사(NTFS 접근 시각 갱신이 꺼져 있으면 부정확).
    pub last_used_ms: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActiveXList {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub controls: Vec<ActiveXControl>,
}

#[tauri::command(async)]
pub async fn activex_list() -> Result<ActiveXList, IpcError> {
    imp::list().await
}

#[tauri::command(async)]
pub async fn activex_remove(clsid: String) -> Result<(), IpcError> {
    // 승격 인자와 레지스트리 경로로 들어가는 값이라 형식을 먼저 엄격히 본다.
    if !is_braced_guid(&clsid) {
        return Err(IpcError::new(ErrorCode::Io, text::activex_bad_clsid(&clsid)));
    }
    imp::remove(&clsid).await
}

/// `InstalledVersion` 기본값은 `1,0,0,1` 처럼 쉼표로 적힌다 — 다른 버전 칸과 같은 점 표기로.
#[cfg_attr(not(windows), allow(dead_code))]
fn dotted_version(v: &str) -> String {
    v.trim().replace(',', ".")
}

/// 레지스트리 값마다 따옴표·대소문자·`\\?\` 접두가 제각각이라 비교 전에 맞춘다.
#[cfg_attr(not(windows), allow(dead_code))]
fn norm_path(p: &str) -> String {
    let p = p.trim().trim_matches('"').replace('/', "\\").to_lowercase();
    p.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(p)
}

/// System32·SysWOW64 아래 = OS·공용 런타임(oleaut32·msvbvm60·mfc42 …) — 컨트롤 고유 파일이 아니다.
#[cfg_attr(not(windows), allow(dead_code))]
fn in_system_dir(file: &str, system_root: &str) -> bool {
    let f = norm_path(file);
    let root = norm_path(system_root);
    let root = root.trim_end_matches('\\');
    ["system32", "syswow64"].iter().any(|d| f.starts_with(&format!(r"{root}\{d}\")))
}

/// 등록 해제할 파일 — 이 CLSID 를 구현하는 InprocServer32 파일이 DU 의 포함 파일에도 있을 때 그 하나뿐.
/// VB6·MFC CAB(국내 은행 컨트롤에 흔하다)은 msvbvm60·mfc42·oleaut32 같은 공용 런타임을 포함 파일로 적어 두는데,
/// 그것까지 `/u` 하면 다른 프로그램이, oleaut32 면 시스템 전체 OLE 자동화가 깨진다. 그래서 시스템 폴더·
/// SharedDLLs 참조가 둘 이상인 파일·.dll/.ocx 가 아닌 파일은 구현 파일이라도 건드리지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
fn unregister_target(
    inproc: Option<&str>,
    contained: &[String],
    system_root: &str,
    shared_count: impl Fn(&str) -> Option<u32>,
) -> Option<String> {
    let n = norm_path(inproc?);
    let file = contained.iter().find(|f| norm_path(f) == n)?;
    let com_module = n.ends_with(".dll") || n.ends_with(".ocx");
    (com_module && !in_system_dir(file, system_root) && shared_count(file).unwrap_or(0) <= 1).then(|| file.clone())
}

#[cfg(windows)]
mod imp {
    use std::path::Path;
    use std::time::UNIX_EPOCH;

    use windows_registry::{Key, CLASSES_ROOT, LOCAL_MACHINE};
    use windows_sys::Win32::System::Registry::{KEY_WOW64_32KEY, KEY_WOW64_64KEY};

    use super::*;
    use crate::pc_care::elevate::{run_elevated, ElevatedProgram};
    use crate::pc_care::installed_apps::{expand_env_vars, reg_string};

    const DU_PATH: &str = r"SOFTWARE\Microsoft\Code Store Database\Distribution Units";
    const SHARED_DLLS_PATH: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\SharedDLLs";
    const HRESULT_FILE_NOT_FOUND: i32 = 0x8007_0002_u32 as i32;
    // 32비트 IE 가 깐 컨트롤이 대부분 WOW6432Node 쪽에 있다.
    const VIEWS: [(u32, &str); 2] = [(KEY_WOW64_64KEY, "/reg:64"), (KEY_WOW64_32KEY, "/reg:32")];

    fn open_du(flag: u32) -> Result<Option<Key>, IpcError> {
        match LOCAL_MACHINE.options().read().access(flag).open(DU_PATH) {
            Ok(k) => Ok(Some(k)),
            // ActiveX 를 한 번도 받지 않은 PC(요즘 대부분)에는 키가 없다.
            Err(e) if e.code().0 == HRESULT_FILE_NOT_FOUND => Ok(None),
            Err(e) => Err(IpcError::new(ErrorCode::Io, text::app_registry_read_failed(DU_PATH, e))),
        }
    }

    fn contained_files(du: &Key) -> Vec<String> {
        // Contains\Files 는 값 **이름**이 파일 경로다. 없는 DU(자바 패키지 등)는 파일 없이 둔다.
        du.open(r"Contains\Files")
            .and_then(|k| k.values().map(|it| it.map(|(name, _)| name).filter(|n| !n.is_empty()).collect()))
            .unwrap_or_default()
    }

    fn system_root() -> String {
        std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
    }

    /// DU 를 찾은 뷰와 같은 뷰의 HKCR\CLSID — 32비트 컨트롤은 WOW6432Node 쪽에만 등록돼 있다.
    fn clsid_key(flag: u32, clsid: &str) -> Option<Key> {
        CLASSES_ROOT.options().read().access(flag).open(format!(r"CLSID\{clsid}")).ok()
    }

    fn control_file(flag: u32, clsid: &str, contained: &[String]) -> Option<String> {
        let inproc = clsid_key(flag, clsid)
            .and_then(|k| k.open("InprocServer32").ok())
            .and_then(|k| reg_string(&k, ""))
            .map(|p| expand_env_vars(&p, |n| std::env::var(n).ok()));
        let shared = LOCAL_MACHINE.options().read().access(flag).open(SHARED_DLLS_PATH).ok();
        unregister_target(inproc.as_deref(), contained, &system_root(), |f| {
            shared.as_ref().and_then(|k| k.get_u32(f).ok())
        })
    }

    fn read_control(du_root: &Key, flag: u32, clsid: &str) -> Option<ActiveXControl> {
        let du = du_root.open(clsid).ok()?;
        let files = contained_files(&du);
        let name = reg_string(&du, "")
            .or_else(|| clsid_key(flag, clsid).and_then(|k| reg_string(&k, "")))
            .unwrap_or_else(|| clsid.to_string());
        let root = system_root();
        // 공용 런타임은 다른 프로그램이 늘 열어 접근 시각이 최근이라 컨트롤을 "방금 씀"으로 보이게 한다.
        let last_used_ms = files
            .iter()
            .filter(|f| !in_system_dir(f, &root))
            .filter_map(|f| std::fs::metadata(f).and_then(|m| m.accessed()).ok())
            .filter_map(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .max();
        Some(ActiveXControl {
            clsid: clsid.to_string(),
            name,
            version: du.open("InstalledVersion").ok().and_then(|k| reg_string(&k, "")).map(|v| dotted_version(&v)),
            codebase: du.open("DownloadInformation").ok().and_then(|k| reg_string(&k, "CODEBASE")),
            files,
            last_used_ms,
        })
    }

    fn list_blocking() -> Result<ActiveXList, IpcError> {
        let mut controls: Vec<ActiveXControl> = Vec::new();
        for (flag, _) in VIEWS {
            let Some(root) = open_du(flag)? else { continue };
            let subs: Vec<String> = root
                .keys()
                .map_err(|e| IpcError::new(ErrorCode::Io, text::app_registry_read_failed(DU_PATH, e)))?
                .collect();
            // CLSID 가 아닌 DU(자바 패키지 이름 등)는 제거 경로가 CLSID 검증을 요구하므로 목록에서도 뺀다.
            for clsid in subs.iter().filter(|s| is_braced_guid(s)) {
                if controls.iter().any(|c| c.clsid.eq_ignore_ascii_case(clsid)) {
                    continue;
                }
                controls.extend(read_control(&root, flag, clsid));
            }
        }
        controls.sort_by_key(|c| c.name.to_lowercase());
        Ok(ActiveXList { supported: true, unsupported_reason: None, controls })
    }

    pub(super) async fn list() -> Result<ActiveXList, IpcError> {
        tokio::task::spawn_blocking(list_blocking)
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_registry_read_failed(DU_PATH, e)))?
    }

    /// (reg.exe 뷰 플래그, 등록 해제할 파일) — 이 CLSID 가 등록된 뷰마다.
    fn find_registrations(clsid: &str) -> Result<Vec<(&'static str, Option<String>)>, IpcError> {
        let mut found = Vec::new();
        for (flag, reg_view) in VIEWS {
            if let Some(root) = open_du(flag)? {
                if let Ok(du) = root.open(clsid) {
                    found.push((reg_view, control_file(flag, clsid, &contained_files(&du))));
                }
            }
        }
        Ok(found)
    }

    pub(super) async fn remove(clsid: &str) -> Result<(), IpcError> {
        let id = clsid.to_string();
        let found = tokio::task::spawn_blocking(move || find_registrations(&id))
            .await
            .map_err(|e| IpcError::new(ErrorCode::Io, text::app_registry_read_failed(DU_PATH, e)))??;
        if found.is_empty() {
            return Err(IpcError::new(ErrorCode::NotFound, text::activex_not_found(clsid)));
        }
        // ponytail: 단계마다 UAC 창이 한 번씩 뜬다 — elevate 가 고정 프로그램 하나씩만 승격하기 때문. 묶으려면 elevate 에 배치 실행을 더한다.
        for (reg_view, file) in &found {
            if let Some(file) = file.as_ref().filter(|f| Path::new(f).is_file()) {
                match run_elevated(ElevatedProgram::Regsvr32, &["/u".into(), "/s".into(), file.clone()]).await {
                    Ok(()) => {}
                    Err(e) if matches!(e.code, ErrorCode::Cancelled) => return Err(e),
                    // 등록 해제 진입점이 없거나 이미 깨진 파일도 DU 키는 지워야 목록에서 사라진다 — 기록만 하고 계속.
                    Err(e) => log::warn!("[pccare] regsvr32 /u 실패 {file}: {}", e.message),
                }
            }
            let key = format!(r"HKLM\{DU_PATH}\{clsid}");
            run_elevated(ElevatedProgram::Reg, &["delete".into(), key, "/f".into(), (*reg_view).into()]).await?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub(super) async fn list() -> Result<ActiveXList, IpcError> {
        Ok(ActiveXList {
            supported: false,
            unsupported_reason: Some(text::activex_unsupported().to_string()),
            controls: Vec::new(),
        })
    }

    pub(super) async fn remove(_clsid: &str) -> Result<(), IpcError> {
        Err(IpcError::new(ErrorCode::Io, text::activex_unsupported()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pccare_programs_activex_clsid_and_version() {
        assert!(is_braced_guid("{D27CDB6E-AE6D-11CF-96B8-444553540000}"));
        // 승격 인자로 가므로 경로·따옴표·공백이 섞인 값은 전부 거절.
        assert!(!is_braced_guid("{D27CDB6E-AE6D-11CF-96B8-444553540000}\\..\\Run"));
        assert!(!is_braced_guid("\"{D27CDB6E-AE6D-11CF-96B8-444553540000}\""));
        assert!(!is_braced_guid("{D27CDB6E AE6D-11CF-96B8-444553540000}"));
        assert!(!is_braced_guid(""));
        assert_eq!(dotted_version(" 1,0,0,12 "), "1.0.0.12");
    }

    #[test]
    fn pccare_programs_activex_unregisters_only_the_control_file() {
        let root = r"C:\Windows";
        let ocx = r"C:\Windows\Downloaded Program Files\BankSign.ocx".to_string();
        // VB6 CAB 이 실제로 적어 두는 모양 — 컨트롤 하나 + 공용 런타임 + inf.
        let files = vec![
            ocx.clone(),
            r"C:\Windows\SysWOW64\msvbvm60.dll".to_string(),
            r"C:\Windows\SysWOW64\oleaut32.dll".to_string(),
            r"C:\Windows\Downloaded Program Files\BankSign.inf".to_string(),
        ];
        let none = |_: &str| None;
        // 따옴표·대소문자가 달라도 같은 파일. Downloaded Program Files 는 SystemRoot 아래지만 시스템 폴더가 아니다.
        let inproc = r#""c:\windows\downloaded program files\banksign.ocx""#;
        assert_eq!(unregister_target(Some(inproc), &files, root, none), Some(ocx.clone()));
        // 구현 파일이 공용 런타임을 가리키면(잘못 등록된 경우) 아무것도 해제하지 않는다.
        assert_eq!(unregister_target(Some(r"C:\Windows\SysWOW64\oleaut32.dll"), &files, root, none), None);
        assert_eq!(unregister_target(Some(r"\\?\C:\WINDOWS\System32\x.ocx"), &[r"C:\Windows\System32\x.ocx".into()], root, none), None);
        // 포함 파일에 없는 구현 파일·구현 파일 정보 없음·COM 모듈이 아님 → 없음.
        assert_eq!(unregister_target(Some(r"D:\other\x.ocx"), &files, root, none), None);
        assert_eq!(unregister_target(None, &files, root, none), None);
        assert_eq!(unregister_target(Some(&files[3]), &files, root, none), None);
        // 다른 프로그램도 쓰는 파일(SharedDLLs 2 이상)은 건드리지 않는다.
        assert_eq!(unregister_target(Some(inproc), &files, root, |_| Some(2)), None);
        assert_eq!(unregister_target(Some(inproc), &files, root, |_| Some(1)), Some(ocx));
    }
}
