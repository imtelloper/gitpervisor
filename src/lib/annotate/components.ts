// 컴포넌트 마스터 ↔ 인스턴스 — 라이브러리의 정의를 문서 안 **실제 노드**로 물질화하고,
// 커밋마다 그 사본이 마스터에서 얼마나 벗어났는지(재정의)를 되짚는다.
//
// **인스턴스는 평탄 배열 안의 슬라이스다.** `InstanceNode` 바로 뒤에 프레임 자식이 오고 그 뒤로
// 자손이 연속한다(38 §3.1 불변식). 이 파일이 배열을 만들 때 그 순서를 어기면 트리 연산 전체
// (`subtreeRange`·`reorder`·`group`)가 조용히 엉뚱한 슬라이스를 집는다 — DEV 의
// `assertTreeInvariant` 가 커밋에서 터뜨려 주지만, 여기서 안 깨는 것이 먼저다.
//
// **위치·크기·회전은 인스턴스가 아니라 첫 자식 프레임이 든다**(51 §3.4). 그래서 이동·리사이즈·
// 회전·제약 재배치·히트·마퀴·AABB 가 38 의 프레임 처리를 그대로 타고, 이 파일에는 기하 코드가
// 한 줄도 없다. `InstanceNode` 에 x/y/rot 을 두는 순간 `translateSubtree`·`rotateNodes`·
// `transformObjects`·`straightenObjects` 네 곳이 그 필드를 따로 갱신해야 한다(51 §3.4 대안 C).
//
// 자식 id 는 `${instanceId}/${masterChildId}` 다 — 재정의를 마스터 자식과 짝지을 유일한 끈이다.
// 접두를 잃으면 "이 자식이 마스터의 어느 노드였나"를 되찾을 방법이 없어 재정의가 통째로 증발한다.
//
// **순수 함수만** 둔다(스토어·React import 0). 이 파일은 커밋 경로에서 도는데, 여기서 문서 밖
// 상태를 읽으면 같은 문서가 창마다 다른 결과로 커밋돼 히스토리 결정론이 깨진다(00-INDEX §10.4).
//
// 배경: DOCS/task/51-image-styles-components.md §3.4~§3.6

import { applyConstraints, isGeomNode, normalizeDeg } from "./geometry";
import {
  ancestorsOf,
  childrenOf,
  group,
  indexOf,
  nodeOf,
  reparent,
  rotateNodes,
  subtreeRange,
  translateSubtree,
} from "./tree";
import {
  newObjId,
  type ComponentDef,
  type EditorDoc,
  type FrameNode,
  type GroupNode,
  type ImageLibrary,
  type InstanceNode,
  type InstanceOverride,
  type Node,
  type ObjId,
  type Rect,
} from "./types";

type Rec = Record<string, unknown>;

/**
 * 재정의로 **삼지 않는** 키.
 *
 * 기하(x·y·w·h·rot·pts·x1..y2·subpaths)를 뺀 이유는 성능이 아니라 병합이다 — 자식 위치·크기
 * 재정의를 허용하면 마스터의 구조가 바뀔 때마다 "마스터 원본 · 이전 마스터 기준의 재정의 ·
 * 현재 인스턴스"를 3-way 로 합쳐야 한다(51 §3.5). 자식 기하를 정말 바꾸고 싶으면 분리한다.
 *
 * 구조 키(id·parentId·kind·componentId·overrides·detachedFrom)와 컨테이너 계약 키
 * (mask·constraints·exportRows·locked)는 애초에 값이 아니라 트리의 뼈대라 재정의 대상이 아니다.
 */
export const INSTANCE_FIXED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "parentId",
  "kind",
  "x",
  "y",
  "w",
  "h",
  "rot",
  "pts",
  "x1",
  "y1",
  "x2",
  "y2",
  "subpaths",
  "componentId",
  "overrides",
  "detachedFrom",
  "mask",
  "constraints",
  "exportRows",
  "locked",
]);

/** 인스턴스 자식 id. 이 한 줄이 재정의 ↔ 마스터 자식의 대응 규칙 전부다. */
function childId(instId: ObjId, masterId: ObjId): ObjId {
  return `${instId}/${masterId}`;
}

/**
 * 키 순서를 타지 않는 깊은 비교.
 *
 * `JSON.stringify` 비교 대신인 이유: 사이드카에서 다시 읽어 온 문서(정규화가 만든 키 순서)와
 * 방금 물질화한 서브트리(마스터 노드의 키 순서)는 값이 같아도 문자열이 다를 수 있다. 그 차이가
 * "바뀌었다"로 읽히면 라이브러리가 흔들릴 때마다 **내용이 같은** '컴포넌트 갱신' 커밋이 쌓여
 * 히스토리 200칸(41)을 갉아먹고, `objects` 참조가 매번 새로 나 렌더 캐시도 통째로 무효화된다.
 */
function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as Rec);
  const kb = Object.keys(b as Rec);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEq((a as Rec)[k], (b as Rec)[k])) return false;
  }
  return true;
}

function findDef(lib: ImageLibrary, id: string): ComponentDef | null {
  return lib.components.find((c) => c.id === id) ?? null;
}

function rectOf(f: FrameNode): Rect {
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

/** `nodes[0]` 계약(0,0,w,h·rot 0 프레임) 검사. 여기가 깨지면 재물질화가 기준 rect 를 잃는다. */
function defRootFrame(def: ComponentDef): FrameNode {
  const root = def.nodes[0];
  if (!root || root.kind !== "frame") {
    throw new Error(`컴포넌트 '${def.name}': nodes[0] 이 루트 프레임이 아니다`);
  }
  return root;
}

/** 인스턴스 노드 한 개 — 기하 필드는 **일부러** 빼고 프레임 자식에게 넘긴다(머리말). */
function makeInstance(
  root: FrameNode,
  instId: ObjId,
  parentId: ObjId | null,
  def: ComponentDef,
): InstanceNode {
  const { x, y, w, h, radius, clipsContent, kind, ...base } = root;
  return {
    ...base,
    kind: "instance",
    id: instId,
    parentId,
    name: def.name,
    rot: 0,
    componentId: def.id,
    overrides: {},
  };
}

/**
 * 썸네일 생성은 39 렌더(캔버스)에 기댄다 — 캔버스가 없는 곳에서 던져도 컴포넌트 생성 자체는
 * 성공해야 한다. 실패하면 빈 문자열이고 카드는 이름만 그린다(51 §6).
 */
function safeThumb(thumb: (nodes: Node[]) => string, nodes: Node[]): string {
  try {
    return thumb(nodes);
  } catch {
    return "";
  }
}

// ── 조회 ────────────────────────────────────────────────────────────────────

/** ⑤ `연결됨 · 재정의됨 · 분리됨` 배지의 판정. 인스턴스도 분리 그룹도 아니면 null. */
export function instanceState(node: Node): "linked" | "overridden" | "detached" | null {
  if (node.kind === "instance") {
    return Object.keys(node.overrides).length ? "overridden" : "linked";
  }
  if (node.kind === "group" && node.detachedFrom) return "detached";
  return null;
}

/** 문서 전체 집계(⑤ 하단 3칩). */
export function instanceCounts(objects: readonly Node[]): {
  linked: number;
  overridden: number;
  detached: number;
} {
  const out = { linked: 0, overridden: 0, detached: 0 };
  for (const n of objects) {
    const st = instanceState(n);
    if (st) out[st] += 1;
  }
  return out;
}

function firstFrame(objects: readonly Node[], instId: ObjId): FrameNode | null {
  const [s, e] = subtreeRange(objects, instId);
  for (let i = s + 1; i < e; i++) {
    const n = objects[i];
    // 첫 직계 자식만 본다 — 프레임이 아니면 서브트리가 이미 망가진 것이라 뒤를 뒤져 봐야
    // "어느 프레임이 기하를 드는가"가 두 개가 된다.
    if (n.parentId === instId) return n.kind === "frame" ? n : null;
  }
  return null;
}

/** 인스턴스의 기하를 드는 첫 자식 프레임. 없으면 불변식이 깨진 것이라 **throw** 한다. */
export function instanceFrame(objects: readonly Node[], instId: ObjId): FrameNode {
  const f = firstFrame(objects, instId);
  if (!f) throw new Error(`instanceFrame: 인스턴스 ${instId} 에 프레임 자식이 없다`);
  return f;
}

/**
 * 드래그·nudge 가 실제로 움직여야 할 id.
 *
 * 더블클릭으로 인스턴스 안 자식에 들어간 상태에서 그 자식을 끌면 **인스턴스 전체**가 따라온다
 * (Figma 관습). 자식만 옮기면 위치 재정의가 되는데, 51 §3.5 가 기하 재정의를 받지 않기로 했으니
 * 그 이동은 다음 커밋의 재물질화에서 소리 없이 되돌아간다 — 사용자에겐 "드래그가 씹혔다"로 보인다.
 */
export function moveUnit(objects: readonly Node[], id: ObjId): ObjId {
  for (const a of ancestorsOf(objects, id)) {
    if (nodeOf(objects, a)?.kind === "instance") return a;
  }
  return id;
}

// ── 물질화 ──────────────────────────────────────────────────────────────────

/**
 * 마스터 정의 + 현재 프레임 기하 + 재정의 → 인스턴스 서브트리(`[프레임, …자손]`).
 *
 * 순수 함수다 — 같은 입력이면 항상 같은 서브트리라, 호출부가 결과를 현재 서브트리와 비교해
 * **같으면 커밋하지 않을** 수 있다(51 §3.6). 그 비교가 라이브러리 변경마다 쌓이는 빈 커밋을 막는다.
 *
 * 순서가 중요하다: 제약 재배치(로컬 → 세계) → 회전 → 재정의. 회전을 먼저 걸면 `applyConstraints`
 * 가 축정렬 rect 를 기준으로 삼는 전제가 깨지고, 재정의를 먼저 얹으면 제약 계산이 사용자가
 * 바꾼 값(예: 글꼴 크기)을 마스터 값으로 되돌린다.
 */
export function applyOverrides(
  def: ComponentDef,
  frame: FrameNode,
  instId: ObjId,
  overrides: Record<ObjId, InstanceOverride>,
): Node[] {
  const root = defRootFrame(def);
  const base: Rect = { x: 0, y: 0, w: def.w, h: def.h };
  const target: Rect = rectOf(frame);

  // 자손은 자기 부모 프레임의 (옛 rect → 새 rect) 로 재배치한다. 기하 없는 컨테이너(group)는
  // 부모 기준을 그대로 물려준다 — 그래야 중첩 프레임 안의 제약이 바깥 프레임 기준으로
  // 두 번 늘어나지 않는다.
  const refs = new Map<ObjId, { old: Rect; next: Rect }>([[root.id, { old: base, next: target }]]);
  const placed: Node[] = [{ ...root, x: target.x, y: target.y, w: target.w, h: target.h, rot: 0 }];
  for (let i = 1; i < def.nodes.length; i++) {
    const m = def.nodes[i];
    const ref = refs.get(m.parentId ?? root.id) ?? { old: base, next: target };
    const p = isGeomNode(m) ? applyConstraints(m, ref.old, ref.next) : m;
    refs.set(m.id, p.kind === "frame" && m.kind === "frame" ? { old: rectOf(m), next: rectOf(p) } : ref);
    placed.push(p);
  }

  let sub: Node[] = placed.map((n, i) => ({
    ...n,
    id: childId(instId, n.id),
    parentId: i === 0 || n.parentId === null ? instId : childId(instId, n.parentId),
  }));

  // 프레임 중심 회전. 프레임의 회전 피벗(`objectAnchor`)이 곧 중심이라 프레임 자신의 rect 는
  // 그대로 있고 `rot` 만 누적된다 — 그래서 회전한 인스턴스도 세계 rect 하나로 계속 설명된다.
  if (normalizeDeg(frame.rot) !== 0) {
    sub = rotateNodes(sub, [sub[0].id], frame.rot, {
      x: target.x + target.w / 2,
      y: target.y + target.h / 2,
    });
  }

  return sub.map((n) => {
    const o = overrides[n.id];
    return o ? ({ ...n, ...o } as Node) : n;
  });
}

/**
 * 캔버스에 사본 하나를 놓는다. `at` 은 프레임의 **중심**이다(카드 드롭 좌표·이미지 중심 둘 다).
 *
 * 물질화를 `applyOverrides` 와 **같은 경로**로 한다. 여기서 따로 좌표를 계산하면 방금 놓은
 * 인스턴스가 다음 `resolveInstances` 에서 "다르다"로 판정돼 배치 직후 '컴포넌트 갱신' 커밋이
 * 한 칸 더 쌓인다(부동소수 끝자리만 달라도 그렇다).
 */
export function instantiate(def: ComponentDef, at: { x: number; y: number }): Node[] {
  const root = defRootFrame(def);
  const instId = newObjId();
  const frame: FrameNode = {
    ...root,
    x: at.x - def.w / 2,
    y: at.y - def.h / 2,
    w: def.w,
    h: def.h,
    rot: 0,
  };
  return [makeInstance(root, instId, null, def), ...applyOverrides(def, frame, instId, {})];
}

/**
 * 선택을 컴포넌트로 만든다 — 합집합 rect 프레임에 감싸 마스터로 떠내고, 그 자리를 인스턴스로
 * 바꾼다(기하는 그대로).
 *
 * 선택에 인스턴스가 있으면 **throw** 한다. 중첩 인스턴스를 만들지 않기로 했으므로(51 §3.10)
 * 순환 검사 자체가 필요 없어지는 대신, 그 전제를 여기서 지켜야 한다.
 */
export function makeComponent(
  objects: readonly Node[],
  ids: readonly ObjId[],
  name: string,
  thumb: (nodes: Node[]) => string,
): { objects: Node[]; def: ComponentDef; instanceId: ObjId } {
  for (const id of ids) {
    if (moveUnit(objects, id) !== id) {
      throw new Error("인스턴스 안의 노드는 컴포넌트로 만들 수 없습니다 — 먼저 분리하세요");
    }
    const [s, e] = subtreeRange(objects, id);
    for (let i = s; i < e; i++) {
      if (objects[i].kind === "instance") {
        throw new Error("선택에 인스턴스가 있습니다 — 먼저 분리하세요");
      }
    }
  }

  const g = group(objects, ids, "frame");
  if (!g.id) throw new Error("컴포넌트로 만들 노드가 없습니다");
  const [fs, fe] = subtreeRange(g.objects, g.id);
  const frame = g.objects[fs] as FrameNode;

  // 마스터는 프레임 원점 좌표계다. 껍데기 프레임은 **그리지 않는다** — 클립을 켜 두면
  // 인스턴스를 놓는 곳마다 선 두께·그림자가 프레임 변에서 잘린다.
  const local = translateSubtree(g.objects.slice(fs, fe), [g.id], -frame.x, -frame.y);
  const root: FrameNode = {
    ...(local[0] as FrameNode),
    x: 0,
    y: 0,
    rot: 0,
    parentId: null,
    fills: [],
    strokes: [],
    clipsContent: false,
  };
  const nodes: Node[] = [root, ...local.slice(1)];
  const def: ComponentDef = {
    id: newObjId(),
    name,
    nodes,
    w: frame.w,
    h: frame.h,
    thumb: safeThumb(thumb, nodes),
    updatedAt: Date.now(),
  };

  const instanceId = newObjId();
  const sub = applyOverrides(def, frame, instanceId, {});
  return {
    objects: [
      ...g.objects.slice(0, fs),
      makeInstance(root, instanceId, frame.parentId, def),
      ...sub,
      ...g.objects.slice(fe),
    ],
    def,
    instanceId,
  };
}

// ── 커밋 시 파생 ────────────────────────────────────────────────────────────

function deriveOverrides(
  objects: readonly Node[],
  inst: InstanceNode,
  def: ComponentDef,
): Record<ObjId, InstanceOverride> {
  const out: Record<ObjId, InstanceOverride> = {};
  for (const m of def.nodes) {
    const cid = childId(inst.id, m.id);
    const actual = nodeOf(objects, cid);
    if (!actual) {
      // Figma 규칙: 인스턴스 안에서 지운 자식은 사라지는 게 아니라 숨는다. 그래야 42 의 Delete
      // 경로를 건드리지 않고도 '재정의 초기화'로 되살아난다(51 §3.5).
      out[cid] = { visible: false };
      continue;
    }
    const patch: Rec = {};
    // 키를 정렬해 담는다 — 사이드카 JSON 이 커밋마다 키 순서로만 흔들리면 41 의 diff 가 매번
    // 바뀐 것처럼 보인다.
    for (const k of Object.keys(actual).sort()) {
      if (INSTANCE_FIXED_KEYS.has(k)) continue;
      const v = (actual as unknown as Rec)[k];
      if (v === undefined) continue;
      if (!deepEq(v, (m as unknown as Rec)[k])) patch[k] = v;
    }
    if (Object.keys(patch).length) out[cid] = patch as InstanceOverride;
  }
  return out;
}

/**
 * 커밋 직전에 인스턴스 상태를 문서에서 **되짚는다**(51 §3.5).
 *
 * 자식을 만지는 경로(캔버스·인스펙터·팝오버·키보드)마다 `setOverride` 훅을 심는 대신, 커밋
 * 한 곳에서 diff 를 뜬다 — 새 편집 경로가 생겨도 재정의는 저절로 따라온다.
 *
 * 인스턴스가 없으면 **같은 참조**를 돌려준다. 변경이 없을 때 새 문서를 만들면 인스턴스를 쓰지
 * 않는 문서까지 커밋마다 배열이 갈리고, `AnnotationLayer` 의 참조비교 렌더 캐시가 전부 빗나간다.
 */
export function diffInstance(doc: EditorDoc, lib: ImageLibrary): EditorDoc {
  const ids = doc.objects.filter((n) => n.kind === "instance").map((n) => n.id);
  if (!ids.length) return doc;

  let objects: Node[] = doc.objects;
  let changed = false;

  // ① 떠돌이 노드 — 그리기·붙여넣기가 인스턴스 안에 남긴 것을 인스턴스 **바로 뒤 형제**로 뺀다.
  //    "인스턴스 서브트리 ⊆ 마스터 id" 가 커밋마다 회복돼야 재물질화가 남의 노드를 지우지 않는다.
  for (const instId of ids) {
    const inst = nodeOf(objects, instId);
    if (!inst || inst.kind !== "instance") continue;
    const def = findDef(lib, inst.componentId);
    if (!def) continue;
    const known = new Set(def.nodes.map((m) => childId(instId, m.id)));
    const [s, e] = subtreeRange(objects, instId);
    const strays: ObjId[] = [];
    for (let i = s + 1; i < e; i++) if (!known.has(objects[i].id)) strays.push(objects[i].id);
    if (!strays.length) continue;
    const at = childrenOf(objects, inst.parentId).indexOf(instId) + 1;
    objects = reparent(objects, strays, inst.parentId, at);
    changed = true;
  }

  // ② 재정의 — 마스터 자식과 실제 자식의 값 차이. 기하 차이는 INSTANCE_FIXED_KEYS 가 거른다.
  const patched = new Map<ObjId, Record<ObjId, InstanceOverride>>();
  for (const instId of ids) {
    const inst = nodeOf(objects, instId);
    if (!inst || inst.kind !== "instance") continue;
    const def = findDef(lib, inst.componentId);
    if (!def) continue;
    const next = deriveOverrides(objects, inst, def);
    if (!deepEq(next, inst.overrides)) patched.set(instId, next);
  }
  if (patched.size) {
    objects = objects.map((n) => {
      const ov = patched.get(n.id);
      return ov ? { ...(n as InstanceNode), overrides: ov } : n;
    });
    changed = true;
  }

  return changed ? { ...doc, objects } : doc;
}

// ── 라이브러리 → 문서 재동기 ────────────────────────────────────────────────

/**
 * 라이브러리가 바뀌었을 때 문서의 인스턴스를 맞춘다(마스터 갱신 전파·사라진 마스터 분리).
 *
 * **`diffInstance` 뒤에 돈다**는 전제가 있다: 서브트리를 마스터에서 다시 만들어 통째로 갈아
 * 끼우므로, 아직 빠져나가지 못한 떠돌이 노드가 인스턴스 안에 있으면 그 노드가 사라진다.
 * 배선 순서(커밋 파생 → 라이브러리 effect)를 바꾸지 마라(51 §4 ImageEditor 배선).
 */
export function resolveInstances(
  doc: EditorDoc,
  lib: ImageLibrary,
): { doc: EditorDoc; detached: { name: string; count: number }[] } {
  const ids = doc.objects.filter((n) => n.kind === "instance").map((n) => n.id);
  if (!ids.length) return { doc, detached: [] };

  let objects: Node[] = doc.objects;
  let changed = false;
  const detached = new Map<string, number>();

  for (const instId of ids) {
    const inst = nodeOf(objects, instId);
    if (!inst || inst.kind !== "instance") continue;
    const def = findDef(lib, inst.componentId);
    const frame = firstFrame(objects, instId);
    if (!def || !frame) {
      // 마스터가 지워졌거나(라이브러리에서 삭제) 프레임이 없어 기하를 잃은 인스턴스. 값은
      // 이미 노드에 있으므로 분리만 하면 화면은 그대로다 — 링크만 끊긴다.
      const label = def?.name ?? inst.name ?? inst.componentId;
      objects = detachInstance(objects, instId);
      detached.set(label, (detached.get(label) ?? 0) + 1);
      changed = true;
      continue;
    }
    const [s, e] = subtreeRange(objects, instId);
    const next = applyOverrides(def, frame, instId, inst.overrides);
    if (deepEq(objects.slice(s + 1, e), next)) continue;
    objects = [...objects.slice(0, s + 1), ...next, ...objects.slice(e)];
    changed = true;
  }

  if (!changed) return { doc, detached: [] };
  return {
    doc: { ...doc, objects },
    detached: [...detached].map(([name, count]) => ({ name, count })),
  };
}

/** '재정의 초기화' — 마스터 값으로 되돌린다. 바뀔 게 없으면 같은 문서를 돌려준다. */
export function resetOverrides(doc: EditorDoc, lib: ImageLibrary, instId: ObjId): EditorDoc {
  const objects = doc.objects;
  const inst = nodeOf(objects, instId);
  if (!inst || inst.kind !== "instance") return doc;
  const def = findDef(lib, inst.componentId);
  const frame = firstFrame(objects, instId);
  if (!def || !frame) return doc;
  const [s, e] = subtreeRange(objects, instId);
  const next = applyOverrides(def, frame, instId, {});
  if (!Object.keys(inst.overrides).length && deepEq(objects.slice(s + 1, e), next)) return doc;
  return {
    ...doc,
    objects: [...objects.slice(0, s), { ...inst, overrides: {} }, ...next, ...objects.slice(e)],
  };
}

/**
 * '이 인스턴스로 마스터 갱신' — 인스턴스 서브트리를 마스터 좌표계(원점·무회전)로 되돌려 def 로
 * 굳히고, 이 인스턴스의 재정의를 비운다.
 *
 * 자식 id 의 **접두만 벗긴다**(새 id 를 발급하지 않는다). 마스터 자식 id 가 바뀌면 다른
 * 인스턴스의 재정의 키(`${그쪽 인스턴스}/${옛 마스터 id}`)가 전부 미아가 돼, "마스터를 갱신했더니
 * 남의 인스턴스 재정의가 날아갔다"가 된다(e2e 38 (g) 가 그 회귀를 잡는다).
 */
export function pushToMaster(
  doc: EditorDoc,
  instId: ObjId,
  def: ComponentDef,
  thumb: (nodes: Node[]) => string,
): { doc: EditorDoc; def: ComponentDef } {
  const objects = doc.objects;
  const inst = nodeOf(objects, instId);
  if (!inst || inst.kind !== "instance") return { doc, def };
  const frame = firstFrame(objects, instId);
  if (!frame) return { doc, def };

  const [s, e] = subtreeRange(objects, instId);
  let sub: Node[] = objects.slice(s + 1, e);
  if (normalizeDeg(frame.rot) !== 0) {
    sub = rotateNodes(sub, [frame.id], -frame.rot, {
      x: frame.x + frame.w / 2,
      y: frame.y + frame.h / 2,
    });
  }
  sub = translateSubtree(sub, [frame.id], -frame.x, -frame.y);

  const prefix = `${instId}/`;
  const strip = (id: ObjId) => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
  const nodes: Node[] = sub.map((n, i) => ({
    ...n,
    id: strip(n.id),
    parentId: i === 0 || n.parentId === null ? null : strip(n.parentId),
  }));
  const root = nodes[0];
  if (root.kind !== "frame") return { doc, def };
  // 회전·평행이동을 되돌린 결과가 곧 (0,0,rot 0) 이지만, 부동소수 찌꺼기가 남으면 다음
  // 재물질화가 인스턴스를 통째로 한 픽셀 밀어 놓는다.
  nodes[0] = { ...root, x: 0, y: 0, rot: 0 };

  return {
    doc: {
      ...doc,
      objects: objects.map((n) => (n.id === instId ? { ...(n as InstanceNode), overrides: {} } : n)),
    },
    def: {
      ...def,
      nodes,
      w: frame.w,
      h: frame.h,
      thumb: safeThumb(thumb, nodes) || def.thumb,
      updatedAt: Date.now(),
    },
  };
}

// ── 분리 ────────────────────────────────────────────────────────────────────

/**
 * 인스턴스 → 보통 그룹. 값은 이미 노드에 있으므로 화면은 그대로고 링크만 끊긴다.
 *
 * 자식 id 를 새 uuid 로 바꾼다: 접두가 남아 있으면 같은 마스터를 다시 놓았을 때 id 가 부딪히고,
 * 무엇보다 "분리했는데 마스터를 고치면 따라 바뀐다"는 유령이 생긴다.
 */
export function detachInstance(objects: readonly Node[], instId: ObjId): Node[] {
  const s = indexOf(objects, instId);
  if (s < 0) return objects as Node[];
  const inst = objects[s];
  if (inst.kind !== "instance") return objects as Node[];
  const [, e] = subtreeRange(objects, instId);

  const { componentId, overrides, kind, ...base } = inst;
  const grp: GroupNode = { ...base, kind: "group", detachedFrom: componentId };

  const idMap = new Map<ObjId, ObjId>();
  for (let i = s + 1; i < e; i++) idMap.set(objects[i].id, newObjId());
  const kids = objects.slice(s + 1, e).map((n) => ({
    ...n,
    id: idMap.get(n.id) ?? n.id,
    parentId: n.parentId !== null ? (idMap.get(n.parentId) ?? n.parentId) : null,
  }));
  return [...objects.slice(0, s), grp, ...kids, ...objects.slice(e)];
}

/**
 * 이미지 90° 회전·반전(`rotateBy`/`flipBy`) 훅.
 *
 * R-ROT 의 축정렬 사각형 표현은 미러·180° 정보를 잃어(38 `transformObjects`) 프레임이 인스턴스의
 * 방향을 더 이상 들 수 없다 — 링크를 유지하면 다음 재물질화가 방향을 잘못 복원한다. 그래서 값을
 * 그대로 둔 채 링크만 끊고, 호출부가 토스트로 알린다(undo 한 칸이면 복귀).
 */
export function detachAllInstances(objects: readonly Node[]): { objects: Node[]; count: number } {
  const ids = objects.filter((n) => n.kind === "instance").map((n) => n.id);
  if (!ids.length) return { objects: objects as Node[], count: 0 };
  let out = objects as Node[];
  for (const id of ids) out = detachInstance(out, id);
  return { objects: out, count: ids.length };
}
