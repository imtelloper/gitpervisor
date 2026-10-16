// 리소스 모니터 PC 관리 — 프로그램 탭(설치된 프로그램·ActiveX, DOCS/pc-care-design.md §4.7·§4.8).

import { defineText } from "./define-text";

const ko = {
  filterAll: "전체",
  filterFinance: "금융보안",
  filterSecurity: "백신·보안",
  filterOther: "기타",
  financeNote:
    "금융보안 프로그램은 은행·공공 사이트가 필요할 때 다시 설치하라고 안내하므로, 지금 쓰지 않는 것은 지워도 됩니다.",
  searchPlaceholder: "이름·게시자 검색",
  refresh: "새로 고침",
  colPublisher: "게시자",
  colVersion: "버전",
  colInstalled: "설치일",
  colSize: "크기",
  count: (shown: number, total: number) => `${shown} / ${total}개`,
  userScope: "현재 사용자에게만 설치됨",
  noMatches: "조건에 맞는 프로그램이 없습니다",
  uninstall: "제거",
  copyCommand: "명령 복사",
  commandCopied: "제거 명령을 복사했습니다 — 터미널에서 실행하세요",
  uninstallTitle: "프로그램 제거",
  uninstallMessage: (name: string) =>
    `'${name}'의 제거 프로그램을 실행할까요? 제거 프로그램이 직접 확인 창이나 관리자 권한 요청을 띄울 수 있습니다.`,
  trashMessage: (name: string) => `'${name}'을(를) 휴지통으로 옮길까요?`,
  uninstallStarted: (name: string) =>
    `'${name}' 제거 프로그램을 실행했습니다. 끝나면 새로 고침하세요.`,
  trashed: (name: string) => `'${name}'을(를) 휴지통으로 옮겼습니다`,
  activexTitle: "ActiveX 컨트롤",
  activexUnused: (days: number) => `${days}일 이상 미사용`,
  activexNote:
    "마지막 사용은 포함 파일의 마지막 접근 시각으로 추정합니다. 제거하면 등록을 해제하고 목록에서 지우며, 파일은 남깁니다.",
  activexEmpty: "설치된 ActiveX 컨트롤이 없습니다",
  activexNoMatches: "조건에 맞는 ActiveX 컨트롤이 없습니다",
  colLastUsed: "마지막 사용",
  colFiles: "파일",
  activexRemoveTitle: "ActiveX 제거",
  activexRemoveMessage: (name: string) =>
    `'${name}'의 등록을 해제하고 목록에서 지울까요? 컨트롤 파일 하나만 등록 해제하고, 함께 설치된 공용 런타임(System32 등)은 건드리지 않습니다. 관리자 권한 요청이 두 번 뜰 수 있습니다.`,
  activexRemoved: (name: string) => `'${name}'을(를) 제거했습니다`,
};

export const pccareProgramsText = defineText(ko, {
  en: {
    filterAll: "All",
    filterFinance: "Banking security",
    filterSecurity: "Antivirus",
    filterOther: "Other",
    financeNote:
      "Banking security plug-ins are offered for reinstall by banking and government sites when needed, so removing ones you don't use now is safe.",
    searchPlaceholder: "Search name or publisher",
    refresh: "Refresh",
    colPublisher: "Publisher",
    colVersion: "Version",
    colInstalled: "Installed",
    colSize: "Size",
    count: (shown, total) => `${shown} / ${total}`,
    userScope: "Installed for the current user only",
    noMatches: "No programs match",
    uninstall: "Uninstall",
    copyCommand: "Copy command",
    commandCopied: "Uninstall command copied — run it in a terminal",
    uninstallTitle: "Uninstall program",
    uninstallMessage: (name) =>
      `Run the uninstaller for '${name}'? The uninstaller may show its own confirmation or administrator prompt.`,
    trashMessage: (name) => `Move '${name}' to the Trash?`,
    uninstallStarted: (name) => `Started the uninstaller for '${name}'. Refresh when it finishes.`,
    trashed: (name) => `Moved '${name}' to the Trash`,
    activexTitle: "ActiveX controls",
    activexUnused: (days) => `Unused ${days}+ days`,
    activexNote:
      "Last use is estimated from the contained files' last access time. Removing unregisters the control and drops it from the list; the files stay.",
    activexEmpty: "No ActiveX controls installed",
    activexNoMatches: "No ActiveX controls match",
    colLastUsed: "Last used",
    colFiles: "Files",
    activexRemoveTitle: "Remove ActiveX",
    activexRemoveMessage: (name) =>
      `Unregister '${name}' and remove it from the list? Only the control's own file is unregistered; shared runtimes installed with it (System32 etc.) are left alone. Two administrator prompts may appear.`,
    activexRemoved: (name) => `Removed '${name}'`,
  },
});
