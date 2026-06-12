import { create } from "zustand";

export interface Toast {
  id: number;
  kind: "error" | "info";
  message: string;
}

interface UiState {
  selectedProjectId: string | null;
  selectedFilePath: string | null;
  toasts: Toast[];
  selectProject: (id: string | null) => void;
  selectFile: (path: string | null) => void;
  pushToast: (kind: Toast["kind"], message: string) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useUi = create<UiState>((set) => ({
  selectedProjectId: null,
  selectedFilePath: null,
  toasts: [],
  selectProject: (id) => set({ selectedProjectId: id, selectedFilePath: null }),
  selectFile: (path) => set({ selectedFilePath: path }),
  pushToast: (kind, message) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => useUi.getState().dismissToast(id), 6000);
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
