// 앱 뼈대 — 타이틀바·상태바·모아보기·git 게이트·경로 없음·오류 경계.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const ko = {
  // 메인 타이틀바와 플로팅 창 타이틀바가 같은 창 컨트롤을 쓴다.
  windowControls: {
    minimize: "최소화",
    close: "닫기",
    restore: "이전 크기로",
    maximize: "최대화",
  },
  floatTitleBar: {
    terminalBadge: "터미널",
  },
  errorBoundary: {
    title: "문제가 발생했습니다",
    logHint: "자세한 내용은 앱 로그 폴더(logs/)에 기록됐습니다.",
    retry: "다시 시도",
    reload: "새로고침",
  },
  gitGate: {
    checking: "git 확인 중…",
    notFoundTitle: "git을 찾을 수 없습니다",
    requirement: "Gitpervisor는 시스템에 설치된 git CLI를 사용합니다 (2.35 이상 권장).",
    // 다운로드 주소(<span>)를 사이에 둔 문장 — 어순이 언어마다 달라 앞뒤를 따로 둔다.
    installBeforeUrl: "",
    installAfterUrl: "에서 설치한 뒤 다시 시도하세요.",
    recheck: "다시 확인",
  },
  projectPathMissing: {
    pickDialogTitle: (name: string) => `'${name}'의 새 위치 선택`,
    title: "프로젝트 경로를 찾을 수 없습니다",
    desc: (path: string) =>
      `${path} — 폴더를 옮겼다면 새 위치를 지정하고, 삭제했다면 프로젝트를 제거하세요.`,
    fixPath: "프로젝트 경로 수정",
    remove: "프로젝트 제거",
  },
  statusBar: {
    lastUpdated: (relative: string) => `마지막 갱신 ${relative}`,
    encodingUncertainTitle: "인코딩을 확정하지 못했습니다 — 직접 고르세요",
    encodingTitle: "파일 인코딩 — 클릭해 다른 인코딩으로 다시 엽니다",
    encodingAutoDetect: "자동 탐지",
    usageWindowFiveHour: "5시간",
    usageWindowWeekly: "주간",
    usageTitle: "Claude 사용량 (세션 5시간 · 주간) — /usage 와 동일 소스",
    usageUsed: (tail: string) => (tail ? `사용 ${tail}` : "사용"),
    agentWorkingTitle: "AI 작업 중 — 클릭해 이동",
    agentDoneTitle: "AI 작업 완료 — 클릭해 확인",
  },
  titleBar: {
    favoritesSaveFailed: (error: string) => `즐겨찾기를 저장하지 못했습니다 — ${error}`,
    renameFavoriteTitle: "즐겨찾기 이름 바꾸기",
    renameFavoriteConfirm: "저장",
    renameFavoriteEmpty: "이름을 입력하세요",
    addFavoriteDialogTitle: "즐겨찾기에 추가할 폴더",
    favoritesButtonTitle:
      "즐겨찾기 폴더 — 항목에 호버하면 최근 파일 미리보기(클릭: 경로 복사), 항목 클릭은 새 창",
    favoritesButton: "폴더",
    favoritesEmpty: "등록된 폴더가 없습니다",
    favoriteItemTitle: (path: string) =>
      `${path}\n호버: 최근 파일 미리보기 · 클릭: 창으로 열기 · 우클릭: 이름 바꾸기`,
    favoriteRemoveTitle: "즐겨찾기에서 제거",
    favoritePresetTitle: (path: string) => `${path}\n클릭하면 즐겨찾기에 추가합니다`,
    favoriteAddFolder: "폴더 추가…",
    aggregateInWindowTitle: "모아보기가 별도 창에 있습니다 — 클릭하면 그 창으로 이동",
    aggregateButtonTitle: (hotkey: string) =>
      `터미널 모아보기 — 여러 터미널을 한 화면에 분할로 (${hotkey})\n우클릭: 별도 창으로 띄우기`,
    aggregateButton: "모아보기",
    reportButtonTitle:
      "작업 리포트 — 잔디(활동 히트맵)와 일간·주간·월간 요약\n우클릭: 새 창으로 열기",
    reportButton: "리포트",
    reportOpenInWindow: "새 창으로 열기",
    memoButtonTitle: "메모장 — 프로젝트와 무관한 전역 메모",
    memoButton: "메모장",
    quarantineTitle: (count: number) =>
      `brew cask CLI ${count}개가 macOS 격리로 차단됨 — 클릭하여 해제`,
    quarantineBadge: (count: number) => `${count}개 차단`,
  },
  aggregate: {
    layoutGridTitle: "그리드 — 2×2·3×3 균등 배치",
    layoutColumnsTitle: "세로 컬럼 — 셀을 좌우로 한 줄에 나열(최대 4열, 넘치면 줄바꿈)",
    fallbackProjectName: "프로젝트",
    fallbackBrowserTitle: "브라우저",
    headerTitle: "터미널 모아보기",
    selectedCount: (shown: number, total: number) => `${shown}/${total} 선택`,
    reportTabBackToTerminals: "터미널로 돌아가기",
    reportTabShow: "리포트 보기",
    reportTab: "리포트",
    reportTabClose: "리포트 탭 닫기",
    groupChipTitle: (name: string, count: number) =>
      `${name} — 탭 ${count}개 (클릭: 전체 표시/숨김, 호버: 목록)`,
    autoLayoutTitle:
      "셀 자동배치 — 클릭: 지금 모드로 균등 정렬 · 호버: 모드 선택(그리드 / 세로 컬럼)",
    autoLayout: "자동배치",
    groupTabsOffTitle: "탭 모으기 끄기 — 탭을 개별 칩으로 펼칩니다",
    groupTabsOnTitle: "탭 모으기 켜기 — 같은 프로젝트의 탭을 칩 하나로 묶습니다",
    groupTabs: "탭 모으기",
    closeWindowTitle: "창 닫기 — 터미널은 메인 창으로 돌아갑니다",
    closeAggregateTitle: (hotkey: string) => `모아보기 닫기 (${hotkey})`,
    close: "닫기",
    emptyPickTitle: "표시할 터미널·브라우저를 선택하세요",
    emptyNoneTitle: "열린 터미널·브라우저가 없습니다",
    emptyPickDesc: "위 칩에서 보고 싶은 것을 고르면 여기에 분할로 표시됩니다",
    emptyNoneDesc: "위의 새 터미널 · 새 브라우저 버튼으로 바로 열 수 있습니다",
    closeTerminal: "터미널 닫기",
    closeTerminalConfirm: (project: string, title: string) =>
      `'${project} · ${title}' 터미널을 닫을까요? 실행 중인 프로세스가 종료됩니다.`,
    closeAllTabsTitle: "탭 모두 닫기",
    closeAllTabsConfirm: (name: string, count: number, terminals: number) =>
      `'${name}' 탭 ${count}개를 닫을까요?` +
      (terminals ? ` 터미널 ${terminals}개의 실행 중인 프로세스가 종료됩니다.` : ""),
    closeAllTabsConfirmLabel: "모두 닫기",
    newTerminalIn: (name: string) => `'${name}'에 새 터미널 열기`,
    closeAllTabsMenu: (name: string, count: number) => `'${name}' 탭 ${count}개 모두 닫기`,
    hideFromGrid: "그리드에서 숨기기",
    showInGrid: "그리드에 표시",
    unzoom: "확대 해제",
    zoom: "확대해서 보기",
    closePromptList: "프롬프트 목록 닫기",
    openPromptList: "프롬프트 목록 열기",
    translateSelection: "선택 영역 번역",
    floatToWindow: "새 창으로 분리 (Float)",
    closeBrowser: "브라우저 닫기",
    chipTitle: (project: string, title: string) => `${project} · ${title} (우클릭: 메뉴)`,
    newCellTerminal: "새 터미널",
    newCellBrowser: "새 브라우저",
    newCellClaude: "Claude Code 세션 터미널",
    // e2e 가 이 title 로 "+" 버튼을 찾는다 — 글자를 바꾸면 스위트를 같이 고친다.
    newCellNoProjectsTitle: "프로젝트를 추가하면 새 터미널·브라우저를 열 수 있습니다",
    newCellTitleWithBrowser: "새 터미널 · 새 브라우저 — 이 화면에 바로 연다",
    newCellTitleTerminalsOnly: "새 터미널 · Claude Code 세션 터미널 — 이 화면에 바로 연다",
    newCellPickProject: (kind: string) => `${kind} — 프로젝트 선택`,
    hideTerminalTitle:
      "숨기기 — 이 화면에서만 빼고 터미널은 계속 실행됩니다 (상단 칩으로 되돌리기)",
    hideBrowserTitle:
      "숨기기 — 이 화면에서만 빼고 브라우저는 계속 실행됩니다 (상단 칩으로 되돌리기)",
    unzoomCellTitle: "원래 크기로 — 그리드로 돌아갑니다",
    zoomCellTitle: "확대 — 이 터미널만 화면 가득 봅니다",
    closeTerminalCellTitle: "터미널 닫기 (프로세스 종료)",
  },
};

export const appText = defineText(ko, {
  en: {
    windowControls: {
      minimize: "Minimize",
      close: "Close",
      restore: "Restore down",
      maximize: "Maximize",
    },
    floatTitleBar: {
      terminalBadge: "Terminal",
    },
    errorBoundary: {
      title: "Something went wrong",
      logHint: "Details were written to the app log folder (logs/).",
      retry: "Try again",
      reload: "Reload",
    },
    gitGate: {
      checking: "Checking git…",
      notFoundTitle: "git not found",
      requirement: "Gitpervisor uses the git CLI installed on your system (2.35 or later recommended).",
      installBeforeUrl: "Install it from ",
      installAfterUrl: " and try again.",
      recheck: "Check again",
    },
    projectPathMissing: {
      pickDialogTitle: (name) => `Choose new location for '${name}'`,
      title: "Project path not found",
      desc: (path) =>
        `${path} — If you moved the folder, choose its new location. If you deleted it, remove the project.`,
      fixPath: "Fix project path",
      remove: "Remove project",
    },
    statusBar: {
      lastUpdated: (relative) => `Updated ${relative}`,
      encodingUncertainTitle: "Could not determine the encoding — choose one",
      encodingTitle: "File encoding — click to reopen with a different encoding",
      encodingAutoDetect: "Auto-detect",
      usageWindowFiveHour: "5h",
      usageWindowWeekly: "weekly",
      usageTitle: "Claude usage (5-hour session · weekly) — same source as /usage",
      usageUsed: (tail) => (tail ? `used ${tail}` : "used"),
      agentWorkingTitle: "AI working — click to go there",
      agentDoneTitle: "AI done — click to review",
    },
    titleBar: {
      favoritesSaveFailed: (error) => `Could not save favorites — ${error}`,
      renameFavoriteTitle: "Rename favorite",
      renameFavoriteConfirm: "Save",
      renameFavoriteEmpty: "Enter a name",
      addFavoriteDialogTitle: "Folder to add to favorites",
      favoritesButtonTitle:
        "Favorite folders — hover an item to preview recent files (click: copy path), click an item to open a new window",
      favoritesButton: "Folders",
      favoritesEmpty: "No folders added",
      favoriteItemTitle: (path) =>
        `${path}\nHover: preview recent files · Click: open in window · Right-click: rename`,
      favoriteRemoveTitle: "Remove from favorites",
      favoritePresetTitle: (path) => `${path}\nClick to add to favorites`,
      favoriteAddFolder: "Add folder…",
      aggregateInWindowTitle: "The aggregate view is in a separate window — click to go there",
      aggregateButtonTitle: (hotkey) =>
        `Aggregate view — split many terminals on one screen (${hotkey})\nRight-click: open in separate window`,
      aggregateButton: "Aggregate",
      reportButtonTitle:
        "Work report — activity heatmap and daily · weekly · monthly summaries\nRight-click: open in new window",
      reportButton: "Report",
      reportOpenInWindow: "Open in new window",
      memoButtonTitle: "Notes — global notes not tied to any project",
      memoButton: "Notes",
      quarantineTitle: (count) =>
        `${count} brew cask ${plural(count, "CLI is", "CLIs are")} blocked by macOS quarantine — click to unblock`,
      quarantineBadge: (count) => `${count} blocked`,
    },
    aggregate: {
      layoutGridTitle: "Grid — even 2×2 · 3×3 layout",
      layoutColumnsTitle: "Columns — cells side by side in one row (up to 4, then wrap)",
      fallbackProjectName: "Project",
      fallbackBrowserTitle: "Browser",
      headerTitle: "Aggregate view",
      selectedCount: (shown, total) => `${shown}/${total} selected`,
      reportTabBackToTerminals: "Back to terminals",
      reportTabShow: "Show report",
      reportTab: "Report",
      reportTabClose: "Close report tab",
      groupChipTitle: (name, count) =>
        `${name} — ${count} ${plural(count, "tab", "tabs")} (click: show/hide all, hover: list)`,
      autoLayoutTitle:
        "Auto layout — click: even out in current mode · hover: choose mode (grid / columns)",
      autoLayout: "Auto layout",
      groupTabsOffTitle: "Turn off Group by project — show each tab as its own chip",
      groupTabsOnTitle: "Turn on Group by project — merge a project's tabs into one chip",
      groupTabs: "Group by project",
      closeWindowTitle: "Close window — terminals return to the main window",
      closeAggregateTitle: (hotkey) => `Close aggregate view (${hotkey})`,
      close: "Close",
      emptyPickTitle: "Select terminals or browsers to show",
      emptyNoneTitle: "No open terminals or browsers",
      emptyPickDesc: "Pick chips above to show them here side by side",
      emptyNoneDesc: "Open one right away with the New terminal · New browser button above",
      closeTerminal: "Close terminal",
      closeTerminalConfirm: (project, title) =>
        `Close terminal '${project} · ${title}'? Running processes will be terminated.`,
      closeAllTabsTitle: "Close all tabs",
      closeAllTabsConfirm: (name, count, terminals) =>
        `Close ${count} ${plural(count, "tab", "tabs")} in '${name}'?` +
        (terminals
          ? ` Running processes in ${terminals} ${plural(terminals, "terminal", "terminals")} will be terminated.`
          : ""),
      closeAllTabsConfirmLabel: "Close all",
      newTerminalIn: (name) => `Open new terminal in '${name}'`,
      closeAllTabsMenu: (name, count) => `Close all ${count} ${plural(count, "tab", "tabs")} in '${name}'`,
      hideFromGrid: "Hide from grid",
      showInGrid: "Show in grid",
      unzoom: "Exit zoom",
      zoom: "Zoom in",
      closePromptList: "Close prompt history",
      openPromptList: "Open prompt history",
      translateSelection: "Translate selection",
      floatToWindow: "Pop out to new window (Float)",
      closeBrowser: "Close browser",
      chipTitle: (project, title) => `${project} · ${title} (right-click: menu)`,
      newCellTerminal: "New terminal",
      newCellBrowser: "New browser",
      newCellClaude: "Claude Code session terminal",
      newCellNoProjectsTitle: "Add a project to open new terminals and browsers",
      newCellTitleWithBrowser: "New terminal · New browser — opens right here",
      newCellTitleTerminalsOnly: "New terminal · Claude Code session terminal — opens right here",
      newCellPickProject: (kind) => `${kind} — choose project`,
      hideTerminalTitle: "Hide — removes it from this view only; the terminal keeps running (restore from the chips above)",
      hideBrowserTitle: "Hide — removes it from this view only; the browser keeps running (restore from the chips above)",
      unzoomCellTitle: "Original size — back to the grid",
      zoomCellTitle: "Zoom — fill the screen with this terminal",
      closeTerminalCellTitle: "Close terminal (terminates process)",
    },
  },
});
