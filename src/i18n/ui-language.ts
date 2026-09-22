// UI 언어 상태(DOCS/i18n-design.md §4.1·§4.2) — 창마다 하나다(창은 JS 컨텍스트가 따로다).
//
// 언어는 Rust가 정한다(`ui_language_resolved`). 여기서는 그 답을 받아 문구 객체를 갈아 끼울 뿐이다 —
// `navigator.language`로 따로 판정하면 창 제목·오류(Rust)와 화면 언어가 어긋날 수 있다.

import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { errorMessage, ipc } from "../lib/ipc";
import type { Locale } from "./define-text";
import { messagesFor, type Messages } from "./messages";

/** 첫 화면을 이보다 오래 붙잡지 않는다 — 답이 늦으면 지금 언어(한국어)로 그리고 나중에 바꾼다. */
const RESOLVE_WAIT_MS = 1500;

interface UiLanguageState {
  locale: Locale;
  messages: Messages;
}

// 판정 전 기본은 한국어 — 지금까지 모든 사용자가 본 화면이고 Rust `i18n.rs`의 기본과 같다.
export const useUiLanguage = create<UiLanguageState>(() => ({
  locale: "ko",
  messages: messagesFor("ko"),
}));

/** 컴포넌트용 — 언어가 바뀔 때만 참조가 바뀌어 다시 그린다. */
export function useMessages(): Messages {
  return useUiLanguage((s) => s.messages);
}

/** 컴포넌트 밖(스토어의 토스트·lib)용 — **호출 시점의 언어**로 문자열을 만든다. */
export function currentMessages(): Messages {
  return useUiLanguage.getState().messages;
}

export function currentLocale(): Locale {
  return useUiLanguage.getState().locale;
}

function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  if (useUiLanguage.getState().locale === locale) return;
  useUiLanguage.setState({ locale, messages: messagesFor(locale) });
}

async function refreshFromBackend(): Promise<void> {
  try {
    const resolved = await Promise.race([
      ipc.uiLanguageResolved(),
      new Promise<null>((r) => window.setTimeout(() => r(null), RESOLVE_WAIT_MS)),
    ]);
    if (resolved === "ko" || resolved === "en") applyLocale(resolved);
    else if (resolved !== null) console.warn(`[i18n] 모르는 UI 언어 "${String(resolved)}" — 지금 언어 유지`);
  } catch (e) {
    // 판정을 못 받았다고 화면을 막을 수는 없다 — 지금 언어로 그리고 다음 설정 변경 때 다시 묻는다.
    console.warn("[i18n] UI 언어 조회 실패 — 지금 언어 유지:", errorMessage(e));
  }
}

/**
 * 첫 화면 전에 한 번 부른다 — 이 창의 언어를 정하고 설정 변경(`settings://changed`)을 따라간다.
 * 던지지 않고 `RESOLVE_WAIT_MS` 넘게 붙잡지 않는다.
 */
export async function initUiLanguage(): Promise<void> {
  await refreshFromBackend();
  void listen("settings://changed", () => void refreshFromBackend()).catch((e: unknown) =>
    console.warn("[i18n] 설정 변경 구독 실패 — 언어를 바꾸면 창을 다시 열어야 반영된다:", errorMessage(e)),
  );
}
