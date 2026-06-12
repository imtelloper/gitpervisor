import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage, ipc } from "../lib/ipc";
import type { SyncOp } from "../stores/ops";
import { useOps } from "../stores/ops";
import { useUi } from "../stores/ui";

export const keys = {
  git: ["git-check"] as const,
  projects: ["projects"] as const,
  statuses: (projectIds: string[]) => ["statuses", projectIds] as const,
  diff: (projectId: string, path: string) => ["diff", projectId, path] as const,
};

export function useGitCheck() {
  return useQuery({
    queryKey: keys.git,
    queryFn: ipc.checkGit,
    staleTime: Infinity,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: ipc.listProjects,
    staleTime: Infinity,
  });
}

/** 전 프로젝트 상태 단일 배치 쿼리 — 요청 1개로 모든 사이드바 뱃지를 채운다 */
export function useStatuses() {
  const { data: projects } = useProjects();
  const ids = (projects ?? []).map((p) => p.id);
  return useQuery({
    queryKey: keys.statuses(ids),
    queryFn: () => ipc.getStatuses(ids),
    enabled: ids.length > 0,
  });
}

/** 배치 결과에서 한 프로젝트의 상태를 선택한다 (쿼리 메타는 배치 것을 공유) */
export function useStatus(projectId: string | null) {
  const batch = useStatuses();
  return {
    ...batch,
    data: projectId
      ? batch.data?.find((s) => s.projectId === projectId)
      : undefined,
  };
}

export function useDiff(projectId: string | null, path: string | null) {
  return useQuery({
    queryKey: keys.diff(projectId ?? "none", path ?? "none"),
    queryFn: () => ipc.getWorktreeDiff(projectId!, path!),
    enabled: !!projectId && !!path,
  });
}

export function useAddProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ipc.addProject,
    onSuccess: async (project) => {
      await qc.invalidateQueries({ queryKey: keys.projects });
      useUi.getState().selectProject(project.id);
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ipc.removeProject,
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects }),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/** 수동 새로고침: 모든 프로젝트 상태 + 열린 diff 재조회 */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["statuses"] });
    void qc.invalidateQueries({ queryKey: ["diff"] });
  };
}

function invalidateRepoData(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["statuses"] });
  void qc.invalidateQueries({ queryKey: ["diff"] });
}

// ---- M2 변경 작업 뮤테이션 ----

export function useStageFiles(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => ipc.stageFiles(projectId, paths),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
    onSettled: () => invalidateRepoData(qc),
  });
}

export function useUnstageFiles(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => ipc.unstageFiles(projectId, paths),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
    onSettled: () => invalidateRepoData(qc),
  });
}

export function useDiscardFiles(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { tracked: string[]; untracked: string[] }) =>
      ipc.discardFiles(projectId, v.tracked, v.untracked),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
    onSettled: () => invalidateRepoData(qc),
  });
}

export function useCommit(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { message: string; amend: boolean }) =>
      ipc.commit(projectId, v.message, v.amend),
    onSuccess: () => useUi.getState().pushToast("success", "커밋 완료"),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
    onSettled: () => invalidateRepoData(qc),
  });
}

/** push/pull/fetch 공통 — 진행 상태는 ops 스토어, 완료 토스트는 이벤트와 중복되지 않게 처리 */
export function useSyncOp(projectId: string, op: SyncOp) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (setUpstream?: boolean) =>
      op === "push"
        ? ipc.push(projectId, !!setUpstream)
        : op === "pull"
          ? ipc.pull(projectId)
          : ipc.fetch(projectId),
    onMutate: () => useOps.getState().start(projectId, op),
    onSuccess: () => {
      const ops = useOps.getState();
      if (ops.running[projectId]) {
        ops.finish(projectId);
        useUi.getState().pushToast("success", `${op} 완료`);
      }
    },
    onError: (e) => {
      const ops = useOps.getState();
      if (ops.running[projectId]) {
        ops.finish(projectId);
        useUi.getState().pushToast("error", errorMessage(e));
      }
    },
    onSettled: () => invalidateRepoData(qc),
  });
}

/** Push 진입점: detached 차단, 업스트림 없으면 -u 확인 다이얼로그 (설계 §10) */
export function usePushFlow(projectId: string) {
  const { data: status } = useStatus(projectId);
  const push = useSyncOp(projectId, "push");

  return () => {
    if (!status) return;
    if (!status.branch) {
      useUi.getState().pushToast("error", "detached HEAD 상태에서는 푸시할 수 없습니다");
      return;
    }
    if (!status.upstream) {
      useUi.getState().askConfirm({
        title: "업스트림 설정",
        message: `'${status.branch}' 브랜치에 업스트림이 없습니다. origin에 브랜치를 만들고 푸시할까요?`,
        confirmLabel: "푸시",
        onConfirm: () => push.mutate(true),
      });
      return;
    }
    push.mutate(false);
  };
}
