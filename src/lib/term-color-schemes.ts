import type { ITheme } from "@xterm/xterm";

// 터미널 세션별 컬러 스킴 — 모아보기 셀 우측 상단 팔레트 버튼이 고른다.
//
// 앱 테마(themes.ts)와 별개인 이유: 이 기능의 실사용은 "여러 세션을 그리드에 놓고 색으로
// 구분"하는 것이라, 앱 테마 6종에 묶이면 선택지가 좁고, 무엇보다 앱 테마의 터미널 색은
// `:root[data-theme]` CSS 변수에서 파생돼 **전역 data-theme를 바꾸지 않고는 다른 테마의
// 값을 계산할 수 없다**(셀렉터가 html에만 매칭). 그래서 여기엔 잘 알려진 터미널 팔레트를
// 완전한 ITheme(배경·전경·커서·선택·ANSI 16색)로 정적 보관한다.
export type TermSchemeId =
  | "dracula"
  | "monokai"
  | "one-dark"
  | "solarized-dark"
  | "solarized-light"
  | "gruvbox-dark"
  | "nord"
  | "tokyo-night";

export interface TermScheme {
  id: TermSchemeId;
  label: string;
  /** 메뉴 스와치 [배경, 색1, 색2, 색3] — 목록에서 팔레트를 한눈에 비교 */
  swatch: [string, string, string, string];
  theme: ITheme;
}

// 각 팔레트는 원전 스펙 그대로다(Dracula/Nord/Solarized/Gruvbox 공식 표, One Dark·Tokyo Night는
// 원 에디터 터미널 값). 커서는 전경색·cursorAccent는 배경색 — readTheme()와 같은 규칙.
export const TERM_SCHEMES: readonly TermScheme[] = [
  {
    id: "dracula",
    label: "Dracula",
    swatch: ["#282a36", "#bd93f9", "#50fa7b", "#ff79c6"],
    theme: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    swatch: ["#272822", "#66d9ef", "#a6e22e", "#f92672"],
    theme: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#272822",
      selectionBackground: "#49483e",
      black: "#272822",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#e6db74",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#a1efe4",
      white: "#f8f8f2",
      brightBlack: "#75715e",
      brightRed: "#f92672",
      brightGreen: "#a6e22e",
      brightYellow: "#e6db74",
      brightBlue: "#66d9ef",
      brightMagenta: "#ae81ff",
      brightCyan: "#a1efe4",
      brightWhite: "#f9f8f5",
    },
  },
  {
    id: "one-dark",
    label: "One Dark",
    swatch: ["#282c34", "#61afef", "#98c379", "#e06c75"],
    theme: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#abb2bf",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    swatch: ["#002b36", "#268bd2", "#859900", "#dc322f"],
    theme: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#839496",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    swatch: ["#fdf6e3", "#268bd2", "#859900", "#dc322f"],
    theme: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#657b83",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    swatch: ["#282828", "#fabd2f", "#b8bb26", "#fb4934"],
    theme: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#3c3836",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "nord",
    label: "Nord",
    swatch: ["#2e3440", "#88c0d0", "#a3be8c", "#bf616a"],
    theme: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    swatch: ["#1a1b26", "#7aa2f7", "#9ece6a", "#f7768e"],
    theme: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#283457",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
];

/** id로 스킴 조회 — 미지의 id(스토리지 손상·다운그레이드)는 null(=앱 테마 따름). */
export function termSchemeOf(id: string | undefined | null): TermScheme | null {
  return TERM_SCHEMES.find((s) => s.id === id) ?? null;
}
