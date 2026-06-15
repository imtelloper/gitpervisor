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
    const onMove = (ev: MouseEvent) =>
      setWidth(Math.min(max, Math.max(min, startW + ev.clientX - startX)));
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

  return { width, startResize };
}
