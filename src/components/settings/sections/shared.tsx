// 설정 섹션 공용 프리미티브 (태스크 18). SettingsDialog가 아닌 여기 두어 셸↔섹션 순환 의존을 끊는다.
import type { ReactNode } from "react";

import type { Settings } from "../../../lib/ipc";

/** 폼 섹션 공용 props — form/update는 셸 소유, hl은 검색 하이라이트 키 집합. */
export interface SectionProps {
  form: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  hl: Set<string>;
}

export const inputCls =
  "w-full rounded border border-edge bg-base px-2 py-1 outline-none focus:border-accent";

/** 라벨(위) + 내용 + 힌트(아래) 래퍼. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-medium">{label}</div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-fg-dim">{hint}</div>}
    </div>
  );
}

/**
 * 하이라이트 래퍼 — 검색 매칭 필드에 accent 링. Field prop이 아닌 범용 래퍼라 체크박스·raw input·
 * 테마 그리드 등 Field를 안 쓰는 필드도 감쌀 수 있다(태스크 18 §4). `id`는 Settings 키 또는
 * 비-키 항목(시크릿·즉시 액션)의 식별자. `hl`에 있으면 강조.
 */
export function Hl({ id, hl, children }: { id?: string; hl: Set<string>; children: ReactNode }) {
  const on = id != null && hl.has(id);
  return (
    <div
      data-setting-key={id}
      className={on ? "-mx-1 rounded px-1 ring-1 ring-accent" : undefined}
    >
      {children}
    </div>
  );
}
