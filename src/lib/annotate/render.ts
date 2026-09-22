// 주석 렌더러 v2 — 프리뷰·저장·내보내기가 **똑같이** 부르는 단 하나의 진입.
//
// v1 은 캔버스를 둘로 나눠 썼다(아래: 이미지, 위: 투명 주석 오버레이). 그 구조에서는 배경이
// 있어야 성립하는 합성(형광펜 multiply·모자이크 샘플링)을 렌더러가 **매번 재구성**해야 했고,
// 노드 종류가 늘 때마다 그 재구성이 종류마다 복제됐다. 그래서 블렌드·효과·그룹 불투명도는
// 아예 만들 수 없었다(DOCS/pro-image-editor-design.md §8 이 기각한 이유).
//
// v2 는 **씬 캔버스 하나**에 이미지와 노드를 함께 그린다. 그러면 multiply 도, 배경 블러도,
// 그룹 격리도 전부 캔버스 표준 합성 그대로 성립한다 — 재구성 코드가 사라진다.
//
// 진입은 `renderScene(ctx, scene, t, opts)` 하나다. 배열을 넘기면 컴파일 에러다(38 Scene).
// 화면 크롬(선택 상자·핸들·가이드)은 여기 **없다** — SVG 오버레이가 그린다(태스크 43).
//
// 배경: DOCS/task/39-image-render-v2.md

import { currentMessages } from "../../i18n/ui-language";
import { readableOn } from "../color";
import {
  backgroundBlur,
  dropShadow,
  innerShadow,
  layerBlur,
  pixelate,
  releaseEffectScratch,
} from "./effects";
import {
  applyObjectTransform,
  effectReach,
  applySceneTransform,
  buildObjectPath,
  objectAABB,
  objectBBox,
} from "./geometry";
import {
  fontStringOf,
  HAS_CTX_SPACING,
  layoutText,
  setupTextCtx,
} from "./text-layout";
import { layerPool, type LayerPool } from "./layers";
import { fillPaint, gradientOf, strokePaint } from "./paint";
import { imageStore, type ImageStore } from "./imageStore";
import type { MaskScope, Scene, SceneContainer } from "./scene";
import {
  BADGE_RADIUS_SCALE,
  DEFAULT_FONT_FAMILY,
  DEFAULT_STROKE,
  type BadgeObject,
  type BlendMode,
  type EditorDoc,
  type Fill,
  type GeomNode,
  type ObjId,
  type Rect,
  type SceneTransform,
  type TextNode,
} from "./types";

export type { SceneTransform } from "./types";

/** 렌더 옵션 — 프리뷰 백킹·디테일 캔버스·출력 타일·썸네일이 같은 함수를 이 옵션만 바꿔 부른다. */
export interface RenderOpts {
  /** oriented 원본 캔버스. 없으면 노드만 그린다(투명 배경 — 썸네일·에셋 미리보기). */
  image?: CanvasImageSource;
  /** 'image'(기본) · 'transparent' · CSS 색(jpeg 출력의 흰 바탕). */
  background?: "image" | "transparent" | string;
  /** 이미지에만 거는 조정 필터(밝기·대비·채도). 주석에는 물들지 않는다(D2). */
  filter?: string;
  /** 텍스트 편집 중인 노드 — textarea 오버레이가 대신 보여 준다. */
  skipId?: ObjId;
  /** 라이브 미리보기로 따로 그리는 노드들(커밋 캐시에서 뺀다). */
  skipIds?: ReadonlySet<ObjId>;
  /** 부분 렌더 — 생략은 전부, `[]` 는 노드 0개(배경만). 태스크 52 레이어별 내보내기. */
  nodeIds?: readonly ObjId[];
  /** 에셋(이미지 페인트) 디코드 캐시. 없으면 빈 저장소로 그린다(회색 플레이스홀더). */
  store?: ImageStore;
}

/** 격리 레이어 풀 — 상한은 **바이트**다(40 §3.5). 백킹이 커지면 그만큼 늘려 잡는다. */
let pool: LayerPool | null = null;
let poolBytes = 0;
function poolFor(ctx: CanvasRenderingContext2D): LayerPool {
  const want = Math.max(2 * ctx.canvas.width * ctx.canvas.height * 4, 8 * 1024 * 1024);
  if (!pool || poolBytes !== want) {
    pool?.releaseAll();
    pool = layerPool(want);
    poolBytes = want;
  }
  return pool;
}

/**
 * 모듈 스크래치를 놓아 준다 — 편집기 언마운트에서 부른다.
 *
 * 스크래치는 모듈 전역이라 편집기를 닫아도 **마지막 크기 그대로 창 수명 동안 남는다**.
 * doc-* 창은 별도 WebView2라 창마다 따로 쌓인다(4K 전면 가림에서 창당 ~15MB).
 */
export function releaseScratch(): void {
  pool?.releaseAll();
  pool = null;
  poolBytes = 0;
  releaseEffectScratch();
}

// ── 진입 ────────────────────────────────────────────────────────────────────

export function renderScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  t: SceneTransform,
  opts?: RenderOpts,
): void {
  const o = opts ?? {};
  const store = o.store ?? EMPTY_STORE;
  const p = poolFor(ctx);

  // ① 배경 — 이미지가 씬 캔버스에 **함께** 있어야 multiply·배경 블러·그룹 격리가 성립한다.
  const bg = o.background ?? (o.image ? "image" : "transparent");
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  if (bg !== "transparent" && bg !== "image") {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }
  ctx.restore();

  if (o.image && bg !== "transparent") {
    ctx.save();
    // 벡터 모양으로 이미지 자르기(시안 ⑦) — 클립을 먼저 걸고 이미지를 그린다.
    if (scene.imageMask) applyImageMask(ctx, scene, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 조정은 **여기 한 곳**에서만 걸린다(D2: 주석에 물들지 않는다).
    ctx.filter = o.filter && o.filter !== "none" ? o.filter : "none";
    applySceneTransform(ctx, t);
    ctx.drawImage(o.image, 0, 0);
    ctx.restore();
  }

  // ② 노드 — 컨테이너 범위를 만나면 격리 합성한다.
  const only = o.nodeIds ? new Set(o.nodeIds) : null;
  renderRange(ctx, scene, t, 0, scene.nodes.length, o, store, p, only, null, new Set());
}

const EMPTY_STORE: ImageStore = {
  get: () => null,
  ensure: async () => {},
};

/** 씬 노드 구간을 그린다. 컨테이너를 만나면 레이어로 빼서 한 번에 얹는다. */
function renderRange(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  t: SceneTransform,
  start: number,
  end: number,
  o: RenderOpts,
  store: ImageStore,
  p: LayerPool,
  only: Set<ObjId> | null,
  skipMask: ObjId | null,
  /**
   * 지금 열려 있는 컨테이너들. 이게 없으면 `renderContainer` 가 자기 범위를 그리려고 다시
   * `renderRange` 를 부를 때 **자기 자신을 또 잡아** 무한 재귀가 된다(그룹 하나만 있어도).
   */
  open: Set<ObjId>,
): void {
  let i = start;
  while (i < end) {
    const c = containerAt(scene, i, start, end, open);
    if (c) {
      renderContainer(ctx, scene, t, c, o, store, p, only, open);
      i = c.range[1];
      continue;
    }
    const node = scene.nodes[i];
    i++;
    if (skipMask && node.id === skipMask) continue;
    if (o.skipId && node.id === o.skipId) continue;
    if (o.skipIds?.has(node.id)) continue;
    if (only && !only.has(node.id)) continue;
    renderNode(ctx, node, t, store, p);
  }
}

/** `i` 에서 시작하는 컨테이너 중 **가장 바깥**(범위가 큰 것). 중첩은 재귀가 푼다. */
function containerAt(
  scene: Scene,
  i: number,
  start: number,
  end: number,
  open: Set<ObjId>,
): SceneContainer | null {
  let best: SceneContainer | null = null;
  for (const c of scene.containers) {
    if (open.has(c.id)) continue;
    if (c.range[0] !== i || c.range[1] > end || c.range[0] < start) continue;
    // 같은 자리에서 시작하는 컨테이너가 여럿이면 바깥부터 — 안쪽은 재귀에서 다시 잡힌다.
    if (!best || c.range[1] > best.range[1]) best = c;
  }
  return best;
}

/**
 * 컨테이너 격리 합성 — 자식을 스크래치에 먼저 합치고, 그 결과를 불투명도·블렌드·효과·마스크를
 * 걸어 **한 번에** 얹는다.
 *
 * `beginLayer()` 가 있으면 이걸 브라우저가 해 주지만 WebView2(Chrome 152)에는 없다(실측).
 */
function renderContainer(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  t: SceneTransform,
  c: SceneContainer,
  o: RenderOpts,
  store: ImageStore,
  p: LayerPool,
  only: Set<ObjId> | null,
  open: Set<ObjId>,
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const layer = p.acquire(w, h);
  const inner = layer.canvas;
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.globalAlpha = 1;
  layer.globalCompositeOperation = "source-over";
  layer.filter = "none";
  layer.clearRect(0, 0, w, h);

  // 자식을 레이어에 — 안쪽 컨테이너는 재귀가 다시 격리한다. 자기 자신은 `open` 이 막는다.
  open.add(c.id);
  renderRange(layer, scene, t, c.range[0], c.range[1], o, store, p, only, c.mask?.maskId ?? null, open);
  open.delete(c.id);

  // 마스크: 마스크 노드의 알파로 잘라 낸다(모양 마스크는 채우기 알파가 곧 모양이다).
  if (c.mask) applyMask(layer, scene, c.mask, t);
  // 프레임 clipsContent — 잘라내기는 마스크와 같은 자리에서 한다.
  if (c.clip) clipToRect(layer, c.clip, t);

  // 효과는 얹기 직전에 — 레이어 블러와 이너 섀도는 **레이어 안**에서, 드롭 섀도만 얹는 드로우에.
  // 이너 섀도를 씬 캔버스에 걸면 source-atop 이 아래 픽셀 전부에 물든다(effects.ts 계약 ③).
  const src: CanvasImageSource = inner;
  for (const e of c.effects) {
    if (e.type === "layer-blur") layerBlur(layer, inner, e.radius, t);
    if (e.type === "inner-shadow" && c.clip) {
      // 안쪽 가장자리가 정의되는 것은 프레임(clipsContent)뿐이다. 기하 없는 그룹의
      // "안쪽"은 자손 실루엣이라 경로가 없다 — 45가 값을 노출할 때 함께 정한다.
      const path = new Path2D();
      path.rect((c.clip.x + t.tx) * t.sx, (c.clip.y + t.ty) * t.sy, c.clip.w * t.sx, c.clip.h * t.sy);
      innerShadow(layer, path, e, t, p);
    }
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, c.opacity));
  // pass-through 컨테이너가 여기까지 온 것은 불투명도·효과·마스크 때문이다 — 블렌드는 기본값.
  ctx.globalCompositeOperation = gcoOf(c.blend === "pass-through" ? "normal" : c.blend);
  for (const e of c.effects) {
    if (e.type === "drop-shadow") dropShadow(ctx, src, e, t);
  }
  if (c.blend === "linear-burn") drawLinearBurn(ctx, src, ctx.globalAlpha);
  else ctx.drawImage(src, 0, 0);
  ctx.restore();
  p.release(layer);
}

// ── 노드 ────────────────────────────────────────────────────────────────────

/** 노드 하나 — 효과·비표준 블렌드가 있으면 레이어로 빼서 한 번에 얹는다. */
function renderNode(
  ctx: CanvasRenderingContext2D,
  node: GeomNode,
  t: SceneTransform,
  store: ImageStore,
  p: LayerPool,
): void {
  const effects = node.effects.filter((e) => e.visible);
  // 가림(모자이크)은 **대상 픽셀을 되읽는다** — 빈 레이어에 그리면 읽을 배경이 없어 아무것도
  // 가려지지 않는다. 그래서 효과·블렌드가 붙어도 레이어로 빼지 않는다(39 §3.7).
  const needsLayer =
    node.kind !== "mosaic" &&
    (effects.length > 0 || (node.blend !== "normal" && node.blend !== "pass-through"));
  if (!needsLayer) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity));
    ctx.globalCompositeOperation = gcoOf(node.blend);
    paintNode(ctx, node, t, store);
    ctx.restore();
    return;
  }

  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const layer = p.acquire(w, h);
  layer.setTransform(1, 0, 0, 1, 0, 0);
  layer.globalAlpha = 1;
  layer.globalCompositeOperation = "source-over";
  layer.filter = "none";
  layer.clearRect(0, 0, w, h);
  paintNode(layer, node, t, store);

  for (const e of effects) {
    if (e.type === "layer-blur") layerBlur(layer, layer.canvas, e.radius, t);
    if (e.type === "inner-shadow") {
      const path = devicePathOf(node, t);
      innerShadow(layer, path, e, t, p);
    }
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.max(0, Math.min(1, node.opacity));
  ctx.globalCompositeOperation = gcoOf(node.blend);
  for (const e of effects) {
    if (e.type === "drop-shadow") dropShadow(ctx, layer.canvas, e, t);
  }
  if (node.blend === "linear-burn") drawLinearBurn(ctx, layer.canvas, ctx.globalAlpha);
  else ctx.drawImage(layer.canvas, 0, 0);
  ctx.restore();
  p.release(layer);
}

/** 실제 그리기 — 채우기 스택 → 선 스택. 배경을 읽는 종류(모자이크)는 따로 간다. */
function paintNode(
  ctx: CanvasRenderingContext2D,
  node: GeomNode,
  t: SceneTransform,
  store: ImageStore,
): void {
  if (node.kind === "mosaic") {
    drawMosaic(ctx, node, t);
    return;
  }
  if (node.kind === "text") {
    drawText(ctx, node, t, store);
    return;
  }
  if (node.kind === "badge") {
    drawBadge(ctx, node, t, store);
    return;
  }
  ctx.save();
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, node);
  const path = buildObjectPath(node);
  fillPaint(ctx, node, path, t, store);
  strokePaint(ctx, node, path, t, store);
  ctx.restore();
}

/** 디바이스 좌표 경로 — 이너 섀도처럼 CTM 을 안 타는 연산에 쓴다. */
function devicePathOf(node: GeomNode, t: SceneTransform): Path2D {
  const m = new DOMMatrix()
    .scaleSelf(t.sx, t.sy)
    .translateSelf(t.tx, t.ty);
  const out = new Path2D();
  out.addPath(buildObjectPath(node), m);
  return out;
}

/** 캔버스에 없는 블렌드 하나 — `invert ∘ lighter ∘ invert`(39 §3.4). 불투명 배경에서 정확하다. */
function drawLinearBurn(ctx: CanvasRenderingContext2D, src: CanvasImageSource, alpha: number): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 배경을 반전 → 소스를 반전해 더함(lighter) → 전체를 다시 반전.
  ctx.globalCompositeOperation = "difference";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = alpha;
  ctx.filter = "invert(1)";
  ctx.drawImage(src, 0, 0);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "difference";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** 문서 블렌드 → canvas 합성 이름. `linear-dodge` 만 이름이 다르고, `linear-burn` 은 없다. */
function gcoOf(b: BlendMode): GlobalCompositeOperation {
  if (b === "linear-dodge") return "lighter";
  if (b === "linear-burn" || b === "pass-through" || b === "normal") return "source-over";
  return b as GlobalCompositeOperation;
}

// ── 마스크 ──────────────────────────────────────────────────────────────────

/** 컨테이너 마스크 — 마스크 노드의 알파로 레이어를 잘라 낸다. */
export function applyMask(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  mask: MaskScope,
  t: SceneTransform,
): void {
  const node = scene.nodes.find((n) => n.id === mask.maskId);
  if (!node) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  // 반전 마스크는 "모양 **밖**을 남긴다" — destination-out 이 그대로 그 뜻이다.
  ctx.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, node);
  ctx.fillStyle = "#000000";
  ctx.fill(buildObjectPath(node));
  ctx.restore();
}

/** 벡터 모양으로 이미지 자르기(시안 ⑦) — 이미지를 그리기 **전에** 클립을 건다. */
function applyImageMask(ctx: CanvasRenderingContext2D, scene: Scene, t: SceneTransform): void {
  const m = scene.imageMask;
  if (!m) return;
  const node = scene.nodes.find((n) => n.id === m.id);
  if (!node) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, node);
  const path = buildObjectPath(node);
  if (!m.invert) {
    ctx.clip(path);
    return;
  }
  // 반전: 캔버스 전체에서 모양을 뺀 영역(evenodd 두 겹).
  const outer = new Path2D();
  outer.rect(-1e6, -1e6, 2e6, 2e6);
  outer.addPath(path);
  ctx.clip(outer, "evenodd");
}

function clipToRect(ctx: CanvasRenderingContext2D, r: Rect, t: SceneTransform): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000000";
  ctx.fillRect((r.x + t.tx) * t.sx, (r.y + t.ty) * t.sy, r.w * t.sx, r.h * t.sy);
  ctx.restore();
}

// ── 텍스트 · 뱃지 ───────────────────────────────────────────────────────────

/** 채우기 스택 첫 겹의 스타일(단색 또는 그라디언트). 글자·뱃지 원처럼 경로가 하나인 곳에 쓴다. */
function firstPaintStyle(
  ctx: CanvasRenderingContext2D,
  fills: readonly Fill[],
  bbox: Rect,
  t: SceneTransform,
  fallback: string,
): string | CanvasGradient | CanvasPattern {
  for (const f of fills) {
    if (!f.visible) continue;
    if (f.type === "solid") return f.color;
    const g = gradientOf(ctx, f, bbox, t);
    if (g) return g;
  }
  return fallback;
}

/**
 * 여러 줄 텍스트 — 앵커(x,y)가 상자의 좌상단. 줄·런·마커·장식 위치는 **전부** `layoutText`
 * 가 준다(태스크 49). 여기서 좌표를 하나라도 다시 계산하면 프리뷰·저장·히트·편집 오버레이
 * 네 소비자 중 이 하나만 다른 자리에 그린다 — 그게 v1 이 정렬·자간을 못 넣었던 이유다.
 */
function drawText(
  ctx: CanvasRenderingContext2D,
  o: TextNode,
  t: SceneTransform,
  store: ImageStore,
): void {
  void store;
  const l = layoutText(o);
  ctx.save();
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, o);
  ctx.globalAlpha = 1;
  // 글자색은 **채우기 스택**이다(v1 의 stroke 자리 — 37 §3.3 매핑표).
  const fill = firstPaintStyle(ctx, o.fills, objectBBox(o), t, DEFAULT_STROKE);
  // 외곽선은 `strokeText` 라 경로 기반 `strokePaint` 를 못 쓴다. `inside` 는 글리프 클립이
  // 있어야 성립하므로(50 outline 경로) 지금은 `center` 로 그린다 — 인스펙터가 같은 판정을
  // 하도록 `paintOf` 쪽에 표시 규칙이 생기면 그때 갈라진다.
  const outline =
    o.strokeWidth > 0 && o.strokes.some((f) => f.visible)
      ? {
          style: firstPaintStyle(ctx, o.strokes, objectBBox(o), t, DEFAULT_STROKE),
          // outside 는 두께 2배로 긋고 채움으로 안쪽 절반을 덮는다(source-over) — 글리프
          // 안쪽으로 파고드는 선이 얇은 획을 통째로 먹는 것을 막는다.
          width: o.strokeAlign === "outside" ? o.strokeWidth * 2 : o.strokeWidth,
        }
      : null;
  setupTextCtx(ctx, l);
  ctx.fillStyle = fill;
  if (outline) {
    ctx.strokeStyle = outline.style;
    ctx.lineWidth = outline.width;
    ctx.lineJoin = "round";
  }
  for (const line of l.lines) {
    for (const run of line.runs) {
      // 폴백 경로(§3.8)는 런마다 wordSpacing 0 이고 간격을 x 에 이미 넣어 둔다. 속성이 없는
      // 엔진(WKWebView)에서는 대입 자체를 하지 않는다 — 그게 폴백이 존재하는 이유다.
      if (HAS_CTX_SPACING) ctx.wordSpacing = `${run.wordSpacing}px`;
      if (outline) ctx.strokeText(run.text, o.x + run.x, o.y + run.baseline);
      ctx.fillText(run.text, o.x + run.x, o.y + run.baseline);
    }
    // 마커는 저장 문자열에 없다(편집 중 커서가 지우지 못하게) — 레이아웃이 준 자리에 따로 찍는다.
    if (line.marker) {
      ctx.fillText(line.marker.text, o.x + line.marker.x, o.y + line.baseline);
    }
    // 장식은 줄의 잉크 폭만 덮는다. 기준은 **첫 런의 베이스라인**이다 — 첨자가 걸리면 글자가
    // 통째로 올라가는데 밑줄만 제자리에 남으면 글자와 떨어진 선이 하나 뜬다.
    const base = line.runs[0]?.baseline ?? line.baseline;
    const x0 = o.x + (line.runs[0]?.x ?? 0);
    for (const d of [l.decor.underline, l.decor.strike]) {
      if (d) ctx.fillRect(x0, o.y + base + d.y, line.width, d.thick);
    }
  }
  ctx.restore();
}

/** 번호 뱃지 — 반지름 0.9 × fontSize 의 채운 원 + 가운데 숫자. */
function drawBadge(
  ctx: CanvasRenderingContext2D,
  o: BadgeObject,
  t: SceneTransform,
  store: ImageStore,
): void {
  const r = BADGE_RADIUS_SCALE * o.fontSize;
  ctx.save();
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, o);
  const path = buildObjectPath(o);
  fillPaint(ctx, o, path, t, store);
  strokePaint(ctx, o, path, t, store);
  // 숫자 색은 원 색의 대비로 정한다 — 사용자가 고르는 값이 아니다(시안에 항목이 없다).
  const solid = o.fills.find((f) => f.visible && f.type === "solid");
  ctx.fillStyle = readableOn(solid && solid.type === "solid" ? solid.color : DEFAULT_STROKE);
  ctx.font = fontStringOf(o.fontSize, DEFAULT_FONT_FAMILY, 700);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(o.n), o.x, o.y);
  ctx.restore();
  void r;
}

// ── 가림(모자이크·블러) ─────────────────────────────────────────────────────

/**
 * 가림은 **대상 ctx 자신의 픽셀**을 샘플링한다. v2 에서는 이미지가 같은 캔버스에 있으므로
 * 프리뷰에서 원본을 따로 심어 줄 필요가 없다(v1 의 `seedMosaicSources` 가 사라진 이유).
 *
 * 셀 격자·블러 반경은 oriented 기준이라 프리뷰(s<1)와 출력(s=1)에서 같은 결과가 나온다.
 * 합성이 `copy` 인 것과 3σ 가장자리 복제 패딩은 effects.ts 로 옮겼다 — 그 두 가지가 없으면
 * 가려야 할 픽셀이 비친다(e2e 30 (r)(s) 가 지키는 계약).
 */
function drawMosaic(
  ctx: CanvasRenderingContext2D,
  o: Extract<GeomNode, { kind: "mosaic" }>,
  t: SceneTransform,
): void {
  const box = objectAABB(o); // rot 이 걸려도 외접 사각형을 샘플링하고 클립으로 잘라낸다
  ctx.save();
  applySceneTransform(ctx, t);
  applyObjectTransform(ctx, o);
  ctx.beginPath();
  ctx.rect(o.x, o.y, o.w, o.h);
  ctx.clip();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const strength = Math.max(1, o.strength);
  if (o.mode === "blur") backgroundBlur(ctx, box, strength, t);
  else pixelate(ctx, box, strength, t);
  ctx.restore();
}

// ── 저장 전 구조 점검 ───────────────────────────────────────────────────────

/**
 * 픽셀이 아니라 **구조**를 본다 — 가림이 새는 배치와, 이 플랫폼에서 Figma 와 달라지는 합성.
 * 저장·내보내기 확인창이 한 줄로 띄운다(40 §3.6). 차단은 아니다.
 */
export function occlusionIntegrity(scene: Scene): { warnings: string[] } {
  const warnings: string[] = [];
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  for (const c of scene.containers) {
    const translucent = c.opacity < 1 || (c.blend !== "normal" && c.blend !== "pass-through");
    if (!translucent) continue;
    for (let i = c.range[0]; i < c.range[1]; i++) {
      const n = scene.nodes[i];
      if (n?.kind === "mosaic") {
        warnings.push(
          currentMessages().annotate.render.mosaicInTranslucentGroup(Math.round(c.opacity * 100)),
        );
        break;
      }
    }
  }
  for (const n of byId.values()) {
    if (n.blend === "linear-burn") {
      warnings.push(currentMessages().annotate.render.linearBurnEmulated);
      break;
    }
  }
  return { warnings };
}

/** 문서의 에셋 디코드를 보장한다 — 출력·내보내기 전에 반드시 await(52 계약). */
export function ensureAssets(doc: EditorDoc): Promise<void> {
  return imageStore(doc).ensure(doc);
}

// ── 렌더 윈도 · 타일 출력 (태스크 40) ───────────────────────────────────────

/** 디테일 캔버스 한 장의 상한(픽셀). 넘으면 배율을 한 단계 낮춘다(40 §3.1). */
export const MAX_DETAIL_PX = 8_000_000;

/** 출력 타일 한 변의 기본 디바이스 px — 작업 메모리를 출력 크기와 무관하게 묶는다. */
const DEFAULT_TILE_PX = 2048;

/** 씬 전체에서 노드가 자기 경계 밖으로 번지는 최대 거리(oriented px). */
function sceneReach(scene: Scene): number {
  let r = 0;
  for (const n of scene.nodes) {
    r = Math.max(r, effectReach(n));
    // 가림은 배경을 3σ 까지 빨아들인다 — 창 경계가 그 안쪽을 지나면 스크롤마다 결과가 달라진다.
    if (n.kind === "mosaic") r = Math.max(r, n.mode === "blur" ? 3 * n.strength : n.strength);
  }
  return Math.ceil(r);
}

function intersect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * 창(win)만 그린다 — 화면 디테일 캔버스와 출력 타일이 같은 함수를 쓴다.
 *
 * **클램프 사고를 구조로 없앤다**(40 §3.2): 배경 의존 효과(가림·배경 블러)는 캔버스 경계에서
 * 값을 클램프하는데, 창만 그리면 그 경계가 이미지 한가운데를 지나 팬할 때마다 결과가 달라진다.
 * 그래서 작업 캔버스를 `win ⊕ reach` 로 잡고 이미지 경계와 교차시킨다 — 어떤 가시 픽셀에서도
 * 경계는 `reach` 이상 떨어져 있거나(안전), 진짜 이미지 가장자리다(가장자리 복제가 맞는 곳).
 *
 * `win` 이 이미지 전체면 확장 없이 한 번에 그린다 — 프리뷰 백킹·1x 출력은 종전 경로 그대로다.
 */
export function renderRegion(
  scene: Scene,
  win: Rect,
  devScale: number,
  opts: RenderOpts & { into?: CanvasRenderingContext2D; imageSize?: { w: number; h: number } },
): { ctx: CanvasRenderingContext2D; work: Rect } {
  const img = opts.imageSize ?? sizeOfImage(opts.image);
  const bounds: Rect = img ? { x: 0, y: 0, w: img.w, h: img.h } : win;
  const reach = sceneReach(scene);
  const grown: Rect = {
    x: win.x - reach,
    y: win.y - reach,
    w: win.w + reach * 2,
    h: win.h + reach * 2,
  };
  const work = img ? intersect(grown, bounds) : grown;
  const w = Math.max(1, Math.ceil(work.w * devScale));
  const h = Math.max(1, Math.ceil(work.h * devScale));

  let ctx = opts.into ?? null;
  if (!ctx) {
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    ctx = cv.getContext("2d")!;
  } else if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w;
    ctx.canvas.height = h;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  renderScene(ctx, scene, { tx: -work.x, ty: -work.y, sx: devScale, sy: devScale }, opts);
  return { ctx, work };
}

function sizeOfImage(img: CanvasImageSource | undefined): { w: number; h: number } | null {
  if (!img) return null;
  const any = img as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  const w = any.naturalWidth ?? any.width ?? 0;
  const h = any.naturalHeight ?? any.height ?? 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * 저장·내보내기 출력 — **타일로** 그린다.
 *
 * 종전에는 출력 캔버스를 통째로 만들고 한 번에 그렸다. 2x(5760×3210)면 렌더 중 작업 메모리가
 * 출력 크기에 비례해 늘고, 3x 는 166MB 다. 타일이면 작업 캔버스가 타일 하나 + reach 로 묶인다
 * (CLAUDE.md 의 저메모리 강제 종료 이력이 이 상한을 요구한다).
 */
export function renderOutput(
  scene: Scene,
  o: {
    crop: Rect | null;
    outW: number;
    outH: number;
    nodeIds?: readonly ObjId[];
    background: RenderOpts["background"];
    filter?: string;
    tileDevicePx?: number;
    image: CanvasImageSource;
    store?: ImageStore;
  },
): HTMLCanvasElement {
  const img = sizeOfImage(o.image);
  const srcW = o.crop ? o.crop.w : img?.w ?? o.outW;
  const srcH = o.crop ? o.crop.h : img?.h ?? o.outH;
  const sx = o.crop ? o.crop.x : 0;
  const sy = o.crop ? o.crop.y : 0;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(o.outW));
  out.height = Math.max(1, Math.round(o.outH));
  const ctx = out.getContext("2d")!;
  const scale = out.width / Math.max(1, srcW);
  const scaleY = out.height / Math.max(1, srcH);

  // 배율이 축마다 다르면(비율 고정 해제 리사이즈) 타일 좌표가 어긋난다 — 그때는 한 장으로 간다.
  const tile = o.tileDevicePx ?? DEFAULT_TILE_PX;
  const single = Math.abs(scale - scaleY) > 1e-6 || (out.width <= tile && out.height <= tile);
  if (single) {
    renderScene(
      ctx,
      scene,
      { tx: -sx, ty: -sy, sx: scale, sy: scaleY },
      { image: o.image, background: o.background, filter: o.filter, nodeIds: o.nodeIds, store: o.store },
    );
    return out;
  }

  const stepSrc = tile / scale; // 타일 한 변에 해당하는 oriented px
  for (let ty = 0; ty < srcH; ty += stepSrc) {
    for (let tx = 0; tx < srcW; tx += stepSrc) {
      const win: Rect = {
        x: sx + tx,
        y: sy + ty,
        w: Math.min(stepSrc, srcW - tx),
        h: Math.min(stepSrc, srcH - ty),
      };
      const { ctx: work, work: rect } = renderRegion(scene, win, scale, {
        image: o.image,
        background: o.background,
        filter: o.filter,
        nodeIds: o.nodeIds,
        store: o.store,
        imageSize: img ?? undefined,
      });
      // 작업 캔버스에서 **창에 해당하는 부분만** 오려 붙인다(확장분은 효과 계산용이다).
      const cutX = Math.round((win.x - rect.x) * scale);
      const cutY = Math.round((win.y - rect.y) * scale);
      const cutW = Math.max(1, Math.round(win.w * scale));
      const cutH = Math.max(1, Math.round(win.h * scale));
      ctx.drawImage(
        work.canvas,
        cutX,
        cutY,
        cutW,
        cutH,
        Math.round(tx * scale),
        Math.round(ty * scale),
        cutW,
        cutH,
      );
    }
  }
  return out;
}

/**
 * 내보내기 전 메모리 추정 — 배율 게이트와 "예상 용량" 표시의 **단일 출처**(40 §3.3).
 * 인코더 리드백(toBlob 이 만드는 1× 출력 사본)까지 센다 — 그게 빠지면 2x 저장에서 실제 피크를
 * 크게 낮춰 잡는다.
 */
export function estimateRenderBytes(
  scene: Scene,
  o: { outW: number; outH: number; tileDevicePx?: number },
): { peak: number; output: number; work: number } {
  void scene;
  const output = Math.max(1, o.outW) * Math.max(1, o.outH) * 4;
  const tile = o.tileDevicePx ?? DEFAULT_TILE_PX;
  const tiled = o.outW > tile || o.outH > tile;
  const work = tiled ? tile * tile * 4 * 2 : output; // 타일 + 격리 레이어 1장
  const readback = output; // toBlob 인코더가 뜨는 사본
  return { peak: output + work + readback, output, work };
}
