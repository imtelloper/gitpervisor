import { ChevronsRight } from "lucide-react";

import { useMessages } from "../../i18n/ui-language";

/** 접힌 사이드 패널 자리에 남는 세로 스트립 — 클릭하면 다시 펼친다. */
export function CollapsedPanelStrip({
  title,
  badge,
  onExpand,
}: {
  title: string;
  /** 제목 아래 붙는 짧은 표시(예: 변경 개수) */
  badge?: string;
  onExpand: () => void;
}) {
  const msg = useMessages();
  return (
    <button
      onClick={onExpand}
      title={msg.shell.collapsedPanelStrip.expandTitle(title)}
      className="flex h-full w-7 shrink-0 flex-col items-center gap-2 border-r border-edge bg-panel py-2 hover:bg-raised"
    >
      <ChevronsRight size={14} className="shrink-0 text-fg-dim" />
      <span
        className="text-[11px] font-semibold text-fg-muted"
        style={{ writingMode: "vertical-rl" }}
      >
        {title}
      </span>
      {badge && (
        <span
          className="rounded bg-raised px-0.5 py-1 text-[10px] text-fg-dim"
          style={{ writingMode: "vertical-rl" }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
