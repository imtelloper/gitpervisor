import { X } from "lucide-react";

import type { DiffTarget } from "../../lib/ipc";
import { useUi, viewerTabKey } from "../../stores/ui";

/** 탭 표기 — 파일명 + 모드 힌트(diff/staged/커밋은 배지로 구분, 파일 보기는 이름만). */
function tabLabel(target: DiffTarget): { name: string; hint: string | null } {
  const name = target.path.split("/").pop() ?? target.path;
  switch (target.mode) {
    case "worktree":
      return { name, hint: "±" };
    case "index":
      return { name, hint: "±S" };
    case "commit":
      return { name, hint: target.sha.slice(0, 7) };
    case "file":
      return { name, hint: null };
  }
}

/**
 * 뷰어 파일 탭 바(PyCharm식) — selectDiff로 연 대상들이 탭으로 쌓이고,
 * go-to-definition(Ctrl+클릭)으로 점프해도 이전 파일이 탭으로 남는다.
 * 클릭=전환, X·휠클릭=닫기. 탭이 없으면 렌더하지 않는다.
 */
export function ViewerFileTabs({ projectId }: { projectId: string }) {
  const viewerTabs = useUi((s) => s.viewerTabs);
  const selectedDiff = useUi((s) => s.selectedDiff);
  const selectedDiffRepoId = useUi((s) => s.selectedDiffRepoId);
  const selectDiff = useUi((s) => s.selectDiff);
  const closeViewerTab = useUi((s) => s.closeViewerTab);

  const tabs = viewerTabs.filter((t) => t.outerId === projectId);
  if (tabs.length === 0) return null;
  const activeKey = selectedDiff
    ? viewerTabKey(selectedDiff, selectedDiffRepoId, projectId)
    : null;

  return (
    <div
      // 탭 바는 가로로만 넘친다 — 세로 휠을 가로 스크롤로 바꿔 마우스만으로 탐색(VS Code 관례)
      onWheel={(e) => {
        if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
      }}
      className="flex h-8 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-edge bg-panel px-1"
    >
      {tabs.map((t) => {
        const { name, hint } = tabLabel(t.target);
        const on = t.key === activeKey;
        return (
          <div
            key={t.key}
            onClick={() => selectDiff(t.target, t.repoId)}
            onAuxClick={(e) => {
              if (e.button === 1) closeViewerTab(t.key); // 휠클릭 닫기
            }}
            title={`${t.target.path}${hint ? ` (${hint})` : ""}`}
            className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2 text-xs ${
              on
                ? "border-accent bg-raised text-fg"
                : "border-transparent text-fg-muted hover:bg-raised/60 hover:text-fg"
            }`}
          >
            <span className="max-w-[160px] truncate whitespace-nowrap">{name}</span>
            {hint && (
              <span className="shrink-0 rounded bg-edge/60 px-1 font-mono text-[10px] text-fg-dim">
                {hint}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeViewerTab(t.key);
              }}
              title="탭 닫기"
              className="ml-0.5 shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-edge hover:text-fg group-hover:opacity-100"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
