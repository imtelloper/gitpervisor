// PDF 저장 변형(설계 §7.2, 태스크 75 T4) — 다른 이름으로 저장 · 정리 저장 · 평탄화 내보내기.
//
// 셋 다 "지금 편집"을 먼저 일반 저장과 **같은** 증분(buildIncrement)으로 만든 뒤 시작한다 — 마크업·페이지 연산이
// 증분에 붙으면 여기도 저절로 따라온다. pdf-lib 은 동적 import 만(설계 §10).
//
// 정리 저장·평탄화는 증분이 아니라 전체 다시 쓰기다. pdf-lib 의 `save({ rewrite: true })` 는 컨텍스트의 **모든** 객체를
// 쓴다(쓰레기 수집 없음 — PDFWriter.computeBufferSize 가 enumerateIndirectObjects 그대로) — 지운 주석 사전이 이전
// 리비전에서 파싱돼 그대로 남는다. 그래서 trailer 에서 닿지 않는 객체를 먼저 지운다(collectGarbage).

import type { PDFDict, PDFDocument, PDFObject, PDFRef } from "@cantoo/pdf-lib";

import { currentLocale } from "../../i18n/locale-state";
import { messagesFor } from "../../i18n/messages";
import { ipc, type IpcError } from "../ipc";
import type { EditorDoc } from "../annotate/types";
import type { PdfLedger, PdfMarkup } from "./model";
import { buildIncrement, type SaveModel } from "./save";
import type { PdfLib } from "./write";

const t = () => messagesFor(currentLocale()).pdf.export;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

/** 원본 ⧺ 지금 편집의 증분. 편집이 없으면(m=null) 원본 그대로. */
async function withEdits(bytes: Uint8Array, m: SaveModel | null): Promise<{ full: Uint8Array; ledger: PdfLedger | null }> {
  if (!m) return { full: bytes, ledger: null };
  const { inc, ledger } = await buildIncrement(bytes, m);
  return { full: concat(bytes, inc), ledger };
}

/** 순수: 다른 이름으로 저장할 바이트 = 원본 ⧺ 일반 저장과 같은 증분. */
export async function buildSaveAs(bytes: Uint8Array, m: SaveModel | null): Promise<Uint8Array> {
  return (await withEdits(bytes, m)).full;
}

/** 지난 저장 뒤로 지운 노드가 있나 — 일반 저장 뒤 "정리 저장" 제안(설계 Q7)의 조건. */
export function hasDeletions(pages: EditorDoc[], ledger: PdfLedger, markups: readonly PdfMarkup[] = []): boolean {
  const live = new Set([...pages.flatMap((d) => d.objects.map((o) => o.id)), ...markups.map((mk) => mk.id)]);
  for (const id of ledger.refs.keys()) if (!live.has(id)) return true;
  return false;
}

// ── 판정 ─────────────────────────────────────────────────────────────────────

export type RewriteBlock = "encrypted" | "signed";

/** 값(/V)이 든 서명 필드가 있나. /FT 는 상속된다(부모 필드에만 있을 수 있다). */
function hasSignedField(lib: PdfLib, doc: PDFDocument): boolean {
  const N = (s: string) => lib.PDFName.of(s);
  const fields = doc.catalog.lookupMaybe(N("AcroForm"), lib.PDFDict)?.lookupMaybe(N("Fields"), lib.PDFArray);
  const seen = new Set<string>();
  const walk = (o: PDFObject, ft: PDFObject | undefined): boolean => {
    if (o instanceof lib.PDFRef) {
      if (seen.has(o.toString())) return false;
      seen.add(o.toString());
    }
    const d = doc.context.lookupMaybe(o, lib.PDFDict);
    if (!d) return false;
    const myFt = d.get(N("FT")) ?? ft;
    if (myFt === N("Sig") && d.has(N("V"))) return true;
    return (d.lookupMaybe(N("Kids"), lib.PDFArray)?.asArray() ?? []).some((k) => walk(k, myFt));
  };
  return (fields?.asArray() ?? []).some((f) => walk(f, undefined));
}

/** 전체 다시 쓰기용 로드 — 암호화 문서는 복호화 없이 다시 쓰면 내용이 깨지므로 판정만 하고 돌려준다. */
async function loadForRewrite(lib: PdfLib, bytes: Uint8Array): Promise<{ doc: PDFDocument; block: RewriteBlock | null }> {
  const doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) return { doc, block: "encrypted" };
  return { doc, block: hasSignedField(lib, doc) ? "signed" : null };
}

/** 정리 저장을 막는 사유 — 서명은 다시 쓰는 순간 무효가 된다, 암호화는 다시 쓸 수 없다. */
export async function cleanSaveBlock(bytes: Uint8Array): Promise<RewriteBlock | null> {
  const lib = await import("@cantoo/pdf-lib");
  return (await loadForRewrite(lib, bytes)).block;
}

function blockError(b: RewriteBlock): Error {
  return new Error(b === "signed" ? t().blockedSigned : t().blockedEncrypted);
}

// ── 다시 쓰기 ────────────────────────────────────────────────────────────────

/**
 * trailer(/Root·/Info)에서 닿지 않는 간접 객체를 지운다 — 이전 리비전에만 남은 주석·AP 가 여기서 사라진다.
 * 페이지 트리 밖의 페이지 leaf 로는 들어가지 않는다: 지운 페이지를 태그 구조(/StructTreeRoot … /Pg)·양식 필드(위젯 /P)·
 * 개요 /Dest 가 계속 가리키고, copyPages 는 주석 /P·필드 /Kids 를 따라 뽑지 않은 페이지를 고아로 끌고 온다 — 그 콘텐츠가
 * "닿는 객체"로 살아남아 파일에서 꺼낼 수 있었다(지운·뽑지 않은 쪽 유출). 남는 참조는 없는 객체를 가리키게 되고 그건 null 이다
 * (ISO 32000-1 §7.3.10).
 */
export function collectGarbage(lib: PdfLib, doc: PDFDocument): void {
  const ctx = doc.context;
  const N = (s: string) => lib.PDFName.of(s);
  const livePages = new Set(doc.getPages().map((p) => p.ref.toString()));
  const seen = new Set<string>();
  const stack: PDFObject[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info].filter((o): o is PDFObject => !!o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof lib.PDFRef) {
      if (seen.has(o.toString())) continue;
      const target = ctx.lookup(o);
      if (target instanceof lib.PDFDict && target.get(N("Type")) === N("Page") && !livePages.has(o.toString())) continue;
      seen.add(o.toString());
      if (target) stack.push(target);
    } else if (o instanceof lib.PDFDict) stack.push(...o.values());
    else if (o instanceof lib.PDFArray) stack.push(...o.asArray());
    else if (o instanceof lib.PDFStream) stack.push(...o.dict.values());
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
}

async function rewrite(lib: PdfLib, doc: PDFDocument): Promise<Uint8Array> {
  collectGarbage(lib, doc);
  // 폼 외관 재생성·빈 쪽 추가는 "다시 쓰기"가 아니라 내용 변경이다 — 끈다.
  return doc.save({ rewrite: true, updateFieldAppearances: false, addDefaultPage: false });
}

/** 순수: 원본 + 편집 → 이전 리비전 없는 새 파일. 서명·암호화 문서는 던진다. 객체 번호는 보존된다(장부 refs 그대로 유효). */
export async function buildCleanSave(
  bytes: Uint8Array,
  m: SaveModel | null,
): Promise<{ out: Uint8Array; ledger: PdfLedger | null }> {
  const lib = await import("@cantoo/pdf-lib");
  // 서명 판정은 편집 전 원본으로 — 증분을 먼저 만들면 그 사이 예외가 사유를 가린다.
  const pre = await loadForRewrite(lib, bytes);
  if (pre.block) throw blockError(pre.block);
  const { full, ledger } = await withEdits(bytes, m);
  const { doc } = await loadForRewrite(lib, full);
  return { out: await rewrite(lib, doc), ledger };
}

// ── 평탄화 ───────────────────────────────────────────────────────────────────

/** 주석이 보이는 외관 스트림(/AP /N, 상태 사전이면 /AS 상태). 없으면 null. */
function normalAppearance(lib: PdfLib, doc: PDFDocument, annot: PDFDict): PDFRef | null {
  const N = (s: string) => lib.PDFName.of(s);
  const ap = annot.lookupMaybe(N("AP"), lib.PDFDict);
  let n = ap?.get(N("N"));
  if (n && !(n instanceof lib.PDFRef)) {
    const states = doc.context.lookupMaybe(n, lib.PDFDict);
    const as = annot.get(N("AS"));
    n = states && as instanceof lib.PDFName ? states.get(as) : undefined;
  }
  return n instanceof lib.PDFRef && doc.context.lookup(n) instanceof lib.PDFStream ? n : null;
}

function numsOf(lib: PdfLib, d: PDFDict, key: string): number[] | null {
  const a = d.lookupMaybe(lib.PDFName.of(key), lib.PDFArray);
  if (!a) return null;
  const v = a.asArray().map((o) => (o instanceof lib.PDFNumber ? o.asNumber() : Number.NaN));
  return v.every(Number.isFinite) ? v : null;
}

const fmt = (v: number) => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? "0" : String(r);
};

/**
 * PDF 32000 §12.5.5 — 외관의 BBox 를 /Matrix 로 옮긴 경계를 /Rect 에 맞추는 행렬 A. `Do` 가 /Matrix 를 스스로 적용하므로
 * 콘텐츠에는 A 만 건다.
 */
function placeMatrix(rect: number[], bbox: number[], m: number[]): number[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  const [tx0, tx1, ty0, ty1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [rx0, rx1] = [Math.min(rect[0], rect[2]), Math.max(rect[0], rect[2])];
  const [ry0, ry1] = [Math.min(rect[1], rect[3]), Math.max(rect[1], rect[3])];
  const sx = tx1 > tx0 ? (rx1 - rx0) / (tx1 - tx0) : 1;
  const sy = ty1 > ty0 ? (ry1 - ry0) / (ty1 - ty0) : 1;
  return [sx, 0, 0, sy, rx0 - sx * tx0, ry0 - sy * ty0];
}

/** /F 의 Hidden(2)·NoView(32) — 화면에 안 보이는 주석은 평탄화해도 그리지 않는다(지우기만). */
const invisible = (f: number) => (f & 2) !== 0 || (f & 32) !== 0;
/** 페이지 내용이 아니라 상호작용 요소 — 평탄화 대상이 아니다. Popup 은 부모를 따라간다. */
const KEEP = new Set(["Widget", "Link", "Popup"]);

/** 순수: 원본 + 편집 → 주석 외관을 페이지 내용으로 구운 새 파일. 원본 바이트는 건드리지 않는다. */
export async function buildFlatten(bytes: Uint8Array, m: SaveModel | null): Promise<Uint8Array> {
  const lib = await import("@cantoo/pdf-lib");
  const N = (s: string) => lib.PDFName.of(s);
  const { full } = await withEdits(bytes, m);
  const { doc, block } = await loadForRewrite(lib, full);
  if (block === "encrypted") throw blockError(block);
  const ctx = doc.context;

  for (const page of doc.getPages()) {
    const raw = page.node.get(N("Annots"));
    const arr = raw ? ctx.lookupMaybe(raw, lib.PDFArray) : undefined;
    if (!arr) continue;
    const gone = new Set<string>();
    const ops: string[] = [];
    for (const e of arr.asArray()) {
      const d = ctx.lookupMaybe(e, lib.PDFDict);
      const sub = d?.get(N("Subtype"));
      if (!d || !(sub instanceof lib.PDFName) || KEEP.has(sub.decodeText())) continue;
      const apRef = normalAppearance(lib, doc, d);
      const rect = numsOf(lib, d, "Rect");
      if (!apRef || !rect || rect.length !== 4) continue; // 외관이 없으면 뷰어가 그리는 것 — 그대로 둔다
      gone.add(e.toString());
      const f = d.lookupMaybe(N("F"), lib.PDFNumber)?.asNumber() ?? 0;
      if (invisible(f)) continue;
      const form = ctx.lookup(apRef, lib.PDFStream);
      const bbox = numsOf(lib, form.dict, "BBox");
      if (!bbox || bbox.length !== 4) continue;
      // 외관 스트림이 /Type·/Subtype 을 생략해도 주석으로는 그려진다 — Do 로 부르려면 Form XObject 여야 한다.
      form.dict.set(N("Type"), N("XObject"));
      form.dict.set(N("Subtype"), N("Form"));
      const name = page.node.newXObject("GpvFlat", apRef);
      const a = placeMatrix(rect, bbox, numsOf(lib, form.dict, "Matrix") ?? [1, 0, 0, 1, 0, 0]);
      // 주석 /CA(§12.5.2)는 외관 전체에 걸리는 불투명도다. 외관이 자기 ExtGState 로 불투명도를 이미 굽는 경우(우리 것·pdf.js 가
      // 쓴 것은 둘 다 /CA 와 외관 gs 를 같이 쓴다)에 또 걸면 두 번 옅어진다 — 외관에 ExtGState 가 없을 때만 건다.
      // ponytail: 외관이 gs 를 쓰되 불투명도와 무관한 값(선 굵기 등)만 담은 경우는 /CA 를 놓친다 — 필요해지면 gs 값을 읽어 가른다.
      const ca = d.lookupMaybe(N("CA"), lib.PDFNumber)?.asNumber() ?? 1;
      const ownGs = form.dict.lookupMaybe(N("Resources"), lib.PDFDict)?.has(N("ExtGState")) ?? false;
      const gs = ca < 1 && !ownGs ? `${page.node.newExtGState("GpvCA", ctx.obj({ Type: "ExtGState", CA: ca, ca })).toString()} gs ` : "";
      ops.push(`q ${gs}${a.map(fmt).join(" ")} cm ${name.toString()} Do Q`);
    }
    if (!gone.size) continue;
    const kept = arr.asArray().filter((e) => {
      if (gone.has(e.toString())) return false;
      const parent = ctx.lookupMaybe(e, lib.PDFDict)?.get(N("Parent"));
      return !(parent instanceof lib.PDFRef && gone.has(parent.toString()));
    });
    if (kept.length) page.node.set(N("Annots"), ctx.obj(kept));
    else page.node.delete(N("Annots"));
    // 새 파일이라 L2(원본 페이지 보존)는 해당 없다 — addContentStream 의 normalize 가 기존 내용을 q/Q 로 감싸
    // 원래 콘텐츠가 남긴 그래픽 상태가 우리 cm 에 새지 않게 한다.
    if (ops.length) page.node.addContentStream(ctx.register(ctx.flateStream(ops.join("\n"))));
  }
  return rewrite(lib, doc);
}

// ── 경로 ─────────────────────────────────────────────────────────────────────

/** `a/b/report.pdf` → `a/b/report-flattened.pdf`. */
export function flattenedName(path: string): string {
  const m = /^(.*?)(\.pdf)?$/i.exec(path)!;
  return `${m[1]}-flattened${m[2] ?? ".pdf"}`;
}

/** 사용자 입력 경로 → 레포 상대 경로(슬래시·앞 ./ 정리, .pdf 보장). 레포 밖 판정은 Rust resolve_in_repo 몫이다. */
export function normalizeTargetPath(input: string): string {
  let p = input.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
  if (p && !/\.pdf$/i.test(p)) p += ".pdf";
  return p;
}

// ── IPC ──────────────────────────────────────────────────────────────────────

function conflictError(path: string): IpcError {
  return { code: "CONFLICT", message: messagesFor(currentLocale()).pdf.core.changedExternally(path), stderr: null };
}

/** 장부가 가리키는 판인지 확인하고 읽는다 — 편집이 다른 판 위에 붙으면 refs 가 엉뚱한 객체를 가리킨다. */
async function readExpected(projectId: string, path: string, expectedStamp: string): Promise<Uint8Array> {
  if ((await ipc.fileStamp(projectId, path)) !== expectedStamp) throw conflictError(path);
  const bytes = new Uint8Array(await ipc.readFileRaw(projectId, path));
  if ((await ipc.fileStamp(projectId, path)) !== expectedStamp) throw conflictError(path);
  return bytes;
}

/** 다른 이름으로 저장 — `원본 ⧺ 증분`을 새 경로에. 있으면 ALREADY_EXISTS(overwrite 로 다시 부르면 덮어쓴다). 원본은 불변. */
export async function saveAsPdf(
  projectId: string,
  path: string,
  expectedStamp: string,
  target: string,
  m: SaveModel | null,
  overwrite: boolean,
): Promise<void> {
  const bytes = await readExpected(projectId, path, expectedStamp);
  await ipc.writeFileRaw(projectId, target, await buildSaveAs(bytes, m), { mode: "replace", overwrite });
}

/** 정리 저장 — 제자리 전체 다시 쓰기(expectedStamp 로 덮어쓰기 경합을 막는다). 새 stamp 와 저장 뒤 장부. */
export async function cleanSavePdf(
  projectId: string,
  path: string,
  expectedStamp: string,
  m: SaveModel | null,
): Promise<{ stamp: string; ledger: PdfLedger | null }> {
  const bytes = await readExpected(projectId, path, expectedStamp);
  const { out, ledger } = await buildCleanSave(bytes, m);
  const stamp = await ipc.writeFileRaw(projectId, path, out, { mode: "replace", overwrite: true, expectedStamp });
  // 쓰기는 끝났는데 mtime 을 못 읽는 파일시스템 — savePdf 와 같은 처리.
  return { stamp: stamp ?? (await ipc.fileStamp(projectId, path)) ?? "", ledger };
}

/** 평탄화 내보내기 — 새 파일(overwrite 는 사용자가 확인했을 때만). 원본은 불변. */
export async function flattenPdf(
  projectId: string,
  path: string,
  expectedStamp: string,
  target: string,
  m: SaveModel | null,
  overwrite: boolean,
): Promise<void> {
  const bytes = await readExpected(projectId, path, expectedStamp);
  await ipc.writeFileRaw(projectId, target, await buildFlatten(bytes, m), { mode: "replace", overwrite });
}
