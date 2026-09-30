// 상태바 오른쪽 끝의 작업 버튼 — 지금 돌거나 줄 서 있는 긴 작업을 한곳에서 보고 취소한다(사용자 요청 2026-09-30).
//
// 긴 작업은 저마다 자기 스토어가 있다(사본·프레임 추출 대기열·분할 저장·자막 만들기·번역) — 여기는 **읽기만** 해서
// 한 목록으로 편다. 단일 내보내기(내보내기 패널·mp4로 변환)는 상태가 컴포넌트 안에만 있어 videoJobs가 따로 모은다.
// ponytail: 스토어가 창마다 따로라 이 창에서 시작한 작업만 보인다 — 문서 창의 작업까지 모으려면 Rust 잡 레지스트리를 창에 흘려야 한다.
import { ListTodo, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useMessages } from "../i18n/ui-language";
import { errorMessage, ipc } from "../lib/ipc";
import { useCaptionDoc } from "../stores/captionDoc";
import { useMediaQueue } from "../stores/mediaQueue";
import { useOccludesWebview } from "../stores/occlusion";
import { useUi } from "../stores/ui";
import { useVideoFrames } from "../stores/videoFrames";
import { useVideoJobs } from "../stores/videoJobs";
import { useVideoSplit } from "../stores/videoSplit";

interface TaskRow {
  key: string;
  kind: string;
  name: string;
  /** 0~100. 대기 중이면 null. */
  pct: number | null;
  detail: string | null;
  cancelLabel: string;
  onCancel: () => void;
}

const baseName = (rel: string) => rel.split("/").pop() ?? rel;

export function TaskCenter() {
  const msg = useMessages();
  const t = msg.app.tasks;
  const pushToast = useUi((s) => s.pushToast);
  const queue = useMediaQueue((s) => s.tasks);
  const frames = useVideoFrames((s) => s.job);
  const split = useVideoSplit((s) => s.batch);
  const exports = useVideoJobs((s) => s.jobs);
  const entries = useCaptionDoc((s) => s.entries);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // 펼친 목록이 내장 브라우저(네이티브 webview)에 가리지 않게.
  useOccludesWebview(open);

  const rows = useMemo<TaskRow[]>(() => {
    const out: TaskRow[] = [];
    // 대기열 순서 그대로 — 도는 추출의 장 수는 videoFrames가 들고 있다(같은 잡 id).
    queue.forEach((j, i) => {
      const run = j.state === "running";
      const live = j.kind === "frames" && run && frames?.jobId === j.id ? frames : null;
      out.push({
        key: `q:${j.id}`,
        kind: j.kind === "frames" ? t.kindFrames : t.kindFastCopy,
        name: baseName(j.srcRel),
        pct: !run ? null : live ? live.percent : j.pct,
        detail: !run
          ? t.queued(i)
          : live
            ? live.expected > 0
              ? t.framesDetail(live.frames, live.expected)
              : t.framesCount(live.frames)
            : null,
        cancelLabel: run ? t.cancel : t.unqueue,
        onCancel: () => useMediaQueue.getState().cancel(j.id),
      });
    });
    if (split)
      out.push({
        key: "split",
        kind: t.kindSplit,
        name: baseName(split.srcRel),
        pct: split.total > 0 ? ((split.done + split.currentPct / 100) / split.total) * 100 : 0,
        detail: t.splitDetail(split.done, split.total),
        cancelLabel: t.cancel,
        onCancel: () => useVideoSplit.getState().cancel(),
      });
    for (const j of exports)
      out.push({
        key: `export:${j.id}`,
        kind: t.kindExport,
        name: j.label,
        pct: j.pct,
        detail: null,
        cancelLabel: t.cancel,
        onCancel: () => void ipc.videoExportCancel(j.id).catch((e) => pushToast("error", errorMessage(e))),
      });
    for (const [key, e] of Object.entries(entries)) {
      if (e.job)
        out.push({
          key: `stt:${key}`,
          kind: t.kindCaptions,
          name: baseName(e.relPath),
          pct: e.job.percent,
          detail: null,
          cancelLabel: t.cancel,
          onCancel: () => useCaptionDoc.getState().cancelTranscribe(key),
        });
      if (e.translate)
        out.push({
          key: `tr:${key}`,
          kind: t.kindTranslate,
          name: baseName(e.relPath),
          pct: e.translate.total > 0 ? (e.translate.done / e.translate.total) * 100 : 0,
          detail: e.translate.status ?? t.translateDetail(e.translate.done, e.translate.total),
          cancelLabel: t.cancel,
          onCancel: () => useCaptionDoc.getState().cancelTranslate(key),
        });
    }
    return out;
  }, [queue, frames, split, exports, entries, t, pushToast]);

  // 바깥 클릭·Esc로 닫는다(다른 상태바 팝오버와 같은 규칙).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const busy = rows.length > 0;
  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        data-gpv="task-center"
        onClick={() => setOpen((v) => !v)}
        title={t.buttonTitle}
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-raised ${
          busy ? "text-accent" : "text-fg-dim hover:text-fg"
        }`}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <ListTodo size={11} />}
        {busy ? t.buttonCount(rows.length) : t.button}
      </button>
      {open && (
        <div
          data-gpv="task-center-list"
          className="absolute bottom-full right-0 z-50 mb-1 flex max-h-[60vh] w-80 flex-col overflow-y-auto rounded-md border border-edge bg-panel p-1.5 text-[11px] shadow-xl"
        >
          <div className="px-1.5 pb-1 font-semibold text-fg-muted">{t.title}</div>
          {rows.length === 0 ? (
            <div className="px-1.5 py-2 text-fg-dim">{t.empty}</div>
          ) : (
            rows.map((r) => (
              <div key={r.key} data-gpv="task-row" className="rounded px-1.5 py-1.5 hover:bg-raised">
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 rounded bg-raised px-1 text-[10px] text-fg-muted">{r.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-fg" title={r.name}>
                    {r.name}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-fg-muted">
                    {r.pct === null ? "" : `${Math.floor(r.pct)}%`}
                  </span>
                  <button
                    onClick={r.onCancel}
                    title={r.cancelLabel}
                    aria-label={r.cancelLabel}
                    className="shrink-0 rounded p-0.5 text-fg-dim hover:bg-panel hover:text-danger"
                  >
                    <X size={11} />
                  </button>
                </div>
                {r.pct !== null && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-edge">
                    <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, r.pct))}%` }} />
                  </div>
                )}
                {r.detail && <div className="mt-0.5 truncate text-fg-dim">{r.detail}</div>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
