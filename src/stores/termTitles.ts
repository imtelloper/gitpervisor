// 터미널 세션별 제목 — "이 세션이 뭘 하던 것이었지?"를 잊지 않게 사용자가 직접 붙이는 이름. 모아보기 셀 헤더
// 가운데에 보인다. 컬러 스킴(termThemes)과 같은 계약: 세션(pane)을 닫으면(dropPane) 함께 지워지고, 닫지 않는 한
// 앱을 다시 켜도 남는다(세션 복원이 같은 paneId 를 쓴다).
import { create } from "zustand";

/** termId(=paneId) → 제목. 항목 없음 = 제목 없음. */
type TitleMap = Record<string, string>;

const KEY = "gp:term-session-titles";
/** 헤더 한 줄에 들어갈 만큼 — 더 길면 메모장의 일이다. */
export const SESSION_TITLE_MAX = 80;

function load(): TitleMap {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    const out: TitleMap = {};
    for (const [k, v] of Object.entries(p as Record<string, unknown>))
      if (typeof v === "string" && v) out[k] = v.slice(0, SESSION_TITLE_MAX);
    return out;
  } catch {
    return {};
  }
}

/** 읽고-고쳐-쓰기 — 모아보기 별도 창과 메인이 각자 다른 세션 제목을 바꿀 수 있어 통째 덮어쓰면 상대 것이 지워진다
 *  (termThemes 와 같은 이유). */
function persist(termId: string, title: string | null): void {
  try {
    const cur = load();
    if (title) cur[termId] = title;
    else delete cur[termId];
    localStorage.setItem(KEY, JSON.stringify(cur));
  } catch {
    /* localStorage 불가 — 제목은 이번 실행 동안 메모리에만 남는다 */
  }
}

interface TermTitlesState {
  byTerminal: TitleMap;
  /** 빈 문자열·공백뿐이면 지운다. */
  setTitle: (termId: string, title: string) => void;
  /** 세션 종료 시 정리 — 닫힌 터미널의 제목이 쌓이지 않게. */
  clear: (termId: string) => void;
}

export const useTermTitles = create<TermTitlesState>((set) => ({
  byTerminal: load(),

  setTitle: (termId, title) => {
    const t = title.trim().slice(0, SESSION_TITLE_MAX);
    set((s) => {
      const next = { ...s.byTerminal };
      if (t) next[termId] = t;
      else delete next[termId];
      return { byTerminal: next };
    });
    persist(termId, t || null);
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

// 다른 창(모아보기 별도 창 ↔ 메인)에서 바꾼 제목을 따라간다 — storage 이벤트는 다른 창에서만 발화.
window.addEventListener("storage", (e) => {
  if (e.key !== KEY) return;
  useTermTitles.setState({ byTerminal: load() });
});
