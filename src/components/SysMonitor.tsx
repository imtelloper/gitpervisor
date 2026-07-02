import type { ProcSortKey } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { useSysMetrics } from "../queries";
import { writeSysmonSortKey } from "./sysmon/prefs";

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
 *  이미 떠 있으면 백엔드가 포커스만 준다(싱글턴 — 정렬은 창이 부팅 시 1회 읽는다). */
function openSysmon(sortBy?: ProcSortKey) {
  if (sortBy) writeSysmonSortKey(sortBy);
  void ipc.openSysmonWindow().catch((e) => {
    console.error("리소스 모니터 창 생성 실패:", e);
  });
}

function Metric({
  label,
  pct,
  tip,
  sortBy,
}: {
  label: string;
  pct: number | null;
  tip?: string;
  /** 클릭 시 팝업 초기 정렬로 넘길 지표 — 없으면(SSD) 정렬 유지한 채 열기만 */
  sortBy?: ProcSortKey;
}) {
  const v = pct == null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <button
      type="button"
      onClick={() => openSysmon(sortBy)}
      title={`${tip ? `${tip} — ` : ""}클릭하면 프로세스별 상세 보기`}
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

/** 타이틀바 좌측 시스템 모니터 (CPU / GPU / RAM / 저장소) — 클릭하면 프로세스별 상세 팝업.
 *  드래그 영역이 아니다(클릭 대상) — 타이틀바 드래그는 주변 spacer가 유지한다(태스크 05 §4.2). */
export function SysMonitor() {
  const { data: m } = useSysMetrics();

  return (
    <div className="flex items-center gap-2.5">
      <Metric label="CPU" pct={m?.cpu ?? null} tip="CPU 사용률" sortBy="cpu" />
      <Metric
        label="GPU"
        pct={m?.gpu ?? null}
        tip={m && m.gpu == null ? "GPU 사용률을 읽을 수 없음" : "GPU 사용률 (전 어댑터)"}
        sortBy="gpu"
      />
      <Metric
        label="RAM"
        pct={m?.ram ?? null}
        tip={m ? `메모리 ${gb(m.ramUsed)} / ${gb(m.ramTotal)} GB` : "메모리"}
        sortBy="ram"
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
