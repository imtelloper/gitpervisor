import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { fuzzyMatch } from "../../lib/fuzzy";
import { ipc } from "../../lib/ipc";
import { useStatuses } from "../../queries";
import { useUi } from "../../stores/ui";
import { QuickPick, type QuickPickItem } from "../common/QuickPick";

interface FileEntry {
  path: string; // 저장소 루트 기준 경로(열기용)
  repoId: string; // 저장소 id(outer 또는 합성)
  display: string; // outer 기준 표시 경로
  base: string; // 파일명(basename)
  hint?: string; // 임베디드 배지
}
type Pick = { path: string; repoId: string; isOuter: boolean };

/**
 * Quick Open 어댑터 — mod+P로 여는 파일 퍼지 검색. 저장소 파일 목록(outer + 임베디드)을
 * 배치로 받아 프론트 퍼지 랭킹으로 좁히고, 선택 시 selectDiff로 뷰어 탭에 연다.
 * QuickPick 프리미티브(09 정의)에 파일 소스를 주입하는 얇은 호스트.
 */
export function QuickOpenHost() {
  const open = useUi((s) => s.quickOpenOpen);
  const setOpen = useUi((s) => s.setQuickOpenOpen);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const aggregateOpen = useUi((s) => s.aggregateOpen);
  const selectDiff = useUi((s) => s.selectDiff);
  const viewerTabs = useUi((s) => s.viewerTabs);
  const { data: statuses } = useStatuses();

  // 선택 프로젝트의 임베디드(중첩) 저장소 — 합성 id + relPath
  const embedded = useMemo(
    () => (statuses ?? []).filter((s) => s.parentId === selectedProjectId && s.relPath),
    [statuses, selectedProjectId],
  );
  const sortedIds = useMemo(() => {
    if (!selectedProjectId) return [];
    return [selectedProjectId, ...embedded.map((s) => s.projectId)].sort();
  }, [selectedProjectId, embedded]);

  const { data: lists } = useQuery({
    queryKey: ["repo-files", ...sortedIds],
    queryFn: () => ipc.listRepoFiles(sortedIds),
    enabled: open && sortedIds.length > 0,
    staleTime: 30_000,
  });

  // 평탄 파일 목록(outer + 임베디드 표시경로 부착)
  const flat = useMemo<FileEntry[]>(() => {
    if (!lists) return [];
    const relById = new Map(embedded.map((s) => [s.projectId, s.relPath!]));
    const out: FileEntry[] = [];
    for (const l of lists) {
      if (l.error) continue;
      const rel = l.projectId === selectedProjectId ? null : relById.get(l.projectId);
      for (const f of l.files) {
        out.push({
          path: f,
          repoId: l.projectId,
          display: rel ? `${rel}/${f}` : f,
          base: f.split("/").pop() ?? f,
          hint: rel ? `⊂ ${rel}` : undefined,
        });
      }
    }
    return out;
  }, [lists, embedded, selectedProjectId]);

  // 최근 연 파일 가중(뒤일수록 최근 → 큰 값)
  const recentRank = useMemo(() => {
    const m = new Map<string, number>();
    const tabs = viewerTabs.filter(
      (t) => t.outerId === selectedProjectId && t.target.mode === "file",
    );
    tabs.forEach((t, i) => m.set(t.target.path, tabs.length - i));
    return m;
  }, [viewerTabs, selectedProjectId]);

  const truncated = useMemo(() => (lists ?? []).some((l) => l.truncated), [lists]);

  const toItem = useCallback(
    (f: FileEntry, highlights?: number[]): QuickPickItem<Pick> => ({
      id: `${f.repoId}:${f.path}`,
      label: f.base,
      labelHighlights: highlights,
      description: f.display,
      hint: f.hint,
      data: { path: f.path, repoId: f.repoId, isOuter: f.repoId === selectedProjectId },
    }),
    [selectedProjectId],
  );

  const source = useCallback(
    (query: string): QuickPickItem<Pick>[] => {
      const q = query.trim();
      if (q === "") {
        // 최근 파일 우선 + 나머지 앞부분
        const seen = new Set<string>();
        const items: QuickPickItem<Pick>[] = [];
        const recents = flat
          .filter((f) => recentRank.has(f.path))
          .sort((a, b) => recentRank.get(b.path)! - recentRank.get(a.path)!);
        for (const f of recents) {
          items.push(toItem(f));
          seen.add(f.repoId + f.path);
          if (items.length >= 100) return items;
        }
        for (const f of flat) {
          if (seen.has(f.repoId + f.path)) continue;
          items.push(toItem(f));
          if (items.length >= 100) break;
        }
        return items;
      }
      const scored: { f: FileEntry; score: number; hl?: number[] }[] = [];
      for (const f of flat) {
        const base = fuzzyMatch(q, f.base);
        let score: number;
        let hl: number[] | undefined;
        if (base) {
          score = base.score + 25; // basename 매치 강한 우대
          hl = base.positions;
        } else {
          const full = fuzzyMatch(q, f.display);
          if (!full) continue;
          score = full.score; // 경로 세그먼트 매치(라벨 하이라이트는 생략)
        }
        score += (recentRank.get(f.path) ?? 0) * 2;
        scored.push({ f, score, hl });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 100).map(({ f, hl }) => toItem(f, hl));
    },
    [flat, recentRank, toItem],
  );

  const onPick = useCallback(
    (item: QuickPickItem<Pick>) => {
      selectDiff(
        { mode: "file", path: item.data.path },
        item.data.isOuter ? undefined : item.data.repoId,
      );
      setOpen(false);
    },
    [selectDiff, setOpen],
  );

  if (!open || !selectedProjectId || aggregateOpen) return null;

  return (
    <QuickPick
      placeholder="파일 이름으로 검색…"
      source={source}
      onPick={onPick}
      onClose={() => setOpen(false)}
      emptyText={lists ? "일치하는 파일 없음" : "파일 목록 불러오는 중…"}
      footer={
        truncated ? "일부만 표시 — 더 입력해 좁히세요(50,000개 초과)" : undefined
      }
    />
  );
}
