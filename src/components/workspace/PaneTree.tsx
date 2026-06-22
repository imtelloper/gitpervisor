import {
  Globe,
  Maximize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";

import { useBrowsers } from "../../stores/browser";
import {
  collectPanes,
  useTerminals,
  type Pane,
  type TermTab,
} from "../../stores/terminals";
import { BrowserPane } from "./BrowserPane";
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
  return <SplitView {...props} node={props.node} />;
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

  return (
    <div className="group/pane relative h-full w-full">
      {leaf.content === "browser" ? (
        // 패널 브라우저: 표시 조건은 분할 드래그 중이 아닐 때 (탭은 이미 활성)
        <BrowserPane id={leaf.paneId} active={!draggingSplit} />
      ) : (
        <TerminalPane
          tabId={tab.id}
          projectId={projectId}
          paneId={leaf.paneId}
          active={active}
          fontSize={fontSize}
        />
      )}
      <PaneToolbar tabId={tab.id} paneId={leaf.paneId} content={leaf.content} />
    </div>
  );
}

/** 각 패널 우상단 호버 툴바 — 우/하 분할, 터미널↔웹 전환, 최대화, 닫기 (cmux 스타일). */
function PaneToolbar({
  tabId,
  paneId,
  content,
}: {
  tabId: string;
  paneId: string;
  content: "terminal" | "browser";
}) {
  const splitPane = useTerminals((s) => s.splitPane);
  const setPaneContent = useTerminals((s) => s.setPaneContent);
  const closePane = useTerminals((s) => s.closePane);
  const toggleMaximize = useTerminals((s) => s.toggleMaximize);
  const ensurePane = useBrowsers((s) => s.ensurePane);
  const projectId = useTerminals(
    (s) => s.terminals.find((t) => t.id === tabId)?.projectId ?? "",
  );

  const toggleType = () => {
    if (content === "terminal") {
      ensurePane(paneId, projectId);
      setPaneContent(tabId, paneId, "browser");
    } else {
      // 웹→터미널: 웹뷰 정리는 BrowserPane 언마운트가 처리(참조 사라짐→dispose)
      setPaneContent(tabId, paneId, "terminal");
    }
  };

  return (
    <div className="absolute right-1 top-1 z-30 flex items-center gap-0.5 rounded-md border border-edge bg-panel/95 p-0.5 opacity-0 shadow-lg transition-opacity group-hover/pane:opacity-100">
      <TBtn
        title={content === "terminal" ? "웹으로 전환" : "터미널로 전환"}
        onClick={toggleType}
      >
        {content === "terminal" ? <Globe size={13} /> : <TerminalIcon size={13} />}
      </TBtn>
      <TBtn title="오른쪽으로 분할" onClick={() => splitPane(tabId, paneId, "row", false)}>
        <SplitSquareHorizontal size={13} />
      </TBtn>
      <TBtn title="아래로 분할" onClick={() => splitPane(tabId, paneId, "col", false)}>
        <SplitSquareVertical size={13} />
      </TBtn>
      <TBtn title="최대화/복원" onClick={() => toggleMaximize(tabId, paneId)}>
        <Maximize2 size={13} />
      </TBtn>
      <TBtn title="패널 닫기" danger onClick={() => closePane(tabId, paneId)}>
        <X size={13} />
      </TBtn>
    </div>
  );
}

function TBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded p-1 text-fg-dim hover:bg-raised ${
        danger ? "hover:text-danger" : "hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

function SplitView({
  node,
  tab,
  projectId,
  fontSize,
  multi,
}: ViewProps & { node: Extract<Pane, { kind: "split" }> }) {
  const isRow = node.dir === "row";
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full ${isRow ? "flex-row" : "flex-col"}`}
    >
      <div
        style={{ flexBasis: `${node.ratio * 100}%` }}
        className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden"
      >
        <PaneView
          node={node.a}
          tab={tab}
          projectId={projectId}
          fontSize={fontSize}
          multi={multi}
        />
      </div>

      <Divider
        dir={node.dir}
        tabId={tab.id}
        splitId={node.id}
        containerRef={containerRef}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneView
          node={node.b}
          tab={tab}
          projectId={projectId}
          fontSize={fontSize}
          multi={multi}
        />
      </div>
    </div>
  );
}

function Divider({
  dir,
  tabId,
  splitId,
  containerRef,
}: {
  dir: "row" | "col";
  tabId: string;
  splitId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const setRatio = useTerminals((s) => s.setRatio);
  const setDraggingSplit = useTerminals((s) => s.setDraggingSplit);
  const isRow = dir === "row";

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // 드래그 중엔 브라우저 웹뷰를 숨겨 리사이즈 잔상을 막는다
    setDraggingSplit(true);
    const move = (ev: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const ratio = isRow
        ? (ev.clientX - r.left) / r.width
        : (ev.clientY - r.top) / r.height;
      setRatio(tabId, splitId, Math.min(0.9, Math.max(0.1, ratio)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraggingSplit(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className={`shrink-0 bg-edge transition-colors hover:bg-accent ${
        isRow ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize"
      }`}
    />
  );
}
