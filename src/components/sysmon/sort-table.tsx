// 리소스 모니터 PC 관리 표들의 공통 정렬 — 머리글 클릭으로 열 기준·방향을 바꾸고, 표마다 마지막 정렬을 기억한다.
// 프로세스 탭의 SortHeader(SysMonitorWindow)는 백엔드가 정렬해 주는 내림차순 전용이라 따로 둔다.

import { ChevronDown, ChevronUp } from "lucide-react";
import { useMemo, useState } from "react";

import { useMessages } from "../../i18n/ui-language";

export type SortDir = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;
export interface TableSort<K extends string> {
  key: K;
  dir: SortDir;
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// 값이 없는 행은 방향과 무관하게 항상 맨 뒤 — 내림차순에서 "—"가 위로 올라오면 정렬한 의미가 없다.
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const aNone = a == null || a === "";
  const bNone = b == null || b === "";
  if (aNone || bNone) return aNone === bNone ? 0 : aNone ? 1 : -1;
  const raw =
    typeof a === "string" && typeof b === "string"
      ? COLLATOR.compare(a, b)
      : Number(a) - Number(b);
  return dir === "asc" ? raw : -raw;
}

function storageKey(id: string): string {
  return `gp:sysmon-sort:${id}`;
}

function loadSort<K extends string>(id: string, keys: readonly K[], fallback: TableSort<K>): TableSort<K> {
  try {
    const p = JSON.parse(localStorage.getItem(storageKey(id)) ?? "null") as Partial<TableSort<string>> | null;
    const key = keys.find((k) => k === p?.key);
    if (key && (p?.dir === "asc" || p?.dir === "desc")) return { key, dir: p.dir };
  } catch {
    // 손상된 저장값은 기본 정렬로 — 정렬 기억은 편의 기능이다.
  }
  return fallback;
}

/**
 * `columns`의 값 함수로 행을 정렬한다. 같은 열을 다시 누르면 방향이 바뀌고, 새 열은 글자면 오름차순·
 * 숫자(크기·시각·개수)면 내림차순으로 시작한다 — 큰 것·최근 것을 먼저 보려고 누르는 경우가 대부분이다.
 * 같은 값끼리는 원래 순서를 지킨다(Array.prototype.sort는 안정 정렬).
 */
export function useTableSort<T, K extends string>(
  id: string,
  rows: readonly T[],
  columns: Record<K, (row: T) => SortValue>,
  initial: TableSort<NoInfer<K>>,
) {
  const keys = Object.keys(columns) as K[];
  const [sort, setSort] = useState<TableSort<K>>(() => loadSort(id, keys, initial));

  const sorted = useMemo(() => {
    const value = columns[sort.key];
    return [...rows].sort((a, b) => compareSortValues(value(a), value(b), sort.dir));
    // columns 는 렌더마다 새 객체라 의존성에서 뺀다 — 값 함수는 열 키로 고정이다.
  }, [rows, sort.key, sort.dir]);

  const toggle = (key: K) => {
    setSort((cur) => {
      let dir: SortDir;
      if (cur.key === key) {
        dir = cur.dir === "asc" ? "desc" : "asc";
      } else {
        const sample = rows.map(columns[key]).find((v) => v != null && v !== "");
        dir = typeof sample === "string" ? "asc" : "desc";
      }
      const next = { key, dir };
      try {
        localStorage.setItem(storageKey(id), JSON.stringify(next));
      } catch {
        // 저장 실패(사생활 모드 등)면 이번 창에서만 유지된다.
      }
      return next;
    });
  };

  return { sorted, sort, toggle };
}

/** 머리글 안에 넣는 정렬 버튼 — `<th>`·grid 칸 어느 쪽에도 쓴다. */
export function SortLabel<K extends string>({
  label,
  k,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  k: K;
  sort: TableSort<K>;
  onSort: (k: K) => void;
  align?: "left" | "right";
}) {
  const msg = useMessages();
  const active = sort.key === k;
  const Icon = sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      title={msg.sysmon.window.sortBy(label)}
      className={`inline-flex max-w-full items-center gap-0.5 whitespace-nowrap transition-colors hover:text-fg ${
        align === "right" ? "flex-row-reverse" : ""
      } ${active ? "text-accent" : ""}`}
    >
      <span className="truncate">{label}</span>
      <Icon size={11} className={`shrink-0 ${active ? "" : "invisible"}`} />
    </button>
  );
}
