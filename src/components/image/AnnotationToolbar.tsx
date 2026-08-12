// 주석 도구 팔레트 + 속성 패널(설계 §5.2).
//
// 순수 표현 컴포넌트다 — 상태는 전부 ImageEditor 가 들고 있고 여기서는 콜백만 부른다.
// 속성은 "다음에 만들 객체"의 기본값이자, 선택된 객체가 있으면 그 객체에도 함께 반영된다
// (반영 여부 판단은 ImageEditor 몫).

import {
  ArrowUpRight,
  Circle,
  Grid3x3,
  Hash,
  Highlighter,
  Minus,
  MousePointer2,
  Pen,
  Redo2,
  Square,
  Type,
  Undo2,
} from "lucide-react";

import {
  PALETTE,
  type Tool,
  type ToolStyle,
} from "../../lib/annotate/types";

/** 도구 팔레트 정의 — 아이콘·라벨·단축키를 한 곳에 모은다(§5.2 표). */
const TOOLS: {
  id: Tool;
  label: string;
  key: string;
  icon: React.ComponentType<{ size?: number }>;
}[] = [
  { id: "select", label: "선택", key: "V", icon: MousePointer2 },
  { id: "pen", label: "펜", key: "P", icon: Pen },
  { id: "highlight", label: "형광펜", key: "H", icon: Highlighter },
  { id: "line", label: "직선", key: "L", icon: Minus },
  { id: "arrow", label: "화살표", key: "A", icon: ArrowUpRight },
  { id: "rect", label: "사각형", key: "R", icon: Square },
  { id: "ellipse", label: "타원", key: "O", icon: Circle },
  { id: "text", label: "텍스트", key: "T", icon: Type },
  { id: "badge", label: "번호 뱃지", key: "N", icon: Hash },
  { id: "mosaic", label: "모자이크", key: "M", icon: Grid3x3 },
];

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

export interface AnnotationToolbarProps {
  tool: Tool;
  onToolChange: (t: Tool) => void;
  /**
   * 속성 패널이 따를 도구. 보통 `tool` 과 같지만, 선택 도구로 객체를 고른 상태에서는 그
   * 객체의 종류가 들어온다 — 안 그러면 선택 중에는 색·두께를 바꿀 수단이 사라진다.
   */
  propTool: Tool;
  style: ToolStyle;
  /** `live` 는 슬라이더 드래그 중 틱 — 히스토리를 매 틱 쌓지 않게 하는 신호다(§5.3). */
  onStyleChange: (patch: Partial<ToolStyle>, live?: boolean) => void;
  /** 0–1. 형광펜은 자체 알파를 쓰므로 노출하지 않는다. */
  opacity: number;
  onOpacityChange: (v: number, live?: boolean) => void;
  /** 슬라이더 드래그 종료 — 다음 변경이 새 히스토리 칸이 된다. */
  onEditEnd: () => void;
  /** 세션 내 최근 사용 색(최신 순). */
  recentColors: readonly string[];
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}

export default function AnnotationToolbar({
  tool,
  onToolChange,
  propTool,
  style,
  onStyleChange,
  opacity,
  onOpacityChange,
  onEditEnd,
  recentColors,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: AnnotationToolbarProps) {
  const showColor = COLOR_TOOLS.has(propTool);
  const showWidth = WIDTH_TOOLS.has(propTool);
  const showFill = propTool === "rect" || propTool === "ellipse";
  const showRadius = propTool === "rect";
  const showFont = propTool === "text" || propTool === "badge";
  const showMosaic = propTool === "mosaic";
  // 형광펜은 알파가 고정(멀티플라이 블렌드 전제)이라 슬라이더를 숨긴다.
  const showOpacity = showColor && propTool !== "highlight";

  return (
    <div>
      <div className="grid grid-cols-5 gap-1.5">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            title={`${t.label} (${t.key})`}
            onClick={() => onToolChange(t.id)}
            className={`flex items-center justify-center rounded py-1.5 ${
              tool === t.id
                ? "bg-accent/20 text-accent"
                : "bg-raised text-fg-muted hover:text-fg"
            }`}
          >
            <t.icon size={15} />
          </button>
        ))}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          title="실행 취소 (Ctrl+Z)"
          onClick={onUndo}
          disabled={!canUndo}
          className="flex flex-1 items-center justify-center rounded bg-raised py-1 text-fg-muted hover:text-fg disabled:opacity-40"
        >
          <Undo2 size={14} />
        </button>
        <button
          title="다시 실행 (Ctrl+Shift+Z)"
          onClick={onRedo}
          disabled={!canRedo}
          className="flex flex-1 items-center justify-center rounded bg-raised py-1 text-fg-muted hover:text-fg disabled:opacity-40"
        >
          <Redo2 size={14} />
        </button>
      </div>

      {showColor && (
        <div className="mt-2">
          <PropLabel>색</PropLabel>
          <div className="flex flex-wrap gap-1">
            {PALETTE.map((c) => (
              <Swatch
                key={c}
                color={c}
                active={style.stroke.toLowerCase() === c.toLowerCase()}
                onClick={() => onStyleChange({ stroke: c })}
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
                  active={style.stroke.toLowerCase() === c.toLowerCase()}
                  onClick={() => onStyleChange({ stroke: c })}
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
              onClick={() => onStyleChange({ fill: null })}
              className={`h-5 w-5 rounded border text-[10px] leading-none ${
                style.fill === null
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
                active={(style.fill ?? "").toLowerCase() === c.toLowerCase()}
                onClick={() => onStyleChange({ fill: c })}
              />
            ))}
          </div>
        </div>
      )}

      {showRadius && (
        <PropSlider
          label="모서리"
          value={style.radius}
          min={0}
          max={80}
          onChange={(v) => onStyleChange({ radius: v }, true)}
          onEnd={onEditEnd}
        />
      )}

      {showFont && (
        <PropSlider
          label="글자 크기"
          value={style.fontSize}
          min={8}
          max={200}
          onChange={(v) => onStyleChange({ fontSize: v }, true)}
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
    <div className="mt-2">
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
