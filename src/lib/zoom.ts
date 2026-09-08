// 컨테이너 안에서 무언가를 확대·이동하는 뷰 상태 — 이미지 뷰어와 이미지 편집기가 공유한다.
//
// 원래 diff/ImageView 안에만 있던 것을 편집기가 같은 동작을 필요로 해 뽑았다. 두 벌로 두면
// "뷰어에서는 최대 배율에서 이미지가 안 밀리는데 편집기에서는 밀린다" 류로 갈라진다.

/** 배율 한계와 휠 스텝. 지수 스텝이라 어느 배율에서든 한 노치의 체감이 균일하다. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;
export const WHEEL_STEP = 1.1;

export const clampScale = (s: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** 컨테이너 좌표 기준 배치 — transform-origin은 좌상단(0,0) 고정이 전제다(zoomAt 참고). */
export interface View {
  scale: number;
  x: number;
  y: number;
}

/** 확대·이동 없음. "맞춤" 상태가 곧 항등이 되도록 컨테이너를 잡는 쪽이 리셋이 쉽다. */
export const IDENTITY_VIEW: View = { scale: 1, x: 0, y: 0 };

/**
 * 컨테이너 좌표 (cx, cy) 아래의 점을 **그 자리에 둔 채** 배율만 factor배 한다.
 *
 *   o' = c - (c - o) * (s' / s)
 *
 * transform-origin이 0 0이라 이 한 줄로 끝난다(center면 컨테이너 크기가 식에 끼어든다).
 */
export function zoomAt(v: View, cx: number, cy: number, factor: number): View {
  const scale = clampScale(v.scale * factor);
  // 한계에 걸리면 요청한 factor와 실제 비율이 달라진다 — 실제 비율로 오프셋을 옮겨야
  // 최대/최소 배율에서 이미지가 슬금슬금 밀리지 않는다.
  const k = scale / v.scale;
  return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}

/**
 * 배율을 **지정한 값으로** 맞춘다 — (cx, cy) 아래의 점은 그 자리에 남는다.
 *
 * 줌 드롭다운의 `100% · 200%` 처럼 목표 배율이 정해진 경로가 쓴다. 호출부가
 * `target / v.scale` 을 직접 계산해 `zoomAt` 에 넘기면 그 나눗셈이 화면마다 흩어지고,
 * 한 곳이라도 클램프 이후의 실제 배율이 아니라 요청 배율로 나누면 연속 호출에서
 * 배율이 조금씩 어긋난다.
 */
export function zoomTo(v: View, cx: number, cy: number, targetScale: number): View {
  return zoomAt(v, cx, cy, targetScale / v.scale);
}
