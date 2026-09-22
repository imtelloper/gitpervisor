// 메모장·프로젝트 메모.

import { defineText } from "./define-text";

const ko = {
  memoPanel: {
    untitledMemo: "새 메모",
    emptyListLine1: "메모가 없습니다.",
    emptyListLine2: "아래 버튼으로 추가하세요.",
    newMemo: "새 메모",
    editorFallbackTitle: "메모",
    markdownModeTitle:
      "Markdown 모드 — 본문을 렌더해서 보여줍니다. 렌더된 본문을 클릭하면 편집, 포커스가 빠지면 다시 렌더",
    deleteMemoTitle: "이 메모 삭제",
    closeTitle: "닫기 (Esc)",
    noneSelected: "왼쪽에서 메모를 선택하거나 새로 만드세요",
    editorPlaceholder: "메모 작성…",
  },
  globalMemo: {
    scopeLabel: "전역 메모",
  },
};

export const notesText = defineText(ko, {
  en: {
    memoPanel: {
      untitledMemo: "New note",
      emptyListLine1: "No notes.",
      emptyListLine2: "Add one with the button below.",
      newMemo: "New note",
      editorFallbackTitle: "Note",
      markdownModeTitle:
        "Markdown mode — shows the note rendered. Click the rendered text to edit; it renders again when focus leaves",
      deleteMemoTitle: "Delete this note",
      closeTitle: "Close (Esc)",
      noneSelected: "Select a note on the left or create a new one",
      editorPlaceholder: "Write a note…",
    },
    globalMemo: {
      scopeLabel: "Global notes",
    },
  },
});
