// 화면 크롬 — 선택 박스·8핸들·크롭 오버레이·드래그 HUD·마퀴(설계 §5.6).
// 전부 오버레이 캔버스에만 그린다 — 출력 경로(renderScene)에는 없다.

import {
  objectAABB,
  objectAnchor,
  objectBBox,
  rotatePoint,
  isGeomNode,
} from "../../../lib/annotate/geometry";
import {
  DEFAULT_FONT_FAMILY,
  type GeomNode,
  type ObjId,
  type Rect,
} from "../../../lib/annotate/types";
import type { AnnotationLayerProps } from "../AnnotationLayer";
import type { DragState, Point } from "./pointer";

/** 선택 핸들 한 변(css px). */
const HANDLE_CSS = 8;
/** 핸들 집기 허용 반경(css px) — 손가락/트랙패드로도 집히게 넉넉히. */
export const HANDLE_GRAB_CSS = 10;
/** 이보다 작은 드래그는 클릭 오조작으로 보고 객체를 만들지 않는다(oriented px). */
export const MIN_DRAG = 3;

const SELECT_COLOR = "#4fa3ff";

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

/** 선택 바운딩 박스 + 8핸들. 화면 크롬이므로 출력 경로(renderScene)에는 절대 없다(§5.6). */
export function drawSelection(
  ctx: CanvasRenderingContext2D,
  s: AnnotationLayerProps,
  live: readonly GeomNode[] | null,
): void {
  if (!s.selectedIds.length) return;
  const byId = new Map<ObjId, GeomNode>((live ?? []).map((o) => [o.id, o]));
  // 마퀴로 전체 선택이 가능해진 순간 includes 는 매 프레임 O(N·M) 이 된다 — Set 이 같은
  // 커밋에 들어와야 하는 이유다(설계 K2).
  const selSet = new Set(s.selectedIds);
  const sel: GeomNode[] = [];
  for (const o of s.objects) {
    // 컨테이너(그룹·인스턴스)는 기하가 없다 — 선택 상자는 태스크 38 selectBox 가 자손
    // 합집합으로 그린다. 여기서는 리프만 본다.
    if (selSet.has(o.id) && isGeomNode(o)) sel.push(byId.get(o.id) ?? o);
  }
  if (!sel.length) return;
  // 백킹 px / css px — 핸들이 배율과 무관하게 같은 크기로 보이게 한다.
  const k = s.scale / Math.max(s.displayScale, 1e-6);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = Math.max(1, k);
  ctx.setLineDash([4 * k, 3 * k]);
  for (const o of sel) {
    const b = objectAABB(o);
    ctx.strokeRect(b.x * s.scale, b.y * s.scale, b.w * s.scale, b.h * s.scale);
  }
  ctx.setLineDash([]);
  if (sel.length > 1) {
    // 합집합 bbox 는 실선 한 겹. **핸들은 그리지 않는다** — 다중 선택 일괄 리사이즈는 넣지
    // 않기로 했고(설계 §8), 핸들이 보이면 그게 된다고 약속하는 셈이다.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const o of sel) {
      const b = objectAABB(o);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    ctx.strokeRect(
      x0 * s.scale,
      y0 * s.scale,
      (x1 - x0) * s.scale,
      (y1 - y0) * s.scale,
    );
  }
  if (sel.length === 1) {
    const size = HANDLE_CSS * k;
    ctx.fillStyle = "#ffffff";
    for (const h of handlePointsOf(sel[0])) {
      const cx = h.x * s.scale;
      const cy = h.y * s.scale;
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
      ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
    }
  }
  ctx.restore();
}

/** 크롭 오버레이 — 기존 ImageEditor.paint() 에서 이관(§4.3). */
export function drawCropOverlay(
  ctx: CanvasRenderingContext2D,
  s: AnnotationLayerProps,
  preview: Rect | null | undefined,
): void {
  const r = preview !== undefined ? preview : s.cropRect;
  if (!r || r.w <= 0 || r.h <= 0) return;
  const x = r.x * s.scale;
  const y = r.y * s.scale;
  const w = r.w * s.scale;
  const h = r.h * s.scale;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, cw, y);
  ctx.fillRect(0, y + h, cw, ch - (y + h));
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, cw - (x + w), h);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = Math.max(1.5, cw / 400);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/**
 * 드래그 중 수치 — 스냅·가이드 대신 넣은 것이다(설계 K3). 마크업의 정렬 대상은 다른 주석이
 * 아니라 아래 이미지의 UI 요소라 스냅은 "원하는 곳에 못 놓는" 저항이 되지만, 수치는
 * "내가 지금 무엇을 만들고 있는가"를 그냥 알려 준다.
 *
 * **화면 크롬이라 renderScene 을 지나지 않는다** — 저장 파일에 샐 경로가 없다.
 */
export function drawHud(
  ctx: CanvasRenderingContext2D,
  s: AnnotationLayerProps,
  d: DragState | null,
  draft: GeomNode | null,
  live: readonly GeomNode[] | null,
): void {
  if (!d) return;
  let text = "";
  let box: Rect | null = null;

  if (d.mode === "marquee") {
    const r = marqueeRect(d);
    if (r.w < MIN_DRAG && r.h < MIN_DRAG) return;
    text = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    box = r;
  } else if (d.mode === "draw" && draft) {
    // 자유곡선은 폭·높이가 의미를 못 준다 — 아무것도 안 띄운다.
    if (draft.kind === "pen" || draft.kind === "highlight") return;
    box = objectAABB(draft);
    if (draft.kind === "line" || draft.kind === "arrow") {
      const dx = draft.x2 - draft.x1;
      const dy = draft.y2 - draft.y1;
      text = `${Math.round(Math.hypot(dx, dy))} px  ∠${Math.round(
        (Math.atan2(dy, dx) * 180) / Math.PI,
      )}°`;
    } else {
      text = `${Math.round(box.w)} × ${Math.round(box.h)}`;
    }
  } else if (d.mode === "resize" && live && live[0]) {
    box = objectAABB(live[0]);
    text = `${Math.round(box.w)} × ${Math.round(box.h)}`;
  } else if (d.mode === "move" && live && live[0]) {
    // 델타는 로컬 bbox 차이로 구한다 — 상태에 cur 를 더 들고 다닐 필요가 없다.
    const from = objectBBox(d.base[0]);
    const to = objectBBox(live[0]);
    const dx = Math.round(to.x - from.x);
    const dy = Math.round(to.y - from.y);
    // 단순 클릭 선택(pointerdown 이 move 드래그를 세운 직후)에서 "+0 +0" 이 깜빡이는 것을 막는다.
    if (Math.abs(dx) < MIN_DRAG && Math.abs(dy) < MIN_DRAG) return;
    text = `${dx >= 0 ? "+" : ""}${dx}  ${dy >= 0 ? "+" : ""}${dy}`;
    box = objectAABB(live[0]);
  }
  if (!text || !box) return;

  const k = s.scale / Math.max(s.displayScale, 1e-6); // 백킹 px / css px
  const fs = 11 * k;
  const padX = 5 * k;
  const padY = 3 * k;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `${fs}px ${DEFAULT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  const w = ctx.measureText(text).width + padX * 2;
  const h = fs * 1.35 + padY * 2;
  let x = (box.x + box.w) * s.scale + 6 * k;
  let y = (box.y + box.h) * s.scale + 6 * k;
  // 캔버스 밖으로 나가면 안쪽으로 접는다(확대 상태에서도 항상 보이게).
  if (x + w > ctx.canvas.width) x = ctx.canvas.width - w;
  if (y + h > ctx.canvas.height) y = box.y * s.scale - h - 6 * k;
  x = Math.max(0, x);
  y = Math.max(0, y);
  ctx.fillStyle = "rgba(20,20,24,0.85)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x + padX, y + padY);
  ctx.restore();
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

/** 선택 사각형 — 화면 크롬이라 renderScene 에 없다(저장 파일에 샐 수 없다). */
export function drawMarquee(
  ctx: CanvasRenderingContext2D,
  s: AnnotationLayerProps,
  d: DragState | null,
): void {
  if (!d || d.mode !== "marquee") return;
  const r = marqueeRect(d);
  if (r.w < MIN_DRAG && r.h < MIN_DRAG) return;
  const k = s.scale / Math.max(s.displayScale, 1e-6);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgba(79,163,255,0.12)";
  ctx.fillRect(r.x * s.scale, r.y * s.scale, r.w * s.scale, r.h * s.scale);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.lineWidth = Math.max(1, k);
  ctx.setLineDash([4 * k, 3 * k]);
  ctx.strokeRect(r.x * s.scale, r.y * s.scale, r.w * s.scale, r.h * s.scale);
  ctx.restore();
}

/**
 * 8핸들 위치(0 nw, 1 n, 2 ne, 3 e, 4 se, 5 s, 6 sw, 7 w) — **회전 외접 사각형이 아니라
 * 로컬 bbox 위**에 두고 rot 만큼 돌린다.
 *
 * 종전에는 `objectAABB`(회전 외접 사각형)의 모서리를 썼다. rot≠0 이면 그 사각형은 객체보다
 * 크고 축정렬이라, 거기서 뽑은 배율을 회전 이전 좌표에 먹이면 앵커가 포인터로 순간이동했다.
 * 회전된 로컬 모서리는 실제 도형의 모서리라 눈에 보이는 것과 집는 것이 같아진다.
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
