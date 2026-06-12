import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage, ipc } from "../lib/ipc";
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
