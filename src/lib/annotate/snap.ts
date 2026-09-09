// 스냅·정렬 측정 — 드래그가 "정확한 값"에 붙는 유일한 곳.
//
// **왜 인덱스가 따로 있나**: 후보 좌표를 pointermove 마다 다시 뽑으면 text 노드의 `objectAABB`
// 가 그때마다 `layoutText → measureText` 를 부른다(geometry.ts). N개 × 60fps 면 드래그가 눈에
// 띄게 끊긴다. 그래서 **드래그 시작에 한 번** 정렬된 `Float64Array` 를 만들고, 매 틱은 이진
// 탐색만 한다. 선형 스캔으로 되돌리면 5,000노드 문서에서 그 끊김이 그대로 돌아온다.
//
// DOM 을 import 하지 않는다 — 47 노드 드래그·48 크롭 핸들·45 그라디언트 핸들이 같은 함수를
// 부르기 때문이다. 좌표는 전부 **oriented px** 이고, 화면 px 임계값(기본 4 css px)은 호출자가
// `tol = 임계값 / screen.scale` 로 환산해 넘긴다 — 여기서 줌을 알면 좌표 프레임이 둘이 된다.
//
// 배경: DOCS/task/43-image-chrome-snap.md §3.4·§3.5

import { objectAABB } from "./geometry";
import type { Scene } from "./scene";
import type { EditorDoc, ObjId, Rect } from "./types";

/** 눈금자에서 끌어낸 가이드. `axis` 는 **`pos` 가 어느 축의 좌표인가**다 — `'y'` 면 수평선. */
export type Guide = EditorDoc["guides"][number];

export interface SnapIndex {
  xs: Float64Array;
  ys: Float64Array;
  boxes: readonly Rect[];
  guides: readonly Guide[];
  gridPx: 0 | 8 | 16;
  pixel: boolean;
  canvas: Rect;
}

export type SnapKind = "guide" | "object" | "canvas" | "grid";

export interface SnapLine {
  axis: "x" | "y";
  pos: number;
  from: number;
  to: number;
  kind: SnapKind;
}

export interface SnapGap {
  axis: "x" | "y";
  a: number;
  b: number;
  at: number;
  value: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  lines: SnapLine[];
  gaps: SnapGap[];
}

export interface Measure {
  from: { x: number; y: number };
  to: { x: number; y: number };
  label: string;
  kind: "alt" | "gap";
}

type Axis = "x" | "y";

/** 좌표 동일 판정 — 후보는 부동소수 산술(중앙 = x + w/2)로 나오므로 정확 비교는 못 한다. */
const EPS = 1e-6;

/**
 * 동률(같은 거리)일 때의 우선순위. 뒤집히면 사용자가 손으로 만든 가이드가 그리드에 밀린다 —
 * 가이드는 "여기 붙여 달라"는 명시적 지시이므로 자동 후보보다 항상 앞선다.
 */
const RANK: Record<SnapKind, number> = { guide: 0, object: 1, canvas: 2, grid: 3 };

// ── 인덱스 ──────────────────────────────────────────────────────────────────

/**
 * 드래그 시작에 **한 번** 부른다. O(N log N).
 *
 * `exclude` 는 드래그 중인 노드다 — 안 빼면 자기 자신에게 스냅해 드래그가 제자리에 붙는다.
 * 서브트리도 함께 빠져야 하므로 조상 사슬을 타고 확인한다(호출자가 루트 id 만 넘겨도 된다).
 */
export function buildSnapIndex(
  scene: Scene,
  exclude: ReadonlySet<ObjId>,
  guides: readonly Guide[],
  opts: {
    gridPx: 0 | 8 | 16;
    pixel: boolean;
    objects: boolean;
    guides: boolean;
    canvas: Rect;
  },
): SnapIndex {
  const boxes: Rect[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const useGuides = opts.guides ? guides : [];

  if (opts.objects) {
    // 컨테이너는 기하가 없다 — 자손 리프의 합집합으로 파생한다(tree.nodeAABB 와 같은 규칙).
    // owner 사슬을 한 번 타면서 누적하므로 그룹마다 서브트리를 다시 훑지 않는다.
    const containers = new Map<ObjId, Rect>();
    for (const n of scene.nodes) {
      if (isExcluded(scene, exclude, n.id)) continue;
      const b = objectAABB(n);
      boxes.push(b);
      let p = scene.owner.get(n.id) ?? null;
      for (let guard = 0; p && guard <= scene.nodes.length; guard++) {
        const acc = containers.get(p);
        containers.set(p, acc ? unionRect(acc, b) : b);
        p = scene.owner.get(p) ?? null;
      }
    }
    for (const b of containers.values()) boxes.push(b);
    for (const b of boxes) {
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
  }
  for (const g of useGuides) (g.axis === "x" ? xs : ys).push(g.pos);
  const c = opts.canvas;
  xs.push(c.x, c.x + c.w / 2, c.x + c.w);
  ys.push(c.y, c.y + c.h / 2, c.y + c.h);

  return {
    xs: sortedUnique(xs),
    ys: sortedUnique(ys),
    boxes,
    guides: useGuides,
    gridPx: opts.gridPx,
    pixel: opts.pixel,
    canvas: c,
  };
}

function isExcluded(scene: Scene, exclude: ReadonlySet<ObjId>, id: ObjId): boolean {
  if (exclude.size === 0) return false;
  let cur: ObjId | null = id;
  // 사슬이 망가진 문서(순환)에서도 멈춘다 — 여기서 무한 루프면 드래그 중 창이 통째로 언다.
  for (let guard = 0; cur && guard <= scene.nodes.length; guard++) {
    if (exclude.has(cur)) return true;
    cur = scene.owner.get(cur) ?? null;
  }
  return false;
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

function sortedUnique(v: number[]): Float64Array {
  if (v.length === 0) return new Float64Array(0);
  const a = Float64Array.from(v);
  a.sort();
  let n = 1;
  for (let i = 1; i < a.length; i++) if (a[i] - a[n - 1] > EPS) a[n++] = a[i];
  return a.subarray(0, n);
}

// ── 조회 ────────────────────────────────────────────────────────────────────

function lowerBound(a: Float64Array, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function canvasCoords(c: Rect, axis: Axis): [number, number, number] {
  const lo = axis === "x" ? c.x : c.y;
  const len = axis === "x" ? c.w : c.h;
  return [lo, lo + len / 2, lo + len];
}

function boxCoordsHit(idx: SnapIndex, axis: Axis, v: number): boolean {
  for (const b of idx.boxes) {
    const lo = axis === "x" ? b.x : b.y;
    const len = axis === "x" ? b.w : b.h;
    if (
      Math.abs(lo - v) <= EPS ||
      Math.abs(lo + len / 2 - v) <= EPS ||
      Math.abs(lo + len - v) <= EPS
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 후보 좌표가 어디서 왔나. 배열에는 종류를 안 싣는다(인덱스 계약이 좌표 배열 둘뿐) —
 * 대신 **가이드 → 캔버스 → 객체** 순으로 되짚는다. 캔버스 변에 객체 변이 겹쳐 있으면
 * 객체가 이겨야 해서(우선순위 object > canvas) 그때만 상자를 훑는다. 캔버스 좌표는 축당
 * 3개뿐이라 O(N) 경로는 사실상 안 돈다.
 */
function kindOf(idx: SnapIndex, axis: Axis, v: number): SnapKind {
  for (const g of idx.guides) if (g.axis === axis && Math.abs(g.pos - v) <= EPS) return "guide";
  for (const c of canvasCoords(idx.canvas, axis)) {
    if (Math.abs(c - v) <= EPS) return boxCoordsHit(idx, axis, v) ? "object" : "canvas";
  }
  return "object";
}

/** 좌표 하나에 가장 가까운 후보. 없으면 그리드, 그것도 없으면 null. */
function bestOnAxis(
  idx: SnapIndex,
  axis: Axis,
  v: number,
  tol: number,
): { pos: number; kind: SnapKind } | null {
  const arr = axis === "x" ? idx.xs : idx.ys;
  let found = false;
  let pos = 0;
  let dist = Infinity;
  let kind: SnapKind = "object";
  let rank = RANK.grid + 1;
  const consider = (p: number): void => {
    const d = Math.abs(p - v);
    if (d > tol + EPS) return;
    const k = kindOf(idx, axis, p);
    const r = RANK[k];
    if (!found || d < dist - EPS || (d <= dist + EPS && r < rank)) {
      found = true;
      pos = p;
      dist = d;
      kind = k;
      rank = r;
    }
  };
  const lo = lowerBound(arr, v);
  // 정렬돼 있으니 양쪽으로 벌어지다 최선 거리를 넘는 순간 멈춘다 — 동률 후보만 더 본다.
  for (let i = lo - 1; i >= 0 && v - arr[i] <= Math.min(tol, dist) + EPS; i--) consider(arr[i]);
  for (let i = lo; i < arr.length && arr[i] - v <= Math.min(tol, dist) + EPS; i++) consider(arr[i]);
  if (found) return { pos, kind };

  // 그리드는 무한해서 배열에 못 싣는다 — 산술로 답하고, 우선순위상 맨 뒤이므로 여기서 본다.
  if (idx.gridPx > 0) {
    const g = Math.round(v / idx.gridPx) * idx.gridPx;
    if (Math.abs(g - v) <= tol + EPS) return { pos: g, kind: "grid" };
  }
  return null;
}

function lineFor(
  idx: SnapIndex,
  axis: Axis,
  pos: number,
  kind: SnapKind,
  other: readonly [number, number],
): SnapLine {
  let from = other[0];
  let to = other[1];
  if (kind === "object") {
    // 두 객체 **사이**만 긋는다(시안 `Smart Guide V`) — 캔버스 전폭으로 그으면 가이드와
    // 구분이 안 된다.
    for (const b of idx.boxes) {
      const lo = axis === "x" ? b.x : b.y;
      const len = axis === "x" ? b.w : b.h;
      if (
        Math.abs(lo - pos) > EPS &&
        Math.abs(lo + len / 2 - pos) > EPS &&
        Math.abs(lo + len - pos) > EPS
      ) {
        continue;
      }
      const o0 = axis === "x" ? b.y : b.x;
      const o1 = o0 + (axis === "x" ? b.h : b.w);
      from = Math.min(from, o0);
      to = Math.max(to, o1);
    }
  } else {
    const [c0, , c1] = canvasCoords(idx.canvas, axis === "x" ? "y" : "x");
    from = Math.min(from, c0);
    to = Math.max(to, c1);
  }
  return { axis, pos, from, to, kind };
}

function snapAxis(
  idx: SnapIndex,
  axis: Axis,
  coords: readonly number[],
  tol: number,
  other: readonly [number, number],
): { delta: number; line: SnapLine | null } {
  let best: { delta: number; pos: number; kind: SnapKind } | null = null;
  for (const c of coords) {
    const hit = bestOnAxis(idx, axis, c, tol);
    if (!hit) continue;
    const delta = hit.pos - c;
    if (
      !best ||
      Math.abs(delta) < Math.abs(best.delta) - EPS ||
      (Math.abs(delta) <= Math.abs(best.delta) + EPS && RANK[hit.kind] < RANK[best.kind])
    ) {
      best = { delta, pos: hit.pos, kind: hit.kind };
    }
  }
  if (best) return { delta: best.delta, line: lineFor(idx, axis, best.pos, best.kind, other) };
  if (idx.pixel) {
    // 픽셀 스냅은 최후 수단이고 선을 그리지 않는다 — 매 프레임 뜨는 1px 선은 정보가 없다.
    const c = coords[0];
    return { delta: Math.round(c) - c, line: null };
  }
  return { delta: 0, line: null };
}

/** 이동·마퀴 — AABB 의 좌·중·우 / 상·중·하 3×3 후보. */
export function snapRect(
  idx: SnapIndex,
  r: Rect,
  tol: number,
  opts?: { gaps?: boolean },
): SnapResult {
  const x = snapAxis(idx, "x", [r.x, r.x + r.w / 2, r.x + r.w], tol, [r.y, r.y + r.h]);
  const y = snapAxis(idx, "y", [r.y, r.y + r.h / 2, r.y + r.h], tol, [r.x, r.x + r.w]);
  const lines: SnapLine[] = [];
  if (x.line) lines.push(x.line);
  if (y.line) lines.push(y.line);
  let dx = x.delta;
  let dy = y.delta;
  const gaps: SnapGap[] = [];
  if (opts?.gaps) {
    // 변 스냅이 이미 잡은 축은 건드리지 않는다 — 두 보정이 다른 값을 가리키면 나중에 쓴 쪽이
    // 이기고, 사용자는 뱃지가 말하는 간격과 다른 자리에 놓인 객체를 본다.
    if (!x.line) {
      const g = equalGap(idx, r, "x", tol);
      if (g) {
        dx = g.delta;
        gaps.push(...g.gaps);
      }
    }
    if (!y.line) {
      const g = equalGap(idx, r, "y", tol);
      if (g) {
        dy = g.delta;
        gaps.push(...g.gaps);
      }
    }
  }
  return { dx, dy, lines, gaps };
}

/** 핸들·정점·펜 클릭·가이드·크롭 핸들 — 점 하나. */
export function snapPoint(
  idx: SnapIndex,
  p: { x: number; y: number },
  tol: number,
): SnapResult {
  const x = snapAxis(idx, "x", [p.x], tol, [p.y, p.y]);
  const y = snapAxis(idx, "y", [p.y], tol, [p.x, p.x]);
  const lines: SnapLine[] = [];
  if (x.line) lines.push(x.line);
  if (y.line) lines.push(y.line);
  return { dx: x.delta, dy: y.delta, lines, gaps: [] };
}

// ── 등간격 ──────────────────────────────────────────────────────────────────

/**
 * 등간격 배치 감지(시안 `Gap Badge 50`). 두 모양을 본다:
 * ① 좌우에 이웃이 있고 두 간격이 비슷하면 **가운데로** 맞춘다,
 * ② 한쪽에만 이웃이 둘이면 그 둘의 간격을 **이어서** 세 번째를 놓는다(A·B 다음의 C).
 *
 * `ponytail: 이웃 탐색 O(N)/move — 1k 객체 <0.1ms(추정, 비교 6N회). 5k 넘으면 인덱스에 이미
 * 있는 정렬을 살려 구간 트리로 승격`.
 */
function equalGap(
  idx: SnapIndex,
  r: Rect,
  axis: Axis,
  tol: number,
): { delta: number; gaps: SnapGap[] } | null {
  const a0 = axis === "x" ? r.x : r.y;
  const size = axis === "x" ? r.w : r.h;
  const a1 = a0 + size;
  const c0 = axis === "x" ? r.y : r.x;
  const c1 = c0 + (axis === "x" ? r.h : r.w);
  const at = (c0 + c1) / 2;

  // 수직축 범위가 겹치는 이웃만 — 다른 줄에 있는 객체와의 "간격"은 의미가 없다.
  const near: { lo: number; hi: number }[] = [];
  for (const b of idx.boxes) {
    const b0 = axis === "x" ? b.y : b.x;
    const b1 = b0 + (axis === "x" ? b.h : b.w);
    if (b1 <= c0 + EPS || b0 >= c1 - EPS) continue;
    const lo = axis === "x" ? b.x : b.y;
    near.push({ lo, hi: lo + (axis === "x" ? b.w : b.h) });
  }

  const left: { lo: number; hi: number }[] = [];
  const right: { lo: number; hi: number }[] = [];
  for (const b of near) {
    if (b.hi <= a0 + EPS) left.push(b);
    else if (b.lo >= a1 - EPS) right.push(b);
  }
  left.sort((p, q) => q.hi - p.hi);
  right.sort((p, q) => p.lo - q.lo);

  // a/b 는 축 방향 구간, at 은 뱃지를 놓을 수직축 좌표다.
  const mk = (lo: number, hi: number, value: number): SnapGap => ({ axis, a: lo, b: hi, at, value });

  // ① 사이에 놓기
  if (left.length && right.length) {
    const total = right[0].lo - left[0].hi - size;
    const gapL = a0 - left[0].hi;
    const gapR = right[0].lo - a1;
    if (total >= 0 && Math.abs(gapL - gapR) <= tol + EPS) {
      const g = total / 2;
      const start = left[0].hi + g;
      return {
        delta: start - a0,
        gaps: [mk(left[0].hi, start, g), mk(start + size, right[0].lo, g)],
      };
    }
  }
  // ② 한쪽 이웃 둘의 간격을 잇기
  const series = (side: { lo: number; hi: number }[], forward: boolean) => {
    if (side.length < 2) return null;
    const target = forward ? side[0].lo - side[1].hi : side[1].lo - side[0].hi;
    if (target < 0) return null;
    const cur = forward ? a0 - side[0].hi : side[0].lo - a1;
    if (Math.abs(cur - target) > tol + EPS) return null;
    const start = forward ? side[0].hi + target : side[0].lo - target - size;
    const prev = forward
      ? mk(side[1].hi, side[0].lo, target)
      : mk(side[0].hi, side[1].lo, target);
    const own = forward
      ? mk(side[0].hi, start, target)
      : mk(start + size, side[0].lo, target);
    return { delta: start - a0, gaps: [prev, own] };
  };
  return series(left, true) ?? series(right, false);
}

// ── 측정 ────────────────────────────────────────────────────────────────────

function crossCenter(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  // 겹치면 겹친 구간 가운데, 아니면 두 중심의 중간 — 선이 두 상자 밖으로 벗어나지 않는다.
  return hi > lo ? (lo + hi) / 2 : ((a0 + a1) / 2 + (b0 + b1) / 2) / 2;
}

function measure(x1: number, y1: number, x2: number, y2: number): Measure {
  return {
    from: { x: x1, y: y1 },
    to: { x: x2, y: y2 },
    label: String(Math.round(Math.abs(x2 - x1) + Math.abs(y2 - y1))),
    kind: "alt",
  };
}

/**
 * Alt 호버 측정(시안 `Alt 호버 · 간격 50px · 좌 151 / 우 529`).
 *
 * `b` 가 null 이면 캔버스 4변까지의 거리 4개. `b` 가 있으면 **겹치지 않는 축만** 돌려준다 —
 * 겹치는 축에서 두 상자의 "거리"는 음수이거나 임의의 변 조합이라 읽는 사람을 속인다.
 */
export function measureBetween(a: Rect, b: Rect | null, canvas: Rect): Measure[] {
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  if (!b) {
    return [
      measure(canvas.x, cy, a.x, cy),
      measure(a.x + a.w, cy, canvas.x + canvas.w, cy),
      measure(cx, canvas.y, cx, a.y),
      measure(cx, a.y + a.h, cx, canvas.y + canvas.h),
    ];
  }
  const out: Measure[] = [];
  const my = crossCenter(a.y, a.y + a.h, b.y, b.y + b.h);
  if (b.x >= a.x + a.w - EPS) out.push(measure(a.x + a.w, my, b.x, my));
  else if (a.x >= b.x + b.w - EPS) out.push(measure(b.x + b.w, my, a.x, my));
  const mx = crossCenter(a.x, a.x + a.w, b.x, b.x + b.w);
  if (b.y >= a.y + a.h - EPS) out.push(measure(mx, a.y + a.h, mx, b.y));
  else if (a.y >= b.y + b.h - EPS) out.push(measure(mx, b.y + b.h, mx, a.y));
  return out;
}
