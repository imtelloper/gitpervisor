import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

import { currentMessages } from "../i18n/ui-language";
import { ipc } from "../lib/ipc";
import { useTerminals } from "./terminals";

// gp:browser localStorage는 **메인 창만** 쓴다 — 보조 창들은 같은 origin의 공유 키를 쓰므로, 보조 창이 자기
// 로드 시점 스냅샷으로 덮으면 메인 창의 최신 탭이 소실된다. 예전 판정(sysmon·float-* 만 제외)은 모아보기
// 별도 창과 문서 창(doc-*)을 저장자로 남겨, 그 창에서 페이지가 로드될 때마다(browser://nav는 모든 창에
// 간다) 낡은 스냅샷이 메인의 새 탭을 지웠다.
//
//  - main      : 저장 + 아래 보조 창 명령을 대신 실행
//  - aggregate : 메인이 저장한 것을 storage 이벤트로 따라가고(그리드에 메인의 브라우저를 그린다), 변경은
//                메인에 위임한다(browsers://cmd) — stores/terminals.ts의 terminals://cmd와 같은 구조
//  - other     : 분리한 브라우저 창 등 — 자기 항목은 로컬에만, 북마크만 메인에 위임
type BrowserWindowRole = "main" | "aggregate" | "other";
/** 이 창의 라벨 — 백엔드 browser://host 와 비교해 "다른 창이 webview를 가졌다"를 판정한다. */
export const THIS_WINDOW_LABEL = (() => {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "main";
  }
})();
const ROLE: BrowserWindowRole =
  THIS_WINDOW_LABEL === "main" ? "main" : THIS_WINDOW_LABEL === "aggregate" ? "aggregate" : "other";

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

/** 보조 창이 메인에 내리는 브라우저 변경 명령 — 스토어 액션과 1:1. */
type BrowsersCmd =
  | {
      op: "openBrowser";
      id: string;
      projectId: string;
      url: string;
      preview?: PreviewSource;
      title?: string;
    }
  | { op: "closeBrowser"; id: string }
  | { op: "setUrl"; id: string; url: string }
  | { op: "ensurePane"; id: string; projectId: string; url: string }
  | { op: "setBookmark"; url: string; title: string; on: boolean };

const sendBrowsersCmd = (cmd: BrowsersCmd) =>
  void emitTo("main", "browsers://cmd", cmd).catch((e) =>
    console.error("메인 위임 실패:", e),
  );

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
  /** id별 네이티브 webview를 가진 창 라벨(백엔드 browser://host, 전이 상태). 빈 문자열 = 어느 창에도 없음. */
  host: Record<string, string>;
  /** 독립 브라우저 탭 생성 — 반환 id가 activeTab 슬롯에 들어간다.
   *  preview를 주면 로컬 HTML 프리뷰 탭으로 표시돼 재시작 시 URL을 재발급받는다.
   *  opts.id는 보조 창의 위임이 쓴다(같은 id가 storage로 돌아온다), activate:false면 메인의 활성 탭을 그대로 둔다. */
  openBrowser: (
    projectId: string,
    url?: string,
    preview?: PreviewSource,
    opts?: { id?: string; title?: string; activate?: boolean },
  ) => string;
  closeBrowser: (id: string) => void;
  /** 다른 창에서 넘겨받은 항목을 이 창 스토어에 넣는다(분리한 브라우저 창 — 이 창은 저장하지 않는다). */
  adoptItem: (item: BrowserItem) => void;
  setHost: (id: string, window: string) => void;
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
  /** 북마크를 그 상태로 맞춘다(on=true면 맨 앞에 추가). 토글과 보조 창 위임이 쓴다. */
  setBookmark: (url: string, title: string, on: boolean) => void;
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
    return new URL(url).host || currentMessages().stores.browser.newBrowserTitle;
  } catch {
    return currentMessages().stores.browser.newBrowserTitle;
  }
}

function makeItem(id: string, projectId: string, url: string): BrowserItem {
  return {
    id,
    projectId,
    title: url ? hostTitle(url) : currentMessages().stores.browser.newBrowserTitle,
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
  host: {},

  openBrowser: (projectId, url = "", preview, opts) => {
    const id = opts?.id ?? crypto.randomUUID();
    if (ROLE === "aggregate") {
      sendBrowsersCmd({ op: "openBrowser", id, projectId, url, preview, title: opts?.title });
      return id; // 호출부는 이 id로 그리드에 넣는다 — 같은 id가 storage로 돌아온다
    }
    const item = { ...makeItem(id, projectId, url), preview };
    if (opts?.title) item.title = opts.title;
    set((s) => ({ items: { ...s.items, [id]: item }, tabIds: [...s.tabIds, id] }));
    if (opts?.activate !== false) useTerminals.getState().setActiveTab(projectId, id);
    return id;
  },

  // tabIds에도 넣는다 — 그래야 패널이 언마운트될 때(StrictMode 이중 마운트 포함) releaseBrowser가 "아직 참조
  // 중"으로 보고 숨기기만 한다. 빠지면 이 창이 막 넘겨받은 webview를 닫아 버린다.
  adoptItem: (item) =>
    set((s) => ({
      items: { ...s.items, [item.id]: item },
      tabIds: s.tabIds.includes(item.id) ? s.tabIds : [...s.tabIds, item.id],
    })),

  setHost: (id, window) =>
    set((s) => (s.host[id] === window ? s : { host: { ...s.host, [id]: window } })),

  closeBrowser: (id) => {
    if (ROLE === "aggregate") return sendBrowsersCmd({ op: "closeBrowser", id });
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

  ensurePane: (id, projectId, url = "") => {
    // 모아보기 창은 메인 스토어를 따라가므로 메인에도 만든다 — 로컬에만 두면 다음 storage 반영에 사라진다.
    if (ROLE === "aggregate" && !get().items[id])
      sendBrowsersCmd({ op: "ensurePane", id, projectId, url });
    set((s) =>
      s.items[id]
        ? s
        : { items: { ...s.items, [id]: makeItem(id, projectId, url) } },
    );
  },

  removePane: (id) =>
    set((s) => {
      if (!s.items[id]) return s;
      const items = { ...s.items };
      delete items[id];
      const loading = { ...s.loading };
      delete loading[id];
      return { items, loading };
    }),

  // 모아보기 창은 로컬에 쓰지 않고 메인 결과(storage)를 기다린다 — 로컬에 먼저 쓰면 메인이 그 명령을 받기 전에
  // 저장한 낡은 값이 storage로 와 주소를 되돌리고, BrowserPane이 옛 주소로 한 번 더 navigate한다.
  setUrl: (id, url) => {
    if (ROLE === "aggregate") return sendBrowsersCmd({ op: "setUrl", id, url });
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
    );
  },

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
      // 모르는 id = 다른 창(분리한 브라우저 창)이 자기 스토어에만 둔 브라우저다. browser://nav는 모든 창에
      // 오므로 방문 기록만은 남긴다 — 기록은 메인이 저장하는 공용 자료다.
      if (!item)
        return {
          loading: { ...s.loading, [id]: p.loading },
          history: p.url ? pushHistory(s.history, p.url) : s.history,
        };
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

  toggleBookmark: (url, title) => {
    if (!url) return;
    const on = !get().bookmarks.some((b) => b.url === url);
    // 북마크는 메인이 저장하는 공용 자료다. 토글이 아니라 결과 상태를 보낸다 — 이 창의 사본이 낡았으면
    // 메인에서 반대로 뒤집힌다.
    if (ROLE !== "main") sendBrowsersCmd({ op: "setBookmark", url, title, on });
    // 모아보기 창은 storage로 메인 결과를 받는다(setUrl과 같은 이유로 로컬에 먼저 쓰지 않는다).
    if (ROLE !== "aggregate") get().setBookmark(url, title, on);
  },

  setBookmark: (url, title, on) =>
    set((s) => {
      const rest = s.bookmarks.filter((b) => b.url !== url);
      return { bookmarks: on ? [{ url, title: title || url }, ...rest] : rest };
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
// 메인 창만 쓴다(위 ROLE 주석) — 보조 창이 스테일 스냅샷으로 덮지 않게.
if (ROLE === "main")
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

// 보조 창(모아보기·분리한 브라우저 창)이 보낸 변경을 메인이 대신 실행한다 — 저장하는 창이 메인뿐이라
// 변경도 메인이 해야 영속되고 storage로 다른 창에 퍼진다. 모아보기에서 연 탭은 메인의 활성 탭을 바꾸지
// 않는다(메인이 그 탭을 보이려 들면 webview를 두 창이 다툰다).
if (ROLE === "main")
  void listen<BrowsersCmd>("browsers://cmd", ({ payload: c }) => {
    const bs = useBrowsers.getState();
    if (c.op === "openBrowser")
      bs.openBrowser(c.projectId, c.url, c.preview, { id: c.id, title: c.title, activate: false });
    else if (c.op === "closeBrowser") bs.closeBrowser(c.id);
    else if (c.op === "setUrl") bs.setUrl(c.id, c.url);
    else if (c.op === "ensurePane") bs.ensurePane(c.id, c.projectId, c.url);
    else if (c.op === "setBookmark") bs.setBookmark(c.url, c.title, c.on);
    else {
      const never: never = c;
      console.error("알 수 없는 브라우저 위임:", never);
    }
  });

// 모아보기 창은 메인이 저장한 것을 따라간다 — storage 이벤트는 **다른 창**에서만 발화한다
// (stores/terminals.ts의 같은 구독과 짝).
if (ROLE === "aggregate")
  window.addEventListener("storage", (e) => {
    if (e.key !== PERSIST_KEY || !e.newValue) return;
    try {
      const p = JSON.parse(e.newValue) as Partial<Persisted>;
      useBrowsers.setState({
        items: p.items && typeof p.items === "object" ? p.items : {},
        tabIds: Array.isArray(p.tabIds) ? p.tabIds : [],
        history: Array.isArray(p.history) ? p.history : [],
        bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
      });
    } catch (err) {
      console.error("gp:browser 따라가기 실패:", err);
    }
  });
