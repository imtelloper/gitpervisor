// 터미널 세션별 컬러 스킴 선택 — 모아보기 셀의 팔레트 버튼이 기록하고, 그 세션의 xterm에
// 적용된다(모아보기·워크스페이스·플로팅 어디서 그리든 같은 세션 = 같은 색).
// 세션(pane)이 닫힐 때(dropPane) 함께 지워진다 — "세션을 끄지 않는 한 기억"이 계약.
import { create } from "zustand";

import { refreshTerminalThemes } from "../lib/terminal";
import type { TermSchemeId } from "../lib/term-color-schemes";

/** termId(=paneId) → 스킴 id. 항목 없음 = 앱 테마 따름(기본). */
type SchemeMap = Record<string, TermSchemeId>;

const KEY = "gp:term-themes";

function load(): SchemeMap {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    // 값은 문자열만 신뢰한다 — 미지의 스킴 id는 적용 시점(termSchemeOf)이 기본으로 폴백.
    const out: SchemeMap = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>))
      if (typeof v === "string") out[k] = v as TermSchemeId;
    return out;
  } catch {
    return {};
  }
}

/**
 * 디스크 반영 — 프롬프트 기록(promptHistory)과 같은 이유로 **읽고-고쳐-쓰기**:
 * 모아보기 별도 창이 열리면 그 창이 xterm을 소유해 스킴 변경도 그 창에서 일어난다.
 * 스냅샷 통째 덮어쓰기는 상대 창이 방금 바꾼 다른 세션의 선택을 지운다.
 */
function persist(termId: string, scheme: TermSchemeId | null): void {
  try {
    const cur = load();
    if (scheme) cur[termId] = scheme;
    else delete cur[termId];
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    /* localStorage 불가 — 선택은 메모리에만 남는다(이번 실행 동안은 동작) */
  }
}

interface TermThemesState {
  byTerminal: SchemeMap;
  /** 스킴 선택(null=기본으로 복귀). 저장 후 열린 xterm에 즉시 재적용한다. */
  setScheme: (termId: string, scheme: TermSchemeId | null) => void;
  /** 세션 종료 시 정리 — 닫힌 터미널의 선택이 쌓이지 않게. */
  clear: (termId: string) => void;
}

export const useTermThemes = create<TermThemesState>((set) => ({
  byTerminal: load(),

  setScheme: (termId, scheme) => {
    set((s) => {
      const next = { ...s.byTerminal };
      if (scheme) next[termId] = scheme;
      else delete next[termId];
      return { byTerminal: next };
    });
    persist(termId, scheme);
    // 열린 모든 터미널에 재적용(엔진이 세션별 오버라이드를 읽는다) — 대상 하나만 바뀌지만
    // 나머지도 같은 값 재대입이라 무해하고, 단일 경로가 어긋날 자리를 없앤다.
    refreshTerminalThemes();
  },

  clear: (termId) => {
    set((s) => {
      if (!(termId in s.byTerminal)) return s;
      const rest = { ...s.byTerminal };
      delete rest[termId];
      return { byTerminal: rest };
    });
    persist(termId, null);
  },
}));

// 다른 창(모아보기 별도 창 ↔ 메인)의 선택을 따라간다 — storage 이벤트는 다른 창에서만 발화.
// xterm을 소유한 쪽이 이 이벤트를 받으면 즉시 재적용해 화면도 함께 바뀐다.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY || !e.newValue) return;
  try {
    const p = JSON.parse(e.newValue);
    if (p && typeof p === "object" && !Array.isArray(p)) {
      useTermThemes.setState({ byTerminal: p as SchemeMap });
      refreshTerminalThemes();
    }
  } catch {
    /* 손상된 값 무시 */
  }
});
