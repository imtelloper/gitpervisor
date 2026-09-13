import {
  Languages,
  Maximize2,
  Minimize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { useEffect } from "react";

import { collectPanes } from "../../lib/pane-tree";
import { translateRequest } from "../../lib/translate";
import { useUi, VIEWER_MAX_PANES } from "../../stores/ui";
import { MenuItem } from "./TerminalPane";
import { modLabel } from "../../lib/platform";

/**
 * 뷰어 패널 우클릭 메뉴 — 터미널 pane 메뉴(`TerminalPane.tsx`의 PaneMenu)와 같은 모양·같은
 * 단축키 힌트. 항목만 뷰어용이다(분할/최대화/닫기 + 선택이 있으면 번역).
 *
 * Monaco가 우클릭을 먹지 않는 이유: 뷰어 리프가 `DiffViewer`에 `suppressContextMenu`를 줘서
 * 본문 우클릭이 이 메뉴로 온다(설계 §3.5). 그래서 Monaco 메뉴에 있던 "선택 영역 번역"
 * (태스크 61)을 여기서 대신 낸다 — 선택은 호출부가 메뉴를 여는 순간 잡아 넘긴다.
 */
export function ViewerPaneMenu({
  paneId,
  x,
  y,
  selection,
  onClose,
}: {
  paneId: string;
  x: number;
  y: number;
  /** 메뉴가 열린 순간의 Monaco 선택. 비어 있으면 번역 항목 자체가 없다(비활성 아님). */
  selection: string;
  onClose: () => void;
}) {
  const layout = useUi((s) => s.viewerLayout);
  const maximized = useUi((s) => s.viewerMaximizedPaneId === paneId);
  const split = useUi((s) => s.splitViewerPane);
  const closePane = useUi((s) => s.closeViewerPane);
  const toggleMaximize = useUi((s) => s.toggleViewerMaximize);
  const openTranslate = useUi((s) => s.openTranslate);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const count = collectPanes(layout).length;
  const full = count >= VIEWER_MAX_PANES; // 상한 도달 — 분할 항목 비활성
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="fixed z-50 min-w-52 rounded-md border border-edge bg-panel py-1 text-[13px] shadow-xl"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        // 하단 클램프 = 메뉴 실높이. 항목 6 × 31.5 + 구분선 8.67 + 패딩·테두리 9.3 ≈ 207 → 216.
        // (TerminalPane PaneMenu와 같은 방식 — 항목이 늘면 이 상수도 같이 올린다.)
        // 번역 항목은 선택이 있을 때만 붙는다 — 그때는 한 줄 + 구분선만큼(≈40) 더 잡는다.
        top: Math.max(0, Math.min(y, window.innerHeight - (selection ? 256 : 216))),
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {selection && (
        <>
          <MenuItem
            icon={<Languages size={14} />}
            label="선택 영역 번역"
            onClick={run(() => openTranslate(translateRequest(selection, x, y)))}
          />
          <div className="my-1 border-t border-edge" />
        </>
      )}
      {/* 상한(VIEWER_MAX_PANES)에서는 분할 항목을 비활성으로 보인다 — Monaco는 인스턴스당
          비용이 크다. pointer-events-none이라 title 툴팁은 안 뜬다(그래서 달지 않는다). */}
      <div className={full ? "pointer-events-none opacity-40" : ""}>
        <MenuItem
          icon={<SplitSquareHorizontal size={14} />}
          label="오른쪽으로 분할"
          hint={`${modLabel}+Shift+D`}
          onClick={run(() => split(paneId, "row", false))}
        />
        <MenuItem
          icon={<SplitSquareHorizontal size={14} />}
          label="왼쪽으로 분할"
          onClick={run(() => split(paneId, "row", true))}
        />
        <MenuItem
          icon={<SplitSquareVertical size={14} />}
          label="아래로 분할"
          hint={`${modLabel}+Shift+E`}
          onClick={run(() => split(paneId, "col", false))}
        />
        <MenuItem
          icon={<SplitSquareVertical size={14} />}
          label="위로 분할"
          onClick={run(() => split(paneId, "col", true))}
        />
      </div>
      <div className="my-1 border-t border-edge" />
      <MenuItem
        icon={maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        label={maximized ? "패널 최대화 해제" : "패널 최대화"}
        onClick={run(() => toggleMaximize(paneId))}
      />
      {/* 마지막 한 칸이면 닫기 항목 자체가 없다(뷰어가 통째로 비지 않게). */}
      {count > 1 && (
        <MenuItem
          icon={<X size={14} />}
          label="패널 닫기"
          hint={`${modLabel}+Shift+W`}
          danger
          onClick={run(() => closePane(paneId))}
        />
      )}
    </div>
  );
}
