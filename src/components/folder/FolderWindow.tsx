import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  Film,
  Folder,
  FolderOpen,
  FolderSearch,
  Image as ImageIcon,
  LayoutGrid,
  List,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { copyText } from "../../lib/clipboard";
import { ipc, type FavEntry } from "../../lib/ipc";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { Toasts } from "../common/Toast";
import { FloatTitleBar } from "../FloatTitleBar";

/**
 * 즐겨찾기 폴더 창 (태스크 66) — 스크린샷·다운로드 폴더를 빠르게 훑어보는 창.
 *
 * 파일 뷰어 창(`doc-*`)의 인프라를 그대로 쓴다(`lib/floating.ts` openFolderWindow). 이 창은
 * **프로젝트에 속하지 않는다** — 모든 경로가 절대경로이고, 백엔드가 `Settings.favoriteFolders`
 * 아래인지 매 호출마다 검사한다(commands/favorites.rs `allowed`).
 *
 * 원본 이미지를 목록에 그리지 않는다. 이 앱엔 asset protocol 이 없어 이미지가 base64 로 IPC 를
 * 타므로(`tauri.conf.json` csp), 스크린샷 수백 장을 원본으로 보내면 창이 그대로 죽는다.
 * 그래서 백엔드가 캐시된 썸네일(JPEG)을 주고, 그것도 **화면에 보이는 칸만** 요청한다.
 */
export default function FolderWindow({ root }: { root: string }) {
  const SEP = root.includes("\\") ? "\\" : "/";
  const join = useCallback(
    (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}${SEP}${name}`,
    [SEP],
  );

  const [dir, setDir] = useState(root);
  const [entries, setEntries] = useState<FavEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState(() => readView(root));
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FavEntry } | null>(
    null,
  );

  useEffect(() => writeView(root, view), [root, view]);

  const load = useCallback(async () => {
    try {
      const list = await ipc.favList(dir);
      setEntries(list);
      setError(null);
    } catch (e) {
      setEntries([]);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [dir]);

  useEffect(() => {
    setEntries(null);
    setCursor(0);
    void load();
  }, [load]);

  // **창에 포커스가 돌아오면 다시 읽는다.** 스크린샷은 이 창이 뒤에 있을 때 찍히고, 보려면
  // 이 창을 클릭한다 — 그 클릭이 곧 갱신 신호다. 파일 워처를 거는 것보다 정확히 필요한 만큼이다.
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) void load();
      })
      .then((f) => (disposed ? f() : (un = f)));
    return () => {
      disposed = true;
      un?.();
    };
  }, [load]);

  /** 화면에 그릴 목록 — 필터 → 정렬. 폴더는 언제나 위. */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (entries ?? []).filter(
      (e) =>
        (!q || e.name.toLowerCase().includes(q)) &&
        (!view.imagesOnly || e.isDir || e.kind === "image"),
    );
    const dirFirst = (a: FavEntry, b: FavEntry) =>
      a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1;
    return list.sort((a, b) => {
      const d = dirFirst(a, b);
      if (d) return d;
      if (view.sort === "name") return a.name.localeCompare(b.name);
      if (view.sort === "size") return b.size - a.size;
      return b.mtimeMs - a.mtimeMs; // 기본: 최신 먼저
    });
  }, [entries, query, view.imagesOnly, view.sort]);

  /** 라이트박스가 넘나드는 순서 = **지금 보이는 순서의 이미지들**(태스크 56 규약). */
  const images = useMemo(() => shown.filter((e) => e.kind === "image"), [shown]);

  const openEntry = useCallback(
    (e: FavEntry) => {
      if (e.isDir) {
        setDir(join(dir, e.name));
        return;
      }
      if (e.kind === "image") {
        const i = images.findIndex((x) => x.name === e.name);
        if (i >= 0) {
          setLightbox(i);
          return;
        }
      }
      void ipc.favOpen(join(dir, e.name), "default").catch((err) =>
        useUi.getState().pushToast("error", `열지 못했습니다 — ${msg(err)}`),
      );
    },
    [dir, images, join],
  );

  const goUp = useCallback(() => {
    if (dir.replace(/[\\/]+$/, "") === root.replace(/[\\/]+$/, "")) return;
    const cut = dir.replace(/[\\/]+$/, "").lastIndexOf(SEP);
    if (cut > 0) setDir(dir.slice(0, cut));
  }, [dir, root, SEP]);

  const copyPath = useCallback(
    (e: FavEntry) => {
      void copyText(join(dir, e.name)).then((ok) =>
        useUi
          .getState()
          .pushToast(ok ? "success" : "error", ok ? "경로를 복사했습니다" : "복사에 실패했습니다"),
      );
    },
    [dir, join],
  );

  /** 메인 창의 활성 터미널에 경로를 넣는다 — 스크린샷을 Claude 프롬프트에 붙이는 그 동선.
   *  이 창엔 터미널이 없으므로 이벤트로 넘긴다(App.tsx 가 받는다). */
  const pastePath = useCallback(
    (e: FavEntry) => {
      void emit("fav:paste-path", { path: join(dir, e.name) });
    },
    [dir, join],
  );

  // ---- 키보드 ----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const typing =
        ev.target instanceof HTMLInputElement ||
        ev.target instanceof HTMLTextAreaElement;
      if (lightbox !== null) {
        if (ev.key === "Escape") setLightbox(null);
        else if (ev.key === "ArrowRight")
          setLightbox((i) => Math.min((i ?? 0) + 1, images.length - 1));
        else if (ev.key === "ArrowLeft") setLightbox((i) => Math.max((i ?? 0) - 1, 0));
        else return;
        ev.preventDefault();
        return;
      }
      if (ev.key === "F5") {
        ev.preventDefault();
        void load();
        return;
      }
      if (typing) return;
      if (ev.ctrlKey && ev.key >= "1" && ev.key <= "4") {
        ev.preventDefault();
        setView((v) => ({ ...v, mode: MODES[Number(ev.key) - 1].id }));
        return;
      }
      if (ev.ctrlKey && ev.key.toLowerCase() === "c") {
        const e = shown[cursor];
        if (e) {
          ev.preventDefault();
          copyPath(e);
        }
        return;
      }
      if (ev.key === "Backspace") {
        ev.preventDefault();
        goUp();
        return;
      }
      if (ev.key === "Enter") {
        const e = shown[cursor];
        if (e) {
          ev.preventDefault();
          openEntry(e);
        }
        return;
      }
      const step =
        ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
      const row = ev.key === "ArrowDown" ? 1 : ev.key === "ArrowUp" ? -1 : 0;
      if (!step && !row) return;
      ev.preventDefault();
      // 목록 모드는 ←→도 한 칸씩(열이 하나라 위아래와 같다).
      const delta = step || row * (view.mode === "list" ? 1 : 0) || row;
      setCursor((c) => Math.max(0, Math.min(shown.length - 1, c + delta)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, images.length, shown, cursor, view.mode, load, goUp, openEntry, copyPath]);

  const crumbs = useMemo(() => {
    const rootName = root.replace(/[\\/]+$/, "").split(SEP).filter(Boolean).pop() ?? root;
    const rest = dir
      .slice(root.replace(/[\\/]+$/, "").length)
      .split(SEP)
      .filter(Boolean);
    return [rootName, ...rest];
  }, [dir, root, SEP]);

  return (
    <div className="flex h-screen flex-col bg-base" onClick={() => setMenu(null)}>
      <FloatTitleBar title={crumbs[crumbs.length - 1] ?? root} badge="폴더" />

      <Toolbar
        crumbs={crumbs}
        onCrumb={(i) =>
          setDir(
            i === 0
              ? root
              : join(root, crumbs.slice(1, i + 1).join(SEP)),
          )
        }
        query={query}
        setQuery={setQuery}
        view={view}
        setView={setView}
        onRefresh={() => void load()}
        onReveal={() =>
          void ipc.favOpen(dir, "reveal").catch(() => {
            useUi.getState().pushToast("error", "탐색기를 열지 못했습니다");
          })
        }
        count={shown.length}
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <EmptyState
            icon={FolderSearch}
            title="폴더를 읽지 못했습니다"
            desc={error}
          />
        ) : entries === null ? (
          <div className="p-4 text-xs text-fg-dim">읽는 중…</div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Folder}
            title={query || view.imagesOnly ? "조건에 맞는 항목이 없습니다" : "빈 폴더입니다"}
            desc={
              query || view.imagesOnly
                ? "검색어나 '이미지만' 필터를 지우면 전체가 보입니다."
                : "이 폴더에 표시할 파일이 없습니다."
            }
          />
        ) : view.mode === "list" ? (
          <ListView
            items={shown}
            cursor={cursor}
            onCursor={setCursor}
            onOpen={openEntry}
            onMenu={(x, y, e) => setMenu({ x, y, entry: e })}
          />
        ) : (
          <GridView
            items={shown}
            dir={dir}
            join={join}
            edge={EDGE[view.mode]}
            cursor={cursor}
            onCursor={setCursor}
            onOpen={openEntry}
            onMenu={(x, y, e) => setMenu({ x, y, entry: e })}
          />
        )}
      </div>

      {menu && (
        <ItemMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          onClose={() => setMenu(null)}
          onCopyPath={() => copyPath(menu.entry)}
          onPastePath={() => pastePath(menu.entry)}
          onOpen={() =>
            void ipc.favOpen(join(dir, menu.entry.name), "default").catch(() => {
              useUi.getState().pushToast("error", "열지 못했습니다");
            })
          }
          onReveal={() =>
            void ipc.favOpen(join(dir, menu.entry.name), "reveal").catch(() => {
              useUi.getState().pushToast("error", "탐색기를 열지 못했습니다");
            })
          }
        />
      )}

      {lightbox !== null && images[lightbox] && (
        <Lightbox
          path={join(dir, images[lightbox].name)}
          name={images[lightbox].name}
          index={lightbox}
          total={images.length}
          onClose={() => setLightbox(null)}
          onStep={(d) =>
            setLightbox((i) => Math.max(0, Math.min(images.length - 1, (i ?? 0) + d)))
          }
        />
      )}

      <Toasts />
    </div>
  );
}

// ---- 보기 상태 (폴더별 기억) ---------------------------------------------------------

const MODES = [
  { id: "grid-s", Icon: LayoutGrid, title: "작은 썸네일 (Ctrl+1)" },
  { id: "grid-m", Icon: LayoutGrid, title: "중간 썸네일 (Ctrl+2)" },
  { id: "grid-l", Icon: LayoutGrid, title: "큰 썸네일 (Ctrl+3)" },
  { id: "list", Icon: List, title: "목록 (Ctrl+4)" },
] as const;
type Mode = (typeof MODES)[number]["id"];
/** 썸네일 한 변 — 백엔드가 **이 셋만** 받는다(캐시 폭주 방지). */
const EDGE: Record<Exclude<Mode, "list">, 128 | 192 | 320> = {
  "grid-s": 128,
  "grid-m": 192,
  "grid-l": 320,
};
type Sort = "mtime" | "name" | "size";
interface View {
  mode: Mode;
  sort: Sort;
  imagesOnly: boolean;
}

const viewKey = (root: string) => `gp:folder-view:${root}`;
function readView(root: string): View {
  try {
    const raw = localStorage.getItem(viewKey(root));
    if (raw) {
      const v = JSON.parse(raw) as Partial<View>;
      return {
        mode: MODES.some((m) => m.id === v.mode) ? (v.mode as Mode) : "grid-m",
        sort: v.sort === "name" || v.sort === "size" ? v.sort : "mtime",
        imagesOnly: !!v.imagesOnly,
      };
    }
  } catch {
    /* 파싱 실패는 기본값으로 */
  }
  return { mode: "grid-m", sort: "mtime", imagesOnly: false };
}
function writeView(root: string, v: View) {
  try {
    localStorage.setItem(viewKey(root), JSON.stringify(v));
  } catch {
    /* 용량 초과 — 보기 설정은 다음에 기본값으로 뜰 뿐이다 */
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { year: "2-digit", month: "2-digit", day: "2-digit" });
};

// ---- 툴바 ---------------------------------------------------------------------------

function Toolbar({
  crumbs,
  onCrumb,
  query,
  setQuery,
  view,
  setView,
  onRefresh,
  onReveal,
  count,
}: {
  crumbs: string[];
  onCrumb: (i: number) => void;
  query: string;
  setQuery: (v: string) => void;
  view: View;
  setView: (f: (v: View) => View) => void;
  onRefresh: () => void;
  onReveal: () => void;
  count: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-2 py-1.5 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 truncate">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-0.5">
            {i > 0 && <span className="text-fg-dim">›</span>}
            <button
              onClick={() => onCrumb(i)}
              className={`truncate rounded px-1 py-0.5 hover:bg-raised ${
                i === crumbs.length - 1 ? "text-fg" : "text-fg-muted"
              }`}
            >
              {c}
            </button>
          </span>
        ))}
        <span className="ml-1 shrink-0 text-fg-dim">{count}개</span>
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5">
        <Search size={11} className="text-fg-dim" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="이름 검색"
          className="w-28 bg-transparent text-[11px] text-fg outline-none placeholder:text-fg-dim"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-fg-dim hover:text-fg">
            <X size={11} />
          </button>
        )}
      </div>

      <button
        onClick={() => setView((v) => ({ ...v, imagesOnly: !v.imagesOnly }))}
        title="이미지만 보기"
        className={`shrink-0 rounded p-1 ${
          view.imagesOnly ? "bg-raised text-accent" : "text-fg-muted hover:bg-raised hover:text-fg"
        }`}
      >
        <ImageIcon size={13} />
      </button>

      <select
        value={view.sort}
        onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as Sort }))}
        title="정렬"
        className="shrink-0 rounded border border-edge bg-panel px-1 py-0.5 text-[11px] text-fg-muted"
      >
        <option value="mtime">최신순</option>
        <option value="name">이름순</option>
        <option value="size">크기순</option>
      </select>

      <div className="flex shrink-0 items-center rounded border border-edge">
        {MODES.map(({ id, Icon, title }, i) => (
          <button
            key={id}
            title={title}
            onClick={() => setView((v) => ({ ...v, mode: id }))}
            className={`p-1 ${
              view.mode === id ? "bg-raised text-accent" : "text-fg-muted hover:bg-raised hover:text-fg"
            }`}
          >
            {/* 그리드 3종은 같은 아이콘이라 크기로 구분한다 — 목록만 다른 아이콘. */}
            <Icon size={id === "list" ? 13 : 9 + i * 2} />
          </button>
        ))}
      </div>

      <button
        onClick={onRefresh}
        title="새로고침 (F5) — 창을 클릭해 돌아와도 자동으로 갱신됩니다"
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <RotateCw size={13} />
      </button>
      <button
        onClick={onReveal}
        title="탐색기에서 이 폴더 열기"
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <FolderOpen size={13} />
      </button>
    </div>
  );
}

// ---- 그리드 -------------------------------------------------------------------------

function GridView({
  items,
  dir,
  join,
  edge,
  cursor,
  onCursor,
  onOpen,
  onMenu,
}: {
  items: FavEntry[];
  dir: string;
  join: (dir: string, name: string) => string;
  edge: 128 | 192 | 320;
  cursor: number;
  onCursor: (i: number) => void;
  onOpen: (e: FavEntry) => void;
  onMenu: (x: number, y: number, e: FavEntry) => void;
}) {
  const thumbs = useThumbs(dir, edge, join);
  return (
    <div
      className="grid gap-2 p-2"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${edge}px, 1fr))` }}
    >
      {items.map((e, i) => (
        <button
          key={e.name}
          ref={(el) => thumbs.observe(el, e)}
          onClick={() => onCursor(i)}
          onDoubleClick={() => onOpen(e)}
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onCursor(i);
            onMenu(ev.clientX, ev.clientY, e);
          }}
          title={e.name}
          // content-visibility: 화면 밖 칸은 레이아웃·페인트를 건너뛴다(수백 장에서 체감된다).
          style={{ contentVisibility: "auto", containIntrinsicSize: `${edge + 26}px` }}
          className={`flex flex-col overflow-hidden rounded border text-left ${
            i === cursor ? "border-accent bg-raised" : "border-edge hover:bg-raised"
          }`}
        >
          <div
            className="flex items-center justify-center overflow-hidden bg-base"
            style={{ height: edge }}
          >
            {e.isDir ? (
              <Folder size={edge / 3} className="text-fg-dim" />
            ) : thumbs.get(e.name) ? (
              <img
                src={thumbs.get(e.name)}
                alt={e.name}
                className="h-full w-full object-contain"
              />
            ) : (
              <KindIcon kind={e.kind} size={edge / 4} />
            )}
          </div>
          <div className="truncate px-1.5 py-1 text-[11px] text-fg-muted">{e.name}</div>
        </button>
      ))}
    </div>
  );
}

function KindIcon({ kind, size }: { kind: FavEntry["kind"]; size: number }) {
  const cls = "text-fg-dim";
  if (kind === "image") return <ImageIcon size={size} className={cls} />;
  if (kind === "video") return <Film size={size} className={cls} />;
  return <FileGlyph size={size} />;
}

function FileGlyph({ size }: { size: number }) {
  // lucide File 아이콘 대신 단순 사각형 — 이 창은 종류를 색이 아니라 이름으로 읽는다.
  return (
    <div
      className="rounded border border-edge"
      style={{ width: size * 0.72, height: size }}
      aria-hidden
    />
  );
}

/**
 * 보이는 칸의 썸네일만 받아 온다.
 *
 * 전부 미리 받으면 스크린샷 폴더(수백 장)에서 IPC 가 그만큼 나가고 각 응답이 base64 문자열이다.
 * IntersectionObserver 로 화면에 들어온 것만, 동시 8개까지 요청한다.
 */
function useThumbs(
  dir: string,
  edge: 128 | 192 | 320,
  join: (dir: string, name: string) => string,
) {
  const [map, setMap] = useState<Record<string, string>>({});
  const inflight = useRef(0);
  const queue = useRef<{ name: string; path: string }[]>([]);
  const asked = useRef<Set<string>>(new Set());
  const io = useRef<IntersectionObserver | null>(null);
  const nodes = useRef(new Map<Element, FavEntry>());

  // 폴더나 썸네일 크기가 바뀌면 처음부터 — 캐시 키가 달라진다.
  useEffect(() => {
    setMap({});
    asked.current = new Set();
    queue.current = [];
  }, [dir, edge]);

  const pump = useCallback(() => {
    while (inflight.current < 8 && queue.current.length) {
      const job = queue.current.shift()!;
      inflight.current++;
      void ipc
        .favThumb(job.path, edge)
        .then((url) => setMap((m) => ({ ...m, [job.name]: url })))
        .catch(() => {
          /* 못 만드는 형식(svg·손상)은 아이콘으로 남는다 — 조용히 넘긴다 */
        })
        .finally(() => {
          inflight.current--;
          pump();
        });
    }
  }, [edge]);

  useEffect(() => {
    io.current = new IntersectionObserver(
      (list) => {
        for (const it of list) {
          if (!it.isIntersecting) continue;
          const e = nodes.current.get(it.target);
          if (!e || e.isDir || e.kind !== "image") continue;
          const key = `${e.name}`;
          if (asked.current.has(key)) continue;
          asked.current.add(key);
          queue.current.push({ name: e.name, path: join(dir, e.name) });
        }
        pump();
      },
      { rootMargin: "200px" },
    );
    return () => io.current?.disconnect();
  }, [dir, pump, join]);

  const observe = useCallback((el: Element | null, e: FavEntry) => {
    if (!el || !io.current) return;
    nodes.current.set(el, e);
    io.current.observe(el);
  }, []);

  const get = useCallback((name: string) => map[name], [map]);
  return { observe, get };
}

// ---- 목록 ---------------------------------------------------------------------------

function ListView({
  items,
  cursor,
  onCursor,
  onOpen,
  onMenu,
}: {
  items: FavEntry[];
  cursor: number;
  onCursor: (i: number) => void;
  onOpen: (e: FavEntry) => void;
  onMenu: (x: number, y: number, e: FavEntry) => void;
}) {
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 bg-panel text-[11px] text-fg-dim">
        <tr>
          <th className="px-2 py-1 text-left font-normal">이름</th>
          <th className="w-20 px-2 py-1 text-right font-normal">크기</th>
          <th className="w-24 px-2 py-1 text-right font-normal">수정</th>
        </tr>
      </thead>
      <tbody>
        {items.map((e, i) => (
          <tr
            key={e.name}
            onClick={() => onCursor(i)}
            onDoubleClick={() => onOpen(e)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              onCursor(i);
              onMenu(ev.clientX, ev.clientY, e);
            }}
            className={`cursor-default ${i === cursor ? "bg-raised text-fg" : "text-fg-muted hover:bg-raised"}`}
          >
            <td className="flex items-center gap-1.5 truncate px-2 py-1">
              {e.isDir ? (
                <Folder size={13} className="shrink-0 text-fg-dim" />
              ) : (
                <KindIcon kind={e.kind} size={13} />
              )}
              <span className="truncate">{e.name}</span>
            </td>
            <td className="px-2 py-1 text-right text-fg-dim">
              {e.isDir ? "" : fmtSize(e.size)}
            </td>
            <td className="px-2 py-1 text-right text-fg-dim">{fmtTime(e.mtimeMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- 우클릭 메뉴 --------------------------------------------------------------------

function ItemMenu({
  x,
  y,
  entry,
  onClose,
  onCopyPath,
  onPastePath,
  onOpen,
  onReveal,
}: {
  x: number;
  y: number;
  entry: FavEntry;
  onClose: () => void;
  onCopyPath: () => void;
  onPastePath: () => void;
  onOpen: () => void;
  onReveal: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed z-50 min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      // 항목 4줄 × 31.5 + 헤더 24.5 + 패딩 ≈ 160. PaneMenu 와 같은 클램프 규칙.
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.max(0, Math.min(y, window.innerHeight - 160)),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 py-1 text-[11px] text-fg-dim">{entry.name}</div>
      <div className="my-1 border-t border-edge" />
      <Row icon={<Copy size={14} />} label="경로 복사" hint="Ctrl+C" onClick={run(onCopyPath)} />
      <Row
        icon={<ClipboardPaste size={14} />}
        label="터미널에 경로 붙여넣기"
        onClick={run(onPastePath)}
      />
      <Row icon={<ExternalLink size={14} />} label="기본 앱으로 열기" onClick={run(onOpen)} />
      <Row icon={<FolderOpen size={14} />} label="탐색기에서 보기" onClick={run(onReveal)} />
    </div>
  );
}

/** 메뉴 한 줄. `workspace/TerminalPane`의 `MenuItem`과 같은 모양이지만 **여기 따로 둔다** —
 *  거기서 가져오면 이 창 청크에 터미널 스토어·PTY 코어가 통째로 딸려 온다(폴더 창엔 터미널이 없다). */
function Row({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-fg-dim">{hint}</span>}
    </button>
  );
}

// ---- 라이트박스 ---------------------------------------------------------------------

function Lightbox({
  path,
  name,
  index,
  total,
  onClose,
  onStep,
}: {
  path: string;
  name: string;
  index: number;
  total: number;
  onClose: () => void;
  onStep: (d: number) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setErr(null);
    void ipc
      .favRead(path)
      .then((b) => alive && setSrc(`data:${b.mime};base64,${b.base64}`))
      .catch((e) => alive && setErr(msg(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-base/95"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="truncate">{name}</span>
        <span className="shrink-0 text-fg-dim">
          {index + 1} / {total}
        </span>
        <span className="ml-auto shrink-0 text-fg-dim">← → 이동 · Esc 닫기</span>
        <button onClick={onClose} className="shrink-0 rounded p-1 hover:bg-raised hover:text-fg">
          <X size={13} />
        </button>
      </div>
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-3"
        onClick={(e) => e.stopPropagation()}
      >
        {err ? (
          <div className="text-xs text-danger">{err}</div>
        ) : src ? (
          // 끝에서는 멈춘다(순환 없음) — 태스크 56의 뷰어 규약과 같다.
          <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="text-xs text-fg-dim">읽는 중…</div>
        )}
      </div>
      <div
        className="flex shrink-0 items-center justify-center gap-4 pb-3 text-fg-muted"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          disabled={index === 0}
          onClick={() => onStep(-1)}
          className="rounded px-3 py-1 text-xs hover:bg-raised disabled:opacity-30"
        >
          이전
        </button>
        <button
          disabled={index === total - 1}
          onClick={() => onStep(1)}
          className="rounded px-3 py-1 text-xs hover:bg-raised disabled:opacity-30"
        >
          다음
        </button>
      </div>
    </div>
  );
}
