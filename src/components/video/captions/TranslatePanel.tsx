// 번역 자막(태스크 72 §3.7, P4) — 대본 패널 헤더 [번역] 팝업. 대상 언어·진행 n/N·취소·이어서 번역.
//
// 번역 잡은 captionDoc 스토어가 든다(패널이 닫혀도 창이 살아 있으면 계속 돈다). 배치마다 문서에 저장되므로 창을
// 닫았다 열면 "이어서 번역"이 빠진 줄·원문이 바뀐 줄만 다시 한다. 모델은 61처럼 설정 › AI의 기본 모델이다.
import { Loader2 } from "lucide-react";
import { useMemo } from "react";

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
        <span className="text-[11px] text-fg-dim">대상 언어</span>
        <select
          data-gpv="translate-lang"
          aria-label="번역 대상 언어"
          value={job?.lang ?? lang}
          onChange={(e) => onLang(e.target.value)}
          disabled={!!job}
          className={fieldCls}
        >
          {CAPTION_TRANSLATE_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
        <span data-gpv="translate-count" className="font-mono text-[11px] tabular-nums text-fg-dim">
          {counts.done + counts.stale}/{counts.total}줄
        </span>
        {counts.stale > 0 && (
          <span
            className="rounded bg-warn/15 px-1 text-[10px] text-warn"
            title="번역한 뒤 원문(자막 줄·인식 단어)을 고친 줄 — 이어서 번역하면 다시 번역합니다"
          >
            원문 바뀜 {counts.stale}
          </span>
        )}
      </div>

      {job ? (
        <div data-gpv="translate-progress" className="space-y-1">
          <div className="flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-accent" />
            <span className="text-fg">{captionLangLabel(job.lang)}로 번역 중…</span>
            <span className="font-mono tabular-nums">
              {job.done + job.failed}/{job.total}
            </span>
            <div className="flex-1" />
            <button
              data-gpv="translate-cancel"
              onClick={() => useCaptionDoc.getState().cancelTranslate(capKey)}
              className={`${smallBtn} text-warn`}
            >
              취소
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
                  설정 › AI 열기
                </button>
              ) : (
                <span className="text-[11px] text-fg-dim">메인 창의 설정에서 받을 수 있습니다.</span>
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
              ? "번역할 자막이 없습니다"
              : pending === 0
                ? "모두 번역됨"
                : counts.done + counts.stale > 0
                  ? `이어서 번역 (남은 ${pending}줄)`
                  : `번역 시작 (${counts.total}줄)`}
          </button>
        </>
      )}
      {error && <div className="text-[11px] text-danger">{error}</div>}
      <div className="text-[11px] text-fg-dim">
        로컬 AI(설정 › AI의 기본 모델)로 자막 줄마다 번역합니다. 시각은 보내지 않아 그대로이고, 번역한 줄은 곧바로
        저장돼 창을 닫았다 열어도 이어서 합니다. 번역 줄은 눌러서 고칠 수 있습니다.
      </div>
    </div>
  );
}
