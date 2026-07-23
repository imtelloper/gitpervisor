import { AppWindow, Copy, FolderOpen, Search, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import type { ProcSortKey, ProcessSample } from "../../lib/ipc";
import { useProcessSnapshot, useSettings } from "../../queries";
import { useUi } from "../../stores/ui";
import { ConfirmHost } from "../common/ConfirmDialog";
import { Toasts } from "../common/Toast";
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
/** 디스크 처리량 — 0이면 "—", 그 외 B/s·KB/s·MB/s. */
function bps(v: number | null | undefined): string {
  if (v == null || v === 0) return "—";
  return `${formatBytes(v)}/s`;
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

/** 프로세스 아이콘 — exePath가 아이콘 캐시에 있으면 그림을, 없으면 기본 창 아이콘. */
function ProcIcon({ uri }: { uri: string | undefined }) {
  const [failed, setFailed] = useState(false);
  if (!uri || failed) {
    return <AppWindow size={14} className="shrink-0 text-fg-dim" />;
  }
  return (
    <img
      src={uri}
      alt=""
      width={16}
      height={16}
      className="shrink-0"
      style={{ width: 16, height: 16 }}
      onError={() => setFailed(true)}
    />
  );
}

function Row({
  p,
  grouped,
  icon,
  onKill,
  onMenu,
}: {
  p: ProcessSample;
  grouped: boolean;
  icon: string | undefined;
  onKill: (p: ProcessSample) => void;
  onMenu: (e: React.MouseEvent, p: ProcessSample) => void;
}) {
  const cpu = Math.max(0, p.cpu);
  return (
    <tr
      className="group border-b border-edge/50 hover:bg-raised/50"
      onContextMenu={(e) => onMenu(e, p)}
    >
      <td className="max-w-0 px-2 py-1 text-fg" title={p.name}>
        <div className="flex items-center gap-1.5">
          <ProcIcon uri={icon} />
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onKill(p);
            }}
            title="작업 끝내기 (프로세스 종료)"
            className="shrink-0 rounded p-0.5 text-fg-dim opacity-0 hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
          >
            <Square size={11} className="fill-current" />
          </button>
        </div>
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
      <td className="px-2 py-1 text-right font-mono text-fg-muted tabular-nums">
        {bps(p.diskBps)}
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

interface RowMenu {
  x: number;
  y: number;
  p: ProcessSample;
}

/**
 * 리소스 모니터 팝업 창(라벨 "sysmon", 태스크 05) — 프로세스별 CPU/RAM/디스크/GPU + 아이콘,
 * 작업 끝내기(확인 모달), 우클릭 메뉴(파일 위치·복사), 검색. 정렬·"프로그램별" 토글은
 * gp:sysmon localStorage에 영속. 폴링은 틱당 sys_process_snapshot 1개(totals 포함 배치).
 * 아이콘은 exePath 키로 세션 캐시(경로당 1회 get_process_icons).
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
  const allRows = useMemo(() => data?.processes ?? [], [data]);

  // ── 검색 필터 (프론트, 이름 부분일치) ──
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allRows.filter((p) => p.name.toLowerCase().includes(q)) : allRows;
  }, [allRows, query]);
  const rest = data ? Math.max(0, data.totalCount - allRows.length) : 0;

  // ── 아이콘 캐시 (exePath → dataURI). 세션 지속, 경로당 1회만 백엔드 요청 ──
  const [icons, setIcons] = useState<Record<string, string>>({});
  const iconReqRef = useRef<Set<string>>(new Set()); // 요청 중/완료한 경로(중복 요청 방지)
  useEffect(() => {
    const missing = allRows
      .map((p) => p.exePath)
      .filter((p): p is string => !!p && !iconReqRef.current.has(p));
    if (missing.length === 0) return;
    for (const p of missing) iconReqRef.current.add(p);
    void ipc
      .getProcessIcons(missing)
      .then((map) => {
        if (Object.keys(map).length) setIcons((prev) => ({ ...prev, ...map }));
      })
      .catch(() => {
        // 실패한 경로는 다시 시도할 수 있게 요청 집합에서 해제
        for (const p of missing) iconReqRef.current.delete(p);
      });
  }, [allRows]);

  // ── 작업 끝내기 (확인 모달 재사용 — 이 창의 useUi 인스턴스) ──
  const askConfirm = useUi((s) => s.askConfirm);
  const pushToast = useUi((s) => s.pushToast);
  const killProc = (p: ProcessSample) => {
    const pids = p.groupPids ?? [p.pid];
    const label =
      pids.length > 1 ? `${p.name} (${pids.length}개 프로세스)` : p.name;
    askConfirm({
      title: "작업 끝내기",
      message: `'${label}'을(를) 종료할까요? 저장하지 않은 작업이 사라질 수 있습니다.`,
      confirmLabel: "작업 끝내기",
      danger: true,
      onConfirm: () => {
        void ipc
          .killProcesses(pids)
          .then((r) => {
            if (r.failed.length === 0) {
              pushToast("success", `${label} 종료됨`);
            } else if (r.killed > 0) {
              pushToast(
                "info",
                `${r.killed}개 종료 · ${r.failed.length}개 실패(권한 부족)`,
              );
            } else {
              pushToast("error", "종료하지 못했습니다 (권한이 필요할 수 있음)");
            }
          })
          .catch((e) => pushToast("error", errorMessage(e)));
      },
    });
  };

  // ── 우클릭 메뉴 ──
  const [menu, setMenu] = useState<RowMenu | null>(null);
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
  const openMenu = (e: React.MouseEvent, p: ProcessSample) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, p });
  };
  const copy = (text: string, ok: string) => {
    void writeText(text)
      .then(() => pushToast("success", ok))
      .catch(() => pushToast("error", "복사에 실패했습니다"));
    setMenu(null);
  };
  const revealExe = (p: ProcessSample) => {
    setMenu(null);
    if (!p.exePath) {
      pushToast("info", "실행 파일 경로를 알 수 없습니다");
      return;
    }
    void ipc.revealPath(p.exePath).catch((e) => pushToast("error", errorMessage(e)));
  };

  return (
    <div className="flex h-screen flex-col bg-base text-fg select-none">
      <FloatTitleBar title="리소스 모니터" badge="모니터" />

      {/* 헤더: 전체 사용률 게이지 + 검색 + 프로그램별 토글 */}
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
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름 검색"
            className="w-32 rounded border border-edge bg-base py-1 pl-6 pr-2 text-[11px] text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
          />
        </div>
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
              <th className="w-[72px] px-2 py-1.5 text-right font-medium">
                PID
              </th>
              <SortHeader
                label="CPU"
                k="cpu"
                active={sortBy === "cpu"}
                onSort={setSortBy}
                className="w-[58px]"
              />
              <SortHeader
                label="RAM"
                k="ram"
                active={sortBy === "ram"}
                onSort={setSortBy}
                className="w-[76px]"
              />
              <SortHeader
                label="디스크"
                k="disk"
                active={sortBy === "disk"}
                onSort={setSortBy}
                className="w-[82px]"
              />
              <SortHeader
                label="GPU"
                k="gpu"
                active={sortBy === "gpu"}
                onSort={setSortBy}
                className="w-[62px]"
              />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Row
                key={`${p.name}:${p.pid}`}
                p={p}
                grouped={groupByName}
                icon={p.exePath ? icons[p.exePath] : undefined}
                onKill={killProc}
                onMenu={openMenu}
              />
            ))}
          </tbody>
        </table>
        {!data ? (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">
            측정 중…
          </div>
        ) : rows.length === 0 && query ? (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">
            '{query}'와 일치하는 프로세스가 없습니다
          </div>
        ) : null}
      </div>

      {/* 푸터: 절단된 나머지 행 수 */}
      {rest > 0 && !query ? (
        <div className="shrink-0 border-t border-edge bg-panel px-3 py-1.5 text-right text-[10px] text-fg-dim">
          … 외 {rest}개
        </div>
      ) : null}

      {/* 우클릭 메뉴 */}
      {menu ? (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-edge bg-panel py-1 text-[12px] shadow-xl"
          style={{
            left: Math.min(menu.x, window.innerWidth - 190),
            top: Math.min(menu.y, window.innerHeight - 160),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            icon={Square}
            label="작업 끝내기"
            danger
            onClick={() => {
              const p = menu.p;
              setMenu(null);
              killProc(p);
            }}
          />
          <MenuItem
            icon={FolderOpen}
            label="파일 위치 열기"
            onClick={() => revealExe(menu.p)}
          />
          <div className="my-1 border-t border-edge/60" />
          <MenuItem
            icon={Copy}
            label="PID 복사"
            onClick={() => copy(String(menu.p.pid), "PID를 복사했습니다")}
          />
          {menu.p.exePath ? (
            <MenuItem
              icon={Copy}
              label="경로 복사"
              onClick={() => copy(menu.p.exePath!, "경로를 복사했습니다")}
            />
          ) : null}
        </div>
      ) : null}

      {/* 이 창 전용 useUi 인스턴스 — 확인 모달·토스트 호스트를 여기 마운트해 재사용 */}
      <ConfirmHost />
      <Toasts />
    </div>
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
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
        danger
          ? "text-danger hover:bg-danger/15"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      }`}
    >
      <Icon size={13} className="shrink-0" />
      {label}
    </button>
  );
}
