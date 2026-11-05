// 드래그 상자(마퀴) 선택 — 폴더 창 그리드·목록과 타이틀바 미리보기 그리드가 함께 쓴다(FolderWindow.tsx 에서 옮김, 로직 그대로).
import { useEffect, useRef, useState, type RefObject } from "react";

import { isMod } from "../../lib/platform";

/** 드래그 상자가 이만큼(px) 가장자리에 다가가면 그쪽으로 스크롤한다. */
const EDGE_SCROLL = 24;

export interface MarqueeRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Marquee {
  band: { x: number; y: number; w: number; h: number } | null;
  onMouseDown: (ev: React.MouseEvent<HTMLDivElement>) => void;
  /** 드래그 끝에 따라온 click 이면 true(한 번만) — 그 click 은 칸 선택이 아니다. */
  swallow: () => boolean;
}

/**
 * 드래그 상자 — 그리드·목록 공용. 칸 위에서 시작해도 된다(칸 사이 틈이 8px 라 빈 자리에서만 받으면 거의 못 쓴다). 4px 넘게
 * 움직여야 상자이고, 그 뒤의 click 은 삼킨다. 걸린 칸은 `hitTest`(상자를 놓은 요소 기준 내용 좌표)가 고른다 — 가상 그리드는
 * 화면 밖 칸이 DOM 에 없어 계산으로 판정한다. 상자는 내용 좌표라 스크롤해도 시작점이 내용에 붙어 있고, 가장자리에 대면
 * 그쪽으로 스크롤한다(860장 폴더를 한 번에 훑는 동선).
 */
export function useMarqueeDrag(
  scrollRef: RefObject<HTMLDivElement | null>,
  hitTest: (r: MarqueeRect, host: HTMLElement) => number[],
  onMarqueeStart: (additive: boolean) => void,
  onMarquee: (hits: number[]) => void,
): Marquee {
  const [band, setBand] = useState<Marquee["band"]>(null);
  const swallowClick = useRef(false);
  /** 드래그 도중 바뀔 수 있는 것 — 창 포커스로 목록이 다시 읽히면 칸 수·배치가 바뀐다. */
  const live = useRef({ hitTest, onMarquee });
  live.current = { hitTest, onMarquee };
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);

  const onMouseDown = (ev: React.MouseEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (ev.button !== 0 || ev.shiftKey) return;
    const host = ev.currentTarget;
    const sc = scrollRef.current;
    const r0 = host.getBoundingClientRect();
    const sx = ev.clientX - r0.left;
    const sy = ev.clientY - r0.top;
    const additive = isMod(ev);
    let cx = ev.clientX;
    let cy = ev.clientY;
    let started = false;
    let raf = 0;
    let lastKey = "";
    const update = () => {
      const r = host.getBoundingClientRect();
      // 내용 밖으로는 늘리지 않는다 — 상자가 내용보다 길어지면 스크롤 영역이 따라 늘어 자동 스크롤이 끝없이 내려간다.
      const x = Math.max(0, Math.min(r.width, cx - r.left));
      const y = Math.max(0, Math.min(r.height, cy - r.top));
      const rect = { x1: Math.min(sx, x), y1: Math.min(sy, y), x2: Math.max(sx, x), y2: Math.max(sy, y) };
      setBand({ x: rect.x1, y: rect.y1, w: rect.x2 - rect.x1, h: rect.y2 - rect.y1 });
      const hits = live.current.hitTest(rect, host);
      const key = `${hits.length}:${hits[0]}:${hits[hits.length - 1]}`; // 걸린 칸은 늘 이어진 덩어리다
      if (key !== lastKey) {
        lastKey = key;
        live.current.onMarquee(hits);
      }
    };
    const autoScroll = () => {
      if (sc) {
        const sr = sc.getBoundingClientRect();
        const d =
          cy < sr.top + EDGE_SCROLL ? cy - sr.top - EDGE_SCROLL : cy > sr.bottom - EDGE_SCROLL ? cy - sr.bottom + EDGE_SCROLL : 0;
        if (d) sc.scrollTop += Math.max(-40, Math.min(40, d / 2)); // 스크롤 이벤트가 update 를 부른다
      }
      raf = requestAnimationFrame(autoScroll);
    };
    const move = (e: MouseEvent) => {
      cx = e.clientX;
      cy = e.clientY;
      if (!started) {
        if (Math.hypot(cx - ev.clientX, cy - ev.clientY) < 4) return;
        started = true;
        onMarqueeStart(additive);
        sc?.addEventListener("scroll", update);
        raf = requestAnimationFrame(autoScroll);
      }
      update();
    };
    const end = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      sc?.removeEventListener("scroll", update);
      cancelAnimationFrame(raf);
      endDrag.current = null;
      if (started) {
        swallowClick.current = true;
        setBand(null);
      }
    };
    endDrag.current?.();
    endDrag.current = end;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
  };
  const swallow = () => {
    const s = swallowClick.current;
    swallowClick.current = false;
    return s;
  };
  return { band, onMouseDown, swallow };
}

export function MarqueeBand({ band }: { band: Marquee["band"] }) {
  if (!band) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-sm border border-accent bg-accent/10"
      style={{ left: band.x, top: band.y, width: band.w, height: band.h }}
    />
  );
}
