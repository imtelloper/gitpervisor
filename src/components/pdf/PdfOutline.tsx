// PDF 사이드바 목차(/Outlines). 클릭은 dest → onDest, 없으면 url → onUrl, 둘 다 없으면 무반응.
// unsafeUrl·action·attachment 는 읽지도 않는다(§8.4) — 아래 OutlineNode 가 그 필드를 타입에서 뺀다.

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfOutlineProps {
  doc: PDFDocumentProxy;
  onDest(dest: string | unknown[]): void;
  onUrl(url: string): void;
}

type RawNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];
type OutlineNode = Pick<RawNode, "title" | "bold" | "italic" | "dest" | "url" | "count"> & {
  items: OutlineNode[];
};

export default function PdfOutline({ doc, onDest, onUrl }: PdfOutlineProps) {
  // undefined = 받는 중, null = 없음(목차 없음·실패)
  const [outline, setOutline] = useState<OutlineNode[] | null | undefined>(undefined);

  useEffect(() => {
    let dead = false;
    // 타입은 배열이지만 목차가 없으면 null 이 온다
    doc.getOutline().then(
      (o) => {
        if (!dead) setOutline((o as OutlineNode[] | null) ?? null);
      },
      () => {
        if (!dead) setOutline(null);
      },
    );
    return () => {
      dead = true;
    };
  }, [doc]);

  if (outline === undefined) return null;
  if (!outline || outline.length === 0) {
    return (
      <div data-pdf-outline-empty className="p-3 text-xs text-fg-dim">
        목차가 없습니다
      </div>
    );
  }
  return (
    <div data-pdf-outline className="h-full overflow-auto p-2 text-xs">
      <OutlineList items={outline} onDest={onDest} onUrl={onUrl} />
    </div>
  );
}

type Callbacks = Pick<PdfOutlineProps, "onDest" | "onUrl">;

function OutlineList({ items, ...cb }: Callbacks & { items: OutlineNode[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        <OutlineItem key={i} item={item} {...cb} />
      ))}
    </ul>
  );
}

function OutlineItem({ item, onDest, onUrl }: Callbacks & { item: OutlineNode }) {
  // count < 0 이면 작성자가 접어 둔 항목
  const [open, setOpen] = useState(item.count === undefined || item.count >= 0);
  const hasKids = item.items.length > 0;
  return (
    <li>
      <div className="flex items-center gap-0.5 rounded py-0.5 pr-1 hover:bg-raised">
        {hasKids ? (
          <button
            data-pdf-outline-toggle
            aria-expanded={open}
            aria-label={open ? "접기" : "펼치기"}
            onClick={() => setOpen(!open)}
            className="shrink-0 text-fg-dim hover:text-fg"
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <button
          data-pdf-outline-item
          title={item.title}
          onClick={() => {
            if (item.dest) onDest(item.dest);
            else if (item.url) onUrl(item.url);
          }}
          className={`min-w-0 flex-1 truncate text-left text-fg-muted hover:text-fg${
            item.bold ? " font-semibold" : ""
          }${item.italic ? " italic" : ""}`}
        >
          {item.title}
        </button>
      </div>
      {hasKids && open && (
        <div className="pl-3">
          <OutlineList items={item.items} onDest={onDest} onUrl={onUrl} />
        </div>
      )}
    </li>
  );
}
