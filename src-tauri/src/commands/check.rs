use crate::git::runner;
use crate::git::types::GitCheck;

/// 앱 시작 게이트: git 실행 파일 존재 여부와 버전을 확인한다.
#[tauri::command]
pub async fn check_git() -> GitCheck {
    let Some(path) = runner::git_path() else {
        return GitCheck {
            found: false,
            version: None,
            path: None,
        };
    };

    let version = match runner::run_git(None, &["--version"], runner::READ_TIMEOUT_SECS).await {
        Ok(out) if out.code == 0 => Some(out.stdout_str().trim().to_string()),
        _ => None,
    };

    GitCheck {
        found: version.is_some(),
        version,
        path: Some(path.display().to_string()),
    }
}
