import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from "lucide-react";

import type { Project, RepoOpState } from "../../lib/ipc";
import { useRefreshAll, useStatus } from "../../queries";

const OP_LABEL: Partial<Record<RepoOpState, string>> = {
  merging: "MERGE 진행 중",
  rebasing: "REBASE 진행 중",
  "cherry-picking": "CHERRY-PICK 진행 중",
  bisecting: "BISECT 진행 중",
};

export function Toolbar({ project }: { project: Project }) {
  const { data: status, isFetching } = useStatus(project.id);
  const refreshAll = useRefreshAll();

  const branchLabel =
    status?.branch ??
    (status?.detachedSha ? `@ ${status.detachedSha}` : undefined);
  const opLabel = status ? OP_LABEL[status.opState] : undefined;

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel px-4">
      <span className="font-semibold">{project.name}</span>

      {branchLabel && (
        <span className="flex items-center gap-1.5 rounded bg-raised px-2 py-0.5 text-xs text-fg-muted">
          <GitBranch size={11} />
          <span className="font-mono">{branchLabel}</span>
          {!!status?.ahead && (
            <span className="flex items-center text-add">
              <ArrowUp size={11} />
              {status.ahead}
            </span>
          )}
          {!!status?.behind && (
            <span className="flex items-center text-mod">
              <ArrowDown size={11} />
              {status.behind}
            </span>
          )}
        </span>
      )}

      {opLabel && (
        <span className="rounded bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
          {opLabel} — 터미널/IDE에서 해결 후 새로고침하세요
        </span>
      )}

      <div className="flex-1" />

      <button
        title="모든 프로젝트 상태 새로고침"
        onClick={refreshAll}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
      </button>
    </header>
  );
}
