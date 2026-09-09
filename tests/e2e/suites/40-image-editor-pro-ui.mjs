// 편집기 **셸**(창 전체 레이아웃·키 스코프·모드) — DOCS/task/42-image-editor-shell.md §7.
//
// 이 스위트가 지키는 계약 넷:
//   ① **편집기가 열려도 앱 키가 죽지 않는다.** 편집기는 window capture 리스너 하나로 자기 키만
//      가로챈다 — 앱 전역 리스너 25곳은 한 줄도 고치지 않았다. 그래서 F5·Ctrl+P·mod+Alt+N·
//      mod+Shift+F·mod+Shift+A 는 편집기 위에서도 여전히 앱에 도달해야 하고, 반대로 편집기가
//      쓰는 키는 앱 리스너에 **한 번도** 닿으면 안 된다. 이 두 방향을 window 버블 프로브로
//      동시에 잰다: 통과 키는 1회, 소비 키는 0회 + `defaultPrevented`.
//      한쪽만 재면 "다 막아 버려 앱이 먹통" 과 "아무것도 못 막아 Ctrl+W 가 뒤의 탭을 닫음" 중
//      하나가 조용히 통과한다.
//   ② **키는 물리 자판으로 잡는다.** 한글 IME 를 켜면 V 가 `key='ㅍ'`, Mac ⌥A 는 `key='å'` 로
//      온다 — `key` 로 비교하면 그 두 환경에서 도구 전환이 통째로 죽는다. 반대로 e2e 30 의
//      `A.key` 는 `code` 없이 보내므로 폴백도 살아 있어야 한다.
//   ③ **모드는 도구와 직교한다.** 크롭 중에 도구 키를 눌러도 크롭이 조용히 취소되지 않고,
//      Esc 계층은 배너가 알리는 그 모드를 정확히 끝낸다.
//   ④ **없는 기능은 안 보인다.** 레일에는 소유 태스크가 도착한 도구만 그려지고, 툴팁은
//      `<라벨> (<키>)` 한 형식이다(e2e 30 의 `activeTool` 이 이 문자열을 읽는다).
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 이고, 맞춤 배율(`fit`)이 1이라
// **맞춤 == 100%** 다(30·36·37 스위트와 같은 전제).
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "이미지 편집기 셸 (키 스코프·단축키 표 / 툴 레일·플라이아웃 / 모드 배너 · 줌 · 상태바·토글)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

/**
 * M2 시점 레일에 보여야 하는 항목 — `TOOLS.filter(ready)` 와 1:1 이다.
 *
 * 하드코딩인 이유: `TOOLS` 는 페이지에 노출되지 않는다(스토어가 아니라 모듈 상수다).
 * 대신 이 목록이 후속 태스크의 **수용 기준**이 된다 — 43·45·46·47·52 가 자기 도구의
 * `ready` 를 true 로 바꾸면 여기에 한 줄을 더해야 한다. 그 한 줄이 "레일에 그려지는 도구"
 * 결정을 의식적으로 만들고, 아무 동작 없는 도구가 슬며시 레일에 오르는 것을 막는다.
 */
const RAIL_TITLES = [
  "선택 (V)",
  "이동 (K)",
  "프레임 (F)",
  "연필 (Shift+P)",
  "지우개 (E)",
  "사각형 (R)",
  "타원 (O)",
  "직선 (L)",
  "화살표 (A)",
  "텍스트 (T)",
  "이미지",
  "번호 뱃지 (N)",
  "모자이크 (M)",
  "블러",
  "크롭 (C)",
  "손 (Space)",
];

/**
 * 편집기가 **소비해야 하는** 행(§3.3 출처표 · §3.4 표 중 owner 42).
 *
 * 여기 없는 행은 두 부류다: (a) 소유 태스크가 아직 안 온 행(43~52) — 액션이 없으니
 * `preventDefault` 되지 않는 것이 정상이라 소비로 단언하면 안 된다. (b) 기계적으로 특별한
 * 행 — `hand`(홀드), `esc`·`enter`(모드 계층), `file.close`(편집기를 닫는다)는 아래에서
 * 따로 구동한다.
 */
const CONSUME_ROWS = [
  ["tool.select", { key: "v", code: "KeyV" }],
  ["tool.scale", { key: "k", code: "KeyK" }],
  ["tool.frame", { key: "f", code: "KeyF" }],
  ["tool.pen", { key: "P", code: "KeyP", shiftKey: true }],
  ["tool.highlight", { key: "h", code: "KeyH" }],
  ["tool.eraser", { key: "e", code: "KeyE" }],
  ["tool.rect", { key: "r", code: "KeyR" }],
  ["tool.ellipse", { key: "o", code: "KeyO" }],
  ["tool.line", { key: "l", code: "KeyL" }],
  ["tool.arrow", { key: "a", code: "KeyA" }],
  ["tool.text", { key: "t", code: "KeyT" }],
  ["tool.badge", { key: "n", code: "KeyN" }],
  ["tool.mosaic", { key: "m", code: "KeyM" }],
  ["mode.crop", { key: "c", code: "KeyC" }],
  ["undo", { key: "z", code: "KeyZ", ctrlKey: true }],
  ["redo", { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }],
  ["redo(Ctrl+Y)", { key: "y", code: "KeyY", ctrlKey: true }],
  ["duplicate", { key: "d", code: "KeyD", ctrlKey: true }],
  ["copy", { key: "c", code: "KeyC", ctrlKey: true }],
  ["cut", { key: "x", code: "KeyX", ctrlKey: true }],
  ["copyPng", { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }],
  ["selectAll", { key: "a", code: "KeyA", ctrlKey: true }],
  ["delete", { key: "Delete", code: "Delete" }],
  ["delete(Backspace)", { key: "Backspace", code: "Backspace" }],
  ["nudge", { key: "ArrowLeft", code: "ArrowLeft" }],
  ["nudge(Shift)", { key: "ArrowRight", code: "ArrowRight", shiftKey: true }],
  ["group", { key: "g", code: "KeyG", ctrlKey: true }],
  ["ungroup", { key: "G", code: "KeyG", ctrlKey: true, shiftKey: true }],
  ["frame", { key: "g", code: "KeyG", ctrlKey: true, altKey: true }],
  ["mask", { key: "m", code: "KeyM", ctrlKey: true, altKey: true }],
  ["front", { key: "]", code: "BracketRight", ctrlKey: true, altKey: true }],
  ["back", { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true }],
  ["forward", { key: "]", code: "BracketRight" }],
  ["backward", { key: "[", code: "BracketLeft" }],
  ["zoom.in", { key: "=", code: "Equal", ctrlKey: true }],
  ["zoom.out", { key: "-", code: "Minus", ctrlKey: true }],
  ["zoom.100", { key: ")", code: "Digit0", shiftKey: true }],
  ["zoom.fit", { key: "!", code: "Digit1", shiftKey: true }],
  ["zoom.sel", { key: "@", code: "Digit2", shiftKey: true }],
  ["view.rulers", { key: "R", code: "KeyR", shiftKey: true }],
  ["view.pixelGrid", { key: "'", code: "Quote", ctrlKey: true }],
  ["view.snapPixel", { key: '"', code: "Quote", ctrlKey: true, shiftKey: true }],
  ["view.pixelPreview", { key: "y", code: "KeyY", ctrlKey: true, altKey: true }],
  ["file.save", { key: "s", code: "KeyS", ctrlKey: true }],
  ["file.saveAs", { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true }],
];

/** 편집기가 **통과시켜야 하는** 앱 키(§3.3 출처표 첫 행). */
const PASS_ROWS = [
  ["F5", { key: "F5", code: "F5" }],
  ["Ctrl+P", { key: "p", code: "KeyP", ctrlKey: true }],
  ["Ctrl+Alt+N", { key: "n", code: "KeyN", ctrlKey: true, altKey: true }],
  ["Ctrl+Shift+F", { key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }],
  ["Ctrl+Shift+A", { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }],
];

const HELPERS = `(() => {
  const A = {};
  window.__gpvShell = A;

  // 루트는 aria-label 로 잡는다 — 플라이아웃 백드롭도 'fixed inset-0 z-50' 이라
  // 클래스만으로는 둘이 구분되지 않는다.
  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find(
      (el) => el.getAttribute('aria-label') === '이미지 편집',
    ) || null;

  A.canvases = () => {
    const m = A.modal();
    return m ? Array.from(m.querySelectorAll('canvas')) : [];
  };
  A.ready = () => {
    const cs = A.canvases();
    return cs.length >= 2 && cs[1].width > 0;
  };
  A.gone = () => A.modal() === null;
  A.frame = () =>
    new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  A.ed = () => window.__gpv.imageEditor;
  A.doc = () => A.ed().getDoc();
  A.ui = () => A.ed().getUi();
  A.text = () => (A.modal() || {}).textContent || '';
  A.ids = () => A.doc().objects.map((o) => o.id);

  /** 루트 포커스 — 레일·상태바 버튼을 누른 뒤 Space 가 그 버튼을 다시 누르지 않게. */
  A.focusRoot = () => {
    const m = A.modal();
    if (m) m.focus();
    return document.activeElement === m;
  };

  // ── 레일 ──────────────────────────────────────────────────────────────────
  A.rail = () => {
    const m = A.modal();
    return m ? m.querySelector('[role="toolbar"][aria-label="도구"]') : null;
  };
  /** 도구 버튼만 — 맨 아래 색 스와치(title '선 색 · 채우기 색')는 도구가 아니다. */
  A.railButtons = () => {
    const rl = A.rail();
    if (!rl) return [];
    return Array.from(rl.querySelectorAll('button')).filter(
      (b) => (b.getAttribute('title') || '') !== '선 색 · 채우기 색',
    );
  };
  A.railTitles = () => A.railButtons().map((b) => (b.getAttribute('title') || '').trim());
  A.caretButtons = () => A.railButtons().filter((b) => /▾/.test(b.textContent || ''));
  A.clickRail = (title) => {
    const b = A.railButtons().find((x) => (x.getAttribute('title') || '').trim() === title);
    if (!b) return false;
    b.click();
    return true;
  };

  /** 플라이아웃 메뉴의 항목 수(0 = 닫혀 있음). 백드롭은 루트 안에 그려진다. */
  A.flyoutItems = () => {
    const m = A.modal();
    if (!m) return -1;
    const back = m.querySelector('div.fixed.inset-0.z-50');
    return back ? back.querySelectorAll('button').length : 0;
  };
  A.rightClick = (i) => {
    const b = A.caretButtons()[i];
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return true;
  };

  // ── 상태바 ────────────────────────────────────────────────────────────────
  //
  // 클래스 선택자를 쓰지 않는다(Tailwind 각괄호 클래스는 CSS 선택자 이스케이프가 필요하고,
  // 스타일이 바뀌면 조용히 못 찾는다). '실행 취소 N단계' 스팬의 부모가 곧 상태바다.
  A.statusBar = () => {
    const m = A.modal();
    if (!m) return null;
    for (const el of Array.from(m.querySelectorAll('span'))) {
      if (/^실행 취소 \\d+단계$/.test((el.textContent || '').trim())) return el.parentElement;
    }
    return null;
  };
  A.undoDepth = () => {
    const sb = A.statusBar();
    if (!sb) return null;
    for (const el of Array.from(sb.querySelectorAll('span'))) {
      const hit = /^실행 취소 (\\d+)단계$/.exec((el.textContent || '').trim());
      if (hit) return Number(hit[1]);
    }
    return null;
  };
  /** 좌표 칸은 상태바의 첫 자식이다(폭 고정 span). */
  A.coordText = () => {
    const sb = A.statusBar();
    return sb && sb.firstElementChild ? sb.firstElementChild.textContent || '' : '';
  };
  A.cursorHex = () => {
    const sb = A.statusBar();
    if (!sb) return null;
    for (const el of Array.from(sb.querySelectorAll('span'))) {
      const t = (el.textContent || '').trim();
      if (/^#[0-9A-F]{6}$/.test(t)) return t;
    }
    return null;
  };
  A.toggleBtn = (label) => {
    const sb = A.statusBar();
    if (!sb) return null;
    return (
      Array.from(sb.querySelectorAll('button')).find(
        (b) => (b.textContent || '').trim() === label,
      ) || null
    );
  };
  A.clickToggle = (label) => {
    const b = A.toggleBtn(label);
    if (!b) return false;
    b.click();
    A.focusRoot();
    return true;
  };

  /**
   * 선택 개수 — e2e 30 과 **같은 규칙**으로 읽는다(문구를 담은 가장 안쪽 요소, 첫머리 앵커).
   * 상태바가 'N개 선택' 을 자기 span 에 홀로 담지 않으면 여기서 엉뚱한 수가 잡힌다.
   */
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
  /** 'N개 선택' 을 **홀로** 담은 span 이 있는가(30 selCount 오염 방지 규칙). */
  A.selSpanExact = (n) =>
    Array.from((A.modal() || document).querySelectorAll('span')).some(
      (el) => (el.textContent || '').trim() === n + '개 선택',
    );

  // ── 치수 ──────────────────────────────────────────────────────────────────
  A.metrics = () => {
    const m = A.modal();
    if (!m) return null;
    const rail = A.rail();
    const leftTabs = m.querySelector('[role="tablist"][aria-label="좌 패널"]');
    const insp = m.querySelector('aside');
    const sb = A.statusBar();
    return {
      cls: m.className,
      tag: m.tagName,
      role: m.getAttribute('role'),
      rail: rail ? rail.offsetWidth : -1,
      left: leftTabs && leftTabs.parentElement ? leftTabs.parentElement.offsetWidth : -1,
      inspector: insp ? insp.offsetWidth : -1,
      title: m.firstElementChild ? m.firstElementChild.offsetHeight : -1,
      status: sb ? sb.offsetHeight : -1,
      savedLeft: Number(localStorage.getItem('gp:ie:left')),
      savedRight: Number(localStorage.getItem('gp:ie-right')),
    };
  };

  // ── 키 프로브 ─────────────────────────────────────────────────────────────
  //
  // window **버블** 리스너다. 편집기의 capture 리스너가 stopImmediatePropagation 하면
  // 여기까지 오지 않는다 — 그 0/1 이 곧 '앱 리스너에 닿았는가' 다(앱 리스너들도 버블이고,
  // 먼저 등록됐으므로 프로브보다 먼저 실행된다).
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
  A.fire = async (init, type) => {
    A._n = 0;
    const ev = new KeyboardEvent(
      type || 'keydown',
      Object.assign({ bubbles: true, cancelable: true }, init),
    );
    window.dispatchEvent(ev);
    await A.frame();
    return { hits: A._n, prevented: ev.defaultPrevented };
  };

  /**
   * 표 전 행 디스패치. 행마다 문서·선택·모드를 **되돌린 뒤** 쏜다 — 앞 행의 삭제/그룹이
   * 다음 행의 when 게이트(hasSelection·multi)를 무너뜨리면 소비되지 않은 것이
   * "구현 누락" 으로 오독된다.
   */
  A.sweep = async (rows, objects) => {
    const out = [];
    for (const row of rows) {
      A.ed().setDoc({ objects: objects });
      A.ed().setMode({ kind: 'design' });
      await A.fire({ key: 'a', code: 'KeyA', ctrlKey: true });
      const res = await A.fire(row[1]);
      out.push({ id: row[0], hits: res.hits, prevented: res.prevented });
      A.ed().setMode({ kind: 'design' });
      // 행이 프롬프트·확인창을 열었으면 **여기서 닫는다**(file.saveAs 가 '다른 이름으로'를 연다).
      // useEditorKeys 게이트 ①은 prompt/confirm 이 떠 있으면 **모든 키를 통과**시키므로,
      // 열린 채로 두면 그다음 행부터 sweep 전체가 조용히 통과 판정이 된다.
      const st = window.__gpv.ui.getState();
      if (st.prompt) st.closePrompt();
      if (st.confirm) st.closeConfirm();
    }
    return out;
  };

  // ── 포인터(30 스위트와 같은 계약: 백킹 px 좌표) ────────────────────────────
  //
  // opts.alt 는 43 §3.4 의 스냅 해제다 — 수식자가 **move/up 마다** 실려야 applyDragAt 이
  // 그 프레임의 스냅을 건너뛴다(down 에만 실으면 드래그 내내 스냅이 그대로 걸린다).
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
            altKey: !!(opts && opts.alt),
            pointerId: 1400, pointerType: 'mouse', isPrimary: true,
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
  A.hover = async (x, y, opts) => {
    const c = A.canvases()[1];
    if (!c) return false;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.left + (x / c.width) * r.width,
        clientY: r.top + (y / c.height) * r.height,
        button: -1, buttons: 0,
        altKey: !!(opts && opts.alt),
        pointerId: 1401, pointerType: 'mouse', isPrimary: true,
      }),
    );
    await A.frame();
    await A.frame();
    return true;
  };

  // ── 줌 ────────────────────────────────────────────────────────────────────
  /** 화면에 보이는 캔버스 폭(css px) = oriented 폭 × 화면 배율. */
  A.canvasW = () => {
    const c = A.canvases()[1];
    return c ? c.getBoundingClientRect().width : -1;
  };
  /** 타이틀바 줌 드롭다운 — React 제어 select 라 네이티브 setter 로 넣고 change 를 쏜다. */
  A.zoomSelect = async (value) => {
    const m = A.modal();
    const sel = m && m.querySelector('select');
    if (!sel) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await A.frame();
    await A.frame();
    return true;
  };

  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /** 클립보드 텍스트 붙여넣기 합성(37 의 파일 붙여넣기와 같은 방식). */
  A.pasteText = async (s) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', s);
    window.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 300));
    return true;
  };

  // ── 화면 크롬(43) ─────────────────────────────────────────────────────────
  //
  // 크롬은 캔버스가 아니라 stage 위 SVG 한 겹이다(transform 밖). 그래서 여기서 세는 것은
  // 픽셀이 아니라 **요소**다 — 그 크롬이 파일로 샜는지는 반대로 저장본 픽셀로 잰다.
  A.chromeRoot = () => {
    const m = A.modal();
    const g = m ? m.querySelector('[data-chrome="pixel-grid"]') : null;
    return g ? g.parentElement : null;
  };
  A.svg = () => {
    const r = A.chromeRoot();
    return r ? r.querySelector('svg') : null;
  };
  A.chromeAll = (sel) => {
    const s = A.svg();
    return s ? Array.from(s.querySelectorAll(sel)) : [];
  };
  A.chromeN = (sel) => A.chromeAll(sel).length;
  A.chromeTexts = (sel) => A.chromeAll(sel).map((el) => (el.textContent || '').trim());
  /** 마지막 프레임이 쓴 oriented → stage css 변환(43 §3.2). */
  A.screen = () => A.ed().chrome.state().screen;

  /** 백킹 px 좌표의 픽셀 [r,g,b,a]. i=0 커밋 캐시, i=1 씬. */
  A.px = (i, x, y) => {
    const c = A.canvases()[i];
    if (!c) return null;
    const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };

  A.pixelGrid = () => {
    const m = A.modal();
    const el = m ? m.querySelector('[data-chrome="pixel-grid"]') : null;
    return el ? { display: el.style.display, size: el.style.backgroundSize } : null;
  };
  /** 눈금자 라벨 — 값(oriented px)과 그려진 자리(css px). */
  A.rulerLabels = (axis) => {
    const s = A.svg();
    const g = s ? s.querySelector('[data-r="labels' + (axis === 'x' ? 'H' : 'V') + '"]') : null;
    if (!g) return [];
    return Array.from(g.querySelectorAll('text')).map((t) => ({
      v: Number(t.textContent),
      at: Number(t.getAttribute(axis === 'x' ? 'x' : 'y')),
    }));
  };
  A.selBox = () => {
    const r = A.chromeAll('[data-chrome="selection"] rect')[0];
    if (!r) return null;
    return {
      x: Number(r.getAttribute('x')),
      y: Number(r.getAttribute('y')),
      w: Number(r.getAttribute('width')),
      h: Number(r.getAttribute('height')),
    };
  };
  /** 핸들 한 변의 **실제 그려진** 크기(css px) — 줌을 먹었는지 여기서 드러난다. */
  A.handleBox = () => {
    const h = A.chromeAll('[data-chrome="handles"] rect')[0];
    if (!h) return null;
    const b = h.getBBox();
    return { w: b.width, h: b.height };
  };

  // ── 토글 ──────────────────────────────────────────────────────────────────
  //
  // 상태바에는 다섯 개뿐이다. 나머지(간격 표시·오브젝트/가이드/픽셀 스냅)는 인스펙터
  // '스냅 · 가이드' 섹션에만 있고, 그 탭이 숨겨져 있어도 네 탭 전부 마운트돼 있으므로
  // 체크박스 click 은 그대로 먹는다. 두 곳이 같은 스토어를 뒤집는 것이 42·43 의 계약이다.
  A.STATUS_TOGGLE = {
    snap: '스냅', smartGuides: '스마트 가이드', pixelGrid: '픽셀 그리드',
    rulers: '눈금자', guidesVisible: '가이드 표시',
  };
  A.SECTION_TOGGLE = {
    snapPixel: '픽셀 그리드에 스냅 (1px)', snapObjects: '오브젝트에 스냅',
    snapGuides: '가이드에 스냅', smartGuides: '스마트 가이드',
    gapBadges: '간격 표시', rulers: '눈금자 표시',
  };
  A.setToggle = async (key, want) => {
    if (A.ui().toggles[key] === want) return true;
    const m = A.modal();
    // 그리드만 불리언이 아니라 셀렉트다(끄기/8px/16px) — 체크박스·상태바 경로로는 못 바꾼다.
    // 옵션 문구로 고른다: m.querySelector('select') 는 **타이틀바 줌**이라 그걸 집으면
    // 배율이 바뀐 채로 이후 좌표 단언이 전부 어긋난다.
    if (m && key === 'grid') {
      const sel = Array.from(m.querySelectorAll('select')).find((s) =>
        Array.from(s.options).some((o) => (o.textContent || '').trim() === '끄기'),
      );
      if (!sel) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      set.call(sel, String(want));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await A.frame();
      return A.ui().toggles[key] === want;
    }
    const sec = A.SECTION_TOGGLE[key];
    if (m && sec) {
      const lab = Array.from(m.querySelectorAll('label')).find(
        (l) => (l.textContent || '').trim() === sec,
      );
      const box = lab ? lab.querySelector('input[type="checkbox"]') : null;
      if (box) {
        box.click();
        await A.frame();
        return A.ui().toggles[key] === want;
      }
    }
    if (A.STATUS_TOGGLE[key] && A.clickToggle(A.STATUS_TOGGLE[key])) {
      await A.frame();
      return A.ui().toggles[key] === want;
    }
    return false;
  };

  // ── 스테이지 팬 · 눈금자 띠 드래그 ────────────────────────────────────────
  //
  // 둘 다 setPointerCapture 를 부른다 — 실제 포인터가 없으면 NotFoundError 로 핸들러가
  // 통째로 죽으므로 시퀀스 동안 무해화한다(pointerSeq 와 같은 이유).
  A.noCapture = (fn) => {
    const P = Element.prototype;
    const o = { s: P.setPointerCapture, r: P.releasePointerCapture, h: P.hasPointerCapture };
    P.setPointerCapture = function () {};
    P.releasePointerCapture = function () {};
    P.hasPointerCapture = function () { return false; };
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        P.setPointerCapture = o.s;
        P.releasePointerCapture = o.r;
        P.hasPointerCapture = o.h;
      });
  };
  A.stage = () => {
    const m = A.modal();
    return m ? m.querySelector('.checkerboard') : null;
  };
  /** 가운데 버튼 드래그 = 팬(42 §3.5). 눈금자가 함께 밀리는지 재려면 이 경로여야 한다. */
  A.pan = (dx, dy) =>
    A.noCapture(async () => {
      const el = A.stage();
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const send = (type, cx, cy, btn, btns) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy, button: btn, buttons: btns,
            pointerId: 1402, pointerType: 'mouse', isPrimary: true,
          }),
        );
      send('pointerdown', x, y, 1, 4);
      send('pointermove', x + dx, y + dy, -1, 4);
      send('pointerup', x + dx, y + dy, 1, 0);
      await A.frame();
      await A.frame();
      return true;
    });
  /**
   * 눈금자 띠에서 가이드를 끌어낸다. pos 는 oriented px, opts.drop 이 주어지면 그 자리에서
   * 손을 뗀다(이미지 밖 = 취소). 오버레이에서 포인터를 받는 요소는 이 띠 둘뿐이다.
   */
  A.guideDrag = (axis, pos, opts) =>
    A.noCapture(async () => {
      const s = A.svg();
      const band = s
        ? s.querySelector('[data-chrome="ruler-' + (axis === 'y' ? 'h' : 'v') + '"]')
        : null;
      const root = A.chromeRoot();
      if (!band || !root) return false;
      const sc = A.screen();
      const r = root.getBoundingClientRect();
      const cross = opts && opts.cross != null ? opts.cross : 40;
      const at = (p) =>
        axis === 'y'
          ? { x: r.left + sc.x + cross * sc.scale, y: r.top + sc.y + p * sc.scale }
          : { x: r.left + sc.x + p * sc.scale, y: r.top + sc.y + cross * sc.scale };
      const b = band.getBoundingClientRect();
      const send = (type, q, btns) =>
        band.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: q.x, clientY: q.y, button: 0, buttons: btns,
            pointerId: 1403, pointerType: 'mouse', isPrimary: true,
          }),
        );
      send('pointerdown', { x: b.left + b.width / 2, y: b.top + b.height / 2 }, 1);
      send('pointermove', at(pos), 1);
      send('pointerup', at(opts && opts.drop != null ? opts.drop : pos), 0);
      await A.frame();
      await A.frame();
      return true;
    });

  // ── 저장본 읽기(30 스위트와 같은 계약) ────────────────────────────────────
  A.clickBtn = (re) => {
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
  /**
   * '다른 이름으로' 저장을 구동한다. 다이얼로그 DOM 대신 스토어 요청 객체를 직접 확정해
   * 입력 타이밍 흔들림을 없앤다(30 스위트와 같은 방식).
   */
  A.saveAs = async (fileName) => {
    if (!A.clickBtn(/다른 이름으로/)) return { ok: false, why: 'button' };
    await new Promise((r) => setTimeout(r, 80));
    const st = window.__gpv.ui.getState();
    const req = st.prompt;
    if (!req) return { ok: false, why: 'prompt' };
    st.closePrompt();
    req.onConfirm(fileName);
    return { ok: true };
  };
  A.readSaved = async (projectId, relPath, points) => {
    const res = await window.__TAURI_INTERNALS__.invoke('read_file_base64', {
      projectId: projectId,
      relPath: relPath,
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
    return (points || []).map((p) => {
      const d = ctx.getImageData(p[0], p[1], 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
  };

  // ── 좌 패널(44) ───────────────────────────────────────────────────────────
  A.leftTab = async (label) => {
    const m = A.modal();
    const tl = m ? m.querySelector('[role="tablist"][aria-label="좌 패널"]') : null;
    const b = tl
      ? Array.from(tl.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === label,
        )
      : null;
    if (!b) return false;
    b.click();
    A.focusRoot();
    await A.frame();
    return true;
  };
  A.panelBody = (id) => {
    const m = A.modal();
    return m ? m.querySelector('[data-left-tab="' + id + '"]') : null;
  };
  A.rowEls = () => {
    const p = A.panelBody('layers');
    return p ? Array.from(p.querySelectorAll('[role="treeitem"][data-layer-id]')) : [];
  };
  A.rowEl = (id) => A.rowEls().find((el) => el.getAttribute('data-layer-id') === id) || null;
  /** 화면에 그려진 행 — layers().rows(모델)와 대조해 DOM 이 뒤처지지 않았는지 본다. */
  A.rowDom = () =>
    A.rowEls().map((el) => ({
      id: el.getAttribute('data-layer-id'),
      level: Number(el.getAttribute('aria-level')),
      sel: el.getAttribute('aria-selected') === 'true',
      h: el.offsetHeight,
      cls: el.className,
      text: (el.textContent || '').trim(),
    }));
  A.clickRow = async (id, opts) => {
    const el = A.rowEl(id);
    if (!el) return false;
    el.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true, cancelable: true,
        shiftKey: !!(opts && opts.shift), ctrlKey: !!(opts && opts.ctrl),
      }),
    );
    await A.frame();
    return true;
  };
  /** 행 안 아이콘 버튼(눈·자물쇠·캐럿) — title 로 고른다. */
  A.clickRowBtn = async (id, re) => {
    const el = A.rowEl(id);
    const b = el
      ? Array.from(el.querySelectorAll('button')).find((x) =>
          re.test(x.getAttribute('title') || ''),
        )
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    return true;
  };
  A.clickPanelBtn = async (tab, title) => {
    const p = A.panelBody(tab);
    const b = p
      ? Array.from(p.querySelectorAll('button')).find(
          (x) => (x.getAttribute('title') || '').trim() === title,
        )
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    return true;
  };
  A.panelText = (tab) => {
    const p = A.panelBody(tab);
    return p ? (p.textContent || '').trim() : '';
  };
  /**
   * 행 드래그(44 §3.5). 훅이 window 리스너 + elementFromPoint 로 도므로 좌표는 실제
   * 화면 좌표여야 하고, 첫 move 는 임계 5px 를 넘겨야 드래그로 승격된다.
   */
  A.rowDrag = async (fromId, toId, ratio, esc) => {
    const from = A.rowEl(fromId);
    const to = A.rowEl(toId);
    if (!from || !to) return false;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const mk = (type, x, y, btns) =>
      new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: btns,
        pointerId: 1500, pointerType: 'mouse', isPrimary: true,
      });
    const x0 = a.left + Math.min(60, a.width / 2);
    const y0 = a.top + a.height / 2;
    from.dispatchEvent(mk('pointerdown', x0, y0, 1));
    window.dispatchEvent(mk('pointermove', x0, y0 + 9, 1));
    const x1 = b.left + Math.min(60, b.width / 2);
    const y1 = b.top + b.height * ratio;
    window.dispatchEvent(mk('pointermove', x1, y1, 1));
    await A.frame();
    const target = A.dropInfo();
    // 취소는 window 로 쏜다 — 편집기의 단일 capture 리스너를 타야 실제 경로와 같다.
    if (esc) await A.fire({ key: 'Escape', code: 'Escape' });
    window.dispatchEvent(mk('pointerup', x1, y1, 0));
    await A.frame();
    return target;
  };
  /** 드롭 표시선·고스트가 지금 무엇을 약속하는가(드래그 중에만 의미가 있다). */
  A.dropInfo = () => {
    const p = A.panelBody('layers');
    const bar = p ? p.querySelector('.bg-accent.pointer-events-none') : null;
    const ghost = document.querySelector('.pointer-events-none.fixed.z-50');
    return {
      indicator: bar ? bar.style.display : null,
      ghost: ghost ? (ghost.textContent || '').trim() : null,
      inside: p ? p.querySelectorAll('.ring-accent').length : -1,
    };
  };

  // ── 히스토리 탭(44 §3.6) ──────────────────────────────────────────────────
  //
  // 행·그룹 헤더는 높이로 가른다(시안 행 h34 · 그룹 h26). 칩·푸터 버튼과 섞이지 않는
  // 유일한 표식이고, 클래스 선택자는 스타일이 바뀌면 조용히 못 찾는다.
  A.histRows = () => {
    const p = A.panelBody('history');
    if (!p) return [];
    return Array.from(p.querySelectorAll('button'))
      .filter((b) => b.style.height === '34px')
      .map((b) => ({
        text: (b.textContent || '').trim(),
        cur: /현재$/.test((b.textContent || '').trim()),
        dim: /opacity-50/.test(b.className),
        readonly: b.disabled === true,
      }));
  };
  A.histGroups = () => {
    const p = A.panelBody('history');
    if (!p) return [];
    return Array.from(p.querySelectorAll('div'))
      .filter((d) => d.style.height === '26px')
      .map((d) => (d.textContent || '').trim());
  };
  A.clickHistRow = async (i) => {
    const p = A.panelBody('history');
    const rows = p
      ? Array.from(p.querySelectorAll('button')).filter((b) => b.style.height === '34px')
      : [];
    if (!rows[i]) return false;
    rows[i].click();
    await A.frame();
    return true;
  };
  /** 칩(전체·내 작업·스냅샷)과 푸터(되돌리기·스냅샷 저장) — 항목 행(h34)이 아닌 버튼. */
  A.histBtn = async (label) => {
    const p = A.panelBody('history');
    const b = p
      ? Array.from(p.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === label && x.style.height !== '34px',
        )
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    return true;
  };

  // ── 컨텍스트 바 · 인스펙터 · 팝오버(45) ───────────────────────────────────
  //
  // 인스펙터는 **네 탭이 전부 마운트**돼 있고 비활성만 hidden 이다. 그래서 입력을 찾을 때는
  // 반드시 '지금 보이는 탭' 으로 좁힌다 — 루트에서 aria-label 로 집으면 숨은 탭의 같은 이름
  // 필드가 먼저 잡혀, 화면에 있지도 않은 칸을 재는 단언이 된다.
  A.bar = () => {
    const m = A.modal();
    if (!m) return null;
    // 레일도 role=toolbar 다 — 그쪽은 aria-label 이 '도구' 라 그것만 걸러 낸다.
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
  A.clickBar = async (re) => {
    const b = A.bar();
    const hit = b
      ? Array.from(b.querySelectorAll('button')).find((x) =>
          re.test((x.textContent || '') + ' ' + (x.getAttribute('title') || '')),
        )
      : null;
    if (!hit) return false;
    hit.click();
    A.focusRoot();
    await A.frame();
    return true;
  };

  A.tab = () => A.ed().inspector.tab();
  A.tabPanel = (id) => {
    const m = A.modal();
    return m ? m.querySelector('[data-inspector-tab="' + (id || A.tab()) + '"]') : null;
  };
  A.tabHidden = (id) => {
    const el = A.tabPanel(id);
    return el ? el.hidden === true : null;
  };
  /** 인스펙터 탭 목록 — 좌 패널 탭리스트(aria-label 이 있다)와 구분한다. */
  A.tabBtns = () => {
    const m = A.modal();
    const tl = m
      ? Array.from(m.querySelectorAll('[role="tablist"]')).find(
          (el) => !el.getAttribute('aria-label'),
        )
      : null;
    return tl ? Array.from(tl.querySelectorAll('button')) : [];
  };
  A.tabAria = () =>
    A.tabBtns().map((b) => ({
      label: (b.textContent || '').trim(),
      sel: b.getAttribute('aria-selected') === 'true',
    }));
  A.clickTab = async (label) => {
    const b = A.tabBtns().find((x) => (x.textContent || '').trim() === label);
    if (!b) return false;
    b.click();
    A.focusRoot();
    await A.frame();
    return true;
  };

  /** 지금 보이는 탭(root 를 주면 그 안)의 입력 하나. NumField·HEX 가 같은 규칙(aria-label)을 쓴다. */
  A.input = (label, root) => {
    const p = root || A.tabPanel();
    return p ? p.querySelector('input[aria-label="' + label + '"]') : null;
  };
  /** 값과 placeholder 를 **함께** 준다 — 빈 칸 하나로는 '0' 과 '여러 값' 이 구분되지 않는다. */
  A.fieldState = (label, root) => {
    const el = A.input(label, root);
    return el ? { value: el.value, placeholder: el.placeholder || '' } : null;
  };
  /** React 제어 입력 — 네이티브 setter 로 넣어야 onChange 가 값 변화를 본다(zoomSelect 와 같은 이유). */
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
      new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      }),
    );
    await A.frame();
    await A.frame();
    return true;
  };
  /**
   * 필드 위 방향키. **입력에 직접** 쏜다 — window 로 쏘면 42 캡처 리스너의 nudge 가 먼저 먹어
   * 선택 객체가 1px 움직이고, 재려던 필드 규칙(1회 = 1칸)은 재지 못한다.
   */
  A.keyField = async (label, init, root) => {
    const el = A.input(label, root);
    if (!el) return false;
    el.focus();
    el.dispatchEvent(
      new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init)),
    );
    await A.frame();
    await A.frame();
    return true;
  };
  /**
   * 라벨 스크럽. 손잡이는 입력 **앞의 span** 이다(시안 ① — 라벨 글자 자체를 끈다).
   * 실제 포인터가 없으면 setPointerCapture 가 던져 핸들러가 통째로 죽으므로 무해화한다.
   *
   * 드래그 **중간**의 히스토리 깊이를 함께 돌려준다 — 라이브 구간이 한 칸을 넘게 쌓는지는
   * 손을 떼기 전에만 잴 수 있다(떼고 나면 마지막 한 칸만 남아 똑같아 보인다).
   */
  A.scrub = (label, dx, opts) =>
    A.noCapture(async () => {
      const el = A.input(label, opts && opts.root);
      const row = el && el.parentElement ? el.parentElement.parentElement : null;
      const grip = row ? row.firstElementChild : null;
      if (!grip) return { ok: false };
      const x0 = 300;
      const send = (type, x, btns) =>
        grip.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: 100, button: 0, buttons: btns,
            shiftKey: !!(opts && opts.shift), altKey: !!(opts && opts.alt),
            pointerId: 1600, pointerType: 'mouse', isPrimary: true,
          }),
        );
      send('pointerdown', x0, 1);
      send('pointermove', x0 + dx / 2, 1);
      await A.frame();
      send('pointermove', x0 + dx, 1);
      await A.frame();
      const mid = A.hist();
      send('pointerup', x0 + dx, 0);
      await A.frame();
      return { ok: true, mid: mid, end: A.hist() };
    });

  A.hist = () => A.ed().history.entries().length;
  A.lastLabel = () => {
    const e = A.ed().history.entries();
    return e.length ? e[0].label : null;
  };
  /** 내보내기 렌더 경로(39)로 뽑은 픽셀 한 점 — 씬 캔버스와 같아야 '화면 == 파일' 이다. */
  A.renderPx = (x, y) => {
    const r = A.ed().renderRegion({ x: x, y: y, w: 1, h: 1 }, 1);
    return r ? r.data.slice(0, 4) : null;
  };

  // 속성 탭 스택(채우기·선·효과) — 섹션 헤더 **문구**로 집는다. 클래스 선택자는 스타일이
  // 바뀌면 조용히 못 찾고, 순서 인덱스는 필드가 숨겨질 때마다 밀린다.
  A.stack = (title) => {
    const p = A.tabPanel();
    if (!p) return null;
    return (
      Array.from(p.querySelectorAll('section')).find((s) => {
        const h = s.firstElementChild;
        return !!h && (h.textContent || '').trim() === title;
      }) || null
    );
  };
  A.stackRows = (title) => {
    const s = A.stack(title);
    return s ? Array.from(s.children).slice(1) : [];
  };
  A.stackText = (title) => A.stackRows(title).map((r) => (r.textContent || '').trim());
  A.stackAdd = async (title) => {
    const s = A.stack(title);
    const b = s ? s.querySelector('button[title="' + title + ' 추가"]') : null;
    if (!b) return false;
    b.click();
    await A.frame();
    return true;
  };
  A.stackBtn = async (title, i, btnTitle) => {
    const row = A.stackRows(title)[i];
    const b = row ? row.querySelector('button[title="' + btnTitle + '"]') : null;
    if (!b) return false;
    b.click();
    await A.frame();
    return true;
  };
  /** 행 왼쪽 스와치 = 팝오버 앵커. title 이 없다 — 색 자체가 라벨이라 문구로는 못 집는다. */
  A.stackOpen = async (title, i) => {
    const row = A.stackRows(title)[i];
    const b = row && row.firstElementChild ? row.firstElementChild.querySelector('button') : null;
    if (!b) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };

  // 팝오버 — role="dialog" 는 이 프리미티브만 쓴다(확인창·프롬프트는 z-[60] div 다).
  // 중첩 팝오버는 부모 팝오버의 **자손**이라 문서 순서상 뒤가 곧 위다.
  A.pops = () => Array.from((A.modal() || document).querySelectorAll('[role="dialog"]'));
  A.popN = () => A.pops().length;
  A.popTop = () => {
    const p = A.pops();
    return p.length ? p[p.length - 1] : null;
  };
  A.popTitle = () => {
    const p = A.popTop();
    return p && p.firstElementChild ? (p.firstElementChild.textContent || '').trim() : null;
  };
  /** 화면 안에 들어왔는가 — 인스펙터(오른쪽 끝 320)에서 열면 기본 배치가 화면 밖이다. */
  A.popFits = () => {
    const p = A.popTop();
    if (!p) return false;
    const r = p.getBoundingClientRect();
    return (
      r.left >= 0 && r.top >= 0 &&
      r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5
    );
  };
  /** 백드롭 — 모달 팝오버만 그린다. 루트 안의 'fixed inset-0 z-50'(플라이아웃과 같은 모양). */
  A.popBackdrop = () => {
    const m = A.modal();
    return m ? m.querySelector('div.fixed.inset-0.z-50') : null;
  };
  A.clickIn = async (root, re) => {
    const b = root
      ? Array.from(root.querySelectorAll('button')).find((x) =>
          re.test((x.textContent || '') + ' ' + (x.getAttribute('title') || '')),
        )
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };

  return true;
})()`;

/** v1 리터럴 — 경계(normalizeDoc)가 v2 로 채운다(36·37 스위트와 같은 모양). */
const rect = (id, x, y, w, h, strokeWidth = 0) => ({
  id, kind: "rect", stroke: "#FF3B30", strokeWidth, opacity: 1, rot: 0,
  x, y, w, h, fill: "#FF3B30", radius: 0,
});

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 편집기 셸", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-shell.png";
  const SEED = [rect("s1", 10, 10, 40, 40), rect("s2", 110, 10, 40, 40)];
  /** 저장 케이스가 레포에 만든 파일 — finally 가 지운다. */
  const created = [];
  const isWhite = (p) =>
    Array.isArray(p) && p[0] > 245 && p[1] > 245 && p[2] > 245 && p[3] > 250;

  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const S = (expr) => cdp.eval(`window.__gpvShell.${expr}`);
  const closeEditor = () =>
    cdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});
  const openEditor = async () => {
    await cdp.eval(
      `window.__gpv.ui.getState().openImageEditor(${J(SRC)}, ${J(fix.projectId)})`,
    );
    const ok = await poll(() => S(`ready()`).catch(() => false), (v) => v === true);
    await S(`focusRoot()`).catch(() => {});
    return ok;
  };
  const seed = (objects = SEED) =>
    cdp.eval(`window.__gpvShell.ed().setDoc({ objects: ${J(objects)}, crop: null })`);
  const selectAll = () =>
    cdp.eval(`window.__gpvShell.fire({ key:'a', code:'KeyA', ctrlKey:true })`);

  // 사용자 상태 원복용 스냅샷 — 프로젝트 선택·뷰어 탭·토글은 이 스위트가 건드린다.
  const prior = {
    pid: await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
    diff: await cdp.eval(`window.__gpv.ui.getState().selectedDiff`),
    repo: await cdp.eval(`window.__gpv.ui.getState().selectedDiffRepoId`),
    toggles: await cdp.eval(`localStorage.getItem('gp:ie:toggles')`),
  };

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const b64 = await cdp.eval(`window.__gpvShell.solidPng(200, 200, '#ffffff')`);
    const made = await cdp.try("write_file_bytes", {
      projectId: fix.projectId, relPath: SRC, base64: b64, overwrite: true,
    });
    if (!r.check("픽스처 PNG(200×200 흰색) 생성", made.ok && existsSync(join(fix.repo, SRC)))) {
      return;
    }

    await closeEditor();
    await sleep(200);
    // 사이드카에 남은 편집 문서를 먼저 지운다 — 41 의 자동 복원이 "새로 연 편집기는 비어
    // 있다" 전제를 깬다(직전 회차가 남긴 문서가 되살아난다). 편집기가 닫혀 있어
    // `__gpv.imageDocs` 훅이 없으므로 커맨드를 직접 부른다.
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });

    // 편집기 **뒤**의 앱 상태를 만든다 — Ctrl+W 가 뷰어 탭을 닫지 않는지 보려면 닫힐 탭이
    // 실제로 있어야 하고, 앱 단축키(KeyboardShortcuts)는 프로젝트가 선택돼야 마운트된다.
    await cdp.eval(`(() => {
      const u = window.__gpv.ui.getState();
      u.selectProject(${J(fix.projectId)});
      u.setAggregateOpen(false);
      window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, 'viewer');
      u.selectDiff({ mode: 'file', path: ${J(SRC)} }, null);
    })()`);
    await sleep(300);

    if (!r.check("편집기 열림", (await openEditor()) === true)) return;

    // ── (a) 루트·캔버스·그리드 ───────────────────────────────────────────────
    const m = (await S(`metrics()`)) || {};
    r.check(
      "(a-1) 루트가 창 전체를 덮는 `div.fixed.inset-0.z-50` 이고 application 역할이다",
      m.tag === "DIV" &&
        m.role === "application" &&
        /(^|\s)fixed(\s|$)/.test(m.cls) &&
        /(^|\s)inset-0(\s|$)/.test(m.cls) &&
        /(^|\s)z-50(\s|$)/.test(m.cls),
      `tag=${m?.tag} role=${m?.role} cls=${m?.cls}`,
    );
    const cw = await cdp.eval(
      `window.__gpvShell.canvases().map((c) => [c.width, c.height])`,
    );
    r.check(
      "(a-2) 캔버스 두 장이 모두 백킹 크기를 갖는다(캐시 + 씬)",
      Array.isArray(cw) && cw.length >= 2 && cw[0][0] > 0 && cw[1][0] > 0,
      J(cw),
    );
    // 좌·우 폭은 사용자가 끌어 놓은 값이 localStorage 에 남으므로, 저장값이 있으면 그것이
    // 기대치다(없을 때만 시안 기본값 264·320).
    const expLeft = m.savedLeft >= 200 && m.savedLeft <= 420 ? m.savedLeft : 264;
    const expRight = m.savedRight >= 260 && m.savedRight <= 480 ? m.savedRight : 320;
    r.check(
      "(a-3) 시안 치수: 레일 56 · 좌 패널 264 · 인스펙터 320 · 타이틀 48 · 상태바 30",
      Math.abs(m.rail - 56) <= 1 &&
        Math.abs(m.left - expLeft) <= 1 &&
        Math.abs(m.inspector - expRight) <= 1 &&
        Math.abs(m.title - 48) <= 1 &&
        Math.abs(m.status - 30) <= 1,
      `rail=${m.rail} left=${m.left}/${expLeft} insp=${m.inspector}/${expRight} title=${m.title} status=${m.status}`,
    );

    // ── (b) 툴 레일 ─────────────────────────────────────────────────────────
    const titles = await S(`railTitles()`);
    const missing = RAIL_TITLES.filter((t) => !titles.includes(t));
    const extra = titles.filter((t) => !RAIL_TITLES.includes(t));
    r.check(
      "(b-1) 레일에는 **동작이 있는 도구만** 그려진다(소유 태스크 도착 전 도구는 없다)",
      missing.length === 0 && extra.length === 0 && titles.length === RAIL_TITLES.length,
      `n=${titles.length}/${RAIL_TITLES.length} 없음=${J(missing)} 여분=${J(extra)}`,
    );
    r.check(
      "(b-2) 모든 툴팁이 `<라벨> (<키>)` 또는 `<라벨>` 형식이다(e2e 30 activeTool 이 읽는다)",
      titles.length > 0 &&
        titles.every((t) => /^[^()]+( \((?:Shift\+)?[A-Za-z]+\))?$/.test(t)),
      J(titles.filter((t) => !/^[^()]+( \((?:Shift\+)?[A-Za-z]+\))?$/.test(t))),
    );
    const carets = await S(`caretButtons().length`);
    await S(`rightClick(0)`);
    await sleep(120);
    const flyN = await S(`flyoutItems()`);
    r.check(
      "(b-3) 캐럿 우클릭 → 플라이아웃이 뜨고 항목이 하나 이상이다(빈 캐럿은 고장으로 읽힌다)",
      carets >= 1 && flyN >= 1,
      `캐럿=${carets} 항목=${flyN}`,
    );
    const escFly = await S(`fire({ key:'Escape', code:'Escape' })`);
    await sleep(120);
    r.check(
      "(b-4) Esc 가 플라이아웃부터 닫는다(계층 0) — 편집기는 그대로다",
      (await S(`flyoutItems()`)) === 0 && (await S(`gone()`)) === false,
      `prevented=${escFly?.prevented}`,
    );

    // ── (c) 키 스코프 ───────────────────────────────────────────────────────
    await S(`installProbe()`);
    await S(`focusRoot()`);
    const swept = await cdp.eval(
      `window.__gpvShell.sweep(${J(CONSUME_ROWS)}, ${J(SEED)})`,
      { timeoutMs: 120000 },
    );
    const leaked = (swept || []).filter((x) => x.hits !== 0).map((x) => x.id);
    const notPrevented = (swept || []).filter((x) => !x.prevented).map((x) => x.id);
    r.check(
      "(c-1) 편집기가 쓰는 키는 앱 리스너에 **한 번도 닿지 않는다** — 뒤의 25곳은 편집기가 열린 줄 모른다",
      leaked.length === 0,
      `누출 ${leaked.length}/${swept?.length}: ${J(leaked)}`,
    );
    r.check(
      "(c-2) 편집기 키는 브라우저 기본 동작도 막는다(인쇄·북마크·페이지 줌 억제)",
      notPrevented.length === 0,
      `미차단 ${notPrevented.length}/${swept?.length}: ${J(notPrevented)}`,
    );

    // 통과 키 — 편집기가 열렸다고 F5·Quick Open 이 죽으면 안 된다.
    const passHits = [];
    for (const [id, init] of PASS_ROWS) {
      const res = await cdp.eval(`window.__gpvShell.fire(${J(init)})`);
      passHits.push(`${id}=${res.hits}`);
      // 앱 기능이 실제로 열렸는지까지 본 뒤 즉시 되돌린다(다음 키가 입력칸에 먹히지 않게).
      if (id === "Ctrl+P") {
        r.check(
          "(c-3) Ctrl+P 가 Quick Open 을 연다",
          (await cdp.eval(`window.__gpv.ui.getState().quickOpenOpen`)) === true,
        );
        await cdp.eval(`window.__gpv.ui.getState().setQuickOpenOpen(false)`);
      } else if (id === "Ctrl+Alt+N") {
        r.check(
          "(c-4) Ctrl+Alt+N 이 심볼 검색을 연다",
          (await cdp.eval(`window.__gpv.ui.getState().symbolSearchOpen`)) === true,
        );
        await cdp.eval(`window.__gpv.ui.getState().setSymbolSearchOpen(false)`);
      } else if (id === "Ctrl+Shift+F") {
        const opened = await cdp.eval(
          `[...document.querySelectorAll('input')].some((i) => /검색.*Enter/.test(i.placeholder || ''))`,
        );
        r.check("(c-5) Ctrl+Shift+F 가 파일 내 검색 패널을 연다", opened === true);
        await cdp.eval(
          `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '닫기 (Esc)'); if (b) b.click(); return true; })()`,
        );
      } else if (id === "Ctrl+Shift+A") {
        r.check(
          "(c-6) mod+Shift+A 가 터미널 모아보기를 토글한다",
          (await cdp.eval(`window.__gpv.ui.getState().aggregateOpen`)) === true,
        );
        await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
      }
      await sleep(150);
      await S(`focusRoot()`);
    }
    r.check(
      "(c-7) 통과 키는 앱까지 도달한다 — 편집기가 열렸다고 F5·Ctrl+P 가 죽으면 안 된다",
      passHits.every((h) => h.endsWith("=1")),
      passHits.join(" "),
    );

    // 간격 정리(⌃⌥⌘K)는 `KeyboardShortcuts.tsx:122` 가 altKey 를 안 봐서 **git push** 로
    // 새던 조합이다. 푸시가 나갔으면 업스트림 확인창이나 push 토스트가 남는다.
    await cdp.eval(`(() => {
      const st = window.__gpv.ui.getState();
      st.toasts.slice().forEach((t) => st.dismissToast(t.id));
      return true;
    })()`);
    const tidyFire = await cdp.eval(
      `window.__gpvShell.fire({ key:'K', code:'KeyK', ctrlKey:true, altKey:true, shiftKey:true })`,
    );
    await sleep(1200);
    const afterTidy = await cdp.eval(`(() => {
      const st = window.__gpv.ui.getState();
      return { confirm: st.confirm ? st.confirm.title : null, toasts: st.toasts.map((t) => t.message) };
    })()`);
    // 앱 전역 게이트가 고쳐지면 확인창은 어차피 안 뜬다 — 그러면 이 단언이 **내 쪽 방어가
    // 죽어도** 통과한다. 소비 여부를 함께 재서 편집기 층이 살아 있는지 독립적으로 잡는다.
    r.check(
      "(c-8) 간격 정리 키는 편집기가 **소비한다** — 주인(45)이 아직 없어도 앱으로 새면 안 된다",
      tidyFire.prevented === true && tidyFire.hits === 0,
      `prevented=${tidyFire.prevented} hits=${tidyFire.hits}`,
    );
    r.check(
      "(c-8b) Ctrl+Alt+Shift+K(간격 정리)가 **git push 를 쏘지 않는다** — 확인창도 토스트도 없다",
      afterTidy.confirm === null && !afterTidy.toasts.some((t) => /push|업스트림/i.test(t)),
      `confirm=${afterTidy.confirm} toasts=${J(afterTidy.toasts)}`,
    );
    // 확인창이 떴다면(=이 단언이 실패했다면) 그대로 두면 안 된다 — `useEditorKeys` 의
    // 게이트 ①이 확인창 동안 **모든 키를 통과**시켜, 뒤따르는 단언이 전부 무의미해진다.
    await cdp.eval(
      `(() => { const st = window.__gpv.ui.getState(); if (st.confirm) st.closeConfirm(); return true; })()`,
    );

    // Ctrl+W: 뒤의 뷰어 탭이 닫히면 안 된다. 편집기 자신은 닫는 것이 맞다(`file.close`).
    const tabsBefore = await cdp.eval(`window.__gpv.ui.getState().viewerTabs.length`);
    await cdp.eval(`window.__gpvShell.fire({ key:'w', code:'KeyW', ctrlKey:true })`);
    const closed = await poll(() => S(`gone()`).catch(() => false), (v) => v === true, 20, 200);
    const tabsAfter = await cdp.eval(`window.__gpv.ui.getState().viewerTabs.length`);
    r.check(
      "(c-9) Ctrl+W 는 **편집기만** 닫는다 — 뒤의 뷰어 파일 탭은 그대로다",
      tabsAfter === tabsBefore && tabsBefore > 0 && closed === true,
      `tabs ${tabsBefore}→${tabsAfter} 편집기닫힘=${closed}`,
    );

    if (!r.check("(c-10) 재오픈", (await openEditor()) === true)) return;
    await S(`focusRoot()`);

    // ── (d) 물리 키 매칭 ────────────────────────────────────────────────────
    await seed();
    await cdp.eval(`window.__gpvShell.ed().setTool('rect')`);
    await cdp.eval(`window.__gpvShell.fire({ key:'ㅍ', code:'KeyV' })`);
    r.check(
      "(d-1) 한글 IME 를 켜도 도구가 바뀐다(`key='ㅍ'` · `code='KeyV'`)",
      (await S(`ui().tool`)) === "select",
      `tool=${await S(`ui().tool`)}`,
    );
    await cdp.eval(`window.__gpvShell.ed().setTool('rect')`);
    await cdp.eval(`window.__gpvShell.fire({ key:'v' })`);
    r.check(
      "(d-2) `code` 없이 `key` 만 온 합성 이벤트도 잡는다(e2e 30 의 A.key 가 그렇게 보낸다)",
      (await S(`ui().tool`)) === "select",
      `tool=${await S(`ui().tool`)}`,
    );

    await selectAll();
    const sel2 = await S(`ui().selectedIds.length`);
    const mac = await cdp.eval(`(() => {
      const M = (i) => window.__gpv.imageEditor.matchShortcut(i, 'mac');
      return {
        alt: M({ key: 'å', code: 'KeyA', altKey: true }),
        group: M({ key: 'g', code: 'KeyG', metaKey: true }),
        dist: M({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }),
      };
    })()`);
    r.check(
      "(d-3) Mac ⌥A 가 `key='å'` 로 와도 왼쪽 정렬로 잡힌다(⌘G=그룹 · ⌃⌥H=가로 분배)",
      sel2 === 2 && mac.alt === "align.left" && mac.group === "group" && mac.dist === "distribute.h",
      `sel=${sel2} ${J(mac)}`,
    );

    await cdp.eval(`window.__gpvShell.ed().setTool('rect')`);
    await cdp.eval(`window.__gpvShell.fire({ key:' ', code:'Space' })`);
    const held = await S(`ui().tool`);
    await cdp.eval(`window.__gpvShell.fire({ key:' ', code:'Space' }, 'keyup')`);
    const released = await S(`ui().tool`);
    r.check(
      "(d-4) Space 를 누르는 동안만 손 도구다 — 떼면 쓰던 도구로 돌아온다",
      held === "hand" && released === "rect",
      `누름=${held} 뗌=${released}`,
    );

    // ── (e) 모드 상태 머신 ──────────────────────────────────────────────────
    await seed();
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    // 아래 크롭 Esc 단언은 **선택이 비어 있어야** 계층 6(모드 종료)을 잰다 — 선택이 남아
    // 있으면 계층 5가 그것부터 지우고 크롭이 그대로 남는다. 반대로 이미 비었는데 Esc 를
    // 쏘면 계층 7(닫기)로 내려가 편집기가 사라진다. 그래서 개수를 보고 딱 한 번만 쏜다.
    if ((await S(`ui().selectedIds.length`)) > 0) {
      await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    }
    await cdp.eval(`window.__gpvShell.fire({ key:'c', code:'KeyC' })`);
    await sleep(150);
    r.check(
      "(e-1) C → 크롭 모드로 들어가고 배너가 무엇이 Enter·Esc 를 받는지 알린다",
      (await S(`ui().mode.kind`)) === "crop" && /크롭 모드/.test(await S(`text()`)),
      `mode=${J(await S(`ui().mode`))}`,
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'Enter', code:'Enter' })`);
    await sleep(150);
    r.check(
      "(e-2) 크롭 모드에서 Enter 는 적용하고 디자인으로 돌아온다",
      (await S(`ui().mode.kind`)) === "design",
      `mode=${J(await S(`ui().mode`))}`,
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'c', code:'KeyC' })`);
    await sleep(120);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(150);
    const afterEsc = await cdp.eval(
      `({ mode: window.__gpvShell.ui().mode.kind, crop: window.__gpvShell.doc().crop, open: !window.__gpvShell.gone() })`,
    );
    r.check(
      "(e-3) 크롭 모드 Esc 는 모드만 끝낸다 — 편집기가 닫히지도, 크롭이 남지도 않는다",
      afterEsc.mode === "design" && afterEsc.crop === null && afterEsc.open === true,
      J(afterEsc),
    );
    await cdp.eval(`window.__gpvShell.ed().setMode({ kind:'nodeEdit', id:'s1' })`);
    await sleep(150);
    const nodeBanner = /벡터 편집 모드/.test(await S(`text()`));
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(150);
    r.check(
      "(e-4) 노드 편집 모드도 같은 계층으로 끝난다(배너 → Esc → 디자인)",
      nodeBanner === true && (await S(`ui().mode.kind`)) === "design",
      `배너=${nodeBanner} mode=${await S(`ui().mode.kind`)}`,
    );

    // ── (f) 레일 도구 동작 ──────────────────────────────────────────────────
    await seed();
    await cdp.eval(`window.__gpvShell.ed().setTool('eraser')`);
    await cdp.eval(
      `window.__gpvShell.pointerSeq([['down',15,30],['move',25,30],['move',38,30],['up',38,30]])`,
    );
    await sleep(200);
    const erased = await cdp.eval(`({
      ids: window.__gpvShell.ids(),
      label: window.__gpvShell.ed().history.entries()[0].label,
    })`);
    r.check(
      "(f-1) 지우개는 지나간 자리의 노드만 지우고 **한 번에** 커밋한다(라벨 '지우개')",
      J(erased.ids) === J(["s2"]) && /지우개/.test(erased.label || ""),
      `ids=${J(erased.ids)} label=${erased.label}`,
    );

    // 이동(K)과 선택(V)의 유일한 차이는 **선 두께가 함께 배율되는가** 다(draft.ts scaleObject).
    // 두 도구로 같은 드래그를 해 그 차이만 잰다.
    const resizeWith = async (tool) => {
      await seed([rect("sc", 20, 20, 60, 60, 4)]);
      await cdp.eval(`window.__gpvShell.ed().setTool(${J(tool)})`);
      await selectAll();
      await cdp.eval(
        `window.__gpvShell.pointerSeq([['down',80,80],['move',110,110],['move',140,140],['up',140,140]])`,
      );
      await sleep(200);
      return cdp.eval(`(() => {
        const o = window.__gpvShell.doc().objects[0];
        return { w: Math.round(o.w), sw: o.strokeWidth };
      })()`);
    };
    const byScale = await resizeWith("scale");
    const bySelect = await resizeWith("select");
    // 두께가 **폭과 같은 비율**로 커졌는지만 본다. 절대 픽셀을 요구하면 핸들을 집는
    // 지점이 몇 px 다른 것만으로도 실패해, 정작 재려던 성질(비율 보존)이 가려진다.
    const ratio = byScale.w / 60;
    r.check(
      "(f-2) 이동(K)은 선 두께까지 **같은 비율로** 배율한다 — 선택(V)은 사용자가 고른 두께를 건드리지 않는다",
      byScale.w > 100 &&
        Math.abs(byScale.sw / 4 - ratio) < 0.02 &&
        bySelect.w === byScale.w &&
        Math.abs(bySelect.sw - 4) < 0.01,
      `K=${J(byScale)} V=${J(bySelect)} 배율=${ratio.toFixed(3)}`,
    );

    await seed([]);
    await cdp.eval(`window.__gpvShell.ed().setTool('frame')`);
    await cdp.eval(
      `window.__gpvShell.pointerSeq([['down',20,20],['move',50,50],['move',80,80],['up',80,80]])`,
    );
    await sleep(200);
    const framed = await cdp.eval(`(() => {
      const o = window.__gpvShell.doc().objects[0];
      return o ? { kind: o.kind, clips: o.clipsContent, w: Math.round(o.w) } : null;
    })()`);
    r.check(
      "(f-3) 프레임(F) 드래그가 `frame` 노드를 만든다(내용을 자르는 컨테이너)",
      framed && framed.kind === "frame" && framed.clips === true && framed.w === 60,
      J(framed),
    );
    r.skip(
      "(f-4) 이미지 도구",
      "`asset_pick_file` 이 **네이티브 파일 대화상자**를 연다 — 뜨는 순간 러너가 통째로 멈춘다(취소할 손이 없다). 실기 확인 항목",
    );

    // ── (g) 줌 ──────────────────────────────────────────────────────────────
    await seed();
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await S(`zoomSelect('2')`);
    const w200 = await S(`canvasW()`);
    await S(`zoomSelect('1')`);
    const w100 = await S(`canvasW()`);
    const outW = await S(`doc().outW`);
    r.check(
      "(g-1) 드롭다운 100% 는 원본 1:1 이다(200% 는 두 배)",
      Math.abs(w100 - outW) <= 1 && Math.abs(w200 - outW * 2) <= 2,
      `100%=${w100} 200%=${w200} oriented=${outW}`,
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'=', code:'Equal', ctrlKey:true })`);
    await cdp.eval(`window.__gpvShell.fire({ key:'=', code:'Equal', ctrlKey:true })`);
    await sleep(150);
    const wIn = await S(`canvasW()`);
    r.check(
      "(g-2) Ctrl+= 두 번 = 휠 네 노치(1.1⁴) — 키 줌과 휠 줌이 같은 스텝을 쓴다",
      Math.abs(wIn / w100 - Math.pow(1.1, 4)) < 0.01,
      `${w100} → ${wIn} (비 ${(wIn / w100).toFixed(4)}, 기대 ${Math.pow(1.1, 4).toFixed(4)})`,
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'!', code:'Digit1', shiftKey:true })`);
    await sleep(150);
    const wFit = await S(`canvasW()`);
    r.check(
      "(g-3) Shift+1 은 맞춤으로 되돌린다(200px 픽스처라 맞춤 == 100%)",
      Math.abs(wFit - outW) <= 1,
      `fit=${wFit} oriented=${outW}`,
    );

    // ── (h) 상태바 ──────────────────────────────────────────────────────────
    await seed([]);
    await sleep(200); // 씬 캔버스가 비워질 때까지 — 색은 그려진 픽셀에서 읽는다
    await S(`hover(100, 100)`);
    await sleep(150);
    const cursor = await cdp.eval(
      `({ coord: window.__gpvShell.coordText(), hex: window.__gpvShell.cursorHex() })`,
    );
    r.check(
      "(h-1) 커서 좌표와 그 자리의 색이 상태바에 뜬다(흰 픽스처 → #FFFFFF)",
      /^X 100\s+Y 100$/.test((cursor.coord || "").trim()) && cursor.hex === "#FFFFFF",
      `coord=${J(cursor.coord)} hex=${cursor.hex}`,
    );
    await seed();
    await selectAll();
    await sleep(150);
    const sel = await cdp.eval(`({
      n: window.__gpvShell.selCount(),
      exact: window.__gpvShell.selSpanExact(2),
      ui: window.__gpvShell.ui().selectedIds.length,
    })`);
    r.check(
      "(h-2) `2개 선택` 이 **자기 span 에 홀로** 있다 — 옆 숫자가 붙으면 e2e 30 이 '1001개 선택' 을 읽는다",
      sel.exact === true && sel.n === 2 && sel.ui === 2,
      J(sel),
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
    await sleep(200);
    const depth = await cdp.eval(
      `({ shown: window.__gpvShell.undoDepth(), cursor: window.__gpvShell.ed().history.cursor() })`,
    );
    r.check(
      "(h-3) `실행 취소 N단계` 가 히스토리 커서와 같다(되돌린 만큼 표시된다)",
      depth.shown !== null && depth.shown === depth.cursor && depth.cursor >= 1,
      `표시=${depth.shown} cursor=${depth.cursor}`,
    );

    // ── (i) 객체 복사·붙여넣기 ──────────────────────────────────────────────
    //
    // ponytail: doc 창 ↔ 메인 창 왕복은 여기서 확인하지 않는다. 복사는 **OS 클립보드**
    // (clipboard.ts copyText)로 나가고 붙여넣기는 clipboardData 의 text/plain 을 읽으므로
    // 창에 매인 경로가 없다 — 같은 창 왕복이 그 형식을 이미 고정한다(doc 창의 편집기가
    // 뜨는지는 34 스위트가 본다).
    await seed([rect("cp", 30, 30, 20, 20)]);
    await selectAll();
    await cdp.eval(`window.__gpvShell.fire({ key:'c', code:'KeyC', ctrlKey:true })`);
    await sleep(400);
    // `navigator.clipboard.readText()` 는 창 포커스·권한에 걸려 거부되거나 영영 안 돌아온다.
    // 앱이 실제로 쓰는 경로(clipboard.ts → arboard 플러그인)로 읽으면 그 제약이 없고,
    // **복사가 나간 바로 그 통로**를 되읽는 것이라 검증 대상도 더 정확하다.
    const clip = await cdp.eval(`Promise.race([
      window.__TAURI_INTERNALS__
        .invoke('plugin:clipboard-manager|read_text')
        .then((t) => ({ ok: true, t })),
      new Promise((res) => setTimeout(() => res({ ok: false, t: '읽기 시간 초과' }), 3000)),
    ]).catch((e) => ({ ok: false, t: String((e && e.message) || e) }))`);
    // Windows 클립보드는 다른 프로세스가 잠글 수 있다(실측: "held by another party").
    // 그건 환경 조건이라 이 한 단언만 스킵한다 — 형식 계약은 아래에서 따로 본다.
    if (!clip.ok) {
      r.skip("(i-1) Ctrl+C → OS 클립보드", `클립보드를 읽을 수 없다 — ${clip.t}`);
    } else {
      r.check(
        "(i-1) Ctrl+C 가 선택 객체를 `gpv-anno:` 로 클립보드에 쓴다(터미널 선택 복사에 뺏기지 않는다)",
        typeof clip.t === "string" && clip.t.startsWith("gpv-anno:"),
        `clip=${J(String(clip.t || "").slice(0, 60))}`,
      );
    }

    // 붙여넣기 **형식 계약**은 클립보드를 타지 않는다 — 핸들러가 `text/plain` 을 읽으므로
    // 합성 이벤트로 그대로 잰다. OS 클립보드가 잠겨 있어도 이 단언은 살아 있어야 한다:
    // 여기가 깨지면 창을 오가며 복사한 객체가 조용히 안 붙는다.
    const wire = `gpv-anno:${J([
      { id: "cp", kind: "rect", x: 30, y: 30, w: 20, h: 20, fill: "#FF3B30", strokeWidth: 0 },
    ])}`;
    await cdp.eval(`window.__gpvShell.pasteText(${J(wire)})`);
    await sleep(300);
    const pasted = await cdp.eval(`(() => {
      const os = window.__gpvShell.doc().objects;
      const last = os[os.length - 1];
      return { n: os.length, id: last.id, x: last.x, y: last.y, kind: last.kind };
    })()`);
    r.check(
      "(i-2) `gpv-anno:` 붙여넣기가 새 id·8px 오프셋으로 되살린다(원본을 덮지 않는다)",
      pasted.n === 2 &&
        pasted.id !== "cp" &&
        pasted.kind === "rect" &&
        pasted.x === 38 &&
        pasted.y === 38,
      J(pasted),
    );

    // ── (j) 보기 토글 ───────────────────────────────────────────────────────
    const LABELS = ["스냅", "스마트 가이드", "픽셀 그리드", "눈금자", "가이드 표시"];
    const KEYS = ["snap", "smartGuides", "pixelGrid", "rulers", "guidesVisible"];
    const before = await S(`ui().toggles`);
    for (const label of LABELS) await S(`clickToggle(${J(label)})`);
    await sleep(200);
    const after = await S(`ui().toggles`);
    const stored = await cdp.eval(`localStorage.getItem('gp:ie:toggles')`);
    const flipped = KEYS.every((k) => after[k] === !before[k]);
    r.check(
      "(j-1) 상태바 토글 5개가 스토어를 뒤집는다(레일·인스펙터·43 표시가 같은 값을 본다)",
      flipped,
      KEYS.map((k) => `${k}:${before[k]}→${after[k]}`).join(" "),
    );
    let saved = null;
    try {
      saved = JSON.parse(stored || "null");
    } catch {
      /* 손상 값은 아래 단언이 잡는다 */
    }
    r.check(
      "(j-2) 토글은 `gp:ie:toggles` 에 바로 저장된다",
      saved && KEYS.every((k) => saved[k] === after[k]),
      `stored=${J(stored)}`,
    );
    await closeEditor();
    await sleep(300);
    if (!r.check("(j-3) 재오픈", (await openEditor()) === true)) return;
    const reopened = await S(`ui().toggles`);
    r.check(
      "(j-4) 다시 열어도 토글이 유지된다(취향은 문서가 아니라 사용자에 속한다)",
      KEYS.every((k) => reopened[k] === after[k]),
      KEYS.map((k) => `${k}:${reopened[k]}`).join(" "),
    );
    // 원복 — 다음 스위트가 뒤집힌 토글을 물려받지 않게.
    for (const label of LABELS) await S(`clickToggle(${J(label)})`);

    // ══ 태스크 43 — 화면 크롬 · 스냅 · 눈금자 · 가이드 · 측정 ═══════════════
    //
    // 케이스 번호에 태스크를 붙인다: 위 (c-1)~(c-10) 은 42 의 **키 스코프** 케이스이고,
    // 설계 43 §7 도 자기 케이스를 (c-1)~(c-12) 로 부른다. 접두사가 없으면 한 보고서에
    // 뜻이 다른 (c-3) 이 둘 생겨 실패한 쪽이 어느 계약인지 알 수 없다.
    //
    // 이 절이 지키는 것 하나: **크롬은 화면에만 있고 파일에는 없다.** 그래서 단언이 두
    // 갈래다 — SVG 요소를 세는 쪽(있어야 한다)과 저장본 픽셀을 읽는 쪽(없어야 한다).
    await closeEditor();
    await sleep(250);
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    if (!r.check("(43 c-0) 크롬 검증용 재오픈", (await openEditor()) === true)) return;

    // 사용자가 꺼 둔 스냅으로 스냅을 재면 안 된다 — 전제를 명시적으로 세우고 끝에 원복한다.
    const T0 = await S(`ui().toggles`);
    const WANT = {
      snap: true,
      smartGuides: true,
      gapBadges: true,
      snapObjects: true,
      snapGuides: true,
      guidesVisible: true,
      rulers: false,
      pixelGrid: false,
      snapPixel: false,
      // **그리드 후보까지 끈다.** 불리언만 맞춰 놓고 이걸 빠뜨리면 사용자가 SnapSection 에서
      // 골라 둔 16px 이 최하위 스냅 후보로 살아남는다 — (c-8) 의 GC 는 108→112 로 붙어
      // 등간격 보정이 통째로 건너뛰어지고(snap.ts `if (!x.line)`), (c-10a) 의 둘째 측정 점은
      // 140→144 로 붙어 "104 px" 이 된다. 두 실패 모두 여기 한 줄이 원인이었다.
      grid: 0,
    };
    const badToggle = [];
    for (const k of Object.keys(WANT)) {
      const ok = await cdp.eval(
        `window.__gpvShell.setToggle(${J(k)}, ${J(WANT[k])})`,
      );
      if (ok !== true) badToggle.push(`${k}=${await S(`ui().toggles.${k}`)}`);
    }
    r.check(
      "(43 c-0b) 전제 토글을 알려진 값으로 맞춘다(상태바 5개 + 인스펙터 `스냅 · 가이드` 섹션 + 그리드)",
      badToggle.length === 0,
      `실패=${J(badToggle)}`,
    );

    // ── (43 c-1)(c-2) 스냅과 그 해제 ────────────────────────────────────────
    const SNAP2 = [rect("A", 40, 40, 60, 60), rect("B", 150, 40, 60, 60)];
    /** B 중심을 잡고 왼쪽으로 108 — 왼변이 42 에 선다(A 왼변 40 에서 2px). */
    const dragB = async (opts) => {
      await seed(SNAP2);
      await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
      await cdp.eval(
        `window.__gpvShell.pointerSeq([['down',180,70],['move',120,70],['move',72,70],['up',72,70]], ${J(
          opts || null,
        )})`,
      );
      await sleep(150);
      return cdp.eval(`window.__gpvShell.doc().objects.find((o) => o.id === 'B').x`);
    };
    const snapX = await dragB();
    r.check(
      "(43 c-1) 스냅은 '가까이'가 아니라 **정확한 값**에 붙인다 — 2px 남기고 놓아도 A 왼변과 딱 맞는다",
      snapX === 40,
      `B.x=${snapX} (기대 40)`,
    );
    const altX = await dragB({ alt: true });
    r.check(
      "(43 c-2a) Alt 드래그는 스냅을 끈다 — '정확히 여기에 놓겠다'는 뜻이라 저항이 있으면 안 된다",
      altX === 42,
      `B.x=${altX} (기대 42)`,
    );
    await cdp.eval(`window.__gpvShell.setToggle('snap', false)`);
    const offX = await dragB();
    await cdp.eval(`window.__gpvShell.setToggle('snap', true)`);
    r.check(
      "(43 c-2b) 스냅 토글은 실제로 엔진을 끈다(같은 드래그가 붙지 않는다)",
      offX === 42,
      `B.x=${offX} (기대 42)`,
    );

    // ── (43 c-2c) 클릭은 드래그가 아니다 ────────────────────────────────────
    //
    // 클릭은 **길이 0 의 move 드래그**다(pointerup 이 `applyDragAt` 를 한 번 더 부른다).
    // 델타 0 을 그냥 통과시키면 "선택하려고 눌렀을 뿐인데 도형이 튀고 히스토리가 한 칸 쌓인다".
    // NC 왼변 102 는 캔버스 후보 100 에서 2px — 가드가 없으면 클릭 한 번에 100 으로 붙는다.
    // (y 는 아래변 200 이 캔버스 후보와 정확히 겹쳐 델타 0 이라 x 하나만 움직인다.)
    await seed([rect("NA", 40, 40, 60, 60), rect("NC", 102, 140, 60, 60)]);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    const nudgeH0 = await cdp.eval(`window.__gpvShell.ed().history.entries().length`);
    await S(`pointerSeq([['down',132,170],['up',132,170]])`);
    await sleep(200);
    const nudge = await cdp.eval(`({
      x: window.__gpvShell.doc().objects.find((o) => o.id === 'NC').x,
      sel: window.__gpvShell.ui().selectedIds.length,
      hist: window.__gpvShell.ed().history.entries().length,
    })`);
    r.check(
      "(43 c-2c) 클릭만으로는 스냅이 걸리지 않는다 — 고르기만 했으니 자리도 히스토리도 그대로다",
      nudge.x === 102 && nudge.sel === 1 && nudge.hist === nudgeH0,
      `NC.x=${nudge.x} (기대 102) 선택=${nudge.sel} hist=${nudgeH0}→${nudge.hist}`,
    );

    // ── (43 c-3) 크롬 비영속 — 이 태스크의 핵심 회귀 ────────────────────────
    //
    // A 를 위(y 20~40), B 를 아래(y 120~140)에 두고 B 를 A 왼변에 맞춘다. 그러면 스마트
    // 가이드가 두 상자 **사이**(y 40~120)를 지나므로 그 구간의 픽셀 하나로 "크롬이 캔버스에도
    // 파일에도 없다"를 잴 수 있다 — 상자 위에 겹치면 주석 색에 묻혀 아무것도 못 잰다.
    await seed([rect("A", 40, 20, 60, 20), rect("B", 150, 120, 60, 20)]);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await cdp.eval(
      `window.__gpvShell.pointerSeq([['down',180,130],['move',110,130],['move',72,130]])`,
    );
    await sleep(200);
    const mid = await cdp.eval(`({
      smart: window.__gpvShell.chromeN('[data-chrome="smart"] line'),
      hud: window.__gpvShell.chromeTexts('[data-chrome="hud"] text'),
      canvas: window.__gpvShell.px(1, 40, 60),
    })`);
    r.check(
      "(43 c-3a) 드래그 중 스마트 가이드가 SVG 로 뜬다 — 무엇에 붙었는지 화면이 말한다",
      mid.smart >= 1,
      `line=${mid.smart} hud=${J(mid.hud)}`,
    );
    r.check(
      "(43 c-3b) 그 순간에도 **씬 캔버스에는 크롬이 한 획도 없다**(가이드 자리 픽셀이 원본 흰색)",
      isWhite(mid.canvas),
      `px(1,40,60)=${J(mid.canvas)}`,
    );
    await cdp.eval(`window.__gpvShell.pointerSeq([['up',72,130]])`);
    await sleep(200);
    const smartUp = await S(`chromeN('[data-chrome="smart"] line')`);
    r.check(
      "(43 c-3c) 손을 떼면 스마트 가이드가 사라진다 — 남으면 분홍 선이 화면에 굳는다",
      smartUp === 0,
      `line=${smartUp}`,
    );

    // 드래그를 **연 채로** 저장한다. 크롬이 가장 많이 떠 있는 순간의 파일을 보는 것이 요점이다.
    // 앞 드래그가 B 를 이미 옮겨 놓았으므로 자리를 되돌려 같은 제스처를 다시 만든다.
    await seed([rect("A", 40, 20, 60, 20), rect("B", 150, 120, 60, 20)]);
    await sleep(150);
    await cdp.eval(
      `window.__gpvShell.pointerSeq([['down',180,130],['move',110,130],['move',72,130]])`,
    );
    await sleep(200);
    const CHROME_OUT = "e2e-shell-chrome.png";
    created.push(CHROME_OUT);
    // 앞 회차가 남긴 파일이 있으면 저장이 '덮어쓰기' 확인창을 열고 멈춘다 — 그 확인창이 뜨면
    // `useEditorKeys` 게이트 ①이 이후 모든 키를 통과시켜 뒤따르는 단언이 통째로 무의미해진다.
    try {
      const stale = join(fix.repo, CHROME_OUT);
      if (existsSync(stale)) unlinkSync(stale);
    } catch {
      /* 남아 있으면 아래 저장이 실패로 보고된다 */
    }
    const svRes = await cdp.eval(`window.__gpvShell.saveAs(${J(CHROME_OUT)})`);
    const svClosed = await poll(
      () => S(`gone()`).catch(() => false),
      (v) => v === true,
      30,
      200,
    );
    const svDisk = await poll(
      async () => existsSync(join(fix.repo, CHROME_OUT)),
      (v) => v === true,
      30,
      200,
    );
    if (
      r.check(
        "(43 c-3) 드래그 중 상태 저장",
        svRes?.ok === true && svClosed === true && svDisk === true,
        `${J(svRes)} closed=${svClosed} disk=${svDisk}`,
      )
    ) {
      // [40,60] = 스마트 가이드 선 · [70,147] = HUD 뱃지 상단(글자 위) · [180,60] = 대조군.
      const filePx = await cdp.eval(
        `window.__gpvShell.readSaved(${J(fix.projectId)}, ${J(
          CHROME_OUT,
        )}, [[40,60],[70,147],[180,60]])`,
      );
      r.check(
        "(43 c-3d) 저장본에 스마트 가이드도 HUD 뱃지도 없다 — 크롬은 렌더 진입과 **DOM 부터** 갈라져 있다",
        Array.isArray(filePx) && filePx.every(isWhite),
        J(filePx),
      );
    }
    if (!r.check("(43 c-3e) 저장 뒤 재오픈", (await openEditor()) === true)) return;

    // ── (43 c-4) 눈금자 ─────────────────────────────────────────────────────
    await cdp.eval(`window.__gpvShell.setToggle('rulers', true)`);
    await seed([]);
    await sleep(200);
    const rulerNow = () =>
      cdp.eval(`({
        labels: window.__gpvShell.rulerLabels('x'),
        scale: window.__gpvShell.screen().scale,
      })`);
    /** 라벨 사이 css 간격 == 라벨 값 차이 × 배율, 그리고 서로 붙지 않는다(≥50css). */
    const spacingOk = (o) => {
      const L = o?.labels ?? [];
      if (L.length < 3) return false;
      for (let i = 1; i < L.length; i++) {
        const dv = L[i].v - L[i - 1].v;
        const dx = L[i].at - L[i - 1].at;
        if (dx < 50 || Math.abs(dx - dv * o.scale) > 0.5) return false;
      }
      return true;
    };
    const rk1 = await rulerNow();
    r.check(
      "(43 c-4a) 눈금자 라벨은 **이미지 좌표**이고, 그 간격이 화면 배율과 정확히 맞는다(±0.5)",
      spacingOk(rk1),
      `scale=${rk1?.scale} labels=${J((rk1?.labels ?? []).slice(0, 4))}`,
    );
    await S(`zoomSelect('2')`);
    await sleep(200);
    const rk2 = await rulerNow();
    r.check(
      "(43 c-4b) 확대하면 눈금이 다시 계산된다 — 라벨이 겹치지도, 화면 밖으로 밀려 사라지지도 않는다",
      spacingOk(rk2) && Math.abs((rk2?.scale ?? 0) - 2) < 0.01,
      `scale=${rk2?.scale} n=${rk2?.labels?.length}`,
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'!', code:'Digit1', shiftKey:true })`);
    await sleep(200);
    const zeroBefore = (await rulerNow())?.labels?.find((l) => l.v === 0);
    await S(`pan(60, -40)`);
    await sleep(200);
    const zeroAfter = (await rulerNow())?.labels?.find((l) => l.v === 0);
    r.check(
      "(43 c-4c) 팬하면 눈금자가 이미지와 **함께** 밀린다(원점 라벨이 정확히 60px 이동)",
      !!zeroBefore && !!zeroAfter && Math.abs(zeroAfter.at - zeroBefore.at - 60) <= 0.5,
      `0 라벨 ${zeroBefore?.at} → ${zeroAfter?.at}`,
    );
    const ticks = await cdp.eval(`window.__gpvShell.ed().rulerTicks(0.7, 0, 1200)`);
    r.check(
      "(43 c-4d) `rulerTicks(0.7, …)` 는 100 oriented px 마다 라벨을 준다(시안 70% 기준)",
      ticks?.major?.[1]?.label === "100",
      J(ticks?.major?.slice(0, 3)),
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'!', code:'Digit1', shiftKey:true })`);
    await sleep(150);

    // ── (43 c-5) 가이드 — 만들고 · 붙고 · 되돌리고 · 지운다 ─────────────────
    await seed([]);
    await sleep(150);
    await S(`guideDrag('y', 100)`);
    await sleep(250);
    const gd1 = await cdp.eval(`({
      guides: window.__gpvShell.doc().guides,
      label: window.__gpvShell.ed().history.entries()[0].label,
      lines: window.__gpvShell.chromeN('[data-chrome="guides"] line'),
    })`);
    r.check(
      "(43 c-5a) 눈금자에서 끌어낸 가이드는 **문서**에 남는다 — 히스토리·사이드카를 공짜로 탄다",
      gd1.guides?.length === 1 &&
        gd1.guides[0].axis === "y" &&
        gd1.guides[0].pos === 100 &&
        /가이드 추가/.test(gd1.label || "") &&
        gd1.lines === 1,
      `guides=${J(gd1.guides)} label=${gd1.label} line=${gd1.lines}`,
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
    await sleep(250);
    const gd2 = await S(`doc().guides`);
    r.check(
      "(43 c-5b) Ctrl+Z 한 번이 그 가이드를 되돌린다(문서에 살기 때문에)",
      Array.isArray(gd2) && gd2.length === 0,
      J(gd2),
    );

    // 캔버스 후보(0·100·200)에서 멀리 떨어진 63 에 만든다 — 여기 붙으면 **가이드에** 붙은 것이다.
    await seed([rect("G", 20, 140, 40, 40)]);
    await sleep(150);
    await S(`guideDrag('y', 63)`);
    await sleep(250);
    const gpos = await cdp.eval(`(window.__gpvShell.doc().guides[0] || {}).pos`);
    if (typeof gpos === "number") {
      const gy = (gpos + 2.5 + 20).toFixed(3); // G 중심(160)을 윗변이 가이드 2.5px 아래 오도록
      await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
      await cdp.eval(
        `window.__gpvShell.pointerSeq([['down',40,160],['move',40,${gy}],['up',40,${gy}]])`,
      );
      await sleep(200);
      const oy = await cdp.eval(`window.__gpvShell.doc().objects[0].y`);
      r.check(
        "(43 c-5c) 객체가 가이드에 붙는다 — 임계 안에서 놓으면 가이드 좌표 **그대로**다",
        Math.abs(oy - gpos) < 1e-6,
        `y=${oy} guide=${gpos}`,
      );
      await cdp.eval(
        `window.__gpvShell.pointerSeq([['down',150,${gpos}],['move',150,-40],['up',150,-40]])`,
      );
      await sleep(250);
      const gd3 = await cdp.eval(`({
        guides: window.__gpvShell.doc().guides,
        label: window.__gpvShell.ed().history.entries()[0].label,
      })`);
      r.check(
        "(43 c-5d) 가이드를 이미지 밖으로 끌면 지워진다(커밋 라벨 `가이드 삭제`)",
        gd3.guides?.length === 0 && /가이드 삭제/.test(gd3.label || ""),
        `guides=${J(gd3.guides)} label=${gd3.label}`,
      );
    } else {
      r.skip("(43 c-5c)(c-5d) 가이드 이동·삭제", `가이드가 만들어지지 않았다 — pos=${J(gpos)}`);
    }
    await cdp.eval(`window.__gpvShell.setToggle('rulers', false)`);

    // ── (43 c-6) Alt 측정 ───────────────────────────────────────────────────
    await seed(SNAP2);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await cdp.eval(`window.__gpvShell.pointerSeq([['down',70,70],['up',70,70]])`);
    await sleep(150);
    await S(`hover(180, 70, { alt: true })`);
    await sleep(200);
    const ms1 = await S(`chromeTexts('[data-chrome="measure"] text')`);
    r.check(
      "(43 c-6a) Alt 홀드 호버가 선택과 대상 사이를 잰다(A 우변 100 ↔ B 좌변 150 = 50)",
      Array.isArray(ms1) && ms1.length === 1 && ms1[0] === "50",
      J(ms1),
    );
    await cdp.eval(
      `window.__gpvShell.fire({ key:'Alt', code:'AltLeft', altKey:true }, 'keyup')`,
    );
    await sleep(200);
    const ms2 = await S(`chromeN('[data-chrome="measure"] text')`);
    r.check(
      "(43 c-6b) Alt 를 떼면 측정이 사라진다 — 포인터가 멈춰 있어도 홀드가 풀린 것을 안다",
      ms2 === 0,
      `text=${ms2}`,
    );
    await S(`hover(130, 180, { alt: true })`);
    await sleep(200);
    const ms3 = await S(`chromeTexts('[data-chrome="measure"] text')`);
    r.check(
      "(43 c-6c) 대상이 없으면 캔버스 4변까지의 거리 4개를 보여 준다",
      Array.isArray(ms3) && ms3.length === 4,
      J(ms3),
    );
    await S(`hover(190, 190)`);

    // ── (43 c-7) 픽셀 그리드 ────────────────────────────────────────────────
    await cdp.eval(`window.__gpvShell.setToggle('pixelGrid', true)`);
    await S(`zoomSelect('4')`);
    await sleep(250);
    const pg4 = await cdp.eval(`({
      grid: window.__gpvShell.pixelGrid(),
      scale: window.__gpvShell.screen().scale,
    })`);
    r.check(
      "(43 c-7a) 400% 에서 픽셀 그리드가 CSS 그라디언트로 뜬다(캔버스 메모리 0 · 셀 = 1 oriented px)",
      pg4.grid?.display !== "none" && pg4.grid?.size === `${pg4.scale}px ${pg4.scale}px`,
      J(pg4),
    );
    await S(`zoomSelect('1')`);
    await sleep(250);
    const pg1 = await S(`pixelGrid()`);
    r.check(
      "(43 c-7b) 100% 에서는 아예 그리지 않는다 — 그 배율의 격자는 회색 띠가 된다",
      pg1?.display === "none",
      J(pg1),
    );
    await cdp.eval(`window.__gpvShell.setToggle('pixelGrid', false)`);

    // ── (43 c-8) 등간격 ─────────────────────────────────────────────────────
    //
    // 좌표는 캔버스 후보(0·100·200)에서 4px 넘게 떨어뜨린다 — 변 스냅이 먼저 잡히면
    // `snapRect` 가 그 축의 등간격 보정을 아예 건너뛴다(뱃지도 안 뜬다).
    await seed([
      rect("GA", 10, 40, 30, 30),
      rect("GB", 60, 40, 30, 30),
      rect("GC", 150, 40, 30, 30),
    ]);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await cdp.eval(
      `window.__gpvShell.pointerSeq([['down',165,55],['move',140,55],['move',123,55]])`,
    );
    await sleep(200);
    const gap = await S(`chromeTexts('[data-chrome="measure"] text')`);
    await cdp.eval(`window.__gpvShell.pointerSeq([['up',123,55]])`);
    await sleep(200);
    const gcx = await cdp.eval(
      `window.__gpvShell.doc().objects.find((o) => o.id === 'GC').x`,
    );
    r.check(
      "(43 c-8) 등간격이 감지되면 간격만큼 보정하고 양쪽 간격 뱃지를 띄운다(20 · 20 → x=110)",
      gcx === 110 && Array.isArray(gap) && gap.length === 2 && gap.every((t) => t === "20"),
      `GC.x=${gcx} (기대 110) 뱃지=${J(gap)}`,
    );

    // ── (43 c-9) 선택 상자·핸들 ─────────────────────────────────────────────
    await seed([rect("S", 40, 40, 60, 60)]);
    await selectAll();
    await sleep(200);
    const selChrome = await cdp.eval(`({
      box: window.__gpvShell.selBox(),
      screen: window.__gpvShell.screen(),
      handles: window.__gpvShell.chromeN('[data-chrome="handles"] rect'),
    })`);
    const sc = selChrome.screen;
    const near = (a, b) => Math.abs(a - b) <= 0.5;
    r.check(
      "(43 c-9a) 선택 상자가 `getBoundingClientRect` 없이 산술로만 계산한 자리에 놓인다(±0.5) · 핸들 8",
      !!selChrome.box &&
        !!sc &&
        near(selChrome.box.x, sc.x + 40 * sc.scale) &&
        near(selChrome.box.y, sc.y + 40 * sc.scale) &&
        near(selChrome.box.w, 60 * sc.scale) &&
        near(selChrome.box.h, 60 * sc.scale) &&
        selChrome.handles === 8,
      `box=${J(selChrome.box)} screen=${J(sc)} handles=${selChrome.handles}`,
    );
    await S(`zoomSelect('4')`);
    await sleep(250);
    const hb = await S(`handleBox()`);
    r.check(
      "(43 c-9b) 400% 로 확대해도 핸들은 **8 css px** 그대로다(캔버스 크롬을 버린 바로 그 이유)",
      !!hb && near(hb.w, 8) && near(hb.h, 8),
      J(hb),
    );
    await S(`zoomSelect('1')`);
    await sleep(200);

    // ── (43 c-10) 측정 도구 ─────────────────────────────────────────────────
    await seed([]);
    await cdp.eval(`window.__gpvShell.ed().setTool('measure')`);
    const histBefore = await cdp.eval(`window.__gpvShell.ed().history.entries().length`);
    await S(`pointerSeq([['down',40,40],['up',40,40]])`);
    await sleep(150);
    await S(`pointerSeq([['down',140,40],['up',140,40]])`);
    await sleep(250);
    const meas = await cdp.eval(`(() => {
      const os = window.__gpvShell.doc().objects;
      const g = os.find((o) => o.kind === 'group');
      const t = os.find((o) => o.kind === 'text');
      const h = window.__gpvShell.ed().history.entries();
      return {
        kinds: os.map((o) => o.kind),
        name: g ? g.name : null,
        text: t ? t.text : null,
        hist: h.length,
        label: h[0].label,
      };
    })()`);
    r.check(
      "(43 c-10a) 측정 도구는 두 점으로 `측정 라벨` 그룹(선+텍스트)을 **한 커밋**에 만든다",
      meas.kinds?.length === 3 &&
        meas.name === "측정 라벨" &&
        meas.text === "100 px" &&
        meas.hist === histBefore + 1 &&
        /측정 라벨/.test(meas.label || ""),
      J(meas),
    );
    await seed([]);
    await cdp.eval(`window.__gpvShell.ed().setTool('measure')`);
    await S(`pointerSeq([['down',40,40],['up',40,40]])`);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(150);
    await S(`pointerSeq([['down',140,40],['up',140,40]])`);
    await sleep(250);
    const measEsc = await S(`doc().objects.length`);
    r.check(
      "(43 c-10b) Esc 는 찍어 둔 시작점을 버린다 — 다음 클릭이 그 점을 잇지 않는다",
      measEsc === 0,
      `objects=${measEsc}`,
    );
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);

    // ── (43 c-11) 크롭 오버레이 ─────────────────────────────────────────────
    //
    // 48(크롭 세션)이 오기 전이라 상태를 직접 밀어 넣는다. 읽기까지 한 eval 안에서 끝내는
    // 이유: 다음 프레임의 `paintNow` 가 이 강제 상태를 곧바로 덮어쓴다.
    const cropOf = (overlay) =>
      cdp.eval(`(() => {
        const ok = window.__gpvShell.ed().chrome.set({
          crop: { rect: { x: 40, y: 40, w: 120, h: 80 }, overlay: ${J(overlay)},
                  label: '2400 × 1600 · 3:2', handles: true },
        });
        return {
          ok: ok,
          line: window.__gpvShell.chromeN('[data-chrome="crop"] line'),
          dim: window.__gpvShell.chromeN('[data-chrome="crop"] rect[data-k="dim"]'),
          handle: window.__gpvShell.chromeN('[data-chrome="crop"] rect[data-k="handle"]'),
          badge: window.__gpvShell.chromeTexts('[data-chrome="crop"] text'),
        };
      })()`);
    const cr3 = await cropOf("thirds");
    const cr4 = await cropOf("quarters");
    const crg = await cropOf("golden");
    const crd = await cropOf("diagonal");
    r.check(
      "(43 c-11) 크롭 구도: 3분할 4선 · 4분할 6선 · 황금비 4선 · 대각선 2선, 딤 4면 + 핸들 8 + 뱃지",
      cr3.ok === true &&
        cr3.line === 4 &&
        cr4.line === 6 &&
        crg.line === 4 &&
        crd.line === 2 &&
        cr3.dim === 4 &&
        cr3.handle === 8 &&
        cr3.badge?.[0] === "2400 × 1600 · 3:2",
      `thirds=${J(cr3)} quarters=${cr4.line} golden=${crg.line} diagonal=${crd.line}`,
    );

    // ── (43 c-12) HUD ───────────────────────────────────────────────────────
    await seed([rect("H", 40, 40, 60, 60)]);
    await selectAll();
    await sleep(200);
    const hud1 = await S(`chromeTexts('[data-chrome="hud"] text')`);
    r.check(
      "(43 c-12a) 선택이 있으면 HUD 가 크기를 말한다(`60 × 60`)",
      Array.isArray(hud1) && hud1[0] === "60 × 60",
      J(hud1),
    );
    await cdp.eval(
      `window.__gpvShell.pointerSeq([['down',70,70],['move',90,90],['move',100,100]])`,
    );
    await sleep(200);
    const hud2 = await S(`chromeTexts('[data-chrome="hud"] text')`);
    await cdp.eval(`window.__gpvShell.pointerSeq([['up',100,100]])`);
    await sleep(150);
    r.check(
      "(43 c-12b) 이동 드래그 중에는 델타로 바뀐다(`+dx +dy`)",
      Array.isArray(hud2) && /^\+\d+\s+\+\d+$/.test(hud2[0] || ""),
      J(hud2),
    );

    // 토글 원복 — 이 절이 세운 전제를 다음 스위트가 물려받지 않게.
    for (const k of Object.keys(WANT)) {
      if (T0) await cdp.eval(`window.__gpvShell.setToggle(${J(k)}, ${J(T0[k])})`);
    }

    // ══ 태스크 44 — 좌측 패널: 레이어 트리 · 히스토리 ═══════════════════════
    //
    // 패널은 문서의 **뷰**다: 검색·필터·접기는 문서에 남지 않고, 이름·눈/자물쇠·순서는
    // 전부 `onCommit(objects, label)` 하나로 나간다. 그래서 여기 단언은 늘 셋을 함께 본다 —
    // 행(DOM) · 문서(getDoc) · 히스토리 라벨.
    await closeEditor();
    await sleep(250);
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    if (!r.check("(44 L-0) 패널 검증용 재오픈", (await openEditor()) === true)) return;

    const LEAF = [
      rect("la", 10, 10, 30, 30),
      { id: "lb", kind: "ellipse", parentId: null, stroke: "#FF3B30", strokeWidth: 0,
        opacity: 1, rot: 0, x: 60, y: 10, w: 30, h: 30, fill: "#FF3B30" },
      { id: "lc", kind: "text", parentId: null, stroke: "#111111", strokeWidth: 0,
        opacity: 1, rot: 0, x: 10, y: 60, w: 80, h: 18, text: "e2e", fontSize: 14 },
      { id: "ld", kind: "badge", parentId: null, stroke: "#FFFFFF", strokeWidth: 0,
        opacity: 1, rot: 0, x: 120, y: 60, n: 3, fontSize: 14 },
      { id: "le", kind: "mosaic", parentId: null, stroke: "#000000", strokeWidth: 0,
        opacity: 1, rot: 0, x: 10, y: 100, w: 40, h: 40, mode: "pixelate", strength: 8 },
    ];
    await seed(LEAF);
    await sleep(250);
    const rows1 = await cdp.eval(`({
      model: window.__gpvShell.ed().layers(),
      dom: window.__gpvShell.rowDom(),
    })`);
    r.check(
      "(44 L-1) 문서 트리가 행 목록이 된다 — 위가 앞(문서 역순) · 배경 행이 최하단 · 기본 이름 규칙",
      J(rows1.model?.rows?.map((x) => x.name)) ===
        J(["모자이크 1", "번호 뱃지 #3", '텍스트 "e2e"', "타원 1", "사각형 1", `배경 — ${SRC}`]) &&
        rows1.model?.rows?.[5]?.locked === true &&
        rows1.dom.length === 6 &&
        rows1.dom.every((d) => d.h === 28),
      `names=${J(rows1.model?.rows?.map((x) => x.name))} dom=${rows1.dom?.length} h=${J(
        rows1.dom?.map((d) => d.h),
      )}`,
    );

    // ── (44 L-2) 중첩 · 접기 · 검색 ─────────────────────────────────────────
    const gid = await cdp.eval(`window.__gpvShell.ed().tree.group(['la','lb'])`);
    await sleep(250);
    const grouped = await cdp.eval(`window.__gpvShell.ed().layers().rows`);
    const gRow = (grouped || []).find((x) => x.id === gid);
    const kidRows = (grouped || []).filter((x) => x.id === "la" || x.id === "lb");
    r.check(
      "(44 L-2a) 그룹은 depth 0 · 자식은 depth 1 이고 컨테이너 기본 블렌드가 `패스스루` 뱃지로 보인다",
      !!gRow && gRow.depth === 0 && kidRows.length === 2 &&
        kidRows.every((x) => x.depth === 1) && J(gRow.badges) === J(["패스스루"]),
      `group=${J(gRow)} kids=${J(kidRows.map((x) => [x.id, x.depth]))}`,
    );
    await cdp.eval(`window.__gpvShell.ed().panel.toggleCollapsed(${J(gid)})`);
    await sleep(200);
    const collapsedDom = await cdp.eval(
      `window.__gpvShell.rowDom().map((d) => d.id)`,
    );
    await cdp.eval(`window.__gpvShell.ed().panel.setQuery('타원')`);
    await sleep(200);
    const searched = await cdp.eval(
      `window.__gpvShell.ed().layers().rows.map((x) => x.id)`,
    );
    await cdp.eval(`window.__gpvShell.ed().panel.setQuery('')`);
    await cdp.eval(`window.__gpvShell.ed().panel.toggleCollapsed(${J(gid)})`);
    await sleep(200);
    r.check(
      "(44 L-2b) 접으면 자식 행이 DOM 에서 빠지고, 검색은 접기를 무시한 채 **매치 + 조상**만 남긴다",
      !collapsedDom.includes("la") && !collapsedDom.includes("lb") &&
        J(searched) === J([gid, "lb"]),
      `접힘=${J(collapsedDom)} 검색=${J(searched)}`,
    );

    // ── (44 L-3) 선택 동기 ──────────────────────────────────────────────────
    await seed(LEAF);
    await sleep(250);
    await S(`clickRow('lc')`);
    await sleep(150);
    const pick1 = await cdp.eval(`({
      ids: window.__gpvShell.ui().selectedIds,
      n: window.__gpvShell.selCount(),
    })`);
    await S(`clickRow('ld', { shift: true })`);
    await sleep(150);
    const pick2 = await cdp.eval(`({
      ids: window.__gpvShell.ui().selectedIds,
      n: window.__gpvShell.selCount(),
      foot: window.__gpvShell.panelText('layers'),
    })`);
    r.check(
      "(44 L-3a) 행 클릭·⇧클릭이 캔버스와 **같은 선택 상태**를 바꾸고 푸터·상태바가 같은 수를 말한다",
      J(pick1.ids) === J(["lc"]) && pick1.n === 1 &&
        J(pick2.ids) === J(["lc", "ld"]) && pick2.n === 2 &&
        /2개 선택됨/.test(pick2.foot || ""),
      `1=${J(pick1)} 2=${J(pick2.ids)}/${pick2.n}`,
    );
    await S(`clickRowBtn('le', /^(잠금|잠금 해제)$/)`);
    await sleep(200);
    await S(`clickRow('le')`);
    await sleep(150);
    const lockedSel = await cdp.eval(`({
      ids: window.__gpvShell.ui().selectedIds,
      locked: window.__gpvShell.doc().objects.find((o) => o.id === 'le').locked,
    })`);
    r.check(
      "(44 L-3b) 잠긴 노드도 **패널에서는** 선택된다(캔버스 클릭은 38 (d) 대로 통과시킨다)",
      lockedSel.locked === true && J(lockedSel.ids) === J(["le"]),
      J(lockedSel),
    );
    await S(`clickRowBtn('le', /^(잠금|잠금 해제)$/)`);
    await sleep(150);

    // ── (44 L-4) 이름 변경 ──────────────────────────────────────────────────
    await S(`clickRow('la')`);
    await sleep(150);
    await cdp.eval(`window.__gpvShell.fire({ key:'F2', code:'F2' })`);
    await sleep(200);
    const renamed = await cdp.eval(`(() => {
      const el = window.__gpvShell.rowEl('la');
      const inp = el ? el.querySelector('input') : null;
      if (!inp) return { ok: false };
      // 포커스를 명시한다 — 입력에 포커스가 없으면 window capture 리스너가 Enter 를
      // 먼저 소비해(표의 'enter' 행) 확정이 통째로 죽는다.
      inp.focus();
      inp.value = '검사 영역';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      return { ok: document.activeElement === inp };
    })()`);
    await sleep(250);
    const nameNow = await cdp.eval(`({
      doc: (window.__gpvShell.doc().objects.find((o) => o.id === 'la') || {}).name,
      row: (window.__gpvShell.ed().layers().rows.find((x) => x.id === 'la') || {}).name,
      label: window.__gpvShell.ed().history.entries()[0].label,
    })`);
    r.check(
      "(44 L-4a) F2 → 입력 → Enter 가 문서 이름을 바꾸고 행·히스토리가 같은 값을 본다",
      renamed.ok === true && nameNow.doc === "검사 영역" && nameNow.row === "검사 영역" &&
        nameNow.label === "이름 변경",
      J(nameNow),
    );
    await cdp.eval(`window.__gpvShell.fire({ key:'F2', code:'F2' })`);
    await sleep(200);
    const canceled = await cdp.eval(`(() => {
      const el = window.__gpvShell.rowEl('la');
      const inp = el ? el.querySelector('input') : null;
      if (!inp) return { ok: false };
      inp.focus();
      inp.value = '버릴 이름';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return { ok: document.activeElement === inp };
    })()`);
    await sleep(250);
    const nameAfterEsc = await cdp.eval(
      `(window.__gpvShell.doc().objects.find((o) => o.id === 'la') || {}).name`,
    );
    r.check(
      "(44 L-4b) Esc 는 이름을 버린다 — 확정이 두 번 나가 히스토리가 두 칸 쌓이지도 않는다",
      canceled.ok === true && nameAfterEsc === "검사 영역",
      `name=${J(nameAfterEsc)}`,
    );

    // ── (44 L-5) 눈 · 자물쇠 · 헤더 액션 ────────────────────────────────────
    await seed(LEAF);
    await sleep(250);
    await S(`clickRowBtn('la', /^(숨기기|표시)$/)`);
    await sleep(250);
    const hidden = await cdp.eval(`({
      visible: window.__gpvShell.doc().objects.find((o) => o.id === 'la').visible,
      px: window.__gpvShell.px(1, 20, 20),
      cls: (window.__gpvShell.rowDom().find((d) => d.id === 'la') || {}).cls,
      label: window.__gpvShell.ed().history.entries()[0].label,
    })`);
    r.check(
      "(44 L-5a) 행 눈은 그 노드만 끈다 — 프리뷰에서 사라지고 행이 흐려진다(라벨 `숨김`)",
      hidden.visible === false && isWhite(hidden.px) &&
        /opacity-50/.test(hidden.cls || "") && hidden.label === "숨김",
      J(hidden),
    );
    await S(`clickRowBtn('la', /^(숨기기|표시)$/)`);
    await sleep(200);
    await S(`clickRow('lb')`);
    await S(`clickRow('lc', { shift: true })`);
    await sleep(150);
    await S(`clickPanelBtn('layers', '선택 잠금/잠금 해제')`);
    await sleep(250);
    const bulkLock = await cdp.eval(
      `window.__gpvShell.doc().objects.filter((o) => o.locked).map((o) => o.id)`,
    );
    r.check(
      "(44 L-5b) 헤더 자물쇠는 **선택 전체**에 같은 값을 건다",
      J(bulkLock) === J(["lb", "lc"]),
      J(bulkLock),
    );
    const beforeDel = await cdp.eval(`window.__gpvShell.ids()`);
    await S(`clickPanelBtn('layers', '삭제')`);
    await sleep(250);
    const afterDel = await cdp.eval(`window.__gpvShell.ids()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
    await sleep(250);
    const afterUndo = await cdp.eval(`window.__gpvShell.ids()`);
    r.check(
      "(44 L-5c) 헤더 휴지통은 Delete 와 **같은 핸들러**다 — 한 칸으로 지워지고 Ctrl+Z 로 돌아온다",
      afterDel.length === beforeDel.length - 2 && J(afterUndo) === J(beforeDel),
      `${beforeDel.length} → ${afterDel.length} → ${afterUndo.length}`,
    );

    // ── (44 L-6) 타입 필터 ──────────────────────────────────────────────────
    await seed(LEAF);
    await sleep(250);
    await cdp.eval(
      `window.__gpvShell.ed().panel.setFilter({ types: new Set(['text']) })`,
    );
    await sleep(200);
    const onlyText = await cdp.eval(`({
      ids: window.__gpvShell.ed().layers().rows.map((x) => x.id),
      head: window.__gpvShell.panelText('layers'),
    })`);
    r.check(
      "(44 L-6a) 타입 필터는 문서를 건드리지 않는 뷰다 — 텍스트만 남고 헤더가 `1/5` 로 바뀐다",
      J(onlyText.ids) === J(["lc"]) && /1\/5/.test(onlyText.head || "") &&
        (await cdp.eval(`window.__gpvShell.doc().objects.length`)) === 5,
      `ids=${J(onlyText.ids)} head=${J((onlyText.head || "").slice(0, 24))}`,
    );
    // 숨기기는 **행이 보이는 동안** 눌러야 한다 — 필터를 먼저 켜면 그 행이 사라져 누를 수 없다.
    const hideOk = await S(`clickRowBtn('lc', /^(숨기기|표시)$/)`);
    await sleep(250);
    await cdp.eval(`window.__gpvShell.ed().panel.setFilter({
      types: new Set(['frame','group','shape','text','image','vector','component']),
      hiddenOnly: true,
    })`);
    await sleep(250);
    const hiddenOnly = await cdp.eval(
      `window.__gpvShell.ed().layers().rows.map((x) => x.id)`,
    );
    r.check(
      "(44 L-6b) `숨김만` 은 타입을 모두 켜도 숨긴 행만 남긴다(상태 필터는 타입과 AND)",
      hideOk === true && J(hiddenOnly) === J(["lc"]),
      `hide=${hideOk} rows=${J(hiddenOnly)}`,
    );
    // `초기화 → 적용` 은 팝오버 UI 로 구동한다 — 초안(draft) 계약이 실제로 도는지 본다.
    await S(`clickPanelBtn('layers', '타입 필터')`);
    await sleep(200);
    const resetOk = await cdp.eval(`(async () => {
      const btns = Array.from(document.querySelectorAll('button'));
      const reset = btns.find((b) => (b.textContent || '').trim() === '초기화');
      const apply = btns.find((b) => (b.textContent || '').trim() === '적용');
      if (!reset || !apply) return false;
      reset.click();
      // React 19 는 discrete 갱신을 **마이크로태스크**에서 flush 한다 — 같은 동기 스크립트에서
      // 이어 누르면 \`적용\` 의 onClick 이 아직 초기화 이전 렌더의 클로저라 옛 draft 를 그대로
      // 다시 쓴다(필터가 한 톨도 안 바뀌고 뒤따르는 L-7~L-9 가 0행으로 무너진다).
      await window.__gpvShell.frame();
      apply.click();
      return true;
    })()`);
    await sleep(250);
    const restored = await cdp.eval(
      `window.__gpvShell.ed().layers().rows.map((x) => x.id)`,
    );
    r.check(
      "(44 L-6c) 팝오버 `초기화 → 적용` 이 필터를 기본값으로 되돌린다(6행 전부)",
      resetOk === true && restored.length === 6,
      `ok=${resetOk} rows=${J(restored)}`,
    );

    // ── (44 L-7) 드래그 순서 변경 ───────────────────────────────────────────
    await seed([
      rect("da", 10, 10, 20, 20),
      rect("db", 40, 10, 20, 20),
      rect("dc", 70, 10, 20, 20),
      rect("dd", 100, 10, 20, 20),
    ]);
    await sleep(250);
    const dropped = await S(`rowDrag('dd', 'da', 0.9)`);
    await sleep(300);
    const order1 = await cdp.eval(`({
      ids: window.__gpvShell.ids(),
      label: window.__gpvShell.ed().history.entries()[0].label,
    })`);
    await cdp.eval(`window.__gpvShell.fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
    await sleep(250);
    const order2 = await cdp.eval(`window.__gpvShell.ids()`);
    r.check(
      "(44 L-7a) 행을 아래로 끌면 문서 순서가 그만큼 바뀐다(패널 위 = 문서 뒤) · 한 칸 `순서 변경` · Ctrl+Z 원복",
      J(order1.ids) === J(["dd", "da", "db", "dc"]) &&
        order1.label === "순서 변경" &&
        J(order2) === J(["da", "db", "dc", "dd"]),
      `after=${J(order1.ids)} label=${order1.label} undo=${J(order2)} drop=${J(dropped)}`,
    );
    const dgid = await cdp.eval(`window.__gpvShell.ed().tree.group(['da','db'])`);
    await sleep(250);
    await S(`rowDrag('dd', ${J(dgid)}, 0.5)`);
    await sleep(300);
    const intoGroup = await cdp.eval(
      `(window.__gpvShell.doc().objects.find((o) => o.id === 'dd') || {}).parentId`,
    );
    r.check(
      "(44 L-7b) 그룹 행 가운데로 놓으면 **그 안**으로 들어간다",
      intoGroup === dgid,
      `parentId=${J(intoGroup)} group=${J(dgid)}`,
    );
    const beforeCycle = await cdp.eval(`window.__gpvShell.ids()`);
    const cycle = await S(`rowDrag(${J(dgid)}, 'da', 0.5)`);
    await sleep(300);
    const afterCycle = await cdp.eval(`window.__gpvShell.ids()`);
    r.check(
      "(44 L-7c) 자기 자식 안으로는 못 놓는다 — 순환이면 표시선도 안 뜨고 커밋도 없다",
      J(afterCycle) === J(beforeCycle) && cycle?.indicator === "none",
      `ids 그대로=${J(afterCycle) === J(beforeCycle)} drop=${J(cycle)}`,
    );
    // L-7a 와 **똑같은** 드래그에 Escape 만 끼운다 — 취소가 죽어 있으면 순서가 바뀐다.
    await seed([
      rect("da", 10, 10, 20, 20),
      rect("db", 40, 10, 20, 20),
      rect("dc", 70, 10, 20, 20),
      rect("dd", 100, 10, 20, 20),
    ]);
    await sleep(250);
    const escDrop = await S(`rowDrag('dd', 'da', 0.9, true)`);
    await sleep(300);
    const escOrder = await cdp.eval(`window.__gpvShell.ids()`);
    r.check(
      "(44 L-7d) 드래그 중 Escape 는 드롭을 버린다 — 손을 떼도 순서가 그대로다",
      J(escOrder) === J(["da", "db", "dc", "dd"]),
      `ids=${J(escOrder)} drop=${J(escDrop)}`,
    );

    // ── (44 L-8) 호버 동기 ──────────────────────────────────────────────────
    await seed(LEAF);
    await sleep(250);
    await cdp.eval(`window.__gpvShell.pointerSeq([['down',190,190],['up',190,190]])`);
    await sleep(150);
    await S(`hover(20, 20)`);
    await sleep(200);
    const hov = await cdp.eval(`({
      id: window.__gpvShell.ui().hoverId,
      cls: (window.__gpvShell.rowDom().find((d) => d.id === 'la') || {}).cls,
    })`);
    await S(`hover(190, 190)`);
    await sleep(200);
    const hovOff = await S(`ui().hoverId`);
    r.check(
      "(44 L-8) 캔버스 호버가 그 행을 밝힌다 — 값이 바뀔 때만 흐르고 빈 곳에서는 null 이다",
      hov.id === "la" && /bg-raised/.test(hov.cls || "") && hovOff === null,
      // `cls` 를 함께 찍는다 — 통과한 두 값만 보이면 실제로 깨진 조건이 무엇인지 알 수 없다
      // (행이 필터에 걸려 DOM 에 아예 없으면 `cls` 가 undefined 로 온다).
      `hover=${J(hov.id)} off=${J(hovOff)} cls=${J(hov.cls)}`,
    );

    // ── (44 L-9) 인스턴스 ───────────────────────────────────────────────────
    await seed([
      { id: "inst", kind: "instance", parentId: null, componentId: "cmp-1" },
      { id: "inst/c1", kind: "rect", parentId: "inst", stroke: "#FF3B30", strokeWidth: 0,
        opacity: 1, rot: 0, x: 10, y: 10, w: 20, h: 20, fill: "#FF3B30" },
      { id: "inst/c2", kind: "rect", parentId: "inst", stroke: "#FF3B30", strokeWidth: 0,
        opacity: 1, rot: 0, x: 40, y: 10, w: 20, h: 20, fill: "#FF3B30" },
    ]);
    await sleep(250);
    const instRows = await cdp.eval(`({
      rows: window.__gpvShell.ed().layers().rows,
      dom: window.__gpvShell.rowDom(),
    })`);
    r.check(
      "(44 L-9) 인스턴스는 자식이 물질화돼 있어도 펼치지 않는다 — 행 하나 + `인스턴스` 뱃지",
      instRows.rows?.length === 2 &&
        instRows.rows[0].id === "inst" &&
        // 인스턴스는 **컨테이너**라 정규화가 기본 blend 를 pass-through 로 채운다(37 §3.2) —
        // 그룹(L-2a)과 똑같이 `패스스루` 뱃지가 먼저 붙는다. 여기서 볼 것은 인스턴스 뱃지가
        // 있다는 것이지만, 개수·순서까지 못박아 둔다(51 이 붙일 state 는 문자열을 안 바꾼다).
        J(instRows.rows[0].badges) === J(["패스스루", "instance"]) &&
        !instRows.dom.some((d) => d.id === "inst/c1") &&
        /인스턴스/.test(instRows.dom?.[0]?.text || ""),
      `rows=${J(instRows.rows?.map((x) => x.id))} badges=${J(instRows.rows?.[0]?.badges)}`,
    );

    // ── (44 H) 히스토리 탭 ──────────────────────────────────────────────────
    await closeEditor();
    await sleep(250);
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    if (!r.check("(44 H-0) 히스토리 검증용 재오픈", (await openEditor()) === true)) return;
    await S(`leftTab('히스토리')`);
    await sleep(200);

    await seed([rect("h1", 10, 10, 20, 20)]);
    await seed([rect("h1", 40, 10, 20, 20)]);
    await seed([rect("h1", 40, 10, 20, 20), rect("h2", 80, 10, 20, 20)]);
    await sleep(300);
    const hist1 = await cdp.eval(`({
      rows: window.__gpvShell.histRows(),
      entries: window.__gpvShell.ed().history.entries().map((e) => e.label),
      cursor: window.__gpvShell.ed().history.cursor(),
    })`);
    r.check(
      "(44 H-1) 히스토리 탭은 41 의 항목을 그대로 보여 준다 — 커밋 3회 + `이미지 열기`, 최신이 위, `현재` 는 0번 행",
      hist1.rows?.length === 4 &&
        hist1.rows[0].cur === true &&
        hist1.cursor === 0 &&
        hist1.entries?.[3] === "이미지 열기",
      `rows=${J(hist1.rows?.map((x) => x.text))} cursor=${hist1.cursor}`,
    );

    await S(`clickHistRow(1)`);
    await sleep(300);
    const jumped = await cdp.eval(`({
      cursor: window.__gpvShell.ed().history.cursor(),
      ids: window.__gpvShell.ids(),
      rows: window.__gpvShell.histRows(),
    })`);
    r.check(
      "(44 H-2a) 행 클릭 = `jumpTo` — 커서가 그 행으로 가고 문서가 그 시점으로 돌아간다",
      jumped.cursor === 1 && J(jumped.ids) === J(["h1"]) && jumped.rows?.[0]?.dim === true,
      `cursor=${jumped.cursor} ids=${J(jumped.ids)} 흐림=${J(
        jumped.rows?.map((x) => x.dim),
      )}`,
    );
    await seed([rect("h3", 120, 10, 20, 20)]);
    await sleep(300);
    const branched = await cdp.eval(`({
      rows: window.__gpvShell.histRows(),
      cursor: window.__gpvShell.ed().history.cursor(),
    })`);
    r.check(
      "(44 H-2b) 새 커밋은 되돌려 둔 미래를 버린다 — 흐린 행이 남지 않는다",
      branched.cursor === 0 && !branched.rows?.some((x) => x.dim),
      `cursor=${branched.cursor} rows=${J(branched.rows?.map((x) => [x.text, x.dim]))}`,
    );

    // ── (44 H-3) 스냅샷 ─────────────────────────────────────────────────────
    await S(`histBtn('스냅샷 저장')`);
    await sleep(200);
    const snapPrompt = await cdp.eval(`(() => {
      const st = window.__gpv.ui.getState();
      const req = st.prompt;
      if (!req) return false;
      st.closePrompt();
      req.onConfirm('1차 검토본');
      return true;
    })()`);
    await sleep(600);
    await S(`histBtn('스냅샷')`);
    await sleep(300);
    const snapRows = await S(`histRows()`);
    await seed([]);
    await sleep(250);
    await S(`clickHistRow(0)`);
    await sleep(600);
    const restoredSnap = await cdp.eval(`({
      ids: window.__gpvShell.ids(),
      label: window.__gpvShell.ed().history.entries()[0].label,
    })`);
    await S(`histBtn('전체')`);
    await sleep(200);
    r.check(
      "(44 H-3) `스냅샷 저장` → 칩에 그 이름이 뜨고, 지운 뒤 눌러도 그 시점이 돌아온다(라벨 `스냅샷 복원`)",
      snapPrompt === true &&
        snapRows?.length === 1 &&
        /1차 검토본/.test(snapRows[0].text || "") &&
        restoredSnap.ids?.length > 0 &&
        restoredSnap.label === "스냅샷 복원",
      `rows=${J(snapRows?.map((x) => x.text))} 복원=${J(restoredSnap)}`,
    );

    // ── (44 H-4) 이전 세션 기록 · 그룹 · 되돌리기 ───────────────────────────
    //
    // readonly 항목과 '25분 전' 을 한 번에 만드는 경로는 사이드카뿐이다 — 41 은 문서와
    // **라벨 로그**만 영속하고, 그 로그가 다음 세션의 읽기 전용 항목이 된다.
    await cdp.eval(`window.__gpvShell.ed().history.flush()`);
    await sleep(400);
    // 편집기를 **먼저** 닫는다 — 열린 채로 조작하면 언마운트의 마지막 저장이 내 로그를 덮는다.
    await closeEditor();
    await sleep(400);
    const sidecar = await cdp.try("image_doc_read", {
      projectId: fix.projectId,
      relPath: SRC,
      kind: "doc",
    });
    let forged = false;
    if (sidecar.ok && typeof sidecar.r?.json === "string") {
      const env = JSON.parse(sidecar.r.json);
      const t = Date.now() - 25 * 60 * 1000;
      env.log = [
        { at: t, label: "이전 세션 작업" },
        { at: t + 30_000, label: "이전 세션 작업 2" },
      ];
      const w = await cdp.try("image_doc_write", {
        projectId: fix.projectId,
        relPath: SRC,
        kind: "doc",
        json: JSON.stringify(env),
      });
      forged = w.ok === true;
    }
    if (!forged || !(await openEditor())) {
      r.skip("(44 H-4) 이전 세션 기록", `사이드카 로그를 만들 수 없다 — forged=${forged}`);
    } else {
      await S(`leftTab('히스토리')`);
      await sleep(300);
      const priorHist = await cdp.eval(`({
        rows: window.__gpvShell.histRows(),
        groups: window.__gpvShell.histGroups(),
        cursor: window.__gpvShell.ed().history.cursor(),
      })`);
      const roIdx = (priorHist.rows || []).findIndex((x) => x.readonly);
      r.check(
        "(44 H-4a) 이전 세션 기록은 읽기 전용으로 남고, 10분 넘게 벌어진 항목은 **다른 그룹**이 된다",
        priorHist.groups?.length === 2 &&
          (priorHist.rows || []).filter((x) => x.readonly).length === 2 &&
          (priorHist.groups || []).every((g) => /^(오늘|어제) · \d{2}:\d{2}$/.test(g)),
        `groups=${J(priorHist.groups)} rows=${J(priorHist.rows?.map((x) => [x.text, x.readonly]))}`,
      );
      if (roIdx >= 0) await S(`clickHistRow(${roIdx})`);
      await sleep(250);
      const afterRo = await cdp.eval(`window.__gpvShell.ed().history.cursor()`);
      r.check(
        "(44 H-4b) 읽기 전용 항목은 눌러도 점프하지 않는다 — 문서가 없어 되돌릴 수 없다",
        roIdx >= 0 && afterRo === priorHist.cursor,
        `cursor ${priorHist.cursor} → ${afterRo} (readonly 행 #${roIdx})`,
      );
      await seed([rect("u1", 10, 10, 20, 20)]);
      await sleep(250);
      const cur0 = await cdp.eval(`window.__gpvShell.ed().history.cursor()`);
      await S(`histBtn('되돌리기')`);
      await sleep(300);
      const cur1 = await cdp.eval(`window.__gpvShell.ed().history.cursor()`);
      r.check(
        "(44 H-4c) 푸터 `되돌리기` 는 Ctrl+Z 와 **같은 핸들러**다(커서가 목록에서 한 칸 내려간다)",
        cur1 === cur0 + 1,
        `cursor ${cur0} → ${cur1}`,
      );
    }
    // ══ 태스크 45 — 컨텍스트 바 · 인스펙터 4탭 · 필드 · 팝오버 ══════════════
    //
    // 이 절이 지키는 것 셋:
    //   ① **세 상태를 뭉개지 않는다.** 값 하나 / 여러 값(MIXED) / 그 속성이 없음 은 각각
    //      숫자 · 빈 칸+`혼합` · **필드 자체가 없음** 이다. 뭉치는 순간 사용자는 "0"과
    //      "값 없음"과 "여러 값"을 같은 빈 칸으로 보고, 그 칸을 건드리는 것만으로 선택
    //      전체를 자기가 모르던 값으로 덮는다. 그래서 MIXED 의 스크럽·방향키는 절대값이
    //      아니라 **노드별 Δ** 여야 한다(4/8 에 ↑ 한 번이 둘 다 5 로 만들면 안 된다).
    //   ② **버튼과 단축키는 같은 함수다.** 정렬·간격 정리를 두 경로로 돌려 문서를 통째로
    //      비교한다 — 갈라지면 히스토리 라벨부터 어긋나고, 그다음엔 한쪽만 정규화를 탄다.
    //   ③ **라이브 한 번 = 히스토리 한 칸.** 스크럽·슬라이더는 손을 **떼기 전에도** 재야
    //      한다. 떼고 나서만 보면 중간에 수십 칸이 쌓였다 마지막 하나만 남은 경우와
    //      구분되지 않는다(41 상한 200 이 몇 초에 소진된다).
    await closeEditor();
    await sleep(250);
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    if (!r.check("(45 ins-0) 인스펙터 검증용 재오픈", (await openEditor()) === true)) return;
    await S(`leftTab('레이어')`);
    await sleep(150);

    /** 페인트 스택을 **명시**한 rect — v1 리터럴(`fill`)은 경계가 단색 한 겹으로 채운다. */
    const paintRect = (id, x, y, w, h, fills) => ({
      id, kind: "rect", parentId: null, stroke: "#FF3B30", strokeWidth: 0,
      opacity: 1, rot: 0, x, y, w, h, radius: 0, fills, strokes: [],
    });
    const solid = (color) => ({
      type: "solid", color, opacity: 1, visible: true, blend: "normal",
    });
    const ellipse = (id, x, y) => ({
      id, kind: "ellipse", parentId: null, stroke: "#FF3B30", strokeWidth: 0,
      opacity: 1, rot: 0, x, y, w: 40, h: 40, fill: "#FF3B30",
    });
    const TEXT_NODE = {
      id: "vt", kind: "text", parentId: null, stroke: "#111111", strokeWidth: 0,
      opacity: 1, rot: 0, x: 10, y: 60, w: 80, h: 18, text: "e2e", fontSize: 14,
    };
    /**
     * 빈 곳 클릭 = 선택 해제. Esc 를 쓰면 안 된다 — 선택이 이미 비어 있을 때 Esc 는 계층을
     * 끝까지 내려가 **편집기를 닫는다**(그 뒤 단언이 전부 무의미해진다).
     */
    const clearSel = async () => {
      await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
      await S(`pointerSeq([['down',196,196],['up',196,196]])`);
      await sleep(150);
    };
    /**
     * 전체 선택 — **루트 포커스가 먼저다**. 앞 케이스가 필드에 포커스를 남겨 두면
     * `useEditorKeys` 게이트 ④(입력 요소면 통과)가 Ctrl+A 를 그 입력의 전체 선택으로
     * 흘려보낸다 — 아무것도 안 고른 채로 뒤따르는 단언이 전부 무너진다.
     */
    const selectAllRoot = async () => {
      await S(`focusRoot()`);
      await selectAll();
      await sleep(150);
    };

    // ── (45 ins-1) 컨텍스트 바 7변형 · 자동 탭 ───────────────────────────────
    const V1 = rect("v1", 40, 40, 60, 60);
    const V2 = rect("v2", 150, 100, 40, 30);
    const V3 = rect("v3", 20, 150, 30, 30);
    const variant = async (objects, pick) => {
      await seed(objects);
      await sleep(150);
      if (pick === "all") await selectAllRoot();
      else if (pick === "base") await S(`clickRow('__base')`);
      else await clearSel();
      await sleep(250);
      return cdp.eval(`(() => {
        const S = window.__gpvShell;
        const t = S.barTitles();
        return {
          kind: S.ed().classify(),
          tab: S.tab(),
          titles: t,
          text: S.barText(),
          align: t.filter((x) => /정렬 \\(/.test(x)).length,
          dist: t.filter((x) => /균등 분배/.test(x)).length,
          zoom: !!S.input('줌', S.bar()),
          radius: !!S.input('반경', S.bar()),
          opacity: !!S.input('불투명도', S.bar()),
        };
      })()`);
    };

    const vNone = await variant([V1], "none");
    r.check(
      "(45 ins-1a) 아무것도 안 고르면 바는 **캔버스 것**이다 — 줌·맞춤·보기 토글뿐이고 정렬은 없다",
      vNone.kind === "none" &&
        vNone.zoom === true &&
        /캔버스/.test(vNone.text) &&
        vNone.titles.some((t) => /맞춤/.test(t)) &&
        vNone.align === 0,
      `kind=${vNone.kind} titles=${J(vNone.titles)}`,
    );
    const vOne = await variant([V1], "all");
    r.check(
      "(45 ins-1b) 도형 하나면 그 도형의 값이 바에 온다(채우기·선 칩 · 반경 · 불투명도) — 개수 문구는 없다",
      vOne.kind === "single-shape" &&
        vOne.tab === "props" &&
        vOne.titles.some((t) => /^채우기/.test(t)) &&
        vOne.titles.some((t) => /^선/.test(t)) &&
        vOne.radius === true &&
        vOne.opacity === true &&
        !/개 선택/.test(vOne.text),
      `kind=${vOne.kind} tab=${vOne.tab} titles=${J(vOne.titles)}`,
    );
    const vTwo = await variant([V1, V2], "all");
    const vThree = await variant([V1, V2, V3], "all");
    r.check(
      "(45 ins-1c) 여럿이면 정렬 6 이 뜨고, **분배는 3개부터** 나타난다(둘은 놓을 자리가 없어 눌러도 아무 일이 없다)",
      vTwo.kind === "multi" &&
        vTwo.align === 6 &&
        vTwo.dist === 0 &&
        /2개 선택/.test(vTwo.text) &&
        vThree.align === 6 &&
        vThree.dist === 2,
      `2개: align=${vTwo.align} dist=${vTwo.dist} / 3개: align=${vThree.align} dist=${vThree.dist}`,
    );
    r.check(
      "(45 ins-1d) 아직 주인이 없는 기능은 **버튼이 없다** — 불리언(46)이 오기 전에는 회색 버튼조차 그리지 않는다(눌러 보고 나서야 아무 일도 안 난다는 것을 알면 앱이 고장 난 것으로 읽힌다)",
      !vThree.titles.some((t) => /합집합|빼기|교집합|배타/.test(t)),
      J(vThree.titles),
    );
    const vBase = await variant([V1], "base");
    r.check(
      "(45 ins-1e) 배경을 고르면 이미지 변형이다 — `배경 이미지` · 원본 크기 · 조정 탭 자동 전환",
      vBase.kind === "image" &&
        vBase.tab === "adjust" &&
        /배경 이미지/.test(vBase.text) &&
        /원본 크기 200 × 200/.test(vBase.text),
      `kind=${vBase.kind} tab=${vBase.tab} text=${J(vBase.text.slice(0, 40))}`,
    );

    await seed([TEXT_NODE]);
    await selectAllRoot();
    await sleep(250);
    const autoText = await cdp.eval(
      `({ kind: window.__gpvShell.ed().classify(), tab: window.__gpvShell.tab() })`,
    );
    await S(`clickTab('속성')`);
    await sleep(150);
    const manual = await S(`tab()`);
    const aria = await S(`tabAria()`);
    await selectAllRoot();
    await sleep(250);
    const kept = await S(`tab()`);
    await S(`clickRow('__base')`);
    await sleep(250);
    const again = await S(`tab()`);
    r.check(
      "(45 ins-1f) 탭 자동 전환은 **선택 종류가 바뀔 때 한 번**이다 — 그 안에서 사용자가 고른 탭은 남고, 종류가 바뀌면 다시 산다",
      autoText.kind === "text" &&
        autoText.tab === "text" &&
        manual === "props" &&
        kept === "props" &&
        again === "adjust",
      `text=${autoText.tab} 수동=${manual} 유지=${kept} 종류변경=${again}`,
    );
    r.check(
      "(45 ins-1g) 탭 넷이 `role=tab` 이고 `aria-selected` 는 **하나만** 참이다(스크린리더가 지금 보이는 탭을 읽는 유일한 근거다)",
      Array.isArray(aria) &&
        J(aria.map((t) => t.label)) === J(["속성", "텍스트", "조정", "내보내기"]) &&
        aria.filter((t) => t.sel).length === 1 &&
        aria[0].sel === true,
      J(aria),
    );

    // 모드 전환은 `setMode` 로 한다 — Esc 로 나오면 계층 5(선택 해제)가 먼저 걸려 모드가
    // 그대로 남는다(Esc 계층 자체는 42 의 (e-3)(e-4) 가 이미 잰다).
    await seed([V1]);
    await selectAllRoot();
    await cdp.eval(`window.__gpvShell.ed().setMode({ kind:'nodeEdit', id:'v1' })`);
    await sleep(250);
    const inNode = await cdp.eval(
      `({ kind: window.__gpvShell.ed().classify(), text: window.__gpvShell.barText() })`,
    );
    await cdp.eval(`window.__gpvShell.ed().setMode({ kind:'crop' })`);
    await sleep(250);
    const inCrop = await cdp.eval(`({
      kind: window.__gpvShell.ed().classify(),
      text: window.__gpvShell.barText(),
      tab: window.__gpvShell.tab(),
    })`);
    await cdp.eval(`window.__gpvShell.ed().setMode({ kind:'design' })`);
    await sleep(250);
    const backDesign = await cdp.eval(
      `({ kind: window.__gpvShell.ed().classify(), crop: window.__gpvShell.doc().crop })`,
    );
    r.check(
      "(45 ins-1h) **모드가 선택을 이긴다** — 크롭·노드 편집 중에는 무엇이 골라져 있든 그 모드의 바가 뜬다(선택을 먼저 보면 크롭 중에 다른 객체를 스치는 것만으로 취소·적용 버튼이 사라진다)",
      inNode.kind === "vector-edit" &&
        inCrop.kind === "crop" &&
        /크롭/.test(inCrop.text) &&
        inCrop.tab === "adjust" &&
        backDesign.kind === "single-shape" &&
        backDesign.crop === null,
      `node=${J(inNode)} crop=${J(inCrop)} 복귀=${J(backDesign)}`,
    );

    // ── (45 ins-2) 정렬 · 분배 · 간격 정리 ───────────────────────────────────
    const AL = [rect("a1", 40, 40, 60, 60), rect("a2", 150, 100, 80, 30)];
    await seed(AL);
    await selectAllRoot();
    await sleep(200);
    const h2 = await S(`hist()`);
    await cdp.eval(`window.__gpvShell.ed().actions.align('left')`);
    await sleep(250);
    const aligned = await cdp.eval(`({
      xs: window.__gpvShell.doc().objects.map((o) => o.x),
      label: window.__gpvShell.lastLabel(),
      hist: window.__gpvShell.hist(),
    })`);
    await cdp.eval(`window.__gpvShell.fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
    await sleep(250);
    const undone = await cdp.eval(`window.__gpvShell.doc().objects.map((o) => o.x)`);
    r.check(
      "(45 ins-2a) 왼쪽 정렬은 **마지막 선택**에 맞춘다 — 기준 자신은 안 움직이고, 한 칸이며, Ctrl+Z 로 되돌아온다",
      J(aligned.xs) === J([150, 150]) &&
        aligned.label === "정렬 왼쪽" &&
        aligned.hist === h2 + 1 &&
        J(undone) === J([40, 150]),
      `xs=${J(aligned.xs)} label=${aligned.label} hist=${h2}→${aligned.hist} undo=${J(undone)}`,
    );

    // 같은 조작을 키와 버튼으로 각각 돌려 **문서를 통째로** 비교한다. 한쪽만 액션 맵을
    // 지나가면(예: 바가 patchDoc 을 직접 부르면) 좌표는 같아도 라벨이 갈린다.
    const alignBy = async (how) => {
      await seed(AL);
      await selectAllRoot();
      await sleep(200);
      if (how === "key") {
        await cdp.eval(`window.__gpvShell.fire({ key:'a', code:'KeyA', altKey:true })`);
      } else {
        await S(`clickBar(/왼쪽 정렬/)`);
      }
      await sleep(250);
      return cdp.eval(`({
        geom: window.__gpvShell.doc().objects.map((o) => [o.id, o.x, o.y]),
        label: window.__gpvShell.lastLabel(),
      })`);
    };
    const alignKey = await alignBy("key");
    const alignBtn = await alignBy("btn");
    r.check(
      "(45 ins-2b) 정렬은 **버튼과 단축키가 같은 함수**다 — 좌표도 히스토리 라벨도 같다",
      J(alignKey.geom) === J(alignBtn.geom) &&
        alignKey.label === alignBtn.label &&
        alignKey.label === "정렬 왼쪽",
      `key=${J(alignKey)} btn=${J(alignBtn)}`,
    );

    await seed([
      rect("d1", 10, 40, 30, 30),
      rect("d2", 70, 40, 30, 30),
      rect("d3", 150, 40, 30, 30),
    ]);
    await selectAllRoot();
    await sleep(200);
    await cdp.eval(`window.__gpvShell.ed().actions.distribute('x')`);
    await sleep(250);
    const dist = await cdp.eval(`(() => {
      const c = window.__gpvShell.doc().objects.map((o) => o.x + o.w / 2).sort((a, b) => a - b);
      return { c: c, gaps: c.slice(1).map((v, i) => v - c[i]), label: window.__gpvShell.lastLabel() };
    })()`);
    r.check(
      "(45 ins-2c) 수평 분배는 양 끝을 두고 가운데 중심을 등간격에 놓는다(±0.5)",
      dist.gaps.length === 2 &&
        Math.abs(dist.gaps[0] - dist.gaps[1]) <= 0.5 &&
        dist.label === "수평 분배",
      `centers=${J(dist.c)} gaps=${J(dist.gaps)} label=${dist.label}`,
    );

    const TIDY = [
      rect("t1", 10, 40, 30, 30),
      rect("t2", 60, 40, 30, 30),
      rect("t3", 150, 40, 30, 30),
    ];
    await seed(TIDY);
    await selectAllRoot();
    await sleep(200);
    await cdp.eval(`window.__gpvShell.ed().actions.tidy(24)`);
    await sleep(250);
    const tidied = await cdp.eval(`(() => {
      const os = window.__gpvShell.doc().objects.slice().sort((a, b) => a.x - b.x);
      return {
        first: os[0].x,
        gaps: os.slice(1).map((o, i) => o.x - (os[i].x + os[i].w)),
        label: window.__gpvShell.lastLabel(),
      };
    })()`);
    r.check(
      "(45 ins-2d) `간격 정리 24` 는 첫 항목을 제자리에 두고 인접 간격을 전부 24 로 만든다",
      J(tidied.gaps) === J([24, 24]) &&
        tidied.first === 10 &&
        tidied.label === "간격 정리 24",
      `first=${tidied.first} gaps=${J(tidied.gaps)} label=${tidied.label}`,
    );

    const tidyBy = async (how) => {
      await seed(TIDY);
      await selectAllRoot();
      await sleep(200);
      if (how === "key") {
        await cdp.eval(
          `window.__gpvShell.fire({ key:'K', code:'KeyK', ctrlKey:true, altKey:true, shiftKey:true })`,
        );
      } else {
        await S(`clickBar(/간격 정리/)`);
      }
      await sleep(250);
      return cdp.eval(`({
        geom: window.__gpvShell.doc().objects.map((o) => [o.id, o.x]),
        label: window.__gpvShell.lastLabel(),
      })`);
    };
    const tidyKey = await tidyBy("key");
    const tidyBtn = await tidyBy("btn");
    r.check(
      "(45 ins-2e) 간격 정리도 키(Ctrl+Alt+Shift+K)와 버튼이 같은 결과다 — 둘 다 `ui.tidyGap` 을 읽는다",
      J(tidyKey.geom) === J(tidyBtn.geom) &&
        tidyKey.label === tidyBtn.label &&
        J(tidyKey.geom) !== J(TIDY.map((o) => [o.id, o.x])),
      `key=${J(tidyKey)} btn=${J(tidyBtn)}`,
    );

    // ── (45 ins-3) MIXED 세 상태 ─────────────────────────────────────────────
    const MIX = [
      { ...rect("m1", 10, 10, 40, 40), radius: 4 },
      { ...rect("m2", 100, 10, 40, 40), radius: 8 },
    ];
    await seed(MIX);
    await selectAllRoot();
    await S(`clickTab('속성')`);
    await sleep(250);
    const mixField = await S(`fieldState('반경')`);
    r.check(
      "(45 ins-3a) 값이 갈리면 **빈 칸 + `혼합`** 이다 — 한쪽 값을 대표로 보여 주면 그 칸을 누르는 순간 다른 쪽이 조용히 덮인다",
      !!mixField && mixField.value === "" && mixField.placeholder === "혼합",
      J(mixField),
    );
    const h3 = await S(`hist()`);
    await S(`typeField('반경', '12')`);
    await sleep(300);
    const typed = await cdp.eval(`({
      radii: window.__gpvShell.doc().objects.map((o) => o.radius),
      hist: window.__gpvShell.hist(),
    })`);
    r.check(
      "(45 ins-3b) 숫자를 **직접 적는 것**만 절대값이다 — 선택 전체가 그 값이 되고 히스토리는 한 칸",
      J(typed.radii) === J([[12, 12, 12, 12], [12, 12, 12, 12]]) && typed.hist === h3 + 1,
      `radii=${J(typed.radii)} hist=${h3}→${typed.hist}`,
    );

    await seed(MIX);
    await selectAllRoot();
    await sleep(250);
    const h3b = await S(`hist()`);
    const scrubbed = await cdp.eval(`window.__gpvShell.scrub('반경', 5)`);
    await sleep(250);
    const scrubRadii = await cdp.eval(
      `window.__gpvShell.doc().objects.map((o) => o.radius[0])`,
    );
    r.check(
      "(45 ins-3c) 스크럽은 **상대 델타**다 — 4/8 이 9/13 이 되어 차이가 살아남고, 드래그 전체가 한 칸이다",
      J(scrubRadii) === J([9, 13]) &&
        scrubbed.ok === true &&
        scrubbed.mid === h3b + 1 &&
        scrubbed.end === h3b + 1,
      `radius=${J(scrubRadii)} hist=${h3b}→${scrubbed.mid}→${scrubbed.end}`,
    );

    await seed([ellipse("e1", 10, 10), ellipse("e2", 100, 10)]);
    await selectAllRoot();
    await sleep(300);
    const noRadius = await cdp.eval(`({
      radius: !!window.__gpvShell.input('반경'),
      opacity: !!window.__gpvShell.input('불투명도'),
      names: Object.keys(window.__gpvShell.ed().inspector.fields()),
    })`);
    r.check(
      "(45 ins-3d) 어느 노드에도 없는 속성은 **칸 자체가 없다** — 타원에 반경 칸을 그리면 거기 적은 값이 아무 데도 가지 않는다",
      noRadius.radius === false && noRadius.opacity === true,
      J(noRadius),
    );

    // ── (45 ins-4) 위치 · 크기 필드 ──────────────────────────────────────────
    await seed([rect("f1", 30, 30, 50, 40)]);
    await selectAllRoot();
    await sleep(250);
    const h4 = await S(`hist()`);
    await S(`typeField('X', '100')`);
    await sleep(300);
    const movedX = await cdp.eval(`({
      x: window.__gpvShell.doc().objects[0].x,
      y: window.__gpvShell.doc().objects[0].y,
      hist: window.__gpvShell.hist(),
      label: window.__gpvShell.lastLabel(),
    })`);
    r.check(
      "(45 ins-4a) X 필드는 `setObjectFrame` 을 탄다 — 적은 값 그대로 들어가고 다른 축은 건드리지 않는다",
      movedX.x === 100 && movedX.y === 30 && movedX.hist === h4 + 1 && movedX.label === "X 100",
      J(movedX),
    );
    const w0 = await S(`doc().objects[0].w`);
    const h4b = await S(`hist()`);
    await S(`keyField('W', { key:'ArrowUp', code:'ArrowUp', shiftKey:true })`);
    await sleep(300);
    const w1 = await cdp.eval(
      `({ w: window.__gpvShell.doc().objects[0].w, hist: window.__gpvShell.hist() })`,
    );
    await S(`keyField('W', { key:'ArrowUp', code:'ArrowUp', shiftKey:true, repeat:true })`);
    await sleep(300);
    const w2 = await cdp.eval(
      `({ w: window.__gpvShell.doc().objects[0].w, hist: window.__gpvShell.hist() })`,
    );
    r.check(
      "(45 ins-4b) Shift+↑ 는 10 을 더하고 **한 번 = 한 칸**이며 auto-repeat 는 버린다(누르고 있으면 초당 수십 칸이 쌓여 앞 작업이 히스토리 밖으로 밀린다)",
      w1.w === w0 + 10 && w1.hist === h4b + 1 && w2.w === w1.w && w2.hist === w1.hist,
      `w ${w0}→${w1.w}→${w2.w} hist ${h4b}→${w1.hist}→${w2.hist}`,
    );

    // ── (45 ins-5) 채우기 스택 — 겹 추가 · 눈 · 제거 ─────────────────────────
    //
    // 픽스처가 두 겹인 이유: `+` 가 만드는 겹의 색은 **최근 사용 색**에 달려 있어 고정값이
    // 아니다. 위에 덮이는 흰 겹을 미리 깔아 두면 눈을 껐을 때 나와야 할 픽셀이 정해진다.
    const BLUE = [10, 132, 255];
    await seed([paintRect("p1", 40, 40, 60, 60, [solid("#0A84FF"), solid("#FFFFFF")])]);
    await selectAllRoot();
    await sleep(300);
    const rows0 = await S(`stackRows('채우기').length`);
    await S(`stackAdd('채우기')`);
    await sleep(300);
    const addedN = await S(`doc().objects[0].fills.length`);
    await S(`stackBtn('채우기', 2, '제거')`);
    await sleep(300);
    const removedN = await S(`doc().objects[0].fills.length`);
    r.check(
      "(45 ins-5a) 스택 행 수 == 문서 겹 수이고 `+`/`−` 가 그대로 반영된다",
      rows0 === 2 && addedN === 3 && removedN === 2,
      `rows=${rows0} +=${addedN} −=${removedN}`,
    );
    await S(`stackBtn('채우기', 1, '숨기기')`);
    await sleep(400);
    const hiddenFill = await cdp.eval(`({
      visible: window.__gpvShell.doc().objects[0].fills[1].visible,
      preview: window.__gpvShell.px(1, 70, 70),
      render: window.__gpvShell.renderPx(70, 70),
      label: window.__gpvShell.lastLabel(),
    })`);
    const near3 = (a, b) =>
      Array.isArray(a) && Array.isArray(b) && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= 2);
    r.check(
      "(45 ins-5b) 겹의 눈을 끄면 화면에서도 **렌더 경로에서도** 사라진다 — 프리뷰와 내보내기 픽셀이 같아야 '화면 == 파일' 이다",
      hiddenFill.visible === false &&
        near3(hiddenFill.preview, BLUE) &&
        near3(hiddenFill.preview, hiddenFill.render) &&
        hiddenFill.label === "채우기 숨기기",
      `preview=${J(hiddenFill.preview)} render=${J(hiddenFill.render)} label=${hiddenFill.label}`,
    );

    // ── (45 ins-6) 반전 · 회전 ───────────────────────────────────────────────
    await seed([rect("x1", 20, 20, 40, 30), rect("x2", 120, 60, 30, 50)]);
    await selectAllRoot();
    await sleep(250);
    const geomKey = `window.__gpvShell.doc().objects.map((o) => [o.id, o.x, o.y, o.w, o.h])`;
    const geo0 = await cdp.eval(geomKey);
    await cdp.eval(`window.__gpvShell.ed().actions.flip('h')`);
    await sleep(250);
    const geo1 = await cdp.eval(geomKey);
    await cdp.eval(`window.__gpvShell.ed().actions.flip('h')`);
    await sleep(250);
    const geo2 = await cdp.eval(geomKey);
    r.check(
      "(45 ins-6a) 좌우 반전은 **선택 AABB 안에서** 뒤집는다 — 한 번은 자리가 바뀌고 두 번은 정확히 제자리다",
      J(geo1) !== J(geo0) && J(geo2) === J(geo0),
      `0=${J(geo0)} 1=${J(geo1)} 2=${J(geo2)}`,
    );
    await seed([rect("x1", 20, 20, 40, 30)]);
    await selectAllRoot();
    await sleep(200);
    await cdp.eval(`window.__gpvShell.ed().actions.rotate(90)`);
    await sleep(250);
    const rotated = await cdp.eval(
      `({ rot: window.__gpvShell.doc().objects[0].rot, label: window.__gpvShell.lastLabel() })`,
    );
    r.check(
      "(45 ins-6b) 선택 회전은 선택 상자 중심을 축으로 돈다(`rot` 90 · 라벨 `90° 회전`)",
      rotated.rot === 90 && rotated.label === "90° 회전",
      J(rotated),
    );

    // ── (45 ins-7) 색 피커 ───────────────────────────────────────────────────
    await seed([paintRect("c1", 40, 40, 60, 60, [solid("#FF3B30")])]);
    await selectAllRoot();
    await sleep(300);
    await S(`stackOpen('채우기', 0)`);
    await sleep(300);
    const popOpen = await cdp.eval(`({
      n: window.__gpvShell.popN(),
      title: window.__gpvShell.popTitle(),
      fits: window.__gpvShell.popFits(),
      slot: window.__gpvShell.ed().popover.open(),
      hex: (window.__gpvShell.fieldState('HEX', window.__gpvShell.popTop()) || {}).value,
    })`);
    r.check(
      "(45 ins-7a) 스와치가 색 피커를 연다 — 인스펙터 오른쪽 끝에서 열어도 화면 안이고, hex 왕복에 오차가 없다",
      popOpen.n === 1 &&
        popOpen.fits === true &&
        popOpen.slot === "paint:fills:0" &&
        /채우기 · 단색/.test(popOpen.title || "") &&
        String(popOpen.hex).toUpperCase() === "#FF3B30",
      J(popOpen),
    );
    const h7 = await S(`hist()`);
    await cdp.eval(
      `window.__gpvShell.typeField('HEX', '0A84FF', window.__gpvShell.popTop())`,
    );
    await sleep(300);
    const hexPut = await cdp.eval(`({
      fill: window.__gpvShell.doc().objects[0].fills[0],
      hist: window.__gpvShell.hist(),
      label: window.__gpvShell.lastLabel(),
    })`);
    r.check(
      "(45 ins-7b) hex 입력은 한 칸으로 들어간다 — 적은 문자열이 **그대로** 문서 색이 된다(HSV 왕복으로 한 칸 어긋나면 안 된다)",
      hexPut.fill.color === "#0A84FF" &&
        hexPut.hist === h7 + 1 &&
        hexPut.label === "채우기 0A84FF",
      `fill=${J(hexPut.fill)} hist=${h7}→${hexPut.hist} label=${hexPut.label}`,
    );
    await cdp.eval(
      `window.__gpvShell.typeField('불투명도', '50', window.__gpvShell.popTop())`,
    );
    await sleep(300);
    const painted = await S(`doc().objects[0].fills[0]`);
    r.check(
      "(45 ins-7c) 알파는 `Fill.opacity` 로 간다 — 색 문자열은 `#rrggbb` 그대로다(섞으면 e2e 색 상수·팔레트·정규화 전제가 통째로 깨진다)",
      painted.color === "#0A84FF" && painted.opacity === 0.5,
      J(painted),
    );
    // 라벨 div 는 **자식이 없는** 것으로 고른다 — 감싼 div 도 같은 문구를 담고 있어
    // 그것을 집으면 스와치 줄이 아니라 피커 전체를 세게 된다.
    const docSw = await cdp.eval(`(() => {
      const p = window.__gpvShell.popTop();
      if (!p) return null;
      const head = Array.from(p.querySelectorAll('div')).find(
        (d) => d.children.length === 0 && (d.textContent || '').trim() === '문서 색상',
      );
      const box = head && head.parentElement ? head.parentElement.lastElementChild : null;
      return {
        shown: box ? box.querySelectorAll('button').length : -1,
        colors: window.__gpvShell.ed().schema.documentColors(window.__gpvShell.doc()).length,
      };
    })()`);
    r.check(
      "(45 ins-7d) `문서 색상` 칸은 문서에 실제로 쓰인 색이다(한 줄 8칸까지)",
      !!docSw && docSw.shown > 0 && docSw.shown === Math.min(8, docSw.colors),
      J(docSw),
    );
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(250);
    const escPop = await cdp.eval(`({
      n: window.__gpvShell.popN(),
      color: window.__gpvShell.doc().objects[0].fills[0].color,
      open: !window.__gpvShell.gone(),
    })`);
    r.check(
      "(45 ins-7e) Esc 는 **팝오버부터** 닫는다(계층 0) — 문서도 편집기도 그대로다",
      escPop.n === 0 && escPop.color === "#0A84FF" && escPop.open === true,
      J(escPop),
    );
    await S(`stackOpen('채우기', 0)`);
    await sleep(250);
    const outside = await cdp.eval(`(() => {
      const b = window.__gpvShell.popBackdrop();
      if (!b) return false;
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(250);
    const afterOutside = await cdp.eval(
      `({ n: window.__gpvShell.popN(), objects: window.__gpvShell.doc().objects.length })`,
    );
    r.check(
      "(45 ins-7f) 바깥 클릭이 닫는다 — 그 클릭이 캔버스로 새어 선택이 바뀌거나 도형이 그려지지 않는다",
      outside === true && afterOutside.n === 0 && afterOutside.objects === 1,
      `${J(afterOutside)}`,
    );
    // 위 (ins-7e)는 포커스를 루트로 뺀 뒤 쐈다 — 실제 기본 상태는 **hex 입력에 포커스**다
    // (Popover 가 첫 입력을 잡는다). 그 자리에서 Esc 를 쏴야 재려던 것이 재어진다.
    await S(`stackOpen('채우기', 0)`);
    await sleep(250);
    const hexFocused = await cdp.eval(`(() => {
      const p = window.__gpvShell.popTop();
      return !!p && document.activeElement === window.__gpvShell.input('HEX', p);
    })()`);
    await cdp.eval(
      `window.__gpvShell.keyField('HEX', { key:'Escape', code:'Escape' }, window.__gpvShell.popTop())`,
    );
    await sleep(250);
    const escHex = await cdp.eval(`({
      n: window.__gpvShell.popN(),
      color: window.__gpvShell.doc().objects[0].fills[0].color,
      open: !window.__gpvShell.gone(),
    })`);
    r.check(
      "(45 ins-7g) hex 입력에 포커스가 있어도 Esc 가 닫는다 — 42 캡처 리스너는 입력 안 Esc 를 통과시키므로 이 이벤트가 팝오버까지 **올라가야** 닫힌다(입력이 삼키면 X 버튼 말고는 닫을 길이 없다)",
      hexFocused === true &&
        escHex.n === 0 &&
        escHex.color === "#0A84FF" &&
        escHex.open === true,
      `focus=${hexFocused} ${J(escHex)}`,
    );

    // ── (45 ins-8) 블렌드 목록 19 ────────────────────────────────────────────
    await seed([rect("b1", 40, 40, 60, 60)]);
    await selectAllRoot();
    await sleep(250);
    await S(`clickBar(/블렌드 모드 전체/)`);
    await sleep(300);
    const menu = await cdp.eval(`(() => {
      const p = window.__gpvShell.popTop();
      const items = p ? Array.from(p.querySelectorAll('[role="menuitemradio"]')) : [];
      return {
        n: items.length,
        seps: p ? p.querySelectorAll('[role="separator"]').length : -1,
        pass: items
          .filter((b) => (b.textContent || '').trim() === '패스스루')
          .map((b) => b.disabled),
      };
    })()`);
    await cdp.eval(`window.__gpvShell.clickIn(window.__gpvShell.popTop(), /곱하기/)`);
    await sleep(300);
    const blended = await cdp.eval(`({
      blend: window.__gpvShell.doc().objects[0].blend,
      label: window.__gpvShell.lastLabel(),
      n: window.__gpvShell.popN(),
    })`);
    r.check(
      "(45 ins-8) 블렌드 19종·구분선 5 이고, 리프에서 `패스스루` 는 **남되 비활성**이다 — 빼 버리면 항목 수가 선택마다 흔들리고 컨테이너 전용이라는 사실이 화면에서 사라진다",
      menu.n === 19 &&
        menu.seps === 5 &&
        J(menu.pass) === J([true]) &&
        blended.blend === "multiply" &&
        blended.label === "블렌드 곱하기" &&
        blended.n === 0,
      `${J(menu)} → ${J(blended)}`,
    );

    // ── (45 ins-9) 팝오버가 열린 동안의 키 스코프 ────────────────────────────
    await seed([paintRect("k1", 40, 40, 60, 60, [solid("#FF3B30")]), rect("k2", 130, 40, 30, 30)]);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await S(`pointerSeq([['down',70,70],['up',70,70]])`);
    await sleep(250);
    await S(`stackOpen('채우기', 0)`);
    await sleep(300);
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.ed().setTool('rect')`);
    const delFire = await cdp.eval(
      `window.__gpvShell.fire({ key:'Delete', code:'Delete' })`,
    );
    await sleep(200);
    const vFire = await cdp.eval(`window.__gpvShell.fire({ key:'v', code:'KeyV' })`);
    await sleep(200);
    const guarded = await cdp.eval(`({
      objects: window.__gpvShell.doc().objects.length,
      tool: window.__gpvShell.ui().tool,
      pops: window.__gpvShell.popN(),
    })`);
    await S(`ed().popover.close()`);
    await sleep(200);
    r.check(
      "(45 ins-9) 팝오버가 열려 있으면 편집기 단축키는 **하나도** 먹지 않는다(Esc 만 예외) — 막지 않으면 색 이름을 지우려던 Delete 가 선택 객체를 지우고 V 는 글자 대신 도구를 바꾼다",
      guarded.objects === 2 &&
        guarded.tool === "rect" &&
        guarded.pops === 1 &&
        delFire.prevented === false &&
        vFire.prevented === false,
      `${J(guarded)} delete=${J(delFire)} v=${J(vFire)}`,
    );
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);

    // ── (45 ins-10) 아이드로퍼 ───────────────────────────────────────────────
    await seed([
      paintRect("y1", 10, 10, 40, 40, [solid("#0A84FF")]),
      rect("y2", 80, 80, 60, 60),
    ]);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await S(`pointerSeq([['down',30,30],['up',30,30]])`);
    await sleep(250);
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'i', code:'KeyI' })`);
    await sleep(250);
    const eyeOn = await S(`ui().tool`);
    await S(`pointerSeq([['down',110,110],['up',110,110]])`);
    await sleep(350);
    const picked = await cdp.eval(`({
      tool: window.__gpvShell.ui().tool,
      color: window.__gpvShell.doc().objects[0].fills[0].color,
      objects: window.__gpvShell.doc().objects.length,
      label: window.__gpvShell.lastLabel(),
    })`);
    r.check(
      "(45 ins-10a) 스포이드는 캔버스 색을 집어 선택 도형에 넣고 **원래 도구로 돌아온다** — 그 클릭이 선점되지 않으면 찍은 자리에 도형이 하나 생긴다",
      eyeOn === "eyedropper" &&
        picked.tool === "select" &&
        picked.color === "#FF3B30" &&
        picked.objects === 2 &&
        picked.label === "채우기 FF3B30",
      `on=${eyeOn} ${J(picked)}`,
    );
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'i', code:'KeyI' })`);
    await sleep(200);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(300);
    const canceledPick = await cdp.eval(`({
      tool: window.__gpvShell.ui().tool,
      color: window.__gpvShell.doc().objects[0].fills[0].color,
      open: !window.__gpvShell.gone(),
    })`);
    r.check(
      "(45 ins-10b) Esc 는 색을 쓰지 않고 도구만 되돌린다 — 등록이 남으면 그 뒤 캔버스 클릭이 계속 먹혀 '그림이 안 그려진다'가 된다",
      canceledPick.tool === "select" &&
        canceledPick.color === "#FF3B30" &&
        canceledPick.open === true,
      J(canceledPick),
    );
    await S(`pointerSeq([['down',196,196],['up',196,196]])`);
    await sleep(250);
    const afterCancel = await cdp.eval(`({
      sel: window.__gpvShell.ui().selectedIds.length,
      objects: window.__gpvShell.doc().objects.length,
    })`);
    r.check(
      "(45 ins-10c) 취소가 포인터 선점을 **해제**한다 — 빈 곳 클릭이 캔버스에 닿아 선택이 비고(선점이 남아 있으면 그 클릭이 삼켜져 선택이 그대로다) 객체 수는 변하지 않는다",
      afterCancel.sel === 0 && afterCancel.objects === 2,
      J(afterCancel),
    );

    // 색 피커의 스포이드 버튼 — `I` 와 달리 **팝오버가 열린 채** 도는 경로다. 버튼을 누르면
    // 백드롭이 걷혀야(캔버스 클릭이 통과해야) 색을 뽑을 수 있는데, 그 전환이 팝오버를 다시
    // 마운트하면 정리 함수가 방금 켠 세션을 그 자리에서 죽인다.
    await seed([
      paintRect("y3", 10, 10, 40, 40, [solid("#0A84FF")]),
      rect("y4", 80, 80, 60, 60),
    ]);
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);
    await S(`pointerSeq([['down',30,30],['up',30,30]])`);
    await sleep(250);
    await S(`stackOpen('채우기', 0)`);
    await sleep(300);
    await cdp.eval(`window.__gpvShell.clickIn(window.__gpvShell.popTop(), /스포이드/)`);
    await sleep(250);
    const popEye = await cdp.eval(
      `({ tool: window.__gpvShell.ui().tool, n: window.__gpvShell.popN() })`,
    );
    await S(`pointerSeq([['down',110,110],['up',110,110]])`);
    await sleep(350);
    const popPicked = await cdp.eval(`({
      tool: window.__gpvShell.ui().tool,
      color: window.__gpvShell.doc().objects[0].fills[0].color,
      objects: window.__gpvShell.doc().objects.length,
      n: window.__gpvShell.popN(),
    })`);
    r.check(
      "(45 ins-10d) 색 피커의 스포이드도 같은 세션이다 — 백드롭이 걷히는 동안 피커가 살아 있어야 그 클릭이 색으로 들어온다(다시 마운트되면 버튼이 아무 일도 안 한 것처럼 보인다)",
      popEye.tool === "eyedropper" &&
        popEye.n === 1 &&
        popPicked.tool === "select" &&
        popPicked.color === "#FF3B30" &&
        popPicked.objects === 2 &&
        popPicked.n === 1,
      `${J(popEye)} → ${J(popPicked)}`,
    );
    await cdp.eval(`window.__gpvShell.clickIn(window.__gpvShell.popTop(), /스포이드/)`);
    await sleep(250);
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(300);
    const popEsc = await cdp.eval(`({
      tool: window.__gpvShell.ui().tool,
      n: window.__gpvShell.popN(),
      color: window.__gpvShell.doc().objects[0].fills[0].color,
    })`);
    r.check(
      "(45 ins-10e) 팝오버를 Esc 로 닫으면 도구도 함께 돌아온다 — Esc 는 계층 0(팝오버)에서 끝나 `select` 복귀(4단계)까지 못 가므로 세션이 스스로 되돌려야 한다(안 하면 캔버스가 선택도 그리기도 안 먹는다)",
      popEsc.n === 0 && popEsc.tool === "select" && popEsc.color === "#FF3B30",
      J(popEsc),
    );
    await cdp.eval(`window.__gpvShell.ed().setTool('select')`);

    // ── (45 ins-11) 그라디언트 편집기 · 팝오버 스택 ──────────────────────────
    const GRAD = paintRect("g1", 40, 40, 100, 60, [
      {
        type: "linear", angle: 90, scale: 1, visible: true, blend: "normal",
        stops: [
          { pos: 0, color: "#3B82F6", opacity: 1 },
          { pos: 1, color: "#A855F7", opacity: 1 },
        ],
      },
    ]);
    await seed([GRAD]);
    await selectAllRoot();
    await sleep(300);
    await S(`stackOpen('채우기', 0)`);
    await sleep(350);
    const gOpen = await cdp.eval(`({
      n: window.__gpvShell.popN(),
      title: window.__gpvShell.popTitle(),
      backdrop: !!window.__gpvShell.popBackdrop(),
      extra: window.__gpvShell.chromeN('[data-chrome="extra"] *'),
    })`);
    r.check(
      "(45 ins-11a) 그라디언트 팝오버는 **백드롭이 없다**(핸들을 캔버스에서 끌어야 한다) · 핸들은 SVG 크롬에만 뜬다",
      gOpen.n === 1 &&
        /그라디언트/.test(gOpen.title || "") &&
        gOpen.backdrop === false &&
        gOpen.extra >= 1,
      J(gOpen),
    );
    await cdp.eval(`window.__gpvShell.typeField('각도', '135', window.__gpvShell.popTop())`);
    await sleep(300);
    const addStop = await cdp.eval(`(() => {
      const p = window.__gpvShell.popTop();
      const bar = p ? p.querySelector('[aria-label="스톱"]') : null;
      if (!bar) return false;
      const r = bar.getBoundingClientRect();
      bar.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          button: 0, buttons: 1, pointerId: 1601, pointerType: 'mouse', isPrimary: true,
        }),
      );
      return true;
    })()`);
    await sleep(300);
    const gEdited = await cdp.eval(`(() => {
      const f = window.__gpvShell.doc().objects[0].fills[0];
      return { type: f.type, angle: f.angle, pos: f.stops.map((s) => s.pos) };
    })()`);
    await cdp.eval(`window.__gpvShell.clickIn(window.__gpvShell.popTop(), /스톱 순서 반전/)`);
    await sleep(300);
    const shuffled = await cdp.eval(
      `window.__gpvShell.doc().objects[0].fills[0].stops.map((s) => s.pos)`,
    );
    r.check(
      "(45 ins-11b) 각도 필드·스톱 바·순서 반전이 전부 문서에 닿는다 — 핸들 없이도 그라디언트 전 기능에 도달한다",
      gEdited.type === "linear" &&
        gEdited.angle === 135 &&
        addStop === true &&
        gEdited.pos.length === 3 &&
        J(shuffled) === J(gEdited.pos.map((p) => 1 - p).reverse()),
      `edited=${J(gEdited)} shuffle=${J(shuffled)}`,
    );
    const nested = await cdp.eval(`(() => {
      const p = window.__gpvShell.popTop();
      const b = p ? p.querySelector('button[title="색"]') : null;
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(300);
    const stacked = await cdp.eval(
      `({ n: window.__gpvShell.popN(), title: window.__gpvShell.popTitle() })`,
    );
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(300);
    const afterEsc1 = await cdp.eval(
      `({ n: window.__gpvShell.popN(), title: window.__gpvShell.popTitle() })`,
    );
    await S(`focusRoot()`);
    await cdp.eval(`window.__gpvShell.fire({ key:'Escape', code:'Escape' })`);
    await sleep(300);
    const afterEsc2 = await cdp.eval(`({
      n: window.__gpvShell.popN(),
      extra: window.__gpvShell.chromeN('[data-chrome="extra"] *'),
      open: !window.__gpvShell.gone(),
    })`);
    r.check(
      "(45 ins-11c) 팝오버는 **스택**이다 — 그라디언트 위에 연 스톱 피커를 Esc 가 하나씩 벗기고, 다 닫히면 캔버스 핸들도 함께 걷힌다",
      nested === true &&
        stacked.n === 2 &&
        /스톱/.test(stacked.title || "") &&
        afterEsc1.n === 1 &&
        /그라디언트/.test(afterEsc1.title || "") &&
        afterEsc2.n === 0 &&
        afterEsc2.extra === 0 &&
        afterEsc2.open === true,
      `열림=${J(stacked)} Esc1=${J(afterEsc1)} Esc2=${J(afterEsc2)}`,
    );

    // ── (45 ins-12) 효과 편집 ────────────────────────────────────────────────
    await seed([rect("fx", 40, 40, 60, 60)]);
    await selectAllRoot();
    await sleep(300);
    await S(`stackAdd('효과')`);
    await sleep(300);
    const fx1 = await cdp.eval(`({
      effects: window.__gpvShell.doc().objects[0].effects,
      rows: window.__gpvShell.stackText('효과'),
      label: window.__gpvShell.lastLabel(),
    })`);
    r.check(
      "(45 ins-12a) `효과 +` 는 시안 기본값 드롭 섀도(0·4 12 25%) 한 겹을 만든다",
      fx1.effects.length === 1 &&
        fx1.effects[0].type === "drop-shadow" &&
        fx1.effects[0].y === 4 &&
        fx1.effects[0].blur === 12 &&
        fx1.effects[0].opacity === 0.25 &&
        /드롭 섀도/.test(fx1.rows[0] || "") &&
        fx1.label === "효과 추가 드롭 섀도",
      J(fx1),
    );
    await S(`stackBtn('효과', 0, '설정')`);
    await sleep(300);
    await cdp.eval(`window.__gpvShell.typeField('흐림', '16', window.__gpvShell.popTop())`);
    await sleep(300);
    const fx2 = await cdp.eval(`({
      blur: window.__gpvShell.doc().objects[0].effects[0].blur,
      title: window.__gpvShell.popTitle(),
      n: window.__gpvShell.popN(),
    })`);
    await S(`ed().popover.close()`);
    await sleep(200);
    await S(`stackBtn('효과', 0, '제거')`);
    await sleep(300);
    const fx3 = await cdp.eval(`({
      n: window.__gpvShell.doc().objects[0].effects.length,
      label: window.__gpvShell.lastLabel(),
    })`);
    r.check(
      "(45 ins-12b) 행의 `설정` 이 그 겹의 편집기를 열고, 필드가 문서에 닿고, `−` 가 겹을 지운다",
      fx2.blur === 16 && fx2.n === 1 && fx2.title === "드롭 섀도" && fx3.n === 0 &&
        fx3.label === "효과 제거",
      `${J(fx2)} → ${J(fx3)}`,
    );

    // ── (45 ins-13) 조정 탭 — hidden 마운트 · 마스크 · 슬라이더 ──────────────
    await seed([rect("j1", 20, 20, 40, 40)]);
    await selectAllRoot();
    await S(`clickTab('속성')`);
    await sleep(250);
    const before13 = await cdp.eval(`({
      tab: window.__gpvShell.tab(),
      hidden: window.__gpvShell.tabHidden('adjust'),
      rotation: window.__gpvShell.doc().rotation,
    })`);
    const rotClicked = await S(`clickBtn(/오른쪽 90/)`);
    await sleep(500);
    const after13 = await cdp.eval(
      `({ rotation: window.__gpvShell.doc().rotation, tab: window.__gpvShell.tab() })`,
    );
    await S(`clickBtn(/왼쪽 90/)`);
    await sleep(400);
    r.check(
      "(45 ins-13a) 네 탭이 **항상 마운트**돼 있다 — 속성 탭을 보는 채로 조정 탭의 `오른쪽 90°` 가 눌린다(e2e 30 (c) 가 정확히 이 경로다)",
      before13.tab === "props" &&
        before13.hidden === true &&
        rotClicked === true &&
        after13.rotation === (before13.rotation + 90) % 360 &&
        after13.tab === "props",
      `${J(before13)} → ${J(after13)} clicked=${rotClicked}`,
    );

    await seed([rect("k1", 20, 20, 40, 40), rect("k2", 90, 20, 40, 40)]);
    await selectAllRoot();
    await sleep(250);
    await S(`clickBar(/마스크로 사용/)`);
    await sleep(350);
    const masked = await cdp.eval(`({
      masks: window.__gpvShell.doc().objects.filter((o) => o.mask).length,
      kinds: window.__gpvShell.doc().objects.map((o) => o.kind),
      label: window.__gpvShell.lastLabel(),
    })`);
    r.check(
      "(45 ins-13b) `마스크로 사용` 은 그룹으로 감싸고 **맨 아래 한 겹만** 마스크로 만든다(38 makeMask)",
      masked.masks === 1 && masked.kinds.includes("group") && masked.label === "마스크로 사용",
      J(masked),
    );

    await S(`clickTab('조정')`);
    await sleep(250);
    const h13 = await S(`hist()`);
    const slid = await cdp.eval(`(async () => {
      const p = window.__gpvShell.tabPanel('adjust');
      const el = p ? p.querySelector('input[type="range"]') : null;
      if (!el) return null;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const v of ['110', '120', '130']) {
        set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await window.__gpvShell.frame();
      }
      const mid = window.__gpvShell.hist();
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      await window.__gpvShell.frame();
      return {
        mid: mid,
        end: window.__gpvShell.hist(),
        brightness: window.__gpvShell.doc().brightness,
      };
    })()`);
    r.check(
      "(45 ins-13c) 색 보정 슬라이더는 **드래그 한 번 = 한 칸**이다 — 틱마다 커밋하면 몇 초 만에 200칸 상한이 소진돼 그 앞 작업으로 못 돌아간다",
      !!slid && slid.brightness === 130 && slid.mid === h13 + 1 && slid.end === h13 + 1,
      J(slid),
    );
    await cdp.eval(`window.__gpvShell.ed().setDoc({ brightness: 100 })`);
    await S(`clickTab('속성')`);
    await sleep(200);

    // ── (45 ins-14) 푸터 ─────────────────────────────────────────────────────
    const footer = await cdp.eval(`(() => {
      const m = window.__gpvShell.modal();
      const aside = m ? m.querySelector('aside') : null;
      const foot = aside ? aside.lastElementChild : null;
      return {
        labels: foot
          ? Array.from(foot.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
          : [],
        cancels: m
          ? Array.from(m.querySelectorAll('button')).filter(
              (b) => (b.textContent || '').trim() === '취소',
            ).length
          : -1,
      };
    })()`);
    r.check(
      "(45 ins-14) 푸터는 `초기화 · 복사 · 다른 이름으로 · 저장 (PNG)` 넷이고 `취소` 버튼은 없다 — e2e 30/34/35 가 이 라벨로 저장을 구동하고, 닫기는 타이틀바 X·Esc 다",
      footer.labels.length === 4 &&
        footer.labels[0] === "초기화" &&
        footer.labels[1] === "복사" &&
        footer.labels[2] === "다른 이름으로" &&
        /^저장 \(/.test(footer.labels[3] || "") &&
        footer.cancels === 0,
      J(footer),
    );
  } finally {
    await cdp.eval(`window.__gpvShell && window.__gpvShell.removeProbe()`).catch(() => {});
    await closeEditor().catch(() => {});
    await sleep(200);
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    // 앱 상태 원복 — 22 스위트와 같은 순서(selectProject 를 selectDiff 보다 먼저 되돌리지
    // 않으면 픽스처 selectedProjectId 로 사용자 파일이 viewerTabs 에 기록된다).
    await cdp
      .eval(`(() => {
        const u = window.__gpv.ui.getState();
        if (u.confirm) u.closeConfirm();
        if (u.prompt) u.closePrompt();
        u.setQuickOpenOpen(false);
        u.setSymbolSearchOpen(false);
        u.setAggregateOpen(false);
        for (const t of [...u.viewerTabs].filter((t) => t.outerId === ${J(fix.projectId)})) {
          u.closeViewerTab(t.key);
        }
        if (${J(prior.pid)}) u.selectProject(${J(prior.pid)});
        u.selectDiff(${J(prior.diff)}, ${J(prior.repo)});
        return true;
      })()`)
      .catch(() => {});
    if (prior.toggles !== null) {
      await cdp
        .eval(`localStorage.setItem('gp:ie:toggles', ${J(prior.toggles)})`)
        .catch(() => {});
    }
    for (const rel of [SRC, ...created]) {
      const p = join(fix.repo, rel);
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* 픽스처 정리는 best-effort */
      }
    }
  }
}
