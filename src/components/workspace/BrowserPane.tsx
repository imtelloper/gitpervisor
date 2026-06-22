import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CornerUpLeft,
  Globe,
  Lock,
  Plug,
  RotateCw,
  Star,
  Unlock,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  back,
  blurBrowser,
  type Bounds,
  ensureBrowserEvents,
  forward,
  isBrowserCreated,
  navigate,
  openBrowser,
  releaseBrowser,
  reload,
  scanDevPorts,
  setBounds,
  setVisible,
  stop,
} from "../../lib/browser";
import {
  type BookmarkEntry,
  type BrowserItem,
  resolveOmnibox,
  useBrowsers,
} from "../../stores/browser";
import { useDb } from "../../stores/db";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { Favicon } from "./Favicon";

interface Suggestion {
  url: string;
  title: string;
  bookmarked: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function rectOf(el: HTMLElement | null): Bounds {
  if (!el) return { x: 0, y: 0, width: 0, height: 0 };
  const r = el.getBoundingClientRect();
  // CSS(logical) 픽셀을 그대로 — Tauri Logical 단위와 1:1 (devicePixelRatio 곱 금지).
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const EMPTY_ITEM: BrowserItem = {
  id: "",
  projectId: "",
  title: "새 브라우저",
  url: "",
  mode: "native",
};

/**
 * 브라우저 패널 — 독립 탭과 분할 패널 양쪽에서 재사용. 외부 URL은 네이티브 자식 webview,
 * localhost는 <iframe>. `active`는 호출자가 계산한 "차단 모달이 없으면 보여야 하는가" 신호다
 * (탭=활성탭 여부, 패널=다른 패널 maximize/분할드래그 아님).
 */
export function BrowserPane({
  id,
  active,
  paneControls,
}: {
  id: string;
  active: boolean;
  paneControls?: React.ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const item = useBrowsers((s) => s.items[id]) ?? EMPTY_ITEM;
  const url = item.url;
  const mode = item.mode;
  const setUrl = useBrowsers((s) => s.setUrl);
  const loading = useBrowsers((s) => s.loading[id] ?? false);
  const history = useBrowsers((s) => s.history);
  const bookmarks = useBrowsers((s) => s.bookmarks);
  const toggleBookmark = useBrowsers((s) => s.toggleBookmark);
  const isBookmarked = bookmarks.some((b) => b.url === url);

  // 점유(occlusion) 조건 — active(호출자) & 네이티브 & URL 있음 & 차단성 모달 없음
  const settingsOpen = useUi((s) => s.settingsOpen);
  const memoOpen = useUi((s) => s.memoOpen);
  const confirm = useUi((s) => s.confirm);
  const dbDialog = useDb((s) => s.dialog);

  const shouldShow =
    active && mode === "native" && !!url && !settingsOpen && !memoOpen && !confirm && !dbDialog;

  // 안정 리스너에서 최신 shouldShow를 읽기 위한 ref
  const shouldShowRef = useRef(shouldShow);
  shouldShowRef.current = shouldShow;

  // 주소창 입력 로컬 상태 (미포커스 시 url을 따라감)
  const [draft, setDraft] = useState(url);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(-1); // 자동완성 선택 인덱스 (-1=입력값 사용)
  useEffect(() => {
    if (!focused) setDraft(url);
  }, [url, focused]);
  useEffect(() => setSel(-1), [draft]);

  // 옴니박스 자동완성 — 북마크(우선) + 방문기록 합쳐 substring 매칭(최대 6)
  const q = draft.trim().toLowerCase();
  const matches: Suggestion[] = (() => {
    if (!focused || !q || q === url.toLowerCase()) return [];
    const bm: Suggestion[] = bookmarks.map((b) => ({ ...b, bookmarked: true }));
    const seen = new Set(bm.map((b) => b.url));
    const hist: Suggestion[] = history
      .filter((h) => !seen.has(h.url))
      .map((h) => ({ ...h, bookmarked: false }));
    return [...bm, ...hist]
      .filter(
        (x) =>
          x.url.toLowerCase().includes(q) || x.title.toLowerCase().includes(q),
      )
      .slice(0, 6);
  })();

  // 모듈 1회 이벤트 구독
  useEffect(() => {
    ensureBrowserEvents();
  }, []);

  // 언마운트 정리 — 여전히 참조되면 hide(탭 전환), 아니면 dispose(닫힘/터미널 전환)
  useEffect(() => {
    return () => releaseBrowser(id);
  }, [id]);

  // 생성/네비게이션 (네이티브 · 활성일 때만 lazy 생성)
  const prevUrlRef = useRef("");
  useEffect(() => {
    if (mode !== "native" || !url || !active) return;
    if (!isBrowserCreated(id)) {
      void openBrowser(id, url, rectOf(viewportRef.current));
      prevUrlRef.current = url;
    } else if (prevUrlRef.current !== url) {
      navigate(id, url);
      prevUrlRef.current = url;
    }
  }, [id, mode, url, active]);

  // 표시/숨김 (점유 제어). iframe 모드면 네이티브는 항상 hide.
  useEffect(() => {
    if (mode !== "native") {
      if (isBrowserCreated(id)) void setVisible(id, false);
      return;
    }
    if (shouldShow) void setVisible(id, true, rectOf(viewportRef.current));
    else void setVisible(id, false);
  }, [shouldShow, mode, id]);

  // bounds 동기화 — 콘텐츠 rect 변화가 단일 진실(ResizeObserver). LogPanel/FileTree/분할
  // 토글 등 모든 리플로우는 viewport 크기를 바꾸므로 여기서 잡힌다.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const sync = () => {
      if (mode === "native" && isBrowserCreated(id)) setBounds(id, rectOf(el));
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, mode]);

  // 창 리사이즈 jank 차단 — 리사이즈 중엔 hide, 멈추면 show+bounds(보일 조건일 때만)
  useEffect(() => {
    if (mode !== "native") return;
    let t: number | undefined;
    const onResize = () => {
      if (!shouldShowRef.current) return;
      void setVisible(id, false);
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (shouldShowRef.current) void setVisible(id, true, rectOf(viewportRef.current));
      }, 160);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, [id, mode]);

  const go = (raw: string) => {
    const resolved = resolveOmnibox(raw);
    if (!resolved) return;
    setUrl(id, resolved);
    inputRef.current?.blur();
  };

  const secure = url.startsWith("https://");
  const hasUrl = !!url;

  return (
    <div className="flex h-full w-full flex-col bg-base">
      {/* 컨트롤 바 — 항상 React DOM (네이티브 webview bounds는 이 아래 viewport로만 한정) */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge px-2">
        <NavBtn label="뒤로" onClick={() => back(id)} disabled={!hasUrl}>
          <ArrowLeft size={15} />
        </NavBtn>
        <NavBtn label="앞으로" onClick={() => forward(id)} disabled={!hasUrl}>
          <ArrowRight size={15} />
        </NavBtn>
        <NavBtn
          label={loading ? "정지" : "새로고침"}
          onClick={() => (loading ? stop(id) : reload(id))}
          disabled={!hasUrl}
        >
          {loading ? <X size={15} /> : <RotateCw size={15} />}
        </NavBtn>

        <div className="relative mx-1 min-w-0 flex-1">
          <div className="flex h-7 items-center gap-1.5 rounded bg-raised px-2 text-xs focus-within:outline focus-within:outline-1 focus-within:outline-accent">
            {secure ? (
              <Lock size={12} className="shrink-0 text-add" />
            ) : (
              <Unlock size={12} className="shrink-0 text-fg-dim" />
            )}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => {
                setFocused(true);
                e.target.select();
              }}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  go(sel >= 0 && matches[sel] ? matches[sel].url : draft);
                } else if (e.key === "ArrowDown" && matches.length) {
                  e.preventDefault();
                  setSel((i) => (i + 1) % matches.length);
                } else if (e.key === "ArrowUp" && matches.length) {
                  e.preventDefault();
                  setSel((i) => (i <= 0 ? matches.length - 1 : i - 1));
                } else if (e.key === "Escape") {
                  setDraft(url);
                  inputRef.current?.blur();
                }
              }}
              placeholder="URL 입력 또는 검색…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-fg-dim"
            />
          </div>
          {matches.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-edge bg-panel py-1 shadow-xl">
              {matches.map((m, i) => (
                <button
                  key={m.url}
                  // onMouseDown(blur보다 먼저) 으로 선택 — onBlur가 닫기 전에 처리
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(m.url);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                    i === sel ? "bg-raised text-fg" : "text-fg-muted hover:bg-raised"
                  }`}
                >
                  {m.bookmarked ? (
                    <Star size={12} className="shrink-0 fill-accent text-accent" />
                  ) : (
                    <Globe size={12} className="shrink-0 text-fg-dim" />
                  )}
                  <span className="truncate">{m.title || m.url}</span>
                  <span className="ml-auto shrink-0 truncate text-[11px] text-fg-dim">
                    {hostOf(m.url)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {hasUrl && (
          <NavBtn
            label={isBookmarked ? "북마크 제거" : "북마크 추가"}
            onClick={() => toggleBookmark(url, item.title)}
          >
            <Star
              size={15}
              className={isBookmarked ? "fill-accent text-accent" : ""}
            />
          </NavBtn>
        )}
        {mode === "native" && hasUrl && (
          <NavBtn label="앱으로 포커스 (단축키 복귀)" onClick={() => blurBrowser()}>
            <CornerUpLeft size={15} />
          </NavBtn>
        )}
        <BookmarksMenu bookmarks={bookmarks} onPick={(u) => go(u)} />
        <DevPorts onPick={(u) => go(u)} />
        {paneControls && (
          <>
            <div className="mx-0.5 h-5 w-px shrink-0 bg-edge" />
            {paneControls}
          </>
        )}
      </div>

      {/* 로딩 바 */}
      <div className="relative h-0.5 shrink-0 overflow-hidden">
        {loading && <div className="absolute inset-y-0 left-0 w-full animate-pulse bg-accent" />}
      </div>

      {/* 뷰포트 — 네이티브 webview가 이 사각형에 bounds-clip (localhost면 iframe) */}
      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-base">
        {!hasUrl ? (
          <BrowserEmpty onPick={(u) => go(u)} bookmarks={bookmarks} />
        ) : mode === "iframe" ? (
          <iframe
            title={item.title}
            src={url}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          />
        ) : (
          // 네이티브 모드: webview가 위를 덮는다. 숨겨질 때 보이는 중립 배경.
          <div className="flex h-full w-full items-center justify-center text-xs text-fg-dim">
            {!active && "다른 곳에서 표시 중…"}
          </div>
        )}
      </div>
    </div>
  );
}

function NavBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className="shrink-0 rounded p-1.5 text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/** localhost dev 서버 빠른 접속 드롭다운 — 감지된 포트만 노출. */
function DevPorts({ onPick }: { onPick: (url: string) => void }) {
  const [ports, setPorts] = useState<number[] | null>(null);
  const [open, setOpen] = useState(false);

  const scan = async () => {
    setOpen(true);
    setPorts(null);
    setPorts(await scanDevPorts());
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => (open ? setOpen(false) : void scan())}
        title="개발 서버 빠른 접속"
        className="rounded p-1.5 text-fg-dim hover:bg-raised hover:text-fg"
      >
        <Plug size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 min-w-44 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl">
            {ports === null ? (
              <div className="px-3 py-1.5 text-fg-dim">검색 중…</div>
            ) : ports.length === 0 ? (
              <div className="px-3 py-1.5 text-fg-dim">감지된 개발 서버 없음</div>
            ) : (
              ports.map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    onPick(`http://localhost:${p}`);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-add" />
                  localhost:{p}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 북마크 드롭다운 — 저장된 북마크 목록, 클릭 시 이동. */
function BookmarksMenu({
  bookmarks,
  onPick,
}: {
  bookmarks: BookmarkEntry[];
  onPick: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="북마크"
        className="rounded p-1.5 text-fg-dim hover:bg-raised hover:text-fg"
      >
        <Bookmark size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 max-h-80 min-w-56 overflow-auto rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl">
            {bookmarks.length === 0 ? (
              <div className="px-3 py-1.5 text-fg-dim">
                북마크 없음 — 주소창의 ★로 추가
              </div>
            ) : (
              bookmarks.map((b) => (
                <button
                  key={b.url}
                  onClick={() => {
                    onPick(b.url);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
                >
                  <Favicon url={b.url} size={13} />
                  <span className="truncate">{b.title || b.url}</span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function BrowserEmpty({
  onPick,
  bookmarks,
}: {
  onPick: (url: string) => void;
  bookmarks: BookmarkEntry[];
}) {
  const [ports, setPorts] = useState<number[]>([]);
  useEffect(() => {
    void scanDevPorts().then(setPorts);
  }, []);

  return (
    <EmptyState
      icon={Globe}
      title="주소를 입력하거나 검색하세요"
      desc="위 주소창에 URL을 넣으면 바로 열리고, 검색어를 넣으면 Google에서 찾아봅니다"
      action={
        <div className="flex max-w-md flex-wrap justify-center gap-2">
          {bookmarks.slice(0, 8).map((b) => (
            <button
              key={b.url}
              onClick={() => onPick(b.url)}
              title={b.url}
              className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
            >
              <Favicon url={b.url} size={12} />
              <span className="max-w-32 truncate">{b.title || b.url}</span>
            </button>
          ))}
          {ports.map((p) => (
            <button
              key={p}
              onClick={() => onPick(`http://localhost:${p}`)}
              className="rounded border border-edge px-3 py-1.5 text-xs text-fg-muted hover:bg-raised hover:text-fg"
            >
              localhost:{p} 열기
            </button>
          ))}
        </div>
      }
    />
  );
}
