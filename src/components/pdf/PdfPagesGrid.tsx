// PDF 페이지 모드(M4, DOCS/task/75 T6) — 연산 뒤 순서의 썸네일 그리드. 여기서는 연산을 만들기만 하고(onOp)
// 적용·undo·저장은 PdfView 세션이 한다.
//
// 썸네일은 연산 **전** 표시 문서(doc = 작업 사본)에서 그린다 — 페이지 모드 동안 pdf.js 를 다시 싣지 않는다(설계 §12 M4:
// 모드를 나갈 때 한 번). 회전은 viewport rotation 으로, 다른 PDF 페이지는 그 소스를 따로 열어 그린다.
// pages.ts 는 `import type` 만 — 런타임은 PdfView 의 늦은 코어 청크에 있다(보기 전용 사용자가 받지 않게).

import { Copy, FileInput, FileOutput, FilePlus, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";

import { useMessages } from "../../i18n/ui-language";
import { ensureAssets, imageStore } from "../../lib/annotate/imageStore";
import { renderScene } from "../../lib/annotate/render";
import { resolveScene } from "../../lib/annotate/scene";
import type { EditorDoc } from "../../lib/annotate/types";
import { errorMessage, ipc } from "../../lib/ipc";
import type { PageOp, PdfMarkup, PdfPageInfo } from "../../lib/pdf/model";
import type { PageSlot, PdfSource } from "../../lib/pdf/pages";
import { loadPdfjs } from "../../lib/pdf/pdfjs";
import { isMod } from "../../lib/platform";
import { useUi } from "../../stores/ui";
import { QuickPick, type QuickPickItem } from "../common/QuickPick";
import { MarkupShape } from "./PdfMarkupLayer";

export interface PdfPagesGridProps {
  /** 연산 전 표시 문서 — `baseKeys[i]` 가 그 i+1 쪽이다. */
  doc: PDFDocumentProxy;
  baseKeys: readonly string[];
  /** 연산 뒤 순서(replayPageOps). `infos` 와 같은 순서·key. */
  slots: readonly PageSlot[];
  infos: readonly PdfPageInfo[];
  /** 연산 뒤 순서의 편집 노드·마크업 — 썸네일은 연산 전 문서에서 그리므로 우리 주석은 그 위에 따로 얹는다. */
  pages: readonly EditorDoc[];
  markups: readonly PdfMarkup[];
  projectId: string;
  onOp(op: PageOp, inserted?: PdfPageInfo[]): void;
  onExtract(keys: string[]): void;
  onUndo(): void;
  onRedo(): void;
}

const NO_MARKUPS: readonly PdfMarkup[] = [];
const BOX = 150; // 썸네일 칸(CSS px) — 페이지는 이 안에 비율대로 맞춘다
const newKey = () => `new:${crypto.randomUUID()}`;
const srcId = (s: PdfSource) => `${s.projectId}\0${s.relPath}`;

type OpenSource = (s: PdfSource) => Promise<PDFDocumentProxy>;

function PageThumb({
  slot,
  info,
  doc,
  baseIndex,
  openSource,
  page,
  markups,
}: {
  slot: PageSlot;
  info: PdfPageInfo;
  doc: PDFDocumentProxy;
  baseIndex: number;
  openSource: OpenSource;
  page: EditorDoc;
  markups: readonly PdfMarkup[];
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const fit = Math.min(BOX / info.w, BOX / info.h);
  const src = slot.src;
  // slot 객체는 렌더마다 새로 만들어진다 — effect 는 원시 값으로만 다시 돈다.
  const srcKey = src.kind === "orig" ? `o:${baseIndex}` : src.kind === "pdf" ? `p:${srcId(src.source)}:${src.index}` : "blank";
  const srcRef = useRef(src);
  srcRef.current = src;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    const s = srcRef.current;
    if (!visible || !box || s.kind === "blank") return;
    let dead = false;
    let task: RenderTask | null = null;
    const canvas = document.createElement("canvas");
    void (async () => {
      const page: PDFPageProxy =
        s.kind === "orig" ? await doc.getPage(baseIndex + 1) : await (await openSource(s.source)).getPage(s.index + 1);
      if (dead) return;
      const rotation = (page.rotate + slot.rot) % 360;
      const one = page.getViewport({ scale: 1, rotation });
      const vp = page.getViewport({ scale: Math.min(BOX / one.width, BOX / one.height), rotation });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${vp.width}px`;
      canvas.style.height = `${vp.height}px`;
      box.replaceChildren(canvas);
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      task = null;
    })().catch((e: unknown) => {
      // 스크롤 아웃·언마운트의 RenderingCancelled 와 소스 문서 파괴는 정상 경로다 — 그 밖은 로그로 남긴다.
      if (!dead) console.warn("[pdf-pages] thumbnail render failed", srcKey, e);
    });
    return () => {
      dead = true;
      task?.cancel();
      canvas.width = canvas.height = 0;
      canvas.remove();
    };
    // srcKey 가 출처를 대표한다 — slot.src 객체 신원은 렌더마다 바뀐다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, doc, srcKey, slot.rot, baseIndex, openSource]);

  return (
    <div className="flex items-center justify-center" style={{ width: BOX, height: BOX }}>
      <div className="relative shadow" style={{ width: info.w * fit, height: info.h * fit }}>
        {/* 캔버스는 effect 가 명령형으로 붙인다 — React 자식을 두지 않는다 */}
        <div ref={boxRef} className="h-full w-full overflow-hidden bg-white" />
        {visible && <ThumbAnnots info={info} fit={fit} page={page} markups={markups} />}
      </div>
    </div>
  );
}

/** 썸네일 위 우리 주석 — 노드는 page space 라 배율 하나(fit)로 그리고, 마크업은 화면과 같은 SVG(viewBox = page space). */
function ThumbAnnots({ info, fit, page, markups }: { info: PdfPageInfo; fit: number; page: EditorDoc; markups: readonly PdfMarkup[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [assetsVer, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => {
    let alive = true;
    void ensureAssets(page).then(() => alive && bump());
    return () => {
      alive = false;
    };
  }, [page]);
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv || !page.objects.length) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.ceil(info.w * fit * dpr);
    cv.height = Math.ceil(info.h * fit * dpr);
    const k = fit * dpr;
    renderScene(cv.getContext("2d")!, resolveScene(page), { tx: 0, ty: 0, sx: k, sy: k }, { background: "transparent", store: imageStore(page) });
  }, [page, info.w, info.h, fit, assetsVer]);
  return (
    <>
      {page.objects.length > 0 && <canvas ref={ref} aria-hidden data-pdf-thumb-annots className="pointer-events-none absolute inset-0 h-full w-full" />}
      {markups.length > 0 && (
        <svg
          aria-hidden
          viewBox={`0 0 ${info.w} ${info.h}`}
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
          style={{ mixBlendMode: "multiply" }}
        >
          {markups.map((m) => (
            <MarkupShape key={m.id} m={m} selected={false} />
          ))}
        </svg>
      )}
    </>
  );
}

export default function PdfPagesGrid({
  doc,
  baseKeys,
  slots,
  infos,
  pages,
  markups,
  projectId,
  onOp,
  onExtract,
  onUndo,
  onRedo,
}: PdfPagesGridProps) {
  const msg = useMessages();
  const t = msg.pdf.pages;
  const pushToast = useUi((s) => s.pushToast);
  const rootRef = useRef<HTMLDivElement>(null);
  const markupsOf = useMemo(() => {
    const m = new Map<string, PdfMarkup[]>();
    for (const mk of markups) m.set(mk.pageKey, [...(m.get(mk.pageKey) ?? []), mk]);
    return m;
  }, [markups]);
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [drop, setDrop] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);

  // 다른 PDF 소스 — 그리드가 사는 동안만 연다(삽입 측정 + 썸네일). 공유 워커는 destroy 하지 않는다(pdfjs.ts).
  const [sources] = useState(() => ({ docs: new Map<string, Promise<PDFDocumentProxy>>(), tasks: [] as PDFDocumentLoadingTask[] }));
  useEffect(
    () => () => {
      for (const task of sources.tasks) void task.destroy();
    },
    [sources],
  );
  const openSource = useMemo<OpenSource>(
    () => (s) => {
      const id = srcId(s);
      let p = sources.docs.get(id);
      if (!p) {
        p = (async () => {
          const [lib, buf] = await Promise.all([loadPdfjs(), ipc.readFileRaw(s.projectId, s.relPath)]);
          const { task } = lib.open(new Uint8Array(buf));
          sources.tasks.push(task);
          return task.promise;
        })();
        // 실패한 열기를 캐시하지 않는다 — 다음 시도에서 다시 읽는다.
        p.catch(() => sources.docs.delete(id));
        sources.docs.set(id, p);
      }
      return p;
    },
    [sources],
  );

  const baseIndex = useMemo(() => new Map(baseKeys.map((k, i) => [k, i])), [baseKeys]);
  const keys = slots.map((s) => s.key);
  const selected = keys.filter((k) => sel.has(k)); // 표시 순서
  // 연산 뒤 사라진 key(삭제·undo)는 선택에서 뺀다.
  useEffect(() => {
    const live = new Set(slots.map((s) => s.key));
    setSel((cur) => ([...cur].every((k) => live.has(k)) ? cur : new Set([...cur].filter((k) => live.has(k)))));
  }, [slots]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  /** 선택 뒤(없으면 끝)에 넣는다. */
  const insertAt = () => (selected.length ? keys.indexOf(selected[selected.length - 1]) + 1 : keys.length);

  const click = (e: React.MouseEvent, key: string) => {
    if (e.shiftKey && anchor.current && keys.includes(anchor.current)) {
      const [a, b] = [keys.indexOf(anchor.current), keys.indexOf(key)].sort((x, y) => x - y);
      setSel(new Set(keys.slice(a, b + 1)));
      return;
    }
    anchor.current = key;
    // Ctrl·⌘ 둘 다 토글로 받는다 — isMod 는 KeyboardEvent 전용이고, 클릭에서 플랫폼을 가를 이유가 없다.
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(sel);
      if (!next.delete(key)) next.add(key);
      setSel(next);
    } else setSel(new Set([key]));
  };

  const rotate = (delta: 90 | -90) => {
    if (selected.length) onOp({ kind: "rotate", keys: selected, delta });
  };
  const remove = () => {
    if (!selected.length) return;
    if (selected.length === keys.length) {
      pushToast("info", t.cantDeleteAll);
      return;
    }
    onOp({ kind: "delete", keys: selected });
    setSel(new Set());
    // 선택이 비면 누른 툴바 버튼이 disabled 가 되며 포커스가 BODY 로 빠진다 — 그러면 Ctrl+Z 가 안 먹는다.
    rootRef.current?.focus({ preventScroll: true });
  };
  const duplicate = () => {
    if (selected.length) onOp({ kind: "duplicate", keys: selected, newKeys: selected.map(newKey) });
  };
  const insertBlank = () => {
    const at = insertAt();
    // "현재 크기" = 넣을 자리 앞 페이지(없으면 첫 페이지)의 page space 크기
    const ref = infos[Math.max(0, at - 1)] ?? infos[0];
    onOp({ kind: "insertBlank", at, key: newKey(), w: ref?.w ?? 612, h: ref?.h ?? 792 });
  };

  const insertPdf = async (relPath: string) => {
    const source: PdfSource = { projectId, relPath };
    try {
      const d = await openSource(source);
      const inserted = await Promise.all(
        Array.from({ length: d.numPages }, async (_, i): Promise<PdfPageInfo> => {
          const vp = (await d.getPage(i + 1)).getViewport({ scale: 1 });
          return { index: 0, key: "", w: vp.width, h: vp.height, toPage: [...vp.transform] as PdfPageInfo["toPage"] };
        }),
      );
      onOp({ kind: "insertPdf", at: insertAt(), keys: inserted.map(newKey), source }, inserted);
    } catch (e) {
      pushToast("error", t.insertFailed(errorMessage(e)));
    }
  };

  const [pdfList, setPdfList] = useState<string[] | null>(null);
  const openPicker = () => {
    setPicking(true);
    if (pdfList) return;
    ipc.treeFilesByExt(projectId, ["pdf"], []).then(
      (r) => setPdfList(r.files.map((f) => f.path)),
      (e) => {
        setPicking(false);
        pushToast("error", t.listFailed(errorMessage(e)));
      },
    );
  };
  // QuickPick 은 source 신원이 바뀔 때마다 다시 조회한다 — 목록이 도착할 때만 바뀌게.
  const pickSource = useCallback(
    (q: string): QuickPickItem<string>[] => {
      const needle = q.trim().toLowerCase();
      return (pdfList ?? [])
        .filter((p) => !needle || p.toLowerCase().includes(needle))
        .slice(0, 200)
        .map((p) => ({ id: p, label: p.split("/").pop() ?? p, description: p, data: p }));
    },
    [pdfList],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 고르기 창(QuickPick)의 입력 칸 키도 DOM 상 여기로 버블된다 — 거기서 Backspace 가 페이지를 지우면 안 된다.
    const tag = (e.target as HTMLElement).tagName;
    if (picking || tag === "INPUT" || tag === "TEXTAREA") return;
    const mod = isMod(e.nativeEvent);
    const k = e.key.toLowerCase();
    let done = true;
    if (e.key === "Delete" || e.key === "Backspace") remove();
    else if (mod && !e.shiftKey && k === "a") setSel(new Set(keys));
    else if (mod && !e.shiftKey && k === "z") onUndo();
    else if (mod && (k === "y" || (e.shiftKey && k === "z"))) onRedo();
    else if (e.key === "Escape" && sel.size) setSel(new Set());
    else done = false;
    if (!done) return; // Ctrl+S 등은 PdfView 루트로 흐른다
    e.preventDefault();
    e.stopPropagation();
  };

  const dropAt = (e: React.DragEvent, i: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? i : i + 1;
  };
  const onDrop = () => {
    const at = drop;
    setDrop(null);
    if (at === null || !selected.length) return;
    const moving = new Set(selected);
    const to = keys.slice(0, at).filter((k) => !moving.has(k)).length;
    const rest = keys.filter((k) => !moving.has(k));
    const next = [...rest.slice(0, to), ...selected, ...rest.slice(to)];
    if (next.every((k, i) => k === keys[i])) return;
    onOp({ kind: "move", keys: selected, to });
  };

  const btn = "flex items-center gap-1 rounded px-1.5 py-0.5 enabled:hover:bg-raised enabled:hover:text-fg disabled:opacity-40";
  const none = selected.length === 0;

  return (
    <div
      ref={rootRef}
      data-pdf-pages-grid
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-10 flex flex-col bg-base outline-none"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-hidden border-b border-edge px-3 text-xs text-fg-dim">
        <button data-pdf-pages-op="rotate-left" disabled={none} onClick={() => rotate(-90)} title={t.rotateLeft} className={btn}>
          <RotateCcw size={13} />
        </button>
        <button data-pdf-pages-op="rotate-right" disabled={none} onClick={() => rotate(90)} title={t.rotateRight} className={btn}>
          <RotateCw size={13} />
        </button>
        <button data-pdf-pages-op="duplicate" disabled={none} onClick={duplicate} title={t.duplicate} className={btn}>
          <Copy size={13} />
        </button>
        <button data-pdf-pages-op="delete" disabled={none} onClick={remove} title={t.remove} className={btn}>
          <Trash2 size={13} />
        </button>
        <div className="mx-1 h-4 w-px bg-edge" />
        <button data-pdf-pages-op="insert-blank" onClick={insertBlank} title={t.insertBlank} className={btn}>
          <FilePlus size={13} />
          <span className="@max-md:hidden">{t.insertBlank}</span>
        </button>
        <button data-pdf-pages-op="insert-pdf" onClick={openPicker} title={t.insertPdf} className={btn}>
          <FileInput size={13} />
          <span>{t.insertPdf}</span>
        </button>
        <button data-pdf-pages-op="extract" disabled={none} onClick={() => onExtract(selected)} title={t.extract} className={btn}>
          <FileOutput size={13} />
          <span>{t.extract}</span>
        </button>
        <div className="flex-1" />
        <span data-pdf-pages-count className="shrink-0 tabular-nums">
          {t.selected(selected.length, keys.length)}
        </span>
      </div>

      <div
        role="listbox"
        aria-multiselectable
        aria-label={t.grid}
        className="flex min-h-0 flex-1 flex-wrap content-start gap-3 overflow-auto p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSel(new Set());
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
      >
        {slots.map((slot, i) => {
          const on = sel.has(slot.key);
          return (
            <div
              key={slot.key}
              role="option"
              aria-selected={on}
              data-pdf-page-key={slot.key}
              draggable
              onClick={(e) => click(e, slot.key)}
              onDragStart={(e) => {
                if (!on) setSel(new Set([slot.key]));
                anchor.current = slot.key;
                // WebView2 는 dataTransfer 가 비면 드래그를 시작하지 않는다.
                e.dataTransfer.setData("text/plain", slot.key);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                e.preventDefault();
                const at = dropAt(e, i);
                if (at !== drop) setDrop(at);
              }}
              onDragEnd={() => setDrop(null)}
              className={`relative flex cursor-default flex-col items-center gap-1 rounded p-1.5 ${
                on ? "bg-accent/15 ring-1 ring-accent" : "hover:bg-raised"
              }`}
            >
              {drop === i && <div className="absolute -left-2 top-1 bottom-1 w-0.5 rounded bg-accent" />}
              {drop === i + 1 && i === slots.length - 1 && (
                <div className="absolute -right-2 top-1 bottom-1 w-0.5 rounded bg-accent" />
              )}
              {infos[i] && (
                <PageThumb
                  slot={slot}
                  info={infos[i]}
                  doc={doc}
                  baseIndex={slot.src.kind === "orig" ? (baseIndex.get(slot.src.key) ?? 0) : 0}
                  openSource={openSource}
                  page={pages[i]}
                  markups={markupsOf.get(infos[i].key) ?? NO_MARKUPS}
                />
              )}
              <span className="text-[11px] tabular-nums text-fg-dim">{t.page(i + 1)}</span>
            </div>
          );
        })}
      </div>

      {picking && (
        <QuickPick<string>
          placeholder={t.pickPdf}
          source={pickSource}
          emptyText={pdfList ? t.noPdf : undefined}
          onPick={(item) => {
            setPicking(false);
            void insertPdf(item.data);
          }}
          onClose={() => {
            setPicking(false);
            rootRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
