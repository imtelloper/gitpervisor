// 폴리라인 → 3차 베지어 피팅(Schneider, Graphics Gems 1990). 자유곡선(펜·형광펜)과 불리언
// 결과 링이 **편집 가능한 정점**이 되는 유일한 경로다.
//
// 코너 검출이 먼저다. 방향이 크게 꺾이는 점에서 폴리라인을 끊지 않으면 최소제곱이 직각 하나를
// 완만한 곡선으로 흡수한다 — 펜으로 그린 ㄱ자가 둥글게 뭉개지고, 불리언 교차점이 무너진다.
// 그 다음이 피팅이고, 오차가 남으면 최대오차 지점에서 재귀로 쪼갠다.
//
// `fit-curve@0.2.0` 과 같은 알고리즘이다. 의존을 들이지 않은 이유: 이 파일 하나로 끝나고,
// 그 패키지의 오차 판정 관례(제곱거리를 비제곱 임계와 비교한다 — maxErr<1 이면 요구보다 훨씬
// 촘촘히, >1 이면 훨씬 성기게 맞춘다)를 그대로 물려받지 않아도 된다. 여기서는 실거리로 판정한다.
// ponytail: 자체 구현. 피팅 품질이 문제가 되면 fit-curve 로 교체(같은 알고리즘·같은 시그니처)
//
// 배경: DOCS/task/46-image-vector-path.md §3.4·§3.5

import type { PathVert } from "../types";
import { vertModeOf } from "./path";

/** 내부 전용 점. 알고리즘 원문이 벡터 연산이라 평탄 배열보다 이 모양이 읽기 쉽다. */
type P = [number, number];

export interface FitOptions {
  /** 허용 최대 편차(oriented px). */
  maxErr?: number;
  /** 이 각도(deg) 넘게 꺾이면 코너로 끊는다. */
  cornerDeg?: number;
  /** 링(닫힌 폴리라인)인가. */
  closed?: boolean;
}

/** 재파라미터화 반복 상한. 수렴은 보통 2~3회다 — 원문의 20회는 큰 획에서 값을 못 한다. */
const MAX_REPARAM = 8;

function dist(a: P, b: P): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** 단위 벡터. 길이가 0이면 (0,0) — 호출부가 대체 방향을 고른다. */
function unit(x: number, y: number): P {
  const l = Math.hypot(x, y);
  return l < 1e-12 ? [0, 0] : [x / l, y / l];
}

function bezAt(b: P[], t: number): P {
  const m = 1 - t;
  const c0 = m * m * m;
  const c1 = 3 * m * m * t;
  const c2 = 3 * m * t * t;
  const c3 = t * t * t;
  return [
    c0 * b[0][0] + c1 * b[1][0] + c2 * b[2][0] + c3 * b[3][0],
    c0 * b[0][1] + c1 * b[1][1] + c2 * b[2][1] + c3 * b[3][1],
  ];
}

/** 연속 중복점 제거. 남겨 두면 접선이 0 벡터가 되고 코드 길이 파라미터화가 0으로 나눈다. */
function dedupe(pts: readonly number[]): P[] {
  const out: P[] = [];
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - x) < 1e-6 && Math.abs(last[1] - y) < 1e-6) continue;
    out.push([x, y]);
  }
  return out;
}

/** 점 i 에서의 꺾임 각(rad). 양끝은 0. */
function turnAt(pts: readonly P[], i: number, n: number): number {
  const p = pts[(i - 1 + n) % n];
  const c = pts[i];
  const q = pts[(i + 1) % n];
  const u = unit(c[0] - p[0], c[1] - p[1]);
  const v = unit(q[0] - c[0], q[1] - c[1]);
  if ((u[0] === 0 && u[1] === 0) || (v[0] === 0 && v[1] === 0)) return 0;
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]));
  return Math.acos(dot);
}

// ── Schneider 핵심 ───────────────────────────────────────────────────────────

/** 코드 길이 비례 파라미터화 — 초기 추정치. */
function chordParam(pts: readonly P[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i - 1], pts[i]));
  const total = u[u.length - 1];
  if (total < 1e-12) return u.map((_, i) => i / (pts.length - 1));
  return u.map((v) => v / total);
}

/**
 * 양 끝점과 접선 방향을 고정한 채 핸들 길이만 최소제곱으로 푼다.
 *
 * 미지수가 2개(좌우 핸들 길이)뿐이라 2×2 정규방정식 하나로 닫힌 해가 나온다 — 그래서 이
 * 알고리즘이 1990년대 하드웨어에서도 실시간이었다.
 */
function generateBezier(pts: readonly P[], u: readonly number[], t1: P, t2: P): P[] {
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i];
    const m = 1 - t;
    const b0 = m * m * m;
    const b1 = 3 * m * m * t;
    const b2 = 3 * m * t * t;
    const b3 = t * t * t;
    const a0x = t1[0] * b1;
    const a0y = t1[1] * b1;
    const a1x = t2[0] * b2;
    const a1y = t2[1] * b2;
    c00 += a0x * a0x + a0y * a0y;
    c01 += a0x * a1x + a0y * a1y;
    c11 += a1x * a1x + a1y * a1y;
    const rx = pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3));
    const ry = pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3));
    x0 += a0x * rx + a0y * ry;
    x1 += a1x * rx + a1y * ry;
  }
  const det = c00 * c11 - c01 * c01;
  let a0 = Math.abs(det) < 1e-12 ? 0 : (x0 * c11 - x1 * c01) / det;
  let a1 = Math.abs(det) < 1e-12 ? 0 : (c00 * x1 - x0 * c01) / det;
  const seg = dist(p0, p3);
  // 음수·0 길이 해는 핸들이 뒤집힌 곡선이다(고리가 생긴다). 원문대로 코드 길이 1/3 로 물러선다.
  if (a0 < 1e-6 * seg || a1 < 1e-6 * seg) {
    a0 = seg / 3;
    a1 = seg / 3;
  }
  return [
    p0,
    [p0[0] + t1[0] * a0, p0[1] + t1[1] * a0],
    [p3[0] + t2[0] * a1, p3[1] + t2[1] * a1],
    p3,
  ];
}

/** 점 q 에서 선분 ab 까지의 거리. */
function segDist(q: P, a: P, b: P): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len = vx * vx + vy * vy;
  const t = len > 0 ? Math.min(1, Math.max(0, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / len)) : 0;
  return Math.hypot(q[0] - (a[0] + t * vx), q[1] - (a[1] + t * vy));
}

/**
 * 최대 편차와 그 지점. 양 끝점은 구성상 정확히 맞으므로 뺀다.
 *
 * **표본 위치만 재면 안 된다.** 표본이 양 끝에 몰린 run 에서는 가운데가 아무리 부풀어도
 * 아무도 재지 않는다 — 윤곽선화의 '직선 밑변 + 둥근 캡 이음매'가 정확히 그 모양이라
 * (u ≈ [0, 0.018, 0.982, 1]) 밑변이 11px 아래로 휘고도 오차 0.5 로 통과했고, 그 결과
 * 화살촉이 링 안에 삼켜졌다(46 §7 (v)). 인접 표본 사이 중점도 **폴리라인 선분까지의**
 * 거리로 함께 잰다 — 곡선은 표본을 잇는 선분을 근사하는 것이지 표본 4개만 맞히면 되는
 * 것이 아니다.
 */
function maxError(pts: readonly P[], bez: P[], u: readonly number[]): [number, number] {
  let max = 0;
  let idx = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const q = bezAt(bez, u[i]);
    const d = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]);
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const q = bezAt(bez, (u[i] + u[i + 1]) / 2);
    const d = segDist(q, pts[i], pts[i + 1]);
    if (d > max) {
      max = d;
      idx = i + 1;
    }
  }
  return [max, idx];
}

/** 각 점을 곡선 위 최근접 파라미터로 다시 붙인다(뉴턴-랩슨 1스텝). */
function reparam(bez: P[], pts: readonly P[], u: readonly number[]): number[] {
  return u.map((t, i) => {
    const q = bezAt(bez, t);
    const dx = q[0] - pts[i][0];
    const dy = q[1] - pts[i][1];
    // 제어점 차분 A,B,C 로 B'(t)=3(m²A+2mtB+t²C), B''(t)=6(m(B−A)+t(C−B)).
    const m = 1 - t;
    const ax = bez[1][0] - bez[0][0];
    const ay = bez[1][1] - bez[0][1];
    const bx = bez[2][0] - bez[1][0];
    const by = bez[2][1] - bez[1][1];
    const cx = bez[3][0] - bez[2][0];
    const cy = bez[3][1] - bez[2][1];
    const d1x = 3 * (m * m * ax + 2 * m * t * bx + t * t * cx);
    const d1y = 3 * (m * m * ay + 2 * m * t * by + t * t * cy);
    const d2x = 6 * (m * (bx - ax) + t * (cx - bx));
    const d2y = 6 * (m * (by - ay) + t * (cy - by));
    const den = d1x * d1x + d1y * d1y + dx * d2x + dy * d2y;
    if (Math.abs(den) < 1e-12) return t;
    const next = t - (dx * d1x + dy * d1y) / den;
    return next < 0 ? 0 : next > 1 ? 1 : next;
  });
}

/** 한 구간을 3차 베지어 하나 이상으로 맞춰 `out` 에 쌓는다. */
function fitCubic(pts: P[], t1: P, t2: P, err: number, out: P[][]): void {
  const n = pts.length;
  if (n < 2) return;
  if (n === 2) {
    const d = dist(pts[0], pts[1]) / 3;
    out.push([
      pts[0],
      [pts[0][0] + t1[0] * d, pts[0][1] + t1[1] * d],
      [pts[1][0] + t2[0] * d, pts[1][1] + t2[1] * d],
      pts[1],
    ]);
    return;
  }
  let u = chordParam(pts);
  let bez = generateBezier(pts, u, t1, t2);
  let [err0, split] = maxError(pts, bez, u);
  if (err0 <= err) {
    out.push(bez);
    return;
  }
  // 조금 벗어난 정도면 쪼개기 전에 파라미터만 고쳐 본다 — 정점 수가 눈에 띄게 줄어든다.
  if (err0 < err * 4) {
    for (let i = 0; i < MAX_REPARAM; i++) {
      u = reparam(bez, pts, u);
      bez = generateBezier(pts, u, t1, t2);
      [err0, split] = maxError(pts, bez, u);
      if (err0 <= err) {
        out.push(bez);
        return;
      }
    }
  }
  // 최대오차 지점에서 분할. 그 자리의 접선은 이웃 두 점을 잇는 방향(중앙차분)이라 좌우가
  // 매끄럽게 이어진다 — 한쪽 이웃만 쓰면 이음매마다 미세한 꺾임이 남는다.
  const s = Math.min(Math.max(split, 1), n - 2);
  let ct = unit(pts[s - 1][0] - pts[s + 1][0], pts[s - 1][1] - pts[s + 1][1]);
  if (ct[0] === 0 && ct[1] === 0) ct = unit(pts[s - 1][0] - pts[s][0], pts[s - 1][1] - pts[s][1]);
  fitCubic(pts.slice(0, s + 1), t1, ct, err, out);
  fitCubic(pts.slice(s), [-ct[0], -ct[1]], t2, err, out);
}

// ── 공개 ────────────────────────────────────────────────────────────────────

/**
 * 폴리라인 `[x0,y0,…]` → 정점 배열.
 *
 * `closed` 면 이음매를 **가장 급하게 꺾이는 점**으로 돌려 놓는다. 아무 데나 끊으면 그 자리에
 * 접선 불연속이 남아 매끈한 원에 각이 하나 생긴다 — 코너 자리로 옮기면 어차피 각인 곳이라
 * 보이지 않는다. 불리언 결과 링(46 §3.5)이 정확히 이 경로로 온다.
 *
 * 반환 정점의 `mode` 는 핸들에서 파생한다(`vertModeOf`). 검출된 코너만 `corner` 로 못 박는다:
 * 피팅 오차 때문에 두 핸들이 우연히 거의 공선이 되면 매끈한 정점으로 잘못 표시되고, 47 이
 * 그 표시를 믿고 핸들을 맞추는 순간 사용자가 그린 각이 펴진다.
 */
export function fitPolyline(pts: readonly number[], opts: FitOptions = {}): PathVert[] {
  const maxErr = Math.max(1e-3, opts.maxErr ?? 0.5);
  const cornerDeg = opts.cornerDeg ?? 30;
  const closed = opts.closed ?? false;

  let src = dedupe(pts);
  if (closed && src.length > 1) {
    const f = src[0];
    const l = src[src.length - 1];
    if (Math.abs(f[0] - l[0]) < 1e-6 && Math.abs(f[1] - l[1]) < 1e-6) src.pop();
  }
  if (src.length === 0) return [];
  if (src.length === 1) {
    return [{ x: src[0][0], y: src[0][1], inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" }];
  }

  const cornerRad = (cornerDeg * Math.PI) / 180;
  const ring = closed && src.length >= 3;
  // 이음매에서 양쪽이 공유할 접선. 매끈한 링에서만 쓴다(코너면 null — 각을 펴면 안 된다).
  let seamT: P | null = null;
  if (ring) {
    let best = 0;
    let bestTurn = -1;
    for (let i = 0; i < src.length; i++) {
      const a = turnAt(src, i, src.length);
      if (a > bestTurn) {
        bestTurn = a;
        best = i;
      }
    }
    if (best > 0) src = src.slice(best).concat(src.slice(0, best));
    src = src.concat([src[0]]); // 링을 열린 폴리라인으로 편다
    if (bestTurn <= cornerRad) {
      // 이음매 양쪽의 접선을 **하나의 중앙차분**으로 묶는다. 각 끝에서 이웃 현으로 따로
      // 구하면 표본 간격의 절반씩(원 120표본이면 좌우 1.5°) 어긋나 매끈한 원에 각이 하나 남는다.
      seamT = unit(src[1][0] - src[src.length - 2][0], src[1][1] - src[src.length - 2][1]);
      if (seamT[0] === 0 && seamT[1] === 0) seamT = null;
    }
  }

  // 코너 검출 — 이 이후로는 열린 폴리라인 하나만 다룬다.
  const cuts: number[] = [0];
  for (let i = 1; i < src.length - 1; i++) {
    if (turnAt(src, i, src.length) > cornerRad) cuts.push(i);
  }
  cuts.push(src.length - 1);

  const beziers: P[][] = [];
  const cornerAt = new Set<number>(); // 결과 정점 인덱스 중 코너로 못 박을 것
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k];
    const b = cuts[k + 1];
    const run = src.slice(a, b + 1);
    if (run.length < 2) continue;
    let t1 = unit(run[1][0] - run[0][0], run[1][1] - run[0][1]);
    let t2 = unit(
      run[run.length - 2][0] - run[run.length - 1][0],
      run[run.length - 2][1] - run[run.length - 1][1],
    );
    if (t1[0] === 0 && t1[1] === 0) t1 = [1, 0];
    if (t2[0] === 0 && t2[1] === 0) t2 = [-1, 0];
    if (seamT && k === 0) t1 = seamT;
    if (seamT && k + 2 === cuts.length) t2 = [-seamT[0], -seamT[1]];
    fitCubic(run, t1, t2, maxErr, beziers);
    if (k + 2 < cuts.length) cornerAt.add(beziers.length); // 이 구간의 끝 정점 = 다음 정점 번호
  }
  if (beziers.length === 0) return [];

  const verts: PathVert[] = [
    {
      x: beziers[0][0][0],
      y: beziers[0][0][1],
      inX: 0,
      inY: 0,
      outX: 0,
      outY: 0,
      mode: "corner",
    },
  ];
  for (const b of beziers) {
    const prev = verts[verts.length - 1];
    prev.outX = b[1][0] - prev.x;
    prev.outY = b[1][1] - prev.y;
    verts.push({
      x: b[3][0],
      y: b[3][1],
      inX: b[2][0] - b[3][0],
      inY: b[2][1] - b[3][1],
      outX: 0,
      outY: 0,
      mode: "corner",
    });
  }

  if (ring && verts.length > 1) {
    // 편 폴리라인의 마지막 정점은 첫 정점과 같은 자리다 — in 핸들만 넘기고 지운다.
    const last = verts.pop();
    if (last) {
      verts[0].inX = last.inX;
      verts[0].inY = last.inY;
    }
  }

  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    v.mode = cornerAt.has(i) ? "corner" : vertModeOf(v.inX, v.inY, v.outX, v.outY);
  }
  return verts;
}
