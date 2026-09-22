// 색 피커 — 채우기·선·효과·그라디언트 스톱이 전부 이 콘텐츠를 `Popover` 안에 띄운다.
//
// **HSV 를 자기 상태로 든다.** 화면에 보이는 것은 hex 지만 hex 를 상태로 삼으면 슬라이더를
// 한 칸 움직일 때마다 hex→HSV→hex 왕복이 돌아, 손대지도 않은 채도·명도가 반올림으로 미끄러진다
// (`lib/color.ts` 머리말). hex 는 **출력**으로만 만든다. 회색(v=0·s=0)에서 색상값이 사라지는
// 것도 같은 이유로 로컬 HSV 가 막아 준다 — 밝기를 0 까지 내렸다 올려도 고르던 색상이 남는다.
//
// 바깥 값이 바뀌면(되돌리기·스와치·스포이드) 로컬 HSV 를 다시 맞추되, **우리가 방금 내보낸
// 값이 되돌아온 것은 무시**한다(`seen`). 안 그러면 드래그 틱마다 자기 출력으로 자기 상태를
// 덮어써 위의 미끄러짐이 그대로 재현된다.
//
// 캔버스를 한 장도 쓰지 않는다. SV 사각형·색상·알파는 CSS 그라디언트 두 겹이면 같은 그림이고,
// 무엇보다 **e2e 30·34·35 가 `canvases()[0]/[1]` 로 씬 캔버스를 집는다** — 팝오버가 캔버스를
// 하나라도 DOM 에 올리면 그 인덱스가 밀려 무관한 스위트가 통째로 깨진다.
//
// 알파는 `Fill.opacity` 다. 색 문자열에 섞지 않는다 — `#rrggbb` 전제가 e2e 상수·팔레트·정규화에
// 다 깔려 있다(37).
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.8 색 피커

import { useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Pipette } from "lucide-react";

import { useMessages } from "../../../i18n/ui-language";
import type { Paint } from "../../../lib/annotate/types";
import {
  hexToRgb,
  hslToRgb,
  hsvToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  type Hsl,
  type Hsv,
  type Rgb,
} from "../../../lib/color";
import { useImageEditorUi } from "../../../stores/imageEditor";
import { NumField } from "../inspector/fields/NumField";
import { useEyedropper } from "./Eyedropper";

type Solid = Extract<Paint, { type: "solid" }>;

/** 스토어 상한(42 §4). 한 줄에 보이는 것은 8칸이고 나머지는 밀려 나갈 자리를 기다린다. */
const RECENT_MAX = 12;
const SWATCH_COLS = 8;

/** 알파를 보여 주는 격자 — 반투명 색을 단색 배경 위에 그리면 옅은 색과 구분이 안 된다. */
const CHECKER =
  "conic-gradient(rgba(128,128,128,.35) 25%, transparent 0 50%, rgba(128,128,128,.35) 0 75%, transparent 0)";

export interface ColorPickerProps {
  /** 슬롯 이름(`채우기 · 단색`). 헤더는 `Popover title` 이 그리므로 여기서는 접근성 이름으로만 쓴다. */
  title: string;
  paint: Solid;
  /**
   * 시안 ④ `문서 색상` 칸. 계약(§4)에 없는 추가 prop 이다 — `documentColors(doc)` 는 문서를
   * 봐야 하는데 이 컴포넌트는 페인트 한 겹만 받는다. 안 넘기면 그 줄을 그리지 않는다.
   */
  docColors?: readonly string[];
  onLive(p: Paint): void;
  onCommit(p: Paint): void;
  /** 51 이 오기 전에는 넘어오지 않는다 — 없으면 버튼 자체를 그리지 않는다. */
  onSaveStyle?(): void;
  /**
   * 색 스타일 목록(51 `StyleLibrary`) — 시안 ④ 가 저장 버튼 **아래**에 두는 그 목록이다.
   *
   * 슬롯으로 받는 이유는 적용이 문서 커밋이기 때문이다: 이 컴포넌트는 페인트 한 겹만 알고
   * 문서 깔때기(`ImageEditor.applyDoc`)를 모른다. 직접 마운트하면 선택·히스토리 라벨을
   * 여기까지 실어 내려야 하고, 그러면 색 피커가 문서를 아는 컴포넌트가 된다.
   */
  styles?: ReactNode;
}

export function ColorPicker({
  title,
  paint,
  docColors,
  onLive,
  onCommit,
  onSaveStyle,
  styles,
}: ColorPickerProps) {
  const msg = useMessages();
  const recent = useImageEditorUi((s) => s.recentColors);
  const { start: startEyedropper } = useEyedropper();

  const [model, setModel] = useState<"HEX" | "RGB" | "HSL">("HEX");
  const [hsv, setHsv] = useState<Hsv>(() => toHsv(paint.color));
  const [alpha, setAlpha] = useState(paint.opacity);
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [seen, setSeen] = useState<{ color: string; opacity: number }>(paint);

  // 렌더 중 상태 조정(React 의 "props 가 바뀌면 state 를 맞춘다" 패턴). 이펙트로 미루면
  // 되돌리기 직후 한 프레임 동안 옛 색이 슬라이더에 남는다.
  if (seen.color !== paint.color || seen.opacity !== paint.opacity) {
    setSeen({ color: paint.color, opacity: paint.opacity });
    if (seen.color !== paint.color) {
      setHsv(toHsv(paint.color));
      setHexDraft(null);
    }
    if (seen.opacity !== paint.opacity) setAlpha(paint.opacity);
  }

  const rgb = hsvToRgb(hsv);
  const hex = rgbToHex(rgb);
  const hueHex = rgbToHex(hsvToRgb([hsv[0], 100, 100]));

  /**
   * 색을 내보내는 **유일한** 경로.
   *
   * 드래그 중에는 `onLive`, 뗄 때 `onCommit` 이다. 틱마다 커밋하면 슬라이더 한 번에 히스토리가
   * 수십 칸 쌓여 그 앞 작업이 41 의 상한(200) 밖으로 밀려난다.
   *
   * `color` 를 계산해서 넘기지 않고 인자로 받는 이유: hex 를 직접 입력하거나 스와치를 고른
   * 경우 그 문자열이 **정확히** 문서에 들어가야 한다(HSV 왕복은 한 칸 어긋날 수 있다).
   */
  const put = (color: string, h: Hsv, a: number, live: boolean) => {
    setHsv(h);
    setAlpha(a);
    setSeen({ color, opacity: a });
    const next: Solid = { ...paint, color, opacity: a };
    if (live) {
      onLive(next);
      return;
    }
    onCommit(next);
    pushRecent(color);
  };

  const putHex = (raw: string, live = false) => {
    const norm = normalizeHex(raw);
    if (!norm) return;
    put(norm, toHsv(norm), alpha, live);
  };

  const putRgb = (next: Rgb) => put(rgbToHex(next), rgbToHsv(next), alpha, false);

  return (
    <div aria-label={title} className="flex w-full flex-col gap-2">
      {/* SV — 가로 채도, 세로 명도. 흰→색상 위에 투명→검정을 겹치면 캔버스와 같은 그림이다. */}
      <DragArea
        label={msg.imageInspector.colorPicker.saturationValue}
        className="relative h-[120px] w-full rounded"
        style={{
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #FFF, ${hueHex})`,
        }}
        onDrag={(fx, fy, live) => {
          const next: Hsv = [hsv[0], fx * 100, (1 - fy) * 100];
          put(rgbToHex(hsvToRgb(next)), next, alpha, live);
        }}
      >
        <Thumb left={`${hsv[1]}%`} top={`${100 - hsv[2]}%`} color={hex} />
      </DragArea>

      <div className="flex items-center gap-2">
        <button
          type="button"
          title={msg.imageInspector.colorPicker.eyedropper}
          onClick={() => startEyedropper((picked) => putHex(picked))}
          className="shrink-0 rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <Pipette size={14} />
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <DragArea
            label={msg.imageInspector.colorPicker.hue}
            className="relative h-2.5 rounded-full"
            style={{
              background:
                "linear-gradient(to right, #F00, #FF0, #0F0, #0FF, #00F, #F0F, #F00)",
            }}
            onDrag={(fx, _fy, live) => {
              const next: Hsv = [fx * 360, hsv[1], hsv[2]];
              put(rgbToHex(hsvToRgb(next)), next, alpha, live);
            }}
          >
            <Thumb left={`${(hsv[0] / 360) * 100}%`} top="50%" color={hueHex} />
          </DragArea>

          <DragArea
            label={msg.imageInspector.vocab.opacity}
            className="relative h-2.5 rounded-full"
            style={{
              background: `linear-gradient(to right, ${rgba(rgb, 0)}, ${rgba(rgb, 1)}), ${CHECKER}`,
              backgroundSize: "auto, 8px 8px",
            }}
            onDrag={(fx, _fy, live) => put(hex, hsv, fx, live)}
          >
            <Thumb left={`${alpha * 100}%`} top="50%" color={hex} />
          </DragArea>
        </div>
      </div>

      {/* 색 모델 — 표시만 바꾼다. 값은 언제나 HSV 하나에서 파생된다. */}
      <div className="flex gap-1">
        {(["HEX", "RGB", "HSL"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setModel(m)}
            aria-pressed={model === m}
            className={`h-6 flex-1 rounded text-[11px] ${
              model === m ? "bg-raised text-fg" : "text-fg-dim hover:text-fg"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {model === "HEX" && (
        <div className="flex h-7 items-center gap-1.5">
          <span aria-hidden className="w-11 shrink-0 text-[11px] text-fg-dim">
            HEX
          </span>
          <input
            type="text"
            aria-label="HEX"
            autoComplete="off"
            spellCheck={false}
            value={hexDraft ?? hex}
            onChange={(e) => setHexDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                putHex(e.currentTarget.value);
                setHexDraft(null);
              } else if (e.key === "Escape") {
                // 팝오버를 닫기 **전에** 편집만 되돌린다. 여기서 멈추지 않으면 잘못 친 hex 를
                // 버리려던 Esc 가 팝오버까지 같이 닫는다.
                //
                // **초안이 없으면 삼키지 않는다.** 팝오버가 열릴 때 포커스가 이 입력에 오므로
                // (Popover 가 첫 input 을 잡는다) 그게 기본 상태인데, 그때도 막아 버리면
                // Popover 의 Escape 안전망까지 이벤트가 못 간다 — 42 캡처 리스너는 입력 안
                // Esc 를 `inTextField()` 에서 통과시키므로 그 안전망이 **유일한** 닫기 경로다.
                // 결과는 몇 번을 눌러도 안 닫히는 팝오버(X 버튼·바깥 클릭만 남는다).
                if (hexDraft === null) return;
                e.preventDefault();
                e.stopPropagation();
                setHexDraft(null);
              }
            }}
            onBlur={(e) => {
              putHex(e.currentTarget.value);
              setHexDraft(null);
            }}
            className="min-w-0 flex-1 rounded border border-edge bg-raised px-1.5 py-1 font-mono text-[12px] uppercase outline-none focus:border-accent"
          />
        </div>
      )}

      {model === "RGB" &&
        (["R", "G", "B"] as const).map((ch, i) => (
          <NumField
            key={ch}
            label={ch}
            value={rgb[i]}
            min={0}
            max={255}
            onCommit={(v) => {
              const next = [...rgb] as Rgb;
              next[i] = Math.round(v);
              putRgb(next);
            }}
          />
        ))}

      {model === "HSL" &&
        (() => {
          const hsl = rgbToHsl(rgb);
          return (["H", "S", "L"] as const).map((ch, i) => (
            <NumField
              key={ch}
              label={ch}
              value={hsl[i]}
              unit={i === 0 ? "°" : "%"}
              min={0}
              max={i === 0 ? 360 : 100}
              onCommit={(v) => {
                const next = [...hsl] as Hsl;
                next[i] = v;
                putRgb(hslToRgb(next));
              }}
            />
          ));
        })()}

      <NumField
        label={msg.imageInspector.vocab.opacity}
        value={Math.round(alpha * 100)}
        unit="%"
        min={0}
        max={100}
        onCommit={(v) => put(hex, hsv, v / 100, false)}
      />

      <Swatches
        label={msg.imageInspector.colorPicker.recent}
        colors={recent}
        current={hex}
        onPick={putHex}
      />
      {docColors && (
        <Swatches
          label={msg.imageInspector.colorPicker.documentColors}
          colors={docColors}
          current={hex}
          onPick={putHex}
        />
      )}

      {onSaveStyle && (
        <button
          type="button"
          onClick={onSaveStyle}
          className="h-6 rounded border border-edge text-[11px] text-fg-muted hover:bg-raised hover:text-fg"
        >
          {msg.imageInspector.colorPicker.saveAsStyle}
        </button>
      )}

      {/* 목록은 `Popover` 가 이미 폭과 스크롤을 정해 둔 자리라 `inline` 이다 — `popover` 모드의
          고정 폭 236 은 이 팝오버의 콘텐츠 폭(232 − p-2 좌우)을 넘겨 가로로 삐져나가고,
          자체 스크롤까지 겹치면 목록 안에 스크롤바가 하나 더 생긴다. */}
      {styles && <div className="mt-1 border-t border-edge pt-1">{styles}</div>}
    </div>
  );
}

// ── 조각 ────────────────────────────────────────────────────────────────────

/**
 * 포인터를 잡아 0–1 분수를 흘리는 면. SV·색상·알파가 같은 것을 쓴다.
 *
 * `setPointerCapture` 가 없으면 팝오버 밖으로 손이 나가는 순간 드래그가 끊겨 슬라이더가
 * 끝값에 못 닿는다. 키보드 조작은 아래 HEX/RGB/HSL·불투명도 입력이 담당한다 — 같은 값을
 * 두 방식으로 만질 수 있으므로 이 면 자체는 포인터 전용이다.
 */
function DragArea({
  label,
  className,
  style,
  onDrag,
  children,
}: {
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onDrag(fx: number, fy: number, live: boolean): void;
  children?: ReactNode;
}) {
  const pick = (e: ReactPointerEvent<HTMLDivElement>, live: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    onDrag(
      clamp01((e.clientX - r.left) / Math.max(1, r.width)),
      clamp01((e.clientY - r.top) / Math.max(1, r.height)),
      live,
    );
  };

  return (
    <div
      aria-label={label}
      className={className}
      style={{ touchAction: "none", ...style }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e, true);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) pick(e, true);
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        pick(e, false);
      }}
    >
      {children}
    </div>
  );
}

function Thumb({ left, top, color }: { left: string; top: string; color: string }) {
  return (
    <span
      aria-hidden
      style={{ left, top, background: color }}
      className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
    />
  );
}

function Swatches({
  label,
  colors,
  current,
  onPick,
}: {
  label: string;
  colors: readonly string[];
  current: string;
  onPick(hex: string): void;
}) {
  if (colors.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] text-fg-dim">{label}</div>
      <div className="flex gap-1">
        {colors.slice(0, SWATCH_COLS).map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-pressed={c.toUpperCase() === current}
            onClick={() => onPick(c)}
            style={{ background: c }}
            className={`h-4 w-4 rounded border ${
              c.toUpperCase() === current ? "border-accent" : "border-edge"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

// ── 순수 ────────────────────────────────────────────────────────────────────

function toHsv(hex: string): Hsv {
  return rgbToHsv(hexToRgb(hex) ?? [0, 0, 0]);
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 최근 색 기록. 42 스토어에 `recentColors` 필드는 있는데 **갱신 액션이 없어서**(42 §4 가 필드만
 * 요청했다) 여기서 `setState` 로 직접 쓴다 — 스토어 파일은 42 소유라 액션을 늘리지 않는다.
 * 같은 색을 다시 고르면 맨 앞으로 올린다(중복이 12칸을 채우면 기록이 한 색으로 도배된다).
 */
function pushRecent(hex: string): void {
  useImageEditorUi.setState((s) =>
    s.recentColors[0] === hex
      ? s
      : {
          recentColors: [hex, ...s.recentColors.filter((c) => c !== hex)].slice(0, RECENT_MAX),
        },
  );
}
