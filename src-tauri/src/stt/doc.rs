// 비파괴 자막 문서 `CaptionDoc` v1(태스크 72 §3.3). **Rust가 원본**이고 TS 타입(`src/lib/ipc.ts`
// CaptionDoc·Token·Cue)은 같은 작업에서 맞춘다 — 어긋나도 양쪽 컴파일은 통과하고 런타임에 undefined로만 드러난다.
//
// 영상 줄 = `tokens`(cut만 영상에 영향), 자막 줄 = `cue.caption`(표시만). 시각은 전부 정수 ms,
// ffmpeg 디코드 기준(start_time 상대) — 플레이어 경계 한 곳에서만 start_time을 더한다(§3.5).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::stt::video_subs::CaptionStylePreset;

pub const DOC_VERSION: u32 = 1;
/// 이웃 단어 사이가 이만큼 벌어지면 gap 토큰(Vrew `…`)을 둔다. 파일 머리·꼬리는 길이와 무관하게 둔다.
const GAP_MIN_MS: u64 = 300;
/// cue 분할점 2순위 — 문장부호가 없을 때 이만큼 쉰 곳에서 자른다.
const SPLIT_GAP_MS: u64 = 700;
/// Netflix 이벤트 최대 길이(§2.3).
const MAX_CUE_MS: u64 = 7_000;
const MAX_LINES: usize = 2;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocSource {
    pub rel: String,
    pub size_bytes: u64,
    /// 0 = 파일 시스템이 수정 시각을 주지 않음(그때는 크기만으로 stale을 가른다).
    pub mtime_ms: u64,
    pub duration_ms: u64,
    pub start_time_ms: i64,
    pub audio_stream: u32,
}

/// 단어 시각의 출처. `Approx`면 컷 편집(P2)에 쓰기엔 부정확하다 — whisper가 VAD 대응표(stderr)를 안 찍었거나
/// DTW가 꺼진 비관리 바이너리일 때다(부록 B.1: DTW 아닌 토큰 시각은 한국어에서 0.4~1.0초 이르다).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WordTiming {
    Dtw,
    Approx,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocEngine {
    pub name: String,
    pub build: String,
    pub model_id: String,
    /// 요청한 언어("auto" | "ko" | …).
    pub language: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detected_language: Option<String>,
    pub vad: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub word_timing: WordTiming,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TokenKind {
    Word,
    Gap,
}

/// TS에서는 `kind`로 갈리는 유니온이다 — gap은 `text`·`p`가 직렬화되지 않는다(빈 값 생략).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub id: String,
    pub kind: TokenKind,
    pub start_ms: u64,
    pub end_ms: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p: Option<f32>,
    #[serde(default)]
    pub cut: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Suspect {
    Repeat,
    InvalidUtf8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub id: String,
    pub first_token_id: String,
    pub last_token_id: String,
    /// 자막 줄 override(Correct). 없으면 남은 word를 이어 붙인다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspect: Option<Suspect>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionDoc {
    pub version: u32,
    /// 저장마다 +1 — 낙관적 동시성(store.rs).
    pub rev: u64,
    pub source: DocSource,
    pub engine: DocEngine,
    pub tokens: Vec<Token>,
    pub cues: Vec<Cue>,
    /// P2 무음 줄이기 전역 목표. 필드 삭제 = 복구.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_keep_ms: Option<u64>,
    /// 무음 줄이기 조건 — 이보다 긴 쉼만 줄인다("X초 초과 → Y초로"의 X). 없으면 목표 길이가 곧 조건.
    /// 목표 하나로는 "1.0초 넘는 쉼만 0.6초로"를 못 적는다 — 0.6~1.0초 쉼까지 같이 줄어든다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silence_min_ms: Option<u64>,
    /// P4: lang → cueId → text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translations: Option<BTreeMap<String, BTreeMap<String, String>>>,
    /// P4: lang → cueId → 번역할 때 원문의 해시(프론트 `captionTranslationSrc`). 원문을 고친 cue의 번역을 프론트가
    /// "원문이 바뀜"으로 표시하는 데만 쓴다 — 백엔드는 읽지 않는다. 여기 선언이 없으면 serde가 저장 때 버린다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation_src: Option<BTreeMap<String, BTreeMap<String, String>>>,
    /// P3 자막 스타일 — 미리보기 오버레이와 번인 기본값. 없으면 basic. 백엔드는 읽지 않는다(번인은
    /// `CaptionSubs.preset`으로 받는다) — 영상마다 기억할 자리로 문서를 쓴다(설계 9절 76).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_preset: Option<CaptionStylePreset>,
}

/// whisper 출력에서 만든 어절 하나(whisper_json.rs → build_doc). `segment`는 whisper 세그먼트 번호 —
/// 초기 cue는 세그먼트 경계를 넘지 않는다.
#[derive(Debug, Clone, PartialEq)]
pub struct SttWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub p: Option<f32>,
    /// 깨진 UTF-8을 U+FFFD로 바꿨다 — cue에 suspect로 드러낸다.
    pub invalid_utf8: bool,
    pub segment: usize,
}

// ══════════════════════════ 텍스트 ══════════════════════════

/// 보이지 않는 문자 — SRT에 섞이면 Premiere가 그 뒤 자막을 못 읽는다(Vrew 공지, §2.3).
fn is_invisible(c: char) -> bool {
    (c.is_control() && c != '\n')
        || matches!(
            c,
            '\u{200B}'..='\u{200F}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{2060}'
                | '\u{FEFF}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2066}'..='\u{2069}'
        )
}

/// 제어 문자(`\n` 제외)·폭 없는 문자·방향 제어 제거. 문서 저장 전과 자막 파일 작성 전에 둘 다 건다.
pub fn strip_invisible(s: &str) -> String {
    s.chars().filter(|&c| !is_invisible(c)).collect()
}

/// 한 줄 글자 수 — Netflix 기준 한국어·중국어 16, 일본어 13을 16으로 묶고, 띄어 쓰는 언어는 42(§2.3).
/// 언어를 모르면(auto 미감지) 설계 기본값 16.
pub fn line_chars(lang: &str) -> usize {
    match lang {
        "ko" | "ja" | "zh" | "yue" | "auto" | "" => 16,
        _ => 42,
    }
}

pub fn doc_line_chars(engine: &DocEngine) -> usize {
    line_chars(engine.detected_language.as_deref().unwrap_or(&engine.language))
}

/// 어절을 줄 폭 안으로 채워 넣는다(한 줄보다 긴 어절은 그 한 줄을 넘친다).
pub fn wrap_words<'a>(words: impl IntoIterator<Item = &'a str>, line_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;
    for w in words {
        let n = w.chars().count();
        if n == 0 {
            continue;
        }
        if cur_len > 0 && cur_len + 1 + n > line_chars {
            lines.push(std::mem::take(&mut cur));
            cur_len = 0;
        }
        if cur_len > 0 {
            cur.push(' ');
            cur_len += 1;
        }
        cur.push_str(w);
        cur_len += n;
    }
    if cur_len > 0 {
        lines.push(cur);
    }
    lines
}

// ══════════════════════════ cue 분할 ══════════════════════════

fn cue_fits(words: &[SttWord], r: Range<usize>, line_chars: usize) -> bool {
    if r.is_empty() {
        return true;
    }
    let dur = words[r.end - 1].end_ms.saturating_sub(words[r.start].start_ms);
    dur <= MAX_CUE_MS && wrap_words(words[r].iter().map(|w| w.text.as_str()), line_chars).len() <= MAX_LINES
}

fn ends_clause(text: &str) -> bool {
    text.ends_with(['.', ',', '?', '!', '…', '。', '，', '、', '？', '！', ';', ':'])
}

/// 분할점 k(k 앞에서 자른다): 문장부호 뒤 → 700ms 이상 쉰 곳 → 둘 다 없으면 앞에서부터 들어가는 만큼.
/// 앞의 둘은 가운데에 가장 가까운 후보를 고른다 — 한쪽만 길게 남아 다시 잘리는 일을 줄인다.
fn pick_split(words: &[SttWord], r: Range<usize>, line_chars: usize) -> usize {
    let mid = (words[r.start].start_ms + words[r.end - 1].end_ms) / 2;
    let nearest = |pred: &dyn Fn(usize) -> bool| {
        (r.start + 1..r.end)
            .filter(|&k| pred(k))
            .min_by_key(|&k| words[k].start_ms.abs_diff(mid))
    };
    if let Some(k) = nearest(&|k| ends_clause(&words[k - 1].text)) {
        return k;
    }
    if let Some(k) = nearest(&|k| words[k].start_ms.saturating_sub(words[k - 1].end_ms) >= SPLIT_GAP_MS) {
        return k;
    }
    let mut k = r.start + 1;
    while k + 1 < r.end && cue_fits(words, r.start..k + 1, line_chars) {
        k += 1;
    }
    k
}

fn split_into(words: &[SttWord], r: Range<usize>, line_chars: usize, out: &mut Vec<Range<usize>>) {
    if r.is_empty() {
        return;
    }
    if r.len() == 1 || cue_fits(words, r.clone(), line_chars) {
        out.push(r);
        return;
    }
    let k = pick_split(words, r.clone(), line_chars);
    split_into(words, r.start..k, line_chars, out);
    split_into(words, k..r.end, line_chars, out);
}

/// 한 세그먼트의 어절을 cue로 다시 자른다 — 줄 폭 × 2줄 · 7초(§3.3). 결과는 순서대로·빈틈없이 덮는다.
/// 한 어절이 규칙보다 길면(7초 넘는 어절 등) 그 어절 하나가 cue가 된다.
pub fn split_cues(words: &[SttWord], line_chars: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    split_into(words, 0..words.len(), line_chars, &mut out);
    out
}

// ══════════════════════════ 문서 만들기 ══════════════════════════

fn gap_token(id: String, start_ms: u64, end_ms: u64) -> Token {
    Token { id, kind: TokenKind::Gap, start_ms, end_ms, text: String::new(), p: None, cut: false }
}

/// whisper 어절 → 문서(rev 0, 저장이 올린다). 시각 방어·gap·cue 분할·suspect 표시까지 여기서 끝낸다.
pub fn build_doc(source: DocSource, engine: DocEngine, mut words: Vec<SttWord>) -> CaptionDoc {
    let dur = source.duration_ms;
    crate::stt::guard::fix_word_times(&mut words, dur);
    let line_chars = doc_line_chars(&engine);

    // 세그먼트 단위로 cue 분할 + 세그먼트 반복(환각 루프) 표시.
    let mut groups: Vec<Range<usize>> = Vec::new();
    let mut seg_ranges: Vec<Range<usize>> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let mut j = i + 1;
        while j < words.len() && words[j].segment == words[i].segment {
            j += 1;
        }
        seg_ranges.push(i..j);
        groups.extend(split_cues(&words[i..j], line_chars).into_iter().map(|r| r.start + i..r.end + i));
        i = j;
    }
    let seg_texts: Vec<String> = seg_ranges
        .iter()
        .map(|r| words[r.clone()].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "))
        .collect();
    let seg_repeat = crate::stt::guard::mark_repeats(&seg_texts);
    let mut word_repeat = vec![false; words.len()];
    for (r, rep) in seg_ranges.iter().zip(&seg_repeat) {
        if *rep {
            word_repeat[r.clone()].fill(true);
        }
    }

    // 토큰: 어절 + 사이 gap(머리는 항상, 사이는 300ms 이상, 꼬리는 항상).
    let mut tokens: Vec<Token> = Vec::with_capacity(words.len() * 2);
    let mut word_tok: Vec<usize> = Vec::with_capacity(words.len());
    let mut n = 0u64;
    let mut next_id = |prefix: char| {
        n += 1;
        format!("{prefix}{n}")
    };
    let mut prev_end = 0u64;
    for (wi, w) in words.iter().enumerate() {
        let space = w.start_ms.saturating_sub(prev_end);
        if (wi == 0 && space > 0) || space >= GAP_MIN_MS {
            tokens.push(gap_token(next_id('t'), prev_end, w.start_ms));
        }
        word_tok.push(tokens.len());
        tokens.push(Token {
            id: next_id('t'),
            kind: TokenKind::Word,
            start_ms: w.start_ms,
            end_ms: w.end_ms,
            text: w.text.clone(),
            p: w.p,
            cut: false,
        });
        prev_end = w.end_ms;
    }
    if dur > prev_end {
        tokens.push(gap_token(next_id('t'), prev_end, dur));
    }

    // cue = 연속 토큰 구간. 그룹 사이 gap은 **뒤** cue에 붙고(쉼 → 말), 꼬리 gap은 마지막 cue에 붙는다.
    let mut cues = Vec::with_capacity(groups.len().max(1));
    let mut first = 0usize;
    for (gi, g) in groups.iter().enumerate() {
        let last = if gi + 1 == groups.len() { tokens.len() - 1 } else { word_tok[g.end - 1] };
        let suspect = if words[g.clone()].iter().any(|w| w.invalid_utf8) {
            Some(Suspect::InvalidUtf8)
        } else if word_repeat[g.start] {
            Some(Suspect::Repeat)
        } else {
            None
        };
        cues.push(Cue {
            id: next_id('c'),
            first_token_id: tokens[first].id.clone(),
            last_token_id: tokens[last].id.clone(),
            caption: None,
            suspect,
        });
        first = last + 1;
    }
    if groups.is_empty() && !tokens.is_empty() {
        // 말이 하나도 없는 파일 — 무음 gap 하나를 덮는 cue(자막 텍스트는 비어 파일에서 빠진다).
        cues.push(Cue {
            id: next_id('c'),
            first_token_id: tokens[0].id.clone(),
            last_token_id: tokens[tokens.len() - 1].id.clone(),
            caption: None,
            suspect: None,
        });
    }

    CaptionDoc {
        version: DOC_VERSION,
        rev: 0,
        source,
        engine,
        tokens,
        cues,
        silence_keep_ms: None,
        silence_min_ms: None,
        translations: None,
        translation_src: None,
        style_preset: None,
    }
}

// ══════════════════════════ 불변식 ══════════════════════════

fn bad(m: String) -> IpcError {
    IpcError::new(ErrorCode::Io, text_stt::caption_doc_invalid(&m))
}

/// cue → 토큰 인덱스 구간 `(첫, 끝)`. cue가 순서대로·빈틈없이·겹치지 않게 토큰 전체를 덮는지도 여기서 본다.
pub fn cue_spans(doc: &CaptionDoc) -> Result<Vec<(usize, usize)>, IpcError> {
    let index: HashMap<&str, usize> = doc.tokens.iter().enumerate().map(|(i, t)| (t.id.as_str(), i)).collect();
    let find = |cue: &Cue, id: &str| {
        index
            .get(id)
            .copied()
            .ok_or_else(|| bad(text_stt::caption_doc_cue_token_missing(&cue.id, id)))
    };
    let mut spans = Vec::with_capacity(doc.cues.len());
    let mut next = 0usize;
    for c in &doc.cues {
        let (a, b) = (find(c, &c.first_token_id)?, find(c, &c.last_token_id)?);
        if a != next || b < a {
            return Err(bad(text_stt::caption_doc_cue_not_contiguous(&c.id)));
        }
        spans.push((a, b));
        next = b + 1;
    }
    if next != doc.tokens.len() {
        return Err(bad(text_stt::caption_doc_cues_incomplete().into()));
    }
    Ok(spans)
}

/// 저장 전 필수(§3.3): 텍스트 정리 + tokens 정렬·겹침 없음·`0 ≤ s ≤ e ≤ durationMs`·id 유일 + cue 연속·전체 덮음.
/// 정리(보이지 않는 문자 제거)는 문서를 고친다 — 막는 것은 구조가 틀렸을 때뿐이다.
pub fn validate_doc(doc: &mut CaptionDoc) -> Result<(), IpcError> {
    let dur = doc.source.duration_ms;
    let mut ids = HashSet::with_capacity(doc.tokens.len());
    let mut prev_end = 0u64;
    for t in &mut doc.tokens {
        match t.kind {
            TokenKind::Word => {
                t.text = strip_invisible(&t.text);
                if t.text.trim().is_empty() {
                    return Err(bad(text_stt::caption_doc_word_empty(&t.id)));
                }
            }
            TokenKind::Gap => {
                t.text.clear();
                t.p = None;
            }
        }
        if t.start_ms > t.end_ms || t.end_ms > dur {
            return Err(bad(text_stt::caption_doc_token_time_out_of_range(&t.id, t.start_ms, t.end_ms)));
        }
        if t.start_ms < prev_end {
            return Err(bad(text_stt::caption_doc_token_overlap(&t.id)));
        }
        prev_end = t.end_ms;
        if !ids.insert(t.id.clone()) {
            return Err(bad(text_stt::caption_doc_duplicate_token_id(&t.id)));
        }
    }
    let mut cue_ids = HashSet::with_capacity(doc.cues.len());
    for c in &mut doc.cues {
        if !cue_ids.insert(c.id.clone()) {
            return Err(bad(text_stt::caption_doc_duplicate_cue_id(&c.id)));
        }
        if let Some(cap) = &c.caption {
            c.caption = Some(strip_invisible(cap));
        }
    }
    cue_spans(doc)?;
    if let Some(tr) = &mut doc.translations {
        for v in tr.values_mut().flat_map(|m| m.values_mut()) {
            *v = strip_invisible(v);
        }
    }
    if let Some(p) = &mut doc.engine.prompt {
        *p = strip_invisible(p);
    }
    Ok(())
}

/// cue 하나의 자막 줄 — override가 있으면 그것, 없으면 어절을 이어 줄 폭에 맞춰 줄바꿈한다.
/// `include_cut=false`면 컷된 어절을 뺀다(편집본, §3.3 계획 4).
pub fn cue_text(doc: &CaptionDoc, cue: &Cue, span: (usize, usize), include_cut: bool) -> String {
    if let Some(cap) = cue.caption.as_deref().filter(|c| !c.trim().is_empty()) {
        return cap.to_string();
    }
    let words = doc.tokens[span.0..=span.1]
        .iter()
        .filter(|t| t.kind == TokenKind::Word && (include_cut || !t.cut))
        .map(|t| t.text.trim());
    wrap_words(words, doc_line_chars(&doc.engine)).join("\n")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn w(start_ms: u64, end_ms: u64, text: &str, segment: usize) -> SttWord {
        SttWord { start_ms, end_ms, text: text.into(), p: Some(0.9), invalid_utf8: false, segment }
    }

    pub(crate) fn source(duration_ms: u64) -> DocSource {
        DocSource { rel: "a.mp4".into(), size_bytes: 10, mtime_ms: 20, duration_ms, start_time_ms: 0, audio_stream: 0 }
    }

    pub(crate) fn engine(lang: &str) -> DocEngine {
        DocEngine {
            name: "whisper.cpp".into(),
            build: "b5130".into(),
            model_id: "turbo-q5".into(),
            language: lang.into(),
            detected_language: None,
            vad: true,
            prompt: None,
            word_timing: WordTiming::Dtw,
        }
    }

    fn texts(words: &[SttWord], rs: &[Range<usize>]) -> Vec<String> {
        rs.iter().map(|r| words[r.clone()].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")).collect()
    }

    /// 16자·2줄: 32자를 넘는 한 세그먼트는 문장부호 뒤에서 먼저 자르고, 조각은 모두 규칙 안에 든다.
    #[test]
    fn split_cues_prefers_punctuation_and_fits_two_lines() {
        let src = ["안녕하세요.", "오늘은", "영상", "편집", "프로그램에서", "자동", "자막을", "만드는", "방법을", "알아보겠습니다."];
        let words: Vec<SttWord> = src.iter().enumerate().map(|(i, t)| w(i as u64 * 400, i as u64 * 400 + 350, t, 0)).collect();
        let rs = split_cues(&words, 16);
        let got = texts(&words, &rs);
        assert_eq!(got[0], "안녕하세요.", "문장부호 뒤가 첫 분할점: {got:?}");
        for r in &rs {
            assert!(cue_fits(&words, r.clone(), 16), "규칙을 넘는 cue: {:?}", texts(&words, &[r.clone()]));
        }
        // 순서대로·빈틈없이 덮는다.
        assert_eq!(rs.first().unwrap().start, 0);
        assert_eq!(rs.last().unwrap().end, words.len());
        assert!(rs.windows(2).all(|p| p[0].end == p[1].start));
    }

    /// 7초 규칙과 700ms 쉼: 문장부호가 없으면 가장 긴 쉼이 아니라 가운데에 가까운 700ms+ 쉼에서 자른다.
    #[test]
    fn split_cues_uses_pause_then_seven_seconds() {
        // 짧은 어절 10개가 7.5초에 걸쳐 있다 — 글자 수는 맞지만 7초를 넘는다. b 뒤 1.5초 쉼, e 뒤 0.8초 쉼.
        let words = vec![
            w(0, 400, "a", 0), w(500, 900, "b", 0),
            w(2400, 2800, "c", 0), w(2900, 3300, "d", 0), w(3400, 3800, "e", 0),
            w(4600, 5000, "f", 0), w(5100, 5500, "g", 0), w(5600, 6000, "h", 0), w(6100, 6500, "i", 0), w(6600, 7500, "j", 0),
        ];
        let rs = split_cues(&words, 16);
        assert_eq!(rs, vec![0..5, 5..10], "가운데(3.75초)에 가까운 0.8초 쉼에서 잘라야 한다");
        assert!(rs.iter().all(|r| cue_fits(&words, r.clone(), 16)));
        // 한 어절이 7초를 넘으면 더 자를 수 없다 — 그대로 한 cue.
        let long = vec![w(0, 9000, "음", 0)];
        assert_eq!(split_cues(&long, 16), vec![0..1]);
        assert!(split_cues(&[], 16).is_empty());
    }

    #[test]
    fn line_chars_follow_language() {
        assert_eq!(line_chars("ko"), 16);
        assert_eq!(line_chars("auto"), 16);
        assert_eq!(line_chars("en"), 42);
        assert_eq!(wrap_words(["가나다라", "마바사아자차카", "타파하"], 12), vec!["가나다라 마바사아자차카", "타파하"]);
    }

    /// 문서: 머리·사이(300ms+)·꼬리 gap, cue가 토큰 전체를 덮고, gap은 뒤 cue에 붙는다.
    #[test]
    fn build_doc_places_gaps_and_covers_tokens() {
        let words = vec![w(500, 900, "하나", 0), w(1000, 1400, "둘.", 0), w(3000, 3500, "셋", 1)];
        let mut doc = build_doc(source(4000), engine("ko"), words);
        let kinds: Vec<(TokenKind, u64, u64)> = doc.tokens.iter().map(|t| (t.kind, t.start_ms, t.end_ms)).collect();
        assert_eq!(
            kinds,
            vec![
                (TokenKind::Gap, 0, 500),
                (TokenKind::Word, 500, 900),
                (TokenKind::Word, 1000, 1400), // 100ms 틈은 gap이 아니다
                (TokenKind::Gap, 1400, 3000),
                (TokenKind::Word, 3000, 3500),
                (TokenKind::Gap, 3500, 4000),
            ]
        );
        assert_eq!(doc.cues.len(), 2, "세그먼트 두 개 = cue 두 개");
        let spans = cue_spans(&doc).unwrap();
        assert_eq!(spans, vec![(0, 2), (3, 5)], "사이 gap은 뒤 cue, 꼬리 gap은 마지막 cue");
        validate_doc(&mut doc).unwrap();
        assert_eq!(cue_text(&doc, &doc.cues[0], spans[0], true), "하나 둘.");
    }

    #[test]
    fn build_doc_marks_suspects() {
        let mut words: Vec<SttWord> = (0..4).map(|i| w(i * 1000, i * 1000 + 500, "감사합니다", i as usize)).collect();
        words.push(SttWord { invalid_utf8: true, ..w(5000, 5500, "리눅\u{FFFD}스", 4) });
        let doc = build_doc(source(6000), engine("ko"), words);
        let sus: Vec<Option<Suspect>> = doc.cues.iter().map(|c| c.suspect).collect();
        assert_eq!(sus, vec![Some(Suspect::Repeat); 4].into_iter().chain([Some(Suspect::InvalidUtf8)]).collect::<Vec<_>>());
        // 말이 없는 파일도 문서가 된다(무음 gap 하나).
        let empty = build_doc(source(3000), engine("ko"), vec![]);
        assert_eq!(empty.tokens.len(), 1);
        assert_eq!(empty.cues.len(), 1);
        assert!(build_doc(source(0), engine("ko"), vec![]).cues.is_empty());
    }

    /// validate_doc: 보이지 않는 문자는 지우고 통과, 구조가 틀리면 막는다.
    #[test]
    fn validate_doc_strips_and_rejects() {
        let base = build_doc(source(4000), engine("ko"), vec![w(500, 900, "하나", 0), w(1000, 1400, "둘", 0)]);
        let mut d = base.clone();
        d.tokens[1].text = "하\u{200B}나\u{202E}".into();
        d.cues[0].caption = Some("자막\u{FEFF}\r\n둘째 줄".into());
        validate_doc(&mut d).unwrap();
        assert_eq!(d.tokens[1].text, "하나");
        assert_eq!(d.cues[0].caption.as_deref(), Some("자막\n둘째 줄"));

        let reject = |f: &dyn Fn(&mut CaptionDoc)| {
            let mut d = base.clone();
            f(&mut d);
            validate_doc(&mut d).is_err()
        };
        assert!(reject(&|d| d.tokens[1].end_ms = 5000), "범위 밖");
        assert!(reject(&|d| d.tokens[2].start_ms = 800), "겹침");
        assert!(reject(&|d| d.tokens[2].id = d.tokens[1].id.clone()), "id 중복");
        assert!(reject(&|d| d.tokens[1].text = "\u{200B} ".into()), "빈 단어");
        assert!(reject(&|d| d.cues[0].last_token_id = "t2".into()), "cue가 전체를 덮지 않음");
        assert!(reject(&|d| d.cues[0].first_token_id = "없음".into()), "없는 토큰");
    }

    /// TS 계약: gap은 text·p가 없고, 필드는 camelCase, suspect는 kebab-case.
    #[test]
    fn doc_serializes_to_ts_shape() {
        let mut doc = build_doc(source(2000), engine("ko"), vec![SttWord { invalid_utf8: true, ..w(500, 900, "하나", 0) }]);
        doc.rev = 3;
        let v = serde_json::to_value(&doc).unwrap();
        assert_eq!(v["tokens"][0], serde_json::json!({"id":"t1","kind":"gap","startMs":0,"endMs":500,"cut":false}));
        assert_eq!(v["tokens"][1]["text"], "하나");
        assert_eq!(v["cues"][0]["suspect"], "invalid-utf8");
        assert_eq!(v["source"]["startTimeMs"], 0);
        assert_eq!(v["engine"]["wordTiming"], "dtw");
        assert!(v.get("silenceKeepMs").is_none());
        assert!(v.get("silenceMinMs").is_none());
        assert!(v.get("translationSrc").is_none());
        let back: CaptionDoc = serde_json::from_value(v).unwrap();
        assert_eq!(back, doc);

        // 번역 원문 해시(P4)는 TS `translationSrc`로 왕복한다 — 선언이 빠지면 저장 때 조용히 사라진다.
        let tr = serde_json::json!({"en": {"c2": "a1b2"}});
        let mut v = serde_json::to_value(&doc).unwrap();
        v["translationSrc"] = tr.clone();
        let back: CaptionDoc = serde_json::from_value(v).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap()["translationSrc"], tr);
    }
}
