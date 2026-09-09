// 텍스트 레이아웃 — 줄 나눔·정렬·목록·말줄임·박스 모드를 **한 산출물**로 낸다.
//
// 렌더(render.ts drawText)·히트(geometry buildObjectPath)·바운딩(objectBBox/objectFrame)·
// 편집 오버레이(annotation/textEdit) 네 소비자가 이 `TextLayout` 하나를 나눠 쓴다. 각자 재면
// "보이는 곳"과 "집히는 곳"이 조용히 갈라진다 — v1 이 `split("\n")` 하나로 버틴 이유이자,
// 정렬·자간을 한 번 기각했던 이유다(DOCS/task/49-image-text-layout.md §2·§6).
//
// 좌표는 **객체 로컬**이다(원점 = 앵커 `o.x,o.y`, 단위 oriented px). 소비자가 앵커를 더한다.
// 그래서 캐시 키에 x,y 가 없고, 텍스트를 끌고 다니는 매 프레임이 캐시에 적중한다 —
// 이동마다 다시 재면 `measureText` 가 드래그 한 번에 수천 번 돈다.
//
// 세로 배치는 `textBaseline='alphabetic'` + CSS 라인박스 공식이다(§3.3). 캔버스와 textarea 가
// **같은 정의**를 써야 편집 중/확정 후 첫 글자가 안 튄다 — 옛 `top` + half-leading 근사는
// 폰트마다 다르게, Segoe UI 에서는 5px 어긋났다.

import type { CSSProperties } from "react";

import { readProp, type Maybe } from "./selection";
import {
  DEFAULT_TEXT_STYLE,
  type Rect,
  type TextNode,
  type TextStyle,
} from "./types";

// ── 계약 타입 ────────────────────────────────────────────────────────────────

/** 한 번의 `fillText` 로 그려지는 조각. 폴백 경로(§3.8)에서는 그래핌 하나가 런 하나다. */
export interface TextRun {
  text: string;
  x: number;
  /** 글리프 베이스라인 y — 첨자 시프트가 **여기에만** 반영된다(줄의 baseline 은 안 움직인다). */
  baseline: number;
  width: number;
  /** `ctx.wordSpacing` 에 넣을 px. 양쪽정렬 줄만 > 0. */
  wordSpacing: number;
}

export interface TextLine {
  top: number;
  baseline: number;
  width: number;
  runs: TextRun[];
  /** 문단 첫 줄에만 붙는 목록 마커. 저장 문자열에는 없다(편집 중 커서가 마커를 지우지 못하게). */
  marker: { text: string; x: number } | null;
  para: number;
  /** 낱말이 통째로 안 들어가 그래핌으로 쪼갠 줄. 양쪽정렬에서 제외된다. */
  forced: boolean;
}

export interface TextLayout {
  /**
   * 이 객체의 **유일한** 상자. `buildObjectPath`·`objectBBox`·`objectFrame`·`textEditBox` 가
   * 전부 여기서 나온다 — 하나라도 따로 계산하면 선택 상자와 잉크가 어긋난다.
   */
  box: Rect;
  lines: TextLine[];
  /** `ctx.font` 문자열(첨자 배율 반영). */
  font: string;
  letterSpacingPx: number;
  ascent: number;
  descent: number;
  lineHeightPx: number;
  /** 세로 정렬로 내려간 만큼. 줄의 top/baseline 에는 **이미 더해져 있다**. */
  contentTop: number;
  contentH: number;
  truncated: boolean;
  /** 베이스라인 **상대** 오프셋(아래가 +). 렌더가 `run.baseline + y` 에 그린다. */
  decor: {
    underline: { y: number; thick: number } | null;
    strike: { y: number; thick: number } | null;
  };
  /** 태스크 50 이 채운다 — 있으면 drawText 가 runs 대신 `fill(outline)`. */
  outline?: Path2D;
}

// ── 상수 ────────────────────────────────────────────────────────────────────

/**
 * em 배수로 잡은 2차 메트릭. `TextMetrics` 에 밑줄·취소선 위치가 없어 근사한 값이고,
 * 첨자 시프트는 Blink 의 `vertical-align: super/sub` 를 눈으로 맞춘 값이다(§3.2 — 프로브 미실행).
 * 태스크 50 이 폰트의 post/OS2 표로 덮을 자리라 한 곳에 모아 둔다.
 */
export const TEXT_METRICS = {
  SCRIPT_SCALE: 0.62,
  SUPER_SHIFT: -0.34,
  SUB_SHIFT: 0.2,
  UNDERLINE_Y: 0.12,
  UNDERLINE_THICK: 0.06,
  STRIKE_Y: -0.3,
  LIST_COL_EM: 1.5,
} as const;

/**
 * `ctx.letterSpacing` 이 있는가(Chromium 99+ 는 있고 WKWebView 는 없다).
 *
 * 거짓이면 자간·양쪽정렬을 그래핌별 수동 배치로 폴백한다(§3.8) — 커닝·리가처가 끊기는 대가라
 * **자간 0 이고 양쪽정렬이 아니면 폴백을 타지 않게** 해 뒀다. 태스크 40 실측표가 이 값을 읽는다.
 * ponytail: Mac 실기 확인 전까지 폴백 품질은 눈으로 본 적이 없다 — 어긋나면 그래핌 대신
 * 낱말 단위 런으로 올린다.
 */
export const HAS_CTX_SPACING =
  typeof CanvasRenderingContext2D !== "undefined" &&
  "letterSpacing" in CanvasRenderingContext2D.prototype;

/** 폭 비교 허용오차(px). `measureText` 부동소수 잔차로 마지막 낱말이 튕겨 나가는 것을 막는다. */
const EPS = 0.01;

const CACHE_MAX = 256;

// ── 측정 기반 ────────────────────────────────────────────────────────────────

/**
 * 측정 전용 1×1 컨텍스트. geometry.ts 에도 같은 것이 있지만 **가져오지 않는다** —
 * geometry 가 이 모듈을 import 하므로 순환이 된다(이 모듈은 types 만 본다).
 */
let scratch: CanvasRenderingContext2D | null = null;
function scratchCtx(): CanvasRenderingContext2D {
  if (!scratch) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    scratch = c.getContext("2d")!;
  }
  return scratch;
}

/**
 * 그래핌 분해. `Intl.Segmenter` 는 Chromium 87+ 에 있지만 tsconfig 의 `lib` 가 ES2020 이라
 * 타입이 없다 — lib 를 올리면 무관한 전역 타입이 함께 흔들리므로 여기서만 최소로 선언한다.
 * 없으면 코드포인트 분해로 떨어진다(결합 문자·이모지 시퀀스가 쪼개질 수 있다).
 */
type SegmenterLike = { segment(s: string): Iterable<{ segment: string }> };
const SEGMENTER: SegmenterLike | null = (() => {
  const I = Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      opts?: { granularity: string },
    ) => SegmenterLike;
  };
  return I.Segmenter ? new I.Segmenter(undefined, { granularity: "grapheme" }) : null;
})();

function graphemes(s: string): string[] {
  if (!SEGMENTER) return Array.from(s);
  const out: string[] = [];
  for (const g of SEGMENTER.segment(s)) out.push(g.segment);
  return out;
}

/**
 * 폰트의 고정 세로 메트릭. 글자 내용과 무관하므로 `ctx.font` 문자열 하나당 한 번만 잰다.
 * `fontBoundingBox*` 가 없는 엔진에서는 0.8/0.2 em 근사로 떨어진다 — 라인박스 공식이
 * 무너지는 대신 옛 `top` 배치와 비슷한 자리로 간다.
 */
const fontMetricCache = new Map<string, { asc: number; desc: number }>();
function fontMetrics(
  ctx: CanvasRenderingContext2D,
  font: string,
  size: number,
): { asc: number; desc: number } {
  const hit = fontMetricCache.get(font);
  if (hit) return hit;
  const m = ctx.measureText("Mg가");
  const asc = m.fontBoundingBoxAscent;
  const desc = m.fontBoundingBoxDescent;
  const v =
    typeof asc === "number" && typeof desc === "number" && asc + desc > 0
      ? { asc, desc }
      : { asc: size * 0.8, desc: size * 0.2 };
  fontMetricCache.set(font, v);
  return v;
}

/** 캔버스 font 축약 문자열. textarea(`textCss`)도 같은 값을 조립해야 편집 중 글자가 안 튄다. */
export function fontStringOf(
  fontSize: number,
  fontFamily: string,
  weight: number | string = 400,
  italic = false,
): string {
  return `${italic ? "italic " : ""}${weight} ${fontSize}px ${fontFamily}`;
}

// ── 레이아웃 ────────────────────────────────────────────────────────────────

/** 낱말 경계 조각 — 공백 뭉치와 비공백 뭉치가 번갈아 나온다. */
const PIECE = /\s+|\S+/g;
/** `ctx.wordSpacing` 이 실제로 벌리는 문자(낱말 구분자). 양쪽정렬 여분을 여기에 나눠 준다. */
const WORD_SEP = /[  ]/g;

interface RawLine {
  text: string;
  w: number;
  para: number;
  /** 문단의 첫 줄 — 들여쓰기와 목록 마커가 붙는다. */
  first: boolean;
  forced: boolean;
}

function countSep(s: string): number {
  return s.match(WORD_SEP)?.length ?? 0;
}

function markerText(list: TextStyle["list"], n: number): string {
  return list === "number" ? `${n}.` : list === "check" ? "☐" : "•";
}

/**
 * 캐시 키 — `TextStyle` 24필드 + `w,h` + 옵션 + 본문.
 *
 * **x,y 는 일부러 없다**(§3.2). 본문에 `|` 가 들어갈 수 있으므로 본문은 맨 뒤에 둔다.
 */
function cacheKey(o: TextNode, editing: boolean, fallback: boolean): string {
  const f = o.features;
  return (
    `${o.fontFamily}|${o.fontWeight}|${o.italic}|${o.fontSize}|${o.lineHeight}|` +
    `${o.letterSpacing}|${o.paragraphSpacing}|${o.indent}|${o.align}|${o.valign}|` +
    `${o.resize}|${o.underline}|${o.strike}|${o.script}|${o.textCase}|${o.list}|` +
    `${o.listLevel}|${o.truncateLines}|${f.liga}|${f.onum}|${f.tnum}|${f.frac}|` +
    `${o.w}|${o.h}|${editing}|${fallback}|${o.text}`
  );
}

const cache = new Map<string, TextLayout>();

/**
 * 텍스트 노드의 줄 배치. **동기·순수**이고 결과는 LRU 256 에 담긴다.
 *
 * `editing` 은 말줄임을 푼다 — textarea 는 전문을 보여주므로 편집 중에만 잘려 있으면
 * 커서가 보이지 않는 글자 위를 걷는다(Figma 도 같다).
 * `fallback` 은 §3.8 수동 배치 경로를 강제한다(e2e 훅이 Windows 에서 Mac 경로를 본다).
 */
export function layoutText(
  o: TextNode,
  opts?: { editing?: boolean; fallback?: boolean },
): TextLayout {
  const editing = opts?.editing === true;
  const fallback = opts?.fallback === true;
  const key = cacheKey(o, editing, fallback);
  const hit = cache.get(key);
  if (hit) {
    // 재삽입으로 최근 사용 표시 — Map 은 삽입 순서를 지키므로 첫 키가 가장 오래된 것이다.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const out = computeLayout(o, editing, fallback);
  cache.set(key, out);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return out;
}

function computeLayout(o: TextNode, editing: boolean, forceFallback: boolean): TextLayout {
  const fs = o.fontSize;
  const scale = o.script === "none" ? 1 : TEXT_METRICS.SCRIPT_SCALE;
  const font = fontStringOf(fs * scale, o.fontFamily, o.fontWeight, o.italic);
  const lineHeightPx = (fs * o.lineHeight) / 100;
  const letterSpacingPx = (fs * o.letterSpacing) / 100;
  // auto-width 는 가용 폭이 곧 내용 폭이라 양쪽정렬이 무의미하다(§3.10) — left 로 떨어뜨린다.
  const justify = o.align === "justify" && o.resize !== "auto-width";
  const fb =
    forceFallback || (!HAS_CTX_SPACING && (letterSpacingPx !== 0 || justify));

  const ctx = scratchCtx();
  ctx.font = font;
  // 폴백 경로는 자간을 직접 배치하므로 컨텍스트 자간을 반드시 0 으로 되돌린다 —
  // 남아 있으면 그래핌마다 한 칸씩 더 벌어진다.
  if (HAS_CTX_SPACING) ctx.letterSpacing = fb ? "0px" : `${letterSpacingPx}px`;

  const measure = fb
    ? (s: string): number => {
        let sum = 0;
        let n = 0;
        for (const g of graphemes(s)) {
          sum += ctx.measureText(g).width;
          n++;
        }
        return n > 0 ? sum + letterSpacingPx * (n - 1) : 0;
      }
    : (s: string): number =>
        // Chromium 은 마지막 글자 **뒤** 자간까지 폭에 넣는다(§5-0 프로브 미실행 — 추정).
        // 빼지 않으면 가운데/오른쪽 정렬이 자간 한 칸만큼 밀린다. 자간 0 이면 항등이다.
        s ? ctx.measureText(s).width - letterSpacingPx : 0;

  const { asc, desc } = fontMetrics(ctx, font, fs * scale);

  const listOn = o.list !== "none";
  const colW = TEXT_METRICS.LIST_COL_EM * fs;
  const contentX = listOn ? colW * (Math.max(0, o.listLevel) + 1) : 0;
  const auto = o.resize === "auto-width";
  const maxW = auto ? Infinity : Math.max(1, o.w);

  // ① 대소문자 — 재는 문자열만 바꾼다. 저장 문자열(`o.text`)은 끝까지 원본이다.
  const cased = (s: string): string =>
    o.textCase === "upper"
      ? s.toLocaleUpperCase()
      : o.textCase === "lower"
        ? s.toLocaleLowerCase()
        : s;

  // ②③ 토큰화 + 줄 채우기. 문단은 `\n`, 줄은 공백 경계에서만 끊고, 빈 줄에서도 넘치는
  // 낱말만 그래핌으로 쪼갠다 = Blink `word-break:keep-all; overflow-wrap:anywhere` 등가.
  const raw: RawLine[] = [];
  const paras = o.text.split("\n");
  for (let pi = 0; pi < paras.length; pi++) {
    let first = true;
    let text = "";
    let w = 0;
    let forced = false;
    let sp = "";
    const avail = (): number => maxW - contentX - (first ? o.indent : 0);
    const flush = (): void => {
      raw.push({ text, w, para: pi, first, forced });
      first = false;
      text = "";
      w = 0;
      forced = false;
    };
    for (const piece of cased(paras[pi]).match(PIECE) ?? []) {
      if (/\s/.test(piece)) {
        // 줄 끝으로 밀리면 버려지는 구분자 — 다음 낱말이 같은 줄에 붙을 때만 폭에 든다.
        sp = piece;
        continue;
      }
      const wordW = measure(piece);
      if (text) {
        const spW = sp ? measure(sp) : 0;
        const cand = w + (sp ? letterSpacingPx + spW : 0) + letterSpacingPx + wordW;
        if (cand <= avail() + EPS) {
          text += sp + piece;
          w = cand;
          sp = "";
          continue;
        }
        flush();
      }
      sp = "";
      if (wordW > avail() + EPS) {
        forced = true;
        for (const g of graphemes(piece)) {
          const gw = measure(g);
          const cand = text ? w + letterSpacingPx + gw : gw;
          // `text &&` 가 없으면 상자보다 넓은 글자 하나에서 영원히 돈다.
          if (text && cand > avail() + EPS) {
            flush();
            forced = true;
            text = g;
            w = gw;
          } else {
            text += g;
            w = cand;
          }
        }
      } else {
        text = piece;
        w = wordW;
      }
    }
    flush();
  }

  // ⑦ 말줄임 — 편집 중에는 풀어 준다.
  let truncated = false;
  const lim = o.truncateLines;
  if (lim !== null && !editing && raw.length > lim) {
    raw.length = lim;
    const last = raw[lim - 1];
    const availLast = maxW - contentX - (last.first ? o.indent : 0);
    const gs = graphemes(last.text);
    let s = `${last.text}…`;
    let sw = measure(s);
    while (gs.length > 0 && sw > availLast + EPS) {
      gs.pop();
      s = `${gs.join("")}…`;
      sw = measure(s);
    }
    last.text = s;
    last.w = sw;
    truncated = true;
  }

  // ⑤ 세로 배치 — 문단 사이에만 paragraphSpacing 이 들어간다(마지막 줄 뒤에는 여백 없음).
  const tops: number[] = [];
  let y = 0;
  let prevPara = -1;
  for (const r of raw) {
    if (prevPara >= 0 && r.para !== prevPara) y += o.paragraphSpacing;
    tops.push(y);
    y += lineHeightPx;
    prevPara = r.para;
  }
  const contentH = y;

  let boxW = maxW;
  if (auto) {
    boxW = 0;
    for (const r of raw) {
      boxW = Math.max(boxW, contentX + (r.first ? o.indent : 0) + r.w);
    }
  }
  // 넘쳐도 자르지 않고 상자를 늘린다 — 히트·선택 상자가 보이는 글리프를 덮어야 한다(§3.2).
  const boxH = o.resize === "fixed" ? Math.max(o.h, contentH) : contentH;
  const slackV = Math.max(0, boxH - contentH);
  const contentTop =
    o.resize !== "fixed"
      ? 0
      : o.valign === "middle"
        ? slackV / 2
        : o.valign === "bottom"
          ? slackV
          : 0;

  const halfLead = (lineHeightPx - (asc + desc)) / 2;
  const shift =
    o.script === "super"
      ? TEXT_METRICS.SUPER_SHIFT * fs
      : o.script === "sub"
        ? TEXT_METRICS.SUB_SHIFT * fs
        : 0;

  let markerN = 0;
  const lines: TextLine[] = raw.map((r, i) => {
    const start = contentX + (r.first ? o.indent : 0);
    const lineAvail = (auto ? boxW : maxW) - start;
    const slack = lineAvail - r.w;
    const lastOfPara = i === raw.length - 1 || raw[i + 1].para !== r.para;
    const seps = justify && !r.forced && !lastOfPara ? countSep(r.text) : 0;
    // ④ 양쪽정렬 = 줄당 fillText 1회 + wordSpacing. 문단 마지막 줄과 강제 분할 줄은 제외한다.
    const wordSpacing = seps > 0 && slack > 0 ? slack / seps : 0;
    const x =
      start +
      (o.align === "center" ? slack / 2 : o.align === "right" ? slack : 0);
    const top = contentTop + tops[i];
    const baseline = top + halfLead + asc;
    const base = baseline + shift;

    let runs: TextRun[];
    if (!fb) {
      runs = [
        {
          text: r.text,
          x,
          baseline: base,
          width: r.w + wordSpacing * seps,
          wordSpacing,
        },
      ];
    } else {
      runs = [];
      let cx = x;
      for (const g of graphemes(r.text)) {
        const gw = measure(g);
        runs.push({ text: g, x: cx, baseline: base, width: gw, wordSpacing: 0 });
        cx += gw + letterSpacingPx + (wordSpacing && countSep(g) > 0 ? wordSpacing : 0);
      }
    }

    // ⑥ 마커는 문단 첫 줄에만. 번호는 문단마다 하나씩 오른다.
    if (listOn && r.first) markerN++;
    return {
      top,
      baseline,
      width: r.w + wordSpacing * seps,
      runs,
      marker:
        listOn && r.first
          ? { text: markerText(o.list, markerN), x: contentX - colW }
          : null,
      para: r.para,
      forced: r.forced,
    };
  });

  return {
    box: { x: 0, y: 0, w: boxW, h: boxH },
    lines,
    font,
    letterSpacingPx,
    ascent: asc,
    descent: desc,
    lineHeightPx,
    contentTop,
    contentH,
    truncated,
    // ⑧ 장식 — `TextMetrics` 에 폰트 표 값이 없어 em 근사다(태스크 50 이 대체).
    decor: {
      underline: o.underline
        ? {
            y: TEXT_METRICS.UNDERLINE_Y * fs,
            thick: Math.max(1, TEXT_METRICS.UNDERLINE_THICK * fs),
          }
        : null,
      strike: o.strike
        ? {
            y: TEXT_METRICS.STRIKE_Y * fs,
            thick: Math.max(1, TEXT_METRICS.UNDERLINE_THICK * fs),
          }
        : null,
    },
  };
}

// ── 캔버스 열 · DOM 열 (짝) ─────────────────────────────────────────────────
//
// 아래 둘은 **같은 순서로 같은 속성**을 넣는다. 하나만 고치면 편집 중 글자가 확정 후와
// 다른 자리에 뜬다 — 실제로 그 회귀가 있었다(§3.7). 속성을 하나 늘리면 두 함수를 함께 고쳐라.

/** 캔버스 열 — 이 레이아웃을 그리기 직전의 ctx 상태. */
export function setupTextCtx(ctx: CanvasRenderingContext2D, l: TextLayout): void {
  ctx.font = l.font;
  if (HAS_CTX_SPACING) ctx.letterSpacing = `${l.letterSpacingPx}px`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
}

/** DOM 열 — textarea/미러가 같은 줄을 내게 하는 스타일. `ds` 는 oriented → css px 배율. */
export function textCss(o: TextNode, ds: number): CSSProperties {
  const scale = o.script === "none" ? 1 : TEXT_METRICS.SCRIPT_SCALE;
  const colW = TEXT_METRICS.LIST_COL_EM * o.fontSize;
  const contentX = o.list === "none" ? 0 : colW * (Math.max(0, o.listLevel) + 1);
  const decor = [o.underline ? "underline" : "", o.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return {
    fontFamily: o.fontFamily,
    fontStyle: o.italic ? "italic" : "normal",
    fontWeight: o.fontWeight,
    fontSize: o.fontSize * scale * ds,
    lineHeight: `${((o.fontSize * o.lineHeight) / 100) * ds}px`,
    letterSpacing: `${((o.fontSize * o.letterSpacing) / 100) * ds}px`,
    textAlign: o.align,
    textTransform:
      o.textCase === "upper" ? "uppercase" : o.textCase === "lower" ? "lowercase" : "none",
    textDecorationLine: decor || "none",
    textIndent: `${o.indent * ds}px`,
    paddingLeft: contentX * ds,
    // 여유분(아래 `editSlack`)은 **패딩으로** 잡는다. 상자만 넓히면 border-box 라인박스가
    // 캔버스보다 1em 넓어지고, `textAlign` 이 그 넓어진 상자 안에서 가운데·오른쪽을 잡아
    // 편집 중 글자가 확정 후와 다른 자리에 뜬다(가운데 ½em·오른쪽 1em). 패딩으로 두면
    // 라인박스 폭이 캔버스의 `boxW - contentX` 와 정확히 같아지고, 커서 자리도 그대로 남는다.
    paddingRight: editSlack(o) * ds,
    // 줄바꿈 규칙은 엔진(§3.2)과 등가여야 한다 — keep-all 이 빠지면 한글이 글자마다 끊긴다.
    whiteSpace: o.resize === "auto-width" ? "pre" : "pre-wrap",
    wordBreak: "keep-all",
    overflowWrap: "anywhere",
  };
}

/**
 * auto-width 는 폭이 내용에 딱 맞아 커서가 마지막 글자에 물린다 — 1em 만 여유를 준다.
 * 이 값은 상자 폭(`textEditBox`)과 오른쪽 패딩(`textCss`) **양쪽에** 같이 들어가야 한다.
 * 한쪽에만 넣으면 라인박스가 캔버스와 어긋나거나(정렬이 튄다) 커서가 다시 물린다.
 */
function editSlack(o: TextNode): number {
  return o.resize === "auto-width" ? o.fontSize : 0;
}

/**
 * 편집용 textarea 의 상자.
 *
 * half-leading 뺄셈이 없다 — 라인박스 공식(§3.3)이 캔버스와 DOM 양쪽의 정의라 앵커가 곧
 * 상자 좌상단이고, 그래서 회전 피벗도 `0 0` 이다(옛 `originY: halfLeading` 은 폐기).
 */
export function textEditBox(
  o: TextNode,
  liveText: string,
  ds: number,
): {
  left: number;
  top: number;
  width: number;
  height: number;
  rot: number;
  originX: number;
  originY: number;
} {
  const l = layoutText({ ...o, text: liveText || " " }, { editing: true });
  return {
    left: o.x * ds,
    top: (o.y + l.contentTop) * ds,
    width: (l.box.w + editSlack(o)) * ds,
    height: l.box.h * ds,
    rot: o.rot,
    originX: 0,
    originY: 0,
  };
}

// ── 리사이즈 · Mixed ────────────────────────────────────────────────────────

/**
 * 상자 리사이즈 — **글자 크기는 그대로**다(Figma 동작). 좌우 핸들은 auto-height 로,
 * 나머지는 fixed 로 모드를 바꾼다. Ctrl 을 누른 글자 배율 경로는 호출자가 `scaleObject` 로
 * 따로 태운다(§3.6 — 그쪽이 v1 회귀 방지선이다).
 */
export function resizeText(
  o: TextNode,
  p: { w?: number; h?: number },
  handle: "E" | "W" | "N" | "S" | "NE" | "NW" | "SE" | "SW",
): TextNode {
  const cur = layoutText(o).box;
  const minW = o.fontSize;
  const minH = (o.fontSize * o.lineHeight) / 100;
  const w = Math.max(minW, p.w ?? cur.w);
  const h = Math.max(minH, p.h ?? cur.h);
  const next: TextNode =
    handle === "E" || handle === "W"
      ? { ...o, resize: "auto-height", w }
      : { ...o, resize: "fixed", w, h };
  // 서/북 핸들은 반대 변이 제자리에 있어야 한다. 되민 폭은 **다시 잰 상자**로 구한다 —
  // 줄이 다시 접히면서 auto 높이가 바뀌므로 요청값 h 로 밀면 아래 변이 흔들린다.
  const box = layoutText(next).box;
  const west = handle === "W" || handle === "NW" || handle === "SW";
  const north = handle === "N" || handle === "NW" || handle === "NE";
  return {
    ...next,
    x: west ? o.x + cur.w - box.w : o.x,
    y: north ? o.y + cur.h - box.h : o.y,
  };
}

/** `features` 같은 중첩 값도 같은 값이면 같다고 봐야 한다 — 아니면 항상 MIXED 로 읽힌다. */
function eqStyle(a: unknown, b: unknown): boolean {
  if (typeof a === "object" && a !== null) return JSON.stringify(a) === JSON.stringify(b);
  return Object.is(a, b);
}

/**
 * 다중 선택의 타이포 값 — 갈린 필드는 `MIXED`(태스크 42 `readProp` 3상태 그대로).
 *
 * 세 상태를 뭉개면 인스펙터가 "여러 값"을 빈 칸으로 그리고, 그 칸을 한 번 건드리는 순간
 * 선택 전체가 모르는 값으로 덮인다. 텍스트가 아닌 노드는 의견 없음(undefined)으로 건너뛴다.
 * 선택이 비면 모든 필드가 undefined 다 — 그때는 애초에 인스펙터가 뜨지 않는다.
 */
export function mixedTextStyle(objs: readonly TextNode[]): {
  [K in keyof TextStyle]: Maybe<TextStyle[K]>;
} {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_TEXT_STYLE) as (keyof TextStyle)[]) {
    out[k] = readProp<unknown>(objs, (n) => (n.kind === "text" ? n[k] : undefined), eqStyle);
  }
  return out as { [K in keyof TextStyle]: Maybe<TextStyle[K]> };
}
