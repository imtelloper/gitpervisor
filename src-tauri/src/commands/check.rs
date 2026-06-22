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
            reason: Some("PATH 및 표준 설치 경로에서 git을 찾지 못했습니다.".into()),
        };
    };

    match runner::run_git(None, &["--version"], runner::READ_TIMEOUT_SECS).await {
        Ok(out) if out.code == 0 => GitCheck {
            found: true,
            version: Some(out.stdout_str().trim().to_string()),
            path: Some(path.display().to_string()),
            reason: None,
        },
        Ok(out) => {
            let detail = out.stderr.trim();
            let reason = if detail.is_empty() {
                format!("git --version 실행 실패 (exit {})", out.code)
            } else {
                format!("git --version 실행 실패 (exit {}): {}", out.code, detail)
            };
            GitCheck {
                found: false,
                version: None,
                path: Some(path.display().to_string()),
                reason: Some(reason),
            }
        }
        Err(e) => GitCheck {
            found: false,
            version: None,
            path: Some(path.display().to_string()),
            reason: Some(format!("git 실행 오류: {}", e.message)),
        },
    }
}
