// 키보드 단축키(설계 §5.2·§5.6) — 복제·삭제·z-order·화살표 이동·도구 전환.

import { isGeomNode, translateObject } from "../../../lib/annotate/geometry";
import {
  DUPLICATE_OFFSET,
  newObjId,
  type Node,
  type ObjId,
  type Tool,
} from "../../../lib/annotate/types";
import { useUi } from "../../../stores/ui";
import type { AnnotationLayerProps } from "../AnnotationLayer";
import type { EditState } from "./textEdit";

/** 도구 단축키(§5.2) — 모달 안에서만, 텍스트 입력 중이 아닐 때만 활성. */
const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  p: "pen",
  h: "highlight",
  l: "line",
  a: "arrow",
  r: "rect",
  o: "ellipse",
  t: "text",
  n: "badge",
  m: "mosaic",
};

/** 키 핸들러가 보는 컴포넌트 상태. */
export interface KeyCtx {
  p: React.RefObject<AnnotationLayerProps>;
  editingRef: React.RefObject<EditState | null>;
}

export function createKeyHandler(ctx: KeyCtx): (ev: KeyboardEvent) => void {
  const { p, editingRef } = ctx;
  return (ev: KeyboardEvent) => {
    const s = p.current;
    // 텍스트 편집 중이거나 입력 요소에 포커스가 있으면 단축키를 잡지 않는다(§5.5).
    if (editingRef.current) return;
    const el = document.activeElement as HTMLElement | null;
    if (
      el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable)
    ) {
      return;
    }
    const ui = useUi.getState();
    if (ui.prompt || ui.confirm) return;

    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();

    if (mod && key === "d") {
      if (!s.selectedIds.length) return;
      const copies: Node[] = [];
      for (const o of s.objects) {
        if (!s.selectedIds.includes(o.id)) continue;
        // 컨테이너는 기하가 없다 — 그룹 복제는 태스크 38(tree.translateSubtree)이 붙인다.
        copies.push(
          isGeomNode(o)
            ? { ...translateObject(o, DUPLICATE_OFFSET, DUPLICATE_OFFSET), id: newObjId() }
            : { ...o, id: newObjId() },
        );
      }
      if (!copies.length) return;
      ev.preventDefault();
      s.onCommit([...s.objects, ...copies]);
      s.onSelectionChange(copies.map((o) => o.id));
      return;
    }
    if (mod) return;

    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (!s.selectedIds.length) return;
      ev.preventDefault();
      s.onCommit(s.objects.filter((o) => !s.selectedIds.includes(o.id)));
      s.onSelectionChange([]);
      return;
    }
    if (ev.key === "[" || ev.key === "]") {
      if (!s.selectedIds.length) return;
      ev.preventDefault();
      s.onCommit(reorder(s.objects, s.selectedIds, ev.key === "]" ? 1 : -1));
      return;
    }
    if (ev.key.startsWith("Arrow")) {
      if (!s.selectedIds.length) return;
      // auto-repeat 를 받으면 초당 ~30 커밋이라 HISTORY_LIMIT(50)이 1.7초에 소진돼
      // **이전 히스토리가 통째로 날아간다**. 탭 전용으로 둔다(설계 K5).
      // ponytail: 누르고 있는 동안 이어서 움직이려면 라이브 커밋 경로를 뚫어야 한다(+20줄).
      if (ev.repeat) {
        ev.preventDefault();
        return;
      }
      const step = ev.shiftKey ? 10 : 1;
      const dx =
        ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
      const dy =
        ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
      if (!dx && !dy) return;
      ev.preventDefault();
      const ids = new Set(s.selectedIds);
      s.onCommit(
        s.objects.map((o) =>
          ids.has(o.id) && isGeomNode(o) ? translateObject(o, dx, dy) : o,
        ),
      );
      return;
    }
    const t = TOOL_KEYS[key];
    if (t && !ev.altKey) {
      ev.preventDefault();
      s.onToolChange(t);
    }
  };
}

/** z-order 한 칸 이동(`[` 뒤로, `]` 앞으로). */
function reorder(
  objects: readonly Node[],
  ids: readonly ObjId[],
  dir: 1 | -1,
): Node[] {
  const next = objects.slice();
  // 앞으로 보낼 때는 뒤에서부터, 뒤로 보낼 때는 앞에서부터 옮겨야 서로 자리를 뺏지 않는다.
  const order =
    dir === 1
      ? next.map((_, i) => i).reverse()
      : next.map((_, i) => i);
  for (const i of order) {
    const o = next[i];
    if (!o || !ids.includes(o.id)) continue;
    const j = i + dir;
    if (j < 0 || j >= next.length) continue;
    if (ids.includes(next[j].id)) continue;
    next[i] = next[j];
    next[j] = o;
  }
  return next;
}
