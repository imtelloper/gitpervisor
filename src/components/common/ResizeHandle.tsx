/** 패널 우측 가장자리의 드래그 핸들 — 부모는 relative여야 한다. */
export function ResizeHandle({
  onMouseDown,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      title="드래그하여 폭 조절"
      className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-accent/60"
    />
  );
}
