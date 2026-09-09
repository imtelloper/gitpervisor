// 텍스트 레이아웃 엔진 — DOCS/task/49-image-text-layout.md §7.
//
// 이 스위트가 지키는 계약 셋:
//   ① **산출물이 하나다.** 줄 나눔·상자·마커·장식은 `layoutText` 한 곳에서 나오고 렌더·히트·
//      선택 상자·textarea 오버레이 넷이 그것을 나눠 쓴다. 넷 중 하나만 옛 계산을 쓰면
//      "집히는 곳 ≠ 보이는 곳" 이 되는데, 그건 클릭해 봐야만 드러나는 종류의 고장이다.
//      그래서 여기서는 **훅이 말하는 줄**과 **캔버스에 실제로 찍힌 잉크**를 매번 함께 잰다.
//   ② **프리뷰와 저장이 같은 픽셀이다.** 텍스트만은 브라우저 셰이핑에 기대므로, 렌더 경로가
//      갈리면 화면에서 멀쩡하던 글자가 파일에서 밀린다 — 저장본을 직접 디코드해 잉크를
//      **한 픽셀씩** 대조한다.
//   ③ **편집 오버레이와 캔버스가 같은 자리를 쓴다.** textarea 는 Blink 라인박스, 캔버스는
//      alphabetic 베이스라인이라 정의가 다르다 — `textCss`/`textEditBox` 두 열이 같은 값을
//      낼 때만 확정 전후로 글자가 튀지 않는다(현행 최대 5px 어긋남이 이 태스크의 출발점이다).
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 다(30·37·40 과 같은 전제).
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "이미지 텍스트 레이아웃 (줄바꿈·정렬·목록·말줄임·박스 모드 / 렌더==저장 / textarea 메트릭 계약)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const HELPERS = `(() => {
  const A = {};
  window.__gpvText = A;

  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(
      (el) => el.getAttribute('aria-label') === '이미지 편집',
    ) || null;
  A.canvases = () => {
    const m = A.modal();
    return m ? Array.from(m.querySelectorAll('canvas')) : [];
  };
  A.ready = () => {
    const ed = window.__gpv && window.__gpv.imageEditor;
    if (!ed) return false;
    const cs = A.canvases();
    return cs.length >= 2 && cs[1].width > 0 && ed.getDoc().outW > 0;
  };
  A.frame = () =>
    new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  A.ed = () => window.__gpv.imageEditor;
  A.doc = () => A.ed().getDoc();
  A.obj = (id) => A.doc().objects.find((o) => o.id === id) || null;
  A.layout = (id, opts) => A.ed().textLayout(id, opts);
  A.focusRoot = () => {
    const m = A.modal();
    if (m) m.focus();
    return document.activeElement === m;
  };

  A.setDoc = async (patch) => {
    A.ed().setDoc(patch);
    await A.frame();
    A.ed().renderOnce();
    await A.frame();
    return true;
  };

  // ── 잉크(글자가 실제로 찍힌 자리) ─────────────────────────────────────────
  //
  // 색이 아니라 **흰색이 아님**으로 센다. 안티앨리어스가 글자 획의 대부분이라 색 일치로
  // 세면 11px 캡션에서 잉크가 거의 잡히지 않는다.
  A.maskOf = (data, w, h) => {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) {
      const o = i * 4;
      m[i] = data[o] < 240 || data[o + 1] < 240 || data[o + 2] < 240 ? 1 : 0;
    }
    return { w: w, h: h, m: m };
  };
  A.inkOf = (box) => {
    const c = A.canvases()[1];
    const d = c.getContext('2d').getImageData(box[0], box[1], box[2], box[3]).data;
    return A.maskOf(d, box[2], box[3]);
  };
  /** 잉크 경계(절대 좌표). 잉크가 없으면 null — '아무것도 안 그려졌다'를 값으로 구분한다. */
  A.inkBounds = (box) => {
    const k = A.inkOf(box);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < k.h; y++) {
      for (let x = 0; x < k.w; x++) {
        if (!k.m[y * k.w + x]) continue;
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    if (n === 0) return null;
    return { n: n, x0: box[0] + x0, y0: box[1] + y0, x1: box[0] + x1, y1: box[1] + y1 };
  };
  A.inkSnap = (box) => {
    A._ink = A.inkOf(box);
    return A._ink.m.reduce((a, b) => a + b, 0);
  };
  /** 저장본의 같은 상자를 **픽셀 하나씩** 대조한다(프리뷰 == 파일). */
  A.savedInkDiff = async (projectId, relPath, box) => {
    const res = await window.__TAURI_INTERNALS__.invoke('read_file_base64', {
      projectId: projectId, relPath: relPath,
    });
    const img = await new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error('저장 파일 디코드 실패'));
      im.src = 'data:' + res.mime + ';base64,' + res.base64;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const k = A.maskOf(ctx.getImageData(box[0], box[1], box[2], box[3]).data, box[2], box[3]);
    const a = A._ink;
    if (!a || a.w !== k.w || a.h !== k.h) return { w: c.width, h: c.height, diff: -1 };
    let diff = 0;
    for (let i = 0; i < k.m.length; i++) if (k.m[i] !== a.m[i]) diff++;
    return { w: c.width, h: c.height, diff: diff, ink: k.m.reduce((x, y) => x + y, 0) };
  };

  /** 지금 폰트로 잰 글자 폭 — 레이아웃이 쓰는 것과 **같은 ctx.font** 로 잰다. */
  A.measure = (font, s) => {
    const c = document.createElement('canvas');
    const x = c.getContext('2d');
    x.font = font;
    return x.measureText(s).width;
  };

  // ── 포인터 · 편집 ─────────────────────────────────────────────────────────
  A.pointerSeq = async (steps, opts) => {
    const P = Element.prototype;
    const o = { s: P.setPointerCapture, r: P.releasePointerCapture, h: P.hasPointerCapture };
    P.setPointerCapture = function () {};
    P.releasePointerCapture = function () {};
    P.hasPointerCapture = function () { return false; };
    try {
      const c = A.canvases()[1];
      if (!c) return false;
      for (const st of steps) {
        const rect = c.getBoundingClientRect();
        c.dispatchEvent(
          new PointerEvent('pointer' + st[0], {
            bubbles: true, cancelable: true, composed: true,
            clientX: rect.left + (st[1] / c.width) * rect.width,
            clientY: rect.top + (st[2] / c.height) * rect.height,
            button: 0, buttons: st[0] === 'up' ? 0 : 1,
            ctrlKey: !!(opts && opts.ctrl), shiftKey: !!(opts && opts.shift),
            pointerId: 2100, pointerType: 'mouse', isPrimary: true,
          }),
        );
        if (st[0] !== 'move') await A.frame();
      }
      return true;
    } finally {
      P.setPointerCapture = o.s;
      P.releasePointerCapture = o.r;
      P.hasPointerCapture = o.h;
    }
  };
  A.clickCanvas = (pts) => {
    const steps = [];
    for (const p of pts) steps.push(['down', p[0], p[1]], ['up', p[0], p[1]]);
    return A.pointerSeq(steps);
  };
  /** 더블클릭 = 텍스트 재편집(pointer.ts onDoubleClick). React 는 'dblclick' 을 듣는다. */
  A.dblClick = async (x, y) => {
    const c = A.canvases()[1];
    if (!c) return false;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true, cancelable: true,
        clientX: r.left + (x / c.width) * r.width,
        clientY: r.top + (y / c.height) * r.height,
      }),
    );
    await A.frame();
    await A.frame();
    return true;
  };
  A.textarea = () => {
    const m = A.modal();
    return m ? m.querySelector('textarea') : null;
  };
  /** textarea 가 쓴 값 — 캔버스 열(layoutText)과 같은지 대조할 DOM 열의 전부. */
  A.taBox = () => {
    const t = A.textarea();
    if (!t) return null;
    const s = t.style;
    return {
      left: parseFloat(s.left), top: parseFloat(s.top),
      width: parseFloat(s.width), height: parseFloat(s.height),
      fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight),
      align: s.textAlign, wrap: s.whiteSpace, brk: s.wordBreak,
      transform: s.transform, origin: s.transformOrigin,
    };
  };
  A.esc = async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 200));
    await A.frame();
    return true;
  };

  A.selCount = () => {
    const m = A.modal();
    if (!m) return -1;
    const re = /^\\s*(\\d+)개 선택/;
    let hit = null;
    for (const el of Array.from(m.querySelectorAll('*'))) {
      if (re.test(el.textContent || '')) hit = el;
    }
    return hit ? Number(re.exec(hit.textContent)[1]) : 0;
  };
  A.selectAll = async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true,
      }),
    );
    await A.frame();
    return true;
  };

  A.click = (re) => {
    const m = A.modal();
    const b = m
      ? Array.from(m.querySelectorAll('button')).find((x) =>
          re.test((x.textContent || '') + ' ' + (x.title || '')),
        )
      : null;
    if (!b) return false;
    b.click();
    return true;
  };
  A.saveAs = async (fileName) => {
    if (!A.click(/다른 이름으로/)) return { ok: false, why: 'button' };
    await new Promise((r) => setTimeout(r, 80));
    const st = window.__gpv.ui.getState();
    const req = st.prompt;
    if (!req) return { ok: false, why: 'prompt' };
    st.closePrompt();
    req.onConfirm(fileName);
    return { ok: true };
  };

  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /**
   * DOM 미러 — 편집기의 textCss 로 만든 숨은 div 에 같은 글자를 넣고 줄 수·줄 폭을 잰다.
   * 캔버스 열과 DOM 열이 정말 같은 줄을 내는지는 이 대조 말고 확인할 방법이 없다.
   */
  A.mirror = (id, ds) => {
    const ed = A.ed();
    if (!ed.textCss) return null;
    const o = A.obj(id);
    const l = A.layout(id);
    const div = document.createElement('div');
    Object.assign(div.style, ed.textCss(id));
    div.style.position = 'absolute';
    div.style.left = '-10000px';
    div.style.top = '0px';
    div.style.width = l.box.w * ds + 'px';
    div.textContent = o.text;
    document.body.appendChild(div);
    const range = document.createRange();
    range.selectNodeContents(div);
    const rects = Array.from(range.getClientRects());
    const base = div.getBoundingClientRect();
    const out = rects.map((r) => ({ w: r.width, top: r.top - base.top }));
    div.remove();
    return { lines: out.length, rows: out };
  };

  return true;
})()`;

/** v1 리터럴 — 경계(normalizeDoc)가 v2 타이포 기본값으로 채운다. */
const text = (id, x, y, body, extra) => ({
  id, kind: "text", x, y, text: body, stroke: "#000000", strokeWidth: 0, ...(extra || {}),
});

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 텍스트 레이아웃", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-text.png";
  const OUT = "e2e-text-out.png";
  const created = [SRC, OUT];

  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const S = (expr) => cdp.eval(`window.__gpvText.${expr}`);
  const setDoc = (patch) => cdp.eval(`window.__gpvText.setDoc(${J(patch)})`);
  const layout = (id, opts) =>
    cdp.eval(
      `window.__gpvText.layout(${J(id)}${opts ? `, ${J(opts)}` : ""})`,
    );
  const closeEditor = () =>
    cdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});
  const openEditor = async (rel = SRC) => {
    await closeEditor();
    await sleep(200);
    // 41 자동 복원이 "새로 연 편집기는 비어 있다" 전제를 깬다 — 사이드카를 먼저 지운다.
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: rel });
    await cdp.eval(
      `window.__gpv.ui.getState().openImageEditor(${J(rel)}, ${J(fix.projectId)})`,
    );
    const ok = await poll(() => S(`ready()`).catch(() => false), (v) => v === true);
    await S(`focusRoot()`).catch(() => {});
    return ok === true;
  };

  let snap0 = null;

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const b64 = await cdp.eval(`window.__gpvText.solidPng(200, 200, '#ffffff')`);
    const made = await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: b64, overwrite: true,
    });
    if (!r.check("픽스처 PNG(200×200 흰색) 생성", made.ok && existsSync(join(fix.repo, SRC)))) {
      return;
    }
    if (!r.check("편집기 열림", (await openEditor()) === true)) return;

    const hasLayout = await cdp.eval(
      `typeof window.__gpv.imageEditor.textLayout === 'function'`,
    );
    if (!hasLayout) {
      r.skip("텍스트 레이아웃", "`__gpv.imageEditor.textLayout` 훅 미노출 — 태스크 49 미착지");
      return;
    }

    // 스냅이 켜져 있으면 리사이즈 핸들 산술이 어긋난다(30·40 과 같은 규칙).
    snap0 = await cdp.eval(`window.__gpv.imageEditor.getUi().toggles.snap`);
    await cdp.eval(`window.__gpv.imageEditor.setToggle('snap', false)`);

    // ── (a) 어절 줄바꿈 ──────────────────────────────────────────────────────
    await setDoc({
      objects: [
        text("t1", 20, 20, "가나다 라마바", {
          w: 80, h: 0, resize: "auto-height", fontSize: 20,
        }),
      ],
    });
    const la = await layout("t1");
    const inkLine2 = await S(
      `inkBounds([20, ${Math.round(20 + (la.lines[1] ? la.lines[1].top : 0))}, 120, 40])`,
    );
    r.check(
      "(a) 한글 어절 경계에서 줄이 나뉜다(둘째 줄이 `라` 로 시작) — 잉크도 그 줄 자리에 찍힌다",
      la.lines.length === 2 &&
        la.lines[1].runs[0].text.indexOf("라") === 0 &&
        !!inkLine2 && inkLine2.y0 >= 20 + la.lines[1].top - 1,
      `줄=${la.lines.length} 둘째="${la.lines[1] && la.lines[1].runs[0].text}" 잉크top=${inkLine2 && inkLine2.y0} 기대≥${20 + (la.lines[1] ? la.lines[1].top : 0)}`,
    );

    // ── (b) 상자보다 긴 토큰은 강제로 자른다 ─────────────────────────────────
    await setDoc({
      objects: [
        text("t2", 20, 20, "abcdefghijklmnopqrstuvwxyz", {
          w: 60, h: 0, resize: "auto-height", fontSize: 20,
        }),
      ],
    });
    const lb = await layout("t2");
    r.check(
      "(b) 공백이 없어 넘치는 토큰은 그래핌 단위로 강제 분할된다(`forced` · 줄 폭 ≤ 상자)",
      lb.lines.length >= 2 &&
        lb.lines.slice(0, -1).every((l) => l.forced === true) &&
        lb.lines.every((l) => l.width <= 61),
      `줄=${lb.lines.length} forced=${J(lb.lines.map((l) => l.forced))} 폭=${J(lb.lines.map((l) => Math.round(l.width)))}`,
    );

    // ── (c) 양쪽정렬 ─────────────────────────────────────────────────────────
    await setDoc({
      objects: [
        text("t3", 20, 20, "aa bb cc dd", {
          w: 90, h: 0, resize: "auto-height", fontSize: 20, align: "justify",
        }),
      ],
    });
    const lc = await layout("t3");
    const band = (l, o) =>
      `inkBounds([${o.x}, ${Math.round(o.y + l.top)}, ${Math.round(o.w) + 20}, ${Math.ceil(lc.lineHeightPx)}])`;
    const c1 = await S(band(lc.lines[0], { x: 20, y: 20, w: 90 }));
    const cLast = await S(band(lc.lines[lc.lines.length - 1], { x: 20, y: 20, w: 90 }));
    r.check(
      "(c) 양쪽정렬은 마지막 줄을 빼고 오른쪽 끝을 상자에 맞춘다(줄당 fillText 1회 + wordSpacing)",
      lc.lines.length >= 2 && !!c1 && !!cLast &&
        Math.abs(c1.x1 - (20 + lc.box.w)) <= 2 && cLast.x1 < c1.x1 - 2,
      `첫줄 오른쪽=${c1 && c1.x1} 상자오른쪽=${20 + lc.box.w} 마지막줄=${cLast && cLast.x1}`,
    );

    // ── (d) 말줄임 ───────────────────────────────────────────────────────────
    await setDoc({
      objects: [
        text("t4", 20, 20, "가나다 라마바 사아자", {
          w: 70, h: 0, resize: "auto-height", fontSize: 20, truncateLines: 2,
        }),
      ],
    });
    const ld = await layout("t4");
    const line3Ink = await S(
      `inkBounds([20, ${Math.round(20 + 2 * ld.lineHeightPx)}, 120, ${Math.ceil(ld.lineHeightPx)}])`,
    );
    const ldEdit = await layout("t4", { editing: true });
    const lastRun = ld.lines[ld.lines.length - 1].runs;
    r.check(
      "(d-1) `말줄임 2줄` 은 두 줄까지만 배치하고 끝에 `…` 를 붙인다(셋째 줄 자리에는 잉크 0)",
      ld.truncated === true && ld.lines.length === 2 &&
        /…$/.test(lastRun[lastRun.length - 1].text) && line3Ink === null,
      `truncated=${ld.truncated} 줄=${ld.lines.length} 끝="${lastRun[lastRun.length - 1].text}" 셋째줄잉크=${line3Ink ? line3Ink.n : 0}`,
    );
    r.check(
      "(d-2) 편집 중에는 말줄임이 풀린다 — textarea 는 전문을 보여 준다(Figma 동일)",
      ldEdit.truncated === false && ldEdit.lines.length > 2,
      `편집 truncated=${ldEdit.truncated} 줄=${ldEdit.lines.length}`,
    );

    // ── (e) 목록 마커 ────────────────────────────────────────────────────────
    const listOf = async (kind, level) => {
      await setDoc({
        objects: [
          text("t5", 20, 20, "가나\n다라", {
            w: 150, h: 0, resize: "auto-height", fontSize: 20, list: kind, listLevel: level || 0,
          }),
        ],
      });
      return layout("t5");
    };
    const lBul = await listOf("bullet", 0);
    const lLvl = await listOf("bullet", 1);
    const lNum = await listOf("number", 0);
    r.check(
      "(e-1) 마커는 내용 왼쪽 밖에 놓이고, 레벨 1은 내용을 1.5em 더 민다(마커를 글자에 섞지 않는다)",
      lBul.lines[0].marker && lBul.lines[0].marker.x < lBul.lines[0].runs[0].x &&
        Math.abs(lLvl.lines[0].runs[0].x - lBul.lines[0].runs[0].x - 30) <= 0.5,
      `마커x=${lBul.lines[0].marker && lBul.lines[0].marker.x} 내용x=${lBul.lines[0].runs[0].x} 레벨1 내용x=${lLvl.lines[0].runs[0].x}`,
    );
    r.check(
      "(e-2) 번호는 문단마다 하나씩 오른다(`1.` · `2.`)",
      lNum.lines[0].marker && lNum.lines[0].marker.text === "1." &&
        lNum.lines[1].marker && lNum.lines[1].marker.text === "2.",
      J(lNum.lines.map((l) => l.marker && l.marker.text)),
    );

    // ── (f) 대소문자 — 재는 문자열만 바꾼다 ──────────────────────────────────
    await setDoc({
      objects: [text("t6", 20, 20, "abc", { fontSize: 20, textCase: "upper" })],
    });
    const lf = await layout("t6");
    const wUpper = await S(`measure(${J(lf.font)}, 'ABC')`);
    const savedText = await cdp.eval(`window.__gpvText.obj('t6').text`);
    r.check(
      "(f) `대문자` 는 그리는 글자만 바꾸고 **저장 문자열은 그대로**다(되돌릴 수 있어야 한다)",
      Math.abs(lf.lines[0].width - wUpper) <= 0.5 && savedText === "abc",
      `폭=${lf.lines[0].width.toFixed(2)} 기대=${wUpper.toFixed(2)} 문자열="${savedText}"`,
    );

    // ── (g) 박스 모드 · 세로 정렬 ────────────────────────────────────────────
    const vAlign = async (valign) => {
      await setDoc({
        objects: [
          text("t7", 20, 20, "가나 다라 마바", {
            w: 150, h: 200, resize: "fixed", fontSize: 20, valign,
          }),
        ],
      });
      return layout("t7");
    };
    const lTop = await vAlign("top");
    const lBottom = await vAlign("bottom");
    const lMid = await vAlign("middle");
    const lastBottom =
      lBottom.lines[lBottom.lines.length - 1].baseline + lBottom.descent;
    r.check(
      "(g-1) `고정` 상자에서 세로 정렬 셋이 각자 다른 자리에 내용을 놓는다(위 · 아래 붙음 · 가운데)",
      lTop.contentTop === 0 &&
        Math.abs(lBottom.contentTop + lBottom.contentH - 200) <= 0.5 &&
        Math.abs(lMid.contentTop - (200 - lMid.contentH) / 2) <= 0.5,
      `top=${lTop.contentTop} bottom=${lBottom.contentTop}+${lBottom.contentH} middle=${lMid.contentTop}`,
    );
    // 산술을 끝까지 접으면 `상자바닥 − (baseline+descent) === halfLead` 는 **항등식**이다
    // (contentTop=slackV, 마지막 줄 top=boxH−lh). lineHeight 1.25 + Segoe UI 처럼 자연
    // 라인박스가 lh 보다 큰 조합에서는 halfLead 가 음수라 디센더가 상자 밖으로 그만큼
    // 내려간다 — CSS·Figma 도 같다. `<= 200` 으로 재면 그 정상 동작을 결함으로 잡고,
    // `<= 201` 로 느슨하게 풀면 contentTop 이 반 줄 어긋나도 통과한다. 항등식이 더 강하다.
    const halfLead =
      (lBottom.lineHeightPx - (lBottom.ascent + lBottom.descent)) / 2;
    r.check(
      "(g-2) 아래 정렬의 마지막 줄이 상자 바닥에 붙고 남는 것은 half-leading 뿐이다(음수면 디센더가 그만큼 내려간다)",
      Math.abs(200 - lastBottom - halfLead) <= 0.5,
      `baseline+descent=${lastBottom.toFixed(2)} 상자=200 여유=${(200 - lastBottom).toFixed(2)} halfLead=${halfLead.toFixed(2)}`,
    );
    r.check(
      "(g-3) 상자 모드가 폭·높이를 지배한다(auto-width 는 최장 줄 · fixed 는 준 값)",
      Math.abs(lTop.box.w - 150) <= 0.5 && lTop.box.h >= 200 - 0.5 &&
        Math.abs(lf.box.w - lf.lines[0].width) <= 0.5,
      `fixed=${J(lTop.box)} auto=${J(lf.box)}`,
    );

    // ── (h) 리사이즈 — 글자 크기는 그대로 ────────────────────────────────────
    await setDoc({
      objects: [text("t8", 40, 60, "가나다라", { fontSize: 20 })],
    });
    const lh0 = await layout("t8");
    await S(`clickCanvas([[${Math.round(40 + lh0.box.w / 2)}, ${Math.round(60 + lh0.box.h / 2)}]])`);
    await sleep(200);
    const eX = Math.round(40 + lh0.box.w);
    const eY = Math.round(60 + lh0.box.h / 2);
    await S(
      `pointerSeq([['down',${eX},${eY}],['move',${eX + 20},${eY}],['move',${eX + 40},${eY}],['up',${eX + 40},${eY}]])`,
    );
    await sleep(250);
    const afterE = await cdp.eval(`(() => {
      const o = window.__gpvText.obj('t8');
      return o ? { resize: o.resize, w: o.w, fontSize: o.fontSize } : null;
    })()`);
    r.check(
      "(h-1) 좌우 핸들은 **상자 폭**만 바꾼다(`자동 높이` 로 전환 · 글자 크기 불변) — Figma 동작",
      !!afterE && afterE.resize === "auto-height" &&
        Math.abs(afterE.w - (lh0.box.w + 40)) <= 2 && afterE.fontSize === 20,
      J(afterE),
    );
    // 상자가 방금 바뀌었으므로 모서리를 **다시** 잰다 — 옛 좌표로 누르면 핸들이 아니라
    // 빈 곳을 눌러 드래그가 통째로 다른 제스처(마퀴)가 된다.
    const corner = async () => {
      const l = await layout("t8");
      const o = await cdp.eval(`window.__gpvText.obj('t8')`);
      return { x: Math.round(o.x + l.box.w), y: Math.round(o.y + l.box.h) };
    };
    const drag = async (from, opts) =>
      S(
        `pointerSeq([['down',${from.x},${from.y}],['move',${from.x + 10},${from.y + 10}],` +
          `['move',${from.x + 20},${from.y + 20}],['up',${from.x + 20},${from.y + 20}]]` +
          `${opts ? `, ${opts}` : ""})`,
      );
    await drag(await corner());
    await sleep(250);
    const afterSE = await cdp.eval(`(() => {
      const o = window.__gpvText.obj('t8');
      return o ? { resize: o.resize, fontSize: o.fontSize } : null;
    })()`);
    await drag(await corner(), "{ ctrl: true }");
    await sleep(250);
    const afterCtrl = await cdp.eval(`(() => {
      const o = window.__gpvText.obj('t8');
      return o ? { resize: o.resize, fontSize: o.fontSize } : null;
    })()`);
    r.check(
      "(h-2) 모서리 핸들은 `고정` 상자, Ctrl 을 누르면 종전대로 **글자 배율**이다(v1 회귀 없음)",
      !!afterSE && afterSE.resize === "fixed" && afterSE.fontSize === 20 &&
        !!afterCtrl && afterCtrl.fontSize > 20,
      `SE=${J(afterSE)} Ctrl+SE=${J(afterCtrl)}`,
    );

    // ── (i) 히트 == 상자 ─────────────────────────────────────────────────────
    await setDoc({
      objects: [text("t9", 40, 60, "가나다라", { fontSize: 20 })],
    });
    const li = await layout("t9");
    await S(`clickCanvas([[${Math.round(40 + li.box.w / 2)}, ${Math.round(60 + li.box.h / 2)}]])`);
    await sleep(200);
    const selIn = await S(`selCount()`);
    // AABB 는 **해제 클릭 이전에** 읽는다 — 상자 언저리를 누르는 순간 리사이즈 드래그가
    // 시작되므로, 그 뒤에 읽으면 무엇을 재는지가 흐려진다.
    const aabb = await cdp.eval(`window.__gpvText.ed().tree.nodeAABB('t9')`);
    // 선택 중에는 상자 밖 몇 px 이 **리사이즈 핸들 자리**다(HANDLE_GRAB_CSS=10/displayScale,
    // Figma 동일). 4px 밖은 '빈 곳'이 아니라 E 핸들 안이라 선택이 풀릴 리 없다 —
    // 파지 반경 밖(20px)을 찍어야 이 단언이 재려던 '상자 밖 = 해제'를 실제로 잰다.
    await S(`clickCanvas([[${Math.round(40 + li.box.w + 20)}, ${Math.round(60 + li.box.h / 2)}]])`);
    await sleep(200);
    const selOut = await S(`selCount()`);
    r.check(
      "(i) 집히는 상자 == 그려지는 상자 — 안쪽 클릭은 선택, 핸들 반경 밖(20px)은 해제, AABB 는 layout.box + 앵커",
      selIn === 1 && selOut === 0 && !!aabb &&
        Math.abs(aabb.x - 40) <= 0.5 && Math.abs(aabb.y - 60) <= 0.5 &&
        Math.abs(aabb.w - li.box.w) <= 0.5 && Math.abs(aabb.h - li.box.h) <= 0.5,
      `안=${selIn} 밖=${selOut} aabb=${J(aabb)} box=${J(li.box)}`,
    );

    // ── (j) 프리뷰 == 저장 ───────────────────────────────────────────────────
    await setDoc({
      objects: [
        text("tj", 20, 30, "가나다 라마바\nabc DEF", {
          w: 150, h: 0, resize: "auto-height", fontSize: 18,
        }),
      ],
    });
    const lj = await layout("tj");
    const jBox = [15, 25, 170, Math.ceil(lj.box.h) + 20];
    const jInk = await S(`inkSnap(${J(jBox)})`);
    const saved = await cdp.eval(`window.__gpvText.saveAs(${J(OUT)})`);
    await poll(
      () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
      (v) => v === null,
      30,
      200,
    );
    const jDiff = await cdp.eval(
      `window.__gpvText.savedInkDiff(${J(fix.projectId)}, ${J(OUT)}, ${J(jBox)})`,
    );
    r.check(
      "(j) 프리뷰와 저장본의 글자 잉크가 **픽셀 단위로 같다**(렌더 경로가 갈리면 파일에서만 밀린다)",
      saved && saved.ok === true && jInk > 50 && jDiff && jDiff.diff === 0,
      `프리뷰잉크=${jInk} 저장잉크=${jDiff && jDiff.ink} 불일치=${jDiff && jDiff.diff}`,
    );
    if (!r.check("(j-0) 재오픈", (await openEditor()) === true)) return;
    await cdp.eval(`window.__gpv.imageEditor.setToggle('snap', false)`);

    // (j-2) 외곽선 정렬 — 글리프 밖으로 나가는 양으로 잰다(경계 1px 을 직접 집으면
    // 폰트 힌팅에 따라 흔들린다).
    const outlineBox = async (patch) => {
      await setDoc({
        objects: [text("to", 30, 40, "가", { fontSize: 60, ...patch })],
      });
      return S(`inkBounds([10, 20, 180, 120])`);
    };
    const oPlain = await outlineBox({ strokeWidth: 0 });
    const oOut = await outlineBox({
      strokes: [{ type: "solid", color: "#0E0E10", opacity: 1, visible: true, blend: "normal" }],
      fills: [{ type: "solid", color: "#FF3B30", opacity: 1, visible: true, blend: "normal" }],
      strokeWidth: 6, strokeAlign: "outside",
    });
    const oCenter = await outlineBox({
      strokes: [{ type: "solid", color: "#0E0E10", opacity: 1, visible: true, blend: "normal" }],
      fills: [{ type: "solid", color: "#FF3B30", opacity: 1, visible: true, blend: "normal" }],
      strokeWidth: 6, strokeAlign: "center",
    });
    r.check(
      "(j-2) 텍스트 외곽선 정렬이 결과에 남는다(`바깥` 은 글리프 밖으로 w · `가운데` 는 w/2)",
      !!oPlain && !!oOut && !!oCenter &&
        Math.abs(oPlain.x0 - oOut.x0 - 6) <= 2 &&
        Math.abs(oPlain.x0 - oCenter.x0 - 3) <= 2,
      `없음 x0=${oPlain && oPlain.x0} 바깥 x0=${oOut && oOut.x0} 가운데 x0=${oCenter && oCenter.x0}`,
    );

    // ── (k) DOM 미러 대조 ────────────────────────────────────────────────────
    const hasCss = await cdp.eval(
      `typeof window.__gpv.imageEditor.textCss === 'function'`,
    );
    if (!hasCss) {
      r.skip(
        "(k) 미러 대조(캔버스 열 vs DOM 열)",
        "`__gpv.imageEditor.textCss(id)` 훅 미노출(49 §4 e2e 훅) — 편집기 밖에서 DOM 열을 만들 방법이 없다",
      );
    } else {
      const samples = [
        ["한글 공백 문장", "가나다 라마바 사아자", { w: 110 }],
        ["영문 장토큰", "abcdefghijklmnopqrst", { w: 90 }],
        ["혼합", "가나 abc 다라 def", { w: 110 }],
        ["목록", "가나다 라마바", { w: 110, list: "bullet" }],
        ["양쪽정렬", "aa bb cc dd ee", { w: 110, align: "justify" }],
        ["문단+들여쓰기", "가나다 라마바\n사아자 차카타", { w: 110, paragraphSpacing: 8, indent: 10 }],
      ];
      const bad = [];
      for (const [label, body, patch] of samples) {
        await setDoc({
          objects: [
            text("tk", 20, 20, body, { h: 0, resize: "auto-height", fontSize: 18, ...patch }),
          ],
        });
        const lk = await layout("tk");
        const mir = await cdp.eval(`window.__gpvText.mirror('tk', 1)`);
        if (!mir || mir.lines !== lk.lines.length) {
          bad.push(`${label}: 줄 ${mir ? mir.lines : "?"}≠${lk.lines.length}`);
          continue;
        }
        for (let i = 0; i < lk.lines.length; i++) {
          if (Math.abs(mir.rows[i].w - lk.lines[i].width) > 1.5) {
            bad.push(`${label}#${i}: 폭 ${mir.rows[i].w.toFixed(1)}≠${lk.lines[i].width.toFixed(1)}`);
          }
        }
      }
      r.check(
        "(k) 여섯 표본에서 캔버스 열과 DOM 열이 **같은 줄**을 낸다(줄 수·줄 폭 1px 이내)",
        bad.length === 0,
        bad.join(" · "),
      );
    }

    // ── (l)(m) textarea 메트릭 계약 ──────────────────────────────────────────
    await setDoc({
      objects: [text("tl", 40, 50, "가나다 라마바", { w: 90, h: 0, resize: "auto-height", fontSize: 20 })],
    });
    const ll = await layout("tl");
    await cdp.eval(`window.__gpvText.ed().setTool('select')`);
    await S(`dblClick(${Math.round(40 + ll.box.w / 2)}, ${Math.round(50 + ll.lineHeightPx / 2)})`);
    await sleep(300);
    const ta = await S(`taBox()`);
    const s = ta ? ta.fontSize / 20 : 0;
    r.check(
      "(l-1) 편집 오버레이가 캔버스와 **같은 상자·같은 메트릭**을 쓴다(left=x · top=y+contentTop · line-height=layout)",
      !!ta && s > 0 &&
        Math.abs(ta.left - 40 * s) <= 1 &&
        Math.abs(ta.top - (50 + ll.contentTop) * s) <= 1 &&
        Math.abs(ta.lineHeight - ll.lineHeightPx * s) <= 1,
      `${J(ta)} 배율=${s}`,
    );
    r.check(
      "(l-2) 피벗 보정(half-leading 빼기)이 사라졌다 — 라인박스 공식이 두 열을 함께 정의한다",
      !!ta && /^0px 0px$/.test(ta.origin || "") &&
        /pre-wrap|pre/.test(ta.wrap || "") && /keep-all/.test(ta.brk || ""),
      `origin=${ta && ta.origin} wrap=${ta && ta.wrap} break=${ta && ta.brk}`,
    );
    await S(`esc()`);
    await sleep(250);

    await setDoc({
      objects: [text("tm", 60, 40, "가나다", { fontSize: 20, rot: 90 })],
    });
    const lm = await layout("tm");
    // 90° 돈 글자의 상자는 앵커에서 아래로 뻗는다 — 앵커 근처를 눌러야 히트한다.
    await S(`dblClick(${Math.round(60 - lm.box.h / 2)}, ${Math.round(40 + lm.box.w / 2)})`);
    await sleep(300);
    const taRot = await S(`taBox()`);
    const sr = taRot ? taRot.fontSize / 20 : 0;
    r.check(
      "(m) 회전한 텍스트도 같은 방향·같은 자리에 편집창이 뜬다(`rotate(90deg)` · 피벗 0,0 · 앵커 좌표)",
      !!taRot && sr > 0 && /rotate\(90deg\)/.test(taRot.transform || "") &&
        /^0px 0px$/.test(taRot.origin || "") &&
        Math.abs(taRot.left - 60 * sr) <= 1 && Math.abs(taRot.top - 40 * sr) <= 1,
      J(taRot),
    );
    await S(`esc()`);
    await sleep(250);

    // ── (n) 타이포 편집 경로 ─────────────────────────────────────────────────
    await setDoc({
      objects: [
        text("n1", 20, 20, "가", { fontSize: 14, styleRefs: { text: "st1" } }),
        text("n2", 20, 60, "나", { fontSize: 28 }),
      ],
    });
    await S(`clickCanvas([[24, 26]])`);
    await sleep(200);
    await cdp.eval(
      `window.__gpvText.ed().actions.patchSelection({ typo: { fontSize: 32 } }, '크기 32')`,
    );
    await sleep(250);
    const patched = await cdp.eval(`(() => {
      const o = window.__gpvText.obj('n1');
      return { fontSize: o.fontSize, refs: Object.keys(o.styleRefs || {}) };
    })()`);
    r.check(
      "(n) 타이포 편집은 `applyPaintPatch({typo})` 한 경로를 지나고, 직접 바꾼 값은 스타일 참조를 **떼어 낸다**",
      patched.fontSize === 32 && !patched.refs.includes("text"),
      J(patched),
    );
    const hasMixed = await cdp.eval(
      `typeof window.__gpv.imageEditor.mixedTextStyle === 'function'`,
    );
    if (!hasMixed) {
      r.skip(
        "(n-2) `mixedTextStyle` MIXED 판정",
        "훅 미노출(49 §4) — 인스펙터 텍스트 탭은 50 소유라 화면으로도 못 읽는다",
      );
    }

    // ── (o) Mac 폴백 경로 ────────────────────────────────────────────────────
    await setDoc({
      objects: [
        text("to2", 20, 20, "가나다 abc", { w: 150, h: 0, resize: "auto-height", fontSize: 20 }),
      ],
    });
    const native = await layout("to2");
    const fb = await layout("to2", { fallback: true });
    const worst = Math.max(
      ...native.lines.map((l, i) => Math.abs(l.width - (fb.lines[i] ? fb.lines[i].width : 1e9))),
    );
    r.check(
      "(o) `letterSpacing` 없는 엔진(WKWebView) 폴백이 네이티브와 같은 줄 폭을 낸다 — Mac 에서만 도는 코드라 여기서 안 재면 죽은 줄도 모른다",
      fb.lines.length === native.lines.length && worst <= 1.5,
      `줄=${fb.lines.length}/${native.lines.length} 최대 폭차=${worst.toFixed(2)}`,
    );
  } finally {
    if (snap0 !== null) {
      await cdp
        .eval(`window.__gpv.imageEditor && window.__gpv.imageEditor.setToggle('snap', ${J(snap0)})`)
        .catch(() => {});
    }
    await closeEditor().catch(() => {});
    await sleep(200);
    for (const rel of created) {
      await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: rel });
      const p = join(fix.repo, rel);
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* 픽스처 정리는 best-effort */
      }
    }
  }
}
