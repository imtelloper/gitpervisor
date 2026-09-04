import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CloudOff,
  FolderGit2,
  GitBranch,
  HardDrive,
  Loader2,
  StickyNote,
  X,
} from "lucide-react";

import { memo } from "react";

import { formatBytes, relativeTime } from "../../lib/format";
import type { Project } from "../../lib/ipc";
import { errorMessage } from "../../lib/ipc";
import type { ProjColor } from "../../lib/project-color";
import { useNotes, useProjectSize, useStatus } from "../../queries";
import { useAgentActivity } from "../../stores/agentActivity";
import { dotStateOf, StatusDot } from "../common/StatusDot";
import { useProjectLogo } from "../../queries";

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
  color,
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
  /** 프로젝트 색 — 이름순 전체 배정(useProjectColors). 모아보기 칩·셀 헤더와 같은 값. */
  color: ProjColor;
}) {
  const { data: status, isLoading, error } = useStatus(project.id);
  const { data: notes } = useNotes();
  const hasNote = !!notes?.[project.id]?.some((m) => m.text.trim());
  const dot = dotStateOf(status, isLoading);
  // 로고는 있으면 좋은 것이지 상태 정보가 아니다 — StatusDot을 대체하지 않고 이름 앞에 덧붙인다.
  // (점은 clean/dirty/conflict/error를 나르고, 로고는 그걸 표현할 수 없다.)
  const logo = useProjectLogo(project.id);
  const agent = useAgentActivity((s) => s.byProject[project.id]);
  const size = useProjectSize(project.id);

  const branchLabel =
    status?.branch ??
    (status?.detachedSha ? `@ ${status.detachedSha}` : undefined);

  // 배경 fetch 마지막 성공 시각의 상대 표기 — behind 배지 툴팁 "마지막 확인 M분 전"용.
  const lastFetchMs = status?.lastFetchAt
    ? new Date(status.lastFetchAt).getTime()
    : NaN;
  const lastFetchLabel = Number.isNaN(lastFetchMs)
    ? null
    : relativeTime(lastFetchMs);

  const counts = status
    ? {
        unstaged: status.unstaged.length,
        staged: status.staged.length,
        untracked: status.untracked.length,
        conflicted: status.conflicted.length,
      }
    : null;
  // 이 프로젝트 안 임베디드(중첩) 저장소들의 변경 총합 — 별도 뱃지로 표시.
  const nestedChanges = status?.nestedChanges ?? 0;
  const hasChanges =
    !!counts &&
    counts.unstaged +
      counts.staged +
      counts.untracked +
      counts.conflicted +
      nestedChanges >
      0;

  return (
    <div
      data-project-id={project.id}
      onClick={() => onSelect(project.id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, project) : undefined}
      onPointerDown={
        onPointerDownDrag ? (e) => onPointerDownDrag(e, project.id) : undefined
      }
      // 배경은 프로젝트 색이다 — 색만 보고도 어느 프로젝트인지 기억할 수 있게(모아보기 칩과 같은 색).
      // 인라인 backgroundColor 대신 변수로 넘기는 이유: 인라인은 hover: 클래스를 이겨 강조가 죽는다.
      // hover는 이제 배경이 아니라 안쪽 링이 맡는다 — 색이 불투명해져 hover용 두 번째 색을 두면
      // 그 색도 32슬롯 전부 대비 예산을 다시 받아야 한다. fg-dim은 틴트 위 최악 2.12로 3:1
      // 미달이라 링 색은 fg-muted(최악 3.86)를 쓴다.
      style={{ "--tint": color.bg } as React.CSSProperties}
      className={`group relative cursor-pointer select-none px-3 py-2 bg-(--tint) hover:ring-1 hover:ring-inset hover:ring-fg-muted ${
        selected ? "outline outline-2 -outline-offset-2 outline-accent" : ""
      } ${isDragging ? "opacity-40" : ""} ${
        agent === "working" ? "ai-working" : agent === "done" ? "ai-done" : ""
      }`}
    >
      {/* 좌측 스트라이프 — 라이트 2종은 흰 패널 위 명도 예산이 없어 행 배경만으로는 최소 ΔE00이
          1.7~2.2에 그친다(다크는 6.0+). 글자가 얹히지 않는 이 4px 띠는 비텍스트 3:1만 받으면 돼
          채도를 게멋 끝까지 써서 8.03/7.02까지 벌린다. 선택 시 4→8px — accent outline만으로는
          부족하다(스트라이프와 accent의 최소 ΔE00이 darcula 4.86 / solarized-light 4.65). */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 ${selected ? "w-2" : "w-1"}`}
        style={{ background: color.stripe }}
      />
      {isOver && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-accent" />
      )}
      <div className="flex items-center gap-2 overflow-hidden">
        <StatusDot state={dot} />
        {logo.data && (
          <img
            src={logo.data.dataUri}
            alt=""
            title={`로고: ${logo.data.source}`}
            // alt=""·aria-hidden: 프로젝트 이름이 바로 옆에 있어 스크린리더에 두 번 읽힐 이유가 없다.
            aria-hidden
            className="h-4 w-4 shrink-0 rounded-sm object-contain"
          />
        )}
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
          <span
            className="flex shrink-0 items-center text-mod"
            title={`원격에 새 커밋 ${status.behind}개${
              lastFetchLabel ? ` — 마지막 확인 ${lastFetchLabel}` : ""
            }`}
          >
            <ArrowDown size={11} />
            {status.behind}
          </span>
        )}
        {status?.fetchError && (
          // 배경 fetch 실패 — 토스트/모달 없이 조용한 흐린 아이콘 + 툴팁만(태스크 04 §3.6).
          <span title={status.fetchError} className="flex shrink-0">
            <CloudOff
              size={11}
              className="text-fg-dim"
              aria-label="원격 확인 실패"
            />
          </span>
        )}
        {size && !size.error && size.bytes > 0 && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 text-fg-dim"
            title="폴더 용량 (우클릭 → 용량 새로고침)"
          >
            <HardDrive size={11} />
            {formatBytes(size.bytes)}
          </span>
        )}
      </div>

      <div className="mt-0.5 flex items-center gap-2 pl-4 text-xs">
        {status?.error ? (
          // 오류 문구만 fg-muted다 — fg-dim은 틴트 위 최악 2.12(darcula)라 "프로젝트 경로를
          // 찾을 수 없습니다" 같은 실제로 읽어야 하는 문장에는 모자란다. 용량·"변경 없음"은
          // 의도적 저강조라 fg-dim 그대로 둔다.
          <span className="truncate text-fg-muted" title={status.error}>
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
            {nestedChanges > 0 && (
              <span
                className="flex items-center gap-0.5 text-fg-muted"
                title="중첩 저장소 변경"
              >
                <FolderGit2 size={11} />
                {nestedChanges}
              </span>
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
