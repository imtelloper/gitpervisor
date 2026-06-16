import { getCurrentWindow } from "@tauri-apps/api/window";
import { GitBranch, GitFork } from "lucide-react";
import { useEffect, useState } from "react";

import { useProjects, useStatus } from "../queries";
import { useUi } from "../stores/ui";

const appWindow = getCurrentWindow();

/** 커스텀 타이틀바 — OS 기본 대신 앱 테마에 맞춘 프레임 (decorations:false). */
export function TitleBar() {
  const { data: projects } = useProjects();
  const selectedId = useUi((s) => s.selectedProjectId);
  const selected = projects?.find((p) => p.id === selectedId) ?? null;
  const { data: status } = useStatus(selectedId ?? null);

  return (
    <header
      data-tauri-drag-region
      className="flex h-8 shrink-0 cursor-default items-center gap-2 border-b border-edge bg-panel pl-3 select-none"
    >
      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <GitFork size={14} className="text-accent" />
        <span className="text-xs font-semibold tracking-wide text-fg">
          Gitpervisor
        </span>
      </div>

      <div
        data-tauri-drag-region
        className="flex flex-1 items-center justify-center gap-1.5 text-[11px] text-fg-dim"
      >
        {selected && (
          <>
            <span className="max-w-[40%] truncate text-fg-muted">
              {selected.name}
            </span>
            {status?.branch && (
              <span className="flex items-center gap-0.5 font-mono">
                <GitBranch size={10} />
                {status.branch}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex h-full">
        <CtlButton onClick={() => void appWindow.minimize()} title="최소화">
          <Glyph>
            <line x1="1" y1="5.5" x2="10" y2="5.5" />
          </Glyph>
        </CtlButton>
        <MaxRestoreButton />
        <CtlButton onClick={() => void appWindow.close()} title="닫기" danger>
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
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => void appWindow.isMaximized().then(setMaximized))
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  return (
    <CtlButton
      onClick={() => void appWindow.toggleMaximize()}
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
      className={`flex h-full w-[44px] items-center justify-center text-fg-muted transition-colors ${
        danger
          ? "hover:bg-[#e81123] hover:text-white"
          : "hover:bg-raised hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
