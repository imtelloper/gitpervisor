import type { QueryClient } from "@tanstack/react-query";
import {
  keepPreviousData,
  replaceEqualDeep,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

import type {
  DiffTarget,
  NotesMap,
  ProcSortKey,
  Project,
  ProjectSize,
  ReportMap,
  ReportRecord,
  RepoStatus,
  TargetSize,
} from "../lib/ipc";
import { formatBytes } from "../lib/format";
import { errorMessage, ipc, isIpcError } from "../lib/ipc";
import { opensInOwnViewer } from "../lib/language-map";
import { useDb } from "../stores/db";
import type { SyncOp } from "../stores/ops";
import { useOps } from "../stores/ops";
import { useTerminals } from "../stores/terminals";
import { useTreeState } from "../stores/treeState";
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
  processSnapshot: (sortBy: ProcSortKey, groupByName: boolean) =>
    ["process-snapshot", sortBy, groupByName] as const,
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

/** 메모 드래그 정렬 — 낙관적으로 캐시 배열을 백엔드와 같은 규칙(rank·미포함은 꼬리)으로 재정렬. */
export function useReorderMemos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      orderedIds,
    }: {
      projectId: string;
      orderedIds: string[];
    }) => ipc.reorderMemos(projectId, orderedIds),
    onMutate: ({ projectId, orderedIds }) => {
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      const tail = orderedIds.length;
      patchNotes(qc, (old) => ({
        ...old,
        // Array#sort는 안정(ES2019+) — 미포함 메모끼리의 순서는 그대로다.
        [projectId]: [...(old[projectId] ?? [])].sort(
          (a, b) => (rank.get(a.id) ?? tail) - (rank.get(b.id) ?? tail),
        ),
      }));
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: keys.notes });
      useUi.getState().pushToast("error", errorMessage(e));
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.notes }),
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

/** 리소스 모니터 팝업의 Top-N 행 수 — 작업관리자 수준으로 넉넉히(스크롤+검색으로 소화). */
const PROC_SNAPSHOT_LIMIT = 200;

/**
 * 리소스 모니터 팝업 — 프로세스 스냅샷 2초 폴링(틱당 커맨드 1개, totals 포함 배치).
 * 모니터 창은 비포커스 상태로 곁눈질하는 게 기본 자세라 refetchIntervalInBackground:true —
 * 대신 document.visibilityState(최소화 시 hidden)로 게이트해 "보일 때만" 폴링한다 (§3.2).
 */
export function useProcessSnapshot(
  sortBy: ProcSortKey,
  groupByName: boolean,
  enabled = true,
) {
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return useQuery({
    queryKey: keys.processSnapshot(sortBy, groupByName),
    queryFn: () =>
      ipc.sysProcessSnapshot(sortBy, PROC_SNAPSHOT_LIMIT, groupByName),
    // 디스크 분석 뷰에선 프로세스 폴링 자체를 끈다(디스크 설계 §3.4).
    enabled,
    refetchInterval: visible ? 2000 : false,
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 4000,
    // 정렬/그룹 전환·첫 틱(CPU 0%)에도 직전 데이터를 유지해 깜빡임을 없앤다.
    placeholderData: keepPreviousData,
  });
}

/**
 * 디스크 분석 — 스캔 결과 폴더 1개의 자식 목록. 스캔 결과는 불변 스냅샷이라 staleTime ∞,
 * 새 스캔 완료 시 DiskUsageView가 ["disk"] 전체를 무효화한다(디스크 설계 §3.2).
 * scanRoot가 키에 들어가 다른 경로 재스캔이 자연스럽게 별도 캐시가 된다.
 */
export function useDiskChildren(scanRoot: string | null, rel: string) {
  return useQuery({
    queryKey: ["disk", scanRoot, rel],
    queryFn: () => ipc.diskChildren(rel),
    enabled: scanRoot != null,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
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
  const merged = next.map((s) => {
    const old = prevById.get(s.projectId);
    if (s.error?.includes("시간 초과") && old && !old.error) return old;
    return s;
  });
  // **구조 공유를 되살린다.** `structuralSharing` 에 함수를 주면 react-query 는 기본
  // `replaceEqualDeep` 를 건너뛴다 — 위 map 이 매번 새 배열·새 객체 참조를 내므로 변경이
  // 0건인 재조회(워처 폭풍·포커스 복귀)에도 `useStatus` 구독자 전원(사이드바 N개 + 변경 패널 +
  // 툴바 + 상태바 + 파일트리)이 리렌더되고 프리페치 effect 까지 매번 다시 돈다.
  return replaceEqualDeep(prev, merged) as RepoStatus[];
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
    // 신선도는 워처(`repo://changed`)가 책임진다 — 0이면 알트탭 한 번마다
    // (`refetchOnWindowFocus: true`) 전 레포 배치가 통째로 다시 돈다(프로젝트 21개 실측 22.5초).
    // 10초면 창을 오가는 동안은 캐시를 쓰고, 워처가 놓친 변경도 곧 따라잡는다.
    staleTime: 10_000,
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

/** Claude 사용량(rate_limits) — statusline.js가 떨군 파일을 읽어 좌측 하단 바에 표시.
 *  파일은 Claude Code가 statusline을 갱신할 때마다 바뀌므로 60초 폴링이면 충분. */
export function useClaudeUsage() {
  return useQuery({
    queryKey: ["claude-usage"],
    queryFn: ipc.claudeUsage,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
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

/**
 * 사용자가 상태바에서 **직접 고른** 인코딩(설계 B-K6) — `projectId::path` → 인코딩 이름.
 *
 * 쿼리 키가 아니라 키 밖의 맵인 이유: 워처·저장이 diff 를 무효화하면 같은 키로 **다시**
 * 조회되는데, 그때도 사용자의 선택이 살아 있어야 한다. 키에 넣으면 무효화 때마다
 * 자동 탐지로 조용히 되돌아가고(=사용자가 고친 것이 풀리고), 그 상태로 저장하면 탐지가
 * 틀린 인코딩으로 파일이 기록된다.
 */
const encodingOverrides = new Map<string, string>();
const encodingKey = (projectId: string, path: string) => `${projectId}::${path}`;

/**
 * 지금 열려 있는 파일을 다른 인코딩으로 다시 연다(`null` = 자동 탐지로 복귀).
 * 선택은 이 세션 동안 그 파일에 붙어 있고, 저장도 그 인코딩으로 나간다.
 */
export function useReopenWithEncoding() {
  const qc = useQueryClient();
  return (projectId: string, target: DiffTarget, encoding: string | null) => {
    const k = encodingKey(projectId, target.path);
    if (encoding) encodingOverrides.set(k, encoding);
    else encodingOverrides.delete(k);
    void qc.invalidateQueries({ queryKey: keys.diff(projectId, target) });
  };
}

/**
 * diff 쿼리 옵션 — **같은 diff 키를 구독하는 곳은 전부 이걸 펼쳐 써라**(뷰어·상태바 인코딩 선택기).
 *
 * TanStack v5 는 구독자가 렌더할 때마다 그 옵션을 쿼리에 덮어쓴다(query-core queryObserver setOptions).
 * 한 곳이라도 `queryFn: skipToken` 으로 같은 키를 구독하면, 그 구독자가 마지막으로 렌더한 순간의
 * 무효화(워처·저장·스테이지)가 쿼리를 skipToken 으로 다시 가져오려다 `Missing queryFn` 으로 실패해
 * 뷰어가 "파일 diff를 불러오지 못했습니다"로 깨진다 — 렌더 순서에 따라 나타났다 사라지는 결함이었다
 * (2026-09-17 샤드 e2e 25 에서 발견, 가드는 63). 캐시만 읽고 싶으면 `enabled: false` 를 덧붙인다.
 */
export function diffQueryOptions(projectId: string | null, target: DiffTarget | null) {
  // 이미지·동영상·오디오·Office·PDF는 뷰어가 diff보다 먼저 분기해 결과를 쓰지 않는다 — 부르면
  // 순수 낭비고, 동영상은 파일이 GB 단위일 수 있어 git spawn 비용이 더 크다. 아예 끈다.
  const media = !!target && opensInOwnViewer(target.path);
  return {
    queryKey: target ? keys.diff(projectId ?? "none", target) : (["diff", "none"] as const),
    queryFn: () =>
      ipc.getDiff(
        projectId!,
        target!,
        encodingOverrides.get(encodingKey(projectId!, target!.path)),
      ),
    enabled: !!projectId && !!target && !media,
    // 신선도는 watcher·변경 액션의 invalidate가 책임진다 — 캐시 히트 시 재스폰 없음
    staleTime: Infinity,
  };
}

export function useDiff(projectId: string | null, target: DiffTarget | null) {
  return useQuery({
    ...diffQueryOptions(projectId, target),
    // 파일 전환 시 이전 diff를 유지해 "불러오는 중" 깜빡임을 없앤다
    placeholderData: keepPreviousData,
  });
}

/** ffmpeg 발견 상태 — 편집 UI 게이트. 설치 직후 반영되도록 60초만 신선. */
export function useVideoToolStatus() {
  return useQuery({
    queryKey: ["video-tool"],
    queryFn: () => ipc.videoToolStatus(),
    staleTime: 60_000,
  });
}

/** ffprobe 메타데이터 — 프레임 스텝 fps·크롭 좌표계·내보내기 분모. 도구 있을 때만. */
export function useVideoProbe(projectId: string | null, path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["video-probe", projectId ?? "none", path ?? "none"],
    queryFn: () => ipc.videoProbe(projectId!, path!),
    enabled: enabled && !!projectId && !!path,
    staleTime: Infinity,
    retry: false, // 프로세스 스폰 — 실패 자동 재시도 금지
  });
}

/** 프로젝트 로고 — 프로젝트당 한 번. 로고는 거의 안 바뀌므로 워처 무효화 대상이 아니다.
 *  실패해도 조용히 없는 것으로 둔다(사이드바에 토스트를 띄울 일이 아니다). */
export function useProjectLogo(projectId: string | null) {
  return useQuery({
    queryKey: ["project-logo", projectId ?? "none"],
    queryFn: () => ipc.projectLogo(projectId!),
    enabled: !!projectId,
    staleTime: Infinity,
    retry: false,
  });
}

/** 타임라인 필름스트립 — 파일당 한 번만 뽑는다(ffmpeg 스폰이라 비싸다). */
export function useVideoFilmstrip(
  projectId: string | null,
  path: string | null,
  cols: number,
  height: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["video-filmstrip", projectId ?? "none", path ?? "none", cols, height],
    queryFn: () => ipc.videoFilmstrip(projectId!, path!, cols, height),
    enabled: enabled && !!projectId && !!path,
    staleTime: Infinity,
    retry: false,
  });
}

/** 오디오 파형 피크 — 오디오 트랙이 없으면 빈 배열이 온다(에러 아님). */
export function useVideoWaveform(
  projectId: string | null,
  path: string | null,
  buckets: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["video-waveform", projectId ?? "none", path ?? "none", buckets],
    queryFn: () => ipc.videoWaveform(projectId!, path!, buckets),
    enabled: enabled && !!projectId && !!path,
    staleTime: Infinity,
    retry: false,
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
    ]
      .map((c) => c.path)
      // 자기 뷰어로 여는 파일(PDF·이미지 등)은 diff를 쓰지 않는다 — git spawn 낭비·30개 슬롯 잠식
      .filter((p) => !opensInOwnViewer(p));

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
    // 신선도는 워처(repo://changed → ["dir", pid], events.ts)가 책임진다 — 시간 기반
    // 재조회와 포커스 복귀 일제 refetch를 제거(DOCS/file-tree-performance-design.md §3.2).
    staleTime: Infinity,
    // 워처 커버리지 밖(node_modules 등 IGNORED_DIRS) 외부 변경 보완 — 접었다 펴면 항상
    // 배경 재검증. 백엔드가 ms급(ignore 캐시)이라 비용이 사실상 0이다.
    refetchOnMount: "always",
    // 재검증 중 '…' 깜빡임 제거 — 캐시를 즉시 그리고 조용히 갱신.
    placeholderData: keepPreviousData,
  });
}

/**
 * 프로젝트 전환/시작 시 저장된 확장 폴더를 invoke 1개(list_dirs)로 워밍 — 트리가 즉시 뜬다
 * (설계 §3.1). 루트("")는 useProjectRootsPrefetch가 이미 시딩하므로 나머지만.
 */
export function useExpandedDirsPrefetch(projectId: string | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    const expanded = (useTreeState.getState().expanded[projectId] ?? []).filter((p) => p !== "");
    if (expanded.length === 0) return;
    let cancelled = false;
    void ipc
      .listDirs(projectId, expanded)
      .then((listings) => {
        if (cancelled) return;
        for (const l of listings) {
          // 이미 데이터가 있는 키는 건너뛴다 — 마운트된(펼쳐진) 폴더는 refetchOnMount가
          // 어차피 재검증하고, 배치가 뒤늦게 도착해 **더 신선한 refetch 결과를 옛 목록으로
          // 덮는** 레이스를 막는다(usePrefetchDiffs의 neverLoaded 가드와 같은 원칙).
          if (qc.getQueryState(keys.dir(projectId, l.relPath))?.data !== undefined) continue;
          qc.setQueryData(keys.dir(projectId, l.relPath), l.entries);
        }
      })
      .catch(() => {}); // 워밍 실패는 무해 — 개별 useDir이 평소 경로로 채운다
    return () => {
      cancelled = true;
    };
  }, [projectId, qc]);
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
      // ffmpeg 명시 경로(videoFfmpegPath)도 마찬가지 — 발견 상태 재확인
      void qc.invalidateQueries({ queryKey: ["video-tool"] });
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

/** 프로젝트 제거 + 프론트 상태 정리(터미널 PTY·뷰어 탭·트리 펼침·선택 해제) —
 *  사이드바(X·우클릭 메뉴)와 경로 소실 복구 화면 공용. */
export function useRemoveProjectFull() {
  const removeMutate = useRemoveProject().mutate;
  return useCallback(
    (id: string) => {
      useTerminals.getState().closeProjectTerminals(id); // PTY 정리 (설계 §16.8)
      useUi.getState().closeProjectViewerTabs(id);
      useTreeState.getState().clearProject(id);
      removeMutate(id, {
        onSuccess: () => {
          if (useUi.getState().selectedProjectId === id)
            useUi.getState().selectProject(null);
        },
      });
    },
    [removeMutate],
  );
}

/** 옮긴 프로젝트 폴더의 등록 경로 변경 — 목록 캐시를 즉시 갱신하고 그 프로젝트의
 *  상태·트리·diff를 재조회한다(경로가 바뀌었으니 전부 새 위치 기준). */
export function useUpdateProjectPath() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) =>
      ipc.updateProjectPath(id, path),
    onSuccess: (project) => {
      qc.setQueryData<Project[]>(keys.projects, (old) =>
        (old ?? []).map((p) => (p.id === project.id ? project : p)),
      );
      void qc.invalidateQueries({ queryKey: keys.projects });
      void qc.invalidateQueries({ queryKey: ["dir"] });
      invalidateRepoData(qc);
      useUi.getState().pushToast("success", `경로 변경됨 — ${project.path}`);
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

/** Viewer 편집 저장 — 파일을 디스크에 쓰고 status/diff만 갱신(히스토리·브랜치는 불변).
 *  `encoding`·`bom` 은 연 파일의 것을 그대로 돌려보내는 값이다(왕복 — 설계 B-K3).
 *  생략하면 UTF-8(기존 동작). */
export function useWriteFile(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      path: string;
      content: string;
      encoding?: string;
      bom?: boolean;
    }) => ipc.writeFile(projectId, v.path, v.content, v.encoding, v.bom),
    // UNMAPPABLE 은 실패가 아니라 **질문**이다 — 호출부(DiffViewer)가 "UTF-8 로 저장 / 취소"를
    // 묻는다. 여기서 토스트까지 띄우면 확인창과 빨간 토스트가 같이 뜬다.
    onError: (e) => {
      if (isIpcError(e) && e.code === "UNMAPPABLE") return;
      useUi.getState().pushToast("error", errorMessage(e));
    },
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
    mutationFn: async (relPath: string) => {
      await ipc.deletePath(projectId, relPath);
      // 이미지가 사라졌으면 사이드카 편집 문서도 버린다 — 안 그러면 같은 이름의 새 이미지가
      // 나중에 그 자리에 들어왔을 때 남의 주석이 되살아난다(41 §3.1: 키는 경로 정체다).
      await ipc.imageDocDelete(projectId, relPath).catch(() => {});
    },
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
 * 파일/폴더 이름 바꾸기 — 성공 시 트리·상태·diff 무효화 + 토스트.
 * 성공 콜백에 새 레포-상대 경로가 들어온다(호출 측이 펼침 상태·뷰어 탭을 새 경로로 옮긴다).
 */
export function useRenamePath(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { relPath: string; newName: string }) => {
      const newRel = await ipc.renamePath(projectId, v.relPath, v.newName);
      // 사이드카 키가 경로라 이름만 바꿔도 편집 문서와의 연결이 끊긴다 — 사용자 눈에는
      // "이름 바꿨더니 주석이 통째로 사라졌다"로 보인다(41 §3.1).
      await ipc.imageDocMove(projectId, v.relPath, newRel).catch(() => {});
      return newRel;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["dir"] });
      void qc.invalidateQueries({ queryKey: ["statuses"] });
      void qc.invalidateQueries({ queryKey: ["diff"] });
      // 이미지 캐시는 경로 키라 staleTime:Infinity로 남는다 — 나중에 다른 이미지가 그 이름을
      // 물려받으면 옛 그림이 그대로 뜬다.
      void qc.invalidateQueries({ queryKey: ["file-image"] });
      useUi.getState().pushToast("success", "이름을 바꿨습니다");
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

/**
 * 파일/폴더 이동(드래그 앤 드롭) 후 관련 캐시 무효화 — 여러 개를 옮겨도 한 번만 부른다
 * (항목마다 무효화하면 리페치가 폭주한다). file-image까지 지우는 이유는 rename과 같다:
 * staleTime Infinity라 옛 경로가 재사용되면 낡은 이미지가 남는다.
 */
export function invalidateAfterMove(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ["dir"] });
  void qc.invalidateQueries({ queryKey: ["statuses"] });
  void qc.invalidateQueries({ queryKey: ["diff"] });
  void qc.invalidateQueries({ queryKey: ["file-image"] });
}

/**
 * 이미지 변환·편집 저장 — base64 바이트를 디스크에 쓰고 트리·상태·diff·이미지 캐시 무효화.
 * 오류 토스트는 호출 측(에디터/변환)에서 처리한다 — 인코딩 단계 오류와 합쳐 한 번만 띄우기 위함.
 */
export function useSaveImage(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      relPath: string;
      base64: string;
      overwrite: boolean;
      expectedStamp?: string;
    }) =>
      ipc.writeFileBytes(
        projectId,
        v.relPath,
        v.base64,
        v.overwrite,
        v.expectedStamp,
      ),
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

/**
 * 컨텍스트 메뉴용 — 임의 projectId에 pull/push. useSyncOp은 projectId에 묶인 훅이라 우클릭 메뉴의
 * 동적 대상(선택 프로젝트가 아닐 수 있음)엔 못 쓴다. 호출 시점에 projectId를 받아 동일 인프라
 * (ops 스토어 진행상태·완료 토스트·레포 데이터 무효화)를 재사용한다.
 */
export function useProjectGitOps() {
  const qc = useQueryClient();
  const run = async (projectId: string, op: SyncOp, setUpstream = false) => {
    const ops = useOps.getState();
    if (ops.running[projectId]) return; // 이미 진행 중이면 무시(중복 방지)
    ops.start(projectId, op);
    try {
      if (op === "push") await ipc.push(projectId, setUpstream);
      else if (op === "pull") await ipc.pull(projectId);
      else await ipc.fetch(projectId);
      ops.finish(projectId);
      useUi.getState().pushToast("success", `${op} 완료`);
    } catch (e) {
      ops.finish(projectId);
      useUi.getState().pushToast("error", errorMessage(e));
    }
    invalidateRepoData(qc);
  };
  return {
    pull: (projectId: string) => void run(projectId, "pull"),
    push: (projectId: string, setUpstream: boolean) => void run(projectId, "push", setUpstream),
  };
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

/** 프로젝트 로고 수동 지정/해제(태스크 54) — `useProjectLogo` 캐시(`staleTime: Infinity`)를
 *  무효화해 이 창의 사이드바·툴바가 재시작 없이 갱신된다. 다른 창(모아보기 별도 창)은
 *  QueryClient가 따로라 여기서 못 닿으므로 백엔드가 `project://logo-changed`를 쏜다
 *  (events.ts `attachLogoEvents`). */
export function useSetProjectLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, relPath }: { id: string; relPath: string | null }) =>
      ipc.setProjectLogo(id, relPath),
    onSuccess: (project, { relPath }) => {
      qc.setQueryData<Project[]>(keys.projects, (old) =>
        (old ?? []).map((p) => (p.id === project.id ? project : p)),
      );
      void qc.invalidateQueries({ queryKey: ["project-logo", project.id] });
      useUi
        .getState()
        .pushToast("success", relPath ? "로고를 지정했습니다" : "로고를 해제했습니다");
    },
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

// ---- 작업 리포트 (태스크 60) ----

/** 히트맵 갱신 주기 — 커밋은 `repo://changed`가 `["activity"]`를 무효화해 즉시 반영된다(events.ts). */
const REPORT_STALE_MS = 5 * 60_000;

/**
 * 히트맵 첫 시리즈 — 프로젝트별 날짜별 커밋 수. "전체"면 프로젝트 수만큼 쿼리가 뜨므로
 * 키에 `until`을 넣지 않는다(항상 오늘 — 넣으면 자정마다 캐시가 통째로 날아간다).
 */
export function useActivities(
  projects: Project[],
  since: string,
  until: string,
  mine: boolean,
) {
  return useQueries({
    queries: projects.map((p) => ({
      queryKey: ["activity", p.id, since, mine] as const,
      queryFn: () => ipc.gitActivity(p.id, since, until, mine),
      staleTime: REPORT_STALE_MS,
    })),
  });
}

/** 히트맵 둘째 시리즈 — 프로젝트별 날짜별 프롬프트 수(전사 스캔이라 경로가 키다). */
export function usePromptDumps(
  projects: Project[],
  since: string,
  until: string,
) {
  return useQueries({
    queries: projects.map((p) => ({
      queryKey: ["prompts", p.path, since, until] as const,
      queryFn: () => ipc.claudePrompts(p.path, since, until),
      staleTime: REPORT_STALE_MS,
    })),
  });
}

/** 카드 입력 — 선택 기간의 커밋(≤200). */
export function useCommitsBetween(
  projectId: string,
  since: string,
  until: string,
  mine: boolean,
) {
  return useQuery({
    queryKey: ["commits-between", projectId, since, until, mine] as const,
    queryFn: () => ipc.commitsBetween(projectId, since, until, mine),
    staleTime: REPORT_STALE_MS,
  });
}

/**
 * 종합 카드 입력 — 프로젝트 여러 개의 커밋을 한 번에(태스크 67 §3.1). 키가 `useCommitsBetween`과
 * **같아** 종합 카드와 개별 카드가 같은 IPC를 나눠 쓴다(한 번만 읽는다).
 */
export function useCommitsBetweenMany(
  projects: Project[],
  since: string,
  until: string,
  mine: boolean,
) {
  return useQueries({
    queries: projects.map((p) => ({
      queryKey: ["commits-between", p.id, since, until, mine] as const,
      queryFn: () => ipc.commitsBetween(p.id, since, until, mine),
      staleTime: REPORT_STALE_MS,
    })),
  });
}

/** 카드 입력 — 선택 기간의 프롬프트 원문(히트맵의 1년 쿼리와 기간이 달라 키가 갈린다). */
export function usePrompts(projectPath: string, since: string, until: string) {
  return useQuery({
    queryKey: ["prompts", projectPath, since, until] as const,
    queryFn: () => ipc.claudePrompts(projectPath, since, until),
    staleTime: REPORT_STALE_MS,
  });
}

/** 저장된 요약 전체 — 리포트 뷰를 열면 즉시 본문이 보이도록 1회 로드해 캐시. */
export function useReports() {
  const qc = useQueryClient();

  /**
   * 다른 창(별도 리포트 창 ↔ 메인)의 저장·삭제를 이 창의 캐시에도 반영한다(태스크 67 §3.3).
   * `["reports"]`는 staleTime이 Infinity라 스스로 다시 읽지 않는다 — 이 구독이 없으면
   * 저쪽 창에서 만든 요약이 이쪽엔 영영 안 보인다. 훅 안에 두므로 창(QueryClient)마다 따로
   * 붙고, 리포트 뷰가 없는 창은 리스너도 없다. 보낸 창은 같은 값을 한 번 더 놓는다(멱등).
   */
  useEffect(() => {
    // listen()이 resolve되기 전에 정리가 먼저 돌 수 있다 — 늦게 온 unlisten을 그 자리에서
    // 호출해 리스너가 영구히 남지 않게 한다(DocWindow와 같은 처리).
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ key: string; record: ReportRecord | null }>(
      "report://changed",
      (e) => {
        const { key, record } = e.payload;
        qc.setQueryData<ReportMap>(["reports"], (old) => {
          // 아직 한 번도 안 읽었으면 건드리지 않는다 — 여기서 데이터를 만들면 그게 "신선한"
          // 캐시가 돼(staleTime Infinity) 최초 로드가 통째로 생략되고 이 한 건만 남는다.
          // 대신 **다시 읽는다**: 진행 중이던 `report_get_all` 의 스냅샷이 이 쓰기 이전 것이면
          // (읽기 락은 clone 직후 풀린다) 그냥 버릴 경우 그 키가 이 창에선 영영 없다.
          if (!old) {
            void qc.invalidateQueries({ queryKey: ["reports"] });
            return old;
          }
          const next = { ...old };
          if (record) next[key] = record;
          else delete next[key];
          return next;
        });
      },
    ).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [qc]);

  return useQuery({
    queryKey: ["reports"] as const,
    queryFn: ipc.reportGetAll,
    staleTime: Infinity,
  });
}

/** 요약 저장 — 캐시를 직접 갱신한다(전체 재조회 불필요, 항목이 수천 개일 수 있다). */
export function useSetReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, record }: { key: string; record: ReportRecord }) =>
      ipc.reportSet(key, record),
    onSuccess: (_r, { key, record }) =>
      qc.setQueryData<ReportMap>(["reports"], (old) => ({ ...old, [key]: record })),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}

export function useDeleteReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => ipc.reportDelete(key),
    onSuccess: (_r, key) =>
      qc.setQueryData<ReportMap>(["reports"], (old) => {
        const next = { ...old };
        delete next[key];
        return next;
      }),
    onError: (e) => useUi.getState().pushToast("error", errorMessage(e)),
  });
}
