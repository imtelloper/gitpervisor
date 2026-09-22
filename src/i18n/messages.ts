// 도메인 카탈로그를 한 객체로 묶는다(DOCS/i18n-design.md §4.2). 새 도메인은 여기 한 줄.
//
// 접근은 언제나 **경로**로 한다 — `msg.language.fieldLabel`. `msg[domain][key]`처럼 조립하면 호출처가
// 검색에서 사라지고 오타가 런타임에만 드러난다(e2e 66 이 `msg[` 패턴을 막는다).

import type { Locale } from "./define-text";
import { languageText } from "./text-language";

export function messagesFor(locale: Locale) {
  return {
    language: languageText[locale],
  };
}

export type Messages = ReturnType<typeof messagesFor>;
