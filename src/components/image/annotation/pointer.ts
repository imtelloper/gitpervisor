// 포인터 제스처 — 선택·이동·리사이즈·마퀴·그리기·크롭에 더해 스냅·가이드·측정(설계 §5.2~5.4,
// 43 §3.4~§3.7).
//
// **드래그 갱신점은 `applyDragAt` 하나다.** 스냅을 여기 한 곳에만 끼운 이유이자, 펜·형광펜이
// 자동으로 제외되는 이유이기도 하다(그 둘만 `appendPenPoint` 경로라 분기 자체가 다르다).
// 스냅 결과(스마트 가이드 선·간격)는 `snapRef` 로 크롬에만 간다 — **문서에 남는 것은 좌표뿐**이다.
//
// 화면 크롬 그리기는 여기 없다(43 이 SVG 오버레이로 옮겼다). 남은 것은 크롬과 포인터가 **같은
// 점을 봐야 하는** 순수 기하뿐이다: `handlePointsOf`/`hitHandle`(집는 자리 = 보이는 자리),
// `marqueeRect`, `rectsOverlap`.

import {
  appendPenPoint,
  hitTest,
  isGeomNode,
  normalizeDeg,
  objectAABB,
  objectAnchor,
  objectBBox,
  rotatePoint,
  selectBox,
  translateObject,
} from "../../../lib/annotate/geometry";
import {
  buildSnapIndex,
  measureBetween,
  snapPoint,
  snapRect,
  type Guide,
  type Measure,
  type SnapGap,
  type SnapIndex,
  type SnapLine,
  type SnapResult,
} from "../../../lib/annotate/snap";
import { moveUnit } from "../../../lib/annotate/components";
import {
  group as treeGroup,
  isContainer,
  nodeOf,
  remove,
  subtreeIds,
} from "../../../lib/annotate/tree";
import {
  type GeomNode,
  type Node,
  type ObjId,
  type Rect,
  type TextNode,
} from "../../../lib/annotate/types";
import { useImageEditorUi } from "../../../stores/imageEditor";
import type { Tool } from "../../../stores/imageEditor";
import type { AnnotationLayerProps } from "../AnnotationLayer";
import {
  isDraftUsable,
  makeDraft,
  newBadgeNode,
  newTextNode,
  nextBadgeNumber,
  resizeObject,
} from "./draft";
// 노드 편집·펜의 **본체는 저쪽**이다(47 §3.4) — 여기 들어오는 것은 진입뿐이라, 크롭(48)과
// 이 파일을 동시에 편집하는 면적이 몇 줄로 묶인다.
import {
  createNodeGestures,
  isNodeDrag,
  type NodeDrag,
  type NodeGestureCtx,
  type NodeMods,
} from "./nodeEdit";
import type { EditState } from "./textEdit";

export interface Point {
  x: number;
  y: number;
}

/**
 * 화면(clientX/Y) → 문서 좌표. 클램프하지 **않는다**.
 *
 * 캔버스 css 박스가 덮는 문서 영역은 `viewport`(없으면 `bounds` 전체)라서, 박스 안 비율에 그
 * 영역 크기를 곱하고 원점을 더한다. 포인터·더블클릭·에셋 드롭(`clientToOriented`)이 전부 이
 * 한 벌을 쓴다 — 갈리면 놓은 자리와 생기는 자리가 어긋난다. 뷰포트가 없으면 종전 식 그대로다.
 */
export function clientToDoc(
  c: HTMLCanvasElement,
  cx: number,
  cy: number,
  s: Pick<AnnotationLayerProps, "bounds" | "viewport">,
): Point {
  const r = c.getBoundingClientRect();
  const fx = (cx - r.left) / Math.max(1, r.width);
  const fy = (cy - r.top) / Math.max(1, r.height);
  const v = s.viewport;
  return v
    ? { x: v.x + fx * v.width, y: v.y + fy * v.height }
    : { x: fx * s.bounds.width, y: fy * s.bounds.height };
}

/** 핸들 집기 허용 반경(css px) — 손가락/트랙패드로도 집히게 넉넉히. */
export const HANDLE_GRAB_CSS = 10;
/** 이보다 작은 드래그는 클릭 오조작으로 보고 객체를 만들지 않는다(oriented px). */
export const MIN_DRAG = 3;
/**
 * 가이드 집기 반경(css px). 핸들(10)보다 좁다 — 가이드가 핸들 위를 지날 때 리사이즈를
 * 가로채면 "핸들이 가끔 안 잡힌다"로 보인다. 순서상 핸들이 먼저지만 반경도 겹치지 않게 둔다.
 */
const GUIDE_GRAB_CSS = 4;
/** 측정 라벨을 선에서 띄우는 거리(oriented px) — 겹치면 숫자가 선에 먹힌다. */
const MEASURE_LABEL_GAP = 8;
/** 측정 도구 산출물의 그룹 이름(시안 ⑤ 컴포넌트 이름 관례). */
const MEASURE_GROUP_NAME = "측정 라벨";

/**
 * 선택 도구처럼 구는 도구 — 히트·핸들·이동·마퀴가 같다. 배율(K)은 리사이즈 수식만 다르다.
 */
const isSelectLike = (t: Tool) => t === "select" || t === "scale";

/**
 * 핸들 인덱스(0 nw … 7 w)별 커서.
 *
 * ponytail: 회전된 객체에서는 핸들 인덱스의 **기본 방향**을 쓰므로 최대 45° 어긋난다.
 *           정확히 맞추려면 rot 을 45° 단위로 양자화해 인덱스를 돌리면 된다(3줄). 지금은
 *           회전 객체 자체가 "이미지를 90° 돌린 뒤의 텍스트·뱃지"뿐이라 요구가 없다.
 */
export const HANDLE_CURSORS = [
  "nwse-resize",
  "ns-resize",
  "nesw-resize",
  "ew-resize",
  "nwse-resize",
  "ns-resize",
  "nesw-resize",
  "ew-resize",
];

/**
 * 8핸들 위치(0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w) — **회전 외접 사각형이 아니라
 * 로컬 bbox 위**에 두고 rot 만큼 돌린다.
 *
 * 종전에는 `objectAABB`(회전 외접 사각형)의 모서리를 썼다. rot≠0 이면 그 사각형은 객체보다
 * 크고 축정렬이라, 거기서 뽑은 배율을 회전 이전 좌표에 먹이면 앵커가 포인터로 순간이동했다.
 * 회전된 로컬 모서리는 실제 도형의 모서리라 눈에 보이는 것과 집는 것이 같아진다.
 *
 * 크롬 오버레이도 같은 순서로 핸들을 그린다(`ChromeOverlay.handlePoints` + 상자 회전) —
 * 두 곳이 어긋나면 "보이는 곳을 잡아도 안 잡힌다"가 된다.
 */
function handlePointsOf(o: GeomNode): Point[] {
  const b = objectBBox(o);
  const a = objectAnchor(o);
  const mx = b.x + b.w / 2;
  const my = b.y + b.h / 2;
  return (
    [
      [b.x, b.y],
      [mx, b.y],
      [b.x + b.w, b.y],
      [b.x + b.w, my],
      [b.x + b.w, b.y + b.h],
      [mx, b.y + b.h],
      [b.x, b.y + b.h],
      [b.x, my],
    ] as const
  ).map(([x, y]) => rotatePoint(x, y, o.rot, a));
}

/**
 * 크롭 사각형의 8핸들 — `handlePointsOf` 와 **같은 인덱스**(0 nw … 7 w)다. 크롭 사각형은
 * 회전이 없어 회전 보정도 없다.
 *
 * 크롭 기하(리사이즈·이동·비율)는 세션을 쥔 `ImageEditor` 가 계산하고 여기는 "무엇을 잡았나"만
 * 판정한다. 커서(호버)와 다운 판정이 **같은 함수**를 봐야 보이는 자리와 잡히는 자리가 갈리지
 * 않는다(`hitHandle` 머리말과 같은 이유).
 */
export function hitCropHandle(r: Rect, pt: Point, tol: number): number {
  const mx = r.x + r.w / 2;
  const my = r.y + r.h / 2;
  const hs: readonly (readonly [number, number])[] = [
    [r.x, r.y],
    [mx, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, my],
    [r.x + r.w, r.y + r.h],
    [mx, r.y + r.h],
    [r.x, r.y + r.h],
    [r.x, my],
  ];
  for (let i = 0; i < hs.length; i++) {
    if (Math.abs(hs[i][0] - pt.x) <= tol && Math.abs(hs[i][1] - pt.y) <= tol) return i;
  }
  return -1;
}

/**
 * 크롭 드래그의 마지막 수식자.
 *
 * 크롭 사각형을 계산하는 쪽(ImageEditor 의 크롭 세션)으로 가는 통로는 `onCropMove(pt)` 뿐이라
 * 점 하나만 나른다 — Shift(자유 비율일 때 1:1 임시 고정)와 Alt(스냅 끄기)를 그쪽에서 알 방법이
 * 없다. 이벤트를 보는 이 파일이 남겨 두고, **크롭 드래그 중에만** 읽는다.
 */
let cropMods: { shift: boolean; alt: boolean } = { shift: false, alt: false };
export const cropDragMods = (): { shift: boolean; alt: boolean } => cropMods;

/** 점이 어느 핸들 위인가(oriented px 허용오차). 없으면 -1. */
export function hitHandle(o: GeomNode, pt: Point, tol: number): number {
  const hs = handlePointsOf(o);
  for (let i = 0; i < hs.length; i++) {
    if (Math.abs(hs[i].x - pt.x) <= tol && Math.abs(hs[i].y - pt.y) <= tol) {
      return i;
    }
  }
  return -1;
}

/** 마퀴 드래그의 정규화 사각형(oriented px). */
export function marqueeRect(d: { start: Point; cur: Point }): Rect {
  return {
    x: Math.min(d.start.x, d.cur.x),
    y: Math.min(d.start.y, d.cur.y),
    w: Math.abs(d.cur.x - d.start.x),
    h: Math.abs(d.cur.y - d.start.y),
  };
}

/** 두 축정렬 사각형이 겹치는가(경계 접촉 포함). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  );
}

// ── 선점 훅 ─────────────────────────────────────────────────────────────────

type PointerHit = (pt: Point, e: PointerEvent) => boolean;

const pointerHits = new Set<PointerHit>();

/**
 * `onPointerDown` 에서 **핸들 히트보다 먼저** 불릴 소비자(45 그라디언트 핸들·스포이드).
 * `true` 를 돌려주면 그 다운은 거기서 끝난다 — 캔버스는 캡처도 걸지 않는다.
 *
 * 팝오버가 열릴 때 등록하고 **반환 함수로 반드시 해제**한다. 남겨 두면 팝오버가 닫힌 뒤에도
 * 캔버스 클릭이 조용히 먹혀 "그림이 안 그려진다"가 된다.
 */
export function registerPointerHit(fn: PointerHit): () => void {
  pointerHits.add(fn);
  return () => {
    pointerHits.delete(fn);
  };
}

// ── 상태 ────────────────────────────────────────────────────────────────────

/** 진행 중인 포인터 제스처. */
export type DragState =
  | { mode: "crop" }
  | { mode: "draw"; start: Point; snap?: SnapIndex }
  /**
   * 지우개. 지날 때마다 지우지 **않고** 적중 id 만 모았다가 pointerup 에 한 번 커밋한다 —
   * 틱마다 커밋하면 드래그 한 번이 히스토리 200칸을 통째로 태워 직전 작업으로 못 돌아간다.
   */
  | { mode: "erase"; ids: Set<ObjId> }
  /**
   * 빈 곳에서 시작한 선택 사각형. `keep` 은 Shift 누적의 기준이 되는 **드래그 시작 시점의**
   * 선택이다 — 비-Shift 는 pointerdown 에 이미 비우므로 up 에서 스토어를 되읽으면 늦다.
   */
  | { mode: "marquee"; start: Point; cur: Point; keep: readonly ObjId[] }
  /** `baseBox` 는 시작 시점 합집합 AABB — 매 move 다시 구하면 텍스트가 measureText 를 탄다. */
  | { mode: "move"; start: Point; base: GeomNode[]; baseBox: Rect; snap?: SnapIndex }
  | {
      mode: "resize";
      start: Point;
      handle: number;
      base: GeomNode;
      bbox: Rect;
      snap?: SnapIndex;
    }
  /** 눈금자에서 만든 기존 가이드를 끌고 있다. `index` 는 `doc.guides` 의 자리. */
  | {
      mode: "guide";
      axis: "x" | "y";
      index: number;
      orig: number;
      pos: number;
      moved: boolean;
      snap?: SnapIndex;
    }
  /** 측정 도구 — **버튼을 떼도 살아 있다**(두 클릭이 한 제스처다). */
  | { mode: "measure"; a: Point; cur: Point; snap?: SnapIndex }
  /**
   * 노드 편집의 정점·핸들·노드 마퀴(47). 상태는 같은 `dragRef` 에 실리고 갱신·커밋은
   * `nodeEdit.ts` 가 한다 — 여기 분기는 `isNodeDrag` 한 줄이다.
   */
  | NodeDrag;

/** 이번 프레임의 스냅 부산물 — 크롬에만 간다. */
export interface SnapFeedback {
  lines: SnapLine[];
  gaps: SnapGap[];
}

/** 포인터 핸들러가 만지는 컴포넌트 상태(ref 미러·커밋 헬퍼). */
export interface PointerCtx {
  p: React.RefObject<AnnotationLayerProps>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  dragRef: React.RefObject<DragState | null>;
  /** 아직 커밋되지 않은 새 객체(드래그 중). */
  draftRef: React.RefObject<GeomNode | null>;
  /** 이동·리사이즈 미리보기(원본 대신 이것을 그린다). */
  liveRef: React.RefObject<GeomNode[] | null>;
  editingRef: React.RefObject<EditState | null>;
  /** 번호 뱃지 카운터. */
  badgeSeqRef: React.RefObject<number>;
  /** 스마트 가이드·간격 뱃지(드래그 수명). */
  snapRef: React.RefObject<SnapFeedback | null>;
  /** Alt 홀드 측정 — 객체를 만들지 않는다. */
  measureRef: React.RefObject<Measure[] | null>;
  /** 선택된 가이드의 `doc.guides` 인덱스. -1 = 없음. 문서가 아니라 화면 상태다. */
  guideSelRef: React.RefObject<number>;
  /** 마지막 포인터 위치(oriented) — Alt 를 누른 순간엔 포인터 이벤트가 없다. */
  ptRef: React.RefObject<Point | null>;
  schedule: () => void;
  /** `label` 은 히스토리 항목 이름(41) — 넘기지 않으면 '편집' 류 기본 라벨이 붙는다. */
  commitObjects: (next: Node[], label?: string) => void;
  finishEditing: () => void;
  beginEditing: (obj: TextNode, isNew: boolean) => void;
  /**
   * 노드 편집 세션으로 가는 통로(47 §3.4). 선택 정점·펜 드래프트 ref 의 주인은
   * `AnnotationLayer` 이고, 이 파일은 포인터 좌표와 스냅만 얹는다.
   */
  node: NodeGestureCtx;
}

export function createPointerHandlers(ctx: PointerCtx) {
  const {
    p,
    canvasRef,
    dragRef,
    draftRef,
    liveRef,
    editingRef,
    badgeSeqRef,
    snapRef,
    measureRef,
    guideSelRef,
    ptRef,
    schedule,
    commitObjects,
    finishEditing,
    beginEditing,
  } = ctx;

  // ── 좌표 변환 ───────────────────────────────────────────────────────────

  /** 클램프 **전** 좌표 — 가이드를 이미지 밖으로 끌어내 지우려면 음수/초과가 살아 있어야 한다. */
  const rawOriented = (e: React.PointerEvent): Point =>
    clientToDoc(canvasRef.current!, e.clientX, e.clientY, p.current);

  const toOriented = (e: React.PointerEvent): Point => {
    const q = rawOriented(e);
    const ow = p.current.bounds.width;
    const oh = p.current.bounds.height;
    return {
      x: Math.max(0, Math.min(ow, q.x)),
      y: Math.max(0, Math.min(oh, q.y)),
    };
  };

  /** 지우개가 지난 자리의 적중 노드를 모은다. 씬을 보므로 숨김·잠금은 애초에 안 걸린다. */
  const eraseHit = (ids: Set<ObjId>, pt: Point) => {
    const s = p.current;
    const id = hitTest(s.scene, pt.x, pt.y, s.displayScale);
    if (id) ids.add(id);
  };

  // ── 스냅 ────────────────────────────────────────────────────────────────

  const canvasRect = (): Rect => ({
    x: 0,
    y: 0,
    w: p.current.bounds.width,
    h: p.current.bounds.height,
  });

  /** 흡착 반경. 화면 css px 가 정본이라 **확대할수록 정밀해진다**(시안 `임계값 4px`). */
  const snapTol = () =>
    useImageEditorUi.getState().snapThresholdCss /
    Math.max(p.current.displayScale, 1e-6);

  /**
   * 드래그 시작에 **한 번**. 스냅이 꺼져 있으면 인덱스를 아예 만들지 않는다 —
   * 그래야 이후 경로가 `if (idx)` 하나로 갈린다.
   */
  const makeIndex = (
    exclude: ReadonlySet<ObjId>,
    guides: readonly Guide[] = p.current.guides,
  ): SnapIndex | undefined => {
    const s = p.current;
    const t = useImageEditorUi.getState().toggles;
    if (!t.snap) return undefined;
    return buildSnapIndex(s.scene, exclude, guides, {
      gridPx: t.grid,
      pixel: t.snapPixel,
      objects: t.snapObjects,
      // 안 보이는 가이드에 붙으면 "왜 여기 걸리지"가 된다 — 표시 토글이 스냅도 끈다(§3.6).
      guides: t.snapGuides && t.guidesVisible,
      canvas: canvasRect(),
    });
  };

  /** 스냅 결과를 크롬으로 넘긴다. 스마트 가이드가 꺼져 있으면 선만 감춘다(값은 이미 붙었다). */
  const feedback = (res: SnapResult | null) => {
    const t = useImageEditorUi.getState().toggles;
    snapRef.current = res
      ? { lines: t.smartGuides ? res.lines : [], gaps: res.gaps }
      : null;
  };

  /** 점 하나를 붙인다(핸들·정점·그리기 두 번째 점·측정). */
  const snapAt = (idx: SnapIndex | undefined, pt: Point): Point => {
    if (!idx) {
      feedback(null);
      return pt;
    }
    const r = snapPoint(idx, pt, snapTol());
    feedback(r);
    return { x: pt.x + r.dx, y: pt.y + r.dy };
  };

  // ── 노드 편집·펜(47 §3.4) ───────────────────────────────────────────────
  //
  // 본체는 `nodeEdit.ts` 다. 여기서 넘기는 것은 이 파일만 아는 것뿐이다: 도구·배율·스냅 인덱스.

  const node = createNodeGestures(ctx.node, {
    pen: () => p.current.tool === "vpen",
    curvature: () => useImageEditorUi.getState().toggles.curvature,
    tol: () => HANDLE_GRAB_CSS / Math.max(p.current.displayScale, 1e-6),
    // 편집 중인 객체는 후보에서 뺀다 — 안 빼면 정점이 자기 자신의 변에 붙어 안 움직인다.
    makeSnap: (id) => makeIndex(new Set([id])),
    snapAt,
    // 핸들은 **픽셀 스냅만** 받는다(§3.4). 마스터 토글이 꺼져 있으면 아무 것도 하지 않는다 —
    // 상태바에서 끈 스냅이 노드 편집에서만 살아 있으면 안 된다.
    snapPixel: (pt) => {
      const t = useImageEditorUi.getState().toggles;
      if (!t.snap || !t.snapPixel) return pt;
      return { x: Math.round(pt.x), y: Math.round(pt.y) };
    },
  });

  const modsOf = (e: React.PointerEvent | React.MouseEvent): NodeMods => ({
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: e.ctrlKey || e.metaKey,
  });

  // ── 가이드 ──────────────────────────────────────────────────────────────

  /** 포인터 아래 가이드의 인덱스(위에 그려진 것이 이긴다). 없으면 -1. */
  const hitGuide = (pt: Point, tol: number): number => {
    const s = p.current;
    if (!useImageEditorUi.getState().toggles.guidesVisible) return -1;
    for (let i = s.guides.length - 1; i >= 0; i--) {
      const g = s.guides[i];
      if (Math.abs((g.axis === "x" ? pt.x : pt.y) - g.pos) <= tol) return i;
    }
    return -1;
  };

  /** 가이드는 축 하나만 붙는다 — 반대 축 좌표는 후보에 영향을 주지 않으므로 그대로 넘긴다. */
  const snapGuidePos = (
    idx: SnapIndex | undefined,
    axis: "x" | "y",
    pos: number,
    cross: number,
  ): number => {
    if (!idx) {
      feedback(null);
      return pos;
    }
    const q = axis === "x" ? { x: pos, y: cross } : { x: cross, y: pos };
    const r = snapPoint(idx, q, snapTol());
    // 반대 축 선은 버린다 — 가이드는 한 축만 움직이는데 두 축의 선이 뜨면 무엇에 붙었는지 모른다.
    feedback({ ...r, lines: r.lines.filter((l) => l.axis === axis) });
    return pos + (axis === "x" ? r.dx : r.dy);
  };

  // ── 측정 ────────────────────────────────────────────────────────────────

  /**
   * Alt 홀드 호버 측정. 선택 합집합과 포인터 아래 객체(없으면 캔버스 4변) 사이 거리를 잰다.
   *
   * 대상 판정은 **AABB 포함**이다 — Path2D 히트가 아니다. 재는 것은 "이 상자와 저 상자의
   * 간격"이지 획의 모양이 아니고, Figma 도 같은 기준이다.
   */
  const applyAltMeasure = (on: boolean): void => {
    const s = p.current;
    const pt = ptRef.current;
    if (!on || !pt || s.tool !== "select" || !s.selectedIds.length) {
      measureRef.current = null;
      return;
    }
    const a = selectBox(s.scene, s.selectedIds).rect;
    if (a.w <= 0 && a.h <= 0) {
      measureRef.current = null;
      return;
    }
    const sel = new Set<ObjId>(s.selectedIds);
    let target: Rect | null = null;
    for (let i = s.scene.nodes.length - 1; i >= 0; i--) {
      const o = s.scene.nodes[i];
      if (sel.has(o.id)) continue;
      const b = objectAABB(o);
      if (pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h) {
        target = b;
        break;
      }
    }
    measureRef.current = measureBetween(a, target, canvasRect());
  };

  /** 두 점 = `측정 라벨` 그룹(선 + 텍스트) **한 커밋**. 히스토리 한 칸이어야 Ctrl+Z 한 번에 사라진다. */
  const commitMeasure = (a: Point, b: Point) => {
    const s = p.current;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < MIN_DRAG) return;
    const line = makeDraft({ ...s, tool: "line" }, a, b, false);
    if (!line) return;
    // 법선 방향으로 띄운다 — 선 위에 겹치면 두 색이 섞여 숫자를 못 읽는다.
    const nx = -(b.y - a.y) / dist;
    const ny = (b.x - a.x) / dist;
    const label: TextNode = {
      ...newTextNode({
        x: (a.x + b.x) / 2 + nx * MEASURE_LABEL_GAP,
        y: (a.y + b.y) / 2 + ny * MEASURE_LABEL_GAP,
        opacity: s.opacity,
        fontSize: s.style.fontSize,
        // 글자색은 채우기다 — 툴바의 "색"은 선 슬롯에 앉는다(37 §3.3 매핑표).
        fills: s.style.strokes.map((f) => ({ ...f })),
      }),
      text: `${Math.round(dist)} px`,
    };
    const r = treeGroup([...s.objects, line, label], [line.id, label.id], "group");
    commitObjects(
      r.objects.map((o) => (o.id === r.id ? { ...o, name: MEASURE_GROUP_NAME } : o)),
      "측정 라벨 생성",
    );
  };

  // ── 포인터 ──────────────────────────────────────────────────────────────

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const s = p.current;
    // 손 도구는 좌버튼을 **잡지 않는다**(캡처도, 처리도 없다) — 그래야 이벤트가 그대로
    // 버블해 스테이지의 팬 핸들러가 받는다. setPointerCapture 를 먼저 걸어 버리면 이후
    // move/up 이 이 캔버스로만 배달돼 화면이 한 픽셀도 안 밀린다.
    // 크롭은 모드라 도구보다 우선한다(42 §3.2 — 직교).
    if (s.tool === "hand" && !s.cropMode) return;
    const pt = toOriented(e);
    ptRef.current = pt;
    // 45 의 그라디언트 핸들·스포이드가 **핸들 히트보다 먼저** 본다. 소비했으면 캡처도 걸지 않는다.
    for (const hit of pointerHits) {
      if (hit(pt, e.nativeEvent)) return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);

    if (s.cropMode) {
      cropMods = { shift: e.shiftKey, alt: e.altKey };
      dragRef.current = { mode: "crop" };
      s.onCropDown(pt);
      return;
    }
    // 텍스트 편집 중 캔버스를 누르면 textarea blur 로 확정된다 — 여기서 한 번 더 보장.
    if (editingRef.current) finishEditing();

    // 노드 편집·펜은 **여기서** 갈린다(47 §3.4). 안 갈리면 정점을 집으려는 클릭이 아래
    // `isSelectLike` 로 떨어져 패스 **객체**를 골라 통째로 끌고 가고, 펜 클릭은 `makeDraft` 의
    // default(null)로 떨어져 아무 일도 일어나지 않는다 — 예외도 로그도 없다.
    const nodeHit = node.onDown(pt, modsOf(e));
    if (nodeHit) {
      dragRef.current = nodeHit.drag ?? null;
      schedule();
      return;
    }

    if (s.tool === "eraser") {
      const ids = new Set<ObjId>();
      eraseHit(ids, pt);
      dragRef.current = { mode: "erase", ids };
      return;
    }

    if (s.tool === "measure") {
      const prev = dragRef.current;
      const idx = prev?.mode === "measure" ? prev.snap : makeIndex(new Set());
      const q = snapAt(idx, pt);
      if (prev && prev.mode === "measure") {
        dragRef.current = null;
        commitMeasure(prev.a, q);
        // 제스처가 끝났으니 스마트 가이드도 함께 걷는다 — 안 걷으면 분홍 선이 화면에 굳는다.
        feedback(null);
      } else {
        dragRef.current = { mode: "measure", a: q, cur: q, snap: idx };
      }
      schedule();
      return;
    }

    if (isSelectLike(s.tool)) {
      // 1) 단일 선택 상태면 리사이즈 핸들을 먼저 본다(핸들이 객체 위에 있을 수 있다).
      const only =
        s.selectedIds.length === 1
          ? s.scene.nodes.find((o) => o.id === s.selectedIds[0])
          : undefined;
      if (only) {
        // 리사이즈 수학이 쓰는 bbox 는 **로컬**이다(회전 외접 사각형이 아니다).
        const bbox = objectBBox(only);
        const h = hitHandle(only, pt, HANDLE_GRAB_CSS / s.displayScale);
        if (h >= 0) {
          dragRef.current = {
            mode: "resize",
            start: pt,
            handle: h,
            base: only,
            bbox,
            snap: makeIndex(new Set([only.id])),
          };
          liveRef.current = [only];
          schedule();
          return;
        }
      }
      // 2) 가이드는 **객체보다 먼저** 잡힌다(Figma 규칙). 가이드 위 4px 안의 객체를 못 고르게
      //    되지만, 반대로 두면 가이드를 옮길 방법이 사라진다.
      const gi = hitGuide(pt, GUIDE_GRAB_CSS / s.displayScale);
      if (gi >= 0) {
        const g = s.guides[gi];
        guideSelRef.current = gi;
        dragRef.current = {
          mode: "guide",
          axis: g.axis,
          index: gi,
          orig: g.pos,
          pos: g.pos,
          moved: false,
          // 자기 자신은 후보에서 뺀다 — 안 빼면 거리 0 인 자기 위치에 붙어 가이드가 안 움직인다.
          snap: makeIndex(new Set(), s.guides.filter((_, k) => k !== gi)),
        };
        schedule();
        return;
      }
      // 씬 히트 — 숨김은 애초에 씬에 없고, 잠금은 flags 로 걸러진다. 그룹이 있으면 최상위
      // 조상이 돌아온다(클릭 = 그룹 단위, 시안 ① ⇧클릭 규칙).
      const hitId = hitTest(s.scene, pt.x, pt.y, s.displayScale);
      guideSelRef.current = -1;
      if (!hitId) {
        // 빈 곳 = 마퀴 시작. 종전에는 여기서 dragRef 를 비워 드래그가 통째로 no-op 이었다 —
        // 모든 그래픽 도구가 이 자리에서 고무줄을 그리므로 "이건 그리기 도구가 아니다"라는
        // 가장 큰 신호였다. 클릭(3px 미만)의 선택 해제는 종전 그대로 여기서 한다.
        const keep = e.shiftKey ? s.selectedIds : [];
        if (!e.shiftKey && s.selectedIds.length) s.onSelectionChange([]);
        dragRef.current = { mode: "marquee", start: pt, cur: pt, keep };
        schedule();
        return;
      }
      const id = hitId;
      let ids: ObjId[];
      if (e.shiftKey) {
        ids = s.selectedIds.includes(id)
          ? s.selectedIds.filter((x) => x !== id)
          : [...s.selectedIds, id];
      } else {
        ids = s.selectedIds.includes(id) ? [...s.selectedIds] : [id];
      }
      s.onSelectionChange(ids);
      // **컨테이너를 고르면 서브트리가 통째로 움직인다** — 프레임·그룹·인스턴스 모두.
      // `nudge`(ImageEditor)가 `moveUnit` + `translateSubtree` 로 이미 그렇게 하므로, 여기서
      // 선택 id 만 집으면 같은 조작이 입력 장치에 따라 갈린다: 프레임을 방향키로 밀면 자식이
      // 따라오는데 마우스로 끌면 프레임만 빠져나가고(자식이 뒤에 남는다), 그룹은 기하가 없어
      // (38 §1) `base` 가 비어 드래그가 **아무 일도 없이** 끝난다.
      //
      // 인스턴스는 그중 한 경우다(51 §3.4): 더블클릭으로 들어간 자식을 끌어도 인스턴스 전체가
      // 따라와야 한다 — 자식만 옮기면 위치 재정의가 되는데 51 §3.5 가 기하 재정의를 받지 않아
      // 다음 커밋의 재물질화가 소리 없이 되돌린다(사용자에겐 "드래그가 씹혔다"로 보인다).
      // `moveUnit` 이 인스턴스 조상까지 올려 주는 것도 그래서다.
      //
      // 컨테이너가 하나도 없는 문서에서는 훑지 않는다 — 선택 하나마다 조상·서브트리를 도는
      // O(n) 이라 전체 선택 뒤 드래그가 노드 수 × 선택 수가 된다.
      const hasContainer = s.objects.some(isContainer);
      const moveIds = new Set<ObjId>(hasContainer ? [] : ids);
      if (hasContainer) {
        for (const sel of ids) {
          const unit = moveUnit(s.objects, sel);
          const n = nodeOf(s.objects, unit);
          if (n && isContainer(n)) {
            for (const sub of subtreeIds(s.objects, unit)) moveIds.add(sub);
          } else {
            moveIds.add(unit);
          }
        }
      }
      const base = s.objects.filter(
        (o): o is GeomNode => moveIds.has(o.id) && isGeomNode(o),
      );
      dragRef.current = base.length
        ? {
            mode: "move",
            start: pt,
            base,
            baseBox: unionOf(base),
            // 자기 자신(과 자손)은 후보에서 빼야 한다 — 안 그러면 드래그가 제자리에 붙는다.
            snap: makeIndex(moveIds),
          }
        : null;
      liveRef.current = base.length ? base : null;
      schedule();
      return;
    }

    if (s.tool === "text") {
      // 글자색은 채우기다(v1 의 stroke 자리 — 37 §3.3 매핑표).
      beginEditing(
        newTextNode({
          x: pt.x,
          y: pt.y,
          opacity: s.opacity,
          fontSize: s.style.fontSize,
          fills: s.style.strokes.map((f) => ({ ...f })),
        }),
        true,
      );
      return;
    }

    if (s.tool === "badge") {
      const n = nextBadgeNumber(s.objects, badgeSeqRef);
      // 뱃지의 "색"은 원 채움이다 — 숫자 글자색은 렌더러가 대비로 정한다(v1 규칙 승계).
      commitObjects([
        ...s.objects,
        newBadgeNode({
          x: pt.x,
          y: pt.y,
          n,
          opacity: s.opacity,
          fontSize: s.style.fontSize,
          fills: s.style.strokes.map((f) => ({ ...f })),
        }),
      ]);
      return;
    }

    dragRef.current = { mode: "draw", start: pt, snap: makeIndex(new Set()) };
    draftRef.current = makeDraft(s, pt, pt, e.shiftKey);
    schedule();
  };

  /**
   * 드래그가 없을 때의 호버 — 커서·호버 대상·Alt 측정.
   *
   * **React state 를 쓰지 않는다**(커서는 DOM 에 직접 쓴다) — 매 mousemove 리렌더는
   * useLayoutEffect 의존성을 매번 돌려 schedule 을 폭주시킨다. 호버 대상만 스토어로 올리는데,
   * 그 값은 대상이 **바뀔 때만** 쓰므로 초당 60회가 아니라 객체를 넘나들 때만 흐른다.
   */
  const onHoverMove = (e: React.PointerEvent) => {
    const c = canvasRef.current;
    if (!c) return;
    const s = p.current;
    const pt = toOriented(e);
    ptRef.current = pt;

    let cur = "";
    let hover: ObjId | null = null;
    // 크롭 중에는 도구가 아니라 **사각형**이 커서를 정한다(모드가 도구를 이긴다). 8핸들 위에서
    // 리사이즈 커서가 안 뜨면 사용자는 그 자리가 잡히는 줄 모른다 — 빈 곳의 crosshair 는
    // className 이 내므로 여기서는 빈 문자열로 되돌린다.
    if (s.cropMode) {
      const r = s.cropRect;
      const h = r ? hitCropHandle(r, pt, HANDLE_GRAB_CSS / s.displayScale) : -1;
      if (h >= 0) cur = HANDLE_CURSORS[h];
      else if (
        r &&
        pt.x >= r.x &&
        pt.x <= r.x + r.w &&
        pt.y >= r.y &&
        pt.y <= r.y + r.h
      ) {
        cur = "move";
      }
    } else if (s.tool === "hand") {
      cur = "grab";
    } else if (isSelectLike(s.tool)) {
      if (s.selectedIds.length === 1) {
        const only = s.objects.find(
          (o): o is GeomNode => o.id === s.selectedIds[0] && isGeomNode(o),
        );
        if (only) {
          const h = hitHandle(only, pt, HANDLE_GRAB_CSS / s.displayScale);
          // 핸들 인덱스는 **로컬**(회전 이전) 방향이라 그대로 쓰면 회전 객체에서 어긋난다.
          // 8방향이 45° 간격이므로 회전각을 45° 단위로 반올림해 인덱스를 돌린다.
          if (h >= 0) {
            const turn = Math.round(normalizeDeg(only.rot) / 45);
            cur = HANDLE_CURSORS[(h + turn) % 8];
          }
        }
      }
      if (!cur) {
        const gi = hitGuide(pt, GUIDE_GRAB_CSS / s.displayScale);
        if (gi >= 0) cur = s.guides[gi].axis === "x" ? "col-resize" : "row-resize";
        else hover = hitTest(s.scene, pt.x, pt.y, s.displayScale);
      }
    }
    // className 의 Tailwind 커서로 되돌리려면 **빈 문자열**이어야 한다.
    if (c.style.cursor !== cur) c.style.cursor = cur;

    const ui = useImageEditorUi.getState();
    let dirty = false;
    if (ui.hoverId !== hover) {
      ui.setHover(hover);
      dirty = true;
    }
    const had = measureRef.current !== null;
    // 왼쪽 Alt 만 재는 것은 42 표의 몫이다 — 여기서는 이벤트의 수식자 상태만 본다.
    applyAltMeasure(e.altKey);
    if (had || measureRef.current) dirty = true;
    if (dirty) schedule();
  };

  /**
   * 드래그 상태를 포인터 위치로 갱신한다.
   *
   * **move 와 up 이 같은 함수를 쓴다.** 종전에는 up 이 이 갱신을 하지 않고 마지막
   * pointermove 가 남긴 값을 그대로 커밋해, 그 사이의 이동이 통째로 사라졌다 — 실제 마우스는
   * up 직전에 move 를 내보내 서브프레임 손실로 끝나지만, 펜/터치의 리프트나 합성 이벤트에서는
   * 드래그 구간 전체가 유실된다.
   *
   * `mods.alt` 는 스냅을 끈다 — "정확히 여기에 놓겠다"는 뜻이라 저항이 있으면 안 된다.
   */
  const applyDragAt = (
    d: DragState,
    pt: Point,
    mods: { shift: boolean; alt: boolean; ctrl: boolean },
  ) => {
    const s = p.current;
    // 노드 편집 제스처는 갱신도 커밋도 저쪽이 한다 — 여기 있는 것은 좌표뿐이다.
    if (isNodeDrag(d)) {
      node.onDrag(d, pt, mods);
      return;
    }
    const idx = mods.alt ? undefined : "snap" in d ? d.snap : undefined;
    if (d.mode === "crop") {
      cropMods = mods;
      s.onCropMove(pt);
      return;
    }
    if (d.mode === "marquee") {
      d.cur = pt;
      return;
    }
    if (d.mode === "erase") {
      eraseHit(d.ids, pt);
      return;
    }
    if (d.mode === "guide") {
      const cross = d.axis === "x" ? pt.y : pt.x;
      const raw = d.axis === "x" ? pt.x : pt.y;
      d.pos = snapGuidePos(idx, d.axis, raw, cross);
      // 반 픽셀도 못 움직인 드래그는 클릭(선택)이다 — 커밋을 만들면 히스토리가 지저분해진다.
      if (Math.abs(d.pos - d.orig) >= 0.5) d.moved = true;
      return;
    }
    if (d.mode === "measure") {
      d.cur = snapAt(idx, pt);
      return;
    }
    if (d.mode === "draw") {
      const cur = draftRef.current;
      if (cur && (cur.kind === "pen" || cur.kind === "highlight")) {
        // 드래프트는 커밋 전이므로 제자리 변경한다 — 이벤트마다 복제하면 O(n²).
        // 자유곡선에는 스냅을 걸지 않는다: 획이 격자에서 끊긴다.
        appendPenPoint(cur.pts, pt.x, pt.y);
      } else {
        draftRef.current = makeDraft(s, d.start, snapAt(idx, pt), mods.shift);
      }
      return;
    }
    if (d.mode === "move") {
      let dx = pt.x - d.start.x;
      let dy = pt.y - d.start.y;
      // 클릭 = 길이 0 의 move 드래그다(up 이 이 함수를 한 번 더 부른다). 여기서 막지 않으면
      // 아래 `snapRect` 가 델타 0 인데도 후보까지의 거리를 더해 **선택하려고 누른 도형이 튄다**.
      // `d.base` 를 그대로 돌려놔야 onPointerUp 의 참조 비교(`moved`)가 false 가 돼
      // 빈 히스토리 항목도 남지 않는다 — `translateObject` 는 dx=dy=0 이어도 새 객체를 만든다.
      // 임계를 0 초과로 두면 안 된다: 고배율에서 0.5 oriented px 는 화면 수 px 라 진짜 드래그를 먹는다.
      if (dx === 0 && dy === 0) {
        liveRef.current = d.base;
        feedback(null);
        return;
      }
      if (idx) {
        const t = useImageEditorUi.getState().toggles;
        const r = snapRect(
          idx,
          { x: d.baseBox.x + dx, y: d.baseBox.y + dy, w: d.baseBox.w, h: d.baseBox.h },
          snapTol(),
          // 보이지 않는 스냅은 저항이다(K3) — 뱃지를 끄면 등간격 보정 자체를 끈다.
          { gaps: t.gapBadges },
        );
        dx += r.dx;
        dy += r.dy;
        feedback(r);
      } else {
        feedback(null);
      }
      liveRef.current = d.base.map((o) => translateObject(o, dx, dy));
      return;
    }
    // 클릭 = 길이 0 의 resize 드래그다(up 이 이 함수를 한 번 더 부른다) — move 분기와 같은
    // 가드가 필요하다. `resizeObject` 는 델타가 아니라 **절대 좌표**로 배율을 잡으므로,
    // 핸들 파지 반경(HANDLE_GRAB_CSS) 안 아무 데나 한 번 누르기만 해도 그 오프셋만큼
    // 기하가 조용히 바뀌고(텍스트는 폭까지 갈리며 박스 모드가 auto-height 로 넘어간다)
    // 빈 히스토리 항목이 쌓인다. `d.base` 를 그대로 돌려놔야 onPointerUp 의 참조 비교
    // (`moved`)가 false 가 된다 — d.base 는 scene.nodes 원소 = doc.objects 원소다.
    if (pt.x === d.start.x && pt.y === d.start.y) {
      liveRef.current = [d.base];
      return;
    }
    liveRef.current = [
      resizeObject(
        d.base,
        d.bbox,
        d.handle,
        snapAt(idx, pt),
        mods.shift,
        s.tool === "scale",
        mods.ctrl,
      ),
    ];
  };

  const onPointerMove = (e: React.PointerEvent) => {
    let d = dragRef.current;
    // 측정 도구만 버튼을 뗀 뒤에도 상태가 남는다 — 도구를 바꿨는데 그대로 두면 러버밴드가
    // 다른 도구 위에 유령처럼 따라다닌다.
    if (d?.mode === "measure" && p.current.tool !== "measure") {
      dragRef.current = null;
      d = null;
      schedule();
    }
    if (!d) {
      // 펜 러버밴드·커서 힌트는 디자인 호버 경로가 모른다(그쪽은 객체 하이라이트와 커서만 본다).
      const q = toOriented(e);
      if (node.onHover(q, modsOf(e))) {
        // 인라인 커서는 디자인 호버가 마지막으로 쓴 값이다(리사이즈 화살표 등) — 이 화면에서
        // 정본은 className 의 crosshair 라, 안 비우면 엉뚱한 커서가 굳는다.
        const c = canvasRef.current;
        if (c && c.style.cursor) c.style.cursor = "";
        ptRef.current = q;
        schedule();
        return;
      }
      onHoverMove(e);
      return;
    }
    const pt = d.mode === "guide" ? rawOriented(e) : toOriented(e);
    ptRef.current = pt;
    applyDragAt(d, pt, { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });
    schedule();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    // 펜 드래프트는 `dragRef` 에 실리지 않는다(버튼을 떼도 살아 있다) — 손을 뗐다는 것은
    // **드래그가 없어도** 알려야 한다. 안 알리면 이후 호버가 마지막 정점의 핸들을 계속 끈다.
    node.onRelease();
    if (!d) return;
    const s = p.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // 릴리스 좌표를 마지막으로 한 번 더 반영한다. pointercancel 은 제외한다 —
    // OS 가 제스처를 물린 것이라 그 좌표에는 의미가 없다.
    if (e.type === "pointerup") {
      applyDragAt(d, d.mode === "guide" ? rawOriented(e) : toOriented(e), {
        shift: e.shiftKey,
        alt: e.altKey,
        ctrl: e.ctrlKey || e.metaKey,
      });
    }
    // 스냅 부산물은 드래그와 함께 사라진다 — 남으면 분홍 선이 화면에 굳는다.
    feedback(null);

    // 노드 편집 제스처의 커밋은 라벨(`노드 이동`·`핸들 조정`)이 붙어야 하고, 마퀴는 커밋이
    // 아니라 선택이다 — 아래 일반 꼬리(라벨 없는 커밋)로 흘리면 둘 다 어긋난다.
    if (isNodeDrag(d)) {
      node.onUp(d);
      return;
    }
    if (d.mode === "measure") {
      // 두 클릭이 한 제스처다 — 버튼을 뗐다고 시작점을 버리면 두 번째 점을 찍을 수 없다.
      dragRef.current = d;
      schedule();
      return;
    }
    if (d.mode === "crop") {
      s.onCropUp();
      return;
    }
    if (d.mode === "guide") {
      const max = d.axis === "x" ? s.bounds.width : s.bounds.height;
      const next = s.guides.map((g) => ({ ...g }));
      if (d.pos < 0 || d.pos > max) {
        next.splice(d.index, 1);
        guideSelRef.current = -1;
        s.onGuidesChange(next, "가이드 삭제");
      } else if (d.moved) {
        next[d.index] = { axis: d.axis, pos: d.pos };
        s.onGuidesChange(next, "가이드 이동");
      }
      schedule();
      return;
    }
    if (d.mode === "marquee") {
      const r = marqueeRect(d);
      // 3px 미만은 클릭 오조작 — 선택 해제는 이미 pointerdown 에서 했다(종전 동작 보존).
      if (r.w >= MIN_DRAG || r.h >= MIN_DRAG) {
        const ids = new Set(d.keep);
        // "닿으면 선택"(Figma 규칙) — objectAABB 교차라 새 기하 코드가 0이다.
        // 마퀴도 씬을 본다 — 숨긴 노드가 "닿으면 선택"으로 되살아나지 않게.
        for (const o of s.scene.nodes) {
          if (!s.scene.flags.get(o.id)?.locked && rectsOverlap(r, objectAABB(o))) ids.add(o.id);
        }
        s.onSelectionChange([...ids]);
      }
      schedule();
      return;
    }
    if (d.mode === "erase") {
      // 지운 게 없으면 커밋도 없다 — 빈 히스토리 항목이 쌓이면 Ctrl+Z 가 몇 번은
      // 아무 일도 안 하는 것처럼 보인다.
      if (d.ids.size) commitObjects(remove(s.objects, [...d.ids]), "지우개");
      return;
    }
    if (d.mode === "draw") {
      const draft = draftRef.current;
      draftRef.current = null;
      if (draft && isDraftUsable(draft)) commitObjects([...s.objects, draft]);
      schedule();
      return;
    }
    const live = liveRef.current;
    liveRef.current = null;
    if (live) {
      const byId = new Map(live.map((o) => [o.id, o]));
      const moved = s.objects.some((o) => byId.has(o.id) && byId.get(o.id) !== o);
      if (moved) commitObjects(s.objects.map((o) => byId.get(o.id) ?? o));
    }
    schedule();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const s = p.current;
    if (s.cropMode) return;
    const { x, y } = clientToDoc(canvasRef.current!, e.clientX, e.clientY, s);
    // 펜 드래프트 완료·정점 모드 토글은 도구가 `vpen` 이어도 와야 한다(47 §3.1 표·§3.6).
    if (node.onDouble({ x, y })) {
      schedule();
      return;
    }
    if (s.tool !== "select") return;
    // 더블클릭은 그룹 안으로 들어간다(deep) — 텍스트를 바로 편집할 수 있어야 한다.
    const hitId = hitTest(s.scene, x, y, s.displayScale, { deep: true });
    if (!hitId) return;
    const o = s.scene.nodes.find((n) => n.id === hitId);
    if (o && o.kind === "text") beginEditing(o, false);
    // `path` 더블클릭 = 노드 편집 진입(47 §3.2). 텍스트 편집과 **같은 자리**에서 갈린다 —
    // 진입 경로를 따로 만들면 더블클릭의 뜻이 도구마다 달라진다.
    else if (o && o.kind === "path") node.enter(o.id);
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onDoubleClick,
    /** 42 `measure.hold` 액션 — 포인터가 멈춰 있어도 Alt 누름/뗌에 반응해야 한다. */
    applyAltMeasure,
  };
}

/** 여러 객체의 합집합 AABB(oriented px). */
function unionOf(nodes: readonly GeomNode[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const o of nodes) {
    const b = objectAABB(o);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
