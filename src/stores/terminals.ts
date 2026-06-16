import { create } from "zustand";

import { disposeTerminal, onTermExit } from "../lib/terminal";

export interface TermTab {
  id: string;
  projectId: string;
  title: string;
  status: "live" | "exited";
}

/** 중앙 워크스페이스 탭의 활성 값 — "viewer" 또는 termId */
type ActiveTab = string;

interface TerminalsState {
  terminals: TermTab[];
  /** 프로젝트별 활성 탭 (기본 "viewer") */
  activeTab: Record<string, ActiveTab>;
  openTerminal: (projectId: string) => string;
  closeTerminal: (id: string) => void;
  closeProjectTerminals: (projectId: string) => void;
  setActiveTab: (projectId: string, tab: ActiveTab) => void;
  setStatus: (id: string, status: TermTab["status"]) => void;
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  terminals: [],
  activeTab: {},

  openTerminal: (projectId) => {
    const id = crypto.randomUUID();
    const n = get().terminals.filter((t) => t.projectId === projectId).length + 1;
    set((s) => ({
      terminals: [...s.terminals, { id, projectId, title: `터미널 ${n}`, status: "live" }],
      activeTab: { ...s.activeTab, [projectId]: id },
    }));
    return id;
  },

  closeTerminal: (id) => {
    disposeTerminal(id); // PTY kill + xterm dispose
    set((s) => {
      const term = s.terminals.find((t) => t.id === id);
      const activeTab = { ...s.activeTab };
      if (term && activeTab[term.projectId] === id) activeTab[term.projectId] = "viewer";
      return { terminals: s.terminals.filter((t) => t.id !== id), activeTab };
    });
  },

  closeProjectTerminals: (projectId) => {
    get()
      .terminals.filter((t) => t.projectId === projectId)
      .forEach((t) => disposeTerminal(t.id));
    set((s) => {
      const activeTab = { ...s.activeTab };
      delete activeTab[projectId];
      return {
        terminals: s.terminals.filter((t) => t.projectId !== projectId),
        activeTab,
      };
    });
  },

  setActiveTab: (projectId, tab) =>
    set((s) => ({ activeTab: { ...s.activeTab, [projectId]: tab } })),

  setStatus: (id, status) =>
    set((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, status } : t)),
    })),
}));

// 셸 종료(term://exit) → 해당 탭을 exited로 표시 (모듈 로드 시 1회 구독)
onTermExit((id) => useTerminals.getState().setStatus(id, "exited"));
