import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

import type { DiffTarget } from "../lib/ipc";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  message: string;
  /** 선택 액션 버튼(예: "설정 열기") — 클릭 시 실행 + 토스트 닫힘. */
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  message: string;
  detail?: string; // 본문 아래 모노스페이스 박스(경로 등 — 줄바꿈 보존)
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export interface PromptRequest {
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  /** 입력값 검증 — 오류 메시지를 반환하면 확인이 막힌다(null이면 통과). */
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => void;
}

/** 뷰어에 열린 파일 탭 하나 — 같은 파일이라도 모드(diff/파일)가 다르면 별개 탭. */
export interface ViewerFileTab {
  key: string;
  /** 이 탭이 속한(뷰어에 표시되는) 프로젝트 id */
  outerId: string;
  /** 임베디드 저장소 라우팅용 합성 id (없으면 null → outer) */
  repoId: string | null;
  target: DiffTarget;
}

/** 탭 동일성 키 — file 모드의 line은 제외(같은 파일 내 이동은 기존 탭 재사용). */
export function viewerTabKey(
  target: DiffTarget,
  repoId: string | null,
  outerId: string,
): string {
  const sha = target.mode === "commit" ? target.sha : "";
  return `${repoId ?? outerId}|${target.mode}|${target.path}|${sha}`;
}

interface UiState {
  selectedProjectId: string | null;
  /** 중앙 뷰어가 표시할 diff 대상 — Changes(worktree/index) 또는 Log(commit)에서 설정 */
  selectedDiff: DiffTarget | null;
  /**
   * selectedDiff를 조회할 저장소 id. 임베디드(중첩) 저장소의 파일을 클릭하면 그 저장소의
   * 합성 id(`<outer>::<rel>`)가 들어와 diff/편집이 중첩 저장소를 대상으로 라우팅된다.
   * null이면 현재 선택 프로젝트(outer)를 쓴다.
   */
  selectedDiffRepoId: string | null;
  /**
   * 뷰어에 열린 파일 탭들(PyCharm식) — selectDiff로 연 대상이 쌓이고, go-to-definition으로
   * 점프해도 이전 파일이 탭으로 남아 되돌아갈 수 있다. 프로젝트별로 필터해 표시(outerId).
   */
  viewerTabs: ViewerFileTab[];
  /**
   * 프로젝트별 "마지막 활성 파일" — 프로젝트를 오갈 때 보던 파일로 복원한다(selectedDiff는
   * 전역 단일값이라 전환 시 리셋되므로). selectDiff에서 갱신, selectProject에서 복원.
   */
  activeDiffByProject: Record<string, { target: DiffTarget; repoId: string | null }>;
  /** 하단 Log 패널 펼침 여부 */
  logOpen: boolean;
  /** 하단 Log 패널 펼침 높이(px) — 드래그로 조절, localStorage 영속 */
  logHeight: number;
  /** 터미널 모아보기(여러 터미널 한 화면 분할) 모드 */
  aggregateOpen: boolean;
  /**
   * 모아보기 그리드 트랙 크기 — 셀 개수(n)별로 행 높이(rows)와 "행마다 독립적인" 셀 폭
   * (cols[r] = r행의 fr 배열)을 기억한다. 가로 드래그는 같은 행 이웃과만 재분배하므로
   * 다른 행의 폭에 영향이 없고, 재분배(총합 불변)라 셀이 화면 밖으로 밀려나지 않는다.
   * 여닫아도 유지되게 localStorage 영속. fr은 상대값이라 창 크기가 변해도 비율 유지.
   */
  aggregateTracks: Record<string, { rows: number[]; cols: number[][] }>;
  /** Log 패널에서 선택된 커밋 (상세 패널 구동) */
  selectedCommitSha: string | null;
  /** 설정 모달 열림 여부 */
  settingsOpen: boolean;
  /** Quick Open(파일 퍼지 검색 모달) 열림 여부 — 세션 상태, 영속 없음 */
  quickOpenOpen: boolean;
  /** Go to Symbol(전역 심볼 검색 모달) 열림 여부 */
  symbolSearchOpen: boolean;
  /** 메모 팝오버 열림 여부 (현재 선택 프로젝트) */
  memoOpen: boolean;
  /** diff 뷰어: 변경 없는 영역 접기 (기본 접기, 끄면 전체 펼침) */
  diffCollapseUnchanged: boolean;
  /** 파일 트리 패널 표시 여부 (localStorage 영속) */
  fileTreeOpen: boolean;
  /** PROJECTS: 변경/활동 있는 프로젝트를 위로 정렬 (localStorage 영속) */
  projectSortByChanges: boolean;
  /** 이미지 편집기 대상(레포 상대 경로) — 열려 있으면 모달 표시 */
  imageEditorPath: string | null;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  prompt: PromptRequest | null;
  selectProject: (id: string | null) => void;
  selectDiff: (target: DiffTarget | null, repoId?: string | null) => void;
  /** 뷰어 파일 탭 닫기 — 활성 탭이었으면 이웃 탭으로 전환(없으면 선택 해제). */
  closeViewerTab: (key: string) => void;
  /** 프로젝트 제거 시 그 프로젝트의 뷰어 탭·활성 파일 정리(고아 방지). */
  closeProjectViewerTabs: (projectId: string) => void;
  toggleLog: () => void;
  setLogHeight: (h: number) => void;
  setAggregateOpen: (open: boolean) => void;
  toggleAggregate: () => void;
  /** 모아보기 그리드 트랙 저장(+영속). 경계 드래그 중 실시간 호출. */
  setAggregateTracks: (
    shape: string,
    tracks: { rows: number[]; cols: number[][] },
  ) => void;
  selectCommit: (sha: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setQuickOpenOpen: (open: boolean) => void;
  setSymbolSearchOpen: (open: boolean) => void;
  setMemoOpen: (open: boolean) => void;
  toggleDiffCollapse: () => void;
  toggleFileTree: () => void;
  toggleProjectSort: () => void;
  pushToast: (
    kind: Toast["kind"],
    message: string,
    action?: Toast["action"],
  ) => void;
  dismissToast: (id: number) => void;
  askConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
  askPrompt: (req: PromptRequest) => void;
  closePrompt: () => void;
  openImageEditor: (path: string) => void;
  closeImageEditor: () => void;
}

let toastSeq = 0;

// 뷰어 탭 + 프로젝트별 활성 파일 영속(재시작 후 복원). 프로젝트 전환 시엔 store가 그대로 유지되고,
// 재시작 시 이 loader가 localStorage에서 복원한다. worktree/index 대상은 재시작 후 stale일 수 있으나
// DiffViewer가 없는/안 바뀐 파일을 무해하게 처리한다(사용자가 닫으면 됨).
const VIEWER_KEY = "gp:viewer-tabs";
function loadPersistedViewer(): {
  viewerTabs: ViewerFileTab[];
  activeDiffByProject: UiState["activeDiffByProject"];
} {
  try {
    const raw = localStorage.getItem(VIEWER_KEY);
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object") return { viewerTabs: [], activeDiffByProject: {} };
    return {
      viewerTabs: Array.isArray(p.viewerTabs) ? p.viewerTabs : [],
      activeDiffByProject:
        p.activeDiffByProject && typeof p.activeDiffByProject === "object"
          ? p.activeDiffByProject
          : {},
    };
  } catch {
    return { viewerTabs: [], activeDiffByProject: {} };
  }
}
const persistedViewer = loadPersistedViewer();
// 재시작 시 초기 선택 프로젝트의 마지막 활성 파일도 복원(전환 복원과 동일 경험).
const initialProjectId = localStorage.getItem("gp:selected-project");
const initialActive = initialProjectId
  ? persistedViewer.activeDiffByProject[initialProjectId]
  : null;

export const useUi = create<UiState>((set) => ({
  // 마지막 선택 프로젝트를 복원한다 — 재시작 시 그 프로젝트(+복구된 터미널 탭)로 바로 진입
  selectedProjectId: initialProjectId,
  selectedDiff: initialActive?.target ?? null,
  selectedDiffRepoId: initialActive?.repoId ?? null,
  viewerTabs: persistedViewer.viewerTabs,
  activeDiffByProject: persistedViewer.activeDiffByProject,
  logOpen: false,
  logHeight: (() => {
    const raw = Number(localStorage.getItem("gp:log-height"));
    return raw >= 120 ? raw : 288; // 기본 288px(기존 h-72)
  })(),
  aggregateOpen: false,
  aggregateTracks: (() => {
    try {
      // 구버전(셀별 px — 셀이 그리드 밖으로 밀려나던 방식) 키는 더 안 쓰므로 정리
      localStorage.removeItem("gp:aggregate-sizes");
      const p = JSON.parse(localStorage.getItem("gp:aggregate-tracks") || "null");
      // 포맷이 구버전(cols 1차원)이어도 그대로 들고 있는다 — 컴포넌트가 행 구조 검증에
      // 실패하면 균등 분할로 폴백하고, 다음 드래그에서 새 포맷으로 덮어쓴다.
      return p && typeof p === "object"
        ? (p as Record<string, { rows: number[]; cols: number[][] }>)
        : {};
    } catch {
      return {};
    }
  })(),
  selectedCommitSha: null,
  settingsOpen: false,
  quickOpenOpen: false,
  symbolSearchOpen: false,
  memoOpen: false,
  diffCollapseUnchanged: true,
  // 파일 트리는 기본 열림 — 사용자가 명시적으로 닫은 경우("0")만 닫힌 채 복원
  fileTreeOpen: localStorage.getItem("gp:filetree-open") !== "0",
  projectSortByChanges: localStorage.getItem("gp:project-sort-changes") === "1",
  imageEditorPath: null,
  toasts: [],
  confirm: null,
  prompt: null,
  // 프로젝트 전환 시 diff·커밋 선택은 초기화하되 Log 패널 펼침 상태는 유지
  selectProject: (id) => {
    if (id) localStorage.setItem("gp:selected-project", id);
    else localStorage.removeItem("gp:selected-project");
    set((s) => {
      // 이 프로젝트에서 마지막에 보던 파일로 복원(없으면 null). 전역 selectedDiff가 프로젝트별로
      // 기억되는 효과. 워크스페이스 뷰(viewer/db/terminal)는 terminals.activeTab이 별도로 복원.
      const restored = id ? s.activeDiffByProject[id] : null;
      return {
        selectedProjectId: id,
        selectedDiff: restored?.target ?? null,
        selectedDiffRepoId: restored?.repoId ?? null,
        selectedCommitSha: null,
        memoOpen: false,
        // 이미지 편집기는 프로젝트별 상대 경로라 프로젝트가 바뀌면 닫는다(엉뚱한 프로젝트에 쓰기 방지).
        imageEditorPath: null,
      };
    });
  },
  // repoId: 임베디드 저장소 파일이면 그 저장소의 합성 id, 아니면 생략(outer로 라우팅).
  // 대상을 뷰어 탭으로도 업서트한다 — 같은 키의 탭이 있으면 target만 갱신(file 모드의
  // line 이동이 기존 탭에서 일어나게), 없으면 뒤에 추가. null은 선택만 해제(탭 유지).
  selectDiff: (target, repoId) =>
    set((s) => {
      if (!target) return { selectedDiff: null, selectedDiffRepoId: null };
      const outerId = s.selectedProjectId;
      // 모아보기 중 파일을 열면(사이드바 트리·퀵오픈·심볼검색·정의 이동) 모아보기를 닫고
      // 그 프로젝트를 뷰어 탭으로 전환한다 — 안 그러면 연 파일이 모아보기에 가려 안 보인다.
      // 동적 import: 정적으로 걸면 ui→terminals→lib/terminal→ui 순환이라 시작 시 TDZ 위험.
      if (s.aggregateOpen && outerId)
        void import("./terminals").then((m) =>
          m.useTerminals.getState().setActiveTab(outerId, "viewer"),
        );
      const closeAggregate = s.aggregateOpen;
      if (!outerId)
        return {
          selectedDiff: target,
          selectedDiffRepoId: repoId ?? null,
          ...(closeAggregate && { aggregateOpen: false }),
        };
      const key = viewerTabKey(target, repoId ?? null, outerId);
      const tab: ViewerFileTab = { key, outerId, repoId: repoId ?? null, target };
      const idx = s.viewerTabs.findIndex((t) => t.key === key);
      return {
        ...(closeAggregate && { aggregateOpen: false }),
        selectedDiff: target,
        selectedDiffRepoId: repoId ?? null,
        // 프로젝트별 "마지막 활성 파일" 갱신 — 전환 후 복귀 시 이 파일로 돌아온다.
        activeDiffByProject: {
          ...s.activeDiffByProject,
          [outerId]: { target, repoId: repoId ?? null },
        },
        viewerTabs:
          idx >= 0
            ? s.viewerTabs.map((t, i) => (i === idx ? tab : t))
            : [...s.viewerTabs, tab],
      };
    }),
  closeViewerTab: (key) =>
    set((s) => {
      const closing = s.viewerTabs.find((t) => t.key === key);
      if (!closing) return s;
      const viewerTabs = s.viewerTabs.filter((t) => t.key !== key);
      const activeKey =
        s.selectedDiff && s.selectedProjectId
          ? viewerTabKey(s.selectedDiff, s.selectedDiffRepoId, s.selectedProjectId)
          : null;
      if (activeKey !== key) return { viewerTabs };
      // 활성 탭을 닫음 — 같은 프로젝트의 이웃(원래 자리, 없으면 마지막) 탭으로 전환
      const sibsBefore = s.viewerTabs.filter((t) => t.outerId === closing.outerId);
      const sibIdx = sibsBefore.findIndex((t) => t.key === key);
      const sibs = sibsBefore.filter((t) => t.key !== key);
      const next = sibs[Math.min(sibIdx, sibs.length - 1)] ?? null;
      // 프로젝트별 활성 파일도 이웃 탭으로(마지막 탭이면 제거) — 복원 값이 닫힌 탭을 가리키지 않게.
      const activeDiffByProject = { ...s.activeDiffByProject };
      if (next) activeDiffByProject[closing.outerId] = { target: next.target, repoId: next.repoId };
      else delete activeDiffByProject[closing.outerId];
      return {
        viewerTabs,
        selectedDiff: next?.target ?? null,
        selectedDiffRepoId: next?.repoId ?? null,
        activeDiffByProject,
      };
    }),
  closeProjectViewerTabs: (projectId) =>
    set((s) => {
      const activeDiffByProject = { ...s.activeDiffByProject };
      delete activeDiffByProject[projectId];
      return {
        viewerTabs: s.viewerTabs.filter((t) => t.outerId !== projectId),
        activeDiffByProject,
      };
    }),
  toggleLog: () => set((s) => ({ logOpen: !s.logOpen })),
  setLogHeight: (h) => {
    const v = Math.max(120, Math.min(h, window.innerHeight - 200));
    localStorage.setItem("gp:log-height", String(v));
    set({ logHeight: v });
  },
  setAggregateOpen: (open) => set({ aggregateOpen: open }),
  toggleAggregate: () => set((s) => ({ aggregateOpen: !s.aggregateOpen })),
  setAggregateTracks: (shape, tracks) =>
    set((s) => {
      const next = { ...s.aggregateTracks, [shape]: tracks };
      try {
        localStorage.setItem("gp:aggregate-tracks", JSON.stringify(next));
      } catch {
        /* localStorage 불가 환경 무시 */
      }
      return { aggregateTracks: next };
    }),
  selectCommit: (sha) => set({ selectedCommitSha: sha }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setQuickOpenOpen: (open) => set({ quickOpenOpen: open }),
  setSymbolSearchOpen: (open) => set({ symbolSearchOpen: open }),
  setMemoOpen: (open) => set({ memoOpen: open }),
  toggleDiffCollapse: () =>
    set((s) => ({ diffCollapseUnchanged: !s.diffCollapseUnchanged })),
  toggleFileTree: () =>
    set((s) => {
      const v = !s.fileTreeOpen;
      localStorage.setItem("gp:filetree-open", v ? "1" : "0");
      return { fileTreeOpen: v };
    }),
  toggleProjectSort: () =>
    set((s) => {
      const v = !s.projectSortByChanges;
      localStorage.setItem("gp:project-sort-changes", v ? "1" : "0");
      return { projectSortByChanges: v };
    }),
  pushToast: (kind, message, action) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }));
    setTimeout(() => useUi.getState().dismissToast(id), 6000);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  askConfirm: (req) => set({ confirm: req }),
  closeConfirm: () => set({ confirm: null }),
  askPrompt: (req) => set({ prompt: req }),
  closePrompt: () => set({ prompt: null }),
  openImageEditor: (path) => set({ imageEditorPath: path }),
  closeImageEditor: () => set({ imageEditorPath: null }),
}));

// 뷰어 탭 + 프로젝트별 활성 파일 영속 — 두 슬라이스가 바뀔 때만 기록(참조 비교로 잦은 UI 변화 무시).
// 플로팅 창은 뷰어가 없어 스킵(메인 창 상태를 덮어쓰지 않게).
const IS_FLOAT_UI = (() => {
  try {
    return getCurrentWebviewWindow().label.startsWith("float-");
  } catch {
    return false;
  }
})();
if (!IS_FLOAT_UI) {
  let prevTabs = persistedViewer.viewerTabs;
  let prevActive = persistedViewer.activeDiffByProject;
  useUi.subscribe((s) => {
    if (s.viewerTabs === prevTabs && s.activeDiffByProject === prevActive) return;
    prevTabs = s.viewerTabs;
    prevActive = s.activeDiffByProject;
    try {
      localStorage.setItem(
        VIEWER_KEY,
        JSON.stringify({ viewerTabs: s.viewerTabs, activeDiffByProject: s.activeDiffByProject }),
      );
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  });
}
