// 화면 크롬의 **상태 타입과 눈금자 산술** — React·DOM 이 없는 절반.
//
// 크롬(선택 상자·핸들·마퀴·HUD·가이드·스마트 가이드·측정·눈금자·크롭 오버레이)은 씬 캔버스가
// 아니라 stage 위 SVG 한 겹에 산다. 캔버스에 그리면 백킹 해상도(MAX_PREVIEW 1800)에 묶여
// 400% 로 확대하는 순간 1px 선이 4px 로 뭉개지고, 그 배율에서 뜨는 디테일 캔버스(40)가 위를
// 덮는다 — 편집하려고 확대한 바로 그때 크롬이 사라진다는 뜻이다.
//
// 그래서 이 파일이 지키는 것은 **좌표 규약**이다: 위치는 oriented px, 두께·반경은 css px.
// 둘을 섞으면 확대할수록 선이 굵어지거나(두께를 oriented 로 두면), 팬·줌 프레임마다 모든
// 좌표를 다시 계산해야 한다(위치를 css 로 두면). 오버레이는 oriented 값을 그릴 때만
// `ChromeScreen` 으로 곱한다 — 줌은 CSS transform 한 겹이라는 계약이 그대로 산다.
//
// 크롬은 저장·내보내기 경로(`renderScene`, 39)와 **DOM 부터** 갈라져 있다. 여기 상태가 아무리
// 늘어도 저장본에 샐 자리가 구조적으로 없다(e2e 30 (o-4)(p-5)).
//
// 배경: DOCS/task/43-image-chrome-snap.md §3.1·§3.3·§3.6

import type { Measure, SnapLine } from "./snap";
import type { Rect } from "./types";

/**
 * stage 안 세 겹의 z 순서 — **여기 한 곳**이 정본이다(40 `DetailCanvas`·ImageEditor 박스가 import).
 *
 * 크롬이 디테일 캔버스보다 아래로 내려가면 확대했을 때 선택 상자가 통째로 가려진다. 값을
 * 각 컴포넌트에 흩어 두면 그 회귀가 "확대하면 핸들이 안 보인다"로만 보고된다.
 */
export const STAGE_Z = { detail: 1, box: 2, chrome: 3 } as const;

/**
 * 크롬 전용 색(시안 `.pen` 토큰). Tailwind 토큰이 아닌 이유는 이 색들이 **주석 위에 얹히는
 * 계측 색**이라 테마를 따라가면 안 되기 때문이다 — 다크/라이트 어느 쪽에서도 같은 파랑·분홍이어야
 * 사용자가 "선택된 것"과 "그린 것"을 구분한다. SVG 속성에 문자열로 들어가므로 리터럴은 여기만.
 */
export const CHROME_COLORS = {
  /** 선택 상자·핸들·마퀴·HUD 뱃지(시안 `$sel`). */
  sel: "#3B82F6",
  /** 스마트 가이드·간격 뱃지·픽셀 스냅 셀(시안 `$smart`). */
  smart: "#F0398B",
  /** 사용자 가이드(시안 `$danger`). */
  guide: "#EF4444",
  /** 눈금자 띠 배경(시안 `$ruler`). */
  ruler: "#18181B",
} as const;

/**
 * oriented px → stage css px 변환에 필요한 전부. `getBoundingClientRect` 0 회로 산술만 한다.
 *
 * ```
 * css(x, y) = (x · scale + screen.x, y · scale + screen.y)
 * ```
 *
 * `x`/`y` 는 이미지 원점(oriented 0,0)의 stage 안 css 위치다(중앙 정렬 + 팬). `w`/`h` 는 stage,
 * `ow`/`oh` 는 oriented 이미지 크기 — 눈금자 길이와 캔버스 경계 스냅이 쓴다.
 */
export interface ChromeScreen {
  /** css px / oriented px. `displayScale · view.scale`. */
  scale: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ow: number;
  oh: number;
}

/**
 * 다른 태스크가 크롬에 얹는 임의 도형(47 노드 편집 핸들·스크림, 48 크롭 프리미티브,
 * 45 그라디언트 핸들). 종류를 늘리는 대신 이 5+1 종으로 표현한다.
 *
 * **좌표는 oriented px, 두께·반경(`…Css`)은 css px.** 이 갈림을 어기면 확대할 때 선이 같이
 * 굵어져 8px 핸들이 32px 덩어리가 된다 — 정확히 캔버스 크롬을 버린 이유(§3.1)를 되풀이한다.
 * 정사각 앵커(47)는 `rot: 0` 인 rect 로 그린다. 별도 종류를 만들지 마라.
 */
export type ChromePrim =
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; color?: string; dash?: boolean }
  | { k: "rect"; x: number; y: number; w: number; h: number; color?: string; fill?: string; rot?: number }
  | { k: "circle"; cx: number; cy: number; rCss: number; color?: string; fill?: string }
  | { k: "path"; d: string; color?: string; fill?: string }
  | { k: "text"; x: number; y: number; text: string; bg?: string }
  | {
      k: "scrim";
      color: string;
      alpha: number;
      /** oriented 좌표 SVG `d` — `<mask>` 로 뚫는다(47 노드 편집 격리). */
      cutoutD: string;
      cutoutStrokeCss?: number;
    };

/** 한 프레임에 그려질 크롬 전부. 오버레이는 이 값만 보고 DOM 속성을 쓴다(React state 0). */
export interface ChromeState {
  screen: ChromeScreen;
  /** 리프 1개면 회전 상자 + 핸들 8, 다중/컨테이너면 객체별 점선 상자(핸들 없음). */
  selection: {
    box: { rect: Rect; rot: number; anchor: { x: number; y: number } };
    handles: boolean;
  }[];
  unionBox: Rect | null;
  hover: Rect | null;
  marquee: Rect | null;
  hud: { text: string; at: { x: number; y: number } } | null;
  crop: {
    rect: Rect;
    overlay: "none" | "thirds" | "quarters" | "golden" | "diagonal";
    label: string | null;
    handles: boolean;
  } | null;
  guides: { axis: "x" | "y"; pos: number; selected?: boolean; preview?: boolean }[];
  smartGuides: SnapLine[];
  measures: Measure[];
  rulers: boolean;
  pixelGrid: boolean;
  extra: ChromePrim[];
}

/** 라벨이 서로 붙지 않는 최소 major 간격(css px). 이보다 촘촘하면 숫자가 겹쳐 못 읽는다. */
const RULER_MIN_MAJOR_CSS = 50;
/** minor 가 이보다 촘촘하면 그리지 않는다 — 소수 px 선은 눈금이 아니라 회색 띠가 된다. */
const RULER_MIN_MINOR_CSS = 2;

/**
 * 눈금자 한 축의 major 눈금과 minor 간격.
 *
 * `offsetCss` 는 oriented 0 의 css 위치(음수면 이미지가 눈금자 시작보다 왼쪽/위), `lengthCss` 는
 * 눈금자 길이. 반환 `css` 는 눈금자 시작 기준 css px, `label` 은 **oriented px 값**이다 —
 * 사용자가 읽는 것은 화면 좌표가 아니라 이미지 좌표다.
 *
 * 간격은 화면에서 50css 이상이 되는 1·2·5×10^k 중 가장 작은 값을 고른다. 고정 간격을 쓰면
 * 축소했을 때 라벨이 겹쳐 읽을 수 없고, 확대하면 눈금이 화면 밖으로 밀려 하나도 안 남는다.
 * 간격을 1 oriented px 아래로는 내리지 않는다(라벨이 소수가 되는 순간 정수 좌표라는 약속이 깨진다).
 */
export function rulerTicks(
  scale: number,
  offsetCss: number,
  lengthCss: number,
): { major: { css: number; label: string }[]; minorStepCss: number } {
  const major: { css: number; label: string }[] = [];
  // scale 0(레이아웃 전)·Infinity 길이(ResizeObserver 초기값)에서 아래 루프가 멈추지 않는다.
  if (!(scale > 0) || !(lengthCss > 0) || !Number.isFinite(lengthCss)) {
    return { major, minorStepCss: 0 };
  }

  const need = RULER_MIN_MAJOR_CSS / scale;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(need, 1))));
  // 1·2·5 가 모두 모자라면 10×pow — log10 의 부동소수 오차(log10(1000) = 2.9999…)도 이 갈래로 빠진다.
  let step = pow * 10;
  for (const m of [1, 2, 5]) {
    if (pow * m >= need) {
      step = pow * m;
      break;
    }
  }

  const stepCss = step * scale;
  // 눈금 번호는 oriented 원점 기준이라 팬으로 이미지가 밀리면 자연히 음수 라벨이 나온다.
  for (let i = Math.ceil(-offsetCss / stepCss); ; i++) {
    const css = offsetCss + i * stepCss;
    if (css > lengthCss) break;
    major.push({ css, label: String(i * step) });
  }

  // 2 계열만 4 등분(0.5 단위), 1·5·10 계열은 5 등분 — 자를 읽는 관례다.
  const minorStepCss = stepCss / (Math.round(step / pow) === 2 ? 4 : 5);
  return { major, minorStepCss: minorStepCss >= RULER_MIN_MINOR_CSS ? minorStepCss : 0 };
}
