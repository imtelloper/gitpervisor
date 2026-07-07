// 전역 코드 검색 (Find in Files / search_in_project) — 백엔드 옵션 + 프론트 패널 흐름.
export const name = "전역 코드 검색 (search_in_project)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cdp, report: r, fix }) {
  fix.writeFile("search_a.ts", ["const gpvNeedle = 1;", "function gpvNeedleFn() {}", "// GPVNEEDLE upper", ""].join("\n"));
  fix.writeFile("search_b.py", ["gpv_needle_py = 2", "def other(): pass", ""].join("\n"));

  const S = (query, o = {}) =>
    cdp.invoke("search_in_project", { projectId: fix.projectId, query, regex: false, caseSensitive: false, wholeWord: false, include: [], ...o });

  const lit = await S("gpvNeedle");
  r.check("리터럴: 매치 + 파일 그룹핑", lit.totalMatches >= 2 && lit.files.some((f) => f.path === "search_a.ts"), JSON.stringify({ n: lit.totalMatches, files: lit.files.map((f) => f.path) }));
  r.check("매치에 line/column/text", lit.files[0]?.matches[0]?.line >= 1 && typeof lit.files[0].matches[0].text === "string");

  const glob = await S("gpv", { include: ["*.py"] });
  r.check("include 글롭 *.py 한정", glob.files.length > 0 && glob.files.every((f) => f.path.endsWith(".py")), JSON.stringify(glob.files.map((f) => f.path)));

  const reOn = await S("gpvNeedle\\w*", { regex: true, include: ["*.ts"] });
  r.check("정규식 검색", reOn.totalMatches >= 2, `n=${reOn.totalMatches}`);

  const caseOff = await S("GPVNEEDLE", { caseSensitive: false, include: ["*.ts"] });
  const caseOn = await S("GPVNEEDLE", { caseSensitive: true, include: ["*.ts"] });
  r.check("대소문자: off > on", caseOff.totalMatches > caseOn.totalMatches, `off=${caseOff.totalMatches} on=${caseOn.totalMatches}`);

  const word = await S("gpvNeedle", { wholeWord: true, include: ["*.ts"] });
  r.check("단어 단위(gpvNeedleFn 제외)", word.totalMatches < lit.totalMatches, `word=${word.totalMatches} all=${lit.totalMatches}`);

  const bad = await cdp.try("search_in_project", { projectId: fix.projectId, query: "(unclosed", regex: true, caseSensitive: false, wholeWord: false, include: [] });
  r.check("잘못된 정규식 → GIT_ERROR", !bad.ok && bad.code === "GIT_ERROR", bad.code);

  r.check("1자 미만 → 빈 결과", (await S("a")).files.length === 0);

  const noProj = await cdp.try("search_in_project", { projectId: "no-such", query: "test", regex: false, caseSensitive: false, wholeWord: false, include: [] });
  r.check("없는 프로젝트 → NOT_FOUND", !noProj.ok && noProj.code === "NOT_FOUND", noProj.code);

  // ── 프론트 패널 ──
  const hasStore = await cdp.eval(`!!window.__gpv && !!window.__gpv.ui`);
  if (!hasStore) {
    r.skip("Find in Files 패널", "window.__gpv 미노출 — 백엔드만 검증");
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
    await sleep(200);

    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))`);
    await sleep(400);
    r.check("mod+Shift+F → 패널 열림", await cdp.eval(`(()=>[...document.querySelectorAll('input')].some(i=>/검색.*Enter/.test(i.placeholder||'')))()`));

    const searched = await cdp.eval(`(async ()=>{
      const inp=[...document.querySelectorAll('input')].find(i=>/검색.*Enter/.test(i.placeholder||''));
      if(!inp) return null;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp,'gpvNeedle'); inp.dispatchEvent(new Event('input',{bubbles:true}));
      inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,1500));
      return [...document.querySelectorAll('mark')].map(m=>m.textContent).slice(0,3);
    })()`);
    r.check("검색 결과 하이라이트(<mark>)", Array.isArray(searched) && searched.some((m) => /gpvNeedle/i.test(m || "")), J(searched));

    const nav = await cdp.eval(`(async ()=>{
      const rows=[...document.querySelectorAll('button')].filter(b=>b.className.includes('font-mono') && b.className.includes('pl-6'));
      if(!rows.length) return null;
      rows[0].click(); await new Promise(r=>setTimeout(r,500));
      return window.__gpv.ui.getState().selectedDiff;
    })()`);
    r.check("결과 클릭 → 뷰어 점프(line)", !!nav && nav.mode === "file" && nav.line >= 1, J(nav));
  } finally {
    await cdp.eval(`window.__gpv && (window.__gpv.ui.getState().setAggregateOpen(false))`).catch(() => {});
    // search 스토어는 __gpv에 없으니 Esc 키로 패널 닫기 시도
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`).catch(() => {});
    await cdp.eval(`(()=>{ const u=window.__gpv.ui.getState();
      for (const t of [...u.viewerTabs].filter(t=>t.outerId===${J(fix.projectId)})) u.closeViewerTab(t.key);
      u.selectDiff(${J(prior.diff)}, ${J(prior.repo)}); if(${J(prior.pid)}) u.selectProject(${J(prior.pid)}); })()`).catch(() => {});
  }
}
