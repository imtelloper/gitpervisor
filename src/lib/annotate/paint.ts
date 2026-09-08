// 페인트 스택 렌더 — 노드가 든 `fills`/`strokes` 한 겹씩을 캔버스 상태로 옮긴다(태스크 39 §3.6).
//
// 기하는 geometry.ts 가, 합성 구조(격리 레이어·마스크·효과)는 render.ts/effects.ts 가 소유한다.
// 여기는 **색과 겹**만 본다 — 그래서 리프든 텍스트 글리프든 같은 두 함수를 지난다.
//
// 좌표 계약: 진입 시 ctx 의 CTM 은 `applySceneTransform` + `applyObjectTransform` 이 걸린
// **객체 로컬 좌표**여야 한다(넘겨받는 `path` 가 buildObjectPath 의 로컬 경로다). 그래서
// lineWidth·그라디언트 좌표는 oriented px 그대로 두면 CTM 이 배율을 먹인다. `t` 는 CTM 을
// 타지 않는 값(대시 — §3.6)과 "디바이스 1px 이 로컬 몇 단위인가"(다이아 이음매 보정)에만 쓴다.
//
// 알파 계약: 진입 시 `ctx.globalAlpha` 를 **기준 알파로 읽어 곱한다**. 노드 불투명도를 호출부가
// 직접 걸었든 격리 레이어가 나중에 걸든(§3.3) 여기서 두 번 곱하는 일이 없다.
//
// 스크래치 캔버스를 만들지 않는다 — 선 정렬은 clip 으로, 다이아 그라디언트는 4분할 clip 으로 푼다.

import { objectBBox } from "./geometry";
import type { ImageStore } from "./imageStore";
import {
  ARROW_HEAD_SCALE,
  type BlendMode,
  type Fill,
  type GeomNode,
  type Paint,
  type PaintStop,
  type Rect,
  type SceneTransform,
} from "./types";

const DEG = Math.PI / 180;

/** 디코드 전 이미지 페인트 자리(§3.6) — 뭐가 올 자리인지는 보이되 저장본과 구분은 된다. */
const IMAGE_PLACEHOLDER = "rgba(200, 200, 200, 0.4)";

/** 다이아 그라디언트 4분할이 서로 겹치는 폭(디바이스 px). 0 이면 대각선에 실금이 남는다. */
const SECTOR_OVERLAP_PX = 0.5;

// ── 공개 계약 ────────────────────────────────────────────────────────────────

/**
 * `node.fills` 를 **아래→위**(배열 순서)로 겹겹이 칠한다. 겹마다 `visible` 과 `blend` 를 본다.
 *
 * 틀리면: 순서가 뒤집혀 맨 위 겹만 보이거나(다중 채우기가 통째로 사라진다), gCO·알파를
 * 되돌리지 못해 **이 노드 다음에 그리는 모든 것**이 곱연산·반투명으로 물든다.
 */
export function fillPaint(
  ctx: CanvasRenderingContext2D,
  node: GeomNode,
  path: Path2D,
  t: SceneTransform,
  store: ImageStore,
): void {
  const rule = fillRuleOf(node);
  const bbox = paintBox(node, node.fills);
  const base = ctx.globalAlpha;
  for (const f of node.fills) {
    if (!f.visible) continue;
    ctx.save();
    ctx.globalCompositeOperation = compositeOf(f.blend);
    ctx.globalAlpha = base;
    paintLayer(ctx, f, bbox, t, store, () => ctx.fill(path, rule));
    ctx.restore();
  }
}

/**
 * `node.strokes` 를 겹겹이 긋는다 — 정렬·대시·캡·조인·마이터·화살촉까지 여기서 끝난다.
 *
 * 정렬(§3.6): canvas 는 중앙 정렬만 그리므로 `inside` 는 경로 안쪽으로 clip 한 뒤 두께를 2배로,
 * `outside` 는 경로 **밖**으로 clip 한 뒤 2배로 긋는다(잘려 나간 절반이 정확히 반대쪽이다).
 * 열린 경로(펜·형광펜·선·화살표·열린 서브패스만 있는 path)는 안팎이 정의되지 않아 center 강제다.
 *
 * 틀리면: 정렬 클립이 빠져 도형이 두께의 절반만큼 커/작아 보이고(경계 1px 단언 (t-9) 가 잡는다),
 * 2배 두께를 빼면 선이 절반 굵기로 그려진다.
 */
export function strokePaint(
  ctx: CanvasRenderingContext2D,
  node: GeomNode,
  path: Path2D,
  t: SceneTransform,
  store: ImageStore,
): void {
  const w = node.strokeWidth;
  if (!(w > 0)) return;
  const rule = fillRuleOf(node);
  const bbox = paintBox(node, node.strokes);
  const base = ctx.globalAlpha;
  // 열린 경로는 안팎이 없다 — Figma 와 같이 center 로 떨어뜨린다.
  const align = isOpenPath(node) ? "center" : node.strokeAlign;
  const heads = headAnchors(node);
  for (const s of node.strokes) {
    if (!s.visible) continue;
    ctx.save();
    ctx.globalCompositeOperation = compositeOf(s.blend);
    ctx.globalAlpha = base;
    ctx.lineWidth = align === "center" ? w : w * 2;
    ctx.lineCap = node.cap;
    ctx.lineJoin = node.join;
    ctx.miterLimit = node.miterLimit;
    // 대시 길이는 39 §3.6 계약대로 `t.sx` 를 곱한다.
    // 주의: setLineDash 값은 캔버스 규격상 CTM 을 타므로 이미 배율이 한 번 걸려 있다 —
    // 프리뷰(s<1)와 출력(s=1)의 대시 주기가 어긋나면 이 곱이 원인이다. 계약을 임의로 바꾸지
    // 않고 그대로 두되, e2e 30 (u) 대시 단언이 판정한다.
    ctx.setLineDash(node.dash && node.dash.length > 0 ? node.dash : []);
    if (align === "inside") ctx.clip(path, rule);
    else if (align === "outside") ctx.clip(outsideClip(path, bbox, w), "evenodd");
    paintLayer(ctx, s, bbox, t, store, () => {
      ctx.stroke(path);
      // 화살촉은 선과 **같은 페인트**로 채운다(그라디언트 선이면 머리도 그라디언트다).
      if (heads) {
        if (heads.start) drawArrowHead(ctx, heads.start, w);
        if (heads.end) drawArrowHead(ctx, heads.end, w);
      }
    });
    ctx.restore();
  }
}

/**
 * 그라디언트 페인트를 캔버스 스타일로. 단색·이미지·다이아는 여기서 만들 수 없어 null 이다
 * (단색은 `fillStyle` 그대로, 이미지는 `ImageStore` 가 필요하고, 다이아는 canvas 에 없어
 * `fillPaint`/`strokePaint` 가 4분할 clip 으로 직접 그린다 — §3.6).
 *
 * 각도 규약: 0° = +x(오른쪽), 양수는 시계방향(캔버스 y-down). `scale` 1 이면 스톱 0·1 이
 * bbox 양 끝에 정확히 닿는다.
 *
 * 틀리면: 스톱 0/1 지점이 bbox 안쪽/바깥에 놓여 가장자리에 단색 띠가 생기거나 램프가 잘린다.
 *
 * `_t` 는 계약(39 §4)의 자리만 지킨다 — 그라디언트 좌표는 전부 로컬 좌표라 배율이 필요 없다.
 */
export function gradientOf(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  bbox: Rect,
  _t: SceneTransform,
): CanvasGradient | CanvasPattern | null {
  if (paint.type === "solid" || paint.type === "image" || paint.type === "diamond") return null;
  if (paint.stops.length === 0) return null;
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const scale = paint.scale > 0 ? paint.scale : 1;
  if (paint.type === "angular") {
    // 원뿔은 각도만 쓴다(scale 은 반지름이 없어 뜻이 없다). 구형 WebKitGTK 에 없을 수 있어
    // 없으면 선형으로 낮춘다 — 채우기가 통째로 사라지는 것보다는 낫다(INDEX §10.5 부류).
    if (typeof ctx.createConicGradient !== "function") {
      return linearGradient(ctx, bbox, paint.angle, scale, paint.stops);
    }
    const g = ctx.createConicGradient(paint.angle * DEG, cx, cy);
    addStops(g, paint.stops);
    return g;
  }
  if (paint.type === "radial") {
    // 반지름은 **반대각선** — 선형과 같은 "scale 1 = bbox 를 꽉 채운다" 규약이다(코너까지 램프가
    // 닿는다). canvas 는 타원 그라디언트가 없어 `angle` 은 원에 영향이 없다.
    const r = (Math.hypot(bbox.w, bbox.h) / 2) * scale;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(r, 1e-6));
    addStops(g, paint.stops);
    return g;
  }
  return linearGradient(ctx, bbox, paint.angle, scale, paint.stops);
}

// ── 겹 하나 그리기 ───────────────────────────────────────────────────────────

/**
 * 페인트 한 겹을 `fillStyle`/`strokeStyle` 로 만들고 `draw` 를 부른다.
 *
 * 다이아만 `draw` 를 4번 부른다 — canvas 에 다이아 그라디언트가 없어서, bbox 를 중심 기준
 * 4삼각형으로 clip 하고 각 삼각형에 중심→변 중점 선형 그라디언트를 건다. 삼각형 안에서는
 * 거리값이 축 하나(L∞)로 떨어져 **정확히 선형**이고, 대각선에서 양쪽 값이 같아 이어진다.
 */
function paintLayer(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  bbox: Rect,
  t: SceneTransform,
  store: ImageStore,
  draw: () => void,
): void {
  if (paint.type === "solid") {
    ctx.globalAlpha *= clamp01(paint.opacity);
    ctx.fillStyle = paint.color;
    ctx.strokeStyle = paint.color;
    draw();
    return;
  }
  if (paint.type === "image") {
    const pat = patternOf(ctx, paint, bbox, store);
    ctx.fillStyle = pat ?? IMAGE_PLACEHOLDER;
    ctx.strokeStyle = pat ?? IMAGE_PLACEHOLDER;
    draw();
    return;
  }
  if (paint.type === "diamond") {
    if (paint.stops.length === 0) return;
    const scale = paint.scale > 0 ? paint.scale : 1;
    for (const sector of diamondSectors(bbox, t, scale)) {
      const g = ctx.createLinearGradient(sector.x0, sector.y0, sector.x1, sector.y1);
      addStops(g, paint.stops);
      ctx.save();
      ctx.clip(sector.clip);
      ctx.fillStyle = g;
      ctx.strokeStyle = g;
      draw();
      ctx.restore();
    }
    return;
  }
  const g = gradientOf(ctx, paint, bbox, t);
  if (!g) return;
  ctx.fillStyle = g;
  ctx.strokeStyle = g;
  draw();
}

/** 블렌드 19 → canvas gCO(§3.4). 17종은 철자가 같아 매핑표가 필요 없다. */
function compositeOf(blend: BlendMode): GlobalCompositeOperation {
  switch (blend) {
    case "pass-through":
    case "normal":
      return "source-over";
    case "linear-dodge":
      return "lighter";
    case "linear-burn":
      // 정확한 invert∘lighter∘invert 는 배경 스크래치가 필요해 render.ts(§3.4)가 노드/컨테이너
      // 단위로만 한다. 겹 하나짜리 근사는 곱하기다 — 양 끝(S=0,S=1)에서 값이 같다.
      return "multiply";
    default:
      return blend;
  }
}

/** 그라디언트 스톱 — 스톱 알파는 색에 녹여 넣는다(CanvasGradient 에 알파 채널이 따로 없다). */
function addStops(g: CanvasGradient, stops: readonly PaintStop[]): void {
  for (const s of stops) {
    g.addColorStop(clamp01(s.pos), withAlpha(s.color, s.opacity));
  }
}

function linearGradient(
  ctx: CanvasRenderingContext2D,
  bbox: Rect,
  angleDeg: number,
  scale: number,
  stops: readonly PaintStop[],
): CanvasGradient {
  const a = angleDeg * DEG;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  // 방향 d 로 잰 bbox 의 지지함수 절반 — 135° 정사각형이면 대각선 전체가 되어 코너에서 코너로 간다.
  const half = ((Math.abs(bbox.w * dx) + Math.abs(bbox.h * dy)) / 2) * scale;
  const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  addStops(g, stops);
  return g;
}

interface Sector {
  clip: Path2D;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * 다이아 그라디언트의 4분할 — bbox 를 두 대각선으로 자른 위/오른쪽/아래/왼쪽 삼각형과,
 * 각 삼각형이 쓸 중심→변 중점 선형 그라디언트 축.
 *
 * 틀리면: 대각선 4줄에 1px 실금이 남는다(X 자). canvas 의 clip 은 안티에일리어싱되므로 두
 * 삼각형을 딱 맞대면 경계 커버리지가 1에 못 미쳐 밝은 선이 생긴다 — 그래서 각 삼각형을
 * 반지름에 수직으로 조금 벌려 겹치게 한다. 겹치는 자리의 두 값은 대각선에서 같으므로
 * (L∞ 라 |dx|=|dy| 에서 일치) 색이 튀지 않는다.
 */
function diamondSectors(b: Rect, t: SceneTransform, scale: number): Sector[] {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const x1 = b.x + b.w;
  const y1 = b.y + b.h;
  // 시계방향(캔버스 y-down): TL → TR → BR → BL. 각 구역은 [i] 와 [i+1] 을 잇는 변이 맡는다.
  const corners: [number, number][] = [
    [b.x, b.y],
    [x1, b.y],
    [x1, y1],
    [b.x, y1],
  ];
  const mids: [number, number][] = [
    [cx, b.y],
    [x1, cy],
    [cx, y1],
    [b.x, cy],
  ];
  const lat = SECTOR_OVERLAP_PX / Math.max(Math.abs(t.sx), 1e-6);
  const out: Sector[] = [];
  for (let i = 0; i < 4; i++) {
    const a = nudge(cx, cy, corners[i], lat, -1); // 반시계 끝 — 바깥(반시계)으로
    const c = nudge(cx, cy, corners[(i + 1) % 4], lat, 1); // 시계 끝 — 바깥(시계)으로
    const p = new Path2D();
    p.moveTo(cx, cy);
    p.lineTo(a.x, a.y);
    p.lineTo(c.x, c.y);
    p.closePath();
    out.push({
      clip: p,
      x0: cx,
      y0: cy,
      x1: cx + (mids[i][0] - cx) * scale,
      y1: cy + (mids[i][1] - cy) * scale,
    });
  }
  return out;
}

/** 중심에서 본 반지름에 **수직**으로 `lat` 만큼 민 점(sign 이 시계/반시계 방향). */
function nudge(
  cx: number,
  cy: number,
  p: [number, number],
  lat: number,
  sign: 1 | -1,
): { x: number; y: number } {
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: p[0], y: p[1] };
  return { x: p[0] + (sign * -dy * lat) / len, y: p[1] + (sign * dx * lat) / len };
}

/**
 * 이미지 페인트 → 패턴. `fill` 은 bbox 를 덮는 최대 배율(넘치는 쪽이 잘린다), `fit` 은 다 들어가는
 * 최소 배율(남는 쪽이 빈다), `stretch` 는 축마다 따로 늘린다. 셋 다 bbox 중앙 정렬이다.
 *
 * 틀리면: fill/fit 이 뒤바뀌어 인물이 잘리거나 여백이 생기고, 중앙 정렬을 빼면 좌상단으로 쏠린다.
 */
function patternOf(
  ctx: CanvasRenderingContext2D,
  paint: Extract<Paint, { type: "image" }>,
  bbox: Rect,
  store: ImageStore,
): CanvasPattern | null {
  const bmp = store.get(paint.assetId);
  if (!bmp || bmp.width <= 0 || bmp.height <= 0) return null;
  if (bbox.w <= 0 || bbox.h <= 0) return null;
  const pat = ctx.createPattern(bmp, "no-repeat");
  if (!pat) return null;
  const kx = bbox.w / bmp.width;
  const ky = bbox.h / bmp.height;
  const uniform =
    paint.mode === "stretch" ? null : paint.mode === "fill" ? Math.max(kx, ky) : Math.min(kx, ky);
  const sx = uniform ?? kx;
  const sy = uniform ?? ky;
  const ox = bbox.x + (bbox.w - bmp.width * sx) / 2;
  const oy = bbox.y + (bbox.h - bmp.height * sy) / 2;
  // 패턴 변환은 그릴 때의 사용자 좌표(= 객체 로컬) 기준이라 bbox 를 그대로 쓸 수 있다.
  pat.setTransform(new DOMMatrix([sx, 0, 0, sy, ox, oy]));
  return pat;
}

// ── 경로 성질 ────────────────────────────────────────────────────────────────

/** path 노드만 자기 채우기 규칙을 든다(시안 ③ `채우기 규칙 짝수-홀수`). */
function fillRuleOf(node: GeomNode): CanvasFillRule {
  return node.kind === "path" ? node.fillRule : "nonzero";
}

/** 안팎이 정의되지 않는 열린 경로인가 — 선 정렬을 center 로 떨어뜨릴 판정(§3.6). */
function isOpenPath(node: GeomNode): boolean {
  switch (node.kind) {
    case "pen":
    case "highlight":
    case "line":
    case "arrow":
      return true;
    case "path":
      return !node.subpaths.some((s) => s.closed && s.verts.length > 1);
    default:
      return false;
  }
}

/**
 * 그라디언트·이미지 매핑에 쓸 bbox. 단색뿐이면 계산하지 않는다 — 텍스트 노드의 `objectBBox` 는
 * measureText 를 돌린다(geometry.ts:135). 프레임마다 도는 경로라 공짜가 아니다.
 */
function paintBox(node: GeomNode, stack: readonly Fill[]): Rect {
  for (const f of stack) {
    if (f.visible && f.type !== "solid") return objectBBox(node);
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * 바깥 정렬용 클립 경로 — 경로를 완전히 감싸는 사각형 ∪ 경로를 evenodd 로 잘라 "경로 밖"만 남긴다.
 * 사각형은 2배 두께로 그은 선이 닿는 곳보다 넉넉해야 한다(모자라면 선 끝이 잘린다).
 *
 * 알려진 한계: 자기 교차하는 nonzero 경로는 evenodd 판정이 달라 안쪽 고리가 클립에 남을 수 있다.
 */
function outsideClip(path: Path2D, bbox: Rect, w: number): Path2D {
  const m = w * 2 + 2;
  const p = new Path2D();
  p.rect(bbox.x - m, bbox.y - m, bbox.w + m * 2, bbox.h + m * 2);
  p.addPath(path);
  return p;
}

// ── 화살촉 (§3.6 — render.ts:282 과 같은 기하) ───────────────────────────────

interface HeadAnchor {
  /** 접선의 시작(꼬리 쪽). */
  fromX: number;
  fromY: number;
  /** 머리가 앉는 끝점. */
  toX: number;
  toY: number;
}

/** `heads` 가 켜진 끝점과 그 접선. 닫힌 경로처럼 끝점이 없는 노드는 null. */
function headAnchors(node: GeomNode): { start: HeadAnchor | null; end: HeadAnchor | null } | null {
  if (node.heads.start !== "arrow" && node.heads.end !== "arrow") return null;
  const ends = pathEnds(node);
  if (!ends) return null;
  return {
    start: node.heads.start === "arrow" ? ends.start : null,
    end: node.heads.end === "arrow" ? ends.end : null,
  };
}

/**
 * 열린 경로의 양 끝점과 접선.
 *
 * 펜은 midpoint 이차 베지어로 이어지는데(geometry.ts:165) 첫·마지막 구간만은 정점을 직접 지나므로
 * 이웃 점이 곧 정확한 접선이다. path 는 끝 정점의 핸들이 접선이다 — 핸들이 0이면 이웃 정점을 쓴다.
 * 서브패스가 여럿이면 **첫 서브패스**의 양 끝에만 단다(태스크 46 `pathEndTangents` 가 오면 그 규칙을 따른다).
 */
function pathEnds(node: GeomNode): { start: HeadAnchor; end: HeadAnchor } | null {
  switch (node.kind) {
    case "line":
    case "arrow":
      return {
        start: { fromX: node.x2, fromY: node.y2, toX: node.x1, toY: node.y1 },
        end: { fromX: node.x1, fromY: node.y1, toX: node.x2, toY: node.y2 },
      };
    case "pen":
    case "highlight": {
      const n = node.pts.length;
      if (n < 4) return null;
      return {
        start: { fromX: node.pts[2], fromY: node.pts[3], toX: node.pts[0], toY: node.pts[1] },
        end: {
          fromX: node.pts[n - 4],
          fromY: node.pts[n - 3],
          toX: node.pts[n - 2],
          toY: node.pts[n - 1],
        },
      };
    }
    case "path": {
      const sub = node.subpaths.find((s) => !s.closed && s.verts.length >= 2);
      if (!sub) return null;
      const v = sub.verts;
      const first = v[0];
      const last = v[v.length - 1];
      const prev = v[v.length - 2];
      const next = v[1];
      const hasOut = first.outX !== 0 || first.outY !== 0;
      const hasIn = last.inX !== 0 || last.inY !== 0;
      return {
        start: {
          fromX: hasOut ? first.x + first.outX : next.x,
          fromY: hasOut ? first.y + first.outY : next.y,
          toX: first.x,
          toY: first.y,
        },
        end: {
          fromX: hasIn ? last.x + last.inX : prev.x,
          fromY: hasIn ? last.y + last.inY : prev.y,
          toX: last.x,
          toY: last.y,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * 화살촉 — 길이 4 × strokeWidth, 좌우 π/7 로 벌린 채운 삼각형.
 *
 * render.ts:282 `drawArrowHead` 와 **같은 기하**를 여기 따로 둔다(render.ts 가 paint.ts 를
 * 부르므로 되부르면 순환 import 다). 상수는 둘 다 types.ts `ARROW_HEAD_SCALE` 을 본다 —
 * 틀리면 머리 크기·벌림이 달라져 같은 화살표가 프리뷰와 저장에서 다르게 보인다.
 */
function drawArrowHead(ctx: CanvasRenderingContext2D, h: HeadAnchor, strokeWidth: number): void {
  const len = ARROW_HEAD_SCALE * strokeWidth;
  const dx = h.toX - h.fromX;
  const dy = h.toY - h.fromY;
  if (dx === 0 && dy === 0) return;
  const a = Math.atan2(dy, dx);
  const spread = Math.PI / 7; // 좌우 ≈25.7° → 전체 ≈51°
  ctx.beginPath();
  ctx.moveTo(h.toX, h.toY);
  ctx.lineTo(h.toX - len * Math.cos(a - spread), h.toY - len * Math.sin(a - spread));
  ctx.lineTo(h.toX - len * Math.cos(a + spread), h.toY - len * Math.sin(a + spread));
  ctx.closePath();
  ctx.fill();
}

// ── 색 ───────────────────────────────────────────────────────────────────────

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * 색에 알파를 곱한 캔버스 색 문자열. 문서의 색은 정규화가 hex 로 못 박는다(schema.ts:99).
 *
 * 틀리면: 스톱 불투명도가 통째로 무시돼 반투명 그라디언트가 불투명하게 저장된다.
 */
function withAlpha(color: string, opacity: number): string {
  const a = clamp01(opacity);
  if (a >= 1) return color;
  const rgb = hexToRgb(color);
  if (!rgb) return color; // hex 가 아니면 알파를 못 얹는다 — 색이라도 살린다.
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${(rgb.a * a).toFixed(4)})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number; a: number } | null {
  const h = hex.trim().replace("#", "");
  const full =
    h.length === 3 || h.length === 4
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if ((full.length !== 6 && full.length !== 8) || !/^[0-9a-fA-F]+$/.test(full)) return null;
  const n = Number.parseInt(full.slice(0, 6), 16);
  const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a };
}
