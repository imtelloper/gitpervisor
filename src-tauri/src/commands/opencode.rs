//! OpenCode(anomalyco/opencode, MIT) 관리형 실행 파일 — "OpenCode 세션으로 새 터미널"이 사용자
//! 설치 없이 뜨게 한다.
//!
//! **원본 바이너리를 그대로 받는다(포크하지 않는다).** 동작 조정은 전부 OpenCode의 공식 설정 경로
//! `OPENCODE_CONFIG`(전역 설정보다 위, 프로젝트 `opencode.json`보다 아래)로 넣는다 — 그 파일을
//! 여기서 만든다. `OPENCODE_CONFIG_CONTENT`를 쓰지 않는 이유: 우선순위가 가장 높아 사용자의
//! 프로젝트 설정을 덮는다.
//!
//! 받는 방식은 로컬 LLM 런타임(`llm/acquire.rs`)과 같다: sha256 코드 고정, `.part` 원자 설치,
//! `.ok` 마커. 모델은 정하지 않는다 — 인증이 없으면 OpenCode가 스스로 무료 모델만 남겨 쓴다
//! (opencode v1.18 `provider.ts`의 `opencode` 로더: 키가 없으면 `cost.input === 0`만 남기고
//! `apiKey: "public"`). 무료 목록은 수시로 바뀌므로 여기서 모델 id를 박으면 그게 사라지는 날 깨진다.

use std::io::BufReader;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio_util::sync::CancellationToken;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::{self, text_db, text_tools, Lang};
use crate::llm::acquire::{check_free_space, download_verified, http_client, send_progress};
use crate::llm::{relay, server};
use crate::state::AppState;

/// 받을 OpenCode 릴리스. 올릴 때는 아래 sha256·크기를 **같은 릴리스의 자산에서 다시 채록**한다.
pub const OPENCODE_VERSION: &str = "1.18.32";

/// 진행 이벤트의 `name` — 프론트가 이 값으로 토스트를 고른다.
const PROGRESS_NAME: &str = "opencode";

#[derive(Clone, Copy)]
enum Archive {
    Zip,
    TarGz,
}

struct Artifact {
    asset: &'static str,
    sha256: &'static str,
    size: u64,
    kind: Archive,
    /// 아카이브 최상위의 실행 파일 이름 — 세 OS 모두 폴더 없이 파일 하나다(2026-09-27 실측).
    exe: &'static str,
}

/// 이 플랫폼의 자산. sha256은 GitHub 릴리스 API의 asset `digest`(2026-09-27)이고, darwin-arm64·
/// linux-x64-baseline·windows-x64-baseline은 직접 받아 shasum으로 대조했다.
///
/// x64는 **baseline** 빌드다. 일반 빌드는 Bun이 AVX2를 가정해 구형 CPU에서 첫 명령에 SIGILL로
/// 죽는데, 터미널엔 "Illegal instruction" 한 줄만 남아 원인을 알기 어렵다. 에이전트 CLI라 성능 차는 없다.
/// Linux는 glibc 빌드(musl 아님) — 배포 대상(deb)이 glibc 배포판이다.
fn artifact() -> Option<Artifact> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(Artifact {
            asset: "opencode-darwin-arm64.zip",
            sha256: "fa643f93401c13508d8d513780e54ce9cc01203d501114be9b88d62408b8101f",
            size: 46_299_070,
            kind: Archive::Zip,
            exe: "opencode",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some(Artifact {
            asset: "opencode-darwin-x64-baseline.zip",
            sha256: "3888d74f1478b94ab1682a7c30942ab53e1266329f3786cf05e499381572dea8",
            size: 48_490_250,
            kind: Archive::Zip,
            exe: "opencode",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(Artifact {
            asset: "opencode-linux-x64-baseline.tar.gz",
            sha256: "763af386ef88a8cab18df00fcf055690e5a55e31a7088beabe02307142a6adce",
            size: 60_608_354,
            kind: Archive::TarGz,
            exe: "opencode",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some(Artifact {
            asset: "opencode-linux-arm64.tar.gz",
            sha256: "568461b7d4d8c19865c97e9a1102e613049c6039d01fe772154de873c1865840",
            size: 60_418_875,
            kind: Archive::TarGz,
            exe: "opencode",
        })
    } else if cfg!(all(windows, target_arch = "x86_64")) {
        Some(Artifact {
            asset: "opencode-windows-x64-baseline.zip",
            sha256: "cd852831bd094c2df2eb379eb98bed7a63db7f823a7caf277c732cdac33cbdb6",
            size: 62_101_771,
            kind: Archive::Zip,
            exe: "opencode.exe",
        })
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some(Artifact {
            asset: "opencode-windows-arm64.zip",
            sha256: "5c1c21e85b694ac3fedccff22f934484c29273d5b5780eff006960304108e124",
            size: 60_591_906,
            kind: Archive::Zip,
            exe: "opencode.exe",
        })
    } else {
        None
    }
}

fn asset_url(art: &Artifact) -> String {
    format!(
        "https://github.com/anomalyco/opencode/releases/download/v{OPENCODE_VERSION}/{}",
        art.asset
    )
}

fn io(e: String) -> IpcError {
    IpcError::new(ErrorCode::Io, e)
}

/// ffmpeg와 같은 관리형 도구 루트(`app_local_data_dir/tools`).
fn tools_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("tools"))
}

fn install_dir(root: &Path) -> PathBuf {
    root.join(format!("opencode-{OPENCODE_VERSION}"))
}

/// 설치된 실행 파일 — `.ok` 마커와 실행 파일이 **둘 다** 있어야 인정한다(받다 만 폴더 오판 방지).
fn installed(root: &Path, art: &Artifact) -> Option<PathBuf> {
    let dir = install_dir(root);
    if !dir.join(".ok").is_file() {
        return None;
    }
    let exe = dir.join(art.exe);
    exe.is_file().then_some(exe)
}

/// 압축 해제는 **스트리밍**으로 한다. 풀면 145~185MB라 `llm/acquire.rs`처럼 통째로 메모리에
/// 올리면 순간 250MB를 잡는다(저메모리 Windows에서 이미 겪은 종류의 사고 — DOCS/windows-lowmem-postmortem.md).
fn extract(kind: Archive, archive: &Path, dest: &Path) -> Result<(), IpcError> {
    let file = std::fs::File::open(archive).map_err(|e| io(text_db::llm_archive_open_failed(e)))?;
    match kind {
        Archive::Zip => zip::ZipArchive::new(file)
            .map_err(|e| io(text_db::llm_zip_open_failed(e)))?
            .extract(dest)
            .map_err(|e| io(text_db::llm_zip_extract_failed(e))),
        Archive::TarGz => tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(file)))
            .unpack(dest)
            .map_err(|e| io(text_db::llm_tar_extract_failed(e))),
    }
}

/// 한 번에 한 설치만 — 두 창·연타가 같은 임시 폴더를 동시에 지우고 쓰지 않게 한다.
/// 뒤따른 호출은 기다렸다가 `.ok`를 보고 곧장 돌아간다(Busy로 튕기지 않는다).
static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `root` 아래에 이 버전을 보장한다(멱등). AppHandle에 기대지 않아 수동 테스트가 임시 폴더로 부른다.
async fn ensure_at(root: &Path, art: &Artifact, ch: &Channel<String>) -> Result<PathBuf, IpcError> {
    let _lock = INSTALL_LOCK.lock().await;
    if let Some(exe) = installed(root, art) {
        return Ok(exe);
    }
    std::fs::create_dir_all(root).map_err(|e| io(text_db::llm_install_dir_create_failed(e)))?;
    // 아카이브 + 해제본(약 3배) + 여유.
    check_free_space(root, art.size * 5)?;

    let temp = root.join(format!(".tmp-opencode-{OPENCODE_VERSION}"));
    // 지난번에 죽은 설치의 잔해 — 없으면 NotFound라 결과를 보지 않는다(남아 있으면 아래 create가 그대로 쓴다).
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).map_err(|e| io(text_db::llm_temp_dir_create_failed(e)))?;
    let result = async {
        send_progress(ch, PROGRESS_NAME, "download", Some(0), None);
        let archive = temp.join("archive");
        // 취소 UI는 두지 않는다 — 수십 MB라 기다리는 편이 짧다. 멈춘 연결은 read_timeout이 걷는다.
        let never = CancellationToken::new();
        download_verified(
            &http_client()?,
            &asset_url(art),
            art.sha256,
            art.size,
            &archive,
            PROGRESS_NAME,
            ch,
            &never,
        )
        .await?;
        send_progress(ch, PROGRESS_NAME, "extract", None, None);
        let unpacked = temp.join("unpacked");
        extract(art.kind, &archive, &unpacked)?;
        // 아카이브는 temp 안에 있어 마지막 remove_dir_all이 어차피 걷는다 — 여기선 공간만 먼저 돌려준다.
        let _ = std::fs::remove_file(&archive);
        let unpacked_exe = unpacked.join(art.exe);
        if !unpacked_exe.is_file() {
            return Err(io(text_tools::opencode_exe_missing(art.exe)));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&unpacked_exe, std::fs::Permissions::from_mode(0o755)).map_err(|e| {
                io(text_tools::opencode_chmod_failed(&unpacked_exe.to_string_lossy(), &e))
            })?;
        }
        let dest = install_dir(root);
        // `.ok` 없는 반쪽 폴더(받다 죽은 이동)가 있으면 치운다 — 없으면 NotFound, 실패하면 아래 rename이 알린다.
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&unpacked, &dest).map_err(|e| io(text_db::llm_install_move_failed(e)))?;
        std::fs::write(dest.join(".ok"), OPENCODE_VERSION)
            .map_err(|e| io(text_db::llm_marker_write_failed(e)))?;
        Ok(dest.join(art.exe))
    }
    .await;
    // 성공이면 이미 비었고(unpacked는 옮겨졌다), 실패면 다음 시도가 시작할 때 다시 치운다.
    let _ = std::fs::remove_dir_all(&temp);
    if result.is_ok() {
        remove_old_versions(root);
    }
    result
}

/// 버전을 올리면 옛 폴더(해제본 145~185MB)가 남는다 — 새 설치가 끝난 뒤에만 지운다.
/// 실패는 무시한다: Windows에서 그 버전이 아직 어느 터미널에서 돌고 있으면 exe가 잠겨 있다.
fn remove_old_versions(root: &Path) {
    let current = format!("opencode-{OPENCODE_VERSION}");
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with("opencode-") && name != current && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// 한국어 UI일 때 OpenCode에 거는 응답 언어 지시 — 모델 입력이지 UI 문구가 아니다(DOCS/i18n-design.md §1).
const KO_INSTRUCTIONS: &str = "# gitpervisor\n\n- 사용자에게 보이는 답변은 한국어로 작성한다. 코드·식별자·명령어·파일 경로·에러 메시지 원문은 그대로 둔다.\n"; // i18n-ok: 모델 지시문

/// OpenCode에 등록할 앱 로컬 모델(`llm/relay.rs` 중계 경유).
struct LocalProvider {
    port: u16,
    token: String,
    /// OpenCode 모델 목록에 보일 이름(카탈로그 라벨·외부 모델 이름).
    label: String,
    /// 설정 `opencode_model == "local"` — OpenCode가 처음부터 이 모델을 고른다.
    default: bool,
}

/// OpenCode 설정 JSON(순수 함수 — 테스트 대상).
///
/// - `autoupdate: false` — 받은 바이너리는 sha256으로 검증한 그 버전이어야 한다. 스스로 바뀌면
///   검증이 무의미해지고, 버전 관리는 이 파일의 `OPENCODE_VERSION`이 맡는다.
/// - `share: "disabled"` — 대화를 공개 링크로 올리는 기능. 실수로 코드가 공개되지 않게 닫는다.
/// - `instructions` — UI가 한국어면 한국어로 답하게 한다(절대경로를 받는다 — opencode `instruction.ts`).
/// - `provider.gitpervisor` — 로컬 모델. 기본으로 고를 때는 `small_model`(제목 생성 등 보조 호출)도
///   같은 모델로 묶는다: 안 묶으면 OpenCode가 보조 호출을 무료 **클라우드** 모델로 보내 "로컬만 쓴다"는
///   선택이 깨진다. `tool_call`은 필수다 — 에이전트는 파일 읽기·쓰기를 도구 호출로 한다
///   (llama.cpp b10809는 jinja 템플릿이 기본이라 도구 호출을 받는다 — 2026-09-28 Qwen3 4B로 Write 실측).
fn config_json(instructions: Option<&str>, local: Option<&LocalProvider>) -> serde_json::Value {
    let mut config = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": false,
        "share": "disabled",
    });
    if let Some(rules) = instructions {
        config["instructions"] = serde_json::json!([rules]);
    }
    if let Some(l) = local {
        config["provider"] = serde_json::json!({
            "gitpervisor": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Gitpervisor",
                "options": {
                    "baseURL": format!("http://127.0.0.1:{}/v1", l.port),
                    "apiKey": l.token,
                },
                "models": {
                    "local": {
                        "name": l.label,
                        "tool_call": true,
                        "limit": { "context": server::AGENT_MIN_CTX, "output": 4096 },
                    },
                },
            },
        });
        if l.default {
            config["model"] = serde_json::json!("gitpervisor/local");
            config["small_model"] = serde_json::json!("gitpervisor/local");
        }
    }
    config
}

/// 설정 파일을 쓴다(`OPENCODE_CONFIG`). 매번 다시 쓴다 — 중계 토큰이 앱 실행마다 바뀌고, 내용이 이 코드에
/// 박혀 있으니 버전을 올린 앱이 곧바로 새 내용을 쓰게 된다. 영어 UI는 OpenCode 기본(영어)이라 지시를 넣지 않는다.
fn write_config(dir: &Path, lang: Lang, local: Option<&LocalProvider>) -> Result<PathBuf, IpcError> {
    let write = |path: &Path, bytes: &[u8]| {
        std::fs::write(path, bytes)
            .map_err(|e| io(text_tools::opencode_config_write_failed(&path.to_string_lossy(), &e)))
    };
    let rules = if lang == Lang::Ko {
        let p = dir.join("gitpervisor-instructions.md");
        write(&p, KO_INSTRUCTIONS.as_bytes())?;
        Some(p.to_string_lossy().into_owned())
    } else {
        None
    };
    let config = config_json(rules.as_deref(), local);
    let path = dir.join("gitpervisor.json");
    // json! 값의 직렬화는 실패하지 않는다(맵 키가 전부 문자열) — 그래도 삼키지 않고 같은 오류로 올린다.
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|e| io(text_tools::opencode_config_write_failed(&path.to_string_lossy(), &e)))?;
    write(&path, &bytes)?;
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    /// 이 플랫폼용 공식 빌드가 있는가.
    supported: bool,
    installed: bool,
    version: &'static str,
    /// 아직 안 받았을 때 안내할 다운로드 크기(바이트).
    download_size: u64,
    /// 설정이 로컬 모델을 기본으로 고르는가 — 첫 실행 안내 문구가 달라진다(코드가 밖으로 안 나간다).
    local_model: bool,
}

/// 터미널에 넣을 실행 정보 — 셸 문법(따옴표·환경변수)은 프론트가 실제 띄운 셸을 보고 만든다
/// (`lib/terminal.ts` `formatLaunch`). 여기서 셸을 추측하면 term_open의 폴백이 다른 셸을 고른 날 어긋난다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeLaunch {
    exe: String,
    /// `OPENCODE_CONFIG`로 넘길 설정 파일 경로.
    config: String,
}

/// 설치 여부만 본다(네트워크 없음) — 프론트가 첫 다운로드 전에 안내를 띄울지 정한다.
#[tauri::command(async)]
pub fn opencode_status(app: AppHandle, state: State<'_, AppState>) -> Result<OpencodeStatus, IpcError> {
    let art = artifact();
    let local_model = state.settings.read().unwrap_or_else(|e| e.into_inner()).opencode_model == "local";
    Ok(OpencodeStatus {
        supported: art.is_some(),
        installed: match (&art, tools_root(&app)) {
            (Some(a), Some(root)) => installed(&root, a).is_some(),
            _ => false,
        },
        version: OPENCODE_VERSION,
        download_size: art.map_or(0, |a| a.size),
        local_model,
    })
}

/// 실행 파일을 보장(없으면 받는다)하고 설정 파일을 쓴 뒤 실행 정보를 돌려준다.
/// "OpenCode 세션으로 새 터미널" 클릭으로만 불린다 — 첫 다운로드 전에 프론트가 안내·확인을 받는다.
#[tauri::command(async)]
pub async fn opencode_ensure(
    app: AppHandle,
    state: State<'_, AppState>,
    on_progress: Channel<String>,
) -> Result<OpencodeLaunch, IpcError> {
    let art = artifact()
        .ok_or_else(|| IpcError::new(ErrorCode::ToolNotFound, text_tools::opencode_unsupported_platform()))?;
    let root = tools_root(&app).ok_or_else(|| io(text_db::llm_app_data_dir_error().into()))?;
    let want_local = state.settings.read().unwrap_or_else(|e| e.into_inner()).opencode_model == "local";
    let result: Result<OpencodeLaunch, IpcError> = async {
        // 로컬 모델 확인은 **다운로드보다 먼저** — 모델이 없으면 40MB를 받고 나서야 알리지 않는다.
        // 서버는 띄우지 않는다(수 GB 로드) — 첫 요청이 올 때 중계가 띄운다.
        let local = match server::local_model_label(&app, state.inner()) {
            Ok(label) => {
                let (port, token) = relay::ensure_relay(&app)?;
                Some(LocalProvider { port, token, label, default: want_local })
            }
            Err(e) if want_local => return Err(e),
            // 무료 모델이 기본이면 로컬 모델이 없어도 된다 — OpenCode 모델 목록에 안 넣을 뿐이다.
            Err(_) => None,
        };
        let exe = ensure_at(&root, &art, &on_progress).await?;
        let config = write_config(&install_dir(&root), i18n::lang(), local.as_ref())?;
        Ok(OpencodeLaunch {
            exe: exe.to_string_lossy().into_owned(),
            config: config.to_string_lossy().into_owned(),
        })
    }
    .await;
    match &result {
        Ok(_) => send_progress(&on_progress, PROGRESS_NAME, "done", None, None),
        Err(e) => {
            let msg = e.to_string();
            send_progress(&on_progress, PROGRESS_NAME, "error", None, Some(&msg));
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 로컬 모델을 기본으로 고르면 보조 호출(small_model)까지 로컬로 묶는다 — 안 묶으면 제목 생성 같은
    /// 호출이 무료 클라우드로 나가 "코드가 밖으로 안 나간다"는 선택이 조용히 깨진다.
    #[test]
    fn local_default_pins_both_models_and_keeps_safety_flags() {
        let l = LocalProvider { port: 4321, token: "t".into(), label: "Qwen3 4B".into(), default: true };
        let c = config_json(Some("/x/rules.md"), Some(&l));
        assert_eq!(c["autoupdate"], false);
        assert_eq!(c["share"], "disabled");
        assert_eq!(c["model"], "gitpervisor/local");
        assert_eq!(c["small_model"], "gitpervisor/local");
        let p = &c["provider"]["gitpervisor"];
        assert_eq!(p["options"]["baseURL"], "http://127.0.0.1:4321/v1");
        assert_eq!(p["options"]["apiKey"], "t");
        assert_eq!(p["models"]["local"]["tool_call"], true);
        assert_eq!(p["models"]["local"]["limit"]["context"], server::AGENT_MIN_CTX);
        assert_eq!(c["instructions"][0], "/x/rules.md");

        // 무료 모델이 기본이면 로컬은 목록에만 있고 기본값을 건드리지 않는다.
        let l = LocalProvider { default: false, ..l };
        let c = config_json(None, Some(&l));
        assert!(c.get("model").is_none() && c.get("small_model").is_none());
        assert!(c.get("instructions").is_none());
        assert!(config_json(None, None).get("provider").is_none());
    }

    /// [수동] 실제 릴리스를 임시 폴더에 받아 설치·검증·실행까지 — 네트워크가 필요해 기본 제외.
    /// `cargo test --lib opencode -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn downloads_verifies_and_runs() {
        let art = artifact().expect("이 플랫폼 자산");
        let root = std::env::temp_dir().join(format!("gpv-opencode-test-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        // 옛 버전 폴더가 새 설치 뒤 치워지는지도 함께 본다.
        std::fs::create_dir_all(root.join("opencode-0.0.1")).unwrap();
        let ch = Channel::new(|_| Ok(()));

        let exe = ensure_at(&root, &art, &ch).await.expect("설치");
        assert!(exe.is_file());
        assert!(!root.join("opencode-0.0.1").exists(), "옛 버전 폴더가 남았다");
        assert!(!root.join(format!(".tmp-opencode-{OPENCODE_VERSION}")).exists(), "임시 폴더가 남았다");
        // 두 번째 호출은 받지 않고 같은 경로를 돌려준다(멱등).
        assert_eq!(ensure_at(&root, &art, &ch).await.unwrap(), exe);

        let config = write_config(&install_dir(&root), Lang::Ko, None).unwrap();
        let out = std::process::Command::new(&exe)
            .arg("--version")
            .env("OPENCODE_CONFIG", &config)
            .output()
            .expect("실행");
        let v = String::from_utf8_lossy(&out.stdout);
        eprintln!("opencode --version → {v}");
        assert!(out.status.success(), "종료 코드 {:?} stderr={}", out.status, String::from_utf8_lossy(&out.stderr));
        assert!(v.contains(OPENCODE_VERSION), "버전 불일치: {v}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// [수동] 종단 — 실제 llama-server + 우리 중계 + 실제 OpenCode(Bun fetch)로 파일을 만든다.
    /// 중계의 chunked 스트리밍을 OpenCode가 실제로 읽는지는 이 테스트만 본다(가짜 상류 테스트는 우리 쪽만 본다).
    ///
    /// 느리고 가끔 빨갛다 — 둘 다 중계 탓이 아니다(2026-09-28 실측, M1 Pro · Qwen3 4B):
    /// - 서버를 새로 띄우므로 첫 요청이 12.5K 토큰 프롬프트를 캐시 없이 처리한다: 첫 데이터까지 96~115초
    ///   (`-fa on -ub 2048`도 차이 없음). 같은 요청을 직결·중계로 보낸 차이는 첫 데이터 +20~30ms뿐이었다.
    /// - 4B 모델은 도구를 부르지 않고 "만들었다"고만 답할 때가 있다 — 그러면 hello.txt가 없어 실패한다.
    /// 설치본 경로 예: `GPV_LLAMA_SERVER=~/Library/Application Support/com.greathoon.gitpervisor/llm/llama-b10809/llama-server`
    /// `GPV_LLAMA_MODEL=…/llm/models/Qwen3-4B-Q4_K_M.gguf cargo test --lib opencode_local -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn opencode_local_model_writes_file_through_relay() {
        let (Ok(server_bin), Ok(model)) = (std::env::var("GPV_LLAMA_SERVER"), std::env::var("GPV_LLAMA_MODEL")) else {
            eprintln!("GPV_LLAMA_SERVER·GPV_LLAMA_MODEL 없음 — 건너뜀");
            return;
        };
        let root = std::env::temp_dir().join(format!("gpv-opencode-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let art = artifact().expect("이 플랫폼 자산");
        let exe = ensure_at(&root.join("tools"), &art, &Channel::new(|_| Ok(()))).await.expect("설치");

        let llama_port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let mut llama = std::process::Command::new(&server_bin)
            .args(["-m", &model, "--host", "127.0.0.1", "--port", &llama_port.to_string()])
            .args(["-c", &server::AGENT_MIN_CTX.to_string(), "-ngl", "999", "-np", "1", "--api-key", "upkey", "--no-webui"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("llama-server 기동");
        let health = format!("http://127.0.0.1:{llama_port}/health");
        let mut ready = false;
        for _ in 0..120 {
            if reqwest::get(&health).await.is_ok_and(|r| r.status().is_success()) {
                ready = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        assert!(ready, "llama-server 준비 안 됨");

        let relay_port = relay::serve_fixed_for_test(
            crate::llm::server::Endpoint {
                base: format!("http://127.0.0.1:{llama_port}"),
                key: Some("upkey".into()),
                model: "local".into(),
            },
            "relaytok",
        );
        let local = LocalProvider { port: relay_port, token: "relaytok".into(), label: "test".into(), default: true };
        let config = write_config(&root, Lang::En, Some(&local)).unwrap();
        let proj = root.join("proj");
        std::fs::create_dir_all(&proj).unwrap();
        // git 저장소여야 OpenCode가 이곳을 프로젝트 루트로 잡는다(실사용도 늘 레포 안이다).
        let _ = std::process::Command::new("git").args(["init", "-q"]).current_dir(&proj).status();
        let xdg = root.join("xdg");
        let run = tokio::process::Command::new(&exe)
            // 작은 모델은 "만들었다"고만 답하고 도구를 안 부르는 일이 있다 — 도구 사용을 명시한다.
            .args(["run", "Use the write tool to create a file named hello.txt in the current directory containing exactly: hi from relay"])
            .current_dir(&proj)
            // OpenCode는 작업 폴더를 `PWD`로 잡는다 — 안 주면 이 테스트를 돌린 셸의 PWD(저장소 안)를 물려받아
            // 파일을 **저장소 루트**에 쓴다(2026-09-28 실제로 그랬다). 앱은 PTY 셸이 PWD를 맞춰 준다.
            .env("PWD", &proj)
            .env("OPENCODE_CONFIG", &config)
            .env("XDG_DATA_HOME", xdg.join("data"))
            .env("XDG_CONFIG_HOME", xdg.join("config"))
            .env("XDG_CACHE_HOME", xdg.join("cache"))
            .env("XDG_STATE_HOME", xdg.join("state"))
            .stdin(std::process::Stdio::null())
            .output();
        let out = tokio::time::timeout(std::time::Duration::from_secs(600), run).await;
        let _ = llama.kill();
        let _ = llama.wait();
        let out = out.expect("opencode 600초 초과").expect("opencode 실행");
        eprintln!("opencode stdout:\n{}", String::from_utf8_lossy(&out.stdout));
        let written = std::fs::read_to_string(proj.join("hello.txt"));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(written.expect("hello.txt가 없다").trim(), "hi from relay");
    }

    /// 체크섬이 어긋나면 설치하지 않고 흔적도 남기지 않는다.
    #[tokio::test]
    #[ignore]
    async fn rejects_tampered_download() {
        let mut art = artifact().expect("이 플랫폼 자산");
        art.sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        let root = std::env::temp_dir().join(format!("gpv-opencode-bad-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let ch = Channel::new(|_| Ok(()));
        let err = ensure_at(&root, &art, &ch).await.expect_err("검증 실패여야 한다");
        assert!(err.to_string().contains("무결성"), "{err}");
        assert!(installed(&root, &art).is_none());
        assert!(!install_dir(&root).exists(), "설치 폴더가 생겼다");
        assert!(!root.join(format!(".tmp-opencode-{OPENCODE_VERSION}")).exists(), "임시 폴더가 남았다");
        std::fs::remove_dir_all(&root).ok();
    }
}
