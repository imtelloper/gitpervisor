import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { MAX_SCALE, WHEEL_STEP, type View } from "../../lib/zoom";

/** 1% — lib/zoom 의 MIN_SCALE(5%)보다 낮다. 큰 파노라마·스캔은 맞춤 배율부터 5% 아래라, 그 바닥을 쓰면 휠 한 칸에
 *  맞춤보다 크게 튄다(설계 D2 범위 1%~1600%). */
export const PHOTO_MIN_SCALE = 0.01;
export const PHOTO_MAX_SCALE = MAX_SCALE;
/** 버튼·키(+/-) 한 번의 배율. */
const ZOOM_STEP = 1.25;
/** 맞춤 때 그림 둘레 여백(px, 양쪽 합). */
const FIT_PAD = 16;

const clampPhotoScale = (s: number) => Math.min(PHOTO_MAX_SCALE, Math.max(PHOTO_MIN_SCALE, s));

/** (cx, cy) 아래 점을 그 자리에 둔 채 배율만 `scale` 로 — lib/zoom `zoomTo` 와 같은 식이고 바닥(1%)만 다르다.
 *  닮음 변환이라 기준점이 그림 중심(아래 View 규약)이어도 식이 같다. */
function zoomAround(v: View, cx: number, cy: number, scale: number): View {
  const s = clampPhotoScale(scale);
  const k = s / v.scale;
  return { scale: s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}

/** 그림(`left:0 top:0`, 원점 0 0)에 줄 transform — 중심을 (x, y) 에 놓고 돌린 뒤 배율·뒤집기. 뒤집기를 회전 **뒤에**
 *  거는 것은 화면 기준으로 뒤집기 위해서다(돌려 둔 사진의 "좌우 뒤집기"가 위아래로 뒤집히면 안 된다).
 *  글자 인식 상자도 같은 문자열을 받아 줌·회전·뒤집기를 좌표 계산 없이 따라간다. */
export function photoTransform(
  v: View,
  natural: { w: number; h: number },
  rot: number,
  flipX: boolean,
  flipY: boolean,
): string {
  return `translate(${v.x}px, ${v.y}px) scale(${v.scale * (flipX ? -1 : 1)}, ${v.scale * (flipY ? -1 : 1)}) rotate(${rot}deg) translate(${-natural.w / 2}px, ${-natural.h / 2}px)`;
}

/** 맞춤 배율 — 옆으로 돌렸으면(90·270) 가로세로를 바꿔 잰다. 그림은 `max` 1(원본보다 키우지 않는다), 큰 그림을 기다리는
 *  동안의 썸네일(태스크 79)은 큰 그림이 설 자리만큼 키운다. */
export function photoFitScale(
  natural: { w: number; h: number },
  box: { w: number; h: number },
  rot: number,
  max: number,
): number {
  const side = rot % 180 !== 0;
  const w = side ? natural.h : natural.w;
  const h = side ? natural.w : natural.h;
  return clampPhotoScale(Math.min(max, Math.max(1, box.w - FIT_PAD) / w, Math.max(1, box.h - FIT_PAD) / h));
}

export interface PhotoZoom {
  /** x·y = **그림 중심**의 상자 좌표. 그림 크기를 아직 모르면 null(그림을 숨긴다). */
  view: View | null;
  /** 그림 상자 크기(px) — 측정 전엔 0×0. */
  box: { w: number; h: number };
  /** 맞춤 상태 — 창 크기·회전이 바뀌어도 맞춤을 다시 계산한다. */
  fitted: boolean;
  dragging: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomTo: (scale: number) => void;
  fit: () => void;
  /** 그림 상자에 펼친다 — 드래그 이동(확대했을 때)·더블클릭(맞춤 ↔ 100%). */
  bind: {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  };
}

/** 상자 안 단추(이전·다음)에서 시작한 누름은 이동·더블클릭이 아니다 — 포인터를 잡아 버리면 단추 클릭이 상자로 간다. */
const onButton = (e: React.PointerEvent | React.MouseEvent) => e.target instanceof Element && !!e.target.closest("button");

/**
 * 사진 뷰어의 줌·이동(설계 D2). 상태는 "맞춤"(null) 또는 자유 배치 하나다 — 맞춤을 값으로 저장하지 않고 매번
 * 계산하므로 창 크기가 바뀌어도 맞춤이 유지된다. `resetKey`(경로)가 바뀌면 맞춤으로 돌아간다. 휠은 커서 기준
 * 확대·축소(사진 앱 기본 — 이미지 뷰어처럼 Ctrl 을 요구하지 않는다). `onInteract` 는 줌·이동마다 불린다(슬라이드쇼 정지).
 */
export function usePhotoZoom(
  boxRef: RefObject<HTMLDivElement | null>,
  natural: { w: number; h: number } | null,
  rot: number,
  resetKey: string,
  onInteract: () => void,
): PhotoZoom {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [free, setFree] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () =>
      setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxRef]);

  // 장을 넘기면 맞춤으로 — 그리기 전에(layout) 돌려야 새 그림이 옛 배율로 한 프레임 비치지 않는다.
  useLayoutEffect(() => setFree(null), [resetKey]);

  // 원본보다 키우지는 않는다(종전 라이트박스와 같다) — 작은 스크린샷이 흐릿하게 부풀지 않게.
  const fitView = useMemo<View | null>(() => {
    if (!natural || box.w <= 0 || box.h <= 0) return null;
    return { scale: photoFitScale(natural, box, rot, 1), x: box.w / 2, y: box.h / 2 };
  }, [natural, box, rot]);

  const view = natural ? (free ?? fitView) : null;
  /** 리스너·연달아 온 휠이 읽는 최신값 — 렌더를 기다리지 않고 누적돼야 한다. */
  const live = useRef({ fitView, box, onInteract });
  live.current = { fitView, box, onInteract };

  const zoomWith = useCallback((next: (scale: number) => number, at?: { x: number; y: number }) => {
    const { box, onInteract } = live.current;
    onInteract();
    setFree((f) => {
      const v = f ?? live.current.fitView;
      return v ? zoomAround(v, at?.x ?? box.w / 2, at?.y ?? box.h / 2, next(v.scale)) : f;
    });
  }, []);
  const zoomTo = useCallback((scale: number) => zoomWith(() => scale), [zoomWith]);
  const zoomIn = useCallback(() => zoomWith((s) => s * ZOOM_STEP), [zoomWith]);
  const zoomOut = useCallback(() => zoomWith((s) => s / ZOOM_STEP), [zoomWith]);
  const fit = useCallback(() => {
    live.current.onInteract();
    setFree(null);
  }, []);

  // React 의 onWheel 은 passive 라 preventDefault 가 안 먹는다 — 직접 건다.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.pow(WHEEL_STEP, -e.deltaY / 100);
      zoomWith((s) => s * factor, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [boxRef, zoomWith]);

  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const bind: PhotoZoom["bind"] = {
    onPointerDown: (e) => {
      // 맞춤 상태엔 옮길 것이 없다.
      if (e.button !== 0 || free === null || onButton(e)) return;
      live.current.onInteract();
      dragFrom.current = { x: e.clientX, y: e.clientY };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      const from = dragFrom.current;
      if (!from) return;
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      dragFrom.current = { x: e.clientX, y: e.clientY };
      setFree((f) => (f ? { ...f, x: f.x + dx, y: f.y + dy } : f));
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: (e) => {
      if (onButton(e)) return;
      if (free !== null) {
        fit();
        return;
      }
      // 맞춤 → 100%: 누른 자리를 기준으로 키운다(사진 앱과 같다).
      const r = e.currentTarget.getBoundingClientRect();
      zoomWith(() => 1, { x: e.clientX - r.left, y: e.clientY - r.top });
    },
  };

  return { view, box, fitted: free === null, dragging, zoomIn, zoomOut, zoomTo, fit, bind };
}
