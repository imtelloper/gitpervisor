// 크롭·직선화 순수 기하 — 방향 캔버스, 8핸들 리사이즈, 비율, 내접 사각형, 여백 자동 제거.
//
// DOM 을 만지는 것은 `buildOriented`(캔버스 생성)와 `autoTrimRect`(getImageData) 둘뿐이다.
// 나머지는 전부 수 계산이라 세션 훅·인스펙터·포인터가 같은 답을 본다 — 크롭 사각형의 진실이
// 두 벌이 되면 "화면에 보이는 상자"와 "저장되는 영역"이 조용히 어긋난다.
//
// 좌표는 전부 **oriented px**(types.ts 좌표 규약)다. 직선화는 그 oriented 캔버스를 회전 bbox
// 만큼 **키우므로** θ 가 바뀌면 좌표계 자체가 커진다. 그래서 주석은 누적 델타가 아니라 항상
// base 에서 다시 계산한다(`straightenObjects`) — 슬라이더 한 번 왕복에 회전 행렬을 두 번 곱하면
// float 오차가 남아 원래 각도로 돌아와도 주석이 제자리에 없다(00-INDEX §10.4).
//
// 배경: DOCS/task/48-image-crop-straighten.md §3.2·§3.4

import { rotateNodes, translateSubtree } from "./tree";
import type { Node, Rect } from "./types";

/** 비율 프리셋. 객체형은 시안 ⑦ '사용자' 칩의 W:H 두 입력. */
export type CropAspect =
  | "free"
  | "original"
  | "1:1"
  | "3:2"
  | "4:3"
  | "16:9"
  | { w: number; h: number };

/** 구도 보조선 4종 + 없음. 화면 크롬이라 저장 파일에 남지 않는다(43 SVG 가 그린다). */
export type CropOverlay = "none" | "thirds" | "quarters" | "golden" | "diagonal";

/** 크롭 모드 세션 상태 — 적용/취소 전까지 히스토리에 쌓이지 않는 라이브 값(48 §3.1). */
export interface CropSession {
  /** oriented px, 정수, 항상 `cropBounds` 안. */
  rect: Rect;
  aspect: CropAspect;
  overlay: CropOverlay;
  /** deg, −45..45, 0.1 단위 — 라이브 문서의 `straighten` 과 같은 값. */
  straighten: number;
  /** 켜면 크롭이 직선화로 생긴 투명 모서리를 물지 않는다. |straighten|>15 이면 강제 true. */
  constrainToImage: boolean;
  /** 적용 시 크롭과 교차하지 않는 노드를 같은 커밋에서 지운다. */
  deleteOutside: boolean;
}

export const CROP_ASPECTS: readonly { id: CropAspect; label: string }[] = [
  { id: "free", label: "자유" },
  { id: "original", label: "원본" },
  { id: "1:1", label: "1:1" },
  { id: "3:2", label: "3:2" },
  { id: "4:3", label: "4:3" },
  { id: "16:9", label: "16:9" },
  // 세로 비율은 방향 토글이 아니라 '사용자' 칩으로 낸다(시안 ⑦ 에 방향 토글이 없다).
  { id: { w: 2, h: 3 }, label: "사용자" },
];

export const CROP_OVERLAYS: readonly { id: CropOverlay; label: string }[] = [
  { id: "none", label: "없음" },
  { id: "thirds", label: "3분할" },
  { id: "quarters", label: "4분할" },
  { id: "golden", label: "황금비" },
  { id: "diagonal", label: "대각선" },
];

export const MAX_STRAIGHTEN_DEG = 45;
/**
 * 직선화 후 oriented 캔버스가 가질 수 있는 화소 상한(= RGBA 160MB).
 *
 * 45° 회전은 캔버스를 최대 √2² = 2배까지 부풀린다 — 8K 를 그대로 돌리면 oriented 한 장에
 * 265MB 가 잡히고, 슬라이더 틱마다 옛 캔버스가 회수되기 전에 새것이 생겨 두 장이 겹친다.
 * ponytail: 상수 한 곳, 40 §7 실측 뒤 조정.
 */
export const MAX_STRAIGHTEN_PIXELS = 40_000_000;

const DEG = Math.PI / 180;
/** 폭·높이 0 인 크롭은 저장 캔버스를 0×0 으로 만들어 인코딩이 통째로 실패한다. */
const MIN_CROP = 1;

// ── 방향 캔버스 · 직선화 ─────────────────────────────────────────────────────

/**
 * 직선화한 이미지를 담을 캔버스 크기(회전 bbox). `deg=0` 이면 **원본 그대로** 돌려준다 —
 * 올림이 1px 을 더하면 크롭을 안 쓰던 문서의 저장 결과가 달라진다.
 */
export function straightenedSize(
  w: number,
  h: number,
  deg: number,
): { w: number; h: number } {
  if (deg === 0) return { w, h };
  const s = Math.abs(Math.sin(deg * DEG));
  const c = Math.abs(Math.cos(deg * DEG));
  // 1e-9 를 깎고 올린다 — cos(90°) 는 0 이 아니라 6.1e-17 이라 그냥 올리면 정확히 맞아떨어지는
  // 각에서도 캔버스가 1px 커진다(그만큼 주석 좌표 원점이 밀린다).
  const ceilPx = (v: number) => Math.ceil(v - 1e-9);
  return { w: ceilPx(w * c + h * s), h: ceilPx(w * s + h * c) };
}

/**
 * 이 이미지에서 허용되는 직선화 최대각(0.1° 단위 내림).
 *
 * 회전 bbox 넓이는 `sc(w²+h²) + wh` (sc = |sin2θ|/2) 라 |θ| 에 대해 단조 증가한다 —
 * 역함수가 닫혀 있어 탐색 루프가 필요 없다(슬라이더 렌더마다 부른다).
 */
export function maxStraightenFor(natW: number, natH: number): number {
  const area = natW * natH;
  if (area >= MAX_STRAIGHTEN_PIXELS) return 0;
  const t = (2 * (MAX_STRAIGHTEN_PIXELS - area)) / (natW * natW + natH * natH);
  if (!(t < 1)) return MAX_STRAIGHTEN_DEG;
  return Math.min(MAX_STRAIGHTEN_DEG, Math.floor((Math.asin(t) / 2 / DEG) * 10) / 10);
}

/** 화소 상한 안으로 묶은 직선화 각. 캔버스 크기와 좌표 계산이 같은 각을 봐야 한다. */
function clampStraighten(deg: number, natW: number, natH: number): number {
  const lim = maxStraightenFor(natW, natH);
  return Math.max(-lim, Math.min(lim, deg));
}

/**
 * 회전(0/90/180/270) + 반전 + 직선화(임의 각)를 적용한 캔버스를 만든다(필터·크롭 전).
 *
 * 직선화는 **가장 안쪽**에 들어간다. 그래서 프리뷰 백킹·`renderOutput`·90° 델타는 여전히
 * "이 캔버스의 크기와 픽셀"만 보면 되고, `straighten===0` 이면 `rotate` 를 아예 부르지 않아
 * 종전 경로와 비트 동일하다 — `rotate(-0)` 만으로도 CTM 에 −0 이 심어져 저장 바이트가
 * 달라질 수 있다.
 */
export function buildOriented(
  img: HTMLImageElement,
  rotation: number,
  flipH: boolean,
  flipV: boolean,
  straighten: number,
): HTMLCanvasElement {
  const swap = rotation % 180 !== 0;
  const deg = clampStraighten(straighten, img.naturalWidth, img.naturalHeight);
  const size = straightenedSize(
    swap ? img.naturalHeight : img.naturalWidth,
    swap ? img.naturalWidth : img.naturalHeight,
    deg,
  );
  const w = size.w;
  const h = size.h;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  // 반전은 이미지 공간(rotate 이후 scale)으로 적용되므로, 1/4바퀴 회전 시 화면 기준 축이
  // 뒤바뀐다. 사용자가 본 대로(화면 기준) 반전하려면 회전이 90/270°일 때 H↔V를 교환한다.
  const fh = swap ? flipV : flipH;
  const fv = swap ? flipH : flipV;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(fh ? -1 : 1, fv ? -1 : 1);
  if (deg !== 0) ctx.rotate(deg * DEG);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();
  return c;
}

/**
 * 직선화 각이 `fromDeg` → `toDeg` 로 바뀔 때 주석을 이미지와 함께 돌린다.
 *
 * **이미지만 돌고 주석이 제자리에 남으면 강조한 UI 요소와 화살표가 전부 어긋난다.** 캔버스가
 * bbox 만큼 커지므로 회전(옛 중심 기준) 뒤 중심 차만큼 평행이동한다. `fromDeg===toDeg` 면
 * `rotateNodes`·`translateSubtree` 가 입력 배열을 **그대로** 돌려줘 왕복이 참조까지 항등이다.
 *
 * `mirrored`(반전 홀수 개)면 부호가 뒤집힌다 — `buildOriented` 가 `scale(flip)` **뒤에**
 * θ 를 걸어 화면에서 보이는 회전 방향이 반대가 되기 때문이다(ImageEditor `rotateBy` 와 같은 규칙).
 */
export function straightenObjects(
  objects: readonly Node[],
  fromDeg: number,
  toDeg: number,
  size0: { w: number; h: number },
  size1: { w: number; h: number },
  mirrored: boolean,
): Node[] {
  // 최상위만 넘긴다 — tree 함수가 서브트리로 펼치므로 자손을 두 번 돌리지 않는다.
  const tops = objects.filter((o) => o.parentId === null).map((o) => o.id);
  const delta = (mirrored ? -1 : 1) * (toDeg - fromDeg);
  const c0 = { x: size0.w / 2, y: size0.h / 2 };
  const c1 = { x: size1.w / 2, y: size1.h / 2 };
  const rotated = rotateNodes(objects, tops, delta, c0);
  return translateSubtree(rotated, tops, c1.x - c0.x, c1.y - c0.y);
}

// ── 경계 · 비율 ──────────────────────────────────────────────────────────────

/**
 * `deg` 만큼 돌아간 `w×h` 사각형 안에 들어가는 최대 축정렬 사각형(회전 bbox 캔버스 좌표).
 *
 * **폐형식이다 — 반복 탐색을 넣지 마라.** 직선화 슬라이더 드래그 중 매 틱 불린다.
 * `aspect`(= wr/hr)를 주면 그 비율을 지키는 최대 사각형이다.
 */
export function maxInscribedRect(
  w: number,
  h: number,
  deg: number,
  aspect?: number,
): Rect {
  const bb = straightenedSize(w, h, deg);
  const s = Math.abs(Math.sin(deg * DEG));
  const c = Math.abs(Math.cos(deg * DEG));
  let wr: number;
  let hr: number;
  if (aspect !== undefined && aspect > 0) {
    // 반폭 a 의 사각형 네 모서리를 원본 사각형의 두 변 법선에 투영한 조건 둘. 작은 쪽이 답.
    const a = Math.min(w / 2 / (c + s / aspect), h / 2 / (s + c / aspect));
    wr = 2 * a;
    hr = (2 * a) / aspect;
  } else if (s === 0) {
    wr = bb.w;
    hr = bb.h;
  } else {
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    // 45° 부근에서는 아래 일반해의 분모(cos2θ)가 0 으로 가 발산한다 — 그 구간은 위 가지가 맞다.
    if (short <= 2 * s * c * long || Math.abs(s - c) < 1e-10) {
      // 짧은 변이 띠처럼 얇아 긴 변 제약이 걸리지 않는 경우 — 해가 짧은 변 하나로 결정된다.
      const x = short / 2;
      const wLonger = w >= h;
      wr = wLonger ? x / s : x / c;
      hr = wLonger ? x / c : x / s;
    } else {
      const cos2 = c * c - s * s;
      wr = (w * c - h * s) / cos2;
      hr = (h * c - w * s) / cos2;
    }
  }
  return { x: (bb.w - wr) / 2, y: (bb.h - hr) / 2, w: wr, h: hr };
}

/**
 * 크롭 사각형이 움직일 수 있는 범위. 모든 클램프·'원본' 비율·여백 자동 제거가 이 하나를 본다.
 *
 * `constrainToImage` 가 켜져 있고 직선화가 걸려 있으면 **내접 영역**으로 좁힌다 — 그래야
 * 저장 PNG 네 모서리가 α255 다(끄면 투명 모서리가 그대로 저장된다).
 */
export function cropBounds(
  s: Pick<CropSession, "straighten" | "constrainToImage">,
  natW: number,
  natH: number,
  rotation: number,
  oriented: { w: number; h: number },
): Rect {
  const full = { x: 0, y: 0, w: oriented.w, h: oriented.h };
  const deg = clampStraighten(s.straighten, natW, natH);
  if (!s.constrainToImage || deg === 0) return full;
  const swap = rotation % 180 !== 0;
  const r = maxInscribedRect(swap ? natH : natW, swap ? natW : natH, Math.abs(deg));
  // 안쪽으로 반올림한다 — 바깥으로 반올림하면 저장 결과 가장자리에 투명 픽셀이 한 줄 남는다.
  const x = Math.max(0, Math.ceil(r.x));
  const y = Math.max(0, Math.ceil(r.y));
  const w = Math.min(Math.floor(r.x + r.w), oriented.w) - x;
  const h = Math.min(Math.floor(r.y + r.h), oriented.h) - y;
  return w < MIN_CROP || h < MIN_CROP ? full : { x, y, w, h };
}

/** 비율 칩 → wr/hr. `'free'` 와 값이 망가진 사용자 비율은 null(= 비율 고정 없음). */
export function aspectRatioOf(
  a: CropAspect,
  natW: number,
  natH: number,
  rotation: number,
): number | null {
  if (a === "free") return null;
  if (typeof a === "object") return a.w > 0 && a.h > 0 ? a.w / a.h : null;
  if (a === "original") {
    // 회전만 반영한 **원본** 비율이다 — 직선화 bbox 비율을 쓰면 슬라이더를 만질 때마다
    // '원본'의 뜻이 달라져 고정 비율 칩이 고정이 아니게 된다.
    const swap = rotation % 180 !== 0;
    const w = swap ? natH : natW;
    const h = swap ? natW : natH;
    return h > 0 ? w / h : null;
  }
  const [w, h] = a.split(":").map(Number);
  return h > 0 ? w / h : null;
}

/** 정수로 반올림하고 bounds 안으로 밀어 넣는다. 크기를 먼저 굳혀야 위치가 튀지 않는다. */
function clampRect(r: Rect, b: Rect): Rect {
  const w = Math.max(MIN_CROP, Math.min(Math.round(r.w), b.w));
  const h = Math.max(MIN_CROP, Math.min(Math.round(r.h), b.h));
  const x = Math.min(Math.max(Math.round(r.x), b.x), b.x + b.w - w);
  const y = Math.min(Math.max(Math.round(r.y), b.y), b.y + b.h - h);
  return { x, y, w, h };
}

/** 중심을 유지한 채 비율을 맞추고 bounds 안쪽으로 넣는다(비율 칩 전환·여백 자동 제거 뒤). */
export function fitAspect(rect: Rect, aspect: number | null, bounds: Rect): Rect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  let w = rect.w;
  let h = rect.h;
  if (aspect !== null && aspect > 0 && w > 0 && h > 0) {
    if (w / h > aspect) w = h * aspect;
    else h = w / aspect;
    // bounds 를 넘으면 비율을 지킨 채 줄인다 — 한 축만 자르면 방금 고른 비율이 깨진다.
    const k = Math.min(1, bounds.w / w, bounds.h / h);
    w *= k;
    h *= k;
  }
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, bounds);
}

// ── 8핸들 리사이즈 ───────────────────────────────────────────────────────────

/**
 * 크롭 사각형 리사이즈. `handle` 은 `resizeObject`(annotation/draft.ts)와 **같은 인덱스**다:
 * 0..7 = NW·N·NE·E·SE·S·SW·W. 두 규약이 갈라지면 커서와 잡히는 변이 어긋난다.
 *
 * 비율이 걸리면 폭 하나로 사각형 전체가 결정된다(고정점 = 반대 모서리, 변 핸들이면 반대 변 +
 * 반대 축은 중심 대칭). 그래야 bounds 상한을 폭 하나에 모아 한 번에 걸 수 있다 — 축을 따로
 * 자르면 비율이 깨진 채로 클램프된다.
 */
export function resizeCropRect(
  base: Rect,
  handle: number,
  pt: { x: number; y: number },
  o: { aspect: number | null; bounds: Rect; shift: boolean },
): Rect {
  const b = o.bounds;
  // Shift 는 '자유'일 때만 1:1 을 임시로 건다 — 비율이 이미 잡혀 있는데 Shift 가 덮어쓰면
  // 화면의 상자와 비율 칩이 서로 다른 말을 한다.
  const ar = o.aspect ?? (o.shift ? 1 : null);
  const west = handle === 0 || handle === 6 || handle === 7;
  const east = handle === 2 || handle === 3 || handle === 4;
  const north = handle === 0 || handle === 1 || handle === 2;
  const south = handle === 4 || handle === 5 || handle === 6;
  const px = Math.max(b.x, Math.min(pt.x, b.x + b.w));
  const py = Math.max(b.y, Math.min(pt.y, b.y + b.h));

  let x0 = base.x;
  let y0 = base.y;
  let x1 = base.x + base.w;
  let y1 = base.y + base.h;
  if (west) x0 = Math.min(px, x1 - MIN_CROP);
  else if (east) x1 = Math.max(px, x0 + MIN_CROP);
  if (north) y0 = Math.min(py, y1 - MIN_CROP);
  else if (south) y1 = Math.max(py, y0 + MIN_CROP);
  if (ar === null) return clampRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, b);

  const fx = east ? x0 : west ? x1 : base.x + base.w / 2;
  const fy = south ? y0 : north ? y1 : base.y + base.h / 2;
  const want = west || east ? x1 - x0 : (y1 - y0) * ar;
  const maxByX = east
    ? b.x + b.w - fx
    : west
      ? fx - b.x
      : 2 * Math.min(fx - b.x, b.x + b.w - fx);
  const maxByY = south
    ? b.y + b.h - fy
    : north
      ? fy - b.y
      : 2 * Math.min(fy - b.y, b.y + b.h - fy);
  const w = Math.max(MIN_CROP, Math.min(want, maxByX, maxByY * ar));
  const h = w / ar;
  return clampRect(
    {
      x: east ? fx : west ? fx - w : fx - w / 2,
      y: south ? fy : north ? fy - h : fy - h / 2,
      w,
      h,
    },
    b,
  );
}

// ── 여백 자동 제거 ───────────────────────────────────────────────────────────

/**
 * 단색 여백을 픽셀로 찾아 그 안쪽 사각형을 돌려준다. 기준색은 `bounds` 좌상단 픽셀이고,
 * 네 모서리가 기준색 ±`tol`(RGBA 채널별)이 아니면 **아무것도 하지 않는다**(null) — 배경을
 * 잘못 잡고 사진의 절반을 잘라내는 것보다 낫다.
 *
 * 행·열 **스트립**만 읽는다. 4K 한 행은 15KB 지만 전체 `getImageData` 는 33MB 라, 버튼 한 번에
 * 프레임이 통째로 멈춘다.
 */
export function autoTrimRect(
  canvas: HTMLCanvasElement,
  bounds: Rect,
  tol = 8,
): Rect | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const bx = Math.max(0, Math.round(bounds.x));
  const by = Math.max(0, Math.round(bounds.y));
  const bw = Math.min(canvas.width - bx, Math.round(bounds.w));
  const bh = Math.min(canvas.height - by, Math.round(bounds.h));
  if (bw < 1 || bh < 1) return null;

  const ref = ctx.getImageData(bx, by, 1, 1).data;
  const differs = (d: Uint8ClampedArray, i: number): boolean =>
    Math.abs(d[i] - ref[0]) > tol ||
    Math.abs(d[i + 1] - ref[1]) > tol ||
    Math.abs(d[i + 2] - ref[2]) > tol ||
    Math.abs(d[i + 3] - ref[3]) > tol;
  for (const [cx, cy] of [
    [bx + bw - 1, by],
    [bx, by + bh - 1],
    [bx + bw - 1, by + bh - 1],
  ]) {
    if (differs(ctx.getImageData(cx, cy, 1, 1).data, 0)) return null;
  }

  const rowHasContent = (y: number): boolean => {
    const d = ctx.getImageData(bx, y, bw, 1).data;
    for (let i = 0; i < d.length; i += 4) if (differs(d, i)) return true;
    return false;
  };
  let top = by;
  while (top < by + bh && !rowHasContent(top)) top++;
  // 전부 배경색 — 지울 여백이 있는 게 아니라 내용이 없다. 여기서 사각형을 만들면 0×0 이 된다.
  if (top >= by + bh) return null;
  let bottom = by + bh - 1;
  while (bottom > top && !rowHasContent(bottom)) bottom--;

  // 열 스캔은 이미 찾은 행 구간만 읽는다(여백 행을 다시 훑을 이유가 없다).
  const colHasContent = (x: number): boolean => {
    const d = ctx.getImageData(x, top, 1, bottom - top + 1).data;
    for (let i = 0; i < d.length; i += 4) if (differs(d, i)) return true;
    return false;
  };
  let left = bx;
  while (left < bx + bw && !colHasContent(left)) left++;
  let right = bx + bw - 1;
  while (right > left && !colHasContent(right)) right--;

  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

// ── 라벨 ────────────────────────────────────────────────────────────────────

function aspectLabelOf(a: CropAspect): string {
  if (typeof a === "object") return `${a.w}:${a.h}`;
  return CROP_ASPECTS.find((x) => x.id === a)?.label ?? a;
}

/** 배지·상태바 문자열: `2400 × 1600 · 3:2` (+ ` · 직선화 1.4°`). */
export function cropLabel(s: CropSession, o?: { straighten?: boolean }): string {
  const base = `${Math.round(s.rect.w)} × ${Math.round(s.rect.h)} · ${aspectLabelOf(s.aspect)}`;
  return o?.straighten && s.straighten !== 0
    ? `${base} · 직선화 ${s.straighten.toFixed(1)}°`
    : base;
}
