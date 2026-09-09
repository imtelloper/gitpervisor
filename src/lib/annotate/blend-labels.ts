// 블렌드 19종의 화면 라벨 — 블렌드 목록·인스펙터 `모양` 섹션·컨텍스트 바 Seg 가 같은 표를 본다.
//
// `BlendMode` 값은 canvas `globalCompositeOperation` 철자라 그대로 못 보여 준다(types.ts:57).
// 라벨을 UI 마다 따로 적으면 같은 모드가 드롭다운에서는 `소프트 라이트`, 컨텍스트 바에서는
// `소프트` 로 나오고, 사용자는 두 개를 다른 기능으로 읽는다.
//
// 순서·구분선은 시안 ④ 그대로(`BM` 19 · `Sep` 5 → 6그룹). types.ts 의 `BLEND_MODES` 와는
// 번/닷지 순서가 다르다 — 시안은 `색상 → 선형`, 그쪽은 렌더 매핑 순서다. **목록 표시는 이 표가,
// 정규화 검증은 `BLEND_MODES` 가 정본이다.**

import type { BlendMode } from "./types";

/** `group` 은 값이 아니라 **경계**다 — 이전 항목과 다르면 그 자리에 구분선을 그린다. */
export const BLEND_LABELS = [
  { value: "pass-through", label: "패스스루", group: 0 },
  { value: "normal", label: "표준", group: 0 },

  { value: "darken", label: "어둡게", group: 1 },
  { value: "multiply", label: "곱하기", group: 1 },
  { value: "color-burn", label: "색상 번", group: 1 },
  { value: "linear-burn", label: "선형 번", group: 1 },

  { value: "lighten", label: "밝게", group: 2 },
  { value: "screen", label: "스크린", group: 2 },
  { value: "color-dodge", label: "색상 닷지", group: 2 },
  { value: "linear-dodge", label: "선형 닷지", group: 2 },

  { value: "overlay", label: "오버레이", group: 3 },
  { value: "soft-light", label: "소프트 라이트", group: 3 },
  { value: "hard-light", label: "하드 라이트", group: 3 },

  { value: "difference", label: "차이", group: 4 },
  { value: "exclusion", label: "제외", group: 4 },

  { value: "hue", label: "색조", group: 5 },
  { value: "saturation", label: "채도", group: 5 },
  { value: "color", label: "색상", group: 5 },
  { value: "luminosity", label: "광도", group: 5 },
] as const satisfies readonly { value: BlendMode; label: string; group: number }[];

/**
 * 모드를 하나라도 빠뜨리면 `Exclude` 가 `never` 가 아니게 되어 **이 줄이 컴파일 에러**다.
 * 런타임에 발견하면 이미 늦다 — 드롭다운에 조용히 구멍이 나 있고, 그 모드로 저장된 문서는
 * 열어도 현재값이 목록에 없어 아무 항목도 선택돼 보이지 않는다.
 */
export const BLEND_LABELS_COMPLETE: Exclude<
  BlendMode,
  (typeof BLEND_LABELS)[number]["value"]
> extends never
  ? true
  : never = true;
