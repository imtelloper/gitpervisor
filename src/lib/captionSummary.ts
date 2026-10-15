// 대본 요약 — 자막(전사) 글을 로컬 LLM으로 요약해 문서 `summary`(개요·핵심·장 목차)에 붙인다.
//
// - 대본이 컨텍스트에 안 들어가면 **나눠 메모 → 메모를 다시 요약**(map-reduce). 1시간 대본(한국어 ~3만 자)은 4B 모델의
//   기본 컨텍스트(8K)에 한 번에 못 넣는다. 메모도 줄마다 `[m:ss]`를 달게 해 마지막 단계가 장 시각을 고를 수 있게 한다.
// - 응답은 JSON이 아니라 줄 머리표(OVERVIEW:/POINT:/CHAPTER:) — 작은 모델은 JSON 따옴표·쉼표를 자주 깬다(번역도 줄 형식).
// - 장 시각은 대본에 있던 시각만 믿는다: 영상 길이 밖은 버리고, 그 시각을 품은 자막 줄의 시작으로 당겨 문장 머리에서 재생되게.
// - 순수 함수 + 주입된 `chat`(captionTranslate와 같은 계약) — 스토어가 `chatWithBusyRetry`로 채운다.
import { currentMessages } from "../i18n/ui-language";
import { captionSourceCues, type CaptionTimedCue } from "./captionEdit";
import type { CaptionChat } from "./captionTranslate";
import { fnv16 } from "./floating";
import type { CaptionDoc, CaptionSummary } from "./ipc";
import { langName, type ChatMsg } from "./llm";

/** system 프롬프트 + 채팅 틀 토큰 여유. */
const PROMPT_OVERHEAD_TOKENS = 600;
const NOTES_MAX_TOKENS = 700;
const FINAL_MAX_TOKENS = 1000;
/** 한 번에 보내는 글자 상한 — 컨텍스트가 커도 작은 모델은 긴 입력의 가운데를 흘린다. */
const MAX_CHUNK_CHARS = 8000;
const MAX_CHAPTERS = 10;

/** 요약 대상 자막 줄 — 잘린 어절도 넣는다(원본 영상에서는 말한 내용이고, 장 시각도 원본 축이다). */
function summaryCues(doc: CaptionDoc): CaptionTimedCue[] {
  return captionSourceCues(doc, true).filter((c) => c.text.trim());
}

/** 대본 해시 — 요약한 뒤 자막 글을 고쳤는지 본다. */
export function captionSummarySrc(doc: CaptionDoc): string {
  return fnv16(summaryCues(doc).map((c) => c.text).join("\n"));
}

export function captionSummaryEmpty(doc: CaptionDoc): boolean {
  return summaryCues(doc).length === 0;
}

/** 복사용 텍스트 — 메모장·메신저에 붙여도 읽히게 마크다운 비슷한 평문. */
export function captionSummaryText(s: CaptionSummary, labels: { points: string; chapters: string }): string {
  const lines = [s.overview, "", labels.points, ...s.points.map((p) => `- ${p}`)];
  if (s.chapters.length) lines.push("", labels.chapters, ...s.chapters.map((c) => `${fmtClock(c.startMs)} ${c.title}`));
  return lines.join("\n");
}

export function captionSummaryStale(doc: CaptionDoc): boolean {
  return !!doc.summary && doc.summary.src !== captionSummarySrc(doc);
}

/** 한 번에 보낼 글자 예산 — 한글 최악 1자 ≈ 1토큰, 응답 상한까지 컨텍스트(`llmContext`)에 들어가게. */
export function captionSummaryBudget(ctx: number): number {
  return Math.max(400, Math.min(MAX_CHUNK_CHARS, ctx - PROMPT_OVERHEAD_TOKENS - FINAL_MAX_TOKENS));
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

const CLOCK = /(\d{1,2}:)?\d{1,3}:\d{2}/;

function parseClock(s: string): number | null {
  const m = CLOCK.exec(s);
  if (!m) return null;
  const parts = m[0].split(":").map(Number);
  const sec = parts.reduce((acc, p) => acc * 60 + p, 0);
  return Number.isFinite(sec) ? sec * 1000 : null;
}

function transcriptLines(cues: readonly CaptionTimedCue[]): string[] {
  return cues.map((c) => `[${fmtClock(c.startMs)}] ${c.text.replace(/\s+/g, " ").trim()}`);
}

/** 줄 순서대로 예산 안에서 묶는다. 예산보다 긴 줄 하나는 혼자 한 묶음이다. */
export function chunkSummaryLines(lines: readonly string[], budget: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (cur.length > 0 && size + l.length + 1 > budget) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l);
    size += l.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

function notesMessages(lines: readonly string[], lang: string): ChatMsg[] {
  const name = langName(lang);
  return [
    {
      role: "system",
      content:
        `You take notes on one part of a video transcript. Each input line starts with its timestamp [m:ss]. ` +
        `Write 2 to 5 notes in ${name}, in time order. Each note sums up several lines in your own words in at most ` +
        `15 words — do not copy transcript lines. Format every note as "[m:ss] note", using the timestamp of the line ` +
        `where that topic starts. No preface, headings or closing remarks.`,
    },
    { role: "user", content: lines.join("\n") },
  ];
}

function finalMessages(lines: readonly string[], lang: string, fromNotes: boolean): ChatMsg[] {
  const name = langName(lang);
  return [
    {
      role: "system",
      content:
        `You summarize a video from ${fromNotes ? "timestamped notes on its transcript" : "its transcript"}. ` +
        `Each input line starts with a timestamp [m:ss]. Write everything in ${name}. ` +
        `Reply in exactly this line format and nothing else:\n` +
        `OVERVIEW: <one or two sentences on what the video is about>\n` +
        `POINT: <one key point in one sentence>\n` +
        `POINT: <another key point>\n` +
        `CHAPTER: <m:ss> | <title of 2 to 8 words>\n` +
        `CHAPTER: <m:ss> | <title of the next part>\n` +
        `Write 3 to 7 POINT lines and 2 to 10 CHAPTER lines, each on its own line. A CHAPTER time is when that part ` +
        `starts, copied from an input timestamp, in time order. Titles name the topic — never copy transcript lines.`,
    },
    { role: "user", content: lines.join("\n") },
  ];
}

/** 메모·장 제목 한 줄 상한(글자). */
const NOTE_CHARS = 100;
const TITLE_CHARS = 60;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * 메모 응답 → `[m:ss] 메모` 줄들(시각이 없는 줄은 버린다), 합쳐서 `maxChars` 안으로. 실측(Qwen3 1.7B): "메모하라"고 해도 대본
 * 줄을 그대로 베껴 와서 다음 바퀴 입력이 줄지 않았다 — 길이는 모델이 아니라 여기서 보장한다.
 */
export function parseSummaryNotes(text: string, maxChars = Infinity): string[] {
  const out: string[] = [];
  let size = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = clip(raw.trim().replace(/^[-*•\d.)\s]+(?=\[)/, ""), NOTE_CHARS);
    if (!/^\[(\d{1,2}:)?\d{1,3}:\d{2}\]\s*\S/.test(l)) continue;
    if (size + l.length + 1 > maxChars) break;
    out.push(l);
    size += l.length + 1;
  }
  return out;
}

/** 장 줄 본문 → 장들. 한 줄에 `0:00 | 가 0:06 | 나 …`처럼 여러 개를 이어 쓴 답(1.7B 실측)은 시각마다 나눈다. */
function parseChapterBody(body: string): CaptionSummary["chapters"] {
  const marks = [...body.matchAll(new RegExp(CLOCK.source, "g"))];
  return marks.flatMap((m, i) => {
    const ms = parseClock(m[0]);
    const title = clip(
      body
        .slice(m.index + m[0].length, marks[i + 1]?.index ?? body.length)
        .replace(/^[\s[\]()|｜\-–—:]+|[\s[\]()|｜\-–—:]+$/g, "")
        .trim(),
      TITLE_CHARS,
    );
    return ms != null && title ? [{ startMs: ms, title }] : [];
  });
}

type SummarySection = "OVERVIEW" | "POINT" | "CHAPTER";

/**
 * 최종 응답 → 요약(시각은 아직 문서에 맞추기 전), 모양이 어긋나면 null. 머리표는 대소문자·앞의 불릿·굵게(**)를 견딘다.
 * 머리표만 쓰고 아래에 목록으로 잇는 답(`POINT:` 다음 줄부터 `- …`, Qwen3 4B 2507 실측)은 그 목록을 그 칸으로 읽는다.
 */
export function parseSummaryReply(text: string): Omit<CaptionSummary, "lang" | "src"> | null {
  let overview = "";
  const points: string[] = [];
  const chapters: CaptionSummary["chapters"] = [];
  let section: SummarySection | null = null;
  const take = (sec: SummarySection, body: string) => {
    switch (sec) {
      case "OVERVIEW":
        overview = overview ? `${overview} ${body}` : body;
        break;
      case "POINT":
        points.push(body);
        break;
      case "CHAPTER":
        chapters.push(...parseChapterBody(body));
        break;
      default: {
        const never: never = sec;
        return never;
      }
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\*\*/g, "").replace(/^(?:[\s\-*•]+|\d+[.)]\s+)/, "").trim();
    if (!l) continue;
    const m = /^(OVERVIEW|POINTS?|CHAPTERS?)\s*[:：]\s*(.*)$/i.exec(l);
    if (m) {
      const head = m[1].toUpperCase();
      section = head.startsWith("POINT") ? "POINT" : head.startsWith("CHAPTER") ? "CHAPTER" : "OVERVIEW";
      if (m[2].trim()) take(section, m[2].trim());
    } else if (section) take(section, l);
  }
  return overview && points.length ? { overview, points, chapters } : null;
}

/** 장 시각을 문서에 맞춘다 — 그 시각(초 단위 표기라 +999ms)을 품은 자막 줄의 시작으로, 길이 밖·중복은 버리고 시간순. */
export function snapChapters(
  chapters: CaptionSummary["chapters"],
  cues: readonly CaptionTimedCue[],
  durationMs: number,
): CaptionSummary["chapters"] {
  const out: CaptionSummary["chapters"] = [];
  for (const ch of [...chapters].sort((a, b) => a.startMs - b.startMs)) {
    if (ch.startMs > durationMs) continue;
    let at = 0;
    for (const c of cues) {
      if (c.startMs > ch.startMs + 999) break;
      at = c.startMs;
    }
    if (out.some((o) => o.startMs === at)) continue;
    out.push({ startMs: at, title: ch.title });
  }
  // 작은 모델(1.7B 실측)은 대본 줄마다 장을 하나씩 만들어 27개를 돌려줬다 — 목차가 대본과 다를 바 없어진다. 고르게 10개만.
  if (out.length <= MAX_CHAPTERS) return out;
  return Array.from({ length: MAX_CHAPTERS }, (_, i) => out[Math.round((i * (out.length - 1)) / (MAX_CHAPTERS - 1))]);
}

export interface CaptionSummaryProgress {
  done: number;
  total: number;
}

/**
 * 문서 대본을 요약한다. 대본이 예산을 넘으면 묶음마다 메모를 받고, 메모가 다시 넘으면 한 번 더 — 한 바퀴에 크게
 * 줄지 않으면(모델이 메모를 길게 쓴다) 멈추고 던진다. 형식이 틀린 최종 응답은 temperature 0으로 한 번 더 묻는다.
 * LLM 오류(모델 없음·취소·서버)는 그대로 던진다. 대본이 비면 null.
 */
export async function summarizeCaptionDoc(args: {
  doc: CaptionDoc;
  lang: string;
  ctx: number;
  chat: CaptionChat;
  onProgress: (p: CaptionSummaryProgress) => void;
  signal?: AbortSignal;
}): Promise<CaptionSummary | null> {
  const { doc, lang, chat, onProgress, signal } = args;
  const cues = summaryCues(doc);
  if (cues.length === 0) return null;
  const budget = captionSummaryBudget(args.ctx);
  let lines = transcriptLines(cues);
  let fromNotes = false;
  let done = 0;
  const size = (ls: readonly string[]) => ls.reduce((n, l) => n + l.length + 1, 0);
  while (size(lines) > budget) {
    const chunks = chunkSummaryLines(lines, budget);
    let total = done + chunks.length + 1;
    onProgress({ done, total });
    const notes: string[] = [];
    for (const chunk of chunks) {
      signal?.throwIfAborted();
      const r = await chat(notesMessages(chunk, lang), { temperature: 0.2, maxTokens: NOTES_MAX_TOKENS });
      signal?.throwIfAborted();
      // 묶음 글자의 절반까지만 — 바퀴마다 입력이 확실히 줄게.
      const got = parseSummaryNotes(r.text, Math.floor(size(chunk) / 2));
      // 시각 달린 메모를 하나도 못 받으면 그 묶음의 첫 줄로 자리를 지킨다 — 장 목차에서 그 구간이 통째로 빠지지 않게.
      notes.push(...(got.length ? got : [clip(chunk[0], NOTE_CHARS)]));
      done++;
      total = Math.max(total, done + 1);
      onProgress({ done, total });
    }
    if (size(notes) > size(lines) * 0.8) throw new Error(currentMessages().captions.summary.notShrinking);
    lines = notes;
    fromNotes = true;
  }
  onProgress({ done, total: done + 1 });
  for (const temperature of [0.3, 0]) {
    signal?.throwIfAborted();
    const r = await chat(finalMessages(lines, lang, fromNotes), { temperature, maxTokens: FINAL_MAX_TOKENS });
    signal?.throwIfAborted();
    const got = parseSummaryReply(r.text);
    if (got) {
      onProgress({ done: done + 1, total: done + 1 });
      return {
        lang,
        src: captionSummarySrc(doc),
        overview: got.overview,
        points: got.points,
        chapters: snapChapters(got.chapters, cues, doc.source.durationMs),
      };
    }
  }
  throw new Error(currentMessages().captions.summary.badFormat);
}
