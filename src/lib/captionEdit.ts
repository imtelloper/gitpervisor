// 대본 편집 순수 함수(태스크 72 §3.3·§3.5) — cue 탐색·선택·나누기·합치기·단어/자막 줄 수정·찾아 바꾸기.
//
// UI·IPC와 떨어져 있어 e2e가 `__gpv.caption`으로 직접 단언한다(33 `planSegments` 선례 — TS 단위 테스트
// 러너가 없다). 문서의 원본은 Rust(`stt/doc.rs`)이고, 여기 편집은 구조(토큰 시간순 고정·cue가 순서대로
// 빈틈없이 덮음)를 건드리지 않는 것만 만든다 — 저장 때 Rust `validate_doc`이 한 번 더 막는다.
// 편집은 **바뀐 cue·토큰만 새 객체**로 만든다: 패널 행 memo와 되돌리기 스택이 참조 비교에 기댄다.
import type { CaptionCue, CaptionDoc, CaptionToken, RangeMs } from "./ipc";

export type CaptionWord = Extract<CaptionToken, { kind: "word" }>;

/** 시각 구간을 가진 것 — 토큰·cue 모두(시작순·겹침 없음이 전제). */
interface Timed {
  startMs: number;
  endMs: number;
}

// ══════════════════════════ 텍스트 (Rust doc.rs와 같은 규칙) ══════════════════════════

/** 한 줄 글자 수 — Rust `line_chars`의 거울. 번역문 줄바꿈(captionTranslate)도 대상 언어로 이것을 쓴다. */
export function captionLangLineChars(lang: string): number {
  return ["ko", "ja", "zh", "yue", "auto", ""].includes(lang) ? 16 : 42;
}

/** 문서의 줄 폭 — Rust `doc_line_chars`의 거울(감지 언어 우선). */
export function captionLineChars(engine: CaptionDoc["engine"]): number {
  return captionLangLineChars(engine.detectedLanguage ?? engine.language);
}

/** 어절을 줄 폭 안으로 채운다 — Rust `wrap_words`의 거울(글자 수 = 유니코드 스칼라 수). */
export function wrapCaptionWords(words: string[], lineChars: number): string[] {
  const lines: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const w of words) {
    const n = [...w].length;
    if (n === 0) continue;
    if (curLen > 0 && curLen + 1 + n > lineChars) {
      lines.push(cur);
      cur = "";
      curLen = 0;
    }
    if (curLen > 0) {
      cur += " ";
      curLen += 1;
    }
    cur += w;
    curLen += n;
  }
  if (curLen > 0) lines.push(cur);
  return lines;
}

/** 프로그램이 만드는 override(합치기·나누기·구절 바꾸기)는 줄 폭으로 다시 줄바꿈한다 — SRT에 한 줄로 길게 나가지 않게. */
function wrapText(text: string, lineChars: number): string {
  return wrapCaptionWords(text.split(/\s+/), lineChars).join("\n");
}

/** cue → 토큰 인덱스 구간 [첫, 끝](포함). validate_doc을 통과한 문서가 전제다. */
export function captionCueSpans(doc: CaptionDoc): Array<[number, number]> {
  const index = new Map(doc.tokens.map((t, i) => [t.id, i]));
  return doc.cues.map((c) => [index.get(c.firstTokenId) ?? -1, index.get(c.lastTokenId) ?? -1]);
}

function spanWords(doc: CaptionDoc, span: [number, number], includeCut = true): CaptionWord[] {
  const out: CaptionWord[] = [];
  for (let i = span[0]; i <= span[1]; i++) {
    const t = doc.tokens[i];
    if (t.kind === "word" && (includeCut || !t.cut)) out.push(t);
  }
  return out;
}

/** 인식 텍스트(줄바꿈 없음) — 자막 줄 override와 비교·찾기에 쓴다. 앱이 override를 만들 때는 `includeCut=false`
 *  (override는 컷보다 앞서므로 — Rust `cue_text` — 잘린 어절을 실으면 영상에서 지운 말이 편집본 자막에 되살아난다). */
export function captionRecognizedText(doc: CaptionDoc, span: [number, number], includeCut = true): string {
  return joinedWords(doc, span, includeCut).joined;
}

/** 자막 줄 — override가 있으면 그것, 없으면 어절을 줄 폭으로 줄바꿈(Rust `cue_text`). */
export function captionCueText(
  doc: CaptionDoc,
  cue: CaptionCue,
  span: [number, number],
  includeCut = true,
): string {
  if (cue.caption && cue.caption.trim()) return cue.caption;
  return wrapCaptionWords(
    spanWords(doc, span, includeCut).map((w) => w.text.trim()),
    captionLineChars(doc.engine),
  ).join("\n");
}

export interface CaptionTimedCue {
  cueId: string;
  startMs: number;
  endMs: number;
  text: string;
}

/** 원본 시각 cue — 첫 어절 시작~마지막 어절 끝(Rust `subs::source_cues`). 어절이 없는 cue는 뺀다.
 *  오버레이·패널 시각은 이것만 본다(편집본 시각은 저장 응답의 plan.outCues — 계획 구현은 Rust 하나).
 *  `includeCut=false`는 편집 반영 재생의 오버레이용 — 잘린 어절을 글과 구간에서 빼고, 전부 잘린 cue는 뺀다. */
export function captionSourceCues(doc: CaptionDoc, includeCut = true): CaptionTimedCue[] {
  const spans = captionCueSpans(doc);
  const out: CaptionTimedCue[] = [];
  doc.cues.forEach((cue, i) => {
    const words = spanWords(doc, spans[i], includeCut);
    if (words.length === 0) return;
    out.push({
      cueId: cue.id,
      startMs: words[0].startMs,
      endMs: words[words.length - 1].endMs,
      text: captionCueText(doc, cue, spans[i], includeCut),
    });
  });
  return out;
}

/** ms를 품은 항목의 인덱스(start ≤ ms < end), 없으면 -1 — 이진 탐색(재생 중 매 프레임 불린다). */
export function captionIndexAt(items: readonly Timed[], ms: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && ms < items[ans].endMs ? ans : -1;
}

/** 토큰 인덱스 k가 든 cue 인덱스(spans는 연속·전체 덮음이 전제), 없으면 -1. */
export function captionCueOfToken(spans: ReadonlyArray<[number, number]>, k: number): number {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (k < spans[mid][0]) hi = mid - 1;
    else if (k > spans[mid][1]) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ══════════════════════════ 선택 ══════════════════════════

/** 앵커(처음 누른 토큰)와 포커스(Shift+클릭·드래그 끝) — 둘 다 토큰 id. */
export interface CaptionSelection {
  anchorId: string;
  focusId: string;
}

/** 선택의 토큰 인덱스 구간 [lo, hi]. 토큰이 사라졌으면(다시 읽기) null. */
export function captionSelectionRange(
  doc: CaptionDoc,
  sel: CaptionSelection | null,
): [number, number] | null {
  if (!sel) return null;
  const a = doc.tokens.findIndex((t) => t.id === sel.anchorId);
  const f = sel.focusId === sel.anchorId ? a : doc.tokens.findIndex((t) => t.id === sel.focusId);
  if (a < 0 || f < 0) return null;
  return a <= f ? [a, f] : [f, a];
}

/** 선택을 **cue 단위로 넓힌** 시각 구간 — "선택한 cue → 구간(In/Out)"(§3.6). 어절 첫 시작~끝, 어절이 없으면 토큰 시각. */
export function captionSelectionTimeRange(
  doc: CaptionDoc,
  spans: ReadonlyArray<[number, number]>,
  range: [number, number],
): { startMs: number; endMs: number } | null {
  const c0 = captionCueOfToken(spans, range[0]);
  const c1 = captionCueOfToken(spans, range[1]);
  if (c0 < 0 || c1 < 0) return null;
  const whole: [number, number] = [spans[c0][0], spans[c1][1]];
  const words = spanWords(doc, whole);
  const first = words[0] ?? doc.tokens[whole[0]];
  const last = words[words.length - 1] ?? doc.tokens[whole[1]];
  return last.endMs > first.startMs ? { startMs: first.startMs, endMs: last.endMs } : null;
}

// ══════════════════════════ 나누기·합치기 ══════════════════════════

/** 새 cue id — Rust는 토큰·cue가 번호 하나를 같이 쓴다(`t1`…`c9`). 겹치지 않게 전체 최대 번호 다음을 쓴다. */
function nextCueId(doc: CaptionDoc): string {
  let max = 0;
  for (const x of [...doc.tokens, ...doc.cues]) {
    const m = /(\d+)$/.exec(x.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}

/** caption·suspect 키를 조건부로 — undefined 값을 싣지 않는다(직렬화 결과를 Rust 쪽과 같게). */
function withCaption(cue: CaptionCue, caption: string | undefined): CaptionCue {
  const out: CaptionCue = { id: cue.id, firstTokenId: cue.firstTokenId, lastTokenId: cue.lastTokenId };
  if (cue.suspect) out.suspect = cue.suspect;
  if (caption && caption.trim()) out.caption = caption;
  return out;
}

/**
 * tokenId **앞에서** cue를 나눈다 — 그 토큰이 새 cue의 첫 토큰이 된다. cue의 첫 토큰이면 null(나눌 곳 없음).
 * 자막 줄 override가 있으면 어절 수 비율로 갈라 양쪽에 준다 — 한쪽에 통째로 남기면 두 구간에 같은 글이 겹쳐
 * 보이고, 지우면 사용자가 고친 글이 사라진다(Ctrl+Z로 되돌릴 수 있다).
 */
export function splitCaptionCue(doc: CaptionDoc, tokenId: string): CaptionDoc | null {
  const k = doc.tokens.findIndex((t) => t.id === tokenId);
  if (k < 0) return null;
  const spans = captionCueSpans(doc);
  const ci = captionCueOfToken(spans, k);
  if (ci < 0 || spans[ci][0] === k) return null;
  const cue = doc.cues[ci];
  let capA: string | undefined;
  let capB: string | undefined;
  if (cue.caption && cue.caption.trim()) {
    const wa = spanWords(doc, [spans[ci][0], k - 1]).length;
    const wb = spanWords(doc, [k, spans[ci][1]]).length;
    const words = cue.caption.trim().split(/\s+/);
    const cut = wa + wb === 0 ? words.length : Math.round((words.length * wa) / (wa + wb));
    const lc = captionLineChars(doc.engine);
    capA = wrapText(words.slice(0, cut).join(" "), lc) || undefined;
    capB = wrapText(words.slice(cut).join(" "), lc) || undefined;
  }
  const a = withCaption({ ...cue, lastTokenId: doc.tokens[k - 1].id }, capA);
  const b = withCaption({ ...cue, id: nextCueId(doc), firstTokenId: doc.tokens[k].id }, capB);
  const cues = [...doc.cues.slice(0, ci), a, b, ...doc.cues.slice(ci + 1)];
  return { ...doc, cues };
}

/**
 * cue i와 i+1을 합친다(i+1이 없으면 null). 둘 중 하나라도 override가 있으면 두 자막 줄(override 또는 잘린 어절을 뺀
 * 인식 텍스트)을 이어 붙인 것이 새 override가 된다 — 한쪽 수정만 남기면 다른 쪽 글이 사라진다.
 */
export function mergeCaptionCues(doc: CaptionDoc, i: number): CaptionDoc | null {
  if (i < 0 || i + 1 >= doc.cues.length) return null;
  const spans = captionCueSpans(doc);
  const a = doc.cues[i];
  const b = doc.cues[i + 1];
  const hasA = !!a.caption?.trim();
  const hasB = !!b.caption?.trim();
  let caption: string | undefined;
  if (hasA || hasB) {
    const ta = hasA ? a.caption!.trim() : captionRecognizedText(doc, spans[i], false);
    const tb = hasB ? b.caption!.trim() : captionRecognizedText(doc, spans[i + 1], false);
    caption = wrapText([ta, tb].filter(Boolean).join(" "), captionLineChars(doc.engine));
  }
  const merged = withCaption({ ...a, lastTokenId: b.lastTokenId, suspect: a.suspect ?? b.suspect }, caption);
  return { ...doc, cues: [...doc.cues.slice(0, i), merged, ...doc.cues.slice(i + 2)] };
}

// ══════════════════════════ 텍스트 수정 ══════════════════════════

/** 단어 텍스트 수정(인식 교정 — 시각은 그대로). 빈 텍스트·gap·변화 없음은 null(저장 검증이 빈 단어를 막는다). */
export function setCaptionWordText(doc: CaptionDoc, tokenId: string, text: string): CaptionDoc | null {
  const k = doc.tokens.findIndex((t) => t.id === tokenId);
  const t = doc.tokens[k];
  const next = text.trim();
  if (!t || t.kind !== "word" || !next || next === t.text) return null;
  const tokens = doc.tokens.slice();
  tokens[k] = { ...t, text: next };
  return { ...doc, tokens };
}

/** 자막 줄 override 설정 — null·빈 값·(잘린 어절을 뺀) 인식 텍스트와 같은 값이면 override를 지운다("인식 텍스트
 *  따라가기"). 비교 기준이 자막 줄 표시·입력 초기값(잘린 어절 뺌)과 같아야 고치지 않고 확정한 줄이 override가 되지 않는다. */
export function setCaptionCueCaption(doc: CaptionDoc, cueId: string, caption: string | null): CaptionDoc | null {
  const i = doc.cues.findIndex((c) => c.id === cueId);
  if (i < 0) return null;
  const cue = doc.cues[i];
  const text = caption?.trim() ?? "";
  const recognized = captionRecognizedText(doc, captionCueSpans(doc)[i], false);
  const want = text && text.replace(/\s+/g, " ") !== recognized ? text : undefined;
  if ((cue.caption?.trim() || undefined) === want) return null;
  const cues = doc.cues.slice();
  cues[i] = withCaption(cue, want);
  return { ...doc, cues };
}

// ══════════════════════════ 찾기·바꾸기 ══════════════════════════

/**
 * 찾은 곳 하나. `word` = 한 단어 안(단어 텍스트를 고친다), `span` = 단어 경계를 넘는 구절(토큰은 합치지 않으므로
 * 자막 줄 override로 고친다), `caption` = 이미 override가 있는 자막 줄 안. start/end는 각 텍스트 안의 오프셋.
 * tokenId는 이동·강조할 토큰(caption이면 cue의 첫 단어).
 */
export interface CaptionMatch {
  cueIndex: number;
  kind: "word" | "span" | "caption";
  tokenId: string | null;
  start: number;
  end: number;
}

/** 인식 단어를 공백 하나로 이은 글과 각 단어의 시작 오프셋 — 찾기와 구절 바꾸기가 같은 좌표를 쓴다. */
function joinedWords(doc: CaptionDoc, span: [number, number], includeCut = true) {
  const words = spanWords(doc, span, includeCut);
  const offs: number[] = [];
  let joined = "";
  for (const w of words) {
    if (joined) joined += " ";
    offs.push(joined.length);
    joined += w.text.trim();
  }
  return { words, offs, joined };
}

function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  const h = hay.toLowerCase();
  for (let at = h.indexOf(needle); at >= 0; at = h.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

/** 대소문자 무시 부분 일치 — 자막 줄 override가 있는 cue는 그 글에서, 없으면 인식 단어를 이은 글에서 찾는다. */
export function findCaptionMatches(doc: CaptionDoc, query: string): CaptionMatch[] {
  const q = query.toLowerCase();
  if (!q.trim()) return [];
  const spans = captionCueSpans(doc);
  const out: CaptionMatch[] = [];
  doc.cues.forEach((cue, ci) => {
    const { words, offs, joined } = joinedWords(doc, spans[ci]);
    if (cue.caption?.trim()) {
      for (const at of occurrences(cue.caption, q))
        out.push({ cueIndex: ci, kind: "caption", tokenId: words[0]?.id ?? null, start: at, end: at + q.length });
      return;
    }
    for (const at of occurrences(joined, q)) {
      const end = at + q.length;
      // 시작이 든 단어 — 뒤에서부터 첫 offs ≤ at.
      let wi = offs.length - 1;
      while (wi > 0 && offs[wi] > at) wi--;
      const wEnd = offs[wi] + words[wi].text.trim().length;
      if (end <= wEnd)
        out.push({ cueIndex: ci, kind: "word", tokenId: words[wi].id, start: at - offs[wi], end: end - offs[wi] });
      else out.push({ cueIndex: ci, kind: "span", tokenId: words[wi].id, start: at, end });
    }
  });
  return out;
}

/** 겹치지 않는 구간들을 바꾼다 — 구간에 `repl`이 있으면 그것으로(구절 바꾸기의 잘린 어절 빼기). */
function spliceAll(text: string, cuts: ReadonlyArray<{ start: number; end: number; repl?: string }>, repl: string): string {
  let s = text;
  for (const c of [...cuts].sort((a, b) => b.start - a.start)) s = s.slice(0, c.start) + (c.repl ?? repl) + s.slice(c.end);
  return s;
}

/**
 * 바꾸기(텍스트만 — 시각·컷은 그대로). `only`를 주면 그 한 곳만, 아니면 찾은 곳 전부. 한 번의 호출이 되돌리기 한 단계다.
 * cue마다: override가 있으면 그 글을 고치고, 구절이 단어 경계를 넘으면 override를 만들고(토큰은 합치지 않는다),
 * 아니면 단어 텍스트를 고친다. 단어가 비게 되는 바꾸기는 건너뛴다(저장 검증이 빈 단어를 거절한다).
 */
export function replaceCaptionMatches(
  doc: CaptionDoc,
  query: string,
  replacement: string,
  only?: CaptionMatch,
): { doc: CaptionDoc; replaced: number } {
  const all = only ? [only] : findCaptionMatches(doc, query);
  if (all.length === 0) return { doc, replaced: 0 };
  const spans = captionCueSpans(doc);
  const lc = captionLineChars(doc.engine);
  const byCue = new Map<number, CaptionMatch[]>();
  for (const m of all) byCue.set(m.cueIndex, [...(byCue.get(m.cueIndex) ?? []), m]);

  let tokens = doc.tokens;
  let cues = doc.cues;
  let replaced = 0;
  for (const [ci, ms] of byCue) {
    const cue = doc.cues[ci];
    if (cue.caption?.trim()) {
      if (cues === doc.cues) cues = cues.slice();
      cues[ci] = withCaption(cue, spliceAll(cue.caption, ms, replacement));
      replaced += ms.length;
    } else if (ms.some((m) => m.kind === "span")) {
      // 한 단어 안 일치는 단어 기준 오프셋이다 — 이은 글 좌표로 옮겨 한 번에 바꾼다.
      const { words, offs, joined } = joinedWords(doc, spans[ci]);
      const cuts = ms.map((m) => {
        if (m.kind !== "word") return m;
        const base = offs[words.findIndex((w) => w.id === m.tokenId)];
        return { start: base + m.start, end: base + m.end };
      });
      // 잘린 어절은 override에 싣지 않는다(captionRecognizedText 주석). 바꾸기가 닿은 잘린 어절은 사용자가 고른 곳이라
      // 바꾼 글로 남긴다.
      const drops = words.flatMap((w, j) => {
        const s = offs[j];
        const e = s + w.text.trim().length;
        return w.cut && !cuts.some((c) => c.start < e && c.end > s) ? [{ start: s, end: e, repl: "" }] : [];
      });
      if (cues === doc.cues) cues = cues.slice();
      cues[ci] = withCaption(cue, wrapText(spliceAll(joined, [...cuts, ...drops], replacement), lc));
      replaced += ms.length;
    } else {
      const byTok = new Map<string, CaptionMatch[]>();
      for (const m of ms) byTok.set(m.tokenId!, [...(byTok.get(m.tokenId!) ?? []), m]);
      for (const [tid, tm] of byTok) {
        const k = doc.tokens.findIndex((t) => t.id === tid);
        const t = doc.tokens[k];
        if (!t || t.kind !== "word") continue;
        const next = spliceAll(t.text.trim(), tm, replacement).trim();
        if (!next) continue;
        if (tokens === doc.tokens) tokens = tokens.slice();
        tokens[k] = { ...t, text: next };
        replaced += tm.length;
      }
    }
  }
  return replaced === 0 ? { doc, replaced } : { doc: { ...doc, tokens, cues }, replaced };
}

// ══════════════════════════ 컷·무음 줄이기 (P2) ══════════════════════════
//
// 잘라도 토큰은 지우지 않는다 — `cut` 표시만 바꾸고, 남길 구간(keep)은 저장 응답의 plan(Rust `caption_plan`)만 계산한다.

/** 컷 편집을 해도 되는 문서인가 — 단어 시각이 근사(`approx`)면 컷 위치가 말과 어긋난다(Rust `cut_keep_at`도 내보내기를 거절). */
export function captionCutAllowed(doc: CaptionDoc): boolean {
  return doc.engine.wordTiming === "dtw";
}

/** 고른 토큰의 cut을 바꾼다 — 바뀐 토큰만 새 객체, 바뀐 것이 없으면 null. */
function setTokensCut(doc: CaptionDoc, pick: (t: CaptionToken, i: number) => boolean, cut: boolean): CaptionDoc | null {
  let tokens: CaptionToken[] | null = null;
  for (let i = 0; i < doc.tokens.length; i++) {
    const t = doc.tokens[i];
    if (t.cut === cut || !pick(t, i)) continue;
    if (!tokens) tokens = doc.tokens.slice();
    tokens[i] = { ...t, cut };
  }
  return tokens ? { ...doc, tokens } : null;
}

/** 토큰 인덱스 구간 [lo, hi](쉼 포함)의 컷 토글 — 전부 잘려 있으면 복구, 아니면 전부 자른다. 근사 문서는 자르지 않는다(복구는 된다). */
export function toggleCaptionCut(doc: CaptionDoc, range: [number, number]): CaptionDoc | null {
  const slice = doc.tokens.slice(range[0], range[1] + 1);
  if (slice.length === 0) return null;
  const cut = !slice.every((t) => t.cut);
  if (cut && !captionCutAllowed(doc)) return null;
  return setTokensCut(doc, (_, i) => i >= range[0] && i <= range[1], cut);
}

/** 토큰 id들을 자른다(일괄 컷 — 되돌리기 한 단계). 근사 문서·바뀐 것 없음은 null. */
export function cutCaptionTokens(doc: CaptionDoc, ids: Iterable<string>): CaptionDoc | null {
  if (!captionCutAllowed(doc)) return null;
  const set = new Set(ids);
  return set.size === 0 ? null : setTokensCut(doc, (t) => set.has(t.id), true);
}

/** 문장부호·기호·공백뿐인가(빈 글 포함). */
function punctOnly(s: string): boolean {
  return s.replace(/[\p{P}\p{S}\s]/gu, "") === "";
}

/**
 * "찾은 곳 모두 컷" — 찾은 곳 → 자를 토큰 id. 단어 **전체**(앞뒤 문장부호 무시)와 맞은 곳, 단어 경계에서 시작·끝나는
 * 구절(사이 쉼까지)만 자른다 — "어"를 찾아 "어떻게"를 자르면 안 된다. 자막 줄 override 안에서 찾은 곳은 영상 단어와
 * 이어지지 않으므로 건너뛴다. places = 자를 곳 수, skipped = 건너뛴 곳 수.
 */
export function captionMatchCutIds(
  doc: CaptionDoc,
  matches: readonly CaptionMatch[],
): { ids: string[]; places: number; skipped: number } {
  const spans = captionCueSpans(doc);
  const index = new Map(doc.tokens.map((t, i) => [t.id, i]));
  const ids = new Set<string>();
  let places = 0;
  let skipped = 0;
  for (const m of matches) {
    if (m.kind === "caption" || !m.tokenId) {
      skipped++;
      continue;
    }
    if (m.kind === "word") {
      const t = doc.tokens[index.get(m.tokenId) ?? -1];
      const text = t?.kind === "word" ? t.text.trim() : "";
      if (!text || !punctOnly(text.slice(0, m.start)) || !punctOnly(text.slice(m.end))) {
        skipped++;
        continue;
      }
      ids.add(m.tokenId);
      places++;
      continue;
    }
    // 구절 — 이은 글 좌표에서 시작·끝 단어를 찾는다(findCaptionMatches와 같은 좌표).
    const { words, offs } = joinedWords(doc, spans[m.cueIndex]);
    const wordAt = (at: number) => {
      let wi = offs.length - 1;
      while (wi > 0 && offs[wi] > at) wi--;
      return wi;
    };
    const a = wordAt(m.start);
    const b = wordAt(m.end - 1);
    const head = words[a]?.text.trim().slice(0, m.start - offs[a]) ?? "x";
    const tail = words[b]?.text.trim().slice(m.end - offs[b]) ?? "x";
    if (!punctOnly(head) || !punctOnly(tail)) {
      skipped++;
      continue;
    }
    const lo = index.get(words[a].id) ?? -1;
    const hi = index.get(words[b].id) ?? -1;
    for (let i = lo; i >= 0 && i <= hi; i++) ids.add(doc.tokens[i].id);
    places++;
  }
  return { ids: [...ids], places, skipped };
}

/** 추임새 기본 목록 — 사용자가 고친다(로컬 저장). Whisper는 추임새를 전사에서 빼는 경향이 있어 목록은 보조 수단이다(§2.3). */
export const DEFAULT_CAPTION_FILLERS: readonly string[] = ["음", "어", "아", "그", "저기", "흠", "um", "uh"]; // i18n-ok: 음성 군말 데이터(받아쓰기 언어, UI 문구 아님)

/** 입력 글 → 추임새 목록(쉼표·공백으로 나눈다 — 항목 하나 = 단어 하나). */
export function parseCaptionFillers(text: string): string[] {
  return text.split(/[,\s]+/).filter(Boolean);
}

function fillerKey(s: string): string {
  return s.trim().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "").toLowerCase();
}

/** 추임새 목록과 **단어 전체**(앞뒤 문장부호 무시·대소문자 무시)가 같은, 아직 안 잘린 단어 id. */
export function captionFillerIds(doc: CaptionDoc, fillers: readonly string[]): string[] {
  const set = new Set(fillers.map(fillerKey).filter(Boolean));
  if (set.size === 0) return [];
  return doc.tokens.filter((t) => t.kind === "word" && !t.cut && set.has(fillerKey(t.text))).map((t) => t.id);
}

/**
 * 무음 줄이기가 이 쉼을 줄이는가 — 줄이면 남는 길이(ms), 아니면 null. 조건은 Rust `caption_plan` 2단계와 같다
 * (`길이 > max(목표, 조건)`, 잘린 쉼은 제외).
 */
export function captionGapKeptMs(
  gap: CaptionToken,
  keepMs: number | undefined,
  minMs: number | undefined,
): number | null {
  if (gap.kind !== "gap" || gap.cut || keepMs == null) return null;
  return gap.endMs - gap.startMs > Math.max(keepMs, minMs ?? 0) ? keepMs : null;
}

export interface CaptionSilenceHit {
  tokenId: string;
  startMs: number;
  endMs: number;
  /** 줄어드는 길이 = 쉼 길이 − 목표(가운데를 덜어 낸다 — 설계 9절 11). */
  savedMs: number;
}

/** 무음 줄이기 적용 전 검토 목록 — "minMs 초과 → keepMs로"에 걸리는 쉼과 줄어드는 길이. 실제 남는 구간은 저장 뒤 plan이 정한다. */
export function captionSilenceCandidates(doc: CaptionDoc, minMs: number, keepMs: number): CaptionSilenceHit[] {
  const out: CaptionSilenceHit[] = [];
  for (const t of doc.tokens) {
    const kept = captionGapKeptMs(t, keepMs, minMs);
    if (kept != null) out.push({ tokenId: t.id, startMs: t.startMs, endMs: t.endMs, savedMs: t.endMs - t.startMs - kept });
  }
  return out;
}

/**
 * 무음 줄이기 적용(`{minMs, keepMs}`) / 복구(null — 두 필드를 지운다). 되돌리기 한 단계. 값은 정수 ms(Rust u64) —
 * 아니면 null. 근사 문서에는 적용하지 않는다(복구는 된다). 바뀐 것이 없으면 null.
 */
export function setCaptionSilence(
  doc: CaptionDoc,
  silence: { minMs: number; keepMs: number } | null,
): CaptionDoc | null {
  if (!silence) {
    if (doc.silenceKeepMs == null && doc.silenceMinMs == null) return null;
    const next = { ...doc };
    delete next.silenceKeepMs;
    delete next.silenceMinMs;
    return next;
  }
  const { minMs, keepMs } = silence;
  if (![minMs, keepMs].every((v) => Number.isInteger(v) && v >= 0) || !captionCutAllowed(doc)) return null;
  if (doc.silenceKeepMs === keepMs && doc.silenceMinMs === minMs) return null;
  return { ...doc, silenceKeepMs: keepMs, silenceMinMs: minMs };
}

/**
 * 편집 반영 재생 — 문서 시각 ms가 남는 구간 안이면 null, 잘린 곳이면 다음 남는 구간의 시작, 마지막 구간 뒤면 -1(끝).
 * 시작 1ms 앞까지는 안으로 본다 — 구간 시작으로 옮긴 직후 부동소수 오차로 그 바로 앞이 읽히면 같은 자리로 매 프레임
 * 다시 옮겨 재생이 멈춘다.
 */
export function captionPlaySkipTo(keep: readonly RangeMs[], ms: number): number | null {
  let lo = 0;
  let hi = keep.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keep[mid].endMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= keep.length) return -1;
  return ms >= keep[lo].startMs - 1 ? null : keep[lo].startMs;
}

/** 남는 구간(plan.keep)의 여집합 = 편집본에서 빠지는 구간 — 타임라인 빗금. */
export function captionRemovedRanges(keep: readonly RangeMs[], durationMs: number): RangeMs[] {
  const out: RangeMs[] = [];
  let at = 0;
  for (const r of keep) {
    if (r.startMs > at) out.push({ startMs: at, endMs: r.startMs });
    at = Math.max(at, r.endMs);
  }
  if (durationMs > at) out.push({ startMs: at, endMs: durationMs });
  return out;
}
