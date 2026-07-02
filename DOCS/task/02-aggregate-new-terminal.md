# 태스크 02 — 모아보기 헤더에 새 터미널 추가 버튼

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속) · 근거: 코드 실측 2026-07-02

## 1. 요구사항

터미널 모아보기(AggregateTerminals) 헤더의 **닫기 버튼 왼쪽**에 새 터미널 추가 버튼을 둔다.
누르면 새 터미널이 만들어지고, 모아보기 그리드에 **즉시 셀로 표시**되어야 한다.

## 2. 현황(근거)

- **모아보기 중에는 터미널을 만들 방법이 전무하다.** `src/App.tsx:97-108` — `aggregateOpen`이면 `<AggregateTerminals />`만 렌더되고 Toolbar(새 터미널 버튼 `src/components/toolbar/Toolbar.tsx:213`)·WorkspaceTabs(`NewTabControls`의 + 버튼 `src/components/workspace/WorkspaceTabs.tsx:128-132`)·KeyboardShortcuts(Ctrl+` 새 터미널 `src/components/KeyboardShortcuts.tsx:66-79`)가 전부 언마운트된다. 이 버튼이 유일한 생성 경로가 된다.
- 헤더는 `src/components/AggregateTerminals.tsx:89-131`(아이콘+제목+선택수+선택 칩 스트립+닫기). 닫기 버튼은 `:124-130`(`setAggregateOpen(false)`) — 새 버튼 삽입 지점은 그 직전.
- `useProjects()`는 이미 이 컴포넌트에서 사용 중(`src/components/AggregateTerminals.tsx:27`) — 프로젝트 목록(id/name, `:41`) 확보 비용 없음.
- **터미널 생성 액션**: `useTerminals.openTerminal(projectId)` (`src/stores/terminals.ts:257-277`) — `tabId`·`paneId`를 새로 만들고 단일 리프 레이아웃 탭을 추가, `activeTab[projectId]=tabId`로 전환, `paneStatus[paneId]="live"`, **반환값은 `tabId`**(`:164`, `:276`). zustand `set`은 동기라 호출 직후 `getState()`로 신규 탭 조회 가능.
- **반환값을 쓰는 호출부는 없다**(실측): `WorkspaceTabs.tsx:129`, `Toolbar.tsx:213`, `KeyboardShortcuts.tsx:50,78` 모두 반환 무시 → 반환 타입 변경은 컴파일 안전.
- **그리드 표시 경로는 이미 존재**: 모아보기의 터미널 목록 `all`은 스토어 `terminals`에서 `collectByContent(tab.layout, "terminal")`로 반응형 파생(`AggregateTerminals.tsx:34-48`). `AggregateCell`(`:166-208`)은 마운트 시 `createTerminal`(멱등, `src/lib/terminal.ts:59-70`)로 아직 렌더된 적 없는 터미널의 PTY까지 생성한 뒤 `attachTerminal`(`:73-86`)로 붙이고 ResizeObserver로 fit(`AggregateTerminals.tsx:170-188`). 즉 **신규 paneId가 `selected`에 들어가기만 하면 셀 생성→PTY spawn→attach가 기존 코드로 완결**된다.
- 표시 여부는 로컬 `selected: Set<paneId>`(`AggregateTerminals.tsx:51`)가 결정. 최초 1회만 자동 선택(`initedRef`, `:52-58`)하고 이후엔 갱신 없음 → **신규 pane은 명시적으로 `selected`에 추가해야** 그리드에 뜬다. 사라진 pane 제거 효과(`:61-72`)는 추가와 무관.
- 탭/레이아웃은 localStorage(`gp:terminals`)에 자동 영속(`src/stores/terminals.ts:481-495`) — 신규 탭도 별도 처리 없이 재시작 복구에 포함된다.
- 현재 선택 프로젝트 상태는 존재: `useUi.selectedProjectId`(`src/stores/ui.ts:32`, 초기화 `:89`) — 마지막 선택 프로젝트가 localStorage에서 복원된다. 단 프로젝트 0개면 null 가능.
- 드롭다운 기성 패턴: `NewTabControls`(`WorkspaceTabs.tsx:178-255`) — 버튼 rect 기준 **fixed 위치** 메뉴 + `fixed inset-0 z-40` 백드롭 + `MenuItem`. overflow 컨테이너 클리핑을 피하는 검증된 패턴(주석 `:191-192`). 공용 Dropdown 컴포넌트는 없음(`src/components/common/`에 EmptyState/Toast/ResizeHandle/Confirm/Prompt/StatusDot뿐).

## 3. 설계(대안 비교 + 채택 근거)

### 3.1 새 터미널을 어느 프로젝트에 열 것인가

| 대안 | 동작 | 장점 | 단점 |
|---|---|---|---|
| A. `selectedProjectId`에 즉시 생성 | 클릭 1번 | 가장 빠름 | 모아보기는 **여러 프로젝트** 터미널을 섞어 보는 화면 — "현재 선택"은 모아보기 열기 전 마지막 선택일 뿐이라 화면 맥락과 무관. 잘못된 프로젝트에 열리면 PTY가 엉뚱한 cwd로 spawn되고 탭·activeTab 부작용까지 남는다 |
| B. **프로젝트 선택 드롭다운** (채택) | 클릭→목록에서 선택 | 명시적·예측 가능. `useProjects()` 이미 확보. 다중 프로젝트 화면 맥락과 일치 | 클릭 1번 추가 |
| C. 최근 사용/최다 터미널 프로젝트 휴리스틱 | 클릭 1번 | — | 예측 불가("왜 여기에 열렸지"), 추가 상태 필요. 기각 |

**채택: B + 지름길** — 버튼 클릭 시 프로젝트 드롭다운을 연다. 정렬은 `selectedProjectId`를 맨 위(있으면), 나머지는 `useProjects()` 순서. **프로젝트가 1개뿐이면 드롭다운 생략하고 즉시 생성**(모호성이 없으므로 A의 속도를 회수). 드롭다운은 `NewTabControls`의 fixed 패턴 재사용(§2 마지막 항목) — 헤더 밖(그리드 위)으로 넘치는 메뉴의 클리핑 문제를 원천 회피. 프로젝트 다수 대비 `max-h-80 overflow-auto`(BrowserPane 드롭다운 `src/components/workspace/BrowserPane.tsx:442`와 동일).

프로젝트 0개(또는 `projects` 로딩 전)면 버튼 disabled.

### 3.2 신규 paneId 획득과 즉시 표시

`openTerminal`은 현재 `tabId`만 반환한다(§2). 신규 pane을 `selected`에 넣으려면 paneId가 필요.

| 대안 | 방식 | 평가 |
|---|---|---|
| a. 호출 직후 스토어 조회 | `openTerminal` 후 `getState().terminals.find(t=>t.id===tabId)` → 단일 리프라 `collectPanes(layout)[0]` | 스토어 무변경. 그러나 "신규 탭=단일 리프" 내부 구조에 대한 암묵 결합 |
| b. **반환 타입 확장** (채택) | `openTerminal: (projectId) => { tabId, paneId }` | 계약이 명시적. 기존 호출부 4곳 모두 반환 무시(실측 §2) → 파급 0. 변경은 스토어 2줄(인터페이스 `:164` + 반환 `:276`) |

**채택: b.** 핸들러는 `initedRef.current = true`로 초기 자동선택과의 경합을 차단한 뒤(터미널 0개 상태에서 첫 생성 시 `:53-58`의 init 효과가 뒤늦게 덮어쓰는 것 방지 — 현재 로직상 결과는 같지만 명시가 안전) `setSelected`에 paneId를 추가한다. 이후는 전부 기존 경로: `all` 재계산 → `shown`에 포함 → `AggregateCell` 마운트 → `createTerminal`이 PTY spawn → attach. **신규 코드가 PTY를 직접 다룰 일이 없다.**

### 3.3 `activeTab` 부작용 — 모아보기 닫은 뒤 UX

`openTerminal`은 `activeTab[projectId]`를 새 탭으로 바꾼다(`terminals.ts:273`). 모아보기 중엔 WorkspaceTabs가 언마운트라(파일 상단 주석 `AggregateTerminals.tsx:19-24`, `App.tsx:97-108`) 즉각 영향은 없고, **모아보기를 닫으면 해당 프로젝트 워크스페이스가 새 터미널 탭을 활성으로 보여준다.**

이는 **의도된 동작으로 채택**한다 — 사용자가 방금 명시적으로 만든 터미널이므로 닫은 뒤 그 터미널이 보이는 것이 자연스럽고, Toolbar·Ctrl+`로 만들 때와도 일관된다. 비선택 프로젝트에 만든 경우에도 그 프로젝트로 이동했을 때 새 터미널이 보이는 정도의 영향뿐. `openTerminal`에 `activate?: false` 옵션을 추가하는 안은 YAGNI — 후속.

### 3.4 빈 상태 문구

터미널 0개 EmptyState의 안내(`AggregateTerminals.tsx:141` "프로젝트에서 터미널을 연 뒤 다시 열어보세요")는 이 버튼 도입으로 낡은 문구가 된다 → "위의 + 새 터미널 버튼으로 바로 열 수 있습니다"류로 수정. 버튼은 터미널 0개여도 헤더에 항상 표시(빈 상태 탈출 경로). EmptyState 내부에 별도 생성 버튼을 두는 것은 중복 — 후속 여지로만 남긴다.

## 4. 계약(타입·커맨드·이벤트)

Tauri 커맨드/이벤트/Rust 변경 **없음** — 순수 프론트엔드. PTY 생성은 기존 `createTerminal` 경로 그대로.

```ts
// src/stores/terminals.ts — 반환 계약 확장 (기존 호출부는 반환 미사용, 실측 §2)
interface TerminalsState {
  openTerminal: (projectId: string) => { tabId: string; paneId: string }; // 기존: string(tabId)
  // 나머지 전부 무변경
}
```

```tsx
// src/components/AggregateTerminals.tsx — 헤더(닫기 버튼 왼쪽)에 삽입
/** 프로젝트 드롭다운 → 선택 시 생성. 프로젝트 1개면 드롭다운 생략 즉시 생성, 0개면 disabled. */
function NewTerminalButton({ onCreate }: { onCreate: (projectId: string) => void });
// - projects: 부모에서 이미 확보된 useProjects() 데이터를 prop으로 전달
// - 메뉴: NewTabControls(WorkspaceTabs.tsx:178-255)와 동일한 fixed 위치 + 백드롭 패턴
// - 정렬: selectedProjectId(useUi) 우선, 이하 projects 순서. max-h-80 overflow-auto

// AggregateTerminals 본체의 핸들러 — 생성 + 즉시 선택
const addTerminal = (projectId: string) => {
  initedRef.current = true;                      // 초기 자동선택 효과와의 경합 차단
  const { paneId } = openTerminal(projectId);    // 스토어 갱신은 동기
  setSelected((prev) => new Set(prev).add(paneId)); // → AggregateCell이 PTY 생성·attach
};
```

- 아이콘/문구: `Plus`(lucide) + "새 터미널", 스타일은 옆 닫기 버튼(`:124-130`)과 동일 톤.
- 영속·복구·상태점(agentActivity 없음 → 기본 dot)·exit 처리 전부 기존 경로 — 신규 계약 없음.

## 5. 단계(구현 순서)

1. **스토어**: `openTerminal` 반환을 `{ tabId, paneId }`로 확장(`terminals.ts:164, :276` — 2줄). 기존 호출부 무영향 확인(tsc).
2. **UI**: `NewTerminalButton` 작성 + 헤더 `:124` 앞 삽입, `addTerminal` 핸들러 배선, EmptyState 문구 수정(§3.4).
3. **검증**: (기존 E2E 하네스 `tests/e2e/` 활용) 모아보기 열기 → 버튼 → 프로젝트 선택 → 셀 등장·PTY 입출력 확인 / 터미널 0개 상태에서 생성 / 프로젝트 1개 지름길 / 모아보기 닫은 뒤 해당 프로젝트 activeTab이 새 터미널인지.

**태스크 01(01-aggregate-hotkey.md)과의 조율**: 01도 같은 파일(AggregateTerminals.tsx 또는 전역 리스너)을 만질 수 있으나 기능 의존성은 없다. 충돌 면은 헤더 JSX 정도이므로 **01→02 또는 02→01 어느 순서든 무방하되 동시 작업은 피하고 순차 머지**. 참고로 모아보기 중 `KeyboardShortcuts`는 언마운트(`App.tsx:97-108`)라 01의 토글 단축키는 그 바깥(전역)에 등록되어야 한다 — 01 문서 참조.

규모: **S** — 스토어 2줄 + UI ~70 LOC.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| activeTab 부작용 UX | 모아보기 닫은 뒤 해당 프로젝트가 새 터미널 탭으로 열림 | 의도된 동작으로 채택(§3.3). 불만 시 `activate:false` 옵션 후속 |
| 그리드 재배치 시 기존 셀 리핏 | pane 추가로 `cols` 변동 → 기존 xterm 크기 변경 | 셀은 paneId 키로 리마운트 없음(`:152-158`), ResizeObserver→`fitTerminal`(`:181`)이 기존에 처리 — 저위험 |
| 드롭다운 클리핑/스크롤 | 헤더(h-10) 아래로 넘치는 메뉴, 프로젝트 다수 | fixed 위치 패턴(검증됨, `WorkspaceTabs.tsx:191-199`) + `max-h-80 overflow-auto` |
| 프로젝트 0개/로딩 | `projects` undefined 또는 빈 배열 | 버튼 disabled + title 안내 |
| 초기 자동선택 경합 | 터미널 0개에서 첫 생성 시 init 효과(`:53-58`)가 selected를 덮어씀 | `addTerminal`에서 `initedRef.current = true` 선행(§3.2) |
