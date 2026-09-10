// 노드 편집 세션 — 히트 우선순위·드래그·연산·크롬(47 §3.2·§3.4·§3.5).
//
// **모드는 UI 스토어(`useImageEditorUi.mode`), 세션은 레이어다.** 정점 선택·드래그 base·펜
// 드래프트는 `AnnotationLayer` 안의 ref 로 살고 문서(`EditorDoc`)에는 아무것도 들어가지 않는다 —
// 넣으면 Ctrl+Z 가 편집 모드에서 튕겨 나온다(스냅샷이 UI 상태를 되돌린다). 이 파일은 그 ref 들이
// 쓰는 **순수 함수**만 담는다: 상태를 들지 않으니 포인터 이동마다 리렌더가 없고, 크롬은
// `ChromePrim` 배열로만 나간다(캔버스에 한 획도 그리지 않는다 — 43).
//
// 이 파일이 지키는 계약 셋:
// ① **집는 자리 = 보이는 자리.** `hitNodeEdit` 과 `nodeChrome` 이 같은 `handleRefs`·같은
//    `normalizeAuto` 좌표를 본다. 두 곳이 갈리면 "보이는 핸들을 잡아도 안 잡힌다"가 된다
//    (pointer.ts `handlePointsOf` 머리말과 같은 이유).
// ② **auto 정점의 핸들은 `normalizeAuto` 가 유일한 출구다.** 문서에는 (0,0) 이 그대로 있고
//    (path.ts:81-84), 렌더·히트·인스펙터가 전부 그 함수를 지난다. 문서에 물질화해 넣으면
//    렌더는 그 값을 읽지 않으면서(죽은 데이터) 정점 배열 참조만 갈려 평탄화 캐시가 편집
//    프레임마다 통째로 무효화된다.
// ③ **바뀐 것이 없으면 같은 참조.** `onPointerUp` 의 커밋 판정은 참조 비교이고(pointer.ts:960-962)
//    빈 커밋은 히스토리 200칸을 클릭으로 태운다. 길이 0 드래그·이미 그 모드인 정점·이미 닫힌
//    서브패스는 전부 입력을 그대로 돌려주거나 null 을 낸다.
//
// 좌표는 oriented px, 두께·반경만 css px(chrome.ts 규약).

import { CHROME_COLORS, type ChromePrim } from "../../../lib/annotate/chrome";
import type { SnapIndex } from "../../../lib/annotate/snap";
import type { ObjId, PathNode, PathVert, Rect } from "../../../lib/annotate/types";
import {
  deleteVerts,
  insertVert,
  moveHandle,
  moveVerts,
  reverseSub,
  segmentCount,
  setClosed,
  setVertMode,
  vertCount,
  vertModeUi,
  type NodeModeUi,
  type VertRef,
} from "../../../lib/annotate/vector/edit";
import {
  normalizeAuto,
  pathBounds,
  pathToSvgD,
  projectToPath,
  type SubPath,
} from "../../../lib/annotate/vector/path";
import { penDown, penDrag, penHover, penUp, type PenDraft } from "./pen";
// **타입만** 가져온다. `pointer.ts` 가 이 파일의 함수를 부르므로(진입 3줄) 값을 가져오면
// 런타임 순환이 생기고, 두 모듈 중 어느 쪽이 먼저 평가되는지가 번들러 순서에 달리게 된다.
import type { Point } from "./pointer";

/** 격리 스크림(시안 `Isolation Scrim` `#0B0B0DBF`). 편집 대상만 구멍으로 남는다. */
export const SCRIM = { color: "#0B0B0D", alpha: 0.75 } as const;
/** 앵커 정사각형 한 변(css px, 시안 `Anchor` 11×11). */
export const ANCHOR_CSS = 11;
/** 핸들 노브 지름(css px, 시안 `Handle`). */
export const KNOB_CSS = 11;

/** 핸들 유무 임계 — path.ts `HANDLE_EPS` 와 같은 값이어야 잡히는 핸들과 그려지는 핸들이 같다. */
const HANDLE_EPS = 1e-3;
/** 아트보드 라벨을 객체 위로 띄우는 거리(css px) — 뱃지 높이 16 + 여백 2. */
const LABEL_GAP_CSS = 18;

/** 시안 `Node Type` 라벨. `없음` 은 모드가 아니라 "양 핸들 (0,0)" 이다(37 은 4모드). */
export const NODE_MODE_LABELS: Record<NodeModeUi, string> = {
  none: "없음",
  corner: "코너",
  mirrored: "대칭",
  asymmetric: "비대칭",
  auto: "자동",
};

// ── 상태 ────────────────────────────────────────────────────────────────────

/**
 * 컨텍스트 바·인스펙터·상태바가 읽는 **요약**. 이것만 React state 로 올린다 —
 * 선택 배열·드래그 base 까지 state 로 들면 pointermove 마다 편집기 트리 전체가 다시 그려진다
 * (`useCropSession.ts:203-204` 가 그 갈림의 선례다).
 */
export interface NodeEditState {
  id: ObjId;
  nodeCount: number;
  segmentCount: number;
  selected: VertRef[];
  /** 선택이 없으면 null, 여럿이 서로 다르면 `'mixed'`. */
  mode: NodeModeUi | "mixed" | null;
  /** 단일 선택일 때의 정점 좌표(인스펙터 X/Y). */
  anchor: Point | null;
  /** 단일 선택의 핸들 — **`normalizeAuto` 를 지난 값**이라 auto 정점도 0 이 아니다. */
  handleIn: [number, number] | null;
  handleOut: [number, number] | null;
  /** 선택이 속한 서브패스(없으면 0번)가 열려 있는가 — `패스 닫기/열기` 버튼의 활성 근거. */
  open: boolean;
  draft: { verts: number } | null;
}

/** 컨텍스트 바 버튼 = 키 액션과 **같은 함수**를 부른다(§3.6). */
export type NodeOp =
  | "add"
  | "delete"
  | "close"
  | "open"
  | "reverse"
  | "select-all"
  | { nudge: [number, number] };

export type NodeHit =
  | { kind: "handle"; ref: VertRef; side: "in" | "out" }
  | { kind: "vert"; ref: VertRef }
  | { kind: "seg"; sub: number; seg: number; t: number }
  | null;

/**
 * 노드 편집이 `pointer.ts` 의 `DragState` 에 얹는 3종. **항상 `base`(pointerdown 시점 노드)에서
 * 다시 계산한다** — 델타를 누적하면 스냅이 걸릴 때마다 어긋남이 쌓인다(pointer.ts move/resize 와
 * 같은 틀).
 */
export type NodeDrag =
  | {
      mode: "vert";
      start: Point;
      /** 집은 정점. 스냅은 **이 점**을 기준으로 건다(여럿을 끌어도 붙는 곳은 하나여야 한다). */
      grab: VertRef;
      refs: VertRef[];
      base: PathNode;
      snap?: SnapIndex;
    }
  | { mode: "handle"; start: Point; ref: VertRef; side: "in" | "out"; base: PathNode }
  /** 노드 마퀴. `keep` 은 드래그 시작 시점 선택(Shift 누적 기준) — pointer.ts `marquee` 관례. */
  | { mode: "vmarquee"; start: Point; cur: Point; keep: VertRef[] };

// ── 히트 ────────────────────────────────────────────────────────────────────

/**
 * 핸들 노브를 그리고·잡는 정점: **선택 정점과 그 양옆 이웃**(시안 ③).
 *
 * 전부 그리면 정점 수백 개짜리 패스에서 노브가 앵커를 덮어 아무것도 안 보인다. 이 함수 하나를
 * 히트와 크롬이 같이 쓰는 것이 계약 ① 이다.
 */
export function handleRefs(o: PathNode, sel: readonly VertRef[]): VertRef[] {
  const out: VertRef[] = [];
  const seen = new Set<string>();
  const push = (sub: number, vert: number) => {
    const k = key(sub, vert);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ sub, vert });
  };
  for (const r of sel) {
    const s = o.subpaths[r.sub];
    if (!s) continue;
    const n = s.verts.length;
    if (r.vert < 0 || r.vert >= n) continue;
    push(r.sub, r.vert);
    // 닫힌 서브패스는 양끝이 이웃이다 — 안 감으면 첫/끝 정점의 핸들만 조작 불가가 된다.
    if (r.vert > 0) push(r.sub, r.vert - 1);
    else if (s.closed && n > 1) push(r.sub, n - 1);
    if (r.vert < n - 1) push(r.sub, r.vert + 1);
    else if (s.closed && n > 1) push(r.sub, 0);
  }
  return out;
}

/**
 * 포인터 아래의 것 하나(§3.4). 우선순위 **핸들 → 앵커 → 세그먼트**.
 *
 * 핸들이 앵커보다 먼저인 이유: 짧은 핸들은 앵커 위에 겹친다. 앵커가 먼저 이기면 그 정점의
 * 핸들은 영원히 못 잡는다(e2e (o) 회귀 단언).
 */
export function hitNodeEdit(
  o: PathNode,
  sel: readonly VertRef[],
  pt: Point,
  tol: number,
): NodeHit {
  let best: NodeHit = null;
  let bestD = Infinity;
  for (const ref of handleRefs(o, sel)) {
    for (const side of ["in", "out"] as const) {
      const h = handlePoint(o, ref, side);
      if (!h) continue;
      const d = Math.hypot(h.x - pt.x, h.y - pt.y);
      if (d <= tol && d < bestD) {
        bestD = d;
        best = { kind: "handle", ref, side };
      }
    }
  }
  if (best) return best;

  // 앵커는 정사각형이라 판정도 사각형이다 — 원으로 재면 모서리를 눌렀을 때 안 잡힌다.
  for (let s = 0; s < o.subpaths.length; s++) {
    const verts = o.subpaths[s].verts;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (Math.abs(v.x - pt.x) > tol || Math.abs(v.y - pt.y) > tol) continue;
      const d = Math.hypot(v.x - pt.x, v.y - pt.y);
      if (d < bestD) {
        bestD = d;
        best = { kind: "vert", ref: { sub: s, vert: i } };
      }
    }
  }
  if (best) return best;

  // 세그먼트: 46 이 판정과 투영(seg,t)을 한 번에 준다 — 삽입 미리보기와 실제 삽입 위치가
  // 같은 식에서 나오는 근거다(path.ts:470-476).
  const h = projectToPath(o, pt);
  if (h && h.dist <= Math.max(o.strokeWidth / 2, tol)) {
    return { kind: "seg", sub: h.sub, seg: h.seg, t: h.t };
  }
  return null;
}

/** 마퀴 안에 든 정점 전부(닿으면 선택 — pointer.ts 마퀴와 같은 규칙). */
export function vertsInRect(o: PathNode, r: Rect): VertRef[] {
  const out: VertRef[] = [];
  for (let s = 0; s < o.subpaths.length; s++) {
    const verts = o.subpaths[s].verts;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      if (v.x >= r.x && v.x <= r.x + r.w && v.y >= r.y && v.y <= r.y + r.h) {
        out.push({ sub: s, vert: i });
      }
    }
  }
  return out;
}

/** Shift 누적 토글. 이미 있으면 빼고, 없으면 더한다. */
export function toggleRef(sel: readonly VertRef[], ref: VertRef): VertRef[] {
  const had = sel.some((r) => r.sub === ref.sub && r.vert === ref.vert);
  return had ? sel.filter((r) => !(r.sub === ref.sub && r.vert === ref.vert)) : [...sel, ref];
}

/**
 * 문서 undo·삭제로 정점이 줄면 범위 밖 선택을 걷는다(§3.4 끝).
 *
 * 걷을 것이 없으면 **입력 그대로** 돌려준다 — 매 프레임 새 배열을 만들면 이 값을 의존성에 둔
 * 컨텍스트 바가 프레임마다 다시 그려진다.
 */
export function clampSel(o: PathNode, sel: readonly VertRef[]): readonly VertRef[] {
  const ok = sel.filter((r) => {
    const s = o.subpaths[r.sub];
    return !!s && r.vert >= 0 && r.vert < s.verts.length;
  });
  return ok.length === sel.length ? sel : ok;
}

// ── 드래그 ──────────────────────────────────────────────────────────────────

/**
 * 드래그 한 틱을 `base` 에서 다시 계산한다. 결과는 라이브 객체(`liveRef`)로만 그리고,
 * 커밋은 pointerup 에서 **한 번**이다(= 히스토리 한 칸).
 *
 * `snapAt` 은 호출자가 만든다(스냅 인덱스·토글은 스토어에 있다). 정점 드래그는 오브젝트/가이드/
 * 픽셀 스냅 전부, **핸들 드래그는 픽셀 스냅만** 넘긴다(§3.4) — 핸들이 남의 모서리에 붙으면
 * 곡선이 제멋대로 튄다.
 *
 * 길이 0(=클릭)이면 `d.base` 를 **그대로** 돌려준다. pointer.ts 의 move/resize 와 같은 가드이고
 * 같은 이유다: `moveVerts` 는 dx=dy=0 에서도 새 객체를 만들 수 있어 참조 비교가 true 로 서고,
 * 선택하려고 누른 정점이 스냅 델타만큼 튀면서 빈 히스토리 칸까지 남는다. 임계를 0 초과로 두면
 * 안 된다 — 고배율에서 0.5 oriented px 는 화면 수 px 라 진짜 드래그를 먹는다.
 */
export function applyNodeDrag(
  d: NodeDrag,
  pt: Point,
  mods: { shift: boolean; alt: boolean },
  snapAt: (p: Point) => Point,
): PathNode | null {
  if (d.mode === "vmarquee") {
    d.cur = pt;
    return null;
  }
  if (pt.x === d.start.x && pt.y === d.start.y) return d.base;
  if (d.mode === "handle") {
    return moveHandle(d.base, d.ref, d.side, snapAt(pt), { alt: mods.alt });
  }
  const v = vertAt(d.base, d.grab);
  let dx = pt.x - d.start.x;
  let dy = pt.y - d.start.y;
  if (v) {
    const q = snapAt({ x: v.x + dx, y: v.y + dy });
    dx = q.x - v.x;
    dy = q.y - v.y;
  }
  return moveVerts(d.base, d.refs, dx, dy);
}

// ── 연산 ────────────────────────────────────────────────────────────────────

/**
 * 버튼·키 하나의 결과. `null` 이면 **아무 일도 없다**(비활성 버튼) — 커밋하지 않는다.
 *
 * `obj === 입력 o` 면 문서가 안 바뀐 것이라 호출자는 선택만 갱신한다(`select-all`).
 * `obj === null` 은 정점이 하나도 안 남았다는 뜻 — 호출자가 **객체 삭제**를 커밋한다.
 */
export interface NodeOpResult {
  obj: PathNode | null;
  sel: readonly VertRef[];
  label: string;
}

export function applyNodeOp(
  o: PathNode,
  sel: readonly VertRef[],
  op: NodeOp,
): NodeOpResult | null {
  if (typeof op === "object") {
    if (!sel.length) return null;
    const next = moveVerts(o, sel, op.nudge[0], op.nudge[1]);
    return next === o ? null : { obj: next, sel, label: "노드 이동" };
  }
  switch (op) {
    case "select-all":
      return { obj: o, sel: allRefs(o), label: "" };
    case "delete": {
      if (!sel.length) return null;
      const next = deleteVerts(o, sel);
      // `deleteVerts` 는 지울 것이 하나도 없으면 원본을 돌려준다 — 그걸 커밋하면 빈 칸이다.
      return next === o ? null : { obj: next, sel: [], label: "노드 삭제" };
    }
    case "add": {
      // `노드 추가` = 인접한 선택 정점 두 개 사이 t=.5 삽입(세그먼트 클릭 삽입의 버튼판).
      // 인접 쌍이 없으면 어디에 넣을지 정의되지 않는다 — 그때는 비활성이다.
      const seg = adjacentSeg(o, sel);
      if (!seg) return null;
      const r = insertVert(o, seg.sub, seg.seg, 0.5);
      return r ? { obj: r.obj, sel: [r.ref], label: "노드 추가" } : null;
    }
    case "close":
    case "open": {
      const sub = subOfSel(o, sel);
      const s = o.subpaths[sub];
      const want = op === "close";
      // 이미 그 상태면 커밋하지 않는다 — 빈 칸이 생기면 Ctrl+Z 가 아무 일도 안 하는 것처럼 보인다.
      if (!s || s.closed === want) return null;
      return { obj: setClosed(o, sub, want), sel, label: want ? "패스 닫기" : "패스 열기" };
    }
    case "reverse": {
      const sub = subOfSel(o, sel);
      const next = reverseSub(o, sub);
      if (next === o) return null;
      // 선택을 같은 **정점**에 다시 건다. `reverseSub` 는 열린 서브패스를 통째로 뒤집고
      // (i → n−1−i), 닫힌 것은 첫 정점을 제자리에 둔 채 나머지만 뒤집는다(i → (n−i)%n).
      // 인덱스를 그대로 두면 반전 한 번에 선택 하이라이트가 엉뚱한 정점으로 옮겨간다.
      const cur = o.subpaths[sub];
      const n = cur.verts.length;
      const back = sel.map((r) =>
        r.sub !== sub ? r : { sub, vert: cur.closed ? (n - r.vert) % n : n - 1 - r.vert },
      );
      return { obj: next, sel: back, label: "방향 반전" };
    }
  }
}

/**
 * 세그먼트 클릭 삽입(§3.4 3번, 도구 `vpen`). `hitNodeEdit` 의 `seg` 히트를 그대로 넘긴다 —
 * 히스토리 라벨을 여기 한 곳에 모아 두려고 `insertVert` 를 직접 부르지 않는다.
 */
export function insertAtSeg(
  o: PathNode,
  sub: number,
  seg: number,
  t: number,
): NodeOpResult | null {
  const r = insertVert(o, sub, seg, t);
  return r ? { obj: r.obj, sel: [r.ref], label: "노드 추가" } : null;
}

/** 5모드 버튼·인스펙터(§3.3). 이미 그 모드면 `null` — 같은 값 커밋은 빈 히스토리 칸이다. */
export function applyNodeMode(
  o: PathNode,
  sel: readonly VertRef[],
  m: NodeModeUi,
): { obj: PathNode; label: string } | null {
  if (!sel.length) return null;
  const next = setVertMode(o, sel, m);
  return next === o ? null : { obj: next, label: `노드 모드 ${NODE_MODE_LABELS[m]}` };
}

/**
 * Ctrl+클릭 / 더블클릭 정점 = 코너 ↔ 대칭 토글(§3.6).
 *
 * 디자인 모드의 Ctrl+클릭(리프 관통 선택)과는 모드가 달라 충돌하지 않는다.
 */
export function toggleVertMode(o: PathNode, ref: VertRef): { obj: PathNode; label: string } | null {
  const v = vertAt(o, ref);
  if (!v) return null;
  return applyNodeMode(o, [ref], vertModeUi(v) === "mirrored" ? "corner" : "mirrored");
}

// ── 요약 ────────────────────────────────────────────────────────────────────

export function nodeEditState(
  o: PathNode,
  sel: readonly VertRef[],
  draft: PenDraft | null,
): NodeEditState {
  const selected = sel as VertRef[];
  const one = selected.length === 1 ? vertAt(o, selected[0]) : null;
  // 핸들 표시는 **정규화된 값**이다 — auto 정점은 문서에 (0,0) 이 들어 있어서, 문서를 그대로
  // 읽으면 인스펙터가 "핸들 없음"이라고 말하는데 화면에는 곡선이 그려진다.
  const oneNorm = selected.length === 1 ? normVertAt(o, selected[0]) : null;
  return {
    id: o.id,
    nodeCount: vertCount(o),
    segmentCount: segmentCount(o),
    selected,
    mode: selMode(o, selected),
    anchor: one ? { x: one.x, y: one.y } : null,
    handleIn: oneNorm ? [oneNorm.inX, oneNorm.inY] : null,
    handleOut: oneNorm ? [oneNorm.outX, oneNorm.outY] : null,
    open: !(o.subpaths[subOfSel(o, selected)]?.closed ?? false),
    draft: draft ? { verts: draft.verts.length } : null,
  };
}

/** 상태바 요약(시안 `노드 1개 선택 · 대칭 핸들`). 42 상태바 힌트 슬롯이 부른다. */
export function nodeStatusText(s: NodeEditState): string {
  if (s.draft) return `펜 · 정점 ${s.draft.verts}`;
  if (!s.selected.length) return `노드 ${s.nodeCount} · 세그먼트 ${s.segmentCount}`;
  return `노드 ${s.selected.length}개 선택 · ${handleLabel(s.mode)}`;
}

/** 캔버스 HUD(시안 `Node Info`). */
export function nodeHudText(s: NodeEditState): string {
  const head = `노드 ${s.nodeCount} · 세그먼트 ${s.segmentCount} · 선택 ${s.selected.length}`;
  return s.selected.length ? `${head} · ${handleLabel(s.mode)}` : head;
}

// ── 크롬 ────────────────────────────────────────────────────────────────────

/**
 * 노드 편집 크롬 전부(§3.5 표). **캔버스에 그리지 않는다** — 확대하면 디테일 캔버스(40)가
 * 위를 덮어, 노드를 편집하려고 확대한 바로 그 순간 크롬이 사라진다(43 §3.1).
 *
 * 반환값은 `ChromeState.extra` 에 **덧붙인다**. 덮으면 픽셀 스냅 셀·Alt 측정선·45 그라디언트
 * 핸들이 노드 편집 중에 통째로 사라진다(AnnotationLayer:817-838, ImageEditor:737).
 *
 * css px 크기는 매 프레임 `/ view.scale` 로 환산한다. `rect` 의 w/h 는 oriented px 라
 * (chrome.ts:70-72) 11 을 그대로 넣으면 확대할수록 앵커가 커진다 — 캔버스 크롬을 버린 그 증상이다.
 */
export function nodeChrome(
  o: PathNode,
  st: NodeEditState,
  view: { scale: number },
  opts?: { label?: string | null },
): ChromePrim[] {
  const out: ChromePrim[] = [];
  const scale = Math.max(view.scale, 1e-6);
  const d = pathToSvgD(o.subpaths);
  // 스크림 구멍은 **객체가 실제로 칠하는 자리**만 뚫는다 — 안쪽은 [1]/[2] 의 진짜 렌더가
  // 보이고 바깥만 어두워진다. 구멍 두께를 선 두께로 주지 않으면 가는 선이 스크림에 먹혀 사라진다.
  // 효과(그림자·블러)는 구멍 밖이라 함께 어두워진다(설계 §3.5 문서화).
  out.push({
    k: "scrim",
    color: SCRIM.color,
    alpha: SCRIM.alpha,
    cutoutD: cutoutOf(o, d),
    cutoutStrokeCss: o.strokeWidth * scale,
  });
  // 골격선 — 구멍 경계에 얹는 안내선(시안 `Vector Path`).
  if (d) out.push({ k: "path", d, color: CHROME_COLORS.sel });

  const box = pathBounds(o);
  if (opts?.label) {
    out.push({ k: "text", x: box.x, y: box.y - LABEL_GAP_CSS / scale, text: opts.label });
  }

  // ponytail: 정점 전부를 매 프레임 낸다. 2,000 개를 넘으면 뷰포트 밖 앵커를 걸러야 한다
  //           (오버레이가 그만큼 SVG 노드를 들고 있게 된다). 지금 소스는 펜과 프리셋 도형뿐이라
  //           수십 개다.
  const a = ANCHOR_CSS / scale;
  const selSet = new Set(st.selected.map((r) => key(r.sub, r.vert)));
  for (let s = 0; s < o.subpaths.length; s++) {
    const verts = o.subpaths[s].verts;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      out.push({
        k: "rect",
        x: v.x - a / 2,
        y: v.y - a / 2,
        w: a,
        h: a,
        color: CHROME_COLORS.sel,
        // 선택은 채움, 아니면 흰 속 — 비워 두면 스크림 위에서 테두리만 보여 눈에 안 띈다.
        fill: selSet.has(key(s, i)) ? CHROME_COLORS.sel : "#FFFFFF",
      });
    }
  }

  for (const ref of handleRefs(o, st.selected)) {
    const anchor = vertAt(o, ref);
    if (!anchor) continue;
    for (const side of ["in", "out"] as const) {
      const h = handlePoint(o, ref, side);
      if (!h) continue;
      out.push({ k: "line", x1: anchor.x, y1: anchor.y, x2: h.x, y2: h.y, color: CHROME_COLORS.sel });
      out.push({
        k: "circle",
        cx: h.x,
        cy: h.y,
        rCss: KNOB_CSS / 2,
        color: CHROME_COLORS.sel,
        fill: "#FFFFFF",
      });
    }
  }

  // HUD 는 AABB 오른쪽 아래. 뱃지는 x 가 가로 중앙이라(ChromeOverlay `badge`) 상자 오른쪽
  // 모서리에 걸치는데, 그래야 선택 크기 뱃지(상자 아래 **중앙**)와 겹치지 않는다.
  out.push({ k: "text", x: box.x + box.w, y: box.y + box.h, text: nodeHudText(st) });
  return out;
}

// ── 포인터 제스처(§3.4) ──────────────────────────────────────────────────────
//
// `pointer.ts` 에는 **진입만** 들어가고 본체는 여기다(설계 §3.4 "진입 3줄"). 48(크롭)과 같은
// 파일을 만지는 면적을 줄이려는 것이고, 덕분에 히트 우선순위·커밋 라벨·선택 규칙이 크롬을
// 만드는 코드와 **한 파일**에 남는다(계약 ①).

/** 수식키 — 이벤트를 보는 쪽(pointer.ts)이 읽어 넘긴다. */
export interface NodeMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * 세션·문서 쪽 통로. `AnnotationLayer` 가 만든다 — 선택 정점·펜 드래프트 ref 의 주인이
 * 그쪽이고, 커밋 1회·요약 방출·모드 진입도 전부 거기 한 곳에 모여 있다.
 */
export interface NodeGestureCtx {
  /** 지금 노드 편집 중인 패스. 모드와 문서가 **둘 다** 맞을 때만 값이다. */
  edited(): PathNode | null;
  sel(): readonly VertRef[];
  setSel(refs: readonly VertRef[]): void;
  pen(): PenDraft | null;
  setPen(d: PenDraft | null): void;
  /** 드래그 미리보기(문서 밖). null 이면 커밋된 객체가 그대로 그려진다. */
  setLive(o: PathNode | null): void;
  /** 편집 대상을 갈아 끼우고 **커밋 1회**. `next === cur` 면 커밋하지 않는다(빈 히스토리 칸 금지). */
  commit(cur: PathNode, next: PathNode | null, label: string, sel: readonly VertRef[]): void;
  /** 펜 완료 — 커밋 1회 + (새 객체면) 노드 편집 진입. 드래프트가 있었으면 true. */
  finishPen(closed: boolean): boolean;
  enter(id: ObjId): boolean;
  schedule(): void;
}

/**
 * 화면·스냅 쪽 통로. `pointer.ts` 가 만든다 — 배율·토글·스냅 인덱스는 그쪽이 안다.
 * 이 파일이 스토어를 직접 읽지 않는 이유이기도 하다(순수 함수만 담는다는 머리말).
 */
export interface NodeGestureEnv {
  /** 도구가 `vpen` 인가 — 세그먼트 클릭 삽입·빈 곳 드래프트가 여기서 갈린다. */
  pen(): boolean;
  /** 곡률 토글(§3.1) — 켜져 있으면 펜 클릭이 `auto` 정점을 만든다. */
  curvature(): boolean;
  /** 히트 허용오차(oriented px) = `HANDLE_GRAB_CSS / displayScale`. */
  tol(): number;
  /** 정점 드래그용 스냅 인덱스(드래그 시작에 한 번). 스냅이 꺼져 있으면 undefined. */
  makeSnap(exclude: ObjId): SnapIndex | undefined;
  snapAt(idx: SnapIndex | undefined, pt: Point): Point;
  /** 핸들 드래그는 **픽셀 스냅만**(§3.4) — 남의 모서리에 붙으면 곡선이 제멋대로 튄다. */
  snapPixel(pt: Point): Point;
}

/**
 * `onDown` 의 결과. `null` = 이 다운은 노드 편집·펜의 것이 아니다(디자인 경로가 그대로 돈다).
 * `{}` = 소비했고 드래그는 없다. `{ drag }` = 소비했고 이 제스처를 세운다.
 */
export type NodeDownResult = { drag?: NodeDrag } | null;

/** 노드 마퀴로 인정할 최소 크기(oriented px) — `pointer.ts` 의 `MIN_DRAG` 와 같은 값·같은 이유. */
const MARQUEE_MIN = 3;

export function createNodeGestures(c: NodeGestureCtx, env: NodeGestureEnv) {
  /**
   * 이 드래그가 마지막으로 만든 노드. `onUp` 이 커밋할 값이다.
   *
   * `liveRef` 를 되읽지 않는 이유: up 은 `setLive(null)` 로 미리보기를 걷어야 하는데, 걷은 뒤에
   * 값을 찾으면 이미 없다. 그렇다고 걷기 전에 커밋하면 커밋 → 리렌더 사이에 미리보기가
   * 남아 한 프레임 두 겹으로 그려진다.
   */
  let live: PathNode | null = null;

  const startPen = (
    d: PenDraft | null,
    pt: Point,
    mods: NodeMods,
    target?: PenDraft["target"],
  ): NodeDownResult => {
    const r = penDown(d, pt, mods, {
      curvature: env.curvature(),
      tol: env.tol(),
      target,
    });
    c.setPen(r.draft);
    // 첫 정점 위 클릭 = **닫으면서 완료**(§3.1 표) — 커밋 1회 뒤 곧바로 노드 편집이다.
    if (r.close) c.finishPen(true);
    c.schedule();
    return {};
  };

  const onDown = (pt: Point, mods: NodeMods): NodeDownResult => {
    // 드래프트가 진행 중이면 무엇 위를 눌렀든 펜이 받는다 — 그리는 중에 정점이 집히면
    // 선이 거기서 끊기고, 사용자에게는 "가끔 점이 안 찍힌다"로 보인다.
    const draft = c.pen();
    if (draft) return startPen(draft, pt, mods);

    const o = c.edited();
    const isPen = env.pen();
    if (!o) return isPen ? startPen(null, pt, mods, { kind: "new" }) : null;

    const sel = c.sel();
    const hit = hitNodeEdit(o, sel, pt, env.tol());

    if (hit?.kind === "handle") {
      // 선택은 그대로 둔다 — 핸들은 선택 정점과 그 이웃에만 그려지므로(handleRefs) 잡은
      // 순간 선택을 옮기면 방금 잡은 노브가 화면에서 사라진다.
      c.setLive(o);
      return { drag: { mode: "handle", start: pt, ref: hit.ref, side: hit.side, base: o } };
    }

    if (hit?.kind === "vert") {
      // Ctrl+클릭 = 코너 ↔ 대칭 토글(§3.6). 커밋 1회이고 드래그는 세우지 않는다 —
      // 디자인 모드의 Ctrl+클릭(리프 관통 선택)과는 모드가 달라 충돌하지 않는다.
      if (mods.ctrl) {
        const r = toggleVertMode(o, hit.ref);
        if (r) c.commit(o, r.obj, r.label, sel);
        else c.schedule();
        return {};
      }
      if (mods.shift) {
        // 누적 토글은 드래그를 세우지 않는다 — 방금 선택에서 뺀 정점이 그대로 딸려 움직인다.
        c.setSel(toggleRef(sel, hit.ref));
        c.schedule();
        return {};
      }
      // 이미 고른 정점을 다시 누르면 **선택 전체**를 끈다(pointer.ts 의 객체 이동과 같은 규칙) —
      // 여럿을 골라 놓고 그중 하나를 잡을 때마다 선택이 하나로 줄면 다중 이동이 불가능해진다.
      const inSel = sel.some((r) => r.sub === hit.ref.sub && r.vert === hit.ref.vert);
      const next = inSel ? [...sel] : [hit.ref];
      c.setSel(next);
      c.setLive(o);
      return {
        drag: {
          mode: "vert",
          start: pt,
          grab: hit.ref,
          refs: next,
          base: o,
          snap: env.makeSnap(o.id),
        },
      };
    }

    if (hit?.kind === "seg") {
      if (isPen) {
        // 세그먼트 위 펜 클릭 = 정점 삽입(§3.4 3번) — 커밋 1회, 새 정점이 곧 선택이다.
        const r = insertAtSeg(o, hit.sub, hit.seg, hit.t);
        if (r) c.commit(o, r.obj, r.label, r.sel);
        else c.schedule();
        return {};
      }
      // 선택 도구는 양 끝 정점을 고르고 그 둘을 끈다(세그먼트를 굽히는 것은 시안 밖 — §3.7).
      const n = o.subpaths[hit.sub].verts.length;
      const ends: VertRef[] = [
        { sub: hit.sub, vert: hit.seg },
        { sub: hit.sub, vert: (hit.seg + 1) % n },
      ];
      c.setSel(ends);
      c.setLive(o);
      return {
        drag: { mode: "vert", start: pt, grab: ends[0], refs: ends, base: o, snap: env.makeSnap(o.id) },
      };
    }

    // 빈 곳. `vpen` 이면 같은 객체에 서브패스를 하나 더 얹고(46 짝수-홀수 구멍), 아니면
    // **노드 마퀴**다. 다른 객체는 집히지 않는다(격리) — 스크림 뒤의 도형이 선택되면
    // 편집하던 패스는 화면에 남은 채 조작만 딴 데로 옮겨간다.
    if (isPen) return startPen(null, pt, mods, { kind: "append", id: o.id });
    const keep = mods.shift ? [...sel] : [];
    if (!mods.shift && sel.length) c.setSel([]);
    return { drag: { mode: "vmarquee", start: pt, cur: pt, keep } };
  };

  /**
   * 드래그가 없을 때의 이동. 펜 러버밴드·커서 힌트가 커서를 따라야 한다.
   * @returns 소비했으면 true — 디자인 호버(객체 하이라이트·리사이즈 커서)는 이 화면에서 뜻이 없다.
   */
  const onHover = (pt: Point, mods: NodeMods): boolean => {
    const d = c.pen();
    if (d) {
      c.setPen(d.dragging ? penDrag(d, pt, mods) : penHover(d, pt));
      c.schedule();
      return true;
    }
    // 드래프트가 없어도 펜 도구면 힌트 뱃지가 커서를 따라간다(penPreview) — 호출자가 마지막
    // 포인터 위치를 갱신하고 다시 그린다.
    return env.pen();
  };

  const onDrag = (d: NodeDrag, pt: Point, mods: NodeMods): void => {
    // Alt 는 "정확히 여기에 놓겠다"라 스냅을 끈다(applyDragAt 와 같은 규칙). 핸들 드래그의
    // Alt 는 Figma 의 break 라 스냅 이야기가 아니고, 애초에 픽셀 스냅만 받는다.
    const idx = d.mode === "vert" && !mods.alt ? d.snap : undefined;
    const snap = d.mode === "handle" ? env.snapPixel : (q: Point) => env.snapAt(idx, q);
    const next = applyNodeDrag(d, pt, mods, snap);
    if (next) {
      live = next;
      c.setLive(next);
    }
  };

  const onUp = (d: NodeDrag): void => {
    const next = live;
    live = null;
    c.setLive(null);
    if (d.mode === "vmarquee") {
      const box: Rect = {
        x: Math.min(d.start.x, d.cur.x),
        y: Math.min(d.start.y, d.cur.y),
        w: Math.abs(d.cur.x - d.start.x),
        h: Math.abs(d.cur.y - d.start.y),
      };
      const o = c.edited();
      // 3px 미만은 클릭 오조작이다 — 선택 해제는 이미 다운에서 했다(pointer.ts 마퀴와 같은 규칙).
      if (o && (box.w >= MARQUEE_MIN || box.h >= MARQUEE_MIN)) {
        const merged = [...d.keep];
        for (const r of vertsInRect(o, box)) {
          if (!merged.some((q) => q.sub === r.sub && q.vert === r.vert)) merged.push(r);
        }
        c.setSel(merged);
      }
      c.schedule();
      return;
    }
    // `next === d.base` 면 길이 0 드래그(= 클릭)라 커밋이 없다 — `commit` 이 참조로 판정한다.
    if (next) c.commit(d.base, next, d.mode === "handle" ? "핸들 조정" : "노드 이동", c.sel());
    else c.schedule();
  };

  /**
   * 더블클릭. 펜 드래프트 완료(§3.1 표) → 편집 중이면 정점 모드 토글(§3.6) 순이다.
   * @returns 소비했으면 true — false 일 때만 호출자가 `path` 더블클릭 진입을 본다.
   */
  const onDouble = (pt: Point): boolean => {
    if (c.pen()) {
      c.finishPen(false);
      return true;
    }
    const o = c.edited();
    if (!o) return false;
    const hit = hitNodeEdit(o, c.sel(), pt, env.tol());
    if (hit?.kind === "vert") {
      const r = toggleVertMode(o, hit.ref);
      if (r) c.commit(o, r.obj, r.label, c.sel());
    }
    // 편집 중에는 언제나 소비한다 — 여기서 흘려보내면 편집 대상 위의 더블클릭이 '진입'으로
    // 돌아가 아무 일도 일어나지 않는 제스처가 된다.
    return true;
  };

  /**
   * 버튼을 뗐다. **드래그가 없어도 반드시 불러야 한다** — 펜 드래프트는 `dragRef` 에 실리지
   * 않으므로(버튼을 떼도 살아 있다) 여기서 안 알리면 `dragging` 이 선 채로 남고, 이후 모든
   * 호버가 마지막 정점의 핸들을 계속 끌어 커서를 따라 곡선이 휜다.
   */
  const onRelease = (): void => {
    const d = c.pen();
    if (d?.dragging) c.setPen(penUp(d));
  };

  /** `path` 더블클릭 진입(§3.2). 히트는 호출자가 이미 했다 — 여기서는 모드만 연다. */
  const enter = (id: ObjId): boolean => c.enter(id);

  return { onDown, onHover, onDrag, onUp, onRelease, onDouble, enter };
}

/** `DragState` 에서 노드 편집 제스처를 가려낸다 — 세 mode 문자열이 이 파일 소유라는 표시다. */
export function isNodeDrag(d: { mode: string }): d is NodeDrag {
  return d.mode === "vert" || d.mode === "handle" || d.mode === "vmarquee";
}

// ── 내부 ────────────────────────────────────────────────────────────────────

/**
 * 스크림 구멍의 `d`.
 *
 * 오버레이는 이 패스를 **채우면서 동시에 긋는다**(`ChromeOverlay.drawExtra` 의 마스크 path 는
 * `fill: DIM` + `stroke: DIM` 이 붙박이다). 그래서 채우기가 없는 객체의 `d` 를 그대로 넘기면
 * SVG 가 서브패스를 암묵적으로 닫아 채워, 지시선 세 점이 감싸는 **삼각형 면적 전체**가
 * 스크림에서 파여 밝게 남는다 — "편집 대상만 남기고 나머지를 어둡게"가 통째로 뒤집힌다.
 * 펜 산출물은 `fills: []` 라(pen.ts `penFinish`) 예외가 아니라 기본 경로다.
 *
 * 그래서 채우기가 없으면 같은 패스를 **감김 반대 방향으로 한 번 더** 붙인다: 면적의 감김수가
 * +1 −1 = 0 이라 nonzero·evenodd 어느 쪽에서도 채워지지 않고, stroke 는 같은 자리에 두 번
 * 그려질 뿐이라(마스크는 단색이다) 그림이 같다. 채우기가 있는 객체는 그 면적이 실제로 칠해진
 * 곳이므로 그대로 뚫는다 — 캔버스 `fill()` 도 열린 서브패스를 같은 방식으로 닫아 칠한다.
 *
 * ponytail: `ChromePrim.scrim` 이 `cutoutFill`(+`cutoutFillRule`) 한 칸을 갖게 되면 이 우회는
 *           통째로 사라진다. 그 타입과 오버레이는 43 소유라 이 태스크에서 넓히지 않았다 —
 *           같은 이유로 `fillRule:'evenodd'` 인 채우기 객체의 구멍은 여전히 nonzero 로 판정된다.
 */
function cutoutOf(o: PathNode, d: string): string {
  if (!d || o.fills.some((f) => f.visible)) return d;
  const back = pathToSvgD(o.subpaths.map(windReverse));
  return back ? `${d} ${back}` : d;
}

/**
 * 감김을 뒤집은 사본 — 정점 순서를 통째로 뒤집고 in/out 을 맞바꾼다. 곡선 자체는 한 점도
 * 안 움직이고 진행 방향만 반대가 된다.
 *
 * `edit.ts` 의 `reverseSub` 를 쓰지 않는 이유: 그쪽은 **닫힌 서브패스의 첫 정점을 제자리에
 * 두므로**(선택 인덱스가 밀리지 않게) 정점이 2개인 닫힌 서브패스에서 진행 방향이 그대로다 —
 * 여기서는 감김이 뒤집히지 않으면 면적이 상쇄되지 않고 오히려 두 겹으로 칠해진다.
 */
function windReverse(sub: SubPath): SubPath {
  const v = sub.verts;
  return {
    verts: v.map((_, i) => {
      const w = v[v.length - 1 - i];
      return { ...w, inX: w.outX, inY: w.outY, outX: w.inX, outY: w.inY };
    }),
    closed: sub.closed,
  };
}

const key = (sub: number, vert: number) => `${sub}:${vert}`;

function vertAt(o: PathNode, r: VertRef): PathVert | null {
  return o.subpaths[r.sub]?.verts[r.vert] ?? null;
}

/** auto 핸들이 물질화된 정점(계약 ②). 그리기·히트·인스펙터가 전부 이 값을 본다. */
function normVertAt(o: PathNode, r: VertRef): PathVert | null {
  const s = o.subpaths[r.sub];
  return s ? (normalizeAuto(s).verts[r.vert] ?? null) : null;
}

/** 핸들 노브의 절대 좌표. 핸들이 없으면(길이 0) null — 없는 손잡이를 그리지도 잡지도 않는다. */
function handlePoint(o: PathNode, r: VertRef, side: "in" | "out"): Point | null {
  const v = normVertAt(o, r);
  if (!v) return null;
  const hx = side === "in" ? v.inX : v.outX;
  const hy = side === "in" ? v.inY : v.outY;
  if (Math.abs(hx) < HANDLE_EPS && Math.abs(hy) < HANDLE_EPS) return null;
  return { x: v.x + hx, y: v.y + hy };
}

function allRefs(o: PathNode): VertRef[] {
  const out: VertRef[] = [];
  for (let s = 0; s < o.subpaths.length; s++) {
    for (let i = 0; i < o.subpaths[s].verts.length; i++) out.push({ sub: s, vert: i });
  }
  return out;
}

/** 선택이 걸린 서브패스(없으면 0번) — 닫기/열기/반전이 대상을 정하는 규칙. */
function subOfSel(o: PathNode, sel: readonly VertRef[]): number {
  const s = sel.length ? sel[0].sub : 0;
  return s >= 0 && s < o.subpaths.length ? s : 0;
}

/** 선택 정점 두 개가 한 서브패스에서 이웃인가 — 맞으면 그 사이 세그먼트. */
function adjacentSeg(
  o: PathNode,
  sel: readonly VertRef[],
): { sub: number; seg: number } | null {
  if (sel.length !== 2 || sel[0].sub !== sel[1].sub) return null;
  const s = o.subpaths[sel[0].sub];
  if (!s) return null;
  const n = s.verts.length;
  const a = Math.min(sel[0].vert, sel[1].vert);
  const b = Math.max(sel[0].vert, sel[1].vert);
  if (b - a === 1) return { sub: sel[0].sub, seg: a };
  // 닫힌 서브패스의 마지막 정점과 첫 정점도 이웃이다(그 구간이 seg = n-1).
  if (s.closed && a === 0 && b === n - 1 && n > 2) return { sub: sel[0].sub, seg: n - 1 };
  return null;
}

function selMode(o: PathNode, sel: readonly VertRef[]): NodeModeUi | "mixed" | null {
  let m: NodeModeUi | null = null;
  for (const r of sel) {
    const v = vertAt(o, r);
    if (!v) continue;
    const cur = vertModeUi(v);
    if (m === null) m = cur;
    else if (m !== cur) return "mixed";
  }
  return m;
}

function handleLabel(m: NodeEditState["mode"]): string {
  if (m === "mixed") return "혼합 핸들";
  if (m === null || m === "none") return "핸들 없음";
  return `${NODE_MODE_LABELS[m]} 핸들`;
}
