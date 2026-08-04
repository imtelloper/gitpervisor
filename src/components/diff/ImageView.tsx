import { ExternalLink, FileWarning, Maximize, Minus, Plus, Scan } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, ipc } from "../../lib/ipc";
import { useFileImage } from "../../queries";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

// 배율 한계와 휠 스텝. 지수 스텝이라 어느 배율에서든 한 노치의 체감이 균일하다.
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const WHEEL_STEP = 1.1;
const BTN_STEP = 1.4; // 버튼·키보드는 한 번에 더 크게 움직여야 답답하지 않다
// 이 배율을 넘으면 보간을 끄고 픽셀을 그대로 보여준다(아이콘·픽셀아트가 뭉개지지 않게).
const PIXELATE_FROM = 2;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** 화면 좌표 기준 이미지 배치 — transform-origin은 좌상단(0,0) 고정이 전제다(zoomAt 참고). */
interface View {
  scale: number;
  x: number;
  y: number;
}

/** 이미지 파일 미리보기 — 워크트리 파일을 base64 data URL로 렌더. 줌/팬 지원. */
export default function ImageView({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}) {
  const { data, isLoading, error } = useFileImage(projectId, path);

  if (isLoading) return <EmptyState title="이미지 불러오는 중…" />;
  if (error || !data)
    return (
      <EmptyState
        icon={FileWarning}
        title="이미지를 불러오지 못했습니다"
        desc={error ? errorMessage(error) : undefined}
      />
    );

  // key={path} — 파일이 바뀌면 줌/오프셋이 초기 상태(맞춤)로 되돌아간다.
  return (
    <ZoomableImage
      key={path}
      src={`data:${data.mime};base64,${data.base64}`}
      projectId={projectId}
      path={path}
    />
  );
}

function ZoomableImage({
  src,
  projectId,
  path,
}: {
  src: string;
  projectId: string;
  path: string;
}) {
  const pushToast = useUi((s) => s.pushToast);
  // 웹뷰가 디코드하지 못한 형식 — 확장자가 목록에 있어도 엔진이 못 그릴 수 있다
  // (TIFF·HEIC는 macOS WKWebView는 되고 Windows WebView2는 안 된다 — 실측).
  // onError를 안 잡으면 onLoad가 영영 안 와 빈 화면만 남는다.
  const [decodeFailed, setDecodeFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // null = 아직 이미지 크기를 몰라 "맞춤"을 계산하지 못한 상태(첫 렌더).
  const [view, setView] = useState<View | null>(null);
  const [dragging, setDragging] = useState(false);
  // 지금이 "맞춤" 상태인가 — 컨테이너 리사이즈 때 다시 맞출지 판단한다. 렌더에 쓰이지 않고
  // 리스너에서 최신값을 읽어야 하므로 state가 아니라 ref.
  const atFit = useRef(true);

  /** 컨테이너에 꼭 맞는 배율과 중앙 정렬 오프셋. 원본이 작으면 확대하지 않는다(1배 상한). */
  const fitView = useCallback((): View | null => {
    const box = boxRef.current;
    const img = imgRef.current;
    if (!box || !img?.naturalWidth) return null;
    const scale = Math.min(
      1,
      box.clientWidth / img.naturalWidth,
      box.clientHeight / img.naturalHeight,
    );
    return {
      scale,
      x: (box.clientWidth - img.naturalWidth * scale) / 2,
      y: (box.clientHeight - img.naturalHeight * scale) / 2,
    };
  }, []);

  const applyFit = useCallback(() => {
    atFit.current = true;
    const v = fitView();
    if (v) setView(v);
  }, [fitView]);

  /** 컨테이너 중심을 고정한 채 배율만 바꾼다(툴바 ±·키보드용). */
  const zoomCenter = useCallback((factor: number) => {
    const box = boxRef.current;
    if (!box) return;
    atFit.current = false;
    setView((v) =>
      v ? zoomAt(v, box.clientWidth / 2, box.clientHeight / 2, factor) : v,
    );
  }, []);

  /** 배율 1(원본 픽셀)로 — 화면 중심 기준. */
  const actualSize = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    atFit.current = false;
    setView((v) =>
      v ? zoomAt(v, box.clientWidth / 2, box.clientHeight / 2, 1 / v.scale) : v,
    );
  }, []);

  // 컨테이너 크기가 변하면(패널 리사이즈·창 크기) **맞춤 상태였을 때만** 다시 맞춘다.
  // 사용자가 확대해 둔 배율을 리사이즈가 멋대로 되돌리지 않게 한다.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => {
      if (atFit.current) applyFit();
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [applyFit]);

  // 휠: Ctrl/⌘면 커서 고정 줌, 아니면 팬. 트랙패드 핀치는 브라우저가 ctrlKey로 주므로
  // 핀치줌이 따로 배선 없이 붙는다. preventDefault가 필요해 passive:false로 직접 등록한다
  // (React의 onWheel은 passive라 브라우저 기본 확대가 끼어든다).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      atFit.current = false;
      if (e.ctrlKey || e.metaKey) {
        const r = box.getBoundingClientRect();
        const factor = Math.pow(WHEEL_STEP, -e.deltaY / 100);
        setView((v) =>
          v ? zoomAt(v, e.clientX - r.left, e.clientY - r.top, factor) : v,
        );
      } else {
        // Shift+휠은 가로 팬. 트랙패드는 deltaX를 직접 주므로 그대로 반영한다.
        const dx = e.shiftKey ? -e.deltaY : -e.deltaX;
        const dy = e.shiftKey ? 0 : -e.deltaY;
        setView((v) => (v ? { ...v, x: v.x + dx, y: v.y + dy } : v));
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") zoomCenter(BTN_STEP);
    else if (e.key === "-" || e.key === "_") zoomCenter(1 / BTN_STEP);
    else if (e.key === "0") applyFit();
    else if (e.key === "1") actualSize();
    else return;
    e.preventDefault();
  };

  // 드래그 팬 — 포인터 캡처로 컨테이너 밖으로 나가도 이어진다.
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragFrom.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const from = dragFrom.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragFrom.current = { x: e.clientX, y: e.clientY };
    atFit.current = false;
    setView((v) => (v ? { ...v, x: v.x + dx, y: v.y + dy } : v));
  };
  const endDrag = (e: React.PointerEvent) => {
    dragFrom.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };

  if (decodeFailed)
    return (
      <EmptyState
        icon={FileWarning}
        title="이 형식은 표시할 수 없습니다"
        desc="현재 플랫폼의 웹뷰가 이 이미지 형식을 디코드하지 못합니다. 파일 자체는 정상일 수 있습니다."
        action={
          <button
            onClick={() =>
              void ipc
                .runExecutable(projectId, path)
                .catch((e) => pushToast("error", errorMessage(e)))
            }
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
          >
            <ExternalLink size={13} /> 외부 앱으로 열기
          </button>
        }
      />
    );

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-edge px-3 text-xs text-fg-dim">
        <TBtn label="축소 (−)" onClick={() => zoomCenter(1 / BTN_STEP)}>
          <Minus size={13} />
        </TBtn>
        {/* 배율을 숫자로 보여준다 — 얼마나 확대했는지 모르면 줌은 쓰기 어렵다 */}
        <span className="w-12 text-center tabular-nums">
          {view ? Math.round(view.scale * 100) : 100}%
        </span>
        <TBtn label="확대 (+)" onClick={() => zoomCenter(BTN_STEP)}>
          <Plus size={13} />
        </TBtn>
        <div className="mx-1 h-4 w-px bg-edge" />
        <TBtn label="화면 맞춤 (0)" onClick={applyFit}>
          <Scan size={13} />
        </TBtn>
        <TBtn label="실제 크기 (1)" onClick={actualSize}>
          <Maximize size={13} />
        </TBtn>
      </div>

      <div
        ref={boxRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // 더블클릭: 맞춤 ↔ 원본 (없어진 토글 버튼의 계승)
        onDoubleClick={() => (atFit.current ? actualSize() : applyFit())}
        className={`checkerboard relative min-h-0 flex-1 overflow-hidden outline-none ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <img
          ref={imgRef}
          src={src}
          alt={path}
          draggable={false}
          // naturalWidth는 로드 후에야 안다 — 그 시점에 맞춤을 계산한다.
          onLoad={applyFit}
          onError={() => setDecodeFailed(true)}
          style={{
            transformOrigin: "0 0",
            transform: view
              ? `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
              : undefined,
            imageRendering:
              view && view.scale >= PIXELATE_FROM ? "pixelated" : "auto",
            // 맞춤 계산 전엔 숨긴다 — 원본 크기로 한 프레임 번쩍이는 것을 막는다.
            visibility: view ? "visible" : "hidden",
          }}
          className="absolute left-0 top-0 max-w-none select-none"
        />
      </div>
    </div>
  );
}

/**
 * 컨테이너 좌표 (cx, cy) 아래의 이미지 점을 **그 자리에 둔 채** 배율만 factor배 한다.
 *
 *   o' = c - (c - o) * (s' / s)
 *
 * transform-origin이 0 0이라 이 한 줄로 끝난다(center면 컨테이너 크기가 식에 끼어든다).
 */
function zoomAt(v: View, cx: number, cy: number, factor: number): View {
  const scale = clampScale(v.scale * factor);
  // 한계에 걸리면 요청한 factor와 실제 비율이 달라진다 — 실제 비율로 오프셋을 옮겨야
  // 최대/최소 배율에서 이미지가 슬금슬금 밀리지 않는다.
  const k = scale / v.scale;
  return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
}

function TBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className="rounded p-1 hover:bg-raised hover:text-fg"
    >
      {children}
    </button>
  );
}
