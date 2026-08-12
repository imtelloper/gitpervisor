// 주석 렌더러 — 프리뷰와 저장이 **똑같이** 부르는 단 하나의 함수(§4.1).
//
// 프리뷰 오버레이 캔버스와 renderOutput() 이 같은 renderScene() 을 호출하고 SceneTransform 만
// 다르게 준다. "프리뷰와 저장 결과가 다르다" 클래스의 버그가 구조적으로 불가능해진다.
//
// 기하 정의는 geometry.ts 가 단일 소스다 — 여기서는 색·블렌드·장식(화살촉·글리프·모자이크)만
// 얹는다.

import {
  applyObjectTransform,
  applySceneTransform,
  buildObjectPath,
  fontStringOf,
  layoutText,
  objectAABB,
} from "./geometry";
import {
  ARROW_HEAD_SCALE,
  BADGE_RADIUS_SCALE,
  DEFAULT_FONT_FAMILY,
  type AnnoObject,
  type BadgeObject,
  type LineObject,
  type MosaicObject,
  type ObjId,
  type PenObject,
  type SceneTransform,
  type TextObject,
} from "./types";

export type { SceneTransform } from "./types";

/**
 * 프리뷰 전용 배경 정보(§4.3). 프리뷰는 이미지가 **아래쪽 base 캔버스**에 있고 주석 캔버스는
 * 투명하므로, 배경 픽셀을 필요로 하는 블렌드(형광펜 multiply)가 그대로는 성립하지 않는다.
 * 이걸 넘기면 렌더러가 배경을 재구성해 출력 경로와 같은 픽셀을 만든다.
 *
 * **출력 경로는 이 옵션을 넘기지 않는다** — 이미지가 이미 대상 캔버스에 있어 블렌드가 그대로
 * 성립하고, 넘기지 않은 경우의 코드 경로는 종전과 1비트도 다르지 않다.
 */
export interface PreviewBackdrop {
  /** 회전·반전이 적용된 원본 캔버스(= oriented px 공간, 원점 0,0). */
  image: CanvasImageSource;
  /** 이미지에만 걸리는 색보정 필터 문자열 — base 캔버스의 CSS 필터와 같은 값. */
  filter: string;
}

/**
 * 대상 ctx 에 주석 객체를 그린다. 이미지는 호출부가 **이미 그려 둔 상태**여야 한다
 * (모자이크가 그 픽셀을 샘플링하기 때문).
 *
 * 계약:
 * - 진입 시 `ctx.filter` 는 반드시 `"none"` 이어야 한다. 색보정 필터는 이미지에만 적용된다 —
 *   필터가 남아 있으면 밝기·대비·채도가 마크업까지 물들인다(설계 D2).
 * - 진입 시 CTM 은 항등이어야 한다(`t` 가 전체 변환을 담는다).
 * - 함수는 객체마다 save/restore 로 감싸므로 ctx 상태를 남기지 않는다.
 *
 * @param t      oriented px → 대상 캔버스 px. 프리뷰 `{0,0,s,s}`, 출력 `{−crop.x,−crop.y,outW/sw,outH/sh}`
 * @param opts.skipId   텍스트 편집 중인 객체 — textarea 오버레이가 대신 보여주므로 뺀다(§5.5)
 * @param opts.backdrop 프리뷰에서만 준다. 이미지가 대상 캔버스에 없을 때 배경을 재구성한다.
 */
export function renderScene(
  ctx: CanvasRenderingContext2D,
  objects: readonly AnnoObject[],
  t: SceneTransform,
  opts?: { skipId?: ObjId; backdrop?: PreviewBackdrop },
): void {
  const skip = opts?.skipId;
  for (const o of objects) {
    if (skip && o.id === skip) continue;
    ctx.save();
    drawObject(ctx, o, t, opts?.backdrop);
    ctx.restore();
  }
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  o: AnnoObject,
  t: SceneTransform,
  backdrop?: PreviewBackdrop,
): void {
  // 모자이크는 대상 캔버스 픽셀을 되읽어야 하므로 디바이스 좌표로 따로 처리한다.
  if (o.kind === "mosaic") {
    drawMosaic(ctx, o, t);
    return;
  }
  // 형광펜 multiply 는 배경 픽셀이 있어야 성립한다 — 프리뷰에서는 마스킹 합성으로 재현한다.
  if (o.kind === "highlight" && backdrop) {
    drawHighlightOnBackdrop(ctx, o, t, backdrop);
    return;
  }

  ctx.globalAlpha = Math.max(0, Math.min(1, o.opacity));
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, o);

  ctx.strokeStyle = o.stroke;
  ctx.lineWidth = o.strokeWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  switch (o.kind) {
    case "highlight":
      // 알파만 낮추면 겹치는 획마다 진해져 실제 형광펜과 다르게 보인다. multiply 는 흰 배경 위
      // 글자를 가리지 않고 색만 입힌다. butt cap 이라야 획 끝이 뭉치지 않는다(§5.2).
      ctx.globalCompositeOperation = "multiply";
      ctx.lineCap = "butt";
      ctx.stroke(buildObjectPath(o));
      break;
    case "pen":
      ctx.stroke(buildObjectPath(o));
      break;
    case "line":
    case "arrow":
      ctx.stroke(buildObjectPath(o));
      if (o.kind === "arrow") drawArrowHeads(ctx, o);
      break;
    case "rect":
    case "ellipse": {
      const path = buildObjectPath(o);
      if (o.fill) {
        ctx.fillStyle = o.fill;
        ctx.fill(path);
      }
      if (o.strokeWidth > 0) ctx.stroke(path);
      break;
    }
    case "text":
      drawText(ctx, o);
      break;
    case "badge":
      drawBadge(ctx, o);
      break;
  }
}

// ── 형광펜 프리뷰 합성 (§5.2, D2) ────────────────────────────────────────────

/** 형광펜 마스킹용 재사용 스크래치(모자이크와 따로 — 같은 프레임에 둘 다 쓰일 수 있다). */
let hlScratch: HTMLCanvasElement | null = null;
function hlScratchCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!hlScratch) hlScratch = document.createElement("canvas");
  if (hlScratch.width !== w || hlScratch.height !== h) {
    hlScratch.width = w;
    hlScratch.height = h;
  }
  const ctx = hlScratch.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * 프리뷰에서 형광펜 획을 **출력 경로와 같은 픽셀**로 얹는다.
 *
 * 왜 필요한가: 블렌드 규격상 backdrop 알파가 0이면 multiply 결과는 소스 그대로다. 프리뷰 오버레이
 * 캔버스는 투명이라 multiply 가 source-over 로 퇴화해, 검정 위 노란 형광펜이 프리뷰에서는 보이고
 * 저장 파일에서는 사라진다(출력 캔버스에는 이미지가 같이 있어 진짜 multiply 가 걸린다).
 *
 * 어떻게: 획 bbox 크기 스크래치에
 *   ① 색보정 필터를 건 이미지 → ② 지금까지 오버레이에 그려진 주석(= 현재 보이는 배경 완성)
 *   → ③ multiply + alpha 로 획 → ④ destination-in 으로 같은 획을 불투명 스트로크(획 영역만 남김)
 * 를 차례로 하고, 결과를 오버레이에 source-over 로 얹는다. 획 내부(커버리지 1)에서 얹히는
 * 픽셀은 불투명한 `0.65·bg + 0.35·bg·color/255` 라서 아래 base 캔버스와 합성해도 출력과 같다.
 *
 * ②를 함께 깔기 때문에 형광펜끼리 겹칠 때의 누적 진해짐도 출력과 같이 재현된다.
 *
 * 알려진 한계: 안티에일리어싱 가장자리(커버리지 a<1)에서 ③의 색이 이미 a 만큼 옅어진 뒤 ④가
 * 알파에도 a 를 곱해, 출력의 `bg·(1 − 0.35a + …)` 대신 `a²` 항이 남는다. 획 경계 1px 대의
 * 미세한 차이라 눈에 띄지 않고, 획 내부는 정확히 일치한다.
 */
function drawHighlightOnBackdrop(
  ctx: CanvasRenderingContext2D,
  o: PenObject,
  t: SceneTransform,
  backdrop: PreviewBackdrop,
): void {
  const canvas = ctx.canvas;
  const box = objectAABB(o);
  // 안티에일리어싱이 bbox 를 몇 px 넘어가므로 여유를 준다.
  const pad = 2;
  const x0 = Math.max(0, Math.floor((box.x + t.tx) * t.sx) - pad);
  const y0 = Math.max(0, Math.floor((box.y + t.ty) * t.sy) - pad);
  const x1 = Math.min(canvas.width, Math.ceil((box.x + box.w + t.tx) * t.sx) + pad);
  const y1 = Math.min(canvas.height, Math.ceil((box.y + box.h + t.ty) * t.sy) + pad);
  const dw = x1 - x0;
  const dh = y1 - y0;
  if (dw <= 0 || dh <= 0) return;

  const sc = hlScratchCtx(dw, dh);
  // ① 이미지(색보정 적용) — oriented 공간을 스크래치 원점으로 되민다.
  sc.filter = backdrop.filter;
  sc.translate(-x0, -y0);
  applySceneTransform(sc, t);
  sc.drawImage(backdrop.image, 0, 0);
  sc.setTransform(1, 0, 0, 1, 0, 0);
  sc.filter = "none";
  // ② 이미 오버레이에 그려진 주석(이 획보다 아래 z-order).
  sc.drawImage(canvas, x0, y0, dw, dh, 0, 0, dw, dh);

  // ③ 진짜 multiply — 배경이 불투명해졌으므로 이제 성립한다.
  sc.translate(-x0, -y0);
  applySceneTransform(sc, t);
  applyObjectTransform(sc, o);
  const path = buildObjectPath(o);
  sc.strokeStyle = o.stroke;
  sc.lineWidth = o.strokeWidth;
  sc.lineJoin = "round";
  // butt cap 이라야 획 끝이 뭉치지 않는다(출력 경로와 동일, §5.2).
  sc.lineCap = "butt";
  sc.globalAlpha = Math.max(0, Math.min(1, o.opacity));
  sc.globalCompositeOperation = "multiply";
  sc.stroke(path);

  // ④ 획 영역만 남긴다(canvas clip 은 채움 영역만 받으므로 스트로크에는 마스킹을 쓴다).
  sc.globalAlpha = 1;
  sc.globalCompositeOperation = "destination-in";
  sc.stroke(path);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.drawImage(sc.canvas, 0, 0, dw, dh, x0, y0, dw, dh);
}

/** 화살촉 — 길이 4 × strokeWidth 의 채운 삼각형(§5.2). */
function drawArrowHeads(ctx: CanvasRenderingContext2D, o: LineObject): void {
  ctx.fillStyle = o.stroke;
  drawArrowHead(ctx, o.x1, o.y1, o.x2, o.y2, o.strokeWidth);
  if (o.head === "both") {
    drawArrowHead(ctx, o.x2, o.y2, o.x1, o.y1, o.strokeWidth);
  }
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  strokeWidth: number,
): void {
  const len = ARROW_HEAD_SCALE * strokeWidth;
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (dx === 0 && dy === 0) return;
  const a = Math.atan2(dy, dx);
  const spread = Math.PI / 7; // 좌우 ≈25.7° → 전체 ≈51°
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - len * Math.cos(a - spread), toY - len * Math.sin(a - spread));
  ctx.lineTo(toX - len * Math.cos(a + spread), toY - len * Math.sin(a + spread));
  ctx.closePath();
  ctx.fill();
}

/** 여러 줄 텍스트 — 앵커(x,y)가 첫 줄의 좌상단. 레이아웃은 geometry 와 공유한다. */
function drawText(ctx: CanvasRenderingContext2D, o: TextObject): void {
  const m = layoutText(o);
  ctx.fillStyle = o.stroke;
  ctx.font = fontStringOf(o.fontSize, o.fontFamily);
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < m.lines.length; i++) {
    ctx.fillText(m.lines[i], o.x, o.y + i * m.lineHeight);
  }
}

/** 번호 뱃지 — 반지름 0.9 × fontSize 의 채운 원 + 가운데 숫자(§5.2). */
function drawBadge(ctx: CanvasRenderingContext2D, o: BadgeObject): void {
  const r = BADGE_RADIUS_SCALE * o.fontSize;
  ctx.beginPath();
  ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
  ctx.fillStyle = o.fill;
  ctx.fill();
  if (o.strokeWidth > 0) {
    ctx.strokeStyle = o.stroke;
    ctx.lineWidth = o.strokeWidth;
    ctx.stroke();
  }
  ctx.fillStyle = readableOn(o.fill);
  ctx.font = fontStringOf(o.fontSize, DEFAULT_FONT_FAMILY, 700);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(o.n), o.x, o.y);
}

/** 배경색 위에서 읽히는 글자색(밝기 기준 흰/검 이분). */
function readableOn(bg: string): string {
  const hex = bg.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return "#FFFFFF";
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // ITU-R BT.601 근사 — 정밀한 대비비까지는 필요 없다.
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1C1C1E" : "#FFFFFF";
}

// ── 모자이크 / 블러 (§5.2) ───────────────────────────────────────────────────

/** 픽셀화 축소본을 담는 재사용 스크래치 캔버스(매 프레임 새로 만들면 GC가 튄다). */
let mosaicScratch: HTMLCanvasElement | null = null;
function mosaicScratchCtx(w: number, h: number): CanvasRenderingContext2D {
  if (!mosaicScratch) mosaicScratch = document.createElement("canvas");
  if (mosaicScratch.width !== w || mosaicScratch.height !== h) {
    mosaicScratch.width = w;
    mosaicScratch.height = h;
  }
  const ctx = mosaicScratch.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * 모자이크/블러는 **대상 ctx 자신의 픽셀을 샘플링**한다(renderScene 은 이미지가 그려진 뒤에
 * 불린다). getImageData 를 쓰지 않으므로 taint 걱정이 없다.
 *
 * 배율 보정: 셀 개수를 oriented 크기 기준으로 정하므로(`w / strength`) 프리뷰(s=0.4)와
 * 출력(s=1)에서 **같은 셀 격자**가 나온다. 블러 반경도 배율을 곱해 시각 결과를 맞춘다.
 */
function drawMosaic(
  ctx: CanvasRenderingContext2D,
  o: MosaicObject,
  t: SceneTransform,
): void {
  const canvas = ctx.canvas;
  const box = objectAABB(o); // rot 이 걸려도 외접 사각형을 샘플링하고 클립으로 잘라낸다

  // 회전된 영역이라도 정확한 모양만 남도록 먼저 클립을 건다(clip 은 CTM 을 바꿔도 유지된다).
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, o);
  ctx.beginPath();
  ctx.rect(o.x, o.y, o.w, o.h);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // 이후는 디바이스 좌표로 되그린다
  ctx.globalAlpha = 1;

  const x0 = Math.max(0, Math.floor((box.x + t.tx) * t.sx));
  const y0 = Math.max(0, Math.floor((box.y + t.ty) * t.sy));
  const x1 = Math.min(canvas.width, Math.ceil((box.x + box.w + t.tx) * t.sx));
  const y1 = Math.min(canvas.height, Math.ceil((box.y + box.h + t.ty) * t.sy));
  const dw = x1 - x0;
  const dh = y1 - y0;
  if (dw <= 0 || dh <= 0) return;

  const strength = Math.max(1, o.strength);
  if (o.mode === "blur") {
    const px = (strength * (t.sx + t.sy)) / 2;
    // 가장자리에서 캔버스 밖 투명 픽셀을 빨아들이지 않도록 샘플 영역을 반경만큼 넓힌다.
    const pad = Math.ceil(px * 2);
    const sx0 = Math.max(0, x0 - pad);
    const sy0 = Math.max(0, y0 - pad);
    const sx1 = Math.min(canvas.width, x1 + pad);
    const sy1 = Math.min(canvas.height, y1 + pad);
    ctx.filter = `blur(${px}px)`;
    ctx.drawImage(
      canvas,
      sx0,
      sy0,
      sx1 - sx0,
      sy1 - sy0,
      sx0,
      sy0,
      sx1 - sx0,
      sy1 - sy0,
    );
    ctx.filter = "none";
    return;
  }

  // pixelate — 셀 개수는 oriented 크기로 정해 배율에 불변.
  const cw = Math.max(1, Math.round(dw / Math.max(1, strength * t.sx)));
  const ch = Math.max(1, Math.round(dh / Math.max(1, strength * t.sy)));
  const small = mosaicScratchCtx(cw, ch);
  small.imageSmoothingEnabled = true;
  small.drawImage(canvas, x0, y0, dw, dh, 0, 0, cw, ch);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small.canvas, 0, 0, cw, ch, x0, y0, dw, dh);
  ctx.imageSmoothingEnabled = true;
}
