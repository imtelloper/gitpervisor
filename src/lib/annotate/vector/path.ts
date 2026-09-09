// 베지어 패스 커널 — 정점 배열(37 `PathVert`)과 화면·기하 사이의 **유일한** 변환기.
//
// 순수하다. DOM 은 `Path2D` 생성 하나만 쓴다. 그래서 렌더(39)·히트(38)·노드 편집(47)·
// 불리언·윤곽선화(46)·텍스트 아웃라인(50)이 전부 같은 함수를 부르고, 화면에 보이는 곡선과
// 편집 핸들이 갈라질 수 없다.
//
// 한 벌뿐이어야 하는 것 셋:
// ① `normalizeAuto` — mode 'auto' 정점의 핸들 물질화. 두 벌이면 그린 곡선과 잡히는 핸들이
//    다른 자리에 있게 된다(47 이 같은 함수를 부르는 이유).
// ② `pathBounds` — 3차 극값을 **정확히** 푼다. 제어점 헐로 근사하면 곡선이 상자 안쪽에 있을 때
//    선택 상자가 실제보다 커지고, 그 상자를 기준으로 도는 정렬(45)·스냅(43)·프레임 리사이즈(38)가
//    전부 어긋난다. 눈에는 "선택 테두리가 도형보다 크다"로만 보인다.
// ③ 평탄 폴리라인 — `projectTo*` 를 47 이 포인터 이동마다 부른다. **정점 배열 참조**에 WeakMap
//    으로 묶는다: 커밋된 노드는 불변이라(types.ts 규약) 같은 참조면 같은 폴리라인이고,
//    드래그 중 라이브 객체만 매 틱 새로 계산한다.
//
// 직선 구간(양끝 핸들 0)은 평탄화·투영·분할 **세 곳 모두**에서 선형 파라미터로 다룬다. 3차식으로
// 풀면 같은 t 가 평탄화에서는 선형 위치를, 평가에서는 3t²−2t³ 위치를 가리켜 47 의 "클릭한 자리에
// 노드가 안 생긴다"가 된다.
//
// 배경: DOCS/task/46-image-vector-path.md §3.1

import type { PathNode, PathVert, Rect } from "../types";

/**
 * 서브패스 한 개. 37 은 `PathNode.subpaths` 안에 인라인으로 뒀고 이름을 붙이지 않았다 —
 * 여기서 **파생**해 이름 하나만 둔다(같은 개념에 두 이름을 두지 않는다, INDEX §10.4).
 */
export type SubPath = PathNode["subpaths"][number];

/**
 * 내부 교환용 커맨드(설계 §3.1 대안 C). 편집 표현이 아니라 **어댑터 형식**이다 —
 * 50 의 글리프 아웃라인·라이브러리 링이 이 모양으로 들어오고 나간다.
 */
export type PathCmd =
  | { c: "M" | "L"; p: [number, number] }
  | { c: "C"; p: [number, number, number, number, number, number] }
  | { c: "Q"; p: [number, number, number, number] }
  | { c: "Z"; p: [] };

/** 평탄화 기본 허용오차(oriented px). 투영·히트가 공유한다. */
export const FLATTEN_TOL = 0.25;

/** 핸들 유무 판정 임계. 이보다 짧은 핸들은 없는 것으로 본다. */
const HANDLE_EPS = 1e-3;
const EPS = 1e-9;
/** 적응 분할 깊이 상한 — 실측상 7이면 4,000px 곡선도 0.25px 안에 든다. 12는 순전히 안전망. */
const MAX_DEPTH = 12;

// ── 정점 모드 ────────────────────────────────────────────────────────────────

/**
 * 핸들 두 개에서 정점 모드를 정한다(공선·등길이 판정 1e-3, §3.4).
 *
 * 분할·피팅·커맨드 파싱이 전부 이걸 쓴다. 모드를 손으로 붙이면 "mirrored 라고 적혀 있는데
 * 실제 핸들은 비대칭"인 정점이 생기고, 47 이 그 표시를 믿고 반대쪽 핸들을 맞추는 순간
 * 사용자가 만진 적 없는 곡선이 튄다.
 */
export function vertModeOf(inX: number, inY: number, outX: number, outY: number): PathVert["mode"] {
  const li = Math.hypot(inX, inY);
  const lo = Math.hypot(outX, outY);
  if (li < HANDLE_EPS || lo < HANDLE_EPS) return "corner";
  // 매끄러우려면 두 핸들이 정점을 사이에 두고 **반대** 방향으로 일직선이어야 한다.
  const cross = inX * outY - inY * outX;
  const dot = inX * outX + inY * outY;
  if (dot >= 0 || Math.abs(cross) > HANDLE_EPS * li * lo) return "corner";
  return Math.abs(li - lo) <= HANDLE_EPS * Math.max(li, lo) ? "mirrored" : "asymmetric";
}

// ── auto 핸들 물질화 ─────────────────────────────────────────────────────────

const autoCache = new WeakMap<readonly PathVert[], SubPath>();

/**
 * mode 'auto' 정점의 in/out 핸들을 이웃 기반으로 채운 서브패스.
 *
 * 접선은 이웃 두 점을 잇는 방향(균일 Catmull-Rom), 길이는 각 이웃까지 거리의 1/3 — 그 3차
 * 베지어가 Catmull-Rom 스플라인과 정확히 같은 곡선이다. 열린 끝점은 이웃이 한쪽뿐이라
 * 그쪽 방향만 쓴다.
 *
 * **`mode` 는 'auto' 로 남긴다** — 물질화는 좌표만이다. 문서에는 (0,0) 이 그대로 있고(§3.1),
 * 여기 결과는 그리기·측정용 파생값이다. auto 정점이 없으면 **입력을 그대로 돌려준다**:
 * 아래 평탄화 캐시가 정점 배열 참조에 묶여 있어서, 여기서 매번 새 배열을 만들면 캐시가
 * 통째로 무력화된다.
 */
export function normalizeAuto(sub: SubPath): SubPath {
  const v = sub.verts;
  let hasAuto = false;
  for (let i = 0; i < v.length; i++) {
    if (v[i].mode === "auto") {
      hasAuto = true;
      break;
    }
  }
  if (!hasAuto) return sub;
  const hit = autoCache.get(v);
  if (hit && hit.closed === sub.closed) return hit;

  const n = v.length;
  const verts: PathVert[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = v[i];
    if (p.mode !== "auto") {
      verts[i] = p;
      continue;
    }
    const prev = i > 0 ? v[i - 1] : sub.closed ? v[n - 1] : null;
    const next = i < n - 1 ? v[i + 1] : sub.closed ? v[0] : null;
    const ax = prev ? prev.x : p.x;
    const ay = prev ? prev.y : p.y;
    const bx = next ? next.x : p.x;
    const by = next ? next.y : p.y;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < EPS) {
      verts[i] = p;
      continue;
    }
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    const dIn = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
    const dOut = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
    verts[i] = {
      ...p,
      inX: -tx * dIn,
      inY: -ty * dIn,
      outX: tx * dOut,
      outY: ty * dOut,
    };
  }
  const out: SubPath = { verts, closed: sub.closed };
  autoCache.set(v, out);
  return out;
}

// ── 세그먼트 원시 연산 ────────────────────────────────────────────────────────

/** 세그먼트 수. 닫힌 서브패스는 마지막 정점 → 첫 정점 구간이 하나 더 있다. */
function segCount(sub: SubPath): number {
  const n = sub.verts.length;
  return n < 2 ? 0 : sub.closed ? n : n - 1;
}

/** 양끝 핸들이 모두 없는 구간 = 직선. 파라미터 해석이 3차와 달라지는 유일한 경우다. */
function isLineSeg(a: PathVert, b: PathVert): boolean {
  return (
    Math.abs(a.outX) < HANDLE_EPS &&
    Math.abs(a.outY) < HANDLE_EPS &&
    Math.abs(b.inX) < HANDLE_EPS &&
    Math.abs(b.inY) < HANDLE_EPS
  );
}

/** 3차 베지어 한 축의 값. */
function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
}

// ── Path2D · 커맨드 ──────────────────────────────────────────────────────────

/**
 * 로컬 좌표 Path2D. 채우기·선·히트가 전부 이 하나를 쓴다(38 `buildObjectPath` 의 path 케이스).
 *
 * 직선 구간을 `lineTo` 로 내는 이유: 제어점이 끝점과 겹친 3차 곡선은 캔버스가 접선을 못 뽑아
 * miter 조인이 조용히 bevel 로 떨어질 수 있다. 반경 0 사각형(§3.4 rect 변환)이 그 케이스다.
 */
export function pathToPath2D(node: PathNode): Path2D {
  const p = new Path2D();
  for (const raw of node.subpaths) {
    const sub = normalizeAuto(raw);
    const v = sub.verts;
    if (v.length === 0) continue;
    p.moveTo(v[0].x, v[0].y);
    const S = segCount(sub);
    for (let s = 0; s < S; s++) {
      const a = v[s];
      const b = v[(s + 1) % v.length];
      if (isLineSeg(a, b)) p.lineTo(b.x, b.y);
      else p.bezierCurveTo(a.x + a.outX, a.y + a.outY, b.x + b.inX, b.y + b.inY, b.x, b.y);
    }
    if (sub.closed && S > 0) p.closePath();
  }
  return p;
}

/** `pathToPath2D` 와 같은 순회를 커맨드로. 50 어댑터·라이브러리 링 변환의 출구다. */
export function toPathCmds(node: PathNode): PathCmd[] {
  const out: PathCmd[] = [];
  for (const raw of node.subpaths) {
    const sub = normalizeAuto(raw);
    const v = sub.verts;
    if (v.length === 0) continue;
    out.push({ c: "M", p: [v[0].x, v[0].y] });
    const S = segCount(sub);
    for (let s = 0; s < S; s++) {
      const a = v[s];
      const b = v[(s + 1) % v.length];
      if (isLineSeg(a, b)) out.push({ c: "L", p: [b.x, b.y] });
      else
        out.push({
          c: "C",
          p: [a.x + a.outX, a.y + a.outY, b.x + b.inX, b.y + b.inY, b.x, b.y],
        });
    }
    if (sub.closed && S > 0) out.push({ c: "Z", p: [] });
  }
  return out;
}

/** SVG `d`. 47 스크림 cutout·골격선이 소비한다 — 표시용이라 소수 3자리(<0.001px)로 끊는다. */
export function pathToSvgD(subpaths: readonly SubPath[]): string {
  const f = (v: number) => String(Math.round(v * 1000) / 1000);
  const parts: string[] = [];
  for (const raw of subpaths) {
    const sub = normalizeAuto(raw);
    const v = sub.verts;
    if (v.length === 0) continue;
    parts.push(`M${f(v[0].x)} ${f(v[0].y)}`);
    const S = segCount(sub);
    for (let s = 0; s < S; s++) {
      const a = v[s];
      const b = v[(s + 1) % v.length];
      if (isLineSeg(a, b)) parts.push(`L${f(b.x)} ${f(b.y)}`);
      else
        parts.push(
          `C${f(a.x + a.outX)} ${f(a.y + a.outY)} ${f(b.x + b.inX)} ${f(b.y + b.inY)} ${f(b.x)} ${f(b.y)}`,
        );
    }
    if (sub.closed && S > 0) parts.push("Z");
  }
  return parts.join(" ");
}

// ── 평탄화 ──────────────────────────────────────────────────────────────────

/**
 * 평탄화 결과. `us[i]` 는 폴리라인 점 i 의 **전역 파라미터** `seg + t` 다.
 *
 * (seg, t) 쌍이 아니라 하나의 실수로 두는 이유: 구간 경계 점은 `seg=s,t=1` 이면서 동시에
 * `seg=s+1,t=0` 이라 쌍으로는 두 값이 된다. 투영이 경계를 걸치는 폴리라인 구간에서 t 를
 * 보간할 때 그 이중성이 그대로 튀어나온다. `u` 는 경계에서 정확히 `s+1` 하나다.
 */
interface Flat {
  /** 정규화까지 끝난 서브패스 — 호출자가 `normalizeAuto` 를 또 부르지 않게 함께 돌려준다. */
  sub: SubPath;
  tol: number;
  pts: number[];
  us: number[];
}

const flatCache = new WeakMap<readonly PathVert[], Flat>();

/** 제어점–현 거리로 보는 평탄도(AGG 관례). 현이 0에 가까우면 제어점 자체의 이탈로 본다. */
function isFlat(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  tol: number,
): boolean {
  const dx = x3 - x0;
  const dy = y3 - y0;
  const chord2 = dx * dx + dy * dy;
  if (chord2 < EPS) {
    // 시작·끝이 같은 루프백 곡선 — 현으로 나누면 0 나눗셈이라 무한 재귀가 된다.
    const m = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(x2 - x0), Math.abs(y2 - y0));
    return m <= tol;
  }
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const d = d1 + d2;
  return d * d <= tol * tol * chord2;
}

function flatCubic(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  t0: number,
  t1: number,
  tol: number,
  depth: number,
  pts: number[],
  us: number[],
  base: number,
): void {
  if (depth > 0 && !isFlat(x0, y0, x1, y1, x2, y2, x3, y3, tol)) {
    const ax = (x0 + x1) / 2;
    const ay = (y0 + y1) / 2;
    const bx = (x1 + x2) / 2;
    const by = (y1 + y2) / 2;
    const cx = (x2 + x3) / 2;
    const cy = (y2 + y3) / 2;
    const dx = (ax + bx) / 2;
    const dy = (ay + by) / 2;
    const ex = (bx + cx) / 2;
    const ey = (by + cy) / 2;
    const mx = (dx + ex) / 2;
    const my = (dy + ey) / 2;
    const tm = (t0 + t1) / 2;
    flatCubic(x0, y0, ax, ay, dx, dy, mx, my, t0, tm, tol, depth - 1, pts, us, base);
    flatCubic(mx, my, ex, ey, cx, cy, x3, y3, tm, t1, tol, depth - 1, pts, us, base);
    return;
  }
  pts.push(x3, y3);
  us.push(base + t1);
}

function flatten(sub: SubPath, tolIn: number): Flat {
  const norm = normalizeAuto(sub);
  const tol = Math.max(1e-3, tolIn);
  const hit = flatCache.get(norm.verts);
  if (hit && hit.tol === tol) return hit;

  const v = norm.verts;
  const pts: number[] = [];
  const us: number[] = [];
  if (v.length > 0) {
    pts.push(v[0].x, v[0].y);
    us.push(0);
    const S = segCount(norm);
    for (let s = 0; s < S; s++) {
      const a = v[s];
      const b = v[(s + 1) % v.length];
      if (isLineSeg(a, b)) {
        pts.push(b.x, b.y);
        us.push(s + 1);
      } else {
        flatCubic(
          a.x,
          a.y,
          a.x + a.outX,
          a.y + a.outY,
          b.x + b.inX,
          b.y + b.inY,
          b.x,
          b.y,
          0,
          1,
          tol,
          MAX_DEPTH,
          pts,
          us,
          s,
        );
      }
    }
    // 닫힌 서브패스의 마지막 구간은 첫 점으로 되돌아온다 — 링 소비자(불리언·윤곽선화)가
    // 중복 점을 퇴화 변으로 읽지 않도록 여기서 뗀다.
    if (norm.closed && S > 0) {
      pts.length -= 2;
      us.length -= 1;
    }
  }
  const out: Flat = { sub: norm, tol, pts, us };
  flatCache.set(norm.verts, out);
  return out;
}

/**
 * 적응 분할 폴리라인 `[x0,y0,…]`. 닫힌 서브패스면 첫 점을 끝에 반복하지 않는다.
 *
 * 균등 분할이 아닌 이유: 완만한 구간에 점이 남아돌면 불리언 스윕라인이 그만큼 느려지고,
 * 급한 구간은 각져서 재피팅이 코너로 오인한다.
 *
 * 반환 배열은 **복사본**이다 — 내부 캐시를 그대로 넘기면 호출자의 in-place 변형이 다음
 * 히트테스트를 조용히 오염시킨다.
 */
export function flattenSubPath(sub: SubPath, tol: number = FLATTEN_TOL): number[] {
  return flatten(sub, tol).pts.slice();
}

// ── 경계 상자 ────────────────────────────────────────────────────────────────

/** 도함수 근 두 개를 담는 스크래치. 아래 두 함수가 동기적으로 쓰고 바로 읽는다. */
const extrema = [-1, -1];

/** `B'(t)=0` 의 근을 (0,1) 안에서만 `extrema` 에 담는다. 없으면 -1. */
function solveExtrema(p0: number, p1: number, p2: number, p3: number): void {
  extrema[0] = -1;
  extrema[1] = -1;
  // B'(t)/3 = A t² + B t + C
  const A = -p0 + 3 * p1 - 3 * p2 + p3;
  const B = 2 * (p0 - 2 * p1 + p2);
  const C = p1 - p0;
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) {
      const t = -C / B;
      if (t > 0 && t < 1) extrema[0] = t;
    }
    return;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  let k = 0;
  const r0 = (-B + sq) / (2 * A);
  if (r0 > 0 && r0 < 1) extrema[k++] = r0;
  const r1 = (-B - sq) / (2 * A);
  if (r1 > 0 && r1 < 1) extrema[k] = r1;
}

/**
 * 3차 극값을 정확히 푼 경계 상자(선 두께 **미포함** — pad 는 `objectBBox` 몫, §3.3).
 *
 * 제어점 AABB 로 근사하지 마라: 핸들은 곡선 바깥에 있으므로 근사 상자가 항상 크다. 그 상자로
 * 정렬하면 도형이 눈에 보이게 밀리고, 스냅 후보 좌표도 같은 만큼 어긋난다.
 */
export function pathBounds(node: PathNode): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const hit = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const raw of node.subpaths) {
    const sub = normalizeAuto(raw);
    const v = sub.verts;
    if (v.length === 0) continue;
    hit(v[0].x, v[0].y);
    const S = segCount(sub);
    for (let s = 0; s < S; s++) {
      const a = v[s];
      const b = v[(s + 1) % v.length];
      hit(b.x, b.y);
      if (isLineSeg(a, b)) continue; // 직선은 끝점이 곧 극값
      const ax = a.x + a.outX;
      const ay = a.y + a.outY;
      const bx = b.x + b.inX;
      const by = b.y + b.inY;
      solveExtrema(a.x, ax, bx, b.x);
      for (let k = 0; k < 2; k++) {
        const t = extrema[k];
        if (t > 0) hit(cubicAt(a.x, ax, bx, b.x, t), cubicAt(a.y, ay, by, b.y, t));
      }
      solveExtrema(a.y, ay, by, b.y);
      for (let k = 0; k < 2; k++) {
        const t = extrema[k];
        if (t > 0) hit(cubicAt(a.x, ax, bx, b.x, t), cubicAt(a.y, ay, by, b.y, t));
      }
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ── 투영(세그먼트 히트) ──────────────────────────────────────────────────────

export interface PathHit {
  seg: number;
  t: number;
  x: number;
  y: number;
  dist: number;
}

/**
 * 서브패스 위 최근접점. 47 이 매 pointermove 마다 부르므로 평탄화 캐시 위에서만 돈다.
 *
 * `t` 는 세그먼트 파라미터고 `x,y` 는 그 t 의 **곡선 값**이다(폴리라인 위 점이 아니다) —
 * 47 이 여기 (seg,t) 로 `splitCubic` 을 부르므로, 미리보기 점과 실제 삽입 위치가 같으려면
 * 두 값이 같은 식에서 나와야 한다.
 */
export function projectToSubPath(sub: SubPath, pt: { x: number; y: number }): PathHit {
  const f = flatten(sub, FLATTEN_TOL);
  const norm = f.sub;
  const v = norm.verts;
  const n = f.us.length;
  if (n === 0) return { seg: 0, t: 0, x: 0, y: 0, dist: Infinity };
  const S = segCount(norm);
  if (S === 0) {
    const x = f.pts[0];
    const y = f.pts[1];
    return { seg: 0, t: 0, x, y, dist: Math.hypot(pt.x - x, pt.y - y) };
  }

  let bestD2 = Infinity;
  let bestU = 0;
  // 닫힌 서브패스는 첫 점 반복이 없으므로 마지막 점 → 첫 점 구간을 따로 돈다.
  const lines = norm.closed ? n : n - 1;
  for (let i = 0; i < lines; i++) {
    const j = (i + 1) % n;
    const ax = f.pts[2 * i];
    const ay = f.pts[2 * i + 1];
    const dx = f.pts[2 * j] - ax;
    const dy = f.pts[2 * j + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > EPS ? ((pt.x - ax) * dx + (pt.y - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const d2 = (pt.x - px) * (pt.x - px) + (pt.y - py) * (pt.y - py);
    if (d2 < bestD2) {
      bestD2 = d2;
      const ua = f.us[i];
      const ub = j === 0 ? S : f.us[j]; // 되돌아오는 구간의 끝은 u=0 이 아니라 u=S 다
      bestU = ua + (ub - ua) * t;
    }
  }

  let seg = Math.floor(bestU);
  let t = bestU - seg;
  if (seg >= S) {
    seg = S - 1;
    t = 1;
  }
  const a = v[seg];
  const b = v[(seg + 1) % v.length];
  let x: number;
  let y: number;
  if (isLineSeg(a, b)) {
    // 직선 구간의 t 는 평탄화가 만든 **선형** 비율이다. 3차식으로 평가하면 3t²−2t³ 자리로
    // 튀어 클릭한 곳과 다른 점이 나온다.
    x = a.x + (b.x - a.x) * t;
    y = a.y + (b.y - a.y) * t;
  } else {
    x = cubicAt(a.x, a.x + a.outX, b.x + b.inX, b.x, t);
    y = cubicAt(a.y, a.y + a.outY, b.y + b.inY, b.y, t);
  }
  return { seg, t, x, y, dist: Math.hypot(pt.x - x, pt.y - y) };
}

/** 서브패스 전부 중 최근접. 정점 있는 서브패스가 하나도 없으면 null. */
export function projectToPath(
  node: PathNode,
  pt: { x: number; y: number },
): (PathHit & { sub: number }) | null {
  let best: (PathHit & { sub: number }) | null = null;
  for (let i = 0; i < node.subpaths.length; i++) {
    if (node.subpaths[i].verts.length === 0) continue;
    const h = projectToSubPath(node.subpaths[i], pt);
    if (!best || h.dist < best.dist) best = { ...h, sub: i };
  }
  return best;
}

// ── 분할 ────────────────────────────────────────────────────────────────────

/**
 * 세그먼트 `seg` 를 `t` 에서 갈라 정점 하나를 끼운 서브패스(de Casteljau — 모양 불변).
 *
 * 양쪽 이웃의 모드를 **다시 계산**한다: 분할이 A 의 out 과 B 의 in 을 짧게 잘라 놓으므로,
 * 원래 mirrored 였던 정점은 이제 기하학적으로 mirrored 가 아니다. 표시를 그대로 두면 47 이
 * 그 말을 믿고 반대쪽 핸들을 맞추는 순간 곡선이 튄다. auto 였던 두 이웃도 여기서 굳는다 —
 * 이웃 관계가 바뀌었으니 다음 `normalizeAuto` 는 다른 곡선을 낸다.
 */
export function splitCubic(sub: SubPath, seg: number, t: number): SubPath {
  const base = normalizeAuto(sub);
  const v = base.verts;
  const n = v.length;
  const S = segCount(base);
  if (S === 0 || seg < 0 || seg >= S) return sub;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  const a = v[seg];
  const b = v[(seg + 1) % n];

  let mid: PathVert;
  let na: PathVert;
  let nb: PathVert;
  if (isLineSeg(a, b)) {
    // 직선은 직선으로 쪼갠다. de Casteljau 를 그대로 돌리면 모양은 같지만 공선 핸들 두 개가
    // 돋아나 47 의 핸들 크롬에 없던 손잡이가 생긴다.
    mid = {
      x: a.x + (b.x - a.x) * tc,
      y: a.y + (b.y - a.y) * tc,
      inX: 0,
      inY: 0,
      outX: 0,
      outY: 0,
      mode: "corner",
    };
    na = { ...a, mode: vertModeOf(a.inX, a.inY, 0, 0) };
    nb = { ...b, mode: vertModeOf(0, 0, b.outX, b.outY) };
  } else {
    const L = (u: number, w: number) => u + (w - u) * tc;
    const p1x = a.x + a.outX;
    const p1y = a.y + a.outY;
    const p2x = b.x + b.inX;
    const p2y = b.y + b.inY;
    const q0x = L(a.x, p1x);
    const q0y = L(a.y, p1y);
    const q1x = L(p1x, p2x);
    const q1y = L(p1y, p2y);
    const q2x = L(p2x, b.x);
    const q2y = L(p2y, b.y);
    const r0x = L(q0x, q1x);
    const r0y = L(q0y, q1y);
    const r1x = L(q1x, q2x);
    const r1y = L(q1y, q2y);
    const sx = L(r0x, r1x);
    const sy = L(r0y, r1y);
    mid = {
      x: sx,
      y: sy,
      inX: r0x - sx,
      inY: r0y - sy,
      outX: r1x - sx,
      outY: r1y - sy,
      mode: vertModeOf(r0x - sx, r0y - sy, r1x - sx, r1y - sy),
    };
    na = {
      ...a,
      outX: q0x - a.x,
      outY: q0y - a.y,
      mode: vertModeOf(a.inX, a.inY, q0x - a.x, q0y - a.y),
    };
    nb = {
      ...b,
      inX: q2x - b.x,
      inY: q2y - b.y,
      mode: vertModeOf(q2x - b.x, q2y - b.y, b.outX, b.outY),
    };
  }

  const verts = v.slice();
  verts[seg] = na;
  verts[(seg + 1) % n] = nb;
  // 닫힘 마지막 구간이면 (seg+1)%n === 0 이라 B 는 앞쪽에 있고, splice 위치는 배열 끝이 된다.
  verts.splice(seg + 1, 0, mid);
  return { verts, closed: base.closed };
}

// ── 끝 접선(화살촉) ──────────────────────────────────────────────────────────

export interface EndTangent {
  x: number;
  y: number;
  /** rad. 0 = +x, 캔버스는 y-down 이라 양수가 시계방향. */
  angle: number;
}

/**
 * 열린 서브패스마다 양 끝점과 **바깥을 향한** 접선.
 *
 * `angle` 은 화살촉이 향할 방향이다 — paint.ts `drawArrowHead` 의 `a = atan2(to−from)` 과 같은
 * 규약이라 그대로 넘길 수 있다. 반대로 두면 머리가 선 안쪽을 향해 뒤집힌다.
 *
 * 정점이 1개뿐인 서브패스는 접선이 없어 **건너뛴다** — 결과 인덱스가 서브패스 인덱스와 1:1이 아니다.
 */
export function pathEndTangents(node: PathNode): { start: EndTangent; end: EndTangent }[] {
  const out: { start: EndTangent; end: EndTangent }[] = [];
  for (const raw of node.subpaths) {
    if (raw.closed || raw.verts.length < 2) continue;
    const v = normalizeAuto(raw).verts;
    const first = v[0];
    const last = v[v.length - 1];
    // 끝 정점의 핸들이 곧 접선이다. 핸들이 없으면(직선 구간) 이웃 정점이 정확한 접선이다.
    const hasOut = Math.abs(first.outX) > HANDLE_EPS || Math.abs(first.outY) > HANDLE_EPS;
    const hasIn = Math.abs(last.inX) > HANDLE_EPS || Math.abs(last.inY) > HANDLE_EPS;
    const fx = hasOut ? first.x + first.outX : v[1].x;
    const fy = hasOut ? first.y + first.outY : v[1].y;
    const tx = hasIn ? last.x + last.inX : v[v.length - 2].x;
    const ty = hasIn ? last.y + last.inY : v[v.length - 2].y;
    out.push({
      start: { x: first.x, y: first.y, angle: Math.atan2(first.y - fy, first.x - fx) },
      end: { x: last.x, y: last.y, angle: Math.atan2(last.y - ty, last.x - tx) },
    });
  }
  return out;
}

// ── 커맨드 → 정점 ────────────────────────────────────────────────────────────

function rawVert(x: number, y: number): PathVert {
  return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" };
}

/**
 * `M/L/C/Q/Z` 커맨드를 서브패스로. 50 의 글리프 아웃라인과 라이브러리 링이 들어오는 입구다.
 *
 * **Q 는 C 로 승격한다** — 문서 모델에 2차 베지어가 없다(§3.1). 정확 변환:
 *   `C1 = P0 + ⅔(Q − P0)`, `C2 = P2 + ⅔(Q − P2)`
 * 2차식을 3차 기저로 다시 쓴 항등식이지 근사가 아니다. ½ 이나 ¾ 로 잘못 쓰면 글리프 곡선이
 * 미세하게 부풀어 50 의 텍스트 아웃라인이 원본 글자보다 굵게 나온다.
 *
 * Z 뒤에 이어지는 명령은 **새 서브패스**로 본다(SVG 는 시작점에서 이어 그리지만, 이 함수의
 * 입력은 링·아웃라인이라 그런 경로가 오지 않는다).
 */
export function fromPathCmds(cmds: readonly PathCmd[]): SubPath[] {
  const out: SubPath[] = [];
  let verts: PathVert[] = [];
  const flush = (closed: boolean) => {
    if (verts.length === 0) return;
    if (closed && verts.length > 1) {
      // 닫는 점이 시작점과 겹치면 정점 하나로 합친다. 남겨 두면 길이 0 짜리 변이 생겨
      // 불리언 스윕라인·재피팅이 퇴화 입력으로 받는다.
      const f = verts[0];
      const l = verts[verts.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) {
        verts[0] = { ...f, inX: l.inX, inY: l.inY };
        verts.pop();
      }
    }
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      verts[i] = { ...v, mode: vertModeOf(v.inX, v.inY, v.outX, v.outY) };
    }
    out.push({ verts, closed });
    verts = [];
  };

  for (const cmd of cmds) {
    switch (cmd.c) {
      case "M":
        flush(false);
        verts.push(rawVert(cmd.p[0], cmd.p[1]));
        break;
      case "L":
        if (verts.length === 0) verts.push(rawVert(0, 0));
        verts.push(rawVert(cmd.p[0], cmd.p[1]));
        break;
      case "C":
      case "Q": {
        if (verts.length === 0) verts.push(rawVert(0, 0));
        const prev = verts[verts.length - 1];
        let c1x: number;
        let c1y: number;
        let c2x: number;
        let c2y: number;
        let ex: number;
        let ey: number;
        if (cmd.c === "C") {
          [c1x, c1y, c2x, c2y, ex, ey] = cmd.p;
        } else {
          const [qx, qy, qex, qey] = cmd.p;
          ex = qex;
          ey = qey;
          c1x = prev.x + (2 / 3) * (qx - prev.x);
          c1y = prev.y + (2 / 3) * (qy - prev.y);
          c2x = ex + (2 / 3) * (qx - ex);
          c2y = ey + (2 / 3) * (qy - ey);
        }
        verts[verts.length - 1] = { ...prev, outX: c1x - prev.x, outY: c1y - prev.y };
        const next = rawVert(ex, ey);
        next.inX = c2x - ex;
        next.inY = c2y - ey;
        verts.push(next);
        break;
      }
      case "Z":
        flush(true);
        break;
    }
  }
  flush(false);
  return out;
}
