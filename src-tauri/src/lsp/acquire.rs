// LSP 서버 획득 계층 (태스크 17). M1: node는 PATH, 서버는 관리 디렉토리(fetch-lsp.mjs가 배치).
// M2에서 다운로드·해시 검증·원자 설치를 이 파일에 추가한다(§3.3). 버전 pin은 여기 상수로.

use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha512};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::error::{ErrorCode, IpcError};

// 서버 버전 pin — scripts/fetch-lsp.mjs SERVERS와 동기 유지(§4).
const BASEDPYRIGHT_VERSION: &str = "1.39.9";
const TS_LANGSERVER_VERSION: &str = "5.3.0";
const TYPESCRIPT_VERSION: &str = "5.9.3";
const NODE_VERSION: &str = "24.18.0"; // 최신 LTS(§2.9 실측) — SHASUMS256으로 무결성 검증.
const CLANGD_VERSION: &str = "22.1.6"; // clangd/clangd 릴리스(네이티브 — node 불필요).
// clangd zip은 SHASUMS를 제공 안 해 플랫폼별 sha256을 직접 pin(다운로드 시점 채록). 있는 것만 검증.
#[cfg(all(windows, target_arch = "x86_64"))]
const CLANGD_SHA256: Option<&str> =
    Some("ce54f16e0b4fd76d450eeda9664420b195360b73febcfe40e661108fa57f2ce1");
#[cfg(not(all(windows, target_arch = "x86_64")))]
const CLANGD_SHA256: Option<&str> = None; // mac/linux은 pin 미채록 — 검증 생략(경고)

const RUST_ANALYZER_VERSION: &str = "2026-07-06"; // rust-lang/rust-analyzer 날짜 태그(네이티브).
#[cfg(all(windows, target_arch = "x86_64"))]
const RUST_ANALYZER_SHA256: Option<&str> =
    Some("b046120af10d0cb7c735bbd377a53007d97048666fe967e95ea88a9fc177fa09");
#[cfg(not(all(windows, target_arch = "x86_64")))]
const RUST_ANALYZER_SHA256: Option<&str> = None;

const LUA_LS_VERSION: &str = "3.18.2"; // LuaLS/lua-language-server(네이티브, self-contained).
#[cfg(all(windows, target_arch = "x86_64"))]
const LUA_LS_SHA256: Option<&str> =
    Some("a4439a8f5e8e9e6505c11f045a7bf45db602124a1e246371c1dbe34924f3cf71");
#[cfg(not(all(windows, target_arch = "x86_64")))]
const LUA_LS_SHA256: Option<&str> = None;

const INTELEPHENSE_VERSION: &str = "1.18.5"; // npm(intelephense) — deps 웹팩 번들, node로 실행(무료 stdio).
const ZLS_VERSION: &str = "0.16.0"; // zigtools/zls(네이티브). 완전한 기능은 같은 버전대 Zig 툴체인 필요.
#[cfg(all(windows, target_arch = "x86_64"))]
const ZLS_SHA256: Option<&str> =
    Some("35cbb7163224e8cf92d21099c1b1391f2aba927f25d389f021b13a21d40b96dd");
#[cfg(not(all(windows, target_arch = "x86_64")))]
const ZLS_SHA256: Option<&str> = None;

#[derive(Clone, Copy)]
enum ArchiveKind {
    Zip,      // clangd(전 플랫폼)·rust-analyzer(win)·lua(win)·zls(win)
    GzSingle, // rust-analyzer(mac/linux) — gzip 단일 바이너리
    TarGz,    // lua(mac/linux) — 다중 파일 tar.gz
    TarXz,    // zls(mac/linux) — tar.xz(시스템 tar로 해제, in-process xz 디코더 없음)
}

pub struct ResolvedServer {
    /// 실행 프로그램 — node(py/ts) 또는 clangd(cpp) 절대경로.
    pub program: PathBuf,
    /// 인자 — [서버js, "--stdio"](py/ts) 또는 clangd 플래그(cpp).
    pub args: Vec<String>,
    pub label: String, // UI 표시
    pub version: Option<String>,
    /// TS 전용 — tsserver.js 절대경로. 프론트가 initializationOptions.tsserver.path로 넘긴다
    /// (tls 5.3.0은 --tsserver-path 플래그 없음, 실측). py/cpp는 None.
    pub tsserver: Option<String>,
}

/// 언어별 서버를 발견한다. 발견만(다운로드 자동화는 M2 나머지). 실패 시 ToolNotFound → 프론트가
/// 조용히 휴리스틱 유지. workspace_tsserver=true면 레포 node_modules/typescript를 우선(옵트인 §3.2).
pub fn resolve(
    app: &AppHandle,
    lang: &str,
    repo: &Path,
    workspace_tsserver: bool,
) -> Result<ResolvedServer, IpcError> {
    let lsp_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("앱 데이터 경로 오류: {e}")))?
        .join("lsp");
    let not_found = || {
        IpcError::new(
            ErrorCode::ToolNotFound,
            "언어 서버가 설치되지 않았습니다 — 설정에서 언어 서버 다운로드 후 다시 시도하세요".to_string(),
        )
    };
    // py/ts/php는 node 위에서 도는 js 서버, cpp(clangd) 등 네이티브는 node가 필요 없다.
    let need_node = matches!(lang, "py" | "ts" | "php");
    let node = if need_node {
        resolve_node(app).ok_or_else(|| {
            IpcError::new(
                ErrorCode::ToolNotFound,
                "node를 찾지 못했습니다 — 설정에서 언어 서버 다운로드 또는 Node.js 설치".to_string(),
            )
        })?
    } else {
        PathBuf::new()
    };

    match lang {
        "py" => {
            let dir = lsp_root.join(format!("basedpyright-{BASEDPYRIGHT_VERSION}"));
            let server = dir.join("langserver.index.js");
            if !dir.join(".ok").is_file() || !server.is_file() {
                return Err(not_found());
            }
            Ok(ResolvedServer {
                program: node,
                args: vec![server.to_string_lossy().into_owned(), "--stdio".into()],
                label: format!("basedpyright {BASEDPYRIGHT_VERSION}"),
                version: Some(BASEDPYRIGHT_VERSION.to_string()),
                tsserver: None,
            })
        }
        "ts" => {
            let tls_dir = lsp_root.join(format!("typescript-language-server-{TS_LANGSERVER_VERSION}"));
            let server = tls_dir.join("lib").join("cli.mjs");
            if !tls_dir.join(".ok").is_file() || !server.is_file() {
                return Err(not_found());
            }
            // tsserver: 워크스페이스 옵트인 우선(버전 일치), 아니면 관리 사본.
            let ws = repo.join("node_modules/typescript/lib/tsserver.js");
            let tsserver = if workspace_tsserver && ws.is_file() {
                ws
            } else {
                let ts_dir = lsp_root.join(format!("typescript-{TYPESCRIPT_VERSION}"));
                let managed = ts_dir.join("lib").join("tsserver.js");
                if !ts_dir.join(".ok").is_file() || !managed.is_file() {
                    return Err(not_found());
                }
                managed
            };
            Ok(ResolvedServer {
                program: node,
                args: vec![server.to_string_lossy().into_owned(), "--stdio".into()],
                label: format!("typescript-language-server {TS_LANGSERVER_VERSION}"),
                version: Some(TS_LANGSERVER_VERSION.to_string()),
                tsserver: Some(tsserver.to_string_lossy().into_owned()),
            })
        }
        "php" => {
            // intelephense — deps 웹팩 번들이라 node로 lib/intelephense.js 직접 실행(무료 stdio).
            let dir = lsp_root.join(format!("intelephense-{INTELEPHENSE_VERSION}"));
            let server = dir.join("lib").join("intelephense.js");
            if !dir.join(".ok").is_file() || !server.is_file() {
                return Err(not_found());
            }
            Ok(ResolvedServer {
                program: node,
                args: vec![server.to_string_lossy().into_owned(), "--stdio".into()],
                label: format!("intelephense {INTELEPHENSE_VERSION}"),
                version: Some(INTELEPHENSE_VERSION.to_string()),
                tsserver: None,
            })
        }
        // 네이티브 서버(clangd·rust-analyzer·zls) — stdio 기본, node 불필요.
        lang if native_server_for(lang).is_some() => {
            let server = native_server_for(lang).unwrap();
            let program = managed_native(&lsp_root, server).ok_or_else(not_found)?;
            let spec = native_spec(server).unwrap();
            // clangd는 로그 억제 + 백그라운드 인덱스 off(레포 .cache 오염 방지). rust-analyzer는 무인자.
            let args = match server {
                "clangd" => vec!["--log=error".into(), "--background-index=false".into()],
                _ => vec![],
            };
            Ok(ResolvedServer {
                program,
                args,
                label: format!("{} {}", spec.name, spec.version),
                version: Some(spec.version.to_string()),
                tsserver: None,
            })
        }
        // PATH 발견 서버(gopls 등) — 툴체인 설치본을 그대로 실행.
        lang if path_server_for(lang).is_some() => {
            let (bin, args, hint) = path_server_for(lang).unwrap();
            let program = find_path_server(bin).ok_or_else(|| {
                IpcError::new(
                    ErrorCode::ToolNotFound,
                    format!("{bin}을(를) 찾지 못했습니다 — 설치: {hint}"),
                )
            })?;
            Ok(ResolvedServer {
                program,
                args,
                label: bin.to_string(),
                version: None,
                tsserver: None,
            })
        }
        other => Err(IpcError::new(
            ErrorCode::ToolNotFound,
            format!("지원하지 않는 LSP 언어: {other}"),
        )),
    }
}

/// 네이티브(node 불필요, GitHub 릴리스 다운로드) 서버를 쓰는 언어 → 서버 이름.
fn native_server_for(lang: &str) -> Option<&'static str> {
    match lang {
        "cpp" => Some("clangd"),
        "rust" => Some("rust-analyzer"),
        "lua" => Some("lua-language-server"),
        "zig" => Some("zls"),
        _ => None,
    }
}

/// PATH 발견 서버(툴체인 제공 — 프리빌트 다운로드 없음). lang → (바이너리명, 인자, 설치 안내).
fn path_server_for(lang: &str) -> Option<(&'static str, Vec<String>, &'static str)> {
    match lang {
        "go" => Some((
            "gopls",
            vec!["serve".into()],
            "go install golang.org/x/tools/gopls@latest",
        )),
        "ruby" => Some((
            "ruby-lsp",
            vec![], // stdio 기본. 프로젝트 Ruby 환경(버전매니저 shim)에서 기동돼야 의존성 인식.
            "gem install ruby-lsp",
        )),
        "csharp" => Some((
            "csharp-ls",
            vec![], // stdio 기본. .NET SDK 6+ 필요.
            "dotnet tool install --global csharp-ls",
        )),
        "java" => Some((
            "jdtls",
            vec![], // jdtls 런처가 JRE·launcher jar·config/data를 자체 처리(stdio 기본). JRE 21+ 필요.
            "brew install jdtls (또는 mason/패키지 매니저)",
        )),
        _ => None,
    }
}

/// PATH + 흔한 설치 위치에서 서버 바이너리를 찾는다(gopls는 ~/go/bin).
fn find_path_server(bin: &str) -> Option<PathBuf> {
    if let Some(p) = find_bin_on_path(bin) {
        return Some(p);
    }
    let home = || std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok();
    if bin == "gopls" {
        // GOBIN → GOPATH/bin → ~/go/bin
        let exe = if cfg!(windows) { "gopls.exe" } else { "gopls" };
        if let Ok(gobin) = std::env::var("GOBIN") {
            let p = PathBuf::from(gobin).join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
        let gopath = std::env::var("GOPATH").ok().map(PathBuf::from);
        for base in [gopath, home().map(|h| PathBuf::from(h).join("go"))].into_iter().flatten() {
            let p = base.join("bin").join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if bin == "csharp-ls" {
        // dotnet global tools 고정 경로(~/.dotnet/tools) — PATH에 없을 수 있어 직접 확인.
        let exe = if cfg!(windows) { "csharp-ls.exe" } else { "csharp-ls" };
        if let Some(h) = home() {
            let p = PathBuf::from(h).join(".dotnet").join("tools").join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// PATH에서 임의 실행 파일의 절대경로(where.exe / command -v).
fn find_bin_on_path(name: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("where.exe")
            .arg(name)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("sh")
            .args(["-c", &format!("command -v {name}")])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
            .filter(|p| p.is_file())
    }
}

// ── 네이티브 서버 획득(clangd·rust-analyzer 등 — node 불필요, GitHub 릴리스 바이너리) ──
// 언어 추가는 native_spec에 항목 하나 추가로 끝난다(데이터 기반).
struct NativeSpec {
    name: &'static str,
    version: &'static str,
    url: String,
    sha256: Option<&'static str>,
    inner_dir: Option<String>, // 아카이브 내부 디렉토리(clangd). None이면 flat
    exe_rel: String,           // dest 기준 실행 파일 상대경로
    kind: ArchiveKind,
}

fn native_spec(name: &str) -> Option<NativeSpec> {
    match name {
        "clangd" => {
            let platform = if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "mac"
            } else {
                "linux"
            };
            let exe = if cfg!(windows) { "bin/clangd.exe" } else { "bin/clangd" };
            Some(NativeSpec {
                name: "clangd",
                version: CLANGD_VERSION,
                url: format!(
                    "https://github.com/clangd/clangd/releases/download/{CLANGD_VERSION}/clangd-{platform}-{CLANGD_VERSION}.zip"
                ),
                sha256: CLANGD_SHA256,
                inner_dir: Some(format!("clangd_{CLANGD_VERSION}")),
                exe_rel: exe.to_string(),
                kind: ArchiveKind::Zip,
            })
        }
        "rust-analyzer" => {
            // win=zip(flat), unix=gz(단일 바이너리). 자산 triple.
            #[cfg(all(windows, target_arch = "x86_64"))]
            let triple = "x86_64-pc-windows-msvc";
            #[cfg(all(windows, target_arch = "aarch64"))]
            let triple = "aarch64-pc-windows-msvc";
            #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
            let triple = "x86_64-apple-darwin";
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            let triple = "aarch64-apple-darwin";
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            let triple = "x86_64-unknown-linux-gnu";
            #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
            let triple = "aarch64-unknown-linux-gnu";
            let (ext, kind, exe) = if cfg!(windows) {
                ("zip", ArchiveKind::Zip, "rust-analyzer.exe")
            } else {
                ("gz", ArchiveKind::GzSingle, "rust-analyzer")
            };
            Some(NativeSpec {
                name: "rust-analyzer",
                version: RUST_ANALYZER_VERSION,
                url: format!(
                    "https://github.com/rust-lang/rust-analyzer/releases/download/{RUST_ANALYZER_VERSION}/rust-analyzer-{triple}.{ext}"
                ),
                sha256: RUST_ANALYZER_SHA256,
                inner_dir: None, // flat
                exe_rel: exe.to_string(),
                kind,
            })
        }
        "lua-language-server" => {
            // win=zip / mac·linux=tar.gz, 둘 다 flat(bin/…). arm64 win 자산 없음(x64/ia32만).
            #[cfg(all(windows, target_arch = "x86_64"))]
            let plat = "win32-x64";
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            let plat = "darwin-arm64";
            #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
            let plat = "darwin-x64";
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            let plat = "linux-x64";
            #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
            let plat = "linux-arm64";
            #[cfg(not(any(
                all(windows, target_arch = "x86_64"),
                all(target_os = "macos", target_arch = "aarch64"),
                all(target_os = "macos", target_arch = "x86_64"),
                all(target_os = "linux", target_arch = "x86_64"),
                all(target_os = "linux", target_arch = "aarch64"),
            )))]
            let plat = "win32-ia32"; // 폴백(미지원 플랫폼 — 다운로드는 실패할 수 있음)
            let (ext, kind, exe) = if cfg!(windows) {
                ("zip", ArchiveKind::Zip, "bin/lua-language-server.exe")
            } else {
                ("tar.gz", ArchiveKind::TarGz, "bin/lua-language-server")
            };
            Some(NativeSpec {
                name: "lua-language-server",
                version: LUA_LS_VERSION,
                url: format!(
                    "https://github.com/LuaLS/lua-language-server/releases/download/{LUA_LS_VERSION}/lua-language-server-{LUA_LS_VERSION}-{plat}.{ext}"
                ),
                sha256: LUA_LS_SHA256,
                inner_dir: None, // flat
                exe_rel: exe.to_string(),
                kind,
            })
        }
        "zls" => {
            // win=zip(flat, zls.exe), mac·linux=tar.xz(flat, zls). stdio 기본(무인자).
            #[cfg(target_arch = "x86_64")]
            let arch = "x86_64";
            #[cfg(target_arch = "aarch64")]
            let arch = "aarch64";
            #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
            let arch = "x86_64"; // 폴백
            let (os, ext, kind, exe) = if cfg!(windows) {
                ("windows", "zip", ArchiveKind::Zip, "zls.exe")
            } else if cfg!(target_os = "macos") {
                ("macos", "tar.xz", ArchiveKind::TarXz, "zls")
            } else {
                ("linux", "tar.xz", ArchiveKind::TarXz, "zls")
            };
            Some(NativeSpec {
                name: "zls",
                version: ZLS_VERSION,
                url: format!(
                    "https://github.com/zigtools/zls/releases/download/{ZLS_VERSION}/zls-{arch}-{os}.{ext}"
                ),
                sha256: ZLS_SHA256,
                inner_dir: None, // flat
                exe_rel: exe.to_string(),
                kind,
            })
        }
        _ => None,
    }
}

/// 관리 사본 네이티브 서버 실행 파일 경로(있을 때만 Some).
fn managed_native(lsp_root: &Path, name: &str) -> Option<PathBuf> {
    let spec = native_spec(name)?;
    let p = lsp_root
        .join(format!("{}-{}", spec.name, spec.version))
        .join(&spec.exe_rel);
    p.is_file().then_some(p)
}

// ── 획득 자동화(태스크 17 M2) — npm tarball 다운로드+sha512 검증+원자 설치 ──
// 버전·integrity pin은 scripts/fetch-lsp.mjs SERVERS와 동기 유지(둘 다 같은 버전을 박는다).
struct Pkg {
    version: &'static str,
    integrity: &'static str, // "sha512-<base64>"
    tarball: &'static str,
}

fn packages_for(lang: &str) -> Vec<(&'static str, Pkg)> {
    match lang {
        "py" => vec![(
            "basedpyright",
            Pkg {
                version: BASEDPYRIGHT_VERSION,
                integrity: "sha512-7ijtpTtV3E3r5Lvv8GV0HfOyRrtDdLOj+xA4q3vv1Mg03F8k/vIBXSVLOQ7X5oNI52kFqiMQehhr8RS0CSP59w==",
                tarball: "https://registry.npmjs.org/basedpyright/-/basedpyright-1.39.9.tgz",
            },
        )],
        "ts" => vec![
            (
                "typescript-language-server",
                Pkg {
                    version: TS_LANGSERVER_VERSION,
                    integrity: "sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
                    tarball: "https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz",
                },
            ),
            (
                "typescript",
                Pkg {
                    version: TYPESCRIPT_VERSION,
                    integrity: "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
                    tarball: "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
                },
            ),
        ],
        "php" => vec![(
            "intelephense",
            Pkg {
                version: INTELEPHENSE_VERSION,
                integrity: "sha512-dqCH1YNCRlHGBLND+iUFjBJlGwM4pPimX2jm8AaP/6K2WZNM2K2+E8dOWCD3ZYMP2zC2ICBD9Soe2oxKtU9d9A==",
                tarball: "https://registry.npmjs.org/intelephense/-/intelephense-1.18.5.tgz",
            },
        )],
        _ => vec![],
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureResult {
    pub ready: bool,        // 서버 전부 설치 + node 발견
    pub node_found: bool,   // node가 PATH에 있나(없으면 서버가 있어도 실행 불가)
    pub installed: Vec<String>,
    pub missing: Vec<String>, // 다운로드 실패한 패키지
}

/// lang에 필요한 서버 tarball을 보장 — 없으면 다운로드+검증+원자 설치. 진행률은 Channel로.
/// node는 PATH 요구(번들 다운로드는 후속). 설치 완료(.ok 마커)는 재실행 시 건너뛴다.
pub async fn ensure_installed(
    app: &AppHandle,
    lang: &str,
    on_progress: &Channel<String>,
) -> Result<EnsureResult, IpcError> {
    let lsp_root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("앱 데이터 경로 오류: {e}")))?
        .join("lsp");
    std::fs::create_dir_all(&lsp_root).ok();

    let client = reqwest::Client::builder()
        .user_agent("gitpervisor-lsp")
        .build()
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("HTTP 클라이언트 오류: {e}")))?;

    // 네이티브 서버(node 불필요) — cpp=clangd, rust=rust-analyzer. GitHub 바이너리 다운로드.
    if let Some(server) = native_server_for(lang) {
        let mut installed = Vec::new();
        let mut missing = Vec::new();
        match ensure_native(&client, &lsp_root, on_progress, server).await {
            Ok(()) => installed.push(server.to_string()),
            Err(e) => {
                missing.push(server.to_string());
                let msg = e.to_string().replace('"', "'");
                let _ = on_progress
                    .send(format!("{{\"name\":\"{server}\",\"phase\":\"error\",\"message\":\"{msg}\"}}"));
            }
        }
        return Ok(EnsureResult {
            ready: missing.is_empty(),
            node_found: true, // 네이티브 서버는 node 불필요
            installed,
            missing,
        });
    }

    // PATH 발견 서버(gopls) — 다운로드 없이 툴체인 설치본 확인만.
    if let Some((bin, _, _)) = path_server_for(lang) {
        let found = find_path_server(bin).is_some();
        return Ok(EnsureResult {
            ready: found,
            node_found: true,
            installed: if found { vec![bin.to_string()] } else { vec![] },
            missing: if found { vec![] } else { vec![bin.to_string()] },
        });
    }

    // node 보장 — PATH 우선, 없으면 관리 사본, 그것도 없으면 다운로드(35MB, best-effort).
    let node_found = match ensure_node(app, &client, &lsp_root, on_progress).await {
        Ok(_) => true,
        Err(e) => {
            let msg = e.to_string().replace('"', "'");
            let _ = on_progress
                .send(format!("{{\"name\":\"node\",\"phase\":\"error\",\"message\":\"{msg}\"}}"));
            false
        }
    };

    let mut installed = Vec::new();
    let mut missing = Vec::new();
    for (name, pkg) in packages_for(lang) {
        let dest = lsp_root.join(format!("{name}-{}", pkg.version));
        if dest.join(".ok").is_file() {
            installed.push(name.to_string());
            continue;
        }
        let _ = on_progress.send(format!("{{\"name\":\"{name}\",\"phase\":\"download\"}}"));
        match download_and_install(&client, name, &pkg, &lsp_root).await {
            Ok(()) => {
                installed.push(name.to_string());
                let _ = on_progress.send(format!("{{\"name\":\"{name}\",\"phase\":\"done\"}}"));
            }
            Err(e) => {
                missing.push(name.to_string());
                let msg = e.to_string().replace('"', "'");
                let _ = on_progress
                    .send(format!("{{\"name\":\"{name}\",\"phase\":\"error\",\"message\":\"{msg}\"}}"));
            }
        }
    }

    Ok(EnsureResult {
        ready: missing.is_empty() && node_found,
        node_found,
        installed,
        missing,
    })
}

async fn download_and_install(
    client: &reqwest::Client,
    name: &str,
    pkg: &Pkg,
    lsp_root: &Path,
) -> Result<(), IpcError> {
    let io = |e: String| IpcError::new(ErrorCode::Io, e);
    let bytes = client
        .get(pkg.tarball)
        .send()
        .await
        .map_err(|e| io(format!("다운로드 실패: {e}")))?
        .error_for_status()
        .map_err(|e| io(format!("다운로드 상태 오류: {e}")))?
        .bytes()
        .await
        .map_err(|e| io(format!("본문 수신 실패: {e}")))?;

    // 무결성 — pin된 sha512(base64)와 대조. 불일치는 폐기(공급망 방어).
    let mut hasher = Sha512::new();
    hasher.update(&bytes);
    let actual = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
    let expected = pkg.integrity.strip_prefix("sha512-").unwrap_or("");
    if actual != expected {
        return Err(io(format!("{name} 무결성 검증 실패 — 다운로드 변조 의심")));
    }

    // temp에 tgz 해제 후 rename(원자 설치 — 해제 중 크래시가 손상본을 설치됨으로 오판 안 하게).
    let temp = lsp_root.join(format!(".tmp-{name}-{}", pkg.version));
    std::fs::remove_dir_all(&temp).ok();
    std::fs::create_dir_all(&temp).map_err(|e| io(format!("temp 생성 실패: {e}")))?;
    // npm tgz = gzip(tar). flate2로 gunzip → tar 해제. 최상위 package/ 로 풀린다.
    let mut buf = Vec::new();
    flate2::read::GzDecoder::new(&bytes[..])
        .read_to_end(&mut buf)
        .map_err(|e| io(format!("gunzip 실패: {e}")))?;
    tar::Archive::new(&buf[..])
        .unpack(&temp)
        .map_err(|e| io(format!("tar 해제 실패: {e}")))?;

    let dest = lsp_root.join(format!("{name}-{}", pkg.version));
    std::fs::remove_dir_all(&dest).ok();
    std::fs::rename(temp.join("package"), &dest)
        .map_err(|e| io(format!("설치 이동 실패: {e}")))?;
    std::fs::remove_dir_all(&temp).ok();
    std::fs::write(dest.join(".ok"), pkg.version).map_err(|e| io(format!("마커 쓰기 실패: {e}")))?;
    Ok(())
}

/// 플랫폼별 node 배포 자산 — (다운로드 파일명, 아카이브 내부 디렉토리명, 설치 후 node 실행 상대경로).
fn node_asset() -> (String, String, &'static str) {
    let v = NODE_VERSION;
    #[cfg(all(windows, target_arch = "x86_64"))]
    let triple = "win-x64";
    #[cfg(all(windows, target_arch = "aarch64"))]
    let triple = "win-arm64";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let triple = "darwin-arm64";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let triple = "darwin-x64";
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let triple = "linux-x64";
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    let triple = "linux-arm64";
    let ext = if cfg!(windows) { "zip" } else { "tar.gz" };
    let file = format!("node-v{v}-{triple}.{ext}");
    let inner = format!("node-v{v}-{triple}");
    let exe_rel = if cfg!(windows) { "node.exe" } else { "bin/node" };
    (file, inner, exe_rel)
}

/// 관리 사본 node 실행 파일 경로(있을 때만 Some).
fn managed_node(lsp_root: &Path) -> Option<PathBuf> {
    let (_, _, exe_rel) = node_asset();
    let p = lsp_root.join(format!("node-{NODE_VERSION}")).join(exe_rel);
    p.is_file().then_some(p)
}

/// node 발견 — PATH → 관리 사본. resolve/lsp_start가 서버 스폰에 쓴다.
pub fn resolve_node(app: &AppHandle) -> Option<PathBuf> {
    if let Some(p) = find_node() {
        return Some(p);
    }
    let lsp_root = app.path().app_local_data_dir().ok()?.join("lsp");
    managed_node(&lsp_root)
}

/// node를 보장 — PATH·관리 사본 있으면 그대로, 없으면 다운로드(SHASUMS256 검증 + 원자 설치).
async fn ensure_node(
    app: &AppHandle,
    client: &reqwest::Client,
    lsp_root: &Path,
    on_progress: &Channel<String>,
) -> Result<PathBuf, IpcError> {
    if let Some(p) = find_node() {
        return Ok(p); // PATH node — 다운로드 안 함
    }
    if let Some(p) = managed_node(lsp_root) {
        return Ok(p);
    }
    let io = |e: String| IpcError::new(ErrorCode::Io, e);
    let (file, inner, exe_rel) = node_asset();
    let base = format!("https://nodejs.org/dist/v{NODE_VERSION}");
    let _ = app; // (app는 호출 일관성용 — lsp_root로 충분)

    let _ = on_progress.send("{\"name\":\"node\",\"phase\":\"download\"}".to_string());
    let bytes = client
        .get(format!("{base}/{file}"))
        .send()
        .await
        .map_err(|e| io(format!("node 다운로드 실패: {e}")))?
        .error_for_status()
        .map_err(|e| io(format!("node 상태 오류: {e}")))?
        .bytes()
        .await
        .map_err(|e| io(format!("node 본문 수신 실패: {e}")))?;

    // 무결성 — SHASUMS256.txt에서 파일의 sha256(hex)를 찾아 대조.
    let shasums = client
        .get(format!("{base}/SHASUMS256.txt"))
        .send()
        .await
        .map_err(|e| io(format!("SHASUMS 다운로드 실패: {e}")))?
        .text()
        .await
        .map_err(|e| io(format!("SHASUMS 수신 실패: {e}")))?;
    let expected = parse_shasums(&shasums, &file)
        .ok_or_else(|| io("SHASUMS에 node 파일 해시 없음".to_string()))?;
    if sha256_hex(&bytes) != expected {
        return Err(io("node 무결성 검증 실패 — 다운로드 변조 의심".to_string()));
    }

    // temp 해제 → inner 디렉토리를 node-<ver>로 rename(원자 설치).
    let temp = lsp_root.join(format!(".tmp-node-{NODE_VERSION}"));
    std::fs::remove_dir_all(&temp).ok();
    std::fs::create_dir_all(&temp).map_err(|e| io(format!("temp 생성 실패: {e}")))?;
    if cfg!(windows) {
        extract_zip(&bytes, &temp)?;
    } else {
        let mut buf = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .read_to_end(&mut buf)
            .map_err(|e| io(format!("gunzip 실패: {e}")))?;
        tar::Archive::new(&buf[..])
            .unpack(&temp)
            .map_err(|e| io(format!("tar 해제 실패: {e}")))?;
    }
    let dest = lsp_root.join(format!("node-{NODE_VERSION}"));
    std::fs::remove_dir_all(&dest).ok();
    std::fs::rename(temp.join(&inner), &dest).map_err(|e| io(format!("node 설치 이동 실패: {e}")))?;
    std::fs::remove_dir_all(&temp).ok();
    let _ = on_progress.send("{\"name\":\"node\",\"phase\":\"done\"}".to_string());
    Ok(dest.join(exe_rel))
}

/// 네이티브 서버를 보장 — 관리 사본 있으면 그대로, 없으면 GitHub 릴리스 다운로드+검증+원자 설치.
/// zip(clangd·rust-analyzer win) 또는 gz 단일 바이너리(rust-analyzer unix) 처리. sha256 pin 검증.
async fn ensure_native(
    client: &reqwest::Client,
    lsp_root: &Path,
    on_progress: &Channel<String>,
    name: &str,
) -> Result<(), IpcError> {
    if managed_native(lsp_root, name).is_some() {
        return Ok(());
    }
    let io = |e: String| IpcError::new(ErrorCode::Io, e);
    let spec = native_spec(name).ok_or_else(|| io(format!("알 수 없는 네이티브 서버: {name}")))?;

    let _ = on_progress.send(format!("{{\"name\":\"{name}\",\"phase\":\"download\"}}"));
    let bytes = client
        .get(&spec.url)
        .send()
        .await
        .map_err(|e| io(format!("{name} 다운로드 실패: {e}")))?
        .error_for_status()
        .map_err(|e| io(format!("{name} 상태 오류: {e}")))?
        .bytes()
        .await
        .map_err(|e| io(format!("{name} 본문 수신 실패: {e}")))?;

    if let Some(expected) = spec.sha256 {
        if sha256_hex(&bytes) != expected {
            return Err(io(format!("{name} 무결성 검증 실패 — 다운로드 변조 의심")));
        }
    }

    let dest = lsp_root.join(format!("{}-{}", spec.name, spec.version));
    let temp = lsp_root.join(format!(".tmp-{}-{}", spec.name, spec.version));
    std::fs::remove_dir_all(&temp).ok();
    std::fs::create_dir_all(&temp).map_err(|e| io(format!("temp 생성 실패: {e}")))?;
    std::fs::remove_dir_all(&dest).ok();

    match spec.kind {
        ArchiveKind::GzSingle => {
            // gz 단일 바이너리 → dest/exe_rel로 gunzip.
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(&bytes[..])
                .read_to_end(&mut out)
                .map_err(|e| io(format!("gunzip 실패: {e}")))?;
            std::fs::create_dir_all(&dest).map_err(|e| io(format!("dest 생성 실패: {e}")))?;
            std::fs::write(dest.join(&spec.exe_rel), &out)
                .map_err(|e| io(format!("바이너리 쓰기 실패: {e}")))?;
        }
        ArchiveKind::Zip | ArchiveKind::TarGz | ArchiveKind::TarXz => {
            match spec.kind {
                ArchiveKind::Zip => extract_zip(&bytes, &temp)?,
                ArchiveKind::TarGz => {
                    let mut buf = Vec::new();
                    flate2::read::GzDecoder::new(&bytes[..])
                        .read_to_end(&mut buf)
                        .map_err(|e| io(format!("gunzip 실패: {e}")))?;
                    tar::Archive::new(&buf[..])
                        .unpack(&temp)
                        .map_err(|e| io(format!("tar 해제 실패: {e}")))?;
                }
                _ => {
                    // TarXz(zls unix) — in-process xz 디코더가 없어 시스템 tar로 해제.
                    // 유닉스 tar는 .tar.xz를 투명 처리한다(Windows는 zls가 zip 자산이라 미도달).
                    let arc = lsp_root.join(format!(".tmp-{}-arc.tar.xz", spec.name));
                    std::fs::write(&arc, &bytes)
                        .map_err(|e| io(format!("아카이브 쓰기 실패: {e}")))?;
                    let ok = std::process::Command::new("tar")
                        .arg("-xf")
                        .arg(&arc)
                        .arg("-C")
                        .arg(&temp)
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
                    std::fs::remove_file(&arc).ok();
                    if !ok {
                        return Err(io(format!("{name} tar.xz 해제 실패 — 시스템 tar 필요")));
                    }
                }
            }
            // inner_dir 있으면 그 하위를, 없으면 temp 전체를 dest로.
            let src = match &spec.inner_dir {
                Some(inner) => temp.join(inner),
                None => temp.clone(),
            };
            std::fs::rename(&src, &dest).map_err(|e| io(format!("{name} 설치 이동 실패: {e}")))?;
        }
    }
    std::fs::remove_dir_all(&temp).ok();

    // unix는 실행 비트 보장.
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = dest.join(&spec.exe_rel);
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&bin, perm);
        }
    }
    std::fs::write(dest.join(".ok"), spec.version).map_err(|e| io(format!("마커 쓰기 실패: {e}")))?;
    let _ = on_progress.send(format!("{{\"name\":\"{name}\",\"phase\":\"done\"}}"));
    Ok(())
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), IpcError> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("zip 열기 실패: {e}")))?;
    archive
        .extract(dest)
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("zip 해제 실패: {e}")))?;
    Ok(())
}

/// SHASUMS256.txt("<hex sha256>  <filename>" 줄들)에서 파일명의 해시를 찾는다.
fn parse_shasums(text: &str, filename: &str) -> Option<String> {
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let hash = it.next()?;
        let name = it.next()?;
        // 파일명은 접두 `./` 가 붙기도 한다.
        if name == filename || name.trim_start_matches("./") == filename {
            return Some(hash.to_string());
        }
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Sha256;
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 프로젝트의 파이썬 인터프리터를 탐지해 절대경로로 반환(태스크 17 M2 venv 탐지).
/// basedpyright는 프로젝트 루트 `.venv`만 자동 인식하므로(연구 실측), venv/env/.env 등 나머지
/// 위치와 VIRTUAL_ENV·시스템 python을 우리가 찾아 `python.pythonPath`로 넘긴다. 서버가 바 이름
/// ("python"/"python3")은 폐기하므로 반드시 절대경로여야 한다(isPythonBinary 실측).
/// 탐지 순서: 프로젝트 venv(여러 위치) → VIRTUAL_ENV → 시스템 python. 없으면 None(서버 자동 폴백).
pub fn detect_python(repo: &Path) -> Option<String> {
    let venv_rels: &[&str] = if cfg!(windows) {
        &[
            ".venv/Scripts/python.exe",
            "venv/Scripts/python.exe",
            "env/Scripts/python.exe",
            ".env/Scripts/python.exe",
        ]
    } else {
        &[
            ".venv/bin/python",
            "venv/bin/python",
            "env/bin/python",
            ".env/bin/python",
        ]
    };
    for rel in venv_rels {
        let p = repo.join(rel);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    // 활성 VIRTUAL_ENV(터미널에서 앱을 띄운 경우 등)
    if let Ok(ve) = std::env::var("VIRTUAL_ENV") {
        let sub = if cfg!(windows) {
            "Scripts/python.exe"
        } else {
            "bin/python"
        };
        let p = PathBuf::from(ve).join(sub);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    find_python_on_path()
}

/// PATH에서 python 실행 파일의 절대경로를 찾는다(where.exe / command -v).
fn find_python_on_path() -> Option<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        for name in ["python.exe", "python3.exe"] {
            let out = std::process::Command::new("where.exe")
                .arg(name)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok();
            if let Some(out) = out {
                if out.status.success() {
                    for line in String::from_utf8_lossy(&out.stdout).lines() {
                        let t = line.trim();
                        // WindowsApps 스텁(python3.exe)은 실행 시 스토어를 여는 가짜 — 제외.
                        if !t.is_empty() && !t.contains("WindowsApps") {
                            return Some(t.to_string());
                        }
                    }
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        for name in ["python3", "python"] {
            let out = std::process::Command::new("sh")
                .args(["-c", &format!("command -v {name}")])
                .output()
                .ok();
            if let Some(out) = out {
                if out.status.success() {
                    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
        }
        None
    }
}

/// PATH에서 node 실행 파일을 찾는다(where.exe / command -v — git/runner.rs find_git 미러).
fn find_node() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("where.exe")
            .arg("node.exe")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let p = PathBuf::from(line.trim());
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("sh")
            .args(["-c", "command -v node"])
            .output()
            .ok()?;
        if out.status.success() {
            let p = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
            if p.is_file() {
                return Some(p);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shasums_parse_finds_hash() {
        let txt = "\
aaa111  node-v24.18.0-linux-x64.tar.gz
bbb222  node-v24.18.0-win-x64.zip
ccc333  node-v24.18.0-darwin-arm64.tar.gz";
        assert_eq!(parse_shasums(txt, "node-v24.18.0-win-x64.zip").as_deref(), Some("bbb222"));
        assert_eq!(parse_shasums(txt, "node-v24.18.0-linux-x64.tar.gz").as_deref(), Some("aaa111"));
        assert_eq!(parse_shasums(txt, "no-such-file.zip"), None);
    }

    #[test]
    fn shasums_parse_handles_dot_slash_prefix() {
        let txt = "deadbeef  ./node-v24.18.0-win-x64.zip";
        assert_eq!(parse_shasums(txt, "node-v24.18.0-win-x64.zip").as_deref(), Some("deadbeef"));
    }

    #[test]
    fn sha256_hex_known_vector() {
        // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
