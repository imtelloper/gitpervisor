// 지금 UI 언어 — import 가 하나도 없는 잎 모듈이다.
//
// 카탈로그(`text-*.ts`)가 형식 헬퍼(`format-locale.ts`)를 쓰고, 헬퍼는 지금 언어가 필요하다. 그 값을
// `ui-language.ts`(스토어 — 카탈로그를 import 한다)에서 가져오면 순환 import 가 생겨 앱 시작 때 초기화 순서
// 오류가 난다. 그래서 값만 여기 두고 스토어가 갱신한다.

import type { Locale } from "./define-text";

let current: Locale = "ko";

export function currentLocale(): Locale {
  return current;
}

/** `ui-language.ts`의 applyLocale 만 부른다. */
export function setCurrentLocale(locale: Locale): void {
  current = locale;
}
