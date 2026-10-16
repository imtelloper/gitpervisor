// 프로세스 탭 머리의 CPU·GPU 온도 — 해당 사용률 게이지 바로 아래 한 줄(폭을 더 쓰지 않는다: 창이 좁으면
// 게이지를 두 개 더 놓을 자리가 없다). 2초 폴링, 프로세스 탭이 보일 때만.
// GPU는 건강 탭과 같은 gpu_temperatures(작업 관리자 경로), CPU는 cpu_temperature(HWiNFO/hwmon)를 쓴다.

import { useQuery } from "@tanstack/react-query";

import { useMessages } from "../../i18n/ui-language";
import { errorMessage, ipc } from "../../lib/ipc";

const POLL_MS = 2000;

export interface TempReading {
  celsius: number | null;
  tip: string;
}

// 온도 임계 색 — 80℃부터 주의, 90℃부터 위험(노트북 CPU·GPU의 스로틀 직전 구간).
function tempText(c: number): string {
  return c >= 90 ? "text-danger" : c >= 80 ? "text-warn" : "text-fg-muted";
}

export function useProcTemps(active: boolean): { cpu: TempReading; gpu: TempReading } {
  const w = useMessages().sysmon.window;
  const cpu = useQuery({
    queryKey: ["sysmon-cpu-temp"],
    queryFn: ipc.cpuTemperature,
    enabled: active,
    refetchInterval: active ? POLL_MS : false,
    retry: false,
  });
  const gpu = useQuery({
    queryKey: ["sysmon-gpu-temp"],
    queryFn: ipc.gpuTemperatures,
    enabled: active,
    refetchInterval: active ? POLL_MS : false,
    retry: false,
  });

  const cpuTip = cpu.error
    ? errorMessage(cpu.error)
    : (cpu.data?.unavailableReason ??
      (cpu.data?.source ? w.tempTip(w.cpuTemp, cpu.data.source) : w.cpuTemp));

  // 어댑터가 여럿이면(내장+외장) 가장 뜨거운 값을 보이고, 툴팁에 전부 적는다.
  const readable = (gpu.data?.gpus ?? []).filter((g) => g.temperatureC != null);
  const gpuC = readable.length ? Math.max(...readable.map((g) => g.temperatureC ?? 0)) : null;
  const gpuTip = gpu.error
    ? errorMessage(gpu.error)
    : !gpu.data?.supported
      ? (gpu.data?.unsupportedReason ?? w.gpuTemp)
      : readable.length
        ? readable.map((g) => `${g.name}: ${Math.round(g.temperatureC ?? 0)}℃`).join("\n")
        : w.gpuTempNone;

  return {
    cpu: { celsius: cpu.data?.temperatureC ?? null, tip: cpuTip },
    gpu: { celsius: gpuC, tip: gpuTip },
  };
}

/** 게이지 바 아래 줄 — "온도 64℃". 못 읽으면 "--" + 툴팁에 이유. */
export function TempLine({ reading }: { reading: TempReading }) {
  const label = useMessages().sysmon.window.tempShort;
  const v = reading.celsius == null ? null : Math.round(reading.celsius);
  return (
    <div title={reading.tip} className="flex items-baseline justify-between leading-none">
      <span className="text-[10px] text-fg-dim">{label}</span>
      <span className={`font-mono text-[10px] tabular-nums ${v == null ? "text-fg-dim" : tempText(v)}`}>
        {v == null ? "--" : `${v}℃`}
      </span>
    </div>
  );
}
