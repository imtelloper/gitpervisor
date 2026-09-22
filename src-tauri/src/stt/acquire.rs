// 음성 인식 엔진·모델 획득(태스크 72 §3.2) — 59의 관리형 다운로드(`llm/acquire.rs`)를 그대로 탄다.
// 위치도 `llm/` 아래(`whisper-b5130/`, `models/ggml-*.bin`)라 고아 `.part` 청소와 dev/설치본 identifier
// 분리를 그대로 얻는다. 다운로드 취소는 기존 `llm_download_cancel(name)` — 이름 `stt-runtime`·
// `stt-model-<id>`로 같은 맵을 공유한다.
//
// **sha256은 전부 코드 고정**(공급망 원칙). 2026-09-22에 GitHub 릴리스 API digest와 HF tree API `lfs.oid`를
// 다시 받아 설계 §2.2 표와 대조했다(전부 일치).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::llm::acquire::{self as llm_acquire, ArchiveKind, Artifact, ModelSpec};
use crate::state::AppState;

/// whisper.cpp 릴리스 태그. 안정판 `v1.9.4` 태그에는 자산이 0개라 같은 커밋의 nightly를 고정한다(§2.2).
pub const WHISPER_BUILD: &str = "b5130";
/// b5130 `whisper-cli --version`이 내는 버전(부록 B.3).
const WHISPER_VERSION: &str = "1.9.4";
/// 런타임·VAD 다운로드의 진행 이벤트 이름 = 취소 레지스트리 키(llama의 "runtime"과 겹치면 안 된다).
pub const RUNTIME_NAME: &str = "stt-runtime";

macro_rules! whisper_asset {
    ($name:literal) => {
        concat!("https://github.com/ggml-org/whisper.cpp/releases/download/b5130/", $name)
    };
}

/// 이 플랫폼의 관리형 whisper-cli(CPU 빌드). macOS는 공식 CLI가 없어 None — 발견만 한다(§3.1, Q2 a).
/// `inner_dir`/`exe_rel`은 받은 아카이브를 풀어 확인한 값이다(부록 B.4).
pub fn runtime_spec() -> Option<Artifact> {
    let (url, sha256, size, kind, inner_dir, exe_rel) = if cfg!(all(windows, target_arch = "x86_64")) {
        (
            whisper_asset!("whisper-bin-x64.zip"),
            "f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c",
            8_573_270,
            ArchiveKind::Zip,
            "Release",
            "whisper-cli.exe",
        )
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        (
            whisper_asset!("whisper-bin-win-cpu-arm64.zip"),
            "799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc",
            4_361_895,
            ArchiveKind::Zip,
            "Release",
            "whisper-cli.exe",
        )
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        (
            whisper_asset!("whisper-bin-ubuntu-x64.tar.gz"),
            "53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32",
            9_793_438,
            ArchiveKind::TarGz,
            "whisper-bin-ubuntu-x64",
            "whisper-cli",
        )
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        (
            whisper_asset!("whisper-bin-ubuntu-arm64.tar.gz"),
            "93532a0e3777f26f041ffa358ee77dd88b1a33a86847c1990745327ff335a5d6",
            4_605_905,
            ArchiveKind::TarGz,
            "whisper-bin-ubuntu-arm64",
            "whisper-cli",
        )
    } else {
        return None;
    };
    Some(Artifact {
        url,
        sha256,
        size,
        kind,
        dir: "whisper-b5130",
        inner_dir: Some(inner_dir),
        exe_rel,
        progress_name: RUNTIME_NAME,
        build: WHISPER_BUILD,
        smoke: Some(smoke_version),
    })
}

// ══════════════════════════ 모델 카탈로그 ══════════════════════════
//
// llm `MODELS`와 **분리**한다 — 그쪽 카탈로그 테스트가 `.gguf`를 단언한다. small·turbo-q8·제3자 한국어
// 파인튜닝은 넣지 않는다(small은 turbo-q5와 크기가 비슷한데 품질이 낮고, 파인튜닝은 독립 평가·라이선스
// 표기가 없다 — §3.2).

pub struct SttModel {
    pub spec: ModelSpec,
    /// `-dtw` 프리셋(모델마다 다르다 — 부록 B, 9절 1). base는 미실측.
    pub dtw: &'static str,
}

const MIB: u64 = 1024 * 1024;

pub const STT_MODELS: &[SttModel] = &[
    SttModel {
        spec: ModelSpec {
            id: "turbo-q5",
            label: "Whisper large-v3-turbo (q5_0)",
            repo: "ggerganov/whisper.cpp",
            file: "ggml-large-v3-turbo-q5_0.bin",
            sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
            size: 574_041_195,
            min_ram: 4096 * MIB,
            note: text_stt::stt_model_note_turbo_q5,
        },
        dtw: "large.v3.turbo",
    },
    SttModel {
        spec: ModelSpec {
            id: "base-q5",
            label: "Whisper base (q5_1)",
            repo: "ggerganov/whisper.cpp",
            file: "ggml-base-q5_1.bin",
            sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
            size: 59_707_625,
            min_ram: 2048 * MIB,
            note: text_stt::stt_model_note_base_q5,
        },
        dtw: "base",
    },
];

/// Silero VAD — 런타임과 함께 자동으로 받는다(선택지로 안 보인다).
pub const VAD_MODEL: ModelSpec = ModelSpec {
    id: "silero-vad",
    label: "Silero VAD v6.2.0",
    repo: "ggml-org/whisper-vad",
    file: "ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    size: 885_098,
    min_ram: 0,
    note: || "",
};

/// e2e 전용 모델(디버그 빌드만) — e2e 65 `stt-captions`가 `E2E_STT_MODEL`의 ggml-tiny.bin(77MB)을 `llm/models/`에
/// 넣고 이 id로 전사 경로 전체를 돌린다(카탈로그 모델 57~547MB를 받지 않는다 — 47 `E2E_LLM_GGUF`와 같은 자리).
/// 파일을 경로로 받지 않는 이유: whisper-cli에는 앱 데이터 아래 ASCII 상대 경로만 넘긴다(transcribe.rs 머리 주석).
/// `stt_status` 목록에는 없어 화면에 안 보이고, 릴리스 빌드에서는 모르는 id다.
#[cfg(debug_assertions)]
static E2E_MODEL: SttModel = SttModel {
    spec: ModelSpec {
        id: "e2e-tiny",
        label: "Whisper tiny (e2e)",
        repo: "ggerganov/whisper.cpp",
        file: "ggml-tiny.bin",
        sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        size: 77_691_713,
        min_ram: 0,
        note: || "",
    },
    dtw: "tiny",
};

pub fn stt_model(id: &str) -> Option<&'static SttModel> {
    let found = STT_MODELS.iter().find(|m| m.spec.id == id);
    #[cfg(debug_assertions)]
    let found = found.or((id == E2E_MODEL.spec.id).then_some(&E2E_MODEL));
    found
}

fn model_progress_name(id: &str) -> String {
    format!("stt-model-{id}")
}

// ══════════════════════════ 발견 체인 ══════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SttSource {
    Managed,
    Path,
    Wellknown,
}

#[derive(Clone)]
pub(crate) struct WhisperBin {
    pub exe: PathBuf,
    pub source: SttSource,
}

/// Homebrew는 `whisper-cli`, 옛 formula는 `whisper-cpp`로 깔았다 — 실제 파일 이름은 mac 실기 미확인(§2.2)이라
/// 둘 다 본다. 엉뚱한 바이너리를 집어도 첫 사용 때 플래그 검사(`ensure_usable`)가 막는다.
const EXE_NAMES: &[&str] = &["whisper-cli", "whisper-cpp"];

/// 관리형 → PATH → 관례 경로. 레포 안 바이너리는 찾지 않는다(video.rs 모듈 주석과 같은 공급망 방어).
pub(crate) fn find_whisper(app: &AppHandle) -> Option<WhisperBin> {
    if let Some(exe) = runtime_spec().and_then(|art| llm_acquire::installed_server(app, &art)) {
        return Some(WhisperBin { exe, source: SttSource::Managed });
    }
    for name in EXE_NAMES {
        if let Some(exe) = crate::tools::runner::find_on_path(name) {
            return Some(WhisperBin { exe, source: SttSource::Path });
        }
    }
    // GUI로 띄운 앱의 PATH에는 Homebrew 경로가 없다(video.rs find_ffmpeg ②′와 같은 이유).
    for name in EXE_NAMES {
        if let Some(exe) = crate::tools::runner::find_in_wellknown_dirs(name) {
            return Some(WhisperBin { exe, source: SttSource::Wellknown });
        }
    }
    None
}

/// 짧은 실행(`--version`·`--help`) — 출력은 진단·패턴 검사용이라 lossy로 충분하다.
///
/// `wait_with_output`을 별도 스레드에서 돌린다: 호출자가 동기(`Artifact.smoke`)이고, `--help`는 Windows
/// 파이프 버퍼(4KB)보다 길어서 읽지 않고 종료만 기다리면 자식이 쓰기에서 멈춘다.
fn run_short(exe: &Path, args: &[&str]) -> Result<(Option<i32>, String, String), IpcError> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 시간 초과 시 kill_pid(killpg)가 닿게
    }
    let child = cmd
        .spawn()
        .map_err(|e| IpcError::new(ErrorCode::Io, text_stt::stt_exec_failed(&exe.display(), &e)))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok(Ok(out)) => Ok((
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )),
        Ok(Err(e)) => Err(IpcError::new(
            ErrorCode::Io,
            text_stt::stt_output_collect_failed(&exe.display(), &e),
        )),
        Err(_) => {
            crate::commands::kill_pid(pid);
            Err(IpcError::new(
                ErrorCode::Timeout,
                text_stt::stt_exec_no_response(&exe.display()),
            ))
        }
    }
}

/// Windows `STATUS_DLL_NOT_FOUND`(0xC0000135) — 로더가 DLL을 못 찾아 main 전에 죽은 종료 코드.
const WIN_DLL_NOT_FOUND: i32 = 0xC000_0135_u32 as i32;

/// 설치 스모크 판정(순수) — `.ok`를 쓰기 **전에** 실행해 "풀리기만 하고 못 도는" 설치를 거른다.
/// `--help`에는 버전이 없어서 `--version`의 stdout을 본다(부록 B.3).
pub(crate) fn classify_smoke(code: Option<i32>, stdout: &str, stderr: &str) -> Result<(), IpcError> {
    if code == Some(WIN_DLL_NOT_FOUND) {
        // whisper-cli.exe가 MSVCP140·VCRUNTIME140을, ggml이 VCOMP140을 가져오는데 zip에 동봉돼 있지 않다(부록 B.4).
        return Err(IpcError::new(ErrorCode::ToolNotFound, text_stt::stt_vc_redist_required()));
    }
    if stderr.contains("GLIBC_") || stderr.contains("libgomp") || stderr.contains("error while loading shared libraries") {
        return Err(IpcError {
            code: ErrorCode::ToolNotFound,
            message: text_stt::stt_glibc_unsupported().into(),
            stderr: Some(stderr.to_string()),
        });
    }
    if code != Some(0) || !stdout.contains(WHISPER_VERSION) {
        return Err(IpcError {
            code: ErrorCode::Io,
            message: text_stt::stt_engine_check_failed(
                code,
                &crate::commands::last_error_line(&format!("{stdout}\n{stderr}")),
            ),
            stderr: Some(stderr.to_string()),
        });
    }
    Ok(())
}

fn smoke_version(exe: &Path) -> Result<(), IpcError> {
    let (code, stdout, stderr) = run_short(exe, &["--version"])?;
    classify_smoke(code, &stdout, &stderr)
}

/// 우리가 넘기는 플래그 전부(transcribe.rs `build_whisper_args`). 비관리 바이너리(brew 등)는 버전을 통제할 수
/// 없어서 `--help`에 이것들이 다 있어야 쓴다.
pub(crate) const REQUIRED_FLAGS: &[&str] = &[
    "-m", "-f", "-l", "--vad", "-vm", "-nfa", "-dtw", "-sns", "-ojf", "-pp", "-t", "-of", "--prompt", "-bs", "-bo",
];

/// `--help` 원문에서 빠진 플래그(순수). 옵션 칸이 `-ojf,      --output-json-full` 모양이라 공백·쉼표로 자른다.
pub(crate) fn missing_flags(help: &str) -> Vec<&'static str> {
    let seen: std::collections::HashSet<&str> = help
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| w.starts_with('-'))
        .collect();
    REQUIRED_FLAGS.iter().copied().filter(|f| !seen.contains(f)).collect()
}

/// `whisper.cpp version: 1.9.4` → "1.9.4".
fn parse_version_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("whisper.cpp version:"))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// 통과한 비관리 바이너리의 버전 — 프로세스 수명 캐시(§3.1). 실패는 캐시하지 않는다: brew로 올린 뒤
/// 앱을 다시 켜지 않아도 되게.
static USABLE: Mutex<Option<HashMap<PathBuf, String>>> = Mutex::new(None);

/// 쓸 수 있는 엔진인지 확인하고 문서에 남길 빌드 문자열을 돌려준다. 관리형은 스모크를 통과해야 `.ok`가
/// 생기므로 다시 보지 않는다. 블로킹이라 async 호출자는 spawn_blocking으로 부른다.
pub(crate) fn ensure_usable(bin: &WhisperBin) -> Result<String, IpcError> {
    if bin.source == SttSource::Managed {
        return Ok(WHISPER_BUILD.to_string());
    }
    if let Some(v) = USABLE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|m| m.get(&bin.exe).cloned())
    {
        return Ok(v);
    }
    // --help는 stderr로 나온다(b5130 실측) — 둘 다 본다.
    let (_, out, err) = run_short(&bin.exe, &["--help"])?;
    let missing = missing_flags(&format!("{out}\n{err}"));
    if !missing.is_empty() {
        return Err(IpcError::new(
            ErrorCode::ToolNotFound,
            text_stt::stt_whisper_too_old(&bin.exe.display(), &missing.join(" ")),
        ));
    }
    // 버전 표기가 없는 옛 빌드도 플래그만 맞으면 쓴다 — 문서에는 "unknown"으로 남긴다.
    let version = run_short(&bin.exe, &["--version"])
        .ok()
        .and_then(|(_, out, _)| parse_version_line(&out))
        .unwrap_or_else(|| "unknown".into());
    USABLE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(bin.exe.clone(), version.clone());
    Ok(version)
}

// ══════════════════════════ 상태 ══════════════════════════

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum SttRuntime {
    Found { path: String, source: SttSource },
    /// 관리형 스펙이 있는데 아직 안 받았다.
    Missing,
    /// 관리형이 없는 플랫폼(macOS 등)이고 발견된 것도 없다 — `brew install whisper-cpp` 안내.
    Unsupported,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttModelStatus {
    pub id: String,
    pub label: String,
    pub size: u64,
    pub note: String,
    pub installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttStatus {
    pub runtime: SttRuntime,
    /// 아직 안 받았을 때 버튼에 적을 런타임 다운로드 크기(바이트, VAD 포함). 관리형이 없으면 0.
    pub runtime_size: u64,
    pub models: Vec<SttModelStatus>,
    pub vad_installed: bool,
}

pub(crate) fn status(app: &AppHandle) -> SttStatus {
    let spec = runtime_spec();
    let runtime = match (find_whisper(app), &spec) {
        (Some(bin), _) => SttRuntime::Found {
            path: bin.exe.display().to_string(),
            source: bin.source,
        },
        (None, Some(_)) => SttRuntime::Missing,
        (None, None) => SttRuntime::Unsupported,
    };
    SttStatus {
        runtime,
        runtime_size: spec.map_or(0, |a| a.size + VAD_MODEL.size),
        models: STT_MODELS
            .iter()
            .map(|m| SttModelStatus {
                id: m.spec.id.to_string(),
                label: m.spec.label.to_string(),
                size: m.spec.size,
                note: (m.spec.note)().to_string(),
                installed: llm_acquire::installed_model(app, &m.spec).is_some(),
            })
            .collect(),
        vad_installed: llm_acquire::installed_model(app, &VAD_MODEL).is_some(),
    }
}

// ══════════════════════════ 커맨드 ══════════════════════════

/// 엔진·모델 설치 상태. 앱 데이터의 고아 전사 임시 파일 청소는 여기서 한 번만(llm_status와 같은 방침).
#[tauri::command(async)]
pub fn stt_status(app: AppHandle) -> Result<SttStatus, IpcError> {
    static SWEPT: std::sync::Once = std::sync::Once::new();
    SWEPT.call_once(|| crate::stt::transcribe::sweep_stale_temp(&app));
    Ok(status(&app))
}

/// 런타임 + VAD 다운로드 — 설정 버튼 클릭으로만("클릭이 곧 동의"). 스모크를 통과해야 `.ok`가 생긴다.
/// 관리형이 없는 플랫폼은 VAD만 받고, 발견된 whisper-cli가 없으면 설치 안내로 끝난다.
#[tauri::command(async)]
pub async fn stt_runtime_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<String>,
) -> Result<SttStatus, IpcError> {
    // 실패 시 error 진행은 download_model이 직접 보낸다.
    llm_acquire::download_model(&app, state.inner(), &VAD_MODEL, RUNTIME_NAME, &on_progress).await?;
    let engine = async {
        match runtime_spec() {
            Some(art) => llm_acquire::ensure_runtime(&app, state.inner(), &art, &on_progress)
                .await
                .map(|_| ()),
            None if find_whisper(&app).is_some() => {
                llm_acquire::send_progress(&on_progress, RUNTIME_NAME, "done", None, None);
                Ok(())
            }
            None => Err(IpcError::new(ErrorCode::ToolNotFound, text_stt::stt_no_official_build())),
        }
    }
    .await;
    if let Err(e) = engine {
        let msg = e.to_string().replace('"', "'");
        llm_acquire::send_progress(&on_progress, RUNTIME_NAME, "error", None, Some(&msg));
        return Err(e);
    }
    Ok(status(&app))
}

/// 카탈로그 모델 다운로드(57MiB·547MiB) — 진행률·sha256·`.part` 원자 설치·취소(`stt-model-<id>`).
#[tauri::command(async)]
pub async fn stt_model_download(
    app: AppHandle,
    state: State<'_, AppState>,
    model_id: String,
    on_progress: Channel<String>,
) -> Result<SttStatus, IpcError> {
    let m = stt_model(&model_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, text_stt::stt_unknown_model(&model_id)))?;
    llm_acquire::download_model(&app, state.inner(), &m.spec, &model_progress_name(m.spec.id), &on_progress)
        .await?;
    Ok(status(&app))
}

/// 모델 파일 삭제. 그 모델로 전사가 돌고 있으면 Busy(§3.2).
#[tauri::command(async)]
pub fn stt_model_delete(app: AppHandle, model_id: String) -> Result<SttStatus, IpcError> {
    let m = stt_model(&model_id)
        .ok_or_else(|| IpcError::new(ErrorCode::NotFound, text_stt::stt_unknown_model(&model_id)))?;
    if crate::stt::transcribe::active_model().as_deref() == Some(m.spec.id) {
        return Err(IpcError::new(ErrorCode::Busy, text_stt::stt_model_in_use()));
    }
    llm_acquire::delete_model(&app, &m.spec)?;
    Ok(status(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex64(s: &str) -> bool {
        s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    /// 해시는 64자 소문자 hex — 대문자·잘린 값은 다운로드를 끝까지 받고 마지막 비교에서야 실패한다.
    #[test]
    fn stt_catalog_is_wellformed() {
        for m in STT_MODELS.iter().map(|m| &m.spec).chain([&VAD_MODEL]) {
            assert!(hex64(m.sha256), "{} sha256 형식 오류", m.id);
            assert!(m.size > 0, "{} size 누락", m.id);
            assert!(m.file.ends_with(".bin"), "{} 파일명이 .bin이 아니다", m.id);
        }
        let mut ids: Vec<&str> = STT_MODELS.iter().map(|m| m.spec.id).chain([VAD_MODEL.id]).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "음성 인식 모델 id가 중복됐다");
        // llm 모델과 이름이 겹치면 진행·취소 이름이 섞인다(llm은 모델 id를 그대로 쓴다).
        for m in crate::llm::acquire::MODELS {
            assert!(stt_model(m.id).is_none(), "{} 가 llm 카탈로그와 겹친다", m.id);
        }
        assert!(STT_MODELS.iter().all(|m| !m.dtw.is_empty()), "-dtw 프리셋 누락");
        assert!(stt_model("turbo-q5").is_some(), "설정 기본값(turbo-q5)이 카탈로그에 있어야 한다");
    }

    /// 런타임 폴더는 llama 폴더와 달라야 한다 — 같으면 한쪽 설치가 다른 쪽을 지운다(ensure_runtime은 dest를
    /// 통째로 지우고 옮긴다). 진행 이름도 llama와 겹치면 취소가 엉뚱한 다운로드를 끊는다.
    #[test]
    fn stt_runtime_does_not_collide_with_llama() {
        let llama = [crate::llm::acquire::runtime_spec(), crate::llm::acquire::cpu_spec()];
        if let Some(w) = runtime_spec() {
            assert!(hex64(w.sha256));
            assert!(w.url.contains(WHISPER_BUILD), "런타임 URL이 빌드 태그와 어긋난다");
            assert!(w.smoke.is_some(), "whisper는 설치 스모크가 필수다(§3.2)");
            for l in llama.iter().flatten() {
                assert_ne!(w.dir, l.dir);
                assert_ne!(w.progress_name, l.progress_name);
            }
        }
        assert_ne!(RUNTIME_NAME, crate::llm::acquire::RUNTIME_NAME);
        assert_ne!(RUNTIME_NAME, crate::llm::acquire::RUNTIME_CPU_NAME);
        assert!(model_progress_name("turbo-q5").starts_with("stt-"));
    }

    /// b5130 `--help` 실제 출력(발췌)에는 필요한 플래그가 다 있고, 옛 빌드처럼 `--vad`·`-dtw`가 없으면 잡는다.
    #[test]
    fn stt_flag_check_reads_help_columns() {
        let help = "\
  -t N,      --threads N            [4      ] number of threads to use during computation
  -bo N,     --best-of N            [5      ] number of best candidates to keep
  -bs N,     --beam-size N          [5      ] beam size for beam search
  -ojf,      --output-json-full     [false  ] include more information in the JSON file
  -of FNAME, --output-file FNAME    [       ] output file path (without file extension)
  -pp,       --print-progress       [false  ] print progress
  -l LANG,   --language LANG        [en     ] spoken language ('auto' for auto-detect)
             --prompt PROMPT        [       ] initial prompt (max n_text_ctx/2 tokens)
  -m FNAME,  --model FNAME          [models/ggml-base.en.bin] model path
  -f FNAME,  --file FNAME           [       ] input audio file path
  -dtw MODEL --dtw MODEL            [       ] compute token-level timestamps
  -nfa,      --no-flash-attn        [false  ] disable flash attention
  -sns,      --suppress-nst         [false  ] suppress non-speech tokens
             --vad                           [false  ] enable Voice Activity Detection (VAD)
  -vm FNAME, --vad-model FNAME               [       ] VAD model path";
        assert!(missing_flags(help).is_empty(), "{:?}", missing_flags(help));
        let old: String = help.lines().filter(|l| !l.contains("--vad") && !l.contains("-dtw")).collect::<Vec<_>>().join("\n");
        assert_eq!(missing_flags(&old), vec!["--vad", "-vm", "-dtw"]);
        assert_eq!(parse_version_line("whisper.cpp version: 1.9.4\n"), Some("1.9.4".into()));
        assert_eq!(parse_version_line("usage: ..."), None);
    }

    /// 스모크 판정: 성공(버전 일치) · Windows DLL 없음 → VC++ 안내 · Linux 로더 오류 → 시스템 설치 안내.
    #[test]
    fn stt_smoke_classifies_loader_failures() {
        let load = "load_backend: loaded CPU backend from x\n";
        assert!(classify_smoke(Some(0), "whisper.cpp version: 1.9.4\n", load).is_ok());
        let dll = classify_smoke(Some(-1_073_741_515), "", "").unwrap_err();
        assert_eq!(dll.code, ErrorCode::ToolNotFound);
        assert!(dll.message.contains("Visual C++"));
        let glibc = classify_smoke(Some(1), "", "./whisper-cli: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.34' not found").unwrap_err();
        assert_eq!(glibc.code, ErrorCode::ToolNotFound);
        assert!(glibc.message.contains("PATH"));
        // 다른 버전이 풀려 있으면(아카이브 교체) 설치됨으로 굳히지 않는다.
        assert_eq!(classify_smoke(Some(0), "whisper.cpp version: 1.8.0\n", "").unwrap_err().code, ErrorCode::Io);
    }
}
