import { useEffect } from "react";

import { useBrowsers } from "../../stores/browser";
import {
  collectPanes,
  useTerminals,
  type Pane,
  type TermLeaf,
  type TermTab,
} from "../../stores/terminals";
import { BrowserPane } from "./BrowserPane";
import { PaneControls } from "./PaneControls";
import { SplitView } from "./SplitView";
import {
  FileTreeButton,
  GitDialogButton,
  PromptLogButton,
  ThemeButton,
} from "./TermSessionControls";
import { TerminalPane } from "./TerminalPane";

interface ViewProps {
  node: Pane;
  tab: TermTab;
  projectId: string;
  fontSize: number;
  multi: boolean;
}

/** 활성 탭의 루트 — 최대화 패널이 있으면 그것만, 아니면 분할 트리 전체. */
export function PaneTreeRoot({
  tab,
  projectId,
  fontSize,
}: {
  tab: TermTab;
  projectId: string;
  fontSize: number;
}) {
  if (tab.maximizedPaneId) {
    // 최대화된 리프를 트리에서 찾아 그 content 그대로 렌더
    const leaf = findLeaf(tab.layout, tab.maximizedPaneId);
    if (leaf)
      return (
        <LeafView
          leaf={leaf}
          tab={tab}
          projectId={projectId}
          fontSize={fontSize}
          active={false}
        />
      );
  }
  const multi = collectPanes(tab.layout).length > 1;
  return (
    <PaneView
      node={tab.layout}
      tab={tab}
      projectId={projectId}
      fontSize={fontSize}
      multi={multi}
    />
  );
}

function findLeaf(node: Pane, paneId: string): Extract<Pane, { kind: "leaf" }> | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId);
}

// 순수 분기 — 훅 없음 (리프↔분할 전환 시 훅 개수 변동 방지)
function PaneView(props: ViewProps) {
  if (props.node.kind === "leaf") {
    return (
      <LeafView
        leaf={props.node}
        tab={props.tab}
        projectId={props.projectId}
        fontSize={props.fontSize}
        active={props.multi && props.tab.activePaneId === props.node.paneId}
      />
    );
  }
  return <TermSplitView {...props} node={props.node} />;
}

/** 분할 노드 — 공용 SplitView에 터미널 스토어의 비율/드래그 액션을 물린다. */
function TermSplitView({
  node,
  tab,
  ...rest
}: ViewProps & { node: Extract<Pane, { kind: "split" }> }) {
  const setRatio = useTerminals((s) => s.setRatio);
  const setDraggingSplit = useTerminals((s) => s.setDraggingSplit);
  return (
    <SplitView<TermLeaf>
      node={node}
      setRatio={(splitId, ratio) => setRatio(tab.id, splitId, ratio)}
      setDraggingSplit={setDraggingSplit}
      render={(child) => <PaneView node={child} tab={tab} {...rest} />}
    />
  );
}

/** 리프 한 칸 — content에 따라 터미널/브라우저를 렌더하고, 위에 패널 툴바를 띄운다. */
function LeafView({
  leaf,
  tab,
  projectId,
  fontSize,
  active,
}: {
  leaf: Extract<Pane, { kind: "leaf" }>;
  tab: TermTab;
  projectId: string;
  fontSize: number;
  active: boolean;
}) {
  const draggingSplit = useTerminals((s) => s.draggingSplit);
  const ensurePane = useBrowsers((s) => s.ensurePane);

  // 브라우저 리프면 패널 브라우저 상태를 보장(멱등)
  useEffect(() => {
    if (leaf.content === "browser") ensurePane(leaf.paneId, projectId);
  }, [leaf.content, leaf.paneId, projectId, ensurePane]);

  const controls = (
    <PaneControls tabId={tab.id} paneId={leaf.paneId} content={leaf.content} />
  );

  // 브라우저 패널은 컨트롤을 주소창 바 안에 넣어 자체 버튼과 겹치지 않게 한다.
  if (leaf.content === "browser") {
    return (
      <div className="group/pane relative h-full w-full">
        <BrowserPane id={leaf.paneId} active={!draggingSplit} paneControls={controls} />
      </div>
    );
  }

  // 터미널 패널은 바가 없으므로 우상단 호버 오버레이로 띄운다 — 오버레이 자체는 TerminalPane이
  // xterm 호스트 안에 그린다(프롬프트 컬럼 헤더의 X를 덮지 않게 — TerminalPane의 주석 참고).
  return (
    <div className="group/pane relative h-full w-full">
      <TerminalPane
        tabId={tab.id}
        projectId={projectId}
        paneId={leaf.paneId}
        active={active}
        fontSize={fontSize}
        controls={
          <>
            <ThemeButton termId={leaf.paneId} />
            <PromptLogButton termId={leaf.paneId} />
            <GitDialogButton projectId={tab.projectId} />
            <FileTreeButton projectId={tab.projectId} />
            <span className="mx-0.5 h-3 w-px bg-edge" />
            {controls}
          </>
        }
      />
    </div>
  );
}

