// 설정 모달 UX (태스크 18) — 사이드바 카테고리 + 검색. 저장 모델 불변·상태 보존·검색·완전성 가드.
import { readFileSync } from "node:fs";

export const name = "설정 모달 UX (카테고리 + 검색)";

const REPO = "C:/Users/GreatHoon/DEVELOPMENT/gitpervisor";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cdp, report: r }) {
  const orig = await cdp.invoke("get_settings");

  // ── 셸 구조 ──
  await cdp.eval(`window.__gpv.ui.getState().setSettingsOpen(true)`);
  await sleep(400);
  const shell = await cdp.eval(`(() => ({
    cats: [...document.querySelectorAll('button')].filter(b => /^(일반|모양|코드 도구|터미널|알림|유지보수)$/.test(b.textContent.trim())).length,
    search: !!document.querySelector('input[placeholder="설정 검색…"]'),
  }))()`);
  r.check("사이드바 6카테고리 + 검색 입력", shell.cats === 6 && shell.search, JSON.stringify(shell));

  // ── ① 카테고리 전환 시 form 편집값 유지 ──
  const setNum = (v) => cdp.eval(`(() => { const i=[...document.querySelectorAll('input[type=number]')].find(x=>x.value); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'${v}'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const clickCat = (label) => cdp.eval(`(() => { [...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='${label}').click(); })()`);
  await clickCat("모양");
  await sleep(150);
  await setNum("19");
  await sleep(150);
  await clickCat("알림");
  await sleep(150);
  await clickCat("모양");
  await sleep(150);
  const kept = await cdp.eval(`(() => { const i=[...document.querySelectorAll('input[type=number]')].find(x=>x.value); return i?i.value:null; })()`);
  r.check("① 카테고리 전환 시 편집값 유지(19)", kept === "19", `→ ${kept}`);
  r.check("dirty 배지 표시", await cdp.eval(`document.body.textContent.includes('저장되지 않은 변경')`));

  // ── ② 검색 자동 전환 + 하이라이트 ──
  const setSearch = (v) => cdp.eval(`(() => { const s=document.querySelector('input[placeholder="설정 검색…"]'); const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(s,'${v}'); s.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await setSearch("폰트");
  await sleep(400);
  const s2 = await cdp.eval(`(() => ({
    dimmed: [...document.querySelectorAll('button')].filter(b=>/^(일반|알림)$/.test(b.textContent.trim()) && b.className.includes('opacity-40')).length,
    hl: [...document.querySelectorAll('[data-setting-key]')].filter(e=>e.className.includes('ring-accent')).length,
  }))()`);
  r.check("② 검색 필터(비매칭 dim) + 하이라이트", s2.dimmed >= 1 && s2.hl >= 1, JSON.stringify(s2));

  // Esc 1단계 = 검색 클리어(모달 유지)
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(250);
  const esc1 = await cdp.eval(`(() => ({ q: document.querySelector('input[placeholder="설정 검색…"]')?.value, open: window.__gpv.ui.getState().settingsOpen }))()`);
  r.check("Esc 1단계=검색 클리어(모달 유지)", esc1.q === "" && esc1.open === true, JSON.stringify(esc1));

  // ── ③ 테마 프리뷰 + Esc 복원 ──
  const before = await cdp.eval(`document.documentElement.dataset.theme`);
  const target = before === "dracula" ? "Nord" : "Dracula";
  await clickCat("모양");
  await sleep(150);
  await cdp.eval(`(() => { const t=[...document.querySelectorAll('button')].find(b=>b.textContent.includes(${JSON.stringify(target)}) && b.querySelector('span[style]')); if(t) t.click(); })()`);
  await sleep(250);
  const previewed = await cdp.eval(`document.documentElement.dataset.theme`);
  r.check("③ 테마 라이브 프리뷰", previewed !== before, `${before}→${previewed}`);
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); // 검색 비었으니 닫힘
  await sleep(350);
  const restored = await cdp.eval(`(() => ({ theme: document.documentElement.dataset.theme, open: window.__gpv.ui.getState().settingsOpen }))()`);
  r.check("Esc 닫기 + 테마 복원", restored.open === false && restored.theme === before, JSON.stringify(restored));

  // ── 재오픈 시 query 리셋(I5) ──
  await cdp.eval(`window.__gpv.ui.getState().setSettingsOpen(true)`);
  await sleep(300);
  await setSearch("smtp");
  await sleep(200);
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); // clear
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); // close
  await sleep(200);
  await cdp.eval(`window.__gpv.ui.getState().setSettingsOpen(true)`);
  await sleep(300);
  const reopenQ = await cdp.eval(`document.querySelector('input[placeholder="설정 검색…"]')?.value`);
  r.check("재오픈 시 검색어 리셋", reopenQ === "");
  await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  // ── ⑤ SETTINGS_INDEX 완전성 가드: getSettings 런타임 키 ↔ 인덱스 non-null key ──
  const runtimeKeys = Object.keys(orig).sort();
  const src = readFileSync(`${REPO}/src/components/settings/settings-index.ts`, "utf8");
  const indexKeys = [...src.matchAll(/key:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  const indexKeySet = new Set(indexKeys);
  const missing = runtimeKeys.filter((k) => !indexKeySet.has(k));
  r.check("⑤ SETTINGS_INDEX가 모든 Settings 키 커버", missing.length === 0, missing.length ? `누락: ${missing.join(",")}` : `${runtimeKeys.length}키 전부 커버`);

  // 정리
  await cdp.invoke("set_settings", { settings: orig });
}
