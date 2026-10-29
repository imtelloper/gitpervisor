// PDF 페이지 관리(M4, src/lib/pdf/pages.ts) Node 왕복 자가 검사 — DOCS/task/75 T6.
//
//   node tests/pdf/check-pages.mjs        (실패하면 비 0 종료)
//
// core-check.mjs 와 같은 방식: TS 원본을 esbuild 로 Node 번들(임시 파일)로 묶고, 픽스처는 메모리에서 만든다.
// 픽스처 2쪽·3쪽은 중간 /Pages 노드에서 MediaBox 를 물려받는다 — 트리를 평평하게 다시 엮을 때 상속이 안 끊기는지.

import { build } from "esbuild";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";

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

const dir = mkdtempSync(join(tmpdir(), "gpv-pdf-pages-"));
const outfile = join(dir, "pages.mjs");
await build({
  stdin: {
    contents: [
      'export { buildIncrement, isDirty, lastTrailerSize } from "./src/lib/pdf/save.ts";',
      'export { importAnnotations } from "./src/lib/pdf/import.ts";',
      'export { applyPageOp, displayBytes, extractPages } from "./src/lib/pdf/pages.ts";',
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
const { buildIncrement, isDirty, lastTrailerSize, importAnnotations, applyPageOp, displayBytes, extractPages, normalizeDoc, emptyLedger, pdfLib: L } = core;

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
const solid = (color) => ({ type: "solid", color, opacity: 1, visible: true, blend: "normal" });
const textLines = () => [];

async function pageInfos(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const infos = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    infos.push({ index: i - 1, key: `${page.ref.num} ${page.ref.gen} R`, w: vp.width, h: vp.height, toPage: [...vp.transform] });
  }
  await task.destroy();
  return infos;
}

/** pdf-lib 새 로드 — 페이지별 {key, rotate, contents, subtypes} 와 페이지 트리 /Count. */
async function libPages(bytes) {
  const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages().map((p) => {
    const raw = p.node.get(L.PDFName.of("Annots"));
    const arr = raw ? doc.context.lookup(raw) : null;
    return {
      key: p.ref.toString(),
      rotate: p.getRotation().angle,
      contents: String(p.node.get(L.PDFName.of("Contents"))),
      subtypes: (arr ? arr.asArray() : []).map((e) => doc.context.lookup(e).get(L.PDFName.of("Subtype")).decodeText()),
    };
  });
  const leaves = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof L.PDFDict && o.get(L.PDFName.of("Type")) === L.PDFName.of("Page")).length;
  return { pages, count: doc.catalog.Pages().Count().asNumber(), leaves };
}

async function renderPage(bytes, pageNo) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + "/" });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const img = context.getImageData(0, 0, canvas.width, canvas.height);
  await task.destroy();
  return (x, y) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
}
const close = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

function near(a, b, path = "") {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 0.01 ? null : `${path}: ${a} != ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = near(a[i], b[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const r = near(a[k], b[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}
const geomOf = (infos) => infos.map((i) => ({ key: i.key, w: i.w, h: i.h, toPage: i.toPage }));

// ── 픽스처 ───────────────────────────────────────────────────────────────────
async function makeMain(classic) {
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(L.StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  p0.drawText("page A", { x: 72, y: 700, size: 18, font: helv });
  const p1 = doc.addPage([400, 300]);
  p1.drawText("page B", { x: 40, y: 200, size: 18, font: helv });
  const p2 = doc.addPage([400, 300]);
  p2.drawText("page C", { x: 40, y: 200, size: 18, font: helv });
  p2.setRotation(L.degrees(90));
  // 2·3쪽을 중간 /Pages 아래로 — MediaBox 는 거기서만 물려받는다.
  const ctx = doc.context;
  const rootRef = doc.catalog.get(L.PDFName.of("Pages"));
  const mid = ctx.obj({ Type: "Pages", Parent: rootRef, Kids: [p1.ref, p2.ref], Count: 2, MediaBox: [0, 0, 400, 300] });
  const midRef = ctx.register(mid);
  for (const p of [p1, p2]) {
    p.node.set(L.PDFName.of("Parent"), midRef);
    p.node.delete(L.PDFName.of("MediaBox"));
  }
  doc.catalog.Pages().set(L.PDFName.of("Kids"), ctx.obj([p0.ref, midRef]));
  // 다른 앱의 링크(규칙 3) — 추출본에 따라가면 안 되는 내부 목적지
  const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 600, 200, 620], Dest: [p1.ref, "Fit"] }));
  p0.node.set(L.PDFName.of("Annots"), ctx.obj([link]));
  if (classic) doc.context.header = L.PDFHeader.forVersion(1, 3);
  return new Uint8Array(await doc.save({ useObjectStreams: !classic }));
}

async function makeSource() {
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(L.StandardFonts.Helvetica);
  for (const t of ["src 1", "src 2"]) doc.addPage([300, 500]).drawText(t, { x: 30, y: 400, size: 18, font: helv });
  return new Uint8Array(await doc.save());
}

// ── 회차 ─────────────────────────────────────────────────────────────────────
async function run(label, classic) {
  console.log(`\n[${label}]`);
  const bytes = await makeMain(classic);
  const srcBytes = await makeSource();
  const SRC = { projectId: "p", relPath: "src.pdf" };
  const read = async (s) => {
    if (s.relPath !== SRC.relPath) throw new Error(`unexpected source ${s.relPath}`);
    return srcBytes.slice();
  };
  const infos0 = await pageInfos(bytes);
  check("픽스처: 3쪽, 2쪽은 상속 MediaBox 400×300, 3쪽 /Rotate 90 → 300×400", infos0.length === 3 && near(infos0.map((i) => [i.w, i.h]), [[612, 792], [400, 300], [300, 400]]) === null, JSON.stringify(infos0.map((i) => [i.w, i.h])));
  const [kA, kB, kC] = infos0.map((i) => i.key);
  const lib0 = await libPages(bytes);
  const contentsOf = new Map(lib0.pages.map((p) => [p.key, p.contents]));

  // 저장 1 — 페이지마다 노드 하나(장부를 만든다)
  const base = { opacity: 1, strokeWidth: 4 };
  const pages0 = [
    normalizeDoc({ objects: [{ id: "n-a", kind: "rect", x: 100, y: 100, w: 200, h: 80, ...base, strokes: [solid("#FF0000")], fills: [] }] }),
    normalizeDoc({ objects: [{ id: "n-b", kind: "line", x1: 20, y1: 20, x2: 200, y2: 120, ...base, strokes: [solid("#00AA00")], fills: [] }] }),
    normalizeDoc({ objects: [{ id: "n-c", kind: "pen", pts: [30, 30, 80, 90, 140, 60], ...base, strokes: [solid("#0000FF")], fills: [] }] }),
  ];
  const s1 = await buildIncrement(bytes, { infos: infos0, pages: pages0, ledger: emptyLedger(), textLines, font: null });
  const file1 = concat(bytes, s1.inc);
  check("저장 1 장부 pageOf = 페이지 key", s1.ledger.pageOf.get("n-a") === kA && s1.ledger.pageOf.get("n-c") === kC, JSON.stringify([...s1.ledger.pageOf]));
  const imp = await importAnnotations(file1, infos0, null);
  check("가져오기 장부 pageOf = 페이지 key", imp.ledger.pageOf.get("n-b") === kB);

  // 회전 왕복(R-ROT) — +90 → −90 이면 노드·page space 가 원래대로
  const st0 = { infos: infos0, pages: imp.pages, markups: [{ id: "m1", pageKey: kA, subtype: "Highlight", quads: [10, 10, 50, 10, 10, 20, 50, 20], color: "#FFFF00", opacity: 1 }] };
  const rt = applyPageOp(applyPageOp(st0, { kind: "rotate", keys: [kA], delta: 90 }), { kind: "rotate", keys: [kA], delta: -90 });
  check("회전 +90→−90 왕복: 노드·크기·toPage·마크업 복원", near([rt.pages[0].objects, geomOf(rt.infos), rt.markups], [st0.pages[0].objects, geomOf(infos0), st0.markups]) === null);

  // 연산 — 표시 순서 [A B C]
  const srcInfos = (await pageInfos(srcBytes)).map((i) => ({ ...i }));
  const ops = [];
  let st = st0;
  const step = (op, inserted) => {
    ops.push(op);
    st = applyPageOp(st, op, inserted);
  };
  step({ kind: "move", keys: [kC], to: 0 }); // C A B
  step({ kind: "rotate", keys: [kA], delta: 90 }); // A 가 792×612
  step({ kind: "duplicate", keys: [kB], newKeys: ["new:dupB"] }); // C A B B'
  step({ kind: "insertBlank", at: 1, key: "new:blank", w: 300, h: 200 }); // C _ A B B'
  step({ kind: "insertPdf", at: 5, keys: ["new:s1", "new:s2"], source: SRC }, srcInfos); // C _ A B B' s1 s2
  step({ kind: "delete", keys: [kB] }); // C _ A B' s1 s2
  const order = st.infos.map((i) => i.key);
  check("모델 순서", JSON.stringify(order) === JSON.stringify([kC, "new:blank", kA, "new:dupB", "new:s1", "new:s2"]), JSON.stringify(order));
  check("삭제된 페이지의 마크업은 사라지지 않음(A 는 남음)·회전 따라감", st.markups.length === 1 && Math.abs(st.markups[0].quads[0] - (792 - 10)) < 0.01, JSON.stringify(st.markups));
  const dupNode = st.pages[3].objects[0];
  check("복제 페이지 노드는 새 id", st.pages[3].objects.length === 1 && dupNode.id !== "n-b" && dupNode.kind === "line");
  // 새 빈 페이지에 노드 하나
  st = { ...st, pages: st.pages.map((d, i) => (i === 1 ? normalizeDoc({ objects: [{ id: "n-new", kind: "ellipse", x: 20, y: 20, w: 100, h: 60, ...base, strokes: [solid("#FF00FF")], fills: [] }] }) : d)) };
  check("isDirty(연산 있음) = true", isDirty(st.pages, imp.ledger, ops));

  // 표시용 바이트(작업 사본 위)
  const shown = await displayBytes(imp.workingCopy ?? file1, ops, read);
  const shownInfos = await pageInfos(shown);
  check("표시 바이트: pdf.js 페이지 크기·toPage = 모델(±0.01)", near(shownInfos.map((i) => [i.w, i.h, i.toPage]), st.infos.map((i) => [i.w, i.h, i.toPage])) === null, JSON.stringify(shownInfos.map((i) => [i.w, i.h])));

  // 저장 2 — 주석과 같은 증분 하나
  const s2 = await buildIncrement(file1, { infos: st.infos, pages: st.pages, ledger: imp.ledger, textLines, font: null, pageOps: ops }, read);
  const file2 = concat(file1, s2.inc);
  check("증분은 원본 사본이 아니다", !latin1(s2.inc).startsWith("%PDF-"));
  check("접두사 바이트 = 저장 1 파일", Buffer.compare(Buffer.from(file2.subarray(0, file1.length)), Buffer.from(file1)) === 0);
  const sizes = [bytes, file1, file2].map(lastTrailerSize);
  check("trailer /Size 역행 없음", sizes.every((v, i) => v !== null && (i === 0 || v >= sizes[i - 1])), JSON.stringify(sizes));

  const infos2 = await pageInfos(file2);
  check("다시 열기: 페이지 수 6", infos2.length === 6, String(infos2.length));
  check("다시 열기: 크기·toPage = 모델(회전·상속 MediaBox·삽입 포함)", near(infos2.map((i) => [i.w, i.h, i.toPage]), st.infos.map((i) => [i.w, i.h, i.toPage])) === null, JSON.stringify(infos2.map((i) => [i.w, i.h])));
  check("원본 페이지는 같은 객체(key 불변)", infos2[0].key === kC && infos2[2].key === kA, JSON.stringify(infos2.map((i) => i.key)));
  const lib2 = await libPages(file2);
  check("/Rotate: C 90 유지, A 0→90, 복제 B' 0", lib2.pages[0].rotate === 90 && lib2.pages[2].rotate === 90 && lib2.pages[3].rotate === 0, JSON.stringify(lib2.pages.map((p) => p.rotate)));
  check("L2 원본 /Contents 그대로, 복제는 같은 콘텐츠", lib2.pages[0].contents === contentsOf.get(kC) && lib2.pages[2].contents === contentsOf.get(kA) && lib2.pages[3].contents === contentsOf.get(kB), JSON.stringify(lib2.pages.map((p) => p.contents)));
  check("페이지 트리 /Count 6", lib2.count === 6, String(lib2.count));
  check("주석 subtype(링크는 A 에 남음, 지운 B 의 선은 없음)", JSON.stringify(lib2.pages.map((p) => p.subtypes)) === JSON.stringify([["Ink"], ["Circle"], ["Link", "Square"], ["Line"], [], []]), JSON.stringify(lib2.pages.map((p) => p.subtypes)));

  const imp2 = await importAnnotations(file2, infos2, null);
  const want = st.pages.map((d) => d.objects);
  const got = imp2.pages.map((d) => d.objects);
  check("다시 열면 노드가 같은 페이지 내용을 따라간다(회전된 기하 포함, ±0.01)", near(got, want) === null, near(got, want) ?? "");
  check("다시 연 직후 isDirty = false", !isDirty(imp2.pages, imp2.ledger));
  // 픽셀: 회전한 A 위 사각형 윗변(모델 좌표)은 빨강 — 노드가 페이지 내용과 같이 돌았다
  const rA = st.pages[2].objects[0];
  const px = await renderPage(file2, 3);
  check("픽셀: 회전 페이지의 사각형 왼변 빨강", close(px(rA.x, rA.y + rA.h / 2), [255, 0, 0]), JSON.stringify(px(rA.x, rA.y + rA.h / 2)));
  check("픽셀: 사각형 안은 흰색(대조군)", close(px(rA.x + rA.w / 2, rA.y + rA.h / 2), [255, 255, 255], 10), JSON.stringify(px(rA.x + rA.w / 2, rA.y + rA.h / 2)));

  // 추출 — A(회전·주석)와 s2
  const before = file2.slice();
  const ext = await extractPages(file2, [2, 5]);
  check("추출: 원본 바이트 불변", Buffer.compare(Buffer.from(before), Buffer.from(file2)) === 0);
  const extInfos = await pageInfos(ext);
  check("추출: 페이지 수 2·크기", extInfos.length === 2 && near(extInfos.map((i) => [i.w, i.h]), [[792, 612], [300, 500]]) === null, JSON.stringify(extInfos.map((i) => [i.w, i.h])));
  const libE = await libPages(ext);
  check("추출: 주석 따라감(내부 링크는 뺌)·다른 페이지 객체 안 딸려 옴", JSON.stringify(libE.pages.map((p) => p.subtypes)) === JSON.stringify([["Square"], []]) && libE.leaves === 2, JSON.stringify([libE.pages.map((p) => p.subtypes), libE.leaves]));
}

/** 원시 바이트 + 풀 수 있는 모든 Flate 스트림에서 문자열 개수 — 고아 객체로 남은 콘텐츠까지 센다. */
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

// 추출이 뽑지 않은 쪽 콘텐츠를 새 파일에 고아로 끌고 오지 않는다 — 두 쪽에 위젯이 하나씩 달린 한 필드(/Parent → /Kids → /P),
// 그리고 detach 가 끊지 않는 길(주석 /AA 의 GoTo)까지. 고아는 트리에 없어 pdf.js 로는 안 보이므로 바이트에서 센다.
async function extractLeak() {
  console.log("\n[추출 유출]");
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const p0 = doc.addPage([300, 300]);
  const p1 = doc.addPage([300, 300]);
  const ctx = doc.context;
  p0.node.addContentStream(ctx.register(ctx.stream("% PUBLIC-ONE")));
  p1.node.addContentStream(ctx.register(ctx.stream("% SECRET-TWO")));
  const field = ctx.register(ctx.obj({ FT: "Tx", T: L.PDFString.of("initials") }));
  const w0 = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 60, 30], P: p0.ref, Parent: field }));
  const w1 = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 60, 30], P: p1.ref, Parent: field }));
  ctx.lookup(field).set(L.PDFName.of("Kids"), ctx.obj([w0, w1]));
  const sq = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [100, 100, 150, 150], AA: { D: { S: "GoTo", D: [p1.ref, "Fit"] } } }));
  p0.node.set(L.PDFName.of("Annots"), ctx.obj([w0, sq]));
  p1.node.set(L.PDFName.of("Annots"), ctx.obj([w1]));
  doc.catalog.set(L.PDFName.of("AcroForm"), ctx.obj({ Fields: [field] }));
  const src = new Uint8Array(await doc.save({ useObjectStreams: false }));
  const out = await extractPages(src, [0]);
  const lib = await libPages(out);
  check("추출: 1쪽·뽑은 쪽 콘텐츠 있음", lib.count === 1 && countIn(out, "PUBLIC-ONE") === 1, JSON.stringify([lib.count, countIn(out, "PUBLIC-ONE")]));
  check("추출: 뽑지 않은 쪽 콘텐츠 0(위젯 필드·/AA 경로)", countIn(out, "SECRET-TWO") === 0, String(countIn(out, "SECRET-TWO")));
  check("추출: 트리 밖 페이지 leaf 없음", lib.leaves === 1, String(lib.leaves));
  check("추출: 위젯·사각형 주석은 따라감", JSON.stringify(lib.pages[0].subtypes) === JSON.stringify(["Widget", "Square"]), JSON.stringify(lib.pages[0].subtypes));
}

// 같은 원본 쪽이 두 번 들어간다(같은 PDF 두 번 삽입 · 삽입한 쪽 복제) — 복사기 캐시로 두 페이지가 주석 객체 하나를 나눠
// 갖고, 주석 /P 가 끌고 온 원본 쪽이 고아 leaf 로 남았다.
async function repeatedSource() {
  console.log("\n[같은 원본 쪽 반복 삽입]");
  const s = await L.PDFDocument.create({ updateMetadata: false });
  const sp = s.addPage([300, 200]);
  const ann = s.context.register(s.context.obj({ Type: "Annot", Subtype: "Square", Rect: [50, 50, 150, 100], C: [1, 0, 0], BS: { W: 2 }, P: sp.ref }));
  sp.node.set(L.PDFName.of("Annots"), s.context.obj([ann]));
  const src = new Uint8Array(await s.save({ useObjectStreams: false }));
  const b = await L.PDFDocument.create({ updateMetadata: false });
  b.addPage([300, 200]);
  const base = new Uint8Array(await b.save({ useObjectStreams: false }));
  const SRC = { projectId: "p", relPath: "src.pdf" };
  const read = async () => src.slice();
  const infos0 = await pageInfos(base);
  const srcInfos = await pageInfos(src);
  const ops = [
    { kind: "insertPdf", at: 1, keys: ["new:A"], source: SRC },
    { kind: "duplicate", keys: ["new:A"], newKeys: ["new:B"] },
    { kind: "insertPdf", at: 3, keys: ["new:C"], source: SRC },
  ];
  let st = { infos: infos0, pages: [normalizeDoc({ objects: [] })], markups: [] };
  for (const op of ops) st = applyPageOp(st, op, op.kind === "insertPdf" ? srcInfos : []);
  const { inc } = await buildIncrement(base, { infos: st.infos, pages: st.pages, ledger: emptyLedger(), textLines, font: null, pageOps: ops, markups: [] }, read);
  const out = concat(base, inc);
  const d = await L.PDFDocument.load(out, { updateMetadata: false });
  const pages = d.getPages();
  const inTree = new Set(pages.map((p) => p.ref.toString()));
  const annRefs = pages.map((p) => {
    const raw = p.node.get(L.PDFName.of("Annots"));
    return raw ? d.context.lookup(raw).asArray().map(String) : [];
  });
  const all = annRefs.flat();
  check("4쪽", pages.length === 4, String(pages.length));
  check("주석 객체를 두 페이지가 나눠 갖지 않음", new Set(all).size === all.length && all.length >= 1, JSON.stringify(annRefs));
  const ps = all.map((r) => String(d.context.lookup(L.PDFRef.of(Number(r.split(" ")[0]))).get(L.PDFName.of("P"))));
  check("삽입 쪽 주석 /P = 놓인 페이지(트리 안)", ps.every((p) => inTree.has(p)) && ps[0] === pages[1].ref.toString(), JSON.stringify(ps));
  check("트리 밖 페이지 leaf 없음", (await libPages(out)).leaves === 4, String((await libPages(out)).leaves));
  const imp = await importAnnotations(out, await pageInfos(out), null);
  check("다시 열기: 장부 ref 마다 id 하나", new Set([...imp.ledger.refs.values()].map(String)).size === imp.ledger.refs.size, JSON.stringify([...imp.ledger.refs]));
}

// 이미지 Stamp 가 있는 쪽을 90° 회전 — 그림도 페이지 내용과 같이 돈다(상자 전치·rot 0 이면 서 있는 채 가운데만 잘린다).
async function imageRotate() {
  console.log("\n[이미지 Stamp 회전]");
  const cv = createCanvas(64, 32);
  const g = cv.getContext("2d");
  g.fillStyle = "#FF0000";
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = "#0000FF";
  g.fillRect(32, 0, 32, 32);
  const b = await L.PDFDocument.create({ updateMetadata: false });
  b.addPage([300, 200]);
  const base = new Uint8Array(await b.save({ useObjectStreams: false }));
  const infos = await pageInfos(base);
  const node = { id: "img1", kind: "rect", x: 50, y: 50, w: 128, h: 64, radius: [0, 0, 0, 0], opacity: 1, strokes: [], strokeWidth: 0,
    fills: [{ type: "image", assetId: "a1", mode: "fill", visible: true, blend: "normal" }] };
  const doc0 = normalizeDoc({ objects: [node], assets: { a1: { mime: "image/png", w: 64, h: 32, data: cv.toBuffer("image/png").toString("base64") } } });
  const op = { kind: "rotate", keys: [infos[0].key], delta: 90 };
  const st = applyPageOp({ infos, pages: [doc0], markups: [] }, op);
  const n = st.pages[0].objects[0];
  // 중심 (114,82) → rotCW (h−y, x) = (118,114)
  check("모델: 크기 그대로·rot 90·중심이 페이지와 같이 돎", near([n.w, n.h, n.rot, n.x + n.w / 2, n.y + n.h / 2], [128, 64, 90, 118, 114]) === null, JSON.stringify([n.x, n.y, n.w, n.h, n.rot]));
  const back = applyPageOp(st, { kind: "rotate", keys: [infos[0].key], delta: -90 }).pages[0].objects[0];
  check("모델: +90→−90 왕복", near([back.x, back.y, back.w, back.h, back.rot], [50, 50, 128, 64, 0]) === null, JSON.stringify([back.x, back.y, back.w, back.h, back.rot]));
  const { inc } = await buildIncrement(base, { infos: st.infos, pages: st.pages, ledger: emptyLedger(), textLines, font: null, pageOps: [op], markups: [] });
  const px = await renderPage(concat(base, inc), 1);
  // 돈 그림: 왼쪽(빨강)이 위, 오른쪽(파랑)이 아래 — 상자 x 86..150, y 50..178
  const top = [px(100, 70), px(136, 70)];
  const bottom = [px(100, 160), px(136, 160)];
  check("픽셀: 위 절반 빨강", top.every((c) => close(c, [255, 0, 0])), JSON.stringify(top));
  check("픽셀: 아래 절반 파랑", bottom.every((c) => close(c, [0, 0, 255])), JSON.stringify(bottom));
}

try {
  await run("classic xref %PDF-1.3", true);
  await run("xref stream %PDF-1.7", false);
  await extractLeak();
  await repeatedSource();
  await imageRotate();
} catch (e) {
  failed++;
  console.error("\nFAIL (exception)", e);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
