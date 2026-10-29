// PDF 저장 변형(src/lib/pdf/export.ts)·초안(draft.ts) Node 자가 검사 — DOCS/task/75-pdf-m3-m4.md T4·T5.
//
//   node tests/pdf/check-export.mjs        (실패하면 비 0 종료)
//
// core-check.mjs 와 같은 방식: TS 원본을 esbuild 로 Node 번들(임시 폴더)로 묶어 돌린다. 픽스처는 메모리에서 만들고
// 디스크의 PDF 는 건드리지 않는다. IPC 경로(saveAsPdf 등)는 순수 함수 위의 얇은 래퍼라 여기서는 순수 함수를 본다.

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "gpv-pdf-export-"));
const outfile = join(dir, "export.mjs");
await build({
  stdin: {
    contents: [
      'export { buildIncrement } from "./src/lib/pdf/save.ts";',
      'export { importAnnotations } from "./src/lib/pdf/import.ts";',
      'export { buildCleanSave, buildFlatten, buildSaveAs, cleanSaveBlock, hasDeletions, flattenedName, normalizeTargetPath } from "./src/lib/pdf/export.ts";',
      'export { serializeDraft, parseDraft, restoreDraft } from "./src/lib/pdf/draft.ts";',
      'export { normalizeDoc } from "./src/lib/annotate/schema.ts";',
      'export { emptyLedger } from "./src/lib/pdf/model.ts";',
      'export * as pdfLib from "@cantoo/pdf-lib";',
    ].join("\n"),
    resolveDir: ROOT,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  logLevel: "error",
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
const core = await import(pathToFileURL(outfile).href);
const {
  buildIncrement,
  importAnnotations,
  buildCleanSave,
  buildFlatten,
  buildSaveAs,
  cleanSaveBlock,
  hasDeletions,
  flattenedName,
  normalizeTargetPath,
  serializeDraft,
  parseDraft,
  restoreDraft,
  normalizeDoc,
  emptyLedger,
  pdfLib: L,
} = core;

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

// ── 도우미 ───────────────────────────────────────────────────────────────────
const latin1 = (b) => Buffer.from(b).toString("latin1");
const concat = (a, b) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};
const solid = (color, opacity = 1) => ({ type: "solid", color, opacity, visible: true, blend: "normal" });
const textLines = (n) => n.text.split("\n").map((t, i) => ({ text: t, x: n.x, baseline: n.y + n.fontSize * (i + 1) }));

/** /NM·/GPV_Node 에 들어가는 형태(PDFHexString.fromText = UTF-16BE+BOM hex) — 원시 바이트와 풀어 본 모든 Flate 스트림에서 센다. */
function occurrences(bytes, id) {
  const hex = "FEFF" + [...id].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()).join("");
  const hay = [latin1(bytes)];
  const s = latin1(bytes);
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      hay.push(latin1(inflateSync(bytes.subarray(start, end))));
    } catch {
      // Flate 가 아닌 스트림(이미지 등) — 셀 대상이 아니다
    }
  }
  return hay.reduce((k, h) => k + h.split(hex).length - 1 + h.split(hex.toLowerCase()).length - 1, 0);
}

async function pageInfos(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const infos = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const vp = p.getViewport({ scale: 1 });
    infos.push({ index: i - 1, key: `${p.ref.num} ${p.ref.gen} R`, w: vp.width, h: vp.height, toPage: [...vp.transform] });
  }
  await task.destroy();
  return infos;
}

async function renderAll(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: 0,
    standardFontDataUrl: join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + "/",
  });
  const doc = await task.promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    out.push(context.getImageData(0, 0, canvas.width, canvas.height));
  }
  await task.destroy();
  return out;
}

/** 두 렌더의 채널 차 > 48 인 픽셀 수와 잉크(비흰색) 픽셀 수. */
function pixelDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { bad: Infinity, ink: 0 };
  let bad = 0;
  let ink = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 48) bad++;
    if (a.data[i] < 200 || a.data[i + 1] < 200 || a.data[i + 2] < 200) ink++;
  }
  return { bad, ink };
}

async function libAnnots(bytes) {
  const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const raw = p.node.get(L.PDFName.of("Annots"));
    const arr = raw ? doc.context.lookup(raw) : null;
    return (arr ? arr.asArray() : []).map((e) => doc.context.lookup(e).get(L.PDFName.of("Subtype")).decodeText());
  });
}

async function makeFixture(classic) {
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(L.StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  p0.drawText("page one", { x: 72, y: 700, size: 18, font: helv });
  const p1 = doc.addPage([612, 792]);
  p1.setRotation(L.degrees(90));
  p1.drawText("rotated page", { x: 72, y: 700, size: 18, font: helv });
  // 외관 없는 다른 앱 메모 — 평탄화 대상이 아니다(끝까지 /Annots 에 남아야 한다).
  const note = doc.context.register(
    doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [500, 700, 520, 720], Contents: L.PDFHexString.fromText("foreign note") }),
  );
  p0.node.set(L.PDFName.of("Annots"), doc.context.obj([note]));
  if (classic) doc.context.header = L.PDFHeader.forVersion(1, 3);
  return new Uint8Array(await doc.save({ useObjectStreams: !classic }));
}

function makeNodes() {
  const base = { opacity: 1, strokeWidth: 3 };
  return [
    normalizeDoc({
      objects: [
        { id: "n-del", kind: "rect", x: 80, y: 120, w: 200, h: 90, ...base, strokes: [solid("#FF3B30")], fills: [solid("#FFCC00", 0.5)] },
        { id: "n-keep", kind: "ellipse", x: 320, y: 120, w: 150, h: 100, ...base, rot: 30, strokes: [solid("#0A84FF")], fills: [] },
        { id: "n-arrow", kind: "arrow", x1: 80, y1: 400, x2: 400, y2: 460, ...base, strokes: [solid("#AF52DE")], fills: [], heads: { start: "none", end: "arrow" } },
      ],
    }),
    normalizeDoc({
      objects: [
        { id: "n-pen", kind: "pen", pts: [100, 100, 120, 130, 150, 120, 180, 160, 220, 140], ...base, strokes: [solid("#1C1C1E")], fills: [] },
        { id: "n-hl", kind: "highlight", pts: [100, 250, 300, 252], strokeWidth: 16, strokes: [solid("#FFCC00")], fills: [] },
      ],
    }),
  ];
}

async function makeSigned(withValue) {
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([300, 300]);
  const ctx = doc.context;
  const sigV = ctx.register(ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", ByteRange: [0, 0, 0, 0], Contents: L.PDFHexString.of("00") }));
  // 부모에만 /FT 가 있는 필드 트리 — /FT 상속까지 따라가야 걸린다.
  const parent = ctx.register(ctx.obj({ FT: "Sig", T: L.PDFString.of("sig") }));
  const kid = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 0, 0], Parent: parent, P: page.ref, ...(withValue ? { V: sigV } : {}) }),
  );
  ctx.lookup(parent).set(L.PDFName.of("Kids"), ctx.obj([kid]));
  page.node.set(L.PDFName.of("Annots"), ctx.obj([kid]));
  doc.catalog.set(L.PDFName.of("AcroForm"), ctx.obj({ Fields: [parent], SigFlags: 3 }));
  return new Uint8Array(await doc.save());
}

// ── 회차 ─────────────────────────────────────────────────────────────────────
async function run(label, classic) {
  console.log(`\n[${label}]`);
  const bytes = await makeFixture(classic);
  const infos = await pageInfos(bytes);
  const pages = makeNodes();
  const model = (p, ledger) => ({ infos, pages: p, ledger, textLines, font: null });

  // 저장 1 → 가져오기 → n-del 삭제 후 일반(증분) 저장 = 대조군
  const s1 = await buildIncrement(bytes, model(pages, emptyLedger()));
  const file1 = concat(bytes, s1.inc);
  const imp1 = await importAnnotations(file1, infos, null);
  const p0del = { ...imp1.pages[0], objects: imp1.pages[0].objects.filter((n) => n.id !== "n-del") };
  const pagesDel = [p0del, imp1.pages[1]];
  check("hasDeletions: 지운 뒤 true / 지우기 전 false", hasDeletions(pagesDel, imp1.ledger) && !hasDeletions(imp1.pages, imp1.ledger));
  const s2 = await buildIncrement(file1, model(pagesDel, imp1.ledger));
  const file2 = concat(file1, s2.inc);
  check("대조군: 증분 저장 뒤에도 지운 주석 /NM 이 파일에 남는다(≥1)", occurrences(file2, "n-del") >= 1, String(occurrences(file2, "n-del")));
  check("대조군: 증분 저장본 /Annots 에서는 빠졌다", !(await libAnnots(file2))[0].includes("Square"));

  // 정리 저장 — 편집 없이(디스크 판 다시 쓰기)
  const before = file2.slice();
  const c1 = await buildCleanSave(file2, null);
  check("정리 저장: 지운 주석 /NM 0건", occurrences(c1.out, "n-del") === 0, String(occurrences(c1.out, "n-del")));
  check("정리 저장: 남은 주석은 그대로(≥1)", occurrences(c1.out, "n-keep") >= 1);
  check("정리 저장: 입력 바이트 불변", Buffer.compare(Buffer.from(before), Buffer.from(file2)) === 0);
  const ic1 = await importAnnotations(c1.out, infos, null);
  check(
    "정리 저장: 다시 가져오면 같은 노드·같은 ref(객체 번호 보존)",
    ic1.pages[0].objects.map((n) => n.id).join() === "n-keep,n-arrow" &&
      [...ic1.ledger.refs].every(([id, ref]) => s2.ledger.refs.get(id) === ref),
    JSON.stringify([[...ic1.ledger.refs], [...s2.ledger.refs]]),
  );
  check("정리 저장: 이전 리비전 없음(startxref 1개)", (latin1(c1.out).match(/startxref/g) ?? []).length === 1);

  // 정리 저장 — 편집 적용(UI 경로: 증분 저장 전 세션 그대로)
  const c2 = await buildCleanSave(file1, model(pagesDel, imp1.ledger));
  check("정리 저장(편집 적용): 지운 주석 /NM 0건", occurrences(c2.out, "n-del") === 0, String(occurrences(c2.out, "n-del")));
  const ic2 = await importAnnotations(c2.out, infos, null);
  check(
    "정리 저장(편집 적용): 돌려준 장부 = 다시 가져온 장부",
    !!c2.ledger && [...ic2.ledger.refs].length === c2.ledger.refs.size && [...ic2.ledger.refs].every(([id, ref]) => c2.ledger.refs.get(id) === ref),
  );
  check("정리 저장(편집 적용): 메모 주석 보존", (await libAnnots(c2.out))[0].includes("Text"));

  // 다른 이름으로 저장 = 원본 ⧺ 증분
  const sa = await buildSaveAs(file1, model(pagesDel, imp1.ledger));
  check("다른 이름: 접두사 = 원본", Buffer.compare(Buffer.from(sa.subarray(0, file1.length)), Buffer.from(file1)) === 0);
  check("다른 이름: 뒤는 증분(%PDF 로 시작하지 않음)", sa.length > file1.length && !latin1(sa.subarray(file1.length, file1.length + 8)).startsWith("%PDF"));
  const isa = await importAnnotations(sa, infos, null);
  check("다른 이름: 편집 반영(n-del 없음)", !isa.pages[0].objects.some((n) => n.id === "n-del") && isa.pages[0].objects.length === 2);
  check("다른 이름(편집 없음): 원본 그대로", Buffer.compare(Buffer.from(await buildSaveAs(file1, null)), Buffer.from(file1)) === 0);

  // 평탄화 — 파일에 이미 있는 주석(file1) / 아직 저장 안 한 편집(bytes + model) 두 경로
  for (const [name, src, m] of [
    ["파일 주석", file1, null],
    ["저장 안 한 편집", bytes, model(pages, emptyLedger())],
  ]) {
    const keep = src.slice();
    const flat = await buildFlatten(src, m);
    const ann = await libAnnots(flat);
    check(`평탄화(${name}): /Annots 에 우리 주석 0 · 메모만 남음`, ann[0].join() === "Text" && ann[1].length === 0, JSON.stringify(ann));
    check(`평탄화(${name}): 노드 JSON(/GPV_Node) 흔적 0`, occurrences(flat, "n-keep") === 0 && occurrences(flat, "n-pen") === 0);
    check(`평탄화(${name}): 입력 바이트 불변`, Buffer.compare(Buffer.from(keep), Buffer.from(src)) === 0);
    const ra = await renderAll(file1);
    const rb = await renderAll(flat);
    for (let i = 0; i < ra.length; i++) {
      const d = pixelDiff(ra[i], rb[i]);
      // 앤티앨리어싱 가장자리만 허용 — 주석이 통째로 빠지거나 옮겨지면 잉크 수천 px 가 어긋난다.
      check(`평탄화(${name}) 쪽 ${i + 1}: pdf.js 픽셀 = 평탄화 전(차이 ${d.bad}px / 잉크 ${d.ink}px)`, d.ink > 1000 && d.bad <= 30, `${d.bad}`);
    }
  }
  // 반증: 평탄화 대신 주석만 지운 파일은 픽셀 검사에 걸려야 한다(검사가 유효한지).
  const stripped = await buildFlatten(bytes, null);
  const dNo = pixelDiff((await renderAll(file1))[0], (await renderAll(stripped))[0]);
  check("반증: 주석 없는 판은 픽셀 검사에서 크게 어긋난다", dNo.bad > 1000, String(dNo.bad));
}

async function drafts() {
  console.log("\n[초안]");
  const bytes = await makeFixture(false);
  const infos = await pageInfos(bytes);
  const s1 = await buildIncrement(bytes, { infos, pages: makeNodes(), ledger: emptyLedger(), textLines, font: null });
  const file1 = concat(bytes, s1.inc);
  const imp = await importAnnotations(file1, infos, null);
  // 편집: n-del 이동, n-arrow 삭제, 새 노드 추가
  const p0 = imp.pages[0].objects
    .filter((n) => n.id !== "n-arrow")
    .map((n) => (n.id === "n-del" ? { ...n, x: n.x + 15 } : n));
  const extra = normalizeDoc({ objects: [{ id: "n-new", kind: "rect", x: 10, y: 10, w: 20, h: 20, opacity: 1, strokeWidth: 1, strokes: [solid("#000000")], fills: [] }] }).objects;
  const pages = [{ ...imp.pages[0], objects: [...p0, ...extra] }, imp.pages[1]];
  const json = serializeDraft({ stamp: "123:456", pages, markups: [], pageOps: [], ledger: imp.ledger });
  const d = parseDraft(json);
  check("초안 왕복: stamp·쪽 수", d.stamp === "123:456" && d.pages.length === 2);
  // 같은 판을 다시 가져온 장부로 복원(앱 재시작 경로)
  const again = await importAnnotations(file1, infos, null);
  const r = restoreDraft(d, again.ledger);
  const ids = r.pages[0].objects.map((n) => n.id).join();
  check("복원: 노드 목록", ids === "n-del,n-keep,n-new", ids);
  const keepNode = r.pages[0].objects.find((n) => n.id === "n-keep");
  check("복원: 손대지 않은 노드는 가져온 참조(다시 쓰지 않음)", keepNode === r.ledger.saved.get("n-keep"));
  check("복원: 옮긴 노드는 changed", r.pages[0].objects.find((n) => n.id === "n-del") !== r.ledger.saved.get("n-del"));
  // 복원한 상태로 저장 → 다시 열면 편집 그대로, 지운 화살표는 없음
  const s2 = await buildIncrement(file1, { infos, pages: r.pages, ledger: r.ledger, textLines, font: null });
  const file2 = concat(file1, s2.inc);
  const imp2 = await importAnnotations(file2, infos, null);
  const got = imp2.pages[0].objects;
  check(
    "복원 후 저장: 이동·삭제·추가 반영, 주석 중복 없음",
    got.map((n) => n.id).join() === "n-del,n-keep,n-new" && Math.abs(got[0].x - 95) < 0.01 && (await libAnnots(file2))[0].length === 4,
    JSON.stringify([got.map((n) => n.id), (await libAnnots(file2))[0]]),
  );
  check("복원 후 저장: 안 바뀐 타원은 증분에 없음", !latin1(s2.inc).includes(`\n${imp.ledger.refs.get("n-keep").replace(" R", " obj")}`));
  let threw = false;
  try {
    parseDraft('{"v":2}');
  } catch {
    threw = true;
  }
  check("parseDraft: 모르는 봉투는 던진다", threw);
}

async function guards() {
  console.log("\n[막기·경로]");
  const signed = await makeSigned(true);
  check("서명 문서: cleanSaveBlock = signed", (await cleanSaveBlock(signed)) === "signed");
  let msg = "";
  try {
    await buildCleanSave(signed, null);
  } catch (e) {
    msg = e.message;
  }
  check("서명 문서: 정리 저장 거부(사유 문구)", msg.length > 0 && !msg.includes("parse"), msg);
  check("대조군: 값 없는 서명 필드는 막지 않음", (await cleanSaveBlock(await makeSigned(false))) === null);
  const enc = await L.PDFDocument.create();
  enc.addPage([100, 100]);
  enc.encrypt({ userPassword: "u", ownerPassword: "o" });
  check("암호화 문서: cleanSaveBlock = encrypted", (await cleanSaveBlock(new Uint8Array(await enc.save()))) === "encrypted");
  check("flattenedName", flattenedName("docs/a b.PDF") === "docs/a b-flattened.PDF" && flattenedName("x") === "x-flattened.pdf");
  check("normalizeTargetPath", normalizeTargetPath(" .\\out\\\\copy ") === "out/copy.pdf" && normalizeTargetPath("a.pdf") === "a.pdf");
}

/** 원시 바이트 + 풀 수 있는 모든 Flate 스트림에서 문자열 개수. */
function countIn(bytes, needle) {
  const s = latin1(bytes);
  const hay = [s];
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const st = m.index + m[0].length;
    const en = s.indexOf("endstream", st);
    if (en < 0) continue;
    try {
      hay.push(latin1(inflateSync(bytes.subarray(st, en))));
    } catch {
      // Flate 가 아닌 스트림 — 원시 바이트 쪽에서 이미 셌다
    }
  }
  return hay.reduce((k, h) => k + h.split(needle).length - 1, 0);
}

// 페이지 모드에서 지운 쪽은 정리 저장 뒤 파일에 없어야 한다 — 태그 PDF(구조 원소 /Pg)·양식(필드 → 위젯 /P)·개요(/Dest)가
// 그 쪽을 계속 가리켜도. 이 경로들로 "닿는 객체"가 되어 지운 쪽 콘텐츠가 통째로 남았다.
async function deletedPageGone() {
  console.log("\n[정리 저장: 지운 쪽]");
  for (const kind of ["control", "tagged", "form", "outline"]) {
    const doc = await L.PDFDocument.create({ updateMetadata: false });
    const p0 = doc.addPage([300, 300]);
    const p1 = doc.addPage([300, 300]);
    const ctx = doc.context;
    p0.node.addContentStream(ctx.register(ctx.stream("% PUBLIC-ONE")));
    p1.node.addContentStream(ctx.register(ctx.stream("% SECRET-TWO")));
    if (kind === "tagged") {
      const e0 = ctx.obj({ Type: "StructElem", S: "P", Pg: p0.ref, K: 0 });
      const e1 = ctx.obj({ Type: "StructElem", S: "P", Pg: p1.ref, K: 0 });
      doc.catalog.set(L.PDFName.of("StructTreeRoot"), ctx.register(ctx.obj({ Type: "StructTreeRoot", K: [e0, e1] })));
    } else if (kind === "form") {
      const field = ctx.register(ctx.obj({ FT: "Tx", T: L.PDFString.of("initials") }));
      const w0 = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 60, 30], P: p0.ref, Parent: field }));
      const w1 = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 60, 30], P: p1.ref, Parent: field }));
      ctx.lookup(field).set(L.PDFName.of("Kids"), ctx.obj([w0, w1]));
      p0.node.set(L.PDFName.of("Annots"), ctx.obj([w0]));
      p1.node.set(L.PDFName.of("Annots"), ctx.obj([w1]));
      doc.catalog.set(L.PDFName.of("AcroForm"), ctx.obj({ Fields: [field] }));
    } else if (kind === "outline") {
      const outlines = ctx.nextRef();
      const item = ctx.register(ctx.obj({ Title: L.PDFString.of("two"), Parent: outlines, Dest: [p1.ref, "Fit"] }));
      ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
      doc.catalog.set(L.PDFName.of("Outlines"), outlines);
    }
    const src = new Uint8Array(await doc.save({ useObjectStreams: false }));
    const keys = doc.getPages().map((p) => p.ref.toString());
    const infos = await pageInfos(src);
    const m = {
      infos: [infos[0]],
      pages: [normalizeDoc({ objects: [] })],
      ledger: emptyLedger(),
      textLines,
      font: null,
      pageOps: [{ kind: "delete", keys: [keys[1]] }],
      markups: [],
    };
    const { out } = await buildCleanSave(src, m);
    const shown = await pageInfos(out);
    check(`${kind}: 1쪽·남은 쪽 콘텐츠 있음`, shown.length === 1 && countIn(out, "PUBLIC-ONE") === 1, JSON.stringify([shown.length, countIn(out, "PUBLIC-ONE")]));
    check(`${kind}: 지운 쪽 콘텐츠 0(전: ${countIn(src, "SECRET-TWO")})`, countIn(out, "SECRET-TWO") === 0, String(countIn(out, "SECRET-TWO")));
    // 지운 쪽을 가리키던 참조는 없는 객체 = null — pdf.js 가 그 경로(구조 트리)를 읽다 넘어지지 않는다.
    const task = pdfjs.getDocument({ data: out.slice(), verbosity: 0 });
    const pd = await task.promise;
    let err = "";
    try {
      await (await pd.getPage(1)).getStructTree();
      await pd.getOutline();
    } catch (e) {
      err = String(e);
    }
    await task.destroy();
    check(`${kind}: pdf.js 구조 트리·개요 읽기`, err === "", err);
  }
}

// 다른 앱 주석의 /CA — 외관에 자기 ExtGState 가 없으면 평탄화가 /CA 를 걸고(빨강 → 분홍), 있으면 다시 걸지 않는다(두 번 옅어짐 방지).
async function flattenOpacity() {
  console.log("\n[평탄화 /CA]");
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([200, 100]);
  const ctx = doc.context;
  const ap = (gs) =>
    ctx.register(
      ctx.stream(`${gs ? "/G gs " : ""}1 0 0 rg 0 0 40 40 re f`, {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 40, 40],
        ...(gs ? { Resources: { ExtGState: { G: { Type: "ExtGState", ca: 0.5, CA: 0.5 } } } } : {}),
      }),
    );
  const annot = (x, gs) => ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [x, 30, x + 40, 70], CA: 0.5, F: 4, AP: { N: ap(gs) } }));
  page.node.set(L.PDFName.of("Annots"), ctx.obj([annot(20, false), annot(120, true)]));
  const bytes = new Uint8Array(await doc.save());
  const [img] = await renderAll(await buildFlatten(bytes, null));
  const px = (x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  const a = px(40, 50);
  const b = px(140, 50);
  check("평탄화 /CA: 외관에 gs 없음 → /CA 0.5 적용(분홍)", a[0] > 230 && a[1] > 100 && a[1] < 160, JSON.stringify(a));
  check("평탄화 /CA: 외관이 gs 로 이미 0.5 → 한 번만(분홍, 더 옅지 않음)", b[0] > 230 && b[1] > 100 && b[1] < 160, JSON.stringify(b));
}

try {
  await run("classic xref %PDF-1.3", true);
  await run("xref stream %PDF-1.7", false);
  await drafts();
  await guards();
  await deletedPageGone();
  await flattenOpacity();
} catch (e) {
  failed++;
  console.error("\nFAIL (exception)", e);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
