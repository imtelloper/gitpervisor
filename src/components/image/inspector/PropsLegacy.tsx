// 인스펙터 속성·텍스트 탭의 **과도기** 내용 — v1 `AnnotationToolbar` 의 속성부를 그대로 옮겼다.
//
// `Legacy` 인 이유: 태스크 45 가 선택 분류(`classifySelection`)로 필드를 고르는 진짜 인스펙터로
// 이 파일을 통째로 갈아 끼운다. 그때까지 셸 개편으로 기능이 하나도 없어지지 않게 걸어 두는
// 다리다 — 그래서 45 가 폐기할 `propTool`(도구 ≒ 선택 kind)을 아직 그대로 쓴다.
//
// 여기서 상태를 들지 않는다. 값은 전부 ImageEditor 가 갖고 이 파일은 콜백만 부른다 —
// 속성은 "다음에 만들 객체"의 기본값이자 선택된 객체에 함께 반영되는 값이라, 사본을 두면
// 패널이 보여 주는 값과 실제 값이 갈린다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.8

import {
  DEFAULT_STROKE,
  PALETTE,
  solidFill,
  type DefaultPaint,
} from "../../../lib/annotate/types";
import type { Tool } from "../../../stores/imageEditor";

/** 색을 쓰는 도구(선택·모자이크는 색이 의미 없다). */
const COLOR_TOOLS = new Set<Tool>([
  "pen",
  "highlight",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "badge",
]);
/** 선 두께를 쓰는 도구. */
const WIDTH_TOOLS = new Set<Tool>([
  "pen",
  "highlight",
  "line",
  "arrow",
  "rect",
  "ellipse",
]);

export interface PropsLegacyProps {
  /**
   * 속성 패널이 따를 도구. 보통 현재 도구와 같지만, 선택 도구로 객체를 고른 상태에서는 그
   * 객체의 종류가 들어온다 — 안 그러면 선택 중에는 색·두께를 바꿀 수단이 사라진다.
   */
  propTool: Tool;
  style: DefaultPaint;
  /** `live` 는 슬라이더 드래그 중 틱 — 히스토리를 매 틱 쌓지 않게 하는 신호다(§5.3). */
  onStyleChange: (patch: Partial<DefaultPaint>, live?: boolean) => void;
  /** 슬라이더 드래그 종료 — 다음 변경이 새 히스토리 칸이 된다. */
  onEditEnd: () => void;
}

export interface PropsPaneProps extends PropsLegacyProps {
  /** 0–1. 형광펜은 자체 알파를 쓰므로 노출하지 않는다. */
  opacity: number;
  onOpacityChange: (v: number, live?: boolean) => void;
  /** 세션 내 최근 사용 색(최신 순). */
  recentColors: readonly string[];
}

/** 인스펙터 **속성** 탭 — 팔레트·최근·두께·채움·모서리·모자이크·불투명도. */
export function PropsLegacy({
  propTool,
  style,
  onStyleChange,
  opacity,
  onOpacityChange,
  onEditEnd,
  recentColors,
}: PropsPaneProps) {
  // 페인트 스택의 **첫 겹만** 보여 준다(37 §3.4 shim) — 다중 채우기·그라디언트 편집은 45 다.
  const firstStroke = style.strokes.find((f) => f.visible);
  const strokeColor =
    firstStroke && firstStroke.type === "solid" ? firstStroke.color : DEFAULT_STROKE;
  const firstFill = style.fills.find((f) => f.visible);
  const fillColor = firstFill && firstFill.type === "solid" ? firstFill.color : null;
  const showColor = COLOR_TOOLS.has(propTool);
  const showWidth = WIDTH_TOOLS.has(propTool);
  const showFill = propTool === "rect" || propTool === "ellipse";
  const showRadius = propTool === "rect";
  const showMosaic = propTool === "mosaic";
  // 형광펜은 알파가 고정(멀티플라이 블렌드 전제)이라 슬라이더를 숨긴다.
  const showOpacity = showColor && propTool !== "highlight";

  return (
    <div>
      {showColor && (
        <div>
          <PropLabel>색</PropLabel>
          <div className="flex flex-wrap gap-1">
            {PALETTE.map((c) => (
              <Swatch
                key={c}
                color={c}
                active={strokeColor.toLowerCase() === c.toLowerCase()}
                onClick={() => onStyleChange({ strokes: [solidFill(c)] })}
              />
            ))}
          </div>
          {recentColors.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-fg-dim">최근</span>
              {recentColors.map((c) => (
                <Swatch
                  key={`recent-${c}`}
                  color={c}
                  active={strokeColor.toLowerCase() === c.toLowerCase()}
                  onClick={() => onStyleChange({ strokes: [solidFill(c)] })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {showWidth && (
        <PropSlider
          label="두께"
          value={style.strokeWidth}
          min={1}
          max={40}
          onChange={(v) => onStyleChange({ strokeWidth: v }, true)}
          onEnd={onEditEnd}
        />
      )}

      {showFill && (
        <div className="mt-2">
          <PropLabel>채움</PropLabel>
          <div className="flex flex-wrap gap-1">
            <button
              title="채우지 않음"
              onClick={() => onStyleChange({ fills: [] })}
              className={`h-5 w-5 rounded border text-[10px] leading-none ${
                fillColor === null
                  ? "border-accent text-accent"
                  : "border-edge text-fg-dim hover:text-fg"
              }`}
            >
              ∅
            </button>
            {PALETTE.map((c) => (
              <Swatch
                key={`fill-${c}`}
                color={c}
                active={(fillColor ?? "").toLowerCase() === c.toLowerCase()}
                onClick={() => onStyleChange({ fills: [solidFill(c)] })}
              />
            ))}
          </div>
        </div>
      )}

      {showRadius && (
        <PropSlider
          label="모서리"
          value={style.radius[0]}
          min={0}
          max={80}
          onChange={(v) => onStyleChange({ radius: [v, v, v, v] }, true)}
          onEnd={onEditEnd}
        />
      )}

      {showMosaic && (
        <div className="mt-2">
          <PropLabel>모자이크</PropLabel>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => onStyleChange({ mosaicMode: "pixelate" })}
              className={`rounded px-2 py-1 text-[12px] ${
                style.mosaicMode === "pixelate"
                  ? "bg-accent text-on-accent"
                  : "bg-raised text-fg-muted hover:text-fg"
              }`}
            >
              픽셀화
            </button>
            <button
              onClick={() => onStyleChange({ mosaicMode: "blur" })}
              className={`rounded px-2 py-1 text-[12px] ${
                style.mosaicMode === "blur"
                  ? "bg-accent text-on-accent"
                  : "bg-raised text-fg-muted hover:text-fg"
              }`}
            >
              블러
            </button>
          </div>
          <PropSlider
            label="강도"
            value={style.mosaicStrength}
            min={2}
            max={80}
            onChange={(v) => onStyleChange({ mosaicStrength: v }, true)}
            onEnd={onEditEnd}
          />
        </div>
      )}

      {showOpacity && (
        <PropSlider
          label="불투명도"
          value={Math.round(opacity * 100)}
          min={5}
          max={100}
          onChange={(v) => onOpacityChange(v / 100, true)}
          onEnd={onEditEnd}
        />
      )}
    </div>
  );
}

/** 인스펙터 **텍스트** 탭 — 지금은 글자 크기 하나다(정렬·자간·줄간은 49·50). */
export function TextLegacy({
  propTool,
  style,
  onStyleChange,
  onEditEnd,
}: PropsLegacyProps) {
  if (propTool !== "text" && propTool !== "badge") return null;
  return (
    <PropSlider
      label="글자 크기"
      value={style.fontSize}
      min={8}
      max={200}
      onChange={(v) => onStyleChange({ fontSize: v }, true)}
      onEnd={onEditEnd}
    />
  );
}

function PropLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[11px] text-fg-dim">{children}</div>;
}

function Swatch({
  color,
  active,
  onClick,
}: {
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={color}
      onClick={onClick}
      style={{ background: color }}
      className={`h-5 w-5 rounded border ${
        active ? "border-accent ring-1 ring-accent" : "border-edge"
      }`}
    />
  );
}

function PropSlider({
  label,
  value,
  min,
  max,
  onChange,
  onEnd,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onEnd?: () => void;
}) {
  return (
    <div className="mt-2 first:mt-0">
      <div className="flex justify-between text-[11px] text-fg-dim">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        className="w-full accent-accent"
      />
    </div>
  );
}
