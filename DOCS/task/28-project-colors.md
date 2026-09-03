# 태스크 28 — 프로젝트 색 공유 모듈 + 사이드바 행 배경

> 상태: **구현 완료 · 검증 통과(미커밋)** (2026-09-03) — e2e 14 `#12` 3/3 · e2e 19 대비 6/6 · 실기 CDP 관측 완료(§9) ·
> 근거: 코드 실측 2026-09-02(워킹트리 기준) · 상위 설계:
> `DOCS/pane-history-tooltip-layout-design.md` §1.4·§2.4 (D1+D2) — 색 배정 모듈(D1)과 사이드바 적용(D2)을
> 한 구현 단위로 묶는다. Rust 변경 0.

## 1. 요구사항

좌측 PROJECTS 사이드바의 프로젝트 행마다 배경색이 달라서, **배경색만 보고도 어떤 프로젝트인지 기억**할 수
있어야 한다. 색은 기억의 단서이므로 **모아보기 칩·셀 헤더와 같은 프로젝트는 같은 색**이어야 한다.

받아들이는 조건:
- 같은 프로젝트의 사이드바 행 배경과 모아보기 칩·셀 헤더 배경이 **같은 색상(hue)** 이다 — 메인 창·모아보기
  별도 창 어디서 봐도.
- 사이드바를 **드래그로 재정렬**하거나 **"변경 있는 프로젝트 위로"** 를 켜고 꺼도 각 프로젝트의 색은 바뀌지 않는다.
- 행 hover 시 배경이 진해지고, 선택 행은 기존 `border-l-2 border-accent` 표시를 유지한다.
- 에이전트 활동 표시(`.ai-working` 무지개 흐름 · `.ai-done` 초록빛)는 그대로 보인다.
- 프로젝트가 팔레트(12색)보다 많을 때도 **이름순 12개 단위 안에서는 중복이 없다.**
- 글자 대비: 이름(`text-fg`) ≥ 4.5:1 절대. 2·3행(`text-fg-muted`/`text-fg-dim`)은 **오늘 선택 행이 갖는
  대비(`bg-selection` 위)보다 나빠지지 않는다** — 테마 6종 × 12 hue 전부(§3.4에서 상위 설계의 절대 목표를
  왜 이렇게 바꾸는지 설명).

## 2. 현황(근거)

### 2.1 색 배정은 모아보기 안에만, 그 화면의 부분집합 기준으로

- `src/components/AggregateTerminals.tsx:53-55` `PROJECT_HUES` 12개(균등 분할 아님 — 초록 구간 밀집을 피해 눈으로
  갈리는 지점만). `:57-85` `assignProjectHues(names)`: 이름 해시로 선호 슬롯, 이미 쓰인 슬롯이면 다음 빈 슬롯으로
  밀기. `:77-80` "한 바퀴만 돌고 포기" — 12개가 전부 쓰이면 `slot`이 `pref`로 돌아와 **선호 슬롯 그대로 중복**된다.
  `:87-96` `projectTint(hue, strong: boolean)` = `hsl(${hue} 70% var(--proj-l) / var(--proj-a-on|off))`.
- 배정 대상은 **모아보기에 보이는 셀의 프로젝트만**: `:205-211` — `out.sort(localeCompare(..., "ko"))` 뒤
  `assignProjectHues(out.map((c) => c.projName))`. 열린 터미널 집합이 바뀌면 충돌 밀림 결과가 달라져 같은
  프로젝트의 색이 이동할 수 있다. `:125` `CellMeta = CellSource & { hue }` — 칩(`:940`)·묶음 칩(`:483`)·
  터미널 셀 헤더(`:1191`)·브라우저 셀 헤더(`:1269`)가 이 hue를 읽는다. **`projectTint` 호출부는 4곳**이다
  (상위 설계의 "5개"는 정의 `:94`를 포함해 센 것으로 보인다).
- 컴포넌트는 이미 `useProjects()`를 부른다(`:28` import, `:148`) — 전체 프로젝트 목록이 손에 있다.
- 명도·알파는 테마 종류별 CSS 변수(`src/styles.css:169-189`): `:root { --proj-l 26%; --proj-a-on .92; --proj-a-off .5 }`
  (`:179-183`), `[data-theme="light"], [data-theme="solarized-light"] { 50% / .42 / .2 }` (`:184-189`).
  `:171-178` 주석: 같은 알파가 다크·라이트에서 반대로 작동하므로 종류별로 나눴다. darcula는 별도
  `[data-theme]` 블록이 없다(`@theme` 기본값, `:3`; 테마 블록은 `:41,67,92,118,145` 5개) — `:root`가 darcula다.

### 2.2 사이드바 행

- `src/components/sidebar/ProjectItem.tsx:86-101` 루트 div: `border-l-2 px-3 py-2`, 선택 시 `border-accent
  bg-selection`(`:96`), 아니면 `border-transparent hover:bg-raised`(`:97`), 드래그 중 `opacity-40`, 에이전트
  `ai-working`/`ai-done`(`:99`). `:102-104` 삽입선, `:137-147` 제거 X(`bg-raised`), 이름 `:107`(`font-medium`,
  색은 body `text-fg` 상속 — `styles.css:198`), 2행 `:149` `text-fg-muted`, 3행 `:194-231` `text-fg-dim`/
  `text-add`/`text-mod`/`text-danger`/`text-untrk` 혼합.
- `memo` 컴포넌트(`:14`, `:26`) — 콜백은 안정 참조여야 효과가 있다는 주석 `:23-25`. 부모 `ProjectList.tsx:397-410`이
  넘기는 콜백은 `selectProject`(스토어 액션), `handleRemove`(훅 반환), `handleItemContextMenu`(`useCallback`
  `:289-295`), `beginDrag`(`useCallback` `:141-190`).
- `.ai-working`(`styles.css:420-434`)·`.ai-done`(`:464-470`)은 **background-image**(그라디언트)라
  background-color와 겹쳐 그려진다. 라이트 보정 `:447-461`.
- 사이드바 `aside`는 `bg-panel`(`ProjectList.tsx:357`) — 행의 반투명 배경은 `--color-panel` 위에 합성된다.

### 2.3 표시 순서는 자주 바뀐다

- `ProjectList.tsx:96-127` `orderedProjects`: `projectSortByChanges`면 변경 수·ahead/behind 등급으로 재정렬,
  아니면 `projects` 목록 그대로(`:98`). 토글은 `useUi.toggleProjectSort`(`stores/ui.ts:479-484`, `gp:project-sort-changes` 영속).
- 드래그 정렬 `:133-190`(포인터 기반), 놓으면 `reorderMutate(ids)`(`:184`) + 변경 정렬 자동 해제(`:182-183`).
- 따라서 **표시 순서를 배정 순서로 쓰면 정렬할 때마다 색이 섞인다.**

### 2.4 데이터·의존

- `Project { id, name, path, order, addedAt }`(`src/lib/ipc.ts:5-11`). `useProjects()`는
  `src/queries/index.ts:301-309` — `queryKey: ["projects"]`(`:48`), `staleTime: Infinity`. 데이터 참조는
  무효화·뮤테이션 때만 바뀐다 → `useMemo` 의존으로 적합.
- `src/lib/*`가 `../queries`를 import하는 선례: `src/lib/agent-notify.ts:8`(`useProjects, useSettings`).
  `queries/index.ts`의 내부 import는 `lib/ipc`·`lib/format`·`lib/language-map`·`stores/*`만(`:11-28`; 그 외는
  `@tanstack/react-query`·`react`) → 신규 `lib/project-color.ts`를 import하지 않으니 순환 없음.
- 등록 프로젝트 수(2026-09-02 실측, `%APPDATA%\<identifier>\projects.json`의 `projects` 배열): dev 데이터 **23**,
  설치본 **25**(상위 설계의 27은 시점 차). 어느 쪽이든 12색으로 유일 배정은 불가능하다.
- Tailwind **4.3.0**(`package.json:49`, 설치본 `node_modules/tailwindcss/package.json` 4.3.0). 저장소에
  `bg-(--x)` / `bg-[var(--x)]` 사용 선례는 0건. 설치된 컴파일러로 직접 확인(`compile("@tailwind utilities;").build([...])`):
  - `bg-(--tint)` → `.bg-\(--tint\) { background-color: var(--tint) }` ✓
  - `hover:bg-(--tint-hover)` → `&:hover { @media (hover: hover) { background-color: var(--tint-hover) } }` ✓
  - `bg-[var(--tint)]` → 동일 출력 ✓ (폴백 가능)
  - v3 문법 `bg-[--tint]` → `background-color: --tint` **무효 CSS** — 폴백으로 쓰면 안 된다.
- React 인라인 `style`에 CSS 커스텀 프로퍼티(`"--tint": …`)를 넣는 선례는 저장소에 없다(grep 0건). React는
  `--`로 시작하는 키를 `style.setProperty`로 넣는다 — 타입은 `as React.CSSProperties` 캐스트가 필요하다.
- 테마 전환 e2e 인프라: `tests/e2e/suites/19-themes.mjs:16` `THEME_IDS` 6종, `:87-103` `set_settings` →
  `invalidateQueries(["settings"])` → `dataset.theme` 폴링 루프, `:116-119` 원복. dev 노출 `window.__gpv`는
  `ui`·`terminals`·`videoSplit`·`planSegments`(`src/main.tsx:49-56`) + `queryClient`(`:188-191`).

### 2.5 대비 사전 계산 — 상위 설계 초기값은 목표를 못 맞춘다

`styles.css` 토큰값 그대로 12 hue × 6 테마를 `--color-panel` 위에 알파 합성해 WCAG 대비를 계산했다(스크립트,
실측 대체 아님 — §7이 CDP로 확정한다). **오늘의 행이 이미 절대 목표(4.5/4.5/3.0)를 못 넘는 테마가 있다:**

| 테마 | panel 위 fg/muted/dim | raised(hover) 위 | selection(선택) 위 |
|---|---|---|---|
| darcula | 10.55 / 5.28 / **2.90** | 8.56 / 4.28 / 2.35 | 7.48 / **3.74** / 2.06 |
| monokai | 15.93 / 7.82 / 4.93 | 14.06 / 6.91 / 4.36 | 9.08 / 4.46 / 2.81 |
| dracula | 14.81 / 8.67 / 5.32 | 11.06 / 6.48 / 3.98 | 8.59 / 5.03 / 3.09 |
| nord | 8.73 / 7.45 / 3.80 | 7.49 / 6.39 / 3.26 | 6.40 / 5.46 / 2.79 |
| light | 15.53 / 7.12 / 4.97 | 12.68 / 5.82 / 4.05 | 11.92 / 5.47 / 3.81 |
| solarized-light | 10.61 / **4.39** / 3.64 | 9.49 / 3.93 / 3.25 | 9.75 / 4.04 / 3.34 |

상위 설계 초기값(다크 row .28 / row-on .60, 라이트 .12 / .28)의 12 hue 최악값(최악 hue: 다크 75°, 라이트 250°):
darcula row-on **6.14 / 3.07 / 1.69**(오늘 선택 행 3.74 → 3.07로 하락), light row-on 9.30 / 4.27 / **2.97**,
solarized-light row-on 6.51 / **2.69** / 2.23. 그대로 두면 선택 행의 2행이 오늘보다 읽기 어려워진다.

## 3. 설계

### 3.1 색 배정 — 공유 모듈 `src/lib/project-color.ts`

| 대안 | 평가 |
|---|---|
| **A. 모아보기의 팔레트·배정·틴트를 `lib/project-color.ts`로 옮기고 `useProjectHues()` 훅 추가** (채택) | 코드 이동 + 훅 10줄. 사이드바·모아보기(메인 안·별도 창)가 한 맵을 본다. 배정 로직 변경 없음(순환 1줄만) |
| B. 사이드바가 자체 배정(모아보기 로직 복제) | 두 배정이 부분집합 차이로 어긋난다 — 요구("같은 프로젝트 같은 색") 위반 |
| C. 배정 결과를 스토어/localStorage에 영속 | 추가·제거 시 색 이동은 막지만 상태·마이그레이션이 생긴다. 상위 설계 §6 ⑥ 기본값은 결정적 배정 — 거슬리면 그때 |

**배정 순서 = 등록된 전체 프로젝트를 이름순(`localeCompare(…, "ko")`)** — 모아보기가 이미 쓰는 비교자
(`AggregateTerminals.tsx:208`)와 같다. 표시 순서(드래그·변경순)와 무관하므로 정렬해도 색이 고정된다.
한계: 프로젝트 **추가·제거** 시 충돌 밀림 체인이 바뀌어 일부 색이 이동할 수 있다(해시 선호 슬롯이 비어 있는
프로젝트는 그대로, 밀려 있던 프로젝트만 영향). 12개 경계(아래)도 한 칸씩 이동한다. 상위 설계 §6 ⑥ 수용.

**키 = 이름**(현행 `projName` 기준 유지). 모아보기 묶음(`cells[0].hue`, `:483`)·정렬(`:208`)이 이름 기준이라 id로
바꾸면 어긋난다(상위 설계 §6 ⑤). 같은 이름 둘은 같은 색 — 이름으로도 못 가르는 경우라 수용. 목록에 없는
이름(탭의 프로젝트가 제거된 경우 `projName`이 `"프로젝트"` 폴백 `:168`)은 `?? 0`(빨강) — 오늘은 해시 슬롯을
받았지만 어차피 의미 없는 색이라 차이 없음.

**팔레트 12 vs 프로젝트 23~25.** 유일성은 불가능. `assignProjectHues`에 1줄 — 12개 슬롯이 전부 쓰이면
`taken.clear()` — 로 13~24번째가 **새 바퀴**를 돌아 서로 다른 색을 받는다(지금은 선호 슬롯 중복이 몰린다).
보장 범위: **이름순 12개 블록 안 중복 없음**. 블록 경계(12번째↔13번째)는 13번째가 선호 슬롯을 그대로 받으므로
12번째와 겹칠 수 있다(확률 1/12) — 상위 설계 D1 완료 기준 "이름순 인접 중복 없음"을 이 범위로 정정한다(§3.5).

### 3.2 틴트 4단계

`projectTint(hue, level: "off" | "on" | "row" | "row-on")` → `hsl(${hue} 70% var(--proj-l) / var(--proj-a-${level}))`.
boolean을 union으로 넓혀 CSS 변수 이름과 1:1 — 호출부 4곳은 `"off"/"on"`으로 기계적 치환. 행 전용 알파
2개(`--proj-a-row`, `--proj-a-row-on`)는 칩보다 면적이 커서 같은 알파면 사이드바가 시끄럽다는 상위 설계 판단
+ §2.5 대비 계산으로 값을 정한다(§3.4).

### 3.3 행 배경 — CSS 변수 + Tailwind arbitrary var

| 대안 | 평가 |
|---|---|
| a. 인라인 `style={{ backgroundColor }}` | 인라인이 `hover:` 클래스를 이겨 hover 강조가 죽는다. 선택 강조도 JS 분기 |
| **b. 인라인 `--tint`/`--tint-hover` 변수 + `bg-(--tint) hover:bg-(--tint-hover)`** (채택) | hover는 CSS가 처리. Tailwind 4.3.0 컴파일 확인(§2.4). 선택 행은 두 변수가 같은 값이라 hover 변화 없음(오늘 `bg-selection` 행과 같은 거동) |
| c. `data-hue` 속성 + 12개 CSS 규칙 | 규칙 24개(off/on) 생성. 팔레트 바꾸면 CSS도 바꿔야 |

- 클래스는 **리터럴**로 쓴다(`bg-(--tint)`, `hover:bg-(--tint-hover)` — 문자열 조립 금지). Tailwind v4는 소스를
  스캔해 후보를 뽑으므로 조립된 이름은 생성되지 않는다. 폴백이 필요하면 `bg-[var(--tint)]`(동일 출력 확인) —
  `bg-[--tint]`는 무효 CSS라 쓰지 않는다.
- `bg-selection`은 행에서 제거(틴트가 그 역할). `border-l-2 border-accent`는 유지 — 라이트 테마의 낮은 알파만으로
  선택이 약하다. `hover:bg-raised`는 `hover:bg-(--tint-hover)`로 대체.
- `.ai-working`/`.ai-done`(background-image)·삽입선·제거 X(`bg-raised`)·`opacity-40`은 무변경.
- Tailwind v4의 `hover:`는 `@media (hover: hover)` 안이다 — 오늘의 `hover:bg-raised`도 같은 조건이라 거동 차이 없음.

### 3.4 대비 목표 재정의와 초기 알파

**상위 설계의 절대 목표(fg 4.5 / fg-muted 4.5 / fg-dim 3.0)는 틴트와 무관하게 이미 미달인 테마가 있다**(§2.5:
darcula dim on panel 2.90, fg-muted on selection 3.74; solarized-light fg-muted on panel 4.39). 틴트는 대비를 낮추는
방향으로만 작동하므로 절대 목표는 달성 불가. 대신:

- **이름(`text-fg`) ≥ 4.5 절대** — 모든 테마·알파 후보에서 여유 있게 성립(최악 6.14).
- **fg-muted·fg-dim은 상대 기준**: 틴트 행(`row`·`row-on` 모두)의 12 hue 최악값이 **그 테마의 현행
  `bg-selection` 위 대비**(오늘 행이 이미 갖는 가장 낮은 지속 상태) 이상. 허용 오차 0.1(브라우저 hsl→rgb 반올림).

이 기준선을 **오차 없이**(tol 0) 12 hue 전부 넘는 최대 알파(사전 계산): darcula row-on **.39**, monokai .51, dracula .54,
nord .53, light **.15**, solarized-light **.05**(오차 0.1을 적용하면 .41 / .53 / .56 / .56 / .16 / .06). 다크는 darcula가,
라이트는 solarized-light가 병목이다. 초기값:

| 블록 | `--proj-a-row` | `--proj-a-row-on` | 최악 hue 대비(row / row-on: fg·muted·dim) vs 선택행 기준선 |
|---|---|---|---|
| `:root`(다크 4종 — darcula 기준) | **0.28** | **0.35** (상위 .60 → 하향) | darcula 8.29/4.15/2.28 · 7.77/3.89/2.14 vs 7.48/3.74/2.06 ✓ · nord 7.46/6.37/3.25 · 7.16/6.11/3.12 vs 6.40/5.46/2.79 ✓ |
| `[data-theme="light"]` | **0.10** (.12 → 하향) | **0.15** (.28 → 하향) | 13.06/5.99/4.18 · 11.93/5.47/3.81 vs 11.92/5.47/3.81 ✓ |
| `[data-theme="solarized-light"]` (별도 블록) | **0.06** | **0.10** | 9.61/3.98/3.29 · 8.99/3.72/3.08 vs 9.75/4.04/3.34 — row는 −0.06 이내, row-on muted **−0.32** (기준 미달, §8 ①) |

- 다크 row-on을 .35로 낮추면 hover(.28→.35)와 선택 강조가 약하다. 선택은 `border-accent`가 맡고, hover는 오늘의
  panel→raised 차이(darcula `#2b2d30`→`#393b40`)와 비슷한 수준이라 수용. monokai·dracula·nord는 .5까지 여유가
  있으므로, 실기에서 너무 약하면 `:root[data-theme="monokai"], …` 3종 블록에 `--proj-a-row-on: .5` 1블록 추가가
  업그레이드 경로(다크 병목은 darcula 하나다).
- solarized-light는 selection(`#d3e1ec`)이 panel(`#eee8d5`)과 대비가 거의 같아 **보이는 틴트는 전부 기준선 아래**다.
  이 테마는 `--color-fg-dim`도 4.1:1로 "저대비 테마 특성 유지"로 수용된 전례(`styles.css:157`)가 있다 — .06/.10을
  기본값으로 두고 §8 ①(수용 vs 틴트 0)로 넘긴다.
- **조정 노브는 알파만**(색상·명도 불변) — 배정 로직·팔레트와 독립. `--proj-l-row`(행 전용 명도)는 알파만으로
  라이트 2종의 틴트가 안 보일 때의 다음 카드.

### 3.5 상위 설계와의 차이

| # | 상위 설계 | 이 문서 | 이유 |
|---|---|---|---|
| 1 | 대비 목표 fg/muted/dim ≥ 4.5/4.5/3.0 절대 | fg ≥ 4.5 절대 + muted/dim은 **현행 `bg-selection` 기준선 이상**(테마별) | 절대 목표는 오늘의 행도 못 넘는다(§2.5). 틴트로는 개선 불가 |
| 2 | `--proj-a-row*` 다크 .28/.6, 라이트 .12/.28 | 다크 .28/.35, 라이트 .10/.15, solarized-light 별도 .06/.10 | 사전 계산(§2.5·§3.4). 실측으로 확정 |
| 3 | D1 완료 기준 "13개 이상에서 이름순 인접 중복 없음" | "이름순 12개 블록 안 중복 없음(경계 인접은 1/12 확률로 가능)" | `taken.clear()` 뒤 첫 항목은 선호 슬롯을 그대로 받는다 |
| 4 | `projectTint` 호출부 5개 | **4개**(`:483,:940,:1191,:1269`) | grep 실측 |
| 5 | V 전부 e2e 14 | hue 일치·정렬 불변은 14, **대비 측정은 19-themes 루프에 합류** | 19가 6종 순회·원복 인프라를 이미 갖고 있다(`:87-119`). 14에 복제하지 않는다 |
| 6 | 프로젝트 27개 | 23(dev) / 25(설치본) | 2026-09-02 실측. 결론(12색 유일 불가)은 같다 |

### 3.6 만들지 않는 것

- 색 끄기 토글(상위 §6 ⑦) · 배정 영속(⑥) · 다른 표면(탭·타이틀바) 적용(⑧) · 사용자 지정 색.
- `--proj-l-row`(행 전용 명도) — 알파 조정으로 부족할 때만.
- 3행의 `text-add`/`text-mod`/`text-danger`/`text-untrk` 대비 — 상태색은 이번 범위 밖(오늘도 미측정).

## 4. 계약(타입·액션·코드 스케치)

```ts
// src/lib/project-color.ts (신규) — AggregateTerminals.tsx:53-96에서 이동 + 아래 변경
import { useMemo } from "react";
import { useProjects } from "../queries"; // 선례 lib/agent-notify.ts:8 — queries는 이 파일을 import하지 않는다(순환 없음)

export const PROJECT_HUES: readonly number[] = [0, 25, 45, 75, 140, 168, 190, 215, 250, 280, 310, 335];

/** 이름 → hue. 해시 선호 슬롯 + 충돌 시 다음 빈 슬롯. 12개가 다 쓰이면 새 바퀴(이름순 12개 블록 안 중복 없음). */
export function assignProjectHues(names: string[]): Map<string, number> {
  const taken = new Set<number>();
  const out = new Map<string, number>();
  for (const name of names) {
    if (out.has(name)) continue;
    if (taken.size === PROJECT_HUES.length) taken.clear(); // ← 추가 1줄. 13번째부터 다시 12색 전부 후보
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    const pref = Math.abs(h) % PROJECT_HUES.length;
    let slot = pref;
    for (let i = 0; i < PROJECT_HUES.length && taken.has(slot); i++) slot = (pref + i + 1) % PROJECT_HUES.length;
    taken.add(slot);
    out.set(name, PROJECT_HUES[slot]);
  }
  return out;
}

export type TintLevel = "off" | "on" | "row" | "row-on"; // == styles.css --proj-a-<level>

export function projectTint(hue: number, level: TintLevel): string {
  return `hsl(${hue} 70% var(--proj-l) / var(--proj-a-${level}))`;
}

/** 등록된 전체 프로젝트를 이름순으로 한 번 배정 — 사이드바·모아보기 칩·셀 헤더가 같은 맵을 본다.
 *  이름순인 이유: 표시 순서(드래그·변경순 정렬)와 무관하게 색이 고정돼야 "기억"이 된다. */
export function useProjectHues(): Map<string, number> {
  const { data: projects } = useProjects();
  return useMemo(
    () => assignProjectHues((projects ?? []).map((p) => p.name).sort((a, b) => a.localeCompare(b, "ko"))),
    [projects],
  );
}
```

```ts
// src/components/AggregateTerminals.tsx
import { projectTint, useProjectHues } from "../lib/project-color";   // :53-96 블록 삭제
// AggregateTerminals() 안, useProjects() 옆
const hues = useProjectHues();
// :205-211 — 정렬은 유지(칩 바 그룹핑), 배정만 공유 맵으로
out.sort((a, b) => a.projName.localeCompare(b.projName, "ko"));
return out.map((c) => ({ ...c, hue: hues.get(c.projName) ?? 0 }));
}, [terminals, projects, byTerminal, browserItems, browserTabIds, hues]);   // deps에 hues
// 호출부 4곳
projectTint(cells[0].hue, selCount > 0 ? "on" : "off")   // :483
projectTint(t.hue, on ? "on" : "off")                    // :940
projectTint(meta.hue, "off")                             // :1191, :1269
```

```tsx
// src/components/sidebar/ProjectList.tsx
import { useProjectHues } from "../../lib/project-color";
const hues = useProjectHues();                       // ProjectList() 안 1회
<ProjectItem … hue={hues.get(p.name) ?? 0} />       // :398-410 — number prop, 맵이 바뀔 때만 변화(memo 친화)

// src/components/sidebar/ProjectItem.tsx
import { projectTint } from "../../lib/project-color";
export const ProjectItem = memo(function ProjectItem({ …, hue }: { …; hue: number }) {
  …
  <div
    data-project-id={project.id}
    …
    style={{
      "--tint": projectTint(hue, selected ? "row-on" : "row"),
      "--tint-hover": projectTint(hue, "row-on"),
    } as React.CSSProperties}
    className={`group relative cursor-pointer select-none border-l-2 px-3 py-2 bg-(--tint) hover:bg-(--tint-hover) ${
      selected ? "border-accent" : "border-transparent"
    } ${isDragging ? "opacity-40" : ""} ${agent === "working" ? "ai-working" : agent === "done" ? "ai-done" : ""}`}
  >
```

```css
/* src/styles.css — :179-189 블록에 합류. 값은 §3.4(사전 계산) → §7 실측으로 확정 후 갱신 */
:root {
  --proj-l: 26%;
  --proj-a-on: 0.92;
  --proj-a-off: 0.5;
  --proj-a-row: 0.28;      /* 사이드바 행(태스크 28). 칩보다 면적이 커 낮게. darcula 선택행 기준선이 다크 병목 */
  --proj-a-row-on: 0.35;   /* 선택·hover — .6은 darcula fg-muted 3.07(오늘 3.74) */
}
:root[data-theme="light"],
:root[data-theme="solarized-light"] {
  --proj-l: 50%;
  --proj-a-on: 0.42;
  --proj-a-off: 0.2;
  --proj-a-row: 0.1;
  --proj-a-row-on: 0.15;
}
/* solarized-light: selection이 panel과 대비가 거의 같아 보이는 틴트는 전부 기준선 아래 — 저대비 테마 특성(fg-dim 4.1:1 수용 전례)으로 최소값 */
:root[data-theme="solarized-light"] {
  --proj-a-row: 0.06;
  --proj-a-row-on: 0.1;
}
```

Tauri 커맨드·이벤트·Rust 변경 **없음**.

## 5. 단계(구현 순서)

**선행/후행 문서**: `AggregateTerminals.tsx`는 **24 → 27 → 28** 순(24: ChipMenu 항목·클램프, 27: `colsFor`·
`evenTracks(mode)`·팝오버·`useDelayedClose`). 이 문서는 `:53-96` 삭제, `:210-211` 치환, 호출부 4곳 인자 치환,
import·훅 1줄씩만 건드려 27의 변경 지점(`cols` `:337`, `rowLens` 검증 `:350-362`, `canEven` `:369`, 자동배치 버튼
`:522`, 점유 OR)과 **줄이 겹치지 않는다**. **이 문서의 줄번호는 24·27 적용 전(HEAD) 기준**이다 — 24(import 1 + 구독 3 +
`ChipMenu` 호출·props·항목 ≈ 15)와 27(import 1 + 모듈 함수 `gridCols`/`colsFor`/`shapeFor`/`useDelayedClose`/`LAYOUT_MODES`
≈ 35 + 본문 훅·`evenTracks`·팝오버 ≈ 40)이 들어간 뒤에는 `:53-96` → 약 `:55-98`(import 2줄), `:205-211` → 약 +40,
`:483` → 약 +45, `:940`·`:1191`·`:1269` → 약 +90 밀린다. 앵커는 심볼로 잡는다(`const PROJECT_HUES`·`function assignProjectHues`·
`function projectTint`·`assignProjectHues(out.map`·`projectTint(` 호출 4곳·`useProjects()` 호출 `:148`). 심볼 기준 충돌 없음.
`ProjectItem.tsx`·`ProjectList.tsx`·`styles.css`·`lib/project-color.ts`는 23~27 어느 문서도 건드리지 않는다. D는 A·B·C와
독립이라 병렬 착수 가능(상위 §3) — 단 `AggregateTerminals.tsx` 전환(단계 2)만은 27 뒤에.

1. **`lib/project-color.ts` 신설**(S, +60): 이동 + `taken.clear()` + `TintLevel` + `useProjectHues`. `npx tsc --noEmit -p .`
   — 아직 아무도 안 쓰니 0 영향.
2. **`AggregateTerminals.tsx` 전환**(S, −45/+6): 블록 삭제·import·`hues` 훅·`:210-211`·deps·호출부 4곳. tsc.
   모아보기 칩 색이 한 번 바뀔 수 있다(부분집합 → 전체 배정) — 의도.
3. **`styles.css`**(S, +10): `--proj-a-row`·`--proj-a-row-on` 3블록(§4).
4. **`ProjectList.tsx` + `ProjectItem.tsx`**(S, +3 / +9−2): `hue` prop·`--tint` 변수·클래스 치환. 렌더 뒤 DevTools로
   `.bg-\(--tint\)` 규칙이 생성됐는지 확인(Tailwind 스캔 — 클래스가 리터럴이어야 한다).
5. **e2e**(S~M, 14 +30 · 19 +35): §7 스니펫.
6. **실기·대비 측정**(§7) — 미달 테마는 알파만 낮춰 재측정, 최종값을 `styles.css` 주석과 이 문서 §3.4 표에 기록.

규모: **S~M** — 신규 1파일 + 변경 5파일, 약 +155 / −50 LOC(e2e 포함). Rust 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| Tailwind가 `bg-(--tint)` 규칙을 안 만든다 | 클래스가 조립 문자열이면 스캐너가 못 본다 → 배경 투명 · 정적 검증(tsc)은 통과 | 리터럴 클래스. e2e 14가 `getComputedStyle(row).backgroundColor !== "rgba(0, 0, 0, 0)"`로 잡는다(§7) |
| 선택 행 가독성 하락 | 틴트가 `bg-selection`을 대체 — 알파가 높으면 2·3행이 오늘보다 흐려진다(darcula .6에서 3.74→3.07) | §3.4 상대 기준 + 19-themes 대비 단언. 노브는 알파만 |
| solarized-light에서 틴트가 거의 안 보임 | .06/.10은 기준선을 지키려는 최소값 — 기능이 사실상 꺼진 수준일 수 있다 | §8 ①. 대안: 그 테마만 틴트 0, 또는 −0.35까지 수용 |
| 프로젝트 추가·제거로 색 이동 | 충돌 밀림 체인·12개 경계가 바뀐다 | 해시 선호가 대부분 유지. 거슬리면 상위 §6 ⑥ 영속(`gp:project-hue`) — 그때 |
| 12색 중복(23~25개) | 두 프로젝트가 같은 색 — 유일성은 요구가 아니라 한계로 명시 | 이름순 12개 블록 안 중복 없음. 경계 인접 1/12 |
| `.ai-working` 무지개(알파 .26)가 틴트 위에 겹쳐 과광 | 다크에서 틴트 .28 + 그라디언트 .26 | 실기 스크린샷 체크(§7). 과하면 `--proj-a-row`만 낮춘다(`.ai-working`은 무변경 원칙) |
| `useProjectHues`가 별도 창(aggregate)에서 데이터 없음 | 그 창에서도 `useProjects()`가 이미 돌고 있다(`AggregateTerminals.tsx:148`) | 변경 없음. 로딩 중엔 빈 맵 → `?? 0` 잠깐 — 기존 `?? 0` 거동과 같다 |
| React 커스텀 프로퍼티 인라인 style 첫 사용 | 타입 캐스트 필요, 값이 `var()` 중첩 문자열 | 실기에서 `row.style.getPropertyValue("--tint")`가 `hsl(<h> 70% var(--proj-l) / var(--proj-a-row…))`인지 e2e로 확인 |
| `hover:`가 `@media (hover: hover)` 안 | 터치 전용 장치에서 hover 없음 | 오늘의 `hover:bg-raised`와 같은 조건 — 거동 차이 없음 |
| memo 무효화 | `hue` prop이 매 렌더 바뀌면 캐스케이드 | `useMemo([projects])` — React Query 참조는 무효화 때만 바뀐다(`staleTime: Infinity`) |

## 7. 검증

정적 검증만으로 끝내지 않는다(CLAUDE.md). dev 디버그 앱(`npm run dev:app`, CDP)에서 관측 가능한 값 — DOM 계산
스타일·인라인 변수·스토어 — 로 단언한다.

### 7.1 e2e 14 — 추가 섹션 `#12` (`tests/e2e/suites/14-frontend-dom.mjs`, `#11c` 새 탭 정리 뒤 · `closeTab(tabId)` 앞)

위치(`:362-369` 뒤, `:372` 앞)가 중요하다: `:372`가 픽스처의 마지막 터미널 탭(`tabId`)을 닫으면 모아보기에 픽스처 칩이 없어 두 번째 단언이
성립하지 않는다. `#11c` 직후는 모아보기가 닫혀 있고(`:363-364`) `tabId` 탭은 살아 있다. 헬퍼는 14가 이미 가진
`cdp.eval`·`r.check`·`poll`·`uGet`·`J`·`sleep`·`fix`(`:13,:17,:24-37`)만 쓴다.

```js
    // ── #12 프로젝트 색: 사이드바 행 배경 == 모아보기 칩 색(같은 프로젝트) · 정렬 토글 뒤 불변 (태스크 28) ──
    const bgOf = (elExpr) =>
      cdp.eval(`(()=>{ const el=${elExpr}; return el ? getComputedStyle(el).backgroundColor : null; })()`);
    const rgb3 = (s) => (s && s.match(/^rgba?\((\d+), (\d+), (\d+)/)?.slice(1, 4).join(",")) || null;
    const rowExpr = `document.querySelector('[data-project-id=${J(fix.projectId)}]')`;
    const fixName = await cdp.eval(
      `(window.__gpv.queryClient.getQueryData(["projects"])||[]).find(p=>p.id===${J(fix.projectId)})?.name ?? null`,
    );
    const rowTint = await cdp.eval(`${rowExpr}?.style.getPropertyValue('--tint') ?? ''`);
    const rowBg = await bgOf(rowExpr);
    r.check(
      "사이드바 행: --tint 인라인 변수 + 배경 실제 적용(bg-(--tint) 규칙 생성)",
      /^hsl\(\d+ 70% var\(--proj-l\) \/ var\(--proj-a-row/.test(rowTint) && !!rowBg && rowBg !== "rgba(0, 0, 0, 0)",
      `tint=${rowTint} bg=${rowBg}`,
    );
    // 모아보기 칩 — 개별 칩 title "이름 · 제목 (우클릭: 메뉴)" 또는 묶음 칩 "이름 — 탭 N개 …" 둘 다 이름으로 시작
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(true)`);
    await poll(() => uGet("aggregateOpen"), (v) => v === true, 12, 300);
    const chipExpr = `Array.from(document.querySelectorAll('button')).find(b => (b.title||'').startsWith(${J(fixName)} + ' · ') || (b.title||'').startsWith(${J(fixName)} + ' — 탭'))`;
    const chipBg = await poll(() => bgOf(chipExpr), (v) => !!v, 12, 300);
    r.check(
      "모아보기 칩 색 == 사이드바 행 색 (r,g,b 동일 — 알파만 다름)",
      !!chipBg && rgb3(chipBg) === rgb3(rowBg),
      `chip=${chipBg} row=${rowBg}`,
    );
    await cdp.eval(`window.__gpv.ui.getState().setAggregateOpen(false)`);
    await poll(() => uGet("aggregateOpen"), (v) => v === false, 12, 300);
    // 변경 우선 정렬 토글 → 표시 순서가 바뀌어도 색은 그대로(배정이 이름순 전체 기준)
    const sort0 = await uGet("projectSortByChanges");
    await cdp.eval(`window.__gpv.ui.getState().toggleProjectSort()`);
    await sleep(300);
    const rowBgSorted = await bgOf(rowExpr);
    r.check("변경 우선 정렬 토글 뒤 행 색 불변", rgb3(rowBgSorted) === rgb3(rowBg), `${rowBg} → ${rowBgSorted}`);
    if ((await uGet("projectSortByChanges")) !== sort0)
      await cdp.eval(`window.__gpv.ui.getState().toggleProjectSort()`); // 원복(localStorage 영속이라 반드시)
```

같은 hue·채도·명도면 hsl→rgb가 알파와 무관하게 같은 r,g,b를 낸다 — 행(`--proj-a-row-on`)과 칩(`--proj-a-on`)의
알파가 달라도 `rgb3`로 비교하면 hue 일치를 계산 스타일로 확인하는 셈이다(WebView2가 계산 배경색을 `rgba(r, g, b, a)`
정수 표기로 돌려준다는 전제 — 검증 필요; `color(srgb …)` 등으로 오면 `rgb3`를 손본다). 픽스처 행은 14에서 선택
상태(`ensureFixture`, `:38-41`)라 `row-on`. 칩은 초기 선택 규칙(`AggregateTerminals.tsx:221-226` — 활동(working/done)
터미널이 없으면 전부 선택)에 따라 `on` 또는 `off`인데, 어느 쪽이든 r,g,b는 같아 단언에 영향 없다.

### 7.2 e2e 19 — 테마 루프 안 대비 단언 (`tests/e2e/suites/19-themes.mjs:87-103` 루프, `--color-base` 검사 뒤)

```js
  // 루프 밖: 태스크 28 — 상대 기준선 허용 오차(hsl→rgb 반올림). solarized-light는 §3.4·§8 ①의 예외값.
  const TINT_TOL = { default: 0.1, "solarized-light": 0.35 };
  const fmt = (m) => ["fg", "muted", "dim"].map((k) => m[k].toFixed(2)).join("/");
  …
      // 루프 안(테마 id 적용 확인 뒤): 12 hue × row/row-on을 --color-panel 위에 합성 → 현행 bg-selection 기준선과 비교
      const c = await cdp.eval(`(()=>{
        const HUES=[0,25,45,75,140,168,190,215,250,280,310,335];
        const css=getComputedStyle(document.documentElement), tok=(n)=>css.getPropertyValue(n).trim();
        const hex=(h)=>{ const n=parseInt(h.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; };
        const lum=([r,g,b])=>{ const f=(c)=>{ c/=255; return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4; }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
        const ratio=(a,b)=>{ const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
        const probe=document.createElement('div'); document.body.appendChild(probe);
        const rgba=(v)=>{ probe.style.backgroundColor=v; const m=getComputedStyle(probe).backgroundColor.match(/[\\d.]+/g).map(Number); return m.length===3?[...m,1]:m; };
        const panel=hex(tok('--color-panel')), sel=hex(tok('--color-selection'));
        const text={fg:hex(tok('--color-fg')),muted:hex(tok('--color-fg-muted')),dim:hex(tok('--color-fg-dim'))};
        const out={ baseline:{} }; for (const k in text) out.baseline[k]=ratio(text[k],sel);
        for (const lv of ['row','row-on']) { const m={fg:99,muted:99,dim:99};
          for (const h of HUES) { const [r,g,b,a]=rgba('hsl(' + h + ' 70% var(--proj-l) / var(--proj-a-' + lv + '))');
            const bg=[r,g,b].map((c,i)=>a*c+(1-a)*panel[i]);
            for (const k in text) m[k]=Math.min(m[k], ratio(text[k],bg)); }
          out[lv]=m; }
        probe.remove(); return out; })()`);
      const tol = TINT_TOL[id] ?? TINT_TOL.default;
      const okFg = c.row.fg >= 4.5 && c["row-on"].fg >= 4.5;
      const okRel = ["muted", "dim"].every(
        (k) => c.row[k] >= c.baseline[k] - tol && c["row-on"][k] >= c.baseline[k] - tol,
      );
      r.check(
        `[${id}] 사이드바 행 틴트 대비 — fg ≥ 4.5 · muted/dim ≥ 선택행 기준선 − ${tol} (12 hue 최악값)`,
        okFg && okRel,
        `row=${fmt(c.row)} on=${fmt(c["row-on"])} base=${fmt(c.baseline)}`,
      );
```

이 단언이 **대비 측정 절차 그 자체**다: 테마 6종 × 행 상태 2종 × 12 hue를 CDP에서 실제 테마 토큰과 실제 hsl
파싱으로 계산한다. 미달 테마는 `styles.css`의 `--proj-a-row*`만 낮춰 재실행하고, 최종값·측정값을 §3.4 표에
기록한다. 19는 마지막에 원래 테마로 복원한다(`:116-119`, `finally :120-123`) — 추가 정리 없음.

### 7.3 실기(디버그 앱, 테마 6종 스크린샷 체크리스트)

각 테마(`darcula`·`monokai`·`dracula`·`nord`·`light`·`solarized-light` — 설정 › 테마)에서:

1. PROJECTS 행들이 **서로 다른 색**으로 물들고, 이름순 12개 블록 안에 같은 색이 없다(23~25개면 색당 최대 3행,
   블록 경계 인접은 §3.1대로 겹칠 수 있다).
2. 아무 행에 hover → 배경이 진해진다(`--tint-hover`). 선택 행은 hover에 변화 없음 + 왼쪽 accent 선 유지.
3. Ctrl+Shift+A로 모아보기 열기 → 칩·셀 헤더 색이 그 프로젝트의 사이드바 행과 같은 색상. 모아보기 별도 창
   (타이틀바 "모아보기" 버튼 **우클릭** — `TitleBar.tsx:107-110`)에서도 같다.
4. PROJECTS 헤더 ↕(변경 우선 정렬) 토글, 행 하나를 드래그해 순서 변경 → 각 행의 색 불변(드래그는 e2e 미커버 —
   여기서 확인). 정렬 토글은 원복.
5. Claude Code 작업 중인 프로젝트가 있으면 `.ai-working` 무지개가 틴트 위에 흐르고 글자가 읽힌다. 과광이면
   그 테마의 `--proj-a-row` 하향.
6. 2행(브랜치·↑↓)·3행(변경 수/"변경 없음")이 다크 4종·라이트 2종 전부에서 읽힌다 — 특히 darcula 선택 행,
   solarized-light 전체. 7.2 수치와 눈이 어긋나면 수치를 믿고 알파를 조정한다.
7. 프로젝트 하나 추가(+) → 기존 행 중 색이 바뀐 행이 몇 개인지 기록(§8 ③ 판단 자료) → 제거로 원복.

관측 명령(CDP, 아무 창): `getComputedStyle(document.querySelector('[data-project-id]')).backgroundColor` —
`rgba(0, 0, 0, 0)`이면 Tailwind 규칙 미생성(§6 첫 행).

## 8. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값 |
|---|---|---|
| ① | solarized-light — 상대 기준선을 지키는 .06/.10(거의 안 보임) vs 라이트 공통 .10/.15(선택행 fg-muted 4.04→**3.41**, 비선택 행 3.72) vs 이 테마만 틴트 0 | **.06/.10**(별도 블록). 실기에서 "안 보인다"면 .10/.15로 올리되 19 예외값(`TINT_TOL`)도 0.35 → **0.65**로 함께 올린다(row-on muted −0.63) |
| ② | 다크 row-on .35(darcula 병목) vs monokai·dracula·nord만 .5 별도 블록 | **.35 단일**. hover·선택 강조가 약하다는 피드백이 오면 3종 블록 1개 추가 |
| ③ | (상위 §6 ⑥ 승계) 추가·제거 시 색 이동 수용 vs `gp:project-hue` 영속 | 결정적 배정. §7.3-7 기록으로 판단 |

## 9. 구현 결과(2026-09-03) — 실행·관측 결과

§5 단계 1~6 완료. `npx tsc --noEmit` exit 0. Rust 변경 0. **e2e·실기 전부 실행**했다(dev 디버그 앱, CDP 29222,
프로젝트 23개). 사전 계산(§3.4)과 실측이 소수점까지 일치했으므로 알파는 한 번도 조정하지 않았다.

| 파일 | LOC | 무엇 |
|---|---|---|
| `src/lib/project-color.ts` (신규) | +73 | `PROJECT_HUES`·`assignProjectHues`(+`taken.clear()` 1줄)·`TintLevel`·`projectTint(hue, level)`·`useProjectHues()` |
| `src/components/AggregateTerminals.tsx` | −44/+8 | 색 함수 3개 삭제 → import, `useProjectHues()` 훅, 셀 메모가 공유 맵 사용(deps `hues`), `projectTint` 호출부 4곳 union 인자 |
| `src/styles.css` | +14/−1 | `--proj-a-row`·`--proj-a-row-on` 3블록(다크 .28/.35 · 라이트 .10/.15 · solarized-light .06/.10) + 주석 |
| `src/components/sidebar/ProjectList.tsx` | +4 | `useProjectHues()` 1회, `hue={hues.get(p.name) ?? 0}` prop |
| `src/components/sidebar/ProjectItem.tsx` | +16/−4 | `hue` prop, `--tint`/`--tint-hover` 인라인 변수, `bg-(--tint) hover:bg-(--tint-hover)`, `bg-selection`·`hover:bg-raised` 제거 |
| `tests/e2e/suites/14-frontend-dom.mjs` | +36 | `#12`(§7.1 그대로 — `#11c` 새 탭 정리 뒤 · `closeTab(tabId)` 앞) |
| `tests/e2e/suites/19-themes.mjs` | +37 | 루프 밖 `TINT_TOL`·`fmt`, 루프 안 `--color-base` 검사 뒤 12 hue × row/row-on 대비 단언(§7.2 그대로) |
| `src/lib/project-color.ts` (리뷰 반영) | ±1 | `PROJECT_HUES`에 `readonly number[]` 명시(§4 계약과 일치). tsc exit 0 |

### 9.1 e2e 실행 결과

| 스위트 | 결과 |
|---|---|
| 14 `#12` (§7.1 그대로) | **3/3 PASS**. `tint=hsl(190 70% var(--proj-l) / var(--proj-a-row-on))` `bg=rgba(20, 97, 113, 0.35)` · 칩 `rgba(20, 97, 113, 0.92)`(r,g,b 동일) · 정렬 토글 뒤 불변. 스위트 전체는 56 pass / 1 fail / 1 skip — **fail은 태스크 24의 "셀 메뉴: 라벨 '프롬프트 목록 닫기' → 닫힘"**(28 범위 밖 선행 결함) |
| 19 (§7.2 그대로) | **38 pass / 0 fail / 1 skip** — 틴트 대비 단언 6종 전부 PASS |

**`rgb3` 전제 확인**: WebView2는 계산 배경색을 `rgba(20, 97, 113, 0.35)` — 정수 r,g,b + 소수 알파로 돌려준다.
`color(srgb …)` 표기는 나오지 않아 `rgb3` 파서를 손댈 필요가 없었다(§7.1의 "검증 필요" 해소).

### 9.2 실기 관측(CDP, dev 앱 · 프로젝트 23개 · 2026-09-03)

**대비 — 테마 6종 × 행 상태**(12 hue 최악값, `--color-panel` 위 알파 합성. off=비선택 `row`,
on=선택 = hover `row-on` — 두 상태가 같은 알파라 열이 하나다):

| 테마 | α row/row-on | off(row) fg/muted/dim | on·hover(row-on) | 기준선(bg-selection) | 최악 hue | 판정 |
|---|---|---|---|---|---|---|
| darcula | .28/.35 | 8.29/4.15/2.28 | 7.77/3.89/2.14 | 7.48/3.74/2.06 | 75° | PASS(tol .1) |
| monokai | .28/.35 | 12.28/6.03/3.80 | 11.28/5.54/3.49 | 9.08/4.46/2.81 | 75° | PASS(tol .1) |
| dracula | .28/.35 | 11.42/6.68/4.10 | 10.61/6.21/3.81 | 8.59/5.03/3.09 | 75° | PASS(tol .1) |
| nord | .28/.35 | 7.46/6.37/3.25 | 7.16/6.11/3.12 | 6.40/5.46/2.79 | 75° | PASS(tol .1) |
| light | .10/.15 | 13.06/5.99/4.18 | 11.93/5.47/3.81 | 11.92/5.47/3.81 | 250° | PASS(tol .1) |
| solarized-light | .06/.10 | 9.61/3.98/3.29 | 8.99/3.72/3.08 | 9.75/4.04/3.34 | 250° | PASS(tol .35 — §8 ① 예외) |

**§3.4 사전 계산과 소수점까지 일치**했다(9.3의 오프라인 재현도 같은 값). 알파 조정 0회.

§7.3 항목별:

1. **행 색 구분** — 23개 행이 12색을 2개씩(310°만 1개) 쓴다. 계산 배경의 고유 rgb 12종. 이름순 정렬 시
   **12개 블록 안 중복 0건 · 인접 중복 0건**(블록 경계 `legacy-hrcs 335°` ↔ `legacy-hrcs-samsungs-sdi 25°`도 무충돌 —
   §3.5 ③이 허용한 1/12 확률에 걸리지 않았다). 24개(픽스처 포함) 시점에도 12색 정확히 2개씩·중복 0건.
2. **hover** — 실제 포인터(`Input.dispatchMouseEvent`)로 6종 테마 전부 확인. 비선택 행
   `rgba(90, 113, 20, 0.28)` → `rgba(90, 113, 20, 0.35)`(hue 불변·알파만 상승), 포인터가 벗어나면 복귀.
   **선택 행은 hover 전후 `rgba(20, 59, 113, 0.35)`로 무변화**, 왼쪽 `border-accent rgb(79, 180, 230)` 유지.
3. **모아보기 색 일치** — 메인 안(`setAggregateOpen(true)`)·**별도 창**(타이틀바 "모아보기" 실제 우클릭 → 라벨
   `aggregate` 웹뷰) 양쪽에서 3개 프로젝트 전부 사이드바 행과 r,g,b 동일:
   `nqvm-vis 20,59,113` · `nqvm-web 90,113,20` · `nqvm-ais 20,113,51`. 칩 α .92 / 셀 헤더 α .5 / 행 α .28~.35로
   **알파만 다르다.** 별도 창은 관측 후 닫아 소유권을 메인으로 되돌렸다(`aggregateWindowOpen=false`, 잔존 창 0).
4. **정렬·드래그 뒤 불변** — "변경 있는 프로젝트 위로" 토글(표시 순서 실제로 바뀜) → 색 바뀐 행 **0건**, 되돌려도 0건.
   실제 포인터 드래그로 6번째 행을 2번째로 이동(순서 반영 확인) → **0건**. 순서·정렬 플래그는 `reorder_projects`로 원복.
5. **`.ai-working` 겹침** — 무지개(background-image, 다크 α .26 / 라이트 α .13)와 틴트(background-color)가 함께
   그려짐을 6종 테마에서 확인. 겹친 최악 대비를 **28 이전 바탕과 비교**하면 새로 나빠진 곳이 없다:

   | 테마 | 28 이전 `bg-panel` 위 | 28 이전 `bg-selection` 위 | 28 이후 row 최악 | row-on 최악 |
   |---|---|---|---|---|
   | darcula | 5.74/2.87/1.58 | 4.47/2.24/1.23 | 4.75/2.38/1.30 | 4.53/2.27/1.24 |
   | monokai | 8.71/4.27/2.70 | 5.29/2.60/1.64 | 6.58/3.23/2.04 | 6.13/3.01/1.90 |
   | dracula | 7.95/4.65/2.86 | 5.21/3.05/1.87 | 6.35/3.72/2.28 | 6.00/3.51/2.16 |
   | nord | 5.14/4.38/2.24 | 4.14/3.54/1.81 | 4.57/3.90/1.99 | 4.44/3.79/1.93 |
   | light | 13.00/5.97/4.16 | 10.15/4.66/3.25 | 11.08/5.08/3.54 | 10.19/4.68/3.26 |
   | solarized-light | 9.02/3.74/3.09 | 8.32/3.44/2.85 | 8.24/3.41/2.82 | 7.75/3.21/2.66 |

   틴트 행은 다섯 테마에서 **선택 행(28 이전) 기준선보다 높다**. solarized-light만 row-on이 −0.57/−0.23/−0.19로
   기준선 아래인데, 이는 §8 ①이 이미 수용한 그 테마의 예외와 같은 크기다. `--proj-a-row` 하향 불필요.
   스크린샷(테마 6종, 사이드바 클립)에서도 무지개가 틴트를 덮지 않고 글자가 읽힌다.
6. **2·3행 가독성** — 위 표. 실제 화면의 행 하나(75°)로 잰 이름 대비는 darcula 8.29 · monokai 12.28 ·
   dracula 11.42 · nord 7.46 · light 14.75 · solarized-light 10.40. 스크린샷 육안 확인:
   **solarized-light는 §8 ①의 우려대로 색이 매우 옅다** — 행을 나란히 놓으면 구별되지만 한 행만 보면 거의 무채색이다
   (선택 행 215°가 회색으로 보인다). light는 파랑·올리브·분홍·초록·라벤더가 뚜렷하다.
7. **프로젝트 추가·제거 시 색 이동**(§8 ③ 자료) — e2e 픽스처 `repo`(190°)가 목록에서 빠지는 순간
   **다른 23개 중 정확히 1개**(`stats-chip-pac-dashboard` 310° → 190°)의 색이 이동했다. 충돌 밀림 체인이 바뀌는
   범위가 실제로 1행 수준이라는 뜻 — 결정적 배정(기본값) 유지에 문제 없다.

**Tailwind 규칙(실제 앱 번들)** — CSSOM에서 직접 확인:
`.bg-\(--tint\){background-color:var(--tint)}` · `.hover\:bg-\(--tint-hover\)`(중첩 `&:hover`가
`@media (hover: hover)` 안). 계산 배경이 투명인 행 **0/23**. §6 첫 행 위험 해소.
곁가지: 이 문서 §3.3·§2.4의 예시 문자열까지 Tailwind 소스 스캔에 걸려 `.bg-\[var\(--tint\)\]`(유효)와
`.bg-\[--tint\]`(선언 없는 빈 규칙)도 함께 생성돼 있다 — 쓰이지 않는 dead rule 2개, 동작 영향 없음.

### 9.3 정적 확인값(9.2 실측과 대조용)

`styles.css`에서 읽은 토큰·알파로 §7.2와 같은 수식을 오프라인 재현한 값은 9.2 표와 **전부 동일**하다
(darcula .28/.35 8.29/4.15/2.28 · 7.77/3.89/2.14 …). 사전 계산이 실측을 정확히 맞혔으므로 §3.4 표는 수정하지 않았다.

### 9.4 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| 1 | 없음 — 코드·CSS·e2e 스니펫 모두 §4·§7 그대로, 알파도 사전 계산값 그대로 | 실측이 사전 계산과 일치 |
| 2 | 상위 설계 §3 표(D2 완료 기준 "fg-muted ≥ 4.5:1")·§5 D 항목("2행 ≥ 4.5, 3행 ≥ 3.0")은 실측이 못 넘는다 (darcula row-on muted 3.89 · dim 2.14) | 그 절대 목표는 **같은 문서 §3 머리말 ④가 이미 정정**한 낡은 수치다("절대 4.5/4.5/3.0은 현행 행도 못 넘어 … 재정의"). 실측이 그 정정을 확증했다 — 정정 전 문장이 표 안에 남아 있을 뿐 |

### 9.5 미검증

- 실기 관측은 **dev 앱의 현재 창 크기·프로젝트 23개** 기준이다. 설치본(25개)에서의 블록 경계 중복은 재확인하지 않았다
  (§9.2-1은 23·24개 시점만 관측).
- 프로젝트 **추가** 방향(§7.3-7)은 픽스처 제거 방향으로만 관측했다(제거 1건 → 1행 이동). 사용자가 실제 폴더를 추가할 때의
  이동 개수는 대칭이라 보지만 직접 세지는 않았다.
- 커스텀 테마(태스크 29)로 만든 테마의 틴트 대비는 이 문서 범위 밖 — 19 스위트가 내장 6종만 순회한다.
