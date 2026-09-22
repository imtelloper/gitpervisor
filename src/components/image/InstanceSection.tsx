// 인스펙터 속성 탭 상단의 인스턴스 블록 — 시안 ⑤ `연결됨 / 재정의됨` + 세 동작.
//
// 45 가 선택을 `moveUnit`(51 §3.4)으로 좁혀 인스턴스 id 하나를 넘긴다. 자식을 선택한 상태에서도
// 같은 블록이 떠야 하기 때문이다 — 더블클릭으로 들어간 자식은 페인트·텍스트만 편집 대상이고,
// '분리'·'마스터 갱신'의 대상은 언제나 인스턴스 전체다.
//
// 세 동작 모두 문서와 라이브러리를 함께 건드린다(재설정=문서, 마스터 갱신=둘 다, 분리=문서).
// 그래서 여기서는 **아무것도 실행하지 않고** 콜백으로 올려 보낸다: `ImageEditor.applyDoc` 이
// 유일한 문서 깔때기라, 패널이 직접 커밋하면 히스토리 라벨과 커밋 시 재정의 파생(51 §3.5)이
// 통째로 우회된다.
//
// 배경: DOCS/task/51-image-styles-components.md §3.6·§3.8

import { useMessages } from "../../i18n/ui-language";
import { instanceState } from "../../lib/annotate/components";
import { nodeOf } from "../../lib/annotate/tree";
import type { Node, ObjId } from "../../lib/annotate/types";
import { useImageLibrary } from "../../stores/imageLibrary";

export interface InstanceSectionProps {
  objects: readonly Node[];
  /** `moveUnit` 으로 좁힌 인스턴스 id. null 이면 이 블록은 없다. */
  instId: ObjId | null;
  /** 재정의 초기화 — 마스터 값으로 되돌린다. */
  onReset(): void;
  /** 이 인스턴스로 마스터 갱신 — 다른 인스턴스의 재정의는 유지된다. */
  onPush(): void;
  /** 분리 — 보통 그룹이 된다(값은 그대로). */
  onDetach(): void;
}

export function InstanceSection({
  objects,
  instId,
  onReset,
  onPush,
  onDetach,
}: InstanceSectionProps) {
  const msg = useMessages();
  const components = useImageLibrary((s) => s.lib.components);

  const node = instId ? nodeOf(objects, instId) : null;
  if (!node || node.kind !== "instance") return null;

  const def = components.find((c) => c.id === node.componentId) ?? null;
  const overridden = instanceState(node) === "overridden";

  return (
    <section className="mt-3 first:mt-0">
      <div className="mb-1 text-[11px] text-fg-dim">{msg.imageInspector.instance.sectionTitle}</div>

      <div className="flex items-center gap-1.5 text-[11px]">
        <span
          title={def?.name}
          className={`min-w-0 flex-1 truncate ${def ? "text-fg-muted" : "text-fg-dim"}`}
        >
          {/* 마스터가 사라진 인스턴스는 다음 재동기(51 §3.7)가 분리한다 — 그 사이에만 보인다. */}
          {def?.name ?? msg.imageInspector.instance.missingComponent}
        </span>
        <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] text-accent">
          {overridden ? msg.imageInspector.instance.overridden : msg.imageInspector.instance.linked}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-1">
        <Action
          label={msg.imageInspector.instance.reset}
          // 재정의가 없으면 눌러도 문서가 그대로다 = 죽은 버튼. 회색으로 그 사실을 먼저 말한다.
          disabled={!overridden}
          title={msg.imageInspector.instance.resetTitle}
          onClick={onReset}
        />
        <Action
          label={msg.imageInspector.instance.pushMaster}
          disabled={!def}
          title={msg.imageInspector.instance.pushMasterTitle}
          onClick={onPush}
        />
        <Action
          label={msg.imageInspector.instance.detach}
          title={msg.imageInspector.instance.detachTitle}
          onClick={onDetach}
        />
      </div>
    </section>
  );
}

function Action({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-edge px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-40 disabled:hover:text-fg-muted"
    >
      {label}
    </button>
  );
}
