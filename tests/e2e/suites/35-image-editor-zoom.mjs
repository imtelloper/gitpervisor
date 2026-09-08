// 이미지 편집기의 **화면 줌**(휠) 회귀 — 30 스위트가 전제하는 좌표 계약을 지키는지 본다.
//
// 줌은 CSS transform 한 겹일 뿐이어야 한다. 이 스위트가 지키는 계약 셋:
//   ① 백킹 스토어(previewScale/backW/backH)는 줌과 무관하게 불변이다. 누군가 "확대하면
//      흐리다"며 백킹에 줌을 곱하는 순간 30 스위트의 좌표 리터럴 수십 개가 한꺼번에
//      어긋나는데, 그때 나오는 것은 원인 불명의 픽셀 diff 뿐이다. 여기서 이름으로 잡는다.
//   ② 휠 줌은 **커서 아래 점을 제자리에 둔다**. transform-origin 오설정과, React onWheel
//      (passive)을 써서 preventDefault 가 안 먹는 회귀를 동시에 잡는다.
//   ③ 확대·이동한 상태에서 그린 주석이 **파일 좌표에 그대로** 앉는다. 줌이 표시용을 넘어
//      문서 좌표로 새어 들어가면 저장 파일 픽셀로 드러난다.
//
// 30·34 스위트는 건드리지 않는다(둘 다 자체 헬퍼를 갖고 있고 34 는 doc 창 자원을 쓴다).
// 여기서는 메인 창에서 `useUi.openImageEditor` 로만 편집기를 열어 창 자원이 겹치지 않는다.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const name = "이미지 편집기 줌 (휠 확대·축소 / 백킹 불변 / 줌 상태 WYSIWYG)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const RED = [255, 59, 48]; // DEFAULT_STROKE (#FF3B30)

/**
 * 페이지 헬퍼. 30 의 HELPERS 는 지역 템플릿 문자열이라 재사용할 수 없어(34 도 같은 이유로
 * 복제해 뒀다) 필요한 것만 옮겨 담는다.
 */
const HELPERS = `(() => {
  const A = {};
  window.__gpvZoom = A;

  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50')).find((el) =>
      /이미지 편집/.test(el.textContent || ''),
    ) || null;

  A.canvases = () => {
    const m = A.modal();
    return m ? Array.from(m.querySelectorAll('canvas')) : [];
  };

  A.ready = () => {
    const cs = A.canvases();
    return cs.length >= 2 && cs[1].width > 0;
  };

  /** rAF 두 번 — 레이어가 코얼레싱한 페인트가 실제로 끝난 뒤를 보장한다. */
  A.frame = () =>
    new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  /** 두 캔버스의 백킹 크기 — 줌 전후로 같아야 한다. */
  A.backing = () => {
    const cs = A.canvases();
    if (cs.length < 2) return null;
    return [cs[0].width, cs[0].height, cs[1].width, cs[1].height];
  };

  /** 주석 캔버스의 화면 사각형(줌·팬이 반영된 값). */
  A.rect = () => {
    const c = A.canvases()[1];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  /** 백킹 px → client 좌표 (30 스위트의 pointerSeq 와 같은 식). */
  A.toClient = (bx, by) => {
    const c = A.canvases()[1];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: r.left + (bx / c.width) * r.width,
      y: r.top + (by / c.height) * r.height,
    };
  };

  /** client 좌표 → 백킹 px (AnnotationLayer.toOriented 의 역식과 같은 매핑). */
  A.toBacking = (cx, cy) => {
    const c = A.canvases()[1];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return {
      x: ((cx - r.left) / Math.max(1, r.width)) * c.width,
      y: ((cy - r.top) / Math.max(1, r.height)) * c.height,
    };
  };

  /**
   * 휠 한 번. **stage 에 쏜다** — 리스너가 거기 붙어 있다(캔버스가 아니다).
   * cancelable 이어야 preventDefault 회귀(passive 리스너)를 잡을 수 있다.
   */
  A.wheel = async (clientX, clientY, deltaY) => {
    const m = A.modal();
    if (!m) return false;
    const stage = m.querySelector('.checkerboard');
    if (!stage) return 'no-stage';
    const ev = new WheelEvent('wheel', {
      deltaY,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    stage.dispatchEvent(ev);
    await A.frame();
    return ev.defaultPrevented;
  };

  /** 가운데 버튼 드래그 팬. */
  A.pan = async (dx, dy) => {
    const m = A.modal();
    if (!m) return false;
    const stage = m.querySelector('.checkerboard');
    if (!stage) return false;
    const P = Element.prototype;
    const o = { s: P.setPointerCapture, r: P.releasePointerCapture, h: P.hasPointerCapture };
    P.setPointerCapture = function () {};
    P.releasePointerCapture = function () {};
    P.hasPointerCapture = function () { return true; };
    try {
      const r = stage.getBoundingClientRect();
      const x0 = r.left + r.width / 2;
      const y0 = r.top + r.height / 2;
      const mk = (t, x, y, btn, btns) =>
        new PointerEvent(t, {
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, button: btn, buttons: btns,
          pointerId: 2000, pointerType: 'mouse', isPrimary: true,
        });
      stage.dispatchEvent(mk('pointerdown', x0, y0, 1, 4));
      stage.dispatchEvent(mk('pointermove', x0 + dx, y0 + dy, -1, 4));
      stage.dispatchEvent(mk('pointerup', x0 + dx, y0 + dy, 1, 0));
      await A.frame();
      return true;
    } finally {
      P.setPointerCapture = o.s;
      P.releasePointerCapture = o.r;
      P.hasPointerCapture = o.h;
    }
  };

  /** 합성 포인터 시퀀스(백킹 px). 실제 포인터가 없어 캡처 API 를 무해화한다. */
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
        const r = c.getBoundingClientRect();
        const cx = r.left + (st[1] / c.width) * r.width;
        const cy = r.top + (st[2] / c.height) * r.height;
        c.dispatchEvent(
          new PointerEvent('pointer' + st[0], {
            bubbles: true, cancelable: true, composed: true,
            clientX: cx, clientY: cy,
            button: 0, buttons: st[0] === 'up' ? 0 : 1,
            pointerId: 1001, pointerType: 'mouse', isPrimary: true,
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

  A.click = (re) => {
    const m = A.modal();
    if (!m) return false;
    const b = Array.from(m.querySelectorAll('button')).find((x) =>
      re.test((x.textContent || '') + ' ' + (x.title || '')),
    );
    if (!b) return false;
    b.click();
    return true;
  };

  /** '다른 이름으로' 저장을 스토어로 구동한다(다이얼로그 타이밍 흔들림 제거). */
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

  /** 저장 파일을 디코드해 색 픽셀의 개수·바운딩 박스를 돌려준다. */
  A.readSaved = async (projectId, relPath, color, tol) => {
    const res = await window.__TAURI_INTERNALS__.invoke('read_file_base64', {
      projectId, relPath,
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
    const t = tol == null ? 30 : tol;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const o2 = (y * c.width + x) * 4;
        if (
          Math.abs(d[o2] - color[0]) <= t &&
          Math.abs(d[o2 + 1] - color[1]) <= t &&
          Math.abs(d[o2 + 2] - color[2]) <= t &&
          d[o2 + 3] > 200
        ) {
          n++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    const corner = ctx.getImageData(5, 5, 1, 1).data;
    return { w: c.width, h: c.height, n, minX, minY, maxX, maxY,
             corner: [corner[0], corner[1], corner[2]] };
  };

  /** 단색 PNG base64 — 픽스처. */
  A.solidPng = (w, h, css) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = css;
    x.fillRect(0, 0, w, h);
    return c.toDataURL('image/png').split(',')[1];
  };

  return true;
})()`;

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!(window.__gpv && window.__gpv.ui)`);
  if (!hasStore) {
    r.skip("이미지 편집기 줌", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const SRC = "e2e-zoom-src.png";
  const OUT = "e2e-zoom-out.png";
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
  const closeEditor = () =>
    cdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});

  try {
    const installed = await cdp.eval(HELPERS);
    if (!r.check("페이지 헬퍼 설치", installed === true)) return;

    const b64 = await cdp.eval(`window.__gpvZoom.solidPng(200, 200, '#ffffff')`);
    const seed = await cdp.try("write_file_bytes", {
      projectId: fix.projectId,
      relPath: SRC,
      base64: b64,
      overwrite: true,
    });
    if (
      !r.check(
        "픽스처 PNG(200×200 흰색) 생성",
        seed.ok && existsSync(join(fix.repo, SRC)),
        seed.ok ? "" : seed.code || "",
      )
    ) {
      return;
    }

    await closeEditor();
    await sleep(200);
    // 사이드카에 남은 편집 문서를 먼저 지운다 — 태스크 41 자동 복원이 이 스위트의
    // "새로 연 편집기는 비어 있다" 전제를 깬다(직전 회차가 남긴 문서가 되살아난다).
    // (편집기가 닫혀 있어 __gpv.imageDocs 훅이 없다 — 커맨드를 직접 부른다.)
    await cdp.try("image_doc_delete", { projectId: fix.projectId, relPath: SRC });
    await cdp.eval(
      `window.__gpv.ui.getState().openImageEditor(${J(SRC)}, ${J(fix.projectId)})`,
    );
    const ready = await poll(
      () => cdp.eval(`window.__gpvZoom.ready()`).catch(() => false),
      (v) => v === true,
    );
    if (!r.check("편집기 열림", ready === true, ready ? "" : "ready() 타임아웃")) {
      return;
    }

    // ── ① 백킹 스토어는 줌과 무관하게 불변 ─────────────────────────────────
    //
    // 200px 픽스처라 previewScale = min(1, 1800/200) = 1 → 백킹 px == oriented px == 파일 px.
    // 30 스위트의 좌표 리터럴 전부가 이 등식 위에 서 있다. 줌이 백킹에 스며들면 여기서 죽는다.
    const back0 = await cdp.eval(`window.__gpvZoom.backing()`);
    const rect0 = await cdp.eval(`window.__gpvZoom.rect()`);
    r.check(
      "(a) 백킹 = 200×200 (previewScale 1, 줌 이전)",
      JSON.stringify(back0) === JSON.stringify([200, 200, 200, 200]),
      `backing=${JSON.stringify(back0)}`,
    );

    const c0 = await cdp.eval(`window.__gpvZoom.toClient(100, 100)`);
    for (let i = 0; i < 6; i++) {
      await cdp.eval(
        `window.__gpvZoom.wheel(${c0.x}, ${c0.y}, -100)`,
      );
    }
    const back1 = await cdp.eval(`window.__gpvZoom.backing()`);
    const rect1 = await cdp.eval(`window.__gpvZoom.rect()`);
    r.check(
      "(a-1) 확대해도 백킹 크기는 그대로(줌은 CSS 변환 한 겹뿐)",
      JSON.stringify(back1) === JSON.stringify(back0),
      `before=${JSON.stringify(back0)} after=${JSON.stringify(back1)}`,
    );
    r.check(
      "(a-2) 화면 사각형은 실제로 커졌다",
      rect0 && rect1 && rect1.width > rect0.width * 1.2,
      `${rect0 ? Math.round(rect0.width) : "-"} → ${rect1 ? Math.round(rect1.width) : "-"} px`,
    );

    // ── ② 휠 줌이 커서 아래 점을 제자리에 둔다 + preventDefault 가 먹는다 ──
    //
    // transform-origin 을 0 0 이 아닌 값으로 두면 어긋나고, React 의 onWheel(passive)로
    // 배선하면 defaultPrevented 가 false 로 잡힌다(그 경우 WebView2 가 페이지째 확대한다).
    const anchor = await cdp.eval(`window.__gpvZoom.toClient(150, 50)`);
    const prevented = await cdp.eval(
      `window.__gpvZoom.wheel(${anchor.x}, ${anchor.y}, -100)`,
    );
    const backAt = await cdp.eval(
      `window.__gpvZoom.toBacking(${anchor.x}, ${anchor.y})`,
    );
    r.check(
      "(b-1) 휠 이벤트가 preventDefault 된다(non-passive 리스너)",
      prevented === true,
      `defaultPrevented=${prevented}`,
    );
    r.check(
      "(b-2) 커서 아래 점이 제자리에 남는다 — (150,50) ±1",
      !!backAt && Math.abs(backAt.x - 150) <= 1 && Math.abs(backAt.y - 50) <= 1,
      backAt ? `(${backAt.x.toFixed(2)}, ${backAt.y.toFixed(2)})` : "rect 없음",
    );

    // ── ③ 확대·이동 상태에서 그린 주석이 파일 좌표에 그대로 앉는다 ─────────
    //
    // 줌은 **표시**만이어야 한다. 문서 좌표(objects)나 출력 변환에 새어 들어가면 저장
    // 파일에서 사각형이 밀리거나 크기가 달라진다. 캔버스 rect 로 정·역변환하므로 확대·팬이
    // 얼마든 걸려 있어도 백킹 (40,40)-(160,160) 은 파일 (40,40)-(160,160) 이어야 한다.
    await cdp.eval(`window.__gpvZoom.pan(60, -40)`);
    await cdp.eval(`window.__gpv.imageEditor.setTool("rect")`);
    await sleep(120);
    await cdp.eval(
      `window.__gpvZoom.pointerSeq([['down',40,40],['move',100,100],['up',160,160]])`,
    );
    await sleep(150);
    const objs = await cdp.eval(
      `window.__gpv.imageEditor.getDoc().objects.map(o => [o.kind, Math.round(o.x), Math.round(o.y), Math.round(o.w), Math.round(o.h)])`,
    );
    r.check(
      "(c-1) 확대·이동 중 그린 사각형의 문서 좌표가 (40,40,120,120)",
      Array.isArray(objs) &&
        objs.length === 1 &&
        objs[0][0] === "rect" &&
        Math.abs(objs[0][1] - 40) <= 2 &&
        Math.abs(objs[0][2] - 40) <= 2 &&
        Math.abs(objs[0][3] - 120) <= 3 &&
        Math.abs(objs[0][4] - 120) <= 3,
      `objects=${JSON.stringify(objs)}`,
    );

    const saved = await cdp.eval(`window.__gpvZoom.saveAs(${J(OUT)})`);
    const closed = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
      (v) => v === null,
    );
    const onDisk = await poll(
      async () => existsSync(join(fix.repo, OUT)),
      (v) => v === true,
      20,
      200,
    );
    if (
      r.check(
        "(c) 줌 상태에서 저장",
        saved && saved.ok && closed === null && onDisk === true,
        saved && saved.ok ? `closed=${closed} onDisk=${onDisk}` : saved && saved.why,
      )
    ) {
      const f = await cdp.eval(
        `window.__gpvZoom.readSaved(${J(fix.projectId)}, ${J(OUT)}, ${J(RED)}, 30)`,
      );
      r.check(
        "(c-2) 저장본은 200×200 원본 크기 그대로(줌이 출력에 새지 않는다)",
        f && f.w === 200 && f.h === 200,
        f ? `${f.w}×${f.h}` : "디코드 실패",
      );
      r.check(
        "(c-3) 저장본의 사각형이 파일 좌표 (40,40)-(160,160) ±2",
        f &&
          f.n > 0 &&
          Math.abs(f.minX - 40) <= 2 &&
          Math.abs(f.minY - 40) <= 2 &&
          Math.abs(f.maxX - 160) <= 2 &&
          Math.abs(f.maxY - 160) <= 2,
        f ? `n=${f.n} bbox=(${f.minX},${f.minY})-(${f.maxX},${f.maxY})` : "-",
      );
      r.check(
        "(c-4) 사각형 밖(5,5)은 흰색 — 줌이 그림을 밀어 놓지 않았다",
        f && f.corner[0] > 240 && f.corner[1] > 240 && f.corner[2] > 240,
        f ? `corner=${JSON.stringify(f.corner)}` : "-",
      );
    }
  } finally {
    // 편집기가 열린 채 끝나면 z-50 백드롭이 다음 스위트의 클릭을 삼킨다.
    await cdp.eval(`window.__gpv.ui.getState().closeConfirm()`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closePrompt()`).catch(() => {});
    await closeEditor();
    await cdp.eval(`delete window.__gpvZoom`).catch(() => {});
    for (const rel of created) {
      try {
        unlinkSync(join(fix.repo, rel));
      } catch {
        /* 이미 없으면 무해 — fixture cleanup 이 통째로 지운다 */
      }
    }
  }
}
