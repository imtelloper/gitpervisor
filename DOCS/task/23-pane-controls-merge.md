# 태스크 23 — 터미널 pane 세션 컨트롤 오버레이 병합

> 상태: **구현 완료 · 검증 통과(미커밋)** (2026-09-02) — §9 · 근거: 코드 실측 2026-09-02(워킹트리 기준 — 대상 4파일은 HEAD 14108eb와
> 동일, `git diff --stat` 빈 출력) · 상위 설계: `DOCS/pane-history-tooltip-layout-design.md` §1.1 · §2.1 A1 · §3 A1 · §5

## 1. 요구사항

터미널 pane 우상단의 **테마(팔레트)·히스토리 버튼이 눌려야 한다** — 메인 워크스페이스와 플로팅 창 모두.
지금은 버튼이 DOM에 있고 hover 시 그려지기도 하지만, 같은 자리에 겹친 다른 오버레이가 클릭을 전부 가져간다.

받아들이는 조건:
- 터미널 pane에 포인터를 올리면 우상단에 **오버레이가 하나만** 나온다: `[팔레트][히스토리] | [웹 전환][우분할][하분할][최대화][닫기]`.
- 히스토리 버튼 중심의 `document.elementFromPoint`가 그 버튼(또는 자식)이다. 클릭하면 프롬프트 컬럼이 열리고,
  다시 누르면 닫힌다 — **컬럼이 닫힌 상태에서** 열 수 있어야 한다(지금 안 되는 방향).
- 팔레트 버튼 클릭 → 컬러 스킴 메뉴가 뜨고 항목 선택이 xterm에 적용된다.
- 최대화·닫기 버튼은 **한 벌**만 남는다(현재 두 오버레이가 중복으로 갖고 있다).
- 브라우저 리프(주소창 안 컨트롤)는 변하지 않는다.
- 위 항목이 메인 워크스페이스(분할·최대화 포함)와 플로팅 창(`float-*`)에서 같은 결과다.

## 2. 현황(근거)

### 2.1 두 오버레이가 같은 앵커에 겹친다

- 워크스페이스·플로팅 창·최대화 뷰는 전부 `PaneTreeRoot → LeafView → TerminalPane` 한 경로다
  (`WorkspaceTabs.tsx:179`, `FloatingTerminal.tsx:225`, 최대화 분기 `PaneTree.tsx:32-45`, 리프 렌더 `:115-128`).
- **오버레이 A — PaneTree** (`PaneTree.tsx:124-126`): LeafView가 `TerminalPane`의 **형제**로
  `absolute right-1 top-1 z-30 … opacity-0 … group-hover/pane:opacity-100` div에 `PaneControls`를 얹는다.
  `PaneControls`는 `TBtn` 5개(전환·우분할·하분할·최대화·닫기, `PaneControls.tsx:47-64`), `TBtn`은 `p-1` + 13px 아이콘(`:87`, `:51-63`),
  버튼 사이 `gap-0.5`(`:46`). `group/pane`은 LeafView 래퍼(`PaneTree.tsx:116`).
- **오버레이 B — TerminalPane 클러스터** (`TerminalPane.tsx:99-118`): xterm 호스트 래퍼(`:97`, `relative h-full min-w-0 flex-1`) 안에
  `absolute right-1 top-1 z-10 … opacity-0 … focus-within:opacity-100 group-hover:opacity-100` div — `ThemeButton`(`:102`)·`PromptLogButton`(`:103`)·
  최대화(`:104-110`)·닫기(`:111-117`). 세션 버튼은 `p-0.5` + 12px 아이콘(`TermSessionControls.tsx:75-81`, `:150-154`). `group`은 TerminalPane 루트(`:87`).
- 둘 사이에 stacking context가 없다: TerminalPane 루트(`:86-89`)·호스트 래퍼(`:97`)·LeafView 래퍼(`PaneTree.tsx:116`)는 `relative`만이고 z-index가 없다.
  같은 컨텍스트에서 `z-30 > z-10` — A가 항상 위다.

### 2.2 기하 — 클래스 치수와 실측

Tailwind v4 기본 spacing(`--spacing: 0.25rem` — `styles.css:1-33`의 `@theme`는 색·폰트만 정의하고 spacing을 덮지 않는다):
`p-0.5`=2px · `p-1`=4px · `gap-0.5`=2px · `right-1`/`top-1`=4px · `border`=1px.

| | 구성 | 폭 계산 | 높이 |
|---|---|---|---|
| A PaneControls | 5 × (13 + 4·2) = 105 · gap 2×4 = 8 · 래퍼 p-0.5 4 + border 2 | **119px** | 21 + 6 = 27px |
| B 클러스터 | 4 × (12 + 2·2) = 64 · gap 2×3 = 6 · 래퍼 4 + 2 | **76px** (히스토리 개수 배지 1자리 ≈ +8 → 84, 2자리 ≈ 90) | 16 + 6 = 22px |

- **CDP 실측**(상위 설계 §1.1, 메인 창): A `{l:477.7, w:118.3, z:30}` vs B `{l:513.8, w:82.2, z:10}`, 둘 다 `right=596`.
  B의 x구간 [513.8, 596] ⊂ A의 [477.7, 596], y구간 [4, 26] ⊂ [4, 31] → **B는 완전히 덮인다.** B 4버튼 중심의 `elementFromPoint`는
  전부 A의 `TBtn`이었다. 배지 1자리 추정치 84와 실측 82.2가 맞는다.
- 덧붙여 포인터가 A 위에 있으면 TerminalPane(`group`) 밖이라 B는 `opacity-0`이다 — 보이지도 않는다. 단, opacity는 hit-test에
  영향이 없으므로 "보이지 않아서"가 아니라 "z-order에서 져서" 눌리지 않는 것이다.

### 2.3 비대칭의 정확한 원인(상위 설계 보완)

B의 앵커는 **xterm 호스트 래퍼**(`TerminalPane.tsx:97`)이고 A의 앵커는 **pane 전체**다. 프롬프트 컬럼(`:121`, `w-[15%] min-w-[110px]`,
`TermSessionControls.tsx:224`)이 **열리면** 호스트가 그만큼 줄어 B가 ≥110px 왼쪽으로 이동한다 → B의 x구간 ≈ [404, 486] vs
A [477.7, 596] → 겹침은 B의 오른쪽 끝 ≈ 8px(닫기 버튼 일부)뿐이고 **테마·히스토리는 눌린다.** 즉:

- 컬럼 **닫힘**: B 완전 피복 → 열 수 없다(상위 설계의 "열기는 안 되는").
- 컬럼 **열림**: B가 노출돼 히스토리로 닫을 수도 있고, 컬럼 헤더 X(`TermSessionControls.tsx:237-243`)로도 닫힌다. 이때 pane 우상단에
  두 오버레이가 **나란히** 보여 최대화·닫기가 두 벌 보인다.

세션 상태는 termId 단위 스토어(`promptHistory.ts:129`, `togglePanel :164-173`, write-through `persistPanel :70-79` →
localStorage `gp:prompt-panel-open`), 창 간 동기는 storage 이벤트(`:211-223`). 플로팅 창은 같은 번들·같은 origin이라 그대로 공유된다.

### 2.4 그 외 사실

- `TermSessionControls`의 `ThemeButton`·`PromptLogButton` 사용처는 `TerminalPane.tsx:102-103`과 모아보기 셀 헤더(`AggregateTerminals.tsx:1199-1200`) 둘뿐.
  `PaneTree.tsx`는 `TermSessionControls`를 import하지 않는다(`:1-12`).
- `ThemeButton`은 자기 메뉴가 열린 동안 `useOccludesWebview(!!menu)`를 스스로 등록한다(`TermSessionControls.tsx:36`). 메뉴·백드롭은 버튼의
  **형제 fragment**로 렌더돼(`:83-131`) 버튼을 담은 부모 div 안에 놓인다 — 부모의 `opacity-0`이 메뉴에도 적용된다. B의 `focus-within:opacity-100`(`:101`)이
  그 대비책이다(버튼·메뉴 항목이 포커스를 가지면 부모가 보인다). A(`PaneTree.tsx:124`)에는 `focus-within`이 **없다.**
- `PaneMenu`(`TerminalPane.tsx:164-278`)는 `Maximize2`/`Minimize2`(`:260`)·`X`(`:270`)를 아이콘으로 쓰고 액션은 `useTerminals()` 전체
  스토어(`:179`)로 부른다 — TerminalPane의 `toggleMaximize`/`closePaneAct` 셀렉터(`:52-53`)는 클러스터 전용이다. `maximized`(`:48-50`)는
  PaneMenu prop(`:154`)이라 유지 대상.
- `takenByWindow` 안내 오버레이는 `z-20`(`:122-130`) — A(z-30)는 이미 그 위에 있다.
- `dropPane`이 pane 종료 시 `usePromptHistory.clear`·`useTermThemes.clear`를 부른다(`stores/terminals.ts:14-15`) — e2e 정리가 `closeTab`으로 끝난다.
- e2e 훅 `window.__gpv`는 `ui·terminals·videoSplit·planSegments(+queryClient)`만 노출(`main.tsx:49-56`, `:188-191`) — `promptHistory`는 없다.
  `tests/e2e/lib/cdp.mjs` `connect()`는 라벨 `main` 페이지만 고른다(`export async function connect` — 워킹트리 스냅샷 `:206-250`, 라벨 비교 `:218`;
  파일이 다른 세션 편집 중(M, +118/−24)이라 줄은 심볼로 찾는다. 라벨을 못 읽는 옛 빌드용 첫-매칭 폴백만 있다) — 플로팅 창 DOM은 러너에서 못 본다.

## 3. 설계

### 3.1 대안

| 대안 | 평가 |
|---|---|
| **a. A에 세션 버튼 편입, B 삭제** (채택 — 상위 설계 A1) | 오버레이 1개·버튼 7개. 중복 최대화·닫기 제거. A는 이미 pane 전체 앵커라 컬럼 열림과 무관하게 같은 자리. `-24/+8` LOC |
| b. B를 살리고 A를 왼쪽으로 밀기(`right-[90px]`) | 두 오버레이가 나란히 — 중복 버튼 유지, 배지 폭에 따라 간격이 흔들림. 근본 수정 아님 |
| c. B에 `z-40` | 이번엔 A가 덮인다(전환·분할이 죽음). 같은 결함을 반대로 만든다 |
| d. B를 지우고 세션 버튼을 `PaneControls` 안에 넣기 | `PaneControls`는 브라우저 주소창에도 들어간다(`PaneTree.tsx:109`, `BrowserPane.tsx:349-354`) — `content` 분기가 필요해지고 브라우저 리프가 변한다 |

**a 채택.** 세션 버튼은 터미널 전용이므로 LeafView의 **터미널 분기 오버레이**에만 넣고 `controls`(`PaneTree.tsx:101-103`)는 그대로 둔다 →
브라우저 분기(`:106-112`)는 같은 `controls`를 받으므로 코드·렌더 결과가 무변경이다.

### 3.2 크기 정합 — TBtn(p-1·13px, 21px 박스) vs 세션 버튼(p-0.5·12px, 16px 박스)

| 선택 | 평가 |
|---|---|
| **① 그대로 둔다** (채택) | 오버레이가 `items-center`라 세로 중앙 정렬. 아이콘 12 vs 13px은 육안 차이가 거의 없고, 16px 히트박스는 모아보기 셀 헤더에서 이미 쓰는 치수. 변경 파일 0 |
| ② `ThemeButton`/`PromptLogButton`에 `size` prop | `TermSessionControls.tsx`는 태스크 25→26이 바꾸는 파일 — 이번 범위에서 손대면 충돌. 모아보기 헤더는 12px을 유지해야 하므로 prop 분기가 필요 |
| ③ `TBtn`을 p-0.5·12px로 축소 | 브라우저 주소창(15px `NavBtn` 옆)에서도 줄어든다 — 그쪽 시각 회귀 |
| ④ PaneTree에서 `[&>button]:p-1 [&_svg]:size-[13px]` 같은 임의 변형 래퍼 | 동작하지만 배지 span까지 영향, 나중에 읽는 사람이 해독해야 한다 |

①. 시각 불일치가 거슬리면 25·26 이후 ②를 별도 1커밋으로(§8 오픈 이슈).

### 3.3 상위 설계와의 차이

| # | 상위 설계(§2.1 A1) | 이 문서 | 이유 |
|---|---|---|---|
| 1 | 삭제할 import에 `Maximize2`/`Minimize2`/`X` 포함 | **유지** | 같은 파일의 `PaneMenu`가 아이콘으로 쓴다(`TerminalPane.tsx:260,270`). 지우면 tsc 실패 |
| 2 | 병합 오버레이 클래스에 `focus-within:opacity-100` 없음 | **추가** | B가 갖고 있던 대비책(§2.4). 없으면 좁은 pane에서 팔레트 메뉴가 pane 밖으로 나갈 때 포인터가 pane을 벗어나는 순간 메뉴가 투명해진다(클릭은 되지만 안 보임). 키보드 포커스 표시도 이걸로 산다 |
| 3 | — | TerminalPane 루트의 `group` 마커 제거 | 소비자가 B의 `group-hover`뿐이었다(`workspace/` 내 `group-hover` 검색 4곳 중 TerminalPane 자손은 `TerminalPane.tsx:101`만 — `ViewerFileTabs.tsx:86`·`WorkspaceTabs.tsx:410`은 자기 탭 행의 `group`을 보고, `PaneTree.tsx:124`는 명명 `group/pane`). 죽은 마커 |
| 4 | "열린 뒤엔 컬럼 헤더 X로 닫힌다" | 열린 뒤엔 B 자체도 노출돼 눌린다(§2.3) | 결함 설명의 정밀화 — 설계 결론은 같다 |

### 3.4 만들지 않는 것

- `PaneControls` 최대화 아이콘의 상태 반영(`Maximize2`↔`Minimize2`) — 상위 §6 ④, 범위 밖. `PaneMenu`에는 있다.
- 세션 버튼 클릭 시 `setActivePane` — B는 TerminalPane 안이라 `onMouseDown`(`:90`)이 활성 pane을 바꿨지만, A는 형제라 바꾸지 않는다.
  `PaneControls`가 이미 그 거동이고(`TBtn`은 `stopPropagation`), 세션 상태는 pane 활성과 무관하다.
- xterm 호스트 래퍼(`:97-98`) 축약(ref를 래퍼로 올리기) — 동작 이득 없이 fit 측정 대상이 바뀐다.
- `__gpv.promptHistory` 노출 — `main.tsx`는 지금 다른 세션이 수정 중(워킹트리 M, +3). e2e는 write-through localStorage와 DOM으로 본다.
  26(B1)이 자기 e2e를 위해 노출한다(26 §3.7 #6) — 그 뒤엔 이 문서의 스니펫도 그 훅으로 관측해도 된다.
- 플로팅 창 DOM e2e — `cdp.mjs`도 수정 중(M, +118/−24). 실기로 대신(§7). 25(A3)가 `listTargets`·`attach`·`LABEL_EXPR` export와
  `attachFloat` 헬퍼를 넣으므로(25 §3.5 ③·§7.1) 그 뒤 §7.2 7을 러너로 옮길 수 있다(§8 ②).

## 4. 계약(타입·액션·코드)

Tauri 커맨드·이벤트·Rust 변경 **없음**. 새 타입·스토어 액션 없음. 쓰는 시그니처(현행):

```ts
// TermSessionControls.tsx:25,142
export function ThemeButton({ termId }: { termId: string }): JSX.Element
export function PromptLogButton({ termId }: { termId: string }): JSX.Element
// PaneControls.tsx:17-25
export function PaneControls({ tabId, paneId, content }: { tabId: string; paneId: string; content: PaneKind })
// promptHistory.ts:129,137 — 버튼이 내부에서 쓴다. 관측 지점: openPanels[termId] / localStorage "gp:prompt-panel-open"
openPanels: Record<string, true>;  togglePanel: (termId: string) => void;
```

**`PaneTree.tsx`** — import 1줄 + 오버레이(:124-126 교체):

```tsx
import { PromptLogButton, ThemeButton } from "./TermSessionControls";   // :11 `./PaneControls`와 :12 `./TerminalPane` 사이 — 대소문자 순서상 `TermS…` < `Termi…`(`AggregateTerminals.tsx:47-48`과 같은 순서)

// LeafView 터미널 분기 — :124-126
<div className="absolute right-1 top-1 z-30 flex items-center gap-0.5 rounded-md border border-edge bg-panel/95 p-0.5 opacity-0 shadow-lg transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100">
  <ThemeButton termId={leaf.paneId} />
  <PromptLogButton termId={leaf.paneId} />
  <span className="mx-0.5 h-3 w-px bg-edge" />
  {controls}
</div>
```

병합 후 폭: 내용 16 + 2 + 16(+배지) + 2 + 5(구분선 `mx-0.5 w-px`) + 2 + 113 = 156 · 래퍼 p-0.5 4 + border 2 → **162px**(+배지 ≈ 168~176; §2.2 표의 119와 같은 셈법), 높이 27px(가장 큰 `TBtn` 기준).
브라우저 분기(`:106-112`)·`controls` 정의(`:101-103`)·`PaneControls.tsx`·`BrowserPane.tsx` 무변경.

**`TerminalPane.tsx`** — 삭제만:

| 앵커 | 내용 | 처리 |
|---|---|---|
| `:27` | `import { PromptLogButton, PromptSidePanel, ThemeButton } from "./TermSessionControls";` | `import { PromptSidePanel } from "./TermSessionControls";` |
| `:52-53` | `const toggleMaximize = …; const closePaneAct = …;` | 삭제(클러스터 전용 — PaneMenu는 `ts.*` 사용) |
| `:87` | `` className={`group relative flex h-full w-full ${…}`} `` | `group ` 제거 |
| `:99-118` | 주석 2줄 + 클러스터 div(테마·히스토리·최대화·닫기) | 통째로 삭제 |

유지: `:1-12` lucide import 전부(`Maximize2`/`Minimize2`/`X`는 PaneMenu), `:48-50` `maximized`, `:55` `promptOpen`, `:58` `useOccludesWebview(!!menu)`,
`:97-98` 호스트 래퍼, `:121` `{promptOpen && <PromptSidePanel termId={paneId} />}`, `:122-130` `takenByWindow`.

## 5. 단계(구현 순서)

1. **PaneTree.tsx**: import 추가, `:124-126` 오버레이 교체(§4). — 규모 S, +8/-1
2. **TerminalPane.tsx**: `:99-118` 삭제 → `:52-53` 삭제 → `:27` import 축소 → `:87` `group` 제거(줄 번호는 아래에서 위로 지우면 그대로 맞는다). — S, -24
3. `npx tsc --noEmit -p .` — 미사용 import·변수는 `tsconfig.json:19-20`의 `noUnusedLocals`/`noUnusedParameters`가 잡는다(루트 프로젝트에 eslint 설정·lint 스크립트는 없다 — `package.json` scripts). `Maximize2`/`Minimize2`/`X`는 PaneMenu 사용으로 남아야 정상.
4. **e2e 14**: `:46`에 `let paneId = null;`, `:133-135`를 `openTerminal` 반환 `{ tabId, paneId }` 수신으로 바꾸고(24 `#2c`·26 `#2d`가 같은 변수를 쓴다 — 함수 스코프에 **한 번만**),
   §7 단언을 `#2a`로 `#2 새 터미널 렌더` 바로 뒤(`14-frontend-dom.mjs:140` 다음, `#2b` 앞)에 추가 — 단일 pane 상태에서 오버레이가 가장 넓게 보이는 시점. — +48
5. **실기**(§7) — 메인·플로팅. 정적 통과만으로 끝내지 않는다.

규모: **S** — 소스 2파일 ≈ +8/-25, e2e ≈ +45. Rust 0.

**선행/후행 문서**: **23 → 24**(`TerminalPane.tsx` — 24(A2)가 `PaneMenu`에 "프롬프트 목록 열기/닫기" 항목과 하단 클램프 `- 448`
(24 §3.3 — 상위 설계의 270이 아니다)을 넣는다. 23의 삭제(`:99-118` 20줄 + `:52-53` 2줄 = **22줄**)가 먼저 들어가야 24의 줄 범위가 맞다 —
24의 `PaneMenu` 앵커는 22줄 앞으로 밀린다(:164 → :142; 24 §5에 대응표가 있다). 24는 `usePromptHistory` 구독을 `PaneMenu` 함수 **안**에 두므로
TerminalPane의 `promptOpen`(`:55`)과 스코프가 달라 이름 충돌이 없다). e2e 14는 **23 → 24 → 26** 순으로 `#2a`·`#2c`·`#2d`가 같은 함수 스코프
`paneId`를 공유한다(§7.1). `TermSessionControls.tsx`(25→26)·`AggregateTerminals.tsx`(24→27→28)는 이 태스크가 **읽기만** 한다.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 팔레트 메뉴가 오버레이 opacity에 묶임 | 메뉴 div는 오버레이의 자손(§2.4). 포인터가 pane을 벗어나 메뉴 위로 가면 `group-hover/pane` 해제 | `focus-within:opacity-100`(§3.3 #2) — 클릭한 버튼·메뉴 항목이 포커스를 가진다. 백드롭 클릭은 메뉴를 닫으므로 투명 상태가 남지 않는다. B와 동일 수준 |
| 오버레이 폭 증가 119 → 162px(+배지) | 8분할 같은 좁은 pane에서 hover 중 xterm 우상단 글자를 더 가린다 | hover 중에만 보인다(기존과 같은 조건). 최소 pane 폭 제약은 없음 — 실기에서 8분할 확인 |
| 배지 자릿수로 오버레이 폭이 변함 | 히스토리 개수 0→1→10에서 폭이 ~8px씩 증가 — hover 중 버튼 위치가 좌로 이동 | 오른쪽 정렬(`right-1`)이라 `PaneControls` 5개는 고정, 세션 버튼만 왼쪽으로 자란다. 수용 |
| `takenByWindow` 중 세션 버튼 클릭 가능 | z-20 안내 오버레이 위에 z-30 오버레이 | 이미 `PaneControls`가 그 상태. 테마·컬럼 상태는 세션 단위라 별도 창 셀에 반영된다 — 무해 |
| e2e가 hover 가시성을 못 본다 | `elementFromPoint`는 opacity와 무관 → 오버레이 CSS가 깨져도 hit-test는 통과 | §7 실기 1·2에서 실제 포인터로 `getComputedStyle(overlay).opacity === "1"` 확인을 필수로 둔다 |
| 24와 같은 파일 | `TerminalPane.tsx` 동시 수정 시 충돌 | 순차(23 → 24). 23은 삭제만이라 리베이스가 단순하다 |
| `Maximize2`/`X` import를 상위 설계대로 지움 | tsc 실패 | §3.3 #1. 단계 3의 tsc가 즉시 잡는다 |

## 7. 검증

### 7.1 e2e 14 추가 단언(`14-frontend-dom.mjs`, `#2` 렌더 확인 뒤 · `#2b` 앞)

먼저 픽스처 탭 생성에서 `paneId`도 받는다 — `openTerminal`은 `{ tabId, paneId }`를 돌려주는데(`:132` 주석) 지금은 `tabId`만
쓴다(`:133-135`). 24(`#2c`)·26(`#2d`)이 같은 값을 쓰므로 **함수 스코프 `let`에 한 번만** 두고 뒤 블록은 재선언하지 않는다
(try 스코프에 `const paneId`를 다시 선언하면 그 앞 블록이 TDZ ReferenceError로 죽는다).

```js
    let paneId = null; // :46 `let tabId = null;` 옆 — 23·24·26 공용
    // …
    // :133-135 교체 — 새 탭은 leaf 하나라 paneId == activePaneId
    const opened = await cdp.eval(
      `window.__gpv.terminals.getState().openTerminal(${J(fix.projectId)})`,
    );
    tabId = opened.tabId;
    paneId = opened.paneId;
```

```js
    // ── #2a 세션 컨트롤 오버레이 병합 hit-test (태스크 23) ──
    // 회귀 대상: TerminalPane 우상단 세션 클러스터(z-10)가 같은 앵커의 PaneControls 오버레이(z-30)에 완전히 덮여
    // 테마·히스토리 버튼이 눌리지 않았다. 병합 뒤엔 pane에 오버레이가 하나고, 각 버튼 중심의 elementFromPoint가
    // 자기 자신이어야 한다. opacity-0은 hit-test에 영향이 없어 hover 없이도 판정된다(합성 mouseover는 CSS :hover를
    // 바꾸지 못한다 — 보이는지는 실기가 본다).
    if (rendered >= 1) {
      // paneId: 위에서 잡은 함수 스코프 변수 — 재선언 금지(24 #2c·26 #2d도 같은 것을 쓴다).
      const hit = await cdp.eval(`(()=>{
        const x = document.querySelector('.xterm');
        const pane = x && x.closest('[class~="group/pane"]');
        if (!pane) return { err: 'pane 래퍼 없음' };
        for (const t of ['pointerover','mouseover','mouseenter']) x.dispatchEvent(new MouseEvent(t,{bubbles:true}));
        const log = pane.querySelector('button[title^="입력한 프롬프트"]');
        const theme = pane.querySelector('button[title^="이 터미널의 컬러 테마"]');
        if (!log || !theme) return { err: '세션 버튼 없음', buttons: pane.querySelectorAll('button').length };
        const center = (b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); };
        const hitLog = center(log), hitTheme = center(theme);
        const overlay = log.closest('.z-30');
        return {
          log: !!hitLog && log.contains(hitLog),
          theme: !!hitTheme && theme.contains(hitTheme),
          top: hitLog ? (hitLog.closest('button') || hitLog).title : null,
          merged: !!overlay && overlay.contains(pane.querySelector('button[title="패널 닫기"]')),
          closeBtns: pane.querySelectorAll('button[title^="패널 닫기"]').length,
        };
      })()`);
      r.check("세션 컨트롤 hit-test: 히스토리 버튼 중심 = 그 버튼", hit.log === true, hit.err || `top="${hit.top}"`);
      r.check("세션 컨트롤 hit-test: 팔레트 버튼 중심 = 그 버튼", hit.theme === true, hit.err || "");
      r.check(
        "오버레이 병합: 세션 버튼이 PaneControls와 한 오버레이(z-30), 닫기 버튼 1개",
        hit.merged === true && hit.closeBtns === 1,
        `merged=${hit.merged} close=${hit.closeBtns}`,
      );
      // 클릭 → 컬럼 여닫힘. 스토어(usePromptHistory)는 __gpv에 없으므로 write-through된 localStorage
      // (gp:prompt-panel-open — promptHistory.ts persistPanel)와 DOM(PromptSidePanel 헤더의 X)으로 본다.
      const panelState = () => cdp.eval(`(()=>{
        let ls = {}; try { ls = JSON.parse(localStorage.getItem('gp:prompt-panel-open') || '{}'); } catch (e) {}
        const pane = document.querySelector('.xterm')?.closest('[class~="group/pane"]');
        return { ls: ls[${J(paneId)}] === true, dom: !!pane && !!pane.querySelector('button[title="프롬프트 목록 닫기"]') };
      })()`);
      const clickLog = () => cdp.eval(
        `(()=>{ const b = document.querySelector('[class~="group/pane"] button[title^="입력한 프롬프트"]'); if (b) { b.click(); return true; } return false; })()`,
      );
      await clickLog();
      const st1 = await poll(panelState, (v) => v.ls && v.dom, 12, 250);
      r.check("히스토리 버튼 클릭 → 컬럼 열림(localStorage + DOM)", st1.ls && st1.dom, J(st1));
      await clickLog();
      const st2 = await poll(panelState, (v) => !v.ls && !v.dom, 12, 250);
      r.check("히스토리 버튼 재클릭 → 컬럼 닫힘", !st2.ls && !st2.dom, J(st2));
    } else {
      r.skip("세션 컨트롤 오버레이 병합", "터미널 렌더 선행 실패 — 스킵");
    }
```

수정 전 기대 결과(회귀 감지력 확인): `hit.log === false`, `top`은 `PaneControls` 버튼 title(실측 위치상 분할 버튼), `merged === false`
(히스토리 버튼의 `.z-30` 조상 없음), `closeBtns === 2`("패널 닫기" + "패널 닫기 (Ctrl+Shift+W)"). 수정 후 전부 반전.
정리는 기존 `finally`의 `closeTab`이 맡는다 — `dropPane`이 `clear(paneId)`로 컬럼 상태까지 지운다(§2.4).
정규식에 `\d`를 쓰지 않는다(이 파일 `:175-176` 주석 — 템플릿 → CDP → eval을 거치며 역슬래시가 죽는다). 셀렉터는 `[class~="group/pane"]`로
`/` 이스케이프를 피한다.

### 7.2 실기(디버그 앱 `npm run dev:app`, CDP 29222 — `lib.rs:94`)

메인 창 CDP에 붙어 관측값을 읽는다. 아래 `OV`는 `document.querySelector('.xterm').closest('[class~="group/pane"]').querySelector('.z-30')`.

1. **hover 가시성(진짜 포인터)**: 프로젝트 선택 → 터미널 탭 하나 → 마우스를 pane 우상단에 물리적으로 올린 채
   `getComputedStyle(OV).opacity` → `"1"`, 떼면 `"0"`. `OV.querySelectorAll('button').length` → **7**, title 순서
   `이 터미널의 컬러 테마…` · `입력한 프롬프트 N개…` · `웹으로 전환` · `오른쪽으로 분할` · `아래로 분할` · `최대화/복원` · `패널 닫기`.
   `OV.getBoundingClientRect().width` ≈ 162~176(§4 계산치 — 실측으로 확정).
2. **히스토리(닫힘 → 열림)**: 컬럼이 닫힌 상태에서 히스토리 버튼을 **마우스로** 클릭 → 우측 컬럼(헤더 `프롬프트 N`) 등장,
   버튼 클래스에 `text-accent`, `.xterm` rect 폭이 컬럼 폭만큼 감소, `JSON.parse(localStorage['gp:prompt-panel-open'])[paneId] === true`.
   재클릭 → 전부 반전. 터미널에 한 줄 입력 후 Enter → 컬럼에 항목 추가·배지 증가(오버레이 폭이 왼쪽으로 자라는지).
3. **팔레트 + focus-within**: 우분할로 pane을 210px보다 좁게 만든 뒤(메뉴 폭 210) 팔레트 클릭 → 메뉴가 pane 밖으로 나온다.
   포인터를 메뉴 위로 옮겨도 `getComputedStyle(OV).opacity === "1"`(포커스 유지) · 스킴 선택 → xterm 배경색 변경 · 백드롭 클릭 → 메뉴 닫힘.
   `useOcclusion.getState().count`(`stores/occlusion.ts:25`)가 열림 중 1, 닫힘 후 0 — `__gpv`에 없으므로 14 `#2b`처럼
   `performance.getEntriesByType("resource")`에서 `/src/stores/occlusion.ts` 모듈 URL을 찾아 `import()`한다(브라우저 분할 이웃이 있을 때
   메뉴가 가려지지 않는지 함께).
4. **브라우저 리프 무변경**: 웹 전환 버튼 → 주소창 안 컨트롤에 팔레트·히스토리 **없음**(`button[title^="입력한 프롬프트"]` 0개), 구분선은
   BrowserPane 자체(`h-5`) → 터미널로 전환 복귀.
5. **최대화 경로**: 분할 상태에서 최대화 → 단일 LeafView 렌더(`PaneTree.tsx:32-45`) → 1~2와 같은 오버레이·같은 결과 → 복원.
6. **8분할**: 우클릭 → 8분할 → 각 pane hover 시 오버레이가 pane 폭 안에 들어가고 이웃 pane을 침범하지 않는지(폭 ≈ 162 vs pane 폭).
7. **플로팅 창**: 우클릭 → "새 창으로 분리 (Float)"(`TerminalPane.tsx:266`) → 플로팅 창 pane 우상단 hover → 1과 같은 7버튼 오버레이. 히스토리 클릭 → 그 창에 컬럼 등장.
   **메인 창 CDP**에서 `JSON.parse(localStorage['gp:prompt-panel-open'])[paneId] === true`(같은 origin — storage 공유). 팔레트로 스킴 변경 →
   그 창 xterm 배경 변경. "메인으로 되돌리기"(`FloatingTerminal.tsx:220`) → 메인 pane에 컬럼이 **열린 채** 돌아오고 스킴도 유지(세션 단위 스토어).
   플로팅 창 자체 DOM을 CDP로 보려면 `http://127.0.0.1:29222/json`의 `type === "page"` 목록(문서 타이틀은 전부 `Gitpervisor` — `index.html:7` — 라
   타이틀로는 못 가른다)에 각각 `webSocketDebuggerUrl`로 붙어 `window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label`(`cdp.mjs:22` `LABEL_EXPR`)을
   평가해 `float-<paneId>`인 페이지를 고른다(`float-pool-*`는 아직 pane이 없는 프리워밍 창 — 제외; `cdp.mjs connect()`는 `main`만 고른다).
8. 콘솔 오류 0. `npm run test:e2e`에서 14 통과, 13(플로팅 창)·06(터미널) 회귀 없음.

## 8. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값 |
|---|---|---|
| ① | 세션 버튼 16px vs `TBtn` 21px 히트박스를 맞출지 | **그대로**(§3.2 ①). 거슬리면 25·26 이후 `size` prop 1커밋 |
| ② | 플로팅 창 DOM을 러너에서 단언할지(`cdp.mjs`에 라벨 지정 attach 헬퍼) | **이번엔 실기**. `cdp.mjs`가 다른 세션 수정 중(M). 25(A3)가 export 3개 + `attachFloat`(25 §4·§7.1)를 넣는다 — 그 뒤 §7.2 7을 13 스위트로 옮기는 것은 후속 1커밋 |
| ③ | `__gpv.promptHistory` 노출(`main.tsx` 1줄) | **안 함**. localStorage write-through가 같은 관측을 준다 |

## 9. 구현 결과(2026-09-02)

§5 단계 1~5 전부 구현. `npx tsc --noEmit` **exit 0**. Rust 변경 0. 열린 질문 ①②③ 전부 기본값(§8) 그대로.

| 파일 | LOC | 무엇 |
|---|---|---|
| `src/components/workspace/PaneTree.tsx` | +9/−1 | `TermSessionControls` import 1줄 + LeafView 터미널 분기 오버레이에 `ThemeButton`·`PromptLogButton`·구분선 편입, `gap-0.5`·`focus-within:opacity-100` 추가(§4 그대로). 브라우저 분기·`controls`·`PaneControls.tsx`·`BrowserPane.tsx` 무변경 |
| `src/components/workspace/TerminalPane.tsx` | +2/−24 | 삭제만 — 세션 클러스터 div(`:99-118`) · `toggleMaximize`/`closePaneAct` 셀렉터 · 루트의 `group` 마커 · import 축소(`PromptSidePanel`만). `Maximize2`/`Minimize2`/`X`는 `PaneMenu`가 써서 유지(§3.3 #1) |
| `tests/e2e/suites/14-frontend-dom.mjs` | +125/−13 | 이 중 ≈+56이 §7.1(#2a 블록 + 함수 스코프 `let paneId` + `openTerminal` 반환 수신). 나머지 ≈+69/−13은 러너에서 14가 흔들리던 선행 결함 수리(§9.1 ②③) |

### 9.1 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| ① | 없음 — §4 코드 블록·§5 순서 그대로 | — |
| ② | (범위 밖 수리) `#2` 앞에 `ensureAggClosed()` 전제 검사 추가, `#2b`·`#11` 직전 재확인 | 모아보기 뷰가 열린 채면 `main`을 그리드가 차지해 `.xterm`이 전부 셀의 것이 된다 → #2 우클릭 메뉴·#11 진입이 연쇄로 깨진다. 이 상태에서 `#2a`도 pane 래퍼를 못 찾는다 |
| ③ | (범위 밖 수리) 4분할 판정을 `>= 4`에서 **클릭 전 개수 +3**으로, `#11` 모아보기 버튼을 텍스트 대신 `title`로, `aggGrid`를 즉시 세지 말고 poll, `#2b` `cdp.eval` `timeoutMs: 180000` | `>= 4`는 다른 탭 패널만으로도 충족돼 4분할 실행을 증명하지 못했다(러너에서 실제로 거짓 통과). 나머지는 같은 성격의 취약점 |
| ④ | §7.2 3의 "스킴 선택 → xterm **배경색** 변경"을 DOM 배경색이 아니라 xterm 인스턴스의 `term.options.theme.background`로 관측 | WebGL 렌더러(`terminal-engine.ts` `WebglAddon`)라 배경은 캔버스에 그려진다 — `.xterm`/`.xterm-viewport`/`.xterm-screen` computed 배경은 스킴을 바꿔도 전부 불변이고 캔버스 readback은 `0,0,0,0`(preserveDrawingBuffer 없음). `lib/terminal`의 `registry`를 통해 실제 적용값을 읽었다 |

### 9.2 실기 관측값(CDP 29222 · 라벨 `main`/`float-*` · 진짜 포인터 `Input.dispatchMouseEvent`)

| §7.2 | 항목 | 관측값 |
|---|---|---|
| 1 | hover 가시성 | pane 위 포인터 → `getComputedStyle(OV).opacity` **"1"**, 사이드바로 뺐을 때 **"0"**. `OV.querySelectorAll('button').length` **7**, title 순서 = 설계 그대로(`이 터미널의 컬러 테마…` · `입력한 프롬프트 0개…` · `웹으로 전환` · `오른쪽으로 분할` · `아래로 분할` · `최대화/복원` · `패널 닫기`). pane당 `.z-30` **1개**. rect **161.3 × 26.3px**(§4 계산치 162 × 27) |
| 1 | 진짜 hover 중 hit-test | 히스토리 버튼 중심 `elementFromPoint` → 그 버튼(title 일치) |
| 2 | 컬럼 **닫힘 → 열림** | 마우스 클릭 → `localStorage['gp:prompt-panel-open'][paneId] === true`, 컬럼 헤더 `프롬프트 0`, 버튼에 `text-accent`, `.xterm` 폭 **689 → 579**(−110 = 컬럼 `min-w-[110px]`) |
| 2 | 입력 후 | 터미널에 `echo gpv23` + Enter → 헤더 `프롬프트 1`, 배지 `1`, 항목 `echo gpv23 방금 전`, 오버레이 폭 **161.3 → 168.2**(배지 1자리 +6.9 — §2.2 추정 +8) |
| 2 | 재클릭 | ls·DOM·accent 전부 반전, `.xterm` 폭 689 복귀 |
| 3 | 팔레트 + focus-within | 메뉴 **210 × 288px**, 항목 9. `useOcclusion.count` **0 → 1 → 0**. 메뉴 연 채 포인터를 창 좌상단(20,20)으로 빼도 `opacity === "1"`(activeElement = 팔레트 버튼) · 백드롭/선택 후 메뉴 닫힘 |
| 3 | 스킴 적용 | 메뉴에서 `Monokai` 실클릭 → `term.options.theme.background` **`#070a11` → `#272822`**, `gp:term-themes[paneId] = "monokai"`, 탭 닫으면 `{}`(dropPane 정리) |
| 4 | 브라우저 리프 | `웹으로 전환` 실클릭 → 그 pane의 `button[title^="입력한 프롬프트"]`·`[title^="이 터미널의 컬러 테마"]` **0개**, `.z-30` 오버레이 **0개**(컨트롤은 주소창 안), `패널 닫기` 1개 · `터미널로 전환`으로 복귀 시 7버튼 오버레이 그대로 |
| 5 | 최대화 경로 | 분할 후 최대화 → 보이는 pane 1개, 오버레이 1개·7버튼·161.3px · 복원 → pane 2개 |
| 6 | 8분할 | 단일 pane(689px) → 8분할: pane 폭 **168~172px**, 오버레이 161.3px가 **8/8 전부 pane 안**(`overflow:hidden` 조상 기준 잘림 0px), 전부 7버튼 |
| 7 | 플로팅 창 | 분리(풀 창 `float-pool-18`이 claim) → 그 창 pane 우상단에 **7버튼 오버레이 1개**(161.3px), hover `opacity "1"`, 히스토리 버튼 중심 `elementFromPoint` = 그 버튼. 클릭 → 그 창에 컬럼 등장 · **메인 창** localStorage가 같은 paneId를 `true`로 본다 |
| 7 | 되돌리기 | `메인으로 되돌리기` 실클릭 → 메인 탭(projectId 정상)에 **컬럼이 열린 채** 복귀(`text-accent` 유지), 오버레이 7버튼 |
| 8 | 콘솔 | `window.onerror`·`unhandledrejection`·`console.error` 수집 **0건**(실기 A·B 두 회차) |

> **각주(2026-09-03)**: 위 표와 §7.2의 "pane 우상단"은 §10 수정 뒤 **xterm 호스트 우상단**으로 읽는다. 컬럼이
> 닫혀 있으면 같은 자리(rect 161.3 × 26.3px 그대로)이고, 열려 있으면 오버레이가 컬럼 **왼쪽**에 남는다(§10.1).

**e2e**: 14 스위트 단독 러너 **28 pass / 0 fail / 0 skip**(#2a 5단언 포함). 회귀 확인 — 13(플로팅 창) **17 pass**, 06(터미널 PTY) **9 pass**.
정리 확인: 만든 탭·플로팅 창 전부 회수, `gp:prompt-panel-open`·`gp:term-themes` 둘 다 `{}`, 고아 탭 0, 탭 수 원복.

### 9.3 발견한 선행 이슈(수정 안 함 — 범위 밖)

- **`term_open` 직후 ~2~4초 동안 `term_project`가 `null`** — 이 창에서 갓 만든 터미널을 그 사이에 분리하면
  `FloatingTerminal`의 `ipc.termProject(paneId).catch(()=>null) ?? ""`(`FloatingTerminal.tsx:75`)가 빈 문자열을 받아
  플로팅 창 스토어의 `projectId`가 `""`가 되고, **되돌리기가 `projectId: ""`인 고아 탭**을 메인에 만든다(어느 프로젝트에도
  안 붙어 UI에 안 보이지만 PTY는 산다). 실측: 기존 pane 3개는 전부 정상 id, 갓 만든 pane은 0/1/2초 `null` → 4초에 정상.
  사람 손 속도로는 거의 안 걸리지만 존재한다. 이번 변경과 무관(플로팅·redock 경로는 손대지 않았다).
- **8분할보다 더 좁은 pane(이중 분할로 82px)에서는 오버레이 161px가 pane 폭을 넘는다** — `fits === false` 실측.
  `SplitView`의 셀이 `overflow-hidden`이라 이웃 pane을 덮지는 않고 왼쪽(팔레트 쪽)이 잘린다. 82px 케이스의 잘림 폭은
  측정하지 않았다. 병합 전(119px)에도 82px는 못 담았으므로 성격은 같고 임계 폭만 119 → 162로 올라갔다(§6 표의 그 위험).

## 10. 후속 결함 — 프롬프트 컬럼 헤더 X가 오버레이에 덮인다 (2026-09-03, 태스크 25 검증에서 발견)

**증상**: 컬럼이 열린 pane에서 컬럼 헤더의 X(`프롬프트 목록 닫기`, `TermSessionControls.tsx` PromptSidePanel 헤더)를 누르면
컬럼이 아니라 **pane이 닫히고 PTY가 죽는다**(태스크 25 §9.4 실측 — 1차 시도에서 pane·PTY 소멸 재현).

**원인**: 오버레이는 LeafView 래퍼(pane 루트) 기준 `absolute right-1 top-1`이고(`PaneTree.tsx:129`), 컬럼은 `TerminalPane`
루트 flex의 **마지막(우측) 자식**이다(`TerminalPane.tsx:100`). 컬럼이 열리면 pane 우상단 = 컬럼 헤더 우측이라, hover로 나타난
오버레이(161px, 맨 오른쪽 버튼이 `패널 닫기`)가 컬럼 헤더의 X 자리를 정확히 덮는다. 병합 전에도 PaneControls 오버레이(119px)가
같은 자리에 있었으므로 **선행 결함**이지만, 이번 병합으로 폭이 42px 늘어 덮이는 범위가 커졌고 히스토리 버튼이 살아나 컬럼을
여는 동선이 열리면서 실제로 마주치게 됐다.

**수정(태스크 23 소유 파일 — 후속 커밋)**: 오버레이를 pane 루트가 아니라 **xterm 호스트 래퍼 안**에 그린다 — 컬럼 왼쪽 영역의
우상단이 되어 컬럼 헤더와 절대 겹치지 않는다.
- `TerminalPane`에 `controls?: React.ReactNode` prop 추가. 호스트 래퍼 `<div className="relative h-full min-w-0 flex-1">`
  (`:96`) 안, `ref` div 다음에
  `<div className="absolute right-1 top-1 z-30 flex items-center gap-0.5 rounded-md border border-edge bg-panel/95 p-0.5 opacity-0 shadow-lg transition-opacity focus-within:opacity-100 group-hover/pane:opacity-100">{controls}</div>`.
  `group/pane`은 LeafView 래퍼(조상)에 그대로 있으므로 hover 조건은 동일하게 동작한다.
- `PaneTree.tsx` LeafView 터미널 분기: 형제 오버레이 div(`:125-134`)를 지우고
  `<TerminalPane … controls={<><ThemeButton termId={leaf.paneId} /><PromptLogButton termId={leaf.paneId} /><span className="mx-0.5 h-3 w-px bg-edge" />{controls}</>} />`.
  브라우저 분기 무변경.
- **컬럼 자체의 헤더 X도 오버레이 아래 z에 있어야 하는 이유가 없다** — 위 이동으로 겹침이 사라지므로 z 조정은 불필요.
- 검증: e2e 14 `#2a`(hit-test)는 그대로 통과해야 한다(오버레이는 여전히 pane당 1개, 7버튼). 추가 단언 — 컬럼을 연 뒤 컬럼
  헤더 X 중심 `elementFromPoint`가 그 X 버튼이고, 실클릭 시 `openPanels[paneId]`가 false가 되며 **pane 수·PTY(term_project)는
  불변**. 실기: 컬럼 열린 상태에서 오버레이 rect가 컬럼 rect와 겹치지 않음(`right` 차이 ≥ 컬럼 폭).

### 10.1 수정 결과(2026-09-03)

§10의 수정안 그대로 구현. `npx tsc --noEmit -p .` **exit 0**. Rust 변경 0. 설계 이탈 없음(§10.3).

| 파일 | LOC | 무엇 |
|---|---|---|
| `src/components/workspace/TerminalPane.tsx` | +15/−0 | `controls?: React.ReactNode` prop 추가 · xterm 호스트 래퍼(`relative h-full min-w-0 flex-1`) 안, `ref` div 다음에 오버레이 div(`absolute right-1 top-1 z-30 … focus-within:opacity-100 group-hover/pane:opacity-100`)로 `{controls}` 렌더. 오버레이 주석을 이 자리로 옮기고 "왜 pane 루트가 아니라 호스트 안인가"(= 컬럼 헤더 X를 덮지 않으려고)를 명시 |
| `src/components/workspace/PaneTree.tsx` | +10/−11 | LeafView 터미널 분기의 형제 오버레이 div 삭제 → `<TerminalPane … controls={<><ThemeButton/><PromptLogButton/><span 구분선/>{controls}</>} />`. import·`controls` 정의·브라우저 분기·`PaneControls.tsx`·`BrowserPane.tsx` 무변경 |
| `tests/e2e/suites/14-frontend-dom.mjs` | +97/−9 | `#2a`에 §10 단언 3개(≈+64). 나머지 ≈+33/−9는 `#2c`·`#11a` 메뉴 라벨 재읽기의 간헐 실패 수리(§10.3 ②) |

`git diff`의 numstat은 이 세 파일 모두 **아직 미커밋인 태스크 23(원래 병합)·24·26의 변경분과 섞여 있다** — 위 LOC은 이 수정만 손으로 센 값이다.

**e2e 14 단독 러너: 2회 연속 60 pass / 0 fail / 1 skip.** 스킵 1건은 기존 `#11a` "숨김 셀 칩 메뉴"(탭 모으기 모드라 개별 칩이 없다).
`#2b`(모아보기 반환 후 PTY 폭)는 두 회차 모두 **통과**(스킵 아님). 기존 `#2a` 단언(히스토리·팔레트 버튼 `elementFromPoint`,
`merged`, `closeBtns=1`, 컬럼 여닫힘)은 그대로 통과.

| `#2a` 추가 단언 | 실측 |
|---|---|
| 컬럼 열림 시 오버레이 right ≤ 컬럼 left | overlay right **2284.66**(w 161.33) · column left **2288.66**(w 271.34) — `right-1`의 4px 여유 |
| 컬럼 헤더 X 중심 `elementFromPoint` = 그 X | `top="프롬프트 목록 닫기"` |
| X 실클릭(= `elementFromPoint`가 준 **최상단** 요소를 누른다 — 덮여 있으면 '패널 닫기'가 눌려 즉시 드러난다) | 컬럼만 닫힘(`ls=false dom=false`) · `.xterm` **1→1** · `term_project(paneId)` 클릭 전후 **같은 projectId** |

### 10.2 실기 관측값(CDP 29222 · 라벨 `main`/`float-pool-*` · 진짜 포인터 `Input.dispatchMouseEvent`)

| # | 항목 | 관측값 |
|---|---|---|
| 1 | 메인 hover 가시성·위치 | 포인터를 pane에 올리면 `getComputedStyle(OV).opacity` **"1"**, 창 좌상단으로 빼면 **"0"**. 버튼 **7개**, title 순서 = 설계 그대로. rect **161.33 × 26.33px**, `right=2556` — xterm 우측(2560) 안쪽 4px |
| 2 | 컬럼 열림(히스토리 버튼 **마우스** 클릭) | 컬럼 rect `{l:2288.66, r:2560, w:271.34}`. 오버레이가 **컬럼 왼쪽으로 이동** — `right=2284.66 ≤ 2288.66` (겹침 0). 컬럼 X 중심 `elementFromPoint` = 그 X(`top="프롬프트 목록 닫기"`), 그 순간 오버레이 `opacity="1"`(즉 **보이는 채로도** 덮지 않는다) |
| 3 | 컬럼 X **마우스** 클릭 | 컬럼 소멸 · `gp:prompt-panel-open[paneId]` **false** · `.xterm` **1→1** · `term_project(paneId)` 클릭 전후 동일(`d1cd5d3a…`) — pane·PTY 생존 |
| 4 | 플로팅 창(`float-pool-14` claim) | 900×600 창에서 오버레이 **161.33 × 26.33px**, `right=896 ≤ xterm right=900`. 컬럼 열면 컬럼 `{l:765, w:135}`(min-w 110 초과 — 15%가 135) · 오버레이 `right=761 ≤ 765`. 컬럼 X hit-test = 그 X. X 마우스 클릭 → 컬럼만 닫히고 `.xterm` **1→1**, PTY 생존 |
| 4 | 플로팅 hover | 첫 회차에 `opacity="0"`으로 읽혔으나 **측정 아티팩트**였다 — 포인터가 이미 그 좌표에 있으면 `Input.dispatchMouseEvent(mouseMoved)`가 hover 상태를 갱신하지 않는다. 좌표를 몇 px 흔들어 다시 재니 **"1"**(재확인 스크립트로 별도 검증) |
| 5 | 되돌리기 | 플로팅 타이틀바 `메인으로 되돌리기` 실클릭 → 창 소멸, 메인에 탭 1개로 복귀(PTY 생존) |
| 6 | 정리 | 만든 탭·플로팅 창 전부 회수(탭 수 9→9, 잔여 float 창 0), `term_project(paneId)`가 `null`, `gp:prompt-panel-open` = `{}` |

### 10.3 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| ① | 없음 — §10 수정안의 코드·클래스 그대로 | — |
| ② | (범위 밖 수리, 상위 지시) `#2c`·`#11a`가 **라벨 반전을 보려고 메뉴를 다시 열 때** 쓰던 `sleep(300)` + 1회 읽기를 `openMenuFor(open, want)`로 교체 — (a) `!MENU`로 이전 메뉴가 닫힌 것을 poll로 확인하고 (b) 기대 라벨이 보일 때까지 읽고 (c) 그래도 안 되면 다시 연다(최대 3회). 관련 `r.check` 3곳에 detail 추가 | `#11a`의 "셀 메뉴: 라벨 '프롬프트 목록 닫기' → 닫힘"이 4회 중 1회 실패했는데 detail이 없어 어느 조건이 깨졌는지 알 수 없었다. 동작 의미는 그대로(같은 우클릭·같은 클릭·같은 판정) |
| ③ | `#2a`의 PTY 준비 대기를 16×500ms → **40×500ms**로 늘림 | `term_open`은 셸 spawn이 끝난 뒤에야 세션 맵에 등록한다(`terminal-engine.ts`의 "PTY가 80x24로 박제" 주석) — 그 전까지 `term_project`는 `null`이다. 첫 회차에서 8s 예산이 모자라 `pty null→null`로 **거짓 실패**했다. 별도 프로브 실측: 한가한 앱에서 등록까지 **≈4.5s**(레지스트리 등록은 ≈1.8s), 러너 부하에서는 그보다 길다 |
