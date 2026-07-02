import { useEffect, useRef, useState } from "react";

import { formatBytes } from "../../lib/format";
import type { ProcSortKey, ProcessSample } from "../../lib/ipc";
import { useProcessSnapshot, useSettings } from "../../queries";
import { FloatTitleBar } from "../FloatTitleBar";
import { loadSysmonPrefs, saveSysmonPrefs } from "./prefs";

// 부하 임계 색 — 타이틀바 SysMonitor의 Metric과 동일 규약(평상시/70%+/88%+).
function loadText(pct: number): string {
  return pct >= 88 ? "text-danger" : pct >= 70 ? "text-warn" : "text-fg-muted";
}
function loadBar(pct: number): string {
  return pct >= 88 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-accent";
}
function gb(bytes: number): string {
  const v = bytes / 1024 ** 3;
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

/** 헤더 totals 게이지 — SysMonitor Metric과 같은 스타일(라벨+%+바), 팝업용으로 폭만 넓게. */
function Gauge({
  label,
  pct,
  tip,
}: {
  label: string;
  pct: number | null;
  tip?: string;
}) {
  const v = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div title={tip} className="flex w-[86px] flex-col gap-[3px]">
      <div className="flex items-baseline justify-between leading-none">
        <span className="text-[10px] font-medium tracking-wide text-fg-dim">
          {label}
        </span>
        <span
          className={`font-mono text-[11px] tabular-nums ${
            v == null ? "text-fg-dim" : loadText(v)
          }`}
        >
          {v == null ? "--" : v}%
        </span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-edge">
        <div
          className={`h-full origin-left rounded-full transition-transform duration-500 ease-out ${
            v == null ? "" : loadBar(v)
          }`}
          style={{ transform: `scaleX(${(v ?? 0) / 100})` }}
        />
      </div>
    </div>
  );
}

/** 정렬 가능한 컬럼 헤더 — 클릭 시 해당 지표 내림차순으로 전환. */
function SortHeader({
  label,
  k,
  active,
  onSort,
  className,
}: {
  label: string;
  k: ProcSortKey;
  active: boolean;
  onSort: (k: ProcSortKey) => void;
  className?: string;
}) {
  return (
    <th className={`px-2 py-1.5 font-medium ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        title={`${label} 기준 정렬`}
        className={`w-full text-right transition-colors hover:text-fg ${
          active ? "text-accent" : "text-fg-dim"
        }`}
      >
        {label}
        {active ? " ▾" : ""}
      </button>
    </th>
  );
}

function Row({ p, grouped }: { p: ProcessSample; grouped: boolean }) {
  const cpu = Math.max(0, p.cpu);
  return (
    <tr className="border-b border-edge/50 hover:bg-raised/50">
      <td className="max-w-0 truncate px-2 py-1 text-fg" title={p.name}>
        {p.name}
      </td>
      <td
        className="px-2 py-1 text-right font-mono text-fg-dim tabular-nums"
        title={
          grouped && (p.groupCount ?? 1) > 1
            ? `프로세스 ${p.groupCount}개 합산 — PID는 최대 기여자`
            : undefined
        }
      >
        {p.pid}
        {grouped && (p.groupCount ?? 1) > 1 ? (
          <span className="ml-1 text-fg-muted">×{p.groupCount}</span>
        ) : null}
      </td>
      <td
        className={`px-2 py-1 text-right font-mono tabular-nums ${loadText(cpu)}`}
      >
        {cpu.toFixed(1)}%
      </td>
      <td className="px-2 py-1 text-right font-mono text-fg-muted tabular-nums">
        {formatBytes(p.ram)}
      </td>
      <td
        className={`px-2 py-1 text-right font-mono tabular-nums ${
          p.gpu == null ? "text-fg-dim" : loadText(p.gpu)
        }`}
      >
        {p.gpu == null ? "—" : `${p.gpu.toFixed(1)}%`}
      </td>
    </tr>
  );
}

/**
 * 리소스 모니터 팝업 창(라벨 "sysmon", 태스크 05) — 프로세스별 CPU/RAM/GPU(3D) Top-20.
 * 정렬·"프로그램별" 토글은 gp:sysmon localStorage에 영속(타이틀바 클릭 핸드오프와 공유).
 * 폴링은 틱당 sys_process_snapshot 1개(totals 포함 배치) — useProcessSnapshot이 담당.
 */
export function SysMonitorWindow() {
  // 이 창에도 저장된 테마 적용(FloatingTerminal과 동일 패턴) — 로드 전엔 main.tsx의
  // localStorage 선적용 값이 유지된다.
  const { data: settings } = useSettings();
  useEffect(() => {
    if (settings?.theme) document.documentElement.dataset.theme = settings.theme;
  }, [settings?.theme]);

  // 부팅 시 1회 localStorage에서 초기값을 읽는다 — 타이틀바가 클릭 직전 써둔 sortBy 핸드오프.
  const [prefs] = useState(loadSysmonPrefs);
  const [sortBy, setSortBy] = useState<ProcSortKey>(prefs.sortBy);
  const [groupByName, setGroupByName] = useState(prefs.groupByName);
  useEffect(() => {
    saveSysmonPrefs({ sortBy, groupByName });
  }, [sortBy, groupByName]);

  const { data, dataUpdatedAt } = useProcessSnapshot(sortBy, groupByName);

  // 첫 틱은 CPU 델타 기준점이라 전부 0% — 두 번째 표본이 올 때까지 "측정 중…"으로 안내한다.
  const ticks = useRef(0);
  const [measuring, setMeasuring] = useState(true);
  useEffect(() => {
    if (!dataUpdatedAt) return;
    ticks.current += 1;
    if (ticks.current >= 2) setMeasuring(false);
  }, [dataUpdatedAt]);

  const totals = data?.totals;
  const rows = data?.processes ?? [];
  const rest = data ? Math.max(0, data.totalCount - rows.length) : 0;

  return (
    <div className="flex h-screen flex-col bg-base text-fg select-none">
      <FloatTitleBar title="리소스 모니터" badge="모니터" />

      {/* 헤더: 전체 사용률 게이지 + 프로그램별 토글 */}
      <div className="flex shrink-0 items-center gap-4 border-b border-edge bg-panel px-3 py-2.5">
        <Gauge label="CPU" pct={totals?.cpu ?? null} tip="CPU 사용률 (전체)" />
        <Gauge
          label="GPU"
          pct={totals?.gpu ?? null}
          tip={
            totals && totals.gpu == null
              ? "GPU 사용률을 읽을 수 없음"
              : "GPU 사용률 (3D 엔진)"
          }
        />
        <Gauge
          label="RAM"
          pct={totals?.ram ?? null}
          tip={
            totals
              ? `메모리 ${gb(totals.ramUsed)} / ${gb(totals.ramTotal)} GB`
              : "메모리"
          }
        />
        {measuring ? (
          <span className="text-[10px] text-fg-dim">측정 중…</span>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setGroupByName((v) => !v)}
          title="같은 이름 프로세스를 합산해 프로그램 단위로 표시 (chrome.exe ×20 등)"
          className={`rounded border px-2 py-1 text-[11px] transition-colors ${
            groupByName
              ? "border-accent bg-accent/15 text-accent"
              : "border-edge text-fg-muted hover:bg-raised hover:text-fg"
          }`}
        >
          프로그램별
        </button>
      </div>

      {/* 프로세스 테이블 — 컬럼 헤더 클릭으로 정렬 전환 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-[11px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-edge text-fg-dim">
              <th className="px-2 py-1.5 text-left font-medium">이름</th>
              <th className="w-[76px] px-2 py-1.5 text-right font-medium">
                PID
              </th>
              <SortHeader
                label="CPU"
                k="cpu"
                active={sortBy === "cpu"}
                onSort={setSortBy}
                className="w-[64px]"
              />
              <SortHeader
                label="RAM"
                k="ram"
                active={sortBy === "ram"}
                onSort={setSortBy}
                className="w-[82px]"
              />
              <SortHeader
                label="GPU(3D)"
                k="gpu"
                active={sortBy === "gpu"}
                onSort={setSortBy}
                className="w-[74px]"
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Row key={`${p.name}:${p.pid}`} p={p} grouped={groupByName} />
            ))}
          </tbody>
        </table>
        {!data ? (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">
            측정 중…
          </div>
        ) : null}
      </div>

      {/* 푸터: 절단된 나머지 행 수 */}
      {rest > 0 ? (
        <div className="shrink-0 border-t border-edge bg-panel px-3 py-1.5 text-right text-[10px] text-fg-dim">
          … 외 {rest}개
        </div>
      ) : null}
    </div>
  );
}
