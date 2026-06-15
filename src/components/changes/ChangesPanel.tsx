import { ChevronDown, ChevronRight, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";

import type { ChangeKind, FileChange } from "../../lib/ipc";
import { splitPath } from "../../lib/format";
import {
  useDiscardFiles,
  usePrefetchDiffs,
  useStageFiles,
  useStatus,
  useUnstageFiles,
} from "../../queries";
import { useUi } from "../../stores/ui";
import { CommitForm } from "./CommitForm";

const KIND_BADGE: Record<ChangeKind, { letter: string; className: string }> = {
  modified: { letter: "M", className: "text-mod" },
  added: { letter: "A", className: "text-add" },
  deleted: { letter: "D", className: "text-del" },
  renamed: { letter: "R", className: "text-mod" },
  typechange: { letter: "T", className: "text-mod" },
  conflicted: { letter: "!", className: "text-danger" },
  untracked: { letter: "?", className: "text-untrk" },
};

interface RowActions {
  onToggleStage: (change: FileChange) => void;
  onDiscard: (change: FileChange) => void;
}

function ChangeRow({
  change,
  selected,
  onSelect,
  actions,
}: {
  change: FileChange;
  selected: boolean;
  onSelect: () => void;
  actions: RowActions;
}) {
  const { dir, base } = splitPath(change.path);
  const badge = KIND_BADGE[change.kind];
  const stageable = change.kind !== "conflicted";
  const discardable = !change.staged && change.kind !== "conflicted";

  return (
    <div
      onClick={onSelect}
      title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
      className={`group flex cursor-pointer items-center gap-2 px-3 py-1 ${
        selected ? "bg-selection" : "hover:bg-raised"
      }`}
    >
      {stageable ? (
        <input
          type="checkbox"
          checked={change.staged}
          onChange={() => actions.onToggleStage(change)}
          onClick={(e) => e.stopPropagation()}
          title={change.staged ? "언스테이지" : "스테이지"}
          className="shrink-0 accent-accent"
        />
      ) : (
        <span className="w-[13px] shrink-0" />
      )}
      <span
        className={`w-3 shrink-0 text-center font-mono text-xs ${badge.className}`}
      >
        {badge.letter}
      </span>
      <span className="truncate">{base}</span>
      {dir && (
        <span className="min-w-0 truncate text-xs text-fg-dim">{dir}</span>
      )}
      <span className="flex-1" />
      {discardable && (
        <button
          title={change.kind === "untracked" ? "파일 삭제" : "변경 되돌리기"}
          onClick={(e) => {
            e.stopPropagation();
            actions.onDiscard(change);
          }}
          className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-edge hover:text-danger group-hover:opacity-100"
        >
          <Undo2 size={13} />
        </button>
      )}
    </div>
  );
}

function Group({
  title,
  changes,
  accent,
  selectedFilePath,
  onSelectFile,
  actions,
}: {
  title: string;
  changes: FileChange[];
  accent?: boolean;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  actions: RowActions;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (changes.length === 0) return null;

  return (
    <div>
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-fg-muted hover:text-fg"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <span className={accent ? "text-danger" : ""}>{title}</span>
        <span className="text-fg-dim">{changes.length}</span>
      </button>
      {!collapsed &&
        changes.map((c) => (
          <ChangeRow
            key={`${c.staged ? "s" : "w"}:${c.path}`}
            change={c}
            selected={c.path === selectedFilePath}
            onSelect={() => onSelectFile(c.path)}
            actions={actions}
          />
        ))}
    </div>
  );
}

export function ChangesPanel({ projectId }: { projectId: string }) {
  const { data: status } = useStatus(projectId);
  const selectedFilePath = useUi((s) => s.selectedFilePath);
  const selectFile = useUi((s) => s.selectFile);
  const stage = useStageFiles(projectId);
  const unstage = useUnstageFiles(projectId);
  const discard = useDiscardFiles(projectId);
  usePrefetchDiffs(projectId); // 클릭 전에 diff를 미리 적재 (§12)

  const total = status
    ? status.conflicted.length +
      status.unstaged.length +
      status.staged.length +
      status.untracked.length
    : 0;

  // 새로고침으로 선택 파일이 변경 목록에서 사라지면 뷰어를 비운다 (설계 §9)
  useEffect(() => {
    if (!status || !selectedFilePath) return;
    const exists = [
      ...status.conflicted,
      ...status.unstaged,
      ...status.staged,
      ...status.untracked,
    ].some((c) => c.path === selectedFilePath);
    if (!exists) selectFile(null);
  }, [status, selectedFilePath, selectFile]);

  const actions: RowActions = {
    onToggleStage: (change) => {
      if (change.staged) unstage.mutate([change.path]);
      else stage.mutate([change.path]);
    },
    onDiscard: (change) => {
      const untracked = change.kind === "untracked";
      useUi.getState().askConfirm({
        title: untracked ? "파일 삭제" : "변경 되돌리기",
        message: untracked
          ? `'${change.path}' 은(는) 추적되지 않는 파일입니다. 삭제하면 복구할 수 없습니다.`
          : `'${change.path}' 의 저장되지 않은 변경을 되돌립니다. 복구할 수 없습니다.`,
        confirmLabel: untracked ? "삭제" : "되돌리기",
        danger: true,
        onConfirm: () =>
          discard.mutate(
            untracked
              ? { tracked: [], untracked: [change.path] }
              : { tracked: [change.path], untracked: [] },
          ),
      });
    },
  };

  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-r border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="font-semibold">Changes</span>
        <span className="text-xs text-fg-dim">
          {status ? `${total} files` : "…"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {status?.error ? (
          <div className="px-3 py-3 text-xs leading-5 text-fg-dim">
            {status.error}
          </div>
        ) : status && total === 0 ? (
          <div className="px-3 py-3 text-xs text-fg-dim">
            변경 없음 — 워킹 트리가 깨끗합니다 ✨
          </div>
        ) : status ? (
          <>
            <Group
              title="Conflicts"
              changes={status.conflicted}
              accent
              selectedFilePath={selectedFilePath}
              onSelectFile={selectFile}
              actions={actions}
            />
            <Group
              title="Unstaged"
              changes={status.unstaged}
              selectedFilePath={selectedFilePath}
              onSelectFile={selectFile}
              actions={actions}
            />
            <Group
              title="Staged"
              changes={status.staged}
              selectedFilePath={selectedFilePath}
              onSelectFile={selectFile}
              actions={actions}
            />
            <Group
              title="Untracked"
              changes={status.untracked}
              selectedFilePath={selectedFilePath}
              onSelectFile={selectFile}
              actions={actions}
            />
          </>
        ) : null}
      </div>

      <CommitForm projectId={projectId} />
    </div>
  );
}
