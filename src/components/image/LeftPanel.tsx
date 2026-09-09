// 이미지 편집기 좌 패널(264px) — 레이어·에셋·히스토리 탭.
//
// 세 탭은 **항상 마운트**돼 있고 `hidden` 으로만 감춘다. 검색어·필터·접기(레이어)와 칩
// 선택(히스토리)은 패널 로컬 state 라 탭을 옮길 때 언마운트하면 조용히 사라지고, F2 가
// 부르는 `LayerPanelHandle` 도 다른 탭을 보는 동안 null 이 된다.
//
// 에셋 탭 본문은 51 것이다. 여기서는 **참인 문장 하나**만 둔다 — "아직 만들지 않았습니다"
// 류를 적으면 미완성이 기능처럼 보인다(INDEX §10.4 "없는 기능은 안 보인다").
//
// 배경: DOCS/task/42-image-editor-shell.md §3.8 · DOCS/task/44-image-panels.md §3.7

import type { Ref } from "react";
import { Component } from "lucide-react";

import { usePanelWidth } from "../../lib/use-panel-width";
import { useImageEditorUi } from "../../stores/imageEditor";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { LayerPanel, type LayerPanelHandle, type LayerPanelProps } from "./layers/LayerPanel";
import { HistoryPanel, type HistoryPanelProps } from "./panels/HistoryPanel";

const TABS = [
  { id: "layers", label: "레이어" },
  { id: "assets", label: "에셋" },
  { id: "history", label: "히스토리" },
] as const;

export interface LeftPanelProps {
  layers: LayerPanelProps;
  /** 42 액션 맵의 `rename`(F2)이 잡는 손잡이 — e2e 훅 `panel` 도 같은 것을 쓴다. */
  layersRef: Ref<LayerPanelHandle>;
  history: HistoryPanelProps;
}

export function LeftPanel({ layers, layersRef, history }: LeftPanelProps) {
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
          // 스크롤은 각 탭이 자기 목록에서 한다 — 여기서도 스크롤하면 헤더·푸터가 함께 밀린다.
          // display 를 정하는 클래스는 넣지 마라: `hidden` 속성(UA `display:none`)을 이겨서
          // 세 탭이 겹쳐 보인다.
          className="min-h-0 flex-1 overflow-hidden"
        >
          {t.id === "layers" ? (
            <LayerPanel ref={layersRef} {...layers} />
          ) : t.id === "history" ? (
            <HistoryPanel {...history} />
          ) : (
            <EmptyState icon={Component} title="로컬 컴포넌트가 없습니다" />
          )}
        </div>
      ))}

      <ResizeHandle onMouseDown={startResize} />
    </div>
  );
}
