import { monaco } from "../diff/monaco-setup";

import { Editor } from "@monaco-editor/react";
import { useRef } from "react";
import type { editor } from "monaco-editor";

import { monacoThemeOf } from "../../lib/themes";
import { useSettings } from "../../queries";

/**
 * @monaco-editor/react 얇은 래퍼(§8.5). DbWorkspace QueryEditor(:72-93)의 옵션을 재사용한다.
 * - readOnly 모드(응답 Pretty 뷰), 편집 모드(json 바디) 공용.
 * - theme는 settings.theme → monacoThemeOf(테마 레지스트리)로 자동 추종.
 * - onMountEditor로 외부에서 editor 인스턴스를 잡아 format-document(Ctrl+Shift+F)에 쓴다.
 */
export function MonacoBox({
  value,
  language = "json",
  readOnly = false,
  onChange,
  onMountEditor,
}: {
  value: string;
  language?: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
  onMountEditor?: (ed: editor.IStandaloneCodeEditor) => void;
}) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const { data: settings } = useSettings();
  const theme = monacoThemeOf(settings?.theme);

  return (
    <Editor
      language={language}
      value={value}
      onChange={readOnly ? undefined : (v) => onChange?.(v ?? "")}
      theme={theme}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        lineNumbersMinChars: 3,
        fontFamily: '"Cascadia Code", Consolas, monospace',
        padding: { top: 8 },
        wordWrap: "on",
      }}
      onMount={(ed) => {
        editorRef.current = ed;
        onMountEditor?.(ed);
        ed.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
          () => void ed.getAction("editor.action.formatDocument")?.run(),
        );
      }}
      loading={<span className="text-xs text-fg-dim">에디터 로딩 중…</span>}
    />
  );
}
