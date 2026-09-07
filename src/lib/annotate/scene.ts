// 문서 → 씬 해석 — 숨김·잠금·마스크·컨테이너를 **한 곳에서** 푼다.
//
// 프리뷰 캐시·저장 출력·히트테스트·마퀴·선택 상자가 전부 같은 `Scene` 을 소비한다. 그래서
// "보이는 것 ≠ 저장된 것" 이 구조적으로 생길 수 없다 — 숨긴 노드는 `nodes` 에 아예 없고,
// 세 소비자가 각자 `if (!o.visible)` 를 넣을 자리가 없다(DOCS/pro-image-editor-design.md §8.2 가
// 레이어 패널을 기각한 바로 그 이유를 여기서 없앤다).
//
// 잠금은 다르다 — 렌더는 그대로 하고 **히트만** 막는다. 그래서 `flags` 로 따로 나른다.
//
// 배경: DOCS/task/38-image-tree-scene-geometry.md §3.2

import { isGeomNode } from "./geometry";
import { isContainer, maskScope, subtreeRange } from "./tree";
import type {
  BlendMode,
  EditorDoc,
  Effect,
  GeomNode,
  Node,
  ObjId,
  Rect,
} from "./types";

/** 마스크 노드가 가리는 범위 — `range` 는 **씬 노드 배열**의 인덱스다(문서 인덱스가 아니다). */
export interface MaskScope {
  maskId: ObjId;
  range: [number, number];
  mode: "shape" | "alpha";
  invert: boolean;
}

/** 격리 합성이 필요한 컨테이너 한 개. `range` 는 씬 노드 배열의 인덱스 구간이다. */
export interface SceneContainer {
  id: ObjId;
  range: [number, number];
  opacity: number;
  blend: BlendMode;
  effects: Effect[];
  /** 프레임이 내용을 자를 때의 사각형. 없으면 null. */
  clip: Rect | null;
  mask: MaskScope | null;
}

export interface Scene {
  /** 그릴 노드 — 숨김(자기 또는 조상) 제외, 문서 순서(뒤가 위). */
  nodes: GeomNode[];
  /** 자기 또는 조상이 잠겼는가. 히트테스트만 본다. */
  flags: Map<ObjId, { locked: boolean }>;
  /** 노드 → 담고 있는 컨테이너(없으면 null). 클릭 단위 승격에 쓴다. */
  owner: Map<ObjId, ObjId | null>;
  containers: SceneContainer[];
  imageMask: EditorDoc["imageMask"];
}

/**
 * 단일 슬롯 캐시.
 *
 * WeakMap 이면 히스토리 200벌(태스크 41)이 각자 Scene 을 붙들어 메모리가 200배가 된다.
 * 키는 `doc.objects` 참조다 — 조정 슬라이더는 objects 를 바꾸지 않으므로 그 틱에는 히트한다.
 */
let cacheKey: readonly Node[] | null = null;
let cacheMask: EditorDoc["imageMask"] = null;
let cached: Scene | null = null;

export function resolveScene(doc: EditorDoc): Scene {
  if (cached && cacheKey === doc.objects && cacheMask === doc.imageMask) return cached;
  const scene = buildScene(doc);
  cacheKey = doc.objects;
  cacheMask = doc.imageMask;
  cached = scene;
  return scene;
}

/** 테스트·창 종료에서 캐시를 비운다(문서가 살아 있는 동안 잡고 있을 이유가 없다). */
export function releaseScene(): void {
  cacheKey = null;
  cacheMask = null;
  cached = null;
}

function buildScene(doc: EditorDoc): Scene {
  const objects = doc.objects;
  const hidden = new Set<ObjId>();
  const locked = new Set<ObjId>();
  const owner = new Map<ObjId, ObjId | null>();

  // 조상 상태 전파 — DFS 전순이라 부모가 항상 먼저 나온다(38 §3.1 불변식 ①).
  for (const o of objects) {
    const p = o.parentId;
    const parentHidden = p !== null && hidden.has(p);
    const parentLocked = p !== null && locked.has(p);
    if (!o.visible || parentHidden) hidden.add(o.id);
    if (o.locked || parentLocked) locked.add(o.id);
    owner.set(o.id, p);
  }

  const nodes: GeomNode[] = [];
  const sceneIndex = new Map<ObjId, number>();
  for (const o of objects) {
    if (hidden.has(o.id) || !isGeomNode(o)) continue;
    sceneIndex.set(o.id, nodes.length);
    nodes.push(o);
  }

  const flags = new Map<ObjId, { locked: boolean }>();
  for (const o of objects) flags.set(o.id, { locked: locked.has(o.id) });

  // 컨테이너 — 격리 합성이 필요한 것만 담는다(태스크 39 가 이 목록만큼 레이어를 만든다).
  const containers: SceneContainer[] = [];
  for (const o of objects) {
    if (!isContainer(o) || hidden.has(o.id)) continue;
    const range = sceneRangeOf(objects, o.id, sceneIndex, nodes.length);
    if (!range) continue;
    const clip = o.kind === "frame" && o.clipsContent ? { x: o.x, y: o.y, w: o.w, h: o.h } : null;
    const mask = maskOf(objects, o.id, sceneIndex, nodes.length);
    const needsLayer =
      o.opacity < 1 ||
      (o.blend !== "pass-through" && o.blend !== "normal") ||
      o.effects.some((e) => e.visible) ||
      clip !== null ||
      mask !== null;
    if (!needsLayer) continue;
    containers.push({
      id: o.id,
      range,
      opacity: o.opacity,
      blend: o.blend,
      effects: o.effects.filter((e) => e.visible),
      clip,
      mask,
    });
  }

  return { nodes, flags, owner, containers, imageMask: doc.imageMask };
}

/** 문서 서브트리를 씬 노드 인덱스 구간으로 옮긴다(숨김이 빠져 있으므로 다시 센다). */
function sceneRangeOf(
  objects: readonly Node[],
  id: ObjId,
  sceneIndex: Map<ObjId, number>,
  total: number,
): [number, number] | null {
  const [s, e] = subtreeRange(objects, id);
  let start = -1;
  let end = -1;
  for (let i = s; i < e; i++) {
    const at = sceneIndex.get(objects[i].id);
    if (at === undefined) continue;
    if (start < 0) start = at;
    end = at + 1;
  }
  if (start < 0) return null;
  return [start, Math.min(end, total)];
}

/** 컨테이너 안에 마스크 노드가 있으면 그 범위를 씬 인덱스로. */
function maskOf(
  objects: readonly Node[],
  containerId: ObjId,
  sceneIndex: Map<ObjId, number>,
  total: number,
): MaskScope | null {
  const [s, e] = subtreeRange(objects, containerId);
  for (let i = s + 1; i < e; i++) {
    const n = objects[i];
    if (n.parentId !== containerId || !n.mask) continue;
    const [ms, me] = maskScope(objects, n.id);
    let start = -1;
    let end = -1;
    for (let j = ms; j < me; j++) {
      const at = sceneIndex.get(objects[j].id);
      if (at === undefined) continue;
      if (start < 0) start = at;
      end = at + 1;
    }
    if (start < 0) return null;
    return {
      maskId: n.id,
      range: [start, Math.min(end, total)],
      mode: n.mask.mode,
      invert: n.mask.invert,
    };
  }
  return null;
}

/**
 * 아직 문서에 없는 노드(드래그 드래프트·라이브 미리보기)를 감싸는 임시 씬.
 * 컨테이너·마스크가 없으므로 렌더는 문서 순서대로 그리기만 한다 — 그래야 라이브와 커밋본이
 * **같은 렌더 진입**을 지난다(INDEX §10.4 "렌더 진입은 renderScene 하나").
 */
export function sceneOfNodes(nodes: readonly GeomNode[]): Scene {
  return {
    nodes: [...nodes],
    flags: new Map(),
    owner: new Map(nodes.map((n) => [n.id, null])),
    containers: [],
    imageMask: null,
  };
}

/** 씬에서 노드 하나를 찾는다(없으면 null — 숨김이면 씬에 없다). */
export function sceneNode(scene: Scene, id: ObjId): GeomNode | null {
  for (const n of scene.nodes) if (n.id === id) return n;
  return null;
}
