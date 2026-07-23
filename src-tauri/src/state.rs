use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::{BrowserReg, HttpReg, TerminalSession};
use crate::error::{ErrorCode, IpcError};
use crate::fetch_scheduler::RemoteFreshness;
use crate::git::types::{Memo, Project, Settings};
use crate::monitor::Monitor;
use crate::watcher::RepoWatcher;

pub const STORE_FILE: &str = "projects.json";
pub const STORE_KEY: &str = "projects";
pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_KEY: &str = "settings";
pub const NOTES_FILE: &str = "notes.json";
pub const NOTES_KEY: &str = "notes";

pub type Notes = HashMap<String, Vec<Memo>>;

pub struct AppState {
    pub projects: RwLock<Vec<Project>>,
    pub settings: RwLock<Settings>,
    /// 진행 중인 쓰기 작업(stage/commit/push 등)의 프로젝트 id — 레포당 1개만 허용
    ops: Arc<Mutex<HashSet<String>>>,
    pub watchers: Mutex<HashMap<String, RepoWatcher>>,
    /// 열려 있는 임베디드 터미널 세션 (termId → PTY 핸들). M5 §16.
    pub terminals: Mutex<HashMap<String, TerminalSession>>,
    /// 타이틀바 시스템 모니터(CPU/GPU/RAM/저장소) — 폴링 시 갱신.
    pub monitor: Mutex<Monitor>,
    /// 프로젝트별 메모 (projectId → 메모).
    pub notes: RwLock<Notes>,
    /// 임베디드 브라우저 자식 webview 레지스트리 (browserId → 마지막 bounds). browser.rs §.
    pub browser: Mutex<BrowserReg>,
    /// API 클라이언트 in-flight HTTP 요청 레지스트리 (requestId → AbortHandle). http.rs §4.9.
    pub http: Mutex<HttpReg>,
    /// 배경 fetch 결과 (projectId → freshness) — fetch_scheduler가 갱신하고
    /// get_statuses가 조인해 RepoStatus에 실어 보낸다 (태스크 04 §3.5).
    pub freshness: RwLock<HashMap<String, RemoteFreshness>>,
    /// LSP 세션 레지스트리 ("{projectId}:{lang}" → 서버) — 장수 child, 태스크 17.
    pub lsp: Mutex<HashMap<String, crate::commands::LspSession>>,
    /// 리소스 모니터 프로세스 아이콘 캐시 (exe 경로 → base64 PNG). 모니터와 별도 뮤텍스라
    /// 아이콘 추출이 2s 폴링을 막지 않는다.
    pub icons: crate::proc_icons::IconCache,
}

impl AppState {
    pub fn new(projects: Vec<Project>, settings: Settings, notes: Notes) -> Self {
        Self {
            projects: RwLock::new(projects),
            settings: RwLock::new(settings),
            ops: Arc::new(Mutex::new(HashSet::new())),
            watchers: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            monitor: Mutex::new(Monitor::new()),
            notes: RwLock::new(notes),
            browser: Mutex::new(BrowserReg::default()),
            http: Mutex::new(HttpReg::default()),
            freshness: RwLock::new(HashMap::new()),
            lsp: Mutex::new(HashMap::new()),
            icons: crate::proc_icons::IconCache::default(),
        }
    }

    /// 쓰기 작업 시작. 같은 레포에 이미 진행 중이면 큐잉하지 않고 즉시 거절한다 (설계 §8).
    pub fn try_begin_op(&self, project_id: &str) -> Result<OpGuard, IpcError> {
        let mut ops = self.ops.lock().unwrap();
        if !ops.insert(project_id.to_string()) {
            return Err(IpcError::new(
                ErrorCode::OpInProgress,
                "이미 진행 중인 git 작업이 있습니다 — 완료 후 다시 시도하세요",
            ));
        }
        Ok(OpGuard {
            ops: Arc::clone(&self.ops),
            project_id: project_id.to_string(),
        })
    }
}

/// RAII: 드롭 시점에 쓰기 락 해제 (오류·타임아웃 경로 포함)
pub struct OpGuard {
    ops: Arc<Mutex<HashSet<String>>>,
    project_id: String,
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        self.ops.lock().unwrap().remove(&self.project_id);
    }
}

pub fn load_projects(app: &AppHandle) -> Vec<Project> {
    let Ok(store) = app.store(STORE_FILE) else {
        return Vec::new();
    };
    let Some(value) = store.get(STORE_KEY) else {
        return Vec::new();
    };
    serde_json::from_value(value).unwrap_or_default()
}

pub fn save_projects(app: &AppHandle, projects: &[Project]) -> Result<(), IpcError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("스토어 열기 실패: {e}")))?;
    store.set(STORE_KEY, serde_json::json!(projects));
    store
        .save()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("프로젝트 목록 저장 실패: {e}")))?;
    Ok(())
}

pub fn load_settings(app: &AppHandle) -> Settings {
    let Ok(store) = app.store(SETTINGS_FILE) else {
        return Settings::default();
    };
    let Some(value) = store.get(SETTINGS_KEY) else {
        return Settings::default();
    };
    let mut settings: Settings = serde_json::from_value(value.clone()).unwrap_or_default();
    // 1회 마이그레이션(태스크 04 §3.7): 구 autoFetchMinutes(>0)를 신 remoteRefreshMinutes로 승계.
    // 신 키가 이미 저장돼 있으면 사용자가 만진 값이므로 건드리지 않는다. 의미 변환(0의 뜻이
    // "만진 적 없음"→"명시적 끔"으로 바뀜)이라 serde(alias)로는 불가 — 로드 후 코드로 처리.
    // 다음 set_settings 저장이 전체 객체를 교체해 구 키는 자연 소멸한다(그전까지는 멱등 재적용).
    if value.get("remoteRefreshMinutes").is_none() {
        if let Some(old) = value.get("autoFetchMinutes").and_then(|v| v.as_u64()) {
            if old > 0 {
                settings.remote_refresh_minutes = old as u32;
            }
        }
    }
    settings
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), IpcError> {
    let store = app
        .store(SETTINGS_FILE)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("스토어 열기 실패: {e}")))?;
    store.set(SETTINGS_KEY, serde_json::json!(settings));
    store
        .save()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("설정 저장 실패: {e}")))?;
    Ok(())
}

pub fn load_notes(app: &AppHandle) -> Notes {
    let Ok(store) = app.store(NOTES_FILE) else {
        return Notes::new();
    };
    let Some(value) = store.get(NOTES_KEY) else {
        return Notes::new();
    };
    serde_json::from_value(value).unwrap_or_default()
}

pub fn save_notes(app: &AppHandle, notes: &Notes) -> Result<(), IpcError> {
    let store = app
        .store(NOTES_FILE)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("스토어 열기 실패: {e}")))?;
    store.set(NOTES_KEY, serde_json::json!(notes));
    store
        .save()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("메모 저장 실패: {e}")))?;
    Ok(())
}
