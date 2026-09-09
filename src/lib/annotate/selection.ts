// 선택 분류와 다중 선택 속성 읽기 — "지금 무엇이 선택됐나"를 인스펙터·컨텍스트 바가 묻는 곳.
//
// **순수 함수만** 둔다(React·스토어 런타임 import 0). 45 컨텍스트 바·46 불리언 게이트·49
// 텍스트 혼합 스타일이 같은 판정을 렌더 밖에서도 써야 하기 때문이다 — 훅이 섞이는 순간
// 이 판정은 컴포넌트 안에서만 부를 수 있는 것이 된다.
//
// `readProp` 이 **세 상태**(값 하나 / MIXED / undefined)를 구분하는 것이 이 파일의 핵심이다.
// 셋을 뭉치면 인스펙터가 "0"·"값 없음"·"여러 값"을 같은 빈 칸으로 그리고, 사용자가 그 칸을
// 건드리는 순간 선택 전체가 모르는 값으로 덮인다.
//
// 배경: DOCS/task/42-image-editor-shell.md §3.1 선택 분류

import type { Mode } from "../../stores/imageEditor";
import type { Node, ObjId } from "./types";

export type SelectionKind =
  | "none"
  | "single-shape"
  | "multi"
  | "text"
  | "image"
  | "vector-edit"
  | "crop";

/**
 * 선택 상태를 인스펙터·컨텍스트 바가 쓰는 한 낱말로 줄인다.
 *
 * 우선순위는 45 §3.1 표가 정본이다: crop > vector-edit > none > image > text > single-shape > multi.
 *
 * **모드가 선택보다 먼저다** — 크롭·노드 편집 중에는 무엇이 선택돼 있든 그 모드의 UI 가
 * 떠야 한다. 선택을 먼저 보면 크롭 중에 다른 객체를 스치기만 해도 크롭 바가 사라지고,
 * 세션(48)은 살아 있는데 취소·적용 버튼만 화면에서 없어진다.
 *
 * 컨테이너(group/frame/instance)는 별도 종류가 아니다 — 하나면 `single-shape`, 여럿이면
 * `multi` 다. kind 별 가부(불리언 활성 등)는 각 소비자가 따로 거른다(45 §3.1 multi 행).
 */
export function classifySelection(
  objects: readonly Node[],
  selectedIds: readonly (ObjId | "__base")[],
  mode: Mode,
): SelectionKind {
  if (mode.kind === "crop") return "crop";
  if (mode.kind === "nodeEdit") return "vector-edit";
  if (selectedIds.length === 0) return "none";
  // `'__base'` 는 **끼어 있기만 하면** 이미지다. 스토어의 `normalizeSelection`(42)이 노드와
  // 섞인 조합을 이미 걷어내지만, 그 정규화를 거치지 않은 선택(복원·e2e 훅)이 한 번이라도 들어오면
  // 순서가 반대일 때 배경이 도형 취급을 받아 `setObjectFrame` 이 없는 노드로 간다.
  if (selectedIds.includes("__base")) return "image";
  if (selectedIds.length > 1) return "multi";
  const node = objects.find((o) => o.id === selectedIds[0]);
  // 텍스트는 **혼자 골랐을 때만** 텍스트다. 도형과 섞이면 multi 로 떨어져 공통 속성만 만진다 —
  // 안 그러면 50 의 텍스트 바가 fontSize·행간을 사각형에도 쓴다.
  return node?.kind === "text" ? "text" : "single-shape";
}

/** 여러 노드의 값이 갈렸음. `undefined`(어느 노드에도 없음)와 **다른 상태**다. */
export const MIXED: unique symbol = Symbol("annotate/mixed");

export type Maybe<T> = T | typeof MIXED;

/**
 * 선택된 노드들에서 속성 하나를 읽는다.
 *
 * - 값이 하나로 모이면 그 값
 * - 서로 다르면 `MIXED`(인스펙터는 빈 칸 + "여러 값" 플레이스홀더)
 * - **어느 노드에도 없으면 `undefined`** — 그 필드를 아예 숨긴다
 *
 * 값이 없는 노드는 **건너뛴다**(그 노드가 판정을 MIXED 로 끌어내리지 않는다). 텍스트+사각형을
 * 같이 고른 뒤 글자 크기를 읽으면 텍스트의 값이 나오고, 사각형은 그 필드에 대해 의견이 없다.
 */
export function readProp<T>(
  nodes: readonly Node[],
  get: (n: Node) => T | undefined,
  eq: (a: T, b: T) => boolean = Object.is,
): Maybe<T> | undefined {
  let acc: T | undefined;
  let found = false;
  for (const n of nodes) {
    const v = get(n);
    if (v === undefined) continue;
    if (!found) {
      acc = v;
      found = true;
      continue;
    }
    if (!eq(acc as T, v)) return MIXED;
  }
  return found ? acc : undefined;
}
