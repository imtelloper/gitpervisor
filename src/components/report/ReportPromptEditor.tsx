import { RotateCcw, X } from "lucide-react";
import { useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { DEFAULT_REPORT_PROMPT, REPORT_PROMPT_VARS } from "../../lib/report";
import { useSetSettings, useSettings } from "../../queries";

/** 기본값과 같거나 비어 있으면 null — 앱이 기본 프롬프트를 고치면 손대지 않은 사용자가 따라오게. */
function normalizePrompt(text: string): string | null {
  return text.trim() === "" || text === DEFAULT_REPORT_PROMPT ? null : text;
}

/**
 * 리포트 요약 생성 프롬프트 편집(설정 `reportPrompt`) — 리포트 화면 안에 펼치는 패널.
 *
 * 설정 › AI가 아니라 여기 두는 이유: 별도 리포트 창(doc-*)에는 설정 다이얼로그가 없어 거기서는
 * 고칠 수 없다. 모달이 아니라 레이아웃 안에 끼는 패널이라 네이티브 webview 점유 계약도 필요 없다.
 */
export function ReportPromptEditor({ onClose }: { onClose: () => void }) {
  const msg = useMessages();
  const { data: settings } = useSettings();
  const save = useSetSettings();
  // 편집을 시작하기 전엔 저장값을 그대로 보여 준다 — 다른 창에서 저장해도(settings://changed) 따라간다.
  const [draft, setDraft] = useState<string | null>(null);

  if (!settings) return null;
  const saved = settings.reportPrompt?.trim() ? settings.reportPrompt : null;
  const text = draft ?? saved ?? DEFAULT_REPORT_PROMPT;
  const dirty = draft !== null && normalizePrompt(draft) !== saved;

  const submit = () =>
    save.mutate(
      { ...settings, reportPrompt: normalizePrompt(text) },
      { onSuccess: () => setDraft(null) },
    );

  return (
    <div data-gpv="report-prompt-editor" className="rounded border border-edge bg-panel p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg">{msg.report.promptEditor.title}</span>
        <span className="text-fg-dim">{saved ? msg.report.promptEditor.custom : msg.report.promptEditor.default}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            data-gpv="report-prompt-reset"
            onClick={() => setDraft(DEFAULT_REPORT_PROMPT)}
            disabled={text === DEFAULT_REPORT_PROMPT}
            title={msg.report.promptEditor.resetTitle}
            className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-fg-muted hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw size={11} /> {msg.report.promptEditor.reset}
          </button>
          <button
            data-gpv="report-prompt-save"
            onClick={submit}
            disabled={!dirty || save.isPending}
            className="rounded bg-accent px-2 py-0.5 text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {save.isPending ? msg.report.promptEditor.saving : msg.report.promptEditor.save}
          </button>
          <button
            onClick={onClose}
            title={msg.report.promptEditor.closeTitle}
            className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <textarea
        data-gpv="report-prompt-text"
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        rows={16}
        spellCheck={false}
        className="mt-2 w-full resize-y rounded border border-edge bg-base px-2 py-1.5 font-mono text-xs leading-5 outline-none focus:border-accent"
      />

      <div className="mt-2 space-y-1 text-[11px] text-fg-dim">
        <div>
          {msg.report.promptEditor.placeholdersLabel}{" "}
          {REPORT_PROMPT_VARS.map((v, i) => (
            <span key={v.token}>
              {i > 0 && " · "}
              <code className="text-fg-muted">{v.token}</code> {v.desc}
            </span>
          ))}
        </div>
        <div>{msg.report.promptEditor.footnote}</div>
      </div>
    </div>
  );
}
