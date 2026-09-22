// UI 문구 카탈로그의 뼈대(DOCS/i18n-design.md §4.2).
//
// 도메인 파일(`text-<도메인>.ts`) 하나에 언어별 문구를 **나란히** 둔다 — 원문 옆에 번역이 있어야 문구를
// 고칠 때 다른 언어도 같이 고친다. 한국어가 원본이고 나머지 언어는 `defineText`가 **전부** 요구한다:
// `Locale`에 언어를 하나 더하면 모든 도메인 파일이 그 번역을 내놓을 때까지 tsc가 빨갛다(런타임 폴백 없음).

import type { UiLocale } from "../lib/ipc";

export type Locale = UiLocale;

/**
 * 문자열 리터럴은 `string`으로 넓히고, 함수는 인자 목록을 그대로 둔다 — 번역이 원문과 **같은 모양**
 * (같은 키·같은 인자)이어야 한다. 반환형은 원문 함수의 것을 따른다(문장 안에 굵게·링크가 섞이면 ReactNode).
 */
export type TextShape<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { [K in keyof T]: TextShape<T[K]> };

export function defineText<K>(
  ko: K,
  others: Record<Exclude<Locale, "ko">, TextShape<K>>,
): Record<Locale, TextShape<K>> {
  // 원문은 넓히기 전의 좁은 타입이라 제네릭 K 에서는 TextShape<K> 로 증명되지 않는다 — 넓히기만 하는 안전한 단언.
  return { ko: ko as TextShape<K>, ...others };
}
