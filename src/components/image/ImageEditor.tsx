import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { AlertTriangle, FileWarning, Loader2, Minus, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  normalizeRect,
  transformObjects,
  type OrientDelta,
} from "../../lib/annotate/geometry";
import {
  aspectRatioOf,
  buildOriented,
  cropBounds,
  cropLabel,
  fitAspect,
  maxStraightenFor,
  resizeCropRect,
  straightenObjects,
  type CropSession,
} from "../../lib/annotate/crop";
import { DocHistory } from "../../lib/annotate/history";
import type { LayerFilter } from "../../lib/annotate/layer-rows";
import { ensureAssets, imageStore } from "../../lib/annotate/imageStore";
import { useImageDocPersist, type SnapshotInfo } from "../../lib/annotate/persist";
import {
  estimateRenderBytes,
  renderOutput as renderOutputTiled,
  renderRegion,
} from "../../lib/annotate/render";
import { resolveScene } from "../../lib/annotate/scene";
import {
  isGeomNode,
  objectBBox,
  objectFrame,
  selectBox,
  setObjectFrame,
  translateObject,
} from "../../lib/annotate/geometry";
import {
  alignObjects,
  distributeObjects,
  flipNodes,
  tidyObjects,
  type AlignMode,
} from "../../lib/annotate/align";
import {
  classifySelection,
  MIXED,
  readProp,
  type Maybe,
  type SelectionKind,
} from "../../lib/annotate/selection";
import { layoutText, mixedTextStyle } from "../../lib/annotate/text-layout";
import { matchShortcut } from "../../lib/annotate/shortcuts";
import {
  ancestorsOf as treeAncestorsOf,
  assertTreeInvariant,
  childrenOf as treeChildrenOf,
  group as treeGroup,
  isContainer,
  makeMask as treeMakeMask,
  maskScope as treeMaskScope,
  nodeAABB as treeNodeAABB,
  nodeOf as treeNodeOf,
  releaseMask as treeReleaseMask,
  remove as treeRemove,
  reorder as treeReorder,
  reparent as treeReparent,
  rotateNodes as treeRotate,
  subtreeIds as treeSubtreeIds,
  subtreeRange as treeSubtreeRange,
  translateSubtree as treeTranslate,
  ungroup as treeUngroup,
} from "../../lib/annotate/tree";
import { acquireAsset, acquireFromFile } from "../../lib/annotate/assets";
import {
  applyPaintPatch,
  DOC_VERSION,
  documentColors,
  normalizeDoc,
  normalizeNode,
  paintOf,
  parseImageDoc,
  serializeImageDoc,
  type ImageDocEnvelope,
  type PaintPatch,
} from "../../lib/annotate/schema";
import {
  DEFAULT_OPACITY,
  DEFAULT_PAINT,
  DUPLICATE_OFFSET,
  newObjId,
  type Node,
  type EditorDoc,
  type Effect,
  type Fill,
  type GeomNode,
  type NodeBase,
  type ObjId,
  type Paint,
  type PathNode,
  type Rect,
  type DefaultPaint,
  type TextNode,
  type TextStyle,
} from "../../lib/annotate/types";
import {
  booleanOp,
  flattenObjects,
  separateSubPaths,
} from "../../lib/annotate/vector/boolean";
import {
  canBoolean,
  canFlatten,
  canOutline,
  toPathObject,
} from "../../lib/annotate/vector/convert";
import { outlineStroke } from "../../lib/annotate/vector/outline";
import {
  useImageEditorUi,
  type EditorUiState,
  type Mode,
  type Tool,
} from "../../stores/imageEditor";
import {
  bytesToBase64,
  encodeCanvas,
  extOf,
  formatOfPath,
  loadImage,
  type ImgFormat,
} from "../../lib/image-codec";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { copyText } from "../../lib/clipboard";
import { IS_DOC_WINDOW } from "../../lib/floating";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import {
  clampScale,
  IDENTITY_VIEW,
  WHEEL_STEP,
  zoomAt,
  zoomTo,
  type View,
} from "../../lib/zoom";
import { useSaveImage } from "../../queries";
import { useUi } from "../../stores/ui";
import {
  rulerTicks,
  STAGE_Z,
  type ChromePrim,
  type ChromeScreen,
  type ChromeState,
} from "../../lib/annotate/chrome";
import {
  buildSnapIndex,
  snapPoint,
  snapRect,
  type SnapIndex,
} from "../../lib/annotate/snap";
import AnnotationLayer, {
  type AnnotationLayerHandle,
} from "./AnnotationLayer";
import ChromeOverlay, { type ChromeOverlayHandle } from "./ChromeOverlay";
import { newImageNode } from "./annotation/draft";
import {
  cropDragMods,
  hitCropHandle,
  registerPointerHit,
  HANDLE_GRAB_CSS,
} from "./annotation/pointer";
import { CropInspectorSection } from "./CropInspectorSection";
import { useCropSession } from "./useCropSession";
import EditorStatusBar, { type StatusBarHandle } from "./EditorStatusBar";
import EditorTitleBar from "./EditorTitleBar";
import { LeftPanel } from "./LeftPanel";
import type { LayerPanelHandle } from "./layers/LayerPanel";
import ToolRail, { type ToolRailHandle } from "./ToolRail";
import { ContextBar, type EditorActions as BarActions } from "./ContextBar";
import { Inspector } from "./inspector/Inspector";
import { AdjustTab } from "./inspector/AdjustTab";
import { ExportTabHost } from "./inspector/ExportTabHost";
import { InspectorFooter } from "./inspector/InspectorFooter";
import {
  PropsTab,
  takesPaint,
  type EditorActions as PropsActions,
  type PaintSlot,
  type PropsPopoverRequest,
} from "./inspector/PropsTab";
import { NumField } from "./inspector/fields/NumField";
import { Select, type SelectOption } from "./inspector/fields/Select";
import { Toggle } from "./inspector/fields/Toggle";
import { BooleanPreviewStrip } from "./vector/BooleanPreviewStrip";
import type { PathOp, PathPatch } from "./vector/PathInspectorSection";
import { closeTopPopover, hasOpenPopover, Popover } from "./popovers/Popover";
import { ColorPicker } from "./popovers/ColorPicker";
import { EffectEditor } from "./popovers/EffectEditor";
import { useEyedropper } from "./popovers/Eyedropper";
import { GradientEditor } from "./popovers/GradientEditor";
import { useEditorKeys } from "./useEditorKeys";

// 프리뷰 백킹 스토어 상한 — 거대 이미지를 전체 해상도로 그리면 메모리 폭증 + Chromium 캔버스
// 한계(빈 화면)에 걸린다. 프리뷰는 이 한도로 다운스케일하고, 크롭 좌표는 항상 oriented px 기준.
const MAX_PREVIEW = 1800;
// 출력 캔버스 한 변 상한(Chromium 캔버스 한계 가드) — 초과 시 인코딩 전에 명확히 실패시킨다.
const MAX_OUTPUT_DIM = 16384;

/**
 * 객체 복사·붙여넣기의 클립보드 접두(42 §3.4). **텍스트로** 나가야 doc 창과 메인 창처럼
 * JS 컨텍스트가 갈린 두 창 사이에서도 붙는다 — 메모리에 든 노드는 서로 못 본다.
 * 접두가 없으면 붙여넣기 쪽이 남의 텍스트를 우리 문서로 오인해 파싱한다.
 */
const CLIP_PREFIX = "gpv-anno:";
// 입력 화소수 상한. 8K(33MP)는 통과시키고 초대형 스캔본을 막는 선 — 편집기 하나가 이미지
// 한 장을 두고 디코드·oriented·프리뷰 3장·저장 캔버스를 동시에 들기 때문이다(설계 §6.3).
const MAX_INPUT_PIXELS = 100_000_000;
/** 최근 사용 색 기억 개수(42 스토어 `recentColors` 상한 — `ColorPicker` 와 같은 값이어야 한다). */
const RECENT_COLORS = 12;

/** 빈 문서 — 경계(normalizeDoc)가 만든다. 필드를 두 곳에서 셀 이유가 없다(37 §4). */
const EMPTY_DOC: EditorDoc = normalizeDoc({});

/** 확장자 → 비-라운드트립 경고 문구(설계 D3, §6.3). 라운드트립 가능한 포맷이면 null. */
function roundTripWarning(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (ext === "svg") return "SVG → PNG 래스터화되어 저장됩니다";
  if (ext === "gif") return "첫 프레임만 편집·저장됩니다";
  return formatOfPath(path) === null ? "PNG로 저장됩니다" : null;
}

// ── 액션 맵(45 §4) ──────────────────────────────────────────────────────────
//
// 컨텍스트 바와 속성 탭이 각자 자기 파일에서 같은 이름의 계약을 선언한다(둘 다 이 파일이
// 구현을 든다는 전제로 쓰였다). 여기서 **교집합이 아니라 합집합**으로 든다 — 한쪽만 만족하면
// 나머지 한쪽이 컴파일에서 터지고, 둘을 따로 만들면 버튼과 단축키가 갈라진다.
//
// 두 선언이 겹치는 자리의 인자가 서로 넓다(`patchSelection` 은 patch|함수, `setFrame` 은
// id 하나|배열). 구현은 **둘 다 받는** 쪽으로 넓혀 둔다.
export type EditorActions = BarActions & PropsActions;

/**
 * 선택 전체에 쓰는 속성 묶음 — 두 계약의 patch 타입을 합친 것.
 * `DefaultPaint` 키는 `applyPaintPatch`(37)가 kind 를 보고 거르고, 나머지는 노드 공통 필드다.
 */
type SelPatch = PaintPatch &
  Partial<
    Pick<
      NodeBase,
      "opacity" | "blend" | "name" | "visible" | "locked" | "constraints" | "effects"
    >
  >;

const PAINT_KEYS = [
  "fills",
  "strokes",
  "strokeWidth",
  "radius",
  "fontSize",
  "mosaicMode",
  "mosaicStrength",
  "typo",
] as const satisfies readonly (keyof DefaultPaint)[];

/** `applyPaintPatch` 가 아는 키만 남긴다 — 모르는 키를 넘기면 조용히 무시돼 값이 안 들어간다. */
function paintPart(p: SelPatch): PaintPatch {
  const out: PaintPatch = {};
  for (const k of PAINT_KEYS) if (p[k] !== undefined) Object.assign(out, { [k]: p[k] });
  return out;
}

/**
 * 노드 하나에 패치를 얹는다. 페인트 스택은 37 깔때기를 지나고 공통 필드는 직접 얹는다 —
 * `applyPaintPatch` 는 `DefaultPaint` 키만 알아서 `opacity`/`blend`/`effects` 를 **말없이 버린다**.
 */
function applySelPatch(o: Node, p: SelPatch): Node {
  let next = applyPaintPatch(o, paintPart(p));
  if (p.opacity !== undefined) next = { ...next, opacity: Math.min(1, Math.max(0, p.opacity)) };
  if (p.blend !== undefined) next = { ...next, blend: p.blend };
  if (p.effects !== undefined) next = { ...next, effects: p.effects };
  if (p.name !== undefined) next = { ...next, name: p.name };
  if (p.visible !== undefined) next = { ...next, visible: p.visible };
  if (p.locked !== undefined) next = { ...next, locked: p.locked };
  if (p.constraints !== undefined) next = { ...next, constraints: p.constraints };
  return next;
}

/** 팔레트·색 피커가 고른 색을 최근 목록 맨 앞으로. `ColorPicker` 의 비공개 `pushRecent` 와 같은 규칙. */
function rememberColor(p: SelPatch): void {
  const head = (p.strokes ?? p.fills)?.find((f) => f.visible && f.type === "solid");
  if (!head || head.type !== "solid") return;
  const hex = head.color;
  useImageEditorUi.setState((s) =>
    s.recentColors[0] === hex
      ? s
      : { recentColors: [hex, ...s.recentColors.filter((c) => c !== hex)].slice(0, RECENT_COLORS) },
  );
}

// ── 벡터 연산(46 §4) ────────────────────────────────────────────────────────

/** 히스토리 라벨 = 사용자가 누른 버튼의 이름. 연산마다 다른 이름을 쓰면 되돌리기 목록이 거짓말을 한다. */
const OP_LABEL: Record<PathOp, string> = {
  union: "합집합",
  subtract: "차집합",
  intersect: "교집합",
  exclude: "제외",
  flatten: "평탄화",
  outline: "윤곽선화",
  separate: "패스 분리",
};

const VECTOR_OPS = Object.keys(OP_LABEL) as PathOp[];

/**
 * 불리언 4연산 · 평탄화 · 윤곽선화 · 패스 분리 — 단축키·컨텍스트 바·인스펙터·미리보기 스트립·
 * e2e 훅이 전부 이 함수 하나를 탄다.
 *
 * **판정(`can`)이 실행(`run`)과 같은 자리에 있다.** 갈라 두면 잠긴 버튼의 단축키만 도는 조합이
 * 생기고, 그때 사용자는 "키로는 되는데 버튼으로는 안 된다"를 겪는다.
 *
 * 전부 **파괴적 1커밋**이고 끝나면 선택을 결과 노드로 옮긴다. 피연산자가 사라졌는데 선택이
 * 남으면 다음 조작이 문서에 없는 id 를 만지고, 그 뒤로는 아무 버튼도 듣지 않는다.
 */
export function vectorActions(ctx: {
  doc: EditorDoc;
  ids: readonly ObjId[];
  applyDoc(next: EditorDoc, mode: "commit", label: string): void;
  select(ids: ObjId[]): void;
}): { run(op: PathOp): ObjId[]; can(op: PathOp): boolean } {
  const objects = ctx.doc.objects;
  const set = new Set(ctx.ids);
  // 선택은 **문서 순서(z)** 로 다시 세운다 — 클릭 순서 그대로 넘기면 차집합이 "아래 도형에서
  // 위를 뺀다"(§3.5)를 못 지켜, 같은 두 도형이 고른 차례에 따라 다른 결과를 낸다.
  const picked = objects.filter((o) => set.has(o.id));
  // 조상과 자손을 함께 골랐으면 조상만 남긴다 — 삭제·자리 계산의 단위다.
  const roots = picked.filter((o) => !treeAncestorsOf(objects, o.id).some((a) => set.has(a)));

  /** 평탄화 입력 — 컨테이너는 리프까지 편다(§3.6). 컨테이너 자신은 기하가 아니라 뺀다. */
  const leaves = (): GeomNode[] => {
    const ids = new Set(roots.flatMap((o) => treeSubtreeIds(objects, o.id)));
    return objects.filter(
      (o): o is GeomNode => ids.has(o.id) && isGeomNode(o) && !isContainer(o),
    );
  };

  /** 이미 패스 하나면 평탄화는 항등이다 — 커밋하면 아무것도 안 바뀐 히스토리 칸만 남는다(41 의 200칸). */
  const flattenIsNoop = () => {
    const l = leaves();
    return l.length === 1 && l[0].kind === "path";
  };

  const single = picked.length === 1 ? picked[0] : null;

  /**
   * 결과를 최상위 소스 자리(같은 부모·같은 형제 인덱스)에 놓고 소스를 서브트리째 지운다.
   *
   * 새 노드는 **루트 끝에 붙인 뒤 `reparent` 로** 옮긴다. `parentId` 만 바꿔 배열 끝에 두면
   * "자손은 컨테이너 바로 뒤에 연속"(38 불변식 ②)이 깨져 커밋에서 즉시 터진다.
   */
  const replaceRoots = (made: readonly Node[]): Node[] => {
    const anchor = roots[roots.length - 1];
    const parent = anchor.parentId;
    const siblings = treeChildrenOf(objects, parent);
    const gone = new Set(roots.map((o) => o.id));
    // 삽입 위치는 **살아남는 형제** 기준으로 센다. 원래 인덱스를 그대로 쓰면 아래쪽 피연산자가
    // 함께 사라진 만큼 목록이 짧아져, 결과가 제자리가 아니라 맨 위로 올라간다(a+b 를 합치면
    // c 위로 튀어 나온다). 겹침 순서가 조용히 바뀌는 종류의 사고다.
    const index = siblings
      .slice(0, siblings.indexOf(anchor.id))
      .filter((id) => !gone.has(id)).length;
    const rest = treeRemove(objects, roots.map((o) => o.id));
    const placed = made.map((n) => ({ ...n, parentId: null }));
    return treeReparent(
      [...rest, ...placed],
      placed.map((n) => n.id),
      parent,
      index,
    );
  };

  const commit = (next: Node[], ids: ObjId[], op: PathOp): ObjId[] => {
    ctx.applyDoc({ ...ctx.doc, objects: next }, "commit", OP_LABEL[op]);
    ctx.select(ids);
    return ids;
  };

  const can = (op: PathOp): boolean => {
    switch (op) {
      case "flatten":
        return canFlatten(picked) && !flattenIsNoop();
      case "outline":
        return !!single && canOutline(single);
      case "separate":
        return !!single && single.kind === "path" && single.subpaths.length > 1;
      default:
        return canBoolean(picked);
    }
  };

  return {
    can,
    run(op) {
      if (!can(op)) return [];
      if (op === "flatten") {
        const made = flattenObjects(leaves());
        if (!made) return [];
        // 뱃지 숫자는 텍스트로 따라 나온다(§3.6) — 빼면 평탄화한 순간 번호가 사라진다.
        const nodes = [made.path, ...made.extras];
        return commit(replaceRoots(nodes), nodes.map((n) => n.id), op);
      }
      if (op === "outline") {
        // 텍스트는 같은 액션 id 아래 50 `outlineText` 가 맡는다 — `canOutline` 이 거짓이라
        // 여기까지 오지 않는다. 그 사실은 호출자가 알린다(빈 배열 = 아무 일도 없었다).
        const made = single && isGeomNode(single) ? outlineStroke(single) : null;
        if (!made) return [];
        // 제자리 치환이다(id 유지) — 선택도 z 순서도 그대로 남는다.
        return commit(
          objects.map((o) => (o.id === made.id ? made : o)),
          [made.id],
          op,
        );
      }
      if (op === "separate") {
        // `can` 이 이미 봤지만 다시 좁힌다 — 캐스트로 넘기면 게이트가 한 번 느슨해지는 날
        // `separateSubPaths` 가 subpaths 없는 노드를 받아 터진다.
        if (!single || single.kind !== "path") return [];
        const parts = separateSubPaths(single);
        const i = objects.indexOf(single);
        return commit(
          [...objects.slice(0, i), ...parts, ...objects.slice(i + 1)],
          parts.map((p) => p.id),
          op,
        );
      }
      const made = booleanOp(picked.filter(isGeomNode), op);
      // 겹치지 않는 두 도형의 교집합처럼 결과가 비면 문서를 건드리지 않는다.
      if (!made) return [];
      return commit(replaceRoots([made]), [made.id], op);
    },
  };
}

/** `PathPatch` 중 `applyPaintPatch`(37)가 모르는 키 — 노드에 직접 얹는다(§3.8). */
const PATH_KEYS = [
  "fillRule",
  "subpaths",
  "strokeAlign",
  "dash",
  "cap",
  "join",
  "miterLimit",
  "heads",
] as const satisfies readonly (keyof PathNode)[];

/** 선 기하 키 — 값을 직접 고치면 스타일 참조를 뗀다(`applyPaintPatch` 와 같은 규칙). */
const PATH_STROKE_KEYS = [
  "strokeAlign",
  "dash",
  "cap",
  "join",
  "miterLimit",
  "heads",
] as const satisfies readonly (typeof PATH_KEYS)[number][];

function applyPathPatch(node: PathNode, p: PathPatch): PathNode {
  // **반드시 복사한다.** `applyPaintPatch` 는 아는 키가 하나도 없으면 원본을 그대로 돌려주므로
  // (`if (!touched) return node`), 그 위에 Object.assign 하면 문서에 든 노드를 제자리에서
  // 뜯어고친다 — 히스토리의 이전 칸까지 같은 객체를 가리켜 되돌리기가 아무 것도 안 되돌린다.
  const next: PathNode = { ...(applySelPatch(node, p) as PathNode) };
  for (const k of PATH_KEYS) if (p[k] !== undefined) Object.assign(next, { [k]: p[k] });
  // 라이브러리 값과 어긋난 채 링크가 남으면 다음 라이브러리 변경이 이 편집을 덮는다(51 §4).
  if (PATH_STROKE_KEYS.some((k) => p[k] !== undefined) && next.styleRefs.stroke) {
    const { stroke: _drop, ...rest } = next.styleRefs;
    next.styleRefs = rest;
  }
  return next;
}

const ALIGN_LABEL: Record<AlignMode, string> = {
  left: "왼쪽",
  hcenter: "가로 가운데",
  right: "오른쪽",
  top: "위",
  vcenter: "세로 가운데",
  bottom: "아래",
};

const SLOT_TITLE: Record<PaintSlot, string> = { fills: "채우기", strokes: "선" };

/**
 * 선택 종류 → 자동으로 열 인스펙터 탭(45 §3.1 표). `none` 은 여기 없다 — 아무것도 안 골랐다고
 * 보던 탭을 빼앗으면 조정 슬라이더를 만지다 빈 곳을 클릭한 것만으로 탭이 튄다.
 */
const AUTO_TAB: Partial<Record<SelectionKind, EditorUiState["inspectorTab"]>> = {
  "single-shape": "props",
  multi: "props",
  "vector-edit": "props",
  text: "text",
  image: "adjust",
  crop: "adjust",
};

const PAINT_KIND_TITLE: Record<Paint["type"], string> = {
  solid: "단색",
  linear: "선형 그라디언트",
  radial: "방사형 그라디언트",
  angular: "원뿔 그라디언트",
  diamond: "다이아 그라디언트",
  image: "이미지",
};

const EFFECT_TITLE: Record<Effect["type"], string> = {
  "drop-shadow": "드롭 섀도",
  "inner-shadow": "이너 섀도",
  "layer-blur": "레이어 블러",
  "background-blur": "배경 블러",
};

/** 스택 한 겹만 갈아 끼운다 — 표시·블렌드는 그 겹의 것을 남긴다(팝오버는 색만 고친다). */
function replacePaint(list: readonly Fill[], i: number, p: Paint): Fill[] {
  return list.map((f, k) => (k === i ? { ...p, visible: f.visible, blend: f.blend } : f));
}

/**
 * 맨 앞 겹을 단색으로 바꾼다(없으면 만든다). **나머지 겹은 그대로 둔다** — 스택을 통째로
 * 갈면 두 번째 채우기가 말없이 사라진다(스포이드·팔레트가 같은 규칙을 쓴다).
 */
function withSolidHead(list: readonly Fill[], hex: string): Fill[] {
  const head = list[0];
  return [
    {
      type: "solid",
      color: hex,
      opacity: head && head.type === "solid" ? head.opacity : 1,
      visible: head?.visible ?? true,
      blend: head?.blend ?? "normal",
    },
    ...list.slice(1),
  ];
}

/**
 * 이미지 편집기 모달 — 트리·뷰어에서 "이미지 편집"으로 연다.
 * 회전/반전/크롭/리사이즈/색보정 + 주석(마크업) 후 평탄화 저장(DOCS/image-annotation-design.md).
 */
export default function ImageEditor() {
  const path = useUi((s) => s.imageEditorPath);
  const editorRepoId = useUi((s) => s.imageEditorRepoId);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  // 임베디드 저장소 파일이면 그 저장소 id로 읽고 써야 한다 — 경로만 믿으면 바깥 레포에
  // 엉뚱한 파일을 만든다(설계 D1).
  const projectId = editorRepoId ?? selectedProjectId;
  const close = useUi((s) => s.closeImageEditor);
  const askPrompt = useUi((s) => s.askPrompt);
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const saveImage = useSaveImage(projectId ?? "");

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** 읽은 시점의 원본 파일 정체 — 제자리 저장에서만 되돌려 준다(§ 무성 덮어쓰기 방지). */
  const stampRef = useRef<string | null>(null);

  // ── 편집 문서(히스토리 스냅샷 단위, §5.1) ──
  const [doc, setDoc] = useState<EditorDoc>(EMPTY_DOC);
  const docRef = useRef(doc);
  docRef.current = doc;
  const histRef = useRef<DocHistory>(new DocHistory(EMPTY_DOC));
  // canUndo/canRedo 는 클래스 내부 상태라 리렌더 트리거가 따로 필요하다.
  const [histVer, setHistVer] = useState(0);

  /**
   * 편집 문서 영속(41). 커밋마다 1초 디바운스로 앱 데이터 사이드카에 쓰고, 열 때 되살린다.
   * 훅이 매 렌더 새 객체를 주므로 ref 로 미러해 effect·콜백이 최신 것을 보게 한다.
   */
  const persist = useImageDocPersist(editorRepoId ?? null, path ?? null, histRef, {
    imageStamp: stampRef.current,
    imageW: img?.naturalWidth ?? 0,
    imageH: img?.naturalHeight ?? 0,
  });
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // 이미지 페인트 디코드 캐시. `doc.assets` 참조를 키로 하는 WeakMap 위에 얹혀 있어
  // 여러 번 만들어도 같은 캐시를 본다(39 §3.6) — 참조만 안정시켜 재렌더를 줄인다.
  const store = useMemo(() => imageStore(doc), [doc]);
  const storeRef = useRef(store);
  storeRef.current = store;
  /** 디코드가 끝날 때마다 오른다 — 커밋 캐시를 한 번 무효화해 진짜 그림이 나오게 한다. */
  const [assetsVer, setAssetsVer] = useState(0);
  useEffect(() => {
    let alive = true;
    void ensureAssets(doc).then(() => {
      if (alive) setAssetsVer((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [doc.assets]);

  // ── 문서 밖 UI 상태 ──
  //
  // 도구·모드·선택은 **창별 스토어**가 갖는다(42 §3.1). 레이어 패널(44)·컨텍스트 바(45)·
  // 상태바가 같은 값을 봐야 하는데, 로컬 state 로 두면 prop 이 4단이 되고 호버(초당 60회)가
  // 이 1,400줄 컴포넌트를 통째로 리렌더한다. 아래 이름들은 종전 그대로라 사용처는 무변경이다.
  const tool = useImageEditorUi((s) => s.tool);
  const mode = useImageEditorUi((s) => s.mode);
  const setTool = useImageEditorUi((s) => s.setTool);
  const setMode = useImageEditorUi((s) => s.setMode);
  const uiSelect = useImageEditorUi((s) => s.select);
  const uiReset = useImageEditorUi((s) => s.reset);
  const setTextEditing = useImageEditorUi((s) => s.setTextEditing);
  const leftTab = useImageEditorUi((s) => s.leftTab);
  const rawSelectedIds = useImageEditorUi((s) => s.selectedIds);
  /** `'__base'`(이미지 배경 의사 id)는 노드가 아니다 — 기하·페인트 경로에 흘리지 않는다. */
  const selectedIds = useMemo(
    () => rawSelectedIds.filter((id): id is ObjId => id !== "__base"),
    [rawSelectedIds],
  );
  const setSelectedIds = useCallback((ids: ObjId[]) => uiSelect(ids), [uiSelect]);
  const cropMode = mode.kind === "crop";
  const setCropMode = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      const next =
        typeof v === "function"
          ? v(useImageEditorUi.getState().mode.kind === "crop")
          : v;
      setMode(next ? { kind: "crop" } : { kind: "design" });
    },
    [setMode],
  );

  const [lockRatio, setLockRatio] = useState(true);
  const [format, setFormat] = useState<ImgFormat>("png");
  const [quality, setQuality] = useState(90);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const [style, setStyle] = useState<DefaultPaint>(DEFAULT_PAINT);
  const [opacity, setOpacity] = useState(DEFAULT_OPACITY);
  // 최근 색은 **스토어 한 곳**이다. 여기 로컬 사본을 두면 색 피커(스토어를 직접 쓴다)와
  // 팔레트가 서로 다른 목록을 보여 준다.
  const recent = useImageEditorUi((s) => s.recentColors);
  // 액션 맵은 리렌더 없이 최신 값을 봐야 한다(전부 stable useCallback) — 그래서 거울을 둔다.
  const styleRef = useRef(style);
  styleRef.current = style;

  /**
   * 화면 확대·이동. **CSS transform 으로만** 건다 — 프리뷰 백킹(previewScale/backW/backH)은
   * 절대 따라 키우지 않는다. 백킹을 건드리면 주석 캐시 키가 배율을 물고 있어(AnnotationLayer)
   * 휠 노치마다 전량 재렌더가 돌고, "oriented px == 백킹 px" 를 전제로 한 좌표가 전부 어긋난다.
   */
  const [view, setView] = useState<View>(IDENTITY_VIEW);

  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 변환이 걸리지 않은 레이아웃 앵커 — 줌 수식의 기준 프레임(rect 가 view 에 흔들리지 않는다). */
  const boxRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<AnnotationLayerHandle | null>(null);
  /** SVG 크롬 오버레이 실물. */
  const chromeRef = useRef<ChromeOverlayHandle | null>(null);
  /** 마지막으로 그린 크롬 상태 — e2e 훅이 읽고, `chrome.set` 이 그 위에 얹는다. */
  const lastChromeRef = useRef<ChromeState | null>(null);
  /** 주석 레이어가 마지막으로 준 원본(=`extra` 합류 전). 프리미티브만 바뀔 때 다시 그릴 근거다. */
  const baseChromeRef = useRef<ChromeState | null>(null);
  /**
   * 45 팝오버가 캔버스에 얹는 크롬 프리미티브(그라디언트 핸들). 주석 레이어는 이 값을 모르고
   * 매 프레임 자기 `extra` 를 새로 만들므로, **여기서 합류**시키지 않으면 핸들이 다음 프레임에
   * 사라진다(드래그 중에는 매 틱 다시 그려진다).
   */
  const chromeExtraRef = useRef<ChromePrim[]>([]);
  /** 진행 중인 크롭 세션(48). 렌더마다 갱신되고, 매 프레임 도는 경로가 ref 로만 읽는다. */
  const cropSessionRef = useRef<CropSession | null>(null);
  const paintChrome = useCallback((st: ChromeState) => {
    baseChromeRef.current = st;
    const ex = chromeExtraRef.current;
    let merged = ex.length ? { ...st, extra: [...st.extra, ...ex] } : st;
    // 크롭 **세션 중**에만 8핸들과 크기 배지를 얹는다(48 §3.3). 주석 레이어는 세션을 모르고
    // 확정된 `doc.crop` 도 같은 자리를 쓰므로, 여기서 갈라 두지 않으면 이미 적용된 크롭에도
    // 잡히지 않는 핸들이 그려진다.
    const s = cropSessionRef.current;
    if (s && merged.crop) {
      merged = {
        ...merged,
        crop: {
          ...merged.crop,
          overlay: s.overlay,
          label: cropLabel(s, { straighten: true }),
          handles: true,
        },
      };
    }
    lastChromeRef.current = merged;
    chromeRef.current?.update(merged);
  }, []);
  /**
   * 주석 레이어에 넘기는 **경유 핸들**. 오버레이를 그대로 넘기면 마지막 상태를 볼 방법이 없다
   * (오버레이는 상태를 밖으로 내주지 않는다) — 한 겹 두어 훅과 강제 갱신이 같은 값을 본다.
   */
  const chromeTapRef = useRef<ChromeOverlayHandle>({
    update: (st) => paintChrome(st),
  });
  /**
   * `GradientEditor` 의 `onExtra`. **참조가 안정해야 한다** — 매 렌더 새 함수면 그쪽 이펙트가
   * 렌더마다 돌아 크롬이 초당 60회 재구축된다.
   */
  const setChromeExtra = useCallback(
    (prims: ChromePrim[]) => {
      chromeExtraRef.current = prims;
      // 문서가 안 바뀌는 조작(각도 필드만 만지는 등)에서는 레이어가 프레임을 안 돌린다 —
      // 마지막 원본 위에 다시 얹어 한 번 더 그린다.
      if (baseChromeRef.current) paintChrome(baseChromeRef.current);
    },
    [paintChrome],
  );
  const railRef = useRef<ToolRailHandle | null>(null);
  const statusRef = useRef<StatusBarHandle | null>(null);
  /**
   * 레이어 패널(44). 검색·필터·접기·이름 편집은 패널 로컬 state 라 F2 액션도 e2e 훅도
   * 이 손잡이를 거쳐야 닿는다 — 그 상태를 스토어로 올리면 undo 와 사이드카가 UI 를 싣는다.
   */
  const layerPanelRef = useRef<LayerPanelHandle | null>(null);
  /**
   * 편집기 루트(`role="application"`). 포커스가 여기 있어야 Space 가 손 도구가 된다 —
   * 방금 누른 버튼에 남으면 Space 가 그 버튼을 다시 누르고, 아무 데도 없으면 뒤에 있는
   * 터미널 textarea 로 흘러간다(42 §3.3).
   */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusRoot = useCallback(() => rootRef.current?.focus(), []);
  useEffect(() => {
    rootRef.current?.focus();
  }, [path]);

  // ── 문서 갱신 ──────────────────────────────────────────────────────────────

  /**
   * 문서를 갱신한다. `mode:"commit"` 은 히스토리 스냅샷을 남기고, `"replace"` 는 남기지 않는다
   * (드래그 중 라이브 갱신). React 18+ StrictMode 가 업데이터를 두 번 부를 수 있으므로
   * 히스토리 조작은 setState 업데이터 **밖**에서 한다.
   */
  const applyDoc = useCallback(
    (next: EditorDoc, mode: "commit" | "replace" = "commit", label?: string) => {
      // 트리 불변식은 **커밋 경로 한 곳**에서 본다 — objects 를 직접 splice 한 코드가 있으면
      // 여기서 즉시 터진다(태스크 38 §3.1). DEV 전용이라 배포 빌드에는 없다.
      if (import.meta.env.DEV) assertTreeInvariant(next.objects);
      docRef.current = next;
      if (mode === "commit") {
        histRef.current.commit(next, label);
        // 커밋 = 사용자가 "한 일" 하나 — 여기서만 자동저장을 예약한다(드래그 중 틱은 replace).
        persistRef.current?.markDirty();
      } else {
        histRef.current.replace(next);
      }
      setDoc(next);
      setHistVer((v) => v + 1);
    },
    [],
  );

  /**
   * e2e 훅이 읽는 최신 값 미러 — 훅 effect 의 의존성을 늘리지 않으려고 ref 로 둔다
   * (의존성에 넣으면 조정 슬라이더 틱마다 훅이 재설치된다).
   */
  const orientedRef = useRef<HTMLCanvasElement | null>(null);
  const filterStrRef = useRef("none");

  /** 사이드카 복원 뒤 원본이 바뀌어 있었는가 — 배너로 한 번 알린다. */
  const [imageChanged, setImageChanged] = useState(false);

  /** 숨김·잠금·마스크가 풀린 씬. 렌더·히트·선택이 전부 이걸 본다(38 §3.2). */
  const scene = useMemo(() => resolveScene(doc), [doc]);

  /** 상태바 `W × H`·"선택 맞춤" 줌이 함께 쓰는 선택 상자(38 `selectBox`). */
  const selBox = useMemo(
    () => (selectedIds.length ? selectBox(scene, selectedIds).rect : null),
    [scene, selectedIds],
  );

  const patchDoc = useCallback(
    (patch: Partial<EditorDoc>, mode: "commit" | "replace" = "commit", label?: string) =>
      applyDoc({ ...docRef.current, ...patch }, mode, label),
    [applyDoc],
  );

  // 슬라이더처럼 드래그 중 연속으로 바뀌는 값 — 첫 틱만 스냅샷을 남기고 나머지는 덮어쓴다.
  // 결과적으로 드래그 한 번이 히스토리 한 칸이 된다(§5.3).
  const liveRef = useRef(false);
  const patchLive = useCallback(
    (patch: Partial<EditorDoc>, label?: string) => {
      patchDoc(patch, liveRef.current ? "replace" : "commit", label);
      liveRef.current = true;
    },
    [patchDoc],
  );
  const endLive = useCallback(() => {
    liveRef.current = false;
  }, []);

  /**
   * 확정 커밋. **라이브 구간이 열려 있으면 그 칸을 덮고 봉인한다** — 그냥 commit 하면
   * 슬라이더·핸들 드래그 한 번이 히스토리 두 칸(첫 라이브 틱 + 최종 커밋)이 되어
   * Ctrl+Z 가 같은 조작을 두 번 되돌린다(45 §3.4).
   */
  const commitDoc = useCallback(
    (patch: Partial<EditorDoc>, label: string) => {
      if (liveRef.current) {
        liveRef.current = false;
        patchDoc(patch, "replace", label);
        return;
      }
      patchDoc(patch, "commit", label);
    },
    [patchDoc],
  );

  const undo = useCallback(() => {
    const d = histRef.current.undo();
    if (!d) return;
    docRef.current = d;
    setDoc(d);
    setHistVer((v) => v + 1);
    setSelectedIds([]);
  }, []);
  const redo = useCallback(() => {
    const d = histRef.current.redo();
    if (!d) return;
    docRef.current = d;
    setDoc(d);
    setHistVer((v) => v + 1);
    setSelectedIds([]);
  }, []);

  /**
   * 히스토리 목록에서 한 항목으로 점프(41). 되돌리기와 달리 **여러 칸을 한 번에** 건너뛴다.
   * `markDirty` 를 빼면 점프한 상태가 사이드카에 안 남아, 편집기를 닫았다 열면 점프 전으로
   * 되돌아온다. e2e 훅도 같은 함수를 쓴다 — 둘이 갈라지면 목록 클릭과 훅이 다르게 동작한다.
   */
  const jumpTo = useCallback((i: number) => {
    const d = histRef.current.jumpTo(i);
    if (!d) return false;
    docRef.current = d;
    setDoc(d);
    setHistVer((v) => v + 1);
    persistRef.current?.markDirty();
    return true;
  }, []);

  const loadSnapshot = useCallback(
    async (i: number) => {
      const d = await persistRef.current?.loadSnapshot(i);
      if (!d) return false;
      applyDoc(d, "commit", "스냅샷 복원");
      return true;
    },
    [applyDoc],
  );

  /** 히스토리 탭 `스냅샷` 칩이 보여 주는 목록(41 `listSnapshots`, 별도 파일). */
  const [snapshots, setSnapshots] = useState<readonly SnapshotInfo[]>([]);
  const refreshSnapshots = useCallback(async () => {
    setSnapshots((await persistRef.current?.listSnapshots()) ?? []);
  }, []);
  // 스냅샷은 별도 파일이라 목록도 별도 IPC 다 — 히스토리 탭을 열 때만 읽는다. 편집기를 여는
  // 것만으로 읽으면 이 탭을 한 번도 안 여는 대부분의 세션이 파일 읽기 하나를 그냥 문다.
  useEffect(() => {
    if (leftTab === "history") void refreshSnapshots();
  }, [leftTab, refreshSnapshots]);

  const saveSnapshot = () =>
    askPrompt({
      title: "스냅샷 저장",
      // 상한을 넘기면 41 이 **가장 오래된 것부터 말없이 버린다** — 그 사실을 여기서 알린다.
      label: "지금 상태를 이름 붙여 남깁니다. 되돌리기 목록에서 밀려나도 남고, 20개를 넘으면 오래된 것부터 지워집니다.",
      defaultValue: "1차 검토본",
      confirmLabel: "저장",
      onConfirm: (name) => {
        void (async () => {
          await persistRef.current?.saveSnapshot(name);
          await refreshSnapshots();
        })();
      },
    });

  // ── 원본 로드 ──
  useEffect(() => {
    if (!projectId || !path) return;
    let alive = true;
    setImg(null);
    setLoadErr(null);
    void (async () => {
      try {
        const { mime, base64, stamp } = await ipc.readFileBase64(projectId, path);
        const image = await loadImage(`data:${mime};base64,${base64}`);
        if (!image.naturalWidth || !image.naturalHeight) {
          throw new Error("이미지 크기를 확인할 수 없습니다 (지원되지 않는 형식일 수 있음)");
        }
        // 입력 상한 — 없으면 캔버스 한계를 넘겨 **빈 화면**이 되거나 조용히 죽는다.
        // 저장 방향에는 이미 상한이 둘 있는데(MAX_OUTPUT_DIM, Rust 의 64MB) 로드 방향만
        // 비어 있었다. 8K(33MP)는 통과하고 초대형 스캔본을 막는 선이다.
        const mp = image.naturalWidth * image.naturalHeight;
        if (
          image.naturalWidth > MAX_OUTPUT_DIM ||
          image.naturalHeight > MAX_OUTPUT_DIM ||
          mp > MAX_INPUT_PIXELS
        ) {
          throw new Error(
            `이미지가 너무 큽니다 (${image.naturalWidth}×${image.naturalHeight}) — ` +
              `한 변 ${MAX_OUTPUT_DIM}px · 총 ${Math.round(MAX_INPUT_PIXELS / 1e6)}백만 화소까지 편집할 수 있습니다`,
          );
        }
        if (alive) {
          // 이 스탬프가 "내가 편집을 시작한 그 파일"의 정체다. 저장할 때 되돌려 주면
          // 그 사이 남이 바꿨는지 Rust 가 판정한다(무성 덮어쓰기 방지).
          stampRef.current = stamp ?? null;
          setImg(image);
          setFormat(formatOfPath(path) ?? "png");
        }
      } catch (e) {
        if (alive) setLoadErr(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, path]);

  // 새 이미지가 들어오면 문서와 히스토리를 통째로 초기화한다.
  useEffect(() => {
    if (!img) return;
    const d: EditorDoc = {
      ...EMPTY_DOC,
      outW: img.naturalWidth,
      outH: img.naturalHeight,
    };
    docRef.current = d;
    histRef.current.reset(d);
    setDoc(d);
    setHistVer((v) => v + 1);
    uiReset();

    // 사이드카에 저장해 둔 편집 문서를 **자동으로** 되살린다(41 §3.3). v1 은 창 수명 stash 에
    // 넣고 배너로 물었는데, 그건 창을 닫으면 사라지는 임시 보관이었다. 이제 파일로 남으므로
    // 물어볼 이유가 없다 — 닫아도 잃는 것이 없다.
    let alive = true;
    void (async () => {
      const restored = await persistRef.current
        ?.load(stampRef.current, img.naturalWidth, img.naturalHeight)
        .catch(() => null);
      if (!alive || !restored) return;
      const next = restored.imageChanged
        ? // 원본이 바뀌었으면 크롭·출력 크기는 새 이미지 기준으로 되돌린다 — 낡은 crop 으로
          // 저장하면 엉뚱한 영역이 잘려 나간다(조용한 데이터 손실).
          { ...restored.doc, crop: null, outW: img.naturalWidth, outH: img.naturalHeight }
        : restored.doc;
      docRef.current = next;
      histRef.current.reset(next, "이미지 열기", restored.log);
      setDoc(next);
      setHistVer((v) => v + 1);
      setImageChanged(restored.imageChanged);
      // 되돌린 crop 을 사이드카에도 반영한다 — 저장하지 않으면 열 때마다 같은 배너가 뜬다.
      if (restored.imageChanged) persistRef.current?.markDirty();
    })();
    return () => {
      alive = false;
    };
  }, [img, projectId, path]);

  const { rotation, flipH, flipV, crop, outW, outH, brightness, contrast, saturate } =
    doc;
  const { straighten } = doc;
  const filterStr = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturate}%)`;

  // 회전·반전·직선화가 적용된 캔버스(메모) — 방향이 바뀌면 새 정체성을 갖는다. 직선화는
  // `buildOriented` **가장 안쪽**이라 여기 아래(프리뷰 백킹·출력·90° 델타)는 전부 무변경이다:
  // 그것들은 캔버스의 크기와 픽셀만 보고 어떻게 만들어졌는지는 모른다(48 §3.2).
  const oriented = useMemo(
    () => (img ? buildOriented(img, rotation, flipH, flipV, straighten) : null),
    [img, rotation, flipH, flipV, straighten],
  );

  // ── 캔버스 크기 계산(두 캔버스가 항상 같은 값을 쓴다, §4.3) ────────────────
  const previewScale = oriented
    ? Math.min(1, MAX_PREVIEW / Math.max(oriented.width, oriented.height))
    : 1;
  const backW = oriented ? Math.max(1, Math.round(oriented.width * previewScale)) : 1;
  const backH = oriented ? Math.max(1, Math.round(oriented.height * previewScale)) : 1;

  // 표시 크기는 JS로 계산한다 — 두 캔버스를 겹치려면 절대배치가 필요한데, 절대배치된
  // 캔버스에는 max-width/height 백분율이 먹지 않기 때문(둘의 크기가 어긋나면 좌표가 깨진다).
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit =
    oriented && stage.w > 0 && stage.h > 0
      ? Math.min(1, stage.w / oriented.width, stage.h / oriented.height)
      : 0;
  const dispW = oriented ? Math.max(1, Math.round(oriented.width * fit)) : 0;
  const dispH = oriented ? Math.max(1, Math.round(oriented.height * fit)) : 0;
  const displayScale = oriented && fit > 0 ? dispW / oriented.width : 1;
  const showStage = !!oriented && fit > 0;
  /** 화면에 실제로 보이는 배율(맞춤 × 줌) — 주석 레이어가 화면 상수를 계산하는 근거값이다. */
  const screenScale = displayScale * view.scale;

  /**
   * oriented → stage css px(43 §3.2). **`getBoundingClientRect` 를 쓰지 않는다** — 팬·줌
   * 프레임마다 강제 레이아웃을 부르는 셈이고, 그 값은 이미 여기 다 있다.
   *
   * `x`/`y` 는 이미지 원점의 stage 안 위치다. stage 는 flex 중앙 정렬 + `p-4` 인데
   * `clientWidth` 가 패딩을 포함하므로 `16 + (clientW − 32 − dispW)/2 = (clientW − dispW)/2` 로
   * 패딩이 상쇄된다 — 패딩을 바꾸면 이 식이 아니라 **상수 16 두 개**가 어긋난다.
   */
  const screen = useMemo<ChromeScreen>(
    () => ({
      scale: screenScale,
      x: (stage.w - dispW) / 2 + view.x,
      y: (stage.h - dispH) / 2 + view.y,
      w: stage.w,
      h: stage.h,
      ow: oriented?.width ?? 0,
      oh: oriented?.height ?? 0,
    }),
    [dispH, dispW, oriented, screenScale, stage.h, stage.w, view.x, view.y],
  );

  // 방향(회전·반전)이 바뀌거나 새 이미지가 들어오면 맞춤으로 되돌린다. 옛 방향에서 쌓은 팬
  // 오프셋은 그 순간 의미가 없어져 이미지가 화면 밖으로 튀어나간다.
  //
  // **`oriented` 자체를 의존성으로 두면 안 된다**(48 §3.2): 직선화는 틱마다 새 캔버스를 만드는데
  // 그때마다 맞춤으로 튀면 확대해서 수평을 맞추는 조작 자체가 불가능하다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setView(IDENTITY_VIEW), [img, rotation, flipH, flipV]);

  // 휠 = 줌. **non-passive 로 직접 등록해야 한다** — React 의 onWheel 은 passive 라
  // preventDefault 가 무시되고 WebView2 가 페이지째 확대해 버린다(ImageView 와 같은 이유).
  // ctrlKey 도 함께 받으므로 트랙패드 핀치가 배선 없이 붙는다.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const box = boxRef.current;
      if (!box) return;
      e.preventDefault();
      const r = box.getBoundingClientRect(); // 앵커는 변환 밖이라 view 와 무관하게 안정적이다
      const factor = Math.pow(WHEEL_STEP, -e.deltaY / 100);
      setView((v) => zoomAt(v, e.clientX - r.left, e.clientY - r.top, factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 팬은 **가운데 버튼 드래그**, 그리고 **손 도구의 좌드래그**다(42 §3.5 `button===1 || hand`).
  // 평소 좌버튼은 주석 레이어가 그리기·선택·이동·리사이즈·크롭에 전부 쓰지만, 손 도구일 때는
  // 레이어가 pointerdown 을 캡처도 처리도 하지 않고 버블시킨다(`annotation/pointer.ts`) —
  // 여기서 `button===1` 만 보면 그 이벤트가 조용히 버려져 손 도구·Space 홀드가 한 픽셀도
  // 움직이지 않는다(커서만 grab 이라 잡히는 것처럼 보인다).
  // 크롭은 모드가 도구를 이기므로(§3.2) 그때 좌버튼은 크롭 사각형 것이다.
  const panFrom = useRef<{ x: number; y: number } | null>(null);
  const onStagePointerDown = (e: React.PointerEvent) => {
    const byHand = e.button === 0 && tool === "hand" && !cropMode;
    if (e.button !== 1 && !byHand) return;
    e.preventDefault(); // 가운데 버튼 오토스크롤 · 손 드래그 중 텍스트 선택 차단
    panFrom.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onStagePointerMove = (e: React.PointerEvent) => {
    const from = panFrom.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    panFrom.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const endPan = (e: React.PointerEvent) => {
    if (!panFrom.current) return;
    panFrom.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };

  orientedRef.current = oriented ?? null;
  filterStrRef.current = filterStr;

  // 유효 소스(크롭이 있으면 크롭, 아니면 방향 캔버스) — 리사이즈 비율 기준.
  const effW = crop ? crop.w : oriented?.width ?? 0;
  const effH = crop ? crop.h : oriented?.height ?? 0;

  // ── 방향 변경(§3.2) — 주석 기하를 새 oriented 공간으로 함께 옮긴다 ─────────
  //
  // 여기서만 델타를 적용한다. 예전처럼 `oriented` 변경 효과에 얹으면 undo/redo 로 rotation 이
  // 복원될 때도 효과가 돌아 **델타가 두 번 걸린다** — 스냅샷의 objects 는 이미 그 공간이다.

  /**
   * 반전이 홀수 개 걸려 있으면 화면 기준 회전 방향이 뒤집힌다(buildOriented 가 회전 후
   * 이미지 공간에서 반전하기 때문). 실측으로 확인한 관계다.
   */
  //
  // `oriented` 를 **ref 로 읽는다**: 액션 맵(45)이 이 둘을 stable 하게 물고 있어서, 렌더 값을
  // 잡으면 첫 렌더(이미지가 아직 null)의 클로저가 굳어 회전·반전이 영영 조용히 no-op 이 된다.
  const rotateBy = useCallback(
    (plus90: boolean) => {
      const base = orientedRef.current;
      if (!base) return;
      const d = docRef.current;
      const mirrored = d.flipH !== d.flipV;
      const delta: OrientDelta = plus90 !== mirrored ? "rotCW" : "rotCCW";
      patchDoc({
        rotation: (d.rotation + (plus90 ? 90 : 270)) % 360,
        objects: transformObjects(d.objects, delta, base.width, base.height),
        crop: null,
        outW: base.height,
        outH: base.width,
      });
    },
    [patchDoc],
  );

  const flipBy = useCallback(
    (axis: "h" | "v") => {
      const base = orientedRef.current;
      if (!base) return;
      const d = docRef.current;
      const objects = transformObjects(
        d.objects,
        axis === "h" ? "flipH" : "flipV",
        base.width,
        base.height,
      );
      patchDoc({
        ...(axis === "h" ? { flipH: !d.flipH } : { flipV: !d.flipV }),
        objects,
        crop: null,
        outW: base.width,
        outH: base.height,
      });
    },
    [patchDoc],
  );

  // ── 크롭 세션(48) ─────────────────────────────────────────────────────────
  //
  // 세션은 모드가 열고 닫는다 — 이 훅이 `mode.kind` 를 스스로 구독하므로 여기서 진입·취소를
  // 다시 부르지 않는다. 세션 중 문서 변경은 전부 `replace` 라 히스토리는 0칸이고, 커밋은
  // ⏎ 적용 한 번이다(§3.1).
  const { session: cropSession, api: cropApi } = useCropSession({
    docRef,
    applyDoc,
    oriented,
    img,
    ui: useImageEditorUi.getState(),
  });
  cropSessionRef.current = cropSession;

  const clearCrop = () => {
    if (!oriented) return;
    patchDoc({ crop: null, outW: oriented.width, outH: oriented.height });
  };

  // ── 가이드·스냅(눈금자 띠와 e2e 훅이 쓰는 쪽) ──────────────────────────────

  /**
   * 스냅 인덱스 캐시. 눈금자에서 가이드를 끌 때 `snapForGuide` 가 **매 move** 불리는데,
   * 그때마다 인덱스를 다시 만들면 텍스트 노드가 프레임마다 `measureText` 를 탄다(43 §3.4).
   * 문서·가이드·토글 중 하나라도 바뀌면 버린다 — 셋 다 그대로면 후보도 그대로다.
   */
  const snapIdxRef = useRef<{
    objects: readonly Node[];
    guides: EditorDoc["guides"];
    toggles: unknown;
    idx: SnapIndex;
  } | null>(null);

  const snapIndexNow = useCallback((): SnapIndex | null => {
    const img = orientedRef.current;
    if (!img) return null;
    const d = docRef.current;
    const t = useImageEditorUi.getState().toggles;
    const c = snapIdxRef.current;
    if (c && c.objects === d.objects && c.guides === d.guides && c.toggles === t) {
      return c.idx;
    }
    const idx = buildSnapIndex(resolveScene(d), new Set(), d.guides, {
      gridPx: t.grid,
      pixel: t.snapPixel,
      objects: t.snapObjects,
      guides: t.snapGuides && t.guidesVisible,
      canvas: { x: 0, y: 0, w: img.width, h: img.height },
    });
    snapIdxRef.current = { objects: d.objects, guides: d.guides, toggles: t, idx };
    return idx;
  }, []);

  /** 눈금자에서 끌어내는 중의 스냅. **순수·동기**여야 한다(매 move 불린다). */
  const snapForGuide = (axis: "x" | "y", pos: number): number => {
    const u = useImageEditorUi.getState();
    if (!u.toggles.snap) return pos;
    const idx = snapIndexNow();
    if (!idx) return pos;
    // 가이드는 축 하나만 붙는다 — 반대 축 좌표는 후보에 영향을 주지 않는다.
    const r = snapPoint(
      idx,
      axis === "x" ? { x: pos, y: 0 } : { x: 0, y: pos },
      u.snapThresholdCss / Math.max(screenScale, 1e-6),
    );
    return pos + (axis === "x" ? r.dx : r.dy);
  };

  // ── 크롭 드래그(포인터는 주석 캔버스가 받아 여기로 위임한다) ────────────────
  //
  // 세션 사각형을 아는 쪽이 여기뿐이라 기하도 여기 있다. 포인터 파일은 "무엇을 잡았나"
  // (`hitCropHandle`)와 수식자(`cropDragMods`)만 준다 — 두 곳이 각자 계산하면 보이는 상자와
  // 저장되는 영역이 갈린다.
  const cropDragRef = useRef<
    | { kind: "resize"; handle: number; base: Rect }
    | { kind: "move"; start: { x: number; y: number }; base: Rect }
    | { kind: "draw"; start: { x: number; y: number } }
    | null
  >(null);
  const cropLiveRef = useRef<Rect | null>(null);

  /** 이번 드래그가 쓰는 경계·비율 — 세션과 **같은 함수**(crop.ts)에서만 나온다. */
  const cropGeom = useCallback(() => {
    const s = cropSessionRef.current;
    const base = orientedRef.current;
    if (!s || !base || !img) return null;
    const d = docRef.current;
    return {
      rect: s.rect,
      bounds: cropBounds(s, img.naturalWidth, img.naturalHeight, d.rotation, {
        w: base.width,
        h: base.height,
      }),
      aspect: aspectRatioOf(s.aspect, img.naturalWidth, img.naturalHeight, d.rotation),
    };
  }, [img]);

  /**
   * 크롭도 다른 드래그와 같은 스냅을 탄다 — 안 걸면 크롭만 격자·가이드를 무시한다.
   * Alt 는 "정확히 여기"라는 뜻이라 저항을 없앤다(`applyDragAt` 과 같은 규칙).
   */
  const snapCropPoint = (p: { x: number; y: number }, alt: boolean) => {
    const u = useImageEditorUi.getState();
    if (alt || !u.toggles.snap) return p;
    const idx = snapIndexNow();
    if (!idx) return p;
    const r = snapPoint(idx, p, u.snapThresholdCss / Math.max(screenScale, 1e-6));
    return { x: p.x + r.dx, y: p.y + r.dy };
  };

  const onCropDown = useCallback(
    (p: { x: number; y: number }) => {
      cropLiveRef.current = null;
      layerRef.current?.setCropPreview(null);
      const g = cropGeom();
      if (!g) {
        cropDragRef.current = null;
        return;
      }
      // 히트 순서는 핸들 → 안 → 밖이다(§3.3). 핸들이 사각형 안쪽 경계에 걸쳐 있어서
      // 안쪽 판정을 먼저 하면 모서리를 잡아도 통째로 끌린다.
      const h = hitCropHandle(g.rect, p, HANDLE_GRAB_CSS / Math.max(screenScale, 1e-6));
      if (h >= 0) cropDragRef.current = { kind: "resize", handle: h, base: g.rect };
      else if (
        p.x >= g.rect.x &&
        p.x <= g.rect.x + g.rect.w &&
        p.y >= g.rect.y &&
        p.y <= g.rect.y + g.rect.h
      ) {
        cropDragRef.current = { kind: "move", start: p, base: g.rect };
      } else cropDragRef.current = { kind: "draw", start: p };
    },
    [cropGeom, screenScale],
  );

  const onCropMove = useCallback(
    (p: { x: number; y: number }) => {
      const d = cropDragRef.current;
      const g = cropGeom();
      if (!d || !g) return;
      const m = cropDragMods();
      let r: Rect;
      if (d.kind === "resize") {
        r = resizeCropRect(d.base, d.handle, snapCropPoint(p, m.alt), {
          aspect: g.aspect,
          bounds: g.bounds,
          shift: m.shift,
        });
      } else if (d.kind === "move") {
        // 크기는 그대로, 위치만 — `fitAspect` 에 비율 null 을 주면 정수 반올림 + 경계
        // 클램프만 남는다(같은 규칙을 두 번 쓰지 않는다).
        r = fitAspect(
          { ...d.base, x: d.base.x + (p.x - d.start.x), y: d.base.y + (p.y - d.start.y) },
          null,
          g.bounds,
        );
      } else {
        const q = snapCropPoint(p, m.alt);
        r = fitAspect(
          normalizeRect(d.start.x, d.start.y, q.x, q.y),
          g.aspect ?? (m.shift ? 1 : null),
          g.bounds,
        );
      }
      cropLiveRef.current = r;
      layerRef.current?.setCropPreview(r);
    },
    [cropGeom, screenScale],
  );

  /** Esc 로 드래그가 취소되면 상태와 라이브 사각형을 버린다 — 남아 있으면 버튼을 떼는 순간 확정된다. */
  const onCropCancel = useCallback(() => {
    cropDragRef.current = null;
    cropLiveRef.current = null;
    layerRef.current?.setCropPreview(null);
  }, []);

  const onCropUp = useCallback(() => {
    const d = cropDragRef.current;
    cropDragRef.current = null;
    const r = cropLiveRef.current;
    cropLiveRef.current = null;
    layerRef.current?.setCropPreview(null);
    // 상태가 없다 = Esc 로 취소된 드래그다. 세션에 반영하지 않는다(§5.4 계층 3).
    if (!d || !r) return;
    // 빈 곳에서 시작한 새 사각형만 최소 크기를 본다 — 클릭 오조작이 사각형을 1px 로
    // 줄여 버리면 되돌릴 방법이 세션 취소뿐이다. 핸들·이동은 항상 유효한 값에서 출발한다.
    if (d.kind === "draw" && (r.w < 4 || r.h < 4)) return;
    cropApi.cropSet({ rect: r });
  }, [cropApi]);

  // 타이핑 한 글자마다 히스토리를 쌓지 않도록 슬라이더와 같은 라이브 규칙을 쓴다(blur 에서 끝).
  const changeW = (v: number) => {
    const w = Math.max(1, Math.round(v || 0));
    patchLive({
      outW: w,
      outH: lockRatio && effW > 0 ? Math.max(1, Math.round((w * effH) / effW)) : outH,
    });
  };
  const changeH = (v: number) => {
    const h = Math.max(1, Math.round(v || 0));
    patchLive({
      outH: h,
      outW: lockRatio && effH > 0 ? Math.max(1, Math.round((h * effW) / effH)) : outW,
    });
  };

  /** 모든 편집을 되돌린다 — 주석은 지우지 않고 원래 방향의 좌표로 되돌린다. */
  const resetAll = () => {
    if (!img || !oriented) return;
    const d = docRef.current;
    let objs: readonly Node[] = d.objects;
    let w = oriented.width;
    let h = oriented.height;
    if (d.flipH) objs = transformObjects(objs, "flipH", w, h);
    if (d.flipV) objs = transformObjects(objs, "flipV", w, h);
    // 반전을 걷어낸 뒤에는 화면 회전 방향이 뒤집히지 않는다 — 남은 회전만큼 CCW로 되돌린다.
    for (let r = d.rotation; r > 0; r -= 90) {
      objs = transformObjects(objs, "rotCCW", w, h);
      const t = w;
      w = h;
      h = t;
    }
    // 직선화는 `buildOriented` 의 **가장 안쪽**이라 가장 나중에 푼다(48 §3.2). 반전은 이미
    // 걷혔으므로 부호 뒤집기(mirrored)가 없다.
    if (d.straighten !== 0) {
      objs = straightenObjects(
        objs,
        d.straighten,
        0,
        { w, h },
        { w: img.naturalWidth, h: img.naturalHeight },
        false,
      );
    }
    patchDoc({
      objects: objs.slice(),
      rotation: 0,
      flipH: false,
      flipV: false,
      straighten: 0,
      crop: null,
      outW: img.naturalWidth,
      outH: img.naturalHeight,
      brightness: 100,
      contrast: 100,
      saturate: 100,
    });
    setCropMode(false);
  };

  // ── 도구 기본 스타일 ──────────────────────────────────────────────────────

  // 객체 하나를 고르면 그 속성이 **다음에 그릴 것의 기본값**이 된다(v1 툴바 규칙 승계).
  // 인스펙터는 노드를 직접 읽으므로 이 동기화는 레일 스와치·드래프트 색에만 쓰인다.
  useEffect(() => {
    if (selectedIds.length !== 1) return;
    const o = docRef.current.objects.find((x) => x.id === selectedIds[0]);
    if (!o) return;
    // 뱃지·텍스트는 "색"이 채우기 슬롯에 있다 — 드래프트가 읽는 strokes 자리로 옮겨 둔다
    // (`annotation/pointer.ts` 의 `newTextNode({ fills: style.strokes })` 와 짝이다).
    const p = paintOf(o);
    setStyle((s) => ({
      ...s,
      ...p,
      strokes:
        o.kind === "badge" || o.kind === "text"
          ? p.fills.length
            ? p.fills
            : s.strokes
          : p.strokes.length
            ? p.strokes
            : s.strokes,
      fills: o.kind === "rect" || o.kind === "ellipse" ? p.fills : s.fills,
      strokeWidth: o.strokeWidth || s.strokeWidth,
    }));
    setOpacity(o.opacity);
  }, [selectedIds]);

  // ── 출력 ──────────────────────────────────────────────────────────────────

  /**
   * 모든 편집을 적용한 최종 출력 캔버스(크롭 → 리사이즈 → 색보정 → 주석, §4.2).
   * @param opaqueBg 투명을 흰색으로 채운다(비투명 포맷 저장용). 클립보드 복사는 항상 false.
   */
  const renderOutput = (opaqueBg = format === "jpeg"): HTMLCanvasElement => {
    const base = oriented!;
    const d = docRef.current;
    const sw = d.crop ? d.crop.w : base.width;
    const sh = d.crop ? d.crop.h : base.height;
    const outW = Math.max(1, Math.round(d.outW || sw));
    const outH = Math.max(1, Math.round(d.outH || sh));
    if (outW > MAX_OUTPUT_DIM || outH > MAX_OUTPUT_DIM) {
      throw new Error(`출력 크기가 너무 큽니다 (한 변 ${MAX_OUTPUT_DIM}px 초과)`);
    }
    // 이미지·조정·주석이 **프리뷰와 같은 renderScene** 을 지난다. 큰 출력은 타일로 그려
    // 작업 메모리가 출력 크기에 비례해 늘지 않는다(태스크 40 §3.3).
    // jpeg/avif 등 비투명 포맷은 흰 바탕을 배경으로 준다(투명이 검게 나오지 않게).
    return renderOutputTiled(resolveScene(d), {
      crop: d.crop,
      outW,
      outH,
      background: opaqueBg ? "#ffffff" : "image",
      filter: filterStr,
      image: base,
      store: storeRef.current,
    });
  };

  const dir = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const baseNoExt = (() => {
    if (!path) return "image";
    const b = path.split("/").pop() ?? path;
    const d = b.lastIndexOf(".");
    return d > 0 ? b.slice(0, d) : b;
  })();

  /**
   * @param ignoreStamp 외부 변경 확인창에서 "그래도 저장"을 누른 재시도. 스탬프를 빼야
   *   같은 CONFLICT 가 무한 반복되지 않는다.
   */
  const writeTo = (relPath: string, overwrite: boolean, ignoreStamp = false) => {
    if (!oriented || !projectId) return;
    // 스탬프는 **읽은 그 파일에 제자리로 쓸 때만** 의미가 있다. 다른 이름으로 저장은 대상이
    // 다른 파일이라 이 스탬프와 아무 관계가 없다 — 붙이면 항상 충돌한다.
    const stamp =
      !ignoreStamp && relPath === path ? stampRef.current ?? undefined : undefined;
    setBusy(true);
    // renderOutput()은 동기지만 encodeCanvas는 avif에서 wasm을 동적 로드하므로 프라미스로 처리.
    // 에셋 디코드를 먼저 끝낸다 — 안 그러면 회색 자리가 저장 파일에 그대로 굳는다(39 §3.6).
    void ensureAssets(docRef.current)
      .then(() => encodeCanvas(renderOutput(), format, quality))
      .then((bytes) => {
        const base64 = bytesToBase64(bytes);
        saveImage.mutate(
          { relPath, base64, overwrite, expectedStamp: stamp },
          {
            onSuccess: () => {
              // 열어 둔 **그 파일**에 구웠을 때만 편집 문서를 버린다 — 레이어가 이미지에
              // 들어갔으므로 다시 열 때 복원하면 주석이 두 겹이 된다. '다른 이름으로'는
              // 원본이 한 바이트도 안 바뀌었으니 문서를 살려 둔다(41 §3.3 R8).
              if (projectId && path && relPath === path) {
                void persistRef.current?.deleteDoc();
              }
              pushToast("success", `저장됨 — ${relPath.split("/").pop()}`);
              close();
            },
            onError: (e) => {
              // 기존 파일 충돌 → 덮어쓰기 확인 후 재시도(데이터 손실 방지).
              if (isIpcError(e) && e.code === "ALREADY_EXISTS") {
                askConfirm({
                  title: "덮어쓰기",
                  message: `'${relPath.split("/").pop()}' 파일이 이미 있습니다. 덮어쓸까요?`,
                  detail: relPath,
                  confirmLabel: "덮어쓰기",
                  danger: true,
                  onConfirm: () => writeTo(relPath, true, ignoreStamp),
                });
              } else if (isIpcError(e) && e.code === "CONFLICT") {
                // 편집을 시작한 뒤 남이 그 파일을 바꿨다. 종전에는 이 저장이 그 변경을
                // **말없이** 날렸다. 재시도는 반드시 ignoreStamp 로 — 안 그러면 무한 반복.
                askConfirm({
                  title: "외부에서 변경됨",
                  message:
                    "편집을 시작한 뒤 이 파일이 다른 곳에서 바뀌었습니다. 저장하면 그 변경을 덮어씁니다.",
                  detail: relPath,
                  confirmLabel: "그래도 저장",
                  danger: true,
                  onConfirm: () => writeTo(relPath, overwrite, true),
                });
              } else {
                pushToast("error", errorMessage(e));
              }
            },
            onSettled: () => setBusy(false),
          },
        );
      })
      .catch((e) => {
        pushToast("error", errorMessage(e));
        setBusy(false);
      });
  };

  // "저장": 원본 포맷 그대로면 연 파일을 덮어쓴다(의도된 in-place). 포맷을 바꿨으면 새 형제
  // 파일이 되므로 덮어쓰기는 충돌 확인을 거친다.
  // 주석이 있으면 평탄화가 **비가역**이므로(원본 픽셀도 벡터 문서도 사라진다) 확인을 받는다(§6.1).
  //
  // in-place 판정은 **포맷**으로 한다 — 확장자 문자열로 비교하면 안 된다. extOf 는 언제나
  // 정규 확장자 하나만 돌려주므로(jpeg→jpg) `사진.jpeg`·`사진.PNG` 같은 원본은 대상이
  // `사진.jpg`·`사진.png` 가 되어 자기 자신과 불일치한다 → overwrite=false 로 나가서
  // 원본은 그대로 둔 채 형제 파일만 만들거나(.jpeg), 없는 충돌로 덮어쓰기 확인창을 띄운다
  // (대소문자 무시 파일시스템). "덮어쓰기 예를 눌렀는데 원본이 안 바뀐다"의 원인이었다.
  const saveInPlace = () => {
    const inPlace = path !== null && formatOfPath(path) === format;
    const targetPath = inPlace ? path : `${dir}${baseNoExt}.${extOf(format)}`;
    const go = () => writeTo(targetPath, inPlace);
    if (doc.objects.length) {
      askConfirm({
        title: "레이어를 이미지에 굽기",
        message: inPlace
          ? "주석이 이미지에 합쳐져 원본을 덮어씁니다. 벡터 편집 정보는 남지 않습니다."
          : "주석이 합쳐진 새 파일로 저장됩니다(원본은 그대로). 벡터 편집 정보는 남지 않습니다.",
        detail: targetPath,
        confirmLabel: "합쳐서 저장",
        danger: true,
        onConfirm: go,
      });
    } else {
      go();
    }
  };

  const saveAs = () =>
    askPrompt({
      title: "다른 이름으로 저장",
      label: "같은 폴더에 저장됩니다.",
      // 주석이 있으면 원본을 건드리지 않는 이름을 기본값으로 — 안전한 쪽이 기본 경로다(§6.1).
      defaultValue: `${baseNoExt}${doc.objects.length ? "-annotated" : ""}.${extOf(format)}`,
      confirmLabel: "저장",
      validate: (v) => {
        const t = v.trim();
        if (!t) return "이름을 입력하세요";
        if (/[\\/]/.test(t)) return "이름에 경로 구분자를 쓸 수 없습니다";
        if (t === "." || t === ".." || t.includes("..")) return "잘못된 이름입니다";
        return null;
      },
      onConfirm: (name) => writeTo(`${dir}${name}`, false),
    });

  /** 편집 결과를 PNG로 클립보드에 넣는다(§6.2). 파일 저장 포맷과 무관하게 항상 PNG. */
  const copyToClipboard = () => {
    if (!oriented) return;
    setBusy(true);
    void ensureAssets(docRef.current)
      .then(() => encodeCanvas(renderOutput(false), "png"))
      .then((bytes) => writeImage(bytes))
      .then(() => pushToast("success", "클립보드에 복사됨 (PNG)"))
      .catch((e) => pushToast("error", errorMessage(e)))
      .finally(() => setBusy(false));
  };

  /**
   * 레일 '이미지' — 파일을 골라 캔버스 가운데에 놓는다(42 §3.5 · §3.4 "레일 클릭이 대신").
   *
   * 도구 상태로 남지 않는 **한 번의 동작**이다: `setTool('image')` 로 두면 그 뒤 캔버스
   * 클릭·드래그가 전부 조용한 no-op 이 된다(드래프트를 만들 수 있는 도구가 아니다).
   * 취소하면 `assetPickFile` 이 null 이라 문서를 건드리지 않는다 — 빈 히스토리 항목이 남으면
   * Ctrl+Z 가 아무 일도 안 하는 것처럼 보인다.
   */
  const placeImage = useCallback(() => {
    void (async () => {
      try {
        const picked = await ipc.assetPickFile();
        if (!picked) return;
        const d = docRef.current;
        const got = await acquireAsset(d, picked);
        // 원본 크기로 놓되 캔버스를 넘으면 줄인다 — 20MP 스크린샷을 200px 그림 위에 원본
        // 크기로 놓으면 화면 어디에도 안 보인다(붙여넣기와 같은 규칙).
        const fit = Math.min(1, d.outW / got.w, d.outH / got.h);
        const w = Math.max(1, Math.round(got.w * fit));
        const h = Math.max(1, Math.round(got.h * fit));
        const node = newImageNode({
          x: Math.round((d.outW - w) / 2),
          y: Math.round((d.outH - h) / 2),
          w,
          h,
          assetId: got.id,
          opacity,
        });
        applyDoc(
          { ...d, assets: got.assets, objects: [...d.objects, node] },
          "commit",
          "이미지 배치",
        );
        setSelectedIds([node.id]);
      } catch (err) {
        pushToast("error", errorMessage(err));
      }
    })();
  }, [applyDoc, opacity, pushToast, setSelectedIds]);

  // ── 닫기 · Esc 계층(§5.4) ─────────────────────────────────────────────────


  /**
   * 닫기 — 확인하지 않는다. 편집 문서는 사이드카에 남고 다음에 열 때 그대로 돌아온다.
   * 저장에 실패했을 때만(충돌·IO) 물어본다 — 그때는 진짜로 잃을 수 있기 때문이다.
   */
  const requestClose = useCallback(() => {
    if (busyRef.current) return;
    // 크롭 세션 중이면 **먼저 되돌린다**(48 §6). 세션 문서는 아직 적용된 적 없는 라이브 값인데,
    // 그대로 flush 하면 다음에 열었을 때 누른 적 없는 직선화·크롭이 걸린 채로 뜬다.
    cropApi.cropCancel();
    void (async () => {
      await persistRef.current?.flush();
      if (persistRef.current?.state === "error") {
        askConfirm({
          title: "편집 문서를 저장하지 못했습니다",
          message:
            "이 창의 편집 내용을 파일로 남기지 못했습니다. 그래도 닫으면 마지막 저장 이후 변경분을 잃습니다.",
          confirmLabel: "그래도 닫기",
          danger: true,
          onConfirm: close,
        });
        return;
      }
      close();
    })();
  }, [askConfirm, close, cropApi]);

  /**
   * doc 창의 X(FloatTitleBar → `win.close()`)는 편집기의 닫기 가드를 지나지 않는다 —
   * 창이 그냥 사라진다. 이제 잃을 것은 "마지막 디바운스가 아직 안 쓴 변경분"뿐이므로,
   * **확인 대신 flush** 한다. 저장에 실패했을 때만 물어본다.
   *
   * `destroy()` 를 부르는 이유: `close()` 는 CloseRequested 를 다시 발화시켜 무한 루프가 된다.
   * Rust 쪽 CloseRequested 핸들러는 `main` 라벨만 다루므로 간섭 없다.
   */
  useEffect(() => {
    if (!IS_DOC_WINDOW) return;
    const win = getCurrentWebviewWindow();
    let off: (() => void) | undefined;
    let dead = false;
    void win
      .onCloseRequested((e) => {
        const p = persistRef.current;
        if (!p || p.state === "clean") return;
        e.preventDefault();
        // `requestClose` 와 같은 이유 — 적용하지 않은 크롭 세션을 사이드카에 쓰지 않는다.
        cropApi.cropCancel();
        void (async () => {
          await p.flush();
          if (persistRef.current?.state === "error") {
            askConfirm({
              title: "편집 문서를 저장하지 못했습니다",
              message:
                "이 창의 편집 내용을 파일로 남기지 못했습니다. 그래도 닫으면 마지막 저장 이후 변경분을 잃습니다.",
              confirmLabel: "그래도 닫기",
              danger: true,
              onConfirm: () => void win.destroy(),
            });
            return;
          }
          void win.destroy();
        })();
      })
      .then((f) => {
        if (dead) f();
        else off = f;
      })
      .catch(() => {
        /* 창 API 를 못 쓰는 환경 — 종전과 같이 그냥 닫힌다 */
      });
    return () => {
      dead = true;
      off?.();
    };
  }, [askConfirm, cropApi]);

  // 붙여넣기 한 곳 — 객체(`gpv-anno:` 텍스트, 42 §3.4)와 이미지 파일(→ 에셋 + 이미지 채우기
  // 사각형, 41 §3.5)을 함께 받는다. Ctrl+V 는 단축키 표에 **없다**: 브라우저가 만드는 paste
  // 이벤트 하나가 같은 창·창 간 붙여넣기를 다 처리한다.
  // 상한 검사는 annotate/assets.ts 한 곳에만 있다 — 세 획득 경로가 각자 세면 언젠가
  // 한 곳이 빠지고, 그 경로로 들어온 파일이 사이드카 32MB 상한에서 저장을 통째로 막는다.
  useEffect(() => {
    /**
     * `gpv-anno:` 텍스트를 노드로 되돌린다. 규칙 셋이 전부 필수다:
     * **새 id**(같은 id 를 넣으면 트리 불변식이 즉시 터진다), **8px 오프셋**(없으면 원본에
     * 정확히 겹쳐 붙여넣기가 안 된 것처럼 보인다), **`parentId` 버리기**(복사원의 그룹은
     * 이 문서에 없어 부모가 앞에 없는 노드가 된다).
     * 남이 만든 문자열일 수 있으므로 경계는 `normalizeNode` 하나다.
     */
    const pasteNodes = (text: string) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text.slice(CLIP_PREFIX.length));
      } catch {
        return;
      }
      if (!Array.isArray(raw)) return;
      const added: Node[] = [];
      for (const item of raw) {
        const n = normalizeNode(item);
        if (!n) continue;
        const moved = isGeomNode(n)
          ? translateObject(n, DUPLICATE_OFFSET, DUPLICATE_OFFSET)
          : n;
        added.push({ ...moved, id: newObjId(), parentId: null });
      }
      if (!added.length) return;
      applyDoc(
        { ...docRef.current, objects: [...docRef.current.objects, ...added] },
        "commit",
        "붙여넣기",
      );
      setSelectedIds(added.map((o) => o.id));
    };

    const onPaste = (e: ClipboardEvent) => {
      const ui = useUi.getState();
      if (ui.prompt || ui.confirm) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return; // 텍스트 편집 중에는 글자가 붙어야 한다
      }
      // preventDefault 는 **여기서** 불러야 한다 — await 를 하나라도 지나면 이벤트가 이미
      // 끝나 기본 붙여넣기가 그대로 나간다.
      //
      // 객체 붙여넣기(§3.4)를 파일보다 **먼저** 본다: 우리가 복사한 노드도 클립보드에
      // 그림 파일이 함께 실려 오는 환경이 있어, 순서가 반대면 벡터가 비트맵으로 붙는다.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.startsWith(CLIP_PREFIX)) {
        e.preventDefault();
        pasteNodes(text);
        return;
      }
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      );
      if (!file) return;
      e.preventDefault();
      void (async () => {
        const doc = docRef.current;
        try {
          const got = await acquireFromFile(doc, file);
          // 이미지 밖으로 튀어나오지 않게 자연 크기를 캔버스 안에 맞춘다 — 20MP 스크린샷이
          // 200px 이미지 위에 붙으면 화면 어디에도 안 보인다.
          const fit = Math.min(1, doc.outW / got.w, doc.outH / got.h);
          const w = Math.max(1, Math.round(got.w * fit));
          const h = Math.max(1, Math.round(got.h * fit));
          const node = normalizeNode({
            id: newObjId(),
            kind: "rect",
            x: Math.round((doc.outW - w) / 2),
            y: Math.round((doc.outH - h) / 2),
            w,
            h,
            strokeWidth: 0,
            // Fill 은 flat 이다(Paint & {visible, blend}) — {paint:…} 로 감싸면 정규화가
            // type 을 못 찾아 solid 로 떨어진다.
            fills: [{ type: "image", assetId: got.id, mode: "fill", visible: true }],
          });
          if (!node) return;
          applyDoc(
            { ...doc, assets: got.assets, objects: [...doc.objects, node] },
            "commit",
            "이미지 붙여넣기",
          );
          setSelectedIds([node.id]);
        } catch (err) {
          pushToast("error", errorMessage(err));
        }
      })();
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [applyDoc, pushToast, setSelectedIds]);

  // ── 단축키 ────────────────────────────────────────────────────────────────
  //
  // 리스너는 `useEditorKeys` 하나뿐이다(window **capture**). 다른 태스크는 표(shortcuts.ts)에
  // 행을 넣고 이 맵에 핸들러를 더한다 — 리스너를 새로 달지 않는다. 여기 없는 id 는
  // `preventDefault` 도 안 되므로 앱 전역으로 그대로 흘러간다(먹통 키가 생기지 않는다).
  /**
   * 단축키·액션 맵이 보는 선택. **`'__base'`(배경 의사 id)를 여기서 걸러 낸다** — 렌더 쪽
   * `selectedIds`(:426)와 같은 규칙이다.
   *
   * 남겨 두면 배경만 고른 상태가 개수 1 이라 "선택 없음" 분기를 그냥 지나가는데, 정작 그 id 에
   * 맞는 노드는 하나도 없다. 결과는 조용한 두 가지 사고다: 스포이드로 뽑은 색이 기본 스타일
   * 에도 노드에도 안 들어가 **사라지고**(:1818 의 주석이 막으려던 상황), `patchDoc` 은 매번 새
   * doc 객체를 만들어 히스토리 단락(`next === cur.doc`)을 통과하므로 아무것도 안 바뀐 커밋이
   * 편집마다 한 칸씩 쌓이며 자동저장까지 예약한다(41 의 200칸을 갉아먹는다).
   */
  const selIds = (): ObjId[] =>
    useImageEditorUi
      .getState()
      .selectedIds.filter((id): id is ObjId => id !== "__base");

  /**
   * 선택 노드를 OS 클립보드에 텍스트로 쓴다. 복사한 개수를 돌려준다 — 잘라내기가 그 값으로
   * "지울 것이 있었나"를 판단한다. 자손은 담지 않는다(`duplicate` 와 같은 범위 — 컨테이너
   * 통째 복제는 44 몫이다).
   */
  const copySel = () => {
    const ids = new Set(selIds());
    const nodes = docRef.current.objects.filter((o) => ids.has(o.id));
    if (nodes.length) void copyText(CLIP_PREFIX + JSON.stringify(nodes));
    return nodes.length;
  };

  /**
   * 그룹·삭제는 레이어 패널 헤더 버튼(44 §3.3)과 단축키가 **같은 함수**를 쓴다. 따로 짜면
   * Ctrl+G 로 만든 그룹과 폴더 버튼으로 만든 그룹의 히스토리 라벨·선택 결과가 갈린다.
   *
   * `delete` 액션의 가이드 우선 분기(43)는 여기 **없다** — 패널 휴지통은 고른 노드를 지우는
   * 버튼이라, 가이드를 선택한 채 눌렀다고 가이드가 대신 사라지면 무슨 일이 났는지 알 수 없다.
   */
  const groupSel = (kind: "group" | "frame" = "group") => {
    const ids = selIds();
    // 그룹은 둘 이상, 프레임은 하나만으로도 감싼다(단축키 표의 `when` 이 그렇게 갈려 있다).
    if (kind === "group" ? ids.length < 2 : ids.length < 1) return;
    const r = treeGroup(docRef.current.objects, ids, kind);
    if (!r.id) return;
    patchDoc(
      { objects: r.objects },
      "commit",
      kind === "group" ? "그룹" : "프레임으로 감싸기",
    );
    setSelectedIds([r.id]);
  };

  const ungroupSel = () => {
    const ids = selIds();
    if (ids.length !== 1) return;
    patchDoc({ objects: treeUngroup(docRef.current.objects, ids[0]) }, "commit", "그룹 해제");
  };

  const removeSel = () => {
    const ids = selIds();
    if (!ids.length) return;
    patchDoc({ objects: treeRemove(docRef.current.objects, ids) }, "commit", "삭제");
    setSelectedIds([]);
  };

  const duplicateSel = () => {
    const ids = selIds();
    const copies: Node[] = [];
    for (const o of docRef.current.objects) {
      if (!ids.includes(o.id)) continue;
      // 컨테이너는 기하가 없다 — 자손째 복제는 레이어 패널(44)이 붙인다.
      copies.push(
        isGeomNode(o)
          ? { ...translateObject(o, DUPLICATE_OFFSET, DUPLICATE_OFFSET), id: newObjId() }
          : { ...o, id: newObjId() },
      );
    }
    if (!copies.length) return;
    patchDoc(
      { objects: [...docRef.current.objects, ...copies] },
      "commit",
      copies.length === 1 ? "복제" : copies.length + "개 복제",
    );
    setSelectedIds(copies.map((o) => o.id));
  };

  /**
   * 마스크 지정/해제. 해제는 **선택 안에서 마스크인 노드**를 찾아 푼다 — `makeMask` 가 세운
   * 것이 첫 자식이라, 사용자가 고른 것이 그룹이든 마스크 노드든 같은 결과가 나와야 한다.
   */
  const maskSel = (on: boolean) => {
    const ids = selIds();
    if (!ids.length) return;
    if (on) {
      if (ids.length < 2) return;
      const r = treeMakeMask(docRef.current.objects, ids);
      patchDoc({ objects: r.objects }, "commit", "마스크로 사용");
      return;
    }
    let objs = docRef.current.objects;
    for (const id of ids) {
      for (const sub of treeSubtreeIds(objs, id)) {
        if (treeNodeOf(objs, sub)?.mask) objs = treeReleaseMask(objs, sub);
      }
    }
    if (objs !== docRef.current.objects) patchDoc({ objects: objs }, "commit", "마스크 해제");
  };

  /** 보기 토글 뒤집기. 스토어에서 직접 읽는다 — 액션 맵은 리렌더 없이 최신 값을 봐야 한다. */
  const flipToggle = (k: "rulers" | "pixelGrid" | "snapPixel") => {
    const u = useImageEditorUi.getState();
    u.setToggle(k, !u.toggles[k]);
  };

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const ids = new Set(selIds());
      if (!ids.size) return;
      patchDoc(
        {
          objects: docRef.current.objects.map((o) =>
            ids.has(o.id) && isGeomNode(o) ? translateObject(o, dx, dy) : o,
          ),
        },
        "commit",
        "이동",
      );
    },
    [patchDoc],
  );

  const reorderSel = useCallback(
    (dir: 1 | -1 | "front" | "back") => {
      const ids = selIds();
      if (!ids.length) return;
      patchDoc(
        { objects: treeReorder(docRef.current.objects, ids, dir) },
        "commit",
        dir === 1 ? "앞으로" : dir === -1 ? "뒤로" : dir === "front" ? "맨 앞" : "맨 뒤",
      );
    },
    [patchDoc],
  );

  const zoomBy = useCallback((factor: number) => {
    const el = stageRef.current;
    // 키 줌은 **스테이지 중심** 기준이다(휠만 커서 기준) — 포인터가 어디 있든 화면이 튀지 않아야 한다.
    const cx = el ? el.clientWidth / 2 : 0;
    const cy = el ? el.clientHeight / 2 : 0;
    setView((v) => zoomAt(v, cx, cy, factor));
  }, []);

  /** 모드 종료(크롭 적용·노드 편집 완료) — 크롭 사각형은 문서에 남는다(§3.2). */
  const leaveMode = useCallback(() => {
    setMode({ kind: "design" });
    layerRef.current?.setCropPreview(null);
  }, [setMode]);

  /**
   * 줌 드롭다운(타이틀바). 넘어오는 숫자는 **화면 배율**이라 transform 배율로 바꾸려면
   * 맞춤 배율을 나눠야 한다(100% = `1/displayScale`). 기준점은 키 줌과 같은 스테이지 중심이다.
   */
  const zoomPreset = useCallback(
    (target: number | "fit" | "selection") => {
      const el = stageRef.current;
      if (target === "fit") {
        setView(IDENTITY_VIEW);
        return;
      }
      if (target === "selection") {
        if (!el || !selectedIds.length) return;
        const { rect } = selectBox(scene, selectedIds);
        if (rect.w <= 0 || rect.h <= 0) return;
        const s = clampScale(
          Math.min(
            (el.clientWidth * 0.8) / (rect.w * displayScale),
            (el.clientHeight * 0.8) / (rect.h * displayScale),
          ),
        );
        // 앵커 박스(dispW×dispH)는 스테이지 한가운데 놓이므로 박스 중심 = 화면 중심이다.
        // transform-origin 이 0 0 이라 중심 맞추기가 이 한 줄로 끝난다.
        setView({
          scale: s,
          x: dispW / 2 - (rect.x + rect.w / 2) * displayScale * s,
          y: dispH / 2 - (rect.y + rect.h / 2) * displayScale * s,
        });
        return;
      }
      const cx = el ? el.clientWidth / 2 : 0;
      const cy = el ? el.clientHeight / 2 : 0;
      setView((v) => zoomTo(v, cx, cy, target / displayScale));
    },
    [dispH, dispW, displayScale, scene, selectedIds],
  );

  // ── 액션 맵(45 §4) — 단축키·컨텍스트 바·인스펙터가 같은 함수를 부른다 ──────
  //
  // 전부 **stable** 이어야 한다: e2e 훅이 `actions` 를 통째로 들고 있고, `GradientEditor` 처럼
  // 콜백 참조로 이펙트를 거는 소비자가 있다. 그래서 값은 React state 가 아니라 스토어·ref 에서
  // 읽는다(`selIds()`·`docRef`·`styleRef`·`orientedRef`).

  /** 정렬·반전의 기준 캔버스(oriented px). 이미지가 아직 없으면 0 크기라 연산이 항등이 된다. */
  const canvasRect = useCallback(
    (): Rect => ({
      x: 0,
      y: 0,
      w: orientedRef.current?.width ?? 0,
      h: orientedRef.current?.height ?? 0,
    }),
    [],
  );

  const patchSelection = useCallback(
    (
      patch: SelPatch | ((n: Node) => SelPatch | null),
      label: string,
      live = false,
    ) => {
      const ids = selIds();
      // 고른 값은 **다음에 만들 객체**의 기본값도 된다(v1 `onStyleChange` 승계). 선택이 비면
      // 이것이 전부다 — 이 경로가 없으면 "그리기 전에 색·두께를 고른다"가 통째로 사라진다.
      // 노드별 함수 패치(MIXED)는 값이 하나로 모이지 않으므로 기본값을 건드리지 않는다.
      if (typeof patch !== "function") {
        const paint = paintPart(patch);
        // 타이포만 **병합**이다 — 부분 패치를 그대로 얹으면 행간 하나를 바꾼 순간 나머지
        // 필드가 통째로 사라져, 툴바가 든 "다음 텍스트 스타일"이 반쪽이 된다.
        if (Object.keys(paint).length)
          setStyle((s) => ({
            ...s,
            ...paint,
            typo: paint.typo ? { ...s.typo, ...paint.typo } : s.typo,
          }));
        if (patch.opacity !== undefined) setOpacity(patch.opacity);
        rememberColor(patch);
      }
      if (!ids.length) return;
      const set = new Set(ids);
      const next = docRef.current.objects.map((o) => {
        if (!set.has(o.id)) return o;
        const p = typeof patch === "function" ? patch(o) : patch;
        return p ? applySelPatch(o, p) : o;
      });
      if (live) patchLive({ objects: next }, label);
      else commitDoc({ objects: next }, label);
    },
    [commitDoc, patchLive],
  );

  const setFrame = useCallback(
    (
      ids: ObjId | readonly ObjId[],
      edit:
        | Partial<{ x: number; y: number; w: number; h: number; rot: number }>
        | ((cur: { x: number; y: number; w: number; h: number; rot: number }) => Partial<{
            x: number;
            y: number;
            w: number;
            h: number;
            rot: number;
          }>),
      label: string,
      live = false,
    ) => {
      const set = new Set(typeof ids === "string" ? [ids] : ids);
      if (!set.size) return;
      let touched = false;
      const next = docRef.current.objects.map((o) => {
        // 컨테이너는 자기 기하가 없다 — 프레임 편집은 리프에만 걸린다(38 §1).
        if (!set.has(o.id) || !isGeomNode(o)) return o;
        touched = true;
        return setObjectFrame(o, typeof edit === "function" ? edit(objectFrame(o)) : edit);
      });
      if (!touched) return;
      if (live) patchLive({ objects: next }, label);
      else commitDoc({ objects: next }, label);
    },
    [commitDoc, patchLive],
  );

  /**
   * 벡터 연산 실행(46). 버튼·단축키·미리보기 스트립·e2e 훅이 전부 이 함수를 탄다.
   * `ids` 를 넘기지 않으면 현재 선택이다(스토어에서 읽으므로 액션 맵이 stable 하게 남는다).
   */
  const runVector = useCallback(
    (op: PathOp, ids?: readonly ObjId[]): ObjId[] => {
      const list = ids ?? selIds();
      const out = vectorActions({
        doc: docRef.current,
        ids: list,
        applyDoc,
        select: setSelectedIds,
      }).run(op);
      // 텍스트 윤곽선화는 50(`outlineText`) 몫이라 지금은 게이트에서 막힌다. 조용히 넘어가면
      // 사용자는 Ctrl+Shift+O 가 죽은 줄 알고 다시 누른다 — 한 줄이라도 남겨야 한다.
      if (!out.length && op === "outline" && list.length === 1) {
        if (treeNodeOf(docRef.current.objects, list[0])?.kind === "text") {
          pushToast("info", "텍스트 윤곽선화는 아직 지원하지 않습니다");
        }
      }
      return out;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyDoc, pushToast, setSelectedIds],
  );

  /**
   * 패스 전용 속성(선 기하·fillRule·subpaths). `patchSelection` 을 못 쓰는 이유는 §3.8 주석
   * 그대로다 — `applyPaintPatch` 는 `DefaultPaint` 키만 알고 나머지를 **말없이 버린다**.
   */
  const pathPatch = useCallback(
    (patch: PathPatch, label: string, live = false) => {
      const ids = new Set(selIds());
      if (!ids.size) return;
      let touched = false;
      const next = docRef.current.objects.map((o) => {
        if (!ids.has(o.id) || o.kind !== "path") return o;
        touched = true;
        return applyPathPatch(o, patch);
      });
      if (!touched) return;
      if (live) patchLive({ objects: next }, label);
      else commitDoc({ objects: next }, label);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitDoc, patchLive],
  );

  const actions: EditorActions = useMemo(
    () => ({
      patchSelection,
      setFrame,
      endLive,
      align: (mode) => {
        const ids = selIds();
        if (!ids.length) return;
        // 기준은 **마지막 선택**이다(시안 ⑧). 하나만 골랐으면 캔버스가 기준이 된다.
        const keyId = ids.length > 1 ? ids[ids.length - 1] : null;
        commitDoc(
          {
            objects: alignObjects(docRef.current.objects, ids, mode, keyId, canvasRect()),
          },
          `정렬 ${ALIGN_LABEL[mode]}`,
        );
      },
      distribute: (axis) => {
        const ids = selIds();
        if (ids.length < 3) return;
        commitDoc(
          { objects: distributeObjects(docRef.current.objects, ids, axis) },
          axis === "x" ? "수평 분배" : "수직 분배",
        );
      },
      tidy: (gap) => {
        const ids = selIds();
        if (ids.length < 2) return;
        commitDoc(
          { objects: tidyObjects(docRef.current.objects, ids, gap) },
          gap === "auto" ? "간격 정리" : `간격 정리 ${gap}`,
        );
      },
      flip: (axis) => {
        const ids = selIds();
        if (!ids.length) return;
        commitDoc(
          { objects: flipNodes(docRef.current.objects, ids, axis) },
          axis === "h" ? "좌우 반전" : "상하 반전",
        );
      },
      rotate: (deg) => {
        const ids = selIds();
        if (!ids.length) return;
        // 회전 중심은 선택 상자 한가운데다 — 노드마다 자기 중심으로 돌리면 여러 개를 고른
        // 순간 배치가 흩어진다.
        const { rect } = selectBox(resolveScene(docRef.current), ids);
        commitDoc(
          {
            objects: treeRotate(docRef.current.objects, ids, deg, {
              x: rect.x + rect.w / 2,
              y: rect.y + rect.h / 2,
            }),
          },
          `${deg}° 회전`,
        );
      },
      group: (kind) => groupSel(kind),
      ungroup: () => ungroupSel(),
      mask: (on) => maskSel(on),
      duplicate: () => duplicateSel(),
      remove: () => removeSel(),
      vectorOp: (op) => void runVector(op),
      pathPatch,
      rotateImage: (plus90) => rotateBy(plus90),
      flipImage: (axis) => flipBy(axis),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      patchSelection,
      setFrame,
      endLive,
      commitDoc,
      canvasRect,
      rotateBy,
      flipBy,
      runVector,
      pathPatch,
    ],
  );

  /**
   * `I` 로 시작하는 스포이드. 뽑은 색은 **채우기 맨 앞 겹**에 들어간다(설계 §7 ins-10).
   * 선택이 없으면 그리기 색(= `style.strokes` 슬롯)이 대상이다 — 아무 데도 안 들어가면
   * 사용자는 스포이드가 고장 난 것으로 읽는다.
   */
  const { start: startEyedropper } = useEyedropper();
  const pickColor = useCallback(() => {
    startEyedropper((hex) => {
      const label = `채우기 ${hex.replace("#", "").toUpperCase()}`;
      if (!selIds().length) {
        patchSelection({ strokes: withSolidHead(styleRef.current.strokes, hex) }, label);
        return;
      }
      patchSelection((n) => ({ fills: withSolidHead(n.fills, hex) }), label);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchSelection, startEyedropper]);

  // ── 선택 분류 · 인스펙터 · 팝오버 ─────────────────────────────────────────

  /** 컨텍스트 바와 인스펙터가 **같은 판정**을 본다(45 §3.1). 모드가 선택을 이긴다. */
  const selKind = classifySelection(doc.objects, rawSelectedIds, mode);

  /**
   * 선택 종류가 바뀔 때 탭을 한 번 옮긴다(§3.1 표).
   *
   * **"사용자가 고른 탭은 그 종류 안에서 남는다"를 지키는 것은 이 의존성 배열 하나다** —
   * `[selKind]` 라 종류가 그대로면 이펙트가 아예 돌지 않는다. 스토어에 "수동으로 골랐다"
   * 플래그는 **없다**(아무도 읽지 않는 죽은 상태였다). 여기에 `selectedIds` 나 `doc` 을 더하면
   * 막아 주는 것이 없어 사용자가 고른 탭이 클릭 한 번마다 자동 탭으로 덮인다(e2e 40 ins-1f).
   */
  useEffect(() => {
    const t = AUTO_TAB[selKind];
    if (t) useImageEditorUi.getState().setTab("inspector", t);
  }, [selKind]);

  /**
   * 속성 탭이 읽는 노드. **메모해야 한다** — 매 렌더 새 배열이면 pen/path 선택에서
   * `objectFrame` 이 점 전체를 다시 훑는다(PropsTab 의 프레임 캐시가 이 참조로 걸린다).
   */
  const selNodes = useMemo(
    () => doc.objects.filter((o) => selectedIds.includes(o.id)),
    [doc.objects, selectedIds],
  );

  /**
   * 불리언 미리보기 스트립이 받는 z 순서 기하 노드. **메모해야 한다** — 매 렌더 새 배열이면
   * 스트립의 `useMemo` 키가 매번 깨져 선택을 하나 움직일 때마다 불리언 4연산이 다시 돈다
   * (§6: 200정점 곡선 ∪ rect 가 300ms 예산이다).
   */
  const selGeom = useMemo(() => selNodes.filter(isGeomNode), [selNodes]);

  /**
   * 벡터 연산 게이트(46). 컨텍스트 바·인스펙터가 **같은 판정**을 본다 — 각자 세면 한쪽만
   * 잠긴 버튼이 생기고, 그 차이는 눌러 봐야 알 수 있다.
   */
  const canVector = useMemo(() => {
    const v = vectorActions({
      doc,
      ids: selectedIds,
      applyDoc,
      select: setSelectedIds,
    });
    return Object.fromEntries(VECTOR_OPS.map((op) => [op, v.can(op)])) as Record<
      PathOp,
      boolean
    >;
  }, [doc, selectedIds, applyDoc, setSelectedIds]);

  /**
   * 텍스트 탭에서 **뱃지도 공유하는** 유일한 값이라 `typo` 가 아니라 `fontSize` 슬롯으로 간다.
   * 선택이 없으면 **텍스트·뱃지 도구일 때만** 보여 준다 — 사각형을 든 채 글자 크기를 보여
   * 주면 그 값이 지금 그리는 것에 반영되는 줄 안다.
   * `undefined` 면 `NumField` 가 필드를 통째로 감춘다(= 조용한 빈 탭).
   */
  const fontSizeValue = selNodes.length
    ? readProp(selNodes, (n) =>
        n.kind === "text" || n.kind === "badge" ? n.fontSize : undefined,
      )
    : tool === "text" || tool === "badge"
      ? style.fontSize
      : undefined;

  const [pop, setPop] = useState<PropsPopoverRequest | null>(null);
  const popRef = useRef(pop);
  popRef.current = pop;
  const closePop = useCallback(() => setPop(null), []);
  // 선택이 바뀌면 팝오버가 가리키던 겹이 다른 객체의 것이 된다 — 남의 값을 편집하기 전에 닫는다.
  useEffect(() => setPop(null), [selectedIds]);

  /**
   * 팝오버가 편집하는 노드. **첫 선택이 아니라 그 슬롯에 값을 내는 첫 노드**다.
   *
   * 스택을 그리는 쪽(PropsTab)은 `readProp` 으로 읽고, 그 함수는 그 속성에 의견이 없는 노드를
   * **건너뛴다** — 모자이크는 채우기·선을 받지 않는다(`takesPaint`). 그래서 [모자이크, 사각형]
   * 을 고르면 화면에는 사각형의 스택이 그려지는데 첫 선택에서 다시 읽으면 빈 배열이 나와,
   * 스와치를 눌러도 겹을 못 찾고 **아무 일도 일어나지 않는다**(예외도 로그도 없다).
   * 그린 것과 여는 것은 같은 노드에서 나와야 한다.
   */
  const popPaintNode = () => selNodes.find(takesPaint);

  /** 팝오버가 편집하는 스택. 선택이 없으면 도구 기본 스타일이 대상이다(속성 탭과 같은 규칙). */
  const popStack = (slot: PaintSlot): readonly Fill[] | null => {
    if (!selectedIds.length) return style[slot];
    return popPaintNode()?.[slot] ?? null;
  };
  /**
   * 이미지 페인트에는 편집기가 없다(시안 ④ 팝오버 8종에 없다). 상태만 세워 두면 아무것도
   * 안 뜨는데 "팝오버 열림"으로 남아 e2e 훅과 화면이 어긋난다 — 아예 열지 않는다.
   */
  const openPopover = (req: PropsPopoverRequest) => {
    if (req.kind === "paint" && popStack(req.slot)?.[req.index]?.type === "image") return;
    setPop(req);
  };

  const popFill =
    pop?.kind === "paint" ? (popStack(pop.slot)?.[pop.index] ?? null) : null;
  const popEffect =
    pop?.kind === "effect"
      ? (doc.objects.find((o) => o.id === selectedIds[0])?.effects[pop.index] ?? null)
      : null;

  /**
   * 팝오버가 그린 스택은 `readProp` 이 **기여 노드 전부 동일**로 판정했을 때만 뜬다(PropsTab 은
   * MIXED 스택에 목록을 그리지 않는다) — 그래서 `popPaintNode()` 에서 읽은 절대 배열을 전체에
   * 써도 된다. 기여하지 않는 노드(모자이크)는 `applyPaintPatch` 가 알아서 무시한다.
   */
  const putPaint = (p: Paint, live: boolean) => {
    if (pop?.kind !== "paint") return;
    const cur = popStack(pop.slot);
    if (!cur) return;
    const list = replacePaint(cur, pop.index, p);
    const label = `${SLOT_TITLE[pop.slot]} ${
      p.type === "solid" ? p.color.replace("#", "").toUpperCase() : PAINT_KIND_TITLE[p.type]
    }`;
    actions.patchSelection(
      pop.slot === "fills" ? { fills: list } : { strokes: list },
      label,
      live,
    );
  };

  const putEffect = (e: Effect, live: boolean) => {
    if (pop?.kind !== "effect") return;
    const i = pop.index;
    actions.patchSelection(
      (n) => ({ effects: n.effects.map((x, k) => (k === i ? e : x)) }),
      `${EFFECT_TITLE[e.type]} 편집`,
      live,
    );
  };

  /**
   * 그라디언트 핸들의 기준 상자 — 렌더(`paint.ts` 의 `paintBox`)와 **같은 값**이어야 한다.
   * 어긋나면 핸들이 실제 램프와 다른 자리에 떠 잡아 끄는 대로 색이 움직이지 않는다.
   * 팝오버가 열렸을 때만 부른다 — pen/path 는 `objectBBox` 가 점을 전부 훑는다.
   */
  const popBBox = (): Rect => {
    // 스택을 읽은 그 노드여야 한다 — 다른 객체의 상자를 쓰면 핸들이 램프와 다른 자리에 떠
    // 끄는 대로 색이 움직이지 않는다.
    const n = popPaintNode();
    return n && isGeomNode(n) ? objectBBox(n) : canvasRect();
  };

  const docColors = useMemo(
    () => (pop?.kind === "paint" ? documentColors(doc) : undefined),
    [pop?.kind, doc],
  );

  const escape = useCallback(() => {
    if (busyRef.current) return;
    // 0a) 팝오버가 가장 위다(45 §3.7 — Esc 계층 0단계). 그라디언트 편집기처럼 캔버스와
    //     상호작용하는 팝오버는 백드롭이 없어서, 이걸 빼면 Esc 가 편집기를 통째로 닫는다.
    if (closeTopPopover()) return;
    // 0b) 레일 플라이아웃이 열려 있으면 그것부터 닫는다.
    if (railRef.current?.closeFlyout()) return;
    // 1) 레이어 행 드래그 취소. 아래보다 **먼저** 봐야 한다 — 뒤로 밀면 Esc 가 선택만 비우고
    //    드래그는 살아남아, 손을 떼는 순간 취소한 줄 알았던 이동이 커밋된다.
    if (layerPanelRef.current?.cancelDrag()) return;
    // 2~5) 텍스트 확정 → 드래프트 취소 → select 복귀 → 선택 해제
    if (layerRef.current?.handleEscape()) return;
    // 6) 크롭·노드 편집 종료(동급). 크롭은 **취소**다 — 진입 시점 문서로 정확히 되돌아가고
    //    히스토리는 변하지 않는다(48 §3.1). 여기서 그냥 모드만 끄면 세션 중의 라이브 문서가
    //    적용된 것처럼 남는다.
    if (useImageEditorUi.getState().mode.kind === "crop") {
      cropApi.cropCancel();
      return;
    }
    if (useImageEditorUi.getState().mode.kind !== "design") {
      leaveMode();
      return;
    }
    // 7) 닫기 — 41 이후 확인창은 없다(문서가 사이드카에 남으므로).
    requestClose();
  }, [cropApi, leaveMode, requestClose]);

  useEditorKeys(
    {
      "tool.select": () => setTool("select"),
      "tool.scale": () => setTool("scale"),
      "tool.frame": () => setTool("frame"),
      "tool.eraser": () => setTool("eraser"),
      "tool.pen": () => setTool("pen"),
      "tool.highlight": () => setTool("highlight"),
      "tool.rect": () => setTool("rect"),
      "tool.ellipse": () => setTool("ellipse"),
      "tool.line": () => setTool("line"),
      "tool.arrow": () => setTool("arrow"),
      "tool.text": () => setTool("text"),
      "tool.badge": () => setTool("badge"),
      "tool.mosaic": () => setTool("mosaic"),
      "mode.crop": () => setCropMode(true),
      // 홀드 도구 — 액션 하나가 누름/뗌을 모두 받는다(useEditorKeys 주석 참고).
      hand: (e) =>
        e.type === "keyup"
          ? useImageEditorUi.getState().restoreTool()
          : setTool("hand", { temporary: true }),

      // 크롭 세션 중에는 되돌리기를 잠근다(48 §6): 세션 문서는 `replace` 로만 얹혀 있어
      // 여기서 undo 하면 진입 **이전** 편집이 풀리는데, 화면에는 크롭 상자만 그대로 남아
      // 무엇이 되돌아갔는지 보이지 않는다(Figma 도 크롭 중 잠근다).
      undo: () => {
        if (!cropSessionRef.current) undo();
      },
      redo: () => {
        if (!cropSessionRef.current) redo();
      },
      esc: () => escape(),
      // Enter 는 **모드가 있을 때만** 맵에 넣는다. 항상 넣으면 design 모드의 Enter 까지
      // 소비해 포커스된 버튼이 Enter 로 눌리지 않는다 — design 의 Enter(텍스트 편집 진입·
      // 그룹 진입·노드 편집 진입)는 44·47·50 것이다.
      ...(mode.kind === "design"
        ? {}
        : { enter: () => (mode.kind === "crop" ? cropApi.cropApply() : leaveMode()) }),

      duplicate: () => duplicateSel(),
      delete: () => {
        // 가이드가 먼저다 — 가이드를 고른 채 Delete 를 눌렀는데 객체가 지워지면 되돌리기
        // 전까지 무슨 일이 났는지 알 수 없다.
        if (layerRef.current?.deleteSelectedGuide()) return;
        removeSel();
      },
      // 표에 행만 있고 주인이 44 다 — 캔버스에 포커스가 있어도 레이어 패널의 이름 편집이 뜬다.
      // 다른 탭을 보고 있으면 입력이 `hidden` 안에 생겨 아무 일도 없어 보이므로 탭을 먼저 연다.
      rename: () => {
        useImageEditorUi.getState().setTab("left", "layers");
        layerPanelRef.current?.startRename();
      },
      // 복사·잘라내기는 **표에 있어야** 한다. 맵에 없으면 Ctrl+C 가 그대로 앱으로 흘러
      // `terminal.ts` 의 폴백이 뒤에 있는 터미널 선택을 대신 복사한다(§3.3 출처표).
      copy: () => void copySel(),
      cut: () => {
        const ids = selIds();
        if (!copySel()) return;
        patchDoc(
          { objects: treeRemove(docRef.current.objects, ids) },
          "commit",
          "잘라내기",
        );
        setSelectedIds([]);
      },
      copyPng: () => copyToClipboard(),
      selectAll: () => {
        // 잠긴 노드는 클릭으로 고를 수 없다 — Ctrl+A 로만 잡히면 그다음 조작 결과가
        // 화면에서 본 것과 어긋난다. 씬이 유일한 판정이다(38).
        const sc = resolveScene(docRef.current);
        setSelectedIds(
          sc.nodes.map((n) => n.id).filter((id) => !sc.flags.get(id)?.locked),
        );
      },
      // 표는 방향 넷을 한 행으로 묶는다 — 여기서 방향을 읽는다.
      // auto-repeat 를 무시하는 것은 K5 다: 초당 ~30 커밋이면 히스토리 200칸이 7초에
      // 소진돼 그 앞의 기록이 통째로 날아간다.
      nudge: (e) => {
        if (e.repeat) return;
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        if (dx || dy) nudge(dx, dy);
      },

      // 구조·정렬은 전부 액션 맵을 탄다 — 컨텍스트 바 버튼과 갈라지면 히스토리 라벨부터 어긋난다.
      group: () => actions.group("group"),
      ungroup: () => actions.ungroup(),
      // 그룹과 같은 연산이고 컨테이너 kind 만 다르다(38 `tree.group`) — 프레임은 내용을 자른다.
      frame: () => actions.group("frame"),
      mask: () => actions.mask(true),
      forward: () => reorderSel(1),
      backward: () => reorderSel(-1),
      front: () => reorderSel("front"),
      back: () => reorderSel("back"),

      // 45 가 주인인 행들(표 owner:45). 맵에 없으면 소비만 되고 아무 일도 안 한다.
      "align.left": () => actions.align("left"),
      "align.hcenter": () => actions.align("hcenter"),
      "align.right": () => actions.align("right"),
      "align.top": () => actions.align("top"),
      "align.vcenter": () => actions.align("vcenter"),
      "align.bottom": () => actions.align("bottom"),
      "distribute.h": () => actions.distribute("x"),
      "distribute.v": () => actions.distribute("y"),
      tidy: () => actions.tidy(useImageEditorUi.getState().tidyGap),
      "tool.eyedropper": () => pickColor(),

      // 46 벡터 연산 — 버튼과 **같은 함수**다. 게이트(`vectorActions.can`)도 그 안에 있어서
      // 지금 할 수 없는 조합은 문서를 건드리지 않고 그냥 소비된다.
      "bool.union": () => void runVector("union"),
      "bool.subtract": () => void runVector("subtract"),
      "bool.intersect": () => void runVector("intersect"),
      "bool.exclude": () => void runVector("exclude"),
      flatten: () => void runVector("flatten"),
      outline: () => void runVector("outline"),

      "zoom.in": () => zoomBy(WHEEL_STEP * WHEEL_STEP),
      "zoom.out": () => zoomBy(1 / (WHEEL_STEP * WHEEL_STEP)),
      "zoom.100": () => {
        const el = stageRef.current;
        setView((v) =>
          zoomTo(
            v,
            el ? el.clientWidth / 2 : 0,
            el ? el.clientHeight / 2 : 0,
            1 / displayScale,
          ),
        );
      },
      "zoom.fit": () => setView(IDENTITY_VIEW),
      "zoom.sel": () => zoomPreset("selection"),

      // 표에 있는데 맵에 없으면 Shift+R·Ctrl+' 이 앱 전역으로 새고(먹통), 상태바 토글과 키가
      // 갈린다. 값만 뒤집으면 크롬은 스토어 구독으로 따라온다(AnnotationLayer).
      "view.rulers": () => flipToggle("rulers"),
      "view.pixelGrid": () => flipToggle("pixelGrid"),
      "view.snapPixel": () => flipToggle("snapPixel"),
      // 홀드 — 누르는 동안만 잰다. auto-repeat 는 같은 값을 다시 쓰는 것뿐이라 무해하다.
      "measure.hold": (e) => layerRef.current?.setAltMeasure(e.type !== "keyup"),
      // 0↔1 만 오간다(§3.4) — 45 가 넣는 2x 는 조정 탭이 정한다.
      "view.pixelPreview": () => {
        const u = useImageEditorUi.getState();
        u.setPixelPreview(u.pixelPreview === 0 ? 1 : 0);
      },

      "file.save": () => void persistRef.current?.flush(),
      "file.saveAs": () => saveAs(),
      "file.close": () => requestClose(),
    },
    {
      // 팝오버가 열려 있으면 Escape 만 받는다 — 안 그러면 색 피커 안에서 누른 Delete 가
      // 텍스트가 아니라 **선택 객체**를 지운다(45 §6).
      popoverOpen: () => (railRef.current?.isFlyoutOpen() ?? false) || hasOpenPopover(),
      blocked: () => {
        const ui = useUi.getState();
        return !!(ui.prompt || ui.confirm);
      },
      context: () => {
        const u = useImageEditorUi.getState();
        const ids = new Set(u.selectedIds);
        const kinds = new Set<Node["kind"]>();
        for (const o of docRef.current.objects) if (ids.has(o.id)) kinds.add(o.kind);
        return {
          mode: u.mode,
          sel: u.selectedIds.length,
          selKinds: kinds,
          textEditing: u.textEditing,
        };
      },
    },
  );

  // ── E2E 훅(§9.4) — DEV 빌드에서만 노출 ────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const g = window as unknown as { __gpv?: Record<string, unknown> };
    g.__gpv = g.__gpv ?? {};
    g.__gpv.imageDocs = {
      read: (pid: string, rel: string) => ipc.imageDocRead(pid, rel, "doc"),
      delete: (pid: string, rel: string) => ipc.imageDocDelete(pid, rel),
    };
    g.__gpv.imageEditor = {
      getDoc: () => docRef.current,
      // setDoc 은 **경계**다 — v1 리터럴이든 부분 문서든 여기서 완전한 v2 문서가 된다(37 §3.3).
      // 그래서 30·34·35 의 setDoc 리터럴 21건이 재작성 없이 산다.
      setDoc: (patch: Partial<EditorDoc>) =>
        patchDoc(normalizeDoc({ ...docRef.current, ...patch })),
      setTool: (t: Tool) => setTool(t),
      /** 셸 상태 한 벌(42 §4) — 레일·상태바·패널이 같은 값을 보는지 확인하는 근거. */
      getUi: () => {
        const u = useImageEditorUi.getState();
        return {
          tool: u.tool,
          mode: u.mode,
          pixelPreview: u.pixelPreview,
          selectedIds: u.selectedIds,
          hoverId: u.hoverId,
          toggles: u.toggles,
        };
      },
      /**
       * 토글은 **사용자 취향이라 localStorage 에 영속된다** — 사람이 켜 둔 그리드 16px 이
       * e2e 로 새어 들어와 스냅 없던 시절의 좌표를 재는 단언(30 의 리사이즈 산술)을 깬다.
       * 스위트가 전제를 명시적으로 세우고 끝에 원복할 손잡이다.
       */
      setToggle: <K extends keyof EditorUiState["toggles"]>(
        k: K,
        v: EditorUiState["toggles"][K],
      ) => useImageEditorUi.getState().setToggle(k, v),
      setMode: (m: Mode) => setMode(m),
      /**
       * 표 판정만 떼어 본다 — 한글 IME(`key='ㅍ'`)·Mac ⌥(`key='å'`)에서도 물리 키로
       * 잡히는지를 두 플랫폼 모두 한 머신에서 확인하기 위한 훅이다.
       */
      matchShortcut: (init: KeyboardEventInit, platform?: "win" | "mac") => {
        const u = useImageEditorUi.getState();
        const ids = new Set(u.selectedIds);
        const kinds = new Set<Node["kind"]>();
        for (const o of docRef.current.objects) if (ids.has(o.id)) kinds.add(o.kind);
        return matchShortcut(
          init as KeyboardEvent,
          {
            mode: u.mode,
            sel: u.selectedIds.length,
            selKinds: kinds,
            textEditing: u.textEditing,
          },
          platform,
        );
      },
      renderOnce: () => layerRef.current?.renderOnce(),
      /**
       * 크롭(48). `crop` 은 버튼·단축키가 부르는 것과 **같은 객체**라 갈라질 자리가 없고,
       * `getOrientedSize` 는 직선화가 캔버스를 얼마나 키웠는지를(θ=0 비트 동일 증명 포함)
       * 화면을 안 읽고 확인하는 통로다. `histDepth` 는 "세션 몇 틱 = 히스토리 0칸"의 근거.
       */
      getOrientedSize: () => ({
        w: orientedRef.current?.width ?? 0,
        h: orientedRef.current?.height ?? 0,
      }),
      cropSession: () => cropApi.getCropSession(),
      crop: cropApi,
      histDepth: () => histRef.current.depth,
      /**
       * 텍스트 레이아웃(49) — 줄 나눔·상자·마커를 화면 픽셀을 읽지 않고 확인하는 통로.
       * 렌더·히트·편집 오버레이가 **이 산출물 하나**를 나눠 쓰므로, 여기서 본 줄이 곧
       * 그려진 줄이다. `fallback:true` 는 `letterSpacing` 이 없는 엔진(WKWebView)의 수동
       * 배치 경로를 Windows 에서 강제한다 — 그 경로는 Mac 에서만 도는 코드라 실기 없이
       * 죽어 있는지 알 방법이 이것뿐이다. `outline`(50)은 Path2D 라 직렬화에서 뺀다.
       */
      textLayout: (
        id: ObjId,
        opts?: { editing?: boolean; fallback?: boolean },
      ) => {
        const n = docRef.current.objects.find((o) => o.id === id);
        if (!n || n.kind !== "text") return null;
        const { outline: _drop, ...rest } = layoutText(n, opts);
        return rest;
      },
      /**
       * 화면 크롬(43). `state()` 는 **마지막 프레임이 그린 값**이고, `set()` 은 그 위에 덮어
       * 강제로 한 번 더 그린다 — 아직 소유 태스크가 오지 않은 항목(48 크롭 오버레이·47 extra)을
       * 문서 없이 검증하는 통로다.
       */
      chrome: {
        state: () => lastChromeRef.current,
        // 덮는 대상은 **레이어가 준 원본**이다. 그려진 값(`lastChromeRef`)에 얹으면 45 가
        // 합류시킨 `extra`(그라디언트 핸들)가 한 번 더 붙어 프리미티브가 두 벌이 된다.
        set: (patch: Partial<ChromeState>) => {
          const base = baseChromeRef.current;
          if (!base) return false;
          chromeTapRef.current.update({ ...base, ...patch });
          return true;
        },
      },
      /** 스냅 순수 함수 — 현재 문서로 인덱스를 만든 뒤 부른다(드래그 없이 값만 본다). */
      snap: {
        rect: (r: Rect, tol: number) => {
          const idx = snapIndexNow();
          return idx ? snapRect(idx, r, tol, { gaps: true }) : null;
        },
        point: (pt: { x: number; y: number }, tol: number) => {
          const idx = snapIndexNow();
          return idx ? snapPoint(idx, pt, tol) : null;
        },
      },
      rulerTicks,
      /** 직렬화 왕복이 문서를 바꾸지 않는가 — 태스크 41(사이드카 자동저장)의 전제다. */
      roundTrip: () => {
        const env: ImageDocEnvelope = {
          v: 2,
          projectId: editorRepoId ?? "",
          relPath: path ?? "",
          imageStamp: stampRef.current,
          imageW: docRef.current.outW,
          imageH: docRef.current.outH,
          savedAt: 0,
          doc: docRef.current,
          foreign: [],
          log: [],
        };
        const back = parseImageDoc(serializeImageDoc(env)).env.doc;
        const key = (v: unknown): string =>
          JSON.stringify(v, (_k, x) =>
            x && typeof x === "object" && !Array.isArray(x)
              ? Object.fromEntries(Object.entries(x as object).sort())
              : x,
          );
        return key(back) === key(docRef.current);
      },
      /**
       * 창(win)만 렌더한 결과 — **윈도 불변** 검증용(40 §7 (d-2)). 서로 다른 두 창의 겹침
       * 픽셀이 달라지면 가림·효과가 창 경계에 의존한다는 뜻이다(클램프 사고).
       */
      renderRegion: (win: { x: number; y: number; w: number; h: number }, devScale: number) => {
        const img = orientedRef.current;
        if (!img) return null;
        const { ctx, work } = renderRegion(resolveScene(docRef.current), win, devScale, {
          image: img,
          background: "image",
          filter: filterStrRef.current,
          store: storeRef.current,
        });
        const x = Math.round((win.x - work.x) * devScale);
        const y = Math.round((win.y - work.y) * devScale);
        const w = Math.max(1, Math.round(win.w * devScale));
        const h = Math.max(1, Math.round(win.h * devScale));
        const d = ctx.getImageData(x, y, w, h).data;
        return { w, h, data: Array.from(d.slice(0, Math.min(d.length, 4 * 64))) };
      },
      /** 내보내기 배율 게이트·예상 용량의 단일 출처(40 §3.3). */
      estimate: (outW: number, outH: number) =>
        estimateRenderBytes(resolveScene(docRef.current), { outW, outH }),
      /** 히스토리 v2 — 라벨·커서·점프·스냅샷(41 §7). */
      history: {
        entries: () =>
          histRef.current.entries.map((e) => ({
            label: e.label,
            at: e.at,
            readonly: e.readonly,
          })),
        cursor: () => histRef.current.cursor,
        // 히스토리 탭의 행 클릭과 **같은 함수**다 — 갈라지면 e2e 가 통과해도 화면은 다르다.
        jumpTo,
        snapshot: (name: string) => persistRef.current?.saveSnapshot(name),
        listSnapshots: () => persistRef.current?.listSnapshots(),
        loadSnapshot,
        state: () => persistRef.current?.state ?? "clean",
        flush: () => persistRef.current?.flush(),
      },
      /**
       * 레이어 패널(44). `rows()` 는 지금 **화면에 그려지는** 행이다(검색·필터·접기 반영) —
       * 문서 전체를 보려면 `getDoc()` 을 쓴다. `count` 는 배경을 뺀 문서 노드 수라 필터 표기
       * `matched/count` 의 분모와 같다.
       *
       * `badges` 는 블렌드만 표시 문구이고 나머지는 종류 문자열이다(`mask`·`nodeEdit`·
       * `instance`) — 문구 표는 `LayerRow` 안에 있고 export 되지 않았다.
       */
      layers: () => ({
        rows: (layerPanelRef.current?.rows() ?? []).map((r) => ({
          id: r.id,
          depth: r.depth,
          name: r.name,
          type: r.type,
          hidden: r.hidden,
          locked: r.locked,
          badges: r.badges.map((b) => (b.kind === "blend" ? b.label : b.kind)),
        })),
        count: docRef.current.objects.length,
      }),
      /** 패널 로컬 state 에 닿는 유일한 통로(§4). 스토어에 없는 값이라 훅도 손잡이를 거친다. */
      panel: {
        setQuery: (q: string) => layerPanelRef.current?.setQuery(q),
        setFilter: (patch: Partial<LayerFilter>) => layerPanelRef.current?.setFilter(patch),
        toggleCollapsed: (id: ObjId) => layerPanelRef.current?.toggleCollapsed(id),
        startRename: (id?: ObjId) => layerPanelRef.current?.startRename(id),
      },
      /** 씬 요약 — 숨김이 빠졌는지, 무엇이 잠겼는지, 컨테이너 범위가 맞는지(38 §7). */
      scene: () => {
        const sc = resolveScene(docRef.current);
        return {
          nodeIds: sc.nodes.map((n) => n.id),
          lockedIds: [...sc.flags.entries()].filter(([, f]) => f.locked).map(([id]) => id),
          containers: sc.containers.map((c) => ({ id: c.id, range: c.range })),
        };
      },
      /**
       * 트리 연산 — 패널·단축키(태스크 42·44)가 붙기 전에 연산 자체를 검증한다.
       * 전부 문서에 **커밋**하므로 히스토리·불변식 검사도 함께 지난다.
       */
      tree: {
        group: (ids: ObjId[], kind: "group" | "frame" = "group") => {
          const r = treeGroup(docRef.current.objects, ids, kind);
          patchDoc({ objects: r.objects });
          return r.id;
        },
        ungroup: (id: ObjId) => patchDoc({ objects: treeUngroup(docRef.current.objects, id) }),
        reorder: (ids: ObjId[], dir: 1 | -1 | "front" | "back") =>
          patchDoc({ objects: treeReorder(docRef.current.objects, ids, dir) }),
        reparent: (ids: ObjId[], parent: ObjId | null, index: number) =>
          patchDoc({ objects: treeReparent(docRef.current.objects, ids, parent, index) }),
        remove: (ids: ObjId[]) => patchDoc({ objects: treeRemove(docRef.current.objects, ids) }),
        makeMask: (ids: ObjId[]) => {
          const r = treeMakeMask(docRef.current.objects, ids);
          patchDoc({ objects: r.objects });
          return r.maskId;
        },
        maskScope: (maskId: ObjId) => treeMaskScope(docRef.current.objects, maskId),
        subtreeRange: (id: ObjId) => treeSubtreeRange(docRef.current.objects, id),
        nodeAABB: (id: ObjId) => treeNodeAABB(docRef.current.objects, id),
        translate: (ids: ObjId[], dx: number, dy: number) =>
          patchDoc({ objects: treeTranslate(docRef.current.objects, ids, dx, dy) }),
        rotate: (ids: ObjId[], deg: number, cx: number, cy: number) =>
          patchDoc({ objects: treeRotate(docRef.current.objects, ids, deg, { x: cx, y: cy }) }),
      },
      schema: {
        normalizeDoc,
        parse: parseImageDoc,
        serialize: serializeImageDoc,
        documentColors,
        emptyDoc: () => EMPTY_DOC,
        version: DOC_VERSION,
      },
      /** 컨텍스트 바·인스펙터가 보는 판정(45 §3.1) — 화면을 안 읽고 규칙만 확인한다. */
      classify: () => {
        const u = useImageEditorUi.getState();
        return classifySelection(docRef.current.objects, u.selectedIds, u.mode);
      },
      /**
       * 인스펙터(45). `fields()` 는 **지금 보이는 탭**의 입력만 훑는다 — MIXED 를 값과
       * 구분해야 해서 `value` 와 `placeholder` 를 함께 돌려준다(빈 문자열 하나로 뭉치면
       * "0"·"값 없음"·"여러 값"이 같아 보인다).
       */
      inspector: {
        tab: () => useImageEditorUi.getState().inspectorTab,
        setTab: (t: EditorUiState["inspectorTab"]) =>
          useImageEditorUi.getState().setTab("inspector", t),
        fields: () => {
          const tab = useImageEditorUi.getState().inspectorTab;
          const panel = rootRef.current?.querySelector(`[data-inspector-tab="${tab}"]`);
          const out: Record<string, unknown> = {};
          for (const el of panel?.querySelectorAll<HTMLInputElement>("input[aria-label]") ??
            []) {
            out[el.getAttribute("aria-label")!] = {
              value: el.value,
              placeholder: el.placeholder,
            };
          }
          return out;
        },
      },
      /** 열린 팝오버 하나 — 어떤 슬롯의 몇 번째 겹인지까지 준다. */
      popover: {
        open: () => {
          const p = popRef.current;
          if (!p) return null;
          return p.kind === "paint" ? `paint:${p.slot}:${p.index}` : `effect:${p.index}`;
        },
        close: () => closeTopPopover(),
      },
      /** 버튼·단축키가 부르는 것과 **같은 함수**(45 §4). 갈라지면 e2e 만 통과한다. */
      actions,
      /**
       * 벡터 연산(46 §4). `op` 는 **커밋까지** 하고 결과 id 를 준다 — 화면을 안 읽고 4연산·
       * 평탄화·분리의 문서 결과를 본다. `toPath` 는 변환기 단독 확인용이라 커밋하지 않는다.
       */
      vector: {
        op: (op: PathOp, ids?: ObjId[]) => runVector(op, ids),
        can: (op: PathOp, ids?: ObjId[]) =>
          vectorActions({
            doc: docRef.current,
            ids: ids ?? selIds(),
            applyDoc,
            select: setSelectedIds,
          }).can(op),
        toPath: (id: ObjId) => {
          const n = treeNodeOf(docRef.current.objects, id);
          return n && isGeomNode(n) ? toPathObject(n) : null;
        },
      },
    };
    return () => {
      delete g.__gpv?.imageEditor;
      delete g.__gpv?.imageDocs;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, patchDoc, snapIndexNow, runVector, cropApi]);

  if (!path) return null;

  const warn = roundTripWarning(path);
  const canUndo = histRef.current.canUndo;
  const canRedo = histRef.current.canRedo;
  void histVer; // 히스토리 깊이 변화로 리렌더되게 하는 의존(값 자체는 쓰지 않는다)
  // 히스토리 탭에 넘길 값도 **렌더 시점에** 읽는다 — `DocHistory` 내부 배열을 패널이 직접
  // 들고 있으면 커밋으로 배열이 바뀌어도 리렌더 신호가 없어 목록이 한 칸 뒤처진다(§6).
  const histEntries = histRef.current.entries;
  const histCursor = histRef.current.cursor;
  /** 배경 행 문구(시안 `배경 — 대시보드.png`)는 확장자까지 붙은 파일명이다. */
  const baseFile = path.split("/").pop() ?? path;

  return (
    // 루트 클래스 `fixed inset-0 z-50` 는 **그대로 두어야 한다** — e2e 30·34·35 가 이 선택자로
    // 편집기를 잡는다(문구 대신 `aria-label` 로도 찾도록 헬퍼를 넓혔다). 카드는 없어졌고 창을
    // 통째로 쓴다. doc 창에서는 인라인 top 으로 FloatTitleBar(h-8 = 32px)를 비켜 준다 —
    // 덮으면 창을 옮기지도 닫지도 못한다. stage 재적합은 기존 ResizeObserver 가 한다.
    //
    // `role="application"` + `tabIndex={-1}`: 포커스가 루트에 있어야 Space 홀드가 손 도구가
    // 되고, 방향키·글자 키가 뒤의 앱으로 새지 않는다(§3.3).
    <div
      ref={rootRef}
      role="application"
      aria-label="이미지 편집"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel outline-none"
      style={IS_DOC_WINDOW ? { top: 32 } : undefined}
    >
      <EditorTitleBar
        projectId={projectId ?? null}
        path={path}
        dirty={persist.state !== "clean"}
        zoom={screenScale}
        onZoom={zoomPreset}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        onClose={requestClose}
      />

      {warn && (
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-edge px-3 text-[11px] text-warn">
          <AlertTriangle size={12} className="shrink-0" />
          <span
            className="truncate"
            title="원본 포맷으로 되돌려 저장할 수 없습니다"
          >
            {warn}
          </span>
        </div>
      )}

      {/* 편집 문서는 자동으로 되살아난다(41 §3.3) — 물어볼 것이 없다. 대신 **원본이 바뀐**
          경우만 알린다: 그때는 크롭·출력 크기를 새 이미지 기준으로 되돌렸다는 뜻이다. */}
      {imageChanged && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 text-[11px]">
          <FileWarning size={12} className="shrink-0 text-warn" />
          <span className="flex-1 truncate text-fg-muted">
            편집 문서를 저장한 뒤 원본 이미지가 바뀌었습니다 — 크롭과 출력 크기를 초기화했습니다.
          </span>
          <button
            type="button"
            onClick={() => setImageChanged(false)}
            className="shrink-0 rounded px-1.5 py-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            확인
          </button>
        </div>
      )}

      {/* 시안의 4열 — 레일 56 · 좌 패널 264 · 스테이지 · 인스펙터 320. 좌·우 폭은 각 패널이
          `usePanelWidth` 로 직접 들고 늘였다 줄이므로, 부모는 폭을 정하지 않는 flex 다. */}
      <div className="flex min-h-0 flex-1">
        <ToolRail
          onFocusRoot={focusRoot}
          paint={style}
          handleRef={railRef}
          onPlaceImage={placeImage}
        />
        <LeftPanel
          layersRef={layerPanelRef}
          layers={{
            doc,
            scene,
            baseName: baseFile,
            onCommit: (objects, label) => patchDoc({ objects }, "commit", label),
            // 인자를 삼켜야 한다 — 패널은 `onClick={actions.group}` 으로 그대로 넘기므로
            // 맨 인자로 두면 `groupSel` 이 마우스 이벤트를 컨테이너 kind 로 받는다.
            actions: { group: () => groupSel("group"), remove: () => removeSel() },
          }}
          history={{
            entries: histEntries,
            cursor: histCursor,
            snapshots,
            onJump: jumpTo,
            onLoadSnapshot: (i) => void loadSnapshot(i),
            onSaveSnapshot: saveSnapshot,
            onUndo: undo,
          }}
        />

        {/* 스테이지 열 — 컨텍스트 바(44px) + 프리뷰. 바는 크롬(SVG 오버레이)과 겹치지 않는
            일반 흐름이라 z 를 다투지 않는다. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ContextBar
            kind={selKind}
            actions={actions}
            objects={doc.objects}
            zoom={screenScale}
            onZoom={zoomPreset}
            imageSize={oriented ? { w: oriented.width, h: oriented.height } : null}
            canVector={canVector}
            crop={
              cropSession && img
                ? {
                    session: cropSession,
                    api: cropApi,
                    // 큰 이미지는 직선화 bbox 가 화소 상한에 먼저 걸린다 — 슬라이더 범위를
                    // 그 각까지로 줄여야 끝까지 끌었을 때 캔버스 할당이 터지지 않는다(§3.6).
                    maxDeg: maxStraightenFor(img.naturalWidth, img.naturalHeight),
                  }
                : undefined
            }
          />

          {/* 프리뷰 — 이미지 위에 주석 캔버스를 겹친다(§4.3) */}
          <div
            ref={stageRef}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            className="checkerboard relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
          >
            {/* 모드 배너 — 지금 무엇이 Enter·Esc 를 받는지 알린다(§3.2). 포인터는 통과시킨다:
                스테이지 위에 떠 있어 클릭을 먹으면 그 자리에 그림을 못 그린다. */}
            {mode.kind !== "design" && (
              <div className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-edge bg-panel/90 px-2 py-1 text-[11px] text-fg-muted">
                {mode.kind === "crop"
                  ? "크롭 모드 · ⏎ 적용 · Esc 취소"
                  : "벡터 편집 모드 · Esc 로 편집 종료"}
              </div>
            )}
            {loadErr ? (
              <div className="text-sm text-danger">{loadErr}</div>
            ) : !img ? (
              <div className="flex items-center gap-2 text-sm text-fg-dim">
                <Loader2 size={16} className="animate-spin" /> 이미지 불러오는 중…
              </div>
            ) : showStage && oriented ? (
              // 바깥은 **변환이 걸리지 않는 앵커**다 — 줌 수식의 기준 프레임이라 rect 가
              // view 에 따라 흔들리면 안 된다. 확대분은 stage 의 overflow-hidden 이 자른다.
              // z 는 stage 안 세 겹의 정본(`STAGE_Z`)에서만 온다 — 여기 값을 빼면 40 의 디테일
              // 캔버스가 씬 위로 올라오는 순서가 파일마다 흩어진다.
              <div
                ref={boxRef}
                className="relative"
                style={{ width: dispW, height: dispH, zIndex: STAGE_Z.box }}
              >
                <div
                  className="absolute inset-0 shadow-lg"
                  style={{
                    transformOrigin: "0 0",
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  }}
                >
                  {/* 이미지는 이제 **씬 캔버스**가 그린다(태스크 39 §3.1 병합) — 별도 베이스
                      캔버스도, CSS 필터도 없다. 조정은 renderScene 안에서 이미지에만 걸린다. */}
                  <AnnotationLayer
                    ref={layerRef}
                    scene={scene}
                    oriented={oriented}
                    backW={backW}
                    backH={backH}
                    scale={previewScale}
                    // 줌을 곱해 넘긴다 — 이 prop 의 계약은 "oriented → **화면** css px" 라
                    // 히트 허용오차·핸들 집기 반경·핸들 그리기 크기가 전부 스스로 맞는다.
                    // transform 안쪽 DOM(텍스트 편집 textarea)만 zoom 으로 되나눈다.
                    displayScale={screenScale}
                    zoom={view.scale}
                    filterStr={filterStr}
                    objects={doc.objects}
                    store={store}
                    assetsVer={assetsVer}
                    selectedIds={selectedIds}
                    tool={tool}
                    style={style}
                    opacity={opacity}
                    cropMode={cropMode}
                    // 세션이 있으면 그 사각형이 이긴다 — 확정된 `doc.crop` 은 세션이 끝난 뒤의
                    // 값이라, 세션 중에 그리면 방금 만진 상자가 화면에 안 나온다.
                    cropRect={cropSession ? cropSession.rect : crop}
                    onCropDown={onCropDown}
                    onCropMove={onCropMove}
                    onCropUp={onCropUp}
                    onCropCancel={onCropCancel}
                    onCommit={(objects, label) => patchDoc({ objects }, "commit", label)}
                    onEditingChange={setTextEditing}
                    onToolChange={setTool}
                    onSelectionChange={setSelectedIds}
                    statusRef={statusRef}
                    chrome={chromeTapRef}
                    screen={screen}
                    guides={doc.guides}
                    onGuidesChange={(guides, label) =>
                      patchDoc({ guides }, "commit", label)
                    }
                  />
                </div>
              </div>
            ) : null}

            {/* 크롬은 **변환 밖**, stage 직속이다. 줌 transform 안에 넣으면 1px 선·8px 핸들이
                배율을 그대로 먹어 캔버스 크롬을 버린 이유(43 §3.1)를 되풀이한다. */}
            {showStage && oriented && (
              <ChromeOverlay
                ref={chromeRef}
                onGuideCommit={(axis, pos) =>
                  patchDoc(
                    { guides: [...docRef.current.guides, { axis, pos }] },
                    "commit",
                    "가이드 추가",
                  )
                }
                snapForGuide={snapForGuide}
              />
            )}

            {/* 불리언 미리보기(시안 ③ 캔버스 하단) — 게이트는 컨텍스트 바·인스펙터와 같은
                판정이다. 스트립 자체도 `canBoolean` 을 다시 보므로 여기 조건은 빈 상자를
                만들지 않기 위한 것이다(줌 필과 자리를 다투지 않게 왼쪽으로 붙인다). */}
            {showStage && canVector.union && (
              <div
                className="absolute bottom-3 left-3"
                style={{ zIndex: STAGE_Z.chrome + 1 }}
              >
                <BooleanPreviewStrip nodes={selGeom} onApply={(op) => void runVector(op)} />
              </div>
            )}

            {/* 줌 필(시안 ①, 캔버스 우하단) — 배율은 크롬과 같은 값을 쓴다. */}
            {showStage && (
              <div
                className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-full border border-edge bg-panel/90 px-1 py-0.5 text-[11px] text-fg-muted"
                style={{ zIndex: STAGE_Z.chrome + 1 }}
              >
                <button
                  type="button"
                  title="축소"
                  onClick={() => zoomBy(1 / (WHEEL_STEP * WHEEL_STEP))}
                  className="rounded-full p-1 hover:bg-raised hover:text-fg"
                >
                  <Minus size={12} />
                </button>
                <button
                  type="button"
                  title="화면 맞춤"
                  onClick={() => setView(IDENTITY_VIEW)}
                  className="min-w-[3.5rem] rounded-full px-1 py-0.5 text-center font-mono hover:bg-raised hover:text-fg"
                >
                  {Math.round(screenScale * 100)}%
                </button>
                <button
                  type="button"
                  title="확대"
                  onClick={() => zoomBy(WHEEL_STEP * WHEEL_STEP)}
                  className="rounded-full p-1 hover:bg-raised hover:text-fg"
                >
                  <Plus size={12} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 인스펙터 — 탭 4개(속성·텍스트·조정·내보내기)와 시안 푸터(45 §3.3).
            네 탭이 **항상 마운트**돼 있고 비활성만 숨는다: e2e 30 이 속성 탭이 열린 채로
            조정 탭의 `오른쪽 90°` 를 누른다(조건부 마운트면 그 클릭이 갈 곳이 없다). */}
        <Inspector
          panes={{
            props: (
              <PropsTab
                nodes={selNodes}
                actions={actions}
                style={style}
                opacity={opacity}
                recentColors={recent}
                onOpenPopover={openPopover}
                canVector={canVector}
              />
            ),
            // 글꼴 목록·굵기·서식 툴바는 50 `TextInspector` 것이다 — 레이아웃을 정하는
            // 값만 49 가 채운다. `patchSelection` 을 **직접** 넘기는 이유는 타이포가 부분
            // 패치이기 때문이다(`actions` 쪽 계약의 `typo` 는 완전한 `TextStyle` 이다).
            text: (
              <TextTab
                nodes={selNodes}
                fontSize={fontSizeValue}
                onFontSize={(v, live) =>
                  patchSelection({ fontSize: v }, `글자 크기 ${v}`, live)
                }
                onTypo={(typo, label, live) => patchSelection({ typo }, label, live)}
                onLiveEnd={endLive}
              />
            ),
            adjust: (
              <AdjustTab
                doc={doc}
                onPatch={(patch, live) => (live ? patchLive(patch) : patchDoc(patch))}
                onEditEnd={endLive}
                cropSection={
                  <CropInspectorSection
                    session={cropSession}
                    api={cropApi}
                    doc={doc}
                    onEnter={() => setCropMode(true)}
                    onClear={clearCrop}
                  />
                }
                onRotateImage={rotateBy}
                onFlipImage={flipBy}
                onOutW={changeW}
                onOutH={changeH}
                lockRatio={lockRatio}
                onLockRatio={setLockRatio}
              />
            ),
            export: (
              <ExportTabHost
                format={format}
                onFormat={setFormat}
                quality={quality}
                onQuality={setQuality}
              />
            ),
          }}
          footer={
            <InspectorFooter
              format={format}
              busy={busy}
              canSave={!!img}
              onReset={resetAll}
              onCopy={copyToClipboard}
              onSaveAs={saveAs}
              onSave={saveInPlace}
            />
          }
        />
      </div>

      <EditorStatusBar
        ref={statusRef}
        zoomPercent={screenScale * 100}
        undoDepth={histRef.current.cursor}
        selectBox={selBox}
      />

      {/* 팝오버(45 §3.7~3.8). 편집기 루트 안이라 확인창 `z-[60]`·토스트 `z-[55]` 아래에 선다. */}
      {pop?.kind === "paint" && popFill && popFill.type !== "image" && (
        <Popover
          anchor={pop.anchor}
          open
          onClose={closePop}
          placement="left-start"
          width={232}
          // 그라디언트는 캔버스 핸들을 끌어야 해서 백드롭을 두지 않는다. 색 피커는 스포이드가
          // 켜진 동안만 통과시킨다 — 백드롭이 캔버스 클릭을 먼저 먹으면 스포이드가 한 번도
          // 성립하지 않는다(45 §3.7).
          modal={popFill.type === "solid" && tool !== "eyedropper"}
          title={`${SLOT_TITLE[pop.slot]} · ${PAINT_KIND_TITLE[popFill.type]}`}
        >
          {popFill.type === "solid" ? (
            <ColorPicker
              title={SLOT_TITLE[pop.slot]}
              paint={popFill}
              docColors={docColors}
              onLive={(p) => putPaint(p, true)}
              onCommit={(p) => putPaint(p, false)}
            />
          ) : (
            <GradientEditor
              paint={popFill}
              bbox={popBBox()}
              onExtra={setChromeExtra}
              registerHit={registerPointerHit}
              onLive={(p) => putPaint(p, true)}
              onCommit={(p) => putPaint(p, false)}
            />
          )}
        </Popover>
      )}

      {pop?.kind === "effect" && popEffect && (
        <Popover
          anchor={pop.anchor}
          open
          onClose={closePop}
          placement="left-start"
          width={232}
          modal={tool !== "eyedropper"}
          title={EFFECT_TITLE[popEffect.type]}
        >
          <EffectEditor
            effect={popEffect}
            onLive={(e) => putEffect(e, true)}
            onCommit={(e) => putEffect(e, false)}
            onToggle={() => putEffect({ ...popEffect, visible: !popEffect.visible }, false)}
            onRemove={() => {
              const i = pop.index;
              actions.patchSelection(
                (n) => ({ effects: n.effects.filter((_, k) => k !== i) }),
                "효과 제거",
              );
              // 인덱스가 신원이 아니다 — 지운 자리에 다음 효과가 들어오므로 반드시 닫는다.
              closePop();
            }}
          />
        </Popover>
      )}
    </div>
  );
}

// ── 텍스트 탭(태스크 49) ─────────────────────────────────────────────────────
//
// 시안 ② 타이포그래피 중 **레이아웃을 정하는 값**만 여기 있다. 글꼴 목록·굵기·OpenType 은
// 50 이 얹을 자리라 비워 뒀다 — 지금 껍데기를 그려 두면 50 이 그것을 지우는 일부터 한다.
//
// 쓰기는 전부 `onTypo(부분 스타일)` 하나로 나간다. 노드 필드를 직접 얹으면 37
// `applyPaintPatch` 의 두 규칙(텍스트 아닌 kind 무시 · `styleRefs.text` 떼기)을 우회하게 되고,
// 그러면 스타일 라이브러리(51)가 다음 동기화에서 사용자의 편집을 조용히 덮는다.
//
// 선택에 텍스트가 없으면 **글자 크기만** 남는다. 나머지를 툴바 기본값으로 보여 주면 그 값이
// 지금 그리는 것에 반영되는 것처럼 보이는데, 새 텍스트를 만드는 `newTextNode`(draft.ts)는
// 아직 `fontSize` 밖의 타이포를 받지 않는다.

const ALIGN_OPTS: readonly SelectOption<TextStyle["align"]>[] = [
  { value: "left", label: "왼쪽" },
  { value: "center", label: "가운데" },
  { value: "right", label: "오른쪽" },
  { value: "justify", label: "양쪽" },
];
const VALIGN_OPTS: readonly SelectOption<TextStyle["valign"]>[] = [
  { value: "top", label: "위" },
  { value: "middle", label: "가운데" },
  { value: "bottom", label: "아래" },
];
const RESIZE_OPTS: readonly SelectOption<TextStyle["resize"]>[] = [
  { value: "auto-width", label: "자동 폭" },
  { value: "auto-height", label: "자동 높이" },
  { value: "fixed", label: "고정" },
];
const LIST_OPTS: readonly SelectOption<TextStyle["list"]>[] = [
  { value: "none", label: "없음" },
  { value: "bullet", label: "글머리" },
  { value: "number", label: "번호" },
  { value: "check", label: "체크" },
];
const CASE_OPTS: readonly SelectOption<TextStyle["textCase"]>[] = [
  { value: "none", label: "기본" },
  { value: "upper", label: "대문자" },
  { value: "lower", label: "소문자" },
];
const SCRIPT_OPTS: readonly SelectOption<TextStyle["script"]>[] = [
  { value: "none", label: "없음" },
  { value: "super", label: "위" },
  { value: "sub", label: "아래" },
];

/** 히스토리 라벨은 사용자가 화면에서 읽은 낱말이어야 한다 — 되돌리기 목록이 `justify` 라고 적으면 안 된다. */
function optLabel<V>(opts: readonly SelectOption<V>[], v: V): string {
  return opts.find((o) => Object.is(o.value, v))?.label ?? String(v);
}

function TypoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1 text-[11px] text-fg-dim">{title}</div>
      {children}
    </section>
  );
}

function TypoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5">
      <span className="w-11 shrink-0 text-[11px] text-fg-dim">{label}</span>
      {children}
    </div>
  );
}

/** 값 하나만 실어 보내는 숫자 필드들. 키가 바뀌어도 라벨·히스토리 규칙이 한 곳에 남는다. */
type TypoNumKey =
  | "lineHeight"
  | "letterSpacing"
  | "paragraphSpacing"
  | "indent"
  | "listLevel";

function TextTab({
  nodes,
  fontSize,
  onFontSize,
  onTypo,
  onLiveEnd,
}: {
  nodes: readonly Node[];
  /** 뱃지도 쓰는 값이라 `typo` 가 아니라 `fontSize` 슬롯으로 나간다. */
  fontSize: Maybe<number> | undefined;
  onFontSize(v: number, live?: boolean): void;
  onTypo(patch: Partial<TextStyle>, label: string, live?: boolean): void;
  onLiveEnd(): void;
}) {
  const texts = nodes.filter((n): n is TextNode => n.kind === "text");
  // 빈 선택에서 `mixedTextStyle` 은 모든 필드가 undefined 다 — 세 상태를 지키는 `NumField` 는
  // 그래도 되지만 `Select`·`Toggle` 은 값 하나를 요구하므로 아예 그리지 않는다.
  const t = texts.length ? mixedTextStyle(texts) : null;

  const numField = (
    key: TypoNumKey,
    label: string,
    unit: "px" | "%" | undefined,
    min: number,
    max: number,
    step = 1,
  ) => (
    <NumField
      label={label}
      value={t?.[key]}
      unit={unit}
      min={min}
      max={max}
      step={step}
      onCommit={(v) => onTypo({ [key]: v } as Partial<TextStyle>, `${label} ${v}`)}
      onLive={(v) => onTypo({ [key]: v } as Partial<TextStyle>, `${label} ${v}`, true)}
      onLiveEnd={onLiveEnd}
    />
  );

  const pick = <K extends "align" | "valign" | "resize" | "list" | "textCase" | "script">(
    key: K,
    label: string,
    opts: readonly SelectOption<TextStyle[K]>[],
    value: Maybe<TextStyle[K]>,
  ) => (
    <TypoRow label={label}>
      <Select
        label={label}
        value={value}
        options={opts}
        onChange={(v) =>
          onTypo({ [key]: v } as Partial<TextStyle>, `${label} ${optLabel(opts, v)}`)
        }
      />
    </TypoRow>
  );

  return (
    <>
      <TypoSection title="타이포그래피">
        <NumField
          label="글자 크기"
          value={fontSize}
          unit="px"
          min={4}
          max={400}
          onCommit={(v) => onFontSize(v)}
          onLive={(v) => onFontSize(v, true)}
          onLiveEnd={onLiveEnd}
        />
        {/* 행간·자간은 **%** 다(37 결정) — px 로 두면 캡션 11px 과 제목 28px 사이에서 같은
            숫자가 전혀 다른 간격이 된다. px 환산은 `layoutText` 한 곳에서만 한다. */}
        {t && numField("lineHeight", "행간", "%", 25, 400, 5)}
        {t && numField("letterSpacing", "자간", "%", -50, 200)}
      </TypoSection>

      {t && (
        <>
          <TypoSection title="문단">
            {pick("align", "정렬", ALIGN_OPTS, t.align)}
            {numField("paragraphSpacing", "문단 간격", "px", 0, 400)}
            {numField("indent", "들여쓰기", "px", 0, 400)}
            {pick("list", "목록", LIST_OPTS, t.list)}
            {/* 수준은 목록이 있을 때만 뜻이 있다 — 없는데 보이면 아무 일도 안 하는 칸이 된다. */}
            {t.list !== "none" && numField("listLevel", "수준", undefined, 0, 8)}
          </TypoSection>

          <TypoSection title="상자">
            {pick("resize", "크기", RESIZE_OPTS, t.resize)}
            {/* 세로 정렬은 남는 높이를 나누는 값이라 `고정` 상자에서만 움직인다(§3.2). */}
            {pick("valign", "세로", VALIGN_OPTS, t.valign)}
            <NumField
              label="말줄임"
              // 0 = 자르지 않음. `null` 을 빈 칸으로 그리면 "값 없음"(필드를 숨기는 상태)과
              // 구분되지 않아, 말줄임을 끄는 방법이 화면에서 사라진다.
              value={t.truncateLines === MIXED ? MIXED : (t.truncateLines ?? 0)}
              min={0}
              max={99}
              onCommit={(v) =>
                onTypo(
                  { truncateLines: v >= 1 ? v : null },
                  v >= 1 ? `말줄임 ${v}줄` : "말줄임 해제",
                )
              }
            />
          </TypoSection>

          <TypoSection title="장식">
            <Toggle
              label="밑줄"
              checked={t.underline}
              onChange={(v) => onTypo({ underline: v }, v ? "밑줄" : "밑줄 해제")}
            />
            <Toggle
              label="취소선"
              checked={t.strike}
              onChange={(v) => onTypo({ strike: v }, v ? "취소선" : "취소선 해제")}
            />
            {pick("textCase", "대소문자", CASE_OPTS, t.textCase)}
            {pick("script", "첨자", SCRIPT_OPTS, t.script)}
          </TypoSection>
        </>
      )}
    </>
  );
}
