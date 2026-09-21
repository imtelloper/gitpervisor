//! llama-server 프로세스 수명 (태스크 59 §3.3) — `commands/lsp.rs`의 `LspSession` 이식.
//!
//! LSP와 다른 점 셋:
//! - **단일 세션**(`AppState.llm`). 모델 하나가 수 GB를 mmap하므로 여러 개를 띄울 이유가 없다.
//!   설정의 모델이 세션과 다르면 stop → start 한다(설정 저장 자체는 서버를 건드리지 않는다).
//! - 통신이 stdio가 아니라 **루프백 HTTP**다. 그래서 `--api-key`에 난수를 걸어 같은 머신의 다른
//!   프로세스가 이 서버를 공짜로 못 쓰게 한다(llama-server는 기본 무인증).
//! - 리눅스에서는 `systemd-run --user --scope`로 위임한다. 모델 mmap이 앱 cgroup 메모리로
//!   집계되면 systemd-oomd가 **앱을 통째로** 죽인다(2026-08-01 사건). scope는 수명을 관리하지
//!   않고 cgroup만 옮기므로 pid는 여전히 우리 자식이고 `terminate_child`가 그대로 닿는다.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

use super::acquire;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

const IDLE_TIMEOUT: Duration = Duration::from_secs(600); // 10분(§3.3)
const REAPER_INTERVAL: Duration = Duration::from_secs(60);
/// 로그 tail 보관 줄 수 — 기동 실패 시 에러 메시지에 붙인다.
const LOG_TAIL: usize = 50;
/// 이 시간 안에 프로세스가 죽으면 "기동 자체가 안 된 것"으로 보고 Windows CPU 폴백을 검토한다.
const EARLY_DEATH: Duration = Duration::from_secs(20);

/// 살아있는 llama-server 세션. 하나만 존재한다(`AppState.llm`).
pub struct LlmSession {
    child: Arc<Mutex<Child>>,
    /// unix에선 spawn 시 `process_group(0)`을 줬으므로 그룹 id와 값이 같다 — killpg로 손자까지 거둔다.
    pid: u32,
    port: u16,
    api_key: String,
    /// 이 세션이 물고 있는 카탈로그 모델 id(또는 "custom").
    model: String,
    last_activity: Arc<Mutex<Instant>>,
    ready: AtomicBool,
    terminated: AtomicBool,
    log_tail: Arc<Mutex<VecDeque<String>>>,
}

impl LlmSession {
    fn terminate(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return; // 이미 거둠 — Drop 안전망과 중복 방지
        }
        terminate_child(&self.child, self.pid);
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    fn tail(&self) -> String {
        self.log_tail
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 아직 살아 있는가. `try_wait`이 Some을 주면 이미 끝난 것이고 그 호출이 좀비도 거둔다.
    fn alive(&self) -> bool {
        !self.terminated.load(Ordering::SeqCst)
            && matches!(lock_child(&self.child).try_wait(), Ok(None))
    }
}

impl Drop for LlmSession {
    /// 안전망 — 레지스트리에서 조용히 빠지거나 에러 경로로 버려지는 세션도 자식을 남기지 않는다.
    fn drop(&mut self) {
        self.terminate();
    }
}

/// 대화 상대의 주소. 관리형이면 루프백 + 난수 키, 외부 모드면 설정 그대로다.
pub struct Endpoint {
    pub base: String,
    pub key: Option<String>,
    pub model: String,
}

// ══════════════════════════ 상태 조회 ══════════════════════════

pub fn server_status(state: &AppState) -> Option<acquire::ServerStatus> {
    let guard = state.llm.lock().unwrap_or_else(|e| e.into_inner());
    let s = guard.as_ref()?;
    if !s.alive() {
        return None;
    }
    // 값을 먼저 뽑는다 — 구조체 리터럴 안에서 `last_activity.lock()`을 부르면 그 임시 가드가
    // 꼬리 표현식 끝까지 살아 바깥 `guard`(레지스트리 락)보다 오래 남는다(빌림 검사 거부).
    let idle_secs = s
        .last_activity
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .elapsed()
        .as_secs();
    Some(acquire::ServerStatus {
        model: s.model.clone(),
        port: s.port,
        ready: s.ready.load(Ordering::SeqCst),
        idle_secs,
    })
}

/// 지정 모델을 물고 있는 세션이면 내린다(모델 삭제 전 호출 — 파일이 잠겨 있으면 지울 수 없다).
pub fn stop_if_model(state: &AppState, model_id: &str) {
    let taken = {
        let mut guard = state.llm.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_ref() {
            Some(s) if s.model == model_id => guard.take(),
            _ => None,
        }
    };
    // 종료는 **락 밖에서** — kill+wait을 전역 락 아래서 돌리면 그동안 상태 조회가 전부 멈춘다.
    if let Some(s) = taken {
        s.terminate();
    }
}

// ══════════════════════════ 기동 ══════════════════════════

fn io(e: String) -> IpcError {
    IpcError::new(ErrorCode::Io, e)
}

/// 준비 폴링·채팅이 공유하는 클라이언트(연결 재사용). 루프백 전용이라 프록시 설정도 그대로 둔다.
pub(super) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 빈 포트를 커널에게 받아 즉시 놓는다. 놓은 뒤 llama-server가 잡기까지의 틈에 다른 프로세스가
/// 채갈 수 있어(TOCTOU) 실패 시 3회까지 다시 고른다.
fn free_port() -> Result<u16, IpcError> {
    for _ in 0..3 {
        if let Ok(l) = std::net::TcpListener::bind("127.0.0.1:0") {
            if let Ok(addr) = l.local_addr() {
                return Ok(addr.port());
            }
        }
    }
    Err(io("빈 포트를 찾지 못했습니다".into()))
}

/// 32바이트 난수 hex. `uuid` v4가 이미 트리에 있어 별도 난수 크레이트를 들이지 않는다.
fn random_key() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 외부 OpenAI 호환 서버의 base URL 정규화 — 끝의 `/`와 `/v1`을 떼어 낸다.
///
/// 설정 안내문·플레이스홀더가 `http://localhost:11434/v1`처럼 **`/v1`까지** 적게 한다
/// (Ollama·LM Studio 문서 관례). 그런데 요청 경로도 `/v1/chat/completions`라 그대로 이어 붙이면
/// `…/v1/v1/chat/completions` → 404다. 두 표기를 여기서 하나로 만든다.
fn normalize_base(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    u.strip_suffix("/v1")
        .unwrap_or(u)
        .trim_end_matches('/')
        .to_string()
}

/// 설정이 가리키는 모델 → (id, 경로, 바이트 크기).
fn resolve_model(app: &AppHandle, state: &AppState) -> Result<(String, PathBuf, u64), IpcError> {
    let (model_id, custom) = {
        let s = state.settings.read().unwrap_or_else(|e| e.into_inner());
        (s.llm_model.clone(), s.llm_custom_model_path.clone())
    };
    let path = if model_id == "custom" {
        let p = custom
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| {
                IpcError::new(ErrorCode::NotFound, "사용자 지정 모델 경로가 비어 있습니다")
            })?;
        // 판정은 `status()`의 `custom_model_ok`와 **같은 함수**로 한다 — 갈라지면 화면엔
        // "경로 없음"이라 떠 있는 파일로 서버가 기동한다(확장자 검사가 한쪽에만 있었다).
        acquire::custom_model(Some(p)).ok_or_else(|| {
            IpcError::new(
                ErrorCode::NotFound,
                "사용자 지정 모델이 없거나 .gguf 파일이 아닙니다",
            )
        })?
    } else {
        let spec = acquire::model_spec(&model_id).ok_or_else(|| {
            IpcError::new(ErrorCode::NotFound, format!("모르는 모델: {model_id}"))
        })?;
        acquire::installed_model(app, spec).ok_or_else(|| {
            IpcError::new(
                ErrorCode::NotFound,
                format!("{} 모델이 없습니다 — 설정 › AI에서 다운로드하세요", spec.label),
            )
        })?
    };
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok((model_id, path, size))
}

/// 모델 로드 상한 — GB당 30초 + 30초(HDD 고려, §3.3).
fn load_timeout(model_bytes: u64) -> Duration {
    let gb = (model_bytes as f64 / (1024.0 * 1024.0 * 1024.0)).ceil().max(1.0) as u64;
    Duration::from_secs(30 + gb * 30)
}

/// Windows Vulkan → CPU 자동 폴백 판정(§3.3). 순수 함수 — 테스트 대상.
///
/// "죽었다"가 전제다. 살아 있는데 준비만 늦는 경우(거대 모델·HDD)까지 폴백하면 GPU가 멀쩡한
/// 머신이 영원히 CPU로 돌게 된다.
fn should_fallback_to_cpu(log: &str, died: bool, elapsed: Duration) -> bool {
    if !died {
        return false;
    }
    let l = log.to_ascii_lowercase();
    elapsed < EARLY_DEATH || l.contains("vulkan") || l.contains("failed to initialize")
}

/// 로그 tail 수집 스레드 — stdout/stderr를 **반드시 읽어야** 파이프 버퍼 포화로 서버가 멈추지 않는다.
fn drain(reader: impl std::io::Read + Send + 'static, tail: Arc<Mutex<VecDeque<String>>>) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
            if t.len() >= LOG_TAIL {
                t.pop_front();
            }
            t.push_back(line);
        }
    });
}

/// 프로세스만 띄운다(준비 대기는 호출자). 실패는 spawn 자체의 실패만 뜻한다.
fn spawn_server(
    exe: &std::path::Path,
    model: &std::path::Path,
    port: u16,
    api_key: &str,
    gpu_layers: u32,
    ctx: u32,
    threads: u32,
) -> Result<(Child, Arc<Mutex<VecDeque<String>>>), IpcError> {
    let args: Vec<String> = vec![
        "-m".into(),
        model.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "-c".into(),
        ctx.to_string(),
        "-ngl".into(),
        gpu_layers.to_string(),
        "-t".into(),
        threads.to_string(),
        // 슬롯 1개. **안 주면 llama-server가 4개를 잡는다**(`arg.cpp`가 SERVER 예제에만
        // `n_parallel = -1`(auto)을 준다) — `chat.rs`는 한 번에 한 요청만 보내므로 나머지 3개는
        // KV 캐시만 먹는다. 실측(2026-09-21, Gemma 4 12B / RTX 5070 Ti 12GB): VRAM 10,705→9,328MB,
        // 주간 요약 85→73초. 작은 모델은 속도 차가 없고(4B 12.8→12.4초) VRAM만 준다.
        "-np".into(),
        "1".into(),
        "--api-key".into(),
        api_key.to_string(),
        "--no-webui".into(),
    ];

    // 리눅스: 가능하면 systemd 위임(앱 cgroup 밖). `--scope`여야 한다 — service 유닛은 런처가
    // 끝나는 순간 cgroup을 통째로 SIGTERM 한다(commands/open.rs의 같은 함정).
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = match crate::tools::runner::find_on_path("systemd-run") {
        Some(runner) => {
            let mut c = Command::new(runner);
            c.args(["--user", "--scope", "--quiet", "--collect", "--"]);
            c.arg(exe);
            c.args(&args);
            c
        }
        None => {
            let mut c = Command::new(exe);
            c.args(&args);
            c
        }
    };
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    let mut cmd = {
        let mut c = Command::new(exe);
        c.args(&args);
        c
    };

    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        // 새 프로세스 그룹의 리더로 — 종료 시 killpg로 손자까지 거둔다(lsp.rs와 같은 방침).
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| io(format!("llama-server 실행 실패: {e}")))?;
    let tail = Arc::new(Mutex::new(VecDeque::with_capacity(LOG_TAIL)));
    if let Some(out) = child.stdout.take() {
        drain(out, tail.clone());
    }
    if let Some(err) = child.stderr.take() {
        drain(err, tail.clone());
    }
    Ok((child, tail))
}

/// 모델이 올라올 때까지 `/health`를 500ms 간격으로 두드린다. 503 = 로딩 중.
/// 진행은 `{"phase":"loading"}`으로 흘려 호출자가 "모델 로드 중"을 그릴 수 있게 한다.
async fn wait_ready(
    session: &LlmSession,
    timeout: Duration,
    on_progress: &Channel<String>,
) -> Result<(), IpcError> {
    let url = format!("http://127.0.0.1:{}/health", session.port);
    let started = Instant::now();
    let mut ticks = 0u32;
    while started.elapsed() < timeout {
        if !session.alive() {
            return Err(io(format!(
                "llama-server가 종료됐습니다:\n{}",
                session.tail()
            )));
        }
        if let Ok(resp) = http().get(&url).timeout(Duration::from_secs(2)).send().await {
            if resp.status().is_success() {
                session.ready.store(true, Ordering::SeqCst);
                return Ok(());
            }
        }
        // 매 틱마다 보내면 초당 2건이라 시끄럽다 — 2초에 한 번.
        if ticks % 4 == 0 {
            let payload = serde_json::json!({
                "phase": "loading", "seconds": started.elapsed().as_secs(),
            });
            let _ = on_progress.send(payload.to_string());
        }
        ticks += 1;
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(IpcError::new(
        ErrorCode::Timeout,
        format!("모델 로드 실패(시간 초과):\n{}", session.tail()),
    ))
}

/// 대화 상대를 보장한다. 외부 URL 모드면 프로세스 없이 주소만 돌려주고, 관리형이면 필요할 때만
/// 기동한다(이미 같은 모델로 떠 있으면 재사용 — 첫 요청 20~60초를 두 번 물지 않는다).
pub async fn ensure_server(
    app: &AppHandle,
    state: &AppState,
    on_progress: &Channel<String>,
) -> Result<Endpoint, IpcError> {
    let (provider, ext_url, ext_model, ext_key, gpu_layers, ctx, backend) = {
        let s = state.settings.read().unwrap_or_else(|e| e.into_inner());
        (
            s.llm_provider.clone(),
            s.llm_external_url.clone(),
            s.llm_external_model.clone(),
            s.llm_external_key.clone(),
            s.llm_gpu_layers,
            s.llm_context,
            s.llm_backend.clone(),
        )
    };

    if provider == "external" {
        let base = ext_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .ok_or_else(|| {
                IpcError::new(
                    ErrorCode::NotFound,
                    "외부 서버 URL이 비어 있습니다 — 설정 › AI › 고급",
                )
            })?;
        return Ok(Endpoint {
            base: normalize_base(base),
            key: ext_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()),
            model: ext_model
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| "default".to_string()),
        });
    }

    let (model_id, model_path, model_size) = resolve_model(app, state)?;

    // 재사용 — 같은 모델로 살아 있으면 그대로. 락은 판정 동안만 짧게 잡는다.
    {
        let guard = state.llm.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = guard.as_ref() {
            if s.model == model_id && s.alive() && s.ready.load(Ordering::SeqCst) {
                s.touch();
                return Ok(Endpoint {
                    base: format!("http://127.0.0.1:{}", s.port),
                    key: Some(s.api_key.clone()),
                    model: model_id,
                });
            }
        }
    }
    // 모델이 바뀌었거나 죽은 세션 — 꺼내서 락 밖에서 정리한다.
    let stale = state.llm.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(s) = stale {
        s.terminate();
    }

    let art = acquire::spec_for_backend(&backend).ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "이 플랫폼용 llama.cpp 공식 빌드가 없습니다 — 고급 › 외부 서버 URL을 쓰세요",
        )
    })?;
    let exe = acquire::installed_server(app, &art).ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "AI 런타임이 없습니다 — 설정 › AI에서 런타임을 다운로드하세요",
        )
    })?;
    let threads = physical_threads();
    let ctx = ctx.clamp(2048, 32768);

    match start_and_wait(state, &exe, &model_path, &model_id, gpu_layers, ctx, threads, model_size, on_progress).await {
        Ok(ep) => Ok(ep),
        Err((err, log, died, elapsed)) => {
            // Windows Vulkan 폴백 — 이 태스크의 유일한 자동 복구 경로다(§3.3).
            if backend == "cpu" || !should_fallback_to_cpu(&log, died, elapsed) {
                return Err(err);
            }
            let Some(cpu) = acquire::cpu_spec() else {
                return Err(err);
            };
            log::warn!("[llm] GPU 백엔드 기동 실패 — CPU 빌드로 폴백합니다: {err}");
            let cpu_exe = acquire::ensure_runtime(app, state, &cpu, on_progress).await?;
            // 다음 기동부터 바로 CPU를 쓰도록 기억한다(§3.3).
            {
                let mut s = state.settings.write().unwrap_or_else(|e| e.into_inner());
                s.llm_backend = "cpu".to_string();
                let _ = crate::state::save_settings(app, &s);
            }
            // 프론트에 알린다. 열려 있는 설정 폼은 여전히 "auto"를 들고 있어서, 알리지 않으면
            // 그 폼의 다음 저장이 방금 기록한 폴백을 도로 덮는다(그러면 매번 Vulkan을 다시
            // 시도하고 매번 실패한다). 이벤트는 신호일 뿐, 진실은 재조회다(events.ts §10).
            let _ = app.emit("settings://changed", ());
            start_and_wait(
                state, &cpu_exe, &model_path, &model_id, gpu_layers, ctx, threads, model_size, on_progress,
            )
            .await
            .map_err(|(e, _, _, _)| e)
        }
    }
}

/// 물리 코어 수(없으면 논리, 그것도 없으면 1). `-t`에 그대로 들어간다.
fn physical_threads() -> u32 {
    let sys = sysinfo::System::new();
    sys.physical_core_count()
        .or_else(|| std::thread::available_parallelism().ok().map(|n| n.get()))
        .unwrap_or(1)
        .max(1) as u32
}

/// 스폰 + 준비 대기 + 레지스트리 등록. 실패 시 폴백 판정에 필요한 재료(로그·사망 여부·경과)를 함께 돌려준다.
#[allow(clippy::too_many_arguments)]
async fn start_and_wait(
    state: &AppState,
    exe: &std::path::Path,
    model_path: &std::path::Path,
    model_id: &str,
    gpu_layers: u32,
    ctx: u32,
    threads: u32,
    model_size: u64,
    on_progress: &Channel<String>,
) -> Result<Endpoint, (IpcError, String, bool, Duration)> {
    let started = Instant::now();
    let port = free_port().map_err(|e| (e, String::new(), false, started.elapsed()))?;
    let api_key = random_key();
    let (child, log_tail) = spawn_server(exe, model_path, port, &api_key, gpu_layers, ctx, threads)
        .map_err(|e| (e, String::new(), true, started.elapsed()))?;
    let session = LlmSession {
        pid: child.id(),
        child: Arc::new(Mutex::new(child)),
        port,
        api_key: api_key.clone(),
        model: model_id.to_string(),
        last_activity: Arc::new(Mutex::new(Instant::now())),
        ready: AtomicBool::new(false),
        terminated: AtomicBool::new(false),
        log_tail,
    };

    if let Err(e) = wait_ready(&session, load_timeout(model_size), on_progress).await {
        let log = session.tail();
        let died = !session.alive();
        drop(session); // Drop이 프로세스를 거둔다 — 실패한 서버를 남기지 않는다
        return Err((e, log, died, started.elapsed()));
    }
    session.touch();
    *state.llm.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
    Ok(Endpoint {
        base: format!("http://127.0.0.1:{port}"),
        key: Some(api_key),
        model: model_id.to_string(),
    })
}

/// 토큰이 흐르는 동안 유휴 타이머를 뒤로 민다(요청 시작·토큰마다 — §3.3).
pub fn touch_activity(state: &AppState) {
    if let Some(s) = state.llm.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        s.touch();
    }
}

// ══════════════════════════ 종료 ══════════════════════════

/// 서버 수동 종료 — 설정 화면·e2e가 부른다. 없으면 no-op.
#[tauri::command]
pub fn llm_stop(state: tauri::State<'_, AppState>) -> Result<(), IpcError> {
    let taken = state.llm.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(s) = taken {
        // 동기 커맨드라 메인 스레드에서 돈다 — kill+wait을 여기서 기다리면 UI가 그만큼 언다.
        thread::spawn(move || s.terminate());
    }
    Ok(())
}

/// 앱 종료 시 정리. **시그니처 고정** — lib.rs `shutdown_children`이 이 형태로 부른다
/// (`lsp_kill_all` 바로 옆).
pub fn llm_kill_all(state: &AppState) {
    let taken = state.llm.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(s) = taken {
        // 여기서는 완료를 보장해야 한다 — 스레드에 던져만 두면 앱이 먼저 사라져 서버가 고아가 된다.
        s.terminate();
    }
}

/// 유휴 리퍼 — 10분간 요청이 없던 서버를 내린다(§3.3). 앱 setup에서 1회 스폰(LSP 리퍼 옆).
pub fn llm_spawn_idle_reaper(app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(REAPER_INTERVAL);
        let state = app.state::<AppState>();
        let idle = {
            let guard = state.llm.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().is_some_and(|s| {
                s.last_activity
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .elapsed()
                    > IDLE_TIMEOUT
            })
        };
        if !idle {
            continue;
        }
        let taken = state.llm.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(s) = taken {
            log::info!("[llm] 10분 유휴 — llama-server를 내립니다 (pid={})", s.pid);
            s.terminate(); // 락 밖 — 리퍼 스레드라 여기서 기다려도 UI에 영향 없다
        }
    });
}

fn lock_child(child: &Mutex<Child>) -> std::sync::MutexGuard<'_, Child> {
    // poison까지 복구해서 잡는다 — 여기서 락을 포기하면 wait()를 못 해 좀비가 남는다.
    child.lock().unwrap_or_else(|e| e.into_inner())
}

/// 자식 종료 본체 — 그룹째 죽이고 **반드시 wait으로 좀비를 회수**한다(lsp.rs와 같은 계약).
/// llama-server에는 stdio 종료 프로토콜이 없어 유예 단계가 없다.
fn terminate_child(child: &Mutex<Child>, pid: u32) {
    kill_group(pid); // wait 전에 — 거둔 뒤엔 pid가 재사용될 수 있다
    let mut c = lock_child(child);
    let _ = c.kill();
    let _ = c.wait();
}

/// unix: `process_group(0)`으로 만든 그룹째 정리. 리눅스 systemd 위임 경로에서는 systemd-run이
/// 그룹 리더고 llama-server가 그 안에 있으므로 이 한 방으로 둘 다 닿는다.
#[allow(unused_variables)]
fn kill_group(pid: u32) {
    #[cfg(unix)]
    if pid > 1 {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
    // Windows는 프로세스 그룹 의미가 달라 직계만 종료한다(llama-server는 자식을 두지 않는다).
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 로드 상한은 모델이 클수록 길어야 한다 — 8B(5GB)를 4B와 같은 시한으로 재면 HDD 머신에서
    /// 정상 로드를 "실패"로 오판하고, 그 오판이 Windows에서 **CPU 폴백까지** 유발한다.
    #[test]
    fn load_timeout_scales_with_model_size() {
        let gb = 1024 * 1024 * 1024;
        assert_eq!(load_timeout(0), Duration::from_secs(60)); // 최소 1GB 취급
        assert_eq!(load_timeout(5 * gb / 2), Duration::from_secs(30 + 3 * 30)); // 2.5GB → 3GB
        assert!(load_timeout(5 * gb) > load_timeout(5 * gb / 2));
    }

    /// 살아 있는 서버는 절대 폴백 대상이 아니다(느린 로드 ≠ Vulkan 부재).
    #[test]
    fn fallback_only_when_process_died() {
        assert!(!should_fallback_to_cpu("vulkan: failed", false, Duration::from_secs(1)));
        // 즉사 = 기동 자체 실패
        assert!(should_fallback_to_cpu("", true, Duration::from_secs(3)));
        // 늦게 죽었어도 로그가 vulkan을 가리키면 폴백
        assert!(should_fallback_to_cpu(
            "ggml_vulkan: no devices found",
            true,
            Duration::from_secs(60)
        ));
        // 늦게 죽었고 vulkan과 무관하면 폴백하지 않는다(모델 손상 등 — CPU로 바꿔도 못 고친다)
        assert!(!should_fallback_to_cpu(
            "error loading model: tensor 'x' has wrong shape",
            true,
            Duration::from_secs(60)
        ));
    }

    /// 외부 URL은 `/v1`을 적든 안 적든 같은 곳을 가리켜야 한다. 설정 안내문이 `/v1`까지 적게
    /// 하는데 요청 경로에도 `/v1`이 붙어 `…/v1/v1/chat/completions` → 404가 났다(외부 제공자
    /// 수용 조건이 통째로 막히는 결함이었다).
    #[test]
    fn external_base_normalizes_v1_suffix() {
        for u in [
            "http://localhost:11434/v1",
            "http://localhost:11434/v1/",
            "http://localhost:11434",
            "http://localhost:11434/",
            "  http://localhost:11434/v1  ",
        ] {
            assert_eq!(
                format!("{}/v1/chat/completions", normalize_base(u)),
                "http://localhost:11434/v1/chat/completions",
                "입력 {u:?}"
            );
        }
        // 경로가 있는 프록시는 마지막 `/v1` 하나만 뗀다 — 앞의 경로는 서버 것이다.
        assert_eq!(normalize_base("https://host/api/v1"), "https://host/api");
        assert_eq!(normalize_base("https://host/v1beta"), "https://host/v1beta");
    }

    /// 난수 키는 32바이트(hex 64자)이고 호출마다 달라야 한다 — 고정되면 다른 로컬 프로세스가
    /// 한 번 훔쳐본 키로 계속 이 서버를 쓸 수 있다.
    #[test]
    fn api_key_is_64_hex_and_unique() {
        let a = random_key();
        let b = random_key();
        assert_eq!(a.len(), 64);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
