# 세션 히스토리 접근성 · 히스토리 툴팁 · 자동배치 모드 · 프로젝트 색 — 설계

> 상태: **구현 완료 · 검증 통과(미커밋)** (2026-09-03) · `/sc:design` 산출물 → 태스크 23~28(`DOCS/task/23~28-*.md`,
> 각 문서 구현 결과 절 참조) · 인덱스 `DOCS/task/00-INDEX.md` §7
>
> ⚠ **요구 5(프로젝트 색 = 태스크 D1·D2 → 28)의 산출물은 태스크 36이 대체했다**
> ([DOCS/task/36-project-color-32slot.md](task/36-project-color-32slot.md), 구현·검증 2026-09-03 · 이 주석 2026-09-04).
> 이 문서에서 `PROJECT_HUES` 12개 · `assignProjectHues` · `projectTint` · `useProjectHues` · `--proj-*` 5변수 ·
> `border-l-2 border-accent` 선택 표시를 다루는 서술(§0 요구 5행, §1.4, §2.4 D1·D2, §3 완료 기준, §4 변경 지점,
> §5 검증 D, §6 ⑧)은 **더는 코드에 존재하지 않는다.** 특히 §0·§1.4의 결론 "12색 팔레트에 프로젝트 27개 →
> 유일성 불가, 이름순 12개 단위로 중복 없음"은 **뒤집혔다** — 32슬롯에서 26개 전부 고유이고 6종 테마 전부에서
> 최소 ΔE00 7.02다. 나머지 요구 1~4의 서술은 유효하다. 본문은 그 시점의 기록으로 보존한다.
>
> **구현 결과 요약**: 여섯 태스크 전부 구현, `tsc` 통과, e2e 단독 스위트 13(27 pass)·14(60 pass)·19(38 pass), CDP 실기(메인·
> 플로팅·모아보기 별도 창, 실제 포인터) 통과. Rust 변경 0. 코드 리뷰(정확성·계약 2관점) 지적은 minor 3건뿐 — 전부 반영
> (플로팅 창 낮은 높이에서 메뉴 top 음수 → `Math.max(0, …)`, e2e의 `.xterm` 선택을 보이는 것으로 통일, `PROJECT_HUES` readonly).
> 검증이 드러낸 **후속 결함 1건**(태스크 23 §10): 병합 오버레이가 pane 루트 우상단에 있어 프롬프트 컬럼 헤더 X를 덮어 X 클릭이
> pane을 닫았다 → 오버레이를 xterm 호스트 안(컬럼 왼쪽)으로 이동해 수정·검증. **미해결**: e2e 14의 24번 단언("셀 메뉴 '프롬프트
> 목록 닫기' → 닫힘")이 간헐 실패(5회 중 2회, 메뉴 라벨이 '열기'로 남음) — 앱 결함/테스트 대상 선택 문제 미규명.
> 조사: 워크플로 5 에이전트(코드 사실 3갈래 + 초안 반박 2관점, CDP 실측 포함) — 결과는 §1에 근거로 인용.
> 요구 5는 추가 요청(같은 날)으로 §2.4에 덧붙였다.
>
> 요구 5건:
> 1. 모아보기 말고 **분리된 터미널 세션**(플로팅 창)에서도 히스토리를 켜고 끌 수 있어야 한다
> 2. **모아보기 float 모드**(별도 창)에서 터미널 세션 우클릭 → 히스토리 보기. 해당 창 우측 상단에
>    모아보기 터미널 셀의 우측 상단처럼 반영
> 3. **히스토리바**(프롬프트 컬럼) 항목 호버 시 입력 내용을 가독성 있게 보여주는 툴팁 UI
> 4. 자동배치에 **세로 컬럼 균등** 모드 추가 — 자동배치 호버 시 그리드 / 세로 컬럼 아이콘이 나오고
>    클릭하면 그 모드로 자동 배치
> 5. 좌측 **PROJECTS 사이드바**의 프로젝트 행마다 배경색을 다르게 — 배경색만 보고도 어떤 프로젝트인지
>    기억하고 알 수 있게
>
> 용어(사용자 어휘 → 코드): 히스토리 = 프롬프트 컬럼(`PromptSidePanel`, `promptHistory.openPanels`),
> 히스토리바 = 그 컬럼, 분리된 세션 = 플로팅 창(`float-*`, `FloatingTerminal.tsx`), 모아보기 float 모드 =
> 모아보기 별도 창(`aggregate`, `IS_AGGREGATE_WINDOW`). 요구 2의 "해당 창 우측 상단"은 플로팅 창을
> 가리킬 수도 있어, 아래 설계는 **두 창 모두**에서 같은 결과가 나오게 잡았다.

---

## 0. 결정 요약

| # | 요구 | 결론 | 근거 |
|---|---|---|---|
| 1 | 플로팅 세션 히스토리 토글 | **근본 결함이 있다 — 버튼은 이미 있는데 눌리지 않는다.** 터미널 pane 우상단 세션 컨트롤(테마·히스토리, `TerminalPane` z-10)이 같은 자리에 겹치는 `PaneControls` 오버레이(`PaneTree` z-30)에 완전히 가려진다. 두 오버레이를 **하나로 합치고**(PaneTree 오버레이에 테마·히스토리 버튼 편입, TerminalPane의 중복 클러스터 삭제) 플로팅 창 타이틀바에 창 단위 마스터 토글, 우클릭 메뉴에 세션 토글, 플로팅 창에 토스트 호스트를 추가한다 | CDP 실측(§1.1): 클러스터 4버튼 중심의 `elementFromPoint`가 전부 PaneControls 버튼. 메인 워크스페이스도 같은 결함 |
| 2 | 별도 창 셀 우클릭 → 히스토리 | `ChipMenu`에 "프롬프트 목록 열기/닫기"(표시 중인 터미널 셀에만). 셀 헤더 `PromptLogButton`은 이미 항상 표시되고 상태를 반영한다. 메뉴 하단 클램프 상수 200 → 240 | 셀 헤더는 hover 조건 없이 상시 표시(§1.1) |
| 3 | 히스토리 툴팁 | native `title` → **비상호작용 호버 카드**(`pointer-events-none`, fixed z-50, 항목 왼쪽). 리스트 단위 호버 상태(항목 간 이동은 즉시 전환, 최초만 150ms 지연), 절대시각 + 줄·글자수 헤더, monospace pre-wrap 본문, 30줄 상한 + "외 N줄" 푸터, "클릭하면 복사". Escape·스크롤 없음 | 상호작용 카드는 "leave 즉시 숨김"과 양립 불가 — 카드 위로 포인터가 가는 순간 깜빡임 루프(§1.2). 비상호작용 fixed 카드 선례 `DragGhost` |
| 4 | 자동배치 모드 | `useUi.aggregateLayout: "grid" \| "columns"`(영속). columns = `cols = min(n, 4)`. 자동배치 버튼 hover → 아이콘 2개 팝오버(Grid2x2 그리드 / Columns3 세로 컬럼), 아이콘 클릭 = 모드 설정 + 그 모드로 균등, 메인 버튼 클릭 = 현재 모드로 균등(기존). `disabled` 제거(`aria-disabled`), 팝오버는 점유 등록, 트랙 키는 `n${n}` 유지 | React 19는 disabled 버튼의 onMouseEnter를 발화시키지 않는다(§1.3). n≥5의 1행 배치는 셀 폭이 MIN_W 240 아래로 떨어진다 |
| 5 | 사이드바 프로젝트 배경색 | **모아보기의 색 배정을 공유 모듈로 뽑아 같은 색을 쓴다**(`lib/project-color.ts`: 팔레트·`assignProjectHues`·`projectTint` + `useProjectHues()`). 배정은 **등록된 전체 프로젝트**를 이름순으로 한 번 — 사이드바 행·모아보기 칩·셀 헤더가 한 프로젝트에 한 색. 행 배경은 CSS 변수(`--tint`)로 넣어 hover·선택 강조가 그대로 동작. 행 전용 알파(`--proj-a-row*`) 추가 | 색은 **기억**의 단서라 표면마다 달라지면 의미가 없다. 지금은 모아보기가 자기 부분집합만으로 배정해(§1.4) 사이드바와 어긋날 수 있다. 12색 팔레트에 프로젝트 27개 → 유일성은 불가, 이름순 12개 단위로 중복 없음 |

Rust 변경 0. 전부 프론트.

---

## 1. 현황(근거)

### 1.1 세션 컨트롤이 가려져 있다 (요구 1·2의 뿌리)

- 워크스페이스·플로팅 창은 같은 `PaneTreeRoot → LeafView → TerminalPane`을 그린다
  (`FloatingTerminal.tsx:225`, `PaneTree.tsx:117-123`).
- `TerminalPane.tsx:99-118`: 우상단 세션 클러스터 `absolute right-1 top-1 z-10`, 버튼 4개(테마·히스토리·
  최대화·닫기), `opacity-0 group-hover:opacity-100`.
- `PaneTree.tsx:124-126`: LeafView가 **형제로** `absolute right-1 top-1 z-30` 오버레이에 `PaneControls`
  (전환·우분할·하분할·최대화·닫기, 버튼 5개 `p-1` 13px ≈ 119px 폭)를 얹는다. 클러스터(≈ 76-90px)는
  같은 앵커·같은 hover 조건이고 더 좁다. 사이에 stacking context 없음.
- **실측**(CDP, 메인 창): controls `{l:477.7, w:118.3, z:30}` vs cluster `{l:513.8, w:82.2, z:10}`, 둘 다
  `right=596` → 클러스터 완전 피복. 클러스터 4버튼 중심 `elementFromPoint` = 전부 PaneControls 버튼.
  덧붙여 오버레이 위에 포인터가 있으면 `TerminalPane`의 `group` hover가 풀려 클러스터는 opacity-0.
- 결과: 프롬프트 컬럼이 **닫힌** 상태에서 세션 단위로 켤 방법이 없다(열린 뒤엔 컬럼 헤더 X로 닫힌다 —
  "닫기는 되고 열기는 안 되는" 비대칭). 클러스터 도입 01d29d9 이후 계속. 최대화·닫기는 두 오버레이가
  중복으로 갖고 있다.
- 우클릭 `PaneMenu`(`TerminalPane.tsx:207-275`)와 모아보기 `ChipMenu`(`AggregateTerminals.tsx:861-895`)
  모두 히스토리 항목이 없다.
- 컬럼 열림 상태는 세션(termId) 단위 스토어라 어느 창에서 켜든 같다(`promptHistory.ts:129,164-173`).
  플로팅 창은 `useTerminals`가 독립 로컬 스토어(`terminals.ts:27-37`)라 `PromptHistoryButton`을 그 창에
  그리면 대상은 **그 창의 pane**만이다. 입력 기록은 xterm을 소유한 창에서 캡처·RMW 영속되므로 플로팅 창
  세션도 기록된다(`terminal-engine.ts:78-82`, `promptHistory.ts:81-124`).
- 플로팅 창에는 `<Toasts />` 호스트가 없다(`App.tsx:195`, `AggregateWindow.tsx:49`, `SysMonitorWindow.tsx:570`
  만). 컬럼 항목 클릭의 복사 결과 토스트가 그 창에서만 무음이다.
- `PromptHistoryButton`의 title "(모아보기에서 표시)"는 컬럼이 워크스페이스 pane에도 열리는 지금은 낡았다.

### 1.2 툴팁

- 항목 툴팁은 native `title={`${e.text}\n\n클릭하면 복사`}`(`TermSessionControls.tsx:254`), 본문은
  `line-clamp-3`(:257). 재사용 가능한 커스텀 툴팁 컴포넌트는 없다.
- 비상호작용 fixed 카드 선례: `FileTreePanel.tsx:422-452` `DragGhost` — `pointer-events-none fixed z-50
  rounded-md border border-edge bg-panel px-2.5 py-1.5 text-xs shadow-xl`.
- fixed 팝오버 공통 규칙(§ 14곳 동일): z-50 · `useOccludesWebview` 등록 · 하드코딩 상수 클램프 · 세로
  뒤집기(`ChangesPanel.tsx:547-557`). 컬럼은 flex row의 **마지막(우측) 자식**이라 왼쪽이 자기 xterm이다 —
  카드를 왼쪽에 띄우는 배치가 맞다. 셀 래퍼가 `overflow-hidden`이라 카드는 fixed여야 한다.
- 기하: 별도 창 기본 1100px·2열이면 첫 열 항목 `left ≈ 460px`, 플로팅 창 900px 좌우 분할이면 ≈ 380px —
  폭 480 카드는 항목을 덮는다. 카드에 pointer-events가 있으면 항목 mouseleave → 숨김 → mouseenter →
  표시의 **깜빡임 루프**. `max-h + overflow-auto`도 "leave 즉시 숨김"과 양립 불가(스크롤바에 닿을 수 없다).
- Escape: xterm은 Escape를 막지 않아 `\x1b`가 PTY로 들어간다(`terminal-engine.ts:212-272`) — hover 카드에
  Escape 닫기를 달면 TUI(Claude Code 등)의 진행 중 턴을 끊는 footgun.
- 절대시각 포맷 유틸은 없다(`format.ts`: `relativeTime`은 일 단위 없음, `shortDate`는 시각 없음). 앱 내
  절대시각 선례는 인라인 `toLocaleString()` 2곳.

### 1.3 자동배치

- `cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4`, `rows = ceil(n/cols)`(`AggregateTerminals.tsx:336-338`).
  배치는 absolute+calc, 트랙 비율은 `aggregateTracks[shape]`, `shape = \`n${n}\``(:349). 저장값은 rows·
  rowLens 길이 검증 실패 시 **렌더에서만** 균등 폴백(:350-362), 스토어는 다음 드래그/evenTracks가 덮는다.
- `MIN_W=240`·`MIN_H=160`은 드래그 하한에만 쓰인다(:408,:415). 레이아웃은 폭을 검사하지 않는다.
- 자동배치 버튼(:519-528): `disabled={!canEven}`, hover 핸들러 없음. **React 19.2는 disabled 버튼의
  onMouseEnter 리스너를 호출하지 않는다**(`react-dom-client.development.js:3274-3305`).
- hover로 여는 팝오버 선례는 묶음 칩 드롭다운 하나 — 150ms 지연 닫기 타이머 + 언마운트 정리 +
  `useOccludesWebview(!!chipMenu || !!groupMenu)`(:316-326, :701-721).
- lucide-react 1.17.0 정식 export 확인: `Grid2x2`(현재 사용), `Columns3`, `Columns2`, `Rows3`, `LayoutGrid`
  (모아보기 정체성 아이콘으로 4곳 사용 중 — 모드 아이콘으로 쓰면 충돌).

### 1.4 프로젝트 색

- 색 배정은 `AggregateTerminals.tsx:55-95`에만 있다: `PROJECT_HUES` 12개(균등 분할이 아닌, 눈으로
  갈리는 지점만), `assignProjectHues(names)` = 이름 해시로 선호 슬롯 + 이미 쓰인 슬롯이면 다음 빈 슬롯으로
  밀기(한 바퀴 돌고 포기 → 12개를 넘으면 선호 슬롯 그대로라 중복이 몰릴 수 있다), `projectTint(hue,
  strong)` = `hsl(h 70% var(--proj-l) / var(--proj-a-on|off))`. 배정 대상은 **모아보기에 보이는 프로젝트만**
  (`:210`, 이름순 정렬 뒤) — 부분집합이 달라지면 같은 프로젝트의 색이 밀려 바뀔 수 있다.
- 명도·알파는 테마 종류별 CSS 변수(`styles.css:169-189`): 다크 `--proj-l 26% / on .92 / off .5`, 라이트
  `50% / .42 / .2`. 칩 위 글자는 text-fg로 고정해 대비를 지켰고(solarized-light에서 fg-muted가 3.5:1로
  AA 미달이었던 실측이 주석에 있다), 부제만 text-fg-dim.
- 사이드바 행(`ProjectItem.tsx:86-101`): `border-l-2` + 선택 시 `border-accent bg-selection`, 아니면
  `border-transparent hover:bg-raised`; 에이전트 활동은 `.ai-working`/`.ai-done`(background-**image**
  그라디언트 — background-color와 겹쳐 그려진다). 이름 text-fg(font-medium), 2·3행은 text-fg-muted/
  text-fg-dim. 행은 `ProjectList.tsx:398-410`에서 `memo` 컴포넌트로 렌더(콜백은 안정 참조).
- 사이드바 순서는 드래그 정렬·"변경 있는 프로젝트 위로" 정렬로 바뀐다(`projectSortByChanges`) —
  표시 순서를 색 배정 순서로 쓰면 정렬할 때마다 색이 섞인다.
- 등록 프로젝트는 27개(dev 데이터 기준) — 12색으로 유일 배정은 불가능하다.

---

## 2. 설계

### 2.1 요구 1·2 — 세션 히스토리 접근성 (A)

**A1. 오버레이 병합(근본 수정).** `PaneTree.tsx` LeafView의 터미널 분기 오버레이(:124-126) 하나만 남긴다:

```tsx
<div className="absolute right-1 top-1 z-30 flex items-center gap-0.5 rounded-md border border-edge bg-panel/95 p-0.5 opacity-0 shadow-lg transition-opacity group-hover/pane:opacity-100">
  <ThemeButton termId={leaf.paneId} />
  <PromptLogButton termId={leaf.paneId} />
  <span className="mx-0.5 h-3 w-px bg-edge" />
  {controls}
</div>
```

`TerminalPane.tsx:99-118`의 클러스터 div(테마·히스토리·**중복** 최대화·닫기)는 삭제하고 안 쓰게 된
import(`Maximize2`/`Minimize2`/`X`/`ThemeButton`/`PromptLogButton`)와 `closePaneAct`·`toggleMaximize`
셀렉터를 지운다(`maximized`는 PaneMenu에 넘기므로 유지). `{promptOpen && <PromptSidePanel/>}`는 그대로.
브라우저 분기(`paneControls`를 주소창에 넘김)는 무변경 — 테마·히스토리는 터미널 전용이다.

**A2. 우클릭 메뉴 — 세션 토글.** `PaneMenu`(워크스페이스·플로팅 공용)와 `ChipMenu`(모아보기 메인 안·별도
창 공용)에 같은 항목. 라벨은 이 저장소 토글 관례(현재 상태에 따른 **한 동사**)와 세션 단위 어휘
("프롬프트 목록" — `PromptLogButton`·패널 X와 동일)를 따른다:

```tsx
const promptOpen = usePromptHistory((s) => !!s.openPanels[paneId]);
<MenuItem icon={<History size={14} />}
  label={promptOpen ? "프롬프트 목록 닫기" : "프롬프트 목록 열기"}
  onClick={run(() => togglePanel(paneId))} />
```

- `PaneMenu`: '패널 최대화' 다음, '새 창으로 분리' 앞. 하단 클램프 `innerHeight - 240` → `- 270`.
- `ChipMenu`: '확대해서 보기' 다음. **표시 중인 터미널 셀에만**(`shown && cell.kind === "terminal"`) —
  칩 우클릭으로 열린 메뉴에서 숨김 셀의 컬럼을 켜면 모아보기 안에선 아무 변화가 없다(컬럼은 셀 본문 안).
  클램프 `innerHeight - 200` → `- 240`. 셀 헤더 `PromptLogButton`(상시 표시)이 상태를 반영한다 — 요구 2의
  "우측 상단 반영"은 기존 동작.

**A3. 플로팅 창 타이틀바 마스터 토글 + 토스트.** `FloatingTerminal.tsx` `FloatTitleBar actions`에
`<PromptHistoryButton className="h-full shrink-0 px-2 text-[11px]" />`를 되돌리기 버튼 왼쪽에 둔다 —
그 창의 pane(분할 포함) 전체를 켜고 끈다(§1.1 로컬 스토어). 같은 루트 div에 `<Toasts />` 추가
(`AggregateWindow.tsx:49` 선례) — 복사 토스트와 되돌리기 실패도 표면화된다.
`PromptHistoryButton` title 문구 갱신: "전체 프롬프트 목록 펼치기 — 이 창의 모든 터미널 우측에 입력 목록을
엽니다" / "…접기 — … 닫습니다". 메인·별도 창·플로팅 세 곳에서 모두 참이 되는 문장이라 prop 추가 없음.

### 2.2 요구 3 — 히스토리 호버 카드 (B)

`PromptSidePanel` 내부 구현(공용 컴포넌트 없음 — 사용처가 하나다).

- **상태**: `hover: { id: string; rect: DOMRect } | null`(+ `hoverRef` 미러), `showTimer: useRef<number>()`.
  리스트 컨테이너 `onMouseLeave` → 타이머 clear + `setHover(null)`. 항목 `onMouseEnter` → 이미 열려 있으면
  **즉시 전환**, 아니면 150ms 후 표시(최초 1회만 지연 — 목록을 훑을 때 항목마다 기다리지 않는다). 언마운트
  cleanup에서 타이머 clear(컬럼은 다른 창의 storage 이벤트로 hover 중에도 사라질 수 있다).
- **렌더 가드**: `const entry = hover && list.find((e) => e.id === hover.id)` — 기록 지우기·트림·다른 창
  교체로 항목이 사라지면 카드도 사라진다.
- **항목의 `title` 제거**(native 툴팁과 이중 표시 방지). 헤더 버튼들의 title은 유지.
- **카드**(비상호작용):
  ```tsx
  const W = Math.max(240, Math.min(480, rect.left - 16));          // 항목을 덮어도 pointer-events-none이라 무해
  const left = Math.max(8, rect.left - 8 - W);
  const below = rect.top < window.innerHeight / 2;                  // ChangesPanel의 세로 뒤집기 규칙
  <div className="pointer-events-none fixed z-50 overflow-hidden rounded-md border border-edge bg-panel shadow-xl"
       style={{ left, width: W, ...(below ? { top: rect.top } : { bottom: window.innerHeight - rect.bottom }) }}>
    <div className="flex items-center gap-2 border-b border-edge px-2.5 py-1 text-[10px] text-fg-dim">
      <History size={11} className="text-accent" />
      <span>{new Date(entry.at).toLocaleTimeString()}</span>
      <span>· {lines.length}줄 · {entry.text.length}자</span>
    </div>
    <pre className="max-h-[60vh] overflow-hidden whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[12px] leading-5 text-fg">
      {lines.slice(0, 30).join("\n")}
    </pre>
    {lines.length > 30 && <div className="border-t border-edge px-2.5 py-1 text-[10px] text-fg-dim">… 외 {lines.length - 30}줄</div>}
    <div className="px-2.5 pb-1.5 text-[10px] text-fg-dim">클릭하면 복사</div>
  </div>
  ```
  - 절대시각은 인라인 `toLocaleTimeString()`(앱 내 `toLocaleString()` 선례 계열). 상대시간은 항목에 이미
    있어 카드에서 중복하지 않는다.
  - 스크롤 없음 — 전문은 클릭 복사로 얻는다(패널의 존재 이유가 "곁눈질"이다). Escape 없음(§1.2).
- **점유**: `useOccludesWebview(!!hover)`. 리스트 단위 hover라 항목 사이를 지날 때 해제/재획득이 반복되지
  않는다(옆 브라우저 셀 깜빡임 방지). 카드가 이웃 pane 위로 나갈 수 있어 등록은 필요하다.
- 색·폰트는 토큰 유틸만(`text-fg`, `text-fg-dim`, `bg-panel`, `border-edge`, `font-mono`) — 테마 6종 대응.

### 2.3 요구 4 — 자동배치 모드 (C)

- **스토어**(`ui.ts`): `aggregateLayout: "grid" | "columns"`(localStorage `gp:aggregate-layout`, 기본
  `grid`), `setAggregateLayout(mode)`. `aggregateGroupTabs`와 같은 수동 영속 패턴.
- **배치**(`AggregateTerminals.tsx`):
  ```ts
  const gridCols = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4);
  const colsFor = (mode: Layout, n: number) => (mode === "columns" ? Math.min(n, 4) : gridCols(n));
  const cols = colsFor(layout, n);
  ```
  세로 컬럼 = 셀을 좌우로 한 줄에 나열. **4열 상한**: 최소 창폭 1100에서 n=5부터 셀 폭이 MIN_W 240 아래로
  떨어지고(n=6 ≈ 176px) 프롬프트 컬럼(min 110px)을 열면 xterm이 수십 px가 된다. 넘치면 기존 `rowsOfCells`
  청킹이 2행으로 감싼다(n=6 → 4+2).
- **트랙 키**: `n${n}` 유지. 모드 아이콘 클릭이 항상 균등 정렬을 수반하므로(요구 4 "클릭하면 자동 배치")
  모드별 비율 기억은 정의상 없다. 다른 모드에서 저장된 값은 rows/rowLens 길이 검증(:350-362)이 균등으로
  폴백한다. 마이그레이션 없음.
- **`evenTracks(mode = layout)`**: 대상 모드의 `cols/rows/rowLens`를 계산해 균등값을 쓴다(현재 함수는
  현재 배치만 안다). `setZoomed(null)` 유지.
- **버튼**: 래퍼 `<span>`이 hover를 받는다(버튼 자체가 아닌 이유: §1.3 React disabled 차단 + 팝오버로
  건너갈 때 leave 발생). 메인 버튼은 `disabled` 대신 `aria-disabled={!canEven}` + `onClick={canEven ?
  () => evenTracks() : undefined}` + 클래스 분기(`!canEven ? "opacity-40" : "hover:bg-raised hover:text-fg"`).
  아이콘은 **현재 모드**(`layout === "columns" ? <Columns3/> : <Grid2x2/>`), 라벨 "자동배치".
  title: "셀 자동배치 — 클릭: 지금 모드로 균등 정렬 · 호버: 모드 선택(그리드 / 세로 컬럼)".
- **팝오버**: 래퍼 `onMouseEnter` → `holdOpen` + rect로 `layoutMenu = { right: innerWidth - r.right,
  top: r.bottom + 4 }`(헤더 우측 버튼이라 우측 정렬 — `NewCellButton` 방식). `onMouseLeave` → 150ms
  지연 닫기. 팝오버 div도 enter=hold / leave=schedule. 묶음 칩과 타이머 로직이 같아지므로 두 인스턴스를
  `useDelayedClose(150)` 소형 훅으로 뽑는다(타이머 ref + hold + schedule + 언마운트 정리).
  ```tsx
  <div className="fixed z-50 flex items-center gap-1 rounded-md border border-edge bg-panel p-1 shadow-xl"
       style={{ right: layoutMenu.right, top: layoutMenu.top }}>
    <IconBtn active={layout === "grid"}    title="그리드 — 2×2·3×3 균등 배치" onClick={() => pick("grid")}><Grid2x2 size={14}/></IconBtn>
    <IconBtn active={layout === "columns"} title="세로 컬럼 — 셀을 좌우로 한 줄에 나열(최대 4열, 넘치면 줄바꿈)" onClick={() => pick("columns")}><Columns3 size={14}/></IconBtn>
  </div>
  // pick = (m) => { setAggregateLayout(m); evenTracks(m); closeNow(); }
  ```
  활성 모드는 `bg-raised text-accent`(탭 모으기 토글과 같은 상태색). `useOccludesWebview(!!chipMenu ||
  !!groupMenu || !!layoutMenu)` — 팝오버가 0행 우측 셀(브라우저 셀일 수 있음) 위에 놓인다.
- 아이콘: 그리드 = `Grid2x2`(현행 유지 — `LayoutGrid`는 모아보기 정체성 아이콘이라 피한다), 세로 컬럼 =
  `Columns3`(lucide 1.17 정식 export). 렌더 조건 `n > 1` 유지. 별도 창·메인은 ui 스토어가 창별이라
  시작 시 localStorage로 동기(라이브 동기 없음 — 탭 모으기와 같은 수준).

### 2.4 요구 5 — 사이드바 프로젝트 배경색 (D)

**D1. 색 배정을 공유 모듈로.** `src/lib/project-color.ts`(신규, 소형)에 `PROJECT_HUES`·
`assignProjectHues`·`projectTint`를 옮기고 훅 하나를 더한다:

```ts
/** 등록된 전체 프로젝트를 이름순으로 한 번 배정 — 사이드바·모아보기 칩·셀 헤더가 같은 맵을 본다.
 *  이름순인 이유: 표시 순서(드래그·변경순 정렬)와 무관하게 색이 고정돼야 "기억"이 된다. */
export function useProjectHues(): Map<string, number> {
  const { data: projects } = useProjects();
  return useMemo(
    () => assignProjectHues([...(projects ?? [])].map((p) => p.name).sort((a, b) => a.localeCompare(b, "ko"))),
    [projects],
  );
}
```

- `assignProjectHues` 보강 1줄: 슬롯 12개가 모두 쓰이면 `taken.clear()` — 13~24번째도 서로 다른 색을
  받는다(지금은 한 바퀴 돌고 포기해 선호 슬롯 중복이 몰린다). 이름순 12개 단위로 중복 없음이 보장된다.
- `AggregateTerminals.tsx`는 자기 부분집합 배정(`:210`)을 버리고 `useProjectHues()`를 쓴다 → 모아보기
  칩·셀 헤더 색이 사이드바와 일치한다(기존 색이 한 번 바뀔 수 있음 — 의도).
- 키는 **이름**(기존과 동일). 이름이 같은 프로젝트 둘은 같은 색 — 이름으로도 구분이 안 되는 경우라
  수용(§6 ⑤).
- `projectTint(hue, level: "off" | "on" | "row" | "row-on")` — boolean을 4단계로 넓힌다(`--proj-a-<level>`).
  기존 5개 호출부는 `"off"/"on"`으로 치환.

**D2. 행 배경.** `ProjectList`가 `useProjectHues()`를 한 번 부르고 `hue={hues.get(p.name) ?? 0}`을
`ProjectItem`에 넘긴다(memo 친화 — 맵이 바뀔 때만 prop 변화). `ProjectItem`:

```tsx
style={{
  "--tint": projectTint(hue, selected ? "row-on" : "row"),
  "--tint-hover": projectTint(hue, "row-on"),
} as React.CSSProperties}
className={`group relative cursor-pointer select-none border-l-2 px-3 py-2 bg-(--tint) hover:bg-(--tint-hover) ${
  selected ? "border-accent" : "border-transparent"
} …`}
```

- 인라인 `backgroundColor`가 아니라 **CSS 변수 + `bg-(--tint)`**(Tailwind v4 arbitrary var)인 이유:
  인라인 배경은 `hover:bg-raised` 같은 클래스를 이겨 hover 강조가 죽는다. 변수로 넣으면 hover는
  `--tint-hover`로 진해지고, 선택 행은 이미 진한 값이라 hover 변화가 없다(현재 `bg-selection` 행과 같은
  거동).
- 선택 표시는 기존 `border-l-2 border-accent`를 유지한다 — 라이트 테마의 진한 틴트(0.28)만으로는 선택이
  약하다. `bg-selection`은 행에서 제거(색이 그 역할을 대신).
- `.ai-working`/`.ai-done`은 background-image라 틴트 위에 그대로 겹친다 — 무변경.
- 드래그 삽입선·제거 X 버튼(`bg-raised`)·`opacity-40` 드래그 중 표시는 무변경.
- **행 전용 알파** — 칩보다 면적이 커서 같은 알파면 사이드바가 시끄럽다. `styles.css` `--proj-*` 블록에
  2개씩 추가(초기값, 실기에서 조정):

  | 테마 | `--proj-a-row` | `--proj-a-row-on` |
  |---|---|---|
  | 다크 4종(:root) | 0.28 | 0.6 |
  | 라이트 2종 | 0.12 | 0.28 |

- **대비**: 이름은 text-fg(칩과 같은 조건 — 이미 AA 실측), 2·3행은 text-fg-muted/text-fg-dim. 행 알파가
  칩의 절반 이하라 칩보다 유리하지만 6개 테마에서 측정한다(§5). fg-muted가 어느 테마에서 4.5:1 미달이면
  그 테마의 `--proj-a-row`를 낮춘다 — 색상(hue)이 아니라 알파만 조정하므로 배정 로직은 무관.

---

## 3. 태스크

> **상세 설계 문서**(구현 단위 — `/sc:implement`·`implementer` 입력, 2026-09-02): A1 → `DOCS/task/23-pane-controls-merge.md` ·
> A2 → `24-history-context-menu.md` · A3 → `25-float-window-history.md` · B1 → `26-history-hover-card.md` ·
> C1+C2 → `27-aggregate-layout-mode.md` · D1+D2 → `28-project-colors.md` · 인덱스 `DOCS/task/00-INDEX.md` §7.
> 상세 문서가 코드 대조로 **이 문서를 정정한 것**(상세 문서가 우선): ① A1의 import 삭제 목록 — `Maximize2/Minimize2/X`는
> PaneMenu가 계속 쓰므로 유지, 삭제는 `ThemeButton·PromptLogButton` import와 클러스터 전용 셀렉터뿐. ② A2 하단 클램프 —
> PaneMenu 240→**448**, ChipMenu 200→**248**(현재 값이 이미 173px 부족했다; 아래 270/240은 낡은 수치). ③ B1 카드
> 헤더·푸터 색 `fg-dim`→`fg-muted`(darcula 2.90:1), 카드 `maxHeight`는 60vh가 아니라 앵커 쪽 여유. ④ D2 대비 목표 —
> 절대 4.5/4.5/3.0은 현행 행도 못 넘어 "fg ≥ 4.5 + muted/dim은 현행 `bg-selection` 기준선 이상"으로 재정의, 초기 알파
> 다크 .28/.35 · 라이트 .10/.15 · solarized-light .06/.10.

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| A1 | 오버레이 병합 — PaneTree 오버레이에 테마·히스토리 편입, TerminalPane 클러스터·중복 버튼·미사용 import 삭제 | `workspace/PaneTree.tsx`, `workspace/TerminalPane.tsx` | hover 후 `PromptLogButton` 중심 `elementFromPoint`가 그 버튼(실측). 컬럼 닫힌 상태에서 클릭으로 열림 — 메인·플로팅 모두 |
| A2 | PaneMenu·ChipMenu "프롬프트 목록 열기/닫기" + 클램프 상수 | `workspace/TerminalPane.tsx`, `AggregateTerminals.tsx` | 우클릭 → 항목 클릭 → 컬럼 토글, 라벨이 상태를 따라 바뀜. 숨김 셀의 ChipMenu엔 항목 없음 |
| A3 | 플로팅 창: 타이틀바 `PromptHistoryButton` + `<Toasts/>`, 버튼 title 문구 갱신 | `FloatingTerminal.tsx`, `workspace/TermSessionControls.tsx` | 분할 2개 창에서 마스터 토글이 둘 다 여닫음. 항목 클릭 복사 토스트가 플로팅 창에 뜸 |
| B1 | 호버 카드 — 리스트 단위 hover 상태·150ms 최초 지연·비상호작용 카드·항목 title 제거·점유 등록·타이머 정리 | `workspace/TermSessionControls.tsx` | 좁은 셀(항목 left < 500px)에서 깜빡임 없음. 40줄 프롬프트 → 30줄 + "외 10줄". 다른 창에서 기록 지움 → 카드 소멸, 오류 없음 |
| C1 | `aggregateLayout` 스토어 + 영속 | `stores/ui.ts` | 재시작 후 모드 유지 |
| C2 | `colsFor`·`evenTracks(mode)`·hover 팝오버·`useDelayedClose`·aria-disabled·점유 OR | `AggregateTerminals.tsx` | n=3 세로 컬럼 → 1행 3열, n=6 → 4+2. 아이콘 클릭 즉시 균등. 균등 상태에서도 hover 팝오버 열림. 브라우저 셀 위에서 팝오버가 가려지지 않음 |
| D1 | `lib/project-color.ts` 신설(팔레트·배정·틴트·`useProjectHues`, 팔레트 순환 1줄, `projectTint` 4단계) + `AggregateTerminals` 전환 | `lib/project-color.ts`(신규), `AggregateTerminals.tsx` | 모아보기 칩·셀 헤더 색 == 사이드바 색(같은 프로젝트). 프로젝트 13개 이상에서 이름순 인접 중복 없음 |
| D2 | 행 배경 `--tint` 변수 + `bg-(--tint) hover:bg-(--tint-hover)` + 선택 `border-accent` 유지 + `--proj-a-row*` CSS 변수 | `sidebar/ProjectItem.tsx`, `sidebar/ProjectList.tsx`, `styles.css` | 정렬·드래그 순서를 바꿔도 각 프로젝트 색 불변. hover 진해짐. 다크 4·라이트 2 테마에서 fg-muted 대비 ≥ 4.5:1 |
| V | e2e 14에 hit-test·컬럼 토글·모드 전환 단언, 실기(메인·플로팅·별도 창 × 다크·라이트), 사이드바 대비 측정 | `tests/e2e/suites/14-frontend-dom.mjs` | §5 |

순서: A1 → A2 → A3(같은 파일 군) → B1 → C1 → C2 → D1 → D2 → V. A1은 다른 항목의 전제는 아니지만
요구 1의 진짜 원인이라 먼저 한다. D는 독립이라 병렬 착수 가능.

---

## 4. 변경 지점

| 파일 | 태스크 | 변경 |
|---|---|---|
| `src/components/workspace/PaneTree.tsx` | A1 | 오버레이에 `ThemeButton`·`PromptLogButton` + 구분선 |
| `src/components/workspace/TerminalPane.tsx` | A1, A2 | 클러스터 삭제 · PaneMenu 항목 + `usePromptHistory` 구독 · 클램프 270 |
| `src/components/workspace/TermSessionControls.tsx` | A3, B1 | title 문구 · 호버 카드 |
| `src/FloatingTerminal.tsx` | A3 | `PromptHistoryButton` actions · `<Toasts/>` |
| `src/components/AggregateTerminals.tsx` | A2, C2 | ChipMenu 항목·클램프 240 · `colsFor`·`evenTracks(mode)`·팝오버·`useDelayedClose`·점유 OR |
| `src/stores/ui.ts` | C1 | `aggregateLayout` + setter + 영속 |
| `src/lib/project-color.ts` | D1 | **신규** — 팔레트·`assignProjectHues`(순환)·`projectTint`(4단계)·`useProjectHues` |
| `src/components/sidebar/ProjectItem.tsx`, `ProjectList.tsx` | D2 | `hue` prop · `--tint` 변수 배경 |
| `src/styles.css` | D2 | `--proj-a-row`·`--proj-a-row-on`(다크·라이트 블록) |
| `tests/e2e/suites/14-frontend-dom.mjs` | V | 단언 3종 |

신규 파일은 `lib/project-color.ts` 하나(`useDelayedClose`는 `AggregateTerminals.tsx` 안 소형 훅 — 두
인스턴스가 같은 파일).

---

## 5. 검증(V)

정적 검증만으로 통과시키지 않는다(CLAUDE.md). 모두 dev 디버그 앱(CDP 29222)에서:

- **A1 hit-test**: 터미널 pane에 hover 이벤트 → `PromptLogButton` rect 중심의 `document.elementFromPoint`가
  그 버튼(또는 그 자식). 클릭 → `usePromptHistory.openPanels[paneId]` true → `.xterm` 옆에 컬럼 DOM.
  메인 워크스페이스·플로팅 창 둘 다. e2e 14에 단언 추가(현재 히스토리 관련 e2e 0건).
- **A2**: PaneMenu·ChipMenu에서 항목 라벨이 상태별로 바뀌고 토글됨. 화면 하단 우클릭 시 메뉴가 잘리지 않음
  (클램프). 숨김 셀 칩 우클릭엔 항목 없음.
- **A3**: 플로팅 창 분할 2 pane → 타이틀바 토글로 둘 다 열림/닫힘. 항목 클릭 → 토스트 표시.
- **B1**: 별도 창 1100px 2열 첫 열(항목 left ≈ 460)에서 hover — 카드가 항목 위를 덮어도 깜빡이지 않음
  (`pointer-events-none`). 항목 사이 이동 시 지연 없이 전환, 옆 브라우저 셀 깜빡임 없음. 다크·라이트
  각 1회 대비 확인.
- **C2**: n=3 세로 컬럼 → `rowsOfCells` 1행. n=6 → 2행(4+2). 아이콘 클릭 후 트랙 균등·확대 해제.
  균등 상태(aria-disabled)에서 hover 팝오버 열림. 0행 우측이 브라우저 셀일 때 팝오버 가림 없음(점유).
  재시작 후 모드 유지.
- **D**: 같은 프로젝트의 사이드바 행 배경 hue == 모아보기 칩 hue(`getComputedStyle` 배경색을 HSL로
  환산해 비교). "변경 있는 프로젝트 위로" 정렬 토글·드래그 재정렬 뒤에도 각 행 색 불변. **대비 측정**
  (CDP, 테마 6종 × 행 상태 off/on): 행 배경 = 틴트를 `--color-panel` 위에 알파 합성한 값, 텍스트 =
  `text-fg`·`text-fg-muted`·`text-fg-dim` 계산색 → WCAG 대비 계산. 목표: 이름(fg) ≥ 4.5, 2행(fg-muted)
  ≥ 4.5, 3행 dim ≥ 3.0. 미달 테마는 `--proj-a-row*`를 낮춰 재측정하고 문서에 최종값 기록.

---

## 6. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값 |
|---|---|---|
| ① | 세로 컬럼 4열 상한 — 정적 4 vs 그리드 폭 기준 동적(`floor(w/(MIN_W+GAP))`) | **정적 4**. 동적이면 창 리사이즈에 cols가 바뀌어 저장 비율이 흔들린다 |
| ② | 모드 아이콘 클릭 시 균등 정렬 — 항상(요구 문장) vs 모드만 바꾸고 비율 유지 | **항상 균등**("클릭하면 자동 배치") |
| ③ | 카드 줄 상한 30 / 폭 240~480 | 그대로. 더 긴 전문은 클릭 복사 |
| ④ | `PaneControls` 최대화 아이콘의 상태 반영(`Maximize2`↔`Minimize2`) — 삭제되는 클러스터에는 있었으나 눌리지 않던 버튼 | **이번 범위 밖**. 필요하면 `maximizedPaneId` 구독 3줄 |
| ⑤ | 프로젝트 색 키 — 이름(현행) vs id | **이름**. 같은 이름 둘은 같은 색(이름으로도 못 가르는 경우). id로 바꾸면 모아보기 묶음(`groupByProject`는 이름 기준)과 어긋난다 |
| ⑥ | 색 고정 방식 — 이름순 결정적 배정(기본) vs 배정 결과를 localStorage에 영속 | **결정적 배정**. 프로젝트 추가·제거 시 충돌 밀림으로 일부 색이 바뀔 수 있다(해시 선호가 대부분 유지). 바뀌는 게 거슬리면 `gp:project-hue` 영속 + 새 프로젝트는 가장 덜 쓰인 슬롯 — 그때 추가 |
| ⑦ | 사이드바 색 끄기 토글 | **없음**. 시끄럽다는 피드백이 오면 PROJECTS 헤더에 `projectSortByChanges`와 같은 토글 1개 |
| ⑧ | 색을 다른 표면(워크스페이스 탭·타이틀바)에도 | **이번 범위 밖**. `useProjectHues()`가 공유 모듈이라 붙이는 건 각 1줄 |
