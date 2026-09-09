// 인스펙터 **속성** 탭 — 시안 ① 의 `정렬·분배 · 위치·크기 · 모양 · 채우기 · 선 · 효과`.
//
// 값은 하나도 빠짐없이 `readProp` 으로 읽는다. "선택 첫 객체의 값을 보여 준다"가 이 파일에
// 한 줄도 없어야 하는 이유: v1 은 그 함정을 피하려고 다중 선택에서 패널 동기화를 아예
// 끊어 놨었다(ImageEditor.tsx:604). 세 상태를 각각 값 · `혼합` 빈 칸 · **필드 숨김**으로
// 그린다 — 뭉치는 순간 사용자는 "0"과 "값 없음"과 "여러 값"을 같은 칸으로 보고, 그 칸을
// 건드리는 것만으로 선택 전체를 모르는 값으로 덮는다.
//
// 쓰기는 `EditorActions` 하나로만 나간다. 단축키(42 표)와 이 패널이 같은 함수를 부르지
// 않으면 "버튼으로는 되는데 키로는 안 되는" 차이가 조용히 자란다.
//
// **선택이 비면 "다음에 만들 객체"의 기본 스타일을 편집한다**(v1 툴바 승계). 이 경로가
// 없으면 그리기 전에 색·두께를 고를 수단이 통째로 사라진다. 그때는 현재 도구가 쓰지 않는
// 필드를 숨긴다 — 펜을 든 채 모자이크 강도를 보여 주면 그 값이 지금 그리는 선에 반영되는
// 줄 안다.
//
// MIXED 스택(노드마다 다른 배열)은 **인덱스가 서로 다른 것을 가리킨다.** 그래서 눈·−·설정을
// 주지 않고 `+` 만 준다. 인덱스로 지웠다가는 A 의 두 번째 채우기와 B 의 두 번째 선이 함께
// 사라진다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.4·§3.6

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
  Link2,
  Link2Off,
  StretchHorizontal,
} from "lucide-react";

import type { AlignMode } from "../../../lib/annotate/align";
import { BLEND_LABELS } from "../../../lib/annotate/blend-labels";
import { isGeomNode, objectFrame } from "../../../lib/annotate/geometry";
import { MIXED, readProp, type Maybe } from "../../../lib/annotate/selection";
import { isContainer } from "../../../lib/annotate/tree";
import {
  DEFAULT_STROKE,
  PALETTE,
  solidFill,
  type BlendMode,
  type DefaultPaint,
  type Effect,
  type Fill,
  type MosaicMode,
  type Node,
  type ObjId,
} from "../../../lib/annotate/types";
import { useImageEditorUi, type Tool } from "../../../stores/imageEditor";
import {
  PathInspectorSection,
  type PathOp,
  type PathPatch,
} from "../vector/PathInspectorSection";
import { NumField, type NumFieldProps } from "./fields/NumField";
import { Select } from "./fields/Select";
import { StackList } from "./fields/StackList";
import { Toggle } from "./fields/Toggle";

// ── 계약 ────────────────────────────────────────────────────────────────────

/** 선택 전체에 쓰는 속성 묶음. `effects` 는 `DefaultPaint` 에 없어 따로 얹는다(37 §3.3). */
export type SelectionPatch = Partial<DefaultPaint> & {
  opacity?: number;
  blend?: BlendMode;
  effects?: Effect[];
};

export type FrameEdit = Partial<{ x: number; y: number; w: number; h: number; rot: number }>;

/** 스크럽·방향키가 만지는 프레임 축(각도는 비율 잠금이 없어 따로 다룬다). */
type FrameKey = "x" | "y" | "w" | "h";

/**
 * 편집기 액션 맵(45 §4). 구현은 `ImageEditor` 가 주입한다 — 여기 있는 것은 선언뿐이다.
 *
 * 두 함수가 **함수형 인자**를 받는 이유는 MIXED 다. 다중 선택에서 스크럽·방향키는 절대값이
 * 아니라 노드별 Δ 여야 하는데(§3.4 표), 같은 patch 를 전부에 쓰는 형태로는 반경 4/8 을
 * 5 로 뭉개는 것 말고 표현할 방법이 없다. 노드를 받아 그 노드의 patch 를 만들면 clamp 도
 * 노드별로 걸린다(§6 "반경 4/8 에 −5 → 음수").
 *
 * `setFrame` 이 `ids` 를 받는 것도 같은 갈래다 — 노드마다 따로 부르면 프레임 편집 한 번이
 * 히스토리 N 칸이 되고, Ctrl+Z 한 번에 객체 하나만 되돌아온다.
 */
export interface EditorActions {
  patchSelection(
    patch: SelectionPatch | ((node: Node) => SelectionPatch | null),
    label: string,
    live?: boolean,
  ): void;
  /** 스크럽·슬라이더 라이브 구간 종료 — 다음 변경이 새 히스토리 칸이 된다. */
  endLive(): void;
  setFrame(
    ids: readonly ObjId[],
    edit: FrameEdit | ((cur: { x: number; y: number; w: number; h: number; rot: number }) => FrameEdit),
    label: string,
    live?: boolean,
  ): void;
  align(mode: AlignMode): void;
  distribute(axis: "x" | "y"): void;
  tidy(gap: number | "auto"): void;
  /** `tree.makeMask`/`releaseMask`(38) — 그룹 감싸기까지 그쪽이 한다. */
  mask(on: boolean): void;
  /**
   * 46 패스 속성. `patchSelection` 과 갈라 두는 이유는 **키 집합**이다 — 정렬·대시·캡·조인·
   * 마이터·화살촉·fillRule·subpaths 는 `DefaultPaint` 에 없어서 `applyPaintPatch`(37)가
   * 말없이 버린다(switch 에 default 가 없다). 여기로 오는 것만 노드에 직접 얹는다.
   */
  pathPatch(patch: PathPatch, label: string, live?: boolean): void;
  /** 46 벡터 연산 — 컨텍스트 바·단축키와 **같은 함수**(`ImageEditor.vectorActions`). */
  vectorOp(op: PathOp): void;
}

export type PaintSlot = "fills" | "strokes";

/** 팝오버 요청 — 띄우는 것은 호출자(45 통합) 몫이다. 여기서는 앵커만 올린다. */
export type PropsPopoverRequest =
  | { kind: "paint"; slot: PaintSlot; index: number; anchor: HTMLElement }
  | { kind: "effect"; index: number; anchor: HTMLElement };

export interface PropsTabProps {
  /** 선택된 노드. **순서가 선택 순서**다(정렬 기준은 마지막 — 판정은 `actions.align` 안). */
  nodes: readonly Node[];
  actions: EditorActions;
  /** 선택이 비었을 때 편집 대상 — "다음에 만들 객체"의 스타일. */
  style: DefaultPaint;
  /** 선택이 비었을 때의 불투명도(0–1). */
  opacity: number;
  recentColors: readonly string[];
  onOpenPopover(req: PropsPopoverRequest): void;
  /** 46 벡터 연산 게이트 — 판정은 `vectorActions.can` 한 곳이 낸다(버튼과 키가 같은 판정). */
  canVector: Record<PathOp, boolean>;
}

// ── 도구별 기본 스타일 노출 범위(v1 AnnotationToolbar 승계) ──────────────────

const FILL_TOOLS = new Set<Tool>(["rect", "ellipse"]);
const STROKE_TOOLS = new Set<Tool>([
  "pen",
  "highlight",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "badge",
]);
const WIDTH_TOOLS = new Set<Tool>(["pen", "highlight", "line", "arrow", "rect", "ellipse"]);

const ALIGNS: { mode: AlignMode; title: string; Icon: typeof AlignStartVertical }[] = [
  { mode: "left", title: "왼쪽", Icon: AlignStartVertical },
  { mode: "hcenter", title: "가로 가운데", Icon: AlignCenterVertical },
  { mode: "right", title: "오른쪽", Icon: AlignEndVertical },
  { mode: "top", title: "위", Icon: AlignStartHorizontal },
  { mode: "vcenter", title: "세로 가운데", Icon: AlignCenterHorizontal },
  { mode: "bottom", title: "아래", Icon: AlignEndHorizontal },
];

const SLOT_LABEL: Record<PaintSlot, string> = { fills: "채우기", strokes: "선" };

const GRADIENT_LABEL: Record<string, string> = {
  linear: "선형 그라디언트",
  radial: "방사형 그라디언트",
  angular: "원뿔 그라디언트",
  diamond: "다이아 그라디언트",
};

/** 시안 ① `드롭 섀도 0·4 12 25%` — `효과 +` 가 처음 만드는 값(§7 ins-12). */
const NEW_EFFECT: Effect = {
  type: "drop-shadow",
  x: 0,
  y: 4,
  blur: 12,
  spread: 0,
  color: "#000000",
  opacity: 0.25,
  visible: true,
};

const MOSAIC_MODES: { value: MosaicMode; label: string }[] = [
  { value: "pixelate", label: "픽셀화" },
  { value: "blur", label: "블러" },
];

export function PropsTab({
  nodes,
  actions,
  style,
  opacity,
  recentColors,
  onOpenPopover,
  canVector,
}: PropsTabProps) {
  const tool = useImageEditorUi((s) => s.tool);
  const ratioLock = useImageEditorUi((s) => s.ratioLock);
  const tidyGap = useImageEditorUi((s) => s.tidyGap);
  const [perCorner, setPerCorner] = useState(false);

  const ids = nodes.map((n) => n.id);
  const empty = nodes.length === 0;

  // 프레임을 필드마다 다시 계산하지 않는다 — `objectFrame` 은 pen/path 에서 점을 전부 훑는다.
  const frames = useMemo(
    () => new Map(nodes.map((n) => [n.id, isGeomNode(n) ? objectFrame(n) : undefined])),
    [nodes],
  );

  const read = <T,>(get: (n: Node) => T | undefined, fallback: T | undefined, eq?: (a: T, b: T) => boolean) =>
    empty ? fallback : readProp(nodes, get, eq);

  const frameVal = (k: "x" | "y" | "w" | "h" | "rot") =>
    empty ? undefined : readProp(nodes, (n) => frames.get(n.id)?.[k]);

  const fills = read((n) => (takesPaint(n) ? n.fills : undefined), FILL_TOOLS.has(tool) ? style.fills : undefined, sameJson);
  const strokes = read(
    (n) => (takesPaint(n) ? n.strokes : undefined),
    STROKE_TOOLS.has(tool) ? style.strokes : undefined,
    sameJson,
  );
  const strokeWidth = read(
    (n) => (takesPaint(n) ? n.strokeWidth : undefined),
    WIDTH_TOOLS.has(tool) ? style.strokeWidth : undefined,
  );
  const effects = read((n) => n.effects, undefined, sameJson);
  const radius = read(
    (n) => (n.kind === "rect" || n.kind === "frame" ? n.radius : undefined),
    tool === "rect" ? style.radius : undefined,
    sameJson,
  );
  const opacityPct = mapMaybe(
    read(
      (n) => n.opacity,
      STROKE_TOOLS.has(tool) && tool !== "highlight" ? opacity : undefined,
    ),
    (v) => Math.round(v * 100),
  );
  const blend = read((n) => n.blend, undefined);
  const masked = read((n) => n.mask !== null, undefined);
  const mosaicMode = read(
    (n) => (n.kind === "mosaic" ? n.mode : undefined),
    tool === "mosaic" ? style.mosaicMode : undefined,
  );
  const mosaicStrength = read(
    (n) => (n.kind === "mosaic" ? n.strength : undefined),
    tool === "mosaic" ? style.mosaicStrength : undefined,
  );

  // `pass-through` 는 컨테이너 전용이다 — 리프에 쓰면 37 정규화가 `normal` 로 되돌려
  // 사용자가 고른 값이 조용히 사라진다.
  const container = !empty && nodes.every((n) => isContainer(n));

  // ── 쓰기 ──────────────────────────────────────────────────────────────────

  const slotPatch = (slot: PaintSlot, list: Fill[]): SelectionPatch =>
    slot === "fills" ? { fills: list } : { strokes: list };

  /** 스택 편집. MIXED 는 노드마다 배열이 다르므로 함수형으로만 만질 수 있다. */
  const editPaints = (
    slot: PaintSlot,
    cur: Maybe<Fill[]>,
    f: (list: readonly Fill[]) => Fill[],
    label: string,
  ) =>
    actions.patchSelection(
      cur === MIXED
        ? (n) => (takesPaint(n) ? slotPatch(slot, f(slot === "fills" ? n.fills : n.strokes)) : null)
        : slotPatch(slot, f(cur)),
      label,
    );

  const editEffects = (cur: Maybe<Effect[]>, f: (list: readonly Effect[]) => Effect[], label: string) =>
    actions.patchSelection(
      cur === MIXED ? (n) => ({ effects: f(n.effects) }) : { effects: f(cur) },
      label,
    );

  const pickColor = (slot: PaintSlot, cur: Maybe<Fill[]>, hex: string) =>
    editPaints(slot, cur, (list) => withSolidHead(list, hex), `${SLOT_LABEL[slot]} ${hex.slice(1)}`);

  /** 비율 잠금은 **단일 선택에서만** 성립한다 — 노드마다 종횡비가 달라 같은 h 를 못 쓴다. */
  const frameEdit = (k: FrameKey, v: number): FrameEdit => {
    if (k === "x") return { x: v };
    if (k === "y") return { y: v };
    const only = nodes.length === 1 ? frames.get(nodes[0].id) : undefined;
    if (!ratioLock || !only || only.w <= 0 || only.h <= 0)
      return k === "w" ? { w: v } : { h: v };
    return k === "w" ? { w: v, h: (v * only.h) / only.w } : { h: v, w: (v * only.w) / only.h };
  };

  // 반환 타입을 못 박는다 — 객체 리터럴로 두면 `MIXED`(unique symbol)가 그냥 `symbol` 로
  // 넓어져 세 상태 구분이 타입에서 사라진다.
  const frameProps = (k: FrameKey, label: string): NumFieldProps => ({
    label,
    value: frameVal(k),
    min: k === "w" || k === "h" ? 0 : undefined,
    onCommit: (v: number) => actions.setFrame(ids, frameEdit(k, v), `${label} ${v}`),
    onLive: (v: number) => actions.setFrame(ids, frameEdit(k, v), `${label} ${v}`, true),
    onLiveEnd: actions.endLive,
    // MIXED 는 노드마다 현재값이 다르다 — 절대값을 쓰면 서로 다른 위치가 한 점으로 모인다.
    onDelta: (d: number, live: boolean) =>
      actions.setFrame(ids, (cur) => frameDelta(k, cur, d), `${label} 조정`, live),
  });

  const radiusLabel = (v: number) => `반경 ${v}`;

  const setRadius = (v: number, live = false) =>
    actions.patchSelection({ radius: [v, v, v, v] }, radiusLabel(v), live);

  const setCorner = (i: number, v: number, live = false) =>
    actions.patchSelection(
      (n) =>
        n.kind === "rect" || n.kind === "frame"
          ? { radius: replaceAt(n.radius, i, Math.max(0, v)) }
          : null,
      radiusLabel(v),
      live,
    );

  const nudgeRadius = (d: number, live: boolean, corner?: number) =>
    actions.patchSelection(
      (n) => {
        if (n.kind !== "rect" && n.kind !== "frame") return null;
        // clamp 는 **노드별**이다. 여기서 뭉뚱그리면 반경 4/8 에 −5 를 준 순간 4 쪽이
        // 음수가 되어 렌더가 통째로 깨진다(§6 위험표).
        const next = n.radius.map((r, i) =>
          corner === undefined || corner === i ? Math.max(0, r + d) : r,
        ) as [number, number, number, number];
        return { radius: next };
      },
      `반경 ${d > 0 ? "+" : ""}${d}`,
      live,
    );

  return (
    <div>
      {/* 정렬은 하나만 골라도 뜻이 있다 — 기준이 캔버스가 된다(§3.5). 분배는 3개부터. */}
      {!empty && (
        <Group title="정렬 · 분배">
          <div className="flex flex-wrap items-center gap-1">
            {ALIGNS.map((a) => (
              <IconBtn key={a.mode} title={a.title} onClick={() => actions.align(a.mode)}>
                <a.Icon size={14} />
              </IconBtn>
            ))}
            <span className="mx-0.5 h-4 w-px bg-edge" />
            <IconBtn
              title="수평 분배"
              disabled={nodes.length < 3}
              onClick={() => actions.distribute("x")}
            >
              <AlignHorizontalDistributeCenter size={14} />
            </IconBtn>
            <IconBtn
              title="수직 분배"
              disabled={nodes.length < 3}
              onClick={() => actions.distribute("y")}
            >
              <AlignVerticalDistributeCenter size={14} />
            </IconBtn>
          </div>

          {nodes.length >= 2 && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => actions.tidy(tidyGap)}
                className="flex items-center gap-1 rounded bg-raised px-2 py-1 text-[12px] text-fg-muted hover:text-fg"
              >
                <StretchHorizontal size={13} /> 간격 정리
              </button>
              {typeof tidyGap === "number" && (
                <div className="min-w-0 flex-1">
                  <NumField
                    label="간격"
                    value={tidyGap}
                    unit="px"
                    min={0}
                    onCommit={(v) => useImageEditorUi.setState({ tidyGap: v })}
                  />
                </div>
              )}
              <button
                type="button"
                title="현재 간격의 중앙값을 쓴다"
                onClick={() =>
                  useImageEditorUi.setState({ tidyGap: tidyGap === "auto" ? 24 : "auto" })
                }
                className={`shrink-0 rounded px-1.5 py-1 text-[11px] ${
                  tidyGap === "auto" ? "bg-accent/20 text-accent" : "bg-raised text-fg-dim hover:text-fg"
                }`}
              >
                자동
              </button>
            </div>
          )}
        </Group>
      )}

      {frameVal("x") !== undefined && (
        <Group title="위치 · 크기">
          <div className="grid grid-cols-2 gap-x-2">
            <NumField {...frameProps("x", "X")} />
            <NumField {...frameProps("y", "Y")} />
            <NumField {...frameProps("w", "W")} />
            <NumField {...frameProps("h", "H")} />
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <NumField
                label="각도"
                value={frameVal("rot")}
                unit="°"
                onCommit={(v) => actions.setFrame(ids, { rot: v }, `각도 ${v}°`)}
                onLive={(v) => actions.setFrame(ids, { rot: v }, `각도 ${v}°`, true)}
                onLiveEnd={actions.endLive}
                onDelta={(d, live) =>
                  actions.setFrame(ids, (cur) => ({ rot: cur.rot + d }), "각도 조정", live)
                }
              />
            </div>
            <button
              type="button"
              title="비율 잠금"
              onClick={() => useImageEditorUi.setState({ ratioLock: !ratioLock })}
              className={`shrink-0 rounded px-1.5 py-1 ${
                ratioLock ? "bg-accent/20 text-accent" : "bg-raised text-fg-dim hover:text-fg"
              }`}
            >
              {ratioLock ? <Link2 size={13} /> : <Link2Off size={13} />}
            </button>
          </div>
        </Group>
      )}

      {(opacityPct !== undefined ||
        blend !== undefined ||
        radius !== undefined ||
        masked !== undefined ||
        mosaicMode !== undefined) && (
        <Group title="모양">
          <NumField
            label="불투명도"
            value={opacityPct}
            unit="%"
            min={0}
            max={100}
            onCommit={(v) => actions.patchSelection({ opacity: v / 100 }, `불투명도 ${v}%`)}
            onLive={(v) => actions.patchSelection({ opacity: v / 100 }, `불투명도 ${v}%`, true)}
            onLiveEnd={actions.endLive}
            onDelta={(d, live) =>
              actions.patchSelection(
                (n) => ({ opacity: clamp01(n.opacity + d / 100) }),
                `불투명도 ${d > 0 ? "+" : ""}${d}%`,
                live,
              )
            }
          />

          {blend !== undefined && (
            <div className="flex h-7 items-center gap-1.5">
              <span className="w-11 shrink-0 text-[11px] text-fg-dim">블렌드</span>
              <Select
                label="블렌드"
                value={blend}
                options={BLEND_LABELS.map((b) => ({
                  value: b.value,
                  label: b.label,
                  disabled: b.value === "pass-through" && !container,
                }))}
                onChange={(v) =>
                  actions.patchSelection(
                    { blend: v },
                    `블렌드 ${BLEND_LABELS.find((b) => b.value === v)?.label ?? v}`,
                  )
                }
              />
            </div>
          )}

          {radius !== undefined && (
            <>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <NumField
                    label="반경"
                    value={uniformRadius(radius)}
                    unit="px"
                    min={0}
                    onCommit={(v) => setRadius(v)}
                    onLive={(v) => setRadius(v, true)}
                    onLiveEnd={actions.endLive}
                    onDelta={(d, live) => nudgeRadius(d, live)}
                  />
                </div>
                <button
                  type="button"
                  title="개별 반경"
                  onClick={() => setPerCorner((v) => !v)}
                  className={`shrink-0 rounded px-1.5 py-1 text-[11px] ${
                    perCorner ? "bg-accent/20 text-accent" : "bg-raised text-fg-dim hover:text-fg"
                  }`}
                >
                  ↖↗↘↙
                </button>
              </div>
              {perCorner && (
                <div className="grid grid-cols-2 gap-x-2">
                  {(["↖", "↗", "↘", "↙"] as const).map((glyph, i) => (
                    <NumField
                      key={glyph}
                      label={glyph}
                      value={radius === MIXED ? MIXED : radius[i]}
                      min={0}
                      onCommit={(v) => setCorner(i, v)}
                      onLive={(v) => setCorner(i, v, true)}
                      onLiveEnd={actions.endLive}
                      onDelta={(d, live) => nudgeRadius(d, live, i)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {mosaicMode !== undefined && (
            <div className="flex h-7 items-center gap-1.5">
              <span className="w-11 shrink-0 text-[11px] text-fg-dim">모자이크</span>
              <Select
                label="모자이크"
                value={mosaicMode}
                options={MOSAIC_MODES}
                onChange={(v) =>
                  actions.patchSelection(
                    { mosaicMode: v },
                    `모자이크 ${MOSAIC_MODES.find((m) => m.value === v)?.label ?? v}`,
                  )
                }
              />
            </div>
          )}
          <NumField
            label="강도"
            value={mosaicStrength}
            min={1}
            onCommit={(v) => actions.patchSelection({ mosaicStrength: v }, `모자이크 강도 ${v}`)}
            onLive={(v) => actions.patchSelection({ mosaicStrength: v }, `모자이크 강도 ${v}`, true)}
            onLiveEnd={actions.endLive}
            onDelta={(d, live) =>
              actions.patchSelection(
                (n) => (n.kind === "mosaic" ? { mosaicStrength: Math.max(1, n.strength + d) } : null),
                `모자이크 강도 ${d > 0 ? "+" : ""}${d}`,
                live,
              )
            }
          />

          {/* 마스크 **만들기**는 둘 이상이라야 뜻이 있다(`maskSel` 이 `ids.length < 2` 에서
              그냥 돌아온다 — 마스크는 뒤 형제를 가리는 것이라 혼자서는 자기만 지운다).
              그런데 `mask` 는 모든 노드에 있는 필드라 `readProp` 이 늘 boolean 을 돌려줘,
              게이트가 없으면 단일 선택에서도 토글이 뜨고 눌러도 문서·히스토리·토글 상태가
              전부 그대로다 = 죽은 버튼. **끄는 쪽은 단일 선택이 정상 사용처**이고(마스크를
              푸는 UI 는 지금 이것뿐이다) 그래서 이미 마스크면 개수와 무관하게 남긴다. */}
          {masked !== undefined && (masked !== false || nodes.length > 1) && (
            <Toggle
              checked={masked}
              label="마스크로 사용 (클리핑)"
              onChange={(v) => actions.mask(v)}
            />
          )}
        </Group>
      )}

      {(["fills", "strokes"] as const).map((slot) => {
        const cur = slot === "fills" ? fills : strokes;
        if (cur === undefined) return null;
        const add = () =>
          editPaints(
            slot,
            cur,
            (list) => [...list, solidFill(recentColors[0] ?? DEFAULT_STROKE)],
            `${SLOT_LABEL[slot]} 추가`,
          );
        return (
          <div key={slot}>
            {cur === MIXED ? (
              <MixedStack title={SLOT_LABEL[slot]} onAdd={add} />
            ) : (
              <StackList
                title={SLOT_LABEL[slot]}
                items={cur}
                onAdd={add}
                onToggle={(i) =>
                  editPaints(
                    slot,
                    cur,
                    (list) => list.map((p, j) => (j === i ? { ...p, visible: !p.visible } : p)),
                    `${SLOT_LABEL[slot]} ${cur[i].visible ? "숨기기" : "표시"}`,
                  )
                }
                onRemove={(i) =>
                  editPaints(
                    slot,
                    cur,
                    (list) => list.filter((_, j) => j !== i),
                    `${SLOT_LABEL[slot]} 제거`,
                  )
                }
                render={(p, i) => (
                  <button
                    type="button"
                    // 스와치가 팝오버 앵커다(시안 ① `Sw · Text`). 열려 있는 동안 앵커가
                    // 다시 눌리는 경우는 백드롭이 먹으므로 여기서 토글을 짜지 않는다.
                    onClick={(e) =>
                      onOpenPopover({ kind: "paint", slot, index: i, anchor: e.currentTarget })
                    }
                    className="flex w-full min-w-0 items-center gap-1.5 text-left"
                  >
                    <span
                      style={{ background: paintCss(p) }}
                      className="h-[18px] w-[18px] shrink-0 rounded border border-edge"
                    />
                    <span className="min-w-0 truncate font-mono text-[11px] text-fg-muted">
                      {paintLabel(p)}
                    </span>
                  </button>
                )}
              />
            )}

            {/* 팔레트·최근 색(v1 툴바 승계) — 색 피커를 열지 않고 한 번에 고르는 경로다.
                맨 앞 겹의 색만 바꾼다: 스택을 통째로 갈면 두 번째 채우기가 말없이 사라진다. */}
            <SwatchRow
              colors={PALETTE}
              onPick={(c) => pickColor(slot, cur, c)}
              active={headColor(cur)}
            />
            {recentColors.length > 0 && (
              <SwatchRow
                label="최근"
                colors={recentColors}
                onPick={(c) => pickColor(slot, cur, c)}
                active={headColor(cur)}
              />
            )}

            {slot === "strokes" && (
              <NumField
                label="두께"
                value={strokeWidth}
                unit="px"
                min={0}
                onCommit={(v) => actions.patchSelection({ strokeWidth: v }, `두께 ${v}`)}
                onLive={(v) => actions.patchSelection({ strokeWidth: v }, `두께 ${v}`, true)}
                onLiveEnd={actions.endLive}
                onDelta={(d, live) =>
                  actions.patchSelection(
                    (n) => ({ strokeWidth: Math.max(0, n.strokeWidth + d) }),
                    `두께 ${d > 0 ? "+" : ""}${d}`,
                    live,
                  )
                }
              />
            )}
          </div>
        );
      })}

      {effects !== undefined &&
        (effects === MIXED ? (
          <MixedStack
            title="효과"
            onAdd={() => editEffects(effects, (l) => [...l, NEW_EFFECT], "효과 추가 드롭 섀도")}
          />
        ) : (
          <StackList
            title="효과"
            items={effects}
            onAdd={() => editEffects(effects, (l) => [...l, NEW_EFFECT], "효과 추가 드롭 섀도")}
            onToggle={(i) =>
              editEffects(
                effects,
                (l) => l.map((e, j) => (j === i ? { ...e, visible: !e.visible } : e)),
                `효과 ${effects[i].visible ? "숨기기" : "표시"}`,
              )
            }
            onRemove={(i) => editEffects(effects, (l) => l.filter((_, j) => j !== i), "효과 제거")}
            onOpen={(i, anchor) => onOpenPopover({ kind: "effect", index: i, anchor })}
            render={(e) => (
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  style={{ background: "color" in e ? e.color : "transparent" }}
                  className="h-[18px] w-[18px] shrink-0 rounded border border-edge"
                />
                <span className="min-w-0 truncate text-[11px] text-fg-muted">{effectLabel(e)}</span>
              </div>
            )}
          />
        ))}

      {/* 패스 전용 선 기하·fillRule·벡터 연산(46 §3.8). **하나만 골랐을 때만** 뜬다 —
          `PathInspectorSection` 은 노드 하나의 값을 그리므로 여러 개를 고른 채 띄우면 첫
          객체의 값이 나머지 것으로도 보인다(이 파일이 `readProp` 으로 피하는 바로 그 함정). */}
      {nodes.length === 1 && nodes[0].kind === "path" && (
        <div className="mt-3">
          <PathInspectorSection
            node={nodes[0]}
            // 라이브 틱에는 라벨이 없다(45 계약) — 히스토리 칸 이름은 첫 틱에 정해지므로
            // 스크럽 한 번은 `패스 속성` 으로 남는다. 값은 손을 뗄 때의 커밋이 확정한다.
            onLive={(p) => actions.pathPatch(p, "패스 속성", true)}
            onCommit={(p, label) => actions.pathPatch(p, label ?? "패스 속성")}
            onOp={actions.vectorOp}
            canOp={canVector}
          />
        </div>
      )}
    </div>
  );
}

// ── 조각 ────────────────────────────────────────────────────────────────────

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1 text-[11px] text-fg-dim">{title}</div>
      {children}
    </section>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded bg-raised p-1 text-fg-muted hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * 값이 갈린 스택. 목록을 그리지 않는 것이 핵심이다 — 노드마다 길이도 순서도 달라서
 * `i` 가 무엇을 가리키는지 정해지지 않는다. 더하기만 모든 노드에 같은 뜻이다.
 */
function MixedStack({ title, onAdd }: { title: string; onAdd(): void }) {
  return (
    <section className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-fg-dim">{title}</span>
        <button type="button" onClick={onAdd} title={`${title} 추가`} className="text-fg-dim hover:text-fg">
          +
        </button>
      </div>
      <div className="text-[11px] text-fg-dim">여러 값</div>
    </section>
  );
}

function SwatchRow({
  label,
  colors,
  active,
  onPick,
}: {
  label?: string;
  colors: readonly string[];
  active: string | null;
  onPick(c: string): void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {label && <span className="text-[10px] text-fg-dim">{label}</span>}
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          onClick={() => onPick(c)}
          style={{ background: c }}
          className={`h-4 w-4 rounded border ${
            active && active.toLowerCase() === c.toLowerCase()
              ? "border-accent ring-1 ring-accent"
              : "border-edge"
          }`}
        />
      ))}
    </div>
  );
}

// ── 순수 조각 ───────────────────────────────────────────────────────────────

/**
 * 모자이크만 페인트를 받지 않는다(`applyPaintPatch` 와 같은 규칙 — 37 schema.ts).
 *
 * 팝오버를 띄우는 쪽(`ImageEditor` 의 `popStack`)도 **이 술어를 그대로 써야 한다.** 여기서
 * 건너뛴 노드가 선택의 첫 번째일 수 있는데, 그쪽이 첫 노드에서 스택을 다시 읽으면 화면에
 * 그려진 것과 다른 배열이 나온다. 그래서 파일 밖으로 내보낸다.
 */
export function takesPaint(n: Node): boolean {
  return n.kind !== "mosaic";
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sameJson<T>(a: T, b: T): boolean {
  // ponytail: 스택은 항목 몇 개짜리라 직렬화 비교로 충분하다. 길어지면 겹별 비교로 내린다.
  return JSON.stringify(a) === JSON.stringify(b);
}

function mapMaybe<T, U>(v: Maybe<T> | undefined, f: (x: T) => U): Maybe<U> | undefined {
  if (v === undefined) return undefined;
  if (v === MIXED) return MIXED;
  return f(v as T);
}

function frameDelta(
  k: FrameKey,
  cur: { x: number; y: number; w: number; h: number },
  d: number,
): FrameEdit {
  if (k === "x") return { x: cur.x + d };
  if (k === "y") return { y: cur.y + d };
  // 크기는 0 밑으로 못 간다 — `setObjectFrame` 이 음수를 0 으로 잘라도 그 뒤 배율이 0 이 되어
  // 도형이 한 점으로 접히고, 되돌리기 전까지 복구할 값이 남지 않는다.
  return k === "w" ? { w: Math.max(0, cur.w + d) } : { h: Math.max(0, cur.h + d) };
}

function replaceAt(
  r: readonly [number, number, number, number],
  i: number,
  v: number,
): [number, number, number, number] {
  const out = [...r] as [number, number, number, number];
  out[i] = v;
  return out;
}

/**
 * 네 모서리가 같을 때만 값 하나. 하나라도 다르면 MIXED 다 — 첫 모서리를 대표로 보여 주면
 * 그 칸에 숫자를 넣는 순간 나머지 셋이 조용히 그 값으로 통일된다.
 */
function uniformRadius(r: Maybe<readonly [number, number, number, number]>): Maybe<number> {
  if (r === MIXED) return MIXED;
  return r[0] === r[1] && r[1] === r[2] && r[2] === r[3] ? r[0] : MIXED;
}

/** 스와치 활성 표시는 맨 앞 단색 겹 기준 — 팔레트 클릭이 바꾸는 대상과 같아야 한다. */
function headColor(cur: Maybe<readonly Fill[]>): string | null {
  if (cur === MIXED) return null;
  const head = cur[0];
  return head && head.type === "solid" ? head.color : null;
}

/** 맨 앞 겹을 단색으로 바꾼다(없으면 만든다). 나머지 겹은 건드리지 않는다. */
function withSolidHead(cur: readonly Fill[], hex: string): Fill[] {
  const head = cur[0];
  return [
    {
      type: "solid",
      color: hex,
      opacity: head && head.type === "solid" ? head.opacity : 1,
      visible: head?.visible ?? true,
      blend: head?.blend ?? "normal",
    },
    ...cur.slice(1),
  ];
}

function paintLabel(p: Fill): string {
  if (p.type === "solid") return `${p.color.replace("#", "").toUpperCase()} ${Math.round(p.opacity * 100)}%`;
  if (p.type === "image") return "이미지";
  return `${GRADIENT_LABEL[p.type] ?? p.type} ${Math.round(p.angle)}°`;
}

/** 스와치 미리보기. 그라디언트는 각도만 CSS 로 흉내 낸다(정본 렌더는 39). */
function paintCss(p: Fill): string {
  if (p.type === "solid") return p.color;
  if (p.type === "image") return "repeating-conic-gradient(#8884 0% 25%, transparent 0% 50%) 0 / 8px 8px";
  const stops = p.stops.map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(", ");
  return `linear-gradient(${p.angle + 90}deg, ${stops})`;
}

function effectLabel(e: Effect): string {
  switch (e.type) {
    case "drop-shadow":
      return `드롭 섀도 ${e.x}·${e.y} ${e.blur} ${Math.round(e.opacity * 100)}%`;
    case "inner-shadow":
      return `이너 섀도 ${e.x}·${e.y} ${e.blur} ${Math.round(e.opacity * 100)}%`;
    case "layer-blur":
      return `레이어 블러 반경 ${e.radius}`;
    case "background-blur":
      return `배경 블러 반경 ${e.radius}`;
  }
}
