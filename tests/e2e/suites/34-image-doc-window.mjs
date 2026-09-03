// 태스크 30 — 이미지를 별도 OS 창(`doc-*`)으로 열고 **그 창 안에서** 편집·저장한다.
//
// 검증하는 계약은 세 가지다:
//   ① `openDocWindow` 가 doc 창을 띄우고, 그 창이 이미지를 `<img>` 로 그린다(터미널 창이 아니다).
//   ② 그 창에 편집기와 호스트 3종(Toasts·ConfirmHost·PromptHost)이 **함께** 마운트돼 있다.
//      스토어는 창마다 별개라(웹뷰 = 별도 JS 컨텍스트) 메인 창의 호스트가 대신 그려 주지 않는다 —
//      그래서 스토어 상태가 아니라 **그 창의 DOM**으로 확인한다.
//   ③ doc 창에서 저장하면 **메인 창의** `file-image` 캐시가 무효화된다(워처 → `repo://changed`
//      → events.ts). 이게 빠지면 메인에 열려 있던 같은 이미지가 옛 그림으로 남는다
//      (staleTime Infinity라 스스로 다시 읽지 않는다).
//
// 창 접속은 `connectLabel` 로 한다 — 러너의 `cdp` 는 라벨 `main` 페이지 하나이고, doc 창은
// 타이틀이 파일명이라 `connect()` 의 타이틀 필터에 아예 걸리지 않는다.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { connectLabel } from "../lib/cdp.mjs";

export const name = "이미지 문서 창 (openDocWindow → doc-* 창 편집기·저장 반영)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const WIN_API = "/node_modules/@tauri-apps/api/webviewWindow.js";

const RED = [255, 59, 48]; // DEFAULT_STROKE (#FF3B30)

/** 단색 PNG base64 — 메인 페이지에서 픽스처 이미지를 만든다(30 스위트 solidPng 와 같은 방식). */
const SOLID_PNG = `(() => {
  const c = document.createElement('canvas');
  c.width = 200;
  c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, 200, 200);
  return c.toDataURL('image/png').split(',')[1];
})()`;

/**
 * doc 창에 설치하는 최소 헬퍼. 30 스위트의 `__gpvAnno` 는 **메인 페이지에만** 있다 —
 * 창마다 JS 컨텍스트가 따로라 이 창에서는 보이지 않는다. 여기서는 이 스위트가 쓰는 만큼만 갖는다.
 */
const DOC_HELPERS = `(() => {
  const A = {};
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 이미지 편집기 모달(헤더 문구로 확인·프롬프트 다이얼로그와 가른다). */
  A.modal = () =>
    Array.from(document.querySelectorAll('div.fixed.inset-0.z-50'))
      .find((el) => /이미지 편집/.test(el.textContent || '')) || null;

  /**
   * 확인·프롬프트 호스트가 **이 창에** 실제로 그려졌는가. 둘 다 z-[60] 오버레이라
   * 편집기 모달(z-50)과 섞이지 않는다 — 스토어 상태로는 호스트 마운트를 증명하지 못한다.
   */
  A.overlay = (re) =>
    Array.from(document.querySelectorAll('div.fixed.inset-0')).some(
      (el) => el.className.includes('z-[60]') && re.test(el.textContent || ''),
    );

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

  /** rAF 두 번 — 레이어가 코얼레싱한 페인트가 실제로 끝난 뒤를 보장한다. */
  A.frame = () =>
    new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  /** 편집기가 이 창에서 그릴 준비를 마쳤는가(베이스+주석 캔버스 2장 + 이미지 로드). */
  A.ready = () => {
    const ed = window.__gpv && window.__gpv.imageEditor;
    if (!ed) return false;
    const m = A.modal();
    const cs = m ? Array.from(m.querySelectorAll('canvas')) : [];
    return cs.length >= 2 && cs[1].width > 0 && ed.getDoc().outW > 0;
  };

  A.setDoc = async (patch) => {
    window.__gpv.imageEditor.setDoc(patch);
    await A.frame();
    window.__gpv.imageEditor.renderOnce();
    await A.frame();
    return true;
  };

  /** 백킹 px 좌표의 주석 캔버스 픽셀 [r,g,b,a]. */
  A.px = (x, y) => {
    const m = A.modal();
    const cs = m ? Array.from(m.querySelectorAll('canvas')) : [];
    if (cs.length < 2) return null;
    const d = cs[1].getContext('2d').getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  };

  A.esc = async () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await sleepMs(200);
    return true;
  };

  /**
   * '다른 이름으로' 저장을 구동한다. 프롬프트 **DOM 이 이 창에 떴는지**를 함께 돌려주고,
   * 값 확정은 입력 타이밍이 흔들리지 않게 스토어 요청 객체로 한다(30 스위트와 같은 방식).
   */
  A.saveAs = async (fileName) => {
    if (!A.click(/다른 이름으로/)) return { ok: false, why: 'button' };
    await sleepMs(150);
    const dom = A.overlay(/다른 이름으로 저장/);
    const st = window.__gpv.ui.getState();
    const req = st.prompt;
    if (!req) return { ok: false, why: 'prompt', dom: dom };
    const def = req.defaultValue || '';
    st.closePrompt();
    req.onConfirm(fileName);
    return { ok: true, dom: dom, defaultValue: def };
  };

  /** 저장된 파일을 다시 읽어 디코드하고 한 점을 샘플링한다(0바이트 파일이 통과하지 않게). */
  A.savedPx = async (projectId, relPath, x, y) => {
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
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { w: c.width, h: c.height, px: [d[0], d[1], d[2], d[3]] };
  };

  window.__gpvDoc = A;
  return true;
})()`;

/** 색 근사 비교(인코딩 라운딩 여유). */
const near = (px, rgb, tol = 3) =>
  Array.isArray(px) &&
  Math.abs(px[0] - rgb[0]) <= tol &&
  Math.abs(px[1] - rgb[1]) <= tol &&
  Math.abs(px[2] - rgb[2]) <= tol &&
  px[3] > 200;

const show = (px) => (Array.isArray(px) ? `rgba(${px.join(",")})` : String(px));

/** 채움 사각형 객체(테두리 없음). */
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

export async function run({ cdp, report: r, fix, port }) {
  const cdpPort = port ?? cdp.cdpPort ?? 29222;
  const SRC = "e2e.png"; // 픽스처 원본
  const OUT = "e2e-doc.png"; // doc 창에서 '다른 이름으로' 저장한 결과
  const created = [SRC];

  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.openDocWindow && window.__gpv.queryClient)`,
  );
  if (!hooks) {
    r.skip("이미지 문서 창", "window.__gpv.openDocWindow/queryClient 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const arr = (v) => (Array.isArray(v) ? v : []);
  const labels = () =>
    cdp.eval(
      `(async()=>{ try{ const m=await import(${J(WIN_API)}); return (await m.getAllWebviewWindows()).map(w=>w.label); }catch(e){ return ['ERR:'+String(e.message||e)]; } })()`,
    );
  const closeLabel = (label) =>
    cdp
      .eval(
        `(async()=>{ try{ const m=await import(${J(WIN_API)}); for(const w of await m.getAllWebviewWindows()){ if(w.label===${J(label)}) await w.close(); } return true; }catch(e){ return false; } })()`,
      )
      .catch(() => false);

  const poll = async (fn, ok, tries = 30, ms = 500) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  // 메인 창이 들고 있는 그 이미지의 캐시 — ③ 의 관측 지점(useFileImage 와 같은 키).
  const MAIN_KEY = ["file-image", fix.projectId, SRC];
  const mainInvalidated = () =>
    cdp.eval(
      `(()=>{ const s = window.__gpv.queryClient.getQueryState(${J(MAIN_KEY)}); return s ? !!s.isInvalidated : null; })()`,
    );

  let docLabel = null;
  let dcdp = null;

  try {
    // ── 셋업: 픽스처 이미지 ────────────────────────────────────────────────
    const b64 = await cdp.eval(SOLID_PNG);
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

    // ── ① doc 창 열기 ──────────────────────────────────────────────────────
    // 이미지 더블클릭이 부르는 것과 **같은 호출**이다(FileTreePanel onDouble → openDocWindow).
    // 더블클릭 자체는 트리 행 DOM에 의존해 취약하므로 계약(호출)을 직접 구동한다.
    const before = arr(await labels());
    await cdp.eval(
      `window.__gpv.openDocWindow(${J(fix.projectId)}, ${J(SRC)}, { size: [1180, 860] })`,
    );
    docLabel = await poll(
      async () =>
        arr(await labels()).find((l) => l.startsWith("doc-") && !before.includes(l)) ?? null,
      (v) => !!v,
      20,
      500,
    );
    if (!r.check("openDocWindow: doc-* OS 창 생성됨", !!docLabel, docLabel || "미발견")) return;

    dcdp = await connectLabel(docLabel, { port: cdpPort }).catch((e) => {
      r.check("doc 창 CDP 연결", false, e.message);
      return null;
    });
    if (!dcdp) return;
    r.check("doc 창 CDP 연결(connectLabel — 타이틀이 파일명이라 connect()로는 못 찾는다)", true, docLabel);

    const imgs = await poll(
      () => dcdp.eval(`document.querySelectorAll('img').length`),
      (n) => typeof n === "number" && n > 0,
      30,
      500,
    );
    const xterms = await dcdp.eval(`document.querySelectorAll('.xterm').length`);
    r.check("doc 창이 이미지 뷰어를 그린다(<img> 존재, 터미널 아님)", imgs > 0 && xterms === 0, `img=${imgs} xterm=${xterms}`);

    // 크기 요청이 실제로 먹었는가 — 기본 900×760이면 편집기 우측 패널(w-72 고정)이 stage를
    // 눌러 이 창에서 편집이 좁아진다(태스크 30 §3.2). 논리 좌표로 본다(고DPI에서 물리 px은
    // 배율이 곱해진다). 창 장식이 없어(decorations:false) 뷰포트 = 창 내부 크기다.
    const size = await dcdp.eval(`[window.innerWidth, window.innerHeight]`);
    r.check(
      "doc 창이 요청 크기 1180×860으로 열린다(open_doc_window size 인자)",
      arr(size)[0] === 1180 && arr(size)[1] === 860,
      `${arr(size).join("×")} — 900×760이면 Rust가 size를 무시한 것`,
    );

    // ── ② 편집기 + 호스트가 이 창에 마운트돼 있는가 ────────────────────────
    const installed = await dcdp.eval(DOC_HELPERS);
    if (!r.check("doc 창 페이지 헬퍼 설치", installed === true)) return;

    // ImageView의 [편집] 버튼과 같은 경로 — 그 창의 스토어에 경로·저장소 id를 세운다.
    await dcdp.eval(
      `window.__gpv.ui.getState().openImageEditor(${J(SRC)}, ${J(fix.projectId)})`,
    );
    const editorPath = await poll(
      () => dcdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
      (v) => v === SRC,
      20,
      250,
    );
    const ready = await poll(
      () => dcdp.eval(`window.__gpvDoc.ready()`),
      (v) => v === true,
      40,
      250,
    );
    r.check(
      "doc 창 [편집] → 그 창의 편집기가 실제로 뜬다(모달 DOM + __gpv.imageEditor)",
      editorPath === SRC && ready === true,
      `imageEditorPath=${J(editorPath)} ready=${ready}`,
    );
    if (ready !== true) return;

    // 토스트 호스트 — 편집기의 성공·실패 알림이 이 창에 그려져야 한다.
    await dcdp.eval(`window.__gpv.ui.getState().pushToast("success","e2e-doc-toast")`);
    const toast = await poll(
      () => dcdp.eval(`document.body.textContent.includes('e2e-doc-toast')`),
      (v) => v === true,
      10,
      200,
    );
    r.check("doc 창에 Toasts 호스트 마운트(토스트가 그려진다)", toast === true);
    await dcdp
      .eval(`(()=>{ const u=window.__gpv.ui.getState(); u.toasts.forEach(t=>u.dismissToast(t.id)); })()`)
      .catch(() => {});

    // 주석 1개 — 이후 저장 픽셀 단언과 ConfirmHost 확인(Esc 계층 7)에 함께 쓴다.
    await dcdp.eval(`window.__gpvDoc.setDoc(${J({ objects: [rectObj("d1", 40, 40, 120, 120, "#FF3B30")] })})`);
    const preview = await dcdp.eval(`window.__gpvDoc.px(100, 100)`);
    r.check("doc 창 편집기 프리뷰에 주석이 그려짐", near(preview, RED), show(preview));

    // ConfirmHost — 주석이 남은 채 Esc 면 확인 다이얼로그가 **이 창에** 떠야 한다.
    await dcdp.eval(`window.__gpvDoc.esc()`);
    const confirmDom = await dcdp.eval(`window.__gpvDoc.overlay(/편집기 닫기/)`);
    const stillOpen = await dcdp.eval(`window.__gpv.ui.getState().imageEditorPath !== null`);
    r.check(
      "doc 창에 ConfirmHost 마운트(Esc 계층 7 확인 다이얼로그가 그려진다)",
      confirmDom === true && stillOpen === true,
      `confirmDOM=${confirmDom} 편집기유지=${stillOpen}`,
    );
    await dcdp.eval(`window.__gpv.ui.getState().closeConfirm()`);
    await sleep(150);

    // ── ③ 저장 → 메인 창 file-image 캐시 무효화 ────────────────────────────
    // 저장 **전에** 메인 캐시를 심어 둔다 — 무효화는 "있던 항목"에만 표시되므로,
    // 심지 않으면 events.ts에서 그 줄을 지워도 이 검사가 통과해 버린다(회귀 감지 불능).
    await cdp.eval(
      `window.__gpv.queryClient.setQueryData(${J(MAIN_KEY)}, { mime: "image/png", base64: ${J(b64)} })`,
    );
    const seededFresh = await mainInvalidated();
    r.check(
      "사전: 메인 창의 file-image 캐시가 유효(isInvalidated=false)",
      seededFresh === false,
      `isInvalidated=${seededFresh}`,
    );

    const saved = await dcdp.eval(`window.__gpvDoc.saveAs(${J(OUT)})`);
    created.push(OUT);
    r.check(
      "doc 창에 PromptHost 마운트('다른 이름으로 저장' 입력 다이얼로그가 그려진다)",
      !!saved && saved.dom === true,
      saved ? `dom=${saved.dom} why=${saved.why ?? ""}` : "(eval 실패)",
    );
    const closed = await poll(
      () => dcdp.eval(`window.__gpv.ui.getState().imageEditorPath`),
      (v) => v === null,
      40,
      250,
    );
    const onDisk = await poll(
      async () => existsSync(join(fix.repo, OUT)),
      (v) => v === true,
      20,
      250,
    );
    r.check(
      "doc 창에서 저장 완료(편집기 닫힘 + 파일 생성)",
      !!saved && saved.ok === true && closed === null && onDisk === true,
      `why=${saved?.why ?? ""} closed=${closed} disk=${onDisk}`,
    );

    if (onDisk === true) {
      const file = await dcdp.eval(
        `window.__gpvDoc.savedPx(${J(fix.projectId)}, ${J(OUT)}, 100, 100)`,
      );
      r.check(
        "저장 파일이 doc 창 프리뷰와 같은 그림(200×200, (100,100) 빨강)",
        file?.w === 200 && file?.h === 200 && near(file?.px, RED),
        `${file?.w}×${file?.h} px=${show(file?.px)}`,
      );
    }

    // 워처(400ms 디바운스) → repo://changed → events.ts(250ms 코얼레싱) 경로.
    const invalidated = await poll(mainInvalidated, (v) => v === true, 30, 500);
    r.check(
      "저장이 **메인 창의** file-image 캐시를 무효화한다(events.ts repo://changed 목록)",
      invalidated === true,
      `isInvalidated=${invalidated} — false면 메인에 열려 있던 같은 이미지가 옛 그림으로 남는다`,
    );
  } finally {
    // 정리 — 다이얼로그·편집기를 닫고, CDP 를 먼저 끊은 뒤 창을 닫는다(연결을 남기면
    // 창이 죽을 때 러너 쪽 WebSocket 이 함께 요란하게 끊긴다 — 13 스위트와 같은 순서).
    if (dcdp) {
      await dcdp.eval(`window.__gpv.ui.getState().closeConfirm()`).catch(() => {});
      await dcdp.eval(`window.__gpv.ui.getState().closePrompt()`).catch(() => {});
      await dcdp.eval(`window.__gpv.ui.getState().closeImageEditor()`).catch(() => {});
      await dcdp.eval(`delete window.__gpvDoc`).catch(() => {});
      dcdp.close();
    }
    if (docLabel) {
      await closeLabel(docLabel);
      // 창 대상 기록(localStorage `gp:doc-windows`)은 창이 닫혀도 남는다 — 이 실행분만 지운다.
      await cdp
        .eval(
          `(()=>{ try{ const k='gp:doc-windows'; const v=JSON.parse(localStorage.getItem(k)||'{}');
             delete v[${J(docLabel.slice("doc-".length))}]; localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } })()`,
        )
        .catch(() => {});
    }
    await cdp
      .eval(`window.__gpv.queryClient.removeQueries({ queryKey: ${J(["file-image", fix.projectId])} })`)
      .catch(() => {});
    for (const rel of created) {
      try {
        unlinkSync(join(fix.repo, rel));
      } catch {
        /* 이미 없으면 무해 — fixture cleanup 이 통째로 지운다 */
      }
    }
    await sleep(300);
  }
}
