import {
  Database,
  FileText,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { useSettings } from "../../queries";
import { useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { PaneTreeRoot } from "./PaneTree";
import { ViewerTab } from "./ViewerTab";

// DB 탐색기는 monaco 에디터(~2-3MB)를 끌어온다 — DB 탭을 처음 열 때만 로드해
// 초기 번들에서 monaco를 빼고 첫 화면을 빠르게 한다.
const DbWorkspace = lazy(() =>
  import("../db/DbWorkspace").then((m) => ({ default: m.DbWorkspace })),
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
            onClick={() => setActiveTab(projectId, t.id)}
            onClose={() => closeTab(t.id)}
          />
        ))}
        <button
          onClick={() => openTerminal(projectId)}
          title="새 터미널"
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <Plus size={14} />
        </button>
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
      </div>
    </section>
  );
}

function TabChip({
  active,
  icon,
  label,
  dim,
  onClick,
  onClose,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  dim?: boolean;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      title={label}
      className={`group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2 text-xs ${
        active ? "bg-raised text-fg" : "text-fg-muted hover:bg-raised/60 hover:text-fg"
      } ${dim ? "opacity-60" : ""}`}
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
