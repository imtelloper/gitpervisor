import { emit } from "@tauri-apps/api/event";
import {
  Check,
  Copy,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMessages } from "../../i18n/ui-language";
import { copyText } from "../../lib/clipboard";
import { favThumbUrl, useFavThumbToken } from "../../lib/fav-thumb";
import { ipc, type FavEntry } from "../../lib/ipc";
import { joinPathsForPrompt } from "../../lib/path";
import { isMod } from "../../lib/platform";
import { useUi } from "../../stores/ui";
import { PhotoViewer } from "./PhotoViewer";
import { MarqueeBand, useMarqueeDrag, type MarqueeRect } from "./useMarqueeDrag";

const NO_PICK: ReadonlySet<string> = new Set();

/** 칸이 40개뿐이고 전부 DOM 에 있어 화면 좌표로 바로 판정한다(창의 가상 그리드는 계산으로 한다). */
function peekHits(r: MarqueeRect, host: HTMLElement): number[] {
  const hr = host.getBoundingClientRect();
  const hits: number[] = [];
  host.querySelectorAll<HTMLElement>("[data-pi]").forEach((el) => {
    const b = el.getBoundingClientRect();
    const x = b.left - hr.left;
    const y = b.top - hr.top;
    if (x < r.x2 && x + b.width > r.x1 && y < r.y2 && y + b.height > r.y1) hits.push(Number(el.dataset.pi));
  });
  return hits;
}

/** 미리보기에 그릴 최대 개수 — **최신 순으로** 자른다. 패널이 스크롤되므로 한 화면에 들어갈
 *  필요는 없지만, 무제한이면 폴더가 수백 장일 때(실제 스크린샷 폴더가 225장) 썸네일 요청이
 *  그만큼 나간다. 더 보려면 창을 연다(거기는 보이는 행만 그리는 가상 그리드다). */
const MAX = 40;

/** 썸네일 변 길이. 칸이 ≈200px 이라 192 도 살짝 모자라지만, 백엔드가 받는 값은 128·192·320
 *  셋뿐이고(캐시 폭주 방지) 320 은 40장이면 전송량이 4배가 된다 — object-cover 라 눈에 안 띈다. */
const THUMB_EDGE = 192;

/**
 * 즐겨찾기 폴더 **호버 미리보기** — 최근 파일을 바로 펼치고, 클릭하면 **경로를 복사**한다.
 *
 * 왜 창을 열지 않고 이게 따로 있나: 이 폴더들의 실사용은 "방금 찍은 스크린샷 경로를 Claude 에
 * 붙여넣기" 하나다(`다운로드` 프리셋이 등록돼 있는 이유도 그것이다 — 이미지 경로용 브라우즈
 * 루트). 그 동선이 클릭 → 새 창 → 찾기 → 복사 → 창 닫기 였는데 호버 → 클릭으로 끝난다.
 * **즐겨찾기 이름 클릭은 그대로 창을 연다** — 훑어보기·라이트박스·검색은 여전히 창의 몫이다.
 *
 * 복사 문구는 FolderWindow 의 `copyPath` 와 **같은 것을 쓴다** — 같은 일이 두 곳에서 다르게
 * 보이면 사용자는 다른 일로 읽는다. 우클릭 메뉴 구성도 그 창의 메뉴를 따른다(삭제만 더 있다).
 *
 * 이미지 **더블클릭은 크게 보기**(창과 같은 라이트박스). 더블클릭의 첫 클릭은 여전히 경로를 복사한다
 * — 복사는 되풀이해도 무해하고, 클릭을 더블클릭 판정 시간만큼 미루면 이 패널의 "한 번에 끝내기"가 굼떠진다.
 *
 * `onMouseEnter` 는 TitleBar 가 준다 — 포인터가 패널에 닿으면 가는 길에 지나친 항목의 전환 예약을 취소한다.
 */
export function FolderPeek({ path, onMouseEnter }: { path: string; onMouseEnter?: () => void }) {
  const msg = useMessages();
  const sep = path.includes("\\") ? "\\" : "/";
  const join = (name: string) => `${path.replace(/[\\/]+$/, "")}${sep}${name}`;

  const [files, setFiles] = useState<FavEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 썸네일은 스킴 URL 을 `<img>` 에 바로 건다(lib/fav-thumb.ts) — IPC 를 타지 않아 목록 요청과 줄을 서지 않는다.
  const token = useFavThumbToken();
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(
    null,
  );
  /** 라이트박스에 연 이미지의 **이름** — 창과 같은 규칙(인덱스로 들면 지웠을 때 옆 파일로 옮겨 간다). */
  const [lightbox, setLightbox] = useState<string | null>(null);
  /** 여러 장 고르기(드래그 상자·Ctrl+클릭) — 이름으로 든다(창과 같은 규칙). 스크린샷 여러 장을 한 번에 Claude 에 넘기는 동선. */
  const [picked, setPicked] = useState<ReadonlySet<string>>(NO_PICK);
  const pickBase = useRef<ReadonlySet<string>>(NO_PICK);
  const scrollRef = useRef<HTMLDivElement>(null);
  const marquee = useMarqueeDrag(
    scrollRef,
    peekHits,
    (additive) => {
      pickBase.current = additive ? picked : NO_PICK;
    },
    (hits) => {
      const next = new Set(pickBase.current);
      for (const i of hits) if (files?.[i]) next.add(files[i].name);
      setPicked(next);
    },
  );

  /** 왼쪽으로 밀어낸 픽셀 — 패널이 680px 이라 창이 좁으면 `right-full` 만으로는 화면 밖으로
   *  나가 **아무것도 안 보인다**(초판 256px 때는 드물었지만 지금은 폭 ~950px 미만이면 걸린다).
   *  잘리는 대신 드롭다운 위로 겹치더라도 화면 안에 넣는다 — 안 보이는 것보다 겹치는 게 낫다.
   *  폭을 600 으로 잡은 것도 이 때문이다: 680 이면 이 헤더 배치(드롭다운 left≈620)에서 매번
   *  clamp 가 걸려 드롭다운 왼쪽 67px 를 덮었고, 그 위를 지나는 마우스가 항목 대신 패널에
   *  닿아 **폴더 간 호버 전환이 막혔다**(실측). 600 이면 평소엔 clamp 가 아예 안 걸린다. */
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 이미 밀어 둔 상태에서 다시 재면 누적된다 — 기준은 shift 를 뺀 '원래' 위치다.
    const raw = el.getBoundingClientRect().left - shift;
    const want = raw < 8 ? Math.round(8 - raw) : 0;
    if (want !== shift) setShift(want);
  }, [shift, files]);

  useEffect(() => {
    // `dead` 가 없으면 폴더를 빠르게 옮겨 다닐 때 **먼저 보낸 요청이 나중에 도착해** 남의 폴더
    // 목록을 그린다 — 그 상태로 클릭하면 엉뚱한 경로가 클립보드로 간다(조용한 오답).
    let dead = false;
    setFiles(null);
    setError(null);
    setMenu(null);
    setLightbox(null);
    setPicked(NO_PICK);
    ipc
      .favList(path)
      .then((list) => {
        if (dead) return;
        // 디렉터리는 뺀다 — 여기서 들어갈 수단이 없고(그건 창의 일), 최신 파일을 밀어낸다.
        const recent = list
          .filter((e) => !e.isDir)
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, MAX);
        setFiles(recent);
      })
      .catch((e) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
    // join 은 path 파생이라 의존성에 넣으면 매 렌더 재실행된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // 라이트박스가 넘나드는 순서 = 패널에 보이는 순서의 이미지들(창의 규약과 같다). 열어 둔 파일이
  // 지워져 목록에서 빠지면 lbIndex 가 -1 이라 그리지 않는다 — 옆 이미지로 슬쩍 바뀌어 보이면 안 된다.
  const images = (files ?? []).filter((e) => e.kind === "image");
  const lbIndex = lightbox === null ? -1 : images.findIndex((e) => e.name === lightbox);
  const stepLightbox = (d: number) =>
    setLightbox((name) => {
      const i = images.findIndex((e) => e.name === name);
      return i < 0 ? name : images[Math.max(0, Math.min(images.length - 1, i + d))].name;
    });

  // 키는 **캡처 단계에서** 먹는다. 드롭다운(TitleBar)이 window 버블 단계에 Esc=닫기를 걸어 두어서,
  // 여기서 막지 않으면 Esc 한 번에 라이트박스와 드롭다운이 같이 닫힌다.
  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setLightbox(null);
      else if (ev.key === "ArrowRight") stepLightbox(1);
      else if (ev.key === "ArrowLeft") stepLightbox(-1);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const toast = (kind: "success" | "error", message: string) =>
    useUi.getState().pushToast(kind, message);

  // 여러 개는 공백으로 이은 한 줄 — 폴더 창의 copyPaths 와 같은 모양(그대로 Claude 프롬프트에 붙는다).
  const copy = (names: string[]) =>
    void copyText(joinPathsForPrompt(names.map(join))).then((ok) =>
      toast(
        ok ? "success" : "error",
        ok ? (names.length > 1 ? msg.folder.copyPathsDone(names.length) : msg.folder.copyPathDone) : msg.folder.copyFailed,
      ),
    );

  const pasteToTerminal = (names: string[]) => void emit("fav:paste-path", { paths: names.map(join) });

  /** 메뉴·단축키가 다룰 대상 — 고른 칸 안을 눌렀으면 고른 전부(보이는 순서), 아니면 그 칸 하나. */
  const targetsOf = (name: string) =>
    picked.has(name) ? (files ?? []).filter((e) => picked.has(e.name)).map((e) => e.name) : [name];
  const pickedNames = (files ?? []).filter((e) => picked.has(e.name)).map((e) => e.name);

  const open = (name: string, how: "default" | "reveal") =>
    void ipc
      .favOpen(join(name), how)
      .catch((e) => toast("error", e instanceof Error ? e.message : String(e)));

  /** 확인창을 두지 않는다 — 이 패널의 존재 이유가 "한 번에 끝내기"다. 대신 **휴지통으로** 가고
   *  (백엔드 `fav_delete`), 토스트가 그 사실을 말한다. 목록에서는 즉시 지운다(응답을 기다리면
   *  지워진 칸이 한 박자 남아 같은 파일을 두 번 누르게 된다). 실패하면 되돌린다. */
  const remove = (names: string[]) => {
    if (!names.length) return;
    const before = files;
    const gone = new Set(names);
    setFiles((cur) => cur?.filter((e) => !gone.has(e.name)) ?? cur);
    setPicked((cur) => (cur.size ? new Set([...cur].filter((n) => !gone.has(n))) : cur));
    setMenu(null);
    void ipc
      .favDelete(names.map(join))
      .then(() =>
        toast(
          "success",
          names.length > 1 ? msg.folder.window.trashedMany(names.length) : msg.folder.peek.trashed(names[0]),
        ),
      )
      .catch((e) => {
        setFiles(before ?? null);
        toast("error", e instanceof Error ? e.message : String(e));
      });
  };

  // 고른 게 있을 때만 키를 먹는다 — 캡처 단계라 드롭다운의 Esc=닫기·터미널의 Ctrl+C 보다 먼저 받는다. 패널은 호버하는
  // 동안에만 떠 있으므로 그 사이 Ctrl+C 가 터미널에 안 가는 건 의도다(고른 칸 복사가 지금 할 일).
  useEffect(() => {
    // 메뉴가 떠 있으면 Esc 는 메뉴 닫기다(PeekMenu 가 받는다) — 여기서 먼저 먹으면 선택만 풀리고 메뉴는 남는다.
    if (!picked.size || lightbox !== null || menu) return;
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest("input, textarea:not(.xterm-helper-textarea), [contenteditable=true]")) return;
      if (isMod(ev) && ev.key.toLowerCase() === "c") copy(pickedNames);
      else if (ev.key === "Delete") remove(pickedNames);
      else if (ev.key === "Escape") setPicked(NO_PICK);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    // `right-full` = 드롭다운 **바로 왼쪽에 붙인다**. 틈을 두면 그리로 포인터가 빠지는 순간
    // 컨테이너의 onMouseLeave 가 떠서 패널이 닫힌다. 드롭다운의 자식이라 항목 → 패널 이동은
    // 컨테이너를 벗어나지 않는다(TitleBar 의 showPeek 주석) — `translateX` 로 밀어도 그 관계는
    // 그대로다(DOM 포함 관계가 기준이라 화면 위치와 무관하다).
    <div
      ref={ref}
      onMouseEnter={onMouseEnter}
      onContextMenu={(e) => e.preventDefault()}
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      className="absolute right-full top-0 z-50 flex max-h-[80vh] w-[600px] flex-col rounded-md border border-edge bg-panel p-2 shadow-xl"
    >
      <div className="flex shrink-0 items-baseline gap-2 px-1 pb-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-muted">
          {path}
        </span>
        {!!files?.length && (
          <span className="shrink-0 text-[11px] text-fg-dim">
            {msg.folder.peek.fileCount(files.length, files.length === MAX)}
          </span>
        )}
      </div>

      {error && <div className="px-1 py-3 text-[12px] text-danger">{error}</div>}
      {!error && files === null && (
        <div className="px-1 py-3 text-[12px] text-fg-dim">{msg.folder.loading}</div>
      )}
      {!error && files?.length === 0 && (
        <div className="px-1 py-3 text-[12px] text-fg-dim">{msg.folder.peek.empty}</div>
      )}

      {!!files?.length && (
        // 스크롤은 **그리드만** 한다 — 경로 헤더와 아래 안내는 붙박이다.
        <div ref={scrollRef} className="min-h-0 overflow-y-auto pr-1">
          {/* 드래그 상자 호스트 — 스크롤 안쪽이라 상자가 내용 좌표에 붙는다. select-none: 드래그가 파일 이름을 긁지 않게. */}
          <div className="relative grid select-none grid-cols-3 gap-2" onMouseDown={marquee.onMouseDown}>
          <MarqueeBand band={marquee.band} />
          {files.map((e, i) => (
            <div key={e.name} data-pi={i} className="group/peek relative">
              <button
                onClick={(ev) => {
                  if (marquee.swallow()) return;
                  if (isMod(ev)) {
                    const next = new Set(picked);
                    if (!next.delete(e.name)) next.add(e.name);
                    setPicked(next);
                    return;
                  }
                  // 그냥 클릭은 종전 그대로 그 한 장 복사 — 골라 둔 게 있으면 풀고(탐색기와 같은 규칙).
                  if (picked.size) setPicked(NO_PICK);
                  // 더블클릭의 두 번째 클릭(detail=2)은 복사하지 않는다 — 토스트가 두 번 뜬다.
                  if (ev.detail < 2) copy([e.name]);
                }}
                onDoubleClick={(ev) => !isMod(ev) && e.kind === "image" && setLightbox(e.name)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setMenu({ x: ev.clientX, y: ev.clientY, name: e.name });
                }}
                title={msg.folder.peek.itemTitle(e.name, e.kind === "image")}
                className={`flex w-full min-w-0 flex-col items-stretch gap-1 rounded border p-1 ${
                  picked.has(e.name)
                    ? "border-accent bg-accent/10 ring-1 ring-accent"
                    : "border-edge/60 hover:border-accent hover:bg-raised"
                }`}
              >
                <span className="relative flex h-36 w-full items-center justify-center overflow-hidden rounded bg-base">
                  <PeekThumb
                    key={`${e.mtimeMs}-${e.size}`}
                    kind={e.kind}
                    url={
                      token && e.kind === "image"
                        ? favThumbUrl(join(e.name), e, THUMB_EDGE, token)
                        : undefined
                    }
                  />
                  {/* 고르는 중엔 "복사" 덮개를 띄우지 않는다 — 클릭이 복사가 아닐 수 있다(Ctrl+클릭). */}
                  {!picked.size && (
                    <span className="absolute inset-0 hidden items-center justify-center bg-base/70 group-hover/peek:flex">
                      <Copy size={20} className="text-accent" />
                    </span>
                  )}
                  {picked.has(e.name) && (
                    <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white shadow">
                      <Check size={13} strokeWidth={3} />
                    </span>
                  )}
                </span>
                <span className="w-full truncate px-0.5 text-left text-[11px] text-fg-muted">
                  {e.name}
                </span>
              </button>
              {/* 삭제는 **버튼 밖**에 둔다 — 안에 중첩하면 클릭이 위 버튼(경로 복사)으로 새어
                  파일이 안 지워지고 경로만 복사된다. 호버할 때만 보인다. */}
              <button
                onClick={() => remove([e.name])}
                onMouseDown={(ev) => ev.stopPropagation()}
                title={msg.folder.peek.trashTitle(e.name)}
                className="absolute right-1.5 top-1.5 hidden rounded bg-panel/90 p-1 text-fg-dim hover:text-danger group-hover/peek:block"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          </div>
        </div>
      )}

      {picked.size ? (
        // 고르면 안내 줄 자리가 할 일 막대로 바뀐다 — 고른 다음 할 일이 우클릭 메뉴 안에 숨어 있으면 못 찾는다.
        <div className="flex shrink-0 items-center gap-1 px-1 pt-2 text-[12px]">
          <span className="mr-auto font-medium text-accent">{msg.folder.window.pickedCount(pickedNames.length)}</span>
          <PeekBarButton icon={<Copy size={13} />} label={msg.folder.menuCopyPath} title={msg.folder.peek.pickCopyTitle} onClick={() => copy(pickedNames)} />
          <PeekBarButton
            icon={<SquareTerminal size={13} />}
            label={msg.folder.peek.pickPaste}
            title={msg.folder.peek.pickPasteTitle}
            onClick={() => pasteToTerminal(pickedNames)}
          />
          <PeekBarButton icon={<Trash2 size={13} />} title={msg.folder.peek.pickTrashTitle} danger onClick={() => remove(pickedNames)} />
          <PeekBarButton icon={<X size={13} />} title={msg.folder.peek.pickClearTitle} onClick={() => setPicked(NO_PICK)} />
        </div>
      ) : (
        // 클릭이 무엇을 하는지 한 줄로 말한다 — 안 말하면 "왜 창이 안 열리지"가 된다.
        <div className="shrink-0 px-1 pt-2 text-[11px] text-fg-dim">
          {msg.folder.peek.footerHint}
        </div>
      )}

      {lbIndex >= 0 &&
        // body 로 포털한다 — 패널이 화면 밖으로 밀려 `transform` 이 걸리면 그 안의 `fixed` 는 창이 아니라
        // 패널 기준이 된다. 감싸는 z-[52] 는 드롭다운(z-50) 위·토스트(z-[55])·확인 대화상자(z-[60]) 아래 — z-[70] 이던
        // 때는 뷰어가 토스트("이미지를 복사했습니다" 등)를 덮어 결과가 안 보였다. React 이벤트는 포털도 컴포넌트 트리를
        // 따라 오르므로 드롭다운의 클릭 차단·mouseleave 판정은 그대로 먹는다.
        createPortal(
          <div className="fixed inset-0 z-[52]">
            <PhotoViewer
              path={join(images[lbIndex].name)}
              name={images[lbIndex].name}
              index={lbIndex}
              total={images.length}
              onClose={() => setLightbox(null)}
              onStep={stepLightbox}
              filmstrip={{ images, pathOf: join }}
            />
          </div>,
          document.body,
        )}

      {menu && (
        <PeekMenu
          x={menu.x}
          y={menu.y}
          name={menu.name}
          count={targetsOf(menu.name).length}
          onClose={() => setMenu(null)}
          onCopy={() => copy(targetsOf(menu.name))}
          onPaste={() => pasteToTerminal(targetsOf(menu.name))}
          onOpen={() => open(menu.name, "default")}
          onReveal={() => open(menu.name, "reveal")}
          onDelete={() => remove(targetsOf(menu.name))}
        />
      )}
    </div>
  );
}

/** 칸 썸네일 — 뜰 때까지(또는 못 만드는 형식이면 끝까지) 종류 아이콘. 칸은 이미 `relative` 다. */
function PeekThumb({ kind, url }: { kind: FavEntry["kind"]; url: string | undefined }) {
  const [load, setLoad] = useState<"wait" | "ok" | "fail">("wait");
  return (
    <>
      {load !== "ok" &&
        (kind === "video" ? (
          <Film size={22} className="text-fg-dim" />
        ) : kind === "image" ? (
          <ImageIcon size={22} className="text-fg-dim" />
        ) : (
          <FileText size={22} className="text-fg-dim" />
        ))}
      {url && load !== "fail" && (
        <img
          src={url}
          alt=""
          decoding="async"
          // 이미지 위에서 시작한 드래그가 HTML 끌어 놓기로 새면 드래그 상자가 안 그려진다.
          draggable={false}
          onLoad={() => setLoad("ok")}
          onError={() => setLoad("fail")}
          className={`absolute inset-0 h-full w-full object-cover ${load === "ok" ? "" : "invisible"}`}
        />
      )}
    </>
  );
}

/** 우클릭 메뉴 — 구성은 FolderWindow 의 메뉴를 따른다(삭제만 더 있다).
 *  `fixed` 다: 패널 안에 `absolute` 로 두면 그리드가 스크롤/클리핑될 때 잘린다. */
function PeekMenu({
  x,
  y,
  name,
  count,
  onClose,
  onCopy,
  onPaste,
  onOpen,
  onReveal,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  /** 메뉴가 다룰 개수 — 고른 칸 안을 우클릭했으면 고른 전부. 열기·위치 보기는 누른 칸 하나다. */
  count: number;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const msg = useMessages();
  useEffect(() => {
    const close = () => onClose();
    // 캡처 단계에서 먹는다 — 버블이면 드롭다운(TitleBar)의 Esc=닫기도 같이 떠 패널째 닫히고 골라 둔 칸이 날아간다.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed z-[60] min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        // 항목 5 × 31.5 + 구분선 8.7 + 헤더 22 + 패딩 9 ≈ 197 → 여유를 둬 208.
        top: Math.max(0, Math.min(y, window.innerHeight - 208)),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 py-1 text-[11px] text-fg-dim">
        {count > 1 ? msg.folder.window.pickedCount(count) : name}
      </div>
      <div className="my-1 border-t border-edge" />
      <PeekRow
        icon={<Copy size={14} />}
        label={count > 1 ? msg.folder.window.menuCopyPathMany(count) : msg.folder.menuCopyPath}
        onClick={run(onCopy)}
      />
      <PeekRow
        icon={<SquareTerminal size={14} />}
        label={count > 1 ? msg.folder.window.menuPasteToTerminalMany(count) : msg.folder.window.menuPasteToTerminal}
        onClick={run(onPaste)}
      />
      <PeekRow
        icon={<ExternalLink size={14} />}
        label={msg.folder.menuOpenDefault}
        onClick={run(onOpen)}
      />
      <PeekRow
        icon={<FolderOpen size={14} />}
        label={msg.folder.menuReveal}
        onClick={run(onReveal)}
      />
      <div className="my-1 border-t border-edge" />
      <PeekRow
        icon={<Trash2 size={14} />}
        label={count > 1 ? msg.folder.window.menuTrashMany(count) : msg.folder.peek.menuTrash}
        danger
        onClick={run(onDelete)}
      />
    </div>
  );
}

function PeekBarButton({
  icon,
  label,
  title,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label?: string;
  title: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 rounded border border-edge px-2 py-1 ${
        danger ? "text-fg-dim hover:border-danger hover:text-danger" : "text-fg-muted hover:border-accent hover:text-fg"
      }`}
    >
      {icon}
      {label && <span>{label}</span>}
    </button>
  );
}

function PeekRow({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
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
    </button>
  );
}
