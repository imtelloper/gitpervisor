// PDF 주석 오버레이 — pdf.js `.page` div 마다 React portal 로 얹는다. 배치·viewport 백킹·활성 페이지 규칙은
// M0 스파이크(S1 게이트 통과, 설계 부록 A)에서 옮겼고 페이지 박스만 pdf.js 의 것을 잰다. 게이트는 e2e 62 가 이 오버레이 위에서 다시 잰다.
//
// 좌표: 노드는 page space(pt) = pdf.js getViewport({scale:1}). 백킹 배율 k = round(cssW·dpr)/w(디바이스 px/pt),
// 화면 배율 ds = k/dpr. pdf.js 가 `.page` 폭을 round(down, …, --scale-round-x)로 정하므로 cssW·dpr 은 거의 정수고
// 차이는 오른쪽·아래 가장자리 1 디바이스 px 이하로만 남는다. 페이지 div 는 가운데 정렬이라 원점이 소수 디바이스
// px 에 놓일 수 있다 — 소수 원점은 합성기 재샘플로 1pt 선을 번지게 한다(S1 반증: 반 px 원점 = 흐림 판정).
// 그래서 호스트 안 박스를 디바이스 px 로 스냅한다(left/top 보정).
//
// pdf.js 는 버퍼 밖으로 나간 페이지·재렌더 때 `.page` 의 모르는 자식을 지운다(PDFPageView.reset) — portal 대상은
// 우리가 만든 호스트 div 이고, 렌더마다 떨어져 있으면 다시 붙인다(`.page` div 자체는 문서 수명 내내 남는다).

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { EventBus, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

import type { ChromeScreen } from "../../lib/annotate/chrome";
import { ensureAssets, imageStore } from "../../lib/annotate/imageStore";
import { renderScene } from "../../lib/annotate/render";
import { resolveScene } from "../../lib/annotate/scene";
import type { Guide } from "../../lib/annotate/snap";
import type { DefaultPaint, EditorDoc, Node } from "../../lib/annotate/types";
import type { PdfPageInfo } from "../../lib/pdf/model";
import { useImageEditorUi, type Tool } from "../../stores/imageEditor";
import AnnotationLayer, { type AnnotationLayerHandle } from "../image/AnnotationLayer";
import ChromeOverlay, { type ChromeOverlayHandle } from "../image/ChromeOverlay";

/** 보이는 영역 밖으로 더 잡는 여백(css px) — 스크롤 한 틱에 가장자리가 비지 않게. */
const VIEWPORT_MARGIN_CSS = 96;
/** 크롬 여백(css px) — 페이지 가장자리 객체의 핸들·HUD 가 SVG 경계에서 잘리지 않게. */
const CHROME_PAD = 24;
/** 좌우는 더 좁게 — pdf.js 폭 맞춤(auto·page-width)은 좌우 합쳐 SCROLLBAR_PADDING 40px 만 남겨 테두리를 빼면 한쪽 ≈19px 다.
 *  그보다 넓으면 그 여백을 넘친 만큼 주석 모드에만 가로 스크롤바가 생긴다. 핸들은 가장자리 밖으로 4px(HANDLE/2)이면 충분하다. */
const CHROME_PAD_X = 16;
/** 마지막 scalechanging 뒤 이만큼 조용하면 백킹을 새 배율로 다시 잡는다 — 휠 노치마다 씬 전량 재렌더가 돌지 않게. */
const SETTLE_MS = 150;
const NO_GUIDES: readonly Guide[] = [];
const NOOP = () => {};
const keepPos = (_axis: "x" | "y", pos: number) => pos;

type Viewport = { x: number; y: number; width: number; height: number };

interface Geo {
  /** `.page` 안쪽 박스 기준 오버레이 박스 원점(css px) — 디바이스 px 스냅 보정. */
  left: number;
  top: number;
  cssW: number;
  cssH: number;
  backW: number;
  backH: number;
  scale: number;
  displayScale: number;
  viewport: Viewport;
  /** 페이지가 보이는 영역(+여백)과 겹치는가 — 비활성 페이지 정적 오버레이의 컬링 기준. */
  visible: boolean;
  /** 백킹 크기·배율·viewport 가 같으면 같은 문자열 — viewport 참조를 안정시키고 정적 캔버스 재렌더를 거른다. */
  key: string;
}

/**
 * `.page` 안쪽 박스(client 좌표) — pdf.js 캔버스·텍스트 레이어의 기준. `.page` 는 content-box + 대칭 테두리(pdf.css)다.
 * 테두리는 계산 스타일로 읽는다: 소수 DPR 에서 Chromium 은 테두리를 디바이스 px 로 스냅하는데(DPR 1.5 에서 1px → 0.667px)
 * clientLeft·clientTop 은 정수로 반올림해 1 을 준다. 그 값을 쓰면 오버레이·포인터 환산이 pdf.js 내용에서 ⅓ css px 어긋났다
 * (e2e 62 VP-3·LC-3 실측: 400% 에서 y +0.11pt, 60% 에서 +0.82pt).
 */
export function pageInnerBox(div: HTMLElement): { left: number; top: number; width: number; height: number } {
  const r = div.getBoundingClientRect();
  const cs = getComputedStyle(div);
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const br = parseFloat(cs.borderRightWidth) || 0;
  const bb = parseFloat(cs.borderBottomWidth) || 0;
  return { left: r.left + bl, top: r.top + bt, width: r.width - bl - br, height: r.height - bt - bb };
}

function measure(div: HTMLElement, info: PdfPageInfo, c: DOMRect, dpr: number, pinned: Geo | undefined): Geo | null {
  const ib = pageInnerBox(div);
  const w = ib.width;
  if (w <= 0 || ib.height <= 0 || info.w <= 0 || info.h <= 0) return null;
  if (pinned) {
    // 줌 도중: 백킹·viewport 는 마지막 settle 값, 배치만 라이브 배율 — 엔진이 viewport × displayScale 로 놓는다.
    const ds = w / info.w;
    return { ...pinned, left: 0, top: 0, cssW: w, cssH: info.h * ds, displayScale: ds };
  }
  const ox = ib.left;
  const oy = ib.top;
  const backFull = Math.max(1, Math.round(w * dpr));
  const scale = backFull / info.w;
  const backHFull = Math.max(1, Math.round(info.h * scale));
  const ds = scale / dpr;
  const left = (Math.round(ox * dpr) - ox * dpr) / dpr;
  const top = (Math.round(oy * dpr) - oy * dpr) / dpr;
  const x0e = ox + left;
  const y0e = oy + top;
  // 보이는 영역 ∩ 페이지(+여백), 문서 단위.
  const m = VIEWPORT_MARGIN_CSS;
  const x0 = Math.max(0, (c.left - x0e - m) / ds);
  const x1 = Math.min(info.w, (c.right - x0e + m) / ds);
  const y0 = Math.max(0, (c.top - y0e - m) / ds);
  const y1 = Math.min(info.h, (c.bottom - y0e + m) / ds);
  const visible = x1 > x0 && y1 > y0;
  // 백킹 px 격자로 바깥 스냅 — backW 가 정수로 떨어지고 css 원점도 디바이스 px 에 놓인다. ±EPS 는 float32 로
  // 읽히는 scrollTop 때문에 floor/ceil 이 한 칸 튀는 것을 막는다(M0 스파이크 실측).
  const EPS = 1e-3;
  let bx0 = Math.floor(x0 * scale + EPS);
  let bx1 = Math.min(backFull, Math.ceil(x1 * scale - EPS));
  let by0 = Math.floor(y0 * scale + EPS);
  let by1 = Math.min(backHFull, Math.ceil(y1 * scale - EPS));
  // 화면 밖이면 1×1 — 0 크기 캐시를 drawImage 하면 던진다.
  if (bx1 <= bx0 || by1 <= by0) {
    bx0 = 0;
    bx1 = 1;
    by0 = 0;
    by1 = 1;
  }
  return {
    left,
    top,
    cssW: info.w * ds,
    cssH: info.h * ds,
    backW: bx1 - bx0,
    backH: by1 - by0,
    scale,
    displayScale: ds,
    viewport: { x: bx0 / scale, y: by0 / scale, width: (bx1 - bx0) / scale, height: (by1 - by0) / scale },
    visible,
    key: `${bx0},${by0},${bx1},${by1}|${backFull}`,
  };
}

const hosts = new WeakMap<Element, HTMLDivElement>();

/** `.page` 마다 하나의 호스트. pdf.js 가 떼어 냈으면 다시 붙인다(멱등이라 렌더 중에 불러도 된다). */
function hostOf(div: HTMLElement): HTMLDivElement {
  let h = hosts.get(div);
  if (!h) {
    h = document.createElement("div");
    h.setAttribute("data-pdf-overlay", "");
    h.style.position = "absolute";
    h.style.inset = "0";
    // 텍스트 레이어(z 0)·링크 레이어 위. 호스트 자체는 늘 포인터 통과 — 활성 페이지의 안쪽 박스만 받는다.
    // 호스트에 auto 를 걸면 활성이 풀린 뒤 빈 호스트가 남아 보기 모드의 텍스트 선택을 막는다.
    h.style.zIndex = "4";
    h.style.pointerEvents = "none";
    hosts.set(div, h);
  }
  if (h.parentNode !== div) div.appendChild(h);
  return h;
}

/** 이벤트가 떨어진 pdf.js 페이지 index(0부터). `.page` 의 data-page-number 는 1부터다. */
function pageIndexOf(e: Event): number | null {
  const el = (e.target as Element | null)?.closest?.(".page");
  const n = Number(el?.getAttribute("data-page-number"));
  return Number.isInteger(n) && n >= 1 ? n - 1 : null;
}

export interface PdfAnnotateOverlayProps {
  viewer: PDFViewer;
  bus: EventBus;
  container: HTMLDivElement;
  infos: readonly PdfPageInfo[];
  pages: readonly EditorDoc[];
  active: number;
  /** 주석 모드 — 아니면 정적 캔버스만, 포인터 통과. */
  interactive: boolean;
  tool: Tool;
  paint: DefaultPaint;
  opacity: number;
  layerRef: RefObject<AnnotationLayerHandle | null>;
  onCommit: (page: number, nodes: Node[]) => void;
  /** 활성 페이지 전환 요청(가드·확정은 호출부 몫). */
  onActivate: (page: number) => void;
}

export default function PdfAnnotateOverlay(p: PdfAnnotateOverlayProps) {
  const { viewer, bus, container } = p;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const settled = useRef(new Map<number, Geo>());
  const zooming = useRef(false);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    let raf = 0;
    let timer: number | undefined;
    const later = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          bump();
        });
    };
    const on = (name: string, fn: () => void) => bus.on(name, fn, { signal });
    // pagerender 는 reset(호스트 떼어 냄) 뒤 draw() 에서 나간다 — 다시 붙일 계기다.
    on("pagesinit", later);
    on("pagerender", later);
    on("pagerendered", later);
    on("scalechanging", () => {
      zooming.current = true;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        zooming.current = false;
        bump();
      }, SETTLE_MS);
      later();
    });
    container.addEventListener("scroll", later, { passive: true, signal });
    window.addEventListener("resize", later, { signal }); // DPR 변경(창을 다른 모니터로)
    const ro = new ResizeObserver(later);
    ro.observe(container);
    return () => {
      ac.abort();
      ro.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [bus, container]);

  // 활성 전환·손 팬은 컨테이너 한 곳에서 받는다 — 노드 없는 페이지에는 호스트가 없어서 페이지마다 달 수 없다.
  useEffect(() => {
    const ac = new AbortController();
    const { signal } = ac;
    let pan: { x: number; y: number } | null = null;
    // ① 이동: 버튼을 누르지 않았고 텍스트 입력 중이 아닐 때만(긋던 선이 다른 레이어로 끊기지 않게).
    //    enter 만 보면 가드가 풀린 뒤 포인터가 나갔다 들어올 때까지 그 페이지가 영영 활성이 안 된다 — move 로 본다.
    container.addEventListener(
      "pointermove",
      (e) => {
        if (pan) {
          container.scrollLeft -= e.clientX - pan.x;
          container.scrollTop -= e.clientY - pan.y;
          pan = { x: e.clientX, y: e.clientY };
          return;
        }
        const s = latest.current;
        if (!s.interactive || e.buttons !== 0) return;
        const i = pageIndexOf(e);
        if (i === null || i === s.active || useImageEditorUi.getState().textEditing) return;
        s.onActivate(i);
      },
      { signal },
    );
    // ② 누름(capture): 가드에 막혀 비활성으로 남은 페이지를 누르면 곧바로 활성으로. 누른 제스처 자체는 새 레이어로
    //    가지 않는다(활성화와 텍스트 확정이 그 클릭의 몫) — 이벤트 대상은 이미 정해진 pdf.js 캔버스다.
    container.addEventListener(
      "pointerdown",
      (e) => {
        const s = latest.current;
        if (!s.interactive || e.button !== 0) return;
        const i = pageIndexOf(e);
        if (i !== null && i !== s.active) s.onActivate(i);
      },
      { capture: true, signal },
    );
    // ③ 팬: 가운데 버튼, 손 도구 좌버튼. 레이어는 손 도구 pointerdown 을 잡지 않고 버블시킨다(annotation/pointer.ts).
    container.addEventListener(
      "pointerdown",
      (e) => {
        const s = latest.current;
        if (!s.interactive || !(e.button === 1 || (e.button === 0 && s.tool === "hand"))) return;
        e.preventDefault(); // 가운데 버튼 오토스크롤 · 드래그 중 텍스트 선택 차단
        pan = { x: e.clientX, y: e.clientY };
        container.setPointerCapture(e.pointerId);
      },
      { signal },
    );
    const end = (e: PointerEvent) => {
      if (!pan) return;
      pan = null;
      if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
    };
    container.addEventListener("pointerup", end, { signal });
    container.addEventListener("pointercancel", end, { signal });
    return () => ac.abort();
  }, [container]);

  const dpr = window.devicePixelRatio || 1;
  const c = container.getBoundingClientRect();
  const n = Math.min(p.infos.length, p.pages.length, viewer.pagesCount);
  const out: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const isActive = p.interactive && i === p.active;
    const doc = p.pages[i];
    if (!isActive && doc.objects.length === 0) continue;
    const div = viewer.getPageView(i)?.div as HTMLDivElement | undefined;
    if (!div) continue;
    const g = measure(div, p.infos[i], c, dpr, zooming.current ? settled.current.get(i) : undefined);
    if (!g) continue;
    if (!zooming.current) settled.current.set(i, g);
    // 화면(+여백) 밖 비활성 페이지는 캔버스를 두지 않는다(LC-4 컬링).
    if (!isActive && !g.visible) continue;
    const host = hostOf(div);
    out.push(
      createPortal(
        <div
          data-pdf-overlay-page={i}
          className="absolute"
          style={{ left: g.left, top: g.top, width: g.cssW, height: g.cssH, pointerEvents: isActive ? "auto" : "none" }}
        >
          {isActive ? (
            <ActiveLayer
              page={i}
              doc={doc}
              info={p.infos[i]}
              geo={g}
              tool={p.tool}
              paint={p.paint}
              opacity={p.opacity}
              layerRef={p.layerRef}
              onCommit={p.onCommit}
            />
          ) : (
            <StaticOverlay doc={doc} geo={g} />
          )}
        </div>,
        host,
        `pdf-ov-${i}`,
      ),
    );
  }
  return <>{out}</>;
}

function ActiveLayer({
  page,
  doc,
  info,
  geo,
  tool,
  paint,
  opacity,
  layerRef,
  onCommit,
}: {
  page: number;
  doc: EditorDoc;
  info: PdfPageInfo;
  geo: Geo;
  tool: Tool;
  paint: DefaultPaint;
  opacity: number;
  layerRef: RefObject<AnnotationLayerHandle | null>;
  onCommit: (page: number, nodes: Node[]) => void;
}) {
  const selected = useImageEditorUi((s) => s.selectedIds);
  const chromeRef = useRef<ChromeOverlayHandle>(null);
  // rulers·pixelGrid 는 이미지 편집기와 공유하는 영속 토글이다 — 거기서 켠 눈금자가 PDF 에 새지 않게 덮는다.
  const chromeTap = useRef<ChromeOverlayHandle>({
    update: (s) => chromeRef.current?.update({ ...s, rulers: false, pixelGrid: false }),
  });
  // bounds 참조가 바뀌면 레이어가 매번 다시 그린다 — 값으로 고정한다.
  const bounds = useMemo(() => ({ width: info.w, height: info.h }), [info.w, info.h]);
  const scene = useMemo(() => resolveScene(doc), [doc]);
  const store = useMemo(() => imageStore(doc), [doc]);
  const assetsVer = useAssetsVer(doc);
  const selectedIds = useMemo(() => selected.filter((id) => id !== "__base"), [selected]);
  // viewport 는 레이어 다시 그리기 effect 의 의존성이다 — 값이 같으면 참조도 같아야 한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const viewport = useMemo(() => geo.viewport, [geo.key]);
  const screen = useMemo<ChromeScreen>(
    () => ({
      scale: geo.displayScale,
      x: CHROME_PAD_X,
      y: CHROME_PAD,
      w: geo.cssW + 2 * CHROME_PAD_X,
      h: geo.cssH + 2 * CHROME_PAD,
      ow: info.w,
      oh: info.h,
    }),
    [geo.displayScale, geo.cssW, geo.cssH, info.w, info.h],
  );
  const ui = useImageEditorUi.getState(); // 액션만 쓴다(참조가 안 바뀐다)

  return (
    <>
      <div data-pdf-layer className="absolute inset-0">
        <AnnotationLayer
          ref={layerRef}
          backing="display"
          bounds={bounds}
          viewport={viewport}
          backW={geo.backW}
          backH={geo.backH}
          scale={geo.scale}
          displayScale={geo.displayScale}
          filterStr="none"
          objects={doc.objects}
          store={store}
          assetsVer={assetsVer}
          scene={scene}
          chrome={chromeTap}
          screen={screen}
          guides={NO_GUIDES}
          onGuidesChange={NOOP}
          selectedIds={selectedIds}
          tool={tool}
          style={paint}
          opacity={opacity}
          cropMode={false}
          cropRect={null}
          onCropDown={NOOP}
          onCropMove={NOOP}
          onCropUp={NOOP}
          onCropCancel={NOOP}
          // 렌더 시점 페이지에 묶는다 — 호출 시점 active 를 읽으면 전환 도중 확정이 다른 페이지로 간다.
          onCommit={(next) => onCommit(page, next)}
          onEditingChange={ui.setTextEditing}
          onToolChange={ui.setTool}
          onSelectionChange={ui.select}
        />
      </div>
      <div className="pointer-events-none absolute" style={{ inset: `${-CHROME_PAD}px ${-CHROME_PAD_X}px` }}>
        <ChromeOverlay ref={chromeRef} onGuideCommit={NOOP} snapForGuide={keepPos} />
      </div>
    </>
  );
}

/** 이미지 에셋 디코드가 끝나면 오른다 — 첫 그림은 회색 자리표시라 한 번 다시 그려야 한다(이미지 편집기와 같은 규칙). */
function useAssetsVer(doc: EditorDoc): number {
  const [ver, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => {
    let alive = true;
    void ensureAssets(doc).then(() => alive && bump());
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.assets]);
  return ver;
}

/** 비활성 페이지의 정적 오버레이 — 활성 레이어와 같은 변환 규칙, 포인터 없음. */
function StaticOverlay({ doc, geo }: { doc: EditorDoc; geo: Geo }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const v = geo.viewport;
  const assetsVer = useAssetsVer(doc);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    cv.width = geo.backW; // 대입이 곧 초기화다
    cv.height = geo.backH;
    renderScene(
      cv.getContext("2d")!,
      resolveScene(doc),
      { tx: -v.x, ty: -v.y, sx: geo.scale, sy: geo.scale },
      { background: "transparent", store: imageStore(doc) },
    );
    // geo.key 가 백킹 크기·배율·viewport 를 전부 담는다 — 줌 도중(settle 전)에는 다시 그리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, geo.key, assetsVer]);
  const ds = geo.displayScale;
  return (
    <canvas
      ref={ref}
      aria-hidden
      data-pdf-static
      className="pointer-events-none absolute"
      style={{ left: v.x * ds, top: v.y * ds, width: v.width * ds, height: v.height * ds }}
    />
  );
}
