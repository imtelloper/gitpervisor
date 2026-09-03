// 영역 선택 오버레이 (설계 ⑥) — 영상 위 드래그 사각형. div 기반(캔버스 불필요).
//
// 좌표는 **회전 반영 표시 기준 video px**(probe.width/height와 동일 좌표계)로 저장한다 —
// 백엔드 crop 필터가 autorotate된 프레임에 적용되므로 그대로 일치한다(video.rs VideoMeta).
// 짝수 내림은 백엔드도 하지만(yuv420p) 표시 수치가 실제와 같도록 커밋 시점에 여기서도 한다.
//
// 부모는 <video>를 감싸는 shrink-wrap(inline-flex) 컨테이너다 — 오버레이 inset-0이 곧
// 표시된 영상 영역과 1:1이라 레터박스 보정이 필요 없다.
import { Fragment, useRef, useState } from "react";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_PX = 16; // video px 기준 최소 크기

type DragMode =
  | { kind: "create"; ax: number; ay: number }
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; handle: string; base: CropRect };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const even = (v: number) => Math.max(0, Math.floor(v)) & ~1;

export function CropOverlay({
  videoW,
  videoH,
  crop,
  onChange,
  hint = "드래그해서 추출할 영역을 지정하세요 (Esc 취소)",
}: {
  videoW: number;
  videoH: number;
  crop: CropRect | null;
  onChange: (c: CropRect | null) => void;
  /** 사각형이 없을 때 뜨는 안내 — 크롭/모자이크가 같은 오버레이를 쓴다. */
  hint?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 드래그 중 라이브 사각형(video px, 소수 허용) — 커밋 시 짝수 정수화.
  //
  // ref를 함께 두는 이유: 커밋(onChange)은 **부수효과**라 setState 업데이터 안에서 실행하면
  // 안 된다. StrictMode는 업데이터를 두 번 호출하므로 onChange도 두 번 불렸다. crop은
  // setCrop(c)라 멱등이어서 티가 안 났지만, 가림 영역처럼 배열에 append하는 소비자에서는
  // 드래그 한 번에 사각형이 **두 개** 생겼다(2026-09-03 실측).
  const [live, setLive] = useState<CropRect | null>(null);
  const liveRef = useRef<CropRect | null>(null);
  const setLiveBoth = (v: CropRect | null) => {
    liveRef.current = v;
    setLive(v);
  };
  const shown = live ?? crop;

  /** 클라이언트 좌표 → video px. */
  const toVideo = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0 };
    return {
      x: clamp(((clientX - r.left) / r.width) * videoW, 0, videoW),
      y: clamp(((clientY - r.top) / r.height) * videoH, 0, videoH),
    };
  };

  const normalize = (r: CropRect): CropRect => ({
    x: clamp(r.x, 0, videoW - MIN_PX),
    y: clamp(r.y, 0, videoH - MIN_PX),
    w: clamp(r.w, MIN_PX, videoW - clamp(r.x, 0, videoW - MIN_PX)),
    h: clamp(r.h, MIN_PX, videoH - clamp(r.y, 0, videoH - MIN_PX)),
  });

  /** 포인터 위치 → 다음 사각형. 순수 함수 — setState 업데이터 밖에서 계산한다. */
  const nextRect = (mode: DragMode, p: { x: number; y: number }): CropRect | null => {
    switch (mode.kind) {
      case "create": {
        const x = Math.min(mode.ax, p.x);
        const y = Math.min(mode.ay, p.y);
        return normalize({ x, y, w: Math.abs(p.x - mode.ax), h: Math.abs(p.y - mode.ay) });
      }
      case "move": {
        const base = crop;
        if (!base) return null;
        return {
          x: clamp(p.x - mode.dx, 0, videoW - base.w),
          y: clamp(p.y - mode.dy, 0, videoH - base.h),
          w: base.w,
          h: base.h,
        };
      }
      case "resize": {
        const b = mode.base;
        let { x, y } = b;
        let r = b.x + b.w;
        let btm = b.y + b.h;
        if (mode.handle.includes("w")) x = clamp(p.x, 0, r - MIN_PX);
        if (mode.handle.includes("e")) r = clamp(p.x, x + MIN_PX, videoW);
        if (mode.handle.includes("n")) y = clamp(p.y, 0, btm - MIN_PX);
        if (mode.handle.includes("s")) btm = clamp(p.y, y + MIN_PX, videoH);
        return { x, y, w: r - x, h: btm - y };
      }
    }
  };

  const startDrag = (mode: DragMode) => {
    const move = (ev: PointerEvent) => {
      setLiveBoth(nextRect(mode, toVideo(ev.clientX, ev.clientY)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const cur = liveRef.current;
      setLiveBoth(null);
      if (cur) {
        // 커밋 — 짝수 정수화(yuv420p) 후 부모로. 업데이터 밖이라 정확히 한 번 실행된다.
        const c = { x: even(cur.x), y: even(cur.y), w: even(cur.w), h: even(cur.h) };
        if (c.w >= MIN_PX && c.h >= MIN_PX) onChange(c);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pctStyle = (r: CropRect) => ({
    left: `${(r.x / videoW) * 100}%`,
    top: `${(r.y / videoH) * 100}%`,
    width: `${(r.w / videoW) * 100}%`,
    height: `${(r.h / videoH) * 100}%`,
  });

  const HANDLES: Array<{ id: string; cls: string }> = [
    { id: "nw", cls: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize" },
    { id: "n", cls: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize" },
    { id: "ne", cls: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize" },
    { id: "e", cls: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
    { id: "se", cls: "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize" },
    { id: "s", cls: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize" },
    { id: "sw", cls: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize" },
    { id: "w", cls: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
  ];

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(e) => {
        // 빈 영역(또는 기존 사각형 바깥) 드래그 → 새 사각형.
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        const p = toVideo(e.clientX, e.clientY);
        startDrag({ kind: "create", ax: p.x, ay: p.y });
      }}
    >
      {!shown && (
        <div className="pointer-events-none absolute inset-x-0 top-2 text-center text-[11px] text-fg-dim">
          {hint}
        </div>
      )}
      {shown && (
        <div
          className="absolute border border-accent"
          style={{
            ...pctStyle(shown),
            // 사각형 밖 전체를 어둡게 — dim div 4장 대신 box-shadow 한 방.
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            e.stopPropagation();
            const p = toVideo(e.clientX, e.clientY);
            startDrag({ kind: "move", dx: p.x - shown.x, dy: p.y - shown.y });
          }}
        >
          {/* 3분할 가이드 — 사각형 **안쪽**에만 그린다. 구도를 잡는 기준선이라 프레임 전체가
              아니라 잘려 나갈 영역 기준이어야 의미가 있다. */}
          <div className="pointer-events-none absolute inset-0">
            {[1, 2].map((i) => (
              <Fragment key={i}>
                <div className="absolute inset-y-0 w-px bg-fg/25" style={{ left: `${(i * 100) / 3}%` }} />
                <div className="absolute inset-x-0 h-px bg-fg/25" style={{ top: `${(i * 100) / 3}%` }} />
              </Fragment>
            ))}
          </div>
          <div className="pointer-events-none absolute -top-5 left-0 whitespace-nowrap rounded bg-panel px-1 text-[11px] text-fg-muted">
            {even(shown.w)}×{even(shown.h)} @ {even(shown.x)},{even(shown.y)}
          </div>
          {HANDLES.map((h) => (
            <div
              key={h.id}
              className={`absolute z-10 h-2.5 w-2.5 rounded-full border border-accent bg-panel ${h.cls}`}
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                startDrag({ kind: "resize", handle: h.id, base: crop ?? shown });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
