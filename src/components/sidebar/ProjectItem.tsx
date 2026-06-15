import { ArrowDown, ArrowUp, GitBranch, X } from "lucide-react";

import type { Project } from "../../lib/ipc";
import { errorMessage } from "../../lib/ipc";
import { useStatus } from "../../queries";
import { dotStateOf, StatusDot } from "../common/StatusDot";

export function ProjectItem({
  project,
  selected,
  onSelect,
  onRemove,
  onContextMenu,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { data: status, isLoading, error } = useStatus(project.id);
  const dot = dotStateOf(status, isLoading);

  const branchLabel =
    status?.branch ??
    (status?.detachedSha ? `@ ${status.detachedSha}` : undefined);

  const counts = status
    ? {
        unstaged: status.unstaged.length,
        staged: status.staged.length,
        untracked: status.untracked.length,
        conflicted: status.conflicted.length,
      }
    : null;
  const hasChanges =
    !!counts &&
    counts.unstaged + counts.staged + counts.untracked + counts.conflicted > 0;

  return (
    <div
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`group relative cursor-pointer border-l-2 px-3 py-2 ${
        selected
          ? "border-accent bg-selection"
          : "border-transparent hover:bg-raised"
      }`}
    >
      <div className="flex items-center gap-2">
        <StatusDot state={dot} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {project.name}
        </span>
        <button
          title="프로젝트 제거 (레포는 삭제되지 않음)"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-edge hover:text-fg group-hover:opacity-100"
        >
          <X size={13} />
        </button>
      </div>

      <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-fg-muted">
        {branchLabel && (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranch size={11} className="shrink-0" />
            <span className="truncate font-mono">{branchLabel}</span>
          </span>
        )}
        {!!status?.ahead && (
          <span className="flex shrink-0 items-center text-add">
            <ArrowUp size={11} />
            {status.ahead}
          </span>
        )}
        {!!status?.behind && (
          <span className="flex shrink-0 items-center text-mod">
            <ArrowDown size={11} />
            {status.behind}
          </span>
        )}
      </div>

      <div className="mt-0.5 flex items-center gap-2 pl-4 text-xs">
        {status?.error ? (
          <span className="truncate text-fg-dim" title={status.error}>
            {status.error}
          </span>
        ) : hasChanges && counts ? (
          <>
            {counts.conflicted > 0 && (
              <span className="text-danger">!{counts.conflicted}</span>
            )}
            {counts.unstaged > 0 && (
              <span className="text-mod">●{counts.unstaged}</span>
            )}
            {counts.staged > 0 && (
              <span className="text-add">✚{counts.staged}</span>
            )}
            {counts.untracked > 0 && (
              <span className="text-untrk">?{counts.untracked}</span>
            )}
          </>
        ) : status ? (
          <span className="text-fg-dim">변경 없음</span>
        ) : error ? (
          <span className="truncate text-danger" title={errorMessage(error)}>
            {errorMessage(error)}
          </span>
        ) : (
          <span className="text-fg-dim">불러오는 중…</span>
        )}
      </div>
    </div>
  );
}
