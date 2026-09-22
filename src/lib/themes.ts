import type { ITheme } from "@xterm/xterm";

import { currentMessages } from "../i18n/ui-language";

// 테마 레지스트리 — UI 토큰의 원천은 styles.css의 `:root[data-theme]` 블록(CSS 변수)이고,
// 이 파일은 CSS로 표현 못 하는 성격의 데이터만 담는다: 메타(라벨/종류/스와치) +
// Monaco defineTheme 이름 + CSS 파생만으론 부족한 xterm 보정(라이트 ANSI 16색).
// 테마 1개 = styles.css 블록 + THEMES 엔트리 "2곳" — 짝 누락은 e2e(19-themes)가
// 각 id의 --color-base 변화로 감지한다.

export type ThemeName =
  | "darcula"
  | "monokai"
  | "light"
  | "dracula"
  | "nord"
  | "solarized-light";

/** 앱 테마 id — 내장 6종 또는 사용자 정의(태스크 29). Settings.theme의 타입. */
export type ThemeId = ThemeName | `custom-${string}`;

export interface ThemeMeta {
  id: ThemeId;
  /** SettingsDialog 버튼 표기 — "다크 (Darcula)" 등 */
  label: string;
  kind: "dark" | "light";
  /** monaco-setup.ts defineTheme 이름 "gitpervisor-<계열>" */
  monacoTheme: string;
  /** 스와치 미리보기 [base, accent, add, danger] — CSS 파싱 없이 정적 보관 */
  swatch: [string, string, string, string];
  /** 라이트 테마 등 CSS 파생만으론 부족한 xterm 보정(ANSI 16색 등). 다크는 생략 */
  xterm?: Partial<ITheme>;
}

// 라이트 ANSI 16색 — xterm 기본 팔레트는 다크 배경 전제(밝은 노랑·흰색이 라이트에서 소실).
// VS Code Light+ 터미널 팔레트를 그대로 차용한다(라이트 배경 대비 검증된 세트).
const LIGHT_ANSI: Partial<ITheme> = {
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

// Solarized 공식 ANSI 매핑 — bright 계열이 회색조(base03~base1)인 것이 스펙이다
// (ethanschoonover.com/solarized 의 터미널 표 그대로).
const SOLARIZED_LIGHT_ANSI: Partial<ITheme> = {
  black: "#073642", // base02
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5", // base2
  brightBlack: "#002b36", // base03
  brightRed: "#cb4b16", // orange
  brightGreen: "#586e75", // base01
  brightYellow: "#657b83", // base00
  brightBlue: "#839496", // base0
  brightMagenta: "#6c71c4", // violet
  brightCyan: "#93a1a1", // base1
  brightWhite: "#fdf6e3", // base3
};

// 번역되는 라벨은 getter 다 — 호출처가 `t.label` 로 읽으므로 읽는 순간의 UI 언어로 만든다(모듈 상수에
// 문자열을 담아 두면 언어를 바꿔도 첫 언어로 남는다).
export const THEMES: readonly ThemeMeta[] = [
  {
    id: "darcula",
    get label() {
      return currentMessages().lib.themeLabel.darcula;
    },
    kind: "dark",
    monacoTheme: "gitpervisor-dark",
    swatch: ["#1e1f22", "#3574f0", "#62b543", "#db5c5c"],
  },
  {
    id: "monokai",
    label: "Monokai",
    kind: "dark",
    monacoTheme: "gitpervisor-monokai",
    swatch: ["#070a11", "#4fb4e6", "#6cd07f", "#f0556a"],
  },
  {
    id: "dracula",
    label: "Dracula",
    kind: "dark",
    monacoTheme: "gitpervisor-dracula",
    swatch: ["#282a36", "#bd93f9", "#50fa7b", "#ff5555"],
  },
  {
    id: "nord",
    label: "Nord",
    kind: "dark",
    monacoTheme: "gitpervisor-nord",
    swatch: ["#2e3440", "#88c0d0", "#a3be8c", "#bf616a"],
  },
  {
    id: "light",
    get label() {
      return currentMessages().lib.themeLabel.light;
    },
    kind: "light",
    monacoTheme: "gitpervisor-light",
    swatch: ["#f7f8fa", "#3574f0", "#067d17", "#c7222d"],
    xterm: LIGHT_ANSI,
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    kind: "light",
    monacoTheme: "gitpervisor-solarized-light",
    swatch: ["#fdf6e3", "#268bd2", "#859900", "#dc322f"],
    xterm: SOLARIZED_LIGHT_ANSI,
  },
];

// ── 사용자 정의 테마 (태스크 29) ───────────────────────────────────────────
// 정의(색)는 localStorage `gp:custom-themes`에 있고 스토어는 stores/customThemes.ts,
// CSS 블록 생성은 lib/theme-apply.ts다. 이 파일은 **읽기만** 한다 — 스토어를 import하면
// customThemes → themes → customThemes 순환이 되므로 localStorage를 직접 읽는다.

/** styles.css `@theme` 블록(:5-28)의 색 토큰 18종과 1:1. 순서 = 편집기 그룹 순서. */
export const THEME_TOKENS = [
  "base",
  "panel",
  "raised",
  "selection",
  "edge",
  "accent",
  "accent-hover",
  "on-accent",
  "fg",
  "fg-muted",
  "fg-dim",
  "ok",
  "warn",
  "danger",
  "mod",
  "add",
  "del",
  "untrk",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface CustomTheme {
  /** `custom-<8자>` — CSS 셀렉터에 그대로 들어간다(CUSTOM_ID_RE가 문자셋을 제한). */
  id: `custom-${string}`;
  /** 표시 이름(중복 허용, 빈 문자열 금지) */
  name: string;
  /** kind·Monaco 문법색·xterm ANSI 보정·비토큰 CSS의 상속원 */
  base: ThemeName;
  /** "#rrggbb" 6자리 소문자 — e2e 19의 hex 정규식과 xterm 파생이 이 형식을 전제 */
  colors: Record<ThemeToken, string>;
  updatedAt: number;
}

export const CUSTOM_THEMES_KEY = "gp:custom-themes";

// id는 `:root[data-theme="…"]` 셀렉터로, 색은 선언 값으로 문자열 결합된다 —
// localStorage는 신뢰 경계 밖(다른 창·수동 편집)이라 두 형식을 여기서 강제한다.
const CUSTOM_ID_RE = /^custom-[a-z0-9]{1,32}$/;
const HEX6_RE = /^#[0-9a-f]{6}$/;

export function isCustomThemeId(id: string | undefined): id is `custom-${string}` {
  return typeof id === "string" && CUSTOM_ID_RE.test(id);
}

function isValidCustom(v: unknown): v is CustomTheme {
  const t = v as CustomTheme | null;
  if (!t || typeof t !== "object") return false;
  if (!isCustomThemeId(t.id) || typeof t.name !== "string" || !t.name) return false;
  if (typeof t.updatedAt !== "number") return false;
  if (!THEMES.some((b) => b.id === t.base)) return false;
  if (!t.colors || typeof t.colors !== "object") return false;
  return THEME_TOKENS.every((k) => HEX6_RE.test(t.colors[k] ?? ""));
}

/** 저장된 커스텀 테마 목록 — 형식이 어긋난 항목은 조용히 버린다(부분 손상에도 나머지는 산다). */
export function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return Array.isArray(p) ? p.filter(isValidCustom) : [];
  } catch {
    return [];
  }
}

/** 커스텀 id의 정의 — 내장 id·정의 없는 id는 undefined. */
export function customThemeOf(id: string | undefined): CustomTheme | undefined {
  return isCustomThemeId(id) ? loadCustomThemes().find((t) => t.id === id) : undefined;
}

/** id로 테마 메타 조회 — 미지의 id(다운그레이드·정의 없는 커스텀)는 darcula로 폴백.
 *  커스텀은 **기반 메타에 id·label·swatch만 갈아끼워** 돌려준다 — kind·monacoTheme·
 *  xterm 보정을 기반에서 상속하므로 소비처(terminal-engine 등)는 무변경이다. */
export function themeOf(id: string | undefined): ThemeMeta {
  const custom = customThemeOf(id);
  if (custom) {
    const base = THEMES.find((t) => t.id === custom.base) ?? THEMES[0];
    return {
      ...base,
      id: custom.id,
      label: custom.name,
      swatch: [
        custom.colors.base,
        custom.colors.accent,
        custom.colors.add,
        custom.colors.danger,
      ],
    };
  }
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
