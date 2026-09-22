// whisper-cli `-ojf` JSON + stderr VAD 대응표 → 어절 목록(태스크 72 부록 B.3 형식). whisper 출력 형식이
// 바뀌면 여기만 고친다.
//
// 단어 시각 = 부록 B.1 방식 (d): VAD는 켜 두고 `-nfa -dtw <프리셋>`을 더해, 어절 첫 토큰의 `t_dtw × 10`
// (VAD 타임라인)을 stderr의 `vad_segment_info` 대응표로 원본 타임라인에 옮긴 뒤 DTW 지연 190ms를 뺀다.
// VAD를 켜면 세그먼트 offsets만 원본 시각이고 토큰 offsets·t_dtw는 VAD가 잘라 붙인 타임라인이다.

use serde::Deserialize;

use crate::i18n::text_stt;
use crate::stt::doc::{SttWord, WordTiming};

/// DTW 어절 시작은 일정하게 늦다 — 한국어 TTS 정답 대비 중앙값 +185~195ms(부록 B.1, turbo 기준).
/// 실제 녹음으로 다시 재야 하는 값이다(부록 B.5).
pub const DTW_LAG_MS: u64 = 190;

/// stderr `whisper_vad: vad_segment_info: orig_start: 2.82, orig_end: 8.19, vad_start: 1.19, vad_end: 6.56` 한 줄(ms).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VadSpan {
    pub orig_start: u64,
    pub orig_end: u64,
    pub vad_start: u64,
    pub vad_end: u64,
}

pub fn parse_vad_line(line: &str) -> Option<VadSpan> {
    let rest = line.split_once("vad_segment_info:")?.1;
    let mut v = [0u64; 4];
    for (slot, key) in v.iter_mut().zip(["orig_start:", "orig_end:", "vad_start:", "vad_end:"]) {
        let after = rest.split_once(key)?.1.trim_start();
        let num: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let secs: f64 = num.parse().ok()?;
        *slot = (secs * 1000.0).round() as u64;
    }
    Some(VadSpan { orig_start: v[0], orig_end: v[1], vad_start: v[2], vad_end: v[3] })
}

/// VAD 타임라인 시각 → (원본 시각, 조각 번호). 조각 안이면 조각별 이동, 조각 사이 틈(VAD가 0.2초씩 벌린다)이면
/// 다음 조각 시작으로. `table`은 비어 있지 않아야 한다.
fn vad_to_orig(t: u64, table: &[VadSpan]) -> (u64, usize) {
    let i = table.partition_point(|s| s.vad_end < t).min(table.len() - 1);
    let s = table[i];
    (s.orig_start + t.saturating_sub(s.vad_start), i)
}

#[derive(Deserialize)]
struct WJson {
    #[serde(default)]
    result: Option<WResult>,
    transcription: Vec<WSeg>,
}

#[derive(Deserialize)]
struct WResult {
    language: Option<String>,
}

#[derive(Deserialize)]
struct WSeg {
    offsets: WOff,
    #[serde(default)]
    tokens: Vec<WTok>,
}

#[derive(Deserialize, Clone, Copy)]
struct WOff {
    from: i64,
    to: i64,
}

#[derive(Deserialize)]
struct WTok {
    text: String,
    offsets: WOff,
    #[serde(default)]
    p: Option<f64>,
    /// 10ms 단위, DTW가 꺼졌으면 -1.
    #[serde(default)]
    t_dtw: Option<i64>,
}

#[derive(Debug)]
pub struct WhisperOut {
    pub words: Vec<SttWord>,
    /// `result.language` — `-l auto`면 감지된 언어.
    pub detected_language: Option<String>,
    pub word_timing: WordTiming,
}

#[derive(Debug, PartialEq)]
pub enum WhisperParseError {
    /// 어절을 이어 붙인 바이트가 유효한 UTF-8이 아니다(CUDA beam 실측, §2.2) — greedy로 한 번 다시 돈다.
    InvalidUtf8,
    Malformed(String),
}

// whisper는 토큰 텍스트를 바이트 그대로 쓴다. BPE가 한 글자의 바이트를 두 토큰에 나누면 **토큰 하나는**
// 깨진 UTF-8이지만 이어 붙이면 멀쩡하다 — 그래서 파일 전체를 엄격히 디코드하면 안 되고, 깨진 바이트를
// 보존한 채 JSON을 읽은 뒤 어절 단위로 판정한다. 깨진 바이트는 whisper가 절대 내지 않는 문자
// (U+10FF00 + 바이트, 보조 사설 영역 끝 256칸)로 잠시 싸 둔다.
const ESC_BASE: u32 = 0x10_FF00;

fn escape_invalid_utf8(mut bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    loop {
        match std::str::from_utf8(bytes) {
            Ok(s) => {
                out.push_str(s);
                return out;
            }
            Err(e) => {
                let (good, bad) = bytes.split_at(e.valid_up_to());
                // valid_up_to 앞은 정의상 유효하다.
                out.push_str(std::str::from_utf8(good).unwrap_or_default());
                let n = e.error_len().unwrap_or(bad.len());
                for &b in &bad[..n] {
                    out.extend(char::from_u32(ESC_BASE + u32::from(b)));
                }
                bytes = &bad[n..];
            }
        }
    }
}

fn unescape_into(s: &str, out: &mut Vec<u8>) {
    for c in s.chars() {
        let u = u32::from(c);
        if (ESC_BASE..=ESC_BASE + 0xFF).contains(&u) {
            out.push((u - ESC_BASE) as u8);
        } else {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
}

fn is_special(text: &str) -> bool {
    text.starts_with("[_") && text.ends_with(']')
}

struct Pending {
    text: String,
    invalid: bool,
    p: Option<f32>,
    /// VAD 타임라인 시각과 그 출처가 DTW인가.
    t: u64,
    dtw: bool,
}

/// `strict`면 깨진 어절에서 `InvalidUtf8`을 돌려주고(재시도 신호), 아니면 U+FFFD로 바꾸고 표시한다.
pub fn parse_whisper_json(bytes: &[u8], vad: &[VadSpan], strict: bool) -> Result<WhisperOut, WhisperParseError> {
    let text = escape_invalid_utf8(bytes);
    let doc: WJson = serde_json::from_str(&text)
        .map_err(|e| WhisperParseError::Malformed(text_stt::stt_whisper_json_parse_failed(&e)))?;
    let mut words = Vec::new();
    let mut all_dtw = true;

    for (si, seg) in doc.transcription.iter().enumerate() {
        // BPE 토큰 → 어절(앞 공백 = 새 어절). 특수 토큰([_BEG_]·[_TT_*])은 버린다.
        let mut groups: Vec<Vec<&WTok>> = Vec::new();
        for t in seg.tokens.iter().filter(|t| !t.text.is_empty() && !is_special(&t.text)) {
            match groups.last_mut() {
                Some(g) if !t.text.starts_with(' ') => g.push(t),
                _ => groups.push(vec![t]),
            }
        }
        let mut pending: Vec<Pending> = Vec::with_capacity(groups.len());
        for g in &groups {
            let mut raw = Vec::new();
            for t in g {
                unescape_into(&t.text, &mut raw);
            }
            let (text, invalid) = match String::from_utf8(raw) {
                Ok(s) => (s, false),
                Err(_) if strict => return Err(WhisperParseError::InvalidUtf8),
                // 조용한 복구가 아니다 — invalid 표시가 cue의 suspect("invalid-utf8")로 드러난다(§3.1).
                Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), true),
            };
            let text = text.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let first = g[0];
            let (t, dtw) = match first.t_dtw {
                Some(d) if d >= 0 => (d as u64 * 10, true),
                _ => (first.offsets.from.max(0) as u64, false),
            };
            all_dtw &= dtw;
            let p = g.iter().filter_map(|t| t.p).map(|p| p as f32).reduce(f32::min);
            pending.push(Pending { text, invalid, p, t, dtw });
        }
        if pending.is_empty() {
            continue;
        }

        let seg_from = seg.offsets.from.max(0) as u64;
        let seg_to = (seg.offsets.to.max(0) as u64).max(seg_from);
        // 어절 시작(원본 타임라인)과 그 어절이 든 VAD 조각.
        let starts: Vec<(u64, Option<usize>)> = if vad.is_empty() {
            // 대응표가 없다(비관리 바이너리가 다르게 찍음) — 세그먼트 안으로 선형 재배치. 부록 B.1 (d')와 같은
            // 방식이라 p90 0.8초까지 어긋난다 → word_timing Approx로 알린다.
            let lo = pending.iter().map(|w| w.t).min().unwrap_or(0);
            let hi = pending.iter().map(|w| w.t).max().unwrap_or(0);
            pending
                .iter()
                .map(|w| {
                    let s = if hi > lo { seg_from + (w.t - lo) * (seg_to - seg_from) / (hi - lo) } else { seg_from };
                    (s, None)
                })
                .collect()
        } else {
            pending
                .iter()
                .map(|w| {
                    let (orig, chunk) = vad_to_orig(w.t, vad);
                    (if w.dtw { orig.saturating_sub(DTW_LAG_MS) } else { orig }, Some(chunk))
                })
                .collect()
        };
        for (k, w) in pending.into_iter().enumerate() {
            let (start, chunk) = starts[k];
            // 끝 = 다음 어절 시작, 세그먼트 마지막이면 세그먼트 끝. 어절이 든 VAD 조각 끝을 넘지 않는다 —
            // whisper 세그먼트는 문장 사이 무음을 끼기도 해서(부록 B.1) 그대로 두면 쉼이 앞 어절에 붙는다.
            // 어절 **끝** 시각은 정답이 없어 재지 못했다(부록 B.5).
            let mut end = starts.get(k + 1).map_or(seg_to, |n| n.0);
            if let Some(c) = chunk {
                end = end.min(vad[c].orig_end);
            }
            words.push(SttWord {
                start_ms: start,
                end_ms: end.max(start),
                text: w.text,
                p: w.p,
                invalid_utf8: w.invalid,
                segment: si,
            });
        }
    }

    let word_timing = if !vad.is_empty() && all_dtw { WordTiming::Dtw } else { WordTiming::Approx };
    Ok(WhisperOut {
        words,
        detected_language: doc.result.and_then(|r| r.language).filter(|l| !l.is_empty()),
        word_timing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 부록 B.1 (d) 실행(`--vad -nfa -dtw large.v3.turbo`, 한국어 TTS)의 stderr 대응표 첫 세 줄 그대로.
    const VAD_LINES: &str = "\
whisper_vad: vad_segment_info: orig_start: 1.09, orig_end: 2.08, vad_start: 0.00, vad_end: 0.99
whisper_vad: vad_segment_info: orig_start: 2.82, orig_end: 8.19, vad_start: 1.19, vad_end: 6.56
whisper_vad: vad_segment_info: orig_start: 9.95, orig_end: 12.25, vad_start: 6.76, vad_end: 9.06
whisper_print_progress_callback: progress =  44%";

    /// 같은 실행의 `-ojf` 출력 발췌(세그먼트 1은 앞 토큰 일부, 세그먼트 2는 앞 네 토큰) — 값은 원본 그대로.
    const KO_JSON: &str = r#"{
	"params": {"model": "ggml-large-v3-turbo-q5_0.bin", "language": "ko", "translate": false},
	"result": {"language": "ko"},
	"transcription": [
		{"timestamps": {"from": "00:00:01,090", "to": "00:00:07,890"}, "offsets": {"from": 1090, "to": 7890},
		 "text": " 안녕하세요. 오늘은 영상 편집",
		 "tokens": [
			{"text": "[_BEG_]", "timestamps": {"from": "00:00:00,000", "to": "00:00:00,000"}, "offsets": {"from": 0, "to": 0}, "id": 50365, "p": 0.892276, "t_dtw": -1},
			{"text": " 안녕하세요", "timestamps": {"from": "00:00:00,040", "to": "00:00:00,370"}, "offsets": {"from": 40, "to": 370}, "id": 19289, "p": 0.998058, "t_dtw": 56},
			{"text": ".", "timestamps": {"from": "00:00:00,370", "to": "00:00:00,510"}, "offsets": {"from": 370, "to": 510}, "id": 13, "p": 0.846092, "t_dtw": 128},
			{"text": " 오늘은", "timestamps": {"from": "00:00:00,630", "to": "00:00:00,870"}, "offsets": {"from": 630, "to": 870}, "id": 23720, "p": 0.942699, "t_dtw": 146},
			{"text": " 영상", "timestamps": {"from": "00:00:01,210", "to": "00:00:01,300"}, "offsets": {"from": 1210, "to": 1300}, "id": 15603, "p": 0.999765, "t_dtw": 200},
			{"text": " 편", "timestamps": {"from": "00:00:01,300", "to": "00:00:01,440"}, "offsets": {"from": 1300, "to": 1440}, "id": 16990, "p": 0.701614, "t_dtw": 234},
			{"text": "집", "timestamps": {"from": "00:00:01,440", "to": "00:00:01,580"}, "offsets": {"from": 1440, "to": 1580}, "id": 12837, "p": 0.99559, "t_dtw": 254},
			{"text": "[_TT_313]", "timestamps": {"from": "00:00:06,260", "to": "00:00:06,260"}, "offsets": {"from": 6260, "to": 6260}, "id": 50678, "p": 0.312535, "t_dtw": -1}
		 ]},
		{"timestamps": {"from": "00:00:09,990", "to": "00:00:16,190"}, "offsets": {"from": 9990, "to": 16190},
		 "text": " 먼저 영상 파일",
		 "tokens": [
			{"text": " 먼저", "timestamps": {"from": "00:00:06,800", "to": "00:00:06,800"}, "offsets": {"from": 6800, "to": 6800}, "id": 20749, "p": 0.999996, "t_dtw": 710},
			{"text": " 영상", "timestamps": {"from": "00:00:06,820", "to": "00:00:06,820"}, "offsets": {"from": 6820, "to": 6820}, "id": 15603, "p": 0.999912, "t_dtw": 756},
			{"text": " 파", "timestamps": {"from": "00:00:06,840", "to": "00:00:06,960"}, "offsets": {"from": 6840, "to": 6960}, "id": 3070, "p": 0.987796, "t_dtw": 790},
			{"text": "일", "timestamps": {"from": "00:00:06,960", "to": "00:00:07,100"}, "offsets": {"from": 6960, "to": 7100}, "id": 2785, "p": 0.999338, "t_dtw": 802}
		 ]}
	]
}"#;

    fn table() -> Vec<VadSpan> {
        VAD_LINES.lines().filter_map(parse_vad_line).collect()
    }

    #[test]
    fn whisper_vad_table_parses_real_stderr() {
        let t = table();
        assert_eq!(t.len(), 3, "진행률 줄은 대응표가 아니다");
        assert_eq!(t[1], VadSpan { orig_start: 2820, orig_end: 8190, vad_start: 1190, vad_end: 6560 });
        assert_eq!(parse_vad_line("whisper_vad: detected 19 speech segments"), None);
        // 조각 안 = 조각별 이동, 조각 사이 틈(990~1190) = 다음 조각 시작.
        assert_eq!(vad_to_orig(500, &t), (1590, 0));
        assert_eq!(vad_to_orig(1100, &t), (2820, 1));
        assert_eq!(vad_to_orig(7100, &t), (10290, 2));
        assert_eq!(vad_to_orig(99_000, &t).1, 2, "표 끝 너머는 마지막 조각 기준");
    }

    /// 부록 B.1 (d): 어절 시작 = t_dtw×10을 대응표로 옮기고 −190ms. BPE 병합(앞 공백 = 새 어절)·특수 토큰 제거·
    /// 끝 = 다음 시작(조각 끝을 넘지 않음).
    #[test]
    fn whisper_json_words_follow_p0_method_d() {
        let out = parse_whisper_json(KO_JSON.as_bytes(), &table(), true).unwrap();
        let got: Vec<(&str, u64, u64, usize)> =
            out.words.iter().map(|w| (w.text.as_str(), w.start_ms, w.end_ms, w.segment)).collect();
        assert_eq!(
            got,
            vec![
                // 560 → 조각0 1090+560=1650 −190. 끝 = min(다음 2900, 조각0 끝 2080).
                ("안녕하세요.", 1460, 2080, 0),
                // 1460 → 조각1 2820+270=3090 −190.
                ("오늘은", 2900, 3440, 0),
                ("영상", 3440, 3780, 0),
                // 마지막 어절 끝 = 세그먼트 끝(7890, 조각1 끝 8190보다 앞).
                ("편집", 3780, 7890, 0),
                // 7100 → 조각2 9950+340=10290 −190.
                ("먼저", 10100, 10560, 1),
                ("영상", 10560, 10900, 1),
                ("파일", 10900, 12250, 1),
            ]
        );
        assert_eq!(out.word_timing, WordTiming::Dtw);
        assert_eq!(out.detected_language.as_deref(), Some("ko"));
        assert!((out.words[0].p.unwrap() - 0.846092).abs() < 1e-6, "어절 p = 토큰 p의 최솟값");
    }

    /// 대응표가 없거나(비관리 바이너리) DTW가 꺼졌으면 Approx — 컷 편집이 이 값을 믿으면 안 된다.
    #[test]
    fn whisper_json_without_table_is_approx_and_inside_segment() {
        let out = parse_whisper_json(KO_JSON.as_bytes(), &[], true).unwrap();
        assert_eq!(out.word_timing, WordTiming::Approx);
        for w in &out.words {
            let (lo, hi) = if w.segment == 0 { (1090, 7890) } else { (9990, 16190) };
            assert!(lo <= w.start_ms && w.end_ms <= hi, "{} 이 세그먼트 밖: {}~{}", w.text, w.start_ms, w.end_ms);
        }
        // 한 어절이라도 DTW 값이 없으면(비관리 바이너리의 -dtw 무시 등) 전체가 Approx.
        let no_dtw = KO_JSON.replace("\"t_dtw\": 56", "\"t_dtw\": -1");
        assert_eq!(parse_whisper_json(no_dtw.as_bytes(), &table(), true).unwrap().word_timing, WordTiming::Approx);
    }

    fn json_with_tokens(tokens: &[&[u8]]) -> Vec<u8> {
        let mut b: Vec<u8> = br#"{"result":{"language":"ko"},"transcription":[{"offsets":{"from":0,"to":3000},"tokens":["#.to_vec();
        for (i, t) in tokens.iter().enumerate() {
            if i > 0 {
                b.push(b',');
            }
            b.extend_from_slice(br#"{"text":""#);
            b.extend_from_slice(t);
            b.extend_from_slice(format!(r#"","offsets":{{"from":{},"to":{}}},"p":0.9,"t_dtw":{}}}"#, i * 100, i * 100 + 100, i * 10).as_bytes());
        }
        b.extend_from_slice(b"]}]}");
        b
    }

    /// 멀티바이트 한 글자가 두 토큰에 나뉘어도(토큰 단위로는 깨진 UTF-8) 이어 붙이면 멀쩡하다.
    #[test]
    fn whisper_json_joins_split_multibyte() {
        // " 리눅스" = " 리" + "눅"의 앞 두 바이트 + 마지막 바이트 + "스"
        let json = json_with_tokens(&[" \u{b9ac}".as_bytes(), b"\xeb\x88", b"\x85\xec\x8a\xa4"]);
        let out = parse_whisper_json(&json, &[], true).unwrap();
        assert_eq!(out.words.len(), 1);
        assert_eq!(out.words[0].text, "리눅스");
        assert!(!out.words[0].invalid_utf8);
    }

    /// CUDA beam 실측 바이트(ko6_cuda2.srt: "리눅스" → `eb a6 ac eb 88 85 b9 ec 8a a4`, 길 잃은 0xB9):
    /// 엄격 모드는 Err(재시도 신호), 관대 모드는 U+FFFD + invalid 표시.
    #[test]
    fn whisper_json_rejects_invalid_utf8_in_strict_mode() {
        let json = json_with_tokens(&[b" \xeb\xa6\xac\xeb\x88\x85", b"\xb9\xec\x8a\xa4"]);
        assert_eq!(parse_whisper_json(&json, &[], true).unwrap_err(), WhisperParseError::InvalidUtf8);
        let out = parse_whisper_json(&json, &[], false).unwrap();
        assert_eq!(out.words[0].text, "리눅\u{FFFD}스");
        assert!(out.words[0].invalid_utf8);
        assert!(matches!(parse_whisper_json(b"{not json", &[], true), Err(WhisperParseError::Malformed(_))));
    }
}
