import { emit } from "@tauri-apps/api/event";
import { isMac, isMod } from "../../lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Brush,
  ClipboardPaste,
  Clock,
  Copy,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderSearch,
  Image as ImageIcon,
  LayoutGrid,
  Link,
  List,
  Pencil,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
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
import { copyFilesWithToast, copyText } from "../../lib/clipboard";
import {
  favThumbUrl,
  prefetchFavThumbs,
  thumbEdgeFor,
  touchFavThumb,
  useFavThumbState,
  useFavThumbToken,
  type ThumbEdge,
} from "../../lib/fav-thumb";
import { openDocWindow } from "../../lib/floating";
import { fileIcon, folderIcon } from "../../lib/file-icon";
import { favRecentMs, ipc, type FavEntry, type OsFileType } from "../../lib/ipc";
import { useOsFileTypes } from "../../lib/os-file-type";
import { compareSortValues, SortLabel, type SortDir, type SortValue, type TableSort } from "../sysmon/sort-table";
import { joinPathsForPrompt, validateEntryName } from "../../lib/path";
import { useUi } from "../../stores/ui";
import { ConfirmHost } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { PromptHost } from "../common/PromptDialog";
import { Toasts } from "../common/Toast";
import { FloatTitleBar } from "../FloatTitleBar";
import { PhotoViewer } from "./PhotoViewer";
import { MarqueeBand, useMarqueeDrag, type Marquee } from "./useMarqueeDrag";
import { modLabel } from "../../lib/platform";

/** 이미지 편집기(경로 모드, 태스크 76 D10). **lazy 여야 한다** — DocWindow 와 같은 이유로, 정적 import 면 편집기 전체가
 *  폴더 창 청크에 인라인돼 편집을 안 해도 그 값을 낸다. App·DocWindow 와 같은 모듈이라 청크를 공유한다. */
const ImageEditor = lazy(() => import("../image/ImageEditor"));

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
  const zoomGrid = useCallback(
    (f: number) =>
      setView((v) => (v.mode === "list" ? v : { ...v, zoom: clampTile((v.zoom ?? EDGE[v.mode]) * f) })),
    [],
  );
  const [query, setQuery] = useState("");
  /** 선택. **이름으로 붙든다** — 인덱스로 들면 포커스·F5 갱신이 더 최신 파일을 앞에 끼울 때(기본
   *  정렬이 최신 먼저) 강조·Ctrl+C·Enter 가 말없이 옆 파일로 옮겨 간다. 스크린샷 경로를 Claude 에
   *  넘기는 바로 그 동선에서 엉뚱한 경로가 나간다. */
  const [sel, setSel] = useState<Sel>(NO_SEL);
  /** 다중 선택(이름) — 드래그 상자·Ctrl/Shift+클릭이 채운다. 비어 있으면 커서 한 칸이 선택이다. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(NO_PICK);
  /** 드래그 상자가 시작될 때의 선택 — Ctrl+드래그는 여기에 더하고, 그냥 드래그는 비우고 시작한다. */
  const marqueeBase = useRef<ReadonlySet<string>>(NO_PICK);
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
  /** 이 창에서 연 이미지 편집기(경로 모드) — 떠 있으면 뷰어를 내리고 키를 넘기지 않는다. */
  const imageEditorPath = useUi((s) => s.imageEditorPath);

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
    setPicked(NO_PICK);
    void load();
  }, [load]);
  /** 지금 보고 있는 폴더 — 늦게 끝난 삭제가 다른 폴더로 옮겨 간 뒤에 옛 폴더 목록을 다시 읽어 덮지 않게. */
  const dirNow = useRef(dir);
  useEffect(() => {
    dirNow.current = dir;
  }, [dir]);

  // 편집기를 닫으면 다시 읽는다 — 저장했으면 스탬프가 바뀌어 썸네일·뷰어가 새 파일을 보인다(뷰어는 `version` 으로
  // 다시 읽는다). 다른 이름으로 저장했으면 새 파일이 목록에 생기고 뷰어는 원본에 남는다(이름으로 붙들고 있다).
  // 취소했으면 같은 목록을 한 번 더 읽을 뿐이다.
  const editorWasOpen = useRef(false);
  useEffect(() => {
    if (imageEditorPath) editorWasOpen.current = true;
    else if (editorWasOpen.current) {
      editorWasOpen.current = false;
      void load();
    }
  }, [imageEditorPath, load]);

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

  /** OS 아이콘·유형 이름 — 보이는 쪽(목록 32px / 그리드 256px)만 묻는다(lib/os-file-type.ts). */
  const pathOf = useCallback((name: string) => join(dir, name), [dir, join]);
  const osType32 = useOsFileTypes(view.mode === "list" ? entries : null, pathOf, 32);
  const osType256 = useOsFileTypes(view.mode === "list" ? null : entries, pathOf, 256);
  const osType = view.mode === "list" ? osType32 : osType256;

  /** 화면에 그릴 목록 — 필터 → 정렬. 폴더는 언제나 위. */
  const shown = useMemo(() => {
    const typeOf = (e: FavEntry) => osType(e)?.typeName ?? typeLabel(msg, e);
    const q = query.trim().toLowerCase();
    const list = (entries ?? []).filter(
      (e) =>
        (!q || e.name.toLowerCase().includes(q)) &&
        (!view.imagesOnly || e.isDir || e.kind === "image"),
    );
    const dirFirst = (a: FavEntry, b: FavEntry) =>
      a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1;
    return list.sort((a, b) => {
      // 날짜순은 폴더도 섞는다 — 폴더를 늘 위에 두면 다운로드처럼 폴더가 수백 개인 곳에서 방금 받은 파일이 그 밑에
      // 묻힌다(사용자 지적 2026-11-16). 나머지 기준은 방향과 무관하게 폴더가 위다.
      if (view.sort !== "mtime") {
        const d = dirFirst(a, b);
        if (d) return d;
      }
      return (
        compareSortValues(sortValue(a, view.sort, typeOf), sortValue(b, view.sort, typeOf), view.dir) ||
        compareSortValues(a.name, b.name, "asc")
      );
    });
  }, [entries, query, view.imagesOnly, view.sort, view.dir, osType, msg]);

  /** 목록 머리글 클릭 — 같은 열이면 방향을 뒤집고, 새 열은 그 열의 기본 방향으로. */
  const sortBy = useCallback(
    (sort: Sort) =>
      setView((v) => ({
        ...v,
        sort,
        dir: v.sort === sort ? (v.dir === "asc" ? "desc" : "asc") : SORT_DIR[sort],
      })),
    [],
  );

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

  /** 칸 클릭(빈 자리면 -1). Shift = 커서부터 거기까지(커서는 기준점으로 남는다), Ctrl/⌘ = 하나씩 넣고 빼기. */
  const clickItem = useCallback(
    (i: number, mods: { mod: boolean; shift: boolean }) => {
      const e = shown[i];
      if (!e) {
        if (!mods.mod && !mods.shift) setPicked(NO_PICK);
        return;
      }
      if (mods.shift) {
        const [lo, hi] = cursor < i ? [cursor, i] : [i, cursor];
        setPicked(new Set(shown.slice(lo, hi + 1).map((x) => x.name)));
        return;
      }
      if (mods.mod) {
        setPicked((p) => {
          // 처음 Ctrl+클릭이면 직접 골라 둔 커서 칸도 선택에 든다(탐색기와 같다).
          const n = new Set(p.size === 0 && sel.name !== null && shown[cursor] ? [shown[cursor].name] : p);
          if (n.has(e.name)) n.delete(e.name);
          else n.add(e.name);
          return n;
        });
      } else setPicked(NO_PICK);
      select(i);
    },
    [shown, cursor, sel.name, select],
  );

  /** 우클릭 — 선택 안의 칸이면 선택을 그대로 두고(메뉴의 휴지통이 선택 전체에 간다), 밖이면 그 칸 하나로. */
  const contextItem = useCallback(
    (i: number, x: number, y: number) => {
      const e = shown[i];
      if (!e) return;
      if (!picked.has(e.name)) setPicked(NO_PICK);
      select(i);
      setMenu({ x, y, entry: e });
    },
    [shown, picked, select],
  );

  const marqueeStart = useCallback(
    (additive: boolean) => {
      marqueeBase.current = additive ? picked : NO_PICK;
    },
    [picked],
  );
  const marquee = useCallback(
    (hits: number[]) => {
      const n = new Set(marqueeBase.current);
      for (const i of hits) if (shown[i]) n.add(shown[i].name);
      setPicked(n);
    },
    [shown],
  );

  /** 다중 선택 중 지금 보이는 것 — 검색·필터로 가려진 이름은 지우지 않는다. */
  const pickedShown = useMemo(() => (picked.size ? shown.filter((e) => picked.has(e.name)) : []), [shown, picked]);

  /** 칸 위에서 누른 끌기 — **보이는 선택**(다중 선택, 없으면 강조된 커서 칸) 위면 그 전부를 OS 파일 드래그로 넘기고 true.
   *  메인 창 파일 트리에 놓으면 탐색기에서 끌어 온 파일과 같은 길로 그 폴더에 복사된다(사용자 요청 2026-11-16).
   *  선택 밖에서 누르면 false — 종전대로 드래그 상자다(칸 위에서도 상자를 시작할 수 있어야 한다, useMarqueeDrag 주석). */
  const dragItem = useCallback(
    (i: number, ev: React.MouseEvent) => {
      const e = shown[i];
      const list = picked.size ? (picked.has(e.name) ? pickedShown : []) : i === cursor ? [e] : [];
      if (!list.length) return false;
      trackFileDrag(ev, list.map((x) => join(dir, x.name)));
      return true;
    },
    [shown, picked, pickedShown, cursor, dir, join],
  );
  /** Delete 가 지울 것 — 다중 선택, 없으면 **직접 고른** 커서 한 칸. 아직 아무것도 안 골랐으면(NO_SEL — 강조는 맨 앞을
   *  따라갈 뿐이다) 없다: 창을 열자마자 누른 Delete 에 최신 파일이 말없이 사라지면 안 된다. */
  const trashTargets = useMemo(
    () => (picked.size ? pickedShown : sel.name !== null && shown[cursor] ? [shown[cursor]] : []),
    [picked.size, pickedShown, sel.name, shown, cursor],
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

  /** 프로젝트 모드에서 항목의 레포 상대경로(`/` 구분) — 트리가 뷰어·편집기에 넘기는 것과 같은 꼴. */
  const relOf = useCallback(
    (name: string) =>
      join(dir, name)
        .slice(root.replace(/[\\/]+$/, "").length)
        .split(/[\\/]/)
        .filter(Boolean)
        .join("/"),
    [dir, join, root],
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
        // 트리 더블클릭처럼 동영상은 넓게 연다.
        openDocWindow(projectId, relOf(e.name), e.kind === "video" ? { size: [1180, 860] } : undefined);
        return;
      }
      void ipc.favOpen(join(dir, e.name), "default").catch((err) =>
        useUi
          .getState()
          .pushToast("error", currentMessages().folder.window.openFailedWithReason(errText(err))),
      );
    },
    [dir, images, join, projectId, relOf],
  );

  const goUp = useCallback(() => {
    if (dir.replace(/[\\/]+$/, "") === root.replace(/[\\/]+$/, "")) return;
    const cut = dir.replace(/[\\/]+$/, "").lastIndexOf(SEP);
    if (cut > 0) setDir(dir.slice(0, cut));
  }, [dir, root, SEP]);

  /** 여러 개면 공백으로 이어 한 줄로(joinPathsForPrompt) — 그대로 Claude 프롬프트에 붙여 넣는 동선이다. */
  const copyPaths = useCallback(
    (list: FavEntry[]) => {
      if (!list.length) return;
      void copyText(joinPathsForPrompt(list.map((e) => join(dir, e.name)))).then((ok) => {
        const t = currentMessages().folder;
        useUi
          .getState()
          .pushToast(
            ok ? "success" : "error",
            ok ? (list.length > 1 ? t.copyPathsDone(list.length) : t.copyPathDone) : t.copyFailed,
          );
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
  const pastePaths = useCallback(
    (list: FavEntry[]) => {
      if (list.length) void emit("fav:paste-path", { paths: list.map((e) => join(dir, e.name)) });
    },
    [dir, join],
  );

  /** 같은 폴더 안에서 이름만 — 목록을 먼저 고쳐 선택이 새 이름을 따라가게 하고, 다시 읽어 디스크와 맞춘다. */
  const renameEntry = useCallback(
    (e: FavEntry) => {
      const m = currentMessages();
      useUi.getState().askPrompt({
        title: m.tree.dialog.renameTitle(e.isDir),
        label: join(dir, e.name),
        placeholder: e.isDir ? m.tree.dialog.folderNamePlaceholder : m.tree.dialog.fileNamePlaceholder,
        defaultValue: e.name,
        confirmLabel: m.tree.dialog.renameConfirm,
        validate: validateEntryName,
        onConfirm: (newName) => {
          if (newName === e.name) return;
          void ipc
            .favRename(join(dir, e.name), newName)
            .then(() => {
              setEntries((list) => list && list.map((x) => (x.name === e.name ? { ...x, name: newName } : x)));
              setSel((s) => (s.name === e.name ? { ...s, name: newName } : s));
              setLightbox((n) => (n === e.name ? newName : n));
              void load();
            })
            .catch((err) => useUi.getState().pushToast("error", errText(err)));
        },
      });
    },
    [dir, join, load],
  );

  /** **휴지통으로** 보낸다(fav_delete) — 확인창 없이. 탐색기의 Delete 와 같고, 되돌릴 수 있어서 그렇게 둔다. 목록에서는
   *  먼저 지운다(응답을 기다리면 지운 칸이 한 박자 남아 같은 파일에 Delete 를 두 번 누르게 된다). 실패하면 디스크를 다시
   *  읽는다 — 여러 개 중 일부만 옮겨졌을 수 있어 "전부 되돌리기"는 틀린 그림이다. */
  const trashEntries = useCallback(
    (list: FavEntry[]) => {
      if (!list.length) return;
      const names = new Set(list.map((e) => e.name));
      setEntries((cur) => cur && cur.filter((e) => !names.has(e.name)));
      setPicked(NO_PICK);
      const t = currentMessages().folder;
      void ipc
        .favDelete(list.map((e) => join(dir, e.name)))
        .then(() =>
          useUi
            .getState()
            .pushToast("success", list.length === 1 ? t.peek.trashed(list[0].name) : t.window.trashedMany(list.length)),
        )
        .catch((err) => {
          useUi.getState().pushToast("error", errText(err));
          if (dirNow.current === dir) void load();
        });
    },
    [dir, join, load],
  );

  /** 라이트박스에서 지우면 닫지 않고 다음 장(끝이면 앞 장)으로 넘어간다 — 한 장씩 보며 골라내는 동선. */
  const trashLightbox = useCallback(() => {
    const i = images.findIndex((e) => e.name === lightbox);
    if (i < 0) return;
    setLightbox((images[i + 1] ?? images[i - 1])?.name ?? null);
    trashEntries([images[i]]);
  }, [images, lightbox, trashEntries]);

  // ---- 키보드 ----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // 편집기·확인창이 떠 있으면 그 아래의 뷰어·목록은 키를 받지 않는다 — Delete·←→ 가 편집 중인(또는 회전 저장을
      // 묻는 중인) 사진을 지우거나 넘기면 안 된다.
      const ui = useUi.getState();
      if (ui.imageEditorPath || ui.confirm) return;
      const typing =
        ev.target instanceof HTMLInputElement ||
        ev.target instanceof HTMLTextAreaElement;
      // 누르고 있어도 한 번 — 자동 반복으로 여러 장이 연달아 사라지면 안 된다.
      const trashKey = ev.key === "Delete" || (isMac && ev.metaKey && ev.key === "Backspace");
      if (lightbox !== null) {
        // 뷰어 위 입력창(⋯ › 이름 바꾸기)에서 친 ←→·Delete 가 장을 넘기거나 파일을 지우면 안 된다. 배율 슬라이더는 입력란이 아니다.
        if (typing && !(ev.target instanceof HTMLInputElement && ev.target.type === "range")) return;
        if (ev.key === "Escape") setLightbox(null);
        else if (ev.key === "ArrowRight") stepLightbox(1);
        else if (ev.key === "ArrowLeft") stepLightbox(-1);
        else if (trashKey) {
          if (!ev.repeat) trashLightbox();
        } else return;
        ev.preventDefault();
        return;
      }
      if (ev.key === "F5") {
        ev.preventDefault();
        void load();
        return;
      }
      if (typing) return;
      if (trashKey) {
        ev.preventDefault();
        if (!ev.repeat && !useUi.getState().prompt) trashEntries(trashTargets);
        return;
      }
      if (ev.key === "Escape" && picked.size) {
        setPicked(NO_PICK);
        return;
      }
      if (isMod(ev) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        setPicked(new Set(shown.map((e) => e.name)));
        return;
      }
      if (ev.key === "F2" && !isMod(ev) && !ev.altKey && !ev.shiftKey) {
        const e = shown[cursor];
        if (e && !useUi.getState().prompt) {
          ev.preventDefault();
          renameEntry(e);
        }
        return;
      }
      if (isMod(ev) && ev.key >= "1" && ev.key <= "4") {
        ev.preventDefault();
        setView((v) => ({ ...v, mode: MODES[Number(ev.key) - 1].id, zoom: null }));
        return;
      }
      if (isMod(ev) && ev.key.toLowerCase() === "c") {
        // 여러 장을 골라 두었으면 전부 — 아니면 커서 한 칸. **파일로** 올린다(탐색기처럼 — 사용자 요청 2026-11-09).
        const list = picked.size ? pickedShown : shown[cursor] ? [shown[cursor]] : [];
        if (list.length) {
          ev.preventDefault();
          copyFilesWithToast(list.map((e) => join(dir, e.name)));
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
      // 새 자리를 계산해 **이름**으로 적는다(위 sel 주석). 다중 선택은 접는다(탐색기와 같다).
      setPicked(NO_PICK);
      setSel((s) => {
        const i = Math.max(0, Math.min(shown.length - 1, cursorOf(shown, s) + delta));
        return shown[i] ? { name: shown[i].name, index: i } : s;
      });
      setReveal((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    lightbox,
    stepLightbox,
    trashLightbox,
    trashEntries,
    trashTargets,
    picked.size,
    shown,
    cursor,
    view.mode,
    load,
    goUp,
    openEntry,
    copyPaths,
    pickedShown,
    renameEntry,
  ]);

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
        pickedCount={pickedShown.length}
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
            osType={osType32}
            sort={{ key: view.sort, dir: view.dir }}
            onSort={sortBy}
            cursor={cursor}
            scrollRef={scrollRef}
            picked={picked}
            onClickItem={clickItem}
            onOpen={openEntry}
            onContextItem={contextItem}
            onDragItem={dragItem}
            onMarqueeStart={marqueeStart}
            onMarquee={marquee}
          />
        ) : (
          <GridView
            items={shown}
            osType={osType256}
            dir={dir}
            join={join}
            tile={view.zoom ?? EDGE[view.mode]}
            onZoom={zoomGrid}
            cursor={cursor}
            reveal={reveal}
            scrollRef={scrollRef}
            picked={picked}
            onClickItem={clickItem}
            onOpen={openEntry}
            onContextItem={contextItem}
            onDragItem={dragItem}
            onMarqueeStart={marqueeStart}
            onMarquee={marquee}
          />
        )}
      </div>

      {menu && (
        <ItemMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          onClose={() => setMenu(null)}
          onCopyFiles={() =>
            copyFilesWithToast((picked.has(menu.entry.name) ? pickedShown : [menu.entry]).map((e) => join(dir, e.name)))
          }
          onCopyPath={() => copyPaths(picked.has(menu.entry.name) ? pickedShown : [menu.entry])}
          onCopyVideoTime={copyVideoTime}
          onPastePath={() => pastePaths(picked.has(menu.entry.name) ? pickedShown : [menu.entry])}
          onRename={() => renameEntry(menu.entry)}
          // 사진 뷰어의 「편집」과 같은 자리(이 창 안 경로 모드) — 여러 개 선택이어도 우클릭한 한 장만.
          onEdit={
            menu.entry.kind === "image"
              ? () => useUi.getState().openImageEditorAbs(join(dir, menu.entry.name))
              : undefined
          }
          count={picked.has(menu.entry.name) ? pickedShown.length : 1}
          onTrash={() => trashEntries(picked.has(menu.entry.name) ? pickedShown : [menu.entry])}
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

      {/* 편집기가 떠 있는 동안은 그리지 않는다 — 뷰어의 캡처 키 리스너(R·Space·Ctrl+C)가 편집기 아래에서 돌면 안 된다.
          닫히면 다시 마운트돼 저장된 파일을 새로 읽는다. */}
      {lbIndex >= 0 && !imageEditorPath && (
        <PhotoViewer
          path={join(dir, images[lbIndex].name)}
          version={`${images[lbIndex].mtimeMs}:${images[lbIndex].size}`}
          name={images[lbIndex].name}
          index={lbIndex}
          total={images.length}
          onClose={() => setLightbox(null)}
          onStep={stepLightbox}
          onTrash={trashLightbox}
          onRename={() => renameEntry(images[lbIndex])}
          filmstrip={{ images, pathOf: (n) => join(dir, n) }}
          // 이 창 안에서 경로 모드로 연다 — 즐겨찾기·프로젝트 폴더 모두(프로젝트 루트도 `fav_*` 게이트가 받는다).
          onEdit={() => useUi.getState().openImageEditorAbs(join(dir, images[lbIndex].name))}
          onFileChanged={() => void load()}
        />
      )}

      <Toasts />
      <ConfirmHost />
      <PromptHost />
      {imageEditorPath && (
        <Suspense fallback={null}>
          <ImageEditor />
        </Suspense>
      )}
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
/** Ctrl+휠로 키우고 줄이는 칸 크기(px) 범위 — 위는 가장 큰 썸네일(640)이라 그 이상은 흐려진다. */
const TILE_MIN = 96;
const TILE_MAX = 640;
const clampTile = (n: number) => Math.round(Math.min(TILE_MAX, Math.max(TILE_MIN, n)));
const SORTS = ["mtime", "name", "size", "type"] as const;
type Sort = (typeof SORTS)[number];
/** 기준을 새로 고를 때의 방향 — 날짜·크기는 최근·큰 것부터, 글자는 가나다순. */
const SORT_DIR: Record<Sort, SortDir> = { mtime: "desc", name: "asc", size: "desc", type: "asc" };
function sortLabel(msg: Messages, s: Sort): string {
  const w = msg.folder.window;
  switch (s) {
    case "mtime":
      return w.sortDate;
    case "name":
      return w.sortName;
    case "size":
      return w.sortSize;
    case "type":
      return w.sortType;
    default: {
      const never: never = s;
      return never;
    }
  }
}
/** 확장자(소문자, 없으면 "") — 유형 열·유형순의 키. 맨 앞 점(`.env`)은 확장자가 아니다. */
const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};
const typeLabel = (msg: Messages, e: FavEntry) =>
  e.isDir ? msg.folder.window.typeFolder : msg.folder.window.typeFile(extOf(e.name).toUpperCase());
/** `typeOf` = 유형 열에 보이는 이름(OS 유형 이름, 아직 안 왔으면 "EXT 파일") — 보이는 대로 정렬한다. */
function sortValue(e: FavEntry, s: Sort, typeOf: (e: FavEntry) => string): SortValue {
  switch (s) {
    case "mtime":
      return favRecentMs(e);
    case "name":
      return e.name;
    case "size":
      return e.size;
    case "type":
      return typeOf(e);
    default: {
      const never: never = s;
      return never;
    }
  }
}
interface View {
  mode: Mode;
  /** Ctrl+휠로 정한 칸 크기 — 있으면 `EDGE[mode]` 대신 쓴다. 보기 버튼·Ctrl+숫자는 이것을 지운다. */
  zoom: number | null;
  sort: Sort;
  dir: SortDir;
  imagesOnly: boolean;
}

const viewKey = (root: string) => `gp:folder-view:${root}`;
function readView(root: string): View {
  try {
    const raw = localStorage.getItem(viewKey(root));
    if (raw) {
      const v = JSON.parse(raw) as Partial<View>;
      const sort = SORTS.find((s) => s === v.sort) ?? "mtime";
      return {
        mode: MODES.some((m) => m.id === v.mode) ? (v.mode as Mode) : "grid-m",
        zoom: typeof v.zoom === "number" ? clampTile(v.zoom) : null,
        sort,
        dir: v.dir === "asc" || v.dir === "desc" ? v.dir : SORT_DIR[sort],
        imagesOnly: !!v.imagesOnly,
      };
    }
  } catch {
    /* 파싱 실패는 기본값으로 */
  }
  return { mode: "grid-m", zoom: null, sort: "mtime", dir: "desc", imagesOnly: false };
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
const NO_PICK: ReadonlySet<string> = new Set();
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
  pickedCount,
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
  pickedCount: number;
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
        {pickedCount > 0 && (
          <span className="ml-1 shrink-0 text-accent">· {msg.folder.window.pickedCount(pickedCount)}</span>
        )}
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
        onChange={(e) => {
          const sort = e.target.value as Sort;
          setView((v) => ({ ...v, sort, dir: SORT_DIR[sort] }));
        }}
        title={msg.folder.window.sortTitle}
        className="shrink-0 rounded border border-edge bg-panel px-1 py-0.5 text-[11px] text-fg-muted"
      >
        {/* 고른 기준에만 방향을 붙인다 — 목록 머리글을 다시 눌러 방향을 뒤집으면 여기서도 보여야 한다. */}
        {SORTS.map((s) => (
          <option key={s} value={s}>
            {sortLabel(msg, s)}
            {s === view.sort ? (view.dir === "desc" ? " ↓" : " ↑") : ""}
          </option>
        ))}
      </select>

      <div className="flex shrink-0 items-center rounded border border-edge">
        {MODES.map(({ id, Icon }, i) => (
          <button
            key={id}
            title={modeTitle(msg, id)}
            onClick={() => setView((v) => ({ ...v, mode: id, zoom: null }))}
            // Ctrl+휠로 크기를 바꿨으면 어느 프리셋도 아니다 — 같은 버튼을 다시 누르면 그 크기로 돌아간다.
            className={`p-1 ${
              view.mode === id && (id === "list" || view.zoom === null)
                ? "bg-raised text-accent"
                : "text-fg-muted hover:bg-raised hover:text-fg"
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

/** 드래그 상자(내용 좌표)에 걸친 칸 번호 — 칸 사이 틈만 덮으면 걸리지 않는다. */
function gridHits(
  r: { x1: number; y1: number; x2: number; y2: number },
  n: number,
  cols: number,
  colW: number,
  rowH: number,
  tileH: number,
): number[] {
  const hits: number[] = [];
  const last = Math.floor((r.y2 - PAD) / rowH);
  for (let row = Math.max(0, Math.floor((r.y1 - PAD) / rowH)); row <= last; row++) {
    const top = PAD + row * rowH;
    if (r.y2 < top || r.y1 > top + tileH) continue;
    for (let col = 0; col < cols; col++) {
      const left = PAD + col * (colW + GAP);
      const i = row * cols + col;
      if (i < n && r.x2 >= left && r.x1 <= left + colW) hits.push(i);
    }
  }
  return hits;
}

/** 누른 채 4px 넘게 움직이면 OS 파일 드래그로 넘긴다. 이 창 안엔 놓을 곳이 없어 곧바로 넘긴다 — 왼쪽 버튼이 **아직
 *  눌려 있어야** OS 가 이어받으므로 mouseup 이 아니라 mousemove 에서다. 그 전에 놓으면 평범한 클릭이다. */
function trackFileDrag(ev: React.MouseEvent, paths: string[]) {
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  const move = (e: MouseEvent) => {
    if (Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
    end(); // OS 드래그가 도는 동안엔 mouseup 이 이 창에 안 온다 — 먼저 걷는다
    void ipc.favStartOsDrag(paths).catch((err) => useUi.getState().pushToast("error", errText(err)));
  };
  const end = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", end);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
}

/** 칸·행 마우스 처리 — 칸마다 핸들러를 달지 않고 바깥에서 `data-i` 로 받는다(스크롤마다 새로 그려지는 칸이 `memo` 를 깨지 않게). */
function itemMouseHandlers(
  items: FavEntry[],
  marquee: Marquee,
  onClickItem: (i: number, mods: { mod: boolean; shift: boolean }) => void,
  onOpen: (e: FavEntry) => void,
  onContextItem: (i: number, x: number, y: number) => void,
  onDragItem: (i: number, ev: React.MouseEvent) => boolean,
) {
  const at = (ev: React.MouseEvent) => {
    const el = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-i]") : null;
    const i = el ? Number(el.dataset.i) : -1;
    return items[i] ? i : -1;
  };
  return {
    onMouseDown: (ev: React.MouseEvent<HTMLDivElement>) => {
      // 수정 키가 붙으면 클릭(Ctrl·Shift 선택)·더하기 상자 몫이다.
      if (ev.button === 0 && !isMod(ev) && !ev.shiftKey) {
        const i = at(ev);
        if (i >= 0 && onDragItem(i, ev)) {
          marquee.swallow(); // 지난 상자가 남긴 "click 삼키기"를 비운다 — 안 그러면 이 칸의 클릭이 먹힌다
          return;
        }
      }
      marquee.onMouseDown(ev);
    },
    onClick: (ev: React.MouseEvent) => {
      if (!marquee.swallow()) onClickItem(at(ev), { mod: isMod(ev), shift: ev.shiftKey });
    },
    onDoubleClick: (ev: React.MouseEvent) => {
      const i = at(ev);
      if (i >= 0) onOpen(items[i]);
    },
    onContextMenu: (ev: React.MouseEvent) => {
      const i = at(ev);
      if (i < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      onContextItem(i, ev.clientX, ev.clientY);
    },
  };
}

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
  osType,
  dir,
  join,
  tile,
  onZoom,
  cursor,
  reveal,
  scrollRef,
  picked,
  onClickItem,
  onOpen,
  onContextItem,
  onDragItem,
  onMarqueeStart,
  onMarquee,
}: {
  items: FavEntry[];
  osType: (e: FavEntry) => OsFileType | undefined;
  dir: string;
  join: (dir: string, name: string) => string;
  tile: number;
  /** 칸 크기에 곱할 배율 — 부모가 범위로 자른다. 배율로 넘겨야 그리기 전에 몰려온 휠 여러 번이 누적된다. */
  onZoom: (factor: number) => void;
  cursor: number;
  reveal: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  picked: ReadonlySet<string>;
  onClickItem: (i: number, mods: { mod: boolean; shift: boolean }) => void;
  onOpen: (e: FavEntry) => void;
  onContextItem: (i: number, x: number, y: number) => void;
  /** 칸 위에서 누름 — 파일 드래그로 가져갔으면 true(그럼 상자는 시작하지 않는다). */
  onDragItem: (i: number, ev: React.MouseEvent) => boolean;
  /** 드래그 상자 시작 — `additive` = Ctrl/⌘ 드래그(기존 선택에 더한다). */
  onMarqueeStart: (additive: boolean) => void;
  /** 상자에 걸친 칸 번호 — 바뀔 때만 부른다. */
  onMarquee: (hits: number[]) => void;
}) {
  const token = useFavThumbToken();
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [topRow, setTopRow] = useState(0);
  const edge = thumbEdgeFor(tile);

  const tileH = tile + NAME_H + 2; // 테두리 위아래 1px
  const rowH = tileH + GAP;
  const cols = Math.max(1, Math.floor((box.w - 2 * PAD + GAP) / (tile + GAP)));
  const rows = Math.ceil(items.length / cols);
  const colW = (box.w - 2 * PAD - (cols - 1) * GAP) / cols; // 1fr 열 폭 — 그리드와 같은 식

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

  // Ctrl+휠(터치패드 핀치도 ctrlKey 휠로 온다) = 칸 크기. 마우스 아래 칸이 크기가 바뀐 뒤에도 같은 높이에 남게
  // 스크롤을 맞춘다 — scrollTop 을 그대로 두면 행 높이가 바뀌어 수천 장 폴더에서는 전혀 다른 곳으로 튄다.
  const zoomAnchor = useRef<{ i: number; frac: number; y: number } | null>(null);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const f = Math.exp(-ev.deltaY * 0.0015); // 휠 한 칸(100) ≈ ×1.16
      if ((f > 1 && tile >= TILE_MAX) || (f < 1 && tile <= TILE_MIN)) return;
      const r = sc.getBoundingClientRect();
      const y = ev.clientY - r.top;
      const pos = Math.max(0, sc.scrollTop + y - PAD);
      const row = Math.floor(pos / rowH);
      const col = Math.min(cols - 1, Math.max(0, Math.floor(((ev.clientX - r.left - PAD) * cols) / (box.w - 2 * PAD))));
      zoomAnchor.current = { i: Math.min(items.length - 1, row * cols + col), frac: (pos - row * rowH) / rowH, y };
      onZoom(f);
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, [scrollRef, tile, rowH, cols, box.w, items.length, onZoom]);
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const a = zoomAnchor.current;
    if (!sc || !a) return;
    zoomAnchor.current = null;
    sc.scrollTop = PAD + Math.floor(a.i / cols) * rowH + a.frac * rowH - a.y;
    // 같은 커밋 안에서 행도 맞춘다 — 스크롤 효과(useEffect)를 기다리면 옛 행으로 한 프레임 빈 화면이 그려진다.
    setTopRow(Math.max(0, Math.floor((sc.scrollTop - PAD) / rowH)));
  }, [scrollRef, cols, rowH]);

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
  useEffect(() => prefetchFavThumbs(urls, visFirst, visLast, edge), [urls, visFirst, visLast, edge]);
  // 창을 닫거나 목록 보기로 바꾸면 멈춘다(창을 닫으면 페이지째 사라지지만 목록 보기는 같은 페이지다).
  useEffect(() => () => prefetchFavThumbs([], 0, -1), []);

  const marquee = useMarqueeDrag(
    scrollRef,
    (r) => gridHits(r, items.length, cols, colW, rowH, tileH),
    onMarqueeStart,
    onMarquee,
  );

  return (
    <div
      // 칸이 적어도 아래 빈 자리에서 상자를 시작할 수 있게 화면 높이만큼은 잡는다.
      className="relative select-none"
      style={{ height: rows ? PAD * 2 + rows * rowH - GAP : 0, minHeight: "100%" }}
      {...itemMouseHandlers(items, marquee, onClickItem, onOpen, onContextItem, onDragItem)}
    >
      <MarqueeBand band={marquee.band} />
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
            selected={picked.size ? picked.has(e.name) : start + k === cursor}
            size={tile}
            url={urls[start + k]}
            osIcon={osType(e)?.icon ?? undefined}
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
  size,
  url,
  osIcon,
}: {
  e: FavEntry;
  i: number;
  selected: boolean;
  size: number;
  url: string | undefined;
  /** OS 유형 아이콘(256px PNG data URL) — 썸네일이 없는 동안의 자리 그림. 아직 안 왔으면 앱 아이콘. */
  osIcon: string | undefined;
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
        style={{ height: size }}
      >
        {!shown &&
          (osIcon ? (
            // 셸 큰 아이콘은 테두리 여백을 품고 있어 칸의 절반이면 탐색기 "큰 아이콘"과 비슷하다.
            <img src={osIcon} alt="" draggable={false} style={{ width: size / 2, height: size / 2 }} className="object-contain" />
          ) : (
            <EntryIcon e={e} size={size / 3} />
          ))}
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

/** OS 아이콘이 오기 전(또는 OS 가 못 줄 때)의 아이콘 — 파일 트리와 같은 확장자별 아이콘·색(lib/file-icon.tsx). */
function EntryIcon({ e, size }: { e: FavEntry; size: number }) {
  const { Icon, color } = e.isDir ? folderIcon(false) : fileIcon(e.name);
  return <Icon size={size} color={color} className="shrink-0" />;
}

/** 칸 식별 키 — 이름|mtime|크기. **이름만으로 들면 안 된다:** 같은 이름으로 다시 쓴 파일(편집기로
 *  덮어쓴 스크린샷)의 칸이 옛 로딩 상태를 이어 쓴다. 썸네일 URL·백엔드 디스크 캐시 키도 같은 셋이다. */
const thumbKey = (e: FavEntry) => `${e.name}|${e.mtimeMs}|${e.size}`;

// ---- 목록 ---------------------------------------------------------------------------

function ListView({
  items,
  osType,
  sort,
  onSort,
  cursor,
  scrollRef,
  picked,
  onClickItem,
  onOpen,
  onContextItem,
  onDragItem,
  onMarqueeStart,
  onMarquee,
}: {
  items: FavEntry[];
  osType: (e: FavEntry) => OsFileType | undefined;
  sort: TableSort<Sort>;
  onSort: (s: Sort) => void;
  cursor: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  picked: ReadonlySet<string>;
  onClickItem: (i: number, mods: { mod: boolean; shift: boolean }) => void;
  onOpen: (e: FavEntry) => void;
  onContextItem: (i: number, x: number, y: number) => void;
  onDragItem: (i: number, ev: React.MouseEvent) => boolean;
  onMarqueeStart: (additive: boolean) => void;
  onMarquee: (hits: number[]) => void;
}) {
  const msg = useMessages();
  // 행은 다 그려져 있고 높이가 같다 — 첫 행 자리·높이로 상자가 걸친 행 범위를 낸다(가로는 보지 않는다, 행이 폭 전체다).
  const marquee = useMarqueeDrag(
    scrollRef,
    (r, host) => {
      const first = host.querySelector<HTMLElement>('tr[data-i="0"]');
      if (!first) return [];
      const fr = first.getBoundingClientRect();
      const top0 = fr.top - host.getBoundingClientRect().top;
      const lo = Math.max(0, Math.floor((r.y1 - top0) / fr.height));
      const hi = Math.min(items.length - 1, Math.floor((r.y2 - top0) / fr.height));
      return hi < lo ? [] : Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    },
    onMarqueeStart,
    onMarquee,
  );
  return (
    // select-none — Shift+클릭·드래그가 행 글자를 긁어 선택하지 않게. 표 아래 빈 자리에서도 상자를 시작할 수 있게 화면 높이만큼.
    <div
      className="relative select-none"
      style={{ minHeight: "100%" }}
      {...itemMouseHandlers(items, marquee, onClickItem, onOpen, onContextItem, onDragItem)}
    >
      <MarqueeBand band={marquee.band} />
    <table className="w-full text-[12px]">
      <thead className="sticky top-0 bg-panel text-[11px] text-fg-dim">
        {/* 머리글 누름이 바깥의 드래그 상자·"빈 자리 클릭 = 선택 해제"로 새지 않게 여기서 끊는다. */}
        <tr onMouseDown={(ev) => ev.stopPropagation()} onClick={(ev) => ev.stopPropagation()}>
          <th className="px-2 py-1 text-left font-normal">
            <SortLabel label={msg.folder.window.columnName} k="name" sort={sort} onSort={onSort} />
          </th>
          <th className="w-28 px-2 py-1 text-right font-normal">
            <SortLabel label={msg.folder.window.columnModified} k="mtime" sort={sort} onSort={onSort} align="right" />
          </th>
          <th className="w-20 px-2 py-1 text-right font-normal">
            <SortLabel label={msg.folder.window.columnSize} k="size" sort={sort} onSort={onSort} align="right" />
          </th>
          <th className="w-36 px-2 py-1 text-left font-normal">
            <SortLabel label={msg.folder.window.columnType} k="type" sort={sort} onSort={onSort} />
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((e, i) => {
          const t = osType(e);
          return (
            <tr
              key={e.name}
              data-i={i}
              className={`cursor-default ${
                (picked.size ? picked.has(e.name) : i === cursor) ? "bg-raised text-fg" : "text-fg-muted hover:bg-raised"
              }`}
            >
              <td className="flex items-center gap-1.5 truncate px-2 py-1">
                {t?.icon ? (
                  <img src={t.icon} alt="" draggable={false} className="h-4 w-4 shrink-0 object-contain" />
                ) : (
                  <EntryIcon e={e} size={14} />
                )}
                <span className="truncate">{e.name}</span>
              </td>
              <td className="px-2 py-1 text-right text-fg-dim">{fmtTime(favRecentMs(e))}</td>
              <td className="px-2 py-1 text-right text-fg-dim">
                {e.isDir ? "" : fmtSize(e.size)}
              </td>
              <td className="max-w-0 truncate px-2 py-1 text-fg-dim" title={t?.typeName ?? undefined}>
                {t?.typeName ?? typeLabel(msg, e)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
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
  onCopyFiles,
  onCopyPath,
  onCopyVideoTime,
  onPastePath,
  onRename,
  onEdit,
  count,
  onTrash,
  onOpen,
  onReveal,
}: {
  x: number;
  y: number;
  entry: FavEntry;
  onClose: () => void;
  onCopyFiles: () => void;
  onCopyPath: () => void;
  onCopyVideoTime: (time: string) => void;
  onPastePath: () => void;
  onRename: () => void;
  /** 이미지일 때만 — 없으면 줄을 안 그린다. */
  onEdit?: () => void;
  /** 메뉴가 적용될 개수(경로 복사·붙여넣기·휴지통) — 다중 선택 안의 칸을 우클릭했으면 선택 전체. */
  count: number;
  onTrash: () => void;
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
      // 항목 7줄 × 31.5 + 헤더 24.5 + 구분선 둘 + 패딩 ≈ 264(영상 시각·편집 줄이 있으면 줄마다 +32). PaneMenu 와 같은 클램프 규칙.
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.max(0, Math.min(y, window.innerHeight - 264 - (videoTime ? 32 : 0) - (onEdit ? 32 : 0))),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 py-1 text-[11px] text-fg-dim">{entry.name}</div>
      <div className="my-1 border-t border-edge" />
      <Row
        icon={<Copy size={14} />}
        label={count > 1 ? msg.folder.menuCopyFilesMany(count) : msg.folder.menuCopyFiles}
        hint={`${modLabel}+C`}
        onClick={run(onCopyFiles)}
      />
      <Row
        icon={<Link size={14} />}
        label={count > 1 ? msg.folder.window.menuCopyPathMany(count) : msg.folder.menuCopyPath}
        onClick={run(onCopyPath)}
      />
      {videoTime && (
        <Row
          icon={<Clock size={14} />}
          label={msg.folder.window.menuCopyVideoTime(videoTime)}
          onClick={run(() => onCopyVideoTime(videoTime))}
        />
      )}
      <Row
        icon={<ClipboardPaste size={14} />}
        label={count > 1 ? msg.folder.window.menuPasteToTerminalMany(count) : msg.folder.window.menuPasteToTerminal}
        onClick={run(onPastePath)}
      />
      {onEdit && <Row icon={<Brush size={14} />} label={msg.folder.lightbox.edit} onClick={run(onEdit)} />}
      <Row icon={<Pencil size={14} />} label={msg.folder.window.menuRename} hint="F2" onClick={run(onRename)} />
      <Row icon={<ExternalLink size={14} />} label={msg.folder.menuOpenDefault} onClick={run(onOpen)} />
      <Row icon={<FolderOpen size={14} />} label={msg.folder.menuReveal} onClick={run(onReveal)} />
      <div className="my-1 border-t border-edge" />
      <Row
        icon={<Trash2 size={14} />}
        label={count > 1 ? msg.folder.window.menuTrashMany(count) : msg.folder.peek.menuTrash}
        hint={isMac ? "⌘⌫" : "Del"}
        danger
        onClick={run(onTrash)}
      />
    </div>
  );
}

/** 메뉴 한 줄. `workspace/TerminalPane`의 `MenuItem`과 같은 모양이지만 **여기 따로 둔다** —
 *  거기서 가져오면 이 창 청크에 터미널 스토어·PTY 코어가 통째로 딸려 온다(폴더 창엔 터미널이 없다). */
function Row({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        danger ? "text-danger hover:bg-raised" : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-fg-dim">{hint}</span>}
    </button>
  );
}
