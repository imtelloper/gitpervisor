import { useQuery } from "@tanstack/react-query";
import { GitBranch, Gauge } from "lucide-react";
import { useEffect, useState } from "react";

import type { Messages } from "../i18n/messages";
import { useMessages } from "../i18n/ui-language";
import type { FileDiff, Project, UsageWindow } from "../lib/ipc";
import { encodingLabel } from "../lib/ipc";
import { relativeTime } from "../lib/format";
import { diffQueryOptions, useClaudeUsage, useProjects, useReopenWithEncoding, useStatus } from "../queries";
import { useAgentActivity } from "../stores/agentActivity";
import { useUi } from "../stores/ui";

export function StatusBar({ project }: { project: Project | null }) {
  const msg = useMessages();
  const { data: status, dataUpdatedAt } = useStatus(project?.id ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <footer className="relative flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-panel px-3 text-[11px] text-fg-dim">
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
            <EncodingPicker projectId={project.id} />
            <span>
              {dataUpdatedAt > 0 &&
                msg.app.statusBar.lastUpdated(relativeTime(dataUpdatedAt, now))}
            </span>
          </div>
        </>
      ) : (
        <span>Gitpervisor</span>
      )}
    </footer>
  );
}

/** 다시 열기 메뉴에 올리는 인코딩 — 국내에서 실제로 마주치는 것들만. 값은 encoding_rs
 *  정규 이름(= 백엔드가 그대로 되받는 label)이다. */
const ENCODING_CHOICES = [
  "UTF-8",
  "EUC-KR",
  "Shift_JIS",
  "GBK",
  "Big5",
  "UTF-16LE",
  "UTF-16BE",
  "windows-1252",
];

/**
 * 지금 뷰어에 열린 파일의 인코딩 표시 + **다른 인코딩으로 다시 열기**(설계 B-K6).
 *
 * 탐지는 언제나 확률이다. 사람이 뒤집을 수단 없이 자동 탐지만 두면 오탐이 곧 버그 신고가
 * 되고, 더 나쁘게는 오탐된 인코딩으로 **저장**된다. 여기서 고른 값은 그 파일에 붙어
 * 저장 경로까지 따라간다.
 *
 * diff 를 **조회하지 않는다**(`enabled: false`) — 뷰어가 이미 채워 둔 캐시만 읽는다. 여기서
 * 진짜 쿼리를 걸면 워처가 diff 를 무효화할 때마다 상태바가 git show 를 한 번씩 더 태운다.
 * (꺼진 구독자는 쿼리를 active 로 만들지 않아 무효화 재조회에 가담하지 않는다.)
 */
function EncodingPicker({ projectId }: { projectId: string }) {
  const msg = useMessages();
  const target = useUi((s) => s.selectedDiff);
  const repoId = useUi((s) => s.selectedDiffRepoId);
  const reopen = useReopenWithEncoding();
  const [open, setOpen] = useState(false);
  const id = repoId ?? projectId;
  // 뷰어와 **같은 옵션**에 enabled:false 만 얹는다 — skipToken 으로 구독하면 뷰어가 깨진다(diffQueryOptions 주석).
  const { data: diff } = useQuery<FileDiff>({ ...diffQueryOptions(id, target), enabled: false });

  if (!target || !diff || diff.isBinary || diff.tooLarge) return null;
  const label = `${encodingLabel(diff.encoding)}${diff.bom ? " (BOM)" : ""}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          diff.lossy
            ? msg.app.statusBar.encodingUncertainTitle
            : msg.app.statusBar.encodingTitle
        }
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono hover:bg-raised hover:text-fg ${
          diff.lossy ? "text-warn" : ""
        }`}
      >
        {label}
        {diff.lossy && " ?"}
      </button>
      {open && (
        <>
          {/* 바깥 클릭으로 닫기 — 메뉴보다 아래(z) 에 깔린다 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-2 z-50 mb-1 min-w-40 rounded-md border border-edge bg-panel py-1 text-[12px] shadow-xl">
            <button
              type="button"
              onClick={() => {
                reopen(id, target, null);
                setOpen(false);
              }}
              className="block w-full px-3 py-1 text-left hover:bg-raised hover:text-fg"
            >
              {msg.app.statusBar.encodingAutoDetect}
            </button>
            <div className="my-1 border-t border-edge" />
            {ENCODING_CHOICES.map((enc) => (
              <button
                key={enc}
                type="button"
                onClick={() => {
                  reopen(id, target, enc);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-1 text-left font-mono hover:bg-raised hover:text-fg ${
                  enc === diff.encoding ? "text-accent" : ""
                }`}
              >
                {encodingLabel(enc)}
              </button>
            ))}
          </div>
        </>
      )}
    </>
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
// 리셋 시간이 없는 창의 라벨(모델별 창 등). 알려진 키는 짧은 이름으로.
function usageKeyLabel(key: string, msg: Messages): string | undefined {
  switch (key) {
    case "five_hour":
      return msg.app.statusBar.usageWindowFiveHour;
    case "seven_day":
    case "seven_day_oauth":
      return msg.app.statusBar.usageWindowWeekly;
    case "seven_day_opus":
      return "Opus";
    default:
      return undefined;
  }
}
function windowTail(w: UsageWindow, msg: Messages): string {
  return resetIn(w.resetsAt) || usageKeyLabel(w.key, msg) || w.key;
}

/** 좌측 하단 Claude 사용량 바 — statusline.js가 떨군 rate_limits를 "X% 사용 3h 7m · …"로.
 *  파일 없음/오래됨(6시간 초과)/빈 창이면 아무것도 렌더하지 않는다. */
function ClaudeUsageBar() {
  const msg = useMessages();
  const { data } = useClaudeUsage();
  if (!data || data.windows.length === 0) return null;
  // 6시간 넘게 갱신 안 됐으면(Claude Code 미사용) 숨긴다 — 오래된 수치 오해 방지.
  const ageSec = Math.floor(Date.now() / 1000) - data.updatedAt;
  if (data.updatedAt > 0 && ageSec > 6 * 3600) return null;

  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title={msg.app.statusBar.usageTitle}
    >
      <Gauge size={11} className="shrink-0 text-fg-muted" />
      {data.windows.map((w, i) => {
        const pct = Math.max(0, Math.round(w.usedPercentage));
        const tail = windowTail(w, msg);
        return (
          <span key={w.key} className="flex items-center gap-1">
            {i > 0 && <span className="text-fg-dim/60">·</span>}
            <span className={usedColor(pct)}>{pct}%</span>
            <span className="text-fg-dim">{msg.app.statusBar.usageUsed(tail)}</span>
          </span>
        );
      })}
    </span>
  );
}

/** 현재 AI가 돌고 있는(working) / 막 끝난(done) 프로젝트 칩 — 무지개(.ai-working) 애니메이션,
 *  클릭하면 해당 프로젝트로 이동. 비어 있으면 아무것도 렌더하지 않는다. */
function AgentChips() {
  const msg = useMessages();
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
              ? msg.app.statusBar.agentWorkingTitle
              : msg.app.statusBar.agentDoneTitle
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
