import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

import {
  ipc,
  type HealthLevel,
  type HealthSnapshot,
  type HealthTransition,
  type PrevSession,
} from "../../lib/ipc";
import { useUi } from "../../stores/ui";

const RANK: Record<HealthLevel, number> = { ok: 0, notice: 1, warn: 2, danger: 3 };

/**
 * "갑자기 꺼짐" 경보 배너.
 *
 * 2026-08-01 이 앱은 systemd-oomd에 의해 프로세스 387개와 함께 예고 없이 SIGKILL 됐다.
 * 사용자는 작업 중이었고 아무 경고도 받지 못했다. 이 배너는 두 순간을 담당한다.
 *  - **죽기 전**: 백엔드 감시가 oomd와 같은 지표를 읽어 레벨이 오르면 여기서 알린다.
 *  - **죽은 뒤**: 재시작 시 지난 세션이 비정상 종료였는지 진단해 한 번 보여준다.
 *
 * 표시 원칙: 숫자를 그대로 보여준다. "메모리 부족"만 띄우면 사용자는 아무것도 할 수 없다.
 */
export function HealthBanner() {
  const [snap, setSnap] = useState<HealthSnapshot | null>(null);
  const [prev, setPrev] = useState<PrevSession | null>(null);
  const [dismissed, setDismissed] = useState<HealthLevel | null>(null);
  const toastedAt = useRef(0);
  // 마지막으로 토스트를 띄운 레벨. 쿨다운은 "같은 레벨 반복"에만 적용하고, 레벨이 올라가면
  // 무조건 통과시킨다 — 안 그러면 warn 토스트 직후의 danger("지금 저장하세요")가 3분 쿨다운에
  // 막혀 정상 상승 경로에서 **항상** 유실된다. 이 기능이 존재하는 이유인 최종 경보다.
  const toastedLevel = useRef<HealthLevel>("ok");

  // 지난 실행이 비정상 종료였는지 — 시작 시 1회. 같은 세션을 두 번 알리지 않도록 마커를 둔다.
  useEffect(() => {
    void ipc
      .healthPrevSession()
      .then((p) => {
        if (!p.crashed) return;
        const key = p.record?.updatedAt ?? "unknown";
        if (localStorage.getItem("gp:prev-session-seen") === key) return;
        localStorage.setItem("gp:prev-session-seen", key);
        setPrev(p);
      })
      .catch(() => {});
  }, []);

  // 레벨 전이 구독 — 백엔드는 전이 시에만 발행한다(주기 IPC가 압박을 키우지 않도록).
  useEffect(() => {
    const un = listen<HealthTransition>("health://level", (e) => {
      const t = e.payload;
      setSnap({ level: t.level, sample: t.sample, reasons: t.reasons });
      if (t.level === "ok") {
        setDismissed(null);
        toastedLevel.current = "ok";
        return;
      }
      // 경고 이상에서만 OS 토스트. 주의 단계는 조용히 배너만 — 늑대소년이 되면 안 된다.
      if (t.level === "warn" || t.level === "danger") {
        const now = Date.now();
        const cooldown = t.level === "danger" ? 180_000 : 600_000;
        const escalated = RANK[t.level] > RANK[toastedLevel.current];
        if (escalated || now - toastedAt.current > cooldown) {
          toastedAt.current = now;
          toastedLevel.current = t.level;
          useUi
            .getState()
            .pushToast(
              "error",
              t.level === "danger"
                ? "곧 강제 종료될 수 있습니다 — 지금 저장하세요"
                : "메모리 압박이 높습니다 — 작업을 저장해 주세요",
            );
        }
      }
    });
    // 창을 새로 연 경우를 위해 현재 상태도 한 번 읽는다.
    void ipc
      .healthSnapshot()
      .then((s) => s && s.level !== "ok" && setSnap(s))
      .catch(() => {});
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const prevBanner = prev ? (
    <PrevSessionBanner prev={prev} onClose={() => setPrev(null)} />
  ) : null;

  // 주의 단계는 배너를 띄우지 않는다(상태바 칩 역할만). 위험 단계는 닫을 수 없다.
  const showLive =
    snap &&
    snap.sample.available &&
    (snap.level === "warn" || snap.level === "danger") &&
    !(dismissed === snap.level && snap.level !== "danger");
  if (!showLive) return prevBanner;

  const danger = snap.level === "danger";
  const s = snap.sample;

  // 지난 실행 안내와 현재 경보를 배타 관계로 두면, 이미 지나간 일 때문에 "지금 죽는다"는
  // 닫기 불가 배너가 렌더조차 안 된다. 둘 다 세로로 쌓는다.
  return (
    <>
      {prevBanner}
    <div
      role="alert"
      className={`flex items-start gap-3 border-b px-4 py-2.5 text-xs ${
        danger
          ? "border-red-900/60 bg-red-950/40 text-red-100"
          : "border-amber-900/60 bg-amber-950/30 text-amber-100"
      }`}
    >
      <span aria-hidden className="pt-0.5 text-sm">
        {danger ? "🔴" : "🟠"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {danger ? "곧 강제 종료될 수 있습니다 — 지금 저장하세요" : "강제 종료 위험"}
        </div>
        <ul className="mt-1 space-y-0.5 opacity-90">
          {snap.reasons.slice(0, 4).map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
        <div className="mt-1.5 font-mono text-[11px] opacity-70">
          압박 {s.anchorFullAvg10.toFixed(0)}% / 종료기준 {s.killThreshold.toFixed(0)}% · 프로세스{" "}
          {s.scopeProcs}개 · 앱 메모리 {(s.scopeMemBytes / 1_073_741_824).toFixed(1)}GB
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void ipc.openSysmonWindow()}
            className="rounded border border-current/30 px-2 py-1 hover:bg-white/10"
          >
            리소스 모니터 열기
          </button>
          {!danger && (
            <button
              type="button"
              onClick={() => setDismissed(snap.level)}
              className="rounded px-2 py-1 opacity-70 hover:bg-white/10 hover:opacity-100"
            >
              닫기
            </button>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

/** 재시작 시 1회 — 지난 실행이 왜 사라졌는지 알려준다. */
function PrevSessionBanner({ prev, onClose }: { prev: PrevSession; onClose: () => void }) {
  const r = prev.record;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-amber-900/60 bg-amber-950/30 px-4 py-2.5 text-xs text-amber-100"
    >
      <span aria-hidden className="pt-0.5 text-sm">
        ⚠
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">지난 실행이 비정상 종료되었습니다</div>
        <div className="mt-1 opacity-90">{prev.message}</div>
        {r && (
          <div className="mt-1.5 font-mono text-[11px] opacity-70">
            {new Date(r.updatedAt).toLocaleString()} · 프로세스 {r.last.scopeProcs}개 · 앱 메모리{" "}
            {(r.last.scopeMemBytes / 1_073_741_824).toFixed(1)}GB · 압박{" "}
            {r.last.anchorFullAvg10.toFixed(0)}%
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void ipc.openLogsFolder()}
            className="rounded border border-current/30 px-2 py-1 hover:bg-white/10"
          >
            로그 폴더 열기
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 opacity-70 hover:bg-white/10 hover:opacity-100"
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
