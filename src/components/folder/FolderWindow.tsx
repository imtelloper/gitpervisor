import { emit } from "@tauri-apps/api/event";
import { isMod } from "../../lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ClipboardPaste,
  Clock,
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
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

import type { Messages } from "../../i18n/messages";
import { currentMessages, useMessages } from "../../i18n/ui-language";
import { copyText } from "../../lib/clipboard";
import {
  favThumbUrl,
  prefetchFavThumbs,
  touchFavThumb,
  useFavThumbState,
  useFavThumbToken,
  type ThumbEdge,
} from "../../lib/fav-thumb";
import { openDocWindow } from "../../lib/floating";
import { ipc, type FavEntry } from "../../lib/ipc";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { Toasts } from "../common/Toast";
import { FloatTitleBar } from "../FloatTitleBar";
import { Lightbox } from "./Lightbox";
import { modLabel } from "../../lib/platform";

/**
 * 즐겨찾기 폴더 창 (태스크 66) — 스크린샷·다운로드 폴더를 빠르게 훑어보는 창.
 *
 * 파일 뷰어 창(`doc-*`)의 인프라를 그대로 쓴다(`lib/floating.ts` openFolderWindow). 이 창은
 * **프로젝트에 속하지 않는다** — 모든 경로가 절대경로이고, 백엔드가 `Settings.favoriteFolders`
 * 아래인지 매 호출마다 검사한다(commands/favorites.rs `allowed`).
 *
 * 원본 이미지를 목록에 그리지 않는다 — 백엔드가 캐시된 썸네일(JPEG)을 썸네일 전용 스킴으로 주고
 * (`lib/fav-thumb.ts`), 그리드는 **화면에 보이는 행만** DOM 에 그린다(`GridView`). 3천 장 폴더에서
 * 칸 전부를 그리면 첫 렌더와 스크롤이 통째로 멈췄다(tests/bench/folder-thumbs.mjs).
 *
 * 파일 트리의 폴더 "새 창으로 열기"도 이 창이다(`projectId` 가 있을 때). 그때 `root` 는 프로젝트
 * 루트, `start` 는 누른 폴더이고, 이미지 밖의 파일은 OS 기본 앱 대신 앱의 뷰어 창으로 연다.
 */
export default function FolderWindow({
  root,
  start,
  projectId,
}: {
  root: string;
  start?: string;
  projectId?: string;
}) {
  const msg = useMessages();
  const SEP = root.includes("\\") ? "\\" : "/";
  const join = useCallback(
    (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}${SEP}${name}`,
    [SEP],
  );

  const [dir, setDir] = useState(start ?? root);
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
  /** 목록 스크롤 영역 — 가상 그리드가 스크롤 위치·크기를 여기서 읽는다. */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 키보드로 커서를 옮길 때마다 늘린다 — 그리드가 커서를 화면 안으로 끌어온다. 클릭·갱신으로 커서
   *  자리가 바뀔 때는 스크롤을 건드리지 않는다(새 스크린샷이 끼어 선택이 한 칸 밀려도 보던 자리 그대로). */
  const [reveal, setReveal] = useState(0);

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
      if (projectId) {
        // 트리가 넘기는 것과 같은 레포 상대경로(`/` 구분) — 트리 더블클릭처럼 동영상은 넓게 연다.
        const rel = join(dir, e.name)
          .slice(root.replace(/[\\/]+$/, "").length)
          .split(/[\\/]/)
          .filter(Boolean)
          .join("/");
        openDocWindow(projectId, rel, e.kind === "video" ? { size: [1180, 860] } : undefined);
        return;
      }
      void ipc.favOpen(join(dir, e.name), "default").catch((err) =>
        useUi
          .getState()
          .pushToast("error", currentMessages().folder.window.openFailedWithReason(errText(err))),
      );
    },
    [dir, images, join, projectId, root],
  );

  const goUp = useCallback(() => {
    if (dir.replace(/[\\/]+$/, "") === root.replace(/[\\/]+$/, "")) return;
    const cut = dir.replace(/[\\/]+$/, "").lastIndexOf(SEP);
    if (cut > 0) setDir(dir.slice(0, cut));
  }, [dir, root, SEP]);

  const copyPath = useCallback(
    (e: FavEntry) => {
      void copyText(join(dir, e.name)).then((ok) => {
        const t = currentMessages().folder;
        useUi.getState().pushToast(ok ? "success" : "error", ok ? t.copyPathDone : t.copyFailed);
      });
    },
    [dir, join],
  );

  const copyVideoTime = useCallback((time: string) => {
    void copyText(time).then((ok) => {
      const t = currentMessages().folder;
      useUi.getState().pushToast(ok ? "success" : "error", ok ? t.window.copyVideoTimeDone : t.copyFailed);
    });
  }, []);

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
      if (isMod(ev) && ev.key >= "1" && ev.key <= "4") {
        ev.preventDefault();
        setView((v) => ({ ...v, mode: MODES[Number(ev.key) - 1].id }));
        return;
      }
      if (isMod(ev) && ev.key.toLowerCase() === "c") {
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
      setReveal((n) => n + 1);
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
      <FloatTitleBar title={crumbs[crumbs.length - 1] ?? root} badge={msg.folder.window.badge} />

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
            useUi.getState().pushToast("error", msg.folder.window.revealFailed);
          })
        }
        count={shown.length}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <EmptyState
            icon={FolderSearch}
            title={msg.folder.window.readFailedTitle}
            desc={error}
          />
        ) : entries === null ? (
          <div className="p-4 text-xs text-fg-dim">{msg.folder.loading}</div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={Folder}
            title={query || view.imagesOnly ? msg.folder.window.noMatchTitle : msg.folder.window.emptyTitle}
            desc={
              query || view.imagesOnly
                ? msg.folder.window.noMatchDesc
                : msg.folder.window.emptyDesc
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
            reveal={reveal}
            scrollRef={scrollRef}
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
          onCopyVideoTime={copyVideoTime}
          onPastePath={() => pastePath(menu.entry)}
          onOpen={() =>
            void ipc.favOpen(join(dir, menu.entry.name), "default").catch(() => {
              useUi.getState().pushToast("error", msg.folder.window.openFailed);
            })
          }
          onReveal={() =>
            void ipc.favOpen(join(dir, menu.entry.name), "reveal").catch(() => {
              useUi.getState().pushToast("error", msg.folder.window.revealFailed);
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
  { id: "grid-s", Icon: LayoutGrid },
  { id: "grid-m", Icon: LayoutGrid },
  { id: "grid-l", Icon: LayoutGrid },
  { id: "list", Icon: List },
] as const;
type Mode = (typeof MODES)[number]["id"];
/** 보기 버튼 툴팁 — 렌더 때 계산해야 언어를 바꾸면 따라간다. */
function modeTitle(msg: Messages, id: Mode): string {
  switch (id) {
    case "grid-s":
      return msg.folder.window.modeSmall(modLabel);
    case "grid-m":
      return msg.folder.window.modeMedium(modLabel);
    case "grid-l":
      return msg.folder.window.modeLarge(modLabel);
    case "list":
      return msg.folder.window.modeList(modLabel);
  }
}
const EDGE: Record<Exclude<Mode, "list">, ThumbEdge> = {
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const msg = useMessages();
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
        <span className="ml-1 shrink-0 text-fg-dim">{msg.folder.window.itemCount(count)}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1 rounded border border-edge px-1.5 py-0.5">
        <Search size={11} className="text-fg-dim" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={msg.folder.window.searchPlaceholder}
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
        title={msg.folder.window.imagesOnlyTitle}
        className={`shrink-0 rounded p-1 ${
          view.imagesOnly ? "bg-raised text-accent" : "text-fg-muted hover:bg-raised hover:text-fg"
        }`}
      >
        <ImageIcon size={13} />
      </button>

      <select
        value={view.sort}
        onChange={(e) => setView((v) => ({ ...v, sort: e.target.value as Sort }))}
        title={msg.folder.window.sortTitle}
        className="shrink-0 rounded border border-edge bg-panel px-1 py-0.5 text-[11px] text-fg-muted"
      >
        <option value="mtime">{msg.folder.window.sortNewest}</option>
        <option value="name">{msg.folder.window.sortName}</option>
        <option value="size">{msg.folder.window.sortSize}</option>
      </select>

      <div className="flex shrink-0 items-center rounded border border-edge">
        {MODES.map(({ id, Icon }, i) => (
          <button
            key={id}
            title={modeTitle(msg, id)}
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
        title={msg.folder.window.refreshTitle}
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <RotateCw size={13} />
      </button>
      <button
        onClick={onReveal}
        title={msg.folder.window.revealFolderTitle}
        className="shrink-0 rounded p-1 text-fg-muted hover:bg-raised hover:text-fg"
      >
        <FolderOpen size={13} />
      </button>
    </div>
  );
}

// ---- 그리드 -------------------------------------------------------------------------

/** 칸 사이·가장자리 여백(px) — 예전 `gap-2 p-2` 그대로. */
const GAP = 8;
const PAD = 8;
/** 칸 아래 이름 줄 높이(px). 가상 그리드는 행 높이가 고정이어야 스크롤 위치로 행을 계산한다. */
const NAME_H = 24;

/**
 * 가상 그리드 — 보이는 행 ± 한 화면(행 수)만 DOM 에 그리고 전체 높이는 바깥 상자가 잡는다. 위아래 한 화면은
 * 휠을 연달아 굴려도 컴포지터가 먼저 밀어 올린 자리에 빈 행이 비치지 않게 하는 몫이다.
 *
 * 칸은 썸네일을 요청하지 않는다 — 목록 전체를 미리 받기(`lib/fav-thumb.ts` prefetchFavThumbs)에 넘기고 보이는
 * 범위만 알린다. 칸마다 요청하던 때는 빠른 스크롤로 지나간 칸마다 디코드가 나가 멈춘 자리가 그 뒤에 줄을 섰고
 * (벤치 f), 그걸 막으려 스크롤이 멎을 때까지 요청을 미뤘더니 내리는 내내 아이콘만 보였다(벤치 g·h).
 *
 * 열 수는 `repeat(auto-fill, minmax(edge, 1fr))` 와 같은 식으로 스크롤 영역 폭에서 직접 계산한다(창 크기가
 * 바뀌면 ResizeObserver 가 다시 잰다). 클릭·더블클릭·우클릭은 칸마다 핸들러를 달지 않고 바깥에서 `data-i` 로
 * 받는다 — 스크롤마다 새로 그려지는 칸이 `memo` 를 깨지 않게.
 */
function GridView({
  items,
  dir,
  join,
  edge,
  cursor,
  reveal,
  scrollRef,
  onCursor,
  onOpen,
  onMenu,
}: {
  items: FavEntry[];
  dir: string;
  join: (dir: string, name: string) => string;
  edge: ThumbEdge;
  cursor: number;
  reveal: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onCursor: (i: number) => void;
  onOpen: (e: FavEntry) => void;
  onMenu: (x: number, y: number, e: FavEntry) => void;
}) {
  const token = useFavThumbToken();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [topRow, setTopRow] = useState(0);

  const tileH = edge + NAME_H + 2; // 테두리 위아래 1px
  const rowH = tileH + GAP;
  const cols = Math.max(1, Math.floor((box.w - 2 * PAD + GAP) / (edge + GAP)));
  const rows = Math.ceil(items.length / cols);

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    // 세로 스크롤바가 생기면 clientWidth 가 줄어 열 수가 바뀐다 — content box 를 보는 RO 가 그것도 잡는다.
    const measure = () =>
      setBox((b) =>
        b.w === sc.clientWidth && b.h === sc.clientHeight ? b : { w: sc.clientWidth, h: sc.clientHeight },
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => ro.disconnect();
  }, [scrollRef]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const rowOf = () => Math.max(0, Math.floor((sc.scrollTop - PAD) / rowH));
    // 같은 행이면 React 가 다시 그리지 않는다(같은 값 setState) — 스크롤 이벤트 대부분이 여기서 끝난다.
    // 행이 바뀌면 **이 이벤트 안에서** 그린다: React 에 맡기면 그리기 뒤 태스크에서 커밋해, 스크롤바를 끌거나 멀리
    // 뛸 때 새 위치가 옛 행으로(= 빈 화면) 한 프레임 그려졌다.
    const onScroll = () => flushSync(() => setTopRow(rowOf()));
    setTopRow(rowOf()); // 크기(edge)가 바뀌면 같은 scrollTop 이라도 행이 다르다(효과 안이라 flushSync 는 못 쓴다)
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, [scrollRef, rowH]);

  // 키보드로 옮긴 커서가 화면 밖이면 그 행이 보이게 스크롤한다(그 행은 지금 DOM 에 없을 수도 있다 — 계산으로).
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!reveal || !sc) return;
    const top = PAD + Math.floor(cursor / cols) * rowH;
    if (top < sc.scrollTop) sc.scrollTop = top - PAD;
    else if (top + tileH > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + tileH + PAD - sc.clientHeight;
    // reveal 이 바뀔 때만 — 클릭·갱신으로 커서가 움직일 때는 보던 자리를 지킨다(FolderWindow reveal 주석).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const screenRows = Math.max(1, Math.ceil(box.h / rowH));
  const first = Math.max(0, topRow - screenRows);
  const last = Math.min(rows - 1, topRow + 2 * screenRows);
  const start = first * cols;
  const slice = items.slice(start, (last + 1) * cols);

  const urls = useMemo(
    () =>
      items.map((e) =>
        token && !e.isDir && e.kind === "image" ? favThumbUrl(join(dir, e.name), e, edge, token) : undefined,
      ),
    [items, dir, join, edge, token],
  );
  const visFirst = topRow * cols;
  const visLast = Math.min(items.length, (topRow + screenRows + 1) * cols) - 1;
  useEffect(() => prefetchFavThumbs(urls, visFirst, visLast), [urls, visFirst, visLast]);
  // 창을 닫거나 목록 보기로 바꾸면 멈춘다(창을 닫으면 페이지째 사라지지만 목록 보기는 같은 페이지다).
  useEffect(() => () => prefetchFavThumbs([], 0, -1), []);

  const at = (ev: React.MouseEvent) => {
    const el = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-i]") : null;
    const i = el ? Number(el.dataset.i) : -1;
    return items[i] ? i : -1;
  };

  return (
    <div
      className="relative"
      style={{ height: rows ? PAD * 2 + rows * rowH - GAP : 0 }}
      onClick={(ev) => {
        const i = at(ev);
        if (i >= 0) onCursor(i);
      }}
      onDoubleClick={(ev) => {
        const i = at(ev);
        if (i >= 0) onOpen(items[i]);
      }}
      onContextMenu={(ev) => {
        const i = at(ev);
        if (i < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        onCursor(i);
        onMenu(ev.clientX, ev.clientY, items[i]);
      }}
    >
      <div
        className="absolute grid"
        style={{
          top: PAD + first * rowH,
          left: PAD,
          right: PAD,
          gap: GAP,
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: tileH,
        }}
      >
        {slice.map((e, k) => (
          <Tile
            // key 가 곧 썸네일 식별 키다 — 같은 이름으로 다시 쓴 파일은 칸이 **새로 마운트**돼 새 URL 을 받는다.
            key={thumbKey(e)}
            e={e}
            i={start + k}
            selected={start + k === cursor}
            edge={edge}
            url={urls[start + k]}
          />
        ))}
      </div>
    </div>
  );
}

/** 그리드 한 칸. 썸네일은 미리 받기가 끝낸 뒤에만 건다 — 그래서 `<img>` 는 처음부터 보이는 상태로 마운트된다
 *  (받아 둔 `Image` 가 메모리 캐시에 있어 그 자리에서 완성된다). 못 만드는 형식은 아이콘 그대로. */
const Tile = memo(function Tile({
  e,
  i,
  selected,
  edge,
  url,
}: {
  e: FavEntry;
  i: number;
  selected: boolean;
  edge: ThumbEdge;
  url: string | undefined;
}) {
  const state = useFavThumbState(url);
  /** 받아 둔 뒤 다시 읽다 실패한 URL(그사이 지워진 파일) — URL 로 들어야 크기를 바꿔 새 URL 이 오면 풀린다. */
  const [broken, setBroken] = useState<string | null>(null);
  const shown = state === "ok" && broken !== url;
  useEffect(() => {
    if (shown && url) touchFavThumb(url);
  }, [shown, url]);
  return (
    <button
      data-i={i}
      title={e.name}
      className={`flex flex-col overflow-hidden rounded border text-left ${
        selected ? "border-accent bg-raised" : "border-edge hover:bg-raised"
      }`}
    >
      <div
        className="relative flex w-full shrink-0 items-center justify-center overflow-hidden bg-base"
        style={{ height: edge }}
      >
        {e.isDir ? (
          <Folder size={edge / 3} className="text-fg-dim" />
        ) : (
          !shown && <KindIcon kind={e.kind} size={edge / 4} />
        )}
        {shown && (
          // sync — 이 칸이 처음 그려지는 프레임에 디코드까지 끝낸다. async 면 크로뮴이 디코드를 기다리지 않고 그림
          // 없이 먼저 그릴 수 있다(다음 프레임에 채움) — 스크롤로 새로 나타난 칸이 한 번 비어 보인다. 썸네일은 작은
          // JPEG 라 동기 디코드가 싸다(벤치 d: 한 화면씩 끝까지 내려가는 동안 Long Task 0).
          <img
            src={url}
            alt={e.name}
            decoding="sync"
            draggable={false}
            onError={() => setBroken(url ?? null)}
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
      </div>
      <div
        className="w-full truncate px-1.5 text-[11px] text-fg-muted"
        style={{ height: NAME_H, lineHeight: `${NAME_H}px` }}
      >
        {e.name}
      </div>
    </button>
  );
});

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

/** 칸 식별 키 — 이름|mtime|크기. **이름만으로 들면 안 된다:** 같은 이름으로 다시 쓴 파일(편집기로
 *  덮어쓴 스크린샷)의 칸이 옛 로딩 상태를 이어 쓴다. 썸네일 URL·백엔드 디스크 캐시 키도 같은 셋이다. */
const thumbKey = (e: FavEntry) => `${e.name}|${e.mtimeMs}|${e.size}`;

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
  const msg = useMessages();
  return (
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 bg-panel text-[11px] text-fg-dim">
        <tr>
          <th className="px-2 py-1 text-left font-normal">{msg.folder.window.columnName}</th>
          <th className="w-20 px-2 py-1 text-right font-normal">{msg.folder.window.columnSize}</th>
          <th className="w-24 px-2 py-1 text-right font-normal">{msg.folder.window.columnModified}</th>
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

/** 프레임 추출 이름(`<stem>_HHhMMmSSs[mmm].<ext>`, commands/video.rs `frame_time_name`)의 영상 시각
 *  `HH:MM:SS[.mmm]`. 패턴이 **확장자 바로 앞**일 때만 — stem 에도 `_`·숫자가 흔해 이름 중간의 비슷한 조각은 프레임
 *  이름이 아니다. 시는 두 자리 이상(100시간 넘는 영상은 세 자리). */
function frameVideoTime(name: string): string | null {
  const m = /_(\d{2,})h([0-5]\d)m([0-5]\d)s(\d{3})?\.[^.]+$/.exec(name);
  return m ? `${m[1]}:${m[2]}:${m[3]}${m[4] ? `.${m[4]}` : ""}` : null;
}

function ItemMenu({
  x,
  y,
  entry,
  onClose,
  onCopyPath,
  onCopyVideoTime,
  onPastePath,
  onOpen,
  onReveal,
}: {
  x: number;
  y: number;
  entry: FavEntry;
  onClose: () => void;
  onCopyPath: () => void;
  onCopyVideoTime: (time: string) => void;
  onPastePath: () => void;
  onOpen: () => void;
  onReveal: () => void;
}) {
  const msg = useMessages();
  const videoTime = entry.isDir ? null : frameVideoTime(entry.name);
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
      // 항목 4줄 × 31.5 + 헤더 24.5 + 패딩 ≈ 160(영상 시각 줄이 있으면 +32). PaneMenu 와 같은 클램프 규칙.
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.max(0, Math.min(y, window.innerHeight - (videoTime ? 192 : 160))),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 py-1 text-[11px] text-fg-dim">{entry.name}</div>
      <div className="my-1 border-t border-edge" />
      <Row icon={<Copy size={14} />} label={msg.folder.menuCopyPath} hint={`${modLabel}+C`} onClick={run(onCopyPath)} />
      {videoTime && (
        <Row
          icon={<Clock size={14} />}
          label={msg.folder.window.menuCopyVideoTime(videoTime)}
          onClick={run(() => onCopyVideoTime(videoTime))}
        />
      )}
      <Row
        icon={<ClipboardPaste size={14} />}
        label={msg.folder.window.menuPasteToTerminal}
        onClick={run(onPastePath)}
      />
      <Row icon={<ExternalLink size={14} />} label={msg.folder.menuOpenDefault} onClick={run(onOpen)} />
      <Row icon={<FolderOpen size={14} />} label={msg.folder.menuReveal} onClick={run(onReveal)} />
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
