import {
  Copy,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { copyText } from "../../lib/clipboard";
import { ipc, type FavEntry } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

/** 미리보기에 그릴 최대 개수 — **최신 순으로** 자른다. 패널이 스크롤되므로 한 화면에 들어갈
 *  필요는 없지만, 무제한이면 폴더가 수백 장일 때(실제 스크린샷 폴더가 225장) 썸네일 요청이
 *  그만큼 나간다. 더 보려면 창을 연다(거기는 '보이는 칸만' 요청하는 펌프가 있다). */
const MAX = 40;

/** 썸네일 변 길이. 칸이 ≈200px 이라 192 도 살짝 모자라지만, 백엔드가 받는 값은 128·192·320
 *  셋뿐이고(캐시 폭주 방지) 320 은 40장이면 전송량이 4배가 된다 — object-cover 라 눈에 안 띈다. */
const THUMB_EDGE = 192;

/** 썸네일을 한 번에 몇 개씩 요청할지. 40장을 동시에 던지면 IPC 큐가 막혀 **목록 자체가** 늦게
 *  뜬다(썸네일은 나중에 채워져도 되지만 칸은 즉시 보여야 한다). FolderWindow 가 펌프를 두는
 *  것과 같은 이유이고, 거기는 수백 칸이라 '보이는 칸만'까지 간다. */
const CONCURRENCY = 4;

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
 */
export function FolderPeek({ path }: { path: string }) {
  const sep = path.includes("\\") ? "\\" : "/";
  const join = (name: string) => `${path.replace(/[\\/]+$/, "")}${sep}${name}`;

  const [files, setFiles] = useState<FavEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; name: string } | null>(
    null,
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
    setThumbs({});
    setMenu(null);
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
        // 썸네일은 CONCURRENCY 개씩 흘려보낸다(위 상수 주석).
        const queue = recent.filter(
          (e) => e.kind === "image" || e.kind === "video",
        );
        let next = 0;
        const pump = async () => {
          while (!dead) {
            const e = queue[next++];
            if (!e) return;
            const url = await ipc.favThumb(join(e.name), THUMB_EDGE).catch(
              () => null, // 못 만드는 형식(svg·손상)은 아이콘으로 남는다 — 창과 같은 처리
            );
            if (dead) return;
            if (url) setThumbs((m) => ({ ...m, [e.name]: url }));
          }
        };
        for (let i = 0; i < CONCURRENCY; i++) void pump();
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

  const toast = (kind: "success" | "error", message: string) =>
    useUi.getState().pushToast(kind, message);

  const copy = (name: string) =>
    void copyText(join(name)).then((ok) =>
      toast(
        ok ? "success" : "error",
        ok ? "경로를 복사했습니다" : "복사에 실패했습니다",
      ),
    );

  const open = (name: string, how: "default" | "reveal") =>
    void ipc
      .favOpen(join(name), how)
      .catch((e) => toast("error", e instanceof Error ? e.message : String(e)));

  /** 확인창을 두지 않는다 — 이 패널의 존재 이유가 "한 번에 끝내기"다. 대신 **휴지통으로** 가고
   *  (백엔드 `fav_delete`), 토스트가 그 사실을 말한다. 목록에서는 즉시 지운다(응답을 기다리면
   *  지워진 칸이 한 박자 남아 같은 파일을 두 번 누르게 된다). 실패하면 되돌린다. */
  const remove = (name: string) => {
    const before = files;
    setFiles((cur) => cur?.filter((e) => e.name !== name) ?? cur);
    setMenu(null);
    void ipc
      .favDelete(join(name))
      .then(() => toast("success", `휴지통으로 보냈습니다 — ${name}`))
      .catch((e) => {
        setFiles(before ?? null);
        toast("error", e instanceof Error ? e.message : String(e));
      });
  };

  return (
    // `right-full` = 드롭다운 **바로 왼쪽에 붙인다**. 틈을 두면 그리로 포인터가 빠지는 순간
    // 컨테이너의 onMouseLeave 가 떠서 패널이 닫힌다. 드롭다운의 자식이라 항목 → 패널 이동은
    // 컨테이너를 벗어나지 않는다(TitleBar 의 showPeek 주석) — `translateX` 로 밀어도 그 관계는
    // 그대로다(DOM 포함 관계가 기준이라 화면 위치와 무관하다).
    <div
      ref={ref}
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
            {files.length}개{files.length === MAX ? "+" : ""}
          </span>
        )}
      </div>

      {error && <div className="px-1 py-3 text-[12px] text-danger">{error}</div>}
      {!error && files === null && (
        <div className="px-1 py-3 text-[12px] text-fg-dim">읽는 중…</div>
      )}
      {!error && files?.length === 0 && (
        <div className="px-1 py-3 text-[12px] text-fg-dim">파일이 없습니다</div>
      )}

      {!!files?.length && (
        // 스크롤은 **그리드만** 한다 — 경로 헤더와 아래 안내는 붙박이다.
        <div className="grid min-h-0 grid-cols-3 gap-2 overflow-y-auto pr-1">
          {files.map((e) => (
            <div key={e.name} className="group/peek relative">
              <button
                onClick={() => copy(e.name)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  setMenu({ x: ev.clientX, y: ev.clientY, name: e.name });
                }}
                title={`${e.name}\n클릭: 경로 복사 · 우클릭: 메뉴`}
                className="flex w-full min-w-0 flex-col items-stretch gap-1 rounded border border-edge/60 p-1 hover:border-accent hover:bg-raised"
              >
                <span className="relative flex h-36 w-full items-center justify-center overflow-hidden rounded bg-base">
                  {thumbs[e.name] ? (
                    <img
                      src={thumbs[e.name]}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : e.kind === "video" ? (
                    <Film size={22} className="text-fg-dim" />
                  ) : e.kind === "image" ? (
                    <ImageIcon size={22} className="text-fg-dim" />
                  ) : (
                    <FileText size={22} className="text-fg-dim" />
                  )}
                  <span className="absolute inset-0 hidden items-center justify-center bg-base/70 group-hover/peek:flex">
                    <Copy size={20} className="text-accent" />
                  </span>
                </span>
                <span className="w-full truncate px-0.5 text-left text-[11px] text-fg-muted">
                  {e.name}
                </span>
              </button>
              {/* 삭제는 **버튼 밖**에 둔다 — 안에 중첩하면 클릭이 위 버튼(경로 복사)으로 새어
                  파일이 안 지워지고 경로만 복사된다. 호버할 때만 보인다. */}
              <button
                onClick={() => remove(e.name)}
                title={`휴지통으로 보내기 — ${e.name}`}
                className="absolute right-1.5 top-1.5 hidden rounded bg-panel/90 p-1 text-fg-dim hover:text-danger group-hover/peek:block"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 클릭이 무엇을 하는지 한 줄로 말한다 — 안 말하면 "왜 창이 안 열리지"가 된다. */}
      <div className="shrink-0 px-1 pt-2 text-[11px] text-fg-dim">
        클릭: 경로 복사 · 우클릭: 메뉴 · 폴더 이름 클릭: 창으로 열기
      </div>

      {menu && (
        <PeekMenu
          x={menu.x}
          y={menu.y}
          name={menu.name}
          onClose={() => setMenu(null)}
          onCopy={() => copy(menu.name)}
          onOpen={() => open(menu.name, "default")}
          onReveal={() => open(menu.name, "reveal")}
          onDelete={() => remove(menu.name)}
        />
      )}
    </div>
  );
}

/** 우클릭 메뉴 — 구성은 FolderWindow 의 메뉴를 따른다(삭제만 더 있다).
 *  `fixed` 다: 패널 안에 `absolute` 로 두면 그리드가 스크롤/클리핑될 때 잘린다. */
function PeekMenu({
  x,
  y,
  name,
  onClose,
  onCopy,
  onOpen,
  onReveal,
  onDelete,
}: {
  x: number;
  y: number;
  name: string;
  onClose: () => void;
  onCopy: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
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
      className="fixed z-[60] min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        // 항목 4 × 31.5 + 구분선 8.7 + 헤더 22 + 패딩 9 ≈ 166 → 여유를 둬 176.
        top: Math.max(0, Math.min(y, window.innerHeight - 176)),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="truncate px-3 py-1 text-[11px] text-fg-dim">{name}</div>
      <div className="my-1 border-t border-edge" />
      <PeekRow icon={<Copy size={14} />} label="경로 복사" onClick={run(onCopy)} />
      <PeekRow
        icon={<ExternalLink size={14} />}
        label="기본 앱으로 열기"
        onClick={run(onOpen)}
      />
      <PeekRow
        icon={<FolderOpen size={14} />}
        label="탐색기에서 보기"
        onClick={run(onReveal)}
      />
      <div className="my-1 border-t border-edge" />
      <PeekRow
        icon={<Trash2 size={14} />}
        label="휴지통으로 보내기"
        danger
        onClick={run(onDelete)}
      />
    </div>
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
