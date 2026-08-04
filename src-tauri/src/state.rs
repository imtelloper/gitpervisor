use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use tauri::{AppHandle, Manager};

use crate::commands::{BrowserReg, HttpReg, PreviewServers, TerminalSession};
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
    /// 로컬 HTML 프리뷰 루프백 서버 레지스트리 (base 폴더 → 포트). preview.rs §.
    pub preview: Mutex<PreviewServers>,
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
            preview: Mutex::new(PreviewServers::default()),
        }
    }

    /// 쓰기 작업 시작. 같은 레포에 이미 진행 중이면 큐잉하지 않고 즉시 거절한다 (설계 §8).
    pub fn try_begin_op(&self, project_id: &str) -> Result<OpGuard, IpcError> {
        let mut ops = self.ops.lock().unwrap_or_else(|e| e.into_inner());
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
        self.ops.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.project_id);
    }
}

// ── 사용자 데이터 영속화 ──
//
// 예전에는 tauri-plugin-store를 거쳤는데, 그 저장 경로가 `fs::write` **한 방**이다. Windows의
// CREATE_ALWAYS는 선(先)절단이라 정전·BSOD·Windows Update 강제 재시작이 그 구간에 걸리면 파일이
// 0바이트나 반쪽으로 남는다. 게다가 로드가 파싱 실패를 조용히 삼켜 기본값을 돌려주므로 앱은
// **오류 한 줄 없이 빈 상태로 부팅**한다 — 사용자는 프로젝트 목록이 사라진 걸 나중에야 알아채고,
// 그 상태에서 뭔가 저장하면 잔해까지 덮인다. settings 손상은 특히 나쁘다: 기본값 복귀가
// `remote_refresh_minutes = 5`를 되살려 사용자가 **명시적으로 끈** 배경 fetch가 말없이 재개된다
// (그 노브가 6일간 2만 회 돈 것이 2026-08 OOM 사건 P0-4다 — 데이터 손실이 과거 사건을 재점화한다).
//
// 그래서 읽기·쓰기를 직접 한다. 파일 위치·포맷(`{"<키>": <값>}`)은 플러그인이 쓰던 것과 동일해
// 기존 사용자 파일이 그대로 읽힌다. 원자적 쓰기 패턴 자체는 health/session.rs가 먼저 도입했다.

/// 모든 사용자 데이터 쓰기를 직렬화한다. 없으면 같은 파일에 대한 동시 저장이 같은 `.tmp`를
/// 두 번 쓰고, 한쪽 rename이 다른 쪽의 **덜 쓰인** tmp를 집어갈 수 있다.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

fn data_path(app: &AppHandle, file: &str) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(file))
}

/// 파일 1개에서 키 1개를 읽는다(경로를 직접 받는 순수 코어 — 테스트 대상).
///
/// **손상된 파일은 조용히 버리지 않는다.** 파일이 있는데 파싱에 실패하면 `.corrupt`로 옮기고
/// 에러를 남긴다. 그냥 None을 돌려주면 호출자가 기본값(빈 목록)으로 부팅하고, 사용자가 그 뒤에
/// 뭐라도 저장하는 순간 남아 있던 잔해까지 덮여 **복구 가능성이 0이 된다.** 옮겨 두면 최소한
/// 손으로 되살릴 수 있고, 로그에 흔적이 남아 "왜 갑자기 비었나"를 답할 수 있다.
fn load_json_at<T: serde::de::DeserializeOwned>(path: &Path, key: &str) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?; // 파일 없음 = 첫 실행, 정상

    // 손상은 격리하되, "아직 저장된 적 없음"과는 구분한다 — 키가 없는 `{}`는 정상 상태다.
    let quarantine = |why: &str| {
        let backup = path.with_extension("corrupt");
        let moved = std::fs::rename(path, &backup).is_ok();
        log::error!(
            "[state] {} 를 읽지 못했습니다({why}). 기본값으로 시작합니다 — 원본 보관: {}",
            path.display(),
            if moved {
                backup.display().to_string()
            } else {
                "실패".into()
            },
        );
    };

    let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text)
    else {
        quarantine("JSON 파싱 실패");
        return None;
    };
    let value = map.remove(key)?; // 키 없음 = 아직 저장된 적 없음, 정상
    match serde_json::from_value(value) {
        Ok(v) => Some(v),
        Err(_) => {
            quarantine("스키마 불일치");
            None
        }
    }
}

/// 파일 1개에 키 1개를 **원자적으로** 쓴다 — tmp에 쓰고 rename.
/// 쓰기 도중 전원이 나가도 기존 파일은 손상되지 않는다(rename은 일어나거나 일어나지 않거나 둘 뿐).
fn save_json_at<T: serde::Serialize>(
    path: &Path,
    key: &str,
    value: &T,
) -> Result<(), std::io::Error> {
    let json = serde_json::to_vec_pretty(&serde_json::json!({ key: value }))?;
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

/// 사용자 데이터 1건 읽기 — 없거나 손상이면 None(호출자가 기본값을 정한다).
pub(crate) fn load_json<T: serde::de::DeserializeOwned>(
    app: &AppHandle,
    file: &str,
    key: &str,
) -> Option<T> {
    load_json_at(&data_path(app, file)?, key)
}

/// 사용자 데이터 1건 원자적 저장.
pub(crate) fn save_json<T: serde::Serialize>(
    app: &AppHandle,
    file: &str,
    key: &str,
    value: &T,
    what: &str,
) -> Result<(), IpcError> {
    let fail = |e: String| IpcError::new(ErrorCode::Io, format!("{what} 저장 실패: {e}"));
    let path = data_path(app, file).ok_or_else(|| fail("데이터 폴더를 찾을 수 없습니다".into()))?;
    save_json_at(&path, key, value).map_err(|e| fail(e.to_string()))
}

pub fn load_projects(app: &AppHandle) -> Vec<Project> {
    load_json(app, STORE_FILE, STORE_KEY).unwrap_or_default()
}

pub fn save_projects(app: &AppHandle, projects: &[Project]) -> Result<(), IpcError> {
    save_json(app, STORE_FILE, STORE_KEY, &projects, "프로젝트 목록")
}

pub fn load_settings(app: &AppHandle) -> Settings {
    // 마이그레이션 판정이 "저장돼 있던 원본 JSON"을 봐야 하므로 Settings가 아니라 Value로 읽는다.
    let Some(value) = load_json::<serde_json::Value>(app, SETTINGS_FILE, SETTINGS_KEY) else {
        return Settings::default();
    };
    let mut settings: Settings = serde_json::from_value(value.clone()).unwrap_or_default();
    // 1회 마이그레이션(태스크 04 §3.7): 구 autoFetchMinutes(>0)를 신 remoteRefreshMinutes로 승계.
    // 신 키가 이미 저장돼 있으면 사용자가 만진 값이므로 건드리지 않는다. 의미 변환(0의 뜻이
    // "만진 적 없음"→"명시적 끔"으로 바뀜)이라 serde(alias)로는 불가 — 로드 후 코드로 처리.
    // 다음 set_settings 저장이 전체 객체를 교체해 구 키는 자연 소멸한다(그전까지는 멱등 재적용).
    if value.get("remoteRefreshMinutes").is_none() {
        if let Some(old) = value.get("autoFetchMinutes").and_then(|v| v.as_u64()) {
            // 0(= 사용자가 명시적으로 끔)도 그대로 승계한다. 예전에는 `if old > 0`으로 0을
            // 떨어뜨려 기본값 5분이 되살아났고, 결과를 저장하지도 않아 매 부팅마다 재적용됐다
            // — 끈 적 없는 배경 fetch가 6일간 2만 회 돈 원인(2026-08 OOM 사건 P0-4).
            settings.remote_refresh_minutes = u32::try_from(old).unwrap_or(0);
            // 마이그레이션 결과를 1회 저장해 구 키 재해석을 끝낸다(멱등 재적용 중단).
            let _ = save_settings(app, &settings);
        }
    }
    settings
}

pub fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), IpcError> {
    save_json(app, SETTINGS_FILE, SETTINGS_KEY, settings, "설정")
}

pub fn load_notes(app: &AppHandle) -> Notes {
    load_json(app, NOTES_FILE, NOTES_KEY).unwrap_or_default()
}

pub fn save_notes(app: &AppHandle, notes: &Notes) -> Result<(), IpcError> {
    save_json(app, NOTES_FILE, NOTES_KEY, notes, "메모")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tauri-plugin-store가 쓰던 것과 **같은 파일**을 그대로 읽어야 한다.
    /// 이게 깨지면 업데이트 순간 기존 사용자의 프로젝트·설정·메모가 통째로 사라진다.
    #[test]
    fn reads_the_legacy_plugin_format() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("projects.json");
        // 실제 사용자 파일에서 그대로 가져온 모양(pretty-printed `{"<키>": <값>}`).
        std::fs::write(&p, "{\n  \"projects\": [\"a\", \"b\"]\n}").unwrap();
        let got: Vec<String> = load_json_at(&p, "projects").unwrap();
        assert_eq!(got, vec!["a".to_string(), "b".to_string()]);
    }

    /// 저장 → 로드 왕복. 임시 파일을 남기지 않아야 한다(다음 실행에서 쓰레기로 보이면 안 된다).
    #[test]
    fn save_then_load_roundtrips_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.json");
        save_json_at(&p, "notes", &vec![1u32, 2, 3]).unwrap();
        assert_eq!(load_json_at::<Vec<u32>>(&p, "notes").unwrap(), vec![1, 2, 3]);
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "임시 파일이 남았다: {leftovers:?}");
    }

    /// 기존 파일이 있어도 덮어쓰기가 원자적이어야 한다 — rename이 destination을 대체한다.
    #[test]
    fn overwrite_replaces_existing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("settings.json");
        save_json_at(&p, "settings", &"old").unwrap();
        save_json_at(&p, "settings", &"new").unwrap();
        assert_eq!(load_json_at::<String>(&p, "settings").unwrap(), "new");
    }

    /// 손상 파일은 **격리**한다. 조용히 None을 돌려주면 빈 상태로 부팅하고, 그 뒤 첫 저장이
    /// 잔해까지 덮어 복구 가능성이 0이 된다.
    #[test]
    fn corrupt_file_is_quarantined_not_silently_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("projects.json");
        std::fs::write(&p, "{\"projects\": [\"a\"").unwrap(); // 쓰기 도중 잘린 모양
        assert!(load_json_at::<Vec<String>>(&p, "projects").is_none());
        assert!(
            p.with_extension("corrupt").exists(),
            "손상 원본을 보관하지 않았다"
        );
    }

    /// 키가 없는 정상 파일(`{}`)은 손상이 아니다 — 격리하면 안 된다.
    #[test]
    fn missing_key_is_not_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.json");
        std::fs::write(&p, "{}").unwrap();
        assert!(load_json_at::<Notes>(&p, "notes").is_none());
        assert!(p.exists(), "정상 파일을 격리했다");
        assert!(!p.with_extension("corrupt").exists());
    }
}
