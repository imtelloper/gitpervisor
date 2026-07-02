import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

const win = getCurrentWindow();

/** 플로팅 창의 커스텀 타이틀바 — 드래그 영역 + 창 컨트롤(최소화/최대화/닫기).
 *  badge는 창 종류 표시(기본 "터미널" — 기존 사용처 무영향, 리소스 모니터는 "모니터"). */
export function FloatTitleBar({
  title,
  badge = "터미널",
}: {
  title: string;
  badge?: string;
}) {
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-8 shrink-0 cursor-default items-center border-b border-edge bg-panel pl-3 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <img
          src="/logo.png"
          alt=""
          draggable={false}
          className="h-[16px] w-[16px] rounded-[5px]"
        />
        <span className="truncate text-xs font-semibold tracking-wide text-fg">
          {title}
        </span>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-dim">
          {badge}
        </span>
      </div>

      <div data-tauri-drag-region className="h-full flex-1" />

      <div className="flex h-full">
        <CtlButton onClick={() => void win.minimize()} title="최소화">
          <Glyph>
            <line x1="1" y1="5.5" x2="10" y2="5.5" />
          </Glyph>
        </CtlButton>
        <MaxRestoreButton />
        <CtlButton onClick={() => void win.close()} title="닫기" danger>
          <Glyph>
            <path d="M1.5 1.5 L9.5 9.5 M9.5 1.5 L1.5 9.5" />
          </Glyph>
        </CtlButton>
      </div>
    </header>
  );
}

function MaxRestoreButton() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(() => void win.isMaximized().then(setMaximized))
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  return (
    <CtlButton
      onClick={() => void win.toggleMaximize()}
      title={maximized ? "이전 크기로" : "최대화"}
    >
      {maximized ? (
        <Glyph>
          <rect x="1" y="3" width="7" height="7" rx="0.5" />
          <path d="M3.2 3 V1.5 A0.5 0.5 0 0 1 3.7 1 H9.5 A0.5 0.5 0 0 1 10 1.5 V7.3 A0.5 0.5 0 0 1 9.5 7.8 H8" />
        </Glyph>
      ) : (
        <Glyph>
          <rect x="1" y="1" width="9" height="9" rx="0.5" />
        </Glyph>
      )}
    </CtlButton>
  );
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function CtlButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-full w-[40px] items-center justify-center text-fg-muted transition-colors ${
        danger
          ? "hover:bg-[#e81123] hover:text-white"
          : "hover:bg-raised hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
