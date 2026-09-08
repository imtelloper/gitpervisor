// 태스크 61 — 선택 텍스트 번역(터미널 PaneMenu · 뷰어 Monaco 액션 → 비차단 번역 카드).
//
// 지키는 계약 다섯:
//   ① 메뉴 항목은 **선택이 있을 때만 존재한다**(비활성이 아니라 없음 — ChipMenu 관례).
//   ② 클릭하면 카드가 뜨고 원문이 담기며, 요청 원문은 8,000자를 넘지 않는다.
//   ③ 8,000자 초과 선택은 앞부분만 + `truncated` + 카드에 "잘림".
//   ④ Esc 로 닫히고 상태가 null 로 돌아간다. 점유는 selectBlockingOverlay 가 아니라
//      useOccludesWebview 로 등록돼야 한다(11.3 "둘 중 하나는 반드시").
//   ⑤ 뷰어 Monaco 에 `gp.translate` 액션이 등록돼 있고, 실행하면 같은 카드가 열린다.
//
// LLM 이 실제로 준비된 경우에만(런타임 + 모델) 번역 본문·방향 토글까지 단언한다 — 47 과 같은
// 게이트다. 미준비면 카드가 "이유 + 설정 열기"를 보이는 것만 확인하고 나머지는 skip.
//
// 터미널에는 셸 명령을 보내지 않고 xterm 버퍼에 직접 write 한다 — 선택은 버퍼에서 나오므로
// PTY 왕복(term_open ≈ 4.5s, 셸 프롬프트 타이밍)에 결과가 흔들릴 이유가 없다.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "선택 텍스트 번역 (PaneMenu · Monaco 액션 · 카드 · 8000자 절단)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]+$/, "");

const SAMPLE = "hello world from gitpervisor";
const LONG = "abcdefghij".repeat(801).slice(0, 8001); // 8,001자 — 상한 1자 초과
const VIEWER_FILE = "e2e-translate.txt";
const VIEWER_TEXT = "Gitpervisor translate action target line.\n";

/** PaneMenu(=ChipMenu 와 같은 모양) · 번역 카드 셀렉터. 카드만 role=dialog 다. */
const MENU = `document.querySelector('div.fixed.z-50.min-w-52')`;
const CARD = `document.querySelector('div.fixed.z-50[role="dialog"]')`;

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.ui && window.__gpv.terminals && window.__gpv.term && window.__gpv.queryClient)`,
  );
  if (!hooks) {
    r.skip("선택 텍스트 번역", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const poll = async (fn, ok, tries = 30, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  const VIS_XTERM = `Array.from(document.querySelectorAll('.xterm')).find((e) => e.getBoundingClientRect().width > 0)`;
  const translateState = () =>
    cdp.eval(`(()=>{ const t = window.__gpv.ui.getState().translate;
      return t ? { len: t.text.length, truncated: t.truncated, x: t.x, y: t.y } : null; })()`);
  const cardText = () => cdp.eval(`(()=>{ const c = ${CARD}; return c ? c.textContent : null; })()`);
  const menuLabels = () =>
    cdp.eval(`(()=>{ const m = ${MENU};
      return m ? Array.from(m.querySelectorAll('button')).map(b => b.textContent.trim()) : null; })()`);
  const clickMenu = (label) =>
    cdp.eval(`(()=>{ const m = ${MENU}; if (!m) return false;
      const b = Array.from(m.querySelectorAll('button')).find(el => (el.textContent||'').trim() === ${J(label)});
      if (!b) return false; b.click(); return true; })()`);
  const esc = () =>
    cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  let tabId = null;

  try {
    // ── 셋업: 픽스처 선택 + 터미널 탭 하나 ──
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(400);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    const stuck = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
      (v) => v === fix.projectId,
      12,
      250,
    );
    if (stuck !== fix.projectId) {
      r.skip("선택 텍스트 번역", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    // 모아보기가 열려 있으면 `main`이 그리드라 .xterm 우클릭이 PaneMenu 를 열지 않는다(14의 전제).
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);

    const opened = await cdp.eval(
      `window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)})`,
    );
    tabId = opened.tabId;
    const paneId = opened.paneId;
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, ${J(tabId)})`,
    );
    const live = await poll(
      () => cdp.eval(`!!window.__gpv.term.get(${J(paneId)})`),
      (v) => v === true,
      40,
      250,
    );
    if (!r.check("터미널 pane 생성(xterm 인스턴스)", live === true, `paneId=${paneId}`)) return;

    /** xterm 버퍼에 그대로 그린다(PTY 무관 — 선택은 버퍼에서 나온다). */
    const write = (text) =>
      cdp.eval(`(()=>{ const t = window.__gpv.term.get(${J(paneId)});
        if (!t) return false; t.term.write(${J(text)}); return true; })()`);
    const selectAll = () =>
      cdp.eval(`(()=>{ const t = window.__gpv.term.get(${J(paneId)});
        if (!t) return -1; t.term.selectAll(); return t.term.getSelection().length; })()`);
    const clearSel = () =>
      cdp.eval(`(()=>{ const t = window.__gpv.term.get(${J(paneId)});
        if (t) t.term.clearSelection(); return true; })()`);
    /** 메뉴를 새로 연다 — 이전 메뉴가 남아 있으면 그 닫힘 경로에 같이 닫혀 라벨을 못 읽는다(14 #11a). */
    const openMenu = async () => {
      await esc();
      await poll(() => cdp.eval(`!${MENU}`), (v) => v === true, 12, 150);
      await cdp.eval(`(()=>{ const x = ${VIS_XTERM}; if (!x) return false;
        const b = x.getBoundingClientRect();
        x.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: b.left + 40, clientY: b.top + 40 }));
        return true; })()`);
      return poll(menuLabels, (v) => Array.isArray(v) && v.length > 0, 12, 200);
    };

    // ── ① 선택 유무에 따라 항목이 **있다/없다** ──
    await write(`\r\n${SAMPLE}\r\n`);
    const selLen = await poll(selectAll, (v) => typeof v === "number" && v >= SAMPLE.length, 20, 250);
    if (!r.check("터미널 선택 준비(selectAll)", selLen >= SAMPLE.length, `${selLen}자`)) return;

    const withSel = await openMenu();
    r.check(
      "① 선택이 있으면 PaneMenu 에 '선택 영역 번역'",
      Array.isArray(withSel) && withSel.includes("선택 영역 번역"),
      J(withSel),
    );

    await esc();
    await poll(() => cdp.eval(`!${MENU}`), (v) => v === true, 12, 150);
    await clearSel();
    const noSel = await openMenu();
    r.check(
      "① 선택이 없으면 항목 자체가 없다(비활성 아님)",
      Array.isArray(noSel) && !noSel.includes("선택 영역 번역"),
      J(noSel),
    );

    // ── ② 클릭 → 카드 ──
    await esc();
    await poll(() => cdp.eval(`!${MENU}`), (v) => v === true, 12, 150);
    await selectAll();
    await openMenu();
    const clicked = await clickMenu("선택 영역 번역");
    if (!r.check("② 메뉴 항목 클릭", clicked === true)) return;

    const req = await poll(translateState, (v) => !!v, 20, 250);
    r.check(
      "② useUi.translate 생성 · 원문 8,000자 이하",
      !!req && req.len > 0 && req.len <= 8000,
      J(req),
    );
    const text0 = await poll(cardText, (v) => typeof v === "string", 20, 250);
    r.check(
      "② 카드에 원문이 담긴다",
      typeof text0 === "string" && text0.includes(SAMPLE),
      `card=${(text0 || "").slice(0, 60)}`,
    );

    // LLM 준비 여부 — 47 과 같은 게이트(llmReadyReason 과 같은 판정을 여기서 다시 잰다).
    const st = await cdp.invoke("llm_status", {}, { timeoutMs: 10000 }).catch(() => null);
    const cfg = await cdp.invoke("get_settings").catch(() => null);
    const ready =
      !!cfg &&
      (cfg.llmProvider === "external"
        ? !!(cfg.llmExternalUrl || "").trim()
        : !!st &&
          !!st.runtime &&
          (cfg.llmModel === "custom"
            ? st.customModelOk === true
            : !!(st.models || []).find((m) => m.id === cfg.llmModel && m.present)));

    if (!ready) {
      const guide = await cdp.eval(`(()=>{ const c = ${CARD}; if (!c) return null;
        return Array.from(c.querySelectorAll('button')).map(b => b.textContent.trim()); })()`);
      r.check(
        "② 미준비면 카드가 이유 + '설정 열기' 를 보인다",
        Array.isArray(guide) && guide.includes("설정 열기"),
        J(guide),
      );
      r.skip(
        "② 번역 스트리밍 · 방향 토글",
        `LLM 미준비(runtime=${st && st.runtime} model=${cfg && cfg.llmModel})`,
      );
    } else {
      const out = () =>
        cdp.eval(`(()=>{ const e = document.querySelector('[data-gpv-translation]');
          return e ? e.textContent : null; })()`);
      // 첫 요청은 서버 기동 + 모델 로드로 수십 초가 걸린다 — 60s 폴링(§5.1).
      const ko = await poll(out, (v) => typeof v === "string" && /[가-힣]/.test(v), 120, 500);
      r.check(
        "② 번역문이 스트리밍된다(영어 원문 → 한글 등장)",
        typeof ko === "string" && /[가-힣]/.test(ko),
        `out=${String(ko).slice(0, 60)}`,
      );
      const toggled = await cdp.eval(`(()=>{ const c = ${CARD}; if (!c) return false;
        const b = Array.from(c.querySelectorAll('button')).find(el => (el.textContent||'').trim() === '→ EN');
        if (!b) return false; b.click(); return true; })()`);
      r.check("② 방향 토글 '→ EN' 버튼 존재", toggled === true);
      if (toggled === true) {
        const en = await poll(
          out,
          (v) => typeof v === "string" && v.length > 0 && v !== ko,
          120,
          500,
        );
        r.check(
          "② 토글 → 재요청 후 본문이 바뀐다",
          typeof en === "string" && en.length > 0 && en !== ko,
          `out=${String(en).slice(0, 60)}`,
        );
      }
    }

    // ── ④ Esc → 닫힘 ──
    await esc();
    const closed = await poll(translateState, (v) => v === null, 20, 250);
    r.check("④ Esc → translate === null", closed === null, J(closed));

    // ── ③ 8,001자 선택 → 앞 8,000자 + '잘림' ──
    await write(`\r\n${LONG}\r\n`);
    const longLen = await poll(selectAll, (v) => typeof v === "number" && v > 8000, 30, 300);
    if (longLen > 8000) {
      await openMenu();
      await clickMenu("선택 영역 번역");
      const big = await poll(translateState, (v) => !!v, 20, 250);
      r.check(
        "③ 8,000자 초과 선택 → 앞 8,000자만 + truncated",
        !!big && big.len === 8000 && big.truncated === true,
        J(big),
      );
      const badge = await poll(cardText, (v) => typeof v === "string", 20, 250);
      r.check(
        "③ 카드에 '잘림' 뱃지",
        typeof badge === "string" && badge.includes("잘림"),
        `card=${(badge || "").slice(0, 40)}`,
      );
      await esc();
      await poll(translateState, (v) => v === null, 20, 250);
    } else {
      r.skip("③ 8,000자 절단", `xterm 선택이 8,000자에 못 미친다(${longLen}자)`);
    }

    // ── ④ 점유 계약 — 카드는 **비차단**이라 selectBlockingOverlay 가 아니라 useOccludesWebview 다.
    //    occlusion 스토어가 __gpv 에 노출돼 있지 않아 실행 중 값으로는 못 잰다 → 소스로 고정한다
    //    (브라우저 셀 위에 실제로 그려지는지는 §5.2 실기).
    const cardSrc = readFileSync(`${REPO}/src/components/common/TranslateCard.tsx`, "utf8");
    const uiSrc = readFileSync(`${REPO}/src/stores/ui.ts`, "utf8");
    const overlay = uiSrc.slice(
      uiSrc.indexOf("export const selectBlockingOverlay"),
      uiSrc.indexOf("export const useUi"),
    );
    r.check(
      "④ 카드가 useOccludesWebview 로 점유 등록(비차단 층)",
      /useOccludesWebview\(!!req\)/.test(cardSrc),
      "TranslateCard.tsx",
    );
    r.check(
      "④ selectBlockingOverlay 에는 translate 가 없다(전체화면 모달이 아니다)",
      overlay.length > 0 && !overlay.includes("translate"),
      `overlay=${overlay.replace(/\s+/g, " ").slice(0, 80)}`,
    );

    // ── ⑤ 뷰어 Monaco 액션 ──
    fix.writeFile(VIEWER_FILE, VIEWER_TEXT);
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, "viewer")`,
    );
    await cdp.eval(
      `window.__gpv.ui.getState().selectDiff({ mode: "file", path: ${J(VIEWER_FILE)} })`,
    );
    const FIND_ED = `window.__monaco.editor.getEditors().find(e => ((e.getModel() && e.getModel().getValue()) || '').includes('Gitpervisor translate action'))`;
    const edState = await poll(
      () =>
        cdp.eval(`(()=>{ if (!window.__monaco) return 'no-monaco';
          return ${FIND_ED} ? 'ok' : 'wait'; })()`),
      (v) => v === "ok" || v === "no-monaco",
      40,
      250,
    );
    if (edState !== "ok") {
      r.skip("⑤ 뷰어 Monaco 액션", `에디터를 찾지 못했다(${edState})`);
    } else {
      const fired = await cdp.eval(`(()=>{ const ed = ${FIND_ED}; if (!ed) return 'no-editor';
        if (!ed.getAction('gp.translate')) return 'no-action';
        ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 12 });
        ed.trigger('e2e', 'gp.translate');
        return 'ok'; })()`);
      r.check("⑤ Monaco 에 gp.translate 액션 등록", fired !== "no-action", `state=${fired}`);
      const viaMonaco = await poll(translateState, (v) => !!v, 20, 250);
      r.check(
        "⑤ 액션 실행 → 같은 카드가 열린다",
        fired === "ok" && !!viaMonaco && viaMonaco.len > 0,
        J(viaMonaco),
      );
      await esc();
      await poll(translateState, (v) => v === null, 20, 250);
    }
  } finally {
    // ── ⑥ 정리 — 카드·메뉴·터미널 탭·뷰어 탭·픽스처 파일 ──
    await cdp.eval(`window.__gpv.ui.getState().closeTranslate()`).catch(() => {});
    await esc().catch(() => {});
    if (tabId)
      await cdp
        .eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`)
        .catch(() => {});
    await cdp
      .eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(fix.projectId)})`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectDiff(null)`).catch(() => {});
    try {
      rmSync(join(fix.repo, VIEWER_FILE), { force: true, maxRetries: 5 });
    } catch {
      /* 픽스처 정리가 통째로 지운다 — 실패해도 무해 */
    }
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
    await sleep(300);
  }
}
