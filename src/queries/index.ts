import type { QueryClient } from "@tanstack/react-query";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type {
  DiffTarget,
  NotesMap,
  Project,
  ProjectSize,
  RepoStatus,
  TargetSize,
} from "../lib/ipc";
import { formatBytes } from "../lib/format";
import { errorMessage, ipc, isIpcError } from "../lib/ipc";
import { useDb } from "../stores/db";
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
  targetSizes: (projectIds: string[]) => ["target-sizes", projectIds] as const,
  projectSizes: (projectIds: string[]) =>
    ["project-sizes", projectIds] as const,
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
export function useTableMeta(
  connId: string,
  database: string,
  table: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["db-table-meta", connId, database, table],
    queryFn: () => ipc.dbTableMeta(connId, database, table),
    enabled,
    staleTime: 60_000,
  });
}
export function useDbProcedures(
  connId: string,
  database: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["db-procedures", connId, database],
    queryFn: () => ipc.dbProcedures(connId, database),
    enabled,
    staleTime: 30_000,
  });
}
export function useSaveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { connection: import("../lib/ipc").DbConnection; password: string | null }) =>
      ipc.dbSaveConnection(v.connection, v.password),
    onSuccess: (_data, v) => {
      void qc.invalidateQueries({ queryKey: ["db-connections"] });
      // 편집 시 옛 DB/컬렉션 캐시와 연결 상태를 비워 다음 확장에서 새 설정으로 재연결되게 한다
      const id = v.connection.id;
      void qc.invalidateQueries({ queryKey: ["db-databases", id] });
      void qc.invalidateQueries({ queryKey: ["db-tables", id] });
      useDb.getState().onConnectionRemoved(id);
    },
    onError: (e) =>
      useUi.getState().pushToast("error", `연결 저장 실패: ${errorMessage(e)}`),
  });
}
export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.dbDeleteConnection(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["db-connections"] }),
    onError: (e) =>
      useUi.getState().pushToast("error", `연결 삭제 실패: ${errorMessage(e)}`),
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
    // 창이 백그라운드(비포커스/최소화)면 폴링 중단 — 보이지 않는 동안 CPU·IPC를 절약한다.
    // 포커스 복귀 시 refetchOnWindowFocus(staleTime:0)로 즉시 최신화된다.
    refetchIntervalInBackground: false,
    staleTime: 0,
    gcTime: 4000,
    placeholderData: keepPreviousData,
  });
}

// 부트스트랩 쿼리(앱 게이트) — staleTime:Infinity라 자연 복구가 없다.
// git 미설치는 found:false "데이터"로 즉시 표면화되지만, 콜드 로드 응답 유실은
// throw로 온다(WebView2 §). 전역 retry:false를 덮어 유실만 한정 재시도해 게이트 잠김을 막는다.
export function useGitCheck() {
  return useQuery({
    queryKey: keys.git,
    queryFn: ipc.checkGit,
    staleTime: Infinity,
    retry: 3,
    retryDelay: 600,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: ipc.listProjects,
    staleTime: Infinity,
    retry: 3,
    retryDelay: 600,
  });
}

/**
 * status가 일시적으로 타임아웃하면 직전 정상 상태를 유지한다 — 거대/바쁜 레포에서
 * status가 가끔 느려도 "시간 초과" 오류가 깜빡이지 않게 한다. 타임아웃이 아닌 실제
 * 오류(NOT_A_REPO 등)는 그대로 표면화한다.
 */
function keepLastGoodStatuses(
  prev: RepoStatus[] | undefined,
  next: RepoStatus[],
): RepoStatus[] {
  if (!prev) return next;
  const prevById = new Map(prev.map((s) => [s.projectId, s]));
  return next.map((s) => {
    const old = prevById.get(s.projectId);
    if (s.error?.includes("시간 초과") && old && !old.error) return old;
    return s;
  });
}

/** 전 프로젝트 상태 단일 배치 쿼리 — 요청 1개로 모든 사이드바 뱃지를 채운다 */
export function useStatuses() {
  const { data: projects } = useProjects();
  const ids = (projects ?? []).map((p) => p.id);
  // 키는 정렬본 — 프로젝트 표시 순서가 바뀌어도 동일 쿼리 1개로 유지(중복 fetch 방지).
  const key = [...ids].sort();
  return useQuery({
    queryKey: keys.statuses(key),
    queryFn: () => ipc.getStatuses(ids),
    enabled: ids.length > 0,
    // 프로젝트 추가/제거로 키(전체 id 목록)가 바뀌어도 직전 상태를 유지한다 —
    // 그렇지 않으면 기존 프로젝트까지 전부 "불러오는 중"으로 떨어진다. 기존은 그대로
    // 보이고, 새로 추가된 프로젝트만 (직전 데이터에 없으니) 로딩으로 표시된다.
    placeholderData: keepPreviousData,
    structuralSharing: (prev, next) =>
      keepLastGoodStatuses(
        prev as RepoStatus[] | undefined,
        next as RepoStatus[],
      ) as unknown as typeof next,
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

// ---- Rust target 용량 관리 (commands/disk.rs) ----

/**
 * 전 프로젝트의 target 용량 단일 배치 쿼리. 폴링하지 않는다(staleTime: Infinity) —
 * 디스크 용량은 자주 안 변하고 거대 디렉토리 열거가 비싸다. 청소 후엔 무효화로 갱신.
 */
export function useTargetSizes() {
  const { data: projects } = useProjects();
  const ids = (projects ?? []).map((p) => p.id);
  const key = [...ids].sort();
  return useQuery({
    queryKey: keys.targetSizes(key),
    queryFn: () => ipc.getTargetSizes(ids),
    enabled: ids.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/** 배치 결과에서 한 프로젝트의 target 용량을 선택한다. */
export function useTargetSize(projectId: string): TargetSize | undefined {
  const { data } = useTargetSizes();
  return data?.find((t) => t.projectId === projectId);
}

/**
 * 전 프로젝트의 폴더 전체 용량 단일 배치 쿼리. 폴링하지 않는다(staleTime: Infinity) —
 * 거대 트리(node_modules/.git/target) 워크가 비싸다. 컨텍스트 메뉴 "용량 새로고침"이 무효화한다.
 */
export function useProjectSizes() {
  const { data: projects } = useProjects();
  const ids = (projects ?? []).map((p) => p.id);
  const key = [...ids].sort();
  return useQuery({
    queryKey: keys.projectSizes(key),
    queryFn: () => ipc.getProjectSizes(ids),
    enabled: ids.length > 0,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

/** 배치 결과에서 한 프로젝트의 폴더 용량을 선택한다. */
export function useProjectSize(projectId: string): ProjectSize | undefined {
  const { data } = useProjectSizes();
  return data?.find((s) => s.projectId === projectId);
}

/** 폴더 용량 수동 새로고침 — 배치 쿼리를 무효화해 다시 계산하게 한다. */
export function useRefreshProjectSizes() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["project-sizes"] });
}

/** target 청소(= cargo clean). 성공 시 용량 배치를 무효화하고 회수량을 토스트로 알린다. */
export function useCleanTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => ipc.cleanTarget(projectId),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["target-sizes"] });
      useUi
        .getState()
        .pushToast("success", `target 청소 완료 — ${formatBytes(res.freedBytes)} 회수`);
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/**
 * macOS 격리 도구(brew cask로 깐 CLI에 박힌 com.apple.quarantine) 스캔.
 * 비-macOS에선 백엔드가 빈 배열을 반환. staleTime을 길게 잡아 자주 재실행하지 않는다.
 */
export function useQuarantinedTools() {
  return useQuery({
    queryKey: ["quarantined-tools"],
    queryFn: () => ipc.scanQuarantinedTools(),
    staleTime: 5 * 60_000, // 5분
    refetchOnWindowFocus: false,
  });
}

/** 격리 해제 mutation — 성공 시 스캔 캐시 무효화 + 토스트. */
export function useClearQuarantine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paths: string[]) => ipc.clearQuarantine(paths),
    onSuccess: (_, paths) => {
      void qc.invalidateQueries({ queryKey: ["quarantined-tools"] });
      useUi
        .getState()
        .pushToast("success", `격리 해제 완료 (${paths.length}개)`);
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
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

/** 이미지 파일 미리보기 — 워크트리 파일 바이트(base64). 내용은 watcher invalidate에 맡긴다. */
export function useFileImage(projectId: string | null, path: string | null) {
  return useQuery({
    queryKey: ["file-image", projectId ?? "none", path ?? "none"],
    queryFn: () => ipc.readFileBase64(projectId!, path!),
    enabled: !!projectId && !!path,
    staleTime: Infinity,
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

/**
 * 전 프로젝트 루트를 한 invoke로 **병렬** 읽어 dir 캐시에 시드한다 (§12).
 * 프로젝트 전환 시 트리가 즉시 뜨고, WebView2 동시 invoke 응답 유실에도 강하다.
 */
export function useProjectRootsPrefetch() {
  const { data: projects } = useProjects();
  const qc = useQueryClient();
  const ids = (projects ?? []).map((p) => p.id).sort();
  return useQuery({
    queryKey: ["project-roots", ids],
    queryFn: async () => {
      const roots = await ipc.listProjectRoots(ids);
      for (const r of roots) {
        if (!r.error) qc.setQueryData(keys.dir(r.projectId, ""), r.entries);
      }
      return roots;
    },
    enabled: ids.length > 0,
    staleTime: Infinity,
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

// (구 useAutoFetch 제거 — 자동 fetch는 Rust 스케줄러(fetch_scheduler.rs)가 담당한다.
//  프로젝트별 개별 invoke 남발이 배치 커맨드 패턴과 충돌하던 구현, 태스크 04 §3.1)

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

/** 사이드바 드래그 정렬 — 낙관적으로 캐시 order를 갱신하고 백엔드에 영속화한다. */
export function useReorderProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: string[]) => ipc.reorderProjects(orderedIds),
    onMutate: (orderedIds) => {
      qc.setQueryData<Project[]>(keys.projects, (old) => {
        if (!old) return old;
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        return [...old]
          .map((p) => ({ ...p, order: rank.get(p.id) ?? p.order }))
          .sort((a, b) => a.order - b.order);
      });
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: keys.projects });
      useUi.getState().pushToast("error", errorMessage(e));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.projects }),
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

/** Viewer 편집 저장 — 파일을 디스크에 쓰고 status/diff만 갱신(히스토리·브랜치는 불변). */
export function useWriteFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { path: string; content: string }) =>
      ipc.writeFile(projectId, v.path, v.content),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
    },
  });
}

/** 새 폴더 생성 — 성공 시 트리(dir)·상태 무효화 + 토스트. */
export function useCreateDir(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (relPath: string) => ipc.createDir(projectId, relPath),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      useUi.getState().pushToast("success", "폴더를 만들었습니다");
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/**
 * 새 파일 생성 — 성공 시 트리(dir)·상태 무효화 + 토스트. 성공 콜백(onCreated)으로
 * 호출 측이 방금 만든 파일을 뷰어로 열 수 있다.
 */
export function useCreateFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (relPath: string) => ipc.createFile(projectId, relPath),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      useUi.getState().pushToast("success", "파일을 만들었습니다");
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/** 파일/폴더 삭제(파괴적) — 성공 시 트리·상태·diff 무효화 + 토스트. */
export function useDeletePath(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (relPath: string) => ipc.deletePath(projectId, relPath),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
      useUi.getState().pushToast("success", "삭제했습니다");
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/**
 * 이미지 변환·편집 저장 — base64 바이트를 디스크에 쓰고 트리·상태·diff·이미지 캐시 무효화.
 * 오류 토스트는 호출 측(에디터/변환)에서 처리한다 — 인코딩 단계 오류와 합쳐 한 번만 띄우기 위함.
 */
export function useSaveImage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { relPath: string; base64: string; overwrite: boolean }) =>
      ipc.writeFileBytes(projectId, v.relPath, v.base64, v.overwrite),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
      void qc.invalidateQueries({ queryKey: ["file-image"] });
    },
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
