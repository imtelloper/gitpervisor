// 블렌드 19종 목록 — 인스펙터 `모양` 섹션·컨텍스트 바 Seg 의 `…`·효과 편집이 같은 콘텐츠를 연다.
//
// 네이티브 `<select>`(fields/Select)로 안 되는 것 하나 때문에 팝오버다: **그룹 구분선**.
// 19개를 한 줄로 늘어놓으면 `어둡게 계열`과 `밝게 계열`의 경계가 사라져, 사용자는 이름만 보고
// 곱하기와 스크린을 같은 무리로 읽는다(시안 ④ 는 `Sep` 5개로 6그룹을 나눈다).
//
// `pass-through` 는 리프에서 **목록에 남기고 비활성**으로 그린다. 빼 버리면 항목 수가 선택에
// 따라 19↔18 로 흔들려 사용자가 "아까 있던 게 없어졌다"로 읽고, 무엇보다 컨테이너에서만
// 쓸 수 있다는 사실 자체가 화면에서 사라진다. (리프에 실제로 쓰이면 37 정규화가 `normal` 로
// 되돌린다 — 그래서 눌리기만 하면 값이 조용히 어긋난다.)
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.8 · §7 (ins-8)

import { Check } from "lucide-react";

import { BLEND_LABELS } from "../../../lib/annotate/blend-labels";
import type { Maybe } from "../../../lib/annotate/selection";
import type { BlendMode } from "../../../lib/annotate/types";

export function BlendMenu({
  value,
  container,
  onChange,
}: {
  /** MIXED 면 아무 항목에도 체크가 없다 — 선택 전체가 같은 모드일 때만 "현재값"이 있다. */
  value: Maybe<BlendMode>;
  /** group/frame/instance 를 골랐는가. `pass-through` 의 가부가 여기서만 갈린다. */
  container: boolean;
  onChange(v: BlendMode): void;
}) {
  return (
    <div role="menu" aria-label="블렌드 모드" className="min-w-[140px]">
      {BLEND_LABELS.map((o, i) => {
        const disabled = o.value === "pass-through" && !container;
        const checked = value === o.value;
        return (
          <div key={o.value}>
            {i > 0 && o.group !== BLEND_LABELS[i - 1].group && (
              <div role="separator" className="my-1 h-px bg-edge" />
            )}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              disabled={disabled}
              onClick={() => onChange(o.value)}
              className={`flex h-6 w-full items-center gap-1.5 rounded px-1 text-left text-[12px] ${
                disabled
                  ? "cursor-default text-fg-dim opacity-50"
                  : "text-fg-muted hover:bg-raised hover:text-fg"
              }`}
            >
              {/* 체크 자리는 항상 비워 둔다 — 없을 때 글자가 왼쪽으로 밀리면 목록이 흔들린다. */}
              <span className="w-3 shrink-0 text-accent">
                {checked && <Check size={12} />}
              </span>
              {o.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
