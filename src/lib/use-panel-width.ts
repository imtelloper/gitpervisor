import { useEffect, useState } from "react";

/**
 * 드래그로 조절 가능한 패널 폭. localStorage에 영속해 리로드 후에도 유지된다.
 * 반환한 startResize를 패널 우측 가장자리 핸들의 onMouseDown에 연결한다.
 */
export function usePanelWidth(
  storageKey: string,
  initial: number,
  min: number,
  max: number,
  /** 핸들이 패널의 어느 가장자리인지 — "left"면 드래그 방향을 반전한다(우측 패널). */
  side: "left" | "right" = "right",
) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return saved >= min && saved <= max ? saved : initial;
  });

  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const delta = side === "left" ? startX - ev.clientX : ev.clientX - startX;
      setWidth(Math.min(max, Math.max(min, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** 폭을 특정 px로 설정(min/max 클램프) — 핸들 더블클릭 자동맞춤 등에 사용. */
  const resizeTo = (px: number) => setWidth(Math.min(max, Math.max(min, Math.round(px))));

  return { width, startResize, resizeTo };
}

/**
 * 드래그로 조절 가능한 박스 크기(폭·높이). localStorage에 JSON으로 영속한다.
 *
 * 델타가 `usePanelWidth`와 반대인 이유: 이 훅을 쓰는 팝오버는 **우상단 앵커**(right/top 고정)라
 * 왼쪽·아래로 끌어야 커진다. 최대는 클램프하지 않는다 — 호출부의 인라인 maxWidth/maxHeight가
 * 이미 창 크기로 자른다.
 */
export function useDragSize(
  storageKey: string,
  initial: { w: number; h: number },
  min: { w: number; h: number },
) {
  const [size, setSize] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "");
      if (saved?.w >= min.w && saved?.h >= min.h)
        return { w: saved.w as number, h: saved.h as number };
    } catch {
      /* 손상 값은 기본으로 */
    }
    return initial;
  });

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(size));
  }, [storageKey, size]);

  const startResize = (e: React.MouseEvent, axis: "x" | "y" | "both") => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = size;
    const onMove = (ev: MouseEvent) => {
      const w =
        axis === "y" ? start.w : Math.max(min.w, start.w + startX - ev.clientX);
      const h =
        axis === "x" ? start.h : Math.max(min.h, start.h + ev.clientY - startY);
      setSize({ w, h });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor =
      axis === "x" ? "col-resize" : axis === "y" ? "row-resize" : "nesw-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return { size, startResize };
}

/** 사이드 패널 접힘 상태. localStorage에 영속해 리로드 후에도 유지된다. */
export function usePanelCollapsed(storageKey: string) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(storageKey) === "1",
  );
  const toggle = () => {
    const next = !collapsed;
    localStorage.setItem(storageKey, next ? "1" : "0");
    setCollapsed(next);
  };
  return { collapsed, toggle };
}
