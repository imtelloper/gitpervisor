// 유지보수 (태스크 18) — 브라우저 데이터 초기화·진단 로그·macOS 격리. 전부 "폼이 아닌 즉시 액션"이라
// 저장/취소 대상이 아니고 자체 로컬 상태를 가진다. 셸이 이 섹션을 hidden 마운트로 유지해(§3.6 I1)
// 카테고리 왕복 시 선택 Set·busy·로그 뷰가 소실되지 않는다.
import {
  FolderOpen,
  Globe,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useMessages } from "../../../i18n/ui-language";
import { clearBrowserData } from "../../../lib/browser";
import { formatBytes } from "../../../lib/format";
import type { LogStatus } from "../../../lib/ipc";
import { errorMessage, ipc } from "../../../lib/ipc";
import { useClearQuarantine, useQuarantinedTools } from "../../../queries";
import { useUi } from "../../../stores/ui";
import { Hl } from "./shared";

const isMacOS = /Mac/i.test(navigator.userAgent);
const subHeading = "border-t border-edge pt-3 text-[11px] font-semibold tracking-widest text-fg-dim";

export function MaintenanceSection({ hl }: { hl: Set<string> }) {
  return (
    <>
      <Hl id="browserData" hl={hl}>
        <BrowserData />
      </Hl>
      <Hl id="crashLog" hl={hl}>
        <Diagnostics />
      </Hl>
      {isMacOS && (
        <Hl id="quarantine" hl={hl}>
          <Quarantine />
        </Hl>
      )}
    </>
  );
}

function BrowserData() {
  const msg = useMessages();
  const [busy, setBusy] = useState(false);
  const toast = (kind: "error" | "success", m: string) => useUi.getState().pushToast(kind, m);
  const confirmClear = () =>
    useUi.getState().askConfirm({
      title: msg.settings.maintenance.browserDataReset,
      message: msg.settings.maintenance.browserDataResetMessage,
      confirmLabel: msg.settings.maintenance.browserDataResetConfirm,
      danger: true,
      onConfirm: () => {
        setBusy(true);
        void clearBrowserData()
          .then(() => toast("success", msg.settings.maintenance.browserDataCleared))
          .catch((e) => toast("error", errorMessage(e)))
          .finally(() => setBusy(false));
      },
    });
  return (
    <div className="space-y-2">
      <div className={subHeading}>{msg.settings.maintenance.browserHeading}</div>
      <div className="text-[11px] leading-5 text-fg-muted">
        {msg.settings.maintenance.browserIntro}
      </div>
      <button
        disabled={busy}
        onClick={confirmClear}
        className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-danger hover:bg-danger/15 disabled:opacity-50"
      >
        <Globe size={12} />
        {busy
          ? msg.settings.maintenance.browserResetting
          : msg.settings.maintenance.browserDataReset}
      </button>
    </div>
  );
}

function Diagnostics() {
  const msg = useMessages();
  const [status, setStatus] = useState<LogStatus | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void ipc.getLogStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => refresh(), [refresh]);
  const hasCrash = !!status && status.panicLogBytes > 0;
  const toast = (kind: "error" | "success", m: string) => useUi.getState().pushToast(kind, m);
  return (
    <div className="space-y-2">
      <div className={subHeading}>{msg.settings.maintenance.diagnosticsHeading}</div>
      <div className="text-[11px] leading-5 text-fg-muted">
        {msg.settings.maintenance.diagnosticsIntroBeforeFile}
        <span className="font-mono">panic.log</span>
        {msg.settings.maintenance.diagnosticsIntroAfterFile}
      </div>
      {status?.logDir && (
        <div className="break-all font-mono text-[10px] text-fg-dim">{status.logDir}</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void ipc.openLogsFolder().catch((e) => toast("error", errorMessage(e)))}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <FolderOpen size={12} />
          {msg.settings.maintenance.openLogsFolder}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setLog(await ipc.readCrashLog(256 * 1024));
            } catch (e) {
              toast("error", errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <ScrollText size={12} />
          {msg.settings.maintenance.viewPanicLog}
        </button>
        {hasCrash && (
          <button
            onClick={async () => {
              try {
                await ipc.clearCrashLog();
                setLog(null);
                refresh();
                toast("success", msg.settings.maintenance.crashLogCleared);
              } catch (e) {
                toast("error", errorMessage(e));
              }
            }}
            className="rounded border border-edge px-2.5 py-1 text-danger hover:bg-danger/15"
          >
            {msg.settings.maintenance.clearCrashLog}
          </button>
        )}
      </div>
      {hasCrash ? (
        <span className="text-[12px] text-danger">
          {msg.settings.maintenance.lastCrash(
            status?.lastCrashAt ?? "?",
            formatBytes(status?.panicLogBytes ?? 0),
          )}
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-[12px] text-add">
          <ShieldCheck size={13} />
          {msg.settings.maintenance.noCrashes}
        </span>
      )}
      {log !== null && (
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded border border-edge bg-base p-2 font-mono text-[10px] leading-4">
          {log || msg.settings.maintenance.logEmpty}
        </pre>
      )}
    </div>
  );
}

function Quarantine() {
  const msg = useMessages();
  const { data, isFetching, refetch } = useQuarantinedTools();
  const clear = useClearQuarantine();
  const items = data ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(items.map((i) => i.path)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  const allSelected = items.length > 0 && selected.size === items.length;
  const selectedList = useMemo(
    () => items.filter((i) => selected.has(i.path)).map((i) => i.path),
    [items, selected],
  );
  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.path)));
  return (
    <div className="space-y-2">
      <div className={subHeading}>{msg.settings.maintenance.quarantineHeading}</div>
      <div className="text-[11px] leading-5 text-fg-muted">
        {msg.settings.maintenance.quarantineIntroBeforeError}
        <span className="font-mono">permission denied</span>
        {msg.settings.maintenance.quarantineIntroAfterError}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void refetch()}
          disabled={isFetching || clear.isPending}
          className="flex items-center gap-1.5 rounded border border-edge px-2.5 py-1 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
          {msg.settings.maintenance.rescan}
        </button>
        {items.length === 0 && !isFetching && (
          <span className="flex items-center gap-1.5 text-[12px] text-add">
            <ShieldCheck size={13} />
            {msg.settings.maintenance.noBlocked}
          </span>
        )}
        {items.length > 0 && (
          <span className="text-[12px] text-danger">
            {msg.settings.maintenance.blockedCount(items.length)}
          </span>
        )}
      </div>
      {items.length > 0 && (
        <>
          <div className="max-h-44 overflow-y-auto rounded border border-edge bg-base">
            <label className="flex cursor-pointer items-center gap-2 border-b border-edge px-2 py-1.5 text-[12px] font-medium text-fg-muted hover:bg-raised">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-accent" />
              <span>{msg.settings.maintenance.selectAll}</span>
            </label>
            {items.map((it) => (
              <label
                key={it.path}
                className="flex cursor-pointer items-start gap-2 px-2 py-1.5 hover:bg-raised"
              >
                <input
                  type="checkbox"
                  checked={selected.has(it.path)}
                  onChange={() => toggle(it.path)}
                  className="mt-0.5 accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px]">
                    <span className="font-medium">{it.name}</span>
                    <span className="ml-1 text-fg-dim">({it.cask})</span>
                  </div>
                  <div className="break-all font-mono text-[10px] text-fg-dim">{it.path}</div>
                </div>
              </label>
            ))}
          </div>
          <button
            onClick={() => clear.mutate(selectedList)}
            disabled={selectedList.length === 0 || clear.isPending}
            className="w-full rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
          >
            {clear.isPending
              ? msg.settings.maintenance.clearing
              : msg.settings.maintenance.clearSelected(selectedList.length)}
          </button>
        </>
      )}
    </div>
  );
}
