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
  /** 이름 바꾼 폴더(와 그 하위)의 펼침 경로를 새 경로로 이관. */
  renameTo: (projectId: string, from: string, to: string) => void;
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
  // 이름 바꾸기 후 이관 — 안 하면 펼침 상태가 옛 경로에 남아 방금 이름 바꾼 폴더가
  // (하위까지) 접힌 채로 보인다. 자기 자신과 `from/` 접두 하위를 모두 새 경로로 옮긴다.
  renameTo: (projectId, from, to) =>
    set((s) => {
      const cur = s.expanded[projectId];
      if (!cur || cur.length === 0) return s; // 이 프로젝트에 펼침 기록 없음 — 리렌더 방지
      const next = cur.map((p) =>
        p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p,
      );
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
// **읽고-고쳐-쓰기로 이 창이 바꾼 프로젝트만** 쓴다(promptHistory·termThemes와 같은 이유): 모아보기 창의
// 파일 트리 모달도 이 스토어를 쓰는데, 통째로 쓰면 그 창이 열릴 때 읽은 낡은 사본이 그 뒤 메인에서
// 펼치고 접은 다른 프로젝트들을 되돌린다.
if (!IS_FLOAT) {
  let prev = useTreeState.getState().expanded;
  useTreeState.subscribe((s) => {
    if (s.expanded === prev) return;
    const cur = load();
    for (const p of new Set([...Object.keys(prev), ...Object.keys(s.expanded)])) {
      if (s.expanded[p] === prev[p]) continue;
      if (s.expanded[p]) cur[p] = s.expanded[p];
      else delete cur[p];
    }
    prev = s.expanded;
    try {
      localStorage.setItem(KEY, JSON.stringify(cur));
    } catch {
      /* localStorage 불가 환경 무시 */
    }
  });
}
