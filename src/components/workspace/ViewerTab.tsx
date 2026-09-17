import { MousePointerClick } from "lucide-react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";

import type { SelectionRef } from "../diff/DiffViewer";
import type { DiffTarget } from "../../lib/ipc";
import { collectPanes, type Pane, type PaneSplit } from "../../lib/pane-tree";
import { useOccludesWebview } from "../../stores/occlusion";
import { useTerminals } from "../../stores/terminals";
import { useUi, type ViewerLeaf } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { SplitView } from "./SplitView";
import { ViewerFileTabs } from "./ViewerFileTabs";
import { ViewerPaneMenu } from "./ViewerPaneMenu";

// Monaco 번들은 무겁다 — 파일을 처음 열 때만 로드한다
const DiffViewer = lazy(() => import("../diff/DiffViewer"));

/**
 * Viewer 탭 — 분할 가능한 패널 트리. 열린 파일 탭 바는 패널마다 그 패널 위에 붙는다.
 * 패널 배치·비율은 터미널 탭과 같은 트리를 쓴다(`lib/pane-tree.ts` · `SplitView`).
 */
export function ViewerTab({ projectId }: { projectId: string }) {
  const layout = useUi((s) => s.viewerLayout);
  const activePaneId = useUi((s) => s.viewerActivePaneId);
  const maximized = useUi((s) => s.viewerMaximizedPaneId);
  const panes = collectPanes(layout);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="min-h-0 flex-1">
        {/* 최대화된 패널이 있으면 그것만 — 터미널의 PaneTreeRoot와 같은 규칙. */}
        {maximized && panes.includes(maximized) ? (
          <ViewerLeafView paneId={maximized} projectId={projectId} active={false} />
        ) : (
          <ViewerPaneView
            node={layout}
            projectId={projectId}
            activePaneId={activePaneId}
            multi={panes.length > 1}
          />
        )}
      </div>
    </div>
  );
}

interface ViewProps {
  node: Pane<ViewerLeaf>;
  projectId: string;
  activePaneId: string;
  multi: boolean;
}

// 순수 분기 — 훅 없음 (리프↔분할 전환 시 훅 개수 변동 방지)
function ViewerPaneView({ node, projectId, activePaneId, multi }: ViewProps) {
  if (node.kind === "leaf")
    return (
      <ViewerLeafView
        paneId={node.paneId}
        projectId={projectId}
        active={multi && activePaneId === node.paneId}
      />
    );
  return (
    <ViewerSplitView
      node={node}
      projectId={projectId}
      activePaneId={activePaneId}
      multi={multi}
    />
  );
}

/** 분할 노드 — 공용 SplitView에 뷰어 스토어의 비율/드래그 액션을 물린다. */
function ViewerSplitView({
  node,
  ...rest
}: ViewProps & { node: PaneSplit<ViewerLeaf> }) {
  const setRatio = useUi((s) => s.setViewerRatio);
  // 브라우저 웹뷰 숨김은 터미널 스토어가 쥔다 — 분할 이웃이 네이티브 브라우저 pane이면
  // 드래그 중 잔상이 남으므로 뷰어 divider도 같은 플래그를 세운다.
  const setDraggingSplit = useTerminals((s) => s.setDraggingSplit);
  return (
    <SplitView<ViewerLeaf>
      node={node}
      setRatio={setRatio}
      setDraggingSplit={setDraggingSplit}
      render={(child) => <ViewerPaneView node={child} {...rest} />}
    />
  );
}

/** 패널 한 칸 — 그 패널의 파일 탭 바 + 보는 파일의 diff/내용(없으면 빈 상태). 우클릭 → 분할 메뉴. */
function ViewerLeafView({
  paneId,
  projectId,
  active,
}: {
  paneId: string;
  projectId: string;
  active: boolean;
}) {
  const entry = useUi((s) => s.viewerByPane[paneId] ?? null);
  const setActivePane = useUi((s) => s.setViewerActivePane);
  const [menu, setMenu] = useState<{ x: number; y: number; selection: string } | null>(
    null,
  );
  // 이 패널의 Monaco 선택을 읽는 통로 — Monaco 자체 메뉴를 껐으므로(아래 suppressContextMenu)
  // "선택 영역 번역"을 pane 메뉴가 대신 낸다. 패널마다 하나씩이라 서로 섞이지 않는다.
  const selectionRef: SelectionRef = useRef<(() => string) | null>(null);
  // 분할 이웃 브라우저 pane의 네이티브 webview가 이 메뉴를 덮는다 — 열린 동안 숨긴다.
  useOccludesWebview(!!menu);

  // 패널 안에서 연 파일("편집" 버튼·정의 이동)은 **이 패널**에 뜬다 — 안 넘기면 DiffViewer가
  // 전역 selectDiff로 떨어져 활성 패널로 새어나간다. 신원이 매 렌더 바뀌면 안 된다
  // (정의 이동 opener가 모듈 컨텍스트로 들고 있다 — DiffViewer의 onOpenFile 주석).
  const openInPane = useCallback(
    (target: DiffTarget, repoId: string) => {
      const ui = useUi.getState();
      ui.setViewerActivePane(paneId);
      ui.selectDiff(target, repoId);
    },
    [paneId],
  );

  return (
    <div
      data-viewer-pane={paneId}
      className={`relative flex h-full w-full flex-col ${
        active ? "outline outline-1 -outline-offset-1 outline-accent" : ""
      }`}
      onMouseDown={() => setActivePane(paneId)}
      onContextMenu={(e) => {
        e.preventDefault();
        setActivePane(paneId);
        // 선택은 **메뉴가 열리는 이 순간**에 잡는다(TerminalPane의 PaneMenu와 같은 규칙).
        // Monaco는 선택 밖을 우클릭하면 그 자리로 커서를 옮기므로 그때는 빈 문자열이 온다.
        setMenu({ x: e.clientX, y: e.clientY, selection: selectionRef.current?.() ?? "" });
      }}
    >
      <ViewerFileTabs projectId={projectId} paneId={paneId} />
      <div className="relative min-h-0 flex-1">
        {!entry ? (
          <EmptyState
            icon={MousePointerClick}
            title="파일을 선택하세요"
            desc="왼쪽 변경 목록·파일 트리 또는 아래 Log의 커밋에서 파일을 클릭하면 여기에 표시됩니다"
          />
        ) : (
          <Suspense fallback={<EmptyState title="diff 뷰어 로딩 중…" />}>
            {/* 임베디드 저장소 파일이면 그 저장소의 합성 id로 diff/편집을 라우팅한다(없으면 outer). */}
            <DiffViewer
              projectId={entry.repoId ?? projectId}
              target={entry.target}
              onOpenFile={openInPane}
              suppressContextMenu
              selectionRef={selectionRef}
            />
          </Suspense>
        )}
      </div>
      {menu && (
        <ViewerPaneMenu
          paneId={paneId}
          x={menu.x}
          y={menu.y}
          selection={menu.selection}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
