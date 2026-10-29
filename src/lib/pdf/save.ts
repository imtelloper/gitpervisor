// PDF 주석 증분 저장(설계 §7.1). `buildIncrement` 는 순수(바이트 → 바이트), `savePdf` 는 IPC 파이프라인.
//
// pdf-lib 계약 L1~L3(부록 A): 증분은 `saveIncremental(doc.context.snapshot)` 으로만 뽑고(commit 은 원본 ⧺ 증분 전체를
// 돌려준다), 페이지는 `/Annots` 만 직접 고치며(write.ts setAnnots), trailer `/Size` 역행은 `fixSize` 가 바로잡는다.

import type { PDFDocument, PDFFont, PDFObject, PDFPage, PDFRef } from "@cantoo/pdf-lib";

import { currentLocale } from "../../i18n/locale-state";
import { messagesFor } from "../../i18n/messages";
import type { EditorDoc, TextNode } from "../annotate/types";
import { ipc, type IpcError } from "../ipc";
import { buildMarkupDict } from "./markup";
import type { PageOp, PdfFont, PdfLedger, PdfMarkup, PdfPageInfo, PdfTextLine } from "./model";
import { applyPageOpsToDoc, type ReadPdfSource } from "./pages";
import {
  annotEntries,
  buildAnnotDict,
  embeddedImageOf,
  imageFillOf,
  embedTextFont,
  isPdfNode,
  setAnnots,
  type PdfLib,
  type WriteCtx,
} from "./write";

export interface SaveModel {
  infos: PdfPageInfo[];
  pages: EditorDoc[];
  ledger: PdfLedger;
  /** 텍스트 노드의 줄 — 화면이 layoutText 로 계산해 넘긴다(Node 검사에서는 손으로 준다) */
  textLines: (node: TextNode) => PdfTextLine[];
  font: PdfFont | null;
  /** 페이지 관리 연산(M4) — 주석과 **같은** 증분 하나로 페이지 트리에 적용한다. `infos` 는 연산 뒤 순서다. */
  pageOps?: readonly PageOp[];
  /** 텍스트 마크업(M3) — 노드와 같은 장부(refs·saved·pageOf)를 쓴다. */
  markups?: readonly PdfMarkup[];
}

// ── 바이트 수준 ─────────────────────────────────────────────────────────────

/** 바이트 → latin1 문자열(1바이트 = 1글자). TextDecoder('latin1') 은 실제로 windows-1252 라 0x80–0x9F 가 바뀐다. */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

function lastSizeIn(text: string): number | null {
  let last: number | null = null;
  for (const m of text.matchAll(/\/Size\s+(\d+)/g)) last = Number(m[1]);
  return last;
}

/**
 * 직전 리비전 trailer 의 `/Size`. 클래식 xref 는 trailer 가 파일 끝(startxref 바로 앞)에 있고,
 * xref 스트림은 startxref 가 가리키는 객체 사전 안에 있다 — 그래서 꼬리를 먼저 보고 없으면 그 자리를 본다.
 */
export function lastTrailerSize(bytes: Uint8Array): number | null {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 4096)));
  const sx = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  const tailTrailer = tail.lastIndexOf("trailer");
  if (tailTrailer >= 0) {
    const v = lastSizeIn(tail.slice(tailTrailer));
    if (v !== null) return v;
  }
  if (!sx) return null;
  const off = Number(sx[1]);
  return lastSizeIn(latin1(bytes.subarray(off, Math.min(bytes.length, off + 4096))).split("stream")[0]);
}

/**
 * L3: `PDFWriter`(헤더 1.4 이하) 증분은 새 객체가 없으면 trailer `/Size` 를 직전보다 1 작게 쓴다
 * (`PDFWriter.createTrailerDict`). qpdf 가 경고하고 pyHanko 엄격 모드는 파일을 거부한다 — 직전 값으로 올린다.
 * trailer 는 xref 표 **뒤**라 자릿수가 바뀌어도 startxref 오프셋은 그대로다.
 */
export function fixSize(prev: Uint8Array, inc: Uint8Array): Uint8Array {
  const want = lastTrailerSize(prev);
  // 직전 /Size 를 못 찾으면(손상된 꼬리) 고칠 기준이 없다 — pdf-lib 이 쓴 값을 그대로 둔다.
  if (want === null) return inc;
  const text = latin1(inc);
  const t = text.lastIndexOf("trailer");
  if (t < 0) return inc; // xref 스트림 증분 — PDFStreamWriter 는 /Size 를 largestObjectNumber+1 로 덮어써 역행이 없다
  const m = /\/Size\s+(\d+)/.exec(text.slice(t));
  if (!m || Number(m[1]) >= want) return inc;
  const at = t + m.index;
  const fixed = text.slice(0, at) + `/Size ${want}` + text.slice(at + m[0].length);
  const out = new Uint8Array(fixed.length);
  for (let i = 0; i < fixed.length; i++) out[i] = fixed.charCodeAt(i);
  return out;
}

// ── 증분 ─────────────────────────────────────────────────────────────────────

export function parseRef(lib: PdfLib, s: string): PDFRef {
  const m = /^(\d+) (\d+) R$/.exec(s);
  if (!m) throw new Error(`parseRef: bad object reference "${s}"`);
  return lib.PDFRef.of(Number(m[1]), Number(m[2]));
}

export async function loadForIncrement(lib: PdfLib, bytes: Uint8Array): Promise<PDFDocument> {
  return lib.PDFDocument.load(bytes, { forIncrementalUpdate: true, updateMetadata: false });
}

export async function incrementOf(doc: PDFDocument, prev: Uint8Array): Promise<Uint8Array> {
  const snap = doc.context.snapshot;
  if (!snap) throw new Error("incrementOf: document was not loaded for incremental update");
  return fixSize(prev, await doc.saveIncremental(snap));
}

/**
 * 지울 ref 와 그 `/Popup`, 그리고 그것들에 `/IRT` 로 달린 답글(과 답글의 Popup)까지 — Acrobat 과 같은 범위(§6.3).
 * 반환값은 entries 에서 지울 키 집합(`"N G R"`).
 */
function removalClosure(lib: PdfLib, page: PDFPage, entries: readonly PDFObject[], refs: readonly PDFRef[]): Set<string> {
  const ctx = page.doc.context;
  const kill = new Set(refs.map((r) => r.toString()));
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of entries) {
      if (!(e instanceof lib.PDFRef)) continue;
      const d = ctx.lookupMaybe(e, lib.PDFDict);
      if (!d) continue;
      const key = e.toString();
      const popup = d.get(lib.PDFName.of("Popup"));
      const irt = d.get(lib.PDFName.of("IRT"));
      if (kill.has(key) && popup instanceof lib.PDFRef && !kill.has(popup.toString())) {
        kill.add(popup.toString());
        grew = true;
      }
      if (!kill.has(key) && irt instanceof lib.PDFRef && kill.has(irt.toString())) {
        kill.add(key);
        grew = true;
      }
    }
  }
  return kill;
}

export function removeAnnots(lib: PdfLib, page: PDFPage, refs: readonly PDFRef[], withReplies: boolean): void {
  const entries = annotEntries(lib, page);
  const kill = withReplies ? removalClosure(lib, page, entries, refs) : new Set(refs.map((r) => r.toString()));
  const kept = entries.filter((e) => !(e instanceof lib.PDFRef && kill.has(e.toString())));
  if (kept.length !== entries.length) setAnnots(lib, page, kept);
}

function ensureAnnot(lib: PdfLib, page: PDFPage, ref: PDFRef): void {
  const entries = annotEntries(lib, page);
  if (entries.some((e) => e instanceof lib.PDFRef && e.toString() === ref.toString())) return;
  setAnnots(lib, page, [...entries, ref]);
}

/** 순수: 원본 바이트 → 증분 바이트 + 저장 뒤 장부. L1 saveIncremental(snapshot) · L2 /Annots 직접 · L3 fixSize */
export async function buildIncrement(
  bytes: Uint8Array,
  m: SaveModel,
  readSource?: ReadPdfSource,
): Promise<{ inc: Uint8Array; ledger: PdfLedger }> {
  const lib = await import("@cantoo/pdf-lib");
  const doc = await loadForIncrement(lib, bytes);
  const orig = doc.getPages();
  // 장부의 페이지 key → 파일 페이지. 삭제된 원본 페이지도 남겨 둔다(그 위 주석을 지울 때 찾지 않게 — 아래 gone).
  const pageByKey = new Map(orig.map((p) => [p.ref.toString(), p]));
  let pages = orig;
  if (m.pageOps?.length) {
    const placed = await applyPageOpsToDoc(lib, doc, m.pageOps, readSource, new Set(m.ledger.refs.values()));
    const bad = placed.findIndex((x, i) => x.key !== m.infos[i]?.key);
    if (bad >= 0 || placed.length !== m.infos.length) {
      throw new Error(`buildIncrement: page keys disagree with page ops at index ${bad} (file ${placed.length}, infos ${m.infos.length})`);
    }
    pages = placed.map((x) => x.page);
  }
  if (pages.length !== m.infos.length || m.pages.length !== m.infos.length) {
    throw new Error(
      `buildIncrement: page count mismatch (file ${pages.length}, infos ${m.infos.length}, docs ${m.pages.length})`,
    );
  }
  // 연산이 없으면 index 로 맞춘다 — 외부 앱이 파일을 통째로 다시 써 객체 번호가 바뀐 판(덮어쓰기 저장)도 종전처럼 받는다.
  m.infos.forEach((info, i) => pageByKey.set(info.key, pages[i]));
  let font: Promise<PDFFont> | null = null;
  const wc: WriteCtx = {
    lib,
    doc,
    textLines: m.textLines,
    textFont: () => (font ??= embedTextFont(lib, doc, m.font)),
    asset: (id) => {
      for (const d of m.pages) if (d.assets[id]) return d.assets[id];
      return undefined;
    },
    // 장부 기준으로 고른다 — 그 ref 의 사전은 마지막 저장 때 그 노드(같은 에셋)로 쓴 것이다.
    existingImage: (id) => {
      for (const [nid, refStr] of m.ledger.refs) {
        const prev = m.ledger.saved.get(nid);
        if (!prev || !("kind" in prev) || imageFillOf(prev)?.assetId !== id) continue;
        const d = doc.context.lookupMaybe(parseRef(lib, refStr), lib.PDFDict);
        const img = d ? embeddedImageOf(lib, d) : null;
        if (img) return img;
      }
      return null;
    },
    images: new Map(),
  };
  const ledger: PdfLedger = { refs: new Map(), saved: new Map(), pageOf: new Map() };
  const live = new Set<string>();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const key = m.infos[i].key;
    for (const node of m.pages[i].objects) {
      if (!isPdfNode(node)) {
        throw new Error(`buildIncrement: node ${node.id} kind "${node.kind}" cannot be saved as a PDF annotation`);
      }
      live.add(node.id);
      const refStr = m.ledger.refs.get(node.id);
      const prevKey = m.ledger.pageOf.get(node.id);
      ledger.saved.set(node.id, node);
      ledger.pageOf.set(node.id, key);
      if (refStr && m.ledger.saved.get(node.id) === node && prevKey === key) {
        ledger.refs.set(node.id, refStr);
        continue;
      }
      if (refStr) {
        // 재저장: 같은 ref 에 새 사전을 assign — 새로 만들면 다른 뷰어에 주석이 두 개 생긴다(§7.1 ⑦).
        const ref = parseRef(lib, refStr);
        const base = doc.context.lookupMaybe(ref, lib.PDFDict) ?? null;
        const dict = await buildAnnotDict(wc, node, m.infos[i], page.ref, base);
        doc.context.assign(ref, dict);
        doc.context.snapshot?.markRefForSave(ref);
        const prevPage = prevKey !== undefined && prevKey !== key ? pageByKey.get(prevKey) : undefined;
        if (prevPage) removeAnnots(lib, prevPage, [ref], false);
        ensureAnnot(lib, page, ref);
        ledger.refs.set(node.id, refStr);
      } else {
        const dict = await buildAnnotDict(wc, node, m.infos[i], page.ref, null);
        const ref = doc.context.register(dict);
        ensureAnnot(lib, page, ref);
        ledger.refs.set(node.id, ref.toString());
      }
    }
  }

  for (const mk of m.markups ?? []) {
    const i = m.infos.findIndex((x) => x.key === mk.pageKey);
    // 페이지째 지운 마크업은 live 에 넣지 않는다 — 아래 gone 이 노드와 같은 규칙으로 처리한다.
    if (i < 0) continue;
    const page = pages[i];
    live.add(mk.id);
    ledger.saved.set(mk.id, mk);
    ledger.pageOf.set(mk.id, mk.pageKey);
    const refStr = m.ledger.refs.get(mk.id);
    if (refStr && m.ledger.saved.get(mk.id) === mk && m.ledger.pageOf.get(mk.id) === mk.pageKey) {
      ledger.refs.set(mk.id, refStr);
      continue;
    }
    if (refStr) {
      const ref = parseRef(lib, refStr);
      const base = doc.context.lookupMaybe(ref, lib.PDFDict) ?? null;
      doc.context.assign(ref, buildMarkupDict(lib, doc, mk, m.infos[i], page.ref, base));
      doc.context.snapshot?.markRefForSave(ref);
      ensureAnnot(lib, page, ref);
      ledger.refs.set(mk.id, refStr);
    } else {
      const ref = doc.context.register(buildMarkupDict(lib, doc, mk, m.infos[i], page.ref, null));
      ensureAnnot(lib, page, ref);
      ledger.refs.set(mk.id, ref.toString());
    }
  }

  const gone = new Map<PDFPage, PDFRef[]>();
  for (const [id, refStr] of m.ledger.refs) {
    if (live.has(id)) continue;
    const k = m.ledger.pageOf.get(id);
    if (k === undefined) throw new Error(`buildIncrement: deleted node ${id} has no page in ledger`);
    const p = pageByKey.get(k);
    // 페이지째 삭제됐다(M4) — 트리에서 빠진 페이지의 /Annots 를 고쳐 봐야 증분만 커진다.
    if (!p) continue;
    gone.set(p, [...(gone.get(p) ?? []), parseRef(lib, refStr)]);
  }
  for (const [p, refs] of gone) removeAnnots(lib, p, refs, true);

  return { inc: await incrementOf(doc, bytes), ledger };
}

function conflictError(path: string): IpcError {
  return { code: "CONFLICT", message: messagesFor(currentLocale()).pdf.core.changedExternally(path), stderr: null };
}

/** IPC: stamp 확인 → read_file_raw → buildIncrement → write_file_raw(append, expectedStamp, baseLen). 새 stamp 반환 */
export async function savePdf(
  projectId: string,
  path: string,
  expectedStamp: string,
  m: SaveModel,
): Promise<{ stamp: string; ledger: PdfLedger }> {
  const now = await ipc.fileStamp(projectId, path);
  if (now !== expectedStamp) throw conflictError(path);
  const bytes = new Uint8Array(await ipc.readFileRaw(projectId, path));
  const { inc, ledger } = await buildIncrement(bytes, m);
  // 증분의 xref 오프셋·/Prev 는 읽은 길이 기준 절대값이다 — Rust 가 stamp·길이를 다시 대조하고 다르면 CONFLICT(§7.1 ⑥).
  const stamp = await ipc.writeFileRaw(projectId, path, inc, {
    mode: "append",
    expectedStamp: now,
    baseLen: bytes.length,
  });
  if (stamp === null) {
    // 쓰기는 끝났는데 mtime 을 못 읽는 파일시스템 — 저장 실패가 아니므로 던지지 않고 새 stamp 를 한 번 더 묻는다.
    return { stamp: (await ipc.fileStamp(projectId, path)) ?? "", ledger };
  }
  return { stamp, ledger };
}

export function isDirty(
  pages: EditorDoc[],
  ledger: PdfLedger,
  pageOps: readonly PageOp[] = [],
  markups: readonly PdfMarkup[] = [],
): boolean {
  if (pageOps.length) return true;
  let count = markups.length;
  if (markups.some((mk) => ledger.saved.get(mk.id) !== mk)) return true;
  // 페이지 소속(pageOf)은 보지 않는다 — 노드가 페이지를 옮기는 길은 복제(새 id)·회전(새 참조)뿐이라 위 두 판정이 잡는다.
  for (const page of pages) {
    for (const node of page.objects) {
      count++;
      if (ledger.saved.get(node.id) !== node) return true;
    }
  }
  return count !== ledger.saved.size;
}
