import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  GitBranch,
  Loader2,
  StickyNote,
  X,
} from "lucide-react";

import { memo } from "react";

import type { Project } from "../../lib/ipc";
import { errorMessage } from "../../lib/ipc";
import { useNotes, useStatus } from "../../queries";
import { useAgentActivity } from "../../stores/agentActivity";
import { dotStateOf, StatusDot } from "../common/StatusDot";

// memo — 부모(ProjectList)의 로컬 상태 변화(컨텍스트 메뉴 열림/닫힘, 사이드바 폭 드래그 등)가
// 모든 항목으로 재렌더 캐스케이드되지 않게 한다. 콜백은 id를 인자로 받는 안정 참조라야 효과가 있다.
// (status/notes/agent 구독에 의한 재렌더는 각 항목이 직접 구독하므로 memo와 무관하게 일어난다.)
export const ProjectItem = memo(function ProjectItem({
  project,
  selected,
  onSelect,
  onRemove,
  onContextMenu,
  isOver,
  isDragging,
  onPointerDownDrag,
}: {
  project: Project;
  selected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent, project: Project) => void;
  /** 드래그 정렬 — 이 항목 위에 삽입선 표시 */
  isOver?: boolean;
  /** 이 항목을 지금 끌고 있는 중(흐리게) */
  isDragging?: boolean;
  /** 포인터 드래그 시작(좌클릭 후 임계 이동 시 정렬 드래그로 전환) */
  onPointerDownDrag?: (e: React.PointerEvent, id: string) => void;
}) {
  const { data: status, isLoading, error } = useStatus(project.id);
  const { data: notes } = useNotes();
  const hasNote = !!notes?.[project.id]?.some((m) => m.text.trim());
  const dot = dotStateOf(status, isLoading);
  const agent = useAgentActivity((s) => s.byProject[project.id]);

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
      data-project-id={project.id}
      onClick={() => onSelect(project.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, project) : undefined}
      onPointerDown={
        onPointerDownDrag ? (e) => onPointerDownDrag(e, project.id) : undefined
      }
      className={`group relative cursor-pointer select-none border-l-2 px-3 py-2 ${
        selected
          ? "border-accent bg-selection"
          : "border-transparent hover:bg-raised"
      } ${isDragging ? "opacity-40" : ""} ${
        agent === "working" ? "ai-working" : agent === "done" ? "ai-done" : ""
      }`}
    >
      {isOver && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-accent" />
      )}
      <div className="flex items-center gap-2 overflow-hidden">
        <StatusDot state={dot} />
        <span className="whitespace-nowrap font-medium">{project.name}</span>
        {agent === "working" && (
          <span title="Claude Code 작업 중…" className="flex shrink-0">
            <Loader2
              size={12}
              className="animate-spin text-accent"
              aria-label="Claude Code 작업 중"
            />
          </span>
        )}
        {agent === "done" && (
          <span
            title="Claude Code 작업 완료 — 확인하세요"
            className="flex shrink-0"
          >
            <CircleCheck
              size={12}
              className="text-add"
              aria-label="Claude Code 작업 완료"
            />
          </span>
        )}
        {hasNote && (
          <StickyNote
            size={11}
            className="shrink-0 text-fg-dim"
            aria-label="메모 있음"
          />
        )}
      </div>
      <button
        title="프로젝트 제거 (레포는 삭제되지 않음)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(project.id);
        }}
        className="absolute right-1 top-1.5 rounded bg-raised p-0.5 text-fg-dim opacity-0 hover:bg-edge hover:text-fg group-hover:opacity-100"
      >
        <X size={13} />
      </button>

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
});
