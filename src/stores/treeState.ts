// 파일 트리 펼침 상태 — 프로젝트별로 어떤 폴더를 펼쳐놨는지 기억(전환·재시작 후 복원).
// TreeNode의 로컬 useState를 대체: 프로젝트 전환 시 트리가 리마운트돼도 여기서 복원된다.
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { create } from "zustand";

const KEY = "gp:tree-expanded";
const IS_FLOAT = (() => {
  try {
    return getCurrentWebviewWindow().label.startsWith("float-");
  } catch {
    return false;
  }
})();

/** projectId → 펼쳐진 폴더의 repo-상대 경로 목록. */
type Expanded = Record<string, string[]>;

function load(): Expanded {
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Expanded) : {};
  } catch {
    return {};
  }
}

interface TreeStateStore {
  expanded: Expanded;
  /** 폴더 펼침 토글. */
  toggle: (projectId: string, path: string) => void;
  /** 프로젝트 제거 시 정리. */
  clearProject: (projectId: string) => void;
}

export const useTreeState = create<TreeStateStore>((set) => ({
  expanded: load(),
  toggle: (projectId, path) =>
    set((s) => {
      const cur = s.expanded[projectId] ?? [];
      const next = cur.includes(path)
        ? cur.filter((p) => p !== path)
        : [...cur, path];
      return { expanded: { ...s.expanded, [projectId]: next } };
    }),
  clearProject: (projectId) =>
    set((s) => {
      if (!(projectId in s.expanded)) return s;
      const rest = { ...s.expanded };
      delete rest[projectId];
      return { expanded: rest };
    }),
}));

// 영속 — 상태 변화 시 localStorage에 기록(플로팅 창은 트리가 없어 스킵).
if (!IS_FLOAT)
  useTreeState.subscribe((s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s.expanded));
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  });
