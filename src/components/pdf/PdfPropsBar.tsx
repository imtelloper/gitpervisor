// PDF 주석 속성 바 — 선 색·채움·두께·불투명도·글자 크기. 값은 선택 객체(없으면 새 객체 기본값)에서 읽고,
// 바꾸면 선택 객체에 한 번 커밋(undo 1칸)하면서 새 객체 기본 페인트도 같이 바꾼다(호출부 몫).

import { useEffect, useRef, useState } from "react";

import { useMessages } from "../../i18n/ui-language";
import { applyPaintPatch } from "../../lib/annotate/schema";
import { PALETTE, solidFill, type DefaultPaint, type Fill, type Node } from "../../lib/annotate/types";

export interface PdfPaintChange {
  stroke?: string;
  /** null = 채움 없음. */
  fill?: string | null;
  strokeWidth?: number;
  /** 0–1. */
  opacity?: number;
  fontSize?: number;
}

const solidColor = (fs: readonly Fill[]): string | null => {
  const f = fs.find((x) => x.visible);
  return f && f.type === "solid" ? f.color : null;
};

/** 채움을 받는 kind — 선·펜·텍스트의 fills 는 채움이 아니다(텍스트는 글자색). */
const takesFill = (n: Node) => n.kind === "rect" || n.kind === "ellipse";

/** 변경 하나를 노드 하나에 — 받지 않는 kind 의 필드는 무시한다. 텍스트의 "선 색"은 글자색(fills)이다. */
export function applyPdfPaint(n: Node, c: PdfPaintChange): Node {
  let next = n;
  if (c.stroke !== undefined)
    next = applyPaintPatch(next, n.kind === "text" ? { fills: [solidFill(c.stroke)] } : { strokes: [solidFill(c.stroke)] });
  if (c.fill !== undefined && takesFill(n)) next = applyPaintPatch(next, { fills: c.fill ? [solidFill(c.fill)] : [] });
  if (c.strokeWidth !== undefined && n.kind !== "text") next = applyPaintPatch(next, { strokeWidth: c.strokeWidth });
  if (c.fontSize !== undefined) next = applyPaintPatch(next, { typo: { fontSize: c.fontSize } });
  if (c.opacity !== undefined && c.opacity !== next.opacity) next = { ...next, opacity: c.opacity };
  return next;
}

/** 새 객체 기본 페인트. 텍스트 글자색은 그리는 쪽이 strokes 에서 복사한다(annotation/pointer.ts). */
export function applyPdfPaintDefaults(p: DefaultPaint, c: PdfPaintChange): DefaultPaint {
  return {
    ...p,
    ...(c.stroke !== undefined && { strokes: [solidFill(c.stroke)] }),
    ...(c.fill !== undefined && { fills: c.fill ? [solidFill(c.fill)] : [] }),
    ...(c.strokeWidth !== undefined && { strokeWidth: c.strokeWidth }),
    ...(c.fontSize !== undefined && { fontSize: c.fontSize, typo: { ...p.typo, fontSize: c.fontSize } }),
  };
}

export interface PdfPropsBarProps {
  paint: DefaultPaint;
  opacity: number;
  /** 활성 페이지의 선택 노드 — 첫 노드 값을 보여 준다. */
  selected: readonly Node[];
  onChange: (c: PdfPaintChange) => void;
}

export default function PdfPropsBar({ paint, opacity, selected, onChange }: PdfPropsBarProps) {
  const t = useMessages().pdf.annotate;
  const first = selected[0] ?? null;
  const stroke = first
    ? solidColor(first.kind === "text" ? first.fills : first.strokes)
    : solidColor(paint.strokes);
  const fill = first ? (takesFill(first) ? solidColor(first.fills) : null) : solidColor(paint.fills);
  const width = first ? first.strokeWidth : paint.strokeWidth;
  const op = first ? first.opacity : opacity;
  const fontSize = first?.kind === "text" ? first.fontSize : paint.fontSize;
  const showFill = !first || selected.some(takesFill);
  const showWidth = !first || selected.some((n) => n.kind !== "text");
  const showFont = !first || selected.some((n) => n.kind === "text");

  return (
    <div
      data-pdf-props
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-panel px-3 py-1 text-xs text-fg-dim"
    >
      <Group label={t.stroke}>
        <Swatches value={stroke} onPick={(color) => onChange({ stroke: color })} />
        <ColorInput label={t.customColor} value={stroke ?? "#000000"} onPick={(color) => onChange({ stroke: color })} />
      </Group>
      {showFill && (
        <Group label={t.fill}>
          <button
            data-pdf-fill-none
            aria-pressed={fill === null}
            title={t.fillNone}
            onClick={() => onChange({ fill: null })}
            className={`rounded border px-1.5 leading-5 ${fill === null ? "border-accent text-fg" : "border-edge hover:text-fg"}`}
          >
            {t.fillNone}
          </button>
          <Swatches value={fill} onPick={(color) => onChange({ fill: color })} />
          <ColorInput label={t.customColor} value={fill ?? "#ffffff"} onPick={(color) => onChange({ fill: color })} />
        </Group>
      )}
      {showWidth && (
        <Group label={t.width}>
          <NumBox data-pdf-width value={width} min={0} max={72} step={0.5} onCommit={(v) => onChange({ strokeWidth: v })} />
        </Group>
      )}
      <Group label={t.opacity}>
        <NumBox
          data-pdf-opacity
          value={Math.round(op * 100)}
          min={0}
          max={100}
          step={5}
          onCommit={(v) => onChange({ opacity: v / 100 })}
        />
        <span>%</span>
      </Group>
      {showFont && (
        <Group label={t.fontSize}>
          <NumBox data-pdf-font-size value={fontSize} min={1} max={400} step={1} onCommit={(v) => onChange({ fontSize: v })} />
        </Group>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-0.5">{label}</span>
      {children}
    </div>
  );
}

function Swatches({ value, onPick }: { value: string | null; onPick: (color: string) => void }) {
  const cur = value?.toLowerCase();
  return (
    <>
      {PALETTE.map((color) => (
        <button
          key={color}
          title={color}
          aria-pressed={cur === color.toLowerCase()}
          onClick={() => onPick(color)}
          className={`h-4 w-4 shrink-0 rounded-sm border ${cur === color.toLowerCase() ? "border-accent ring-1 ring-accent" : "border-edge"}`}
          style={{ background: color }}
        />
      ))}
    </>
  );
}

/** 네이티브 색 입력. React onChange 는 input 이벤트라 피커를 끄는 동안 수십 번 온다 — 커밋은 change(피커 닫힘)에만. */
function ColorInput({ label, value, onPick }: { label: string; value: string; onPick: (color: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => pick.current(el.value);
    el.addEventListener("change", on);
    return () => el.removeEventListener("change", on);
  }, []);
  // 비제어 — 값이 바깥에서 바뀌면(선택 변경) 따라간다.
  useEffect(() => {
    if (ref.current && /^#[0-9a-f]{6}$/i.test(value)) ref.current.value = value;
  }, [value]);
  return (
    <input
      ref={ref}
      type="color"
      title={label}
      aria-label={label}
      defaultValue={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
      className="h-5 w-6 shrink-0 cursor-pointer rounded border border-edge bg-transparent p-0"
    />
  );
}

/** 숫자 칸 — 입력 중에는 커밋하지 않는다(글자마다 undo 칸이 쌓이지 않게). Enter·blur·스핀 버튼에서 커밋. */
function NumBox({
  value,
  min,
  max,
  step,
  onCommit,
  ...rest
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v)) return;
    const clamped = Math.min(max, Math.max(min, v));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      {...rest}
      type="number"
      value={draft ?? String(Math.round(value * 100) / 100)}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        // 스핀 버튼·휠은 inputType 이 없다 — 그건 곧바로 커밋한다.
        if (!(e.nativeEvent as InputEvent).inputType) commit(e.target.value);
        else setDraft(e.target.value);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(e.currentTarget.value);
        else if (e.key === "Escape") setDraft(null);
      }}
      className="w-14 rounded border border-edge bg-base px-1 py-0.5 text-right tabular-nums text-fg outline-none focus:border-accent"
    />
  );
}
