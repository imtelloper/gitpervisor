import {
  Maximize2,
  Minimize2,
  RotateCw,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  attachTerminal,
  createTerminal,
  disposeTerminal,
  fitTerminal,
} from "../../lib/terminal";
import { useTerminals } from "../../stores/terminals";

/**
 * 단일 터미널 패널 — xterm 인스턴스(레지스트리 소유)를 이 컨테이너에 붙인다.
 * 우클릭 → 분할/최대화/닫기 메뉴 (Windows Terminal 스타일).
 */
export function TerminalPane({
  tabId,
  projectId,
  paneId,
  active,
  fontSize,
}: {
  tabId: string;
  projectId: string;
  paneId: string;
  active: boolean;
  fontSize: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const status = useTerminals((s) => s.paneStatus[paneId]) ?? "live";
  const maximized = useTerminals(
    (s) => s.terminals.find((t) => t.id === tabId)?.maximizedPaneId === paneId,
  );
  const setActivePane = useTerminals((s) => s.setActivePane);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    createTerminal({ id: paneId, projectId, fontSize });
    const el = ref.current;
    if (el) attachTerminal(paneId, el);
    const ro = new ResizeObserver(() => fitTerminal(paneId));
    if (el) ro.observe(el);
    return () => ro.disconnect();
    // fontSize는 생성 시점에만 쓰인다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId]);

  return (
    <div
      className={`relative h-full w-full ${
        active ? "outline outline-1 -outline-offset-1 outline-accent" : ""
      }`}
      onMouseDown={() => setActivePane(tabId, paneId)}
      onContextMenu={(e) => {
        e.preventDefault();
        setActivePane(tabId, paneId);
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div ref={ref} className="h-full w-full" />

      {status === "exited" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-base/70 text-sm text-fg-muted">
          <span>프로세스가 종료되었습니다</span>
          <button
            onClick={() => {
              disposeTerminal(paneId);
              createTerminal({ id: paneId, projectId, fontSize });
              if (ref.current) attachTerminal(paneId, ref.current);
              useTerminals.getState().setPaneStatus(paneId, "live");
            }}
            className="flex items-center gap-1.5 rounded border border-edge px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <RotateCw size={13} /> 재시작
          </button>
        </div>
      )}

      {menu && (
        <PaneMenu
          tabId={tabId}
          paneId={paneId}
          maximized={!!maximized}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function PaneMenu({
  tabId,
  paneId,
  maximized,
  x,
  y,
  onClose,
}: {
  tabId: string;
  paneId: string;
  maximized: boolean;
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ts = useTerminals();

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
      className="fixed z-50 min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 240),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Item
        icon={<SplitSquareHorizontal size={14} />}
        label="오른쪽으로 분할"
        hint="Ctrl+Shift+D"
        onClick={run(() => ts.splitPane(tabId, paneId, "row", false))}
      />
      <Item
        icon={<SplitSquareHorizontal size={14} />}
        label="왼쪽으로 분할"
        onClick={run(() => ts.splitPane(tabId, paneId, "row", true))}
      />
      <Item
        icon={<SplitSquareVertical size={14} />}
        label="아래로 분할"
        hint="Ctrl+Shift+E"
        onClick={run(() => ts.splitPane(tabId, paneId, "col", false))}
      />
      <Item
        icon={<SplitSquareVertical size={14} />}
        label="위로 분할"
        onClick={run(() => ts.splitPane(tabId, paneId, "col", true))}
      />
      <div className="my-1 border-t border-edge" />
      <Item
        icon={maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        label={maximized ? "패널 최대화 해제" : "패널 최대화"}
        onClick={run(() => ts.toggleMaximize(tabId, paneId))}
      />
      <Item
        icon={<X size={14} />}
        label="패널 닫기"
        hint="Ctrl+Shift+W"
        danger
        onClick={run(() => ts.closePane(tabId, paneId))}
      />
    </div>
  );
}

function Item({
  icon,
  label,
  hint,
  danger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raised ${
        danger ? "text-danger" : "text-fg-muted hover:text-fg"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-fg-dim">{hint}</span>}
    </button>
  );
}
