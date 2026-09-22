import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { copyText } from "../../lib/clipboard";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import type { SystemInfo } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

// 못 구한 항목은 null 로 둔다 — 카드 전체를 죽이지 않고 이 셀만 비운다(설계 §1). 표시값
// ("정보 없음")은 그릴 때 현재 언어로 채운다(`systemInfo.none`).

/** 값 정규화 — null/빈 문자열은 전부 null(정보 없음)로 수렴시킨다. */
function txt(v: string | number | null | undefined): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** MHz → "3.60 GHz"(소수 2자리, 설계 §3.3). */
function ghz(mhz: number | null | undefined): string | null {
  return mhz == null || mhz <= 0 ? null : `${(mhz / 1000).toFixed(2)} GHz`;
}

/** 캐시 크기는 KB로 온다 — 바이트 표기는 기존 formatBytes로 통일. */
function kb(v: number | null | undefined): string | null {
  return v == null || v <= 0 ? null : formatBytes(v * 1024);
}

function bytes(v: number | null | undefined): string | null {
  return v == null || v <= 0 ? null : formatBytes(v);
}

/** 가동 시간 — "3d 4h 12m"(설계 §3.3). */
function uptime(secs: number): string | null {
  if (secs <= 0) return null;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return [d ? `${d}d` : "", h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ");
}

function dateTime(ms: number): string | null {
  if (!ms) return null;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

// 모르는 종류는 `systemInfo.volumeKindUnknown`.
const VOLUME_KIND: Record<string, string> = {
  ssd: "SSD",
  hdd: "HDD",
};

interface Card {
  title: string;
  rows: [string, string | null][];
}

/** 응답 → 카드 7개. 표시와 "요약 복사"가 같은 모델을 쓰므로 둘이 어긋날 수 없다. */
function toCards(d: SystemInfo, msg: Messages): Card[] {
  const { os, cpu, memory, gpus, board, volumes, app } = d;
  const t = msg.sysmon.systemInfo;

  const memRows: [string, string | null][] = [
    [t.memoryTotal, bytes(memory.totalBytes)],
    [t.memorySwap, bytes(memory.swapTotalBytes)],
  ];
  if (memory.modules.length === 0) {
    memRows.push([t.memoryModules, null]);
  } else {
    for (const m of memory.modules) {
      const detail = [
        formatBytes(m.capacityBytes),
        m.speedMhz ? `${m.speedMhz} MHz` : null,
        m.manufacturer,
        m.partNumber,
      ]
        .filter(Boolean)
        .join(" · ");
      memRows.push([txt(m.slot) == null ? t.memoryModule : m.slot, detail]);
    }
  }

  const gpuRows: [string, string | null][] = [];
  if (gpus.length === 0) {
    gpuRows.push(["GPU", null]);
  } else {
    gpus.forEach((g, i) => {
      // GPU가 하나뿐이면 접두사 없이 — 내장+외장인 노트북에서만 번호를 붙인다.
      const p = gpus.length > 1 ? `GPU ${i + 1} ` : "";
      gpuRows.push([t.gpuName(p), txt(g.name)]);
      gpuRows.push([t.gpuDriver(p), txt(g.driverVersion)]);
      gpuRows.push([t.gpuDriverDate(p), txt(g.driverDate)]);
      gpuRows.push([`${p}VRAM`, bytes(g.vramBytes)]);
      gpuRows.push([
        t.gpuKind(p),
        g.isDiscrete == null ? null : g.isDiscrete ? t.gpuDiscrete : t.gpuIntegrated,
      ]);
    });
  }

  const volRows: [string, string | null][] =
    volumes.length === 0
      ? [[t.volume, null]]
      : volumes.map((v) => [
          txt(v.mount) ?? t.none,
          [
            txt(v.name) == null ? null : v.name,
            VOLUME_KIND[v.kind] ?? t.volumeKindUnknown,
            txt(v.fs) == null ? null : v.fs,
            t.volumeSize(formatBytes(v.totalBytes), formatBytes(v.availableBytes)),
            v.removable ? t.volumeRemovable : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ]);

  return [
    {
      title: "OS",
      rows: [
        [t.osName, txt(os.name)],
        [t.osVersion, txt(os.version)],
        [t.osBuild, txt(os.build)],
        [t.osKernel, txt(os.kernel)],
        [t.osArch, txt(os.arch)],
        [t.osHostName, txt(os.hostName)],
        [t.osUser, txt(os.userName)],
        [t.osInstallDate, txt(os.installDate)],
        [t.osBootTime, dateTime(os.bootTimeMs)],
        [t.osUptime, uptime(os.uptimeSecs)],
      ],
    },
    {
      title: "CPU",
      rows: [
        [t.cpuModel, txt(cpu.brand)],
        [t.cpuVendor, txt(cpu.vendor)],
        [t.cpuPhysicalCores, txt(cpu.physicalCores)],
        [t.cpuLogicalCores, txt(cpu.logicalCores)],
        [t.cpuBaseClock, ghz(cpu.baseMhz)],
        [t.cpuMaxClock, ghz(cpu.maxMhz)],
        [t.cpuCurrentClock, ghz(cpu.currentMhzAvg)],
        [t.cpuCacheL1, kb(cpu.cacheL1Kb)],
        [t.cpuCacheL2, kb(cpu.cacheL2Kb)],
        [t.cpuCacheL3, kb(cpu.cacheL3Kb)],
      ],
    },
    { title: t.cardMemory, rows: memRows },
    { title: "GPU", rows: gpuRows },
    {
      title: t.cardBoard,
      rows: board
        ? [
            [t.boardVendor, txt(board.manufacturer)],
            [t.boardModel, txt(board.product)],
            [t.biosVendor, txt(board.biosVendor)],
            [t.biosVersion, txt(board.biosVersion)],
            [t.biosDate, txt(board.biosDate)],
          ]
        : [[t.board, null]],
    },
    { title: t.cardStorage, rows: volRows },
    {
      title: t.cardApp,
      rows: [
        [t.appVersion, txt(app.version)],
        ["Tauri", txt(app.tauriVersion)],
        ["WebView", txt(app.webviewVersion)],
        [t.appBuild, app.buildProfile === "debug" ? t.appBuildDebug : t.appBuildRelease],
      ],
    },
  ];
}

/** 지원 문의용 텍스트 요약 — 화면과 같은 카드 모델을 그대로 직렬화한다. */
function toSummary(cards: Card[], d: SystemInfo, msg: Messages): string {
  const t = msg.sysmon.systemInfo;
  const body = cards
    .map(
      (c) =>
        `[${c.title}]\n${c.rows.map(([k, v]) => `  ${k}: ${v ?? t.none}`).join("\n")}`,
    )
    .join("\n\n");
  const notes = d.notes.length
    ? `\n\n${t.summaryNotesHeader}\n${d.notes.map((n) => `  - ${n}`).join("\n")}`
    : "";
  return `${body}${notes}\n`;
}

function InfoCard({ card, noteTip }: { card: Card; noteTip?: string }) {
  const msg = useMessages();
  return (
    <section className="overflow-hidden rounded border border-edge bg-panel">
      <h3 className="border-b border-edge px-3 py-1.5 text-[11px] font-medium text-fg">
        {card.title}
      </h3>
      <table className="w-full table-fixed border-collapse text-[11px]">
        <tbody>
          {card.rows.map(([k, v], i) => (
            <tr key={`${k}:${i}`} className="border-b border-edge/40 last:border-0">
              <td className="w-[38%] px-3 py-1 align-top text-fg-dim">{k}</td>
              <td
                className={`px-3 py-1 break-words ${
                  v == null ? "text-fg-dim" : "text-fg-muted"
                }`}
                title={v == null ? noteTip : undefined}
              >
                {v ?? msg.sysmon.systemInfo.none}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * 시스템 정보 뷰(태스크 31) — OS/CPU/메모리/GPU/메인보드·BIOS/저장장치/앱 사양.
 * 정적 값이라 staleTime ∞ 로 탭을 열 때 1회만 받는다(백엔드도 캐시). "새로고침"은
 * force 수집 결과를 같은 캐시에 직접 써 넣어 재요청 없이 갱신한다.
 */
export function SystemInfoView() {
  const msg = useMessages();
  const qc = useQueryClient();
  const pushToast = useUi((s) => s.pushToast);
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["sys-info"],
    queryFn: () => ipc.sysInfoStatic(false),
    staleTime: Infinity,
    // 수집 실패(플랫폼 명령 부재 등)는 재시도해도 같은 결과 — 오류를 바로 보여주고
    // 사용자가 "새로고침"으로 다시 시도하게 한다.
    retry: false,
  });

  const cards = data ? toCards(data, msg) : [];
  const noteTip = data && data.notes.length ? data.notes.join("\n") : undefined;

  const refresh = () => {
    setRefreshing(true);
    void ipc
      .sysInfoStatic(true)
      .then((d) => qc.setQueryData(["sys-info"], d))
      .catch((e) => pushToast("error", errorMessage(e)))
      .finally(() => setRefreshing(false));
  };

  const copySummary = () => {
    if (!data) return;
    void copyText(toSummary(cards, data, msg)).then((ok) =>
      pushToast(
        ok ? "success" : "error",
        ok ? msg.sysmon.systemInfo.copied : msg.sysmon.systemInfo.copyFailed,
      ),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-fg-dim">
          {data
            ? msg.sysmon.systemInfo.collectedAt(
                dateTime(data.collectedAtMs) ?? msg.sysmon.systemInfo.none,
              )
            : isLoading
              ? msg.sysmon.systemInfo.collecting
              : ""}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          title={msg.sysmon.systemInfo.refreshTitle}
          className={`flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg ${
            refreshing ? "cursor-default opacity-60" : ""
          }`}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          {msg.sysmon.systemInfo.refresh}
        </button>
        <button
          type="button"
          onClick={copySummary}
          disabled={!data}
          title={msg.sysmon.systemInfo.copySummaryTitle}
          className={`flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg ${
            data ? "" : "cursor-default opacity-60"
          }`}
        >
          <Copy size={12} />
          {msg.sysmon.systemInfo.copySummary}
        </button>
      </div>

      <div className="min-h-0 flex-1 select-text space-y-2.5 overflow-y-auto p-3">
        {isLoading ? (
          <div className="px-4 py-10 text-center text-xs text-fg-dim">
            {msg.sysmon.systemInfo.collectingLong}
          </div>
        ) : error ? (
          <div className="px-4 py-10 text-center text-xs text-danger/80">
            {msg.sysmon.systemInfo.collectFailed(errorMessage(error))}
            <div className="mt-1 text-[10px] text-fg-dim">
              {msg.sysmon.systemInfo.retryHint}
            </div>
          </div>
        ) : (
          cards.map((c) => (
            <InfoCard key={c.title} card={c} noteTip={noteTip} />
          ))
        )}
      </div>
    </div>
  );
}
