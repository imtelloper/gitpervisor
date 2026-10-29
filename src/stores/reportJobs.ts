// 리포트 요약 생성 대기열 — 화면(ReportCard)과 떼어 창 수명 동안 산다.
//
// 요약 한 번이 수 분 걸린다. 카드 컴포넌트가 생성을 들고 있던 때는 리포트를 접거나(모아보기 칩 숨김) 다른 화면으로
// 갔다 오면 카드가 다시 마운트되며 진행 상태를 잃었다 — 요청은 뒤에서 계속 돌아 LLM 슬롯을 물고 있는데 화면은
// "생성 안 함"이라, 다시 누르면 "다른 AI 요청이 진행 중입니다"로 실패했다. 이제 작업은 여기서 돌고 카드는 자기 키의
// 상태를 구독만 한다. LLM 은 한 번에 한 요청이라 직렬 대기열이다 — 다른 카드의 생성은 실패 대신 차례를 기다린다.
// 입력은 **차례가 왔을 때** 같은 쿼리 캐시에서 읽는다(카드가 화면에 없어도 "모두 생성"이 이어진다).
//
// 대기열은 **메인 창 하나**에만 있다 — 모아보기 별도 창·별도 리포트 창에서 누른 생성도 그 창을 닫으면 같이 죽지
// 않게. 다른 창은 명령을 메인에 보내고(report-jobs://cmd) 메인이 방송하는 상태(report-jobs://state)를 그린다.
// 메인 창을 닫으면 앱이 끝난다(lib.rs CloseRequested). 저장된 요약은 report://changed 로 각 창 캐시에 들어간다.

import type { QueryClient } from "@tanstack/react-query";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

import { currentMessages } from "../i18n/ui-language";
import { errorMessage, ipc, type Project, type ReportMap, type Settings } from "../lib/ipc";
import { chatWithBusyRetry } from "../lib/llm";
import { buildMessages, inputHash, maxTokensFor, type Period, type ReportSource } from "../lib/report";
import { commitsBetweenQuery, promptDumpQuery } from "../queries";

export interface ReportJob {
  /** 성공하면 항목이 사라진다(저장본이 본문이 된다). failed 는 취소·오류 — 받은 데까지의 text 와 note 를 남긴다. */
  status: "queued" | "running" | "failed";
  text: string;
  note: string | null;
  batch: string | null;
}

/** 창 사이로 오간다 — 직렬화 가능한 값만. */
export interface ReportJobInput {
  key: string;
  projects: Project[];
  period: Period;
  since: string;
  until: string;
  mine: boolean;
  settings: Settings | undefined;
}

type ReportJobsCmd =
  | { op: "enqueue"; input: ReportJobInput }
  | { op: "cancel"; key: string }
  | { op: "clear"; key: string }
  | { op: "batch"; items: ReportJobInput[] }
  | { op: "cancelBatch" }
  | { op: "sync" };

const IS_MAIN = (() => {
  try {
    return getCurrentWebviewWindow().label === "main";
  } catch {
    return true; // Tauri 밖(단위 검사 등) — 스스로 돈다
  }
})();

const sendCmd = (cmd: ReportJobsCmd) =>
  void emitTo("main", "report-jobs://cmd", cmd).catch((e) => console.error("[report-jobs] main delegation failed", cmd.op, e));

/** 메인 창의 QueryClient — 입력을 그 캐시로 읽고 저장본을 그 캐시에 넣는다(main.tsx 부팅이 묶는다). */
let qc: QueryClient | null = null;
export function bindReportJobsQueryClient(client: QueryClient): void {
  qc = client;
}

interface ReportJobsState {
  jobs: Record<string, ReportJob>;
  batch: { id: string; total: number } | null;
}

export const useReportJobs = create<ReportJobsState>(() => ({ jobs: {}, batch: null }));

const controllers = new Map<string, AbortController>();
let tail: Promise<void> = Promise.resolve();

const active = (j: ReportJob | undefined) => j?.status === "queued" || j?.status === "running";

function patch(key: string, p: Partial<ReportJob> | null) {
  useReportJobs.setState((s) => {
    const jobs = { ...s.jobs };
    if (p === null) delete jobs[key];
    else jobs[key] = { ...(jobs[key] ?? { status: "queued", text: "", note: null, batch: null }), ...p };
    return { jobs };
  });
}

/** 리포트는 전용 모델을 쓸 수 있다(설정 `llmReportModel`) — 기록에도 실제로 요청한 모델 이름을 남긴다. */
export function reportModelName(settings: Settings | undefined): string {
  if (settings?.llmProvider === "external") return settings.llmExternalModel ?? "external";
  return settings?.llmReportModel ?? settings?.llmModel ?? "";
}

async function loadSources(i: ReportJobInput): Promise<ReportSource[]> {
  const c = qc;
  if (!c) throw new Error("report jobs: query client is not bound in this window");
  return Promise.all(
    i.projects.map(async (project) => {
      const [commits, dump] = await Promise.all([
        c.fetchQuery(commitsBetweenQuery(project, i.since, i.until, i.mine)),
        c.fetchQuery(promptDumpQuery(project, i.since, i.until)),
      ]);
      return { project, commits, prompts: dump.items };
    }),
  );
}

async function run(i: ReportJobInput, ac: AbortController): Promise<void> {
  const t = currentMessages().report;
  if (ac.signal.aborted) return patch(i.key, null); // 대기 중에 취소 — 흔적 없이 뺀다
  patch(i.key, { status: "running" });
  let sources: ReportSource[];
  try {
    sources = await loadSources(i);
  } catch (e) {
    // 못 읽은 입력을 0건으로 요약하면 모델이 "작업 없음"을 지어낸다(ReportCard loadError 와 같은 이유).
    return patch(i.key, { status: "failed", note: t.card.loadFailed(errorMessage(e)) });
  }
  // 활동이 없으면 조용히 건너뛴다 — "모두 생성"의 빈 프로젝트.
  if (!sources.some((s) => s.commits.length || s.prompts.length)) return patch(i.key, null);
  let acc = "";
  try {
    const modelId = i.settings?.llmReportModel ?? undefined;
    // 다른 창(별도 리포트 창)·채팅 패널·예약 리포트가 LLM 을 물고 있으면 실패하지 않고 기다린다.
    const done = await chatWithBusyRetry(
      buildMessages({
        sources,
        period: i.period,
        since: i.since,
        until: i.until,
        language: i.settings?.llmLanguage ?? "ko",
        ctx: i.settings?.llmContext,
        prompt: i.settings?.reportPrompt,
      }),
      // 취소는 `llm_cancel` IPC 왕복이라 abort 직후에도 델타가 몇 개 더 온다 — 받은 데까지만 남긴다.
      (delta) => {
        acc += delta;
        // 첫 토큰이 오면 "모델 로드 중…" 안내는 끝난 것이다 — 남기면 본문 위에 낡은 초가 붙어 있다.
        if (!ac.signal.aborted) patch(i.key, { text: acc, note: null });
      },
      {
        // 날짜마다 3줄이라 응답이 기간에 비례한다(값과 근거는 maxTokensFor 주석).
        maxTokens: maxTokensFor(i.period),
        temperature: 0.3,
        modelId,
        signal: ac.signal,
        onProgress: (_phase, message) => patch(i.key, { note: message ?? t.modelLoading }),
        onBusy: () => patch(i.key, { note: t.card.waitingOtherAi }),
      },
    );
    const record = {
      text: done.text,
      generatedAt: new Date().toISOString(),
      inputHash: await inputHash(sources),
      model: reportModelName(i.settings),
    };
    await ipc.reportSet(i.key, record);
    qc?.setQueryData<ReportMap>(["reports"], (old) => ({ ...old, [i.key]: record }));
    patch(i.key, null);
  } catch (e) {
    patch(i.key, { status: "failed", text: acc, note: ac.signal.aborted ? t.cancelled : errorMessage(e) });
  }
}

/** 생성을 대기열에 넣는다. 같은 키가 이미 대기·진행 중이면 무시한다. */
export function enqueueReport(i: ReportJobInput): void {
  if (IS_MAIN) enqueueLocal(i, null);
  else sendCmd({ op: "enqueue", input: i });
}

function enqueueLocal(i: ReportJobInput, batch: string | null): void {
  if (active(useReportJobs.getState().jobs[i.key])) return;
  const ac = new AbortController();
  controllers.set(i.key, ac);
  patch(i.key, { status: "queued", text: "", note: null, batch });
  tail = tail.then(async () => {
    try {
      await run(i, ac);
    } catch (e) {
      // run 은 스스로 잡는다 — 여기 오면 patch 자체가 던진 것이다. 대기열이 멈추지 않게 남기고 넘어간다.
      console.error("[report-jobs] job failed outside its handler", i.key, e);
    } finally {
      if (controllers.get(i.key) === ac) controllers.delete(i.key);
      settleBatch();
    }
  });
}

export function cancelReport(key: string): void {
  if (IS_MAIN) controllers.get(key)?.abort();
  else sendCmd({ op: "cancel", key });
}

/** 실패·취소로 남은 흔적을 지운다(저장본이 새로 왔을 때 — 채팅의 [요약으로 저장]). 진행 중이면 두지 않는다. */
export function clearReportResidue(key: string): void {
  if (!IS_MAIN) return sendCmd({ op: "clear", key });
  if (!active(useReportJobs.getState().jobs[key])) patch(key, null);
}

/** "모두 생성" — 각 항목을 순서대로 대기열에. 진행률은 그 배치에서 아직 안 끝난 작업 수로 센다. */
export function startReportBatch(items: ReportJobInput[]): void {
  if (!items.length) return;
  if (!IS_MAIN) return sendCmd({ op: "batch", items });
  const id = crypto.randomUUID();
  useReportJobs.setState({ batch: { id, total: items.length } });
  for (const i of items) enqueueLocal(i, id);
}

export function cancelReportBatch(): void {
  if (!IS_MAIN) return sendCmd({ op: "cancelBatch" });
  const b = useReportJobs.getState().batch;
  if (!b) return;
  for (const [key, j] of Object.entries(useReportJobs.getState().jobs)) if (j.batch === b.id && active(j)) cancelReport(key);
  useReportJobs.setState({ batch: null });
}

function settleBatch() {
  const { batch, jobs } = useReportJobs.getState();
  if (batch && !Object.values(jobs).some((j) => j.batch === batch.id && active(j))) useReportJobs.setState({ batch: null });
}

export function batchRemaining(s: ReportJobsState): number {
  const b = s.batch;
  return b ? Object.values(s.jobs).filter((j) => j.batch === b.id && active(j)).length : 0;
}

// ── 창 사이 동기화 ────────────────────────────────────────────────────────────

if (IS_MAIN) {
  // 토큰마다 창마다 IPC 를 쏘지 않게 100ms 로 모은다 — 스트리밍 본문은 그 간격이면 충분히 매끄럽다.
  let timer: number | null = null;
  const broadcast = () => {
    timer = null;
    const { jobs, batch } = useReportJobs.getState();
    void emit("report-jobs://state", { jobs, batch }).catch((e) => console.error("[report-jobs] broadcast failed", e));
  };
  void listen<ReportJobsCmd>("report-jobs://cmd", ({ payload: c }) => {
    if (c.op === "enqueue") enqueueLocal(c.input, null);
    else if (c.op === "cancel") cancelReport(c.key);
    else if (c.op === "clear") clearReportResidue(c.key);
    else if (c.op === "batch") startReportBatch(c.items);
    else if (c.op === "cancelBatch") cancelReportBatch();
    else if (c.op === "sync") broadcast();
    else {
      const never: never = c;
      console.error("[report-jobs] unknown command", never);
    }
  });
  useReportJobs.subscribe(() => {
    timer ??= window.setTimeout(broadcast, 100);
  });
} else {
  void listen<ReportJobsState>("report-jobs://state", ({ payload }) => useReportJobs.setState(payload));
  // 늦게 연 창은 지금 상태를 한 번 받아 온다 — 진행 중인 생성이 이 창에서도 바로 보이게.
  sendCmd({ op: "sync" });
}
