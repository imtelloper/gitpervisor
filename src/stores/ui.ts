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
  toasts: Toast[];
  confirm: ConfirmRequest | null;
  selectProject: (id: string | null) => void;
  selectDiff: (target: DiffTarget | null) => void;
  toggleLog: () => void;
  selectCommit: (sha: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  pushToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
  askConfirm: (req: ConfirmRequest) => void;
  closeConfirm: () => void;
}

let toastSeq = 0;

export const useUi = create<UiState>((set) => ({
  selectedProjectId: null,
  selectedDiff: null,
  logOpen: false,
  selectedCommitSha: null,
  settingsOpen: false,
  toasts: [],
  confirm: null,
  // 프로젝트 전환 시 diff·커밋 선택은 초기화하되 Log 패널 펼침 상태는 유지
  selectProject: (id) =>
    set({
      selectedProjectId: id,
      selectedDiff: null,
      selectedCommitSha: null,
    }),
  selectDiff: (target) => set({ selectedDiff: target }),
  toggleLog: () => set((s) => ({ logOpen: !s.logOpen })),
  selectCommit: (sha) => set({ selectedCommitSha: sha }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
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
