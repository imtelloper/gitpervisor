// 벡터 패스(46)와 크롭 프로 모드(48) — DOCS/task/46-image-vector-path.md §7 ·
// DOCS/task/48-image-crop-straighten.md §7.
//
// 이 스위트가 지키는 계약 넷:
//   ① **패스는 그려지고·집히고·변환된다.** `drawObject` switch 에 default 가 없다는 것은
//      path 케이스를 빠뜨려도 컴파일이 통과한다는 뜻이다 — 그때 패스는 **조용히 안 그려진다**.
//      예외도 로그도 없으므로 픽셀로만 잡힌다. 히트·bbox·회전/반전도 같은 종류의 침묵이다.
//   ② **불리언은 결과 하나를 남기고 피연산자를 지운다.** 네 연산이 각자 다른 영역을 남기는지를
//      "겹침·A전용·B전용" 세 점으로 잰다. 세 점 중 하나만 재면 합집합과 제외가 구분되지 않는다.
//      되돌리기는 **한 번**이어야 한다(41 의 200칸을 연산 하나가 갉아먹지 않는다).
//   ③ **크롭 세션은 히스토리를 쓰지 않는다.** 핸들·비율·직선화를 몇 번을 만져도 `replace` 라
//      스택이 그대로고, 적용은 정확히 한 칸, 취소는 진입 시점 문서로 **정확히** 돌아온다.
//      직선화 슬라이더를 왕복해도 주석 좌표가 밀리지 않는다(누적 델타 금지 — INDEX §10.4).
//   ④ **θ=0 이면 종전과 같은 픽셀이다.** 직선화 배관이 `buildOriented` 안쪽에 들어갔으므로
//      각도가 0 인 문서는 옛 경로와 비트 동일해야 한다 — 아니면 30/34/35 가 통째로 흔들린다.
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 이고, 맞춤 배율이 1이라 맞춤 == 100% 다
// (30·36·37·40 스위트와 같은 전제). 스냅은 이 스위트 내내 꺼 둔다 — 켜져 있으면 좌표를 재는
// 단언이 1px 씩 어긋난다(40 §7 과 같은 이유).
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "이미지 벡터·크롭 (패스 렌더·히트·변환 / 불리언 4·평탄화·윤곽선화·분리 / 크롭 8핸들·비율·직선화·여백 제거)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const HELPERS = `(() => {
  const A = {};
  window.__gpvVec = A;

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
  A.ui = () => A.ed().getUi();
  A.hist = () => A.ed().history.entries().length;
  A.lastLabel = () => {
    const e = A.ed().history.entries();
    return e.length ? e[0].label : null;
  };
  A.focusRoot = () => {
    const m = A.modal();
    if (m) m.focus();
    return document.activeElement === m;
  };

  /** 문서를 넣고 **실제로 그려질 때까지** 기다린다 — 픽셀 단언은 그 뒤에만 뜻이 있다. */
  A.setDoc = async (patch) => {
    A.ed().setDoc(patch);
    await A.frame();
    A.ed().renderOnce();
    await A.frame();
    return true;
  };
  A.repaint = async () => {
    A.ed().renderOnce();
    await A.frame();
    await A.frame();
    return true;
  };

  /** 백킹 px 좌표의 픽셀 [r,g,b,a]. i=0 커밋 캐시, i=1 씬(원본까지 합쳐진 그림). */
  A.px = (i, x, y) => {
    const c = A.canvases()[i];
    if (!c) return null;
    const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  /** 씬 캔버스 전체의 dataURL — '비트 동일' 을 파일 저장 없이 재는 지문. */
  A.sceneUrl = () => {
    const c = A.canvases()[1];
    return c ? c.toDataURL('image/png') : null;
  };
  /**
   * **내보내기 렌더 경로**(39 renderRegion)로 뽑은 한 점. 씬 캔버스와 값이 같아야 '화면 == 파일'
   * 이다 — 저장은 편집기를 닫으므로, 케이스마다 파일을 쓰지 않고 이 경로로 대조한다.
   */
  A.renderPx = (x, y) => {
    const r = A.ed().renderRegion({ x: x, y: y, w: 1, h: 1 }, 1);
    return r ? r.data.slice(0, 4) : null;
  };

  /**
   * 잉크 마스크 — 색이 아니라 **흰색이 아님**으로 잉크를 정의한다. 도형→패스 변환은 색이
   * 아니라 모양이 같아야 하는 것이라, 경계 안티앨리어스까지 잉크로 세야 1px 판정이 성립한다.
   */
  A.inkOf = (box) => {
    const c = A.canvases()[1];
    const d = c.getContext('2d').getImageData(box[0], box[1], box[2], box[3]).data;
    const m = new Uint8Array(box[2] * box[3]);
    for (let i = 0; i < m.length; i++) {
      const o = i * 4;
      m[i] = d[o] < 240 || d[o + 1] < 240 || d[o + 2] < 240 ? 1 : 0;
    }
    return { w: box[2], h: box[3], m: m };
  };
  A.inkSnap = (box) => {
    A._ink = A.inkOf(box);
    return A._ink.m.reduce((a, b) => a + b, 0);
  };
  /** 한쪽에만 있으면서 상대의 3×3 이웃에도 없는 픽셀 수 = '1px 초과로 어긋난 잉크'. */
  A.inkDiffNow = (box) => {
    const b = A.inkOf(box);
    const a = A._ink;
    if (!a || a.w !== b.w || a.h !== b.h) return -1;
    const miss = (p, q) => {
      let n = 0;
      for (let y = 0; y < p.h; y++) {
        for (let x = 0; x < p.w; x++) {
          if (!p.m[y * p.w + x]) continue;
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < q.w && ny < q.h && q.m[ny * q.w + nx]) {
                near = true;
                break;
              }
            }
          }
          if (!near) n++;
        }
      }
      return n;
    };
    return Math.max(miss(a, b), miss(b, a));
  };

  /** 키 이벤트 — window capture 리스너(42)가 받는다. 소비 여부까지 함께 돌려준다. */
  A.installProbe = () => {
    if (A._probeOn) return true;
    A._n = 0;
    A._h = () => { A._n++; };
    window.addEventListener('keydown', A._h);
    A._probeOn = true;
    return true;
  };
  A.removeProbe = () => {
    if (A._probeOn) window.removeEventListener('keydown', A._h);
    A._probeOn = false;
    return true;
  };
  A.fire = async (init) => {
    A._n = 0;
    const ev = new KeyboardEvent(
      'keydown',
      Object.assign({ bubbles: true, cancelable: true }, init),
    );
    window.dispatchEvent(ev);
    await A.frame();
    await A.frame();
    return { hits: A._n, prevented: ev.defaultPrevented };
  };
  A.selectAll = () => A.fire({ key: 'a', code: 'KeyA', ctrlKey: true });

  /** 합성 포인터 시퀀스(백킹 px). 실제 포인터가 없으면 setPointerCapture 가 던진다 — 무해화. */
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
            shiftKey: !!(opts && opts.shift), altKey: !!(opts && opts.alt),
            pointerId: 1900, pointerType: 'mouse', isPrimary: true,
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

  /** 선택 개수 — 상태바 문구(30·40 과 같은 규칙: 문구를 담은 가장 안쪽 요소). */
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
  A.statusText = () => {
    const m = A.modal();
    if (!m) return '';
    for (const el of Array.from(m.querySelectorAll('span'))) {
      if (/^실행 취소 \\d+단계$/.test((el.textContent || '').trim())) {
        return (el.parentElement.textContent || '').trim();
      }
    }
    return '';
  };

  // ── 저장본 ────────────────────────────────────────────────────────────────
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
    // 같은 이름으로 두 번째 저장이면 앱이 '덮어쓰기' 확인창을 띄운다(ImageEditor.tsx:1507).
    // 답하지 않으면 **저장이 일어나지 않은 채** 확인창이 useUi 에 남고, closeImageEditor 도
    // confirm 을 지우지 않아 다음 스위트까지 새어 간다 → useEditorKeys 게이트 ①(blocked)이
    // 편집기 키를 통째로 통과시켜 스위트 40 이 무더기로 깨진다.
    let overwrote = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = window.__gpv.ui.getState();
      if (s.confirm) {
        overwrote = true;
        s.confirm.onConfirm();
        s.closeConfirm();
        break;
      }
      if (!s.imageEditorPath) break; // 저장 성공 → 편집기가 닫혔다
    }
    return { ok: true, overwrote };
  };
  A.readSaved = async (projectId, relPath, points, color, tol) => {
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
    const out = { w: c.width, h: c.height, px: [] };
    for (const p of points || []) {
      const d = ctx.getImageData(p[0], p[1], 1, 1).data;
      out.px.push([d[0], d[1], d[2], d[3]]);
    }
    if (color) {
      const t = tol == null ? 12 : tol;
      const all = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < all.length; i += 4) {
        if (
          Math.abs(all[i] - color[0]) <= t &&
          Math.abs(all[i + 1] - color[1]) <= t &&
          Math.abs(all[i + 2] - color[2]) <= t &&
          all[i + 3] > 200
        ) n++;
      }
      out.match = n;
    }
    return out;
  };

  // ── 인스펙터 · 스트립 · 컨텍스트 바 ───────────────────────────────────────
  A.tabPanel = (id) => {
    const m = A.modal();
    return m ? m.querySelector('[data-inspector-tab="' + (id || A.ed().inspector.tab()) + '"]') : null;
  };
  /** 섹션은 헤더 **문구**로 집는다(클래스 선택자는 스타일이 바뀌면 조용히 못 찾는다). */
  A.sectionTitles = () => {
    const p = A.tabPanel();
    if (!p) return [];
    return Array.from(p.querySelectorAll('section'))
      .map((s) => (s.firstElementChild ? (s.firstElementChild.textContent || '').trim() : ''))
      .filter((t) => t !== '');
  };
  A.input = (label, root) => {
    const p = root || A.tabPanel();
    return p ? p.querySelector('input[aria-label="' + label + '"]') : null;
  };
  A.setValue = (el, text) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  A.typeField = async (label, text, root) => {
    const el = A.input(label, root);
    if (!el) return false;
    el.focus();
    A.setValue(el, text);
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
    );
    await A.frame();
    await A.frame();
    return true;
  };
  /** 인스펙터 버튼(패스 연산·채우기 없음) — 문구로 집는다. */
  A.clickPanelBtn = async (re) => {
    const p = A.tabPanel();
    const b = p
      ? Array.from(p.querySelectorAll('button')).find((x) =>
          re.test((x.textContent || '') + ' ' + (x.getAttribute('title') || '')),
        )
      : null;
    if (!b || b.disabled) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };
  /** 45 의 Toggle 은 role=checkbox 버튼이고 라벨이 곧 글자다. */
  A.clickToggle = async (label, root) => {
    const p = root || A.tabPanel();
    const b = p
      ? Array.from(p.querySelectorAll('[role="checkbox"]')).find(
          (x) => (x.textContent || '').trim() === label,
        )
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };

  A.strip = () => {
    const m = A.modal();
    return m ? m.querySelector('[data-boolean-preview]') : null;
  };
  A.stripCells = () => {
    const s = A.strip();
    return s ? s.querySelectorAll('canvas').length : 0;
  };
  A.clickStrip = async (label) => {
    const s = A.strip();
    const b = s
      ? Array.from(s.querySelectorAll('button')).find(
          (x) => (x.getAttribute('title') || '').trim() === label,
        )
      : null;
    if (!b || b.disabled) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };

  /** 컨텍스트 바 — 레일도 role=toolbar 라 aria-label '도구' 만 걸러 낸다. */
  A.bar = () => {
    const m = A.modal();
    if (!m) return null;
    return (
      Array.from(m.querySelectorAll('[role="toolbar"]')).find(
        (el) => (el.getAttribute('aria-label') || '') !== '도구',
      ) || null
    );
  };
  A.barTitles = () => {
    const b = A.bar();
    if (!b) return [];
    return Array.from(b.querySelectorAll('button'))
      .map((x) => (x.getAttribute('title') || '').trim())
      .filter((t) => t !== '');
  };
  A.barText = () => {
    const b = A.bar();
    return b ? (b.textContent || '').trim() : '';
  };
  A.barRange = () => {
    const b = A.bar();
    return b ? b.querySelector('input[type="range"][aria-label="직선화"]') : null;
  };

  // ── 화면 크롬(43) ─────────────────────────────────────────────────────────
  A.chromeRoot = () => {
    const m = A.modal();
    const g = m ? m.querySelector('[data-chrome="pixel-grid"]') : null;
    return g ? g.parentElement : null;
  };
  A.svg = () => {
    const r = A.chromeRoot();
    return r ? r.querySelector('svg') : null;
  };
  A.chromeN = (sel) => {
    const s = A.svg();
    return s ? s.querySelectorAll(sel).length : -1;
  };

  A.solidPng = (w, h, css, inner) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    if (inner) {
      x.fillStyle = inner[4];
      x.fillRect(inner[0], inner[1], inner[2], inner[3]);
    }
    return c.toDataURL('image/png').split(',')[1];
  };

  /** 키 순서를 정규화한 딥이퀄 지문(37 스위트와 같은 방식). */
  A.key = (v) =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort())
        : x,
    );
  A.docKey = () => A.key(A.doc());

  return true;
})()`;

// ── 문서 리터럴(경계 normalizeDoc 이 v2 로 채운다) ───────────────────────────
const RED = "#FF0000";
const BLUE = "#0000FF";
const solid = (hex) => ({ type: "solid", color: hex, opacity: 1, visible: true, blend: "normal" });
const V = (x, y, o) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner", ...(o || {}) });
const boxVerts = (x, y, w, h) => [V(x, y), V(x + w, y), V(x + w, y + h), V(x, y + h)];
const pathNode = (id, subpaths, extra) => ({
  id, kind: "path", subpaths, fillRule: "nonzero",
  fills: [], strokes: [], strokeWidth: 0, ...(extra || {}),
});
const rectNode = (id, x, y, w, h, extra) => ({
  id, kind: "rect", x, y, w, h, radius: 0,
  fills: [solid(RED)], strokes: [], strokeWidth: 0, ...(extra || {}),
});

const near = (p, rgb, tol = 12) =>
  Array.isArray(p) &&
  Math.abs(p[0] - rgb[0]) <= tol &&
  Math.abs(p[1] - rgb[1]) <= tol &&
  Math.abs(p[2] - rgb[2]) <= tol &&
  p[3] > 200;
const isWhite = (p) => near(p, [255, 255, 255], 6);
const show = (p) => (Array.isArray(p) ? `rgba(${p.join(",")})` : String(p));

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 벡터·크롭", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-vec.png";
  /** 20px 흰 여백 + 빨강 중심 — 여백 자동 제거의 유일한 근거 픽스처. */
  const TRIM = "e2e-vec-trim.png";
  const OUT = "e2e-vec-out.png";
  const created = [SRC, TRIM, OUT];

  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const S = (expr) => cdp.eval(`window.__gpvVec.${expr}`);
  const setDoc = (patch) => cdp.eval(`window.__gpvVec.setDoc(${J(patch)})`);
  const px = (x, y) => S(`px(1, ${x}, ${y})`);
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
  const vec = (op, ids) =>
    cdp.eval(`window.__gpvVec.ed().vector.op(${J(op)}${ids ? `, ${J(ids)}` : ""})`);
  const can = (op, ids) =>
    cdp.eval(`window.__gpvVec.ed().vector.can(${J(op)}${ids ? `, ${J(ids)}` : ""})`);
  const objects = () => cdp.eval(`window.__gpvVec.doc().objects`);
  const crop = (method, arg) =>
    cdp.eval(
      `window.__gpvVec.ed().crop.${method}(${arg === undefined ? "" : J(arg)})`,
    ).catch(() => null);
  const session = () => cdp.eval(`window.__gpvVec.ed().cropSession()`);
  const enterCrop = async () => {
    await cdp.eval(`window.__gpvVec.ed().setMode({ kind: 'crop' })`);
    return poll(() => session().catch(() => null), (v) => v !== null, 20, 100);
  };

  let snap0 = null;

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const white = await cdp.eval(`window.__gpvVec.solidPng(200, 200, '#ffffff')`);
    const trim = await cdp.eval(
      `window.__gpvVec.solidPng(200, 200, '#ffffff', [20, 20, 160, 160, '#FF0000'])`,
    );
    const made = await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: white, overwrite: true,
    });
    await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: TRIM, base64: trim, overwrite: true,
    });
    if (!r.check("픽스처 PNG 2장 생성(200×200 흰색 · 여백 20px)", made.ok && existsSync(join(fix.repo, SRC)))) {
      return;
    }
    if (!r.check("편집기 열림", (await openEditor()) === true)) return;

    // 스냅이 켜져 있으면 드래그·핸들 좌표를 재는 단언이 통째로 어긋난다. 사용자 취향이라
    // localStorage 에 영속되므로 명시적으로 끄고 finally 에서 되돌린다(30·40 과 같은 규칙).
    snap0 = await S(`ui().toggles.snap`);
    await cdp.eval(`window.__gpvVec.ed().setToggle('snap', false)`);
    await S(`installProbe()`);

    const hasVector = await cdp.eval(`!!(window.__gpv.imageEditor.vector)`);
    const hasCrop = await cdp.eval(`!!(window.__gpv.imageEditor.crop)`);

    // ══ 46 패스 ══════════════════════════════════════════════════════════════
    if (!hasVector) {
      r.skip("(46) 벡터 패스", "`__gpv.imageEditor.vector` 훅 미노출 — 태스크 46 미착지");
    } else {
      // ── (a) 렌더: 3차 곡선을 가진 닫힌 패스 ────────────────────────────────
      // 윗변만 위로 부푼 사각형. 부푼 꼭대기는 y = 40 − 0.75·40 = 10 이다(3차 최대 편차).
      const bulge = pathNode(
        "pa",
        [
          {
            verts: [
              V(40, 40, { outX: 30, outY: -40 }),
              V(160, 40, { inX: -30, inY: -40 }),
              V(160, 160),
              V(40, 160),
            ],
            closed: true,
          },
        ],
        { fills: [solid(RED)] },
      );
      await setDoc({ objects: [bulge] });
      const aIn = await px(100, 100);
      const aBulge = await px(100, 25);
      const aOut = await px(100, 5);
      const aFile = await cdp.eval(`[
        window.__gpvVec.renderPx(100, 100),
        window.__gpvVec.renderPx(100, 25),
        window.__gpvVec.renderPx(100, 5),
      ]`);
      r.check(
        "(46 a-1) `path` 가 **실제로 그려진다** — `drawObject` switch 에 default 가 없어 케이스를 빠뜨려도 컴파일은 통과한다(조용한 미렌더)",
        near(aIn, [255, 0, 0]),
        show(aIn),
      );
      r.check(
        "(46 a-2) 3차 곡선이 제어점이 아니라 **곡선대로** 채워진다(부푼 안쪽 빨강 · 바깥 흰색)",
        near(aBulge, [255, 0, 0]) && isWhite(aOut),
        `안=${show(aBulge)} 밖=${show(aOut)}`,
      );
      r.check(
        "(46 a-3) 내보내기 렌더가 같은 좌표에서 같은 색이다(WYSIWYG — 프리뷰만 맞는 경로가 생기면 저장에서 드러난다)",
        near(aFile[0], [255, 0, 0]) && near(aFile[1], [255, 0, 0]) && isWhite(aFile[2]),
        aFile.map(show).join(" "),
      );

      // ── (b) fillRule ───────────────────────────────────────────────────────
      const nested = (rule) =>
        pathNode(
          "pb",
          [
            { verts: boxVerts(40, 40, 120, 120), closed: true },
            { verts: boxVerts(70, 70, 60, 60), closed: true },
          ],
          { fills: [solid(RED)], fillRule: rule },
        );
      await setDoc({ objects: [nested("evenodd")] });
      const bEven = await px(100, 100);
      const bRing = await px(50, 100);
      await setDoc({ objects: [nested("nonzero")] });
      const bNon = await px(100, 100);
      r.check(
        "(46 b) 같은 방향 중첩 서브패스가 `짝수-홀수` 에서는 뚫리고 `논제로` 에서는 채워진다",
        isWhite(bEven) && near(bRing, [255, 0, 0]) && near(bNon, [255, 0, 0]),
        `evenodd 중심=${show(bEven)} 고리=${show(bRing)} nonzero 중심=${show(bNon)}`,
      );

      // ── (c) 대시·캡·히트 ───────────────────────────────────────────────────
      const dashed = pathNode(
        "pc",
        [{ verts: [V(0, 100), V(200, 100)], closed: false }],
        { strokes: [solid(BLUE)], strokeWidth: 10, dash: [8, 4], cap: "butt" },
      );
      await setDoc({ objects: [dashed] });
      const cOn = await px(4, 100);
      const cGap = await px(10, 100);
      await cdp.eval(`window.__gpvVec.ed().setTool('select')`);
      await S(`clickCanvas([[10, 100]])`);
      await sleep(150);
      const cSel = await S(`selCount()`);
      r.check(
        "(46 c-1) 대시가 문서 값대로 그려진다(x=4 선색 · x=10 간격은 흰색)",
        near(cOn, [0, 0, 255]) && isWhite(cGap),
        `채움=${show(cOn)} 간격=${show(cGap)}`,
      );
      r.check(
        "(46 c-2) 히트는 대시를 무시한다 — 간격을 눌러도 잡힌다(Figma 동일)",
        cSel === 1,
        `선택=${cSel}`,
      );

      // ── (d) 선 정렬 ────────────────────────────────────────────────────────
      const bandAt = async (align) => {
        await setDoc({
          objects: [
            pathNode("pd", [{ verts: boxVerts(60, 60, 80, 80), closed: true }], {
              strokes: [solid(BLUE)], strokeWidth: 10, strokeAlign: align, join: "miter",
            }),
          ],
        });
        return { out: await px(57, 100), in: await px(63, 100) };
      };
      const dIn = await bandAt("inside");
      const dOut = await bandAt("outside");
      const dMid = await bandAt("center");
      r.check(
        "(46 d) 닫힌 패스의 선 정렬 셋이 각자 다른 띠를 만든다(안쪽 · 바깥 · 가운데)",
        isWhite(dIn.out) && near(dIn.in, [0, 0, 255]) &&
          near(dOut.out, [0, 0, 255]) && isWhite(dOut.in) &&
          near(dMid.out, [0, 0, 255]) && near(dMid.in, [0, 0, 255]),
        `inside=${show(dIn.out)}/${show(dIn.in)} outside=${show(dOut.out)}/${show(dOut.in)} center=${show(dMid.out)}/${show(dMid.in)}`,
      );

      // ── (e) 화살촉 — 열린 패스의 끝 접선 ───────────────────────────────────
      await setDoc({
        objects: [
          pathNode("pe", [{ verts: [V(40, 100), V(160, 100)], closed: false }], {
            strokes: [solid(BLUE)], strokeWidth: 6, heads: { start: "none", end: "arrow" },
          }),
        ],
      });
      // 머리 길이 = 4·w = 24, 좌우 π/7. 끝에서 15px 뒤의 반폭 ≈ 7.2px 이므로 (145,105)는
      // 머리 안이고 선 띠(반폭 3) 밖이다 — 이 한 점이 '머리가 그려졌는가' 를 홀로 가른다.
      const eHead = await px(145, 105);
      const eBefore = await px(125, 105);
      r.check(
        "(46 e) `heads.end` 가 열린 패스의 **끝 접선** 방향으로 화살촉을 그린다(지시선 벡터)",
        near(eHead, [0, 0, 255]) && isWhite(eBefore),
        `머리=${show(eHead)} 머리앞=${show(eBefore)}`,
      );

      // ── (f) 변환: 정점과 핸들이 함께 돈다 ──────────────────────────────────
      const tf = pathNode("pf", [
        { verts: [V(50, 30, { outX: 10, outY: 4 }), V(120, 60)], closed: false },
      ], { strokes: [solid(BLUE)], strokeWidth: 2 });
      await setDoc({ objects: [tf], rotation: 0, flipH: false, flipV: false });
      await cdp.eval(`window.__gpvVec.ed().actions.rotateImage(true)`);
      await sleep(250);
      const fRot = await cdp.eval(`(() => {
        const v = window.__gpvVec.doc().objects[0].subpaths[0].verts[0];
        return { x: v.x, y: v.y, outX: v.outX, outY: v.outY };
      })()`);
      r.check(
        "(46 f-1) 90° 회전이 정점 `(x,y)→(h−y,x)` 과 **상대 핸들** `(dx,dy)→(−dy,dx)` 를 함께 옮긴다",
        Math.abs(fRot.x - (200 - 30)) < 0.01 && Math.abs(fRot.y - 50) < 0.01 &&
          Math.abs(fRot.outX - -4) < 0.01 && Math.abs(fRot.outY - 10) < 0.01,
        J(fRot),
      );
      await setDoc({ objects: [{ ...tf, rot: 20 }], rotation: 0, flipH: false, flipV: false });
      await cdp.eval(`window.__gpvVec.ed().actions.flipImage('h')`);
      await sleep(250);
      const fFlip = await cdp.eval(`window.__gpvVec.doc().objects[0].rot`);
      await setDoc({ objects: [tf], rotation: 0, flipH: false, flipV: false });
      await cdp.eval(`window.__gpvVec.ed().tree.translate(['pf'], 7, -3)`);
      await sleep(200);
      const fMove = await cdp.eval(`(() => {
        const v = window.__gpvVec.doc().objects[0].subpaths[0].verts[0];
        return { x: v.x, y: v.y, outX: v.outX, outY: v.outY };
      })()`);
      r.check(
        "(46 f-2) 반전은 `rot → −rot`(mod 360 정규화 표기) 이고, 평행이동은 앵커만 옮긴다(핸들은 상대 좌표라 불변)",
        // transformObjects 는 normalizeDeg(-rot) 로 [0,360) 에 넣는다(geometry.ts:508) —
        // −20 과 340 은 같은 각이고 화면·왕복 모두 구분되지 않으므로 나머지로 비교한다.
        // 리터럴 −20 을 요구하면 표기만 다른 정상 코드를 회귀로 오진한다.
        Math.abs((((fFlip + 20) % 360) + 360) % 360) < 0.01 &&
          Math.abs(fMove.x - 57) < 0.01 && Math.abs(fMove.y - 27) < 0.01 &&
          fMove.outX === 10 && fMove.outY === 4,
        `flip rot=${fFlip} 이동=${J(fMove)}`,
      );

      // ── (g)(h) bbox = 3차 극값 ─────────────────────────────────────────────
      // M(20,150) C(20,50)(120,50)(120,150) — 곡선의 극값은 y=75, 제어점 헐이면 50 이다.
      await setDoc({
        rotation: 0, flipH: false, flipV: false,
        objects: [
          pathNode("pg", [
            {
              verts: [
                V(20, 150, { outX: 0, outY: -100 }),
                V(120, 150, { inX: 0, inY: -100 }),
              ],
              closed: false,
            },
          ], { strokes: [solid(BLUE)], strokeWidth: 0 }),
        ],
      });
      const gBox = await cdp.eval(`window.__gpvVec.ed().tree.nodeAABB('pg')`);
      r.check(
        "(46 g) bbox 가 **3차 극값**이다 — 제어점 헐(y=50)이면 상자가 곡선보다 25px 크다",
        !!gBox && Math.abs(gBox.y - 75) < 0.01 && Math.abs(gBox.h - 75) < 0.01,
        J(gBox),
      );
      await S(`selectAll()`);
      await sleep(200);
      const gSel = await cdp.eval(`(() => {
        const s = window.__gpvVec.ed().chrome.state();
        const b = s && s.selection[0] ? s.selection[0].box.rect : null;
        return b;
      })()`);
      r.check(
        "(46 h) 선택 상자·회전 핸들이 그 bbox 위에 선다(화면 크롬 == 기하)",
        !!gSel && Math.abs(gSel.y - gBox.y) <= 0.5 && Math.abs(gSel.h - gBox.h) <= 0.5 &&
          Math.abs(gSel.x - gBox.x) <= 0.5 && Math.abs(gSel.w - gBox.w) <= 0.5,
        `크롬=${J(gSel)} 기하=${J(gBox)}`,
      );

      // ── (h-2) 마이터 조인의 뾰족 끝이 상자 안에 있는가(§3.3 선 여백) ────────
      //
      // `pathBounds` 는 **기하만** 잰다 — 선이 기하 밖으로 나가는 양은 `objectBBox` 가 더한다.
      // 그 여백이 선 반폭뿐이면 예각 마이터가 상자 밖으로 튀어나오고, 선택 상자·정렬·스냅·
      // `selectBox` 줌이 전부 이 상자를 쓰므로 **보이는 것과 다른 자리에** 붙는다. 잉크는 있는데
      // 상자만 작은 종류라 화면에는 "선택 테두리가 도형을 파고든다"로만 나타난다.
      //
      // 픽스처: 꼭짓점 (100,100) 에서 (160,60)·(160,140) 으로 벌어진 V. 끼인각
      // θ = 2·atan(40/60) = 67.38° 이므로 마이터 돌출은 (w/2)/sin(θ/2) = 15/0.5547 = 27.04 —
      // 즉 뾰족 끝은 x = 72.96 이고, 선 반폭만 더하던 옛 값(x = 85)보다 **12px 더 왼쪽**이다.
      // 비율 1.803 ≤ miterLimit 4 라 캔버스가 bevel 로 자르지도 않는다(자르면 잉크가 사라져
      // 이 케이스가 무의미해진다 — 그래서 miterLimit 을 픽스처에 명시한다).
      await setDoc({
        rotation: 0, flipH: false, flipV: false,
        objects: [
          pathNode("pm", [
            { verts: [V(160, 60), V(100, 100), V(160, 140)], closed: false },
          ], {
            strokes: [solid(BLUE)], strokeWidth: 30, join: "miter", miterLimit: 4,
          }),
        ],
      });
      const mBox = await cdp.eval(`window.__gpvVec.ed().tree.nodeAABB('pm')`);
      // x=78 은 뾰족 끝(72.96) 안쪽 5px · 옛 상자 경계(85) 바깥 7px — 이 한 점이 "마이터가
      // 실제로 그려졌고 옛 여백으로는 못 담는다"를 홀로 가른다. x=66 은 끝보다 7px 더 왼쪽이다.
      const mTip = await px(78, 100);
      const mOut = await px(66, 100);
      await S(`selectAll()`);
      await sleep(200);
      const mSel = await cdp.eval(`(() => {
        const s = window.__gpvVec.ed().chrome.state();
        const b = s && s.selection[0] ? s.selection[0].box.rect : null;
        return b;
      })()`);
      r.check(
        "(46 h-2) 마이터 조인의 **뾰족 끝까지** 상자가 감싼다 — 선 여백이 반폭뿐이면 잉크가 상자 밖에 남아 선택 테두리가 도형을 파고든다. 상한은 설계가 정한 `w/2·miterLimit`(둔각에서 과대해지는 대가로 어떤 각도에서도 모자라지 않는다)",
        !!mBox && near(mTip, [0, 0, 255]) && isWhite(mOut) &&
          mBox.x <= 73 && mBox.x >= 100 - (30 / 2) * 4 - 0.01 &&
          !!mSel && Math.abs(mSel.x - mBox.x) <= 0.5 && Math.abs(mSel.w - mBox.w) <= 0.5,
        `상자=${J(mBox)} 크롬=${J(mSel)} 끝(78,100)=${show(mTip)} 밖(66,100)=${show(mOut)}`,
      );

      // ── (i) 도형 → 패스: 같은 그림 ─────────────────────────────────────────
      const ell = {
        id: "pi", kind: "ellipse", x: 50, y: 70, w: 100, h: 60,
        fills: [solid(RED)], strokes: [], strokeWidth: 0,
      };
      await setDoc({ objects: [ell] });
      const iInk = await S(`inkSnap([40, 60, 120, 80])`);
      const iPath = await cdp.eval(`window.__gpvVec.ed().vector.toPath('pi')`);
      await setDoc({ objects: [iPath] });
      const iDiff = await S(`inkDiffNow([40, 60, 120, 80])`);
      await setDoc({
        objects: [{ id: "pr", kind: "rect", x: 40, y: 40, w: 100, h: 80, radius: [20, 20, 20, 20], fills: [solid(RED)], strokes: [], strokeWidth: 0 }],
      });
      const rrVerts = await cdp.eval(
        `(() => { const p = window.__gpvVec.ed().vector.toPath('pr'); return p ? p.subpaths[0].verts.length : -1; })()`,
      );
      r.check(
        "(46 i) `toPath` 가 타원을 **같은 잉크**로 옮기고(1px 이내), 둥근 사각형은 모서리당 정점 2개(합 8)를 만든다",
        iPath && iPath.kind === "path" && iDiff >= 0 && iDiff <= 2 && rrVerts === 8,
        `잉크=${iInk} 어긋남=${iDiff} 둥근사각 정점=${rrVerts}`,
      );

      // ── (j) 펜 → 패스 ──────────────────────────────────────────────────────
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        pts.push(30 + t * 140, 100 + Math.sin(t * Math.PI * 2) * 40);
      }
      await setDoc({
        objects: [{ id: "pj", kind: "pen", pts, stroke: BLUE, strokeWidth: 4, cap: "round" }],
      });
      const jInk = await S(`inkSnap([20, 40, 160, 120])`);
      const jPath = await cdp.eval(`window.__gpvVec.ed().vector.toPath('pj')`);
      await setDoc({ objects: [jPath] });
      const jDiff = await S(`inkDiffNow([20, 40, 160, 120])`);
      const jVerts = jPath ? jPath.subpaths.reduce((n, s) => n + s.verts.length, 0) : -1;
      r.check(
        "(46 j) 펜 획이 정점 수 1/3 이하의 베지어로 피팅되고 잉크는 1px 이내로 같다",
        jVerts > 0 && jVerts <= Math.ceil(pts.length / 2 / 3) && jDiff >= 0 && jDiff <= 3,
        `점=${pts.length / 2} 정점=${jVerts} 잉크=${jInk} 어긋남=${jDiff}`,
      );

      // ── (k)(l) 프리셋 도구 ─────────────────────────────────────────────────
      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpvVec.ed().setTool('polygon')`);
      await S(`pointerSeq([['down',40,40],['move',90,90],['move',140,140],['up',140,140]])`);
      await sleep(250);
      const poly = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        if (!o) return null;
        const b = window.__gpvVec.ed().tree.nodeAABB(o.id);
        return { kind: o.kind, n: o.subpaths ? o.subpaths[0].verts.length : -1,
                 closed: o.subpaths ? o.subpaths[0].closed : null, box: b };
      })()`);
      await S(`selectAll()`);
      await cdp.eval(`window.__gpvVec.ed().inspector.setTab('props')`);
      await sleep(250);
      const sides0 = await cdp.eval(
        `(() => { const el = window.__gpvVec.input('변 수'); return el ? el.value : null; })()`,
      );
      await S(`typeField('변 수', '6')`);
      await sleep(250);
      const poly6 = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        const b = window.__gpvVec.ed().tree.nodeAABB(o.id);
        return { n: o.subpaths[0].verts.length, box: b };
      })()`);
      r.check(
        "(46 k) 다각형 도구가 정삼각형 패스를 만들고, `변 수` 6 은 **같은 AABB** 로 다시 만든다",
        poly && poly.kind === "path" && poly.n === 3 && poly.closed === true &&
          sides0 === "3" && poly6.n === 6 &&
          Math.abs(poly6.box.x - poly.box.x) <= 1 && Math.abs(poly6.box.w - poly.box.w) <= 1,
        `3각=${J(poly)} 필드=${sides0} 6각=${J(poly6)}`,
      );

      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpvVec.ed().setTool('callout')`);
      await S(`pointerSeq([['down',40,40],['move',90,80],['move',140,120],['up',140,120]])`);
      await sleep(250);
      // 드래그 상자는 100×80 이라 꼬리 길이 = min(h/2, 24) = 24, 밑변 = min(w/4, 24) = 24.
      // 꼬리 끝점 하나만 아래변 **밖**이고 밑변 두 점은 아래변 위에 있다 — 그 셋이 §3.4 의 꼬리다.
      const callout = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        if (!o || o.kind !== 'path') return null;
        const vs = o.subpaths[0].verts;
        const tip = Math.max.apply(null, vs.map((v) => v.y));
        const edge = Math.max.apply(null, vs.filter((v) => v.y < tip - 0.5).map((v) => v.y));
        return {
          subs: o.subpaths.length,
          below: vs.filter((v) => v.y > edge + 0.5).length,
          tail: Math.round(tip - edge),
          onEdge: vs.filter((v) => Math.abs(v.y - edge) < 0.5).length,
        };
      })()`);
      r.check(
        "(46 l) 말풍선 도구가 서브패스 하나에 **아래변 밖 꼬리**를 붙인다(끝점 1 + 밑변 2 · 길이 min(h/2,24))",
        callout && callout.subs === 1 && callout.below === 1 && callout.tail === 24 &&
          callout.onEdge >= 2,
        J(callout),
      );
      await cdp.eval(`window.__gpvVec.ed().setTool('select')`);

      // ── (m)~(p) 불리언 4연산 ───────────────────────────────────────────────
      const AB = [rectNode("ba", 40, 40, 120, 120), rectNode("bb", 100, 100, 120, 120)];
      const opPixels = async (op) => {
        await setDoc({ objects: AB });
        const ids = await vec(op, ["ba", "bb"]);
        await S(`repaint()`);
        return {
          ids,
          n: (await objects()).length,
          onlyA: await px(50, 50),
          both: await px(120, 120),
          onlyB: await px(180, 180),
        };
      };
      const uni = await opPixels("union");
      const uniShape = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        return { kind: o.kind, subs: o.subpaths.length, verts: o.subpaths[0].verts.length };
      })()`);
      const uniFile = await cdp.eval(`[
        window.__gpvVec.renderPx(50, 50),
        window.__gpvVec.renderPx(120, 120),
        window.__gpvVec.renderPx(180, 180),
      ]`);
      r.check(
        "(46 m) 합집합은 **결과 노드 하나**를 남기고 피연산자를 지운다(서브패스 1 · 정점 ≤10 · 세 영역 전부 채움)",
        uni.n === 1 && uni.ids.length === 1 && uniShape.subs === 1 && uniShape.verts <= 10 &&
          near(uni.onlyA, [255, 0, 0]) && near(uni.both, [255, 0, 0]) && near(uni.onlyB, [255, 0, 0]),
        `객체=${uni.n} ${J(uniShape)} A=${show(uni.onlyA)} 겹침=${show(uni.both)} B=${show(uni.onlyB)}`,
      );
      r.check(
        "(46 m-2) 저장 경로(내보내기 렌더)도 같은 세 점에서 같은 색이다",
        uniFile.every((p) => near(p, [255, 0, 0])),
        uniFile.map(show).join(" "),
      );
      const sub = await opPixels("subtract");
      const int = await opPixels("intersect");
      const exc = await opPixels("exclude");
      r.check(
        "(46 n-1) 차집합은 **아래 도형에서 위를 뺀다**(A 전용만 남는다)",
        near(sub.onlyA, [255, 0, 0]) && isWhite(sub.both) && isWhite(sub.onlyB),
        `A=${show(sub.onlyA)} 겹침=${show(sub.both)} B=${show(sub.onlyB)}`,
      );
      r.check(
        "(46 n-2) 교집합은 겹침만, 제외는 겹침만 뺀다",
        isWhite(int.onlyA) && near(int.both, [255, 0, 0]) && isWhite(int.onlyB) &&
          near(exc.onlyA, [255, 0, 0]) && isWhite(exc.both) && near(exc.onlyB, [255, 0, 0]),
        `교집합 ${show(int.onlyA)}/${show(int.both)}/${show(int.onlyB)} 제외 ${show(exc.onlyA)}/${show(exc.both)}/${show(exc.onlyB)}`,
      );

      // 곡선 피연산자 — 링 재피팅이 원호를 얼마나 지키는가.
      await setDoc({
        objects: [
          { id: "ca", kind: "ellipse", x: 40, y: 60, w: 80, h: 80, fills: [solid(RED)], strokes: [], strokeWidth: 0 },
          rectNode("cb", 100, 100, 60, 60),
        ],
      });
      await vec("union", ["ca", "cb"]);
      await S(`repaint()`);
      const oShape = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        return o.subpaths.reduce((n, s) => n + s.verts.length, 0);
      })()`);
      const oArc = await px(42, 100);
      const oOut = await px(37, 100);
      r.check(
        "(46 o) 곡선 합집합이 원호를 지킨다(정점 ≤24 · 왼쪽 극점 안쪽 채움 · 1px 밖 흰색)",
        oShape <= 24 && near(oArc, [255, 0, 0]) && isWhite(oOut),
        `정점=${oShape} 안=${show(oArc)} 밖=${show(oOut)}`,
      );

      // 스타일·자리·되돌리기.
      await setDoc({
        objects: [
          rectNode("pa1", 40, 40, 60, 60, { fills: [solid(RED)] }),
          rectNode("pa2", 70, 70, 60, 60, { fills: [solid(BLUE)] }),
        ],
      });
      const gid = await cdp.eval(`window.__gpvVec.ed().tree.group(['pa1','pa2'])`);
      await sleep(200);
      const beforeIds = (await objects()).map((o) => o.id);
      const histBefore = await S(`hist()`);
      await vec("union", ["pa1", "pa2"]);
      await sleep(200);
      const pRes = await cdp.eval(`(() => {
        const os = window.__gpvVec.doc().objects;
        const p = os.find((o) => o.kind === 'path');
        return {
          color: p && p.fills[0] ? p.fills[0].color : null,
          parent: p ? p.parentId : null,
          label: window.__gpvVec.lastLabel(),
          hist: window.__gpvVec.hist(),
        };
      })()`);
      await cdp.eval(`window.__gpvVec.fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
      await sleep(250);
      const pUndo = (await objects()).map((o) => o.id);
      r.check(
        "(46 p) 결과는 **z 최상위** 스타일·같은 부모를 물려받고, 되돌리기 **한 번**에 피연산자가 그대로 돌아온다",
        pRes.color === BLUE && pRes.parent === gid && pRes.label === "합집합" &&
          pRes.hist === histBefore + 1 && J(pUndo) === J(beforeIds),
        `색=${pRes.color} 부모=${pRes.parent}/${gid} 라벨=${pRes.label} 칸=${histBefore}→${pRes.hist} 복원=${J(pUndo)}`,
      );

      // ── (q) 게이트 ─────────────────────────────────────────────────────────
      await setDoc({
        objects: [
          rectNode("q1", 20, 20, 40, 40),
          { id: "q2", kind: "text", x: 100, y: 100, text: "가", fontSize: 20, stroke: RED, strokeWidth: 0 },
        ],
      });
      const qText = await can("union", ["q1", "q2"]);
      const qOne = await can("union", ["q1"]);
      const qOk = await cdp.eval(`(() => {
        window.__gpvVec.ed().setDoc({ objects: [] });
        return true;
      })()`);
      await setDoc({ objects: AB });
      const qTwo = await can("union", ["ba", "bb"]);
      r.check(
        "(46 q) 변환할 수 없는 kind 나 1개 선택에서는 불리언이 **잠긴다**(버튼과 키가 같은 판정을 쓴다)",
        qText === false && qOne === false && qTwo === true && qOk === true,
        `텍스트포함=${qText} 1개=${qOne} 2개=${qTwo}`,
      );

      // ── (r) 평탄화 ─────────────────────────────────────────────────────────
      await setDoc({
        objects: [
          rectNode("f1", 20, 20, 40, 40),
          rectNode("f2", 80, 20, 40, 40),
          rectNode("f3", 140, 20, 40, 40),
        ],
      });
      const flatBefore = [];
      for (const p of [[30, 30], [90, 30], [150, 30], [70, 30], [100, 150]]) {
        flatBefore.push(await px(p[0], p[1]));
      }
      await vec("flatten", ["f1", "f2", "f3"]);
      await S(`repaint()`);
      const flatAfter = [];
      for (const p of [[30, 30], [90, 30], [150, 30], [70, 30], [100, 150]]) {
        flatAfter.push(await px(p[0], p[1]));
      }
      const flat = await cdp.eval(`(() => {
        const os = window.__gpvVec.doc().objects;
        return { n: os.length, kind: os[0].kind, subs: os[0].subpaths ? os[0].subpaths.length : -1 };
      })()`);
      r.check(
        "(46 r-1) 평탄화는 서브패스를 **합칠 뿐** 그림을 바꾸지 않는다(객체 1 · 서브패스 3 · 5샘플 동일)",
        flat.n === 1 && flat.kind === "path" && flat.subs === 3 &&
          flatBefore.every((p, i) => near(p, flatAfter[i].slice(0, 3), 4)),
        `${J(flat)} 전=${flatBefore.map(show)} 후=${flatAfter.map(show)}`,
      );
      await setDoc({ objects: [rectNode("one", 40, 40, 60, 60)] });
      await vec("flatten", ["one"]);
      await sleep(200);
      const asPath = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        return { id: o.id, kind: o.kind };
      })()`);
      await setDoc({
        objects: [
          { id: "bg", kind: "badge", x: 100, y: 100, n: 3, fontSize: 20, stroke: RED, fill: RED, strokeWidth: 0 },
        ],
      });
      await vec("flatten", ["bg"]);
      await sleep(200);
      const badgeFlat = await cdp.eval(`window.__gpvVec.doc().objects.map((o) => o.kind)`);
      r.check(
        "(46 r-2) 1개 평탄화 = **패스로**(같은 id 유지) · 뱃지는 숫자를 텍스트 노드로 남긴다",
        asPath.id === "one" && asPath.kind === "path" &&
          badgeFlat.length === 2 && badgeFlat[0] === "path" && badgeFlat[1] === "text",
        `패스로=${J(asPath)} 뱃지=${J(badgeFlat)}`,
      );

      // ── (s) 패스 분리 ──────────────────────────────────────────────────────
      await setDoc({
        objects: [
          pathNode("sp", [
            { verts: boxVerts(20, 20, 50, 50), closed: true },
            { verts: boxVerts(100, 20, 50, 50), closed: true },
            { verts: boxVerts(20, 110, 50, 50), closed: true },
          ], { fills: [solid(RED)] }),
        ],
      });
      await vec("separate", ["sp"]);
      await sleep(200);
      const sepIds = (await objects()).map((o) => o.id);
      r.check(
        "(46 s) 패스 분리는 서브패스 수만큼 객체를 만들고 **첫 id 를 유지**한다(선택·스타일 참조 보존)",
        sepIds.length === 3 && sepIds[0] === "sp",
        J(sepIds),
      );

      // ── (t)(u)(v) 윤곽선화 ─────────────────────────────────────────────────
      const lineOut = async (cap, dash) => {
        await setDoc({
          objects: [
            {
              id: "ln", kind: "line", x1: 50, y1: 100, x2: 150, y2: 100, head: "end",
              strokes: [solid(BLUE)], fills: [], strokeWidth: 10, cap, dash: dash || null,
              heads: { start: "none", end: "none" },
            },
          ],
        });
        await vec("outline", ["ln"]);
        await S(`repaint()`);
        const o = await cdp.eval(`(() => {
          const n = window.__gpvVec.doc().objects[0];
          return { kind: n.kind, fill: n.fills[0] ? n.fills[0].color : null, sw: n.strokeWidth,
                   dash: n.dash, heads: n.heads };
        })()`);
        return { o, tip4: await px(154, 100), tip1: await px(151, 100), gap: await px(10, 100) };
      };
      const tRound = await lineOut("round");
      const tButt = await lineOut("butt");
      r.check(
        "(46 t-1) 윤곽선화는 선을 **채움 패스**로 바꾼다(fills = 선색 · strokeWidth 0 · 대시·화살촉 없음)",
        tRound.o.kind === "path" && tRound.o.fill === BLUE && tRound.o.sw === 0 &&
          tRound.o.dash === null && tRound.o.heads.end === "none",
        J(tRound.o),
      );
      r.check(
        "(46 t-2) 캡이 결과 모양에 남는다(둥근 캡은 끝에서 +4px 채움 · butt 는 +1px 흰색)",
        near(tRound.tip4, [0, 0, 255]) && isWhite(tButt.tip1),
        `round+4=${show(tRound.tip4)} butt+1=${show(tButt.tip1)}`,
      );
      await setDoc({
        objects: [
          pathNode("dl", [{ verts: [V(0, 100), V(200, 100)], closed: false }], {
            strokes: [solid(BLUE)], strokeWidth: 10, dash: [8, 4], cap: "butt",
          }),
        ],
      });
      await vec("outline", ["dl"]);
      await S(`repaint()`);
      const tDashGap = await px(10, 100);
      const tDashOn = await px(4, 100);
      r.check(
        "(46 t-3) 대시는 조각마다 잘려 채워진다 — 간격은 여전히 비어 있다",
        near(tDashOn, [0, 0, 255]) && isWhite(tDashGap),
        `채움=${show(tDashOn)} 간격=${show(tDashGap)}`,
      );

      const rectOut = async (align) => {
        await setDoc({
          objects: [
            pathNode("ro", [{ verts: boxVerts(60, 60, 80, 80), closed: true }], {
              strokes: [solid(BLUE)], strokeWidth: 10, strokeAlign: align, join: "miter",
            }),
          ],
        });
        await vec("outline", ["ro"]);
        await S(`repaint()`);
        return { out: await px(57, 100), in: await px(63, 100) };
      };
      const uIn = await rectOut("inside");
      const uOut = await rectOut("outside");
      r.check(
        "(46 u) 닫힌 패스의 정렬이 윤곽선화 결과에 그대로 남는다(안쪽 · 바깥)",
        isWhite(uIn.out) && near(uIn.in, [0, 0, 255]) &&
          near(uOut.out, [0, 0, 255]) && isWhite(uOut.in),
        `inside=${show(uIn.out)}/${show(uIn.in)} outside=${show(uOut.out)}/${show(uOut.in)}`,
      );

      await setDoc({
        objects: [
          {
            id: "ar", kind: "arrow", x1: 40, y1: 100, x2: 160, y2: 100, head: "end",
            strokes: [solid(BLUE)], fills: [], strokeWidth: 6,
            heads: { start: "none", end: "arrow" },
          },
        ],
      });
      await vec("outline", ["ar"]);
      await S(`repaint()`);
      const vHead = await px(145, 105);
      const vBefore = await px(125, 105);
      r.check(
        "(46 v) 화살촉 삼각형이 윤곽선 패스 안에 들어간다 — 같은 기하(길이 4w · ±π/7)를 쓴다",
        near(vHead, [0, 0, 255]) && isWhite(vBefore),
        `머리=${show(vHead)} 머리앞=${show(vBefore)}`,
      );

      // ── (w) 예산 ───────────────────────────────────────────────────────────
      const curve = [];
      for (let i = 0; i < 200; i++) {
        const t = i / 199;
        curve.push(20 + t * 160, 100 + Math.sin(t * Math.PI * 6) * 50);
      }
      await setDoc({
        objects: [
          { id: "wc", kind: "pen", pts: curve, stroke: BLUE, strokeWidth: 3 },
          rectNode("wr", 60, 60, 80, 80),
        ],
      });
      const ms = await cdp.eval(`(() => {
        const t0 = performance.now();
        window.__gpvVec.ed().vector.op('union', ['wc', 'wr']);
        return Math.round(performance.now() - t0);
      })()`);
      r.check(
        // §6 위험표의 예산은 300ms, CI 는 2배 여유다 — 실측을 항상 남겨 추세를 본다.
        "(46 w) 200정점 자유곡선 ∪ 사각형이 예산 안에 끝난다(설계 300ms · CI 2배 여유)",
        typeof ms === "number" && ms <= 600,
        `${ms}ms`,
      );

      // ── (x) 미리보기 스트립 ────────────────────────────────────────────────
      await setDoc({ objects: AB });
      await S(`selectAll()`);
      await sleep(300);
      const cells2 = await S(`stripCells()`);
      const stripApplied = await S(`clickStrip('합집합')`);
      await sleep(300);
      const stripRes = await cdp.eval(`(() => {
        const os = window.__gpvVec.doc().objects;
        return { n: os.length, kind: os[0] ? os[0].kind : null, label: window.__gpvVec.lastLabel() };
      })()`);
      await setDoc({ objects: [rectNode("s1", 20, 20, 40, 40)] });
      await S(`selectAll()`);
      await sleep(250);
      const cells1 = await S(`stripCells()`);
      await setDoc({
        objects: [
          rectNode("s1", 20, 20, 40, 40),
          { id: "s2", kind: "text", x: 100, y: 100, text: "가", fontSize: 20, stroke: RED, strokeWidth: 0 },
        ],
      });
      await S(`selectAll()`);
      await sleep(250);
      const cellsText = await S(`stripCells()`);
      r.check(
        "(46 x) 스트립은 `canBoolean` 일 때만 5칸(원본+4)이고, 칸 클릭 == 연산 실행이다",
        cells2 === 5 && cells1 === 0 && cellsText === 0 &&
          stripApplied === true && stripRes.n === 1 && stripRes.kind === "path" &&
          stripRes.label === "합집합",
        `2개=${cells2} 1개=${cells1} 텍스트=${cellsText} 적용=${J(stripRes)}`,
      );

      // ── (y) 인스펙터 ───────────────────────────────────────────────────────
      await setDoc({
        objects: [
          pathNode("iy", [{ verts: boxVerts(60, 60, 80, 80), closed: true }], {
            fills: [solid(RED)], strokes: [solid(BLUE)], strokeWidth: 4,
          }),
        ],
      });
      await S(`selectAll()`);
      await cdp.eval(`window.__gpvVec.ed().inspector.setTab('props')`);
      await sleep(300);
      const titles = await S(`sectionTitles()`);
      const panelText = await cdp.eval(
        `(window.__gpvVec.tabPanel() || {}).textContent || ''`,
      );
      const hY = await S(`hist()`);
      await S(`typeField('두께', '12')`);
      await sleep(250);
      const yWidth = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        return { sw: o.strokeWidth, hist: window.__gpvVec.hist() };
      })()`);
      await S(`clickToggle('짝수-홀수')`);
      await sleep(250);
      const yRule = await cdp.eval(`window.__gpvVec.doc().objects[0].fillRule`);
      await S(`clickPanelBtn(/채우기 없음/)`);
      await sleep(250);
      const yFills = await cdp.eval(`window.__gpvVec.doc().objects[0].fills.length`);
      r.check(
        "(46 y-1) 패스를 고르면 인스펙터에 `선 · 채우기 · 불리언 연산` 섹션과 `패스 분리` 버튼이 뜬다",
        ["선", "채우기", "불리언 연산"].every((t) => titles.includes(t)) &&
          /패스 분리/.test(panelText) && /평탄화/.test(panelText) && /윤곽선화/.test(panelText),
        `섹션=${J(titles)}`,
      );
      r.check(
        "(46 y-2) 값 편집은 **한 번에 한 칸**이다(두께 12 · 짝수-홀수 · 채우기 없음)",
        yWidth.sw === 12 && yWidth.hist === hY + 1 && yRule === "evenodd" && yFills === 0,
        `두께=${yWidth.sw} 칸=${hY}→${yWidth.hist} 규칙=${yRule} 채우기=${yFills}`,
      );

      // ── (z) 단축키 ─────────────────────────────────────────────────────────
      await setDoc({ objects: AB });
      await S(`selectAll()`);
      await S(`focusRoot()`);
      const kUnion = await S(`fire({ key:'u', code:'KeyU', ctrlKey:true, altKey:true })`);
      await sleep(300);
      const kUnionN = (await objects()).length;
      await setDoc({ objects: AB });
      await S(`selectAll()`);
      const kFlat = await S(`fire({ key:'e', code:'KeyE', ctrlKey:true })`);
      await sleep(300);
      const kFlatDoc = await cdp.eval(`(() => {
        const os = window.__gpvVec.doc().objects;
        return { n: os.length, subs: os[0] && os[0].subpaths ? os[0].subpaths.length : -1 };
      })()`);
      await setDoc({
        objects: [
          pathNode("ko", [{ verts: boxVerts(60, 60, 80, 80), closed: true }], {
            strokes: [solid(BLUE)], strokeWidth: 8,
          }),
        ],
      });
      await S(`selectAll()`);
      const kOut = await S(`fire({ key:'O', code:'KeyO', ctrlKey:true, shiftKey:true })`);
      await sleep(300);
      const kOutDoc = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        return { sw: o.strokeWidth, fills: o.fills.length };
      })()`);
      r.check(
        "(46 z) Ctrl+Alt+U · Ctrl+E · Ctrl+Shift+O 가 각 연산을 **한 번** 돌리고 브라우저 기본 동작을 막는다",
        kUnionN === 1 && kFlatDoc.n === 1 && kFlatDoc.subs === 2 &&
          kOutDoc.sw === 0 && kOutDoc.fills === 1 &&
          kUnion.prevented && kFlat.prevented && kOut.prevented &&
          kUnion.hits === 0 && kFlat.hits === 0 && kOut.hits === 0,
        `합집합=${kUnionN} 평탄화=${J(kFlatDoc)} 윤곽선화=${J(kOutDoc)} ` +
          `prevented=${[kUnion.prevented, kFlat.prevented, kOut.prevented].join("/")} ` +
          `누출=${[kUnion.hits, kFlat.hits, kOut.hits].join("/")}`,
      );
    }

    // ══ 48 크롭 ══════════════════════════════════════════════════════════════
    if (!hasCrop) {
      r.skip("(48) 크롭 프로 모드", "`__gpv.imageEditor.crop` 훅 미노출 — 태스크 48 미착지");
    } else {
      // ── (z) 8핸들·이동·비율 ────────────────────────────────────────────────
      await setDoc({ objects: [], crop: { x: 40, y: 40, w: 100, h: 100 } });
      const entered = await enterCrop();
      r.check(
        "(48 z-1) 크롭 모드는 **현재 크롭**에서 시작한다 — 진입 직후 8핸들이 바로 잡힌다",
        !!entered && entered.rect.x === 40 && entered.rect.y === 40 &&
          entered.rect.w === 100 && entered.rect.h === 100,
        J(entered && entered.rect),
      );
      await S(`pointerSeq([['down',140,140],['move',160,160],['move',180,180],['up',180,180]])`);
      await sleep(250);
      const seResize = await session();
      r.check(
        "(48 z-2) SE 핸들 드래그가 반대 모서리를 고정한 채 상자를 키운다",
        seResize && seResize.rect.w === 140 && seResize.rect.h === 140 &&
          seResize.rect.x === 40 && seResize.rect.y === 40,
        J(seResize && seResize.rect),
      );
      await crop("cropSet", { aspect: "16:9" });
      await sleep(200);
      const wide = await session();
      await crop("cropSet", { aspect: "original" });
      await sleep(200);
      const orig = await session();
      r.check(
        "(48 z-3) 비율은 핸들과 입력 양쪽에 걸린다(16:9 는 h = round(w·9/16) · 원본은 정사각 픽스처에서 w==h)",
        wide && Math.abs(wide.rect.h - Math.round((wide.rect.w * 9) / 16)) <= 1 &&
          orig && orig.rect.w === orig.rect.h,
        `16:9=${J(wide && wide.rect)} original=${J(orig && orig.rect)}`,
      );
      await crop("cropSet", { aspect: "free", rect: { x: 40, y: 40, w: 100, h: 100 } });
      await sleep(200);
      await S(`pointerSeq([['down',90,90],['move',100,100],['move',110,110],['up',110,110]])`);
      await sleep(250);
      const moved = await session();
      await S(`pointerSeq([['down',110,110],['move',180,180],['move',260,260],['up',260,260]])`);
      await sleep(250);
      const clamped = await session();
      r.check(
        "(48 z-4) 사각형 안 드래그는 크기를 지킨 채 옮기고, 경계 밖으로는 **클램프**된다",
        moved && moved.rect.x === 60 && moved.rect.y === 60 &&
          moved.rect.w === 100 && moved.rect.h === 100 &&
          clamped && clamped.rect.x === 100 && clamped.rect.y === 100 &&
          clamped.rect.w === 100 && clamped.rect.h === 100,
        `이동=${J(moved && moved.rect)} 클램프=${J(clamped && clamped.rect)}`,
      );

      // ── (aa) 오버레이는 화면 크롬이다 ──────────────────────────────────────
      await crop("cropSet", { overlay: "thirds", rect: { x: 40, y: 40, w: 100, h: 100 } });
      await S(`repaint()`);
      await sleep(200);
      const nThirds = await S(`chromeN('[data-chrome="crop"] line')`);
      await crop("cropSet", { overlay: "diagonal" });
      await S(`repaint()`);
      await sleep(200);
      const nDiag = await S(`chromeN('[data-chrome="crop"] line')`);
      r.check(
        "(48 aa-1) 오버레이는 SVG 크롬이다(3분할 4선 · 대각선 2선)",
        nThirds === 4 && nDiag === 2,
        `thirds=${nThirds} diagonal=${nDiag}`,
      );
      await crop("cropApply");
      await sleep(300);
      const savedAa = await cdp.eval(
        `window.__gpvVec.saveAs(${J(OUT)})`,
      );
      const closedAa = await poll(
        () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
        (v) => v === null,
        30,
        200,
      );
      const chromeLeak = await cdp.eval(
        `window.__gpvVec.readSaved(${J(fix.projectId)}, ${J(OUT)}, [], [59, 130, 246], 10)`,
      ).catch(() => null);
      r.check(
        "(48 aa-2) 크롭 크롬(딤·테두리·격자)은 **파일로 새지 않는다** — 캔버스가 아니라 SVG 한 겹이라 구조적으로 불가능하다",
        savedAa && savedAa.ok === true && closedAa === null && chromeLeak &&
          chromeLeak.match === 0 && chromeLeak.w === 100 && chromeLeak.h === 100,
        `저장=${J(savedAa)} 크기=${chromeLeak && chromeLeak.w}×${chromeLeak && chromeLeak.h} 크롬픽셀=${chromeLeak && chromeLeak.match}`,
      );
      if (!r.check("(48 aa-3) 재오픈", (await openEditor()) === true)) return;
      await cdp.eval(`window.__gpvVec.ed().setToggle('snap', false)`);

      // ── (ab) 직선화 = 캔버스 확장, θ=0 은 비트 동일 ────────────────────────
      await setDoc({ objects: [], crop: null, straighten: 0 });
      const url0 = await S(`sceneUrl()`);
      const size0 = await cdp.eval(`window.__gpvVec.ed().getOrientedSize()`);
      await setDoc({ straighten: 1.4 });
      await sleep(300);
      const size14 = await cdp.eval(`window.__gpvVec.ed().getOrientedSize()`);
      await setDoc({ straighten: 0 });
      await sleep(300);
      const urlBack = await S(`sceneUrl()`);
      const sizeBack = await cdp.eval(`window.__gpvVec.ed().getOrientedSize()`);
      r.check(
        "(48 ab-1) 직선화는 oriented 캔버스를 bbox 만큼 키운다(200×200 · 1.4° → 205×205)",
        size0.w === 200 && size0.h === 200 && size14.w === 205 && size14.h === 205,
        `0°=${J(size0)} 1.4°=${J(size14)}`,
      );
      r.check(
        "(48 ab-2) θ=0 이면 **비트 동일**이다 — 아니면 30/34/35 의 픽셀 단언이 통째로 흔들린다",
        sizeBack.w === 200 && sizeBack.h === 200 && !!url0 && url0 === urlBack,
        `크기=${J(sizeBack)} 픽셀동일=${url0 === urlBack}`,
      );

      // ── (ac) 주석은 base 에서 다시 계산된다(누적 델타 금지) ────────────────
      await setDoc({ objects: [rectNode("st", 40, 40, 20, 20)], crop: null, straighten: 0 });
      const baseKey = await S(`docKey()`);
      const baseDepth = await cdp.eval(`window.__gpvVec.ed().histDepth()`);
      await enterCrop();
      await crop("cropSet", { straighten: 10 });
      await sleep(300);
      const rot10 = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        const s = window.__gpvVec.ed().getOrientedSize();
        // 기대치: base 중심을 c₀(200×200) 기준 10° 회전한 뒤 c₁(확장 캔버스) 로 옮긴 자리.
        const rad = (10 * Math.PI) / 180;
        const cx = 100, cy = 100;
        const dx = 50 - cx, dy = 50 - cy;
        return {
          got: { x: o.x + o.w / 2, y: o.y + o.h / 2, rot: o.rot },
          want: {
            x: cx + (dx * Math.cos(rad) - dy * Math.sin(rad)) + (s.w / 2 - cx),
            y: cy + (dx * Math.sin(rad) + dy * Math.cos(rad)) + (s.h / 2 - cy),
          },
        };
      })()`);
      r.check(
        "(48 ac-1) 직선화가 **주석을 함께** 돌린다 — 이미지만 돌면 강조한 자리가 전부 어긋난다",
        rot10 && Math.abs(rot10.got.x - rot10.want.x) <= 0.5 &&
          Math.abs(rot10.got.y - rot10.want.y) <= 0.5 &&
          Math.abs(rot10.got.rot - 10) <= 0.01,
        `실제=${J(rot10 && rot10.got)} 기대=${J(rot10 && rot10.want)}`,
      );
      const ticks = await cdp.eval(`(async () => {
        for (let i = 0; i < 25; i++) {
          window.__gpvVec.ed().crop.cropSet({ straighten: 10 });
          window.__gpvVec.ed().crop.cropSet({ straighten: 0 });
        }
        await window.__gpvVec.frame();
        return {
          key: window.__gpvVec.docKey(),
          depth: window.__gpvVec.ed().histDepth(),
        };
      })()`);
      r.check(
        "(48 ac-2) 슬라이더를 50틱 왕복해도 주석이 밀리지 않고 히스토리는 **0칸**이다(replace 라이브)",
        ticks.key === baseKey && J(ticks.depth) === J(baseDepth),
        `문서동일=${ticks.key === baseKey} 히스토리=${J(baseDepth)}→${J(ticks.depth)}`,
      );
      await crop("cropSet", { straighten: 8 });
      await sleep(200);
      await crop("cropCancel");
      await sleep(300);
      const afterCancel = await S(`docKey()`);
      r.check(
        "(48 ac-3) 취소는 진입 시점 문서로 **정확히** 되돌린다",
        afterCancel === baseKey && (await session()) === null,
        `문서동일=${afterCancel === baseKey}`,
      );
      // 반전 홀수 개에서는 보이는 회전 방향이 좌표 회전과 반대다(rotateBy 의 mirrored 규칙).
      await setDoc({ objects: [rectNode("st", 40, 40, 20, 20)], straighten: 0, flipH: true });
      await enterCrop();
      await crop("cropSet", { straighten: 10 });
      await sleep(300);
      const mirrored = await cdp.eval(`(() => {
        const o = window.__gpvVec.doc().objects[0];
        const s = window.__gpvVec.ed().getOrientedSize();
        const rad = (-10 * Math.PI) / 180;
        const cx = 100, cy = 100;
        const dx = 50 - cx, dy = 50 - cy;
        return {
          got: { x: o.x + o.w / 2, y: o.y + o.h / 2 },
          want: {
            x: cx + (dx * Math.cos(rad) - dy * Math.sin(rad)) + (s.w / 2 - cx),
            y: cy + (dx * Math.sin(rad) + dy * Math.cos(rad)) + (s.h / 2 - cy),
          },
        };
      })()`);
      r.check(
        "(48 ac-4) 반전된 이미지에서는 부호가 뒤집힌다(`det` — 틀리면 주석이 반대로 돈다)",
        mirrored && Math.abs(mirrored.got.x - mirrored.want.x) <= 0.5 &&
          Math.abs(mirrored.got.y - mirrored.want.y) <= 0.5,
        `실제=${J(mirrored && mirrored.got)} 기대=${J(mirrored && mirrored.want)}`,
      );
      await crop("cropCancel");
      await sleep(250);

      // ── (ad) 여백 자동 제거 ────────────────────────────────────────────────
      if (!r.check("(48 ad-0) 여백 픽스처로 재오픈", (await openEditor(TRIM)) === true)) return;
      await cdp.eval(`window.__gpvVec.ed().setToggle('snap', false)`);
      await enterCrop();
      await crop("cropAutoTrim");
      await sleep(300);
      const trimmed = await session();
      r.check(
        "(48 ad-1) 여백 자동 제거가 단색 여백 안쪽으로 사각형을 맞춘다(20px 여백 → 20,20,160,160)",
        trimmed && trimmed.rect.x === 20 && trimmed.rect.y === 20 &&
          trimmed.rect.w === 160 && trimmed.rect.h === 160,
        J(trimmed && trimmed.rect),
      );
      await crop("cropCancel");
      await sleep(200);
      if (!r.check("(48 ad-2) 흰 픽스처로 재오픈", (await openEditor()) === true)) return;
      await cdp.eval(`window.__gpvVec.ed().setToggle('snap', false)`);
      await cdp.eval(`(() => {
        const st = window.__gpv.ui.getState();
        st.toasts.slice().forEach((t) => st.dismissToast(t.id));
        return true;
      })()`);
      await enterCrop();
      const beforeTrim = await session();
      await crop("cropAutoTrim");
      await sleep(400);
      const afterTrim = await session();
      const toasts = await cdp.eval(
        `window.__gpv.ui.getState().toasts.map((t) => t.message)`,
      );
      r.check(
        "(48 ad-3) 여백이 없으면 사각형을 그대로 두고 **알린다**(조용히 아무 일도 안 하면 고장으로 읽힌다)",
        afterTrim && beforeTrim && J(afterTrim.rect) === J(beforeTrim.rect) &&
          toasts.some((t) => /여백/.test(t)),
        `rect=${J(afterTrim && afterTrim.rect)} 토스트=${J(toasts)}`,
      );
      await crop("cropCancel");
      await sleep(200);

      // ── (ae) 영역 밖 삭제 · 적용 커밋 ──────────────────────────────────────
      await setDoc({
        objects: [rectNode("in", 50, 50, 40, 40), rectNode("out", 150, 150, 40, 40)],
        crop: null,
        straighten: 0,
      });
      const depthBefore = await cdp.eval(`window.__gpvVec.ed().histDepth()`);
      await enterCrop();
      await crop("cropSet", { rect: { x: 20, y: 20, w: 100, h: 100 }, deleteOutside: true });
      await sleep(200);
      await crop("cropApply");
      await sleep(400);
      const applied = await cdp.eval(`(() => ({
        ids: window.__gpvVec.doc().objects.map((o) => o.id),
        crop: window.__gpvVec.doc().crop,
        depth: window.__gpvVec.ed().histDepth(),
        label: window.__gpvVec.lastLabel(),
        mode: window.__gpvVec.ui().mode.kind,
      }))()`);
      r.check(
        "(48 ae-1) `크롭 영역 밖 삭제` + 적용 = **한 커밋**(라벨 `크롭 W×H`) 안에서 밖의 노드가 사라진다",
        J(applied.ids) === J(["in"]) &&
          applied.depth.past === depthBefore.past + 1 &&
          /^크롭 \d+×\d+$/.test(applied.label || "") &&
          applied.mode === "design" &&
          applied.crop && applied.crop.w === 100,
        `ids=${J(applied.ids)} 칸=${depthBefore.past}→${applied.depth.past} 라벨=${applied.label}`,
      );
      await setDoc({
        objects: [rectNode("in", 50, 50, 40, 40), rectNode("out", 150, 150, 40, 40)],
        crop: null,
      });
      await enterCrop();
      await crop("cropSet", { rect: { x: 20, y: 20, w: 100, h: 100 } });
      await sleep(200);
      await crop("cropApply");
      await sleep(400);
      const keptN = (await objects()).length;
      r.check(
        "(48 ae-2) 끄면 종전대로 출력에서만 잘린다(문서의 노드는 그대로 — e2e 30 (d) 계약)",
        keptN === 2,
        `객체=${keptN}`,
      );

      // ── (af)(ag) 내접 제한 ─────────────────────────────────────────────────
      await setDoc({ objects: [], crop: null, straighten: 0 });
      await enterCrop();
      await crop("cropSet", { straighten: 20 });
      await sleep(300);
      const forced = await session();
      await crop("cropSet", { constrainToImage: false });
      await sleep(200);
      const stillForced = await session();
      r.check(
        "(48 ag) |θ|>15° 에서는 `이미지 안으로 제한`이 강제된다 — 끄려는 시도는 무시한다(투명 모서리 저장 방지)",
        forced && forced.constrainToImage === true &&
          stillForced && stillForced.constrainToImage === true,
        `θ=20 제한=${forced && forced.constrainToImage} 끈 뒤=${stillForced && stillForced.constrainToImage}`,
      );
      await crop("cropSet", { straighten: 10 });
      await sleep(300);
      const bounded = await cdp.eval(`(() => {
        const s = window.__gpvVec.ed().cropSession();
        const o = window.__gpvVec.ed().getOrientedSize();
        return { rect: s.rect, oriented: o };
      })()`);
      await crop("cropApply");
      await sleep(400);
      const savedAf = await cdp.eval(`window.__gpvVec.saveAs(${J(OUT)})`);
      // 편집기가 닫혔다 = 저장이 실제로 끝났다. 이 값을 버리면 저장이 확인창에서 멈춰도
      // 아래 readSaved 가 **앞 케이스(aa-2)가 남긴 100×100 파일**을 읽어 통과해 버린다.
      const closedAf = await poll(
        () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
        (v) => v === null,
        30,
        200,
      );
      const cornerPx = await cdp.eval(`(async () => {
        const size = await window.__gpvVec.readSaved(${J(fix.projectId)}, ${J(OUT)}, []);
        const w = size.w - 1;
        const h = size.h - 1;
        return window.__gpvVec.readSaved(${J(fix.projectId)}, ${J(OUT)}, [
          [0, 0], [w, 0], [0, h], [w, h],
        ]);
      })()`).catch(() => null);
      r.check(
        "(48 af) 내접 제한이 켜져 있으면 직선화한 이미지의 저장본 **네 모서리가 불투명**하다(투명 모서리 = 조용한 손실)",
        !!cornerPx && cornerPx.px.every((p) => p[3] === 255) && closedAf === null &&
          // 읽은 것이 **이번 저장분**임을 크기로 못박는다(앞 케이스가 남긴 파일이면 크기가 다르다).
          Math.abs(cornerPx.w - Math.round(bounded.rect.w)) <= 1 &&
          bounded.rect.w < bounded.oriented.w && bounded.rect.h < bounded.oriented.h,
        `저장=${J(savedAf)} 닫힘=${closedAf} 크기=${cornerPx && cornerPx.w}×${cornerPx && cornerPx.h} 모서리=${cornerPx ? cornerPx.px.map((p) => p[3]).join("/") : "?"} rect=${J(bounded.rect)} oriented=${J(bounded.oriented)}`,
      );
      if (!r.check("(48 af-2) 재오픈", (await openEditor()) === true)) return;
      await cdp.eval(`window.__gpvVec.ed().setToggle('snap', false)`);

      // ── (ah) UI ────────────────────────────────────────────────────────────
      await setDoc({ objects: [], crop: null, straighten: 0 });
      await enterCrop();
      await sleep(300);
      const barTitles = await S(`barTitles()`);
      const hasRange = await cdp.eval(`!!window.__gpvVec.barRange()`);
      const barText = await S(`barText()`);
      const aspects = barTitles.filter((t) => /^비율 /.test(t)).length;
      const overlays = barTitles.filter((t) => /^오버레이 /.test(t)).length;
      r.check(
        "(48 ah-1) 컨텍스트 바에 비율 7 · 오버레이 4 · 직선화 슬라이더 · 취소 · 적용이 있다",
        aspects === 7 && overlays === 4 && hasRange === true &&
          /취소/.test(barText) && /적용/.test(barText),
        `비율=${aspects} 오버레이=${overlays} range=${hasRange}`,
      );
      await cdp.eval(`window.__gpvVec.ed().inspector.setTab('adjust')`);
      await sleep(300);
      const adjust = await cdp.eval(
        `(window.__gpvVec.tabPanel('adjust') || {}).textContent || ''`,
      );
      const wField = await cdp.eval(`(() => {
        const p = window.__gpvVec.tabPanel('adjust');
        return !!(p && p.querySelector('input[aria-label="W"]'));
      })()`);
      await cdp.eval(`(async () => {
        const p = window.__gpvVec.tabPanel('adjust');
        return window.__gpvVec.typeField('W', '120', p);
      })()`);
      await sleep(300);
      const wSet = await session();
      r.check(
        "(48 ah-2) 조정 탭 크롭 섹션에 `적용 전` 칩 · W/H/X/Y · `크롭 영역 밖 삭제` 가 있고 입력이 사각형을 바꾼다",
        /적용 전/.test(adjust) && /크롭 영역 밖 삭제/.test(adjust) && wField === true &&
          wSet && wSet.rect.w === 120,
        `W=${wSet && wSet.rect.w} 필드=${wField}`,
      );
      const status = await S(`statusText()`);
      r.check(
        "(48 ah-3) 상태바가 크롭 치수·비율을 알린다(48 §4 `크롭 W × H · 비율`)",
        /크롭 \d+ × \d+ · /.test(status),
        J(status),
      );
      await cdp.eval(`window.__gpvVec.ed().inspector.setTab('props')`);

      // ── (ai) 세션 안 회전 · 세션 중 저장 ───────────────────────────────────
      await crop("cropCancel");
      await sleep(250);
      await setDoc({
        objects: [rectNode("rt", 20, 20, 40, 60)],
        crop: null, straighten: 0, rotation: 0, flipH: false, flipV: false,
      });
      await cdp.eval(`window.__gpvVec.ed().history.flush()`);
      await sleep(400);
      const baseKey2 = await S(`docKey()`);
      await enterCrop();
      await crop("cropSet", { rect: { x: 10, y: 20, w: 100, h: 60 } });
      await sleep(200);
      await crop("cropTransform", "rotCW");
      await sleep(400);
      const spun = await cdp.eval(`(() => ({
        size: window.__gpvVec.ed().getOrientedSize(),
        rect: window.__gpvVec.ed().cropSession().rect,
        rotation: window.__gpvVec.doc().rotation,
      }))()`);
      // 자동저장 디바운스(1s)보다 넉넉히 기다린다 — 세션이 디스크를 건드렸다면 여기서 드러난다.
      await sleep(1600);
      const onDisk = await cdp.eval(`(async () => {
        const res = await window.__gpv.imageDocs.read(${J(fix.projectId)}, ${J(SRC)});
        if (!res || !res.json) return null;
        const env = window.__gpvVec.ed().schema.parse(res.json).env;
        return window.__gpvVec.key(env.doc);
      })()`);
      await crop("cropCancel");
      await sleep(300);
      const afterSpinCancel = await cdp.eval(`(() => ({
        key: window.__gpvVec.docKey(),
        rotation: window.__gpvVec.doc().rotation,
      }))()`);
      r.check(
        "(48 ai-1) 세션 안 90° 회전은 크롭 사각형까지 함께 돌리고, 취소가 회전째 되돌린다",
        spun.rotation === 90 &&
          spun.rect.x === 200 - (20 + 60) && spun.rect.w === 60 && spun.rect.h === 100 &&
          afterSpinCancel.rotation === 0 && afterSpinCancel.key === baseKey2,
        `size=${J(spun.size)} rect=${J(spun.rect)} rotation=${spun.rotation}→${afterSpinCancel.rotation}`,
      );
      r.check(
        "(48 ai-2) 세션 중 자동저장이 돌아도 사이드카에는 **진입 시점 문서**가 남는다 — 적용한 적 없는 회전이 되살아나면 안 된다",
        onDisk === baseKey2,
        onDisk === null ? "사이드카 없음" : `동일=${onDisk === baseKey2}`,
      );
    }
  } finally {
    await cdp
      .eval(`window.__gpvVec && window.__gpvVec.removeProbe()`)
      .catch(() => {});
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
