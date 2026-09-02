// 전역 심볼 검색 (Go to Symbol / find_symbols) — 백엔드 부분일치·랭킹 + 프론트 모달 흐름.
export const name = "전역 심볼 검색 (find_symbols)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 결과 행 폴링 — 부하 걸린 머신에서 find_symbols(git grep 21패턴)가 17s 넘게 걸린다.
// 고정 sleep으로 0행일 때 Enter를 누르면 모달이 안 닫힌 채 남아 이후 검증까지 오염된다.
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
  // ── 백엔드 find_symbols ──
  fix.writeFile("syms.ts", [
    "export function gpvAlpha() {}",
    "export function gpvAlphaBeta() {}",
    "export class GpvAlphaCls {}",
    "const gpvAlphaVar = 1;",
    "",
  ].join("\n"));

  const q = (query, extHint = null) => cdp.invoke("find_symbols", { projectId: fix.projectId, query, extHint });

  const res = await q("gpvAlpha", "ts");
  const names = (res || []).map((m) => m.name);
  // smart-case(tree.rs:956, 설계 13-symbol-search.md:81): 쿼리에 대문자가 있으면 대소문자 구분 →
  // 'gpvAlpha'에 GpvAlphaCls는 **안** 잡힌다. 전부 소문자 쿼리만 -i로 넓어진다.
  r.check(
    "find_symbols: 부분일치 후보 다수(smart-case 구분)",
    names.includes("gpvAlpha") && names.includes("gpvAlphaBeta") && names.includes("gpvAlphaVar") && !names.includes("GpvAlphaCls"),
    JSON.stringify(names),
  );
  const lowerNames = (await q("gpvalpha", "ts")).map((m) => m.name);
  r.check("smart-case: 소문자 쿼리는 대소문자 무시(GpvAlphaCls 포함)", lowerNames.includes("GpvAlphaCls"), JSON.stringify(lowerNames));
  // 정확일치(gpvAlpha)가 접두(gpvAlphaBeta)보다 앞 — 랭킹
  const iExact = names.indexOf("gpvAlpha");
  const iPrefix = names.indexOf("gpvAlphaBeta");
  r.check("랭킹: 정확일치 > 접두일치", iExact >= 0 && iExact < iPrefix, `exact@${iExact} prefix@${iPrefix}`);
  const alpha = res.find((m) => m.name === "gpvAlpha");
  r.check("name/line/column + signature", alpha?.path === "syms.ts" && alpha?.line === 1 && alpha?.column >= 1 && /gpvAlpha/.test(alpha?.signature || ""), JSON.stringify(alpha));

  r.check("2자 미만 쿼리 → 빈 결과", (await q("a")).length === 0);
  r.check("특수문자 쿼리 → 빈 결과", (await q("bad-sym!")).length === 0);
  const bad = await cdp.try("find_symbols", { projectId: "no-such-project", query: "test", extHint: null });
  r.check("없는 프로젝트 → NOT_FOUND", !bad.ok && bad.code === "NOT_FOUND", bad.code);

  // find_definition 회귀 가드 — 정확일치만(부분일치 오염 없음)
  const defExact = await cdp.invoke("find_definition", { projectId: fix.projectId, symbol: "gpvAlpha", ext: "ts" });
  const defPartial = await cdp.invoke("find_definition", { projectId: fix.projectId, symbol: "gpvAlph", ext: "ts" });
  r.check("회귀: find_definition은 정확일치 유지", defExact.some((m) => m.path === "syms.ts") && defPartial.length === 0, `exact=${defExact.length} partial=${defPartial.length}`);

  // ── 프론트 모달 흐름 ──
  const hasStore = await cdp.eval(`!!window.__gpv && !!window.__gpv.ui`);
  if (!hasStore) {
    r.skip("심볼 검색 모달", "window.__gpv 미노출 — 백엔드만 검증");
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
    await cdp.eval(`window.__gpv.ui.getState().setSymbolSearchOpen(false)`);
    await sleep(200);

    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))`);
    let open = false;
    for (let i = 0; i < 20; i++) { if (await uGet("symbolSearchOpen")) { open = true; break; } await sleep(150); }
    r.check("mod+Alt+N → 심볼 검색 열림", open);

    await cdp.eval(`(()=>{
      const inp=document.querySelector('.z-\\\\[60\\\\] input'); if(!inp) return;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp,'gpvAlpha'); inp.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    const rows = (await waitRows(cdp)).slice(0, 5);
    r.check("심볼 검색 결과 렌더(gpvAlpha)", rows.some((t) => /gpvAlpha/.test(t)), J(rows));

    if (rows.length) {
      await cdp.eval(`(()=>{ const inp=document.querySelector('.z-\\\\[60\\\\] input'); inp && inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
      await sleep(400);
      const nav = await cdp.eval(`window.__gpv.ui.getState().selectedDiff`);
      r.check("Enter → 심볼 착지(line/column)", !!nav && nav.mode === "file" && /syms\.ts$/.test(nav.path || "") && nav.line >= 1 && nav.column >= 1, J(nav));
      r.check("선택 후 모달 닫힘", (await uGet("symbolSearchOpen")) === false);
    } else {
      // 전제조건 미충족 — 0행에서 Enter를 누르면 모달이 열린 채 남아 다음 검증까지 오염된다.
      r.check("Enter → 심볼 착지(line/column)", false, "결과 행 0개(30s 폴링 타임아웃) — Enter 생략");
      r.check("선택 후 모달 닫힘", false, "결과 행 0개 — 선택 불가");
      await cdp.eval(`window.__gpv.ui.getState().setSymbolSearchOpen(false)`);
    }
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setSymbolSearchOpen(false)`).catch(() => {});
    // selectProject를 selectDiff보다 **먼저** — 순서가 바뀌면 selectDiff가 아직 픽스처인
    // selectedProjectId로 사용자 파일을 activeDiffByProject/viewerTabs에 기록해 다음 스위트가 그 파일을 연다.
    await cdp.eval(`(()=>{ const u=window.__gpv.ui.getState();
      for (const t of [...u.viewerTabs].filter(t=>t.outerId===${J(fix.projectId)})) u.closeViewerTab(t.key);
      if (${J(prior.pid)}) u.selectProject(${J(prior.pid)});
      u.selectDiff(${J(prior.diff)}, ${J(prior.repo)}); })()`).catch(() => {});
  }
}
