import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { copyText } from "../../lib/clipboard";
import { formatBytes } from "../../lib/format";
import { errorMessage, ipc } from "../../lib/ipc";
import type { SystemInfo } from "../../lib/ipc";
import { useUi } from "../../stores/ui";

/** 못 구한 항목의 표시값 — 카드 전체를 죽이지 않고 이 셀만 비운다(설계 §1). */
const NONE = "정보 없음";

/** 값 정규화 — null/빈 문자열은 전부 "정보 없음"으로 수렴시킨다. */
function txt(v: string | number | null | undefined): string {
  if (v == null) return NONE;
  const s = String(v).trim();
  return s === "" ? NONE : s;
}

/** MHz → "3.60 GHz"(소수 2자리, 설계 §3.3). */
function ghz(mhz: number | null | undefined): string {
  return mhz == null || mhz <= 0 ? NONE : `${(mhz / 1000).toFixed(2)} GHz`;
}

/** 캐시 크기는 KB로 온다 — 바이트 표기는 기존 formatBytes로 통일. */
function kb(v: number | null | undefined): string {
  return v == null || v <= 0 ? NONE : formatBytes(v * 1024);
}

function bytes(v: number | null | undefined): string {
  return v == null || v <= 0 ? NONE : formatBytes(v);
}

/** 가동 시간 — "3d 4h 12m"(설계 §3.3). */
function uptime(secs: number): string {
  if (secs <= 0) return NONE;
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return [d ? `${d}d` : "", h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ");
}

function dateTime(ms: number): string {
  if (!ms) return NONE;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

const VOLUME_KIND: Record<string, string> = {
  ssd: "SSD",
  hdd: "HDD",
  unknown: "종류 불명",
};

interface Card {
  title: string;
  rows: [string, string][];
}

/** 응답 → 카드 7개. 표시와 "요약 복사"가 같은 모델을 쓰므로 둘이 어긋날 수 없다. */
function toCards(d: SystemInfo): Card[] {
  const { os, cpu, memory, gpus, board, volumes, app } = d;

  const memRows: [string, string][] = [
    ["총 용량", bytes(memory.totalBytes)],
    ["스왑", bytes(memory.swapTotalBytes)],
  ];
  if (memory.modules.length === 0) {
    memRows.push(["메모리 모듈", NONE]);
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
      memRows.push([txt(m.slot) === NONE ? "모듈" : m.slot, detail]);
    }
  }

  const gpuRows: [string, string][] = [];
  if (gpus.length === 0) {
    gpuRows.push(["GPU", NONE]);
  } else {
    gpus.forEach((g, i) => {
      // GPU가 하나뿐이면 접두사 없이 — 내장+외장인 노트북에서만 번호를 붙인다.
      const p = gpus.length > 1 ? `GPU ${i + 1} ` : "";
      gpuRows.push([`${p}이름`, txt(g.name)]);
      gpuRows.push([`${p}드라이버`, txt(g.driverVersion)]);
      gpuRows.push([`${p}드라이버 날짜`, txt(g.driverDate)]);
      gpuRows.push([`${p}VRAM`, bytes(g.vramBytes)]);
      gpuRows.push([
        `${p}종류`,
        g.isDiscrete == null ? NONE : g.isDiscrete ? "외장" : "내장",
      ]);
    });
  }

  const volRows: [string, string][] =
    volumes.length === 0
      ? [["볼륨", NONE]]
      : volumes.map((v) => [
          txt(v.mount),
          [
            txt(v.name) === NONE ? null : v.name,
            VOLUME_KIND[v.kind] ?? VOLUME_KIND.unknown,
            txt(v.fs) === NONE ? null : v.fs,
            `${formatBytes(v.totalBytes)} (여유 ${formatBytes(v.availableBytes)})`,
            v.removable ? "이동식" : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ]);

  return [
    {
      title: "OS",
      rows: [
        ["이름", txt(os.name)],
        ["버전", txt(os.version)],
        ["빌드", txt(os.build)],
        ["커널", txt(os.kernel)],
        ["아키텍처", txt(os.arch)],
        ["호스트 이름", txt(os.hostName)],
        ["사용자", txt(os.userName)],
        ["설치 날짜", txt(os.installDate)],
        ["부팅 시각", dateTime(os.bootTimeMs)],
        ["가동 시간", uptime(os.uptimeSecs)],
      ],
    },
    {
      title: "CPU",
      rows: [
        ["모델", txt(cpu.brand)],
        ["제조사", txt(cpu.vendor)],
        ["물리 코어", txt(cpu.physicalCores)],
        ["논리 프로세서", txt(cpu.logicalCores)],
        ["기본 클럭", ghz(cpu.baseMhz)],
        ["최대 클럭", ghz(cpu.maxMhz)],
        ["현재 클럭(평균)", ghz(cpu.currentMhzAvg)],
        ["L1 캐시", kb(cpu.cacheL1Kb)],
        ["L2 캐시", kb(cpu.cacheL2Kb)],
        ["L3 캐시", kb(cpu.cacheL3Kb)],
      ],
    },
    { title: "메모리", rows: memRows },
    { title: "GPU", rows: gpuRows },
    {
      title: "메인보드 · BIOS",
      rows: board
        ? [
            ["제조사", txt(board.manufacturer)],
            ["모델", txt(board.product)],
            ["BIOS 제조사", txt(board.biosVendor)],
            ["BIOS 버전", txt(board.biosVersion)],
            ["BIOS 날짜", txt(board.biosDate)],
          ]
        : [["메인보드", NONE]],
    },
    { title: "저장장치", rows: volRows },
    {
      title: "앱",
      rows: [
        ["버전", txt(app.version)],
        ["Tauri", txt(app.tauriVersion)],
        ["WebView", txt(app.webviewVersion)],
        ["빌드", app.buildProfile === "debug" ? "개발(debug)" : "릴리스"],
      ],
    },
  ];
}

/** 지원 문의용 텍스트 요약 — 화면과 같은 카드 모델을 그대로 직렬화한다. */
function toSummary(cards: Card[], d: SystemInfo): string {
  const body = cards
    .map(
      (c) =>
        `[${c.title}]\n${c.rows.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
    )
    .join("\n\n");
  const notes = d.notes.length
    ? `\n\n[수집 참고]\n${d.notes.map((n) => `  - ${n}`).join("\n")}`
    : "";
  return `${body}${notes}\n`;
}

function InfoCard({ card, noteTip }: { card: Card; noteTip?: string }) {
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
                  v === NONE ? "text-fg-dim" : "text-fg-muted"
                }`}
                title={v === NONE ? noteTip : undefined}
              >
                {v}
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

  const cards = data ? toCards(data) : [];
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
    void copyText(toSummary(cards, data)).then((ok) =>
      pushToast(
        ok ? "success" : "error",
        ok ? "시스템 정보를 복사했습니다" : "복사에 실패했습니다",
      ),
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-panel px-3 py-2">
        <span className="min-w-0 truncate text-[11px] text-fg-dim">
          {data
            ? `수집 ${dateTime(data.collectedAtMs)}`
            : isLoading
              ? "수집 중…"
              : ""}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          title="다시 수집합니다 (수 초 걸릴 수 있습니다)"
          className={`flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg ${
            refreshing ? "cursor-default opacity-60" : ""
          }`}
        >
          <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
          새로고침
        </button>
        <button
          type="button"
          onClick={copySummary}
          disabled={!data}
          title="모든 항목을 텍스트로 복사합니다 (지원 문의용)"
          className={`flex items-center gap-1 rounded border border-edge px-2 py-1 text-[11px] text-fg-muted transition-colors hover:bg-raised hover:text-fg ${
            data ? "" : "cursor-default opacity-60"
          }`}
        >
          <Copy size={12} />
          요약 복사
        </button>
      </div>

      <div className="min-h-0 flex-1 select-text space-y-2.5 overflow-y-auto p-3">
        {isLoading ? (
          <div className="px-4 py-10 text-center text-xs text-fg-dim">
            시스템 정보를 수집하는 중…
          </div>
        ) : error ? (
          <div className="px-4 py-10 text-center text-xs text-danger/80">
            수집 실패: {errorMessage(error)}
            <div className="mt-1 text-[10px] text-fg-dim">
              "새로고침"으로 다시 시도할 수 있습니다
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
