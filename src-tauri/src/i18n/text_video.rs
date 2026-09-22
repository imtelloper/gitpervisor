//! 영상 명령(commands/video.rs) 문구 — ffmpeg 획득·자르기·분할·내보내기 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.

use super::{lang, Lang};
use std::fmt::Display;

// ── 발견 체인·실행 헬퍼 ─────────────────────────────────────────────────────

pub fn video_ffmpeg_explicit_path_missing() -> &'static str {
    match lang() {
        Lang::Ko => "설정한 ffmpeg 경로에 실행 파일이 없습니다 — 설정 › 코드 도구를 확인하세요",
        Lang::En => "No executable at the configured ffmpeg path — check Settings › Code tools",
    }
}

pub fn video_ffmpeg_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "ffmpeg를 찾을 수 없습니다 — 설정 › 코드 도구에서 다운로드하거나 PATH에 설치하세요",
        Lang::En => "ffmpeg not found — download it in Settings › Code tools or install it on PATH",
    }
}

pub fn video_run_failed(bin: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("실행 실패({bin}): {err}"),
        Lang::En => format!("Failed to run ({bin}): {err}"),
    }
}

pub fn video_run_timed_out(secs: u64) -> String {
    match lang() {
        Lang::Ko => format!("실행 시간 초과 ({secs}초)"),
        Lang::En => format!("Run timed out ({secs}s)"),
    }
}

pub fn video_output_collect_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("출력 수집 실패: {err}"),
        Lang::En => format!("Failed to collect output: {err}"),
    }
}

pub fn video_filters_list_failed(ffmpeg: &dyn Display, code: i32) -> String {
    match lang() {
        Lang::Ko => format!("ffmpeg 필터 목록을 읽지 못했습니다({ffmpeg}, 종료 코드 {code})"),
        Lang::En => format!("Failed to read the ffmpeg filter list ({ffmpeg}, exit code {code})"),
    }
}

// ── 프로브 ──────────────────────────────────────────────────────────────────

pub fn video_ffprobe_parse_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("ffprobe 출력 파싱 실패: {err}"),
        Lang::En => format!("Failed to parse ffprobe output: {err}"),
    }
}

pub fn video_ffprobe_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "ffprobe를 찾을 수 없습니다 — ffmpeg와 같은 폴더에 있어야 합니다",
        Lang::En => "ffprobe not found — it must be in the same folder as ffmpeg",
    }
}

pub fn video_media_info_unreadable() -> &'static str {
    match lang() {
        Lang::Ko => "미디어 정보를 읽지 못했습니다 (손상되었거나 지원하지 않는 형식)",
        Lang::En => "Couldn't read media info (corrupted file or unsupported format)",
    }
}

pub fn video_file_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "파일을 찾을 수 없습니다",
        Lang::En => "File not found",
    }
}

// ── 내보내기 스펙 검증 — video_export_spec_error가 나머지 사유를 감싼다 ────────

pub fn video_export_spec_error(detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("내보내기 스펙 오류: {detail}"),
        Lang::En => format!("Invalid export spec: {detail}"),
    }
}

pub fn video_spec_unsupported_format(ext: &str) -> String {
    match lang() {
        Lang::Ko => format!("지원하지 않는 출력 형식 .{ext}"),
        Lang::En => format!("unsupported output format .{ext}"),
    }
}

pub fn video_spec_range_inverted() -> &'static str {
    match lang() {
        Lang::Ko => "구간 시작이 끝보다 늦습니다",
        Lang::En => "range start must be before its end",
    }
}

pub fn video_spec_speed_out_of_range() -> &'static str {
    match lang() {
        Lang::Ko => "배속은 0.25~4배만 지원합니다",
        Lang::En => "speed must be between 0.25x and 4x",
    }
}

pub fn video_spec_crf_out_of_range() -> &'static str {
    match lang() {
        Lang::Ko => "CRF 범위(0~51) 초과",
        Lang::En => "CRF out of range (0–51)",
    }
}

pub fn video_spec_caption_cut_needs_encode() -> &'static str {
    match lang() {
        Lang::Ko => "대본 편집본은 재인코딩으로만 만들 수 있습니다 (무손실 복사 불가)",
        Lang::En => "a transcript edit requires re-encoding (lossless copy not possible)",
    }
}

pub fn video_spec_caption_cut_with_range() -> &'static str {
    match lang() {
        Lang::Ko => "대본 편집본은 구간(In/Out)과 함께 쓸 수 없습니다",
        Lang::En => "a transcript edit can't be combined with a range (In/Out)",
    }
}

pub fn video_spec_caption_cut_container(ext: &str) -> String {
    match lang() {
        Lang::Ko => format!("대본 편집본은 mp4·mov로만 내보냅니다 (.{ext})"),
        Lang::En => format!("a transcript edit exports only to mp4/mov (.{ext})"),
    }
}

pub fn video_spec_captioned_container(ext: &str) -> String {
    match lang() {
        Lang::Ko => format!("자막 입힌 영상은 mp4·mov로만 내보냅니다 (.{ext})"),
        Lang::En => format!("a captioned video exports only to mp4/mov (.{ext})"),
    }
}

pub fn video_spec_burn_needs_encode() -> &'static str {
    match lang() {
        Lang::Ko => "자막 번인은 재인코딩으로만 만들 수 있습니다 (무손실 복사 불가)",
        Lang::En => "burned-in captions require re-encoding (lossless copy not possible)",
    }
}

pub fn video_spec_edited_subs_need_cut() -> &'static str {
    match lang() {
        Lang::Ko => "편집본 시각 자막은 대본 편집본과 함께만 넣을 수 있습니다",
        Lang::En => "captions timed to the edit can only be added to a transcript edit",
    }
}

pub fn video_spec_cut_needs_edited_subs() -> &'static str {
    match lang() {
        Lang::Ko => "대본 편집본에는 편집본 시각 자막만 넣을 수 있습니다",
        Lang::En => "a transcript edit only accepts captions timed to the edit",
    }
}

pub fn video_spec_translation_lang_missing() -> &'static str {
    match lang() {
        Lang::Ko => "번역 자막의 언어가 지정되지 않았습니다",
        Lang::En => "no language set for translated captions",
    }
}

pub fn video_spec_copy_incompatible() -> &'static str {
    match lang() {
        Lang::Ko => "무손실 복사는 배속·크롭·모자이크·화질·GIF와 함께 쓸 수 없습니다 (재인코딩 필요)",
        Lang::En => "lossless copy can't be combined with speed, crop, mosaic, quality, or GIF (re-encoding required)",
    }
}

pub fn video_spec_mode_invalid() -> &'static str {
    match lang() {
        Lang::Ko => "mode는 copy|encode",
        Lang::En => "mode must be copy|encode",
    }
}

// ── 자막 번인·긴 필터 그래프 ─────────────────────────────────────────────────

pub fn video_burn_filter_missing(ffmpeg: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!(
            "이 ffmpeg({ffmpeg})에는 자막 번인 필터(libass `subtitles`)가 없습니다 — 소프트 자막으로 내보내거나 libass가 든 ffmpeg를 쓰세요"
        ),
        Lang::En => format!(
            "This ffmpeg ({ffmpeg}) has no caption burn-in filter (libass `subtitles`) — export soft captions or use an ffmpeg built with libass"
        ),
    }
}

pub fn video_burn_no_video_track() -> &'static str {
    match lang() {
        Lang::Ko => "영상 트랙이 없는 파일에는 자막을 입힐 수 없습니다",
        Lang::En => "Can't burn captions into a file with no video track",
    }
}

pub fn video_graph_file_unsupported(version: &str) -> String {
    match lang() {
        Lang::Ko => format!(
            "남길 구간이 너무 많아 명령줄에 다 들어가지 않고, ffmpeg {version}는 그래프 파일을 읽지 못합니다(7.0 이상 필요) — 무음 줄이기 목표를 늘려 구간을 줄이거나 ffmpeg 7 이상을 쓰세요"
        ),
        Lang::En => format!(
            "Too many ranges to keep to fit on the command line, and ffmpeg {version} can't read graph files (7.0+ required) — raise the silence trimming target to reduce ranges or use ffmpeg 7+"
        ),
    }
}

pub fn video_graph_file_write_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("필터 그래프 파일 쓰기 실패({path}): {err}"),
        Lang::En => format!("Failed to write filter graph file ({path}): {err}"),
    }
}

// ── 내보내기 실행 ───────────────────────────────────────────────────────────

/// ffmpeg 실패 줄 뒤에 붙는 꼬리 — 앞의 " — "까지 문구에 포함된다.
#[cfg(windows)]
pub fn video_cfa_hint() -> &'static str {
    match lang() {
        Lang::Ko => " — 저장 폴더가 Windows '제어된 폴더 액세스' 보호 대상입니다. Windows 보안 › 바이러스 및 위협 방지 › 랜섬웨어 방지 › 폴더 액세스 제어에서 ffmpeg.exe와 이 앱을 허용 목록에 추가하거나, 다른 폴더에 저장하세요.",
        Lang::En => " — The save folder is protected by Windows Controlled folder access. In Windows Security › Virus & threat protection › Ransomware protection › Controlled folder access, allow ffmpeg.exe and this app, or save to a different folder.",
    }
}

pub fn video_no_error_detail() -> &'static str {
    match lang() {
        Lang::Ko => "(상세 메시지 없음)",
        Lang::En => "(no details)",
    }
}

pub fn video_source_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "원본 파일을 찾을 수 없습니다",
        Lang::En => "Source file not found",
    }
}

pub fn video_export_onto_source() -> &'static str {
    match lang() {
        Lang::Ko => "원본과 같은 파일로 내보낼 수 없습니다",
        Lang::En => "Can't export to the source file itself",
    }
}

pub fn video_output_exists(rel: &str) -> String {
    match lang() {
        Lang::Ko => format!("{rel} 파일이 이미 있습니다"),
        Lang::En => format!("{rel} already exists"),
    }
}

pub fn video_caption_audio_track_missing(track: u32, tracks: usize) -> String {
    match lang() {
        Lang::Ko => format!(
            "자막을 만든 오디오 트랙 {track}번이 이 파일에 없습니다(오디오 트랙 {tracks}개) — 원본이 바뀌었습니다. 대본에서 다시 인식하거나 소리 빼기로 내보내세요"
        ),
        Lang::En => format!(
            "Audio track {track} used for the captions isn't in this file ({tracks} audio tracks) — the source has changed. Re-run recognition from the transcript, or export with audio removed"
        ),
    }
}

pub fn video_ffmpeg_spawn_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("ffmpeg 실행 실패: {err}"),
        Lang::En => format!("Failed to run ffmpeg: {err}"),
    }
}

pub fn video_ffmpeg_wait_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("ffmpeg 종료 대기 실패: {err}"),
        Lang::En => format!("Failed waiting for ffmpeg to exit: {err}"),
    }
}

pub fn video_export_cancelled() -> &'static str {
    match lang() {
        Lang::Ko => "내보내기가 취소되었습니다",
        Lang::En => "Export cancelled",
    }
}

pub fn video_burn_missing_glyphs(count: usize, shown: &str, font: &str) -> String {
    match lang() {
        Lang::Ko => format!(
            "자막 글꼴에 없는 글자 {count}개가 네모 칸으로 그려져 내보내지 않았습니다({shown}) — '{font}' 글꼴(Linux: fonts-noto-cjk 패키지)을 설치하거나 소프트 자막으로 내보내세요"
        ),
        Lang::En => format!(
            "Not exported: {count} characters missing from the caption font would render as boxes ({shown}) — install the '{font}' font (Linux: fonts-noto-cjk package) or export soft captions"
        ),
    }
}

pub fn video_ffmpeg_failed(line: &str, hint: &str) -> String {
    match lang() {
        Lang::Ko => format!("ffmpeg 실패: {line}{hint}"),
        Lang::En => format!("ffmpeg failed: {line}{hint}"),
    }
}

// ── 프레임 캡처·산출물 ──────────────────────────────────────────────────────

pub fn video_frame_capture_failed(line: &str) -> String {
    match lang() {
        Lang::Ko => format!("프레임 캡처 실패: {line}"),
        Lang::En => format!("Frame capture failed: {line}"),
    }
}

pub fn video_frame_not_found_at_position() -> &'static str {
    match lang() {
        Lang::Ko => "이 위치에서 저장할 프레임을 찾지 못했습니다 — 한 프레임 앞으로 옮긴 뒤 다시 시도하세요",
        Lang::En => "No frame to save at this position — move back one frame and try again",
    }
}

pub fn video_output_move_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("산출물 이동 실패({path}): {err}"),
        Lang::En => format!("Failed to move output file ({path}): {err}"),
    }
}

// ── 필름스트립·파형 ─────────────────────────────────────────────────────────

pub fn video_filmstrip_args_out_of_range() -> &'static str {
    match lang() {
        Lang::Ko => "필름스트립 인자 범위를 벗어났습니다 (cols 1~240, height 8~240)",
        Lang::En => "Filmstrip arguments out of range (cols 1–240, height 8–240)",
    }
}

pub fn video_filmstrip_no_video() -> &'static str {
    match lang() {
        Lang::Ko => "영상 스트림이 없거나 길이를 알 수 없어 필름스트립을 만들 수 없습니다",
        Lang::En => "Can't build a filmstrip: no video stream or unknown duration",
    }
}

pub fn video_filmstrip_failed(line: &str) -> String {
    match lang() {
        Lang::Ko => format!("필름스트립 생성 실패: {line}"),
        Lang::En => format!("Filmstrip generation failed: {line}"),
    }
}

pub fn video_filmstrip_decode_failed() -> &'static str {
    match lang() {
        Lang::Ko => "필름스트립 이미지를 해석하지 못했습니다",
        Lang::En => "Couldn't parse the filmstrip image",
    }
}

pub fn video_waveform_buckets_out_of_range() -> &'static str {
    match lang() {
        Lang::Ko => "파형 버킷 수 범위를 벗어났습니다 (1~4096)",
        Lang::En => "Waveform bucket count out of range (1–4096)",
    }
}

// ── ffmpeg 획득(진행 채널의 message로 설정 화면에 보인다) ─────────────────────

pub fn video_download_no_candidate_url() -> &'static str {
    match lang() {
        Lang::Ko => "다운로드 후보 URL 없음",
        Lang::En => "No download URL candidates",
    }
}

pub fn video_download_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("다운로드 실패: {err}"),
        Lang::En => format!("Download failed: {err}"),
    }
}

pub fn video_download_status_error(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("다운로드 상태 오류: {err}"),
        Lang::En => format!("Download status error: {err}"),
    }
}

pub fn video_temp_file_create_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("임시 파일 생성 실패: {err}"),
        Lang::En => format!("Failed to create temp file: {err}"),
    }
}

pub fn video_download_body_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("본문 수신 실패: {err}"),
        Lang::En => format!("Failed to receive download body: {err}"),
    }
}

pub fn video_temp_file_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("임시 파일 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write temp file: {err}"),
    }
}

pub fn video_integrity_check_failed() -> &'static str {
    match lang() {
        Lang::Ko => "무결성 검증 실패 — 다운로드 변조 의심",
        Lang::En => "Integrity check failed — the download may have been tampered with",
    }
}

pub fn video_archive_open_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("아카이브 열기 실패: {err}"),
        Lang::En => format!("Failed to open archive: {err}"),
    }
}

pub fn video_zip_open_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("zip 열기 실패: {err}"),
        Lang::En => format!("Failed to open zip: {err}"),
    }
}

pub fn video_zip_extract_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("zip 해제 실패: {err}"),
        Lang::En => format!("Failed to extract zip: {err}"),
    }
}

pub fn video_tar_xz_extract_failed() -> &'static str {
    match lang() {
        Lang::Ko => "tar.xz 해제 실패 — 시스템 tar/xz 필요",
        Lang::En => "Failed to extract tar.xz — system tar/xz required",
    }
}

pub fn video_managed_download_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => "이 플랫폼은 앱 내 다운로드를 지원하지 않습니다 — 패키지 관리자(brew/apt 등)로 ffmpeg를 설치하세요",
        Lang::En => "In-app download isn't supported on this platform — install ffmpeg with a package manager (brew/apt, etc.)",
    }
}

pub fn video_app_data_path_error() -> &'static str {
    match lang() {
        Lang::Ko => "앱 데이터 경로 오류",
        Lang::En => "Failed to resolve app data path",
    }
}

pub fn video_http_client_error(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("HTTP 클라이언트 오류: {err}"),
        Lang::En => format!("HTTP client error: {err}"),
    }
}

pub fn video_temp_dir_create_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("temp 생성 실패: {err}"),
        Lang::En => format!("Failed to create temp folder: {err}"),
    }
}

pub fn video_install_move_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("설치 이동 실패: {err}"),
        Lang::En => format!("Failed to move into install folder: {err}"),
    }
}

pub fn video_marker_write_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("마커 쓰기 실패: {err}"),
        Lang::En => format!("Failed to write install marker: {err}"),
    }
}
