import { create } from "zustand";

import { useTerminals } from "./terminals";

// external=네이티브 자식 webview(github/google 등), iframe=localhost dev 프리뷰(React <iframe>)
export type BrowserMode = "native" | "iframe";

export interface BrowserTab {
  id: string;
  projectId: string;
  title: string;
  url: string;
  mode: BrowserMode;
}

/** localhost류 호스트 판정 — iframe(자기 출처) 경로로 보낼지 결정. */
export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1";
}

/** URL → 렌더 경로. localhost는 iframe(점유 무관·split 통합), 그 외 http(s)는 네이티브. */
export function classifyMode(url: string): BrowserMode {
  try {
    return isLocalHost(new URL(url).hostname) ? "iframe" : "native";
  } catch {
    return "native";
  }
}

/**
 * 옴니박스 입력 → 이동할 URL. URL이면 그대로(scheme 보충), 아니면 Google 검색.
 * 빈 입력은 null.
 */
export function resolveOmnibox(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?(\/.*)?$/i.test(s)) return `http://${s}`;
  // 점이 있고 공백이 없으면 호스트로 간주 (github.com/x → https://github.com/x)
  if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export interface HistoryEntry {
  url: string;
  title: string;
}
export interface BookmarkEntry {
  url: string;
  title: string;
}
const HISTORY_CAP = 120;

interface BrowsersState {
  browsers: BrowserTab[];
  /** 방문 기록 (최근 우선, 중복 제거) — 옴니박스 자동완성. 영속. */
  history: HistoryEntry[];
  /** 북마크 (추가 우선). 영속. */
  bookmarks: BookmarkEntry[];
  /** 탭별 로딩 여부 (전이 상태, 비영속) */
  loading: Record<string, boolean>;
  openBrowser: (projectId: string, url?: string) => string;
  closeBrowser: (tabId: string) => void;
  /** 주소창 확정 — navigate + mode 재판정 */
  setUrl: (tabId: string, url: string) => void;
  /** 백엔드 browser://nav 반영 (페이지가 스스로 이동한 경우 포함) */
  applyNav: (tabId: string, p: { url: string; loading: boolean }) => void;
  setTitle: (tabId: string, title: string) => void;
  /** 북마크 토글 — 있으면 제거, 없으면 추가 */
  toggleBookmark: (url: string, title: string) => void;
}

function pushHistory(history: HistoryEntry[], url: string, title?: string): HistoryEntry[] {
  if (!url || url === "about:blank") return history;
  const rest = history.filter((h) => h.url !== url);
  const prev = history.find((h) => h.url === url);
  return [{ url, title: title || prev?.title || "" }, ...rest].slice(0, HISTORY_CAP);
}

// 터미널과 분리된 키로 영속 — 탭/마지막 URL + 방문기록 + 북마크(네이티브 history·세션은 복구 불가).
const PERSIST_KEY = "gp:browser";
function loadPersisted(): {
  browsers: BrowserTab[];
  history: HistoryEntry[];
  bookmarks: BookmarkEntry[];
} {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) {
      const p = JSON.parse(raw) as {
        browsers?: BrowserTab[];
        history?: HistoryEntry[];
        bookmarks?: BookmarkEntry[];
      };
      return {
        browsers: Array.isArray(p.browsers) ? p.browsers : [],
        history: Array.isArray(p.history) ? p.history : [],
        bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
      };
    }
  } catch {
    /* 손상 데이터 무시 */
  }
  return { browsers: [], history: [], bookmarks: [] };
}

function hostTitle(url: string): string {
  try {
    return new URL(url).host || "새 브라우저";
  } catch {
    return "새 브라우저";
  }
}

const persisted = loadPersisted();

export const useBrowsers = create<BrowsersState>((set, get) => ({
  browsers: persisted.browsers,
  history: persisted.history,
  bookmarks: persisted.bookmarks,
  loading: {},

  openBrowser: (projectId, url = "") => {
    const id = crypto.randomUUID();
    set((s) => ({
      browsers: [
        ...s.browsers,
        {
          id,
          projectId,
          title: url ? hostTitle(url) : "새 브라우저",
          url,
          mode: url ? classifyMode(url) : "native",
        },
      ],
    }));
    useTerminals.getState().setActiveTab(projectId, id);
    return id;
  },

  closeBrowser: (tabId) => {
    const tab = get().browsers.find((b) => b.id === tabId);
    set((s) => {
      const loading = { ...s.loading };
      delete loading[tabId];
      return { browsers: s.browsers.filter((b) => b.id !== tabId), loading };
    });
    // 활성 탭이었다면 Viewer로 되돌린다 (DB 탭 닫기와 동일 UX)
    if (tab) {
      const ts = useTerminals.getState();
      if (ts.activeTab[tab.projectId] === tabId) ts.setActiveTab(tab.projectId, "viewer");
    }
  },

  setUrl: (tabId, url) =>
    set((s) => ({
      browsers: s.browsers.map((b) =>
        b.id === tabId ? { ...b, url, mode: classifyMode(url) } : b,
      ),
    })),

  applyNav: (tabId, p) =>
    set((s) => ({
      loading: { ...s.loading, [tabId]: p.loading },
      browsers: s.browsers.map((b) =>
        b.id === tabId ? { ...b, url: p.url || b.url } : b,
      ),
      history: p.url ? pushHistory(s.history, p.url) : s.history,
    })),

  setTitle: (tabId, title) =>
    set((s) => {
      const tab = s.browsers.find((b) => b.id === tabId);
      return {
        browsers: s.browsers.map((b) =>
          b.id === tabId ? { ...b, title: title || b.title } : b,
        ),
        // 같은 URL의 방문기록·북마크에 제목 보강
        history:
          tab && title ? pushHistory(s.history, tab.url, title) : s.history,
        bookmarks:
          tab && title
            ? s.bookmarks.map((bm) =>
                bm.url === tab.url && !bm.title ? { ...bm, title } : bm,
              )
            : s.bookmarks,
      };
    }),

  toggleBookmark: (url, title) =>
    set((s) => {
      if (!url) return s;
      const exists = s.bookmarks.some((b) => b.url === url);
      return {
        bookmarks: exists
          ? s.bookmarks.filter((b) => b.url !== url)
          : [{ url, title: title || url }, ...s.bookmarks],
      };
    }),
}));

// 탭/URL/방문기록/북마크가 바뀔 때마다 localStorage에 저장 — 다음 실행에서 복구.
useBrowsers.subscribe((s) => {
  try {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        browsers: s.browsers,
        history: s.history,
        bookmarks: s.bookmarks,
      }),
    );
  } catch {
    /* 무시 */
  }
});
