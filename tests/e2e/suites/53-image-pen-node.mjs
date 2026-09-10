// 펜 도구와 정점 편집(47) — DOCS/task/47-image-vector-pen-node-edit.md §7.
//
// 이 스위트가 지키는 계약 넷:
//   ① **한 동작 = 히스토리 한 칸.** 상한이 200칸이라 빈 칸은 성능이 아니라 정확성 문제다.
//      길이 0 드래그·이미 그 모드인 정점·이미 닫힌 서브패스는 커밋을 만들면 안 되고, 반대로
//      진짜 조작은 정확히 한 칸이어야 한다. **두 방향을 늘 함께 잰다** — "칸이 안 늘었다"만
//      재면 조작 자체가 씹혀도 통과하고, "칸이 늘었다"만 재면 한 제스처가 두 칸을 태워도 통과한다.
//   ② **모드 진입·정점 선택·모드 종료는 문서가 아니다.** 히스토리에도 문서에도 흔적이 없어야
//      한다 — 남으면 Ctrl+Z 가 "편집 모드에서 튕겨 나온다"(스냅샷이 UI 상태를 되돌린다).
//   ③ **Esc 는 취소다.** 커밋이 아니고, 취소했다고 객체 선택까지 비우지 않는다. 이 저장소는
//      예전에 취소 키가 커밋하고 선택까지 비워 **취소된 것처럼 보이는** 결함을 낸 적이 있다.
//      그래서 여기서는 히스토리·문서·선택 **세 축을 한 단언에서** 함께 잰다.
//   ④ **크롬은 SVG 다.** 앵커·핸들·스크림은 DOM 요소로 실재해야 하고, 캔버스와 저장 파일
//      어디에도 한 픽셀도 남으면 안 된다. 확대하면 디테일 캔버스가 위를 덮으므로(40),
//      캔버스에 그린 크롬은 **노드를 편집하려고 확대한 바로 그 순간** 사라진다.
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 이고 맞춤 배율이 1이다(30·37·39·40 과 같은 전제).
// 스냅은 스위트 내내 꺼 둔다 — 켜져 있으면 좌표를 재는 단언이 1px 씩 어긋난다.
//
// **포인터 절(i)~(o)(s)는 `pointer.ts` 진입(§3.4 "진입 3줄")에 달려 있다.** 그 3줄이 없으면
// `vpen` 클릭은 `makeDraft` 의 default 로 떨어져 **아무 일도 일어나지 않는다** — 예외도 로그도
// 없다. 그래서 각 포인터 절의 첫 단언이 그 배선을 직접 재고, 거기서 빨개지면 같은 뿌리를 가진
// 뒤 단언들은 건너뛴다(빨간 줄 하나가 원인을 이름으로 말한다 — 스킵이 결함을 감추지 않는다).
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "이미지 펜·노드 편집 (펜 드래프트 · 정점 연산 5모드 · Esc 계층 · 히스토리 1칸 · SVG 크롬)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const HELPERS = `(() => {
  const A = {};
  window.__gpvNode = A;

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
  A.obj = (id) => A.doc().objects.find((o) => o.id === id) || null;
  A.verts = (id, sub) => {
    const o = A.obj(id);
    if (!o || o.kind !== 'path') return null;
    const s = o.subpaths[sub || 0];
    return s ? s.verts : null;
  };
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

  /** 키 순서를 정규화한 딥이퀄 지문 — "문서가 한 글자도 안 바뀌었다"의 근거(37·39 와 같은 방식). */
  A.key = (v) =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort())
        : x,
    );
  A.docKey = () => A.key(A.doc());

  /** 문서를 넣고 **실제로 그려질 때까지** 기다린다 — 픽셀 단언은 그 뒤에만 뜻이 있다. */
  A.setDoc = async (patch) => {
    A.ed().setDoc(patch);
    await A.frame();
    A.ed().renderOnce();
    await A.frame();
    return true;
  };

  // ── 노드 편집 API(47 §4) ──────────────────────────────────────────────────
  //
  // 컨텍스트 바 버튼·인스펙터·단축키가 부르는 것과 **같은 함수**다 — 갈라질 자리가 없다.
  A.node = () => A.ed().nodeEdit();
  A.enter = (id) => A.ed().enterNodeEdit(id);
  A.sel = (refs) => A.ed().selectVerts(refs);
  A.op = (op) => A.ed().nodeOp(op);
  A.mode = (m) => A.ed().setNodeMode(m);
  A.vertPos = (x, y) => A.ed().setVertPos(x, y);
  A.vertHandle = (side, x, y) => A.ed().setVertHandle(side, x, y);
  /** 한 조작을 걸고 그 전후의 히스토리 칸 수·문서 지문을 함께 돌려준다(계약 ①). */
  A.around = async (fn) => {
    const h0 = A.hist();
    const k0 = A.docKey();
    await fn();
    await A.frame();
    await A.frame();
    return { dHist: A.hist() - h0, docSame: A.docKey() === k0, label: A.lastLabel() };
  };

  // ── 픽셀 ──────────────────────────────────────────────────────────────────
  A.px = (i, x, y) => {
    const c = A.canvases()[i];
    if (!c) return null;
    const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };
  /** 내보내기 렌더 경로의 한 점 — 저장하지 않고 '화면 == 파일'을 재는 통로(39 와 같은 방식). */
  A.renderPx = (x, y) => {
    const r = A.ed().renderRegion({ x: x, y: y, w: 1, h: 1 }, 1);
    return r ? r.data.slice(0, 4) : null;
  };
  /** 잉크 = **흰색이 아님**. 모양이 같은지를 색이 아니라 자리로 재려면 AA 까지 세야 한다. */
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

  // ── 키 ────────────────────────────────────────────────────────────────────
  //
  // 42 의 window **capture** 리스너가 받는다. 소비 여부(preventDefault)까지 함께 돌려준다 —
  // 표에 행이 없으면 소비도 안 되고, 그 키는 편집기 밖 리스너 25곳으로 샌다.
  A.fire = async (init) => {
    const ev = new KeyboardEvent(
      'keydown',
      Object.assign({ bubbles: true, cancelable: true }, init),
    );
    window.dispatchEvent(ev);
    await A.frame();
    await A.frame();
    return { prevented: ev.defaultPrevented };
  };
  A.kDelete = () => A.fire({ key: 'Delete', code: 'Delete' });
  A.kEnter = () => A.fire({ key: 'Enter', code: 'Enter' });
  A.kEsc = () => A.fire({ key: 'Escape', code: 'Escape' });
  A.kUndo = () => A.fire({ key: 'z', code: 'KeyZ', ctrlKey: true });
  A.kSelectAll = () => A.fire({ key: 'a', code: 'KeyA', ctrlKey: true });
  A.kArrow = (dir, o) =>
    A.fire({
      key: 'Arrow' + dir,
      code: 'Arrow' + dir,
      shiftKey: !!(o && o.shift),
      repeat: !!(o && o.repeat),
    });
  A.match = (init) => A.ed().matchShortcut(init, 'win');

  // ── 포인터 ────────────────────────────────────────────────────────────────
  //
  // 백킹 px 좌표. 실제 포인터가 없으면 setPointerCapture 가 던진다 — 무해화한다(39·43 과 동일).
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
            shiftKey: !!(opts && opts.shift),
            altKey: !!(opts && opts.alt),
            ctrlKey: !!(opts && opts.ctrl),
            pointerId: 1953, pointerType: 'mouse', isPrimary: true,
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
  /** 클릭 = 같은 좌표의 down→up(길이 0 드래그). 이 저장소가 실제로 데인 그 입력이다. */
  A.clickAt = (pts, opts) => {
    const steps = [];
    for (const p of pts) steps.push(['down', p[0], p[1]], ['up', p[0], p[1]]);
    return A.pointerSeq(steps, opts);
  };
  /** 누른 채 끌고 놓기 — 중간 move 를 섞어 실제 드래그와 같은 이벤트 열을 만든다. */
  A.dragTo = (from, to, opts) =>
    A.pointerSeq(
      [
        ['down', from[0], from[1]],
        ['move', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
        ['move', to[0], to[1]],
        ['up', to[0], to[1]],
      ],
      opts,
    );
  A.dblClickAt = async (x, y) => {
    const c = A.canvases()[1];
    if (!c) return false;
    await A.clickAt([[x, y]]);
    await A.clickAt([[x, y]]);
    const rect = c.getBoundingClientRect();
    c.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, composed: true,
        clientX: rect.left + (x / c.width) * rect.width,
        clientY: rect.top + (y / c.height) * rect.height,
        detail: 2,
      }),
    );
    await A.frame();
    await A.frame();
    return true;
  };

  // ── 화면 크롬(43 SVG 오버레이) ────────────────────────────────────────────
  A.chromeRoot = () => {
    const m = A.modal();
    const g = m ? m.querySelector('[data-chrome="pixel-grid"]') : null;
    return g ? g.parentElement : null;
  };
  A.extra = () => {
    const r = A.chromeRoot();
    return r ? r.querySelector('[data-chrome="extra"]') : null;
  };
  A.nAll = (sel) => {
    const g = A.extra();
    return g ? g.querySelectorAll(sel).length : -1;
  };
  /**
   * 앵커 정사각형. 뱃지 배경도 rect 라 태그만으로는 못 가른다 — **화면 폭 11 css px** 로
   * 거른다. 그 값이 곧 "확대해도 앵커 크기는 그대로"라는 계약이라, 폭을 세는 것이 곧 단언이다.
   */
  A.anchors = () => {
    const g = A.extra();
    if (!g) return null;
    return Array.from(g.querySelectorAll('rect'))
      .map((el) => ({
        w: Number(el.getAttribute('width')),
        h: Number(el.getAttribute('height')),
        fill: el.getAttribute('fill') || '',
      }))
      .filter((r) => Math.abs(r.w - 11) < 0.05 && Math.abs(r.h - 11) < 0.05);
  };
  /** 핸들 노브(반지름 5.5 css px). 닫기 강조 원(r=6)과 섞이지 않게 반지름으로 거른다. */
  A.knobs = () => {
    const g = A.extra();
    if (!g) return null;
    return Array.from(g.querySelectorAll('circle')).filter(
      (el) => Math.abs(Number(el.getAttribute('r')) - 5.5) < 0.05,
    ).length;
  };
  /** 스크림 = 마스크가 걸린 전면 사각형. 마스크가 없으면 편집 대상까지 어두워진다. */
  A.scrims = () => {
    const g = A.extra();
    if (!g) return -1;
    return Array.from(g.querySelectorAll('rect')).filter((el) => !!el.getAttribute('mask')).length;
  };
  /**
   * 스크림 **구멍 자체**. 개수만 세면 "마스크는 걸렸는데 구멍이 비었다"도, "구멍 선 두께가
   * 1/4 이라 편집 중인 가는 패스가 스크림에 먹혔다"도 전부 초록이 된다.
   *
   * stroke-width 는 **oriented 단위**다 — 오버레이가 cutoutStrokeCss × (1/scale) 로 되나눠
   * 넣으므로 객체의 strokeWidth 와 같아야 하고, 배율을 바꿔도 그 값이 같아야 한다.
   * 왕복 중 한쪽이 빠지면 여기서만 티가 난다.
   */
  A.scrimCut = () => {
    const g = A.extra();
    if (!g) return null;
    const rect = Array.from(g.querySelectorAll('rect')).find((el) => !!el.getAttribute('mask'));
    if (!rect) return null;
    const id = (rect.getAttribute('mask') || '').replace('url(#', '').replace(')', '');
    const m = document.getElementById(id);
    const p = m ? m.querySelector('path') : null;
    if (!p) return { d: '', sw: -1 };
    return { d: p.getAttribute('d') || '', sw: Number(p.getAttribute('stroke-width')) };
  };
  /**
   * 구멍의 d 가 그 점을 **채우는가**. 마스크 안 요소를 직접 재지 않고 같은 d 로 임시 path 를
   * 만들어 묻는다 — 렌더되지 않는 defs 속 요소에서 isPointInFill 이 엔진마다 다르다.
   * fill-rule 은 오버레이와 같은 기본값(nonzero)이다.
   */
  A.cutFills = (d, pts) => {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '1');
    svg.setAttribute('height', '1');
    svg.style.position = 'fixed';
    svg.style.left = '-9999px';
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', '#000000');
    svg.appendChild(p);
    document.body.appendChild(svg);
    try {
      return pts.map((q) => p.isPointInFill(new DOMPoint(q[0], q[1])));
    } finally {
      svg.remove();
    }
  };

  // ── 도구 레일(42 셸) ──────────────────────────────────────────────────────
  //
  // 표 조회(A.match)는 "행이 있다"만 잰다. 사용자가 실제로 도구를 고르는 두 경로는 물리 키와
  // 이 레일 버튼이고, 둘 다 액션 맵·ready 플래그가 빠지면 **조용히** 아무 일도 하지 않는다.
  A.rail = () => {
    const m = A.modal();
    return m ? m.querySelector('[role="toolbar"][aria-label="도구"]') : null;
  };
  A.railBtn = (title) => {
    const r = A.rail();
    if (!r) return null;
    return (
      Array.from(r.querySelectorAll('button')).find(
        (b) => (b.getAttribute('title') || '') === title,
      ) || null
    );
  };
  A.railClick = async (title) => {
    const b = A.railBtn(title);
    if (!b) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };

  A.extraText = () => {
    const g = A.extra();
    return g ? Array.from(g.querySelectorAll('text')).map((t) => t.textContent || '') : [];
  };
  A.screen = () => {
    const st = A.ed().chrome.state();
    return st ? st.screen : null;
  };

  // ── 셸(컨텍스트 바 · 상태바 · 인스펙터) ──────────────────────────────────
  //
  // 레일도 role=toolbar 라 aria-label '도구' 만 걸러 낸다(39 와 같은 규칙).
  A.bar = () => {
    const m = A.modal();
    if (!m) return null;
    return (
      Array.from(m.querySelectorAll('[role="toolbar"]')).find(
        (el) => (el.getAttribute('aria-label') || '') !== '도구',
      ) || null
    );
  };
  A.barText = () => {
    const b = A.bar();
    return b ? (b.textContent || '').trim() : '';
  };
  A.barBtn = async (re) => {
    const b = A.bar();
    const btn = b
      ? Array.from(b.querySelectorAll('button')).find((x) =>
          re.test((x.textContent || '') + ' ' + (x.getAttribute('title') || '')),
        )
      : null;
    if (!btn || btn.disabled) return false;
    btn.click();
    await A.frame();
    await A.frame();
    return true;
  };
  A.modalText = () => {
    const m = A.modal();
    return m ? (m.textContent || '') : '';
  };
  A.tabPanel = (id) => {
    const m = A.modal();
    return m ? m.querySelector('[data-inspector-tab="' + (id || A.ed().inspector.tab()) + '"]') : null;
  };
  A.field = (label) => {
    const p = A.tabPanel();
    const el = p ? p.querySelector('input[aria-label="' + label + '"]') : null;
    return el ? el.value : null;
  };

  // ── 저장 ──────────────────────────────────────────────────────────────────
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
    // 같은 이름으로 두 번째 저장이면 '덮어쓰기' 확인창이 뜬다. 답하지 않으면 **저장이 일어나지
    // 않은 채** 확인창이 useUi 에 남고, closeImageEditor 도 confirm 을 지우지 않아 다음
    // 스위트까지 새어 간다 → useEditorKeys 의 blocked 게이트가 편집기 키를 통째로 통과시킨다.
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
  A.readSaved = async (projectId, relPath, points) => {
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
    return out;
  };

  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  return true;
})()`;

// ── 문서 리터럴(경계 normalizeDoc 이 v2 로 채운다) ───────────────────────────
const BLUE = "#0000FF";
const RED = "#FF0000";
const solid = (hex) => ({ type: "solid", color: hex, opacity: 1, visible: true, blend: "normal" });
const V = (x, y, o) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner", ...(o || {}) });
const pathNode = (id, verts, closed, extra) => ({
  id,
  kind: "path",
  subpaths: [{ verts, closed: !!closed }],
  fillRule: "nonzero",
  fills: [],
  strokes: [solid(BLUE)],
  strokeWidth: 2,
  ...(extra || {}),
});
const rectNode = (id, x, y, w, h) => ({
  id, kind: "rect", x, y, w, h, radius: 0,
  fills: [solid(RED)], strokes: [], strokeWidth: 0,
});

/** ㄱ 자 열린 패스 — 정점 3 · 세그먼트 2. 스위트 전반의 기준 도형이다. */
const L_VERTS = [V(60, 60), V(140, 60), V(140, 140)];
const L = () => pathNode("pl", L_VERTS.map((v) => ({ ...v })), false);
/**
 * 같은 ㄱ 자인데 가운데 정점만 대칭 핸들이 있다 — 크롬 절 전용.
 * 핸들이 (0,0) 인 정점은 노브를 **그리지 않는 것이 맞으므로**, 기준 도형으로 노브를 세면
 * "핸들 크롬이 통째로 없다"와 "핸들이 없는 정점이라 안 그렸다"가 구분되지 않는다.
 */
const LH = () =>
  pathNode(
    "pl",
    [V(60, 60), V(140, 60, { mode: "mirrored", inX: -20, inY: 0, outX: 20, outY: 0 }), V(140, 140)],
    false,
  );

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
const isWhite = (p) =>
  Array.isArray(p) && p[0] >= 250 && p[1] >= 250 && p[2] >= 250 && p[3] > 200;
const isBlue = (p) =>
  Array.isArray(p) && p[2] >= 200 && p[0] <= 60 && p[1] <= 60 && p[3] > 200;
const show = (p) => (Array.isArray(p) ? `rgba(${p.join(",")})` : String(p));

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 펜·노드 편집", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-node.png";
  const OUT = "e2e-node-out.png";
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
  const S = (expr) => cdp.eval(`window.__gpvNode.${expr}`);
  const setDoc = (patch) => cdp.eval(`window.__gpvNode.setDoc(${J(patch)})`);
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
  /** 노드 편집 요약. 실패를 값으로 위장하지 않는다 — 던지면 성공값과 모양이 다른 것을 돌려준다. */
  const node = () => S(`node()`).catch((e) => ({ ERR: String(e && e.message) }));
  const state = () =>
    cdp
      .eval(
        `(() => { const A = window.__gpvNode; return { node: A.node(), ui: A.ui(), hist: A.hist(), label: A.lastLabel() }; })()`,
      )
      .catch((e) => ({ ERR: String(e && e.message) }));

  /** 기준 문서로 되돌리고 노드 편집에 들어간다 — 케이스마다 같은 출발점을 쓴다. */
  const seedL = async (sel) => {
    await setDoc({ objects: [L()] });
    await cdp.eval(`window.__gpvNode.enter('pl')`);
    if (sel) await cdp.eval(`window.__gpvNode.sel(${J(sel)})`);
    await sleep(150);
  };

  let toggles0 = null;

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const white = await cdp.eval(`window.__gpvNode.solidPng(200, 200, '#ffffff')`);
    const made = await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: white, overwrite: true,
    });
    if (!r.check("픽스처 PNG 생성(200×200 흰색)", made.ok && existsSync(join(fix.repo, SRC)))) {
      return;
    }
    if (!r.check("편집기 열림", (await openEditor()) === true)) return;

    // 스냅이 켜져 있으면 좌표를 재는 단언이 통째로 1px 씩 어긋난다. 토글은 사용자 취향이라
    // localStorage 에 영속되므로 명시적으로 끄고 finally 에서 되돌린다(30·39·40 과 같은 규칙).
    toggles0 = await S(`ui().toggles`);
    for (const k of ["snap", "snapPixel", "snapObjects", "snapGuides", "curvature"]) {
      await cdp.eval(`window.__gpvNode.ed().setToggle(${J(k)}, false)`);
    }

    const hasNodeApi = await cdp.eval(
      `!!(window.__gpv.imageEditor.enterNodeEdit && window.__gpv.imageEditor.nodeEdit)`,
    );
    if (!hasNodeApi) {
      r.skip("(47) 펜·노드 편집", "`__gpv.imageEditor.enterNodeEdit/nodeEdit` 훅 미노출 — 태스크 47 미착지");
      return;
    }

    // ══ (m) 진입 · 선택 · 삭제 · 종료 ════════════════════════════════════════
    await setDoc({ objects: [L(), rectNode("rc", 20, 160, 20, 20)] });
    await sleep(150);
    const beforeEnter = await state();
    const okPath = await cdp.eval(`window.__gpvNode.enter('pl')`);
    await sleep(150);
    const entered = await state();
    r.check(
      "(47 m-1) `path` 진입이 세션을 세우면서 **문서도 히스토리도 건드리지 않는다**(모드 진입은 커밋이 아니다 — 남으면 Ctrl+Z 가 편집 모드에서 튕겨 나온다)",
      okPath === true &&
        !!entered.node &&
        entered.node.id === "pl" &&
        entered.node.nodeCount === 3 &&
        entered.node.segmentCount === 2 &&
        entered.ui.mode.kind === "nodeEdit" &&
        entered.hist === beforeEnter.hist,
      `진입=${okPath} state=${J(entered.node)} mode=${J(entered.ui.mode)} hist=${beforeEnter.hist}→${entered.hist}`,
    );

    const okRect = await cdp.eval(`window.__gpvNode.enter('rc')`);
    const afterRect = await state();
    r.check(
      "(47 m-2) `path` 가 아닌 노드에는 들어가지 않는다 — 성공(`pl`)과 거절(`rc`)을 함께 재야 '아무 것도 안 함'이 통과로 위장되지 않는다(§3.2 · 46 `패스로` 뒤가 그 경로)",
      okPath === true && okRect === false && afterRect.node && afterRect.node.id === "pl",
      `pl=${okPath} rc=${okRect} 현재=${afterRect.node && afterRect.node.id}`,
    );

    const selRes = await S(`around(() => window.__gpvNode.sel([{ sub: 0, vert: 1 }]))`);
    const selState = await node();
    r.check(
      "(47 m-3) 정점 선택은 **문서가 아니다** — 지문·히스토리 불변이면서 요약에는 앵커 좌표가 실린다(선택이 문서로 새면 Ctrl+Z 가 선택까지 되돌린다)",
      selRes.dHist === 0 &&
        selRes.docSame === true &&
        selState.selected &&
        selState.selected.length === 1 &&
        near(selState.anchor.x, 140) &&
        near(selState.anchor.y, 60),
      `Δhist=${selRes.dHist} 문서동일=${selRes.docSame} anchor=${J(selState.anchor)}`,
    );

    const delRes = await S(`around(() => window.__gpvNode.kDelete())`);
    const afterDel = await state();
    const objCount = await cdp.eval(`window.__gpvNode.doc().objects.length`);
    r.check(
      "(47 m-4) Delete 가 **정점 하나**를 지운다 — 객체는 남고 히스토리는 정확히 한 칸(`노드 삭제`). 표의 `hasSelection` 행이 이기면 여기서 객체가 통째로 사라진다",
      delRes.dHist === 1 &&
        delRes.label === "노드 삭제" &&
        afterDel.node &&
        afterDel.node.nodeCount === 2 &&
        afterDel.node.selected.length === 0 &&
        objCount === 2,
      `Δhist=${delRes.dHist} 라벨=${J(delRes.label)} 노드=${afterDel.node && afterDel.node.nodeCount} 객체=${objCount}`,
    );

    await S(`kUndo()`);
    await sleep(200);
    const undone = await state();
    r.check(
      "(47 m-5) Ctrl+Z 한 번이 정점 삭제를 되돌리고 **편집 모드는 그대로**다(문서 undo 가 세션을 끌고 나가면 안 된다)",
      undone.node && undone.node.nodeCount === 3 && undone.ui.mode.kind === "nodeEdit",
      `노드=${undone.node && undone.node.nodeCount} mode=${J(undone.ui.mode)}`,
    );

    const exitRes = await S(`around(() => window.__gpvNode.kEnter())`);
    const exited = await state();
    r.check(
      "(47 m-6) Enter(`편집 완료 ⏎`)가 세션을 닫는다 — **종료는 커밋이 아니다**(문서·히스토리 불변)",
      exitRes.dHist === 0 &&
        exitRes.docSame === true &&
        exited.node === null &&
        exited.ui.mode.kind === "design",
      `Δhist=${exitRes.dHist} 문서동일=${exitRes.docSame} node=${J(exited.node)} mode=${J(exited.ui.mode)}`,
    );

    // ══ Esc 계층 — 취소이면서 선택을 비우지 않는다 ═══════════════════════════
    //
    // 이 저장소가 실제로 데인 결함: 취소 키가 **커밋**하고 **선택까지 비워** 취소된 것처럼
    // 보였다. 두 축(히스토리·선택)을 한 단언에서 함께 재야 그게 잡힌다.
    await setDoc({ objects: [L()] });
    await sleep(120);
    await S(`focusRoot()`);
    await S(`kSelectAll()`);
    await sleep(120);
    const selectedBefore = await S(`ui().selectedIds`);
    const enterByKey = await S(`around(() => window.__gpvNode.kEnter())`);
    const byEnter = await state();
    r.check(
      "(47 esc-0) 단일 `path` 선택 + Enter 로 노드 편집에 들어간다(§3.2 진입 경로) — 그 자체는 커밋이 아니다",
      Array.isArray(selectedBefore) &&
        selectedBefore.length === 1 &&
        selectedBefore[0] === "pl" &&
        enterByKey.dHist === 0 &&
        byEnter.node &&
        byEnter.node.id === "pl",
      `선택=${J(selectedBefore)} Δhist=${enterByKey.dHist} node=${byEnter.node && byEnter.node.id}`,
    );

    await S(`sel([{ sub: 0, vert: 2 }])`);
    await sleep(120);
    const esc1 = await S(`around(() => window.__gpvNode.kEsc())`);
    const afterEsc1 = await state();
    r.check(
      "(47 esc-1) Esc 1단 = **정점 선택 해제**뿐이다 — 모드는 유지되고 문서·히스토리·객체 선택은 하나도 안 바뀐다",
      esc1.dHist === 0 &&
        esc1.docSame === true &&
        afterEsc1.node &&
        afterEsc1.node.selected.length === 0 &&
        afterEsc1.ui.mode.kind === "nodeEdit" &&
        afterEsc1.ui.selectedIds.length === 1,
      `Δhist=${esc1.dHist} 문서동일=${esc1.docSame} 정점선택=${afterEsc1.node && afterEsc1.node.selected.length} mode=${J(afterEsc1.ui.mode)} 객체선택=${J(afterEsc1.ui.selectedIds)}`,
    );

    const esc2 = await S(`around(() => window.__gpvNode.kEsc())`);
    const afterEsc2 = await state();
    r.check(
      "(47 esc-2) Esc 2단 = **편집 종료**다. 취소인데 커밋이 없고(히스토리·문서 불변) **객체 선택도 살아 있다** — 예전에 취소가 커밋하고 선택까지 비워 취소된 것처럼 보였다",
      esc2.dHist === 0 &&
        esc2.docSame === true &&
        afterEsc2.node === null &&
        afterEsc2.ui.mode.kind === "design" &&
        afterEsc2.ui.selectedIds.length === 1 &&
        afterEsc2.ui.selectedIds[0] === "pl",
      `Δhist=${esc2.dHist} 문서동일=${esc2.docSame} mode=${J(afterEsc2.ui.mode)} 객체선택=${J(afterEsc2.ui.selectedIds)}`,
    );

    const esc3 = await S(`around(() => window.__gpvNode.kEsc())`);
    const afterEsc3 = await S(`ui().selectedIds`);
    r.check(
      "(47 esc-3) 그다음 Esc 라야 객체 선택이 풀린다 — 계층이 한 단계씩 내려간다(한 번에 둘을 하면 되돌릴 방법이 없다)",
      esc3.dHist === 0 && Array.isArray(afterEsc3) && afterEsc3.length === 0,
      `Δhist=${esc3.dHist} 선택=${J(afterEsc3)}`,
    );

    // ══ (t) 5모드 · 구조 연산 ════════════════════════════════════════════════
    await seedL([{ sub: 0, vert: 1 }]);
    const mir = await S(`around(() => window.__gpvNode.mode('mirrored'))`);
    const mirV = await S(`verts('pl', 0)`);
    const v1 = mirV && mirV[1];
    r.check(
      "(47 t-1) `대칭` 은 반대편을 −out 으로 맞춘다 — 씨앗이 없는 정점도 이웃에서 만들어 **핸들이 실제로 생긴다**(둘 다 0 이면 모드만 바뀌고 곡선은 그대로다)",
      mir.dHist === 1 &&
        mir.label === "노드 모드 대칭" &&
        !!v1 &&
        v1.mode === "mirrored" &&
        Math.hypot(v1.outX, v1.outY) > 1 &&
        near(v1.inX, -v1.outX, 1e-6) &&
        near(v1.inY, -v1.outY, 1e-6),
      `Δhist=${mir.dHist} 라벨=${J(mir.label)} v1=${J(v1)}`,
    );

    const mirAgain = await S(`around(() => window.__gpvNode.mode('mirrored'))`);
    r.check(
      "(47 t-2) 이미 그 모드면 **커밋이 없다** — 같은 값 커밋은 히스토리 200칸을 버튼 연타로 태우고, Ctrl+Z 를 눌러도 화면이 그대로인 그 증상이 된다",
      mirAgain.dHist === 0 && mirAgain.docSame === true,
      `Δhist=${mirAgain.dHist} 문서동일=${mirAgain.docSame}`,
    );

    const statusHit = await cdp.eval(
      `/노드 1개 선택 · 대칭 핸들/.test(window.__gpvNode.modalText())`,
    );
    const barTxt = await S(`barText()`);
    r.check(
      "(47 t-3) 상태바 요약 `노드 1개 선택 · 대칭 핸들` 과 컨텍스트 바 HUD `노드 3 · 세그먼트 2 · 선택 1` 이 **같은 세션 요약**에서 나온다(둘이 갈리면 화면 두 곳이 서로 다른 말을 한다)",
      statusHit === true && /노드 3 · 세그먼트 2 · 선택 1/.test(barTxt),
      `상태바=${statusHit} 바=${J(barTxt.slice(0, 120))}`,
    );

    const none = await S(`around(() => window.__gpvNode.mode('none'))`);
    const noneV = await S(`verts('pl', 0)`);
    r.check(
      "(47 t-4) `없음` 은 양 핸들을 지우고 모드를 `corner` 로 내린다 — `mirrored` 라고 적힌 채 핸들이 없으면 다음 드래그가 없던 손잡이를 돋운다",
      none.dHist === 1 &&
        noneV[1].inX === 0 && noneV[1].inY === 0 &&
        noneV[1].outX === 0 && noneV[1].outY === 0 &&
        noneV[1].mode === "corner",
      `Δhist=${none.dHist} v1=${J(noneV && noneV[1])}`,
    );

    await S(`mode('auto')`);
    await sleep(150);
    const autoDoc = await S(`verts('pl', 0)`);
    const autoState = await node();
    r.check(
      "(47 t-5) `자동` 은 문서에 (0,0) 을 남기고 물질화하지 않는다 — 그런데 요약의 핸들은 0 이 아니다(`normalizeAuto` 어댑터 한 곳). 문서에 값을 박으면 이웃을 옮겨도 곡선이 안 따라온다",
      autoDoc[1].mode === "auto" &&
        autoDoc[1].outX === 0 && autoDoc[1].outY === 0 &&
        !!autoState.handleOut &&
        Math.hypot(autoState.handleOut[0], autoState.handleOut[1]) > 1,
      `문서=${J(autoDoc && autoDoc[1])} 요약out=${J(autoState.handleOut)}`,
    );

    // ── 닫기 / 열기 ───────────────────────────────────────────────────────────
    await seedL([{ sub: 0, vert: 0 }]);
    const close1 = await S(`around(() => window.__gpvNode.op('close'))`);
    const closed1 = await node();
    const close2 = await S(`around(() => window.__gpvNode.op('close'))`);
    const open1 = await S(`around(() => window.__gpvNode.op('open'))`);
    const opened = await node();
    r.check(
      "(47 t-6) `패스 닫기`는 세그먼트를 하나 늘리고 한 칸을 쓴다 · 이미 닫혀 있으면 **0칸** · `패스 열기`가 되돌린다(왕복이 정확히 두 칸)",
      close1.dHist === 1 && close1.label === "패스 닫기" &&
        closed1.segmentCount === 3 && closed1.open === false &&
        close2.dHist === 0 &&
        open1.dHist === 1 && open1.label === "패스 열기" &&
        opened.segmentCount === 2 && opened.open === true,
      `닫기Δ=${close1.dHist} 재닫기Δ=${close2.dHist} 열기Δ=${open1.dHist} 세그=${closed1.segmentCount}→${opened.segmentCount}`,
    );

    // ── 방향 반전 ─────────────────────────────────────────────────────────────
    await setDoc({
      objects: [
        pathNode(
          "pr",
          [V(40, 40, { outX: 10, outY: 4 }), V(100, 40), V(100, 100)],
          false,
        ),
      ],
    });
    await cdp.eval(`window.__gpvNode.enter('pr')`);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 0 }])`);
    await sleep(150);
    const rev = await S(`around(() => window.__gpvNode.op('reverse'))`);
    const revV = await S(`verts('pr', 0)`);
    r.check(
      "(47 t-7) `방향 반전`이 정점 순서를 뒤집으면서 `in/out` 도 **맞바꾼다** — 순서만 뒤집으면 곡선이 뒤집힌 자리에서 반대로 휜다(시안 `방향 반전`의 뜻은 시작·끝이 바뀌는 것이다)",
      rev.dHist === 1 &&
        rev.label === "방향 반전" &&
        !!revV &&
        near(revV[0].x, 100) && near(revV[0].y, 100) &&
        near(revV[2].x, 40) && near(revV[2].y, 40) &&
        near(revV[2].inX, 10) && near(revV[2].inY, 4) &&
        revV[2].outX === 0 && revV[2].outY === 0,
      `Δhist=${rev.dHist} v0=${J(revV && revV[0])} v2=${J(revV && revV[2])}`,
    );

    // ── 노드 추가 ─────────────────────────────────────────────────────────────
    await seedL([{ sub: 0, vert: 0 }, { sub: 0, vert: 2 }]);
    const addFar = await S(`around(() => window.__gpvNode.op('add'))`);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 0 }, { sub: 0, vert: 1 }])`);
    await sleep(120);
    const addNear = await S(`around(() => window.__gpvNode.op('add'))`);
    const addState = await node();
    const addV = await S(`verts('pl', 0)`);
    r.check(
      "(47 t-8) `노드 추가`는 **인접한** 두 정점 사이에만 넣는다 — 떨어진 쌍(0,2)은 0칸, 인접 쌍(0,1)은 직선 중점 (100,60)에 코너 정점 1개·1칸, 새 정점이 곧 선택이다",
      addFar.dHist === 0 && addFar.docSame === true &&
        addNear.dHist === 1 && addNear.label === "노드 추가" &&
        !!addV && addV.length === 4 &&
        near(addV[1].x, 100) && near(addV[1].y, 60) &&
        addV[1].mode === "corner" &&
        addV[1].outX === 0 && addV[1].outY === 0 &&
        addState.selected.length === 1 && addState.selected[0].vert === 1,
      `떨어짐Δ=${addFar.dHist} 인접Δ=${addNear.dHist} 새정점=${J(addV && addV[1])} 선택=${J(addState.selected)}`,
    );

    // 곡선 세그먼트 분할 — de Casteljau 라 **모양이 안 바뀐다**. 좌표가 아니라 잉크로 재야
    // "분할이 곡선을 폈다"가 잡힌다(제어점만 보면 값이 달라도 그림은 같을 수 있다).
    await setDoc({
      objects: [
        pathNode(
          "pc",
          [V(40, 150, { outX: 40, outY: -110 }), V(160, 150, { inX: -40, inY: -110 })],
          false,
          { strokeWidth: 4 },
        ),
      ],
    });
    await sleep(200);
    const inkBefore = await S(`inkSnap([0, 0, 200, 200])`);
    await cdp.eval(`window.__gpvNode.enter('pc')`);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 0 }, { sub: 0, vert: 1 }])`);
    await sleep(150);
    await S(`op('add')`);
    await sleep(250);
    await cdp.eval(`window.__gpvNode.ed().renderOnce()`);
    await sleep(200);
    const inkDiff = await S(`inkDiffNow([0, 0, 200, 200])`);
    const curveCount = await cdp.eval(`window.__gpvNode.verts('pc', 0).length`);
    r.check(
      "(47 t-9) 곡선 세그먼트에 정점을 넣어도 **그림이 그대로다**(de Casteljau) — 정점은 2→3 인데 잉크는 1px 초과로 어긋난 픽셀이 없다",
      inkBefore > 200 && curveCount === 3 && inkDiff >= 0 && inkDiff <= 4,
      `잉크=${inkBefore} 정점=${curveCount} 어긋남=${inkDiff}`,
    );

    // ── 전체 선택 · 미세 이동 ────────────────────────────────────────────────
    await seedL([{ sub: 0, vert: 0 }]);
    const all = await S(`around(() => window.__gpvNode.kSelectAll())`);
    const allState = await node();
    r.check(
      "(47 t-10) 노드 편집 중 Ctrl+A 는 **정점** 전체를 고른다(문서 불변) — 표의 `selectAll` 행이 `always` 라 여기서 안 갈리면 편집 중인 패스 밖 객체까지 잡힌다",
      all.dHist === 0 && all.docSame === true &&
        allState.selected.length === 3 && allState.nodeCount === 3,
      `Δhist=${all.dHist} 선택=${allState.selected.length}/${allState.nodeCount}`,
    );

    await S(`sel([{ sub: 0, vert: 1 }])`);
    await sleep(120);
    const nudge1 = await S(`around(() => window.__gpvNode.kArrow('Right'))`);
    const afterN1 = await S(`verts('pl', 0)`);
    const nudge10 = await S(`around(() => window.__gpvNode.kArrow('Right', { shift: true }))`);
    const afterN10 = await S(`verts('pl', 0)`);
    const nudgeRep = await S(`around(() => window.__gpvNode.kArrow('Right', { repeat: true }))`);
    r.check(
      "(47 t-11) 방향키 1px · Shift 10px 가 각각 keydown 한 번 = 히스토리 한 칸이고, **auto-repeat 는 무시**한다(K5 — 초당 30커밋이면 200칸이 7초에 소진돼 그 앞 기록이 통째로 날아간다)",
      nudge1.dHist === 1 && near(afterN1[1].x, 141) &&
        nudge10.dHist === 1 && near(afterN10[1].x, 151) &&
        nudgeRep.dHist === 0 && nudgeRep.docSame === true,
      `1px Δ=${nudge1.dHist} x=${afterN1 && afterN1[1].x} / 10px Δ=${nudge10.dHist} x=${afterN10 && afterN10[1].x} / repeat Δ=${nudgeRep.dHist}`,
    );

    // ── 값 그대로 쓰기 = 0칸(길이 0 드래그와 같은 결함 계열) ──────────────────
    await seedL([{ sub: 0, vert: 1 }]);
    const samePos = await S(`around(() => window.__gpvNode.vertPos(140, 60))`);
    const movePos = await S(`around(() => window.__gpvNode.vertPos(150, 70))`);
    const movedV = await S(`verts('pl', 0)`);
    r.check(
      "(47 t-12) 좌표를 **같은 값**으로 쓰면 0칸, 다른 값이면 정확히 1칸이다 — 델타 0 에서도 새 객체를 만들면 인스펙터에 숫자를 다시 적기만 해도 히스토리가 쌓인다(정점 클릭이 객체를 움직이던 결함과 같은 뿌리)",
      samePos.dHist === 0 && samePos.docSame === true &&
        movePos.dHist === 1 && movePos.label === "노드 이동" &&
        near(movedV[1].x, 150) && near(movedV[1].y, 70),
      `같은값Δ=${samePos.dHist} 이동Δ=${movePos.dHist} v1=${J(movedV && movedV[1])}`,
    );

    // ══ (r) auto 핸들은 이웃을 따라간다 ══════════════════════════════════════
    //
    // 위험표 1번(auto 핸들 스테일): 이웃을 옮겼는데 가운데 곡선이 안 따라오는 결함.
    await setDoc({
      objects: [
        pathNode(
          "pa",
          [V(40, 100), V(100, 60, { mode: "auto" }), V(160, 100)],
          false,
        ),
      ],
    });
    await cdp.eval(`window.__gpvNode.enter('pa')`);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
    await sleep(200);
    const auto0 = await node();
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 2 }])`);
    await sleep(120);
    await S(`vertPos(160, 180)`);
    await sleep(200);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
    await sleep(150);
    const auto1 = await node();
    const autoDocStill = await S(`verts('pa', 0)`);
    r.check(
      "(47 r) `auto` 정점의 핸들이 **이웃을 옮기면 따라 바뀐다** — 문서에는 여전히 (0,0) 이고 값은 소비 시점에 이웃에서 나온다(물질화해 넣었다면 낡은 값이 그대로 남아 곡선이 안 따라온다)",
      !!auto0.handleOut && !!auto1.handleOut &&
        Math.hypot(auto0.handleOut[0], auto0.handleOut[1]) > 1 &&
        Math.hypot(auto1.handleOut[0] - auto0.handleOut[0], auto1.handleOut[1] - auto0.handleOut[1]) > 1 &&
        autoDocStill[1].outX === 0 && autoDocStill[1].outY === 0,
      `이웃이동 전=${J(auto0.handleOut)} 후=${J(auto1.handleOut)} 문서=${J(autoDocStill && autoDocStill[1])}`,
    );

    // ══ (p) 크롬은 SVG 다 ════════════════════════════════════════════════════
    await setDoc({ objects: [LH()] });
    await cdp.eval(`window.__gpvNode.enter('pl')`);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
    await sleep(150);
    await cdp.eval(`window.__gpvNode.ed().renderOnce()`);
    await sleep(250);
    const chrome = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      return {
        anchors: A.anchors(),
        knobs: A.knobs(),
        scrims: A.scrims(),
        skeleton: A.nAll('path'),
        texts: A.extraText(),
      };
    })()`);
    r.check(
      "(47 p-1) 정점 크롬이 **DOM 에 실재한다** — 앵커 `rect` 3개(정점 수)·스크림 마스크 사각형·골격 `path`·선택 정점의 노브 `circle` 2개(in/out). 캔버스 픽셀로 그렸다면 이 노드가 하나도 없다",
      Array.isArray(chrome.anchors) &&
        chrome.anchors.length === 3 &&
        chrome.scrims >= 1 &&
        chrome.skeleton >= 1 &&
        chrome.knobs === 2,
      `앵커=${chrome.anchors && chrome.anchors.length} 노브=${chrome.knobs} 스크림=${chrome.scrims} 골격=${chrome.skeleton}`,
    );
    r.check(
      "(47 p-2) 선택 앵커만 채워진다 — 전부 같은 모양이면 무엇을 고른 상태인지 화면에서 알 수 없다",
      Array.isArray(chrome.anchors) &&
        chrome.anchors.filter((a) => /FFFFFF/i.test(a.fill)).length === 2 &&
        chrome.anchors.filter((a) => !/FFFFFF/i.test(a.fill)).length === 1,
      `채움=${J((chrome.anchors || []).map((a) => a.fill))}`,
    );
    r.check(
      "(47 p-3) 아트보드 라벨과 HUD 가 크롬에 있다 — 라벨은 레이어 이름, HUD 는 `노드 N · 세그먼트 M · 선택 K`(컨텍스트 바와 같은 문구)",
      Array.isArray(chrome.texts) &&
        chrome.texts.some((t) => /벡터 레이어 편집 중/.test(t)) &&
        chrome.texts.some((t) => /노드 3 · 세그먼트 2 · 선택 1/.test(t)),
      J(chrome.texts),
    );

    // ── 구멍의 기하 — 개수가 아니라 내용 ──────────────────────────────────────
    const cut0 = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      const c = A.scrimCut();
      return c ? { d: c.d, sw: c.sw, inside: A.cutFills(c.d, [[113, 87]])[0] } : null;
    })()`);
    r.check(
      "(47 p-1b) 구멍의 `d` 가 비어 있지 않고 선 두께가 객체 `strokeWidth` 그대로다(oriented 단위) — `cutoutStrokeCss` 왕복(× scale → ÷ scale)에서 한쪽이 빠지면 400% 에서 구멍이 실획의 1/4 이 돼 편집 중인 가는 패스가 스크림(alpha .75)에 먹힌다. 스크림 **개수**만 세면 그 회귀가 그대로 초록이다",
      !!cut0 && cut0.d.length > 0 && near(cut0.sw, 2, 0.01),
      `d=${J((cut0 && cut0.d.slice(0, 60)) || null)} stroke-width=${cut0 && cut0.sw}`,
    );

    // 같은 도형에 채우기만 주고 다시 잰다 — 두 방향을 함께 재야 "구멍이 통째로 비었다"가
    // 초록으로 위장되지 않는다.
    await setDoc({
      objects: [
        pathNode(
          "pl",
          [
            V(60, 60),
            V(140, 60, { mode: "mirrored", inX: -20, inY: 0, outX: 20, outY: 0 }),
            V(140, 140),
          ],
          false,
          { fills: [solid(RED)] },
        ),
      ],
    });
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
    await cdp.eval(`window.__gpvNode.ed().renderOnce()`);
    await sleep(250);
    const cutFilled = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      const c = A.scrimCut();
      return c ? { d: c.d, inside: A.cutFills(c.d, [[113, 87]])[0] } : null;
    })()`);
    r.check(
      "(47 p-1c) 구멍은 **객체가 실제로 칠하는 자리**만 판다 — 채우기 없는 열린 패스에서 세 점이 감싸는 면적(113,87)은 구멍이 아니고(SVG 채우기는 열린 서브패스를 암묵적으로 닫는다), 같은 도형에 채우기를 주면 바로 그 자리가 구멍이 된다. 펜 산출물이 `fills: []` 라 이건 예외가 아니라 기본 경로다",
      !!cut0 && !!cutFilled && cut0.inside === false && cutFilled.inside === true,
      `무채움 면적=${cut0 && cut0.inside} 채움 면적=${cutFilled && cutFilled.inside}`,
    );
    await setDoc({ objects: [LH()] });
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
    await cdp.eval(`window.__gpvNode.ed().renderOnce()`);
    await sleep(250);

    const cleanScene = await cdp.eval(`[
      window.__gpvNode.px(1, 5, 5),
      window.__gpvNode.px(1, 60, 64),
      window.__gpvNode.renderPx(5, 5),
      window.__gpvNode.renderPx(60, 64),
      window.__gpvNode.px(1, 100, 60),
    ]`);
    r.check(
      "(47 p-4) 편집 중인데도 **씬 캔버스와 내보내기 렌더에는 크롬이 한 픽셀도 없다** — 스크림 자리(5,5)와 앵커 속(60,64)이 흰색이고, 정작 패스(100,60)는 그대로 그려져 있다(빈 화면을 재는 게 아니라는 근거)",
      isWhite(cleanScene[0]) && isWhite(cleanScene[1]) &&
        isWhite(cleanScene[2]) && isWhite(cleanScene[3]) &&
        isBlue(cleanScene[4]),
      `스크림자리=${show(cleanScene[0])} 앵커속=${show(cleanScene[1])} 렌더=${show(cleanScene[2])}/${show(cleanScene[3])} 패스=${show(cleanScene[4])}`,
    );

    // 확대 — 캔버스 크롬이었다면 디테일 캔버스(40)가 위를 덮어 **여기서 사라진다**.
    const zoomed = await cdp.eval(`(async () => {
      const A = window.__gpvNode;
      const m = A.modal();
      const sel = m && m.querySelector('select');
      if (!sel) return { ERR: '줌 select 없음' };
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(sel, '4');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await A.frame();
      await A.frame();
      A.ed().renderOnce();
      await A.frame();
      return { anchors: A.anchors(), scrims: A.scrims(), screen: A.screen(), cut: A.scrimCut() };
    })()`);
    r.check(
      "(47 p-5) 400% 로 확대해도 앵커가 **개수도 크기(11 css px)도 그대로**이고 스크림도 남는다 — 노드를 편집하려고 확대한 바로 그 순간 크롬이 사라지는 것이 캔버스 크롬을 버린 이유다",
      Array.isArray(zoomed.anchors) &&
        zoomed.anchors.length === 3 &&
        zoomed.scrims >= 1 &&
        zoomed.screen && zoomed.screen.scale > 2,
      `앵커=${zoomed.anchors ? zoomed.anchors.length : J(zoomed)} 스크림=${zoomed.scrims} 배율=${zoomed.screen && zoomed.screen.scale}`,
    );
    r.check(
      "(47 p-5b) 구멍의 선 두께는 **배율과 무관하게** 객체 `strokeWidth` 다 — 400% 에서도 100% 와 같은 값이어야 스크림 위로 실획이 그대로 보인다(`× scale` 를 빼면 여기서만 1/4 로 줄고, 앵커·스크림 개수 단언은 전부 초록이다)",
      !!zoomed.cut && zoomed.cut.d.length > 0 && near(zoomed.cut.sw, 2, 0.01),
      `400% stroke-width=${zoomed.cut && zoomed.cut.sw} (100% 에서 ${cut0 && cut0.sw})`,
    );
    await cdp.eval(`(() => {
      const m = window.__gpvNode.modal();
      const sel = m && m.querySelector('select');
      if (!sel) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(sel, 'fit');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);

    // ══ (q) undo 로 대상이 사라지면 세션이 스스로 나간다 ═════════════════════
    await setDoc({ objects: [] });
    await sleep(120);
    await setDoc({ objects: [L()] });
    await sleep(120);
    await cdp.eval(`window.__gpvNode.enter('pl')`);
    await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 0 }])`);
    await sleep(200);
    const barIn = await S(`barText()`);
    await S(`focusRoot()`);
    await S(`kUndo()`);
    await sleep(300);
    const gone = await state();
    const barOut = await S(`barText()`);
    r.check(
      "(47 q) 되돌리기로 편집 대상이 문서에서 사라지면 세션이 **스스로 나간다** — 안 나가면 죽은 id 를 든 채 크롬만 남고 그다음 Delete 가 아무 일도 하지 않는다. 컨텍스트 바도 벡터 편집 바에서 원래 바로 되돌아간다",
      /노드 3 · 세그먼트 2/.test(barIn) &&
        gone.node === null &&
        gone.ui.mode.kind === "design" &&
        !/노드 \d+ · 세그먼트 \d+/.test(barOut),
      `바(편집중)=${J(barIn.slice(0, 80))} node=${J(gone.node)} mode=${J(gone.ui.mode)} 바(종료)=${J(barOut.slice(0, 80))}`,
    );

    // ══ 인스펙터 `Sec 노드` ══════════════════════════════════════════════════
    await seedL([{ sub: 0, vert: 1 }]);
    await cdp.eval(`window.__gpvNode.ed().inspector.setTab('props')`);
    await sleep(250);
    const insp = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      const p = A.tabPanel('props');
      return {
        text: p ? (p.textContent || '') : '',
        x: A.field('X'), y: A.field('Y'),
        inX: A.field('in X'), outX: A.field('out X'),
      };
    })()`);
    await S(`sel([])`);
    await sleep(200);
    const inspEmpty = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      const p = A.tabPanel('props');
      return { text: p ? (p.textContent || '') : '', x: A.field('X') };
    })()`);
    r.check(
      "(47 ins) 속성 탭 `노드` 섹션이 단일 선택에서 X/Y·핸들 in/out 을 그리고 **선택이 없으면 필드째 사라진다** — 빈 칸으로 남기면 사용자가 그 값이 무엇에 붙는지 모른 채 숫자를 적는다",
      /열린 패스/.test(insp.text) &&
        Number(insp.x) === 140 && Number(insp.y) === 60 &&
        insp.inX !== null && insp.outX !== null &&
        /정점을 고르면/.test(inspEmpty.text) && inspEmpty.x === null,
      `X=${J(insp.x)} Y=${J(insp.y)} inX=${J(insp.inX)} 선택없음X=${J(inspEmpty.x)}`,
    );

    // ══ 단축키 표 — 게이트와 물리 키 ═════════════════════════════════════════
    await seedL([{ sub: 0, vert: 0 }]);
    const keys = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      return {
        delNode: A.match({ key: 'Delete', code: 'Delete' }),
        arrowNode: A.match({ key: 'ArrowRight', code: 'ArrowRight' }),
      };
    })()`);
    const delPrevented = (await S(`kDelete()`)).prevented;
    await S(`kUndo()`);
    await sleep(200);
    // 모드는 **Esc 가 아니라 API 로** 나간다. 선택이 비어 있는 design 에서 Esc 를 한 번 더
    // 누르면 계층 7단(`requestClose`)까지 내려가 편집기가 닫히고, 뒤 절이 통째로 못 돈다.
    await cdp.eval(`window.__gpvNode.ed().exitNodeEdit()`);
    await sleep(150);
    await cdp.eval(`window.__gpvNode.ed().setDoc({ objects: [] })`);
    await sleep(200);
    const keysDesign = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      return {
        delDesign: A.match({ key: 'Delete', code: 'Delete' }),
        penIme: A.match({ key: 'ㅍ', code: 'KeyP' }),
      };
    })()`);
    r.check(
      "(47 k-1) 표의 `nodeEdit` 게이트 행이 실제로 이긴다 — 노드 편집 중 Delete·방향키가 `delete`/`nudge` 로 잡히고 **소비**된다(안 잡히면 그 키가 편집기 밖 window 리스너 25곳으로 샌다). 선택 없는 design 에서는 아무 행도 안 맞는다",
      keys.delNode === "delete" &&
        keys.arrowNode === "nudge" &&
        delPrevented === true &&
        keysDesign.delDesign === null,
      `nodeEdit: Delete=${J(keys.delNode)} Arrow=${J(keys.arrowNode)} 소비=${delPrevented} / design Delete=${J(keysDesign.delDesign)}`,
    );
    r.check(
      "(47 k-2) 펜(P)이 `e.key` 가 아니라 **`e.code`** 로 잡힌다 — 한글 IME 는 P 를 `key='ㅍ'` 로 보낸다(키로 매칭하면 한글 상태에서 펜이 통째로 죽는다)",
      keysDesign.penIme === "tool.vpen",
      `key='ㅍ' code='KeyP' → ${J(keysDesign.penIme)}`,
    );

    // k-2 는 **표 조회**다(`matchShortcut` 은 판정만 떼어 본다). 표에 행이 있어도 액션 맵에
    // 핸들러가 없으면 `useEditorKeys` 는 그 키를 **삼키기만 하고 아무 일도 하지 않는다** —
    // 사용자에게는 "P 를 눌러도 안 된다"이고 k-2 는 그대로 초록이다. 그래서 실제 경로를 잰다.
    await cdp.eval(`window.__gpvNode.ed().setTool('select')`);
    await S(`focusRoot()`);
    const penByKey = await cdp.eval(`(async () => {
      const A = window.__gpvNode;
      const en = await A.fire({ key: 'p', code: 'KeyP' });
      const t1 = A.ui().tool;
      A.ed().setTool('select');
      await A.frame();
      const ko = await A.fire({ key: 'ㅍ', code: 'KeyP' });
      return { en: en.prevented, t1: t1, ko: ko.prevented, t2: A.ui().tool };
    })()`);
    r.check(
      "(47 k-3) P 를 **실제로 눌러** 도구가 `vpen` 이 된다 — 영문·한글(IME `key='ㅍ'`) 둘 다. 표 행만 있고 액션 핸들러가 없으면 키는 소비되고(preventDefault) 도구는 그대로다",
      penByKey.en === true &&
        penByKey.t1 === "vpen" &&
        penByKey.ko === true &&
        penByKey.t2 === "vpen",
      `영문 소비=${penByKey.en} 도구=${J(penByKey.t1)} / 한글 소비=${penByKey.ko} 도구=${J(penByKey.t2)}`,
    );

    await cdp.eval(`window.__gpvNode.ed().setTool('select')`);
    await sleep(120);
    const rail = await cdp.eval(`(async () => {
      const A = window.__gpvNode;
      const before = A.ui().toggles.curvature;
      const hasPen = !!A.railBtn('펜 (P)');
      const hasCurv = !!A.railBtn('곡률');
      const clickedPen = await A.railClick('펜 (P)');
      const tool = A.ui().tool;
      const clickedCurv = await A.railClick('곡률');
      const curv = A.ui().toggles.curvature;
      A.ed().setToggle('curvature', before);
      return { hasPen, hasCurv, clickedPen, tool, clickedCurv, on: curv !== before };
    })()`);
    r.check(
      "(47 k-4) 레일에 `펜`·`곡률` 항목이 **렌더되고** 클릭이 실제로 도구·토글을 바꾼다 — `ready:false` 로 남으면 버튼 자체가 없어서 키 말고는 펜을 고를 방법이 없다(레일은 47 이 켠다: 42 §5 소유표)",
      rail.hasPen === true &&
        rail.hasCurv === true &&
        rail.clickedPen === true &&
        rail.tool === "vpen" &&
        rail.clickedCurv === true &&
        rail.on === true,
      `펜버튼=${rail.hasPen} 클릭=${rail.clickedPen} 도구=${J(rail.tool)} / 곡률버튼=${rail.hasCurv} 토글바뀜=${rail.on}`,
    );
    await cdp.eval(`window.__gpvNode.ed().setTool('select')`);
    await sleep(120);

    // ══ (i)~(l) 펜 — pointer.ts 진입이 있어야 도는 절 ════════════════════════
    await setDoc({ objects: [] });
    await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
    await sleep(200);
    const penHist0 = await S(`hist()`);
    await S(`clickAt([[60, 60], [140, 60], [140, 140]])`);
    await sleep(200);
    await S(`kEnter()`);
    await sleep(300);
    const penDone = await cdp.eval(`(() => {
      const A = window.__gpvNode;
      const objs = A.doc().objects;
      const o = objs[0];
      return {
        n: objs.length,
        kind: o ? o.kind : null,
        id: o ? o.id : null,
        verts: o && o.kind === 'path' ? o.subpaths[0].verts : null,
        closed: o && o.kind === 'path' ? o.subpaths[0].closed : null,
        hist: A.hist(),
        node: A.node(),
        tool: A.ui().tool,
      };
    })()`);
    const penWired =
      penDone.n === 1 && penDone.kind === "path" && !!penDone.verts && penDone.verts.length >= 2;
    r.check(
      "(47 i) `vpen` 3점 클릭 + Enter = 정점 3개 열린 패스 **한 칸**이고, 곧바로 그 객체의 노드 편집으로 들어간다(시안 ③ 이 펜 직후 상태다). 도구는 `vpen` 그대로",
      penWired &&
        penDone.verts.length === 3 &&
        penDone.closed === false &&
        penDone.verts.every((v) => v.mode === "corner") &&
        near(penDone.verts[0].x, 60) && near(penDone.verts[2].y, 140) &&
        penDone.hist - penHist0 === 1 &&
        !!penDone.node && penDone.node.id === penDone.id &&
        penDone.tool === "vpen",
      `객체=${penDone.n} kind=${penDone.kind} 정점=${penDone.verts ? penDone.verts.length : "없음"} 닫힘=${penDone.closed} Δhist=${penDone.hist - penHist0} node=${penDone.node ? penDone.node.id : null} tool=${penDone.tool}`,
    );

    if (!penWired) {
      // (i) 가 빨간 이유는 하나다 — `pointer.ts` 에 `vpen`/노드 편집 진입(§3.4 "진입 3줄")이
      // 없으면 클릭이 `makeDraft` 의 default 로 떨어져 **아무 일도 일어나지 않는다**.
      // 같은 뿌리를 가진 뒤 단언들을 굳이 다 빨갛게 만들지 않는다(원인은 (i) 한 줄이 말한다).
      r.skip(
        "(47 j~l) 펜 드래그·닫기·드래프트 되돌리기",
        "(47 i) 실패 — `vpen` 클릭이 드래프트를 만들지 못한다(pointer.ts 진입 미배선)",
      );
    } else {
      // ── (j) 드래그 = 곡선 ──────────────────────────────────────────────────
      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
      await sleep(150);
      await S(`clickAt([[40, 100]])`);
      await S(`dragTo([100, 100], [140, 100])`);
      await S(`clickAt([[160, 100]])`);
      await S(`kEnter()`);
      await sleep(300);
      const curved = await cdp.eval(`(() => {
        const o = window.__gpvNode.doc().objects[0];
        return o && o.kind === 'path' ? o.subpaths[0].verts[1] : null;
      })()`);
      r.check(
        "(47 j-1) 누른 채 끌면 **대칭 핸들**이 붙는다 — out 은 끈 만큼(40,0), in 은 그 반대(−40,0). 클릭과 드래그가 같은 결과면 곡선을 그릴 방법이 없다",
        !!curved &&
          curved.mode === "mirrored" &&
          near(curved.outX, 40) && near(curved.outY, 0) &&
          near(curved.inX, -40) && near(curved.inY, 0),
        J(curved),
      );

      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
      await sleep(150);
      await S(`clickAt([[40, 100]])`);
      await S(`dragTo([100, 100], [140, 100], { alt: true })`);
      await S(`clickAt([[160, 100]])`);
      await S(`kEnter()`);
      await sleep(300);
      const alted = await cdp.eval(`(() => {
        const o = window.__gpvNode.doc().objects[0];
        return o && o.kind === 'path' ? o.subpaths[0].verts[1] : null;
      })()`);
      r.check(
        "(47 j-2) Alt 드래그는 **들어오는 핸들을 고정**한다(Figma break) — out 만 생기고 in 은 0 이라 모드가 `corner` 다",
        !!alted &&
          near(alted.outX, 40) &&
          alted.inX === 0 && alted.inY === 0 &&
          alted.mode === "corner",
        J(alted),
      );

      // ── 곡률 토글 ─────────────────────────────────────────────────────────
      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpvNode.ed().setToggle('curvature', true)`);
      await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
      await sleep(150);
      await S(`clickAt([[40, 120], [100, 60], [160, 120]])`);
      await S(`kEnter()`);
      await sleep(300);
      await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
      await sleep(150);
      const curv = await cdp.eval(`(() => {
        const A = window.__gpvNode;
        const o = A.doc().objects[0];
        const st = A.node();
        return {
          mid: o && o.kind === 'path' ? o.subpaths[0].verts[1] : null,
          handleOut: st ? st.handleOut : null,
        };
      })()`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('curvature', false)`);
      r.check(
        "(47 j-3) `곡률` 토글이 켜져 있으면 펜 **클릭**이 `auto` 정점을 만든다 — 별도 도구 상태가 아니라 토글 하나다(문서에는 (0,0) 이 남고 핸들은 이웃에서 계산돼 요약에 뜬다)",
        !!curv.mid && curv.mid.mode === "auto" &&
          curv.mid.outX === 0 && curv.mid.outY === 0 &&
          !!curv.handleOut &&
          Math.hypot(curv.handleOut[0], curv.handleOut[1]) > 1,
        `가운데=${J(curv.mid)} 요약out=${J(curv.handleOut)}`,
      );

      // ── (k) 첫 정점 클릭 = 닫기 · Esc = 취소 ──────────────────────────────
      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
      await sleep(150);
      const closeH0 = await S(`hist()`);
      await S(`clickAt([[60, 60], [140, 60], [140, 140], [60, 60]])`);
      await sleep(300);
      const closedPen = await cdp.eval(`(() => {
        const A = window.__gpvNode;
        const o = A.doc().objects[0];
        return {
          n: A.doc().objects.length,
          closed: o && o.kind === 'path' ? o.subpaths[0].closed : null,
          verts: o && o.kind === 'path' ? o.subpaths[0].verts.length : -1,
          hist: A.hist(),
        };
      })()`);
      r.check(
        "(47 k-1) 첫 정점 위 클릭이 패스를 **닫으면서 완료**한다 — 같은 자리에 정점을 하나 더 얹지 않는다(길이 0 짜리 변이 남으면 불리언·평탄화가 퇴화 입력을 받는다). 히스토리는 한 칸",
        closedPen.n === 1 &&
          closedPen.closed === true &&
          closedPen.verts === 3 &&
          closedPen.hist - closeH0 === 1,
        `객체=${closedPen.n} 닫힘=${closedPen.closed} 정점=${closedPen.verts} Δhist=${closedPen.hist - closeH0}`,
      );

      await setDoc({ objects: [rectNode("keep", 10, 10, 20, 20)] });
      await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
      await sleep(150);
      const escPen = await S(`around(async () => {
        await window.__gpvNode.clickAt([[60, 60]]);
        await window.__gpvNode.kEsc();
      })`);
      const afterEscPen = await cdp.eval(`window.__gpvNode.doc().objects.length`);
      r.check(
        "(47 k-2) 정점 하나를 찍고 Esc = **취소**다 — 문서도 히스토리도 그대로다(취소 키가 커밋하면 사용자는 되돌린 줄 알고 손을 떼는데 객체가 남는다)",
        escPen.dHist === 0 && escPen.docSame === true && afterEscPen === 1,
        `Δhist=${escPen.dHist} 문서동일=${escPen.docSame} 객체=${afterEscPen}`,
      );

      // ── (l) 드래프트 중 Ctrl+Z 는 문서로 새지 않는다 ──────────────────────
      await setDoc({ objects: [rectNode("mark", 10, 10, 20, 20)] });
      await cdp.eval(`window.__gpvNode.ed().setTool('vpen')`);
      await sleep(200);
      const popH0 = await S(`hist()`);
      await S(`clickAt([[60, 60], [140, 60], [140, 140]])`);
      await S(`kUndo()`);
      await sleep(200);
      await S(`kEnter()`);
      await sleep(300);
      const popped = await cdp.eval(`(() => {
        const A = window.__gpvNode;
        const objs = A.doc().objects;
        const p = objs.find((o) => o.kind === 'path');
        return {
          mark: !!objs.find((o) => o.id === 'mark'),
          verts: p ? p.subpaths[0].verts.length : -1,
          hist: A.hist(),
        };
      })()`);
      r.check(
        "(47 l) 드래프트 중 Ctrl+Z 는 **마지막 정점만** 무른다 — 앞서 만든 `mark` 가 살아 있고(문서 undo 로 샜다면 그것이 사라진다) 완료된 패스는 정점 2개, 히스토리는 한 칸",
        popped.mark === true && popped.verts === 2 && popped.hist - popH0 === 1,
        `mark=${popped.mark} 정점=${popped.verts} Δhist=${popped.hist - popH0}`,
      );
    }

    // ══ (m)~(o)(s) 노드 편집 포인터 ══════════════════════════════════════════
    await cdp.eval(`window.__gpvNode.ed().setTool('select')`);
    await seedL();
    await sleep(150);
    const clickSel = await S(`around(async () => {
      await window.__gpvNode.clickAt([[140, 60]]);
    })`);
    const clicked = await node();
    const hitWired = !!clicked && !!clicked.selected && clicked.selected.length === 1;
    r.check(
      "(47 n-1) 정점을 클릭하면 **그 정점이 선택되고**(길이 0 드래그) 문서·히스토리는 하나도 안 바뀐다 — 두 축을 함께 재야 '클릭이 씹혔다'와 '클릭이 객체를 움직였다'가 같은 초록으로 뭉개지지 않는다(스냅 델타가 dx=dy=0 에서 적용돼 실제로 겪은 결함)",
      hitWired &&
        clicked.selected[0].sub === 0 && clicked.selected[0].vert === 1 &&
        clickSel.dHist === 0 && clickSel.docSame === true,
      `선택=${J(clicked && clicked.selected)} Δhist=${clickSel.dHist} 문서동일=${clickSel.docSame}`,
    );

    if (!hitWired) {
      r.skip(
        "(47 n~s) 정점·핸들 드래그 · 겹친 핸들 우선 · 오브젝트 스냅 · 더블클릭 진입",
        "(47 n-1) 실패 — 캔버스 포인터가 정점을 집지 못한다(pointer.ts 진입 미배선)",
      );
    } else {
      // ── 정점 드래그 = 한 칸 ────────────────────────────────────────────────
      const dragRes = await S(`around(async () => {
        await window.__gpvNode.dragTo([140, 60], [170, 80]);
      })`);
      const draggedV = await S(`verts('pl', 0)`);
      r.check(
        "(47 n-2) 정점 드래그 한 번이 좌표를 정확히 (+30,+20) 옮기고 **히스토리 한 칸**을 쓴다 — 매 move 마다 커밋하면 드래그 한 번이 200칸을 통째로 태운다",
        dragRes.dHist === 1 &&
          dragRes.label === "노드 이동" &&
          !!draggedV && near(draggedV[1].x, 170) && near(draggedV[1].y, 80),
        `Δhist=${dragRes.dHist} 라벨=${J(dragRes.label)} v1=${J(draggedV && draggedV[1])}`,
      );

      await S(`focusRoot()`);
      await S(`kUndo()`);
      await sleep(250);
      const backV = await S(`verts('pl', 0)`);
      r.check(
        "(47 n-3) Ctrl+Z **한 번**으로 드래그 전 좌표로 정확히 돌아온다(누적 델타가 아니라 `base` 에서 다시 계산한다는 증거)",
        !!backV && near(backV[1].x, 140) && near(backV[1].y, 60),
        J(backV && backV[1]),
      );

      // ── (n-4) 픽셀 스냅 = 정수 좌표 ────────────────────────────────────────
      //
      // 목표를 정수로 잡으면 스냅이 **죽어 있어도** 초록이다. 그래서 소수로 끝나는 드래그를
      // 만든다. 격자(`grid`)는 사용자 취향이라 localStorage 에서 새어 들어오는데, 8px 격자가
      // 켜져 있으면 170.4 가 168 로 끌려가 이 단언이 픽셀 스냅과 무관해진다 — 명시적으로 끈다.
      const grid0 = await S(`ui().toggles.grid`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('grid', 0)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snap', true)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snapPixel', true)`);
      await seedL([{ sub: 0, vert: 1 }]);
      const pixRes = await S(`around(async () => {
        await window.__gpvNode.dragTo([140, 60], [170.4, 80.6]);
      })`);
      const pixV = await S(`verts('pl', 0)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snapPixel', false)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snap', false)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('grid', ${J(grid0 || 0)})`);
      r.check(
        "(47 n-4) `픽셀에 스냅`이 켜져 있으면 정점 좌표가 **정수로 떨어진다**(170.4 → 170 · 80.6 → 81) — 드래그 한 번은 그대로 히스토리 한 칸이다. 픽셀 스냅은 최후 수단이라 다른 후보가 없을 때만 걸린다(snap.ts `snapAxis`)",
        // 정확히 `Number.isInteger` 로 재지 않는다 — 보정은 `pt + (round(pt) − pt)` 라 부동소수
        // 잔차(1e-14)가 남는다. 재는 것은 "정수에 붙었다"이고, 안 붙으면 0.4·0.6 이 남는다.
        pixRes.dHist === 1 &&
          !!pixV &&
          Math.abs(pixV[1].x - Math.round(pixV[1].x)) < 1e-6 &&
          Math.abs(pixV[1].y - Math.round(pixV[1].y)) < 1e-6 &&
          near(pixV[1].x, 170) &&
          near(pixV[1].y, 81),
        `Δhist=${pixRes.dHist} v1=${J(pixV && pixV[1])} (스냅 없으면 170.4, 80.6)`,
      );

      // ── (o) 핸들이 앵커 위에 겹칠 때 핸들이 먼저 ──────────────────────────
      //
      // 위험표 2번: 짧은 핸들은 앵커 위에 겹친다. 앵커가 먼저 이기면 그 정점의 핸들은
      // **영원히 못 잡는다** — 눌러도 아무 일이 없는 것이 아니라 엉뚱한 것이 움직인다.
      await setDoc({
        objects: [
          pathNode(
            "po",
            [
              V(60, 100),
              V(100, 100, { mode: "mirrored", outX: 20, outY: 0, inX: -20, inY: 0 }),
              V(120, 100),
            ],
            false,
          ),
        ],
      });
      await cdp.eval(`window.__gpvNode.enter('po')`);
      await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
      await sleep(200);
      await S(`dragTo([120, 100], [120, 140])`);
      await sleep(250);
      const overlap = await S(`verts('po', 0)`);
      r.check(
        "(47 o) 핸들 끝점이 이웃 앵커(120,100)와 **같은 자리**여도 잡히는 것은 핸들이다 — 핸들 끝이 포인터를 따라 (120,140) 으로 가고(앵커 (100,100) 기준 out=(20,40)) 앵커 3개 좌표는 하나도 안 바뀐다(앵커가 먼저 이기면 그 정점의 핸들은 영원히 못 잡는다)",
        !!overlap &&
          // `moveHandle` 의 `to` 는 **절대 좌표**다(§3.3) — 핸들 값은 앵커를 뺀 상대다.
          near(overlap[1].x + overlap[1].outX, 120, 1) &&
          near(overlap[1].y + overlap[1].outY, 140, 1) &&
          near(overlap[0].x, 60) && near(overlap[1].x, 100) && near(overlap[2].x, 120) &&
          near(overlap[2].y, 100),
        `v1핸들끝=${J([overlap && overlap[1].x + overlap[1].outX, overlap && overlap[1].y + overlap[1].outY])} 앵커=${J((overlap || []).map((v) => [v.x, v.y]))}`,
      );

      // ── (o-2) 핸들은 **픽셀 스냅만** 받는다 ────────────────────────────────
      //
      // `applyNodeDrag` 는 핸들 분기와 정점 분기에 같은 콜백을 받으므로, 호출자가 핸들에도
      // 오브젝트/캔버스 인덱스를 주면 노브가 옆 도형 모서리에 달라붙어 곡선이 튄다(§3.4 가
      // 명시적으로 금지한 증상). 타입으로도 함수 안에서도 강제되지 않아 여기서만 잡힌다.
      await setDoc({
        objects: [
          pathNode(
            "ph",
            [
              V(60, 140),
              V(100, 140, { mode: "mirrored", outX: 20, outY: 0, inX: -20, inY: 0 }),
              V(160, 140),
            ],
            false,
          ),
          rectNode("sn2", 40, 40, 60, 60),
        ],
      });
      await cdp.eval(`window.__gpvNode.ed().setToggle('snap', true)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snapObjects', true)`);
      await cdp.eval(`window.__gpvNode.enter('ph')`);
      await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
      await sleep(200);
      // 핸들 끝(120,140) → x=102. 옆 사각형 오른쪽 변도 캔버스 세로 중앙도 x=100 이라,
      // 인덱스가 새면 2px 이 먹혀 정확히 100 에 붙는다(흡착 반경 4).
      await S(`dragTo([120, 140], [102, 140])`);
      await sleep(250);
      const hSnap = await S(`verts('ph', 0)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snapObjects', false)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snap', false)`);
      r.check(
        "(47 o-2) `오브젝트에 스냅`이 켜져 있어도 **핸들 노브는 붙지 않는다** — 끝점이 102 그대로다(정점 드래그가 100 에 붙는 (47 s) 와 같은 조건·같은 배치다). 핸들이 남의 모서리에 붙으면 만진 적 없는 곡선이 튄다",
        !!hSnap && near(hSnap[1].x + hSnap[1].outX, 102, 0.6),
        `핸들끝 x=${hSnap && hSnap[1].x + hSnap[1].outX} (스냅이 새면 100)`,
      );

      // ── (s) 오브젝트 스냅 ─────────────────────────────────────────────────
      await setDoc({ objects: [L(), rectNode("sn", 40, 40, 60, 60)] });
      // 마스터 토글(`snap`)이 꺼져 있으면 `makeIndex` 가 인덱스를 아예 안 만든다 —
      // 종류 토글만 켜면 스냅이 안 걸리고, 그 초록/빨강은 이 단언과 아무 상관이 없다.
      await cdp.eval(`window.__gpvNode.ed().setToggle('snap', true)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snapObjects', true)`);
      await cdp.eval(`window.__gpvNode.enter('pl')`);
      await cdp.eval(`window.__gpvNode.sel([{ sub: 0, vert: 1 }])`);
      await sleep(200);
      await S(`dragTo([140, 60], [102, 60])`);
      await sleep(250);
      const snapped = await S(`verts('pl', 0)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snapObjects', false)`);
      await cdp.eval(`window.__gpvNode.ed().setToggle('snap', false)`);
      r.check(
        "(47 s) `오브젝트에 스냅`이 켜져 있으면 정점이 옆 사각형의 오른쪽 변(x=100)에 붙는다 — 스냅 상태를 노드 전용으로 새로 두지 않고 42 토글 그대로 쓴다는 계약(같은 값에 두 이름이 생기면 상태바에서 끈 스냅이 노드 편집에서만 살아 있다)",
        !!snapped && near(snapped[1].x, 100, 0.6),
        `x=${snapped && snapped[1].x} (스냅 없으면 102)`,
      );

      // ── 더블클릭 진입 ─────────────────────────────────────────────────────
      //
      // **먼저 확실히 나간다.** 같은 id 로 문서를 다시 넣으면 세션이 그대로 살아 있어서,
      // "더블클릭으로 들어갔다"가 "애초에 나온 적이 없다"와 같은 초록이 된다.
      await setDoc({ objects: [L()] });
      await cdp.eval(`window.__gpvNode.ed().exitNodeEdit()`);
      await cdp.eval(`window.__gpvNode.ed().setTool('select')`);
      await sleep(200);
      const beforeDbl = await S(`ui().mode`);
      const dblIn = await S(`around(async () => {
        await window.__gpvNode.dblClickAt(100, 60);
      })`);
      const dblState = await state();
      r.check(
        "(47 m-7) 선택 도구로 `path` 를 더블클릭하면 노드 편집에 들어간다(§3.2 진입 경로) — 직전이 `design` 이었다는 것까지 함께 재고, 진입은 커밋이 아니다",
        beforeDbl && beforeDbl.kind === "design" &&
          dblState.node && dblState.node.id === "pl" &&
          dblState.ui.mode.kind === "nodeEdit" &&
          dblIn.dHist === 0,
        `직전=${J(beforeDbl)} node=${dblState.node && dblState.node.id} mode=${J(dblState.ui.mode)} Δhist=${dblIn.dHist}`,
      );
    }

    // ══ (p-6) 저장 파일에 크롬이 새지 않는다 ═════════════════════════════════
    //
    // 마지막에 둔다 — `saveAs` 는 편집기를 닫는다.
    await cdp.eval(`window.__gpvNode.ed().setTool('select')`);
    await seedL([{ sub: 0, vert: 1 }]);
    await cdp.eval(`window.__gpvNode.ed().renderOnce()`);
    await sleep(250);
    const inNodeEdit = await node();
    const saved = await S(`saveAs(${J(OUT)})`);
    await sleep(600);
    const px = await S(
      `readSaved(${J(fix.projectId)}, ${J(OUT)}, [[5, 5], [60, 64], [56, 60], [140, 146], [60, 44], [100, 60]])`,
    ).catch((e) => ({ ERR: String(e && e.message) }));
    r.check(
      "(47 p-6) **노드 편집 중에 저장해도 파일에는 크롬이 없다** — 스크림 자리·앵커 속·HUD 뱃지·아트보드 라벨이 전부 흰색이고, 패스만 남는다(SVG 크롬이라 저장 경로에 샐 자리가 없다는 증거)",
      !!inNodeEdit && inNodeEdit.id === "pl" &&
        saved.ok === true &&
        !!px.px &&
        px.w === 200 && px.h === 200 &&
        isWhite(px.px[0]) && isWhite(px.px[1]) && isWhite(px.px[2]) &&
        isWhite(px.px[3]) && isWhite(px.px[4]) &&
        isBlue(px.px[5]),
      `저장=${J(saved)} 크기=${px.w}×${px.h} 점=${(px.px || []).map(show).join(" ")}`,
    );
  } finally {
    if (toggles0) {
      for (const k of ["snap", "snapPixel", "snapObjects", "snapGuides", "curvature"]) {
        await cdp
          .eval(
            `window.__gpv.imageEditor && window.__gpv.imageEditor.setToggle(${J(k)}, ${J(!!toggles0[k])})`,
          )
          .catch(() => {});
      }
    }
    // 편집기를 확실히 닫는다 — 열린 채 남으면 다음 스위트의 모달 질의가 이 편집기를 집는다.
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
