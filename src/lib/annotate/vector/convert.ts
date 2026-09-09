// 도형 → 패스 변환 · 패스 프리셋 · 벡터 연산 게이트 (태스크 46 §3.4).
//
// **순수 모듈**이다 — 캔버스도 DOM 도 만지지 않는다. 불리언·평탄화·윤곽선화가 전부 여기를
// 지나므로 kind 한 줄을 빠뜨리면 그 도형만 조용히 연산에서 빠진다(객체가 사라지거나 결과가
// 빈 패스로 나온다). `toPathObject` 의 switch 에 default 를 두지 않는 것은 의도다 —
// `GeomNode` 에 kind 가 늘면 컴파일이 막힌다(37 §3.1 과 같은 장치).
//
// text·mosaic·frame 이 `null` 인 것은 "아직 안 만들었다"가 아니라 **정답**이다. 글리프는 50
// `outlineText` 가, 가림은 벡터가 아니라 픽셀 연산이, 프레임은 기하가 아니라 컨테이너다 —
// 여기서 사각형으로 근사해 돌려주면 "모자이크를 합집합했더니 사각형만 남았다"가 된다.

import { readableOn } from "../../color";
import {
  BADGE_RADIUS_SCALE,
  DEFAULT_TEXT_STYLE,
  newObjId,
  type BadgeObject,
  type GeomNode,
  type Node,
  type NodeBase,
  type ObjId,
  type PathNode,
  type PathVert,
  type Rect,
  type TextNode,
} from "../types";
import { fitPolyline } from "./fit";
import type { SubPath } from "./path";

/**
 * 90° 원호의 3차 베지어 근사 계수 4/3·(√2−1). `arcTo`/`ellipse` 와의 편차는 반지름의 0.03%라
 * 저장 픽셀에서 구분되지 않는다(§3.4 표) — 값을 어림수로 줄이면 그 단언이 깨진다.
 */
const KAPPA = 0.5522847498307933;

/** 펜 피팅 파라미터 — 46 §3.4. 두 값을 바꾸면 평탄화 결과의 정점 수가 통째로 달라진다. */
const FIT_MAX_ERR = 0.5;
const FIT_CORNER_DEG = 30;

/** 정다각형 판정·프리셋의 변 수 상한. 인스펙터 `변 수` 필드가 이 범위 밖을 만들면 안 된다. */
const POLY_MIN = 3;
const POLY_MAX = 12;

function corner(x: number, y: number): PathVert {
  return { x, y, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" };
}

/**
 * NodeBase 전 필드 복사. 배열·객체는 **참조를 공유**한다 — 문서 노드는 불변이라(types.ts 규약)
 * 공유가 안전하고, 깊은 복사는 평탄화 한 번에 fills/effects 를 통째로 다시 만든다.
 */
function baseOf(n: Node): NodeBase {
  return {
    id: n.id,
    parentId: n.parentId,
    name: n.name,
    visible: n.visible,
    locked: n.locked,
    opacity: n.opacity,
    blend: n.blend,
    rot: n.rot,
    fills: n.fills.slice(),
    strokes: n.strokes.slice(),
    strokeWidth: n.strokeWidth,
    strokeAlign: n.strokeAlign,
    dash: n.dash ? n.dash.slice() : null,
    cap: n.cap,
    join: n.join,
    miterLimit: n.miterLimit,
    heads: { ...n.heads },
    effects: n.effects.slice(),
    constraints: { ...n.constraints },
    mask: n.mask ? { ...n.mask } : null,
    exportRows: n.exportRows.slice(),
    styleRefs: { ...n.styleRefs },
  };
}

/**
 * `src` 의 스타일을 그대로 입은 PathNode. 불리언·평탄화·윤곽선화가 공유하는 유일한 생성자다
 * (§4 계약 밖의 내부 공유 — 세 모듈이 같은 규칙으로 스타일을 옮기게 묶어 둔다).
 *
 * `fillRule` 기본값은 §3.4 대로 nonzero 지만, 원본이 이미 패스면 그 값을 지킨다 — 짝수-홀수로
 * 그리던 패스를 평탄화했더니 구멍이 메워지는 일을 막는다.
 */
export function pathFrom(
  src: Node,
  subpaths: SubPath[],
  id: ObjId = src.id,
  fillRule: PathNode["fillRule"] = src.kind === "path" ? src.fillRule : "nonzero",
): PathNode {
  return { ...baseOf(src), id, kind: "path", subpaths, fillRule };
}

// ── 도형 → 패스 ──────────────────────────────────────────────────────────────

/**
 * §3.4 표 그대로. **표의 한 행이라도 빠지면 그 도형이 벡터 연산에서 사라진다.**
 *
 * `path` 는 원본 참조를 그대로 돌려준다 — 불리언 미리보기가 선택마다 이 함수를 도므로
 * 이미 패스인 것을 복제할 이유가 없다(호출자는 결과를 변형하지 않는다).
 */
export function toPathObject(node: GeomNode): PathNode | null {
  switch (node.kind) {
    case "pen":
    case "highlight": {
      // 점 하나(길이 2)는 패스가 아니다 — 렌더가 round cap 으로 점을 찍을 뿐이라
      // 정점 1개짜리 열린 서브패스를 만들면 불리언에서 빈 링이 된다.
      if (node.pts.length < 4) return null;
      const verts = fitPolyline(node.pts, { maxErr: FIT_MAX_ERR, cornerDeg: FIT_CORNER_DEG });
      return pathFrom(node, [{ verts, closed: false }]);
    }
    case "line":
    case "arrow":
      return pathFrom(node, [
        { verts: [corner(node.x1, node.y1), corner(node.x2, node.y2)], closed: false },
      ]);
    case "rect":
      return pathFrom(node, [roundRectSubPath(node, node.radius)]);
    case "ellipse":
      return pathFrom(node, [
        ellipseSubPath(
          node.x + node.w / 2,
          node.y + node.h / 2,
          Math.abs(node.w) / 2,
          Math.abs(node.h) / 2,
        ),
      ]);
    case "badge": {
      const r = BADGE_RADIUS_SCALE * node.fontSize;
      return pathFrom(node, [ellipseSubPath(node.x, node.y, r, r)]);
    }
    case "path":
      return node;
    case "text":
    case "mosaic":
    case "frame":
      return null;
  }
}

/**
 * 뱃지의 숫자를 텍스트 노드로 분리한다 — 원은 `toPathObject` 가, 글자는 여기가 맡는다.
 * 평탄화·패스로는 둘을 함께 넣고 불리언은 원만 쓴다(§3.4·§6 "뱃지 불리언에서 숫자 소실").
 *
 * 글자색은 사용자가 고르는 값이 아니라 원 색의 대비다 — render.ts drawBadge 와 **같은 판정**을
 * 써야 평탄화 전후로 숫자 색이 바뀌지 않는다.
 *
 * 상자는 원의 지름으로 잡고 정렬을 가운데로 둔다. 텍스트 레이아웃(align/valign 해석)은 49 몫이라
 * 그 전까지는 좌상단 근사로 그려진다 — 한 자리 숫자에서 육안 차이가 없는 자리다.
 */
export function badgeLabelNode(badge: BadgeObject): TextNode {
  const r = BADGE_RADIUS_SCALE * badge.fontSize;
  const solid = badge.fills.find((f) => f.visible && f.type === "solid");
  const h = badge.fontSize * (DEFAULT_TEXT_STYLE.lineHeight / 100);
  return {
    ...baseOf(badge),
    ...DEFAULT_TEXT_STYLE,
    // 새 id 다 — 평탄화가 뱃지 id 를 패스 쪽에 물려주므로(§3.6 "선택 1개 = 패스로") 여기서
    // 같은 id 를 쓰면 문서에 중복 id 두 개가 들어가 트리 불변식이 깨진다.
    id: newObjId(),
    kind: "text",
    x: badge.x - r,
    y: badge.y - h / 2,
    w: r * 2,
    h,
    text: String(badge.n),
    fontSize: badge.fontSize,
    fontWeight: 700,
    align: "center",
    valign: "middle",
    resize: "fixed",
    fills: [
      {
        type: "solid",
        color: readableOn(solid && solid.type === "solid" ? solid.color : "#FFFFFF"),
        opacity: 1,
        visible: true,
        blend: "normal",
      },
    ],
    strokes: [],
    strokeWidth: 0,
    heads: { start: "none", end: "none" },
    // 글자색은 원 색에서 파생한 값이라 라이브러리 스타일과 무관하고, 마스크는 원이 맡는다.
    styleRefs: {},
    mask: null,
  };
}

// ── 프리셋 ───────────────────────────────────────────────────────────────────

/**
 * AABB 에 내접하는 N각형. 첫 정점은 −90°(위) — 삼각형이 위를 보게 하는 관례다.
 *
 * `n` 은 3–12 로 조인다. 인스펙터 `변 수` 가 `isRegularPolygon` 의 판정 범위와 같은 값을
 * 보여야 하기 때문이다 — 20각형을 만들면 그 필드가 사라져 되돌릴 방법이 없어진다.
 */
export function polygonSubPath(rect: Rect, n: number): SubPath {
  const sides = Math.max(POLY_MIN, Math.min(POLY_MAX, Math.round(n)));
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const rx = rect.w / 2;
  const ry = rect.h / 2;
  const verts: PathVert[] = [];
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    verts.push(corner(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
  }
  return { verts, closed: true };
}

/**
 * 말풍선 — 모서리 반경 사각형 + 아래변 왼쪽 25% 지점의 꼬리 3정점(§3.4).
 * 꼬리 위치·길이 조정은 47 노드 편집이 맡는다(여기서 상태 필드를 늘리지 않는다).
 */
export function calloutSubPath(
  rect: Rect,
  radius: readonly [number, number, number, number],
): SubPath {
  const sub = roundRectSubPath(rect, radius);
  const lim = Math.min(Math.abs(rect.w), Math.abs(rect.h)) / 2;
  const bl = clampRadius(radius[3], lim);
  const br = clampRadius(radius[2], lim);
  // 꼬리 밑변은 아래변의 곧은 구간(모서리 반경 사이)을 넘지 못한다 — 넘으면 원호를 파고들어
  // 자기교차하는 링이 되고, 그대로 불리언에 들어가면 결과가 조용히 뒤집힌다.
  const span = Math.max(0, rect.w - bl - br);
  const base = Math.min(rect.w / 4, 24, span);
  const len = Math.min(rect.h / 2, 24);
  const cx = Math.min(
    Math.max(rect.x + rect.w * 0.25, rect.x + bl + base / 2),
    rect.x + rect.w - br - base / 2,
  );
  const y = rect.y + rect.h;
  if (base <= 0 || len <= 0) return sub;
  // 아래변은 오른쪽→왼쪽으로 지난다. 꼬리도 같은 방향으로 넣어야 링 방향이 유지된다.
  const tail = [corner(cx + base / 2, y), corner(cx, y + len), corner(cx - base / 2, y)];
  const at = bottomEdgeIndex(sub.verts, y);
  const verts = sub.verts.slice();
  verts.splice(at, 0, ...tail);
  return { verts, closed: true };
}

/** 아래변을 오른쪽에서 왼쪽으로 지나는 구간의 삽입 지점(= 오른쪽 끝 정점 다음). */
function bottomEdgeIndex(verts: readonly PathVert[], y: number): number {
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    if (Math.abs(a.y - y) < 1e-6 && Math.abs(b.y - y) < 1e-6 && b.x < a.x) return i + 1;
  }
  return verts.length;
}

/**
 * 정다각형이면 변 수, 아니면 null. 인스펙터 `모양 › 변 수` 노출 조건이다(§3.4).
 *
 * 변 길이와 무게중심까지의 거리가 모두 같으면 정다각형이다 — 내각을 따로 재지 않는다.
 * 허용오차 0.5px 는 드래그로 만든 프리셋이 리사이즈를 몇 번 거쳐도 살아남는 폭이다.
 */
export function isRegularPolygon(node: PathNode): number | null {
  if (node.subpaths.length !== 1) return null;
  const sp = node.subpaths[0];
  if (!sp.closed) return null;
  const v = sp.verts;
  const n = v.length;
  if (n < POLY_MIN || n > POLY_MAX) return null;
  for (const p of v) {
    if (p.inX !== 0 || p.inY !== 0 || p.outX !== 0 || p.outY !== 0) return null;
    if (p.mode !== "corner") return null;
  }
  let cx = 0;
  let cy = 0;
  for (const p of v) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const side0 = Math.hypot(v[1].x - v[0].x, v[1].y - v[0].y);
  const rad0 = Math.hypot(v[0].x - cx, v[0].y - cy);
  for (let i = 0; i < n; i++) {
    const a = v[i];
    const b = v[(i + 1) % n];
    if (Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - side0) > 0.5) return null;
    if (Math.abs(Math.hypot(a.x - cx, a.y - cy) - rad0) > 0.5) return null;
  }
  return n;
}

// ── 게이트 (45 classifySelection · 42 when 이 부른다) ────────────────────────

/** 패스로 바꿀 수 있는 리프인가. 이 목록이 곧 불리언·평탄화의 입력 자격이다. */
function isConvertible(n: Node): boolean {
  switch (n.kind) {
    case "pen":
    case "highlight":
    case "line":
    case "arrow":
    case "rect":
    case "ellipse":
    case "badge":
    case "path":
      return true;
    default:
      return false;
  }
}

/** 2개 이상이고 전부 변환 가능한 리프. 텍스트·모자이크·컨테이너가 섞이면 거짓(§3.5). */
export function canBoolean(nodes: readonly Node[]): boolean {
  return nodes.length >= 2 && nodes.every(isConvertible);
}

/**
 * 평탄화 가능한 선택인가. 컨테이너는 호출자가 38 `subtreeRange` 로 리프까지 펼치므로 허용한다.
 *
 * 텍스트·모자이크가 섞이면 **거짓**이다 — `toPathObject` 가 null 을 주므로 그대로 진행하면
 * 그 객체만 말없이 사라진다. 텍스트 윤곽선화는 50 이 별도 액션으로 붙인다.
 */
export function canFlatten(nodes: readonly Node[]): boolean {
  if (nodes.length === 0) return false;
  return nodes.every(
    (n) => isConvertible(n) || n.kind === "group" || n.kind === "frame" || n.kind === "instance",
  );
}

/** 윤곽선화 가능한가 — 보이는 선이 있고 두께가 0 보다 큰 변환 가능 도형(§3.7). */
export function canOutline(node: Node): boolean {
  if (node.kind === "badge" || !isConvertible(node)) return false;
  return node.strokeWidth > 0 && node.strokes.some((s) => s.visible);
}

// ── 서브패스 빌더 ────────────────────────────────────────────────────────────

function clampRadius(r: number, lim: number): number {
  return Math.max(0, Math.min(r, lim));
}

/**
 * κ 핸들 4정점 타원. 축 4점을 지나고 대각선에서 원본 `ctx.ellipse` 와 ±1px 안에 든다.
 * 정점 순서는 캔버스 기본 방향(0° → 시계방향, y-down)과 같다.
 */
function ellipseSubPath(cx: number, cy: number, rx: number, ry: number): SubPath {
  const hx = KAPPA * rx;
  const hy = KAPPA * ry;
  return {
    verts: [
      { x: cx + rx, y: cy, inX: 0, inY: -hy, outX: 0, outY: hy, mode: "mirrored" },
      { x: cx, y: cy + ry, inX: hx, inY: 0, outX: -hx, outY: 0, mode: "mirrored" },
      { x: cx - rx, y: cy, inX: 0, inY: hy, outX: 0, outY: -hy, mode: "mirrored" },
      { x: cx, y: cy - ry, inX: -hx, inY: 0, outX: hx, outY: 0, mode: "mirrored" },
    ],
    closed: true,
  };
}

/**
 * 모서리 반경 사각형. geometry.ts `roundRectPath` 와 **같은 순회**(좌상단에서 시계방향)라
 * 변환 전후로 대시 위상·화살촉 접선이 어긋나지 않는다. 반경 0 인 모서리는 정점 1개로 접힌다
 * — 그래서 반경이 전부 0 이면 4정점, 전부 양수면 8정점이다(§3.4).
 */
function roundRectSubPath(rect: Rect, radius: readonly [number, number, number, number]): SubPath {
  const { x, y, w, h } = rect;
  const lim = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const tl = clampRadius(radius[0], lim);
  const tr = clampRadius(radius[1], lim);
  const br = clampRadius(radius[2], lim);
  const bl = clampRadius(radius[3], lim);
  const verts: PathVert[] = [];
  pushArc(verts, x, y + tl, 0, -KAPPA * tl, x + tl, y, -KAPPA * tl, 0, tl);
  pushArc(verts, x + w - tr, y, KAPPA * tr, 0, x + w, y + tr, 0, -KAPPA * tr, tr);
  pushArc(verts, x + w, y + h - br, 0, KAPPA * br, x + w - br, y + h, KAPPA * br, 0, br);
  pushArc(verts, x + bl, y + h, -KAPPA * bl, 0, x, y + h - bl, 0, KAPPA * bl, bl);
  return { verts, closed: true };
}

/** 모서리 원호 하나 — 반경이 0 이면 두 끝점이 같으므로 코너 정점 하나로 접는다. */
function pushArc(
  out: PathVert[],
  ax: number,
  ay: number,
  aoX: number,
  aoY: number,
  bx: number,
  by: number,
  biX: number,
  biY: number,
  r: number,
): void {
  if (r <= 0) {
    out.push(corner(bx, by));
    return;
  }
  out.push({ x: ax, y: ay, inX: 0, inY: 0, outX: aoX, outY: aoY, mode: "corner" });
  out.push({ x: bx, y: by, inX: biX, inY: biY, outX: 0, outY: 0, mode: "corner" });
}
