// 자막 파일 작성기(태스크 72 §3.6) — SRT/VTT/TXT는 순수 함수, 레포 쓰기는 `caption_export_subs` 한 곳.
// 금지 문자(제어·폭 없는·방향 제어)는 작성 직전에 한 번 더 지운다 — Premiere는 보이지 않는 문자 하나에
// 그 뒤 자막을 통째로 못 읽는다(§2.3).

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::state::AppState;
use crate::stt::doc::{cue_spans, cue_text, strip_invisible, CaptionDoc, TokenKind};
use crate::stt::plan::{caption_plan, OutCue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubFormat {
    Srt,
    Vtt,
    Txt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubTimeline {
    /// 원본 영상 시각(컷된 어절도 들어간다 — 원본에는 그 소리가 있다).
    Source,
    /// 편집본 시각(`caption_plan`의 outCues).
    Edited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubText {
    Caption,
    /// 번역(`doc.translations[lang]`, P4).
    Translation,
    /// 원문 아래 번역 2단.
    Both,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubExportSpec {
    pub format: SubFormat,
    pub timeline: SubTimeline,
    pub text: SubText,
    #[serde(default)]
    pub lang: Option<String>,
    pub out_rel: String,
    pub overwrite: bool,
}

fn ext_of(f: SubFormat) -> &'static str {
    match f {
        SubFormat::Srt => "srt",
        SubFormat::Vtt => "vtt",
        SubFormat::Txt => "txt",
    }
}

/// 원본 시각 cue — cue 안 모든 어절의 첫 시작~마지막 끝, 텍스트는 override 또는 어절 전부.
pub fn source_cues(doc: &CaptionDoc) -> Result<Vec<OutCue>, IpcError> {
    let spans = cue_spans(doc)?;
    let mut out = Vec::with_capacity(doc.cues.len());
    for (cue, &(a, b)) in doc.cues.iter().zip(&spans) {
        let mut words = doc.tokens[a..=b].iter().filter(|t| t.kind == TokenKind::Word);
        let Some(first) = words.next() else { continue };
        let last = words.last().unwrap_or(first);
        out.push(OutCue {
            cue_id: cue.id.clone(),
            start_ms: first.start_ms,
            end_ms: last.end_ms,
            text: cue_text(doc, cue, (a, b), true),
        });
    }
    Ok(out)
}

/// 자막 줄 고르기 — 원문 · 번역 · 원문 아래 번역 2단(`원문\n번역`). 번역은 cue id로 다시 붙인다(시각은 LLM을
/// 거치지 않는다, §3.7). 내보낼 cue 중 하나라도 번역이 없으면 거절한다 — 원문으로 채우거나 빼면 번역 자막이
/// 군데군데 원문이거나 비어서 나간다.
pub fn select_sub_text(
    doc: &CaptionDoc,
    cues: Vec<OutCue>,
    text: SubText,
    lang: Option<&str>,
) -> Result<Vec<OutCue>, IpcError> {
    if text == SubText::Caption {
        return Ok(cues);
    }
    let bad = |m: String| IpcError::new(ErrorCode::Io, m);
    let lang = lang.ok_or_else(|| bad(text_stt::caption_translation_lang_missing().into()))?;
    let map = doc
        .translations
        .as_ref()
        .and_then(|t| t.get(lang))
        .ok_or_else(|| bad(text_stt::caption_translation_missing(lang)))?;
    let mut out = Vec::with_capacity(cues.len());
    let mut missing = 0usize;
    for c in cues {
        match map.get(&c.cue_id).map(|t| t.trim()).filter(|t| !t.is_empty()) {
            Some(t) if text == SubText::Both => out.push(OutCue { text: format!("{}\n{t}", c.text), ..c }),
            Some(t) => out.push(OutCue { text: t.to_string(), ..c }),
            None => missing += 1,
        }
    }
    if missing > 0 {
        return Err(bad(text_stt::caption_translation_incomplete(lang, missing)));
    }
    Ok(out)
}

/// 작성 직전 정리: 금지 문자 제거 · 빈 줄 제거(SRT·VTT에서 빈 줄은 cue 끝이다) · 빈 cue 생략 ·
/// 시작순 정렬 · 겹치면 앞 cue 끝을 자르고 길이 0이 된 cue는 버린다.
pub(crate) fn normalize_cues(cues: &[OutCue]) -> Vec<OutCue> {
    let mut v: Vec<OutCue> = cues
        .iter()
        .filter_map(|c| {
            let text = strip_invisible(&c.text)
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty() && c.end_ms > c.start_ms).then(|| OutCue { text, ..c.clone() })
        })
        .collect();
    v.sort_by_key(|c| c.start_ms);
    for i in 0..v.len().saturating_sub(1) {
        let next = v[i + 1].start_ms;
        if v[i].end_ms > next {
            v[i].end_ms = next;
        }
    }
    v.retain(|c| c.end_ms > c.start_ms);
    v
}

fn hms(ms: u64) -> (u64, u64, u64, u64) {
    (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000)
}

pub fn fmt_srt_time(ms: u64) -> String {
    let (h, m, s, f) = hms(ms);
    format!("{h:02}:{m:02}:{s:02},{f:03}")
}

pub fn fmt_vtt_time(ms: u64) -> String {
    let (h, m, s, f) = hms(ms);
    format!("{h:02}:{m:02}:{s:02}.{f:03}")
}

/// SRT — `HH:MM:SS,mmm`, CRLF, BOM 없는 UTF-8.
pub fn build_srt(cues: &[OutCue]) -> String {
    let mut s = String::new();
    for (i, c) in normalize_cues(cues).iter().enumerate() {
        s.push_str(&format!(
            "{}\r\n{} --> {}\r\n{}\r\n\r\n",
            i + 1,
            fmt_srt_time(c.start_ms),
            fmt_srt_time(c.end_ms),
            c.text.replace('\n', "\r\n")
        ));
    }
    s
}

/// VTT — `HH:MM:SS.mmm`, LF(관례). 본문의 `&`·`<`·`>`는 태그·엔티티로 읽히므로 이스케이프한다
/// (`-->`도 `&gt;`가 돼 cue 구분자로 오인되지 않는다).
pub fn build_vtt(cues: &[OutCue]) -> String {
    let mut s = String::from("WEBVTT\n\n");
    for c in normalize_cues(cues) {
        let text = c.text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
        s.push_str(&format!("{} --> {}\n{}\n\n", fmt_vtt_time(c.start_ms), fmt_vtt_time(c.end_ms), text));
    }
    s
}

/// TXT — cue 하나가 한 줄(대본 읽기용, 시각 없음).
pub fn build_txt(cues: &[OutCue]) -> String {
    normalize_cues(cues).iter().map(|c| format!("{}\n", c.text.replace('\n', " "))).collect()
}

/// 레포에 SRT/VTT/TXT를 쓴다 — `resolve_in_repo` → 같은 폴더 임시 파일 → rename. 돌려주는 값은 쓴 상대 경로.
#[tauri::command(async)]
pub fn caption_export_subs(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    spec: SubExportSpec,
) -> Result<String, IpcError> {
    let bad = |m: &str| IpcError::new(ErrorCode::Io, text_stt::caption_export_error(m));
    let want = ext_of(spec.format);
    let ext = std::path::Path::new(&spec.out_rel)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if ext.as_deref() != Some(want) {
        return Err(bad(&text_stt::caption_export_wrong_extension(want)));
    }
    let repo = crate::commands::project_path(&state, &project_id)?;
    let out = crate::commands::resolve_in_repo(&repo, &spec.out_rel)?;
    if out.exists() && !spec.overwrite {
        return Err(IpcError::new(ErrorCode::AlreadyExists, text_stt::caption_export_file_exists(&spec.out_rel)));
    }

    let doc = crate::stt::store::load_required(&app, &project_id, &rel_path)?;
    let cues = match spec.timeline {
        SubTimeline::Source => source_cues(&doc)?,
        SubTimeline::Edited => caption_plan(&doc)?.out_cues,
    };
    let cues = select_sub_text(&doc, cues, spec.text, spec.lang.as_deref())?;
    let body = match spec.format {
        SubFormat::Srt => build_srt(&cues),
        SubFormat::Vtt => build_vtt(&cues),
        SubFormat::Txt => build_txt(&cues),
    };

    let tmp = out.with_file_name(format!(".gpv-export-{}.tmp", uuid::Uuid::new_v4().simple()));
    if let Err(e) = std::fs::write(&tmp, body.as_bytes()) {
        std::fs::remove_file(&tmp).ok(); // 반쯤 쓴 임시 파일 — 정리 실패는 원래 오류를 가리지 않는다
        return Err(IpcError::new(ErrorCode::Io, text_stt::caption_file_write_failed(&tmp.display(), &e)));
    }
    crate::commands::commit_tmp_output(&tmp, &out)?;
    Ok(spec.out_rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::build_doc;
    use crate::stt::doc::tests::{engine, source, w};

    fn cue(id: &str, s: u64, e: u64, text: &str) -> OutCue {
        OutCue { cue_id: id.into(), start_ms: s, end_ms: e, text: text.into() }
    }

    /// 59.999초·1시간 이상 경계.
    #[test]
    fn subs_time_formats() {
        assert_eq!(fmt_srt_time(59_999), "00:00:59,999");
        assert_eq!(fmt_srt_time(60_000), "00:01:00,000");
        assert_eq!(fmt_srt_time(3_600_000), "01:00:00,000");
        assert_eq!(fmt_vtt_time(3_599_999), "00:59:59.999");
        assert_eq!(fmt_vtt_time(36_000_000 + 61_001), "10:01:01.001");
    }

    #[test]
    fn subs_srt_is_crlf_numbered_and_clean() {
        let srt = build_srt(&[
            cue("c2", 2000, 3000, "둘째"),
            cue("c1", 0, 2500, "첫\u{200B}째 줄\n\n두 번째\u{202E} 줄"), // 겹침 + 금지 문자 + 빈 줄
            cue("c3", 3000, 3000, "길이 0"),
            cue("c4", 4000, 5000, "\u{FEFF} "), // 비면 생략
        ]);
        assert_eq!(
            srt,
            "1\r\n00:00:00,000 --> 00:00:02,000\r\n첫째 줄\r\n두 번째 줄\r\n\r\n\
             2\r\n00:00:02,000 --> 00:00:03,000\r\n둘째\r\n\r\n"
        );
        assert!(!srt.starts_with('\u{FEFF}'), "BOM 없음");
    }

    #[test]
    fn subs_vtt_and_txt() {
        let cues = [cue("c1", 1000, 2000, "a < b & c --> d\n둘째")];
        assert_eq!(build_vtt(&cues), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\na &lt; b &amp; c --&gt; d\n둘째\n\n");
        assert_eq!(build_txt(&cues), "a < b & c --> d 둘째\n");
    }

    /// 번역·2단은 cue id로 다시 붙인다(시각은 원문 그대로). 빈 번역은 없는 것과 같고, 내보낼 줄에 하나라도 없으면
    /// 원문으로 채우지 않고 거절 — 단 편집본에서 빠지는(전부 잘린) cue의 번역은 없어도 된다.
    #[test]
    fn subs_translation_and_both_select_by_cue_id() {
        use std::collections::BTreeMap;
        let mut d = build_doc(source(6000), engine("ko"), vec![w(500, 900, "안녕", 0), w(3000, 3500, "하세요", 1)]);
        let ids: Vec<String> = d.cues.iter().map(|c| c.id.clone()).collect();
        assert_eq!(ids.len(), 2);
        let en = BTreeMap::from([(ids[0].clone(), "Hello".to_string()), (ids[1].clone(), " \n ".to_string())]);
        d.translations = Some(BTreeMap::from([("en".to_string(), en)]));
        let src = source_cues(&d).unwrap();

        let e = select_sub_text(&d, src.clone(), SubText::Translation, Some("en")).unwrap_err();
        assert!(e.message.contains("1줄"), "빈 번역은 없는 것 — {}", e.message);
        assert!(select_sub_text(&d, src.clone(), SubText::Both, None).is_err(), "언어 없음");
        assert!(select_sub_text(&d, src.clone(), SubText::Translation, Some("ja")).is_err(), "번역 없는 언어");
        assert_eq!(select_sub_text(&d, src.clone(), SubText::Caption, None).unwrap(), src, "원문은 번역과 무관");

        d.translations.as_mut().unwrap().get_mut("en").unwrap().insert(ids[1].clone(), "there".into());
        let tr = select_sub_text(&d, src.clone(), SubText::Translation, Some("en")).unwrap();
        let got: Vec<(&str, u64, u64)> = tr.iter().map(|c| (c.text.as_str(), c.start_ms, c.end_ms)).collect();
        assert_eq!(got, vec![("Hello", 500, 900), ("there", 3000, 3500)]);
        let both = select_sub_text(&d, src, SubText::Both, Some("en")).unwrap();
        assert_eq!(both[0].text, "안녕\nHello");
        assert!(build_srt(&both).contains("안녕\r\nHello\r\n"), "2단은 SRT에서 두 줄");

        d.translations.as_mut().unwrap().get_mut("en").unwrap().remove(&ids[0]);
        d.tokens.iter_mut().find(|t| t.text == "안녕").unwrap().cut = true;
        let edited = select_sub_text(&d, caption_plan(&d).unwrap().out_cues, SubText::Translation, Some("en")).unwrap();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].text, "there");
        assert!(select_sub_text(&d, source_cues(&d).unwrap(), SubText::Translation, Some("en")).is_err(), "원본 시각엔 그 cue가 있다");
    }

    /// 원본 시각 자막은 컷된 어절도 넣는다(원본에는 소리가 있다) — 편집본(plan)은 뺀다.
    #[test]
    fn subs_source_includes_cut_words_edited_does_not() {
        let mut d = build_doc(source(4000), engine("ko"), vec![w(500, 900, "하나", 0), w(1000, 1400, "둘", 0)]);
        d.tokens.iter_mut().find(|t| t.text == "둘").unwrap().cut = true;
        let src = source_cues(&d).unwrap();
        assert_eq!((src[0].start_ms, src[0].end_ms, src[0].text.as_str()), (500, 1400, "하나 둘"));
        let edited = caption_plan(&d).unwrap().out_cues;
        assert_eq!(edited[0].text, "하나");
        assert!(build_srt(&edited).contains("하나\r\n"));
        assert!(!build_srt(&edited).contains('둘'), "잘린 어절이 편집본 SRT에 남았다");
    }
}
