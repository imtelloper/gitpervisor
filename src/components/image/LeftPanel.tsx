// 이미지 편집기 좌 패널(264px) — 레이어·에셋·히스토리 탭 **프레임만**.
//
// 본문은 태스크 44 가 채운다. 지금은 탭마다 빈 자리 하나씩이고 안내 문구가 없다 —
// "레이어 목록은 아직 없습니다" 류를 넣으면 사용자에게 고장으로 읽힌다(INDEX §10.4
// "없는 기능은 안 보인다"). 44 는 여기 `data-left-tab` 자리에 내용을 마운트하면 된다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.8

import { usePanelWidth } from "../../lib/use-panel-width";
import { useImageEditorUi } from "../../stores/imageEditor";
import { ResizeHandle } from "../common/ResizeHandle";

const TABS = [
  { id: "layers", label: "레이어" },
  { id: "assets", label: "에셋" },
  { id: "history", label: "히스토리" },
] as const;

export function LeftPanel() {
  const tab = useImageEditorUi((s) => s.leftTab);
  const setTab = useImageEditorUi((s) => s.setTab);
  const { width, startResize } = usePanelWidth("gp:ie:left", 264, 200, 420);

  return (
    <div
      style={{ width }}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-r border-edge bg-panel text-xs"
    >
      {/*
        탭 사이 이동에 roving tabindex(방향키)를 **달지 않는다**. 편집기에서 방향키는 선택
        객체의 1px 이동이라, 탭 버튼에 포커스가 남은 채 방향키를 누르면 미세 이동이 조용히
        죽는다. Tab 키로 세 버튼에 모두 닿으므로 키보드 접근은 유지된다.
      */}
      <div
        role="tablist"
        aria-label="좌 패널"
        className="flex shrink-0 border-b border-edge px-2"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`gpv-ie-left-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`gpv-ie-left-body-${t.id}`}
            onClick={() => setTab("left", t.id)}
            className={`flex-1 border-b-2 px-1 py-2 ${
              tab === t.id
                ? "border-accent font-semibold text-accent"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {TABS.map((t) => (
        <div
          key={t.id}
          id={`gpv-ie-left-body-${t.id}`}
          role="tabpanel"
          aria-labelledby={`gpv-ie-left-tab-${t.id}`}
          data-left-tab={t.id}
          hidden={tab !== t.id}
          className="min-h-0 flex-1 overflow-y-auto"
        />
      ))}

      <ResizeHandle onMouseDown={startResize} />
    </div>
  );
}
