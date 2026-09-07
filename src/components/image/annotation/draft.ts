// 드래프트 생성 · 리사이즈 — AnnotationLayer 에서 떼어낸 **순수 함수**들.
//
// 이 파일이 따로 있는 이유는 순환 import 다. 포인터 핸들러(pointer.ts)가 이 함수들을 부르는데
// AnnotationLayer.tsx 에 두면 컴포넌트 파일이 값을 export 하게 되고, 그러면 두 방향 import 가
// 생겨 dev 에서 Fast Refresh 가 꺼진다(파일을 고칠 때마다 전체 리로드). 38·42·43·47·48 이
// 이 파일을 계속 건드리므로 미리 끊어 둔다.
//
// 좌표는 전부 oriented px 다(types.ts 규약).

import type { RefObject } from "react";

import {
  normalizeDeg,
  normalizeRect,
  objectAnchor,
  rotatePoint,
  snapAngle,
  translateObject,
} from "../../../lib/annotate/geometry";
import {
  DEFAULT_OPACITY,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_STYLE,
  HIGHLIGHT_OPACITY,
  HIGHLIGHT_WIDTH_SCALE,
  newObjId,
  SHIFT_SNAP_DEG,
  type BadgeObject,
  type Fill,
  type GeomNode,
  type Node,
  type ObjId,
  type Rect,
  type TextNode,
} from "../../../lib/annotate/types";
import type { AnnotationLayerProps } from "../AnnotationLayer";
import { MIN_DRAG } from "./chrome";
import type { Point } from "./pointer";

/** 텍스트 객체의 기본 폰트 — textarea CSS 와 반드시 같은 문자열이어야 한다(§5.5). */
export const FONT_FAMILY =
  '"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';

/**
 * 현재 도구·속성으로 드래그 드래프트를 만든다.
 *
 * 속성은 툴바가 든 `DefaultPaint`(37) 에서 **복사**한다 — 참조를 공유하면 툴바를 만질 때
 * 이미 커밋된 객체까지 따라 바뀐다.
 */
export function makeDraft(
  s: AnnotationLayerProps,
  a: Point,
  b: Point,
  shift: boolean,
): GeomNode | null {
  const id = newObjId();
  const common = {
    ...emptyBase(id),
    fills: s.style.fills.map((f) => ({ ...f })),
    strokes: s.style.strokes.map((f) => ({ ...f })),
    strokeWidth: s.style.strokeWidth,
    opacity: s.opacity,
  };
  switch (s.tool) {
    case "pen":
      return { ...common, kind: "pen", pts: [a.x, a.y] };
    case "highlight":
      return {
        ...common,
        kind: "highlight",
        // 형광펜의 multiply 는 값이다(37) — 렌더가 kind 로 특수 분기하지 않는다.
        blend: "multiply",
        strokeWidth: s.style.strokeWidth * HIGHLIGHT_WIDTH_SCALE,
        opacity: HIGHLIGHT_OPACITY,
        pts: [a.x, a.y],
      };
    case "line":
    case "arrow": {
      const e = shift ? snapAngle(a.x, a.y, b.x, b.y, SHIFT_SNAP_DEG) : b;
      return {
        ...common,
        kind: s.tool,
        x1: a.x,
        y1: a.y,
        x2: e.x,
        y2: e.y,
        head: "end",
        heads: { start: "none", end: s.tool === "arrow" ? "arrow" : "none" },
      };
    }
    case "rect": {
      const r = squareable(a, b, shift);
      return { ...common, kind: "rect", ...r, radius: [...s.style.radius] };
    }
    case "ellipse": {
      const r = squareable(a, b, shift);
      return { ...common, kind: "ellipse", ...r };
    }
    case "mosaic": {
      const r = squareable(a, b, shift);
      return {
        ...common,
        kind: "mosaic",
        ...r,
        // 가림 영역은 색을 쓰지 않는다.
        fills: [],
        strokes: [],
        mode: s.style.mosaicMode,
        strength: s.style.mosaicStrength,
      };
    }
    default:
      return null;
  }
}

/** Shift 면 정사각/정원으로 맞춘 사각형(§5.2). */
function squareable(a: Point, b: Point, shift: boolean): Rect {
  if (!shift) return normalizeRect(a.x, a.y, b.x, b.y);
  const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  const x = a.x + Math.sign(b.x - a.x || 1) * side;
  const y = a.y + Math.sign(b.y - a.y || 1) * side;
  return normalizeRect(a.x, a.y, x, y);
}

/** 클릭 오조작으로 생긴 티끌 객체를 거른다. */
export function isDraftUsable(o: GeomNode): boolean {
  switch (o.kind) {
    case "pen":
    case "highlight":
      return o.pts.length >= 4;
    case "line":
    case "arrow":
      return Math.hypot(o.x2 - o.x1, o.y2 - o.y1) >= MIN_DRAG;
    case "rect":
    case "ellipse":
    case "mosaic":
      return o.w >= MIN_DRAG && o.h >= MIN_DRAG;
    default:
      return true;
  }
}

/** 다음 뱃지 번호 — 기존 최대값과 카운터 중 큰 쪽에서 이어 붙인다(삭제해도 재정렬 없음). */
export function nextBadgeNumber(
  objects: readonly Node[],
  seq: RefObject<number>,
): number {
  let max = 0;
  for (const o of objects) if (o.kind === "badge") max = Math.max(max, o.n);
  const n = Math.max(seq.current, max + 1);
  seq.current = n + 1;
  return n;
}

/**
 * 8핸들 리사이즈 — 시작 시점 bbox 를 기준으로 배율을 구해 객체 기하를 늘린다.
 * Shift 면 변화가 큰 축의 배율을 양축에 함께 적용해 비율을 고정한다(§5.6).
 */
export function resizeObject(
  base: GeomNode,
  b: Rect,
  handle: number,
  ptScreen: Point,
  shift: boolean,
): GeomNode {
  // 객체 좌표는 전부 **로컬(회전 이전)** 이다 — 회전은 렌더 시점에만 걸린다
  // (geometry.applyObjectTransform). 그러니 배율도 그 프레임에서 구해야 한다.
  // rot=0 이면 rotatePoint 가 항등이라 종전과 1비트도 다르지 않다.
  const pt = rotatePoint(
    ptScreen.x,
    ptScreen.y,
    -base.rot,
    objectAnchor(base),
  );
  const west = handle === 0 || handle === 6 || handle === 7;
  const east = handle === 2 || handle === 3 || handle === 4;
  const north = handle === 0 || handle === 1 || handle === 2;
  const south = handle === 4 || handle === 5 || handle === 6;

  let fx = 1;
  let fy = 1;
  let ox = b.x;
  let oy = b.y;
  if (east && b.w > 0) {
    ox = b.x;
    fx = (pt.x - ox) / b.w;
  } else if (west && b.w > 0) {
    ox = b.x + b.w;
    fx = (ox - pt.x) / b.w;
  }
  if (south && b.h > 0) {
    oy = b.y;
    fy = (pt.y - oy) / b.h;
  } else if (north && b.h > 0) {
    oy = b.y + b.h;
    fy = (oy - pt.y) / b.h;
  }
  if (shift) {
    const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
    // 변 핸들(n/s/e/w)은 한 축 배율만 잡히므로, 비활성 축은 bbox 중심을 원점으로 같은 배율을
    // 건다 — 그래야 마주 보는 변이 양쪽으로 대칭 확대되며 비율이 실제로 고정된다.
    if (!east && !west) ox = b.x + b.w / 2;
    if (!north && !south) oy = b.y + b.h / 2;
    fx = f;
    fy = f;
  }
  // 뒤집기(음수 배율)는 v1 비범위 — 최소 배율로 잡아 둔다.
  const MIN_F = 0.02;
  fx = Math.max(MIN_F, fx);
  fy = Math.max(MIN_F, fy);
  const out = scaleObject(base, fx, fy, ox, oy);
  if (normalizeDeg(base.rot) === 0) return out;
  // 회전 피벗(objectAnchor)은 **기하에서 파생**된다 — 스케일이 그 점을 움직이면 회전 사상
  // 자체가 바뀌어, 로컬 좌표가 맞아도 화면에서는 잡지 않은 변까지 미끄러진다.
  // 앵커 이동분 d 를 회전시킨 만큼(=(R−I)d) 되밀어 화면 고정점을 지킨다.
  const a0 = objectAnchor(base);
  const a1 = objectAnchor(out);
  const dx = a1.x - a0.x;
  const dy = a1.y - a0.y;
  const r = rotatePoint(dx, dy, base.rot, { x: 0, y: 0 });
  return translateObject(out, r.x - dx, r.y - dy);
}

/**
 * 객체 기하를 (ox,oy) 기준으로 늘린다. 선 두께는 사용자가 고른 값이라 건드리지 않고,
 * 텍스트·뱃지는 크기 자체가 글자 크기라 fontSize 를 함께 키운다.
 */
function scaleObject(
  o: GeomNode,
  fx: number,
  fy: number,
  ox: number,
  oy: number,
): GeomNode {
  const sx = (x: number) => ox + (x - ox) * fx;
  const sy = (y: number) => oy + (y - oy) * fy;
  const k = Math.sqrt(Math.abs(fx * fy)) || 1;
  switch (o.kind) {
    case "pen":
    case "highlight": {
      const pts = o.pts.slice();
      for (let i = 0; i + 1 < pts.length; i += 2) {
        pts[i] = sx(pts[i]);
        pts[i + 1] = sy(pts[i + 1]);
      }
      return { ...o, pts };
    }
    case "line":
    case "arrow":
      return {
        ...o,
        x1: sx(o.x1),
        y1: sy(o.y1),
        x2: sx(o.x2),
        y2: sy(o.y2),
      };
    case "rect":
    case "ellipse":
    case "mosaic":
    case "frame": {
      const r = normalizeRect(sx(o.x), sy(o.y), sx(o.x + o.w), sy(o.y + o.h));
      return { ...o, x: r.x, y: r.y, w: r.w, h: r.h };
    }
    case "path":
      // 핸들은 상대 좌표라 배율만 곱한다(원점 이동분은 정점이 이미 흡수한다).
      return {
        ...o,
        subpaths: o.subpaths.map((sub) => ({
          closed: sub.closed,
          verts: sub.verts.map((v) => ({
            ...v,
            x: sx(v.x),
            y: sy(v.y),
            inX: v.inX * fx,
            inY: v.inY * fy,
            outX: v.outX * fx,
            outY: v.outY * fy,
          })),
        })),
      };
    case "text":
    case "badge":
      return {
        ...o,
        x: sx(o.x),
        y: sy(o.y),
        fontSize: Math.max(4, o.fontSize * k),
      };
  }
}

/**
 * 클릭 한 번으로 만드는 텍스트 노드(드래그 드래프트가 아니다).
 * 글자색은 **채우기**다 — v1 의 `stroke` 자리(37 §3.3 매핑표).
 */
export function newTextNode(o: {
  x: number;
  y: number;
  opacity: number;
  fontSize: number;
  fills: Fill[];
}): TextNode {
  return {
    ...emptyBase(newObjId()),
    ...DEFAULT_TEXT_STYLE,
    kind: "text",
    x: o.x,
    y: o.y,
    w: 0,
    h: 0,
    text: "",
    opacity: o.opacity,
    fontSize: o.fontSize,
    fontFamily: FONT_FAMILY,
    fills: o.fills,
    strokeWidth: 0,
  };
}

/** 클릭 한 번으로 만드는 번호 뱃지. "색"은 원 채움이다. */
export function newBadgeNode(o: {
  x: number;
  y: number;
  n: number;
  opacity: number;
  fontSize: number;
  fills: Fill[];
}): BadgeObject {
  return {
    ...emptyBase(newObjId()),
    kind: "badge",
    x: o.x,
    y: o.y,
    n: o.n,
    fontSize: o.fontSize,
    opacity: o.opacity,
    fills: o.fills,
    strokeWidth: 0,
  };
}

/**
 * 새 노드의 공통 필드 기본값. 정규화(schema.normalizeNode)와 **같은 값**을 낸다 —
 * 드래프트는 문서에 바로 커밋되므로 경계를 다시 지나지 않는다.
 */
function emptyBase(id: ObjId) {
  return {
    id,
    parentId: null,
    name: null,
    visible: true,
    locked: false,
    opacity: DEFAULT_OPACITY,
    blend: "normal" as const,
    rot: 0,
    fills: [] as Fill[],
    strokes: [] as Fill[],
    strokeWidth: DEFAULT_STROKE_WIDTH,
    strokeAlign: "center" as const,
    dash: null,
    cap: "round" as const,
    join: "round" as const,
    miterLimit: 4,
    heads: { start: "none" as const, end: "none" as const },
    effects: [],
    constraints: { h: "left" as const, v: "top" as const },
    mask: null,
    exportRows: [],
    styleRefs: {},
  };
}
