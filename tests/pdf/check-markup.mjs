// PDF 마크업·이미지 Stamp·서명(src/lib/pdf/markup.ts·write.ts·import.ts·save.ts) Node 왕복 자가 검사 —
// DOCS/task/75-pdf-m3-m4.md T1·T2·T3.
//
//   node tests/pdf/check-markup.mjs        (실패하면 비 0 종료)
//
// core-check.mjs 와 같은 방식: TS 원본을 esbuild 로 임시 번들, 픽스처는 메모리에서 만들고 디스크의 PDF 는 건드리지 않는다.
// 이미지 픽스처(PNG 알파·JPEG)는 pdfjs 가 쓰는 @napi-rs/canvas 로 그린다.

import { build } from "esbuild";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const dir = mkdtempSync(join(tmpdir(), "gpv-pdf-markup-"));
const outfile = join(dir, "markup.mjs");
await build({
  stdin: {
    contents: [
      'export { buildIncrement, isDirty } from "./src/lib/pdf/save.ts";',
      'export { importAnnotations } from "./src/lib/pdf/import.ts";',
      'export { mergeLineRects, quadsOfRects, hitMarkup, signatureToPathNode } from "./src/lib/pdf/markup.ts";',
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
const { buildIncrement, isDirty, importAnnotations, mergeLineRects, quadsOfRects, hitMarkup, signatureToPathNode, normalizeDoc, emptyLedger, pdfLib: L } = core;

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;

const concat = (a, b) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};
const solid = (color, opacity = 1) => ({ type: "solid", color, opacity, visible: true, blend: "normal" });

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

async function renderPage(bytes, pageNo) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + "/" });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const img = context.getImageData(0, 0, canvas.width, canvas.height);
  const annots = await page.getAnnotations();
  await task.destroy();
  const px = (x, y) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  return { px, annots };
}
const close = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function libAnnots(bytes) {
  const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => {
    const raw = p.node.get(L.PDFName.of("Annots"));
    const arr = raw ? doc.context.lookup(raw) : null;
    return (arr ? arr.asArray() : []).map((e) => {
      const d = doc.context.lookup(e);
      return { ref: e.toString(), subtype: d.get(L.PDFName.of("Subtype")).decodeText(), dict: d, ctx: doc.context };
    });
  });
}

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

// ── 픽스처 ───────────────────────────────────────────────────────────────────
async function makeFixture() {
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(L.StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  p0.drawText("The quick brown fox jumps over the lazy dog", { x: 72, y: 700, size: 18, font: helv });
  const p1 = doc.addPage([612, 792]);
  p1.setRotation(L.degrees(90));
  p1.drawText("rotated page text", { x: 72, y: 700, size: 18, font: helv });
  return doc.save({ useObjectStreams: false });
}

/** 왼쪽 절반 빨강(불투명)·오른쪽 절반 투명 PNG, 전체 파랑 JPEG. */
async function imageAssets() {
  const c = createCanvas(40, 20);
  const g = c.getContext("2d");
  g.fillStyle = "#FF0000";
  g.fillRect(0, 0, 20, 20);
  const png = c.toBuffer("image/png");
  const j = createCanvas(30, 30);
  const h = j.getContext("2d");
  h.fillStyle = "#0000FF";
  h.fillRect(0, 0, 30, 30);
  const jpg = j.toBuffer("image/jpeg");
  return {
    png: { mime: "image/png", w: 40, h: 20, data: png.toString("base64") },
    jpg: { mime: "image/jpeg", w: 30, h: 30, data: jpg.toString("base64") },
  };
}

// ── 순수 함수 ────────────────────────────────────────────────────────────────
{
  const lines = mergeLineRects([
    { x0: 10, y0: 100, x1: 50, y1: 112 },
    { x0: 50, y0: 99, x1: 90, y1: 113 }, // 같은 줄, 높이가 조금 다른 스팬
    { x0: 10, y0: 120, x1: 70, y1: 132 }, // 다음 줄
    { x0: 0, y0: 0, x1: 0.2, y1: 0.2 }, // 빈 조각
  ]);
  check("mergeLineRects: 2 lines", lines.length === 2, JSON.stringify(lines));
  check("mergeLineRects: union of first line", !near(lines[0], { x0: 10, y0: 99, x1: 90, y1: 113 }), JSON.stringify(lines[0]));
  const q = quadsOfRects(lines);
  check("quadsOfRects: 8 per rect, TL TR BL BR", q.length === 16 && !near(q.slice(0, 8), [10, 99, 90, 99, 10, 113, 90, 113]));
  const mk = { id: "m", pageKey: "k", subtype: "Highlight", quads: q, color: "#FF0", opacity: 1 };
  check("hitMarkup: inside", hitMarkup([mk], "k", 30, 125, 1)?.id === "m");
  check("hitMarkup: other page / outside", hitMarkup([mk], "x", 30, 125, 1) === null && hitMarkup([mk], "k", 300, 125, 1) === null);
}

// ── 왕복 ─────────────────────────────────────────────────────────────────────
const orig = await makeFixture();
const infos = await pageInfos(orig);
const assets = await imageAssets();
const [k0, k1] = [infos[0].key, infos[1].key];

// 글줄 "The quick…" 은 user y 700(page y 92) 부근, 높이 ~18.
const markups0 = [
  { id: "mk-hl", pageKey: k0, subtype: "Highlight", quads: quadsOfRects([{ x0: 72, y0: 76, x1: 250, y1: 96 }]), color: "#FFFF00", opacity: 1 },
  { id: "mk-ul", pageKey: k0, subtype: "Underline", quads: quadsOfRects([{ x0: 260, y0: 76, x1: 420, y1: 96 }]), color: "#0000FF", opacity: 1 },
  { id: "mk-so", pageKey: k1, subtype: "StrikeOut", quads: quadsOfRects([{ x0: 100, y0: 100, x1: 300, y1: 120 }]), color: "#FF0000", opacity: 0.8 },
];
const sig = signatureToPathNode({ w: 200, h: 80, strokes: [[10, 40, 50, 10, 90, 70, 130, 20], [140, 60, 190, 60]] }, 300, 500, 160, "#123456", 2);
const p0 = normalizeDoc({
  objects: [
    { id: "img-png", kind: "rect", x: 80, y: 200, w: 120, h: 60, opacity: 1, strokeWidth: 0, strokes: [], fills: [{ type: "image", assetId: "a-png", mode: "stretch", visible: true, blend: "normal" }] },
    { id: "img-jpg", kind: "rect", x: 300, y: 200, w: 90, h: 90, opacity: 1, strokeWidth: 0, strokes: [], fills: [{ type: "image", assetId: "a-jpg", mode: "fill", visible: true, blend: "normal" }] },
    sig,
  ],
  assets: { "a-png": assets.png, "a-jpg": assets.jpg },
});
const p1 = normalizeDoc({ objects: [] });
check("signature: one path node, 2 subpaths, width 160", sig.kind === "path" && sig.subpaths.length === 2 && Math.abs(sig.subpaths[0].verts[0].x - (300 - 80 + 10 * 0.8)) < 1e-6);

const model = { infos, pages: [p0, p1], ledger: emptyLedger(), textLines: () => [], font: null, markups: markups0 };
check("isDirty: new markups dirty", isDirty(model.pages, model.ledger, [], markups0));
const r1 = await buildIncrement(orig, model);
const saved1 = concat(orig, r1.inc);
check("① original prefix identical", Buffer.from(saved1.subarray(0, orig.length)).equals(Buffer.from(orig)));

const la = await libAnnots(saved1);
const subs0 = la[0].map((a) => a.subtype).sort().join(",");
check("② page 0 subtypes", subs0 === "Highlight,Ink,Stamp,Stamp,Underline", subs0);
check("② page 1 subtypes", la[1].map((a) => a.subtype).join(",") === "StrikeOut");
const hl = la[0].find((a) => a.subtype === "Highlight");
const qp = hl.dict.lookup(L.PDFName.of("QuadPoints")).asArray().map((o) => o.asNumber());
// page (72,76)→user (72, 792-76=716) …
check("② Highlight QuadPoints in user space", !near(qp, [72, 716, 250, 716, 72, 696, 250, 696]), JSON.stringify(qp));
const so = la[1][0];
const soq = so.dict.lookup(L.PDFName.of("QuadPoints")).asArray().map((o) => o.asNumber());
check("② StrikeOut on /Rotate 90 page has 8 quad points", soq.length === 8);

const r0 = await renderPage(saved1, 1);
check("③ pdf.js sees markup subtypes", ["Highlight", "Underline"].every((s) => r0.annots.some((a) => a.subtype === s && a.quadPoints)));
check("③ highlight multiply: yellow on white", close(r0.px(160, 80), [255, 255, 0]), JSON.stringify(r0.px(160, 80)));
const ulY = 76 + 20 * 0.8;
check("③ underline drawn blue", close(r0.px(340, ulY), [0, 0, 255], 80), JSON.stringify(r0.px(340, ulY)));
check("③ PNG stamp: opaque half red", close(r0.px(110, 230), [255, 0, 0]), JSON.stringify(r0.px(110, 230)));
check("③ PNG stamp: transparent half shows white page", close(r0.px(170, 230), [255, 255, 255], 10), JSON.stringify(r0.px(170, 230)));
check("③ JPEG stamp blue", close(r0.px(345, 245), [0, 0, 255]), JSON.stringify(r0.px(345, 245)));

// 규칙 1 복원
const imp = await importAnnotations(saved1, infos, null);
const byId = new Map(imp.markups.map((m) => [m.id, m]));
check("④ rule 1: 3 markups", imp.markups.length === 3);
for (const m of markups0) check(`④ rule 1 markup ${m.id} equal`, !near(byId.get(m.id), m), near(byId.get(m.id), m) ?? "");
const n0 = new Map(imp.pages[0].objects.map((o) => [o.id, o]));
for (const o of p0.objects) check(`④ rule 1 node ${o.id} equal`, !near(n0.get(o.id), o), near(n0.get(o.id), o) ?? "");
check("④ PNG asset bytes restored", imp.pages[0].assets["a-png"]?.data === assets.png.data && imp.pages[0].assets["a-png"].mime === "image/png");
check("④ JPEG asset bytes restored", imp.pages[0].assets["a-jpg"]?.data === assets.jpg.data && imp.pages[0].assets["a-jpg"].mime === "image/jpeg");
check("④ asset size restored", imp.pages[0].assets["a-png"]?.w === 40 && imp.pages[0].assets["a-png"]?.h === 20);
check("④ imported is clean", !isDirty(imp.pages, imp.ledger, [], imp.markups));
check("④ working copy hides markups from pdf.js", imp.workingCopy && (await renderPage(imp.workingCopy, 1)).annots.length === 0);

// 두 번째 저장: 색 변경 1 + 삭제 1 + 이미지 이동
const changed = imp.markups.filter((m) => m.id !== "mk-ul").map((m) => (m.id === "mk-hl" ? { ...m, color: "#00FF00" } : m));
const moved = imp.pages[0].objects.map((o) => (o.id === "img-png" ? { ...o, x: o.x + 10 } : o));
const pages2 = [{ ...imp.pages[0], objects: moved }, imp.pages[1]];
check("isDirty: color change dirty", isDirty(pages2, imp.ledger, [], changed));
const r2 = await buildIncrement(saved1, { infos, pages: pages2, ledger: imp.ledger, textLines: () => [], font: null, markups: changed });
const saved2 = concat(saved1, r2.inc);
check("⑤ prefix identical (2nd)", Buffer.from(saved2.subarray(0, saved1.length)).equals(Buffer.from(saved1)));
const la2 = await libAnnots(saved2);
check("⑤ underline removed, same ref reused", la2[0].length === 4 && la2[0].find((a) => a.subtype === "Highlight")?.ref === hl.ref);
const imp2 = await importAnnotations(saved2, infos, null);
check("⑤ re-import color change", imp2.markups.find((m) => m.id === "mk-hl")?.color === "#00FF00");
check("⑤ moved image keeps asset", imp2.pages[0].assets["a-png"]?.data === assets.png.data && imp2.pages[0].objects.find((o) => o.id === "img-png")?.x === 90);
// 이동·복제는 이미지를 다시 넣지 않는다 — 넣으면 저장마다 파일이 이미지 크기만큼 자란다.
const imgCount = (b) => (Buffer.from(b).toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
check("⑤ first save embeds images (control)", imgCount(r1.inc) >= 2, String(imgCount(r1.inc)));
check("⑤ moving an image embeds nothing new", imgCount(r2.inc) === 0, String(imgCount(r2.inc)));
{
  const png = imp2.pages[0].objects.find((o) => o.id === "img-png");
  const pages3 = [{ ...imp2.pages[0], objects: [...imp2.pages[0].objects, { ...png, id: "img-png-copy", x: png.x + 150 }] }, imp2.pages[1]];
  const r3 = await buildIncrement(saved2, { infos, pages: pages3, ledger: imp2.ledger, textLines: () => [], font: null, markups: imp2.markups });
  const saved3 = concat(saved2, r3.inc);
  check("⑤ copied image shares the XObject", imgCount(r3.inc) === 0, String(imgCount(r3.inc)));
  const imp3 = await importAnnotations(saved3, infos, null);
  check("⑤ copied image restores asset", imp3.pages[0].assets["a-png"]?.data === assets.png.data && imp3.pages[0].objects.some((o) => o.id === "img-png-copy"));
  const r = await renderPage(saved3, 1);
  check("⑤ copied image drawn (red half)", close(r.px(260, 230), [255, 0, 0]), JSON.stringify(r.px(260, 230)));
}

// 규칙 2: 다른 앱이 고친 Highlight(/C 바뀜 → 해시는 맞아도 우리 JSON 이 우선이므로, 다른 앱 주석을 흉내 내 /GPV_* 를 지운다)
{
  const doc = await L.PDFDocument.load(saved2, { updateMetadata: false });
  const d = doc.context.lookup(L.PDFRef.of(...hl.ref.split(" ").slice(0, 2).map(Number)));
  d.delete(L.PDFName.of("GPV_Node"));
  d.delete(L.PDFName.of("GPV_APHash"));
  d.set(L.PDFName.of("C"), doc.context.obj([1, 0, 1]));
  const foreign = await doc.save({ useObjectStreams: false });
  const imp3 = await importAnnotations(new Uint8Array(foreign), await pageInfos(new Uint8Array(foreign)), null);
  const m = imp3.markups.find((x) => x.subtype === "Highlight");
  check("⑥ rule 2 Highlight color from /C", m?.color === "#FF00FF", m?.color);
  check("⑥ rule 2 quads to page space", m && !near(m.quads, markups0[0].quads), m && near(m.quads, markups0[0].quads));
}

// ⑦ 다른 앱 Highlight 의 QuadPoints 가 반시계(스펙 문구 순서: 좌하·우하·우상·좌상)여도 좌상·우상·좌하·우하로 받는다 —
// 그대로 받으면 화면 polygon·다시 쓴 AP 가 나비넥타이(삼각형 둘)가 된다. 색만 바꿔 저장 → 상자 전체가 칠해져야 한다.
{
  const s = await L.PDFDocument.create({ updateMetadata: false });
  const sp = s.addPage([300, 200]);
  const ap = s.context.register(s.context.flateStream("1 1 0 rg 50 80 200 40 re f", { Type: "XObject", Subtype: "Form", BBox: [49, 79, 251, 121] }));
  const ann = s.context.register(
    s.context.obj({ Type: "Annot", Subtype: "Highlight", Rect: [49, 79, 251, 121], C: [1, 1, 0], QuadPoints: [50, 80, 250, 80, 250, 120, 50, 120], AP: { N: ap }, NM: L.PDFHexString.fromText("hl-ccw") }),
  );
  sp.node.set(L.PDFName.of("Annots"), s.context.obj([ann]));
  const ccw = new Uint8Array(await s.save({ useObjectStreams: false }));
  const ccwInfos = await pageInfos(ccw);
  const r = await importAnnotations(ccw, ccwInfos, null);
  const mk = r.markups[0];
  check("⑦ CCW quad → TL,TR,BL,BR (page space)", mk && !near(mk.quads, [50, 80, 250, 80, 50, 120, 250, 120]), mk && JSON.stringify(mk.quads));
  const { inc } = await buildIncrement(ccw, { infos: ccwInfos, pages: r.pages, ledger: r.ledger, textLines: () => [], font: null, markups: [{ ...mk, color: "#FF0000" }] });
  const { px } = await renderPage(concat(ccw, inc), 1);
  const spots = [[55, 100], [245, 100], [150, 84], [150, 116]].map(([x, y]) => px(x, y));
  check("⑦ CCW recolor save: whole box red (no bowtie)", spots.every((c) => close(c, [255, 0, 0], 60)), JSON.stringify(spots));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
