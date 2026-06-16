import { useSysMetrics } from "../queries";

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

function Metric({
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
    <div
      data-tauri-drag-region
      title={tip}
      className="flex w-[50px] flex-col gap-[3px]"
    >
      <div className="flex items-baseline justify-between leading-none">
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
    </div>
  );
}

/** 타이틀바 좌측 시스템 모니터 (CPU / GPU / RAM / 저장소). */
export function SysMonitor() {
  const { data: m } = useSysMetrics();

  return (
    <div data-tauri-drag-region className="flex items-center gap-2.5">
      <Metric label="CPU" pct={m?.cpu ?? null} tip="CPU 사용률" />
      <Metric
        label="GPU"
        pct={m?.gpu ?? null}
        tip={m && m.gpu == null ? "GPU 사용률을 읽을 수 없음" : "GPU 사용률 (전 어댑터)"}
      />
      <Metric
        label="RAM"
        pct={m?.ram ?? null}
        tip={m ? `메모리 ${gb(m.ramUsed)} / ${gb(m.ramTotal)} GB` : "메모리"}
      />
      <Metric
        label="SSD"
        pct={m?.storage ?? null}
        tip={
          m ? `저장소 C: ${gb(m.storageUsed)} / ${gb(m.storageTotal)} GB` : "저장소"
        }
      />
    </div>
  );
}
