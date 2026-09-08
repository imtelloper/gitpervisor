import { useEffect, useRef } from "react";

import type { Pane, PaneLeafBase, PaneSplit } from "../../lib/pane-tree";

/**
 * 분할 노드 렌더러 — 터미널 탭(`PaneTree.tsx`)과 뷰어(`ViewerTab.tsx`)가 **공유**한다.
 * 자식 렌더는 호출자가 `render`로 준다(리프의 내용은 트리마다 다르다).
 *
 * `setRatio`/`setDraggingSplit`은 프로프다 — 예전엔 Divider가 `useTerminals`를 직접 불렀는데
 * 뷰어도 같은 divider를 쓰므로 스토어를 위로 올렸다. `setDraggingSplit`(브라우저 웹뷰 숨김)은
 * 뷰어에도 필요하다: 분할 이웃 pane이 네이티브 브라우저면 드래그 잔상이 남는다.
 */
export function SplitView<L extends PaneLeafBase>({
  node,
  render,
  setRatio,
  setDraggingSplit,
}: {
  node: PaneSplit<L>;
  render: (child: Pane<L>) => React.ReactNode;
  setRatio: (splitId: string, ratio: number) => void;
  setDraggingSplit: (v: boolean) => void;
}) {
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
        {render(node.a)}
      </div>

      <Divider
        dir={node.dir}
        splitId={node.id}
        containerRef={containerRef}
        setRatio={setRatio}
        setDraggingSplit={setDraggingSplit}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{render(node.b)}</div>
    </div>
  );
}

function Divider({
  dir,
  splitId,
  containerRef,
  setRatio,
  setDraggingSplit,
}: {
  dir: "row" | "col";
  splitId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  setRatio: (splitId: string, ratio: number) => void;
  setDraggingSplit: (v: boolean) => void;
}) {
  const isRow = dir === "row";

  // 드래그 도중 이 divider가 사라져도(패널 닫기/탭 전환/최대화) 리스너·rAF를 정리하고
  // draggingSplit이 true로 고착(브라우저 웹뷰 영구 숨김)되지 않게 하는 언마운트 안전망.
  const teardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => teardownRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // 드래그 중엔 브라우저 웹뷰를 숨겨 리사이즈 잔상을 막는다
    setDraggingSplit(true);
    // pointermove는 프레임당 여러 번 발화한다 — setRatio(스토어 갱신=워크스페이스 트리
    // 재렌더)를 rAF로 합쳐(coalesce) 프레임당 최대 1회만 커밋해 드래그 중 재렌더 폭주를 막는다.
    let raf = 0;
    let pending = 0;
    const flush = () => {
      raf = 0;
      setRatio(splitId, pending);
    };
    const move = (ev: PointerEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const ratio = isRow
        ? (ev.clientX - r.left) / r.width
        : (ev.clientY - r.top) / r.height;
      pending = Math.min(0.9, Math.max(0.1, ratio));
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      teardownRef.current = null;
      setDraggingSplit(false);
    };
    const up = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        setRatio(splitId, pending); // 마지막 위치를 확정 커밋
      }
      teardown();
    };
    teardownRef.current = teardown;
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
