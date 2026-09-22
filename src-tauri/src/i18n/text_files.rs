//! 파일 트리·즐겨찾기·원본 파일·이미지 문서·프로젝트·디스크 스캔·로고·라이브러리 문구 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.

use std::fmt::Display;

use super::{lang, Lang};

// ---- 파일 쓰기·트리 조작 (commands/tree.rs · commands/raw_file.rs) ----

pub fn cannot_write_symlink() -> &'static str {
    match lang() {
        Lang::Ko => "심볼릭 링크에는 쓸 수 없습니다",
        Lang::En => "Cannot write to a symbolic link",
    }
}

pub fn cannot_write_directory() -> &'static str {
    match lang() {
        Lang::Ko => "디렉토리에는 쓸 수 없습니다",
        Lang::En => "Cannot write to a directory",
    }
}

pub fn encoding_unmappable_chars(label: &str, chars: &str) -> String {
    match lang() {
        Lang::Ko => format!("{label} 인코딩으로 표현할 수 없는 문자가 있습니다: {chars}"),
        Lang::En => format!("Some characters cannot be represented in {label}: {chars}"),
    }
}

pub fn encoding_unknown(label: &str) -> String {
    match lang() {
        Lang::Ko => format!("알 수 없는 인코딩입니다: {label}"),
        Lang::En => format!("Unknown encoding: {label}"),
    }
}

pub fn file_save_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 저장 실패: {err}"),
        Lang::En => format!("Failed to save file: {err}"),
    }
}

pub fn file_save_denied_controlled_folder_access() -> &'static str {
    match lang() {
        Lang::Ko => concat!(
            "파일 저장 실패: 액세스가 거부되었습니다. Windows '제어된 폴더 액세스'",
            "(랜섬웨어 방지)가 차단했을 수 있습니다 — 문서·사진·비디오·바탕 화면이 기본 보호 대상입니다. ",
            "Windows 보안 › 랜섬웨어 방지에서 이 앱을 허용하거나 파일을 보호 폴더 밖으로 옮기세요. ",
            "(읽기 전용 파일이거나 다른 프로그램이 열고 있어도 같은 오류가 납니다.)",
        ),
        Lang::En => concat!(
            "Failed to save file: access denied. Windows 'Controlled folder access' ",
            "(ransomware protection) may have blocked it — Documents, Pictures, Videos and Desktop are protected by default. ",
            "Allow this app in Windows Security › Ransomware protection, or move the file outside the protected folders. ",
            "(A read-only file or a file open in another program gives the same error.)",
        ),
    }
}

pub fn file_save_permission_denied() -> &'static str {
    match lang() {
        Lang::Ko => "파일 저장 실패: 권한이 없습니다. 파일·상위 폴더의 쓰기 권한을 확인하세요.",
        Lang::En => "Failed to save file: permission denied. Check write permission on the file and its parent folder.",
    }
}

pub fn name_already_exists() -> &'static str {
    match lang() {
        Lang::Ko => "같은 이름이 이미 있습니다",
        Lang::En => "An item with the same name already exists",
    }
}

pub fn folder_create_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("폴더 생성 실패: {err}"),
        Lang::En => format!("Failed to create folder: {err}"),
    }
}

pub fn file_create_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 생성 실패: {err}"),
        Lang::En => format!("Failed to create file: {err}"),
    }
}

pub fn target_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "대상을 찾을 수 없습니다",
        Lang::En => "Target not found",
    }
}

pub fn delete_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("삭제 실패: {err}"),
        Lang::En => format!("Failed to delete: {err}"),
    }
}

pub fn name_has_path_separator() -> &'static str {
    match lang() {
        Lang::Ko => "이름에 경로 구분자를 쓸 수 없습니다",
        Lang::En => "Name cannot contain a path separator",
    }
}

pub fn invalid_name() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 이름입니다",
        Lang::En => "Invalid name",
    }
}

pub fn invalid_path() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 경로입니다",
        Lang::En => "Invalid path",
    }
}

pub fn rename_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이름 변경 실패: {err}"),
        Lang::En => format!("Failed to rename: {err}"),
    }
}

pub fn move_folder_into_itself() -> &'static str {
    match lang() {
        Lang::Ko => "폴더를 자기 자신 안으로 옮길 수 없습니다",
        Lang::En => "Cannot move a folder into itself",
    }
}

pub fn repo_path_check_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("레포 경로 확인 실패: {err}"),
        Lang::En => format!("Failed to resolve repository path: {err}"),
    }
}

pub fn dest_folder_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "대상 폴더를 찾을 수 없습니다",
        Lang::En => "Destination folder not found",
    }
}

pub fn path_outside_repo() -> &'static str {
    match lang() {
        Lang::Ko => "레포 밖 경로입니다",
        Lang::En => "Path is outside the repository",
    }
}

pub fn dest_not_a_folder() -> &'static str {
    match lang() {
        Lang::Ko => "대상이 폴더가 아닙니다",
        Lang::En => "Destination is not a folder",
    }
}

pub fn dest_folder_name_already_exists() -> &'static str {
    match lang() {
        Lang::Ko => "대상 폴더에 같은 이름이 이미 있습니다",
        Lang::En => "An item with the same name already exists in the destination folder",
    }
}

pub fn move_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이동 실패: {err}"),
        Lang::En => format!("Failed to move: {err}"),
    }
}

pub fn file_changed_externally_since_edit() -> &'static str {
    match lang() {
        Lang::Ko => "이 파일이 편집을 시작한 뒤 외부에서 바뀌었습니다",
        Lang::En => "This file was changed outside the app after editing started",
    }
}

pub fn file_same_name_exists() -> &'static str {
    match lang() {
        Lang::Ko => "이미 같은 이름의 파일이 있습니다",
        Lang::En => "A file with the same name already exists",
    }
}

pub fn image_bytes_decode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이미지 디코딩 실패: {err}"),
        Lang::En => format!("Failed to decode image: {err}"),
    }
}

pub fn write_bytes_too_large_64mb() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 너무 큽니다 (64MB 초과)",
        Lang::En => "File is too large (over 64MB)",
    }
}

pub fn project_root_read_timeout() -> &'static str {
    match lang() {
        Lang::Ko => "루트 읽기 시간 초과",
        Lang::En => "Timed out reading the project root",
    }
}

pub fn directory_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "디렉토리를 찾을 수 없습니다",
        Lang::En => "Directory not found",
    }
}

pub fn directory_read_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("디렉토리 읽기 실패: {err}"),
        Lang::En => format!("Failed to read directory: {err}"),
    }
}

pub fn directory_read_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("디렉토리 읽기 작업 실패: {err}"),
        Lang::En => format!("Directory read task failed: {err}"),
    }
}

pub fn parent_directory_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "상위 디렉토리를 찾을 수 없습니다",
        Lang::En => "Parent directory not found",
    }
}

// ---- 즐겨찾기 폴더 (commands/favorites.rs) ----

pub fn fav_path_not_found(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("경로를 찾을 수 없습니다: {err}"),
        Lang::En => format!("Path not found: {err}"),
    }
}

pub fn fav_folder_not_registered() -> &'static str {
    match lang() {
        Lang::Ko => "즐겨찾기에 등록되지 않은 폴더입니다",
        Lang::En => "Folder is not in favorite folders",
    }
}

pub fn fav_folder_read_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("폴더를 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to read folder: {err}"),
    }
}

pub fn fav_thumb_size_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "지원하지 않는 썸네일 크기입니다",
        Lang::En => "Unsupported thumbnail size",
    }
}

/// "파일을 읽지 못했습니다" — `file_read_failed`("파일 읽기 실패")와 한국어가 달라 따로 둔다.
pub fn could_not_read_file(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일을 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to read file: {err}"),
    }
}

pub fn fav_thumb_wait_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("썸네일 대기 실패: {err}"),
        Lang::En => format!("Failed to wait for thumbnail: {err}"),
    }
}

pub fn fav_thumb_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("썸네일 작업 실패: {err}"),
        Lang::En => format!("Thumbnail task failed: {err}"),
    }
}

pub fn fav_image_open_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이미지를 열지 못했습니다: {err}"),
        Lang::En => format!("Failed to open image: {err}"),
    }
}

pub fn fav_thumb_image_too_large(what: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이미지가 너무 큽니다 ({what}) — 기본 앱으로 열어 보세요"),
        Lang::En => format!("Image is too large ({what}) — open it in the default app"),
    }
}

/// `fav_thumb_image_too_large` 괄호 안에 들어가는 파일 크기.
pub fn fav_thumb_file_size_mib(mib: u64) -> String {
    match lang() {
        Lang::Ko => format!("파일 {mib} MiB"),
        Lang::En => format!("file {mib} MiB"),
    }
}

pub fn fav_thumb_encode_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("썸네일 인코딩 실패: {err}"),
        Lang::En => format!("Failed to encode thumbnail: {err}"),
    }
}

pub fn fav_read_too_large_25mb() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 너무 큽니다 (25MB 초과) — 기본 앱으로 열어 보세요",
        Lang::En => "File is too large (over 25MB) — open it in the default app",
    }
}

pub fn fav_trash_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("휴지통으로 보내지 못했습니다: {err}"),
        Lang::En => format!("Failed to move to Trash: {err}"),
    }
}

pub fn fav_preset_screenshots() -> &'static str {
    match lang() {
        Lang::Ko => "스크린샷",
        Lang::En => "Screenshots",
    }
}

pub fn fav_preset_downloads() -> &'static str {
    match lang() {
        Lang::Ko => "다운로드",
        Lang::En => "Downloads",
    }
}

pub fn fav_preset_desktop() -> &'static str {
    match lang() {
        Lang::Ko => "바탕화면",
        Lang::En => "Desktop",
    }
}

// ---- 원본 파일 raw IPC (commands/raw_file.rs) ----

pub fn raw_file_too_large_256mb() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 너무 큽니다 (256MB 초과)",
        Lang::En => "File is too large (over 256MB)",
    }
}

pub fn file_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "파일을 찾을 수 없습니다",
        Lang::En => "File not found",
    }
}

pub fn not_a_file() -> &'static str {
    match lang() {
        Lang::Ko => "파일이 아닙니다",
        Lang::En => "Not a file",
    }
}

pub fn file_read_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 읽기 실패: {err}"),
        Lang::En => format!("Failed to read file: {err}"),
    }
}

// 아래 raw_header_* 는 호출처가 "write_file_raw: " 뒤에 붙인다.

pub fn raw_header_project_missing() -> &'static str {
    match lang() {
        Lang::Ko => "x-gpv-project 헤더 누락",
        Lang::En => "missing x-gpv-project header",
    }
}

pub fn raw_header_path_missing() -> &'static str {
    match lang() {
        Lang::Ko => "x-gpv-path-b64 헤더 누락",
        Lang::En => "missing x-gpv-path-b64 header",
    }
}

pub fn raw_header_path_base64_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "경로 base64 디코딩 실패",
        Lang::En => "failed to decode path base64",
    }
}

pub fn raw_header_path_not_utf8() -> &'static str {
    match lang() {
        Lang::Ko => "경로가 UTF-8 이 아닙니다",
        Lang::En => "path is not UTF-8",
    }
}

pub fn raw_header_mode_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "x-gpv-mode 는 append | replace",
        Lang::En => "x-gpv-mode must be append | replace",
    }
}

pub fn raw_header_base_len_not_number() -> &'static str {
    match lang() {
        Lang::Ko => "x-gpv-base-len 이 숫자가 아닙니다",
        Lang::En => "x-gpv-base-len is not a number",
    }
}

pub fn raw_header_append_needs_stamp_and_len() -> &'static str {
    match lang() {
        Lang::Ko => "append 에는 x-gpv-expected-stamp 와 x-gpv-base-len 이 필요합니다",
        Lang::En => "append requires x-gpv-expected-stamp and x-gpv-base-len",
    }
}

pub fn raw_body_required() -> &'static str {
    match lang() {
        Lang::Ko => "write_file_raw: raw 본문이 필요합니다",
        Lang::En => "write_file_raw: raw body required",
    }
}

pub fn raw_write_task_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("쓰기 작업 실패: {err}"),
        Lang::En => format!("Write task failed: {err}"),
    }
}

pub fn file_locked_by_other_program() -> &'static str {
    match lang() {
        Lang::Ko => "다른 프로그램이 이 파일을 열고 있어 저장하지 못했습니다",
        Lang::En => "Failed to save: another program has this file open",
    }
}

pub fn raw_target_file_missing() -> &'static str {
    match lang() {
        Lang::Ko => "대상 파일이 없습니다",
        Lang::En => "Target file not found",
    }
}

// ---- 이미지 편집 문서 (commands/image_doc.rs) ----

pub fn image_doc_kind_unknown() -> &'static str {
    match lang() {
        Lang::Ko => "알 수 없는 문서 종류입니다",
        Lang::En => "Unknown document kind",
    }
}

pub fn image_doc_too_large_32mb() -> &'static str {
    match lang() {
        Lang::Ko => "편집 문서가 너무 큽니다 (32MB 초과)",
        Lang::En => "Edit document is too large (over 32MB)",
    }
}

pub fn image_doc_saved_by_other_window() -> &'static str {
    match lang() {
        Lang::Ko => "이 이미지의 편집 문서를 다른 창이 먼저 저장했습니다",
        Lang::En => "Another window already saved this image's edit document",
    }
}

pub fn image_doc_save_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("편집 문서 저장 실패: {err}"),
        Lang::En => format!("Failed to save edit document: {err}"),
    }
}

pub fn image_doc_move_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("편집 문서 이동 실패: {err}"),
        Lang::En => format!("Failed to move edit document: {err}"),
    }
}

pub fn image_doc_delete_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("편집 문서 삭제 실패: {err}"),
        Lang::En => format!("Failed to delete edit document: {err}"),
    }
}

pub fn asset_pick_dialog_title() -> &'static str {
    match lang() {
        Lang::Ko => "이미지 선택",
        Lang::En => "Select image",
    }
}

pub fn asset_pick_filter_images() -> &'static str {
    match lang() {
        Lang::Ko => "이미지",
        Lang::En => "Images",
    }
}

pub fn file_dialog_no_response() -> &'static str {
    match lang() {
        Lang::Ko => "파일 선택 창이 응답하지 않았습니다",
        Lang::En => "The file dialog did not respond",
    }
}

pub fn file_path_read_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("파일 경로를 읽지 못했습니다: {err}"),
        Lang::En => format!("Failed to read file path: {err}"),
    }
}

pub fn asset_not_an_image() -> &'static str {
    match lang() {
        Lang::Ko => "이미지 파일이 아닙니다 (png·jpg·gif·webp·bmp·avif·tiff·svg)",
        Lang::En => "Not an image file (png·jpg·gif·webp·bmp·avif·tiff·svg)",
    }
}

pub fn asset_image_too_large_16mb() -> &'static str {
    match lang() {
        Lang::Ko => "이미지가 너무 큽니다 (16MB 초과)",
        Lang::En => "Image is too large (over 16MB)",
    }
}

// ---- 프로젝트 (commands/projects.rs · commands/logo.rs) ----
// "프로젝트를 찾을 수 없습니다"·"프로젝트 경로를 찾을 수 없습니다"·"데이터 폴더를 찾을 수 없습니다"는
// text_git_net 공용 함수를 쓴다 — App.tsx 가 status 오류를 그 글자로 비교하므로 출처가 하나여야 한다.

pub fn nested_repo_path_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 중첩 저장소 경로입니다",
        Lang::En => "Invalid nested repository path",
    }
}

pub fn nested_repo_path_escapes() -> &'static str {
    match lang() {
        Lang::Ko => "저장소 경계를 벗어난 경로입니다",
        Lang::En => "Path is outside the repository boundary",
    }
}

pub fn project_folder_not_found(path: &str) -> String {
    match lang() {
        Lang::Ko => format!("폴더를 찾을 수 없습니다: {path}"),
        Lang::En => format!("Folder not found: {path}"),
    }
}

pub fn path_normalize_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("경로 정규화 실패: {err}"),
        Lang::En => format!("Failed to normalize path: {err}"),
    }
}

pub fn project_already_registered(path: &str) -> String {
    match lang() {
        Lang::Ko => format!("이미 등록된 프로젝트입니다: {path}"),
        Lang::En => format!("Project is already added: {path}"),
    }
}

pub fn invalid_folder_name() -> &'static str {
    match lang() {
        Lang::Ko => "잘못된 폴더 이름입니다",
        Lang::En => "Invalid folder name",
    }
}

pub fn parent_folder_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "부모 폴더를 찾을 수 없습니다",
        Lang::En => "Parent folder not found",
    }
}

pub fn folder_same_name_exists() -> &'static str {
    match lang() {
        Lang::Ko => "같은 이름의 폴더가 이미 있습니다",
        Lang::En => "A folder with the same name already exists",
    }
}

pub fn git_init_failed() -> &'static str {
    match lang() {
        Lang::Ko => "git init 실패",
        Lang::En => "git init failed",
    }
}

pub fn logo_file_unusable() -> &'static str {
    match lang() {
        Lang::Ko => "로고로 쓸 수 없는 파일 — png/jpeg는 4MiB, 그 외 형식은 200KiB까지",
        Lang::En => "File cannot be used as a logo — up to 4MiB for png/jpeg, 200KiB for other formats",
    }
}

// ---- 디스크 용량·청소·스캔 (commands/disk.rs · disk_scan.rs) ----

pub fn size_calc_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("용량 계산 실패: {err}"),
        Lang::En => format!("Failed to calculate size: {err}"),
    }
}

pub fn path_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "경로를 찾을 수 없습니다",
        Lang::En => "Path not found",
    }
}

pub fn clean_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("청소 실패: {err}"),
        Lang::En => format!("Failed to clean: {err}"),
    }
}

pub fn clean_target_delete_failed() -> &'static str {
    match lang() {
        Lang::Ko => "target 디렉토리를 삭제하지 못했습니다 (빌드/에디터가 사용 중일 수 있음)",
        Lang::En => "Failed to delete the target directory (a build or editor may be using it)",
    }
}

pub fn disk_scan_node_cap_exceeded(cap: usize) -> String {
    match lang() {
        Lang::Ko => format!("폴더가 {cap}개를 넘습니다 — 더 좁은 폴더를 스캔하세요"),
        Lang::En => format!("More than {cap} folders — scan a narrower folder"),
    }
}

pub fn disk_scan_root_open_failed(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("폴더를 열 수 없습니다: {err}"),
        Lang::En => format!("Failed to open folder: {err}"),
    }
}

pub fn disk_scan_not_a_folder(path: &str) -> String {
    match lang() {
        Lang::Ko => format!("폴더가 아니거나 접근할 수 없습니다: {path}"),
        Lang::En => format!("Not a folder or not accessible: {path}"),
    }
}

pub fn disk_scan_already_running() -> &'static str {
    match lang() {
        Lang::Ko => "이미 스캔이 진행 중입니다 — 중지 후 다시 시도하세요",
        Lang::En => "A scan is already running — stop it and try again",
    }
}

pub fn disk_scan_folder_not_in_result() -> &'static str {
    match lang() {
        Lang::Ko => "스캔 결과에 없는 폴더입니다 — 다시 스캔하세요",
        Lang::En => "Folder is not in the scan results — scan again",
    }
}

pub fn disk_scan_no_completed_scan() -> &'static str {
    match lang() {
        Lang::Ko => "완료된 스캔이 없습니다 — 먼저 스캔하세요",
        Lang::En => "No completed scan — run a scan first",
    }
}

// ---- 이미지 라이브러리 (commands/library.rs) ----

pub fn image_library_too_large_8mb() -> &'static str {
    match lang() {
        Lang::Ko => "이미지 라이브러리가 너무 큽니다 (8MB 초과)",
        Lang::En => "Image library is too large (over 8MB)",
    }
}

pub fn image_library_invalid_format(err: impl Display) -> String {
    match lang() {
        Lang::Ko => format!("이미지 라이브러리 형식이 올바르지 않습니다: {err}"),
        Lang::En => format!("Invalid image library format: {err}"),
    }
}

/// `state::save_json` 의 `what` — "<what> 저장 실패" 문장 가운데 들어가므로 영어는 소문자.
pub fn image_library_label() -> &'static str {
    match lang() {
        Lang::Ko => "이미지 라이브러리",
        Lang::En => "image library",
    }
}
