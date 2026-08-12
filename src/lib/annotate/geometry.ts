// 주석 기하 — Path2D 빌더, 바운딩 박스, 히트테스트, 회전/반전 델타 아핀, 좌표 변환 헬퍼.
//
// 이 모듈이 **기하 정의의 단일 소스**다. 렌더러(render.ts)와 히트테스트가 같은 Path2D 빌더를
// 쓰므로 "보이는 모양"과 "집히는 모양"이 구조적으로 어긋날 수 없다(§5.6).
//
// 좌표 규약: 빌더가 만드는 Path2D 는 **객체 로컬 좌표**(= rot 을 적용하지 않은 oriented px)다.
// rot 은 applyObjectTransform() 이 ctx 의 CTM 으로 걸며, 렌더와 히트테스트가 같은 함수를 쓴다.

import {
  ARROW_HEAD_SCALE,
  BADGE_RADIUS_SCALE,
  HIT_TOLERANCE_CSS,
  PEN_MIN_DIST,
  TEXT_LINE_HEIGHT,
  type AnnoObject,
  type Rect,
  type SceneTransform,
  type TextObject,
} from "./types";

const DEG = Math.PI / 180;

/**
 * 측정·히트테스트 전용 1×1 스크래치 컨텍스트. 픽셀을 그리지 않고 measureText 와
 * isPointInPath/isPointInStroke 만 쓴다(둘 다 CTM·lineWidth 만 참조하며 캔버스 크기와 무관).
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

// ── 텍스트 레이아웃 ──────────────────────────────────────────────────────────

/** 캔버스 font 축약 문자열. textarea 오버레이도 같은 family/size 를 쓴다(§5.5). */
export function fontStringOf(
  fontSize: number,
  fontFamily: string,
  weight: number | string = 400,
): string {
  return `${weight} ${fontSize}px ${fontFamily}`;
}

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  width: number;
  height: number;
}

/** 텍스트 객체의 줄 나눔과 실측 크기(앵커 기준 좌상단 정렬). */
export function layoutText(o: TextObject): TextLayout {
  const ctx = scratchCtx();
  ctx.font = fontStringOf(o.fontSize, o.fontFamily);
  const lines = o.text.length ? o.text.split("\n") : [""];
  let width = 0;
  for (const line of lines) {
    width = Math.max(width, ctx.measureText(line).width);
  }
  const lineHeight = o.fontSize * TEXT_LINE_HEIGHT;
  return { lines, lineHeight, width, height: lineHeight * lines.length };
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

/** 모서리 반경 사각형 — Path2D.roundRect 는 런타임 편차가 있어 arcTo 로 직접 만든다. */
function roundRectPath(
  p: Path2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2));
  if (r <= 0) {
    p.rect(x, y, w, h);
    return;
  }
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.arcTo(x + w, y, x + w, y + r, r);
  p.lineTo(x + w, y + h - r);
  p.arcTo(x + w, y + h, x + w - r, y + h, r);
  p.lineTo(x + r, y + h);
  p.arcTo(x, y + h, x, y + h - r, r);
  p.lineTo(x, y + r);
  p.arcTo(x, y, x + r, y, r);
  p.closePath();
}

/**
 * 객체의 기하를 **로컬 좌표**(rot 미적용 oriented px) Path2D 로 만든다.
 * 화살촉·텍스트 글리프처럼 "장식"에 해당하는 부분은 포함하지 않는다 — 렌더러가 덧그리고,
 * 히트테스트는 본체만 있으면 충분하다.
 */
export function buildObjectPath(o: AnnoObject): Path2D {
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
      const m = layoutText(o);
      p.rect(o.x, o.y, m.width, m.height);
      return p;
    }
    case "badge": {
      const r = BADGE_RADIUS_SCALE * o.fontSize;
      p.arc(o.x, o.y, r, 0, Math.PI * 2);
      return p;
    }
  }
}

// ── 앵커 · 바운딩 박스 ───────────────────────────────────────────────────────

/** 회전 피벗. 도형은 중심, 텍스트·뱃지는 앵커 자신, 선은 중점. */
export function objectAnchor(o: AnnoObject): { x: number; y: number } {
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
      return { x: o.x + o.w / 2, y: o.y + o.h / 2 };
    case "text":
    case "badge":
      return { x: o.x, y: o.y };
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
export function objectBBox(o: AnnoObject): Rect {
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
      const m = layoutText(o);
      return { x: o.x, y: o.y, w: m.width, h: m.height };
    }
    case "badge": {
      const r = BADGE_RADIUS_SCALE * o.fontSize + o.strokeWidth / 2;
      return { x: o.x - r, y: o.y - r, w: r * 2, h: r * 2 };
    }
  }
}

/** rot 을 적용한 축정렬 외접 사각형(oriented px). */
export function objectAABB(o: AnnoObject): Rect {
  const b = objectBBox(o);
  if (normalizeDeg(o.rot) === 0) return b;
  const a = objectAnchor(o);
  const rad = o.rot * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ]) {
    const dx = px - a.x;
    const dy = py - a.y;
    xs.push(a.x + dx * cos - dy * sin);
    ys.push(a.y + dx * sin + dy * cos);
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
  o: AnnoObject,
): void {
  if (normalizeDeg(o.rot) === 0) return;
  const a = objectAnchor(o);
  ctx.translate(a.x, a.y);
  ctx.rotate(o.rot * DEG);
  ctx.translate(-a.x, -a.y);
}

/** 내부를 채우는 객체인가(= isPointInPath 로 집을 수 있는가). */
function hasInterior(o: AnnoObject): boolean {
  switch (o.kind) {
    case "rect":
    case "ellipse":
      return o.fill !== null;
    case "text":
    case "badge":
    case "mosaic":
      return true;
    default:
      return false;
  }
}

/** 테두리를 그리는 객체인가(= isPointInStroke 로 집을 수 있는가). */
function hasOutline(o: AnnoObject): boolean {
  switch (o.kind) {
    case "text":
    case "mosaic":
      return false;
    default:
      return true;
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
  objects: readonly AnnoObject[],
  x: number,
  y: number,
  scale: number,
): number {
  const ctx = scratchCtx();
  const tol = HIT_TOLERANCE_CSS / Math.max(scale, 1e-6);
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
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

/** hitTestIndex 의 객체 반환 버전. */
export function hitTest(
  objects: readonly AnnoObject[],
  x: number,
  y: number,
  scale: number,
): AnnoObject | null {
  const i = hitTestIndex(objects, x, y, scale);
  return i < 0 ? null : objects[i];
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
  objects: readonly AnnoObject[],
  delta: OrientDelta,
  w: number,
  h: number,
): AnnoObject[] {
  const isFlip = delta === "flipH" || delta === "flipV";
  const P = (x: number, y: number) => transformPoint(x, y, delta, w, h);
  return objects.map((o): AnnoObject => {
    const rotOfShape = normalizeDeg(isFlip ? -o.rot : o.rot);
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
      case "mosaic": {
        const a = P(o.x, o.y);
        const b = P(o.x + o.w, o.y + o.h);
        const r = normalizeRect(a.x, a.y, b.x, b.y);
        return { ...o, x: r.x, y: r.y, w: r.w, h: r.h, rot: rotOfShape };
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
export function translateObject(
  o: AnnoObject,
  dx: number,
  dy: number,
): AnnoObject {
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
