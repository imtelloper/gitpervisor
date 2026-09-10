// 정점 연산 — 노드 편집(47)이 `PathNode` 를 바꾸는 **유일한** 곳. 순수하다: DOM 도 스토어도
// 히스토리도 모르고, 들어온 노드를 변형하지 않는다.
//
// 계약 셋. 어기면 전부 조용히 망가진다:
//
// ① **바뀐 것이 없으면 같은 참조를 돌려준다.** 커밋 판정이 참조 비교라(`pointer.ts` 의
//    `onPointerUp`: `byId.get(o.id) !== o`), 값이 같은 새 객체를 돌려주면 클릭 한 번(길이 0
//    드래그)이 히스토리 한 칸을 먹는다 — 상한이 200칸이다. 성능이 아니라 정확성 문제다.
//    덤으로, 새 `verts` 배열은 46 의 평탄화·auto 캐시(정점 배열 **참조**를 키로 하는 WeakMap)를
//    통째로 무효화해 포인터 이동마다 전체 재평탄화를 돌린다.
//
// ② **경계 입력에서 던지지 않는다.** 범위 밖 인덱스·빈 서브패스·정점 1개짜리가 그대로 온다.
//    `schema.ts` 의 정규화는 필드 **존재**만 보장하지 구조가 편집 가능한지는 보지 않고,
//    undo 로 정점이 줄어든 뒤 낡은 `VertRef` 가 도착하는 경로도 있다. 범위 밖 ref 는 말없이
//    버리고, 할 수 있는 일이 없으면 원본을 그대로 돌려준다(= 히스토리 칸도 안 생긴다).
//
// ③ **auto 핸들을 문서에 쓰지 않는다.** 물질화 지점은 46 `normalizeAuto` **한 벌**뿐이고
//    렌더·투영·bbox·분할이 전부 그걸 지난다. 문서에 값을 박아 넣어도 `normalizeAuto` 가
//    저장값을 무시하고 덮으므로 죽은 데이터가 되고, 되레 "이웃을 옮겼는데 곡선이 안 따라온다"가
//    되살아난다(물질화한 값이 낡은 채 남으므로). `settleAuto` 는 그 위의 **읽기 어댑터**이고,
//    씨앗이 필요한 자리(`setVertMode` 의 mirrored/asymmetric, `moveHandle` 의 auto 승격)도
//    같은 함수를 지나 수식이 두 벌이 되지 않게 한다.
//
// 배경: DOCS/task/47-image-vector-pen-node-edit.md §3.3

import type { PathNode, PathVert } from "../types";
import { normalizeAuto, splitCubic, type SubPath } from "./path";

/** 정점 주소. `sub` 는 `PathNode.subpaths` 인덱스, `vert` 는 그 서브패스의 `verts` 인덱스. */
export type VertRef = { sub: number; vert: number };

/**
 * 인스펙터·컨텍스트 바가 보여 주는 5모드. 시안 ③ 의 `없음` 은 문서 모드가 아니라 **양 핸들이
 * (0,0)** 인 상태의 표시 이름이다 — 37 의 문서 모드는 4종 그대로다.
 */
export type NodeModeUi = PathVert["mode"] | "none";

/**
 * 핸들 유무 임계. 46 `path.ts` 의 `HANDLE_EPS` 와 **반드시 같은 값**이어야 한다(그쪽이 export
 * 하지 않아 값을 복제한다). 다르면 `vertModeOf` 가 "핸들 없음 = corner" 로 읽은 정점을 여기서는
 * 있다고 보고 반대편을 맞추려 들어, 사용자가 만진 적 없는 곡선이 튄다.
 */
const HANDLE_EPS = 1e-3;

/** 핸들이 있다고 볼 만한 길이인가. `vertModeOf` 의 corner 판정과 같은 잣대(hypot). */
function hasHandle(x: number, y: number): boolean {
  return Math.hypot(x, y) >= HANDLE_EPS;
}

/**
 * 두 정점 배열이 값으로 같은가 — 머리말 ① 의 "바뀐 것이 없으면 같은 참조" 를 **결과에서**
 * 확인하는 자리. 허용오차를 두지 않는다: 여기서 재는 것은 "연산이 아무 일도 안 했다"이지
 * "거의 같다"가 아니고, 근사로 재면 진짜 1e-9 이동이 커밋되지 않는다.
 */
function sameVerts(a: readonly PathVert[], b: readonly PathVert[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (p === q) continue;
    if (
      p.x !== q.x ||
      p.y !== q.y ||
      p.inX !== q.inX ||
      p.inY !== q.inY ||
      p.outX !== q.outX ||
      p.outY !== q.outY ||
      p.mode !== q.mode
    ) {
      return false;
    }
  }
  return true;
}

// ── auto 핸들 읽기 ───────────────────────────────────────────────────────────

const settledCache = new WeakMap<PathNode, PathNode>();

/**
 * `auto` 정점의 핸들이 채워진 **읽기용** 사본. 인스펙터의 핸들 in/out 표시, 핸들 크롬 좌표,
 * 핸들 노브 히트가 이 값을 본다 — 문서에는 (0,0) 이 그대로 있으므로 원본을 그냥 읽으면
 * "곡선은 휘어 있는데 핸들이 앵커에 붙어 있다"가 된다.
 *
 * **mutator 가 아니다**(머리말 ③). 서브패스마다 46 `normalizeAuto` 에 위임할 뿐이고, auto
 * 정점이 없으면 입력을 그대로 돌려준다.
 *
 * 결과를 자기 자신에도 캐시해 둔다 → `settleAuto(settleAuto(o)) === settleAuto(o)` 로 멱등하고,
 * 크롬이 매 프레임 부르는 경로라 두 번째부터는 계산이 없다.
 *
 * `refs` 는 §4 서명 호환으로 받되 **쓰지 않는다**: `normalizeAuto` 가 서브패스 단위로 이미
 * 캐시돼 있어 부분 갱신이 더 비싸고, 일부만 굳은 노드는 다른 서브패스를 읽는 호출자에게 함정이다.
 */
export function settleAuto(o: PathNode, _refs?: readonly VertRef[]): PathNode {
  const hit = settledCache.get(o);
  if (hit) return hit;
  let subpaths: SubPath[] | null = null;
  for (let i = 0; i < o.subpaths.length; i++) {
    const next = normalizeAuto(o.subpaths[i]);
    if (next === o.subpaths[i]) continue;
    if (!subpaths) subpaths = o.subpaths.slice();
    subpaths[i] = next;
  }
  const out = subpaths ? { ...o, subpaths } : o;
  settledCache.set(o, out);
  if (out !== o) settledCache.set(out, out);
  return out;
}

/**
 * 정점 i 를 `auto` 라고 가정했을 때의 핸들. 모드를 바꿀 때 "없는 쪽"의 씨앗이고, auto 정점의
 * 핸들을 잡았을 때의 출발값이다.
 *
 * 수식을 다시 쓰지 않고 `normalizeAuto` 를 한 번 더 지나게 하는 이유: 씨앗이 실제로 그려지던
 * 곡선과 갈라지면, 모드만 눌렀는데 선이 움직인다.
 *
 * 이웃이 없거나(정점 1개) 이웃 두 점이 겹치면 `normalizeAuto` 가 원본을 그대로 돌려주므로
 * 씨앗도 (0,0) 이다 — 호출자는 그 경우 아무 것도 하지 않는다.
 */
function autoVertAt(sub: SubPath, i: number): PathVert {
  if (sub.verts[i].mode === "auto") return normalizeAuto(sub).verts[i];
  const probe: SubPath = {
    verts: sub.verts.map((w, j) => (j === i ? { ...w, mode: "auto" as const } : w)),
    closed: sub.closed,
  };
  return normalizeAuto(probe).verts[i];
}

// ── ref 다루기 ───────────────────────────────────────────────────────────────

/**
 * ref 목록 → 서브패스별 정점 인덱스 집합. **범위 밖·정수 아닌 인덱스는 버린다**(머리말 ②).
 * 중복도 여기서 걸러지므로 같은 정점을 두 번 옮기는 일이 없다.
 */
function groupRefs(o: PathNode, refs: readonly VertRef[]): Map<number, Set<number>> {
  const groups = new Map<number, Set<number>>();
  for (const r of refs) {
    const sub = o.subpaths[r.sub];
    if (!sub || !Number.isInteger(r.vert) || r.vert < 0 || r.vert >= sub.verts.length) continue;
    let set = groups.get(r.sub);
    if (!set) groups.set(r.sub, (set = new Set()));
    set.add(r.vert);
  }
  return groups;
}

/**
 * 지목된 정점만 `fn` 으로 갈아 끼운 노드.
 *
 * `fn` 이 **같은 정점 객체**를 돌려주면 그 서브패스는 배열째 원본을 유지하고, 바뀐 서브패스가
 * 하나도 없으면 노드도 원본 그대로다(머리말 ①). `fn` 은 언제나 **편집 전** 서브패스를 받는다 —
 * 여러 정점을 한꺼번에 바꿀 때 앞 정점의 결과가 뒤 정점의 씨앗에 새어 들면 같은 선택에
 * 순서 의존이 생긴다.
 */
function editVerts(
  o: PathNode,
  groups: Map<number, Set<number>>,
  fn: (v: PathVert, sub: SubPath, i: number) => PathVert,
): PathNode {
  if (groups.size === 0) return o;
  let subpaths: SubPath[] | null = null;
  for (const [si, idx] of groups) {
    const sub = o.subpaths[si];
    let verts: PathVert[] | null = null;
    for (const i of idx) {
      const next = fn(sub.verts[i], sub, i);
      if (next === sub.verts[i]) continue;
      if (!verts) verts = sub.verts.slice();
      verts[i] = next;
    }
    if (!verts) continue;
    if (!subpaths) subpaths = o.subpaths.slice();
    subpaths[si] = { verts, closed: sub.closed };
  }
  return subpaths ? { ...o, subpaths } : o;
}

// ── 조회 ────────────────────────────────────────────────────────────────────

/**
 * 표시용 모드. `auto` 는 문서에 핸들이 (0,0) 인 채로 있으므로 **먼저** 걸러야 한다 —
 * 안 그러면 자동 정점이 인스펙터에 `없음` 으로 뜬다.
 */
export function vertModeUi(v: PathVert): NodeModeUi {
  if (v.mode === "auto") return "auto";
  return hasHandle(v.inX, v.inY) || hasHandle(v.outX, v.outY) ? v.mode : "none";
}

/** 정점 총수(HUD `노드 N`). */
export function vertCount(o: PathNode): number {
  let n = 0;
  for (const s of o.subpaths) n += s.verts.length;
  return n;
}

/** 세그먼트 총수. 닫힌 서브패스는 마지막 → 첫 정점 구간이 하나 더 있다(46 `segCount` 와 같은 규칙). */
export function segmentCount(o: PathNode): number {
  let n = 0;
  for (const s of o.subpaths) {
    if (s.verts.length < 2) continue;
    n += s.closed ? s.verts.length : s.verts.length - 1;
  }
  return n;
}

// ── 모드 전환 ────────────────────────────────────────────────────────────────

/** 반대편 핸들을 `ref` 의 반대 방향·주어진 길이로. 길이가 0 이면 그대로 (0,0). */
function opposite(rx: number, ry: number, len: number): [number, number] {
  const l = Math.hypot(rx, ry);
  if (l < HANDLE_EPS || len < HANDLE_EPS) return [0, 0];
  return [(-rx / l) * len, (-ry / l) * len];
}

/**
 * 선택 정점들의 모드 전환(시안 `없음 · 코너 · 대칭 · 비대칭 · 자동`).
 *
 * 이미 그 모드이고 핸들도 규칙에 맞으면 **원본을 돌려준다** — 버튼을 두 번 눌러 히스토리에
 * 빈 칸이 쌓이지 않게.
 */
export function setVertMode(o: PathNode, refs: readonly VertRef[], mode: NodeModeUi): PathNode {
  return editVerts(o, groupRefs(o, refs), (v, sub, i) => {
    switch (mode) {
      case "none": {
        // 시안 `없음` = 양 핸들 제거. 모드도 corner 로 내린다: `mirrored` 라고 적힌 채 핸들이
        // 없으면 다음 드래그가 "반대편을 맞춘다"며 없던 손잡이를 돋운다.
        if (v.mode === "corner" && !hasHandle(v.inX, v.inY) && !hasHandle(v.outX, v.outY)) return v;
        return { ...v, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" };
      }
      case "corner": {
        // 핸들은 **그대로 둔다**. 코너로 끊는다는 것은 다음 드래그부터 반대편이 안 따라온다는
        // 뜻이지(Figma break), 지금 곡선을 펴는 것이 아니다. 펴려면 `없음`.
        //
        // `auto` 만 예외다: 문서에 핸들이 (0,0) 이라(머리말 ③) 모드만 내리면 `normalizeAuto` 가
        // 더 이상 물질화하지 않아 **그 정점에서 곡선이 툭 펴진다** — `코너`와 `없음`의 결과가
        // 같아지고, 게다가 커밋 뒤 `vertModeUi` 가 양 핸들 0 을 보고 `없음`을 돌려줘 방금 누른
        // 버튼과 다른 칸이 눌린 채로 뜬다. 그래서 먼저 **굳히고** 모드를 내린다
        // (`moveHandle` 의 auto 승격·`mirrored`/`asymmetric` 씨앗과 같은 처리).
        if (v.mode !== "auto") return v.mode === "corner" ? v : { ...v, mode: "corner" };
        const seed = autoVertAt(sub, i);
        return {
          ...v,
          inX: seed.inX,
          inY: seed.inY,
          outX: seed.outX,
          outY: seed.outY,
          mode: "corner",
        };
      }
      case "auto":
        // 좌표는 굳히지 않는다(머리말 ③) — 소비 시점에 `normalizeAuto` 가 이웃에서 만든다.
        if (v.mode === "auto" && !hasHandle(v.inX, v.inY) && !hasHandle(v.outX, v.outY)) return v;
        return { ...v, inX: 0, inY: 0, outX: 0, outY: 0, mode: "auto" };
      case "mirrored": {
        // 기준은 out. 없으면 in 을 뒤집어 쓰고, 둘 다 없으면 auto 씨앗(열린 끝점은 out 이
        // 0 이라 in 쪽 씨앗을 뒤집는다).
        const seed = autoVertAt(sub, i);
        let ox = v.outX;
        let oy = v.outY;
        if (!hasHandle(ox, oy)) {
          if (hasHandle(v.inX, v.inY)) [ox, oy] = [-v.inX, -v.inY];
          else if (hasHandle(seed.outX, seed.outY)) [ox, oy] = [seed.outX, seed.outY];
          else [ox, oy] = [-seed.inX, -seed.inY];
        }
        // 이웃이 없어 씨앗도 못 만드는 정점(고립·이웃 중복) — 조용히 아무 것도 하지 않는다.
        if (!hasHandle(ox, oy)) return v;
        if (v.mode === "mirrored" && v.outX === ox && v.outY === oy && v.inX === -ox && v.inY === -oy) return v;
        return { ...v, inX: -ox, inY: -oy, outX: ox, outY: oy, mode: "mirrored" };
      }
      case "asymmetric": {
        // 방향만 반대로 맞추고 길이는 유지한다. 없는 쪽은 auto 씨앗으로 채우는데, 씨앗의
        // in/out 길이는 이웃까지 거리에서 나와 서로 다르므로 결과가 자연히 비대칭이다.
        const seed = autoVertAt(sub, i);
        let inX = hasHandle(v.inX, v.inY) ? v.inX : seed.inX;
        let inY = hasHandle(v.inX, v.inY) ? v.inY : seed.inY;
        const outX = hasHandle(v.outX, v.outY) ? v.outX : seed.outX;
        const outY = hasHandle(v.outX, v.outY) ? v.outY : seed.outY;
        if (!hasHandle(inX, inY) || !hasHandle(outX, outY)) return v;
        [inX, inY] = opposite(outX, outY, Math.hypot(inX, inY));
        if (v.mode === "asymmetric" && v.inX === inX && v.inY === inY && v.outX === outX && v.outY === outY)
          return v;
        return { ...v, inX, inY, outX, outY, mode: "asymmetric" };
      }
    }
  });
}

// ── 이동 ────────────────────────────────────────────────────────────────────

/**
 * 선택 정점 이동. **앵커만** 옮긴다 — 핸들은 정점 상대 좌표라 저절로 따라오고(37 §3.2),
 * 이웃의 auto 핸들도 소비 시점에 다시 계산되므로 여기서 손댈 것이 없다.
 *
 * `dx === dy === 0` 은 즉시 원본이다. 임계를 0 **초과**로 두면 안 된다: 고배율에서 0.5 oriented
 * px 는 화면 수 px 라 진짜 드래그를 먹는다(`pointer.ts` 의 move 가드와 같은 판정).
 */
export function moveVerts(o: PathNode, refs: readonly VertRef[], dx: number, dy: number): PathNode {
  if (dx === 0 && dy === 0) return o;
  // NaN 이 한 번 들어가면 그 정점은 렌더·bbox·스냅에서 통째로 사라지고 파일에도 그대로 저장된다.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return o;
  return editVerts(o, groupRefs(o, refs), (v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
}

/**
 * 핸들 노브 드래그. `to` 는 **절대 좌표**(핸들은 상대로 저장되므로 여기서 앵커를 뺀다).
 *
 * 반대편 규칙: `mirrored` → −v, `asymmetric` → 방향만 −v̂ 이고 길이 유지, `corner` → 불변.
 * `opts.alt` 는 Figma 의 "break" — 반대편을 그대로 두고 모드를 corner 로 끊는다.
 *
 * `auto` 정점을 잡으면 그 자리에서 굳혀 `mirrored` 로 승격한다. 굳히지 않고 모드만 바꾸면
 * 반대편이 문서값 (0,0) 이라, 손대지도 않은 쪽에서 곡선이 툭 꺾인다.
 */
export function moveHandle(
  o: PathNode,
  ref: VertRef,
  side: "in" | "out",
  to: { x: number; y: number },
  opts: { alt: boolean },
): PathNode {
  if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return o;
  return editVerts(o, groupRefs(o, [ref]), (v, sub, i) => {
    const base = v.mode === "auto" ? autoVertAt(sub, i) : v;
    const dragX = to.x - v.x;
    const dragY = to.y - v.y;
    const rule: PathVert["mode"] = opts.alt ? "corner" : v.mode === "auto" ? "mirrored" : v.mode;

    let inX = side === "in" ? dragX : base.inX;
    let inY = side === "in" ? dragY : base.inY;
    let outX = side === "out" ? dragX : base.outX;
    let outY = side === "out" ? dragY : base.outY;
    if (rule === "mirrored") {
      if (side === "out") [inX, inY] = [-outX, -outY];
      else [outX, outY] = [-inX, -inY];
    } else if (rule === "asymmetric") {
      if (side === "out") [inX, inY] = opposite(outX, outY, Math.hypot(inX, inY));
      else [outX, outY] = opposite(inX, inY, Math.hypot(outX, outY));
    }

    // 잡은 핸들을 앵커 위로 끌어다 놓으면 그 핸들은 사라진 것이다 → 코너. `rule` 이 corner 면
    // 기하가 우연히 대칭이 되어도 corner 로 남긴다(끊어 둔 정점이 저절로 다시 붙으면 안 된다).
    const mode: PathVert["mode"] =
      rule === "corner" || !hasHandle(inX, inY) || !hasHandle(outX, outY) ? "corner" : rule;
    if (v.inX === inX && v.inY === inY && v.outX === outX && v.outY === outY && v.mode === mode) return v;
    return { ...v, inX, inY, outX, outY, mode };
  });
}

// ── 구조 ────────────────────────────────────────────────────────────────────

/**
 * 세그먼트 `seg` 의 `t` 지점에 정점 하나 삽입. 46 `splitCubic`(de Casteljau) 이 곡선 모양을
 * 보존하고 양 이웃의 모드를 다시 계산한다 — 여기서는 서브패스만 갈아 끼우고 새 정점 주소를 돌려준다.
 *
 * 삽입할 수 없으면(범위 밖 서브패스·세그먼트, 정점 2개 미만, t 가 NaN) **null**. 원본과
 * `{obj:o}` 를 섞어 돌려주지 않는 이유: 실패 통로가 둘이면 호출자가 하나를 빠뜨린다.
 */
export function insertVert(
  o: PathNode,
  sub: number,
  seg: number,
  t: number,
): { obj: PathNode; ref: VertRef } | null {
  const cur = o.subpaths[sub];
  // splitCubic 의 클램프(`t<0?0:t>1?1:t`)는 NaN 을 통과시킨다 → 좌표 전체가 NaN 이 된다.
  if (!cur || !Number.isFinite(t)) return null;
  const next = splitCubic(cur, seg, t);
  if (next === cur) return null;
  const subpaths = o.subpaths.slice();
  subpaths[sub] = next;
  // splitCubic 은 언제나 `splice(seg+1, 0, mid)` 다. 닫힘 마지막 구간이면 `(seg+1)%n === 0` 이라
  // 끝 정점 B 는 배열 **앞쪽**이지만 삽입 위치는 배열 끝(= seg+1)이라 이 식이 그대로 맞는다.
  return { obj: { ...o, subpaths }, ref: { sub, vert: seg + 1 } };
}

/**
 * 선택 정점 삭제. 남은 정점이 2개 미만인 서브패스는 통째로 버리고(정점 1개는 그릴 것도 편집할
 * 것도 없는 잔해다), 서브패스가 전부 없어지면 **null** — 호출자가 객체 삭제를 커밋한다.
 *
 * 닫힘/열림 구분 없이 같은 규칙이다: 닫힌 2정점 서브패스는 앞뒤로 겹치는 두 곡선이라 렌즈 모양을
 * 만들 수 있어 살려 둔다. 이웃 핸들은 **손대지 않는다** — 다시 맞추면(재피팅) 사용자가 정한
 * 곡률이 삭제 한 번에 사라진다.
 */
export function deleteVerts(o: PathNode, refs: readonly VertRef[]): PathNode | null {
  const groups = groupRefs(o, refs);
  if (groups.size === 0) return o;
  const subpaths: SubPath[] = [];
  for (let si = 0; si < o.subpaths.length; si++) {
    const sub = o.subpaths[si];
    const idx = groups.get(si);
    if (!idx) {
      subpaths.push(sub);
      continue;
    }
    const verts = sub.verts.filter((_, i) => !idx.has(i));
    if (verts.length < 2) continue;
    subpaths.push({ verts, closed: sub.closed });
  }
  if (subpaths.length === 0) return null;
  return { ...o, subpaths };
}

/**
 * 서브패스 닫기/열기.
 *
 * 정점 2개 미만은 **닫지 않는다** — 46 `segCount` 가 0 을 돌려줘 아무것도 그려지지 않는 채
 * "닫힘" 이라고만 적힌 서브패스가 남는다.
 *
 * `verts` 배열은 참조째 물려준다: 좌표가 하나도 안 바뀌었으니 46 의 평탄화 캐시를 날릴 이유가
 * 없다(`normalizeAuto` 는 캐시 항목의 `closed` 를 따로 확인한다).
 */
export function setClosed(o: PathNode, sub: number, closed: boolean): PathNode {
  const cur = o.subpaths[sub];
  if (!cur || cur.closed === closed) return o;
  if (closed && cur.verts.length < 2) return o;
  const subpaths = o.subpaths.slice();
  subpaths[sub] = { verts: cur.verts, closed };
  return { ...o, subpaths };
}

/**
 * 서브패스 방향 반전 — 정점 순서를 뒤집고 각 정점의 in/out 을 맞바꾼다(그래야 곡선 모양이
 * 그대로다). 모드는 그대로 유지된다: 대칭/비대칭/자동은 in↔out 교환에 대해 그 성질이 보존된다.
 *
 * 열림/닫힘 차이:
 * - **열린** 서브패스는 통째로 뒤집는다 — 시작점과 끝점이 맞바뀌는 것이 이 연산의 목적이다.
 * - **닫힌** 서브패스는 첫 정점을 제자리에 두고 나머지만 뒤집는다. 링은 어디서 시작해도 같은
 *   모양이라 통째로 뒤집어도 그림은 같지만, 시작 인덱스가 밀리면 호출자가 들고 있던 정점
 *   선택이 통째로 다른 정점을 가리킨다.
 *
 * `heads`(화살촉)는 **건드리지 않는다**: `NodeBase` 에 있어 노드 단위라, 서브패스가 여럿이면
 * 어느 쪽 화살촉을 옮길지 정의되지 않는다.
 * ponytail: 화살촉까지 뒤집으려면 "열린 서브패스 1개짜리 노드" 로 좁혀 호출자가 heads 를 교환하라.
 */
export function reverseSub(o: PathNode, sub: number): PathNode {
  const cur = o.subpaths[sub];
  if (!cur || cur.verts.length < 2) return o;
  const swap = (v: PathVert): PathVert => ({
    ...v,
    inX: v.outX,
    inY: v.outY,
    outX: v.inX,
    outY: v.inY,
  });
  const verts = cur.closed
    ? [swap(cur.verts[0]), ...cur.verts.slice(1).reverse().map(swap)]
    : cur.verts.slice().reverse().map(swap);
  // 값이 하나도 안 바뀌었으면 **입력 그대로**(머리말 ①). 닫힌 **2정점** 서브패스가 그렇다:
  // 첫 정점을 제자리에 두므로 순서가 `[0,1]` 그대로이고, 두 정점의 in/out 이 서로 같으면
  // swap 도 값을 바꾸지 않는다. 그대로 새 객체를 돌려주면 `applyNodeOp` 의 `next === o`
  // 가드를 통과해 `방향 반전`을 누를 때마다 화면은 그대로인 채 히스토리에 빈 칸만 쌓이고,
  // 그 칸에서 Ctrl+Z 는 아무 일도 하지 않는다(정점 배열이 갈려 46 평탄화 캐시도 날아간다).
  if (sameVerts(cur.verts, verts)) return o;
  const subpaths = o.subpaths.slice();
  subpaths[sub] = { verts, closed: cur.closed };
  return { ...o, subpaths };
}
