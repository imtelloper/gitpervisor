// 사용자 정의 테마의 화면 적용 (태스크 29) — 정의는 localStorage(themes.ts loadCustomThemes),
// 적용은 여기서 만드는 `<style id="gp-custom-themes">`의 `:root[data-theme="custom-…"]` 블록이다.
// 인라인 변수 주입이 아니라 CSS 블록인 이유: 기존 관례(`dataset.theme = settings.theme`)가
// 그대로 유효해 보조 창 4개·xterm readTheme()·e2e 19의 단언을 한 줄도 고칠 필요가 없다.
//
// BUILTIN_TOKENS는 **src/styles.css의 정적 사본**이다(각 항목 주석에 원본 줄 범위). 새 테마를
// 만들 때 기반 테마의 초기값이 필요한데, 다른 테마의 CSS 변수는 data-theme를 실제로 바꾸지
// 않고는 계산할 수 없어서(셀렉터가 html에만 매칭) 사본이 불가피하다. **사본은 어긋날 수
// 있다** — e2e 19가 내장 6종 × 18토큰을 getComputedStyle 값과 짝 검증한다.
import { refreshTerminalThemes } from "./terminal";
import {
  CUSTOM_THEMES_KEY,
  loadCustomThemes,
  THEME_TOKENS,
  type CustomTheme,
  type ThemeName,
  type ThemeToken,
} from "./themes";

export const BUILTIN_TOKENS: Record<ThemeName, Record<ThemeToken, string>> = {
  // styles.css `@theme` :5-28 (data-theme 없음 = 기본값)
  darcula: {
    base: "#1e1f22",
    panel: "#2b2d30",
    raised: "#393b40",
    selection: "#2e436e",
    edge: "#393b40",
    accent: "#3574f0",
    "accent-hover": "#4682f4",
    "on-accent": "#ffffff",
    fg: "#dfe1e5",
    "fg-muted": "#9da0a8",
    "fg-dim": "#6f737a",
    ok: "#57965c",
    warn: "#d6ae58",
    danger: "#db5c5c",
    mod: "#56a8f5",
    add: "#62b543",
    del: "#868a91",
    untrk: "#db5c5c",
  },
  // styles.css :41-64
  monokai: {
    base: "#070a11",
    panel: "#0c121b",
    raised: "#161f2c",
    selection: "#1c3f68",
    edge: "#1b2738",
    accent: "#4fb4e6",
    "accent-hover": "#69c2ef",
    "on-accent": "#06141f",
    fg: "#e6edf6",
    "fg-muted": "#98a9bd",
    "fg-dim": "#74849b",
    ok: "#57c65c",
    warn: "#e2c15a",
    danger: "#f0556a",
    mod: "#45a8de",
    add: "#6cd07f",
    del: "#76869c",
    untrk: "#e8a447",
  },
  // styles.css :67-89
  dracula: {
    base: "#282a36",
    panel: "#21222c",
    raised: "#343746",
    selection: "#44475a",
    edge: "#343746",
    accent: "#bd93f9",
    "accent-hover": "#caa8fa",
    "on-accent": "#282a36",
    fg: "#f8f8f2",
    "fg-muted": "#b8bfdd",
    "fg-dim": "#8894c4",
    ok: "#50fa7b",
    warn: "#f1fa8c",
    danger: "#ff5555",
    mod: "#8be9fd",
    add: "#50fa7b",
    del: "#8894c4",
    untrk: "#ffb86c",
  },
  // styles.css :92-114
  nord: {
    base: "#2e3440",
    panel: "#3b4252",
    raised: "#434c5e",
    selection: "#4c566a",
    edge: "#3b4252",
    accent: "#88c0d0",
    "accent-hover": "#9bcfdd",
    "on-accent": "#2e3440",
    fg: "#eceff4",
    "fg-muted": "#d8dee9",
    "fg-dim": "#90a0bc",
    ok: "#a3be8c",
    warn: "#ebcb8b",
    danger: "#bf616a",
    mod: "#81a1c1",
    add: "#a3be8c",
    del: "#90a0bc",
    untrk: "#d08770",
  },
  // styles.css :118-140
  light: {
    base: "#f7f8fa",
    panel: "#ffffff",
    raised: "#e6e8ee",
    selection: "#d4e2ff",
    edge: "#d3d5db",
    accent: "#3574f0",
    "accent-hover": "#2b63d9",
    "on-accent": "#ffffff",
    fg: "#222429",
    "fg-muted": "#55585f",
    "fg-dim": "#6d7076",
    ok: "#368c3c",
    warn: "#9e6a00",
    danger: "#c7222d",
    mod: "#116cd6",
    add: "#067d17",
    del: "#6e7178",
    untrk: "#c7222d",
  },
  // styles.css :145-167
  "solarized-light": {
    base: "#fdf6e3",
    panel: "#eee8d5",
    raised: "#e4dcc4",
    selection: "#d3e1ec",
    edge: "#ddd6c1",
    accent: "#268bd2",
    "accent-hover": "#1f78b7",
    "on-accent": "#ffffff",
    fg: "#073642",
    "fg-muted": "#586e75",
    "fg-dim": "#657b83",
    ok: "#859900",
    warn: "#b58900",
    danger: "#dc322f",
    mod: "#268bd2",
    add: "#667600",
    del: "#657b83",
    untrk: "#cb4b16",
  },
};

// 프로젝트 틴트(--proj-*) — styles.css :189-196(light·solarized-light 공통)과 :199-202
// (solarized-light 추가 오버라이드)의 사본. 다크 기반은 :root 기본값(:179-188)이 이미 맞아
// 커스텀 블록에 넣지 않는다. 커스텀 id는 styles.css의 라이트 셀렉터에 매칭되지 않으므로
// 라이트 기반일 때만 여기서 다시 얹어 준다.
const LIGHT_TINT: Record<string, string> = {
  "--proj-l": "50%",
  "--proj-a-on": "0.42",
  "--proj-a-off": "0.2",
  "--proj-a-row": "0.1",
  "--proj-a-row-on": "0.15",
};
const TINT: Partial<Record<ThemeName, Record<string, string>>> = {
  light: LIGHT_TINT,
  "solarized-light": { ...LIGHT_TINT, "--proj-a-row": "0.06", "--proj-a-row-on": "0.1" },
};

const STYLE_ID = "gp-custom-themes";

/** 커스텀 테마 1개의 `:root[data-theme="…"]` 블록. id·색 형식은 loadCustomThemes가 이미 검증. */
export function customThemeCss(t: CustomTheme): string {
  const decls = THEME_TOKENS.map((k) => `  --color-${k}: ${t.colors[k]};`);
  const tint = TINT[t.base];
  if (tint) for (const [k, v] of Object.entries(tint)) decls.push(`  ${k}: ${v};`);
  return `:root[data-theme="${t.id}"] {\n${decls.join("\n")}\n}`;
}

/** `<style id="gp-custom-themes">`를 저장된 정의로 재생성(멱등). main.tsx가 선적용 직전에
 *  1회 부르고, 정의가 바뀔 때(스토어 upsert/remove·다른 창의 storage 이벤트) 다시 부른다. */
export function installCustomThemeStyles(): void {
  try {
    const css = loadCustomThemes().map(customThemeCss).join("\n");
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  } catch {
    /* localStorage·DOM 불가 — 색은 기반(내장) 테마로 폴백된다 */
  }
}

// 다른 창의 정의 변경을 따라간다(storage는 다른 창에서만 발화). 이 리스너는 모든 창이
// 공유하는 경로(main.tsx가 이 모듈을 import)에 있어 보조 창도 함께 갱신된다.
// 스토어(stores/customThemes.ts)의 리스너는 목록 상태만 맞춘다 — 역할이 다르다.
window.addEventListener("storage", (e) => {
  if (e.key !== CUSTOM_THEMES_KEY) return;
  installCustomThemeStyles();
  refreshTerminalThemes();
});

/** "#RGB"/"#RRGGBB"/"rrggbb" → "#rrggbb", 형식이 아니면 null (편집기 hex 입력용). */
export function normalizeHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h}`;
}

/** WCAG 상대 휘도 대비비(1~21) — e2e 19의 계산과 같은 식. 형식 오류는 1(대비 없음). */
export function contrastRatio(hexA: string, hexB: string): number {
  const lum = (hex: string): number | null => {
    const h = normalizeHex(hex);
    if (!h) return null;
    const n = parseInt(h.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const a = lum(hexA);
  const b = lum(hexB);
  if (a == null || b == null) return 1;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
