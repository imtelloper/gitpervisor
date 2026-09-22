//! git 실행·동기화·상태·HTTP 클라이언트·브라우저·OCR·터미널·설정 저장·워처 문구 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.
//! 호출처가 `#[cfg]`로 갇힌 문구는 같은 `#[cfg]`를 단다 — 다른 OS 빌드에서 dead_code 경고가 나지 않게.

use std::fmt::Display;

use super::{lang, Lang};

// ───────────────────────── 공용 ─────────────────────────

pub fn project_path_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "프로젝트 경로를 찾을 수 없습니다",
        Lang::En => "Project path not found",
    }
}

pub fn invalid_url(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("잘못된 URL: {err}"),
        Lang::En => format!("Invalid URL: {err}"),
    }
}

// ───────────────────────── HTTP 클라이언트(commands/http.rs) ─────────────────────────

pub fn http_unsupported_scheme(scheme: &str) -> String {
    match lang() {
        Lang::Ko => format!("지원하지 않는 스킴입니다: {scheme} (http/https만 허용)"),
        Lang::En => format!("Unsupported scheme: {scheme} (only http/https allowed)"),
    }
}

pub fn http_invalid_method(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("잘못된 메서드: {err}"),
        Lang::En => format!("Invalid method: {err}"),
    }
}

pub fn http_registry_lock_failed() -> &'static str {
    match lang() {
        Lang::Ko => "내부 레지스트리 잠금 실패",
        Lang::En => "Failed to lock internal registry",
    }
}

pub fn http_request_timed_out() -> &'static str {
    match lang() {
        Lang::Ko => "요청이 시간 초과되었습니다",
        Lang::En => "Request timed out",
    }
}

pub fn http_request_cancelled() -> &'static str {
    match lang() {
        Lang::Ko => "요청이 취소되었습니다",
        Lang::En => "Request cancelled",
    }
}

pub fn http_client_build_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("HTTP 클라이언트 생성 실패: {err}"),
        Lang::En => format!("Failed to create HTTP client: {err}"),
    }
}

pub fn http_form_encode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("폼 인코딩 실패: {err}"),
        Lang::En => format!("Failed to encode form: {err}"),
    }
}

pub fn http_mime_parse_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("MIME 파싱 실패: {err}"),
        Lang::En => format!("Failed to parse MIME type: {err}"),
    }
}

pub fn http_base64_decode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("base64 디코드 실패: {err}"),
        Lang::En => format!("Failed to decode base64: {err}"),
    }
}

pub fn http_upload_open_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 열기 실패: {err}"),
        Lang::En => format!("Failed to open file: {err}"),
    }
}

pub fn http_upload_too_large(size: u64, max: u64) -> String {
    match lang() {
        Lang::Ko => format!("업로드 파일이 너무 큽니다 ({size} bytes, 상한 {max} bytes)"),
        Lang::En => format!("Upload file too large ({size} bytes, limit {max} bytes)"),
    }
}

pub fn http_upload_read_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 읽기 실패: {err}"),
        Lang::En => format!("Failed to read file: {err}"),
    }
}

pub fn http_tls_verify_failed() -> &'static str {
    match lang() {
        Lang::Ko => "TLS 인증서 검증 실패 — 검증 토글 또는 인증서 확인",
        Lang::En => "TLS certificate verification failed — check the verify toggle or the certificate",
    }
}

pub fn http_host_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "호스트를 찾을 수 없습니다",
        Lang::En => "Host not found",
    }
}

pub fn http_connection_refused() -> &'static str {
    match lang() {
        Lang::Ko => "연결이 거부되었습니다 — 서버/포트 확인",
        Lang::En => "Connection refused — check the server/port",
    }
}

pub fn http_response_body_failed() -> &'static str {
    match lang() {
        Lang::Ko => "응답 본문 처리 실패",
        Lang::En => "Failed to process response body",
    }
}

pub fn http_network_error() -> &'static str {
    match lang() {
        Lang::Ko => "네트워크 오류",
        Lang::En => "Network error",
    }
}

// ───────────────────────── 인앱 브라우저(commands/browser.rs) ─────────────────────────

pub fn browser_error(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("브라우저 오류: {err}"),
        Lang::En => format!("Browser error: {err}"),
    }
}

pub fn browser_app_data_dir_not_found(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("앱 데이터 폴더를 찾을 수 없습니다: {err}"),
        Lang::En => format!("App data folder not found: {err}"),
    }
}

pub fn external_link_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 링크입니다",
        Lang::En => "Invalid link",
    }
}

pub fn external_link_not_allowed() -> &'static str {
    match lang() {
        Lang::Ko => "허용되지 않는 링크입니다",
        Lang::En => "Link not allowed",
    }
}

pub fn browser_main_window_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "메인 창을 찾을 수 없습니다",
        Lang::En => "Main window not found",
    }
}

pub fn browser_profile_clear_schedule_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("지연 삭제 예약 실패: {err}"),
        Lang::En => format!("Failed to schedule deferred deletion: {err}"),
    }
}

// ───────────────────────── 글자 추출(commands/ocr.rs) ─────────────────────────

pub fn ocr_upscaled_warning() -> &'static str {
    match lang() {
        Lang::Ko => "글자가 작아 2배 확대해 다시 읽음",
        Lang::En => "Text was small; re-read at 2× scale",
    }
}

pub fn ocr_job_interrupted(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("글자 추출 작업이 중단됐습니다: {err}"),
        Lang::En => format!("Text extraction was interrupted: {err}"),
    }
}

pub fn ocr_unsupported_format() -> &'static str {
    match lang() {
        Lang::Ko => "OCR이 지원하지 않는 형식입니다 (png·jpeg·gif·webp·bmp)",
        Lang::En => "Format not supported by OCR (png·jpeg·gif·webp·bmp)",
    }
}

pub fn ocr_image_decode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이미지 디코드 실패: {err}"),
        Lang::En => format!("Failed to decode image: {err}"),
    }
}

pub fn ocr_image_format_detect_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이미지 형식 판별 실패: {err}"),
        Lang::En => format!("Failed to detect image format: {err}"),
    }
}

pub fn ocr_image_too_large(w: u32, h: u32, max_megapixels: u64) -> String {
    match lang() {
        Lang::Ko => format!("이미지가 너무 큽니다 — {w}×{h}px (OCR 상한 {max_megapixels}MP)"),
        Lang::En => format!("Image too large — {w}×{h}px (OCR limit {max_megapixels}MP)"),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn ocr_png_encode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("PNG 인코딩 실패: {err}"),
        Lang::En => format!("Failed to encode PNG: {err}"),
    }
}

#[cfg(windows)]
pub fn ocr_windows_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("Windows OCR 실패: {err}"),
        Lang::En => format!("Windows OCR failed: {err}"),
    }
}

#[cfg(windows)]
pub fn ocr_windows_korean_pack_missing() -> &'static str {
    match lang() {
        Lang::Ko => "한국어 OCR 팩이 없습니다 — 설정 › 시간 및 언어 › 언어 및 지역 › 언어 추가 › 한국어를 \
             설치하세요 (케이퍼빌리티 Language.OCR~~~ko-KR~0.0.1.0)",
        Lang::En => "Korean OCR pack not installed — install Korean under Settings › Time & language › \
             Language & region › Add a language (capability Language.OCR~~~ko-KR~0.0.1.0)",
    }
}

#[cfg(windows)]
pub fn ocr_engine_downscaled(percent: i32) -> String {
    match lang() {
        Lang::Ko => format!("엔진 한계로 {percent}% 축소함"),
        Lang::En => format!("Downscaled by {percent}% due to engine limit"),
    }
}

#[cfg(target_os = "macos")]
pub fn ocr_macos_13_required() -> &'static str {
    match lang() {
        Lang::Ko => "한국어 인식은 macOS 13 이상이 필요합니다",
        Lang::En => "Korean recognition requires macOS 13 or later",
    }
}

#[cfg(target_os = "macos")]
pub fn ocr_vision_languages_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("Vision 언어 목록 조회 실패: {err}"),
        Lang::En => format!("Failed to query Vision languages: {err}"),
    }
}

#[cfg(target_os = "macos")]
pub fn ocr_vision_korean_missing(supported: &str) -> String {
    match lang() {
        Lang::Ko => format!("이 macOS의 Vision에 한국어가 없습니다 (지원: {supported})"),
        Lang::En => format!("Vision on this macOS does not support Korean (supported: {supported})"),
    }
}

#[cfg(target_os = "macos")]
pub fn ocr_vision_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("Vision 인식 실패: {err}"),
        Lang::En => format!("Vision recognition failed: {err}"),
    }
}

#[cfg(target_os = "linux")]
pub fn ocr_tesseract_missing() -> &'static str {
    match lang() {
        Lang::Ko => "tesseract가 없습니다 — Debian/Ubuntu: sudo apt install tesseract-ocr tesseract-ocr-kor · \
             Fedora: sudo dnf install tesseract tesseract-langpack-kor · \
             Arch: sudo pacman -S tesseract tesseract-data-kor",
        Lang::En => "tesseract not found — Debian/Ubuntu: sudo apt install tesseract-ocr tesseract-ocr-kor · \
             Fedora: sudo dnf install tesseract tesseract-langpack-kor · \
             Arch: sudo pacman -S tesseract tesseract-data-kor",
    }
}

#[cfg(target_os = "linux")]
pub fn ocr_tesseract_korean_data_missing() -> &'static str {
    match lang() {
        Lang::Ko => "tesseract 한국어 데이터(kor)가 없습니다 — Debian/Ubuntu: sudo apt install \
                 tesseract-ocr-kor · Fedora: sudo dnf install tesseract-langpack-kor · \
                 Arch: sudo pacman -S tesseract-data-kor",
        Lang::En => "tesseract Korean data (kor) not found — Debian/Ubuntu: sudo apt install \
                 tesseract-ocr-kor · Fedora: sudo dnf install tesseract-langpack-kor · \
                 Arch: sudo pacman -S tesseract-data-kor",
    }
}

#[cfg(target_os = "linux")]
pub fn ocr_tesseract_failed(code: i32, stderr: &str) -> String {
    match lang() {
        Lang::Ko => format!("tesseract 실패 (종료 코드 {code}): {stderr}"),
        Lang::En => format!("tesseract failed (exit code {code}): {stderr}"),
    }
}

#[cfg(target_os = "linux")]
pub fn ocr_tesseract_output_not_utf8() -> &'static str {
    match lang() {
        Lang::Ko => "tesseract 출력이 UTF-8이 아닙니다",
        Lang::En => "tesseract output is not UTF-8",
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn ocr_no_builtin_engine() -> &'static str {
    match lang() {
        Lang::Ko => "이 운영체제에는 쓸 수 있는 내장 OCR 엔진이 없습니다",
        Lang::En => "No built-in OCR engine is available on this OS",
    }
}

pub fn ocr_file_stat_failed(rel_path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{rel_path} 정보 읽기 실패: {err}"),
        Lang::En => format!("Failed to read file info for {rel_path}: {err}"),
    }
}

pub fn ocr_file_too_large() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 너무 큽니다 (25MB 초과)",
        Lang::En => "File too large (over 25MB)",
    }
}

pub fn ocr_file_read_failed(rel_path: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{rel_path} 읽기 실패: {err}"),
        Lang::En => format!("Failed to read {rel_path}: {err}"),
    }
}

// ───────────────────────── 터미널(commands/terminal.rs · terminal/shell.rs) ─────────────────────────

pub fn pty_reader_create_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("PTY 리더 생성 실패: {err}"),
        Lang::En => format!("Failed to create PTY reader: {err}"),
    }
}

pub fn pty_writer_create_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("PTY 라이터 생성 실패: {err}"),
        Lang::En => format!("Failed to create PTY writer: {err}"),
    }
}

pub fn terminal_session_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "터미널 세션을 찾을 수 없습니다",
        Lang::En => "Terminal session not found",
    }
}

pub fn terminal_write_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("터미널 입력 실패: {err}"),
        Lang::En => format!("Failed to write to terminal: {err}"),
    }
}

pub fn terminal_resize_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("터미널 리사이즈 실패: {err}"),
        Lang::En => format!("Failed to resize terminal: {err}"),
    }
}

pub fn clipboard_read_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("클립보드를 읽지 못했습니다 ({err})"),
        Lang::En => format!("Failed to read clipboard ({err})"),
    }
}

#[cfg(not(windows))]
pub fn clipboard_owner_not_responding() -> &'static str {
    match lang() {
        Lang::Ko => "클립보드 소유자가 응답하지 않습니다",
        Lang::En => "Clipboard owner is not responding",
    }
}

#[cfg(not(windows))]
pub fn clipboard_open_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("클립보드를 열지 못했습니다 ({err})"),
        Lang::En => format!("Failed to open clipboard ({err})"),
    }
}

pub fn shell_launch_failed(detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("셸 실행 실패: {detail}"),
        Lang::En => format!("Failed to launch shell: {detail}"),
    }
}

/// 셸 후보 제외 사유(조각) — `"<프로그램>: <사유>"`로 이어 붙으므로 영어도 소문자로 시작한다.
pub fn shell_reason_file_missing() -> &'static str {
    match lang() {
        Lang::Ko => "파일 없음",
        Lang::En => "file not found",
    }
}

pub fn shell_reason_recent_failure(why: &str) -> String {
    match lang() {
        Lang::Ko => format!("{why} (최근 실패)"),
        Lang::En => format!("{why} (failed recently)"),
    }
}

pub fn shell_reason_alias_package_not_installed(pfn: &str) -> String {
    match lang() {
        Lang::Ko => format!("앱 실행 별칭의 패키지({pfn})가 설치돼 있지 않음"),
        Lang::En => format!("app execution alias package ({pfn}) is not installed"),
    }
}

pub fn shell_reason_alias_stale_version(points_to: &str) -> String {
    match lang() {
        Lang::Ko => format!("앱 실행 별칭이 설치되지 않은 버전({points_to})을 가리킴"),
        Lang::En => format!("app execution alias points to an uninstalled version ({points_to})"),
    }
}

pub fn shell_reason_start_timed_out(secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("{secs}초 안에 시작되지 않음"),
        Lang::En => format!("did not start within {secs}s"),
    }
}

pub fn pty_create_failed(err: impl Display) -> String {
    // `{err:#}` — anyhow 오류의 원인 사슬까지 보이던 원래 형식을 그대로 넘긴다.
    match lang() {
        Lang::Ko => format!("PTY 생성 실패: {err:#}"),
        Lang::En => format!("Failed to create PTY: {err:#}"),
    }
}

pub fn shell_fallback_notice(failed_labels: &str, chosen_label: &str, reasons: &str) -> String {
    match lang() {
        Lang::Ko => format!(
            "[Gitpervisor] {failed_labels} 를 열 수 없어 {chosen_label} 로 대신 열었습니다 — {reasons}"
        ),
        Lang::En => format!(
            "[Gitpervisor] Could not open {failed_labels}; opened {chosen_label} instead — {reasons}"
        ),
    }
}

// ───────────────────────── git 실행(git/runner.rs · commands/check.rs) ─────────────────────────

pub fn git_executable_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "git 실행 파일을 찾을 수 없습니다 (PATH 또는 Git 설치 확인)",
        Lang::En => "git executable not found (check PATH or your Git installation)",
    }
}

pub fn git_spawn_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("git 실행 실패: {err}"),
        Lang::En => format!("Failed to run git: {err}"),
    }
}

pub fn git_timed_out(subcommand: &str, timeout_secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("git {subcommand} 시간 초과 ({timeout_secs}초)"),
        Lang::En => format!("git {subcommand} timed out ({timeout_secs}s)"),
    }
}

pub fn git_output_collect_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("git 출력 수집 실패: {err}"),
        Lang::En => format!("Failed to collect git output: {err}"),
    }
}

pub fn git_wait_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("git 종료 대기 실패: {err}"),
        Lang::En => format!("Failed to wait for git to exit: {err}"),
    }
}

pub fn git_not_found_on_system() -> &'static str {
    match lang() {
        Lang::Ko => "PATH 및 표준 설치 경로에서 git을 찾지 못했습니다.",
        Lang::En => "Git was not found in PATH or standard install locations.",
    }
}

pub fn git_version_check_failed(code: i32) -> String {
    match lang() {
        Lang::Ko => format!("git --version 실행 실패 (exit {code})"),
        Lang::En => format!("git --version failed (exit {code})"),
    }
}

pub fn git_version_check_failed_with_detail(code: i32, detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("git --version 실행 실패 (exit {code}): {detail}"),
        Lang::En => format!("git --version failed (exit {code}): {detail}"),
    }
}

pub fn git_exec_error(message: &str) -> String {
    match lang() {
        Lang::Ko => format!("git 실행 오류: {message}"),
        Lang::En => format!("git execution error: {message}"),
    }
}

// ───────────────────────── 로그·스테이징·커밋·상태(commands/log.rs · actions.rs · status.rs) ─────────────────────────

pub fn git_log_failed() -> &'static str {
    match lang() {
        Lang::Ko => "git log 실패",
        Lang::En => "git log failed",
    }
}

pub fn invalid_commit_hash() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 커밋 해시입니다",
        Lang::En => "Invalid commit hash",
    }
}

pub fn commit_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "커밋을 찾을 수 없습니다",
        Lang::En => "Commit not found",
    }
}

pub fn commit_meta_parse_failed() -> &'static str {
    match lang() {
        Lang::Ko => "커밋 메타 파싱 실패",
        Lang::En => "Failed to parse commit metadata",
    }
}

pub fn git_command_failed(command: &str) -> String {
    match lang() {
        Lang::Ko => format!("git {command} 실패"),
        Lang::En => format!("git {command} failed"),
    }
}

pub fn commit_message_empty() -> &'static str {
    match lang() {
        Lang::Ko => "커밋 메시지가 비어 있습니다",
        Lang::En => "Commit message is empty",
    }
}

pub fn git_commit_failed() -> &'static str {
    match lang() {
        Lang::Ko => "git commit 실패",
        Lang::En => "git commit failed",
    }
}

pub fn project_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "프로젝트를 찾을 수 없습니다",
        Lang::En => "Project not found",
    }
}

pub fn git_status_failed(stderr: &str) -> String {
    match lang() {
        Lang::Ko => format!("git status 실패: {stderr}"),
        Lang::En => format!("git status failed: {stderr}"),
    }
}

// ───────────────────────── push·pull·fetch 실패 분류(commands/sync.rs · fetch_scheduler.rs) ─────────────────────────

pub fn sync_auth_failed(op: &str) -> String {
    match lang() {
        Lang::Ko => format!("{op} 인증 실패 — credential manager / ssh-agent 설정을 확인하세요"),
        Lang::En => format!("{op} authentication failed — check your credential manager / ssh-agent setup"),
    }
}

pub fn sync_reason_merge_blocked_by_local_changes() -> &'static str {
    match lang() {
        Lang::Ko => "로컬에 커밋되지 않은 변경이 있어 머지가 거부됨 — 먼저 커밋하거나 stash하세요",
        Lang::En => "Merge rejected: uncommitted local changes — commit or stash first",
    }
}

pub fn sync_reason_no_upstream() -> &'static str {
    match lang() {
        Lang::Ko => "현재 브랜치에 추적 원격이 설정되어 있지 않음 (git branch --set-upstream-to ...)",
        Lang::En => "No upstream is set for the current branch (git branch --set-upstream-to ...)",
    }
}

pub fn sync_reason_remote_ref_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "원격 저장소/브랜치를 찾을 수 없음 — 원격 URL과 브랜치 이름을 확인하세요",
        Lang::En => "Remote repository/branch not found — check the remote URL and branch name",
    }
}

pub fn sync_reason_merge_conflict() -> &'static str {
    match lang() {
        Lang::Ko => "병합 충돌 발생 — 충돌을 해결하고 커밋을 완료하세요",
        Lang::En => "Merge conflict — resolve the conflicts and complete the commit",
    }
}

pub fn sync_reason_divergent_branches() -> &'static str {
    match lang() {
        Lang::Ko => "로컬과 원격이 분기됨 — git config pull.rebase 또는 pull.ff 설정이 필요합니다",
        Lang::En => "Local and remote have diverged — set git config pull.rebase or pull.ff",
    }
}

pub fn sync_reason_push_rejected_non_fast_forward() -> &'static str {
    match lang() {
        Lang::Ko => "원격에 먼저 들어간 커밋이 있어 push가 거부됨 — 먼저 pull/fetch & rebase 하세요",
        Lang::En => "Push rejected: the remote has newer commits — pull/fetch & rebase first",
    }
}

pub fn sync_reason_network_failed() -> &'static str {
    match lang() {
        Lang::Ko => "네트워크 연결 실패 — 인터넷/원격 호스트를 확인하세요",
        Lang::En => "Network connection failed — check your internet connection/remote host",
    }
}

pub fn sync_reason_dubious_ownership() -> &'static str {
    match lang() {
        Lang::Ko => "git이 레포 소유자를 신뢰하지 않음 — git config --global --add safe.directory <경로>",
        Lang::En => "Git does not trust the repository owner — git config --global --add safe.directory <path>",
    }
}

pub fn sync_reason_detached_head() -> &'static str {
    match lang() {
        Lang::Ko => "현재 detached HEAD 상태 — 브랜치로 전환 후 다시 시도하세요",
        Lang::En => "Detached HEAD — switch to a branch and try again",
    }
}

pub fn sync_reason_unrelated_histories() -> &'static str {
    match lang() {
        Lang::Ko => "관련 없는 히스토리 머지가 거부됨 — 의도라면 --allow-unrelated-histories 필요",
        Lang::En => "Merge of unrelated histories rejected — use --allow-unrelated-histories if intended",
    }
}

pub fn sync_reason_op_blocked_by_local_changes() -> &'static str {
    match lang() {
        Lang::Ko => "로컬에 커밋되지 않은 변경이 있어 작업이 거부됨 — 먼저 커밋하거나 stash하세요",
        Lang::En => "Operation rejected: uncommitted local changes — commit or stash first",
    }
}

pub fn git_stderr_no_detail() -> &'static str {
    match lang() {
        Lang::Ko => "(상세 메시지 없음)",
        Lang::En => "(no details)",
    }
}

pub fn sync_op_failed(op: &str, snippet: &str) -> String {
    match lang() {
        Lang::Ko => format!("git {op} 실패: {snippet}"),
        Lang::En => format!("git {op} failed: {snippet}"),
    }
}

pub fn fetch_reason_auth_failed() -> &'static str {
    match lang() {
        Lang::Ko => "인증 실패 — credential manager / ssh-agent 설정을 확인하세요",
        Lang::En => "Authentication failed — check your credential manager / ssh-agent setup",
    }
}

pub fn fetch_reason_remote_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "원격 저장소/브랜치를 찾을 수 없음 — 원격 URL을 확인하세요",
        Lang::En => "Remote repository/branch not found — check the remote URL",
    }
}

pub fn background_fetch_failed(reason: &str) -> String {
    match lang() {
        Lang::Ko => format!("배경 fetch 실패: {reason}"),
        Lang::En => format!("Remote refresh failed: {reason}"),
    }
}

// ───────────────────────── 앱 상태·저장(state.rs) ─────────────────────────

pub fn git_op_in_progress() -> &'static str {
    match lang() {
        Lang::Ko => "이미 진행 중인 git 작업이 있습니다 — 완료 후 다시 시도하세요",
        Lang::En => "Another git operation is in progress — try again when it finishes",
    }
}

/// `what`은 아래 `data_label_*` 중 하나(다른 모듈의 호출자는 자기 라벨을 넘긴다).
pub fn data_save_failed(what: &str, err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("{what} 저장 실패: {err}"),
        Lang::En => format!("Failed to save {what}: {err}"),
    }
}

pub fn data_folder_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "데이터 폴더를 찾을 수 없습니다",
        Lang::En => "Data folder not found",
    }
}

pub fn data_label_projects() -> &'static str {
    match lang() {
        Lang::Ko => "프로젝트 목록",
        Lang::En => "project list",
    }
}

pub fn data_label_settings() -> &'static str {
    match lang() {
        Lang::Ko => "설정",
        Lang::En => "settings",
    }
}

pub fn data_label_notes() -> &'static str {
    match lang() {
        Lang::Ko => "메모",
        Lang::En => "notes",
    }
}

pub fn data_label_reports() -> &'static str {
    match lang() {
        Lang::Ko => "작업 요약",
        Lang::En => "reports",
    }
}
