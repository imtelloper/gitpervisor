import { GitBranch, Gauge } from "lucide-react";
import { useEffect, useState } from "react";

import type { Project, UsageWindow } from "../lib/ipc";
import { relativeTime } from "../lib/format";
import { useClaudeUsage, useProjects, useStatus } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
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
      <ClaudeUsageBar />
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

// 사용률 색 — 낮으면 초록, 높을수록 경고/위험 (statusline.js usedColor와 동일 규약).
function usedColor(p: number): string {
  return p >= 80 ? "text-danger" : p >= 50 ? "text-warn" : "text-add";
}
// 리셋까지 남은 시간 — "3h 7m" / "16h 7m" / "7m". 지났거나 없으면 빈 문자열.
function resetIn(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const s = resetsAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
// 리셋 시간이 없는 창의 라벨(모델별 창 등). 알려진 키는 짧은 한국어로.
const KEY_LABEL: Record<string, string> = {
  five_hour: "5시간",
  seven_day: "주간",
  seven_day_opus: "Opus",
  seven_day_oauth: "주간",
};
function windowTail(w: UsageWindow): string {
  return resetIn(w.resetsAt) || KEY_LABEL[w.key] || w.key;
}

/** 좌측 하단 Claude 사용량 바 — statusline.js가 떨군 rate_limits를 "X% 사용 3h 7m · …"로.
 *  파일 없음/오래됨(6시간 초과)/빈 창이면 아무것도 렌더하지 않는다. */
function ClaudeUsageBar() {
  const { data } = useClaudeUsage();
  if (!data || data.windows.length === 0) return null;
  // 6시간 넘게 갱신 안 됐으면(Claude Code 미사용) 숨긴다 — 오래된 수치 오해 방지.
  const ageSec = Math.floor(Date.now() / 1000) - data.updatedAt;
  if (data.updatedAt > 0 && ageSec > 6 * 3600) return null;

  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title="Claude 사용량 (세션 5시간 · 주간) — /usage 와 동일 소스"
    >
      <Gauge size={11} className="shrink-0 text-fg-muted" />
      {data.windows.map((w, i) => {
        const pct = Math.max(0, Math.round(w.usedPercentage));
        const tail = windowTail(w);
        return (
          <span key={w.key} className="flex items-center gap-1">
            {i > 0 && <span className="text-fg-dim/60">·</span>}
            <span className={usedColor(pct)}>{pct}%</span>
            <span className="text-fg-dim">사용{tail ? ` ${tail}` : ""}</span>
          </span>
        );
      })}
    </span>
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
