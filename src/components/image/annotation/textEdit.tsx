// 텍스트 편집 — 확정 규칙과 캔버스 위에 겹치는 textarea 오버레이(설계 §5.5).
//
// 상자도 글꼴도 **여기서 계산하지 않는다**. `textEditBox`/`textCss`(태스크 49)는 캔버스 쪽
// `setupTextCtx` 와 같은 파일에 나란히 있어서, 속성을 하나 늘리면 두 열을 함께 고치게 된다.
// 그 짝을 여기서 끊고 한쪽만 손보면 편집을 시작하는 순간 글자가 튄다 — 옛 half-leading
// 근사가 정확히 그 회귀였다(Segoe UI 5px, 폰트마다 다른 양으로).

import { useEffect, useRef } from "react";

import { textCss, textEditBox } from "../../../lib/annotate/text-layout";
import {
  DEFAULT_STROKE,
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
    // 즉시 포커스한다. 캔버스 클릭이 편집기 루트로 포커스를 뺏어가는 문제는 이쪽이 아니라
    // **캔버스의 mousedown 기본 동작을 막아서** 푼다(AnnotationLayer 의 onMouseDown) — 편집 중에는
    // 포커스가 textarea 의 것이기 때문이다. 여기서 한 프레임 미루는 우회는 실패했다:
    // rAF(~16ms)가 pointerup/click 보다 먼저라, 잡은 포커스를 제스처 후반이 다시 뺏어갔다.
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, [editing]);

  if (!editing) return null;
  // textarea 는 transform 안쪽 형제라 레이아웃 px(줌 이전)를 써야 한다 — 줌을 되나눈다.
  const ds = displayScale / Math.max(zoom ?? 1, 1e-6);
  // 확정 전 글자로 잰다 — 줄이 늘거나 상자가 자라는 게 타이핑과 같은 프레임에 보여야 한다.
  const box = textEditBox(editing.obj, editing.text, ds);
  // 글자색은 채우기 첫 겹(37 §3.3) — 캔버스 확정 렌더와 같은 값이어야 편집 중/후가 안 튄다.
  const color = textColorOf(editing.obj);
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
        // 글꼴·행간·자간·정렬·줄바꿈 규칙은 통째로 DOM 열에서 온다. 여기서 하나라도
        // 덮어쓰면 캔버스 열(setupTextCtx)과 갈라진다.
        ...textCss(editing.obj, ds),
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        color,
        caretColor: color,
        // 이미지 회전으로 rot 이 붙은 텍스트도 캔버스와 같은 방향·자리에 뜨게 한다(§5.5).
        // 피벗은 textEditBox 가 준다 — 앵커가 곧 상자 좌상단이라 지금은 0,0 이지만,
        // 그 계산이 바뀌면 여기가 아니라 그쪽 한 곳만 고치면 된다.
        transformOrigin: `${box.originX}px ${box.originY}px`,
        transform: `rotate(${box.rot}deg)`,
      }}
    />
  );
}
