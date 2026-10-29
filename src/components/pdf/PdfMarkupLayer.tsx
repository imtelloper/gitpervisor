// 텍스트 마크업 화면(M3 T1) + 마크업·서명 도구 버튼 — 마크업은 노드 트리 밖이라 annotate 엔진이 아니라 여기서 그린다.
//
// 그리기: `.page` 마다 SVG 한 장(viewBox = page space)을 portal 로 얹는다. viewBox 가 배율을 따라가므로 줌·스크롤에 다시 잴 것이
// 없다. 호스트는 mix-blend-mode multiply — 하이라이트가 글자를 덮지 않고 저장본 AP(/BM /Multiply)와 같은 모양이 된다.
// 입력: 마크업 도구일 때 PdfView 가 오버레이를 비활성으로 두고 텍스트 레이어에 포인터를 돌려준다(pdf.css data-pdf-markup).
// 끌어 선택 → pointerup 에 선택 범위의 글자 사각형 → 줄마다 합친 quad. 끌지 않은 클릭은 마크업 선택(hit-test) —
// 선택 도구에서도 노드를 맞히지 못한 클릭이면 마크업을 고른다.
// 서명 놓기 대기 중이면 누른 자리를 캡처 단계에서 가로채 페이지 좌표로 넘긴다.

import { useEffect, useReducer, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Highlighter, Signature, Strikethrough, Underline } from "lucide-react";
import type { EventBus, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

import { useMessages } from "../../i18n/ui-language";
import { newObjId } from "../../lib/annotate/types";
import type { AssetBytes } from "../../lib/ipc";
import {
  hitMarkup,
  MARKUP_DEFAULT_COLOR,
  MARKUP_LINE_AT,
  MARKUP_LINE_WIDTH,
  mergeLineRects,
  quadBoxes,
  quadsOfRects,
  type MarkupSubtype,
  type PageRect,
} from "../../lib/pdf/markup";
import type { PdfMarkup, PdfPageInfo } from "../../lib/pdf/model";
import { pageInnerBox } from "./PdfAnnotateOverlay";

const hosts = new WeakMap<Element, HTMLDivElement>();

function hostOf(div: HTMLElement): HTMLDivElement {
  let h = hosts.get(div);
  if (!h) {
    h = document.createElement("div");
    h.setAttribute("data-pdf-markups", "");
    h.style.position = "absolute";
    h.style.inset = "0";
    // 텍스트 레이어 위·주석 오버레이(z 4) 아래. 포인터는 늘 통과 — 선택은 텍스트 레이어가, hit-test 는 컨테이너가 받는다.
    h.style.zIndex = "3";
    h.style.pointerEvents = "none";
    h.style.mixBlendMode = "multiply";
    hosts.set(div, h);
  }
  // pdf.js 는 재렌더(reset) 때 `.page` 의 모르는 자식을 떼어 낸다 — 렌더마다 다시 붙인다(PdfAnnotateOverlay 와 같다).
  if (h.parentNode !== div) div.appendChild(h);
  return h;
}

/** `.page` div 안쪽 박스 기준 client → page space. */
function toPageSpace(div: HTMLElement, info: PdfPageInfo) {
  const r = div.getBoundingClientRect();
  const ib = pageInnerBox(div); // 스냅된 테두리 — clientLeft 는 정수라 쓰지 않는다(pageInnerBox 주석)
  const ds = ib.width / info.w;
  return { ds, x: (cx: number) => (cx - ib.left) / ds, y: (cy: number) => (cy - ib.top) / ds, r };
}

function pageIndexOfNode(n: Node | null): number | null {
  const el = n instanceof Element ? n : n?.parentElement;
  const num = Number(el?.closest(".page")?.getAttribute("data-page-number"));
  return Number.isInteger(num) && num >= 1 ? num - 1 : null;
}

/** 선택 범위 안 **텍스트 레이어 글자**의 client 사각형만 — 범위의 getClientRects 는 통째로 든 요소(텍스트 레이어 div 자체)의 상자까지 준다. */
function selectionTextRects(range: Range): DOMRect[] {
  const out: DOMRect[] = [];
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root.nodeType === 3 ? root.parentNode ?? root : root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n) || !n.parentElement?.closest(".textLayer")) continue;
    const sub = document.createRange();
    sub.selectNodeContents(n);
    if (n === range.startContainer) sub.setStart(n, range.startOffset);
    if (n === range.endContainer) sub.setEnd(n, range.endOffset);
    out.push(...sub.getClientRects());
  }
  return out;
}

/** 지금 보이는 부분의 가운데(page space) — 이미지를 화면 밖에 놓지 않게. */
export function visibleCenter(viewer: PDFViewer, container: HTMLElement, info: PdfPageInfo, page: number) {
  const div = viewer.getPageView(page)?.div as HTMLElement | undefined;
  if (!div) return { x: info.w / 2, y: info.h / 2 };
  const p = toPageSpace(div, info);
  const c = container.getBoundingClientRect();
  const x0 = Math.max(0, p.x(c.left));
  const x1 = Math.min(info.w, p.x(c.right));
  const y0 = Math.max(0, p.y(c.top));
  const y1 = Math.min(info.h, p.y(c.bottom));
  return x1 > x0 && y1 > y0 ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : { x: info.w / 2, y: info.h / 2 };
}

/**
 * PDF 에 넣을 수 있는 형식(PNG·JPEG)으로 — 그 밖(WebP·GIF·BMP…)은 캔버스로 한 번 그려 PNG 로 바꾼다(write.ts 는 둘만 임베드한다).
 */
export async function toPdfImageBytes(src: AssetBytes): Promise<AssetBytes> {
  if (src.mime === "image/png" || src.mime === "image/jpeg") return src;
  const img = new Image();
  img.src = `data:${src.mime};base64,${src.base64}`;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.getContext("2d")!.drawImage(img, 0, 0);
  return { mime: "image/png", base64: cv.toDataURL("image/png").slice("data:image/png;base64,".length) };
}

export async function fileToAssetBytes(file: File): Promise<AssetBytes> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: file.type, base64: btoa(s) };
}

export function MarkupShape({ m, selected }: { m: PdfMarkup; selected: boolean }) {
  const q = m.quads;
  const parts: ReactNode[] = [];
  for (let i = 0; i + 7 < q.length; i += 8) {
    if (m.subtype === "Highlight") {
      parts.push(
        <polygon
          key={i}
          points={`${q[i]},${q[i + 1]} ${q[i + 2]},${q[i + 3]} ${q[i + 6]},${q[i + 7]} ${q[i + 4]},${q[i + 5]}`}
          fill={m.color}
          fillOpacity={m.opacity}
        />,
      );
    } else {
      const t = MARKUP_LINE_AT[m.subtype];
      const h = Math.hypot(q[i + 4] - q[i], q[i + 5] - q[i + 1]);
      parts.push(
        <line
          key={i}
          x1={q[i] + (q[i + 4] - q[i]) * t}
          y1={q[i + 1] + (q[i + 5] - q[i + 1]) * t}
          x2={q[i + 2] + (q[i + 6] - q[i + 2]) * t}
          y2={q[i + 3] + (q[i + 7] - q[i + 3]) * t}
          stroke={m.color}
          strokeOpacity={m.opacity}
          strokeWidth={Math.max(0.5, h * MARKUP_LINE_WIDTH)}
        />,
      );
    }
  }
  return (
    <g data-pdf-markup-id={m.id} data-pdf-markup-subtype={m.subtype}>
      {parts}
      {selected &&
        quadBoxes(q).map((b, i) => (
          <rect
            key={`s${i}`}
            x={b.x0 - 1}
            y={b.y0 - 1}
            width={b.x1 - b.x0 + 2}
            height={b.y1 - b.y0 + 2}
            fill="none"
            stroke="#0A84FF"
            strokeWidth={1.5}
            strokeDasharray="4 2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
    </g>
  );
}

export interface PdfMarkupLayerProps {
  viewer: PDFViewer;
  bus: EventBus;
  container: HTMLDivElement;
  infos: readonly PdfPageInfo[];
  markups: readonly PdfMarkup[];
  selectedId: string | null;
  /** 마크업 도구 — null 이면 그리기만 한다. */
  tool: MarkupSubtype | null;
  /** 서명 놓기 대기 중. */
  placing: boolean;
  /** 선택 도구 — 노드를 맞히지 못한 클릭이 마크업을 고른다(onPick). */
  pick: boolean;
  onAdd: (ms: PdfMarkup[]) => void;
  onSelect: (id: string | null) => void;
  onPick: (id: string | null) => void;
  onPlace: (page: number, x: number, y: number) => void;
}

export default function PdfMarkupLayer(p: PdfMarkupLayerProps) {
  const { viewer, bus, container } = p;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const ac = new AbortController();
    for (const name of ["pagesinit", "pagerender", "pagerendered"]) bus.on(name, bump, { signal: ac.signal });
    return () => ac.abort();
  }, [bus]);

  // 마크업 도구: 끌어 선택 → quad, 클릭 → 선택.
  useEffect(() => {
    if (!p.tool) return;
    const ac = new AbortController();
    container.addEventListener(
      "pointerup",
      (e) => {
        const s = latest.current;
        if (!s.tool || e.button !== 0) return;
        const sel = document.getSelection();
        if (sel && !sel.isCollapsed && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          const a = pageIndexOfNode(range.startContainer);
          const b = pageIndexOfNode(range.endContainer);
          const n = Math.min(s.infos.length, viewer.pagesCount);
          const lo = Math.max(0, Math.min(a ?? 0, b ?? 0));
          const hi = Math.min(n - 1, Math.max(a ?? n - 1, b ?? n - 1));
          const rects = selectionTextRects(range);
          const out: PdfMarkup[] = [];
          for (let i = lo; i <= hi; i++) {
            const div = viewer.getPageView(i)?.div as HTMLElement | undefined;
            if (!div) continue;
            const ps = toPageSpace(div, s.infos[i]);
            const mine: PageRect[] = rects
              .filter((r) => {
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                return cx >= ps.r.left && cx <= ps.r.right && cy >= ps.r.top && cy <= ps.r.bottom;
              })
              .map((r) => ({ x0: ps.x(r.left), y0: ps.y(r.top), x1: ps.x(r.right), y1: ps.y(r.bottom) }));
            const lines = mergeLineRects(mine);
            if (!lines.length) continue;
            out.push({
              id: newObjId(),
              pageKey: s.infos[i].key,
              subtype: s.tool,
              quads: quadsOfRects(lines),
              color: MARKUP_DEFAULT_COLOR[s.tool],
              opacity: 1,
            });
          }
          sel.removeAllRanges();
          if (out.length) s.onAdd(out);
          return;
        }
        const i = pageIndexOfNode(e.target instanceof globalThis.Node ? e.target : null);
        const div = i === null ? undefined : (viewer.getPageView(i)?.div as HTMLElement | undefined);
        if (i === null || !div || !s.infos[i]) return s.onSelect(null);
        const ps = toPageSpace(div, s.infos[i]);
        const hit = hitMarkup(s.markups, s.infos[i].key, ps.x(e.clientX), ps.y(e.clientY), 3 / ps.ds);
        s.onSelect(hit?.id ?? null);
      },
      { signal: ac.signal },
    );
    return () => ac.abort();
  }, [p.tool, container, viewer]);

  // 선택 도구: 주석 레이어가 누름을 먼저 처리(노드 선택·해제)한 **뒤에** 마크업을 맞혀 본다 — 노드가 위라 노드가 이긴다(onPick 이 거른다).
  useEffect(() => {
    if (!p.pick) return;
    const ac = new AbortController();
    let down: { x: number; y: number } | null = null;
    container.addEventListener("pointerdown", (e) => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null), {
      capture: true,
      signal: ac.signal,
    });
    container.addEventListener(
      "pointerup",
      (e) => {
        const d = down;
        down = null;
        // 끌기(이동·영역 선택)는 클릭이 아니다.
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 3) return;
        const i = pageIndexOfNode(e.target instanceof globalThis.Node ? e.target : null);
        const { clientX, clientY } = e;
        setTimeout(() => {
          const s = latest.current;
          const div = i === null ? undefined : (viewer.getPageView(i)?.div as HTMLElement | undefined);
          if (!s.pick || i === null || !div || !s.infos[i]) return s.onPick(null);
          const ps = toPageSpace(div, s.infos[i]);
          s.onPick(hitMarkup(s.markups, s.infos[i].key, ps.x(clientX), ps.y(clientY), 3 / ps.ds)?.id ?? null);
        }, 0);
      },
      { capture: true, signal: ac.signal },
    );
    return () => ac.abort();
  }, [p.pick, container, viewer]);

  // 서명 놓기: 캡처 단계에서 가로채 레이어가 그 누름을 그리기로 받지 않게.
  useEffect(() => {
    if (!p.placing) return;
    const ac = new AbortController();
    const prevCursor = container.style.cursor;
    container.style.cursor = "crosshair";
    container.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;
        const s = latest.current;
        const i = pageIndexOfNode(e.target instanceof globalThis.Node ? e.target : null);
        const div = i === null ? undefined : (viewer.getPageView(i)?.div as HTMLElement | undefined);
        if (i === null || !div || !s.infos[i]) return;
        e.preventDefault();
        e.stopPropagation();
        const ps = toPageSpace(div, s.infos[i]);
        s.onPlace(i, ps.x(e.clientX), ps.y(e.clientY));
      },
      { capture: true, signal: ac.signal },
    );
    return () => {
      ac.abort();
      container.style.cursor = prevCursor;
    };
  }, [p.placing, container, viewer]);

  const byKey = new Map<string, PdfMarkup[]>();
  for (const m of p.markups) byKey.set(m.pageKey, [...(byKey.get(m.pageKey) ?? []), m]);
  const out: ReactNode[] = [];
  const n = Math.min(p.infos.length, viewer.pagesCount);
  for (let i = 0; i < n; i++) {
    const info = p.infos[i];
    const ms = byKey.get(info.key);
    if (!ms) continue;
    const div = viewer.getPageView(i)?.div as HTMLElement | undefined;
    if (!div) continue;
    out.push(
      createPortal(
        <svg
          data-pdf-markup-page={i}
          viewBox={`0 0 ${info.w} ${info.h}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
        >
          {ms.map((m) => (
            <MarkupShape key={m.id} m={m} selected={m.id === p.selectedId} />
          ))}
        </svg>,
        hostOf(div),
        `pdf-mk-${info.key}`,
      ),
    );
  }
  return <>{out}</>;
}

const MARKUP_ICONS = { Highlight: Highlighter, Underline, StrikeOut: Strikethrough } as const;

/** 레일 옆 도구 칸 — ToolRail 은 이미지 편집기 Tool 만 받으므로 마크업·서명은 여기 둔다. */
export function PdfMarkupTools({
  tool,
  placing,
  onTool,
  onSignature,
}: {
  tool: MarkupSubtype | null;
  placing: boolean;
  onTool: (t: MarkupSubtype | null) => void;
  onSignature: () => void;
}) {
  const t = useMessages().pdf.markup;
  const label: Record<MarkupSubtype, string> = { Highlight: t.highlight, Underline: t.underline, StrikeOut: t.strikeOut };
  const btn = (on: boolean) =>
    `flex h-8 w-8 items-center justify-center rounded ${on ? "bg-raised text-accent" : "text-fg-dim hover:bg-raised hover:text-fg"}`;
  return (
    <div role="group" aria-label={t.group} data-pdf-markup-tools className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-edge bg-panel py-2">
      {(Object.keys(MARKUP_ICONS) as MarkupSubtype[]).map((k) => {
        const Icon = MARKUP_ICONS[k];
        return (
          <button key={k} data-pdf-markup-tool={k} title={label[k]} aria-pressed={tool === k} onClick={() => onTool(tool === k ? null : k)} className={btn(tool === k)}>
            <Icon size={16} />
          </button>
        );
      })}
      <div className="my-1 h-px w-6 bg-edge" />
      <button data-pdf-signature-tool title={t.signature} aria-pressed={placing} onClick={onSignature} className={btn(placing)}>
        <Signature size={16} />
      </button>
    </div>
  );
}
