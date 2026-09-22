// 컨텍스트 바 '벡터 편집' 변형(시안 ③) — 노드 5모드 · 추가/삭제/닫기/열기/반전 · 스냅 2 ·
// 편집 완료 ⏎.
//
// **여기에 기하는 없다.** 버튼은 전부 `api`(= `AnnotationLayerHandle` 의 노드 편집 조각)를
// 부르고, 그 함수들은 단축키 표(42)의 `delete`·`nudge`·`enter` 가 부르는 것과 **같은 함수**다.
// 이 파일이 정점을 직접 만지기 시작하면 같은 조작이 키와 버튼에서 갈라지고, 히스토리 라벨이
// 먼저 어긋난다(`CropContextBar` 머리말과 같은 규칙).
//
// 셸(`role="toolbar"` 한 줄)을 이 파일이 들고 있는 것은 임시다 — `ContextBar` 의
// `case "vector-edit"` 는 45 소유라 이번 태스크가 건드리지 않는다. 그쪽으로 옮길 때는 바깥
// `<div>` 만 벗기면 `CropContextBar` 와 같은 조각(프래그먼트)이 된다.
//
// 배경: DOCS/task/47-image-vector-pen-node-edit.md §3.6 · 시안 ③ 컨텍스트 바
//
// ponytail: 폭이 모자라면 가로 스크롤이다(`ContextBar` 와 같은 처리). 우선순위 접기는 실제로
//           넘치는 창 폭이 확인되면 넣는다.

import type { ReactNode } from "react";
import { PenTool } from "lucide-react";

import { useMessages } from "../../i18n/ui-language";
import { EDITOR_SHORTCUTS, formatShortcut, type ShortcutId } from "../../lib/annotate/shortcuts";
import type { NodeModeUi } from "../../lib/annotate/vector/edit";
import { useImageEditorUi } from "../../stores/imageEditor";
import type { AnnotationLayerHandle } from "./AnnotationLayer";
import { NODE_MODE_LABELS, nodeHudText, type NodeEditState } from "./annotation/nodeEdit";

/** 이 바가 쓰는 조각만 받는다 — 레이어 손잡이 전체를 요구하면 e2e·다른 호출자가 못 부른다. */
export type NodeBarApi = Pick<
  AnnotationLayerHandle,
  "nodeOp" | "setNodeMode" | "exitNodeEdit"
>;

/** 시안 `Node Type` 5칸. `없음` 은 문서 모드가 아니라 "양 핸들 (0,0)" 이다(37 은 4모드). */
const MODES: readonly NodeModeUi[] = ["none", "corner", "mirrored", "asymmetric", "auto"];

const BTN =
  "flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent";
const ON = "bg-accent/15 text-accent";

function Btn({
  title,
  pressed,
  disabled,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`${BTN} ${pressed ? ON : ""}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-edge" />;
}

/** 툴팁 `<라벨> (<키>)`. 같은 id 의 행이 둘이면 첫 행(design)의 표기가 그대로 맞다. */
function tip(id: ShortcutId): string {
  const s = EDITOR_SHORTCUTS.find((x) => x.id === id);
  return s ? `${s.label} (${formatShortcut(s).split("·")[0]})` : "";
}

export function NodeContextBar({
  state,
  name,
  api,
}: {
  state: NodeEditState;
  /** 편집 중인 레이어 이름 — 레이어 패널·캔버스 라벨과 **같은 값**이어야 한다. */
  name: string;
  api: NodeBarApi;
}) {
  const msg = useMessages();
  const t = msg.imagePanels.nodeBar;
  const toggles = useImageEditorUi((s) => s.toggles);
  const setToggle = useImageEditorUi((s) => s.setToggle);
  const sel = state.selected.length;

  return (
    <div
      role="toolbar"
      aria-label={t.toolbarLabel}
      className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-edge bg-panel px-2 text-[12px]"
    >
      <PenTool size={14} className="shrink-0 text-fg-dim" />
      <span className="shrink-0 truncate text-fg-muted">{name}</span>

      <Sep />
      <span className="shrink-0 text-fg-dim">{t.nodeHeading}</span>
      {MODES.map((m) => (
        <Btn
          key={m}
          title={t.modeButtonTitle(NODE_MODE_LABELS[m])}
          // `mixed` 면 어느 칸도 눌린 상태가 아니다 — 한 칸을 켜 두면 값이 갈린 선택이 그
          // 값으로 통일된 것처럼 보이고, 사용자는 바꾼 적 없는 모드를 그대로 믿는다.
          pressed={state.mode === m}
          // 고른 정점이 없으면 모드를 쓸 대상이 없다. 눌러도 아무 일 없는 버튼은 두지 않는다.
          disabled={sel === 0}
          onClick={() => api.setNodeMode(m)}
        >
          {NODE_MODE_LABELS[m]}
        </Btn>
      ))}

      <Sep />
      <Btn
        title={t.addNodeTitle}
        // ponytail: 인접 판정은 `applyNodeOp` 안에 있고 요약에는 없다 — 이웃이 아닌 두 정점을
        //           고르면 눌러도 아무 일이 없다. 요약에 인접 여부를 실으면 정확해진다.
        disabled={sel !== 2}
        onClick={() => api.nodeOp("add")}
      >
        {t.addNode}
      </Btn>
      <Btn title={tip("delete")} disabled={sel === 0} onClick={() => api.nodeOp("delete")}>
        {t.deleteNodes}
      </Btn>
      {/* 닫힌 패스에 '패스 닫기'를, 열린 패스에 '패스 열기'를 회색으로 남겨 두지 않는다 —
          지금 할 수 있는 쪽만 그린다(`CropContextBar` 의 오버레이 '없음'과 같은 규칙). */}
      {state.open ? (
        <Btn title={t.closePathTitle} onClick={() => api.nodeOp("close")}>
          {t.closePath}
        </Btn>
      ) : (
        <Btn title={t.openPathTitle} onClick={() => api.nodeOp("open")}>
          {t.openPath}
        </Btn>
      )}
      <Btn
        title={t.reverseTitle}
        disabled={state.nodeCount < 2}
        onClick={() => api.nodeOp("reverse")}
      >
        {t.reverse}
      </Btn>

      <Sep />
      {/* 노드 전용 스냅 상태를 두지 않는다(§3.7) — 42 토글 그대로다. 같은 값에 두 이름이
          생기면 상태바에서 끈 스냅이 노드 편집에서만 살아 있는 상태가 만들어진다. */}
      <Btn
        title={t.snapPixel}
        pressed={toggles.snapPixel}
        onClick={() => setToggle("snapPixel", !toggles.snapPixel)}
      >
        {t.snapPixel}
      </Btn>
      <Btn
        title={t.snapObjects}
        pressed={toggles.snapObjects}
        onClick={() => setToggle("snapObjects", !toggles.snapObjects)}
      >
        {t.snapObjects}
      </Btn>

      <Sep />
      {/* 캔버스 HUD 와 **같은 문구**다 — 확대해서 HUD 가 화면 밖으로 나가도 개수는 여기 남는다. */}
      <span className="shrink-0 tabular-nums text-fg-dim">{nodeHudText(state)}</span>

      <div className="flex-1" />
      <button
        type="button"
        title={t.doneTitle}
        onClick={api.exitNodeEdit}
        className="flex h-7 shrink-0 items-center gap-1 rounded bg-accent px-2 text-on-accent hover:opacity-90"
      >
        {t.done}
      </button>
    </div>
  );
}
