// 리소스 모니터 서비스 탭 — DOCS/pc-care-design.md §4.6.

import { Copy, Play, RefreshCw, RotateCw, Search, Settings2, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { copyWithToast } from "../../lib/clipboard";
import { errorMessage, ipc, isIpcError } from "../../lib/ipc";
import type {
  ServiceAction,
  ServiceInfo,
  ServiceStartType,
  ServiceStartTypeChoice,
  ServiceState,
} from "../../lib/ipc";
import { useUi } from "../../stores/ui";

type Text = Messages["pccareServices"];

function stateLabel(t: Text, s: ServiceState): string {
  switch (s) {
    case "running":
      return t.stateRunning;
    case "stopped":
      return t.stateStopped;
    case "startPending":
      return t.stateStartPending;
    case "stopPending":
      return t.stateStopPending;
    case "paused":
      return t.statePaused;
    case "unknown":
      return t.stateUnknown;
    default: {
      const never: never = s;
      return never;
    }
  }
}

function stateBadge(s: ServiceState): string {
  switch (s) {
    case "running":
      return "bg-ok/15 text-ok";
    case "startPending":
    case "stopPending":
    case "paused":
      return "bg-warn/15 text-warn";
    case "stopped":
    case "unknown":
      return "bg-raised text-fg-dim";
    default: {
      const never: never = s;
      return never;
    }
  }
}

function startTypeLabel(t: Text, s: ServiceStartType): string {
  switch (s) {
    case "auto":
      return t.startAuto;
    case "autoDelayed":
      return t.startAutoDelayed;
    case "manual":
      return t.startManual;
    case "disabled":
      return t.startDisabled;
    case "boot":
      return t.startBoot;
    case "system":
      return t.startSystem;
    case "unknown":
      return t.startUnknown;
    default: {
      const never: never = s;
      return never;
    }
  }
}

function actionLabel(t: Text, a: ServiceAction): string {
  switch (a) {
    case "start":
      return t.actionStart;
    case "stop":
      return t.actionStop;
    case "restart":
      return t.actionRestart;
    default: {
      const never: never = a;
      return never;
    }
  }
}

const START_CHOICES: ServiceStartTypeChoice[] = ["auto", "manual", "disabled"];

interface RowMenu {
  x: number;
  y: number;
  s: ServiceInfo;
}

export function ServicesView() {
  const msg = useMessages();
  const t = msg.pccareServices;
  const qc = useQueryClient();
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const [query, setQuery] = useState("");
  const [includeMicrosoft, setIncludeMicrosoft] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);

  const queryKey = ["pccare-services", includeMicrosoft] as const;
  // 탭이 마운트된 동안만 폴링 — 탭을 떠나면 이 컴포넌트가 내려가 관찰자도 사라진다.
  const { data, error, isFetching } = useQuery({
    queryKey,
    queryFn: () => ipc.servicesList(includeMicrosoft),
    refetchInterval: 5000,
    retry: false,
    // 체크박스를 바꾸면 키가 바뀐다 — 새 목록이 올 때까지 이전 목록을 둬야 체크박스(data 로 그린다)와 표가 사라지지 않는다.
    placeholderData: keepPreviousData,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["pccare-services"] });

  const rows = useMemo(() => {
    const list = data?.services ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [data, query]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // 관리자 권한이 필요하면 같은 호출을 elevate:true 로 다시 부를 수 있게 토스트에 버튼을 단다.
  const execute = (name: string, run: (elevate: boolean) => Promise<void>, done: string, elevate: boolean) => {
    setBusy(name);
    run(elevate)
      .then(() => pushToast("success", done))
      .catch((e: unknown) => {
        if (!elevate && isIpcError(e) && e.code === "PERMISSION_DENIED") {
          pushToast(
            "error",
            e.message,
            { label: t.retryElevated, run: () => execute(name, run, done, true) },
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

  const control = (s: ServiceInfo, action: ServiceAction) => {
    setMenu(null);
    const label = actionLabel(t, action);
    askConfirm({
      title: label,
      message:
        t.confirmControl(label, s.displayName) + (action === "start" ? "" : ` ${t.stopWarning}`),
      detail: s.name,
      confirmLabel: label,
      danger: action !== "start",
      onConfirm: () =>
        execute(
          s.name,
          (elevate) => ipc.serviceControl(s.name, action, elevate),
          t.controlDone(label, s.displayName),
          false,
        ),
    });
  };

  const setStartType = (s: ServiceInfo, choice: ServiceStartTypeChoice) => {
    setMenu(null);
    const label = startTypeLabel(t, choice);
    askConfirm({
      title: t.confirmStartTypeTitle,
      message:
        t.confirmStartType(s.displayName, label) +
        (choice === "disabled" ? ` ${t.disableWarning}` : ""),
      detail: s.name,
      confirmLabel: label,
      danger: choice === "disabled",
      onConfirm: () =>
        execute(
          s.name,
          (elevate) => ipc.serviceSetStartType(s.name, choice, elevate),
          t.startTypeDone(s.displayName, label),
          false,
        ),
    });
  };

  const controllable = data?.controlSupported ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-panel px-3 py-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            className="w-44 rounded border border-edge bg-base py-1 pl-6 pr-2 text-[11px] text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
          />
        </div>
        {data?.filtersMicrosoft ? (
          <label
            title={t.showMicrosoftTitle}
            className="flex cursor-pointer items-center gap-1.5 text-[11px] text-fg-muted"
          >
            <input
              type="checkbox"
              checked={includeMicrosoft}
              onChange={(e) => setIncludeMicrosoft(e.target.checked)}
            />
            {t.showMicrosoft}
          </label>
        ) : null}
        <div className="flex-1" />
        {data ? (
          <span className="text-[10px] text-fg-dim">
            {t.count(rows.length)}
            {data.hiddenMicrosoft > 0 ? ` · ${t.hiddenMicrosoft(data.hiddenMicrosoft)}` : ""}
          </span>
        ) : null}
        <button
          type="button"
          onClick={refresh}
          title={t.refresh}
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
        </button>
      </div>

      {data && !data.controlSupported && data.unsupportedReason ? (
        <div className="shrink-0 border-b border-edge px-3 py-1.5 text-[11px] text-fg-dim">
          {data.unsupportedReason}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-[11px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-edge text-fg-dim">
              <th className="px-2 py-1.5 text-left font-medium">{t.columnName}</th>
              <th className="w-[76px] px-2 py-1.5 text-left font-medium">{t.columnState}</th>
              <th className="w-[96px] px-2 py-1.5 text-left font-medium">{t.columnStartType}</th>
              <th className="w-[56px] px-2 py-1.5 text-right font-medium">PID</th>
              <th className="w-[34%] px-2 py-1.5 text-left font-medium">{t.columnDescription}</th>
              {controllable ? <th className="w-[68px]" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.name}
                className="group border-b border-edge/50 hover:bg-raised/50"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, s });
                }}
              >
                <td className="max-w-0 px-2 py-1" title={s.binaryPath ?? s.name}>
                  <div className="truncate text-fg">{s.displayName}</div>
                  {s.displayName !== s.name ? (
                    <div className="truncate text-[10px] text-fg-dim">{s.name}</div>
                  ) : null}
                </td>
                <td className="px-2 py-1">
                  <span className={`rounded px-1.5 py-px text-[10px] ${stateBadge(s.state)}`}>
                    {stateLabel(t, s.state)}
                  </span>
                </td>
                <td className="truncate px-2 py-1 text-fg-muted">{startTypeLabel(t, s.startType)}</td>
                <td className="px-2 py-1 text-right font-mono text-fg-dim tabular-nums">
                  {s.pid ?? ""}
                </td>
                <td className="max-w-0 truncate px-2 py-1 text-fg-dim" title={s.description ?? ""}>
                  {s.description ?? ""}
                </td>
                {controllable ? (
                  <td className="px-1 py-1">
                    <div
                      className={`flex justify-end gap-0.5 ${
                        busy === s.name ? "opacity-40" : "opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      {s.state === "stopped" && s.startType !== "disabled" ? (
                        <RowButton
                          icon={Play}
                          title={t.actionStart}
                          disabled={busy !== null}
                          onClick={() => control(s, "start")}
                        />
                      ) : null}
                      {s.canStop ? (
                        <>
                          <RowButton
                            icon={RotateCw}
                            title={t.actionRestart}
                            disabled={busy !== null}
                            onClick={() => control(s, "restart")}
                          />
                          <RowButton
                            icon={Square}
                            title={t.actionStop}
                            danger
                            disabled={busy !== null}
                            onClick={() => control(s, "stop")}
                          />
                        </>
                      ) : null}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {error ? (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">
            {t.loadFailed(errorMessage(error))}
          </div>
        ) : !data ? (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">{t.loading}</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">
            {query ? t.noMatch : t.empty}
            {data.hiddenMicrosoft > 0 ? (
              <div className="mt-1">{t.hiddenMicrosoft(data.hiddenMicrosoft)}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {menu ? (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-edge bg-panel py-1 text-[12px] shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 260),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {controllable && busy === null ? (
            <>
              {menu.s.state === "stopped" ? (
                <MenuItem icon={Play} label={t.actionStart} onClick={() => control(menu.s, "start")} />
              ) : null}
              {menu.s.canStop ? (
                <>
                  <MenuItem
                    icon={RotateCw}
                    label={t.actionRestart}
                    onClick={() => control(menu.s, "restart")}
                  />
                  <MenuItem
                    icon={Square}
                    label={t.actionStop}
                    danger
                    onClick={() => control(menu.s, "stop")}
                  />
                </>
              ) : null}
              <div className="flex items-center gap-2 px-3 pb-0.5 pt-1.5 text-[10px] text-fg-dim">
                <Settings2 size={11} />
                {t.startTypeMenu}
              </div>
              {START_CHOICES.map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={menu.s.startType === c}
                  onClick={() => setStartType(menu.s, c)}
                  className="flex w-full items-center px-3 py-1 pl-8 text-left text-fg-muted hover:bg-raised hover:text-fg disabled:pointer-events-none disabled:text-accent"
                >
                  {startTypeLabel(t, c)}
                </button>
              ))}
              <div className="my-1 border-t border-edge/60" />
            </>
          ) : null}
          <MenuItem
            icon={Copy}
            label={t.copyName}
            onClick={() => {
              copyWithToast(menu.s.name, t.nameCopied);
              setMenu(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function RowButton({
  icon: Icon,
  title,
  danger,
  disabled,
  onClick,
}: {
  icon: typeof Square;
  title: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded p-0.5 text-fg-dim disabled:pointer-events-none ${
        danger ? "hover:bg-danger/20 hover:text-danger" : "hover:bg-raised hover:text-fg"
      }`}
    >
      <Icon size={11} className={danger ? "fill-current" : ""} />
    </button>
  );
}

function MenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: typeof Square;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        danger ? "text-danger hover:bg-danger/15" : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <Icon size={13} className="shrink-0" />
      {label}
    </button>
  );
}
