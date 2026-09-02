# 모아보기 별도 창 조작 · Float 되돌리기 · 메모장 2건 — 설계

> 상태: **구현 완료 · 실기 검증 통과** (2026-09-02, 미커밋) · `/sc:design` 산출물 → `/sc:implement`
>
> **구현 중 설계에 추가된 것(§8)** — 실기 검증이 드러낸 결함 2건과 정정 1건:
> `disposeTerminal`이 이 창에 인스턴스가 없어도 `term_close`를 보내게(위임으로 만든 PTY 고아 방지),
> 모아보기 창의 "꺼짐" 신호를 Rust Destroyed 훅이 메인에 보내게(beforeunload IPC 유실), 되돌리기
> 우회 등록은 대표 paneId 하나만.
>
> 요구 6건 (사용자 표현의 "모아보기 float 모드" = 라벨 `aggregate`의 **별도 OS 창**):
> 1. 별도 창 우측 상단(자동배치 옆)에 새 터미널 추가 · 셀 우클릭 → 닫기
> 2. 터미널 세션 우클릭 → 패널 분리(Float)
> 3. 메모장이 마지막으로 보던 메모를 기억
> 4. 분리된 터미널을 다시 모아보기로 되돌리기(Float 취소)
> 5. 별도 창에서도 히스토리(프롬프트 컬럼) 전체 펼치기/접기
> 6. 메모장 크기를 드래그로 조절
>
> 6건은 **뿌리 3개**로 모인다 — 태스크도 뿌리별(A/B/C)로 묶는다:
> - **A** 별도 창은 터미널 스토어를 **읽기만** 한다 → 만들기·닫기·분리가 전부 막혀 있다 (요구 1·2·5)
> - **B** Float는 단방향이다 (요구 4 — 기존 F2 설계 계승)
> - **C** 메모장 상태가 로컬 state·고정 크기다 (요구 3·6)

---

## 0. 결정 요약

| # | 요구 | 결론 | 근거 |
|---|---|---|---|
| 1 | 별도 창 새 터미널 · 우클릭 닫기 | 스토어 액션 3개(`openTerminal`·`closePane`·`floatPane`) 첫 줄에 **"aggregate 창이면 메인에 위임"** 가드 1개. 컴포넌트의 `IS_AGGREGATE_WINDOW` 가드 5곳은 **삭제** | 별도 창은 `gp:terminals`를 읽기만 한다(`stores/terminals.ts:17-36`). 로컬로 만들면 메인이 모르고, 로컬로 닫으면 메인 소유 PTY가 죽는다(`AggregateTerminals.tsx:497-499` 주석이 정확히 이 이유로 막아 놓았다). 변경은 메인만 할 수 있으니 **명령을 메인에 보내고 결과는 이미 있는 storage 이벤트로 돌려받는다** |
| 2 | 우클릭 → 패널 분리 | **신규 기능이 아니다.** 워크스페이스 우클릭(`TerminalPane.tsx:264-268`)과 메인 안 모아보기 우클릭(ChipMenu)에 이미 있고, **별도 창에서만** 막혀 있다(`AggregateTerminals.tsx:763-769`) → 1의 가드로 함께 풀린다 | 셀 우클릭은 이미 ChipMenu를 연다(`:623-630`). 부족한 건 메뉴 항목이 아니라 별도 창의 실행 권한 |
| 3 | 메모장 마지막 메모 기억 | `gp:memo-active:<scopeId>` localStorage — `MemoPanel` 3줄 | `activeId`가 로컬 state(`MemoPanel.tsx:53`)라 팝오버를 닫으면 소멸. 전역·프로젝트 메모 둘 다 `MemoPanel`이라 한 곳 |
| 4 | Float 취소(되돌리기) | 기존 **F2 설계**(`video-split-redock-notify-design.md` §2) 계승. 단순화 1건: `adoptPane` 신설 대신 **`openTerminal(projectId, { paneId })`** — 1의 위임 명령과 **같은 op** | `createTerminal`이 "세션 있으면 attach, 없으면 open"을 자동 판정한다(`lib/terminal.ts:98-117`) → 새 PTY(요구 1)와 살아 있는 PTY(요구 4)를 스토어가 구분할 이유가 없다. 되돌린 pane은 항상 **새 탭 1개**(§2.2) |
| 5 | 별도 창 히스토리 전체 토글 | `TitleBar`의 `PromptHistoryButton`(`TitleBar.tsx:134-162`)을 `TermSessionControls.tsx`로 옮겨 모아보기 헤더에 렌더(별도 창일 때). **위임 불필요** | promptHistory 스토어는 창마다 RMW 쓰기 + storage 따라가기가 설계돼 있다(`promptHistory.ts:81-88, 211-223`). 별도 창은 `FloatTitleBar`라 그 버튼이 없었을 뿐 |
| 6 | 메모장 드래그 크기 | 좌하단 모서리 + 좌·하 변 핸들, `gp:memo-size` 영속. `usePanelWidth`(`lib/use-panel-width.ts`)의 2축 형제 훅 | 팝오버가 **우상단 앵커**(`right`/`top`)라 CSS `resize`는 핸들이 반대편(우하)에 생겨 드래그 방향과 자라는 방향이 어긋난다 → 기각 |

**Rust 변경은 B의 PTY-kill 우회 1건뿐.** A·C는 프론트 전용.

---

## 1. A — 별도 창 → 메인 명령 위임 (요구 1·2·5)

### 1.1 현황(근거)

- **창 역할**(`stores/terminals.ts:17-36`): main = 불러옴+저장 / aggregate = 불러옴 + storage 이벤트로
  따라감, **저장 안 함**(`:527-540`) / float = 독립 로컬 스토어. 저장이 메인 하나인 이유는 두 창이
  파일 통째 RMW를 하면 나중 쪽이 상대 변경을 덮기 때문 — 이 원칙은 유지한다.
- **별도 창에서 막힌 UI** — 전부 `IS_AGGREGATE_WINDOW` 가드:
  헤더 `NewCellButton`(`AggregateTerminals.tsx:500-506`), 묶음 드롭다운 "새 터미널"(`:727-736`),
  ChipMenu의 `onNewTerminal`/`onFloat`/`onCloseCell`(`:758-790`), 터미널 셀 헤더 X(`:1194-1202`),
  브라우저 셀 헤더 X(`:1261-1269`).
- **히스토리 마스터 토글**은 메인 `TitleBar`에만 있다. 별도 창은 `FloatTitleBar`(`AggregateWindow.tsx:44`).
- **별도 창에 `ConfirmHost`가 없다**(`AggregateWindow.tsx:42-51` — `Toasts`만). 터미널 닫기는
  `askConfirm`을 거치므로 필요. 선례: `SysMonitorWindow.tsx:11`.
- **창 간 명령 선례**: Rust `emit_to("main", "app://close-requested")`(`lib.rs:938`), JS `emitTo`는
  `@tauri-apps/api` 2.11에 있다(`event.d.ts`). 브로드캐스트+라벨 필터(`float://claim`)보다 대상 지정이 맞다.
- **메인은 별도 창이 떠 있는 동안 터미널에 손대지 않는다**(`TerminalPane.tsx:66-69`,
  `takenByWindow`) — 새 PTY를 어느 창이 띄울지에 대한 경합이 원천적으로 없다.
- **모아보기의 신규/소멸 항목 처리는 이미 있다**: 새 id 자동 편입(`AggregateTerminals.tsx:225-241`),
  사라진 id 선택 해제(`:244-255`). 다만 사라진 셀의 **xterm 인스턴스는 정리하지 않는다** —
  메인에서는 `closePane`/`floatPane`이 이미 dispose/detach 하므로 문제가 없었지만, 별도 창에선
  아무도 안 지운다.

### 1.2 설계

**한 곳의 가드.** 별도 창의 모든 변경 동선(+ 버튼·드롭다운·ChipMenu·셀 X)은 스토어 액션 3개로
수렴하므로, 컴포넌트가 아니라 **스토어에서** 위임한다. 컴포넌트 가드 5곳은 지운다.

```ts
// stores/terminals.ts — ROLE 블록(:17-36) 옆
export type TerminalsCmd =
  | { op: "openTerminal"; projectId: string; paneId: string; tabId?: string }
  | { op: "closePane"; tabId: string; paneId: string }
  | { op: "floatPane"; tabId: string; paneId: string };

/** 보조 창 → 메인. 메인만 스토어를 저장하므로 변경은 메인이 하고, 결과는 storage 이벤트로 돌아온다. */
export const sendTerminalsCmd = (cmd: TerminalsCmd) =>
  void emitTo("main", "terminals://cmd", cmd).catch((e) => console.error("메인 위임 실패:", e));

// 액션 — 첫 줄 가드
openTerminal: (projectId, ids) => {
  const tabId = ids?.tabId ?? crypto.randomUUID();
  const paneId = ids?.paneId ?? crypto.randomUUID();
  if (ROLE === "aggregate") {
    sendTerminalsCmd({ op: "openTerminal", projectId, tabId, paneId });
    return { tabId, paneId };           // 호출부(addTerminal)는 이 id로 selected에 넣는다 — 그대로 유효
  }
  /* 기존 본문 — tabId/paneId만 위 변수 사용 */
},
closePane: (tabId, paneId) => {
  if (ROLE === "aggregate") return sendTerminalsCmd({ op: "closePane", tabId, paneId });
  /* 기존 */
},
floatPane: (tabId, paneId) => {
  if (ROLE === "aggregate") return sendTerminalsCmd({ op: "floatPane", tabId, paneId });
  /* 기존 */
},

// 메인 — 영속 subscribe(:509) 옆, 같은 파일에 프로토콜을 모아 둔다
if (ROLE === "main")
  void listen<TerminalsCmd>("terminals://cmd", ({ payload: c }) => {
    const ts = useTerminals.getState();
    if (c.op === "openTerminal") ts.openTerminal(c.projectId, { tabId: c.tabId, paneId: c.paneId });
    else if (c.op === "closePane") ts.closePane(c.tabId, c.paneId);
    else if (c.op === "floatPane") ts.floatPane(c.tabId, c.paneId);
  });
```

`openTerminal`의 `ids?: { tabId?: string; paneId?: string }`는 **B(되돌리기)도 쓴다** — 살아 있는
paneId를 넘기면 그 PTY를 담은 새 탭이 된다(§2.2).

**흐름**(세 op 공통): 별도 창 UI → 스토어 액션 → `emitTo("main")` → 메인 스토어 변경 →
`gp:terminals` 저장 → storage 이벤트 → 별도 창 `terminals` 갱신 → 그리드 자동 편입/제거(기존).

- **새 터미널**: 별도 창에 셀이 마운트되며 `createTerminal` → 세션 없음 → `term_open`으로
  **별도 창이 spawn**. 메인 `TerminalPane`은 `takenByWindow` 동안 효과를 건너뛰고, 창이 닫히면
  그 효과가 재실행돼(`deps: [paneId, takenByWindow]`) `sessionExists` → attach로 이어받는다.
  `reattachAllTerminals`(`lib/terminal.ts:144-169`)는 메인 레지스트리 기준이라 이 pane을 모르지만
  위 경로가 대신 붙인다 — 새 xterm이라 fit이 기본 80×24에서 바뀌어 `onResize`도 발화한다.
- **닫기**: 메인 `closePane` → `dropPane` → `term_close`. 메인 레지스트리에 이 pane의 stale
  인스턴스(채널만 뺏긴 상태)가 있어 함께 dispose된다. 확인 다이얼로그는 **별도 창의**
  `askConfirm` → 그 창의 `ConfirmHost`(추가).
- **분리**: 메인 `floatPane` 기존 경로(`detachTerminalKeepPty` → 트리 제거 → 풀 창 claim).
- **별도 창의 잔여 xterm 정리**(신규, 1줄): 기존 prevIds 효과(`:225-241`)에서 `removed`도 계산해
  `detachTerminalKeepPty(id)`. 안 하면 닫거나 분리한 셀마다 xterm(WebGL 컨텍스트)이 그 창에
  쌓인다 — 이 창은 보조 모니터에 종일 켜 두는 용도라 누적된다. 메인에선 이미 정리돼 no-op이므로
  분기 없이 무조건 호출한다. 분리 케이스에서 플로팅 창의 `term_attach`와 순서 무관(IPC 없음).
- **UI 정리**:
  - 가드 5곳 삭제(§1.1). 단 **브라우저는 범위 밖**: 브라우저 스토어는 메인만 저장하고(`browser.ts:338-342`)
    별도 창에 storage 따라가기가 없다. `NewCellButton`은 별도 창에서 "새 터미널"만 보이고
    (`onCreateBrowser` 생략 → 종류 선택 단계 없이 프로젝트 목록), 독립 브라우저 탭 닫기(`closeBrowserTab`)는
    지금처럼 메인 전용. 브라우저 **분할 pane** 닫기는 `closePane`이라 위임을 그대로 탄다.
  - `AggregateWindow`에 `<ConfirmHost />`.
  - `PromptHistoryButton`을 `TermSessionControls.tsx`로 이동(export). `AggregateTerminals` 헤더의
    "탭 모으기" 옆에 **`IS_AGGREGATE_WINDOW`일 때만** 렌더 — 메인 안 모아보기는 바로 위 TitleBar에
    같은 버튼이 있어 두 개가 한 화면에 보이면 안 된다. 대상 집합은 그 창의 `useTerminals`(미러)라
    메인과 동일. `setPanels`가 `gp:prompt-panel-open`을 RMW로 쓰고 메인이 storage 이벤트로 따라가
    양쪽 버튼 상태가 맞는다.

### 1.3 태스크

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| A1 | `TerminalsCmd`·`sendTerminalsCmd`·aggregate 가드 3개·`openTerminal(projectId, ids?)`·메인 `listen` | `stores/terminals.ts` | 별도 창에서 액션 호출 시 로컬 스토어 불변 + 메인 스토어 변경 + storage 이벤트로 별도 창 반영 |
| A2 | `IS_AGGREGATE_WINDOW` 가드 5곳 삭제(브라우저 제외), `NewCellButton` 터미널 전용 모드, removed → `detachTerminalKeepPty` 1줄 | `components/AggregateTerminals.tsx` | 별도 창에서 +·우클릭 닫기·우클릭 분리 동작. 닫힌/분리된 셀의 xterm host가 DOM에 남지 않음 |
| A3 | `<ConfirmHost />` 추가 | `AggregateWindow.tsx` | 별도 창 터미널 닫기에 확인 다이얼로그 |
| A4 | `PromptHistoryButton` 이동 + 별도 창 헤더 렌더 | `TitleBar.tsx`, `workspace/TermSessionControls.tsx`, `AggregateTerminals.tsx` | 별도 창 버튼으로 모든 셀 컬럼 펼침/접힘, 메인 TitleBar 버튼 상태 동기 |

---

## 2. B — Float 되돌리기 (요구 4)

기존 F2 설계(`video-split-redock-notify-design.md` §2.1 현황·§2.2 절차)가 유효하다. 여기서는
**바뀐 점과 확정된 세부**만 적는다.

### 2.1 현황 보충

- F2 작성 이후 **프리워밍 풀**이 들어왔다(`lib.rs:173-199`, `FloatingTerminal.tsx:34-58`).
  플로팅 창은 이제 대개 `float-pool-N` 라벨이고 PTY 식별은 `FLOAT_POOL.claims`(라벨→paneId)다.
  Destroyed 훅은 **풀 분기**(`lib.rs:947-962`)와 **float 분기**(`:963-975`) 둘이 각각 PTY를 죽인다
  → 우회는 **두 분기 모두**에 걸어야 한다(풀이 비었을 때만 `float-<paneId>` 창이 만들어진다).
- F2가 신설하려던 `adoptPane`은 A1의 `openTerminal(projectId, { paneId })`로 흡수된다.
- 플로팅 창 언로드 정리(`FloatingTerminal.tsx:151-162`)는 **로컬 스토어의 pane 목록**을 돈다 —
  목록을 먼저 비우면 정리할 것이 없어 자연 우회. 그리고 "탭 소멸 → 창 닫기" 효과(`:164-167`)가
  있어 **스토어 비우기 = 창 닫기 트리거**다.

### 2.2 설계

- **Rust**: `AppState`에 `redock_skip: Mutex<HashSet<String>>`. 커맨드
  `float_redock_begin(state, term_ids: Vec<String>)`가 삽입. Destroyed 풀/float 분기 모두
  `if !skip.remove(id) { close_session(...) }` — 1회성. 라벨 계약 테스트(`lib.rs:1044-1058`) 옆에
  "skip 등록된 id는 Destroyed에서 close_session 미호출, 미등록은 기존 동작" 단언.
- **스토어**: 신설 없음(A1).
- **FloatTitleBar**: `actions?: ReactNode` 슬롯 — 창 컨트롤(`:37-49`) 왼쪽. AggregateWindow·SysMonitor
  사용처는 생략하면 무영향.
- **FloatingTerminal — 되돌리기 절차**(버튼 "메인으로 되돌리기"):
  ```
  1. panes = 로컬 스토어 전체 pane(collectPanes — 분할로 늘린 것 포함), projectId는 state에 있다
  2. await invoke("float_redock_begin", { termIds: [paneId] })   ← 대표 id **하나만**(아래 정정). 창 닫기 전 완료 필수
  3. panes.forEach(detachTerminalKeepPty)                       ← xterm만, PTY 유지
  4. panes.forEach(p => sendTerminalsCmd({ op: "openTerminal", projectId, paneId: p }))
  5. useTerminals.setState({ terminals: [] })                   ← 기존 효과가 창을 닫고, beforeunload는 빈 목록을 돈다
  ```
  2는 await, 나머지는 동기. 4가 5보다 먼저일 필요는 없지만(메인은 이벤트 수신 시점에 처리) 읽기
  좋게 이 순서로 둔다.

  **정정(2026-09-02 재검증)**: 2단계는 `panes` 전부가 아니라 **이 창의 대표 paneId 하나**(`fixedPaneId`
  또는 claim으로 받은 값)만 등록한다. Destroyed 훅이 `close_unless_redocking`에 넘기는 id는 창당
  하나(풀 창 = `claims[label]`, 비풀 창 = 라벨 접미사)라, 분할로 늘린 pane의 id는 Rust가 한 번도
  조회하지 않아 `redock_skip`에 영구히 남는다 → 나중에 그 pane을 메인에서 다시 분리했다 **진짜로**
  닫을 때 PTY가 살아남아 고아 셸이 된다(`take_redock_skip` 주석이 경고하는 경로). 분할 pane의
  PTY는 등록 없이도 산다 — beforeunload dispose가 5단계의 빈 목록을 돌기 때문이다. 상세는
  `video-split-redock-notify-design.md` §2.2.
- **메인**: A1 리스너 → `openTerminal(projectId, { paneId })` → 새 탭 "터미널 N" → 영속 → 보이는 쪽이
  마운트되며 `createTerminal` → `sessionExists` → attach. 세 경우 모두 기존 코드:
  워크스페이스 탭(모아보기 닫힘) / 메인 안 모아보기(신규 자동 편입 `:225-241`) / 별도 창(storage →
  자동 편입). 라벨이 "모아보기로"가 아니라 "메인으로"인 이유는 F2와 같다 — 모아보기가 닫혀 있으면
  워크스페이스로 간다.
- **크기**: 되돌아온 쪽은 **새 xterm 인스턴스**라 fit이 기본 80×24에서 바뀌며 `onResize` →
  `term_resize`가 나간다. CLAUDE.md의 같은-크기 함정은 *기존 인스턴스 재부착*(모아보기 창 닫힘)에
  해당. 그래도 검증(V)에서 `#2b` 방식으로 실폭을 본다 — 이 앱에서 "이론상 된다"는 통과 사유가 아니다.
- **F2 §2.2와의 차이**: `adoptPane`(프로젝트 탭이 있으면 `splitAt`으로 끼움) → **항상 새 탭**.
  되돌아오는 창은 메인 트리의 어느 pane 옆에 끼울지 모르고(그 정보는 float 시점에 버려졌다),
  새 탭이면 위임 명령과 코드 경로가 하나다. 원위치 복귀가 필요해지면 `floatPane`이 원래
  `(tabId, 이웃 paneId, dir)`를 라벨이나 localStorage에 남기는 확장으로(§7 ①).

### 2.3 태스크

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| B1 | `redock_skip` + `float_redock_begin` + Destroyed 두 분기 우회 + 테스트 | `src-tauri/src/state.rs`, `lib.rs` | 등록 id 창 파괴 시 `close_session` 미호출(테스트), 미등록은 기존 |
| B2 | `FloatTitleBar` `actions` 슬롯 | `components/FloatTitleBar.tsx` | 기존 3 사용처 무영향 |
| B3 | 되돌리기 버튼 + 절차 1~5 | `FloatingTerminal.tsx` | 클릭 → 창 닫힘, `term_project(paneId)`가 null이 아님(PTY 생존) |
| B4 | (A1에 포함) 메인 수신 → `openTerminal(projectId, {paneId})` | — | 되돌린 세션에서 입력 에코 이어짐, 스크롤백 제외 |

---

## 3. C — 메모장 (요구 3·6)

### 3.1 마지막 메모 기억 — `MemoPanel`

```ts
const activeKey = `gp:memo-active:${scopeId}`;
const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(activeKey));
useEffect(() => setActiveId(localStorage.getItem(activeKey)), [scopeId]);   // :71-73의 null 리셋을 대체
useEffect(() => {                                                          // :76-79 본문 로드 효과에 한 줄
  setText(active?.text ?? ""); textOwner.current = active?.id ?? null;
  if (active?.id) localStorage.setItem(activeKey, active.id);
}, [active?.id]);
```

- 저장 대상은 `activeId`가 아니라 **실효 `active.id`** — 아무것도 고르지 않고 첫 메모를 보다 닫은
  경우도 "그 메모"로 복원된다.
- 삭제된 id는 기존 `?? memos[0]` 폴백(`:54`)이 흡수한다 — 검증 코드 불필요.
- 전역 메모(`GlobalMemoPopover`)·프로젝트 메모(`MemoDialog`) 둘 다 이 패널이라 한 번에 해결.
  scopeId별 키라 두 스코프가 서로를 덮지 않는다.

### 3.2 드래그 크기 — `GlobalMemoPopover`

- 앵커가 `right`/`top`(`:69-70`)이므로 **자유 모서리는 좌하단**. 핸들 3개 — 좌 변(`cursor-col-resize`),
  하 변(`cursor-row-resize`), 좌하 모서리(`cursor-nesw-resize`). `CellHandles`(`AggregateTerminals.tsx:1289-1320`)의
  좌우 미러.
- 훅 `useDragSize(storageKey, initial: {w,h}, min: {w,h})` → `lib/use-panel-width.ts`에 `usePanelWidth` 옆.
  같은 패턴(window `mousemove`/`mouseup`, `body.userSelect = "none"`, 값 변경 시 localStorage 저장).
  드래그 델타: `dw = startX - clientX`(왼쪽으로 끌면 커짐), `dh = clientY - startY`. 축은 핸들이 정한다.
- 기본 720×420(현재값), **최소 480×300**(목록 240 + 편집기 최소). 최대는 기존 인라인
  `maxWidth`/`maxHeight`(`:71-72`)가 이미 창 크기로 자른다 — 훅은 min만 클램프하고 `h-[420px] w-[720px]`
  클래스를 `style.width/height`로 바꾼다.
- 영속 `gp:memo-size` = `{"w":720,"h":420}`. 손상 값은 기본으로.
- `useOccludesWebview(true)`가 이미 걸려 있어 드래그 중 네이티브 webview와 충돌 없음.
- `MemoDialog`(프로젝트 메모 820×560, 중앙 정렬)는 **범위 밖** — 요구가 "메모장"(타이틀바 전역 메모)이다.
  필요하면 같은 훅(§7 ③).

### 3.3 태스크

| # | 내용 | 파일 | 완료 기준 |
|---|---|---|---|
| C1 | 마지막 메모 id 영속(스코프별) | `components/memo/MemoPanel.tsx` | B 선택 → 닫기 → 열기 → B. B 삭제 후 열기 → 첫 메모 |
| C2 | `useDragSize` + 핸들 3개 + `gp:memo-size` | `lib/use-panel-width.ts`, `components/memo/GlobalMemoPopover.tsx` | 세 핸들 각각 동작, 최소 미만 불가, 닫고 열어도 유지, 좁은 창에서 기존 max 클램프 유지 |

---

## 4. 변경 지점 총괄

| 파일 | 뿌리 | 변경 |
|---|---|---|
| `src/stores/terminals.ts` | A, B | `TerminalsCmd`·`sendTerminalsCmd`·가드 3개·`openTerminal(ids?)`·메인 `listen` |
| `src/components/AggregateTerminals.tsx` | A | 가드 5곳 삭제 · `NewCellButton` 터미널 전용 · removed detach 1줄 · 히스토리 버튼 렌더 |
| `src/AggregateWindow.tsx` | A | `<ConfirmHost />` |
| `src/components/TitleBar.tsx` → `src/components/workspace/TermSessionControls.tsx` | A | `PromptHistoryButton` 이동 |
| `src-tauri/src/state.rs`, `src-tauri/src/lib.rs` | B | `redock_skip` · `float_redock_begin` · Destroyed 두 분기 · 테스트 |
| `src/components/FloatTitleBar.tsx` | B | `actions` 슬롯 |
| `src/FloatingTerminal.tsx` | B | 되돌리기 버튼 + 절차 |
| `src/components/memo/MemoPanel.tsx` | C | 마지막 메모 영속 |
| `src/lib/use-panel-width.ts`, `src/components/memo/GlobalMemoPopover.tsx` | C | `useDragSize` + 핸들 |
| `tests/e2e/suites/13-float-window.mjs` | B | redock 케이스 |

신규 파일 없음. 신규 Rust 커맨드 1개(`float_redock_begin`). 신규 창 간 이벤트 1개(`terminals://cmd`).

---

## 5. 구현 순서(권장)

1. **C1 → C2** — 독립·프론트 전용·반나절 미만. 바로 실기 확인 가능.
2. **A1 → A3 → A2 → A4** — A1이 B의 전제. A2는 가드 삭제라 A1 없이 하면 별도 창이 로컬 스토어를
   건드려 **정확히 예전 주석이 경고한 사고**(메인 PTY 사망)가 난다. 순서 엄수.
3. **B1 → B2 → B3** — Rust 포함, CLAUDE.md 함정(라벨 계약·PTY 수명·같은-크기)을 지나는 유일한 뿌리.
4. **V** — e2e + 실기.

---

## 6. 검증(V)

**정적 검증만으로 통과시키지 않는다**(CLAUDE.md). 항목별 실기:

- **A 별도 창**: `+` → 그 창에 셀 등장 + 메인 탭바에 탭 등장 → 별도 창 닫기 → 메인 탭에서 입력
  에코(이어받음). 셀 우클릭 → 터미널 닫기 → 확인 다이얼로그(그 창에서) → 셀·메인 탭 소멸,
  `term_project`가 null, 셀 host가 DOM에 없음. 셀 우클릭 → 분리 → 플로팅 창 등장 + 셀 소멸.
  히스토리 버튼 → 모든 셀 컬럼 펼침, 메인 TitleBar 버튼도 켜진 표시.
- **B 되돌리기**: 분리 → 되돌리기 → 창 닫힘 + 메인에 새 탭 + 입력 에코(PTY 생존) + ConPTY 실폭
  (`$Host.UI.RawUI.WindowSize.Width`, e2e 14 `#2b` 방식). **풀 창·비풀 창 두 경로** — 풀은 1개라
  연속 2회 분리하면 두 번째가 비풀(`float-<paneId>`) 경로다. 메인 안 모아보기 열린 상태 / 별도 창
  열린 상태 / 둘 다 닫힌 상태 3가지에서 되돌린 세션이 나타나는 위치 확인.
- **C 메모장**: §3 완료 기준 그대로. 크기는 다크·라이트 각 1회(핸들 hover 색 대비).
- **e2e**: `13-float-window.mjs`에 redock 케이스(창 소멸 후 `term_project` non-null + 메인 `__gpv.terminals`에
  paneId 존재). 별도 창 위임은 창별 webview 컨텍스트라 직접 구동이 어려우면 **메인 스토어 결과**로
  단언한다(`terminals://cmd`를 e2e가 메인에 직접 emit해도 같은 코드 경로).

---

## 7. 오픈 이슈(사용자 결정 — 없으면 기본값)

| # | 질문 | 기본값 |
|---|---|---|
| ① | 되돌린 pane의 위치 — 새 탭 vs 원래 탭의 원래 자리 | **새 탭**. 원위치는 float 시점에 위치를 남겨야 해 범위 확대 |
| ② | 별도 창에서 "새 브라우저"도 만들기 | **제외**. 브라우저 스토어에 storage 따라가기가 없어 위임만으로는 그리드에 안 뜬다 — 요구에 없음 |
| ③ | 프로젝트 메모 모달(`MemoDialog`)도 드래그 크기 | **제외**. 요구가 타이틀바 메모장. 같은 훅으로 후속 가능 |
| ④ | 되돌리기 진입점 — 타이틀바 버튼만 vs 플로팅 창 우클릭 메뉴에도 | **타이틀바 버튼만**. 메뉴 항목은 `TerminalPane`이 `FloatingTerminal`을 역참조해야 해 의존 방향이 꼬인다 |

---

## 8. 구현 결과(2026-09-02)

태스크 A1~A4·B1~B3·C1~C2 전부 구현, `tsc` 통과, `cargo test` 통과, 실기 검증 통과. 아래는
**실기 검증이 아니었으면 나가지 못했을 것들** — 정적 검증(tsc·cargo test)은 전부 통과한 상태였다.

### 8.1 검증 중 드러난 결함과 수정

| # | 증상(실측) | 원인 | 수정 |
|---|---|---|---|
| 1 | 별도 창에서 만든 터미널을 별도 창에서 닫으면 메인 탭은 사라지는데 `term_project`가 계속 non-null — **PTY 고아** | 위임으로 만든 pane은 메인이 `takenByWindow` 동안 xterm을 만들지 않아 메인 레지스트리에 없다. `disposeTerminal`이 "인스턴스 없음 → 조기 반환"이라 `term_close`를 건너뛰었다. §1.2의 "stale 인스턴스가 있어 함께 dispose된다"는 별도 창이 열리기 **전에** 만든 터미널에만 참이었다 | `lib/terminal.ts` `disposeTerminal`: `term_close`를 레지스트리 유무와 무관하게 먼저 보낸다(세션 없는 id는 백엔드 no-op) |
| 2 | 별도 창을 닫아도 메인의 `aggregateWindowOpen`이 true로 남아 "모아보기 창에서 표시 중"에 갇힘 — 새 탭의 PTY가 영영 spawn되지 않음 | 그 창의 `beforeunload`가 보내는 "꺼짐" 이벤트가 **창이 죽는 중의 비동기 IPC라 유실**. 포커스 재확인은 사용자가 창을 닫을 때만 우연히 돌았다(스크립트로 닫으면 포커스 이동이 없다). 덧붙여 열릴 때 StrictMode 이중 마운트가 true·true·false 순서로 도착해 창이 열려 있는데 false가 남았다 | "꺼짐"을 **Rust Destroyed 훅**(`lib.rs`, `label == "aggregate"` 분기)이 `emit_to("main", "aggregate-window://state", {open:false})`로 보낸다. `AggregateWindow`는 마운트 시 "켜짐"만 보내고 beforeunload·효과 정리를 없앴다. 포커스 재확인은 안전망으로 유지 |
| 3 | (정정) 되돌리기 우회 등록이 분할 pane까지 전부였다 | §2.2 정정 참조 — Rust가 조회하는 id는 창당 대표 하나 | `FloatingTerminal` `redock()`: `termIds: [ownPaneId]` |

같은 부류로 **고치지 않은 것**: 플로팅 창 `beforeunload`의 `disposeTerminal`(분할로 생긴 PTY 정리)도
같은 이유로 유실된다 — e2e 프로브에서 창 파괴 후 3초까지 PTY가 살아 있었다. 그 코드의 주석이 이미
"베스트 에포트"라고 적고 있고 이번 요구와 무관해 그대로 두었다(대표 pane은 Rust Destroyed가 죽인다).

### 8.2 실기 검증 내역(CDP, 디버그 앱)

- **A 별도 창 위임**: `+` → 메인 스토어 탭 생성 → storage로 별도 창 반영 → 별도 창 셀이 PTY spawn;
  히스토리 마스터 토글로 셀 컬럼 펼침; `ConfirmHost` 표시; 셀 우클릭 메뉴에 "터미널 닫기"·"새 창으로
  분리"; `closePane` 위임 → 메인 탭 제거 + **PTY 종료**(8.1-1 수정 후) + 별도 창 xterm host 정리(7→7);
  `floatPane` 위임 → 플로팅 창 생성 + 메인 스토어 제거 + PTY 생존.
- **B 되돌리기**: 풀 창(`float-pool-N`)·비풀 창(`float-<paneId>`) 두 경로 모두 — 창 소멸 후 PTY 생존,
  메인에 새 탭, 별도 창이 열려 있으면 그 그리드에 자동 편입, 되돌린 세션에서 에코 응답 +
  **ConPTY 실폭 = xterm cols(46=46)**. 분할 2 pane 창 되돌리기 → 두 PTY 모두 생존·복귀. 회귀: 그
  분할 pane을 재분리해 **진짜로** 닫으면 PTY 종료(skip 잔여 없음).
- **C 메모장**: 모서리 드래그 720×420→840×480, `gp:memo-size` 영속, 최소 480×300 클램프; 임시
  메모 2개로 두 번째 선택 → 닫고 열면 복원, `gp:memo-active:__global__` 영속.
- **e2e**: `13-float-window.mjs` 17 pass — 생성·소멸(풀 라벨 인식) + redock + 1회성 회귀 가드.

### 8.3 알려진 미해결(범위 밖)

- `tests/e2e/lib/cdp.mjs`의 `connect()`가 제목("Gitpervisor")으로 첫 페이지를 잡아 **프리워밍 풀 창에
  붙을 수 있다** — 풀이 들어온 뒤 `npm run test:e2e` 전체가 영향을 받는다. 라벨(`__TAURI_INTERNALS__.metadata.currentWebview.label`)로
  main을 고르게 바꿔야 한다.
- 모아보기 빈 화면 문구 "위의 새 터미널 · 새 브라우저 버튼으로…"는 별도 창에서 브라우저를 못 만들어
  부정확하다(변경 전에도 별도 창엔 + 버튼이 없어 맞지 않던 문구).
- 플로팅 창에 `<Toasts />` 호스트가 없어 되돌리기 실패는 console.error로만 남는다.
