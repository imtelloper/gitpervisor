import { create } from "zustand";

import { errorMessage, ipc, type SearchOpts, type SearchResult } from "../lib/ipc";

// Find in Files 상태 — 하단 결과 패널. seq 토큰으로 스테일 응답을 드롭한다(재검색 연타 시
// 이전 요청의 늦은 응답이 최신 결과를 덮지 못하게). 패널 높이는 localStorage 영속.

const HEIGHT_KEY = "gp:search-height";
function initHeight(): number {
  const raw = Number(localStorage.getItem(HEIGHT_KEY));
  return raw >= 120 ? raw : 240;
}

interface SearchState {
  open: boolean;
  height: number;
  query: string;
  opts: SearchOpts;
  result: SearchResult | null;
  searching: boolean;
  error: string | null;
  seq: number;
  setOpen: (open: boolean) => void;
  setHeight: (h: number) => void;
  setQuery: (q: string) => void;
  setOpts: (patch: Partial<SearchOpts>) => void;
  run: (projectId: string) => void;
  cancel: () => void;
}

export const useSearch = create<SearchState>((set, get) => ({
  open: false,
  height: initHeight(),
  query: "",
  opts: { regex: false, caseSensitive: false, wholeWord: false, include: [] },
  result: null,
  searching: false,
  error: null,
  seq: 0,

  setOpen: (open) => set({ open }),
  setHeight: (h) => {
    const v = Math.max(120, Math.min(h, window.innerHeight - 200));
    localStorage.setItem(HEIGHT_KEY, String(v));
    set({ height: v });
  },
  setQuery: (query) => set({ query }),
  setOpts: (patch) => set((s) => ({ opts: { ...s.opts, ...patch } })),

  run: (projectId) => {
    const { query, opts } = get();
    const q = query.trim();
    if (q.length < 2) {
      set({ result: null, error: null, searching: false });
      return;
    }
    const seq = get().seq + 1;
    set({ seq, searching: true, error: null });
    void ipc
      .searchInProject(projectId, q, opts)
      .then((result) => {
        if (get().seq !== seq) return; // 더 최신 검색이 있음 — 폐기
        set({ result, searching: false, error: null });
      })
      .catch((e) => {
        if (get().seq !== seq) return;
        set({ result: null, searching: false, error: errorMessage(e) });
      });
  },
  cancel: () => set((s) => ({ seq: s.seq + 1, searching: false })),
}));
