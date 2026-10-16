// 리소스 모니터 건강 탭 — 디스크 건강 · GPU 온도 · 비정상 종료 이력 (DOCS/pc-care-design.md §4.1~4.3).

import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import type { CrashEvent, CrashKind, DiskHealth, DiskHealthStatus } from "../../lib/ipc";
import { SortLabel, useTableSort } from "./sort-table";

type T = Messages["pccareHealth"];

const STATUS_CLASS: Record<DiskHealthStatus, string> = {
  ok: "border-ok/50 text-ok",
  warning: "border-warn/50 text-warn",
  critical: "border-danger/50 text-danger",
  unknown: "border-edge text-fg-dim",
};

function statusLabel(s: DiskHealthStatus, t: T): string {
  switch (s) {
    case "ok":
      return t.statusOk;
    case "warning":
      return t.statusWarning;
    case "critical":
      return t.statusCritical;
    case "unknown":
      return t.statusUnknown;
    default: {
      const never: never = s;
      return never;
    }
  }
}

function kindLabel(k: CrashKind, t: T): string {
  switch (k) {
    case "bugcheck":
      return t.kindBugcheck;
    case "unexpectedShutdown":
      return t.kindUnexpectedShutdown;
    case "kernelPanic":
      return t.kindKernelPanic;
    default: {
      const never: never = k;
      return never;
    }
  }
}

const num = (v: number | null) => (v == null ? null : v.toLocaleString());

function dateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded border border-edge bg-panel">
      <h3 className="border-b border-edge px-3 py-1.5 text-[11px] font-medium text-fg">{title}</h3>
      {children}
    </section>
  );
}

function Dim({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <div className={`px-3 py-2 text-[11px] ${danger ? "text-danger/80" : "text-fg-dim"}`}>
      {children}
    </div>
  );
}

function DiskCard({ d, t }: { d: DiskHealth; t: T }) {
  const rows: [string, string | null, boolean?][] = [
    [t.temperature, d.temperatureC == null ? null : `${d.temperatureC}℃`, (d.temperatureC ?? 0) >= 70],
    [t.percentageUsed, d.percentageUsed == null ? null : `${d.percentageUsed}%`, (d.percentageUsed ?? 0) >= 90],
    [
      t.availableSpare,
      d.availableSparePct == null
        ? null
        : `${d.availableSparePct}%${
            d.availableSpareThresholdPct == null ? "" : ` (${t.spareThreshold(d.availableSpareThresholdPct)})`
          }`,
      d.availableSparePct != null &&
        d.availableSpareThresholdPct != null &&
        d.availableSparePct < d.availableSpareThresholdPct,
    ],
    [t.powerOnHours, d.powerOnHours == null ? null : t.hours(d.powerOnHours.toLocaleString())],
    [t.powerCycles, num(d.powerCycles)],
    [t.unsafeShutdowns, num(d.unsafeShutdowns)],
    [t.mediaErrors, num(d.mediaErrors), (d.mediaErrors ?? 0) > 0],
    [t.errorLogEntries, num(d.errorLogEntries)],
    [t.dataRead, d.dataReadBytes == null ? null : formatBytes(d.dataReadBytes)],
    [t.dataWritten, d.dataWrittenBytes == null ? null : formatBytes(d.dataWrittenBytes)],
    [t.criticalWarning, d.criticalWarning ? `0x${d.criticalWarning.toString(16).padStart(2, "0")}` : null, true],
  ];
  // 값이 하나도 없는 줄은 감춘다 — USB·SATA처럼 못 읽은 디스크는 이유 한 줄만 보이게.
  const shown = rows.filter(([, v]) => v != null);
  const sub = [d.bus, d.sizeBytes == null ? null : formatBytes(d.sizeBytes), d.serial]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="overflow-hidden rounded border border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-fg">
            {d.model || t.diskUnnamed(d.index)}
          </div>
          {sub ? <div className="truncate text-[10px] text-fg-dim">{sub}</div> : null}
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[d.status]}`}
        >
          {statusLabel(d.status, t)}
        </span>
      </div>
      {shown.length ? (
        <table className="w-full table-fixed border-collapse text-[11px]">
          <tbody>
            {shown.map(([k, v, bad]) => (
              <tr key={k} className="border-b border-edge/40 last:border-0 hover:bg-hover">
                <td className="w-[45%] px-3 py-1 text-fg-dim">{k}</td>
                <td className={`px-3 py-1 ${bad ? "text-warn" : "text-fg-muted"}`}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {d.unreadableReason ? <Dim>{d.unreadableReason}</Dim> : null}
    </section>
  );
}

// 데이터가 없을 때 렌더마다 새 [] 를 넘기면 정렬 메모가 매번 다시 돈다.
const NO_EVENTS: CrashEvent[] = [];

export function HealthView() {
  const msg = useMessages();
  const t = msg.pccareHealth;

  // 탭이 마운트된 동안만 쿼리가 산다 — GPU 폴링도 이 탭을 볼 때만 돈다(설계 §4.2).
  const disks = useQuery({
    queryKey: ["pccare-disk-health"],
    queryFn: ipc.diskHealthList,
    staleTime: 60_000,
    retry: false,
  });
  const gpus = useQuery({
    queryKey: ["pccare-gpu-temps"],
    queryFn: ipc.gpuTemperatures,
    refetchInterval: 5000,
    retry: false,
  });
  const crashes = useQuery({
    queryKey: ["pccare-crash-history"],
    queryFn: ipc.crashHistoryList,
    staleTime: 60_000,
    retry: false,
  });

  const crashSort = useTableSort(
    "crashes",
    crashes.data?.events ?? NO_EVENTS,
    {
      time: (e) => e.timeMs,
      kind: (e) => kindLabel(e.kind, t),
      code: (e) => e.code,
      detail: (e) => e.detail,
    },
    { key: "time", dir: "desc" },
  );

  const busy = disks.isFetching || crashes.isFetching;
  const refresh = () => {
    void disks.refetch();
    void gpus.refetch();
    void crashes.refetch();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 py-2">
        <div className="flex-1" />
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className={`flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg ${
            busy ? "cursor-default opacity-60" : ""
          }`}
        >
          <RefreshCw size={12} className={busy ? "animate-spin" : ""} />
          {t.refresh}
        </button>
      </div>

      <div className="min-h-0 flex-1 select-text space-y-2.5 overflow-y-auto p-3">
        <div className="text-[11px] font-medium text-fg-dim">{t.disksTitle}</div>
        {disks.isLoading ? (
          <Dim>{t.loading}</Dim>
        ) : disks.error ? (
          <Dim danger>{t.loadFailed(errorMessage(disks.error))}</Dim>
        ) : !disks.data?.length ? (
          <Dim>{t.disksEmpty}</Dim>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
            {disks.data.map((d) => (
              <DiskCard key={d.index} d={d} t={t} />
            ))}
          </div>
        )}

        <Section title={t.gpuTitle}>
          {gpus.isLoading ? (
            <Dim>{t.loading}</Dim>
          ) : gpus.error ? (
            <Dim danger>{t.loadFailed(errorMessage(gpus.error))}</Dim>
          ) : !gpus.data?.supported ? (
            <Dim>{gpus.data?.unsupportedReason ?? t.none}</Dim>
          ) : !gpus.data.gpus.length ? (
            <Dim>{gpus.data.unsupportedReason ?? t.gpuEmpty}</Dim>
          ) : (
            <table className="w-full table-fixed border-collapse text-[11px]">
              <tbody>
                {gpus.data.gpus.map((g, i) => (
                  <tr key={`${g.name}:${i}`} className="border-b border-edge/40 last:border-0 hover:bg-hover">
                    <td className="truncate px-3 py-1 text-fg-muted" title={g.source}>
                      {g.name || t.none}
                    </td>
                    <td
                      className={`w-40 px-3 py-1 text-right tabular-nums ${
                        g.temperatureC == null
                          ? "text-fg-dim"
                          : g.temperatureC >= 85
                            ? "text-warn"
                            : "text-fg"
                      }`}
                    >
                      {g.temperatureC == null ? t.gpuNotReported : `${g.temperatureC.toFixed(0)}℃`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={t.crashTitle}>
          {crashes.isLoading ? (
            <Dim>{t.loading}</Dim>
          ) : crashes.error ? (
            <Dim danger>{t.loadFailed(errorMessage(crashes.error))}</Dim>
          ) : !crashes.data?.supported ? (
            <Dim>{crashes.data?.unsupportedReason ?? t.none}</Dim>
          ) : !crashes.data.events.length ? (
            // 출처 일부를 못 읽었으면 "기록 없음"이라 단정하지 않고 그 이유만 보인다.
            <Dim>{crashes.data.unsupportedReason ?? t.crashEmpty}</Dim>
          ) : (
            <>
              {crashes.data.unsupportedReason ? <Dim>{crashes.data.unsupportedReason}</Dim> : null}
              <table className="w-full table-fixed border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-edge text-left text-fg-dim">
                    <th className="w-36 px-3 py-1 font-normal">
                      <SortLabel label={t.crashTime} k="time" sort={crashSort.sort} onSort={crashSort.toggle} />
                    </th>
                    <th className="w-32 px-3 py-1 font-normal">
                      <SortLabel label={t.crashKind} k="kind" sort={crashSort.sort} onSort={crashSort.toggle} />
                    </th>
                    <th className="w-28 px-3 py-1 font-normal">
                      <SortLabel label={t.crashCode} k="code" sort={crashSort.sort} onSort={crashSort.toggle} />
                    </th>
                    <th className="px-3 py-1 font-normal">
                      <SortLabel label={t.crashDetail} k="detail" sort={crashSort.sort} onSort={crashSort.toggle} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {crashSort.sorted.map((e, i) => (
                    <tr key={`${e.timeMs}:${i}`} className="border-b border-edge/40 last:border-0 hover:bg-hover">
                      <td className="px-3 py-1 tabular-nums text-fg-muted">{dateTime(e.timeMs)}</td>
                      <td className={`px-3 py-1 ${e.kind === "unexpectedShutdown" ? "text-fg-muted" : "text-danger"}`}>
                        {kindLabel(e.kind, t)}
                      </td>
                      <td className="px-3 py-1 font-mono text-fg-muted">{e.code ?? ""}</td>
                      <td className="truncate px-3 py-1 text-fg-dim" title={e.detail ?? undefined}>
                        {e.detail ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Section>
      </div>
    </div>
  );
}
