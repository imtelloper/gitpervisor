// PDF 찾기 바 — 표시와 입력만 한다. 열림 상태·query·결과는 PdfView 가 소유하고 eventBus 도 PdfView 만 안다.

import { ChevronDown, ChevronUp, X } from "lucide-react";

import { TBtn } from "../diff/ImageView";

export interface PdfFindBarProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  /** state = pdf.js FindState: 0 FOUND · 1 NOT_FOUND · 2 WRAPPED · 3 PENDING (null = 아직 없음) */
  status: { state: number | null; current: number; total: number };
  onQueryChange(query: string): void;
  onStep(previous: boolean): void;
  onClose(): void;
}

export default function PdfFindBar({
  inputRef,
  query,
  status,
  onQueryChange,
  onStep,
  onClose,
}: PdfFindBarProps) {
  const count = !query
    ? ""
    : status.state === 1
      ? "결과 없음"
      : status.state === 0 || status.state === 2
        ? `${status.current}/${status.total}`
        : "";
  return (
    <div
      data-pdf-find
      // 좁은 칸에서는 입력칸이 줄어든다(max-w) — 고정 폭이면 왼쪽이 칸 밖으로 잘린다.
      className="absolute right-3 top-2 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded border border-edge bg-panel px-2 py-1 text-xs text-fg-dim shadow-lg"
    >
      <input
        ref={inputRef}
        data-pdf-find-input
        value={query}
        placeholder="문서에서 찾기"
        spellCheck={false}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // 한글 조합 중 Enter 는 조합 확정이다 — 여기서 넘기면 한 번 누름에 두 칸 이동한다.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey);
          } else if (e.key === "Escape") {
            // 전파를 끊는다 — Git 모달이 window 버블 Esc 로 닫히므로 찾기만 닫혀야 한다.
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        className="w-44 min-w-0 rounded border border-edge bg-base px-2 py-0.5 text-fg outline-none focus:border-accent"
      />
      <span data-pdf-find-count className="min-w-14 text-center tabular-nums">
        {count}
      </span>
      <TBtn data-pdf-find-prev label="이전 (Shift+Enter)" onClick={() => onStep(true)}>
        <ChevronUp size={13} />
      </TBtn>
      <TBtn data-pdf-find-next label="다음 (Enter)" onClick={() => onStep(false)}>
        <ChevronDown size={13} />
      </TBtn>
      <TBtn data-pdf-find-close label="닫기 (Esc)" onClick={onClose}>
        <X size={13} />
      </TBtn>
    </div>
  );
}
