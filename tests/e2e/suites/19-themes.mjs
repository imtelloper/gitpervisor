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

  // 프로젝트 색 대비 — 팔레트도, 재는 토큰 목록(FG)도, 절대 하한(FLOORS)도, 슬롯 수
  // (PROJECT_HUES)도 전부 **앱이 실제로 쓰는 값**(__gpv.projectColor)에서 읽는다. 여기에
  // 손사본을 두면 구현이 바뀌어도 사본이 조용히 옛 값으로 통과한다(옛 판은 12 hue 하드코딩,
  // 그 다음 판은 8토큰·하한 3개를 손으로 베낀 사본이었다).
  // 슬롯 **수** 자체(32)는 여기서 안 잰다 — 아래 `c.n === c.hues`는 projectPalette가
  // PROJECT_HUES.map이라 항진명제이고, 수 핀은 14-frontend-dom.mjs "슬롯 수 ≥ 32" 한 곳에 있다.
  // 기준선 = 그 테마의 선택 행(bg-selection) 위 대비. 허용 오차는 8비트 반올림분 0.1 —
  // solarized-light 예외(0.35)는 없앴다: 신 팔레트는 최소 여유 +0.090으로 기준선을 넘는다.
  const TINT_TOL = { default: 0.1 };
  const fmt = (m) =>
    Object.entries(m)
      .map(([k, v]) => `${k}=${v.toFixed(2)}`)
      .join(" ");

  // ── 다리 확인 — 없으면 **명시적으로 FAIL** 한다 ──
  // 이 스위트의 값은 전부 구현에서 읽어 오므로, 다리가 없는 빌드에 붙으면 "빈 목록을 다 돌았다"
  // 로 조용히 통과해 버린다(잰 척). 옛 빌드/릴리스 빌드에 붙었을 때 그걸 막는 관문.
  const bridge = await cdp.eval(`(()=>{
    const p = window.__gpv && window.__gpv.projectColor;
    return { fg: p && p.FG, floors: (p && p.FLOORS) || null,
             hues: p && Array.isArray(p.PROJECT_HUES) ? p.PROJECT_HUES.length : 0,
             themes: Object.keys(window.__gpv.builtinTokens || {}) };})()`);
  const fgOk = Array.isArray(bridge?.fg) && bridge.fg.length > 0;
  const floorsOk =
    !!bridge?.floors &&
    typeof bridge.floors === "object" &&
    !Array.isArray(bridge.floors) &&
    Object.keys(bridge.floors).length > 0;
  r.check(
    "__gpv.projectColor 다리 노출 (FG · FLOORS · PROJECT_HUES — 사본 대신 구현에서 읽는다)",
    fgOk && floorsOk && bridge.hues > 0,
    `FG=${fgOk ? bridge.fg.length : bridge?.fg} FLOORS=${floorsOk ? Object.keys(bridge.floors).length : bridge?.floors} hues=${bridge?.hues}`,
  );
  // themes.ts THEMES 목록도 손사본을 두지 않는다 — BUILTIN_TOKENS는 `Record<ThemeName, …>`라
  // THEMES에 테마가 늘면 키가 컴파일 타임에 따라 늘어난다(빠지면 theme-apply.ts가 안 컴파일된다).
  const THEME_IDS = Array.isArray(bridge?.themes) ? bridge.themes : [];
  r.check(
    "__gpv.builtinTokens 다리에서 테마 id 목록 확보",
    THEME_IDS.length > 0,
    `ids=${THEME_IDS.join(",") || "(없음)"}`,
  );
  const canMeasureTint = fgOk && floorsOk && bridge.hues > 0;

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

      // 슬롯 × 토큰 전수(다크는 2톤 포함)를 실제 테마 토큰 위에서 잰다.
      // 글자가 얹히는 행 배경은 기준선 + 절대 하한, 글자가 없는 스트라이프는 비텍스트 3:1.
      if (canMeasureTint) {
        const c = await cdp.eval(`(()=>{
          const css=getComputedStyle(document.documentElement), tok=(n)=>css.getPropertyValue('--color-'+n).trim();
          const hex=(h)=>{const n=parseInt(h.slice(1),16);return [(n>>16)&255,(n>>8)&255,n&255];};
          const lum=([r,g,b])=>{const f=(c)=>{c/=255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;};return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
          const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+0.05)/(y+0.05);};
          const pc=window.__gpv.projectColor, T=pc.FG;
          const panel=hex(tok('panel')), sel=hex(tok('selection'));
          const pal=pc.projectPalette(document.documentElement.dataset.theme||'darcula');
          const out={baseline:{},worst:{},stripe:99,n:pal.length,hues:pc.PROJECT_HUES.length,floors:pc.FLOORS};
          for(const k of T){out.baseline[k]=ratio(hex(tok(k)),sel); out.worst[k]=99;}
          for(const p of pal){const bg=hex(p.bg);
            for(const k of T) out.worst[k]=Math.min(out.worst[k], ratio(hex(tok(k)),bg));
            out.stripe=Math.min(out.stripe, ratio(hex(p.stripe),panel));}
          return out;})()`);
        const tol = TINT_TOL[id] ?? TINT_TOL.default;
        // 하한 0인 토큰(mod/add/untrk/danger/accent)은 자동 통과 — 구현이 "의도적으로 하한 없음"
        // 으로 0을 박아 둔 것이라 여기서 특별 취급하지 않는 게 맞다(기준선 몫은 okRel이 진다).
        // 다만 그 개수는 detail에 찍는다 — FG에 토큰을 추가하는 사람이 컴파일 오류를 보고
        // `newtok: 0`을 복붙하면 하한 목록에는 흔적이 안 남기 때문이다(판정에는 넣지 않는다).
        const floors = Object.entries(c.floors);
        const okAbs = floors.every(([k, min]) => c.worst[k] >= min);
        const okRel = Object.keys(c.baseline).every((k) => c.worst[k] >= c.baseline[k] - tol);
        const nTok = Object.keys(c.baseline).length;
        const floorDesc = floors
          .filter(([, m]) => m > 0)
          .map(([k, m]) => `${k}≥${m}`)
          .join(" ");
        r.check(
          `[${id}] 프로젝트 색 — ${c.n}슬롯 × ${nTok}토큰 ≥ 기준선 − ${tol} · 하한(${floorDesc}) · 스트라이프 ≥ 3:1`,
          c.n === c.hues && okAbs && okRel && c.stripe >= 3.0,
          `worst=${fmt(c.worst)} base=${fmt(c.baseline)} stripe=${c.stripe.toFixed(2)} n=${c.n}/${c.hues} floors0=${floors.length - floors.filter(([, m]) => m > 0).length}`,
        );
      }

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
      `${THEME_IDS.length}개 테마 --color-base 전부 상이 (styles.css 블록 ↔ THEMES 짝)`,
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
        const res = await cdp.eval(`(()=>{
          const want = window.__gpv.builtinTokens[${J(id)}];
          const css = getComputedStyle(document.documentElement);
          const out = [];
          for (const k in want) {
            const got = css.getPropertyValue('--color-' + k).trim().toLowerCase();
            if (got !== want[k]) out.push(k + ' css=' + got + ' 사본=' + want[k]);
          }
          return { bad: out, n: Object.keys(want).length }; })()`);
        const bad = res && res.bad;
        r.check(
          `[${id}] ${res?.n ?? "?"}토큰 == BUILTIN_TOKENS (theme-apply.ts 사본 ↔ styles.css)`,
          Array.isArray(bad) && bad.length === 0 && res.n > 0,
          Array.isArray(bad) ? bad.join(" · ") : String(res),
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
