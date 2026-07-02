// 프론트(DOM) 기능 e2e — 실제 키보드/클릭/우클릭/포인터로 구동하고 결과를 DOM·스토어로 단언한다.
// dev 빌드가 노출한 window.__gpv(ui·terminals·queryClient)로 픽스처 선택·상태확인·정리를 안정화한다.
// 모두 픽스처 프로젝트에서만 동작하고, 끝나면 만든 터미널/모아보기/선택/Log 상태를 원복한다.
//
// 순서 주의: 이미지 뷰어(프론트 IPC call 래퍼 경유)는 터미널 대량 개폐가 만든 IPC 게이트 혼잡에
// 막혀 로딩이 걸릴 수 있어, 터미널 조작 "전" 깨끗한 상태에서 먼저 검증한다(메모: WebView2 IPC 함정).
import { unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "프론트 DOM 기능 (사이드바 이동 / 이미지뷰어 / 그리드분할 / Ctrl+W / 모아보기·단축키 / Log 리사이즈)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!window.__gpv`);
  if (!hasStore) {
    r.skip("프론트 DOM 기능", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const J = (v) => JSON.stringify(v);
  const uGet = (p) => cdp.eval(`window.__gpv.ui.getState().${p}`);
  const selectProject = (id) =>
    cdp.eval(`window.__gpv.ui.getState().selectProject(${J(id)})`);
  const xtermCount = () => cdp.eval(`document.querySelectorAll('.xterm').length`);
  const poll = async (fn, ok, tries = 28, ms = 300) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const ensureFixture = async () => {
    await selectProject(fix.projectId);
    return poll(() => uGet("selectedProjectId"), (v) => v === fix.projectId, 10, 200);
  };

  const origSel = await uGet("selectedProjectId");
  const origLogOpen = await uGet("logOpen");
  const origLogHeight = await uGet("logHeight");
  let tabId = null;
  let tabClosed = false;

  try {
    // ── 셋업: 픽스처는 원시 invoke로 추가돼 UI 캐시에 없을 수 있다 → projects 쿼리 갱신 후 선택.
    //    선택이 박혀야(=목록에 픽스처 존재) 이후 테스트가 사용자 프로젝트가 아닌 픽스처에서 격리 실행된다.
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(500);
    const stuck = await ensureFixture();
    if (
      !r.check(
        "픽스처 프로젝트 선택(이후 테스트 격리)",
        stuck === fix.projectId,
        `selected=${String(stuck).slice(0, 8)}`,
      )
    ) {
      return; // 픽스처를 못 고르면 사용자 UI를 건드리므로 중단
    }

    // ── #1 사이드바 Ctrl+Shift+↑/↓ 이동 ──
    const sel0 = await uGet("selectedProjectId");
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',ctrlKey:true,shiftKey:true,bubbles:true}))`,
    );
    const selDown = await poll(() => uGet("selectedProjectId"), (v) => v !== sel0, 10, 250);
    r.check(
      "Ctrl+Shift+↓: 선택 프로젝트 이동",
      selDown !== sel0,
      `${String(sel0).slice(0, 8)}→${String(selDown).slice(0, 8)}`,
    );
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',ctrlKey:true,shiftKey:true,bubbles:true}))`,
    );
    const selUp = await poll(() => uGet("selectedProjectId"), (v) => v === sel0, 10, 250);
    r.check("Ctrl+Shift+↑: 원위치 복귀", selUp === sel0);
    await ensureFixture();

    // ── #9 이미지 뷰어 (터미널 조작 전 — IPC 게이트 깨끗할 때) ──
    fix.writeFile("e2e-pixel.png", Buffer.from(PNG_B64, "base64"));
    await cdp.eval(
      `(()=>{ window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer"); window.__gpv.ui.getState().selectDiff({ mode: "file", path: "e2e-pixel.png" }); })()`,
    );
    const gotImg = await poll(
      () => cdp.eval(`!!document.querySelector('img[src^="data:image"]')`),
      (v) => v === true,
      30,
      400,
    );
    r.check("이미지 파일 선택 → <img data:image> 렌더", gotImg === true);
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`);
    try {
      unlinkSync(join(fix.repo, "e2e-pixel.png"));
    } catch {
      /* cleanup이 픽스처 통째로 지운다 */
    }

    // ── #2 그리드 분할 (우클릭 → 4분할) ──
    tabId = await cdp.eval(
      `window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)})`,
    );
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, ${J(tabId)})`,
    );
    const rendered = await poll(xtermCount, (n) => n >= 1);
    r.check("새 터미널 렌더(콜드스타트)", rendered >= 1, `xterm=${rendered}`);

    const ctx = await cdp.eval(`(()=>{
      const x = document.querySelector('.xterm');
      if (!x) return false;
      x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:200}));
      return true;
    })()`);
    await sleep(400);
    const clicked = await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(el => /4분할/.test(el.textContent||''));
      if (b) { b.click(); return true; } return false;
    })()`);
    r.check("터미널 우클릭 → '4분할' 메뉴 노출·클릭", ctx && clicked);
    const after4 = await poll(xtermCount, (n) => n >= 4, 28, 350);
    r.check("4분할: 터미널 패널 4개 생성", after4 >= 4, `xterm=${after4}`);

    // ── #10 Ctrl+W 포커스 패널 닫기 ──
    if (after4 >= 4) {
      const beforeW = await xtermCount();
      await cdp.eval(`(()=>{
        const ta = document.querySelector('.xterm-helper-textarea');
        if (ta) { ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true})); }
      })()`);
      const afterW = await poll(xtermCount, (n) => n < beforeW, 16, 300);
      r.check("Ctrl+W: 포커스 터미널 닫힘(-1)", afterW === beforeW - 1, `${beforeW}→${afterW}`);
    } else {
      r.skip("Ctrl+W", "4분할 선행 실패 — 스킵");
    }

    // ── #11 모아보기 ──
    const aggBtn = await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /모아보기/.test(x.textContent||''));
      if (b) { b.click(); return true; } return false;
    })()`);
    await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const aggOpen = await uGet("aggregateOpen");
    const aggHeader = await cdp.eval(`document.body.innerText.includes('터미널 모아보기')`);
    r.check("모아보기 버튼 → 뷰 진입", aggBtn && aggOpen === true && aggHeader);
    const aggGrid = await cdp.eval(
      `(()=>{ const g=document.querySelector('[style*="grid-template-columns"]'); return g?g.querySelectorAll('.xterm').length:0; })()`,
    );
    r.check("모아보기: 그리드에 터미널 표시", aggGrid >= 1, `gridXterm=${aggGrid}`);
    await cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button')).find(x => /닫기/.test(x.textContent||''));
      if (b) b.click();
    })()`);
    await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    r.check("모아보기 닫기 → 워크스페이스 복귀", (await uGet("aggregateOpen")) === false);

    // ── #11b 모아보기 토글 단축키 (Ctrl+Shift+A — GlobalShortcuts + xterm 화이트리스트) ──
    await cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`,
    );
    const hkOpen = await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const hkHeader = await cdp.eval(`document.body.innerText.includes('터미널 모아보기')`);
    r.check("Ctrl+Shift+A: 모아보기 열림", hkOpen === true && hkHeader);
    // 터미널(xterm) 포커스 상태에서도 토글돼야 한다 — 엔진 화이트리스트 통과 검증(Ctrl+W 패턴 미러)
    await poll(
      () => cdp.eval(`!!document.querySelector('.xterm-helper-textarea')`),
      (v) => v === true,
      12,
      300,
    );
    await cdp.eval(`(()=>{
      const ta = document.querySelector('.xterm-helper-textarea');
      const target = ta || window;
      if (ta) ta.focus();
      target.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    })()`);
    const hkClosed = await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    r.check("Ctrl+Shift+A(터미널 포커스): 모아보기 닫힘", hkClosed === false);

    // 터미널 탭 닫기 — 이후 Log 핸들이 패널 divider(.cursor-row-resize)와 안 헷갈리게.
    await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`);
    tabClosed = true;
    await sleep(400);

    // ── #4 Log 패널 높이 드래그 리사이즈 ──
    // 높이는 [120, innerHeight-200]로 클램프된다 → 창이 너무 작으면(최소화 등) 여유가 없어
    // 드래그가 의미 없으므로 그때만 스킵한다(기능 자체는 정상, 환경 의존).
    const ih = await cdp.eval(`window.innerHeight`);
    if (ih < 500) {
      r.skip("Log 핸들 드래그 리사이즈", `창이 작음(innerHeight=${ih}) — 클램프 여유 없어 스킵`);
    } else {
      await cdp.eval(
        `if(!window.__gpv.ui.getState().logOpen) window.__gpv.ui.getState().toggleLog()`,
      );
      await sleep(350);
      await cdp.eval(`window.__gpv.ui.getState().setLogHeight(160)`); // 클램프 하단 근처
      await sleep(200);
      const h0 = await uGet("logHeight");
      const dragged = await cdp.eval(`(()=>{
        const h = document.querySelector('.cursor-row-resize');
        if (!h) return false;
        const rect = h.getBoundingClientRect();
        const y = rect.top + rect.height/2;
        h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientY:y,pointerId:1}));
        window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientY:y-100,pointerId:1}));
        window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientY:y-100,pointerId:1}));
        return true;
      })()`);
      await sleep(450);
      const h1 = await uGet("logHeight");
      const lsH = await cdp.eval(`Number(localStorage.getItem('gp:log-height'))`);
      r.check("Log 핸들 드래그 → 높이 증가", dragged && h1 > h0, `${h0}→${h1}`);
      r.check("Log 높이 localStorage 영속", lsH === h1, `ls=${lsH}`);
    }
  } finally {
    // 정리 — 만든 터미널 탭 닫고, 모아보기/뷰어/Log/선택 상태 원복.
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    if (tabId && !tabClosed)
      await cdp.eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`).catch(() => {});
    await cdp
      .eval(`window.__gpv.ui.getState().setLogHeight(${Number(origLogHeight) || 288})`)
      .catch(() => {});
    if (!origLogOpen)
      await cdp
        .eval(`if(window.__gpv.ui.getState().logOpen) window.__gpv.ui.getState().toggleLog()`)
        .catch(() => {});
    if (origSel)
      await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
  }
}
