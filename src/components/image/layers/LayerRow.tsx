// 레이어 행 하나. 파일이 따로 있는 이유는 모양이 아니라 **구독 범위**다.
//
// 선택·호버는 42 스토어에 있고 호버는 캔버스 pointermove 를 따라 초당 수십 번 바뀐다.
// 부모가 `selectedIds`·`hoverId` 를 props 로 내려주면 그 한 번의 전이마다 목록 전체가
// 다시 그려진다 — 300행 문서에서 마우스를 훑는 것만으로 프레임이 무너진다. 그래서 행이
// **자기 것만** 구독하고(`includes(id)` · `hoverId === id`), 나머지 props 는 참조가 고정된
// 것만 받아 `memo` 가 실제로 걸리게 한다. 부모에서 콜백을 인라인으로 만들면 이 memo 는
// 조용히 무력화된다(LayerPanel 이 전부 `useCallback` 으로 넘기는 이유).
//
// 배경: DOCS/task/44-image-panels.md §3.4

import { memo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Component,
  Eye,
  EyeOff,
  Frame,
  Group,
  ImageIcon,
  Lock,
  LockOpen,
  PenTool,
  Square,
  Type,
  type LucideIcon,
} from "lucide-react";

import type { LayerBadge, LayerRow as Row, LayerType } from "../../../lib/annotate/layer-rows";
import type { ObjId } from "../../../lib/annotate/types";
import { useImageEditorUi } from "../../../stores/imageEditor";

/** 시안 ① 행 높이. `useLayerDrag` 의 드롭 표시선 위치가 같은 값을 쓴다. */
export const ROW_H = 28;
/** 시안 ① `Indent 13/depth`. */
const INDENT = 13;

const TYPE_ICON: Record<LayerType, LucideIcon> = {
  frame: Frame,
  group: Group,
  shape: Square,
  text: Type,
  image: ImageIcon,
  vector: PenTool,
  component: Component,
};

const INSTANCE_LABEL: Record<"linked" | "overridden" | "detached", string> = {
  linked: "연결됨",
  overridden: "재정의됨",
  detached: "분리됨",
};

function badgeText(b: LayerBadge): string {
  switch (b.kind) {
    case "mask":
      return "마스크";
    case "blend":
      return b.label;
    case "nodeEdit":
      return "노드 편집";
    case "instance":
      return b.state ? INSTANCE_LABEL[b.state] : "인스턴스";
  }
}

export interface LayerRowProps {
  row: Row;
  renaming: boolean;
  /** 드래그 시작(`useLayerDrag`). 클릭 선택은 이 행이 직접 한다. */
  onPointerDown(e: ReactPointerEvent, row: Row): void;
  onToggle(id: ObjId): void;
  onStartRename(id: ObjId): void;
  /** `value === null` 이면 취소(Esc). */
  onRename(id: ObjId, value: string | null): void;
  onVisible(row: Row): void;
  onLocked(row: Row): void;
}

export const LayerRow = memo(function LayerRow({
  row,
  renaming,
  onPointerDown,
  onToggle,
  onStartRename,
  onRename,
  onVisible,
  onLocked,
}: LayerRowProps) {
  const selected = useImageEditorUi((s) => s.selectedIds.includes(row.id));
  const hovered = useImageEditorUi((s) => s.hoverId === row.id);
  const select = useImageEditorUi((s) => s.select);
  const setHover = useImageEditorUi((s) => s.setHover);

  const node = row.node;
  const Icon = TYPE_ICON[row.type];

  return (
    <div
      role="treeitem"
      data-layer-id={row.id}
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? !row.collapsed : undefined}
      aria-selected={selected}
      title={row.name}
      // 화면 밖 행은 레이아웃을 생략한다 — 가상화 라이브러리를 넣지 않는 근거(§3.8).
      // 높이를 함께 주지 않으면 스크롤바 길이가 스크롤할 때마다 튄다.
      style={{
        height: ROW_H,
        paddingLeft: 4 + row.depth * INDENT,
        contentVisibility: "auto",
        containIntrinsicSize: `auto ${ROW_H}px`,
      }}
      className={`flex select-none items-center gap-1 pr-1 text-[11px] ${
        selected ? "bg-accent/15 text-fg" : hovered ? "bg-raised text-fg" : "text-fg-muted"
      } ${row.hidden ? "opacity-50" : ""}`}
      onPointerDown={(e) => onPointerDown(e, row)}
      onPointerEnter={() => setHover(node ? (row.id as ObjId) : null)}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        // 배경은 문서 노드가 아니라 노드와 섞일 수 없다 — 스토어의 `'__base'` 단독 규칙과 짝.
        if (!node) {
          select(["__base"]);
          return;
        }
        select([row.id], { toggle: e.shiftKey || e.ctrlKey || e.metaKey });
      }}
      onDoubleClick={() => node && onStartRename(row.id as ObjId)}
    >
      {row.hasChildren ? (
        <button
          // 접기는 선택이 아니다 — 버블을 막지 않으면 캐럿 한 번에 선택까지 바뀐다.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.id as ObjId);
          }}
          title={row.collapsed ? "펼치기" : "접기"}
          className="shrink-0 text-fg-dim hover:text-fg"
        >
          {row.collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </button>
      ) : (
        <span className="shrink-0" style={{ width: 11 }} />
      )}

      <Icon size={12} className="shrink-0 text-fg-dim" />

      {renaming && node ? (
        <RenameInput
          initial={row.name}
          onDone={(v) => onRename(row.id as ObjId, v)}
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{row.name}</span>
      )}

      {row.badges.map((b, i) => (
        <span
          key={i}
          className="shrink-0 rounded border border-edge px-1 text-[8px] leading-4 text-fg-dim"
        >
          {badgeText(b)}
        </span>
      ))}

      {node && (
        <>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onVisible(row);
            }}
            title={node.visible ? "숨기기" : "표시"}
            className="shrink-0 opacity-45 hover:opacity-100"
          >
            {node.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onLocked(row);
            }}
            // 아이콘은 **효과적** 잠금(조상 포함)이고 버튼은 이 노드 자기 필드만 뒤집는다.
            // 조상이 잠근 행에서 눌러도 그림이 안 바뀌는 이유라 문구로 구분해 둔다.
            title={node.locked ? "잠금 해제" : "잠금"}
            className="shrink-0 opacity-45 hover:opacity-100"
          >
            {row.locked ? <Lock size={12} /> : <LockOpen size={12} />}
          </button>
        </>
      )}
    </div>
  );
});

/**
 * 이름 입력(시안 `Rename Input` h22).
 *
 * 별도 컴포넌트인 이유는 "확정을 한 번만" 이다 — Enter·Esc 뒤에 blur 가 곧바로 따라오므로
 * 플래그가 없으면 커밋이 두 번 나가 히스토리가 두 칸 쌓인다. 마운트/언마운트로 플래그가
 * 저절로 초기화되게 두는 편이 `renaming` 변화를 effect 로 좇는 것보다 짧고 안전하다.
 */
function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone(value: string | null): void;
}) {
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      defaultValue={initial}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") finish(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      style={{ height: 22 }}
      className="min-w-0 flex-1 rounded border border-accent bg-base px-1 text-[11px] text-fg outline-none"
    />
  );
}
