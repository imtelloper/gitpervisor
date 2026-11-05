// 사진 톤 패스(태스크 76 D12) — 노출·밝은 영역·어두운 영역·따뜻함·색조·비네트·필터 프리셋.
//
// **CSS 필터가 아니라 픽셀 패스인 이유**: 이것들은 `ctx.filter` 함수로 정확히 옮겨지지 않는다 —
// 노출은 선형광 공간의 곱, 밝은/어두운 영역은 휘도 곡선, 따뜻함·색조는 채널 이득, 비네트는 위치
// 함수다. 근사(`brightness()` 로 노출 흉내 등)로 가면 "프리뷰에서 본 것"의 정의가 엔진마다 달라진다.
//
// **기존 밝기·대비·채도는 `ctx.filter` 에 그대로 둔다.** 이 패스로 옮기면 중간 클램프·반올림 순서가
// 달라 같은 값의 결과가 미세하게 바뀐다 — 이미 저장된 사이드카가 다시 열었을 때 다른 픽셀을 내면 안 된다.
// 톤 필드를 안 쓰는 문서는 이 패스를 아예 타지 않는다(`resolveTone` 이 null).
// 순서는 CSS 필터(이미지를 그릴 때) → 이 패스다. 프리셋은 이 패스가 맡는다: 흑백·세피아·채도
// 행렬은 CSS Filter Effects 규격 계수 그대로라 `grayscale()`·`sepia()`·`saturate()` 와 같은 모양이고,
// `ctx.filter` 지원 여부(WebKitGTK 미실측)와 무관하게 돈다.
//
// **대상 해상도에서 돈다**(프리뷰 백킹 ≤ 1800px · 출력 타일 ≤ 2048px). 원본 해상도 보정본을 따로 들면
// 100MP 입력에서 400MB 가 더 든다. 점 연산이라 배율이 달라도 같은 모양이고, 위치를 보는 비네트는
// **문서 좌표**(크롭 사각형)로 정의해 프리뷰와 타일 출력이 같은 자리에 같은 값을 낸다(`toneFrameOn`).
//
// 이 파일은 DOM 을 모른다 — 캔버스 왕복은 render.ts(와 조정 탭 프리셋 썸네일)가 한다.

import type { EditorDoc, FilterPreset, Rect, SceneTransform } from "./types";

/** 문서에서 이 패스가 읽는 필드. `crop` 은 비네트 기준 사각형이다. */
export type ToneDoc = Pick<
  EditorDoc,
  | "exposure"
  | "highlights"
  | "shadows"
  | "warmth"
  | "tint"
  | "vignette"
  | "filterPreset"
  | "filterAmount"
  | "crop"
>;

/** 톤 필드 기본값 — 정규화 경계(schema)와 `다시 설정`(resetAll)이 같은 값을 쓴다. */
export const TONE_DEFAULTS: Omit<ToneDoc, "crop"> = {
  exposure: 0,
  highlights: 0,
  shadows: 0,
  warmth: 0,
  tint: 0,
  vignette: 0,
  filterPreset: "none",
  filterAmount: 100,
};

/** 픽셀 패스가 먹는 유효값 — 슬라이더 + 프리셋 × 강도를 합친 것. */
export interface ToneRecipe {
  /** 노출(EV). */
  ev: number;
  /** −1..1. 양수 = 밝게. */
  highlights: number;
  shadows: number;
  /** −1..1 — 선형광 채널 이득. 따뜻함 양수 = R↑B↓, 색조 양수 = 마젠타(G↓). */
  warmth: number;
  tint: number;
  /** CSS `grayscale()`·`sepia()` 인자(0..1). */
  grayscale: number;
  sepia: number;
  /** CSS `saturate()`·`contrast()` 배율 − 1. */
  saturation: number;
  contrast: number;
  /** 검정 들어 올리기(0..1). */
  fade: number;
  /** −1..1. 양수 = 가장자리 어둡게. */
  vignette: number;
  /** 비네트 기준 사각형(문서 좌표) — 크롭, 없으면 이미지 전체. 비네트가 0 이면 null(키가 크롭에 안 흔들리게). */
  frame: Rect | null;
}

type RecipeKey = Exclude<keyof ToneRecipe, "frame">;

/** 슬라이더 100 = ±2EV(두 단) — 끝까지 밀어도 보통 사진의 중간톤이 하얗게/까맣게 날아가지 않는 폭. */
const EV_RANGE = 2;
/** 따뜻함·색조 1.0 의 채널 이득(stop). */
const WARMTH_STOPS = 0.4;
const TINT_STOPS = 0.35;
/** 페이드 1.0 — 검정을 0.2 로 올리고 흰색을 0.95 로 내린다. */
const FADE_LIFT = 0.2;
const FADE_DIM = 0.05;
/** 비네트 — 중심에서 이 거리(모서리 = 1)부터 번지기 시작한다. */
const VIG_START = 0.35;
const VIG_DARK = 0.75;
const VIG_LIGHT = 0.6;

/**
 * 프리셋 = 같은 매개변수 위의 레시피(강도 100 기준). 강도는 전부에 선형으로 곱한다 — CSS 필터
 * 함수들도 인자에 대해 선형이라 `grayscale(0.5)` 와 "흑백 50%"가 같은 뜻이 된다.
 */
const PRESET_RECIPES: Record<FilterPreset, Partial<Record<RecipeKey, number>>> = {
  none: {},
  mono: { grayscale: 1, contrast: 0.1 },
  sepia: { sepia: 1, contrast: -0.05 },
  vivid: { saturation: 0.35, contrast: 0.12 },
  warm: { warmth: 0.35, saturation: 0.08 },
  cool: { warmth: -0.35, saturation: 0.04 },
  vintage: { sepia: 0.35, fade: 0.3, vignette: 0.35, contrast: -0.08, warmth: 0.1 },
  fade: { fade: 0.4, saturation: -0.25, contrast: -0.1 },
};

const RECIPE_KEYS: readonly RecipeKey[] = [
  "ev",
  "highlights",
  "shadows",
  "warmth",
  "tint",
  "grayscale",
  "sepia",
  "saturation",
  "contrast",
  "fade",
  "vignette",
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 슬라이더(−100..100) → −1..1. 깨진 사이드카 값이 패스를 NaN 으로 물들이지 않게 여기서 막는다. */
function unit(v: number): number {
  return Number.isFinite(v) ? clamp(v / 100, -1, 1) : 0;
}

/**
 * 문서 → 유효 레시피. 아무것도 안 바꾸면 **null** — render.ts 는 그때 종전 경로(이미지에 CSS 필터만)를
 * 그대로 탄다. 그래서 톤 필드를 안 쓰는 문서의 픽셀은 이 기능 이전과 한 비트도 다르지 않다.
 */
export function resolveTone(d: ToneDoc, imageW: number, imageH: number): ToneRecipe | null {
  const p = PRESET_RECIPES[d.filterPreset] ?? {};
  const k = Number.isFinite(d.filterAmount) ? clamp(d.filterAmount / 100, 0, 1) : 1;
  const mix = (key: RecipeKey, base: number) => base + (p[key] ?? 0) * k;
  const r: ToneRecipe = {
    ev: mix("ev", unit(d.exposure) * EV_RANGE),
    highlights: mix("highlights", unit(d.highlights)),
    shadows: mix("shadows", unit(d.shadows)),
    warmth: mix("warmth", unit(d.warmth)),
    tint: mix("tint", unit(d.tint)),
    grayscale: clamp(mix("grayscale", 0), 0, 1),
    sepia: clamp(mix("sepia", 0), 0, 1),
    saturation: mix("saturation", 0),
    contrast: mix("contrast", 0),
    fade: clamp(mix("fade", 0), 0, 1),
    vignette: clamp(mix("vignette", unit(d.vignette)), -1, 1),
    frame: null,
  };
  if (RECIPE_KEYS.every((key) => r[key] === 0)) return null;
  if (r.vignette !== 0) r.frame = d.crop ?? { x: 0, y: 0, w: imageW, h: imageH };
  return r;
}

/** 캐시 키 — 프리뷰 커밋 캐시와 render.ts 의 톤 레이어가 같은 값으로 갈린다. */
export function toneKey(r: ToneRecipe): string {
  return JSON.stringify(r);
}

/** 비네트 타원 — 대상 버퍼 px. */
export interface ToneFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** 문서 좌표 비네트 사각형 → 대상 버퍼 px(`target = (p + t) × s`). 비네트가 없으면 null. */
export function toneFrameOn(r: ToneRecipe, t: SceneTransform): ToneFrame | null {
  const f = r.frame;
  if (!f || f.w <= 0 || f.h <= 0) return null;
  return {
    cx: (f.x + f.w / 2 + t.tx) * t.sx,
    cy: (f.y + f.h / 2 + t.ty) * t.sy,
    rx: (f.w / 2) * t.sx,
    ry: (f.h / 2) * t.sy,
  };
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(l: number): number {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

/** 8비트 입력 → 노출·화이트밸런스 이득을 선형광에서 건 sRGB 값(0..1). 채널마다 256칸이면 끝난다. */
function gainLut(gain: number): Float32Array {
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = gain === 1 ? v / 255 : linearToSrgb(Math.min(1, srgbToLinear(v / 255) * gain));
  }
  return lut;
}

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** a·b — b 를 먼저 건다. */
function mul3(a: Mat3, b: Mat3): Mat3 {
  const m = (r: number, c: number) => a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return [m(0, 0), m(0, 1), m(0, 2), m(1, 0), m(1, 1), m(1, 2), m(2, 0), m(2, 1), m(2, 2)];
}

// 아래 셋은 CSS Filter Effects 규격의 행렬 그대로다(계수를 바꾸면 "CSS 와 같은 모양"이 깨진다).
function grayscaleMat(g: number): Mat3 {
  const a = 1 - g;
  return [
    0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a,
    0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a,
    0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a,
  ];
}

function sepiaMat(s: number): Mat3 {
  const a = 1 - s;
  return [
    0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a,
    0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a,
    0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a,
  ];
}

function saturateMat(s: number): Mat3 {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}

/**
 * RGBA 버퍼(비프리멀티플라이 — `getImageData` 그대로)에 톤을 건다. 알파는 건드리지 않는다.
 * `y0` 는 이 버퍼 첫 행의 대상 캔버스 y — 띠로 나눠 부를 때 비네트가 이어지게 한다.
 */
export function applyTone(
  data: Uint8ClampedArray,
  w: number,
  rows: number,
  y0: number,
  r: ToneRecipe,
  frame: ToneFrame | null,
): void {
  const g = Math.pow(2, r.ev);
  const lutR = gainLut(g * Math.pow(2, WARMTH_STOPS * r.warmth));
  const lutG = gainLut(g * Math.pow(2, -TINT_STOPS * r.tint));
  const lutB = gainLut(g * Math.pow(2, -WARMTH_STOPS * r.warmth));

  // 밝은/어두운 영역 — 끝점(0·1)을 고정한 4차 곡선 `Y(1−Y)³`·`Y³(1−Y)` 를 휘도에 더한다(봉우리가
  // 1/4·3/4 라 중간톤을 덜 건드린다). 계수는 곡선이 단조로운 한계 안에서 고른 값이다 — 어두운 영역을
  // 내릴 때·밝은 영역을 올릴 때 1 을 넘기면 끝점 근처가 뒤집힌다(반대 방향은 4 까지 단조).
  const hs = r.highlights !== 0 || r.shadows !== 0;
  const kS = r.shadows * (r.shadows > 0 ? 2 : 1);
  const kH = r.highlights * (r.highlights > 0 ? 1 : 2);

  const matOn = r.grayscale !== 0 || r.sepia !== 0 || r.saturation !== 0;
  const m = matOn
    ? mul3(saturateMat(1 + r.saturation), mul3(sepiaMat(r.sepia), grayscaleMat(r.grayscale)))
    : IDENTITY3;
  const c = 1 + r.contrast;
  const lo = FADE_LIFT * r.fade;
  const span = 1 - FADE_DIM * r.fade - lo;
  const vig = frame && r.vignette !== 0 && frame.rx > 0 && frame.ry > 0 ? frame : null;

  for (let y = 0; y < rows; y++) {
    const dy = vig ? (y0 + y + 0.5 - vig.cy) / vig.ry : 0;
    const dy2 = dy * dy;
    for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
      if (data[i + 3] === 0) continue;
      let R = lutR[data[i]];
      let G = lutG[data[i + 1]];
      let B = lutB[data[i + 2]];
      if (hs) {
        const Y = clamp(0.2126 * R + 0.7152 * G + 0.0722 * B, 0, 1);
        const inv = 1 - Y;
        const d = kS * Y * inv * inv * inv + kH * Y * Y * Y * inv;
        R = clamp(R + d, 0, 1);
        G = clamp(G + d, 0, 1);
        B = clamp(B + d, 0, 1);
      }
      if (matOn) {
        const r0 = R;
        const g0 = G;
        R = clamp(m[0] * r0 + m[1] * g0 + m[2] * B, 0, 1);
        G = clamp(m[3] * r0 + m[4] * g0 + m[5] * B, 0, 1);
        B = clamp(m[6] * r0 + m[7] * g0 + m[8] * B, 0, 1);
      }
      if (c !== 1) {
        R = (R - 0.5) * c + 0.5;
        G = (G - 0.5) * c + 0.5;
        B = (B - 0.5) * c + 0.5;
      }
      if (lo !== 0) {
        R = lo + clamp(R, 0, 1) * span;
        G = lo + clamp(G, 0, 1) * span;
        B = lo + clamp(B, 0, 1) * span;
      }
      if (vig) {
        // 정규화 거리 — 기준 사각형 모서리가 1. 크롭 밖 화소는 1 을 넘으므로 끝값으로 붙인다.
        const dx = (x + 0.5 - vig.cx) / vig.rx;
        const t = clamp((Math.sqrt((dx * dx + dy2) * 0.5) - VIG_START) / (1 - VIG_START), 0, 1);
        if (t > 0) {
          const wgt = t * t * (3 - 2 * t);
          if (r.vignette > 0) {
            const k = 1 - VIG_DARK * r.vignette * wgt;
            R *= k;
            G *= k;
            B *= k;
          } else {
            const a = -VIG_LIGHT * r.vignette * wgt;
            R += (1 - R) * a;
            G += (1 - G) * a;
            B += (1 - B) * a;
          }
        }
      }
      // Uint8ClampedArray 가 반올림·클램프한다.
      data[i] = R * 255;
      data[i + 1] = G * 255;
      data[i + 2] = B * 255;
    }
  }
}
