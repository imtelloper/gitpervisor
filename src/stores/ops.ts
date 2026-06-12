import { create } from "zustand";

export type SyncOp = "push" | "pull" | "fetch";

interface OpsState {
  /** 프로젝트별 진행 중인 네트워크 작업 + 마지막 진행 라인 */
  running: Record<string, { op: SyncOp; lastLine: string | null }>;
  start: (projectId: string, op: SyncOp) => void;
  progress: (projectId: string, line: string) => void;
  finish: (projectId: string) => void;
}

export const useOps = create<OpsState>((set) => ({
  running: {},
  start: (projectId, op) =>
    set((s) => ({
      running: { ...s.running, [projectId]: { op, lastLine: null } },
    })),
  progress: (projectId, line) =>
    set((s) =>
      s.running[projectId]
        ? {
            running: {
              ...s.running,
              [projectId]: { ...s.running[projectId], lastLine: line },
            },
          }
        : s,
    ),
  finish: (projectId) =>
    set((s) => {
      const { [projectId]: _removed, ...rest } = s.running;
      return { running: rest };
    }),
}));
