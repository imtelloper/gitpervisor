// 화면 크롬 오버레이 — stage 위 SVG 한 겹 + 픽셀 그리드 div 하나.
//
// **여기에 `useState` 를 들이면 편집기가 통째로 느려진다.** 크롬은 드래그 중 rAF 마다
// `update()` 를 받는다(초당 60회). 그걸 state 로 받으면 같은 빈도의 리렌더가 편집기 트리
// 전체로 번진다 — 상태바가 커서 좌표를 `textContent` 로 직접 쓰는 것과 같은 이유다
// (`EditorStatusBar.tsx` 머리말). 그래서 이 파일은 JSX 로 **고정 슬롯**만 만들고 `update()`
// 안에서 DOM 속성을 직접 쓴다. 개수가 가변인 항목은 `child()` 로 슬롯을 재사용한다.
//
// 좌표 규약은 `annotate/chrome.ts` 가 정한다: 위치는 oriented px, 두께·핸들 크기는 css px.
// 이 SVG 는 stage 의 CSS transform **밖**에 있어 user unit = css px 이므로 위치만
// `ChromeScreen` 으로 곱하면 끝난다. `vector-effect="non-scaling-stroke"` 에 기대지 않는 이유는
// 브라우저마다 반올림이 달라 400% 확대에서 선이 1px 이 아니게 되기 때문이다 — 캔버스 크롬을
// 버린 바로 그 증상을 다시 얻는다.
//
// 포인터는 계속 씬 캔버스가 받는다(`pointer-events:none`). 예외는 눈금자 띠 둘뿐 — 거기서
// 가이드를 끌어낸다. 이 예외를 넓히면 캔버스 히트 테스트가 크롬에 가려 조용히 죽는다.
//
// 배경: DOCS/task/43-image-chrome-snap.md §3.1~§3.6

import { forwardRef, useId, useImperativeHandle, useRef } from "react";

import {
  CHROME_COLORS,
  STAGE_Z,
  rulerTicks,
  type ChromePrim,
  type ChromeScreen,
  type ChromeState,
} from "../../lib/annotate/chrome";

export interface ChromeOverlayHandle {
  /** rAF 안에서 부른다 — React state 를 거치지 않고 DOM 을 직접 갱신한다. */
  update(s: ChromeState): void;
}

export interface ChromeOverlayProps {
  /** 눈금자에서 끌어낸 가이드를 문서에 커밋한다(히스토리 1칸). */
  onGuideCommit(axis: "x" | "y", pos: number): void;
  /** 끌어내는 중 스냅된 위치(oriented px). 스냅이 꺼져 있으면 받은 값을 그대로 돌려주면 된다. */
  snapForGuide(axis: "x" | "y", pos: number): number;
}

/** 눈금자 띠 두께(css px, 시안 `Ruler Row` h=22). */
const RULER = 22;
/** 선택 핸들 한 변(css px) — 어느 배율에서도 이 값이다. */
const HANDLE = 8;
const TICK_MAJOR = 8;
const TICK_MINOR = 4;
const BADGE_H = 16;
const FONT = 11;

// 아래 셋은 설계 §3.3 이 색을 직접 지정한 자리다. `CHROME_COLORS` 에 없고 **테마를 따라가서도
// 안 된다** — 바탕이 사용자 이미지이거나 고정 크롬 색이라, `--color-fg` 같은 토큰을 쓰면 어두운
// 사진 위에서 통째로 사라지거나 파란 뱃지 위에 파란 글자가 된다.
/** 뱃지 글자·눈금자 라벨·핸들 채움 — 바탕이 항상 고정 크롬 색이다. */
const INK = "#ffffff";
/** 크롭 딤(α .45)·스크림 마스크의 구멍. */
const DIM = "#000000";
/** 픽셀 그리드 선 — 어떤 사진 위에서도 보이는 흰 실선. */
const GRID_LINE = "rgba(255,255,255,0.16)";

const SVG_NS = "http://www.w3.org/2000/svg";

// ── DOM 슬롯 ────────────────────────────────────────────────────────────────

/**
 * `parent` 의 i 번째 자식을 `tag` 로 확보한다 — 없으면 만들고, 종류가 다르면 갈아 끼운다.
 *
 * 매 프레임 `replaceChildren` 로 다시 만들면 드래그 중 요소 수백 개가 초당 60회 생성·폐기돼
 * GC 가 프레임을 먹는다. 인덱스로 재사용하면 바뀌는 것은 속성뿐이다. 종류 검사가 있는 이유는
 * `extra`(47·45 가 넘기는 임의 프리미티브)처럼 한 그룹에 태그가 섞이는 자리가 있어서다.
 */
function child<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  i: number,
  tag: K,
): SVGElementTagNameMap[K] {
  const cur = parent.children[i];
  if (cur && cur.tagName === tag) return cur as SVGElementTagNameMap[K];
  const made = document.createElementNS(SVG_NS, tag);
  if (cur) parent.replaceChild(made, cur);
  else parent.appendChild(made);
  return made;
}

/** i 번째부터 뒤를 잘라낸다 — 이번 프레임에 안 쓴 슬롯이 유령으로 남는 것을 막는다. */
function trim(parent: Element, n: number): void {
  while (parent.childElementCount > n) parent.lastElementChild!.remove();
}

function attrs(el: Element, a: Record<string, string | number>): void {
  for (const k in a) el.setAttribute(k, String(a[k]));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** oriented → stage css. 크롬의 모든 좌표가 이 두 줄을 지난다. */
const sx = (sc: ChromeScreen, x: number) => sc.x + x * sc.scale;
const sy = (sc: ChromeScreen, y: number) => sc.y + y * sc.scale;

/** 1px 선 하나(css 좌표). `dash` 는 점선, `width` 는 css px. */
function lineAt(
  g: Element,
  i: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  o?: { dash?: boolean; width?: number; opacity?: number },
): number {
  attrs(child(g, i, "line"), {
    x1,
    y1,
    x2,
    y2,
    stroke: color,
    "stroke-width": o?.width ?? 1,
    "stroke-dasharray": o?.dash ? "4 3" : "none",
    "stroke-opacity": o?.opacity ?? 1,
  });
  return i + 1;
}

/** 사각형 하나(css 좌표). 음수 폭은 SVG 에서 에러라 0 으로 접는다. */
function rectAt(
  g: Element,
  i: number,
  x: number,
  y: number,
  w: number,
  h: number,
  a: Record<string, string | number>,
): number {
  attrs(child(g, i, "rect"), { x, y, width: Math.max(0, w), height: Math.max(0, h), ...a });
  return i + 1;
}

/**
 * 뱃지 글자 폭 추정.
 *
 * ponytail: `getBBox()` 로 재면 정확하지만 rAF 안에서 강제 레이아웃을 부른다 — 드래그
 *           프레임마다 동기 리플로우다. 글자가 넘쳐 보이면 그때 `Map<string, number>` 측정
 *           캐시를 붙인다. 지금 뱃지는 숫자·기호뿐이라 오차가 눈에 띄지 않는다.
 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? FONT : FONT * 0.56;
  return w;
}

/** 배경 상자 + 흰 글자 한 쌍. `cx`·`top` 은 css px(가로 중앙 기준), stage 안으로 접는다. */
function badge(
  g: Element,
  i: number,
  sc: ChromeScreen,
  cx: number,
  top: number,
  text: string,
  bg: string,
): number {
  const w = textWidth(text) + 10;
  const x = clamp(cx - w / 2, 0, Math.max(0, sc.w - w));
  const y = clamp(top, 0, Math.max(0, sc.h - BADGE_H));
  const next = rectAt(g, i, x, y, w, BADGE_H, { rx: 2, fill: bg, stroke: "none" });
  const t = child(g, next, "text");
  attrs(t, {
    x: x + w / 2,
    y: y + 11.5,
    "text-anchor": "middle",
    fill: INK,
    "font-size": FONT,
  });
  t.textContent = text;
  return next + 1;
}

/** 회전 상자의 로컬 모서리·변 중점 8개(0 nw … 7 w) — `hitHandle` 과 같은 순서다. */
function handlePoints(r: { x: number; y: number; w: number; h: number }) {
  const mx = r.x + r.w / 2;
  const my = r.y + r.h / 2;
  return [
    [r.x, r.y],
    [mx, r.y],
    [r.x + r.w, r.y],
    [r.x + r.w, my],
    [r.x + r.w, r.y + r.h],
    [mx, r.y + r.h],
    [r.x, r.y + r.h],
    [r.x, my],
  ] as const;
}

/** 회전이 있으면 anchor 기준 `rotate`, 없으면 속성 자체를 지운다(빈 문자열은 남기지 않는다). */
function setRotate(el: Element, deg: number, cx: number, cy: number): void {
  if (deg) el.setAttribute("transform", `rotate(${deg} ${cx} ${cy})`);
  else el.removeAttribute("transform");
}

// ── 항목별 그리기 ───────────────────────────────────────────────────────────

function drawSelection(
  selG: Element,
  handlesG: Element,
  sc: ChromeScreen,
  st: ChromeState,
): void {
  let i = 0;
  for (const s of st.selection) {
    const r = s.box.rect;
    i = rectAt(selG, i, sx(sc, r.x), sy(sc, r.y), r.w * sc.scale, r.h * sc.scale, {
      fill: "none",
      stroke: CHROME_COLORS.sel,
      "stroke-width": 1,
      // 다중 선택은 객체별 점선 + 합집합 실선이다. 점선 상자에 핸들을 달면 "여기를 잡으면
      // 크기가 바뀐다"고 약속하는 셈인데, 일괄 리사이즈는 없다.
      "stroke-dasharray": s.handles ? "none" : "4 3",
    });
    setRotate(selG.children[i - 1], s.box.rot, sx(sc, s.box.anchor.x), sy(sc, s.box.anchor.y));
  }
  if (st.unionBox && st.selection.length > 1) {
    const u = st.unionBox;
    i = rectAt(selG, i, sx(sc, u.x), sy(sc, u.y), u.w * sc.scale, u.h * sc.scale, {
      fill: "none",
      stroke: CHROME_COLORS.sel,
      "stroke-width": 1,
      "stroke-dasharray": "none",
    });
    selG.children[i - 1].removeAttribute("transform");
  }
  trim(selG, i);

  const h = st.selection.find((s) => s.handles);
  if (!h) {
    trim(handlesG, 0);
    handlesG.removeAttribute("transform");
    return;
  }
  // 핸들 사각형은 그룹 회전을 함께 타 상자와 같은 각도로 눕는다. 회전은 길이를 보존하니
  // 크기는 css 8px 그대로다(e2e (c-9) 가 `getBBox().width` 로 확인한다).
  setRotate(handlesG, h.box.rot, sx(sc, h.box.anchor.x), sy(sc, h.box.anchor.y));
  let k = 0;
  for (const [px, py] of handlePoints(h.box.rect)) {
    k = rectAt(handlesG, k, sx(sc, px) - HANDLE / 2, sy(sc, py) - HANDLE / 2, HANDLE, HANDLE, {
      fill: INK,
      stroke: CHROME_COLORS.sel,
      "stroke-width": 1,
    });
  }
  trim(handlesG, k);
}

function drawHover(g: Element, sc: ChromeScreen, r: ChromeState["hover"]): void {
  const n = r
    ? rectAt(g, 0, sx(sc, r.x), sy(sc, r.y), r.w * sc.scale, r.h * sc.scale, {
        fill: "none",
        stroke: CHROME_COLORS.sel,
        "stroke-width": 1,
        "stroke-opacity": 0.7,
      })
    : 0;
  trim(g, n);
}

function drawMarquee(g: Element, sc: ChromeScreen, r: ChromeState["marquee"]): void {
  const n = r
    ? rectAt(g, 0, sx(sc, r.x), sy(sc, r.y), r.w * sc.scale, r.h * sc.scale, {
        fill: CHROME_COLORS.sel,
        "fill-opacity": 0.12,
        stroke: CHROME_COLORS.sel,
        "stroke-width": 1,
        "stroke-dasharray": "4 3",
      })
    : 0;
  trim(g, n);
}

/** `hud.at` 은 뱃지의 **위쪽 가운데**(oriented px) — 선택 합집합 아래 중앙을 넘기면 시안이 된다. */
function drawHud(g: Element, sc: ChromeScreen, hud: ChromeState["hud"]): void {
  const n = hud
    ? badge(g, 0, sc, sx(sc, hud.at.x), sy(sc, hud.at.y) + 6, hud.text, CHROME_COLORS.sel)
    : 0;
  trim(g, n);
}

/** 크롭 격자 분할비 — 선 개수가 e2e (c-11) 의 단언값이다(3분할 4·4분할 6·황금비 4·대각선 2). */
const CROP_GRID: Record<string, { v: number[]; h: number[]; diag: boolean }> = {
  none: { v: [], h: [], diag: false },
  thirds: { v: [1 / 3, 2 / 3], h: [1 / 3, 2 / 3], diag: false },
  quarters: { v: [0.25, 0.5, 0.75], h: [0.25, 0.5, 0.75], diag: false },
  // 1/φ² 과 1/φ.
  golden: { v: [0.382, 0.618], h: [0.382, 0.618], diag: false },
  diagonal: { v: [], h: [], diag: true },
};

function drawCrop(g: Element, sc: ChromeScreen, crop: ChromeState["crop"]): void {
  if (!crop) return trim(g, 0);
  const x = sx(sc, crop.rect.x);
  const y = sy(sc, crop.rect.y);
  const w = crop.rect.w * sc.scale;
  const h = crop.rect.h * sc.scale;
  const dim = { fill: DIM, "fill-opacity": 0.45, stroke: "none", "data-k": "dim" };
  let i = 0;
  i = rectAt(g, i, 0, 0, sc.w, y, dim);
  i = rectAt(g, i, 0, y + h, sc.w, sc.h - (y + h), dim);
  i = rectAt(g, i, 0, y, x, h, dim);
  i = rectAt(g, i, x + w, y, sc.w - (x + w), h, dim);
  i = rectAt(g, i, x, y, w, h, {
    fill: "none",
    stroke: CHROME_COLORS.sel,
    "stroke-width": 1,
    "data-k": "frame",
  });

  const grid = CROP_GRID[crop.overlay] ?? CROP_GRID.none;
  const faint = { opacity: 0.5 };
  for (const f of grid.v) i = lineAt(g, i, x + w * f, y, x + w * f, y + h, INK, faint);
  for (const f of grid.h) i = lineAt(g, i, x, y + h * f, x + w, y + h * f, INK, faint);
  if (grid.diag) {
    i = lineAt(g, i, x, y, x + w, y + h, INK, faint);
    i = lineAt(g, i, x + w, y, x, y + h, INK, faint);
  }

  if (crop.handles) {
    for (const [px, py] of handlePoints({ x, y, w, h })) {
      i = rectAt(g, i, px - HANDLE / 2, py - HANDLE / 2, HANDLE, HANDLE, {
        fill: INK,
        stroke: CHROME_COLORS.sel,
        "stroke-width": 1,
        "data-k": "handle",
      });
    }
  }
  if (crop.label) i = badge(g, i, sc, x + w / 2, y + h + 6, crop.label, CHROME_COLORS.sel);
  trim(g, i);
}

function drawGuides(
  g: Element,
  sc: ChromeScreen,
  guides: ChromeState["guides"],
  preview: { axis: "x" | "y"; pos: number } | null,
): void {
  let i = 0;
  const all = preview ? [...guides, { ...preview, preview: true, selected: false }] : guides;
  for (const gd of all) {
    const p = gd.axis === "x" ? sx(sc, gd.pos) : sy(sc, gd.pos);
    const vertical = gd.axis === "x";
    i = lineAt(
      g,
      i,
      vertical ? p : 0,
      vertical ? 0 : p,
      vertical ? p : sc.w,
      vertical ? sc.h : p,
      CHROME_COLORS.guide,
      {
        // 선택된 가이드만 진하고 굵다 — Delete 가 무엇을 지울지 눈으로 보여야 한다.
        opacity: gd.selected ? 1 : 0.55,
        width: gd.selected ? 2 : 1,
        dash: gd.preview,
      },
    );
  }
  trim(g, i);
}

function drawSmart(g: Element, sc: ChromeScreen, lines: ChromeState["smartGuides"]): void {
  let i = 0;
  for (const l of lines) {
    // `from`~`to` 는 pos 와 **다른 축**의 구간이다 — 캔버스 전폭이 아니라 두 객체 사이만 긋는다.
    const p = l.axis === "x" ? sx(sc, l.pos) : sy(sc, l.pos);
    const a = l.axis === "x" ? sy(sc, l.from) : sx(sc, l.from);
    const b = l.axis === "x" ? sy(sc, l.to) : sx(sc, l.to);
    i =
      l.axis === "x"
        ? lineAt(g, i, p, a, p, b, CHROME_COLORS.smart)
        : lineAt(g, i, a, p, b, p, CHROME_COLORS.smart);
  }
  trim(g, i);
}

function drawMeasures(g: Element, sc: ChromeScreen, ms: ChromeState["measures"]): void {
  let i = 0;
  for (const m of ms) {
    const x1 = sx(sc, m.from.x);
    const y1 = sy(sc, m.from.y);
    const x2 = sx(sc, m.to.x);
    const y2 = sy(sc, m.to.y);
    i = lineAt(g, i, x1, y1, x2, y2, CHROME_COLORS.smart);
    // 양끝 틱 — 선분만 있으면 "어디까지가 이 거리인가"가 배경 그림에 묻힌다.
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const nx = (-(y2 - y1) / len) * TICK_MINOR;
    const ny = ((x2 - x1) / len) * TICK_MINOR;
    i = lineAt(g, i, x1 - nx, y1 - ny, x1 + nx, y1 + ny, CHROME_COLORS.smart);
    i = lineAt(g, i, x2 - nx, y2 - ny, x2 + nx, y2 + ny, CHROME_COLORS.smart);
    i = badge(g, i, sc, (x1 + x2) / 2, (y1 + y2) / 2 - BADGE_H / 2, m.label, CHROME_COLORS.smart);
  }
  trim(g, i);
}

/**
 * 47·45·48 이 얹는 임의 프리미티브. 좌표는 oriented, 두께·반경은 css px.
 *
 * `path`·`scrim` 만 `transform` 으로 좌표를 옮긴다(`d` 문자열을 파싱해 다시 쓸 수는 없다).
 * 그 안에서는 stroke 도 함께 확대되므로 **`1/scale` 로 되나눠** css px 두께를 지킨다.
 */
function drawExtra(
  g: Element,
  defs: Element,
  sc: ChromeScreen,
  prims: readonly ChromePrim[],
  uid: string,
): void {
  const fit = `translate(${sc.x} ${sc.y}) scale(${sc.scale})`;
  const inv = 1 / (sc.scale || 1);
  let i = 0;
  let masks = 0;
  for (const p of prims) {
    switch (p.k) {
      case "line":
        i = lineAt(
          g,
          i,
          sx(sc, p.x1),
          sy(sc, p.y1),
          sx(sc, p.x2),
          sy(sc, p.y2),
          p.color ?? CHROME_COLORS.sel,
          { dash: p.dash },
        );
        break;
      case "rect":
        i = rectAt(g, i, sx(sc, p.x), sy(sc, p.y), p.w * sc.scale, p.h * sc.scale, {
          fill: p.fill ?? "none",
          stroke: p.color ?? CHROME_COLORS.sel,
          "stroke-width": 1,
        });
        setRotate(g.children[i - 1], p.rot ?? 0, sx(sc, p.x + p.w / 2), sy(sc, p.y + p.h / 2));
        break;
      case "circle":
        attrs(child(g, i++, "circle"), {
          cx: sx(sc, p.cx),
          cy: sy(sc, p.cy),
          r: p.rCss,
          fill: p.fill ?? "none",
          stroke: p.color ?? CHROME_COLORS.sel,
          "stroke-width": 1,
        });
        break;
      case "path":
        attrs(child(g, i++, "path"), {
          d: p.d,
          transform: fit,
          fill: p.fill ?? "none",
          stroke: p.color ?? CHROME_COLORS.sel,
          "stroke-width": inv,
        });
        break;
      case "text":
        i = badge(g, i, sc, sx(sc, p.x), sy(sc, p.y), p.text, p.bg ?? CHROME_COLORS.sel);
        break;
      case "scrim": {
        // 마스크는 defs 에 산다. id 에 창 고유값(uid)과 번호를 함께 넣는 이유: 편집기가 둘
        // 뜨면(메인·doc 창은 별도 웹뷰지만 한 문서에 둘이 뜰 수 있다) 뒤엣것이 앞엣것의
        // 마스크를 덮어써 스크림이 통째로 사라진다.
        const id = `${uid}-scrim-${masks}`;
        const m = child(defs, masks++, "mask");
        attrs(m, { id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: sc.w, height: sc.h });
        rectAt(m, 0, 0, 0, sc.w, sc.h, { fill: INK });
        attrs(child(m, 1, "path"), {
          d: p.cutoutD,
          transform: fit,
          fill: DIM,
          stroke: DIM,
          "stroke-width": (p.cutoutStrokeCss ?? 0) * inv,
        });
        trim(m, 2);
        i = rectAt(g, i, 0, 0, sc.w, sc.h, {
          fill: p.color,
          "fill-opacity": p.alpha,
          mask: `url(#${id})`,
        });
        break;
      }
    }
  }
  trim(g, i);
  trim(defs, masks);
}

/** 눈금 하나 — 띠 안쪽 가장자리에 붙여 `len` 만큼 뻗는다. */
function tickPath(at: number, len: number, vertical: boolean): string {
  return vertical ? `M${RULER - len} ${at}H${RULER}` : `M${at} ${RULER - len}V${RULER}`;
}

function drawRulers(p: Record<string, Element>, sc: ChromeScreen, st: ChromeState): void {
  (p.rulers as SVGGElement).style.display = st.rulers ? "" : "none";
  if (!st.rulers) return;

  attrs(p.bandH, { x: RULER, y: 0, width: Math.max(0, sc.w - RULER), height: RULER });
  attrs(p.bandV, { x: 0, y: RULER, width: RULER, height: Math.max(0, sc.h - RULER) });
  attrs(p.corner, { x: 0, y: 0, width: RULER, height: RULER });

  // 선택 범위 강조(시안 `Ruler Sel Range`) — 모서리 칸은 덮지 않는다.
  const range = (el: Element, a: number, len: number, vertical: boolean) => {
    const from = Math.max(RULER, a);
    const to = Math.max(from, a + len);
    attrs(el, {
      x: vertical ? 0 : from,
      y: vertical ? from : 0,
      width: vertical ? RULER : to - from,
      height: vertical ? to - from : RULER,
    });
  };
  const u = st.unionBox;
  if (u) {
    range(p.rangeH, sx(sc, u.x), u.w * sc.scale, false);
    range(p.rangeV, sy(sc, u.y), u.h * sc.scale, true);
  } else {
    attrs(p.rangeH, { width: 0, height: 0 });
    attrs(p.rangeV, { width: 0, height: 0 });
  }

  const axis = (
    ticks: Element,
    labels: Element,
    offsetCss: number,
    lengthCss: number,
    vertical: boolean,
  ) => {
    // 눈금자는 모서리 칸 다음부터 시작한다 — 오프셋·길이 모두 그 기준으로 넘긴다.
    const start = offsetCss - RULER;
    const span = lengthCss - RULER;
    const t = rulerTicks(sc.scale, start, span);
    // 눈금선 수백 개를 요소로 만들면 팬 한 번에 DOM 이 폭발한다 — 축마다 path 하나로 묶는다.
    let d = "";
    if (t.minorStepCss > 0) {
      // 첫 minor 를 oriented 배수에 맞춘다. 눈금자 끝에서 시작하면 팬 할 때 눈금 전체가
      // 소수 px 씩 미끄러져 major 와 어긋난다.
      const ms = t.minorStepCss;
      for (let c = (((start % ms) + ms) % ms); c <= span; c += ms) {
        d += tickPath(RULER + c, TICK_MINOR, vertical);
      }
    }
    let i = 0;
    for (const m of t.major) {
      const q = RULER + m.css;
      d += tickPath(q, TICK_MAJOR, vertical);
      const el = child(labels, i++, "text");
      attrs(el, {
        x: vertical ? TICK_MAJOR : q + 3,
        y: vertical ? q + 3 : 8,
        fill: INK,
        "fill-opacity": 0.55,
        "font-size": 10,
      });
      // 세로 눈금자 라벨은 반시계로 눕혀 아래에서 위로 읽는다(Figma 동일).
      if (vertical) el.setAttribute("transform", `rotate(-90 ${TICK_MAJOR} ${q + 3})`);
      else el.removeAttribute("transform");
      el.textContent = m.label;
    }
    trim(labels, i);
    ticks.setAttribute("d", d);
  };
  axis(p.ticksH, p.labelsH, sc.x, sc.w, false);
  axis(p.ticksV, p.labelsV, sc.y, sc.h, true);
}

/**
 * 픽셀 그리드는 SVG 가 아니라 CSS 그라디언트다 — 400% 에서 선이 수천 개라 요소로 그리면
 * 노드가 폭발한다. 컴포지터가 GPU 에서 채우므로 캔버스 메모리도 0 이다.
 */
function drawPixelGrid(el: HTMLDivElement, sc: ChromeScreen, on: boolean): void {
  // 4배 미만에서는 격자가 픽셀보다 촘촘해 회색 띠가 된다. 호출자가 이미 걸었더라도 여기서
  // 다시 거는 쪽이 싸다 — 게이트가 한 군데만 있으면 그 한 군데를 빠뜨렸을 때 증상이
  // "확대하면 화면이 회색"이라 원인을 찾기 어렵다.
  if (!on || !(sc.scale >= 4)) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.style.backgroundImage =
    `linear-gradient(to right, ${GRID_LINE} 0 1px, transparent 1px), ` +
    `linear-gradient(to bottom, ${GRID_LINE} 0 1px, transparent 1px)`;
  el.style.backgroundSize = `${sc.scale}px ${sc.scale}px`;
  el.style.backgroundPosition = `${sc.x}px ${sc.y}px`;
}

/**
 * `data-chrome`/`data-r` 로 붙인 고정 슬롯을 이름표로 모은다(첫 `update` 에 1회).
 *
 * 자식 순서를 상수로 박지 않는 이유: 나중에 그룹이 하나 끼어들면 인덱스가 통째로 밀려
 * **아무 에러 없이** 엉뚱한 요소에 그린다. 이름표는 JSX 를 옮겨도 따라온다.
 */
function collectParts(svg: SVGSVGElement): Record<string, Element> {
  const m: Record<string, Element> = {};
  const walk = (parent: Element, attr: string) => {
    for (const c of Array.from(parent.children)) {
      const k = c.getAttribute(attr);
      if (k) m[k] = c;
    }
  };
  walk(svg, "data-chrome");
  if (m.rulers) walk(m.rulers, "data-r");
  return m;
}

// ── 컴포넌트 ────────────────────────────────────────────────────────────────

const ChromeOverlay = forwardRef<ChromeOverlayHandle, ChromeOverlayProps>(
  function ChromeOverlay({ onGuideCommit, snapForGuide }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const defsRef = useRef<SVGDefsElement>(null);
    const partsRef = useRef<Record<string, Element> | null>(null);

    /** 마지막 `update` 인자 — 가이드 드래그가 프레임 밖에서 다시 그릴 때 쓴다. */
    const lastRef = useRef<ChromeState | null>(null);
    const dragRef = useRef<{ axis: "x" | "y"; id: number; rect: DOMRect } | null>(null);
    const previewRef = useRef<{ axis: "x" | "y"; pos: number } | null>(null);
    // React 판마다 useId 의 구분자가 다르다(`:r0:`·`«r0»`) — url(#…) 에 들어가는 값이라
    // 식별자로 쓸 수 있는 글자만 남긴다.
    const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

    useImperativeHandle(
      ref,
      (): ChromeOverlayHandle => ({
        update(st) {
          lastRef.current = st;
          const svg = svgRef.current;
          const grid = gridRef.current;
          const defs = defsRef.current;
          if (!svg || !grid || !defs) return;
          const p = (partsRef.current ??= collectParts(svg));
          const sc = st.screen;
          drawPixelGrid(grid, sc, st.pixelGrid);
          drawCrop(p.crop, sc, st.crop);
          drawMarquee(p.marquee, sc, st.marquee);
          drawHover(p.hover, sc, st.hover);
          drawSelection(p.selection, p.handles, sc, st);
          drawGuides(p.guides, sc, st.guides, previewRef.current);
          drawSmart(p.smart, sc, st.smartGuides);
          drawMeasures(p.measure, sc, st.measures);
          drawExtra(p.extra, defs, sc, st.extra, uid);
          drawHud(p.hud, sc, st.hud);
          drawRulers(p, sc, st);
        },
      }),
      [uid],
    );

    /** 프리뷰 가이드만 다시 그린다 — 끌어내는 동안에는 `paintNow` 프레임이 오지 않는다. */
    const redrawGuides = () => {
      const st = lastRef.current;
      const p = partsRef.current;
      if (st && p) drawGuides(p.guides, st.screen, st.guides, previewRef.current);
    };

    /** 포인터 → 스냅된 oriented 좌표. stage rect 는 드래그 시작에 한 번만 읽는다. */
    const posOf = (axis: "x" | "y", e: React.PointerEvent): number | null => {
      const d = dragRef.current;
      const sc = lastRef.current?.screen;
      if (!d || !sc) return null;
      const raw =
        axis === "x"
          ? (e.clientX - d.rect.left - sc.x) / sc.scale
          : (e.clientY - d.rect.top - sc.y) / sc.scale;
      return snapForGuide(axis, raw);
    };

    const onBandDown = (axis: "x" | "y") => (e: React.PointerEvent<SVGRectElement>) => {
      if (e.button !== 0 || !rootRef.current || !lastRef.current) return;
      e.preventDefault();
      // stage 까지 버블하면 손 도구(Space 홀드 포함)일 때 stage 가 **나중에**
      // `setPointerCapture` 를 걸어 캡처를 빼앗는다 — 같은 이벤트 안에서는 마지막 호출이
      // 이긴다. 그러면 이 띠는 move·up 을 한 번도 못 받아 가이드가 커밋되지 않고,
      // 방금 그린 점선 프리뷰가 지울 사람 없이 화면에 굳는다. 가운데 버튼 팬은 위 가드가
      // 이미 통과시킨다.
      e.stopPropagation();
      // 띠 자신이 포인터를 잡는다 — 캡처가 없으면 stage 밖으로 나가는 순간 move 가 끊겨
      // 가이드가 마지막 위치에 얼어붙는다.
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { axis, id: e.pointerId, rect: rootRef.current.getBoundingClientRect() };
      const pos = posOf(axis, e);
      previewRef.current = pos === null ? null : { axis, pos };
      redrawGuides();
    };

    const onBandMove = (e: React.PointerEvent<SVGRectElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.id) return;
      const pos = posOf(d.axis, e);
      previewRef.current = pos === null ? null : { axis: d.axis, pos };
      redrawGuides();
    };

    const onBandUp = (e: React.PointerEvent<SVGRectElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.id) return;
      const p = previewRef.current;
      const sc = lastRef.current?.screen;
      dragRef.current = null;
      previewRef.current = null;
      redrawGuides();
      // 이미지 밖에서 놓으면 취소다 — 눈금자 띠 위에서 손을 뗀 경우(음수 좌표)도 여기 걸린다.
      if (!p || !sc) return;
      const max = d.axis === "x" ? sc.ow : sc.oh;
      if (p.pos >= 0 && p.pos <= max) onGuideCommit(d.axis, p.pos);
    };

    const onBandCancel = () => {
      dragRef.current = null;
      previewRef.current = null;
      redrawGuides();
    };

    const band = {
      fill: CHROME_COLORS.ruler,
      onPointerMove: onBandMove,
      onPointerUp: onBandUp,
      onPointerCancel: onBandCancel,
    };

    return (
      <div
        ref={rootRef}
        className="pointer-events-none absolute inset-0"
        style={{ zIndex: STAGE_Z.chrome }}
      >
        <div
          data-chrome="pixel-grid"
          ref={gridRef}
          className="absolute inset-0"
          style={{ display: "none" }}
        />
        {/* 그룹 순서 = 겹침 순서. 눈금자가 마지막인 이유는 띠가 불투명이라 stage 가장자리로
            흘러나온 크롬을 덮어야 하기 때문이다. */}
        <svg
          ref={svgRef}
          className="absolute inset-0 block h-full w-full"
          style={{ fontSize: FONT }}
          aria-hidden="true"
        >
          <defs ref={defsRef} />
          <g data-chrome="crop" />
          <g data-chrome="marquee" />
          <g data-chrome="hover" />
          <g data-chrome="selection" />
          <g data-chrome="handles" />
          <g data-chrome="guides" />
          <g data-chrome="smart" />
          <g data-chrome="measure" />
          <g data-chrome="extra" />
          <g data-chrome="hud" />
          <g data-chrome="rulers" style={{ display: "none" }}>
            {/* 오버레이에서 **유일하게** 포인터를 받는 두 요소. 여기서 아래로 끌면 가이드다. */}
            <rect
              data-chrome="ruler-h"
              data-r="bandH"
              className="pointer-events-auto cursor-ns-resize"
              onPointerDown={onBandDown("y")}
              {...band}
            />
            <rect
              data-chrome="ruler-v"
              data-r="bandV"
              className="pointer-events-auto cursor-ew-resize"
              onPointerDown={onBandDown("x")}
              {...band}
            />
            <rect data-r="corner" fill={CHROME_COLORS.ruler} />
            <rect data-r="rangeH" fill="var(--color-accent)" fillOpacity={0.25} />
            <rect data-r="rangeV" fill="var(--color-accent)" fillOpacity={0.25} />
            <path data-r="ticksH" stroke={INK} strokeOpacity={0.45} strokeWidth={1} fill="none" />
            <path data-r="ticksV" stroke={INK} strokeOpacity={0.45} strokeWidth={1} fill="none" />
            <g data-r="labelsH" />
            <g data-r="labelsV" />
          </g>
        </svg>
      </div>
    );
  },
);

export default ChromeOverlay;
