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
  /** 선택. **이름으로 붙든다** — 인덱스로 들면 포커스·F5 갱신이 더 최신 파일을 앞에 끼울 때(기본
   *  정렬이 최신 먼저) 강조·Ctrl+C·Enter 가 말없이 옆 파일로 옮겨 간다. 스크린샷 경로를 Claude 에
   *  넘기는 바로 그 동선에서 엉뚱한 경로가 나간다. */
  const [sel, setSel] = useState<Sel>(NO_SEL);
  /** 라이트박스에 열린 이미지의 **이름** — 같은 이유로 인덱스가 아니다. */
  const [lightbox, setLightbox] = useState<string | null>(null);
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
    setSel(NO_SEL); // 폴더가 바뀌면 선택은 처음부터
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

  const cursor = useMemo(() => cursorOf(shown, sel), [shown, sel]);
  // 이름이 사라졌으면(삭제·필터) 폴백 자리의 항목이 새 선택이다 — 다음 갱신부터는 그 이름을 따라간다.
  // 자리도 함께 적어 둔다: 다음에 사라질 때의 폴백이다.
  // **아직 안 골랐으면(NO_SEL) 적지 않는다.** 고르기 전의 강조는 맨 앞(= 최신)을 따라가야 한다 — 새
  // 스크린샷을 찍고 창을 클릭(= 갱신)하면 강조·Ctrl+C·Enter 가 방금 찍은 것이어야 한다. 첫 로드에서 이름을
  // 붙들면 이전 스크린샷에 남아 옛 경로가 나간다. 이름은 클릭·화살표가 비로소 적는다.
  useEffect(() => {
    if (sel.name === null) return;
    const e = shown[cursor];
    if (e && (e.name !== sel.name || cursor !== sel.index)) setSel({ name: e.name, index: cursor });
  }, [shown, cursor, sel]);
  const select = useCallback(
    (i: number) => {
      const e = shown[i];
      if (e) setSel({ name: e.name, index: i });
    },
    [shown],
  );

  const lbIndex = lightbox === null ? -1 : images.findIndex((e) => e.name === lightbox);
  // 열어 둔 이미지가 갱신 뒤 없으면(지워짐) 닫는다 — 옆 이미지로 슬쩍 바뀌어 보이면 안 된다.
  useEffect(() => {
    if (lightbox !== null && lbIndex < 0) setLightbox(null);
  }, [lightbox, lbIndex]);
  const stepLightbox = useCallback(
    (d: number) =>
      setLightbox((name) => {
        const i = images.findIndex((e) => e.name === name);
        return i < 0 ? name : images[Math.max(0, Math.min(images.length - 1, i + d))].name;
      }),
    [images],
  );

  const openEntry = useCallback(
    (e: FavEntry) => {
      if (e.isDir) {
        setDir(join(dir, e.name));
        return;
      }
      if (e.kind === "image" && images.some((x) => x.name === e.name)) {
        setLightbox(e.name);
        return;
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
        else if (ev.key === "ArrowRight") stepLightbox(1);
        else if (ev.key === "ArrowLeft") stepLightbox(-1);
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
      // 새 자리를 계산해 **이름**으로 적는다(위 sel 주석).
      setSel((s) => {
        const i = Math.max(0, Math.min(shown.length - 1, cursorOf(shown, s) + delta));
        return shown[i] ? { name: shown[i].name, index: i } : s;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, stepLightbox, shown, cursor, view.mode, load, goUp, openEntry, copyPath]);

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
        // 이 폴더 **자체**를 연다 — `reveal` 은 상위 폴더를 열고 이것을 선택만 한다(Linux 는 상위만).
        // `default` 는 디렉터리를 받으면 그 폴더를 연다(commands/favorites.rs `fav_open`).
        onReveal={() =>
          void ipc.favOpen(dir, "default").catch(() => {
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
            onCursor={select}
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
            onCursor={select}
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

      {lbIndex >= 0 && (
        <Lightbox
          path={join(dir, images[lbIndex].name)}
          name={images[lbIndex].name}
          index={lbIndex}
          total={images.length}
          onClose={() => setLightbox(null)}
          onStep={stepLightbox}
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

/** 선택 — `name` 이 본체이고 `index` 는 마지막으로 보인 자리(이름이 사라졌을 때의 폴백). */
interface Sel {
  name: string | null;
  index: number;
}
const NO_SEL: Sel = { name: null, index: 0 };
/** 선택이 지금 목록의 몇 번째인가. 이름이 없으면(삭제·필터) 마지막 자리 — 끝을 넘지 않게. 아직 안
 *  골랐으면(NO_SEL) 늘 0 = 맨 앞(최신). */
const cursorOf = (list: FavEntry[], s: Sel) => {
  const i = list.findIndex((e) => e.name === s.name);
  return i >= 0 ? i : Math.min(s.index, list.length - 1);
};

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
          // key 가 곧 썸네일 식별 키다 — 같은 이름으로 다시 쓴 파일은 칸이 **새로 마운트**돼야 새 키를
          // 요청한다. IntersectionObserver 는 이미 관찰 중인 요소의 observe() 를 무시한다(첫 콜백이 없다).
          key={thumbKey(e)}
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
            ) : thumbs.get(e) ? (
              <img
                src={thumbs.get(e)}
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

/** 썸네일 식별 키 — 이름|mtime|크기. **이름만으로 들면 안 된다:** 같은 이름으로 다시 쓴 파일(편집기로
 *  덮어쓴 스크린샷)이 옛 썸네일을 영영 쓴다. 백엔드 디스크 캐시 키도 같은 셋이다(favorites.rs `fav_thumb`). */
const thumbKey = (e: FavEntry) => `${e.name}|${e.mtimeMs}|${e.size}`;

/**
 * 보이는 칸의 썸네일만 받아 온다.
 *
 * 전부 미리 받으면 스크린샷 폴더(수백 장)에서 IPC 가 그만큼 나가고 각 응답이 base64 문자열이다.
 * IntersectionObserver 로 화면에 들어온 것만, 동시 8개까지 요청한다. 키는 `thumbKey`.
 *
 * ponytail: 다시 쓴 파일의 옛 키 썸네일은 폴더를 옮기거나 크기를 바꿀 때까지 map 에 남는다(장당 수십 KB).
 * 커지면 목록 갱신 때 지금 목록의 키만 남기고 거른다.
 */
function useThumbs(
  dir: string,
  edge: 128 | 192 | 320,
  join: (dir: string, name: string) => string,
) {
  const [map, setMap] = useState<Record<string, string>>({});
  const inflight = useRef(0);
  const queue = useRef<{ key: string; path: string; edge: 128 | 192 | 320; gen: number }[]>([]);
  const asked = useRef<Set<string>>(new Set());
  /** 초기화 세대. 요청은 자기 세대를 들고 나가고, 돌아왔을 때 세대가 바뀌었으면 버린다 — 크기를 바꾼
   *  직후 늦게 온 128px 응답이 320px 칸을 덮거나, 옛 폴더의 응답이 같은 키 칸에 앉지 않게. */
  const gen = useRef(0);
  const io = useRef<IntersectionObserver | null>(null);
  const nodes = useRef(new Map<Element, FavEntry>());

  // 폴더나 썸네일 크기가 바뀌면 처음부터 — 캐시 키가 달라진다. setMap({}) 은 매번 새 객체라 반드시
  // 다시 그려지고, 그 렌더의 ref 콜백이 칸들을 **새** observer 에 다시 붙인다(아래 observe).
  useEffect(() => {
    gen.current++;
    setMap({});
    asked.current = new Set();
    queue.current = [];
  }, [dir, edge]);

  // 요청이 자기 edge 를 들고 다니므로 pump 는 한 벌이면 된다. 렌더마다 edge 를 붙든 pump 였다면
  // 크기를 바꾼 뒤 옛 요청의 finally 가 부른 **옛** pump 가 새 요청을 옛 크기로 내보낸다.
  const pump = useCallback(() => {
    while (inflight.current < 8 && queue.current.length) {
      const job = queue.current.shift()!;
      inflight.current++;
      void ipc
        .favThumb(job.path, job.edge)
        .then((url) => {
          if (job.gen === gen.current) setMap((m) => ({ ...m, [job.key]: url }));
        })
        .catch(() => {
          /* 못 만드는 형식(svg·손상)은 아이콘으로 남는다 — 조용히 넘긴다 */
        })
        .finally(() => {
          inflight.current--;
          pump();
        });
    }
  }, []);

  useEffect(() => {
    io.current = new IntersectionObserver(
      (list) => {
        for (const it of list) {
          if (!it.isIntersecting) continue;
          const e = nodes.current.get(it.target);
          if (!e || e.isDir || e.kind !== "image") continue;
          const key = thumbKey(e);
          if (asked.current.has(key)) continue;
          asked.current.add(key);
          queue.current.push({ key, path: join(dir, e.name), edge, gen: gen.current });
        }
        pump();
      },
      { rootMargin: "200px" },
    );
    return () => io.current?.disconnect();
  }, [dir, edge, pump, join]);

  const observe = useCallback((el: Element | null, e: FavEntry) => {
    if (!el || !io.current) return;
    nodes.current.set(el, e);
    io.current.observe(el);
  }, []);

  const get = useCallback((e: FavEntry) => map[thumbKey(e)], [map]);
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
