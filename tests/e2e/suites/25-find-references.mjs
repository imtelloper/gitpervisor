// 참조 찾기 (Find Usages / find_references) — 백엔드 git grep -F -w + peek 위젯(Shift+F12).
export const name = "참조 찾기 (find_references)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cdp, report: r, fix }) {
  fix.writeFile("refdef.ts", ["export function gpvRefTarget() { return 1; }", ""].join("\n"));
  fix.writeFile("refuse.ts", [
    "import { gpvRefTarget } from './refdef';",
    "const a = gpvRefTarget();",
    "const b = gpvRefTarget() + gpvRefTarget();",
    "const c = gpvRefTargetXyz();", // -w로 제외돼야 함
    "",
  ].join("\n"));

  const res = await cdp.invoke("find_references", { projectId: fix.projectId, symbol: "gpvRefTarget", ext: "ts" });
  const paths = res.matches.map((m) => m.path);
  r.check("두 파일에서 참조 발견", paths.includes("refdef.ts") && paths.includes("refuse.ts"), JSON.stringify([...new Set(paths)]));
  r.check("1-based line/column", res.matches.every((m) => m.line >= 1 && m.column >= 1));
  r.check("단어 경계(-w): gpvRefTargetXyz 미매치", !res.matches.some((m) => m.path === "refuse.ts" && m.line === 4), `lines=${res.matches.filter((m) => m.path === "refuse.ts").map((m) => m.line)}`);
  r.check("truncated=false(소량)", res.truncated === false);

  r.check("없는 심볼 → 빈 결과", (await cdp.invoke("find_references", { projectId: fix.projectId, symbol: "gpvNoneXyz", ext: "ts" })).matches.length === 0);
  r.check("비식별자 거부", (await cdp.invoke("find_references", { projectId: fix.projectId, symbol: "bad-x!", ext: "ts" })).matches.length === 0);
  const noProj = await cdp.try("find_references", { projectId: "no-such", symbol: "x", ext: "ts" });
  r.check("없는 프로젝트 → NOT_FOUND", !noProj.ok && noProj.code === "NOT_FOUND", noProj.code);

  // ── 프론트 peek ──
  const hasStore = await cdp.eval(`!!window.__gpv && !!window.__monaco`);
  if (!hasStore) {
    r.skip("참조 peek 위젯", "window.__gpv/__monaco 미노출 — 백엔드만 검증");
    return;
  }
  const J = (v) => JSON.stringify(v);
  const prior = {
    pid: await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`),
    diff: await cdp.eval(`window.__gpv.ui.getState().selectedDiff`),
    repo: await cdp.eval(`window.__gpv.ui.getState().selectedDiffRepoId`),
  };
  try {
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await sleep(300);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
    await cdp.eval(`window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, 'viewer')`);
    await cdp.eval(`window.__gpv.ui.getState().selectDiff({ mode:'file', path:'refuse.ts' }, ${J(fix.projectId)})`);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      ready = await cdp.eval(`(()=>{ const m=window.__monaco; if(!m) return false; return m.editor.getEditors().some(e=>e.getModel()?.getValue().includes('gpvRefTarget')); })()`);
      if (ready) break;
      await sleep(300);
    }
    const peek = await cdp.eval(`(async ()=>{
      const m=window.__monaco;
      const ed=m.editor.getEditors().find(e=>e.getModel()?.getValue().includes('gpvRefTarget'));
      if(!ed) return { err:'no editor' };
      const model=ed.getModel();
      const hit=model.findNextMatch('gpvRefTarget(', {lineNumber:2,column:1}, false, true, null, false);
      ed.setPosition({ lineNumber: hit.range.startLineNumber, column: hit.range.startColumn+2 });
      ed.focus();
      ed.trigger('e2e','editor.action.goToReferences',{});
      let w=null;
      for(let i=0;i<24;i++){ await new Promise(r=>setTimeout(r,200)); w=document.querySelector('.reference-zone-widget, .peekview-widget'); if(w && w.getBoundingClientRect().height>0) break; }
      const visible=!!(w && w.getBoundingClientRect().height>0);
      const rows = w ? w.querySelectorAll('.monaco-list-row').length : 0;
      ed.focus(); ed.trigger('e2e','closeReferenceSearch',{});
      return { visible, rows };
    })()`);
    r.check("Shift+F12 → peek 위젯 표시(참조 목록)", peek.visible === true && peek.rows >= 1, J(peek));
  } finally {
    await cdp.eval(`(()=>{ const u=window.__gpv.ui.getState();
      for (const t of [...u.viewerTabs].filter(t=>t.outerId===${J(fix.projectId)})) u.closeViewerTab(t.key);
      u.selectDiff(${J(prior.diff)}, ${J(prior.repo)}); if(${J(prior.pid)}) u.selectProject(${J(prior.pid)}); })()`).catch(() => {});
  }
}
