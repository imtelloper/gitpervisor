import { Activity } from "lucide-react";

import { useMessages } from "../i18n/ui-language";
import type { ProcSortKey } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useSysMetrics } from "../queries";
import { writeSysmonSortKey, writeSysmonView } from "./sysmon/prefs";

/** 부하 임계에 따른 색 — 평상시 sky, 70%+ 앰버, 88%+ 빨강 */
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

/** 지표 클릭 → 클릭한 지표를 초기 정렬로 핸드오프하고 리소스 모니터 팝업을 연다(§3.6).
 *  이미 떠 있으면 백엔드가 포커스만 준다(싱글턴 — 정렬은 창이 부팅 시 1회 읽는다).
 *  SSD 클릭(disk=true)은 디스크 용량 분석 뷰로 핸드오프한다(disk-usage 설계 §3.4). */
function openSysmon(sortBy?: ProcSortKey, disk?: boolean) {
  if (disk) writeSysmonView("disk");
  else if (sortBy) writeSysmonSortKey(sortBy);
  void ipc.openSysmonWindow().catch((e) => {
    console.error("리소스 모니터 창 생성 실패:", e);
  });
}

function Metric({
  label,
  pct,
  tip,
  sortBy,
  disk,
}: {
  label: string;
  pct: number | null;
  tip?: string;
  /** 클릭 시 팝업 초기 정렬로 넘길 지표 — 없으면 정렬 유지한 채 열기만 */
  sortBy?: ProcSortKey;
  /** SSD — 클릭 시 디스크 용량 분석 뷰로 연다 */
  disk?: boolean;
}) {
  const msg = useMessages();
  const v = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <button
      type="button"
      onClick={() => openSysmon(sortBy, disk)}
      title={`${tip ? `${tip} — ` : ""}${
        disk
          ? msg.sysmon.titleBarMetric.clickForDiskUsage
          : msg.sysmon.titleBarMetric.clickForProcesses
      }`}
      className="flex w-[50px] cursor-pointer flex-col gap-[3px] rounded-sm px-0 py-0 text-left hover:opacity-80"
    >
      <div className="flex w-full items-baseline justify-between leading-none">
        <span className="text-[9px] font-medium tracking-wide text-fg-dim">
          {label}
        </span>
        <span
          className={`font-mono text-[10px] tabular-nums ${
            v == null ? "text-fg-dim" : loadText(v)
          }`}
        >
          {v == null ? "--" : v}%
        </span>
      </div>
      <div className="h-[2px] w-full overflow-hidden rounded-full bg-edge">
        <div
          className={`h-full origin-left rounded-full transition-transform duration-500 ease-out ${
            v == null ? "" : loadBar(v)
          }`}
          style={{ transform: `scaleX(${(v ?? 0) / 100})` }}
        />
      </div>
    </button>
  );
}

/**
 * 좁은 창에서의 접힌 표시 — 지표 하나만 보여 준다(약 230px → 60px).
 *
 * 무엇을 보여 주나: **부하가 가장 높은 것**(CPU·GPU·RAM 중). SSD는 빼는데, 그건 부하가 아니라
 * 채워진 용량이라 늘 70% 언저리로 눌러앉아 다른 지표의 급등을 가려 버린다. 네 값 전부는 툴팁에 있다.
 */
function CompactSysMonitor({ items, className }: { items: MetricSpec[]; className?: string }) {
  const msg = useMessages();
  const load = items.filter((i) => !i.disk);
  const worst = load.reduce((a, b) => ((b.pct ?? -1) > (a.pct ?? -1) ? b : a), load[0]);
  const v = worst?.pct == null ? null : Math.max(0, Math.min(100, Math.round(worst.pct)));
  const tip = `${items
    .map((i) => `${i.label} ${i.pct == null ? "--" : Math.round(i.pct)}%`)
    .join(" · ")} — ${msg.sysmon.titleBarMetric.clickForProcesses}`;
  return (
    <button
      type="button"
      onClick={() => openSysmon(worst?.sortBy)}
      title={tip}
      data-gpv="sysmon-compact"
      className={`flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-raised ${className ?? ""}`}
    >
      <Activity size={12} className={v == null ? "text-fg-dim" : loadText(v)} />
      <span
        className={`font-mono text-[10px] tabular-nums ${v == null ? "text-fg-dim" : loadText(v)}`}
      >
        {v == null ? "--" : `${worst.label} ${v}%`}
      </span>
    </button>
  );
}

interface MetricSpec {
  label: string;
  pct: number | null;
  tip: string;
  sortBy?: ProcSortKey;
  disk?: boolean;
}

/** 타이틀바 좌측 시스템 모니터 (CPU / GPU / RAM / 저장소) — 클릭하면 프로세스별 상세 팝업.
 *  드래그 영역이 아니다(클릭 대상) — 타이틀바 드래그는 주변 spacer가 유지한다(태스크 05 §4.2).
 *
 *  1280px 미만에서는 지표 하나로 접는다 — 네 개를 펼치면 약 230px를 먹어 프로젝트명·버튼 줄을
 *  밀어낸다(사용자 제보 2026-09-23). 기준이 뷰포트 폭이라 보조 창에서도 그대로 동작한다. */
export function SysMonitor() {
  const msg = useMessages();
  const { data: m } = useSysMetrics();

  const items: MetricSpec[] = [
    { label: "CPU", pct: m?.cpu ?? null, tip: msg.sysmon.titleBarMetric.cpuTip, sortBy: "cpu" },
    {
      label: "GPU",
      pct: m?.gpu ?? null,
      tip:
        m && m.gpu == null
          ? msg.sysmon.common.gpuUnsupported
          : msg.sysmon.titleBarMetric.gpuTipAllAdapters,
      // GPU를 못 읽는 플랫폼(macOS/Linux)에선 정렬 핸드오프를 하지 않는다 — 전 행이
      // null이라 GPU 정렬은 아무 의미가 없고, 그 값이 localStorage에 눌러앉아 이후
      // 재오픈까지 계속 무의미한 정렬로 뜬다.
      sortBy: m && m.gpu == null ? undefined : "gpu",
    },
    {
      label: "RAM",
      pct: m?.ram ?? null,
      tip: m
        ? msg.sysmon.common.memoryTip(gb(m.ramUsed), gb(m.ramTotal))
        : msg.sysmon.common.memory,
      sortBy: "ram",
    },
    {
      label: "SSD",
      pct: m?.storage ?? null,
      disk: true,
      // 드라이브 문자를 지어내지 않는다 — 백엔드가 실제로 측정한 볼륨의 마운트 지점을
      // 실어 보낸다(Windows "C:\", macOS "/"). 예전엔 "C:"를 하드코딩해 macOS에서
      // 엉뚱한 외장 볼륨 수치에 존재하지도 않는 드라이브 문자를 붙였다.
      tip: m
        ? msg.sysmon.titleBarMetric.storageTip(
            m.storageMount,
            gb(m.storageUsed),
            gb(m.storageTotal),
          )
        : msg.sysmon.titleBarMetric.storage,
    },
  ];

  return (
    <>
      <div data-gpv="sysmon-metrics" className="hidden items-center gap-2.5 xl:flex">
        {items.map((i) => (
          <Metric key={i.label} label={i.label} pct={i.pct} tip={i.tip} sortBy={i.sortBy} disk={i.disk} />
        ))}
      </div>
      <CompactSysMonitor items={items} className="xl:hidden" />
    </>
  );
}
