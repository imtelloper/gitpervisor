// 동영상 — 라이브러리 레일·자르기 오버레이·플레이어 상태 줄.

import { defineText } from "./define-text";
import { plural } from "./format-locale";

const ko = {
  cropOverlay: {
    defaultHint: "드래그해서 추출할 영역을 지정하세요 (Esc 취소)",
  },
  libraryRail: {
    expand: "라이브러리 펼치기",
    mediaCount: (n: number) => `미디어 ${n}개`,
    clipCount: (n: number) => `분할 클립 ${n}개`,
    title: "라이브러리",
    collapse: "라이브러리 접기",
    searchPlaceholder: "클립 검색",
    searchLabel: "라이브러리 검색",
    noMedia: "열린 영상이 없습니다.",
    noResults: "검색 결과가 없습니다.",
    clipsTitle: "분할 클립",
    clipsEmpty: "분할 지점을 찍으면 여기에 클립이 나열됩니다.",
    stopPreview: (label: string) => `${label} 미리보기 정지`,
    playSegment: (label: string) => `${label} 구간 재생`,
    saveAllSplits: "분할 전체 저장",
  },
  playerStatusBar: {
    zoom: (pct: number) => `확대 ${pct}%`,
  },
};

export const mediaText = defineText(ko, {
  en: {
    cropOverlay: {
      defaultHint: "Drag to select the area to extract (Esc to cancel)",
    },
    libraryRail: {
      expand: "Expand library",
      mediaCount: (n) => `${n} media ${plural(n, "file", "files")}`,
      clipCount: (n) => `${n} split ${plural(n, "clip", "clips")}`,
      title: "Library",
      collapse: "Collapse library",
      searchPlaceholder: "Search clips",
      searchLabel: "Search library",
      noMedia: "No videos open.",
      noResults: "No results.",
      clipsTitle: "Split clips",
      clipsEmpty: "Add split points to list clips here.",
      stopPreview: (label) => `Stop preview of ${label}`,
      playSegment: (label) => `Play ${label}`,
      saveAllSplits: "Save all splits",
    },
    playerStatusBar: {
      zoom: (pct) => `Zoom ${pct}%`,
    },
  },
});
