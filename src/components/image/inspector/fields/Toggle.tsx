// 인스펙터 스위치(시안 `Switch 24×14`) — 켬/끔/**불확정** 세 상태.
//
// `role="switch"` 가 아니라 `role="checkbox"` 인 이유: ARIA 에서 switch 는 `aria-checked`
// 에 `mixed` 를 허용하지 않는다. 다중 선택에서 값이 갈린 토글을 `false` 로 그리면 사용자는
// 한 번 눌렀을 때 전부 켜지는지 전부 꺼지는지 알 수 없다.
//
// MIXED 에서 누르면 **켠다**. 갈린 값을 한쪽으로 모으는 조작이니 사용자가 방금 만진 쪽으로
// 켜지는 편이 예측 가능하고, 되돌리려면 한 번 더 누르면 된다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.4

import { MIXED } from "../../../../lib/annotate/selection";

export function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean | typeof MIXED;
  label: string;
  onChange(v: boolean): void;
}) {
  const mixed = checked === MIXED;
  const on = checked === true;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? "mixed" : on}
      onClick={() => onChange(mixed ? true : !on)}
      className="flex h-7 w-full items-center justify-between gap-2 text-[12px] text-fg-muted hover:text-fg"
    >
      <span className="min-w-0 truncate">{label}</span>
      <span
        className={`relative h-3.5 w-6 shrink-0 rounded-full ${on ? "bg-accent" : "bg-raised"}`}
      >
        {/* 불확정은 손잡이를 **가운데**에 둔다 — 색만으로 구분하면 테마에 따라 꺼짐과 겹친다. */}
        <span
          style={{ left: mixed ? 7 : on ? 12 : 2 }}
          className={`absolute top-0.5 h-2.5 w-2.5 rounded-full ${
            on ? "bg-on-accent" : "bg-fg-dim"
          }`}
        />
      </span>
    </button>
  );
}
