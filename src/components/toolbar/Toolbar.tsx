import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  FolderTree,
  GitBranch,
  RefreshCcw,
  RefreshCw,
  Settings as SettingsIcon,
  SquareTerminal,
  StickyNote,
} from "lucide-react";
import { useRef } from "react";

import type { Project, RepoOpState } from "../../lib/ipc";
import {
  useNotes,
  usePushFlow,
  useRefreshAll,
  useStatus,
  useSyncOp,
} from "../../queries";
import { useOps } from "../../stores/ops";
import { useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { MemoPopover } from "../memo/MemoPopover";

const OP_LABEL: Partial<Record<RepoOpState, string>> = {
  merging: "MERGE 진행 중",
  rebasing: "REBASE 진행 중",
  "cherry-picking": "CHERRY-PICK 진행 중",
  bisecting: "BISECT 진행 중",
};

export function Toolbar({ project }: { project: Project }) {
  const { data: status, isFetching } = useStatus(project.id);
  const refreshAll = useRefreshAll();
  const fetchOp = useSyncOp(project.id, "fetch");
  const pullOp = useSyncOp(project.id, "pull");
  const startPush = usePushFlow(project.id);
  const running = useOps((s) => s.running[project.id]);
  const fileTreeOpen = useUi((s) => s.fileTreeOpen);
  const memoOpen = useUi((s) => s.memoOpen);
  const setMemoOpen = useUi((s) => s.setMemoOpen);
  const { data: notes } = useNotes();
  const hasNote = !!notes?.[project.id]?.text;
  const memoAnchor = useRef<HTMLDivElement>(null);

  const branchLabel =
    status?.branch ??
    (status?.detachedSha ? `@ ${status.detachedSha}` : undefined);
  const opLabel = status ? OP_LABEL[status.opState] : undefined;
  const detached = !!status && !status.branch;
  const busy = !!running;

  const syncBtn =
    "flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel px-4">
      <button
        title="파일 트리 토글"
        onClick={() => useUi.getState().toggleFileTree()}
        className={`-ml-1 rounded p-1.5 hover:bg-raised ${
          fileTreeOpen ? "text-accent" : "text-fg-muted hover:text-fg"
        }`}
      >
        <FolderTree size={16} />
      </button>
      <span className="font-semibold">{project.name}</span>

      {branchLabel && (
        <span className="flex items-center gap-1.5 rounded bg-raised px-2 py-0.5 text-xs text-fg-muted">
          <GitBranch size={11} />
          <span className="font-mono">{branchLabel}</span>
        </span>
      )}

      {opLabel && (
        <span className="rounded bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
          {opLabel}
        </span>
      )}

      <div className="min-w-0 flex-1">
        {running?.lastLine && (
          <div className="truncate text-right font-mono text-[11px] text-fg-dim">
            {running.lastLine}
          </div>
        )}
      </div>

      <button
        onClick={() => fetchOp.mutate(undefined)}
        disabled={busy}
        title="원격에서 페치"
        className={syncBtn}
      >
        <RefreshCcw
          size={12}
          className={running?.op === "fetch" ? "animate-spin" : ""}
        />
        Fetch
      </button>

      <button
        onClick={() => pullOp.mutate(undefined)}
        disabled={busy || detached}
        title={detached ? "detached HEAD에서는 풀 불가" : "풀"}
        className={syncBtn}
      >
        <ArrowDownToLine
          size={12}
          className={running?.op === "pull" ? "animate-spin" : ""}
        />
        Pull
        {!!status?.behind && (
          <span className="flex items-center text-mod">
            <ArrowDown size={11} />
            {status.behind}
          </span>
        )}
      </button>

      <button
        onClick={startPush}
        disabled={busy || detached}
        title={detached ? "detached HEAD에서는 푸시 불가" : "푸시"}
        className={syncBtn}
      >
        <ArrowUpToLine
          size={12}
          className={running?.op === "push" ? "animate-spin" : ""}
        />
        Push
        {!!status?.ahead && (
          <span className="flex items-center text-add">
            <ArrowUp size={11} />
            {status.ahead}
          </span>
        )}
      </button>

      <div className="relative" ref={memoAnchor}>
        <button
          title="프로젝트 메모"
          onClick={() => setMemoOpen(!memoOpen)}
          className={`rounded p-1.5 hover:bg-raised ${
            memoOpen || hasNote
              ? "text-accent"
              : "text-fg-muted hover:text-fg"
          }`}
        >
          <StickyNote size={15} />
        </button>
        {memoOpen && (
          <MemoPopover
            project={project}
            anchorRef={memoAnchor}
            onClose={() => setMemoOpen(false)}
          />
        )}
      </div>

      <button
        title="이 프로젝트 경로에서 터미널 열기 (Ctrl+`)"
        onClick={() => useTerminals.getState().openTerminal(project.id)}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <SquareTerminal size={15} />
      </button>

      <button
        title="모든 프로젝트 상태 새로고침 (F5)"
        onClick={refreshAll}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
      </button>

      <button
        title="설정"
        onClick={() => useUi.getState().setSettingsOpen(true)}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <SettingsIcon size={15} />
      </button>
    </header>
  );
}
