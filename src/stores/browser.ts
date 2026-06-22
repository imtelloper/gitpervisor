import { create } from "zustand";

import { useTerminals } from "./terminals";

// external=네이티브 자식 webview(github/google 등), iframe=localhost dev 프리뷰(React <iframe>)
export type BrowserMode = "native" | "iframe";

export interface BrowserItem {
  id: string; // 독립 탭 id 또는 분할 패널 paneId — 동일 맵에 통합 보관
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
  /** 모든 브라우저(독립 탭 + 분할 패널) — id로 통합 보관 */
  items: Record<string, BrowserItem>;
  /** 독립 브라우저 탭의 id (탭 스트립용, 생성 순서) */
  tabIds: string[];
  /** 방문 기록 (최근 우선, 중복 제거) — 옴니박스 자동완성. 영속. */
  history: HistoryEntry[];
  /** 북마크 (추가 우선). 영속. */
  bookmarks: BookmarkEntry[];
  /** id별 로딩 여부 (전이 상태, 비영속) */
  loading: Record<string, boolean>;
  /** 독립 브라우저 탭 생성 — 반환 id가 activeTab 슬롯에 들어간다 */
  openBrowser: (projectId: string, url?: string) => string;
  closeBrowser: (id: string) => void;
  /** 분할 패널 브라우저 보장(멱등) — 트리 leaf가 browser로 전환될 때 호출 */
  ensurePane: (id: string, projectId: string, url?: string) => void;
  /** 분할 패널 브라우저 제거(패널 닫힘/터미널 전환 시) */
  removePane: (id: string) => void;
  /** 주소창 확정 — navigate + mode 재판정 */
  setUrl: (id: string, url: string) => void;
  /** 백엔드 browser://nav 반영 (페이지가 스스로 이동한 경우 포함) */
  applyNav: (id: string, p: { url: string; loading: boolean }) => void;
  setTitle: (id: string, title: string) => void;
  /** 북마크 토글 — 있으면 제거, 없으면 추가 */
  toggleBookmark: (url: string, title: string) => void;
}

function pushHistory(history: HistoryEntry[], url: string, title?: string): HistoryEntry[] {
  if (!url || url === "about:blank") return history;
  const rest = history.filter((h) => h.url !== url);
  const prev = history.find((h) => h.url === url);
  return [{ url, title: title || prev?.title || "" }, ...rest].slice(0, HISTORY_CAP);
}

// 터미널과 분리된 키로 영속 — 탭/패널 URL + 방문기록 + 북마크(네이티브 history·세션은 복구 불가).
const PERSIST_KEY = "gp:browser";
interface Persisted {
  items: Record<string, BrowserItem>;
  tabIds: string[];
  history: HistoryEntry[];
  bookmarks: BookmarkEntry[];
}
function loadPersisted(): Persisted {
  const empty: Persisted = { items: {}, tabIds: [], history: [], bookmarks: [] };
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Persisted> & { browsers?: BrowserItem[] };
    const history = Array.isArray(p.history) ? p.history : [];
    const bookmarks = Array.isArray(p.bookmarks) ? p.bookmarks : [];
    // 구버전(browsers 배열) → items/tabIds 마이그레이션
    if (Array.isArray(p.browsers)) {
      const items: Record<string, BrowserItem> = {};
      const tabIds: string[] = [];
      for (const b of p.browsers) {
        items[b.id] = b;
        tabIds.push(b.id);
      }
      return { items, tabIds, history, bookmarks };
    }
    return {
      items: p.items && typeof p.items === "object" ? p.items : {},
      tabIds: Array.isArray(p.tabIds) ? p.tabIds : [],
      history,
      bookmarks,
    };
  } catch {
    return empty;
  }
}

function hostTitle(url: string): string {
  try {
    return new URL(url).host || "새 브라우저";
  } catch {
    return "새 브라우저";
  }
}

function makeItem(id: string, projectId: string, url: string): BrowserItem {
  return {
    id,
    projectId,
    title: url ? hostTitle(url) : "새 브라우저",
    url,
    mode: url ? classifyMode(url) : "native",
  };
}

const persisted = loadPersisted();

export const useBrowsers = create<BrowsersState>((set, get) => ({
  items: persisted.items,
  tabIds: persisted.tabIds,
  history: persisted.history,
  bookmarks: persisted.bookmarks,
  loading: {},

  openBrowser: (projectId, url = "") => {
    const id = crypto.randomUUID();
    set((s) => ({
      items: { ...s.items, [id]: makeItem(id, projectId, url) },
      tabIds: [...s.tabIds, id],
    }));
    useTerminals.getState().setActiveTab(projectId, id);
    return id;
  },

  closeBrowser: (id) => {
    const item = get().items[id];
    set((s) => {
      const items = { ...s.items };
      delete items[id];
      const loading = { ...s.loading };
      delete loading[id];
      return { items, tabIds: s.tabIds.filter((t) => t !== id), loading };
    });
    // 활성 탭이었다면 Viewer로 되돌린다 (DB 탭 닫기와 동일 UX)
    if (item) {
      const ts = useTerminals.getState();
      if (ts.activeTab[item.projectId] === id) ts.setActiveTab(item.projectId, "viewer");
    }
  },

  ensurePane: (id, projectId, url = "") =>
    set((s) =>
      s.items[id]
        ? s
        : { items: { ...s.items, [id]: makeItem(id, projectId, url) } },
    ),

  removePane: (id) =>
    set((s) => {
      if (!s.items[id]) return s;
      const items = { ...s.items };
      delete items[id];
      const loading = { ...s.loading };
      delete loading[id];
      return { items, loading };
    }),

  setUrl: (id, url) =>
    set((s) =>
      s.items[id]
        ? {
            items: {
              ...s.items,
              [id]: { ...s.items[id], url, mode: classifyMode(url) },
            },
          }
        : s,
    ),

  applyNav: (id, p) =>
    set((s) => {
      const item = s.items[id];
      if (!item) return { loading: { ...s.loading, [id]: p.loading } };
      return {
        loading: { ...s.loading, [id]: p.loading },
        items: { ...s.items, [id]: { ...item, url: p.url || item.url } },
        history: p.url ? pushHistory(s.history, p.url) : s.history,
      };
    }),

  setTitle: (id, title) =>
    set((s) => {
      const item = s.items[id];
      if (!item) return s;
      return {
        items: { ...s.items, [id]: { ...item, title: title || item.title } },
        history: title ? pushHistory(s.history, item.url, title) : s.history,
        bookmarks: title
          ? s.bookmarks.map((bm) =>
              bm.url === item.url && !bm.title ? { ...bm, title } : bm,
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

// 탭/패널 URL·방문기록·북마크가 바뀔 때마다 localStorage에 저장 — 다음 실행에서 복구.
useBrowsers.subscribe((s) => {
  try {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        items: s.items,
        tabIds: s.tabIds,
        history: s.history,
        bookmarks: s.bookmarks,
      }),
    );
  } catch {
    /* 무시 */
  }
});
