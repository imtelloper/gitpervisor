// 설정 › 일반의 UI 언어 선택(DOCS/i18n-design.md §4.1).

import { defineText } from "./define-text";

const ko = {
  // 영어 병기 — 모르는 언어로 떠 있는 화면에서도 이 칸은 찾을 수 있어야 한다.
  fieldLabel: "언어 · Language",
  fieldHint: "시스템을 고르면 OS 표시 언어를 따릅니다. 바꾸면 열려 있는 모든 창에 바로 적용됩니다",
  optionSystem: "시스템 설정 따르기",
  // 언어 이름은 그 언어로 쓴다(자기 이름) — 어느 UI 언어에서든 같은 글자다.
  optionKorean: "한국어",
  optionEnglish: "English (베타 — 일부 화면은 한국어)",
};

export const languageText = defineText(ko, {
  en: {
    fieldLabel: "Language",
    fieldHint:
      "System follows the OS display language. Changes apply to every open window immediately",
    optionSystem: "Follow system setting",
    optionKorean: "한국어",
    optionEnglish: "English (beta — some screens are still in Korean)",
  },
});
