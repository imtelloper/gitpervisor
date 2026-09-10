// 이미지 주석(마크업) 문서 모델 v2 — 기하·렌더·히스토리·영속이 공유하는 단일 타입 소스.
//
// 좌표·크기는 **전부 oriented px**(회전·반전이 적용된 원본 해상도 공간)다. 프리뷰 다운스케일,
// 크롭 원점 이동, 리사이즈 배율은 렌더 시점에 SceneTransform 으로만 곱해지므로 여기 담긴
// 숫자는 화면 상태와 무관하다. 배경: DOCS/image-annotation-design.md §3, DOCS/task/37-image-doc-model-v2.md
//
// **리프 좌표는 세계 oriented px 하나**다(중첩 행렬 0). 그룹은 기하가 없고 프레임만 세계 rect 를
// 가진다 — 그래서 geometry.ts·render.ts 는 `GeomNode` 만 받고 `group`/`instance` 를 넘기면
// 컴파일 에러다. 컨테이너 AABB 는 tree.nodeAABB 가 자손 합집합으로 파생한다(태스크 38).
//
// 객체는 **불변**으로 갱신한다 — 바뀐 객체만 새 참조를 만든다. 히스토리가 문서 전체를
// 스냅샷해도 실제 복제되는 것은 변경분뿐이다. `objects` 는 커밋마다 새 배열이어야 한다
// (AnnotationLayer 의 커밋 캐시가 배열 참조 비교로 재사용을 판정한다).
//
// 이 트랙(37~52)의 타입은 **이 파일 하나**가 소유한다. 다른 모듈은 import 만 하고,
// 같은 개념에 두 이름을 두지 않는다(DOCS/task/00-INDEX.md §10.4).

/** 주석 객체 식별자. `newObjId()` 의 uuid 또는 인스턴스 자식의 `${instanceId}/${masterChildId}`. */
export type ObjId = string;
/** 스타일 라이브러리 항목 id(태스크 51). */
export type StyleId = string;
/** 컴포넌트 마스터 id(태스크 51). */
export type ComponentId = string;
/** 문서에 내장된 에셋(이미지 페인트 소스) id(태스크 41). */
export type AssetId = string;

/**
 * 도구로 직접 만들 수 있는 노드 종류.
 *
 * `Tool` 은 여기 없다 — 도구는 문서가 아니라 화면 상태라 `stores/imageEditor.ts` 가 갖는다
 * (42 §3.1). 문서 타입에 두면 레일 22종이 정규화 경계까지 흘러 들어간다.
 * `path`·`frame`·`group`·`instance` 는 도구가 아니라 연산·인스펙터로 생긴다(태스크 45·46).
 */
export const TOOL_KINDS = [
  "pen",
  "highlight",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "badge",
  "mosaic",
] as const;

/** oriented px 사각형. 크롭·바운딩 박스·도형 영역 공통. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── 스타일 값 (시안 ①④ 인스펙터) ────────────────────────────────────────────

/**
 * 블렌드 모드 19종 — canvas `globalCompositeOperation` 철자를 그대로 쓴다(렌더에 매핑표가 없다).
 * `pass-through` 는 컨테이너(group/frame/instance) 전용이며, 정규화가 리프에서는 `normal` 로 바꾼다.
 * `linear-burn` 만 canvas 에 없어 렌더가 invert∘lighter∘invert 로 합성한다(태스크 39 §3.4).
 */
export type BlendMode =
  | "pass-through"
  | "normal"
  | "darken"
  | "multiply"
  | "linear-burn"
  | "color-burn"
  | "lighten"
  | "screen"
  | "linear-dodge"
  | "color-dodge"
  | "overlay"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/**
 * 블렌드 19종 — **정규화 검증용 집합**이다(schema.ts `pick` 이 포함 여부만 본다).
 *
 * 순서는 렌더 매핑 순서라 시안 ④ 드롭다운과 **다르다**(시안은 `색상 번 → 선형 번`,
 * `색상 닷지 → 선형 닷지`, 여기는 반대). 표시 순서·구분선의 정본은 `blend-labels.ts` 다 —
 * 이 배열로 목록을 그리면 사용자가 보는 순서가 시안과 어긋난다. 반대로 이 배열을 시안 순서에
 * 맞추려고 재배열하는 것도 의미가 없다(집합만 쓰이므로 검증 결과가 안 바뀐다).
 */
export const BLEND_MODES: readonly BlendMode[] = [
  "pass-through",
  "normal",
  "darken",
  "multiply",
  "linear-burn",
  "color-burn",
  "lighten",
  "screen",
  "linear-dodge",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

/** 그라디언트 스톱. `pos` 는 0–1. */
export interface PaintStop {
  pos: number;
  color: string;
  opacity: number;
}

/**
 * 채우기/선 한 겹의 값. 판별자는 `type`, 알파는 `opacity`, 스톱 위치는 `pos` 로 통일한다.
 * (kind/alpha/at/offset 혼용을 막는다 — 변환표가 생기면 렌더가 두 갈래가 된다.)
 */
export type Paint =
  | { type: "solid"; color: string; opacity: number }
  | {
      type: "linear" | "radial" | "angular" | "diamond";
      stops: PaintStop[];
      /** deg. 시안 ④ `각도 135°`. */
      angle: number;
      /** 1 = bbox 에 꽉 참. */
      scale: number;
    }
  | { type: "image"; assetId: AssetId; mode: "fill" | "fit" | "stretch" };

/** 노드의 `fills`/`strokes` 스택 한 항목 — 페인트 + 표시/블렌드. */
export type Fill = Paint & { visible: boolean; blend: BlendMode };

/** 효과 스택 한 항목(시안 ① `드롭 섀도 0·4·12·25%` / `레이어 블러 반경 4`). */
export type Effect =
  | {
      type: "drop-shadow" | "inner-shadow";
      x: number;
      y: number;
      blur: number;
      spread: number;
      color: string;
      opacity: number;
      visible: boolean;
    }
  | { type: "layer-blur" | "background-blur"; radius: number; visible: boolean };

/** 노드 인스펙터의 내보내기 행(시안 ① `1x · 접미사 · PNG`). 태스크 52 가 소비한다. */
export interface ExportRow {
  scale: number | { width: number };
  suffix: string;
  format: "png" | "jpg" | "webp" | "avif";
  quality: number;
  /** 정규화 기본 'srgb' — 태스크 52 §3.4. */
  profile?: "srgb" | "display-p3";
}

/**
 * 인스턴스가 마스터 자식에 덮어쓰는 값(태스크 51 §4).
 *
 * `NodeBase` 공통분(페인트·표시·블렌드)과 타이포 외에 **kind 별 값 키**를 명시로 더한다 —
 * 재정의는 `diffInstance` 가 커밋 때 파생하는데(51 §3.5), 여기 없는 키는 타입이 막아 놓고
 * 런타임에서만 실려 오는 유령 필드가 된다. 반대로 기하 키(x/y/w/h/rot/pts/…)는 **일부러
 * 뺐다**: 자식 위치·크기 재정의를 허용하면 마스터 구조 변경과 3-way 병합을 해야 한다.
 */
export type InstanceOverride = Partial<
  Omit<NodeBase, "id" | "parentId" | "constraints" | "mask" | "exportRows" | "locked">
> &
  Partial<TextStyle> & {
    text?: string;
    radius?: RectObject["radius"];
    n?: number;
    fontSize?: number;
    mode?: MosaicMode;
    strength?: number;
    fillRule?: PathNode["fillRule"];
    clipsContent?: boolean;
  };

// ── 노드 ────────────────────────────────────────────────────────────────────

/**
 * 모든 노드의 공통 속성.
 *
 * `strokeWidth` 는 **v1 이름·의미 그대로**(노드 하나의 두께)다 — 색만 `strokes` 스택으로 쌓는다.
 * 시안 ①③ 의 선 섹션도 두께·정렬이 단일이라 UI 와 모델이 같은 모양이다.
 */
export interface NodeBase {
  id: ObjId;
  /** 부모 컨테이너 id. 최상위는 null. 트리 불변식은 태스크 38 assertTreeInvariant. */
  parentId: ObjId | null;
  /** null 이면 레이어 패널이 kind 기반 기본 이름을 만든다(태스크 44 defaultLayerName). */
  name: string | null;
  visible: boolean;
  locked: boolean;
  /** 0–1. */
  opacity: number;
  blend: BlendMode;
  /** 회전각(deg, 앵커/중심 기준). */
  rot: number;
  fills: Fill[];
  strokes: Fill[];
  /** 선 두께(oriented px). 0 이면 선을 그리지 않는다. */
  strokeWidth: number;
  strokeAlign: "inside" | "center" | "outside";
  /** [대시, 간격, …] oriented px. null = 실선. */
  dash: number[] | null;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  miterLimit: number;
  heads: { start: "none" | "arrow"; end: "none" | "arrow" };
  effects: Effect[];
  constraints: {
    h: "left" | "right" | "center" | "scale" | "stretch";
    v: "top" | "bottom" | "center" | "scale" | "stretch";
  };
  /** 마스크로 쓰이는 노드. 범위(뒤 형제)는 태스크 38 maskScope 가 해석한다. */
  mask: { mode: "shape" | "alpha"; invert: boolean } | null;
  exportRows: ExportRow[];
  /** 적용된 라이브러리 스타일 참조(태스크 51). 직접 편집하면 정규화가 떼어 낸다. */
  styleRefs: { fill?: StyleId; stroke?: StyleId; text?: StyleId; effect?: StyleId };
}

/** 자유곡선. `pts` 는 평탄 배열 [x0,y0,x1,y1,…] — 스냅샷 복사와 델타 아핀이 루프 하나로 끝난다. */
export interface PenObject extends NodeBase {
  kind: "pen" | "highlight";
  pts: number[];
}

/**
 * 직선 / 화살표.
 *
 * `head` 는 v1 필드다 — 정규화가 `heads` 를 채우면서도 이 필드를 **남긴다**(render shim 호환).
 * 태스크 39 가 `heads` 만 읽도록 바꾸면서 제거한다.
 */
export interface LineObject extends NodeBase {
  kind: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  head: "end" | "both";
}

/** 사각형. 모서리 반경은 [tl, tr, br, bl] — 시안 ① `↖8 ↗8 ↘8 ↙8`. */
export interface RectObject extends NodeBase {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  radius: [number, number, number, number];
}

/** 타원. */
export interface EllipseObject extends NodeBase {
  kind: "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 번호 뱃지. (x,y) 는 원의 중심. 원 색은 `fills`, 숫자 색은 `strokes` 가 아니라 렌더 규칙이다. */
export interface BadgeObject extends NodeBase {
  kind: "badge";
  x: number;
  y: number;
  n: number;
  fontSize: number;
}

/** 모자이크 강도 모드. */
export type MosaicMode = "pixelate" | "blur";

/**
 * 모자이크/블러 영역.
 *
 * 효과 스택의 `background-blur` 와 기제를 공유하지만(태스크 39 effects.ts 의 같은 함수),
 * **kind 로 남긴다** — e2e 30 의 누수 단언 (j)(r)(s) 가 이 kind 위에 서 있다.
 */
export interface MosaicObject extends NodeBase {
  kind: "mosaic";
  x: number;
  y: number;
  w: number;
  h: number;
  mode: MosaicMode;
  /** 셀 크기(pixelate) 또는 블러 반경(blur) — 단위는 oriented px. */
  strength: number;
}

/** 패스 정점. 핸들(in/out)은 정점 **상대** 좌표, (0,0)이면 핸들 없음. 시안 ③. */
export interface PathVert {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  mode: "corner" | "mirrored" | "asymmetric" | "auto";
}

/** 베지어 패스(태스크 46·47). 서브패스마다 열림/닫힘. */
export interface PathNode extends NodeBase {
  kind: "path";
  subpaths: { verts: PathVert[]; closed: boolean }[];
  fillRule: "nonzero" | "evenodd";
}

/** 프레임 — 기하가 있는 컨테이너. 자식은 objects 평탄 슬라이스다. */
export interface FrameNode extends NodeBase {
  kind: "frame";
  x: number;
  y: number;
  w: number;
  h: number;
  radius: [number, number, number, number];
  clipsContent: boolean;
}

/** 그룹 — 기하 없음. AABB 는 tree.nodeAABB 가 자손에서 파생한다(태스크 38). */
export interface GroupNode extends NodeBase {
  kind: "group";
  /** 인스턴스에서 분리돼 나온 그룹이면 원래 마스터(태스크 51). */
  detachedFrom?: ComponentId;
}

/**
 * 컴포넌트 인스턴스(태스크 51). 자식은 **물질화**돼 objects 평탄 슬라이스로 존재한다
 * (`children` 배열 없음 — 트리 불변식이 하나다). 자식 id 는 `${instanceId}/${masterChildId}`.
 */
export interface InstanceNode extends NodeBase {
  kind: "instance";
  componentId: ComponentId;
  overrides: Record<ObjId, InstanceOverride>;
}

/** 텍스트 타이포 속성(시안 ②). 태스크 49·50 이 소비한다. */
export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: number;
  /** % — 125 = 1.25배. */
  lineHeight: number;
  /** % — 시안 ② `자간 −0.2`. */
  letterSpacing: number;
  paragraphSpacing: number;
  indent: number;
  align: "left" | "center" | "right" | "justify";
  valign: "top" | "middle" | "bottom";
  resize: "auto-width" | "auto-height" | "fixed";
  underline: boolean;
  strike: boolean;
  script: "none" | "super" | "sub";
  textCase: "none" | "upper" | "lower";
  list: "none" | "bullet" | "number" | "check";
  listLevel: number;
  /** 말줄임 줄 수. null = 자르지 않음. */
  truncateLines: number | null;
  features: { liga: boolean; onum: boolean; tnum: boolean; frac: boolean };
}

/** 텍스트 노드. (x,y) 는 첫 줄의 좌상단(앵커) — 회전 피벗도 여기다. */
export type TextNode = NodeBase &
  TextStyle & {
    kind: "text";
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
  };

/** 기하를 직접 갖는 말단 노드. */
export type LeafNode =
  | PenObject
  | LineObject
  | RectObject
  | EllipseObject
  | TextNode
  | BadgeObject
  | MosaicObject
  | PathNode;

/**
 * geometry.ts·render.ts 가 받는 **유일한** 타입.
 * `group`/`instance` 를 넘기면 컴파일 에러다 — 기하 없는 컨테이너가 AABB 를 부풀리는 사고를
 * 타입이 막는다(태스크 37 §3.1).
 */
export type GeomNode = LeafNode | FrameNode;

/** 문서에 담기는 모든 노드. */
export type Node = GeomNode | GroupNode | InstanceNode;

/** 판별 태그 모음. */
export type NodeKind = Node["kind"];

/** 컨테이너 kind — 자식을 갖는 노드. */
export type ContainerKind = "group" | "frame" | "instance";

/**
 * 히스토리에 스냅샷되는 편집 문서 전체.
 *
 * `objects` 는 **DFS 전순 평탄 배열**이다 — 자손은 컨테이너 바로 뒤에 연속으로 오고, 뒤가 위(z)다.
 * 재배열은 tree.ts 함수로만 한다(직접 splice 금지). 불변식 검사는 태스크 38 assertTreeInvariant.
 */
export interface EditorDoc {
  v: 2;
  objects: Node[];
  /** 이미지 페인트 소스. base64 data(태스크 41 — 16MB/16MP 상한). */
  assets: Record<AssetId, { mime: string; w: number; h: number; data: string }>;
  /** 눈금자에서 끌어낸 가이드(태스크 43). */
  guides: { axis: "x" | "y"; pos: number }[];
  /** 벡터 모양으로 이미지를 자른다(시안 ⑦). */
  imageMask: { id: ObjId; mode: "shape" | "alpha"; invert: boolean } | null;
  /** 직선화 각(deg, 시안 ⑦ `1.4°`) — 태스크 48. */
  straighten: number;
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  crop: Rect | null;
  outW: number;
  outH: number;
  brightness: number;
  contrast: number;
  saturate: number;
}

/**
 * oriented px → 대상 캔버스 px 변환. 크롭 원점 이동 후 배율을 곱한다:
 * `target = (p + t) * s`. 프리뷰는 `{0,0,s,s}`, 출력은 `{−crop.x,−crop.y,outW/sw,outH/sh}`.
 *
 * 계약상 render.ts 의 공개 타입이지만 geometry 도 참조하므로 순환 import 를 피해
 * 여기 두고 render.ts 가 재수출한다.
 */
export interface SceneTransform {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

// ── 스타일·컴포넌트 라이브러리 (태스크 51) ──────────────────────────────────
//
// 라이브러리는 **문서 밖**에 산다(앱 전역 파일 하나 — 51 §3.1). 노드에는 값이 복사되고
// `styleRefs[slot]` 에 id 만 남으므로, 라이브러리가 지워져도·다른 머신에서 열어도 문서는
// 자기완결이다. 렌더·히트·AABB 가 라이브러리를 읽는 순간 WYSIWYG 와 히스토리 결정론이
// 깨진다(00-INDEX §10.4) — 그래서 이 타입들은 `EditorDoc` 에 들어가지 않는다.

/** 색 스타일 1개. `name` 은 경로 하나(`'상태 / 경고 / 핑크'`) — 첫 세그먼트가 섹션이다. */
export interface ColorStyle {
  id: StyleId;
  name: string;
  paint: Fill;
  updatedAt: number;
}

/**
 * 텍스트 스타일이 싣는 타이포 키만 추린 것.
 *
 * `align`/`valign`/`resize`/`list`/`truncateLines` 등이 빠진 이유: 그것들은 **글자 모양이
 * 아니라 상자 배치**라, 스타일을 적용했다고 문단 정렬이나 자동 크기 모드까지 바뀌면
 * 사용자는 스타일 하나로 레이아웃이 흐트러지는 경험을 한다(시안 ② 목록도 글꼴·크기·행간만 든다).
 */
export type TextStyleProps = Pick<
  TextStyle,
  | "fontFamily"
  | "fontWeight"
  | "italic"
  | "fontSize"
  | "lineHeight"
  | "letterSpacing"
  | "paragraphSpacing"
  | "indent"
  | "underline"
  | "strike"
  | "textCase"
  | "features"
>;

/** 텍스트 스타일 1개(시안 ② `제목 / H1`). */
export interface TextStyleDef {
  id: StyleId;
  name: string;
  style: TextStyleProps;
  updatedAt: number;
}

/** 효과 스타일 1개 — 스택 통째가 한 항목이다(시안 ① 효과 섹션). */
export interface EffectStyle {
  id: StyleId;
  name: string;
  effects: Effect[];
  updatedAt: number;
}

/**
 * 컴포넌트 마스터 1개.
 *
 * `nodes[0]` 은 **반드시 `(0,0,w,h)`·rot 0 의 루트 `FrameNode`** 고 나머지는 그 로컬 좌표의
 * 자손이다(DFS 전순). 인스턴스의 위치·크기·회전을 그 프레임 자식이 들기 때문에(51 §3.4)
 * 이 불변식이 깨지면 재물질화(`applyConstraints` → `rotateNodes`)가 기준 rect 를 잃는다.
 */
export interface ComponentDef {
  id: ComponentId;
  name: string;
  nodes: Node[];
  w: number;
  h: number;
  /** `data:image/png` ≤96px. 생성 실패 시 빈 문자열 — 카드는 이름만 그린다. */
  thumb: string;
  updatedAt: number;
}

/**
 * 라이브러리 1벌 = `app_data_dir/image-library.json` 의 `library` 키 값.
 *
 * `seeded` 는 내장 텍스트 스타일 3종을 심었는지다 — 사용자가 지운 것을 다음 실행이 되살리면
 * 지우는 행위 자체가 무의미해진다.
 */
export interface ImageLibrary {
  v: 1;
  colorStyles: ColorStyle[];
  textStyles: TextStyleDef[];
  effectStyles: EffectStyle[];
  components: ComponentDef[];
  seeded: boolean;
}

// ── 기본 속성값 ──────────────────────────────────────────────────────────────

/** 기본 색 — 스크린샷 강조 관례상 빨강. */
export const DEFAULT_STROKE = "#FF3B30";

/** 팔레트 8색 + 세션 최근 사용 기억은 툴바 몫. */
export const PALETTE: readonly string[] = [
  "#FF3B30", // 빨강
  "#FF9500", // 주황
  "#FFCC00", // 노랑
  "#34C759", // 초록
  "#0A84FF", // 파랑
  "#AF52DE", // 보라
  "#FFFFFF", // 흰색
  "#1C1C1E", // 검정
];

export const DEFAULT_STROKE_WIDTH = 4;
export const DEFAULT_OPACITY = 1;

/** 형광펜은 알파 0.35 + multiply 블렌드로 그린다. */
export const HIGHLIGHT_OPACITY = 0.35;
/** 형광펜 기본 두께는 펜의 4배 — 마커 느낌을 낸다. */
export const HIGHLIGHT_WIDTH_SCALE = 4;

export const DEFAULT_FONT_SIZE = 24;
/**
 * 앱 기본 산세리프 스택(styles.css `--font-sans` 와 동일 문자열).
 * 캔버스 `ctx.font` 는 CSS 변수를 못 읽으므로 리터럴로 둔다. textarea 오버레이도 같은 값을
 * 써야 편집 중/확정 후 메트릭이 어긋나지 않는다(폰트 일치 계약).
 */
export const DEFAULT_FONT_FAMILY =
  '"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';
/** 줄 간격 배수 — 캔버스 여러 줄 레이아웃과 textarea line-height 가 공유한다. */
export const TEXT_LINE_HEIGHT = 1.25;

/** 화살촉 길이 = 4 × strokeWidth. */
export const ARROW_HEAD_SCALE = 4;
/** 뱃지 원 반지름 = 0.9 × fontSize. */
export const BADGE_RADIUS_SCALE = 0.9;

export const DEFAULT_RECT_RADIUS = 0;
/** 블러는 원본 추정 공격에 상대적으로 약하다 — 기본은 픽셀화. */
export const DEFAULT_MOSAIC_MODE: MosaicMode = "pixelate";
export const DEFAULT_MOSAIC_STRENGTH = 12;

/** 펜 점 데시메이션 임계(oriented px) — 직전 점과 이보다 가까우면 버린다. */
export const PEN_MIN_DIST = 1.5;
/** 히트테스트 스트로크 허용오차(css px). oriented 로는 `10 / s` 가 된다. */
export const HIT_TOLERANCE_CSS = 10;
/** Shift 드래그 각도 스냅 단위(deg) — 직선·화살표. */
export const SHIFT_SNAP_DEG = 15;
/** Ctrl+D 복제 오프셋(oriented px). */
export const DUPLICATE_OFFSET = 8;

/** 텍스트 노드의 타이포 기본값 — 정규화와 makeDraft 가 공유한다. */
export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontWeight: 400,
  italic: false,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: TEXT_LINE_HEIGHT * 100,
  letterSpacing: 0,
  paragraphSpacing: 0,
  indent: 0,
  align: "left",
  valign: "top",
  resize: "auto-width",
  underline: false,
  strike: false,
  script: "none",
  textCase: "none",
  list: "none",
  listLevel: 0,
  truncateLines: null,
  features: { liga: true, onum: false, tnum: false, frac: false },
};

/**
 * 툴바가 들고 있는 "다음에 만들 객체"의 속성. 선택된 객체 편집에도 같은 필드를 쓴다.
 * (v1 `ToolStyle` 대체 — 단색 하나가 아니라 페인트 스택을 든다.)
 */
export interface DefaultPaint {
  fills: Fill[];
  strokes: Fill[];
  strokeWidth: number;
  radius: [number, number, number, number];
  fontSize: number;
  mosaicMode: MosaicMode;
  mosaicStrength: number;
  /**
   * 타이포 한 벌. 들고 있는 값은 **항상 완전한** `TextStyle` 이고, 패치로 올 때만
   * `Partial` 이다(`schema.PaintPatch`). 반쪽짜리를 들면 다음에 만들 텍스트가 어떤 필드는
   * 툴바 값, 어떤 필드는 정규화 기본값을 갖게 돼 "지금 고른 스타일"이 무엇인지 화면에서
   * 갈린다. 기본값은 `DEFAULT_TEXT_STYLE` — 정규화가 쓰는 그 상수여야 새 텍스트와
   * 정규화된 텍스트가 같은 자리에서 시작한다(태스크 49 §4).
   */
  typo: TextStyle;
}

/** 단색 Fill 한 겹을 만든다(정규화·기본값·업그레이드가 공유). */
export function solidFill(color: string, opacity = 1): Fill {
  return { type: "solid", color, opacity, visible: true, blend: "normal" };
}

export const DEFAULT_PAINT: DefaultPaint = {
  fills: [],
  strokes: [solidFill(DEFAULT_STROKE)],
  strokeWidth: DEFAULT_STROKE_WIDTH,
  radius: [DEFAULT_RECT_RADIUS, DEFAULT_RECT_RADIUS, DEFAULT_RECT_RADIUS, DEFAULT_RECT_RADIUS],
  fontSize: DEFAULT_FONT_SIZE,
  mosaicMode: DEFAULT_MOSAIC_MODE,
  mosaicStrength: DEFAULT_MOSAIC_STRENGTH,
  typo: DEFAULT_TEXT_STYLE,
};

/** 새 객체 id. Tauri webview 는 보안 컨텍스트라 randomUUID 를 항상 쓸 수 있다. */
export function newObjId(): ObjId {
  return crypto.randomUUID();
}
