import { ensureMonacoTheme, monaco } from "../diff/monaco-setup";

import { Editor } from "@monaco-editor/react";
import { useRef } from "react";
import type { editor } from "monaco-editor";

import { useSettings } from "../../queries";

/**
 * @monaco-editor/react 얇은 래퍼(§8.5). DbWorkspace QueryEditor(:72-93)의 옵션을 재사용한다.
 * - readOnly 모드(응답 Pretty 뷰), 편집 모드(json 바디) 공용.
 * - theme는 settings.theme → ensureMonacoTheme(테마 레지스트리)로 자동 추종.
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
  const theme = ensureMonacoTheme(settings?.theme);

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
        // addCommand 가 아니라 addAction — 전자는 해제 수단이 없어 모듈 전역 레지스트리에 쌓이고
        // 핸들러가 이 에디터를 붙잡는다(DiffViewer 와 같은 누수). 후자는 dispose 가능하다.
        const reg = ed.addAction({
          id: "gp.format",
          label: "문서 서식",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
          run: (e) => void e.getAction("editor.action.formatDocument")?.run(),
        });
        ed.onDidDispose(() => {
          reg.dispose();
          if (editorRef.current === ed) editorRef.current = null;
        });
      }}
      loading={<span className="text-xs text-fg-dim">에디터 로딩 중…</span>}
    />
  );
}
