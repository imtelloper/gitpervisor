// Monaco를 CDN이 아닌 번들로 로드한다 (오프라인 데스크톱 앱 필수).
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
// basic-languages 하위 모듈은 타입 선언이 없다 — 문법 객체만 가져온다.
// @ts-expect-error 타입 선언 없음
import { language as pythonLanguage } from "monaco-editor/esm/vs/basic-languages/python/python.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

// Darcula — JetBrains 색감(키워드 주황·문자열 초록·숫자 파랑·주석 회색 이탤릭·상수 보라).
// Monaco는 어휘 토큰만 분류하므로 함수 선언 노랑·인스턴스 필드 보라 같은 의미 색은 제한적.
monaco.editor.defineTheme("gitpervisor-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "808080", fontStyle: "italic" },
    { token: "string", foreground: "6A8759" },
    { token: "string.escape", foreground: "CC7832" },
    { token: "number", foreground: "6897BB" },
    { token: "keyword", foreground: "CC7832" },
    { token: "constant.language", foreground: "CC7832" },
    { token: "operator", foreground: "A9B7C6" },
    { token: "delimiter", foreground: "A9B7C6" },
    { token: "function", foreground: "FFC66D" },
    { token: "constant", foreground: "9876AA" },
    { token: "type", foreground: "A9B7C6" },
    { token: "type.identifier", foreground: "A9B7C6" },
    { token: "identifier", foreground: "A9B7C6" },
    { token: "variable", foreground: "A9B7C6" },
    { token: "tag", foreground: "E8BF6A" },
    { token: "attribute.name", foreground: "BABABA" },
    { token: "attribute.value", foreground: "6A8759" },
  ],
  colors: {
    "editor.background": "#1E1F22",
    "editor.foreground": "#A9B7C6",
    "editor.lineHighlightBackground": "#26282E",
    "editorLineNumber.foreground": "#606366",
    "editorLineNumber.activeForeground": "#A4A3A3",
    "diffEditor.insertedTextBackground": "#3B511F80",
    "diffEditor.insertedLineBackground": "#2A3B2340",
    "diffEditor.removedTextBackground": "#62333380",
    "diffEditor.removedLineBackground": "#3A282840",
    "diffEditorGutter.insertedLineBackground": "#2A3B2360",
    "diffEditorGutter.removedLineBackground": "#3A282860",
    "scrollbarSlider.background": "#44464B80",
    "scrollbarSlider.hoverBackground": "#54565BAA",
  },
});

// Monokai — 고전 토큰 색(주석 회색·문자열 노랑·키워드 핑크·타입 시안·함수 초록)
monaco.editor.defineTheme("gitpervisor-monokai", {
  base: "vs-dark",
  inherit: true,
  rules: [
    // 주석은 쿨 블루그레이로 — 웜 올리브가 쿨 프레임에서 뜨던 문제 해소(구문색은 Monokai 유지)
    { token: "comment", foreground: "5C6B80" },
    { token: "string", foreground: "E6DB74" },
    { token: "number", foreground: "AE81FF" },
    { token: "keyword", foreground: "F92672" },
    { token: "operator", foreground: "F92672" },
    { token: "type", foreground: "66D9EF", fontStyle: "italic" },
    { token: "type.identifier", foreground: "66D9EF", fontStyle: "italic" },
    { token: "function", foreground: "A6E22E" },
    { token: "constant", foreground: "AE81FF" },
    { token: "variable", foreground: "F8F8F2" },
    { token: "variable.predefined", foreground: "FD971F" },
    { token: "delimiter", foreground: "F8F8F2" },
    { token: "tag", foreground: "F92672" },
    { token: "attribute.name", foreground: "A6E22E" },
    { token: "attribute.value", foreground: "E6DB74" },
  ],
  colors: {
    // 바탕은 UI 토큰과 동일한 다크 블루·블랙(로고 조화), 구문색은 위 Monokai 유지
    "editor.background": "#070A11",
    "editor.foreground": "#E3EAF3",
    "editor.lineHighlightBackground": "#101926",
    "editorLineNumber.foreground": "#3E4E64",
    "editorLineNumber.activeForeground": "#9FB0C4",
    "editor.selectionBackground": "#1C3F68",
    "diffEditor.insertedTextBackground": "#6CD07F22",
    "diffEditor.insertedLineBackground": "#6CD07F12",
    "diffEditor.removedTextBackground": "#F0556A30",
    "diffEditor.removedLineBackground": "#F0556A16",
    "diffEditorGutter.insertedLineBackground": "#6CD07F20",
    "diffEditorGutter.removedLineBackground": "#F0556A20",
    "scrollbarSlider.background": "#27395280",
    "scrollbarSlider.hoverBackground": "#34496AAA",
  },
});

// Dracula — 공식 스펙 색(주석 블루그레이·문자열 노랑·키워드 핑크·타입 시안·함수 초록·상수 퍼플)
monaco.editor.defineTheme("gitpervisor-dracula", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6272A4", fontStyle: "italic" },
    { token: "string", foreground: "F1FA8C" },
    { token: "string.escape", foreground: "FF79C6" },
    { token: "number", foreground: "BD93F9" },
    { token: "keyword", foreground: "FF79C6" },
    { token: "constant.language", foreground: "BD93F9" },
    { token: "operator", foreground: "FF79C6" },
    { token: "delimiter", foreground: "F8F8F2" },
    { token: "type", foreground: "8BE9FD", fontStyle: "italic" },
    { token: "type.identifier", foreground: "8BE9FD", fontStyle: "italic" },
    { token: "function", foreground: "50FA7B" },
    { token: "constant", foreground: "BD93F9" },
    { token: "variable", foreground: "F8F8F2" },
    { token: "variable.predefined", foreground: "FFB86C" },
    { token: "tag", foreground: "FF79C6" },
    { token: "attribute.name", foreground: "50FA7B" },
    { token: "attribute.value", foreground: "F1FA8C" },
  ],
  colors: {
    "editor.background": "#282A36",
    "editor.foreground": "#F8F8F2",
    "editor.lineHighlightBackground": "#31333F",
    "editorLineNumber.foreground": "#6272A4",
    "editorLineNumber.activeForeground": "#F8F8F2",
    "editor.selectionBackground": "#44475A",
    "diffEditor.insertedTextBackground": "#50FA7B22",
    "diffEditor.insertedLineBackground": "#50FA7B12",
    "diffEditor.removedTextBackground": "#FF555530",
    "diffEditor.removedLineBackground": "#FF555516",
    "diffEditorGutter.insertedLineBackground": "#50FA7B20",
    "diffEditorGutter.removedLineBackground": "#FF555520",
    "scrollbarSlider.background": "#44475A80",
    "scrollbarSlider.hoverBackground": "#565A75AA",
  },
});

// Nord — 공식 포팅 컨벤션(키워드 nord9·문자열 nord14·타입 nord7·함수 nord8·숫자 nord15)
monaco.editor.defineTheme("gitpervisor-nord", {
  base: "vs-dark",
  inherit: true,
  rules: [
    // 주석은 공식 nord3(#4C566A)이 아닌 밝힌 파생(#616E88) — nord 저장소의 가독성 개정판
    { token: "comment", foreground: "616E88", fontStyle: "italic" },
    { token: "string", foreground: "A3BE8C" },
    { token: "string.escape", foreground: "EBCB8B" },
    { token: "number", foreground: "B48EAD" },
    { token: "keyword", foreground: "81A1C1" },
    { token: "constant.language", foreground: "81A1C1" },
    { token: "operator", foreground: "81A1C1" },
    { token: "delimiter", foreground: "ECEFF4" },
    { token: "type", foreground: "8FBCBB" },
    { token: "type.identifier", foreground: "8FBCBB" },
    { token: "function", foreground: "88C0D0" },
    { token: "constant", foreground: "B48EAD" },
    { token: "variable", foreground: "D8DEE9" },
    { token: "variable.predefined", foreground: "D08770" },
    { token: "tag", foreground: "81A1C1" },
    { token: "attribute.name", foreground: "8FBCBB" },
    { token: "attribute.value", foreground: "A3BE8C" },
  ],
  colors: {
    "editor.background": "#2E3440",
    "editor.foreground": "#D8DEE9",
    "editor.lineHighlightBackground": "#3B4252",
    "editorLineNumber.foreground": "#4C566A",
    "editorLineNumber.activeForeground": "#D8DEE9",
    "editor.selectionBackground": "#434C5E",
    "diffEditor.insertedTextBackground": "#A3BE8C2A",
    "diffEditor.insertedLineBackground": "#A3BE8C14",
    "diffEditor.removedTextBackground": "#BF616A38",
    "diffEditor.removedLineBackground": "#BF616A18",
    "diffEditorGutter.insertedLineBackground": "#A3BE8C26",
    "diffEditorGutter.removedLineBackground": "#BF616A26",
    "scrollbarSlider.background": "#434C5E80",
    "scrollbarSlider.hoverBackground": "#4C566AAA",
  },
});

// 라이트 — IntelliJ Light 구문색(키워드 남색·문자열 초록·숫자 파랑·상수 보라·주석 회색).
// diff 오버레이는 알파를 흰 바탕용으로 낮춘 라이트 전용 값(다크 알파 재사용 금지 — §위험).
monaco.editor.defineTheme("gitpervisor-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "8C8C8C", fontStyle: "italic" },
    { token: "string", foreground: "067D17" },
    { token: "string.escape", foreground: "0037A6" },
    { token: "number", foreground: "1750EB" },
    { token: "keyword", foreground: "0033B3" },
    { token: "constant.language", foreground: "0033B3" },
    { token: "operator", foreground: "222429" },
    { token: "delimiter", foreground: "222429" },
    { token: "type", foreground: "371F80" },
    { token: "type.identifier", foreground: "371F80" },
    { token: "function", foreground: "00627A" },
    { token: "constant", foreground: "871094" },
    { token: "variable", foreground: "222429" },
    { token: "tag", foreground: "0033B3" },
    { token: "attribute.name", foreground: "174AD4" },
    { token: "attribute.value", foreground: "067D17" },
  ],
  colors: {
    // 에디터는 순백 — UI base(#F7F8FA)와 미세 대비로 콘텐츠 영역이 구분된다(IntelliJ Light 관행)
    "editor.background": "#FFFFFF",
    "editor.foreground": "#080808",
    "editor.lineHighlightBackground": "#F2F3F7",
    "editorLineNumber.foreground": "#ADADAD",
    "editorLineNumber.activeForeground": "#5C5C5C",
    "editor.selectionBackground": "#D4E2FF",
    "diffEditor.insertedTextBackground": "#4CB05E40",
    "diffEditor.insertedLineBackground": "#4CB05E1A",
    "diffEditor.removedTextBackground": "#E4536040",
    "diffEditor.removedLineBackground": "#E453601A",
    "diffEditorGutter.insertedLineBackground": "#4CB05E30",
    "diffEditorGutter.removedLineBackground": "#E4536030",
    "scrollbarSlider.background": "#00000022",
    "scrollbarSlider.hoverBackground": "#00000038",
  },
});

// Solarized Light — 공식 구문 컨벤션(키워드 green·문자열 cyan·함수 blue·숫자 magenta·주석 base1)
monaco.editor.defineTheme("gitpervisor-solarized-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "93A1A1", fontStyle: "italic" },
    { token: "string", foreground: "2AA198" },
    { token: "string.escape", foreground: "CB4B16" },
    { token: "number", foreground: "D33682" },
    { token: "keyword", foreground: "859900" },
    { token: "constant.language", foreground: "B58900" },
    { token: "operator", foreground: "657B83" },
    { token: "delimiter", foreground: "657B83" },
    { token: "type", foreground: "B58900" },
    { token: "type.identifier", foreground: "B58900" },
    { token: "function", foreground: "268BD2" },
    { token: "constant", foreground: "CB4B16" },
    { token: "variable", foreground: "073642" },
    { token: "variable.predefined", foreground: "268BD2" },
    { token: "tag", foreground: "268BD2" },
    { token: "attribute.name", foreground: "B58900" },
    { token: "attribute.value", foreground: "2AA198" },
  ],
  colors: {
    "editor.background": "#FDF6E3", // base3
    "editor.foreground": "#657B83", // base00 — 공식 에디터 본문색
    "editor.lineHighlightBackground": "#EEE8D5", // base2
    "editorLineNumber.foreground": "#93A1A1", // base1
    "editorLineNumber.activeForeground": "#586E75", // base01
    "editor.selectionBackground": "#D5E3EC",
    "diffEditor.insertedTextBackground": "#85990033",
    "diffEditor.insertedLineBackground": "#85990016",
    "diffEditor.removedTextBackground": "#DC322F2E",
    "diffEditor.removedLineBackground": "#DC322F14",
    "diffEditorGutter.insertedLineBackground": "#85990028",
    "diffEditorGutter.removedLineBackground": "#DC322F28",
    "scrollbarSlider.background": "#586E7540",
    "scrollbarSlider.hoverBackground": "#586E7560",
  },
});

// ── Python 삼중 따옴표 f-string 구문 강조 수정 ──────────────────────────────
// Monaco 기본 Python 문법은 삼중 따옴표 f-string(f"""...""")을 한 줄 문자열로 취급해
// 첫 줄 끝에서 닫아버린다. 그러면 실제 닫는 """가 "새 도크스트링 시작"으로 오인되고,
// 도크스트링은 줄 끝에서 안 닫히므로 그 아래 전체가 문자열색(Monokai 노랑)으로 새어나간다.
// → 접두사(f/r/b/u…) 삼중 따옴표를 "닫는 삼중 따옴표까지 불투명 처리"하는 상태를 추가한다.
const patchedPython: monaco.languages.IMonarchLanguage = {
  ...pythonLanguage,
  tokenizer: {
    ...pythonLanguage.tokenizer,
    // 접두사 삼중 따옴표를 단일행 f-string 규칙(@fDblStringBody 등)보다 먼저 가로챈다.
    strings: [
      [/[bBfFrRuU]{1,3}"""/, "string", "@tripleDoubleBody"],
      [/[bBfFrRuU]{1,3}'''/, "string", "@tripleSingleBody"],
      ...pythonLanguage.tokenizer.strings,
    ],
    tripleDoubleBody: [
      [/[^"]+/, "string"],
      [/"""/, "string", "@pop"],
      [/"/, "string"],
    ],
    tripleSingleBody: [
      [/[^']+/, "string"],
      [/'''/, "string", "@pop"],
      [/'/, "string"],
    ],
  },
};

// python 문법은 monaco import 시 등록되므로 즉시 덮어쓴다(지연 로드 대비 onLanguage도 등록).
monaco.languages.setMonarchTokensProvider("python", patchedPython);
monaco.languages.onLanguage("python", () =>
  monaco.languages.setMonarchTokensProvider("python", patchedPython),
);

export { monaco };
