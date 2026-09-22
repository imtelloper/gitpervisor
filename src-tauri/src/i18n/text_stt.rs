//! 음성 인식·자막(stt/) 문구 — whisper 획득·받아쓰기·자막 문서·자막 입힌 영상 — 문구 하나 = 함수 하나, 모든 `Lang`을 `match`로 적는다(DOCS/i18n-design.md §4.4).
//! 빠진 언어는 컴파일 오류다. 정적 문구는 `&'static str`, 보간이 있으면 `String`을 돌려준다.

use super::{lang, Lang};
use std::fmt::{Debug, Display};

// ── stt/acquire.rs — 엔진·모델 획득(설정 › AI › 음성 인식) ─────────────────────

pub fn stt_model_note_turbo_q5() -> &'static str {
    match lang() {
        Lang::Ko => "기본 — 한국어 정확도 최상, MIT",
        Lang::En => "Default — best Korean accuracy, MIT",
    }
}

pub fn stt_model_note_base_q5() -> &'static str {
    match lang() {
        Lang::Ko => "저사양·빠른 초안 — 정확도 낮음, MIT",
        Lang::En => "Low-end PCs · quick drafts — lower accuracy, MIT",
    }
}

pub fn stt_exec_failed(exe: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("실행 실패({exe}): {err}"),
        Lang::En => format!("Failed to run ({exe}): {err}"),
    }
}

pub fn stt_output_collect_failed(exe: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("출력 수집 실패({exe}): {err}"),
        Lang::En => format!("Failed to collect output ({exe}): {err}"),
    }
}

pub fn stt_exec_no_response(exe: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{exe} 응답 없음(20초)"),
        Lang::En => format!("{exe} did not respond (20 s)"),
    }
}

pub fn stt_vc_redist_required() -> &'static str {
    match lang() {
        Lang::Ko => {
            "음성 인식 엔진을 실행하려면 Microsoft Visual C++ 재배포 패키지가 필요합니다 — \
             https://aka.ms/vs/17/release/vc_redist.x64.exe (ARM64는 vc_redist.arm64.exe)를 설치한 뒤 다시 받으세요"
        }
        Lang::En => {
            "The speech recognition engine requires the Microsoft Visual C++ Redistributable — \
             install https://aka.ms/vs/17/release/vc_redist.x64.exe (vc_redist.arm64.exe on ARM64), then download again"
        }
    }
}

pub fn stt_glibc_unsupported() -> &'static str {
    match lang() {
        Lang::Ko => {
            "이 배포판에서는 whisper.cpp 공식 빌드를 실행할 수 없습니다(glibc 2.34 이상·libgomp 필요) — \
             시스템에 whisper-cli를 설치해 PATH에 두세요"
        }
        Lang::En => {
            "The official whisper.cpp build can't run on this distribution (requires glibc 2.34+ and libgomp) — \
             install whisper-cli on your system and put it on PATH"
        }
    }
}

pub fn stt_engine_check_failed(code: Option<i32>, detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("음성 인식 엔진 확인 실패(종료 코드 {code:?}): {detail}"),
        Lang::En => format!("Speech recognition engine check failed (exit code {code:?}): {detail}"),
    }
}

pub fn stt_whisper_too_old(exe: &dyn Display, missing: &str) -> String {
    match lang() {
        Lang::Ko => format!(
            "whisper.cpp 버전이 낮습니다({exe}) — 빠진 옵션: {missing}. `brew upgrade whisper-cpp` 등으로 1.8 이상을 설치하세요"
        ),
        Lang::En => format!(
            "whisper.cpp is too old ({exe}) — missing options: {missing}. Install 1.8 or later, e.g. `brew upgrade whisper-cpp`"
        ),
    }
}

pub fn stt_no_official_build() -> &'static str {
    match lang() {
        Lang::Ko => {
            "이 플랫폼용 whisper.cpp 공식 빌드가 없습니다 — 터미널에서 `brew install whisper-cpp`로 설치하세요 \
             (Intel Mac은 bottle이 없어 소스 빌드가 됩니다)"
        }
        Lang::En => {
            "There is no official whisper.cpp build for this platform — install it from a terminal with `brew install whisper-cpp` \
             (Intel Macs have no bottle, so it builds from source)"
        }
    }
}

pub fn stt_unknown_model(model_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("모르는 음성 인식 모델: {model_id}"),
        Lang::En => format!("Unknown speech recognition model: {model_id}"),
    }
}

pub fn stt_model_in_use() -> &'static str {
    match lang() {
        Lang::Ko => "이 모델로 자막을 만드는 중입니다 — 끝나거나 취소한 뒤 지우세요",
        Lang::En => "Captions are being generated with this model — delete it after that finishes or is cancelled",
    }
}

// ── stt/transcribe.rs — 받아쓰기 잡 ─────────────────────────────────────────

pub fn stt_already_running() -> &'static str {
    match lang() {
        Lang::Ko => "이미 다른 영상의 자막을 만드는 중입니다",
        Lang::En => "Already generating captions for another video",
    }
}

pub fn stt_app_data_path_error(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("앱 데이터 경로 오류: {err}"),
        Lang::En => format!("Failed to resolve app data path: {err}"),
    }
}

pub fn stt_temp_dir_create_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("임시 폴더 생성 실패({path}): {err}"),
        Lang::En => format!("Failed to create temp folder ({path}): {err}"),
    }
}

pub fn stt_unsupported_language(code: &str) -> String {
    match lang() {
        Lang::Ko => format!("지원하지 않는 언어 코드: {code}"),
        Lang::En => format!("Unsupported language code: {code}"),
    }
}

pub fn stt_prompt_too_long(max_chars: usize) -> String {
    match lang() {
        Lang::Ko => format!("용어 힌트는 {max_chars}자까지입니다"),
        Lang::En => format!("Vocabulary hints can be at most {max_chars} characters"),
    }
}

pub fn stt_prompt_ascii_only() -> &'static str {
    match lang() {
        Lang::Ko => "Windows에서는 용어 힌트에 영문·숫자만 쓸 수 있습니다 — 음성 인식 엔진이 명령줄의 한글을 깨뜨립니다",
        Lang::En => {
            "On Windows, vocabulary hints can only use English letters and digits — \
             the speech recognition engine garbles non-ASCII text on the command line"
        }
    }
}

pub fn stt_path_not_ascii(path: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("음성 인식 파일 경로가 앱 데이터 폴더 밖이거나 ASCII가 아닙니다: {path}"),
        Lang::En => format!("Speech recognition file path is outside the app data folder or not ASCII: {path}"),
    }
}

pub fn stt_process_spawn_failed(what: &str, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{what} 실행 실패: {err}"),
        Lang::En => format!("Failed to run {what}: {err}"),
    }
}

pub fn stt_process_wait_failed(what: &str, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("{what} 종료 대기 실패: {err}"),
        Lang::En => format!("Failed waiting for {what} to exit: {err}"),
    }
}

pub fn stt_cancelled() -> &'static str {
    match lang() {
        Lang::Ko => "자막 만들기를 취소했습니다",
        Lang::En => "Caption generation cancelled",
    }
}

/// 실패한 단계 이름 — `stt_step_failed`의 `what`(로그에도 같은 이름이 남는다).
pub fn stt_step_speech_recognition() -> &'static str {
    match lang() {
        Lang::Ko => "음성 인식",
        Lang::En => "Speech recognition",
    }
}

pub fn stt_step_audio_extraction() -> &'static str {
    match lang() {
        Lang::Ko => "오디오 추출",
        Lang::En => "Audio extraction",
    }
}

pub fn stt_step_failed(what: &str, detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("{what} 실패: {detail}"),
        Lang::En => format!("{what} failed: {detail}"),
    }
}

pub fn stt_result_read_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("음성 인식 결과 읽기 실패({path}): {err}"),
        Lang::En => format!("Failed to read speech recognition result ({path}): {err}"),
    }
}

pub fn stt_invalid_job_id(job_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("잘못된 작업 id: {job_id}"),
        Lang::En => format!("Invalid job id: {job_id}"),
    }
}

pub fn stt_engine_missing() -> &'static str {
    match lang() {
        Lang::Ko => "음성 인식 엔진이 없습니다 — 설정 › AI › 음성 인식에서 받으세요",
        Lang::En => "Speech recognition engine not installed — download it in Settings › AI › Speech recognition",
    }
}

pub fn stt_engine_check_task_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("엔진 확인 작업 실패: {err}"),
        Lang::En => format!("Engine check task failed: {err}"),
    }
}

pub fn stt_model_missing(label: &str) -> String {
    match lang() {
        Lang::Ko => format!("{label} 모델이 없습니다 — 설정 › AI › 음성 인식에서 받으세요"),
        Lang::En => format!("{label} model not installed — download it in Settings › AI › Speech recognition"),
    }
}

pub fn stt_vad_model_missing() -> &'static str {
    match lang() {
        Lang::Ko => "VAD 모델이 없습니다 — 설정 › AI › 음성 인식에서 엔진을 받으세요",
        Lang::En => "VAD model not installed — download the engine in Settings › AI › Speech recognition",
    }
}

pub fn stt_source_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "원본 파일을 찾을 수 없습니다",
        Lang::En => "Source file not found",
    }
}

pub fn stt_no_audio_track() -> &'static str {
    match lang() {
        Lang::Ko => "오디오 트랙이 없는 파일입니다",
        Lang::En => "This file has no audio track",
    }
}

/// `track`은 1부터 센 번호.
pub fn stt_audio_track_missing(track: u32, count: usize) -> String {
    match lang() {
        Lang::Ko => format!("오디오 트랙 {track}번이 없습니다 — 이 파일의 오디오 트랙은 {count}개입니다"),
        Lang::En => match count {
            1 => format!("Audio track {track} doesn't exist — this file has 1 audio track"),
            _ => format!("Audio track {track} doesn't exist — this file has {count} audio tracks"),
        },
    }
}

pub fn stt_unknown_duration() -> &'static str {
    match lang() {
        Lang::Ko => "길이를 알 수 없는 파일이라 자막을 만들 수 없습니다",
        Lang::En => "Can't generate captions — the file's duration is unknown",
    }
}

pub fn stt_source_stat_failed(path: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("원본 파일 정보를 읽지 못했습니다: {path}"),
        Lang::En => format!("Failed to read source file info: {path}"),
    }
}

pub fn stt_result_parse_failed(err: &dyn Debug) -> String {
    match lang() {
        Lang::Ko => format!("음성 인식 결과 해석 실패: {err:?}"),
        Lang::En => format!("Failed to parse speech recognition result: {err:?}"),
    }
}

// ── stt/whisper_json.rs — whisper 출력 해석 ─────────────────────────────────

pub fn stt_whisper_json_parse_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("whisper JSON 해석 실패: {err}"),
        Lang::En => format!("Failed to parse whisper JSON: {err}"),
    }
}

// ── stt/doc.rs — 자막 문서 불변식(`caption_doc_invalid`의 detail로 들어간다) ───

pub fn caption_doc_invalid(detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("자막 문서 오류: {detail}"),
        Lang::En => format!("Invalid caption document: {detail}"),
    }
}

pub fn caption_doc_cue_token_missing(cue_id: &str, token_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("cue {cue_id} 가 가리키는 토큰 {token_id} 이 없습니다"),
        Lang::En => format!("Cue {cue_id} points to missing token {token_id}"),
    }
}

pub fn caption_doc_cue_not_contiguous(cue_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("cue {cue_id} 가 앞 cue와 이어지지 않거나 거꾸로입니다"),
        Lang::En => format!("Cue {cue_id} doesn't continue from the previous cue or is reversed"),
    }
}

pub fn caption_doc_cues_incomplete() -> &'static str {
    match lang() {
        Lang::Ko => "cue가 토큰 전체를 덮지 않습니다",
        Lang::En => "Cues don't cover all tokens",
    }
}

pub fn caption_doc_word_empty(token_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("단어 {token_id} 의 텍스트가 비었습니다"),
        Lang::En => format!("Word {token_id} has empty text"),
    }
}

pub fn caption_doc_token_time_out_of_range(token_id: &str, start_ms: u64, end_ms: u64) -> String {
    match lang() {
        Lang::Ko => format!("토큰 {token_id} 의 시각({start_ms}~{end_ms}ms)이 범위를 벗어났습니다"),
        Lang::En => format!("Token {token_id} time ({start_ms}–{end_ms} ms) is out of range"),
    }
}

pub fn caption_doc_token_overlap(token_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("토큰 {token_id} 이 앞 토큰과 겹치거나 순서가 어긋났습니다"),
        Lang::En => format!("Token {token_id} overlaps the previous token or is out of order"),
    }
}

pub fn caption_doc_duplicate_token_id(token_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("토큰 id {token_id} 가 중복됐습니다"),
        Lang::En => format!("Duplicate token id {token_id}"),
    }
}

pub fn caption_doc_duplicate_cue_id(cue_id: &str) -> String {
    match lang() {
        Lang::Ko => format!("cue id {cue_id} 가 중복됐습니다"),
        Lang::En => format!("Duplicate cue id {cue_id}"),
    }
}

// ── stt/store.rs — 자막 문서 저장소 ─────────────────────────────────────────

pub fn caption_doc_newer_version(path: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("새 버전 앱에서 만든 자막 문서라 이 앱은 읽기만 합니다 — 앱을 업데이트하세요({path})"),
        Lang::En => format!(
            "This caption document was made by a newer version of the app, so it is read-only here — update the app ({path})"
        ),
    }
}

pub fn caption_doc_read_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("자막 문서 읽기 실패({path}): {err}"),
        Lang::En => format!("Failed to read caption document ({path}): {err}"),
    }
}

pub fn caption_doc_corrupt_retranscribe(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("자막 문서가 손상됐습니다({path}): {err} — 다시 인식하면 새로 만듭니다"),
        Lang::En => format!("Caption document is corrupted ({path}): {err} — re-transcribe to create a new one"),
    }
}

pub fn caption_doc_corrupt(path: &dyn Display, detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("자막 문서가 손상됐습니다({path}): {detail}"),
        Lang::En => format!("Caption document is corrupted ({path}): {detail}"),
    }
}

pub fn caption_doc_serialize_failed(err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("자막 문서 직렬화 실패: {err}"),
        Lang::En => format!("Failed to serialize caption document: {err}"),
    }
}

pub fn caption_doc_save_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("자막 문서 저장 실패({path}): {err}"),
        Lang::En => format!("Failed to save caption document ({path}): {err}"),
    }
}

pub fn caption_doc_conflict(saved_rev: u64, base_rev: u64) -> String {
    match lang() {
        Lang::Ko => format!("다른 창에서 자막 문서가 바뀌었습니다(저장본 {saved_rev}, 편집 기준 {base_rev}) — 다시 불러오세요"),
        Lang::En => format!(
            "The caption document was changed in another window (saved rev {saved_rev}, editing rev {base_rev}) — reload it"
        ),
    }
}

pub fn caption_doc_backup_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("직전 자막 문서 보관 실패({path}): {err}"),
        Lang::En => format!("Failed to back up the previous caption document ({path}): {err}"),
    }
}

pub fn caption_app_data_dir_not_found() -> &'static str {
    match lang() {
        Lang::Ko => "앱 데이터 폴더를 찾을 수 없습니다",
        Lang::En => "App data folder not found",
    }
}

pub fn caption_doc_missing() -> &'static str {
    match lang() {
        Lang::Ko => "이 영상의 자막 문서가 없습니다 — 먼저 자막을 만드세요",
        Lang::En => "This video has no caption document — generate captions first",
    }
}

pub fn caption_cut_approx_word_timing() -> &'static str {
    match lang() {
        Lang::Ko => "단어 시각이 근사값인 자막이라(인식 엔진이 단어 시각을 주지 않았다) 편집본을 만들 수 없습니다",
        Lang::En => {
            "Can't create a transcript edit — these captions have approximate word timings \
             (the recognition engine didn't provide word timings)"
        }
    }
}

pub fn caption_cut_source_changed() -> &'static str {
    match lang() {
        Lang::Ko => "자막을 만든 뒤 원본 영상이 바뀌어 컷 위치가 어긋날 수 있습니다 — 다시 인식한 뒤 내보내세요",
        Lang::En => {
            "The source video changed after the captions were made, so cut positions may be off — \
             re-transcribe, then export"
        }
    }
}

pub fn caption_cut_nothing_left() -> &'static str {
    match lang() {
        Lang::Ko => "남는 구간이 없습니다 — 대본이 전부 잘렸습니다",
        Lang::En => "Nothing left to keep — the whole transcript is cut",
    }
}

// ── stt/subs.rs · stt/video_subs.rs — 자막 파일·자막 입힌 영상 내보내기 ───────

pub fn caption_translation_lang_missing() -> &'static str {
    match lang() {
        Lang::Ko => "번역 자막의 언어가 지정되지 않았습니다",
        Lang::En => "No language specified for translated captions",
    }
}

pub fn caption_translation_missing(lang_code: &str) -> String {
    match lang() {
        Lang::Ko => format!("{lang_code} 번역이 없습니다 — 먼저 번역하세요"),
        Lang::En => format!("No {lang_code} translation — translate first"),
    }
}

pub fn caption_translation_incomplete(lang_code: &str, missing: usize) -> String {
    match lang() {
        Lang::Ko => format!("{lang_code} 번역이 끝나지 않았습니다 — 자막 {missing}줄에 번역이 없습니다"),
        Lang::En => match missing {
            1 => format!("The {lang_code} translation is incomplete — 1 caption line has no translation"),
            _ => format!("The {lang_code} translation is incomplete — {missing} caption lines have no translation"),
        },
    }
}

pub fn caption_export_error(detail: &str) -> String {
    match lang() {
        Lang::Ko => format!("자막 내보내기 오류: {detail}"),
        Lang::En => format!("Caption export error: {detail}"),
    }
}

pub fn caption_export_wrong_extension(want: &str) -> String {
    match lang() {
        Lang::Ko => format!("파일 확장자가 .{want}여야 합니다"),
        Lang::En => format!("File extension must be .{want}"),
    }
}

pub fn caption_export_file_exists(rel: &str) -> String {
    match lang() {
        Lang::Ko => format!("{rel} 파일이 이미 있습니다"),
        Lang::En => format!("{rel} already exists"),
    }
}

pub fn caption_file_write_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("자막 파일 쓰기 실패({path}): {err}"),
        Lang::En => format!("Failed to write caption file ({path}): {err}"),
    }
}

pub fn caption_export_no_cues() -> &'static str {
    match lang() {
        Lang::Ko => "내보낼 자막이 없습니다 — 구간 안에 자막이 없거나 자막 줄이 전부 비었습니다",
        Lang::En => "No captions to export — there are none in the range, or every caption line is empty",
    }
}

pub fn caption_burn_temp_dir_failed(path: &dyn Display, err: &dyn Display) -> String {
    match lang() {
        Lang::Ko => format!("자막 임시 폴더 생성 실패({path}): {err}"),
        Lang::En => format!("Failed to create caption temp folder ({path}): {err}"),
    }
}
