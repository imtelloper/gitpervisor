// 무거운 영상 작업 대기열 — 빠른 재생용 사본과 간격 프레임 추출을 **한 줄**에 세워 하나씩 돌린다(사용자 요청 2026-09-30:
// "다 태스크 큐에"). 여러 영상에서 눌러도 뒤에 서고, 앞이 끝나면 알아서 다음을 시작한다.
//
// - 한 번에 하나만: 둘 다 원본 전체를 한 번 읽는 디스크 일이다(사본은 video_remux.rs, 추출은 파이프로 흘려 NVDEC 디코드).
//   같은 USB HDD에서 둘을 동시에 돌리면 헤드가 두 파일 사이를 오가 둘 다 몇 배 느려진다 — 차례로 도는 편이 합계로도 빠르다.
// - 상태가 여기 있는 이유: 안내 띠·팝오버는 파일을 바꾸면 사라지지만 작업은 계속 돈다.
// - 종결: 사본은 video://export-finished와 invoke 중 **먼저 온 쪽** 한 번(convertToMp4와 같은 계약), 추출은 videoFrames.run이
//   채널 종결과 invoke 중 먼저 온 쪽으로 푼다.
//
// ponytail: 대기열은 창마다 따로다(스토어가 창별). 문서 창과 메인 창에서 각각 누르면 두 작업이 동시에 돈다 —
// 겪으면 Rust 쪽에 허가 1개 세마포어를 두어 창과 무관하게 줄 세운다.
import type { QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import { currentMessages } from "../i18n/ui-language";
import { markLocalVideoJob, takeLocalVideoJob } from "../lib/events";
import {
  errorMessage,
  ipc,
  isIpcError,
  type VideoExportFinished,
  type VideoExportProgress,
  type VideoFramesFormat,
} from "../lib/ipc";
import { useUi } from "./ui";
import { useVideoFrames } from "./videoFrames";

interface TaskBase {
  id: string;
  projectId: string;
  srcRel: string;
  state: "queued" | "running";
  /** 사본의 진행률. 추출은 videoFrames.job이 장 수까지 들고 있어 거기서 읽는다. */
  pct: number;
}

export interface FastCopyTask extends TaskBase {
  kind: "fastCopy";
  outRel: string;
  /** ffmpeg 폴백(리먹서 지원 밖)에 넘길 길이·오디오 — 이런 파일은 probe가 시간 초과하기 일쑤라 0이면 바이트 진행률. */
  durationMs: number;
  hasAudio: boolean;
}

export interface FramesTask extends TaskBase {
  kind: "frames";
  intervalSecs: number;
  format: VideoFramesFormat;
  durationMs: number;
  /** 끝난 뒤 트리·상태 갱신용 — 시작한 창의 것. */
  qc: QueryClient;
}

export type MediaTask = FastCopyTask | FramesTask;
type NewTask = Omit<FastCopyTask, "state" | "pct"> | Omit<FramesTask, "state" | "pct">;

export interface MediaTaskDone {
  kind: MediaTask["kind"];
  srcRel: string;
  projectId: string;
  /** 사본: 만들어졌거나 이미 있던 사본의 경로 — 그 영상을 보고 있으면 연다. 실패·추출은 null. */
  openRel: string | null;
}

interface MediaQueueState {
  /** 순서 = 대기열. 도는 작업은 늘 하나이고 맨 앞이다. */
  tasks: MediaTask[];
  /** 같은 영상의 같은 종류가 이미 대기열에 있으면 무시한다(두 번 눌러도 하나). */
  enqueue: (task: NewTask) => void;
  /** 대기 중이면 빼고, 도는 중이면 취소한다. */
  cancel: (id: string) => void;
}

const doneListeners = new Set<(d: MediaTaskDone) => void>();
/** 작업이 끝날 때마다 — 그 영상을 보고 있는 플레이어가 사본을 연다(대기열은 누가 보고 있는지 모른다). */
export function onMediaTaskDone(cb: (d: MediaTaskDone) => void): () => void {
  doneListeners.add(cb);
  return () => doneListeners.delete(cb);
}

/** 도는 사본의 종결을 한 번만 받는다 — 이벤트와 invoke 중 먼저 온 쪽. */
let settleRunningCopy: ((ok: boolean) => void) | null = null;

export const useMediaQueue = create<MediaQueueState>((set, get) => ({
  tasks: [],
  enqueue: (task) => {
    if (get().tasks.some((t) => t.kind === task.kind && t.projectId === task.projectId && t.srcRel === task.srcRel)) return;
    set((s) => ({ tasks: [...s.tasks, { ...task, state: "queued", pct: 0 } as MediaTask] }));
    pump();
  },
  cancel: (id) => {
    const t = get().tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.state === "queued") {
      set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) }));
      return;
    }
    // 두 종류가 같은 잡 레지스트리라 내보내기 취소 커맨드가 그대로 먹는다(추출은 videoFrames.cancel이 같은 일을 한다).
    if (t.kind === "frames") useVideoFrames.getState().cancel();
    else void ipc.videoExportCancel(id).catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
  },
}));

let listening = false;
/** 사본 진행률·종결 이벤트는 모든 창에 온다 — 이 대기열의 작업만 골라 받는다. 한 번만 단다. */
function ensureListeners() {
  if (listening) return;
  listening = true;
  void listen<VideoExportProgress>("video://export-progress", (e) => {
    const { jobId, percent } = e.payload;
    const q = useMediaQueue.getState();
    if (!q.tasks.some((t) => t.id === jobId)) return;
    useMediaQueue.setState({ tasks: q.tasks.map((t) => (t.id === jobId ? { ...t, pct: percent } : t)) });
  });
  void listen<VideoExportFinished>("video://export-finished", (e) => {
    const run = useMediaQueue.getState().tasks[0];
    if (run?.kind === "fastCopy" && run.state === "running" && run.id === e.payload.jobId) settleRunningCopy?.(e.payload.ok);
  });
}

function pump() {
  ensureListeners();
  const { tasks } = useMediaQueue.getState();
  if (tasks.length === 0 || tasks[0].state === "running") return;
  const head = { ...tasks[0], state: "running" as const };
  useMediaQueue.setState({ tasks: [head, ...tasks.slice(1)] });
  const done = (openRel: string | null) => {
    useMediaQueue.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== head.id) }));
    doneListeners.forEach((cb) => cb({ kind: head.kind, srcRel: head.srcRel, projectId: head.projectId, openRel }));
    pump();
  };
  if (head.kind === "fastCopy") void runFastCopy(head, done);
  else
    void useVideoFrames
      .getState()
      .run({
        jobId: head.id,
        projectId: head.projectId,
        srcRel: head.srcRel,
        intervalSecs: head.intervalSecs,
        format: head.format,
        durationMs: head.durationMs,
        qc: head.qc,
      })
      .then(() => done(null));
}

async function runFastCopy(job: FastCopyTask, done: (openRel: string | null) => void) {
  const t = currentMessages().media.fastStart;
  let settled = false;
  const finish = (openRel: string | null) => {
    if (settled) return;
    settled = true;
    settleRunningCopy = null;
    done(openRel);
  };
  settleRunningCopy = (ok) => finish(ok ? job.outRel : null);
  markLocalVideoJob(job.id); // 완료·실패·취소 토스트는 events.ts가 이 창에서 띄운다
  try {
    try {
      await ipc.videoFastStartCopy(job.projectId, job.id, job.srcRel, job.outRel);
    } catch (e) {
      // 리먹서가 못 다루는 구조 — 종결 이벤트 없이 돌아왔으니 같은 잡 id로 이어 간다(진행률 구독·취소·토스트가 그대로 이어진다).
      if (!(isIpcError(e) && e.code === "UNSUPPORTED")) throw e;
      await ipc.videoExport(job.projectId, job.id, {
        srcRel: job.srcRel,
        outRel: job.outRel,
        overwrite: false,
        range: null,
        mode: "copy",
        speed: null,
        crop: null,
        masks: null,
        maskKind: "mosaic",
        crf: null,
        maxHeight: null,
        removeAudio: false,
        durationMs: job.durationMs,
        hasAudio: job.hasAudio,
      });
    }
    finish(job.outRel);
  } catch (e) {
    // 종결 이벤트가 이미 알렸으면(잡이 돈 뒤의 실패·취소) 표시가 거둬져 있다 — 남아 있으면 이벤트가 없는 실패다.
    const unreported = takeLocalVideoJob(job.id);
    const name = job.outRel.split("/").pop() ?? job.outRel;
    if (isIpcError(e) && e.code === "ALREADY_EXISTS") {
      // 내보내기는 tmp → rename이라 같은 이름이 있으면 완성된 사본이다 — 다시 만들지 않고 그걸 쓴다.
      useUi.getState().pushToast("info", t.exists(name));
      finish(job.outRel);
      return;
    }
    if (unreported)
      // 잡 시작 전 실패(원본 없음·원본 덮어쓰기·커맨드 없음)는 이벤트가 없어 무반응이었다.
      useUi.getState().pushToast(isIpcError(e) && e.code === "CANCELLED" ? "info" : "error", errorMessage(e));
    finish(null);
  }
}

if (import.meta.env.DEV) {
  // e2e 70이 대기열 순서를 잰다 — main.tsx의 __gpv에 넣으면 그 전역 모듈이 바뀌어 떠 있는 dev 창이 통째로 다시 읽힌다.
  (window as unknown as { __gpvMediaQueue?: unknown }).__gpvMediaQueue = useMediaQueue;
}
