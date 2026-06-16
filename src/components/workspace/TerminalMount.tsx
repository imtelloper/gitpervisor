import { RotateCw } from "lucide-react";
import { useEffect, useRef } from "react";

import { attachTerminal, createTerminal, disposeTerminal, fitTerminal } from "../../lib/terminal";
import { useTerminals, type TermTab } from "../../stores/terminals";

/**
 * 터미널 호스트 — xterm 인스턴스(레지스트리 소유)를 이 컨테이너에 붙인다.
 * 비활성 탭이 되면 언마운트되지만 PTY·xterm·스크롤백은 레지스트리에 살아남는다(설계 §16.5).
 */
export function TerminalMount({ tab, fontSize }: { tab: TermTab; fontSize: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    createTerminal({ id: tab.id, projectId: tab.projectId, fontSize });
    const el = ref.current;
    if (el) attachTerminal(tab.id, el);

    const ro = new ResizeObserver(() => fitTerminal(tab.id));
    if (el) ro.observe(el);
    return () => ro.disconnect();
    // fontSize는 생성 시점에만 쓰인다 — 변경은 새 터미널부터 반영
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  return (
    <div className="relative h-full w-full">
      <div ref={ref} className="h-full w-full" />
      {tab.status === "exited" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-base/70 text-sm text-fg-muted">
          <span>프로세스가 종료되었습니다</span>
          <button
            onClick={() => {
              disposeTerminal(tab.id);
              createTerminal({ id: tab.id, projectId: tab.projectId, fontSize });
              if (ref.current) attachTerminal(tab.id, ref.current);
              useTerminals.getState().setStatus(tab.id, "live");
            }}
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <RotateCw size={13} /> 재시작
          </button>
        </div>
      )}
    </div>
  );
}
