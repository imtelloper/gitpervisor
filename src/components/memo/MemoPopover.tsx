import { StickyNote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { relativeTime } from "../../lib/format";
import type { Project } from "../../lib/ipc";
import { useNotes, useSetNote } from "../../queries";

/** 프로젝트 메모 팝오버 — 툴바 버튼 앵커. 자동 저장(디바운스 600ms + 닫을 때 flush). */
export function MemoPopover({
  project,
  anchorRef,
  onClose,
}: {
  project: Project;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const { data: notes } = useNotes();
  const setNote = useSetNote();
  const note = notes?.[project.id];

  const [text, setText] = useState(() => note?.text ?? "");
  const [saved, setSaved] = useState(true);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const firstRef = useRef(true);
  const latest = useRef(text);
  latest.current = text;
  const savedRef = useRef(saved);
  savedRef.current = saved;

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // 입력 멈춤 600ms 후 저장
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    setSaved(false);
    const t = setTimeout(() => {
      setNote.mutate(
        { projectId: project.id, text },
        { onSuccess: () => setSaved(true) },
      );
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // 언마운트 시 미저장분 flush
  useEffect(
    () => () => {
      if (!savedRef.current)
        setNote.mutate({ projectId: project.id, text: latest.current });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 바깥 클릭 / Esc 로 닫기 (앵커=버튼+팝오버 컨테이너는 제외)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node))
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const t = setTimeout(() => {
      window.addEventListener("mousedown", onDown);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  return (
    <div className="absolute right-0 top-full z-50 mt-1.5 w-[340px] overflow-hidden rounded-lg border border-edge bg-panel shadow-xl">
      <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2">
        <StickyNote size={13} className="shrink-0 text-accent" />
        <span className="text-[13px] font-medium">메모</span>
        <span className="min-w-0 truncate text-[11px] text-fg-dim">
          · {project.name}
        </span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          title="닫기"
          className="rounded p-0.5 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="이 프로젝트에 대한 메모…"
        spellCheck={false}
        className="block h-56 w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-6 text-fg outline-none placeholder:text-fg-dim"
      />

      <div className="border-t border-edge px-3 py-1.5 text-[11px] text-fg-dim">
        {!saved ? (
          "저장 중…"
        ) : note ? (
          <>저장됨 · {relativeTime(new Date(note.updatedAt).getTime())}</>
        ) : (
          "자동 저장"
        )}
      </div>
    </div>
  );
}
