// 태스크 55 — 터미널 세션 헤더의 Git 버튼 → 그 프로젝트의 변경·로그 **모달**.
//
// 지키는 계약 넷:
//   ① 모달 안에서 파일을 클릭해도 **전역이 안 움직인다** — `selectedDiff`·뷰어 탭 수·모아보기 열림이
//      클릭 전후로 같아야 한다. 그냥 `selectDiff`를 쓰면 뷰어 탭이 늘고 **모아보기가 닫힌다**(ui.ts:317).
//      모아보기에서 보려고 만든 모달이 열자마자 모아보기를 닫는 게 이 태스크의 유일한 함정이다.
//   ② 변경 탭·로그 탭 모두 모달 **안에서** diff가 그려진다(모달 로컬 선택 → 모달 안 DiffViewer).
//   ③ 모아보기가 열린 채로 같은 조작을 해도 `aggregateOpen`이 true로 남는다.
//   ④ 세션 헤더 버튼으로도 열리고 Esc로 닫힌다(`gitDialog === null`).
//
// 픽스처의 추적 파일 `src/app.txt`를 한 줄 고쳐 미커밋 변경 1개를 만든다(03-status-changes 관례).
export const name = "Git 변경·로그 모달 (모달 로컬 선택 · 전역 불변 · 모아보기 유지 · 헤더 버튼·Esc)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const REL = "src/app.txt";
const MODAL = `document.querySelector('div.fixed.inset-0.z-50')`;

export async function run({ cdp, report: r, fix }) {
  const hooks = await cdp.eval(
    `!!(window.__gpv && window.__gpv.ui && window.__gpv.queryClient)`,
  );
  if (!hooks) {
    r.skip("Git 변경·로그 모달", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn().catch(() => null);
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };

  /** 전역 스냅샷 — ①의 불변 단언 대상. selectedCommitSha는 제외한다(Log 패널과 스토어 공유가 설계). */
  const globals = () =>
    cdp.eval(`(()=>{
      const s = window.__gpv.ui.getState();
      return {
        diff: s.selectedDiff ? JSON.stringify(s.selectedDiff) : null,
        repo: s.selectedDiffRepoId || null,
        tabs: s.viewerTabs.length,
        agg: !!s.aggregateOpen,
      };
    })()`);
  const sameGlobals = (a, b) =>
    !!a && !!b && a.diff === b.diff && a.repo === b.repo && a.tabs === b.tabs && a.agg === b.agg;

  const dialogOpen = () => cdp.eval(`!!window.__gpv.ui.getState().gitDialog`);
  const openDialog = () =>
    cdp.eval(`window.__gpv.ui.getState().openGitDialog(${J(fix.projectId)})`);
  const esc = () =>
    cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  /** 모달 안에서 title이 정확히 일치하는 행(변경 행·커밋 상세 파일 행)을 클릭한다. */
  const clickRow = (title) =>
    cdp.eval(`(()=>{
      const m = ${MODAL};
      if (!m) return 'no-modal';
      const el = Array.from(m.querySelectorAll('div[title]'))
        .find(x => x.getAttribute('title') === ${J(title)});
      if (!el) return 'no-row';
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'ok';
    })()`);

  /**
   * 모달 안 **첫 파일 행**(변경 목록 행 또는 커밋 상세 파일 행)을 클릭하고 그 title(=경로)을 준다.
   * 커밋 목록 행은 title이 없어 걸리지 않는다. 로그 탭에서 경로를 하드코딩하면 안 된다 —
   * 04가 픽스처를 외부 커밋(ext.txt만 건드림)으로 fast-forward 하므로 전체 회차에서는 최신 커밋에
   * src/app.txt가 아예 없다(단독 실행만 통과하는 단언이 된다).
   */
  const clickFirstFileRow = () =>
    cdp.eval(`(()=>{
      const m = ${MODAL};
      if (!m) return 'no-modal';
      const el = Array.from(m.querySelectorAll('div[title]'))
        .find(x => x.className.includes('cursor-pointer'));
      if (!el) return 'no-row';
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return el.getAttribute('title') || 'ok';
    })()`);
  const rowOk = (v) => !!v && v !== "no-modal" && v !== "no-row";

  /** 모달 안에 diff가 그려졌는지 — Monaco가 뜨거나(텍스트) 최소한 빈 상태가 사라졌는지. */
  const modalDiff = () =>
    cdp.eval(`(()=>{
      const m = ${MODAL};
      if (!m) return 'no-modal';
      if (m.querySelector('.monaco-editor')) return 'monaco';
      return (m.textContent || '').includes('파일을 선택하세요') ? 'empty' : 'other';
    })()`);

  const clickTab = (label) =>
    cdp.eval(`(()=>{
      const m = ${MODAL};
      const b = m && Array.from(m.querySelectorAll('[role="tab"]'))
        .find(x => x.textContent.trim() === ${J(label)});
      if (!b) return false;
      b.click();
      return true;
    })()`);

  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);

  try {
    // ── 셋업: 픽스처 선택 + 미커밋 변경 1개 ──────────────────────────────────
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(500);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    const stuck = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
      (v) => v === fix.projectId,
      12,
      250,
    );
    if (stuck !== fix.projectId) {
      r.skip("Git 변경·로그 모달", `픽스처 선택 실패(selected=${String(stuck).slice(0, 8)})`);
      return;
    }
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    fix.writeFile(REL, "line1\nline2\nline3\ngit-dialog e2e\n");
    // 변경이 **실제로 목록에 뜰 때까지** 기다린다. 고정 sleep이면 워처가 늦은 회차에서
    // 변경 탭이 비어 있어 아래 행 클릭이 'no-row'로 떨어진다(실측). 무효화 키도 둘 다 친다 —
    // ChangesPanel은 `useStatuses()`, 그 안의 RepoChanges는 `useStatus(projectId)`를 쓴다.
    for (let i = 0; i < 20; i++) {
      await cdp
        .eval(
          `(()=>{ const qc=window.__gpv.queryClient;
             qc.invalidateQueries({ queryKey: ["statuses"] });
             qc.invalidateQueries({ queryKey: ["status"] });
             return true; })()`,
        )
        .catch(() => {});
      const seen = await cdp
        .eval(
          `(()=>{ const ss = window.__gpv.queryClient.getQueryData(["statuses"])||[];
             const s = ss.find(x=>x.projectId===${J(fix.projectId)});
             if(!s) return false;
             return [...(s.unstaged||[]),...(s.staged||[])].some(c=>c.path===${J(REL)}); })()`,
        )
        .catch(() => false);
      if (seen === true) break;
      await sleep(300);
    }

    // ── 열기 + 껍데기 단언 ───────────────────────────────────────────────────
    await openDialog();
    const shell = await poll(
      () =>
        cdp.eval(`(()=>{
          const m = ${MODAL};
          if (!m) return null;
          const t = m.textContent || '';
          return {
            tabs: Array.from(m.querySelectorAll('[role="tab"]')).map(x => x.textContent.trim()),
            changes: t.includes('Changes'),
          };
        })()`),
      (v) => !!v && v.tabs.length === 2,
      20,
      250,
    );
    if (
      !r.check(
        "openGitDialog → 모달에 탭 [변경 | 로그] + Changes 패널",
        !!shell &&
          shell.tabs[0] === "변경" &&
          shell.tabs[1] === "로그" &&
          shell.changes === true,
        `shell=${J(shell)}`,
      )
    )
      return;

    // ── ① ② 변경 탭: 행 클릭 → 모달 안 diff, 전역 불변 ─────────────────────
    const g0 = await globals();
    // 워킹트리 변경이 목록에 도착할 때까지 **모달 안에서** 기다린다 — 워처 디바운스·refetch가
    // 늦으면 방금 쓴 파일이 아직 없다. 저장 직후 store를 폴링하는 방식은 안 통한다:
    // `useStatuses`의 키가 `["statuses", [ids]]`라 `getQueryData(["statuses"])`가 undefined다
    // (무효화는 prefix 매칭이라 먹지만, 도착 확인은 화면에서 해야 한다).
    const clicked = await poll(
      async () => {
        const res = await clickRow(REL);
        if (res === "ok") return res;
        await cdp
          .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["statuses"] })`)
          .catch(() => {});
        return res;
      },
      (v) => v === "ok",
      24,
      500,
    );
    r.check(`변경 목록에서 ${REL} 행 클릭`, clicked === "ok", `res=${clicked}`);
    const d1 = await poll(modalDiff, (v) => v === "monaco", 40, 250);
    r.check("모달 안에 diff가 그려진다(변경 탭)", d1 === "monaco", `state=${d1}`);
    const g1 = await globals();
    r.check(
      "전역 불변 — selectedDiff·뷰어 탭 수·모아보기 상태가 클릭 전후 동일(모달 로컬 선택)",
      sameGlobals(g0, g1),
      `before=${J(g0)} after=${J(g1)}`,
    );

    // ── ② 로그 탭: 커밋 → 파일 → 모달 안 diff, 전역 불변 ────────────────────
    r.check("'로그' 탭 전환", (await clickTab("로그")) === true);
    const commitClicked = await poll(
      () =>
        cdp.eval(`(()=>{
          const m = ${MODAL};
          if (!m) return 'no-modal';
          const row = Array.from(m.querySelectorAll('div'))
            .find(x => x.className.includes('cursor-pointer') && x.className.includes('border-b'));
          if (!row) return 'no-commit';
          row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'ok';
        })()`),
      (v) => v === "ok",
      20,
      250,
    );
    r.check("커밋 목록에서 첫 커밋 클릭", commitClicked === "ok", `res=${commitClicked}`);
    const filePath = await poll(clickFirstFileRow, rowOk, 20, 250);
    r.check("커밋 상세의 첫 파일 행 클릭", rowOk(filePath), `res=${filePath}`);
    const d2 = await poll(modalDiff, (v) => v === "monaco", 40, 250);
    r.check("모달 안에 커밋 diff가 그려진다(로그 탭)", d2 === "monaco", `state=${d2}`);
    const g2 = await globals();
    r.check(
      "로그 탭에서도 전역 불변(커밋 파일 클릭이 뷰어 탭을 만들지 않는다)",
      sameGlobals(g0, g2),
      `before=${J(g0)} after=${J(g2)}`,
    );

    // ── ④ Esc로 닫힘 ────────────────────────────────────────────────────────
    await esc();
    const closed = await poll(dialogOpen, (v) => v === false, 12, 250);
    r.check("Esc → 모달 닫힘(gitDialog === null)", closed === false, `open=${closed}`);

    // ── ③ 모아보기가 열린 채로 같은 조작 → 모아보기 유지 ────────────────────
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`);
    const aggOn = await poll(
      () => cdp.eval(`window.__gpv.ui.getState().aggregateOpen`),
      (v) => v === true,
      12,
      250,
    );
    if (aggOn !== true) {
      r.skip("모아보기 유지 단언", "모아보기를 열지 못했다");
    } else {
      // 셀 헤더(또는 pane 오버레이)의 Git 버튼으로 연다 — 스토어 직접 호출이 아닌 실제 동선.
      const btn = await cdp.eval(`(()=>{
        const b = document.querySelector('button[title="Git 변경·로그 보기"]');
        if (!b) return 'no-button';
        b.click();
        return 'ok';
      })()`);
      if (btn === "ok") {
        const opened = await poll(dialogOpen, (v) => v === true, 12, 250);
        r.check("세션 헤더 Git 버튼 클릭으로도 열린다", opened === true, `open=${opened}`);
        // 버튼이 연 모달은 **그 셀의 프로젝트**라 변경 행이 하나도 없을 수 있다 — 아래 행 클릭은
        // 변경 1개가 보장된 픽스처로 다시 열어 결정적으로 만든다.
        await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`);
        await sleep(200);
      } else {
        r.skip("세션 헤더 Git 버튼", "버튼이 없다(터미널 세션 없음) — openGitDialog로 대체");
      }
      await openDialog();
      await poll(dialogOpen, (v) => v === true, 12, 250);
      // 클릭 전 값을 잡아 둔다. 클릭이 실제로 일어나야 의미가 있는 단언이므로 'no-row'는
      // 성공이 아니다 — 그걸 성공으로 받으면 아무 것도 안 누른 채 같은 상태끼리 비교해 늘 통과한다.
      const g3 = await globals();
      const clickedRow = await poll(clickFirstFileRow, rowOk, 12, 250);
      r.check("모아보기 상태에서 모달의 파일 행 클릭", rowOk(clickedRow), `res=${clickedRow}`);
      await sleep(600);
      const g4 = await globals();
      r.check(
        "모아보기가 열린 채 모달에서 파일을 눌러도 모아보기가 닫히지 않는다",
        rowOk(clickedRow) &&
          !!g4 &&
          g4.agg === true &&
          g4.tabs === g3.tabs &&
          g4.diff === g3.diff,
        `before=${J(g3)} after=${J(g4)} click=${clickedRow}`,
      );
      await esc();
      await poll(dialogOpen, (v) => v === false, 12, 250);
      await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
      await sleep(200);
    }

    // 점유 계약(selectBlockingOverlay에 gitDialog 포함)은 셀렉터가 __gpv에 노출돼 있지 않아
    // 여기서 잴 수 없다 — main.tsx 노출은 이 태스크 범위 밖이라 실기(§5.2)로 남긴다.
    r.skip(
      "점유 계약(selectBlockingOverlay에 gitDialog)",
      "selectBlockingOverlay가 __gpv에 노출돼 있지 않다 — 브라우저 셀 위 표시는 실기 확인",
    );
  } finally {
    await esc().catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().closeGitDialog()`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    try {
      fix.revert(REL);
    } catch {
      /* 픽스처 정리가 통째로 지운다 — 실패해도 무해 */
    }
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["statuses"] })`)
      .catch(() => {});
    if (origSel)
      await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`).catch(() => {});
    await sleep(300);
  }
}
