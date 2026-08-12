// 이미지 주석(마크업) 객체 모델 — 기하·렌더·히스토리가 공유하는 단일 타입 소스.
//
// 좌표·크기는 **전부 oriented px**(회전·반전이 적용된 원본 해상도 공간)다. 프리뷰 다운스케일,
// 크롭 원점 이동, 리사이즈 배율은 렌더 시점에 SceneTransform 으로만 곱해지므로 여기 담긴
// 숫자는 화면 상태와 무관하다. 배경: DOCS/image-annotation-design.md §3, §5.1
//
// 객체는 **불변**으로 갱신한다 — 바뀐 객체만 새 참조를 만든다. 히스토리가 문서 전체를
// 스냅샷해도 실제 복제되는 것은 변경분뿐이다(§5.3).

/** 주석 객체 식별자. */
export type ObjId = string;

/** 팔레트에서 고를 수 있는 도구(§5.2). `select` 만 객체를 만들지 않는다. */
export type Tool =
  | "select"
  | "pen"
  | "highlight"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text"
  | "badge"
  | "mosaic";

/** oriented px 사각형. 크롭·바운딩 박스·도형 영역 공통. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 모든 주석 객체가 갖는 공통 속성. */
interface Common {
  id: ObjId;
  /** #rrggbb — 선/글자 색. */
  stroke: string;
  /** 선 두께(oriented px). */
  strokeWidth: number;
  /** 0–1. */
  opacity: number;
  /**
   * 회전각(deg, 앵커/중심 기준). v1 에서는 이미지 회전 델타로만 생긴다 — 회전 핸들 UI 는 v2.
   * 데이터·렌더는 미리 지원하므로 추가가 순증이다(§5.1).
   */
  rot: number;
}

/** 자유곡선. `pts` 는 평탄 배열 [x0,y0,x1,y1,…] — 스냅샷 복사와 델타 아핀이 루프 하나로 끝난다. */
export interface PenObject extends Common {
  kind: "pen" | "highlight";
  pts: number[];
}

/** 직선 / 화살표. `head` 는 화살촉 위치. */
export interface LineObject extends Common {
  kind: "line" | "arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  head: "end" | "both";
}

/** 사각형(모서리 반경 지원). `fill` 이 null 이면 테두리만. */
export interface RectObject extends Common {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  radius: number;
}

/** 타원. */
export interface EllipseObject extends Common {
  kind: "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
}

/** 텍스트. (x,y) 는 첫 줄의 좌상단(앵커) — 회전 피벗도 여기다. */
export interface TextObject extends Common {
  kind: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily: string;
}

/** 번호 뱃지. (x,y) 는 원의 중심. */
export interface BadgeObject extends Common {
  kind: "badge";
  x: number;
  y: number;
  n: number;
  fontSize: number;
  fill: string;
}

/** 모자이크 강도 모드. */
export type MosaicMode = "pixelate" | "blur";

/** 모자이크/블러 영역. 색·불투명도는 쓰지 않지만 Common 을 공유해 조작 코드가 단일해진다. */
export interface MosaicObject extends Common {
  kind: "mosaic";
  x: number;
  y: number;
  w: number;
  h: number;
  mode: MosaicMode;
  /** 셀 크기(pixelate) 또는 블러 반경(blur) — 단위는 oriented px. */
  strength: number;
}

export type AnnoObject =
  | PenObject
  | LineObject
  | RectObject
  | EllipseObject
  | TextObject
  | BadgeObject
  | MosaicObject;

/** 판별 태그 모음. */
export type AnnoKind = AnnoObject["kind"];

/**
 * 히스토리에 스냅샷되는 편집 문서 전체(§5.1).
 *
 * 주석만이 아니라 방향·크롭·색보정까지 담는 이유: 회전이 주석 기하를 변형하므로(§3.2)
 * 주석만 되돌리면 좌표 공간이 어긋난다. 이미지 픽셀은 문서에 없으므로 크기는 무시할 만하다.
 */
export interface EditorDoc {
  objects: AnnoObject[];
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
 * `target = (p + t) * s`. 프리뷰는 `{0,0,s,s}`, 출력은 `{−crop.x,−crop.y,outW/sw,outH/sh}`(§4.1).
 *
 * 계약상 render.ts 의 공개 타입이지만(설계 §4.1) geometry 도 참조하므로 순환 import 를 피해
 * 여기 두고 render.ts 가 재수출한다.
 */
export interface SceneTransform {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

// ── 기본 속성값 (§12) ────────────────────────────────────────────────────────

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

/** 형광펜은 알파 0.35 + multiply 블렌드로 그린다(§5.2). */
export const HIGHLIGHT_OPACITY = 0.35;
/** 형광펜 기본 두께는 펜의 4배 — 마커 느낌을 낸다. */
export const HIGHLIGHT_WIDTH_SCALE = 4;

export const DEFAULT_FONT_SIZE = 24;
/**
 * 앱 기본 산세리프 스택(styles.css `--font-sans` 와 동일 문자열).
 * 캔버스 `ctx.font` 는 CSS 변수를 못 읽으므로 리터럴로 둔다. textarea 오버레이도 같은 값을
 * 써야 편집 중/확정 후 메트릭이 어긋나지 않는다(§5.5 폰트 일치 계약).
 */
export const DEFAULT_FONT_FAMILY =
  '"Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';
/** 줄 간격 배수 — 캔버스 여러 줄 레이아웃과 textarea line-height 가 공유한다. */
export const TEXT_LINE_HEIGHT = 1.25;

/** 화살촉 길이 = 4 × strokeWidth (§5.2). */
export const ARROW_HEAD_SCALE = 4;
/** 뱃지 원 반지름 = 0.9 × fontSize (§5.2). */
export const BADGE_RADIUS_SCALE = 0.9;

export const DEFAULT_RECT_RADIUS = 0;
/** 블러는 원본 추정 공격에 상대적으로 약하다 — 기본은 픽셀화(§12). */
export const DEFAULT_MOSAIC_MODE: MosaicMode = "pixelate";
export const DEFAULT_MOSAIC_STRENGTH = 12;

/** 펜 점 데시메이션 임계(oriented px) — 직전 점과 이보다 가까우면 버린다(§4.4). */
export const PEN_MIN_DIST = 1.5;
/** 히트테스트 스트로크 허용오차(css px). oriented 로는 `10 / s` 가 된다(§5.6). */
export const HIT_TOLERANCE_CSS = 10;
/** Shift 드래그 각도 스냅 단위(deg) — 직선·화살표(§5.2). */
export const SHIFT_SNAP_DEG = 15;
/** Ctrl+D 복제 오프셋(oriented px, §5.6). */
export const DUPLICATE_OFFSET = 8;

/** 툴바가 들고 있는 "다음에 만들 객체"의 속성. 선택된 객체 편집에도 같은 필드를 쓴다. */
export interface ToolStyle {
  stroke: string;
  strokeWidth: number;
  fill: string | null;
  radius: number;
  fontSize: number;
  mosaicMode: MosaicMode;
  mosaicStrength: number;
}

export const DEFAULT_STYLE: ToolStyle = {
  stroke: DEFAULT_STROKE,
  strokeWidth: DEFAULT_STROKE_WIDTH,
  fill: null,
  radius: DEFAULT_RECT_RADIUS,
  fontSize: DEFAULT_FONT_SIZE,
  mosaicMode: DEFAULT_MOSAIC_MODE,
  mosaicStrength: DEFAULT_MOSAIC_STRENGTH,
};

/** 새 객체 id. Tauri webview 는 보안 컨텍스트라 randomUUID 를 항상 쓸 수 있다. */
export function newObjId(): ObjId {
  return crypto.randomUUID();
}
