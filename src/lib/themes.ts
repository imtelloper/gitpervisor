import type { ITheme } from "@xterm/xterm";

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

export interface ThemeMeta {
  id: ThemeName;
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

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "darcula",
    label: "다크 (Darcula)",
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
    label: "라이트 (IntelliJ)",
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

/** id로 테마 메타 조회 — 미지의 id(다운그레이드 등)는 darcula로 폴백. */
export function themeOf(id: string | undefined): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** settings.theme → Monaco defineTheme 이름 (DiffViewer/MonacoBox/DbWorkspace 공용). */
export function monacoThemeOf(id: string | undefined): string {
  return themeOf(id).monacoTheme;
}
