// 자막 파일 가져오기(SRT/VTT → CaptionDoc). 다른 도구가 만든 자막을 대본 패널에서 고치고·번역하고·영상에 입히는
// 길이다. 어절 시각이 없으니(cue 시각뿐) 어절은 cue 안에 글자 수 비례로 늘어놓고 `WordTiming::Approx`로 둔다 —
// 대본 컷 편집(P2)은 근사 시각을 거절하므로 가져온 자막으로는 영상을 자르지 않는다.
//
// 파서는 관대하게 읽는다(인덱스 줄 생략, `.` 밀리초, 시 생략, cue 사이 빈 줄 없음, VTT cue 설정·태그 — FilmCraft
// captions 크레이트의 읽기 규칙을 참고했다). 다만 **인코딩은 추측해 깨뜨리지 않는다**: text/encoding.rs로 판정하고,
// 어떤 인코딩으로도 깨끗이 못 읽으면 거절한다(lossy 금지 — 깨진 글자가 문서에 저장된다).

use std::path::Path;

use tauri::{AppHandle, State};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::state::AppState;
use crate::stt::doc::{build_doc, strip_invisible, DocEngine, DocSource, SttWord, WordTiming};
use crate::stt::store::{self, CaptionLoaded};

/// 이보다 큰 자막 파일은 자막이 아니다(10시간 분량 SRT ≈ 1MB).
const MAX_SUBS_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct ImportedCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// `[hh:]mm:ss[,.]f…` → ms. 소수는 3자리로 자르거나 채운다("1.5" = 500ms).
fn parse_sub_time(s: &str) -> Option<u64> {
    let (clock, frac) = match s.find([',', '.']) {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    if !(2..=3).contains(&parts.len()) || !parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let nums: Vec<u64> = parts.iter().map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let (h, m, sec) = if nums.len() == 3 { (nums[0], nums[1], nums[2]) } else { (0, nums[0], nums[1]) };
    let ms = frac.bytes().chain(std::iter::repeat(b'0')).take(3).fold(0u64, |a, b| a * 10 + u64::from(b - b'0'));
    Some(((h * 60 + m) * 60 + sec) * 1000 + ms)
}

/// `00:00:01,000 --> 00:00:02,500 [VTT 설정…]` → (시작, 끝).
fn parse_timing_line(line: &str) -> Option<(u64, u64)> {
    let (a, b) = line.split_once("-->")?;
    let end = b.split_whitespace().next()?;
    Some((parse_sub_time(a.trim())?, parse_sub_time(end)?))
}

/// VTT `<v 화자>`·`<i>`·`<00:00:01.000>`, SRT `<font …>`·`{\an8}` 같은 꾸밈을 걷고 VTT 엔티티를 푼다.
fn clean_cue_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut skip_to: Option<char> = None;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match (skip_to, c) {
            (None, '<') => skip_to = Some('>'),
            // `{`는 ASS 꾸밈(`{\an8}`)일 때만 — 본문의 중괄호는 글자다.
            (None, '{') if it.peek() == Some(&'\\') => skip_to = Some('}'),
            (Some(close), c) if c == close => skip_to = None,
            (Some(_), _) => {}
            (None, c) => out.push(c),
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&lrm;", "")
        .replace("&rlm;", "")
        .replace("&amp;", "&");
    strip_invisible(&out)
}

/// SRT·VTT 본문 → cue 목록(시각 순). 시각 줄(`-->`)을 기준으로 읽으므로 VTT 머리(WEBVTT)·NOTE·STYLE 블록과 SRT 인덱스
/// 줄은 저절로 빠진다. 빈 cue·끝이 시작보다 이른 cue는 버린다.
pub fn parse_subtitle_text(text: &str) -> Vec<ImportedCue> {
    let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
    let mut cues = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some((start_ms, end_ms)) = parse_timing_line(lines[i]) else {
            i += 1;
            continue;
        };
        i += 1;
        let mut body: Vec<&str> = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() && parse_timing_line(lines[i]).is_none() {
            // 빈 줄 없이 붙은 다음 cue의 인덱스 줄("12" 바로 뒤가 시각 줄)은 본문이 아니다.
            let is_index = lines[i].trim().bytes().all(|b| b.is_ascii_digit())
                && lines.get(i + 1).is_some_and(|n| parse_timing_line(n).is_some());
            if is_index {
                break;
            }
            body.push(lines[i]);
            i += 1;
        }
        let text = clean_cue_text(&body.join("\n"));
        if end_ms > start_ms && !text.trim().is_empty() {
            cues.push(ImportedCue { start_ms, end_ms, text });
        }
    }
    cues.sort_by_key(|c| c.start_ms);
    cues
}

/// cue → 어절(공백 단위). cue 시간을 글자 수 비례로 나눈다. `segment` = cue 번호라 build_doc이 cue 경계를 지킨다
/// (한 cue가 두 줄 한도를 넘을 때만 build_doc이 더 쪼갠다).
pub fn imported_words(cues: &[ImportedCue]) -> Vec<SttWord> {
    let mut words = Vec::new();
    for (ci, c) in cues.iter().enumerate() {
        let parts: Vec<&str> = c.text.split_whitespace().collect();
        let total: u64 = parts.iter().map(|p| p.chars().count() as u64).sum::<u64>().max(1);
        let span = c.end_ms - c.start_ms;
        let mut acc = 0u64;
        for p in parts {
            let s = c.start_ms + span * acc / total;
            acc += p.chars().count() as u64;
            let e = c.start_ms + span * acc / total;
            words.push(SttWord { start_ms: s, end_ms: e, text: p.to_string(), p: None, invalid_utf8: false, segment: ci });
        }
    }
    words
}

/// 줄 길이(doc_line_chars)와 번역 기본 대상에만 쓰는 대략의 언어 — 한글·가나·한자, 그리고 라틴 문자가 대부분이면
/// "en"(띄어 쓰는 언어의 줄 폭 42를 받으려고 — 모르면 16자라 영어 cue가 잘게 쪼개진다). 그 밖은 모른다(None).
fn guess_caption_language(cues: &[ImportedCue]) -> Option<String> {
    let (mut hangul, mut kana, mut han, mut latin, mut other) = (0usize, 0usize, 0usize, 0usize, 0usize);
    for c in cues.iter().flat_map(|c| c.text.chars()) {
        match c {
            '\u{AC00}'..='\u{D7A3}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' => hangul += 1,
            '\u{3040}'..='\u{30FF}' => kana += 1,
            '\u{4E00}'..='\u{9FFF}' => han += 1,
            c if c.is_ascii_alphabetic() => latin += 1,
            c if c.is_alphabetic() => other += 1,
            _ => {}
        }
    }
    let lang = if hangul > 0 && hangul >= kana {
        "ko"
    } else if kana > 0 {
        "ja"
    } else if han > 0 {
        "zh"
    } else if latin > other * 4 {
        "en"
    } else {
        return None;
    };
    Some(lang.to_string())
}

fn subs_format_of(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "srt" => Some("srt"),
        "vtt" => Some("vtt"),
        _ => None,
    }
}

/// 자막 파일 바이트 → cue 목록(순수 코어 — 인코딩 판정 포함).
pub fn decode_subtitle_file(bytes: &[u8], path: &Path) -> Result<Vec<ImportedCue>, IpcError> {
    let decoded = crate::text::encoding::decode(bytes);
    if decoded.lossy {
        return Err(IpcError::new(ErrorCode::Io, text_stt::caption_import_undecodable(&path.display())));
    }
    let cues = parse_subtitle_text(&decoded.text);
    if cues.is_empty() {
        return Err(IpcError::new(ErrorCode::Io, text_stt::caption_import_no_cues(&path.display())));
    }
    Ok(cues)
}

/// 영상 `rel_path`의 자막 문서를 자막 파일 `sub_path`(사용자가 파일 대화상자로 고른 절대 경로 — 읽기만 한다)로
/// 만든다. 재전사와 같이 직전 문서는 `.bak` 한 세대로 남는다(store::write_transcribed).
#[tauri::command(async)]
pub async fn caption_import_subs(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    sub_path: String,
) -> Result<CaptionLoaded, IpcError> {
    let sub = Path::new(&sub_path);
    let format = subs_format_of(sub)
        .ok_or_else(|| IpcError::new(ErrorCode::Io, text_stt::caption_import_bad_ext(&sub.display())))?;
    let len = std::fs::metadata(sub)
        .map_err(|e| IpcError::new(ErrorCode::NotFound, text_stt::caption_import_read_failed(&sub.display(), &e)))?
        .len();
    if len > MAX_SUBS_BYTES {
        return Err(IpcError::new(ErrorCode::Io, text_stt::caption_import_too_large(&sub.display())));
    }
    let bytes = std::fs::read(sub)
        .map_err(|e| IpcError::new(ErrorCode::Io, text_stt::caption_import_read_failed(&sub.display(), &e)))?;
    let cues = decode_subtitle_file(&bytes, sub)?;

    let ff = crate::commands::find_ffmpeg(&app, state.inner())?;
    let probe = crate::commands::need_probe(&ff)?;
    let repo = crate::commands::project_path(&state, &project_id)?;
    let src = crate::commands::resolve_in_repo(&repo, &rel_path)?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, text_stt::stt_source_not_found()));
    }
    let meta = crate::commands::probe_meta(&probe, &src.display().to_string()).await?;
    if meta.duration_ms == 0 {
        return Err(IpcError::new(ErrorCode::Io, text_stt::stt_unknown_duration()));
    }
    let (size_bytes, mtime_ms) = store::file_stamp(&src)
        .ok_or_else(|| IpcError::new(ErrorCode::Io, text_stt::stt_source_stat_failed(&src.display())))?;

    let doc = build_doc(
        DocSource {
            rel: store::normalize_rel(&rel_path),
            size_bytes,
            mtime_ms,
            duration_ms: meta.duration_ms,
            start_time_ms: meta.start_time_ms,
            audio_stream: 0,
        },
        DocEngine {
            name: "import".into(),
            build: format.into(),
            model_id: String::new(),
            language: "auto".into(),
            detected_language: guess_caption_language(&cues),
            vad: false,
            prompt: None,
            word_timing: WordTiming::Approx,
        },
        imported_words(&cues),
    );
    let loaded = store::write_transcribed(&app, &project_id, &rel_path, doc)?;
    log::info!(
        "[stt] 자막 가져오기 {} → {rel_path} cues={} ({format})", // i18n-ok: 로그
        sub.display(),
        loaded.doc.cues.len(),
    );
    Ok(loaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::tests::source;

    #[test]
    fn sub_times_accept_common_spellings() {
        assert_eq!(parse_sub_time("00:01:02,345"), Some(62_345));
        assert_eq!(parse_sub_time("00:01:02.345"), Some(62_345));
        assert_eq!(parse_sub_time("01:02.5"), Some(62_500), "시 생략 · 소수 한 자리");
        assert_eq!(parse_sub_time("1:00:00"), Some(3_600_000), "소수 없음");
        assert_eq!(parse_sub_time("00:00:01,23456"), Some(1_234), "넷째 자리부터 버림");
        for bad in ["", "12", "aa:bb", "00:00:01,x", "00::01"] {
            assert_eq!(parse_sub_time(bad), None, "{bad}");
        }
    }

    /// 인덱스 생략·빈 줄 없는 cue·CRLF·여러 줄 본문·꾸밈 태그.
    #[test]
    fn srt_is_read_leniently() {
        let srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>안녕하세요</i>\r\n여러분\r\n\r\n\
                   00:00:03.000 --> 00:00:04.000\r\n{\\an8}둘째\r\n3\r\n00:00:05,000 --> 00:00:06,000\r\n셋째\r\n";
        assert_eq!(
            parse_subtitle_text(srt),
            vec![
                ImportedCue { start_ms: 1000, end_ms: 2500, text: "안녕하세요\n여러분".into() },
                ImportedCue { start_ms: 3000, end_ms: 4000, text: "둘째".into() },
                ImportedCue { start_ms: 5000, end_ms: 6000, text: "셋째".into() },
            ]
        );
    }

    /// VTT 머리·NOTE·STYLE·cue id·cue 설정·화자 태그·엔티티. 빈 cue와 역전 cue는 버린다.
    #[test]
    fn vtt_header_notes_and_settings_are_skipped() {
        let vtt = "WEBVTT - 제목\n\nNOTE 메모 --- 무시\n\nSTYLE\n::cue { color: red }\n\nintro\n\
                   00:01.000 --> 00:02.000 align:start position:10%\n<v 철수>Tom &amp; Jerry &lt;3\n\n\
                   00:03.000 --> 00:04.000\n\n00:06.000 --> 00:05.000\n거꾸로\n";
        assert_eq!(
            parse_subtitle_text(vtt),
            vec![ImportedCue { start_ms: 1000, end_ms: 2000, text: "Tom & Jerry <3".into() }]
        );
    }

    /// 어절 시각은 cue 안 글자 수 비례, cue마다 세그먼트가 갈려 build_doc이 cue 경계를 지킨다. 근사 시각이다.
    #[test]
    fn imported_cues_become_a_doc_with_cue_boundaries() {
        let cues = vec![
            ImportedCue { start_ms: 1000, end_ms: 2000, text: "가나 다".into() },
            ImportedCue { start_ms: 3000, end_ms: 3600, text: "라".into() },
        ];
        let words = imported_words(&cues);
        let got: Vec<(u64, u64, &str, usize)> =
            words.iter().map(|w| (w.start_ms, w.end_ms, w.text.as_str(), w.segment)).collect();
        assert_eq!(got, vec![(1000, 1666, "가나", 0), (1666, 2000, "다", 0), (3000, 3600, "라", 1)]);

        let engine = DocEngine {
            name: "import".into(),
            build: "srt".into(),
            model_id: String::new(),
            language: "auto".into(),
            detected_language: guess_caption_language(&cues),
            vad: false,
            prompt: None,
            word_timing: WordTiming::Approx,
        };
        assert_eq!(engine.detected_language.as_deref(), Some("ko"));
        let mut doc = build_doc(source(5000), engine, words);
        crate::stt::doc::validate_doc(&mut doc).unwrap();
        assert_eq!(doc.cues.len(), 2, "cue 하나 = 문서 cue 하나");
    }

    /// 어떤 인코딩으로도 못 읽는 바이트는 깨진 글자로 저장하지 않고 거절한다. CP949 한글 자막은 제대로 읽는다.
    #[test]
    fn subtitle_file_decoding_follows_encoding_contract() {
        let p = Path::new("a.srt");
        let (cp949, _, _) = encoding_rs::EUC_KR.encode("1\n00:00:01,000 --> 00:00:02,000\n안녕하세요 반갑습니다\n");
        let cues = decode_subtitle_file(&cp949, p).unwrap();
        assert_eq!(cues[0].text, "안녕하세요 반갑습니다");
        assert!(decode_subtitle_file(b"WEBVTT\n\nNOTE only\n", p).is_err(), "cue 없음");
        let one = |t: &str| guess_caption_language(&[ImportedCue { start_ms: 0, end_ms: 1, text: t.into() }]);
        assert_eq!(one("hello there").as_deref(), Some("en"));
        assert_eq!(one("Привет мир"), None);
        assert_eq!(one("123 !!"), None);
        assert_eq!(subs_format_of(Path::new("x.SRT")), Some("srt"));
        assert_eq!(subs_format_of(Path::new("x.ass")), None);
    }
}
