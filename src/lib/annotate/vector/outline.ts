// 윤곽선화 — 선(stroke)을 면(fill)으로 (태스크 46 §3.7). **순수 모듈**.
//
// 결과가 원본과 **한 픽셀이라도 다르면 실패**다. 그래서 선 정렬·캡·조인·마이터 한계·대시·
// 화살촉을 하나도 빼지 않고 반영한다 — 하나라도 빠지면 "윤곽선화했더니 모양이 달라졌다"가
// 되고, 되돌릴 방법이 없다(파괴적 1커밋).
//
// 만드는 방식은 §3.7 의 "조각마다 사각형·조인·캡을 union" 과 **결과가 같되 더 싸다**:
// 조각마다 [오른쪽 오프셋 정방향 → 끝 캡 → 왼쪽 오프셋 역방향 → 시작 캡] 으로 **링 하나**를
// 짜고 `fillRule:'nonzero'` 로 둔다. 급한 코너에서 안쪽에 생기는 자기교차 고리는 감김수 2 라
// nonzero 에서 그대로 채워진다 — 캔버스가 stroke 를 채우는 방식과 같다. evenodd 로 두면
// 바로 그 고리가 구멍으로 뚫린다(모드를 바꾸지 마라).
//
// 링 방향은 전부 양(반시계, 대수 기준)으로 통일한다. 조각·화살촉이 겹칠 때 방향이 어긋나면
// 겹친 자리가 상쇄돼 사라진다. 닫힌 서브패스만 예외로 바깥/안쪽 링이 서로 반대 방향이어야
// 가운데가 뚫린 띠가 된다.
//
// 정렬(inside/outside)만 진짜 불리언이 필요하다: 폭 2w 띠를 도형 면과 ∩ / − 한다. 캔버스가
// clip + 2배 두께로 그리는 것과 같은 정의라(paint.ts strokePaint) 픽셀이 맞는다.

import { ARROW_HEAD_SCALE, type GeomNode, type PathNode } from "../types";
import { clipRegions, type ClipRegion } from "./boolean";
import { canOutline, pathFrom, toPathObject } from "./convert";
import { fitPolyline } from "./fit";
import { flattenSubPath, pathEndTangents, type SubPath } from "./path";

const TOL = 0.25;
/** 원호 근사 사지타 상한(oriented px) — 캡·조인의 둥근 정도가 여기서 결정된다. */
const SAGITTA = 0.25;
/** 화살촉 벌림 — paint.ts drawArrowHead 와 같은 값이어야 머리 모양이 안 바뀐다. */
const HEAD_SPREAD = Math.PI / 7;
/** 대시 조각 상한. 두께 대비 터무니없이 짧은 대시가 들어와도 편집기가 멈추지 않게 한다. */
const MAX_DASH_PIECES = 4000;

/**
 * §4 계약. `canOutline` 이 거짓이면 null — 게이트를 통과하지 못한 선택에 이 함수를 부르면
 * 조용히 선이 사라진 빈 패스를 만든다.
 */
export function outlineStroke(node: GeomNode): PathNode | null {
  if (!canOutline(node)) return null;
  const src = toPathObject(node);
  if (!src) return null;
  const stroke = node.strokes.find((s) => s.visible);
  if (!stroke || !(node.strokeWidth > 0)) return null;

  // 열린 경로는 안팎이 없어 정렬이 center 로 떨어진다 — paint.ts 와 **같은 판정**이라야
  // 윤곽선화 전후의 두께가 같다.
  const open = !src.subpaths.some((s) => s.closed && s.verts.length > 1);
  const align = open ? "center" : node.strokeAlign;
  const half = (align === "center" ? node.strokeWidth : node.strokeWidth * 2) / 2;

  const rings: number[][] = [];
  for (const sub of src.subpaths) {
    const pts = flattenSubPath(sub, TOL);
    if (pts.length < 4) continue;
    for (const piece of pieces(pts, sub.closed, node.dash)) {
      if (piece.closed) {
        pushLoopRings(rings, piece.pts, half, node.join, node.miterLimit);
      } else {
        const ring = openRing(piece.pts, half, node.cap, node.join, node.miterLimit);
        if (ring.length >= 6) rings.push(ring);
      }
    }
  }
  pushHeads(rings, src, node.heads, node.strokeWidth);
  if (rings.length === 0) return null;

  const final = align === "center" ? rings : clipToShape(rings, src, align === "inside");
  if (final.length === 0) return null;

  const subpaths: SubPath[] = final.map((ring) => ({
    verts: fitPolyline(ring, { maxErr: 0.5, cornerDeg: 30, closed: true }),
    closed: true,
  }));
  return {
    ...pathFrom(node, subpaths, node.id, "nonzero"),
    // 선이 면이 됐으니 선 관련 값은 전부 내려놓는다. 남겨 두면 결과에 또 테두리가 그려진다.
    fills: [stroke],
    strokes: [],
    strokeWidth: 0,
    dash: null,
    heads: { start: "none", end: "none" },
  };
}

// ── 정렬 클립 ────────────────────────────────────────────────────────────────

/** inside = 띠 ∩ 도형, outside = 띠 − 도형. 도형 면은 노드 자신의 fillRule 로 읽는다. */
function clipToShape(rings: readonly number[][], src: PathNode, inside: boolean): number[][] {
  const shape: number[][] = [];
  for (const sub of src.subpaths) {
    const pts = flattenSubPath(sub, TOL);
    if (pts.length >= 6) shape.push(pts);
  }
  if (shape.length === 0) return rings.slice();
  const band: ClipRegion = { rings, rule: "nonzero" };
  const area: ClipRegion = { rings: shape, rule: src.fillRule };
  return clipRegions([band, area], inside ? (v) => v[0] && v[1] : (v) => v[0] && !v[1]);
}

// ── 대시 ─────────────────────────────────────────────────────────────────────

interface Piece {
  pts: number[];
  closed: boolean;
}

/**
 * 대시가 없으면 서브패스 그대로 한 조각, 있으면 호장 기준으로 잘라 **조각마다 열린 폴리라인**이다
 * (캔버스가 조각마다 캡을 다는 것과 같다). 닫힌 서브패스는 첫 점을 뒤에 붙여 한 바퀴 도는
 * 열린 선으로 바꿔 자른다 — 캔버스도 닫힘 구간을 마지막 세그먼트로 그리고 위상을 이어 간다.
 *
 * 닫힘 이음매를 **가로지르는** 대시는 한 조각이어야 한다. 캔버스(Skia)는 마지막 "켬" 구간이
 * 경로 끝을 넘으면 첫 구간과 이어 붙여 **조인**으로 그린다. 여기서 총길이에 잘라 두 조각으로
 * 내면 그 자리에 캡 두 개가 맞대어 서고 조인이 채우던 쐐기가 빈 채로 남는다 — 사각형의
 * 좌상단(로 시작하는 링) 직각 코너가 두께² 만큼 파인다(두께 20이면 100px²). 파괴적 1커밋이라
 * 되돌릴 방법이 없다.
 */
function pieces(pts: number[], closed: boolean, dash: readonly number[] | null): Piece[] {
  const pat = (dash ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  if (pat.length === 0 || pat.every((v) => v === 0)) return [{ pts, closed }];
  const cyc = pat.length % 2 === 1 ? pat.concat(pat) : pat;
  const line = closed ? pts.concat([pts[0], pts[1]]) : pts;

  const total = arcLength(line);
  const out: Piece[] = [];
  let pos = 0;
  let i = 0;
  let on = true;
  // 마지막 "켬" 구간이 총길이에 잘렸는가 — 잘렸다면 이음매를 넘어 첫 구간과 이어져야 한다.
  let straddles = false;
  while (pos < total && out.length < MAX_DASH_PIECES) {
    const len = cyc[i % cyc.length];
    if (len > 0) {
      if (on) {
        const seg = sliceByArc(line, pos, Math.min(pos + len, total));
        if (seg.length >= 4) out.push({ pts: seg, closed: false });
      }
      straddles = on && pos + len > total;
      pos += len;
    }
    on = !on;
    i++;
  }
  // `cyc[0] > 0` 이라야 첫 조각이 호장 0 에서 시작한다(0 이면 첫 구간이 통째로 건너뛰어진다).
  if (closed && straddles && cyc[0] > 0 && out.length > 0) {
    const last = out[out.length - 1];
    // 한 조각이 한 바퀴를 다 덮었다 = 실선이다. 닫힌 링으로 돌려보내면 이음매가 사라진다.
    if (out.length === 1) out[0] = { pts, closed: true };
    // 끝점과 시작점이 같은 좌표라 앞의 한 점을 버리고 잇는다.
    else last.pts.push(...out.shift()!.pts.slice(2));
  }
  return out;
}

function arcLength(pts: readonly number[]): number {
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) {
    s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  }
  return s;
}

/** 호장 [a,b] 구간의 폴리라인. 구간 끝은 세그먼트 위에서 보간한다. */
function sliceByArc(pts: readonly number[], a: number, b: number): number[] {
  const out: number[] = [];
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2];
    const y0 = pts[i - 1];
    const x1 = pts[i];
    const y1 = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len > 0) {
      const e = s + len;
      if (e > a && s < b) {
        const t0 = Math.max(0, (a - s) / len);
        const t1 = Math.min(1, (b - s) / len);
        if (out.length === 0) out.push(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0);
        out.push(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1);
      }
      s = e;
    }
    if (s >= b) break;
  }
  return out;
}

// ── 오프셋 링 ────────────────────────────────────────────────────────────────

/** 중복 점을 걷어낸 세그먼트 방향들. 길이 0 세그먼트는 법선이 정의되지 않아 조인을 망친다. */
function directions(pts: readonly number[]): { px: number[]; dx: number[]; dy: number[] } {
  const px: number[] = [];
  const dx: number[] = [];
  const dy: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const n = px.length;
    if (n >= 2 && Math.abs(px[n - 2] - pts[i]) < 1e-9 && Math.abs(px[n - 1] - pts[i + 1]) < 1e-9) {
      continue;
    }
    px.push(pts[i], pts[i + 1]);
  }
  for (let i = 2; i < px.length; i += 2) {
    const ex = px[i] - px[i - 2];
    const ey = px[i + 1] - px[i - 1];
    const len = Math.hypot(ex, ey) || 1;
    dx.push(ex / len);
    dy.push(ey / len);
  }
  return { px, dx, dy };
}

/**
 * 한쪽 오프셋 사슬. `side` +1 이면 진행 방향 왼쪽(대수 기준), −1 이면 오른쪽이다.
 * 바깥쪽 코너에만 조인을 넣고 안쪽은 두 점을 곧장 잇는다 — 안쪽에 생기는 고리는 nonzero 가 메운다.
 */
function appendSide(
  out: number[],
  px: readonly number[],
  dx: readonly number[],
  dy: readonly number[],
  side: number,
  half: number,
  join: GeomNode["join"],
  miterLimit: number,
  wrap: boolean,
): void {
  const segs = dx.length;
  for (let i = 0; i < segs; i++) {
    const ux = side * -dy[i];
    const uy = side * dx[i];
    out.push(px[i * 2] + ux * half, px[i * 2 + 1] + uy * half);
    const last = i === segs - 1;
    const j = last ? 0 : i + 1;
    if (last && !wrap) {
      out.push(px[(i + 1) * 2] + ux * half, px[(i + 1) * 2 + 1] + uy * half);
      break;
    }
    const vx = px[(i + 1) * 2];
    const vy = px[(i + 1) * 2 + 1];
    const ax = vx + ux * half;
    const ay = vy + uy * half;
    const nx = side * -dy[j];
    const ny = side * dx[j];
    const bx = vx + nx * half;
    const by = vy + ny * half;
    out.push(ax, ay);
    // 상대편 오프셋 점 b 는 여기서 찍지 않는다 — 다음 세그먼트의 시작점이 같은 자리고,
    // 마지막(wrap) 에서는 링의 첫 점이 그 자리다. 두 번 찍으면 재피팅이 길이 0 변을 만난다.
    appendJoin(out, vx, vy, ax, ay, bx, by, ux, uy, nx, ny, dx[i], dy[i], dx[j], dy[j], side, half, join, miterLimit);
  }
}

/** 바깥쪽 코너의 조인. 안쪽이면 아무것도 넣지 않는다(두 오프셋 점이 곧장 이어진다). */
function appendJoin(
  out: number[],
  vx: number,
  vy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  d0x: number,
  d0y: number,
  d1x: number,
  d1y: number,
  side: number,
  half: number,
  join: GeomNode["join"],
  miterLimit: number,
): void {
  const cross = d0x * d1y - d0y * d1x;
  // 이 면이 바깥쪽인가. 안쪽이면 조인 기하가 이미 사각형 안에 들어 있다.
  if (side * cross >= 0) return;
  if (join === "bevel") return;
  if (join === "round") {
    let bisX = ux + nx;
    let bisY = uy + ny;
    // 180° 되꺾임이면 이등분선이 0 이다 — 진행 방향으로 부풀린다(반원이 된다).
    if (Math.hypot(bisX, bisY) < 1e-9) {
      bisX = d0x;
      bisY = d0y;
    }
    appendArc(out, vx, vy, ax, ay, bx, by, half, bisX, bisY);
    return;
  }
  // miter — 두 오프셋 직선의 교점. 한계를 넘으면 캔버스와 같이 bevel 로 떨어진다.
  const den = d0x * d1y - d0y * d1x;
  if (Math.abs(den) < 1e-12) return;
  const t = ((bx - ax) * d1y - (by - ay) * d1x) / den;
  const mx = ax + d0x * t;
  const my = ay + d0y * t;
  if (Math.hypot(mx - vx, my - vy) > miterLimit * half) return;
  out.push(mx, my);
}

/** 중심 (cx,cy) 반지름 r 의 원호를 from→to 로 잇는다. `dir` 쪽으로 돌아야 바깥으로 부푼다. */
function appendArc(
  out: number[],
  cx: number,
  cy: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  r: number,
  dirX: number,
  dirY: number,
): void {
  const a0 = Math.atan2(fromY - cy, fromX - cx);
  const a1 = Math.atan2(toY - cy, toX - cx);
  const ccw = (fromX - cx) * dirY - (fromY - cy) * dirX > 0;
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  if (!ccw) sweep -= Math.PI * 2;
  const steps = arcSteps(r, Math.abs(sweep));
  // **외접** 반지름으로 표본을 찍는다 — 반지름 r 위에 찍으면 현이 항상 원 안쪽을 지나
  // 다각형이 원보다 작아진다(둥근 캡 끝이 0.25px 깎여 그 픽셀의 피복률이 떨어진다:
  // 46 §7 (t-2) 가 그 값을 rgba(64,64,255) 로 잡아냈다). R 을 쓰면 현의 중점이 원에
  // 정확히 접해 다각형이 원을 감싼다 — 잉크를 잃지 않는 쪽이 이 모듈의 계약이다.
  const R = r / Math.cos(Math.abs(sweep) / (2 * steps));
  for (let i = 1; i < steps; i++) {
    const a = a0 + (sweep * i) / steps;
    out.push(cx + R * Math.cos(a), cy + R * Math.sin(a));
  }
  out.push(toX, toY);
}

/** 사지타 ≤ 0.25px 를 만족하는 분할 수. 반지름이 작으면 한 조각이면 충분하다. */
function arcSteps(r: number, sweep: number): number {
  if (r <= SAGITTA) return 1;
  const step = 2 * Math.acos(1 - SAGITTA / r);
  return Math.max(1, Math.min(180, Math.ceil(sweep / step)));
}

/**
 * 열린 조각 하나의 링. 오른쪽 정방향 → 끝 캡 → 왼쪽 역방향 → 시작 캡 순서라 항상 양의 방향이
 * 나온다(모든 조각·화살촉과 방향이 맞아 겹쳐도 상쇄되지 않는다).
 */
function openRing(
  pts: readonly number[],
  half: number,
  cap: GeomNode["cap"],
  join: GeomNode["join"],
  miterLimit: number,
): number[] {
  const f = directions(pts);
  if (f.dx.length === 0) return [];
  const b = directions(reversePts(f.px));
  const ring: number[] = [];
  appendSide(ring, f.px, f.dx, f.dy, -1, half, join, miterLimit, false);
  const n = f.dx.length - 1;
  appendCap(ring, f.px[f.px.length - 2], f.px[f.px.length - 1], f.dx[n], f.dy[n], half, cap);
  appendSide(ring, b.px, b.dx, b.dy, -1, half, join, miterLimit, false);
  appendCap(ring, f.px[0], f.px[1], -f.dx[0], -f.dy[0], half, cap);
  return ring;
}

/** 끝점 캡. 링의 마지막 점에서 반대편 오프셋 점으로 넘어가는 구간을 채운다. */
function appendCap(
  out: number[],
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  half: number,
  cap: GeomNode["cap"],
): void {
  const fromX = out[out.length - 2];
  const fromY = out[out.length - 1];
  // 캡 반대편 = 같은 끝점의 반대 오프셋. 다음 사슬의 첫 점과 같은 자리다.
  const toX = 2 * cx - fromX;
  const toY = 2 * cy - fromY;
  if (cap === "square") {
    out.push(fromX + dirX * half, fromY + dirY * half);
    out.push(toX + dirX * half, toY + dirY * half);
  } else if (cap === "round") {
    appendArc(out, cx, cy, fromX, fromY, toX, toY, half, dirX, dirY);
    out.length -= 2; // 반대편 점은 다음 사슬이 다시 찍는다
  }
}

/**
 * 닫힌 서브패스는 링 **두 개**(바깥·안쪽)를 낸다. 둘의 방향이 반대라야 가운데가 뚫린 띠가 된다 —
 * 같은 방향이면 nonzero 에서 통짜 면이 되어 도형 안쪽이 통째로 칠해진다.
 */
function pushLoopRings(
  out: number[][],
  pts: readonly number[],
  half: number,
  join: GeomNode["join"],
  miterLimit: number,
): void {
  const f = directions(closeLoop(pts));
  if (f.dx.length < 2) return;
  const area = signedArea(f.px);
  const left: number[] = [];
  const right: number[] = [];
  appendSide(left, f.px, f.dx, f.dy, 1, half, join, miterLimit, true);
  appendSide(right, f.px, f.dx, f.dy, -1, half, join, miterLimit, true);
  // 왼쪽 법선은 반시계 링에서 안쪽을 가리킨다(대수 기준) — 바깥 링은 반대쪽이다.
  const outer = area > 0 ? right : left;
  const inner = area > 0 ? left : right;
  if (outer.length >= 6) out.push(area > 0 ? outer : reversePts(outer));
  if (inner.length >= 6) out.push(area > 0 ? reversePts(inner) : inner);
}

/** 링을 "마지막 점 = 첫 점" 형태로 만든다 — `directions` 가 한 바퀴 세그먼트를 다 보게. */
function closeLoop(pts: readonly number[]): number[] {
  const n = pts.length;
  if (n < 4) return pts.slice();
  if (Math.abs(pts[0] - pts[n - 2]) < 1e-9 && Math.abs(pts[1] - pts[n - 1]) < 1e-9) return pts.slice();
  return pts.concat([pts[0], pts[1]]);
}

function reversePts(pts: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
  return out;
}

function signedArea(pts: readonly number[]): number {
  let s = 0;
  const n = pts.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return s / 2;
}

// ── 화살촉 ───────────────────────────────────────────────────────────────────

/**
 * 화살촉 삼각형 — paint.ts drawArrowHead 와 **같은 기하**(길이 4×두께, 좌우 π/7)다.
 * 값이 갈라지면 윤곽선화 전후로 머리 크기가 달라진다.
 *
 * 머리는 첫 열린 서브패스의 양 끝에만 단다 — paint.ts `pathEnds` 가 지금 그렇게 그린다.
 * 여기만 서브패스 전부에 달면 저장 PNG 에 없던 머리가 생긴다.
 */
function pushHeads(
  out: number[][],
  src: PathNode,
  heads: GeomNode["heads"],
  strokeWidth: number,
): void {
  if (heads.start !== "arrow" && heads.end !== "arrow") return;
  const ends = pathEndTangents(src);
  if (ends.length === 0) return;
  const len = ARROW_HEAD_SCALE * strokeWidth;
  if (heads.start === "arrow") pushHead(out, ends[0].start, len);
  if (heads.end === "arrow") pushHead(out, ends[0].end, len);
}

function pushHead(
  out: number[][],
  tip: { x: number; y: number; angle: number },
  len: number,
): void {
  const ring = [
    tip.x,
    tip.y,
    tip.x - len * Math.cos(tip.angle - HEAD_SPREAD),
    tip.y - len * Math.sin(tip.angle - HEAD_SPREAD),
    tip.x - len * Math.cos(tip.angle + HEAD_SPREAD),
    tip.y - len * Math.sin(tip.angle + HEAD_SPREAD),
  ];
  out.push(signedArea(ring) < 0 ? reversePts(ring) : ring);
}
