// 좌 패널 `레이어` 탭(시안 ① 264px) — 검색·타입 필터·헤더 액션·트리·푸터.
//
// 문서는 여기서 만들지 않는다. 이름·눈/자물쇠·순서까지 전부 `onCommit(objects, label)` 하나로
// 나가고, 히스토리 한 칸의 라벨도 그 자리에서 정해진다 — 커밋 경로가 둘이 되면 되돌리기가
// 조작마다 다르게 동작한다.
//
// **검색·필터·접기·이름 편집 중 상태는 패널 로컬 state 다**(§3.1 대안 B 탈락). 문서에 넣으면
// 그룹을 접은 것이 undo 한 칸을 먹고 사이드카(41)에 UI 상태가 실린다. 다시 열면 초기화되는
// 것이 의도다(Figma 동일).
//
// 리렌더 규칙: 이 셸은 선택이 바뀔 때마다 다시 그려지지만(헤더 버튼 활성·푸터 개수),
// 행들은 `memo` 라 그대로 있다. 그러려면 행에 넘기는 콜백이 **매 렌더 같은 참조**여야 한다 —
// 아래 핸들러가 전부 `useCallback([])` + ref 인 이유다. 인라인 화살표를 하나라도 끼우면
// 선택 한 번에 수백 행이 다시 그려진다.
//
// 배경: DOCS/task/44-image-panels.md §3.1~§3.5

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Eye,
  FolderPlus,
  ListFilter,
  Lock,
  Search,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import {
  DEFAULT_LAYER_FILTER,
  defaultLayerName,
  filterRows,
  flattenLayers,
  patchNodes,
  type DropTarget,
  type LayerFilter,
  type LayerRow as Row,
} from "../../../lib/annotate/layer-rows";
import type { Scene } from "../../../lib/annotate/scene";
import { nodeOf, reparent } from "../../../lib/annotate/tree";
import type { EditorDoc, Node, ObjId } from "../../../lib/annotate/types";
import { useImageEditorUi } from "../../../stores/imageEditor";
import { DragGhost } from "../../common/DragGhost";
import { LayerRow } from "./LayerRow";
import { LayerTypeFilter } from "./LayerTypeFilter";
import { useLayerDrag } from "./useLayerDrag";

/** 검색 중에는 접기를 무시한다 — 접힌 그룹 안의 매치가 안 보이면 검색이 고장으로 읽힌다. */
const NO_COLLAPSE: ReadonlySet<ObjId> = new Set();
/** 팝오버 폭(시안 ④ w236) — 화면 오른쪽 클램프에 쓴다. */
const POPOVER_W = 236;

export interface LayerPanelHandle {
  /** 42 단축키 표의 `rename`(F2). 캔버스에 포커스가 있어도 여기로 들어온다. */
  startRename(id?: ObjId): void;
  /**
   * 42 단축키 표의 `esc`. 행 드래그 취소가 여기로 들어오는 이유는 `useLayerDrag` 머리말에
   * 있다 — 편집기 안에서는 window 리스너를 새로 달 수 없다.
   */
  cancelDrag(): boolean;
  /**
   * 아래 넷은 `__gpv.imageEditor.panel`(§4 e2e 훅)이 패널 로컬 state 에 닿는 **유일한** 통로다.
   * 검색·필터·접기를 스토어에 두지 않기로 한 이상(§3.1) 밖에서 볼 방법이 이것뿐이다.
   */
  setQuery(q: string): void;
  setFilter(patch: Partial<LayerFilter>): void;
  toggleCollapsed(id: ObjId): void;
  /** 지금 화면에 그려지는 행(검색·필터·접기 반영). */
  rows(): readonly Row[];
}

export interface LayerPanelProps {
  doc: EditorDoc;
  scene: Scene;
  /** 배경 행에 붙는 파일명(시안 `배경 — 대시보드.png`). */
  baseName: string;
  onCommit(objects: Node[], label: string): void;
  /** 42 액션 맵의 **같은 핸들러** — 헤더 버튼과 Ctrl+G · Delete 가 갈라지지 않게 주입받는다. */
  actions: { group(): void; remove(): void };
}

function isDefaultFilter(f: LayerFilter): boolean {
  return (
    f.types.size === DEFAULT_LAYER_FILTER.types.size &&
    !f.hiddenOnly &&
    !f.lockedOnly &&
    !f.overriddenOnly &&
    f.includeMasks
  );
}

export const LayerPanel = forwardRef<LayerPanelHandle, LayerPanelProps>(function LayerPanel(
  { doc, scene, baseName, onCommit, actions },
  handle,
) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LayerFilter>(DEFAULT_LAYER_FILTER);
  const [collapsed, setCollapsed] = useState<ReadonlySet<ObjId>>(NO_COLLAPSE);
  const [renamingId, setRenamingId] = useState<ObjId | null>(null);
  /** 팝오버 위치 겸 열림 상태 — 좌표를 열 때 한 번만 재면 렌더 중 레이아웃 읽기가 없다. */
  const [filterAt, setFilterAt] = useState<{ x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIds = useImageEditorUi((s) => s.selectedIds);
  const nodeEditId = useImageEditorUi((s) => (s.mode.kind === "nodeEdit" ? s.mode.id : null));

  const rows = useMemo(
    () =>
      flattenLayers(doc, scene, query.trim() ? NO_COLLAPSE : collapsed, {
        baseName,
        nodeEditId,
      }),
    [doc, scene, query, collapsed, baseName, nodeEditId],
  );
  const shown = useMemo(() => filterRows(rows, query, filter), [rows, query, filter]);

  // 콜백이 최신 값을 보되 참조는 고정되게 — 행 `memo` 가 살아 있는 조건이다.
  const docRef = useRef(doc);
  docRef.current = doc;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const rowsRef = useRef(shown);
  rowsRef.current = shown;
  const selRef = useRef(selectedIds);
  selRef.current = selectedIds;

  const selNodes = useMemo(
    () => selectedIds.filter((id): id is ObjId => id !== "__base"),
    [selectedIds],
  );

  const onToggle = useCallback((id: ObjId) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useImperativeHandle(
    handle,
    () => ({
      startRename(id) {
        const target =
          id ?? [...selRef.current].reverse().find((s): s is ObjId => s !== "__base");
        if (target) setRenamingId(target);
      },
      // `drag` 는 아래에서 만들어지지만 이 팩토리는 커밋 단계에 돌아 이미 값이 있다.
      // 한 겹 감싸는 것은 `drag` 객체가 매 렌더 새로 오기 때문이다(안의 함수는 고정).
      cancelDrag: () => drag.cancelDrag(),
      setQuery,
      setFilter: (patch) => setFilter((f) => ({ ...f, ...patch })),
      toggleCollapsed: onToggle,
      rows: () => rowsRef.current,
    }),
    [onToggle],
  );

  // 캔버스에서 선택이 바뀌면 그 행을 보이게 한다. `nearest` 라 이미 보이는 행에는 아무 일도
  // 일어나지 않는다 — 패널에서 직접 클릭한 경우 화면이 튀지 않는 이유.
  useEffect(() => {
    const last = selectedIds[selectedIds.length - 1];
    if (!last) return;
    listRef.current
      ?.querySelector(`[data-layer-id="${CSS.escape(last)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIds]);

  const onStartRename = useCallback((id: ObjId) => setRenamingId(id), []);

  const onRename = useCallback((id: ObjId, value: string | null) => {
    setRenamingId(null);
    if (value === null) return;
    const objects = docRef.current.objects;
    const node = nodeOf(objects, id);
    if (!node) return;
    const name = value.trim();
    // 기본 이름을 그대로 확정하면 저장하지 않는다 — 리터럴로 굳으면 앞 객체를 지운 뒤에도
    // 번호가 따라오지 않아 `사각형 3` 이 둘 생긴다(`patchNodes` 가 빈 문자열을 null 로 만든다).
    const next = name === defaultLayerName(node, objects) ? "" : name;
    if ((node.name ?? "") === next) return;
    commitRef.current(patchNodes(objects, [id], { name: next }), "이름 변경");
  }, []);

  const onVisible = useCallback((row: Row) => {
    const n = row.node;
    if (!n) return;
    commitRef.current(
      patchNodes(docRef.current.objects, [n.id], { visible: !n.visible }),
      n.visible ? "숨김" : "표시",
    );
  }, []);

  const onLocked = useCallback((row: Row) => {
    const n = row.node;
    if (!n) return;
    commitRef.current(
      patchNodes(docRef.current.objects, [n.id], { locked: !n.locked }),
      n.locked ? "잠금 해제" : "잠금",
    );
  }, []);

  const onDrop = useCallback((target: DropTarget, ids: ObjId[]) => {
    commitRef.current(
      reparent(docRef.current.objects, ids, target.parentId, target.index),
      "순서 변경",
    );
  }, []);

  // 인자는 훅이 ref 로 받으므로 매 렌더 새 화살표여도 `onRowPointerDown` 참조는 고정이다.
  const drag = useLayerDrag(
    listRef,
    () => rowsRef.current,
    () => docRef.current.objects,
    onDrop,
  );

  /** 선택 전체의 눈/자물쇠 — 하나라도 켜져 있으면 끄는 쪽으로 맞춘다. */
  function bulk(field: "visible" | "locked") {
    const objects = doc.objects;
    const nodes = selNodes.map((id) => nodeOf(objects, id)).filter((n): n is Node => n !== null);
    if (!nodes.length) return;
    const value = !nodes.every((n) => n[field]);
    const label =
      field === "visible" ? (value ? "표시" : "숨김") : value ? "잠금" : "잠금 해제";
    const patch = field === "visible" ? { visible: value } : { locked: value };
    commitRef.current(patchNodes(objects, selNodes, patch), label);
  }

  const filtering = query.trim() !== "" || !isDefaultFilter(filter);
  const matched = shown.reduce((n, r) => n + (r.node ? 1 : 0), 0);
  const noSel = selNodes.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        style={{ height: 38 }}
        className="flex shrink-0 items-center gap-1 border-b border-edge px-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search
            size={11}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-fg-dim"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="레이어 검색"
            aria-label="레이어 검색"
            style={{ height: 26 }}
            className="w-full rounded border border-edge bg-base pl-6 pr-1.5 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-accent"
          />
        </div>
        <button
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setFilterAt(filterAt ? null : { x: r.left, y: r.bottom + 4 });
          }}
          title="타입 필터"
          aria-label="타입 필터"
          style={{ height: 26, width: 26 }}
          className={`flex shrink-0 items-center justify-center rounded border border-edge ${
            isDefaultFilter(filter) ? "text-fg-muted hover:text-fg" : "bg-accent/15 text-accent"
          }`}
        >
          <ListFilter size={12} />
        </button>
      </div>

      <div
        style={{ height: 30 }}
        className="flex shrink-0 items-center gap-1 border-b border-edge px-2 text-[11px]"
      >
        <span className="text-fg-muted">레이어</span>
        <span className="text-fg-dim">
          · {filtering ? `${matched}/${doc.objects.length}` : doc.objects.length}
        </span>
        <span className="flex-1" />
        <HeaderAction icon={Eye} title="선택 숨기기/표시" disabled={noSel} onClick={() => bulk("visible")} />
        <HeaderAction icon={Lock} title="선택 잠금/잠금 해제" disabled={noSel} onClick={() => bulk("locked")} />
        <HeaderAction icon={FolderPlus} title="그룹" disabled={noSel} onClick={actions.group} />
        <HeaderAction icon={Trash2} title="삭제" disabled={noSel} onClick={actions.remove} />
      </div>

      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div role="tree" aria-label="레이어 트리">
          {shown.map((r) => (
            <LayerRow
              key={r.id}
              row={r}
              renaming={renamingId === r.id}
              onPointerDown={drag.onRowPointerDown}
              onToggle={onToggle}
              onStartRename={onStartRename}
              onRename={onRename}
              onVisible={onVisible}
              onLocked={onLocked}
            />
          ))}
        </div>
        {/* 드롭 표시선(시안 `Drop Indicator` h2) — 위치는 드래그 훅이 DOM 으로 직접 쓴다. */}
        <div
          ref={drag.indicatorRef}
          style={{ display: "none", height: 2 }}
          className="pointer-events-none absolute right-0 bg-accent"
        />
      </div>
      {/* 고스트는 `fixed` 라 스크롤 컨테이너 밖에 둔다 — 안에 두면 조상에 transform 이
          하나만 생겨도 그 컨테이너 기준으로 잘린다. */}
      <DragGhost ref={drag.ghostRef} />

      <div
        style={{ height: 32 }}
        className="flex shrink-0 items-center gap-2 border-t border-edge px-2 text-[11px] text-fg-dim"
      >
        {selectedIds.length > 0 && (
          <span className="shrink-0 text-fg-muted">{selectedIds.length}개 선택됨</span>
        )}
        <span className="truncate">⇧클릭 · 드래그로 순서 변경</span>
      </div>

      {filterAt && (
        // 45 `Popover` 가 오기 전의 임시 셸 — `ViewerFileTabs.tsx:119-131` 관례(백드롭이 바깥
        // 클릭·우클릭을 삼키고 화면 안으로 클램프). 프리미티브를 여기서 새로 만들지 않는다.
        <div
          className="fixed inset-0 z-50"
          onClick={() => setFilterAt(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setFilterAt(null);
          }}
        >
          <div
            className="fixed rounded-md border border-edge bg-panel p-2 shadow-xl"
            style={{
              left: Math.min(filterAt.x, window.innerWidth - POPOVER_W - 8),
              top: Math.min(filterAt.y, Math.max(8, window.innerHeight - 380)),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <LayerTypeFilter
              value={filter}
              onApply={(f) => {
                setFilter(f);
                setFilterAt(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
});

function HeaderAction({
  icon: Icon,
  title,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-0.5 text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <Icon size={12} />
    </button>
  );
}
