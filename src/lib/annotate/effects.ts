// 효과 — 드롭/이너 섀도, 레이어 블러, 배경 의존 가림(배경 블러·픽셀화). 태스크 39 §3.7.
//
// **`backgroundBlur`/`pixelate` 는 `render.ts` 의 `drawMosaic` 을 이관한 코드다**(v1 render.ts
// :393-461). 모자이크 kind 와 효과 스택의 `background-blur` 는 같은 기제여야 하므로 함수를 하나로
// 두고, drawMosaic 은 이 함수를 부른다. 이관하면서 지켜야 하는 세 가지가 곧 e2e 30 의 단언이다:
//
//   ① `copy` 합성 — 가림은 아래 픽셀을 **남기면 안 되는** 연산이다. source-over 로 얹으면 결과
//      알파가 1 미만인 곳마다 `a×가림 + (1−a)×원본` 이 되어 원본이 그 비율로 비친다((s-1)).
//   ② 가장자리 복제 3σ 패딩 — filter 블러는 **그리는 소스 사각형 밖을 투명으로** 보므로 소스
//      경계에서 결과 알파가 떨어진다(경계열 ≈0.5). 그 경계가 이미지 가장자리와 겹치면 방어가
//      통째로 사라진다 — 좌상단 가리기가 정확히 그 경우였다((r-1~3)).
//   ③ oriented 기준 셀 격자 — 셀 개수를 oriented 크기로 정해 프리뷰(s<1)와 저장(s=1~2)의 셀
//      경계가 같은 oriented 좌표에 온다((j-1~4)).
//
// 좌표 규약: 배경 의존 함수는 **대상 캔버스 픽셀을 되읽는다**(getImageData 를 쓰지 않으므로
// taint 걱정이 없다). 되읽을 사각형은 인자 `rect`(oriented px)이고, 캔버스 밖은 읽지 않도록
// 교차만 취한다 — 40 §3.2 의 렌더 윈도가 오면 그 작업 캔버스 경계가 곧 안전 경계가 된다.

import { hexToRgb } from "../color";
import type { LayerPool } from "./layers";
import type { Effect, Rect, SceneTransform } from "./types";

/**
 * 흐림 반경 → 가우시안 σ(반경과 같은 단위). geometry.ts `effectReach` 의 `1.5B` / `1.5R` 과
 * **같은 상수 계열**이다 — 3σ 가 곧 1.5×반경이라, 여백을 1.5×반경으로 잡으면 커널이 전부 그 안에
 * 들어온다(Skia 블러 지원 반경 ≈2.82σ).
 *
 * - 섀도: canvas `shadowBlur` 는 σ 의 **2배**로 정의된다(규격, CSS box-shadow 동일) →
 *   `shadowBlur = 2·σ·s = B·s`.
 * - 블러: CSS `filter: blur(px)` 의 px 가 곧 σ → `blur(σ·s)` = `blur((R/2)·s)`.
 */
export const BLUR_SIGMA = {
  shadow: (b: number) => b / 2,
  blur: (r: number) => r / 2,
};

// ── 모듈 스크래치 ────────────────────────────────────────────────────────────
//
// 매 프레임 새로 만들면 GC 가 튀고, 모듈 전역이라 편집기를 닫아도 마지막 크기 그대로 창 수명 동안
// 남는다 — 그래서 `releaseEffectScratch()` 를 언마운트에서 부른다(render.ts `releaseScratch` 와 같은 이유).

/** 블러 패딩본·픽셀화 축소본·팽창 실루엣이 돌려 쓰는 스크래치(v1 `mosaicScratch` 이관). */
let fxScratch: HTMLCanvasElement | null = null;
/** `sampleBackdrop` 결과 — 호출부가 들고 있는 동안 fxScratch 가 덮어쓰면 안 되므로 따로 둔다. */
let bdScratch: HTMLCanvasElement | null = null;

function ctxOf(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const ctx = c.getContext("2d")!;
  // 픽셀뿐 아니라 CTM 까지 되돌려야 한다 — `dilateAlpha` 가 translate 를 걸고 나간다.
  // `reset()` 이 없는 구형 엔진(WebKitGTK < 2.40)에서는 canvas.width 재대입이 같은 일을 한다(규격).
  if (c.width !== w || c.height !== h || typeof ctx.reset !== "function") {
    c.width = w; // 백킹 재할당이 곧 초기화
    c.height = h;
  } else {
    ctx.reset();
  }
  return ctx;
}

function fxCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!fxScratch) fxScratch = document.createElement("canvas");
  return ctxOf(fxScratch, w, h);
}

function bdCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!bdScratch) bdScratch = document.createElement("canvas");
  return ctxOf(bdScratch, w, h);
}

/** 모듈 스크래치를 놓아 준다 — 편집기 언마운트에서 부른다(격리 레이어는 `layerPool.releaseAll`). */
export function releaseEffectScratch(): void {
  fxScratch = null;
  bdScratch = null;
}

// ── 공용 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * oriented rect → 대상 캔버스 device 정수 사각형. 클램프는 **캔버스 경계와의 교차**다 —
 * 밖을 읽으면 투명이 섞여 들어와 가림이 옅어진다(v1 render.ts:415-420 과 같은 식).
 */
function deviceRect(canvas: HTMLCanvasElement, r: Rect, t: SceneTransform): Rect {
  const x0 = Math.max(0, Math.floor((r.x + t.tx) * t.sx));
  const y0 = Math.max(0, Math.floor((r.y + t.ty) * t.sy));
  const x1 = Math.min(canvas.width, Math.ceil((r.x + r.w + t.tx) * t.sx));
  const y1 = Math.min(canvas.height, Math.ceil((r.y + r.h + t.ty) * t.sy));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * 색 + 효과 불투명도 → canvas 색 문자열. 문서 색은 항상 hex 다(types.ts `PALETTE`·정규화) —
 * 다른 표기가 들어오면 알파를 못 곱하고 색만 쓴다.
 *
 * 파싱은 `color.ts` 가 한다. 여기 있던 자기 정규식은 그쪽 `normalizeHex` 와 받는 모양이
 * 글자 하나까지 같았다 — 두 벌로 두면 한쪽만 표기를 늘렸을 때 같은 색이 인스펙터에서는 읽히고
 * 섀도에서는 무시되는(= 효과 불투명도가 통째로 빠지는) 차이가 조용히 생긴다.
 */
function withAlpha(color: string, opacity: number): string {
  const a = Math.max(0, Math.min(1, opacity));
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/** 레이어 크기(device px). 격리 레이어는 캔버스라 width/height 가 곧 크기다. */
function sizeOf(src: CanvasImageSource): { w: number; h: number } {
  if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement) return { w: src.naturalWidth, h: src.naturalHeight };
  const c = src as HTMLCanvasElement;
  return { w: c.width, h: c.height };
}

// ── 섀도 · 레이어 블러 ───────────────────────────────────────────────────────

/**
 * 드롭 섀도 — **레이어를 얹으면서 그 그림자를 같이 그린다**(spread 없으면 drawImage 1회).
 *
 * 전제: 레이어는 **현재 CTM 의 (0,0)** 에 놓인다. 위치는 호출부가 translate 로 정하고 **배율은
 * 걸지 않는다** — `shadowBlur/shadowOffset` 은 CTM 을 타지 않아 device px 로 계산되므로, CTM 에
 * 배율이 섞이면 그림자만 어긋난다. 그래서 여기서 `t.sx/t.sy` 를 직접 곱한다(39 §3.7).
 *
 * @param spreadPath `spread > 0` 일 때 팽창 알파를 만들 노드 경로. **레이어와 같은 좌표계**
 *   (= 현재 CTM, 레이어 원점이 0,0)여야 한다. 없으면 레이어 알파를 링으로 근사한다.
 */
export function dropShadow(
  ctx: CanvasRenderingContext2D,
  layer: CanvasImageSource,
  e: Effect,
  t: SceneTransform,
  spreadPath?: Path2D,
): void {
  if (e.type !== "drop-shadow" || !e.visible) return;
  ctx.save();
  ctx.shadowColor = withAlpha(e.color, e.opacity);
  ctx.shadowBlur = 2 * BLUR_SIGMA.shadow(e.blur) * t.sx;
  ctx.shadowOffsetX = e.x * t.sx;
  ctx.shadowOffsetY = e.y * t.sy;
  if (e.spread <= 0) {
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    return;
  }

  // spread 가 있으면 그림자 소스가 레이어가 아니라 **팽창 실루엣**이다. 실루엣 자체는 보이면
  // 안 되므로 캔버스 밖에 그리고 그 거리만큼 shadowOffset 을 되밀어 그림자만 안으로 들인다
  // (shadowOffset 은 CTM 을 안 타므로 device px 로 그대로 더한다).
  const spread = e.spread * t.sx;
  const pad = Math.ceil(spread) + 1;
  const src = dilateAlpha(layer, spread, pad, spreadPath);
  const away = ctx.canvas.width + src.canvas.width + Math.ceil(ctx.shadowBlur) + 1;
  ctx.shadowOffsetX = e.x * t.sx + away;
  ctx.drawImage(src.canvas, -pad - away, -pad);
  // 레이어는 그림자 없이 제자리에.
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/**
 * spread 만큼 팽창시킨 알파(민코프스키 합). 경로를 `lineWidth = 2·spread`·round join 으로
 * stroke 하면 정확히 spread 만큼 부푼다 — 벡터·텍스트는 정확하다(39 §3.7).
 *
 * 결과는 `(pad, pad)` 를 레이어 원점으로 놓는다.
 */
function dilateAlpha(
  layer: CanvasImageSource,
  spread: number,
  pad: number,
  path?: Path2D,
): CanvasRenderingContext2D {
  const { w, h } = sizeOf(layer);
  const s = fxCtx(Math.max(1, w + pad * 2), Math.max(1, h + pad * 2));
  s.translate(pad, pad);
  // 실루엣의 색은 의미가 없다 — 그림자는 소스의 **알파**만 쓰고 색은 shadowColor 가 준다.
  s.drawImage(layer, 0, 0);
  if (path) {
    s.fillStyle = "#000";
    s.strokeStyle = "#000";
    s.lineWidth = spread * 2;
    s.lineJoin = "round";
    s.lineCap = "round";
    s.fill(path);
    s.stroke(path);
    return s;
  }
  // ponytail: 경로가 없으면(이미지 페인트 등) 레이어를 8방향으로 겹쳐 근사한다 — 반경 오차
  // ≤ 8%(cos 22.5°)이고 어차피 그 뒤에 σ=B/2 로 흐려진다. 정확히 하려면 spreadPath 를 넘겨라.
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    s.drawImage(layer, Math.cos(a) * spread, Math.sin(a) * spread);
  }
  return s;
}

/**
 * 이너 섀도 — 3블릿(39 §3.7): 그림자색 채움 → 노드 알파를 (dx,dy) 오프셋 `destination-out`
 * → `filter: blur` 를 걸어 `source-atop`.
 *
 * 전제: `ctx` 는 **이 노드만 그려진 격리 레이어**다. `source-atop` 이 노드 알파 안쪽만 남기는데,
 * 씬 전체가 그려진 캔버스에 걸면 아래 깔린 모든 픽셀에 그림자가 물든다.
 *
 * `path` 는 현재 CTM 좌표계(= 노드가 그려진 그 좌표계)여야 한다.
 */
export function innerShadow(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  e: Effect,
  t: SceneTransform,
  pool: LayerPool,
): void {
  if (e.type !== "inner-shadow" || !e.visible) return;
  const m = ctx.getTransform();
  // ponytail: 스크래치를 대상 캔버스 크기로 잡는다(4K 백킹 7.3MB — 풀 상한 2×백킹 안). 노드
  // bbox 크기면 훨씬 작지만 시그니처에 rect 가 없다. 필요해지면 rect 를 받아 좁힌다.
  const s = pool.acquire(ctx.canvas.width, ctx.canvas.height);

  // ① 그림자색으로 노드 모양을 채운다.
  s.setTransform(m);
  s.fillStyle = withAlpha(e.color, e.opacity);
  s.fill(path);

  // ② 같은 모양을 (dx,dy) 민 자리에서 지운다 → 남는 초승달이 곧 안쪽 그림자다. 오프셋은
  //    device px 라 CTM **앞에** 곱한다(드롭 섀도의 shadowOffset 과 같은 규약).
  s.globalCompositeOperation = "destination-out";
  s.setTransform(new DOMMatrix().translateSelf(e.x * t.sx, e.y * t.sy).multiplySelf(m));
  s.fill(path);
  // ponytail: spread 는 안쪽 그림자를 두껍게 하려면 ②의 구멍을 **침식**해야 하는데 canvas
  // 합성으로는 팽창밖에 안 된다(스크래치 한 장 더 필요). 설계 §3.7 표도 이너 섀도에는 spread 를
  // 정의하지 않는다 — 45 UI 가 값을 노출하면 그때 스크래치를 하나 더 쓴다.

  // ③ 블러를 걸어 노드 알파 안쪽에만 얹는다.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.filter = `blur(${BLUR_SIGMA.shadow(e.blur) * t.sx}px)`;
  ctx.drawImage(s.canvas, 0, 0);
  ctx.restore();
  pool.release(s);
}

/**
 * 레이어 블러 — 격리 레이어를 흐려서 얹는다. 레이어 스크래치는 `visualBounds`(38, `effectReach`
 * = 1.5R = 3σ 여백 포함) 크기라 내용이 스크래치 경계에 닿지 않는다 → 여기서는 가장자리 복제가
 * 필요 없다(닿으면 `backgroundBlur` 처럼 패딩이 필요해진다).
 *
 * 레이어는 드롭 섀도와 같은 규약으로 현재 CTM 의 (0,0) 에 놓인다.
 */
export function layerBlur(
  ctx: CanvasRenderingContext2D,
  layer: CanvasImageSource,
  radius: number,
  t: SceneTransform,
): void {
  if (radius <= 0) return;
  ctx.save();
  ctx.filter = `blur(${BLUR_SIGMA.blur(radius) * t.sx}px)`;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

// ── 배경 의존 가림 (drawMosaic 이관) ─────────────────────────────────────────

/**
 * 대상 ctx 의 `rect` 아래 픽셀을 되읽은 스크래치. 격리 스택에서 "지금까지 그려진 배경"을
 * 떠 오는 용도다(39 §3.7 `sampleBackdrop`).
 *
 * 돌려주는 캔버스의 (0,0) 은 device 좌표 `(max(0, ⌊(rect.x+tx)·sx⌋), …)` — 호출부가 같은
 * `deviceRect` 규칙으로 위치를 되계산한다. 캔버스 밖은 읽지 않으므로 rect 가 밖으로 나가면
 * 그만큼 작다.
 */
export function sampleBackdrop(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  t: SceneTransform,
): CanvasRenderingContext2D {
  const d = deviceRect(ctx.canvas, rect, t);
  const s = bdCtx(Math.max(1, d.w), Math.max(1, d.h));
  if (d.w > 0 && d.h > 0) s.drawImage(ctx.canvas, d.x, d.y, d.w, d.h, 0, 0, d.w, d.h);
  return s;
}

/**
 * 배경 블러 — `rect` 안의 대상 캔버스 픽셀을 흐린 것으로 **대체**한다(drawMosaic blur 분기 이관).
 *
 * 호출부가 먼저 노드 모양으로 clip 을 걸어 둔다(회전·둥근 모서리는 그 clip 이 잘라낸다).
 * 목적지 사각형이 clip 을 완전히 덮으므로 `copy` 가 clip 밖을 건드리지 않는다.
 *
 * @param radius 블러 **σ(oriented px)** — `MosaicObject.strength` 가 곧 이 값이다. 효과 스택의
 *   반경 R 은 `BLUR_SIGMA.blur(R)` 로 바꿔 넘긴다(σ = R/2).
 */
export function backgroundBlur(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  radius: number,
  t: SceneTransform,
): void {
  const d = deviceRect(ctx.canvas, rect, t);
  if (d.w <= 0 || d.h <= 0) return;
  // 축 배율이 다르면(비율 고정 해제 리사이즈) **큰 쪽**에 맞춘다 — 가리기가 목적이라 약해지는
  // 쪽으로 틀리면 안 된다. 등방 배율에서는 종전 평균과 같은 값이다.
  const px = Math.max(1, radius) * Math.max(t.sx, t.sy);
  // 캔버스에서 직접 넓게 떠서 블러하면 안 된다 — 소스 경계 알파 감쇠가 이미지·크롭 가장자리에서
  // 클램프에 걸려 모자이크 사각형과 겹친다(파일 머리 ②). 가장자리 복제로 3σ 패딩을 만든 스크래치를
  // 블러하면 clip 안 알파가 어디서나 1이다.
  const p = Math.ceil(px * 3) + 1;
  const pw = d.w + p * 2;
  const ph = d.h + p * 2;
  const s = fxCtx(pw, ph);
  s.imageSmoothingEnabled = false;
  s.drawImage(ctx.canvas, d.x, d.y, d.w, d.h, p, p, d.w, d.h);
  // 좌·우 한 열을 패딩 폭으로 늘린 뒤, 위·아래를 전폭으로 늘려 모서리까지 채운다.
  s.drawImage(s.canvas, p, p, 1, d.h, 0, p, p, d.h);
  s.drawImage(s.canvas, p + d.w - 1, p, 1, d.h, p + d.w, p, p, d.h);
  s.drawImage(s.canvas, 0, p, pw, 1, 0, 0, pw, p);
  s.drawImage(s.canvas, 0, p + d.h - 1, pw, 1, 0, p + d.h, pw, p);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // 되읽기·되그리기는 device 좌표로
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "copy";
  ctx.filter = `blur(${px}px)`;
  // 스크래치 **전체**를 그린다 — 부분 소스로 그리면 그 경계에 같은 감쇠가 다시 생긴다.
  ctx.drawImage(s.canvas, d.x - p, d.y - p);
  ctx.restore();
}

/**
 * 픽셀화 — `rect` 안을 셀 격자 평균으로 **대체**한다(drawMosaic pixelate 분기 이관).
 *
 * 셀 개수를 oriented 크기(`dw / (cell·s)`)로 정하므로 프리뷰(s<1)와 저장(s=1~2)에서 **같은 셀
 * 격자**가 나온다 — 배율 보정이 빠지면 저장본 셀이 oriented 로 작아져 경계 셀이 사라진다((j-4)).
 *
 * @param cell 셀 크기(oriented px) — `MosaicObject.strength`.
 */
export function pixelate(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  cell: number,
  t: SceneTransform,
): void {
  const d = deviceRect(ctx.canvas, rect, t);
  if (d.w <= 0 || d.h <= 0) return;
  const c = Math.max(1, cell);
  const cw = Math.max(1, Math.round(d.w / Math.max(1, c * t.sx)));
  const ch = Math.max(1, Math.round(d.h / Math.max(1, c * t.sy)));
  const small = fxCtx(cw, ch);
  small.imageSmoothingEnabled = true; // 축소가 곧 셀 평균
  small.drawImage(ctx.canvas, d.x, d.y, d.w, d.h, 0, 0, cw, ch);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "copy";
  ctx.imageSmoothingEnabled = false; // 셀 경계가 뭉개지지 않게 최근접 확대
  ctx.drawImage(small.canvas, 0, 0, cw, ch, d.x, d.y, d.w, d.h);
  ctx.restore();
}
