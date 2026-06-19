import {
  ArrowLeft,
  ArrowRight,
  CornerUpLeft,
  Globe,
  Lock,
  Plug,
  RotateCw,
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
  reload,
  scanDevPorts,
  setBounds,
  setVisible,
  stop,
} from "../../lib/browser";
import {
  type HistoryEntry,
  resolveOmnibox,
  useBrowsers,
  type BrowserTab,
} from "../../stores/browser";
import { useDb } from "../../stores/db";
import { useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";

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

/** 단일 브라우저 탭 — 외부 URL은 네이티브 자식 webview, localhost는 <iframe>. */
export function BrowserPane({ tab }: { tab: BrowserTab }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const setUrl = useBrowsers((s) => s.setUrl);
  const loading = useBrowsers((s) => s.loading[tab.id] ?? false);
  const history = useBrowsers((s) => s.history);

  // 점유(occlusion) 조건 — 활성 탭 & 차단성 모달 없음
  const active = useTerminals((s) => s.activeTab[tab.projectId]) === tab.id;
  const settingsOpen = useUi((s) => s.settingsOpen);
  const memoOpen = useUi((s) => s.memoOpen);
  const confirm = useUi((s) => s.confirm);
  const dbDialog = useDb((s) => s.dialog);

  const shouldShow =
    active && tab.mode === "native" && !!tab.url && !settingsOpen && !memoOpen && !confirm && !dbDialog;

  // 안정 리스너에서 최신 shouldShow를 읽기 위한 ref
  const shouldShowRef = useRef(shouldShow);
  shouldShowRef.current = shouldShow;

  // 주소창 입력 로컬 상태 (미포커스 시 tab.url을 따라감)
  const [draft, setDraft] = useState(tab.url);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(-1); // 자동완성 선택 인덱스 (-1=입력값 사용)
  useEffect(() => {
    if (!focused) setDraft(tab.url);
  }, [tab.url, focused]);
  useEffect(() => setSel(-1), [draft]);

  // 옴니박스 자동완성 후보 — 방문기록에서 substring 매칭(최대 6)
  const q = draft.trim().toLowerCase();
  const matches: HistoryEntry[] =
    focused && q && q !== tab.url.toLowerCase()
      ? history
          .filter(
            (h) =>
              h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q),
          )
          .slice(0, 6)
      : [];

  // 모듈 1회 이벤트 구독
  useEffect(() => {
    ensureBrowserEvents();
  }, []);

  // 생성/네비게이션 (네이티브 · 활성일 때만 lazy 생성)
  const prevUrlRef = useRef("");
  useEffect(() => {
    if (tab.mode !== "native" || !tab.url || !active) return;
    if (!isBrowserCreated(tab.id)) {
      void openBrowser(tab.id, tab.url, rectOf(viewportRef.current));
      prevUrlRef.current = tab.url;
    } else if (prevUrlRef.current !== tab.url) {
      navigate(tab.id, tab.url);
      prevUrlRef.current = tab.url;
    }
  }, [tab.id, tab.mode, tab.url, active]);

  // 표시/숨김 (점유 제어). iframe 모드면 네이티브는 항상 hide.
  useEffect(() => {
    if (tab.mode !== "native") {
      if (isBrowserCreated(tab.id)) void setVisible(tab.id, false);
      return;
    }
    if (shouldShow) void setVisible(tab.id, true, rectOf(viewportRef.current));
    else void setVisible(tab.id, false);
  }, [shouldShow, tab.mode, tab.id]);

  // bounds 동기화 — 콘텐츠 rect 변화가 단일 진실(ResizeObserver). LogPanel/FileTree
  // 토글 등 모든 리플로우는 viewport 크기를 바꾸므로 여기서 잡힌다.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const sync = () => {
      if (tab.mode === "native" && isBrowserCreated(tab.id)) setBounds(tab.id, rectOf(el));
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab.id, tab.mode]);

  // 창 리사이즈 jank 차단 — 리사이즈 중엔 hide, 멈추면 show+bounds(보일 조건일 때만)
  useEffect(() => {
    if (tab.mode !== "native") return;
    let t: number | undefined;
    const onResize = () => {
      if (!shouldShowRef.current) return;
      void setVisible(tab.id, false);
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (shouldShowRef.current) void setVisible(tab.id, true, rectOf(viewportRef.current));
      }, 160);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, [tab.id, tab.mode]);

  const go = (raw: string) => {
    const url = resolveOmnibox(raw);
    if (!url) return;
    setUrl(tab.id, url);
    inputRef.current?.blur();
  };

  const secure = tab.url.startsWith("https://");
  const hasUrl = !!tab.url;

  return (
    <div className="flex h-full w-full flex-col bg-base">
      {/* 컨트롤 바 — 항상 React DOM (네이티브 webview bounds는 이 아래 viewport로만 한정) */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge px-2">
        <NavBtn label="뒤로" onClick={() => back(tab.id)} disabled={!hasUrl}>
          <ArrowLeft size={15} />
        </NavBtn>
        <NavBtn label="앞으로" onClick={() => forward(tab.id)} disabled={!hasUrl}>
          <ArrowRight size={15} />
        </NavBtn>
        <NavBtn
          label={loading ? "정지" : "새로고침"}
          onClick={() => (loading ? stop(tab.id) : reload(tab.id))}
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
                  setDraft(tab.url);
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
                  <Globe size={12} className="shrink-0 text-fg-dim" />
                  <span className="truncate">{m.title || m.url}</span>
                  <span className="ml-auto shrink-0 truncate text-[11px] text-fg-dim">
                    {hostOf(m.url)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {tab.mode === "native" && hasUrl && (
          <NavBtn label="앱으로 포커스 (단축키 복귀)" onClick={() => blurBrowser()}>
            <CornerUpLeft size={15} />
          </NavBtn>
        )}
        <DevPorts onPick={(url) => go(url)} />
      </div>

      {/* 로딩 바 */}
      <div className="relative h-0.5 shrink-0 overflow-hidden">
        {loading && <div className="absolute inset-y-0 left-0 w-full animate-pulse bg-accent" />}
      </div>

      {/* 뷰포트 — 네이티브 webview가 이 사각형에 bounds-clip (localhost면 iframe) */}
      <div ref={viewportRef} className="relative min-h-0 flex-1 bg-base">
        {!hasUrl ? (
          <BrowserEmpty onPick={(url) => go(url)} />
        ) : tab.mode === "iframe" ? (
          <iframe
            title={tab.title}
            src={tab.url}
            className="h-full w-full border-0 bg-white"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
          />
        ) : (
          // 네이티브 모드: webview가 위를 덮는다. 숨겨질 때 보이는 중립 배경.
          <div className="flex h-full w-full items-center justify-center text-xs text-fg-dim">
            {!active && "다른 탭에서 표시 중…"}
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

function BrowserEmpty({ onPick }: { onPick: (url: string) => void }) {
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
        <div className="flex flex-wrap justify-center gap-2">
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
