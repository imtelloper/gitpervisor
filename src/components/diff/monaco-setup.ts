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

monaco.editor.defineTheme("gitpervisor-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1E1F22",
    "editor.lineHighlightBackground": "#26282E",
    "editorLineNumber.foreground": "#6F737A",
    "editorLineNumber.activeForeground": "#DFE1E5",
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

export { monaco };
