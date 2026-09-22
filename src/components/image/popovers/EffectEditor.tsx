// 효과 한 겹 편집 — 인스펙터 `효과` 스택의 행 `설정` 이 이 콘텐츠를 띄운다.
//
// 섀도(드롭/이너)와 블러(레이어/배경)는 **필드 구성이 아예 다르다**(37 `Effect` 는 두 갈래
// 유니온이다). 한 화면에 다 그려 놓고 비활성으로 두면 블러에 `확산` 같은 뜻 없는 칸이 남아,
// 사용자가 그 값을 바꿔 놓고 왜 안 변하는지 묻게 된다. 그래서 타입으로 갈라 그린다.
//
// 미리보기 칩은 CSS `box-shadow`/`filter` 다 — 캔버스를 올리면 e2e 의 `canvases()[0]/[1]`
// 인덱스가 밀린다. 흐림 반경은 canvas 의 σ 환산(39 `BLUR_SIGMA`)과 정확히 같지 않아 **모양만**
// 맞는 근사다. 정확한 결과는 캔버스 프리뷰가 보여 주므로 여기서 맞출 이유가 없다.
//
// 시안 ④ 의 `Blend "곱하기"` 행은 그리지 않는다 — 37 `Effect` 에 `blend` 필드가 없다(설계 §3.10
// 미해결). 37 이 필드를 추가하면 여기에 `Select` 한 줄이 는다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.8 효과 편집

import { useState } from "react";
import { Eye, EyeOff, Minus } from "lucide-react";

import type { Messages } from "../../../i18n/messages";
import { useMessages } from "../../../i18n/ui-language";
import type { Effect, Paint } from "../../../lib/annotate/types";
import { hexToRgb } from "../../../lib/color";
import { NumField } from "../inspector/fields/NumField";
import { Select } from "../inspector/fields/Select";
import { ColorPicker } from "./ColorPicker";
import { Popover } from "./Popover";

function shadowKindsFor(msg: Messages) {
  return [
    { value: "drop-shadow" as const, label: msg.imageInspector.effectEditor.kindDrop },
    { value: "inner-shadow" as const, label: msg.imageInspector.effectEditor.kindInner },
  ];
}

export interface EffectEditorProps {
  effect: Effect;
  onLive(e: Effect): void;
  onCommit(e: Effect): void;
  onRemove(): void;
  onToggle(): void;
}

export function EffectEditor({ effect, onLive, onCommit, onRemove, onToggle }: EffectEditorProps) {
  const msg = useMessages();
  const [colorAnchor, setColorAnchor] = useState<HTMLElement | null>(null);

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {/* 조건을 변수로 빼지 않는다 — 그러면 `effect` 가 4갈래 유니온인 채로 남아
            `{...effect, type: v}` 가 블러에도 섀도 타입을 넣는 코드로 읽힌다. */}
        {(effect.type === "drop-shadow" || effect.type === "inner-shadow") && (
          <Select
            label={msg.imageInspector.effectEditor.kindSelect}
            value={effect.type}
            options={shadowKindsFor(msg)}
            onChange={(v) => onCommit({ ...effect, type: v })}
          />
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onToggle}
          title={effect.visible ? msg.imageInspector.vocab.hide : msg.imageInspector.vocab.show}
          className="shrink-0 text-fg-dim hover:text-fg"
        >
          {effect.visible ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title={msg.imageInspector.vocab.remove}
          className="shrink-0 text-fg-dim hover:text-fg"
        >
          <Minus size={12} />
        </button>
      </div>

      <div className="flex h-11 items-center justify-center rounded border border-edge bg-raised">
        <span style={chipStyle(effect)} className="h-6 w-16 rounded bg-panel" />
      </div>

      {/* `"radius" in effect` 로 가른다. `type === "layer-blur" || type === "background-blur"` 는
          **거짓 가지를 좁히지 못한다** — 판별자 자체가 리터럴 유니온이라 TS 가 그 멤버를 쪼개지
          못하고, 아래 섀도 필드가 전부 "Effect 에 x 가 없다" 로 터진다. */}
      {"radius" in effect ? (
        <NumField
          label={msg.imageInspector.vocab.radius}
          value={effect.radius}
          unit="px"
          min={0}
          onCommit={(v) => onCommit({ ...effect, radius: v })}
          onLive={(v) => onLive({ ...effect, radius: v })}
          onLiveEnd={() => onCommit(effect)}
        />
      ) : (
        <>
          <NumField
            label="X"
            value={effect.x}
            unit="px"
            onCommit={(v) => onCommit({ ...effect, x: v })}
            onLive={(v) => onLive({ ...effect, x: v })}
            onLiveEnd={() => onCommit(effect)}
          />
          <NumField
            label="Y"
            value={effect.y}
            unit="px"
            onCommit={(v) => onCommit({ ...effect, y: v })}
            onLive={(v) => onLive({ ...effect, y: v })}
            onLiveEnd={() => onCommit(effect)}
          />
          <NumField
            label={msg.imageInspector.effectEditor.blur}
            value={effect.blur}
            unit="px"
            min={0}
            onCommit={(v) => onCommit({ ...effect, blur: v })}
            onLive={(v) => onLive({ ...effect, blur: v })}
            onLiveEnd={() => onCommit(effect)}
          />
          <NumField
            label={msg.imageInspector.effectEditor.spread}
            value={effect.spread}
            unit="px"
            onCommit={(v) => onCommit({ ...effect, spread: v })}
            onLive={(v) => onLive({ ...effect, spread: v })}
            onLiveEnd={() => onCommit(effect)}
          />

          <div className="flex h-7 items-center gap-1.5">
            <button
              type="button"
              title={msg.imageInspector.vocab.color}
              onClick={(e) => setColorAnchor(e.currentTarget)}
              style={{ background: effect.color }}
              className="h-4 w-4 shrink-0 rounded border border-edge"
            />
            <span className="w-16 shrink-0 font-mono text-[11px] text-fg-muted">
              {effect.color}
            </span>
            <div className="min-w-0 flex-1">
              <NumField
                label={msg.imageInspector.effectEditor.alpha}
                value={Math.round(effect.opacity * 100)}
                unit="%"
                min={0}
                max={100}
                onCommit={(v) => onCommit({ ...effect, opacity: v / 100 })}
              />
            </div>
          </div>

          {colorAnchor && (
            <Popover
              anchor={colorAnchor}
              open
              onClose={() => setColorAnchor(null)}
              placement="left-start"
              width={232}
              title={msg.imageInspector.effectEditor.colorPopoverTitle}
            >
              <ColorPicker
                title={msg.imageInspector.effectEditor.colorPickerTitle}
                paint={{ type: "solid", color: effect.color, opacity: effect.opacity }}
                onLive={(p) => applyColor(p, effect, onLive)}
                onCommit={(p) => applyColor(p, effect, onCommit)}
              />
            </Popover>
          )}
        </>
      )}
    </div>
  );
}

/** 색 피커는 `Paint` 를 돌려주는데 `Effect` 는 색과 알파를 따로 든다 — 여기서만 갈라 넣는다. */
function applyColor(
  p: Paint,
  effect: Effect,
  out: (e: Effect) => void,
): void {
  if (p.type !== "solid" || "radius" in effect) return;
  out({ ...effect, color: p.color, opacity: p.opacity });
}

/**
 * 미리보기 칩의 CSS. 드롭/이너는 `box-shadow` 가 같은 그림을 그리고(이너는 `inset`),
 * 블러는 칩 자체를 흐린다. 배경 블러는 팝오버 안에 배경이랄 게 없어 레이어 블러와 같게 보인다.
 */
function chipStyle(e: Effect): React.CSSProperties {
  if ("radius" in e) return { filter: `blur(${e.radius}px)` };
  const rgb = hexToRgb(e.color);
  const c = rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${e.opacity})` : e.color;
  const inset = e.type === "inner-shadow" ? "inset " : "";
  return { boxShadow: `${inset}${e.x}px ${e.y}px ${e.blur}px ${e.spread}px ${c}` };
}
