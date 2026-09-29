// 간격 프레임 추출 잡(video.rs `video_extract_frames`) — 플레이어 헤더의 추출 버튼이 연다.
//
// - 상태가 여기 있는 이유: 버튼·팝오버는 파일 전환(key={path})에 언마운트되지만 ffmpeg는 계속 돈다
//   (videoSplit과 같은 이유). 다른 영상으로 옮겨 가도 진행률·취소가 사라지지 않는다.
// - 한 번에 하나만 — 1시간 영상 디코드는 CPU를 다 쓴다(동시 ffmpeg를 띄우지 않는다, videoSplit 머리 주석).
// - 종결은 채널의 종결 메시지와 invoke 프라미스 중 **먼저 온 쪽**(Windows 응답 유실 대비 — video.rs FramesEvent).
import type { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";

import { currentMessages } from "../i18n/ui-language";
import {
  errorMessage,
  ipc,
  isIpcError,
  type VideoFramesEvent,
  type VideoFramesFormat,
} from "../lib/ipc";
import { useUi } from "./ui";

export interface FramesJob {
  projectId: string;
  srcRel: string;
  jobId: string;
  percent: number;
  frames: number;
  /** 예상 장 수(표시용) — expectedFrameCount */
  expected: number;
}

/** 예상 장 수 — 0, 간격, 2×간격 … 중 영상 길이 **미만**인 지점(끝 = 길이 지점엔 프레임이 없다: 10초 영상 1초 간격 = 10장,
 *  실측). 길이가 프레임 경계에 딱 맞지 않으면 ±1이라 "약"으로 보인다. */
export function expectedFrameCount(durationMs: number, intervalSecs: number): number {
  if (!(durationMs > 0) || !(intervalSecs > 0)) return 0;
  return Math.ceil(durationMs / 1000 / intervalSecs);
}

type FramesEnd = Exclude<VideoFramesEvent, { phase: "progress" }>;

interface VideoFramesState {
  job: FramesJob | null;
  start: (opts: {
    projectId: string;
    srcRel: string;
    intervalSecs: number;
    format: VideoFramesFormat;
    durationMs: number;
    qc: QueryClient;
  }) => void;
  cancel: () => void;
}

export const useVideoFrames = create<VideoFramesState>((set, get) => ({
  job: null,
  start: ({ projectId, srcRel, intervalSecs, format, durationMs, qc }) => {
    if (get().job) return;
    const jobId = crypto.randomUUID();
    set({
      job: {
        projectId,
        srcRel,
        jobId,
        percent: 0,
        frames: 0,
        expected: expectedFrameCount(durationMs, intervalSecs),
      },
    });
    let ended = false;
    const finish = (e: FramesEnd) => {
      if (ended) return;
      ended = true;
      set({ job: null });
      const ui = useUi.getState();
      const t = currentMessages().media.frameExtract;
      if (e.phase === "done") {
        ui.pushToast("success", t.done(e.count, e.outRel.split("/").pop() ?? e.outRel), {
          label: t.openFolder,
          run: () =>
            void ipc
              .revealInRepo(projectId, e.outRel)
              .catch((err) => useUi.getState().pushToast("error", errorMessage(err))),
        });
        void qc.invalidateQueries({ queryKey: ["dir"] });
        void qc.invalidateQueries({ queryKey: ["statuses"] });
      } else if (e.phase === "cancelled") ui.pushToast("info", t.cancelled);
      else ui.pushToast("error", e.message);
    };
    void ipc
      .videoExtractFrames(
        projectId,
        jobId,
        srcRel,
        intervalSecs,
        format,
        Math.max(0, Math.round(durationMs)), // Rust u64 — 소수면 역직렬화가 거절한다
        (e) => {
          if (e.phase !== "progress") return finish(e);
          if (ended) return;
          set((s) =>
            s.job?.jobId === jobId
              ? // 시작 때 길이를 몰랐으면(0) 백엔드가 ffprobe로 잰 예상 장 수로 채운다.
                { job: { ...s.job, percent: e.percent, frames: e.frames, expected: e.expected || s.job.expected } }
              : s,
          );
        },
      )
      .then((d) => finish({ phase: "done", ...d }))
      .catch((err) =>
        finish(
          isIpcError(err) && err.code === "CANCELLED"
            ? { phase: "cancelled" }
            : { phase: "failed", message: errorMessage(err) },
        ),
      );
  },
  cancel: () => {
    const job = get().job;
    // 같은 잡 레지스트리라 내보내기 취소 커맨드가 그대로 먹는다(모르는 id는 no-op).
    if (job)
      void ipc
        .videoExportCancel(job.jobId)
        .catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
  },
}));
