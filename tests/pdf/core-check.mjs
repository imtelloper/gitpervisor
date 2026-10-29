// PDF 주석 코어(src/lib/pdf/save.ts·import.ts) Node 왕복 자가 검사 — DOCS/task/74-pdf-annotate-m2.md 「검증」 ①~⑥.
//
//   node tests/pdf/core-check.mjs        (실패하면 비 0 종료)
//
// TS 원본을 esbuild 로 Node 용 번들(임시 파일)로 묶어 돌린다. @cantoo/pdf-lib ESM 빌드는 Node 에서 JSON import 로
// 죽으므로(설계 §10) 번들이 CJS 빌드를 고르게 둔다. 픽스처는 메모리에서 만들고 디스크의 PDF 는 건드리지 않는다.
// 폰트는 C:\Windows\Fonts\malgun.ttf(없으면 텍스트 노드 검사를 건너뛰지 않고 실패한다 — Windows 개발기 전용 검사다).

import { build } from "esbuild";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FONT_PATH = "C:\\Windows\\Fonts\\malgun.ttf";

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

// ── 번들 ─────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "gpv-pdf-core-"));
const outfile = join(dir, "core.mjs");
await build({
  stdin: {
    contents: [
      'export { buildIncrement, isDirty, fixSize, lastTrailerSize } from "./src/lib/pdf/save.ts";',
      'export { importAnnotations } from "./src/lib/pdf/import.ts";',
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
  // CJS 의존(pdf-lib cjs)이 require 를 쓴다 — ESM 번들에 require 를 만들어 준다.
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
const core = await import(pathToFileURL(outfile).href);
const { buildIncrement, isDirty, fixSize, lastTrailerSize, importAnnotations, normalizeDoc, emptyLedger, pdfLib: L } = core;

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"),
).href;

const fontBytes = new Uint8Array(readFileSync(FONT_PATH));
const font = { family: "gpv-check", bytes: fontBytes };

// ── 도우미 ───────────────────────────────────────────────────────────────────
const latin1 = (b) => Buffer.from(b).toString("latin1");
const concat = (a, b) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

async function pageInfos(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const infos = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    infos.push({ index: i - 1, w: vp.width, h: vp.height, toPage: [...vp.transform] });
  }
  await task.destroy();
  return infos;
}

async function pdfjsAnnots(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const doc = await task.promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push(await (await doc.getPage(i)).getAnnotations());
  await task.destroy();
  return out;
}

/** pdf.js 로 한 쪽을 scale 1(page space = px)로 그려 RGBA 를 돌려준다 — 주석은 AP 로 그려진다. */
async function renderPage(bytes, pageNo) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: 0,
    standardFontDataUrl: join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + "/",
  });
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale: 1 });
  const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const img = context.getImageData(0, 0, canvas.width, canvas.height);
  await task.destroy();
  const px = (x, y) => {
    const i = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const count = (x0, y0, x1, y1, pred) => {
    let k = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pred(px(x, y))) k++;
    return k;
  };
  return { px, count };
}
const close = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** pdf-lib 새 로드로 페이지별 [{ref, subtype, dict}]. */
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

async function contentsRefs(bytes) {
  const doc = await L.PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((p) => String(p.node.get(L.PDFName.of("Contents"))));
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
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const r = near(a[k], b[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  return a === b ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

const solid = (color, opacity = 1) => ({ type: "solid", color, opacity, visible: true, blend: "normal" });

// ── 픽스처 ───────────────────────────────────────────────────────────────────
async function makeFixture(classic) {
  const doc = await L.PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(L.StandardFonts.Helvetica);
  const p0 = doc.addPage([612, 792]);
  p0.drawText("page one", { x: 72, y: 700, size: 18, font: helv });
  const p1 = doc.addPage([612, 792]);
  p1.setRotation(L.degrees(90));
  p1.drawText("rotated page", { x: 72, y: 700, size: 18, font: helv });
  // 다른 앱의 메모 주석(규칙 3 — 끝까지 그대로 남아야 한다).
  const note = doc.context.register(
    doc.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [500, 700, 520, 720],
      Contents: L.PDFHexString.fromText("foreign note"),
    }),
  );
  p0.node.set(L.PDFName.of("Annots"), doc.context.obj([note]));
  if (classic) doc.context.header = L.PDFHeader.forVersion(1, 3);
  return doc.save({ useObjectStreams: !classic });
}

function makeNodes() {
  const base = { opacity: 1, strokeWidth: 3 };
  const p0 = normalizeDoc({
    objects: [
      { id: "n-rect", kind: "rect", x: 80, y: 120, w: 200, h: 90, ...base, strokes: [solid("#FF3B30")], fills: [solid("#FFCC00", 0.5)], dash: [6, 3], radius: [8, 8, 8, 8] },
      { id: "n-ellipse", kind: "ellipse", x: 320, y: 120, w: 150, h: 100, ...base, rot: 30, strokes: [solid("#0A84FF")], fills: [] },
      { id: "n-line", kind: "line", x1: 80, y1: 300, x2: 400, y2: 340, ...base, strokes: [solid("#34C759")], fills: [] },
      { id: "n-arrow", kind: "arrow", x1: 80, y1: 400, x2: 400, y2: 460, ...base, strokes: [solid("#AF52DE")], fills: [], heads: { start: "none", end: "arrow" } },
    ],
  });
  const p1 = normalizeDoc({
    objects: [
      { id: "n-pen", kind: "pen", pts: [100, 100, 120, 130, 150, 120, 180, 160, 220, 140], ...base, strokes: [solid("#1C1C1E")], fills: [] },
      { id: "n-hl", kind: "highlight", pts: [100, 250, 300, 252], strokeWidth: 16, strokes: [solid("#FFCC00")], fills: [] },
      { id: "n-text", kind: "text", x: 120, y: 320, w: 300, h: 30, text: "가나다 한글 ABC", fontSize: 18, fontFamily: font.family, fills: [solid("#0A84FF")], strokes: [], strokeWidth: 0 },
    ],
  });
  return [p0, p1];
}

const textLines = (n) => n.text.split("\n").map((t, i) => ({ text: t, x: n.x, baseline: n.y + n.fontSize * (i + 1) }));

// ── 회차 ─────────────────────────────────────────────────────────────────────
async function run(label, classic) {
  console.log(`\n[${label}]`);
  const bytes = new Uint8Array(await makeFixture(classic));
  const infos = await pageInfos(bytes);
  check("픽스처: 2쪽, 둘째 쪽 /Rotate 90 → page space 가로 792", infos.length === 2 && Math.abs(infos[1].w - 792) < 0.01);
  const origContents = await contentsRefs(bytes);
  const pages = makeNodes();

  // 저장 1 — 7종 추가
  const s1 = await buildIncrement(bytes, { infos, pages, ledger: emptyLedger(), textLines, font });
  const file1 = concat(bytes, s1.inc);
  const inc1 = latin1(s1.inc);
  const origStartxref = Number([...latin1(bytes).matchAll(/startxref\s+(\d+)/g)].pop()[1]);
  check("① 증분은 원본 사본이 아니다(%PDF 로 시작하지 않음, L1)", !inc1.startsWith("%PDF-"));
  check("① 증분 /Prev = 원본 startxref", new RegExp(`/Prev ${origStartxref}\\b`).test(inc1), `Prev not ${origStartxref}`);
  check("① 접두사 바이트 = 원본", Buffer.compare(Buffer.from(file1.subarray(0, bytes.length)), Buffer.from(bytes)) === 0);
  check("L2 페이지 /Contents 불변", JSON.stringify(await contentsRefs(file1)) === JSON.stringify(origContents));

  const a1 = await libAnnots(file1);
  const subs1 = a1.map((p) => p.map((a) => a.subtype).join(","));
  check("② pdf-lib 재로드 주석·subtype", subs1[0] === "Text,Square,Circle,Line,Line" && subs1[1] === "Ink,Ink,FreeText", JSON.stringify(subs1));
  check("② 장부 ref 7개", s1.ledger.refs.size === 7 && s1.ledger.saved.size === 7);
  check("isDirty(저장 직후) = false", !isDirty(pages, s1.ledger));

  const pj = await pdfjsAnnots(file1);
  const pjSubs = pj.map((p) => p.map((a) => a.subtype).join(","));
  check("② pdf.js getAnnotations subtype", pjSubs[0] === "Text,Square,Circle,Line,Line" && pjSubs[1] === "Ink,Ink,FreeText", JSON.stringify(pjSubs));
  const sq = a1[0][1].dict.lookup(L.PDFName.of("Rect")).asArray().map((n) => n.asNumber());
  const pjSq = pj[0][1].rect;
  check("② pdf.js Square rect = /Rect", near(sq, pjSq) === null, `${sq} vs ${pjSq}`);
  // 회전 페이지 위 노드는 user space 로 옮겨졌어야 한다 — page space 좌표 그대로 들어가면 rect 가 page 밖으로 나간다.
  const ft = pj[1][2].rect;
  check("회전 페이지 FreeText rect 가 MediaBox 안", ft[0] >= 0 && ft[1] >= 0 && ft[2] <= 612 && ft[3] <= 792, JSON.stringify(ft));

  // 픽셀: AP 가 page space 의 그 자리에 그 색으로 그려지는가(/Rotate 90 쪽 포함). 대조군 = 빈 자리는 흰색.
  const r0 = await renderPage(file1, 1);
  check("픽셀 대조군: 빈 자리 흰색", close(r0.px(560, 40), [255, 255, 255], 5), JSON.stringify(r0.px(560, 40)));
  check("픽셀 사각형 윗변 빨강", close(r0.px(180, 120), [255, 59, 48]), JSON.stringify(r0.px(180, 120)));
  check("픽셀 사각형 안 노랑 50%", close(r0.px(180, 165), [255, 230, 128], 25), JSON.stringify(r0.px(180, 165)));
  check("픽셀 화살표 몸통 보라", close(r0.px(240, 430), [175, 82, 222]), JSON.stringify(r0.px(240, 430)));
  // 몸통 반폭 1.5px 밖, 법선으로 3px — 끝에서 10.5px 뒤 머리 반폭은 ≈5px. 머리보다 뒤의 같은 오프셋은 대조군.
  const [ux, uy] = [320 / Math.hypot(320, 60), 60 / Math.hypot(320, 60)];
  const off = (back) => [400 - back * ux - 3 * uy, 460 - back * uy + 3 * ux];
  check("픽셀 화살촉 보라(몸통 밖)", close(r0.px(...off(10.5)), [175, 82, 222]), JSON.stringify(r0.px(...off(10.5))));
  check("픽셀 화살촉 뒤 같은 오프셋은 흰색(대조군)", close(r0.px(...off(25)), [255, 255, 255], 10), JSON.stringify(r0.px(...off(25))));
  // 타원 rot 30°(y-down 시계방향): 회전한 장축 끝은 파랑, 회전 안 했을 때의 장축 끝은 흰색.
  check("픽셀 타원 회전 방향(장축 끝)", r0.count(457, 205, 463, 211, (c) => close(c, [10, 132, 255], 60)) > 3);
  check("픽셀 타원 회전 안 된 자리 흰색(대조군)", close(r0.px(470, 170), [255, 255, 255], 10), JSON.stringify(r0.px(470, 170)));
  const r1 = await renderPage(file1, 2);
  // 화면과 같은 midpoint 2차 곡선 — 첫 곡선의 t=0.5 점 (118.75, 121.25). 꺾은선 꼭짓점(120,130)은 지나지 않는다.
  check("픽셀(회전 쪽) 펜 점 검정", r1.count(114, 116, 124, 126, (c) => close(c, [28, 28, 30], 60)) > 5);
  check("픽셀(회전 쪽) 펜은 꺾은선 꼭짓점을 지나지 않는다(대조군)", close(r1.px(120, 130), [255, 255, 255], 10), JSON.stringify(r1.px(120, 130)));
  check("픽셀(회전 쪽) 형광펜 곱하기 노랑", close(r1.px(200, 251), [255, 238, 166], 25), JSON.stringify(r1.px(200, 251)));
  const blue = r1.count(120, 320, 420, 350, (c) => c[2] > 180 && c[0] < 120);
  check("픽셀(회전 쪽) 한글 텍스트 잉크(파랑)", blue > 150, String(blue));

  // ③ 규칙 1 가져오기
  const imp = await importAnnotations(file1, infos, font);
  const saved = pages.flatMap((p) => p.objects);
  const got = imp.pages.flatMap((p) => p.objects);
  check("③ 가져온 노드 수 7", got.length === 7, String(got.length));
  const diff = near(got, saved);
  check("③ 규칙 1 노드 == 저장 노드(±0.01)", diff === null, diff ?? "");
  check("③ 가져온 직후 isDirty = false", !isDirty(imp.pages, imp.ledger));
  check("③ notes 없음", imp.notes.length === 0, JSON.stringify(imp.notes));
  const wc = imp.workingCopy ? await libAnnots(imp.workingCopy) : null;
  check(
    "③ 작업 사본 = 편집 주석만 빠짐(메모는 남음)",
    !!wc && wc[0].map((a) => a.subtype).join(",") === "Text" && wc[1].length === 0,
    wc ? JSON.stringify(wc.map((p) => p.map((a) => a.subtype))) : "null",
  );

  // ④ 두 번째 저장 — 사각형 1개 수정, 직선 1개 삭제
  const p0 = imp.pages[0];
  const edited = p0.objects
    .filter((n) => n.id !== "n-line")
    .map((n) => (n.id === "n-rect" ? { ...n, strokes: [solid("#000000")], x: n.x + 10 } : n));
  const pages2 = [{ ...p0, objects: edited }, imp.pages[1]];
  check("④ 수정 뒤 isDirty = true", isDirty(pages2, imp.ledger));
  const s2 = await buildIncrement(file1, { infos, pages: pages2, ledger: imp.ledger, textLines, font });
  const file2 = concat(file1, s2.inc);
  const a2 = await libAnnots(file2);
  const subs2 = a2.map((p) => p.map((a) => a.subtype).join(","));
  check("④ 삭제 반영·중복 없음", subs2[0] === "Text,Square,Circle,Line" && subs2[1] === "Ink,Ink,FreeText", JSON.stringify(subs2));
  check("④ 수정한 사각형은 같은 ref", s2.ledger.refs.get("n-rect") === imp.ledger.refs.get("n-rect") && a2[0][1].ref === imp.ledger.refs.get("n-rect"));
  const circleRef = imp.ledger.refs.get("n-ellipse").replace(" R", " obj");
  check("④ 안 바뀐 타원은 증분에 다시 쓰지 않음", !latin1(s2.inc).includes(`\n${circleRef}`) && !latin1(s2.inc).startsWith(circleRef));
  const imp2 = await importAnnotations(file2, infos, font);
  const rect2 = imp2.pages[0].objects.find((n) => n.id === "n-rect");
  check("④ 다시 열면 수정값", rect2?.strokes[0]?.color === "#000000" && Math.abs(rect2.x - 90) < 0.01, JSON.stringify(rect2?.strokes));
  check("④ 다시 열면 삭제된 노드 없음", !imp2.pages[0].objects.some((n) => n.id === "n-line"));

  // 저장 3 — 삭제만(새 객체 0) — L3 가 걸리는 경로
  const pages3 = [{ ...imp2.pages[0], objects: imp2.pages[0].objects.filter((n) => n.id !== "n-arrow") }, imp2.pages[1]];
  const s3 = await buildIncrement(file2, { infos, pages: pages3, ledger: imp2.ledger, textLines, font });
  const file3 = concat(file2, s3.inc);
  const sizes = [bytes, file1, file2, file3].map(lastTrailerSize);
  check("⑤ trailer /Size 역행 없음", sizes.every((v, i) => v !== null && (i === 0 || v >= sizes[i - 1])), JSON.stringify(sizes));
  const a3 = await libAnnots(file3);
  check("⑤ 삭제만 한 증분도 열린다", a3[0].map((a) => a.subtype).join(",") === "Text,Square,Circle", JSON.stringify(a3[0].map((a) => a.subtype)));

  // ⑥ 다른 앱이 /C 를 바꾸고 AP 를 다시 만든 사본 → 규칙 2 로 새 색
  const other = await L.PDFDocument.load(file1, { forIncrementalUpdate: true, updateMetadata: false });
  const sqRef = L.PDFRef.of(...imp.ledger.refs.get("n-rect").split(" ").slice(0, 2).map(Number));
  const sqDict = other.context.lookup(sqRef);
  sqDict.set(L.PDFName.of("C"), other.context.obj([0, 0, 1]));
  const bbox = sqDict.lookup(L.PDFName.of("Rect"));
  const newAp = other.context.register(other.context.stream("0 0 1 RG 3 w 0 0 10 10 re S", { Type: "XObject", Subtype: "Form", BBox: bbox }));
  sqDict.set(L.PDFName.of("AP"), other.context.obj({ N: newAp }));
  other.context.snapshot.markRefForSave(sqRef);
  const file1b = concat(file1, await other.saveIncremental(other.context.snapshot));
  const imp3 = await importAnnotations(file1b, infos, font);
  const r3 = imp3.pages[0].objects.find((n) => n.id === "n-rect");
  const orig = saved.find((n) => n.id === "n-rect");
  check("⑥ 규칙 2 — 바뀐 /C 가 들어온다", r3?.strokes[0]?.color === "#0000FF", JSON.stringify(r3?.strokes));
  check(
    "⑥ 규칙 2 — 사각형 기하가 /RD 로 복원(±0.01)",
    !!r3 && near([r3.x, r3.y, r3.w, r3.h, r3.strokeWidth], [orig.x, orig.y, orig.w, orig.h, orig.strokeWidth]) === null,
    r3 ? JSON.stringify([r3.x, r3.y, r3.w, r3.h]) : "missing",
  );
  check("⑥ 규칙 2 — 채움색·대시 유지", r3?.fills[0]?.color === "#FFCC00" && JSON.stringify(r3?.dash) === "[6,3]", JSON.stringify([r3?.fills, r3?.dash]));
  const ln = imp3.pages[0].objects.find((n) => n.id === "n-arrow");
  check("⑥ 다른 노드는 여전히 규칙 1", near(ln, saved.find((n) => n.id === "n-arrow")) === null);
}

try {
  check("fixSize: 역행한 /Size 를 직전 값으로", (() => {
    const prev = new TextEncoder().encode("%PDF-1.3\n...\ntrailer\n<< /Size 16 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n");
    const inc = new TextEncoder().encode("1 0 obj\n<<>>\nendobj\nxref\n0 1\ntrailer\n<< /Size 15 /Root 1 0 R /Prev 9 >>\nstartxref\n0\n%%EOF\n");
    return /\/Size 16 /.test(latin1(fixSize(prev, inc)));
  })());
  await run("classic xref %PDF-1.3", true);
  await run("xref stream %PDF-1.7", false);
} catch (e) {
  failed++;
  console.error("\nFAIL (exception)", e);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
