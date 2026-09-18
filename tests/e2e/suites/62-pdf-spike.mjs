// PDF 주석 스파이크(S1) 게이트 — DOCS/pdf-viewer-editor-design.md §8.2.
//
// pdf.js 없이 가짜 A4 3장 하니스(src/components/pdf/PdfAnnotateSpike.tsx)를 `__gpv.pdfSpike` 로 구동해
// 오버레이의 성질만 잰다:
//   A4  레일이 PDF 도구 9종을 정확히 그 순서로 보인다(플라이아웃 전용 형광펜 포함, 캐럿 0).
//   1a  display 백킹 = css × dpr(±1) · image-rendering auto          (page · viewport 전략)
//   1b  400% 에서 1pt 사선이 계단 없이 그려진다 — 스크린샷의 행별 첫 잉크 x 연속 길이
//   1c  같은 사선이 번지지 않는다 — 열별 세로 단면의 부분 피복 픽셀 수(흐림·반 px 재샘플)
//   P   viewport 계약(400%) — VP-1 원점을 옮긴 스크롤의 커밋 직후(rAF 전) 박스·픽셀이 같은 원점 ·
//       V2a 원점만 옮긴 스크롤 뒤 커밋 캐시 · VP-2 줌 도중 viewport 고정 · V2c 커서 픽셀 오프셋 ·
//       VP-3 실제 포인터 드래그가 viewport·page 전략에서 같은 문서 좌표
//   T   전환과 텍스트 — LC-3 편집 중 전환 시 옛 페이지에 확정 · LC-2 hover 가드에 막힌 페이지의 누름·이동
//   4   활성 페이지 전환 100회 뒤 힙의 캔버스 개수·면적이 늘지 않는다(강제 GC 후 queryObjects)
//   M   400% 에서 page vs viewport 전략의 캔버스 면적(메모리 질문) · LC-4 화면 밖 정적 오버레이 컬링
//
// **헛단언 방지** — 각 게이트는 "기능이 완전히 고장 나 있으면 빨개지는가"를 반증으로 함께 잰다:
//   1a → image 전략(1pt = 1 백킹 px)에서는 같은 식이 **실패해야** 한다.
//   1b → image 전략의 계단(연속 ≥6)이 안 나오면 지표가 흐림을 못 보는 것이라 1b 전체를 실패시킨다.
//        잉크 행 수·위치도 함께 본다 — 빈 캡처는 연속 0 으로 "통과"해 버린다.
//   1c → 쌍선형 흐림(image + auto)·반 디바이스 px 원점(page + translate)이 둘 다 **실패해야** 한다.
//   VP-1 → 스크롤 직전 비트맵(옛 원점)으로 같은 판정을 하면 **실패해야** 한다.
//   VP-3·V2c → viewport 원점 ≥5pt 를 전제로 둔다 — 원점을 빠뜨리면 허용오차(0.5pt)를 크게 벗어난다.
//   LC-3 → ① 확정을 건너뛴 raw 전환에서는 텍스트가 **사라져야** 한다(blur 가 대신 확정하지 않는다).
//   4  → 분리된 캔버스 3장을 일부러 만들어 계측이 +3 을 보는지 먼저 확인한다(DOM 개수로는 0 이다).
//        요소로 붙잡은 3장과 **컨텍스트로만** 붙잡은 3장(레이어 풀·스크래치의 모양) 둘 다.
//
// 포인터는 CDP Input.dispatchMouseEvent(실제 히트 테스트·포인터 캡처·mousedown 기본 동작)로 쏜다.
// 좌표는 페이지 div 기준 docToClient 라 레이어의 clientToDoc 과 독립이다.
//
// 창 리로드가 끼면 `__gpv.pdfSpike` 가 main.tsx 의 open 전용 자리로 되돌아가 호출이 예외로 죽는다 —
// 그 실행은 무효다. 마지막에 performance.timeOrigin 불변도 단언한다.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const name =
  "PDF 주석 스파이크 S1 (A4 레일 · 게이트1 선명도 · viewport 계약 · 전환과 텍스트 · 게이트4 전환 누수 · 백킹 메모리)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const S = "window.__gpv.pdfSpike";
/** 스크린샷 크롭 저장 위치(스파이크 전용). GPV_E2E_SHOTS 로 바꿀 수 있다. */
const SHOTS =
  process.env.GPV_E2E_SHOTS ||
  join(tmpdir(), "claude/F--gitpervisor/d6ad5c3a-9aa6-4ea4-9c95-efdffc2ce748/scratchpad/s1-shots");
/** layers.ts IDLE_MS(5000) + 여유 — 풀의 노는 캔버스가 버려진 **같은 상태**에서 전후를 잰다. */
const POOL_IDLE_MS = 5600;
const GROUP = "gpv62-heap";
/** 신생 세대 churn(작은 탈출 객체 → 스캐빈지) — 수정되지 않은 캔버스 래퍼가 버려지는 조건을 만든다. */
const CHURN = `{ const ring = new Array(4096); for (let i = 0; i < 4e6; i++) { ring[i & 4095] = { a: i, b: [i, i + 1], s: 'x' + i }; } }`;

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
];

const HELPERS = `(() => {
  const A = {};
  window.__gpv62 = A;

  A.railTitles = () => {
    const root = document.querySelector('[data-pdf-spike]');
    const bar = root && root.querySelector('[role="toolbar"][aria-label="도구"]');
    if (!bar) return null;
    return Array.from(bar.querySelectorAll('button')).map((b) => ({
      title: b.title,
      caret: /▾/.test(b.textContent || ''),
    }));
  };

  /**
   * PNG → 행마다 첫 빨강 잉크 x. 빨강 = r − g > 64 (흰 바탕 위 부분 피복 25% 이상).
   * 회색 가짜 본문·파랑 크롬은 r ≈ g 거나 r < g 라 걸리지 않는다.
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
      for (let px = 0; px < c.width; px++) {
        const o = (y * c.width + px) * 4;
        if (d[o] - d[o + 1] > 64 && d[o] > 150) { fx = px; break; }
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
    // 선명한 1pt(400%·dpr1.5 = 8 디바이스 px) 사선은 가장자리마다 부분 1px 라 ≈2, 흐림·반 px
    // 재샘플은 가장자리가 번져 늘어난다. 계단 지표(maxRun)는 이 둘에서 1 이라 못 본다.
    const parts = [], fulls = [];
    for (let px = Math.floor(w * 0.25); px < Math.floor(w * 0.75); px += 3) {
      let p = 0, f = 0, m = 0;
      for (let y = 0; y < h; y++) {
        const o = (y * w + px) * 4;
        const a = Math.max(0, Math.min(1, (d[o] - d[o + 1]) / 255));
        if (a >= 0.9) f++;
        else if (a > 0.1) p++;
        m += a;
      }
      if (m > 0.5) { parts.push(p); fulls.push(f); }
    }
    const med = (v) => { const s = [...v].sort((u, t) => u - t); return s.length ? s[s.length >> 1] : null; };
    const xsec = { cols: parts.length, medPartial: med(parts), medFull: med(fulls) };
    // 가운데 절반 행만 본다 — 둥근 끝(캡) 근처에서는 가장 왼쪽 잉크가 사선 변이 아니라 캡 곡선이라
    // 원래부터 같은 x 가 몇 행 이어진다(흐림과 무관).
    const a = Math.floor(rows.length * 0.25);
    const b = Math.ceil(rows.length * 0.75);
    let run = 0, maxRun = 0, prev = null;
    for (let k = a; k < b; k++) {
      const cur = rows[k];
      run = prev && prev[0] === cur[0] - 1 && prev[1] === cur[1] ? run + 1 : 1;
      if (run > maxRun) maxRun = run;
      prev = cur;
    }
    return {
      w, h, inkRows: rows.length, used: Math.max(0, b - a), maxRun, xsec,
      minX: rows.length ? minX : null, minY, maxY,
      sample: rows.slice(a, a + 10).map((q) => q[1]),
    };
  };
  return true;
})()`;

async function send(cdp, method, params) {
  const res = await cdp._send(method, params);
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
}

/**
 * 힙에 살아 있는 캔버스 전부의 [개수, Σ width×height] — **강제 GC 뒤**.
 * DOM querySelectorAll 로는 레이어 풀·효과 스크래치 같은 분리 캔버스가 정의상 안 보인다.
 *
 * HTMLCanvasElement 질의만으로도 모자란다: **컨텍스트로만** 붙잡힌 캔버스(layers.ts 풀 Entry 의 ctx ·
 * text-layout 스크래치)는 수정되지 않은 JS 래퍼가 스캐빈지에서 버려져 C++ 캔버스만 살아남는다 —
 * 요소 질의에 안 잡힌다(실측: 3장을 ctx 로 쥐고 churn 뒤 요소 질의 +0, 합집합 +3). 그래서
 * CanvasRenderingContext2D 도 질의해 `ctx.canvas` 와 합집합으로 센다.
 * HeapProfiler.enable 없이 collectGarbage 가 된다(이 앱에서 실측, 2026-09-14).
 * @returns elCount·elArea — 요소 질의만의 값(옛 계측과 비교하는 info 용)
 */
async function heapCanvases(cdp) {
  await send(cdp, "HeapProfiler.collectGarbage");
  const protoEl = await send(cdp, "Runtime.evaluate", {
    expression: "HTMLCanvasElement.prototype",
    objectGroup: GROUP,
  });
  const protoCtx = await send(cdp, "Runtime.evaluate", {
    expression: "CanvasRenderingContext2D.prototype",
    objectGroup: GROUP,
  });
  try {
    const qe = await send(cdp, "Runtime.queryObjects", {
      prototypeObjectId: protoEl.result.objectId,
      objectGroup: GROUP,
    });
    const qc = await send(cdp, "Runtime.queryObjects", {
      prototypeObjectId: protoCtx.result.objectId,
      objectGroup: GROUP,
    });
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

const mp = (px) => (px / 1e6).toFixed(1);

export async function run({ cdp, report: r }) {
  const has = await cdp
    .eval(`typeof window.__gpv?.pdfSpike?.open === 'function'`)
    .catch(() => false);
  if (!has) {
    r.skip("PDF 스파이크 하니스", "window.__gpv.pdfSpike 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  /** 문서 사각형(페이지 0, pt)을 디바이스 px 에 붙인 클립으로 캡처해 PNG 를 남긴다. */
  const capture = async (file, [x0, y0, x1, y1]) => {
    const clip = await cdp.eval(`(() => {
      const s = ${S}, d = devicePixelRatio;
      const a = s.docToClient(0, ${x0}, ${y0}), b = s.docToClient(0, ${x1}, ${y1});
      if (!a || !b) return null;
      const q = (v) => Math.round(v * d) / d;
      return { x: q(a.x) + scrollX, y: q(a.y) + scrollY, width: q(b.x) - q(a.x), height: q(b.y) - q(a.y), scale: 1 };
    })()`);
    if (!clip) return { ok: false, why: "docToClient null" };
    const res = await cdp._send("Page.captureScreenshot", {
      format: "png",
      clip,
      captureBeyondViewport: false,
    });
    if (res.error || !res.result?.data) {
      return { ok: false, why: res.error?.message || "data 없음", clip };
    }
    try {
      mkdirSync(SHOTS, { recursive: true });
      writeFileSync(join(SHOTS, `62-${file}.png`), Buffer.from(res.result.data, "base64"));
    } catch (e) {
      r.info(`스크린샷 저장 실패(${file}): ${e.message}`);
    }
    return { ok: true, data: res.result.data, clip };
  };

  /** 페이지 문서 좌표 → client 좌표(페이지 div 기준 — 레이어의 clientToDoc 과 독립). */
  const at = async (page, x, y) => {
    const p = await cdp.eval(`${S}.docToClient(${page}, ${x}, ${y})`);
    if (!p) throw new Error(`docToClient(${page}, ${x}, ${y}) null`);
    return p;
  };
  /** 실제 입력 경로의 마우스 이벤트 하나. buttons 는 누른 채 이동·누름이면 1. */
  const mouse = (type, p, buttons = 0) =>
    send(cdp, "Input.dispatchMouseEvent", {
      type,
      x: p.x,
      y: p.y,
      button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
      buttons,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const drag = async (a, b, steps = 4) => {
    await mouse("mouseMoved", a);
    await mouse("mousePressed", a, 1);
    for (let k = 1; k <= steps; k++) {
      await mouse("mouseMoved", { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps }, 1);
    }
    await mouse("mouseReleased", b, 0);
  };
  const frames = () => cdp.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
  const active = async () => (await cdp.eval(`${S}.stats()`)).active;

  const origin0 = await cdp.eval(`performance.timeOrigin`);
  try {
    const st0 = await cdp.eval(`${S}.open({ strategy: 'page', zoom: 1, hoverSwitch: false })`);
    if (
      !r.check(
        "하니스 열림 — 활성 레이어의 씬 캔버스가 있다",
        !!st0?.layer && st0.layer.backW > 0,
        `layer=${J(st0?.layer ?? null)} dpr=${st0?.dpr}`,
      )
    ) {
      return;
    }
    if (!r.check("페이지 헬퍼 설치", (await cdp.eval(HELPERS)) === true)) return;

    // ── A4 레일 ─────────────────────────────────────────────────────────────
    // tools 가 무시되면 이미지 편집기 레일 20여 개가 그대로 나오고 형광펜은 없다 → 빨강.
    const rail = await cdp.eval(`window.__gpv62.railTitles()`);
    const tools = rail ? rail.filter((b) => b.title !== "선 색 · 채우기 색") : null;
    r.check(
      "(A4) 레일 = PDF 도구 9종 · 이 순서 · 플라이아웃 캐럿 0 (형광펜은 플라이아웃 전용인데도 레일에 올라온다)",
      !!tools && J(tools.map((b) => b.title)) === J(RAIL_EXPECT) && tools.every((b) => !b.caret),
      J(tools?.map((b) => b.title + (b.caret ? "▾" : "")) ?? null),
    );

    // ── 게이트 1 — 400% 선명도 ───────────────────────────────────────────────
    const LINE = {
      id: "g1-line",
      kind: "line",
      x1: 100,
      y1: 100,
      x2: 300,
      y2: 160,
      strokeWidth: 1,
      strokes: [solid("#FF0000")],
    };
    const TEXT = {
      id: "g1-text",
      kind: "text",
      x: 100,
      y: 180, // 400% 에서 선 클립과 함께 스크롤 영역(1440×900 창 기준) 안에 들어오는 자리
      w: 300,
      h: 24,
      text: "선명도 Sharpness 가나다 0123",
      fontSize: 14,
      fills: [solid("#000000")],
    };
    const n1 = await cdp.eval(`${S}.setNodes(0, ${J([LINE, TEXT])})`);
    r.check("(1) 노드 주입 — 1pt 사선 1 · 텍스트 1 이 스키마 정규화를 통과", n1 === 2, `nodes=${n1}`);

    const g1 = {};
    // image 를 먼저 — 반증이 무효면 뒤의 1b 판정도 무효로 처리한다.
    for (const s of ["image", "page", "viewport"]) {
      await cdp.eval(`${S}.setStrategy(${J(s)})`);
      await cdp.eval(`${S}.setZoom(4)`);
      await cdp.eval(`${S}.scrollToDoc(0, 90, 90)`);
      await sleep(250); // 32MP 페인트·합성 여유
      const st = await cdp.eval(`${S}.stats()`);
      const line = await capture(`line-${s}-z4`, [95, 95, 305, 165]);
      await capture(`text-${s}-z4`, [95, 172, 330, 208]); // 눈으로 보는 용도 — 단언 없음
      const ink = line.ok ? await cdp.eval(`window.__gpv62.firstInk(${J(line.data)})`) : null;
      const c = st.container;
      const inView =
        line.ok &&
        !!c &&
        line.clip.x >= c.left &&
        line.clip.y >= c.top &&
        line.clip.x + line.clip.width <= c.left + c.width &&
        line.clip.y + line.clip.height <= c.top + c.height;
      g1[s] = { st, ink, inView, why: line.ok ? "" : line.why };
      r.info(
        `1 ${s}: zoom=${st.zoom}/${st.settled} dpr=${st.dpr} layer=${J(st.layer)} viewport=${J(st.geo.viewport)} ` +
          `ink=${J(ink)} clip=${J(line.clip ?? null)} inView=${inView} ${g1[s].why}`,
      );
    }

    const num = (s) => {
      const { st } = g1[s];
      const L = st.layer;
      if (!L) return null;
      return {
        dW: Math.abs(L.backW - L.cssW * st.dpr),
        dH: Math.abs(L.backH - L.cssH * st.dpr),
        ir: L.imageRendering,
        settled: st.zoom === 4 && st.settled === 4,
      };
    };
    const pass1a = (m) => !!m && m.settled && m.dW < 1 && m.dH < 1 && m.ir === "auto";
    for (const s of ["page", "viewport"]) {
      const m = num(s);
      r.check(
        `(1a) ${s}: 400% settle 뒤 |backW − cssW·dpr| < 1 · |backH − cssH·dpr| < 1 · image-rendering auto`,
        pass1a(m),
        m ? `dW=${m.dW.toFixed(3)} dH=${m.dH.toFixed(3)} rendering=${m.ir} layer=${J(g1[s].st.layer)}` : "레이어 없음",
      );
    }
    const mi = num("image");
    r.check(
      "(1a-반증) image 전략(1pt = 1 백킹 px)에서는 같은 식이 실패한다 — 이 식이 흐린 백킹을 구별한다는 증거",
      !!mi && mi.settled && !pass1a(mi),
      mi ? `dW=${mi.dW.toFixed(1)} dH=${mi.dH.toFixed(1)} rendering=${mi.ir}` : "레이어 없음",
    );

    const ki = g1.image.ink;
    const counterOk = !!ki && ki.inkRows > 0 && ki.maxRun >= 6 && g1.image.inView;
    r.check(
      "(1b-반증) image 전략은 1pt 사선의 첫 잉크 x 가 ≥6행 연속 같다(계단) — 안 나오면 지표가 흐림을 못 보는 것이라 1b 는 무효",
      counterOk,
      ki ? `maxRun=${ki.maxRun} inkRows=${ki.inkRows} sample=${J(ki.sample)} inView=${g1.image.inView}` : `캡처 실패 ${g1.image.why}`,
    );
    for (const s of ["page", "viewport"]) {
      const { st, ink: k, inView } = g1[s];
      // 디바이스 px / pt. 선 (100,100)→(300,160), 두께 1pt 둥근 끝 → 잉크 세로 폭 ≈ 61pt,
      // 클립 원점 (95,95) 기준 잉크 좌상단 ≈ (4.5pt, 4.5pt). viewport 원점 이동이 틀리면 여기서 어긋난다.
      const ppd = st.geo.displayScale * st.dpr;
      const rowsOk = !!k && k.inkRows >= 0.9 * 61 * ppd && k.inkRows <= 1.1 * 61 * ppd;
      const posOk =
        !!k && k.minX !== null && Math.abs(k.minX - 4.5 * ppd) <= ppd + 2 && Math.abs(k.minY - 4.5 * ppd) <= ppd + 2;
      r.check(
        `(1b) ${s}: 400% 1pt 사선의 첫 잉크 x 최대 연속 ≤ 3 · 잉크 행 수·위치가 문서 좌표와 일치 · 반증 유효`,
        counterOk && !!k && k.maxRun <= 3 && rowsOk && posOk && inView,
        k
          ? `maxRun=${k.maxRun} (image ${ki?.maxRun ?? "-"}) inkRows=${k.inkRows}/${Math.round(61 * ppd)} ` +
              `min=(${k.minX},${k.minY}) 기대≈(${(4.5 * ppd).toFixed(1)}) img=${k.w}×${k.h} inView=${inView}`
          : `캡처 실패 ${g1[s].why}`,
      );
    }
    // ── 1c — 단면 선명도: 쌍선형 흐림 · 서브픽셀 재샘플 ─────────────────────────
    // 1b 계단 지표는 저해상 백킹 + auto(쌍선형)와 반 디바이스 px 원점(합성기 재샘플)에서 둘 다
    // maxRun=1 로 통과한다(검증 실측 2026-09-14). 뒤쪽이 s1-critic 의 "수치는 맞는데 화면이 흐린"
    // 위험 그대로라 열별 단면으로 따로 잰다. 반증 둘은 **런타임 스타일만** 바꿔 만든다 —
    // 파일 저장은 창을 리로드해 이 실행을 무효로 만든다.
    const layerSel = `document.querySelector('[data-pdf-spike] [data-pdf-layer]')`;
    const xsecProbe = async (label, strategy, tweak) => {
      await cdp.eval(`${S}.setStrategy(${J(strategy)})`);
      await cdp.eval(`${S}.setZoom(4)`);
      await cdp.eval(`${S}.scrollToDoc(0, 90, 90)`);
      await cdp.eval(`(() => { ${tweak}; return true; })()`);
      await sleep(250);
      const shot = await capture(`line-${label}-z4`, [95, 95, 305, 165]);
      return shot.ok ? await cdp.eval(`window.__gpv62.firstInk(${J(shot.data)})`) : null;
    };
    let bil = null;
    let sub = null;
    try {
      // React 는 prop 이 바뀔 때만 style 을 다시 쓴다 — 전략을 page 로 돌리면 auto 로 덮여 원상복구된다.
      bil = await xsecProbe("image-bilinear", "image", `${layerSel}.querySelectorAll(':scope > canvas')[1].style.imageRendering = 'auto'`);
      sub = await xsecProbe(
        "page-halfpx",
        "page",
        `${layerSel}.style.transform = 'translate(' + (0.5 / devicePixelRatio) + 'px, ' + (0.5 / devicePixelRatio) + 'px)'`,
      );
    } finally {
      await cdp.eval(`(() => { const l = ${layerSel}; if (l) l.style.transform = ''; return true; })()`).catch(() => {});
    }
    const sharp = (x) => !!x && x.cols >= 100 && x.medPartial !== null && x.medPartial <= 3 && x.medFull >= 1;
    const cp1c =
      !!bil?.xsec && !!sub?.xsec && bil.xsec.cols >= 100 && sub.xsec.cols >= 100 && !sharp(bil.xsec) && !sharp(sub.xsec);
    r.check(
      "(1c-반증) 단면 지표가 쌍선형 흐림(image + auto)과 반 디바이스 px 원점 재샘플(page + translate)을 둘 다 흐림으로 판정한다 — 1b 계단 지표는 둘 다 놓친다",
      cp1c,
      `bilinear=${J(bil?.xsec ?? null)} maxRun=${bil?.maxRun} · halfpx=${J(sub?.xsec ?? null)} maxRun=${sub?.maxRun}`,
    );
    for (const s of ["page", "viewport"]) {
      const x = g1[s].ink?.xsec ?? null;
      r.check(
        `(1c) ${s}: 400% 1pt 사선의 열별 단면 — 부분 피복 픽셀 중앙값 ≤ 3 · 완전 피복 중앙값 ≥ 1 · 반증 유효`,
        cp1c && sharp(x),
        `${J(x)} (image ${J(g1.image.ink?.xsec ?? null)})`,
      );
    }
    r.info(`1b·1c 크롭 PNG: ${SHOTS}`);

    // ── P — viewport 계약(400%) ─────────────────────────────────────────────
    // 게이트 1 은 viewport 기하를 **하나만** 렌더하고 노드도 setNodes 로만 넣는다 — 원점 이동·줌 도중·
    // 포인터 환산·커서 픽셀 경로가 한 번도 안 돈다. 사선 (100,100)→(300,160) 은 문서 x=200 에서 y=130 이라
    // 그 열을 씬 캔버스에서 직접 읽어 잉크 중심 행을 잰다(빨강만 — 검정 텍스트는 안 걸린다).
    await cdp.eval(`${S}.setStrategy('viewport')`);
    await cdp.eval(`${S}.setZoom(4)`);
    await cdp.eval(`${S}.scrollToDoc(0, 90, 90)`);
    const COL = `(c, v, sc) => {
      const bx = Math.round((200 - v.x) * sc);
      const d = c.getContext('2d').getImageData(bx, 0, 1, c.height).data;
      let n = 0, sum = 0;
      for (let y = 0; y < c.height; y++) { const o = y * 4; if (d[o + 3] > 128 && d[o] > 150 && d[o + 1] < 100) { n++; sum += y; } }
      return { n, center: n ? sum / n : null };
    }`;
    const SCENE = `() => document.querySelectorAll('[data-pdf-spike] [data-pdf-layer] > canvas')[1] || null`;
    const vp1 = await cdp.eval(`(async () => {
      const s = ${S}, col = ${COL}, scene = ${SCENE};
      const pre = s.stats(), c0 = scene();
      // 크기는 **지금** 읽는다 — 반환 객체에서 c0.width 를 읽으면 await 뒤 값이라 전·후가 같은 읽기가 된다.
      const w0 = c0.width, h0 = c0.height;
      const colPre = col(c0, pre.geo.viewport, pre.geo.scale);
      // 커밋은 마이크로태스크(SyncLane)에서 끝나고 rAF 는 아직이다 — 한 프레임 어긋남을 바로 여기서 본다.
      const pending = s.scrollToDoc(0, 90, 110);
      for (let k = 0; k < 5; k++) await Promise.resolve();
      const mid = s.stats(), c1 = scene();
      const colMid = col(c1, mid.geo.viewport, mid.geo.scale);
      const boxTop = parseFloat(c1.style.top);
      await pending;
      const post = s.stats(), c2 = scene();
      const colPost = col(c2, post.geo.viewport, post.geo.scale);
      return {
        pre: { vp: pre.geo.viewport, w: w0, h: h0 },
        mid: { vp: mid.geo.viewport, ds: mid.geo.displayScale, scale: mid.geo.scale, boxTop },
        post: { vp: post.geo.viewport, w: c2.width, h: c2.height, same: c0 === c2 },
        colPre, colMid, colPost,
      };
    })()`);
    {
      const { pre, mid, post, colPre, colMid, colPost } = vp1;
      const exp = (130 - mid.vp.y) * mid.scale;
      const tol = mid.scale; // 1pt
      const cp = mid.vp.y - pre.vp.y >= 5 && mid.vp.x === pre.vp.x && colPre.n > 0 && Math.abs(colPre.center - exp) > 4 * tol;
      r.check(
        "(VP-1-반증) 스크롤 직전 비트맵(옛 원점)으로 같은 판정을 하면 기대 행에서 4pt 넘게 벗어난다 — 지표가 원점 어긋남을 구별한다",
        cp,
        `원점 y ${pre.vp.y}→${mid.vp.y} · 옛 비트맵 잉크 중심 ${colPre.center}(n=${colPre.n}) vs 새 원점 기대 ${exp}`,
      );
      r.check(
        "(VP-1) viewport 원점을 옮긴 스크롤의 커밋 직후(rAF 전) 캔버스 박스와 픽셀이 같은 원점이다 — 스크롤 프레임마다 주석이 본문에서 어긋나지 않는다 · 반증 유효",
        cp && Math.abs(mid.boxTop - mid.vp.y * mid.ds) < 0.01 && colMid.n > 0 && Math.abs(colMid.center - exp) <= tol,
        `box top ${mid.boxTop} 기대 ${(mid.vp.y * mid.ds).toFixed(3)} · 잉크 중심 ${colMid.center}(n=${colMid.n}) 기대 ${exp}±${tol}`,
      );
      r.check(
        "(V2a) 원점만 옮긴 스크롤(백킹 크기 같음 · 재마운트 없음) 뒤 프레임이 지나도 새 원점 픽셀이다 — 커밋 캐시 키가 원점을 구별한다 · 반증 유효",
        cp &&
          post.same &&
          pre.w === post.w &&
          pre.h === post.h &&
          J(post.vp) === J(mid.vp) &&
          colPost.n > 0 &&
          Math.abs(colPost.center - exp) <= tol,
        `백킹 ${pre.w}×${pre.h} → ${post.w}×${post.h} same=${post.same} · 잉크 중심 ${colPost.center}(n=${colPost.n}) 기대 ${exp}`,
      );
    }

    // VP-2: settle(150ms) 전에 읽는다. 고정이 없으면 라이브 줌으로 보이는 문서 높이를 settle 배율로 덮는다.
    const vp2 = await cdp.eval(`(async () => {
      const s = ${S}, scene = ${SCENE};
      const raf = () => new Promise((res) => requestAnimationFrame(() => res()));
      const pre = s.stats(), c0 = scene();
      const w0 = c0.width, h0 = c0.height; // 지금 읽는다 — 반환 시점(settle 뒤)에 읽으면 전·도중이 같은 값이 된다
      const pending = s.setZoom(1);
      await raf(); await raf(); await raf();
      const mid = s.stats(), c1 = scene();
      const w1 = c1.width, h1 = c1.height;
      const pg = document.querySelector('[data-pdf-spike] [data-pdf-page="0"]').getBoundingClientRect();
      const liveDocH = mid.container.height / (pg.width / 595);
      await pending;
      const post = s.stats();
      return {
        pre: { vp: pre.geo.viewport, w: w0, h: h0, scale: pre.geo.scale },
        mid: { zoom: mid.zoom, settled: mid.settled, vp: mid.geo.viewport, w: w1, h: h1, same: c0 === c1 },
        post: { settled: post.settled, scale: post.geo.scale, vp: post.geo.viewport },
        liveDocH,
      };
    })()`);
    {
      const { pre, mid, post, liveDocH } = vp2;
      r.check(
        "(VP-2) 400%→100% 줌 도중(settle 전) viewport·백킹 크기·씬 캔버스가 settle 값에 고정된다(라이브로 보이는 문서 높이 ≥ 고정 영역×2 인데도) · settle 뒤에는 풀린다",
        mid.zoom === 1 &&
          mid.settled === 4 &&
          liveDocH >= 2 * pre.vp.height &&
          mid.same &&
          J(mid.vp) === J(pre.vp) &&
          mid.w === pre.w &&
          mid.h === pre.h &&
          post.settled === 1 &&
          post.scale < pre.scale,
        `zoom ${mid.zoom}/${mid.settled} · vp ${J(pre.vp)} → ${J(mid.vp)} · 백킹 ${pre.w}×${pre.h} → ${mid.w}×${mid.h} same=${mid.same} · ` +
          `라이브로 보이는 문서 높이 ${liveDocH.toFixed(0)}pt vs 고정 ${pre.vp.height}pt · settle 뒤 scale ${pre.scale}→${post.scale} vp=${J(post.vp)}`,
      );
    }
    await cdp.eval(`${S}.setZoom(4)`);
    await cdp.eval(`${S}.scrollToDoc(0, 90, 90)`);

    // V2c: 커서 픽셀 읽기(flushCursor)의 viewport 원점 빼기. 원점을 빠뜨리면 (200,130) 이 백킹에서 문서
    // (200+vp.x, 130+vp.y) 자리를 읽는다 — 사선에서 수십 pt 떨어진 투명 픽셀이라 #000000 이 나온다.
    const vpNow = (await cdp.eval(`${S}.stats()`)).geo.viewport;
    const hoverAt = async (x, y) => {
      await mouse("mouseMoved", await at(0, x, y));
      await frames();
      return cdp.eval(`${S}.cursor()`);
    };
    const curOn = await hoverAt(200, 130);
    const curOff = await hoverAt(200, 150);
    const nearPt = (v, e) => typeof v === "number" && Math.abs(v - e) <= 0.5;
    r.check(
      "(V2c) viewport 원점(x·y ≥5pt)에서 커서 픽셀 읽기가 원점을 뺀다 — 1pt 사선 위 (200,130) #FF0000 · 20pt 아래 #000000 · 좌표 ±0.5pt",
      !!vpNow &&
        vpNow.x >= 5 &&
        vpNow.y >= 5 &&
        curOn?.rgb === "#FF0000" &&
        curOff?.rgb === "#000000" &&
        nearPt(curOn.x, 200) &&
        nearPt(curOn.y, 130) &&
        nearPt(curOff.y, 150),
      `viewport=${J(vpNow)} on=${J(curOn)} off=${J(curOff)}`,
    );

    // VP-3: 사각형 도구 실제 드래그. 끝점 (176,160) 은 16 의 배수·정수라 격자·픽셀 스냅이 no-op 이고
    // 시작점은 스냅되지 않는다. 드래그마다 노드를 되돌려 사각형이 하나만 남게 한다.
    const dragRect = async (strategy) => {
      await cdp.eval(`${S}.setStrategy(${J(strategy)})`);
      await cdp.eval(`${S}.setNodes(0, ${J([LINE, TEXT])})`);
      await cdp.eval(`${S}.setTool('rect')`);
      const st = await cdp.eval(`${S}.stats()`);
      await drag(await at(0, 120, 120), await at(0, 176, 160));
      await frames();
      const rects = await cdp.eval(
        `${S}.getNodes(0).filter((n) => n.kind === 'rect').map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))`,
      );
      return { vp: st.geo.viewport, rects };
    };
    const dv = await dragRect("viewport");
    const dp = await dragRect("page");
    await cdp.eval(`${S}.setNodes(0, ${J([LINE, TEXT])})`);
    await cdp.eval(`${S}.setTool('select')`);
    {
      const R = { x: 120, y: 120, w: 56, h: 40 };
      const K = ["x", "y", "w", "h"];
      const rv = dv.rects.length === 1 ? dv.rects[0] : null;
      const rp = dp.rects.length === 1 ? dp.rects[0] : null;
      const ok = (q) => !!q && K.every((k) => Math.abs(q[k] - R[k]) <= 0.5);
      r.check(
        "(VP-3) 400% 사각형 도구 실제 포인터 드래그 (120,120)→(176,160) — viewport 전략(원점 ≥5pt)과 page 전략이 둘 다 x·y·w·h ±0.5pt · 두 전략 차 ≤0.5pt",
        !!dv.vp && dv.vp.x >= 5 && dv.vp.y >= 5 && dp.vp === null && ok(rv) && ok(rp) && K.every((k) => Math.abs(rv[k] - rp[k]) <= 0.5),
        `viewport=${J(dv.vp)} → ${J(dv.rects)} · page vp=${J(dp.vp)} → ${J(dp.rects)} · 원점을 빠뜨리면 x≈${dv.vp ? (120 - dv.vp.x).toFixed(2) : "-"}`,
      );
    }

    // ── T — 전환과 텍스트(LC-3 · LC-2) ────────────────────────────────────────
    // 100% page 전략 · 페이지 0 아래쪽과 페이지 1 위쪽이 한 화면에 들어오게 스크롤한다.
    await cdp.eval(`${S}.setStrategy('page')`);
    await cdp.eval(`${S}.setZoom(1)`);
    await cdp.eval(`${S}.switchTo(0)`);
    await cdp.eval(`${S}.scrollToDoc(0, 0, 520)`);
    await cdp.eval(`${S}.setTool('text')`);
    const hitPage = (p) =>
      cdp.eval(`(() => {
        const e = document.elementFromPoint(${p.x}, ${p.y});
        const pg = e && e.closest('[data-pdf-spike] [data-pdf-page]');
        return pg ? { page: Number(pg.getAttribute('data-pdf-page')), tag: e.tagName } : null;
      })()`);
    const texts = (page) =>
      cdp.eval(`${S}.getNodes(${page}).filter((n) => n.kind === 'text').map((n) => ({ text: n.text, x: n.x, y: n.y }))`);
    const has = (list, text) => list.some((n) => n.text === text);
    /** 활성 페이지 0 을 텍스트 도구로 눌러 편집을 열고 글자를 넣는다(실제 포인터 + insertText). */
    const typeOnPage0 = async (x, y, text) => {
      const p = await at(0, x, y);
      await mouse("mouseMoved", p);
      await mouse("mousePressed", p, 1);
      await mouse("mouseReleased", p, 0);
      await frames();
      await send(cdp, "Input.insertText", { text });
      await frames();
      return cdp.eval(`(() => {
        const t = document.querySelector('[data-pdf-spike] textarea');
        const r = t && t.getBoundingClientRect();
        return { ui: ${S}.ui(), value: t ? t.value : null, focused: !!t && document.activeElement === t,
          box: r ? { x: r.left, y: r.top } : null, want: ${S}.docToClient(0, ${x}, ${y}) };
      })()`);
    };

    // LC-3 반증 먼저 — raw 전환에서 텍스트가 살아남으면 아래 LC-3 은 ① 을 재는 게 아니다.
    const eA = await typeOnPage0(100, 600, "유실반증");
    const beforeA = await texts(0);
    await cdp.eval(`${S}.switchTo(1, { raw: true })`);
    const afterA = [...(await texts(0)), ...(await texts(1))];
    const cp3 = eA.ui.textEditing && eA.value === "유실반증" && !has(beforeA, "유실반증") && !has(afterA, "유실반증");
    r.check(
      "(LC-3-반증) ① 확정을 건너뛴 전환(raw)에서는 입력 중 텍스트가 어느 페이지에도 남지 않는다 — 제거되는 textarea 의 blur 가 대신 확정하지 않는다",
      cp3,
      `편집 ${J(eA.ui)} value=${J(eA.value)} · 전 ${J(beforeA)} · 후(0·1쪽) ${J(afterA)}`,
    );

    await cdp.eval(`${S}.switchTo(0)`);
    const eB = await typeOnPage0(100, 600, "전환확정");
    const beforeB = await texts(0);
    await cdp.eval(`${S}.switchTo(1)`);
    const t0B = await texts(0);
    const t1B = await texts(1);
    const uiB = await cdp.eval(`${S}.ui()`);
    const actB = await active();
    const nB = t0B.find((n) => n.text === "전환확정");
    const boxOk = !!eB.box && Math.abs(eB.box.x - eB.want.x) <= 1 && Math.abs(eB.box.y - eB.want.y) <= 1;
    r.check(
      "(LC-3) 텍스트 편집 중 활성 페이지 전환 — 옛 페이지 0 에 확정(클릭 자리 ±0.5pt · textarea 좌상단 ±1css) · 새 페이지 1 에는 없음 · textEditing 해제 · 도구 유지 · 반증 유효",
      cp3 &&
        eB.ui.textEditing &&
        eB.focused &&
        boxOk &&
        !has(beforeB, "전환확정") &&
        !!nB &&
        Math.abs(nB.x - 100) <= 0.5 &&
        Math.abs(nB.y - 600) <= 0.5 &&
        !has(t1B, "전환확정") &&
        !uiB.textEditing &&
        uiB.tool === "text" &&
        actB === 1,
      `편집 ${J(eB.ui)} focused=${eB.focused} textarea=${J(eB.box)} 기대 ${J(eB.want)} · 전 ${J(beforeB)} → 0쪽 ${J(t0B)} · 1쪽 ${J(t1B)} · ui ${J(uiB)} active=${actB}`,
    );

    // LC-2 ①: 편집 중에는 hover 전환이 막힌다(e2e 는 hoverSwitch 도 꺼져 있다). 누름이 유일한 경로다.
    await cdp.eval(`${S}.switchTo(0)`);
    const eC = await typeOnPage0(100, 700, "누름확정");
    const p1 = await at(1, 300, 150);
    const hit1 = await hitPage(p1);
    await mouse("mouseMoved", p1);
    await frames();
    const actHover = await active();
    await mouse("mousePressed", p1, 1);
    await mouse("mouseReleased", p1, 0);
    await frames();
    const actPress = await active();
    const uiC = await cdp.eval(`${S}.ui()`);
    const t0C = await texts(0);
    const t1C = await texts(1);
    const taC = await cdp.eval(`!!document.querySelector('[data-pdf-spike] textarea')`);
    r.check(
      "(LC-2) 텍스트 편집 중 비활성 페이지 1 — 올라가기만 해서는 활성 불변, 누르면 곧바로 활성 · 편집 텍스트는 옛 페이지 0 에 확정 · 새 페이지에 텍스트 생성 없음",
      eC.ui.textEditing &&
        hit1?.page === 1 &&
        hit1.tag !== "CANVAS" &&
        actHover === 0 &&
        actPress === 1 &&
        has(t0C, "누름확정") &&
        t1C.length === 0 &&
        !uiC.textEditing &&
        !taC,
      `편집 ${J(eC.ui)} · 누른 자리 ${J(hit1)} · 이동 뒤 active=${actHover} · 누른 뒤 active=${actPress} · 0쪽 ${J(t0C)} · 1쪽 ${J(t1C)} · ui ${J(uiC)} textarea=${taC}`,
    );

    // LC-2 ②: 여백에서 누른 채 들어오면 enter 가 buttons≠0 가드에 막힌다 — 놓은 뒤 첫 이동이 다시 판정해야 한다.
    await cdp.eval(`${S}.setTool('select')`);
    await cdp.eval(`${S}.switchTo(0)`);
    const cont = (await cdp.eval(`${S}.stats()`)).container;
    const grey = { x: cont.left + cont.width - 60, y: p1.y };
    const inP1 = { x: p1.x, y: p1.y + 20 };
    const hitGrey = await hitPage(grey);
    const hitIn = await hitPage(inP1);
    // 여백으로 먼저 옮기고 나서 hover 를 켠다 — 방금 전환으로 바뀐 레이아웃 아래의 가짜 mousemove 가 새지 않게.
    await mouse("mouseMoved", grey);
    await frames();
    await sleep(100);
    let actReleased = -1;
    let actMoved = -1;
    await cdp.eval(`${S}.setHoverSwitch(true)`);
    try {
      await drag(grey, inP1);
      await frames();
      actReleased = await active();
      await mouse("mouseMoved", { x: inP1.x + 4, y: inP1.y + 2 });
      await frames();
      actMoved = await active();
    } finally {
      await cdp.eval(`${S}.setHoverSwitch(false)`);
    }
    r.check(
      "(LC-2) 여백에서 누른 채 페이지 1 로 들어와 놓으면 enter 가 가드(buttons≠0)에 막혀 활성 불변 — 놓은 뒤 첫 이동에서 다시 판정해 활성이 된다",
      hitGrey === null && hitIn?.page === 1 && actReleased === 0 && actMoved === 1,
      `여백 ${J(hitGrey)} · 놓은 자리 ${J(hitIn)} · 놓은 뒤 active=${actReleased} · 이동 뒤 active=${actMoved}`,
    );
    await cdp.eval(`${S}.switchTo(0)`);
    // 포인터를 페이지 밖(하니스 헤더 줄)으로 치운다 — 게이트 4·M 의 줌·스크롤 아래에서 호버가 돌지 않게.
    await mouse("mouseMoved", { x: grey.x, y: cont.top - 20 });

    // ── 게이트 4 — 활성 페이지 전환 누수 ─────────────────────────────────────
    const HL = {
      id: "g4-hl",
      kind: "highlight",
      pts: [60, 300, 200, 306, 360, 300, 520, 310],
      strokeWidth: 16,
      strokes: [solid("#FFE600")],
    };
    const RECT = {
      id: "g4-rect",
      kind: "rect",
      x: 80,
      y: 120,
      w: 240,
      h: 160,
      strokeWidth: 2,
      strokes: [solid("#2563EB")],
    };
    const n4 = [
      await cdp.eval(`${S}.setNodes(0, ${J([HL])})`),
      await cdp.eval(`${S}.setNodes(1, ${J([RECT])})`),
      await cdp.eval(`${S}.setNodes(2, [])`),
    ];
    await cdp.eval(`${S}.setStrategy('page')`);
    await cdp.eval(`${S}.setZoom(2)`);
    await cdp.eval(`${S}.scrollTo(0, 0)`);
    await cdp.eval(`${S}.switchTo(0)`);
    // 워밍업: 세 페이지를 한 바퀴 — 풀·씬 슬롯·정적 오버레이가 한 번씩 만들어진 뒤를 기준으로 삼는다.
    for (const t of [1, 2, 0]) await cdp.eval(`${S}.switchTo(${t})`);
    await sleep(POOL_IDLE_MS);
    const heap0 = await heapCanvases(cdp);
    const stA = await cdp.eval(`${S}.stats()`);

    // 계측 반증: 분리 캔버스 3장(64×64)을 일부러 붙잡는다 — 힙 +3, DOM 0.
    await cdp.eval(
      `window.__gpv62.leak = Array.from({ length: 3 }, () => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; return c; }); true`,
    );
    const heapL = await heapCanvases(cdp);
    const domL = await cdp.eval(`document.querySelectorAll('canvas').length`);
    await cdp.eval(`delete window.__gpv62.leak; true`);
    r.check(
      "(4-반증) 힙 계측이 DOM 밖 분리 캔버스를 본다 — 일부러 붙잡은 3장이 개수 +3 · 면적 +3×64² (DOM 개수는 그대로)",
      heapL.count - heap0.count === 3 && heapL.area - heap0.area === 3 * 64 * 64 && domL === stA.domCanvasCount,
      `nodes=${J(n4)} heap ${J(heap0)} → ${J(heapL)} dom ${stA.domCanvasCount} → ${domL}`,
    );
    // 계측 반증 2: **컨텍스트로만** 붙잡은 3장(layers.ts 풀 Entry·텍스트 스크래치와 같은 모양)을 같은
    // 태스크의 churn 뒤에 잰다 — 요소 질의만 하면 래퍼가 버려져 이 모양의 누수가 초록으로 숨는다.
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

    // 전환이 **실제로** 일어났는지도 같이 센다 — switchTo 가 아무것도 안 해도 끝 활성은 0 이라
    // 개수·면적 단언은 초록이다. 씬 캔버스 요소가 매번 바뀌고(재마운트) 그 페이지 div 안에 있어야 한다.
    // 요소 참조는 직전 1개만 쥔다 — 모아 두면 그 자체가 힙 캔버스 누수로 잡힌다.
    const loop = await cdp.eval(
      `(async () => {
        const s = ${S}, seq = [1, 0, 2, 0], t0 = performance.now();
        const scene = () => document.querySelectorAll('[data-pdf-spike] [data-pdf-layer] > canvas')[1] || null;
        let prev = scene(), remounts = 0, wrongActive = 0, wrongPage = 0;
        for (let k = 0; k < 100; k++) {
          const want = seq[k % 4];
          await s.switchTo(want);
          const cur = scene();
          if (cur && cur !== prev) remounts++;
          prev = cur;
          if (s.stats().active !== want) wrongActive++;
          if (!document.querySelector('[data-pdf-page="' + want + '"] [data-pdf-layer]')) wrongPage++;
        }
        prev = null;
        return { ms: Math.round(performance.now() - t0), active: s.stats().active, remounts, wrongActive, wrongPage };
      })()`,
      { timeoutMs: 180000 },
    );
    await sleep(POOL_IDLE_MS);
    const heap1 = await heapCanvases(cdp);
    const stB = await cdp.eval(`${S}.stats()`);
    r.check(
      "(4) 활성 페이지 전환 100회(1,0,2,0 반복 · 레이어 재마운트 100회 확인) 뒤 힙 캔버스 개수 ≤ 전 · 면적 ≤ 전×1.05 (강제 GC · 풀 유휴 해제 뒤 같은 활성 페이지)",
      loop.active === 0 &&
        loop.remounts === 100 &&
        loop.wrongActive === 0 &&
        loop.wrongPage === 0 &&
        heap1.count <= heapB.count &&
        heap1.area <= heapB.area * 1.05,
      `before=${heapB.count}개/${mp(heapB.area)}MP after=${heap1.count}개/${mp(heap1.area)}MP ` +
        `loop=${loop.ms}ms(${(loop.ms / 100).toFixed(1)}ms/회) active=${loop.active} ` +
        `remounts=${loop.remounts} wrongActive=${loop.wrongActive} wrongPage=${loop.wrongPage}`,
    );
    r.check(
      "(4) DOM 캔버스 수 불변 — 중복 마운트 없음(보조 지표)",
      stB.domCanvasCount === stA.domCanvasCount,
      `dom ${stA.domCanvasCount} → ${stB.domCanvasCount} · 하니스 ${J(stA.harnessCanvases)} → ${J(stB.harnessCanvases)}`,
    );

    // ── M — 400% 백킹 메모리(page vs viewport) ────────────────────────────────
    // 형광펜(multiply → 격리 레이어 풀)이 있는 페이지 0 을 활성으로 두고 **페인트 직후** 잰다 —
    // 풀이 살아 있는 상태라 "그리는 동안"의 봉우리에 가깝다(유휴 5s 뒤에는 풀 몫이 빠진다).
    // 화면 밖 페이지 1 의 정적 오버레이는 두 전략 모두 컬링된다(LC-4) — 합계에 컬링 정책 차이가 섞이지
    // 않도록 활성 레이어 · 정적 오버레이 · 힙−하니스 DOM(풀·스크래치·앱의 다른 캔버스)을 갈라 찍는다.
    const mem = {};
    for (const s of ["page", "viewport"]) {
      await cdp.eval(`${S}.setStrategy(${J(s)})`);
      await cdp.eval(`${S}.setZoom(4)`);
      await cdp.eval(`${S}.switchTo(0)`);
      await cdp.eval(`${S}.scrollToDoc(0, 40, 250)`);
      await sleep(300);
      const heap = await heapCanvases(cdp);
      const st = await cdp.eval(`${S}.stats()`);
      mem[s] = { heap, st, layerPx: st.layer ? st.layer.backW * st.layer.backH : null };
      const staticArea = st.statics.reduce((n, q) => n + q.w * q.h, 0);
      r.info(
        `M ${s}: 힙 캔버스 ${heap.count}개 Σ${mp(heap.area)}MP(≈${Math.round((heap.area * 4) / 2 ** 20)}MiB RGBA) = ` +
          `활성 레이어 ${st.layerCanvases.count}장 Σ${mp(st.layerCanvases.area)}MP + ` +
          `정적 오버레이 ${st.statics.length}장 Σ${mp(staticArea)}MP + ` +
          `힙−하니스 DOM Σ${mp(heap.area - st.harnessCanvases.area)}MP(풀·스크래치·앱의 다른 캔버스) · ` +
          `활성 백킹 ${st.layer?.backW}×${st.layer?.backH} dpr=${st.dpr}`,
      );

      // LC-4: 노드 있는 페이지 1 이 화면(+여백 96css) 밖이면 정적 캔버스가 없다. 반증 — 스크롤해 보이면 생긴다
      // (컬링이 "아예 안 그림"으로 고장 나 있으면 여기서 빨개진다).
      const p1Top = await cdp.eval(`document.querySelector('[data-pdf-spike] [data-pdf-page="1"]').getBoundingClientRect().top`);
      const c = st.container;
      const below = c ? p1Top - (c.top + c.height) : null;
      const nodes1 = (await cdp.eval(`${S}.getNodes(1)`)).length;
      const off1 = st.statics.filter((q) => q.page === 1);
      await cdp.eval(`${S}.scrollToDoc(1, 40, 100)`);
      const on1 = (await cdp.eval(`${S}.stats()`)).statics.filter((q) => q.page === 1);
      r.check(
        `(LC-4) ${s}: 400% 화면(+여백 96css) 밖의 주석 페이지 1 에는 정적 캔버스가 없다 — 스크롤해 보이면 생긴다(반증)`,
        nodes1 === 1 && below !== null && below > 96 && off1.length === 0 && on1.length === 1 && on1[0].w * on1[0].h > 1e6,
        `페이지 1 노드 ${nodes1} · 컨테이너 아래로 ${below?.toFixed(0)}css · 밖 ${J(off1)} → 보임 ${J(on1)}`,
      );
    }
    r.check(
      "(M) 400% viewport 전략의 활성 백킹이 page 전략보다 작다 — 전략이 실제로 적용됐다(면적은 위 info)",
      mem.page.layerPx !== null && mem.viewport.layerPx !== null && mem.viewport.layerPx < mem.page.layerPx,
      `page Σ${mp(mem.page.heap.area)}MP vs viewport Σ${mp(mem.viewport.heap.area)}MP · 활성 ${mp(mem.page.layerPx ?? 0)}MP vs ${mp(mem.viewport.layerPx ?? 0)}MP`,
    );

    const origin1 = await cdp.eval(`performance.timeOrigin`);
    r.check(
      "실행 중 창 리로드 없음(performance.timeOrigin 불변) — 리로드가 끼었으면 위 수치는 무효",
      origin1 === origin0,
      `${origin0} → ${origin1}`,
    );
  } finally {
    await cdp.eval(`window.__gpv?.pdfSpike?.close?.()`).catch(() => {});
    await cdp.eval(`delete window.__gpv62`).catch(() => {});
  }
}
