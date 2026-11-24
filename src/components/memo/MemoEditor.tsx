import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { useEffect, useImperativeHandle, useRef } from "react";

import { imageFilesOf } from "../../lib/memo-image-pipeline";
import { insertMemoImages, memoLivePreview } from "../../lib/memo-live-preview";

export interface MemoEditorHandle {
  getDoc: () => string;
  /** 본문을 통째로 바꾼다(다른 창이 고친 내용을 따라갈 때). onChange 는 부르지 않고 실행 취소 기록에도 남기지 않는다. */
  replaceDoc: (text: string) => void;
  /** 이미지를 메모 이미지로 넣고 커서 자리에 토큰을 쓴다. */
  insertImages: (images: Blob[]) => void;
}

interface MemoEditorProps {
  /**
   * **마운트할 때 한 번만 읽는다.** 편집기는 문서를 스스로 갖는다 — 부모가 값을 계속 내려 주면(제어 컴포넌트)
   * 렌더가 한 박자 늦은 값이 방금 친 글자를 덮는다. 메모가 바뀌면 부모가 `key` 로 다시 마운트하고(실행 취소
   * 기록도 메모마다 갈린다), 같은 메모의 본문을 밖에서 바꿀 때만 `replaceDoc` 을 부른다.
   */
  initialText: string;
  onChange: (text: string) => void;
  onBlur?: () => void;
  placeholder: string;
  /** 마운트하면서 포커스를 잡고 커서를 끝에 둔다. */
  autoFocus?: boolean;
  ref?: React.Ref<MemoEditorHandle>;
}

// replaceDoc 이 보낸 트랜잭션 표시 — 이걸 onChange 로 돌려보내면 부모가 "내가 고쳤다"로 본다.
const externalReplace = Annotation.define<boolean>();

// 지금까지의 textarea 와 같은 모양(14px, 줄 높이 28px, 안쪽 여백 12px·16px). 색은 테마 CSS 변수를 그대로 쓴다.
const memoEditorTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", color: "var(--color-fg)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "28px", overflow: "auto" },
  ".cm-content": { padding: "12px 0", caretColor: "var(--color-fg)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-placeholder": { color: "var(--color-fg-dim)" },
});

// dev 전용(E2E) — e2e 창에는 OS 포커스가 없어 키 입력을 흘려보낼 수 없고, 화면의 글자(textContent)는 위젯이
// 가린 토큰을 잃는다. 문서를 직접 읽고, 사용자가 친 것과 같은 길(트랜잭션 → onChange)로 글자를 넣는다.
// 편집기는 **DOM 에서 찾는다**. 모듈 변수에 담아 두면 HMR 이 이 모듈의 사본을 하나 더 만들었을 때 훅과
// 컴포넌트가 서로 다른 사본의 변수를 보게 되어, 편집기가 떠 있는데도 훅은 "없음"이라 답한다(실제로 겪었다).
if (import.meta.env.DEV) {
  const liveMemoEditor = () => {
    const el = document.querySelector<HTMLElement>(".cm-editor");
    return el ? EditorView.findFromDOM(el) : null;
  };
  (window as unknown as { __gpvMemoEditor?: unknown }).__gpvMemoEditor = {
    doc: () => liveMemoEditor()?.state.doc.toString() ?? null,
    type: (text: string) => {
      const view = liveMemoEditor();
      if (!view) return false;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        userEvent: "input.type",
      });
      return true;
    },
    select: (anchor: number, head = anchor) => liveMemoEditor()?.dispatch({ selection: { anchor, head } }),
  };
}

/**
 * 메모 본문 편집기 — CodeMirror 6. 문서는 **평문 그대로**이고(저장되는 글자와 한 바이트도 다르지 않다),
 * 이미지 토큰과 줄 머리 체크박스만 위젯으로 보인다(lib/memo-live-preview.ts).
 */
export default function MemoEditor({
  initialText,
  onChange,
  onBlur,
  placeholder,
  autoFocus,
  ref,
}: MemoEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 편집기는 한 번만 만든다 — 콜백은 ref 로 최신 것을 따라간다.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          // standardKeymap 은 textarea 와 같은 키만 담는다. defaultKeymap 은 쓰지 않는다 — 코드 편집기용 키
          // (Ctrl+Shift+K 줄 삭제, Alt+↑↓ 줄 이동 …)가 들어 있고 CodeMirror 는 처리한 키의 전파를 막지 않아,
          // Ctrl+Shift+K 한 번에 메모 줄 삭제와 앱의 git push 단축키가 같이 돈다.
          keymap.of([...standardKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholderExtension(placeholder),
          EditorView.contentAttributes.of({ spellcheck: "false" }),
          memoEditorTheme,
          memoLivePreview(),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((tr) => tr.annotation(externalReplace))) return;
            onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event, v) {
              const images = imageFilesOf(event.clipboardData);
              // 글자가 같이 실려 있으면 글자로 붙인다 — Excel 셀·Word 글은 텍스트와 비트맵을 함께 올려서,
              // 파일만 보고 판단하면 복사한 글이 그림으로 붙는다.
              if (images.length === 0 || event.clipboardData?.getData("text/plain")) return false;
              event.preventDefault(); // 비동기 작업 전에 동기로 — 늦으면 기본 붙여넣기가 이미 돈다
              const { from, to } = v.state.selection.main;
              insertMemoImages(v, images, from, to);
              return true;
            },
            drop(event, v) {
              const images = imageFilesOf(event.dataTransfer);
              // 이미지가 아닌 파일은 CodeMirror 기본 동작에 맡긴다.
              if (images.length === 0) return false;
              event.preventDefault();
              const at =
                v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.doc.length;
              insertMemoImages(v, images, at);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (autoFocus) {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
    }
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 1회. 메모 전환은 부모의 key 가 다시 마운트한다.
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getDoc: () => viewRef.current?.state.doc.toString() ?? "",
      replaceDoc: (text) => {
        const view = viewRef.current;
        if (!view || view.state.doc.toString() === text) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          annotations: [externalReplace.of(true), Transaction.addToHistory.of(false)],
        });
      },
      insertImages: (images) => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        insertMemoImages(view, images, from, to);
        view.focus();
      },
    }),
    [],
  );

  return (
    <div
      ref={hostRef}
      onBlur={(e) => {
        // **지금 살아 있는 편집기**에서 온 것만 받는다. 포커스를 가진 편집기가 DOM 에서 빠지면 브라우저가
        // focusout 을 쏘는데, StrictMode 는 개발 모드에서 편집기를 한 번 만들었다 버린다 — 그걸 "떠남"으로
        // 받으면 MD 모드에서 렌더 본문을 눌러 편집에 들어가자마자 렌더 뷰로 되돌아간다.
        const view = viewRef.current;
        if (!view || !(e.target instanceof Node) || !view.dom.contains(e.target)) return;
        // 안의 체크박스 위젯으로 옮겨 가는 것도 "떠남"이 아니다.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        onBlur?.();
      }}
      className="min-h-0 flex-1 overflow-hidden"
    />
  );
}
