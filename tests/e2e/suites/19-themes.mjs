// 테마 시스템 e2e — 6개 테마 id 각각에 대해 set_settings → DOM 반영을 단언한다.
// styles.css `[data-theme]` 블록 ↔ themes.ts THEMES 엔트리의 짝 누락은 --color-base가
// 잡는다: 블록이 빠지면 기본(darcula) 값이 그대로라 "6개 전부 상이" 검사에서 겹쳐 실패.
// 열린 xterm에는 refreshTerminalThemes 재적용을 .xterm-scrollable-element 배경색으로
// 확인하고(xterm 6은 onChangeColors 때 theme.background를 이 노드 인라인 스타일로 반영 —
// .xterm-viewport가 아님), 끝나면 원래 테마로 복원한다.
//
// set_settings 원시 invoke는 React Query 캐시를 모르므로, dev 노출 __gpv.queryClient로
// settings 쿼리를 invalidate해 App의 테마 effect(dataset.theme 의존 체인)를 구동한다.

export const name =
  "테마 시스템 (6종 전환 / CSS 토큰 / xterm 재적용 / 복원 / 커스텀 테마)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// themes.ts THEMES와 1:1이어야 하는 목록 — 테마 추가 시 여기에도 추가(짝 검증의 제3사본).
const THEME_IDS = ["darcula", "monokai", "dracula", "nord", "light", "solarized-light"];

/** "#rrggbb" → getComputedStyle이 돌려주는 "rgb(r, g, b)" 표기. */
function rgbOf(hex) {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

export async function run({ cdp, report: r, fix }) {
  const hasStore = await cdp.eval(`!!window.__gpv && !!window.__gpv.queryClient`);
  if (!hasStore) {
    r.skip("테마 시스템", "window.__gpv 미노출(dev 빌드 아님) — 스킵");
    return;
  }

  const J = (v) => JSON.stringify(v);
  const poll = async (fn, ok, tries = 20, ms = 250) => {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (ok(v)) return v;
      await sleep(ms);
    }
    return v;
  };
  const invalidateSettings = () =>
    cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["settings"] })`)
      .catch(() => {});
  const domTheme = () => cdp.eval(`document.documentElement.dataset.theme || null`);
  const cssBase = () =>
    cdp.eval(
      `getComputedStyle(document.documentElement).getPropertyValue("--color-base").trim()`,
    );
  const xtermBg = () =>
    cdp.eval(
      `(()=>{ const v=document.querySelector('.xterm-scrollable-element'); return v?getComputedStyle(v).backgroundColor:null; })()`,
    );

  // 태스크 28 — 사이드바 행 틴트 대비. 절대 목표(4.5/4.5/3.0)는 틴트 없는 오늘의 행도 못 넘으므로
  // (darcula fg-dim 2.90:1) 이름만 절대, 나머지는 "현행 bg-selection 위 대비" 기준선으로 본다.
  // 허용 오차는 hsl→rgb 반올림분(0.1). solarized-light는 selection≈panel이라 보이는 틴트가 전부
  // 기준선 아래 — 그 테마 특성으로 수용한 예외값(28 §3.4·§8 ①).
  const TINT_TOL = { default: 0.1, "solarized-light": 0.35 };
  const fmt = (m) => ["fg", "muted", "dim"].map((k) => m[k].toFixed(2)).join("/");

  const orig = await cdp.invoke("get_settings");
  const origTheme = orig.theme || "darcula";
  const origSel = await cdp.eval(`window.__gpv.ui.getState().selectedProjectId`);
  let tabId = null;

  try {
    // ── 셋업: 픽스처 선택 + 터미널 1개(열린 xterm 재적용 단언용 — 실패해도 테마 단언은 계속) ──
    await cdp
      .eval(`window.__gpv.queryClient.invalidateQueries({ queryKey: ["projects"] })`)
      .catch(() => {});
    await sleep(400);
    await cdp.eval(`window.__gpv.ui.getState().selectProject(${J(fix.projectId)})`);
    tabId = await cdp
      .eval(`window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)}).tabId`)
      .catch(() => null);
    if (tabId)
      await cdp.eval(
        `window.__gpv.terminals.getState().setActiveTab(${J(fix.projectId)}, ${J(tabId)})`,
      );
    const hasXterm =
      (await poll(
        () => cdp.eval(`!!document.querySelector('.xterm-scrollable-element')`),
        (v) => v === true,
        20,
        300,
      )) === true;
    if (!hasXterm) r.skip("xterm 테마 재적용", "터미널 미렌더 — DOM 토큰 단언만 진행");

    // ── 6개 테마 순회: set_settings → dataset.theme · --color-base · xterm 배경 ──
    const bases = {};
    for (const id of THEME_IDS) {
      await cdp.invoke("set_settings", { settings: { ...orig, theme: id } });
      await invalidateSettings();
      const applied = await poll(domTheme, (v) => v === id, 20, 250);
      r.check(`[${id}] data-theme 반영`, applied === id, `dataset=${applied}`);

      const base = await cssBase();
      bases[id] = base;
      r.check(`[${id}] --color-base 유효(#rrggbb)`, /^#[0-9a-fA-F]{6}$/.test(base), base);

      // 12 hue × row/row-on을 --color-panel 위에 합성해 실제 테마 토큰으로 WCAG 대비를 계산한다
      // (사전 계산 대체가 아니라 브라우저 hsl 파싱으로 확정하는 측정 그 자체 — 태스크 28 §7.2).
      const c = await cdp.eval(`(()=>{
        const HUES=[0,25,45,75,140,168,190,215,250,280,310,335];
        const css=getComputedStyle(document.documentElement), tok=(n)=>css.getPropertyValue(n).trim();
        const hex=(h)=>{ const n=parseInt(h.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; };
        const lum=([r,g,b])=>{ const f=(c)=>{ c/=255; return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4; }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
        const ratio=(a,b)=>{ const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
        const probe=document.createElement('div'); document.body.appendChild(probe);
        const rgba=(v)=>{ probe.style.backgroundColor=v; const m=getComputedStyle(probe).backgroundColor.match(/[\\d.]+/g).map(Number); return m.length===3?[...m,1]:m; };
        const panel=hex(tok('--color-panel')), sel=hex(tok('--color-selection'));
        const text={fg:hex(tok('--color-fg')),muted:hex(tok('--color-fg-muted')),dim:hex(tok('--color-fg-dim'))};
        const out={ baseline:{} }; for (const k in text) out.baseline[k]=ratio(text[k],sel);
        for (const lv of ['row','row-on']) { const m={fg:99,muted:99,dim:99};
          for (const h of HUES) { const [r,g,b,a]=rgba('hsl(' + h + ' 70% var(--proj-l) / var(--proj-a-' + lv + '))');
            const bg=[r,g,b].map((c,i)=>a*c+(1-a)*panel[i]);
            for (const k in text) m[k]=Math.min(m[k], ratio(text[k],bg)); }
          out[lv]=m; }
        probe.remove(); return out; })()`);
      const tol = TINT_TOL[id] ?? TINT_TOL.default;
      const okFg = c.row.fg >= 4.5 && c["row-on"].fg >= 4.5;
      const okRel = ["muted", "dim"].every(
        (k) => c.row[k] >= c.baseline[k] - tol && c["row-on"][k] >= c.baseline[k] - tol,
      );
      r.check(
        `[${id}] 사이드바 행 틴트 대비 — fg ≥ 4.5 · muted/dim ≥ 선택행 기준선 − ${tol} (12 hue 최악값)`,
        okFg && okRel,
        `row=${fmt(c.row)} on=${fmt(c["row-on"])} base=${fmt(c.baseline)}`,
      );

      if (hasXterm) {
        const want = rgbOf(base);
        // refreshTerminalThemes는 동적 import 경유(마이크로태스크)라 잠깐 뒤 반영 — 폴링.
        const got = await poll(xtermBg, (v) => v === want, 16, 250);
        r.check(`[${id}] 열린 xterm 배경 재적용`, got === want, `bg=${got} ≠ ${want}`);
      }
    }

    // 블록 누락 감지 — 한 블록이라도 빠지면 그 테마의 base가 기본(darcula) 값과 겹친다.
    const uniq = new Set(Object.values(bases).map((s) => s.toLowerCase()));
    r.check(
      "6개 테마 --color-base 전부 상이 (styles.css 블록 ↔ THEMES 짝)",
      uniq.size === THEME_IDS.length,
      Object.entries(bases)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    );

    // ── 태스크 29 ① 내장 6종 × 18토큰: styles.css ↔ theme-apply.ts BUILTIN_TOKENS 짝 검증 ──
    // 사본이 어긋나면 "새 테마 만들기"의 초기값이 낡은 색으로 시작한다. 위 루프를 건드리지
    // 않으려고 별도 루프로 다시 돈다(전환 비용 < 두 hunk가 얽히는 비용).
    const hasCustom = await cdp.eval(
      `!!(window.__gpv && window.__gpv.customThemes && window.__gpv.builtinTokens)`,
    );
    if (!hasCustom) {
      r.skip("커스텀 테마 (태스크 29)", "__gpv.customThemes/builtinTokens 미노출 — 스킵");
    } else {
      for (const id of THEME_IDS) {
        await cdp.invoke("set_settings", { settings: { ...orig, theme: id } });
        await invalidateSettings();
        await poll(domTheme, (v) => v === id, 20, 250);
        const bad = await cdp.eval(`(()=>{
          const want = window.__gpv.builtinTokens[${J(id)}];
          const css = getComputedStyle(document.documentElement);
          const out = [];
          for (const k in want) {
            const got = css.getPropertyValue('--color-' + k).trim().toLowerCase();
            if (got !== want[k]) out.push(k + ' css=' + got + ' 사본=' + want[k]);
          }
          return out; })()`);
        r.check(
          `[${id}] 18토큰 == BUILTIN_TOKENS (theme-apply.ts 사본 ↔ styles.css)`,
          Array.isArray(bad) && bad.length === 0,
          Array.isArray(bad) ? bad.join(" · ") : String(bad),
        );
      }

      // ── 태스크 29 ② 커스텀 테마: 정의 주입 → 선택 → 토큰·xterm·<style> → 삭제 ──
      const CID = "custom-e2e";
      await cdp.eval(`window.__gpv.customThemes.getState().upsert({
        id: ${J(CID)}, name: "E2E 커스텀", base: "dracula",
        colors: { ...window.__gpv.builtinTokens.dracula, base: "#101010" },
        updatedAt: Date.now() })`);
      await cdp.invoke("set_settings", { settings: { ...orig, theme: CID } });
      await invalidateSettings();
      const capplied = await poll(domTheme, (v) => v === CID, 20, 250);
      r.check("[custom] data-theme 반영", capplied === CID, `dataset=${capplied}`);

      const cbase = await poll(cssBase, (v) => v === "#101010", 12, 250);
      r.check("[custom] --color-base = 사용자 값(#101010)", cbase === "#101010", cbase);

      const hasBlock = await cdp.eval(
        `(document.getElementById("gp-custom-themes")?.textContent || "").includes('[data-theme="${CID}"]')`,
      );
      r.check("[custom] <style id=gp-custom-themes> 블록 존재", hasBlock === true, `block=${hasBlock}`);

      if (hasXterm) {
        const got = await poll(xtermBg, (v) => v === "rgb(16, 16, 16)", 16, 250);
        r.check("[custom] 열린 xterm 배경 재적용", got === "rgb(16, 16, 16)", `bg=${got}`);
      }

      // Monaco 정의는 소비처(DiffViewer 등)가 렌더될 때 ensureMonacoTheme으로 만들어진다 —
      // 이 스위트는 에디터를 띄우지 않으므로 "레지스트리가 보이면" 확인, 아니면 스킵.
      // 레지스트리는 monaco 모듈에 없다(`monaco.editor._themeService`는 undefined — 실측
      // 2026-09-03). **마운트된 에디터**의 `_themeService._knownThemes`로만 닿는다.
      const mon = await cdp.eval(`(()=>{
        const m = window.__monaco; if (!m) return "no-monaco";
        const ed = (m.editor.getEditors ? m.editor.getEditors() : [])[0];
        if (!ed) return "no-editor";
        const known = ed._themeService && ed._themeService._knownThemes;
        if (!known || !known.has) return "unreachable";
        return { builtin: known.has("gitpervisor-dracula"), custom: known.has("gitpervisor-custom-${CID}") };
      })()`);
      if (typeof mon === "string" || !mon) {
        r.skip("Monaco 커스텀 테마 정의", `${mon} — 에디터 미마운트/레지스트리 조회 불가(수동 확인 대상)`);
      } else if (!mon.custom) {
        r.check("Monaco 내장 6종 등록(MONACO_THEMES 루프)", mon.builtin === true, `builtin=${mon.builtin}`);
        r.skip("Monaco 커스텀 테마 정의", "에디터 미마운트 — ensureMonacoTheme 미호출");
      } else {
        r.check("Monaco 커스텀 테마 정의", mon.builtin === true && mon.custom === true, JSON.stringify(mon));
      }

      // 삭제 → 블록 소멸. dataset.theme는 그대로지만 매칭 블록이 없어 기본(darcula) 값으로 돌아간다.
      await cdp.eval(`window.__gpv.customThemes.getState().remove(${J(CID)})`);
      const gone = await cdp.eval(
        `(document.getElementById("gp-custom-themes")?.textContent || "").includes('[data-theme="${CID}"]')`,
      );
      r.check("[custom] 삭제 후 블록 소멸", gone === false, `block=${gone}`);
      const fellBack = await poll(cssBase, (v) => v === "#1e1f22", 12, 250);
      r.check(
        "[custom] 정의 없는 id는 기본 테마 색으로 폴백",
        fellBack === "#1e1f22",
        `--color-base=${fellBack}`,
      );
    }

    // ── 원복: 원래 테마로 되돌아가는지 확인(스냅샷 teardown 원복과도 호환) ──
    await cdp.invoke("set_settings", { settings: orig });
    await invalidateSettings();
    const restored = await poll(domTheme, (v) => v === origTheme, 20, 250);
    r.check("원래 테마 복원", restored === origTheme, `theme=${restored}`);
  } finally {
    // 방어적 원복 — 위 원복이 예외로 못 갔어도 설정·터미널·선택을 되돌린다.
    await cdp.try("set_settings", { settings: orig });
    await invalidateSettings();
    if (tabId)
      await cdp
        .eval(`window.__gpv.terminals.getState().closeTab(${J(tabId)})`)
        .catch(() => {});
    if (origSel)
      await cdp
        .eval(`window.__gpv.ui.getState().selectProject(${J(origSel)})`)
        .catch(() => {});
  }
}
