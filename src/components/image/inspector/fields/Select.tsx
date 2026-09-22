// 인스펙터 단일 선택 목록(정렬·대시·캡·조인·제약·블렌드).
//
// 네이티브 `<select>` 다. 설계(§3.4)는 `Popover` 위의 목록을 적었지만, 계약(§4)에 앵커·배치
// props 가 없고 저장소는 같은 편집기 안에서 이미 `<select>` 를 쓴다(`SnapSection.tsx` 그리드).
// 네이티브가 키보드 탐색·타이핑 점프·뷰포트 플립·스크롤을 전부 갖고 오므로 직접 만들 이유가
// 없다 — 19항목 블렌드 목록의 **그룹 구분선**처럼 네이티브로 안 되는 것은 그 팝오버(`BlendMenu`)가
// 따로 그린다.
//
// `V` 를 문자열로 제약하지 않으려고 option 의 value 에는 **인덱스**를 넣는다. 값이 숫자거나
// 객체여도 왕복이 깨지지 않는다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.4

import { useMessages } from "../../../../i18n/ui-language";
import { MIXED, type Maybe } from "../../../../lib/annotate/selection";

export interface SelectOption<V> {
  value: V;
  label: string;
  disabled?: boolean;
}

export function Select<V>({
  value,
  options,
  onChange,
  label,
}: {
  value: Maybe<V>;
  options: readonly SelectOption<V>[];
  onChange(v: V): void;
  /** 화면에 라벨이 따로 없을 때의 접근성 이름. */
  label?: string;
}) {
  const msg = useMessages();
  const mixed = value === MIXED;
  const idx = mixed ? -1 : options.findIndex((o) => Object.is(o.value, value));

  return (
    <select
      aria-label={label}
      value={idx < 0 ? "" : String(idx)}
      onChange={(e) => {
        const i = Number(e.target.value);
        // 자리표시자(빈 문자열)를 다시 고른 경우 — 아무 것도 쓰지 않는다. 여기서 0번을
        // 쓰면 MIXED 선택이 목록 첫 항목으로 조용히 통일된다.
        if (Number.isInteger(i) && options[i]) onChange(options[i].value);
      }}
      className="min-w-0 flex-1 rounded border border-edge bg-raised px-1.5 py-1 text-[12px] outline-none focus:border-accent"
    >
      {idx < 0 && (
        // MIXED 와 "목록에 없는 값"을 같은 칸으로 그린다 — 둘 다 사용자가 고른 적 없는
        // 상태이고, 어느 쪽이든 그대로 두면 문서는 바뀌지 않는다.
        <option value="" disabled>
          {mixed ? msg.imageInspector.vocab.mixedValues : "—"}
        </option>
      )}
      {options.map((o, i) => (
        <option key={i} value={String(i)} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
