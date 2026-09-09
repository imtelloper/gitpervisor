// 불리언 4연산 · 평탄화 · 패스 분리 (태스크 46 §3.5·§3.6). **순수 모듈** — 캔버스를 만지지 않는다.
//
// 파이프라인은 §3.5 그대로다: 객체 → `toPathObject` → 서브패스 평탄화(0.25px) → 링 →
// 연산 → 링마다 재피팅 → PathNode. 스타일은 z 최상위 객체, 결과 `fillRule` 은 nonzero.
//
// **클리핑 엔진은 자체 구현이다.** §3.5 표가 고른 `polygon-clipping` 은 저장소에 설치돼 있지
// 않고(`package.json` deps 실측 — 46 §5 1단계가 함께 설치하기로 한 두 패키지가 아직 없다),
// 이 태스크의 파일 분담에는 package.json 이 없다. 대신 같은 결과를 내는 고전 절차를 쓴다:
//
//   ① 모든 변을 서로 자른다(교차·T 접합·겹친 변) → ② 정점을 1e-6px 격자로 병합해 같은 점을
//   같은 id 로 만든다 → ③ 같은 두 점을 잇는 변을 한 줄로 묶고 피연산자별 **방향 합**(D)을 센다
//   → ④ 변마다 법선 방향으로 광선을 쏴 감김수 W 를 재고 양쪽 면(W, W−D)에 술어를 적용해
//   경계에 남을 변만 고른다 → ⑤ 각 정점에서 가장 시계방향인 다음 변을 골라 링으로 잇는다.
//
// ②가 없으면 겹친 정점이 서로 다른 점으로 남아 링이 이어지지 않고, ①이 T 접합을 안 자르면
// 겹친 변이 서로 다른 변으로 남아 ③의 상쇄가 일어나지 않는다 — 둘 다 **조용히 빈 패스**로
// 끝난다. 자기교차는 ①이 자기 자신끼리도 자르므로 별도 처리가 필요 없고, 완전 포함은 ④가
// 안쪽 링의 방향을 뒤집어 자동으로 구멍이 된다(nonzero 로 그리면 뚫린다).
//
// ④의 광선 방향을 **변의 법선**으로 잡는 것이 핵심이다. x축 광선을 쓰면 수평 변에서 판정이
// 무너지는데(변 자신이 광선 위에 눕는다), 법선은 절대 변과 나란해질 수 없다. 변 자신은
// 광선 원점(교차 파라미터 0)에서만 걸리므로 그 하나만 걸러내면 된다.

import { objectAnchor } from "../geometry";
import {
  newObjId,
  type GeomNode,
  type PathNode,
  type PathVert,
  type TextNode,
} from "../types";
import { badgeLabelNode, pathFrom, toPathObject } from "./convert";
import { fitPolyline } from "./fit";
import { flattenSubPath, type SubPath } from "./path";

export type BoolOp = "union" | "subtract" | "intersect" | "exclude";

/** 곡선 평탄화 허용오차(oriented px) — §3.5 기본값. */
const TOL = 0.25;

/**
 * 정점 병합 격자와 0 판정. 좌표는 oriented px(이미지 해상도라 ~10⁴ 이하)라 float64 의 절대
 * 오차는 1e-12 수준이다 — MERGE 는 그보다 여섯 자리 위, 평탄화 오차(0.25px)보다 다섯 자리
 * 아래라 "붙어야 할 점은 붙고 떨어져야 할 점은 안 붙는" 구간에 있다.
 */
const MERGE = 1e-6;
const EPS = 1e-9;

/** 링 = [x0,y0,x1,y1,…], 마지막 점에서 첫 점으로 암묵 닫힘. */
type Ring = readonly number[];

/** 클리핑 피연산자 하나 — 링 묶음과 그 묶음을 면으로 읽는 규칙. */
export interface ClipRegion {
  rings: readonly Ring[];
  rule: "nonzero" | "evenodd";
}

interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  op: number;
}

function filled(rule: ClipRegion["rule"], w: number): boolean {
  return rule === "evenodd" ? (w & 1) !== 0 : w !== 0;
}

/**
 * 점 `m` 에서 방향 `n` 으로 쏜 광선의 감김수. `m` 이 경계 위에 있어도 **`m` 을 지나는 변은
 * 세지 않으므로**(교차 x ≤ EPS) 결과는 `m + εn` 쪽 면의 감김수다 — 반대쪽은 호출자가 D 를 빼서 얻는다.
 *
 * 광선을 +x 로 놓는 좌표계로 회전해 계산한다. 반열림 비교(`>0` 한쪽만)라 광선이 정점을 정확히
 * 스쳐도 두 번 세거나 빠뜨리지 않는다 — 이게 없으면 격자에 맞춘 사각형들에서 판정이 흔들린다.
 */
function rayWinding(rings: readonly Ring[], mx: number, my: number, nx: number, ny: number): number {
  let w = 0;
  for (const ring of rings) {
    const n = ring.length >> 1;
    if (n < 3) continue;
    let ex = ring[(n - 1) * 2] - mx;
    let ey = ring[(n - 1) * 2 + 1] - my;
    let px = ex * nx + ey * ny;
    let py = -ex * ny + ey * nx;
    for (let i = 0; i < n; i++) {
      ex = ring[i * 2] - mx;
      ey = ring[i * 2 + 1] - my;
      const qx = ex * nx + ey * ny;
      const qy = -ex * ny + ey * nx;
      if (py > 0 !== qy > 0) {
        const xi = px + (-py / (qy - py)) * (qx - px);
        if (xi > EPS) w += qy > py ? 1 : -1;
      }
      px = qx;
      py = qy;
    }
  }
  return w;
}

/** 파라미터 t 가 변의 **안쪽**이면 자른다. 끝점은 이미 정점이라 자를 것이 없다. */
function addCut(out: number[], t: number, pad: number): void {
  if (t > pad && t < 1 - pad) out.push(t);
}

/** 두 변의 교차·겹침을 각자의 자를 지점으로 기록한다. */
function pairCuts(a: Edge, b: Edge, ca: number[], cb: number[]): void {
  const rx = a.x1 - a.x0;
  const ry = a.y1 - a.y0;
  const sx = b.x1 - b.x0;
  const sy = b.y1 - b.y0;
  const la = Math.hypot(rx, ry);
  const lb = Math.hypot(sx, sy);
  if (la < EPS || lb < EPS) return;
  const qx = b.x0 - a.x0;
  const qy = b.y0 - a.y0;
  const den = rx * sy - ry * sx;
  const pa = MERGE / la;
  const pb = MERGE / lb;
  if (Math.abs(den) > EPS * la * lb) {
    const t = (qx * sy - qy * sx) / den;
    const u = (qx * ry - qy * rx) / den;
    if (t < -pa || t > 1 + pa || u < -pb || u > 1 + pb) return;
    addCut(ca, t, pa);
    addCut(cb, u, pb);
    return;
  }
  // 나란하다 — 같은 직선 위일 때만(겹친 변·겹친 정점) 서로의 끝점을 자를 지점으로 넘긴다.
  if (Math.abs(qx * ry - qy * rx) > MERGE * la) return;
  const ia = 1 / (la * la);
  const ib = 1 / (lb * lb);
  addCut(ca, (qx * rx + qy * ry) * ia, pa);
  addCut(ca, ((b.x1 - a.x0) * rx + (b.y1 - a.y0) * ry) * ia, pa);
  addCut(cb, ((a.x0 - b.x0) * sx + (a.y0 - b.y0) * sy) * ib, pb);
  addCut(cb, ((a.x1 - b.x0) * sx + (a.y1 - b.y0) * sy) * ib, pb);
}

/**
 * 모든 변을 서로 자른다. x 로 정렬한 활성 목록으로 훑어 전부 대 전부(O(E²))를 피한다 —
 * 윤곽선화는 획 하나가 변 수천 개라 없으면 체감 정지한다.
 *
 * ponytail: 활성 목록이 배열 필터라 겹치는 변이 많은 입력에서는 여전히 제곱에 가깝다.
 * 실제로 느려지면 그때 구간 트리로 바꾼다.
 */
function splitAll(edges: readonly Edge[]): Edge[] {
  const cuts: number[][] = edges.map(() => []);
  const minX = edges.map((e) => Math.min(e.x0, e.x1));
  const maxX = edges.map((e) => Math.max(e.x0, e.x1));
  const minY = edges.map((e) => Math.min(e.y0, e.y1));
  const maxY = edges.map((e) => Math.max(e.y0, e.y1));
  const order = edges.map((_, i) => i).sort((p, q) => minX[p] - minX[q]);
  let active: number[] = [];
  for (const i of order) {
    active = active.filter((k) => maxX[k] >= minX[i] - MERGE);
    for (const k of active) {
      if (maxY[k] < minY[i] - MERGE || maxY[i] < minY[k] - MERGE) continue;
      pairCuts(edges[k], edges[i], cuts[k], cuts[i]);
    }
    active.push(i);
  }

  const out: Edge[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ts = cuts[i];
    if (ts.length === 0) {
      out.push(e);
      continue;
    }
    ts.sort((p, q) => p - q);
    let prev = 0;
    let px = e.x0;
    let py = e.y0;
    for (const t of ts) {
      if (t - prev <= 0) continue;
      const x = e.x0 + (e.x1 - e.x0) * t;
      const y = e.y0 + (e.y1 - e.y0) * t;
      out.push({ x0: px, y0: py, x1: x, y1: y, op: e.op });
      prev = t;
      px = x;
      py = y;
    }
    out.push({ x0: px, y0: py, x1: e.x1, y1: e.y1, op: e.op });
  }
  return out;
}

/**
 * 피연산자들을 술어로 합성해 결과 링을 낸다. 술어는 각 피연산자의 "이 면이 안쪽인가"를 받는다
 * (합집합 `a||b`, 차집합 `a&&!b`, 교집합 `a&&b`, 제외 `a!==b`).
 *
 * 결과 링은 **내부가 진행 방향 왼쪽**으로 통일된다 — 바깥 링과 구멍 링의 방향이 저절로
 * 반대가 되므로 nonzero 로 그리면 구멍이 뚫린다. 방향을 통일하지 않으면 겹친 조각끼리
 * 상쇄돼 멀쩡한 면에 구멍이 생긴다.
 */
export function clipRegions(
  regions: readonly ClipRegion[],
  pred: (inside: boolean[]) => boolean,
): number[][] {
  const raw: Edge[] = [];
  for (let op = 0; op < regions.length; op++) {
    for (const ring of regions[op].rings) {
      const n = ring.length >> 1;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        raw.push({
          x0: ring[i * 2],
          y0: ring[i * 2 + 1],
          x1: ring[j * 2],
          y1: ring[j * 2 + 1],
          op,
        });
      }
    }
  }
  if (raw.length === 0) return [];

  const split = splitAll(raw);

  // 정점 병합 — 이웃 격자 9칸까지 본다. 한 칸만 보면 격자 경계에 걸친 두 점이 갈라진다.
  const bucket = new Map<string, number>();
  const px: number[] = [];
  const py: number[] = [];
  const idOf = (x: number, y: number): number => {
    const gx = Math.round(x / MERGE);
    const gy = Math.round(y / MERGE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const hit = bucket.get(`${gx + dx},${gy + dy}`);
        if (hit !== undefined && Math.abs(px[hit] - x) <= MERGE && Math.abs(py[hit] - y) <= MERGE) {
          return hit;
        }
      }
    }
    const id = px.length;
    px.push(x);
    py.push(y);
    bucket.set(`${gx},${gy}`, id);
    return id;
  };

  const groups = new Map<string, { a: number; b: number; d: number[] }>();
  for (const e of split) {
    const ia = idOf(e.x0, e.y0);
    const ib = idOf(e.x1, e.y1);
    if (ia === ib) continue;
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    const key = `${lo},${hi}`;
    let g = groups.get(key);
    if (!g) {
      g = { a: lo, b: hi, d: new Array<number>(regions.length).fill(0) };
      groups.set(key, g);
    }
    g.d[e.op] += ia === lo ? 1 : -1;
  }

  const kept: { a: number; b: number }[] = [];
  for (const g of groups.values()) {
    // 방향 합이 전부 0 = 같은 변이 양방향으로 겹쳤다. 양면의 감김수가 같아 경계일 수 없다.
    if (g.d.every((v) => v === 0)) continue;
    const ax = px[g.a];
    const ay = py[g.a];
    const bx = px[g.b];
    const by = py[g.b];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < EPS) continue;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const left: boolean[] = [];
    const right: boolean[] = [];
    for (let k = 0; k < regions.length; k++) {
      const w = rayWinding(regions[k].rings, mx, my, nx, ny);
      left.push(filled(regions[k].rule, w));
      right.push(filled(regions[k].rule, w - g.d[k]));
    }
    const l = pred(left);
    if (l === pred(right)) continue;
    kept.push(l ? { a: g.a, b: g.b } : { a: g.b, b: g.a });
  }
  if (kept.length === 0) return [];

  // 잇기 — 갈림길에서는 들어온 방향의 반대에서 가장 시계방향인 변을 고른다(면 순회 규칙).
  // 차수 2 가 대부분이지만 두 도형이 한 점에서만 만나면 여기가 결과를 가른다.
  const out = new Map<number, number[]>();
  for (let i = 0; i < kept.length; i++) {
    const arr = out.get(kept[i].a);
    if (arr) arr.push(i);
    else out.set(kept[i].a, [i]);
  }
  const used = new Array<boolean>(kept.length).fill(false);
  const rings: number[][] = [];
  for (let s = 0; s < kept.length; s++) {
    if (used[s]) continue;
    const ring: number[] = [];
    const start = kept[s].a;
    let cur = s;
    let guard = kept.length + 1;
    for (;;) {
      used[cur] = true;
      ring.push(px[kept[cur].a], py[kept[cur].a]);
      const v = kept[cur].b;
      if (v === start) break;
      const cand = out.get(v);
      let next = -1;
      if (cand) {
        const rev = Math.atan2(py[kept[cur].a] - py[v], px[kept[cur].a] - px[v]);
        let bestTurn = Infinity;
        for (const i of cand) {
          if (used[i]) continue;
          let turn = rev - Math.atan2(py[kept[i].b] - py[v], px[kept[i].b] - px[v]);
          while (turn <= 0) turn += Math.PI * 2;
          while (turn > Math.PI * 2) turn -= Math.PI * 2;
          if (turn < bestTurn) {
            bestTurn = turn;
            next = i;
          }
        }
      }
      if (next < 0 || guard-- <= 0) {
        // 닫히지 않은 사슬은 결과가 아니다(수치 오차로 한 변이 빠진 경우). 버린다.
        ring.length = 0;
        break;
      }
      cur = next;
    }
    if (ring.length >= 6) rings.push(ring);
  }
  return rings;
}

// ── 46 §4 계약 ───────────────────────────────────────────────────────────────

/** 객체 하나의 면 — 열린 서브패스도 캔버스처럼 암묵으로 닫아 링으로 센다(§3.2). */
function regionOf(path: PathNode, tol: number): ClipRegion {
  const rings: Ring[] = [];
  for (const sub of path.subpaths) {
    const pts = flattenSubPath(sub, tol);
    if (pts.length >= 6) rings.push(pts);
  }
  return { rings, rule: path.fillRule };
}

/** 링 → 서브패스. 재피팅은 30° 코너를 살린 3차 근사(오차 0.5px, §3.5) — 직선 구간은 핸들 0. */
function ringsToSubPaths(rings: readonly Ring[], refit: boolean): SubPath[] {
  return rings.map((ring) => ({
    verts: refit
      ? fitPolyline(ring, { maxErr: 0.5, cornerDeg: 30, closed: true })
      : cornerVerts(ring),
    closed: true,
  }));
}

function cornerVerts(ring: readonly number[]): PathVert[] {
  const verts: PathVert[] = [];
  for (let i = 0; i < ring.length; i += 2) {
    verts.push({ x: ring[i], y: ring[i + 1], inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" });
  }
  return verts;
}

const PREDICATES: Record<BoolOp, (v: boolean[]) => boolean> = {
  union: (v) => v[0] || v[1],
  subtract: (v) => v[0] && !v[1],
  intersect: (v) => v[0] && v[1],
  exclude: (v) => v[0] !== v[1],
};

/**
 * `rot` 을 정점에 굽고 각도를 0 으로 만든다 — **피연산자가 둘 이상일 때만** 쓴다.
 *
 * `toPathObject` 가 주는 좌표는 로컬(rot 미적용)이고 회전은 렌더가 `objectAnchor` 기준으로만
 * 건다. 회전각·앵커가 서로 다른 두 도형의 로컬 링을 그대로 클립하면, 화면에서 겹치지도 않는
 * 자리가 겹친 것으로 계산되고 결과에는 z 최상위 하나의 rot 만 찍혀 **어느 피연산자와도 맞지
 * 않는 도형**이 남는다(파괴적 1커밋이라 되돌릴 것도 없다). 클립 전에 회전을 기하로 흡수시킨다.
 *
 * 단일 노드 연산(윤곽선화·'패스로')은 로컬 기하 + 원본 rot 이 이미 정확하므로 이 함수를 태우지
 * 않는다 — 태우면 회전 편집 상태를 사용자 몰래 굽는다.
 */
function bakeRot(p: PathNode, src: GeomNode): PathNode {
  const rad = (src.rot * Math.PI) / 180;
  if (rad === 0) return p.rot === 0 ? p : { ...p, rot: 0 };
  const a = objectAnchor(src);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    ...p,
    rot: 0,
    subpaths: p.subpaths.map((sub) => ({
      closed: sub.closed,
      verts: sub.verts.map((v) => ({
        ...v,
        x: a.x + (v.x - a.x) * cos - (v.y - a.y) * sin,
        y: a.y + (v.x - a.x) * sin + (v.y - a.y) * cos,
        // 핸들은 상대 벡터라 앵커 없이 방향만 돌린다.
        inX: v.inX * cos - v.inY * sin,
        inY: v.inX * sin + v.inY * cos,
        outX: v.outX * cos - v.outY * sin,
        outY: v.outX * sin + v.outY * cos,
      })),
    })),
  };
}

/**
 * 4연산. `objs` 는 **z 순서**(앞이 아래)다 — 차집합은 시안·Figma 관례대로 맨 아래에서 위를 뺀다.
 * 3개 이상이면 왼쪽부터 접는다(네 연산 모두 결합법칙이 성립해 n항 결과와 같다).
 *
 * 스타일·부모는 z 최상위 객체에서 가져오고 id 는 새로 만든다. 결과가 비면(교집합이 없다 등)
 * `null` — 호출자는 문서를 건드리지 말아야 한다.
 */
export function booleanOp(
  objs: readonly GeomNode[],
  op: BoolOp,
  opts?: { tol?: number; refit?: boolean },
): PathNode | null {
  if (objs.length < 2) return null;
  const tol = opts?.tol ?? TOL;
  const regions: ClipRegion[] = [];
  for (const o of objs) {
    const p = toPathObject(o);
    if (!p) return null;
    regions.push(regionOf(bakeRot(p, o), tol));
  }
  const pred = PREDICATES[op];
  let acc = regions[0];
  for (let i = 1; i < regions.length; i++) {
    acc = { rings: clipRegions([acc, regions[i]], pred), rule: "nonzero" };
    if (acc.rings.length === 0) return null;
  }
  const src = objs[objs.length - 1];
  const subpaths = ringsToSubPaths(acc.rings, opts?.refit !== false);
  if (subpaths.length === 0) return null;
  // 링이 이미 회전을 품고 있으므로 결과 각도는 0 이다 — src 의 rot 을 물려받으면 방금 구운
  // 회전이 한 번 더 걸린다.
  return { ...pathFrom(src, subpaths, newObjId(), "nonzero"), rot: 0 };
}

/**
 * 평탄화 — 클리핑 없이 서브패스를 **결합**한 패스 하나(§3.6). 선택 1개면 id 를 지켜 '패스로'가
 * 되고(선택·styleRefs 보존), 2개 이상이면 새 id 다.
 *
 * 뱃지 숫자는 `extras` 로 따라 나온다. 그러지 않으면 뱃지를 평탄화한 순간 번호가 사라진다.
 * 컨테이너는 호출자가 리프까지 펼쳐서 넘긴다 — 프레임 자신은 `toPathObject` 가 null 이라 빠진다.
 */
export function flattenObjects(
  objs: readonly GeomNode[],
): { path: PathNode; extras: TextNode[] } | null {
  if (objs.length === 0) return null;
  const subpaths: SubPath[] = [];
  const extras: TextNode[] = [];
  // 서브패스들이 결과 노드 **하나**의 rot 아래로 들어가므로, 각도가 섞이면 그 한 값이 나머지를
  // 전부 엉뚱한 프레임에 놓는다. 1개짜리('패스로')는 프레임이 하나뿐이라 그대로 지킨다.
  const bake = objs.length > 1;
  for (const o of objs) {
    const p = toPathObject(o);
    if (!p) continue;
    for (const sub of (bake ? bakeRot(p, o) : p).subpaths) subpaths.push(sub);
    if (o.kind === "badge") extras.push(badgeLabelNode(o));
  }
  if (subpaths.length === 0) return null;
  const src = objs[objs.length - 1];
  const id = objs.length === 1 ? objs[0].id : newObjId();
  const path = pathFrom(src, subpaths, id);
  return { path: bake ? { ...path, rot: 0 } : path, extras };
}

/**
 * 서브패스마다 노드 하나로 쪼갠다. 첫 것은 id 를 지키므로 선택이 끊기지 않는다.
 * 서브패스가 하나면 no-op — 호출자(45 버튼)가 길이 1 을 보고 커밋을 건너뛴다.
 */
export function separateSubPaths(node: PathNode): PathNode[] {
  if (node.subpaths.length < 2) return [node];
  return node.subpaths.map((sub, i) => ({
    ...node,
    id: i === 0 ? node.id : newObjId(),
    subpaths: [sub],
  }));
}
