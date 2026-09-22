// 인스펙터 **프레임**(시안 우측 320px) — 탭 4개와 푸터의 자리만 만든다.
//
// 내용은 전부 `panes` 로 받는다. 이 컴포넌트가 속성 필드를 알게 되는 순간 45(컨텍스트 바·
// 속성 필드)가 여기를 고쳐야 하고, 통합 단계가 기존 `AnnotationToolbar` 섹션을 그대로 꽂을
// 수 없게 된다.
//
// **네 탭을 전부 마운트하고 비활성만 숨긴다.** 언마운트하면 탭을 오갈 때마다 슬라이더·입력의
// 로컬 state 가 초기화돼, 사용자가 조정하던 값이 탭 한 번 보고 온 사이에 리셋된다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.8

import { useId, type ReactNode } from "react";

import { ResizeHandle } from "../../common/ResizeHandle";
import type { Messages } from "../../../i18n/messages";
import { useMessages } from "../../../i18n/ui-language";
import { usePanelWidth } from "../../../lib/use-panel-width";
import { useImageEditorUi, type EditorUiState } from "../../../stores/imageEditor";

type InspectorTab = EditorUiState["inspectorTab"];

function inspectorTabsFor(msg: Messages): readonly { id: InspectorTab; label: string }[] {
  const t = msg.imageInspector.tabs;
  return [
    { id: "props", label: t.props },
    { id: "text", label: t.text },
    { id: "adjust", label: t.adjust },
    { id: "export", label: t.export },
  ];
}

export function Inspector({
  panes,
  footer,
}: {
  panes: Record<InspectorTab, ReactNode>;
  /** 시안 푸터 `초기화 · 복사 · 다른 이름으로 · 저장 (PNG)` — 버튼은 호출부가 넘긴다. */
  footer?: ReactNode;
}) {
  const msg = useMessages();
  const tabs = inspectorTabsFor(msg);
  const tab = useImageEditorUi((s) => s.inspectorTab);
  const setTab = useImageEditorUi((s) => s.setTab);
  const { width, startResize } = usePanelWidth("gp:ie-right", 320, 260, 480, "left");
  // 메인 창과 doc 창이 각자 인스펙터를 들고, e2e 가 두 편집기를 한 문서에 띄울 수도 있다 —
  // 고정 id 면 aria 연결이 남의 탭을 가리킨다.
  const uid = useId();

  return (
    <aside
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-l border-edge bg-panel text-[13px]"
    >
      <ResizeHandle onMouseDown={startResize} side="left" />

      {/* 방향키를 가로채지 않는다 — 편집기에서 방향키는 선택 객체의 1px 미세 이동이다. */}
      <div role="tablist" className="flex h-9 shrink-0 items-center gap-1 border-b border-edge px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`${uid}-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`${uid}-${t.id}-panel`}
            onClick={() => setTab("inspector", t.id)}
            className={`border-b-2 px-2 py-1 text-xs ${
              tab === t.id
                ? "border-accent text-fg"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tabs.map((t) => (
        <div
          key={t.id}
          id={`${uid}-${t.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${uid}-${t.id}`}
          // e2e 40 이 이 속성으로 패널을 집는다(`id` 는 `useId` 라 창마다 달라 못 쓴다).
          data-inspector-tab={t.id}
          hidden={tab !== t.id}
          className={tab === t.id ? "flex-1 overflow-y-auto p-3" : "hidden"}
        >
          {panes[t.id]}
        </div>
      ))}

      {footer && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 border-t border-edge px-3 py-2">
          {footer}
        </div>
      )}
    </aside>
  );
}
