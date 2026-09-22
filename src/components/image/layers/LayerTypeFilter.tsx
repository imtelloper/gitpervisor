// 레이어 타입 필터 팝오버의 **콘텐츠**(시안 ④ w236). 셸(앵커·백드롭)은 호출부가 준다 —
// 45 가 `Popover` 프리미티브를 내면 그쪽으로 갈아 끼운다.
//
// 초안(draft)을 들고 `적용`에서만 밖으로 내보낸다. 체크할 때마다 목록이 튀면 여러 조건을
// 조합하는 동안 화면이 계속 흔들리고, 되돌리려면 껐던 것을 하나씩 다시 켜야 한다.
// `초기화`는 **초안만** 기본값으로 되돌린다(그 다음 `적용`이 실제로 쓴다).
//
// 배경: DOCS/task/44-image-panels.md §3.2

import { useEffect, useState } from "react";

import type { Messages } from "../../../i18n/messages";
import { useMessages } from "../../../i18n/ui-language";
import {
  DEFAULT_LAYER_FILTER,
  type LayerFilter,
  type LayerType,
} from "../../../lib/annotate/layer-rows";

function typesFor(msg: Messages): readonly { id: LayerType; label: string }[] {
  const t = msg.imagePanels.layerFilter;
  return [
    { id: "frame", label: t.typeFrame },
    { id: "group", label: t.typeGroup },
    { id: "shape", label: t.typeShape },
    { id: "text", label: t.typeText },
    { id: "image", label: t.typeImage },
    { id: "vector", label: t.typeVector },
    { id: "component", label: t.typeComponent },
  ];
}

type StateKey = "hiddenOnly" | "lockedOnly" | "overriddenOnly" | "includeMasks";

function statesFor(msg: Messages): readonly { id: StateKey; label: string }[] {
  const t = msg.imagePanels.layerFilter;
  return [
    { id: "hiddenOnly", label: t.hiddenOnly },
    { id: "lockedOnly", label: t.lockedOnly },
    { id: "overriddenOnly", label: t.overriddenOnly },
    { id: "includeMasks", label: t.includeMasks },
  ];
}

export interface LayerTypeFilterProps {
  value: LayerFilter;
  onApply(f: LayerFilter): void;
}

export function LayerTypeFilter({ value, onApply }: LayerTypeFilterProps) {
  const msg = useMessages();
  const t = msg.imagePanels.layerFilter;
  const [draft, setDraft] = useState<LayerFilter>(value);
  // 팝오버가 닫힌 채 살아 있을 수 있으므로(호출부 사정) 밖에서 값이 바뀌면 초안을 맞춘다.
  useEffect(() => setDraft(value), [value]);

  const toggleType = (t: LayerType) =>
    setDraft((d) => {
      const types = new Set(d.types);
      if (types.has(t)) types.delete(t);
      else types.add(t);
      return { ...d, types };
    });

  return (
    <div style={{ width: 236 }} className="flex flex-col gap-1 text-[11px]">
      <div className="px-1 pt-1 text-fg-dim">{t.typeHeading}</div>
      {typesFor(msg).map((ty) => (
        <Check
          key={ty.id}
          label={ty.label}
          checked={draft.types.has(ty.id)}
          onChange={() => toggleType(ty.id)}
        />
      ))}

      <div className="my-1 border-t border-edge" />

      {statesFor(msg).map((s) => (
        <Check
          key={s.id}
          label={s.label}
          checked={draft[s.id]}
          onChange={() => setDraft((d) => ({ ...d, [s.id]: !d[s.id] }))}
        />
      ))}

      <div className="mt-1 flex justify-end gap-1 border-t border-edge pt-2">
        <button
          onClick={() => setDraft(DEFAULT_LAYER_FILTER)}
          className="rounded border border-edge px-2 py-1 text-fg-muted hover:text-fg"
        >
          {t.reset}
        </button>
        <button
          onClick={() => onApply(draft)}
          className="rounded bg-accent px-2 py-1 text-on-accent hover:bg-accent-hover"
        >
          {t.apply}
        </button>
      </div>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(): void;
}) {
  return (
    <label
      style={{ height: 26 }}
      className="flex cursor-pointer items-center gap-2 rounded px-1 text-fg-muted hover:bg-raised hover:text-fg"
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-accent" />
      {label}
    </label>
  );
}
