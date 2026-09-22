import { listen } from "@tauri-apps/api/event";
import { Activity, BellOff, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { flushAllDrafts } from "../../lib/drafts";
import { formatBytes } from "../../lib/format";
import {
  ipc,
  type HealthLevel,
  type HealthSnapshot,
  type HealthTransition,
  type PrevSession,
  type TopProc,
} from "../../lib/ipc";
import { useHealthMute } from "../../stores/health";

const RANK: Record<HealthLevel, number> = { ok: 0, notice: 1, warn: 2, danger: 3 };

/**
 * "갑자기 꺼짐" 경보 — 우측 하단 카드.
 *
 * 2026-08-01 이 앱은 systemd-oomd에 의해 프로세스 387개와 함께 예고 없이 SIGKILL 됐다.
 * 사용자는 작업 중이었고 아무 경고도 받지 못했다. 이 카드는 두 순간을 담당한다.
 *  - **죽기 전**: 백엔드 감시가 oomd와 같은 지표를 읽어 레벨이 오르면 여기서 알린다.
 *  - **죽은 뒤**: 재시작 시 지난 세션이 비정상 종료였는지 진단해 한 번 보여준다.
 *
 * 표시 원칙:
 *  - 숫자를 그대로 보여준다 — "메모리 부족"만 띄우면 사용자는 아무것도 할 수 없다.
 *  - 문구는 **시스템(OS)이 주어**다. "곧 강제 종료될 수 있습니다"처럼 주어를 생략하면
 *    앱이 자기 불안정을 자백하는 것처럼 읽힌다(실사용 피드백) — 실제 행위자는 OS의
 *    메모리 회수이고, 이 앱은 그걸 미리 알려주는 쪽이다.
 *  - 상단 전폭 배너가 아니라 **우측 하단 카드**로 띄운다 — 작업 영역을 밀어내지 않는다.
 *  - **모든 카드에 닫기(X)가 있다.** 위험 단계라고 닫기를 뺏으면 경고가 아니라 인질이 된다.
 *    닫으면 닫은 레벨 이하에선 숨기고, 그보다 올라가거나 정상(ok) 회복 후 재악화하면
 *    (ok 전이에서 dismissed 리셋) 다시 띄운다. danger 지속 중엔 5분 타이머가 재표시한다.
 *  - **그 재표시 규칙에서 완전히 빠지는 길도 준다**(`useHealthMute`). 여유 메모리가 상시
 *    빠듯한 머신에서는 레벨이 경계에서 영원히 흔들려 X만으로는 끌 수가 없다 — 되돌리기는
 *    설정 › 알림.
 */
export function HealthBanner() {
  const [snap, setSnap] = useState<HealthSnapshot | null>(null);
  const [prev, setPrev] = useState<PrevSession | null>(null);
  const [dismissed, setDismissed] = useState<HealthLevel | null>(null);

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
  // 별도 토스트는 띄우지 않는다 — 카드 자체가 같은 자리(우측 하단)에 나타나므로 토스트를
  // 겹치면 같은 경고를 두 번 울리는 셈이다(예전 상단 배너 + 토스트 조합의 과잉 경보 회귀 방지).
  useEffect(() => {
    const un = listen<HealthTransition>("health://level", (e) => {
      const t = e.payload;
      setSnap({ level: t.level, sample: t.sample, reasons: t.reasons });
      // 해소되면 닫음 기록도 리셋 — 다음 상승은 새 사건이니 다시 알린다.
      if (t.level === "ok") setDismissed(null);
    });
    // 백엔드가 warn 이상으로 올라갈 때 보내는 초안 저장 신호. 받는 쪽이 여기밖에 없다
    // (lib/drafts.ts) — 이 구독이 없으면 이벤트는 그냥 버려진다.
    const unFlush = listen("health://flush-drafts", () => flushAllDrafts());
    // 창을 새로 연 경우를 위해 현재 상태도 한 번 읽는다.
    void ipc
      .healthSnapshot()
      .then((s) => {
        if (!s || s.level === "ok") return;
        setSnap(s);
        // 이 창은 이미 지나간 전이 이벤트를 받지 못했다 — 경보 중이면 지금 한 번 비운다.
        if (s.level === "warn" || s.level === "danger") flushAllDrafts();
      })
      .catch(() => {});
    return () => {
      void un.then((f) => f());
      void unFlush.then((f) => f());
    };
  }, []);

  // danger를 닫은 채 위험이 그대로 지속되면 5분 뒤 카드를 다시 띄운다. 백엔드는 레벨
  // "전이" 시에만 발행하므로(주기 IPC가 압박을 키우지 않도록), danger에 고정된 상태에선
  // 이 타이머가 유일한 재알림 채널이다.
  useEffect(() => {
    if (dismissed !== "danger" || snap?.level !== "danger") return;
    const t = setTimeout(() => setDismissed(null), 300_000);
    return () => clearTimeout(t);
  }, [dismissed, snap]);

  // 사용자가 이 종류를 껐으면 실시간 카드는 아예 만들지 않는다(지난 실행 안내는 별개 —
  // 그건 1회성이고 이미 세션 키로 중복을 막는다).
  const muted = useHealthMute((st) => st.muted);
  const setMuted = useHealthMute((st) => st.setMuted);

  // 주의 단계는 카드를 띄우지 않는다(늑대소년 방지 — 경고 이상만). 닫으면 그 레벨 이하는
  // 숨기고 더 올라가면(warn 닫음 → danger) 다시 띄운다 — RANK 비교가 그 규칙이다.
  const showLive =
    !muted &&
    snap &&
    snap.sample.available &&
    (snap.level === "warn" || snap.level === "danger") &&
    RANK[snap.level] > RANK[dismissed ?? "ok"];

  if (!showLive && !prev) return null;

  // 위치 컨테이너는 App의 우측 하단 카드 스택이 갖는다 — 여기서 자기 fixed 박스를 또 만들면
  // 같은 좌표의 다른 카드(StarPrompt)와 겹친다. 여기서는 카드만 돌려준다.
  return (
    <>
      {prev && <PrevSessionCard prev={prev} onClose={() => setPrev(null)} />}
      {showLive && snap && (
        <LiveCard
          snap={snap}
          onClose={() => setDismissed(snap.level)}
          onMute={() => setMuted(true)}
        />
      )}
    </>
  );
}

/** 실시간 경보 카드 — OS가 메모리를 회수하기 전에 미리 알린다. */
function LiveCard({
  snap,
  onClose,
  onMute,
}: {
  snap: HealthSnapshot;
  onClose: () => void;
  onMute: () => void;
}) {
  const msg = useMessages();
  const danger = snap.level === "danger";
  const s = snap.sample;
  return (
    <div
      role="alert"
      className={`rounded-lg border bg-panel p-3 text-xs shadow-xl ${
        danger ? "border-danger/60" : "border-amber-700/60"
      }`}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="pt-0.5 text-sm">
          {danger ? "🔴" : "🟠"}
        </span>
        <div className={`min-w-0 flex-1 font-medium ${danger ? "text-danger" : "text-amber-300"}`}>
          {danger ? msg.shell.healthBanner.liveDangerTitle : msg.shell.healthBanner.liveWarnTitle}
        </div>
        <button
          onClick={onClose}
          title={msg.shell.healthBanner.liveCloseTitle}
          className="-mr-1 -mt-1 shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-1 pl-6 leading-5 text-fg-muted">
        {msg.shell.healthBanner.liveExplanation}
      </div>
      {snap.reasons.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-6 text-fg-muted opacity-90">
          {snap.reasons.slice(0, 4).map((r) => (
            <li key={r}>· {r}</li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 pl-6 font-mono text-[11px] text-fg-dim">
        {/* Windows에는 PSI가 없어 압박·종료기준이 항상 0이다 — "압박 0% / 종료기준 0%"라는
            거짓 수치가 카드에 박혀 있었다. 값이 실재할 때만 보여준다(session.rs와 같은 규칙). */}
        {s.killThreshold > 0 && (
          <>
            {msg.shell.healthBanner.livePressure(
              s.anchorFullAvg10.toFixed(0),
              s.killThreshold.toFixed(0),
            )}
            {" · "}
          </>
        )}
        {msg.shell.healthBanner.liveMemoryStats(
          s.memAvailablePct.toFixed(0),
          s.scopeProcs,
          (s.scopeMemBytes / 1_073_741_824).toFixed(1),
        )}
      </div>
      {/* 앱 메모리 한 덩어리만 보면 무엇을 닫아야 할지 알 수 없다 — 앱 자체(창·WebView2)와
          터미널에서 띄운 프로그램을 나눠 보여준다. Windows 전용 값이라 없을 수 있다. */}
      {s.scopeCoreBytes != null && s.scopeCoreBytes > 0 && (
        <div className="pl-6 font-mono text-[11px] text-fg-dim">
          {msg.shell.healthBanner.liveAppCore(formatBytes(s.scopeCoreBytes))}
          {s.scopeMemBytes - s.scopeCoreBytes > 0 && (
            <>
              {" · "}
              {msg.shell.healthBanner.liveTerminalPrograms(
                formatBytes(s.scopeMemBytes - s.scopeCoreBytes),
              )}
            </>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
        <button
          type="button"
          onClick={() => void ipc.openSysmonWindow()}
          className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <Activity size={12} /> {msg.shell.healthBanner.openResourceMonitor}
        </button>
        <button
          type="button"
          onClick={onMute}
          title={msg.shell.healthBanner.muteTitle}
          className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <BellOff size={12} /> {msg.shell.healthBanner.mute}
        </button>
      </div>
    </div>
  );
}

/**
 * 상위 프로세스를 **이름으로 합산**해 큰 순 n개. 같은 이름이 여러 개로 뜨는 게 정상이라
 * (msedgewebview2.exe 4~5개, pwsh.exe 13개) 개별로 나열하면 목록이 한 이름으로 채워진다.
 */
function topByName(top: TopProc[], n: number): [string, number][] {
  const sum = new Map<string, number>();
  for (const p of top) sum.set(p.name, (sum.get(p.name) ?? 0) + p.bytes);
  return [...sum].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** 재시작 시 1회 — 지난 실행이 왜 사라졌는지 알려준다. */
function PrevSessionCard({ prev, onClose }: { prev: PrevSession; onClose: () => void }) {
  const msg = useMessages();
  const r = prev.record;
  const top = r?.last.top?.length ? topByName(r.last.top, 3) : [];
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-700/60 bg-panel p-3 text-xs shadow-xl"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="pt-0.5 text-sm">
          ⚠
        </span>
        <div className="min-w-0 flex-1 font-medium text-amber-300">
          {msg.shell.healthBanner.prevSessionTitle}
        </div>
        <button
          onClick={onClose}
          title={msg.shell.healthBanner.prevSessionClose}
          className="-mr-1 -mt-1 shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-1 pl-6 leading-5 text-fg-muted">{prev.message}</div>
      {r && (
        <div className="mt-1.5 pl-6 font-mono text-[11px] text-fg-dim">
          {msg.shell.healthBanner.prevSessionStats(
            new Date(r.updatedAt).toLocaleString(),
            r.last.scopeProcs,
            (r.last.scopeMemBytes / 1_073_741_824).toFixed(1),
          )}
          {/* LiveCard와 같은 이유 — Windows엔 PSI가 없어 늘 "압박 0%"가 붙었다. */}
          {r.last.killThreshold > 0 && (
            <>
              {" · "}
              {msg.shell.healthBanner.prevSessionPressure(r.last.anchorFullAvg10.toFixed(0))}
            </>
          )}
        </div>
      )}
      {top.length > 0 && (
        <div className="mt-1 pl-6 font-mono text-[11px] text-fg-dim">
          {msg.shell.healthBanner.prevSessionTopProcs(
            top.map(([n, b]) => `${n} ${formatBytes(b)}`).join(" · "),
          )}
        </div>
      )}
      {/* OS가 남긴 흔적(Windows 이벤트 로그) — 앱 로그에는 아무것도 안 남는 종료 경로를
          여기서만 구분할 수 있다. 백엔드가 이미 한국어 문장으로 만들어 보낸다. */}
      {prev.osEvents && prev.osEvents.length > 0 && (
        <ul className="mt-1 space-y-0.5 pl-6 text-[11px] leading-4 text-fg-muted opacity-90">
          {prev.osEvents.map((e, i) => (
            <li key={i}>· {e}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 pl-6">
        <button
          type="button"
          onClick={() => void ipc.openLogsFolder()}
          className="flex items-center gap-1.5 rounded border border-edge px-2 py-1 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <FolderOpen size={12} /> {msg.shell.healthBanner.openLogsFolder}
        </button>
      </div>
    </div>
  );
}
