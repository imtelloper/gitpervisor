// 작업 리포트(태스크 60 §3.3) — 요약 프롬프트 조립 · 토큰 예산 · 입력 해시 · 기간 계산.
//
// LLM 호출 자체는 `lib/llm.ts`의 `chat()`이 한다(59 계약). 여기는 **순수 함수**만 둔다 —
// 카드가 스트리밍 상태를 들고, 이 파일은 "무엇을 보낼지"와 "입력이 바뀌었는지"만 답한다.

import type { Commit, PromptItem } from "./ipc";
import type { ChatMsg } from "./llm";
import { langName } from "./llm";

export type Period = "day" | "week" | "month";

export const PERIOD_LABEL: Record<Period, string> = {
  day: "일간",
  week: "주간",
  month: "월간",
};

// ── 날짜(로컬) ────────────────────────────────────────────────────────────────
// 백엔드가 커밋·전사를 **로컬 날짜**로 버킷하므로(report.rs) 프론트도 전부 로컬로 다룬다.
// ISO 문자열(UTC)로 왕복하면 한국 시간 오전 9시 이전이 전날로 밀린다.

/** Date → `YYYY-MM-DD`(로컬). */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `YYYY-MM-DD` → 그 날 로컬 자정. */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function today(): string {
  return ymd(new Date());
}

/** 그 주의 **월요일**(한국 관례 — 설계 §7). */
export function weekStart(s: string): string {
  const d = parseYmd(s);
  // getDay(): 일=0 … 토=6 → 월요일까지 되돌릴 일수
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return ymd(d);
}

/** 선택 기간의 [since, until]과 상단 바에 적을 라벨. */
export function periodRange(
  period: Period,
  anchor: string,
): { since: string; until: string; label: string } {
  if (period === "day") return { since: anchor, until: anchor, label: anchor };
  if (period === "week") {
    const since = weekStart(anchor);
    const d = parseYmd(since);
    // "9월 1주" — 그 주 월요일이 속한 달의 몇 번째 주인가.
    const nth = Math.floor((d.getDate() - 1) / 7) + 1;
    return { since, until: addDays(since, 6), label: `${d.getMonth() + 1}월 ${nth}주` };
  }
  const d = parseYmd(anchor);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return {
    since: ymd(first),
    until: ymd(last),
    label: `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}`,
  };
}

/** ◀▶ — 기간 단위로 기준일을 옮긴다. */
export function shiftPeriod(period: Period, anchor: string, dir: 1 | -1): string {
  if (period === "day") return addDays(anchor, dir);
  if (period === "week") return addDays(weekStart(anchor), dir * 7);
  const d = parseYmd(anchor);
  return ymd(new Date(d.getFullYear(), d.getMonth() + dir, 1));
}

/** `reports.json`의 키 — `"<projectId>|<period>|<since>"`(설계 §3.4). */
export function reportKey(projectId: string, period: Period, since: string): string {
  return `${projectId}|${period}|${since}`;
}

/**
 * 입력 해시 — 커밋 sha 목록 + 프롬프트 시각 목록의 SHA-1. 저장된 요약의 해시와 다르면
 * 카드가 "입력이 바뀜 — 다시 생성"을 띄운다(본문 전체를 비교하지 않는 이유: 커밋 하나만
 * 추가돼도 요약은 낡은 것이다).
 */
export async function inputHash(
  commits: Commit[],
  prompts: PromptItem[],
): Promise<string> {
  const src = [...commits.map((c) => c.sha), "|", ...prompts.map((p) => p.at)].join(",");
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(src));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 프롬프트 조립 · 토큰 예산 ────────────────────────────────────────────────

/** 컨텍스트 8192(59 기본) − 응답 1024 − 시스템 ≈ 6,500 토큰. 한글 ≈ 1.5자/토큰(설계 §3.3). */
const CHAR_BUDGET = 6500 * 1.5;
const MAX_COMMITS = 60;
const MAX_PROMPTS = 80;
/** 한 줄의 상한 — 커밋 본문 첫 줄과 프롬프트 원문을 각각 이만큼만 싣는다. */
const BODY_CHARS = 120;
const PROMPT_CHARS = 300;

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * 최신순 줄 목록을 상한·예산에 맞춰 자른다. **오래된 것부터** 버리고, 버린 개수를
 * "…외 N건" 한 줄로 남긴다 — 잘렸다는 사실이 요약을 읽는 사람에게 보여야 한다(설계 §6).
 */
function fit(
  lines: string[],
  max: number,
  budget: number,
): { block: string; used: number } {
  const kept = lines.slice(0, max);
  let dropped = lines.length - kept.length;
  const size = (a: string[]) => a.reduce((n, l) => n + l.length + 1, 0);
  while (kept.length > 1 && size(kept) > budget) {
    kept.pop();
    dropped++;
  }
  const out = dropped > 0 ? [...kept, `…외 ${dropped}건`] : kept;
  return { block: out.join("\n"), used: size(out) };
}

/** 프롬프트 줄머리의 시각 — 월간 요약에서도 언제인지 보이도록 `MM-DD HH:MM`. */
function atLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 시스템 프롬프트가 한국어라 언어 이름도 한국어여야 한다 — `langName`은 영어 이름을 주므로
 * 그대로 넣으면 "Korean로 요약해라"가 된다. `langName`은 59 계약(61의 영어 프롬프트가 쓴다)이라
 * 건드리지 않고, 목록에 없는 코드만 그쪽으로 폴백한다.
 */
const LANG_LABEL: Record<string, string> = { ko: "한국어", en: "영어" };

/**
 * 요약 요청 메시지 2개(system·user). `commits`는 git log 순서(최신 먼저), `prompts`는
 * 백엔드 정렬(오래된 먼저)이라 여기서 뒤집어 최신 우선으로 예산을 태운다.
 */
export function buildMessages(args: {
  projectName: string;
  period: Period;
  since: string;
  until: string;
  commits: Commit[];
  prompts: PromptItem[];
  language: string;
}): ChatMsg[] {
  const { projectName, period, since, until, commits, prompts, language } = args;

  const commitLines = commits.map((c) => {
    const body = c.body.split("\n").find((l) => l.trim().length > 0);
    return `- ${c.sha.slice(0, 7)} ${c.subject}${body ? ` — ${clip(body.trim(), BODY_CHARS)}` : ""}`;
  });
  const promptLines = [...prompts]
    .reverse()
    .map((p) => `- [${atLabel(p.at)}] ${clip(p.text.replace(/\s+/g, " ").trim(), PROMPT_CHARS)}`);

  // 커밋이 정본이라 예산을 먼저 쓴다 — 남은 몫이 프롬프트로 간다.
  const c = fit(commitLines, MAX_COMMITS, CHAR_BUDGET * 0.5);
  const p = fit(promptLines, MAX_PROMPTS, CHAR_BUDGET - c.used);

  const system =
    `너는 개발자의 작업 일지를 쓰는 비서다. 아래 커밋과 프롬프트를 근거로 ` +
    `${LANG_LABEL[language] ?? langName(language)}로 ` +
    `${PERIOD_LABEL[period]} 작업을 요약해라.\n` +
    `형식: ## 한 줄 요약 / ## 한 일 (불릿, 커밋 해시 7자리 인용) / ## 진행 중·막힌 것 / ` +
    `## 다음 할 일 제안(3개 이하).\n` +
    `근거 없는 내용은 쓰지 마라. 프롬프트는 사용자가 AI에게 한 요청이다.`;

  const user =
    `프로젝트: ${projectName} (${since}~${until})\n\n` +
    `### 커밋 ${commits.length}건\n${c.block || "- (없음)"}\n\n` +
    `### 프롬프트 ${prompts.length}건\n${p.block || "- (없음)"}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
