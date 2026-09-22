// 번역 자막(태스크 72 §3.7, P4) — 대본 패널 헤더 [번역] 팝업. 대상 언어·진행 n/N·취소·이어서 번역.
//
// 번역 잡은 captionDoc 스토어가 든다(패널이 닫혀도 창이 살아 있으면 계속 돈다). 배치마다 문서에 저장되므로 창을
// 닫았다 열면 "이어서 번역"이 빠진 줄·원문이 바뀐 줄만 다시 한다. 모델은 61처럼 설정 › AI의 기본 모델이다.
import { Loader2 } from "lucide-react";
import { useMemo } from "react";

import { useMessages } from "../../../i18n/ui-language";
import { CAPTION_TRANSLATE_LANGS, captionLangLabel, captionTranslationCounts } from "../../../lib/captionTranslate";
import type { CaptionDoc } from "../../../lib/ipc";
import { llmReadyReason, useLlmStatus } from "../../../lib/llm";
import { HAS_SETTINGS_DIALOG } from "../../../lib/stt";
import { useSettings } from "../../../queries";
import { useCaptionDoc } from "../../../stores/captionDoc";
import { useUi } from "../../../stores/ui";

const smallBtn = "rounded border border-edge px-2 py-0.5 hover:bg-raised hover:text-fg disabled:opacity-40";
const fieldCls = "rounded border border-edge bg-base px-1.5 py-1 text-xs text-fg outline-none focus:border-accent";

export function TranslatePanel({
  capKey,
  doc,
  lang,
  onLang,
  blocked,
}: {
  capKey: string;
  doc: CaptionDoc;
  lang: string;
  onLang: (lang: string) => void;
  /** 번역을 시작할 수 없는 이유(전사 중·읽기 전용) — null이면 가능. */
  blocked: string | null;
}) {
  const msg = useMessages();
  const job = useCaptionDoc((s) => s.entries[capKey]?.translate ?? null);
  const error = useCaptionDoc((s) => s.entries[capKey]?.translateError ?? null);
  const openSettings = useUi((s) => s.openSettings);
  const { data: settings } = useSettings();
  const { data: llm } = useLlmStatus();
  const notReady = llmReadyReason(llm, settings);
  const counts = useMemo(() => captionTranslationCounts(doc, lang), [doc, lang]);
  const pending = counts.missing + counts.stale;

  const start = () => void useCaptionDoc.getState().translate(capKey, lang, settings?.llmContext ?? 8192);

  return (
    <div data-gpv="translate-panel" className="shrink-0 space-y-1.5 border-b border-edge px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-fg-dim">{msg.captions.translate.targetLang}</span>
        <select
          data-gpv="translate-lang"
          aria-label={msg.captions.translate.targetLangAria}
          value={job?.lang ?? lang}
          onChange={(e) => onLang(e.target.value)}
          disabled={!!job}
          className={fieldCls}
        >
          {CAPTION_TRANSLATE_LANGS.map((code) => (
            <option key={code} value={code}>
              {msg.captions.translateLangLabel[code]}
            </option>
          ))}
        </select>
        <span data-gpv="translate-count" className="font-mono text-[11px] tabular-nums text-fg-dim">
          {msg.captions.translate.lineCount(counts.done + counts.stale, counts.total)}
        </span>
        {counts.stale > 0 && (
          <span
            className="rounded bg-warn/15 px-1 text-[10px] text-warn"
            title={msg.captions.translate.staleTitle}
          >
            {msg.captions.translate.staleBadge(counts.stale)}
          </span>
        )}
      </div>

      {job ? (
        <div data-gpv="translate-progress" className="space-y-1">
          <div className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-accent" />
            <span className="text-fg">{msg.captions.translate.translating(captionLangLabel(job.lang))}</span>
            <span className="font-mono tabular-nums">
              {job.done + job.failed}/{job.total}
            </span>
            <div className="flex-1" />
            <button
              data-gpv="translate-cancel"
              onClick={() => useCaptionDoc.getState().cancelTranslate(capKey)}
              className={`${smallBtn} text-warn`}
            >
              {msg.captions.cancel}
            </button>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-raised">
            <div
              className="h-full rounded bg-accent transition-[width]"
              style={{ width: `${job.total ? ((job.done + job.failed) / job.total) * 100 : 0}%` }}
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
            data-gpv="translate-start"
            onClick={start}
            disabled={!!notReady || !!blocked || pending === 0}
            className="w-full rounded bg-accent/20 px-3 py-1 font-semibold text-accent hover:bg-accent/30 disabled:bg-transparent disabled:font-normal disabled:text-fg-muted"
          >
            {counts.total === 0
              ? msg.captions.translate.nothingToTranslate
              : pending === 0
                ? msg.captions.translate.allTranslated
                : counts.done + counts.stale > 0
                  ? msg.captions.translate.continueTranslate(pending)
                  : msg.captions.translate.startTranslate(counts.total)}
          </button>
        </>
      )}
      {error && <div className="text-[11px] text-danger">{error}</div>}
      <div className="text-[11px] text-fg-dim">{msg.captions.translate.help}</div>
    </div>
  );
}
