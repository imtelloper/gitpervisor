import {
  ExternalLink,
  FileWarning,
  Maximize,
  Minus,
  Pencil,
  Plus,
  Scan,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { errorMessage, ipc } from "../../lib/ipc";
import { useDir, useFileImage } from "../../queries";
import { IS_DOC_WINDOW, openDocWindow } from "../../lib/floating";
import { isImage } from "../../lib/language-map";
import { joinPath, parentDir } from "../../lib/path";
import { WHEEL_STEP, zoomAt, type View } from "../../lib/zoom";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

// 줌 상수·수학은 lib/zoom.ts 가 단일 소스다(이미지 편집기와 공유 — 두 벌로 두면 갈라진다).
const BTN_STEP = 1.4; // 버튼·키보드는 한 번에 더 크게 움직여야 답답하지 않다
// 이 배율을 넘으면 보간을 끄고 픽셀을 그대로 보여준다(아이콘·픽셀아트가 뭉개지지 않게).
const PIXELATE_FROM = 2;

/**
 * 같은 폴더의 형제 이미지 내비게이션(↑↓·←→). 트리와 **같은 목록**(백엔드 dirs-first 자연 정렬)에서
 * 이미지만 뽑는다 — 화면 순서와 어긋나지 않게. 트리가 이미 펼친 폴더면 캐시 히트라 즉시,
 * 아니면 list_dir 1회.
 *
 * doc 창은 대상이 창 수명 동안 고정이라 넘길 수 없다(태스크 56 §3.4 — v1 범위 밖). 여기서 막지
 * 않으면 replaceDiff가 그 창의 별개 스토어만 바꾸고(화면은 그대로) 공유 localStorage의
 * 뷰어 탭 대상까지 조용히 갈아 끼운다. projectId=null → 쿼리 자체가 비활성.
 *
 * 로딩·실패 화면도 같은 훅을 쓴다 — 안 그러면 디코드 못 하는 파일 하나에서 내비가 끊겨
 * 트리로 되돌아가야 한다(§1 "트리를 다시 클릭할 필요가 없다").
 */
function useSiblingNav(projectId: string, path: string) {
  const replaceDiff = useUi((s) => s.replaceDiff);
  const dir = parentDir(path);
  const { data: entries } = useDir(IS_DOC_WINDOW ? null : projectId, dir);
  const siblings = useMemo(
    () =>
      (entries ?? [])
        .filter((e) => !e.isDir && isImage(e.name))
        .map((e) => joinPath(dir, e.name)),
    [entries, dir],
  );
  const idx = siblings.indexOf(path);
  /** d칸 뒤/앞 이미지로 — 끝에서는 멈춘다(순환 없음). 탭은 늘지 않는다(replaceDiff). */
  const go = (d: 1 | -1) => {
    const next = idx >= 0 ? siblings[idx + d] : undefined;
    if (next) replaceDiff({ mode: "file", path: next });
  };
  /** 화살표만 처리한다. true = 처리함(호출자는 자기 키 처리를 건너뛴다). */
  const navKey = (e: React.KeyboardEvent) => {
    // 수식키 조합은 앱 전역 단축키에 양보한다(Ctrl+Shift+↑↓ = 프로젝트 이동 등).
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!plain) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") go(-1);
    else return false;
    e.preventDefault(); // 화살표가 박스를 스크롤하지 않게
    return true;
  };
  return { idx, siblings, go, navKey };
}

/**
 * 로딩·실패 화면을 감싸는 최소 껍데기 — 포커스 가능한 박스 + 화살표 + "n / N".
 * 그림이 없어도 ↑/↓로 다음 이미지로 빠져나갈 수 있어야 한다.
 */
function NavShell({
  projectId,
  path,
  children,
}: {
  projectId: string;
  path: string;
  children: React.ReactNode;
}) {
  const { idx, siblings, navKey } = useSiblingNav(projectId, path);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={boxRef}
      tabIndex={0}
      onKeyDown={navKey}
      className="flex h-full flex-col outline-none"
    >
      {idx >= 0 && siblings.length >= 2 && (
        <div className="flex h-8 shrink-0 items-center justify-end border-b border-edge px-3 text-xs text-fg-dim">
          <span className="tabular-nums">
            {idx + 1} / {siblings.length}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
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

  // 로딩·실패도 NavShell로 감싼다 — 전환 중 포커스가 body로 떨어지면 연타가 끊기고,
  // 못 여는 파일에서는 화살표가 아예 죽는다.
  if (isLoading)
    return (
      <NavShell projectId={projectId} path={path}>
        <EmptyState title="이미지 불러오는 중…" />
      </NavShell>
    );
  if (error || !data)
    return (
      <NavShell projectId={projectId} path={path}>
        <EmptyState
          icon={FileWarning}
          title="이미지를 불러오지 못했습니다"
          desc={error ? errorMessage(error) : undefined}
        />
      </NavShell>
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
  const openImageEditor = useUi((s) => s.openImageEditor);
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

  // 같은 폴더의 형제 이미지(↑/↓·←/→) — 로딩·실패 화면과 같은 훅을 공유한다(위 NavShell).
  const { idx, siblings, navKey } = useSiblingNav(projectId, path);

  // 마운트 시 박스에 포커스 — 지금껏 아무도 focus()를 부르지 않아 한 번 클릭하기 전엔 키가
  // 안 먹었다. key={path}라 이미지가 바뀔 때마다 리마운트돼 포커스가 따라온다(연타 가능).
  // 훔치는 범위는 리마운트 시점뿐이다: 저장 후 무효화는 path가 그대로라 리마운트되지 않고,
  // 뷰어 탭이 hidden이면 focus()는 애초에 무효라 뒤에서 열린 이미지가 포커스를 가져가지 않는다.
  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true });
  }, []);

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
    // 화살표(형제 이미지 이동)가 먼저 — 수식키 양보 규칙은 navKey 안에 있다.
    if (navKey(e)) return;
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
      <NavShell projectId={projectId} path={path}>
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
      </NavShell>
    );

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-edge px-3 text-xs text-fg-dim">
        {/* 편집 진입 — projectId 를 함께 넘긴다. 임베디드 저장소면 합성 id 라 이게 정답이다(설계 D1). */}
        <button
          // 메인 창에서는 **크기 조절 가능한 별도 창**으로 연다(파일트리 더블클릭과 같은 경로·
          // 같은 크기). 이미 doc 창 안이면 그 창에서 열어야 한다 — 여기서 또 openDocWindow 를
          // 부르면 편집을 누를 때마다 창이 하나씩 늘어난다.
          onClick={() =>
            IS_DOC_WINDOW
              ? openImageEditor(path, projectId)
              : openDocWindow(projectId, path, { size: [1180, 860], edit: true })
          }
          title="이미지 편집 (새 창)"
          className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-raised hover:text-fg"
        >
          <Pencil size={13} /> 편집
        </button>
        <div className="flex-1" />
        {/* 같은 폴더에서 몇 번째 이미지인가 — ↑/↓로 넘길 게 남았는지 알려 준다(2장 이상일 때만). */}
        {idx >= 0 && siblings.length >= 2 && (
          <span className="mr-1 tabular-nums text-fg-dim">
            {idx + 1} / {siblings.length}
          </span>
        )}
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

export function TBtn({
  label,
  onClick,
  children,
  ...rest // data-*·aria-* — TSX 는 하이픈 속성을 props 타입 검사에서 빼므로 PdfView 가 셀렉터를 달 수 있다
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      {...rest}
      onClick={onClick}
      title={label}
      className="rounded p-1 hover:bg-raised hover:text-fg"
    >
      {children}
    </button>
  );
}
