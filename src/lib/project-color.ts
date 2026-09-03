import { useMemo } from "react";

import { useProjects } from "../queries";

// 프로젝트 색상환 — 균등 분할(30°씩)이 아니다. 균등하면 초록 구간(90~150°)에 여러 칸이 몰려
// 눈으로 갈리지 않는다. 실제로 구분되는 지점만 골라 12개를 둔다.
export const PROJECT_HUES: readonly number[] = [0, 25, 45, 75, 140, 168, 190, 215, 250, 280, 310, 335];

/**
 * 프로젝트 이름 → 색 배정.
 *
 * 이름 해시로 자리를 잡되 **이미 쓰인 자리면 다음 빈 자리로 민다.** 해시만 쓰면 한 화면에
 * 같은 색이 두 번 나온다 — 실측: gitpervisor(82°)와 nqvm-vis(80°)가 사실상 같은 초록이었다.
 * 반대로 순번으로만 배정하면 프로젝트가 하나 늘 때 나머지 색이 전부 밀린다. 해시 + 충돌 회피는
 * 둘 다 피한다: 겹치지 않으면 이름이 색을 결정하고(창·세션이 달라도 같은 색), 겹칠 때만 밀린다.
 *
 * 12색이 전부 쓰이면 `taken`을 비워 **새 바퀴**를 돈다. 안 비우면 13번째부터 선호 슬롯이 그대로
 * 중복돼 몇 색에 몰린다(등록 프로젝트 23~25개 실측). 보장 범위는 "이름순 12개 블록 안 중복 없음" —
 * 블록 경계(12번째↔13번째)는 13번째가 선호 슬롯을 그대로 받으므로 1/12 확률로 겹칠 수 있다.
 *
 * 색상(hue)만 돌려준다. 실제 칠은 **반투명 배경**이라(`projectTint`) 테마 배경 위에 얹히므로,
 * 라이트 2종·다크 4종 어디서든 글자 대비를 깨지 않고 칩·행만 물든다.
 */
export function assignProjectHues(names: string[]): Map<string, number> {
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const name of names) {
    if (out.has(name)) continue;
    if (taken.size === PROJECT_HUES.length) taken.clear();
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    const pref = Math.abs(h) % PROJECT_HUES.length;
    let slot = pref;
    for (let i = 0; i < PROJECT_HUES.length && taken.has(slot); i++) {
      slot = (pref + i + 1) % PROJECT_HUES.length;
    }
    taken.add(slot);
    out.set(name, PROJECT_HUES[slot]);
  }
  return out;
}

/** 틴트 단계 — 이름이 곧 `styles.css`의 `--proj-a-<level>` 변수다(칩 off/on · 사이드바 행 row/row-on). */
export type TintLevel = "off" | "on" | "row" | "row-on";

/**
 * 프로젝트 색 배경. 명도·알파는 테마 종류에 따라 갈리므로 CSS 변수로 뺐다(styles.css의
 * `--proj-*` 주석에 이유가 있다 — 같은 알파가 다크·라이트에서 반대로 작동한다).
 *
 * 선택 칩은 더 진하게(`on`) — 선택 표시는 ring이 하지만 배경까지 같으면 색만 보이고
 * 선택 여부가 안 읽힌다. 사이드바 행은 면적이 칩보다 훨씬 커서 별도 알파(`row`/`row-on`)를 쓴다.
 */
export function projectTint(hue: number, level: TintLevel): string {
  return `hsl(${hue} 70% var(--proj-l) / var(--proj-a-${level}))`;
}

/**
 * 등록된 전체 프로젝트를 이름순으로 한 번 배정 — 사이드바 행·모아보기 칩·셀 헤더가 같은 맵을 본다.
 *
 * 이름순인 이유: 표시 순서(드래그 정렬·"변경 있는 프로젝트 위로")와 무관하게 색이 고정돼야
 * "배경색으로 프로젝트를 기억한다"가 성립한다. 화면에 보이는 부분집합으로 배정하면 열린 터미널이
 * 바뀔 때마다 충돌 밀림 결과가 달라져 같은 프로젝트의 색이 이동한다.
 */
export function useProjectHues(): Map<string, number> {
  const { data: projects } = useProjects();
  return useMemo(
    () =>
      assignProjectHues(
        (projects ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b, "ko")),
      ),
    [projects],
  );
}
