import type { QueryClient } from "@tanstack/react-query";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type { DiffTarget, NotesMap, Project } from "../lib/ipc";
import { errorMessage, ipc, isIpcError } from "../lib/ipc";
import type { SyncOp } from "../stores/ops";
import { useOps } from "../stores/ops";
import { useUi } from "../stores/ui";

const LOG_PAGE_SIZE = 200;

/** DiffTarget을 안정적인 쿼리 키 문자열로 직렬화 (mode별로 구분). */
function diffTargetKey(t: DiffTarget): string {
  switch (t.mode) {
    case "worktree":
      return `w:${t.path}`;
    case "index":
      return `i:${t.path}`;
    case "commit":
      return `c:${t.sha}:${t.path}`;
    case "file":
      return `f:${t.path}`;
  }
}

export const keys = {
  git: ["git-check"] as const,
  projects: ["projects"] as const,
  statuses: (projectIds: string[]) => ["statuses", projectIds] as const,
  diff: (projectId: string, target: DiffTarget) =>
    ["diff", projectId, diffTargetKey(target)] as const,
  log: (projectId: string) => ["log", projectId] as const,
  branches: (projectId: string) => ["branches", projectId] as const,
  commitDetail: (projectId: string, sha: string) =>
    ["commit-detail", projectId, sha] as const,
  settings: ["settings"] as const,
  dir: (projectId: string, relPath: string) =>
    ["dir", projectId, relPath] as const,
  sysMetrics: ["sys-metrics"] as const,
  notes: ["notes"] as const,
};

// ---- DB 탐색기 (M6 §17) ----
export function useDbConnections() {
  return useQuery({
    queryKey: ["db-connections"],
    queryFn: ipc.dbListConnections,
    staleTime: Infinity,
  });
}
export function useDbDatabases(connId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["db-databases", connId],
    queryFn: () => ipc.dbDatabases(connId),
    enabled,
    staleTime: 30_000,
  });
}
export function useDbTables(connId: string, database: string, enabled: boolean) {
  return useQuery({
    queryKey: ["db-tables", connId, database],
    queryFn: () => ipc.dbTables(connId, database),
    enabled,
    staleTime: 30_000,
  });
}
export function useSaveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { connection: import("../lib/ipc").DbConnection; password: string | null }) =>
      ipc.dbSaveConnection(v.connection, v.password),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["db-connections"] }),
  });
}
export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.dbDeleteConnection(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["db-connections"] }),
  });
}

/** 전체 프로젝트 메모 (캐시). */
export function useNotes() {
  return useQuery({
    queryKey: keys.notes,
    queryFn: ipc.getNotes,
    staleTime: Infinity,
  });
}

function patchNotes(
  qc: ReturnType<typeof useQueryClient>,
  fn: (old: NotesMap) => NotesMap,
) {
  qc.setQueryData<NotesMap>(keys.notes, (old) => fn(old ?? {}));
}

/** 새 메모 추가 — 낙관적(프론트 생성 memoId). */
export function useAddMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, memoId }: { projectId: string; memoId: string }) =>
      ipc.addMemo(projectId, memoId),
    onMutate: ({ projectId, memoId }) => {
      const now = new Date().toISOString();
      patchNotes(qc, (old) => ({
        ...old,
        [projectId]: [
          ...(old[projectId] ?? []),
          { id: memoId, text: "", createdAt: now, updatedAt: now },
        ],
      }));
    },
  });
}

/** 메모 본문 수정 — 낙관적. */
export function useUpdateMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      memoId,
      text,
    }: {
      projectId: string;
      memoId: string;
      text: string;
    }) => ipc.updateMemo(projectId, memoId, text),
    onMutate: ({ projectId, memoId, text }) => {
      const now = new Date().toISOString();
      patchNotes(qc, (old) => ({
        ...old,
        [projectId]: (old[projectId] ?? []).map((m) =>
          m.id === memoId ? { ...m, text, updatedAt: now } : m,
        ),
      }));
    },
  });
}

/** 메모 삭제 — 낙관적(목록 비면 키 제거). */
export function useDeleteMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, memoId }: { projectId: string; memoId: string }) =>
      ipc.deleteMemo(projectId, memoId),
    onMutate: ({ projectId, memoId }) => {
      patchNotes(qc, (old) => {
        const next = { ...old };
        const list = (next[projectId] ?? []).filter((m) => m.id !== memoId);
        if (list.length) next[projectId] = list;
        else delete next[projectId];
        return next;
      });
    },
  });
}

/** 타이틀바 시스템 모니터 — 2초 간격 폴링. */
export function useSysMetrics() {
  return useQuery({
    queryKey: keys.sysMetrics,
    queryFn: ipc.sysMetrics,
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 4000,
    placeholderData: keepPreviousData,
  });
}

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

export function useDiff(projectId: string | null, target: DiffTarget | null) {
  return useQuery({
    queryKey: target ? keys.diff(projectId ?? "none", target) : ["diff", "none"],
    queryFn: () => ipc.getDiff(projectId!, target!),
    enabled: !!projectId && !!target,
    // 신선도는 watcher·변경 액션의 invalidate가 책임진다 — 캐시 히트 시 재스폰 없음
    staleTime: Infinity,
    // 파일 전환 시 이전 diff를 유지해 "불러오는 중" 깜빡임을 없앤다
    placeholderData: keepPreviousData,
  });
}

/**
 * diff 프리페치: 상태가 갱신될 때 변경 파일들의 diff를 배치로 미리 캐시에 적재한다.
 * 클릭 시점에는 캐시 히트로 즉시 표시 — "클릭 후 git spawn 대기" 구조를 제거 (§12).
 */
export function usePrefetchDiffs(projectId: string) {
  const qc = useQueryClient();
  const { data: status } = useStatus(projectId);

  useEffect(() => {
    if (!status || status.error) return;
    // worktree 모드로 보는 파일만 프리페치한다 — staged 파일은 클릭 시 index 모드로
    // 조회하고(HEAD↔인덱스), 순수 staged 파일의 worktree diff는 비어 있어 무의미하다.
    const paths = [
      ...status.conflicted,
      ...status.unstaged,
      ...status.untracked,
    ].map((c) => c.path);

    // 한 번도 읽지 않은 파일만 적재한다 — 캐시에 있는 파일은 무효화돼도
    // 클릭 시 기존 내용이 즉시 표시되고 백그라운드로 갱신되므로 프리페치가 불필요.
    const neverLoaded = (p: string) =>
      qc.getQueryState(keys.diff(projectId, { mode: "worktree", path: p }))
        ?.data === undefined;

    // 첫 진입(미적재 파일 존재)은 즉시, 이후 상태 갱신 폭풍 중엔 잠깐 미룬다
    const delay = paths.some(neverLoaded) ? 0 : 600;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // 작은 청크를 순차 실행 — IPC 슬롯을 최대 1개만 점유해 클릭(interactive)에 항상 양보
      const CHUNK = 8;
      void (async () => {
        const missing = paths.slice(0, 30).filter(neverLoaded);
        for (let i = 0; i < missing.length; i += CHUNK) {
          if (cancelled) return;
          try {
            const diffs = await ipc.getWorktreeDiffs(
              projectId,
              missing.slice(i, i + CHUNK),
            );
            if (cancelled) return;
            for (const d of diffs) {
              qc.setQueryData(
                keys.diff(projectId, { mode: "worktree", path: d.path }),
                d,
              );
            }
          } catch {
            return; // 프리페치 실패는 무시 — 클릭 시 단건 조회가 오류를 표면화한다
          }
        }
      })();
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, projectId, qc]);
}

// ---- M3: 히스토리 ----

/** 커밋 로그 — 200개 단위 무한 스크롤 (`--skip`, 설계 §12). enabled로 패널 펼침 시에만 조회. */
export function useLog(projectId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: keys.log(projectId ?? "none"),
    queryFn: ({ pageParam }) =>
      ipc.getLog(projectId!, { limit: LOG_PAGE_SIZE, skip: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === LOG_PAGE_SIZE
        ? allPages.reduce((n, p) => n + p.length, 0)
        : undefined,
    enabled: !!projectId && enabled,
    staleTime: 30_000,
  });
}

export function useBranches(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.branches(projectId ?? "none"),
    queryFn: () => ipc.getBranches(projectId!),
    enabled: !!projectId && enabled,
    staleTime: 30_000,
  });
}

/** 단일 커밋 상세 — 커밋 내용은 불변이라 무기한 캐시. */
export function useCommitDetail(projectId: string | null, sha: string | null) {
  return useQuery({
    queryKey: keys.commitDetail(projectId ?? "none", sha ?? "none"),
    queryFn: () => ipc.getCommitDetail(projectId!, sha!),
    enabled: !!projectId && !!sha,
    staleTime: Infinity,
  });
}

/** 파일 트리: 한 디렉토리의 항목 (지연 로딩 — 폴더 펼칠 때만 마운트). */
export function useDir(projectId: string | null, relPath: string) {
  return useQuery({
    queryKey: keys.dir(projectId ?? "none", relPath),
    queryFn: () => ipc.listDir(projectId!, relPath),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

// ---- M4: 설정 ----

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: ipc.getSettings,
    staleTime: Infinity,
  });
}

export function useSetSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ipc.setSettings,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.settings });
      // git 경로가 바뀌었을 수 있으니 게이트 재확인
      void qc.invalidateQueries({ queryKey: keys.git });
      useUi.getState().pushToast("success", "설정을 저장했습니다");
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/**
 * 옵트인 자동 fetch (설계 §9 — 기본 OFF). autoFetchMinutes>0이면 전 프로젝트를
 * 주기적으로 fetch한다. op-finished 이벤트가 상태를 무효화해 ahead/behind가 갱신된다.
 */
export function useAutoFetch() {
  const { data: settings } = useSettings();
  const { data: projects } = useProjects();
  const mins = settings?.autoFetchMinutes ?? 0;

  useEffect(() => {
    if (!mins || !projects || projects.length === 0) return;
    const id = window.setInterval(
      () => {
        for (const p of projects) void ipc.fetch(p.id).catch(() => {});
      },
      mins * 60_000,
    );
    return () => window.clearInterval(id);
  }, [mins, projects]);
}

export function useAddProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ipc.addProject,
    onSuccess: (project) => {
      // 낙관적 반영 — 추가 직후 list_projects refetch 응답이 WebView2에서 유실돼도
      // 새 프로젝트가 즉시 목록에 보이게 한다(§10 invoke 응답 유실 대응).
      qc.setQueryData<Project[]>(keys.projects, (old) => {
        const rest = (old ?? []).filter((p) => p.id !== project.id);
        return [...rest, project].sort((a, b) => a.order - b.order);
      });
      void qc.invalidateQueries({ queryKey: keys.projects });
      useUi.getState().selectProject(project.id);
    },
    onError: (e) => {
      // 이미 등록됐는데 목록엔 없는(stale) 상태 — 진실을 다시 끌어와 표시한다
      if (isIpcError(e) && e.code === "DUPLICATE_PROJECT") {
        void qc.invalidateQueries({ queryKey: keys.projects });
      }
      useUi.getState().pushToast("error", errorMessage(e));
    },
  });
}

export function useRemoveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ipc.removeProject,
    onSuccess: (_void, id) => {
      // 낙관적 제거 — refetch 유실과 무관하게 즉시 목록에서 빠지게 한다.
      qc.setQueryData<Project[]>(keys.projects, (old) =>
        (old ?? []).filter((p) => p.id !== id),
      );
      void qc.invalidateQueries({ queryKey: keys.projects });
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/** 수동 새로고침: 프로젝트 목록 + 모든 상태 + 열린 diff + 로그/브랜치 재조회 */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    // 목록이 stale(추가/삭제 갱신 유실)한 경우 F5로 진실을 다시 끌어온다
    void qc.invalidateQueries({ queryKey: keys.projects });
    void qc.invalidateQueries({ queryKey: ["dir"] });
    invalidateRepoData(qc);
  };
}

function invalidateRepoData(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["statuses"] });
  void qc.invalidateQueries({ queryKey: ["diff"] });
  // 커밋/풀/페치 후 히스토리·브랜치도 갱신 (커밋 상세는 불변이라 제외)
  void qc.invalidateQueries({ queryKey: ["log"] });
  void qc.invalidateQueries({ queryKey: ["branches"] });
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
