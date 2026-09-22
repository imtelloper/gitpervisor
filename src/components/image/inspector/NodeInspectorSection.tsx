// 인스펙터 `Sec 노드`(시안 ③ :18219) — 열린 패스 · X/Y · 정점 모드 5 · 핸들 in/out.
//
// 문서를 직접 만지지 않는다. 쓰기는 전부 `api`(= `AnnotationLayerHandle` 의 노드 편집 조각)로
// 나가고, 그 함수는 컨텍스트 바 버튼·단축키가 부르는 것과 **같은 함수**다 — 갈라지면 히스토리
// 라벨이 먼저 어긋난다(`PathInspectorSection` 머리말과 같은 규칙).
//
// **X/Y·핸들은 단일 선택에서만 그린다.** 여럿을 고른 채 절대 좌표를 적으면 그 정점들이 한 점으로
// 뭉치는데, 그건 사용자가 "전부 이 값으로"라고 말해서 얻으려던 결과가 아니다(`NumField` 가
// MIXED 에서 절대값 대신 Δ 를 내보내는 것과 같은 이유). 값이 없는 필드는 `undefined` 로 넘겨
// **필드째 사라지게** 한다 — 빈 칸으로 남기면 "0" 과 구분되지 않는다.
//
// 배경: DOCS/task/47-image-vector-pen-node-edit.md §3.3 · 시안 ③ 인스펙터

import type { ReactNode } from "react";

import { useMessages } from "../../../i18n/ui-language";
import { MIXED, type Maybe } from "../../../lib/annotate/selection";
import type { NodeModeUi } from "../../../lib/annotate/vector/edit";
import type { AnnotationLayerHandle } from "../AnnotationLayer";
import { NODE_MODE_LABELS, type NodeEditState } from "../annotation/nodeEdit";
import { NumField } from "./fields/NumField";
import { Select } from "./fields/Select";

/** 이 섹션이 쓰는 조각만 받는다. */
export type NodeInspectorApi = Pick<
  AnnotationLayerHandle,
  "setNodeMode" | "setVertPos" | "setVertHandle"
>;

// 렌더 때 만든다 — `NODE_MODE_LABELS` 는 게터라 모듈 최상위에서 읽으면 로드 시점 언어로 굳는다.
function nodeModeOptions() {
  return (["none", "corner", "mirrored", "asymmetric", "auto"] as const).map((value) => ({
    value: value as NodeModeUi,
    label: NODE_MODE_LABELS[value],
  }));
}

export function NodeInspectorSection({
  state,
  api,
}: {
  state: NodeEditState;
  api: NodeInspectorApi;
}) {
  const msg = useMessages();
  const anchor = state.anchor;
  // 핸들 값은 `nodeEditState` 가 **정규화된 정점**에서 읽는다 — 문서에는 auto 정점의 핸들이
  // (0,0) 으로 들어 있어서, 문서를 그대로 보여 주면 화면에는 곡선이 휘어 있는데 인스펙터는
  // "핸들 없음"이라고 말한다.
  const hIn = state.handleIn;
  const hOut = state.handleOut;
  const mode: Maybe<NodeModeUi> | null =
    state.mode === null ? null : state.mode === "mixed" ? MIXED : state.mode;

  return (
    <section className="border-b border-edge px-3 py-2">
      <div className="mb-1 flex items-center justify-between text-[11px] text-fg-dim">
        <span>{msg.imageInspector.nodeSection.title}</span>
        {/* 열림/닫힘은 이 섹션에서 **읽기 전용**이다 — 바꾸는 것은 컨텍스트 바의
            `패스 닫기/열기` 하나뿐이라야 같은 조작이 두 곳에서 갈리지 않는다. */}
        <span>
          {state.open ? msg.imageInspector.vocab.openPath : msg.imageInspector.vocab.closedPath}
        </span>
      </div>

      {mode === null ? (
        // 고른 정점이 없으면 편집할 값이 없다. 빈 필드를 늘어놓으면 사용자는 그 칸이 무엇에
        // 적용되는지 모른 채 숫자를 적는다.
        <div className="text-[11px] text-fg-dim">
          {msg.imageInspector.nodeSection.noVertexHint(state.nodeCount, state.segmentCount)}
        </div>
      ) : (
        <>
          <Row label={msg.imageInspector.nodeSection.modeRow}>
            <Select
              label={msg.imageInspector.nodeSection.modeSelect}
              value={mode}
              options={nodeModeOptions()}
              onChange={(v) => api.setNodeMode(v)}
            />
          </Row>

          {/* ponytail: 라벨 스크럽(드래그)은 라이브 갱신 통로가 없어 꺼져 있다 — 매 틱 커밋하면
                        드래그 한 번이 히스토리를 통째로 태운다. 타이핑·방향키는 각각 1칸이다.
                        정점 드래그(포인터)가 붙을 때 같은 라이브 경로를 여기에도 잇는다. */}
          <div className="grid grid-cols-2 gap-x-2">
            <NumField
              label="X"
              value={anchor?.x}
              unit="px"
              onCommit={(v) => api.setVertPos(v, anchor?.y ?? 0)}
            />
            <NumField
              label="Y"
              value={anchor?.y}
              unit="px"
              onCommit={(v) => api.setVertPos(anchor?.x ?? 0, v)}
            />
          </div>

          <div className="mt-2 mb-1 text-[11px] text-fg-dim">
            {msg.imageInspector.nodeSection.handles}
          </div>
          <div className="grid grid-cols-2 gap-x-2">
            <NumField
              label="in X"
              value={hIn?.[0]}
              unit="px"
              onCommit={(v) => api.setVertHandle("in", v, hIn?.[1] ?? 0)}
            />
            <NumField
              label="in Y"
              value={hIn?.[1]}
              unit="px"
              onCommit={(v) => api.setVertHandle("in", hIn?.[0] ?? 0, v)}
            />
            <NumField
              label="out X"
              value={hOut?.[0]}
              unit="px"
              onCommit={(v) => api.setVertHandle("out", v, hOut?.[1] ?? 0)}
            />
            <NumField
              label="out Y"
              value={hOut?.[1]}
              unit="px"
              onCommit={(v) => api.setVertHandle("out", hOut?.[0] ?? 0, v)}
            />
          </div>
        </>
      )}
    </section>
  );
}

/** `Select` 앞의 라벨 열 — `NumField` 의 라벨 폭(`w-11`)에 맞춰야 줄이 어긋나지 않는다. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5">
      <span className="w-11 shrink-0 text-[11px] text-fg-dim">{label}</span>
      {children}
    </div>
  );
}
