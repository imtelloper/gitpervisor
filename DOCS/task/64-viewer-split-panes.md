# 태스크 64 — 뷰어 우클릭 → 패널 분할 (코드 나란히 보기)

> 상태: **설계** (2026-09-08) · 대상: gitpervisor · 근거: 코드 실측 2026-09-08(워킹트리 기준) ·
> 선행: 터미널 분할 트리(`stores/terminals.ts`·`workspace/PaneTree.tsx` — **이 설계가 재사용한다**) ·
> **Rust 변경 0**

## 1. 요구사항

Viewer 탭에서 코드를 볼 때 **우클릭 → 패널 분할**로 파일을 나란히 볼 수 있어야 한다.

받아들이는 조건:
- 뷰어 본문 우클릭 → 메뉴에 `오른쪽/왼쪽/아래/위로 분할`, `패널 최대화`, `패널 닫기`.
  터미널 pane 메뉴(`TerminalPane.tsx:204-302`)와 **같은 항목·같은 단축키 힌트**.
- 분할 후 각 패널이 **서로 다른 파일**을 보여준다. 경계는 드래그로 비율 조절.
- 파일 트리·변경 목록·검색·Go to Definition에서 파일을 클릭하면 **활성 패널**에 열린다.
- 파일 탭 바(`ViewerFileTabs`)는 활성 패널의 탭을 보여준다. **(2026-09-17 변경: 패널마다 자기 탭 바 — §3.3 끝)**
- 레이아웃은 앱 재시작 후에도 유지된다(뷰어 탭이 이미 영속화된다).

## 2. 현황(근거)

- **뷰어는 단일 뷰다.** `ViewerTab.tsx:12-37` = 파일 탭 바 + `DiffViewer({projectId, target})` 하나.
  무엇을 보여줄지는 전역 단일값 `useUi.selectedDiff`/`selectedDiffRepoId`(`ui.ts:79-85`)가 정한다.
- **`selectDiff` 호출부가 8파일 11곳**이다: `ChangesPanel`·`FileTreePanel`·`SearchPanel`·
  `SymbolSearch`·`QuickOpenHost`·`goto-definition`·`ViewerFileTabs`·`KeyboardShortcuts`.
  → **이 11곳을 건드리지 않는 설계라야 한다.** 라우팅은 `selectDiff` 안에서 한다.
- **분할 트리는 이미 있고 검증돼 있다.** `stores/terminals.ts:58-60`의 `Pane`
  (`leaf | split{dir,ratio,a,b}`)과 순수 함수 `splitAt`(`:82-107`)·`removePane`(`:172-179`)·
  `collectPanes`(`:76-80`)·`setRatioAt`(`:181-189`)·`replaceLeaf`(`:138-146`).
  렌더러는 `PaneTree.tsx`의 `PaneView`/`SplitView`/`Divider`(`:144-261`) — `Divider`는 rAF
  합치기와 언마운트 안전망까지 들어 있다.
- **뷰어 탭은 이미 영속화된다**: `ui.ts:87-90,228-243,277`의 `viewerTabs` + `activeDiffByProject`.
- **패널별 라우팅 배선이 이미 있다.** `DiffViewer`는 `onOpenFile?: (target, repoId) => void`를 받고,
  주지 않으면 전역 `selectDiff`로 떨어진다(`DiffViewer.tsx:184-196` — 태스크 55가 Git 모달용으로
  넣었다). 뷰어 리프는 **자기 paneId로 여는 함수**를 여기에 넘기면 된다. 주석대로 신원이 매 렌더
  바뀌지 않게 `useCallback`으로 넘겨야 한다(정의 이동 opener가 모듈 컨텍스트로 들고 있다).
- Monaco 옵션 상수는 `DiffViewer.tsx:155-166`(`FILE_OPTIONS`)·`:168-182`(`DIFF_OPTIONS`) 두 개다
  — §3.5의 `contextmenu: false`는 **둘 다**에 들어가야 한다(단일 파일 보기와 diff 보기 양쪽).

## 3. 설계

핵심 판단 두 개다.

### 3.1 레이아웃 트리는 **재사용**한다 — 두 번째 분할 구현을 만들지 않는다

`stores/terminals.ts`의 순수 함수 4개(`splitAt`·`removePane`·`collectPanes`·`setRatioAt`)와 타입
`Pane`/`SplitDir`를 `src/lib/pane-tree.ts`로 옮기고, 리프 payload를 제네릭으로 연다:

```ts
export type Pane<L> =
  | ({ kind: "leaf" } & L)
  | { kind: "split"; id: string; dir: SplitDir; ratio: number; a: Pane<L>; b: Pane<L> };
```

- 터미널: `L = { paneId: string; content: PaneKind }` — **기존 영속 데이터·마이그레이션
  (`migrateLeafContent`, `:166-170`)이 그대로 통한다**(형태가 안 바뀐다).
- 뷰어: `L = { paneId: string }` — 파일은 리프가 아니라 §3.2의 맵이 쥔다.

`terminals.ts`는 이 모듈에서 import만 한다. **동작 변경 0**이어야 하고, 그 사실을 e2e 14로 확인한다.

`SplitView`/`Divider`도 `workspace/SplitView.tsx`로 뽑는다. 지금 `Divider`는 `useTerminals`의
`setRatio`/`setDraggingSplit`을 직접 부르므로(`:190-191`), 그 둘을 프로프로 올린다.
`setDraggingSplit`(브라우저 webview 숨김)은 뷰어에도 필요하다 — **분할 배치에서 이웃 pane이
네이티브 브라우저면 드래그 잔상이 남는다.**

### 3.2 뷰어 상태 — 리프는 **paneId만**, 파일은 별도 맵

리프에 `DiffTarget`을 직접 넣지 않는다. 파일 탭 목록(`viewerTabs`)이 이미 pane과 무관한 전역
목록이고, 리프에 넣으면 두 곳이 같은 사실을 갖게 된다.

`stores/ui.ts`에 더한다:

```ts
viewerLayout: Pane<{ paneId: string }>          // 기본 = 리프 1개
viewerActivePaneId: string
viewerMaximizedPaneId: string | null
viewerByPane: Record<string, { target: DiffTarget; repoId: string | null } | null>
```

`selectedDiff`/`selectedDiffRepoId`는 **지운다** — 대신 파생 셀렉터로 남긴다:

```ts
export const selectActiveDiff = (s: UiState) => s.viewerByPane[s.viewerActivePaneId] ?? null;
```

읽는 쪽(`ChangesPanel`의 행 강조, `CommitDetailPane` 등)은 `s.selectedDiff` → `selectActiveDiff(s)`
한 줄 치환이다. **활성 패널이 곧 "지금 보고 있는 파일"**이므로 의미가 보존된다.

`activeDiffByProject`(프로젝트별 마지막 파일 복원, `ui.ts:92-93`)는 활성 패널 기준으로 계속 갱신한다.

### 3.3 라우팅 — `selectDiff`는 **활성 패널에** 연다

11개 호출부를 그대로 두는 열쇠다.

```ts
selectDiff: (target, repoId) => set((s) => {
  const pane = s.viewerActivePaneId;
  // ... 기존 viewerTabs 업서트·모아보기 닫기·activeDiffByProject 갱신은 그대로 ...
  return { viewerByPane: { ...s.viewerByPane, [pane]: target && { target, repoId: repoId ?? null } } };
})
```

~~`viewerTabs`는 패널별로 나누지 않는다.~~ **2026-09-17 사용자 요청으로 뒤집었다** — "분할하면 위 탭들도
같이 분리되고, 분리된 패널의 탭을 닫으면 그 패널도 닫히게". 원안(창 단위 탭 목록 하나)은 분할 화면에서
어느 탭이 어느 패널 것인지 알 수 없었다. 지금 규칙:

- `ViewerFileTab.paneId` — 탭은 패널 소속이다. 신원은 `(paneId, key)`라 같은 파일을 두 패널에 열 수 있다.
  `selectDiff`/`replaceDiff`는 **활성 패널의** 탭만 업서트한다(라우팅은 여전히 이 한 곳).
- `ViewerFileTabs`는 리프마다 그 패널 위에 렌더된다. 탭 클릭은 그 패널을 활성으로 만든 뒤 연다.
- `closeViewerTab(key, paneId?)` — 분할 중에 **그 패널·현재 프로젝트의 마지막 탭**을 닫으면
  패널도 닫는다(`dropViewerPane`, 메뉴 "패널 닫기"와 같은 경로). 한 칸뿐이면 빈 패널로 남는다.
  `paneId` 생략 시 활성 패널 → 그 키의 첫 탭 순(e2e 정리 루프가 키만 넘긴다).
- 패널을 닫으면 그 패널의 현재 프로젝트 탭은 같이 닫히고, **다른 프로젝트 탭**(안 보이던 것)은 남는
  활성 패널로 옮긴다.
- `selectProject`는 패널마다 그 프로젝트의 그 패널 탭으로 복원한다(마지막 활성 파일이 있으면 그것).
- 영속 마이그레이션: `paneId` 없는 탭·트리에 없는 패널의 탭은 활성 패널로 모은다.

### 3.4 렌더 (`workspace/ViewerTab.tsx`)

```
ViewerTab
└ ViewerPaneTree            ← viewerLayout 순회 (SplitView 재사용)
   └ ViewerLeaf(paneId)
      ├ onMouseDown → setViewerActivePane(paneId)
      ├ onContextMenu → ViewerPaneMenu
      ├ 활성이면 outline (TerminalPane.tsx:92-94와 같은 표시)
      ├ ViewerFileTabs(projectId, paneId)   ← 2026-09-17: 패널마다 탭 바
      └ viewerByPane[paneId] ? <DiffViewer …/> : <EmptyState "파일을 선택하세요"/>
```

`DiffViewer`에는 **그 리프 전용 `onOpenFile`**을 넘긴다(§2의 마지막 항목) — 그래야 패널 안에서
"편집" 버튼·정의 이동으로 연 파일이 전역이 아니라 **그 패널**에 뜬다. `useCallback([paneId])`.

`maximizedPaneId`는 `PaneTreeRoot`(`PaneTree.tsx:28-59`)와 같은 규칙 — 최대화된 리프만 렌더.

**Monaco 인스턴스가 패널 수만큼 생긴다.** `DiffViewer`는 이미 lazy(`ViewerTab.tsx:9`)이고
`DocWindow`가 별도 창에서 동시에 띄우는 선례가 있다. 다만 분할 상한을 **4개**로 두고 그 이상은
메뉴에서 비활성화한다 — 터미널과 달리 Monaco는 인스턴스당 비용이 크고, 4분할이면 요구는 충족된다.
(`ponytail: 상한 4 — 실사용에서 부족하면 상수만 올린다.`)

### 3.5 메뉴 (`workspace/ViewerPaneMenu.tsx`)

`TerminalPane.tsx:161-303`의 `PaneMenu`와 같은 모양. 항목만 다르다:

| 항목 | 힌트 | 동작 |
|---|---|---|
| 오른쪽으로 분할 | `Ctrl+Shift+D` | `splitViewerPane(paneId,"row",false)` |
| 왼쪽으로 분할 | | `…("row",true)` |
| 아래로 분할 | `Ctrl+Shift+E` | `…("col",false)` |
| 위로 분할 | | `…("col",true)` |
| 패널 최대화 / 해제 | | `toggleViewerMaximize(paneId)` |
| 패널 닫기 | `Ctrl+Shift+W` | `closeViewerPane(paneId)` (마지막 하나면 항목 없음) |

`MenuItem`은 `TerminalPane.tsx:306-333`에서 이미 export돼 있으니 그대로 쓴다.

**주의 — Monaco가 우클릭을 먹는다.** Monaco 에디터는 자체 컨텍스트 메뉴를 띄운다. 뷰어 pane의
`onContextMenu`는 Monaco 밖(패널 여백·탭 헤더)에서만 발화하므로, 요구를 만족하려면 둘 중 하나다:
- **(채택)** `DiffViewer`에 넘기는 Monaco 옵션에 `contextmenu: false`를 주고 pane 메뉴로 통일한다.
  Monaco 기본 메뉴는 "명령 팔레트/정의로 이동" 등인데, 이 앱은 Go to Definition을 이미 별도
  단축키·`goto-definition.ts`로 제공하므로 잃는 게 없다.
- (대안) Monaco 메뉴를 남기고 분할은 여백 우클릭에서만 — 요구("코드 볼 때 우클릭")를 못 채운다.

`useOccludesWebview(!!menu)`를 잊지 않는다 — 분할 이웃이 브라우저 pane이면 메뉴가 가려진다
(`TerminalPane.tsx:63`이 같은 이유로 건다).

### 3.6 단축키 (`KeyboardShortcuts.tsx`)

`Ctrl+Shift+D/E/W`는 지금 터미널 분할이다. **활성 탭이 Viewer일 때만** 뷰어 분할로 라우팅한다
(`useUi.activeWorkspaceTab`을 이미 `WorkspaceTabs`가 안다). 터미널 탭에서의 동작은 불변.

### 3.7 영속화

`viewerLayout`·`viewerActivePaneId`·`viewerByPane`을 `viewerTabs`와 같은 localStorage 항목에 넣는다
(`ui.ts:228-243`의 파서에 필드 추가, 없으면 기본 단일 리프로 마이그레이션). 손상 값은 지금처럼
빈 상태로 강등한다.

## 4. 검증

- **e2e (신규 스위트)**:
  1. Viewer에서 파일 열기 → 우클릭 → "오른쪽으로 분할" → 패널 2개, 새 패널이 활성.
  2. 파일 트리에서 다른 파일 클릭 → **새(활성) 패널에** 뜨고 첫 패널은 그대로.
  3. 첫 패널 클릭(활성 전환) → 또 다른 파일 클릭 → **첫 패널이** 바뀐다.
  4. Divider 드래그 → `viewerLayout`의 `ratio`가 바뀐다.
  5. "패널 닫기" → 남은 패널이 전체를 차지하고 활성이 그것으로 옮겨간다.
  6. 앱 재로드 후 레이아웃·각 패널 파일이 복원된다.
  7. Monaco 본문 우클릭에서 **앱 메뉴**가 뜬다(§3.5의 `contextmenu:false` 확인).
- **회귀 (여기가 진짜 위험 구간)**:
  - **e2e 14 전 항목** — §3.1의 `pane-tree.ts` 추출이 터미널 분할·최대화·닫기·비율·영속 마이그레이션을
    하나도 바꾸지 않았음을 확인한다. 추출은 **동작 변경 0**이 합격 조건이다.
  - `selectDiff` 11개 호출부가 전부 활성 패널로 도달하는지: 변경 목록·트리·검색·심볼 검색·
    QuickOpen·Go to Definition·파일 탭 바·단축키.
  - 브라우저 pane 이웃에서 Divider 드래그 시 webview 숨김(`setDraggingSplit`)이 뷰어 쪽에서도 걸리는지.

## 5. 하지 말 것

- **분할 트리를 새로 구현하지 마라.** `splitAt`/`removePane`/`Divider`는 rAF 합치기·언마운트
  안전망·비율 클램프까지 다듬어진 코드다(`PaneTree.tsx:189-250`). 추출해 공유한다.
- **`selectDiff` 호출부 11곳을 고치지 마라.** 라우팅은 `selectDiff` 안 한 곳에서 한다 — 그래야
  나중에 추가되는 호출부도 자동으로 맞는다.
- ~~`viewerTabs`를 패널별로 쪼개지 마라~~ — 2026-09-17 사용자 요청으로 패널별로 바꿨다(§3.3 끝).
- `Pane` 타입을 제네릭으로 열 때 **터미널의 영속 형태를 바꾸지 마라** — 리프의 필드 이름
  (`paneId`·`content`)이 그대로여야 저장된 레이아웃이 로드된다.
