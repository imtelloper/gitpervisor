import { create } from "zustand";

import { disposeTerminal, onTermExit } from "../lib/terminal";

export type SplitDir = "row" | "col"; // row=좌우 분할, col=상하 분할

/** 한 터미널 탭의 분할 레이아웃 트리. 리프 = 터미널 패널(paneId=termId). */
export type Pane =
  | { kind: "leaf"; paneId: string }
  | { kind: "split"; id: string; dir: SplitDir; ratio: number; a: Pane; b: Pane };

export interface TermTab {
  id: string;
  projectId: string;
  title: string;
  layout: Pane;
  /** 포커스된 패널 — 분할/닫기·단축키의 기준 */
  activePaneId: string;
  /** 설정 시 해당 패널만 전체 표시 (나머지는 백그라운드 유지) */
  maximizedPaneId: string | null;
}

type PaneStatus = "live" | "exited";

// ---- 레이아웃 트리 헬퍼 ----
function collectPanes(node: Pane): string[] {
  return node.kind === "leaf"
    ? [node.paneId]
    : [...collectPanes(node.a), ...collectPanes(node.b)];
}

function splitAt(
  node: Pane,
  target: string,
  dir: SplitDir,
  newPaneId: string,
  newFirst: boolean,
): Pane {
  if (node.kind === "leaf") {
    if (node.paneId !== target) return node;
    const oldLeaf: Pane = node;
    const newLeaf: Pane = { kind: "leaf", paneId: newPaneId };
    return {
      kind: "split",
      id: crypto.randomUUID(),
      dir,
      ratio: 0.5,
      a: newFirst ? newLeaf : oldLeaf,
      b: newFirst ? oldLeaf : newLeaf,
    };
  }
  return {
    ...node,
    a: splitAt(node.a, target, dir, newPaneId, newFirst),
    b: splitAt(node.b, target, dir, newPaneId, newFirst),
  };
}

function removePane(node: Pane, target: string): Pane | null {
  if (node.kind === "leaf") return node.paneId === target ? null : node;
  const a = removePane(node.a, target);
  const b = removePane(node.b, target);
  if (a === null) return b; // 형제가 분할 자리를 차지
  if (b === null) return a;
  return { ...node, a, b };
}

function setRatioAt(node: Pane, splitId: string, ratio: number): Pane {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    a: setRatioAt(node.a, splitId, ratio),
    b: setRatioAt(node.b, splitId, ratio),
  };
}

export { collectPanes };

interface TerminalsState {
  terminals: TermTab[];
  /** 프로젝트별 활성 탭 ("viewer" 또는 tabId) */
  activeTab: Record<string, string>;
  paneStatus: Record<string, PaneStatus>;
  openTerminal: (projectId: string) => string;
  closeTab: (tabId: string) => void;
  closeProjectTerminals: (projectId: string) => void;
  setActiveTab: (projectId: string, tab: string) => void;
  splitPane: (
    tabId: string,
    paneId: string,
    dir: SplitDir,
    newFirst: boolean,
  ) => void;
  closePane: (tabId: string, paneId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  toggleMaximize: (tabId: string, paneId: string) => void;
  setRatio: (tabId: string, splitId: string, ratio: number) => void;
  setPaneStatus: (paneId: string, status: PaneStatus) => void;
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  terminals: [],
  activeTab: {},
  paneStatus: {},

  openTerminal: (projectId) => {
    const tabId = crypto.randomUUID();
    const paneId = crypto.randomUUID();
    const n = get().terminals.filter((t) => t.projectId === projectId).length + 1;
    set((s) => ({
      terminals: [
        ...s.terminals,
        {
          id: tabId,
          projectId,
          title: `터미널 ${n}`,
          layout: { kind: "leaf", paneId },
          activePaneId: paneId,
          maximizedPaneId: null,
        },
      ],
      activeTab: { ...s.activeTab, [projectId]: tabId },
      paneStatus: { ...s.paneStatus, [paneId]: "live" },
    }));
    return tabId;
  },

  closeTab: (tabId) => {
    const tab = get().terminals.find((t) => t.id === tabId);
    if (tab) collectPanes(tab.layout).forEach((p) => disposeTerminal(p));
    set((s) => {
      const activeTab = { ...s.activeTab };
      if (tab && activeTab[tab.projectId] === tabId)
        activeTab[tab.projectId] = "viewer";
      const paneStatus = { ...s.paneStatus };
      if (tab) collectPanes(tab.layout).forEach((p) => delete paneStatus[p]);
      return {
        terminals: s.terminals.filter((t) => t.id !== tabId),
        activeTab,
        paneStatus,
      };
    });
  },

  closeProjectTerminals: (projectId) => {
    const tabs = get().terminals.filter((t) => t.projectId === projectId);
    tabs.forEach((t) => collectPanes(t.layout).forEach((p) => disposeTerminal(p)));
    set((s) => {
      const activeTab = { ...s.activeTab };
      delete activeTab[projectId];
      const paneStatus = { ...s.paneStatus };
      tabs.forEach((t) =>
        collectPanes(t.layout).forEach((p) => delete paneStatus[p]),
      );
      return {
        terminals: s.terminals.filter((t) => t.projectId !== projectId),
        activeTab,
        paneStatus,
      };
    });
  },

  setActiveTab: (projectId, tab) =>
    set((s) => ({ activeTab: { ...s.activeTab, [projectId]: tab } })),

  splitPane: (tabId, paneId, dir, newFirst) => {
    const newPaneId = crypto.randomUUID();
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === tabId
          ? {
              ...t,
              layout: splitAt(t.layout, paneId, dir, newPaneId, newFirst),
              activePaneId: newPaneId,
              maximizedPaneId: null,
            }
          : t,
      ),
      paneStatus: { ...s.paneStatus, [newPaneId]: "live" },
    }));
  },

  closePane: (tabId, paneId) => {
    disposeTerminal(paneId);
    const tab = get().terminals.find((t) => t.id === tabId);
    if (!tab) return;
    const layout = removePane(tab.layout, paneId);
    if (layout === null) {
      get().closeTab(tabId);
      return;
    }
    const remaining = collectPanes(layout);
    set((s) => {
      const paneStatus = { ...s.paneStatus };
      delete paneStatus[paneId];
      return {
        terminals: s.terminals.map((t) =>
          t.id === tabId
            ? {
                ...t,
                layout,
                activePaneId: remaining.includes(t.activePaneId)
                  ? t.activePaneId
                  : remaining[remaining.length - 1],
                maximizedPaneId:
                  t.maximizedPaneId && remaining.includes(t.maximizedPaneId)
                    ? t.maximizedPaneId
                    : null,
              }
            : t,
        ),
        paneStatus,
      };
    });
  },

  setActivePane: (tabId, paneId) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === tabId ? { ...t, activePaneId: paneId } : t,
      ),
    })),

  toggleMaximize: (tabId, paneId) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === tabId
          ? {
              ...t,
              maximizedPaneId: t.maximizedPaneId === paneId ? null : paneId,
            }
          : t,
      ),
    })),

  setRatio: (tabId, splitId, ratio) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === tabId ? { ...t, layout: setRatioAt(t.layout, splitId, ratio) } : t,
      ),
    })),

  setPaneStatus: (paneId, status) =>
    set((s) => ({ paneStatus: { ...s.paneStatus, [paneId]: status } })),
}));

// 셸 종료(term://exit) → 해당 패널을 exited로 표시 (모듈 로드 시 1회 구독)
onTermExit((id) => useTerminals.getState().setPaneStatus(id, "exited"));
