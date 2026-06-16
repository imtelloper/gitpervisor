// Monaco를 CDN이 아닌 번들로 로드한다 (오프라인 데스크톱 앱 필수).
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
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
    { token: "comment", foreground: "75715E" },
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
    "editor.background": "#0B1018",
    "editor.foreground": "#E3EAF3",
    "editor.lineHighlightBackground": "#141E2D",
    "editorLineNumber.foreground": "#46566C",
    "editorLineNumber.activeForeground": "#9FB0C4",
    "editor.selectionBackground": "#214A78",
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

export { monaco };
