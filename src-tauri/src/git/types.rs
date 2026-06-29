use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub order: u32,
    pub added_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Typechange,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    pub staged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepoOpState {
    Normal,
    Merging,
    Rebasing,
    CherryPicking,
    Bisecting,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub project_id: String,
    pub branch: Option<String>,
    pub detached_sha: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub op_state: RepoOpState,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub untracked: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    /// 경로 소실·git 실패 등 — 값이 있으면 사이드바에서 회색(오류) 상태로 표시한다.
    pub error: Option<String>,
}

impl RepoStatus {
    pub fn empty(project_id: &str) -> Self {
        Self {
            project_id: project_id.to_string(),
            branch: None,
            detached_sha: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            op_state: RepoOpState::Normal,
            staged: Vec::new(),
            unstaged: Vec::new(),
            untracked: Vec::new(),
            conflicted: Vec::new(),
            error: None,
        }
    }

    pub fn with_error(project_id: &str, message: impl Into<String>) -> Self {
        let mut status = Self::empty(project_id);
        status.error = Some(message.into());
        status
    }
}

/// diff 내용은 패치가 아니라 양쪽 전체 텍스트 — Monaco DiffEditor가 비교를 수행한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub is_binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum DiffTarget {
    Worktree { path: String },
    // IPC 계약(설계 §7)의 일부 — 핸들러는 M3에서 구현되며 그때까지 필드를 읽지 않는다
    #[allow(dead_code)]
    Index { path: String },
    #[allow(dead_code)]
    Commit { sha: String, path: String },
    /// 트리에서 클릭한 단일 파일 보기 — 워크트리 내용만(diff 아님)
    #[allow(dead_code)]
    File { path: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheck {
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub reason: Option<String>,
}

// ---- M3: 히스토리 (로그 / 브랜치 / 커밋 상세) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    /// ISO 8601 (git %aI)
    pub authored_at: String,
    /// 데코레이션: ["HEAD -> main", "origin/main", "tag: v1.0"]
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// "origin/main" 형태
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub head: Option<String>,
    pub local: Vec<LocalBranch>,
    pub remote: Vec<RemoteBranch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub commit: Commit,
    pub files: Vec<CommitFile>,
}

// ---- M4: 설정 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// null/빈 문자열 = PATH 자동 탐색
    pub git_path: Option<String>,
    /// 0 = 자동 fetch 끔
    pub auto_fetch_minutes: u32,
    pub diff_font_size: u32,
    pub confirm_discard: bool,
    /// UI 테마 이름 ("darcula" | "monokai"). 검증·렌더는 프론트가 담당.
    pub theme: String,
    /// 임베디드 터미널 셸 (null/빈값 = 자동: pwsh→powershell→cmd / $SHELL)
    pub terminal_shell: Option<String>,
    pub terminal_font_size: u32,
    /// AI 작업 완료 알림 모드: "off" | "project-inactive" | "terminal" | "always"
    pub notify_mode: String,
    // ---- AI 완료 외부 알림 (Slack 웹훅 / SMTP email) ----
    // 시크릿(웹훅 URL·SMTP 비번)은 여기 두지 않고 OS 키링에 저장한다(notify.rs).
    pub slack_enabled: bool,
    pub email_enabled: bool,
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_from: Option<String>,
    pub smtp_to: Option<String>,
    /// true = 암호화(465 implicit TLS / 587 STARTTLS), false = 평문
    pub smtp_tls: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            git_path: None,
            auto_fetch_minutes: 0,
            diff_font_size: 13,
            confirm_discard: true,
            theme: "darcula".to_string(),
            terminal_shell: None,
            terminal_font_size: 13,
            notify_mode: "project-inactive".to_string(),
            slack_enabled: false,
            email_enabled: false,
            smtp_host: None,
            smtp_port: 587,
            smtp_username: None,
            smtp_from: None,
            smtp_to: None,
            smtp_tls: true,
        }
    }
}

// ---- 프로젝트 메모 (프로젝트당 여러 개) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memo {
    pub id: String,
    pub text: String,
    /// ISO 8601
    pub created_at: String,
    pub updated_at: String,
}

// ---- 파일 트리 탐색기 ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    /// .gitignore에 의해 무시되는 항목 (.git 포함) — UI에서 흐리게 표시
    pub is_ignored: bool,
}
