// 대본 요약 — 대본 패널 헤더 [요약] 팝업. 개요·핵심 내용·장면 목차(누르면 그 시각으로), 진행·취소·다시 요약.
//
// 잡은 captionDoc 스토어가 든다(팝업을 닫아도 창이 살아 있으면 계속 돈다). 결과는 문서 `summary`에 저장된다.
import { Copy, Loader2 } from "lucide-react";
import { useMemo } from "react";

import { useMessages } from "../../../i18n/ui-language";
import { captionSummaryEmpty, captionSummaryStale, captionSummaryText, fmtClock } from "../../../lib/captionSummary";
import { copyWithToast } from "../../../lib/clipboard";
import type { CaptionDoc } from "../../../lib/ipc";
import { llmReadyReason, useLlmStatus } from "../../../lib/llm";
import { HAS_SETTINGS_DIALOG } from "../../../lib/stt";
import { useSettings } from "../../../queries";
import { useCaptionDoc } from "../../../stores/captionDoc";
import { useUi } from "../../../stores/ui";

const smallBtn = "rounded border border-edge px-2 py-0.5 hover:bg-raised hover:text-fg disabled:opacity-40";

export function SummaryPanel({
  capKey,
  doc,
  blocked,
  onSeek,
}: {
  capKey: string;
  doc: CaptionDoc;
  /** 요약을 시작할 수 없는 이유(전사 중·읽기 전용) — null이면 가능. */
  blocked: string | null;
  /** 문서 시각(ms)으로 이동. */
  onSeek: (ms: number) => void;
}) {
  const msg = useMessages();
  const t = msg.captions.summary;
  const job = useCaptionDoc((s) => s.entries[capKey]?.summarize ?? null);
  const error = useCaptionDoc((s) => s.entries[capKey]?.summaryError ?? null);
  const openSettings = useUi((s) => s.openSettings);
  const { data: settings } = useSettings();
  const { data: llm } = useLlmStatus();
  const notReady = llmReadyReason(llm, settings);
  const empty = useMemo(() => captionSummaryEmpty(doc), [doc]);
  const stale = useMemo(() => captionSummaryStale(doc), [doc]);
  const summary = doc.summary;

  const start = () => void useCaptionDoc.getState().summarize(capKey, settings?.llmContext ?? 8192);

  return (
    <div data-gpv="summary-panel" className="max-h-[60%] shrink-0 space-y-2 overflow-auto border-b border-edge px-3 py-2">
      {job ? (
        <div data-gpv="summary-progress" className="space-y-1">
          <div className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-accent" />
            <span className="text-fg">{t.running}</span>
            {job.total > 1 && <span className="font-mono tabular-nums">{t.step(job.done, job.total)}</span>}
            <div className="flex-1" />
            <button
              data-gpv="summary-cancel"
              onClick={() => useCaptionDoc.getState().cancelSummarize(capKey)}
              className={`${smallBtn} text-warn`}
            >
              {msg.captions.cancel}
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-raised">
            <div
              className="h-full rounded bg-accent transition-[width]"
              style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }}
            />
          </div>
          {job.status && <div className="text-[11px] text-fg-dim">{job.status}</div>}
        </div>
      ) : (
        <>
          {notReady && (
            <div className="flex flex-wrap items-center gap-1.5 rounded border border-edge bg-base px-2 py-1.5">
              <span className="min-w-0 flex-1 text-fg">{notReady}</span>
              {HAS_SETTINGS_DIALOG ? (
                <button onClick={() => openSettings("ai")} className={smallBtn}>
                  {msg.captions.openAiSettings}
                </button>
              ) : (
                <span className="text-[11px] text-fg-dim">{msg.captions.settingsInMainWindow}</span>
              )}
            </div>
          )}
          {blocked && <div className="text-[11px] text-warn">{blocked}</div>}
          <button
            data-gpv="summary-start"
            onClick={start}
            disabled={!!notReady || !!blocked || empty}
            className="w-full rounded bg-accent/20 px-3 py-1 font-semibold text-accent hover:bg-accent/30 disabled:bg-transparent disabled:font-normal disabled:text-fg-muted"
          >
            {empty ? t.empty : summary ? t.redo : t.start}
          </button>
        </>
      )}
      {error && <div className="text-[11px] text-danger">{error}</div>}

      {summary && (
        <div data-gpv="summary-result" className="space-y-2 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-fg-dim">{t.overview}</span>
            {stale && (
              <span className="rounded bg-warn/15 px-1 text-[10px] text-warn" title={t.staleTitle}>
                {t.staleBadge}
              </span>
            )}
            <div className="flex-1" />
            <button
              onClick={() => copyWithToast(captionSummaryText(summary, t), t.copied)}
              title={t.copyTitle}
              className={`${smallBtn} flex items-center gap-1 text-[11px] text-fg-dim`}
            >
              <Copy size={11} />
              {t.copy}
            </button>
          </div>
          <p className="select-text leading-relaxed text-fg">{summary.overview}</p>
          <div className="text-[11px] font-semibold text-fg-dim">{t.points}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-fg">
            {summary.points.map((p, i) => (
              <li key={i} className="select-text leading-relaxed">
                {p}
              </li>
            ))}
          </ul>
          {summary.chapters.length > 0 && (
            <>
              <div className="text-[11px] font-semibold text-fg-dim">{t.chapters}</div>
              <div className="space-y-px">
                {summary.chapters.map((c) => (
                  <button
                    key={c.startMs}
                    data-gpv="summary-chapter"
                    onClick={() => onSeek(c.startMs)}
                    title={t.seekChapter}
                    className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-raised"
                  >
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-accent">{fmtClock(c.startMs)}</span>
                    <span className="min-w-0 text-fg">{c.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div className="text-[11px] text-fg-dim">{t.help}</div>
    </div>
  );
}
