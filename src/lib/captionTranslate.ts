// 자막 번역(태스크 72 §3.7, P4) — cue 글을 로컬 LLM으로 번역해 문서 `translations[lang][cueId]`에 붙인다.
//
// - **타임코드는 LLM에 보내지 않는다**: 배치 안 번호(1..N)만 보내고 cue id로 다시 붙이므로 시각이 망가질 수 없다.
// - 응답 검증(번호 집합 일치·줄마다 베낀 원문 일치·빈 줄/중복 없음·잘리지 않음)이 실패하면 temperature 0으로 한 번
//   더 → 배치를 반으로 → 한 줄까지. 한 줄도 안 되면 그 cue만 비워 두고 넘어간다(다음 "이어서 번역"이 그 줄만 다시 한다).
// - 번역의 원문 = 원본 시각 cue 글(잘린 어절 포함, Rust `source_cues`) — 원본·편집본 어느 시각으로 내보내도 모든 cue에
//   번역이 있게. 번역할 때 원문의 해시를 `translationSrc`에 같이 적어, 원문을 고친 cue를 "원문이 바뀜"으로 알아본다.
// - 순수 함수 + 주입된 `chat` — LLM 호출·Busy 재시도는 스토어가 `chatWithBusyRetry`로 넣는다. e2e는 `__gpv.caption`에
//   가짜 chat을 넣어 배치·검증·쪼개기를 결정적으로 단언한다(TS 단위 테스트 러너가 없다).
import { captionLangLineChars, captionSourceCues, wrapCaptionWords } from "./captionEdit";
import { fnv16 } from "./floating";
import type { CaptionDoc } from "./ipc";
import type { ChatMsg } from "./llm";
import { langName } from "./llm";

/** 번역 대상 언어 — Vrew의 "100개 언어"는 약속하지 않는다(로컬 소형 모델이 버티는 언어만). */
export const CAPTION_TRANSLATE_LANGS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "영어" },
  { code: "ja", label: "일본어" },
  { code: "zh", label: "중국어" },
  { code: "es", label: "스페인어" },
  { code: "fr", label: "프랑스어" },
  { code: "de", label: "독일어" },
  { code: "vi", label: "베트남어" },
];

export function captionLangLabel(code: string): string {
  return CAPTION_TRANSLATE_LANGS.find((l) => l.code === code)?.label ?? code;
}

/** 번역할 cue 하나 — `src`는 원문 해시(번역과 같이 저장). */
export interface CaptionTranslateItem {
  cueId: string;
  text: string;
  src: string;
}

/** 번역 결과 하나(문서에 쓸 값). */
export interface CaptionTranslated {
  cueId: string;
  text: string;
  src: string;
}

export function captionTranslationSrc(text: string): string {
  return fnv16(text);
}

/** 번역할 수 있는 모든 cue(어절이 있는 cue) — 원본 시각 cue 글과 그 해시. */
export function captionTranslateItems(doc: CaptionDoc): CaptionTranslateItem[] {
  return captionSourceCues(doc, true).map((c) => ({ cueId: c.cueId, text: c.text, src: captionTranslationSrc(c.text) }));
}

export type CaptionTranslationState = "done" | "stale" | "missing";

/** 번역이 없거나 비었으면 missing, 번역할 때의 원문 해시가 지금과 다르면 stale. 해시가 없으면(손으로 만든 문서) 믿는다. */
export function captionTranslationState(
  doc: CaptionDoc,
  lang: string,
  item: CaptionTranslateItem,
): CaptionTranslationState {
  if (!doc.translations?.[lang]?.[item.cueId]?.trim()) return "missing";
  const src = doc.translationSrc?.[lang]?.[item.cueId];
  return src != null && src !== item.src ? "stale" : "done";
}

/** 이어서 번역할 cue — 빠진 것과 원문이 바뀐 것. */
export function captionTranslatePending(doc: CaptionDoc, lang: string): CaptionTranslateItem[] {
  return captionTranslateItems(doc).filter((it) => captionTranslationState(doc, lang, it) !== "done");
}

/** 번역 현황. `cueIds`를 주면 그 cue만 센다(내보낼 줄 — 편집본이면 plan.outCues). */
export function captionTranslationCounts(
  doc: CaptionDoc,
  lang: string,
  cueIds?: ReadonlySet<string>,
): { total: number; done: number; stale: number; missing: number } {
  const n = { total: 0, done: 0, stale: 0, missing: 0 };
  for (const it of captionTranslateItems(doc)) {
    if (cueIds && !cueIds.has(it.cueId)) continue;
    n.total++;
    n[captionTranslationState(doc, lang, it)]++;
  }
  return n;
}

/** 번역이 한 줄이라도 있는 언어들(오버레이 2단·내보내기 선택지). */
export function captionTranslationLangs(doc: CaptionDoc | null): string[] {
  return Object.entries(doc?.translations ?? {})
    .filter(([, m]) => Object.values(m).some((t) => t.trim()))
    .map(([lang]) => lang);
}

/** 번역 패널의 기본 대상 — 이미 번역한 언어, 없으면 한국어 영상은 영어로·그 밖은 한국어로. */
export function captionDefaultTranslateLang(doc: CaptionDoc | null): string {
  const have = captionTranslationLangs(doc)[0];
  if (have) return have;
  const src = doc?.engine.detectedLanguage ?? doc?.engine.language;
  return src === "ko" ? "en" : "ko";
}

// ══════════════════════════ 배치·프롬프트·응답 검증 ══════════════════════════

/** 한 배치 최대 줄 수 — 작은 모델은 줄이 많으면 번호를 건너뛴다. */
const MAX_BATCH_LINES = 40;
/** system 프롬프트 + 채팅 틀의 토큰 여유. */
const PROMPT_OVERHEAD_TOKENS = 320;

/**
 * 배치 글자 예산 — 입력은 한글 최악 1자 ≈ 1토큰, 응답 상한은 입력의 2배(`captionTranslateMaxTokens`)라 셋을 합쳐
 * 컨텍스트(`llmContext`, 2048..32768)에 들어가게. 상한 1,500자(≈ 30~40 cue, §3.7) — 컨텍스트가 커도 한 번에 많이
 * 보내면 작은 모델이 줄을 놓친다.
 */
export function captionTranslateBudget(ctx: number): number {
  return Math.min(1500, Math.floor((ctx - PROMPT_OVERHEAD_TOKENS) / 3));
}

/** 번호 줄 — cue 안 줄바꿈은 ` ⏎ `(한 cue = 한 줄 규약을 지키려고). */
function numberedLine(n: number, text: string): string {
  return `${n}|${text.replace(/\s*\n\s*/g, " ⏎ ")}`;
}

/** cue 순서대로 예산·줄 수 안에서 묶는다. 예산보다 긴 cue 하나는 혼자 한 배치다. */
export function batchCaptionItems(items: readonly CaptionTranslateItem[], budget: number): CaptionTranslateItem[][] {
  const out: CaptionTranslateItem[][] = [];
  let cur: CaptionTranslateItem[] = [];
  let size = 0;
  for (const it of items) {
    const n = numberedLine(cur.length + 1, it.text).length + 1;
    if (cur.length > 0 && (size + n > budget || cur.length >= MAX_BATCH_LINES)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(it);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 요청 메시지. **응답에 원문을 베껴 쓰게 한다**(`번호|원문 => 번역`) — 실측(2026-09-22, Qwen3 4B):
 * - `번호|번역`만 받으면 모델이 문장 단위로 뜻을 옮겨 담아 번호 개수는 맞는데 내용이 한 줄씩 밀렸다(3번에 4번 뜻,
 *   마지막 줄 소실). 번호 검사로는 못 잡는다. 베낀 원문을 대조하면 밀린 응답이 형식 오류가 돼 다시 묻기·쪼개기로 간다.
 * - 구분자를 `|`로 두면 영어 → 한국어에서 입력을 그대로 베끼고 끝냈다(두 번 다). `=>`는 "바꿔 쓰라"로 읽힌다.
 */
export function captionTranslateMessages(batch: readonly CaptionTranslateItem[], lang: string): ChatMsg[] {
  const name = langName(lang);
  const system =
    `You translate video subtitles into ${name}. ` +
    `Each input line is "<number>|<subtitle>"; " ⏎ " marks a line break inside one subtitle. ` +
    `The subtitles are fragments of spoken sentences split by timing, so a sentence often continues on the next line. ` +
    `Translate line by line: the translation for a number carries only the meaning of that same line, ` +
    `even when ${name} word order differs — keep a fragment a fragment. Use neighbouring lines only for context. ` +
    `Reply with exactly ${batch.length} line${batch.length === 1 ? "" : "s"}, one per input line in the same order, ` +
    `each formatted "<number>|<the subtitle copied exactly> => <its ${name} translation>". ` +
    `Do not merge, split, skip or add lines. No preface, notes or code fences.`;
  return [
    { role: "system", content: system },
    { role: "user", content: batch.map((it, i) => numberedLine(i + 1, it.text)).join("\n") },
  ];
}

/** 응답 상한 — 베낀 원문 + 번역문(원문과 토큰이 비슷하다, 한↔영)이라 입력의 2배 + 64. */
export function captionTranslateMaxTokens(messages: readonly ChatMsg[]): number {
  const user = messages[messages.length - 1]?.content ?? "";
  return user.length * 2 + 64;
}

/** 베낀 원문과 번역 사이 구분자 — 요청은 `=>`지만 모델이 `|`·`→`로 바꿔 쓴다. */
const ECHO_SEP = /\s*(?:=>|→|[|｜])\s*/;

/** 번역문 한 줄 정리 — ⏎·줄바꿈·연속 공백을 공백 하나로, 앞뒤에 남은 구분자는 뗀다(작은 모델이 줄 끝에 붙인다). */
function cleanTranslation(s: string): string {
  return s
    .replace(/\s*⏎\s*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:=>|→|[|｜\s])+|(?:=>|→|[|｜\s])+$/g, "");
}

/** 베낀 원문 대조 키 — 공백·문장부호·기호(⏎ 포함)·대소문자 차이는 같은 줄로 본다. 실측: 일본어로 번역할 때 4B 모델이
 *  베낀 원문의 `.`·`,`를 `。`·`、`로 바꿨다 — 그것까지 틀렸다고 보면 배치가 줄마다 쪼개져 호출이 두 배가 된다. */
function echoKey(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

/**
 * `원문 => 번역` → 번역. 앞부분이 원문과 맞는 구분자 자리를 찾는다(원문 안의 `|`·`=>`도 견딘다). 맞는 자리가 없으면
 * null. 번역 앞에 같은 줄 번호를 한 번 더 쓴 답(`3|원문|3|번역`, 1.7B 실측)은 그 번호를 뗀다.
 */
function afterEcho(rest: string, source: string, k: number): string | null {
  const want = echoKey(source);
  for (const m of rest.matchAll(new RegExp(ECHO_SEP.source, "g"))) {
    if (echoKey(rest.slice(0, m.index)) !== want) continue;
    return rest.slice(m.index + m[0].length).replace(new RegExp(`^${k}\\s*[|｜]\\s*`), "");
  }
  return null;
}

/**
 * 응답 → 번역 n개(배치 순서, `sources`는 보낸 원문), 형식이 어긋나면 null. 줄마다 베낀 원문이 그 번호의 원문과
 * 맞아야 한다(밀린 응답 거르기). 첫 번호 줄 앞의 서문은 무시하지만, 번호 줄 뒤의 번호 없는 줄은 실패로 본다(이어
 * 붙이면 뒤따르는 잡담이 번역에 섞인다). 한 줄짜리 배치(쪼개기의 마지막 단계)만 느슨하게 — 밀릴 이웃이 없으니
 * 베낀 원문이 틀려도 마지막 칸을 번역으로 받는다(요청한 모양이 `원문 => 번역`). 단 그 칸이 원문 그대로면(번역을
 * 빠뜨림) 받지 않는다 — 실측(1.7B): `1|Hello.`·`settings.json|The settings file…`·원문만 돌려준 답이 섞여 왔다.
 */
export function parseCaptionTranslation(text: string, sources: readonly string[]): string[] | null {
  const n = sources.length;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"));
  if (n === 1) {
    const m = /^1\s*[|｜]\s*(.*)$/.exec(lines[0] ?? "");
    const body = m ? [m[1], ...lines.slice(1)].join(" ") : lines.length === 1 ? lines[0] : null;
    if (body == null) return null;
    const split = afterEcho(body, sources[0], 1);
    if (split != null) {
      const t = cleanTranslation(split);
      return t ? [t] : null;
    }
    const last = cleanTranslation(body.split(ECHO_SEP).filter((p) => p.trim()).pop() ?? "");
    const lastKey = echoKey(last);
    return lastKey && lastKey !== echoKey(sources[0]) ? [last] : null;
  }
  const out: Array<string | undefined> = new Array(n).fill(undefined);
  let started = false;
  for (const l of lines) {
    const m = /^(\d+)\s*[|｜]\s*(.*)$/.exec(l);
    if (!m) {
      if (started) return null;
      continue;
    }
    const k = Number(m[1]);
    if (k < 1 || k > n || out[k - 1] !== undefined) return null;
    const tr = afterEcho(m[2], sources[k - 1], k);
    if (tr == null) return null;
    out[k - 1] = cleanTranslation(tr);
    started = true;
  }
  return out.every((t) => !!t) ? (out as string[]) : null;
}

/** 제 글자를 가진 대상 언어 — 이 글자가 하나도 없는 원문을 그대로 돌려준 답은 번역하지 않은 것이다. */
const TARGET_SCRIPT: Partial<Record<string, RegExp>> = {
  ko: /\p{Script=Hangul}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  zh: /\p{Script=Han}/u,
};

/**
 * 원문을 번역하지 않고 그대로 돌려준 답인가. 실측(e2e 64, Qwen3 1.7B, 영어 → 한국어): `1|2nd line => 2nd line`처럼 베낀
 * 원문을 번역 자리에도 써서 형식 검사를 통과했고, 영어가 한국어 번역으로 저장돼 "모두 번역됨"이 떴다. 원문과 같은 번역은
 * 원래 받는다(이미 대상 언어인 줄 — 설계 9절 83). 대상 언어 글자가 원문에 없을 때만 거절한다. 라틴 문자 언어끼리는 가릴 수
 * 없어 그대로 받는다. 대가: 한국어로 옮길 "GitHub"만 있는 cue는 번역하지 못한 줄로 남는다(손으로 채운다).
 */
function untranslatedEcho(translation: string, source: string, lang: string): boolean {
  const script = TARGET_SCRIPT[lang];
  return !!script && !script.test(source) && echoKey(translation) === echoKey(source);
}

/** 번역문을 대상 언어의 줄 폭으로 다시 줄바꿈한다(원문의 줄 나눔은 번역에서 자리가 맞지 않는다). */
function wrapTranslation(text: string, lang: string): string {
  return wrapCaptionWords(text.split(" "), captionLangLineChars(lang)).join("\n");
}

/** LLM 한 번 — 스토어가 `chatWithBusyRetry`(모델·취소·Busy 대기)로 채운다. */
export type CaptionChat = (
  messages: ChatMsg[],
  opts: { temperature: number; maxTokens: number },
) => Promise<{ text: string; truncated: boolean }>;

/**
 * cue들을 번역한다. 성공한 배치(쪼갠 조각 포함)마다 `onChunk(번역들, [])`, 한 줄까지 쪼개도 실패한 cue는
 * `onChunk([], [cueId])` — 호출자는 배치마다 문서에 저장한다(창을 닫아도 번역한 데까지 남는다).
 * LLM 오류(모델 없음·취소·서버)는 그대로 던진다 — 형식이 틀린 응답(번역하지 않고 원문을 돌려준 답 포함)만 다시 묻고 쪼갠다.
 */
export async function translateCaptionItems(args: {
  items: readonly CaptionTranslateItem[];
  lang: string;
  /** 설정 `llmContext`. */
  ctx: number;
  chat: CaptionChat;
  onChunk: (done: CaptionTranslated[], failedIds: string[]) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { lang, chat, onChunk, signal } = args;
  const run = async (batch: CaptionTranslateItem[]): Promise<void> => {
    for (const temperature of [0.2, 0]) {
      signal?.throwIfAborted();
      const messages = captionTranslateMessages(batch, lang);
      const r = await chat(messages, { temperature, maxTokens: captionTranslateMaxTokens(messages) });
      // 취소가 요청 등록보다 먼저 닿으면 llm_cancel이 헛돌아 답이 그대로 온다 — 취소한 뒤에 문서에 쓰지 않게.
      signal?.throwIfAborted();
      const got = r.truncated
        ? null
        : parseCaptionTranslation(
            r.text,
            batch.map((it) => it.text),
          );
      if (got && !got.some((t, i) => untranslatedEcho(t, batch[i].text, lang))) {
        onChunk(
          batch.map((it, i) => ({ cueId: it.cueId, text: wrapTranslation(got[i], lang), src: it.src })),
          [],
        );
        return;
      }
    }
    if (batch.length === 1) {
      onChunk([], [batch[0].cueId]);
      return;
    }
    const mid = Math.ceil(batch.length / 2);
    await run(batch.slice(0, mid));
    await run(batch.slice(mid));
  };
  for (const b of batchCaptionItems(args.items, captionTranslateBudget(args.ctx))) await run(b);
}

// ══════════════════════════ 문서 쓰기 ══════════════════════════

/**
 * 번역들을 `translations[lang]`·`translationSrc[lang]`에 쓴다. 빈 글은 그 cue의 번역을 지운다. 번역하는 사이 합쳐져
 * 사라진 cue는 건너뛴다. 바뀐 것이 없으면 null(스토어 `edit` 계약).
 * `base`(번역 잡이 시작할 때의 `translations[lang]`)를 주면 그 뒤 바뀐 줄 — 잡 도중 손으로 고치거나 지운 번역 — 은
 * 덮지 않는다. 대기 목록은 잡을 시작할 때 정해져, 늦게 도착한 배치가 그 편집을 말없이 지웠다.
 */
export function setCaptionTranslations(
  doc: CaptionDoc,
  lang: string,
  got: readonly CaptionTranslated[],
  base?: Readonly<Record<string, string>>,
): CaptionDoc | null {
  const cueIds = new Set(doc.cues.map((c) => c.id));
  const tr = { ...(doc.translations?.[lang] ?? {}) };
  const src = { ...(doc.translationSrc?.[lang] ?? {}) };
  let changed = false;
  for (const g of got) {
    if (!cueIds.has(g.cueId)) continue;
    if (base && tr[g.cueId] !== base[g.cueId]) continue;
    const text = g.text.trim();
    if (text) {
      if (tr[g.cueId] === text && src[g.cueId] === g.src) continue;
      tr[g.cueId] = text;
      src[g.cueId] = g.src;
      changed = true;
    } else if (g.cueId in tr || g.cueId in src) {
      delete tr[g.cueId];
      delete src[g.cueId];
      changed = true;
    }
  }
  if (!changed) return null;
  const translations = { ...doc.translations, [lang]: tr };
  const translationSrc = { ...doc.translationSrc, [lang]: src };
  if (Object.keys(tr).length === 0) {
    delete translations[lang];
    delete translationSrc[lang];
  }
  return { ...doc, translations, translationSrc };
}

/** 번역 줄 손으로 고치기 — 지금 원문을 보고 고친 것이므로 원문 해시도 지금 것으로(원문 바뀜 표시가 풀린다). */
export function setCaptionTranslation(doc: CaptionDoc, lang: string, cueId: string, text: string): CaptionDoc | null {
  const item = captionTranslateItems(doc).find((it) => it.cueId === cueId);
  if (!item) return null;
  return setCaptionTranslations(doc, lang, [{ cueId, text, src: item.src }]);
}
