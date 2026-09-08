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
  A.pointerSeq = async (steps) => {
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
  A.hover = async (x, y) => {
    const c = A.canvases()[1];
    if (!c) return false;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, composed: true,
        clientX: r.left + (x / c.width) * r.width,
        clientY: r.top + (y / c.height) * r.height,
        button: -1, buttons: 0,
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
    const p = join(fix.repo, SRC);
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* 픽스처 정리는 best-effort */
    }
  }
}
