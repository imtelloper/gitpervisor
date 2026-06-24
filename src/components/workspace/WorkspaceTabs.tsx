import {
  ChevronDown,
  Database,
  FileText,
  Globe,
  Plus,
  Send,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useSettings } from "../../queries";
import { useAgentActivity } from "../../stores/agentActivity";
import { useApiClient } from "../../stores/apiclient";
import { useBrowsers } from "../../stores/browser";
import { collectPanes, useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { BrowserPane } from "./BrowserPane";
import { Favicon } from "./Favicon";
import { PaneTreeRoot } from "./PaneTree";
import { ViewerTab } from "./ViewerTab";

// DB 탐색기는 monaco 에디터(~2-3MB)를 끌어온다 — DB 탭을 처음 열 때만 로드해
// 초기 번들에서 monaco를 빼고 첫 화면을 빠르게 한다.
const DbWorkspace = lazy(() =>
  import("../db/DbWorkspace").then((m) => ({ default: m.DbWorkspace })),
);

// API 클라이언트 탭도 monaco(~2-3MB)를 끌어온다 — named export라 동일하게 lazy 래핑.
const ApiClientTab = lazy(() =>
  import("../apiclient/ApiClientTab").then((m) => ({ default: m.ApiClientTab })),
);

/** 중앙 워크스페이스 — Viewer ↔ DB ↔ 터미널 탭 전환 (설계 §16.6, §17). */
export function WorkspaceTabs({ projectId }: { projectId: string }) {
  const allTerminals = useTerminals((s) => s.terminals);
  const terminals = allTerminals.filter((t) => t.projectId === projectId);
  const active = useTerminals((s) => s.activeTab[projectId]) ?? "viewer";
  const setActiveTab = useTerminals((s) => s.setActiveTab);
  const openTerminal = useTerminals((s) => s.openTerminal);
  const closeTab = useTerminals((s) => s.closeTab);
  const dbOpen = useTerminals((s) => s.dbProjects.includes(projectId));
  const closeDbTab = useTerminals((s) => s.closeDbTab);
  const tabIds = useBrowsers((s) => s.tabIds);
  const items = useBrowsers((s) => s.items);
  const browsers = tabIds
    .map((id) => items[id])
    .filter((b): b is NonNullable<typeof b> => !!b && b.projectId === projectId);
  const openBrowser = useBrowsers((s) => s.openBrowser);
  const closeBrowser = useBrowsers((s) => s.closeBrowser);
  const apiTabIds = useApiClient((s) => s.tabIds);
  const apiItems = useApiClient((s) => s.items);
  const apiTabs = apiTabIds
    .map((id) => apiItems[id])
    .filter((t): t is NonNullable<typeof t> => !!t && t.projectId === projectId);
  const openApiClient = useApiClient((s) => s.openTab);
  const closeApiClient = useApiClient((s) => s.closeTab);
  // 터미널 탭별 AI 작업 상태 — 패널(paneId)별 상태를 탭 단위로 집계해 무지개 배경 표시
  const byTerminal = useAgentActivity((s) => s.byTerminal);
  const tabAgentClass = (t: (typeof terminals)[number]): string => {
    let done = false;
    for (const paneId of collectPanes(t.layout)) {
      if (byTerminal[paneId] === "working") return "ai-working";
      if (byTerminal[paneId] === "done") done = true;
    }
    return done ? "ai-done" : "";
  };

  const selectedDiff = useUi((s) => s.selectedDiff);
  const { data: settings } = useSettings();
  const fontSize = settings?.terminalFontSize ?? 13;

  // 파일을 선택하면(어디서든) Viewer 탭으로 자동 전환 — "쉽게쉽게" 전환(설계 §16.6)
  useEffect(() => {
    if (selectedDiff) setActiveTab(projectId, "viewer");
  }, [selectedDiff, projectId, setActiveTab]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-base">
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-edge px-2">
        <TabChip
          active={active === "viewer"}
          icon={<FileText size={13} />}
          label="Viewer"
          onClick={() => setActiveTab(projectId, "viewer")}
        />
        {dbOpen && (
          <TabChip
            active={active === "db"}
            icon={<Database size={13} />}
            label="DB"
            onClick={() => setActiveTab(projectId, "db")}
            onClose={() => closeDbTab(projectId)}
          />
        )}
        {terminals.map((t) => (
          <TabChip
            key={t.id}
            active={active === t.id}
            icon={<TerminalIcon size={13} />}
            label={t.title}
            extraClass={tabAgentClass(t)}
            onClick={() => setActiveTab(projectId, t.id)}
            onClose={() => closeTab(t.id)}
          />
        ))}
        {browsers.map((b) => (
          <TabChip
            key={b.id}
            active={active === b.id}
            icon={b.url ? <Favicon url={b.url} /> : <Globe size={13} />}
            label={b.title}
            onClick={() => setActiveTab(projectId, b.id)}
            onClose={() => closeBrowser(b.id)}
          />
        ))}
        {apiTabs.map((t) => (
          <TabChip
            key={t.id}
            active={active === t.id}
            icon={<Send size={13} />}
            label={t.title}
            onClick={() => setActiveTab(projectId, t.id)}
            onClose={() => closeApiClient(t.id)}
          />
        ))}
        <NewTabControls
          onNewTerminal={() => openTerminal(projectId)}
          onNewBrowser={() => openBrowser(projectId)}
          onNewApiClient={() => openApiClient(projectId)}
        />
      </div>

      <div className="min-h-0 flex-1">
        <div className={active === "viewer" ? "h-full" : "hidden"}>
          <ViewerTab projectId={projectId} />
        </div>
        {dbOpen && (
          <div className={active === "db" ? "h-full" : "hidden"}>
            <Suspense fallback={null}>
              <DbWorkspace />
            </Suspense>
          </div>
        )}
        {terminals.map((t) => (
          <div key={t.id} className={active === t.id ? "h-full" : "hidden"}>
            {active === t.id && (
              <PaneTreeRoot tab={t} projectId={projectId} fontSize={fontSize} />
            )}
          </div>
        ))}
        {/* 브라우저 탭은 항상 마운트 — 네이티브 webview rect 추적(ResizeObserver)이
            끊기지 않게 한다(터미널과 의도된 차이). 비활성은 hidden→rect 0→자동 hide. */}
        {browsers.map((b) => (
          <div key={b.id} className={active === b.id ? "h-full" : "hidden"}>
            <BrowserPane id={b.id} active={active === b.id} />
          </div>
        ))}
        {/* API 클라이언트 탭 — 한 번 열면 마운트 유지(hidden 토글)해 탭 복귀 시 Monaco
            재초기화를 없애고 즉시 전환되게 한다. 첫 마운트에만 monaco 청크가 lazy 로드된다. */}
        {apiTabs.map((t) => (
          <div key={t.id} className={active === t.id ? "h-full" : "hidden"}>
            <Suspense fallback={null}>
              <ApiClientTab
                tabId={t.id}
                projectId={projectId}
                active={active === t.id}
              />
            </Suspense>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 새 탭 — "+"는 빠른 새 터미널, "▾"는 종류 선택(터미널/브라우저). */
function NewTabControls({
  onNewTerminal,
  onNewBrowser,
  onNewApiClient,
}: {
  onNewTerminal: () => void;
  onNewBrowser: () => void;
  onNewApiClient: () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);

  // 탭 줄은 overflow-x-auto라 그 안의 absolute 드롭다운이 세로로 잘린다.
  // 버튼 rect 기준 fixed 위치로 띄워 클리핑을 벗어난다(PaneMenu와 동일 패턴).
  const toggle = () => {
    if (menu) {
      setMenu(null);
      return;
    }
    const r = chevronRef.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 4 });
  };

  return (
    <div className="flex shrink-0 items-center">
      <button
        onClick={onNewTerminal}
        title="새 터미널"
        className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
      >
        <Plus size={14} />
      </button>
      <button
        ref={chevronRef}
        onClick={toggle}
        title="새 탭"
        className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
      >
        <ChevronDown size={12} />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-50 min-w-40 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
            style={{ left: menu.x, top: menu.y }}
          >
            <MenuItem
              icon={<TerminalIcon size={14} />}
              label="새 터미널"
              onClick={() => {
                onNewTerminal();
                setMenu(null);
              }}
            />
            <MenuItem
              icon={<Globe size={14} />}
              label="새 브라우저"
              onClick={() => {
                onNewBrowser();
                setMenu(null);
              }}
            />
            <MenuItem
              icon={<Send size={14} />}
              label="새 API 클라이언트"
              onClick={() => {
                onNewApiClient();
                setMenu(null);
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function TabChip({
  active,
  icon,
  label,
  dim,
  extraClass,
  onClick,
  onClose,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  dim?: boolean;
  /** ai-working/ai-done 등 추가 클래스 (무지개 배경) */
  extraClass?: string;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      title={label}
      className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs ${
        active ? "bg-raised text-fg" : "text-fg-muted hover:bg-raised/60 hover:text-fg"
      } ${dim ? "opacity-60" : ""} ${extraClass ?? ""}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="whitespace-nowrap">{label}</span>
      {onClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title="탭 닫기"
          className="ml-0.5 shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-edge hover:text-fg group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
