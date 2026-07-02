// 테마 시스템 e2e — 6개 테마 id 각각에 대해 set_settings → DOM 반영을 단언한다.
// styles.css `[data-theme]` 블록 ↔ themes.ts THEMES 엔트리의 짝 누락은 --color-base가
// 잡는다: 블록이 빠지면 기본(darcula) 값이 그대로라 "6개 전부 상이" 검사에서 겹쳐 실패.
// 열린 xterm에는 refreshTerminalThemes 재적용을 .xterm-scrollable-element 배경색으로
// 확인하고(xterm 6은 onChangeColors 때 theme.background를 이 노드 인라인 스타일로 반영 —
// .xterm-viewport가 아님), 끝나면 원래 테마로 복원한다.
//
// set_settings 원시 invoke는 React Query 캐시를 모르므로, dev 노출 __gpv.queryClient로
// settings 쿼리를 invalidate해 App의 테마 effect(dataset.theme 의존 체인)를 구동한다.

export const name = "테마 시스템 (6종 전환 / CSS 토큰 / xterm 재적용 / 복원)";

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
