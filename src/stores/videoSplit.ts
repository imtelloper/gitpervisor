// 동영상 타임틱 분할 배치 (DOCS/task/22-video-timetick-split.md §3.2) —
// 틱 N개로 잘린 세그먼트 N+1개를 기존 `video_export`로 **순차** 실행한다.
//
// - 배치 상태가 여기 있는 이유: ExportPanel은 편집 패널 토글·파일 전환(key={path})에 언마운트된다.
//   패널 로컬 state면 루프는 계속 도는데 진행률·취소 버튼만 사라진다.
// - 종결 판정은 `videoExport` 프라미스와 `video://export-finished` 이벤트의 **경주** — 먼저 온
//   쪽이 이긴다(Windows invoke 응답 유실 대비, ipc.ts:1098 계약). AlreadyExists만은 이벤트가
//   없고 프라미스 거부로만 온다(video.rs:655 계약). 배치 정리 뒤 늦게 오는 이벤트는
//   `recentlyOwned`(아래)가 계속 우리 것으로 인정해 중복 토스트를 막는다.
// - 동시 ffmpeg는 띄우지 않는다(프로세스 위생 — DOCS/process-leak-postmortem.md).
import type { QueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import type {
  VideoExportFinished,
  VideoExportProgress,
  VideoExportSpec,
} from "../lib/ipc";
import { errorMessage, ipc, isIpcError } from "../lib/ipc";
import { useUi } from "./ui";

export interface SplitSegment {
  startMs: number;
  endMs: number;
}

/** 세그먼트 경계 계산 — 정렬 → (0, dur) 밖 제거 → 이웃과 minGapMs 미만이면 병합 → 인접 쌍.
 *  순수 함수라 e2e(`__gpv.planSegments`)가 직접 단언한다. */
export function planSegments(
  ticksSec: number[],
  durationSec: number,
  minGapMs = 100,
): SplitSegment[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const minGap = minGapMs / 1000;
  const bounds = [0];
  for (const t of [...ticksSec].sort((a, b) => a - b)) {
    if (!Number.isFinite(t) || t <= 0 || t >= durationSec) continue;
    if (t - bounds[bounds.length - 1] >= minGap) bounds.push(t);
  }
  // 마지막 틱이 영상 끝에 붙어 있으면 길이 0에 가까운 꼬리 세그먼트가 생긴다 — 버린다.
  while (bounds.length > 1 && durationSec - bounds[bounds.length - 1] < minGap) bounds.pop();
  bounds.push(durationSec);
  return bounds.slice(0, -1).map((s, i) => ({
    startMs: Math.round(s * 1000),
    endMs: Math.round(bounds[i + 1] * 1000),
  }));
}

/** 0패딩 폭 = max(2, 총 개수 자릿수). 확장자는 두 모드 모두 mp4(§3.4). */
export function partName(stem: string, index1: number, total: number): string {
  return `${stem}.part-${String(index1).padStart(Math.max(2, String(total).length), "0")}.mp4`;
}

export interface SplitBatch {
  projectId: string;
  srcRel: string;
  /** dir + folder (레포 상대) */
  folderRel: string;
  total: number;
  /** 완성된 세그먼트 수 */
  done: number;
  /** 1-based, 표시용 */
  currentIndex: number;
  currentJobId: string | null;
  /** 현재 잡 0-100 */
  currentPct: number;
  /** owns()용 — 이 배치가 발급한 jobId 전부 */
  jobIds: Set<string>;
  cancelled: boolean;
  error: string | null;
}

export interface SplitOptions {
  /** 폴더명(검증 완료된 값) */
  folder: string;
  mode: "copy" | "encode";
  stem: string;
  /** probe 값 그대로 — 백엔드 expected_out_us가 range가 있으면 range 길이를 분모로 쓴다
   *  (video.rs:601) → 세그먼트마다 %가 100까지 간다. 별도 보정 없음. */
  durationMs: number;
  hasAudio: boolean;
}

/** 세그먼트 하나의 결말 — 프라미스와 종결 이벤트 중 먼저 온 쪽이 만든다. */
type Outcome =
  | { kind: "ok" }
  | { kind: "cancelled" }
  | { kind: "exists" }
  | { kind: "error"; error: string };

/** 진행 중인 세그먼트의 대기자 — events.ts가 advance()로 깨운다. */
const waiters = new Map<string, (o: Outcome) => void>();

// 배치가 끝난 뒤에도 잠시 기억하는 jobId. 마지막 세그먼트에서 프라미스가 이벤트를 이기면
// 루프가 batch를 비운 뒤 이벤트가 도착해 owns()가 false → events.ts 일반 경로가 요약 토스트와
// 별개로 "내보내기 완료" 토스트를 하나 더 띄운다. 이벤트는 응답 직후에 오므로 초 단위 기억이면
// 충분하고(10초), 영구 보존은 그냥 누수다.
const recentlyOwned = new Set<string>();
const RECENT_MS = 10_000;

// 배치 종료 시 산출물 반영에 쓰는 QueryClient. 스토어는 React 밖이라 훅을 못 쓴다 —
// attachRepoEvents(main.tsx 부트)가 자기 qc를 한 번 넘겨준다.
let queryClient: QueryClient | null = null;
export function setSplitQueryClient(qc: QueryClient) {
  queryClient = qc;
}

/** 덮어쓰기 확인 1회 — 전역 다이얼로그를 프라미스로 감싼다. */
function confirmOverwrite(folder: string): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.getState().askConfirm({
      title: "덮어쓰기",
      message: `${folder} 폴더에 같은 이름의 분할 파일이 있습니다. 기존 분할 결과를 덮어쓸까요?`,
      confirmLabel: "덮어쓰기",
      danger: true,
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/** 세그먼트 1개 실행 — 프라미스/이벤트 경주(§3.3). 어느 쪽이 와도 정확히 한 번 settle. */
function runOne(projectId: string, jobId: string, spec: VideoExportSpec): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let settled = false;
    const done = (o: Outcome) => {
      if (settled) return;
      settled = true;
      waiters.delete(jobId);
      resolve(o);
    };
    waiters.set(jobId, done);
    void ipc.videoExport(projectId, jobId, spec).then(
      () => done({ kind: "ok" }),
      (e) => {
        if (isIpcError(e) && e.code === "ALREADY_EXISTS") done({ kind: "exists" });
        else if (isIpcError(e) && e.code === "CANCELLED") done({ kind: "cancelled" });
        else done({ kind: "error", error: errorMessage(e) });
      },
    );
  });
}

/** 요약 토스트 1개 — 세그먼트마다 뜨는 개별 토스트는 events.ts가 owns()로 눌렀다. */
function summarize(b: SplitBatch) {
  const ui = useUi.getState();
  const folder = b.folderRel.split("/").pop() ?? b.folderRel;
  const at = String(b.currentIndex).padStart(Math.max(2, String(b.total).length), "0");
  if (b.error) ui.pushToast("error", `part-${at}에서 실패: ${b.error} · ${b.done}개 저장됨`);
  else if (b.cancelled) ui.pushToast("info", `${b.done}/${b.total}개 저장 후 중단`);
  else ui.pushToast("success", `${b.done}개로 분할 저장 — ${folder}/`);
}

interface VideoSplitState {
  batch: SplitBatch | null;
  /** 배치 시작. 이미 진행 중이면 no-op. 완료/중단 시 batch=null + 요약 토스트 + 쿼리 무효화. */
  start(
    projectId: string,
    srcRel: string,
    dir: string,
    segments: SplitSegment[],
    opts: SplitOptions,
  ): Promise<void>;
  cancel(): void;
  owns(jobId: string): boolean;
  /** events.ts 전용 — 종결 이벤트를 현재 세그먼트 결과로 반영(대기 중인 start 루프를 깨운다). */
  advance(ev: VideoExportFinished): void;
  /** 스토어가 배치 중에만 구독하는 진행 이벤트 처리. */
  progress(ev: VideoExportProgress): void;
}

export const useVideoSplit = create<VideoSplitState>((set, get) => ({
  batch: null,

  start: async (projectId, srcRel, dir, segments, opts) => {
    if (get().batch || segments.length === 0) return;
    const folderRel = dir + opts.folder;
    set({
      batch: {
        projectId,
        srcRel,
        folderRel,
        total: segments.length,
        done: 0,
        currentIndex: 0,
        currentJobId: null,
        currentPct: 0,
        jobIds: new Set(),
        cancelled: false,
        error: null,
      },
    });

    // resolve_in_repo(tree.rs:1677)는 부모 폴더가 있어야 통과한다 — 폴더를 먼저 만든다.
    // 이미 있으면 재사용(재분할·덮어쓰기 경로).
    try {
      await ipc.createDir(projectId, folderRel);
    } catch (e) {
      if (!(isIpcError(e) && e.code === "ALREADY_EXISTS")) {
        set({ batch: null });
        useUi.getState().pushToast("error", `분할 폴더를 만들지 못했습니다 — ${errorMessage(e)}`);
        return;
      }
    }

    const unProg = await listen<VideoExportProgress>("video://export-progress", (e) =>
      get().progress(e.payload),
    );
    /** 현재 배치에만 부분 갱신 — 취소/정리로 batch가 사라진 뒤의 늦은 set을 무시한다. */
    const patch = (f: (b: SplitBatch) => SplitBatch) =>
      set((s) => (s.batch ? { batch: f(s.batch) } : s));

    let overwrite = false;
    try {
      for (let i = 0; i < segments.length; i++) {
        if (get().batch?.cancelled) break;
        const jobId = crypto.randomUUID();
        patch((b) => ({
          ...b,
          currentIndex: i + 1,
          currentJobId: jobId,
          currentPct: 0,
          jobIds: new Set(b.jobIds).add(jobId),
        }));
        const spec: VideoExportSpec = {
          srcRel,
          outRel: `${folderRel}/${partName(opts.stem, i + 1, segments.length)}`,
          overwrite,
          range: segments[i],
          mode: opts.mode,
          speed: null,
          crop: null,
          // 분할은 편집 설정을 쓰지 않는다(패널이 그렇게 고지한다) — 모자이크도 마찬가지.
          masks: null,
          maskKind: "mosaic",
          crf: opts.mode === "encode" ? 23 : null,
          maxHeight: null,
          removeAudio: false,
          durationMs: opts.durationMs,
          hasAudio: opts.hasAudio,
        };
        const outcome = await runOne(projectId, jobId, spec);
        if (outcome.kind === "exists") {
          // overwrite=true인데도 또 충돌 = 우리가 모르는 이유(권한·잠금) — 무한 재시도 금지.
          if (overwrite) {
            patch((b) => ({ ...b, error: "기존 파일을 덮어쓰지 못했습니다" }));
            break;
          }
          if (!(await confirmOverwrite(opts.folder))) {
            patch((b) => ({ ...b, cancelled: true }));
            break;
          }
          overwrite = true;
          i--; // 같은 세그먼트를 overwrite로 다시
          continue;
        }
        if (outcome.kind === "cancelled") {
          patch((b) => ({ ...b, cancelled: true }));
          break;
        }
        if (outcome.kind === "error") {
          patch((b) => ({ ...b, error: outcome.error }));
          break;
        }
        patch((b) => ({ ...b, done: b.done + 1, currentPct: 100 }));
      }
    } finally {
      unProg();
      const b = get().batch;
      if (b) summarize(b);
      // 산출물이 워크트리에 생겼다 — 배치 끝에 1회만(세그먼트마다 하면 N번 폭풍).
      void queryClient?.invalidateQueries({ queryKey: ["dir"] });
      void queryClient?.invalidateQueries({ queryKey: ["statuses"] });
      void queryClient?.invalidateQueries({ queryKey: ["video-probe"] });
      if (b) {
        const ids = [...b.jobIds];
        ids.forEach((id) => recentlyOwned.add(id));
        setTimeout(() => ids.forEach((id) => recentlyOwned.delete(id)), RECENT_MS);
      }
      set({ batch: null });
    }
  },

  cancel: () => {
    const b = get().batch;
    if (!b || b.cancelled) return;
    set({ batch: { ...b, cancelled: true } });
    // 현재 잡의 종결(cancelled)을 루프가 기다렸다가 빠져나간다 — 완료분은 남는다.
    if (b.currentJobId)
      void ipc
        .videoExportCancel(b.currentJobId)
        .catch((e) => useUi.getState().pushToast("error", errorMessage(e)));
  },

  owns: (jobId) => (get().batch?.jobIds.has(jobId) ?? false) || recentlyOwned.has(jobId),

  advance: (ev) => {
    // 대기자가 없으면 프라미스가 먼저 종결시킨 경우다(경주 특성상 정상) — 무시.
    waiters.get(ev.jobId)?.(
      ev.cancelled
        ? { kind: "cancelled" }
        : ev.ok
          ? { kind: "ok" }
          : { kind: "error", error: ev.error ?? "분할 실패" },
    );
  },

  progress: (ev) => {
    const b = get().batch;
    if (b && ev.jobId === b.currentJobId) set({ batch: { ...b, currentPct: ev.percent } });
  },
}));
