// PDF 주석 편집 — 실제 PdfView 위의 오버레이 게이트 + 편집 핵심 경로(DOCS/pdf-viewer-editor-design.md §8.2·부록 A·C,
// 계약 DOCS/task/74-pdf-annotate-m2.md · 75-pdf-m3-m4.md).
//
// M0/M1 때 이 스위트는 pdf.js 없는 가짜 A4 하니스(PdfAnnotateSpike.tsx)를 구동했다. M2 에서 하니스의 배치·백킹 규칙을
// PdfAnnotateOverlay.tsx 로 옮겼으므로 게이트도 실제 뷰어(pdf.js `.page` div 위의 오버레이)로 옮기고 하니스는 지웠다.
//
// 옮긴 게이트(gates.pdf, 3쪽 A4):
//   A4  레일 = PDF 도구 10종(이미지 포함) · 이 순서 · 플라이아웃 캐럿 0
//   1a  400% settle 뒤 활성 레이어 백킹 = css × dpr(±1) · image-rendering auto
//       반증: 줌 도중(settle 전, 백킹이 settle 값에 고정된) 같은 레이어에서 같은 식이 **실패해야** 한다.
//   1b  400% 1pt 사선의 행별 첫 잉크 x 연속 ≤ 3(계단 없음) · 잉크 행 수·위치가 문서 좌표와 일치
//       반증: 1pt = 1 백킹 px 캔버스(pixelated)를 같은 자리에 얹어 찍으면 계단이 나와야 한다.
//   1c  같은 사선의 열별 세로 단면 — 부분 피복 중앙값 ≤ 3 · 완전 피복 ≥ 1
//       반증: 1pt = 1 백킹 px 쌍선형(auto) 캔버스, 실제 레이어를 반 디바이스 px 옮긴 것 — 둘 다 흐림 판정이어야 한다.
//   VP-1 viewport 원점을 옮긴 스크롤의 **커밋 직후**(MutationObserver 마이크로태스크 — rAF 전) 사선이 페이지의 제자리에 보인다
//       반증: 스크롤 직전 비트맵을 새 박스로 읽으면 4pt 넘게 어긋나야 한다(원점 이동 ≥5pt 전제).
//   V2a 원점만 옮긴 스크롤 뒤 프레임이 지나도 같은 캔버스·같은 백킹 크기·새 원점 픽셀(커밋 캐시 키가 원점을 구별)
//   VP-2 400%→100% 줌 도중 viewport·백킹·씬 캔버스가 settle 값에 고정 · settle 뒤 풀림
//   VP-3 400% 사각형 도구 실제 포인터 드래그 → 문서 좌표 ±0.05pt(viewport 원점 ≥5pt — 원점을 빠뜨리면 수십 pt 어긋난다)
//   LC-3 텍스트 편집 중 활성 페이지 전환(PdfView.switchPage) → 옛 페이지에 확정 · 새 페이지에는 없음
//   LC-2 ① 편집 중 비활성 페이지 — 올라가기만 해서는 불변, 누르면 활성 · 텍스트는 옛 페이지에 확정
//        ② 여백에서 누른 채 페이지로 들어와 놓으면 불변(buttons≠0 가드), 놓은 뒤 첫 이동에서 활성
//   4   활성 페이지 전환 100회 뒤 힙 캔버스 개수·면적이 늘지 않는다(+ 계측 반증 두 가지 — 요소·컨텍스트로만 쥔 캔버스)
//   LC-4 400% 화면(+여백 96css) 밖 주석 페이지에는 정적 캔버스가 없다 — 스크롤해 보이면 생긴다(반증)
//   M   400% 활성 백킹이 보이는 영역(+여백)으로 잘린다 — 반증: 같은 배율의 페이지 전체 백킹은 그 2배를 넘는다
//
// 뺀 게이트(하니스 전용이라 실제 뷰어에 대응물이 없다):
//   · image·page·viewport **전략 비교**(1a·1b 의 image 반증, VP-3 의 두 전략 차, M 의 page vs viewport) — 실제 오버레이는
//     viewport 전략 하나뿐이다. image 전략이 하던 반증 역할은 위의 1pt = 1 백킹 px 탐침 캔버스와 줌 도중 고정 상태가 맡는다.
//   · V2c 커서 픽셀 읽기 — PdfAnnotateOverlay 는 statusRef 를 넘기지 않아(PDF 에는 상태 표시줄이 없다) flushCursor 경로가 돌지 않는다.
//   · LC-3 반증(raw 전환) — 확정을 건너뛰는 전환 경로가 제품에 없다. 대신 "전환 전에는 노드가 없고 전환 뒤에 생긴다"를
//     함께 단언해 확정이 전환에서 왔음을 보인다.
//   · hoverSwitch 끄기 — 실제 오버레이는 hover 전환이 늘 켜져 있다. 그래서 전환을 hook 으로 부를 때는 포인터를 페이지 밖에 둔다.
//
// 편집 핵심 경로(edit.pdf, 3쪽 — 1쪽에 글자 한 줄과 파란 32pt 사각형):
//   E1 사각형 도구 실제 드래그 → Ctrl+S → 저장본(pdf.js)에 Square 1개 · 렌더에서 빨간 테두리가 파란 사각형 네 변을 둘러싼다
//      (대조: 원본 렌더는 0변)
//   E2 탭을 닫고 다시 열기 → 같은 id·같은 좌표로 편집 가능한 노드 · 선택 + → 키로 1pt 옮겨 저장 → 저장본 Square 여전히 1개(중복 없음) ·
//      Rect 가 1pt 이동
//   E3 형광펜 마크업 도구로 글자를 실제로 끌어 선택 → 마크업 1 → 저장본 Highlight · 그 영역 렌더가 마크업 색(대조: 원본 0%)
//   E4 선택 도구로 마크업 클릭 → 선택 표시 → Delete → 마크업 0 → 저장본 Highlight 0 · Square 는 그대로 1
//   E5 페이지 모드에서 1쪽 오른쪽 회전 + 복제 → Ctrl+S → 저장본 4쪽 · /Rotate [90,90,0,0] · Square [1,1,0,0] · 회전된 두 쪽 렌더에서
//      테두리가 여전히 파란 사각형을 둘러싼다(대조: 사각형이 없는 쪽은 0변) → 다시 열기 → 노드 [1,1,0,0] · 회전된 좌표
//
// 포인터·키는 CDP Input.*(실제 히트 테스트·포인터 캡처·포커스 경로)로 쏜다. 저장본은 Node 의 pdf.js 로 읽고 그린다.
// 창 리로드가 끼면 수치는 무효다 — performance.timeOrigin 불변을 단언한다.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const name =
  "PDF 주석 편집 (오버레이 게이트: 선명도·viewport 계약·전환과 텍스트·전환 누수·컬링 + 그리기·저장·재편집·마크업·페이지 연산)";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
/** Windows·Linux 는 Ctrl(2), macOS 는 ⌘(4) — PdfView 의 isMod 와 같은 규칙. */
const MOD = process.platform === "darwin" ? 4 : 2;
const GROUP = "gpv62-heap";
/** layers.ts IDLE_MS(5000) + 여유 — 풀의 노는 캔버스가 버려진 **같은 상태**에서 전후를 잰다. */
const POOL_IDLE_MS = 5600;
/** 신생 세대 churn(작은 탈출 객체 → 스캐빈지) — 수정되지 않은 캔버스 래퍼가 버려지는 조건을 만든다. */
const CHURN = `{ const ring = new Array(4096); for (let i = 0; i < 4e6; i++) { ring[i & 4095] = { a: i, b: [i, i + 1], s: 'x' + i }; } }`;
/** PdfAnnotateOverlay SETTLE_MS(150) + pdf.js 재렌더 여유. */
const SETTLE_WAIT = 450;

const DIR = "pdf-e2e-62";
const P = { gates: `${DIR}/gates.pdf`, edit: `${DIR}/edit.pdf` };
const PANE = "gpv62-pane";
const W = 595;
const H = 842;
/** edit.pdf 1쪽 파란 사각형(page space, 위 원점)과 그 둘레로 그릴 사각형 — 16 의 배수라 격자·픽셀 스냅이 no-op 이다. */
const BLUE = { x: 136, y: 296, w: 32, h: 32 };
const RECT_FROM = { x: 112, y: 272 };
const RECT_TO = { x: 192, y: 352 };
const MARGIN = 24;

const solid = (color) => ({ type: "solid", color, opacity: 1, visible: true, blend: "normal" });

const RAIL_EXPECT = [
  "선택 (V)",
  "손 (Space)",
  "텍스트 (T)",
  "사각형 (R)",
  "타원 (O)",
  "직선 (L)",
  "화살표 (A)",
  "연필 (Shift+P)",
  "형광펜 (H)",
  "이미지",
];
const SWATCH_TITLE = "선 색 · 채우기 색";

// ── 픽스처 ─────────────────────────────────────────────────────────────────────────────────────────
// @cantoo/pdf-lib ESM 빌드는 Node 에서 JSON import 로 죽는다(tests/pdf/core-check.mjs 머리 주석) — CJS 빌드를 require 한다.
// 고전 xref(useObjectStreams:false) — 이 스위트가 재는 것은 오버레이·편집이지 xref 스트림 파싱이 아니다.
async function buildFixtures() {
  const L = require("@cantoo/pdf-lib");
  const make = async (draws) => {
    const d = await L.PDFDocument.create();
    const font = await d.embedFont(L.StandardFonts.Helvetica);
    for (const draw of draws) draw(d.addPage([W, H]), font, L);
    return Buffer.from(await d.save({ useObjectStreams: false }));
  };
  // 게이트용 — 맨 위 한 줄 말고는 흰 바탕(사선·텍스트·사각형 자리를 비운다).
  const gates = await make(
    [1, 2, 3].map((n) => (pg, font) => pg.drawText(`Gate page ${n}`, { x: 72, y: H - 60, size: 18, font })),
  );
  const edit = await make([
    (pg, font, L) => {
      pg.drawText("Alpha Bravo Charlie", { x: 72, y: 700, size: 24, font });
      pg.drawRectangle({ x: BLUE.x, y: H - BLUE.y - BLUE.h, width: BLUE.w, height: BLUE.h, color: L.rgb(0, 0, 1) });
    },
    (pg, font) => pg.drawText("Page Two", { x: 72, y: 700, size: 24, font }),
    (pg, font) => pg.drawText("Page Three", { x: 72, y: 700, size: 24, font }),
  ]);
  return { gates, edit };
}

// ── 저장본 판독(Node pdf.js) ──────────────────────────────────────────────────────────────────────────
let pdfjsP = null;
const pdfjs = () =>
  (pdfjsP ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = pathToFileURL(join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    return m;
  }));

/** 쪽마다 { rotate, w, h, annots[{subtype, rect, quads}], img? } — render 에 든 쪽(1부터)은 1px/pt 로 그린 RGBA. */
async function readPdf(bytes, render = []) {
  const m = await pdfjs();
  const task = m.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    standardFontDataUrl: join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + "/",
  });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      const annots = (await pg.getAnnotations()).map((a) => ({
        subtype: a.subtype,
        rect: a.rect ? Array.from(a.rect) : null,
        quads: a.quadPoints ? Array.from(a.quadPoints) : null,
      }));
      let img = null;
      if (render.includes(i)) {
        const { canvas, context } = doc.canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
        await pg.render({ canvas, canvasContext: context, viewport: vp }).promise;
        const d = context.getImageData(0, 0, canvas.width, canvas.height);
        img = { w: d.width, h: d.height, data: d.data };
      }
      pages.push({ rotate: pg.rotate, w: vp.width, h: vp.height, annots, img });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const px = (img, x, y) => {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
  const o = (Math.round(y) * img.w + Math.round(x)) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
/** 기본 획 #FF3B30 — 흰 바탕 위 안티앨리어싱 가장자리까지. */
const isRed = (c) => !!c && c[0] > 200 && c[1] < 140 && c[2] < 140;

/** 파란 픽스처 사각형의 렌더 bbox(px, 끝 포함). 회전된 쪽이면 회전된 화면 좌표다. */
function blueBox(img) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      if (img.data[o + 2] > 200 && img.data[o] < 80 && img.data[o + 1] < 80) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return n ? { x0, y0, x1, y1, n, cx: (x0 + x1 + 1) / 2, cy: (y0 + y1 + 1) / 2 } : null;
}

/**
 * 사각형 bbox 에서 MARGIN 만큼 밖의 네 변 가운데(±3px 창)에 빨강이 있는 변 수 + 그 안쪽 틈(MARGIN/2)이 비었는지.
 * 노드가 페이지 내용을 따라가지 않았으면(회전 누락·좌표 어긋남) 테두리가 다른 자리에 있어 변 수가 떨어진다.
 */
function sidesAround(img, b) {
  if (!b) return { sides: 0, gapClean: false };
  const near = (x, y) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (isRed(px(img, x + dx, y + dy))) return true;
    return false;
  };
  const cx = b.cx, cy = b.cy;
  const hits = [
    near(b.x0 - MARGIN, cy),
    near(b.x1 + 1 + MARGIN, cy),
    near(cx, b.y0 - MARGIN),
    near(cx, b.y1 + 1 + MARGIN),
  ];
  const gapClean = ![
    px(img, b.x0 - MARGIN / 2, cy),
    px(img, b.x1 + 1 + MARGIN / 2, cy),
    px(img, cx, b.y0 - MARGIN / 2),
    px(img, cx, b.y1 + 1 + MARGIN / 2),
  ].some(isRed);
  return { sides: hits.filter(Boolean).length, gapClean };
}

/** PDF 좌표(아래 원점) quad 목록의 bbox 안에서 색 c(±tol)에 가까운 픽셀 비율. 쪽은 회전 0 이어야 한다. */
function colorShare(img, quads, hex, tol = 45) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const xs = quads.filter((_, i) => i % 2 === 0);
  const ys = quads.filter((_, i) => i % 2 === 1);
  const x0 = Math.ceil(Math.min(...xs)), x1 = Math.floor(Math.max(...xs));
  const y0 = Math.ceil(img.h - Math.max(...ys)), y1 = Math.floor(img.h - Math.min(...ys));
  let hit = 0, all = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = px(img, x, y);
      all++;
      if (p && p.every((v, k) => Math.abs(v - c[k]) <= tol)) hit++;
    }
  return { share: all ? hit / all : 0, all, box: [x0, y0, x1, y1] };
}

// ── 페이지 쪽 헬퍼 ────────────────────────────────────────────────────────────────────────────────
const HELPERS = `(() => {
  const A = (window.__gpv62 = {});
  A.h = (p) => (window.__gpv && window.__gpv.pdf && window.__gpv.pdf.byPath(p)) || null;
  A.root = (p) => { const h = A.h(p); return h ? h.root : null; };
  A.scroll = (p) => { const r = A.root(p); return r && r.querySelector('[data-pdf-scroll]'); };
  A.pageDiv = (p, i) => { const r = A.root(p); return (r && r.querySelector('.pdfViewer .page[data-page-number="' + (i + 1) + '"]')) || null; };
  A.cont = (p) => {
    const s = A.scroll(p);
    if (!s) return null;
    const b = s.getBoundingClientRect();
    return { left: b.left, top: b.top, width: s.clientWidth, height: s.clientHeight, bw: b.width, bh: b.height };
  };
  A.ready = (p) => {
    const h = A.h(p);
    if (!h) return null;
    const s = h.state();
    const pg = A.pageDiv(p, 0);
    return { id: s.id, status: s.status, loaded: !!pg && pg.hasAttribute('data-loaded') && !!pg.querySelector('.canvasWrapper canvas') };
  };
  A.ann = (p) => { const h = A.h(p); return h ? h.annotate.state() : null; };
  A.center = (el) => { const q = el.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2, disabled: !!el.disabled }; };
  A.btn = (p, sel) => { const r = A.root(p); const b = r && r.querySelector(sel); return b ? A.center(b) : null; };
  A.railBtn = (p, title) => {
    const r = A.root(p);
    const bar = r && r.querySelector('[role="toolbar"]');
    const b = bar && Array.from(bar.querySelectorAll('button')).find((x) => x.title === title);
    return b ? A.center(b) : null;
  };
  A.railTitles = (p) => {
    const r = A.root(p);
    const bar = r && r.querySelector('[role="toolbar"]');
    if (!bar) return null;
    return Array.from(bar.querySelectorAll('button')).map((b) => ({ title: b.title, caret: /▾/.test(b.textContent || '') }));
  };
  A.park = (p) => { const r = A.root(p).getBoundingClientRect(); return { x: r.left + 6, y: r.top + 4 }; };
  A.setScale = (p, s) => { A.h(p).viewer().currentScale = s; return true; };
  A.scrollToDoc = (p, page, x, y) => {
    const pt = A.h(p).annotate.docToClient(page, x, y);
    const s = A.scroll(p);
    if (!pt || !s) return false;
    const c = s.getBoundingClientRect();
    s.scrollLeft += pt.x - c.left;
    s.scrollTop += pt.y - c.top;
    return true;
  };
  A.box = (p, i) => { const d = A.pageDiv(p, i); return d && d.querySelector('[data-pdf-overlay-page="' + i + '"]'); };
  A.layer = (p, i) => { const b = A.box(p, i); return b && b.querySelector('[data-pdf-layer]'); };
  /** 활성 레이어의 씬 캔버스([0] 은 커밋 캐시). */
  A.scene = (p, i) => { const l = A.layer(p, i); return (l && l.querySelectorAll(':scope > canvas')[1]) || null; };
  /** 활성 레이어 기하 — viewport(pt)·배율(백킹 px/pt)은 씬 캔버스의 css 박스와 백킹에서, ds 는 오버레이 페이지 박스에서. */
  A.geo = (p, i) => {
    const b = A.box(p, i), c = A.scene(p, i);
    if (!b || !c) return null;
    const br = b.getBoundingClientRect();
    const ds = br.width / ${W};
    const L = parseFloat(c.style.left) || 0, T = parseFloat(c.style.top) || 0;
    const CW = parseFloat(c.style.width), CH = parseFloat(c.style.height);
    const cr = c.getBoundingClientRect();
    return {
      ds, dpr: devicePixelRatio,
      vp: { x: L / ds, y: T / ds, width: CW / ds, height: CH / ds },
      scale: c.width / (CW / ds),
      backW: c.width, backH: c.height, cssW: cr.width, cssH: cr.height,
      boxW: br.width, boxH: br.height,
      ir: getComputedStyle(c).imageRendering,
    };
  };
  /**
   * 씬 캔버스에서 문서 x=XC 열의 빨강 잉크 중심을 **client y** 로. 사선 (100,100)→(…, 기울기 0.3)은 그 열에서 y=YC 라
   * 기대값은 페이지 div 기준 docToClient(0, XC, YC).y — 레이어의 viewport 산술과 독립이다. XC·YC 는 스위트가 넣는다.
   */
  A.inkY = (c, g, cr) => {
    const bx = Math.round((A.XC - g.vp.x) * g.scale);
    if (bx < 0 || bx >= c.width) return { n: 0, y: null };
    const d = c.getContext('2d').getImageData(bx, 0, 1, c.height).data;
    let n = 0, sum = 0;
    for (let y = 0; y < c.height; y++) { const o = y * 4; if (d[o + 3] > 128 && d[o] > 150 && d[o + 1] < 100) { n++; sum += y; } }
    return { n, y: n ? cr.top + ((sum / n + 0.5) * cr.height) / c.height : null };
  };
  /** VP-1 · V2a — 원점을 옮기는 스크롤 뒤 **커밋 직후**(MutationObserver 마이크로태스크)와 두 프레임 뒤. */
  A.vp1 = (p, dyPt) => new Promise((resolve) => {
    const pre = A.geo(p, 0), c0 = A.scene(p, 0);
    if (!pre || !c0) return resolve({ err: 'no layer' });
    const w0 = c0.width, h0 = c0.height;
    // 옛 비트맵을 지금 떠 둔다 — 반증은 이 픽셀을 새 박스 자리에서 읽는다.
    const snap = document.createElement('canvas');
    snap.width = w0; snap.height = h0;
    snap.getContext('2d').drawImage(c0, 0, 0);
    let done = false;
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
    const mo = new MutationObserver(() => {
      if (done) return;
      const g = A.geo(p, 0);
      if (!g || Math.abs(g.vp.y - pre.vp.y) < 1e-6) return;
      done = true;
      mo.disconnect();
      const c1 = A.scene(p, 0), cr = c1.getBoundingClientRect();
      const want = A.h(p).annotate.docToClient(0, A.XC, A.YC).y;
      const mid = { vp: g.vp, scale: g.scale, ds: g.ds, same: c1 === c0, ink: A.inkY(c1, g, cr), want };
      // 반증: 스크롤 직전 픽셀(옛 원점)을 새 박스 자리에 놓고 같은 판정.
      const stale = A.inkY(snap, g, cr);
      snap.width = 0; snap.height = 0;
      (async () => {
        await raf(); await raf();
        const g2 = A.geo(p, 0), c2 = A.scene(p, 0);
        const post = { vp: g2.vp, w: c2.width, h: c2.height, same: c2 === c0, ink: A.inkY(c2, g2, c2.getBoundingClientRect()), want: A.h(p).annotate.docToClient(0, A.XC, A.YC).y };
        resolve({ pre: { vp: pre.vp, w: w0, h: h0 }, mid, stale, post });
      })();
    });
    mo.observe(c0, { attributes: true, attributeFilter: ['style'] });
    setTimeout(() => { if (!done) { done = true; mo.disconnect(); snap.width = 0; resolve({ err: 'timeout — 같은 캔버스에서 원점이 바뀌지 않았다', pre: pre.vp, now: A.geo(p, 0) }); } }, 3000);
    A.scroll(p).scrollTop += dyPt * pre.ds;
  });
  /**
   * 반증 탐침 — 1pt = 1 백킹 px 캔버스(흰 바탕 + 같은 사선)를 오버레이 페이지 박스와 같은 자리에 얹는다.
   * image-rendering pixelated 면 계단, auto 면 쌍선형 흐림이어야 한다(옛 하니스 image 전략의 몫).
   */
  A.probe = (p, mode, x2, y2) => {
    A.unprobe();
    const b = A.box(p, 0);
    if (!b) return false;
    const c = document.createElement('canvas');
    c.id = 'gpv62-probe';
    c.width = ${W}; c.height = ${H};
    Object.assign(c.style, { position: 'absolute', left: b.style.left, top: b.style.top, width: b.style.width, height: b.style.height, zIndex: '6', pointerEvents: 'none', imageRendering: mode });
    const x = c.getContext('2d');
    x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, ${W}, ${H});
    x.strokeStyle = '#FF0000'; x.lineWidth = 1; x.lineCap = 'round';
    x.beginPath(); x.moveTo(100, 100); x.lineTo(x2, y2); x.stroke();
    b.parentNode.appendChild(c);
    return true;
  };
  A.unprobe = () => { const c = document.getElementById('gpv62-probe'); if (c) { c.width = 0; c.height = 0; c.remove(); } return true; };
  A.textarea = (p) => {
    const t = A.root(p).querySelector('textarea');
    if (!t) return null;
    const q = t.getBoundingClientRect();
    return { value: t.value, focused: document.activeElement === t, x: q.left, y: q.top };
  };
  A.texts = (p, page) => A.h(p).annotate.getNodes(page).filter((n) => n.kind === 'text').map((n) => ({ text: n.text, x: n.x, y: n.y }));
  A.hitPage = (p, x, y) => {
    const e = document.elementFromPoint(x, y);
    const pg = e && e.closest('.page[data-page-number]');
    if (pg && A.root(p).contains(pg)) return { page: Number(pg.getAttribute('data-page-number')) - 1, inLayer: !!e.closest('[data-pdf-layer]') };
    A.lastMiss = e ? e.tagName + '.' + String(e.className).slice(0, 60) : null; // 페이지가 아니면 무엇이었나(진단)
    return null;
  };
  A.statics = (p) => {
    const out = [];
    for (const c of A.root(p).querySelectorAll('canvas[data-pdf-static]')) {
      const box = c.closest('[data-pdf-overlay-page]');
      out.push({ page: Number(box.getAttribute('data-pdf-overlay-page')), w: c.width, h: c.height });
    }
    return out;
  };
  A.markups = (p) => Array.from(A.root(p).querySelectorAll('[data-pdf-markup-id]')).map((g) => ({
    id: g.getAttribute('data-pdf-markup-id'), subtype: g.getAttribute('data-pdf-markup-subtype'),
    selected: !!g.querySelector('rect'), fill: (g.querySelector('polygon') || {}).getAttribute?.('fill') || null,
    ...A.center(g),
  }));
  A.span = (p, page, sub) => {
    const pg = A.pageDiv(p, page);
    const s = pg && Array.from(pg.querySelectorAll('.textLayer span')).find((x) => (x.textContent || '').includes(sub));
    if (!s) return null;
    const q = s.getBoundingClientRect();
    return { left: q.left, right: q.right, top: q.top, bottom: q.bottom };
  };
  A.thumbs = (p) => Array.from(A.root(p).querySelectorAll('[data-pdf-page-key]')).map((e) => ({ key: e.getAttribute('data-pdf-page-key'), selected: e.getAttribute('aria-selected') === 'true', ...A.center(e) }));
  /**
   * PNG → 행마다 첫 빨강 잉크 x. 빨강 = r − g > 64 (흰 바탕 위 부분 피복 25% 이상).
   * 검정 본문·파랑 크롬은 r ≈ g 거나 r < g 라 걸리지 않는다.
   */
  A.firstInk = async (b64) => {
    const img = await new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error('캡처 디코드 실패'));
      im.src = 'data:image/png;base64,' + b64;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    let minX = Infinity, minY = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      let fx = -1;
      for (let q = 0; q < c.width; q++) {
        const o = (y * c.width + q) * 4;
        if (d[o] - d[o + 1] > 64 && d[o] > 150) { fx = q; break; }
      }
      if (fx < 0) continue;
      rows.push([y, fx]);
      if (minY < 0) minY = y;
      maxY = y;
      if (fx < minX) minX = fx;
    }
    const w = c.width, h = c.height;
    c.width = 0;
    c.height = 0;
    // 열별 세로 단면(1c) — 피복 a = (r − g)/255 로 부분(0.1<a<0.9)·완전(≥0.9) 픽셀 수를 센다.
    // 선명한 1pt 사선은 가장자리마다 부분 1px 라 ≈2, 흐림·반 px 재샘플은 가장자리가 번져 늘어난다.
    const parts = [], fulls = [];
    for (let q = Math.floor(w * 0.25); q < Math.floor(w * 0.75); q += 3) {
      let pp = 0, f = 0, m = 0;
      for (let y = 0; y < h; y++) {
        const o = (y * w + q) * 4;
        const a = Math.max(0, Math.min(1, (d[o] - d[o + 1]) / 255));
        if (a >= 0.9) f++;
        else if (a > 0.1) pp++;
        m += a;
      }
      if (m > 0.5) { parts.push(pp); fulls.push(f); }
    }
    const med = (v) => { const s = [...v].sort((u, t) => u - t); return s.length ? s[s.length >> 1] : null; };
    const xsec = { cols: parts.length, medPartial: med(parts), medFull: med(fulls) };
    // 가운데 절반 행만 — 둥근 끝(캡) 근처의 가장 왼쪽 잉크는 캡 곡선이라 원래 같은 x 가 몇 행 이어진다.
    const a = Math.floor(rows.length * 0.25);
    const b = Math.ceil(rows.length * 0.75);
    let run = 0, maxRun = 0, prev = null;
    for (let k = a; k < b; k++) {
      const cur = rows[k];
      run = prev && prev[0] === cur[0] - 1 && prev[1] === cur[1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
      prev = cur;
    }
    return { w, h, inkRows: rows.length, maxRun, xsec, minX: rows.length ? minX : null, minY, maxY, sample: rows.slice(a, a + 10).map((q) => q[1]) };
  };
  return true;
})()`;

// ── Node 쪽 헬퍼 ──────────────────────────────────────────────────────────────────────────────────
async function send(c, method, params) {
  const res = await c._send(method, params);
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

const KEYS = {
  s: { key: "s", code: "KeyS", windowsVirtualKeyCode: 83 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

const poll = async (fn, ok, tries = 40, ms = 250) => {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await fn().catch(() => null);
    if (ok(v)) return v;
    await sleep(ms);
  }
  return v;
};

/**
 * 힙에 살아 있는 캔버스 전부의 [개수, Σ width×height] — **강제 GC 뒤**. DOM 질의로는 레이어 풀·효과 스크래치 같은 분리
 * 캔버스가 안 보이고, 요소 질의만으로도 모자란다: **컨텍스트로만** 붙잡힌 캔버스는 수정되지 않은 JS 래퍼가 스캐빈지에서
 * 버려져 C++ 캔버스만 살아남는다. 그래서 CanvasRenderingContext2D 도 질의해 `ctx.canvas` 와 합집합으로 센다.
 */
async function heapCanvases(cdp) {
  await send(cdp, "HeapProfiler.collectGarbage");
  const protoEl = await send(cdp, "Runtime.evaluate", { expression: "HTMLCanvasElement.prototype", objectGroup: GROUP });
  const protoCtx = await send(cdp, "Runtime.evaluate", { expression: "CanvasRenderingContext2D.prototype", objectGroup: GROUP });
  try {
    const qe = await send(cdp, "Runtime.queryObjects", { prototypeObjectId: protoEl.result.objectId, objectGroup: GROUP });
    const qc = await send(cdp, "Runtime.queryObjects", { prototypeObjectId: protoCtx.result.objectId, objectGroup: GROUP });
    const v = await send(cdp, "Runtime.callFunctionOn", {
      objectId: qe.objects.objectId,
      functionDeclaration:
        "function(ctxs){let ea=0;for(const c of this)ea+=c.width*c.height;" +
        "const s=new Set(this);for(const x of ctxs)s.add(x.canvas);" +
        "let a=0;for(const c of s)a+=c.width*c.height;return [s.size,a,this.length,ea]}",
      arguments: [{ objectId: qc.objects.objectId }],
      returnByValue: true,
    });
    const [count, area, elCount, elArea] = v.result.value;
    return { count, area, elCount, elArea };
  } finally {
    await send(cdp, "Runtime.releaseObjectGroup", { objectGroup: GROUP });
  }
}

const mp = (n) => (n / 1e6).toFixed(1);

export async function run({ cdp, report: r, fix }) {
  // `__gpv.pdf` 는 PdfView 청크(지연 로드)가 처음 불릴 때 생긴다 — 여기서는 `__gpv.ui` 만 본다. 파일을 연 뒤에도
  // byPath 가 없으면 아래 waitReady 가 빨갛게 끝난다(조용한 skip 이 아니다).
  const dev = await poll(() => cdp.eval(`!!(window.__gpv && window.__gpv.ui)`), (v) => v === true, 16, 250);
  if (dev !== true) {
    r.skip("PDF 주석 편집", "window.__gpv.ui 미노출(dev 빌드 아님) — 스킵");
    return;
  }
  const pid = fix.projectId;
  const put = (rel, buf) => {
    const f = join(fix.repo, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, buf);
  };
  const disk = (rel) => readFileSync(join(fix.repo, rel));

  // ── 입력 ──
  const mouse = (type, p, buttons = 0) =>
    send(cdp, "Input.dispatchMouseEvent", {
      type,
      x: p.x,
      y: p.y,
      button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const click = async (p) => {
    await mouse("mouseMoved", p);
    await mouse("mousePressed", p, 1);
    await mouse("mouseReleased", p, 0);
  };
  const drag = async (a, b, steps = 4) => {
    await mouse("mouseMoved", a);
    await mouse("mousePressed", a, 1);
    for (let k = 1; k <= steps; k++) {
      await mouse("mouseMoved", { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps }, 1);
    }
    await mouse("mouseReleased", b, 0);
  };
  const press = async (name, modifiers = 0) => {
    const k = KEYS[name];
    const base = { ...k, nativeVirtualKeyCode: k.windowsVirtualKeyCode, modifiers };
    await send(cdp, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
    await send(cdp, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  };
  const frames = () => cdp.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  const A = (body, opts) => cdp.eval(`(async () => { const A = window.__gpv62; ${body} })()`, opts);
  const ann = (p) => A(`return A.ann(${J(p)});`);
  const at = async (p, page, x, y) => {
    const q = await A(`return A.h(${J(p)}).annotate.docToClient(${page}, ${x}, ${y});`);
    if (!q) throw new Error(`docToClient(${page}, ${x}, ${y}) null`);
    return q;
  };
  const park = async (p) => mouse("mouseMoved", await A(`return A.park(${J(p)});`));
  const setScale = async (p, s) => {
    await A(`return A.setScale(${J(p)}, ${s});`);
    await sleep(SETTLE_WAIT);
    await frames();
  };
  const scrollToDoc = async (p, page, x, y) => {
    await A(`return A.scrollToDoc(${J(p)}, ${page}, ${x}, ${y});`);
    await frames();
    await sleep(60);
    await frames();
  };

  // ── 뷰어 ──
  const setView = () =>
    cdp.eval(`window.__gpv.ui.setState({
      viewerLayout: { kind: 'leaf', paneId: ${J(PANE)} },
      viewerActivePaneId: ${J(PANE)},
      viewerByPane: {}, viewerMaximizedPaneId: null,
      selectedDiff: null, selectedDiffRepoId: null,
    })`);
  const open = (path) => cdp.eval(`window.__gpv.ui.getState().selectDiff(${J({ mode: "file", path })})`);
  const waitReady = (p) => poll(() => A(`return A.ready(${J(p)});`), (v) => v?.status === "ready" && v.loaded, 120, 250);
  const enterAnnotate = async (p, pages) => {
    const b = await A(`return A.btn(${J(p)}, '[data-pdf-mode="annotate"]');`);
    if (!b || b.disabled) return { err: `주석 버튼 ${J(b)}` };
    await click(b);
    return poll(() => ann(p), (s) => s?.mode === "annotate" && s.nodes.length === pages, 120, 250);
  };
  /** 탭을 모두 닫고(PdfView 언마운트) 같은 경로를 새로 연다 — 인스턴스 id 가 바뀌어야 진짜 다시 연 것이다. */
  const reopen = async (p) => {
    const id0 = (await A(`return A.ready(${J(p)});`))?.id ?? null;
    await cdp.eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(pid)})`);
    await setView(); // selectedDiff 도 비운다 — 탭만 닫으면 선택된 파일 화면이 인스턴스를 붙잡고 있다
    const gone = await poll(() => A(`return A.h(${J(p)}) ? 1 : 0;`), (v) => v === 0, 40, 100);
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, 'viewer')`);
    await open(p);
    const rd = await waitReady(p);
    return { ok: gone === 0 && rd?.status === "ready" && rd.loaded && rd.id !== id0, id0, id1: rd?.id ?? null };
  };
  /** Ctrl+S(실제 키) → 이 저장의 lastSave. */
  const saveByKey = async (p) => {
    const before = (await ann(p))?.lastSave?.at ?? 0;
    await press("s", MOD);
    return poll(() => ann(p), (s) => (s?.lastSave?.at ?? 0) > before, 80, 250).then((s) => s?.lastSave ?? null);
  };

  const VIEW_SNAP = `(() => {
    const s = window.__gpv.ui.getState();
    return JSON.stringify({
      layout: s.viewerLayout, active: s.viewerActivePaneId, byPane: s.viewerByPane,
      max: s.viewerMaximizedPaneId, diff: s.selectedDiff, repo: s.selectedDiffRepoId,
      project: s.selectedProjectId, agg: s.aggregateOpen, report: s.reportOpen,
    });
  })()`;
  const t0 = await cdp.eval(`performance.timeOrigin`);
  const snap = await cdp.eval(VIEW_SNAP);
  const origTab = await cdp.eval(
    `(() => { const t = window.__gpv.terminals.getState().activeTab; return t[${J(pid)}] || null; })()`,
  );

  let F = null;
  try {
    try {
      F = await buildFixtures();
    } catch (e) {
      r.check("픽스처 생성(pdf-lib)", false, e.message);
      return;
    }
    put(P.gates, F.gates);
    put(P.edit, F.edit);

    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp
      .eval(`(() => { const s = window.__gpv.ui.getState(); if (s.reportOpen) s.toggleReport(); return true; })()`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(pid)})`);
    const picked = await poll(() => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`), (v) => v === pid, 16, 250);
    if (!r.check("셋업: 픽스처 프로젝트 선택", picked === pid, String(picked))) return;
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, 'viewer')`);
    await setView();
    if (!r.check("페이지 헬퍼 설치", (await cdp.eval(HELPERS)) === true)) return;

    await gatesBlock();
    await editBlock();

    const t1 = await cdp.eval(`performance.timeOrigin`);
    r.check("실행 중 창 리로드 없음(performance.timeOrigin 불변) — 리로드가 끼었으면 위 수치는 무효", t1 === t0, `${t0} → ${t1}`);
  } finally {
    await cdp.eval(`window.__gpv62 && window.__gpv62.unprobe()`).catch(() => {});
    await cdp
      .eval(`(() => { const s = window.__gpv.ui.getState(); s.closeConfirm(); s.closePrompt(); return true; })()`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(pid)})`).catch(() => {});
    await cdp
      .eval(`(() => {
        const p = JSON.parse(${J(snap)});
        const orig = ${J(origTab)};
        const t = window.__gpv.terminals.getState();
        if (orig) t.setActiveTab(${J(pid)}, orig);
        if (p.project) window.__gpv.ui.getState().selectProject(p.project);
        if (p.agg) window.__gpv.ui.getState().setAggregateOpen(true);
        if (p.report) window.__gpv.ui.getState().toggleReport();
        window.__gpv.ui.setState({
          viewerLayout: p.layout, viewerActivePaneId: p.active, viewerByPane: p.byPane,
          viewerMaximizedPaneId: p.max, selectedDiff: p.diff, selectedDiffRepoId: p.repo,
        });
        return true;
      })()`)
      .catch(() => {});
    await cdp.eval(`delete window.__gpv62`).catch(() => {});
    await sleep(300);
    try {
      rmSync(join(fix.repo, DIR), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 앱이 쥐고 있으면 러너 teardown 이 픽스처째 지운다 */
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // 오버레이 게이트 — gates.pdf
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  async function gatesBlock() {
    const p = P.gates;
    const S = `A.h(${J(p)}).annotate`;
    await open(p);
    const rd = await waitReady(p);
    if (!r.check("(게이트) gates.pdf 가 PdfView 로 열리고 1쪽이 그려진다", rd?.status === "ready" && rd.loaded, J(rd))) return;
    const st0 = await enterAnnotate(p, 3);
    if (!r.check("(게이트) [주석] 버튼(실제 클릭)으로 주석 모드 — 3쪽 세션", st0?.mode === "annotate" && st0.nodes.length === 3, J(st0)))
      return;
    await park(p);

    // ── A4 레일 ─────────────────────────────────────────────────────────────
    // tools 가 무시되면 이미지 편집기 레일 20여 개가 그대로 나오고 형광펜은 없다 → 빨강.
    const rail = await A(`return A.railTitles(${J(p)});`);
    const tools = rail ? rail.filter((b) => b.title !== SWATCH_TITLE) : null;
    r.check(
      "(A4) 레일 = PDF 도구 10종 · 이 순서 · 플라이아웃 캐럿 0 (형광펜은 플라이아웃 전용인데도 레일에 올라온다)",
      !!tools && J(tools.map((b) => b.title)) === J(RAIL_EXPECT) && tools.every((b) => !b.caret),
      J(tools?.map((b) => b.title + (b.caret ? "▾" : "")) ?? null),
    );

    // ── 게이트 1 — 400% 선명도 ───────────────────────────────────────────────
    await A(`A.scroll(${J(p)}).scrollTop = 0; return true;`);
    await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(0)`);
    await setScale(p, 4);
    await scrollToDoc(p, 0, 90, 90);
    const cont = await A(`return A.cont(${J(p)});`);
    const g0 = await A(`return A.geo(${J(p)}, 0);`);
    // 사선 길이는 보이는 영역에 맞춘다(뷰어 칸 폭은 회차·창마다 다르다 — 샤드 앱 실측 546css = 82pt). 1c 단면 열 수(≥100)가
    // 나오려면 클립 폭이 ≈600 디바이스 px 는 돼야 해 ≥60pt 를 요구한다. VP-1 이 읽는 열은 사선 가운데(XC, YC)다.
    const Lpt = g0 && cont ? Math.min(200, Math.floor(cont.width / g0.ds - 20)) : 0;
    if (!r.check("(1) 400% 에서 사선(≥60pt)이 보이는 영역에 든다", Lpt >= 60, `L=${Lpt}pt · 컨테이너 ${J(cont)} · geo ${J(g0)}`)) return;
    const X2 = 100 + Lpt;
    const Y2 = 100 + 0.3 * Lpt;
    const XC = 100 + Lpt / 2;
    const YC = 100 + 0.3 * (Lpt / 2);
    await A(`A.XC = ${XC}; A.YC = ${YC}; return true;`);
    const LINE = { id: "g1-line", kind: "line", x1: 100, y1: 100, x2: X2, y2: Y2, strokeWidth: 1, strokes: [solid("#FF0000")] };
    const n1 = await A(`return await ${S}.setNodes(0, ${J([LINE])});`);
    r.check("(1) 노드 주입 — 1pt 사선이 스키마 정규화를 통과", n1 === 1, `nodes=${n1}`);
    await frames();

    /** 문서 사각형(페이지 0, pt)을 디바이스 px 에 붙인 클립으로 캡처한다. */
    const capture = async ([x0, y0, x1, y1]) => {
      const clip = await A(`
        const h = A.h(${J(p)}), d = devicePixelRatio;
        const a = h.annotate.docToClient(0, ${x0}, ${y0}), b = h.annotate.docToClient(0, ${x1}, ${y1});
        if (!a || !b) return null;
        const q = (v) => Math.round(v * d) / d;
        return { x: q(a.x) + scrollX, y: q(a.y) + scrollY, width: q(b.x) - q(a.x), height: q(b.y) - q(a.y), scale: 1 };`);
      if (!clip) return { ok: false, why: "docToClient null" };
      const res = await cdp._send("Page.captureScreenshot", { format: "png", clip, captureBeyondViewport: false });
      if (res.error || !res.result?.data) return { ok: false, why: res.error?.message || "data 없음", clip };
      return { ok: true, data: res.result.data, clip };
    };
    const CLIP = [95, 95, X2 + 5, Y2 + 5];
    const inkOf = async () => {
      await sleep(200); // 큰 레이어 페인트·합성 여유
      const shot = await capture(CLIP);
      const ink = shot.ok ? await cdp.eval(`window.__gpv62.firstInk(${J(shot.data)})`) : null;
      const inView =
        shot.ok &&
        shot.clip.x >= cont.left &&
        shot.clip.y >= cont.top &&
        shot.clip.x + shot.clip.width <= cont.left + cont.width &&
        shot.clip.y + shot.clip.height <= cont.top + cont.height;
      return { ink, inView, why: shot.ok ? "" : shot.why, clip: shot.clip ?? null };
    };

    const g1 = await A(`return A.geo(${J(p)}, 0);`);
    const pass1a = (g) => !!g && Math.abs(g.backW - g.cssW * g.dpr) < 1 && Math.abs(g.backH - g.cssH * g.dpr) < 1 && g.ir === "auto";
    const real = await inkOf();
    const ppd = g1 ? g1.ds * g1.dpr : 0; // 디바이스 px / pt
    r.info(`1 viewport: geo=${J(g1)} ink=${J(real.ink)} clip=${J(real.clip)} inView=${real.inView} ${real.why}`);

    // 반증 탐침 — pixelated(계단) · auto(쌍선형 흐림). 실제 레이어 위에 흰 바탕째 얹으므로 아래 사선은 가려진다.
    const probeInk = async (mode) => {
      await A(`return A.probe(${J(p)}, ${J(mode)}, ${X2}, ${Y2});`);
      try {
        return await inkOf();
      } finally {
        await A(`return A.unprobe();`);
      }
    };
    const stair = await probeInk("pixelated");
    const bil = await probeInk("auto");
    // 반 디바이스 px 원점 — 실제 레이어 div 의 transform 만 런타임에 바꾼다(React 는 이 div 에 style 을 쓰지 않는다).
    let sub = null;
    try {
      await A(`const l = A.layer(${J(p)}, 0); l.style.transform = 'translate(' + (0.5 / devicePixelRatio) + 'px, ' + (0.5 / devicePixelRatio) + 'px)'; return true;`);
      sub = await inkOf();
    } finally {
      await A(`const l = A.layer(${J(p)}, 0); if (l) l.style.transform = ''; return true;`).catch(() => {});
    }
    r.info(`1 반증: pixelated=${J(stair.ink)} · bilinear=${J(bil.ink?.xsec ?? null)} · halfpx=${J(sub?.ink?.xsec ?? null)}`);

    r.check(
      "(1a) 400% settle 뒤 활성 레이어 |backW − cssW·dpr| < 1 · |backH − cssH·dpr| < 1 · image-rendering auto (반증은 VP-2 의 줌 도중 고정 상태)",
      pass1a(g1) && Math.abs(g1.ds - (4 * 4) / 3) < 0.01,
      g1 ? `back ${g1.backW}×${g1.backH} css ${g1.cssW.toFixed(2)}×${g1.cssH.toFixed(2)} dpr=${g1.dpr} ds=${g1.ds.toFixed(4)} rendering=${g1.ir}` : "레이어 없음",
    );
    const sk = stair.ink;
    const stairMin = Math.max(4, Math.floor(ppd * 0.75));
    const counter1b = !!sk && sk.inkRows > 0 && sk.maxRun >= stairMin && stair.inView;
    r.check(
      `(1b-반증) 1pt = 1 백킹 px 캔버스(pixelated)는 같은 사선의 첫 잉크 x 가 ≥${stairMin}행 연속 같다(계단) — 안 나오면 지표가 계단을 못 보는 것이라 1b 는 무효`,
      counter1b,
      sk ? `maxRun=${sk.maxRun} inkRows=${sk.inkRows} sample=${J(sk.sample)} inView=${stair.inView}` : `캡처 실패 ${stair.why}`,
    );
    {
      const k = real.ink;
      // 잉크 세로 폭 ≈ (0.3L + 1)pt(둥근 끝 포함), 클립 원점 (95,95) 기준 잉크 좌상단 ≈ (4.5pt, 4.5pt).
      const rowsWant = (0.3 * Lpt + 1) * ppd;
      const rowsOk = !!k && k.inkRows >= 0.9 * rowsWant && k.inkRows <= 1.1 * rowsWant;
      const posOk = !!k && k.minX !== null && Math.abs(k.minX - 4.5 * ppd) <= ppd + 2 && Math.abs(k.minY - 4.5 * ppd) <= ppd + 2;
      r.check(
        "(1b) 400% 1pt 사선의 첫 잉크 x 최대 연속 ≤ 3 · 잉크 행 수·위치가 문서 좌표와 일치 · 반증 유효",
        counter1b && !!k && k.maxRun <= 3 && rowsOk && posOk && real.inView,
        k
          ? `maxRun=${k.maxRun} (계단 ${sk?.maxRun ?? "-"}) inkRows=${k.inkRows}/${Math.round(rowsWant)} min=(${k.minX},${k.minY}) 기대≈${(4.5 * ppd).toFixed(1)} img=${k.w}×${k.h} inView=${real.inView}`
          : `캡처 실패 ${real.why}`,
      );
    }
    // 부분 피복 ≤ 2 — 선명한 1pt 는 위·아래 가장자리에 하나씩이라 2 다. 실제 오버레이의 반 디바이스 px 원점은 3 이 나온다
    // (2026-10-29 실측 2/8 vs 3/7 — 하니스는 4/7 이었다). ≤3 으로 두면 반 px 흐림이 선명 판정에 들어간다.
    const sharp = (x) => !!x && x.cols >= 100 && x.medPartial !== null && x.medPartial <= 2 && x.medFull >= 1;
    const cp1c = !!bil.ink?.xsec && !!sub?.ink?.xsec && bil.ink.xsec.cols >= 100 && sub.ink.xsec.cols >= 100 && !sharp(bil.ink.xsec) && !sharp(sub.ink.xsec);
    r.check(
      "(1c-반증) 단면 지표가 쌍선형 흐림(1pt = 1 백킹 px + auto)과 반 디바이스 px 원점 재샘플(실제 레이어 + translate)을 둘 다 흐림으로 판정한다",
      cp1c,
      `bilinear=${J(bil.ink?.xsec ?? null)} maxRun=${bil.ink?.maxRun} · halfpx=${J(sub?.ink?.xsec ?? null)} maxRun=${sub?.ink?.maxRun}`,
    );
    r.check(
      "(1c) 400% 1pt 사선의 열별 단면 — 부분 피복 픽셀 중앙값 ≤ 2 · 완전 피복 중앙값 ≥ 1 · 반증 유효",
      cp1c && sharp(real.ink?.xsec),
      J(real.ink?.xsec ?? null),
    );

    // ── P — viewport 계약(400%) ─────────────────────────────────────────────
    const vp1 = await A(`return await A.vp1(${J(p)}, 20);`, { timeoutMs: 15000 });
    if (vp1?.err) {
      r.check("(VP-1) 원점을 옮기는 스크롤에서 같은 씬 캔버스의 원점이 바뀐다", false, J(vp1));
    } else {
      const { pre, mid, stale, post } = vp1;
      const tol = mid.ds; // 1pt(css px)
      const cp = mid.vp.y - pre.vp.y >= 5 && Math.abs(mid.vp.x - pre.vp.x) < 1e-6 && stale.n > 0 && Math.abs(stale.y - mid.want) > 4 * tol;
      r.check(
        "(VP-1-반증) 스크롤 직전 비트맵(옛 원점)을 새 박스 자리에서 읽으면 기대 위치에서 4pt 넘게 벗어난다 — 지표가 원점 어긋남을 구별한다",
        cp,
        `원점 y ${pre.vp.y.toFixed(2)}→${mid.vp.y.toFixed(2)} · 옛 픽셀 잉크 y ${stale.y?.toFixed(2)}(n=${stale.n}) vs 기대 ${mid.want.toFixed(2)}`,
      );
      r.check(
        "(VP-1) viewport 원점을 옮긴 스크롤의 커밋 직후(MutationObserver — rAF 전) 사선이 페이지의 제자리(가운데 열, ±1pt)에 그려져 있다 · 반증 유효",
        cp && mid.same && mid.ink.n > 0 && Math.abs(mid.ink.y - mid.want) <= tol,
        `잉크 y ${mid.ink.y?.toFixed(2)}(n=${mid.ink.n}) 기대 ${mid.want.toFixed(2)}±${tol.toFixed(2)} same=${mid.same}`,
      );
      r.check(
        "(V2a) 원점만 옮긴 스크롤(백킹 크기 같음 · 재마운트 없음) 뒤 프레임이 지나도 새 원점 픽셀이다 — 커밋 캐시 키가 원점을 구별한다 · 반증 유효",
        cp &&
          post.same &&
          pre.w === post.w &&
          pre.h === post.h &&
          J(post.vp) === J(mid.vp) &&
          post.ink.n > 0 &&
          Math.abs(post.ink.y - post.want) <= tol,
        `백킹 ${pre.w}×${pre.h} → ${post.w}×${post.h} same=${post.same} · 잉크 y ${post.ink.y?.toFixed(2)} 기대 ${post.want?.toFixed(2)}`,
      );
    }

    // VP-2: settle(150ms) 전에 읽는다. 고정이 없으면 라이브 줌으로 보이는 문서 높이를 settle 배율로 덮는다.
    const vp2 = await A(`
      const p = ${J(p)};
      const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
      const pre = A.geo(p, 0), c0 = A.scene(p, 0);
      const w0 = c0.width, h0 = c0.height; // 지금 읽는다 — 반환 시점(settle 뒤)에 읽으면 전·도중이 같은 값이 된다
      A.setScale(p, 1);
      await raf(); await raf(); await raf();
      const mid = A.geo(p, 0), c1 = A.scene(p, 0);
      const w1 = c1 ? c1.width : null, h1 = c1 ? c1.height : null;
      const pg = A.pageDiv(p, 0).getBoundingClientRect();
      const liveDocH = A.cont(p).height / (pg.width / ${W});
      await new Promise((res) => setTimeout(res, ${SETTLE_WAIT}));
      await raf(); await raf();
      const post = A.geo(p, 0);
      return { pre: { vp: pre.vp, w: w0, h: h0, scale: pre.scale }, mid: { geo: mid, w: w1, h: h1, same: c0 === c1 }, post: { geo: post }, liveDocH };`);
    {
      const { pre, mid, post, liveDocH } = vp2;
      const m = mid.geo;
      const near = (a, b) => Math.abs(a - b) < 1e-3;
      r.check(
        "(VP-2) 400%→100% 줌 도중(settle 전) viewport·백킹 크기·씬 캔버스가 settle 값에 고정된다(라이브로 보이는 문서 높이 ≥ 고정 영역×2 인데도) · settle 뒤에는 풀린다",
        !!m &&
          liveDocH >= 2 * pre.vp.height &&
          mid.same &&
          near(m.vp.x, pre.vp.x) &&
          near(m.vp.y, pre.vp.y) &&
          near(m.vp.width, pre.vp.width) &&
          mid.w === pre.w &&
          mid.h === pre.h &&
          !!post.geo &&
          post.geo.scale < pre.scale / 2,
        `vp ${J(pre.vp)} → ${J(m?.vp)} · 백킹 ${pre.w}×${pre.h} → ${mid.w}×${mid.h} same=${mid.same} · 라이브 문서 높이 ${liveDocH.toFixed(0)}pt vs 고정 ${pre.vp.height.toFixed(0)}pt · settle 뒤 scale ${pre.scale.toFixed(3)}→${post.geo?.scale.toFixed(3)}`,
      );
      r.check(
        "(1a-반증) 줌 도중 고정된 레이어(백킹 = settle 값, css = 라이브 배율)에서는 1a 식이 실패한다 — 이 식이 백킹·화면 어긋남을 구별한다는 증거",
        !!m && mid.same && !pass1a(m),
        m ? `back ${m.backW}×${m.backH} css ${m.cssW.toFixed(1)}×${m.cssH.toFixed(1)} dpr=${m.dpr}` : "레이어 없음",
      );
    }

    // VP-3: 사각형 도구 실제 드래그. 빈 페이지에서 그린다 — 다른 노드가 있으면 오브젝트 스냅(굵기 절반만큼 부푼 AABB 경계,
    // 400% 에서 임계 0.75pt)이 끝점을 끌어 0.5pt 짜리 어긋남이 생긴다(2026-09-18 하니스 실측 — 그때는 사선 끝 y=160 이
    // 끝점 170 근처였다). 허용치 ±0.05 를 넓히지 마라: 넓히는 순간 "정상"과 "0.5pt 어긋남"이 같은 판정에 들어간다.
    await setScale(p, 4);
    await scrollToDoc(p, 0, 90, 90);
    await A(`return await ${S}.setNodes(0, []);`);
    await A(`${S}.setTool('rect'); return true;`);
    await frames();
    const vpD = (await A(`return A.geo(${J(p)}, 0);`))?.vp ?? null;
    const d0 = await at(p, 0, 120, 120);
    const d1 = await at(p, 0, 176, 170);
    await A(`window.__gpv62.ev = []; window.__gpv62.onEv = (e) => window.__gpv62.ev.push([e.type, e.clientX, e.clientY]);
      for (const t of ['pointerdown', 'pointerup']) window.addEventListener(t, window.__gpv62.onEv, true); return true;`);
    await drag(d0, d1);
    await frames();
    const rects = await A(`return ${S}.getNodes(0).filter((n) => n.kind === 'rect').map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));`);
    const diag = await A(`for (const t of ['pointerdown', 'pointerup']) window.removeEventListener(t, A.onEv, true);
      const div = A.pageDiv(${J(p)}, 0), b = A.box(${J(p)}, 0);
      const br = b.getBoundingClientRect(), cw = div.querySelector('.canvasWrapper'), wr = cw && cw.getBoundingClientRect();
      return { ev: A.ev, border: getComputedStyle(div).borderLeftWidth, clientLeft: div.clientLeft, pdfjs: wr && { x: wr.left, y: wr.top }, overlay: { x: br.left, y: br.top } };`);
    // 어긋나면 먼저 볼 것: 포인터가 요청 좌표로 왔나(ev) · 오버레이 박스 원점 = pdf.js 캔버스 원점(±⅓ css px 스냅)인가.
    r.info(`VP-3 진단: 요청 ${J(d0)}→${J(d1)} · ${J(diag)}`);
    await A(`${S}.setTool('select'); return true;`);
    await park(p);
    {
      const R = { x: 120, y: 120, w: 56, h: 50 };
      const q = rects.length === 1 ? rects[0] : null;
      r.check(
        "(VP-3) 400% 사각형 도구 실제 포인터 드래그 (120,120)→(176,170) — viewport 원점 ≥5pt 에서 x·y·w·h ±0.05pt",
        !!vpD && vpD.x >= 5 && vpD.y >= 5 && !!q && ["x", "y", "w", "h"].every((k) => Math.abs(q[k] - R[k]) <= 0.05),
        `viewport=${J(vpD)} → ${J(rects)} · 원점을 빠뜨리면 x≈${vpD ? (120 - vpD.x).toFixed(2) : "-"}`,
      );
    }

    // ── T — 전환과 텍스트(LC-3 · LC-2) ────────────────────────────────────────
    // 60% — 페이지 0 아래쪽과 페이지 1 위쪽이 한 화면에, 페이지 좌우로 여백이 남는다.
    await A(`return await ${S}.setNodes(0, []);`);
    await setScale(p, 0.6);
    await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(0)`);
    await scrollToDoc(p, 0, 0, 520);
    await A(`${S}.setTool('text'); return true;`);
    /** 활성 페이지 0 을 텍스트 도구로 눌러 편집을 열고 글자를 넣는다(실제 포인터 + insertText). */
    const typeOnPage0 = async (x, y, text) => {
      const q = await at(p, 0, x, y);
      await click(q);
      await frames();
      await send(cdp, "Input.insertText", { text });
      await frames();
      return { ta: await A(`return A.textarea(${J(p)});`), want: q };
    };
    const hasT = (list, t) => list.some((n) => n.text === t);

    // LC-3: 편집 중 PdfView.switchPage(설계 §8.2 순서 — 확정 → 잔재 정리 → 활성 변경). 전환 전 포인터를 치운다 —
    // 실제 오버레이는 hover 전환이 늘 켜져 있어, 레이아웃이 바뀐 뒤 커서 아래 이동이 활성을 되돌릴 수 있다.
    const eB = await typeOnPage0(100, 600, "전환확정");
    const beforeB = await A(`return A.texts(${J(p)}, 0);`);
    await park(p);
    await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(1)`);
    await frames();
    const t0B = await A(`return A.texts(${J(p)}, 0);`);
    const t1B = await A(`return A.texts(${J(p)}, 1);`);
    const sB = await ann(p);
    const taB = await A(`return A.textarea(${J(p)});`);
    const nB = t0B.find((n) => n.text === "전환확정");
    const boxOk = !!eB.ta && Math.abs(eB.ta.x - eB.want.x) <= 1 && Math.abs(eB.ta.y - eB.want.y) <= 1;
    r.check(
      "(LC-3) 텍스트 편집 중 활성 페이지 전환 — 전환 전 노드 없음 → 옛 페이지 0 에 확정(클릭 자리 ±0.5pt · textarea 좌상단 ±1css) · 새 페이지 1 에는 없음 · 편집 해제 · 도구 유지",
      !!eB.ta &&
        eB.ta.value === "전환확정" &&
        eB.ta.focused &&
        boxOk &&
        !hasT(beforeB, "전환확정") &&
        !!nB &&
        Math.abs(nB.x - 100) <= 0.5 &&
        Math.abs(nB.y - 600) <= 0.5 &&
        !hasT(t1B, "전환확정") &&
        !taB &&
        sB.tool === "text" &&
        sB.active === 1,
      `편집 ${J(eB.ta)} 기대 ${J(eB.want)} · 전 ${J(beforeB)} → 0쪽 ${J(t0B)} · 1쪽 ${J(t1B)} · textarea=${J(taB)} tool=${sB.tool} active=${sB.active}`,
    );

    // LC-2 ①: 편집 중에는 hover 전환이 막힌다(textEditing 가드). 누름이 유일한 경로다.
    await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(0)`);
    const eC = await typeOnPage0(100, 700, "누름확정");
    const p1 = await at(p, 1, 300, 150);
    const hit1 = await A(`return A.hitPage(${J(p)}, ${p1.x}, ${p1.y});`);
    await mouse("mouseMoved", p1);
    await frames();
    const actHover = (await ann(p)).active;
    await mouse("mousePressed", p1, 1);
    await mouse("mouseReleased", p1, 0);
    await frames();
    const sC = await ann(p);
    const t0C = await A(`return A.texts(${J(p)}, 0);`);
    const t1C = await A(`return A.texts(${J(p)}, 1);`);
    const taC = await A(`return A.textarea(${J(p)});`);
    r.check(
      "(LC-2) 텍스트 편집 중 비활성 페이지 1 — 올라가기만 해서는 활성 불변, 누르면 곧바로 활성 · 편집 텍스트는 옛 페이지 0 에 확정 · 새 페이지에 텍스트 생성 없음",
      eC.ta?.value === "누름확정" &&
        hit1?.page === 1 &&
        !hit1.inLayer &&
        actHover === 0 &&
        sC.active === 1 &&
        hasT(t0C, "누름확정") &&
        t1C.length === 0 &&
        !taC,
      `편집 ${J(eC.ta)} · 누른 자리 ${J(hit1)} · 이동 뒤 active=${actHover} · 누른 뒤 active=${sC.active} · 0쪽 ${J(t0C)} · 1쪽 ${J(t1C)} · textarea=${J(taC)}`,
    );

    // LC-2 ②: 여백에서 누른 채 들어오면 이동 전환이 buttons≠0 가드에 막힌다 — 놓은 뒤 첫 이동이 다시 판정해야 한다.
    await A(`${S}.setTool('select'); return true;`);
    await park(p);
    await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(0)`);
    const c2 = await A(`return A.cont(${J(p)});`);
    // 페이지 1 왼쪽 위 — 오른쪽 아래는 토스트 자리라 elementFromPoint 가 페이지 밖으로 나온다.
    const p1b = await at(p, 1, 40, 120);
    const grey = { x: c2.left + 8, y: p1b.y };
    const inP1 = { x: p1b.x, y: p1b.y + 20 };
    const hitGrey = await A(`return A.hitPage(${J(p)}, ${grey.x}, ${grey.y});`);
    const hitIn = await A(`return A.hitPage(${J(p)}, ${inP1.x}, ${inP1.y}) || { miss: A.lastMiss };`);
    await mouse("mouseMoved", grey);
    await frames();
    await drag(grey, inP1);
    await frames();
    const actReleased = (await ann(p)).active;
    await mouse("mouseMoved", { x: inP1.x + 4, y: inP1.y + 2 });
    await frames();
    const actMoved = (await ann(p)).active;
    r.check(
      "(LC-2) 여백에서 누른 채 페이지 1 로 들어와 놓으면 가드(buttons≠0)에 막혀 활성 불변 — 놓은 뒤 첫 이동에서 다시 판정해 활성이 된다",
      hitGrey === null && hitIn?.page === 1 && actReleased === 0 && actMoved === 1,
      `컨테이너 ${J(c2)} 1쪽 ${J(p1b)} · 여백 ${J(hitGrey)} · 놓은 자리 ${J(hitIn)} · 놓은 뒤 active=${actReleased} · 이동 뒤 active=${actMoved}`,
    );
    await park(p);
    await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(0)`);

    // ── 게이트 4 — 활성 페이지 전환 누수 ─────────────────────────────────────
    const HL = { id: "g4-hl", kind: "highlight", pts: [60, 300, 200, 306, 360, 300, 520, 310], strokeWidth: 16, strokes: [solid("#FFE600")] };
    const RECT = { id: "g4-rect", kind: "rect", x: 80, y: 120, w: 240, h: 160, strokeWidth: 2, strokes: [solid("#2563EB")] };
    const n4 = [
      await A(`return await ${S}.setNodes(0, ${J([HL])});`),
      await A(`return await ${S}.setNodes(1, ${J([RECT])});`),
      await A(`return await ${S}.setNodes(2, []);`),
    ];
    await setScale(p, 1);
    await A(`A.scroll(${J(p)}).scrollTop = 0; return true;`);
    await park(p);
    // 워밍업: 세 페이지를 한 바퀴 — 풀·씬 슬롯·정적 오버레이가 한 번씩 만들어진 뒤를 기준으로 삼는다.
    for (const t of [1, 2, 0]) await cdp.eval(`window.__gpv62.h(${J(p)}).annotate.switchPage(${t})`);
    await sleep(POOL_IDLE_MS);
    const heap0 = await heapCanvases(cdp);
    const dom0 = await cdp.eval(`document.querySelectorAll('canvas').length`);

    // 계측 반증: 분리 캔버스 3장(64×64)을 일부러 붙잡는다 — 힙 +3, DOM 0.
    await cdp.eval(
      `window.__gpv62.leak = Array.from({ length: 3 }, () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; return c; }); true`,
    );
    const heapL = await heapCanvases(cdp);
    const domL = await cdp.eval(`document.querySelectorAll('canvas').length`);
    await cdp.eval(`delete window.__gpv62.leak; true`);
    r.check(
      "(4-반증) 힙 계측이 DOM 밖 분리 캔버스를 본다 — 일부러 붙잡은 3장이 개수 +3 · 면적 +3×64² (DOM 개수는 그대로)",
      heapL.count - heap0.count === 3 && heapL.area - heap0.area === 3 * 64 * 64 && domL === dom0,
      `nodes=${J(n4)} heap ${J(heap0)} → ${J(heapL)} dom ${dom0} → ${domL}`,
    );
    // 계측 반증 2: **컨텍스트로만** 붙잡은 3장(layers.ts 풀 Entry·텍스트 스크래치와 같은 모양)을 같은 태스크의 churn 뒤에 잰다.
    await cdp.eval(
      `(() => { window.__gpv62.leakCtx = Array.from({ length: 3 }, () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; return c.getContext('2d'); }); ${CHURN}; return true; })()`,
    );
    const heapC = await heapCanvases(cdp);
    await cdp.eval(`delete window.__gpv62.leakCtx; true`);
    r.check(
      "(4-반증 ctx) 컨텍스트로만 붙잡은 분리 캔버스 3장(신생 세대 churn 뒤)도 개수 +3 · 면적 +3×64² 로 본다 — 레이어 풀·스크래치가 캔버스를 쥐는 모양",
      heapC.count - heap0.count === 3 && heapC.area - heap0.area === 3 * 64 * 64,
      `heap ${J(heap0)} → ${J(heapC)} · 요소 질의만이면 개수 ${heapC.elCount - heap0.elCount >= 0 ? "+" : ""}${heapC.elCount - heap0.elCount}`,
    );
    const heapB = await heapCanvases(cdp);

    // 전환이 **실제로** 일어났는지도 센다 — switchPage 가 아무것도 안 해도 끝 활성은 0 이라 개수·면적 단언은 초록이다.
    // 씬 캔버스 요소가 매번 바뀌고(재마운트) 그 페이지 div 안에 있어야 한다. 요소 참조는 직전 1개만 쥔다.
    const loop = await A(
      `const p = ${J(p)}, h = A.h(p), seq = [1, 0, 2, 0], t0 = performance.now();
       const sceneAny = () => A.root(p).querySelectorAll('[data-pdf-layer] > canvas')[1] || null;
       let prev = sceneAny(), remounts = 0, wrongActive = 0, wrongPage = 0;
       for (let k = 0; k < 100; k++) {
         const want = seq[k % 4];
         h.annotate.switchPage(want);
         const cur = sceneAny();
         if (cur && cur !== prev) remounts++;
         prev = cur;
         if (h.annotate.state().active !== want) wrongActive++;
         if (!A.layer(p, want)) wrongPage++;
         await new Promise((r) => requestAnimationFrame(() => r()));
       }
       prev = null;
       return { ms: Math.round(performance.now() - t0), active: h.annotate.state().active, remounts, wrongActive, wrongPage };`,
      { timeoutMs: 180000 },
    );
    await sleep(POOL_IDLE_MS);
    const heap1 = await heapCanvases(cdp);
    const dom1 = await cdp.eval(`document.querySelectorAll('canvas').length`);
    r.check(
      "(4) 활성 페이지 전환 100회(1,0,2,0 반복 · 레이어 재마운트 100회 확인) 뒤 힙 캔버스 개수 ≤ 전 · 면적 ≤ 전×1.05 (강제 GC · 풀 유휴 해제 뒤 같은 활성 페이지)",
      loop.active === 0 &&
        loop.remounts === 100 &&
        loop.wrongActive === 0 &&
        loop.wrongPage === 0 &&
        heap1.count <= heapB.count &&
        heap1.area <= heapB.area * 1.05,
      `before=${heapB.count}개/${mp(heapB.area)}MP after=${heap1.count}개/${mp(heap1.area)}MP ` +
        `loop=${loop.ms}ms active=${loop.active} remounts=${loop.remounts} wrongActive=${loop.wrongActive} wrongPage=${loop.wrongPage}`,
    );
    r.check("(4) DOM 캔버스 수 불변 — 중복 마운트 없음(보조 지표)", dom1 === dom0, `dom ${dom0} → ${dom1}`);

    // ── LC-4 · M — 400% 컬링과 백킹 크기 ────────────────────────────────────
    await setScale(p, 4);
    await scrollToDoc(p, 0, 40, 250);
    await sleep(300);
    const gM = await A(`return A.geo(${J(p)}, 0);`);
    const cM = await A(`return A.cont(${J(p)});`);
    const p1Top = await A(`return A.pageDiv(${J(p)}, 1).getBoundingClientRect().top;`);
    const off1 = (await A(`return A.statics(${J(p)});`)).filter((q) => q.page === 1);
    const nodes1 = (await ann(p)).nodes[1];
    await scrollToDoc(p, 1, 40, 100);
    await sleep(200);
    const on1 = (await A(`return A.statics(${J(p)});`)).filter((q) => q.page === 1);
    const below = cM ? p1Top - (cM.top + cM.height) : null;
    r.check(
      "(LC-4) 400% 화면(+여백 96css) 밖의 주석 페이지 1 에는 정적 캔버스가 없다 — 스크롤해 보이면 생긴다(반증)",
      nodes1 === 1 && below !== null && below > 96 && off1.length === 0 && on1.length === 1 && on1[0].w > 1 && on1[0].h > 1,
      `페이지 1 노드 ${nodes1} · 컨테이너 아래로 ${below?.toFixed(0)}css · 밖 ${J(off1)} → 보임 ${J(on1)}`,
    );
    if (gM && cM) {
      const d = gM.dpr;
      // 오버레이는 컨테이너의 getBoundingClientRect(스크롤바 포함)로 자른다 — client 폭이 아니라 그 값으로 상한을 잡는다.
      const bound = ((cM.bw + 2 * 96) * d + 2) * ((cM.bh + 2 * 96) * d + 2);
      const layerPx = gM.backW * gM.backH;
      const fullPx = gM.boxW * d * (gM.boxH * d);
      r.info(`M: 활성 백킹 ${gM.backW}×${gM.backH}=${mp(layerPx)}MP · 보이는 영역 상한 ${mp(bound)}MP · 페이지 전체 ${mp(fullPx)}MP · dpr=${d}`);
      r.check(
        "(M) 400% 활성 백킹이 보이는 영역(+여백 96css)으로 잘린다 — 반증: 같은 배율의 페이지 전체 백킹은 그 상한의 2배를 넘는다",
        layerPx <= bound && fullPx > 2 * bound,
        `활성 ${mp(layerPx)}MP ≤ 상한 ${mp(bound)}MP · 전체 ${mp(fullPx)}MP`,
      );
    } else r.check("(M) 400% 활성 레이어 기하", false, `geo=${J(gM)} cont=${J(cM)}`);

    // 편집이 남은 채 닫으면 사이드카 초안이 남는다 — 저장해 깨끗하게 끝낸다(저장 경로는 아래 편집 블록이 따로 잰다).
    await setScale(p, 1);
    const sv = await A(`return await ${S}.save();`, { timeoutMs: 30000 });
    r.check("(게이트) 끝 — gates.pdf 저장으로 편집을 비운다", sv?.ok === true && (await ann(p))?.dirty === false, J(sv));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // 편집 핵심 경로 — edit.pdf
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  async function editBlock() {
    const p = P.edit;
    const S = `A.h(${J(p)}).annotate`;
    const orig = await readPdf(F.edit, [1]);
    const origBlue = blueBox(orig[0].img);
    const origSides = sidesAround(orig[0].img, origBlue);
    if (
      !r.check(
        "(편집) 원본 픽스처 — 3쪽 · 주석 0 · 1쪽 파란 사각형 렌더 bbox = 픽스처 좌표 · 그 둘레 빨강 0변(대조군)",
        orig.length === 3 &&
          orig.every((q) => q.annots.length === 0) &&
          !!origBlue &&
          origBlue.x0 === BLUE.x &&
          origBlue.y0 === BLUE.y &&
          origSides.sides === 0,
        `blue=${J(origBlue)} sides=${J(origSides)}`,
      )
    )
      return;

    await cdp.eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(pid)})`);
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(pid)}, 'viewer')`);
    await setView();
    await open(p);
    const rd = await waitReady(p);
    if (!r.check("(편집) edit.pdf 가 열린다", rd?.status === "ready" && rd.loaded, J(rd))) return;
    const st = await enterAnnotate(p, 3);
    if (!r.check("(편집) [주석] 버튼으로 주석 모드", st?.mode === "annotate", J(st))) return;

    // ── E1 사각형 그리기 → Ctrl+S ──
    await A(`A.scroll(${J(p)}).scrollTop = 0; return true;`);
    await frames();
    const rectBtn = await A(`return A.railBtn(${J(p)}, '사각형 (R)');`);
    if (!r.check("(E1) 레일 '사각형' 버튼", !!rectBtn, J(rectBtn))) return;
    await click(rectBtn);
    const a0 = await at(p, 0, RECT_FROM.x, RECT_FROM.y);
    const a1 = await at(p, 0, RECT_TO.x, RECT_TO.y);
    const cE = await A(`return A.cont(${J(p)});`);
    const inside = (q) => q.x > cE.left && q.y > cE.top && q.x < cE.left + cE.width && q.y < cE.top + cE.height;
    if (!r.check("(E1) 그릴 자리가 보이는 영역 안", inside(a0) && inside(a1), `${J(a0)} ${J(a1)} cont=${J(cE)}`)) return;
    await drag(a0, a1);
    await frames();
    const drawn = await A(`return ${S}.getNodes(0);`);
    const rect0 = drawn.length === 1 && drawn[0].kind === "rect" ? drawn[0] : null;
    r.check(
      "(E1) 사각형 도구 실제 드래그 (112,272)→(192,352) — 1쪽에 rect 노드 1개 · x·y·w·h ±0.05pt",
      !!rect0 &&
        Math.abs(rect0.x - RECT_FROM.x) <= 0.05 &&
        Math.abs(rect0.y - RECT_FROM.y) <= 0.05 &&
        Math.abs(rect0.w - (RECT_TO.x - RECT_FROM.x)) <= 0.05 &&
        Math.abs(rect0.h - (RECT_TO.y - RECT_FROM.y)) <= 0.05,
      J(drawn.map((n) => ({ kind: n.kind, x: n.x, y: n.y, w: n.w, h: n.h }))),
    );
    if (!rect0) return;
    const sv1 = await saveByKey(p);
    const s1 = await ann(p);
    const b1 = await readPdf(disk(p), [1]);
    const side1 = sidesAround(b1[0].img, blueBox(b1[0].img));
    r.check(
      "(E1) Ctrl+S(실제 키) 저장 — dirty 해제 · 저장본 1쪽 Square 1개(다른 쪽 0) · 렌더에서 빨간 테두리가 파란 사각형 네 변을 둘러싸고 안쪽 틈은 비었다 · 대조(원본 0변) 유효",
      sv1?.ok === true &&
        s1.dirty === false &&
        b1[0].annots.filter((a) => a.subtype === "Square").length === 1 &&
        b1.slice(1).every((q) => q.annots.length === 0) &&
        side1.sides === 4 &&
        side1.gapClean &&
        origSides.sides === 0,
      `save=${J(sv1)} dirty=${s1.dirty} annots=${J(b1.map((q) => q.annots.map((a) => a.subtype)))} sides=${J(side1)}`,
    );

    // ── E2 다시 열기 → 같은 노드 · 재편집(→ 1pt) → 저장 ──
    const ro1 = await reopen(p);
    const st2 = ro1.ok ? await enterAnnotate(p, 3) : null;
    const re = st2 ? await A(`return ${S}.getNodes(0);`) : [];
    const rect1 = re.length === 1 && re[0].kind === "rect" ? re[0] : null;
    r.check(
      "(E2) 탭을 닫고 다시 열기(새 인스턴스) → 주석 모드에서 같은 id·같은 좌표(±0.01pt)의 편집 가능한 rect 노드 1개",
      ro1.ok &&
        st2?.mode === "annotate" &&
        J(st2.nodes) === J([1, 0, 0]) &&
        !!rect1 &&
        rect1.id === rect0.id &&
        ["x", "y", "w", "h"].every((k) => Math.abs(rect1[k] - rect0[k]) <= 0.01),
      `reopen=${J(ro1)} nodes=${J(st2?.nodes)} 전 ${J({ id: rect0.id, x: rect0.x, y: rect0.y, w: rect0.w, h: rect0.h })} 후 ${J(rect1 && { id: rect1.id, x: rect1.x, y: rect1.y, w: rect1.w, h: rect1.h })}`,
    );
    if (!rect1) return;
    // 선택 도구로 왼쪽 변을 눌러 고르고 → 키로 1pt. 선택이 안 됐으면 nudge 가 아무 일도 안 해 x 가 그대로다.
    await A(`A.scroll(${J(p)}).scrollTop = 0; return true;`);
    await frames();
    await click(await A(`return A.railBtn(${J(p)}, '선택 (V)');`));
    await click(await at(p, 0, RECT_FROM.x, (RECT_FROM.y + RECT_TO.y) / 2));
    await frames();
    await press("ArrowRight");
    await frames();
    const moved = (await A(`return ${S}.getNodes(0);`))[0];
    const sv2 = await saveByKey(p);
    const b2 = await readPdf(disk(p), [1]);
    const sq1 = b1[0].annots.find((a) => a.subtype === "Square");
    const sq2s = b2[0].annots.filter((a) => a.subtype === "Square");
    const dxPdf = sq1 && sq2s.length === 1 ? sq2s[0].rect[0] - sq1.rect[0] : null;
    r.check(
      "(E2) 재편집 — 선택 + → 키로 x +1pt · 저장본 Square 여전히 1개(재편집이 기존 주석을 바꿨지 새로 더하지 않았다) · /Rect 가 +1pt 이동 · y 불변",
      !!moved &&
        moved.id === rect1.id &&
        Math.abs(moved.x - (rect1.x + 1)) <= 0.01 &&
        Math.abs(moved.y - rect1.y) <= 0.01 &&
        sv2?.ok === true &&
        sq2s.length === 1 &&
        dxPdf !== null &&
        Math.abs(dxPdf - 1) <= 0.01 &&
        Math.abs(sq2s[0].rect[1] - sq1.rect[1]) <= 0.01,
      `노드 x ${rect1.x}→${moved?.x} · save=${J(sv2)} · Square ${sq2s.length}개 rect ${J(sq1?.rect)} → ${J(sq2s.map((a) => a.rect))}`,
    );

    // ── E3 형광펜 마크업 — 글자를 실제로 끌어 선택 ──
    await click(await A(`return A.btn(${J(p)}, '[data-pdf-markup-tool="Highlight"]');`));
    await frames();
    const sp = await A(`return A.span(${J(p)}, 0, 'Alpha');`);
    if (!r.check("(E3) 1쪽 텍스트 레이어에 'Alpha Bravo Charlie' 스팬", !!sp, J(sp))) return;
    const my = (sp.top + sp.bottom) / 2;
    await drag({ x: sp.left + 1, y: my }, { x: sp.right - 1, y: my }, 8);
    await frames();
    await sleep(100);
    const s3 = await ann(p);
    const mk3 = await A(`return A.markups(${J(p)});`);
    const sv3 = await saveByKey(p);
    const b3 = await readPdf(disk(p), [1]);
    const hl = b3[0].annots.filter((a) => a.subtype === "Highlight");
    const color = mk3[0]?.fill ?? "#FFD54F";
    const share = hl.length === 1 && hl[0].quads ? colorShare(b3[0].img, hl[0].quads, color) : null;
    const share0 = hl.length === 1 && hl[0].quads ? colorShare(orig[0].img, hl[0].quads, color) : null;
    const qx = hl[0]?.quads?.filter((_, i) => i % 2 === 0) ?? [];
    const qy = hl[0]?.quads?.filter((_, i) => i % 2 === 1) ?? [];
    // 글자 줄 = x 72.. · 기준선 PDF y 700(24pt). quad 가 그 줄을 덮어야 한다.
    const coversLine = qx.length > 0 && Math.min(...qx) <= 74 && Math.max(...qx) >= 200 && Math.min(...qy) <= 702 && Math.max(...qy) >= 712;
    r.check(
      "(E3) 형광펜 도구로 글자를 끌어 선택 → 마크업 1 · Ctrl+S → 저장본 1쪽 Highlight 1개(quad 가 글자 줄을 덮음) · 그 영역 렌더의 마크업 색 비율 ≥ 30%(대조: 원본 0%) · Square 그대로 1",
      s3.markups === 1 &&
        mk3.length === 1 &&
        sv3?.ok === true &&
        hl.length === 1 &&
        coversLine &&
        !!share &&
        share.share >= 0.3 &&
        share0?.share === 0 &&
        b3[0].annots.filter((a) => a.subtype === "Square").length === 1,
      `markups=${s3.markups} dom=${J(mk3.map((m) => m.subtype))} save=${J(sv3)} hl=${J(hl.map((a) => a.quads?.map((v) => Math.round(v))))} share=${J(share)} 원본=${J(share0)}`,
    );

    // ── E4 선택 도구로 마크업 클릭 → Delete ──
    await click(await A(`return A.railBtn(${J(p)}, '선택 (V)');`)); // 레일을 누르면 마크업 도구도 꺼진다
    await frames();
    const mkPt = (await A(`return A.markups(${J(p)});`))[0];
    if (mkPt) await click(mkPt);
    await sleep(50); // 마크업 hit-test 는 pointerup 뒤 setTimeout(0) 에서 돈다
    await frames();
    const selBefore = await A(`return A.markups(${J(p)});`);
    await press("Delete");
    await frames();
    const s4 = await ann(p);
    const mk4 = await A(`return A.markups(${J(p)});`);
    const sv4 = await saveByKey(p);
    const b4 = await readPdf(disk(p));
    r.check(
      "(E4) 선택 도구로 마크업을 클릭하면 선택 표시가 뜨고 Delete 로 지워진다 → 저장본 Highlight 0 · Square 그대로 1(노드는 안 지워짐)",
      selBefore.length === 1 &&
        selBefore[0].selected &&
        s4.markups === 0 &&
        mk4.length === 0 &&
        s4.nodes[0] === 1 &&
        sv4?.ok === true &&
        b4[0].annots.filter((a) => a.subtype === "Highlight").length === 0 &&
        b4[0].annots.filter((a) => a.subtype === "Square").length === 1,
      `클릭 뒤 ${J(selBefore.map((m) => ({ sel: m.selected })))} · 뒤 markups=${s4.markups} dom=${mk4.length} nodes=${J(s4.nodes)} · save=${J(sv4)} · annots=${J(b4[0].annots.map((a) => a.subtype))}`,
    );

    // ── E5 페이지 모드 — 1쪽 오른쪽 회전 + 복제 → Ctrl+S → 다시 열기 ──
    const nodeBefore = (await A(`return ${S}.getNodes(0);`))[0];
    const cx0 = nodeBefore.x + nodeBefore.w / 2;
    const cy0 = nodeBefore.y + nodeBefore.h / 2;
    await click(await A(`return A.btn(${J(p)}, '[data-pdf-mode="pages"]');`));
    const grid = await poll(() => A(`return A.thumbs(${J(p)});`), (v) => Array.isArray(v) && v.length === 3, 60, 250);
    if (!r.check("(E5) 페이지 모드 그리드 — 썸네일 3", grid?.length === 3, J(grid))) return;
    await click(grid[0]);
    await frames();
    await click(await A(`return A.btn(${J(p)}, '[data-pdf-pages-op="rotate-right"]');`));
    await frames();
    await click(await A(`return A.btn(${J(p)}, '[data-pdf-pages-op="duplicate"]');`));
    await frames();
    const s5a = await ann(p);
    const sv5 = await saveByKey(p);
    // 페이지 연산을 쓴 판은 저장 뒤 디스크에서 다시 가져온다(reloadAfterPageOps) — 그 끝을 기다린다.
    const s5 = await poll(() => ann(p), (s) => s?.pageKeys?.length === 4 && s.pageOps === 0 && s.dirty === false, 80, 250);
    const b5 = await readPdf(disk(p), [1, 2, 3]);
    const rots = b5.map((q) => q.rotate);
    const squares = b5.map((q) => q.annots.filter((a) => a.subtype === "Square").length);
    const sideP = [0, 1, 2].map((i) => sidesAround(b5[i].img, blueBox(b5[i].img)));
    const blueR = blueBox(b5[0].img);
    // 1쪽 파란 사각형 중심 (152,312) 의 시계 방향 90° = (842 − 312, 152) — 렌더가 회전 규약을 확인한다.
    const blueRotOk = !!blueR && Math.abs(blueR.cx - (H - (BLUE.y + BLUE.h / 2))) <= 1 && Math.abs(blueR.cy - (BLUE.x + BLUE.w / 2)) <= 1;
    r.check(
      "(E5) 1쪽 오른쪽 회전 + 복제(실제 클릭) → Ctrl+S → 저장본 4쪽 · /Rotate [90,90,0,0] · Square [1,1,0,0] · 회전된 두 쪽에서 테두리가 파란 사각형 네 변을 그대로 둘러싼다(대조: 사각형 없는 3쪽은 0변)",
      s5a.pageOps === 2 &&
        sv5?.ok === true &&
        !!s5 &&
        b5.length === 4 &&
        J(rots) === J([90, 90, 0, 0]) &&
        J(squares) === J([1, 1, 0, 0]) &&
        blueRotOk &&
        sideP[0].sides === 4 &&
        sideP[0].gapClean &&
        sideP[1].sides === 4 &&
        sideP[1].gapClean &&
        sideP[2].sides === 0,
      `ops=${s5a.pageOps} save=${J(sv5)} 재로드=${J(s5 && { keys: s5.pageKeys.length, nodes: s5.nodes })} · rotate=${J(rots)} squares=${J(squares)} · 회전 bbox=${J(blueR)} · sides=${J(sideP)}`,
    );

    const ro2 = await reopen(p);
    const st6 = ro2.ok ? await enterAnnotate(p, 4) : null;
    const n0 = st6 ? (await A(`return ${S}.getNodes(0);`))[0] : null;
    const n1 = st6 ? (await A(`return ${S}.getNodes(1);`))[0] : null;
    // 쪽 방향 — 뷰어의 pdf.js 페이지 div 가 가로(회전 90)인가. 회전이 두 번 들어가 180 이 되면 세로로 돌아와 여기서 걸린다.
    const land = st6
      ? await A(`return [0, 1, 2, 3].map((i) => { const q = A.pageDiv(${J(p)}, i).getBoundingClientRect(); return q.width > q.height; });`)
      : null;
    const want = { cx: H - cy0, cy: cx0 };
    const ctr = (n) => n && { cx: n.x + n.w / 2, cy: n.y + n.h / 2 };
    const okCtr = (n) => !!n && Math.abs(ctr(n).cx - want.cx) <= 0.05 && Math.abs(ctr(n).cy - want.cy) <= 0.05;
    r.check(
      "(E5) 다시 열기 → 노드 [1,1,0,0] · 1·2쪽만 가로 · 회전된 1·2쪽 노드 중심 = 원래 중심의 시계 방향 90°(842 − cy, cx) ±0.05pt · 복제 쪽 노드는 다른 id",
      ro2.ok && !!st6 && J(st6.nodes) === J([1, 1, 0, 0]) && J(land) === J([true, true, false, false]) && okCtr(n0) && okCtr(n1) && n0.id !== n1.id,
      `reopen=${J(ro2)} nodes=${J(st6?.nodes)} 가로=${J(land)} 기대 중심 ${J(want)} · 0쪽 ${J(ctr(n0))} · 1쪽 ${J(ctr(n1))} ids ${n0?.id?.slice(0, 8)}/${n1?.id?.slice(0, 8)}`,
    );
  }
}
