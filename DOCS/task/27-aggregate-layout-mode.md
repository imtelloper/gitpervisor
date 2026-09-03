# 태스크 27 — 모아보기 자동배치 모드(그리드 / 세로 컬럼)

> 상태: **구현 완료 · 검증 통과(미커밋)** — e2e 14 `#11d` 5단언 pass, §7.2 실기 1~10 전부 관측
> (2026-09-02 구현 · 2026-09-03 검증) · 근거: 코드 실측 2026-09-02(워킹트리 기준 — `AggregateTerminals.tsx`는
> HEAD 14108eb와 동일, `stores/ui.ts`는 태스크 20의 **미커밋 변경**을 포함) · 상위 설계:
> `DOCS/pane-history-tooltip-layout-design.md` §1.3·§2.3 (C1+C2 — 스토어와 UI를 한 구현 단위로)

## 1. 요구사항

자동배치에 **세로 컬럼 균등** 모드를 추가한다. 자동배치 버튼을 호버하면 그리드 / 세로 컬럼 아이콘이 나오고,
클릭하면 그 모드로 자동 배치된다(상위 설계 요구 4).

받아들이는 조건:
- 자동배치 버튼 **호버** → 아이콘 2개 팝오버(그리드 `Grid2x2` / 세로 컬럼 `Columns3`). 현재 모드 아이콘은
  `bg-raised text-accent`(탭 모으기 ON과 같은 상태색).
- 아이콘 **클릭** → 모드 저장 + 그 모드로 **즉시 균등 정렬** + 확대 해제 + 팝오버 닫힘.
- 메인 버튼 **클릭** → 지금 모드로 균등 정렬(기존 동작). 이미 균등이면 시각적 비활성(`aria-disabled`)이되
  **호버 팝오버는 열린다** — 균등 상태에서 모드를 바꾸는 것이 이 기능의 주 동선이다.
- 세로 컬럼 = 셀을 좌우로 한 줄에 나열, **최대 4열**. n≤4 → 1행 n열, n=5~8 → 4열 2행(4+1 … 4+4),
  n=9 → 4+4+1.
- 모드는 재시작 후 유지(localStorage). 별도 창(`aggregate`)도 시작 시 같은 모드로 뜬다.
- 팝오버는 브라우저 셀의 네이티브 webview에 가려지지 않는다(점유 등록).
- 트랙 저장 형식(`aggregateTracks[\`n${n}\`]`)·드래그 리사이즈 불변. 마이그레이션 없음.

## 2. 현황(근거)

모두 `src/components/AggregateTerminals.tsx`(1348줄) 기준.

- **배치 계산**: `cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4`, `rows = max(1, ceil(n/cols))`(:337-338).
  `rowsOfCells`는 `shown`을 `cols`씩 청킹(:341-343), `rowLens = rowsOfCells.map(r => r.length)`(:350).
  실제 배치는 absolute+calc(:596-627) — 트랙 fr을 좌표로 환산하며 폭은 검사하지 않는다.
- **트랙 저장·검증**: `shape = \`n${n}\``(:349), `saved = aggregateTracks[shape]`(:351). `rowFr`은
  `saved.rows.length === rows`일 때만 채택(:352-355), `cellFr`은 `saved.cols.length === rows` **그리고**
  행마다 `a.length === rowLens[r]`일 때만 채택(:356-362) — 실패 시 **렌더에서만** 균등 폴백, 스토어는 다음
  드래그/`evenTracks`가 덮는다. 검증은 두 값이 **따로** 이루어진다(§3.3 표의 근거).
- **균등 판정·버튼**: `uneven`(:366-368) → `canEven = uneven || !!zoomedId`(:369). `evenTracks()`(:373-379)는
  **현재** `rows`·`rowLens`로만 균등값을 쓴다(대상 모드 인자 없음). 버튼(:519-528): `disabled={!canEven}`,
  hover 핸들러 없음, 아이콘 `Grid2x2` 고정, title "셀 자동배치 — 드래그로 바뀐 칸 비율을 균등 그리드로
  되돌립니다". 렌더 조건 `n > 1`(:519).
- **React 19.2.7이 disabled 버튼의 onMouseEnter를 삼킨다**: `node_modules/react-dom/cjs/react-dom-client.development.js:3274-3305`
  `getListener` — `case "onMouseEnter":`(:3291)에서 `props.disabled`(:3292)이고 타입이
  `button|input|select|textarea`(:3295-3298)면 `return null`(:3305). onClick·onMouseDown·onMouseMove도 같은
  목록이다. **버튼 자체에 hover를 달면 균등 상태에서 팝오버가 절대 열리지 않는다** — 정확히 이 기능의 주 동선.
  덧붙여 onMouseEnter는 네이티브 `mouseover`/`mouseout`에서 합성된다(`:27412`, `:19459-19471`) —
  e2e가 hover를 유도하는 근거(§7).
- **드래그 하한 상수**: `MIN_W = 240`, `MIN_H = 160`(:131-132), `GAP = 6`(:134). `MIN_W`는 `startResize`의
  `lo` 계산(:408)에서만 쓰인다 — 레이아웃은 셀 폭을 보장하지 않는다.
- **hover 팝오버 선례 = 묶음 칩 드롭다운 하나**: `groupCloseTimer` ref + `holdGroupOpen` + `scheduleGroupClose`(150ms)
  + 언마운트 정리(:318-325), 칩 `onMouseEnter`/`onMouseLeave`(:471,:478-481), 드롭다운 div의 enter=hold /
  leave=schedule(:712-720), 위치 `{ x: r.left, y: r.bottom + 4 }`(:464). 점유 등록은
  `useOccludesWebview(!!chipMenu || !!groupMenu)` 한 호출(:326).
- **우측 정렬 fixed 메뉴 선례** `NewCellButton`: `setMenu({ right: window.innerWidth - r.right, y: r.bottom + 4 })`
  (:1031) → `style={{ right: menu.right, top: menu.y }}`(:1057). 헤더 우측 끝 버튼은 left 기준이면 창 밖으로
  잘린다(:986 주석). 자동배치 버튼도 헤더 우측 군(新셀 `+` 다음, :511-528)이다.
- **상태색 선례**: 탭 모으기 토글 ON `bg-raised text-accent`(:548-549).
- **점유 훅**: `src/stores/occlusion.ts:49-54` `useOccludesWebview(active: boolean)` — effect에서 `acquire()`,
  비활성화 시 해제.
- **스토어**(`src/stores/ui.ts`, 워킹트리 531줄): 영속 boolean 패턴 `aggregateGroupTabs`(:100-102 선언,
  :258 초기값 `localStorage.getItem("gp:aggregate-group-tabs") === "1"`, :458-463 토글이 `setItem` 후 `set`).
  `aggregateTracks`(:99, :244-257 로드, :448-457 저장). **태스크 20의 미커밋 변경**이 같은 파일에 있다:
  `import type { SettingsCategory }`(:4-5), `ToastOptions`(:16-19), `settingsCategory`(:107-108, :261),
  `openSettings`(:156-157, :466-467), `pushToast` 4번째 인자(:164-169, :485-491). 이 문서의 삽입 지점
  (:100-102, :258, :458-463)과 **줄 범위가 겹치지 않는다** — 워킹트리 위에 얹으면 충돌 없음, HEAD 기준으로
  작업하면 태스크 20 변경을 되돌리게 되니 금지.
- **창 폭**: 별도 창 `inner_size(1100, 720)`(`src-tauri/src/lib.rs:360`), 메인 창 `min_inner_size(1100, 700)`(:759).
  메인 안 모아보기는 사이드바만큼 더 좁다. 프롬프트 컬럼은 `w-[15%] min-w-[110px]`
  (`src/components/workspace/TermSessionControls.tsx:224`)이고 셀 본문 안에서 xterm 옆에 붙는다
  (`AggregateTerminals.tsx:1223-1226`).
- **아이콘**: lucide-react 1.17.0 `node_modules/lucide-react/dist/lucide-react.d.ts` — `Grid2x2`(:9858, 현재 import
  :7), `Columns3`(:6075), 참고 `Columns2`(:6049)·`Columns4`(:6088)·`Rows3`(:16319)·`LayoutGrid`(:11353, 모아보기
  정체성 아이콘으로 :442·:574에서 사용 중). 렌더 클래스는 `lucide-grid-2x2` / `lucide-columns-3`
  (`dist/esm/createLucideIcon.mjs:19-21`, `icons/columns-3.mjs:15`, `icons/grid-2x2.mjs:15`).
- **e2e**: `tests/e2e/suites/14-frontend-dom.mjs` #11c(:293-369)가 모아보기를 열고 새 터미널을 만들어 그리드 셀
  수가 느는 것을 단언한다. 그리드 표식은 `[style*="grid-template-columns"]`(:260,:301 — 컴포넌트 :593 주석이
  이 표식을 계약으로 명시, :594가 그 인라인 스타일). 헬퍼: `cdp.eval`(`lib/cdp.mjs:76-86`, `awaitPromise`·`returnByValue`),
  `J`(:24, `JSON.stringify`), `uGet`(:25), `poll(fn, ok, tries, ms)`(:29-37), `r.check(name, cond, detail?)`(boolean
  반환, :60-65 용례), `r.skip(name, reason)`(:20). 자동배치·`disabled`에 의존하는 기존 e2e는 없다(전 스위트 grep 0건).
- `aria-disabled`·`useDelayedClose` 유사 훅은 `src/` 어디에도 없다(grep 0건) — 신설.

## 3. 설계

### 3.1 모드 저장 위치

| 대안 | 평가 |
|---|---|
| **A. `useUi.aggregateLayout` + localStorage `gp:aggregate-layout`** (채택) | `aggregateGroupTabs`와 같은 수동 영속 패턴. 별도 창은 스토어가 창별이라 시작 시 localStorage로 동기(라이브 동기 없음 — 탭 모으기와 같은 수준). 메인 안 모아보기와 별도 창은 동시에 열리지 않으므로(`main.tsx:178-182` — 창이 열리면 메인 모아보기를 닫는다) 라이브 동기가 필요한 순간이 없다 |
| B. `settings.json`(Rust 설정) | 재시작·창 간 동기는 같고 IPC·스키마·설정 UI 3곳을 건드린다. Rust 변경 0 원칙 위반 |
| C. 컴포넌트 로컬 state | 모아보기를 닫고 열면 초기화 — 요구 "모드 유지" 미달 |

### 3.2 세로 컬럼의 열 수

| 대안 | 평가 |
|---|---|
| **a. 정적 상한 `cols = min(n, 4)`** (채택) | 창폭과 무관하게 n이 cols를 결정하므로 `n${n}` 트랙 키와 정합. 상위 설계 §6 ① 기본값 |
| b. 그리드 폭 기준 동적 `floor(w / (MIN_W + GAP))` | 창 리사이즈마다 cols가 바뀌어 저장 비율이 흔들리고, `layoutKey`(:656) 변화로 브라우저 셀 bounds 재동기화가 리사이즈 중 연쇄된다 |
| c. 상한 없음(`cols = n`) | n=6에서 셀 폭 ≈ 176px — 아래 표 |

**4열 상한 근거** — 별도 창 기본 폭 1100(`lib.rs:360`; 메인 최소 폭도 1100, `:759`)에서 1행 배치 셀 폭
`(1100 − GAP·2 − (cols−1)·GAP) / cols` — 계산값이다(그리드 `clientWidth`가 창 내부 폭과 같다고 가정).
**실측으로 확정**: 별도 창에서 `innerWidth = 1100`·그리드 `clientWidth = 1100`, n=6 columns의 첫 행 셀 폭
**267.5px** — 가정도 표도 그대로다(§8.3 실기 2):

| cols | 셀 폭 | MIN_W 240 | 프롬프트 컬럼(min 110) 열면 xterm 폭(테두리 2 제외) |
|---|---|---|---|
| 3 | 358.7 | ✓ | ≈ 247 |
| **4** | **267.5** | **✓** | ≈ 155 |
| 5 | 212.8 | ✗ | ≈ 101 |
| 6 | 176.3 | ✗ | ≈ 64 |

4가 `MIN_W`를 지키는 최대 열 수다. 넘치는 셀은 기존 `rowsOfCells` 청킹이 다음 행으로 감싼다(n=6 → 4+2).
메인 안 모아보기는 사이드바 폭만큼 좁아 4열이 이미 240 아래일 수 있으나, 그리드 모드도 n≥10에서 4열이라
새 한계가 아니다(`MIN_W`는 드래그 하한일 뿐 — §2).

### 3.3 트랙 키와 모드 전환

`shape = \`n${n}\`` **유지**. 모드 아이콘 클릭이 항상 `evenTracks(mode)`를 수반하므로(요구 "클릭하면 자동 배치",
상위 설계 §6 ②) 모드별 비율 기억은 정의상 없다. 저장값과 새 모양이 어긋나는 경우는 **스토어 setter를 직접 부른
경우뿐**(e2e·다른 창의 시작 시 동기)이고, 그때는 기존 길이 검증(:352-362)이 흡수한다:

| n | grid: cols / rows / rowLens | columns: cols / rows / rowLens | grid 저장값 위에서 columns로 모드만 바뀌면 |
|---|---|---|---|
| 2 | 2 / 1 / [2] | 2 / 1 / [2] | **동일 모양** — 저장값 그대로 유효. 전환은 시각적 no-op(균등만 수행) |
| 3 | 2 / 2 / [2, 1] | 3 / 1 / [3] | rows 2≠1 → rowFr 폴백 · cols 길이 2≠1 → cellFr 폴백 |
| 4 | 2 / 2 / [2, 2] | 4 / 1 / [4] | 둘 다 폴백 |
| 5 | 3 / 2 / [3, 2] | 4 / 2 / [4, 1] | rows 2=2 → **rowFr 저장값 채택**, rowLens [3,2]≠[4,1] → cellFr만 폴백 |
| 6 | 3 / 2 / [3, 3] | 4 / 2 / [4, 2] | 같음 — rowFr 채택·cellFr 폴백 |
| 7 | 3 / 3 / [3, 3, 1] | 4 / 2 / [4, 3] | 둘 다 폴백 |
| 8 | 3 / 3 / [3, 3, 2] | 4 / 2 / [4, 4] | 둘 다 폴백 |
| 9 | 3 / 3 / [3, 3, 3] | 4 / 3 / [4, 4, 1] | rowFr 채택·cellFr 폴백 |
| ≥10 | 4 / ⌈n/4⌉ | 4 / ⌈n/4⌉ | **동일** — columns는 **n=3~9에서만** grid와 다르다 |

상위 설계 §2.3의 "다른 모드에서 저장된 값은 … 균등으로 폴백한다"는 **cellFr에 대해서만 항상 참**이고, rows 수가
같은 n=5·6·9는 행 높이 비율이 넘어온다. 행 높이는 두 모드에서 의미가 같으므로(둘 다 2행) 해롭지 않고, UI 경로는
어차피 균등값을 쓴다. e2e는 직접 setter를 쓰므로 **균등을 단언하지 않고 첫 행 셀 수만** 단언한다(§7).

### 3.4 버튼·팝오버

- **hover 수신은 래퍼 `<span>`**. 이유 두 가지: ① §2 React가 disabled 버튼의 onMouseEnter를 삼킨다 ②
  버튼→팝오버로 건너가는 4px 공백에서 leave가 나므로 어차피 지연 닫기가 필요하고, 지연 닫기의 hold/schedule을
  버튼과 팝오버 양쪽에 달아야 한다 — 래퍼 하나가 자연스러운 앵커다.
- 메인 버튼은 `disabled` 대신 `aria-disabled={!canEven}` + `onClick={canEven ? () => evenTracks() : undefined}`
  + 클래스 분기. `disabled`를 남기면 래퍼로 우회해도 버튼 위에서는 네이티브 `mouseover`의 target이 버튼이고
  React가 그 경로의 리스너를 거르는지 확인하는 부담이 생긴다 — 없애는 편이 단순하다. 키보드: aria-disabled
  버튼은 Tab 포커스가 되고 Enter는 `onClick=undefined`라 no-op.
- 팝오버는 `NewCellButton` 방식의 **우측 정렬 fixed**(`right: innerWidth − r.right`, `top: r.bottom + 4`).
  좌측 정렬이면 창 우측 끝에서 잘린다(:986).
- 아이콘은 **현재 모드**를 보여준다(`Grid2x2` / `Columns3`). `LayoutGrid`는 모아보기 정체성 아이콘(:442,:574)
  이라 모드 아이콘으로 쓰지 않는다.
- 점유: `useOccludesWebview(!!chipMenu || !!groupMenu || !!layoutMenu)` — 기존 한 호출(:326)에 OR. 팝오버가
  0행 우측 셀(브라우저 셀일 수 있음) 위에 놓인다.

### 3.5 상위 설계와의 차이

| # | 차이 | 이유 |
|---|---|---|
| 1 | `IconBtn` 컴포넌트 없음 → 모드 상수 배열 `LAYOUT_MODES`를 map | 파일에 `IconBtn`이 존재하지 않고, 버튼 2개에 컴포넌트를 새로 만들 이유가 없다 |
| 2 | `useDelayedClose(150)` → `useDelayedClose(close, ms = 150)`가 `{ hold, schedule }` 반환 | 닫기 콜백 없이는 타이머가 무엇을 닫는지 알 수 없다. 두 인스턴스(묶음 칩·자동배치)가 각자 setter를 넘긴다 |
| 3 | `colsFor`만이 아니라 `shapeFor(mode, n) → { cols, rows, rowLens }` 순수 함수 | rows·rowLens 계산이 렌더(:337-338,:350)와 `evenTracks(mode)` 두 곳이 되므로 한 함수로 — 어긋나면 균등값이 저장 검증에 걸려 즉시 폴백되는 조용한 버그가 된다 |
| 4 | `n ≤ 1`이 되면 `layoutMenu`를 지우는 effect 1줄 | 버튼이 `n > 1` 조건으로 언마운트돼도 React는 mouseleave를 발화하지 않는다 → 스테일 상태가 남아 n이 다시 늘 때 hover 없이 팝오버가 나타난다. 확대 스테일 정리(:332-335)와 같은 이유 |
| 5 | §3.3 — "균등 폴백"은 cellFr만 항상 참 | 실측(:352-355 vs :356-362 검증이 분리) |
| 6 | `colsFor`의 columns 분기가 `Math.min(n, 4)` → `Math.max(1, Math.min(n, 4))` | 상위 설계 §2.3 원문은 n=0에서 cols=0 → `rows = max(1, ceil(0/0)) = NaN` → `Array(NaN)`(:355·:362) RangeError. `n === 0` EmptyState 분기(:572)는 그 뒤라 막지 못한다. 모아보기에서 셀을 전부 숨기면(n=0) 바로 재현되는 경로 |

### 3.6 만들지 않는 것

- 모드별 트랙 비율 기억(`n3:columns` 같은 키) — 아이콘 클릭이 항상 균등이라 의미가 없다(§6 ②).
- 동적 열 수·폭 기반 자동 줄바꿈 — §3.2 b.
- 창 간 라이브 동기(storage 이벤트) — 두 표면이 동시에 열리지 않는다(§3.1).
- 팝오버 열기 지연 — 묶음 칩 드롭다운도 enter 즉시 연다. 헤더를 스치며 브라우저 셀이 깜빡이는 게 거슬리면
  훅에 `openDelay` 인자 1개(§6).
- 그리드 모드 규칙(`n≤4 → 2열…`) 변경 — 기존 동작 그대로.

## 4. 계약(타입·액션)

Tauri 커맨드/이벤트/Rust 변경 **없음**.

```ts
// src/stores/ui.ts — 워킹트리(태스크 20 변경 포함) 위에 얹는다.
export type AggregateLayout = "grid" | "columns";

interface UiState {
  // … :100-102 `aggregateGroupTabs`/`toggleAggregateGroupTabs` 바로 뒤에:
  /** 모아보기 자동배치 모드 — grid(2×2·3×3 …) / columns(좌우 한 줄, 최대 4열). localStorage 영속 */
  aggregateLayout: AggregateLayout;
  setAggregateLayout: (mode: AggregateLayout) => void;
}

// 초기값 — :258 `aggregateGroupTabs:` 바로 뒤. 알 수 없는 값은 grid(기본).
aggregateLayout: localStorage.getItem("gp:aggregate-layout") === "columns" ? "columns" : "grid",

// 액션 — :458-463 `toggleAggregateGroupTabs` 바로 뒤. 같은 수동 영속 패턴.
setAggregateLayout: (mode) => {
  localStorage.setItem("gp:aggregate-layout", mode);
  set({ aggregateLayout: mode });
},
```

```ts
// src/components/AggregateTerminals.tsx — 모듈 스코프(:130-134 상수 옆)
import { Columns3, /* … 기존 … */ } from "lucide-react"; // :2 CircleCheck와 :3 ExternalLink 사이(+1줄) — 24의 History(:7 뒤)와 같은 블록
import { type AggregateLayout, useUi } from "../stores/ui";

const gridCols = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4); // :337 그대로
/** 세로 컬럼은 좌우 한 줄, 4열 상한 — 1100px 창에서 n=5부터 셀 폭이 MIN_W 아래(§3.2).
 *  하한 1: n=0에서 min(0,4)=0이면 rows=ceil(0/0)=NaN → :355·:362의 `Array(rows)`가 RangeError를 던진다
 *  (rowFr·cellFr는 :572의 `n === 0` 분기보다 먼저 계산된다). gridCols(0)=1과 같은 하한을 둔다. */
const colsFor = (mode: AggregateLayout, n: number) =>
  mode === "columns" ? Math.max(1, Math.min(n, 4)) : gridCols(n);
/** 모드·셀 수 → 행 수와 행별 셀 수. 렌더와 evenTracks(mode)가 같은 함수를 본다(어긋나면 균등값이
 *  저장 검증 :352-362에 걸려 조용히 폴백된다). n=0이면 두 모드 모두 cols=1·rows=1·rowLens=[0] —
 *  그리드가 안 그려지므로(:572) 무해. */
function shapeFor(mode: AggregateLayout, n: number) {
  const cols = colsFor(mode, n);
  const rows = Math.max(1, Math.ceil(n / cols));
  const rowLens = Array.from({ length: rows }, (_, r) => Math.max(0, Math.min(cols, n - r * cols)));
  return { cols, rows, rowLens };
}

/** hover 팝오버 지연 닫기 — 트리거→팝오버로 건너가는 4px 공백에 닫히지 않게 ms 유예.
 *  묶음 칩 드롭다운(:318-325)과 자동배치 팝오버가 같은 로직을 쓴다. 언마운트 시 타이머 정리. */
function useDelayedClose(close: () => void, ms = 150) {
  const timer = useRef<number | undefined>(undefined);
  const hold = () => window.clearTimeout(timer.current);
  const schedule = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { hold, schedule };
}

const LAYOUT_MODES: { mode: AggregateLayout; Icon: typeof Grid2x2; title: string }[] = [
  { mode: "grid", Icon: Grid2x2, title: "그리드 — 2×2·3×3 균등 배치" },
  { mode: "columns", Icon: Columns3, title: "세로 컬럼 — 셀을 좌우로 한 줄에 나열(최대 4열, 넘치면 줄바꿈)" },
];
```

```tsx
// AggregateTerminals() 본문
const layout = useUi((s) => s.aggregateLayout);                 // :162-163 옆
const setAggregateLayout = useUi((s) => s.setAggregateLayout);

// :316-325 교체 — 타이머 3줄×2를 훅 1줄×2로
const [groupMenu, setGroupMenu] = useState<{ name: string; x: number; y: number } | null>(null);
const { hold: holdGroupOpen, schedule: scheduleGroupClose } = useDelayedClose(() => setGroupMenu(null));
const [layoutMenu, setLayoutMenu] = useState<{ right: number; top: number } | null>(null);
const { hold: holdLayoutOpen, schedule: scheduleLayoutClose } = useDelayedClose(() => setLayoutMenu(null));
useOccludesWebview(!!chipMenu || !!groupMenu || !!layoutMenu);  // :326 교체

// :337-338 · :350 교체
const { cols, rows, rowLens } = shapeFor(layout, n);
// rowsOfCells 청킹(:341-343)은 그대로 — cols가 바뀌었을 뿐.

// 버튼이 사라져도(n ≤ 1) React는 mouseleave를 안 준다 — 스테일 팝오버 정리(§3.5 ④)
useEffect(() => { if (n <= 1) setLayoutMenu(null); }, [n]);

// :373-379 교체 — 대상 모드의 균등값. 기본 인자 = 현재 모드(메인 버튼 클릭).
const evenTracks = (mode: AggregateLayout = layout) => {
  const s = shapeFor(mode, n);
  setAggregateTracks(shape, {
    rows: Array(s.rows).fill(1),
    cols: s.rowLens.map((len) => Array(len).fill(1)),
  });
  setZoomed(null);
};
const pickLayout = (m: AggregateLayout) => {
  setAggregateLayout(m);
  evenTracks(m);          // 같은 이벤트 안 — 새 모드 + 균등 트랙이 한 렌더에 반영된다
  holdLayoutOpen();
  setLayoutMenu(null);
};
```

```tsx
{/* :519-528 교체 — 래퍼 span이 hover를 받는다(§3.4). */}
{n > 1 && (
  <span
    className="shrink-0"
    onMouseEnter={(e) => {
      holdLayoutOpen();
      const r = e.currentTarget.getBoundingClientRect();
      setLayoutMenu({ right: window.innerWidth - r.right, top: r.bottom + 4 });
    }}
    onMouseLeave={scheduleLayoutClose}
  >
    <button
      onClick={canEven ? () => evenTracks() : undefined}
      aria-disabled={!canEven}
      title="셀 자동배치 — 클릭: 지금 모드로 균등 정렬 · 호버: 모드 선택(그리드 / 세로 컬럼)"
      className={`flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted ${
        canEven ? "hover:bg-raised hover:text-fg" : "opacity-40"
      }`}
    >
      {layout === "columns" ? <Columns3 size={14} /> : <Grid2x2 size={14} />} 자동배치
    </button>
  </span>
)}

{/* 묶음 칩 드롭다운(:701-749) 다음 형제로 — 헤더는 overflow가 없지만 z 계층을 다른 fixed 메뉴와 맞춘다 */}
{layoutMenu && n > 1 && (
  <div
    className="fixed z-50 flex items-center gap-1 rounded-md border border-edge bg-panel p-1 shadow-xl"
    style={{ right: layoutMenu.right, top: layoutMenu.top }}
    onMouseEnter={holdLayoutOpen}
    onMouseLeave={scheduleLayoutClose}
  >
    {LAYOUT_MODES.map(({ mode, Icon, title }) => (
      <button
        key={mode}
        title={title}
        onClick={() => pickLayout(mode)}
        className={`rounded p-1 ${
          layout === mode ? "bg-raised text-accent" : "text-fg-muted hover:bg-raised hover:text-fg"
        }`}
      >
        <Icon size={14} />
      </button>
    ))}
  </div>
)}
```

`ChipMenu`·`groupMenu`의 렌더·닫힘 규칙은 무변경. `startResize`(:383-436)는 `rows`·`rowLens`·`cellFr`를 그대로
쓰므로 무변경 — `shapeFor`가 같은 이름의 값을 돌려주기 때문이다.

## 5. 단계(구현 순서)

**선행/후행 문서**: 24 → **27** → 28 (`AggregateTerminals.tsx` 순차). 24(A2)는 `ChipMenu`(:861-895)와 클램프
(:852)를, 28(D1)은 색 배정(:53-96, :210)을 건드린다 — 이 문서의 변경 범위(:1-16·:39 import, :130-134, :162-163,
:316-326, :337-338, :349-350, :371-379, :519-528, :699-749 뒤)와 줄 범위는 겹치지 않지만 같은 파일이라 **동시 작업
금지**, 24 머지 뒤 착수하고 28은 이 문서 뒤에. **이 문서의 줄번호는 24 적용 전(HEAD) 기준**이다 — 24가 넣는
`History` import(:7 뒤, +1)·컨테이너 구독(:307 뒤, +3)·`ChipMenu` 호출 prop(:751-797 안, +6)·props(:827-829, +2)·항목(:870 뒤, +7)
만큼 밀린다: `:316` 이후 약 +4, `:798` 이후 약 +10, `:831` 이후 약 +12, `:871` 이후 약 +19. 앵커는 심볼로 잡는다
(`groupCloseTimer`·`useOccludesWebview(`·`const cols =`·`const shape =`·`const evenTracks`·`disabled={!canEven}`·
`{groupMenu &&`). `stores/ui.ts`는 태스크 20 변경(미커밋)이 있는 워킹트리 기준.

1. **ui.ts**: `AggregateLayout` 타입·`aggregateLayout`·`setAggregateLayout` 3곳 삽입(§4 위치). `tsc`.
2. **AggregateTerminals.tsx 배치**: `gridCols`/`colsFor`/`shapeFor` 모듈 함수, `:337-338`·`:350` 교체,
   `evenTracks(mode)`. 이 단계만으로 dev 앱에서 `__gpv.ui.getState().setAggregateLayout("columns")`가 첫 행
   셀 수를 바꾸는지 확인(§7 첫 단언) — UI 전에 배치 계약을 고정한다.
3. **훅·상태**: `useDelayedClose` 신설 → 묶음 칩 타이머(:318-325) 교체 → `layoutMenu` 상태·점유 OR·스테일 effect.
   묶음 칩 hover가 회귀하지 않는지 먼저 본다(드롭다운 열림·150ms 유예·언마운트 정리).
4. **버튼·팝오버**: `:519-528` 교체, `LAYOUT_MODES` 팝오버, `pickLayout`.
5. **e2e 14** #11d 단언 추가(§7) + `origLayout` 원복.
6. **실기 검증**(§7) — 정적 통과만으로 끝내지 않는다.

규모: **S~M** — `ui.ts` +8 · `AggregateTerminals.tsx` 순증 ≈ +60(훅 12 · shapeFor 8 · 버튼/팝오버 ≈ 40 ·
타이머 블록 −8) · e2e ≈ +45. 합계 ≈ 110 LOC, 2파일 + e2e 1파일. Rust 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 균등 상태에서 팝오버가 안 열림 | `disabled` 버튼의 onMouseEnter를 React가 삼킨다(§2 `getListener`) — 정적 검증으론 절대 안 보인다 | 래퍼 span hover + `aria-disabled`. e2e가 **aria-disabled="true" 상태에서** 팝오버 열림을 단언(§7) |
| 렌더와 `evenTracks`의 모양 계산이 어긋남 | 어긋나면 균등값이 :352-362 검증에 걸려 렌더는 균등 폴백, 스토어엔 엉뚱한 길이가 남는다 — 화면은 멀쩡해 보인다 | `shapeFor` 한 함수. e2e가 아이콘 클릭 뒤 `aggregateTracks[n*]`의 `cols.map(a=>a.length)`가 관측된 행 구성과 같은지 단언 |
| 저장 rowFr 부분 채택 | n=5·6·9에서 직접 setter로 모드만 바꾸면 행 높이 비율이 넘어온다(§3.3) | UI 경로는 항상 `evenTracks(mode)`. 허용 — 행 높이는 두 모드에서 의미가 같다 |
| 헤더를 스치며 브라우저 셀 깜빡임 | hover 즉시 팝오버 → 점유 acquire → 네이티브 webview 전부 숨김. 묶음 칩 hover와 같은 비용 | 기존 수준 승계. 거슬리면 `useDelayedClose`에 `openDelay` 1개 추가(열기도 150ms) |
| 스테일 팝오버 | n이 1로 줄면 버튼이 언마운트되는데 mouseleave가 없다 | `n <= 1 → setLayoutMenu(null)` effect(§3.5 ④) + 렌더 조건 `n > 1` |
| 4열이 좁은 창에서 MIN_W 미달 | 메인 안 모아보기(사이드바 만큼 좁음)·프롬프트 컬럼 열림 | 그리드 모드 n≥10과 같은 기존 한계. §3.2 표를 문서에 남기고 실기에서 폭을 기록 |
| `ui.ts` 충돌 | 태스크 20 미커밋 변경과 같은 파일 | 삽입 지점 비중첩(§2). 워킹트리 기준 작업, HEAD 체크아웃 금지 |
| 별도 창과 모드 불일치 | 스토어가 창별, localStorage만 공유 | 두 표면은 동시에 열리지 않는다(`main.tsx:178-182`). 별도 창을 열 때 시작 시 동기 |
| e2e hover 유도 방식 | 기존 스위트에 mouseover 선례 없음 | React는 onMouseEnter를 `mouseover`에서 합성(`react-dom-client.development.js:27412`, `:19459-19471` — relatedTarget이 React 노드면 skip, null이면 `:19497`에서 from=null·to=대상 fiber로 "밖에서 들어옴" 처리 → 대상과 그 조상 전부에 enter 발화). `new MouseEvent('mouseover', {bubbles:true})`(relatedTarget 기본 null)를 래퍼에 dispatch. 실패하면 `pointerover`로 대체(`:19460`·`:19504-19505`에서 함께 처리) |

## 7. 검증

**e2e 14 추가 단언** — #11c의 "새 터미널: 모아보기 그리드에 셀 등장"(:357-361) 뒤, "모아보기 닫고 새 탭 정리"
(:362) **앞**에 `#11d`로 넣는다(모아보기가 열려 있고 셀 ≥ 2인 유일한 구간. 24의 ChipMenu 단언은 `#11`~`#11b` 사이의
`#11a`, 28의 프로젝트 색은 `#11c` 정리 뒤 `#12` — 라벨이 겹치지 않는다). 시작부(:43-45)에 `const origLayout = await
uGet("aggregateLayout");`, `finally`(:406)에 `setAggregateLayout(origLayout)` 원복.

```js
// ── #11d 자동배치 모드(태스크 27) — 모아보기 열림·셀 ≥ 2 상태에서.
// gridAfter는 그리드 안 `.xterm` 수(:299-302, :356) — 브라우저 셀은 안 세므로 n>1 판정으로는 보수적(스킵 쪽으로 기운다).
if (gridAfter < 2) {
  r.skip("자동배치 모드", `셀 ${gridAfter}개 — 자동배치 버튼은 n>1에서만 렌더`);
} else {
  // 그리드 자식(=셀 슬롯)의 top으로 행 구성을 읽는다. 배치는 absolute+calc라 DOM 순서로는 행을 알 수 없다.
  const rowShape = () => cdp.eval(`(()=>{
    const g = document.querySelector('[style*="grid-template-columns"]');
    if (!g) return null;
    const tops = [...g.children].map(el => Math.round(el.getBoundingClientRect().top));
    const first = tops.filter(t => t === Math.min(...tops)).length;
    return { n: tops.length, first, rows: new Set(tops).size };
  })()`);
  const gridColsOf = (n) => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);

  await cdp.eval(`window.__gpv.ui.getState().setAggregateLayout("columns")`);
  const colShape = await poll(rowShape, (v) => v && v.first === Math.min(v.n, 4), 10, 250);
  r.check(
    "자동배치 columns: 첫 행 셀 수 = min(n, 4)",
    !!colShape && colShape.first === Math.min(colShape.n, 4),
    J(colShape),
  );
  r.check(
    "aggregateLayout localStorage 영속",
    (await cdp.eval(`localStorage.getItem('gp:aggregate-layout')`)) === "columns",
  );
  await cdp.eval(`window.__gpv.ui.getState().setAggregateLayout("grid")`);
  const gridShape = await poll(rowShape, (v) => v && v.first === gridColsOf(v.n), 10, 250);
  r.check(
    "자동배치 grid: 첫 행 셀 수 = gridCols(n)",
    !!gridShape && gridShape.first === gridColsOf(gridShape.n),
    J(gridShape),
  );

  // 팝오버 — 균등 상태(aria-disabled="true")에서 래퍼 hover로 열려야 한다(React disabled 차단 우회 검증).
  // React는 onMouseEnter를 네이티브 mouseover에서 합성한다(relatedTarget null = 밖에서 들어옴).
  const hover = await cdp.eval(`(()=>{
    const b = [...document.querySelectorAll('button')].find(x => /자동배치/.test(x.textContent||''));
    if (!b) return { found: false };
    b.parentElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { found: true, aria: b.getAttribute('aria-disabled'), nativeDisabled: b.disabled };
  })()`);
  const popBtns = () => cdp.eval(`(()=>{
    const m = [...document.querySelectorAll('div.fixed.z-50')].find(d => d.querySelector('button[title^="그리드"]'));
    return m ? m.querySelectorAll('button').length : 0;
  })()`);
  const icons = await poll(popBtns, (v) => v === 2, 8, 150);
  r.check(
    "자동배치 hover → 모드 팝오버(아이콘 2개) — aria-disabled 상태에서도",
    hover.found && hover.nativeDisabled === false && icons === 2,
    J({ ...hover, icons }),
  );
  // 아이콘 클릭 = 모드 설정 + 대상 모드 균등 트랙 + 닫힘
  await cdp.eval(
    `[...document.querySelectorAll('div.fixed.z-50 button')].find(b => /^세로 컬럼/.test(b.title))?.click()`,
  );
  const picked = await poll(() => uGet("aggregateLayout"), (v) => v === "columns", 8, 150);
  const popGone = await poll(popBtns, (v) => v === 0, 8, 150);
  const tracks = await cdp.eval(`(()=>{
    const s = window.__gpv.ui.getState();
    const t = s.aggregateTracks['n' + ${colShape?.n ?? 0}];
    return t && {
      lens: t.cols.map(a => a.length),
      even: t.rows.every(v => v === 1) && t.cols.every(a => a.every(v => v === 1)),
    };
  })()`);
  r.check(
    "모드 아이콘 클릭 → aggregateLayout=columns · 트랙 균등(첫 행 min(n,4)) · 팝오버 닫힘",
    picked === "columns" && popGone === 0 && !!tracks && tracks.even && tracks.lens[0] === Math.min(colShape?.n ?? 0, 4),
    J({ picked, popGone, tracks }),
  );
  const iconNow = await cdp.eval(
    `!![...document.querySelectorAll('button')].find(x => /자동배치/.test(x.textContent||''))?.querySelector('svg.lucide-columns-3')`,
  );
  r.check("메인 버튼 아이콘 = 현재 모드(Columns3)", iconNow === true);
  await cdp.eval(`window.__gpv.ui.getState().setAggregateLayout("grid")`);
}
```

**실기(디버그 앱 `npm run dev:app`, CDP 29222)** — 관측값은 DOM·스토어·계산 스타일로 적는다.

1. 모아보기 열기, 터미널 **3개** 표시(n=3). `[style*="grid-template-columns"]` 자식 3개의 `getBoundingClientRect()`
   → grid: top 2종(2+1). 자동배치 버튼 **hover** → `div.fixed.z-50`에 버튼 2개, 그리드 아이콘 버튼의
   `getComputedStyle(...).color`가 `--color-accent`와 같고 `bg-raised`. **세로 컬럼 클릭** → 자식 3개의 top 동일(1행),
   width ≈ (그리드 clientWidth − 12 − 12)/3, `useUi.getState().aggregateLayout === "columns"`,
   `localStorage['gp:aggregate-layout'] === "columns"`, `aggregateTracks.n3 = { rows:[1], cols:[[1,1,1]] }`,
   팝오버 소멸. 메인 버튼 svg 클래스 `lucide-columns-3`.
2. 셀을 **6개**로(`+`로 추가 또는 칩 선택) → top 2종, 첫 행 4개·둘째 행 2개. 별도 창(1100px)에서 첫 행 셀 폭 ≈ 267px
   (`≥ 240`) 기록. 셀 하나의 프롬프트 컬럼(헤더 History 버튼)을 켜 xterm 호스트 폭 ≈ 155px임을 기록 — 한계 확인용.
3. 첫 행 셀 경계를 드래그 → `aria-disabled="false"`, opacity 1, hover 색 변화. **메인 버튼 클릭** → 트랙 균등,
   모드는 columns 유지(아이콘 그대로), `aggregateTracks.n6.cols.map(a=>a.length)` = `[4,2]`.
4. 균등 상태 → 버튼 `aria-disabled="true"`, `getComputedStyle(btn).opacity === "0.4"`, `btn.disabled === false`.
   **hover** → 팝오버 열림(이 항목이 §2 React 차단의 회귀 가드). 버튼 **클릭** → `aggregateTracks` 참조 불변
   (클릭 전후 `useUi.getState().aggregateTracks === prev`), 확대 상태 무변화.
5. 팝오버에서 **그리드 클릭** → n=6이 3+3(top 2종, 첫 행 3개), `aggregateTracks.n6.cols` 길이 `[3,3]`, 모드 grid.
6. 0행 우측 끝 셀을 **브라우저(외부 URL, 네이티브 webview)** 로 두고 자동배치 hover → 팝오버가 보이고 그 브라우저
   셀의 webview가 숨는다(`BrowserPane active=false`) → leave 150ms 뒤 팝오버 닫힘·webview 복귀. 팝오버 위로 마우스를
   옮겼을 때 닫히지 않음(hold).
7. 팝오버가 열린 상태에서 셀을 닫아 n=1로 → 팝오버 소멸, 이후 셀을 다시 2개로 늘려도 hover 없이는 팝오버가
   **안** 나타남(§3.5 ④).
8. 묶음 칩(탭 모으기 ON) hover 드롭다운이 이전과 같이 열리고 칩→드롭다운 이동 시 닫히지 않음(훅 교체 회귀).
9. columns 상태로 **dev 앱 재시작** → 모아보기 열면 아이콘 `lucide-columns-3`, n=3이 1행. 모아보기 **별도 창**을
   열면 그 창도 columns로 뜬다(시작 시 localStorage 동기).
10. 다크·라이트 각 1회: 활성 아이콘 `text-accent`가 `bg-raised` 위에서 읽힘.

## 8. 구현 결과(2026-09-02 구현 · 2026-09-03 검증)

§5 단계 1~6 전부 완료. `npx tsc --noEmit` **exit 0**, e2e 14 단독 실행 **57 pass / 0 fail / 1 skip**
(`#11d` 5단언 전부 pass), §7.2 실기 1~10 **전부 관측**(§8.3). Rust 변경 0.

| 파일 | LOC | 무엇을 |
|---|---|---|
| `src/stores/ui.ts` | +15 | `AggregateLayout` 타입 export, `aggregateLayout` 상태·초기값(`gp:aggregate-layout`), `setAggregateLayout`(수동 영속 — `toggleAggregateGroupTabs`와 같은 패턴) |
| `src/components/AggregateTerminals.tsx` | +140 / −28 | `Columns3` import, 모듈 함수 `gridCols`/`colsFor`/`shapeFor`·훅 `useDelayedClose`·상수 `LAYOUT_MODES`, `layout` 구독, 묶음 칩 타이머 3줄×2 → 훅, `layoutMenu` 상태·점유 OR·n≤1 스테일 정리, `cols/rows/rowLens`를 `shapeFor(layout, n)`로, `evenTracks(mode)`·`pickLayout`, 자동배치 버튼을 래퍼 span + `aria-disabled`로, 모드 팝오버 |
| `tests/e2e/suites/14-frontend-dom.mjs` | +90 | `#11d` 블록(#11c "그리드에 셀 등장" 뒤 · "모아보기 닫고 새 탭 정리" 앞), 시작부 `origLayout`, `finally` 원복 |

### 8.1 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| 1 | e2e 스니펫의 `gridColsOf = (n) => …` 인자명을 `k`로 | 스위트 상단에 이미 `n`을 쓰는 스코프가 여럿이라 셰도잉을 피했다. 동작 동일 |
| 2 | `finally`의 원복을 `if (origLayout)`로 가드 | `aggregateLayout`이 없는 빌드(스토어 갱신 전 HMR 등)에서 `setAggregateLayout(undefined)`로 localStorage에 `"undefined"`를 쓰지 않게. 그 값이 남아도 초기값 로더가 grid로 떨어뜨리지만 남길 이유가 없다 |
| 3 | `const shape = \`n${n}\`` 위 주석의 "모양 충돌이 없다"를 §3.3 근거로 다시 씀 | 원 주석은 "n이 마지막 행 셀 수까지 결정"이라 단언했는데 모드가 생기면서 **모드 안에서만** 참이다. 낡은 근거를 남기면 다음 사람이 §3.3을 다시 유도해야 한다 |
| 4 | 설계 §4 스니펫의 `evenTracks` 주석에 "그 순간 `layout`은 아직 이전 값"을 추가 | `pickLayout`이 인자를 넘기는 이유가 코드에 없으면 다음 사람이 인자를 지운다(같은 이벤트 안 zustand set은 렌더 클로저의 `layout`을 갱신하지 않는다) |

설계 §4의 계약(타입·초기값·액션·모듈 함수·JSX 구조·클래스 문자열·title 문구)은 그 외 전부 그대로다.

### 8.2 검증 결과

| 항목 | 결과 |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `node --check` (e2e 14) | exit 0 |
| `shapeFor`/`colsFor` 표 대조(스크래치 `shapefor-check.mjs`, node assert) | **통과** — §3.3 표의 n=2~9·10·12 전 행이 `{cols, rows, rowLens}`까지 일치, `rowLens` 합 = n(렌더 청킹과 정합), n=0·1에서 `Array(rows)` RangeError 없음(§3.5 ⑥), "columns ≠ grid는 n=3~9뿐"(n=0~20 전수) |
| §3.2 셀 폭 계산 | 1100px 창 1행 배치: 3열 **358.7** · 4열 **267.5**(≥ MIN_W 240) · 5열 **212.8** · 6열 **176.3** — 문서 표와 일치. **4열은 실측으로 확정**(별도 창 `innerWidth`=그리드 `clientWidth`=1100 → 267.5px, §8.3 실기 2) |
| e2e 14 `#11d` | **5단언 전부 pass** — 스위트 전체 57 pass / 0 fail / 1 skip(스킵은 이 태스크와 무관한 태스크 24의 "숨김 셀 칩 메뉴" — 탭 모으기 ON이라 개별 칩이 없어 스위트가 스스로 건너뛴다). 다만 실행 시점의 셀 수가 **n=13**이라 두 모드의 모양이 같아(§3.3 — columns≠grid는 n=3~9뿐) 첫 두 단언은 모드를 **구별하지 못한다**. 구별은 실기 1·2·5(n=3·6)가 한다 |
| §7.2 실기 1~10 | **전부 관측 · 통과** — §8.3 |

### 8.3 실기 관측 결과(2026-09-03, dev 앱 CDP 29222)

환경 — 메인 창 `innerWidth/Height = 2560×1392` CSS px(dpr 1.5), 그리드 `clientWidth = 2060`, 테마 monokai,
터미널 탭 9개. 별도 창 `1100×720`, 그리드 `clientWidth = 1100`. 호버는 전부 **실제 포인터**
(CDP `Input.dispatchMouseEvent` — 합성 `MouseEvent`가 아니라 브라우저 hit-test를 거친다).

| # | 관측값 | 판정 |
|---|---|---|
| 1 | n=3 grid: `rows=2 · rowLens=[2,1]`. 버튼 hover(래퍼 span) → `div.fixed.z-50` 버튼 2개, 우측 정렬(팝오버 `right`=버튼 `right`=2384.7, `top`=버튼 `bottom`+4=67.7). 활성(그리드) 아이콘 `color=rgb(79,180,230)`=`--color-accent` `#4fb4e6`, `bg=rgb(22,31,44)`=`--color-raised` `#161f2c`; 비활성은 `fg-muted`·투명. **세로 컬럼 클릭** → `rows=1 · rowLens=[3]`, 셀 폭 **678.7** = (2060−12−12)/3, `aggregateLayout="columns"` · `gp:aggregate-layout="columns"` · `aggregateTracks.n3={rows:[1],cols:[[1,1,1]]}`, 팝오버 소멸, 메인 버튼 아이콘 `lucide-columns-3` | ✅ |
| 2 | 별도 창(1100) columns n=6: `rowLens=[4,2]`, 첫 행 셀 폭 **267.5**(= (1100−12−18)/4, `≥ MIN_W 240`). 첫 셀 프롬프트 컬럼(`PromptLogButton`) 열기 → 프롬프트 컬럼 110px, **xterm 호스트 156.2px**(`.xterm-screen` 139px) — §3.2의 "≈155" 예측과 일치. 닫으면 패널 0개로 복귀 | ✅ |
| 3 | 첫 행 첫 경계 col-resize 핸들 드래그(−150px) → `rowLens` 불변·폭 `[357.5, 657.5, 507.5, 507.5]`, 트랙 `{rows:[639,639],cols:[[357.5,657.5,507.5,507.5],[1,1]]}`. 버튼 `aria-disabled="false"` · `opacity=1`, hover 시 `color`→`rgb(230,237,246)`(fg)·`bg`→raised. **메인 버튼 클릭** → 폭 전부 507.5, 트랙 `{rows:[1,1],cols:[[1,1,1,1],[1,1]]}`(=`[4,2]`), 모드는 columns 유지(아이콘 `lucide-columns-3`) | ✅ |
| 4 | 균등 상태: `aria-disabled="true"` · `getComputedStyle(btn).opacity === "0.4"` · **`btn.disabled === false`**. 그 상태에서 **실제 포인터 hover → 팝오버 열림**(§6 첫 행 위험의 회귀 가드 — React `getListener`가 `disabled` 버튼의 onMouseEnter를 삼키는 함정을 래퍼 span + `aria-disabled`가 실제로 우회한다). 버튼 클릭은 no-op: `useUi.getState().aggregateTracks === prev`(참조 동일), 확대 셀 0개·행 수 불변 | ✅ |
| 5 | 팝오버에서 **그리드 클릭** → n=6이 `rowLens=[3,3]`, 셀 폭 678.7, 트랙 `cols=[[1,1,1],[1,1,1]]`, `aggregateLayout="grid"`·LS `grid`, 메인 아이콘 `lucide-grid-2x2` | ✅ |
| 6 | 0행 **우측 끝** 셀을 브라우저(외부 URL `https://example.com/` = 네이티브 webview)로 두고 관측. 팝오버 열기 전 자식 `WRY_WEBVIEW` HWND(rect `2047,141,506,1221`) `IsWindowVisible = true` → **hover로 팝오버 열림 → `false`** → 포인터를 팝오버 위로 옮겨도 팝오버 유지·webview 계속 숨김(hold) → 이탈 **166ms** 뒤 팝오버 닫힘 + `IsWindowVisible = true` 복귀 | ✅ |
| 7 | 팝오버 열린 상태에서 칩 해제로 n=1 → 버튼 언마운트(쿼리 결과 null)·팝오버 소멸. 포인터를 그리드로 옮긴 뒤 셀을 3개로 되돌려도 팝오버 **안 나타남**(스테일 정리 effect 동작) | ✅ |
| 8 | 묶음 칩(탭 모으기 ON) 실제 포인터 hover → 드롭다운 즉시 열림(칩 1개 + 새 터미널 행), 칩→드롭다운으로 건너가도 300ms 후 유지, 이탈 후 **165ms**에 닫힘 — `useDelayedClose(150)` 교체 회귀 없음 | ✅ |
| 9 | columns 상태로 **메인 창 새로고침**(`location.reload()`) → `aggregateLayout="columns"`·LS `columns` 복원, 모아보기 열고 n=3 → `rows=1 · rowLens=[3]`, 아이콘 `lucide-columns-3`. **별도 창**을 새로 열면 시작부터 `layout="columns"`·아이콘 `lucide-columns-3`(스토어 초기화가 localStorage를 읽는 그 경로) | ✅ |
| 10 | 활성 아이콘(accent on raised) 대비 — 다크(monokai) `#4fb4e6`/`#161f2c` = **7.11:1**, 라이트 `#3574f0`/`#e6e8ee` = **3.49:1**. 비활성(fg-muted on panel)은 7.82 / 7.12 | ⚠️ 아래 |

**10의 라이트 3.49:1** — WCAG 비텍스트(아이콘) 기준 3.0은 넘고 텍스트 기준 4.5는 못 넘는다. 다만 이 색쌍은
**기존 "탭 모으기 ON"의 상태색과 같은 `bg-raised text-accent`**라 이 태스크가 새로 만든 한계가 아니다
(라이트에서 상태색을 올리려면 토큰 레벨 변경 — 범위 밖).

관측 수단 메모(다음 사람을 위해):

- **`window.__TAURI_INTERNALS__.invoke`는 감쌀 수 없다** — `writable:false, configurable:false`라 대입이
  조용히 무시된다(sloppy mode). invoke 로깅으로 `browser_set_visible`을 잡으려던 첫 시도가 이래서 빈 로그였다.
- **자식 webview는 CDP 타깃으로 안 잡힌다**(e2e 07 주석과 동일 — `data_directory` 격리). 그래서 6의 판정은
  Win32 `EnumChildWindows` + `IsWindowVisible`(스크래치 `win-children.ps1`)로 했다 — `wv.hide()`의 진짜 결과다.
- vite dev 모듈 그래프로 `import('/src/stores/occlusion.ts')` 하면 **다른 인스턴스**가 잡힌다(HMR 쿼리).
  점유 카운터가 팝오버 열림 중에도 계속 0으로 읽혔다 — 이 경로로 스토어를 관측하지 말 것.

### 8.4 발견한 선행 이슈

이 태스크의 변경 범위에서는 **없음**. `AggregateTerminals.tsx`의 태스크 24 변경(`History` import·
`chipPromptOpen`·ChipMenu 항목)과 `stores/ui.ts`의 태스크 20 변경은 삽입 지점이 겹치지 않아 그대로
얹혔다(§2 예측대로).

검증 중 **범위 밖에서 한 번** 관측한 것(원인 미규명, 이 태스크와 무관):

- §7.2 6의 임시 브라우저 셀을 헤더 X(`브라우저 닫기`)로 닫은 뒤 **자식 webview
  `gpv-browser-<id>`가 살아남은 경우가 1회** 있었다(`plugin:webview|get_all_webviews`에 잔존 ·
  HWND `IsWindowVisible=true`로 메인 창 우측을 덮고 있었다). 셀은 그리드에서 사라졌으므로
  `releaseBrowser → disposeBrowser → browser_close` 경로 중 어딘가가 유실된 것인데,
  같은 절차를 다시 돌린 최종 관측(§8.3 6)에서는 남지 않았다 — 재현 조건을 못 잡았다.
  잔존분은 `browser_close`로 정리했고 앱 상태는 실험 전으로 복원했다(webview 목록
  `main`·`float-pool-14`만, `gp:browser` localStorage 원본 복원). 브라우저 셀 정리 경로를 볼 일이
  생기면 이 관측을 출발점으로.
