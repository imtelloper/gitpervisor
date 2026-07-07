// 전역 심볼 검색 (Go to Symbol / find_symbols) — 백엔드 부분일치·랭킹 + 프론트 모달 흐름.
export const name = "전역 심볼 검색 (find_symbols)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  r.check("find_symbols: 부분일치 후보 다수", names.includes("gpvAlpha") && names.includes("gpvAlphaBeta") && names.includes("GpvAlphaCls"), JSON.stringify(names));
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

    const rows = await cdp.eval(`(async ()=>{
      const inp=document.querySelector('.z-\\\\[60\\\\] input'); if(!inp) return null;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp,'gpvAlpha'); inp.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,900));
      return [...document.querySelectorAll('.z-\\\\[60\\\\] [data-idx]')].map(x=>x.textContent).slice(0,5);
    })()`);
    r.check("심볼 검색 결과 렌더(gpvAlpha)", Array.isArray(rows) && rows.some((t) => /gpvAlpha/.test(t)), J(rows));

    await cdp.eval(`(()=>{ const inp=document.querySelector('.z-\\\\[60\\\\] input'); inp && inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); })()`);
    await sleep(400);
    const nav = await cdp.eval(`window.__gpv.ui.getState().selectedDiff`);
    r.check("Enter → 심볼 착지(line/column)", !!nav && nav.mode === "file" && /syms\.ts$/.test(nav.path || "") && nav.line >= 1 && nav.column >= 1, J(nav));
    r.check("선택 후 모달 닫힘", (await uGet("symbolSearchOpen")) === false);
  } finally {
    await cdp.eval(`window.__gpv.ui.getState().setSymbolSearchOpen(false)`).catch(() => {});
    await cdp.eval(`(()=>{ const u=window.__gpv.ui.getState();
      for (const t of [...u.viewerTabs].filter(t=>t.outerId===${J(fix.projectId)})) u.closeViewerTab(t.key);
      u.selectDiff(${J(prior.diff)}, ${J(prior.repo)});
      if (${J(prior.pid)}) u.selectProject(${J(prior.pid)}); })()`).catch(() => {});
  }
}
