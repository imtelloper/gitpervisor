// 프로젝트 색 — 사이드바 행 배경·좌측 스트라이프, 모아보기 칩·셀 헤더가 같은 값을 쓴다.
//
// 왜 12 → 32슬롯인가: 등록 프로젝트가 26개인데 슬롯이 12개뿐이라 **16쌍이 완전히 같은 색**
// (ΔE00 0.00)이었다. 색상환을 32칸으로 늘리고, 다크에서는 슬롯 i의 명도를 `i % 2`로 갈라
// (2톤) 이웃한 hue끼리도 명도로 떨어뜨린다. 실측 26개·325쌍 최소 지각거리:
// darcula 9.98 · monokai 8.10 · dracula 8.44 · nord 8.93 · light 8.03 · solarized-light 7.02
// (전 테마에서 "명백히 다른 색" 문턱 5 위, <5인 쌍 0개).
//
// 왜 CSS가 아니라 JS가 `#rrggbb`를 계산하는가: `oklch()`를 CSS에 쓰면 게멋 밖 색의 매핑이
// 브라우저(WebView2/WebKit) 몫이라 실제로 칠해지는 값을 코드가 모른다 — 대비 증명이 불가능해진다.
// 여기서 sRGB 안쪽 최대 채도를 직접 이분탐색해 8비트 hex로 확정한다(외부 의존성 0).
//
// 왜 명도를 이분탐색으로 유도하는가: 테마마다 상수를 박으면 커스텀 테마(태스크 29)에 해가 없다.
// 대비비는 배경 휘도에 대해 단조라, "32슬롯 × 8토큰이 전부 통과하는 구간"의 극단을 이분탐색으로
// 찾으면 최악 hue가 정의상 그 극단에 붙는다 — 테마별 하드코딩 0개로 6종 + 커스텀이 같은 경로를 탄다.
// 실측 최악 슬롯: 다크 4종 158° tone0, 라이트 2종 326° tone1. 기준선 대비 최소 여유 +0.061.
import { useMemo, useSyncExternalStore } from "react";

import { useProjects } from "../queries";
import { useCustomThemes } from "../stores/customThemes";
import { BUILTIN_TOKENS, contrastRatio } from "./theme-apply";
import { loadCustomThemes, type ThemeToken } from "./themes";

// 프로젝트 색상환 32개(OKLCH deg). 균등 분할이 아니다 — 6종 테마에서 동시에 CIEDE2000
// 최소 쌍거리를 최대화하도록 고른 좌표다(초록 구간은 눈이 덜 갈려 간격을 벌렸다).
export const PROJECT_HUES: readonly number[] = [
  0, 12, 23, 34, 45, 56, 68, 79, 90, 101, 113, 124, 135, 146, 158, 164, 180, 191, 203, 214, 225,
  236, 248, 257, 270, 279, 294, 304, 316, 326, 338, 349,
];

const CAP = 0.11; // 채도 상한 — 게멋 최대는 hue별로 3.75배 벌어져 안 씌우면 팔레트가 한 시스템으로 안 보인다
const TONE_D = 0.07; // 다크 전용 2톤 간격(실측: d=0.07에서 다크 최소 ΔE00가 최대)
const MARGIN = 0.008; // 이분탐색 결과에서 물러나는 안전 마진(8비트 반올림·엔진 차이)
const STRIPE_D = 0.105; // 스트라이프 2톤 간격
// FG·FLOORS를 export 하는 이유는 main.tsx:74의 builtinTokens와 같다 — e2e 19가 대비를 재려면
// 이 두 값이 필요한데, 노출이 없으면 테스트가 손사본을 들고 있게 되고 사본은 여기를 고쳐도
// 조용히 옛 값으로 통과한다(실제로 옛 e2e 19가 12 hue 사본으로 32슬롯 팔레트를 안 재고 PASS했다).
// `satisfies readonly ThemeToken[]` — themes.ts THEME_TOKENS에 없는 토큰을 컴파일 타임에 막는다
// (없는 토큰을 넣으면 c[k]가 undefined인 채 contrastRatio로 들어간다).
export const FG = [
  "fg",
  "fg-muted",
  "fg-dim",
  "mod",
  "add",
  "untrk",
  "danger",
  "accent",
] as const satisfies readonly ThemeToken[];
// 절대 하한 — "기준선(선택 행) 이상"만 보면 기준선 자체가 무너진 커스텀 테마에서 같이 무너진다.
// 실측(라이트 토큰 + selection #3574f0): 하한을 빼면 fg 3.75 / muted 1.72 / dim 1.20까지 내려간다.
// FG **전수**(Partial 아님)라 FG에 토큰을 추가하면 여기 키 누락으로 컴파일이 깨진다 — 하한이
// 조용히 없는 상태로 새 토큰이 들어가는 걸 막는 게 이 타입의 목적이다.
// 0 = "의도적으로 하한 없음". 그 토큰은 기준선(선택 행 위 대비) 이상만 요구한다.
// `as const satisfies` — 타입 표기 대신 이 형태를 쓰는 이유는 초과 키(오타) 차단이 **fresh
// 객체 리터럴**에만 걸리는 검사라, 나중에 스프레드 조립(`{...DEFAULTS, fg: 4.5}`)이나 별도
// 변수 경유로 리팩터하면 표기형은 누락(TS2741)만 남고 오타를 놓치기 때문이다.
// 주의: 이 값은 단언값이자 **이분탐색의 입력**이다(아래 rowOk → edge) — 도달 가능한 값으로
// 올리면 팔레트가 따라 어두워져 e2e 19가 그대로 통과한다(실측: fg 4.5→9.9에서 darcula worst
// fg가 7.70→10.20으로 **이동**). e2e 19의 okAbs가 실제로 무는 것은 해가 없어 무하한 폴백
// (L0raw 2단계)으로 떨어질 때뿐이다(실측: fg=21 → 6/6 테마 FAIL).
export const FLOORS = {
  fg: 4.5,
  "fg-muted": 3.0,
  "fg-dim": 2.0,
  mod: 0,
  add: 0,
  untrk: 0,
  danger: 0,
  accent: 0,
} as const satisfies Record<(typeof FG)[number], number>;

export type ProjColor = { bg: string; stripe: string };
export const NO_COLOR: ProjColor = { bg: "transparent", stripe: "transparent" };

/* ── OKLab ↔ sRGB (외부 의존성 0) ── */
const lin2s = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, c)) * 255);
};
const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function oklchLin(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180),
    b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** 그 명도·색상에서 sRGB 안에 드는 최대 채도 — 게멋 매핑을 브라우저에 맡기지 않는다. */
function maxC(L: number, h: number): number {
  let lo = 0,
    hi = 0.42;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (oklchLin(L, m, h).every((v) => v >= -1e-4 && v <= 1 + 1e-4)) lo = m;
    else hi = m;
  }
  return lo;
}

const oklchHex = (L: number, C: number, h: number) =>
  "#" +
  oklchLin(L, C, h)
    .map((v) => lin2s(v).toString(16).padStart(2, "0"))
    .join("");

/** "#rrggbb" → OKLab L. 해가 없는 극단 커스텀 테마의 폴백 명도를 패널에서 뽑을 때만 쓴다. */
function oklabL(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => s2lin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/** pred가 참인 구간(연속)의 극단 L. up이면 통과하는 가장 큰 L, 아니면 가장 작은 L. */
function edge(pred: (L: number) => boolean, up: boolean): number | null {
  let ok = up ? 0.02 : 0.999,
    bad = up ? 0.999 : 0.02;
  if (!pred(ok)) return null;
  for (let i = 0; i < 14; i++) {
    const m = (ok + bad) / 2;
    if (pred(m)) ok = m;
    else bad = m;
  }
  return ok;
}

// 키가 테마 id**만**이면 안 된다: 커스텀 테마 편집은 id를 보존한 채 색만 바꾸므로
// (stores/customThemes.upsert가 같은 id를 교체) 편집 후에도 옛 팔레트가 영원히 나온다 —
// 모듈 스코프 Map이라 창을 새로고침하기 전까지 복구되지 않고, 다크 테마를 라이트로 편집하면
// 흰 패널 위에 어두운 행이 남아 이 설계의 대비 보증이 통째로 무효가 된다. 토큰 값까지 키에
// 넣으면 정의가 바뀐 순간 자동으로 미스가 난다(내장 6종은 토큰이 불변이라 언제나 히트).
const cache = new Map<string, ProjColor[]>();

/** 테마 id → 32슬롯 팔레트(메모). 테마 토큰만 보고 계산한다 — 테마별 상수 0개.
 *  첫 호출 실측 3.5ms(Node), 이후는 캐시라 테마 전환이 프레임을 먹지 않는다. */
export function projectPalette(themeId: string): ProjColor[] {
  // `Record<ThemeToken, string>` — 아래 c[k]/c.panel 사용처에도 FG와 같은 제약을 걸어
  // 존재하지 않는 토큰이 undefined인 채 contrastRatio로 들어가는 걸 2중으로 막는다.
  const c: Record<ThemeToken, string> =
    BUILTIN_TOKENS[themeId as keyof typeof BUILTIN_TOKENS] ??
    loadCustomThemes().find((t) => t.id === themeId)?.colors ??
    BUILTIN_TOKENS.darcula;
  const key = `${themeId}|${JSON.stringify(c)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // 다크/라이트는 base id가 아니라 **실제 팔레트**로 판정한다 — 커스텀 테마는 "다크 기반 +
  // 라이트 색"이 가능해서 상속원 id로 명도를 고르면 반대로 칠해진다(옛 TINT[t.base]의 버그).
  const dark = contrastRatio(c.fg, "#000000") >= contrastRatio(c.panel, "#000000");
  const base: Record<string, number> = {};
  for (const k of FG) base[k] = contrastRatio(c[k], c.selection);

  // 행 배경: 32 hue 전부가 (a) 그 테마의 선택 행 위 대비 이상 (b) 절대 하한 이상.
  // 다크의 tone1(L0−TONE_D)은 더 어두워 대비가 **올라가므로** 검사가 필요 없다.
  const rowOk = (L: number, floors: boolean) =>
    PROJECT_HUES.every((h) => {
      const bg = oklchHex(L, Math.min(CAP, 0.95 * maxC(L, h)), h);
      return FG.every((k) => {
        const v = contrastRatio(c[k], bg);
        return v >= base[k] && (!floors || v >= FLOORS[k]);
      });
    });
  const L0raw = edge((L) => rowOk(L, true), dark) ?? edge((L) => rowOk(L, false), dark);
  // 2·3단계 폴백은 FLOORS를 보증하지 않는다 — 애초에 하한을 만족하는 L이 없는 테마에만
  // 닿는 경로다(예: darcula 토큰 + panel #ffffff처럼 fg가 패널 위에서 이미 안 읽히는 테마.
  // 그런 테마는 행 색과 무관하게 앱 전체가 못 읽는 상태다). 여기서 색을 포기하는 대신
  // 패널에서 명도를 떼어 "칠해진 게 보이기는 한다"까지만 보장한다.
  const L0 =
    L0raw === null
      ? oklabL(c.panel) + (dark ? 0.07 : -0.07) // 해가 없는 극단 테마(fg가 panel과 같은 쪽) 폴백
      : L0raw + (dark ? -MARGIN : MARGIN);

  // 스트라이프: 글자가 없어 비텍스트 3:1만 받는다 → 채도를 게멋 끝까지 쓴다.
  // 라이트 2종은 배경 명도 예산이 없어(최소 ΔE00 1.7~2.2) 구분의 몫을 여기가 받는다.
  const stripeOk = (L: number) =>
    PROJECT_HUES.every((h) => contrastRatio(oklchHex(L, maxC(L, h), h), c.panel) >= 3.05);
  const s = edge(stripeOk, !dark) ?? (dark ? 0.62 : 0.58);
  const sPair: [number, number] = dark ? [s, s + STRIPE_D] : [s - STRIPE_D, s];

  const pal = PROJECT_HUES.map((h, i) => {
    const bgL = dark && i % 2 ? L0 - TONE_D : L0; // 라이트는 명도 예산이 없어 1톤(2톤이면 오히려 악화)
    const stL = sPair[i % 2];
    return {
      bg: oklchHex(bgL, Math.min(CAP, 0.95 * maxC(bgL, h)), h),
      stripe: oklchHex(stL, maxC(stL, h), h),
    };
  });
  cache.set(key, pal);
  return pal;
}

/**
 * 이름 → 슬롯. 해시 선호 슬롯 + **이중 해싱** 탐사.
 *
 * 겹치지 않으면 이름이 색을 결정하고(창·세션이 달라도 같은 색), 겹칠 때만 민다. 옛 선형 탐사는
 * 1차 군집이 생겨 프로젝트를 하나 추가할 때 평균 5.63개(최악 11개)의 색이 따라 움직였다 —
 * 이중 해싱은 같은 실측에서 **1.04개(최악 5)**, 제거 시 0.58개다. step은 홀수라 N=32와 서로소,
 * 즉 탐사가 32칸 전부를 방문한다. 33번째부터 `taken`을 비워 새 바퀴를 돈다(그때부터 중복 1쌍).
 */
export function assignProjectSlots(names: string[]): Map<string, number> {
  const N = PROJECT_HUES.length; // 32
  const taken = new Set<number>(),
    out = new Map<string, number>();
  for (const name of names) {
    if (out.has(name)) continue;
    if (taken.size === N) taken.clear();
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    const u = h >>> 0,
      pref = u % N,
      step = 1 + 2 * ((u >>> 5) % (N / 2));
    let slot = pref;
    for (let i = 1; i <= N && taken.has(slot); i++) slot = (pref + i * step) % N;
    taken.add(slot);
    out.set(name, slot);
  }
  return out;
}

/**
 * 지금 **화면에 적용된** 테마 id — `settings.theme`가 아니라 `data-theme`가 진실이다.
 * 설정 › 모양의 라이브 프리뷰(SettingsDialog.previewTheme)와 커스텀 테마 편집기는 저장하지
 * 않고 dataset.theme만 바꾼다. 저장값을 읽으면 프리뷰 중 **행 색만** 이전 테마에 얼어붙어
 * (다이얼로그가 반투명 스크림이라 사이드바가 그대로 보인다) monokai→light 프리뷰에서
 * 흰 패널 위 어두운 행 = 프로젝트명 대비 1.0이 된다. 옛 `--proj-*` CSS 변수 구현은 셀렉터가
 * data-theme를 직접 따라가서 이 문제가 없었다 — 값을 JS로 옮긴 대가를 여기서 갚는다.
 * main.tsx가 렌더 전에 localStorage 캐시로 심어 두므로 첫 페인트 값으로도 이게 맞다.
 */
const appliedTheme = {
  subscribe(onChange: () => void): () => void {
    const mo = new MutationObserver(onChange);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  },
  get: () => document.documentElement.dataset.theme ?? "darcula",
};

/**
 * 등록 전체를 이름순으로 배정 — 표시 순서(드래그 정렬·"변경 있는 프로젝트 위로")·열린 터미널과
 * 무관하게 색이 고정된다. 화면에 보이는 부분집합으로 배정하면 충돌 밀림 결과가 매번 달라져
 * "배경색으로 프로젝트를 기억한다"가 깨진다.
 */
export function useProjectColors(): Map<string, ProjColor> {
  const { data: projects } = useProjects();
  const theme = useSyncExternalStore(appliedTheme.subscribe, appliedTheme.get);
  // 커스텀 테마를 편집해도 id는 그대로라(같은 id를 upsert) theme 문자열이 안 바뀐다 —
  // 정의 목록 자체를 구독해야 편집·삭제·다른 창의 storage 변경이 행 색까지 내려온다.
  const customThemes = useCustomThemes((s) => s.themes);
  return useMemo(() => {
    const pal = projectPalette(theme);
    const slots = assignProjectSlots(
      (projects ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b, "ko")),
    );
    return new Map([...slots].map(([n, s]) => [n, pal[s]] as const));
  }, [projects, theme, customThemes]);
}
