// 검색·빠른 열기·심볼 검색.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const ko = {
  quickOpen: {
    placeholder: "파일 이름으로 검색…",
    noMatches: "일치하는 파일 없음",
    loadingFiles: "파일 목록 불러오는 중…",
    truncatedFooter: "일부만 표시 — 더 입력해 좁히세요(50,000개 초과)",
  },
  findInFiles: {
    queryPlaceholder: (hotkey: string) => `검색 (${hotkey}) — Enter로 실행`,
    includePlaceholder: "포함 (예: *.ts, src/**)",
    caseSensitive: "대소문자 구분",
    wholeWord: "단어 단위",
    regex: "정규식",
    close: "닫기 (Esc)",
    idleHint: "검색어를 입력하고 Enter를 누르세요.",
    noResults: "일치하는 결과가 없습니다.",
    summary: (matches: number, files: number, truncated: boolean) =>
      `${matches}개 매치 · ${files}개 파일${truncated ? " · 500+개 — 조건을 좁히세요" : ""}`,
  },
  symbolSearch: {
    placeholder: "심볼 이름으로 검색 (2자 이상)…",
    emptyText: "심볼을 입력하세요 (함수·클래스·타입 정의)",
  },
};

export const searchText = defineText(ko, {
  en: {
    quickOpen: {
      placeholder: "Search by file name…",
      noMatches: "No matching files",
      loadingFiles: "Loading file list…",
      truncatedFooter: "Partial list — type more to narrow it (over 50,000 files)",
    },
    findInFiles: {
      queryPlaceholder: (hotkey) => `Search (${hotkey}) — press Enter to run`,
      includePlaceholder: "Include (e.g. *.ts, src/**)",
      caseSensitive: "Match case",
      wholeWord: "Match whole word",
      regex: "Use regular expression",
      close: "Close (Esc)",
      idleHint: "Type a search term and press Enter.",
      noResults: "No matching results.",
      summary: (matches, files, truncated) =>
        `${matches} ${plural(matches, "match", "matches")} · ${files} ${plural(files, "file", "files")}${truncated ? " · 500+ — narrow the search" : ""}`,
    },
    symbolSearch: {
      placeholder: "Search by symbol name (2+ characters)…",
      emptyText: "Type a symbol name (functions · classes · type definitions)",
    },
  },
});
