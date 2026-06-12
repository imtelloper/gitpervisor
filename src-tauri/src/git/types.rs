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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheck {
    pub found: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}
