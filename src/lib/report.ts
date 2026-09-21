// 작업 리포트(태스크 60 §3.3 · 67 §3.1) — 요약 프롬프트 조립 · 토큰 예산 · 입력 해시 · 기간 계산.
//
// LLM 호출 자체는 `lib/llm.ts`의 `chat()`이 한다(59 계약). 여기는 **순수 함수**만 둔다 —
// 카드가 스트리밍 상태를 들고, 이 파일은 "무엇을 보낼지"와 "입력이 바뀌었는지"만 답한다.

import { fnv16 } from "./floating";
import type { Commit, Project, PromptItem } from "./ipc";
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

/** `reports.json`의 키 — `"<scopeKey>|<period>|<since>"`(설계 60 §3.4). */
export function reportKey(scope: string, period: Period, since: string): string {
  return `${scope}|${period}|${since}`;
}

/**
 * 저장 키의 앞부분 — 1개면 그 프로젝트 id, 2개 이상이면 조합 해시(설계 67 §3.1).
 * 이름이 아니라 해시인 이유: 키 길이가 프로젝트 수만큼 늘지 않고, 프로젝트 이름을 바꿔도
 * 저장해 둔 종합 요약을 계속 찾는다. 충돌해도 요약이 뒤바뀌는 게 아니라 "입력이 바뀜" 뱃지가
 * 뜰 뿐이다(해시가 다르다 — 설계 §6).
 */
export function scopeKey(projects: { id: string }[]): string {
  if (projects.length === 1) return projects[0].id;
  return `multi:${fnv16(projects.map((p) => p.id).sort().join("+"))}`;
}

/** 카드 한 장의 입력 — 프로젝트 1개분의 커밋·프롬프트. 종합 카드는 이걸 여러 개 든다. */
export interface ReportSource {
  project: Project;
  commits: Commit[];
  prompts: PromptItem[];
}

/**
 * 입력 해시 — 커밋 sha 목록 + 프롬프트 시각 목록의 SHA-1. 저장된 요약의 해시와 다르면
 * 카드가 "입력이 바뀜 — 다시 생성"을 띄운다(본문 전체를 비교하지 않는 이유: 커밋 하나만
 * 추가돼도 요약은 낡은 것이다).
 *
 * 프로젝트는 **id 순**으로 이어 붙인다 — 선택 순서가 흔들리면 같은 조합인데도 "입력이 바뀜"이
 * 헛뜬다(설계 67 §3.1).
 *
 * 프로젝트가 하나면 id를 넣지 않는다 — 넣으면 문자열이 60의 것과 달라져, 입력이 하나도 안 바뀐
 * v0.5.3 저장본 **전부**가 업그레이드 직후 "입력이 바뀜" 뱃지를 단다.
 */
export async function inputHash(sources: ReportSource[]): Promise<string> {
  const src = [...sources]
    .sort((a, b) => (a.project.id < b.project.id ? -1 : 1))
    .map((s) =>
      [
        ...(sources.length > 1 ? [s.project.id] : []),
        ...s.commits.map((c) => c.sha),
        "|",
        ...s.prompts.map((p) => p.at),
      ].join(","),
    )
    .join(";");
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(src));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 프롬프트 조립 · 토큰 예산 ────────────────────────────────────────────────

/** 설정을 못 읽었을 때의 컨텍스트 — 59의 기본값(`llmContext`)과 같다. */
const DEFAULT_CTX = 8192;
const MAX_COMMITS = 60;
const MAX_PROMPTS = 80;
/** 한 줄의 상한 — 커밋 본문 첫 줄과 프롬프트 원문을 각각 이만큼만 싣는다. */
const BODY_CHARS = 120;
const PROMPT_CHARS = 300;
/** 채팅에 딸려 보내는 대화 — 최근 몇 개까지(ponytail: 슬라이딩 윈도, 요약 압축은 업그레이드 경로). */
const HISTORY_MAX = 8;
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 응답 상한 — 월간은 최대 31일 × 3줄 ≈ 1,900 토큰이라 그만큼 열어 둔다(설계 67 §3.1). */
export function maxTokensFor(period: Period): number {
  return { day: 768, week: 1536, month: 2048 }[period];
}

/**
 * 근거로 실을 수 있는 글자 수 — 컨텍스트에서 응답·시스템 몫을 뺀 나머지(한글 ≈ 1.5자/토큰).
 * `ctx`는 설정 `llmContext`(2048..32768)다: 2048로 줄여 둔 사용자도 최소 1,500자는 싣는다.
 */
function charBudget(period: Period, ctx: number): number {
  return Math.max(1500, (ctx - maxTokensFor(period) - 400) * 1.5);
}

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * 한 날짜의 한 갈래(커밋·프롬프트) 블록. 예산을 넘치면 **오래된 것부터** 버리고, 버린 개수를
 * "…외 N건" 한 줄로 남긴다 — 잘렸다는 사실이 요약을 읽는 사람에게 보여야 한다(설계 60 §6).
 * `total`은 전체 상한에 잘리기 전의 그 날 건수라 머리글은 언제나 실제 개수를 말한다.
 *
 * **한 줄도 못 실으면 한 줄도 남기지 않는다.** 예산이 날짜별로 쪼개진 뒤로는(67 §3.1) "최소 1줄"
 * 바닥이 날짜 수 × 2회로 곱해져 전체 예산을 통째로 넘긴다 — 예산은 "컨텍스트에 들어간다"는
 * 보장인데 그 보장이 활동 날짜 수에 따라 깨진다(옛 전역 `fit()`은 바닥이 2회뿐이었다).
 */
function group(
  label: string,
  lines: string[],
  total: number,
  budget: number,
): { text: string; used: number } {
  if (total === 0) return { text: "", used: 0 };
  const kept = [...lines];
  const size = (a: string[]) => a.reduce((n, l) => n + l.length + 1, 0);
  while (kept.length > 0 && size(kept) > budget) kept.pop();
  if (kept.length === 0) {
    const text = `${label} ${total}건 (내용 생략)`;
    return { text, used: text.length + 1 };
  }
  const dropped = total - kept.length;
  const out = [
    `${label} ${total}건`,
    ...kept,
    ...(dropped > 0 ? [`…외 ${dropped}건`] : []),
  ];
  return { text: out.join("\n"), used: size(out) };
}

/**
 * ISO → 로컬 날짜·시각. 커밋 `authoredAt`(오프셋 포함)도 프롬프트 `at`(UTC)도 **로컬 날짜**로
 * 버킷한다(report.rs와 같은 원칙 — 한국 시간 오전 9시 이전이 전날로 밀리지 않게).
 * 파싱 불가는 기간 첫날로 몰아 둔다 — 그대로 두면 날짜 머리글이 `### NaN-NaN-NaN`이 된다.
 */
function localAt(iso: string, fallback: string): { date: string; ms: number; hm: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: fallback, ms: 0, hm: "??:??" };
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: ymd(d), ms: d.getTime(), hm: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/**
 * 근거 블록(요약 요청의 user 메시지 · 채팅의 "### 근거") — **날짜 섹션**으로 묶는다(설계 67 §3.1).
 *
 * 예산은 활동 날짜 수로 **균등 분배**하고 날짜 안에서 커밋이 절반을 먼저 쓴다. 기존의
 * "최신순 전체 예산"은 월간 요약에서 앞쪽 날짜를 통째로 먹어 치웠다 — 날짜마다 3줄을 쓰려면
 * 모든 날짜가 근거를 조금씩이라도 들고 있어야 한다.
 */
function evidenceBlock(args: {
  sources: ReportSource[];
  since: string;
  until: string;
  budget: number;
}): string {
  const { sources, since, until, budget } = args;
  // 여러 프로젝트일 때만 줄머리에 이름을 붙인다 — 한 프로젝트면 매 줄이 같은 접두라 낭비다.
  const multi = sources.length > 1;
  const names = sources.map((s) => s.project.name).join(", ");
  const head = `프로젝트: ${names || "(없음)"} (${since}~${until})`;

  type Entry = { date: string; ms: number; line: string };
  const commits: Entry[] = [];
  const prompts: Entry[] = [];
  for (const s of sources) {
    const tag = multi ? `[${s.project.name}] ` : "";
    for (const c of s.commits) {
      const at = localAt(c.authoredAt, since);
      // 커밋은 `%aI` **오프셋의 날짜**로 버킷한다 — Rust 의 기간 필터도 잔디도 그 기준이다
      // (`report.rs` 의 `date_naive()`). 로컬로 변환하면 UTC 로 찍힌 커밋이 기간 밖 날짜 머리글을
      // 만들어 모델이 그 날짜로 3줄을 쓰고, 카드 카운트·잔디와도 하루씩 어긋난다.
      // (프롬프트 `at` 은 UTC 라 아래처럼 로컬 변환이 맞다 — Rust `local_date` 와 같다.)
      const body = c.body.split("\n").find((l) => l.trim().length > 0);
      commits.push({
        date: /^\d{4}-\d{2}-\d{2}/.test(c.authoredAt) ? c.authoredAt.slice(0, 10) : at.date,
        ms: at.ms,
        line: `- ${tag}${c.sha.slice(0, 7)} ${c.subject}${body ? ` — ${clip(body.trim(), BODY_CHARS)}` : ""}`,
      });
    }
    for (const p of s.prompts) {
      const at = localAt(p.at, since);
      prompts.push({
        date: at.date,
        ms: at.ms,
        line: `- ${tag}[${at.hm}] ${clip(p.text.replace(/\s+/g, " ").trim(), PROMPT_CHARS)}`,
      });
    }
  }

  // 전체 건수 상한은 최신순으로 **먼저** — 그 뒤에 남은 것들로 날짜를 나눈다.
  const newest = (a: Entry, b: Entry) => b.ms - a.ms;
  const keptC = [...commits].sort(newest).slice(0, MAX_COMMITS);
  const keptP = [...prompts].sort(newest).slice(0, MAX_PROMPTS);

  const dates = [...new Set([...keptC, ...keptP].map((e) => e.date))].sort();
  if (dates.length === 0) return `${head}\n\n(활동 없음)`;

  const perDay = budget / dates.length;
  const sections = dates.map((d) => {
    const c = group(
      "커밋",
      keptC.filter((e) => e.date === d).map((e) => e.line),
      commits.filter((e) => e.date === d).length,
      perDay * 0.5,
    );
    const p = group(
      "프롬프트",
      keptP.filter((e) => e.date === d).map((e) => e.line),
      prompts.filter((e) => e.date === d).length,
      perDay - c.used,
    );
    return [`### ${d} (${WEEKDAY[parseYmd(d).getDay()]})`, c.text, p.text]
      .filter(Boolean)
      .join("\n");
  });

  // 날짜마다 붙는 머리글("### 날짜"·"커밋 N건")은 예산에 안 잡힌다 — 날짜가 많으면 그 합만으로도
  // 예산을 넘길 수 있다. 넘으면 **오래된 날짜부터** 섹션을 통째로 접어 한 줄로 바꾼다.
  const size = (a: string[]) => a.reduce((n, s) => n + s.length + 2, 0);
  let kept = sections;
  while (kept.length > 1 && size(kept) > budget) kept = kept.slice(1);
  const folded = sections.length - kept.length;
  const body = folded > 0 ? [`…이전 ${folded}일 생략`, ...kept] : kept;

  return `${head}\n\n${body.join("\n\n")}`;
}

/**
 * 시스템 프롬프트가 한국어라 언어 이름도 한국어여야 한다 — `langName`은 영어 이름을 주므로
 * 그대로 넣으면 "Korean로 요약해라"가 된다. `langName`은 59 계약(61의 영어 프롬프트가 쓴다)이라
 * 건드리지 않고, 목록에 없는 코드만 그쪽으로 폴백한다.
 */
const LANG_LABEL: Record<string, string> = { ko: "한국어", en: "영어" };

/**
 * 요약 요청 메시지 2개(system·user). 여러 프로젝트면 근거가 한 블록에 섞여 들어가고
 * 줄머리에 `[프로젝트명]`이 붙는다(설계 67 §3.1 — 종합 카드).
 */
export function buildMessages(args: {
  sources: ReportSource[];
  period: Period;
  since: string;
  until: string;
  language: string;
  /** 설정 `llmContext`. 생략하면 59 기본값. */
  ctx?: number;
}): ChatMsg[] {
  const { sources, period, since, until, language } = args;

  // 형식은 **빈 틀**로 준다(산문 "형식: A / B / C" 아님). 태스크 70 §6 실측: 산문으로 주면
  // 모델이 ① 머리글을 자기 제목으로 갈아치우고(Gemma 4 12B 3회/3회 `## 한 줄 요약` 누락)
  // ② 심하면 "/" 구분자·"(3개 이하)" 같은 **지시문 자체를 본문에 베낀다**(Mi:dm 2.0 실관측).
  // 틀을 보여 주면 베낄 대상이 본문 모양이라 그 둘이 같이 준다.
  const system =
    `너는 개발자의 작업 일지를 쓰는 비서다. 아래 커밋과 프롬프트를 근거로 ` +
    `${LANG_LABEL[language] ?? langName(language)}로 ` +
    `${PERIOD_LABEL[period]} 작업을 요약해라.\n` +
    `아래 틀을 그대로 채워라. 머리글은 글자 그대로 쓰고 다른 머리글을 새로 만들지 마라.\n\n` +
    `## 한 줄 요약\n한 문장\n\n` +
    `## 날짜별\n### YYYY-MM-DD (요일)\n` +
    // **길이를 못 박아야 한다.** "한 문장"만으로는 Qwen3 4B 2507 이 불릿 하나를 380자까지
    // 늘려 5개 날짜 중 3개에서 max_tokens 에 걸렸다(태스크 70 §8 실측 — 상한을 3000 으로
    // 올려도 여전히 잘렸다. 상한 문제가 아니라 장황함 문제다).
    `- 그 날 한 일 한 문장(100자 이내), 커밋 해시 7자리 인용${sources.length > 1 ? ", [프로젝트명] 접두" : ""}\n` +
    `- 같은 형태\n- 같은 형태\n\n` +
    `활동이 있는 날짜마다 위 날짜 블록을 반복한다. 날짜당 불릿은 정확히 3개다.\n\n` +
    `## 다음 할 일\n- 3개 이하\n\n` +
    `근거 없는 내용은 쓰지 마라. 프롬프트는 사용자가 AI에게 한 요청이다.`;

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: evidenceBlock({
        sources,
        since,
        until,
        budget: charBudget(period, args.ctx ?? DEFAULT_CTX),
      }),
    },
  ];
}

// ── 채팅(설계 67 §3.2) ───────────────────────────────────────────────────────

/** 채팅 패널이 들고 있는 "지금 무엇을 두고 이야기하는가". 카드의 [AI에게 묻기]가 만든다. */
export interface ChatContext {
  /** `reportKey()` — [요약으로 저장]이 이 키에 쓴다. */
  key: string;
  /** 헤더 칩에 보일 이름("gitpervisor" · "종합 · 2개 프로젝트"). */
  title: string;
  sources: ReportSource[];
  period: Period;
  since: string;
  until: string;
  /** 지금 카드에 보이는 요약 본문 — 수정 요청의 대상이다. */
  body: string;
  /** 카드가 계산해 둔 입력 해시. 채팅은 입력을 바꾸지 않으니 저장할 때 그대로 쓴다. */
  hash: string | null;
}

/**
 * 채팅 요청 메시지 — system(리포트 컨텍스트) + 최근 히스토리 + 이번 입력.
 *
 * 컨텍스트가 없으면 system은 첫 문장뿐이다(리포트와 무관한 일반 대화도 허용 — 설계 §3.2).
 * `llmCtx`는 설정 `llmContext`: 2048로 줄여 둔 사용자에서 근거 블록이 컨텍스트를 통째로
 * 먹지 않도록 요약 예산의 절반만 쓰고 바닥은 800자다(설계 §6).
 */
export function chatMessages(
  ctx: ChatContext | null,
  history: ChatMsg[],
  userText: string,
  language: string,
  llmCtx?: number,
): ChatMsg[] {
  const lang = LANG_LABEL[language] ?? langName(language);
  let system = `너는 개발자의 작업 리포트를 돕는 비서다. ${lang}로 답해라. 근거 없는 내용은 쓰지 마라.`;
  if (ctx) {
    const budget = Math.max(800, charBudget(ctx.period, llmCtx ?? DEFAULT_CTX) * 0.5);
    system +=
      `\n사용자가 요약의 수정을 요청하면 요약 전체를 같은 형식` +
      `(## 한 줄 요약 / ## 날짜별 / ## 다음 할 일)으로 다시 써라 — 부분만 주지 마라.\n` +
      `### 현재 요약\n${clip(ctx.body, 3000)}\n` +
      `### 근거\n${evidenceBlock({
        sources: ctx.sources,
        since: ctx.since,
        until: ctx.until,
        budget,
      })}`;
  }
  return [
    { role: "system", content: system },
    ...history.slice(-HISTORY_MAX),
    { role: "user", content: userText },
  ];
}
