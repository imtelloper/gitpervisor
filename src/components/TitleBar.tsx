import { getCurrentWindow } from "@tauri-apps/api/window";
import { LayoutGrid, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { isMac, modLabel } from "../lib/platform";
import { useProjects, useQuarantinedTools } from "../queries";
import { useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";
import { SysMonitor } from "./SysMonitor";

const appWindow = getCurrentWindow();
const isMacOS = /Mac/i.test(navigator.userAgent);

/** 커스텀 타이틀바 — 좌: 브랜드 / 중앙: 프로젝트명 / 우: 시스템 모니터 + 창 컨트롤. */
export function TitleBar() {
  const { data: projects } = useProjects();
  const selectedId = useUi((s) => s.selectedProjectId);
  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  // F11: 최대화 토글 (전역)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        void appWindow.toggleMaximize();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-8 shrink-0 cursor-default items-center border-b border-edge bg-panel pl-3 select-none"
    >
      {/* 중앙: 선택 프로젝트명 (정중앙, 표시 전용) */}
      {selected && (
        <span className="pointer-events-none absolute left-1/2 max-w-[28%] -translate-x-1/2 truncate text-xs font-medium text-fg-muted">
          {selected.name}
        </span>
      )}

      {/* 좌: 브랜드 */}
      <div data-tauri-drag-region className="flex items-center gap-1.5">
        <img
          src="/logo.png"
          alt=""
          draggable={false}
          className="h-[18px] w-[18px] rounded-[5px]"
        />
        <span className="text-xs font-semibold tracking-wide text-fg">
          Gitpervisor
        </span>
      </div>

      {/* 가운데: 드래그 영역 */}
      <div data-tauri-drag-region className="h-full flex-1" />

      {/* 우: 모아보기 토글 + 시스템 모니터 */}
      <AggregateButton />
      <SysMonitor />

      {/* 우: macOS 격리 도구 배지 (차단 항목 있을 때만) */}
      {isMacOS && <QuarantineBadge />}

      {/* 우끝: 창 컨트롤 */}
      <div className="ml-3 flex h-full">
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

// 모아보기 토글 단축키 라벨 — mac은 심볼 관례(⌘⇧A), 그 외는 Ctrl+Shift+A
const hotkeyLabel = isMac ? `${modLabel}⇧A` : `${modLabel}+Shift+A`;

/** 터미널 모아보기 토글 버튼 — 열린 터미널이 하나라도 있을 때만 표시. 클릭할 때마다 열림/닫힘. */
function AggregateButton() {
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const toggleAggregate = useUi((s) => s.toggleAggregate);
  const hasTerminals = useTerminals((s) => s.terminals.length > 0);
  if (!hasTerminals) return null;
  return (
    <button
      onClick={toggleAggregate}
      title={`터미널 모아보기 — 여러 터미널을 한 화면에 분할로 (${hotkeyLabel})`}
      className={`mr-2.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
        aggregateOpen
          ? "bg-raised text-accent"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <LayoutGrid size={11} /> 모아보기
    </button>
  );
}

/**
 * macOS 격리 도구 배지 — brew cask CLI에 박힌 quarantine을 자동 스캔해 카운트로 노출.
 * 클릭하면 Settings를 열어 해제 섹션으로 이동시킨다(섹션은 항상 보이므로 별도 스크롤 불필요).
 */
function QuarantineBadge() {
  const { data } = useQuarantinedTools();
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const count = data?.length ?? 0;
  if (count === 0) return null;
  return (
    <button
      onClick={() => setSettingsOpen(true)}
      title={`brew cask CLI ${count}개가 macOS 격리로 차단됨 — 클릭하여 해제`}
      className="mx-2 flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger hover:bg-danger/20"
    >
      <ShieldAlert size={12} />
      <span>{count}개 차단</span>
    </button>
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
