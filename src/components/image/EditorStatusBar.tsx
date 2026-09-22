// 편집기 하단 상태바(30px) — 커서 좌표·색, 보기 토글 5, 선택 요약, 줌, 되돌리기 깊이, 모드 힌트.
//
// **커서 좌표와 색은 React state 를 타지 않는다.** `AnnotationLayer` 가 rAF 당 1회
// `setCursor` 를 부르는데, state 로 받으면 마우스를 움직이는 동안 초당 60회 리렌더가 상태바를
// 넘어 편집기 전체로 번진다. 그래서 ref 로 잡은 `<span>` 의 `textContent` 를 직접 쓴다 —
// 같은 이유로 `AnnotationLayer` 도 호버 커서를 `canvas.style.cursor` 로 직접 바꾼다(K4).
//
// 나머지 값(토글·선택·힌트)은 사람이 누를 때만 바뀌므로 평범하게 스토어를 구독한다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.7

import { forwardRef, useImperativeHandle, useRef } from "react";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import type { Rect } from "../../lib/annotate/types";
import { useImageEditorUi, type EditorUiState } from "../../stores/imageEditor";

export interface StatusBarHandle {
  /** 오리엔트 좌표와 그 픽셀 색(`#RRGGBB`). 캔버스 밖이면 셋 다 `null`. */
  setCursor(x: number | null, y: number | null, rgb: string | null): void;
}

/** 상태바에 노출하는 보기 토글 — 나머지 토글(스냅 세부·그리드 간격 등)은 인스펙터 몫이다(45). */
function viewToggles(msg: Messages): {
  k: "snap" | "smartGuides" | "pixelGrid" | "rulers" | "guidesVisible";
  label: string;
}[] {
  const t = msg.imageEditor.statusBar;
  return [
    { k: "snap", label: t.snap },
    { k: "smartGuides", label: t.smartGuides },
    { k: "pixelGrid", label: t.pixelGrid },
    { k: "rulers", label: t.rulers },
    { k: "guidesVisible", label: t.guidesVisible },
  ];
}

export interface EditorStatusBarProps {
  /** 화면 배율(100 = 원본 1:1). `screenScale * 100` 을 부모가 넘긴다. */
  zoomPercent: number;
  /** 되돌릴 수 있는 커밋 수(41 `history.cursor`). */
  undoDepth: number;
  /** 선택 바운딩 박스(38 `selectBox().rect`) — 계산은 씬을 든 부모가 한다. */
  selectBox: Rect | null;
}

const selectToggles = (s: EditorUiState) => s.toggles;
const selectSetToggle = (s: EditorUiState) => s.setToggle;
const selectCount = (s: EditorUiState) => s.selectedIds.length;
const selectHint = (s: EditorUiState) => s.hint;

const EditorStatusBar = forwardRef<StatusBarHandle, EditorStatusBarProps>(
  function EditorStatusBar({ zoomPercent, undoDepth, selectBox }, ref) {
    const msg = useMessages();
    const toggles = useImageEditorUi(selectToggles);
    const setToggle = useImageEditorUi(selectSetToggle);
    const count = useImageEditorUi(selectCount);
    const hint = useImageEditorUi(selectHint);

    const coordRef = useRef<HTMLSpanElement>(null);
    const hexRef = useRef<HTMLSpanElement>(null);
    const swatchRef = useRef<HTMLSpanElement>(null);

    useImperativeHandle(
      ref,
      (): StatusBarHandle => ({
        setCursor(x, y, rgb) {
          // 반올림은 여기서 한다 — 소수점을 그대로 그리면 글자 폭이 매 프레임 요동친다.
          if (coordRef.current) {
            coordRef.current.textContent =
              x === null || y === null ? "" : `X ${Math.round(x)}  Y ${Math.round(y)}`;
          }
          if (hexRef.current) hexRef.current.textContent = rgb ?? "";
          // 색 없음일 때도 칸은 남긴다(투명) — 지웠다 그리면 옆 항목들이 매 프레임 밀린다.
          if (swatchRef.current) {
            swatchRef.current.style.background = rgb ?? "transparent";
          }
        },
      }),
      [],
    );

    return (
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-t border-edge bg-panel px-3 text-[11px] text-fg-dim">
        {/* 두 칸 띄운 `X … Y …` 를 그대로 유지해야 하므로 whitespace-pre. 폭 고정은 좌표가
            한 자리씩 늘 때 오른쪽 전체가 흔들리지 않게 한다. */}
        <span ref={coordRef} className="w-[112px] shrink-0 whitespace-pre tabular-nums" />

        {viewToggles(msg).map((t) => (
          <button
            key={t.k}
            aria-pressed={toggles[t.k]}
            onClick={() => setToggle(t.k, !toggles[t.k])}
            className={`shrink-0 rounded px-1.5 py-0.5 hover:bg-raised ${
              toggles[t.k] ? "bg-accent/15 text-accent" : "text-fg-dim hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}

        {hint && <span className="truncate text-fg-muted">{hint}</span>}

        <div className="flex-1" />

        {count > 0 && (
          <>
            {/* `N개 선택` 은 **자기 span 안에 홀로** 있어야 한다 — e2e 30 selCount 가
                `^\s*(\d+)개 선택` 을 담은 가장 안쪽 요소를 찾는다. 옆 텍스트를 같은 노드에
                붙이면 크기·색까지 삼킨 문자열이 잡혀 개수 단언이 엉뚱한 값을 본다. */}
            <span className="shrink-0 tabular-nums">
              {msg.imageEditor.contextBar.selectedCount(count)}
            </span>
            {selectBox && (
              <span className="shrink-0 tabular-nums">
                {Math.round(selectBox.w)} × {Math.round(selectBox.h)}
              </span>
            )}
          </>
        )}

        <span className="flex shrink-0 items-center gap-1">
          <span ref={swatchRef} className="h-2.5 w-2.5 rounded-sm border border-edge" />
          <span ref={hexRef} className="w-[60px] font-mono" />
        </span>

        <span className="shrink-0 tabular-nums">{Math.round(zoomPercent)}%</span>
        <span className="shrink-0 tabular-nums">
          {msg.imageEditor.statusBar.undoDepth(undoDepth)}
        </span>
      </div>
    );
  },
);

export default EditorStatusBar;
