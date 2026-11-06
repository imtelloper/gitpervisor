import { Image as ImageIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { favThumbUrl, useFavThumbToken, useThumbImgRetry } from "../../lib/fav-thumb";
import type { FavEntry } from "../../lib/ipc";

/** 칸 한 변(px)·칸 사이·양끝 여백. 칸 폭이 고정이라 스크롤 위치만으로 보이는 범위를 계산한다. */
const CELL = 56;
const GAP = 4;
const PAD = 8;
const STEP = CELL + GAP;
/** 보이는 범위 양옆으로 더 그려 두는 칸 수 — 빨리 밀어도 빈 칸이 비치지 않게. */
const OVERSCAN = 8;
/** 칸(56px)엔 128 이면 되지만 그리드 기본(중간, 192)·타이틀바 미리보기와 같은 크기여야 디스크 캐시를 같이 쓴다 —
 *  128 이면 뷰어를 여는 순간 칸 25개를 새로 해독해 큰 그림 앞에 줄을 섰다(태스크 79 실측 7초). */
const FILMSTRIP_EDGE = 192;

/**
 * 사진 뷰어 아래 필름스트립(설계 D4). 썸네일은 그리드와 같은 스킴·크기(192)라 캐시를 같이 쓴다.
 *
 * 보이는 칸만 DOM 에 그린다 — 폴더 창 그리드와 같은 이유다: 3천 장 폴더에서 칸 전부를 그리면 썸네일 요청이 그만큼
 * 한꺼번에 나간다(`loading="lazy"` 는 가로 스크롤 상자 안에서 믿을 수 없다).
 */
export function Filmstrip({
  images,
  pathOf,
  index,
  onPick,
}: {
  images: FavEntry[];
  pathOf: (name: string) => string;
  index: number;
  onPick: (i: number) => void;
}) {
  const token = useFavThumbToken();
  const ref = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWin((w) => (w.left === el.scrollLeft && w.width === el.clientWidth ? w : { left: el.scrollLeft, width: el.clientWidth }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, []);

  // 지금 장이 화면 밖일 때만 가운데로 — 안에 있으면 두어야 훑던 자리가 클릭마다 튀지 않는다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const left = PAD + index * STEP;
    if (left < el.scrollLeft || left + CELL > el.scrollLeft + el.clientWidth)
      el.scrollLeft = left - (el.clientWidth - CELL) / 2;
  }, [index, images.length]);

  const first = Math.max(0, Math.floor((win.left - PAD) / STEP) - OVERSCAN);
  const last = Math.min(images.length - 1, Math.ceil((win.left + win.width) / STEP) + OVERSCAN);
  const cells = [];
  for (let i = first; i <= last; i++) {
    const e = images[i];
    cells.push(
      <Cell
        // 이름|mtime|크기 — 같은 이름으로 다시 쓴 파일은 새 칸(새 썸네일 URL·실패 상태 초기화). 그리드 thumbKey 와 같다.
        key={`${e.name}|${e.mtimeMs}|${e.size}`}
        name={e.name}
        url={token ? favThumbUrl(pathOf(e.name), e, FILMSTRIP_EDGE, token) : undefined}
        left={PAD + i * STEP}
        current={i === index}
        onClick={() => onPick(i)}
      />,
    );
  }

  return (
    <div
      ref={ref}
      data-photo-filmstrip
      // 세로 휠로도 민다 — 가로 스크롤바만 있는 띠라 휠이 아무 일도 안 하면 손이 간다.
      onWheel={(e) => {
        if (ref.current) ref.current.scrollLeft += e.deltaY;
      }}
      className="h-[76px] shrink-0 overflow-x-auto overflow-y-hidden border-t border-edge"
    >
      <div className="relative h-full" style={{ width: PAD * 2 + images.length * STEP - GAP }}>
        {cells}
      </div>
    </div>
  );
}

function Cell({
  name,
  url,
  left,
  current,
  onClick,
}: {
  name: string;
  url: string | undefined;
  left: number;
  current: boolean;
  onClick: () => void;
}) {
  const retry = useThumbImgRetry(url);
  return (
    <button
      title={name}
      onClick={onClick}
      style={{ left, width: CELL, height: CELL }}
      className={`absolute top-1.5 flex items-center justify-center overflow-hidden rounded border bg-base ${
        current ? "border-accent ring-1 ring-accent" : "border-edge opacity-60 hover:opacity-100"
      }`}
    >
      {url && retry.attempt !== null ? (
        // alt 는 비운다 — e2e 60 이 `img[alt="<이름>"]` 로 뷰어 본 그림을 찾는다(썸네일이 먼저 걸리면 안 된다).
        <img
          key={retry.attempt}
          src={url}
          alt=""
          decoding="async"
          draggable={false}
          onError={retry.onError}
          className="h-full w-full object-cover"
        />
      ) : (
        <ImageIcon size={16} className="text-fg-dim" />
      )}
    </button>
  );
}
