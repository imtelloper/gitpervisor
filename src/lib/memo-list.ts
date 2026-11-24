// 메모 목록의 표시 순서·필터 — 화면에 보일 목록만 만든다. **정본(notes.json 의 배열 순서)은 건드리지 않는다**:
// 배열 순서가 곧 사용자가 드래그로 정한 순서라, 정렬 결과를 저장하면 그 순서를 잃는다
// (DOCS/memo-todo-category-image-design.md §4).

import type { Memo } from "./ipc";

export type MemoSort = "manual" | "updated" | "created" | "title";
export const MEMO_SORTS: readonly MemoSort[] = ["manual", "updated", "created", "title"];

export type MemoCategoryFilter =
  | { kind: "all" }
  | { kind: "uncategorized" }
  | { kind: "category"; name: string };

/** 메모 제목 = 본문의 첫 비어 있지 않은 줄(60자까지). 없으면 `untitled`. */
export function memoTitle(text: string, untitled: string): string {
  const first = text.split("\n").find((l) => l.trim());
  return first?.trim().slice(0, 60) || untitled;
}

/** 저장해 둔 정렬 값 읽기 — 모르는 값(옛 버전·손상)은 수동으로. */
export function parseMemoSort(raw: string | null): MemoSort {
  return MEMO_SORTS.find((s) => s === raw) ?? "manual";
}

/**
 * 필터 ↔ `<select>` 값. 카테고리 이름은 자유 문자열이라 "all"·"none" 같은 예약어와 겹칠 수 있다 —
 * 카테고리에는 접두어를 붙여 가른다. localStorage 에도 이 문자열 그대로 저장한다.
 */
export function memoFilterValue(f: MemoCategoryFilter): string {
  if (f.kind === "all") return "all";
  if (f.kind === "uncategorized") return "none";
  return `c:${f.name}`;
}
export function parseMemoFilter(raw: string | null): MemoCategoryFilter {
  if (raw === "none") return { kind: "uncategorized" };
  if (raw?.startsWith("c:") && raw.length > 2) return { kind: "category", name: raw.slice(2) };
  return { kind: "all" };
}

/** 한 스코프의 카테고리 목록(이름순)과 메모 수 — 메모에 붙은 이름에서 도출한다(카테고리 테이블이 없다). */
export function memoCategories(memos: Memo[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of memos) {
    if (m.category) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

function matchesMemoFilter(m: Memo, f: MemoCategoryFilter): boolean {
  if (f.kind === "all") return true;
  if (f.kind === "uncategorized") return !m.category;
  return m.category === f.name;
}

// 저장 시각은 백엔드(chrono, "+00:00")와 낙관적 캐시(toISOString, "Z")가 다른 꼴이라 문자열 비교가 아니라 시각으로 본다.
const timeOf = (iso: string) => Date.parse(iso) || 0;

/**
 * 화면에 보일 메모 목록.
 * - `memos` 는 **수동 순서**(정본 배열의 역순 — 새 메모가 위)로 받는다. "manual" 은 그 순서 그대로다.
 * - `keepId` 는 필터에 안 맞아도 남길 메모(활성 메모)다. 치던 메모가 필터나 카테고리 변경으로 목록에서
 *   사라지면 다른 메모로 넘어가면서 마지막 입력이 저장 없이 버려진다.
 * - 정렬은 안정이라 같은 값끼리는 수동 순서를 따른다.
 */
export function visibleMemos(
  memos: Memo[],
  opts: { sort: MemoSort; filter: MemoCategoryFilter; keepId?: string | null },
): Memo[] {
  const shown = memos.filter((m) => m.id === opts.keepId || matchesMemoFilter(m, opts.filter));
  switch (opts.sort) {
    case "manual":
      return shown;
    case "updated":
      return shown.sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
    case "created":
      return shown.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
    case "title":
      return shown.sort((a, b) =>
        memoTitle(a.text, "").localeCompare(memoTitle(b.text, ""), "ko"),
      );
    default: {
      const unreachable: never = opts.sort;
      return unreachable;
    }
  }
}
