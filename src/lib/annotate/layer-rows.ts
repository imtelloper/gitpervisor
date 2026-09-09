// 레이어 패널이 그리는 행 목록 — 문서(37)와 씬(38) 위에 얹는 **파생 뷰** 하나.
//
// 문서는 DFS 전순 평탄 배열이고 **뒤가 위(z)** 다. 레이어 패널은 반대로 **위가 앞**이라
// 형제를 역순으로 훑는다. 이 방향을 한 번 헷갈리면 드래그가 z 를 뒤집어 "위로 올렸는데
// 뒤로 간다"가 된다 — 방향 변환은 이 파일 두 곳(`flattenLayers` 의 역순 루프,
// `dropTarget` 의 index 식)에만 있고 다른 곳은 문서 순서 그대로 산다.
//
// 접기·검색·필터는 문서에 넣지 않는다(패널 로컬 state). 넣으면 undo 한 칸이 "그룹을 접었다"에
// 소모되고 사이드카(41)에 UI 상태가 실린다.
//
// 순수 함수만 둔다 — DOM·React 0. 배경: DOCS/task/44-image-panels.md §3.1·§3.2·§3.5

import type { Scene } from "./scene";
import { ancestorsOf, isContainer, nodeOf } from "./tree";
import type {
  BlendMode,
  EditorDoc,
  InstanceNode,
  Node,
  NodeBase,
  NodeKind,
  ObjId,
} from "./types";

/** 행 아이콘·타입 필터가 쓰는 분류 7종(시안 ④ `타입 · 프레임 · 그룹 · 도형 · 텍스트 · 이미지 · 벡터 · 컴포넌트`). */
export type LayerType = "frame" | "group" | "shape" | "text" | "image" | "vector" | "component";

/** 이름 오른쪽 칩. `instance.state` 가 null 이면 51 이전이라 상태를 모른다는 뜻이다. */
export type LayerBadge =
  | { kind: "mask" }
  | { kind: "blend"; label: string }
  | { kind: "nodeEdit" }
  | { kind: "instance"; state: InstanceBadgeState | null };

/** 51 `instanceState` 반환값과 **같은 철자** — 두 곳이 갈리면 필터가 조용히 0행이 된다. */
export type InstanceBadgeState = "linked" | "overridden" | "detached";

export interface LayerRow {
  /** 노드 id 또는 이미지 배경 의사 id `'__base'`(42 스토어의 단독 선택 규칙과 짝). */
  id: ObjId | "__base";
  depth: number;
  /** 배경 행만 null. */
  node: Node | null;
  name: string;
  type: LayerType;
  hasChildren: boolean;
  collapsed: boolean;
  /** 자기 또는 조상이 `visible:false` — 행을 흐리게 그리는 용도. */
  hidden: boolean;
  /** 38 `scene.flags` 의 **효과적** 잠금(조상 잠금 포함). */
  locked: boolean;
  badges: LayerBadge[];
}

export interface LayerFilter {
  types: ReadonlySet<LayerType>;
  hiddenOnly: boolean;
  lockedOnly: boolean;
  overriddenOnly: boolean;
  includeMasks: boolean;
}

const ALL_TYPES: readonly LayerType[] = [
  "frame",
  "group",
  "shape",
  "text",
  "image",
  "vector",
  "component",
];

/** 팝오버 `초기화` 가 되돌리는 값. 타입 7종 on · 상태 3종 off · 마스크 포함. */
export const DEFAULT_LAYER_FILTER: LayerFilter = {
  types: new Set(ALL_TYPES),
  hiddenOnly: false,
  lockedOnly: false,
  overriddenOnly: false,
  includeMasks: true,
};

/** 이미지 배경 행 id — 42 스토어의 `'__base'` 와 같은 문자열이어야 한다. */
const BASE_ID = "__base";

// ── 이름 ────────────────────────────────────────────────────────────────────

const KIND_NAME: Record<NodeKind, string> = {
  rect: "사각형",
  ellipse: "타원",
  line: "직선",
  arrow: "화살표",
  pen: "펜",
  highlight: "형광펜",
  mosaic: "모자이크",
  path: "벡터",
  frame: "프레임",
  group: "그룹",
  instance: "인스턴스",
  badge: "번호 뱃지",
  text: "텍스트",
};

/**
 * kind 별 등장 순번(1-based). 배열 참조마다 한 번만 세고 캐시한다 — 이름이 행마다 필요한데
 * 매번 `filter().indexOf()` 를 돌리면 200행 문서가 O(N²) 다.
 *
 * 커밋마다 새 배열이 오므로(불변 갱신 규약) 캐시는 자연히 무효화된다.
 */
const ordinalCache = new WeakMap<readonly Node[], Map<ObjId, number>>();

function ordinals(objects: readonly Node[]): Map<ObjId, number> {
  let m = ordinalCache.get(objects);
  if (!m) {
    m = new Map();
    const seen = new Map<NodeKind, number>();
    for (const o of objects) {
      const n = (seen.get(o.kind) ?? 0) + 1;
      seen.set(o.kind, n);
      m.set(o.id, n);
    }
    ordinalCache.set(objects, m);
  }
  return m;
}

/**
 * `name:null` 인 노드의 표시 이름(시안 ① `사각형 3 · 번호 뱃지 #3 · 텍스트 "…"`).
 *
 * **이 규칙의 유일한 자리다** — 41 `describeChange` 의 히스토리 라벨도 여기를 부른다. 두 곳에
 * 두면 패널에는 `모자이크 2`, 히스토리에는 `가림 영역 이동` 이 떠서 같은 객체가 달리 불린다.
 *
 * 번호는 문서 순서에서 세므로 앞 객체를 지우면 뒤 번호가 당겨진다(Figma 동일). 문서에는
 * `name:null` 만 저장되니 파일에 남는 영향은 없고, 히스토리 라벨은 커밋 시점 문자열이라 불변이다.
 */
export function defaultLayerName(node: Node, objects: readonly Node[]): string {
  const n = ordinals(objects).get(node.id) ?? 1;
  if (node.kind === "badge") return `번호 뱃지 #${node.n}`;
  if (node.kind === "text") {
    const line = node.text.replace(/\s+/g, " ").trim().slice(0, 20);
    return line ? `텍스트 "${line}"` : `텍스트 ${n}`;
  }
  return `${KIND_NAME[node.kind]} ${n}`;
}

// ── 타입·뱃지 ───────────────────────────────────────────────────────────────

/**
 * 행 분류. **컨테이너 종류가 먼저다** — 이미지 페인트를 깐 프레임은 여전히 프레임이다.
 * 리프에서만 이미지 페인트가 kind 를 이긴다(이 앱에는 image 노드 종류가 없어, 사진을 담은
 * 사각형이 '이미지' 로 보여야 시안 ④ 의 `이미지` 필터가 아무것도 못 걸러내는 일이 없다).
 */
export function layerTypeOf(node: Node): LayerType {
  switch (node.kind) {
    case "frame":
      return "frame";
    case "group":
      return "group";
    case "instance":
      return "component";
    default:
      break;
  }
  if (node.fills.some((f) => f.type === "image")) return "image";
  if (node.kind === "text") return "text";
  if (node.kind === "path") return "vector";
  return "shape";
}

/** 뱃지 문구(시안 ① `[패스스루]`). 컨테이너 기본값 `pass-through` 도 뱃지로 보인다. */
const BLEND_LABEL: Record<BlendMode, string> = {
  "pass-through": "패스스루",
  normal: "표준",
  darken: "어둡게",
  multiply: "곱하기",
  "linear-burn": "선형 번",
  "color-burn": "컬러 번",
  lighten: "밝게",
  screen: "스크린",
  "linear-dodge": "선형 닷지",
  "color-dodge": "컬러 닷지",
  overlay: "오버레이",
  "soft-light": "소프트 라이트",
  "hard-light": "하드 라이트",
  difference: "차이",
  exclusion: "제외",
  hue: "색조",
  saturation: "채도",
  color: "색상",
  luminosity: "광도",
};

interface FlattenCtx {
  /** 배경 행에 붙일 파일명(시안 `배경 — 대시보드.png`). */
  baseName: string;
  nodeEditId: ObjId | null;
  /** 51 이 붙인다. 없으면 상태를 모르는 채 `인스턴스` 뱃지만 단다. */
  instanceState?: (n: InstanceNode) => InstanceBadgeState;
}

function badgesOf(n: Node, ctx: FlattenCtx): LayerBadge[] {
  const out: LayerBadge[] = [];
  if (n.mask) out.push({ kind: "mask" });
  if (n.blend !== "normal") out.push({ kind: "blend", label: BLEND_LABEL[n.blend] });
  if (ctx.nodeEditId !== null && ctx.nodeEditId === n.id) out.push({ kind: "nodeEdit" });
  if (n.kind === "instance") {
    out.push({ kind: "instance", state: ctx.instanceState?.(n) ?? null });
  }
  return out;
}

// ── 평탄화 ──────────────────────────────────────────────────────────────────

/**
 * 문서 트리를 패널 표시 순서의 행 배열로. 접힌 컨테이너의 자손은 행에서 빠진다.
 *
 * 맨 아래 한 행은 이미지 배경(`'__base'`)이다 — 주석은 전부 이미지 위에 있으므로 배경보다
 * 아래에 놓일 행은 없다. `dropTarget` 이 배경 아래를 거절하는 근거이기도 하다.
 */
export function flattenLayers(
  doc: EditorDoc,
  scene: Scene,
  collapsed: ReadonlySet<ObjId>,
  ctx: FlattenCtx,
): LayerRow[] {
  const objects = doc.objects;
  // 부모 → 자식. `childrenOf` 를 컨테이너마다 부르면 O(N × 컨테이너) 라 한 번만 훑는다.
  const kids = new Map<ObjId | null, Node[]>();
  for (const n of objects) {
    const arr = kids.get(n.parentId);
    if (arr) arr.push(n);
    else kids.set(n.parentId, [n]);
  }

  const rows: LayerRow[] = [];
  const walk = (parent: ObjId | null, depth: number, parentHidden: boolean): void => {
    const list = kids.get(parent);
    if (!list) return;
    // 문서는 뒤가 위 — 패널은 위가 앞이라 형제를 뒤에서 앞으로 훑는다.
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      const hidden = parentHidden || !n.visible;
      // 인스턴스는 자식이 물질화돼 있어도 펼치지 않는다(Figma 동일) — 행으로 새면 안쪽
      // 노드가 개별 선택·이동돼 마스터와의 대응이 조용히 어긋난다. 안쪽 편집은 51 재정의 경로다.
      const expandable =
        isContainer(n) && n.kind !== "instance" && (kids.get(n.id)?.length ?? 0) > 0;
      const isCollapsed = expandable && collapsed.has(n.id);
      rows.push({
        id: n.id,
        depth,
        node: n,
        name: n.name ?? defaultLayerName(n, objects),
        type: layerTypeOf(n),
        hasChildren: expandable,
        collapsed: isCollapsed,
        hidden,
        locked: scene.flags.get(n.id)?.locked ?? false,
        badges: badgesOf(n, ctx),
      });
      if (expandable && !isCollapsed) walk(n.id, depth + 1, hidden);
    }
  };
  walk(null, 0, false);

  rows.push({
    id: BASE_ID,
    depth: 0,
    node: null,
    name: `배경 — ${ctx.baseName}`,
    type: "image",
    hasChildren: false,
    collapsed: false,
    hidden: false,
    // 배경은 문서 노드가 아니라 옮기거나 숨길 수 없다 — 행은 잠금으로 고정해 그 사실을 보인다.
    locked: true,
    badges: [],
  });
  return rows;
}

// ── 검색·필터 ───────────────────────────────────────────────────────────────

function matches(row: LayerRow, query: string, f: LayerFilter): boolean {
  if (query && !row.name.toLowerCase().includes(query)) return false;
  if (!f.types.has(row.type)) return false;
  if (f.hiddenOnly && !row.hidden) return false;
  if (f.lockedOnly && !row.locked) return false;
  if (f.overriddenOnly && !row.badges.some((b) => b.kind === "instance" && b.state === "overridden")) {
    return false;
  }
  if (!f.includeMasks && row.node?.mask) return false;
  return true;
}

/**
 * 매치된 행 **+ 그 조상**만 남긴다(문서는 건드리지 않는 뷰 — 다시 열면 초기화된다).
 *
 * 조상을 빼면 검색 결과가 트리 구조 없이 떠 있어 그 노드가 어느 그룹 안인지 알 수 없다.
 * 행 배열은 컨테이너가 자손보다 **앞**에 오는 DFS 라 뒤에서 앞으로 한 번 훑으면 조상이
 * 전부 잡힌다: 깊이 d 인 행을 남기면 그보다 얕은 다음 행이 곧 부모다.
 */
export function filterRows(rows: readonly LayerRow[], query: string, f: LayerFilter): LayerRow[] {
  const q = query.trim().toLowerCase();
  const keep: boolean[] = new Array(rows.length).fill(false);
  // 이 깊이보다 얕은 행은 남긴 행의 조상이다. 0 이면 아직 남길 것이 없다는 뜻.
  let need = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (matches(r, q, f)) {
      keep[i] = true;
      if (r.depth > need) need = r.depth;
    } else if (r.depth < need) {
      keep[i] = true;
      need = r.depth;
    }
  }
  return rows.filter((_, i) => keep[i]);
}

// ── 노드 필드 갱신 ──────────────────────────────────────────────────────────

/**
 * 이름·표시·잠금만 바꾼다. **바뀐 노드만 새 참조**다 — 히스토리가 문서 전체를 스냅샷하므로
 * 안 바뀐 노드까지 복제하면 200칸이 그만큼 무거워진다.
 *
 * `objects.map` 이라 **순서를 바꾸지 않는다**(재배열은 tree.ts 만 — INDEX §10.4). 자손 전파도
 * 하지 않는다: 효과적 숨김/잠금은 38 `resolveScene` 이 조상 규칙으로 풀므로, 여기서 자식
 * 필드까지 쓰면 부모를 다시 켰을 때 자식이 꺼진 채로 남는다.
 */
export function patchNodes(
  objects: readonly Node[],
  ids: readonly ObjId[],
  patch: Partial<Pick<NodeBase, "name" | "visible" | "locked">>,
): Node[] {
  const set = new Set<ObjId>(ids);
  return objects.map((n) => {
    if (!set.has(n.id)) return n;
    // 빈 이름은 `null` 로 되돌린다 — 빈 문자열을 저장하면 행에 이름이 없는 채로 남아
    // 기본 이름조차 못 붙는다(이름 지우기 = 기본명 복귀, 44 §3.3).
    const name = patch.name === undefined ? n.name : patch.name === "" ? null : patch.name;
    const visible = patch.visible ?? n.visible;
    const locked = patch.locked ?? n.locked;
    if (name === n.name && visible === n.visible && locked === n.locked) return n;
    return { ...n, name, visible, locked };
  });
}

// ── 드래그 드롭 ─────────────────────────────────────────────────────────────

export interface DropTarget {
  parentId: ObjId | null;
  /** `tree.reparent` 의 index — **드래그 노드를 들어낸 뒤**의 형제 위치다. */
  index: number;
  pos: "before" | "after" | "inside";
  rowId: ObjId;
}

/** `id` 자신 또는 조상이 인스턴스인가. 인스턴스 안쪽은 마스터가 소유한다(51). */
function insideInstance(objects: readonly Node[], id: ObjId): boolean {
  if (nodeOf(objects, id)?.kind === "instance") return true;
  return ancestorsOf(objects, id).some((a) => nodeOf(objects, a)?.kind === "instance");
}

/**
 * 포인터가 행 `row` 의 세로 `yRatio`(0=위, 1=아래) 지점에 있을 때의 드롭 지점.
 * 놓을 수 없으면 `null`(패널은 고스트에 "여기로는 이동할 수 없습니다"를 띄운다).
 *
 * 거절 세 가지:
 * - **순환** — 자기 자손 안으로 넣으면 `tree.reparent` 가 던진다.
 * - **인스턴스 안** — 마스터 대응이 깨진다.
 * - **배경 아래** — 주석이 전부 이미지 뒤로 사라진다.
 *
 * `index` 변환이 뒤집히는 자리다: 패널 **위** = 문서 **뒤**(k+1), 패널 아래 = 문서 앞(k).
 * 형제 목록에서 드래그 대상을 먼저 빼는 이유는 `reparent` 가 슬라이스를 들어낸 **뒤**의
 * 목록에 index 를 적용하기 때문이다 — 안 빼면 위로 끌 때마다 한 칸씩 밀린다.
 */
export function dropTarget(
  _rows: readonly LayerRow[],
  objects: readonly Node[],
  dragIds: readonly ObjId[],
  row: LayerRow,
  yRatio: number,
): DropTarget | null {
  const drag = new Set<ObjId>(dragIds);
  if (drag.size === 0) return null;

  const container = row.node !== null && isContainer(row.node);
  // 가운데 50% 는 컨테이너면 안으로, 아니면 가까운 가장자리로 붙인다.
  const pos: DropTarget["pos"] =
    yRatio < 0.25
      ? "before"
      : yRatio > 0.75
        ? "after"
        : container
          ? "inside"
          : yRatio < 0.5
            ? "before"
            : "after";

  if (row.node === null) {
    // 배경 행 — 위(= 문서 맨 앞, 가장 아래 주석)만 받는다.
    return pos === "before" ? { parentId: null, index: 0, pos: "before", rowId: row.id } : null;
  }
  // 자기 자신 위/아래는 제자리다 — 커밋할 것이 없다.
  if (drag.has(row.id)) return null;

  const parentId = pos === "inside" ? row.id : row.node.parentId;
  if (parentId !== null) {
    if (drag.has(parentId)) return null;
    if (ancestorsOf(objects, parentId).some((a) => drag.has(a))) return null;
    if (insideInstance(objects, parentId)) return null;
  }

  const siblings: ObjId[] = [];
  for (const o of objects) if (o.parentId === parentId && !drag.has(o.id)) siblings.push(o.id);
  if (pos === "inside") {
    // 자식 맨 위 = 문서 순서 맨 뒤.
    return { parentId, index: siblings.length, pos, rowId: row.id };
  }
  const k = siblings.indexOf(row.id);
  if (k < 0) return null;
  return { parentId, index: pos === "before" ? k + 1 : k, pos, rowId: row.id };
}
