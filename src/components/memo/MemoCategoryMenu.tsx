import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { MEMO_CATEGORY_MAX_CHARS } from "../../lib/ipc";

interface MemoCategoryMenuProps {
  /** 이 스코프의 카테고리(이름순) — 메모에 붙은 이름에서 도출된 목록이라 빈 카테고리는 없다. */
  categories: { name: string; count: number }[];
  colorOf: (name: string) => string | undefined;
  /** 지금 메모의 카테고리(없으면 미분류) */
  current: string | undefined;
  /** 이 메모에 지정. null = 미분류 */
  onAssign: (name: string | null) => void;
  /** 그 이름의 메모 전부를 새 이름으로. null = 카테고리 해제(메모는 남는다) */
  onRename: (from: string, to: string | null) => void;
  onClose: () => void;
}

/**
 * 메모 편집기 헤더의 카테고리 메뉴 — 지정·새로 만들기·이름 바꾸기·해제를 한 곳에서 한다.
 *
 * 패널 안 absolute 로 뜬다(부모가 relative 래퍼를 준다). 새 fixed 레이어를 만들지 않는 이유: 전역 메모
 * 팝오버는 투명 백드롭 클릭으로 닫히는데(GlobalMemoPopover), 그 위에 층을 하나 더 얹으면 메뉴 밖 클릭이
 * 어느 층에 먹히는지에 따라 팝오버까지 닫힌다. 바깥 클릭 닫기는 부모가 래퍼 기준으로 판정한다.
 */
export function MemoCategoryMenu({
  categories,
  colorOf,
  current,
  onAssign,
  onRename,
  onClose,
}: MemoCategoryMenuProps) {
  const msg = useMessages();
  const t = msg.notes.memoPanel;
  const [renaming, setRenaming] = useState<string | null>(null);

  /** 입력칸 공통 — Enter 는 한글 조합 확정이면 넘기고, Esc 는 이 입력만 취소한다. */
  function onInputKey(
    e: React.KeyboardEvent<HTMLInputElement>,
    commit: (value: string) => void,
    cancel: () => void,
  ) {
    if (e.key === "Enter") {
      // 한글 조합을 확정하는 Enter 가 "추가"로 새면 마지막 글자가 빠진 이름이 만들어진다.
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      commit(e.currentTarget.value.trim());
    } else if (e.key === "Escape") {
      // 껍데기(팝오버·모달)의 창 단위 Esc 닫기가 defaultPrevented 를 보지 않는다 — 전파를 끊어야
      // 입력 취소가 메모장 닫기로 번지지 않는다.
      e.stopPropagation();
      cancel();
    }
  }

  return (
    <div
      data-memo-category-menu
      className="absolute right-0 top-full z-20 mt-1 flex max-h-64 w-56 flex-col overflow-y-auto rounded border border-edge bg-panel py-1 text-[12px] shadow-lg"
    >
      <button
        onClick={() => onAssign(null)}
        className="flex items-center gap-2 px-2.5 py-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
      >
        <span className="w-3 shrink-0">{!current && <Check size={12} />}</span>
        {t.categoryNone}
      </button>

      {categories.map((c) =>
        renaming === c.name ? (
          <input
            key={c.name}
            autoFocus
            defaultValue={c.name}
            maxLength={MEMO_CATEGORY_MAX_CHARS}
            onKeyDown={(e) =>
              onInputKey(
                e,
                (value) => {
                  if (value && value !== c.name) onRename(c.name, value);
                  setRenaming(null);
                },
                () => setRenaming(null),
              )
            }
            onBlur={() => setRenaming(null)}
            className="mx-2 my-1 rounded border border-accent bg-base px-1.5 py-1 text-fg outline-none"
          />
        ) : (
          <div key={c.name} className="group flex items-center hover:bg-raised">
            <button
              onClick={() => onAssign(c.name)}
              data-memo-category-option={c.name}
              className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-fg"
            >
              <span className="w-3 shrink-0">{current === c.name && <Check size={12} />}</span>
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: colorOf(c.name) }}
              />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="shrink-0 text-[11px] text-fg-dim">{c.count}</span>
            </button>
            <button
              onClick={() => setRenaming(c.name)}
              title={t.categoryRenameTitle}
              className="invisible shrink-0 rounded p-1 text-fg-dim hover:text-fg group-hover:visible"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => onRename(c.name, null)}
              title={t.categoryRemoveTitle}
              className="invisible mr-1 shrink-0 rounded p-1 text-fg-dim hover:text-danger group-hover:visible"
            >
              <X size={12} />
            </button>
          </div>
        ),
      )}

      <input
        data-memo-category-new
        placeholder={t.categoryNewPlaceholder}
        maxLength={MEMO_CATEGORY_MAX_CHARS}
        onKeyDown={(e) =>
          onInputKey(
            e,
            (value) => {
              if (value) onAssign(value);
            },
            onClose,
          )
        }
        className="mx-2 mb-1 mt-1.5 rounded border border-edge bg-base px-1.5 py-1 text-fg outline-none placeholder:text-fg-dim focus:border-accent"
      />
    </div>
  );
}
