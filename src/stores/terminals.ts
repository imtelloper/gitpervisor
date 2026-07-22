import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

import { openFloatingWindow } from "../lib/floating";
import { detachTerminalKeepPty, disposeTerminal, onTermExit } from "../lib/terminal";

// 플로팅 창(label=float-*)은 메인 창과 같은 origin이라 localStorage(gp:terminals)를 공유한다.
// 따라서 플로팅 창의 스토어는 빈 상태로 시작하고 영속화하지 않는다(메인 창 탭을 덮어쓰지 않게).
// 플로팅 창의 초기 탭은 FloatingTerminal이 시드한다.
const IS_FLOAT = (() => {
  try {
    return getCurrentWebviewWindow().label.startsWith("float-");
  } catch {
    return false;
  }
})();

export type SplitDir = "row" | "col"; // row=좌우 분할, col=상하 분할

/** 리프 패널의 내용 종류 — 터미널(PTY) 또는 브라우저(웹뷰). */
export type PaneKind = "terminal" | "browser";

/** 한 탭의 분할 레이아웃 트리. 리프 = 패널(paneId). content로 터미널/웹 구분. */
export type Pane =
  | { kind: "leaf"; paneId: string; content: PaneKind }
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
  content: PaneKind,
): Pane {
  if (node.kind === "leaf") {
    if (node.paneId !== target) return node;
    const oldLeaf: Pane = node;
    const newLeaf: Pane = { kind: "leaf", paneId: newPaneId, content };
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
    a: splitAt(node.a, target, dir, newPaneId, newFirst, content),
    b: splitAt(node.b, target, dir, newPaneId, newFirst, content),
  };
}

/** 노드 배열을 한 방향(dir)으로 균형 분할 트리로 묶는다(절반씩 재귀 → 칸이 고르게 나뉜다). */
function makeBalanced(nodes: Pane[], dir: SplitDir): Pane {
  if (nodes.length === 1) return nodes[0];
  const mid = Math.ceil(nodes.length / 2);
  return {
    kind: "split",
    id: crypto.randomUUID(),
    dir,
    ratio: mid / nodes.length,
    a: makeBalanced(nodes.slice(0, mid), dir),
    b: makeBalanced(nodes.slice(mid), dir),
  };
}

/** paneId 목록을 cols열 그리드(행=row 분할, 행 묶음=col 분할)로 배치한다. */
function buildGrid(paneIds: string[], cols: number): Pane {
  const leaves: Pane[] = paneIds.map((id) => ({
    kind: "leaf",
    paneId: id,
    content: "terminal",
  }));
  const rows: Pane[] = [];
  for (let i = 0; i < leaves.length; i += cols)
    rows.push(makeBalanced(leaves.slice(i, i + cols), "row"));
  return makeBalanced(rows, "col");
}

/** 트리에서 target 리프를 subtree로 교체한다(탭의 나머지 레이아웃은 그대로 유지). */
function replaceLeaf(node: Pane, target: string, subtree: Pane): Pane {
  if (node.kind === "leaf") return node.paneId === target ? subtree : node;
  return {
    ...node,
    a: replaceLeaf(node.a, target, subtree),
    b: replaceLeaf(node.b, target, subtree),
  };
}

/** 리프의 content(터미널↔브라우저)만 바꾼다. */
function setContentAt(node: Pane, target: string, content: PaneKind): Pane {
  if (node.kind === "leaf")
    return node.paneId === target ? { ...node, content } : node;
  return {
    ...node,
    a: setContentAt(node.a, target, content),
    b: setContentAt(node.b, target, content),
  };
}

/** 트리를 순회하며 특정 content의 paneId만 모은다 (예: 브라우저 패널 정리용). */
function collectByContent(node: Pane, content: PaneKind): string[] {
  if (node.kind === "leaf")
    return node.content === content ? [node.paneId] : [];
  return [...collectByContent(node.a, content), ...collectByContent(node.b, content)];
}

/** 영속 데이터 마이그레이션 — content 없는 구버전 리프를 terminal로 채운다. */
function migrateLeafContent(node: Pane): Pane {
  if (node.kind === "leaf")
    return { ...node, content: node.content ?? "terminal" };
  return { ...node, a: migrateLeafContent(node.a), b: migrateLeafContent(node.b) };
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

export { collectByContent, collectPanes };

interface TerminalsState {
  terminals: TermTab[];
  /** 프로젝트별 활성 탭 ("viewer" 또는 tabId) */
  activeTab: Record<string, string>;
  paneStatus: Record<string, PaneStatus>;
  /** 새 터미널 탭(단일 리프)을 연다 — 신규 pane을 바로 다루도록 paneId까지 반환 */
  openTerminal: (projectId: string) => { tabId: string; paneId: string };
  closeTab: (tabId: string) => void;
  closeProjectTerminals: (projectId: string) => void;
  setActiveTab: (projectId: string, tab: string) => void;
  /** DB 탐색기 탭이 열린 프로젝트들 */
  dbProjects: string[];
  openDbTab: (projectId: string) => void;
  closeDbTab: (projectId: string) => void;
  splitPane: (
    tabId: string,
    paneId: string,
    dir: SplitDir,
    newFirst: boolean,
    content?: PaneKind,
  ) => void;
  /** 활성 패널을 기준으로 탭 레이아웃을 N개(2/4/8) 터미널 그리드로 한 번에 구성 */
  splitGrid: (tabId: string, paneId: string, count: number) => void;
  /** 패널을 트리에서 떼어 별도 OS 창으로 띄운다(PTY 유지 — 새 창이 term_attach로 이어받음) */
  floatPane: (tabId: string, paneId: string) => void;
  closePane: (tabId: string, paneId: string) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  toggleMaximize: (tabId: string, paneId: string) => void;
  setRatio: (tabId: string, splitId: string, ratio: number) => void;
  setPaneStatus: (paneId: string, status: PaneStatus) => void;
  /** 리프 패널의 내용을 터미널↔브라우저로 전환 */
  setPaneContent: (tabId: string, paneId: string, content: PaneKind) => void;
  /** 분할 divider 드래그 중 여부 — 브라우저 웹뷰 jank 차단용(전이 상태) */
  draggingSplit: boolean;
  setDraggingSplit: (v: boolean) => void;
}

// 터미널 탭 구성을 localStorage에 영속화한다 — 앱 재시작 시 같은 탭/분할 레이아웃으로
// 복구한다. PTY는 재시작 시 죽으므로 스크롤백·실행 중 프로세스는 복구하지 못하고,
// 탭/레이아웃/제목만 되살려 새 셸을 같은 모양으로 다시 띄운다.
const PERSIST_KEY = "gp:terminals";
interface PersistedTerminals {
  terminals: TermTab[];
  activeTab: Record<string, string>;
  dbProjects: string[];
}
function loadPersistedTerminals(): PersistedTerminals {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PersistedTerminals>;
      const terminals = Array.isArray(p.terminals) ? p.terminals : [];
      return {
        // 구버전 레이아웃(content 없는 리프)을 terminal로 마이그레이션
        terminals: terminals.map((t) => ({
          ...t,
          layout: migrateLeafContent(t.layout),
        })),
        activeTab:
          p.activeTab && typeof p.activeTab === "object" ? p.activeTab : {},
        dbProjects: Array.isArray(p.dbProjects) ? p.dbProjects : [],
      };
    }
  } catch {
    /* 손상된 데이터는 빈 상태로 무시 */
  }
  return { terminals: [], activeTab: {}, dbProjects: [] };
}

const persisted = IS_FLOAT
  ? { terminals: [], activeTab: {}, dbProjects: [] }
  : loadPersistedTerminals();

export const useTerminals = create<TerminalsState>((set, get) => ({
  terminals: persisted.terminals,
  activeTab: persisted.activeTab,
  paneStatus: {},
  dbProjects: persisted.dbProjects,
  draggingSplit: false,
  setDraggingSplit: (v) => set({ draggingSplit: v }),

  openDbTab: (projectId) =>
    set((s) => ({
      dbProjects: s.dbProjects.includes(projectId)
        ? s.dbProjects
        : [...s.dbProjects, projectId],
      activeTab: { ...s.activeTab, [projectId]: "db" },
    })),

  closeDbTab: (projectId) =>
    set((s) => ({
      dbProjects: s.dbProjects.filter((p) => p !== projectId),
      activeTab: {
        ...s.activeTab,
        [projectId]:
          s.activeTab[projectId] === "db" ? "viewer" : s.activeTab[projectId],
      },
    })),

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
          layout: { kind: "leaf", paneId, content: "terminal" },
          activePaneId: paneId,
          maximizedPaneId: null,
        },
      ],
      activeTab: { ...s.activeTab, [projectId]: tabId },
      paneStatus: { ...s.paneStatus, [paneId]: "live" },
    }));
    return { tabId, paneId };
  },

  closeTab: (tabId) => {
    const tab = get().terminals.find((t) => t.id === tabId);
    if (tab) collectPanes(tab.layout).forEach((p) => disposeTerminal(p));
    set((s) => {
      const activeTab = { ...s.activeTab };
      if (tab && activeTab[tab.projectId] === tabId) {
        // 활성 터미널 탭을 닫으면 왼쪽(이전) 터미널 탭으로 순차 포커스 이동한다 — 없으면 오른쪽
        // 이웃, 남은 터미널이 없으면 viewer로. (s.terminals는 아직 닫는 탭을 포함한 상태)
        const sibs = s.terminals.filter((t) => t.projectId === tab.projectId);
        const idx = sibs.findIndex((t) => t.id === tabId);
        const next = sibs[idx - 1] ?? sibs[idx + 1] ?? null;
        activeTab[tab.projectId] = next ? next.id : "viewer";
      }
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

  splitPane: (tabId, paneId, dir, newFirst, content = "terminal") => {
    const newPaneId = crypto.randomUUID();
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === tabId
          ? {
              ...t,
              layout: splitAt(t.layout, paneId, dir, newPaneId, newFirst, content),
              activePaneId: newPaneId,
              maximizedPaneId: null,
            }
          : t,
      ),
      paneStatus: { ...s.paneStatus, [newPaneId]: "live" },
    }));
  },

  splitGrid: (tabId, paneId, count) => {
    const tab = get().terminals.find((t) => t.id === tabId);
    if (!tab) return;
    const cols = count >= 8 ? 4 : 2; // 2→2×1, 4→2×2, 8→4×2
    // 우클릭한 그 패널만 N분할한다. 첫 칸은 기존 터미널(paneId/PTY 유지), 나머지는 새 패널.
    // 대상 리프만 그리드로 교체하므로 탭의 다른 패널은 보존되고, 분할된 칸에서 다시 분할하면
    // 그 칸이 또 N분할된다(중첩).
    const ids = [paneId];
    for (let i = 1; i < count; i++) ids.push(crypto.randomUUID());
    const layout = replaceLeaf(tab.layout, paneId, buildGrid(ids, cols));
    set((s) => {
      const paneStatus = { ...s.paneStatus };
      ids.forEach((id) => {
        paneStatus[id] = "live";
      });
      return {
        terminals: s.terminals.map((t) =>
          t.id === tabId
            ? { ...t, layout, activePaneId: paneId, maximizedPaneId: null }
            : t,
        ),
        paneStatus,
      };
    });
  },

  floatPane: (tabId, paneId) => {
    const tab = get().terminals.find((t) => t.id === tabId);
    if (!tab) return;
    // PTY는 살린 채 메인 창의 xterm만 정리하고 트리에서 패널을 뺀다(closePane과 달리 term_close 안 함).
    detachTerminalKeepPty(paneId);
    const layout = removePane(tab.layout, paneId);
    set((s) => {
      const paneStatus = { ...s.paneStatus };
      delete paneStatus[paneId];
      if (layout === null) {
        // 패널이 이 하나뿐이던 탭 → 탭 제거 + Viewer로 전환
        const activeTab = { ...s.activeTab };
        if (activeTab[tab.projectId] === tabId) activeTab[tab.projectId] = "viewer";
        return {
          terminals: s.terminals.filter((t) => t.id !== tabId),
          activeTab,
          paneStatus,
        };
      }
      const remaining = collectPanes(layout);
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
    // 별도 OS 창을 띄운다 — 새 창이 term_attach로 살아있는 PTY 출력을 이어받는다.
    openFloatingWindow(paneId, tab.projectId);
  },

  setPaneContent: (tabId, paneId, content) =>
    set((s) => ({
      terminals: s.terminals.map((t) =>
        t.id === tabId
          ? { ...t, layout: setContentAt(t.layout, paneId, content) }
          : t,
      ),
    })),

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

// 탭/레이아웃이 바뀔 때마다 localStorage에 저장 — 다음 실행에서 복구한다.
// 플로팅 창에서는 영속화하지 않는다(메인 창과 공유 키를 덮어쓰지 않게).
if (!IS_FLOAT)
  useTerminals.subscribe((s) => {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          terminals: s.terminals,
          activeTab: s.activeTab,
          dbProjects: s.dbProjects,
        }),
      );
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  });
