import { Plus, StickyNote, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { registerDraftFlush } from "../../lib/drafts";
import { relativeTime } from "../../lib/format";
import {
  useAddMemo,
  useDeleteMemo,
  useNotes,
  useUpdateMemo,
} from "../../queries";

function memoTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim());
  return first?.trim().slice(0, 60) || "새 메모";
}

interface MemoPanelProps {
  /** 메모가 묶이는 키 — 프로젝트 id 또는 GLOBAL_NOTES_ID */
  scopeId: string;
  /** 목록 헤더에 보일 이름(프로젝트명 또는 "전역 메모") */
  scopeLabel: string;
  /** 닫기 버튼(X) 클릭 */
  onClose: () => void;
  /** 부모가 닫기 직전에 호출할 flush 함수를 심어 준다(빈 메모 정리 + 미저장분 즉시 저장). */
  flushRef?: React.RefObject<(() => void) | null>;
}

/**
 * 메모 목록(좌) + 편집기(우) 패널 — scopeId만 갈아끼우면 프로젝트 메모/전역 메모 어느 쪽에도 쓴다.
 *
 * 크기·테두리·배경·그림자는 **부모(모달/팝오버)가 갖는다**. 같은 UI가 820x560 모달과
 * 720x420 팝오버 두 껍데기에 들어가야 해서, 여기서 크기를 정하면 한쪽이 반드시 깨진다.
 * Esc·바깥 클릭 닫기도 껍데기마다 달라 부모 몫이다.
 */
export function MemoPanel({
  scopeId,
  scopeLabel,
  onClose,
  flushRef,
}: MemoPanelProps) {
  const { data: notes } = useNotes();

  const addMemo = useAddMemo();
  const updateMemo = useUpdateMemo();
  const deleteMemo = useDeleteMemo();

  // 생성 시각 내림차순(새 메모가 위) — 편집 중 재정렬 없이 안정적
  const memos = useMemo(() => {
    const list = notes?.[scopeId] ?? [];
    return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [notes, scopeId]);

  // 마지막으로 보던 메모를 스코프별로 기억한다 — 전역/프로젝트가 서로를 덮지 않게 키를 나눈다.
  const activeKey = `gp:memo-active:${scopeId}`;
  const [activeId, setActiveId] = useState<string | null>(() =>
    localStorage.getItem(activeKey),
  );
  const active = memos.find((m) => m.id === activeId) ?? memos[0] ?? null;

  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const taRef = useRef<HTMLTextAreaElement>(null);
  // 지금 편집기의 text가 **어느 메모의 것인가**. 낙관적 추가(onMutate)는 마이크로태스크라
  // "새 메모" 직후의 동기 렌더에서는 active가 아직 직전 메모다 — 그 상태로 디바운스가 발화하면
  // 직전 메모 본문이 ""로 덮여 사라진다. 소유자가 일치할 때만 저장해 그 창을 닫는다.
  //
  // (예전엔 "한 번 건너뛰기" 플래그였는데, 그 플래그는 [text] 이펙트가 실제로 다시 돌아야만
  //  소비된다. 새 메모를 만들 때 text가 이미 ""면 이펙트가 안 돌아 플래그가 남고, 그다음 진짜
  //  입력 — 붙여넣기처럼 input 이벤트 한 번으로 끝나는 편집 — 이 통째로 저장을 건너뛰었다.)
  const textOwner = useRef<string | null>(null);

  // 스코프가 바뀌면 그 스코프가 마지막에 보던 메모로 갈아끼운다 — 이전 스코프의 memoId가 남으면
  // 첫 렌더에서 엉뚱한 메모를 가리킨다.
  useEffect(() => {
    setActiveId(localStorage.getItem(activeKey));
  }, [activeKey]);

  // active 메모가 바뀌면 본문 로드. 기억은 activeId가 아니라 **실효 active.id**로 — 아무것도
  // 고르지 않고 첫 메모를 보다 닫은 경우도 그 메모로 복원된다.
  useEffect(() => {
    setText(active?.text ?? "");
    textOwner.current = active?.id ?? null;
    if (active?.id) localStorage.setItem(activeKey, active.id);
  }, [active?.id]);

  // 디바운스 자동 저장 — 방금 불러온 그대로(text === active.text)면 쓸 것이 없고,
  // 소유자가 다르면 아직 화면의 active가 따라오지 않은 과도기다(위 textOwner 주석).
  useEffect(() => {
    if (!active || textOwner.current !== active.id || text === active.text) return;
    const t = setTimeout(() => {
      updateMemo.mutate({ projectId: scopeId, memoId: active.id, text });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // 부모가 닫기 직전에 부를 수 있도록 최신 flush를 심어 둔다(deps 없음 = 매 렌더 갱신).
  // **언마운트 정리에서 flush하면 안 된다** — 이 앱은 React.StrictMode라 개발 모드에서 마운트가
  // 즉시 한 번 버려지고, 그때 아직 비어 있는 새 메모가 "빈 메모 정리"에 걸려 지워진다.
  // 그래서 정리 시점이 아니라 부모의 명시적 호출로만 flush한다.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  });

  // health 경보(warn↑) 때도 같은 flush를 돌린다 — OS가 메모리 부족으로 앱을 죽이면 500ms
  // 디바운스에 걸려 있던 본문이 통째로 날아간다(2026-09-02 NTS, lib/drafts.ts).
  // 등록은 마운트 때 한 번이고, 최신 flush는 ref로 따라간다(매 렌더 재등록 방지).
  const flushLatest = useRef(flush);
  flushLatest.current = flush;
  useEffect(() => registerDraftFlush(() => flushLatest.current()), []);

  // 빈 메모는 떠날 때 정리, 변경분은 즉시 저장.
  // 소유자 불일치(= 새 메모 추가 직후 캐시가 아직 안 따라온 과도기)에는 손대지 않는다 —
  // 그 순간 active는 직전 메모라, 빈 본문으로 flush하면 그 메모가 삭제된다.
  function flush() {
    if (!active || textOwner.current !== active.id) return;
    const t = textRef.current;
    if (t.trim() === "")
      deleteMemo.mutate({ projectId: scopeId, memoId: active.id });
    else if (t !== active.text)
      updateMemo.mutate({ projectId: scopeId, memoId: active.id, text: t });
  }
  function selectMemo(id: string) {
    flush();
    setActiveId(id);
  }
  function handleAdd() {
    flush();
    const id = crypto.randomUUID();
    addMemo.mutate({ projectId: scopeId, memoId: id });
    setActiveId(id);
    // 본문의 소유자를 **새 메모**로 먼저 옮긴다 — 낙관적 추가가 반영되기 전 렌더에서 active는
    // 아직 직전 메모라, 이게 없으면 빈 본문이 직전 메모에 저장된다(위 textOwner 주석).
    textOwner.current = id;
    setText("");
    setTimeout(() => taRef.current?.focus(), 0);
  }
  function handleDelete() {
    if (!active) return;
    const idx = memos.findIndex((m) => m.id === active.id);
    deleteMemo.mutate({ projectId: scopeId, memoId: active.id });
    const next = memos[idx + 1] ?? memos[idx - 1] ?? null;
    setActiveId(next?.id ?? null);
  }

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* 좌: 메모 목록 */}
      <div className="flex w-[240px] shrink-0 flex-col border-r border-edge">
        <div className="flex items-center gap-1.5 border-b border-edge px-3 py-2.5">
          <StickyNote size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
            {scopeLabel}
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
            onClick={onClose}
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
  );
}
