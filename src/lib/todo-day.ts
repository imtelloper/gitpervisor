// 할 일 패널의 "그 날 목록" 계산(DOCS/memo-todo-category-image-design.md §5) — UI·IPC 와 떼어 둔 순수 함수.
//
// 저장된 시각은 RFC3339 UTC 라 날짜를 그대로 자르면 KST 에서 자정~09시 완료가 전날로 간다.
// 비교는 전부 **로컬 날짜 키**("YYYY-MM-DD")로 한다. 키는 사전순 = 날짜순이라 문자열 비교로 충분하다.

import type { Todo } from "./ipc";

const pad2 = (n: number) => String(n).padStart(2, "0");

export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 키를 UTC 자정으로 옮겨 계산한다 — UTC 에는 DST 가 없어 하루가 언제나 86400000ms 다.
function dayKeyToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function shiftDayKey(day: string, delta: number): string {
  const t = new Date(dayKeyToUtcMs(day));
  t.setUTCDate(t.getUTCDate() + delta);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function todosForDay(
  todos: Todo[],
  day: string,
  today: string,
): { open: Todo[]; done: Todo[] } {
  if (day > today) return { open: [], done: [] };
  const done = todos
    .filter((t) => t.doneAt !== undefined && localDayKey(new Date(t.doneAt)) === day)
    .sort((a, b) => Date.parse(a.doneAt ?? "") - Date.parse(b.doneAt ?? ""));
  const open = day === today ? todos.filter((t) => t.doneAt === undefined) : [];
  return { open, done };
}

/** 만든 날 = 0. 시계가 뒤로 간 경우(만든 날이 미래)도 0. */
export function todoDaysOpen(todo: Todo, today: string): number {
  const created = localDayKey(new Date(todo.createdAt));
  return Math.max(0, Math.round((dayKeyToUtcMs(today) - dayKeyToUtcMs(created)) / 86_400_000));
}

// dev 전용 노출(E2E) — 자정 경계는 실제 시계로 못 재니 합성 데이터로 부른다(71 스위트). release 미포함.
if (import.meta.env.DEV) {
  (window as unknown as { __gpvTodoDay?: unknown }).__gpvTodoDay = {
    localDayKey,
    todosForDay,
    todoDaysOpen,
    shiftDayKey,
  };
}
