use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotARepo,
    GitNotFound,
    DuplicateProject,
    NotFound,
    Timeout,
    GitError,
    OpInProgress,
    AuthFailed,
    Io,
    // API 클라이언트 HTTP 엔진 (DOCS/api-client-design.md §4.8)
    Network,
    DnsFailure,
    ConnectionRefused,
    TlsError,
    Cancelled,
    InvalidUrl,
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
