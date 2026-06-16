import { useRef } from "react";

import {
  collectPanes,
  useTerminals,
  type Pane,
  type TermTab,
} from "../../stores/terminals";
import { TerminalPane } from "./TerminalPane";

interface ViewProps {
  node: Pane;
  tab: TermTab;
  projectId: string;
  fontSize: number;
  multi: boolean;
}

/** 활성 터미널 탭의 루트 — 최대화 패널이 있으면 그것만, 아니면 분할 트리 전체. */
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
    return (
      <TerminalPane
        tabId={tab.id}
        projectId={projectId}
        paneId={tab.maximizedPaneId}
        active={false}
        fontSize={fontSize}
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

// 순수 분기 — 훅 없음 (리프↔분할 전환 시 훅 개수 변동 방지)
function PaneView(props: ViewProps) {
  if (props.node.kind === "leaf") {
    return (
      <TerminalPane
        tabId={props.tab.id}
        projectId={props.projectId}
        paneId={props.node.paneId}
        active={props.multi && props.tab.activePaneId === props.node.paneId}
        fontSize={props.fontSize}
      />
    );
  }
  return <SplitView {...props} node={props.node} />;
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
  const isRow = dir === "row";

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
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
