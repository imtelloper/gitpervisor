import { ChevronDown, ChevronUp, History } from "lucide-react";
import { useEffect, useRef } from "react";

import { useUi } from "../../stores/ui";
import { BranchesPane } from "./BranchesPane";
import { CommitDetailPane } from "./CommitDetailPane";
import { CommitList } from "./CommitList";

/** 하단 접이식 Log 패널 — 펼치면 브랜치 / 커밋 리스트 / 커밋 상세 3분할 (설계 §5.1). */
export function LogPanel({ projectId }: { projectId: string }) {
  const logOpen = useUi((s) => s.logOpen);
  const toggleLog = useUi((s) => s.toggleLog);
  const logHeight = useUi((s) => s.logHeight);
  const setLogHeight = useUi((s) => s.setLogHeight);

  return (
    <div className="flex shrink-0 flex-col border-t border-edge bg-panel">
      {/* 펼쳤을 때만: 콘텐츠 위에 세로 리사이즈 핸들 (PaneTree Divider와 같은 pointer+rAF 패턴). */}
      {logOpen && (
        <ResizeHandle height={logHeight} onResize={setLogHeight} />
      )}
      <button
        onClick={toggleLog}
        className="flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-semibold text-fg-muted hover:text-fg"
      >
        {logOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        <History size={13} />
        <span>Log</span>
      </button>
      {logOpen && (
        <div
          style={{ height: logHeight }}
          className="flex min-h-0 border-t border-edge"
        >
          <BranchesPane projectId={projectId} />
          <CommitList projectId={projectId} />
          <CommitDetailPane projectId={projectId} />
        </div>
      )}
    </div>
  );
}

/** Log 패널 높이 드래그 핸들 — 위로 끌면 높이 증가. pointermove는 rAF로 합쳐 커밋한다. */
function ResizeHandle({
  height,
  onResize,
}: {
  height: number;
  onResize: (h: number) => void;
}) {
  const teardownRef = useRef<(() => void) | null>(null);
  // 언마운트 시(드래그 도중 Log 접힘 등) 남은 리스너·rAF 정리
  useEffect(() => () => teardownRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let raf = 0;
    let pending = startH;
    const flush = () => {
      raf = 0;
      onResize(pending);
    };
    const move = (ev: PointerEvent) => {
      pending = startH + (startY - ev.clientY); // 위로 끌면(작아지는 clientY) 높이 증가
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      teardownRef.current = null;
    };
    const up = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        onResize(pending);
      }
      teardown();
    };
    teardownRef.current = teardown;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className="h-[3px] shrink-0 cursor-row-resize bg-edge transition-colors hover:bg-accent"
    />
  );
}
