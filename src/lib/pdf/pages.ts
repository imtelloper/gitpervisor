// 페이지 관리(M4, DOCS/task/75 T6) — PageOp 목록 하나를 세 곳이 같은 규칙(stepPages)으로 읽는다:
//   applyPageOp       편집 상태(infos·노드·마크업)를 연산 하나만큼 옮긴다 — 연산을 만들 때 한 번(순수)
//   applyPageOpsToDoc pdf-lib 문서의 페이지 트리를 바꾼다 — 저장(buildIncrement 의 같은 증분)과 표시(displayBytes)
//   replayPageOps     원본 key 목록 → 각 자리의 출처(원본·빈 페이지·다른 PDF)와 추가 회전 — 그리드 썸네일
//
// L2: 원본 페이지의 /Contents 는 건드리지 않는다. 회전은 /Rotate, 순서는 /Kids, 복제는 같은 콘텐츠를 가리키는 새 leaf.

import type { PDFDocument, PDFPage, PDFRef } from "@cantoo/pdf-lib";

import { transformObjects } from "../annotate/geometry";
import { normalizeDoc } from "../annotate/schema";
import { newObjId, type EditorDoc, type Node } from "../annotate/types";
import { ipc } from "../ipc";
import { collectGarbage } from "./export";
import type { Affine, PageOp, PdfMarkup, PdfPageInfo } from "./model";
import { buildIncrement, incrementOf, loadForIncrement, type SaveModel } from "./save";
import { mul } from "./space";
import { annotEntries, type PdfLib } from "./write";

export type PdfSource = Extract<PageOp, { kind: "insertPdf" }>["source"];
export type ReadPdfSource = (src: PdfSource) => Promise<Uint8Array>;

const readSourceIpc: ReadPdfSource = async (s) => new Uint8Array(await ipc.readFileRaw(s.projectId, s.relPath));

export const sourceId = (s: PdfSource) => `${s.projectId}\0${s.relPath}`;

// ── 목록 연산(공통 규칙) ─────────────────────────────────────────────────────

interface StepFns<T> {
  rotate(t: T, delta: 90 | -90): T;
  blank(op: Extract<PageOp, { kind: "insertBlank" }>): T;
  pdf(op: Extract<PageOp, { kind: "insertPdf" }>): T[];
  dup(t: T, newKey: string): T;
}

function stepPages<T>(list: readonly T[], keyOf: (t: T) => string, op: PageOp, f: StepFns<T>): T[] {
  switch (op.kind) {
    case "move": {
      const set = new Set(op.keys);
      const rest = list.filter((t) => !set.has(keyOf(t)));
      return [...rest.slice(0, op.to), ...list.filter((t) => set.has(keyOf(t))), ...rest.slice(op.to)];
    }
    case "rotate": {
      const set = new Set(op.keys);
      return list.map((t) => (set.has(keyOf(t)) ? f.rotate(t, op.delta) : t));
    }
    case "delete": {
      const set = new Set(op.keys);
      return list.filter((t) => !set.has(keyOf(t)));
    }
    case "insertBlank":
      return [...list.slice(0, op.at), f.blank(op), ...list.slice(op.at)];
    case "insertPdf":
      return [...list.slice(0, op.at), ...f.pdf(op), ...list.slice(op.at)];
    case "duplicate":
      return list.flatMap((t) => {
        const i = op.keys.indexOf(keyOf(t));
        return i < 0 ? [t] : [t, f.dup(t, op.newKeys[i])];
      });
    default: {
      const never: never = op;
      throw new Error(`stepPages: unknown op ${JSON.stringify(never)}`);
    }
  }
}

// ── 편집 상태 ─────────────────────────────────────────────────────────────────

/** page space 를 90° 돌리는 아핀 — 이미지 편집기 회전(geometry.ts transformPoint rotCW/rotCCW)과 같은 식. (w,h)는 돌리기 전. */
export function rotationAffine(delta: 90 | -90, w: number, h: number): Affine {
  return delta === 90 ? [0, 1, -1, 0, h, 0] : [0, -1, 1, 0, 0, w];
}

export interface PageEditState {
  infos: PdfPageInfo[];
  pages: EditorDoc[];
  markups: PdfMarkup[];
}

const emptyDoc = (): EditorDoc => normalizeDoc({ objects: [] });

function copyNodes(objects: readonly Node[]): Node[] {
  const ids = new Map(objects.map((o) => [o.id, newObjId()]));
  return objects.map((o) => ({ ...o, id: ids.get(o.id)!, parentId: o.parentId ? (ids.get(o.parentId) ?? null) : null }));
}


/**
 * 연산 하나를 편집 상태에 적용한다. `inserted` 는 insertPdf 의 새 페이지 정보(pdf.js 로 소스를 열어 잰 값, op.keys 순서).
 * 삭제된 페이지의 노드·마크업은 함께 사라진다(undo 는 스냅샷이 되살린다).
 */
export function applyPageOp(st: PageEditState, op: PageOp, inserted: readonly PdfPageInfo[] = []): PageEditState {
  type E = { info: PdfPageInfo; doc: EditorDoc };
  const list: E[] = st.infos.map((info, i) => ({ info, doc: st.pages[i] }));
  const next = stepPages<E>(list, (e) => e.info.key, op, {
    rotate: ({ info, doc }, delta) => ({
      info: { ...info, w: info.h, h: info.w, toPage: mul(info.toPage, rotationAffine(delta, info.w, info.h)) },
      doc: { ...doc, objects: transformObjects(doc.objects, delta === 90 ? "rotCW" : "rotCCW", info.w, info.h) },
    }),
    blank: (o) => ({ info: { index: 0, key: o.key, w: o.w, h: o.h, toPage: [1, 0, 0, -1, 0, o.h] }, doc: emptyDoc() }),
    pdf: (o) => {
      if (inserted.length !== o.keys.length) {
        throw new Error(`applyPageOp: insertPdf has ${o.keys.length} keys but ${inserted.length} page infos`);
      }
      return inserted.map((info, i) => ({ info: { ...info, key: o.keys[i] }, doc: emptyDoc() }));
    },
    dup: ({ info, doc }, key) => ({ info: { ...info, key }, doc: { ...doc, objects: copyNodes(doc.objects) } }),
  });

  let markups = st.markups;
  if (op.kind === "delete") {
    const set = new Set(op.keys);
    markups = markups.filter((m) => !set.has(m.pageKey));
  } else if (op.kind === "rotate") {
    const byKey = new Map(st.infos.map((i) => [i.key, i]));
    markups = markups.map((m) => {
      const info = op.keys.includes(m.pageKey) ? byKey.get(m.pageKey) : undefined;
      if (!info) return m;
      const r = rotationAffine(op.delta, info.w, info.h);
      const quads = m.quads.slice();
      for (let i = 0; i + 1 < quads.length; i += 2) {
        const [x, y] = [quads[i], quads[i + 1]];
        quads[i] = r[0] * x + r[2] * y + r[4];
        quads[i + 1] = r[1] * x + r[3] * y + r[5];
      }
      return { ...m, quads };
    });
  } else if (op.kind === "duplicate") {
    const copies = markups.flatMap((m) => {
      const i = op.keys.indexOf(m.pageKey);
      return i < 0 ? [] : [{ ...m, id: newObjId(), pageKey: op.newKeys[i] }];
    });
    markups = [...markups, ...copies];
  }

  return {
    infos: next.map((e, index) => ({ ...e.info, index })),
    pages: next.map((e) => e.doc),
    markups,
  };
}

// ── 파일 ─────────────────────────────────────────────────────────────────────

export type PageSrc =
  | { kind: "orig"; key: string }
  | { kind: "blank"; w: number; h: number }
  | { kind: "pdf"; source: PdfSource; index: number };

/** 연산 뒤 한 자리 — `rot` 은 출처 페이지의 /Rotate 위에 더할 시계방향 각(0·90·180·270). */
export interface PageSlot {
  key: string;
  src: PageSrc;
  rot: number;
}

export function replayPageOps(keys: readonly string[], ops: readonly PageOp[]): PageSlot[] {
  let slots: PageSlot[] = keys.map((key) => ({ key, src: { kind: "orig", key }, rot: 0 }));
  for (const op of ops) {
    slots = stepPages<PageSlot>(slots, (s) => s.key, op, {
      rotate: (s, delta) => ({ ...s, rot: (s.rot + delta + 360) % 360 }),
      blank: (o) => ({ key: o.key, src: { kind: "blank", w: o.w, h: o.h }, rot: 0 }),
      pdf: (o) => o.keys.map((key, index) => ({ key, src: { kind: "pdf", source: o.source, index }, rot: 0 })),
      dup: (s, key) => ({ ...s, key }),
    });
  }
  return slots;
}

/** 부모 /Pages 에서 물려받던 값을 leaf 로 내린다 — 트리를 평평하게 다시 엮으면 중간 노드의 상속이 끊긴다. */
function pinInherited(lib: PdfLib, page: PDFPage): void {
  for (const k of lib.PDFPageLeaf.InheritableEntries) {
    const name = lib.PDFName.of(k);
    const v = page.node.getInheritableAttribute(name);
    if (v && !page.node.get(name)) page.node.set(name, v);
  }
}

/**
 * copyPages 직전, 메모리에 연 문서에서 이 페이지 주석이 다른 페이지로 닿는 길을 끊는다 — 복사기는 참조를 끝까지 따라가
 * 닿은 페이지를 콘텐츠째 새 문서에 고아로 끌고 온다(트리엔 없어 안 보이지만 파일에서 꺼낼 수 있다 — 공유하려고 뽑은 쪽에
 * 뽑지 않은 쪽이 섞인다). 길: /P · 문서 안 이동 링크(/Dest·GoTo, 새 문서에선 갈 곳도 없다) · 이 페이지 밖을 가리키는
 * /Parent(위젯 → 필드 → /Kids → 다른 쪽 위젯 → /P)·/IRT·/Popup. 위젯은 필드 연결을 잃고 외관만 남는다(새 문서엔 /AcroForm 도 없다).
 */
function detachAnnotsForCopy(lib: PdfLib, page: PDFPage): void {
  const ctx = page.doc.context;
  const N = (s: string) => lib.PDFName.of(s);
  const kept = annotEntries(lib, page).filter((e) => {
    const d = ctx.lookupMaybe(e, lib.PDFDict);
    const action = d?.lookupMaybe(N("A"), lib.PDFDict);
    return !(d?.has(N("Dest")) || action?.get(N("S")) === N("GoTo"));
  });
  const here = new Set(kept.map((e) => e.toString()));
  for (const e of kept) {
    const d = ctx.lookupMaybe(e, lib.PDFDict);
    if (!d) continue;
    d.delete(N("P"));
    for (const k of ["Parent", "IRT", "Popup"]) {
      const v = d.get(N(k));
      if (v && !here.has(v.toString())) d.delete(N(k));
    }
  }
  // 메모리 사본만 고친다 — setAnnots 는 증분 저장 전용이라 쓰지 않는다.
  page.node.set(N("Annots"), ctx.obj(kept));
}

/**
 * 연산을 문서의 페이지 트리에 적용하고 연산 뒤 순서의 페이지를 돌려준다(key 는 원본이면 `"N G R"`, 그 외는 연산의 key).
 * pdf-lib 의 removePage 는 객체를 지워(context.delete) 옮기기에 못 쓰고, 이후 doc.getPages() 는 캐시가 낡는다 —
 * 호출자는 반환값만 쓴다.
 */
export async function applyPageOpsToDoc(
  lib: PdfLib,
  doc: PDFDocument,
  ops: readonly PageOp[],
  read: ReadPdfSource = readSourceIpc,
  /** 편집 노드·마크업의 주석 ref — 복제본에 사본을 만들지 않는다(모델이 새 id 로 복사해 새 주석으로 쓴다). */
  editable: ReadonlySet<string> = new Set(),
): Promise<{ key: string; page: PDFPage }[]> {
  const orig = doc.getPages();
  const origKeys = orig.map((p) => p.ref.toString());
  const byKey = new Map(orig.map((p, i) => [origKeys[i], p]));
  const slots = replayPageOps(origKeys, ops);

  // 다른 PDF 는 소스마다 copyPages 한 번 — 글꼴 등 공유 자원이 페이지마다 따로 복사되지 않게. 같은 쪽은 한 번만 넘긴다:
  // 복사기가 주석 사전을 캐시해, 같은 쪽을 두 번 넘기면(같은 PDF 두 번 삽입·삽입 쪽 복제) 두 페이지가 주석 객체 하나를
  // 나눠 가졌다 — 한쪽 주석을 고치면 다른 쪽도 움직였다. 두 번째부터는 원본 쪽 복제와 같은 규칙(새 leaf, /Annots 없음).
  const wanted = new Map<string, { source: PdfSource; indices: Set<number> }>();
  for (const s of slots) {
    if (s.src.kind !== "pdf") continue;
    const id = sourceId(s.src.source);
    const w = wanted.get(id) ?? { source: s.src.source, indices: new Set<number>() };
    w.indices.add(s.src.index);
    wanted.set(id, w);
  }
  const copied = new Map<string, Map<number, PDFPage>>();
  for (const [id, w] of wanted) {
    const src = await lib.PDFDocument.load(await read(w.source), { updateMetadata: false });
    const srcPages = src.getPages();
    const indices = [...w.indices];
    const badIdx = indices.find((i) => i >= srcPages.length);
    if (badIdx !== undefined) {
      throw new Error(`applyPageOpsToDoc: ${w.source.relPath} has ${srcPages.length} pages, wanted page ${badIdx + 1}`);
    }
    for (const i of indices) detachAnnotsForCopy(lib, srcPages[i]);
    const pages = await doc.copyPages(src, indices);
    copied.set(id, new Map(indices.map((i, k) => [i, pages[k]])));
  }

  // 복제 — 같은 /Contents·/Resources 를 가리키는 새 leaf. 주석은 한 페이지에만 속하므로 공유하지 않는다: 편집 노드는
  // 모델이 새 id 로 복사해 새 주석으로 쓰고, 다른 앱 주석(링크·메모 등)은 사전을 복사해 /P 를 새 leaf 로 바꾼다.
  // 위젯(폼 필드)·Popup·답글(/IRT)은 따라가지 않는다 — 필드 값이 두 곳에 묶이고, 팝업·답글은 부모 주석에 매여 있다.
  const N = (k: string) => lib.PDFName.of(k);
  const cloneLeaf = (p: PDFPage): PDFPage => {
    pinInherited(lib, p);
    const leaf = p.node.clone();
    leaf.delete(N("Annots"));
    const ref = doc.context.register(leaf);
    const copies: PDFRef[] = [];
    for (const e of annotEntries(lib, p)) {
      if (editable.has(e.toString())) continue;
      const d = doc.context.lookupMaybe(e, lib.PDFDict);
      const sub = d?.get(N("Subtype"));
      if (!d || sub === N("Widget") || sub === N("Popup") || d.has(N("IRT"))) continue;
      const c = d.clone();
      c.set(N("P"), ref);
      c.delete(N("Popup"));
      c.delete(N("NM")); // 같은 이름이 두 쪽에 있으면 /NM 으로 찾는 쪽('그래도 저장')이 엉뚱한 사본을 잡는다
      copies.push(doc.context.register(c));
    }
    if (copies.length) leaf.set(N("Annots"), doc.context.obj(copies));
    return lib.PDFPage.of(leaf, ref, doc);
  };
  const usedCopies = new Set<PDFPage>();

  const placed: { key: string; page: PDFPage }[] = [];
  for (const s of slots) {
    let page: PDFPage;
    if (s.src.kind === "orig") {
      const p = byKey.get(s.src.key);
      if (!p) throw new Error(`applyPageOpsToDoc: page ${s.src.key} is not in this file`);
      page = s.key === s.src.key ? p : cloneLeaf(p);
    } else if (s.src.kind === "blank") {
      page = lib.PDFPage.create(doc);
      page.setSize(s.src.w, s.src.h);
    } else {
      const first = copied.get(sourceId(s.src.source))!.get(s.src.index)!;
      if (usedCopies.has(first)) page = cloneLeaf(first);
      else {
        usedCopies.add(first);
        page = first;
        // 복사 전에 끊은 /P 를 새 자리로 — 화면 주석(Screen)은 /P 가 있어야 한다.
        for (const e of annotEntries(lib, page)) doc.context.lookupMaybe(e, lib.PDFDict)?.set(lib.PDFName.of("P"), page.ref);
      }
    }
    placed.push({ key: s.key, page });
  }
  // 회전은 모든 사본을 뜬 **뒤에** — 같은 루프에서 돌리면 뒤 슬롯의 복제(cloneLeaf)가 이미 돈 leaf 를 떠 회전이 두 번 들어간다
  // (회전한 쪽을 복제하면 사본이 180° 로 저장됐다 — e2e 62 E5 · check-pages '회전한 쪽 복제').
  placed.forEach(({ page }, i) => {
    const rot = slots[i].rot;
    if (rot) page.setRotation(lib.degrees((page.getRotation().angle + rot) % 360));
  });

  if (!placed.length) throw new Error("applyPageOpsToDoc: a PDF needs at least one page");
  const same = placed.length === orig.length && placed.every((x, i) => x.page === orig[i]);
  if (!same) {
    const rootRef = doc.catalog.get(lib.PDFName.of("Pages"));
    if (!(rootRef instanceof lib.PDFRef)) throw new Error("applyPageOpsToDoc: catalog /Pages is not an indirect reference");
    const root = doc.catalog.Pages();
    for (const { page } of placed) {
      pinInherited(lib, page);
      page.node.set(lib.PDFName.of("Parent"), rootRef as PDFRef);
    }
    // 평평한 트리 하나로 — 옛 중간 /Pages 노드는 고아가 된다(증분이라 원본 바이트는 그대로).
    root.set(lib.PDFName.of("Kids"), doc.context.obj(placed.map((x) => x.page.ref)));
    root.set(lib.PDFName.of("Count"), lib.PDFNumber.of(placed.length));
  }
  return placed;
}

/** 표시용: 작업 사본 ⧺ 페이지 연산 증분(메모리 안). 파일에는 쓰지 않는다. */
export async function displayBytes(base: Uint8Array, ops: readonly PageOp[], read?: ReadPdfSource): Promise<Uint8Array> {
  if (!ops.length) return base.slice();
  const lib = await import("@cantoo/pdf-lib");
  const doc = await loadForIncrement(lib, base);
  await applyPageOpsToDoc(lib, doc, ops, read);
  const inc = await incrementOf(doc, base);
  const out = new Uint8Array(base.length + inc.length);
  out.set(base);
  out.set(inc, base.length);
  return out;
}

/** 추출: 지금 편집 상태가 반영된 파일 바이트 `full` 에서 `indices` 페이지만 새 문서로. */
export async function extractPages(full: Uint8Array, indices: readonly number[]): Promise<Uint8Array> {
  const lib = await import("@cantoo/pdf-lib");
  const src = await lib.PDFDocument.load(full, { updateMetadata: false });
  const pages = src.getPages();
  for (const i of indices) {
    const page = pages[i];
    if (!page) throw new Error(`extractPages: page index ${i} out of range (${pages.length} pages)`);
    detachAnnotsForCopy(lib, page);
  }
  const out = await lib.PDFDocument.create({ updateMetadata: false });
  for (const p of await out.copyPages(src, [...indices])) out.addPage(p);
  // 끊지 못한 길(추가 동작 /AA 등)로 고아가 된 페이지가 따라왔어도 트리 밖이라 여기서 콘텐츠째 지워진다.
  collectGarbage(lib, out);
  return out.save();
}

/**
 * 선택 key 의 페이지를 새 파일 `outRel` 로(같은 프로젝트, 있으면 ALREADY_EXISTS — 사용자가 확인하면 overwrite 로 다시). 지금 편집(주석·페이지 연산)을 반영하되
 * 원본 파일은 읽기만 한다. stamp 가 다르면 장부가 엉뚱한 객체를 가리키므로 막는다.
 */
export async function extractPagesToFile(
  projectId: string,
  path: string,
  expectedStamp: string,
  m: SaveModel,
  keys: readonly string[],
  outRel: string,
  overwrite = false,
): Promise<void> {
  if (outRel === path) throw new Error(`extractPagesToFile: target ${outRel} is the source file`);
  const now = await ipc.fileStamp(projectId, path);
  if (now !== expectedStamp) throw new Error(`extractPagesToFile: ${path} changed since it was loaded`);
  const disk = new Uint8Array(await ipc.readFileRaw(projectId, path));
  const { inc } = await buildIncrement(disk, m);
  const full = new Uint8Array(disk.length + inc.length);
  full.set(disk);
  full.set(inc, disk.length);
  const indices = keys.map((k) => {
    const i = m.infos.findIndex((info) => info.key === k);
    if (i < 0) throw new Error(`extractPagesToFile: page ${k} is not in the document`);
    return i;
  });
  await ipc.writeFileRaw(projectId, outRel, await extractPages(full, indices), { mode: "replace", overwrite });
}
