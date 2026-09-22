import { Loader2, MessageSquare, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { fmtDateTime } from "../../i18n/format-locale";
import { useMessages } from "../../i18n/ui-language";
import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage } from "../../lib/ipc";
import type { Project } from "../../lib/ipc";
import { chat, llmReadyReason, useLlmStatus } from "../../lib/llm";
import type { ChatContext, Period, ReportSource } from "../../lib/report";
import {
  buildMessages,
  inputHash,
  maxTokensFor,
  reportKey,
  scopeKey,
} from "../../lib/report";
import {
  useCommitsBetweenMany,
  usePromptDumps,
  useReports,
  useSetReport,
  useSettings,
} from "../../queries";
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
 */
export function ReportCard({
  projects,
  period,
  since,
  until,
  mine,
  stripe,
  runNow,
  onFinish,
  onAsk,
}: {
  projects: Project[];
  period: Period;
  since: string;
  until: string;
  mine: boolean;
  stripe: string;
  /** 배치("모두 생성")의 현재 차례 — true가 되는 순간 1회 생성한다. */
  runNow?: boolean;
  onFinish?: () => void;
  /** [AI에게 묻기] — 뷰가 우측 채팅 패널을 이 컨텍스트로 연다(§3.2). */
  onAsk?: (ctx: ChatContext) => void;
}) {
  const msg = useMessages();
  const commitQs = useCommitsBetweenMany(projects, since, until, mine);
  const promptQs = usePromptDumps(projects, since, until);
  const { data: reports } = useReports();
  const { data: settings } = useSettings();
  const { data: status } = useLlmStatus();
  const setReport = useSetReport();
  const openSettings = useUi((s) => s.openSettings);

  const scope = scopeKey(projects);
  const key = reportKey(scope, period, since);
  const saved = reports?.[key];
  // 리포트는 전용 모델을 쓸 수 있다(설정 `llmReportModel`) — 준비 판정도 **그 모델**을 봐야 한다.
  const reportModel = settings?.llmReportModel ?? null;
  const reason = llmReadyReason(status, settings, reportModel);
  const combined = projects.length > 1;

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 지금 카드가 가리키는 기간 — 비동기 생성이 끝났을 때 "그 사이에 기간이 바뀌었나"를 본다.
  const keyRef = useRef(key);
  keyRef.current = key;

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
  const empty = !loading && commitCount === 0 && promptCount === 0;

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

  // 기간·프로젝트가 바뀌면 화면의 스트리밍 결과는 그 기간 것이 아니다 — 저장본으로 되돌린다.
  // 진행 중인 생성도 함께 끊는다: 카드는 key가 같아 리마운트되지 않으므로(ReportView가
  // `key={p.id}`) 안 끊으면 **떠난 기간**의 토큰이 새 기간 머리글 아래로 계속 쌓이고,
  // 한 번에 하나뿐인 LLM 슬롯도 그동안 물고 있는다.
  useEffect(() => {
    abortRef.current?.abort();
    setText("");
    setNote(null);
  }, [key]);

  // 저장본이 새로 오면 로컬 텍스트를 비운다 — 채팅의 [요약으로 저장](§3.2)이 이 카드의 키에
  // 쓰는데, 스트리밍 잔여 `text`가 남아 있으면 `body`가 그쪽을 먼저 골라 **옛 본문이 계속
  // 보인다**("저장했는데 안 바뀐다").
  useEffect(() => {
    setText("");
  }, [saved?.generatedAt]);

  const stale = !!saved && !!hash && saved.inputHash !== hash;
  const body = text || saved?.text || "";
  const title = combined ? msg.report.card.combinedTitle(projects.length) : (projects[0]?.name ?? "");
  const model =
    settings?.llmProvider === "external"
      ? (settings.llmExternalModel ?? "external")
      : (settings?.llmModel ?? "");

  const generate = async () => {
    if (busy || reason || empty) return;
    setBusy(true);
    setText("");
    setNote(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const keyAtStart = key;
    let acc = "";
    try {
      const done = await chat(
        buildMessages({
          sources,
          period,
          since,
          until,
          language: settings?.llmLanguage ?? "ko",
          ctx: settings?.llmContext,
          prompt: settings?.reportPrompt,
        }),
        // 취소는 `llm_cancel` IPC 왕복이라 abort 직후에도 델타가 몇 개 더 온다 —
        // 그걸 그리면 기간을 바꾼 카드에 옛 기간 본문이 도로 채워진다.
        (delta) => {
          acc += delta;
          if (!ac.signal.aborted) setText(acc);
        },
        {
          // 날짜마다 3줄이라 응답이 기간에 비례한다(값과 근거는 maxTokensFor 주석).
          maxTokens: maxTokensFor(period),
          temperature: 0.3,
          modelId: reportModel ?? undefined,
          signal: ac.signal,
          onProgress: (_phase, message) => setNote(message ?? msg.report.modelLoading),
        },
      );
      if (!ac.signal.aborted) setText(done.text);
      setNote(null);
      await setReport.mutateAsync({
        key,
        record: {
          text: done.text,
          generatedAt: new Date().toISOString(),
          inputHash: await inputHash(sources),
          model,
        },
      });
    } catch (e) {
      // 취소는 오류가 아니다 — 카드에 흔적만 남기고 지금까지 받은 텍스트는 그대로 둔다.
      // 단 **기간을 옮겨서** 끊긴 경우는 조용히 넘어간다: 그 "취소됨"은 사용자가 지금 보고 있는
      // 새 기간 머리글 아래에 붙어, 누르지도 않은 취소가 일어난 것처럼 보인다.
      if (keyAtStart !== keyRef.current)
        return;
      setNote(ac.signal.aborted ? msg.report.cancelled : errorMessage(e));
    } finally {
      setBusy(false);
      abortRef.current = null;
      onFinish?.();
    }
  };

  // 배치 차례 — 부모가 순서대로 한 장씩 켠다(59는 한 번에 한 요청).
  // 생성할 수 없는 카드(활동 없음·LLM 미준비)는 **여기서** 건너뛴다: generate()의 이른 반환은
  // try 이전이라 `finally`의 onFinish를 타지 않아, 대기열이 그 카드에서 영영 멈춘다.
  // generate() 쪽을 고치지 않는 이유는 수동 버튼도 같은 함수를 쓰기 때문 — 그쪽이 대기열을
  // 밀면 안 된다.
  useEffect(() => {
    if (!runNow) return;
    // 데이터가 아직 안 왔으면 **기다린다**(건너뛰지 않는다) — loading이 deps에 있어
    // 도착하는 순간 이 효과가 다시 돈다. 안 그러면 "모두 생성"을 연 직후 누른 사용자에게
    // 아직 로딩 중이던 카드만 조용히 빈 채로 남는다.
    if (loading) return;
    if (busy || reason || empty) onFinish?.();
    else void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runNow, loading]);

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
                onClick={() => abortRef.current?.abort()}
                className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] text-fg-muted hover:text-fg"
              >
                <X size={11} /> {msg.report.cancel}
              </button>
            ) : (
              <button
                onClick={() => void generate()}
                disabled={!!reason || empty}
                title={reason ?? undefined}
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
