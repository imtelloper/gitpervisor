// 텍스트 편집 — 확정 규칙과 캔버스 위에 겹치는 textarea 오버레이(설계 §5.5).

import { useEffect, useRef } from "react";

import { layoutText } from "../../../lib/annotate/geometry";
import {
  DEFAULT_STROKE,
  TEXT_LINE_HEIGHT,
  type Node,
  type TextNode,
} from "../../../lib/annotate/types";
import type { AnnotationLayerProps } from "../AnnotationLayer";

/** 텍스트 노드의 글자색 — 채우기 스택의 첫 보이는 단색(37 §3.3 매핑표). */
function textColorOf(o: TextNode): string {
  for (const f of o.fills) {
    if (f.visible && f.type === "solid") return f.color;
  }
  return DEFAULT_STROKE;
}

export interface EditState {
  /** 편집 중인 텍스트 객체(확정 전 값). */
  obj: TextNode;
  /** 새로 만드는 중인가 — 빈 내용으로 끝나면 그냥 버린다. */
  isNew: boolean;
  text: string;
}

/** `finishEditing` 이 만지는 컴포넌트 상태. */
export interface TextEditCtx {
  p: React.RefObject<AnnotationLayerProps>;
  editingRef: React.RefObject<EditState | null>;
  /** blur 와 Esc 가 동시에 확정을 부르는 이중 커밋 방지. */
  editDoneRef: React.RefObject<boolean>;
  setEditing: React.Dispatch<React.SetStateAction<EditState | null>>;
  commitObjects: (next: Node[]) => void;
  schedule: () => void;
}

/** 편집 중이던 텍스트를 확정한다. 내용이 비면 객체를 만들지 않거나 삭제한다(§5.5). */
export function finishEditing(ctx: TextEditCtx): void {
  const { p, editingRef, editDoneRef, setEditing, commitObjects, schedule } =
    ctx;
  const st = editingRef.current;
  if (!st || editDoneRef.current) return;
  editDoneRef.current = true;
  const s = p.current;
  const text = st.text.replace(/\s+$/g, "");
  if (!text.trim()) {
    if (!st.isNew) commitObjects(s.objects.filter((o) => o.id !== st.obj.id));
  } else {
    const obj: TextNode = { ...st.obj, text };
    commitObjects(
      st.isNew
        ? [...s.objects, obj]
        : s.objects.map((o) => (o.id === obj.id ? obj : o)),
    );
  }
  setEditing(null);
  editingRef.current = null;
  schedule();
}

export interface TextEditOverlayProps {
  editing: EditState | null;
  setEditing: React.Dispatch<React.SetStateAction<EditState | null>>;
  onFinish: () => void;
  /** oriented → 화면 css px 배율(맞춤 배율 × 줌). */
  displayScale: number;
  /** 부모가 CSS transform 으로 건 줌 배율(기본 1). */
  zoom?: number;
}

/** 캔버스 위에 겹치는 편집용 textarea(§5.5). */
export function TextEditOverlay({
  editing,
  setEditing,
  onFinish,
  displayScale,
  zoom,
}: TextEditOverlayProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  // textarea 는 transform 안쪽 형제라 레이아웃 px(줌 이전)를 써야 한다 — 줌을 되나눈다.
  const ds = displayScale / Math.max(zoom ?? 1, 1e-6);
  const editBox = editing
    ? (() => {
        const m = layoutText({ ...editing.obj, text: editing.text || " " });
        const fs = editing.obj.fontSize * ds;
        const lh = editing.obj.fontSize * TEXT_LINE_HEIGHT * ds;
        // 캔버스는 textBaseline="top"(em 상단 기준)인데 줄 상자는 half-leading 만큼
        // 글리프를 내린다 — 그 차이를 빼서 편집 중에도 같은 자리에 보이게 한다.
        const halfLeading = (lh - fs) / 2;
        return {
          left: editing.obj.x * ds,
          top: editing.obj.y * ds - halfLeading,
          width: (m.width + editing.obj.fontSize) * ds,
          height: m.height * ds + (lh - fs),
          fontSize: fs,
          lineHeight: `${lh}px`,
          // 이미지 회전으로 rot 이 붙은 텍스트도 캔버스와 같은 방향·자리에 뜨게 한다(§5.5).
          // 피벗은 applyObjectTransform 과 같은 앵커(=obj.x,obj.y)이고, 그 점은 textarea 상자
          // 안에서 (0, half-leading) 이다.
          rot: editing.obj.rot,
          originY: halfLeading,
        };
      })()
    : null;

  if (!editing || !editBox) return null;
  return (
    <textarea
      ref={taRef}
      value={editing.text}
      onChange={(e) =>
        setEditing((st) => (st ? { ...st, text: e.target.value } : st))
      }
      onBlur={onFinish}
      onKeyDown={(e) => {
        // Ctrl+Enter 확정. Esc 는 모달의 Esc 계층이 handleEscape() 로 처리하므로
        // **전파를 막지 않는다** — 막으면 window 리스너까지 못 가 Esc 가 죽는다.
        // 도구 단축키·Ctrl+Z 는 리스너 쪽이 포커스된 입력 요소를 보고 스스로 비켜난다.
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onFinish();
        }
      }}
      spellCheck={false}
      className="absolute m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      style={{
        left: editBox.left,
        top: editBox.top,
        width: editBox.width,
        height: editBox.height,
        fontSize: editBox.fontSize,
        lineHeight: editBox.lineHeight,
        fontFamily: editing.obj.fontFamily,
        // 글자색은 채우기 첫 겹(37 §3.3) — 캔버스 확정 렌더와 같은 값이어야 편집 중/후가 안 튄다.
        color: textColorOf(editing.obj),
        caretColor: textColorOf(editing.obj),
        whiteSpace: "pre",
        transformOrigin: `0px ${editBox.originY}px`,
        transform: `rotate(${editBox.rot}deg)`,
      }}
    />
  );
}
