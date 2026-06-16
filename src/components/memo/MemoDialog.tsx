import { Plus, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { relativeTime } from "../../lib/format";
import {
  useAddMemo,
  useDeleteMemo,
  useNotes,
  useProjects,
  useUpdateMemo,
} from "../../queries";
import { useUi } from "../../stores/ui";

function memoTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim());
  return first?.trim().slice(0, 60) || "새 메모";
}

/** 프로젝트별 메모 — 큰 모달(좌: 메모 목록 / 우: 편집기). 여러 메모 지원. */
export function MemoDialog() {
  const open = useUi((s) => s.memoOpen);
  const setOpen = useUi((s) => s.setMemoOpen);
  const projectId = useUi((s) => s.selectedProjectId);
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId) ?? null;
  const { data: notes } = useNotes();

  const addMemo = useAddMemo();
  const updateMemo = useUpdateMemo();
  const deleteMemo = useDeleteMemo();

  // 생성 시각 내림차순(새 메모가 위) — 편집 중 재정렬 없이 안정적
  const memos = useMemo(() => {
    const list = (projectId && notes?.[projectId]) || [];
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [notes, projectId]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const active = memos.find((m) => m.id === activeId) ?? memos[0] ?? null;

  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const skipSave = useRef(true);

  // active 메모가 바뀌면 본문 로드
  useEffect(() => {
    setText(active?.text ?? "");
    skipSave.current = true;
  }, [active?.id]);

  // 디바운스 자동 저장
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (!active || !projectId || text === active.text) return;
    const t = setTimeout(() => {
      updateMemo.mutate({ projectId, memoId: active.id, text });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Esc 닫기
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, projectId]);

  if (!open || !project || !projectId) return null;

  // 빈 메모는 떠날 때 정리, 변경분은 즉시 저장
  function flush() {
    if (!active || !projectId) return;
    const t = textRef.current;
    if (t.trim() === "") deleteMemo.mutate({ projectId, memoId: active.id });
    else if (t !== active.text)
      updateMemo.mutate({ projectId, memoId: active.id, text: t });
  }
  function selectMemo(id: string) {
    flush();
    setActiveId(id);
  }
  function handleAdd() {
    flush();
    const id = crypto.randomUUID();
    addMemo.mutate({ projectId: projectId!, memoId: id });
    setActiveId(id);
    setText("");
    setTimeout(() => taRef.current?.focus(), 0);
  }
  function handleDelete() {
    if (!active) return;
    const idx = memos.findIndex((m) => m.id === active.id);
    deleteMemo.mutate({ projectId: projectId!, memoId: active.id });
    const next = memos[idx + 1] ?? memos[idx - 1] ?? null;
    setActiveId(next?.id ?? null);
  }
  function close() {
    flush();
    setOpen(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={close}
    >
      <div
        className="flex h-[560px] w-[820px] overflow-hidden rounded-lg border border-edge bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 좌: 메모 목록 */}
        <div className="flex w-[240px] shrink-0 flex-col border-r border-edge">
          <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2.5">
            <StickyNote size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {project.name}
            </span>
            <span className="text-[11px] text-fg-dim">{memos.length}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {memos.map((m) => (
              <button
                key={m.id}
                onClick={() => selectMemo(m.id)}
                className={`block w-full border-b border-edge/40 px-3 py-2 text-left ${
                  active?.id === m.id ? "bg-selection" : "hover:bg-raised"
                }`}
              >
                <div className="truncate text-[13px] text-fg">
                  {memoTitle(m.text)}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-fg-dim">
                  {relativeTime(new Date(m.updatedAt).getTime())}
                </div>
              </button>
            ))}
            {memos.length === 0 && (
              <div className="px-3 py-4 text-[12px] leading-5 text-fg-dim">
                메모가 없습니다.
                <br />
                아래 버튼으로 추가하세요.
              </div>
            )}
          </div>

          <button
            onClick={handleAdd}
            className="flex items-center gap-1.5 border-t border-edge px-3 py-2.5 text-[13px] text-fg-muted hover:bg-raised hover:text-fg"
          >
            <Plus size={14} /> 새 메모
          </button>
        </div>

        {/* 우: 편집기 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg-dim">
              {active ? memoTitle(active.text) : "메모"}
            </span>
            {active && (
              <button
                onClick={handleDelete}
                title="이 메모 삭제"
                className="rounded p-1 text-fg-dim hover:bg-raised hover:text-danger"
              >
                <Trash2 size={14} />
              </button>
            )}
            <button
              onClick={close}
              title="닫기 (Esc)"
              className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
            >
              <X size={15} />
            </button>
          </div>

          {active ? (
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="메모 작성…"
              spellCheck={false}
              autoFocus
              className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[14px] leading-7 text-fg outline-none placeholder:text-fg-dim"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-fg-dim">
              왼쪽에서 메모를 선택하거나 새로 만드세요
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
