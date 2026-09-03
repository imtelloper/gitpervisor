// 사용자 정의 테마 목록 (태스크 29) — 정의는 localStorage `gp:custom-themes`에 두고
// 창 간에는 storage 이벤트로 동기한다(termThemes.ts와 같은 패턴·같은 이유: 설정 JSON에
// 넣으면 Rust 타입·설정 인덱스·완전성 가드까지 연쇄인데, 렌더 전 선적용은 어차피 동기
// localStorage가 필요하다). 화면 적용(<style> 블록)은 lib/theme-apply.ts 담당.
import { create } from "zustand";

import { refreshTerminalThemes } from "../lib/terminal";
import { installCustomThemeStyles } from "../lib/theme-apply";
import { CUSTOM_THEMES_KEY, loadCustomThemes, type CustomTheme } from "../lib/themes";

/** 디스크 반영 + 이 창의 즉시 재적용 — storage 이벤트는 **다른** 창에서만 발화한다. */
function persist(themes: CustomTheme[]): void {
  try {
    localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
  } catch {
    /* localStorage 불가 — 이번 실행 동안은 메모리 상태로 동작 */
  }
  installCustomThemeStyles();
  refreshTerminalThemes();
}

interface CustomThemesState {
  themes: CustomTheme[];
  /** 추가 또는 교체(id 기준). */
  upsert: (t: CustomTheme) => void;
  remove: (id: string) => void;
  get: (id: string) => CustomTheme | undefined;
}

export const useCustomThemes = create<CustomThemesState>((set, get) => ({
  themes: loadCustomThemes(),

  upsert: (t) => {
    const cur = get().themes;
    const next = cur.some((x) => x.id === t.id)
      ? cur.map((x) => (x.id === t.id ? t : x))
      : [...cur, t];
    set({ themes: next });
    persist(next);
  },

  remove: (id) => {
    const next = get().themes.filter((x) => x.id !== id);
    set({ themes: next });
    persist(next);
  },

  get: (id) => get().themes.find((t) => t.id === id),
}));

// 다른 창의 목록 변경을 따라간다 — <style> 재생성은 theme-apply.ts의 리스너가 하고,
// 여기선 설정 UI가 보는 목록 상태만 맞춘다.
window.addEventListener("storage", (e) => {
  if (e.key !== CUSTOM_THEMES_KEY) return;
  useCustomThemes.setState({ themes: loadCustomThemes() });
});
