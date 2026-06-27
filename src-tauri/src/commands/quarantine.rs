//! macOS Gatekeeper 격리 속성(com.apple.quarantine) 검사·해제.
//! brew cask, /usr/local/bin, ~/.local/bin, nvm 글로벌 등 사용자가 PATH로 부르는 CLI
//! 바이너리에 격리 속성이 박혀 터미널 실행이 "permission denied"로 막히는 케이스를
//! 한 번에 잡는다. 심볼릭 링크는 타겟을 따라가 확인하고, 정규화 경로로 중복 제거한다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedItem {
    /// 격리 속성이 박힌 실제 실행 파일 절대경로 (심볼릭 링크는 따라간 후의 타겟)
    pub path: String,
    /// 사용자가 부를 때 사용하는 파일명/명령 이름
    pub name: String,
    /// 출처 식별자 — brew cask 이름이거나, "/usr/local/bin", "nvm:v22.12.0" 등
    pub cask: String,
}

#[cfg(target_os = "macos")]
fn has_quarantine(path: &Path) -> bool {
    std::process::Command::new("xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(path)
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn is_executable_file(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

/// 한 항목을 검사해 격리되어 있으면 results에 추가한다. 정규화 경로로 dedup.
#[cfg(target_os = "macos")]
fn check_and_add(
    entry_path: &Path,
    source: &str,
    results: &mut HashMap<String, QuarantinedItem>,
) {
    let real = std::fs::canonicalize(entry_path).unwrap_or_else(|_| entry_path.to_path_buf());
    // .app 번들은 Finder가 자체 흐름으로 처리 — 제외
    if real.extension().map(|e| e == "app").unwrap_or(false) {
        return;
    }
    let Ok(meta) = std::fs::metadata(&real) else {
        return;
    };
    if !is_executable_file(&meta) {
        return;
    }
    if !has_quarantine(&real) {
        return;
    }
    let key = real.display().to_string();
    if results.contains_key(&key) {
        return;
    }
    // 표시 이름은 사용자가 부를 때 쓰는 원본 경로의 파일명 (심볼릭 링크라면 그 이름)
    let name = entry_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| key.clone());
    results.insert(
        key.clone(),
        QuarantinedItem {
            path: key,
            name,
            cask: source.to_string(),
        },
    );
}

/// Caskroom 구조: `<root>/<cask>/<version>/<file>`. cask 이름을 source로 쓴다.
#[cfg(target_os = "macos")]
fn scan_caskroom(root: &Path, results: &mut HashMap<String, QuarantinedItem>) {
    let Ok(casks) = std::fs::read_dir(root) else {
        return;
    };
    for cask_entry in casks.flatten() {
        let cask_path = cask_entry.path();
        if !cask_path.is_dir() {
            continue;
        }
        let cask_name = cask_entry.file_name().to_string_lossy().into_owned();
        let Ok(versions) = std::fs::read_dir(&cask_path) else {
            continue;
        };
        for ver_entry in versions.flatten() {
            let ver_path = ver_entry.path();
            if !ver_path.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&ver_path) else {
                continue;
            };
            for f in files.flatten() {
                check_and_add(&f.path(), &cask_name, results);
            }
        }
    }
}

/// 평탄 bin 디렉토리(/usr/local/bin, ~/.local/bin, nvm bin 등)를 한 단계 스캔.
#[cfg(target_os = "macos")]
fn scan_flat_bin(dir: &Path, source: &str, results: &mut HashMap<String, QuarantinedItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        check_and_add(&entry.path(), source, results);
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn scan_quarantined_tools() -> Vec<QuarantinedItem> {
    let mut results: HashMap<String, QuarantinedItem> = HashMap::new();

    // 1) brew Caskroom (Intel + Apple Silicon)
    for caskroom in ["/usr/local/Caskroom", "/opt/homebrew/Caskroom"] {
        scan_caskroom(Path::new(caskroom), &mut results);
    }

    // 2) 평탄 bin 디렉토리 — 사용자가 PATH로 부르는 명령들이 사는 곳
    let mut flat_dirs: Vec<(PathBuf, String)> = vec![
        (PathBuf::from("/usr/local/bin"), "/usr/local/bin".to_string()),
        (PathBuf::from("/opt/homebrew/bin"), "/opt/homebrew/bin".to_string()),
    ];

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        flat_dirs.push((home.join(".local/bin"), "~/.local/bin".to_string()));

        // nvm — 설치된 모든 node 버전의 bin 디렉토리를 각각 스캔
        let nvm_versions = home.join(".nvm/versions/node");
        if let Ok(versions) = std::fs::read_dir(&nvm_versions) {
            for v in versions.flatten() {
                let bin = v.path().join("bin");
                if bin.is_dir() {
                    let label =
                        format!("nvm:{}", v.file_name().to_string_lossy());
                    flat_dirs.push((bin, label));
                }
            }
        }
    }

    for (dir, source) in flat_dirs {
        scan_flat_bin(&dir, &source, &mut results);
    }

    let mut items: Vec<QuarantinedItem> = results.into_values().collect();
    items.sort_by(|a, b| a.path.cmp(&b.path));
    items
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn scan_quarantined_tools() -> Vec<QuarantinedItem> {
    Vec::new()
}

/// 받은 경로에 대해 `xattr -d com.apple.quarantine`을 실행한다.
/// 이미 해제된 항목("No such xattr")은 성공으로 간주한다.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn clear_quarantine(paths: Vec<String>) -> Result<(), crate::error::IpcError> {
    use crate::error::{ErrorCode, IpcError};
    for p in &paths {
        let out = std::process::Command::new("xattr")
            .args(["-d", "com.apple.quarantine"])
            .arg(p)
            .output()
            .map_err(|e| IpcError::new(ErrorCode::Io, format!("xattr 실행 실패: {e}")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            if !stderr.contains("No such xattr") && !stderr.trim().is_empty() {
                return Err(IpcError::new(
                    ErrorCode::Io,
                    format!("격리 해제 실패 ({}): {}", p, stderr.trim()),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn clear_quarantine(_paths: Vec<String>) -> Result<(), crate::error::IpcError> {
    Ok(())
}
