// 리소스 모니터 PC 관리 — tools: 파일 잠금 찾기 · 정리 가능 공간 · 네트워크 카드 (DOCS/pc-care-design.md §4.9~4.11).

import { defineText } from "./define-text";

const ko = {
  // 파일 잠금 찾기
  lockButton: "파일 잠금 찾기",
  lockButtonTitle: "파일이나 폴더를 붙잡고 있는 프로세스를 찾습니다",
  lockPickFile: "파일 선택",
  lockPickFolder: "폴더 선택",
  lockPickFileDialogTitle: "잠긴 파일 선택",
  lockPickFolderDialogTitle: "잠긴 폴더 선택",
  lockRescan: "다시 찾기",
  lockClose: "닫기",
  lockSearching: "찾는 중…",
  lockPrompt: "파일이나 폴더를 고르면 그것을 붙잡고 있는 프로세스를 찾습니다",
  lockNone: "이 경로를 붙잡고 있는 프로세스를 찾지 못했습니다",
  lockTruncated: "폴더 안 파일이 많아 처음 2,000개만 확인했습니다",
  lockFailed: (err: string) => `찾지 못했습니다: ${err}`,
  lockColName: "이름",
  lockColReason: "이유",
  lockColExe: "실행 파일",
  // 정리 가능 공간
  cleanupTitle: "정리 가능 공간",
  cleanupScan: "검사",
  cleanupScanning: "검사 중…",
  cleanupHint: "검사를 누르면 임시 파일·휴지통·크래시 덤프·개발 캐시가 차지한 공간을 셉니다",
  cleanupEmpty: "정리할 항목을 찾지 못했습니다",
  cleanupFiles: (n: number) => `${n.toLocaleString()}개`,
  cleanupRun: "선택 항목 정리",
  cleanupRunning: "정리 중…",
  cleanupConfirmMessage: (count: number, size: string) =>
    `${count}개 항목에서 약 ${size}를 지웁니다. 휴지통을 거치지 않으므로 되돌릴 수 없습니다.`,
  cleanupConfirmLabel: "정리",
  cleanupDone: (freed: string, deleted: number, skipped: number) =>
    `${freed} 확보 · ${deleted.toLocaleString()}개 삭제${
      skipped ? ` · 사용 중이거나 권한이 없어 ${skipped.toLocaleString()}개 건너뜀` : ""
    }`,
  cleanupFailed: (err: string) => `정리하지 못했습니다: ${err}`,
  cleanupScanFailed: (err: string) => `검사하지 못했습니다: ${err}`,
  // 시스템 정보 네트워크 카드
  networkCard: "네트워크",
  networkAdapter: "네트워크 어댑터",
};

export const pccareToolsText = defineText(ko, {
  en: {
    lockButton: "Find file locks",
    lockButtonTitle: "Find processes that are holding a file or folder",
    lockPickFile: "Choose file",
    lockPickFolder: "Choose folder",
    lockPickFileDialogTitle: "Choose a locked file",
    lockPickFolderDialogTitle: "Choose a locked folder",
    lockRescan: "Search again",
    lockClose: "Close",
    lockSearching: "Searching…",
    lockPrompt: "Choose a file or folder to find the processes holding it",
    lockNone: "No process was found holding this path",
    lockTruncated: "The folder has many files — only the first 2,000 were checked",
    lockFailed: (err) => `Search failed: ${err}`,
    lockColName: "Name",
    lockColReason: "Reason",
    lockColExe: "Executable",
    cleanupTitle: "Reclaimable space",
    cleanupScan: "Scan",
    cleanupScanning: "Scanning…",
    cleanupHint: "Scan counts the space used by temp files, the recycle bin, crash dumps and dev caches",
    cleanupEmpty: "Nothing to clean was found",
    cleanupFiles: (n) => `${n.toLocaleString()} files`,
    cleanupRun: "Clean selected",
    cleanupRunning: "Cleaning…",
    cleanupConfirmMessage: (count, size) =>
      `About ${size} will be deleted from ${count} item(s). This bypasses the recycle bin and cannot be undone.`,
    cleanupConfirmLabel: "Clean",
    cleanupDone: (freed, deleted, skipped) =>
      `${freed} freed · ${deleted.toLocaleString()} deleted${
        skipped ? ` · ${skipped.toLocaleString()} skipped (in use or no permission)` : ""
      }`,
    cleanupFailed: (err) => `Cleanup failed: ${err}`,
    cleanupScanFailed: (err) => `Scan failed: ${err}`,
    networkCard: "Network",
    networkAdapter: "Network adapter",
  },
});
