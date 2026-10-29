import { useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquare, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { fmtDateTime } from "../../i18n/format-locale";
import { useMessages } from "../../i18n/ui-language";
import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage } from "../../lib/ipc";
import type { Project } from "../../lib/ipc";
import { llmReadyReason, useLlmStatus } from "../../lib/llm";
import type { ChatContext, Period, ReportSource } from "../../lib/report";
import { inputHash, reportKey, scopeKey } from "../../lib/report";
import { useCommitsBetweenMany, usePromptDumps, useReports, useSettings } from "../../queries";
import { cancelReport, clearReportResidue, enqueueReport, useReportJobs } from "../../stores/reportJobs";
import { useUi } from "../../stores/ui";
import MarkdownView from "../diff/MarkdownView";
import { ProjectLogo } from "../common/ProjectLogo";

/**
 * 프로젝트 N개 × 선택 기간의 요약 카드.
 *
 * 1개면 개별 카드, 2개 이상이면 **종합 카드**다(태스크 67 §3.1) — 카운트는 합, 근거는 한 블록에
 * 섞여 들어가고 저장 키는 조합 해시(`scopeKey`)다.
 *
 * 입력(커밋·프롬프트)은 LLM이 없어도 보인다 — "요약 생성"만 막힌다(설계 60 §1). 저장된 요약이
 * 있으면 즉시 본문을 그리고, 입력 해시가 달라졌으면 "입력이 바뀜" 뱃지로 재생성을 권한다.
 * 생성 자체는 카드 밖 대기열(stores/reportJobs)에서 돈다 — 카드는 자기 키의 진행 상태를 그리기만 한다.
 */
export function ReportCard({
  projects,
  period,
  since,
  until,
  mine,
  stripe,
  onAsk,
}: {
  projects: Project[];
  period: Period;
  since: string;
  until: string;
  mine: boolean;
  stripe: string;
  /** [AI에게 묻기] — 뷰가 우측 채팅 패널을 이 컨텍스트로 연다(§3.2). */
  onAsk?: (ctx: ChatContext) => void;
}) {
  const msg = useMessages();
  const commitQs = useCommitsBetweenMany(projects, since, until, mine);
  const promptQs = usePromptDumps(projects, since, until);
  const { data: reports } = useReports();
  const { data: settings } = useSettings();
  const { data: status } = useLlmStatus();
  const qc = useQueryClient();
  const openSettings = useUi((s) => s.openSettings);

  const scope = scopeKey(projects);
  const key = reportKey(scope, period, since);
  const saved = reports?.[key];
  // 리포트는 전용 모델을 쓸 수 있다(설정 `llmReportModel`) — 준비 판정도 **그 모델**을 봐야 한다.
  const reportModel = settings?.llmReportModel ?? null;
  const reason = llmReadyReason(status, settings, reportModel);
  const combined = projects.length > 1;

  const [hash, setHash] = useState<string | null>(null);
  const job = useReportJobs((s) => s.jobs[key]);
  const busy = job?.status === "queued" || job?.status === "running";
  const text = job?.text ?? "";
  const note = job?.status === "queued" ? msg.report.card.queued : (job?.note ?? null);

  // `useQueries` 결과는 렌더마다 새 배열·새 객체다(query-core는 combine 없이는 구조 공유를
  // 하지 않는다) — 그대로 deps에 넣으면 아래 해시 효과가 매 렌더 돈다. 데이터가 실제로 바뀐
  // 시점만 보는 `dataUpdatedAt`으로 서명을 만들어 고정한다(`?? []`도 같은 이유로 여기 안에).
  const sig = [...commitQs, ...promptQs].map((q) => q.dataUpdatedAt).join(",");
  const sources: ReportSource[] = useMemo(
    () =>
      projects.map((p, i) => ({
        project: p,
        commits: commitQs[i]?.data ?? [],
        prompts: promptQs[i]?.data?.items ?? [],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, sig],
  );

  const commitCount = sources.reduce((n, s) => n + s.commits.length, 0);
  const promptCount = sources.reduce((n, s) => n + s.prompts.length, 0);
  // 아직 안 온 데이터를 "활동 없음"으로 읽으면 안 된다 — 배치가 그 카드를 조용히 건너뛴다.
  const loading = [...commitQs, ...promptQs].some((q) => q.isPending);
  // **못 읽은 데이터도 0건으로 읽으면 안 된다.** 위 `data ?? []` 가 실패를 빈 목록으로 만들어, 커밋 조회가
  // 시간 초과로 실패한 채 프롬프트만으로 요약이 나갔다 — 모델이 "작업이 전혀 없었다"를 7일치 지어냈다
  // (2026-10-02 실사례, 그 시각 설치본 로그 `health=danger sys=timeout`). 실패가 있으면 생성을 막고 보인다.
  const failedQs = [...commitQs, ...promptQs].filter((q) => q.isError);
  const loadError = failedQs.length > 0 ? errorMessage(failedQs[0].error) : null;
  const empty = !loading && !loadError && commitCount === 0 && promptCount === 0;

  // 저장된 요약이 아직 유효한가 — 입력이 바뀌면 뱃지를 띄운다.
  useEffect(() => {
    let alive = true;
    void inputHash(sources).then((h) => {
      if (alive) setHash(h);
    });
    return () => {
      alive = false;
    };
  }, [sources]);

  // 저장본이 새로 오면 남은 실패·취소 흔적을 지운다 — 채팅의 [요약으로 저장](§3.2)이 이 카드의 키에 쓰는데,
  // 흔적의 `text`가 남아 있으면 `body`가 그쪽을 먼저 골라 **옛 본문이 계속 보인다**("저장했는데 안 바뀐다").
  // 마운트 때는 건너뛴다 — 접었다 다시 연 카드가 "취소됨"·오류 안내를 잃지 않게.
  const seenGenerated = useRef(saved?.generatedAt);
  useEffect(() => {
    if (seenGenerated.current === saved?.generatedAt) return;
    seenGenerated.current = saved?.generatedAt;
    clearReportResidue(key);
  }, [saved?.generatedAt, key]);

  const stale = !!saved && !!hash && saved.inputHash !== hash;
  const body = text || saved?.text || "";
  const title = combined ? msg.report.card.combinedTitle(projects.length) : (projects[0]?.name ?? "");
  const generate = () => {
    if (busy || reason || empty || loadError) return;
    enqueueReport({ key, projects, period, since, until, mine, settings, qc });
  };

  return (
    <div
      data-gpv={combined ? "report-card-combined" : "report-card"}
      data-scope-key={scope}
      className="flex overflow-hidden rounded border border-edge bg-panel"
    >
      <span aria-hidden style={{ background: stripe }} className="w-1 shrink-0" />
      <div className="min-w-0 flex-1 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {combined ? (
            // 로고 3개까지 겹쳐 그린다 — 어느 프로젝트가 섞였는지 한눈에 보이되 헤더가 길어지지 않게.
            <span className="flex shrink-0 items-center">
              {projects.slice(0, 3).map((p, i) => (
                <ProjectLogo
                  key={p.id}
                  projectId={p.id}
                  size={16}
                  className={i > 0 ? "-ml-1.5 ring-1 ring-panel" : undefined}
                />
              ))}
            </span>
          ) : (
            <ProjectLogo projectId={projects[0]?.id ?? ""} size={16} />
          )}
          <span className="truncate text-xs font-medium text-fg">{title}</span>
          <span className="text-[11px] text-fg-muted">
            {msg.report.card.counts(commitCount, promptCount)}
          </span>
          {stale && (
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">
              {msg.report.card.inputChanged}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {saved && !busy && (
              <span className="text-[10px] text-fg-dim">
                {fmtDateTime(new Date(saved.generatedAt))} · {saved.model}
              </span>
            )}
            {onAsk && (
              <button
                data-gpv="report-ask"
                onClick={() =>
                  onAsk({ key, title, sources, period, since, until, body, hash })
                }
                title={msg.report.card.askTitle}
                className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg"
              >
                <MessageSquare size={11} /> {msg.report.card.ask}
              </button>
            )}
            {busy ? (
              <button
                onClick={() => cancelReport(key)}
                className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg"
              >
                <X size={11} /> {msg.report.cancel}
              </button>
            ) : (
              <button
                onClick={generate}
                disabled={!!reason || empty || !!loadError}
                title={reason ?? loadError ?? undefined}
                className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles size={11} /> {saved ? msg.report.card.regenerate : msg.report.card.generate}
              </button>
            )}
          </div>
        </div>

        {reason && (
          <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
            <span>{reason}</span>
            {/* 별도 창(doc-*)엔 설정 다이얼로그가 없다 — 버튼을 두면 눌러도 아무 일이 없다(§3.3). */}
            {IS_DOC_WINDOW ? (
              <span className="text-fg-dim">{msg.report.prepareInMainSettings}</span>
            ) : (
              <button
                onClick={() => openSettings("ai")}
                className="rounded bg-raised px-1.5 py-0.5 text-fg-muted hover:text-fg"
              >
                {msg.report.openSettings}
              </button>
            )}
          </div>
        )}

        {loadError && (
          <div data-gpv="report-load-error" className="mt-2 flex items-center gap-2 text-[11px] text-danger">
            <span className="min-w-0 break-all">{msg.report.card.loadFailed(loadError)}</span>
            <button
              onClick={() => failedQs.forEach((q) => void q.refetch())}
              className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-fg-muted hover:text-fg"
            >
              {msg.report.card.retry}
            </button>
          </div>
        )}

        {busy && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <Loader2 size={11} className="animate-spin" />
            {note ?? msg.report.card.generating}
          </div>
        )}
        {!busy && note && (
          <div className="mt-2 text-[11px] text-fg-muted">{note}</div>
        )}

        {empty ? (
          <div className="mt-2 text-[11px] text-fg-dim">{msg.report.card.noActivity}</div>
        ) : body ? (
          <div className="mt-2 max-h-[50vh] overflow-auto rounded border border-edge">
            <MarkdownView content={body} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
