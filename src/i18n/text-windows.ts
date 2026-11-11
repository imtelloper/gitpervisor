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
    savedToast: (fileName: string) => `저장 후 클립보드에 복사했습니다 — ${fileName}`,
    openFolder: "폴더 열기",
    recordHint: "드래그해서 녹화할 영역 선택 · 놓으면 바로 녹화 · Esc/우클릭 취소",
    recStop: "정지",
    recStopping: "저장 중…",
    recCpu: "CPU",
    recCpuTitle: "GPU 인코더를 쓸 수 없어 CPU로 녹화합니다(30fps) — 끊길 수 있습니다",
    recStarting: "곧 녹화를 시작합니다",
    recCancel: "취소",
    recPause: "일시정지",
    recResume: "다시 녹화",
    recAudioTitle: "오디오를 함께 녹음합니다",
    recSavedToast: (fileName: string) => `녹화를 저장했습니다 — ${fileName}`,
    recLimitToast: (reason: "maxDuration" | "maxSize" | "diskLow", fileName: string) =>
      `${
        reason === "maxDuration"
          ? "설정한 최대 길이에 도달해"
          : reason === "maxSize"
            ? "최대 크기(4GB)에 도달해"
            : "디스크 여유 공간이 1GB 아래로 내려가"
      } 녹화를 멈추고 저장했습니다 — ${fileName}`,
    openInEditor: "편집기에서 열기",
    recBrokenToast: (fileName: string, detail: string) =>
      `녹화가 정상적으로 끝나지 않았습니다 — ${fileName} 이 재생되지 않을 수 있습니다${detail ? ` (${detail})` : ""}`,
  },
  docWindow: {
    reportTitle: "작업 리포트",
    reportBadge: "리포트",
    browserBadge: "브라우저",
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
      savedToast: (fileName) => `Saved and copied to the clipboard — ${fileName}`,
      openFolder: "Open folder",
      recordHint: "Drag to select the area to record · recording starts on release · Esc/right-click to cancel",
      recStop: "Stop",
      recStopping: "Saving…",
      recCpu: "CPU",
      recCpuTitle: "No GPU encoder available — recording on the CPU at 30 fps, playback may stutter",
      recStarting: "Recording starts soon",
      recCancel: "Cancel",
      recPause: "Pause",
      recResume: "Resume",
      recAudioTitle: "Recording audio too",
      recSavedToast: (fileName) => `Recording saved — ${fileName}`,
      recLimitToast: (reason, fileName) =>
        `${
          reason === "maxDuration"
            ? "Reached the maximum length set in Settings"
            : reason === "maxSize"
              ? "Reached the 4 GB limit"
              : "Less than 1 GB of disk space left"
        } — recording stopped and saved: ${fileName}`,
      openInEditor: "Open in editor",
      recBrokenToast: (fileName, detail) =>
        `The recording didn't finish cleanly — ${fileName} may not play${detail ? ` (${detail})` : ""}`,
    },
    docWindow: {
      reportTitle: "Work report",
      reportBadge: "Report",
      browserBadge: "Browser",
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
