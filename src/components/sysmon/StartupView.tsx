// 리소스 모니터 시작프로그램 탭 — 위: 시작프로그램(§4.4), 아래: 예약 작업(§4.5). DOCS/pc-care-design.md.

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Messages } from "../../i18n/messages";
import { fmtDateTime } from "../../i18n/format-locale";
import { useMessages } from "../../i18n/ui-language";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import type { ScheduledTaskState, StartupScope } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

type Text = Messages["pccareStartup"];

function scopeLabel(t: Text, s: StartupScope): string {
  switch (s) {
    case "user":
      return t.scopeUser;
    case "machine":
      return t.scopeMachine;
    default: {
      const never: never = s;
      return never;
    }
  }
}

function stateLabel(t: Text, s: ScheduledTaskState): string {
  switch (s) {
    case "ready":
      return t.stateReady;
    case "running":
      return t.stateRunning;
    case "disabled":
      return t.stateDisabled;
    case "queued":
      return t.stateQueued;
    case "unknown":
      return t.stateUnknown;
    default: {
      const never: never = s;
      return never;
    }
  }
}

function fmtWhen(ms: number | null): string {
  return ms == null ? "—" : fmtDateTime(new Date(ms));
}

function fmtHex(n: number | null): string {
  return n == null ? "—" : `0x${n.toString(16).toUpperCase().padStart(8, "0")}`;
}

function Toggle({
  on,
  disabled,
  title,
  onClick,
}: {
  on: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-[14px] w-[26px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        on ? "bg-accent" : "bg-edge"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-base transition-[left] ${
          on ? "left-[14px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

function SectionHeader({
  title,
  count,
  fetching,
  onRefresh,
  refreshLabel,
  children,
}: {
  title: string;
  count: string | null;
  fetching: boolean;
  onRefresh: () => void;
  refreshLabel: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 py-1.5 text-[11px]">
      <span className="font-medium text-fg">{title}</span>
      {count ? <span className="text-fg-dim">{count}</span> : null}
      <div className="flex-1" />
      {children}
      <button
        type="button"
        onClick={onRefresh}
        title={refreshLabel}
        className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
      >
        <RefreshCw size={12} className={fetching ? "animate-spin" : ""} />
      </button>
    </div>
  );
}

/** 읽지 못한 위치·오류·빈 목록을 표 아래 흐린 줄로 — 빈 표만 남기면 "없음"과 "못 읽음"이 구분되지 않는다. */
function Notes({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="space-y-0.5 px-3 py-2 text-[11px] text-fg-dim">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

export function StartupView() {
  const msg = useMessages();
  const t = msg.pccareStartup;
  const qc = useQueryClient();
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const [includeMicrosoft, setIncludeMicrosoft] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // 시작프로그램·예약 작업은 저절로 바뀌는 일이 드물다 — 폴링 없이 열 때와 새로고침·토글 뒤에만 읽는다.
  const startup = useQuery({
    queryKey: ["pccare-startup"],
    queryFn: () => ipc.startupList(),
    retry: false,
  });
  const tasks = useQuery({
    queryKey: ["pccare-tasks", includeMicrosoft],
    queryFn: () => ipc.scheduledTasksList(includeMicrosoft),
    retry: false,
  });
  const refreshStartup = () => void qc.invalidateQueries({ queryKey: ["pccare-startup"] });
  const refreshTasks = () => void qc.invalidateQueries({ queryKey: ["pccare-tasks"] });

  // 관리자 권한이 필요하면 같은 호출을 elevate:true 로 다시 부를 수 있게 토스트에 버튼을 단다.
  const execute = (
    key: string,
    run: (elevate: boolean) => Promise<void>,
    done: string,
    refresh: () => void,
    elevate: boolean,
  ) => {
    setBusy(key);
    run(elevate)
      .then(() => pushToast("success", done))
      .catch((e: unknown) => {
        if (!elevate && isIpcError(e) && e.code === "PERMISSION_DENIED") {
          pushToast(
            "error",
            e.message,
            { label: t.retryElevated, run: () => execute(key, run, done, refresh, true) },
            { durationMs: 15_000 },
          );
        } else {
          pushToast("error", errorMessage(e));
        }
      })
      .finally(() => {
        setBusy(null);
        refresh();
      });
  };

  const toggleStartup = (id: string, name: string, enabled: boolean) => {
    const next = !enabled;
    askConfirm({
      title: next ? t.turnOn : t.turnOff,
      message: next ? t.confirmStartupOn(name) : t.confirmStartupOff(name),
      confirmLabel: next ? t.turnOn : t.turnOff,
      danger: !next,
      onConfirm: () =>
        execute(
          id,
          (elevate) => ipc.startupSetEnabled(id, next, elevate),
          next ? t.doneOn(name) : t.doneOff(name),
          refreshStartup,
          false,
        ),
    });
  };

  const toggleTask = (path: string, name: string, enabled: boolean) => {
    const next = !enabled;
    askConfirm({
      title: next ? t.turnOn : t.turnOff,
      message: next ? t.confirmTaskOn(name) : t.confirmTaskOff(name),
      detail: path,
      confirmLabel: next ? t.turnOn : t.turnOff,
      danger: !next,
      onConfirm: () =>
        execute(
          path,
          (elevate) => ipc.scheduledTaskSetEnabled(path, next, elevate),
          next ? t.doneOn(name) : t.doneOff(name),
          refreshTasks,
          false,
        ),
    });
  };

  const startupItems = startup.data?.items ?? [];
  const startupNotes = [
    ...(startup.error ? [t.loadFailed(errorMessage(startup.error))] : []),
    ...(startup.data?.unreadable ?? []),
    ...(startup.data && startupItems.length === 0 ? [t.empty] : []),
    ...(startup.isLoading ? [t.loading] : []),
  ];
  const taskItems = tasks.data?.tasks ?? [];
  const taskNotes = [
    ...(tasks.error ? [t.loadFailed(errorMessage(tasks.error))] : []),
    ...(tasks.data?.unreadable ?? []),
    ...(tasks.data && taskItems.length === 0 ? [t.empty] : []),
    ...(tasks.isLoading ? [t.loading] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── 시작프로그램 ── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <SectionHeader
          title={t.startupTitle}
          count={startup.data ? t.count(startupItems.length) : null}
          fetching={startup.isFetching}
          onRefresh={refreshStartup}
          refreshLabel={t.refresh}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="border-b border-edge text-fg-dim">
                <th className="w-[44px] px-2 py-1.5 text-left font-medium">{t.columnEnabled}</th>
                <th className="w-[28%] px-2 py-1.5 text-left font-medium">{t.columnName}</th>
                <th className="px-2 py-1.5 text-left font-medium">{t.columnCommand}</th>
                <th className="w-[24%] px-2 py-1.5 text-left font-medium">{t.columnLocation}</th>
              </tr>
            </thead>
            <tbody>
              {startupItems.map((it) => (
                <tr key={it.id} className="border-b border-edge/50 hover:bg-raised/50">
                  <td className="px-2 py-1">
                    <Toggle
                      on={it.enabled}
                      disabled={busy === it.id}
                      title={it.enabled ? t.toggleOnTitle : t.toggleOffTitle}
                      onClick={() => toggleStartup(it.id, it.name, it.enabled)}
                    />
                  </td>
                  <td className={`truncate px-2 py-1 ${it.enabled ? "text-fg" : "text-fg-dim"}`} title={it.name}>
                    {it.name}
                  </td>
                  <td className="truncate px-2 py-1 font-mono text-[10px] text-fg-dim" title={it.command}>
                    {it.command}
                  </td>
                  <td className="truncate px-2 py-1 text-fg-dim" title={it.location}>
                    {scopeLabel(t, it.scope)} · {it.location}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Notes lines={startupNotes} />
        </div>
      </div>

      {/* ── 예약 작업 ── */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-edge">
        <SectionHeader
          title={t.tasksTitle}
          count={tasks.data ? t.count(taskItems.length) : null}
          fetching={tasks.isFetching}
          onRefresh={refreshTasks}
          refreshLabel={t.refresh}
        >
          <label className="flex items-center gap-1 text-fg-dim" title={t.showMicrosoftTitle}>
            <input
              type="checkbox"
              checked={includeMicrosoft}
              onChange={(e) => setIncludeMicrosoft(e.target.checked)}
              className="accent-accent"
            />
            {t.showMicrosoft}
          </label>
        </SectionHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="border-b border-edge text-fg-dim">
                <th className="w-[44px] px-2 py-1.5 text-left font-medium">{t.columnEnabled}</th>
                <th className="px-2 py-1.5 text-left font-medium">{t.columnName}</th>
                <th className="w-[72px] px-2 py-1.5 text-left font-medium">{t.columnState}</th>
                <th className="w-[132px] px-2 py-1.5 text-left font-medium">{t.columnLastRun}</th>
                <th className="w-[132px] px-2 py-1.5 text-left font-medium">{t.columnNextRun}</th>
                <th className="w-[84px] px-2 py-1.5 text-left font-medium">{t.columnLastResult}</th>
              </tr>
            </thead>
            <tbody>
              {taskItems.map((task) => (
                <tr key={task.path} className="border-b border-edge/50 hover:bg-raised/50">
                  <td className="px-2 py-1">
                    <Toggle
                      on={task.enabled}
                      disabled={!task.canToggle || busy === task.path}
                      title={
                        !task.canToggle
                          ? t.readOnlyTitle
                          : task.enabled
                            ? t.toggleOnTitle
                            : t.toggleOffTitle
                      }
                      onClick={() => toggleTask(task.path, task.name, task.enabled)}
                    />
                  </td>
                  <td
                    className="truncate px-2 py-1"
                    title={[task.path, task.command, task.author ? t.authorTip(task.author) : null]
                      .filter(Boolean)
                      .join("\n")}
                  >
                    <span className={task.enabled ? "text-fg" : "text-fg-dim"}>{task.name}</span>
                    {task.path !== task.name ? (
                      <span className="ml-1.5 text-[10px] text-fg-dim">{task.path}</span>
                    ) : null}
                  </td>
                  <td className="truncate px-2 py-1 text-fg-dim">{stateLabel(t, task.state)}</td>
                  <td className="truncate px-2 py-1 tabular-nums text-fg-dim">{fmtWhen(task.lastRunMs)}</td>
                  <td className="truncate px-2 py-1 tabular-nums text-fg-dim">{fmtWhen(task.nextRunMs)}</td>
                  <td className="truncate px-2 py-1 font-mono text-[10px] text-fg-dim">
                    {fmtHex(task.lastResult)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Notes lines={taskNotes} />
        </div>
      </div>
    </div>
  );
}
