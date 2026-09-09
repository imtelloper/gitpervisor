// 좌 패널 `에셋` 탭(시안 ⑤) — 로컬 컴포넌트 카드 · 문서 이미지 · 인스턴스 상태 집계.
//
// 컴포넌트 목록은 **앱 전역** 라이브러리라 문서를 바꿔도 그대로 있고(51 §3.1), 문서 이미지는
// 이 문서에만 있다. 한 탭에 나란히 두면서 제목으로 그 차이를 말한다 — 섞어 보이면 "저 워터마크를
// 다른 이미지에서도 쓸 수 있나"에 답이 없다.
//
// 카드는 **배치를 실행하지 않는다.** 드래그는 스테이지가(드롭 좌표를 아는 쪽이 `clientToOriented`
// 로 푼다), 더블클릭은 `onPlace` 로 편집기가 받는다 — 문서 변경 깔때기는 `applyDoc` 하나뿐이다.
//
// 삭제는 라이브러리에서 빼는 것으로 끝난다. 참조하던 인스턴스는 여기서 건드리지 않는다 —
// 열린 문서는 편집기의 재동기가, 닫힌 문서는 다음 로드가 분리한다(51 §3.6). 그래서 확인 문구가
// "인스턴스 N개가 분리됩니다"여야 한다: "삭제됩니다"로 읽히면 아무도 못 지운다.
//
// 배경: DOCS/task/51-image-styles-components.md §3.8

import {
  useEffect,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Component, LayoutGrid, List, Search } from "lucide-react";

import { instanceCounts } from "../../../lib/annotate/components";
import type { ComponentDef, EditorDoc } from "../../../lib/annotate/types";
import { useImageLibrary } from "../../../stores/imageLibrary";
import { useUi } from "../../../stores/ui";
import { EmptyState } from "../../common/EmptyState";
import { RowMenu } from "../StyleLibrary";

/**
 * 카드 드래그가 싣는 `dataTransfer` 타입.
 *
 * 스테이지의 `onDrop`(ImageEditor)이 **같은 문자열**을 읽는다. 양쪽에 리터럴을 따로 적으면
 * 오타 하나에 드롭이 조용히 무시되고(예외도 로그도 없다) 더블클릭만 되는 상태가 된다.
 */
export const COMPONENT_DND_TYPE = "application/x-gpv-component";

export interface AssetsPanelProps {
  /** 인스턴스 집계와 문서 이미지 목록에 쓴다(읽기 전용). */
  doc: EditorDoc;
  /** 카드 더블클릭 배치. `at` 은 편집기가 정한다(이미지 중심). */
  onPlace(def: ComponentDef): void;
}

export function AssetsPanel({ doc, onPlace }: AssetsPanelProps) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; def: ComponentDef } | null>(null);

  const components = useImageLibrary((s) => s.lib.components);
  const ensure = useImageLibrary((s) => s.ensure);

  useEffect(() => {
    void ensure();
  }, [ensure]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? components.filter((c) => c.name.toLowerCase().includes(q)) : components),
    [components, q],
  );

  const assets = useMemo(() => Object.entries(doc.assets), [doc.assets]);
  const counts = useMemo(() => instanceCounts(doc.objects), [doc.objects]);

  function startRename(def: ComponentDef) {
    useUi.getState().askPrompt({
      title: "컴포넌트 이름",
      defaultValue: def.name,
      validate: (v) => (v.trim() ? null : "이름을 입력하세요"),
      onConfirm: (v) => {
        const name = v.trim();
        if (name && name !== def.name) useImageLibrary.getState().renameComponent(def.id, name);
      },
    });
  }

  function confirmRemove(def: ComponentDef) {
    const n = doc.objects.filter(
      (o) => o.kind === "instance" && o.componentId === def.id,
    ).length;
    useUi.getState().askConfirm({
      title: "컴포넌트 삭제",
      message: `'${def.name}' 을(를) 라이브러리에서 지웁니다.`,
      detail: n > 0 ? `이 문서의 인스턴스 ${n}개가 분리됩니다 (모양은 그대로입니다).` : undefined,
      confirmLabel: "삭제",
      danger: true,
      onConfirm: () => useImageLibrary.getState().removeComponent(def.id),
    });
  }

  function cardProps(def: ComponentDef) {
    return {
      draggable: true,
      onDragStart: (e: ReactDragEvent) => {
        e.dataTransfer.setData(COMPONENT_DND_TYPE, def.id);
        e.dataTransfer.effectAllowed = "copy" as const;
      },
      onDoubleClick: () => onPlace(def),
      onContextMenu: (e: ReactMouseEvent) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, def });
      },
      title: def.name,
    };
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-[11px]">
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
            placeholder="에셋 검색"
            aria-label="에셋 검색"
            style={{ height: 26 }}
            className="w-full rounded border border-edge bg-base pl-6 pr-1.5 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-accent"
          />
        </div>
        <button
          type="button"
          onClick={() => setList((v) => !v)}
          title={list ? "카드로 보기" : "목록으로 보기"}
          aria-label={list ? "카드로 보기" : "목록으로 보기"}
          style={{ height: 26, width: 26 }}
          className="flex shrink-0 items-center justify-center rounded border border-edge text-fg-muted hover:text-fg"
        >
          {list ? <LayoutGrid size={12} /> : <List size={12} />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          style={{ height: 26 }}
          className="flex items-center gap-1 bg-panel px-2 text-fg-dim"
        >
          <span>로컬 컴포넌트</span>
          <span>· {shown.length}</span>
        </div>

        {shown.length === 0 ? (
          q ? (
            <div className="px-2 py-3 text-fg-dim">검색 결과가 없습니다</div>
          ) : (
            <div className="py-6">
              <EmptyState icon={Component} title="로컬 컴포넌트가 없습니다" />
            </div>
          )
        ) : list ? (
          <div>
            {shown.map((def) => (
              <div
                key={def.id}
                {...cardProps(def)}
                style={{ height: 30 }}
                className="flex cursor-grab items-center gap-1.5 px-2 text-fg-muted hover:bg-raised hover:text-fg"
              >
                <Thumb def={def} size={18} />
                <span className="min-w-0 flex-1 truncate">{def.name}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5 p-1.5">
            {shown.map((def) => (
              <div
                key={def.id}
                {...cardProps(def)}
                className="flex cursor-grab flex-col gap-1 rounded border border-edge p-1 text-fg-muted hover:border-accent hover:text-fg"
              >
                <div className="flex h-14 items-center justify-center overflow-hidden rounded bg-base">
                  <Thumb def={def} size={44} />
                </div>
                <span className="truncate text-center">{def.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* 검색 중에는 감춘다 — 에셋에는 이름이 없어 어떤 검색어에도 걸리지 않는다.
            그대로 남겨 두면 "검색했는데 안 걸러진 것들"로 읽힌다. */}
        {!q && assets.length > 0 && (
          <>
            <div
              style={{ height: 26 }}
              className="flex items-center gap-1 bg-panel px-2 text-fg-dim"
            >
              <span>문서 이미지</span>
              <span>· {assets.length}</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1.5">
              {assets.map(([id, a]) => (
                <div
                  key={id}
                  title={`${a.w}×${a.h}`}
                  className="flex h-12 items-center justify-center overflow-hidden rounded border border-edge bg-base"
                >
                  <img
                    src={`data:${a.mime};base64,${a.data}`}
                    alt=""
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div
        style={{ height: 32 }}
        className="flex shrink-0 items-center gap-2 border-t border-edge px-2 text-fg-dim"
      >
        <span className="shrink-0">인스턴스</span>
        <span className="truncate">
          {counts.linked} 연결됨 · {counts.overridden} 재정의됨 · {counts.detached} 분리됨
        </span>
      </div>

      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "이름 변경", onClick: () => startRename(menu.def) },
            { label: "삭제", danger: true, onClick: () => confirmRemove(menu.def) },
          ]}
        />
      )}
    </div>
  );
}

/** 썸네일 — 생성이 실패한 컴포넌트는 빈 문자열이라 아이콘으로 떨어진다(51 §6). */
function Thumb({ def, size }: { def: ComponentDef; size: number }) {
  if (!def.thumb) return <Component size={size * 0.6} className="shrink-0 text-fg-dim" />;
  return (
    <img
      src={def.thumb}
      alt=""
      style={{ maxHeight: size, maxWidth: size }}
      className="shrink-0 object-contain"
    />
  );
}
