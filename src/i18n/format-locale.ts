// 언어를 따르는 숫자·복수형(DOCS/i18n-design.md §4.2) — 카탈로그 함수 안에서 쓴다.
//
// 숫자를 문구에 박지 말고 이 헬퍼로 — `toLocaleString()`을 인자 없이 부르면 OS 로캘을 따라가
// UI 언어와 어긋난다(영어 UI에 한국식 구분자·그 반대).

import { currentLocale } from "./locale-state";

const INTL_TAG = { ko: "ko-KR", en: "en-US" } as const;

export function fmtInt(n: number): string {
  return n.toLocaleString(INTL_TAG[currentLocale()], { maximumFractionDigits: 0 });
}

export function fmtNumber(n: number, fractionDigits: number): string {
  return n.toLocaleString(INTL_TAG[currentLocale()], {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** 영어 복수형 — `plural(n, "file", "files")`. 한국어 쪽은 복수가 없으니 쓰지 않는다. */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}
