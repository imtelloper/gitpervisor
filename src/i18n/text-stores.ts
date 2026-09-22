// 스토어가 띄우는 토스트·안내(이미지 라이브러리·브라우저·업데이트·API·터미널).

import { defineText } from "./define-text";

const ko = {
  apiclient: {
    newRequestName: "새 요청",
  },
  browser: {
    newBrowserTitle: "새 브라우저",
  },
  imageLibrary: {
    // 이름 없이 저장된 항목을 읽을 때 붙이는 이름.
    fallbackColorStyleName: "색",
    fallbackTextStyleName: "텍스트",
    fallbackEffectStyleName: "효과",
    fallbackComponentName: "컴포넌트",
    // 첫 로드에 심는 내장 텍스트 스타일 — `섹션 / 이름` 경로라 첫 세그먼트가 서로 달라야 섹션 헤더로 접히지 않는다.
    seedHeadingName: "제목 / H1",
    seedBodyName: "본문 / Body",
    seedCaptionName: "캡션 / Caption",
    saveFailed: (err: string) => `이미지 라이브러리 저장 실패 — ${err}`,
  },
  terminals: {
    defaultTitle: (n: number) => `터미널 ${n}`,
  },
  updater: {
    newVersionAvailable: (version: string) => `새 버전 v${version}이 나왔습니다`,
    openUpdate: "업데이트 열기",
  },
};

export const storesText = defineText(ko, {
  en: {
    apiclient: {
      newRequestName: "New request",
    },
    browser: {
      newBrowserTitle: "New browser",
    },
    imageLibrary: {
      fallbackColorStyleName: "Color",
      fallbackTextStyleName: "Text",
      fallbackEffectStyleName: "Effect",
      fallbackComponentName: "Component",
      seedHeadingName: "Heading / H1",
      seedBodyName: "Body text / Body",
      seedCaptionName: "Caption text / Caption",
      saveFailed: (err) => `Failed to save image library — ${err}`,
    },
    terminals: {
      defaultTitle: (n) => `Terminal ${n}`,
    },
    updater: {
      newVersionAvailable: (version) => `New version v${version} is available`,
      openUpdate: "View update",
    },
  },
});
