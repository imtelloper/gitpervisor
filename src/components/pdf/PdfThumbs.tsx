// PDF 사이드바 썸네일 — pdf.js 는 PDFThumbnailViewer 를 export 하지 않아 직접 그린다.
//
// 캔버스는 리스트에서 보이는 항목 ±200px 에만 둔다(IntersectionObserver 하나). 200쪽 문서의 썸네일을
// 상시 두면 인스턴스(최대 5개)마다 수십 MB 가 되고, e2e C6 의 페이지 캔버스 계수와도 섞인다.
//
// doc 은 메인 뷰어와 공유한다 — page.cleanup()·doc.destroy() 금지. 대신 다 그린 페이지를 onRendered 로 알려
// PdfView 가 pdf.js 'thumbnailrendered' 를 쏘게 한다(메인 버퍼 밖 페이지만 PDFViewer 가 치운다). 재로드는 PdfView 가 key 로
// 리마운트하지만, 그 사이 옛 doc 이 destroy 되면 getPage·render 가 'Transport destroyed' 류로 reject
// 한다. 그래서 reject 는 전부 삼키고, 세대가 바뀐 뒤(언마운트·doc 변경) 도착한 결과는 버린다.

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfThumbsProps {
  doc: PDFDocumentProxy;
  currentPage: number;
  onGoto(page: number): void;
  /** 썸네일 렌더 완료 — 이 페이지의 오퍼레이터 리스트·디코드 이미지를 치워도 되는지는 받는 쪽(메인 뷰어)이 정한다. */
  onRendered?(page: number, pdfPage: PDFPageProxy): void;
}

const THUMB_W = 112; // CSS px

export default function PdfThumbs({ doc, currentPage, onGoto, onRendered }: PdfThumbsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // effect 는 [doc] 에만 걸린다 — 콜백 신원이 매 렌더 바뀌어도 IO 를 다시 만들지 않게 ref 로 읽는다.
  const renderedRef = useRef(onRendered);
  renderedRef.current = onRendered;
  const genRef = useRef(0);
  // 박스 비율(h/w) — 첫 페이지 기준, 페이지별 크기 차이는 무시. 도착 전엔 A4.
  const [ratio, setRatio] = useState(Math.SQRT2);

  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const gen = ++genRef.current;
    const stale = () => gen !== genRef.current;
    const live = new Map<number, { canvas: HTMLCanvasElement; task: RenderTask | null }>();

    doc.getPage(1).then(
      (p) => {
        if (stale()) return;
        const v = p.getViewport({ scale: 1 });
        setRatio(v.height / v.width);
      },
      () => {},
    );

    const release = (n: number) => {
      const slot = live.get(n);
      if (!slot) return;
      live.delete(n);
      slot.task?.cancel();
      slot.canvas.width = slot.canvas.height = 0;
      slot.canvas.remove();
    };

    const attach = async (n: number, box: HTMLElement) => {
      if (live.has(n)) return;
      const canvas = document.createElement("canvas");
      canvas.setAttribute("data-pdf-thumb-canvas", "");
      const slot = { canvas, task: null as RenderTask | null };
      live.set(n, slot);
      try {
        const page = await doc.getPage(n);
        // 기다리는 사이 해제됐거나(스크롤 아웃) 세대가 바뀌었으면 버린다
        if (stale() || live.get(n) !== slot) return;
        const vp = page.getViewport({ scale: THUMB_W / page.getViewport({ scale: 1 }).width });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        box.appendChild(canvas);
        slot.task = page.render({
          canvas,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        await slot.task.promise;
        slot.task = null; // 끝난 task 를 release 에서 다시 cancel 하지 않게(공유 intentState 에 abort 가 흘러간다)
        if (!stale()) renderedRef.current?.(n, page);
      } catch {
        // RenderingCancelledException·Transport destroyed 등 — 전부 무시(미처리 거부로 로그를 더럽히지 않게)
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const n = Number(el.dataset.pdfThumb);
          if (e.isIntersecting) void attach(n, el.firstElementChild as HTMLElement);
          else release(n);
        }
      },
      { root, rootMargin: "200px 0px" },
    );
    root.querySelectorAll("[data-pdf-thumb]").forEach((el) => io.observe(el));

    return () => {
      genRef.current++;
      io.disconnect();
      for (const n of [...live.keys()]) release(n);
    };
  }, [doc]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-pdf-thumb="${currentPage}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [currentPage]);

  return (
    <div ref={listRef} data-pdf-thumbs className="h-full overflow-auto p-2">
      {Array.from({ length: doc.numPages }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          data-pdf-thumb={n}
          aria-current={n === currentPage ? "page" : undefined}
          onClick={() => onGoto(n)}
          className={`mx-auto mb-2 flex flex-col items-center gap-1 rounded p-1 hover:bg-raised ${
            n === currentPage ? "ring-1 ring-accent" : ""
          }`}
        >
          {/* 캔버스는 IO 가 명령형으로 붙인다 — React 자식을 두지 않는다 */}
          <div className="overflow-hidden bg-white" style={{ width: THUMB_W, height: THUMB_W * ratio }} />
          <span className="text-[11px] text-fg-dim">{n}</span>
        </button>
      ))}
    </div>
  );
}
