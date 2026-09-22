import { useMessages } from "../../i18n/ui-language";

/** 패널 가장자리의 드래그 핸들 — 부모는 relative여야 한다. side로 좌/우 가장자리 선택. */
export function ResizeHandle({
  onMouseDown,
  onDoubleClick,
  side = "right",
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  /** 더블클릭 — 보통 내용에 맞춰 폭 자동 조절. */
  onDoubleClick?: (e: React.MouseEvent) => void;
  side?: "left" | "right";
}) {
  const msg = useMessages();
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title={
        onDoubleClick
          ? msg.shell.resizeHandle.dragToResizeOrFit
          : msg.shell.resizeHandle.dragToResize
      }
      className={`absolute top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-accent/60 ${
        side === "left" ? "left-0" : "right-0"
      }`}
    />
  );
}
