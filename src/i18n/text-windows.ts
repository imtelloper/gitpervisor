// 보조 창 진입점 — 문서 창·플로팅 터미널·모아보기 창·캡쳐 오버레이·App.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const ko = {
  aggregateWindow: {
    title: "터미널 모아보기",
    badge: "모아보기",
  },
  app: {
    closeConfirmTitle: "터미널이 실행 중입니다",
    closeConfirmMessage: (n: number) =>
      `실행 중인 터미널 세션이 ${n}개 있습니다. 지금 닫으면 그 안에서 돌고 있는 명령(빌드·개발 서버·에이전트)이 모두 종료됩니다.`,
    closeConfirmLabel: "닫기",
    pastePathNoTerminal: "경로를 넣을 터미널이 없습니다",
    emptyTitle: "프로젝트를 추가하세요",
    emptyDesc: "좌측 하단 ‘프로젝트 추가’ 버튼으로 git 레포 폴더를 등록하면 상태가 표시됩니다",
  },
  captureOverlay: {
    hint: "드래그해서 영역 선택 · Enter 확정 · Esc/우클릭 취소",
  },
  docWindow: {
    reportTitle: "작업 리포트",
    reportBadge: "리포트",
    fileFallbackName: "파일",
    fileBadge: "파일",
    targetMissingTitle: "열 파일을 찾지 못했습니다",
    targetMissingDesc: "창 정보가 만료되었습니다. 파일트리에서 다시 열어 주세요.",
    loadFailedTitle: "파일을 불러오지 못했습니다",
    tooLargeTitle: "파일이 너무 큽니다",
    tooLargeDesc: "1.5MB를 초과하는 파일은 표시하지 않습니다",
    markdownShowRendered: "미리보기 (렌더된 마크다운)",
    markdownShowSource: "원본 보기 (마크다운 소스)",
    loading: "불러오는 중…",
  },
  floatingTerminal: {
    defaultTitle: "터미널",
    redockTitle: "이 창의 터미널을 메인 창으로 되돌립니다 — 모아보기가 열려 있으면 거기 나타납니다",
    redockLabel: "메인으로 되돌리기",
  },
};

export const windowsText = defineText(ko, {
  en: {
    aggregateWindow: {
      title: "Terminal aggregate view",
      badge: "Aggregate",
    },
    app: {
      closeConfirmTitle: "Terminals are running",
      closeConfirmMessage: (n) =>
        `${n} terminal ${plural(n, "session is", "sessions are")} running. Closing now stops every command running in them (builds, dev servers, agents).`,
      closeConfirmLabel: "Close",
      pastePathNoTerminal: "No terminal to paste the path into",
      emptyTitle: "Add a project",
      emptyDesc: "Add a git repository folder with the + button in the sidebar to see its status",
    },
    captureOverlay: {
      hint: "Drag to select an area · Enter to confirm · Esc/right-click to cancel",
    },
    docWindow: {
      reportTitle: "Work report",
      reportBadge: "Report",
      fileFallbackName: "File",
      fileBadge: "File",
      targetMissingTitle: "Couldn't find the file to open",
      targetMissingDesc: "The window info has expired. Open the file again from the file tree.",
      loadFailedTitle: "Couldn't load the file",
      tooLargeTitle: "File is too large",
      tooLargeDesc: "Files larger than 1.5MB are not shown",
      markdownShowRendered: "Preview (rendered Markdown)",
      markdownShowSource: "View source (Markdown)",
      loading: "Loading…",
    },
    floatingTerminal: {
      defaultTitle: "Terminal",
      redockTitle: "Move this window's terminals back to the main window — they appear in the Aggregate view if it's open",
      redockLabel: "Dock back",
    },
  },
});
