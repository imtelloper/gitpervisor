//! LSP 획득·HTML 프리뷰·HLS·열기·포매터·도구 실행·격리 해제·검색 문구 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.

use super::{lang, Lang};
use std::fmt::Display;

// ── lsp/acquire.rs — 언어 서버 발견 ─────────────────────────────────────────

pub fn lsp_app_data_path_error(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("앱 데이터 경로 오류: {err}"),
        Lang::En => format!("Failed to resolve app data path: {err}"),
    }
}

pub fn lsp_server_not_installed() -> &'static str {
    match lang() {
        Lang::Ko => "언어 서버가 설치되지 않았습니다 — 설정에서 언어 서버 다운로드 후 다시 시도하세요",
        Lang::En => "Language server not installed — download it in Settings and try again",
    }
}

pub fn lsp_node_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "node를 찾지 못했습니다 — 설정에서 언어 서버 다운로드 또는 Node.js 설치",
        Lang::En => "node not found — download the language server in Settings or install Node.js",
    }
}

pub fn lsp_path_server_not_found(bin: &str, hint: &str) -> String {
    match lang() {
        Lang::Ko => format!("{bin}을(를) 찾지 못했습니다 — 설치: {hint}"),
        Lang::En => format!("{bin} not found — install: {hint}"),
    }
}

pub fn lsp_unsupported_language(lang_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("지원하지 않는 LSP 언어: {lang_id}"),
        Lang::En => format!("Unsupported LSP language: {lang_id}"),
    }
}

pub fn lsp_jdtls_install_hint() -> &'static str {
    match lang() {
        Lang::Ko => "brew install jdtls (또는 mason/패키지 매니저)",
        Lang::En => "brew install jdtls (or mason/a package manager)",
    }
}

// ── lsp/acquire.rs — 다운로드·설치(진행 채널의 message로 설정 화면에 보인다) ─

pub fn lsp_http_client_error(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("HTTP 클라이언트 오류: {err}"),
        Lang::En => format!("HTTP client error: {err}"),
    }
}

pub fn lsp_download_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("다운로드 실패: {err}"),
        Lang::En => format!("Download failed: {err}"),
    }
}

pub fn lsp_download_status_error(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("다운로드 상태 오류: {err}"),
        Lang::En => format!("Download status error: {err}"),
    }
}

pub fn lsp_download_body_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("본문 수신 실패: {err}"),
        Lang::En => format!("Failed to receive download body: {err}"),
    }
}

pub fn lsp_named_download_failed(name: &str, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{name} 다운로드 실패: {err}"),
        Lang::En => format!("Failed to download {name}: {err}"),
    }
}

pub fn lsp_named_download_status_error(name: &str, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{name} 상태 오류: {err}"),
        Lang::En => format!("{name} download status error: {err}"),
    }
}

pub fn lsp_named_download_body_failed(name: &str, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{name} 본문 수신 실패: {err}"),
        Lang::En => format!("Failed to receive {name} download body: {err}"),
    }
}

pub fn lsp_integrity_check_failed(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} 무결성 검증 실패 — 다운로드 변조 의심"),
        Lang::En => format!("{name} integrity check failed — the download may have been tampered with"),
    }
}

pub fn lsp_shasums_download_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("SHASUMS 다운로드 실패: {err}"),
        Lang::En => format!("Failed to download SHASUMS: {err}"),
    }
}

pub fn lsp_shasums_receive_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("SHASUMS 수신 실패: {err}"),
        Lang::En => format!("Failed to receive SHASUMS: {err}"),
    }
}

pub fn lsp_shasums_missing_node_hash() -> &'static str {
    match lang() {
        Lang::Ko => "SHASUMS에 node 파일 해시 없음",
        Lang::En => "No hash for the node file in SHASUMS",
    }
}

pub fn lsp_unknown_native_server(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("알 수 없는 네이티브 서버: {name}"),
        Lang::En => format!("Unknown native server: {name}"),
    }
}

pub fn lsp_temp_dir_create_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("temp 생성 실패: {err}"),
        Lang::En => format!("Failed to create temp folder: {err}"),
    }
}

pub fn lsp_dest_dir_create_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("dest 생성 실패: {err}"),
        Lang::En => format!("Failed to create install folder: {err}"),
    }
}

pub fn lsp_gunzip_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("gunzip 실패: {err}"),
        Lang::En => format!("Failed to decompress gzip: {err}"),
    }
}

pub fn lsp_tar_extract_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("tar 해제 실패: {err}"),
        Lang::En => format!("Failed to extract tar: {err}"),
    }
}

pub fn lsp_tar_xz_extract_failed(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name} tar.xz 해제 실패 — 시스템 tar 필요"),
        Lang::En => format!("Failed to extract {name} tar.xz — system tar required"),
    }
}

pub fn lsp_zip_open_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("zip 열기 실패: {err}"),
        Lang::En => format!("Failed to open zip: {err}"),
    }
}

pub fn lsp_zip_extract_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("zip 해제 실패: {err}"),
        Lang::En => format!("Failed to extract zip: {err}"),
    }
}

pub fn lsp_archive_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("아카이브 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write archive: {err}"),
    }
}

pub fn lsp_binary_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("바이너리 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write binary: {err}"),
    }
}

pub fn lsp_install_move_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("설치 이동 실패: {err}"),
        Lang::En => format!("Failed to move install into place: {err}"),
    }
}

pub fn lsp_named_install_move_failed(name: &str, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{name} 설치 이동 실패: {err}"),
        Lang::En => format!("Failed to move {name} install into place: {err}"),
    }
}

pub fn lsp_marker_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("마커 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write install marker: {err}"),
    }
}

// ── commands/lsp.rs — 언어 서버 세션 ─────────────────────────────────────────

pub fn lsp_start_task_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("언어 서버 시작 작업 실패: {err}"),
        Lang::En => format!("Language server start task failed: {err}"),
    }
}

pub fn lsp_spawn_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("언어 서버 실행 실패: {err}"),
        Lang::En => format!("Failed to start language server: {err}"),
    }
}

pub fn lsp_stdin_attach_failed() -> &'static str {
    match lang() {
        Lang::Ko => "stdin 연결 실패",
        Lang::En => "Failed to attach stdin",
    }
}

pub fn lsp_stdout_attach_failed() -> &'static str {
    match lang() {
        Lang::Ko => "stdout 연결 실패",
        Lang::En => "Failed to attach stdout",
    }
}

pub fn lsp_project_closed_during_start(project_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("언어 서버를 띄우는 사이 프로젝트가 닫혔습니다: {project_id}"),
        Lang::En => format!("Project was closed while the language server was starting: {project_id}"),
    }
}

pub fn lsp_stdin_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("lsp stdin 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write to language server stdin: {err}"),
    }
}

// ── commands/preview.rs — HTML 프리뷰 루프백 서버 (hls.rs도 같은 서버를 쓴다) ──

pub fn preview_file_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "파일을 찾을 수 없습니다",
        Lang::En => "File not found",
    }
}

pub fn preview_repo_path_check_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("레포 경로 확인 실패: {err}"),
        Lang::En => format!("Failed to resolve repository path: {err}"),
    }
}

pub fn preview_path_outside_repo() -> &'static str {
    match lang() {
        Lang::Ko => "레포 밖 경로입니다",
        Lang::En => "Path is outside the repository",
    }
}

pub fn preview_parent_folder_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "상위 폴더를 찾을 수 없습니다",
        Lang::En => "Parent folder not found",
    }
}

pub fn preview_file_name_unreadable() -> &'static str {
    match lang() {
        Lang::Ko => "파일 이름을 읽을 수 없습니다",
        Lang::En => "Cannot read file name",
    }
}

pub fn preview_server_start_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("프리뷰 서버 시작 실패: {err}"),
        Lang::En => format!("Failed to start preview server: {err}"),
    }
}

pub fn preview_port_check_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("포트 확인 실패: {err}"),
        Lang::En => format!("Failed to get preview server port: {err}"),
    }
}

pub fn preview_nonblocking_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("논블로킹 설정 실패: {err}"),
        Lang::En => format!("Failed to set non-blocking mode: {err}"),
    }
}

pub fn preview_thread_spawn_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("프리뷰 스레드 생성 실패: {err}"),
        Lang::En => format!("Failed to start preview thread: {err}"),
    }
}

// ── commands/hls.rs — 재생 불가 코덱 HLS 폴백 ───────────────────────────────

pub fn hls_file_metadata_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 정보를 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to read file info: {err}"),
    }
}

pub fn hls_ffprobe_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "ffprobe를 찾을 수 없습니다 — ffmpeg와 같은 폴더에 있어야 합니다",
        Lang::En => "ffprobe not found — it must be in the same folder as ffmpeg",
    }
}

pub fn hls_no_video_stream() -> &'static str {
    match lang() {
        Lang::Ko => "동영상 스트림을 찾지 못했습니다 — 변환할 수 없는 파일입니다",
        Lang::En => "No video stream found — this file cannot be converted",
    }
}

pub fn hls_cache_dir_create_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("캐시 폴더 생성 실패: {err}"),
        Lang::En => format!("Failed to create cache folder: {err}"),
    }
}

// ── commands/open.rs — 탐색기·터미널·실행 ───────────────────────────────────

pub fn open_in_project_path_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "프로젝트 경로를 찾을 수 없습니다",
        Lang::En => "Project path not found",
    }
}

pub fn reveal_path_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "경로를 찾을 수 없습니다",
        Lang::En => "Path not found",
    }
}

pub fn open_explorer_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("탐색기 열기 실패: {err}"),
        Lang::En => format!("Failed to open file manager: {err}"),
    }
}

pub fn open_terminal_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("터미널 열기 실패: {err}"),
        Lang::En => format!("Failed to open terminal: {err}"),
    }
}

// Windows의 run_file은 ShellExecuteW라 이 문구를 쓰지 않는다.
#[cfg_attr(windows, allow(dead_code))]
pub fn run_file_launch_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("실행 열기 실패: {err}"),
        Lang::En => format!("Failed to run file: {err}"),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn run_file_shell_execute_failed(code: isize) -> String {
    match lang() {
        Lang::Ko => format!("실행 실패 (코드 {code})"),
        Lang::En => format!("Failed to run file (code {code})"),
    }
}

pub fn run_executable_symlink_rejected() -> &'static str {
    match lang() {
        Lang::Ko => "심볼릭 링크는 실행할 수 없습니다",
        Lang::En => "Cannot run a symbolic link",
    }
}

pub fn run_executable_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "실행 파일을 찾을 수 없습니다",
        Lang::En => "Executable not found",
    }
}

// ── commands/format.rs · tools/runner.rs — 포매터·외부 도구 ─────────────────

pub fn format_file_too_large() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 너무 커서 포맷할 수 없습니다",
        Lang::En => "File is too large to format",
    }
}

pub fn formatter_not_installed(name: &str) -> String {
    match lang() {
        Lang::Ko => format!("{name}이(가) 설치되어 있지 않습니다 — 설정에서 경로를 지정하거나 설치하세요"),
        Lang::En => format!("{name} is not installed — set its path in Settings or install it"),
    }
}

pub fn format_failed() -> &'static str {
    match lang() {
        Lang::Ko => "포맷 실패",
        Lang::En => "Formatting failed",
    }
}

pub fn tool_spawn_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("도구 실행 실패: {err}"),
        Lang::En => format!("Failed to run tool: {err}"),
    }
}

pub fn tool_stdin_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("stdin 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write to tool stdin: {err}"),
    }
}

pub fn tool_timed_out() -> &'static str {
    match lang() {
        Lang::Ko => "도구 실행 시간 초과",
        Lang::En => "Tool timed out",
    }
}

pub fn tool_output_collect_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("도구 출력 수집 실패: {err}"),
        Lang::En => format!("Failed to collect tool output: {err}"),
    }
}

// ── commands/quarantine.rs — macOS 격리 해제 ────────────────────────────────

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn quarantine_xattr_spawn_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("xattr 실행 실패: {err}"),
        Lang::En => format!("Failed to run xattr: {err}"),
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn quarantine_clear_failed(path: &str, stderr: &str) -> String {
    match lang() {
        Lang::Ko => format!("격리 해제 실패 ({path}): {stderr}"),
        Lang::En => format!("Failed to clear quarantine ({path}): {stderr}"),
    }
}

// ── commands/search.rs — 전체 검색 ──────────────────────────────────────────

pub fn search_failed() -> &'static str {
    match lang() {
        Lang::Ko => "검색 실패",
        Lang::En => "Search failed",
    }
}
