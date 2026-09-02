// 빠른 파일 열기 (Quick Open) — 백엔드 list_repo_files + 프론트 모달 흐름.
// 백엔드: 추적+미추적 포함·.gitignore 제외·후행 '/' 없음·오류 격리. 프론트: mod+P 토글.
export const name = "빠른 파일 열기 (Quick Open / list_repo_files)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 결과 행 폴링 — 부하 걸린 머신에서 repo-files 쿼리가 6s 넘게 걸린다. 고정 sleep으로 0행일 때
// Enter를 누르면 모달이 안 닫힌 채 남아 이후 검증(모아보기 중 mod+P)까지 연쇄로 무너진다.
async function waitRows(cdp, maxMs = 30000) {
  const expr = `[...document.querySelectorAll('.z-\\\\[60\\\\] [data-idx]')].map(x=>x.textContent)`;
  const t0 = Date.now();
  for (;;) {
    const rows = await cdp.eval(expr);
    if ((Array.isArray(rows) && rows.length) || Date.now() - t0 >= maxMs) return rows || [];
    await sleep(200);
  }
}

export async function run({ cdp, report: r, fix }) {
  // ── 백엔드 list_repo_files ──
  fix.writeFile("untracked_new.txt", "hello\n"); // 미추적(--others가 잡아야 함)
  fix.writeFile("ignored.txt", "secret\n"); // .gitignore(ignored.txt) 대상 → 제외돼야 함

  const res = await cdp.invoke("list_repo_files", { projectIds: [fix.projectId] });
  const l = (res || []).find((x) => x.projectId === fix.projectId);
  const files = l?.files || [];
  r.check("list_repo_files: 배치 결과 + error 없음", res.length === 1 && l?.error === null, JSON.stringify({ n: files.length, err: l?.error }));
  r.check("추적 파일 포함(src/app.txt)", files.includes("src/app.txt"), files.slice(0, 5).join(","));
  r.check("미추적 파일 포함(untracked_new.txt)", files.includes("untracked_new.txt"));
  r.check(".gitignore 파일 제외(ignored.txt)", !files.includes("ignored.txt"));
  r.check("후행 '/' 항목 없음(임베디드 디렉토리)", !files.some((f) => f.endsWith("/")));
  r.check("forward-slash 경로", !files.some((f) => f.includes("\\")));

  const bad = await cdp.invoke("list_repo_files", { projectIds: ["no-such-project"] });
  r.check("없는 프로젝트 → error 격리(배치 미중단)", bad[0]?.error !== null && bad[0]?.files.length === 0, bad[0]?.error);

  // 정리 — 픽스처 더러움 배제
  fix.revert(".gitignore");

  // ── 프론트 모달 흐름(dev __gpv 필요) ──
  const hasStore = await cdp.eval(`!!window.__gpv && !!window.__gpv.ui`);
  if (!hasStore) {
    r.skip("Quick Open 모달", "window.__gpv 미노출 — 백엔드만 검증");
    return;
  }
  const J = (v) => JSON.stringify(v);
  const uGet = (k) => cdp.eval(`window.__gpv.ui.getState().${k}`);
  const prior = {
    pid: await uGet("selectedProjectId"),
    diff: await cdp.eval(`window.__gpv.ui.getState().selectedDiff`),
    repo: await uGet("selectedDiffRepoId"),
  };
  try {
    await cdp.eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`).catch(() => {});
    await sleep(300);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
    await cdp.eval(`window.__gpv.ui.getState().setQuickOpenOpen(false)`);
    await sleep(200);

    // mod+P → quickOpenOpen
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true,cancelable:true}))`);
    let open = false;
    for (let i = 0; i < 20; i++) { if (await uGet("quickOpenOpen")) { open = true; break; } await sleep(150); }
    r.check("mod+P → Quick Open 열림", open);
    r.check("모달 input 렌더", await cdp.eval(`!!document.querySelector('.z-\\\\[60\\\\] input')`));

    // 검색 → 결과 행(폴링) + Enter 열기
    await cdp.eval(`(()=>{
      const inp=document.querySelector('.z-\\\\[60\\\\] input'); if(!inp) return;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp,'app'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    const rows = (await waitRows(cdp)).slice(0, 5);
    r.check("검색 결과에 app.txt", rows.some((t) => /app\.txt/.test(t)), J(rows));

    if (rows.length) {
      await cdp.eval(`(()=>{ const inp=document.querySelector('.z-\\\\[60\\\\] input'); inp && inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
      await sleep(400);
      const nav = await cdp.eval(`window.__gpv.ui.getState().selectedDiff`);
      r.check("Enter → 파일 뷰어에 열림", !!nav && nav.mode === "file" && /app\.txt$/.test(nav.path || ""), J(nav));
      r.check("선택 후 모달 닫힘", (await uGet("quickOpenOpen")) === false);
    } else {
      // 전제조건 미충족 — 0행에서 Enter를 누르면 모달이 열린 채 남아 다음 검증까지 오염된다.
      r.check("Enter → 파일 뷰어에 열림", false, "결과 행 0개(30s 폴링 타임아웃) — Enter 생략");
      r.check("선택 후 모달 닫힘", false, "결과 행 0개 — 선택 불가");
      await cdp.eval(`window.__gpv.ui.getState().setQuickOpenOpen(false)`);
    }

    // 모아보기 중엔 mod+P 무동작(등록 위치 — KeyboardShortcuts 언마운트)
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`);
    await sleep(200);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',ctrlKey:true,bubbles:true,cancelable:true}))`);
    await sleep(400);
    r.check("모아보기 중 mod+P 무동작", (await uGet("quickOpenOpen")) === false);
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`).catch(() => {});
    await cdp.eval(`window.__gpv.ui.getState().setQuickOpenOpen(false)`).catch(() => {});
    // 픽스처에서 연 탭 정리 + 상태 원복
    // selectProject를 selectDiff보다 **먼저** — 순서가 바뀌면 selectDiff가 아직 픽스처인
    // selectedProjectId로 사용자 파일을 activeDiffByProject/viewerTabs에 기록해 다음 스위트가 그 파일을 연다.
    await cdp.eval(`(()=>{ const u=window.__gpv.ui.getState();
      for (const t of [...u.viewerTabs].filter(t=>t.outerId===${J(fix.projectId)})) u.closeViewerTab(t.key);
      if (${J(prior.pid)}) u.selectProject(${J(prior.pid)});
      u.selectDiff(${J(prior.diff)}, ${J(prior.repo)}); })()`).catch(() => {});
  }
}
