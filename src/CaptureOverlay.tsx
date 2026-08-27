import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

import { ipc, type CaptureRect, type CaptureSession } from "./lib/ipc";

/**
 * 화면 캡쳐 오버레이 — 프리즈 프레임 위에서 영역을 고른다(`DOCS/screen-capture-design.md` M1).
 *
 * 이 창은 **닫히지 않는다.** 한 번 만들어지면 숨었다 나타나기만 한다 — 새로 만들면 내용이 뜰
 * 때까지 실측 1367ms라 100ms 예산이 통째로 무너진다(설계 §3 D4). 그래서 세션이 바뀔 때마다
 * 상태를 갈아끼우는 것이 이 컴포넌트의 생명주기 전부다.
 *
 * 좌표는 **프레임 픽셀 비율**로 환산한다. 화면 배율(DPI)이 모니터마다 다르고 가상 데스크톱
 * 원점이 음수일 수 있는데(이 개발기 실측 `(-2560, 0)`), 비율로 재면 그 둘이 계산에 아예
 * 들어오지 않는다 — `<img>`가 창을 정확히 채우므로 비율 × 프레임 크기 = 버퍼 좌표다.
 */
export function CaptureOverlay() {
  const [sess, setSess] = useState<CaptureSession | null>(null);
  /** 드래그 중인 사각형(뷰포트 CSS px). null이면 아직 안 그었다. */
  const [box, setBox] = useState<Box | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /**
   * 확정에 쓰는 **권위 있는** 사각형. state는 그리기 전용이다.
   *
   * 빠르게 긋고 같은 프레임에 떼면 pointerup 핸들러가 보는 `box` state는 마지막 move가 아직
   * 반영되기 전 값이다 — 그대로 확정하면 사용자가 그은 것보다 작은 영역이 잘린다.
   */
  const boxRef = useRef<Box | null>(null);
  const dragging = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  /** 확정/취소를 두 번 보내지 않기 위한 빗장 — 마우스업과 Enter가 겹칠 수 있다. */
  const done = useRef(false);

  const begin = useCallback((s: CaptureSession | null) => {
    if (!s) return;
    done.current = false;
    dragging.current = false;
    boxRef.current = null;
    setBox(null);
    setCursor(null);
    setSess(s);
  }, []);

  // 세션 수신 경로가 둘이다. 이벤트는 두 번째 캡쳐부터만 도착한다 — 창을 **처음 만든** 순간엔
  // 아직 리스너가 없어 백엔드의 emit이 유실되기 때문. 그래서 마운트 시 한 번 당겨도 온다.
  useEffect(() => {
    void ipc.captureCurrent().then(begin).catch(() => {});
    const un = listen<CaptureSession>("capture://begin", (e) => begin(e.payload));
    return () => void un.then((f) => f());
  }, [begin]);

  const finish = useCallback(
    async (rect: CaptureRect | null) => {
      if (!sess || done.current) return;
      done.current = true;
      try {
        if (rect) await ipc.captureToClipboard(sess.id, rect);
        else await ipc.captureCancel(sess.id);
      } catch {
        // 실패해도 오버레이를 남기지 않는다 — 백엔드가 못 닫았으면 여기서라도 취소를 시도한다.
        await ipc.captureCancel(sess.id).catch(() => {});
      }
      setSess(null);
    },
    [sess],
  );

  // Esc 취소 / Enter 확정. window 리스너를 쓴다 — DOM 포커스가 어디에 있든 창이 OS 포커스를
  // 쥐고 있으면 온다(오버레이는 백그라운드에서 뜨므로 내부 포커스를 가정하면 안 된다).
  useEffect(() => {
    if (!sess) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void finish(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        void finish(toRect(boxRef.current, imgRef.current, sess));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sess, finish]);

  if (!sess) return null;

  const rect = toRect(box, imgRef.current, sess);

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      style={{ cursor: "crosshair" }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; // 우클릭은 아래 onContextMenu가 취소로 받는다
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        boxRef.current = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
        setBox(boxRef.current);
      }}
      onPointerMove={(e) => {
        setCursor({ x: e.clientX, y: e.clientY });
        if (!dragging.current || !boxRef.current) return;
        boxRef.current = { ...boxRef.current, x1: e.clientX, y1: e.clientY };
        setBox(boxRef.current);
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        // ref에서 읽는다(위 boxRef 주석). 잘못 누른 클릭(2px 미만)은 toRect가 null을 돌려
        // 확정이 아니라 취소가 된다 — 1px 이미지를 클립보드에 넣지 않는다.
        void finish(toRect(boxRef.current, imgRef.current, sess));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void finish(null);
      }}
    >
      {/* 프리즈 프레임. 창 크기 = 모니터 물리 크기이므로 창을 정확히 채운다. */}
      <img
        ref={imgRef}
        src={sess.preview}
        alt=""
        draggable={false}
        className="absolute inset-0 h-full w-full"
        // 디코드가 끝난 뒤 한 프레임 더 기다렸다가 "띄워도 된다"고 알린다. onLoad 시점엔 아직
        // 합성 전이라, 여기서 바로 알리면 막으려던 잔상이 그대로 보인다.
        onLoad={() => requestAnimationFrame(() => void ipc.captureOverlayReady(sess.id).catch(() => {}))}
      />

      {box ? (
        <>
          {/* 선택 바깥 딤 — 거대한 box-shadow 한 장으로 구멍을 낸다(레이어 4장보다 싸다). */}
          <div
            className="absolute border border-white/90"
            style={{
              left: Math.min(box.x0, box.x1),
              top: Math.min(box.y0, box.y1),
              width: Math.abs(box.x1 - box.x0),
              height: Math.abs(box.y1 - box.y0),
              boxShadow: "0 0 0 100vmax rgba(0,0,0,0.45)",
            }}
          />
          {rect && <SizeTag box={box} rect={rect} />}
        </>
      ) : (
        <>
          <div className="absolute inset-0 bg-black/35" />
          {cursor && <Crosshair x={cursor.x} y={cursor.y} />}
          <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded bg-black/70 px-3 py-1.5 text-xs text-white">
            드래그해서 영역 선택 · Enter 확정 · Esc/우클릭 취소
          </div>
        </>
      )}
    </div>
  );
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 십자선 — 선택 전 조준 보조. */
function Crosshair({ x, y }: { x: number; y: number }) {
  return (
    <>
      <div className="pointer-events-none absolute left-0 right-0 h-px bg-white/50" style={{ top: y }} />
      <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-white/50" style={{ left: x }} />
    </>
  );
}

/** 선택 크기 표시 — 프레임 픽셀 기준(화면 배율과 무관한 실제 결과물 크기다). */
function SizeTag({ box, rect }: { box: Box; rect: CaptureRect }) {
  const top = Math.min(box.y0, box.y1);
  const left = Math.min(box.x0, box.x1);
  // 위쪽에 자리가 없으면 사각형 안쪽으로 내린다 — 화면 밖으로 나가면 아무 쓸모가 없다.
  const above = top > 26;
  return (
    <div
      className="pointer-events-none absolute rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white"
      style={{ left, top: above ? top - 24 : top + 4 }}
    >
      {rect.w} × {rect.h}
    </div>
  );
}

/**
 * 뷰포트 CSS 사각형 → 프레임 버퍼 픽셀.
 *
 * 비율로 환산하는 이유는 컴포넌트 주석 참고(DPI·음수 원점 회피). 2px 미만은 null을 돌려
 * **오클릭을 확정으로 만들지 않는다**.
 */
function toRect(
  box: Box | null,
  img: HTMLImageElement | null,
  sess: CaptureSession,
): CaptureRect | null {
  if (!box || !img) return null;
  const r = img.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const sx = sess.width / r.width;
  const sy = sess.height / r.height;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const x0 = clamp((Math.min(box.x0, box.x1) - r.left) * sx, sess.width);
  const y0 = clamp((Math.min(box.y0, box.y1) - r.top) * sy, sess.height);
  const x1 = clamp((Math.max(box.x0, box.x1) - r.left) * sx, sess.width);
  const y1 = clamp((Math.max(box.y0, box.y1) - r.top) * sy, sess.height);
  const w = x1 - x0;
  const h = y1 - y0;
  return w >= 2 && h >= 2 ? { x: x0, y: y0, w, h } : null;
}

export default CaptureOverlay;
