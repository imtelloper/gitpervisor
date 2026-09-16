// 태스크 64 — 뷰어 우클릭 → 패널 분할(코드 나란히 보기).
//
// 지키는 계약 여덟:
//   ① Monaco **본문** 우클릭에서 앱 메뉴가 뜬다 — 뷰어 리프가 주는 `suppressContextMenu`.
//      켜져 있으면 코드 위에서는 Monaco 자체 메뉴가 떠서 분할 메뉴에 닿을 수 없다(설계 §3.5).
//      Monaco 메뉴를 끈 대가로 "선택 영역 번역"(태스크 61)이 사라지면 안 되므로 pane 메뉴가
//      그 항목을 대신 낸다 — 선택이 있을 때만(비활성이 아니라 없음).
//   ⑧ 그 억제는 **뷰어 리프에서만** 건다. Git 모달·문서 창에는 대체할 pane 메뉴가 없어서
//      상수에 `contextmenu:false`를 두면 번역이 앱 어디에서도 우클릭으로 안 뜬다(실제 회귀).
//   ② "오른쪽으로 분할" → 패널 2개, **새 패널이 활성**이고 비어 있다(첫 패널은 그대로).
//   ③ 파일을 열면(파일 트리·selectDiff — 호출부 11곳은 손대지 않았다) **활성 패널**에 뜬다.
//      라우팅은 `selectDiff` 안 한 곳에서 한다(설계 §3.3).
//   ④ 패널을 클릭해 활성을 되돌리면 그 다음 파일은 **그 패널**이 받는다.
//   ⑤ Divider 드래그로 ratio가 바뀌고, 드래그 중에는 `draggingSplit`이 켜진다
//      (분할 이웃이 네이티브 브라우저 pane이면 이게 없으면 잔상이 남는다).
//   ⑥ "패널 닫기" → 남은 패널이 전체를 차지하고 활성·표시 파일이 그 패널로 옮겨간다.
//      마지막 한 칸에는 닫기 항목 자체가 없다. 분할 상한은 4(도달 시 메뉴 항목 비활성).
//   ⑦ 레이아웃·패널별 파일이 `gp:viewer-tabs`에 영속된다(재시작 복원의 재료).
//
// **앱을 리로드하지 않는다** — 사용자가 쓰고 있는 dev 앱이라 ⑦은 localStorage 기록으로 확인한다.
// 시작 시 뷰어를 알려진 단일 패널(gpv-e2e-pane)로 만들고, 끝나면 원래 레이아웃을 되돌린다.
//
// 끝에 하나 더: `KeyboardShortcuts`의 **Alt 게이트** 회귀(태스크 64 범위 밖이지만 같은 파일).
// Windows AltGr = Ctrl+Alt 라서 게이트가 없으면 `@`·`\`를 치다 커밋·push가 오발한다.

export const name =
  "뷰어 패널 분할 (Monaco 우클릭 · 활성 패널 라우팅 · 비율 드래그 · 닫기/상한 · 영속)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const PANE_A = "gpv-e2e-pane";
/** 페이지 안에서 레이아웃의 리프 id를 모은다(스토어의 collectPanes와 같은 순회). */
const PANES = `(function walk(n){ return n.kind === 'leaf' ? [n.paneId] : walk(n.a).concat(walk(n.b)); })(window.__gpv.ui.getState().viewerLayout)`;

export async function run({ cdp, report: r, fix }) {
  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  // 훅 노출은 폴링한다 — 다른 세션의 편집으로 vite가 방금 리로드했으면 `__gpv` 대입이 아직
  // 안 끝나 한 번만 보고는 "dev 빌드 아님"으로 오진한다(스위트 50과 같은 이유).
  const hooks = await poll(
    () => cdp.eval(`!!(window.__gpv && window.__gpv.ui && window.__gpv.terminals)`),
    (v) => v === true,
    16,
    250,
  );
  if (hooks !== true) {
    r.skip("뷰어 패널 분할", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  /** 뷰어 상태 요약 — 패널 목록·활성·패널별 경로. */
  const view = () =>
    cdp.eval(`(()=>{
      const s = window.__gpv.ui.getState();
      const ids = ${PANES};
      const byPane = {};
      for (const id of ids) {
        const e = s.viewerByPane[id];
        byPane[id] = e ? e.target.mode + ':' + e.target.path : null;
      }
      return {
        ids,
        active: s.viewerActivePaneId,
        byPane,
        mirror: s.selectedDiff ? s.selectedDiff.mode + ':' + s.selectedDiff.path : null,
        max: s.viewerMaximizedPaneId,
      };
    })()`);

  const menuItem = (label) =>
    cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button'))
        .find(el => (el.textContent || '').includes(${J(label)}));
      if (!b) return 'none';
      return b.closest('.pointer-events-none') ? 'disabled' : 'enabled';
    })()`);
  const clickMenu = (label) =>
    cdp.eval(`(()=>{
      const b = Array.from(document.querySelectorAll('button'))
        .find(el => (el.textContent || '').includes(${J(label)}));
      if (!b) return 'none';
      b.click();
      return 'ok';
    })()`);
  const closeMenu = () =>
    cdp.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
  /** 패널 위에서 우클릭 — Monaco가 있으면 **에디터 본문**을 노린다(①의 핵심). */
  const rightClick = (paneId) =>
    cdp.eval(`(()=>{
      const host = document.querySelector('[data-viewer-pane=' + ${J(`"${paneId}"`)} + ']');
      if (!host) return 'no-pane';
      const mon = host.querySelector('.monaco-editor');
      const el = mon || host;
      const b = el.getBoundingClientRect();
      if (!b.width) return 'no-layout';
      el.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 40,
      }));
      return mon ? 'monaco' : 'pane';
    })()`);
  /**
   * Monaco 자체 우클릭 메뉴의 항목. **섀도루트**에 그려지므로(useShadowDOM) `document` 질의로는
   * 영영 안 보인다 — 셀렉터 한 줄로 "없음"을 단언하면 있으나 없으나 통과하는 가짜 green 이다.
   */
  const monacoMenuItems = () =>
    cdp.eval(`(()=>{
      const found = [];
      const visit = (root, depth) => {
        if (depth > 6 || !root.querySelectorAll) return;
        for (const n of root.querySelectorAll('.monaco-menu'))
          found.push(...Array.from(n.querySelectorAll('.action-label'))
            .map(e => (e.textContent || '').trim()).filter(Boolean));
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) visit(e.shadowRoot, depth + 1);
      };
      visit(document, 0);
      return found;
    })()`);
  /** 이 패널 Monaco 의 선택을 세운다(1행 1~6열). 돌려주는 값이 실제 선택 텍스트. */
  const selectInPane = (paneId, on) =>
    cdp.eval(`(()=>{
      const host = document.querySelector('[data-viewer-pane=' + JSON.stringify(${J(paneId)}) + ']');
      if (!host || !window.__monaco) return 'no-monaco';
      const ed = window.__monaco.editor.getEditors().find(e => host.contains(e.getContainerDomNode()));
      if (!ed || !ed.getModel()) return 'no-editor';
      ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: ${on ? 6 : 1} });
      return ed.getModel().getValueInRange(ed.getSelection());
    })()`);
  const translateText = () =>
    cdp.eval(
      `(()=>{ const t = window.__gpv.ui.getState().translate; return t ? t.text : null; })()`,
    );
  const openFile = (path) =>
    cdp.eval(
      `window.__gpv.ui.getState().selectDiff({ mode: 'file', path: ${J(path)} })`,
    );

  // ── 원상복구용 스냅샷(사용자가 돌아와서 쓸 앱이다) ──────────────────────────
  const snap = await cdp.eval(`(()=>{
    const s = window.__gpv.ui.getState();
    return JSON.stringify({
      layout: s.viewerLayout, active: s.viewerActivePaneId, byPane: s.viewerByPane,
      max: s.viewerMaximizedPaneId, diff: s.selectedDiff, repo: s.selectedDiffRepoId,
      project: s.selectedProjectId, agg: s.aggregateOpen, report: s.reportOpen,
    });
  })()`);
  const origTab = await cdp.eval(
    `(()=>{ const t = window.__gpv.terminals.getState().activeTab; return t[${J(fix.projectId)}] || null; })()`,
  );

  try {
    // ── 셋업: 픽스처를 선택하고 Viewer 탭을 화면에 띄운다(레이아웃 계산이 필요하다) ──
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp
      .eval(
        `(()=>{ const s = window.__gpv.ui.getState(); if (s.reportOpen) s.toggleReport(); return true; })()`,
      )
      .catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await cdp.eval(
      `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, 'viewer')`,
    );
    // 알려진 단일 패널에서 시작한다 — 이전 실행 잔재가 있어도 단언이 흔들리지 않는다.
    await cdp.eval(`window.__gpv.ui.setState({
      viewerLayout: { kind: 'leaf', paneId: ${J(PANE_A)} },
      viewerActivePaneId: ${J(PANE_A)},
      viewerByPane: {}, viewerMaximizedPaneId: null,
      selectedDiff: null, selectedDiffRepoId: null,
    })`);

    // 첫 파일은 **Monaco로 그려지는** 것이라야 한다 — README.md는 마크다운 미리보기라
    // 에디터가 없어 ①(contextmenu:false)을 확인할 수 없다(DiffViewer의 isMarkdown 분기).
    await openFile("src/app.txt");
    const opened = await poll(
      view,
      (v) => v?.byPane?.[PANE_A] === "file:src/app.txt",
      20,
      250,
    );
    if (
      !r.check(
        "단일 패널에 파일이 열린다(selectDiff → 활성 패널)",
        opened?.byPane?.[PANE_A] === "file:src/app.txt" &&
          opened.mirror === "file:src/app.txt",
        J(opened),
      )
    )
      return;

    // ── ① Monaco 본문 우클릭 → 앱 메뉴 ──────────────────────────────────────
    // `.view-lines` 가 한 번 보였다고 준비된 게 아니다 — 첫 마운트 직후 에디터가 한 번 다시 마운트된다.
    // 샤딩(그 앱의 첫 뷰어 마운트 + 병렬 부하)에서 그 틈이 길어져, 옵션 확인은 통과하고 바로 다음
    // 우클릭은 대상=pane·선택="no-editor" 로 떨어졌다. **같은 에디터 id 를 연속 두 번** 봐야 준비로 친다
    // (아래 Git 모달의 'stable' 과 같은 규칙).
    const monReady = await poll(
      () =>
        cdp.eval(`(()=>{
          const host = document.querySelector('[data-viewer-pane]');
          const ed = host && window.__monaco && window.__monaco.editor.getEditors()
            .find(e => host.contains(e.getContainerDomNode()) && e.getModel());
          if (!ed || !host.querySelector('.monaco-editor .view-lines')) { window.__gpv51ed = null; return false; }
          const prev = window.__gpv51ed; window.__gpv51ed = ed.getId();
          return prev === ed.getId() ? 'stable' : 'mounted';
        })()`),
      (v) => v === "stable",
      60,
      250,
    );
    await cdp.eval(`(()=>{ delete window.__gpv51ed; return true; })()`).catch(() => {});
    const rawOpt = await cdp.eval(`(()=>{
      if (!window.__monaco) return 'no-monaco';
      const host = document.querySelector('[data-viewer-pane]');
      if (!host) return 'no-pane';
      const eds = window.__monaco.editor.getEditors()
        .filter(e => host.contains(e.getContainerDomNode()));
      if (!eds.length) return 'no-editor';
      return eds.every(e => e.getRawOptions().contextmenu === false) ? 'off' : 'on';
    })()`);
    r.check(
      "뷰어 Monaco 옵션 contextmenu=false (본문 우클릭을 pane 메뉴로 넘긴다)",
      rawOpt === "off",
      `monaco=${monReady} opt=${rawOpt}`,
    );

    const where = await rightClick(PANE_A);
    const splitItem = await poll(() => menuItem("오른쪽으로 분할"), (v) => v === "enabled", 12, 250);
    r.check(
      "Monaco 본문 우클릭 → 앱 pane 메뉴(분할 항목)가 뜬다",
      where === "monaco" && splitItem === "enabled",
      `대상=${where} 항목=${splitItem}`,
    );
    // 섀도루트까지 훑는다 — Monaco 메뉴는 useShadowDOM 으로 그려져 `document` 질의로는
    // 있으나 없으나 안 보인다(그 셀렉터로는 가짜 green 이 된다).
    const noMonacoMenu = await monacoMenuItems();
    r.check(
      "같은 우클릭에서 Monaco 자체 메뉴는 뜨지 않는다",
      Array.isArray(noMonacoMenu) && noMonacoMenu.length === 0,
      `monaco-menu 항목=${J(noMonacoMenu)}`,
    );
    // 최대화 항목은 있고, 마지막 한 칸이라 닫기 항목은 없어야 한다.
    const maxItem = await menuItem("패널 최대화");
    const closeItemAlone = await menuItem("패널 닫기");
    r.check(
      "메뉴 구성 — 최대화 있음 · 마지막 한 칸이면 '패널 닫기' 항목 없음",
      maxItem === "enabled" && closeItemAlone === "none",
      `최대화=${maxItem} 닫기=${closeItemAlone}`,
    );

    // ── ①-b Monaco 메뉴를 끈 자리 — "선택 영역 번역"은 pane 메뉴가 대신 낸다(태스크 61) ──
    // 선택은 메뉴가 **열리는 순간** 잡는다(TerminalPane PaneMenu 와 같은 규칙) → 여는 순서를
    // 지켜 두 번 확인한다. 항목 유무만 보지 않고 클릭까지 해 **그 패널의** 선택이 카드로 가는지
    // 본다(통로가 패널별이 아니라 전역 싱글턴이면 패널이 여럿일 때 마지막 마운트가 이긴다).
    await closeMenu();
    await sleep(150);
    const picked = await selectInPane(PANE_A, true);
    await rightClick(PANE_A);
    const trItem = await poll(() => menuItem("선택 영역 번역"), (v) => v !== "none", 12, 250);
    r.check(
      "선택이 있으면 pane 메뉴에 '선택 영역 번역'이 있다(끈 Monaco 메뉴의 대체)",
      typeof picked === "string" && picked.length > 0 && trItem === "enabled",
      `선택=${J(picked)} 항목=${trItem}`,
    );
    const trClick = await clickMenu("선택 영역 번역");
    const req = await poll(translateText, (v) => typeof v === "string", 16, 250);
    r.check(
      "클릭 → **그 패널의 선택**이 그대로 번역 카드 원문이 된다",
      trClick === "ok" && req === picked,
      `click=${trClick} 카드=${J(req)} 선택=${J(picked)}`,
    );
    await cdp.eval(`window.__gpv.ui.getState().closeTranslate()`).catch(() => {});
    await poll(translateText, (v) => v === null, 12, 250);

    // 선택을 지우고 다시 열면 항목 **자체가 없다**(비활성이 아님 — PaneMenu·ChipMenu 관례).
    await closeMenu();
    await sleep(150);
    const cleared = await selectInPane(PANE_A, false);
    await rightClick(PANE_A);
    const splitAgain = await poll(() => menuItem("오른쪽으로 분할"), (v) => v === "enabled", 12, 250);
    const trGone = await menuItem("선택 영역 번역");
    r.check(
      "선택이 없으면 번역 항목 자체가 없다(메뉴 나머지는 그대로)",
      cleared === "" && splitAgain === "enabled" && trGone === "none",
      `선택=${J(cleared)} 분할=${splitAgain} 번역=${trGone}`,
    );

    // ── ② 오른쪽으로 분할 → 2패널, 새 패널이 활성·빈 상태 ────────────────────
    const clicked = await clickMenu("오른쪽으로 분할");
    const split = await poll(view, (v) => v?.ids?.length === 2, 16, 250);
    const paneB = split?.ids?.find((id) => id !== PANE_A) ?? null;
    if (
      !r.check(
        "우클릭 → '오른쪽으로 분할' → 패널 2개, 새 패널이 활성(빈 상태)",
        clicked === "ok" &&
          split?.ids?.length === 2 &&
          split.ids[0] === PANE_A &&
          split.active === paneB &&
          split.byPane[paneB] === null &&
          split.mirror === null,
        `click=${clicked} ${J(split)}`,
      )
    )
      return;
    r.check(
      "분할해도 첫 패널의 파일은 그대로다",
      split.byPane[PANE_A] === "file:src/app.txt",
      J(split.byPane),
    );

    // ── ③ 파일 트리에서 파일 클릭 → **활성(새) 패널**에 뜬다 ─────────────────
    // 실제 동선 하나는 UI로 확인한다(나머지 호출부는 모두 같은 selectDiff를 지난다).
    if ((await cdp.eval(`window.__gpv.ui.getState().fileTreeOpen`)) !== true)
      await cdp.eval(`window.__gpv.ui.getState().toggleFileTree()`).catch(() => {});
    await cdp
      .eval(`(()=>{ const b = document.querySelector('button[title="Files 펼치기"]');
        if (b) { b.click(); return 'expanded'; } return 'already'; })()`)
      .catch(() => {});
    await sleep(400);
    const treeClick = await poll(
      () =>
        cdp.eval(`(()=>{
          const el = Array.from(document.querySelectorAll('[data-tree-file="README.md"]'))
            .find(e => !e.closest('div.fixed.inset-0.z-50'));
          if (!el) return 'no-row';
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'ok';
        })()`),
      (v) => v === "ok",
      16,
      250,
    );
    if (treeClick === "ok") {
      const routed = await poll(view, (v) => v?.byPane?.[paneB] === "file:README.md", 20, 250);
      r.check(
        "파일 트리 클릭 → **활성 패널**에 열린다(호출부는 그대로, 라우팅은 selectDiff 안에서)",
        routed?.byPane?.[paneB] === "file:README.md" &&
          routed.byPane[PANE_A] === "file:src/app.txt" &&
          routed.active === paneB,
        J(routed),
      );
    } else {
      r.skip("파일 트리 → 활성 패널", "사이드바 트리 행이 없다(패널이 닫혀 있거나 접힘)");
      await openFile("README.md"); // 아래 "나란히 보기" 단언을 위해 같은 대상을 스토어로 연다
    }
    const sideBySide = await poll(view, (v) => v?.byPane?.[paneB] === "file:README.md", 20, 250);
    r.check(
      "두 패널이 서로 다른 파일을 나란히 보여준다",
      sideBySide?.byPane?.[PANE_A] === "file:src/app.txt" &&
        sideBySide?.byPane?.[paneB] === "file:README.md",
      J(sideBySide?.byPane),
    );

    // ── ④ 첫 패널 클릭(활성 전환) → 다음 파일은 그 패널이 받는다 ─────────────
    const focusA = await cdp.eval(`(()=>{
      const el = document.querySelector('[data-viewer-pane=' + ${J(`"${PANE_A}"`)} + ']');
      if (!el) return 'no-pane';
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);
    const switched = await poll(view, (v) => v?.active === PANE_A, 12, 250);
    r.check(
      "패널 클릭 → 활성 전환(탭 바·강조 기준인 selectedDiff 미러도 그 패널의 파일)",
      focusA === "ok" && switched?.active === PANE_A && switched.mirror === "file:src/app.txt",
      `click=${focusA} ${J(switched)}`,
    );
    await cdp.eval(
      `window.__gpv.ui.getState().selectDiff({ mode: 'file', path: '.gitignore' })`,
    );
    const toA = await poll(view, (v) => v?.byPane?.[PANE_A] === "file:.gitignore", 20, 250);
    r.check(
      "활성을 되돌린 뒤 연 파일은 **첫 패널**이 받는다(다른 패널은 불변)",
      toA?.byPane?.[PANE_A] === "file:.gitignore" &&
        toA?.byPane?.[paneB] === "file:README.md",
      J(toA?.byPane),
    );

    // ── ⑦ 영속 — 레이아웃·패널별 파일이 gp:viewer-tabs에 기록된다 ────────────
    const persisted = await poll(
      () =>
        cdp.eval(`(()=>{
          try {
            const p = JSON.parse(localStorage.getItem('gp:viewer-tabs') || 'null');
            const s = window.__gpv.ui.getState();
            if (!p) return { ok: false, why: 'no-record' };
            return {
              ok: JSON.stringify(p.viewerLayout) === JSON.stringify(s.viewerLayout) &&
                  p.viewerActivePaneId === s.viewerActivePaneId &&
                  JSON.stringify(p.viewerByPane) === JSON.stringify(s.viewerByPane),
              panes: p.viewerLayout ? JSON.stringify(p.viewerLayout).length : 0,
              active: p.viewerActivePaneId || null,
              paths: p.viewerByPane
                ? Object.values(p.viewerByPane).map(e => (e ? e.target.path : null))
                : null,
            };
          } catch (e) { return { ok: false, why: String(e.message || e) }; }
        })()`),
      (v) => v?.ok === true,
      16,
      250,
    );
    r.check(
      "레이아웃·활성 패널·패널별 파일이 localStorage(gp:viewer-tabs)에 영속된다",
      persisted?.ok === true,
      J(persisted),
    );

    // ── ⑤ Divider 드래그 → ratio 변경 + 드래그 중 draggingSplit ──────────────
    const grab = await cdp.eval(`(()=>{
      const pane = document.querySelector('[data-viewer-pane=' + ${J(`"${PANE_A}"`)} + ']');
      if (!pane) return { err: 'no-pane' };
      const wrap = pane.parentElement;                 // flexBasis 래퍼
      const div = wrap && wrap.nextElementSibling;     // Divider
      const cont = wrap && wrap.parentElement;         // SplitView 컨테이너(비율 기준)
      if (!div || !cont) return { err: 'no-divider' };
      const b = cont.getBoundingClientRect();
      if (!b.width) return { err: 'no-layout' };
      div.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      const dragging = window.__gpv.terminals.getState().draggingSplit;
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: b.left + b.width * 0.3, clientY: b.top + 10,
      }));
      return { ok: true, dragging };
    })()`);
    await sleep(120); // rAF 합치기(프레임당 1회 커밋)를 지나게 둔다
    await cdp.eval(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
    const ratio = await poll(
      () =>
        cdp.eval(
          `(()=>{ const l = window.__gpv.ui.getState().viewerLayout; return l.kind === 'split' ? l.ratio : null; })()`,
        ),
      (v) => typeof v === "number" && Math.abs(v - 0.3) < 0.02,
      16,
      250,
    );
    r.check(
      "Divider 드래그 → viewerLayout.ratio가 바뀐다(0.5 → 0.3)",
      typeof ratio === "number" && Math.abs(ratio - 0.3) < 0.02,
      `grab=${J(grab)} ratio=${ratio}`,
    );
    r.check(
      "드래그 중 draggingSplit=true (이웃 브라우저 pane의 webview 잔상 차단) → 놓으면 false",
      grab?.dragging === true &&
        (await cdp.eval(`window.__gpv.terminals.getState().draggingSplit`)) === false,
      `down=${grab?.dragging} up=${await cdp.eval(`window.__gpv.terminals.getState().draggingSplit`)}`,
    );

    // ── ⑥ 상한 4 · 패널 닫기 ────────────────────────────────────────────────
    await cdp.eval(`(()=>{
      const ui = window.__gpv.ui.getState();
      ui.splitViewerPane(ui.viewerActivePaneId, 'col', false);
      const a = window.__gpv.ui.getState();
      a.splitViewerPane(a.viewerActivePaneId, 'col', false);
      return true;
    })()`);
    const four = await poll(view, (v) => v?.ids?.length === 4, 16, 250);
    await cdp.eval(`(()=>{
      const ui = window.__gpv.ui.getState();
      ui.splitViewerPane(ui.viewerActivePaneId, 'row', false); // 상한 초과 — 무시돼야 한다
      return true;
    })()`);
    await sleep(200);
    const stillFour = await view();
    r.check(
      "분할 상한 4 — 4개에서 더 분할해도 늘지 않는다",
      four?.ids?.length === 4 && stillFour?.ids?.length === 4,
      `4분할=${four?.ids?.length} 추가시도후=${stillFour?.ids?.length}`,
    );
    const rc4 = await rightClick(stillFour.active);
    const capItem = await poll(() => menuItem("오른쪽으로 분할"), (v) => v !== "none", 12, 250);
    r.check(
      "상한 도달 시 메뉴의 분할 항목이 비활성으로 보인다",
      rc4 !== "no-pane" && capItem === "disabled",
      `우클릭=${rc4} 항목=${capItem}`,
    );
    await closeMenu();
    await sleep(150);

    // 다시 2개로 줄여 닫기 계약을 본다(3개를 메뉴로 닫는다).
    await cdp.eval(`(()=>{
      const st = window.__gpv.ui.getState();
      const ids = ${PANES};
      for (const id of ids) if (id !== ${J(PANE_A)} && id !== st.viewerActivePaneId) {
        window.__gpv.ui.getState().closeViewerPane(id);
      }
      return true;
    })()`);
    const two = await poll(view, (v) => v?.ids?.length === 2, 16, 250);
    if (two?.ids?.length === 2) {
      const other = two.ids.find((id) => id !== PANE_A);
      await rightClick(other);
      await poll(() => menuItem("패널 닫기"), (v) => v === "enabled", 12, 250);
      const closeClick = await clickMenu("패널 닫기");
      const one = await poll(view, (v) => v?.ids?.length === 1, 16, 250);
      r.check(
        "'패널 닫기' → 남은 패널이 전체를 차지하고 활성·표시 파일이 그 패널로 옮겨간다",
        closeClick === "ok" &&
          one?.ids?.length === 1 &&
          one.ids[0] === PANE_A &&
          one.active === PANE_A &&
          one.mirror === one.byPane[PANE_A],
        `click=${closeClick} ${J(one)}`,
      );
    } else {
      r.skip("패널 닫기", `2패널로 복귀 실패(ids=${two?.ids?.length})`);
    }

    // ── 회귀: Ctrl 단축키 게이트가 Alt 조합을 막는다(AltGr = Ctrl+Alt) ────────
    // 실측 재현된 버그: `Ctrl+Alt+Shift+K`가 push 흐름(업스트림 설정 확인창)을 띄웠다.
    // Windows에서 AltGr은 ctrlKey+altKey로 오므로 `@`·`\`·`|`를 치면 커밋·push가 오발한다.
    //
    // **층을 섞지 않는다.** 같은 키를 삼키는 층이 둘이다 — 여기서 재는 KeyboardShortcuts의
    // 게이트와, 이미지 편집기의 useEditorKeys(파괴적 키를 국소 소비). 편집기가 열려 있으면
    // 게이트를 통째로 되돌려도 통과하는 **가짜 green**이 되므로 그때는 스킵한다.
    //
    // 판정은 부재가 아니라 `defaultPrevented`로 한다 — 게이트는 `return`이라 preventDefault를
    // 부르지 않고, 게이트가 없으면 그 분기가 반드시 부른다. 즉 이게 게이트 개입의 직접 증거다.
    const env = await cdp.eval(`(()=>{
      const s = window.__gpv.ui.getState();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return { image: !!s.imageEditorPath, project: s.selectedProjectId || null };
    })()`);
    // push/pull은 실제 원격에 나가는 동작이다 — **격리 픽스처가 선택된 상태에서만** 누른다.
    if (env?.image || env?.project !== fix.projectId) {
      r.skip(
        "Ctrl 단축키 Alt 게이트",
        `층 분리 불가(이미지 편집기=${env?.image}) 또는 픽스처 미선택 — 스킵`,
      );
    } else {
      const send = (k, mods) =>
        cdp.eval(`(()=>{
          const ev = new KeyboardEvent('keydown', Object.assign(
            { key: ${J(k)}, bubbles: true, cancelable: true }, ${J(mods)}));
          window.dispatchEvent(ev);
          return ev.defaultPrevented;
        })()`);
      const confirmOpen = () => cdp.eval(`!!window.__gpv.ui.getState().confirm`);

      // 음성 대조(이게 더 중요하다) — Alt 없는 Ctrl+Shift+K는 **여전히 핸들러에 도달**한다.
      // 픽스처는 업스트림이 없어 확인창에서 멈춘다 → 바로 취소해 push는 나가지 않는다.
      const plainPush = await send("k", { ctrlKey: true, shiftKey: true });
      const askedUpstream = await poll(confirmOpen, (v) => v === true, 12, 250);
      await cdp.eval(`window.__gpv.ui.getState().closeConfirm()`).catch(() => {});
      await sleep(200);
      r.check(
        "음성 대조 — Ctrl+Shift+K(Alt 없음)는 그대로 동작한다(핸들러 도달 = preventDefault)",
        plainPush === true,
        `defaultPrevented=${plainPush} 업스트림확인창=${askedUpstream}`,
      );

      const toastsBefore = await cdp.eval(`window.__gpv.ui.getState().toasts.length`);
      const altPush = await send("k", { ctrlKey: true, altKey: true, shiftKey: true });
      const altCommit = await send("k", { ctrlKey: true, altKey: true });
      const altPull = await send("t", { ctrlKey: true, altKey: true });
      await sleep(700);
      const noSideEffect = await cdp.eval(`(()=>{
        const s = window.__gpv.ui.getState();
        return { confirm: !!s.confirm, prompt: !!s.prompt, toasts: s.toasts.length };
      })()`);
      r.check(
        "Ctrl+Alt+Shift+K / Ctrl+Alt+K / Ctrl+Alt+T — 게이트가 먹는다(preventDefault 없음 · 부작용 없음)",
        altPush === false &&
          altCommit === false &&
          altPull === false &&
          noSideEffect?.confirm === false &&
          noSideEffect?.prompt === false &&
          noSideEffect?.toasts === toastsBefore,
        `prevented=[${altPush},${altCommit},${altPull}] 부작용=${J(noSideEffect)} 토스트기준=${toastsBefore}`,
      );

      // 같은 게이트 아래 있는 **내 기능**(뷰어 분할)도 양쪽으로 확인한다 — 부작용이 없다.
      const panesBefore = (await view())?.ids?.length ?? 0;
      const altSplitPrevented = await send("d", {
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      });
      await sleep(400);
      const altSplit = (await view())?.ids?.length ?? 0;
      const splitPrevented = await send("d", { ctrlKey: true, shiftKey: true });
      const plain = await poll(view, (v) => v?.ids?.length === panesBefore + 1, 16, 250);
      r.check(
        "Ctrl+Alt+Shift+D는 막히고 Ctrl+Shift+D(뷰어 분할)는 그대로 동작한다",
        altSplitPrevented === false &&
          altSplit === panesBefore &&
          splitPrevented === true &&
          plain?.ids?.length === panesBefore + 1,
        `Alt조합 prevented=${altSplitPrevented} 패널 ${panesBefore}→${altSplit}, ` +
          `Alt없음 prevented=${splitPrevented} 패널→${plain?.ids?.length}`,
      );
    }


    // ── ⑧ Git 모달 안 DiffViewer 에는 Monaco 자체 메뉴가 **살아 있다** ───────
    // 억제를 상수(FILE_OPTIONS/DIFF_OPTIONS)에 두면 이 컴포넌트를 쓰는 모든 곳에서 우클릭
    // 메뉴가 죽는다 — 모달·문서 창에는 대체할 pane 메뉴가 없어 "선택 영역 번역"이 앱 어디에서도
    // 우클릭으로 안 뜬다(실제로 그렇게 들어갔던 회귀). 억제는 뷰어 리프의 prop 으로만 건다.
    //
    // 로그 탭으로 간다 — 워킹트리 변경 유무에 기대지 않는다(픽스처엔 커밋이 항상 있다).
    await cdp.eval(`window.__gpv.ui.getState().openGitDialog(${J(fix.projectId)})`);
    const MODAL = `document.querySelector('div.fixed.inset-0.z-50')`;
    const modalShown = await poll(
      () => cdp.eval(`(()=>{ const m = ${MODAL}; if (!m) return false;
        const b = Array.from(m.querySelectorAll('[role="tab"]')).find(x => x.textContent.trim() === '로그');
        if (!b) return false; b.click(); return true; })()`),
      (v) => v === true,
      16,
      250,
    );
    const commitRow = await poll(
      () => cdp.eval(`(()=>{ const m = ${MODAL}; if (!m) return 'no-modal';
        const row = Array.from(m.querySelectorAll('div'))
          .find(x => x.className.includes('cursor-pointer') && x.className.includes('border-b'));
        if (!row) return 'no-commit';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'ok'; })()`),
      (v) => v === "ok",
      16,
      250,
    );
    const fileRow = await poll(
      () => cdp.eval(`(()=>{ const m = ${MODAL}; if (!m) return 'no-modal';
        const el = Array.from(m.querySelectorAll('div[title]'))
          .find(x => x.className.includes('cursor-pointer'));
        if (!el) return 'no-row';
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return el.getAttribute('title') || 'ok'; })()`),
      (v) => !!v && v !== "no-modal" && v !== "no-row",
      16,
      250,
    );
    // 준비 = 아래 우클릭이 겨누는 "글자 있는 줄"이 **같은 요소로** 두 폴링(250ms) 연속 붙어 있다. `.view-lines` 존재만
    // 보면 DiffEditor 가 모델을 갈아 끼우는 중(옛 뷰 해체 ~ 새 뷰 전)에 쏠 수 있다 — 단언 시점엔 글자 있는 줄이 없었는데
    // 수 ms 뒤 진단에서는 있던 실측(prevented=no-line)이 그 모양이다. 판정 조건은 그대로다.
    // 끝내 안정되지 않으면 skip 이 아니라 아래 단언으로 간다('no-line' → 실패) — skip 은 예전처럼 에디터가 없을 때만.
    //
    // 대상 줄은 DOM 순서가 아니라 **적중 판정**으로 고른다 — 그 좌표의 최상단 요소가 그 줄 안이어야 한다. 좁은 모달의
    // 수정 파일 DiffEditor 는 인라인 배치라 원본 에디터가 30px 로 접히는데, DOM 상 첫 글자 줄(원본 'line1')은 그 밖으로
    // 넘쳐 수정 에디터 줄번호 거터 **밑에** 깔린다. 거기 우클릭은 거터에 가고 Monaco 는 거터 대상이면 preventDefault 만
    // 하고 메뉴를 안 띄운다(03 뒤 커밋 'e2e: modify app.txt' 에서 prevented=true 항목=[] 실측). 추가 파일은 원본이 비어 통과했다.
    const PICK_LINE = `((m) => {
      for (const l of m.querySelectorAll('.monaco-editor .view-line')) {
        const b = l.getBoundingClientRect();
        if (!b.width || (l.textContent || '').trim().length <= 2) continue;
        const x = Math.round(b.left + 12), y = Math.round(b.top + b.height / 2);
        const el = document.elementFromPoint(x, y);
        if (el && l.contains(el)) return { line: l, el, x, y };
      }
      return null;
    })`;
    const modalReady = await poll(
      () => cdp.eval(`(()=>{ const m = ${MODAL}; if (!m) return false;
        const hit = ${PICK_LINE}(m);
        const line = hit ? hit.line : null;
        const prev = window.__gpv51line; window.__gpv51line = line;
        if (line && line === prev && line.isConnected) return 'stable';
        return m.querySelector('.monaco-editor .view-lines') ? 'lines' : false; })()`),
      (v) => v === "stable",
      40,
      250,
    );
    await cdp.eval(`(()=>{ delete window.__gpv51line; return true; })()`).catch(() => {});
    const modalMonaco = modalReady === "stable" || modalReady === "lines";
    if (modalShown !== true || commitRow !== "ok" || modalMonaco !== true) {
      r.skip(
        "Git 모달 Monaco 우클릭",
        `모달 준비 실패(로그탭=${modalShown} 커밋=${commitRow} 파일=${fileRow} 에디터=${modalMonaco})`,
      );
    } else {
      const modalOpt = await cdp.eval(`(()=>{
        const m = ${MODAL};
        const eds = window.__monaco.editor.getEditors().filter(e => m.contains(e.getContainerDomNode()));
        if (!eds.length) return 'no-editor';
        return eds.every(e => e.getRawOptions().contextmenu === true) ? 'on' : 'off';
      })()`);
      r.check(
        "Git 모달 Monaco 옵션 contextmenu=true (억제는 뷰어 리프에만)",
        modalOpt === "on",
        `opt=${modalOpt} 파일=${fileRow}`,
      );
      // 본문 **글자 위**에 보낸다 — 바깥 `.monaco-editor` 에 쏘면 Monaco 내부 리스너(자손)에
      // 닿지 않아 "메뉴가 안 뜬다"가 항상 참이 된다. 판정은 `defaultPrevented`(Monaco 는 자기
      // 메뉴를 띄우는 경로에서만 부른다) + 섀도루트 안 실제 항목.
      const prevented = await cdp.eval(`(()=>{
        const hit = ${PICK_LINE}(${MODAL});
        if (!hit) return 'no-line';
        const ev = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: hit.x, clientY: hit.y, button: 2, buttons: 2, view: window,
        });
        hit.el.dispatchEvent(ev);
        return ev.defaultPrevented;
      })()`);
      const items = await poll(monacoMenuItems, (v) => Array.isArray(v) && v.length > 0, 12, 250);
      r.check(
        "Git 모달 본문 우클릭 → Monaco **자체** 메뉴가 뜬다(이번 회귀의 핵심)",
        prevented === true && Array.isArray(items) && items.length > 0,
        `prevented=${prevented} 항목=${J(items)} 준비=${modalReady}`,
      );
      // 앱 pane 메뉴는 모달 안에서 뜨지 않는다(뷰어 리프가 아니다).
      const modalSplitItem = await menuItem("오른쪽으로 분할");
      r.check(
        "모달에서는 앱 pane 메뉴(분할 항목)가 뜨지 않는다",
        modalSplitItem === "none",
        `분할항목=${modalSplitItem}`,
      );
    }
    await closeMenu().catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`).catch(() => {});
    const menuGone = await poll(
      monacoMenuItems,
      (v) => Array.isArray(v) && v.length === 0,
      12,
      250,
    );
    r.check(
      "정리 — 모달을 닫으면 Monaco 메뉴도 남지 않는다",
      Array.isArray(menuGone) && menuGone.length === 0,
      J(menuGone),
    );

    // ── ⑧ Monaco 등록 누수 — 파일을 갈아탈 때마다 전역 등록이 쌓이면 안 된다 ───────────────
    // <Editor key={editorKey}> 라 파일 전환은 에디터 리마운트다. `editor.addCommand` 는 반환이
    // 커맨드 id 문자열뿐이라 해제할 길이 없어, 마운트마다 **모듈 전역** StandaloneKeybindingService.
    // _dynamicKeybindings 와 CommandsRegistry 에 1건씩 남고 그 핸들러가 dispose 된 에디터(와 분리된
    // DOM 서브트리)를 붙잡는다. addAction(IDisposable) + onDidDispose 로 바꾼 뒤의 회귀 가드다.
    // GC 를 기다리지 않는 결정적 계수라 힙 스냅샷보다 싸고 흔들리지 않는다.
    fix.writeFile("src/app2.txt", "alpha\nbeta\ngamma\n");
    // 한 칸으로 되돌린다 — 패널이 둘이면 openFile 은 **활성** 패널에 열려, 아래 edId 가 보는
    // 첫 패널의 에디터는 그대로다(= 리마운트 전제가 거짓이 되고 계수도 두 에디터분이 섞인다).
    await cdp.eval(`window.__gpv.ui.setState({
      viewerLayout: { kind: 'leaf', paneId: ${J(PANE_A)} },
      viewerActivePaneId: ${J(PANE_A)}, viewerByPane: {}, viewerMaximizedPaneId: null,
    })`);
    const kbCount = () => cdp.eval(`(()=>{
      const eds = window.__monaco ? window.__monaco.editor.getEditors() : [];
      const svc = eds.length ? eds[0]._standaloneKeybindingService : null;
      return svc && Array.isArray(svc._dynamicKeybindings) ? svc._dynamicKeybindings.length : -1;
    })()`);
    const edId = () => cdp.eval(`(()=>{
      const host = document.querySelector('[data-viewer-pane=' + JSON.stringify(${J(PANE_A)}) + ']');
      const eds = window.__monaco ? window.__monaco.editor.getEditors() : [];
      const ed = host ? eds.find(e => host.contains(e.getContainerDomNode())) : null;
      return ed ? ed.getId() : null;
    })()`);
    await openFile("src/app.txt");
    await poll(edId, (v) => typeof v === "string", 20, 250);
    const kb0 = await kbCount();
    const ids = [await edId()];
    for (let i = 0; i < 4; i++) {
      await openFile(i % 2 ? "src/app.txt" : "src/app2.txt");
      // 전체 회차에서는 리마운트가 5초를 넘기는 회차가 있다(실측: 3번째에서 null) — 넉넉히 기다린다.
      const id = await poll(
        edId,
        (v) => typeof v === "string" && v !== ids[ids.length - 1],
        60,
        250,
      );
      ids.push(id);
    }
    const kb1 = await kbCount();
    // 전제(반증): 전환마다 에디터가 **실제로** 새로 마운트됐다. 이게 없으면 "안 쌓였다"가 공허하다.
    // 교체 순간을 읽으면 null 이 섞일 수 있어(옛 에디터 dispose 와 새 마운트 사이) 그건 잡음으로
    // 보고 **서로 다른 id 가 4개 이상**인지로 본다 — 리마운트가 아예 없으면 1개뿐이라 빨개진다.
    const distinct = new Set(ids.filter((v) => typeof v === "string")).size;
    r.check(
      "파일 전환 4회 — 에디터가 매번 새로 마운트되는데(서로 다른 id ≥ 4) Monaco 전역 동적 키바인딩 수는 그대로(등록 누수 0)",
      kb0 > 0 && distinct >= 4 && kb1 === kb0,
      `키바인딩 ${kb0} → ${kb1} · 서로 다른 id ${distinct} · ${J(ids)}`,
    );
  } finally {
    // ── 원상복구 — 사용자가 보던 레이아웃·파일·프로젝트로 되돌린다 ────────────
    await closeMenu().catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeTranslate()`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`).catch(() => {});
    // 확인창·입력창 안전망 — **이 줄이 없으면 다음 스위트가 통째로 죽는다.** 이 스위트는
    // AltGr 음성 대조에서 업스트림 확인창을 **의도적으로** 띄우고 그 자리에서 닫는데(:544),
    // 그 사이 어느 단언이든 던지면 `confirm` 이 `useUi` 에 남는다. 남은 모달은 다음 스위트의
    // 키 입력을 전부 삼켜(Ctrl+W 가 뷰어 탭을 닫는 식으로) 원인과 전혀 다른 얼굴의 실패가 된다
    // — 2026-09-09 다른 스위트에서 실제로 그렇게 9건이 죽었다. 열었을 수 있는 모달은 정리
    // 단계에서 **무조건** 닫는다(안 열려 있으면 no-op).
    await cdp.eval(`(()=>{ const s = window.__gpv.ui.getState(); s.closeConfirm(); s.closePrompt(); return true; })()`).catch(() => {});
    await cdp
      .eval(`(()=>{
        const p = JSON.parse(${J(snap)});
        window.__gpv.ui.setState({
          viewerLayout: p.layout, viewerActivePaneId: p.active, viewerByPane: p.byPane,
          viewerMaximizedPaneId: p.max, selectedDiff: p.diff, selectedDiffRepoId: p.repo,
        });
        return true;
      })()`)
      .catch(() => {});
    await cdp
      .eval(`window.__gpv.ui.getState().closeProjectViewerTabs(${J(fix.projectId)})`)
      .catch(() => {});
    await cdp
      .eval(`(()=>{
        const p = JSON.parse(${J(snap)});
        const t = window.__gpv.terminals.getState();
        const orig = ${J(origTab)};
        if (orig) t.setActiveTab(${J(fix.projectId)}, orig);
        if (p.project) window.__gpv.ui.getState().selectProject(p.project);
        if (p.agg) window.__gpv.ui.getState().setAggregateOpen(true);
        if (p.report) window.__gpv.ui.getState().toggleReport();
        return true;
      })()`)
      .catch(() => {});
    // selectProject가 활성 패널을 사용자 프로젝트의 마지막 파일로 되돌린다 — 그 위에
    // 스냅샷의 패널 상태를 한 번 더 덮어 원래 배치를 정확히 복원한다.
    await cdp
      .eval(`(()=>{
        const p = JSON.parse(${J(snap)});
        window.__gpv.ui.setState({
          viewerLayout: p.layout, viewerActivePaneId: p.active, viewerByPane: p.byPane,
          viewerMaximizedPaneId: p.max, selectedDiff: p.diff, selectedDiffRepoId: p.repo,
        });
        return true;
      })()`)
      .catch(() => {});
    await sleep(300);
  }
}
