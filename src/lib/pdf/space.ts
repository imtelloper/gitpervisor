// page space ↔ PDF user space 아핀 — 변환의 출처는 `PdfPageInfo.toPage`(pdf.js viewport) 하나다(설계 §5).
// /Rotate·/CropBox·/UserUnit 을 여기서 따로 해석하지 않는다. 역행렬만 쓴다.

import type { Affine } from "./model";

/** a 다음 b 적용 = b∘a. */
export function mul(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error(`invert: singular matrix [${m.join(" ")}]`);
  }
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 점열(평탄 [x0,y0,…])을 m 으로 옮긴 축정렬 외접 상자 [x0,y0,x1,y1]. 점이 없으면 null. */
export function boundsOf(m: Affine, pts: readonly number[]): [number, number, number, number] | null {
  if (pts.length < 2) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const [x, y] = apply(m, pts[i], pts[i + 1]);
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
