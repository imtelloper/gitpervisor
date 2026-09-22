// UI 언어(다국어) — DOCS/i18n-design.md §5.
//
// 지키는 계약:
//   ① 소스 가드: 한국어 UI 문구가 남은 파일은 `i18n-legacy-files.json` 목록에 있는 것뿐이다 — 새 파일·이행
//      끝난 파일에 한글이 다시 들어오면 빨갛다. 목록은 **줄어들기만** 한다(한글이 사라진 파일이 목록에 남아
//      있어도 빨갛다 — 안 그러면 목록이 영영 안 줄어도 모른다).
//   ② 카탈로그를 조립한 키로 열지 않는다(`msg[…]`) — 호출처가 검색에서 사라지고 오타가 런타임에만 드러난다.
//   ③ `src/i18n/text-*.ts` 도메인은 전부 `messages.ts`에 등록돼 있다 — 빠지면 그 도메인 문구가 조용히 안 뜬다.
//   ④ 런타임: `ui_language_resolved` 가 설정을 따른다(샤드는 "ko" 로 심어 둔다) · "en" 으로 저장하면 열린 창이
//      재시작 없이 영어가 되고 `<html lang>` 이 바뀐다 · 되돌리면 한국어로 돌아온다.
//
// ①~③ 은 앱 없이 소스만 본다. 반증: 이행 끝난 파일(`src/i18n/ui-language.ts`)에 한글 리터럴을 넣으면 ① 이
// 빨개지는 것을 스캐너를 처음 만들 때 확인했다(tests/e2e/lib/i18n-scan.mjs 머리 주석).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scanDynamicCatalogAccess, scanHangulFiles } from "../lib/i18n-scan.mjs";

export const name = "UI 언어(다국어) — 소스 가드 · 런타임 전환";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeoutMs, stepMs = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(stepMs);
  }
}

export async function run({ cdp, report: r }) {
  // ── ① 한국어 UI 문구가 남은 파일 = 기준 목록 ──
  const legacy = JSON.parse(readFileSync(join(REPO, "tests/e2e/i18n-legacy-files.json"), "utf8")).files;
  const found = scanHangulFiles(REPO);
  const added = [...found.entries()]
    .filter(([f]) => !(f in legacy))
    .map(([f, lines]) => `${f}:${lines.slice(0, 3).join(",")}`);
  const cleared = Object.keys(legacy).filter((f) => !found.has(f));
  r.check(
    "① 새로 한국어 UI 문구가 들어온 파일 없음(문구는 src/i18n/text-*.ts 카탈로그로)",
    added.length === 0,
    added.length ? `추가: ${added.slice(0, 8).join(" · ")}${added.length > 8 ? ` 외 ${added.length - 8}` : ""}` : `남은 파일 ${found.size}개`,
  );
  r.check(
    "① 이행 끝난 파일은 기준 목록에서 빠져 있다(목록은 줄어들기만)",
    cleared.length === 0,
    cleared.length ? `i18n-legacy-files.json 에서 지울 것: ${cleared.join(", ")}` : `목록 ${Object.keys(legacy).length}개`,
  );

  // ── ② 조립한 키로 카탈로그 열기 금지 ──
  const dynamic = scanDynamicCatalogAccess(REPO);
  r.check("② 카탈로그를 조립한 키로 열지 않는다(msg[…])", dynamic.length === 0, dynamic.join(" · ") || "0건");

  // ── ③ 도메인 등록 누락 ──
  const domains = readdirSync(join(REPO, "src/i18n")).filter((f) => /^text-[a-z0-9-]+\.ts$/.test(f));
  const messagesSrc = readFileSync(join(REPO, "src/i18n/messages.ts"), "utf8");
  const unregistered = domains.filter((f) => !messagesSrc.includes(`./${f.replace(/\.ts$/, "")}"`));
  r.check(
    "③ src/i18n/text-*.ts 도메인이 전부 messages.ts 에 등록돼 있다",
    domains.length > 0 && unregistered.length === 0,
    unregistered.length ? `미등록: ${unregistered.join(", ")}` : `도메인 ${domains.length}개`,
  );

  // ── ④ 런타임 전환 ──
  const orig = await cdp.invoke("get_settings");
  const setLang = (uiLanguage) => cdp.invoke("set_settings", { settings: { ...orig, uiLanguage } });
  const pickerState = () =>
    cdp.eval(`(()=>{ const s=document.querySelector('[data-gpv="settings-ui-language"]');
      return { html: document.documentElement.lang, option: s ? s.options[0].textContent : null }; })()`);
  try {
    const resolved0 = await cdp.invoke("ui_language_resolved");
    r.check(
      "④ ui_language_resolved 가 설정을 따른다(샤드는 uiLanguage=ko 로 심어 둔다)",
      orig.uiLanguage === "system" ? resolved0 === "ko" || resolved0 === "en" : resolved0 === orig.uiLanguage,
      `설정=${orig.uiLanguage} 판정=${resolved0}`,
    );

    await cdp.eval(`(window.__gpv.ui.getState().openSettings("general"), true)`);
    await setLang("en");
    const en = await until(async () => {
      const st = await pickerState();
      return st.option === "Follow system setting" && st.html === "en" ? st : null;
    }, 5000);
    r.check(
      "④ uiLanguage=en 저장 → 열린 창이 재시작 없이 영어(설정 언어 칸)·<html lang=en>",
      !!en && (await cdp.invoke("ui_language_resolved")) === "en",
      J(en ?? (await pickerState())),
    );

    await setLang("ko");
    const ko = await until(async () => {
      const st = await pickerState();
      return st.option === "시스템 설정 따르기" && st.html === "ko" ? st : null;
    }, 5000);
    r.check("④ uiLanguage=ko 로 되돌리면 한국어로 돌아온다", !!ko, J(ko ?? (await pickerState())));
  } finally {
    await cdp.invoke("set_settings", { settings: orig }).catch(() => {});
    await cdp.eval(`(window.__gpv.ui.getState().setSettingsOpen(false), true)`).catch(() => {});
  }
}
