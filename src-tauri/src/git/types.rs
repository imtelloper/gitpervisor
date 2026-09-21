use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub order: u32,
    pub added_at: String,
    /// 수동 지정 로고의 레포 상대경로(forward-slash). None = 자동 감지(commands/logo.rs).
    /// `#[serde(default)]` — 이 필드가 없는 옛 projects.json이 그대로 읽혀야 한다(격리 금지).
    #[serde(default)]
    pub logo: Option<String>,
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
    /// 이 status가 임베디드(중첩) 저장소면 그 부모 프로젝트 id. 최상위 프로젝트는 None.
    /// 프론트는 배치에서 parent_id == 선택 프로젝트 인 항목을 Changes 패널에 별도 섹션으로 렌더한다.
    pub parent_id: Option<String>,
    /// 임베디드 저장소의 부모 루트 기준 상대 경로(예: "APPLICATION/nexus-application"). 최상위는 None.
    pub rel_path: Option<String>,
    /// 이 프로젝트에 속한 (모든 깊이의) 임베디드 저장소들의 변경 총합 — 사이드바 뱃지/점 표시용.
    pub nested_changes: u32,
    /// 배경/수동 fetch 마지막 성공 시각(ISO 8601) — get_statuses가 freshness 맵을 조인해 채운다.
    pub last_fetch_at: Option<String>,
    /// 마지막 배경 fetch 실패 사유 — 조용한 배지(CloudOff)용. None=정상.
    pub fetch_error: Option<String>,
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
            parent_id: None,
            rel_path: None,
            nested_changes: 0,
            last_fetch_at: None,
            fetch_error: None,
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
    /// 이 내용을 **무엇으로 읽었는지**(encoding_rs 정규 이름: "UTF-8" / "EUC-KR" / "UTF-16LE" …).
    /// 저장할 때 그대로 되돌려 보내야 원본 인코딩이 유지된다(설계 B-K1·B-K3). 이 필드가
    /// 왕복하지 않으면 CP949 파일이 저장 한 번에 UTF-8 로 통째 변환된다(동의 없는 파일 변경).
    pub encoding: String,
    /// 원본에 BOM 이 있었다(텍스트에는 포함돼 있지 않다) — 저장 시 다시 붙인다.
    pub bom: bool,
    /// 어떤 인코딩으로도 깨끗이 읽지 못했다(치환 문자 발생). 프론트는 **읽기 전용**으로 연다 —
    /// 이 상태로 저장하면 읽으면서 잃은 바이트가 그대로 디스크에 박힌다.
    pub lossy: bool,
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

/// 즐겨찾기 폴더 한 칸 — `path` 는 절대경로, `name` 은 드롭다운 표시용(기본 = 폴더명).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteFolder {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// null/빈 문자열 = PATH 자동 탐색
    pub git_path: Option<String>,
    /// 원격 새로고침(배경 fetch) 주기 — 0 = 끔, 기본 5분. 구 auto_fetch_minutes를 대체하며
    /// 저장값에 이 키가 없으면 로드 시 1회 마이그레이션한다(state.rs, 태스크 04 §3.7).
    pub remote_refresh_minutes: u32,
    pub diff_font_size: u32,
    pub confirm_discard: bool,
    /// UI 테마 이름 ("darcula" | "monokai" | "light" | "dracula" | "nord" | "solarized-light").
    /// 자유 문자열 통과 — 검증·렌더는 프론트(themes.ts, 미지 id는 darcula 폴백)가 담당.
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
    // ---- 포매터/린터 외부 도구 (태스크 15/16) ----
    /// ruff/biome 명시 경로 (null/빈값 = 자동 발견: PATH). 지정 시 그것만 사용(폴백 금지).
    pub formatter_ruff_path: Option<String>,
    pub formatter_biome_path: Option<String>,
    /// 프로젝트 로컬 바이너리(node_modules/.bin·.venv) 실행 허용 — 기본 false(공급망 위험).
    /// 이 옵트인은 린트(파일 열람만으로 자동 실행)에도 적용된다 — 열람=실행으로 위험 확대.
    pub formatter_project_local: bool,
    /// 저장 시 자동 포맷 — 기본 false.
    pub format_on_save: bool,
    /// LSP 활성 프로젝트 id 목록 — 옵트인 기본 빈(전부 OFF). 태스크 17 §3.4.
    pub lsp_enabled_projects: Vec<String>,
    /// 워크스페이스 node_modules/typescript를 tsserver로 쓰기(옵트인 기본 false — 레포 공급 코드
    /// 실행 공급망 표면, §3.2). false면 관리 사본 typescript 사용.
    pub lsp_workspace_tsserver: bool,
    /// ffmpeg 명시 경로 (null/빈값 = 자동 발견: PATH → 관리 설치본). 지정 시 그것만(폴백 금지).
    pub video_ffmpeg_path: Option<String>,
    // ---- 로컬 LLM (태스크 59 §3.6) ----
    /// "managed"(앱이 llama-server를 관리) | "external"(이미 쓰는 Ollama/LM Studio 등)
    pub llm_provider: String,
    /// 카탈로그 id(llm/acquire.rs MODELS) 또는 "custom".
    pub llm_model: String,
    /// 작업 리포트 요약·채팅(60·67)에만 쓸 모델. null/빈값 = `llm_model` 을 쓴다.
    ///
    /// **왜 갈랐나**: 요약은 예약·배치로 돌려 기다려도 되고 정확도가 돈이 되지만(태스크 70 §8 —
    /// Gemma 4 12B 가 블라인드 14.11 vs 8B 9.22), 번역·대화는 즉답이라 같은 모델이면 답답하다.
    /// 다만 **서버는 한 번에 한 모델만** 물고 있으므로(`ensure_server`) 두 기능을 번갈아 쓰면
    /// 매번 죽였다 다시 띄운다(12B 로드 ~7~25초). 그래서 기본은 null(=하나만 쓰기)이다.
    pub llm_report_model: Option<String>,
    /// llm_model == "custom"일 때 쓸 절대경로 .gguf.
    pub llm_custom_model_path: Option<String>,
    /// 외부 OpenAI 호환 base URL — 예: http://localhost:11434/v1
    pub llm_external_url: Option<String>,
    /// 외부 서버의 모델 이름 — 예: qwen3:4b
    pub llm_external_model: Option<String>,
    /// 외부 서버 API 키. 시크릿이지만 **로컬 서버용**이라 키링을 쓰지 않는다(§7).
    /// 원격 OpenAI 호환 서비스를 지원하게 되면 notify_set_secret 관례로 옮긴다.
    pub llm_external_key: Option<String>,
    /// GPU 오프로드 레이어 수(-ngl). 기본 99 = 가능한 만큼 전부.
    pub llm_gpu_layers: u32,
    /// 컨텍스트 길이(-c). 저장 시 2048..32768로 클램프한다.
    pub llm_context: u32,
    /// 요약·번역 기본 출력 언어 ("ko" | "en").
    pub llm_language: String,
    /// "auto" | "cpu" — Windows Vulkan 초기화 실패 시 폴백이 여기에 "cpu"를 기록한다.
    pub llm_backend: String,
    /// 즐겨찾기 폴더 (태스크 66). **이 목록이 곧 `commands/favorites.rs` 의 허용 루트다** —
    /// 등록되지 않은 경로는 읽기·썸네일·열기가 전부 거부된다. 비어 있으면 폴더 창을 열 수 없다.
    pub favorite_folders: Vec<FavoriteFolder>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            git_path: None,
            remote_refresh_minutes: 5,
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
            formatter_ruff_path: None,
            formatter_biome_path: None,
            formatter_project_local: false,
            format_on_save: false,
            lsp_enabled_projects: Vec::new(),
            lsp_workspace_tsserver: false,
            video_ffmpeg_path: None,
            llm_provider: "managed".to_string(),
            llm_model: "qwen3-4b-q4".to_string(),
            llm_report_model: None,
            llm_custom_model_path: None,
            llm_external_url: None,
            llm_external_model: None,
            llm_external_key: None,
            llm_gpu_layers: 99,
            llm_context: 8192,
            llm_language: "ko".to_string(),
            llm_backend: "auto".to_string(),
            favorite_folders: Vec::new(),
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
