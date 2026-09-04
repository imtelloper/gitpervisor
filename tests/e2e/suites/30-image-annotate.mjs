// 이미지 주석(마크업) e2e — 설계 DOCS/image-annotation-design.md §9.4 "픽셀 단언" 전략 구현.
//
// 스크린샷 비교는 폰트·GPU·DPI에 따라 흔들려 취약하다. 대신 **결정적 픽셀 단언**을 쓴다:
//   ① 픽스처 레포에 알려진 단색 PNG(200×200 흰색)를 만든다
//   ② __gpv.imageEditor 로 편집기를 열고 객체를 직접 주입한다(DEV 전용 훅)
//   ③ 프리뷰 주석 캔버스의 특정 좌표를 샘플링해 기대색을 단언한다
//   ④ 저장 → read_file_base64 로 다시 읽어 디코드 → 같은 좌표를 단언한다
//   ⑤ ③ == ④  ⇒ WYSIWYG 계약(§4.1 단일 renderScene) 통과
//
// 좌표 주의: 픽스처가 200px라 프리뷰 배율 s=min(1,1800/200)=1 이므로
// **oriented px == 백킹 px == 파일 px** 이다. 그래서 좌표 변환 없이 같은 숫자로 단언할 수 있다.
//
// 클립보드 복사(§6.2)는 CDP로 검증할 수 없어 여기서 다루지 않는다(수동 체크리스트).
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { git } from "../lib/git-fixture.mjs";

export const name =
  "이미지 주석 (WYSIWYG 픽셀 / D2 색보정 / 회전·크롭·리사이즈 좌표 / D1 임베디드 라우팅 / 뱃지 · undo)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

const RED = [255, 59, 48]; // DEFAULT_STROKE (#FF3B30)
const RED_HEX = "#FF3B30";
const BLUE = [10, 132, 255]; // 팔레트 파랑 (#0A84FF)

/** 페이지에 설치하는 헬퍼 묶음 — 모달 탐색·픽셀 샘플·저장 다이얼로그 구동·합성 포인터. */
const HELPERS = `(() => {
  const A = {};

  // 이미지 편집기 모달(확인·프롬프트 다이얼로그와 섞이지 않게 헤더 문구로 가른다).
  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50'))
      .find((el) => /이미지 편집/.test(el.textContent || '')) || null;

  // [0] = 베이스(이미지, CSS 필터), [1] = 주석 오버레이(§4.3)
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

  /** 백킹 px 좌표의 픽셀 [r,g,b,a]. i=0 베이스, i=1 주석. */
  A.px = (i, x, y) => {
    const c = A.canvases()[i];
    if (!c) return null;
    const d = c.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };

  /** rAF 두 번 — 레이어가 코얼레싱한 페인트가 실제로 끝난 뒤를 보장한다(§4.4). */
  A.frame = () =>
    new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  A.btn = (re) => {
    const m = A.modal();
    if (!m) return null;
    return (
      Array.from(m.querySelectorAll('button')).find((b) =>
        re.test((b.textContent || '') + ' ' + (b.title || '')),
      ) || null
    );
  };
  A.click = (re) => {
    const b = A.btn(re);
    if (!b) return false;
    b.click();
    return true;
  };

  /** 객체를 주입하고 다음 페인트까지 기다린다. */
  A.setDoc = async (patch) => {
    window.__gpv.imageEditor.setDoc(patch);
    await A.frame();
    window.__gpv.imageEditor.renderOnce();
    await A.frame();
    return true;
  };

  /** 문서를 건드리지 않고 다시 그리기만 한다(빈 setDoc 은 히스토리를 한 칸 더 쌓는다). */
  A.repaint = async () => {
    window.__gpv.imageEditor.renderOnce();
    await A.frame();
    return true;
  };

  /** 편집기가 **이 파일로 새로 초기화**됐는가 — 재개 시 이전 문서를 보고 통과하는 것을 막는다. */
  A.fresh = () => {
    if (!A.ready()) return false;
    const d = window.__gpv.imageEditor.getDoc();
    return (
      d.objects.length === 0 &&
      d.rotation === 0 &&
      d.crop === null &&
      d.brightness === 100 &&
      !d.flipH &&
      !d.flipV
    );
  };

  /** 단색 PNG base64 — 픽스처 이미지를 만들 때 쓴다(외부 인코더 불필요). */
  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /**
   * 좌우 2색 PNG base64 — **배경색이 결과를 좌우하는** 케이스용 픽스처.
   * 단색 흰 배경에서는 multiply 와 단순 알파 합성이 수치적으로 같아져(흰색 × C = C) 형광펜
   * 블렌드 결함이 드러나지 않는다. 검은 절반이 있어야 둘이 갈린다.
   */
  A.halfPng = (w, h, leftCss, rightCss) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = leftCss;
    x.fillRect(0, 0, Math.floor(w / 2), h);
    x.fillStyle = rightCss;
    x.fillRect(Math.floor(w / 2), 0, w - Math.floor(w / 2), h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /**
   * 세로 줄무늬 PNG. 가리기(모자이크/블러) 검증용 고주파 프로브다 — 균일 픽스처는
   * "가림이 안 걸렸다"와 "제대로 걸렸다"를 구분하지 못한다.
   * alpha 는 **이미지 전체**의 균일 알파(255=불투명). 반투명이면 알파 있는 원본 위 합성
   * 누수 프로브가 된다 — 줄마다 알파를 다르게 주면 셀 앨리어싱과 뒤섞여 못 쓴다.
   */
  A.stripePng = (w, h, period, alpha) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.globalAlpha = (alpha == null ? 255 : alpha) / 255;
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#000000';
    for (let i = 0; i < w; i += period * 2) x.fillRect(i, 0, period, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  /**
   * 한 행에서 **인접 픽셀 최대 급변**(채널 ch: 0=R, 3=alpha)과 알파 최소값.
   * 가림이 온전하면 결과는 매끄러워 급변이 없다 — 원본의 줄무늬가 조금이라도 살아남으면
   * 그 주기만큼 큰 델타가 남는다. "전체가 균일한가"로 재면 안 된다: 가장자리 복제 패딩은
   * 정상 동작에서도 완만한 그라디언트를 만든다.
   */
  A.maxAdjDelta = (ctx, y, x0, x1, ch) => {
    const n = Math.max(0, x1 - x0);
    if (n < 2) return { d: -1, at: -1, minA: -1 };
    const d = ctx.getImageData(x0, y, n, 1).data;
    const k = ch || 0;
    let max = 0, at = -1, minA = 255;
    for (let i = 0; i < n; i++) {
      if (d[i * 4 + 3] < minA) minA = d[i * 4 + 3];
      if (i === 0) continue;
      const v = Math.abs(d[i * 4 + k] - d[(i - 1) * 4 + k]);
      if (v > max) { max = v; at = x0 + i; }
    }
    return { d: max, at: at, minA: minA };
  };

  /** 저장 파일에서 인접 급변을 잰다. */
  A.savedAdjDelta = async (projectId, relPath, y, x0, x1, ch) => {
    const ctx = await A.decodeSaved(projectId, relPath);
    return A.maxAdjDelta(ctx, y, x0, x1, ch);
  };

  /** 프리뷰 오버레이에서 인접 급변을 잰다. */
  A.previewAdjDelta = (y, x0, x1, ch) => {
    const c = A.canvases()[1];
    return c ? A.maxAdjDelta(c.getContext('2d'), y, x0, x1, ch) : null;
  };

  /** 저장 파일을 디코드해 2D 컨텍스트로 돌려준다(같은 파일을 여러 방식으로 훑을 때 재사용). */
  A.decodeSaved = async (projectId, relPath) => {
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
    return ctx;
  };

  /**
   * 한 행에서 "검정도 흰색도 아닌" 픽셀의 구간 [min,max] 과 개수.
   * 2색 픽스처 위 모자이크는 흑/백 셀만 만들되 **경계를 걸친 셀 하나만 회색**이 된다 —
   * 그 회색 구간의 좌표가 곧 셀 격자의 위치다(배율이 달라도 같은 oriented 좌표여야 한다).
   */
  A.midRunOf = (ctx, y, x0, x1) => {
    const n = Math.max(0, x1 - x0);
    if (!n) return { min: -1, max: -1, n: 0 };
    const d = ctx.getImageData(x0, y, n, 1).data;
    let min = -1;
    let max = -1;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const mid =
        d[o + 3] > 200 &&
        d[o] > 60 && d[o] < 195 &&
        d[o + 1] > 60 && d[o + 1] < 195 &&
        d[o + 2] > 60 && d[o + 2] < 195;
      if (!mid) continue;
      if (min < 0) min = x0 + i;
      max = x0 + i;
      cnt++;
    }
    return { min: min, max: max, n: cnt };
  };

  /** 프리뷰 주석 캔버스(백킹 px)의 중간톤 구간. */
  A.previewMidRun = (y, x0, x1) => {
    const c = A.canvases()[1];
    return c ? A.midRunOf(c.getContext('2d'), y, x0, x1) : null;
  };

  /** 저장 파일(파일 px)의 중간톤 구간. */
  A.savedMidRun = async (projectId, relPath, y, x0, x1) => {
    const ctx = await A.decodeSaved(projectId, relPath);
    return A.midRunOf(ctx, y, x0, x1);
  };

  /**
   * 저장된 파일을 다시 읽어 디코드하고 좌표를 샘플링한다(④단계).
   * color 를 주면 그 색 픽셀의 개수·바운딩 박스도 함께 돌려준다(클리핑·두께 검증용).
   */
  A.readSaved = async (projectId, relPath, points, color, tol) => {
    const ctx = await A.decodeSaved(projectId, relPath);
    const c = ctx.canvas;
    const out = { w: c.width, h: c.height, px: [] };
    for (const p of points || []) {
      const d = ctx.getImageData(p[0], p[1], 1, 1).data;
      out.px.push([d[0], d[1], d[2], d[3]]);
    }
    if (color) {
      const t = tol == null ? 3 : tol;
      const all = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const o = (y * c.width + x) * 4;
          if (
            Math.abs(all[o] - color[0]) <= t &&
            Math.abs(all[o + 1] - color[1]) <= t &&
            Math.abs(all[o + 2] - color[2]) <= t &&
            all[o + 3] > 200
          ) {
            n++;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      out.match = { n: n, minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }
    return out;
  };

  /**
   * '다른 이름으로' 저장을 구동한다. 프롬프트의 기본값(§6.1 '-annotated')을 함께 돌려준다.
   * 다이얼로그 DOM 대신 스토어 요청 객체를 직접 확정해 입력 타이밍 흔들림을 없앤다.
   */
  A.saveAs = async (fileName) => {
    if (!A.click(/다른 이름으로/)) return { ok: false, why: 'button' };
    await sleepMs(80);
    const st = window.__gpv.ui.getState();
    const req = st.prompt;
    if (!req) return { ok: false, why: 'prompt' };
    const def = req.defaultValue || '';
    st.closePrompt();
    req.onConfirm(fileName);
    return { ok: true, defaultValue: def };
  };

  /**
   * 합성 포인터 시퀀스(백킹 px 좌표). steps 는 ['down'|'move'|'up', x, y] 또는 ['esc'].
   *
   * Esc 를 시퀀스 안에 섞을 수 있게 한 이유: "드래그가 진행 중인 동안" Esc 를 눌러야
   * 계층 3(진행 중 제스처 취소)이 재현된다. 시퀀스 밖에서 쏘면 포인터 캡처 무해화가 이미
   * 풀려 뒤따르는 pointerup 이 핸들러 안에서 예외로 죽는다.
   *
   * 실제 포인터가 없으면 setPointerCapture 가 NotFoundError 를 던져 핸들러가 통째로
   * 중단되므로 시퀀스 전체 동안 무해화한다.
   *
   * move 뒤에는 프레임을 기다리지 않는다 — 포인터 핸들러는 동기라 상태는 이미 반영됐고,
   * 데시메이션 검증처럼 수십~수백 점을 흘리는 궤적에서 프레임마다 쉬면 수 초가 걸린다.
   */
  A.pointerSeq = async (steps, opts) => {
    const P = Element.prototype;
    const o = {
      s: P.setPointerCapture,
      r: P.releasePointerCapture,
      h: P.hasPointerCapture,
    };
    P.setPointerCapture = function () {};
    P.releasePointerCapture = function () {};
    P.hasPointerCapture = function () { return false; };
    try {
      const c = A.canvases()[1];
      if (!c) return false;
      const shift = !!(opts && opts.shift);
      // 한 제스처는 pointerId 하나 — 실제 마우스와 같다.
      const id = 1000;
      for (const st of steps) {
        if (st[0] === 'esc') {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
            }),
          );
          await A.frame();
          continue;
        }
        const rect = c.getBoundingClientRect();
        const cx = rect.left + (st[1] / c.width) * rect.width;
        const cy = rect.top + (st[2] / c.height) * rect.height;
        c.dispatchEvent(
          new PointerEvent('pointer' + st[0], {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: st[0] === 'up' ? 0 : 1,
            shiftKey: shift,
            pointerId: id,
            pointerType: 'mouse',
            isPrimary: true,
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

  /** 드래그 없는 호버(백킹 px). buttons=0 이라 포인터 핸들러의 드래그 분기를 타지 않는다. */
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
        pointerId: 1002, pointerType: 'mouse', isPrimary: true,
      }),
    );
    await A.frame();
    return true;
  };

  /** 주석 캔버스의 인라인 커서(빈 문자열이면 className 의 Tailwind 커서가 산다). */
  A.cursor = () => {
    const c = A.canvases()[1];
    return c ? c.style.cursor : null;
  };

  /** window 에 keydown 하나. 편집기 단축키는 전부 window 리스너다. */
  A.key = async (key, opts) => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true,
        shiftKey: !!(opts && opts.shift),
        repeat: !!(opts && opts.repeat),
      }),
    );
    await A.frame();
    return true;
  };

  /** 복구 배너가 떠 있는가(§P4). */
  A.banner = () => {
    const m = A.modal();
    return !!(m && /직전에 저장하지 않고 닫은 편집/.test(m.textContent || ''));
  };

  /** 합성 포인터 클릭(백킹 px 좌표) — 점마다 down/up 한 쌍. */
  A.clickCanvas = (pts) => {
    const steps = [];
    for (const p of pts) steps.push(['down', p[0], p[1]], ['up', p[0], p[1]]);
    return A.pointerSeq(steps);
  };

  /** 편집기 Esc 계층을 구동한다(모달의 window 리스너가 받는다, §5.4). */
  A.esc = async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await sleepMs(180);
    await A.frame();
    return true;
  };

  // ── 훅이 노출하지 않는 UI 상태를 DOM 에서 읽는다 ────────────────────────────
  // __gpv.imageEditor 는 문서(getDoc)만 노출한다. tool·selectedIds·cropMode 는 문서 밖
  // 상태라 화면 표시를 근거로 읽는다 — 사용자가 실제로 보는 것과 같은 값이라 오히려 낫다.

  /** 활성 도구 id — 툴바 버튼의 강조 클래스(text-accent)로 판별한다. */
  A.activeTool = () => {
    const m = A.modal();
    if (!m) return null;
    const byKey = {
      V: 'select', P: 'pen', H: 'highlight', L: 'line', A: 'arrow',
      R: 'rect', O: 'ellipse', T: 'text', N: 'badge', M: 'mosaic',
    };
    for (const b of Array.from(m.querySelectorAll('button'))) {
      // 도구 버튼만 '<라벨> (<단축키 한 글자>)' 형태의 title 을 갖는다.
      // 역슬래시는 두 번 쓴다 — 이 블록은 템플릿 리터럴이라 \\( 라야 페이지에 \( 로 실린다.
      const hit = /\\(([A-Z])\\)$/.exec((b.getAttribute('title') || '').trim());
      if (!hit || !byKey[hit[1]]) continue;
      if (/text-accent/.test(b.className)) return byKey[hit[1]];
    }
    return null;
  };

  /**
   * 선택된 객체 수 — 툴바 아래 안내 문구("N개 선택 — …")에서 읽는다.
   *
   * 모달 전체 textContent 에 걸면 안 된다: 바로 앞 PropSlider 의 값 span("100")과 이 문구
   * 사이에 공백 노드가 없어 "1001개 선택"으로 읽힌다. 문구를 직접 담은 **가장 안쪽** 요소를
   * 찾아 문자열 첫머리에 앵커해 매칭한다(제품 코드에 testid 를 심지 않는다).
   */
  A.selCount = () => {
    const m = A.modal();
    if (!m) return -1;
    const re = /^\\s*(\\d+)개 선택/;
    let hit = null;
    // querySelectorAll 은 문서 순서(조상 → 자손)라 마지막 매치가 가장 안쪽 요소다.
    for (const el of Array.from(m.querySelectorAll('*'))) {
      if (re.test(el.textContent || '')) hit = el;
    }
    return hit ? Number(re.exec(hit.textContent)[1]) : 0;
  };

  /** 크롭 모드 켜짐 — 버튼 라벨이 '크롭 선택' → '영역을 드래그'로 바뀐다. */
  A.cropOn = () => !!A.btn(/영역을 드래그/);

  /** 텍스트 편집 textarea 가 떠 있는가(§5.5). */
  A.hasTextarea = () => {
    const m = A.modal();
    return !!(m && m.querySelector('textarea'));
  };

  /**
   * 편집 중인 textarea 에 값을 넣는다. React 제어 컴포넌트라 ta.value 직접 대입은 무시되므로
   * 네이티브 setter 로 넣고 input 이벤트를 쏜다.
   */
  A.typeText = async (v) => {
    const m = A.modal();
    const ta = m && m.querySelector('textarea');
    if (!ta) return false;
    const set = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    ).set;
    set.call(ta, v);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await A.frame();
    return true;
  };

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  window.__gpvAnno = A;
  return true;
})()`;

/** 색 근사 비교(인코딩 라운딩 여유). */
const near = (px, rgb, tol = 3) =>
  Array.isArray(px) &&
  Math.abs(px[0] - rgb[0]) <= tol &&
  Math.abs(px[1] - rgb[1]) <= tol &&
  Math.abs(px[2] - rgb[2]) <= tol &&
  px[3] > 200;

const isWhite = (px) => near(px, [255, 255, 255], 4);
const show = (px) => (Array.isArray(px) ? `rgba(${px.join(",")})` : String(px));

/** 채움 사각형 객체(테두리 없음 — 픽셀 개수가 정확히 w×h가 되게). */
const rectObj = (id, x, y, w, h, color) => ({
  id,
  kind: "rect",
  stroke: color,
  strokeWidth: 0,
  opacity: 1,
  rot: 0,
  x,
  y,
  w,
  h,
  fill: color,
  radius: 0,
});

/** 형광펜 획. opacity 는 HIGHLIGHT_OPACITY(0.35) 고정 — 툴바가 노출하지 않는 값이다(§5.2). */
const hlObj = (id, pts, color, width) => ({
  id,
  kind: "highlight",
  stroke: color,
  strokeWidth: width,
  opacity: 0.35,
  rot: 0,
  pts,
});

/** 모자이크 영역(pixelate). strength 는 셀 크기(oriented px). */
const mosaicObj = (id, x, y, w, h, strength) => ({
  id,
  kind: "mosaic",
  stroke: "#000000",
  strokeWidth: 0,
  opacity: 1,
  rot: 0,
  x,
  y,
  w,
  h,
  mode: "pixelate",
  strength,
});

/** 블러 영역. strength 는 블러 반경(oriented px). */
const blurObj = (id, x, y, w, h, strength) => ({
  ...mosaicObj(id, x, y, w, h, strength),
  mode: "blur",
});

/** 회전된 사각형. rot 은 앵커(중심) 기준 도(度). */
const rotRectObj = (id, x, y, w, h, color, rot) => ({
  ...rectObj(id, x, y, w, h, color),
  rot,
});

const YELLOW = "#FFCC00"; // 팔레트 노랑 — 형광펜 관례색

// 형광펜 픽셀 기댓값. multiply + globalAlpha 0.35 의 결과는 배경 bg 에 대해
//   out = bg · (0.65 + 0.35 · color/255)   (채널별)
// 이다. #FFCC00 → color/255 = (1, 0.8, 0) 이므로 계수는 (1.0, 0.93, 0.65).
const HL_MUL = [1.0, 0.93, 0.65];
const hlOver = (bg, times = 1) =>
  HL_MUL.map((k, i) => Math.round(bg[i] * Math.pow(k, times)));

const WHITE_BG = [255, 255, 255];
/** 흰 배경 위 획 하나 → (255, 237, 166). */
const HL_ON_WHITE = hlOver(WHITE_BG, 1);
/** 흰 배경 위 두 획이 겹친 교차점 → (255, 220, 108). */
const HL_CROSS_WHITE = hlOver(WHITE_BG, 2);
/** 검은 배경 위 → 몇 겹을 칠해도 (0,0,0). multiply 의 정의상 0 은 0으로 남는다. */
const HL_ON_BLACK = [0, 0, 0];

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 주석", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const poll = async (fn, ok, tries = 40, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  const SRC = "e2e-anno-src.png";
  /** 좌반(x<100) 검정 / 우반 흰색 — 배경 의존 블렌드(형광펜)와 모자이크 셀 격자용. */
  const TWO = "e2e-anno-two.png";
  /** 4px 주기 흑백 세로줄 — 가리기가 원본을 실제로 없앴는지 재는 고주파 프로브. */
  const STRIPE = "e2e-anno-stripe.png";
  /** 같은 줄무늬인데 전체가 **균일 반투명** — 알파 있는 원본에서의 합성 누수 프로브. */
  const STRIPE_A = "e2e-anno-stripe-a.png";
  const EMB = "embedded";
  const created = [SRC, TWO, STRIPE, STRIPE_A];
  let embMade = false;

  const closeEditor = () =>
    cdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});
  const getDoc = () => cdp.eval(`window.__gpv.imageEditor.getDoc()`);
  const annoPx = (x, y) => cdp.eval(`window.__gpvAnno.px(1, ${x}, ${y})`);
  const setDoc = (patch) =>
    cdp.eval(`window.__gpvAnno.setDoc(${J(patch)})`);

  /**
   * 편집기를 (다시) 연다. 같은 경로를 재개할 때 편집기는 이전 세션의 문서를 잠깐 그대로
   * 들고 있다가 새 이미지 로드가 끝나야 초기화한다 — 그 창을 지나치면 이전 케이스의 객체가
   * 남은 채로 단언하게 되므로, "초기화된 문서"가 보일 때까지 기다린다.
   */
  const openEditor = async (repoId, p) => {
    await closeEditor();
    await sleep(200);
    await cdp.eval(
      `window.__gpv.ui.getState().openImageEditor(${J(p)}, ${J(repoId)})`,
    );
    await sleep(250);
    const ok = await poll(
      () => cdp.eval(`window.__gpvAnno.fresh()`).catch(() => false),
      (v) => v === true,
      40,
      250,
    );
    return ok === true;
  };

  /** 저장 → 편집기 자동 닫힘 + 디스크 반영을 함께 확인한다. */
  const saveAs = async (fileName, diskRel) => {
    const res = await cdp.eval(`window.__gpvAnno.saveAs(${J(fileName)})`);
    if (!res || !res.ok) return { ok: false, why: res ? res.why : "eval" };
    const closed = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
      (v) => v === null,
      40,
      250,
    );
    const onDisk = await poll(
      async () => existsSync(join(fix.repo, diskRel)),
      (v) => v === true,
      20,
      200,
    );
    // res 를 먼저 펼친다 — 뒤에 두면 res.ok(=다이얼로그 구동 성공)가 최종 판정을 덮어쓴다.
    return { ...res, ok: closed === null && onDisk === true, closed, onDisk };
  };

  try {
    // ── 셋업 ────────────────────────────────────────────────────────────────
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const b64 = await cdp.eval(`window.__gpvAnno.solidPng(200, 200, '#ffffff')`);
    const seed = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: SRC,
      base64: b64,
      overwrite: true,
    });
    if (
      !r.check(
        "픽스처 단색 PNG(200×200 흰색) 생성",
        seed.ok && existsSync(join(fix.repo, SRC)),
        seed.ok ? "" : seed.code || "",
      )
    ) {
      return;
    }

    const b64two = await cdp.eval(
      `window.__gpvAnno.halfPng(200, 200, '#000000', '#ffffff')`,
    );
    const seed2 = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: TWO,
      base64: b64two,
      overwrite: true,
    });
    const twoOk = r.check(
      "픽스처 2색 PNG(200×200, 좌반 검정·우반 흰색) 생성",
      seed2.ok && existsSync(join(fix.repo, TWO)),
      seed2.ok ? "" : seed2.code || "",
    );

    const seedStripe = async (rel, alphaB) => {
      const b = await cdp.eval(
        `window.__gpvAnno.stripePng(200, 200, 4, ${alphaB})`,
      );
      const w = await cdp.try("write_file_bytes", {
        projectId: fix.projectId,
        relPath: rel,
        base64: b,
        overwrite: true,
      });
      return w.ok && existsSync(join(fix.repo, rel));
    };
    const stripeOk = r.check(
      "픽스처 줄무늬 PNG(200×200, 4px 주기 흑백) 생성",
      await seedStripe(STRIPE, 255),
    );
    const stripeAOk = r.check(
      "픽스처 줄무늬 PNG(전체 알파 128) 생성",
      await seedStripe(STRIPE_A, 128),
    );

    const opened = await openEditor(fix.projectId, SRC);
    if (
      !r.check(
        "편집기 열림 + __gpv.imageEditor 훅 노출",
        opened,
        opened ? "" : "ready() 타임아웃",
      )
    ) {
      return;
    }

    // ── (a) WYSIWYG 기본 — 프리뷰와 저장 결과가 같은 좌표에서 같은 색 ────────
    await setDoc({ objects: [rectObj("a1", 40, 40, 120, 120, "#FF3B30")] });
    const aIn = await annoPx(100, 100);
    const aOut = await annoPx(10, 10);
    r.check("(a) 프리뷰: 주석 안쪽이 빨강", near(aIn, RED), show(aIn));
    r.check(
      "(a) 프리뷰: 주석 밖은 투명(오버레이 분리, §4.3)",
      Array.isArray(aOut) && aOut[3] === 0,
      show(aOut),
    );

    // §6.1 — 주석이 있으면 in-place 저장이 확인 다이얼로그를 거친다(비가역 평탄화).
    const clickedSave = await cdp.eval(`window.__gpvAnno.click(/저장 \\(/)`);
    await sleep(150);
    const conf = await cdp.eval(
      `(()=>{ const c = window.__gpv.ui.getState().confirm; return c ? { title: c.title, danger: !!c.danger } : null; })()`,
    );
    r.check(
      "(a) 주석 있는 '저장' → 평탄화 확인 다이얼로그(§6.1)",
      clickedSave === true && !!conf && /주석/.test(conf.title) && conf.danger,
      conf ? conf.title : "(다이얼로그 없음)",
    );
    await cdp.eval(`window.__gpv.ui.getState().closeConfirm()`);
    await sleep(100);

    const savedA = await saveAs("e2e-anno-a.png", "e2e-anno-a.png");
    created.push("e2e-anno-a.png");
    r.check(
      "(a) '다른 이름으로' 저장 완료(편집기 닫힘 + 파일 생성)",
      savedA.ok,
      savedA.ok ? "" : `why=${savedA.why} closed=${savedA.closed} disk=${savedA.onDisk}`,
    );
    r.check(
      "(a) 다른 이름 기본값이 '-annotated' (§6.1 안전한 쪽이 기본)",
      savedA.defaultValue === "e2e-anno-src-annotated.png",
      String(savedA.defaultValue),
    );

    const fileA = await cdp.eval(
      `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-a.png", [[100,100],[10,10]])`,
    );
    r.check(
      "(a) 저장 파일 크기 = 원본 200×200",
      fileA.w === 200 && fileA.h === 200,
      `${fileA.w}×${fileA.h}`,
    );
    r.check(
      "(a) ④ 저장 파일 (100,100) = 프리뷰와 같은 빨강 ⇒ WYSIWYG",
      near(fileA.px[0], RED),
      show(fileA.px[0]),
    );
    r.check(
      "(a) 저장 파일 (10,10) = 원본 흰색(주석 밖 보존)",
      isWhite(fileA.px[1]),
      show(fileA.px[1]),
    );

    // ── (b) D2 — 색보정은 이미지에만, 주석 RGB는 불변 ───────────────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({
        objects: [rectObj("b1", 40, 40, 120, 120, "#FF3B30")],
        brightness: 50,
      });
      const savedB = await saveAs("e2e-anno-b.png", "e2e-anno-b.png");
      created.push("e2e-anno-b.png");
      if (r.check("(b) 밝기 50% 저장", savedB.ok, savedB.ok ? "" : savedB.why)) {
        const fileB = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-b.png", [[100,100],[10,10]])`,
        );
        r.check(
          "(b) D2: 밝기 50%에도 주석 RGB 불변(#FF3B30)",
          near(fileB.px[0], RED),
          show(fileB.px[0]),
        );
        r.check(
          "(b) D2: 이미지 배경은 실제로 어두워짐",
          Array.isArray(fileB.px[1]) && fileB.px[1][0] < 200,
          show(fileB.px[1]),
        );
      }
    } else {
      r.skip("(b) D2 색보정", "편집기 재개 실패");
    }

    // ── (c) 90° 회전 좌표 변환 + (h) undo/redo ──────────────────────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({ objects: [rectObj("c1", 10, 10, 20, 20, "#FF3B30")] });
      const before = await annoPx(20, 20);
      r.check("(c) 회전 전: 좌상단에 주석", near(before, RED), show(before));

      const rot = await cdp.eval(`window.__gpvAnno.click(/오른쪽 90/)`);
      await sleep(250);
      await cdp.eval(`window.__gpvAnno.repaint()`);
      const docC = await getDoc();
      const o = docC.objects[0];
      // (x,y) → (H − y, x) 이므로 (10,10)-(30,30) → x=170, y=10 (§3.2)
      r.check(
        "(c) +90° 델타 아핀: rect (10,10) → (170,10)",
        rot === true &&
          docC.rotation === 90 &&
          Math.round(o.x) === 170 &&
          Math.round(o.y) === 10,
        `rotation=${docC.rotation} x=${Math.round(o.x)} y=${Math.round(o.y)}`,
      );
      const afterTR = await annoPx(180, 20);
      const afterTL = await annoPx(20, 20);
      r.check(
        "(c) 프리뷰: 주석이 이미지와 함께 우상단으로 돎",
        near(afterTR, RED) && Array.isArray(afterTL) && afterTL[3] === 0,
        `TR=${show(afterTR)} TL=${show(afterTL)}`,
      );

      // (h) undo → 회전과 주석 좌표가 함께 복원(§5.3 문서 전체 스냅샷)
      await cdp.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))`,
      );
      await sleep(250);
      const docU = await getDoc();
      r.check(
        "(h) Ctrl+Z: 회전·주석 좌표 동시 복원",
        docU.rotation === 0 && Math.round(docU.objects[0].x) === 10,
        `rotation=${docU.rotation} x=${Math.round(docU.objects[0].x)}`,
      );
      await cdp.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,bubbles:true,cancelable:true}))`,
      );
      await sleep(250);
      const docR = await getDoc();
      r.check(
        "(h) Ctrl+Y: redo 로 회전 상태 재적용",
        docR.rotation === 90 && Math.round(docR.objects[0].x) === 170,
        `rotation=${docR.rotation} x=${Math.round(docR.objects[0].x)}`,
      );

      // Esc 계층 7 — 주석이 남은 채 닫으면 확인을 받는다(§5.4)
      await cdp.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`,
      );
      await sleep(200);
      const escConf = await cdp.eval(
        `(()=>{ const c = window.__gpv.ui.getState().confirm; return c ? c.title : null; })()`,
      );
      const stillOpen = await cdp.eval(
        `window.__gpv.ui.getState().imageEditorPath !== null`,
      );
      r.check(
        "(c) Esc 계층 7: 주석 있는 채 닫기 → 확인 다이얼로그(작업물 보호)",
        !!escConf && stillOpen === true,
        escConf || "(없음)",
      );
      await cdp.eval(`window.__gpv.ui.getState().closeConfirm()`);
    } else {
      r.skip("(c) 회전 좌표 변환 / (h) undo·redo", "편집기 재개 실패");
    }

    // ── (d) 크롭 자동 클리핑 — 크롭 밖 주석은 출력에서 사라진다 ─────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({
        objects: [
          rectObj("d1", 20, 20, 20, 20, "#FF3B30"), // 크롭 안
          rectObj("d2", 140, 140, 20, 20, "#FF3B30"), // 크롭 밖
        ],
        crop: { x: 0, y: 0, w: 100, h: 100 },
        outW: 100,
        outH: 100,
      });
      const savedD = await saveAs("e2e-anno-d.png", "e2e-anno-d.png");
      created.push("e2e-anno-d.png");
      if (r.check("(d) 크롭 상태 저장", savedD.ok, savedD.ok ? "" : savedD.why)) {
        const fileD = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-d.png", [[30,30]], ${J(RED)}, 3)`,
        );
        r.check(
          "(d) 출력 크기 = 크롭 크기 100×100",
          fileD.w === 100 && fileD.h === 100,
          `${fileD.w}×${fileD.h}`,
        );
        r.check(
          "(d) 크롭 안 주석 유지 (30,30)",
          near(fileD.px[0], RED),
          show(fileD.px[0]),
        );
        const m = fileD.match;
        r.check(
          "(d) 크롭 밖 주석 소멸: 빨강 픽셀이 20×20 하나뿐",
          m.n >= 380 && m.n <= 440 && m.minX >= 18 && m.maxX <= 41,
          `n=${m.n} bbox=(${m.minX},${m.minY})-(${m.maxX},${m.maxY})`,
        );
      }
    } else {
      r.skip("(d) 크롭 자동 클리핑", "편집기 재개 실패");
    }

    // ── (e) 리사이즈 50% — 좌표·선 두께가 함께 절반 ─────────────────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({
        objects: [
          rectObj("e1", 40, 40, 120, 120, "#FF3B30"),
          {
            id: "e2",
            kind: "line",
            stroke: "#0A84FF",
            strokeWidth: 20,
            opacity: 1,
            rot: 0,
            x1: 20,
            y1: 190,
            x2: 180,
            y2: 190,
            head: "end",
          },
        ],
        outW: 100,
        outH: 100,
      });
      const savedE = await saveAs("e2e-anno-e.png", "e2e-anno-e.png");
      created.push("e2e-anno-e.png");
      if (r.check("(e) 50% 리사이즈 저장", savedE.ok, savedE.ok ? "" : savedE.why)) {
        const fileE = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-e.png", [[25,25],[15,15],[78,78],[85,85],[50,96],[50,84]], ${J(BLUE)}, 6)`,
        );
        r.check(
          "(e) 출력 크기 100×100",
          fileE.w === 100 && fileE.h === 100,
          `${fileE.w}×${fileE.h}`,
        );
        r.check(
          "(e) 사각형이 배율을 따라 (40,40,120,120) → (20,20,60,60)",
          near(fileE.px[0], RED) &&
            isWhite(fileE.px[1]) &&
            near(fileE.px[2], RED) &&
            isWhite(fileE.px[3]),
          `in=${show(fileE.px[0])}/${show(fileE.px[2])} out=${show(fileE.px[1])}/${show(fileE.px[3])}`,
        );
        const mb = fileE.match;
        const thick = mb.maxY - mb.minY + 1;
        r.check(
          "(e) 선 두께도 절반: strokeWidth 20 → 출력 약 10px",
          near(fileE.px[4], BLUE, 8) &&
            isWhite(fileE.px[5]) &&
            thick >= 9 &&
            thick <= 12,
          `두께=${thick}px bboxY=${mb.minY}~${mb.maxY}`,
        );
      }
    } else {
      r.skip("(e) 리사이즈 50%", "편집기 재개 실패");
    }

    // ── (g) 번호 뱃지 — 클릭 순서대로 증가, 삭제해도 재정렬 없음(§12) ───────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({ objects: [] });
      await cdp.eval(`window.__gpv.imageEditor.setTool("badge")`);
      await sleep(150);
      const clicked = await cdp.eval(
        `window.__gpvAnno.clickCanvas([[40,40],[80,40],[120,40]])`,
      );
      await sleep(250);
      const docG = await getDoc();
      const ns = docG.objects.filter((x) => x.kind === "badge").map((x) => x.n);
      r.check(
        "(g) 뱃지 3개가 클릭 순서대로 1,2,3",
        clicked === true && ns.join(",") === "1,2,3",
        `n=[${ns.join(",")}]`,
      );
      // 중심은 숫자 글리프(자동 대비 색)라 원의 채움만 보이는 지점을 샘플링한다.
      const badgePx = await annoPx(52, 40);
      r.check(
        "(g) 프리뷰에 뱃지 원이 그려짐(원 채움 = 뱃지 색)",
        near(badgePx, RED, 6),
        show(badgePx),
      );

      // 2번을 지우고 다시 찍으면 재정렬 없이 4번이 이어진다.
      await setDoc({
        objects: docG.objects.filter((x) => x.n !== 2),
      });
      await cdp.eval(`window.__gpvAnno.clickCanvas([[160,40]])`);
      await sleep(250);
      const docG2 = await getDoc();
      const ns2 = docG2.objects.filter((x) => x.kind === "badge").map((x) => x.n);
      r.check(
        "(g) 삭제 후 새 뱃지는 재정렬 없이 이어서 증가(1,3,4)",
        ns2.join(",") === "1,3,4",
        `n=[${ns2.join(",")}]`,
      );
      await cdp.eval(`window.__gpv.imageEditor.setTool("select")`);
    } else {
      r.skip("(g) 번호 뱃지", "편집기 재개 실패");
    }

    // ── (i) 형광펜 multiply — 겹침 누적 + **프리뷰 == 저장** 블렌드 ──────────
    //
    // 왜 2색 픽스처인가: 흰 배경만으로는 이 결함이 안 보인다. multiply 는 흰색 배경에서
    // `255 × C = C` 라 단순 알파 합성과 같은 값이 나오기 때문이다. 검은 배경에서만 갈린다 —
    // 진짜 multiply 는 검정(0)을 검정으로 남기고, 퇴화한 source-over 는 노랑을 얹는다.
    //
    // 프리뷰 오버레이는 투명이라 블렌드 규격상 multiply 가 source-over 로 퇴화한다
    // (backdrop 알파 0 ⇒ 결과 = 소스). 렌더러가 배경을 재구성하지 않으면 검정 위 형광펜이
    // **프리뷰에서는 노랗게 보이고 저장 파일에서는 사라진다**. 아래 (i-2)가 그 회귀 방지다.
    if (twoOk && (await openEditor(fix.projectId, TWO))) {
      await setDoc({
        objects: [
          hlObj("i1", [20, 60, 180, 60], YELLOW, 24), // 가로 획 — 검정·흰색을 모두 지난다
          hlObj("i2", [150, 20, 150, 140], YELLOW, 24), // 세로 획 — 흰색 쪽에서 i1 과 교차
        ],
      });
      // 획 두께 24 · butt cap 이라 아래 좌표는 전부 커버리지 1(안티에일리어싱 경계가 아님).
      const pBlack = await annoPx(50, 60); // 검정 위, 획 하나
      const pWhite = await annoPx(120, 60); // 흰색 위, 획 하나
      const pCross = await annoPx(150, 60); // 흰색 위, 두 획 교차
      const pVert = await annoPx(150, 120); // 흰색 위, 세로 획만

      r.check(
        "(i-1) 프리뷰: 흰 배경 위 형광펜 = bg·(0.65 + 0.35·색) = (255,237,166)",
        near(pWhite, HL_ON_WHITE, 6),
        `${show(pWhite)} 기대 rgb(${HL_ON_WHITE.join(",")})`,
      );
      r.check(
        "(i-2) 프리뷰: 검정 위 형광펜은 검정 — 투명 오버레이에서 multiply 가 퇴화하지 않는다",
        near(pBlack, HL_ON_BLACK, 6),
        `${show(pBlack)} 기대 rgb(0,0,0) — 노랑(255,204,0,α89)이면 프리뷰 blend 회귀`,
      );
      r.check(
        "(i-3) 교차점은 한 겹보다 어둡되 검게 뭉치지 않는다(multiply 누적)",
        near(pCross, HL_CROSS_WHITE, 8) &&
          Array.isArray(pWhite) &&
          Math.abs(pCross[0] - pWhite[0]) <= 4 && // 소스가 255인 채널은 multiply 로 안 어두워진다
          pCross[2] <= pWhite[2] - 30 && // 그러나 다른 채널은 실제로 누적된다
          pCross[2] >= 60, // 검정으로 뭉치는 것은 아니다
        `교차=${show(pCross)} 단일=${show(pWhite)} 기대 rgb(${HL_CROSS_WHITE.join(",")})`,
      );

      const savedI = await saveAs("e2e-anno-hl.png", "e2e-anno-hl.png");
      created.push("e2e-anno-hl.png");
      if (r.check("(i) 형광펜 저장", savedI.ok, savedI.ok ? "" : savedI.why)) {
        const fileI = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-hl.png", [[50,60],[120,60],[150,60],[150,120]])`,
        );
        const pv = [pBlack, pWhite, pCross, pVert];
        const diff = pv
          .map((p, i) => (near(fileI.px[i], p, 4) ? null : `#${i} ${show(p)}≠${show(fileI.px[i])}`))
          .filter(Boolean);
        r.check(
          "(i-4) **프리뷰 픽셀 == 저장 픽셀** — 검정·흰색·교차 네 지점 모두(§4.1 WYSIWYG)",
          fileI.w === 200 && diff.length === 0,
          diff.length ? diff.join(" / ") : `${fileI.w}×${fileI.h}`,
        );
      }
    } else {
      r.skip("(i) 형광펜 multiply", "2색 픽스처 또는 편집기 재개 실패");
    }

    // ── (j) 모자이크 셀 격자 배율 불변 — 프리뷰(s=1)와 저장(s=2)의 셀 경계가 같다 ──
    //
    // 셀 개수를 `dw / (strength × s)` 로 잡으므로 배율이 달라도 **같은 oriented 격자**가
    // 나온다(§5.2). 검증법: 검정/흰색 경계(oriented x=100)를 45부터 10px 셀로 자르면
    // 경계를 걸친 셀 하나만 회색이 된다 — 그 회색 구간이 곧 격자 좌표다.
    //   셀 5 = oriented [95,105) → 프리뷰 device [95,105), 저장 device [190,210)
    // 배율 보정이 없으면 저장 쪽 셀이 oriented 5px 이 되어 경계가 셀 안쪽으로 들어가지 않고
    // (셀 10 = [95,100) 전부 검정, 셀 11 = [100,105) 전부 흰색) **회색 구간 자체가 사라진다**.
    if (twoOk && (await openEditor(fix.projectId, TWO))) {
      await setDoc({
        objects: [mosaicObj("j1", 45, 40, 100, 100, 10)],
        outW: 400,
        outH: 400,
      });
      const pRun = await cdp.eval(`window.__gpvAnno.previewMidRun(90, 45, 145)`);
      const pDark = await annoPx(90, 90); // 셀 4 = [85,95) 전부 검정
      const pGray = await annoPx(100, 90); // 셀 5 = [95,105) 경계 걸침
      const pLite = await annoPx(110, 90); // 셀 6 = [105,115) 전부 흰색
      r.check(
        "(j-1) 프리뷰: 모자이크가 흑·회·백 셀로 픽셀화됨",
        near(pDark, [0, 0, 0], 20) &&
          isWhite(pLite) &&
          Array.isArray(pGray) &&
          pGray[0] > 60 &&
          pGray[0] < 195,
        `dark=${show(pDark)} gray=${show(pGray)} lite=${show(pLite)}`,
      );

      const savedJ = await saveAs("e2e-anno-mos.png", "e2e-anno-mos.png");
      created.push("e2e-anno-mos.png");
      if (r.check("(j) 모자이크 200% 리사이즈 저장", savedJ.ok, savedJ.ok ? "" : savedJ.why)) {
        const fileJ = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-mos.png", [[180,180],[200,180],[220,180]])`,
        );
        const sRun = await cdp.eval(
          `window.__gpvAnno.savedMidRun(${J(fix.projectId)}, "e2e-anno-mos.png", 180, 90, 290)`,
        );
        r.check(
          "(j-2) 저장본도 같은 흑·회·백 셀 배치(출력 400×400)",
          fileJ.w === 400 &&
            near(fileJ.px[0], [0, 0, 0], 20) &&
            isWhite(fileJ.px[2]) &&
            Array.isArray(fileJ.px[1]) &&
            fileJ.px[1][0] > 60 &&
            fileJ.px[1][0] < 195,
          `${fileJ.w}×${fileJ.h} dark=${show(fileJ.px[0])} gray=${show(fileJ.px[1])} lite=${show(fileJ.px[2])}`,
        );
        // device 구간 → oriented 구간(프리뷰 s=1, 저장 s=2).
        const pL = pRun && pRun.n ? pRun.min : NaN;
        const pR = pRun && pRun.n ? pRun.max + 1 : NaN;
        const sL = sRun && sRun.n ? sRun.min / 2 : NaN;
        const sR = sRun && sRun.n ? (sRun.max + 1) / 2 : NaN;
        r.check(
          "(j-3) 프리뷰 셀 격자 = oriented 10px, 경계를 걸친 셀은 [95,105)",
          Math.abs(pL - 95) <= 1 && Math.abs(pR - 105) <= 1,
          `프리뷰 회색구간 oriented [${pL},${pR}) n=${pRun ? pRun.n : "-"}`,
        );
        r.check(
          "(j-4) 저장본 셀 경계가 프리뷰와 같은 oriented 좌표(배율 보정, §5.2)",
          Math.abs(sL - pL) <= 1 && Math.abs(sR - pR) <= 1,
          `저장 oriented [${sL},${sR}) vs 프리뷰 [${pL},${pR}) — 보정 누락 시 회색구간 n=0`,
        );
      }
    } else {
      r.skip("(j) 모자이크 배율 보정", "2색 픽스처 또는 편집기 재개 실패");
    }

    // ── (r) 블러가 이미지 경계에 닿아도 저장본에 원본이 남지 않는다 ────────────
    //
    // 캔버스 필터 블러는 **그리는 소스 사각형 밖을 투명으로** 본다. 그래서 소스 경계에서
    // 결과 알파가 떨어지고(경계열 ≈0.5, 코너 ≈0.25), source-over 로 얹으면 그 비율만큼
    // 아래 깔린 **선명한 원본**이 그대로 비친다. 종전 구현은 소스를 반경만큼 넓혀 이걸
    // 피했는데, 그 확장이 `Math.max(0, …)` 로 캔버스 경계에서 클램프돼 **이미지·크롭
    // 가장자리에서는 방어가 통째로 사라졌다** — 스크린샷 좌상단(주소창·계정명) 가리기가
    // 정확히 그 경우다. 현재는 가장자리 복제로 3σ 패딩을 만든 스크래치를 블러한다.
    //
    // 판정: 4px 주기 줄무늬 위에 σ=12 로 가리면 원본 주기가 **한 톨도** 남으면 안 된다.
    // "행이 균일한가"로 재면 안 된다 — 정상 동작인 가장자리 복제도 완만한 그라디언트를
    // 만들기 때문이다. 그래서 **인접 픽셀 급변**으로 잰다(줄무늬가 살면 델타가 크게 남는다).
    if (stripeOk && (await openEditor(fix.projectId, STRIPE))) {
      await setDoc({
        objects: [blurObj("l1", 0, 0, 120, 200, 12)],
        outW: 200,
        outH: 200,
      });
      const pre = await cdp.eval(`window.__gpvAnno.previewAdjDelta(100, 2, 110, 0)`);
      r.check(
        "(r-1) 프리뷰: 왼쪽 경계에 닿은 블러 안에 원본 줄무늬가 없다",
        !!pre && pre.d <= 12 && pre.minA >= 250,
        `최대 인접델타=${pre ? pre.d : "-"} @x=${pre ? pre.at : "-"} 최소알파=${pre ? pre.minA : "-"}`,
      );

      const savedL = await saveAs("e2e-anno-blur.png", "e2e-anno-blur.png");
      created.push("e2e-anno-blur.png");
      if (r.check("(r) 경계 블러 저장", savedL.ok, savedL.ok ? "" : savedL.why)) {
        const adj = await cdp.eval(
          `window.__gpvAnno.savedAdjDelta(${J(fix.projectId)}, "e2e-anno-blur.png", 100, 2, 110, 0)`,
        );
        r.check(
          "(r-2) 저장본: 블러 영역에 원본 줄무늬가 남지 않음(경계 알파 감쇠 누수 회귀)",
          !!adj && adj.d <= 12 && adj.minA >= 250,
          `최대 인접델타=${adj ? adj.d : "-"} @x=${adj ? adj.at : "-"} 최소알파=${adj ? adj.minA : "-"} (누수 시 100+)`,
        );
        // 사각형 밖(x>120)은 원본 그대로여야 한다 — 가림이 새어 나가지 않았다는 반대편 단언.
        const out = await cdp.eval(
          `window.__gpvAnno.savedAdjDelta(${J(fix.projectId)}, "e2e-anno-blur.png", 100, 130, 190, 0)`,
        );
        r.check(
          "(r-3) 사각형 밖은 원본 줄무늬가 그대로(가림이 번지지 않음)",
          !!out && out.d >= 200,
          `최대 인접델타=${out ? out.d : "-"}`,
        );
      }
    } else {
      r.skip("(r) 경계 블러 누수", "줄무늬 픽스처 또는 편집기 재개 실패");
    }

    // ── (s) 알파 있는 원본에서 가림이 원본을 남기지 않는다(copy 합성) ──────────
    //
    // 가림 결과의 알파는 원본 알파를 물려받아 1 미만이 될 수 있다. 이걸 source-over 로
    // 얹으면 `가림 + (1−a)×원본` 이 되어 투명 배경 PNG(로고·UI 에셋)에서 가려야 할 글자가
    // 그대로 읽힌다 — 사각형 **한가운데**에서도 샌다는 것이 (l)의 가장자리 누수와 다른 점이다.
    // 그래서 drawMosaic 은 클립 안을 copy 로 **대체**한다.
    // 측정 구간은 사각형 안쪽 깊숙이 잡는다(가장자리 복제 그라디언트와 섞이지 않게).
    if (stripeAOk && (await openEditor(fix.projectId, STRIPE_A))) {
      await setDoc({
        objects: [blurObj("m1", 20, 20, 160, 160, 12)],
        outW: 200,
        outH: 200,
      });
      const savedM = await saveAs("e2e-anno-alpha.png", "e2e-anno-alpha.png");
      created.push("e2e-anno-alpha.png");
      if (r.check("(s) 반투명 원본 가림 저장", savedM.ok, savedM.ok ? "" : savedM.why)) {
        const adjR = await cdp.eval(
          `window.__gpvAnno.savedAdjDelta(${J(fix.projectId)}, "e2e-anno-alpha.png", 100, 60, 140, 0)`,
        );
        const adjA = await cdp.eval(
          `window.__gpvAnno.savedAdjDelta(${J(fix.projectId)}, "e2e-anno-alpha.png", 100, 60, 140, 3)`,
        );
        r.check(
          "(s-1) 저장본: 반투명 원본의 줄무늬가 사각형 안에 남지 않음(source-over 누수 회귀)",
          !!adjR && adjR.d <= 6 && !!adjA && adjA.d <= 6,
          `RGB 인접델타=${adjR ? adjR.d : "-"} 알파 인접델타=${adjA ? adjA.d : "-"} (누수 시 45/24)`,
        );
      }
    } else {
      r.skip("(s) 반투명 원본 합성 누수", "반투명 줄무늬 픽스처 또는 편집기 재개 실패");
    }

    // ── (k) Esc 계층 2~6 (계층 7은 (c)에서 검증) ────────────────────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({ objects: [rectObj("k1", 30, 30, 100, 100, "#FF3B30")] });
      const isOpen = () =>
        cdp.eval(`window.__gpv.ui.getState().imageEditorPath !== null`);

      // 계층 2 — 편집 중인 텍스트를 확정한다(닫기가 아니라).
      await cdp.eval(`window.__gpv.imageEditor.setTool("text")`);
      await sleep(150);
      await cdp.eval(`window.__gpvAnno.clickCanvas([[60,170]])`); // 사각형 아래 빈 자리
      await sleep(200);
      const taOpen = await cdp.eval(`window.__gpvAnno.hasTextarea()`);
      const typed = await cdp.eval(`window.__gpvAnno.typeText("e2e")`);
      await sleep(150);
      await cdp.eval(`window.__gpvAnno.esc()`);
      const docK = await getDoc();
      const txt = docK.objects.find((o) => o.kind === "text");
      const taGone = await cdp.eval(`window.__gpvAnno.hasTextarea()`);
      r.check(
        "(k) Esc 계층 2: 텍스트 확정 — 객체가 남고 편집기는 닫히지 않는다",
        taOpen === true &&
          typed === true &&
          taGone === false &&
          !!txt &&
          txt.text === "e2e" &&
          (await isOpen()) === true,
        `textarea=${taOpen}→${taGone} text=${txt ? J(txt.text) : "(없음)"}`,
      );

      // 계층 4 — 그리기 도구에서 select 로 복귀.
      await cdp.eval(`window.__gpv.imageEditor.setTool("pen")`);
      await sleep(150);
      const toolPen = await cdp.eval(`window.__gpvAnno.activeTool()`);
      await cdp.eval(`window.__gpvAnno.esc()`);
      const toolSel = await cdp.eval(`window.__gpvAnno.activeTool()`);
      r.check(
        "(k) Esc 계층 4: pen → select 복귀(편집기 유지)",
        toolPen === "pen" && toolSel === "select" && (await isOpen()) === true,
        `tool ${toolPen} → ${toolSel}`,
      );

      // 계층 5 — 선택 해제.
      await cdp.eval(`window.__gpvAnno.clickCanvas([[80,80]])`);
      await sleep(200);
      const selBefore = await cdp.eval(`window.__gpvAnno.selCount()`);
      await cdp.eval(`window.__gpvAnno.esc()`);
      const selAfter = await cdp.eval(`window.__gpvAnno.selCount()`);
      r.check(
        "(k) Esc 계층 5: 선택 해제(편집기 유지)",
        selBefore === 1 && selAfter === 0 && (await isOpen()) === true,
        `선택 ${selBefore} → ${selAfter}`,
      );

      // 계층 3 — 크롭 드래그 중 Esc. 진행 중 제스처를 버리는 계층이라 크롭 '모드'는 남는다.
      const cropBtn = await cdp.eval(`window.__gpvAnno.click(/크롭 선택/)`);
      await sleep(200);
      const cropBefore = await cdp.eval(`window.__gpvAnno.cropOn()`);
      const seqK = await cdp.eval(
        `window.__gpvAnno.pointerSeq([['down',30,30],['move',80,80],['move',140,140],['esc'],['up',140,140]])`,
      );
      await sleep(250);
      const docCrop = await getDoc();
      const cropStillOn = await cdp.eval(`window.__gpvAnno.cropOn()`);
      r.check(
        "(k) Esc 계층 3: 크롭 드래그 취소 — 버튼을 떼도 크롭이 확정되지 않는다",
        cropBtn === true && cropBefore === true && seqK === true && docCrop.crop === null,
        `crop=${J(docCrop.crop)} (취소 누락 시 {x:30,y:30,w:110,h:110})`,
      );
      r.check(
        "(k) Esc 계층 3은 크롭 모드까지 끄지 않는다(그건 계층 6의 몫)",
        cropStillOn === true,
        `cropMode=${cropStillOn}`,
      );

      // 계층 6 — 크롭 모드 해제.
      await cdp.eval(`window.__gpvAnno.esc()`);
      const cropOff = await cdp.eval(`window.__gpvAnno.cropOn()`);
      r.check(
        "(k) Esc 계층 6: 크롭 모드 해제(편집기 유지)",
        cropOff === false && (await isOpen()) === true,
        `cropMode=${cropOff}`,
      );
    } else {
      r.skip("(k) Esc 계층 2~6", "편집기 재개 실패");
    }

    // ── (l) 8핸들 리사이즈 — 변 핸들 + Shift 비율 고정 ──────────────────────
    //
    // 변 핸들(n/s/e/w)은 한 축 배율만 잡힌다. Shift 면 그 배율을 비활성 축에도 걸고, 비활성
    // 축 원점은 bbox 중심으로 잡아 마주 보는 두 변이 대칭으로 늘어나야 한다(§5.6).
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({ objects: [rectObj("l1", 30, 30, 100, 100, "#FF3B30")] });
      await cdp.eval(`window.__gpvAnno.clickCanvas([[80,80]])`);
      await sleep(200);
      const selL = await cdp.eval(`window.__gpvAnno.selCount()`);
      if (
        r.check(
          "(l) 객체 선택 — 8핸들이 뜨는 전제 조건",
          selL === 1,
          `선택=${selL}개`,
        )
      ) {
        // 동쪽 변 핸들 (130,80) → (180,80). fx = 150/100 = 1.5, 비활성 축 원점 = 중심 y=80.
        //   x: 30 유지, w: 100 × 1.5 = 150
        //   y: 80 + (30−80)×1.5 = 5,  h: 100 × 1.5 = 150
        const seqL = await cdp.eval(
          `window.__gpvAnno.pointerSeq([['down',130,80],['move',160,80],['move',180,80],['up',180,80]], {shift:true})`,
        );
        await sleep(250);
        const a = (await getDoc()).objects[0];
        const box = (o) =>
          `(${Math.round(o.x)},${Math.round(o.y)},${Math.round(o.w)},${Math.round(o.h)})`;
        r.check(
          "(l-1) 변(e) 핸들 + Shift: (30,30,100,100) → (30,5,150,150) — 비활성 축도 같은 배율",
          seqL === true &&
            Math.abs(a.x - 30) <= 2 &&
            Math.abs(a.y - 5) <= 2 &&
            Math.abs(a.w - 150) <= 2 &&
            Math.abs(a.h - 150) <= 2,
          `${box(a)} (비활성 축 미적용 시 (30,30,150,100))`,
        );
        r.check(
          "(l-2) Shift 비율 고정: 정사각형이 정사각형으로 남는다",
          Math.abs(a.w - a.h) <= 2,
          `w=${Math.round(a.w)} h=${Math.round(a.h)}`,
        );

        // Shift 없이 코너(se) 핸들 (180,155) → (130,130): 두 축 배율이 따로 잡혀 비율이 바뀐다.
        //   fx = 100/150, fy = 125/150 → w=100, h=125
        const seqL2 = await cdp.eval(
          `window.__gpvAnno.pointerSeq([['down',180,155],['move',150,140],['move',130,130],['up',130,130]])`,
        );
        await sleep(250);
        const b = (await getDoc()).objects[0];
        r.check(
          "(l-3) Shift 없는 코너(se) 핸들은 축별 자유 배율 — (30,5,150,150) → (30,5,100,125)",
          seqL2 === true &&
            Math.abs(b.w - 100) <= 3 &&
            Math.abs(b.h - 125) <= 3 &&
            Math.abs(b.w - b.h) > 10,
          `${box(b)}`,
        );
      }
    } else {
      r.skip("(l) 8핸들 리사이즈 + Shift", "편집기 재개 실패");
    }

    // ── (m) 펜 점 데시메이션 — 조밀한 궤적이 PEN_MIN_DIST(1.5px)로 걸러진다(§4.4) ──
    if (await openEditor(fix.projectId, SRC)) {
      await cdp.eval(`window.__gpv.imageEditor.setTool("pen")`);
      await sleep(150);
      // 0.5px 간격으로 x 20→60 (81 샘플). 데시메이션이 없으면 그대로 81점(pts 162)이 된다.
      const steps = [["down", 20, 100]];
      for (let x = 20.5; x <= 60.0001; x += 0.5) steps.push(["move", x, 100]);
      steps.push(["up", 60, 100]);
      const seqM = await cdp.eval(`window.__gpvAnno.pointerSeq(${J(steps)})`);
      await sleep(300);
      const pen = (await getDoc()).objects.find((o) => o.kind === "pen");
      const n = pen ? pen.pts.length : -1;
      // 기대치 54 = (1 + floor(40 / 1.5)) × 2. 후보 간격이 정확히 1.5의 배수라
      // `>=` 비교가 부동소수 오차로 갈릴 수 있어(1.5 간격 대신 2.0 간격 = 42) 범위로 둔다.
      r.check(
        "(m) 펜 데시메이션: 0.5px 간격 81 샘플 → 27점 안팎(pts ≈ 54), 무데시메이션 162 아님",
        seqM === true && n >= 38 && n <= 58,
        `pts=${n} (기대 42~54, 무데시메이션 162)`,
      );
      let minGap = Number.POSITIVE_INFINITY;
      if (pen) {
        for (let i = 2; i + 1 < pen.pts.length; i += 2) {
          minGap = Math.min(
            minGap,
            Math.hypot(pen.pts[i] - pen.pts[i - 2], pen.pts[i + 1] - pen.pts[i - 1]),
          );
        }
      }
      r.check(
        "(m) 남은 점의 간격이 모두 PEN_MIN_DIST(1.5px) 이상",
        Number.isFinite(minGap) && minGap >= 1.5 - 0.01,
        `최소 간격=${Number.isFinite(minGap) ? minGap.toFixed(3) : "-"}px`,
      );
      r.check(
        "(m) 데시메이션이 획의 시작·끝을 잃지 않는다",
        !!pen &&
          Math.abs(pen.pts[0] - 20) <= 1 &&
          Math.abs(pen.pts[pen.pts.length - 2] - 60) <= 2, // 마지막 1px 미만 잔여는 버려진다
        pen ? `x: ${pen.pts[0].toFixed(1)} → ${pen.pts[pen.pts.length - 2].toFixed(1)}` : "(획 없음)",
      );
    } else {
      r.skip("(m) 펜 데시메이션", "편집기 재개 실패");
    }

    // ── (f) D1 임베디드 저장소 라우팅 — 그 저장소 "안"에 써야 한다 ──────────
    const embDir = join(fix.repo, EMB);
    let embReady = false;
    try {
      mkdirSync(embDir, { recursive: true });
      git(embDir, ["init", "-b", "main"]);
      embMade = true;
      embReady = true;
    } catch (e) {
      r.skip("(f) 임베디드 저장소 라우팅(D1)", `중첩 레포 생성 실패: ${e.message}`);
    }
    if (embReady) {
      const embId = `${fix.projectId}::${EMB}`;
      const embSeed = await cdp.try("write_file_bytes", {
        projectId: embId,
        relPath: "shot.png",
        base64: b64,
        overwrite: true,
      });
      if (
        r.check(
          "(f) 중첩 저장소 합성 id(`<outer>::<rel>`)로 픽스처 이미지 생성",
          embSeed.ok && existsSync(join(embDir, "shot.png")),
          embSeed.ok ? "" : embSeed.code || "",
        )
      ) {
        const embOpen = await openEditor(embId, "shot.png");
        if (r.check("(f) 중첩 저장소 이미지로 편집기 열림", embOpen)) {
          await setDoc({ objects: [rectObj("f1", 40, 40, 120, 120, "#FF3B30")] });
          const savedF = await saveAs(
            "shot-annotated.png",
            join(EMB, "shot-annotated.png"),
          );
          r.check(
            "(f) D1: 저장 결과가 **중첩 저장소 안**에 생성됨",
            savedF.ok && existsSync(join(embDir, "shot-annotated.png")),
            savedF.ok ? "" : `why=${savedF.why} closed=${savedF.closed}`,
          );
          r.check(
            "(f) D1: 바깥 레포 루트에는 아무것도 쓰이지 않음",
            !existsSync(join(fix.repo, "shot-annotated.png")),
            "outer/shot-annotated.png 없음",
          );
          const fileF = await cdp.eval(
            `window.__gpvAnno.readSaved(${J(embId)}, "shot-annotated.png", [[100,100]])`,
          );
          r.check(
            "(f) 중첩 저장소 저장물도 같은 픽셀 계약",
            near(fileF.px[0], RED),
            show(fileF.px[0]),
          );
        }
      }
    }

    // ── (n) 회전된 객체의 리사이즈 (설계 D-A) ──────────────────────────────
    //
    // 객체 좌표는 전부 **로컬**(회전 이전)이고 회전은 렌더 시점에만 걸린다. 종전에는 핸들을
    // objectAABB(회전 외접 사각형) 위에 두고 거기서 뽑은 배율을 그 로컬 좌표에 먹였다 →
    // 앵커가 포인터로 순간이동했다. 도달 경로는 "이미지를 90° 돌린 뒤 텍스트·뱃지 리사이즈"다.
    //
    // 픽스처: rect(60,60,80,40) rot=90. 앵커는 중심 (100,80).
    //   로컬 동쪽 핸들 (140,80) 을 90° 돌리면 → (100,120).      ← 새 코드가 집는 점
    //   AABB 는 {80,40,40,80} 이라 그 점은 **남쪽** 핸들이다.    ← 옛 코드가 집던 점
    // (100,120) → (100,160) 으로 끌면
    //   새 코드: 로컬 pt=(180,80) → 동쪽 fx=1.5 → x=60 y=60 w=120 h=40  (앵커 고정)
    //   옛 코드: 남쪽 fy=1.5      → y=70 h=60 w=80               (y 가 튄다)
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({ objects: [rotRectObj("n1", 60, 60, 80, 40, RED_HEX, 90)] });
      await cdp.eval(`window.__gpv.imageEditor.setTool("select")`);
      await cdp.eval(`window.__gpvAnno.clickCanvas([[100,80]])`);
      const selN = await cdp.eval(`window.__gpvAnno.selCount()`);
      if (r.check("(n-0) 회전 사각형이 선택된다", selN === 1, `selCount=${selN}`)) {
        await cdp.eval(
          `window.__gpvAnno.pointerSeq([['down',100,120],['move',100,140],['up',100,160]])`,
        );
        // rot 이 90 의 배수인 사각형의 **화면**(축정렬 외접) 사각형. 로컬 좌표만 보면
        // 앵커 드리프트를 못 잡는다 — 로컬은 맞는데 화면에서 미끄러지는 것이 D-A 의 잔여 결함이었다.
        const box = await cdp.eval(
          `(()=>{const a=window.__gpv.imageEditor.getDoc().objects[0]; if(!a) return null;
             const cx=a.x+a.w/2, cy=a.y+a.h/2;
             const b = (((a.rot%180)+180)%180===0)
               ? {x:a.x,y:a.y,w:a.w,h:a.h}
               : {x:cx-a.h/2,y:cy-a.w/2,w:a.h,h:a.w};
             return [Math.round(b.x),Math.round(b.y),Math.round(b.w),Math.round(b.h)];})()`,
        );
        r.check(
          "(n-1) 회전 리사이즈: 잡은 변이 포인터(160)를 따라오고 반대 변(40)은 고정",
          Array.isArray(box) &&
            Math.abs(box[0] - 80) <= 2 &&
            Math.abs(box[2] - 40) <= 2 &&
            Math.abs(box[1] - 40) <= 2 &&
            Math.abs(box[1] + box[3] - 160) <= 2,
          `화면 x,y,w,h=${J(box)} — 기대 [80,40,40,120]`,
        );
      }
    } else {
      r.skip("(n) 회전 리사이즈", "편집기 재개 실패");
    }

    // ── (o) 마퀴 선택 (설계 D-B) ──────────────────────────────────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({
        objects: [
          rectObj("o1", 20, 20, 30, 30, RED_HEX),
          rectObj("o2", 70, 20, 30, 30, RED_HEX),
          rectObj("o3", 150, 150, 30, 30, RED_HEX),
        ],
      });
      await cdp.eval(`window.__gpv.imageEditor.setTool("select")`);
      // 앞의 둘만 감싼다(세 번째는 멀리 있다).
      await cdp.eval(
        `window.__gpvAnno.pointerSeq([['down',10,10],['move',60,60],['up',110,60]])`,
      );
      const c1 = await cdp.eval(`window.__gpvAnno.selCount()`);
      r.check("(o-1) 마퀴가 감싼 2개를 선택한다", c1 === 2, `selCount=${c1}`);

      await cdp.eval(
        `window.__gpvAnno.pointerSeq([['down',140,140],['move',160,160],['up',190,190]], {shift:true})`,
      );
      const c2 = await cdp.eval(`window.__gpvAnno.selCount()`);
      r.check("(o-2) Shift 마퀴는 기존 선택에 누적된다", c2 === 3, `selCount=${c2}`);

      await cdp.eval(`window.__gpvAnno.clickCanvas([[190,10]])`);
      const c3 = await cdp.eval(`window.__gpvAnno.selCount()`);
      r.check("(o-3) 빈 곳 클릭은 종전대로 선택 해제", c3 === 0, `selCount=${c3}`);

      // 마퀴를 **연 채로** 저장한다(up 없음) — 그래야 화면에 사각형이 떠 있는 상태의
      // 저장본을 본다. up 뒤에 저장하면 마퀴가 이미 사라져 아무것도 검증하지 못한다.
      await cdp.eval(
        `window.__gpvAnno.pointerSeq([['down',10,10],['move',60,60],['move',110,60]])`,
      );
      const savedO = await saveAs("e2e-anno-marquee.png", "e2e-anno-marquee.png");
      created.push("e2e-anno-marquee.png");
      if (r.check("(o) 마퀴 상태 저장", savedO.ok, savedO.ok ? "" : savedO.why)) {
        // (55,10) 은 두 사각형 사이 빈 곳이자 마퀴 테두리가 지나던 자리다.
        const fO = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-marquee.png", [[55,10],[10,10]])`,
        );
        r.check(
          "(o-4) 저장본에 마퀴 사각형이 없다(화면 크롬은 renderScene 에 없다)",
          !!fO && isWhite(fO.px[0]) && isWhite(fO.px[1]),
          fO ? `${show(fO.px[0])} ${show(fO.px[1])}` : "-",
        );
      }
    } else {
      r.skip("(o) 마퀴 선택", "편집기 재개 실패");
    }

    // ── (p) 손 피드백: 핸들 커서 · 방향키 nudge · HUD (설계 D-C·D-D·K3) ────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({ objects: [rectObj("p1", 60, 60, 80, 40, RED_HEX)] });
      await cdp.eval(`window.__gpv.imageEditor.setTool("select")`);
      await cdp.eval(`window.__gpvAnno.clickCanvas([[100,80]])`);

      // (p-1) SE 핸들(140,100) 위에서 커서가 바뀐다. 벗어나면 되돌아온다.
      await cdp.eval(`window.__gpvAnno.hover(140,100)`);
      const curOn = await cdp.eval(`window.__gpvAnno.cursor()`);
      await cdp.eval(`window.__gpvAnno.hover(20,190)`);
      const curOff = await cdp.eval(`window.__gpvAnno.cursor()`);
      r.check(
        "(p-1) SE 핸들 호버 → nwse-resize, 벗어나면 해제",
        curOn === "nwse-resize" && curOff === "",
        `on=${J(curOn)} off=${J(curOff)}`,
      );

      // (p-2) 방향키 1px × 3 → +3.
      for (let i = 0; i < 3; i++) {
        await cdp.eval(`window.__gpvAnno.key("ArrowRight")`);
      }
      const x1 = await cdp.eval(
        `Math.round(window.__gpv.imageEditor.getDoc().objects[0].x)`,
      );
      r.check("(p-2) ArrowRight ×3 → x +3", x1 === 63, `x=${x1} (기대 63)`);

      // (p-2b) 키 한 번 = 히스토리 한 칸 — undo 3회로 원위치.
      for (let i = 0; i < 3; i++) {
        await cdp.eval(`window.__gpvAnno.click(/실행 취소/)`);
      }
      const xu = await cdp.eval(
        `Math.round(window.__gpv.imageEditor.getDoc().objects[0].x)`,
      );
      r.check("(p-2b) undo 3회로 원위치(키 1회 = 히스토리 1칸)", xu === 60, `x=${xu} (기대 60)`);
      // undo 는 선택을 비운다(ImageEditor.undo). 방향키는 선택이 있어야 도므로 다시 집는다.
      await cdp.eval(`window.__gpvAnno.clickCanvas([[100,80]])`);

      // (p-3) Shift+방향키 = 10px.
      await cdp.eval(`window.__gpvAnno.key("ArrowRight", {shift:true})`);
      const x2 = await cdp.eval(
        `Math.round(window.__gpv.imageEditor.getDoc().objects[0].x)`,
      );
      r.check("(p-3) Shift+ArrowRight → +10", x2 === 70, `x=${x2} (기대 70)`);

      // (p-3b) auto-repeat 는 무시한다 — HISTORY_LIMIT(50)을 초 단위로 소진하는 것을 막는다.
      await cdp.eval(`window.__gpvAnno.key("ArrowRight", {repeat:true})`);
      const x2b = await cdp.eval(
        `Math.round(window.__gpv.imageEditor.getDoc().objects[0].x)`,
      );
      r.check("(p-3b) auto-repeat 방향키는 무시된다", x2b === 70, `x=${x2b} (기대 70)`);

      // (p-4) 우측 패널 입력에 포커스가 있으면 방향키를 잡지 않는다(슬라이더 회귀).
      const focused = await cdp.eval(
        `(()=>{const m=window.__gpvAnno.modal(); const i=m&&m.querySelector('input');
           if(!i) return false; i.focus(); return document.activeElement===i;})()`,
      );
      await cdp.eval(`window.__gpvAnno.key("ArrowRight")`);
      const x3 = await cdp.eval(
        `Math.round(window.__gpv.imageEditor.getDoc().objects[0].x)`,
      );
      await cdp.eval(`document.activeElement && document.activeElement.blur()`);
      r.check(
        "(p-4) 입력 포커스 중 방향키는 객체를 안 옮긴다",
        focused === true && x3 === 70,
        `focused=${focused} x=${x3} (기대 70)`,
      );

      // (p-5) HUD 는 화면 크롬 — 저장본에 남지 않는다. 여기서도 드래그를 **연 채로** 저장해
      // HUD 가 실제로 떠 있는 상태를 본다. 사각형 우하단 바깥이 HUD 자리다.
      await cdp.eval(`window.__gpv.imageEditor.setTool("rect")`);
      await cdp.eval(
        `window.__gpvAnno.pointerSeq([['down',30,120],['move',60,150],['move',90,170]])`,
      );
      const savedP = await saveAs("e2e-anno-hud.png", "e2e-anno-hud.png");
      created.push("e2e-anno-hud.png");
      if (r.check("(p) 손 피드백 상태 저장", savedP.ok, savedP.ok ? "" : savedP.why)) {
        // 드래프트 사각형은 (30,120)-(90,170) 이라 HUD 는 그 우하단 (96,176) 부근에 뜬다.
        const fP = await cdp.eval(
          `window.__gpvAnno.readSaved(${J(fix.projectId)}, "e2e-anno-hud.png", [[100,180],[120,185]])`,
        );
        r.check(
          "(p-5) 저장본에 HUD 라벨이 없다(드래그 중 상태로 저장)",
          !!fP && isWhite(fP.px[0]) && isWhite(fP.px[1]),
          fP ? `${show(fP.px[0])} ${show(fP.px[1])}` : "-",
        );
      }
    } else {
      r.skip("(p) 손 피드백", "편집기 재개 실패");
    }

    // ── (q) 세션 내 복구 배너 (설계 K6·K7) ────────────────────────────────
    if (await openEditor(fix.projectId, SRC)) {
      await setDoc({
        objects: [rectObj("q1", 30, 30, 50, 50, RED_HEX)],
        rotation: 90,
      });
      // Esc → "편집기 닫기" 확인 → 확인. (주석이 있으므로 확인창이 뜬다)
      await cdp.eval(`window.__gpvAnno.esc()`);
      await sleep(150);
      const confirmed = await cdp.eval(
        `(()=>{const st=window.__gpv.ui.getState(); const c=st.confirm; if(!c) return false;
           st.closeConfirm(); c.onConfirm(); return true;})()`,
      );
      await sleep(250);

      if (r.check("(q-0) Esc → 닫기 확인 후 편집기 닫힘", confirmed === true)) {
        // (q-1) 다시 열면 **문서는 비어 있고** 배너만 뜬다. 자동 복원은 openEditor 의
        //       fresh() 계약(objects.length===0)을 깨뜨린다 — 이 스위트가 거기 매달려 있다.
        const reopened = await openEditor(fix.projectId, SRC);
        const banner = await cdp.eval(`window.__gpvAnno.banner()`);
        r.check(
          "(q-1) 재오픈: 문서는 비고 배너만 뜬다(자동 복원 아님)",
          reopened === true && banner === true,
          `fresh=${reopened} banner=${banner}`,
        );

        // (q-2)(q-3) [이어서 하기] → objects·rotation 이 닫기 직전과 일치.
        const restored = await cdp.eval(
          `(()=>{const m=window.__gpvAnno.modal(); if(!m) return false;
             const b=Array.from(m.querySelectorAll('button')).find(x=>/이어서 하기/.test(x.textContent||''));
             if(!b) return false; b.click(); return true;})()`,
        );
        await sleep(200);
        const d = await getDoc();
        r.check(
          "(q-2) 이어서 하기 → objects 복원",
          restored === true &&
            d.objects.length === 1 &&
            Math.round(d.objects[0].x) === 30 &&
            Math.round(d.objects[0].w) === 50,
          `objects=${J(d.objects.map((o) => [Math.round(o.x), Math.round(o.w)]))}`,
        );
        r.check(
          "(q-3) 회전도 그대로 복원(델타 이중 적용 없음)",
          d.rotation === 90,
          `rotation=${d.rotation} (기대 90)`,
        );
        r.check(
          "(q-3b) 복원 후 배너가 사라진다",
          (await cdp.eval(`window.__gpvAnno.banner()`)) === false,
        );

        // (q-4) 저장 성공 시 stash 삭제(설계 R8) — **배너를 무시한 채** 제자리 저장해야
        // 그 계약이 발동한다. [이어서 하기]는 이미 stash 를 지우므로 그 뒤에 저장하면
        // 아무것도 검증하지 못한다. 그리고 다른 이름 저장은 원본을 안 건드려 지우지 않는다.
        await cdp.eval(`window.__gpvAnno.esc()`);
        await sleep(150);
        await cdp.eval(
          `(()=>{const st=window.__gpv.ui.getState(); const c=st.confirm;
             if(c){st.closeConfirm(); c.onConfirm();} return true;})()`,
        );
        await sleep(250);
        const reopen2 = await openEditor(fix.projectId, SRC);
        const banner2 = await cdp.eval(`window.__gpvAnno.banner()`);
        r.check(
          "(q-4a) 다시 닫으면 다시 stash 된다(배너 재등장)",
          reopen2 === true && banner2 === true,
          `fresh=${reopen2} banner=${banner2}`,
        );

        // 배너를 무시하고 새로 그린 뒤 **원본에 제자리 저장**한다.
        // 주의: 이 블록이 픽스처 SRC 를 덮어쓴다 — (q) 뒤에 SRC 를 쓰는 케이스를 두지 마라.
        await setDoc({ objects: [rectObj("q2", 10, 10, 20, 20, RED_HEX)] });
        const inPlace = await cdp.eval(
          `(()=>{ if(!window.__gpvAnno.click(/^\\s*저장/)) return 'button'; return 'ok'; })()`,
        );
        await sleep(150);
        await cdp.eval(
          `(()=>{const st=window.__gpv.ui.getState(); const c=st.confirm;
             if(c){st.closeConfirm(); c.onConfirm();} return true;})()`,
        );
        const closedQ = await poll(
          () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
          (v) => v === null,
        );
        if (
          r.check(
            "(q-4b) 원본에 제자리 저장",
            inPlace === "ok" && closedQ === null,
            `click=${inPlace} closed=${closedQ}`,
          ) &&
          (await openEditor(fix.projectId, SRC))
        ) {
          r.check(
            "(q-4c) 제자리 저장 후에는 배너가 없다(이중 주석 방지)",
            (await cdp.eval(`window.__gpvAnno.banner()`)) === false,
          );
        } else {
          r.skip("(q-4c) 저장 후 배너 없음", "저장 또는 재오픈 실패");
        }
      }
    } else {
      r.skip("(q) 복구 배너", "편집기 재개 실패");
    }
  } finally {
    // 정리 — 편집기·다이얼로그를 닫고 이 스위트가 만든 파일/중첩 레포를 전부 지운다.
    await cdp.eval(`window.__gpv.ui.getState().closeConfirm()`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closePrompt()`).catch(() => {});
    await closeEditor();
    await cdp.eval(`delete window.__gpvAnno`).catch(() => {});
    for (const rel of created) {
      try {
        unlinkSync(join(fix.repo, rel));
      } catch {
        /* 이미 없으면 무해 — fixture cleanup 이 통째로 지운다 */
      }
    }
    if (embMade) {
      try {
        rmSync(join(fix.repo, EMB), { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* noop */
      }
    }
  }
}
