import { GitBranch, LayoutGrid } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project } from "../lib/ipc";
import { relativeTime } from "../lib/format";
import { isMac, modLabel } from "../lib/platform";
import { useProjects, useStatus } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
import { useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";

export function StatusBar({ project }: { project: Project | null }) {
  const { data: status, dataUpdatedAt } = useStatus(project?.id ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-panel px-3 text-[11px] text-fg-dim">
      {project ? (
        <>
          <span className="min-w-0 truncate select-text font-mono">
            {project.path}
          </span>
          {status?.branch && (
            <span className="flex shrink-0 items-center gap-1">
              <GitBranch size={10} />
              <span className="font-mono">{status.branch}</span>
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <AggregateButton />
            <AgentChips />
            <span>
              {dataUpdatedAt > 0 &&
                `마지막 갱신 ${relativeTime(dataUpdatedAt, now)}`}
            </span>
          </div>
        </>
      ) : (
        <span>Gitpervisor</span>
      )}
    </footer>
  );
}

// 모아보기 토글 단축키 라벨 — mac은 심볼 관례(⌘⇧A), 그 외는 Ctrl+Shift+A
const hotkeyLabel = isMac ? `${modLabel}⇧A` : `${modLabel}+Shift+A`;

/** 터미널 모아보기 진입 버튼 — 열린 터미널이 하나라도 있을 때만 표시. */
function AggregateButton() {
  const setAggregateOpen = useUi((s) => s.setAggregateOpen);
  const hasTerminals = useTerminals((s) => s.terminals.length > 0);
  if (!hasTerminals) return null;
  return (
    <button
      onClick={() => setAggregateOpen(true)}
      title={`터미널 모아보기 — 여러 터미널을 한 화면에 분할로 (${hotkeyLabel})`}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-raised hover:text-fg"
    >
      <LayoutGrid size={11} /> 모아보기
    </button>
  );
}

/** 현재 AI가 돌고 있는(working) / 막 끝난(done) 프로젝트 칩 — 무지개(.ai-working) 애니메이션,
 *  클릭하면 해당 프로젝트로 이동. 비어 있으면 아무것도 렌더하지 않는다. */
function AgentChips() {
  const byProject = useAgentActivity((s) => s.byProject);
  const { data: projects } = useProjects();
  const selectProject = useUi((s) => s.selectProject);
  const selectedProjectId = useUi((s) => s.selectedProjectId);

  // working을 앞에, done을 뒤에. byProject에 상태가 있는 프로젝트만.
  const chips = (projects ?? [])
    .map((p) => ({ p, state: byProject[p.id] }))
    .filter((x): x is { p: Project; state: "working" | "done" } => !!x.state)
    .sort(
      (a, b) =>
        (a.state === "working" ? 0 : 1) - (b.state === "working" ? 0 : 1),
    );

  if (chips.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {chips.map(({ p, state }) => (
        <button
          key={p.id}
          onClick={() => selectProject(p.id)}
          title={
            state === "working"
              ? "AI 작업 중 — 클릭해 이동"
              : "AI 작업 완료 — 클릭해 확인"
          }
          className={`max-w-[120px] truncate rounded px-1.5 py-0.5 text-[10px] leading-none text-fg ${
            state === "working" ? "ai-working" : "ai-done"
          } ${p.id === selectedProjectId ? "ring-1 ring-accent" : ""}`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}
