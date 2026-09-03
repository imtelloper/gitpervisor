# 태스크 24 — 우클릭 메뉴 "프롬프트 목록 열기/닫기"

> 상태: **구현 완료 · 검증 통과(미커밋)** (2026-09-03) · 구현 결과·실측값은 §8 ·
> 근거: 코드 실측 2026-09-02(워킹트리 기준) · 상위 설계:
> `DOCS/pane-history-tooltip-layout-design.md` §2.1 **A2** (요구 1·2 — 세션 히스토리 접근성)
>
> 메뉴 높이는 실행 중 dev 앱(CDP 29222, 메인 창 1440×900, DPR 1.5)에서 **실측**했다(§2.4). 문서의
> 클램프 상수는 그 값에서 유도했고, 상위 설계의 숫자와 다른 곳은 §3.3에 이유를 적었다.

## 1. 요구사항

터미널 세션을 **우클릭**해서 그 세션의 프롬프트 컬럼(히스토리바)을 켜고 끌 수 있어야 한다 — 워크스페이스
pane, 플로팅 창 pane, 모아보기(메인 안·별도 창) 셀 모두.

받아들이는 조건:
- `PaneMenu`(워크스페이스·플로팅 공용)에 항목이 있고, 라벨이 현재 상태를 따라 **"프롬프트 목록 열기" /
  "프롬프트 목록 닫기"** 로 바뀐다. 위치는 '패널 최대화' 다음, '새 창으로 분리 (Float)' 앞.
- `ChipMenu`(모아보기 메인 안·별도 창 공용)에 같은 항목이 있다. 위치는 '확대해서 보기' 다음. **표시 중인
  터미널 셀에만** — 칩 우클릭으로 열린 **숨김 셀**의 메뉴와 **브라우저 셀** 메뉴에는 없다.
- 클릭하면 `usePromptHistory.openPanels[paneId]`가 토글되고(영속 + 다른 창 동기), 컬럼이 그 세션 옆에
  나타나거나 사라진다. 셀 헤더의 `PromptLogButton` 강조가 상태를 따라간다(기존 동작).
- 항목이 하나 늘어도 **화면 하단에서 우클릭한 메뉴가 잘리지 않는다**(하단 클램프).
- Rust 변경 0. 신규 컴포넌트 0. 신규 스토어 액션 0.

## 2. 현황(근거)

### 2.1 두 메뉴의 현재 모양

- `PaneMenu`(`src/components/workspace/TerminalPane.tsx:164-278`) — props `{ tabId, paneId, maximized, x, y,
  onClose }`(:164-178). 안에서 `const ts = useTerminals()`(:179)로 스토어를 직접 읽는다. 닫힘은 `window`
  `click`·Escape(:181-190), 항목 실행은 `run(fn) = () => { fn(); onClose(); }`(:192-195). 컨테이너는 `fixed z-50
  min-w-52 … py-1 text-[13px]`(:199), 위치 `left: min(x, innerWidth-220)`·`top: min(y, innerHeight-240)`
  (:201-202). 항목 12개, 구분선 3개(:219, :242, :258). 마지막 그룹: '패널 최대화(해제)'(:259-263) → '새 창으로
  분리 (Float)'(:264-268) → '패널 닫기'(:269-275, danger).
- `PaneMenu`는 `TerminalPane`이 우클릭 시 연다(:91-95 `onContextMenu` → `setMenu({x,y})`, :150-159). 열린 동안
  `useOccludesWebview(!!menu)`(:58)로 이웃 브라우저 pane의 네이티브 webview를 숨긴다 — 항목 추가로 바뀔 것 없음.
- 워크스페이스와 플로팅 창은 같은 `PaneTreeRoot → LeafView → TerminalPane`을 그린다
  (`WorkspaceTabs.tsx:179`, `FloatingTerminal.tsx:225`, `PaneTree.tsx:117-123`). 그래서 `PaneMenu` 한 곳이면 두 창을
  다 덮는다.
- `ChipMenu`(`src/components/AggregateTerminals.tsx:806-898`) — props `{ cell, x, y, shown, zoomed, onClose, onToggle,
  onZoom, onNewTerminal?, onFloat?, onCloseCell? }`(:806-830). **콜백만 받는 표현 컴포넌트**다 — 항목의 존재는
  optional 콜백의 유무로 정해진다(:871-895: `onNewTerminal`·`onFloat`·`onCloseCell`이 있을 때만 구분선+항목).
  닫힘·`run`은 PaneMenu와 같다(:831-845). 컨테이너 클래스 동일(:849), 위치 `left: min(x, innerWidth-220)`·
  `top: min(y, innerHeight-200)`(:851-852). 헤더 한 줄 `px-3 py-1 text-[11px]`(:857-859) + 구분선 + 토글 2개
  ('그리드에서 숨기기/그리드에 표시' :861-865, '확대해서 보기/확대 해제' :866-870) + optional 그룹.
- `ChipMenu` 호출처는 하나(:751-797)지만 **여는 곳은 셋**: 칩 바의 `Chip`(:496-505, `onMenu` :502), 그리드 셀 래퍼의
  `onContextMenu`(:639-644 — INPUT/TEXTAREA는 네이티브 메뉴 유지), 묶음 드롭다운 안의 `Chip`(:722-738, :729).
  `Chip` 자체의 우클릭은 :931-934. 컨테이너가 `shown={selected.has(chipMenu.cell.id)}`(:756)로 표시 여부를 넘기고,
  `onFloat`는 `cell.kind === "terminal" && cell.tabId != null`일 때만(:770-774), `onCloseCell`은
  `IS_AGGREGATE_WINDOW && tabId == null`이면 뺀다(:775-795) — **조건은 컨테이너가, 렌더는 메뉴가** 맡는 관례.
- `ChipMenu`가 열린 동안의 점유는 `useOccludesWebview(!!chipMenu || !!groupMenu)`(:326).
- 모아보기 메인 안(`App.tsx:166-167`)과 별도 창(`AggregateWindow.tsx:43`)이 같은 `AggregateTerminals`를 그린다 →
  `ChipMenu` 한 곳이면 두 표면을 다 덮는다.
- `CellMeta = CellSource & { hue }`(:125), `CellSource`는 `kind: "terminal" | "browser"` 판별 유니언(:99-117).
  터미널 셀의 `id`가 paneId(:102) = 프롬프트 스토어의 termId.

### 2.2 프롬프트 컬럼 상태 — 이미 세션 단위 스토어가 있다

- `usePromptHistory.openPanels: Record<string, true>`(`src/stores/promptHistory.ts:129`), `togglePanel(termId)`
  (:137 선언, :164-173 구현) — 메모리 갱신 후 `persistPanel`(:70-79)로 `gp:prompt-panel-open`(:18)에 termId 단위
  읽고-고쳐-쓰기. 다른 창의 변경은 `storage` 이벤트로 따라온다(:213-223). 즉 **어느 창에서 토글하든 같은 세션 =
  같은 상태**고, 이 태스크는 새 액션이 필요 없다.
- 렌더 소비자: 워크스페이스/플로팅 pane은 `TerminalPane.tsx:55` `promptOpen` → `:121 {promptOpen && <PromptSidePanel/>}`.
  모아보기 셀은 `AggregateCell`(`AggregateTerminals.tsx:1133`)의 `promptPanelOpen`(:1156). 셀 헤더의 `PromptLogButton`
  (:1200)은 상태에 따라 `bg-raised text-accent`(`TermSessionControls.tsx:151`).
- pane이 닫히면 `dropPane`이 `clear(paneId)`로 기록·열림 상태를 지운다(`stores/terminals.ts:12-16`) — 메뉴로 켠
  상태가 세션 종료 뒤 남지 않는다.

### 2.3 라벨 어휘 — 이 저장소의 관례

- 기존 토글 항목은 **현재 상태에 따른 한 동사**다: '패널 최대화' ↔ '패널 최대화 해제'(`TerminalPane.tsx:261`),
  '그리드에서 숨기기' ↔ '그리드에 표시'(`AggregateTerminals.tsx:863`), '확대해서 보기' ↔ '확대 해제'(:868).
  체크 표시·활성 스타일로 상태를 표현하는 항목은 없다(`MenuItem`에 active prop 없음 — `TerminalPane.tsx:281-293`).
- 세션 단위 어휘는 **"프롬프트 목록"**: 컬럼 헤더의 X 버튼 title "프롬프트 목록 닫기"(`TermSessionControls.tsx:239`),
  `PromptLogButton` title "…클릭하면 우측 목록을 엽니다/닫습니다"(:149), 컬럼 헤더 "프롬프트 {n}"(:227).
  "히스토리"는 창 단위 마스터 토글의 어휘다(`PromptHistoryButton` :186-187, :195 "히스토리") — 메뉴 항목은 **한
  세션**을 다루므로 세션 어휘를 따른다. 아이콘은 두 표면이 같이 쓰는 `History`(:7).

### 2.4 메뉴 높이 실측 — 하단 클램프 상수가 이미 낡았다

2026-09-02, 실행 중 dev 앱 메인 창(CDP 29222, `innerWidth 1440 × innerHeight 900`, 테두리 1px가 1.333px로
읽혀 DPR 1.5)에서 워크스페이스 xterm에 `contextmenu`를 디스패치해 `div.fixed.z-50.min-w-52`를 측정했다:

| 구성 요소 | 클래스 | 실측 |
|---|---|---|
| 항목(`MenuItem` button) | `px-3 py-1.5`(`TerminalPane.tsx:297`) — 글자 크기는 메뉴 컨테이너 `text-[13px]`(:199, body 기본과 같다 `styles.css:198`); line-height 1.5 상속 → 19.5px | **31.5px** × 12 |
| 구분선 | `my-1 border-t` | **8.667px** × 3 (4 + 0.667 + 4) |
| 컨테이너 세로 패딩 | `py-1` | 8px |
| 컨테이너 테두리 | `border` | 1.333px |
| **PaneMenu 전체** | | **413.33px** (= 12×31.5 + 3×8.667 + 8 + 1.333) — 유도식은 코드(:199·:219·:297)와 맞다; 실측 수치 자체는 CDP 재실행으로 재확인 (검증 필요) |

- **현재 `innerHeight - 240` 클램프는 173px 부족하다.** 900px 창에서 y ≥ 660이면 top=660, 메뉴 바닥 1073 → '새 창으로
  분리'·'패널 닫기'가 잘린다. 메뉴가 통째로 보이는 y의 상한은 487px — 창 아래 절반 어디서 우클릭해도 잘린다. 240은
  분할·그리드 항목이 붙기 전 값이 갱신되지 않은 채 남은 것이다. 상위 설계의 `-270`도 같은 이유로 부족하다(§3.3).
- `ChipMenu`는 측정 시점에 터미널이 없어(사용자 dev 창에 터미널을 만들지 않았다) 같은 클래스의 실측 치수로
  **계산**했다: 헤더 `py-1 text-[11px]` = 11×1.5 + 8 = 24.5, 구분선 2개, 항목 최대 5개(터미널 셀·메인 창: 숨기기·
  확대·새 터미널·Float·닫기) → 24.5 + 2×8.667 + 5×31.5 + 8 + 1.333 = **208.7px**. 현재 `-200`도 9px 모자란다.
  DPR 1(테두리 1px, 구분선 9px)이면 PaneMenu 415 / ChipMenu 210으로 조금 더 크다.
- 동일한 세로 뒤집기 선례: `ChangesPanel.tsx:547-557`(`menu.y > innerHeight/2 ? {bottom} : {top}`).
  `ThemeButton`은 "~290px" 근사 상수 + `maxHeight` + 뒤집기(`TermSessionControls.tsx:46-63`).

### 2.5 e2e 기반

- `window.__gpv = { ui, terminals, videoSplit, planSegments }`(`src/main.tsx:49-56`, DEV 전용) + `queryClient`(:188-191).
  **`promptHistory`는 노출돼 있지 않다.** 열림 상태는 DOM(`PromptSidePanel`)과 `localStorage["gp:prompt-panel-open"]`
  로 직접 관측 가능하다 — 둘 다 `openPanels`의 산출물(:121 렌더, :172 write-through)이라 스토어 노출 없이 단언한다.
- e2e 14(`tests/e2e/suites/14-frontend-dom.mjs`)는 이미 `.xterm`에 `contextmenu`를 디스패치하고 텍스트로 항목을
  찍는다(:222-235 '4분할'). 헬퍼: `sleep`(:13), `J`·`uGet`·`poll`(:24-37), 픽스처 탭 `tabId`(:133-138), 모아보기
  진입은 '모아보기' 버튼 클릭(:251-258), 정리는 `finally`(:406-423). 새 탭의 `layout`은 leaf 하나
  (`stores/terminals.ts:313`, `Pane` 타입 :58-60) → `layout.paneId`가 그 세션의 termId다.
- 히스토리 관련 e2e는 현재 0건(`tests/e2e` grep `prompt-panel|promptHistory|프롬프트` → 무관 2건).
- 측정 중 발견: HMR로 `stores/ui.ts`가 재인스턴스되면 부트 시 잡아 둔 `__gpv.ui`가 **스테일**해져
  `setAggregateOpen(true)`가 화면에 아무 효과가 없다(e2e 14 :153-156이 `lib/terminal.ts`에 대해 적어 둔 같은 함정).
  러너는 앱을 새로 띄워 도니 영향이 없지만, 실기에서 `__gpv`로 뷰를 조작할 때는 DOM 버튼을 우선한다.

## 3. 설계

### 3.1 항목을 어디에·어떻게

| 대안 | 평가 |
|---|---|
| **A. 두 메뉴에 `MenuItem` 1개씩, 라벨 = 상태별 한 동사, `togglePanel` 직접 호출** (채택) | 스토어·액션·컴포넌트 신설 0. 라벨 관례(§2.3)와 어휘 일치. `PaneMenu`는 스토어를 직접 읽는 선례(:179)가 있어 안에서 구독, `ChipMenu`는 콜백형이라 컨테이너가 조건·값을 넘긴다(§4) |
| B. `MenuItem`에 `checked`/`active` prop을 더해 "프롬프트 목록" 고정 라벨 + 체크 | 이 저장소 메뉴에 체크형 항목이 없다(§2.3). 공용 `MenuItem`(WorkspaceTabs도 쓴다 `:23`) 시그니처 변경 — 범위 밖 |
| C. 우클릭 대신 pane 헤더 버튼만 살리기(A1) | A1은 hover 오버레이라 발견성이 낮고 모아보기 별도 창의 요구 2("셀 우클릭 → 히스토리")를 못 채운다. A2는 A1과 별개로 필요 |

**A 채택.** `ChipMenu`의 조건 `shown && cell.kind === "terminal"`은 **컨테이너**(:751-797)가 판정해 `onTogglePrompt`를
넘기거나 `undefined`로 둔다 — `onFloat`/`onCloseCell`과 같은 관례(§2.1). 숨김 셀에서 켜도 모아보기 안에서는 보이는
변화가 없고(컬럼은 셀 본문 안), 브라우저 셀에는 프롬프트 기록이 없다.

### 3.2 하단 클램프 — 상수를 실측값으로 재조정

| 대안 | 평가 |
|---|---|
| **a. 상수 유지, 값만 실높이로 교정 + 유도식 주석** (채택) | 변경 2글자×2. 유도식(항목 n × 31.5 + 구분선 k × 8.67 + 9.3)을 주석으로 남겨 다음에 항목이 늘 때 갱신 지점을 알린다. 창이 메뉴보다 낮은 극단(innerHeight < 448)은 기존과 같이 위쪽이 잘린다 — 최소 창 높이보다 낮은 값이라 수용 |
| b. `ChangesPanel` 식 절반 뒤집기(`y > innerHeight/2 ? bottom : top`) | 상수는 없어지지만 PaneMenu 445px가 창 절반(450 @ 900px)과 거의 같다 — 900px 미만 창에서는 어느 쪽으로도 잘린다. a가 낮은 창에 더 강하다 |
| c. `ref` + `useLayoutEffect`로 실높이 측정 후 클램프 | 영영 낡지 않지만 메뉴 2곳에 5줄씩. 항목 수가 또 바뀌면 그때 이걸로 간다(§6 ponytail 주석) |

### 3.3 상위 설계와의 차이

| 항목 | 상위 설계 §2.1 | 이 문서 | 이유 |
|---|---|---|---|
| `PaneMenu` 하단 클램프 | `innerHeight - 270` | **`innerHeight - 448`** | 실측 413.3px + 31.5 = 444.8(DPR 1.5) / 446.5(DPR 1). 270은 현재 값 240의 +30일 뿐, 현재 값 자체가 173px 부족하다(§2.4) |
| `ChipMenu` 하단 클램프 | `innerHeight - 240` | **`innerHeight - 248`** | 계산 240.2(DPR 1.5) / 241.5(DPR 1) — 240이면 0.2~1.5px 넘친다. 8 단위 올림으로 PaneMenu와 같은 규칙 |
| 그 외(위치·조건·라벨·아이콘) | — | 동일 | — |

### 3.4 만들지 않는 것

- 단축키 — 요구에 없다. 필요하면 `GlobalShortcuts`(`KeyboardShortcuts.tsx:15`)에 1항목이지만 xterm 화이트리스트 판단이 따로 필요하다.
- 숨김 셀 칩 메뉴·브라우저 셀 메뉴의 항목 — §3.1.
- 창 단위 마스터 토글을 메뉴에 — 플로팅 타이틀바(A3)와 메인/별도 창 헤더의 `PromptHistoryButton`이 그 역할.
- `__gpv.promptHistory` 노출 — e2e는 DOM·localStorage로 충분(§2.5). 스토어 값을 직접 봐야 하는 단언이 생기면
  `main.tsx:50-55`에 1줄.
- `MenuItem` 확장(체크·활성 상태) — §3.1 B.

## 4. 계약(타입·액션·코드 스케치)

Tauri 커맨드/이벤트/Rust 변경 **없음**. 스토어 변경 없음(`togglePanel`·`openPanels` 그대로).

```tsx
// src/components/workspace/TerminalPane.tsx — PaneMenu 안(:179 `const ts = useTerminals()` 다음)
import { …, History, … } from "lucide-react";                    // :1-12 import 목록에 추가 — 알파벳순으로 :4 ExternalLink와 :5 LayoutGrid 사이(+1줄)
const promptOpen = usePromptHistory((s) => !!s.openPanels[paneId]); // PromptLogButton(TermSessionControls.tsx:144)·TerminalPane(:55)과 같은 셀렉터
const togglePanel = usePromptHistory((s) => s.togglePanel);

// 마지막 그룹 — '패널 최대화(해제)'(:259-263) 다음, '새 창으로 분리 (Float)'(:264) 앞
<MenuItem
  icon={<History size={14} />}
  label={promptOpen ? "프롬프트 목록 닫기" : "프롬프트 목록 열기"}
  onClick={run(() => togglePanel(paneId))}
/>

// 컨테이너(:200-203) — 하단 클램프. 실높이 = 항목 13 × 31.5 + 구분선 3 × 8.67 + 패딩·테두리 9.3 ≈ 445 → 8 단위 올림
top: Math.min(y, window.innerHeight - 448),
```

```tsx
// src/components/AggregateTerminals.tsx — 컨테이너(:307 chipMenu 상태 다음)
import { …, History, … } from "lucide-react";                    // :1-16 import 목록에 추가 — :7 Grid2x2와 :8 Layers 사이(+1줄; 27이 :2-3 사이에 넣는 Columns3와 같은 블록)
const togglePanel = usePromptHistory((s) => s.togglePanel);
// 열린 메뉴의 셀만 구독 — openPanels 전체를 구독하면 토글마다 그리드 컨테이너가 리렌더된다.
const chipPromptOpen = usePromptHistory((s) => (chipMenu ? !!s.openPanels[chipMenu.cell.id] : false));

// ChipMenu 호출(:751-797) — onFloat/onCloseCell 조건부 관례와 같게. 숨김 셀·브라우저 셀엔 undefined.
<ChipMenu
  …
  promptOpen={chipPromptOpen}
  onTogglePrompt={
    selected.has(chipMenu.cell.id) && chipMenu.cell.kind === "terminal"
      ? () => togglePanel(chipMenu.cell.id)
      : undefined
  }
/>

// ChipMenu props(:806-830)
promptOpen?: boolean;          // onTogglePrompt가 있을 때만 의미
onTogglePrompt?: () => void;   // 없으면 항목 자체를 그리지 않는다(onFloat 관례)

// '확대해서 보기/확대 해제'(:866-870) 다음, optional 그룹 구분선(:871) 앞
{onTogglePrompt && (
  <MenuItem
    icon={<History size={14} />}
    label={promptOpen ? "프롬프트 목록 닫기" : "프롬프트 목록 열기"}
    onClick={run(onTogglePrompt)}
  />
)}

// 컨테이너(:850-853) — 헤더 24.5 + 항목 6 × 31.5 + 구분선 2 × 8.67 + 9.3 ≈ 240 → 8 단위 올림
top: Math.min(y, window.innerHeight - 248),
```

`MenuItem` 시그니처는 그대로 쓴다 — `{ icon: ReactNode; label: string; hint?: string; danger?: boolean; onClick: () => void }`
(`TerminalPane.tsx:281-293`). 별도 창(`IS_AGGREGATE_WINDOW`)에서도 `togglePanel`은 위임 없이 직접 부른다 — 이 스토어는
창마다 독립이고 `localStorage` write-through + `storage` 이벤트로 맞춰지므로(`promptHistory.ts:70-79, 213-223`)
`terminals://cmd` 같은 위임 경로가 필요 없다.

## 5. 단계(구현 순서)

**선행/후행 문서**: `TerminalPane.tsx`는 **23(A1) → 24** — 23이 `:99-118`(20줄)과 `:52-53`(2줄)을 지우면 이 문서의
`PaneMenu` 줄번호는 **22줄 앞**으로 밀린다(`:27`·`:87`은 같은 줄 수의 치환): `PaneMenu` :164 → :142, `const ts` :179 → :157,
컨테이너 :198-206 → :176-184(클램프 :202 → :180), '패널 최대화' :259-263 → :237-241, '새 창으로 분리' :264 → :242,
`MenuItem` :281-293 → :259-271. 앵커는 라벨 문자열·심볼로 잡는다. 23이 지우는 줄은 이 문서가 앵커로 쓰지 않는다.
24의 `promptOpen` 구독은 `PaneMenu` 함수 **안**이라 TerminalPane의 `promptOpen`(`:55`)과 스코프가 달라 이름 충돌이 없다.
`AggregateTerminals.tsx`는 **24 → 27(C2) → 28(D1)** 순서로 순차 납품 — 같은 파일 동시 작업 금지. 이 문서가 넣는 줄
(import 1 · 컨테이너 구독 3 · `ChipMenu` 호출 prop 6 · props 2 · 항목 7 ≈ 19줄)만큼 27·28의 앵커가 뒤로 밀린다 —
그 문서들의 §5에 밀림 폭을 적어 두었다.

1. **TerminalPane.tsx** — `History` import, `PaneMenu` 안 구독 2줄, `MenuItem` 1개, 클램프 448. `npx tsc --noEmit -p .`.
2. **AggregateTerminals.tsx** — `History` import, 컨테이너 구독 2줄, `ChipMenu` props 2개 + 항목 + 호출처 2 prop, 클램프 248.
3. **e2e 14** — §7의 `#2c`(PaneMenu)와 `#11a`(ChipMenu) 단언 삽입. `paneId`는 23(`#2a`)이 함수 스코프에 잡아 둔 것을 쓴다(재선언 금지).
4. **실기**(§7) — 메인·플로팅·모아보기 메인 안·별도 창 × 하단 우클릭. 정적 통과만으로 끝내지 않는다.

규모: **S** — 2파일 ~30 LOC(+27/−2) + e2e ~60 LOC.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 클램프 상수 재발 | 상수가 한 번 낡았다(§2.4). 다음에 항목이 늘면 또 잘린다 | 유도식 주석(§4) + e2e가 **창 바닥 우클릭 시 메뉴 바닥 ≤ innerHeight**를 단언(§7) — 항목을 더하고 상수를 안 올리면 실패한다. 세 번째 변경부터는 §3.2 c(ref 실측)로 전환 — 코드에 `// ponytail: 상수 클램프 — 항목이 또 늘면 ref 실측으로` |
| 라벨 텍스트 결합 | e2e가 "프롬프트 목록 열기/닫기" 문자열로 항목을 찾는다 | 기존 '4분할' 단언과 같은 수준의 결합. 라벨을 바꾸면 e2e도 함께 |
| 숨김 셀에서 항목이 없어 "왜 없나" | 칩 우클릭으로 켜도 모아보기 안에선 변화가 안 보인다는 판단(상위 설계) | '그리드에 표시' 뒤 다시 우클릭하면 나타난다 — 자연스러운 동선. 실기에서 혼란이 크면 비활성 항목(`aria-disabled`)으로 재검토 |
| 컨테이너 리렌더 | `openPanels` 전체 구독 시 토글마다 그리드 리렌더 | `chipMenu` 셀만 보는 좁은 셀렉터(§4) — 메뉴가 열린 동안만 값이 바뀔 수 있다 |
| 다른 창이 먼저 토글 | 메뉴가 열린 채 다른 창에서 같은 세션을 토글하면 라벨이 어긋날 수 있다 | 둘 다 스토어 구독(PaneMenu 안·컨테이너)이라 `storage` 이벤트로 라벨이 즉시 따라온다. `togglePanel`은 현재 값 기준 반전(:165)이라 최종 상태도 일관 |
| 브라우저 pane 위 가림 | 메뉴가 31.5px 길어져 이웃 브라우저 webview 위로 더 나갈 수 있다 | 두 메뉴 모두 이미 `useOccludesWebview` 점유 등록(:58, :326). 변경 없음 |
| A1(23)과의 줄번호 충돌 | 23이 TerminalPane 위쪽 20줄을 지운다 | §5 순서 고정 + 앵커는 라벨 |
| e2e 중단 시 셀 숨김 상태 잔존 | `#11a`가 칩을 눌러 숨긴 뒤 예외로 빠지면 셀이 숨은 채 남는다 | `try/finally`에서 `ring-1` 없는 칩을 다시 클릭. 열어 둔 컬럼은 `closeTab → dropPane → clear`(`terminals.ts:12-16`)가 지운다 |

## 7. 검증

### 7.1 e2e 14 추가 단언

**`#2c` — `#2b`(PTY 크기 복구, :152-220) 뒤, 우클릭→'4분할'(:222) 앞에 삽입** — 이 시점엔 `.xterm`이 하나뿐이라 대상이
유일하다. `paneId`는 23(`#2a`)이 `:46`/`:133-135`에서 `openTerminal` 반환값으로 잡아 둔 **함수 스코프 변수**를 그대로 쓴다 —
여기서 `const paneId`를 재선언하면 try 블록 스코프가 되어 앞의 `#2a`가 TDZ ReferenceError로 죽는다. 26의 `#2d`(호버 카드)는
이 블록 **뒤**·'4분할' 앞에 들어온다(같은 `paneId`).

```js
    // ── #2c 우클릭 메뉴 → 프롬프트 목록 열기/닫기 (태스크 24) ──
    // paneId는 23이 :46/:133-135에서 잡은 함수 스코프 변수(openTerminal 반환 { tabId, paneId }).
    // 새 탭의 layout은 leaf 하나(stores/terminals.ts:313)라 그 값이 곧 프롬프트 스토어의 termId.
    // 재선언 금지 — try 스코프에 `const paneId`를 두면 앞의 #2a(23)가 TDZ ReferenceError.
    // openPanels는 __gpv에 없다 — 산출물(영속 키·PromptSidePanel DOM)로 관측한다(promptHistory.ts:172, TerminalPane.tsx:121).
    const panelPersisted = () =>
      cdp.eval(`JSON.parse(localStorage.getItem('gp:prompt-panel-open')||'{}')[${J(paneId)}] === true`);
    const panelCount = () => cdp.eval(`document.querySelectorAll('button[title="프롬프트 목록 닫기"]').length`);
    const MENU = `document.querySelector('div.fixed.z-50.min-w-52')`;
    const menuLabels = () =>
      cdp.eval(`(()=>{ const m=${MENU}; return m ? Array.from(m.querySelectorAll('button')).map(b=>b.textContent.trim()) : null; })()`);
    const clickMenu = (label) =>
      cdp.eval(`(()=>{ const m=${MENU}; const b = m && Array.from(m.querySelectorAll('button')).find(el => (el.textContent||'').trim() === ${J(label)}); if (b) { b.click(); return true; } return false; })()`);
    const esc = () => cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    // .xterm에 contextmenu → TerminalPane onContextMenu(:91-95)가 PaneMenu를 연다(#2의 '4분할'과 같은 경로).
    const rightClickXterm = (yExpr = "r.top+40") =>
      cdp.eval(`(()=>{ const x=document.querySelector('.xterm'); if(!x) return false; const r=x.getBoundingClientRect();
        x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+40,clientY:${yExpr}})); return true; })()`);

    const dom0 = await panelCount();
    r.check("프롬프트 컬럼 초기 닫힘(전제)", !!paneId && (await panelPersisted()) === false, `pane=${String(paneId).slice(0, 8)}`);
    await rightClickXterm();
    await sleep(300);
    const labels1 = await menuLabels();
    const iMax = labels1?.findIndex((l) => /^패널 최대화/.test(l)) ?? -1;
    const iPrompt = labels1?.indexOf("프롬프트 목록 열기") ?? -1;
    const iFloat = labels1?.findIndex((l) => /새 창으로 분리/.test(l)) ?? -1;
    r.check("PaneMenu: '프롬프트 목록 열기' — '패널 최대화' 다음·'새 창으로 분리' 앞", iMax >= 0 && iPrompt === iMax + 1 && iFloat === iPrompt + 1, J(labels1));
    const clicked1 = await clickMenu("프롬프트 목록 열기");
    const persisted1 = await poll(panelPersisted, (v) => v === true, 10, 200);
    const dom1 = await poll(panelCount, (n) => n === dom0 + 1, 10, 200);
    r.check("클릭 → openPanels[paneId] 영속 + PromptSidePanel 렌더", clicked1 && persisted1 === true && dom1 === dom0 + 1, `ls=${persisted1} dom=${dom0}→${dom1}`);
    await rightClickXterm();
    await sleep(300);
    const labels2 = await menuLabels();
    r.check("PaneMenu: 열린 뒤 라벨 '프롬프트 목록 닫기'", !!labels2 && labels2.includes("프롬프트 목록 닫기") && !labels2.includes("프롬프트 목록 열기"));
    const clicked2 = await clickMenu("프롬프트 목록 닫기");
    const persisted2 = await poll(panelPersisted, (v) => v === false, 10, 200);
    const dom2 = await poll(panelCount, (n) => n === dom0, 10, 200);
    r.check("클릭 → 컬럼 닫힘(영속 키 제거 + DOM 제거)", clicked2 && persisted2 === false && dom2 === dom0);
    // 하단 클램프 — 창 바닥에서 우클릭해도 메뉴 바닥이 창 안에 있다(항목 13개 ≈ 445px, 상수 448).
    await rightClickXterm("window.innerHeight-4");
    await sleep(300);
    const clamp = await cdp.eval(`(()=>{ const m=${MENU}; if(!m) return null; const r=m.getBoundingClientRect(); return { h: r.height, bottom: r.bottom, ih: window.innerHeight }; })()`);
    r.check("PaneMenu 하단 클램프: 메뉴 바닥 ≤ innerHeight", !!clamp && clamp.bottom <= clamp.ih + 0.5, J(clamp));
    await esc();
    await sleep(150);
```

**`#11a` — 모아보기 그리드 단언(:259-262) 뒤, '닫기'(:263) 앞에 삽입**(`#11`과 `#11b` 사이라 `a`; 27의 자동배치 단언은
`#11c` 뒤 `#11d`, 28의 프로젝트 색은 `#12`) — 이 시점 그리드에는 픽스처 탭의 셀들이 전부
표시 중이다(초기 선택 규칙 `AggregateTerminals.tsx:221-226`: 활동(working/done) 있는 터미널이 없으면 전부 선택).

```js
    // ── #11a ChipMenu → 프롬프트 목록 (태스크 24) — 표시 중 터미널 셀에만 ──
    const rightClickCell = () =>
      cdp.eval(`(()=>{ const g=document.querySelector('[style*="grid-template-columns"]'); const x=g&&g.querySelector('.xterm'); if(!x) return false;
        const r=x.getBoundingClientRect(); x.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+30,clientY:r.top+30})); return true; })()`);
    const cell0 = await panelCount();
    await rightClickCell();
    await sleep(300);
    const cl1 = await menuLabels();
    const iZoom = cl1?.findIndex((l) => /^확대/.test(l)) ?? -1;
    r.check("ChipMenu(표시 셀): '프롬프트 목록 열기' — '확대해서 보기' 다음", iZoom >= 0 && cl1[iZoom + 1] === "프롬프트 목록 열기", J(cl1));
    const cClick1 = await clickMenu("프롬프트 목록 열기");
    const cDom1 = await poll(panelCount, (n) => n === cell0 + 1, 10, 200);
    r.check("셀 메뉴 클릭 → 셀 안 PromptSidePanel", cClick1 && cDom1 === cell0 + 1, `dom ${cell0}→${cDom1}`);
    await rightClickCell();
    await sleep(300);
    const cl2 = await menuLabels();
    const cClick2 = await clickMenu("프롬프트 목록 닫기");
    const cDom2 = await poll(panelCount, (n) => n === cell0, 10, 200);
    r.check("셀 메뉴: 라벨 '프롬프트 목록 닫기' → 닫힘", !!cl2 && cl2.includes("프롬프트 목록 닫기") && cClick2 && cDom2 === cell0);
    // 숨김 셀의 칩 우클릭 → 항목 없음. 칩은 title "(우클릭: 메뉴)"(Chip :937); 탭 모으기 모드면 개별 칩이 없어 스킵.
    const CHIP = `document.querySelector('button[title*="우클릭: 메뉴"]')`;
    const hasChip = await cdp.eval(`!!${CHIP}`);
    if (!hasChip) {
      r.skip("숨김 셀 칩 메뉴", "개별 칩 없음(탭 모으기 모드) — 스킵");
    } else {
      await cdp.eval(`${CHIP}.click()`); // 첫 칩 숨김(all은 이름순 정렬이라 첫 칩은 안정)
      await sleep(300);
      try {
        await cdp.eval(`(()=>{ const c=${CHIP}; const r=c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:r.left+4,clientY:r.bottom+2})); })()`);
        await sleep(300);
        const hl = await menuLabels();
        r.check("숨김 셀 칩 메뉴: '그리드에 표시'는 있고 프롬프트 목록 항목은 없음", !!hl && hl.includes("그리드에 표시") && !hl.some((l) => l.startsWith("프롬프트 목록")), J(hl));
        await esc();
        await sleep(150);
      } finally {
        await cdp.eval(`(()=>{ const c=${CHIP}; if (c && !c.classList.contains('ring-1')) c.click(); })()`); // 다시 표시
        await sleep(300);
      }
    }
```

`#2c`가 `#11a`보다 먼저 돌아 헬퍼(`panelCount`·`menuLabels`·`clickMenu`·`esc`)를 공유한다(둘 다 try 블록 최상위 스코프). 정리는 기존 `finally`로 충분 —
탭을 닫으면 `dropPane → clear`가 열림 상태를 지운다(§2.2).

### 7.2 실기(dev 디버그 앱, `npm run dev:app`)

정적 검증(tsc·e2e)만으로 통과시키지 않는다. 관측은 DOM·`localStorage`·계산 스타일로 한다.

1. **메인 워크스페이스, 창 바닥 우클릭** — 터미널 pane 아래쪽(`innerHeight - 450` 아래)에서 우클릭. 13항목 전부 보이고
   '패널 닫기'가 잘리지 않는다. CDP: `document.querySelector('div.fixed.z-50.min-w-52').getBoundingClientRect().bottom
   <= innerHeight`. 창 높이를 700px로 줄여 반복(클램프가 창 크기에 따라 움직이는지).
2. **열기/닫기** — '프롬프트 목록 열기' 클릭 → xterm 오른쪽에 컬럼(`w-[15%] min-w-[110px]`, 헤더 "프롬프트 N")이 붙고
   xterm이 좁아진다(PTY refit — `$Host.UI.RawUI.WindowSize.Width`가 줄어드는지, e2e 14 `#2b` 방식). 다시 우클릭 → 라벨
   '프롬프트 목록 닫기'. `localStorage['gp:prompt-panel-open']`에 paneId가 들고 나는지. (23 이후) hover 오버레이의
   `PromptLogButton`이 `text-accent`로 켜지는지.
3. **플로팅 창** — 같은 pane을 '새 창으로 분리' → 플로팅 창에서 우클릭 → 같은 항목·같은 동작. 토글 뒤 **메인 창**의
   `localStorage['gp:prompt-panel-open']`에도 반영됐는지(`storage` 동기 — 플로팅 창 CDP는 `lib/cdp.mjs`의 `connect()`가
   `label === "main"`만 고르므로(`export async function connect` — 워킹트리 스냅샷 `:206-250`, 라벨 비교 `:218`; 파일이 다른 세션
   편집 중(M)이라 줄은 심볼로 찾는다)
   실기에서는 그 조건을 `float-` 접두로 바꾼 임시 사본으로 붙인다. 25(A3)가 `listTargets`·`attach`·`LABEL_EXPR`를 export하면
   (25 §3.5 ③) 그쪽 `attachFloat`(25 §7.1)로 대신한다).
4. **모아보기 메인 안** — 터미널 셀 본문 우클릭 → '확대해서 보기' 다음에 항목. 클릭 → 셀 안 컬럼 + 셀 헤더
   `PromptLogButton`(:1200) 강조. 칩을 눌러 셀을 숨긴 뒤 그 칩 우클릭 → 항목 없음, '그리드에 표시' 뒤 다시 우클릭 →
   항목 있음. 브라우저 셀 우클릭 → 항목 없음. 묶음 드롭다운 안 칩 우클릭 → 표시 중 터미널이면 항목 있음.
5. **모아보기 별도 창**(요구 2) — 별도 창으로 띄운 뒤 셀 우클릭 → 항목 → 클릭 → 그 창 셀에 컬럼. 메인 창을 다시 열면
   같은 세션 pane에 컬럼이 열려 있다(세션 단위 상태).
6. **ChipMenu 실높이 확정** — §2.4의 ChipMenu 값은 계산값이다. 메인 창 모아보기에서 항목이 최다인 메뉴(터미널 셀:
   숨기기·확대·프롬프트·새 터미널·Float·닫기 = 6개)를 열고 `getBoundingClientRect().height`를 읽어 **≤ 248**인지 확인.
   창 바닥 우클릭으로 바닥 ≤ innerHeight도 확인. Windows 배율 100%·150% 각 1회(DPR별 테두리 폭 차이).
7. **회귀** — 기존 항목(분할·최대화·Float·닫기, 숨기기·확대·새 터미널) 동작 불변, Escape·바깥 클릭 닫힘 불변.

## 8. 구현 결과 · 실행·관측 결과(2026-09-03)

§5 단계 1~4 전부 완료. `npx tsc --noEmit -p .` **exit 0**, e2e 14 **55 pass / 0 fail / 2 skip**,
§7.2 실기 1~7 **CDP 실측 완료**(§8.2). Rust 변경 0, 신규 컴포넌트·스토어 액션 0.

| 파일 | 변경 |
|---|---|
| `src/components/workspace/TerminalPane.tsx` | +15/−1 — `History` import(:4 ExternalLink 다음), `PaneMenu` 안 `promptOpen`·`togglePanel` 구독 2줄, `MenuItem` 1개('패널 최대화' 다음·'새 창으로 분리' 앞), 하단 클램프 `Math.min(y, ih−240)` → `Math.max(0, Math.min(y, ih−448))` + 유도식·`max(0,…)` 이유·ponytail 주석 |
| `src/components/AggregateTerminals.tsx` | +34/−1 — `History` import(Grid2x2와 Layers 사이), 컨테이너 `togglePanel`·`chipPromptOpen`(열린 메뉴 셀만 구독), `ChipMenu` 호출에 `promptOpen`·`onTogglePrompt`(조건 `selected.has(id) && kind==="terminal"`), props 2개 + 항목('확대해서 보기' 다음), 클램프 `Math.min(y, ih−200)` → `Math.max(0, Math.min(y, ih−248))` + 주석 |
| `tests/e2e/suites/14-frontend-dom.mjs` | +88 — `#2c`(48줄, `#2b` 뒤·'4분할' 앞) · `#11a`(40줄, '모아보기: 그리드에 터미널 표시' 뒤·'닫기' 앞). `paneId` 재선언 없음(23이 잡은 함수 스코프 변수 사용), `#2c`의 헬퍼(`panelCount`·`menuLabels`·`clickMenu`·`esc`)를 `#11a`가 공유. 추가로 **`VIS_XTERM` 공용 표현식**(try 스코프 위, 보이는 첫 `.xterm`)을 두고 `#2a`(hit-test·`panelState`)·`#2c`(`rightClickXterm`)·'4분할' 블록을 그것으로 통일 — 4분할 블록에만 있던 인라인 필터를 승격했다 |

항목 수 확인(클램프 상수의 전제): PaneMenu **13개**(복사·붙여넣기 / 분할 4 / 그리드 3 / 최대화·**프롬프트**·Float·닫기), ChipMenu 최대 **6개**(숨기기·확대·**프롬프트**·새 터미널·Float·닫기).

### 8.1 설계 대비 이탈

| # | 이탈 | 이유 |
|---|---|---|
| 1 | 클램프에 `Math.max(0, …)` 추가(§4 스케치는 `Math.min`만) — 두 메뉴 모두 | 플로팅 창은 `min_inner_size` 360×240이라 `innerHeight`가 448/248보다 **낮을 수 있다.** 그러면 `min`만으로는 `top`이 음수가 되어 위쪽 항목(복사·붙여넣기)이 화면 밖으로 잘린다. 실측(§8.2-1b): 뷰포트 300px에서 `max(0,…)` 없이는 `top = −148`, 있으면 `top = 0`으로 첫 항목이 보인다. §3.2-a가 "낮은 창은 위쪽이 잘린다"를 수용한다고 적었으나 **아래도 같이 잘리는** 상태였다 |
| 2 | (형식) `ChipMenu` props에 한 줄 JSDoc 2개 추가(`promptOpen`/`onTogglePrompt`) | 파일의 기존 prop 주석 밀도와 같은 수준. 동작 영향 없음 |
| 3 | e2e에 `VIS_XTERM` 공용 표현식 도입(§7.1 스니펫엔 없다) | `#2a`·`#2c`는 문서 순서 첫 `.xterm`을 잡았는데 **비활성 탭도 `hidden`으로 마운트된 채 남는다**(`WorkspaceTabs.tsx`). 4분할 블록만 이미 "레이아웃 상자가 있는 것"으로 걸러 두고 있었다 — 같은 필터를 한 곳에 두고 셋이 공유한다 |

### 8.2 실기 관측값 (dev 앱, CDP 29222 · 메인 창 2560×1392 · DPR 1.5)

관측은 실제 포인터(`Input.dispatchMouseEvent` right/left)와 `Input.dispatchKeyEvent`로 했다.

**1) 하단 클램프 — PaneMenu 실높이 = 444.83px (13항목, DPR 1.5).** 상수 448, 여유 **3.17px**.
§2.4의 유도값(413.33 + 31.5 = 444.83)과 **소수점까지 일치**한다. pane 바닥에서 우클릭한 결과:

| innerHeight | 클릭 y | `top` | `bottom` | 13항목 전부 화면 안 |
|---|---|---|---|---|
| 1392 (최대화) | 1319 | 944 | 1388.83 | ✅ |
| 700 | 629 | 252 | 696.83 | ✅ |
| 500 | 430 | 52 | 496.83 | ✅ |
| 430 | 369 | **0** | 444.83 | 첫 항목 '복사' 보임 · 마지막 '패널 닫기'만 잘림 |
| 360 | 292 | **0** | 444.83 | 〃 |
| 300 | 231 | **0** | 444.83 | 〃 |

`ih ≥ 448`이면 정확히 `ih − 448`로 붙고, 그 아래에서는 `max(0,…)`이 `top = 0`으로 고정해 **위쪽이 살아남는다**
(이탈 1). 700px 이하는 OS 창 리사이즈가 아니라 CDP `Emulation.setDeviceMetricsOverride` 뷰포트로 재현했다(§8.4).

**2) 열기/닫기 · PTY refit · 강조.** 메뉴 라벨 순서 실측 `[…, "패널 최대화"(9), "프롬프트 목록 열기"(10), "새 창으로 분리 (Float)"(11), "패널 닫기"(12)]`.
'프롬프트 목록 열기' 클릭 →

| 관측 | 값 |
|---|---|
| 컬럼 DOM | `flex w-[15%] min-w-[110px] shrink-0 flex-col border-l border-edge bg-panel text-[11px]`, 헤더 `프롬프트 0`, 폭 **271px** |
| xterm 폭 | 1809 → **1538px** |
| **PTY 크기(xterm cols)** | 244 → **207** (닫으면 **244로 복귀**) — ResizeObserver → `fitTerminal` → `term_resize` 경로가 실제로 돈다 |
| `PromptLogButton` | `… text-fg-dim` → `… bg-raised text-accent`, computed color `rgb(79, 180, 230)` |
| `gp:prompt-panel-open` | `false → true → false` |
| 클릭 직후 메뉴 | 닫힘(`run()`) |

재우클릭 시 라벨이 `프롬프트 목록 닫기` 하나로 바뀌고 `열기`는 없다.

**3) 플로팅 창 (`float-pool-1` claim, 900×600, ih 600).** '새 창으로 분리 (Float)'로 띄운 뒤 그 창 xterm 우클릭:
항목 **13개·메인과 동일한 순서**('패널 최대화' 다음이 '프롬프트 목록 열기'), 메뉴 높이 **444.83px**, 전부 화면 안.
클릭 → 그 창에 컬럼(헤더 `프롬프트 0`, `bg-raised text-accent`) + **메인 창 `gp:prompt-panel-open`이 `false → true`**.
재우클릭 라벨 반전 → '닫기' 클릭 → **메인 `false`**. `storage` 동기가 양방향으로 동작한다.

**4) 모아보기 메인 안.**

| 대상 | 항목(실측) | 프롬프트 항목 |
|---|---|---|
| 표시 중 터미널 셀(본문 우클릭) | `그리드에서 숨기기 · 확대해서 보기 · 프롬프트 목록 열기 · '…'에 새 터미널 열기 · 새 창으로 분리 (Float) · 터미널 닫기` (6개, **240.17px**) | ✅ '확대해서 보기' **바로 다음** |
| 표시 중 터미널 칩(우클릭) | 같은 6개 | ✅ |
| **숨김** 셀 칩(우클릭) | `그리드에 표시 · 확대해서 보기 · '…'에 새 터미널 열기 · 새 창으로 분리 (Float) · 터미널 닫기` (5개, 208.67px) | ❌ 없음 — 설계대로 |
| 다시 '그리드에 표시' 후 칩 | 6개로 복귀 | ✅ |
| **브라우저 셀**(본문 우클릭) | `그리드에서 숨기기 · 확대해서 보기 · '…'에 새 터미널 열기 · 브라우저 닫기` (4개, 177.17px) | ❌ 없음 — 설계대로 |
| **묶음 드롭다운** 안 칩(우클릭) | 6개 | ✅ |

클릭 → 그 셀 안에 컬럼(헤더 `프롬프트 0`, 폭 **110px** = `min-w-[110px]`) + **셀 헤더 `PromptLogButton`이 `bg-raised text-accent`**.

**5) 모아보기 별도 창(label `aggregate`, 1100×720).** 셀 우클릭 → 6항목·같은 순서, 높이 240.17px.
'프롬프트 목록 열기' 클릭 → 그 창 셀에 컬럼 + 그 창 `localStorage` 기록 + **메인 창 `gp:prompt-panel-open`이 `{}` → `{"299519f3…":true}`**.
세션 단위 상태 확인: 같은 경로(`usePromptHistory` setState = `storage` 리스너와 동일)로 켜면 **메인 워크스페이스 pane에도**
컬럼(헤더 `프롬프트 0`, 271px)이 그려지고 `PromptLogButton`이 `text-fg-dim → bg-raised text-accent`로 바뀐다.

**6) ChipMenu 실높이 확정 — 240.17px (6항목, DPR 1.5).** §2.4의 **계산값 240.2와 일치**. 상수 248, 여유 **7.83px**.
가장 아래 셀 바닥(y=1358)에서 우클릭 → `ih 1392`, `top 1144`(= 1392 − 248), `bottom 1384.17`, 6항목 전부 화면 안.
별도 창(ih 720)·묶음 드롭다운에서도 같은 240.17px. **DPR 1.0(배율 100%)은 미관측**(§8.4).

**7) 회귀.** 13항목 라벨·힌트 전부 그대로, Escape로 닫힘, 메뉴 바깥 클릭으로 닫힘, 항목 클릭 시 자동 닫힘.
e2e 14가 '4분할'(1→4) · Ctrl+W(4→3) · 모아보기 진입/닫기 · Ctrl+Shift+A · 새 터미널 · 자동배치 · 프로젝트 색까지 전부 통과.

**e2e 14 단독 실행**(`scratchpad/run-14.mjs`) — `55 pass / 0 fail / 2 skip`, exit 0. 이 태스크 블록의 결과:

```
✅ PaneMenu: '프롬프트 목록 열기' — '패널 최대화' 다음·'새 창으로 분리' 앞
✅ 클릭 → openPanels[paneId] 영속 + PromptSidePanel 렌더        — ls=true dom=0→1
✅ PaneMenu: 열린 뒤 라벨 '프롬프트 목록 닫기'
✅ 클릭 → 컬럼 닫힘(영속 키 제거 + DOM 제거)
✅ PaneMenu 하단 클램프: 메뉴 바닥 ≤ innerHeight  — {"h":444.83,"bottom":1388.83,"ih":1392}
✅ ChipMenu(표시 셀): '프롬프트 목록 열기' — '확대해서 보기' 다음
✅ 셀 메뉴 클릭 → 셀 안 PromptSidePanel                          — dom 0→1
✅ 셀 메뉴: 라벨 '프롬프트 목록 닫기' → 닫힘
⊘ 숨김 셀 칩 메뉴 — 개별 칩 없음(탭 모으기 모드) — 스킵          ← 실기 §8.2-4로 관측했다
```

나머지 skip 1건은 `#2b`(모아보기 반환 후 PTY 크기 복구 — "셸이 폭을 보고하지 않는다", 태스크 24 범위 밖).

### 8.3 검증 중 발견한 것

- **`#11a`의 '숨김 셀 칩 메뉴'는 기본 설정에서 항상 스킵된다.** 앱 기본값이 **탭 모으기 ON**(`aggregateGroupTabs`)이라
  칩 바에 개별 칩이 없고 묶음 칩만 있다 — `#11a`의 `hasChip` 가드가 그래서 걸린다. 스니펫대로 스킵 처리라 실패는 아니지만
  **이 단언은 사실상 죽어 있다.** 실기에서는 탭 모으기를 끄고 직접 관측해 통과를 확인했다(§8.2-4).
  살리려면 `#11a`가 '탭 모으기 끄기' 버튼(`title=/탭 모으기 끄기/`)을 눌러 개별 칩을 편 뒤 원복하면 된다 — 이 문서 범위 밖으로 두었다.
- **`Math.max(0, …)` 누락**(리뷰 지적) — §8.1-1에서 수정·실측 확인.
- **`#2a`·`#2c`가 보이지 않는 `.xterm`을 잡을 수 있었다**(리뷰 지적) — `VIS_XTERM`으로 통일. 검증 도중 창이
  144×18로 찌그러진 상태에서 실제로 이 결함이 드러났다(§8.4).
- 태스크 24 코드 쪽 결함은 발견하지 못했다.

### 8.4 관측하지 못한 것

| 항목 | 이유 |
|---|---|
| **Windows 배율 100%(DPR 1.0)에서의 두 메뉴 실높이** | 이 머신은 DPR 1.5 고정이고 배율 변경은 사용자 세션 설정이라 건드리지 않았다. §2.4의 DPR 1.0 계산값은 PaneMenu 446.5 / ChipMenu 241.5 — 상수 448/248 안이지만 **계산값**이다 |
| **낮은 창의 클램프를 OS 창 리사이즈로** | dev 앱 capabilities에 `core:window:allow-set-size`가 없어 IPC로 크기를 못 바꾸고, Win32 `SetWindowPos`는 이 창에서 높이가 65535로 튀었다. 대신 CDP `Emulation.setDeviceMetricsOverride`로 `innerHeight`를 바꿔 관측했다 — 클램프가 읽는 값이 정확히 `window.innerHeight`라 등가지만, **OS 창 자체를 줄인 것은 아니다** |
| **§7.2-5의 "별도 창을 닫고 메인을 다시 열면" 순서 그대로** | 별도 창을 닫은 뒤 메인 활성 탭이 `viewer`로 되돌아가 그 pane이 렌더되지 않았다. 대신 ① 별도 창 토글 → 메인 `localStorage` 반영 ② 그 세션 상태 → 메인 워크스페이스 pane에 컬럼 렌더 를 **따로** 관측해 같은 결론에 도달했다(§8.2-5) |

**검증 환경 메모**: 시작 시 dev 메인 창의 웹뷰가 **144×18 CSS px**로 찌그러져 있어(OS 창은 1455×909) e2e 14가
14건 실패했다 — `.xterm`이 보이지 않고 `innerHeight=18`이라 클램프·Log 리사이즈 단언이 전부 무너진다.
`plugin:window|toggle_maximize`로 창을 최대화(2560×1392)한 뒤 전부 통과했다. **창은 최대화 상태로 남겨 두었다**
(원래의 144×18은 정상 상태가 아니다). 검증이 만든 임시 자원(터미널 탭 3개·브라우저 탭 1개·플로팅 창·별도 창·
`gp:prompt-panel-open` 항목)은 전부 정리했다 — 확인: `gp:prompt-panel-open = {}`, 터미널 탭 9개(시작과 동일), 브라우저 탭 0개.
