// 환각·시간 방어(태스크 72 §3.1) — 순수 함수. **지우지 않는다**: 시각은 고치고, 의심스러운 텍스트는
// 표시만 한다(사용자가 대본에서 보고 판단한다).

use crate::stt::doc::SttWord;

/// 시각 역전·범위 밖·겹침·길이 0을 고친다: `[0, duration]`으로 자르고, 시작을 단조 증가로, 앞 어절 끝을
/// 다음 시작에서 자르고, 길이 0 어절은 이웃과 나눠 최소 1ms를 준다(나눌 곳이 없으면 0으로 남는다 —
/// `validate_doc`은 `s ≤ e`까지만 요구한다).
pub fn fix_word_times(words: &mut [SttWord], duration_ms: u64) {
    let mut prev_start = 0u64;
    for w in words.iter_mut() {
        w.start_ms = w.start_ms.min(duration_ms).max(prev_start);
        w.end_ms = w.end_ms.min(duration_ms).max(w.start_ms);
        prev_start = w.start_ms;
    }
    for i in 1..words.len() {
        let next_start = words[i].start_ms;
        let prev = &mut words[i - 1];
        prev.end_ms = prev.end_ms.min(next_start);
    }
    for i in 0..words.len() {
        if words[i].end_ms > words[i].start_ms {
            continue;
        }
        let s = words[i].start_ms;
        // ① 다음 어절과 같은 시각에 몰렸으면(DTW가 두 어절에 같은 값을 준 경우) 다음 어절 구간을 반으로.
        if let Some(next) = words.get(i + 1) {
            if next.start_ms == s && next.end_ms > s + 1 {
                let mid = s + (next.end_ms - s) / 2;
                words[i].end_ms = mid;
                words[i + 1].start_ms = mid;
                continue;
            }
        }
        // ② 뒤에 빈 곳이 있으면 1ms.
        let limit = words.get(i + 1).map_or(duration_ms, |n| n.start_ms);
        if limit > s {
            words[i].end_ms = s + 1;
            continue;
        }
        // ③ 앞 어절 끝에 붙어 있으면 앞 어절 구간을 반으로.
        if i > 0 && words[i - 1].end_ms == s && words[i - 1].end_ms > words[i - 1].start_ms + 1 {
            let mid = words[i - 1].start_ms + (words[i - 1].end_ms - words[i - 1].start_ms) / 2;
            words[i - 1].end_ms = mid;
            words[i].start_ms = mid;
        }
    }
}

/// 비교용 정규화 — 대소문자·공백·문장부호를 무시한다("감사합니다." = "감사합니다").
fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// 같은 정규화 텍스트가 연속 3회 이상인 칸을 표시한다(whisper 환각 루프 — 같은 세그먼트를 되풀이한다).
pub fn mark_repeats(texts: &[String]) -> Vec<bool> {
    let norm: Vec<String> = texts.iter().map(|t| normalize(t)).collect();
    let mut out = vec![false; texts.len()];
    let mut i = 0;
    while i < norm.len() {
        let mut j = i + 1;
        while j < norm.len() && norm[j] == norm[i] {
            j += 1;
        }
        if j - i >= 3 && !norm[i].is_empty() {
            out[i..j].fill(true);
        }
        i = j;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::tests::w;

    fn times(ws: &[SttWord]) -> Vec<(u64, u64)> {
        ws.iter().map(|w| (w.start_ms, w.end_ms)).collect()
    }

    /// 역전·범위 밖·겹침: 범위로 자르고 단조 보정한다.
    #[test]
    fn guard_clamps_and_makes_monotonic() {
        let mut ws = vec![
            w(1000, 1500, "a", 0),
            w(800, 1200, "b", 0),  // 시작 역전 + 앞과 겹침
            w(1400, 9000, "c", 0), // 끝이 범위 밖
            w(9500, 9900, "d", 0), // 통째로 범위 밖
        ];
        fix_word_times(&mut ws, 5000);
        // a는 b와 같은 시작으로 몰려 반씩 나누고, 범위 밖 d는 끝(5000)에 붙어 c와 반씩 나눈다.
        assert_eq!(times(&ws), vec![(1000, 1100), (1100, 1200), (1400, 3200), (3200, 5000)]);
        assert!(ws.windows(2).all(|p| p[0].end_ms <= p[1].start_ms && p[0].start_ms <= p[1].start_ms));
        assert!(ws.iter().all(|w| w.start_ms <= w.end_ms && w.end_ms <= 5000));
    }

    /// 길이 0: 같은 시각에 몰린 다음 어절과 반씩 · 뒤가 비었으면 1ms · 끝에 몰렸으면 앞 어절과 반씩.
    #[test]
    fn guard_splits_zero_length_words() {
        let mut ws = vec![w(100, 100, "a", 0), w(100, 300, "b", 0), w(500, 500, "c", 0), w(900, 1000, "d", 0)];
        fix_word_times(&mut ws, 1000);
        assert_eq!(times(&ws), vec![(100, 200), (200, 300), (500, 501), (900, 1000)]);
        let mut tail = vec![w(0, 1000, "a", 0), w(1000, 1000, "b", 0)];
        fix_word_times(&mut tail, 1000);
        assert_eq!(times(&tail), vec![(0, 500), (500, 1000)]);
    }

    #[test]
    fn guard_marks_runs_of_three() {
        let t = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            mark_repeats(&t(&["안녕", "감사합니다.", "감사합니다", "감사 합니다!", "끝"])),
            vec![false, true, true, true, false]
        );
        assert_eq!(mark_repeats(&t(&["a", "a", "b", "a"])), vec![false; 4], "두 번은 반복이 아니다");
        assert_eq!(mark_repeats(&t(&["...", "...", "..."])), vec![false; 3], "빈 정규화 텍스트는 제외");
    }
}
