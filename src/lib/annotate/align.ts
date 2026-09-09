// 정렬·분배·간격 정리·반전 — 선택 여러 개를 한 번에 옮기는 **순수** 연산.
//
// `Node[]` → `Node[]` 만 한다(DOM·React·스토어 import 0). 컨텍스트 바 버튼과 단축키가 같은
// 함수를 부르고 e2e 는 `actions.align('left')` 로 직접 부르므로, 렌더 밖에서 검증되는 것이
// 이 파일이 순수해야 하는 이유다.
//
// 어긋나면 조용히 틀리는 두 가지를 늘 지킨다:
// ① **기준은 AABB**(`nodeAABB`)다. 회전한 노드를 로컬 rect 로 맞추면 문서상으로는 맞았는데
//    화면에서는 삐뚤어져 보인다 — 사용자가 보는 것은 회전 뒤 외접 상자다.
// ② **컨테이너는 자손째 움직인다**(`translateSubtree`). 그룹은 자기 기하가 없어서(38 §1)
//    리프만 옮기면 그룹이 그 자리에서 흩어진다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.5

import { transformObjects } from "./geometry";
import { ancestorsOf, nodeAABB, nodeOf, subtreeIds, translateSubtree } from "./tree";
import type { Node, ObjId, Rect } from "./types";

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/**
 * 실제로 옮길 id — 문서에 없는 것과, 선택 안에 조상이 함께 있는 자손을 뺀다.
 *
 * 아래 연산들은 id 마다 **각자 다른 델타**로 `translateSubtree` 를 부른다. 조상과 자손이
 * 같이 걸려 있으면 자손이 조상 델타 + 자기 델타로 **두 번** 움직여 그룹이 어긋난다.
 * 삭제된 노드를 가리키는 id 는 AABB 가 `0,0,0,0` 이라 남겨 두면 분배 간격을 통째로 끌어당긴다.
 */
function movableRoots(objects: readonly Node[], ids: readonly ObjId[]): ObjId[] {
  const set = new Set(ids);
  return [...set].filter(
    (id) => nodeOf(objects, id) !== null && !ancestorsOf(objects, id).some((a) => set.has(a)),
  );
}

function centerOf(r: Rect, axis: "x" | "y"): number {
  return axis === "x" ? r.x + r.w / 2 : r.y + r.h / 2;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return {
    x: x0,
    y: y0,
    w: Math.max(a.x + a.w, b.x + b.w) - x0,
    h: Math.max(a.y + a.h, b.y + b.h) - y0,
  };
}

function alignDelta(box: Rect, target: Rect, mode: AlignMode): { dx: number; dy: number } {
  switch (mode) {
    case "left":
      return { dx: target.x - box.x, dy: 0 };
    case "hcenter":
      return { dx: centerOf(target, "x") - centerOf(box, "x"), dy: 0 };
    case "right":
      return { dx: target.x + target.w - (box.x + box.w), dy: 0 };
    case "top":
      return { dx: 0, dy: target.y - box.y };
    case "vcenter":
      return { dx: 0, dy: centerOf(target, "y") - centerOf(box, "y") };
    case "bottom":
      return { dx: 0, dy: target.y + target.h - (box.y + box.h) };
  }
}

/**
 * 대상들을 기준 상자에 맞춘다.
 *
 * `keyId` 가 null 이면 **캔버스**가 기준, 아니면 그 노드가 기준이고 기준 자신은 움직이지
 * 않는다. 어느 것이 "마지막 선택"인지는 선택 순서를 아는 호출자가 정한다(Figma 관습).
 */
export function alignObjects(
  objects: readonly Node[],
  ids: readonly ObjId[],
  mode: AlignMode,
  keyId: ObjId | null,
  canvas: Rect,
): Node[] {
  const target = keyId ? nodeAABB(objects, keyId) : canvas;
  const moving = movableRoots(objects, ids).filter((id) => id !== keyId);
  if (!moving.length) return objects as Node[];
  const deltas = moving.map((id) => alignDelta(nodeAABB(objects, id), target, mode));
  // ponytail: id 하나마다 배열 전체를 훑는다(O(N·k)). 선택 수백 개까지는 무해하다 —
  // 한 번에 끝내려면 `translateSubtree` 의 루프를 여기에 복제해야 한다.
  return moving.reduce(
    (acc, id, i) => translateSubtree(acc, [id], deltas[i].dx, deltas[i].dy),
    objects as Node[],
  );
}

/**
 * 중심을 축 방향 등간격에 놓는다. 양 끝 둘은 제자리다.
 *
 * **3개 미만이면 항등**(같은 배열을 그대로 돌려준다) — 둘을 "균등 분배"하면 놓을 자리가
 * 없는데 좌표만 흔들려 히스토리에 아무것도 안 바뀐 칸이 쌓인다.
 */
export function distributeObjects(
  objects: readonly Node[],
  ids: readonly ObjId[],
  axis: "x" | "y",
): Node[] {
  const roots = movableRoots(objects, ids);
  if (roots.length < 3) return objects as Node[];
  const items = roots
    .map((id) => ({ id, c: centerOf(nodeAABB(objects, id), axis) }))
    .sort((a, b) => a.c - b.c);
  const first = items[0].c;
  const step = (items[items.length - 1].c - first) / (items.length - 1);
  return items.reduce((acc, it, i) => {
    if (i === 0 || i === items.length - 1) return acc;
    const d = first + step * i - it.c;
    return translateSubtree(acc, [it.id], axis === "x" ? d : 0, axis === "x" ? 0 : d);
  }, objects as Node[]);
}

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 선택을 한 줄로 모아 **인접 간격을 균일하게** 만든다. 첫 항목이 제자리에 남고 나머지가 붙어 온다.
 *
 * 축은 중심들이 더 넓게 퍼진 쪽으로 고른다 — 가로로 늘어선 것을 세로로 쌓아 버리면 안 된다.
 * `gap === 'auto'` 는 현재 간격의 **중앙값**이다. 평균이면 멀찍이 떨어진 하나가 나머지 전부를
 * 밀어내 "정리"가 아니라 재배치가 된다.
 */
export function tidyObjects(
  objects: readonly Node[],
  ids: readonly ObjId[],
  gap: number | "auto",
): Node[] {
  const roots = movableRoots(objects, ids);
  if (roots.length < 2) return objects as Node[];
  const boxes = roots.map((id) => ({ id, box: nodeAABB(objects, id) }));
  const spread = (a: "x" | "y"): number => {
    const cs = boxes.map((b) => centerOf(b.box, a));
    return Math.max(...cs) - Math.min(...cs);
  };
  const axis: "x" | "y" = spread("x") >= spread("y") ? "x" : "y";
  const start = (r: Rect) => (axis === "x" ? r.x : r.y);
  const size = (r: Rect) => (axis === "x" ? r.w : r.h);
  boxes.sort((a, b) => centerOf(a.box, axis) - centerOf(b.box, axis));

  const g =
    gap === "auto"
      ? median(boxes.slice(1).map((b, i) => start(b.box) - (start(boxes[i].box) + size(boxes[i].box))))
      : gap;
  let cursor = start(boxes[0].box) + size(boxes[0].box);
  return boxes.reduce((acc, b, i) => {
    if (i === 0) return acc;
    const d = cursor + g - start(b.box);
    cursor += g + size(b.box);
    return translateSubtree(acc, [b.id], axis === "x" ? d : 0, axis === "x" ? 0 : d);
  }, objects as Node[]);
}

/**
 * 선택을 **제자리에서** 뒤집는다.
 *
 * `transformObjects` 의 사상이 `x → W − x` 라, 선택 AABB 중심 `cx` 의 두 배를 `W` 로 넘기면
 * 반사축이 정확히 `cx` 가 된다 — 새 기하 수학이 필요 없다. 글리프(텍스트·뱃지)는 거울로
 * 뒤집지 않고 앵커만 옮기고 `rot` 부호를 뒤집는다(`geometry.ts` R-ROT) — 읽히는 쪽이 낫다.
 *
 * 대상은 서브트리로 펼쳐서 넘긴다. 컨테이너 노드만 넘기면 기하가 없어 아무 일도 일어나지 않는다.
 */
export function flipNodes(
  objects: readonly Node[],
  ids: readonly ObjId[],
  axis: "h" | "v",
): Node[] {
  const moving = new Set<ObjId>();
  let box: Rect | null = null;
  for (const id of movableRoots(objects, ids)) {
    for (const sub of subtreeIds(objects, id)) moving.add(sub);
    const b = nodeAABB(objects, id);
    box = box ? unionRect(box, b) : b;
  }
  if (!box || !moving.size) return objects as Node[];

  const flipped = transformObjects(
    objects.filter((n) => moving.has(n.id)),
    axis === "h" ? "flipH" : "flipV",
    2 * centerOf(box, "x"),
    2 * centerOf(box, "y"),
  );
  const byId = new Map(flipped.map((n) => [n.id, n]));
  return objects.map((n) => byId.get(n.id) ?? n);
}
