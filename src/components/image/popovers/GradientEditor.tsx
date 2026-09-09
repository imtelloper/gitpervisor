// 그라디언트 편집기 — 종류 4·스톱 목록·각도/스케일, 그리고 **캔버스 위 핸들**.
//
// 핸들이 이 파일의 어려운 부분이고, 세 가지 규약 위에 서 있다:
//
//   1) **그림은 43 크롬(SVG)에 얹는다**(`onExtra`). 씬 캔버스에 그리면 저장·내보내기 경로가
//      같은 캔버스를 쓰므로 핸들이 그대로 이미지에 구워진다(e2e 30 (o-4)(p-5)).
//   2) **포인터는 43 의 핸들 히트보다 먼저 가로챈다**(`registerHit`). 안 그러면 스톱을 잡으려던
//      드래그가 객체 리사이즈가 된다. 등록 해제를 빠뜨리면 팝오버를 닫은 뒤에도 캔버스 클릭이
//      계속 먹혀 "그림이 안 그려진다"가 되므로 해제는 이펙트 정리 하나에만 있다.
//   3) 두 배선 모두 **props 로 받는다**. 여기서 43·통합 모듈을 직접 부르면 팝오버가 크롬 소유권을
//      나눠 갖게 되고, 안 넘기면 핸들만 사라진다 — 각도·스케일·위치는 아래 필드로 전부 도달한다.
//
// 축(from→to)은 `paint.ts` 의 `linearGradient`/`gradientOf` 와 **같은 식**이어야 한다. 어긋나면
// 핸들이 실제 램프와 다른 자리에 떠서, 잡아 끄는 대로 색이 움직이지 않는다.
//
// 미리보기·스톱 바는 CSS 그라디언트다(캔버스 0장) — 팝오버가 캔버스를 올리면 e2e 의
// `canvases()[0]/[1]` 인덱스가 밀린다. 다이아만 CSS 에 없어 미리보기를 선형으로 낮춘다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.8 그라디언트 편집기

import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Shuffle } from "lucide-react";

import { CHROME_COLORS, type ChromePrim } from "../../../lib/annotate/chrome";
import type { Paint, PaintStop, Rect } from "../../../lib/annotate/types";
import { hexToRgb } from "../../../lib/color";
import { NumField } from "../inspector/fields/NumField";
import { ColorPicker } from "./ColorPicker";
import { Popover } from "./Popover";

type Gradient = Extract<Paint, { type: "linear" | "radial" | "angular" | "diamond" }>;
type Point = { x: number; y: number };

const KINDS = [
  { value: "linear", label: "선형" },
  { value: "radial", label: "방사" },
  { value: "angular", label: "원뿔" },
  { value: "diamond", label: "다이아" },
] as const;

/** 핸들 집기 반경(css px) — pointer.ts 의 `HANDLE_GRAB_CSS` 와 같은 값으로 둔다. */
const GRAB_CSS = 10;
const DEG = Math.PI / 180;

export interface GradientEditorProps {
  paint: Gradient;
  /** 노드 bbox(oriented px) — 축 계산의 기준. 렌더가 쓰는 것과 같은 값이어야 한다. */
  bbox: Rect;
  onLive(p: Paint): void;
  onCommit(p: Paint): void;
  /**
   * 43 `ChromeState.extra` 슬롯. **안정된 참조**(useCallback)여야 한다 — 매 렌더 새 함수를
   * 넘기면 이펙트가 렌더마다 돌아 크롬이 초당 60회 재구축된다.
   */
  onExtra?(prims: ChromePrim[]): void;
  /** `annotation/pointer.ts` 의 `registerPointerHit` 을 그대로 넘긴다. */
  registerHit?(fn: (pt: Point, e: PointerEvent) => boolean): () => void;
}

export function GradientEditor({
  paint,
  bbox,
  onLive,
  onCommit,
  onExtra,
  registerHit,
}: GradientEditorProps) {
  const [edit, setEdit] = useState<{ i: number; anchor: HTMLElement } | null>(null);

  // 드래그 중에는 이벤트 리스너가 항상 최신 값을 봐야 한다 — 이펙트 재등록으로 해결하면
  // 손을 대고 있는 동안 등록이 갈려 나간다. `bbox` 도 같은 이유로 거울이다(호출부가 매 렌더
  // 새 객체를 만들어도 선점 등록이 흔들리지 않는다).
  const live = useRef(paint);
  live.current = paint;
  const box = useRef(bbox);
  box.current = bbox;

  const put = (next: Gradient, commit: boolean) =>
    commit ? onCommit(next) : onLive(next);

  const setStops = (stops: PaintStop[], commit: boolean) =>
    put({ ...paint, stops }, commit);

  // ── 캔버스 핸들 ───────────────────────────────────────────────────────────

  // bbox 는 값으로 건다 — 호출부가 매 렌더 새 객체를 만들면 `onExtra` 가 렌더마다 불려
  // 크롬이 다시 세워지고, 그 재렌더가 다시 여기로 돌아오면 루프가 된다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prims = useMemo(() => handlePrims(paint, bbox), [paint, bbox.x, bbox.y, bbox.w, bbox.h]);

  useEffect(() => {
    onExtra?.(prims);
  }, [onExtra, prims]);

  // 비우는 것은 **언마운트에만**. 값이 바뀔 때마다 비웠다 채우면 크롬이 한 프레임 깜빡인다.
  useEffect(() => () => onExtra?.([]), [onExtra]);

  useEffect(() => {
    if (!registerHit) return;
    return registerHit((pt, e) => {
      const cur = live.current;
      const bb = box.current;
      // 클라이언트 좌표 ↔ oriented 배율은 이 컴포넌트가 모른다(줌은 40·43 소유). 다만 다운
      // 이벤트 하나에 **같은 점의 두 좌표**가 다 들어 있어 비율로 역산할 수 있다. 이 값이
      // 없으면 집기 반경을 oriented 상수로 박아야 하고, 그러면 확대할수록 헐거워진다.
      const k = orientedPerCss(pt, e);
      const ax = axisOf(cur, bb);
      const tol = GRAB_CSS * k;

      let grab: { kind: "stop"; i: number } | { kind: "end" } | null = null;
      // 스톱이 끝점보다 먼저다 — pos 1 스톱과 끝 핸들이 겹쳐 있는데, 겹친 자리에서 각도가
      // 바뀌면 사용자는 스톱을 옮기려다 램프 전체를 돌린 것이 된다.
      for (let i = 0; i < cur.stops.length; i++) {
        const p = pointAt(ax, cur.stops[i].pos);
        if (Math.hypot(p.x - pt.x, p.y - pt.y) <= tol) {
          grab = { kind: "stop", i };
          break;
        }
      }
      if (!grab && Math.hypot(ax.to.x - pt.x, ax.to.y - pt.y) <= tol) grab = { kind: "end" };
      // 콜백 안에서는 `let` 의 좁힘이 풀린다 — 여기서 상수로 고정해야 아래에서 `.kind` 를 읽는다.
      const g = grab;
      if (!g) return false;

      let last = cur;
      const at = (ev: PointerEvent): Point => ({
        x: pt.x + (ev.clientX - e.clientX) * k,
        y: pt.y + (ev.clientY - e.clientY) * k,
      });
      const move = (ev: PointerEvent) => {
        last =
          g.kind === "stop"
            ? moveStop(last, bb, g.i, at(ev))
            : moveEnd(last, bb, at(ev));
        onLive(last);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onCommit(last);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return true;
    });
  }, [registerHit, onLive, onCommit]);

  // ── 화면 ─────────────────────────────────────────────────────────────────

  const sorted = [...paint.stops].sort((a, b) => a.pos - b.pos);

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-1">
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            aria-pressed={paint.type === k.value}
            onClick={() => put({ ...paint, type: k.value }, true)}
            className={`h-6 flex-1 rounded text-[11px] ${
              paint.type === k.value ? "bg-raised text-fg" : "text-fg-dim hover:text-fg"
            }`}
          >
            {k.label}
          </button>
        ))}
        <button
          type="button"
          title="스톱 순서 반전"
          onClick={() => {
            // 열려 있던 스톱 색 피커는 닫는다 — 아래 둘 다 **배열 인덱스를 옮기므로** 그대로
            // 두면 피커가 남의 스톱을 편집하게 된다(`edit.i` 는 위치일 뿐 신원이 아니다).
            setEdit(null);
            setStops(paint.stops.map((s) => ({ ...s, pos: 1 - s.pos })).reverse(), true);
          }}
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <Shuffle size={12} />
        </button>
      </div>

      <div
        aria-label="미리보기"
        className="h-8 rounded border border-edge"
        style={{ background: cssGradient(paint) }}
      />

      {/* 스톱 바 — 빈 자리를 누르면 그 위치의 색으로 스톱이 하나 생긴다(시안 ④). */}
      <div
        aria-label="스톱"
        onPointerDown={(e) => {
          if (e.button !== 0 || e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          const pos = clamp01((e.clientX - r.left) / Math.max(1, r.width));
          setStops([...paint.stops, { ...sampleStop(sorted, pos), pos }], true);
        }}
        className="relative h-4 rounded border border-edge"
        style={{
          background: `linear-gradient(to right, ${cssStops(sorted)})`,
          touchAction: "none",
        }}
      >
        {paint.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            title={`${s.color} ${Math.round(s.pos * 100)}%`}
            onClick={(e) => setEdit({ i, anchor: e.currentTarget })}
            style={{ left: `${s.pos * 100}%`, background: s.color }}
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          />
        ))}
      </div>

      {paint.stops.map((s, i) => (
        <div key={i} className="flex h-7 items-center gap-1.5">
          <button
            type="button"
            title="색"
            onClick={(e) => setEdit({ i, anchor: e.currentTarget })}
            style={{ background: s.color }}
            className="h-4 w-4 shrink-0 rounded border border-edge"
          />
          <span className="w-16 shrink-0 font-mono text-[11px] text-fg-muted">{s.color}</span>
          <div className="min-w-0 flex-1">
            <NumField
              label="위치"
              value={s.pos * 100}
              unit="%"
              min={0}
              max={100}
              onCommit={(v) => setStops(patchStop(paint.stops, i, { pos: v / 100 }), true)}
            />
          </div>
          <button
            type="button"
            title="스톱 제거"
            // 두 개 아래로 내려가면 램프가 성립하지 않는다 — 렌더는 스톱 0개를 통째로 무시한다.
            disabled={paint.stops.length <= 2}
            onClick={() => {
              setEdit(null);
              setStops(paint.stops.filter((_, k) => k !== i), true);
            }}
            className="shrink-0 text-fg-dim hover:text-fg disabled:opacity-30"
          >
            <Minus size={12} />
          </button>
        </div>
      ))}

      {/* 방사는 각도가 그림에 영향이 없고(원), 원뿔은 반지름이 없어 스케일이 뜻이 없다.
          `undefined` 를 주면 NumField 가 필드를 통째로 감춘다 — 못 쓰는 칸을 만지게 두지 않는다. */}
      <NumField
        label="각도"
        value={paint.type === "radial" ? undefined : paint.angle}
        unit="°"
        onCommit={(v) => put({ ...paint, angle: v }, true)}
        onLive={(v) => put({ ...paint, angle: v }, false)}
        onLiveEnd={() => onCommit(live.current)}
      />
      <NumField
        label="스케일"
        value={paint.type === "angular" ? undefined : paint.scale}
        min={0.01}
        step={0.05}
        onCommit={(v) => put({ ...paint, scale: v }, true)}
        onLive={(v) => put({ ...paint, scale: v }, false)}
        onLiveEnd={() => onCommit(live.current)}
      />

      {edit && paint.stops[edit.i] && (
        <Popover
          anchor={edit.anchor}
          open
          onClose={() => setEdit(null)}
          placement="left-start"
          width={232}
          title="그라디언트 스톱 · 단색"
        >
          <ColorPicker
            title="그라디언트 스톱"
            paint={{
              type: "solid",
              color: paint.stops[edit.i].color,
              opacity: paint.stops[edit.i].opacity,
            }}
            onLive={(p) =>
              p.type === "solid" &&
              setStops(patchStop(paint.stops, edit.i, { color: p.color, opacity: p.opacity }), false)
            }
            onCommit={(p) =>
              p.type === "solid" &&
              setStops(patchStop(paint.stops, edit.i, { color: p.color, opacity: p.opacity }), true)
            }
          />
        </Popover>
      )}
    </div>
  );
}

// ── 축·핸들 기하 ─────────────────────────────────────────────────────────────

interface Axis {
  from: Point;
  to: Point;
  /** scale 1 일 때의 반길이 — 끝 핸들을 끌 때 스케일로 되돌리는 나눗셈의 분모다. */
  unit: number;
}

/**
 * 램프의 시작·끝 점(oriented px). `paint.ts` 의 `linearGradient`/`gradientOf` 와 **같은 식**이다:
 * 선형은 방향 d 로 잰 bbox 지지함수의 절반, 방사는 반대각선의 절반.
 *
 * 방사만 `from` 이 중심이다(램프가 중심에서 밖으로 간다) — 다른 종류는 중심을 지나 양쪽으로 뻗는다.
 */
function axisOf(p: Gradient, bbox: Rect): Axis {
  const a = p.angle * DEG;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const unit =
    p.type === "radial"
      ? Math.hypot(bbox.w, bbox.h) / 2
      : (Math.abs(bbox.w * dx) + Math.abs(bbox.h * dy)) / 2;
  const half = unit * (p.scale > 0 ? p.scale : 1);
  return {
    from:
      p.type === "radial" ? { x: cx, y: cy } : { x: cx - dx * half, y: cy - dy * half },
    to: { x: cx + dx * half, y: cy + dy * half },
    unit,
  };
}

function pointAt(ax: Axis, t: number): Point {
  return {
    x: ax.from.x + (ax.to.x - ax.from.x) * t,
    y: ax.from.y + (ax.to.y - ax.from.y) * t,
  };
}

function handlePrims(p: Gradient, bbox: Rect): ChromePrim[] {
  const ax = axisOf(p, bbox);
  return [
    { k: "line", x1: ax.from.x, y1: ax.from.y, x2: ax.to.x, y2: ax.to.y, color: CHROME_COLORS.sel },
    { k: "circle", cx: ax.to.x, cy: ax.to.y, rCss: 6, color: CHROME_COLORS.sel },
    ...p.stops.map((s): ChromePrim => {
      const at = pointAt(ax, s.pos);
      return { k: "circle", cx: at.x, cy: at.y, rCss: 4, color: CHROME_COLORS.sel, fill: s.color };
    }),
  ];
}

/** 스톱 하나를 축 위로 투영해 `pos` 만 바꾼다. 배열 순서는 건드리지 않는다 — 끌던 행이 밑으로 사라진다. */
function moveStop(p: Gradient, bbox: Rect, i: number, at: Point): Gradient {
  const ax = axisOf(p, bbox);
  const vx = ax.to.x - ax.from.x;
  const vy = ax.to.y - ax.from.y;
  const len2 = vx * vx + vy * vy;
  if (!(len2 > 0)) return p;
  const t = clamp01(((at.x - ax.from.x) * vx + (at.y - ax.from.y) * vy) / len2);
  return { ...p, stops: patchStop(p.stops, i, { pos: t }) };
}

/** 끝 핸들 = 각도 + 스케일 동시 편집. 중심은 bbox 중심에 고정이라 두 값이면 축이 결정된다. */
function moveEnd(p: Gradient, bbox: Rect, at: Point): Gradient {
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const angle = Math.atan2(at.y - cy, at.x - cx) / DEG;
  // 새 각도의 `unit` 으로 나눈다 — 옛 각도로 나누면 방향을 돌릴 때 스케일이 같이 튄다.
  const unit = axisOf({ ...p, angle }, bbox).unit;
  const scale = unit > 0 ? Math.hypot(at.x - cx, at.y - cy) / unit : p.scale;
  return { ...p, angle, scale: Math.max(0.01, scale) };
}

/**
 * 다운 이벤트 하나에서 oriented px / css px 배율을 역산한다.
 *
 * 캔버스 rect 는 oriented 이미지 전체를 덮으므로 `pt.x / (clientX − rect.left)` 가 곧 그 배율이다.
 * 두 축 중 **분모가 큰 쪽**을 쓴다 — 이미지 왼쪽 끝이나 위쪽 끝을 눌렀을 때 0/0 이 되는 축을 피한다.
 */
function orientedPerCss(pt: Point, e: PointerEvent): number {
  const el = e.target as HTMLElement | null;
  const r = el?.getBoundingClientRect?.();
  if (!r) return 1;
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  if (Math.abs(dx) >= Math.abs(dy)) return Math.abs(dx) > 1 ? pt.x / dx : 1;
  return Math.abs(dy) > 1 ? pt.y / dy : 1;
}

// ── 스톱·CSS ────────────────────────────────────────────────────────────────

function patchStop(stops: readonly PaintStop[], i: number, patch: Partial<PaintStop>): PaintStop[] {
  return stops.map((s, k) => (k === i ? { ...s, ...patch } : s));
}

/** 새 스톱의 색 — 그 위치의 램프 색을 그대로 뜬다. 이웃 색을 복사하면 클릭한 자리에서 색이 튄다. */
function sampleStop(sorted: readonly PaintStop[], pos: number): PaintStop {
  if (sorted.length === 0) return { pos, color: "#FFFFFF", opacity: 1 };
  const hi = sorted.findIndex((s) => s.pos >= pos);
  if (hi < 0) return { ...sorted[sorted.length - 1], pos };
  if (hi === 0) return { ...sorted[0], pos };
  const a = sorted[hi - 1];
  const b = sorted[hi];
  const t = b.pos === a.pos ? 0 : (pos - a.pos) / (b.pos - a.pos);
  const ca = hexToRgb(a.color);
  const cb = hexToRgb(b.color);
  const color =
    ca && cb
      ? `#${[0, 1, 2]
          .map((k) =>
            Math.round(ca[k] + (cb[k] - ca[k]) * t)
              .toString(16)
              .padStart(2, "0")
              .toUpperCase(),
          )
          .join("")}`
      : a.color;
  return { pos, color, opacity: a.opacity + (b.opacity - a.opacity) * t };
}

function cssStops(sorted: readonly PaintStop[]): string {
  return sorted
    .map((s) => {
      const rgb = hexToRgb(s.color);
      const c = rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${s.opacity})` : s.color;
      return `${c} ${(s.pos * 100).toFixed(1)}%`;
    })
    .join(", ");
}

/**
 * 미리보기용 CSS. 캔버스 각도 규약(0° = +x)과 CSS(0deg = 위)가 90° 어긋나므로 더한다.
 * 다이아는 CSS 에 없어 선형으로 낮춘다 — 캔버스 렌더는 4분할 clip 으로 제대로 그린다(39).
 */
function cssGradient(p: Gradient): string {
  const s = cssStops([...p.stops].sort((a, b) => a.pos - b.pos));
  if (p.type === "radial") return `radial-gradient(circle, ${s})`;
  if (p.type === "angular") return `conic-gradient(from ${p.angle + 90}deg, ${s})`;
  return `linear-gradient(${p.angle + 90}deg, ${s})`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
