import { listen } from "@tauri-apps/api/event";
import { Mic, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMessages } from "./i18n/ui-language";
import { formatBytes } from "./lib/format";
import {
  ipc,
  type CaptureRect,
  type CaptureSession,
  type RecordProgress,
  type RecordStarted,
} from "./lib/ipc";

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
 *
 * 녹화 모드(`sess.mode === "record"`)에선 확정이 녹화 시작이고, 그 뒤 **이 창이 녹화 컨트롤 바가 된다**
 * (Rust 가 창을 줄여 영역 옆으로 옮긴다 — commands/record.rs). 새 창을 만들면 뜰 때까지 1초 넘게 걸린다.
 */
export function CaptureOverlay() {
  const msg = useMessages();
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
  /**
   * 녹화 중이면 컨트롤 바를 그린다 — "pending" 은 record_start 응답 전.
   * 정지 결과(record://saved·failed)나 카운트다운 취소(record://cancelled)가 오면 null.
   */
  const [rec, setRec] = useState<RecordStarted | "pending" | null>(null);

  const begin = useCallback((s: CaptureSession | null) => {
    if (!s) return;
    done.current = false;
    dragging.current = false;
    boxRef.current = null;
    setBox(null);
    setCursor(null);
    setRec(null); // 정지 이벤트를 놓쳤어도 새 선택은 깨끗하게 시작한다
    setSess(s);
  }, []);

  // 세션 수신 경로가 둘이다. 이벤트는 두 번째 캡쳐부터만 도착한다 — 창을 **처음 만든** 순간엔
  // 아직 리스너가 없어 백엔드의 emit이 유실되기 때문. 그래서 마운트 시 한 번 당겨도 온다.
  useEffect(() => {
    void ipc.captureCurrent().then(begin).catch(() => {});
    const un = listen<CaptureSession>("capture://begin", (e) => begin(e.payload));
    return () => void un.then((f) => f());
  }, [begin]);

  useEffect(() => {
    const saved = listen("record://saved", () => setRec(null));
    const failed = listen("record://failed", () => setRec(null));
    const cancelled = listen("record://cancelled", () => setRec(null));
    return () => {
      for (const un of [saved, failed, cancelled]) void un.then((f) => f());
    };
  }, []);

  const finish = useCallback(
    async (rect: CaptureRect | null) => {
      if (!sess || done.current) return;
      done.current = true;
      if (rect && sess.mode === "record") {
        // 바를 먼저 그린다 — Rust 가 창을 줄이는 순간 프리즈 프레임 조각이 비치지 않게.
        setRec("pending");
        setSess(null);
        try {
          setRec(await ipc.recordStart(sess.id, rect));
        } catch {
          // 실패는 Rust 가 오버레이를 닫고 record://failed 로 메인 창에 알린다(이 창엔 토스트가 없다).
          setRec(null);
        }
        return;
      }
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

  if (rec) return <RecordBar rec={rec === "pending" ? null : rec} />;
  if (!sess) return null;

  const rect = toRect(box, imgRef.current, sess);
  const recording = sess.mode === "record";

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
            className={`absolute border ${recording ? "border-red-500" : "border-white/90"}`}
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
            {recording ? msg.windows.captureOverlay.recordHint : msg.windows.captureOverlay.hint}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 녹화 컨트롤 바 — 창 전체가 이 바다(크기는 commands/record.rs `BAR_CSS`, 380×44 CSS px). 화면 녹화에서 빠지는 창이라
 * 결과물엔 안 찍힌다. `rec` 이 null 이면 record_start 응답 전이다.
 */
function RecordBar({ rec }: { rec: RecordStarted | null }) {
  const t = useMessages().windows.captureOverlay;
  const [prog, setProg] = useState<RecordProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [stopping, setStopping] = useState(false);
  // 카운트다운은 응답을 받은 순간부터 센다(응답이 "지금부터 N초"다). 어긋나도 첫 record://progress 가 오면
  // 녹화 화면으로 넘어간다 — 그 이벤트는 실제로 녹화가 돌 때만 온다.
  const t0 = useRef<number | null>(null);
  if (rec && t0.current === null) t0.current = performance.now();
  const [now, setNow] = useState(() => performance.now());
  const left = rec ? rec.countdownSecs - Math.floor(Math.max(0, now - (t0.current ?? now)) / 1000) : 0;
  const counting = !rec || (!prog && left > 0);

  useEffect(() => {
    const progress = listen<RecordProgress>("record://progress", (e) => {
      setProg(e.payload);
      setPaused(e.payload.paused);
    });
    const pausedEv = listen<{ paused: boolean }>("record://paused", (e) => setPaused(e.payload.paused));
    return () => {
      for (const un of [progress, pausedEv]) void un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (!counting) return;
    const iv = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(iv);
  }, [counting]);

  // 결과(성공·실패·취소)는 record://saved·failed·cancelled 로 오고 Rust 가 이 창을 닫는다 — 응답 자체엔 실을 것이 없다.
  // 호출이 실패하면 버튼만 되살린다(이 창엔 토스트가 없다) — 다시 누를 수 있어야 녹화가 끝없이 돌지 않는다.
  const stop = () => {
    setStopping(true);
    void ipc.recordStop().catch(() => setStopping(false));
  };

  if (counting) {
    return (
      <div className="fixed inset-0 flex select-none items-center gap-3 bg-neutral-900 px-3 text-sm text-white">
        <span className="w-7 text-center font-mono text-2xl font-semibold tabular-nums text-red-400">
          {rec ? left : "…"}
        </span>
        <span className="text-xs text-white/70">{t.recStarting}</span>
        <button
          type="button"
          // 응답 전엔 취소할 녹화가 아직 없다 — record_stop 이 헛돌고 그 뒤에 녹화가 시작된다.
          disabled={!rec || stopping}
          className="ml-auto rounded bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20 disabled:opacity-60"
          onClick={stop}
        >
          {t.recCancel}
        </button>
      </div>
    );
  }

  const sec = Math.floor((prog?.elapsedMs ?? 0) / 1000);
  const clock = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  return (
    <div className="fixed inset-0 flex select-none items-center gap-2 overflow-hidden whitespace-nowrap bg-neutral-900 px-2.5 text-sm text-white">
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          paused ? "bg-amber-400" : `bg-red-500 ${stopping ? "" : "animate-pulse"}`
        }`}
      />
      <span className={`font-mono tabular-nums ${paused ? "text-white/50" : ""}`}>{clock}</span>
      <span className="font-mono text-[11px] text-white/60">{formatBytes(prog?.bytes ?? 0)}</span>
      <span className="min-w-0 truncate font-mono text-[11px] text-white/40">
        {rec.width}×{rec.height}
      </span>
      {rec.cpu && (
        <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[10px] text-amber-300" title={t.recCpuTitle}>
          {t.recCpu}
        </span>
      )}
      {rec.audio && (
        <span className="shrink-0 text-white/60" title={t.recAudioTitle}>
          <Mic size={13} />
        </span>
      )}
      <button
        type="button"
        disabled={pausing || stopping}
        title={paused ? t.recResume : t.recPause}
        aria-label={paused ? t.recResume : t.recPause}
        className="ml-auto shrink-0 rounded p-1 text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-50"
        onClick={() => {
          setPausing(true);
          void ipc
            .recordPause(!paused)
            .then(setPaused)
            // 실패(대개 방금 정지됐다)면 표시를 그대로 둔다 — 다음 record://progress 가 실제 상태를 싣고 온다.
            .catch(() => {})
            .finally(() => setPausing(false));
        }}
      >
        {paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
      <button
        type="button"
        disabled={stopping}
        className="shrink-0 rounded bg-red-600 px-2.5 py-1 text-xs font-medium hover:bg-red-500 disabled:opacity-60"
        onClick={stop}
      >
        {stopping ? t.recStopping : `■ ${t.recStop}`}
      </button>
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
