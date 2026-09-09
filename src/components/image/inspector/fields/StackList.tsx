// 채우기·선·효과가 공유하는 스택 목록(시안 ① `채우기`·`선`·`효과` 섹션).
//
// **배열 순서가 곧 렌더 순서다**(39). 그래서 이 컴포넌트는 순서를 건드리는 수단을 주지
// 않는다 — 위아래 이동이 필요하면 호출자가 `render` 안에 넣는다. 여기서 정렬 버튼을 만들면
// 세 섹션이 각자 다른 방향 규칙(위가 앞? 아래가 앞?)을 갖게 된다.
//
// 항목 타입을 `visible` 로 제약하는 이유: 눈 아이콘이 켬/끔을 **보여 줘야** 한다. 상태를
// 모른 채 눈을 항상 같은 모양으로 그리면 숨긴 채우기와 보이는 채우기가 목록에서 구분되지
// 않아, 사용자는 화면에 안 나오는 색을 계속 고치게 된다(37 `Fill`·`Effect` 둘 다 이 필드를 갖는다).
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.4

import type { ReactNode } from "react";
import { Eye, EyeOff, Minus, Plus, Settings2 } from "lucide-react";

export interface StackListProps<T extends { visible: boolean }> {
  title: string;
  items: readonly T[];
  /** 행의 가운데 — 스와치·이름·불투명도 등 섹션마다 다른 부분은 호출자가 그린다. */
  render(item: T, i: number): ReactNode;
  onAdd(): void;
  onToggle(i: number): void;
  onRemove(i: number): void;
  /**
   * 있으면 행에 `설정` 버튼이 생긴다. 앵커는 눌린 그 버튼 요소를 **이벤트에서 바로** 넘긴다 —
   * ref 배열로 들면 항목이 지워질 때 인덱스가 밀려 팝오버가 남의 행에 붙는다.
   */
  onOpen?(i: number, anchor: HTMLElement): void;
}

export function StackList<T extends { visible: boolean }>({
  title,
  items,
  render,
  onAdd,
  onToggle,
  onRemove,
  onOpen,
}: StackListProps<T>) {
  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">{title}</span>
        <button
          type="button"
          onClick={onAdd}
          title={`${title} 추가`}
          className="text-fg-dim hover:text-fg"
        >
          <Plus size={13} />
        </button>
      </div>

      {items.map((item, i) => (
        <div
          key={i}
          className={`flex h-7 items-center gap-1.5 ${item.visible ? "" : "opacity-50"}`}
        >
          <div className="min-w-0 flex-1">{render(item, i)}</div>

          {onOpen && (
            <button
              type="button"
              onClick={(e) => onOpen(i, e.currentTarget)}
              title="설정"
              className="shrink-0 text-fg-dim hover:text-fg"
            >
              <Settings2 size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onToggle(i)}
            title={item.visible ? "숨기기" : "표시"}
            className="shrink-0 text-fg-dim hover:text-fg"
          >
            {item.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            type="button"
            onClick={() => onRemove(i)}
            title="제거"
            className="shrink-0 text-fg-dim hover:text-fg"
          >
            <Minus size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}
