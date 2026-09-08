/**
 * 분할 레이아웃 트리 — 터미널 탭(`stores/terminals.ts`)과 뷰어(`stores/ui.ts`)가 **공유**한다.
 *
 * 리프 payload만 제네릭으로 열어 뒀다: 터미널은 `{ paneId, content }`, 뷰어는 `{ paneId }`.
 * 필드 이름(`paneId`·`content`)은 영속 데이터의 형태 그 자체라 바꾸면 저장된 레이아웃이
 * 로드되지 않는다. **두 번째 분할 구현을 만들지 말고 여기를 쓴다**(태스크 64 §3.1).
 */

export type SplitDir = "row" | "col"; // row=좌우 분할, col=상하 분할

/** 모든 리프가 갖는 최소 payload — 트리 순회·검색의 키. */
export interface PaneLeafBase {
  paneId: string;
}

/** 리프 노드 타입 — payload는 트리마다 다르다. */
export type PaneLeaf<L extends PaneLeafBase = PaneLeafBase> = { kind: "leaf" } & L;

/** 분할 노드 타입. 두 자식과 경계 비율(0.1~0.9로 클램프)을 갖는다. */
export interface PaneSplit<L extends PaneLeafBase = PaneLeafBase> {
  kind: "split";
  id: string;
  dir: SplitDir;
  ratio: number;
  a: Pane<L>;
  b: Pane<L>;
}

/** 한 탭(또는 뷰어)의 분할 레이아웃 트리. 리프 = 패널.
 *  (제네릭이 섞인 `Extract<Pane<L>, …>`는 좁혀지지 않는다 — 분기 타입은 위 둘을 직접 쓴다.) */
export type Pane<L extends PaneLeafBase = PaneLeafBase> = PaneLeaf<L> | PaneSplit<L>;

export function collectPanes<L extends PaneLeafBase>(node: Pane<L>): string[] {
  return node.kind === "leaf"
    ? [node.paneId]
    : [...collectPanes(node.a), ...collectPanes(node.b)];
}

/** target 리프를 (newLeaf, target) 분할로 교체한다. newFirst면 새 리프가 앞(좌/상)에 온다. */
export function splitAt<L extends PaneLeafBase>(
  node: Pane<L>,
  target: string,
  dir: SplitDir,
  newLeaf: PaneLeaf<L>,
  newFirst: boolean,
): Pane<L> {
  if (node.kind === "leaf") {
    if (node.paneId !== target) return node;
    const oldLeaf: Pane<L> = node;
    return {
      kind: "split",
      id: crypto.randomUUID(),
      dir,
      ratio: 0.5,
      a: newFirst ? newLeaf : oldLeaf,
      b: newFirst ? oldLeaf : newLeaf,
    };
  }
  return {
    ...node,
    a: splitAt(node.a, target, dir, newLeaf, newFirst),
    b: splitAt(node.b, target, dir, newLeaf, newFirst),
  };
}

/** 트리에서 target 리프를 subtree로 교체한다(나머지 레이아웃은 그대로 유지). */
export function replaceLeaf<L extends PaneLeafBase>(
  node: Pane<L>,
  target: string,
  subtree: Pane<L>,
): Pane<L> {
  if (node.kind === "leaf") return node.paneId === target ? subtree : node;
  return {
    ...node,
    a: replaceLeaf(node.a, target, subtree),
    b: replaceLeaf(node.b, target, subtree),
  };
}

export function removePane<L extends PaneLeafBase>(
  node: Pane<L>,
  target: string,
): Pane<L> | null {
  if (node.kind === "leaf") return node.paneId === target ? null : node;
  const a = removePane(node.a, target);
  const b = removePane(node.b, target);
  if (a === null) return b; // 형제가 분할 자리를 차지
  if (b === null) return a;
  return { ...node, a, b };
}

export function setRatioAt<L extends PaneLeafBase>(
  node: Pane<L>,
  splitId: string,
  ratio: number,
): Pane<L> {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    a: setRatioAt(node.a, splitId, ratio),
    b: setRatioAt(node.b, splitId, ratio),
  };
}
