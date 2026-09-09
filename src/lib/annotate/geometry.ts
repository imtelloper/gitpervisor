// 주석 기하 — Path2D 빌더, 바운딩 박스, 히트테스트, 회전/반전 델타 아핀, 좌표 변환 헬퍼.
//
// 이 모듈이 **기하 정의의 단일 소스**다. 렌더러(render.ts)와 히트테스트가 같은 Path2D 빌더를
// 쓰므로 "보이는 모양"과 "집히는 모양"이 구조적으로 어긋날 수 없다(§5.6).
//
// 좌표 규약: 빌더가 만드는 Path2D 는 **객체 로컬 좌표**(= rot 을 적용하지 않은 oriented px)다.
// rot 은 applyObjectTransform() 이 ctx 의 CTM 으로 걸며, 렌더와 히트테스트가 같은 함수를 쓴다.

import type { Scene } from "./scene";
import { layoutText, resizeText } from "./text-layout";
// 패스 기하의 정본은 vector/path.ts 다(46 §3.3). 여기에 지역 근사본을 다시 두면 auto 정점이
// 물질화되지 않고 bbox 가 제어점 헐로 부풀어, 화면(렌더)과 집히는 상자가 어긋난다.
import { pathBounds, pathToPath2D } from "./vector/path";
import {
  ARROW_HEAD_SCALE,
  BADGE_RADIUS_SCALE,
  HIT_TOLERANCE_CSS,
  PEN_MIN_DIST,
  type GeomNode,
  type Node,
  type ObjId,
  type Rect,
  type SceneTransform,
} from "./types";

/**
 * 기하가 있는 노드인가. `group`/`instance` 는 기하가 없어 이 모듈의 함수를 못 받는다 —
 * 컨테이너 AABB 는 자손 합집합으로 파생한다(태스크 38 `tree.nodeAABB`).
 */
export function isGeomNode(n: Node): n is GeomNode {
  return n.kind !== "group" && n.kind !== "instance";
}

const DEG = Math.PI / 180;

/**
 * 히트테스트 전용 1×1 스크래치 컨텍스트. 픽셀을 그리지 않고 isPointInPath/isPointInStroke
 * 만 쓴다(둘 다 CTM·lineWidth 만 참조하며 캔버스 크기와 무관). 글자 측정용 컨텍스트는
 * text-layout.ts 가 따로 든다 — 그쪽은 `font`·`letterSpacing` 을 매번 갈아 끼운다.
 */
let scratch: CanvasRenderingContext2D | null = null;
function scratchCtx(): CanvasRenderingContext2D {
  if (!scratch) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    scratch = c.getContext("2d")!;
  }
  return scratch;
}

/** 각도를 0–359 로 정규화. */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** 두 점에서 좌상단 기준 사각형을 만든다(음수 폭/높이 제거). */
export function normalizeRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Rect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
  };
}

// ── 좌표 변환 헬퍼 ───────────────────────────────────────────────────────────

/** oriented px → 대상 캔버스 px. `(p + t) * s` (§4.1). */
export function orientedToTarget(
  x: number,
  y: number,
  t: SceneTransform,
): { x: number; y: number } {
  return { x: (x + t.tx) * t.sx, y: (y + t.ty) * t.sy };
}

/** 대상 캔버스 px → oriented px (orientedToTarget 의 역). */
export function targetToOriented(
  x: number,
  y: number,
  t: SceneTransform,
): { x: number; y: number } {
  return { x: x / t.sx - t.tx, y: y / t.sy - t.ty };
}

/** ctx 에 SceneTransform 을 건다 — 배율 먼저, 그 다음 크롭 원점 이동. */
export function applySceneTransform(
  ctx: CanvasRenderingContext2D,
  t: SceneTransform,
): void {
  ctx.scale(t.sx, t.sy);
  ctx.translate(t.tx, t.ty);
}

/** 시작점 기준 각도를 step(deg) 단위로 스냅한 끝점(Shift 드래그, §5.2). */
export function snapAngle(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stepDeg: number,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: x2, y: y2 };
  const step = stepDeg * DEG;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: x1 + Math.cos(a) * len, y: y1 + Math.sin(a) * len };
}

// ── Path2D 빌더 (렌더·히트테스트 공용) ───────────────────────────────────────

function penPath(pts: readonly number[]): Path2D {
  const p = new Path2D();
  const n = Math.floor(pts.length / 2);
  if (n === 0) return p;
  if (n === 1) {
    // 점 하나 — 길이 0 의 선분은 그려지지 않으므로 아주 짧게 늘려 round cap 이 점을 찍게 한다.
    p.moveTo(pts[0], pts[1]);
    p.lineTo(pts[0] + 0.01, pts[1]);
    return p;
  }
  p.moveTo(pts[0], pts[1]);
  if (n === 2) {
    p.lineTo(pts[2], pts[3]);
    return p;
  }
  // midpoint 이차 베지어 — 점 배열을 그대로 폴리라인으로 이으면 각져 보인다(§4.4).
  for (let i = 1; i < n - 1; i++) {
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const mx = (cx + pts[(i + 1) * 2]) / 2;
    const my = (cy + pts[(i + 1) * 2 + 1]) / 2;
    p.quadraticCurveTo(cx, cy, mx, my);
  }
  p.lineTo(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1]);
  return p;
}

/**
 * 모서리 반경 사각형 — Path2D.roundRect 는 런타임 편차가 있어 arcTo 로 직접 만든다.
 * 반경은 [tl, tr, br, bl] 넷을 각각 받는다(시안 ① `↖8 ↗8 ↘8 ↙8`).
 */
function roundRectPath(
  p: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: readonly [number, number, number, number],
): void {
  const lim = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const tl = Math.max(0, Math.min(radius[0], lim));
  const tr = Math.max(0, Math.min(radius[1], lim));
  const br = Math.max(0, Math.min(radius[2], lim));
  const bl = Math.max(0, Math.min(radius[3], lim));
  if (tl <= 0 && tr <= 0 && br <= 0 && bl <= 0) {
    p.rect(x, y, w, h);
    return;
  }
  p.moveTo(x + tl, y);
  p.lineTo(x + w - tr, y);
  p.arcTo(x + w, y, x + w, y + tr, tr);
  p.lineTo(x + w, y + h - br);
  p.arcTo(x + w, y + h, x + w - br, y + h, br);
  p.lineTo(x + bl, y + h);
  p.arcTo(x, y + h, x, y + h - bl, bl);
  p.lineTo(x, y + tl);
  p.arcTo(x, y, x + tl, y, tl);
  p.closePath();
}

/**
 * 객체의 기하를 **로컬 좌표**(rot 미적용 oriented px) Path2D 로 만든다.
 * 화살촉·텍스트 글리프처럼 "장식"에 해당하는 부분은 포함하지 않는다 — 렌더러가 덧그리고,
 * 히트테스트는 본체만 있으면 충분하다.
 */
const pathMemo = new WeakMap<GeomNode, Path2D>();

/**
 * 로컬 좌표 Path2D. **노드 참조로 메모**한다 — 커밋된 노드는 불변이라(types.ts 규약) 같은
 * 참조면 같은 경로다. 드래그 중 라이브 객체는 매 틱 새 참조라 종전처럼 매번 만든다(비용 동일).
 *
 * 이 메모가 있어야 hover 히트테스트를 매 pointermove 마다 부를 수 있다(태스크 43 스냅·커서).
 */
export function buildObjectPath(o: GeomNode): Path2D {
  const memo = pathMemo.get(o);
  if (memo) return memo;
  const built = buildObjectPathUncached(o);
  pathMemo.set(o, built);
  return built;
}

function buildObjectPathUncached(o: GeomNode): Path2D {
  const p = new Path2D();
  switch (o.kind) {
    case "pen":
    case "highlight":
      return penPath(o.pts);
    case "line":
    case "arrow":
      p.moveTo(o.x1, o.y1);
      p.lineTo(o.x2, o.y2);
      return p;
    case "rect":
      roundRectPath(p, o.x, o.y, o.w, o.h, o.radius);
      return p;
    case "ellipse":
      p.ellipse(
        o.x + o.w / 2,
        o.y + o.h / 2,
        Math.abs(o.w) / 2,
        Math.abs(o.h) / 2,
        0,
        0,
        Math.PI * 2,
      );
      return p;
    case "mosaic":
      p.rect(o.x, o.y, o.w, o.h);
      return p;
    case "text": {
      // 상자는 `layoutText` 가 정하는 **하나**다 — 여기서 따로 재면 집히는 곳이 보이는 곳과
      // 어긋난다(정렬·박스 모드·말줄임이 전부 그 상자에서 나온다).
      const b = layoutText(o).box;
      p.rect(o.x + b.x, o.y + b.y, b.w, b.h);
      return p;
    }
    case "badge": {
      const r = BADGE_RADIUS_SCALE * o.fontSize;
      p.arc(o.x, o.y, r, 0, Math.PI * 2);
      return p;
    }
    case "path":
      return pathToPath2D(o);
    case "frame":
      roundRectPath(p, o.x, o.y, o.w, o.h, o.radius);
      return p;
  }
}

// ── 앵커 · 바운딩 박스 ───────────────────────────────────────────────────────

/** 회전 피벗. 도형은 중심, 텍스트·뱃지는 앵커 자신, 선은 중점. */
export function objectAnchor(o: GeomNode): { x: number; y: number } {
  switch (o.kind) {
    case "pen":
    case "highlight": {
      const b = penBounds(o.pts);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    case "line":
    case "arrow":
      return { x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 };
    case "rect":
    case "ellipse":
    case "mosaic":
    case "frame":
      return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    case "text":
    case "badge":
      return { x: o.x, y: o.y };
    case "path": {
      const b = pathBounds(o);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
  }
}

function penBounds(pts: readonly number[]): Rect {
  if (pts.length < 2) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = pts[0];
  let y0 = pts[1];
  let x1 = pts[0];
  let y1 = pts[1];
  for (let i = 2; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    x1 = Math.max(x1, pts[i]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

/** 회전 전(로컬) 바운딩 박스 — 선 두께까지 포함한다. */
export function objectBBox(o: GeomNode): Rect {
  switch (o.kind) {
    case "pen":
    case "highlight":
      return inflate(penBounds(o.pts), o.strokeWidth / 2);
    case "line":
    case "arrow": {
      const r = normalizeRect(o.x1, o.y1, o.x2, o.y2);
      // 화살촉이 선 끝 바깥으로 퍼지므로 머리 길이의 절반만큼 더 넉넉히 잡는다.
      const pad =
        o.kind === "arrow"
          ? (ARROW_HEAD_SCALE * o.strokeWidth) / 2
          : o.strokeWidth / 2;
      return inflate(r, pad);
    }
    case "rect":
    case "ellipse":
      return inflate(
        normalizeRect(o.x, o.y, o.x + o.w, o.y + o.h),
        o.strokeWidth / 2,
      );
    case "mosaic":
      return normalizeRect(o.x, o.y, o.x + o.w, o.y + o.h);
    case "text": {
      const b = layoutText(o).box;
      return { x: o.x + b.x, y: o.y + b.y, w: b.w, h: b.h };
    }
    case "badge": {
      const r = BADGE_RADIUS_SCALE * o.fontSize + o.strokeWidth / 2;
      return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
    }
    case "path":
      return inflate(pathBounds(o), o.strokeWidth / 2);
    case "frame":
      return inflate(normalizeRect(o.x, o.y, o.x + o.w, o.y + o.h), o.strokeWidth / 2);
  }
}

/**
 * (px,py) 를 앵커 기준으로 `deg` 만큼 돈 점. `applyObjectTransform` 이 캔버스에 거는 것과
 * **같은 회전**이므로, 이 함수와 그 함수는 항상 짝으로 움직여야 한다.
 *
 * `deg` 를 음수로 주면 화면 좌표를 객체의 **로컬(회전 이전) 프레임**으로 되돌린다 —
 * 객체 좌표가 전부 로컬이라(회전은 렌더 시점에만 걸린다) 리사이즈 배율은 그 프레임에서
 * 구해야 맞는다.
 */
export function rotatePoint(
  px: number,
  py: number,
  deg: number,
  a: { x: number; y: number },
): { x: number; y: number } {
  if (normalizeDeg(deg) === 0) return { x: px, y: py };
  const rad = deg * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - a.x;
  const dy = py - a.y;
  return { x: a.x + dx * cos - dy * sin, y: a.y + dx * sin + dy * cos };
}

/** rot 을 적용한 축정렬 외접 사각형(oriented px). */
export function objectAABB(o: GeomNode): Rect {
  const b = objectBBox(o);
  if (normalizeDeg(o.rot) === 0) return b;
  const a = objectAnchor(o);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ]) {
    const q = rotatePoint(px, py, o.rot, a);
    xs.push(q.x);
    ys.push(q.y);
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

// ── 히트테스트 ───────────────────────────────────────────────────────────────

/**
 * 객체 로컬 → oriented 변환을 현재 ctx CTM 에 곱한다(앵커 기준 rot).
 * 렌더와 히트테스트가 같은 함수를 쓰므로 rot 처리가 어긋날 수 없다.
 */
export function applyObjectTransform(
  ctx: CanvasRenderingContext2D,
  o: GeomNode,
): void {
  if (normalizeDeg(o.rot) === 0) return;
  const a = objectAnchor(o);
  ctx.translate(a.x, a.y);
  ctx.rotate(o.rot * DEG);
  ctx.translate(-a.x, -a.y);
}

/**
 * 내부를 채우는 객체인가(= isPointInPath 로 집을 수 있는가).
 *
 * v1 의 `fill !== null` 판정과 결과가 같다 — 정규화가 `fill:null` 을 빈 `fills` 로 보낸다.
 * 텍스트·모자이크는 채우기 스택과 무관하게 몸통 전체가 집힌다(글자·가림 영역).
 */
function hasInterior(o: GeomNode): boolean {
  switch (o.kind) {
    case "text":
    case "mosaic":
      return true;
    default:
      return o.fills.some((f) => f.visible);
  }
}

/** 테두리를 그리는 객체인가(= isPointInStroke 로 집을 수 있는가). */
function hasOutline(o: GeomNode): boolean {
  switch (o.kind) {
    case "text":
    case "mosaic":
      return false;
    default:
      return o.strokes.some((f) => f.visible) && o.strokeWidth > 0;
  }
}

/**
 * oriented px 점 (x,y) 가 어느 객체 위인지 찾는다. **위에서부터(마지막에 그린 것부터)** 훑고
 * 첫 히트를 채택한다. `scale` 은 프리뷰 배율 s — 얇은 선도 집을 수 있도록 스트로크 허용오차를
 * `max(strokeWidth, 10/s)` 로 넓힌다(§5.6).
 *
 * @returns 히트한 인덱스, 없으면 -1.
 */
export function hitTestIndex(
  objects: readonly Node[],
  x: number,
  y: number,
  scale: number,
): number {
  const ctx = scratchCtx();
  const tol = HIT_TOLERANCE_CSS / Math.max(scale, 1e-6);
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    // 그룹·인스턴스는 기하가 없다 — 자손 리프가 대신 집힌다(선택 단위 승격은 태스크 38 hitTest).
    if (!isGeomNode(o)) continue;
    const path = buildObjectPath(o);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyObjectTransform(ctx, o);
    let hit = hasInterior(o) && ctx.isPointInPath(path, x, y);
    if (!hit && hasOutline(o)) {
      ctx.lineWidth = Math.max(o.strokeWidth, tol);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      hit = ctx.isPointInStroke(path, x, y);
    }
    ctx.restore();
    if (hit) return i;
  }
  return -1;
}

// ── 회전 · 반전 델타 아핀 (§3.2) ─────────────────────────────────────────────

/** oriented 공간을 바꾸는 연산. `w`,`h` 는 **변환 이전**의 oriented 크기다. */
export type OrientDelta = "rotCW" | "rotCCW" | "flipH" | "flipV";

/** §3.2 표의 점 변환 4종. */
export function transformPoint(
  x: number,
  y: number,
  delta: OrientDelta,
  w: number,
  h: number,
): { x: number; y: number } {
  switch (delta) {
    case "rotCW":
      return { x: h - y, y: x };
    case "rotCCW":
      return { x: y, y: w - x };
    case "flipH":
      return { x: w - x, y };
    case "flipV":
      return { x, y: h - y };
  }
}

/**
 * 이미지 회전/반전에 맞춰 주석 기하를 새 oriented 공간으로 옮긴다(§3.2). 객체는 불변 갱신.
 *
 * 규칙 R-ROT:
 * - 점이 여럿인 객체(펜·선·도형)는 **모든 점을 옮기면 회전이 기하에 흡수**되므로 `rot` 은
 *   그대로 두고, 반전에서만 `rot → −rot` 으로 뒤집는다. 사각형·타원은 두 꼭짓점을 옮긴 뒤
 *   재정규화하므로 축 정렬이 보존되고 `x,y,w,h` 만 바뀐다.
 * - 앵커 하나뿐인 텍스트·뱃지는 회전을 기하가 흡수할 수 없으므로 `rot ± 90` 으로 함께 눕고,
 *   반전에서는 **앵커만 미러링하고 `rot → −rot`** 으로 글자가 거울로 뒤집히지 않게 한다.
 *
 * @param w 변환 이전 oriented 폭
 * @param h 변환 이전 oriented 높이
 */
export function transformObjects(
  objects: readonly Node[],
  delta: OrientDelta,
  w: number,
  h: number,
): Node[] {
  const isFlip = delta === "flipH" || delta === "flipV";
  const P = (x: number, y: number) => transformPoint(x, y, delta, w, h);
  return objects.map((o): Node => {
    const rotOfShape = normalizeDeg(isFlip ? -o.rot : o.rot);
    // 컨테이너는 기하가 없다 — 자손 리프가 각자 옮겨지면 그룹도 따라 움직인 것과 같다.
    if (!isGeomNode(o)) return o;
    switch (o.kind) {
      case "pen":
      case "highlight": {
        const pts = new Array<number>(o.pts.length);
        for (let i = 0; i + 1 < o.pts.length; i += 2) {
          const p = P(o.pts[i], o.pts[i + 1]);
          pts[i] = p.x;
          pts[i + 1] = p.y;
        }
        return { ...o, pts, rot: rotOfShape };
      }
      case "line":
      case "arrow": {
        const a = P(o.x1, o.y1);
        const b = P(o.x2, o.y2);
        return { ...o, x1: a.x, y1: a.y, x2: b.x, y2: b.y, rot: rotOfShape };
      }
      case "rect":
      case "ellipse":
      case "mosaic":
      case "frame": {
        const a = P(o.x, o.y);
        const b = P(o.x + o.w, o.y + o.h);
        const r = normalizeRect(a.x, a.y, b.x, b.y);
        return { ...o, x: r.x, y: r.y, w: r.w, h: r.h, rot: rotOfShape };
      }
      case "path": {
        // 정점과 핸들을 함께 옮긴다. 핸들은 **상대** 좌표라 원점을 뺀 차분으로 변환한다
        // (평행이동 성분이 두 번 들어가면 곡선이 어긋난다).
        const o0 = P(0, 0);
        const D = (dx: number, dy: number) => {
          const q = P(dx, dy);
          return { x: q.x - o0.x, y: q.y - o0.y };
        };
        return {
          ...o,
          rot: rotOfShape,
          subpaths: o.subpaths.map((sub) => ({
            closed: sub.closed,
            verts: sub.verts.map((v) => {
              const q = P(v.x, v.y);
              const i = D(v.inX, v.inY);
              const t = D(v.outX, v.outY);
              return { ...v, x: q.x, y: q.y, inX: i.x, inY: i.y, outX: t.x, outY: t.y };
            }),
          })),
        };
      }
      case "text":
      case "badge": {
        const a = P(o.x, o.y);
        const rot = isFlip
          ? -o.rot
          : delta === "rotCW"
            ? o.rot + 90
            : o.rot - 90;
        return { ...o, x: a.x, y: a.y, rot: normalizeDeg(rot) };
      }
    }
  });
}

/** 객체를 평행이동한 새 객체(드래그 이동·복제). */
export function translateObject<T extends GeomNode>(
  o: T,
  dx: number,
  dy: number,
): T {
  switch (o.kind) {
    case "pen":
    case "highlight": {
      const pts = o.pts.slice();
      for (let i = 0; i + 1 < pts.length; i += 2) {
        pts[i] += dx;
        pts[i + 1] += dy;
      }
      return { ...o, pts };
    }
    case "line":
    case "arrow":
      return {
        ...o,
        x1: o.x1 + dx,
        y1: o.y1 + dy,
        x2: o.x2 + dx,
        y2: o.y2 + dy,
      };
    case "path":
      // 핸들은 상대 좌표라 그대로 둔다 — 정점만 옮기면 곡선 모양이 보존된다.
      return {
        ...o,
        subpaths: o.subpaths.map((sub) => ({
          closed: sub.closed,
          verts: sub.verts.map((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
        })),
      };
    default:
      return { ...o, x: o.x + dx, y: o.y + dy };
  }
}

// ── 펜 점 데시메이션 (§4.4) ──────────────────────────────────────────────────

/** 직전 점과 `minDist`(oriented px) 이상 떨어졌을 때만 참. */
export function shouldKeepPenPoint(
  pts: readonly number[],
  x: number,
  y: number,
  minDist: number = PEN_MIN_DIST,
): boolean {
  if (pts.length < 2) return true;
  const dx = x - pts[pts.length - 2];
  const dy = y - pts[pts.length - 1];
  return dx * dx + dy * dy >= minDist * minDist;
}

/**
 * 드래프트 점 배열에 점을 덧붙인다. 임계 미만이면 버리고 false 를 돌려준다.
 * **드래프트는 아직 커밋 전이므로 제자리 변경한다** — 포인터 이벤트마다 배열을 복제하면
 * O(n²) 가 된다. 커밋(pointerup) 시점에 새 객체로 굳히는 것은 호출부 몫이다.
 */
export function appendPenPoint(
  pts: number[],
  x: number,
  y: number,
  minDist: number = PEN_MIN_DIST,
): boolean {
  if (!shouldKeepPenPoint(pts, x, y, minDist)) return false;
  pts.push(x, y);
  return true;
}

/** 이미 쌓인 점 배열을 사후 데시메이션(외부에서 주입된 궤적 정리용). */
export function decimatePoints(
  pts: readonly number[],
  minDist: number = PEN_MIN_DIST,
): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (shouldKeepPenPoint(out, pts[i], pts[i + 1], minDist)) {
      out.push(pts[i], pts[i + 1]);
    }
  }
  // 마지막 점은 획의 끝이므로 데시메이션으로 잃지 않는다.
  const n = pts.length;
  if (n >= 2 && (out.length < 2 || out[out.length - 2] !== pts[n - 2] || out[out.length - 1] !== pts[n - 1])) {
    out.push(pts[n - 2], pts[n - 1]);
  }
  return out;
}

// ── 씬 기하 (태스크 38) ──────────────────────────────────────────────────────
//
// 여기부터는 **Scene**(scene.ts 가 숨김·잠금·마스크를 푼 결과) 위에서 동작한다. 문서 배열을
// 직접 받는 함수와 섞이지 않게 구획을 나눠 둔다 — 씬을 안 지나면 숨긴 노드가 살아난다.

/**
 * 효과가 노드 밖으로 번지는 거리(oriented px).
 *
 * 흐림 반경 규약은 렌더(태스크 39)와 **같은 상수**를 쓴다: 섀도 blur B → 1.5B, 레이어 블러
 * 반경 R → 1.5R. 이너 섀도는 안쪽이라 0, 배경 블러는 노드 영역 안의 배경만 건드리므로 0이다.
 */
export function effectReach(node: GeomNode): number {
  let reach = 0;
  for (const e of node.effects) {
    if (!e.visible) continue;
    if (e.type === "drop-shadow") {
      reach = Math.max(reach, Math.hypot(e.x, e.y) + 1.5 * e.blur + Math.max(0, e.spread));
    } else if (e.type === "layer-blur") {
      reach = Math.max(reach, 1.5 * e.radius);
    }
  }
  return reach;
}

function intersectRect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * 화면에 실제로 나타나는 범위 — AABB ⊕ 효과 여백, 프레임 클립으로 잘린 뒤.
 * 태스크 39 의 격리 스크래치 크기와 43 의 선택 크롬 여백이 이 값을 믿는다.
 */
export function visualBounds(scene: Scene, id: ObjId): Rect {
  const node = scene.nodes.find((n) => n.id === id);
  if (!node) return { x: 0, y: 0, w: 0, h: 0 };
  const box = objectAABB(node);
  const r = effectReach(node);
  let out = r > 0 ? { x: box.x - r, y: box.y - r, w: box.w + r * 2, h: box.h + r * 2 } : box;
  // 조상 프레임이 내용을 자르면 거기서 잘린다.
  for (const c of scene.containers) {
    if (!c.clip) continue;
    const at = scene.nodes.indexOf(node);
    if (at < c.range[0] || at >= c.range[1]) continue;
    out = intersectRect(out, c.clip);
  }
  return out;
}

/**
 * 선택 상자. 리프 하나면 **회전 상자**(로컬 bbox + rot), 여럿이거나 컨테이너면 축정렬 합집합이다.
 * 그룹 자체의 회전각은 보존하지 않는다(INDEX §10.5 — 리프 세계 좌표 단일의 대가).
 */
export function selectBox(
  scene: Scene,
  ids: readonly ObjId[],
): { rect: Rect; rot: number } {
  const picked = scene.nodes.filter((n) => ids.includes(n.id));
  if (picked.length === 1) {
    return { rect: objectBBox(picked[0]), rot: picked[0].rot };
  }
  // 컨테이너가 선택됐으면 그 자손이 씬에 있으므로 owner 를 타고 모은다.
  const wanted = new Set(ids);
  const inSelection = (n: GeomNode): boolean => {
    let cur: ObjId | null = n.id;
    for (let guard = 0; cur && guard <= scene.nodes.length; guard++) {
      if (wanted.has(cur)) return true;
      cur = scene.owner.get(cur) ?? null;
    }
    return false;
  };
  let box: Rect | null = null;
  for (const n of scene.nodes) {
    if (!inSelection(n)) continue;
    const b = objectAABB(n);
    box = box
      ? {
          x: Math.min(box.x, b.x),
          y: Math.min(box.y, b.y),
          w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
          h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y),
        }
      : b;
  }
  return { rect: box ?? { x: 0, y: 0, w: 0, h: 0 }, rot: 0 };
}

/**
 * 씬 히트테스트 — 위(뒤)에서부터 첫 적중.
 *
 * 기본은 적중 리프의 **최상위 조상**을 돌려준다(클릭 = 그룹 단위, Figma 관례). 더블클릭이나
 * `scope` 를 주면 그 안으로 들어간다. 잠긴 노드는 건너뛰고, 마스크 범위 밖 픽셀은 적중하지 않는다.
 */
export function hitTest(
  scene: Scene,
  x: number,
  y: number,
  scale: number,
  opts?: { deep?: boolean; scope?: ObjId | null },
): ObjId | null {
  const ctx = scratchCtx();
  const tol = HIT_TOLERANCE_CSS / Math.max(scale, 1e-6);
  const scope = opts?.scope ?? null;
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const o = scene.nodes[i];
    if (scene.flags.get(o.id)?.locked) continue;
    if (scope !== null && !isInside(scene, o.id, scope)) continue;
    if (!maskAllows(scene, i, x, y, ctx)) continue;
    const path = buildObjectPath(o);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyObjectTransform(ctx, o);
    let hit = hasInterior(o) && ctx.isPointInPath(path, x, y);
    if (!hit && hasOutline(o)) {
      ctx.lineWidth = Math.max(o.strokeWidth, tol);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      hit = ctx.isPointInStroke(path, x, y);
    }
    ctx.restore();
    if (!hit) continue;
    if (opts?.deep || scope !== null) return o.id;
    return topOwnerOf(scene, o.id);
  }
  return null;
}

/** 자기 또는 조상 중에 `ancestor` 가 있는가. */
function isInside(scene: Scene, id: ObjId, ancestor: ObjId): boolean {
  let cur: ObjId | null = scene.owner.get(id) ?? null;
  for (let guard = 0; cur && guard <= scene.nodes.length; guard++) {
    if (cur === ancestor) return true;
    cur = scene.owner.get(cur) ?? null;
  }
  return false;
}

/** 최상위 조상(없으면 자기). */
function topOwnerOf(scene: Scene, id: ObjId): ObjId {
  let cur = id;
  for (let guard = 0; guard <= scene.nodes.length; guard++) {
    const p = scene.owner.get(cur) ?? null;
    if (p === null) return cur;
    cur = p;
  }
  return cur;
}

/** 마스크가 가리는 범위 안의 노드는 마스크 모양 밖에서 적중하지 않는다. */
function maskAllows(
  scene: Scene,
  sceneIndex: number,
  x: number,
  y: number,
  ctx: CanvasRenderingContext2D,
): boolean {
  for (const c of scene.containers) {
    const m = c.mask;
    if (!m) continue;
    if (sceneIndex < m.range[0] || sceneIndex >= m.range[1]) continue;
    const mask = scene.nodes.find((n) => n.id === m.maskId);
    if (!mask) continue;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyObjectTransform(ctx, mask);
    const inside = ctx.isPointInPath(buildObjectPath(mask), x, y);
    ctx.restore();
    if (inside === m.invert) return false;
  }
  return true;
}

/** 인스펙터가 읽고 쓰는 위치·크기(태스크 45). 피벗은 `objectAnchor` 다. */
export function objectFrame(node: GeomNode): { x: number; y: number; w: number; h: number; rot: number } {
  switch (node.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
    case "frame":
      return { x: node.x, y: node.y, w: node.w, h: node.h, rot: node.rot };
    default: {
      // 선 두께를 뺀 기하 자체의 상자 — 폭을 물으면 도형 크기를 답해야 한다.
      const b = objectBBox(node);
      const pad = node.kind === "text" ? 0 : node.strokeWidth / 2;
      return { x: b.x + pad, y: b.y + pad, w: Math.max(0, b.w - pad * 2), h: Math.max(0, b.h - pad * 2), rot: node.rot };
    }
  }
}

/**
 * 프레임을 그대로 맞춘다 — 이동은 평행이동, 크기는 기준점(좌상단) 고정 배율.
 * 기하 종류별 특수 코드를 여기 두지 않으려고 `translateObject` + 배율 합성으로만 만든다.
 */
export function setObjectFrame(
  node: GeomNode,
  f: Partial<{ x: number; y: number; w: number; h: number; rot: number }>,
): GeomNode {
  const cur = objectFrame(node);
  let out: GeomNode = node;
  const nw = f.w === undefined ? cur.w : Math.max(0, f.w);
  const nh = f.h === undefined ? cur.h : Math.max(0, f.h);
  if ((nw !== cur.w || nh !== cur.h) && cur.w > 0 && cur.h > 0) {
    // 텍스트는 배율이 아니다 — 인스펙터 W 를 한 번 건드릴 때마다 글꼴 크기가 조용히 따라
    // 커지면 사용자가 고른 "14" 가 의미를 잃는다(49 §3.6). 폭만 주면 높이는 자동(동쪽 핸들),
    // 둘 다 주면 고정 상자(남동 핸들)로 — 좌상단 고정이라 이 함수의 규약과 같다.
    out =
      node.kind === "text"
        ? resizeText(node, { w: nw, h: nh }, f.h === undefined ? "E" : "SE")
        : scaleGeom(out, nw / cur.w, nh / cur.h, cur.x, cur.y);
  }
  const after = objectFrame(out);
  const dx = (f.x === undefined ? cur.x : f.x) - after.x;
  const dy = (f.y === undefined ? cur.y : f.y) - after.y;
  if (dx !== 0 || dy !== 0) out = translateObject(out, dx, dy);
  if (f.rot !== undefined) out = { ...out, rot: normalizeDeg(f.rot) };
  return out;
}

/** (ox,oy) 기준 배율. 텍스트·뱃지는 크기 자체가 글자 크기라 fontSize 를 함께 키운다. */
function scaleGeom(o: GeomNode, fx: number, fy: number, ox: number, oy: number): GeomNode {
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
      return { ...o, x1: sx(o.x1), y1: sy(o.y1), x2: sx(o.x2), y2: sy(o.y2) };
    case "rect":
    case "ellipse":
    case "mosaic":
    case "frame": {
      const r = normalizeRect(sx(o.x), sy(o.y), sx(o.x + o.w), sy(o.y + o.h));
      return { ...o, x: r.x, y: r.y, w: r.w, h: r.h };
    }
    case "path":
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
      return { ...o, x: sx(o.x), y: sy(o.y), fontSize: Math.max(4, o.fontSize * k) };
  }
}

/**
 * 프레임이 리사이즈될 때 자식을 제약(시안 ① `좌·상 고정`)대로 재배치한다.
 * `scale` 은 비례, `stretch` 는 양끝을 프레임 변에 붙인다.
 */
export function applyConstraints(child: GeomNode, oldFrame: Rect, newFrame: Rect): GeomNode {
  const f = objectFrame(child);
  const { h, v } = child.constraints;
  const axis = (
    mode: "left" | "right" | "top" | "bottom" | "center" | "scale" | "stretch",
    pos: number,
    size: number,
    o0: number,
    s0: number,
    o1: number,
    s1: number,
  ): { pos: number; size: number } => {
    const leadOld = pos - o0;
    const trailOld = o0 + s0 - (pos + size);
    switch (mode) {
      case "left":
      case "top":
        return { pos: o1 + leadOld, size };
      case "right":
      case "bottom":
        return { pos: o1 + s1 - trailOld - size, size };
      case "center": {
        const centerRatio = (pos + size / 2 - o0) / (s0 || 1);
        return { pos: o1 + centerRatio * s1 - size / 2, size };
      }
      case "scale": {
        const k = s1 / (s0 || 1);
        return { pos: o1 + leadOld * k, size: size * k };
      }
      case "stretch":
        return { pos: o1 + leadOld, size: Math.max(0, s1 - leadOld - trailOld) };
    }
  };
  const hx = axis(h, f.x, f.w, oldFrame.x, oldFrame.w, newFrame.x, newFrame.w);
  const vy = axis(v, f.y, f.h, oldFrame.y, oldFrame.h, newFrame.y, newFrame.h);
  return setObjectFrame(child, { x: hx.pos, y: vy.pos, w: hx.size, h: vy.size });
}
