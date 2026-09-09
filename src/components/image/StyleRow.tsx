// 인스펙터 섹션에 붙는 스타일 링크 한 줄 — 시안 ① `스타일 · 경고/핑크`.
//
// 45(채우기·선·효과)와 50(텍스트)이 각자 자기 섹션에 마운트한다. 한 줄짜리를 파일로 뺀 이유는
// 모양이 아니라 **판정이 하나여야** 해서다: 링크 상태(`none`/`linked`/`stale`/`missing`)를 섹션마다
// 다시 계산하면 채우기에서는 '갱신 가능'이 뜨는데 텍스트에서는 안 뜨는 식으로 갈라진다.
//
// **선택이 한 목소리가 아니면 아무것도 그리지 않는다.** 노드마다 다른 스타일을 물고 있는데
// 대표 하나를 보이면, 그 옆의 분리 버튼이 사용자가 보지도 않은 링크까지 끊는다.
//
// `stale` 은 "내가 노드를 직접 고쳤거나 '스타일 갱신'을 undo 했다"는 뜻이라 되돌릴 방법이
// 있고(`갱신 가능`), `missing` 은 "라이브러리에서 지워졌다"라 되돌릴 값 자체가 없다 — 그래서
// 두 상태를 절대 같은 배지로 묶지 않는다(51 §3.3).
//
// 배경: DOCS/task/51-image-styles-components.md §3.3·§3.8

import { Unlink } from "lucide-react";

import { styleSection, styleState, type StyleSlot } from "../../lib/annotate/styles";
import type { Node, StyleId } from "../../lib/annotate/types";
import { useImageLibrary } from "../../stores/imageLibrary";

export interface StyleRowProps {
  slot: StyleSlot;
  /** 지금 선택된 노드들. 비었거나 링크가 갈리면 이 줄은 통째로 사라진다. */
  nodes: readonly Node[];
  /** 링크만 끊는다(값 유지). 커밋은 호출자가 한 칸으로 묶는다. */
  onDetach(): void;
  /** `갱신 가능` — 이 노드들만 라이브러리 값으로 되돌린다. `stale` 일 때만 보인다. */
  onResync(): void;
}

export function StyleRow({ slot, nodes, onDetach, onResync }: StyleRowProps) {
  const lib = useImageLibrary((s) => s.lib);

  let id: StyleId | undefined;
  for (const n of nodes) {
    const ref = n.styleRefs[slot];
    if (!ref) return null;
    if (id === undefined) id = ref;
    else if (id !== ref) return null;
  }
  if (!id) return null;

  // 하나라도 라이브러리에 없으면 `missing` 이 이긴다 — 없는 것을 '갱신 가능'으로 보이면
  // 눌러도 아무 일이 없다. 나머지는 하나라도 값이 어긋나면 `stale`.
  const states = nodes.map((n) => styleState(n, slot, lib));
  const missing = states.includes("missing");
  const stale = !missing && states.includes("stale");

  const list =
    slot === "text" ? lib.textStyles : slot === "effect" ? lib.effectStyles : lib.colorStyles;
  const name = list.find((s) => s.id === id)?.name ?? null;

  return (
    <div className="mt-1 flex items-center gap-1.5 text-[11px]">
      <span className="shrink-0 text-[10px] text-fg-dim">스타일</span>
      <span
        title={name ?? undefined}
        className={`min-w-0 flex-1 truncate ${missing ? "text-fg-dim" : "text-fg-muted"}`}
      >
        {/* 이름은 라이브러리에만 있다 — 지워진 스타일은 부를 이름이 없어 상태를 그대로 적는다.
            재동기(51 §3.7)가 곧 링크를 끊으므로 이 표시는 스쳐 지나간다. */}
        {name === null ? "없는 스타일" : styleSection(name).display}
      </span>
      {stale && (
        <button
          type="button"
          onClick={onResync}
          title="라이브러리 값으로 되돌립니다"
          className="shrink-0 rounded bg-accent/15 px-1 text-[9px] text-accent hover:bg-accent/25"
        >
          갱신 가능
        </button>
      )}
      <button
        type="button"
        onClick={onDetach}
        title="스타일 연결 해제 (값은 그대로 남습니다)"
        aria-label="스타일 연결 해제"
        className="shrink-0 text-fg-dim hover:text-fg"
      >
        <Unlink size={11} />
      </button>
    </div>
  );
}
