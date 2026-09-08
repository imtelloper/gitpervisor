//! 로컬 LLM 런타임·모델 획득 (태스크 59 §3.3) — ffmpeg 관리형 다운로드(`commands/video.rs`
//! `download_verified`)를 이식하고 두 가지를 더한다.
//!
//! ① **취소**: 모델이 GB 단위라 오클릭 복구가 필수다. `AppState.llm_downloads`의
//!    `CancellationToken`을 이름(`"runtime"`·모델 id)으로 걸어 두고 `llm_download_cancel`이 끊는다.
//! ② **`.part` + rename**: 받다 만 파일이 "설치됨"으로 오판되지 않게 임시 이름으로 받아 마지막에
//!    옮긴다. 다운로드 전 여유 공간(`sys_info_static`의 volumes)도 미리 본다 — 2.5GB를 다 받고
//!    나서 "공간 부족"을 알려 주는 건 사용자를 두 번 기다리게 하는 일이다.
//!
//! **sha256은 전부 코드 고정**이다(공급망 원칙 — 17·ffmpeg와 같은 수준).
//! - 런타임 아카이브: 릴리스에 체크섬 파일이 없어 2026-09-07에 5개 자산을 직접 받아 채록했다.
//! - GGUF: HuggingFace tree API(`/api/models/<org>/<repo>/tree/main`)의 `lfs.oid`가 곧 sha256이다.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// llama.cpp 릴리스 빌드 태그. 자산 이름·설치 폴더·`.ok` 마커가 전부 이 값에서 나온다.
pub const LLAMA_BUILD: &str = "b10809";

#[derive(Clone, Copy)]
pub enum ArchiveKind {
    Zip,
    TarGz,
}

/// 플랫폼별 런타임 아카이브 1개. `dir`는 설치 폴더 이름(= `.ok` 마커가 놓이는 곳).
pub struct Artifact {
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    pub kind: ArchiveKind,
    pub dir: &'static str,
    /// 아카이브 최상위에서 설치 폴더로 올릴 서브디렉토리. **실측 2026-09-07**: Windows zip은
    /// 평탄(None), mac/linux tar.gz는 `llama-b10809/`로 묶여 있다(설계 문서의 `build/bin/` 추정은 틀렸다).
    pub inner_dir: Option<&'static str>,
    pub exe_rel: &'static str,
}

macro_rules! asset_url {
    ($name:literal) => {
        concat!(
            "https://github.com/ggml-org/llama.cpp/releases/download/b10809/",
            $name
        )
    };
}

/// 이 플랫폼의 기본 런타임. Windows는 Vulkan(벤더 무관 GPU), mac은 Metal 내장, Linux는 CPU 빌드.
pub fn runtime_spec() -> Option<Artifact> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some(Artifact {
            url: asset_url!("llama-b10809-bin-win-vulkan-x64.zip"),
            sha256: "97e50b3ef0cdd2cb4d5afd446a9006b3496bee6c0d0ba7083d32f36075771870",
            size: 35_221_385,
            kind: ArchiveKind::Zip,
            dir: "llama-b10809",
            inner_dir: None,
            exe_rel: "llama-server.exe",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(Artifact {
            url: asset_url!("llama-b10809-bin-macos-arm64.tar.gz"),
            sha256: "7d692df9e1e386e62f1c12b843903218041e6cd74c9415aa39a7ed3176f9eaa2",
            size: 11_123_196,
            kind: ArchiveKind::TarGz,
            dir: "llama-b10809",
            inner_dir: Some("llama-b10809"),
            exe_rel: "llama-server",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some(Artifact {
            url: asset_url!("llama-b10809-bin-macos-x64.tar.gz"),
            sha256: "13b34aa8a5d87341a21065a83f54a8167e1aaa6fe0d66065de01632a1ed64be6",
            size: 11_175_330,
            kind: ArchiveKind::TarGz,
            dir: "llama-b10809",
            inner_dir: Some("llama-b10809"),
            exe_rel: "llama-server",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        // vulkan 자산은 libvulkan 의존이라 v1 제외(§3.1) — CPU 빌드만.
        Some(Artifact {
            url: asset_url!("llama-b10809-bin-ubuntu-x64.tar.gz"),
            sha256: "5e34434ddc6d03cd1584f403201aff0d4bd1a5793a72ff7e286532dfd1e4b941",
            size: 16_734_586,
            kind: ArchiveKind::TarGz,
            dir: "llama-b10809",
            inner_dir: Some("llama-b10809"),
            exe_rel: "llama-server",
        })
    } else {
        // win-arm64·linux-arm64 등 — 공식 빌드가 없다. 외부 URL 모드(Ollama)로만.
        None
    }
}

/// Windows Vulkan 초기화 실패 시 자동으로 내려앉는 CPU 빌드(§3.3). 다른 플랫폼엔 폴백이 없다.
pub fn cpu_spec() -> Option<Artifact> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some(Artifact {
            url: asset_url!("llama-b10809-bin-win-cpu-x64.zip"),
            sha256: "9df3158ed228a641a4b127942d7f459f24c9e13f04682659d05c00c80099b6b5",
            size: 18_407_457,
            kind: ArchiveKind::Zip,
            dir: "llama-b10809-cpu",
            inner_dir: None,
            exe_rel: "llama-server.exe",
        })
    } else {
        None
    }
}

/// 설정 `llm_backend`("auto" | "cpu")가 고른 스펙. cpu 폴백이 없는 플랫폼은 auto와 같다.
pub fn spec_for_backend(backend: &str) -> Option<Artifact> {
    if backend == "cpu" {
        cpu_spec().or_else(runtime_spec)
    } else {
        runtime_spec()
    }
}

/// 다운로드 진행 이벤트 이름 — 취소 레지스트리 키와 같다.
pub const RUNTIME_NAME: &str = "runtime";
pub const RUNTIME_CPU_NAME: &str = "runtime-cpu";

fn artifact_progress_name(art: &Artifact) -> &'static str {
    if art.dir.ends_with("-cpu") {
        RUNTIME_CPU_NAME
    } else {
        RUNTIME_NAME
    }
}

// ══════════════════════════ 모델 카탈로그 (§3.5) ══════════════════════════
//
// 항목 추가 = 배열 한 줄. sha256·size는 tree API가 준 값 그대로다(2026-09-07 실측).
// 제외: Gemma 3(HF 토큰 게이트), EXAONE(비상업), Llama(고지 의무).

pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub repo: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    /// 권장 최소 물리 RAM. 프론트가 `sys_info_static`과 대조해 뱃지를 만든다.
    pub min_ram: u64,
    pub note: &'static str,
}

const GB: u64 = 1024 * 1024 * 1024;

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "qwen3-4b-q4",
        label: "Qwen3 4B (Q4_K_M)",
        repo: "Qwen/Qwen3-4B-GGUF",
        file: "Qwen3-4B-Q4_K_M.gguf",
        sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
        size: 2_497_280_256,
        min_ram: 8 * GB,
        note: "기본 — 한국어·코드 양호, Apache-2.0",
    },
    ModelSpec {
        id: "qwen3-1.7b-q8",
        label: "Qwen3 1.7B (Q8_0)",
        repo: "Qwen/Qwen3-1.7B-GGUF",
        file: "Qwen3-1.7B-Q8_0.gguf",
        sha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a",
        size: 1_834_426_016,
        min_ram: 6 * GB,
        note: "저사양 — 가장 빠름",
    },
    ModelSpec {
        id: "qwen3-8b-q4",
        label: "Qwen3 8B (Q4_K_M)",
        repo: "Qwen/Qwen3-8B-GGUF",
        file: "Qwen3-8B-Q4_K_M.gguf",
        sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
        size: 5_027_783_488,
        min_ram: 12 * GB,
        note: "품질 우선",
    },
];

pub fn model_spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

fn model_url(m: &ModelSpec) -> String {
    // 공개 모델은 인증 없음. CDN 리다이렉트는 reqwest 기본 follow가 처리한다.
    format!("https://huggingface.co/{}/resolve/main/{}", m.repo, m.file)
}

// ══════════════════════════ 경로 ══════════════════════════
//
// ffmpeg·LSP가 쓰는 `tools/`가 아니라 `llm/`로 가른다 — 모델이 GB 단위라 "유지보수 › 캐시 삭제"
// 같은 후속 기능의 대상이 되기 때문이다(§3.2).

pub fn llm_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("llm"))
}

pub fn models_dir(app: &AppHandle) -> Option<PathBuf> {
    llm_root(app).map(|d| d.join("models"))
}

/// 설치된 런타임 실행 파일 — `.ok` 마커와 실행 파일이 **둘 다** 있어야 인정한다.
pub fn installed_server(app: &AppHandle, art: &Artifact) -> Option<PathBuf> {
    let dir = llm_root(app)?.join(art.dir);
    if !dir.join(".ok").is_file() {
        return None;
    }
    let exe = dir.join(art.exe_rel);
    exe.is_file().then_some(exe)
}

/// 카탈로그 모델의 설치 경로(있을 때만).
pub fn installed_model(app: &AppHandle, m: &ModelSpec) -> Option<PathBuf> {
    let p = models_dir(app)?.join(m.file);
    p.is_file().then_some(p)
}

/// 설정의 사용자 지정 GGUF 경로 — **존재 + `.gguf` 확장자**를 둘 다 만족할 때만 Some(§3.5).
/// `status()`의 `custom_model_ok`와 `server::resolve_model`이 **이 함수 하나로** 판정해야 한다.
/// 갈라지면 화면에 "경로 없음"으로 뜬 파일을 llama-server가 물고 기동하는 모순이 생긴다.
pub fn custom_model(path: Option<&str>) -> Option<PathBuf> {
    let p = Path::new(path.map(str::trim).filter(|p| !p.is_empty())?);
    let ok = p.is_file()
        && p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("gguf"));
    ok.then(|| p.to_path_buf())
}

/// 고아 임시 파일 청소(§3.2 "재시작 시 삭제") — 다운로드 중 앱이 죽으면 `.part`(모델)와
/// `.tmp-*`(런타임 해제용)가 남아 GB를 붙잡는다. 스스로 지워 주는 코드는 어디에도 없었다.
///
/// **다운로드가 하나라도 등록돼 있으면 통째로 건너뛴다** — 지금 쓰고 있는 `.part`를 지우면
/// 그 다운로드가 쓰기 실패로 죽는다. 등록이 비었을 때만 도는 게 가장 짧고 안전한 판정이다.
fn sweep_stale_downloads(app: &AppHandle, state: &AppState) {
    if !state
        .llm_downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_empty()
    {
        return;
    }
    let Some(root) = llm_root(app) else { return };
    for dir in [root.join("models"), root] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("part")) {
                let _ = std::fs::remove_file(&p);
            } else if p.is_dir()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(".tmp-"))
            {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
    }
}

// ══════════════════════════ 다운로드 ══════════════════════════

fn io(e: String) -> IpcError {
    IpcError::new(ErrorCode::Io, e)
}

fn send_progress(ch: &Channel<String>, name: &str, phase: &str, percent: Option<u64>, message: Option<&str>) {
    let payload = serde_json::json!({
        "name": name, "phase": phase, "percent": percent, "message": message,
    });
    let _ = ch.send(payload.to_string());
}

/// 사람이 읽는 크기 — 에러 문구("필요 2.6GB / 남음 1.1GB")에만 쓴다.
fn human(bytes: u64) -> String {
    let gb = bytes as f64 / GB as f64;
    if gb >= 1.0 {
        format!("{gb:.1}GB")
    } else {
        format!("{:.0}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// 설치 루트가 놓인 볼륨의 여유 공간을 미리 본다. 볼륨을 못 찾으면 **검사를 건너뛴다** —
/// 여기서 실패로 처리하면 마운트 표현이 다른 플랫폼에서 다운로드가 통째로 막힌다.
///
/// `sys_info_static`을 쓰지 않는다. 그 캐시는 **프로세스 수명 내내 무효화되지 않아서**, 앱을 켠
/// 뒤 공간을 비워도 반영되지 않고 한 번 부족했던 값이 재시작 전까지 모든 다운로드를 거짓으로
/// 막는다. 디스크 목록 재조회는 ms급이라 매번 새로 읽는 편이 싸다(수집이 수 초인 그 커맨드와 다르다).
fn check_free_space(root: &Path, need: u64) -> Result<(), IpcError> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let target = root.to_string_lossy().to_lowercase();
    let avail = disks
        .list()
        .iter()
        .filter(|d| {
            let m = d.mount_point().to_string_lossy().to_lowercase();
            !m.is_empty() && target.starts_with(&m)
        })
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space());
    let Some(avail) = avail else { return Ok(()) };
    // 5% 여유 — 해제 중 임시 사본이 잠깐 두 벌이 되는 구간을 흡수한다.
    let need = need + need / 20;
    if avail < need {
        return Err(io(format!(
            "여유 공간 부족: 필요 {} / 남음 {}",
            human(need),
            human(avail)
        )));
    }
    Ok(())
}

/// 스트리밍 다운로드 + 증분 sha256 + 정수 % 진행 + 취소. `dest`에는 `.part`로 받아 마지막에 옮긴다.
///
/// 취소·검증 실패·에러 어느 경로로 끝나도 `.part`는 남기지 않는다 — 남으면 다음 시도가
/// 이어받는 것처럼 보이는데 실제로는 처음부터 다시 받으므로 사용자에게 거짓말이 된다.
async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    sha256: &str,
    dest: &Path,
    name: &str,
    ch: &Channel<String>,
    cancel: &CancellationToken,
) -> Result<(), IpcError> {
    let part = dest.with_extension("part");
    std::fs::remove_file(&part).ok();
    let result = async {
        let mut resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| io(format!("다운로드 실패: {e}")))?
            .error_for_status()
            .map_err(|e| io(format!("다운로드 상태 오류: {e}")))?;
        let total = resp.content_length();
        let mut file = std::fs::File::create(&part).map_err(|e| io(format!("임시 파일 생성 실패: {e}")))?;
        let mut hasher = Sha256::new();
        let mut got: u64 = 0;
        let mut last_pct: u64 = u64::MAX;
        loop {
            // 취소를 **청크 사이에서만** 보면 연결이 죽었을 때 그 대기에 매달린 채로 "취소"가
            // 먹지 않는다(read_timeout이 결국 걷어 주더라도 그때까지 버튼이 무응답이다).
            // 수신과 취소를 함께 기다린다 — 둘 다 취소 안전한 future다.
            let chunk = tokio::select! {
                _ = cancel.cancelled() => {
                    return Err(IpcError::new(ErrorCode::Cancelled, "다운로드를 취소했습니다"));
                }
                c = resp.chunk() => c.map_err(|e| io(format!("본문 수신 실패: {e}")))?,
            };
            let Some(chunk) = chunk else { break };
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| io(format!("임시 파일 쓰기 실패: {e}")))?;
            got += chunk.len() as u64;
            if let Some(t) = total.filter(|t| *t > 0) {
                let pct = got * 100 / t;
                if pct != last_pct {
                    last_pct = pct;
                    send_progress(ch, name, "download", Some(pct), None);
                }
            }
        }
        drop(file);
        send_progress(ch, name, "verify", None, None);
        let hex: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if hex != sha256 {
            return Err(io("무결성 검증 실패 — 다운로드 변조 의심".into()));
        }
        std::fs::remove_file(dest).ok();
        std::fs::rename(&part, dest).map_err(|e| io(format!("설치 이동 실패: {e}")))?;
        Ok(())
    }
    .await;
    if result.is_err() {
        std::fs::remove_file(&part).ok();
    }
    result
}

fn extract_archive(kind: ArchiveKind, archive: &Path, temp: &Path) -> Result<(), IpcError> {
    match kind {
        ArchiveKind::Zip => {
            let file = std::fs::File::open(archive).map_err(|e| io(format!("아카이브 열기 실패: {e}")))?;
            zip::ZipArchive::new(file)
                .map_err(|e| io(format!("zip 열기 실패: {e}")))?
                .extract(temp)
                .map_err(|e| io(format!("zip 해제 실패: {e}")))?;
            Ok(())
        }
        ArchiveKind::TarGz => {
            // 아카이브가 11~17MB라 메모리에 통째로 올려도 무해하다(lsp/acquire.rs와 같은 방식).
            let bytes = std::fs::read(archive).map_err(|e| io(format!("아카이브 읽기 실패: {e}")))?;
            let mut buf = Vec::new();
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_end(&mut buf)
                .map_err(|e| io(format!("gunzip 실패: {e}")))?;
            tar::Archive::new(&buf[..])
                .unpack(temp)
                .map_err(|e| io(format!("tar 해제 실패: {e}")))?;
            Ok(())
        }
    }
}

/// 취소 토큰을 이름으로 등록하고 RAII로 지운다(성공·실패·패닉 공통 — http.rs InflightGuard 철학).
struct DownloadGuard<'a> {
    state: &'a AppState,
    name: String,
}

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        self.state
            .llm_downloads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.name);
    }
}

fn register_cancel<'a>(
    state: &'a AppState,
    name: &str,
) -> Result<(CancellationToken, DownloadGuard<'a>), IpcError> {
    let token = CancellationToken::new();
    {
        let mut map = state.llm_downloads.lock().unwrap_or_else(|e| e.into_inner());
        if map.contains_key(name) {
            return Err(IpcError::new(ErrorCode::Busy, "이미 다운로드가 진행 중입니다"));
        }
        map.insert(name.to_string(), token.clone());
    }
    Ok((
        token,
        DownloadGuard {
            state,
            name: name.to_string(),
        },
    ))
}

fn http_client() -> Result<reqwest::Client, IpcError> {
    reqwest::Client::builder()
        .user_agent("gitpervisor-llm")
        // 죽은 연결에 영원히 매달리지 않게. **전체 시한(`timeout`)은 쓰면 안 된다** — GB 단위
        // 다운로드는 어떤 상한이든 정상적으로 넘긴다. `read_timeout`은 읽기마다 리셋돼
        // "멈춘 연결"만 걷어낸다. 여기서 끝나야 `DownloadGuard`가 떨어지고 그 이름으로 다시
        // 받을 수 있다(안 그러면 그 이름이 영구히 Busy로 굳는다).
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| io(format!("HTTP 클라이언트 오류: {e}")))
}

/// 런타임 아카이브 1개를 보장 — 이미 설치돼 있으면 즉시 반환(멱등).
/// Windows Vulkan 폴백(server.rs)도 이 함수를 cpu 스펙으로 다시 부른다.
pub async fn ensure_runtime(
    app: &AppHandle,
    state: &AppState,
    art: &Artifact,
    ch: &Channel<String>,
) -> Result<PathBuf, IpcError> {
    let name = artifact_progress_name(art);
    if let Some(exe) = installed_server(app, art) {
        send_progress(ch, name, "done", None, None);
        return Ok(exe);
    }
    let root = llm_root(app).ok_or_else(|| io("앱 데이터 경로 오류".into()))?;
    std::fs::create_dir_all(&root).map_err(|e| io(format!("설치 폴더 생성 실패: {e}")))?;
    // 압축 해제본이 아카이브의 2~3배라 넉넉히 잡는다.
    check_free_space(&root, art.size * 4)?;

    let (cancel, _guard) = register_cancel(state, name)?;
    let client = http_client()?;
    let temp = root.join(format!(".tmp-{}", art.dir));
    std::fs::remove_dir_all(&temp).ok();
    std::fs::create_dir_all(&temp).map_err(|e| io(format!("temp 생성 실패: {e}")))?;

    send_progress(ch, name, "download", Some(0), None);
    let archive = temp.join("archive");
    download_verified(&client, art.url, art.sha256, &archive, name, ch, &cancel).await?;
    send_progress(ch, name, "extract", None, None);
    extract_archive(art.kind, &archive, &temp)?;
    std::fs::remove_file(&archive).ok();

    let src = match art.inner_dir {
        Some(inner) => temp.join(inner),
        None => temp.clone(),
    };
    let dest = root.join(art.dir);
    std::fs::remove_dir_all(&dest).ok();
    std::fs::rename(&src, &dest).map_err(|e| io(format!("설치 이동 실패: {e}")))?;
    std::fs::remove_dir_all(&temp).ok();

    #[cfg(not(windows))]
    {
        // tar가 모드를 보존하지만 zip 경로·이상한 umask에서도 확실하게(ffmpeg 관례).
        use std::os::unix::fs::PermissionsExt;
        let bin = dest.join(art.exe_rel);
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&bin, perm);
        }
    }
    std::fs::write(dest.join(".ok"), LLAMA_BUILD).map_err(|e| io(format!("마커 쓰기 실패: {e}")))?;
    send_progress(ch, name, "done", None, None);
    Ok(dest.join(art.exe_rel))
}

// ══════════════════════════ 상태 ══════════════════════════

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub label: String,
    pub repo: String,
    pub file: String,
    pub size: u64,
    pub min_ram: u64,
    pub note: String,
    pub present: bool,
    pub path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub model: String,
    pub port: u16,
    pub ready: bool,
    /// 마지막 활동 이후 경과 초 — UI가 "유휴 N분"을 그린다(리퍼는 10분).
    pub idle_secs: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    /// 설치된 빌드 태그(없으면 null).
    pub runtime: Option<String>,
    /// 설치 경로 — 진단용.
    pub runtime_path: Option<String>,
    /// 아직 안 받았을 때 버튼에 적을 다운로드 크기(바이트). 이 플랫폼에 스펙이 없으면 0.
    pub runtime_size: u64,
    /// 이 플랫폼에 관리형 런타임 스펙이 있는가(없으면 외부 URL 모드만 가능).
    pub runtime_supported: bool,
    pub models: Vec<ModelStatus>,
    pub server: Option<ServerStatus>,
    /// 설정의 사용자 지정 GGUF 경로가 실재하는가.
    pub custom_model_ok: bool,
}

pub fn status(app: &AppHandle, state: &AppState) -> LlmStatus {
    let backend = state
        .settings
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .llm_backend
        .clone();
    let art = spec_for_backend(&backend);
    let installed = art.as_ref().and_then(|a| installed_server(app, a));
    let models = MODELS
        .iter()
        .map(|m| {
            let path = installed_model(app, m);
            ModelStatus {
                id: m.id.to_string(),
                label: m.label.to_string(),
                repo: m.repo.to_string(),
                file: m.file.to_string(),
                size: m.size,
                min_ram: m.min_ram,
                note: m.note.to_string(),
                present: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect();
    let custom_model_ok = {
        let s = state.settings.read().unwrap_or_else(|e| e.into_inner());
        custom_model(s.llm_custom_model_path.as_deref()).is_some()
    };
    LlmStatus {
        runtime: installed.as_ref().map(|_| LLAMA_BUILD.to_string()),
        runtime_path: installed.map(|p| p.to_string_lossy().into_owned()),
        runtime_size: art.as_ref().map(|a| a.size).unwrap_or(0),
        runtime_supported: art.is_some(),
        models,
        server: crate::llm::server::server_status(state),
        custom_model_ok,
    }
}

// ══════════════════════════ 커맨드 ══════════════════════════

/// 런타임 앱 내 다운로드 — 설정 버튼 클릭으로만("클릭이 곧 동의", ffmpeg·LSP 정책).
#[tauri::command]
pub async fn llm_runtime_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<String>,
) -> Result<LlmStatus, IpcError> {
    let backend = state
        .settings
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .llm_backend
        .clone();
    let art = spec_for_backend(&backend).ok_or_else(|| {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "이 플랫폼용 llama.cpp 공식 빌드가 없습니다 — 고급 › 외부 서버 URL을 쓰세요",
        )
    })?;
    if let Err(e) = ensure_runtime(&app, state.inner(), &art, &on_progress).await {
        let msg = e.to_string().replace('"', "'");
        send_progress(&on_progress, artifact_progress_name(&art), "error", None, Some(&msg));
        return Err(e);
    }
    Ok(status(&app, state.inner()))
}

/// GGUF 모델 다운로드(1.8~5.0GB) — 진행률·sha256 검증·`.part` 원자 설치·취소.
#[tauri::command]
pub async fn llm_model_download(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
    on_progress: Channel<String>,
) -> Result<LlmStatus, IpcError> {
    let spec = model_spec(&model_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("모르는 모델: {model_id}")))?;
    let run = async {
        let dir = models_dir(&app).ok_or_else(|| io("앱 데이터 경로 오류".into()))?;
        std::fs::create_dir_all(&dir).map_err(|e| io(format!("모델 폴더 생성 실패: {e}")))?;
        let dest = dir.join(spec.file);
        if dest.is_file() {
            send_progress(&on_progress, spec.id, "done", None, None);
            return Ok(());
        }
        check_free_space(&dir, spec.size)?;
        let (cancel, _guard) = register_cancel(state.inner(), spec.id)?;
        let client = http_client()?;
        send_progress(&on_progress, spec.id, "download", Some(0), None);
        download_verified(
            &client,
            &model_url(spec),
            spec.sha256,
            &dest,
            spec.id,
            &on_progress,
            &cancel,
        )
        .await?;
        send_progress(&on_progress, spec.id, "done", None, None);
        Ok::<(), IpcError>(())
    }
    .await;
    if let Err(e) = run {
        let msg = e.to_string().replace('"', "'");
        send_progress(&on_progress, spec.id, "error", None, Some(&msg));
        return Err(e);
    }
    Ok(status(&app, state.inner()))
}

/// 진행 중인 다운로드 취소 — 이름은 `"runtime"`·`"runtime-cpu"` 또는 모델 id. 없으면 no-op.
#[tauri::command]
pub fn llm_download_cancel(state: State<'_, AppState>, name: String) -> Result<(), IpcError> {
    if let Some(token) = state
        .llm_downloads
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&name)
    {
        token.cancel();
    }
    Ok(())
}

/// 모델 파일 삭제(GB 단위 회수). 서버가 그 모델을 물고 있으면 먼저 내린다(§3.3).
#[tauri::command]
pub async fn llm_model_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
) -> Result<LlmStatus, IpcError> {
    let spec = model_spec(&model_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, format!("모르는 모델: {model_id}")))?;
    crate::llm::server::stop_if_model(state.inner(), spec.id);
    if let Some(dir) = models_dir(&app) {
        let dest = dir.join(spec.file);
        if dest.is_file() {
            std::fs::remove_file(&dest).map_err(|e| io(format!("모델 삭제 실패: {e}")))?;
        }
        std::fs::remove_file(dest.with_extension("part")).ok();
    }
    Ok(status(&app, state.inner()))
}

/// 런타임·모델·서버 현재 상태. 설정 AI 페이지와 60·61의 "준비 안 됨" 안내가 쓴다.
#[tauri::command]
pub fn llm_status(app: AppHandle, state: State<'_, AppState>) -> Result<LlmStatus, IpcError> {
    // 고아 `.part`·`.tmp-*` 청소는 여기서 **딱 한 번**(§3.2는 "재시작 시 삭제"다). 설정 화면이
    // 5초마다 이 커맨드를 부르므로 매번 디스크를 훑을 이유가 없다.
    static SWEPT: std::sync::Once = std::sync::Once::new();
    SWEPT.call_once(|| sweep_stale_downloads(&app, state.inner()));
    Ok(status(&app, state.inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 카탈로그의 sha256은 **64자 소문자 hex**여야 한다. 대문자나 잘린 값이 섞이면 다운로드는
    /// 끝까지 돌고 마지막 비교에서만 실패한다 — GB를 다 받은 뒤에 알게 되는 최악의 실패다.
    #[test]
    fn catalog_hashes_are_wellformed_and_ids_unique() {
        let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        for m in MODELS {
            assert!(hex(m.sha256), "{} sha256 형식 오류", m.id);
            assert!(m.size > 0, "{} size 누락", m.id);
            assert!(m.file.ends_with(".gguf"), "{} 파일명이 .gguf가 아니다", m.id);
        }
        let mut ids: Vec<&str> = MODELS.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "모델 id가 중복됐다");
        for art in [runtime_spec(), cpu_spec()].into_iter().flatten() {
            assert!(hex(art.sha256), "런타임 {} sha256 형식 오류", art.dir);
            assert!(art.url.contains(LLAMA_BUILD), "런타임 URL이 빌드 태그와 어긋난다");
        }
    }

    /// cpu 폴백 스펙은 기본 스펙과 **다른 폴더**여야 한다 — 같으면 폴백 설치가 원본을 덮어
    /// 되돌릴 방법이 사라진다(설정에서 auto로 되돌려도 CPU 빌드가 돈다).
    #[test]
    fn cpu_fallback_installs_into_its_own_dir() {
        if let (Some(a), Some(b)) = (runtime_spec(), cpu_spec()) {
            assert_ne!(a.dir, b.dir);
        }
    }
}
