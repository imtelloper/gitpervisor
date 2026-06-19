import { create } from "zustand";

import type { DiffTarget } from "../lib/ipc";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  message: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

interface UiState {
  selectedProjectId: string | null;
  /** 중앙 뷰어가 표시할 diff 대상 — Changes(worktree/index) 또는 Log(commit)에서 설정 */
  selectedDiff: DiffTarget | null;
  /** 하단 Log 패널 펼침 여부 */
  logOpen: boolean;
  /** Log 패널에서 선택된 커밋 (상세 패널 구동) */
  selectedCommitSha: string | null;
  /** 설정 모달 열림 여부 */
  settingsOpen: boolean;
  /** 메모 팝오버 열림 여부 (현재 선택 프로젝트) */
  memoOpen: boolean;
  /** diff 뷰어: 변경 없는 영역 접기 (기본 접기, 끄면 전체 펼침) */
  diffCollapseUnchanged: boolean;
  /** 파일 트리 패널 표시 여부 (localStorage 영속) */
  fileTreeOpen: boolean;
  /** PROJECTS: 변경/활동 있는 프로젝트를 위로 정렬 (localStorage 영속) */
  projectSortByChanges: boolean;
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  selectProject: (id: string | null) => void;
  selectDiff: (target: DiffTarget | null) => void;
  toggleLog: () => void;
  selectCommit: (sha: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setMemoOpen: (open: boolean) => void;
  toggleDiffCollapse: () => void;
  toggleFileTree: () => void;
  toggleProjectSort: () => void;
  pushToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
  askConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
}

let toastSeq = 0;

export const useUi = create<UiState>((set) => ({
  // 마지막 선택 프로젝트를 복원한다 — 재시작 시 그 프로젝트(+복구된 터미널 탭)로 바로 진입
  selectedProjectId: localStorage.getItem("gp:selected-project"),
  selectedDiff: null,
  logOpen: false,
  selectedCommitSha: null,
  settingsOpen: false,
  memoOpen: false,
  diffCollapseUnchanged: true,
  // 파일 트리는 기본 열림 — 사용자가 명시적으로 닫은 경우("0")만 닫힌 채 복원
  fileTreeOpen: localStorage.getItem("gp:filetree-open") !== "0",
  projectSortByChanges: localStorage.getItem("gp:project-sort-changes") === "1",
  toasts: [],
  confirm: null,
  // 프로젝트 전환 시 diff·커밋 선택은 초기화하되 Log 패널 펼침 상태는 유지
  selectProject: (id) => {
    if (id) localStorage.setItem("gp:selected-project", id);
    else localStorage.removeItem("gp:selected-project");
    set({
      selectedProjectId: id,
      selectedDiff: null,
      selectedCommitSha: null,
      memoOpen: false,
    });
  },
  selectDiff: (target) => set({ selectedDiff: target }),
  toggleLog: () => set((s) => ({ logOpen: !s.logOpen })),
  selectCommit: (sha) => set({ selectedCommitSha: sha }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
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
  pushToast: (kind, message) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => useUi.getState().dismissToast(id), 6000);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  askConfirm: (req) => set({ confirm: req }),
  closeConfirm: () => set({ confirm: null }),
}));
