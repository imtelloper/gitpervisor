// 간격 프레임 추출 — 플레이어 헤더의 "프레임" 옆 버튼 + 팝오버(간격·형식 → 시작 · 진행률 · 취소).
// 시작은 대기열(stores/mediaQueue.ts — 빠른 재생 사본과 한 줄)에 넣고, 도는 잡의 장 수·진행률은 stores/videoFrames.ts가 든다
// (파일을 바꿔도 추출은 계속되고, 돌아오면 진행률이 다시 보인다).
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Images, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import type { VideoFramesFormat } from "../../lib/ipc";
import { useMediaQueue } from "../../stores/mediaQueue";
import { useOccludesWebview } from "../../stores/occlusion";
import { expectedFrameCount, useVideoFrames } from "../../stores/videoFrames";
import { splitPath } from "./frameCapture";

const PRESETS = [1, 2, 5, 10];
const FORMATS: VideoFramesFormat[] = ["jpg", "png"];

export function FrameExtractButton({
  projectId,
  path,
  durationMs,
  hasFfmpeg,
}: {
  projectId: string;
  path: string;
  durationMs: number;
  hasFfmpeg: boolean;
}) {
  const msg = useMessages();
  const t = msg.media.frameExtract;
  const tq = msg.media.mediaQueue;
  const qc = useQueryClient();
  const job = useVideoFrames((s) => s.job);
  const cancel = useVideoFrames((s) => s.cancel);
  const tasks = useMediaQueue((s) => s.tasks);
  const mine = job !== null && job.projectId === projectId && job.srcRel === path;
  const queuedIdx = tasks.findIndex(
    (x) => x.kind === "frames" && x.state === "queued" && x.projectId === projectId && x.srcRel === path,
  );
  const queued = queuedIdx >= 0 ? tasks[queuedIdx] : null;
  // 메타데이터가 늦는 파일(조각 fMP4)은 duration이 0·NaN·Infinity일 수 있다 — 그땐 0을 보내 백엔드가 잰다.
  const knownMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  const [intervalText, setIntervalText] = useState("2");
  const [format, setFormat] = useState<VideoFramesFormat>("jpg");
  const btnRef = useRef<HTMLButtonElement>(null);
  useOccludesWebview(!!pos);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos]);

  const toggle = () => {
    if (pos) return setPos(null);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ right: Math.max(8, window.innerWidth - r.right), top: r.bottom + 4 });
  };

  const interval = Number(intervalText);
  const valid = intervalText.trim() !== "" && interval >= 0.1 && interval <= 3600;
  const percent = mine ? Math.floor(job.percent) : 0;
  // 미리보기용 이름 — 실제 이름은 백엔드가 고르고(video.rs frames_folder_base + 중복이면 _2…) 완료 토스트에 뜬다.
  const folder = `${splitPath(path).stem}_frames_${valid ? interval : "?"}s`;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={!hasFfmpeg}
        title={hasFfmpeg ? t.buttonTitle : msg.media.player.frameNeedsFfmpeg}
        className={`flex items-center gap-1 rounded px-2 py-0.5 hover:bg-raised disabled:text-fg-dim/50 disabled:hover:bg-transparent ${
          pos || mine ? "text-accent" : "hover:text-fg"
        }`}
      >
        {mine ? (
          <>
            <Loader2 size={12} className="animate-spin" /> {percent}%
          </>
        ) : queued ? (
          <>
            <Clock size={12} /> {tq.queued(queuedIdx)}
          </>
        ) : (
          <>
            <Images size={12} /> {t.title}
          </>
        )}
      </button>
      {pos && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPos(null)} />
          <div
            className="fixed z-50 w-80 rounded-md border border-edge bg-panel p-3 text-[12px] text-fg-muted shadow-xl"
            style={{ right: pos.right, top: pos.top }}
          >
            <div className="mb-2 font-medium text-fg">{t.title}</div>
            {mine ? (
              <div className="space-y-2">
                {(job.expected > 0 || job.percent > 0) && (
                  <div className="h-1.5 overflow-hidden rounded bg-raised">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
                  </div>
                )}
                <div className="tabular-nums">
                  {job.expected > 0
                    ? t.running(job.frames, job.expected, percent)
                    : job.percent > 0
                      ? t.runningNoExpected(job.frames, percent)
                      : t.runningNoTotal(job.frames)}
                </div>
                <button
                  onClick={cancel}
                  className="w-full rounded border border-edge px-2 py-1 text-warn hover:bg-raised"
                >
                  {t.cancel}
                </button>
              </div>
            ) : queued ? (
              <div className="space-y-2">
                <div className="tabular-nums">{tq.queued(queuedIdx)}</div>
                <button
                  onClick={() => useMediaQueue.getState().cancel(queued.id)}
                  className="w-full rounded border border-edge px-2 py-1 hover:bg-raised"
                >
                  {tq.unqueue}
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="w-10 shrink-0">{t.interval}</span>
                  <input
                    type="number"
                    min={0.1}
                    max={3600}
                    step={0.5}
                    value={intervalText}
                    onChange={(e) => setIntervalText(e.target.value)}
                    className="w-16 rounded border border-edge bg-base px-1.5 py-0.5 text-fg tabular-nums"
                  />
                  <span>{t.seconds}</span>
                  <div className="ml-auto flex gap-1">
                    {PRESETS.map((sec) => (
                      <button
                        key={sec}
                        onClick={() => setIntervalText(String(sec))}
                        className={`rounded px-1.5 py-0.5 ${
                          interval === sec ? "bg-raised text-accent" : "hover:bg-raised hover:text-fg"
                        }`}
                      >
                        {t.preset(sec)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-10 shrink-0">{t.format}</span>
                  {FORMATS.map((f) => (
                    <button
                      key={f}
                      onClick={() => setFormat(f)}
                      className={`rounded px-2 py-0.5 uppercase ${
                        format === f ? "bg-raised text-accent" : "hover:bg-raised hover:text-fg"
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                  {valid && knownMs > 0 && (
                    <span className="ml-auto tabular-nums text-fg">
                      {t.estimate(expectedFrameCount(knownMs, interval))}
                    </span>
                  )}
                </div>
                {!valid && <div className="text-danger">{t.intervalInvalid}</div>}
                <div className="space-y-0.5 text-[11px] leading-4 text-fg-dim">
                  <div className="break-all">{t.where(folder)}</div>
                  <div className="break-all">{t.naming(`${splitPath(path).stem}_01h23m45s.${format}`)}</div>
                </div>
                <button
                  onClick={() =>
                    useMediaQueue.getState().enqueue({
                      kind: "frames",
                      id: crypto.randomUUID(),
                      projectId,
                      srcRel: path,
                      intervalSecs: interval,
                      format,
                      durationMs: knownMs,
                      qc,
                    })
                  }
                  disabled={!valid}
                  title={tasks.length > 0 ? tq.queueTitle(tasks.length) : undefined}
                  className="w-full rounded bg-accent/20 px-2 py-1 text-accent hover:bg-accent/30 disabled:opacity-50"
                >
                  {t.start}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
