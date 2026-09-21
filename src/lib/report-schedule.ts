// 주간 리포트 예약 생성 (태스크 70 §10) — **메인 창 1회**.
//
// 왜 프론트에 두는가: 요약 한 건은 `buildMessages()`(lib/report.ts) + `chat()`(lib/llm.ts)로
// 만들어지고 둘 다 프론트 계약이다. Rust 에 스케줄러를 두면 그쪽이 프롬프트를 다시 조립해야
// 하고, 그러면 카드와 예약이 서로 다른 요약을 낸다.
//
// 왜 카드를 안 쓰는가: `ReportCard.generate()` 는 react-query 훅(`useCommitsBetweenMany`·
// `usePromptDumps`)에 매여 있어 **그 카드가 마운트돼 있어야** 돈다. 예약은 리포트 화면을
// 열어 두지 않은 동안에도 돌아야 하므로 데이터 조립을 여기서 직접 한다(같은 ipc 커맨드).
//
// 중복 실행 방지는 **별도 상태 없이** 저장본 존재로 한다 — 이미 그 키에 요약이 있으면 건너뛴다.
// 그래서 앱이 한 주 꺼져 있었어도 켜는 순간 지난주 것을 한 번 만들고 끝난다(따라잡기 공짜).
import { useEffect, useRef } from "react";

import { ipc, type Project } from "./ipc";
import { chat, llmReadyReason, useLlmStatus } from "./llm";
import {
  addDays,
  buildMessages,
  inputHash,
  maxTokensFor,
  periodRange,
  reportKey,
  scopeKey,
  today,
  type ReportSource,
} from "./report";
import { useProjects, useSettings } from "../queries";

/** 점검 간격 — 예약은 분 단위 정확도가 필요 없다(주 1회다). */
const TICK_MS = 10 * 60_000;

/**
 * 만들 대상 기간 = **지난주**(월~일). 이번 주로 잡으면 주중에 한 번 만들고 그 뒤 커밋은
 * 영영 반영되지 않는다("입력이 바뀜" 뱃지만 남는다). 주가 끝난 뒤 한 번 만드는 게 맞다.
 */
export function lastWeekRange(todayYmd: string): { since: string; until: string } {
  const thisWeek = periodRange("week", todayYmd).since;
  const since = addDays(thisWeek, -7);
  return { since, until: addDays(since, 6) };
}

/** 프로젝트 1개분 근거 — 카드의 두 쿼리와 **같은 커맨드**를 직접 부른다. */
async function fetchSource(p: Project, since: string, until: string, mine: boolean): Promise<ReportSource> {
  const [commits, prompts] = await Promise.all([
    ipc.commitsBetween(p.id, since, until, mine),
    ipc.claudePrompts(p.path, since, until),
  ]);
  return { project: p, commits, prompts: prompts.items };
}

/**
 * 한 프로젝트의 지난주 요약을 만들어 저장한다. 활동이 없으면 아무것도 하지 않는다.
 * 반환: 실제로 만들었으면 true.
 */
async function runOne(
  p: Project,
  since: string,
  until: string,
  opts: { mine: boolean; language: string; ctx?: number; modelId?: string; model: string },
): Promise<boolean> {
  const src = await fetchSource(p, since, until, opts.mine);
  if (src.commits.length === 0 && src.prompts.length === 0) return false;
  const done = await chat(
    buildMessages({ sources: [src], period: "week", since, until, language: opts.language, ctx: opts.ctx }),
    () => {}, // 예약 실행은 그릴 화면이 없다 — 델타는 버리고 done.text 만 쓴다
    { maxTokens: maxTokensFor("week"), temperature: 0.3, modelId: opts.modelId },
  );
  await ipc.reportSet(reportKey(scopeKey([p]), "week", since), {
    text: done.text,
    generatedAt: new Date().toISOString(),
    inputHash: await inputHash([src]),
    model: opts.model,
  });
  return true;
}

/**
 * 예약 점검 1회. 화면이 없으므로 조용히 실패하고 다음 회차에 다시 본다 —
 * 단 **던지지는 않는다**(setInterval 안에서 던지면 그 뒤 회차가 죽는다).
 */
export async function checkOnce(args: {
  projects: Project[];
  todayYmd: string;
  mine: boolean;
  language: string;
  ctx?: number;
  modelId?: string;
  model: string;
}): Promise<number> {
  const { since, until } = lastWeekRange(args.todayYmd);
  const saved = await ipc.reportGetAll();
  let made = 0;
  for (const p of args.projects) {
    if (saved[reportKey(scopeKey([p]), "week", since)]) continue;
    try {
      if (await runOne(p, since, until, args)) made++;
    } catch {
      // 59 는 한 번에 한 요청이라 사용자가 번역·채팅 중이면 Busy 로 거절된다.
      // 그건 오류가 아니라 "지금은 때가 아님"이므로 이 회차를 접고 다음 tick 에 다시 본다.
      break;
    }
  }
  return made;
}

/** 메인 창에서 한 번 마운트한다(App.tsx). 보조 창은 `main.tsx` 가 다른 루트로 보내므로 안 돈다. */
export function useReportSchedule() {
  const { data: settings } = useSettings();
  const { data: projects } = useProjects();
  const { data: status } = useLlmStatus();
  // 회차가 겹치지 않게 — 한 번에 한 요청이라 두 회차가 물리면 서로 Busy 를 만든다.
  const running = useRef(false);

  const enabled = !!settings?.reportAutoWeekly;
  const ready = enabled && !llmReadyReason(status, settings, settings?.llmReportModel ?? null);

  useEffect(() => {
    if (!ready || !projects?.length || !settings) return;
    const tick = async () => {
      if (running.current) return;
      running.current = true;
      try {
        await checkOnce({
          projects,
          todayYmd: today(), // report.ts 의 로컬 날짜 — 카드와 같은 기준을 써야 키가 맞는다
          mine: true,
          language: settings.llmLanguage || "ko",
          ctx: settings.llmContext,
          modelId: settings.llmReportModel?.trim() || undefined,
          model:
            settings.llmProvider === "external"
              ? (settings.llmExternalModel ?? "external")
              : (settings.llmReportModel?.trim() || settings.llmModel),
        });
      } finally {
        running.current = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), TICK_MS);
    return () => window.clearInterval(id);
  }, [ready, projects, settings]);
}
