// 스타일 라이브러리·컴포넌트/인스턴스(51) — DOCS/task/51-image-styles-components.md §7.
//
// 이 스위트가 지키는 계약 다섯:
//   ① **라이브러리는 문서 밖에 산다.** `app_data_dir/image-library.json` 파일 하나이고 창이 몇
//      개든 같은 것을 본다 — doc 창이 저장하면 메인 창의 목록도, 메인 창의 **문서**도 따라
//      움직인다. 파일·이벤트·재동기 중 하나만 빠져도 "다른 창에서 만든 색이 안 보인다"가 된다.
//   ② **스타일은 값 복사 + 참조다.** 라이브러리를 고치면 참조 노드가 **전부** 따라오고(커밋 1칸),
//      노드를 직접 고치면 링크가 끊긴다. 안 끊기면 다음 재동기가 사용자 편집을 조용히 되돌린다
//      (§3.2) — 화면 어디에도 원인이 없는 종류의 버그라 픽셀·값으로만 잡힌다.
//   ③ **재정의는 커밋 시 문서에서 되짚는다**(§3.5). 자식을 어떤 경로로 고쳤든 훅 없이 잡히고,
//      '마스터 갱신'은 **남의 인스턴스 재정의를 덮지 않는다**(덮으면 사용자가 손으로 맞춘 값이
//      한 번의 갱신으로 전부 날아간다).
//   ④ **인스턴스는 프레임 자식이 기하를 든다**(§3.4). 끌면 서브트리가 통째로 가고, 이미지 90°
//      회전은 방향을 들 수 없어 **분리하고 그 사실을 알린다**(조용히 끊으면 원인을 못 찾는다).
//   ⑤ **8MB 에서 멈춘다.** 거절이 없으면 IPC 문자열 하나가 WebView 를 통째로 세우고, 그 값이
//      파일에 닿으면 다음 로드가 손상으로 보고 라이브러리를 통째로 격리한다.
//
// 200px 픽스처라 oriented px == 백킹 px == 파일 px 이고 맞춤 배율이 1이다(30·36·37·39·40 과 같은
// 전제). 좌표를 재는 케이스가 있으므로 스냅은 스위트 내내 꺼 두고 finally 에서 되돌린다.
//
// **사용자의 실제 라이브러리를 건드린다** — 앱 전역 파일이라 창·문서와 무관하다(§6 위험표 1행).
// 편집기를 연 직후의 라이브러리를 기준선으로 떠 두고 finally 에서 되돌리며, 이 스위트가 만드는
// 것에는 전부 `e2e:` 접두를 붙인다. 시작에도 같은 접두를 걷어내므로 중간에 죽은 앞 회차의
// 잔해가 다음 실행에 섞이지 않는다.
//
// **라이브러리 쓰기는 doc 창에서 한다.** 메인 창이 자기 `image_library_set` 을 부르면 Rust 가
// 보내는 `image-library://changed` 의 origin 이 자기 라벨이라 스토어가 **의도적으로** 무시한다
// (§3.7 — 자기 이벤트로 재로드하면 저장→로드→저장 왕복이 된다). 즉 메인에서 쓰면 파일만 바뀌고
// 화면·문서는 그대로다. doc 창에서 쓰면 origin 이 달라 메인이 재로드하고, 그 재로드가 곧 편집기의
// 재동기 경로다 — 스타일 편집을 e2e 가 구동할 수 있는 유일한 통로이자 (k) 그 자체다.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { connectLabel } from "../lib/cdp.mjs";

export const name =
  "이미지 스타일·컴포넌트 (앱 전역 라이브러리·창 간 동기 / 스타일 재동기·자동 분리 / 인스턴스 재정의·마스터 갱신·분리)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
// **베어 지정자를 쓰지 마라.** 페이지 안 동적 `import()` 는 번들러 별칭을 모른다 —
// `@tauri-apps/api/webviewWindow` 는 "Failed to resolve module specifier" 로 던진다.
// 34 스위트와 같은 파일 경로를 쓴다.
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

/** 정규화된 단색 Fill 과 **같은 모양**(schema `normFill`: type·color·opacity·visible·blend). */
const solid = (hex) => ({ type: "solid", color: hex, opacity: 1, visible: true, blend: "normal" });

const RED = "#FF0000";
const BLUE = "#0000FF";
const GREEN = "#00FF00";
const ORANGE = "#FF8800";

const HELPERS = `(() => {
  const A = {};
  window.__gpvLib = A;

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
  A.objects = () => A.doc().objects;
  A.node = (id) => A.doc().objects.find((o) => o.id === id) || null;
  A.kinds = () => A.doc().objects.map((o) => o.kind);
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
  /** **내보내기 렌더 경로**로 뽑은 한 점 — 씬과 같아야 '화면 == 파일' 이다(39·40 과 같은 계약). */
  A.renderPx = (x, y) => {
    const r = A.ed().renderRegion({ x: x, y: y, w: 1, h: 1 }, 1);
    return r ? r.data.slice(0, 4) : null;
  };

  // ── 라이브러리·인스턴스 훅(51 §4) ─────────────────────────────────────────
  A.lib = () => A.ed().library.get();
  A.libJson = () => JSON.stringify(A.ed().library.get());
  A.styles = () => A.ed().library.styles();
  A.components = () => A.ed().library.components();
  A.instState = (id) => A.ed().instance.state(id);
  A.counts = () => A.ed().instance.counts();

  // ── 토스트·프롬프트·확인창 ────────────────────────────────────────────────
  A.toasts = () => window.__gpv.ui.getState().toasts.map((t) => t.message);
  A.clearToasts = () => {
    const st = window.__gpv.ui.getState();
    st.toasts.slice().forEach((t) => st.dismissToast(t.id));
    return true;
  };
  /**
   * 열린 프롬프트에 답한다. **닫고 나서** onConfirm 을 부른다 — 확인 핸들러가 또 다른 확인창을
   * 열 수 있는데(컴포넌트 삭제) 순서가 반대면 그것까지 함께 닫힌다(30·39 와 같은 규칙).
   */
  A.answerPrompt = async (value) => {
    for (let i = 0; i < 40; i++) {
      const st = window.__gpv.ui.getState();
      if (st.prompt) {
        const req = st.prompt;
        st.closePrompt();
        req.onConfirm(value);
        await A.frame();
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  A.answerConfirm = async () => {
    for (let i = 0; i < 40; i++) {
      const st = window.__gpv.ui.getState();
      if (st.confirm) {
        const req = st.confirm;
        st.closeConfirm();
        req.onConfirm();
        await A.frame();
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  /** 남은 모달 — 다음 케이스·다음 스위트의 키를 죽이는 것이 이것들이다(useEditorKeys 게이트 ①). */
  A.pending = () => {
    const st = window.__gpv.ui.getState();
    return { prompt: !!st.prompt, confirm: !!st.confirm };
  };

  // ── 키(42 window capture 리스너가 받는다) ─────────────────────────────────
  A.fire = async (init) => {
    const ev = new KeyboardEvent(
      'keydown',
      Object.assign({ bubbles: true, cancelable: true }, init),
    );
    window.dispatchEvent(ev);
    await A.frame();
    await A.frame();
    return ev.defaultPrevented;
  };
  A.selectAll = () => A.fire({ key: 'a', code: 'KeyA', ctrlKey: true });
  A.selIds = () => A.ui().selectedIds;

  // ── 포인터(백킹 px 좌표 — 30·39·40 과 같은 계약) ──────────────────────────
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
            pointerId: 3800, pointerType: 'mouse', isPrimary: true,
          }),
        );
        if (st[0] !== 'move') await A.frame();
      }
      await A.frame();
      return true;
    } finally {
      P.setPointerCapture = o.s;
      P.releasePointerCapture = o.r;
      P.hasPointerCapture = o.h;
    }
  };
  A.click = (x, y) => A.pointerSeq([['down', x, y], ['up', x, y]]);
  A.drag = (x, y, dx, dy) =>
    A.pointerSeq([
      ['down', x, y],
      ['move', x + dx / 2, y + dy / 2],
      ['move', x + dx, y + dy],
      ['up', x + dx, y + dy],
    ]);

  // ── 좌 패널 · 에셋 카드(51 §3.8) ──────────────────────────────────────────
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
  A.panelText = (id) => {
    const p = A.panelBody(id);
    return p ? (p.textContent || '').trim() : '';
  };
  /** 카드는 button 이 아니라 div 다(드래그 손잡이) — title 이 곧 컴포넌트 이름이다. */
  A.cards = () => {
    const p = A.panelBody('assets');
    return p ? Array.from(p.querySelectorAll('div[title]')) : [];
  };
  A.cardTitles = () => A.cards().map((el) => el.getAttribute('title'));
  A.card = (nm) => A.cards().find((el) => el.getAttribute('title') === nm) || null;
  A.stage = () => {
    const m = A.modal();
    return m ? m.querySelector('.checkerboard') : null;
  };
  /** 카드 더블클릭 = 이미지 중심 배치(§3.8). */
  A.placeByCard = async (nm) => {
    const el = A.card(nm);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await A.frame();
    await A.frame();
    return true;
  };
  /**
   * 카드 드래그 → 스테이지 드롭. **같은 DataTransfer 객체**를 dragstart 와 drop 에 함께 쓴다 —
   * 카드가 그 안에 컴포넌트 id 를 넣고 스테이지가 그것을 읽는 것이 계약이라(COMPONENT_DND_TYPE),
   * 새 객체를 만들면 드롭이 조용히 무시된다(예외도 로그도 없다).
   *
   * 좌표는 포인터 경로와 **같은 매핑**으로 만든다(캔버스 rect ↔ 백킹 px). 그래야 인스턴스가
   * 생긴 자리를 놓은 자리와 직접 비교할 수 있다.
   */
  A.dropCard = async (nm, ox, oy) => {
    const el = A.card(nm);
    const st = A.stage();
    const c = A.canvases()[1];
    if (!el || !st || !c) return false;
    const r = c.getBoundingClientRect();
    const clientX = r.left + (ox / c.width) * r.width;
    const clientY = r.top + (oy / c.height) * r.height;
    // DataTransfer·DragEvent 생성자는 엔진이 막을 수 있다 — 던지면 스위트가 통째로 죽으므로
    // 여기서 삼키고 false 를 돌려준다(그 케이스만 실패로 남는다).
    try {
      const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      for (const type of ['dragover', 'drop']) {
        st.dispatchEvent(
          new DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: clientX, clientY: clientY,
          }),
        );
      }
    } catch (e) {
      return false;
    }
    await A.frame();
    await A.frame();
    return true;
  };

  // ── 인스펙터 · 팝오버(45 셸) ──────────────────────────────────────────────
  A.tabPanel = (id) => {
    const m = A.modal();
    return m ? m.querySelector('[data-inspector-tab="' + (id || A.ed().inspector.tab()) + '"]') : null;
  };
  A.tabText = (id) => {
    const p = A.tabPanel(id);
    return p ? (p.textContent || '').trim() : '';
  };
  /** 인스펙터 버튼 — 문구로 집는다(클래스 선택자는 스타일이 바뀌면 조용히 못 찾는다). */
  A.tabBtn = async (label, id) => {
    const p = A.tabPanel(id);
    const b = p
      ? Array.from(p.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === label,
        )
      : null;
    if (!b || b.disabled) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };
  A.tabBtnEnabled = (label, id) => {
    const p = A.tabPanel(id);
    const b = p
      ? Array.from(p.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === label,
        )
      : null;
    return b ? !b.disabled : null;
  };
  /** 속성 탭 섹션 — 헤더 **문구**로 집는다(40 과 같은 규칙). */
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
  A.pops = () => Array.from((A.modal() || document).querySelectorAll('[role="dialog"]'));
  A.popTop = () => {
    const p = A.pops();
    return p.length ? p[p.length - 1] : null;
  };
  A.clickIn = async (root, label) => {
    const b = root
      ? Array.from(root.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === label,
        )
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    return true;
  };
  A.clickSaveStyle = async () => A.clickIn(A.popTop(), '색 스타일로 저장');

  // ── 스타일 목록(45/50 슬롯이 마운트한다 — 없으면 그 블록은 skip) ──────────
  A.styleList = () => {
    const m = A.modal();
    const input = m ? m.querySelector('input[aria-label="스타일 검색"]') : null;
    return input ? input.parentElement.parentElement : null;
  };
  A.styleSearch = async (q) => {
    const m = A.modal();
    const el = m ? m.querySelector('input[aria-label="스타일 검색"]') : null;
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, q);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await A.frame();
    await A.frame();
    return true;
  };
  /** 목록 행 — title 이 스타일 **전체 이름**이고 본문은 섹션이 붙었으면 표시 이름만이다(§3.3). */
  A.styleRows = () => {
    const root = A.styleList();
    if (!root) return [];
    return Array.from(root.querySelectorAll('button'))
      .filter((b) => b.getAttribute('title') !== null)
      .map((b) => ({ name: b.getAttribute('title'), text: (b.textContent || '').trim() }));
  };
  /** 섹션 헤더 — title 이 없는 버튼(행과 갈리는 유일한 표식). */
  A.styleSections = () => {
    const root = A.styleList();
    if (!root) return [];
    return Array.from(root.querySelectorAll('button'))
      .filter((b) => b.getAttribute('title') === null)
      // 헤더 버튼은 [이름 span][개수 span] 두 칸이다 — 버튼 전체 textContent 를 읽으면
      // 'e2e:상태' + '2' 가 붙어 'e2e:상태2' 가 된다(42 의 선택 개수 표시와 같은 함정).
      // 첫 자식은 chevron **아이콘**이다 — 이름 span 을 집어야 한다.
      .map((b) => ((b.querySelector('span') || b).textContent || '').trim());
  };
  /** 행 클릭 = 적용. 값 복사·참조 기록·히스토리 한 칸은 목록이 아니라 **호출자**가 한다(§3.8). */
  A.clickStyleRow = async (nm) => {
    const root = A.styleList();
    const b = root
      ? Array.from(root.querySelectorAll('button')).find((x) => x.getAttribute('title') === nm)
      : null;
    if (!b) return false;
    b.click();
    await A.frame();
    await A.frame();
    return true;
  };

  // ── 저장(30·39 와 같은 계약) ──────────────────────────────────────────────
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
   * '다른 이름으로' 저장. 같은 이름으로 두 번째 저장이면 앱이 **덮어쓰기 확인창**을 띄우는데,
   * 답하지 않으면 저장이 일어나지 않은 채 확인창이 useUi 에 남고 closeImageEditor 도 그것을
   * 지우지 않아 **다음 스위트까지 새어 간다** — useEditorKeys 게이트 ①(blocked)이 편집기 키를
   * 통째로 통과시켜 뒤 스위트가 무더기로 깨진다(실측). 그래서 여기서 끝까지 답한다.
   */
  A.saveAs = async (fileName) => {
    if (!A.clickBtn(/다른 이름으로/)) return { ok: false, why: 'button' };
    await new Promise((r) => setTimeout(r, 80));
    const st = window.__gpv.ui.getState();
    const req = st.prompt;
    if (!req) return { ok: false, why: 'prompt' };
    st.closePrompt();
    req.onConfirm(fileName);
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
    return { ok: true, overwrote: overwrote };
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
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /** 키 순서를 정규화한 딥이퀄 지문(37·39 스위트와 같은 방식). */
  A.key = (v) =>
    JSON.stringify(v, (_k, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort())
        : x,
    );

  return true;
})()`;

const near = (p, rgb, tol = 12) =>
  Array.isArray(p) &&
  Math.abs(p[0] - rgb[0]) <= tol &&
  Math.abs(p[1] - rgb[1]) <= tol &&
  Math.abs(p[2] - rgb[2]) <= tol &&
  p[3] > 200;
const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const show = (p) => (Array.isArray(p) ? `rgba(${p.join(",")})` : String(p));

/** 이 스위트가 만든 것(전부 `e2e:` 접두)을 걷어낸 라이브러리 — 기준선이자 정리 대상이다. */
function stripE2e(lib) {
  const clean = (list) => (Array.isArray(list) ? list.filter((x) => !/^e2e:/.test(x.name || "")) : []);
  return {
    ...lib,
    colorStyles: clean(lib.colorStyles),
    textStyles: clean(lib.textStyles),
    effectStyles: clean(lib.effectStyles),
    components: clean(lib.components),
  };
}

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 스타일·컴포넌트", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-lib.png";
  const OUT = "e2e-lib-out.png";
  const created = [SRC, OUT];

  const S = (expr) => cdp.eval(`window.__gpvLib.${expr}`);
  const setDoc = (patch) => cdp.eval(`window.__gpvLib.setDoc(${J(patch)})`);
  const objects = () => S(`objects()`);
  const node = (id) => cdp.eval(`window.__gpvLib.node(${J(id)})`);
  const px = (x, y) => S(`px(1, ${x}, ${y})`);
  const mainLib = () => S(`lib()`).catch(() => null);
  const closeEditor = () =>
    cdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});

  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

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
    await cdp.eval(`window.__gpvLib.ed().setTool('select')`).catch(() => {});
    await cdp.eval(`window.__gpvLib.ed().setToggle('snap', false)`).catch(() => {});
    return ok === true;
  };

  /** 컴포넌트 만들기(Ctrl+Alt+K) — 프롬프트까지 답해야 한 동작이 끝난다. */
  const makeComponent = async (nm) => {
    await S(`fire({ key:'k', code:'KeyK', ctrlKey:true, altKey:true })`);
    await S(`answerPrompt(${J(nm)})`);
    await sleep(300);
  };

  let snap0 = null;
  let baseLib = null; // 되돌릴 기준선(사용자 라이브러리 − `e2e:` 잔해)
  let docLabel = null;
  let dcdp = null;

  const arr = (v) => (Array.isArray(v) ? v : []);
  const labels = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
    );

  /**
   * 라이브러리를 doc 창에서 고친다(머리말 참조). 메인의 **300ms 디바운스 저장이 내 쓰기 뒤에**
   * 떨어지면 방금 쓴 것을 자기 옛 상태로 덮으므로, 쓰기 전에 그 창을 먼저 비운다.
   * 돌려주는 값은 메인이 실제로 재로드해 조건을 만족하기까지 걸린 시간이다((k) 의 근거).
   */
  const writeLib = async (mutate, want) => {
    if (!dcdp) return { ok: false, why: "doc 창 없음" };
    await sleep(700);
    const cur = await S(`libJson()`);
    const next = mutate(JSON.parse(cur));
    const t0 = Date.now();
    const res = await dcdp.try("image_library_set", { json: JSON.stringify(next) });
    if (!res.ok) return { ok: false, why: res.code || res.message };
    const got = await poll(() => mainLib(), want || (() => true), 30, 100);
    return { ok: !!(want ? want(got) : got), ms: Date.now() - t0, lib: got };
  };

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    // ── 셋업: 픽스처 PNG · 편집기 · doc 창 ───────────────────────────────────
    const white = await cdp.eval(`window.__gpvLib.solidPng(200, 200, '#ffffff')`);
    const made = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: SRC,
      base64: white,
      overwrite: true,
    });
    if (!r.check("픽스처 PNG 생성(200×200 흰색)", made.ok && existsSync(join(fix.repo, SRC)))) {
      return;
    }
    if (!r.check("편집기 열림", (await openEditor()) === true)) return;
    snap0 = await S(`ui().toggles.snap`).catch(() => null);

    const hasLib = await cdp.eval(
      `!!(window.__gpv.imageEditor && window.__gpv.imageEditor.library && window.__gpv.imageEditor.instance)`,
    );
    if (!hasLib) {
      r.skip(
        "이미지 스타일·컴포넌트",
        "`__gpv.imageEditor.library/instance` 훅 미노출 — 태스크 51 미착지",
      );
      return;
    }

    // 스토어의 첫 로드(ensure)가 끝나야 기준선이 진짜 파일 내용이다. `ready` 전에는 빈
    // 라이브러리라, 그걸 기준선으로 잡으면 finally 가 사용자 스타일을 통째로 지운다.
    const ready = await poll(
      () => cdp.eval(`window.__gpv.imageEditor.library.get()`).catch(() => null),
      (v) => !!v && Array.isArray(v.textStyles),
      30,
      200,
    );
    baseLib = ready ? stripE2e(ready) : null;
    if (!r.check("라이브러리 스토어 로드됨(기준선 확보)", !!baseLib)) return;

    const before = arr(await labels());
    await cdp.eval(
      `window.__gpv.openDocWindow(${J(fix.projectId)}, ${J(SRC)}, { size: [900, 700] })`,
    );
    docLabel = await poll(
      async () => arr(await labels()).find((l) => l.startsWith("doc-") && !before.includes(l)) ?? null,
      (v) => !!v,
      20,
      500,
    );
    if (docLabel) {
      dcdp = await connectLabel(docLabel, { port: cdpPort }).catch(() => null);
    }
    r.check(
      "doc 창 확보(라이브러리 쓰기 채널 — 메인은 자기 origin 이벤트를 무시한다)",
      !!dcdp,
      docLabel || "미발견",
    );

    // ── (a) 저장소 — 앱 전역 파일 하나 · 기본 모양 ───────────────────────────
    const cleaned = await writeLib(
      () => baseLib,
      (l) => !!l && !l.colorStyles.some((s) => /^e2e:/.test(s.name)),
    );
    const lib0 = (await mainLib()) || {};
    r.check(
      "(51 a-1) 라이브러리는 `{v:1, 색·텍스트·효과·컴포넌트 4배열, seeded}` 한 벌이다(창·문서와 무관한 앱 전역 상태)",
      lib0.v === 1 &&
        Array.isArray(lib0.colorStyles) &&
        Array.isArray(lib0.textStyles) &&
        Array.isArray(lib0.effectStyles) &&
        Array.isArray(lib0.components) &&
        lib0.seeded === true,
      `v=${lib0.v} 색=${arr(lib0.colorStyles).length} 텍스트=${arr(lib0.textStyles).length} 효과=${arr(lib0.effectStyles).length} 컴포넌트=${arr(lib0.components).length} seeded=${lib0.seeded} 잔해정리=${cleaned.ok}`,
    );

    if (process.platform === "win32" && process.env.APPDATA) {
      // dev 빌드는 identifier 가 `.dev` 로 갈린다(CLAUDE.md) — 둘 다 본다.
      const cands = [
        join(process.env.APPDATA, "com.greathoon.gitpervisor.dev", "image-library.json"),
        join(process.env.APPDATA, "com.greathoon.gitpervisor", "image-library.json"),
      ];
      const hit = cands.find((p) => existsSync(p)) || null;
      let keyed = false;
      if (hit) {
        try {
          keyed = Object.prototype.hasOwnProperty.call(
            JSON.parse(readFileSync(hit, "utf8")),
            "library",
          );
        } catch {
          keyed = false;
        }
      }
      r.check(
        "(51 a-2) `app_data_dir/image-library.json` 에 키 `library` 로 실제로 쓰인다(state.rs 포맷 — 설정·프로젝트와 같은 원자 쓰기·손상 격리를 그대로 탄다)",
        !!hit && keyed,
        hit ? `${hit} key=${keyed}` : `없음: ${cands.join(" · ")}`,
      );
    } else {
      r.skip("(51 a-2) 라이브러리 파일 존재", `win32 아님(${process.platform}) — 경로 규칙이 다르다`);
    }

    // ── (d) 내장 텍스트 스타일 3종(시안 ②) ──────────────────────────────────
    const seeds = arr(lib0.textStyles).filter((s) => /^(제목|본문|캡션) \//.test(s.name));
    const h1 = seeds.find((s) => s.name === "제목 / H1") || null;
    r.check(
      "(51 d-1) 내장 텍스트 스타일 3종이 첫 로드에 심긴다 — `제목 / H1` 은 28 · 700 · 130%",
      seeds.length === 3 &&
        !!h1 &&
        h1.style.fontSize === 28 &&
        h1.style.fontWeight === 700 &&
        h1.style.lineHeight === 130,
      `${seeds.map((s) => s.name).join(" · ")} H1=${h1 ? J(h1.style.fontSize) + "/" + h1.style.fontWeight + "/" + h1.style.lineHeight : "없음"}`,
    );

    // ── (b) '색 스타일로 저장'(시안 ④ 색 피커) ──────────────────────────────
    //
    // 저장은 **적용이 아니다** — 참조를 남기지 않으므로 문서는 한 줄도 바뀌지 않는다(§3.8).
    const PINK = "e2e:상태 / 경고 / 핑크";
    await setDoc({
      objects: [
        { id: "a1", kind: "rect", x: 20, y: 20, w: 60, h: 40, fills: [solid(RED)], strokes: [], strokeWidth: 0 },
        { id: "b1", kind: "rect", x: 120, y: 20, w: 60, h: 40, fills: [solid(RED)], strokes: [], strokeWidth: 0 },
      ],
    });
    await S(`click(50, 40)`);
    await sleep(200);
    await cdp.eval(`window.__gpvLib.ed().inspector.setTab('props')`);
    await sleep(200);
    const histB = await S(`hist()`);
    const opened = await S(`stackOpen('채우기', 0)`);
    const hasSaveBtn = await cdp.eval(
      `(() => { const p = window.__gpvLib.popTop(); return !!p && Array.from(p.querySelectorAll('button')).some((b) => (b.textContent||'').trim() === '색 스타일로 저장'); })()`,
    );
    await S(`clickSaveStyle()`);
    await S(`answerPrompt(${J(PINK)})`);
    await sleep(400);
    const savedStyle = (await mainLib()) || {};
    const pink = arr(savedStyle.colorStyles).find((s) => s.name === PINK) || null;
    const a1 = await node("a1");
    r.check(
      "(51 b-1) 색 피커 `색 스타일로 저장` 이 노드 값을 그대로 스타일로 굳힌다 — 저장은 적용이 아니라 문서·히스토리는 그대로다",
      opened === true &&
        hasSaveBtn === true &&
        !!pink &&
        pink.paint.color === RED &&
        !!a1 &&
        !a1.styleRefs.fill &&
        (await S(`hist()`)) === histB,
      `팝오버=${opened} 버튼=${hasSaveBtn} 스타일=${pink ? pink.name + "/" + pink.paint.color : "없음"} 참조=${a1 ? J(a1.styleRefs) : "?"}`,
    );

    // ── (b-2) 목록 UI — 섹션 규칙·검색·적용·`적용됨`(45/50 슬롯) ─────────────
    //
    // **팝오버를 연 채로** 본다: 목록은 45 색 피커 안(시안 ④)이 첫 자리라, 닫고 찾으면
    // 마운트돼 있어도 못 찾아 통째로 skip 된다.
    const hasList = (await cdp.eval(`!!window.__gpvLib.styleList()`)) && !!dcdp;
    if (!hasList) {
      r.skip(
        "(51 b-2) 스타일 목록 UI(섹션·검색·`적용됨`)",
        dcdp
          ? "`스타일 검색` 입력 미마운트 — 45(채우기 팝오버)·50(텍스트 인스펙터) 슬롯 배선 대기"
          : "doc 창 없음 — 두 번째 스타일을 심을 통로가 없다",
      );
    } else {
      const rows1 = await S(`styleRows()`);
      const secs1 = await S(`styleSections()`);
      await writeLib((l) => ({
        ...l,
        colorStyles: [
          ...l.colorStyles,
          { id: "e2e-blue-500", name: "e2e:상태 / Blue 500", paint: solid(BLUE), updatedAt: 1 },
        ],
      }), (l) => !!l && l.colorStyles.some((s) => s.id === "e2e-blue-500"));
      await sleep(300);
      const rows2 = await S(`styleRows()`);
      const secs2 = await S(`styleSections()`);
      r.check(
        "(51 b-2) 같은 섹션이 **2개 이상일 때만** 헤더로 접힌다 — 1건이면 전체 이름을 그대로 보인다(시안 ② `제목 / H1`)",
        arr(rows1).some((x) => x.name === PINK && x.text.includes(PINK)) &&
          !arr(secs1).includes("e2e:상태") &&
          arr(secs2).includes("e2e:상태") &&
          arr(rows2).some((x) => x.name === PINK && x.text.includes("경고 / 핑크")),
        `1건=${J(arr(rows1).filter((x) => /^e2e:/.test(x.name)))} 2건 섹션=${J(arr(secs2).filter((s) => /^e2e:/.test(s)))}`,
      );
      await S(`styleSearch('BLUE')`);
      const hits = await S(`styleRows()`);
      await S(`styleSearch('')`);
      r.check(
        "(51 b-3) 검색은 대소문자를 무시하고 **이름 전체**(섹션 포함)로 거른다",
        arr(hits).length >= 1 && arr(hits).every((x) => /blue/i.test(x.name)),
        J(arr(hits).map((x) => x.name)),
      );

      // 적용 = 값 복사 + 참조. 선택(a1)이 그 id 를 물면 그 행에만 `적용됨` 이 붙는다.
      const clicked = await S(`clickStyleRow(${J(PINK)})`);
      await sleep(300);
      const applied = await node("a1");
      const rows3 = await S(`styleRows()`);
      const badged = arr(rows3).filter((x) => /적용됨/.test(x.text));
      r.check(
        "(51 b-4) 목록 행을 누르면 **값이 노드에 복사되고 참조가 남는다** — `적용됨` 배지는 선택 전부가 같은 id 를 물 때만 그 행에 붙는다",
        clicked === true && !!pink && !!applied &&
          applied.styleRefs.fill === pink.id &&
          applied.fills[0].color === pink.paint.color &&
          badged.length === 1 && badged[0].name === PINK,
        `참조=${applied && J(applied.styleRefs)} 색=${applied && applied.fills[0].color} 배지=${J(badged.map((x) => x.name))}`,
      );
    }
    await cdp.eval(`window.__gpvLib.ed().popover.close()`).catch(() => {});
    await sleep(150);

    // ── (c)(k) 편집 전파 · 자동 분리 · 삭제 ─────────────────────────────────
    //
    // 두 노드가 **같은 스타일**을 물게 해 두고 라이브러리를 다른 창에서 고친다. 재동기가
    // 노드마다 도는 것이 아니라 문서 전체를 한 번에 훑어 **커밋 한 칸**이어야 한다(§3.3).
    const pinkId = pink ? pink.id : null;
    if (!pinkId || !dcdp) {
      r.skip("(51 c)(k) 스타일 편집 전파", pinkId ? "doc 창 없음" : "색 스타일 생성 실패");
    } else {
      await setDoc({
        objects: [
          { id: "a1", kind: "rect", x: 20, y: 20, w: 60, h: 40, fills: [pink.paint], strokes: [], strokeWidth: 0, styleRefs: { fill: pinkId } },
          { id: "b1", kind: "rect", x: 120, y: 20, w: 60, h: 40, fills: [pink.paint], strokes: [], strokeWidth: 0, styleRefs: { fill: pinkId } },
        ],
      });
      const histC = await S(`hist()`);
      const edited = await writeLib(
        (l) => ({
          ...l,
          colorStyles: l.colorStyles.map((s) =>
            s.id === pinkId ? { ...s, paint: solid(BLUE), updatedAt: Date.now() } : s,
          ),
        }),
        (l) => !!l && (l.colorStyles.find((s) => s.id === pinkId) || {}).paint?.color === BLUE,
      );
      await sleep(400);
      await S(`repaint()`);
      const cA = await node("a1");
      const cB = await node("b1");
      const cPxA = await px(50, 40);
      const cPxB = await px(150, 40);
      r.check(
        "(51 k) doc 창에서 고친 라이브러리가 **메인 창까지** 1초 안에 온다(Rust emit + origin 필터 — 폴링도 storage 이벤트도 아니다)",
        edited.ok === true && edited.ms < 2000,
        `${edited.ms}ms 결과=${edited.ok} ${edited.why || ""}`,
      );
      r.check(
        "(51 c-1) 스타일을 고치면 **참조 노드가 전부** 따라 바뀌고 히스토리는 `스타일 갱신` **한 칸**이다(노드마다 한 칸이면 41 의 200칸이 이름 몇 번에 소진된다)",
        !!cA && !!cB &&
          cA.fills[0].color === BLUE && cB.fills[0].color === BLUE &&
          near(cPxA, rgb(BLUE)) && near(cPxB, rgb(BLUE)) &&
          (await S(`hist()`)) === histC + 1 &&
          (await S(`lastLabel()`)) === "스타일 갱신",
        `A=${cA && cA.fills[0].color}/${show(cPxA)} B=${cB && cB.fills[0].color}/${show(cPxB)} 칸=${histC}→${await S(`hist()`)} 라벨=${await S(`lastLabel()`)}`,
      );

      // 노드를 직접 고치면 링크가 끊긴다 — 안 끊기면 다음 재동기가 이 편집을 되돌린다.
      await S(`click(150, 40)`);
      await sleep(200);
      await cdp.eval(
        `window.__gpvLib.ed().actions.patchSelection({ fills: [${J(solid(GREEN))}] }, '채우기 00FF00')`,
      );
      await sleep(300);
      const dA = await node("a1");
      const dB = await node("b1");
      r.check(
        "(51 c-2) 노드의 `fills` 를 직접 고치면 그 슬롯의 링크가 **끊긴다**(STYLE_DETACH_KEYS) — 다른 노드의 링크는 그대로다",
        !!dB && !dB.styleRefs.fill && dB.fills[0].color === GREEN &&
          !!dA && dA.styleRefs.fill === pinkId,
        `B참조=${dB && J(dB.styleRefs)} B색=${dB && dB.fills[0].color} A참조=${dA && J(dA.styleRefs)}`,
      );

      // 삭제 = 라이브러리에서 빼는 것으로 끝. 값은 남고 링크만 풀린다.
      const removed = await writeLib(
        (l) => ({ ...l, colorStyles: l.colorStyles.filter((s) => s.id !== pinkId) }),
        (l) => !!l && !l.colorStyles.some((s) => s.id === pinkId),
      );
      await sleep(400);
      const eA = await node("a1");
      r.check(
        "(51 c-3) 스타일을 지우면 참조만 풀리고 **값은 남는다**(값까지 되돌리면 스타일 하나 삭제가 문서의 색을 날린다)",
        removed.ok === true && !!eA && !eA.styleRefs.fill && eA.fills[0].color === BLUE,
        `참조=${eA && J(eA.styleRefs)} 색=${eA && eA.fills[0].color}`,
      );

      // ── (d-2) 텍스트 스타일도 같은 경로로 노드에 얹힌다 ────────────────────
      if (h1) {
        await setDoc({
          objects: [
            { id: "tx", kind: "text", x: 20, y: 120, text: "가나", fontSize: 12, fontWeight: 400, styleRefs: { text: h1.id } },
          ],
        });
        const bumped = await writeLib(
          (l) => ({
            ...l,
            colorStyles: [
              ...l.colorStyles,
              { id: "e2e-tick", name: "e2e:틱", paint: solid(ORANGE), updatedAt: Date.now() },
            ],
          }),
          (l) => !!l && l.colorStyles.some((s) => s.id === "e2e-tick"),
        );
        await sleep(400);
        const tx = await node("tx");
        r.check(
          "(51 d-2) 텍스트 스타일 참조도 재동기가 타이포 전체를 노드에 복사한다(28 · 700 · 130%) — 렌더는 라이브러리를 읽지 않는다",
          bumped.ok === true && !!tx &&
            tx.fontSize === 28 && tx.fontWeight === 700 && tx.lineHeight === 130 &&
            tx.styleRefs.text === h1.id,
          tx ? `${tx.fontSize}/${tx.fontWeight}/${tx.lineHeight} 참조=${J(tx.styleRefs)}` : "노드 없음",
        );
      }
    }

    // ── (e) 컴포넌트 만들기(Ctrl+Alt+K) ─────────────────────────────────────
    const CHIP = "e2e:범례 칩";
    await S(`clearToasts()`);
    await setDoc({
      objects: [
        { id: "r1", kind: "rect", x: 20, y: 20, w: 60, h: 30, fills: [solid(RED)], strokes: [], strokeWidth: 0 },
        { id: "t1", kind: "text", x: 20, y: 60, text: "칩", fontSize: 12 },
      ],
    });
    await S(`selectAll()`);
    await sleep(200);
    const histE = await S(`hist()`);
    await makeComponent(CHIP);
    const objsE = await objects();
    const inst1 = arr(objsE).find((o) => o.kind === "instance") || null;
    const kidsE = inst1 ? arr(objsE).filter((o) => o.id.startsWith(inst1.id + "/")) : [];
    const libE = (await mainLib()) || {};
    const defChip = arr(libE.components).find((c) => c.name === CHIP) || null;
    await S(`leftTab('에셋')`);
    await sleep(250);
    const cardTitles = await S(`cardTitles()`);
    r.check(
      "(51 e) 선택이 **프레임에 감싸인 마스터 + 그 자리의 인스턴스**가 된다(자식 id 는 `<인스턴스>/<마스터>` 접두 · 썸네일 PNG · 에셋 카드 1)",
      !!inst1 && kidsE.length === 3 && kidsE.filter((o) => o.kind === "frame").length === 1 &&
        !!defChip && defChip.nodes.length === 3 && defChip.nodes[0].kind === "frame" &&
        /^data:image\/png/.test(defChip.thumb || "") &&
        arr(cardTitles).includes(CHIP) &&
        (await S(`lastLabel()`)) === "컴포넌트 만들기" &&
        (await S(`hist()`)) === histE + 1,
      `종류=${J(await S(`kinds()`))} 자식=${kidsE.length} 썸네일=${(defChip && defChip.thumb || "").slice(0, 22)} 카드=${J(cardTitles)}`,
    );

    if (!inst1 || !defChip || !arr(defChip.nodes).some((n) => n.kind === "rect")) {
      r.skip("(51 f)~(j) 인스턴스 케이스", "컴포넌트 생성 실패 — 이후 전제가 성립하지 않는다");
    } else {
      const masterRect = arr(defChip.nodes).find((n) => n.kind === "rect");
      /** 인스턴스의 프레임과 rect 자식 — 좌표·픽셀 단언은 문서에서 읽은 값으로만 한다. */
      const rectOf = async (instId) => {
        const os = await objects();
        return {
          frame: arr(os).find((o) => o.kind === "frame" && o.parentId === instId) || null,
          rect: arr(os).find((o) => o.id === instId + "/" + masterRect.id) || null,
        };
      };
      /**
       * 인스턴스를 고른다. 자식 픽셀을 눌러도 히트는 **최상위 조상**(= 인스턴스)이다(38 기본) —
       * 돌려주는 값이 그 규칙 자체의 단언이다.
       */
      const selectInstance = async (instId) => {
        const g = await rectOf(instId);
        if (!g.rect) return false;
        await S(`click(${Math.round(g.rect.x + 5)}, ${Math.round(g.rect.y + 5)})`);
        await sleep(250);
        return arr(await S(`selIds()`)).includes(instId);
      };
      /** 마스터 자식의 채우기 색 — 없으면 null(구조가 깨져도 단언이 TypeError 로 죽지 않게). */
      const masterFill = (def, id) => {
        const n = def && arr(def.nodes).find((x) => x.id === id);
        return n && arr(n.fills)[0] ? n.fills[0].color : null;
      };

      // ── (f) 배치 — 카드 더블클릭(이미지 중심) · 드래그 드롭(드롭 좌표) ─────
      await S(`placeByCard(${J(CHIP)})`);
      await sleep(300);
      const afterDbl = arr(await objects()).filter((o) => o.kind === "instance");
      const inst2 = afterDbl.find((o) => o.id !== inst1.id) || null;
      await S(`dropCard(${J(CHIP)}, 150, 150)`);
      await sleep(400);
      const afterDrop = arr(await objects()).filter((o) => o.kind === "instance");
      const inst3 = afterDrop.find((o) => o.id !== inst1.id && (!inst2 || o.id !== inst2.id)) || null;

      const g2 = inst2 ? await rectOf(inst2.id) : { frame: null };
      const g3 = inst3 ? await rectOf(inst3.id) : { frame: null };
      const center = (f) => (f ? { x: f.x + f.w / 2, y: f.y + f.h / 2 } : null);
      const c2 = center(g2.frame);
      const c3 = center(g3.frame);
      r.check(
        "(51 f-1) 카드 더블클릭은 **이미지 중심**에, 드롭은 **놓은 자리**에 프레임 중심을 맞춘다(드롭 좌표는 포인터와 같은 `clientToOriented` 산술)",
        !!c2 && Math.abs(c2.x - 100) <= 1 && Math.abs(c2.y - 100) <= 1 &&
          !!c3 && Math.abs(c3.x - 150) <= 1 && Math.abs(c3.y - 150) <= 1,
        `더블클릭=${J(c2)} 드롭=${J(c3)}`,
      );

      await S(`repaint()`);
      const sample = async (instId) => {
        const g = await rectOf(instId);
        if (!g.rect) return null;
        const x = g.rect.x + g.rect.w / 2;
        const y = g.rect.y + g.rect.h / 2;
        return {
          scene: await px(x, y),
          file: await cdp.eval(`window.__gpvLib.renderPx(${x}, ${y})`),
        };
      };
      const s1 = await sample(inst1.id);
      const s2 = inst2 ? await sample(inst2.id) : null;
      const s3 = inst3 ? await sample(inst3.id) : null;
      r.check(
        "(51 f-2) 세 인스턴스가 **같은 그림**을 그리고 내보내기 렌더도 같은 색이다(물질화라 렌더는 인스턴스를 모른다)",
        !!s1 && !!s2 && !!s3 &&
          near(s1.scene, rgb(RED)) && near(s2.scene, rgb(RED)) && near(s3.scene, rgb(RED)) &&
          near(s1.file, rgb(RED)) && near(s2.file, rgb(RED)) && near(s3.file, rgb(RED)),
        `씬=${[s1, s2, s3].map((s) => show(s && s.scene)).join(" ")} 파일=${[s1, s2, s3].map((s) => show(s && s.file)).join(" ")}`,
      );
      const counts0 = await S(`counts()`);
      const assetsText0 = await S(`panelText('assets')`);
      r.check(
        "(51 f-3) 에셋 패널 하단이 문서 전체를 집계한다(⑤ `연결됨 · 재정의됨 · 분리됨`)",
        counts0 && counts0.linked === 3 && counts0.overridden === 0 && counts0.detached === 0 &&
          /3 연결됨/.test(assetsText0),
        `${J(counts0)} 패널=${(assetsText0.match(/\d+ 연결됨[^]*?분리됨/) || [""])[0]}`,
      );

      // ── (g) 재정의 파생 · 마스터 갱신 · 초기화 ──────────────────────────────
      //
      // 자식 편집은 **문서를 고치는 것**으로 구동한다 — 재정의는 훅이 아니라 커밋 시 diff 로
      // 파생되므로(§3.5), 어느 경로로 고쳤는지와 무관하게 같은 결과여야 한다는 것이 계약이다.
      const patchChild = async (instId, masterId, patch) => {
        const os = arr(await objects());
        const cid = instId + "/" + masterId;
        await setDoc({ objects: os.map((o) => (o.id === cid ? { ...o, ...patch } : o)) });
        await sleep(250);
      };
      const masterText = defChip.nodes.find((n) => n.kind === "text") || null;
      await patchChild(inst1.id, masterRect.id, { fills: [solid(GREEN)] });
      const ov1 = await node(inst1.id);
      const counts1 = await S(`counts()`);
      const assetsText1 = await S(`panelText('assets')`);
      r.check(
        "(51 g-1) 자식을 고치면 커밋 시 **재정의가 파생된다**(경로마다 훅을 심지 않는다) — 상태·집계·패널이 같은 판정을 쓴다",
        !!ov1 && Object.keys(ov1.overrides).length === 1 &&
          !!ov1.overrides[inst1.id + "/" + masterRect.id] &&
          (await S(`instState(${J(inst1.id)})`)) === "overridden" &&
          counts1.overridden === 1 && counts1.linked === 2 &&
          /1 재정의됨/.test(assetsText1),
        `재정의=${ov1 && J(Object.keys(ov1.overrides))} 집계=${J(counts1)}`,
      );

      if (!inst2 || !masterText) {
        r.skip("(51 g-2) 마스터 갱신", "두 번째 인스턴스 또는 텍스트 자식 없음");
      } else {
        await patchChild(inst2.id, masterRect.id, { fills: [solid(ORANGE)] });
        await patchChild(inst2.id, masterText.id, { text: "갱신" });
        const picked2 = await selectInstance(inst2.id);
        await cdp.eval(`window.__gpvLib.ed().inspector.setTab('props')`);
        await sleep(200);
        const secText = await S(`tabText('props')`);
        const pushed = await S(`tabBtn('마스터 갱신', 'props')`);
        await sleep(600);
        const os2 = arr(await objects());
        const inst2After = os2.find((o) => o.id === inst2.id) || null;
        const kid1 = os2.find((o) => o.id === inst1.id + "/" + masterRect.id) || null;
        const kid1Text = os2.find((o) => o.id === inst1.id + "/" + masterText.id) || null;
        const kid3 = inst3 ? os2.find((o) => o.id === inst3.id + "/" + masterRect.id) || null : null;
        const libG = (await mainLib()) || {};
        const defG = arr(libG.components).find((c) => c.id === defChip.id) || null;
        r.check(
          "(51 g-2) `이 인스턴스로 마스터 갱신` 이 마스터를 굳히고 다른 인스턴스가 따라오되 — **재정의한 필드는 유지된다**(덮으면 손으로 맞춘 값이 한 번에 날아간다)",
          picked2 === true && pushed === true &&
            !!inst2After && Object.keys(inst2After.overrides).length === 0 &&
            masterFill(defG, masterRect.id) === ORANGE &&
            !!kid1 && kid1.fills[0].color === GREEN &&
            !!kid1Text && kid1Text.text === "갱신" &&
            !!kid3 && kid3.fills[0].color === ORANGE &&
            /재정의됨|연결됨/.test(secText),
          `마스터=${masterFill(defG, masterRect.id)} inst1=${kid1 && kid1.fills[0].color}/${kid1Text && kid1Text.text} inst3=${kid3 && kid3.fills[0].color} inst2재정의=${inst2After && J(Object.keys(inst2After.overrides))}`,
        );

        await selectInstance(inst1.id);
        const resetOk = await S(`tabBtn('재정의 초기화', 'props')`);
        await sleep(500);
        const kid1Reset = arr(await objects()).find((o) => o.id === inst1.id + "/" + masterRect.id) || null;
        const inst1Reset = await node(inst1.id);
        r.check(
          "(51 g-3) `재정의 초기화` 가 마스터 값으로 되돌린다(재정의 0 · 값 일치)",
          resetOk === true && !!kid1Reset && kid1Reset.fills[0].color === ORANGE &&
            !!inst1Reset && Object.keys(inst1Reset.overrides).length === 0 &&
            (await S(`instState(${J(inst1.id)})`)) === "linked",
          `색=${kid1Reset && kid1Reset.fills[0].color} 재정의=${inst1Reset && J(Object.keys(inst1Reset.overrides))}`,
        );
      }

      // ── (i) 이동은 인스턴스 단위 · 자식 삭제는 숨김 ─────────────────────────
      //
      // **자식을 직접 고르는 경로는 아직 없다**(포인터 더블클릭은 텍스트 편집만 하고, 레이어
      // 패널은 인스턴스를 펼치지 않는다 — layer-rows.ts). 그래서 드래그는 인스턴스를 집어
      // 확인한다: 컨테이너는 기하가 없으므로 `moveUnit`+서브트리 분기가 없으면 **아무것도
      // 움직이지 않는다**(조용한 no-op).
      const g1a = await rectOf(inst1.id);
      const pickedForDrag = await selectInstance(inst1.id);
      if (g1a.rect) {
        await S(`drag(${Math.round(g1a.rect.x + 5)}, ${Math.round(g1a.rect.y + 5)}, 20, 10)`);
        await sleep(400);
      }
      const g1b = await rectOf(inst1.id);
      const inst1Moved = await node(inst1.id);
      r.check(
        "(51 i-1) 자식 픽셀을 눌러도 잡히는 것은 **인스턴스**고, 끌면 서브트리 전체가 같은 델타로 움직인다(자식 상대 좌표 불변 · 기하는 재정의로 남지 않는다 — §3.5 INSTANCE_FIXED_KEYS)",
        pickedForDrag === true && !!g1b.frame && !!g1a.frame &&
          Math.abs(g1b.frame.x - (g1a.frame.x + 20)) <= 1 &&
          Math.abs(g1b.frame.y - (g1a.frame.y + 10)) <= 1 &&
          Math.abs((g1b.rect.x - g1b.frame.x) - (g1a.rect.x - g1a.frame.x)) <= 0.01 &&
          !!inst1Moved && Object.keys(inst1Moved.overrides).length === 0,
        `프레임 ${g1a.frame && g1a.frame.x},${g1a.frame && g1a.frame.y} → ${g1b.frame && g1b.frame.x},${g1b.frame && g1b.frame.y} 재정의=${inst1Moved && J(Object.keys(inst1Moved.overrides))}`,
      );

      if (masterText) {
        const cid = inst1.id + "/" + masterText.id;
        const osDel = arr(await objects()).filter((o) => o.id !== cid);
        await setDoc({ objects: osDel });
        await sleep(400);
        const instDel = await node(inst1.id);
        await selectInstance(inst1.id);
        await S(`tabBtn('재정의 초기화', 'props')`);
        await sleep(500);
        const back = await node(cid);
        r.check(
          "(51 i-2) 인스턴스 **안**에서 지운 자식은 사라지는 게 아니라 숨는다(`{visible:false}` 재정의) — 초기화하면 돌아온다(Figma 동일)",
          !!instDel && instDel.overrides[cid] && instDel.overrides[cid].visible === false && !!back,
          `재정의=${instDel && J(instDel.overrides[cid])} 복귀=${!!back}`,
        );
      }

      // ── (j) 이미지 90° 회전 = 인스턴스 분리 + 알림 ──────────────────────────
      await S(`clearToasts()`);
      // 연결/재정의를 가리지 않는다 — 회전은 **전부** 분리한다. `linked` 만 세면 재정의된
      // 인스턴스 하나 때문에 정상 동작이 회귀로 읽힌다.
      const beforeRot = arr(await objects()).filter((o) => o.kind === "instance").length;
      await cdp.eval(`window.__gpvLib.ed().actions.rotateImage(true)`);
      await sleep(600);
      const rotKinds = await S(`kinds()`);
      const rotToasts = await S(`toasts()`);
      const rotGroups = arr(await objects()).filter((o) => o.kind === "group" && o.detachedFrom);
      await S(`fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
      await sleep(600);
      const backKinds = await S(`kinds()`);
      r.check(
        "(51 j) 이미지 90° 회전은 인스턴스를 **분리하고 그 사실을 알린다**(축정렬 사각형이 미러·180° 를 잃어 프레임이 방향을 못 든다) — 되돌리기 한 칸에 인스턴스가 돌아온다",
        !arr(rotKinds).includes("instance") &&
          rotGroups.length === beforeRot &&
          arr(rotToasts).some((t) => /회전으로 인스턴스 \d+개를 분리했습니다/.test(t)) &&
          arr(backKinds).filter((k) => k === "instance").length === beforeRot,
        `회전 뒤=${J(rotKinds)} 토스트=${J(rotToasts)} undo 뒤 인스턴스=${arr(backKinds).filter((k) => k === "instance").length}`,
      );

      // ── (h) 분리(Ctrl+Alt+B) · 마스터 삭제 → 자동 분리 ──────────────────────
      const live = arr(await objects()).filter((o) => o.kind === "instance");
      if (live.length) {
        const target = live[0];
        await selectInstance(target.id);
        await S(`fire({ key:'b', code:'KeyB', ctrlKey:true, altKey:true })`);
        await sleep(500);
        const det = await node(target.id);
        const countsH = await S(`counts()`);
        r.check(
          "(51 h-1) `Ctrl+Alt+B` 분리는 보통 그룹으로 바꾸고 출처만 남긴다(값·모양은 그대로, 마스터와의 연결만 끊긴다)",
          !!det && det.kind === "group" && det.detachedFrom === defChip.id &&
            (await S(`instState(${J(target.id)})`)) === "detached" &&
            countsH.detached >= 1,
          `종류=${det && det.kind} 출처=${det && det.detachedFrom} 집계=${J(countsH)}`,
        );
      }
      await S(`clearToasts()`);
      if (!dcdp) {
        r.skip("(51 h-2) 마스터 삭제 → 자동 분리", "doc 창 없음 — 라이브러리를 고칠 통로가 없다");
      } else {
        const stillLinked = arr(await objects()).filter((o) => o.kind === "instance").length;
        const gone = await writeLib(
          (l) => ({ ...l, components: l.components.filter((c) => c.id !== defChip.id) }),
          (l) => !!l && !l.components.some((c) => c.id === defChip.id),
        );
        await sleep(600);
        const afterGone = arr(await objects()).filter((o) => o.kind === "instance").length;
        const goneToasts = await S(`toasts()`);
        r.check(
          "(51 h-2) 마스터가 라이브러리에서 사라지면 남은 인스턴스가 **자동으로 분리되고 그 이유를 말한다**(조용히 끊으면 며칠 뒤 원인을 못 찾는다)",
          gone.ok === true && stillLinked > 0 && afterGone === 0 &&
            arr(goneToasts).some((t) => /라이브러리에 없어 인스턴스 \d+개를 분리했습니다/.test(t)),
          `인스턴스 ${stillLinked}→${afterGone} 토스트=${J(goneToasts)}`,
        );
      }

      // ── 저장본 — 화면이 곧 파일인가(인스턴스는 물질화라 렌더가 모른다) ──────
      //
      // 기대 색을 리터럴로 적지 않는다: 여기까지 오는 동안 마스터 갱신·초기화·분리를 거쳐
      // 그 사각형의 색이 여러 번 바뀌었다. **문서가 지금 들고 있는 값**과 파일을 맞대야
      // "화면 == 파일"을 재는 것이지, 리터럴을 쓰면 앞 케이스의 결과를 다시 재게 된다.
      const probe = arr(await objects()).find((o) => o.kind === "rect" && o.parentId) || null;
      const probeColor = probe && arr(probe.fills)[0] ? probe.fills[0].color : null;
      const saveRes = await S(`saveAs(${J(OUT)})`);
      const closed = await poll(
        () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
        (v) => v === null,
        30,
        200,
      );
      let savedPx = null;
      if (probe && probeColor) {
        savedPx = await cdp
          .eval(
            `window.__gpvLib.readSaved(${J(fix.projectId)}, ${J(OUT)}, [[${Math.round(probe.x + probe.w / 2)}, ${Math.round(probe.y + probe.h / 2)}]])`,
          )
          .catch(() => null);
      }
      r.check(
        "(51 f-4) 저장본에도 그 그림이 그대로 있다 — **편집기가 닫혔는지**로 이번 저장분임을 못 박는다(앞 케이스가 남긴 파일을 읽으면 거짓 통과다)",
        saveRes && saveRes.ok === true && closed === null &&
          !!savedPx && savedPx.w === 200 && savedPx.h === 200 &&
          !!probeColor && near(savedPx.px[0], rgb(probeColor), 20),
        `저장=${J(saveRes)} 닫힘=${closed} 크기=${savedPx && savedPx.w + "×" + savedPx.h} 문서=${probeColor} 파일=${savedPx && show(savedPx.px[0])}`,
      );
      const leftover = await cdp.eval(
        `(() => { const st = window.__gpv.ui.getState(); return { prompt: !!st.prompt, confirm: !!st.confirm }; })()`,
      );
      r.check(
        "(51 f-5) 저장 뒤 프롬프트·확인창이 남지 않는다(남으면 `useEditorKeys` 게이트가 다음 스위트의 편집기 키를 통째로 통과시킨다)",
        leftover && leftover.prompt === false && leftover.confirm === false,
        J(leftover),
      );
    }

    // ── (m) 사이드카 왕복 — 인스턴스·재정의·참조가 살아 돌아온다 ─────────────
    if (!r.check("(51 m) 재오픈", (await openEditor()) === true)) return;
    const libM = (await mainLib()) || {};
    const anyStyle = arr(libM.colorStyles)[0] || null;
    await setDoc({
      objects: [
        {
          id: "m1", kind: "rect", x: 30, y: 30, w: 50, h: 40,
          fills: [anyStyle ? anyStyle.paint : solid(RED)], strokes: [], strokeWidth: 0,
          ...(anyStyle ? { styleRefs: { fill: anyStyle.id } } : {}),
        },
      ],
    });
    await S(`selectAll()`);
    await sleep(200);
    const histM = await S(`hist()`);
    await makeComponent("e2e:왕복");
    const osM = arr(await objects());
    const instM = osM.find((o) => o.kind === "instance") || null;
    if (!instM) {
      r.skip("(51 m) 사이드카 왕복", "컴포넌트 생성 실패");
    } else {
      const defM = arr(((await mainLib()) || {}).components).find((c) => c.name === "e2e:왕복") || null;
      const rectM = defM ? arr(defM.nodes).find((n) => n.kind === "rect") : null;
      if (rectM) {
        const cid = instM.id + "/" + rectM.id;
        await setDoc({
          objects: arr(await objects()).map((o) => (o.id === cid ? { ...o, opacity: 0.5 } : o)),
        });
        await sleep(300);
      }
      await cdp.eval(`window.__gpvLib.ed().history.flush()`);
      await sleep(1400);
      const back = await cdp
        .eval(
          `(async () => {
             const res = await window.__gpv.imageDocs.read(${J(fix.projectId)}, ${J(SRC)});
             if (!res || !res.json) return null;
             const doc = window.__gpvLib.ed().schema.parse(res.json).env.doc;
             const inst = doc.objects.find((o) => o.kind === 'instance');
             return {
               same: window.__gpvLib.key(doc) === window.__gpvLib.key(window.__gpvLib.doc()),
               inst: inst ? { componentId: inst.componentId, overrides: Object.keys(inst.overrides).length } : null,
               refs: doc.objects.map((o) => o.styleRefs.fill || null).filter(Boolean).length,
             };
           })()`,
        )
        .catch(() => null);
      // 커밋은 둘이다(컴포넌트 만들기 · 자식 편집) — 한 칸만 되돌리면 인스턴스가 남아 있어
      // "되돌려도 안 사라진다"를 못 잡는다.
      for (let i = 0; i < (rectM ? 2 : 1); i++) {
        await S(`fire({ key:'z', code:'KeyZ', ctrlKey:true })`);
        await sleep(400);
      }
      const undone = await S(`kinds()`);
      r.check(
        "(51 m) 사이드카 왕복이 인스턴스·재정의·`styleRefs` 를 그대로 되살리고, 되돌리기는 컴포넌트 생성 **이전**(원본 노드 하나)으로 정확히 돌아간다",
        !!back && back.same === true && !!back.inst && back.inst.overrides >= 1 &&
          (!anyStyle || back.refs >= 1) &&
          J(undone) === J(["rect"]),
        `${J(back)} undo 뒤=${J(undone)} 칸=${histM}→${await S(`hist()`)}`,
      );
    }

    // ── (n) 8MB 상한 ────────────────────────────────────────────────────────
    //
    // 문자열을 **페이지 안에서** 만든다. Node 에서 만들어 넘기면 8MB 표현식이 CDP 를 통째로 탄다.
    await sleep(800);
    const beforeBig = await cdp.try("image_library_get");
    const big = await cdp.eval(
      `(async () => {
         try {
           await window.__TAURI_INTERNALS__.invoke('image_library_set', {
             json: '"' + 'x'.repeat(8 * 1024 * 1024) + '"',
           });
           return { ok: true };
         } catch (e) {
           return { ok: false, code: (e && e.code) || null, message: ((e && e.message) || '').slice(0, 60) };
         }
       })()`,
      { timeoutMs: 120000 },
    );
    const afterBig = await cdp.try("image_library_get");
    const sameFile =
      beforeBig.ok && afterBig.ok && typeof afterBig.r === "string" && beforeBig.r === afterBig.r;
    r.check(
      "(51 n) 8MB 를 넘는 저장은 **파일에 닿기 전에** 거절되고 마지막 성공본이 남는다(통과시키면 다음 로드가 손상으로 보고 라이브러리를 통째로 격리한다)",
      big && big.ok === false && big.code === "IO" && sameFile,
      `${J(big)} 파일 보존=${sameFile}`,
    );
  } finally {
    // ── 정리: 라이브러리 원복 → doc 창 → 편집기 → 픽스처 ─────────────────────
    //
    // 라이브러리는 **doc 창에서** 되돌린다. 메인에서 쓰면 파일만 바뀌고 메인 스토어에는 e2e
    // 잔해가 남아, 사용자가 다음에 스타일을 하나 만드는 순간 그 잔해까지 함께 저장된다.
    // (doc 창이 없어 그 경로로 떨어졌더라도 다음 실행 시작의 `e2e:` 정리가 받아 낸다.)
    if (baseLib) {
      const writer = dcdp || cdp;
      await writer
        .try("image_library_set", { json: JSON.stringify(baseLib) }, { timeoutMs: 30000 })
        .catch(() => null);
      await sleep(500);
    }
    if (dcdp) dcdp.close();
    if (docLabel) {
      await cdp
        .eval(
          `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${J(docLabel)}) await w.close(); } return true; }catch(e){ return false; } })()`,
        )
        .catch(() => {});
      // 닫힌 doc 창이 localStorage(`gp:doc-windows`)에 남긴 대상 기록 제거(34 와 같은 규칙).
      await cdp
        .eval(
          `(()=>{ try{ const k='gp:doc-windows'; const v=JSON.parse(localStorage.getItem(k)||'{}');
             delete v[${J(docLabel.slice("doc-".length))}]; localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } })()`,
        )
        .catch(() => {});
    }
    if (snap0 !== null) {
      await cdp
        .eval(`window.__gpv.imageEditor && window.__gpv.imageEditor.setToggle('snap', ${J(snap0)})`)
        .catch(() => {});
    }
    await cdp
      .eval(
        `(() => { const st = window.__gpv.ui.getState(); if (st.prompt) st.closePrompt(); if (st.confirm) st.closeConfirm(); st.toasts.slice().forEach((t) => st.dismissToast(t.id)); return true; })()`,
      )
      .catch(() => {});
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
