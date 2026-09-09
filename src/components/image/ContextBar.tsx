// 컨텍스트 바 — 스테이지 위 44px 한 줄. 선택 종류(§3.1 7변형)에 따라 내용이 통째로 바뀐다.
//
// **여기에 문서 로직은 없다.** 버튼은 전부 `actions` 의 함수를 부르고, 그 함수는 단축키 표(42)가
// 부르는 것과 **같은 함수**다. 이 파일이 `patchDoc` 을 직접 부르기 시작하면 같은 조작이 키와
// 버튼에서 갈라진다 — 히스토리 라벨이 먼저 어긋나고, 그다음엔 한쪽만 정규화를 탄다.
//
// **없는 기능은 그리지 않는다**(INDEX §10.4). text·vector-edit·crop 변형의 알맹이는 50·47·48 이
// 소유하고 아직 없어서, 그 자리에는 무엇이 선택됐는지만 적는다. 회색 버튼으로 채워 두면
// 사용자는 눌러 보고 나서야 아무 일도 안 난다는 것을 알고, 그때는 앱이 고장 난 것으로 읽는다.
// 벡터 연산(46)도 같은 이유로 `canVector` **prop** 이다 — `actions.vectorOp` 의 존재로 지금
// 그 연산이 되는지를 추측하면 안 된다. 액션 맵은 아무 일도 안 하는 함수도 들 수 있고, 판정은
// `vectorActions.can` 한 곳에서만 나와야 버튼과 단축키가 갈라지지 않는다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.1·§3.2

import { useMemo, useState, type ReactNode } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Component,
  Copy,
  Crop,
  FlipHorizontal,
  FlipVertical,
  Frame,
  Grid3x3,
  Group,
  ImageIcon,
  Magnet,
  MousePointer2,
  PenTool,
  RotateCcw,
  RotateCw,
  Ruler,
  Square,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Sun,
  Trash2,
  Type,
  type LucideIcon,
} from "lucide-react";

import type { AlignMode } from "../../lib/annotate/align";
import { BLEND_LABELS } from "../../lib/annotate/blend-labels";
import {
  defaultLayerName,
  layerTypeOf,
  type LayerType,
} from "../../lib/annotate/layer-rows";
import { MIXED, readProp, type Maybe, type SelectionKind } from "../../lib/annotate/selection";
import {
  EDITOR_SHORTCUTS,
  formatShortcut,
  type ShortcutId,
} from "../../lib/annotate/shortcuts";
import { isContainer } from "../../lib/annotate/tree";
import type {
  BlendMode,
  DefaultPaint,
  Fill,
  Node,
  NodeBase,
  ObjId,
} from "../../lib/annotate/types";
import type { BoolOp } from "../../lib/annotate/vector/boolean";
import type { CropSession } from "../../lib/annotate/crop";
import { useImageEditorUi } from "../../stores/imageEditor";
import { CropContextBar } from "./CropContextBar";
import type { CropApi } from "./useCropSession";
import { NumField } from "./inspector/fields/NumField";
import type { PathOp } from "./vector/PathInspectorSection";
import { BlendMenu } from "./popovers/BlendMenu";
import { Popover } from "./popovers/Popover";

export type { BoolOp };

/** `patchSelection` 이 받는 것 — 페인트 스택 필드(37 `DefaultPaint`) + 노드 공통 속성 몇 개. */
export type SelectionPatch = Partial<DefaultPaint> &
  Partial<Pick<NodeBase, "opacity" | "blend" | "name" | "visible" | "locked" | "constraints">>;

/**
 * 편집기 액션 맵(45 §4) — 단축키 표(42)와 이 바·인스펙터가 **같은 함수**를 부르는 접점.
 *
 * 구현은 `ImageEditor` 가 든다. 선언이 여기 있는 것은 그 파일이 아직 액션 맵을 노출하지 않아서다 —
 * 통합 단계에서 `ImageEditor.tsx` 로 옮기고 이 파일은 import 만 하면 된다.
 */
export interface EditorActions {
  /** 선택 전체에 같은 값(37 `applyPaintPatch` 경유). `live` 면 히스토리 한 칸을 replace 한다. */
  patchSelection(patch: SelectionPatch, label: string, live?: boolean): void;
  setFrame(
    id: ObjId,
    f: Partial<{ x: number; y: number; w: number; h: number; rot: number }>,
    label: string,
    live?: boolean,
  ): void;
  /**
   * 라이브 구간 봉인. **스크럽 뒤에 반드시 불러야** 다음 편집이 새 히스토리 칸이 된다 —
   * 빠뜨리면 드래그 이후의 모든 변경이 그 한 칸에 계속 겹쳐 쌓여 되돌리기가 통째로 뭉개진다.
   */
  endLive(): void;
  align(mode: AlignMode): void;
  distribute(axis: "x" | "y"): void;
  tidy(gap: number | "auto"): void;
  flip(axis: "h" | "v"): void;
  rotate(deg: 90 | -90): void;
  group(kind: "group" | "frame"): void;
  ungroup(): void;
  mask(on: boolean): void;
  duplicate(): void;
  remove(): void;
  /**
   * 46 벡터 연산 — 불리언 4연산·평탄화·윤곽선화·패스 분리가 **함수 하나**다
   * (`ImageEditor.vectorActions`). 45 가 `boolean(op)` 로 자리만 잡아 둔 것을 46 이 넓혔다:
   * 연산마다 진입점을 따로 두면 어느 한쪽만 선택을 옮기거나 라벨을 다르게 다는 날이 온다.
   */
  vectorOp(op: PathOp): void;
  /** 이미지 **전체** 변형(기존 `rotateBy`/`flipBy`) — 선택 대상 `rotate`/`flip` 과 다른 축이다. */
  rotateImage(plus90: boolean): void;
  flipImage(axis: "h" | "v"): void;
}

export interface ContextBarProps {
  kind: SelectionKind;
  actions: EditorActions;
  /** 문서 노드 전부 — 선택 노드 조회와 표시 이름 순번(`defaultLayerName`)이 필요로 한다. */
  objects: readonly Node[];
  /** 화면 배율(1 = 100%). `EditorTitleBar` 와 같은 계약 — 100% 환산은 부모 몫이다. */
  zoom: number;
  onZoom(target: number | "fit"): void;
  /** oriented 원본 크기(시안 ⑧ `원본 크기 2880×1605`). 아직 안 읽혔으면 null. */
  imageSize: { w: number; h: number } | null;
  /**
   * 46 벡터 연산 게이트(`vectorActions.can` 한 곳이 낸다). **지금 할 수 있는 것만 그린다** —
   * 잠긴 회색 버튼으로 채우면 사용자는 눌러 보고 나서야 안 되는 줄 알고, 그때는 앱이 고장 난
   * 것으로 읽는다. 생략하면(=46 미도착) 벡터 버튼이 통째로 사라진다.
   */
  canVector?: Partial<Record<PathOp, boolean>>;
  /**
   * 48 크롭 세션. 모드에 들어가도 이미지가 아직 안 읽혔으면 세션이 없다 — 그때는 이 prop 이
   * 없고 바는 '크롭' 라벨만 그린다(`canVector` 와 같은 규칙: 없는 기능은 안 그린다).
   */
  crop?: { session: CropSession; api: CropApi; maxDeg: number };
}

/** 툴팁 `<라벨> (<키>)`. 대안 키가 있는 행은 첫 번째만 쓴다(`EditorTitleBar` 와 같은 규칙). */
function tip(id: ShortcutId): string {
  const s = EDITOR_SHORTCUTS.find((x) => x.id === id);
  return s ? `${s.label} (${formatShortcut(s).split("·")[0]})` : "";
}

// `layers/LayerRow.tsx:39 TYPE_ICON` 과 같은 표다(그쪽이 비공개라 복제했다). 두 곳이 갈리면
// 같은 객체가 레이어 패널과 이 바에서 다른 그림으로 보인다 — 한쪽을 고치면 다른 쪽도 고쳐라.
const KIND_ICON: Record<LayerType, LucideIcon> = {
  frame: Frame,
  group: Group,
  shape: Square,
  text: Type,
  image: ImageIcon,
  vector: PenTool,
  component: Component,
};

const ALIGNS: readonly { mode: AlignMode; id: ShortcutId; icon: LucideIcon }[] = [
  { mode: "left", id: "align.left", icon: AlignStartVertical },
  { mode: "hcenter", id: "align.hcenter", icon: AlignCenterVertical },
  { mode: "right", id: "align.right", icon: AlignEndVertical },
  { mode: "top", id: "align.top", icon: AlignStartHorizontal },
  { mode: "vcenter", id: "align.vcenter", icon: AlignCenterHorizontal },
  { mode: "bottom", id: "align.bottom", icon: AlignEndHorizontal },
];

const BOOLS: readonly { op: BoolOp; id: ShortcutId; icon: LucideIcon }[] = [
  { op: "union", id: "bool.union", icon: SquaresUnite },
  { op: "subtract", id: "bool.subtract", icon: SquaresSubtract },
  { op: "intersect", id: "bool.intersect", icon: SquaresIntersect },
  { op: "exclude", id: "bool.exclude", icon: SquaresExclude },
];

/** 시안 ⑧ 의 Seg 3칸. 나머지 16종은 `BlendMenu`(45 4단계) 몫이다. */
const BLEND_SEG: readonly BlendMode[] = ["normal", "multiply", "screen"];

function blendLabel(v: BlendMode): string {
  return BLEND_LABELS.find((b) => b.value === v)?.label ?? v;
}

const BTN =
  "flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-fg-muted hover:bg-raised hover:text-fg";
const ON = "bg-accent/15 text-accent";

function Btn({
  title,
  onClick,
  pressed,
  children,
}: {
  title: string;
  onClick(): void;
  /** 토글 버튼만 넘긴다 — 한 번 하고 끝나는 동작에 `aria-pressed` 를 달면 상태가 있는 것처럼 읽힌다. */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
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

/** 필드 하나가 들어갈 고정 폭 — 바는 flex 라 놔두면 NumField 가 남은 폭을 전부 먹는다. */
function Field({ children }: { children: ReactNode }) {
  return <div className="w-[7.5rem] shrink-0">{children}</div>;
}

/** 첫 **보이는** 겹 — 스택 전체 편집은 인스펙터 몫이고, 바는 대표값 한 겹만 보여 준다. */
function topPaint(stack: readonly Fill[]): Fill | null {
  return stack.find((f) => f.visible) ?? null;
}

/** 스와치 배경. 그라디언트도 실제 스톱으로 그린다 — 빈 칸이면 색을 깔았는지 알 수 없다. */
function swatchBg(p: Fill | null): string | undefined {
  if (!p) return undefined;
  if (p.type === "solid") return p.color;
  if (p.type === "image" || p.stops.length === 0) return undefined;
  return `linear-gradient(90deg, ${p.stops
    .map((s) => `${s.color} ${Math.round(s.pos * 100)}%`)
    .join(", ")})`;
}

function PaintChip({
  label,
  paint,
  text,
  onClick,
}: {
  label: string;
  paint: Fill | null;
  text: string;
  onClick(): void;
}) {
  const bg = swatchBg(paint);
  return (
    <button
      type="button"
      // 색 피커 팝오버(45 4단계)가 붙기 전까지는 속성 탭으로 보내는 것이 전부다. 아무 일도
      // 안 하는 스와치보다는 편집할 수 있는 곳으로 데려가는 편이 낫다(툴 레일 스와치와 같은 처리).
      title={`${label} — 속성 탭에서 편집`}
      onClick={onClick}
      className={BTN}
    >
      <span
        style={{ background: bg }}
        className={`h-3.5 w-3.5 shrink-0 rounded-[2px] border ${
          bg ? "border-edge" : "border-dashed border-fg-dim"
        }`}
      />
      <span className="font-mono text-[11px]">{text}</span>
    </button>
  );
}

function paintText(p: Fill | null): string {
  if (!p) return "없음";
  if (p.type === "solid") return p.color.replace("#", "").toUpperCase();
  return p.type === "image" ? "이미지" : "그라디언트";
}

/** 담당 태스크의 콘텐츠가 아직 없는 변형 — 무엇이 선택됐는지만 적는다. */
function SlotLabel({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <>
      <Icon size={14} className="shrink-0 text-fg-dim" />
      <span className="truncate text-fg-muted">{text}</span>
    </>
  );
}

function BlendSeg({
  value,
  container,
  onChange,
}: {
  value: Maybe<BlendMode> | undefined;
  /** 고른 것이 전부 컨테이너인가 — `pass-through` 의 가부가 여기서 갈린다(`BlendMenu`). */
  container: boolean;
  onChange(v: BlendMode): void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (value === undefined) return null;
  return (
    <div className="flex shrink-0 items-center rounded bg-raised p-0.5 text-[11px]">
      {BLEND_SEG.map((v) => {
        // MIXED 면 어느 칸도 눌린 상태가 아니다 — 첫 칸을 켜 두면 여러 값이 섞인 선택이
        // "전부 표준"으로 보이고, 사용자는 자기가 바꾼 적 없는 값을 그대로 믿는다.
        const on = value === v;
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(v)}
            className={`rounded px-1.5 py-0.5 ${
              on ? "bg-panel text-fg" : "text-fg-dim hover:text-fg"
            }`}
          >
            {blendLabel(v)}
          </button>
        );
      })}
      {/* Seg 3칸 밖의 16종. 현재값이 그 16종 중 하나면 어느 칸도 안 눌린 채로 보이는데,
          이 캐럿이 없으면 그 값이 무엇인지 확인할 방법도 되돌릴 방법도 화면에 없다. */}
      <button
        type="button"
        title="블렌드 모드 전체"
        onClick={(e) => setAnchor(e.currentTarget)}
        className="rounded px-1.5 py-0.5 text-fg-dim hover:text-fg"
      >
        …
      </button>
      {anchor && (
        <Popover anchor={anchor} open onClose={() => setAnchor(null)} title="블렌드">
          <BlendMenu
            value={value}
            container={container}
            onChange={(v) => {
              onChange(v);
              setAnchor(null);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

// ── 변형 ────────────────────────────────────────────────────────────────────

function NoneBar({
  zoom,
  onZoom,
}: {
  zoom: number;
  onZoom(target: number | "fit"): void;
}) {
  const toggles = useImageEditorUi((s) => s.toggles);
  const setToggle = useImageEditorUi((s) => s.setToggle);

  return (
    <>
      {/* 시안 ⑧ 의 `캔버스` 칩은 라벨뿐이다 — 이 앱에 캔버스 배경색 개념이 없다(INDEX §10.5). */}
      <SlotLabel icon={MousePointer2} text="캔버스" />
      <Sep />

      <Btn
        title={tip("view.rulers")}
        pressed={toggles.rulers}
        onClick={() => setToggle("rulers", !toggles.rulers)}
      >
        <Ruler size={14} />
      </Btn>
      <Btn
        title={tip("view.pixelGrid")}
        pressed={toggles.pixelGrid}
        onClick={() => setToggle("pixelGrid", !toggles.pixelGrid)}
      >
        <Grid3x3 size={14} />
      </Btn>
      <Btn
        title="자석(스냅)"
        pressed={toggles.snap}
        onClick={() => setToggle("snap", !toggles.snap)}
      >
        <Magnet size={14} />
      </Btn>

      <Sep />
      <Field>
        <NumField
          label="줌"
          value={Math.round(zoom * 100)}
          unit="%"
          min={1}
          max={6400}
          step={10}
          onCommit={(v) => onZoom(v / 100)}
          // 줌은 문서가 아니라 화면 상태다 — 라이브/커밋을 가를 히스토리가 없어 같은 함수다.
          onLive={(v) => onZoom(v / 100)}
        />
      </Field>
      <Btn title={tip("zoom.fit")} onClick={() => onZoom("fit")}>
        맞춤
      </Btn>
    </>
  );
}

function ShapeBar({
  node,
  objects,
  actions,
  canVector,
}: {
  node: Node;
  objects: readonly Node[];
  actions: EditorActions;
  canVector: Partial<Record<PathOp, boolean>>;
}) {
  const setTab = useImageEditorUi((s) => s.setTab);
  const openProps = () => setTab("inspector", "props");
  const Icon = KIND_ICON[layerTypeOf(node)];

  // 반경은 rect·frame 에만 있다. 없으면 `undefined` 로 넘겨 **필드를 지운다** — 0 으로 넘기면
  // 타원에 반경 칸이 생기고, 거기 적은 값은 어디에도 반영되지 않는다.
  const r = "radius" in node ? node.radius : null;
  const radius: Maybe<number> | undefined =
    r === null ? undefined : r.every((v) => v === r[0]) ? r[0] : MIXED;

  const fill = topPaint(node.fills);
  const stroke = topPaint(node.strokes);

  return (
    <>
      <SlotLabel icon={Icon} text={node.name ?? defaultLayerName(node, objects)} />
      <Sep />

      <PaintChip label="채우기" paint={fill} text={paintText(fill)} onClick={openProps} />
      <PaintChip
        label="선"
        paint={stroke}
        text={`선 ${Math.round(node.strokeWidth)}`}
        onClick={openProps}
      />

      <Sep />
      <Field>
        <NumField
          label="반경"
          value={radius}
          min={0}
          onCommit={(v) => actions.patchSelection({ radius: [v, v, v, v] }, `반경 ${v}`)}
          onLive={(v) => actions.patchSelection({ radius: [v, v, v, v] }, `반경 ${v}`, true)}
          onLiveEnd={actions.endLive}
        />
      </Field>
      <Field>
        <NumField
          label="불투명도"
          value={Math.round(node.opacity * 100)}
          unit="%"
          min={0}
          max={100}
          onCommit={(v) => actions.patchSelection({ opacity: v / 100 }, `불투명도 ${v}%`)}
          onLive={(v) => actions.patchSelection({ opacity: v / 100 }, `불투명도 ${v}%`, true)}
          onLiveEnd={actions.endLive}
        />
      </Field>

      <Sep />
      <BlendSeg
        value={node.blend}
        container={isContainer(node)}
        onChange={(v) => actions.patchSelection({ blend: v }, `블렌드 ${blendLabel(v)}`)}
      />

      {/* 시안 ③ 컨텍스트 바 `평탄화 · 윤곽선화`. 도형 하나에 건 평탄화가 곧 '패스로'다
          (§3.6) — `패스로` 전용 버튼은 두지 않는다(시안 라벨 0건, §3.9). */}
      {(canVector.flatten || canVector.outline) && (
        <>
          <Sep />
          {canVector.flatten && (
            <Btn title={tip("flatten")} onClick={() => actions.vectorOp("flatten")}>
              평탄화
            </Btn>
          )}
          {canVector.outline && (
            <Btn title={tip("outline")} onClick={() => actions.vectorOp("outline")}>
              윤곽선화
            </Btn>
          )}
        </>
      )}

      <Sep />
      {/* 하나만 골랐을 때의 정렬 기준은 캔버스다(`align.ts` keyId=null) — 액션이 정한다. */}
      <Btn title={tip("align.hcenter")} onClick={() => actions.align("hcenter")}>
        <AlignCenterVertical size={14} />
      </Btn>
      {isContainer(node) && (
        <Btn title={tip("ungroup")} onClick={actions.ungroup}>
          그룹 해제
        </Btn>
      )}
      <Btn title={tip("duplicate")} onClick={actions.duplicate}>
        <Copy size={14} />
      </Btn>
      <Btn title={tip("delete")} onClick={actions.remove}>
        <Trash2 size={14} />
      </Btn>
    </>
  );
}

function MultiBar({
  nodes,
  count,
  actions,
  canVector,
}: {
  nodes: readonly Node[];
  count: number;
  actions: EditorActions;
  canVector: Partial<Record<PathOp, boolean>>;
}) {
  const tidyGap = useImageEditorUi((s) => s.tidyGap);

  // 반올림은 **비교 뒤**다. getter 안에서 반올림하면 0.501 과 0.504 가 같은 50 으로 읽혀
  // MIXED 가 사라진다 — 속성 탭은 '혼합'을 보여 주는데 이 바만 확정값 50 을 보여 주고,
  // 일부러 죽여 둔 스크럽(`onDelta` 없음 → mixed 면 잠긴다)이 되살아나 드래그 한 번이
  // 서로 다른 두 값을 하나로 뭉갠다.
  const opacityRaw = readProp(nodes, (n) => n.opacity);
  const opacity = typeof opacityRaw === "number" ? Math.round(opacityRaw * 100) : opacityRaw;
  const blend = readProp(nodes, (n) => n.blend);

  return (
    <>
      {/* `N개 선택` 은 자기 span 안에 홀로 둔다 — e2e 30 `selCount` 가 이 문구를 담은 가장
          안쪽 요소를 찾는다(상태바와 같은 계약). 옆 글자를 같은 노드에 붙이면 개수가 어긋난다. */}
      <span className="shrink-0 tabular-nums text-fg-muted">{count}개 선택</span>
      <Sep />

      {ALIGNS.map((a) => (
        <Btn key={a.mode} title={tip(a.id)} onClick={() => actions.align(a.mode)}>
          <a.icon size={14} />
        </Btn>
      ))}

      {/* 분배는 3개 이상이어야 놓을 자리가 생긴다(`distributeObjects` 는 그 아래에서 항등) —
          눌러도 아무 일 없는 버튼을 두는 대신 아예 숨긴다. */}
      {nodes.length >= 3 && (
        <>
          <Sep />
          <Btn title={tip("distribute.h")} onClick={() => actions.distribute("x")}>
            <AlignHorizontalDistributeCenter size={14} />
          </Btn>
          <Btn title={tip("distribute.v")} onClick={() => actions.distribute("y")}>
            <AlignVerticalDistributeCenter size={14} />
          </Btn>
        </>
      )}
      <Btn title={tip("tidy")} onClick={() => actions.tidy(tidyGap)}>
        간격 정리
      </Btn>

      {/* 텍스트·모자이크가 섞이면 `canBoolean` 이 거짓이라 아이콘 4개가 통째로 사라진다 —
          눌러도 아무 일 없는 버튼을 남기는 것보다 낫다(§3.5 게이트). 평탄화는 게이트가 더
          넓다(컨테이너도 리프까지 펴서 받는다) — 그래서 조건을 따로 본다. */}
      {(canVector.union || canVector.flatten) && (
        <>
          <Sep />
          {canVector.union &&
            BOOLS.map((b) => (
              <Btn key={b.op} title={tip(b.id)} onClick={() => actions.vectorOp(b.op)}>
                <b.icon size={14} />
              </Btn>
            ))}
          {canVector.flatten && (
            <Btn title={tip("flatten")} onClick={() => actions.vectorOp("flatten")}>
              평탄화
            </Btn>
          )}
        </>
      )}

      <Sep />
      <Btn title="좌우 반전" onClick={() => actions.flip("h")}>
        <FlipHorizontal size={14} />
      </Btn>
      <Btn title="상하 반전" onClick={() => actions.flip("v")}>
        <FlipVertical size={14} />
      </Btn>
      {/* 제목에 `오른쪽 90` 을 쓰지 마라 — e2e 30 (c) 가 그 문자열로 **이미지 전체** 회전
          버튼(조정 탭)을 찾는다. 이 바가 문서 순서상 먼저라 선택 회전이 대신 눌린다. */}
      <Btn title="반시계 방향 90° 회전" onClick={() => actions.rotate(-90)}>
        <RotateCcw size={14} />
      </Btn>
      <Btn title="시계 방향 90° 회전" onClick={() => actions.rotate(90)}>
        <RotateCw size={14} />
      </Btn>

      <Sep />
      <Btn title={tip("mask")} onClick={() => actions.mask(true)}>
        마스크로 사용
      </Btn>
      <Btn title={tip("group")} onClick={() => actions.group("group")}>
        그룹
      </Btn>

      <Sep />
      <Field>
        <NumField
          label="불투명도"
          value={opacity}
          unit="%"
          min={0}
          max={100}
          onCommit={(v) => actions.patchSelection({ opacity: v / 100 }, `불투명도 ${v}%`)}
          // 스크럽·방향키는 단일값일 때만 산다. MIXED 의 상대 델타(§3.4)는 "각 객체 현재값 + Δ"
          // 라 패치 한 장으로 표현할 수 없다 — 액션에 델타 함수가 생기면 `onDelta` 를 잇는다.
          onLive={(v) => actions.patchSelection({ opacity: v / 100 }, `불투명도 ${v}%`, true)}
          onLiveEnd={actions.endLive}
        />
      </Field>
      <BlendSeg
        value={blend}
        // 하나라도 리프면 `pass-through` 는 못 쓴다 — 눌리면 37 정규화가 조용히 `normal` 로
        // 되돌려, 목록에서 고른 값과 문서에 남는 값이 달라진다.
        container={nodes.length > 0 && nodes.every(isContainer)}
        onChange={(v) => actions.patchSelection({ blend: v }, `블렌드 ${blendLabel(v)}`)}
      />
    </>
  );
}

function ImageBar({ size }: { size: { w: number; h: number } | null }) {
  const setTab = useImageEditorUi((s) => s.setTab);
  const setMode = useImageEditorUi((s) => s.setMode);

  return (
    <>
      <SlotLabel icon={ImageIcon} text="배경 이미지" />
      <Sep />
      {/*
        시안 ⑧ 은 밝기·대비·채도 세 버튼이 각자 그 슬라이더로 **포커스**한다. 지금은 셋 다 탭을
        여는 것 말고 할 일이 없어서(조정 탭은 45 3단계) 하나로 둔다 — 같은 일을 하는 버튼 셋은
        사용자가 둘은 고장 났다고 읽는다. 필드 포커스 훅이 생기면 그때 셋으로 나눈다.
      */}
      <Btn title="색 보정 — 밝기 · 대비 · 채도" onClick={() => setTab("inspector", "adjust")}>
        <Sun size={14} />
        색 보정
      </Btn>
      <Btn title={tip("mode.crop")} onClick={() => setMode({ kind: "crop" })}>
        <Crop size={14} />
        크롭
      </Btn>
      {size && (
        <>
          <Sep />
          <span className="shrink-0 tabular-nums text-fg-dim">
            원본 크기 {size.w} × {size.h}
          </span>
        </>
      )}
    </>
  );
}

export function ContextBar({
  kind,
  actions,
  objects,
  zoom,
  onZoom,
  imageSize,
  canVector = {},
  crop,
}: ContextBarProps) {
  const selectedIds = useImageEditorUi((s) => s.selectedIds);
  const mode = useImageEditorUi((s) => s.mode);
  // 선택 **순서**는 여기서 쓰지 않는다(정렬 기준 keyId 는 액션이 정한다) — 값 읽기는 문서 순서로 족하다.
  const nodes = useMemo(
    () => objects.filter((o) => selectedIds.includes(o.id)),
    [objects, selectedIds],
  );

  let body: ReactNode = null;
  switch (kind) {
    case "none":
      body = <NoneBar zoom={zoom} onZoom={onZoom} />;
      break;
    case "single-shape":
      // 선택 id 가 문서에 없을 수 있다(되돌리기 직후 한 프레임) — 그때는 빈 바다.
      body = nodes[0] ? (
        <ShapeBar
          node={nodes[0]}
          objects={objects}
          actions={actions}
          canVector={canVector}
        />
      ) : null;
      break;
    case "multi":
      body = (
        <MultiBar
          nodes={nodes}
          count={selectedIds.length}
          actions={actions}
          canVector={canVector}
        />
      );
      break;
    case "image":
      body = <ImageBar size={imageSize} />;
      break;
    case "text":
      // 50 `TextContextBarContent`(폰트 · 굵기 · 크기 · 행간 · 정렬 · 텍스트 스타일)의 자리.
      body = nodes[0] ? (
        <SlotLabel icon={Type} text={nodes[0].name ?? defaultLayerName(nodes[0], objects)} />
      ) : null;
      break;
    case "vector-edit": {
      // 47 `NodeContextBar`(정점 5모드 · 추가/삭제/닫기 · 편집 완료 ⏎)의 자리.
      const editing = mode.kind === "nodeEdit" ? objects.find((o) => o.id === mode.id) : null;
      body = (
        <SlotLabel
          icon={PenTool}
          text={editing ? (editing.name ?? defaultLayerName(editing, objects)) : "벡터 편집"}
        />
      );
      break;
    }
    case "crop":
      body = crop ? (
        <CropContextBar session={crop.session} api={crop.api} maxDeg={crop.maxDeg} />
      ) : (
        <SlotLabel icon={Crop} text="크롭" />
      );
      break;
  }

  return (
    // ponytail: 폭이 모자라면 가로 스크롤이다. 시안의 우선순위 접기(뒤 그룹부터 `…` 메뉴)는
    // 실제로 넘치는 창 폭이 확인되면 넣는다 — 지금 넣으면 접기 규칙을 추측으로 정하게 된다.
    <div
      role="toolbar"
      aria-label="컨텍스트"
      className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-edge bg-panel px-2 text-[12px]"
    >
      {body}
    </div>
  );
}
