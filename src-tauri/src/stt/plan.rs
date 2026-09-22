// 편집 계획 `caption_plan`(태스크 72 §3.3) — **단일 구현**. 내보내기(P2)는 Rust가 자기 저장소에서 문서를
// 읽어 이걸 계산하고, 프론트의 미리보기·타임라인 음영은 저장 응답의 plan만 쓴다. cue·keep을 IPC로
// 받아 쓰는 경로를 만들지 않는다 — 계획이 둘로 갈라진다.

use serde::Serialize;

use crate::commands::RangeMs;
use crate::error::IpcError;
use crate::stt::doc::{cue_spans, cue_text, CaptionDoc, TokenKind};

/// 남기는 어절 앞뒤 여유. 부록 B.1: DTW 지연을 뺀 뒤 200ms면 앞이 잘리는 어절 ≈ 6%, 잘려도 최대 ~170ms.
/// 설정값이 아니다(§3.3).
pub const PAD_MS: u64 = 200;
/// "1프레임 미만" — fps를 문서에 두지 않으므로 흔한 fps 중 가장 긴 프레임(24fps ≈ 41.7ms)으로 잡는다.
const FRAME_MS: u64 = 42;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutCue {
    pub cue_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionPlan {
    pub keep: Vec<RangeMs>,
    pub out_cues: Vec<OutCue>,
    pub out_duration_ms: u64,
}

/// 겹치거나 `join_below`ms 미만으로 떨어진 구간을 합친다(정렬 포함).
fn merge(mut v: Vec<(u64, u64)>, join_below: u64) -> Vec<(u64, u64)> {
    v.retain(|r| r.1 > r.0);
    v.sort_unstable();
    let mut out: Vec<(u64, u64)> = Vec::with_capacity(v.len());
    for r in v {
        match out.last_mut() {
            Some(last) if r.0 < last.1 + join_below || r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => out.push(r),
        }
    }
    out
}

/// `keep − removed` (둘 다 merge된 정렬 구간).
fn subtract(keep: &[(u64, u64)], removed: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::with_capacity(keep.len());
    let mut j = 0;
    for &(mut s, e) in keep {
        while j < removed.len() && removed[j].1 <= s {
            j += 1;
        }
        let mut k = j;
        while k < removed.len() && removed[k].0 < e {
            if removed[k].0 > s {
                out.push((s, removed[k].0));
            }
            s = s.max(removed[k].1);
            k += 1;
        }
        if s < e {
            out.push((s, e));
        }
    }
    out
}

/// 원본 시각 t → 편집본 시각. 잘린 곳에 있으면 다음 남는 구간의 시작으로 간다(단조 증가).
fn out_time(keep: &[(u64, u64)], prefix: &[u64], t: u64) -> u64 {
    let i = keep.partition_point(|r| r.1 < t);
    match keep.get(i) {
        Some(&(s, _)) if t >= s => prefix[i] + (t - s),
        _ => prefix[i],
    }
}

pub fn caption_plan(doc: &CaptionDoc) -> Result<CaptionPlan, IpcError> {
    let spans = cue_spans(doc)?;
    let dur = doc.source.duration_ms;
    let mut wanted: Vec<(u64, u64)> = Vec::with_capacity(doc.tokens.len());
    let mut removed: Vec<(u64, u64)> = Vec::new();
    for t in &doc.tokens {
        let (s, e) = (t.start_ms, t.end_ms);
        match (t.kind, t.cut) {
            (_, true) => removed.push((s, e)),
            // 1. 남는 어절 = [s−pad, e+pad]. 이웃 컷 구간과 겹치는 패딩은 아래 subtract가 잘라 낸다.
            (TokenKind::Word, false) => wanted.push((s.saturating_sub(PAD_MS), (e + PAD_MS).min(dur))),
            // 2. 무음 줄이기: 목표보다 긴 gap은 **가운데를 덜어** 목표 길이만 남긴다(양 끝에 절반씩).
            //    가운데 k만 남기면 이웃 어절의 패딩이 양 끝을 다시 살려 실제 쉼이 k+2·pad가 된다.
            //    조건(`silence_min_ms`, "X초 초과")이 있으면 그보다 긴 쉼만 줄인다.
            (TokenKind::Gap, false) => match doc.silence_keep_ms {
                Some(k) if e - s > k.max(doc.silence_min_ms.unwrap_or(0)) => {
                    let (a, b) = (s + k / 2, e - (k - k / 2));
                    wanted.push((s, a));
                    wanted.push((b, e));
                    removed.push((a, b));
                }
                _ => wanted.push((s, e)),
            },
        }
    }
    // 3. 합치고(1프레임 미만 틈 합침) 제거 구간을 빼고, 1프레임 미만 조각은 버린다.
    let keep: Vec<(u64, u64)> = merge(subtract(&merge(wanted, 0), &merge(removed, 0)), FRAME_MS)
        .into_iter()
        .filter(|r| r.1 - r.0 >= FRAME_MS)
        .collect();
    let mut prefix = Vec::with_capacity(keep.len() + 1);
    let mut acc = 0u64;
    for r in &keep {
        prefix.push(acc);
        acc += r.1 - r.0;
    }
    prefix.push(acc);

    // 4. cue 출력 구간 = 남은 첫~마지막 어절, 전부 잘린 cue는 버림, 컷된 어절은 자막 텍스트에서도 뺀다.
    let mut out_cues = Vec::new();
    for (cue, &(a, b)) in doc.cues.iter().zip(&spans) {
        let mut kept = doc.tokens[a..=b].iter().filter(|t| t.kind == TokenKind::Word && !t.cut);
        let Some(first) = kept.next() else { continue };
        let last = kept.last().unwrap_or(first);
        let text = cue_text(doc, cue, (a, b), false);
        let (os, oe) = (out_time(&keep, &prefix, first.start_ms), out_time(&keep, &prefix, last.end_ms));
        if text.trim().is_empty() || oe <= os {
            continue;
        }
        out_cues.push(OutCue { cue_id: cue.id.clone(), start_ms: os, end_ms: oe, text });
    }
    Ok(CaptionPlan {
        keep: keep.iter().map(|&(start_ms, end_ms)| RangeMs { start_ms, end_ms }).collect(),
        out_cues,
        out_duration_ms: acc,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::tests::{engine, source, w};
    use crate::stt::doc::build_doc;

    /// 0.5~0.9 하나 · 1.0~1.4 둘 · [gap 1.4~3.0] · 3.0~3.5 셋 · [gap 3.5~6.0]
    fn doc() -> CaptionDoc {
        build_doc(
            source(6000),
            engine("ko"),
            vec![w(500, 900, "하나", 0), w(1000, 1400, "둘", 0), w(3000, 3500, "셋", 1)],
        )
    }

    fn ranges(p: &CaptionPlan) -> Vec<(u64, u64)> {
        p.keep.iter().map(|r| (r.start_ms, r.end_ms)).collect()
    }

    fn check_invariants(d: &CaptionDoc, p: &CaptionPlan) {
        let sum: u64 = p.keep.iter().map(|r| r.end_ms - r.start_ms).sum();
        assert_eq!(sum, p.out_duration_ms, "Σkeep = out_duration_ms");
        assert!(p.keep.windows(2).all(|w| w[0].end_ms + FRAME_MS <= w[1].start_ms), "1프레임 미만 틈이 남았다");
        assert!(p.keep.iter().all(|r| r.end_ms - r.start_ms >= FRAME_MS && r.end_ms <= d.source.duration_ms));
        assert!(p.out_cues.windows(2).all(|w| w[0].start_ms <= w[1].start_ms), "out(t) 단조");
        assert!(p.out_cues.iter().all(|c| c.end_ms <= p.out_duration_ms));
    }

    /// 편집 없음 = 전체를 남긴다(gap 전부 + 어절 패딩) — 편집본이 원본과 같다.
    #[test]
    fn plan_without_edits_keeps_everything() {
        let d = doc();
        let p = caption_plan(&d).unwrap();
        assert_eq!(ranges(&p), vec![(0, 6000)]);
        assert_eq!(p.out_duration_ms, 6000);
        assert_eq!(
            p.out_cues,
            vec![
                OutCue { cue_id: d.cues[0].id.clone(), start_ms: 500, end_ms: 1400, text: "하나 둘".into() },
                OutCue { cue_id: d.cues[1].id.clone(), start_ms: 3000, end_ms: 3500, text: "셋".into() },
            ]
        );
        check_invariants(&d, &p);
    }

    /// 컷: 어절 구간은 정확히 빠지고, 이웃 어절의 패딩이 컷 구간을 침범하지 않는다. 컷된 어절은 자막에서도 빠진다.
    #[test]
    fn plan_cut_word_clips_neighbor_padding() {
        let mut d = doc();
        d.tokens.iter_mut().find(|t| t.text == "둘").unwrap().cut = true;
        let p = caption_plan(&d).unwrap();
        // 하나 [500,900]+pad → 1100까지 원하지만 둘 [1000,1400]이 잘려 1000에서 멈춘다.
        assert_eq!(ranges(&p), vec![(0, 1000), (1400, 6000)]);
        assert_eq!(p.out_cues[0].text, "하나");
        assert_eq!((p.out_cues[0].start_ms, p.out_cues[0].end_ms), (500, 900));
        // 셋 [3000,3500] → 3000 − 잘린 400 = 2600.
        assert_eq!((p.out_cues[1].start_ms, p.out_cues[1].end_ms), (2600, 3100));
        check_invariants(&d, &p);
    }

    /// cue의 어절이 전부 잘리면 override가 있어도 cue째 빠진다. override는 남은 어절이 있을 때만 쓴다.
    #[test]
    fn plan_drops_fully_cut_cue() {
        let mut d = doc();
        d.cues[1].caption = Some("세 번째".into());
        d.cues[0].caption = Some("하나와 둘".into());
        for t in d.tokens.iter_mut().filter(|t| t.text == "셋") {
            t.cut = true;
        }
        let p = caption_plan(&d).unwrap();
        assert_eq!(p.out_cues.len(), 1);
        assert_eq!(p.out_cues[0].text, "하나와 둘");
        check_invariants(&d, &p);
    }

    /// 무음 줄이기: 1.6초 gap(1.4~3.0)을 0.6초로 — 가운데 1.0초를 덜어 양 끝 0.3초씩 남긴다.
    #[test]
    fn plan_shortens_long_gaps_to_target() {
        let mut d = doc();
        d.silence_keep_ms = Some(600);
        let p = caption_plan(&d).unwrap();
        // 머리 gap 0.5초(<0.6)는 그대로, 사이 gap은 [1400,1700]+[2700,3000], 꼬리 2.5초는 [3500,3800]+[5700,6000].
        assert_eq!(ranges(&p), vec![(0, 1700), (2700, 3800), (5700, 6000)]);
        let kept_silence = (1700 - 1400) + (3000 - 2700);
        assert_eq!(kept_silence, 600, "남은 쉼 = 목표 길이");
        assert_eq!(p.out_duration_ms, 1700 + 1100 + 300);
        check_invariants(&d, &p);
    }

    /// 조건 "2.0초 초과 → 0.6초로": 1.6초 사이 gap은 그대로, 2.5초 꼬리 gap만 줄어든다.
    #[test]
    fn plan_shortens_only_gaps_over_threshold() {
        let mut d = doc();
        d.silence_keep_ms = Some(600);
        d.silence_min_ms = Some(2000);
        let p = caption_plan(&d).unwrap();
        assert_eq!(ranges(&p), vec![(0, 3800), (5700, 6000)]);
        check_invariants(&d, &p);
    }

    /// 컷된 gap은 통째로 빠지고, 1프레임(42ms) 미만 틈은 합치고 미만 조각은 버린다.
    #[test]
    fn plan_merges_sub_frame_slivers() {
        let d = build_doc(
            source(3000),
            engine("ko"),
            // 가운데 어절 둘 사이 30ms — 둘째를 자르면 첫째 패딩과 셋째 패딩 사이가 벌어진다.
            vec![w(0, 1000, "가", 0), w(1030, 1060, "나", 0), w(1090, 2000, "다", 0)],
        );
        let mut d = d;
        d.tokens.iter_mut().find(|t| t.text == "나").unwrap().cut = true;
        let p = caption_plan(&d).unwrap();
        // 잘린 30ms(1030~1060)는 1프레임 미만 틈이라 다시 합쳐진다.
        assert_eq!(ranges(&p), vec![(0, 3000)]);
        assert!(merge(vec![(0, 100), (120, 200)], FRAME_MS) == vec![(0, 200)]);
        assert_eq!(subtract(&[(0, 100)], &[(10, 20), (50, 60)]), vec![(0, 10), (20, 50), (60, 100)]);
        check_invariants(&d, &p);
    }
}
