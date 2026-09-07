// 평탄 DFS 트리 연산 — `objects: Node[]` 를 트리로 읽고 쓰는 **유일한** 곳.
//
// 표현: DFS 전순 평탄 배열 + `parentId`. 자손은 컨테이너 **바로 뒤에 연속**으로 오고, 뒤가 위(z)다.
// 그래서 서브트리는 배열 슬라이스 `[start, end)` 하나이고, 이동·삭제·그룹은 splice 두 번으로 끝난다.
// `objects.length`(e2e 계약)·참조비교 캐시·히스토리 배열 공유·렌더의 선형 루프가 전부 그대로 산다.
//
// **이 파일 밖에서 `objects` 를 직접 splice 하지 마라**(DOCS/task/00-INDEX.md §10.4). 불변식이
// 깨지면 순서·부모가 조용히 어긋나고, 그 결과는 "가끔 그룹이 흩어진다"로만 보인다.
// DEV 에서는 `assertTreeInvariant` 가 커밋마다 검사한다.
//
// 배경: DOCS/task/38-image-tree-scene-geometry.md §3.1·§3.4

import {
  isGeomNode,
  normalizeDeg,
  objectAABB,
  objectAnchor,
  rotatePoint,
  translateObject,
} from "./geometry";
import {
  newObjId,
  type GeomNode,
  type Node,
  type NodeKind,
  type ObjId,
  type Rect,
} from "./types";

/** 자식을 가질 수 있는 노드인가. */
export function isContainer(n: Node): boolean {
  return n.kind === "group" || n.kind === "frame" || n.kind === "instance";
}

// ── 조회 ────────────────────────────────────────────────────────────────────

/**
 * id → 인덱스. 배열 참조마다 한 번만 맵을 만들어 O(1) 로 답한다.
 *
 * 커밋마다 새 배열이 오므로(불변 갱신 규약) 맵은 자연히 무효화된다. WeakMap 이라
 * 히스토리에 남은 옛 배열이 살아 있는 동안만 유지된다.
 */
const indexCache = new WeakMap<readonly Node[], Map<ObjId, number>>();

function indexMap(objects: readonly Node[]): Map<ObjId, number> {
  let m = indexCache.get(objects);
  if (!m) {
    m = new Map();
    for (let i = 0; i < objects.length; i++) m.set(objects[i].id, i);
    indexCache.set(objects, m);
  }
  return m;
}

export function indexOf(objects: readonly Node[], id: ObjId): number {
  const i = indexMap(objects).get(id);
  return i === undefined ? -1 : i;
}

export function nodeOf(objects: readonly Node[], id: ObjId): Node | null {
  const i = indexOf(objects, id);
  return i < 0 ? null : objects[i];
}

export function parentOf(objects: readonly Node[], id: ObjId): ObjId | null {
  return nodeOf(objects, id)?.parentId ?? null;
}

/** 가까운 조상부터 루트 방향으로. */
export function ancestorsOf(objects: readonly Node[], id: ObjId): ObjId[] {
  const out: ObjId[] = [];
  let cur = parentOf(objects, id);
  // 사슬이 망가진 문서(순환)에서도 멈추도록 길이 상한을 둔다.
  for (let guard = 0; cur && guard <= objects.length; guard++) {
    out.push(cur);
    cur = parentOf(objects, cur);
  }
  return out;
}

/** 최상위 조상(자기 자신이 최상위면 자기). 클릭 = 그룹 선택의 단위다(38 §3.3). */
export function topLevelAncestor(objects: readonly Node[], id: ObjId): ObjId {
  const chain = ancestorsOf(objects, id);
  return chain.length ? chain[chain.length - 1] : id;
}

/** 직계 자식 id 를 문서 순서대로. `parent` 가 null 이면 최상위 노드들. */
export function childrenOf(objects: readonly Node[], parent: ObjId | null): ObjId[] {
  const out: ObjId[] = [];
  for (const o of objects) if (o.parentId === parent) out.push(o.id);
  return out;
}

/**
 * 서브트리 슬라이스 `[start, endExclusive)` — 자기 자신을 포함한다.
 *
 * 자손이 컨테이너 바로 뒤에 연속이라는 불변식 덕에 앞에서 뒤로 한 번만 훑으면 끝난다.
 */
export function subtreeRange(objects: readonly Node[], id: ObjId): [number, number] {
  const start = indexOf(objects, id);
  if (start < 0) return [0, 0];
  const inside = new Set<ObjId>([id]);
  let end = start + 1;
  while (end < objects.length) {
    const p = objects[end].parentId;
    if (!p || !inside.has(p)) break;
    inside.add(objects[end].id);
    end++;
  }
  return [start, end];
}

/** 서브트리의 노드 id 전부(자기 포함). */
export function subtreeIds(objects: readonly Node[], id: ObjId): ObjId[] {
  const [s, e] = subtreeRange(objects, id);
  const out: ObjId[] = [];
  for (let i = s; i < e; i++) out.push(objects[i].id);
  return out;
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 노드의 축정렬 경계(oriented px).
 *
 * 컨테이너는 기하가 없다 — 자손 리프의 `objectAABB` 합집합으로 **파생**한다. 그래서 그룹이
 * 있어도 리프의 AABB·모자이크 샘플 영역·형광펜 스크래치가 부풀지 않는다(38 §1).
 * 프레임은 자기 rect 를 갖되, 내용을 자르지 않으면 넘치는 자손까지 포함한다.
 */
export function nodeAABB(objects: readonly Node[], id: ObjId): Rect {
  const [s, e] = subtreeRange(objects, id);
  if (s >= e) return { x: 0, y: 0, w: 0, h: 0 };
  const self = objects[s];
  if (isGeomNode(self) && self.kind !== "frame") return objectAABB(self);

  let box: Rect | null = null;
  if (self.kind === "frame") {
    box = objectAABB(self);
    if (self.clipsContent) return box;
  }
  for (let i = s + 1; i < e; i++) {
    const n = objects[i];
    if (isGeomNode(n)) box = unionRect(box, objectAABB(n));
  }
  return box ?? { x: 0, y: 0, w: 0, h: 0 };
}

// ── 재배열 ──────────────────────────────────────────────────────────────────

/** 서브트리를 통째로 들어낸 조각과 나머지. */
function extract(objects: readonly Node[], ids: readonly ObjId[]): { rest: Node[]; slices: Node[][] } {
  // 선택 안에 조상·자손이 같이 있으면 조상만 남긴다(서브트리가 두 번 움직이지 않게).
  const set = new Set(ids);
  const roots = ids.filter((id) => !ancestorsOf(objects, id).some((a) => set.has(a)));
  const ranges = roots
    .map((id) => subtreeRange(objects, id))
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const slices: Node[][] = ranges.map(([s, e]) => objects.slice(s, e));
  const drop = new Set<number>();
  for (const [s, e] of ranges) for (let i = s; i < e; i++) drop.add(i);
  const rest = objects.filter((_, i) => !drop.has(i));
  return { rest, slices };
}

/**
 * 형제 사이에서 z 순서를 바꾼다. 자손 슬라이스가 함께 움직인다.
 * `dir` 은 1(앞으로) · −1(뒤로) · 'front' · 'back'(시안 ⑧ `맨 앞으로 ⌥⌘]`).
 */
export function reorder(
  objects: readonly Node[],
  ids: readonly ObjId[],
  dir: 1 | -1 | "front" | "back",
): Node[] {
  if (!ids.length) return objects as Node[];
  const set = new Set(ids);
  // 부모가 같은 것끼리만 움직인다 — 다른 부모의 형제 열은 서로 간섭하지 않는다.
  const byParent = new Map<ObjId | null, ObjId[]>();
  for (const id of ids) {
    const n = nodeOf(objects, id);
    if (!n) continue;
    // 조상이 함께 선택돼 있으면 조상만 움직인다.
    if (ancestorsOf(objects, id).some((a) => set.has(a))) continue;
    const key = n.parentId;
    const arr = byParent.get(key);
    if (arr) arr.push(id);
    else byParent.set(key, [id]);
  }
  let out = objects as Node[];
  for (const [parent, group] of byParent) {
    const siblings = childrenOf(out, parent);
    const moving = new Set(group);
    const staying = siblings.filter((id) => !moving.has(id));
    const ordered = siblings.filter((id) => moving.has(id));
    let next: ObjId[];
    if (dir === "front") next = [...staying, ...ordered];
    else if (dir === "back") next = [...ordered, ...staying];
    else {
      next = [...siblings];
      const idxs = ordered.map((id) => next.indexOf(id));
      // 앞으로 보낼 때는 뒤에서부터, 뒤로 보낼 때는 앞에서부터 옮겨야 서로 밀치지 않는다.
      const order = dir === 1 ? idxs.slice().sort((a, b) => b - a) : idxs.slice().sort((a, b) => a - b);
      for (const i of order) {
        const j = i + dir;
        if (j < 0 || j >= next.length || moving.has(next[j])) continue;
        const t = next[i];
        next[i] = next[j];
        next[j] = t;
      }
    }
    out = reorderSiblings(out, next);
  }
  return out;
}

/** 형제 순서를 주어진 순서로 다시 깐다(각자의 서브트리를 달고). */
function reorderSiblings(objects: readonly Node[], order: readonly ObjId[]): Node[] {
  const ranges = order.map((id) => subtreeRange(objects, id));
  if (!ranges.length) return objects as Node[];
  const start = Math.min(...ranges.map(([s]) => s));
  const end = Math.max(...ranges.map(([, e]) => e));
  const slices = order.map((id) => {
    const [s, e] = subtreeRange(objects, id);
    return objects.slice(s, e);
  });
  return [...objects.slice(0, start), ...slices.flat(), ...objects.slice(end)];
}

/**
 * 부모를 바꾼다. `index` 는 새 부모의 자식들 사이 삽입 위치.
 * 자기 자신·자손을 새 부모로 삼으면 트리가 순환하므로 **throw** 한다.
 */
export function reparent(
  objects: readonly Node[],
  ids: readonly ObjId[],
  newParent: ObjId | null,
  index: number,
): Node[] {
  if (!ids.length) return objects as Node[];
  if (newParent !== null) {
    const target = nodeOf(objects, newParent);
    if (!target) throw new Error(`reparent: 부모 ${newParent} 가 없다`);
    if (!isContainer(target)) throw new Error(`reparent: ${target.kind} 은 자식을 담을 수 없다`);
    for (const id of ids) {
      if (id === newParent || subtreeIds(objects, id).includes(newParent)) {
        throw new Error("reparent: 자기 자손 안으로는 넣을 수 없다(순환)");
      }
    }
  }
  const { rest, slices } = extract(objects, ids);
  const moved = slices.flat().map((n, _i, all) => {
    // 슬라이스의 루트만 새 부모를 받는다. 자손의 parentId 는 그대로다.
    const isRoot = !all.some((x) => x.id === n.parentId);
    return isRoot ? { ...n, parentId: newParent } : n;
  });
  const siblings = childrenOf(rest, newParent);
  const at = Math.max(0, Math.min(index, siblings.length));
  let insertAt: number;
  if (siblings.length === 0) {
    // 빈 컨테이너 — 바로 뒤에 넣는다. 최상위면 맨 뒤.
    insertAt = newParent === null ? rest.length : indexOf(rest, newParent) + 1;
  } else if (at >= siblings.length) {
    const [, e] = subtreeRange(rest, siblings[siblings.length - 1]);
    insertAt = e;
  } else {
    insertAt = indexOf(rest, siblings[at]);
  }
  return [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
}

/** 컨테이너의 공통 필드 기본값 — schema.normalizeNode 와 같은 값이어야 한다. */
function blankContainer(id: ObjId, parentId: ObjId | null) {
  return {
    id,
    parentId,
    name: null,
    visible: true,
    locked: false,
    opacity: 1,
    // 컨테이너 기본은 패스스루 — 격리 합성을 만들지 않는다(39가 blend≠pass-through 일 때만 격리).
    blend: "pass-through" as const,
    rot: 0,
    fills: [],
    strokes: [],
    strokeWidth: 0,
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

/**
 * 선택을 컨테이너로 묶는다(시안 ⑧ `그룹 ⌘G` · `프레임으로 ⌥⌘G`).
 * 컨테이너는 선택의 공통 부모 아래, **가장 위 항목 자리**에 들어간다.
 */
export function group(
  objects: readonly Node[],
  ids: readonly ObjId[],
  kind: "group" | "frame",
): { objects: Node[]; id: ObjId } {
  const set = new Set(ids);
  const roots = ids.filter((id) => !ancestorsOf(objects, id).some((a) => set.has(a)));
  if (!roots.length) return { objects: objects as Node[], id: "" };
  // 공통 부모 — 다르면 최상위로 올린다(Figma 도 같은 규칙).
  const parents = new Set(roots.map((id) => parentOf(objects, id)));
  const parent = parents.size === 1 ? [...parents][0] : null;
  const box = roots.reduce<Rect | null>((acc, id) => unionRect(acc, nodeAABB(objects, id)), null) ?? {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
  const id = newObjId();
  const base = {
    ...blankContainer(id, parent),
    name: null,
  };
  const container: Node =
    kind === "frame"
      ? { ...base, kind: "frame", x: box.x, y: box.y, w: box.w, h: box.h, radius: [0, 0, 0, 0], clipsContent: true }
      : { ...base, kind: "group" };

  const { rest, slices } = extract(objects, roots);
  const children = slices.flat().map((n) => {
    const isRoot = roots.includes(n.id);
    return isRoot ? { ...n, parentId: id } : n;
  });
  // 가장 위 항목(문서 순서상 마지막 루트) 자리에 컨테이너를 놓는다.
  const anchorIdx = Math.max(
    ...roots.map((r) => objects.findIndex((o) => o.id === r)),
  );
  const before = objects.slice(0, anchorIdx).filter((o) => rest.some((r) => r.id === o.id));
  const insertAt = before.length;
  return {
    objects: [...rest.slice(0, insertAt), container, ...children, ...rest.slice(insertAt)],
    id,
  };
}

/** 컨테이너를 없애고 자식을 그 자리에 편다. */
export function ungroup(objects: readonly Node[], id: ObjId): Node[] {
  const i = indexOf(objects, id);
  if (i < 0) return objects as Node[];
  const self = objects[i];
  if (!isContainer(self)) return objects as Node[];
  const [s, e] = subtreeRange(objects, id);
  const inner = objects.slice(s + 1, e).map((n) => (n.parentId === id ? { ...n, parentId: self.parentId } : n));
  return [...objects.slice(0, s), ...inner, ...objects.slice(e)];
}

/** 서브트리째 삭제. */
export function remove(objects: readonly Node[], ids: readonly ObjId[]): Node[] {
  if (!ids.length) return objects as Node[];
  const { rest } = extract(objects, ids);
  return rest;
}

// ── 마스크 ──────────────────────────────────────────────────────────────────

/**
 * 선택을 그룹으로 감싸고 **가장 아래** 노드를 마스크로 세운다(시안 ⑧ `마스크로 사용 ^⌘M`).
 * Figma 규칙 그대로 — 마스크는 같은 부모의 뒤 형제 전부를 가린다.
 */
export function makeMask(objects: readonly Node[], ids: readonly ObjId[]): { objects: Node[]; maskId: ObjId } {
  const g = group(objects, ids, "group");
  if (!g.id) return { objects: g.objects, maskId: "" };
  const children = childrenOf(g.objects, g.id);
  if (!children.length) return { objects: g.objects, maskId: "" };
  const maskId = children[0]; // 문서 순서상 첫 자식 = 가장 아래(z)
  return {
    objects: g.objects.map((n) => (n.id === maskId ? { ...n, mask: { mode: "shape", invert: false } } : n)),
    maskId,
  };
}

/** 마스크 지정을 해제한다(그룹은 남긴다). */
export function releaseMask(objects: readonly Node[], maskId: ObjId): Node[] {
  return objects.map((n) => (n.id === maskId ? { ...n, mask: null } : n));
}

/**
 * 마스크가 가리는 범위 `[start, endExclusive)` — 같은 부모의 **뒤 형제 전부**.
 * 마스크 자신은 범위에 없다(자신은 클립 모양으로만 쓰인다).
 */
export function maskScope(objects: readonly Node[], maskId: ObjId): [number, number] {
  const i = indexOf(objects, maskId);
  if (i < 0) return [0, 0];
  const [, selfEnd] = subtreeRange(objects, maskId);
  const parent = objects[i].parentId;
  const end = parent === null ? objects.length : subtreeRange(objects, parent)[1];
  return [selfEnd, Math.max(selfEnd, end)];
}

// ── 기하 연산(서브트리 단위) ────────────────────────────────────────────────

/** 선택(과 그 자손)을 평행이동. 현행 다중 이동과 같은 수학이다. */
export function translateSubtree(
  objects: readonly Node[],
  ids: readonly ObjId[],
  dx: number,
  dy: number,
): Node[] {
  if (!ids.length || (dx === 0 && dy === 0)) return objects as Node[];
  const moving = new Set<ObjId>();
  for (const id of ids) for (const sub of subtreeIds(objects, id)) moving.add(sub);
  return objects.map((n) => (moving.has(n.id) && isGeomNode(n) ? translateObject(n, dx, dy) : n));
}

/**
 * 선택(과 자손)을 `center` 기준으로 `deg` 만큼 돌린다. **회전은 리프 기하에 굽는다** —
 * 그룹은 각도를 갖지 않는다(INDEX §10.5).
 *
 * 리프 규칙(48 §3.2 해석): 축정렬 도형(rect·ellipse·mosaic)과 앵커 하나짜리(text·badge)는
 * 앵커를 회전 이동시키고 `rot` 을 누적한다. 정점이 여럿인 것(pen·highlight·line·arrow·path)은
 * 정점을 직접 돌려 회전을 기하에 흡수시킨다.
 */
export function rotateNodes(
  objects: readonly Node[],
  ids: readonly ObjId[],
  deg: number,
  center: { x: number; y: number },
): Node[] {
  if (!ids.length || normalizeDeg(deg) === 0) return objects as Node[];
  const moving = new Set<ObjId>();
  for (const id of ids) for (const sub of subtreeIds(objects, id)) moving.add(sub);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const R = (x: number, y: number) => {
    const dx = x - center.x;
    const dy = y - center.y;
    return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
  };
  return objects.map((n): Node => {
    if (!moving.has(n.id) || !isGeomNode(n)) return n;
    switch (n.kind) {
      case "pen":
      case "highlight": {
        const pts = n.pts.slice();
        for (let i = 0; i + 1 < pts.length; i += 2) {
          const q = R(pts[i], pts[i + 1]);
          pts[i] = q.x;
          pts[i + 1] = q.y;
        }
        return { ...n, pts };
      }
      case "line":
      case "arrow": {
        const a = R(n.x1, n.y1);
        const b = R(n.x2, n.y2);
        return { ...n, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      }
      case "path": {
        const rot = (dx: number, dy: number) => ({ x: dx * cos - dy * sin, y: dx * sin + dy * cos });
        return {
          ...n,
          subpaths: n.subpaths.map((sub) => ({
            closed: sub.closed,
            verts: sub.verts.map((v) => {
              const q = R(v.x, v.y);
              const i = rot(v.inX, v.inY);
              const t = rot(v.outX, v.outY);
              return { ...v, x: q.x, y: q.y, inX: i.x, inY: i.y, outX: t.x, outY: t.y };
            }),
          })),
        };
      }
      default: {
        // 축정렬 도형·앵커형 — 앵커를 옮기고 각도를 누적한다.
        const a = objectAnchor(n);
        const q = R(a.x, a.y);
        const moved = translateObject(n, q.x - a.x, q.y - a.y);
        return { ...moved, rot: normalizeDeg(moved.rot + deg) };
      }
    }
  });
}

// ── 진단 ────────────────────────────────────────────────────────────────────

export function countByKind(objects: readonly Node[]): Record<NodeKind, number> {
  const out = {} as Record<NodeKind, number>;
  for (const o of objects) out[o.kind] = (out[o.kind] ?? 0) + 1;
  return out;
}

/**
 * 트리 불변식 검사(DEV 전용 — `applyDoc` 뒤에 부른다).
 *
 * ① `parentId` 는 자기보다 **앞**에 있는 컨테이너를 가리킨다
 * ② 자손은 컨테이너 바로 뒤에 **연속**이다
 * ③ `pass-through` 블렌드는 컨테이너에만
 * ④ id 중복 없음
 */
export function assertTreeInvariant(objects: readonly Node[]): void {
  const seen = new Map<ObjId, number>();
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (seen.has(o.id)) throw new Error(`tree: id 중복 ${o.id} (${seen.get(o.id)}, ${i})`);
    seen.set(o.id, i);
    if (o.parentId !== null) {
      const pi = seen.get(o.parentId);
      if (pi === undefined) throw new Error(`tree: ${o.id} 의 부모 ${o.parentId} 가 앞에 없다`);
      if (!isContainer(objects[pi])) {
        throw new Error(`tree: ${o.parentId} 는 ${objects[pi].kind} 라 자식을 담을 수 없다`);
      }
    }
    if (o.blend === "pass-through" && !isContainer(o)) {
      throw new Error(`tree: ${o.kind} ${o.id} 에 pass-through 블렌드`);
    }
  }
  // ② 연속성 — 각 컨테이너의 자식 수가 슬라이스 안의 직계 자식 수와 같아야 한다.
  for (const o of objects) {
    if (!isContainer(o)) continue;
    const [s, e] = subtreeRange(objects, o.id);
    let direct = 0;
    for (let i = s + 1; i < e; i++) if (objects[i].parentId === o.id) direct++;
    const all = childrenOf(objects, o.id).length;
    if (direct !== all) {
      throw new Error(`tree: ${o.id} 의 자손이 흩어져 있다(슬라이스 ${direct} vs 전체 ${all})`);
    }
  }
}

/** 씬·히트가 쓰는 편의 — 문서 순서대로 기하 노드만. */
export function geomNodes(objects: readonly Node[]): GeomNode[] {
  return objects.filter(isGeomNode);
}

/** 회전 헬퍼를 다시 내보낸다(48 크롭·직선화가 같은 함수를 쓴다). */
export { rotatePoint };
