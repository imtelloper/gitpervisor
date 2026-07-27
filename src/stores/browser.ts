import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

import { ipc } from "../lib/ipc";
import { useTerminals } from "./terminals";

// 메인 창만 gp:browser localStorage에 쓴다 — sysmon/float 보조 창은 같은 origin의 공유
// 키를 쓰므로, 보조 창이 자기 로드 시점 스냅샷으로 덮으면 메인 창의 최신 상태가 소실된다
// (terminals.ts의 IS_FLOAT 가드와 같은 취지, 여기선 sysmon까지 포함해 메인 창으로 한정).
const IS_MAIN_WINDOW = (() => {
  try {
    const label = getCurrentWebviewWindow().label;
    return label !== "sysmon" && !label.startsWith("float-");
  } catch {
    return true;
  }
})();

// external=네이티브 자식 webview(github/google 등), iframe=localhost dev 프리뷰(React <iframe>)
export type BrowserMode = "native" | "iframe";

/** 로컬 HTML 프리뷰의 출처 — URL(루프백 포트+토큰)은 프로세스 수명이라 재시작 후 죽는데,
 *  출처가 있으면 시작 시 preview_local_url로 재발급해 탭을 되살릴 수 있다. */
export interface PreviewSource {
  projectId: string;
  relPath: string;
}

export interface BrowserItem {
  id: string; // 독립 탭 id 또는 분할 패널 paneId — 동일 맵에 통합 보관
  projectId: string;
  title: string;
  url: string;
  mode: BrowserMode;
  preview?: PreviewSource;
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

/** 프리뷰(루프백 발급) URL 판정 — 죽은 토큰 URL이 방문기록·자동완성에 남지 않게. */
export function isPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "127.0.0.1" && /^[0-9a-f]{32}$/.test(u.searchParams.get("t") ?? "")
    );
  } catch {
    return false;
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
  /** 독립 브라우저 탭 생성 — 반환 id가 activeTab 슬롯에 들어간다.
   *  preview를 주면 로컬 HTML 프리뷰 탭으로 표시돼 재시작 시 URL을 재발급받는다. */
  openBrowser: (projectId: string, url?: string, preview?: PreviewSource) => string;
  closeBrowser: (id: string) => void;
  /** 분할 패널 브라우저 보장(멱등) — 트리 leaf가 browser로 전환될 때 호출 */
  ensurePane: (id: string, projectId: string, url?: string) => void;
  /** 분할 패널 브라우저 제거(패널 닫힘/터미널 전환 시) */
  removePane: (id: string) => void;
  /** 주소창 확정 — navigate + mode 재판정. 사용자가 직접 이동한 것이므로 프리뷰 출처는 끊는다. */
  setUrl: (id: string, url: string) => void;
  /** 프리뷰 URL 재발급 반영 — setUrl과 달리 preview 출처를 유지한다(시작 시 복구 경로).
   *  expect를 주면 그 출처가 여전히 이 탭의 preview일 때만 적용한다(늦게 온 재발급이
   *  그 사이 사용자가 다른 곳으로 이동시킨 탭을 덮어쓰지 않게). */
  refreshPreview: (id: string, url: string, expect?: PreviewSource) => void;
  /** 백엔드 browser://nav 반영 (페이지가 스스로 이동한 경우 포함) */
  applyNav: (id: string, p: { url: string; loading: boolean }) => void;
  setTitle: (id: string, title: string) => void;
  /** 북마크 토글 — 있으면 제거, 없으면 추가 */
  toggleBookmark: (url: string, title: string) => void;
}

function pushHistory(history: HistoryEntry[], url: string, title?: string): HistoryEntry[] {
  if (!url || url === "about:blank" || isPreviewUrl(url)) return history;
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

  openBrowser: (projectId, url = "", preview) => {
    const id = crypto.randomUUID();
    set((s) => ({
      items: { ...s.items, [id]: { ...makeItem(id, projectId, url), preview } },
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
              [id]: {
                ...s.items[id],
                url,
                mode: classifyMode(url),
                // 사용자가 다른 곳으로 이동 — 더는 프리뷰 탭이 아니다(재발급 대상 제외)
                preview: undefined,
              },
            },
          }
        : s,
    ),

  refreshPreview: (id, url, expect) =>
    set((s) => {
      const item = s.items[id];
      if (!item) return s;
      // 늦게 settle된 재발급 가드 — 그 사이 setUrl로 preview가 끊겼거나 다른 파일로
      // 바뀌었으면 무시한다(사용자가 이동한 페이지를 프리뷰 URL로 되돌리지 않게).
      if (
        expect &&
        (item.preview?.projectId !== expect.projectId ||
          item.preview?.relPath !== expect.relPath)
      )
        return s;
      return {
        items: { ...s.items, [id]: { ...item, url, mode: classifyMode(url) } },
      };
    }),

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

// 프리뷰 URL(루프백 포트+토큰)은 프로세스 수명이라 재시작 후엔 죽은 주소다 — 출처가 저장된
// 항목은 시작 시 재발급해 되살린다. 같은 세션 내 재실행은 폴더별 포트 캐시로 같은 URL이
// 돌아와 멱등이고, 실패(파일/프로젝트 삭제)하면 빈 주소로 둬 BrowserEmpty가 뜬다.
//
// main.tsx의 메인 창 분기에서만 호출한다 — sysmon/float 보조 창은 같은 origin의 공유
// localStorage(gp:browser)를 쓰므로, 이 루프가 보조 창 스토어를 set()하면 그 창의 로드
// 시점 스냅샷으로 localStorage를 덮어써 메인 창의 최신 탭/북마크가 소실된다.
export function initPreviewRemint(): void {
  for (const id of Object.keys(useBrowsers.getState().items)) remintPreview(id);
}

/**
 * 프리뷰 탭 하나의 URL을 재발급한다(출처가 있는 항목만). 백엔드가 폴더별로 포트를 캐시하므로
 * 서버가 살아 있으면 **같은 URL**이 돌아와 iframe이 재로드되지 않고, 죽었으면 새 포트를 띄워
 * 되살린다(멱등).
 *
 * 시작 시점 외에 **탭 활성화 때도** 호출한다 — 서버는 유휴 10분이면 스스로 종료하는데(preview.rs)
 * 탭은 그대로 열려 있을 수 있다. 그 상태로 페이지 안 링크를 누르면 연결 거부가 되므로, 탭으로
 * 돌아올 때 되살린다. 서버가 죽는 다른 원인(프로젝트 제거 후 재추가 등)도 같은 경로로 덮인다.
 */
export function remintPreview(id: string): void {
  const src = useBrowsers.getState().items[id]?.preview;
  if (!src) return;
  void ipc
    .previewLocalUrl(src.projectId, src.relPath)
    .then((url) => useBrowsers.getState().refreshPreview(id, url, src))
    .catch(() => useBrowsers.getState().refreshPreview(id, "", src));
}

// 탭/패널 URL·방문기록·북마크가 바뀔 때마다 localStorage에 저장 — 다음 실행에서 복구.
// 메인 창만 쓴다(위 IS_MAIN_WINDOW 주석) — 보조 창이 스테일 스냅샷으로 덮지 않게.
if (IS_MAIN_WINDOW)
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
