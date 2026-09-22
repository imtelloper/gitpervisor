// 스타일 라이브러리 목록 — 시안 ④(색 스타일)·②(텍스트 스타일)의 **본문 하나**.
//
// **팝오버를 스스로 열지 않는다.** 45 색 피커 안에서도, 50 텍스트 인스펙터 안에서도 같은
// 목록이라 셸까지 여기서 만들면 둘 중 한 자리는 팝오버 안의 팝오버가 된다. `mode` 가 가르는
// 것은 폭·스크롤뿐이다.
//
// 라이브러리는 앱 전역 스토어에서 **직접** 읽지만(창마다 싱글턴 — 51 §3.7), 문서는 한 줄도
// 건드리지 않는다: 적용은 `onApply` 로 올려 보낸다. 문서 변경 깔때기는 `ImageEditor.applyDoc`
// 하나뿐이라, 여기서 커밋하면 히스토리 라벨과 커밋 시 인스턴스 파생(51 §3.5)을 통째로 우회한다.
//
// 이름 변경·삭제는 반대로 라이브러리 쪽 일이라 스토어를 직접 부른다. 삭제해도 **노드 값은
// 남고 링크만 풀린다**(다음 재동기에서 `resyncStyles` 가 `missing` 을 분리한다) — 확인 문구가
// 그 사실을 말하지 않으면 사용자는 "색이 통째로 사라진다"로 읽고 지우지 못한다.
//
// 배경: DOCS/task/51-image-styles-components.md §3.3·§3.8

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import type { Messages } from "../../i18n/messages";
import { useMessages } from "../../i18n/ui-language";
import { groupStyles, styleSection, type StyleSlot } from "../../lib/annotate/styles";
import { nodeOf } from "../../lib/annotate/tree";
import type {
  ColorStyle,
  Effect,
  EffectStyle,
  Fill,
  Node,
  StyleId,
  TextStyleDef,
} from "../../lib/annotate/types";
import { useImageEditorUi } from "../../stores/imageEditor";
import { useImageLibrary } from "../../stores/imageLibrary";
import { useUi } from "../../stores/ui";

/** 시안 ④ 팝오버 폭 — `LayerPanel` 의 필터 팝오버와 같은 값이다. */
const POPOVER_W = 236;

/** 슬롯이 정해지기 전까지 항목은 셋 중 무엇이든 될 수 있다(styles.ts 와 같은 유니온). */
type StyleDef = ColorStyle | TextStyleDef | EffectStyle;

function effectLabels(msg: Messages): Record<Effect["type"], string> {
  const t = msg.imagePanels.styleLibrary;
  return {
    "drop-shadow": t.effectDropShadow,
    "inner-shadow": t.effectInnerShadow,
    "layer-blur": t.effectLayerBlur,
    "background-blur": t.effectBackgroundBlur,
  };
}

/**
 * 스와치 미리보기. 그라디언트는 각도만 CSS 로 흉내 낸다 — 정본 렌더는 39 다.
 *
 * ponytail: `PropsTab` 에 같은 함수가 모듈 비공개로 있다. 그 파일은 45 소유라 손대지 않았다.
 * 셋째 사용처가 생기면 그때 `annotate/paint.ts` 로 올린다.
 */
function paintCss(p: Fill): string {
  if (p.type === "solid") return p.color;
  if (p.type === "image") {
    return "repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 0 / 8px 8px";
  }
  const stops = p.stops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(", ");
  return `linear-gradient(${p.angle + 90}deg, ${stops})`;
}

/**
 * 이 스타일을 물고 있는 노드 수 — 삭제 확인 문구의 N.
 *
 * 슬롯을 가리지 않고 센다: 색 스타일 하나는 `fill` 과 `stroke` 양쪽에 꽂힐 수 있고
 * (시안 ④ 목록이 하나다), 삭제는 그 둘을 한꺼번에 푼다.
 */
function refCount(objects: readonly Node[], id: StyleId): number {
  return objects.filter((n) => Object.values(n.styleRefs).some((v) => v === id)).length;
}

export interface StyleLibraryProps {
  slot: StyleSlot;
  /** `popover` = 45 팝오버 안(고정 폭·자체 스크롤), `inline` = ② 목록(폭·스크롤은 부모). */
  mode: "popover" | "inline";
  /** 현재 문서 노드 — `적용됨` 배지와 삭제 확인의 참조 개수에만 쓴다(읽기 전용). */
  objects: readonly Node[];
  /** 클릭 적용. 값 복사·`styleRefs` 기록·히스토리 한 칸은 **호출자**가 한다. */
  onApply(style: StyleDef): void;
}

export function StyleLibrary({ slot, mode, objects, onApply }: StyleLibraryProps) {
  const msg = useMessages();
  const t = msg.imagePanels.styleLibrary;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; item: StyleDef } | null>(null);

  const lib = useImageLibrary((s) => s.lib);
  const ensure = useImageLibrary((s) => s.ensure);
  const selectedIds = useImageEditorUi((s) => s.selectedIds);

  // 첫 사용에 로드·시드·구독을 건다. 단일 비행이라 네 화면이 각자 불러도 한 번만 돈다.
  useEffect(() => {
    void ensure();
  }, [ensure]);

  const items: readonly StyleDef[] =
    slot === "text" ? lib.textStyles : slot === "effect" ? lib.effectStyles : lib.colorStyles;
  const groups = useMemo(() => groupStyles(items, query), [items, query]);

  /**
   * `적용됨` 배지 = 선택 **전부**가 같은 id 를 물고 있을 때만(§3.3).
   *
   * 하나라도 다르면 null 이다 — 대표 하나를 골라 배지를 달면, 그 배지를 보고 "이미 적용됐다"고
   * 넘어간 사용자의 나머지 선택은 다른 색으로 남는다.
   */
  const appliedId = useMemo<StyleId | null>(() => {
    const sel = selectedIds.filter((id): id is Exclude<typeof id, "__base"> => id !== "__base");
    if (!sel.length) return null;
    let hit: StyleId | undefined;
    for (const id of sel) {
      const ref = nodeOf(objects, id)?.styleRefs[slot];
      if (!ref) return null;
      if (hit === undefined) hit = ref;
      else if (hit !== ref) return null;
    }
    return hit ?? null;
  }, [objects, selectedIds, slot]);

  function toggleSection(section: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  function startRename(item: StyleDef) {
    useUi.getState().askPrompt({
      title: t.renamePromptTitle,
      label: t.renamePromptLabel,
      defaultValue: item.name,
      validate: (v) => (v.trim() ? null : t.nameRequired),
      onConfirm: (v) => {
        const name = v.trim();
        if (name && name !== item.name) {
          useImageLibrary.getState().renameStyle(slot, item.id, name);
        }
      },
    });
  }

  function confirmRemove(item: StyleDef) {
    const n = refCount(objects, item.id);
    useUi.getState().askConfirm({
      title: t.deleteConfirmTitle,
      message: t.deleteConfirmMessage(item.name),
      detail: n > 0 ? t.deleteConfirmDetail(n) : undefined,
      confirmLabel: t.deleteConfirmButton,
      danger: true,
      onConfirm: () => useImageLibrary.getState().removeStyle(slot, item.id),
    });
  }

  return (
    <div
      className="flex min-h-0 flex-col text-[11px]"
      style={mode === "popover" ? { width: POPOVER_W, maxHeight: 320 } : undefined}
    >
      <div className="relative shrink-0 px-1 pb-1">
        <Search
          size={11}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-dim"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchPlaceholder}
          style={{ height: 26 }}
          className="w-full rounded border border-edge bg-base pl-6 pr-1.5 text-[11px] text-fg outline-none placeholder:text-fg-dim focus:border-accent"
        />
      </div>

      {/* 비어 있으면 **아무 말도 하지 않는다.** 검색 결과 0 만 한 줄로 알린다 — 그건 입력에
          대한 응답이라 침묵이 곧 고장으로 읽힌다. */}
      {items.length > 0 && groups.length === 0 && (
        <div className="px-2 py-3 text-fg-dim">{t.noSearchResults}</div>
      )}

      <div className={`min-h-0 flex-1 ${mode === "popover" ? "overflow-y-auto" : ""}`}>
        {groups.map((g, gi) => {
          const folded = g.section !== null && collapsed.has(g.section);
          return (
            <div key={g.section ?? `_${gi}`}>
              {g.section !== null && (
                <button
                  type="button"
                  onClick={() => toggleSection(g.section as string)}
                  style={{ height: 24 }}
                  className="flex w-full items-center gap-1 bg-panel px-1.5 text-left text-fg-dim hover:text-fg"
                >
                  {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  <span className="min-w-0 truncate">{g.section}</span>
                  <span className="ml-auto">{g.items.length}</span>
                </button>
              )}
              {!folded &&
                g.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    // 헤더가 붙은 그룹만 표시 이름으로 줄인다. 헤더 없는 그룹에서 `display` 를
                    // 쓰면 시안 ② 의 `제목 / H1` 이 `H1` 로 잘려 무엇의 H1 인지 사라진다(styles.ts).
                    title={item.name}
                    onClick={() => onApply(item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, item });
                    }}
                    style={{ height: 30 }}
                    className="flex w-full items-center gap-1.5 px-1.5 text-left text-fg-muted hover:bg-raised hover:text-fg"
                  >
                    <Sample slot={slot} item={item} />
                    <span className="min-w-0 flex-1 truncate">
                      {g.section === null ? item.name : styleSection(item.name).display}
                    </span>
                    {appliedId === item.id && (
                      <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] text-accent">
                        {t.appliedBadge}
                      </span>
                    )}
                  </button>
                ))}
            </div>
          );
        })}
      </div>

      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t.menuRename, onClick: () => startRename(menu.item) },
            { label: t.menuDelete, danger: true, onClick: () => confirmRemove(menu.item) },
          ]}
        />
      )}
    </div>
  );
}

/** 행 왼쪽의 한 눈 미리보기 — 색 칩 / `가나 Ag` 표본 / 효과 요약. */
function Sample({ slot, item }: { slot: StyleSlot; item: StyleDef }) {
  const msg = useMessages();
  if (slot === "text" && "style" in item) {
    const t = item.style;
    return (
      <span
        style={{
          fontFamily: t.fontFamily,
          fontWeight: t.fontWeight,
          fontStyle: t.italic ? "italic" : "normal",
        }}
        // 표본은 **크기를 따라가지 않는다** — 28px 스타일 하나가 행 높이를 밀어 목록이
        // 들쭉날쭉해진다. 글꼴·굵기·기울임만 눈으로, 나머지는 아래 캡션이 숫자로 말한다.
        title={`${t.fontFamily} ${t.fontWeight} ${t.fontSize} · ${t.lineHeight}%`}
        className="w-8 shrink-0 truncate text-fg"
      >
        {msg.imagePanels.styleLibrary.textSample}
      </span>
    );
  }
  if (slot === "effect" && "effects" in item) {
    const labels = effectLabels(msg);
    return (
      <span className="w-8 shrink-0 truncate text-[9px] text-fg-dim">
        {item.effects.map((e) => labels[e.type]).join(" · ") ||
          msg.imagePanels.styleLibrary.noEffects}
      </span>
    );
  }
  if (!("paint" in item)) return null;
  return (
    <span
      style={{ background: paintCss(item.paint) }}
      className="h-[14px] w-[14px] shrink-0 rounded border border-edge"
    />
  );
}

export interface RowMenuItem {
  label: string;
  danger?: boolean;
  onClick(): void;
}

/**
 * 행 우클릭 메뉴(이름 변경·삭제).
 *
 * 저장소에 공용 컨텍스트 메뉴 프리미티브가 없어(`ViewerFileTabs`·`LayerPanel` 이 각자 만든다)
 * 첫 사용처인 여기 둔다 — `AssetsPanel` 이 같은 것을 쓴다. 백드롭이 바깥 클릭과 **우클릭까지**
 * 삼키는 것이 관례다: 우클릭을 흘리면 메뉴가 열린 채 브라우저 기본 메뉴가 겹쳐 뜬다.
 */
export function RowMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: readonly RowMenuItem[];
  onClose(): void;
}) {
  const w = 120;
  const h = items.length * 26 + 8;
  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        style={{
          left: Math.min(x, window.innerWidth - w - 8),
          top: Math.min(y, Math.max(8, window.innerHeight - h - 8)),
          minWidth: w,
        }}
        className="fixed rounded-md border border-edge bg-panel py-1 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            // 닫고 나서 실행한다 — 확인창·프롬프트가 이 백드롭 **아래** 깔리면 클릭이 통째로
            // 백드롭에 먹혀 버튼이 죽은 것처럼 보인다.
            onClick={() => {
              onClose();
              it.onClick();
            }}
            style={{ height: 26 }}
            className={`block w-full px-3 text-left text-[11px] hover:bg-raised ${
              it.danger ? "text-danger" : "text-fg-muted hover:text-fg"
            }`}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}
