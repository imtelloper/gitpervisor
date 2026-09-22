// PDF 주석 스파이크 하니스(S1 · DEV 전용) — pdf.js 없이 가짜 A4 3장 위에서 어댑터 A1~A4 와
// 활성 페이지 규칙을 잰다(DOCS/pdf-viewer-editor-design.md §8.2). e2e 62 가 구동한다.
//
// 게이트 1·4 는 전부 **오버레이의 성질**이라 PDF 렌더러가 없어도 잴 수 있다. 그래서 페이지는 흰 div
// 이고, 그 위에 얹는 것만 제품 경로와 같다: 활성 페이지 1장에 `AnnotationLayer` + `ChromeOverlay`,
// 노드가 있는 비활성 페이지에는 `renderScene` 정적 캔버스(상호작용 없음).
//
// 좌표계:
//   문서 단위  pt(595×842) — 노드가 사는 곳
//   백킹 px    = pt × scale          scale = round(595·k)/595, k = settled줌·96/72·dpr
//   css px     = pt × displayScale   settle 뒤 페이지 css 박스 = 백킹/dpr
//
// 페이지 css 박스를 백킹/dpr 로 **스냅**하는 이유: 소수 css 크기에 백킹을 붙이면 합성기가 비트맵을
// 통째로 재샘플해 1pt 선이 번진다 — 게이트 1 이 재는 바로 그 증상이다. 줌 도중(settle 전)에는 라이브
// 크기로 늘려 보여 주고 백킹은 settle 값 그대로 둔다 — 휠 노치마다 씬 전량 재렌더가 돌지 않게.
// viewport 전략도 같다: 줌 도중에는 영역을 **마지막 settle 의 레이아웃·스크롤**로 고정한다(geoOf).
//
// 백킹 전략 셋(런타임 전환):
//   page      viewport 없음, 페이지 전체를 디바이스 px 로 덮는다.
//   viewport  보이는 영역 ∩ 페이지(+여백)만 덮는다 — 400% 메모리 질문의 대안.
//   image     이미지 편집기식(1pt = 1px, pixelated). 게이트 1 이 흐림을 **잡는지** 보는 반증용이다.
// 비활성 페이지의 정적 오버레이는 세 전략 모두 보이는 영역(+여백)과 겹칠 때만 캔버스를 둔다 —
// 전략 비교(M)에 컬링 정책 차이가 섞이지 않게.
//
// `window.__gpv.pdfSpike` — main.tsx 에는 `open` 만 있고, 첫 open 이 이 모듈을 불러 그 자리를
// 아래 전체 API 로 바꾼다(동적 import 라 메인 청크에 안 들어간다).

import {
  createRef,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { create } from "zustand";

import { useMessages } from "../../i18n/ui-language";
import type { ChromeScreen } from "../../lib/annotate/chrome";
import { imageStore } from "../../lib/annotate/imageStore";
import { renderScene } from "../../lib/annotate/render";
import { resolveScene } from "../../lib/annotate/scene";
import { normalizeDoc } from "../../lib/annotate/schema";
import type { Guide } from "../../lib/annotate/snap";
import { DEFAULT_PAINT, type DefaultPaint, type EditorDoc } from "../../lib/annotate/types";
import { useImageEditorUi, type Tool } from "../../stores/imageEditor";
import { useOccludesWebview } from "../../stores/occlusion";
import AnnotationLayer, { type AnnotationLayerHandle } from "../image/AnnotationLayer";
import ChromeOverlay, { type ChromeOverlayHandle } from "../image/ChromeOverlay";
import type { StatusBarHandle } from "../image/EditorStatusBar";
import ToolRail, { type RailItem } from "../image/ToolRail";

type Strategy = "page" | "viewport" | "image";
type Viewport = { x: number; y: number; width: number; height: number };

/** A4(pt). 이 **참조**가 곧 `bounds` prop 이다 — 매 렌더 새 객체면 레이어가 매번 다시 그린다. */
const PAGE = { width: 595, height: 842 } as const;
const PAGE_COUNT = 3;
const PT_CSS = 96 / 72;
const SETTLE_MS = 150;
/** viewport 전략이 보이는 영역 밖으로 더 잡는 여백(css px) — 스크롤 한 틱에 가장자리가 비지 않게. */
const VIEWPORT_MARGIN_CSS = 96;
/** 크롬 여백(css px) — 페이지 가장자리 객체의 핸들·HUD 가 SVG 경계에서 잘리지 않게(s1-critic). */
const CHROME_PAD = 24;

/** PDF 도구 집합(설계 §8.1). vpen(베지어)·크롭·모자이크는 없다. */
export const PDF_TOOLS: readonly RailItem["id"][] = [
  "select",
  "hand",
  "text",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "pen",
  "highlight",
];
/** 기본 페인트 — 값이 문서 단위라 pt 다(설계 Q5 본문 14pt). */
const PAINT: DefaultPaint = {
  ...DEFAULT_PAINT,
  strokeWidth: 2,
  fontSize: 14,
  typo: { ...DEFAULT_PAINT.typo, fontSize: 14 },
};
const NO_GUIDES: readonly Guide[] = [];
const NOOP = () => {};
const keepPos = (_axis: "x" | "y", pos: number) => pos;

/** 상태바 대역 — 레이어의 커서 좌표·픽셀 색 경로(flushCursor)를 e2e 가 읽게 마지막 값만 쥔다. */
let lastCursor: { x: number | null; y: number | null; rgb: string | null } | null = null;
const statusRef: RefObject<StatusBarHandle | null> = {
  current: { setCursor: (x, y, rgb) => void (lastCursor = { x, y, rgb }) },
};

// ── 상태 ────────────────────────────────────────────────────────────────────

interface SpikeState {
  /** 라이브 줌(1 = 100%). */
  zoom: number;
  /** 150ms 디바운스 뒤 줌 — 백킹은 이 값만 본다. */
  settled: number;
  strategy: Strategy;
  active: number;
  docs: EditorDoc[];
  /** pointerenter·pointermove 로 활성 페이지를 바꿀지. e2e 는 끈다(실제 마우스가 창 위에 있으면 게이트가 흔들린다). 누름 전환은 이 값과 무관. */
  hoverSwitch: boolean;
  /** 스크롤 컨테이너 — viewport 전략이 보이는 영역을 여기서 계산한다. */
  scroll: { left: number; top: number; w: number; h: number };
  /** 줌을 시작한 순간(settle 상태)의 scroll — 줌 도중 geoOf 가 이 값으로 영역을 고정한다. */
  pinScroll: { left: number; top: number; w: number; h: number };
}

const fresh = (): SpikeState => ({
  zoom: 1,
  settled: 1,
  strategy: "page",
  active: 0,
  docs: Array.from({ length: PAGE_COUNT }, () => normalizeDoc({})),
  hoverSwitch: true,
  scroll: { left: 0, top: 0, w: 0, h: 0 },
  pinScroll: { left: 0, top: 0, w: 0, h: 0 },
});

const useSpike = create<SpikeState>(fresh);

const scrollRef = createRef<HTMLDivElement>();
const layerRef = createRef<AnnotationLayerHandle>();

// ── 배치 산술 ────────────────────────────────────────────────────────────────

function pageLayout(st: SpikeState, dpr: number) {
  const snap = (css: number) => Math.round(css * dpr) / dpr;
  const backW = Math.round(PAGE.width * st.settled * PT_CSS * dpr);
  // 등방 배율은 폭에서 정한다 — 높이는 반올림 오차(≤0.5 디바이스 px)를 아래 가장자리에만 남긴다.
  const scale = backW / PAGE.width;
  const backH = Math.round(PAGE.height * scale);
  const zooming = st.zoom !== st.settled;
  const cssW = zooming ? PAGE.width * st.zoom * PT_CSS : backW / dpr;
  const cssH = zooming ? PAGE.height * st.zoom * PT_CSS : backH / dpr;
  // 여백·간격도 디바이스 px 로 붙인다 — 페이지 원점이 소수 px 에 놓이면 스냅이 무의미해진다.
  const pad = snap(16);
  const gap = snap(24);
  return {
    dpr,
    backW,
    backH,
    scale,
    cssW,
    cssH,
    ds: cssW / PAGE.width,
    pad,
    top: (i: number) => pad + i * (cssH + gap),
    contentW: pad * 2 + cssW,
    contentH: pad * 2 + PAGE_COUNT * cssH + (PAGE_COUNT - 1) * gap,
  };
}
type Layout = ReturnType<typeof pageLayout>;

interface Geo {
  backing: "image" | "display";
  backW: number;
  backH: number;
  scale: number;
  displayScale: number;
  viewport?: Viewport;
  /** 페이지가 보이는 영역(+여백)과 겹치는가 — 비활성 페이지 정적 오버레이의 컬링 기준. */
  visible: boolean;
  /** 값이 같으면 같은 문자열 — viewport 객체 참조를 안정시키고 정적 캔버스 재렌더를 거른다. */
  key: string;
}

function geoOf(i: number, st: SpikeState, L: Layout): Geo {
  // 줌 도중(settle 전)에는 **마지막 settle 의 레이아웃·스크롤**로 영역을 잰다. 라이브 ds 로 보이는
  // 영역을 settle 배율(L.scale)로 덮으면 줌아웃 몇 노치에 백킹이 settle 의 수 배(400%→100% 에서
  // 3MP → 27MP)가 되고, 노치마다 key 가 바뀌어 씬 전량 재렌더·재할당이 돈다. css 배치는 라이브
  // displayScale 이 맡으므로 자리는 맞다 — 줌아웃으로 새로 드러난 가장자리만 settle 까지 빈다.
  const zooming = st.zoom !== st.settled;
  const V = zooming ? pageLayout({ ...st, zoom: st.settled }, L.dpr) : L;
  const { left, top, w, h } = zooming ? st.pinScroll : st.scroll;
  // 보이는 영역 ∩ 페이지(+여백), 문서 단위.
  const m = VIEWPORT_MARGIN_CSS;
  const x0 = Math.max(0, (left - V.pad - m) / V.ds);
  const x1 = Math.min(PAGE.width, (left + w - V.pad + m) / V.ds);
  const y0 = Math.max(0, (top - V.top(i) - m) / V.ds);
  const y1 = Math.min(PAGE.height, (top + h - V.top(i) + m) / V.ds);
  const visible = x1 > x0 && y1 > y0;
  if (st.strategy === "image") {
    return {
      backing: "image",
      backW: PAGE.width,
      backH: PAGE.height,
      scale: 1,
      displayScale: L.ds,
      visible,
      key: "image",
    };
  }
  if (st.strategy === "page") {
    return {
      backing: "display",
      backW: L.backW,
      backH: L.backH,
      scale: L.scale,
      displayScale: L.ds,
      visible,
      key: `page|${L.backW}x${L.backH}`,
    };
  }
  // 백킹 px 격자로 **바깥** 스냅 — 그래야 backW = round(viewport.width × scale) 가 정수로 딱
  // 떨어지고 css 원점도 디바이스 px 에 놓인다. ±EPS: scrollTop 은 디바이스 px 에 붙여도 float32 로
  // 읽혀(602.66668…) floor/ceil 이 한 칸 튄다 — 원점만 옮긴 스크롤에서 백킹 크기가 ±1 흔들렸다(실측).
  const EPS = 1e-3;
  let bx0 = Math.floor(x0 * L.scale + EPS);
  let bx1 = Math.min(L.backW, Math.ceil(x1 * L.scale - EPS));
  let by0 = Math.floor(y0 * L.scale + EPS);
  let by1 = Math.min(L.backH, Math.ceil(y1 * L.scale - EPS));
  // 페이지가 화면 밖이면 1×1 — 0 크기 캐시를 drawImage 하면 던진다.
  if (bx1 <= bx0 || by1 <= by0) {
    bx0 = 0;
    bx1 = 1;
    by0 = 0;
    by1 = 1;
  }
  return {
    backing: "display",
    backW: bx1 - bx0,
    backH: by1 - by0,
    scale: L.scale,
    displayScale: L.ds,
    visible,
    viewport: {
      x: bx0 / L.scale,
      y: by0 / L.scale,
      width: (bx1 - bx0) / L.scale,
      height: (by1 - by0) / L.scale,
    },
    key: `vp|${bx0},${by0},${bx1},${by1}|${L.backW}`,
  };
}

// ── 활성 페이지 전환 ────────────────────────────────────────────────────────

/** @param raw e2e 반증 전용 — ① 확정만 건너뛴다. 이 경로에서 텍스트가 사라져야 ① 단언이 헛단언이 아니다. */
function switchTo(i: number, raw = false): void {
  if (i === useSpike.getState().active || i < 0 || i >= PAGE_COUNT) return;
  const ui = useImageEditorUi.getState();
  // ① 입력 중인 텍스트를 **옛 페이지에** 확정한다(handleEscape 첫 분기 = finishEditing).
  //    레이어에는 언마운트 확정 경로가 없고, 제거되는 textarea 의 onBlur 에 기댈 수도 없다.
  if (ui.textEditing && !raw) layerRef.current?.handleEscape();
  // ② 레이어가 스스로 되돌리지 않는 스토어 잔재. reset() 은 도구까지 select 로 돌리므로 쓰지 않는다.
  ui.select([]);
  ui.setHover(null);
  ui.setTextEditing(false); // 새 레이어가 없는 순간에도 도구 키가 죽지 않게(shortcuts.ts:318)
  if (useImageEditorUi.getState().mode.kind !== "design") ui.setMode({ kind: "design" });
  // ③ 마지막에 활성 페이지. flushSync — 곧바로 이어지는 첫 클릭이 커밋 전 DOM 에 떨어지지 않게.
  flushSync(() => useSpike.setState({ active: i }));
}

/**
 * pointerenter **와 pointermove** 에서 부른다. 드래그 중·텍스트 편집 중에는 hover 로 바꾸지 않는데
 * (긋던 선이 다른 페이지 레이어로 끊긴다), enter 만 보면 그 가드가 풀린 뒤 포인터가 나갔다 들어올
 * 때까지 그 페이지가 영영 활성이 안 된다(자식이 전부 pointer-events-none 이라 enter 가 다시 안 온다).
 * 그래서 첫 이동에서 다시 판정한다. 활성 페이지 위의 이동은 첫 줄에서 끝난다.
 */
function onPageHover(e: ReactPointerEvent, i: number): void {
  const s = useSpike.getState();
  if (i === s.active || !s.hoverSwitch || e.buttons !== 0) return;
  if (useImageEditorUi.getState().textEditing) return;
  switchTo(i);
}

/**
 * 비활성 페이지를 누르면 곧바로 활성으로(capture) — hover 가드에 막힌 채 움직이지 않고 누른 클릭이
 * 무반응으로 사라지지 않게. pointerdown 은 mousedown(→ textarea blur)보다 먼저라 ① 확정 → 전환
 * 순서가 여기서도 지켜진다. 누른 제스처 자체는 새 레이어로 가지 않는다 — 활성화(와 텍스트 확정)가
 * 그 클릭의 몫이다. hoverSwitch 와 무관하다(누름은 의도된 입력이다).
 */
function onPagePress(e: ReactPointerEvent, i: number): void {
  if (e.button !== 0 || i === useSpike.getState().active) return;
  switchTo(i);
}

function setObjects(page: number, objects: EditorDoc["objects"]): void {
  useSpike.setState((s) => ({
    docs: s.docs.map((d, i) => (i === page ? { ...d, objects } : d)),
  }));
}

let scrollRaf = 0;
function syncScroll(): void {
  const el = scrollRef.current;
  if (!el) return;
  const cur = useSpike.getState().scroll;
  const next = { left: el.scrollLeft, top: el.scrollTop, w: el.clientWidth, h: el.clientHeight };
  if (next.left !== cur.left || next.top !== cur.top || next.w !== cur.w || next.h !== cur.h) {
    useSpike.setState({ scroll: next });
  }
}
function onScroll(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    syncScroll();
  });
}

// ── 컴포넌트 ────────────────────────────────────────────────────────────────

function Harness() {
  const msg = useMessages();
  const st = useSpike();
  useOccludesWebview(true); // 내장 브라우저(네이티브 자식 webview)가 하니스 위로 뜨지 않게
  useEffect(() => {
    window.addEventListener("resize", syncScroll);
    return () => window.removeEventListener("resize", syncScroll);
  }, []);
  const L = pageLayout(st, window.devicePixelRatio || 1);

  return (
    <div data-pdf-spike className="fixed inset-0 flex bg-panel text-fg" style={{ zIndex: 9000 }}>
      <ToolRail tools={PDF_TOOLS} paint={PAINT} onFocusRoot={NOOP} onPlaceImage={NOOP} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3 text-[12px]">
          <span className="font-medium">{msg.pdf.spike.title}</span>
          <select
            value={st.strategy}
            onChange={(e) => void pdfSpike.setStrategy(e.target.value as Strategy)}
            className="rounded border border-edge bg-raised px-1"
          >
            <option value="page">page</option>
            <option value="viewport">viewport</option>
            <option value="image">image</option>
          </select>
          <button className="rounded px-2 hover:bg-raised" onClick={() => void pdfSpike.setZoom(st.zoom / 1.25)}>
            −
          </button>
          <span className="w-12 text-center tabular-nums">{Math.round(st.zoom * 100)}%</span>
          <button className="rounded px-2 hover:bg-raised" onClick={() => void pdfSpike.setZoom(st.zoom * 1.25)}>
            +
          </button>
          <span className="text-fg-muted">
            {msg.pdf.spike.activePage(st.active + 1, PAGE_COUNT)}
          </span>
          <button className="ml-auto rounded px-2 hover:bg-raised" onClick={() => pdfSpike.close()}>
            {msg.pdf.spike.close}
          </button>
        </div>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="relative min-h-0 flex-1 overflow-auto"
          style={{ background: "#525659" }}
        >
          <div className="relative" style={{ width: L.contentW, height: L.contentH }}>
            {st.docs.map((doc, i) => {
              const geo = geoOf(i, st, L);
              return (
                <div
                  key={i}
                  data-pdf-page={i}
                  className="absolute"
                  style={{ left: L.pad, top: L.top(i), width: L.cssW, height: L.cssH, background: "#ffffff" }}
                  onPointerEnter={(e) => onPageHover(e, i)}
                  onPointerMove={(e) => onPageHover(e, i)}
                  onPointerDownCapture={(e) => onPagePress(e, i)}
                >
                  <FakeText ds={L.ds} page={i} />
                  {i === st.active ? (
                    <ActiveLayer key={st.active} page={i} doc={doc} geo={geo} cssW={L.cssW} cssH={L.cssH} />
                  ) : (
                    // 화면(+여백) 밖이면 캔버스를 두지 않는다 — 전략과 무관하게(page 전략도 400% 에서 장당 32MP).
                    doc.objects.length > 0 && geo.visible && <StaticOverlay doc={doc} geo={geo} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 정렬이 눈에 보이게 하는 가짜 본문. 회색이라 게이트 1b 의 빨강 잉크 판정에 걸리지 않는다. */
function FakeText({ ds, page }: { ds: number; page: number }) {
  const lines = [
    `${page + 1}쪽 — 가짜 본문 Lorem ipsum dolor sit amet`, // i18n-ok: 스파이크 정렬용 가짜 본문(픽스처)
    "주석 오버레이 정렬 확인용 줄 0123456789", // i18n-ok: 스파이크 정렬용 가짜 본문(픽스처)
    "The quick brown fox jumps over the lazy dog",
  ];
  return (
    <>
      {lines.map((t, k) => (
        <div
          key={k}
          className="pointer-events-none absolute whitespace-nowrap"
          style={{ left: 72 * ds, top: (440 + k * 22) * ds, fontSize: 11 * ds, lineHeight: 1, color: "#4b5563" }}
        >
          {t}
        </div>
      ))}
    </>
  );
}

function ActiveLayer({
  page,
  doc,
  geo,
  cssW,
  cssH,
}: {
  page: number;
  doc: EditorDoc;
  geo: Geo;
  cssW: number;
  cssH: number;
}) {
  const tool = useImageEditorUi((s) => s.tool);
  const selected = useImageEditorUi((s) => s.selectedIds);
  const chromeRef = useRef<ChromeOverlayHandle>(null);
  // rulers·pixelGrid 는 이미지 편집기와 **공유하는 영속 토글**이다 — 거기서 켠 눈금자가 PDF 에
  // 새지 않게 경유 핸들로 덮는다(ImageEditor 의 chromeTapRef 패턴, 엔진 diff 0).
  const chromeTap = useRef<ChromeOverlayHandle>({
    update: (s) => chromeRef.current?.update({ ...s, rulers: false, pixelGrid: false }),
  });
  const scene = useMemo(() => resolveScene(doc), [doc]);
  const store = useMemo(() => imageStore(doc), [doc]);
  const selectedIds = useMemo(() => selected.filter((id) => id !== "__base"), [selected]);
  // viewport 는 레이어 다시 그리기 effect 의 의존성이다 — 값이 같으면 참조도 같아야 한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewport = useMemo(() => geo.viewport, [geo.key]);
  const screen = useMemo<ChromeScreen>(
    () => ({
      scale: geo.displayScale,
      x: CHROME_PAD,
      y: CHROME_PAD,
      w: cssW + 2 * CHROME_PAD,
      h: cssH + 2 * CHROME_PAD,
      ow: PAGE.width,
      oh: PAGE.height,
    }),
    [geo.displayScale, cssW, cssH],
  );
  const ui = useImageEditorUi.getState(); // 액션만 쓴다(참조가 안 바뀐다)

  return (
    <>
      {/* 래퍼 = 페이지 css 박스. 캔버스(viewport 없으면 inset-0)와 textarea 가 이 원점을 쓴다. */}
      <div data-pdf-layer className="absolute inset-0">
        <AnnotationLayer
          ref={layerRef}
          backing={geo.backing}
          bounds={PAGE}
          viewport={viewport}
          backW={geo.backW}
          backH={geo.backH}
          scale={geo.scale}
          displayScale={geo.displayScale}
          filterStr="none"
          objects={doc.objects}
          store={store}
          assetsVer={0}
          scene={scene}
          chrome={chromeTap}
          screen={screen}
          guides={NO_GUIDES}
          onGuidesChange={NOOP}
          selectedIds={selectedIds}
          // 레일은 PDF 집합만 보이지만 도구 키·다른 편집기가 남긴 도구가 들어올 수 있다 — 한 번 더 막는다.
          tool={(PDF_TOOLS as readonly string[]).includes(tool) ? tool : "select"}
          style={PAINT}
          opacity={1}
          // A3: 엔진 변경 0 — cropMode 가 거짓이면 콜백 넷은 도달하지 않는다.
          cropMode={false}
          cropRect={null}
          onCropDown={NOOP}
          onCropMove={NOOP}
          onCropUp={NOOP}
          onCropCancel={NOOP}
          // 렌더 시점 페이지에 묶는다 — 호출 시점 active 를 읽으면 전환 도중 확정이 다른 페이지로 간다.
          onCommit={(next) => setObjects(page, next)}
          onEditingChange={ui.setTextEditing}
          statusRef={statusRef}
          onToolChange={ui.setTool}
          onSelectionChange={ui.select}
        />
      </div>
      <div className="pointer-events-none absolute" style={{ inset: -CHROME_PAD }}>
        <ChromeOverlay ref={chromeRef} onGuideCommit={NOOP} snapForGuide={keepPos} />
      </div>
    </>
  );
}

/** 비활성 페이지의 정적 오버레이 — 활성 레이어와 같은 변환 규칙, 포인터 없음. */
function StaticOverlay({ doc, geo }: { doc: EditorDoc; geo: Geo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = geo.viewport;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = geo.backW; // 대입이 곧 초기화다(같은 값이어도 백킹을 새로 잡는다)
    c.height = geo.backH;
    renderScene(
      c.getContext("2d")!,
      resolveScene(doc),
      { tx: -(v?.x ?? 0), ty: -(v?.y ?? 0), sx: geo.scale, sy: geo.scale },
      { background: "transparent", store: imageStore(doc) },
    );
    // geo.key 가 백킹 크기·배율·viewport 를 전부 담는다 — 줌 도중(settle 전)에는 다시 그리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, geo.key]);
  const ds = geo.displayScale;
  return (
    <canvas
      ref={ref}
      aria-hidden
      data-pdf-static
      className="pointer-events-none absolute"
      style={{
        ...(v
          ? { left: v.x * ds, top: v.y * ds, width: v.width * ds, height: v.height * ds }
          : { left: 0, top: 0, width: "100%", height: "100%" }),
        imageRendering: geo.backing !== "display" && ds >= 2 ? "pixelated" : "auto",
      }}
    />
  );
}

// ── e2e API ─────────────────────────────────────────────────────────────────

let host: { root: Root; el: HTMLDivElement } | null = null;
let settleTimer = 0;

const frames = (n = 2) =>
  new Promise<void>((res) => {
    const tick = () => (--n > 0 ? requestAnimationFrame(tick) : res());
    requestAnimationFrame(tick);
  });

async function settle(): Promise<void> {
  for (;;) {
    const s = useSpike.getState();
    if (s.zoom === s.settled) break;
    await frames(1);
  }
  await frames(2);
  syncScroll();
  await frames(2);
}

export interface SpikeOpenOpts {
  strategy?: Strategy;
  zoom?: number;
  hoverSwitch?: boolean;
}

export const pdfSpike = {
  async open(o: SpikeOpenOpts = {}) {
    // 주석 모드 진입 = 창 싱글턴 편집기 UI 를 **한 번** 비운다(모드·선택·textEditing 잔재 제거).
    useImageEditorUi.getState().reset();
    lastCursor = null;
    const z = o.zoom ?? 1;
    useSpike.setState({
      ...fresh(),
      strategy: o.strategy ?? "page",
      zoom: z,
      settled: z,
      hoverSwitch: o.hoverSwitch ?? true,
    });
    const g = (window as unknown as { __gpv?: Record<string, unknown> }).__gpv;
    if (g) g.pdfSpike = pdfSpike;
    if (!host) {
      const el = document.createElement("div");
      document.body.appendChild(el);
      const root = createRoot(el);
      root.render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      );
      host = { root, el };
    }
    await frames(3);
    syncScroll();
    await frames(2);
    return pdfSpike.stats();
  },

  close() {
    clearTimeout(settleTimer);
    host?.root.unmount();
    host?.el.remove();
    host = null;
    useImageEditorUi.getState().reset();
  },

  /** 라이브 줌을 바꾸고 150ms settle 까지 기다린다(백킹은 settle 에서만 바뀐다). */
  setZoom(z: number) {
    // 줌 **시작** 순간의 스크롤을 고정한다 — 줌 도중의 스크롤 클램프가 viewport key 를 흔들지 않게.
    syncScroll();
    useSpike.setState((s) => ({ zoom: z, pinScroll: s.zoom === s.settled ? s.scroll : s.pinScroll }));
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => useSpike.setState((s) => ({ settled: s.zoom })), SETTLE_MS);
    return settle();
  },

  async setStrategy(s: Strategy) {
    syncScroll();
    useSpike.setState({ strategy: s });
    await frames(2);
  },

  /** `raw` 는 ① 텍스트 확정을 건너뛰는 반증 경로(e2e 62 LC-3 전용). */
  switchTo(i: number, o?: { raw?: boolean }) {
    switchTo(i, !!o?.raw);
    return frames(2);
  },

  setTool(t: Tool) {
    useImageEditorUi.getState().setTool(t);
    return frames(2);
  },

  setHoverSwitch(on: boolean) {
    useSpike.setState({ hoverSwitch: on });
  },

  ui() {
    const u = useImageEditorUi.getState();
    return { tool: u.tool, textEditing: u.textEditing };
  },

  /** 레이어가 상태바로 보낸 마지막 커서(문서 좌표 · 씬 캔버스 픽셀 색). */
  cursor() {
    return lastCursor;
  },

  /** 스크롤 컨테이너 내용 좌표(css px). 디바이스 px 에 붙인다. */
  async scrollTo(y: number, x?: number) {
    const el = scrollRef.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    el.scrollTop = Math.round(y * dpr) / dpr;
    if (x !== undefined) el.scrollLeft = Math.round(x * dpr) / dpr;
    syncScroll();
    await frames(2);
  },

  /** 페이지 `page` 의 문서 좌표 (x,y) 가 컨테이너 좌상단에 오게 스크롤한다. */
  scrollToDoc(page: number, x: number, y: number) {
    const L = pageLayout(useSpike.getState(), window.devicePixelRatio || 1);
    return pdfSpike.scrollTo(L.top(page) + y * L.ds, L.pad + x * L.ds);
  },

  /** 스키마 정규화를 거쳐 페이지 문서를 통째로 바꾼다. @returns 살아남은 노드 수 */
  async setNodes(page: number, nodes: unknown[]) {
    const doc = normalizeDoc({ objects: nodes });
    useSpike.setState((s) => ({ docs: s.docs.map((d, i) => (i === page ? doc : d)) }));
    await frames(2);
    return doc.objects.length;
  },

  getNodes(page: number) {
    return useSpike.getState().docs[page]?.objects ?? [];
  },

  /** 페이지 문서 좌표 → client 좌표(스크린샷 클립용). */
  docToClient(page: number, x: number, y: number) {
    const el = host?.el.querySelector(`[data-pdf-page="${page}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ds = r.width / PAGE.width;
    return { x: r.left + x * ds, y: r.top + y * ds };
  },

  stats() {
    const st = useSpike.getState();
    const dpr = window.devicePixelRatio || 1;
    const geo = geoOf(st.active, st, pageLayout(st, dpr));
    // [data-pdf-layer] 직속 캔버스 = [0] 커밋 캐시 · [1] 씬 캔버스(AnnotationLayer DOM 순서).
    const scene = host?.el.querySelectorAll<HTMLCanvasElement>("[data-pdf-layer] > canvas")[1] ?? null;
    const r = scene?.getBoundingClientRect();
    const sc = scrollRef.current;
    const scr = sc?.getBoundingClientRect();
    const own = host ? Array.from(host.el.querySelectorAll("canvas")) : [];
    const sum = (cs: HTMLCanvasElement[]) => ({ count: cs.length, area: cs.reduce((n, c) => n + c.width * c.height, 0) });
    return {
      active: st.active,
      strategy: st.strategy,
      zoom: st.zoom,
      settled: st.settled,
      dpr,
      geo: {
        backing: geo.backing,
        backW: geo.backW,
        backH: geo.backH,
        scale: geo.scale,
        displayScale: geo.displayScale,
        viewport: geo.viewport ?? null,
      },
      layer:
        scene && r
          ? {
              backW: scene.width,
              backH: scene.height,
              cssW: r.width,
              cssH: r.height,
              rect: { left: r.left, top: r.top, width: r.width, height: r.height },
              imageRendering: getComputedStyle(scene).imageRendering,
            }
          : null,
      container:
        sc && scr ? { left: scr.left, top: scr.top, width: sc.clientWidth, height: sc.clientHeight } : null,
      domCanvasCount: document.querySelectorAll("canvas").length,
      harnessCanvases: sum(own),
      // M 을 같은 조건끼리 비교하려고 갈라 센다: 활성 레이어(캐시+씬) · 비활성 정적 오버레이.
      layerCanvases: sum(own.filter((c) => !!c.closest("[data-pdf-layer]"))),
      statics: own
        .filter((c) => c.hasAttribute("data-pdf-static"))
        .map((c) => ({ page: Number(c.closest("[data-pdf-page]")?.getAttribute("data-pdf-page")), w: c.width, h: c.height })),
    };
  },
};
