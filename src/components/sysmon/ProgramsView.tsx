// 리소스 모니터 PC 관리 — 프로그램 탭: 설치된 프로그램(분류 필터) + ActiveX(Windows). DOCS/pc-care-design.md §4.7·§4.8.

import { Copy, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useMessages } from "../../i18n/ui-language";
import { copyWithToast } from "../../lib/clipboard";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import type { ActiveXControl, InstalledApp, InstalledAppCategory } from "../../lib/ipc";
import { isMac } from "../../lib/platform";
import { useUi } from "../../stores/ui";
import { SortLabel, useTableSort } from "./sort-table";

type CategoryFilter = "all" | InstalledAppCategory;
const UNUSED_DAYS = [15, 30, 60] as const;
type UnusedFilter = "all" | (typeof UNUSED_DAYS)[number];

const APPS_KEY = ["pccare", "installedApps"] as const;
const ACTIVEX_KEY = ["pccare", "activex"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 설치일은 날짜뿐(UTC 자정)이라 UTC 로, 마지막 사용은 실제 시각이라 로컬로. */
function fmtUtcDate(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function fmtLocalDate(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-edge text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}

const APP_GRID = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_80px_70px_96px]";
const AX_GRID = "grid grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,0.8fr)_84px_44px_96px]";

export function ProgramsView() {
  const msg = useMessages();
  const t = msg.pccarePrograms;
  const pushToast = useUi((s) => s.pushToast);
  const askConfirm = useUi((s) => s.askConfirm);
  const queryClient = useQueryClient();

  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [unused, setUnused] = useState<UnusedFilter>("all");

  const apps = useQuery({ queryKey: APPS_KEY, queryFn: ipc.installedAppsList });
  const activex = useQuery({ queryKey: ACTIVEX_KEY, queryFn: ipc.activexList });

  // Windows 제거 프로그램은 끝을 알려 주지 않는다. 그 창을 닫으면 이 창으로 포커스가 돌아오니 그때 다시 읽는다 —
  // react-query 의 포커스 갱신은 visibilitychange 만 보는데 리소스 모니터는 내내 보이는 상태라 발화하지 않는다.
  const uninstallPending = useRef(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused && uninstallPending.current) void queryClient.invalidateQueries({ queryKey: APPS_KEY });
      })
      .then((f) => (disposed ? f() : (un = f)));
    return () => {
      disposed = true;
      un?.();
    };
  }, [queryClient]);

  const counts = useMemo(() => {
    const c: Record<CategoryFilter, number> = { all: 0, finance: 0, security: 0, other: 0 };
    for (const a of apps.data ?? []) {
      c.all++;
      c[a.category]++;
    }
    return c;
  }, [apps.data]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps.data ?? []).filter(
      (a) =>
        (category === "all" || a.category === category) &&
        (!q ||
          a.name.toLowerCase().includes(q) ||
          (a.publisher ?? "").toLowerCase().includes(q)),
    );
  }, [apps.data, category, query]);

  const shownActivex = useMemo(() => {
    const controls = activex.data?.controls ?? [];
    if (unused === "all") return controls;
    // 접근 시각을 못 읽은 컨트롤은 미사용으로 단정할 근거가 없어 기간 필터에서 뺀다.
    const cutoff = Date.now() - unused * 86_400_000;
    return controls.filter((c) => c.lastUsedMs != null && c.lastUsedMs < cutoff);
  }, [activex.data, unused]);
  const appSort = useTableSort(
    "programs",
    shown,
    {
      name: (r) => r.name,
      publisher: (r) => r.publisher,
      version: (r) => r.version,
      installed: (r) => r.installDateMs,
      size: (r) => r.sizeBytes,
    },
    { key: "name", dir: "asc" },
  );
  const axSort = useTableSort(
    "activex",
    shownActivex,
    {
      name: (r) => r.name,
      clsid: (r) => r.clsid,
      version: (r) => r.version,
      lastUsed: (r) => r.lastUsedMs,
      files: (r) => r.files.length,
    },
    { key: "name", dir: "asc" },
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: APPS_KEY });
    void queryClient.invalidateQueries({ queryKey: ACTIVEX_KEY });
  };

  const uninstall = (a: InstalledApp) => {
    askConfirm({
      title: t.uninstallTitle,
      message: isMac ? t.trashMessage(a.name) : t.uninstallMessage(a.name),
      detail: a.location ?? undefined,
      confirmLabel: t.uninstall,
      danger: true,
      onConfirm: () => {
        ipc
          .installedAppUninstall(a.id)
          .then(() => {
            pushToast("success", isMac ? t.trashed(a.name) : t.uninstallStarted(a.name));
            // macOS 휴지통은 즉시 끝난다. 나머지는 위의 포커스 복귀가 다시 읽는다(제거 프로그램이 여러 창을 거칠 수 있어 계속 켜 둔다).
            if (isMac) void queryClient.invalidateQueries({ queryKey: APPS_KEY });
            else uninstallPending.current = true;
          })
          .catch((e) => pushToast("error", errorMessage(e)));
      },
    });
  };

  const removeActivex = (c: ActiveXControl) => {
    askConfirm({
      title: t.activexRemoveTitle,
      message: t.activexRemoveMessage(c.name),
      detail: [c.clsid, ...c.files].join("\n"),
      confirmLabel: t.uninstall,
      danger: true,
      onConfirm: () => {
        ipc
          .activexRemove(c.clsid)
          .then(() => pushToast("success", t.activexRemoved(c.name)))
          .catch((e) => pushToast("error", errorMessage(e)))
          .finally(() => void queryClient.invalidateQueries({ queryKey: ACTIVEX_KEY }));
      },
    });
  };

  const filters: [CategoryFilter, string][] = [
    ["all", t.filterAll],
    ["finance", t.filterFinance],
    ["security", t.filterSecurity],
    ["other", t.filterOther],
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto text-[11px]">
      {/* 헤더: 분류 칩 + 검색 + 새로 고침 */}
      <div className="sticky top-0 z-10 border-b border-edge bg-panel px-3 py-2">
        <div className="flex items-center gap-1.5">
          {filters.map(([k, label]) => (
            <Chip
              key={k}
              active={category === k}
              label={`${label} ${counts[k]}`}
              onClick={() => setCategory(k)}
            />
          ))}
          <div className="flex-1" />
          <span className="text-fg-dim tabular-nums">{t.count(shown.length, counts.all)}</span>
          <div className="relative">
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchPlaceholder}
              className="w-40 rounded border border-edge bg-base py-1 pl-6 pr-2 text-[11px] text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={refresh}
            title={t.refresh}
            className="rounded border border-edge p-1 text-fg-muted hover:bg-raised hover:text-fg"
          >
            <RefreshCw size={12} className={apps.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
        {category === "finance" ? <div className="mt-1.5 text-fg-dim">{t.financeNote}</div> : null}
      </div>

      {/* 설치된 프로그램 표 */}
      <div className={`${APP_GRID} gap-2 border-b border-edge bg-panel px-3 py-1 text-fg-dim`}>
        <SortLabel label={msg.sysmon.common.columnName} k="name" sort={appSort.sort} onSort={appSort.toggle} />
        <SortLabel label={t.colPublisher} k="publisher" sort={appSort.sort} onSort={appSort.toggle} />
        <SortLabel label={t.colVersion} k="version" sort={appSort.sort} onSort={appSort.toggle} />
        <SortLabel label={t.colInstalled} k="installed" sort={appSort.sort} onSort={appSort.toggle} />
        <span className="text-right">
          <SortLabel label={t.colSize} k="size" sort={appSort.sort} onSort={appSort.toggle} align="right" />
        </span>
        <span />
      </div>
      {apps.isLoading ? (
        <div className="px-3 py-2 text-fg-dim">{msg.sysmon.common.reading}</div>
      ) : apps.error ? (
        <div className="px-3 py-2 text-danger/80">{errorMessage(apps.error)}</div>
      ) : shown.length === 0 ? (
        <div className="px-3 py-2 text-fg-dim">{t.noMatches}</div>
      ) : (
        appSort.sorted.map((a) => (
          <div
            key={a.id}
            className={`${APP_GRID} items-center gap-2 border-b border-edge/50 px-3 py-1 hover:bg-hover`}
          >
            <span className="truncate text-fg" title={a.location ?? a.name}>
              {a.name}
              {a.scope === "user" ? (
                <span className="ml-1.5 text-[10px] text-fg-dim" title={t.userScope}>
                  ●
                </span>
              ) : null}
            </span>
            <span className="truncate text-fg-dim" title={a.publisher ?? undefined}>
              {a.publisher ?? "—"}
            </span>
            <span className="truncate font-mono text-[10px] text-fg-dim" title={a.version ?? undefined}>
              {a.version ?? "—"}
            </span>
            <span className="font-mono text-[10px] text-fg-dim tabular-nums">
              {fmtUtcDate(a.installDateMs)}
            </span>
            <span className="text-right font-mono text-[10px] text-fg-dim tabular-nums">
              {a.sizeBytes != null ? formatBytes(a.sizeBytes) : "—"}
            </span>
            <span className="flex justify-end">
              {a.canUninstall ? (
                <button
                  type="button"
                  onClick={() => uninstall(a)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-dim hover:bg-danger/15 hover:text-danger"
                >
                  <Trash2 size={11} />
                  {t.uninstall}
                </button>
              ) : a.uninstallCommand ? (
                <button
                  type="button"
                  onClick={() => copyWithToast(a.uninstallCommand ?? "", t.commandCopied)}
                  title={a.uninstallCommand}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-dim hover:bg-raised hover:text-fg"
                >
                  <Copy size={11} />
                  {t.copyCommand}
                </button>
              ) : null}
            </span>
          </div>
        ))
      )}

      {/* ActiveX — 지원하는 OS(Windows)에서만 */}
      {activex.data?.supported ? (
        <>
          <div className="mt-3 border-y border-edge bg-panel px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className="mr-1.5 font-medium text-fg">{t.activexTitle}</span>
              <Chip active={unused === "all"} label={t.filterAll} onClick={() => setUnused("all")} />
              {UNUSED_DAYS.map((d) => (
                <Chip
                  key={d}
                  active={unused === d}
                  label={t.activexUnused(d)}
                  onClick={() => setUnused(d)}
                />
              ))}
            </div>
            <div className="mt-1.5 text-fg-dim">{t.activexNote}</div>
          </div>
          {activex.data.controls.length === 0 ? (
            <div className="px-3 py-2 text-fg-dim">{t.activexEmpty}</div>
          ) : (
            <>
              <div className={`${AX_GRID} gap-2 border-b border-edge bg-panel px-3 py-1 text-fg-dim`}>
                <SortLabel label={msg.sysmon.common.columnName} k="name" sort={axSort.sort} onSort={axSort.toggle} />
                <SortLabel label="CLSID" k="clsid" sort={axSort.sort} onSort={axSort.toggle} />
                <SortLabel label={t.colVersion} k="version" sort={axSort.sort} onSort={axSort.toggle} />
                <SortLabel label={t.colLastUsed} k="lastUsed" sort={axSort.sort} onSort={axSort.toggle} />
                <span className="text-right">
                  <SortLabel label={t.colFiles} k="files" sort={axSort.sort} onSort={axSort.toggle} align="right" />
                </span>
                <span />
              </div>
              {shownActivex.length === 0 ? (
                <div className="px-3 py-2 text-fg-dim">{t.activexNoMatches}</div>
              ) : (
                axSort.sorted.map((c) => (
                  <div
                    key={c.clsid}
                    className={`${AX_GRID} items-center gap-2 border-b border-edge/50 px-3 py-1 hover:bg-hover`}
                  >
                    <span className="truncate text-fg" title={c.codebase ?? c.name}>
                      {c.name}
                    </span>
                    <span className="truncate font-mono text-[10px] text-fg-dim">{c.clsid}</span>
                    <span className="truncate font-mono text-[10px] text-fg-dim">{c.version ?? "—"}</span>
                    <span className="font-mono text-[10px] text-fg-dim tabular-nums">
                      {fmtLocalDate(c.lastUsedMs)}
                    </span>
                    <span
                      className="text-right font-mono text-[10px] text-fg-dim tabular-nums"
                      title={c.files.join("\n")}
                    >
                      {c.files.length}
                    </span>
                    <span className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeActivex(c)}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-dim hover:bg-danger/15 hover:text-danger"
                      >
                        <Trash2 size={11} />
                        {t.uninstall}
                      </button>
                    </span>
                  </div>
                ))
              )}
            </>
          )}
        </>
      ) : activex.error ? (
        <div className="mt-3 px-3 py-2 text-danger/80">{errorMessage(activex.error)}</div>
      ) : null}
    </div>
  );
}
