import { useEffect, useRef, useState } from "react";
import { ExternalLink, X, XSquare } from "lucide-react";

import { openDocWindow } from "../../lib/floating";
import type { DiffTarget } from "../../lib/ipc";
import { useOccludesWebview } from "../../stores/occlusion";
import type { ViewerFileTab } from "../../stores/ui";
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
  const activeKey =
    selectedDiff && tabs.length > 0
      ? viewerTabKey(selectedDiff, selectedDiffRepoId, projectId)
      : null;

  // 탭이 많아 가로로 넘칠 때, 활성 탭이 밖에 있으면 보이는 데까지만 스크롤한다.
  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  // 우클릭 메뉴 — 네이티브 자식 webview(내장 브라우저)가 항상 DOM 위에 그려지므로,
  // 열려 있는 동안 점유를 등록해 webview를 숨긴다(FileTreePanel 메뉴와 같은 계약).
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ViewerFileTab } | null>(null);
  useOccludesWebview(!!menu);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  if (tabs.length === 0) return null;

  const menuItemCls =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg";

  return (
    <>
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
              ref={on ? activeRef : undefined}
              onClick={() => selectDiff(t.target, t.repoId)}
              onAuxClick={(e) => {
                if (e.button === 1) closeViewerTab(t.key); // 휠클릭 닫기
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, tab: t });
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

      {menu && (
        // 백드롭이 바깥 클릭·우클릭을 삼켜 메뉴를 닫는다(브라우저 기본 메뉴도 막는다).
        <div
          className="fixed inset-0 z-50"
          onClick={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="fixed min-w-44 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 110),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className={menuItemCls}
              onClick={() => {
                closeViewerTab(menu.tab.key);
                setMenu(null);
              }}
            >
              <X size={14} className="shrink-0" />
              닫기
            </button>
            <button
              className={menuItemCls}
              onClick={() => {
                // 같은 프로젝트의 나머지만 — 다른 프로젝트 탭은 이 바에 보이지도 않는다.
                for (const o of tabs) if (o.key !== menu.tab.key) closeViewerTab(o.key);
                setMenu(null);
              }}
            >
              <XSquare size={14} className="shrink-0" />
              다른 탭 닫기
            </button>
            <button
              className={menuItemCls}
              onClick={() => {
                // doc 창은 파일 보기 전용이다 — diff 모드 탭도 그 파일로 연다.
                openDocWindow(projectId, menu.tab.target.path);
                setMenu(null);
              }}
            >
              <ExternalLink size={14} className="shrink-0" />
              새 창으로 열기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
