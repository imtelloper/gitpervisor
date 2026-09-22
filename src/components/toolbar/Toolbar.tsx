import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Database,
  FolderTree,
  GitBranch,
  HardDrive,
  Loader2,
  RefreshCcw,
  RefreshCw,
  Settings as SettingsIcon,
  SquareTerminal,
  StickyNote,
  Trash2,
} from "lucide-react";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { formatBytes } from "../../lib/format";
import type { Project, RepoOpState } from "../../lib/ipc";
import {
  useCleanTarget,
  useNotes,
  usePushFlow,
  useRefreshAll,
  useStatus,
  useSyncOp,
  useTargetSize,
} from "../../queries";
import { useOps } from "../../stores/ops";
import { useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { ProjectLogo } from "../common/ProjectLogo";

function opLabelFor(msg: Messages, op: RepoOpState): string | undefined {
  switch (op) {
    case "normal":
      return undefined;
    case "merging":
      return msg.shell.toolbar.opMerging;
    case "rebasing":
      return msg.shell.toolbar.opRebasing;
    case "cherry-picking":
      return msg.shell.toolbar.opCherryPicking;
    case "bisecting":
      return msg.shell.toolbar.opBisecting;
    default: {
      const unreachable: never = op;
      return unreachable;
    }
  }
}

export function Toolbar({ project }: { project: Project }) {
  const msg = useMessages();
  const { data: status, isFetching } = useStatus(project.id);
  const refreshAll = useRefreshAll();
  const fetchOp = useSyncOp(project.id, "fetch");
  const pullOp = useSyncOp(project.id, "pull");
  const startPush = usePushFlow(project.id);
  const running = useOps((s) => s.running[project.id]);
  const fileTreeOpen = useUi((s) => s.fileTreeOpen);
  const setMemoOpen = useUi((s) => s.setMemoOpen);
  const { data: notes } = useNotes();
  const memoCount = notes?.[project.id]?.filter((m) => m.text.trim()).length ?? 0;
  const targetSize = useTargetSize(project.id);
  const cleanTarget = useCleanTarget();

  function handleCleanTarget() {
    if (cleanTarget.isPending) return;
    const paths = targetSize?.paths ?? [];
    useUi.getState().askConfirm({
      title: msg.shell.toolbar.cleanTargetTitle,
      message: msg.shell.toolbar.cleanTargetMessage(
        project.name,
        formatBytes(targetSize?.bytes ?? 0),
        paths.length,
      ),
      detail: paths.join("\n"),
      confirmLabel: msg.shell.toolbar.cleanTargetConfirm,
      danger: true,
      onConfirm: () => cleanTarget.mutate(project.id),
    });
  }

  const branchLabel =
    status?.branch ??
    (status?.detachedSha ? `@ ${status.detachedSha}` : undefined);
  const opLabel = status ? opLabelFor(msg, status.opState) : undefined;
  const detached = !!status && !status.branch;
  const busy = !!running;

  const syncBtn =
    "flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-xs text-fg-muted hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel px-4">
      <button
        title={msg.shell.toolbar.toggleFileTree}
        onClick={() => useUi.getState().toggleFileTree()}
        className={`-ml-1 rounded p-1.5 hover:bg-raised ${
          fileTreeOpen ? "text-accent" : "text-fg-muted hover:text-fg"
        }`}
      >
        <FolderTree size={16} />
      </button>
      <ProjectLogo projectId={project.id} />
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
        title={msg.shell.toolbar.fetchTitle}
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
        title={detached ? msg.shell.toolbar.pullDetachedTitle : msg.shell.toolbar.pullTitle}
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
        title={detached ? msg.shell.toolbar.pushDetachedTitle : msg.shell.toolbar.pushTitle}
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

      {targetSize?.isRust && (
        <span
          title={
            targetSize.targetCount > 1
              ? msg.shell.toolbar.targetSizeMultiTitle(targetSize.targetCount)
              : msg.shell.toolbar.targetSizeSingleTitle
          }
          className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 text-xs text-fg-muted"
        >
          <HardDrive size={12} className="shrink-0" />
          <span className="font-mono">{formatBytes(targetSize.bytes)}</span>
          {targetSize.bytes > 0 &&
            (cleanTarget.isPending ? (
              <Loader2
                size={12}
                className="animate-spin text-accent"
                aria-label={msg.shell.toolbar.cleaningLabel}
              />
            ) : (
              <button
                title={msg.shell.toolbar.cleanTargetButtonTitle}
                onClick={handleCleanTarget}
                className="-mr-0.5 rounded p-0.5 text-fg-dim hover:bg-edge hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            ))}
        </span>
      )}

      <button
        title={msg.shell.toolbar.projectNotes}
        onClick={() => setMemoOpen(true)}
        className={`relative rounded p-1.5 hover:bg-raised ${
          memoCount > 0 ? "text-accent" : "text-fg-muted hover:text-fg"
        }`}
      >
        <StickyNote size={15} />
        {memoCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold text-on-accent">
            {memoCount}
          </span>
        )}
      </button>

      <button
        title={msg.shell.toolbar.openTerminalTitle}
        onClick={() => useTerminals.getState().openTerminal(project.id)}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <SquareTerminal size={15} />
      </button>

      <button
        title={msg.shell.toolbar.dbExplorerTitle}
        onClick={() => useTerminals.getState().openDbTab(project.id)}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <Database size={15} />
      </button>

      <button
        title={msg.shell.toolbar.refreshAllTitle}
        onClick={refreshAll}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <RefreshCw size={15} className={isFetching ? "animate-spin" : ""} />
      </button>

      <button
        title={msg.shell.toolbar.settingsTitle}
        onClick={() => useUi.getState().setSettingsOpen(true)}
        className="rounded p-1.5 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <SettingsIcon size={15} />
      </button>
    </header>
  );
}
