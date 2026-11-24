import { ChevronLeft, ChevronRight, ListChecks, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useMessages, useUiLanguage } from "../../i18n/ui-language";
import type { Todo } from "../../lib/ipc";
import { localDayKey, shiftDayKey, todoDaysOpen, todosForDay } from "../../lib/todo-day";
import {
  useAddTodo,
  useDeleteTodo,
  useSetTodoDone,
  useTodos,
  useUpdateTodoText,
} from "../../queries";

/**
 * 할 일 패널(DOCS/memo-todo-category-image-design.md §5) — 전역 메모 팝오버의 두 번째 탭.
 * MemoPanel 과 같이 크기·Esc·바깥 클릭 닫기는 껍데기(GlobalMemoPopover) 몫이다.
 */
export function TodoPanel({
  headerLead,
  onClose,
}: {
  /** 헤더 왼쪽 자리 — 팝오버가 탭 버튼을 꽂는다. 없으면 아이콘+이름. */
  headerLead?: React.ReactNode;
  onClose: () => void;
}) {
  const msg = useMessages();
  const t = msg.notes.todoPanel;
  const locale = useUiLanguage((s) => s.locale);
  const { data: todos } = useTodos();
  const addTodo = useAddTodo();
  const updateText = useUpdateTodoText();
  const setDone = useSetTodoDone();
  const deleteTodo = useDeleteTodo();

  // 열린 채 자정을 넘기면 "오늘"이 바뀌어야 한다 — 저장된 날짜가 없고 매번 계산하는 구조라 이것만으로 충분하다.
  const [today, setToday] = useState(() => localDayKey(new Date()));
  useEffect(() => {
    const timer = setInterval(() => setToday(localDayKey(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  // null = 오늘 보기. 날짜를 고정해 두면 자정을 넘긴 뒤 "오늘" 보기가 어제에 머문다.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay ?? today;
  const isToday = day === today;
  function moveDay(delta: number) {
    const next = shiftDayKey(day, delta);
    setPickedDay(next >= today ? null : next);
    setEditingId(null);
  }

  const { open, done } = useMemo(
    () => todosForDay(todos ?? [], day, today),
    [todos, day, today],
  );

  const dayLabel = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    const weekday = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(y, m - 1, d)));
    const date = day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day;
    return `${date} (${weekday})`;
  }, [day, today, locale]);

  const [draft, setDraft] = useState("");
  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    addTodo.mutate({ todoId: crypto.randomUUID(), text });
    setDraft("");
  }

  // 한 번에 한 항목만 고친다. ref 는 Enter/Esc 뒤 언마운트가 일으키는 blur 가 두 번 저장하지 않게 막는다.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editingRef = useRef<string | null>(null);
  function startEdit(todo: Todo) {
    editingRef.current = todo.id;
    setEditingId(todo.id);
    setEditText(todo.text);
  }
  function endEdit(todo: Todo, save: boolean) {
    if (editingRef.current !== todo.id) return;
    editingRef.current = null;
    setEditingId(null);
    if (!save) return;
    const text = editText.trim();
    if (!text) deleteTodo.mutate({ todoId: todo.id });
    else if (text !== todo.text) updateText.mutate({ todoId: todo.id, text });
  }

  const renderRow = (todo: Todo) => {
    const isDone = todo.doneAt !== undefined;
    const days = isDone ? 0 : todoDaysOpen(todo, today);
    return (
      <div
        key={todo.id}
        data-todo-id={todo.id}
        className="group flex items-center gap-2 px-4 py-1.5 hover:bg-raised"
      >
        <input
          type="checkbox"
          checked={isDone}
          onChange={(e) => setDone.mutate({ todoId: todo.id, done: e.target.checked })}
          title={t.toggleDoneTitle}
          className="shrink-0 accent-accent"
        />
        {editingId === todo.id ? (
          <input
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // 팝오버의 창 단위 Esc 닫기는 defaultPrevented 를 보지 않는다 — 여기서 끊지 않으면
                // 수정 취소가 팝오버까지 닫는다. React 루트에서 멈추므로 window 리스너에 닿지 않는다.
                e.stopPropagation();
                if (!e.nativeEvent.isComposing) endEdit(todo, false);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                endEdit(todo, true);
              }
            }}
            onBlur={() => endEdit(todo, true)}
            autoFocus
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-edge bg-transparent px-1.5 py-0.5 text-[13px] text-fg outline-none focus:border-accent"
          />
        ) : (
          <span
            onClick={isToday ? () => startEdit(todo) : undefined}
            title={isToday ? t.editTitle : undefined}
            className={`min-w-0 flex-1 truncate text-[13px] ${
              isDone ? "text-fg-dim line-through" : "text-fg"
            } ${isToday ? "cursor-text" : ""}`}
          >
            {todo.text}
          </span>
        )}
        {/* 만든 날이 1일째다 — 어제 만든 항목은 오늘 "2일째". */}
        {days > 0 && (
          <span className="shrink-0 text-[11px] text-fg-dim">{t.daysOpen(days + 1)}</span>
        )}
        {isToday && editingId !== todo.id && (
          <button
            onClick={() => deleteTodo.mutate({ todoId: todo.id })}
            title={t.deleteTitle}
            className="invisible shrink-0 rounded p-0.5 text-fg-dim hover:text-danger group-hover:visible"
          >
            <X size={13} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {headerLead ?? (
            <>
              <ListChecks size={14} className="shrink-0 text-accent" />
              <span className="truncate text-[13px] font-semibold">{t.title}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => moveDay(-1)}
            title={t.prevDayTitle}
            className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <ChevronLeft size={14} />
          </button>
          <span data-todo-day={day} className="min-w-[96px] text-center text-[12px] text-fg-muted">
            {dayLabel}
            {isToday && <span className="text-accent"> · {t.today}</span>}
          </span>
          <button
            onClick={() => moveDay(1)}
            disabled={isToday}
            title={t.nextDayTitle}
            className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <span title={t.progressTitle} className="text-[11px] text-fg-dim">
            {done.length}/{open.length + done.length}
          </span>
          <button
            onClick={onClose}
            title={t.closeTitle}
            className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {isToday && (
          <div className="mx-3 mb-2 flex items-center gap-1.5 rounded border border-edge px-2 py-1 focus-within:border-accent">
            <Plus size={13} className="shrink-0 text-fg-dim" />
            <input
              data-todo-add
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitDraft();
                // 지울 게 있을 때만 Esc 를 먹는다 — 빈 칸의 Esc 는 평소처럼 팝오버를 닫는다.
                else if (e.key === "Escape" && draft !== "") {
                  e.stopPropagation();
                  if (!e.nativeEvent.isComposing) setDraft("");
                }
              }}
              placeholder={t.addPlaceholder}
              spellCheck={false}
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-dim"
            />
          </div>
        )}
        {open.map(renderRow)}
        {done.length > 0 && (
          <div className="mx-3 my-1.5 flex items-center gap-2 text-[11px] text-fg-dim">
            <span className="h-px w-3 bg-edge" />
            {t.doneSection(done.length)}
            <span className="h-px flex-1 bg-edge" />
          </div>
        )}
        {done.map(renderRow)}
        {open.length === 0 && done.length === 0 && (
          <div className="px-4 py-4 text-[12px] text-fg-dim">
            {isToday ? t.emptyToday : t.emptyPastDay}
          </div>
        )}
      </div>
    </div>
  );
}
