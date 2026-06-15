import { ChevronDown, ChevronUp, History } from "lucide-react";

import { useUi } from "../../stores/ui";
import { BranchesPane } from "./BranchesPane";
import { CommitDetailPane } from "./CommitDetailPane";
import { CommitList } from "./CommitList";

/** 하단 접이식 Log 패널 — 펼치면 브랜치 / 커밋 리스트 / 커밋 상세 3분할 (설계 §5.1). */
export function LogPanel({ projectId }: { projectId: string }) {
  const logOpen = useUi((s) => s.logOpen);
  const toggleLog = useUi((s) => s.toggleLog);

  return (
    <div className="flex shrink-0 flex-col border-t border-edge bg-panel">
      <button
        onClick={toggleLog}
        className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-semibold text-fg-muted hover:text-fg"
      >
        {logOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        <History size={13} />
        <span>Log</span>
      </button>
      {logOpen && (
        <div className="flex h-72 min-h-0 border-t border-edge">
          <BranchesPane projectId={projectId} />
          <CommitList projectId={projectId} />
          <CommitDetailPane projectId={projectId} />
        </div>
      )}
    </div>
  );
}
