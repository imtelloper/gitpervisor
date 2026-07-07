use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // 비-git 폴더 등록 허용 이후 현재 Rust에서는 발화하지 않지만, IPC 코드 안정성을 위해 유지.
    #[allow(dead_code)]
    NotARepo,
    GitNotFound,
    DuplicateProject,
    NotFound,
    Timeout,
    GitError,
    OpInProgress,
    AuthFailed,
    Io,
    /// 대상이 이미 존재함 (새 폴더·이미지 변환 저장 충돌). 프론트는 이 코드로 덮어쓰기 확인을 띄운다.
    AlreadyExists,
    // API 클라이언트 HTTP 엔진 (DOCS/api-client-design.md §4.8)
    Network,
    DnsFailure,
    ConnectionRefused,
    TlsError,
    Cancelled,
    InvalidUrl,
    // 외부 도구(ruff/biome 등) 미설치 — 프론트는 설치 안내 토스트를 띄운다(태스크 15/16).
    ToolNotFound,
}

/// 모든 IPC 커맨드의 공통 오류 형태. 프론트엔드는 code로 분기하고 stderr를 상세로 노출한다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub stderr: Option<String>,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            stderr: None,
        }
    }

    pub fn git(message: impl Into<String>, stderr: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::GitError,
            message: message.into(),
            stderr: Some(stderr.into()),
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for IpcError {}
