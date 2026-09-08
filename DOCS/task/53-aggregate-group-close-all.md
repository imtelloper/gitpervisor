# 태스크 53 — 모아보기 "탭 모으기" 묶음 칩 우클릭 → 묶음 탭 전부 닫기

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07(워킹트리 기준) ·
> 선행: 태스크 24(ChipMenu 관례), 27(묶음 드롭다운 `useDelayedClose`) · **Rust 변경 0 · 스토어 변경 0**

## 1. 요구사항

모아보기에서 **탭 모으기**를 켜면 같은 프로젝트의 탭이 칩 하나로 묶인다. 그 묶음 칩을 **우클릭**해서
그 프로젝트의 **탭을 한 번에 전부 닫을** 수 있어야 한다.

받아들이는 조건:
- 탭 모으기 ON 상태에서 묶음 칩 우클릭 → 드롭다운 맨 아래에 **`'{프로젝트}' 탭 N개 모두 닫기`**(danger)
  항목이 있다. N = 그 창에서 닫을 수 있는 셀 수.
- 클릭 → 확인 다이얼로그(실행 중인 프로세스가 종료됨을 명시) → 확인 시 그 프로젝트의 터미널 pane·
  브라우저 pane·독립 브라우저 탭이 전부 닫히고 칩이 사라진다.
- 메인 안 모아보기와 **별도 창(aggregate)** 양쪽에서 동작한다. 별도 창에서는 닫기 위임 경로가 없는
  **독립 브라우저 탭만** 제외되고(기존 ChipMenu 관례), N에서 빠진다.
- 탭 모으기 OFF(개별 칩)에서는 변화 없음 — 개별 칩 메뉴의 '터미널 닫기'가 이미 있다.

## 2. 현황(근거)

- **"탭 모으기"는 워크스페이스 탭 기능이 아니라 모아보기 칩 바의 표시 토글**이다.
  `AggregateTerminals.tsx:587-605` 버튼(`Layers` 아이콘, title "탭 모으기 켜기 — 같은 프로젝트의 탭을 칩 하나로
  묶습니다"), 상태는 `useUi.aggregateGroupTabs`(`stores/ui.ts:104-105`, `gp:aggregate-group-tabs`).
- **묶음은 객체가 아니라 파생값**이다. `all: CellMeta[]`(`:178-222`)는 터미널 pane·브라우저 pane·독립 브라우저 탭
  (`tabId: null`, `:205-216`)을 `projName` 오름차순으로 정렬한 배열이고, `groupByProject(all)`(`:1004-1013`)가
  인접 같은 이름을 버킷으로 묶는다. 묶음에 쓸 수 있는 키는 `projName`이며 드롭다운도 그렇게 찾는다(`:754`).
- **묶음 칩의 우클릭은 이미 드롭다운을 연다**: `:506-509` `onContextMenu → preventDefault → openDropdown`.
  드롭다운(`:752-800`)은 `fixed z-50 … max-h-[60vh] min-w-44 max-w-80`, `left: min(x, innerWidth-328)`, 지연 닫기
  `useDelayedClose`(`:334-336`). 내용 = 구성원 `Chip full` 목록 + 구분선 + `MenuRow` "'{name}'에 새 터미널 열기"
  (`:792-797`). 즉 **항목을 붙일 자리가 이미 있고, 우클릭 동선도 이미 있다.**
- **셀 하나 닫기의 확정 로직은 ChipMenu 컨테이너에 있다**(`:862-882`):
  - 별도 창(`IS_AGGREGATE_WINDOW`)이고 `tabId == null`(독립 브라우저 탭) → 항목 자체를 뺀다(위임 경로 없음, `:853-855` 주석).
  - 터미널 pane → `askConfirm({danger, onConfirm: closePane(tabId, id)})`.
  - 브라우저 pane → 확인 없이 `closePane`. 독립 브라우저 탭 → `closeBrowserTab(id)`.
- `closePane`은 별도 창에서 `sendTerminalsCmd({op:"closePane"})`로 메인에 위임된다(`stores/terminals.ts:43`, `:466-467`,
  리스너 `:554-561`). 트리가 비면 `closeTab`으로 넘어가 활성 탭 포커스도 정리된다(`:472-475`, `:324-345`).
  `closeTab`·`closeProjectTerminals`(`:347-363`)는 **위임 목록에 없다** — 별도 창에서 직접 부르면 저장되지 않는다.
- `askConfirm`은 별도 창에도 호스트가 있다(`AggregateWindow.tsx:48 <ConfirmHost/>`).
- `MenuItem`(`TerminalPane.tsx:289-314`)에 `danger` prop이 있고 `AggregateTerminals`가 이미 import한다(ChipMenu가 사용).
  드롭다운의 `MenuRow`(`:1216-1234`)는 danger 변형이 없다.
- e2e 14는 탭 모으기 모드를 알고 있다(`:681-685` 개별 칩 없으면 스킵), 모아보기 '새 터미널'(`#11c` `:732`)·
  자동배치(`#11d` `:801`) 절이 있어 픽스처·정리 관례를 그대로 쓴다.

## 3. 설계

### 3.1 항목 위치와 동작

| 대안 | 평가 |
|---|---|
| **A. 묶음 드롭다운 맨 아래에 `MenuItem danger` 1개 — 확인 후 셀별 `closePane`/`closeBrowserTab` 반복** (채택) | 우클릭 동선·드롭다운·확인 호스트·닫기 로직이 전부 있다. 스토어 변경 0, 위임 프로토콜 변경 0 — `closePane`이 이미 위임된다. ≈ +25줄 |
| B. `closeProjectTerminals(projectId)` 호출 | 프로젝트 삭제용이라 `activeTab[projectId]`를 **삭제**해(`:352`) 워크스페이스가 빈 키를 보게 되고, 별도 창 위임이 없어 `TerminalsCmd`·리스너·ROLE 가드 3곳을 늘려야 한다. 독립 브라우저 탭도 안 닫는다 |
| C. `closeTab`을 위임 목록에 추가하고 탭 단위로 닫기 | A보다 호출 수는 적지만 위임 유니언·리스너·`closeTab` ROLE 가드 3줄이 는다. 탭 수는 보통 한 자리 — 호출 수는 문제가 아니다 |
| D. 묶음 칩에 별도 우클릭 메뉴(ChipMenu 계열) 신설 | 우클릭이 이미 드롭다운을 연다(`:504-505` 주석이 그 결정을 적어 뒀다). 메뉴 두 벌은 발견성만 나빠진다 |

**A 채택.** 닫힘 대상 집합은 ChipMenu 컨테이너의 조건(§2)을 그대로 셀마다 적용한다:

```ts
// AggregateTerminals.tsx 드롭다운 IIFE 안 — cells는 이미 계산돼 있다(:754)
const closable = cells.filter((c) => !(IS_AGGREGATE_WINDOW && c.tabId == null));
const closeAll = () => {
  setGroupMenu(null);
  const procs = closable.filter((c) => c.kind === "terminal").length;
  askConfirm({
    title: "탭 모두 닫기",
    message: `'${groupMenu.name}' 탭 ${closable.length}개를 닫을까요?` +
      (procs ? ` 터미널 ${procs}개의 실행 중인 프로세스가 종료됩니다.` : ""),
    confirmLabel: "모두 닫기",
    danger: true,
    onConfirm: () =>
      closable.forEach((c) =>
        c.tabId != null ? closePane(c.tabId, c.id) : closeBrowserTab(c.id),
      ),
  });
};
```

- 확인창은 **항상** 띄운다(브라우저만인 묶음이라도 — 여러 개를 한 번에 없애는 동작이라 단일 셀의 "브라우저는 확인
  없이" 예외를 승계하지 않는다).
- 닫는 순서는 `cells` 순서(탭 생성 순). `closePane`은 같은 탭의 pane을 하나씩 떼다가 마지막에 `closeTab`으로
  넘어가므로 별도 처리 없이 탭이 사라진다. 별도 창에서는 셀마다 `terminals://cmd` 이벤트가 하나씩 가고 메인이
  차례로 `getState()`를 읽어 처리한다 — 이벤트 순서는 tauri `emitTo`가 보존한다 (검증 필요: 4개 이상 pane 탭에서
  마지막 pane의 `closeTab` 전환이 앞선 removePane 결과를 본 상태에서 실행되는지 실기 1회).
- `selected`·`zoomed`에 남는 스테일 id는 기존 X 닫기와 같다 — `shown = all.filter(selected.has)`(`:344`)와
  `zoomed` 정리 효과(`:348-`)가 이미 흡수한다.
- 드롭다운을 먼저 닫는다(`setGroupMenu(null)`) — 확인창이 뜨는 동안 hover 지연 닫기 타이머와 경합하지 않게.

### 3.2 항목 모양

`MenuRow` 대신 **`MenuItem danger`**를 쓴다(이미 import, `text-danger`). `MenuRow`는 `text-fg-muted` 고정이라
danger 변형을 넣으면 두 컴포넌트가 같은 일을 하게 된다. 두 컴포넌트의 패딩·글자 크기가 같아(`px-3 py-1.5`) 한
드롭다운 안에서 줄 높이가 맞는다. 아이콘 `X size={13}`(ChipMenu '터미널 닫기'와 동일).

라벨: **`'{name}' 탭 N개 모두 닫기`** — 토글 버튼 title의 어휘가 "탭"(§2)이고, ChipMenu의 단일 닫기는 "터미널 닫기"
/"브라우저 닫기"로 종류를 부르지만 묶음은 종류가 섞이므로 "탭"으로 부른다. `N`은 `closable.length`.
`closable.length === 0`(별도 창에서 독립 브라우저 탭만 있는 묶음)이면 항목을 **뺀다**(ChipMenu 관례 — 비활성 표시 없음).

### 3.3 드롭다운 높이

행 1개(31.5px)가 늘어난다. 드롭다운은 `max-h-[60vh] overflow-y-auto`라 클램프 상수가 없다 — 24의 하단 클램프 문제는
해당 없음. `top: groupMenu.y`는 칩 바로 아래 고정이라 900px 창에서 60vh=540px 안에 칩 17개까지 스크롤 없이 들어간다.

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/components/AggregateTerminals.tsx` | 드롭다운 IIFE(`:752-800`)에 `closable`·`closeAll` + `MenuItem danger` 1행(`:797` 뒤). `X` 아이콘 import는 이미 있음(ChipMenu) | ≈ +25 |
| `tests/e2e/suites/14-frontend-dom.mjs` | `#11e` 절 추가(§6) | ≈ +45 |

신규 파일 0, 스토어 0, Rust 0.

## 5. 검증

### 5.1 e2e 14 `#11e` (모아보기 열림 상태, `#11d` 뒤·`#12` 앞)

1. 픽스처 프로젝트에 `openTerminal` 2회(`__gpv.terminals`) → 모아보기 셀 ≥ 2.
2. `localStorage["gp:aggregate-group-tabs"]`가 `"0"`이면 헤더 '탭 모으기' 버튼 클릭(DOM 우선 — `__gpv.ui` 스테일 함정, 24 §2.5).
3. 묶음 칩(`button[title^="<픽스처명> — 탭 "]`)에 `contextmenu` 디스패치 → `div.fixed.z-50` 안에 텍스트 `모두 닫기` 포함 버튼 존재 단언, 라벨의 N == 그 프로젝트 셀 수.
4. 클릭 → `ConfirmHost` 다이얼로그(`z-[60]`)의 danger 버튼 "모두 닫기" 클릭.
5. 폴링 5s: `useTerminals.getState().terminals.filter(t => t.projectId === fixture).length === 0`, 묶음 칩 소멸.
6. finally: 탭 모으기 원복(2에서 켰다면 다시 클릭), `#11c`와 같은 정리.

### 5.2 실기

- 메인 안 모아보기: 터미널 2 + 브라우저 pane 1 + 독립 브라우저 탭 1 묶음 → N=4, 확인 문구 "터미널 2개의 … 종료" → 전부 사라짐, 워크스페이스 탭 바도 비고 `viewer`로 포커스.
- 별도 창(aggregate): 같은 구성 → N=3(독립 브라우저 탭 제외), 확인 후 메인 창 탭이 사라지고 별도 창 그리드가 storage 이벤트로 따라온다.
- 4-pane 분할 탭 하나가 묶음일 때 별도 창에서 닫기 → 탭 하나로 정리되는지(§3.1 검증 필요 항목).
- 드롭다운 hover 지연 닫기와 확인창 경합 없음(확인창이 뜬 뒤 드롭다운이 남지 않는다).

## 6. 위험·열린 질문

| 항목 | 내용 | 기본값 |
|---|---|---|
| 위임 순서 | 별도 창에서 셀 N개 → 이벤트 N개. tauri 이벤트는 순서 보존이 관례지만 실측 1회 필요. 어긋나면 C안(closeTab 위임)으로 전환 — 3줄 | A 유지 |
| 브라우저만인 묶음의 확인창 | 단일 브라우저 닫기는 확인이 없다. 묶음은 항상 확인 | 항상 확인 |
| 개별 칩 모드에서도 '프로젝트 탭 모두 닫기'를 줄지 | 요구는 묶음 칩. 개별 칩 ChipMenu에 같은 항목을 넣으면 +6줄 | 넣지 않음 |

## 8. 구현 결과 (2026-09-07)

**구현 완료 · 정적 검증 통과(미커밋).** 설계대로 A안 — 스토어·Rust·위임 프로토콜 변경 0.

- `AggregateTerminals.tsx`: 묶음 드롭다운 IIFE에 `closable`(별도 창 + 독립 브라우저 탭 제외) + `closeAll`
  (드롭다운 닫기 → `askConfirm(danger)` → 셀마다 `closePane`/`closeBrowserTab`) + 맨 아래 `MenuItem danger` 1행
  (`closable.length > 0`일 때만).
- e2e 14 `#11e`(`#11d` 뒤, `#12` 앞): 탭 모으기 ON → 묶음 칩 우클릭 → 라벨 N 대조 → danger 확인 → 탭 0·칩 소멸.
  `#12`가 볼 픽스처 칩을 절 끝에서 하나 되살린다. 탭 모으기 원복은 스위트 `finally`.

**적대적 리뷰(2026-09-07, 리뷰어 3렌즈 → 발견당 반박자 3)에서 확정돼 고친 것:**

| 지적 | 수정 |
|---|---|
| `closeAll`이 `setGroupMenu(null)`만 하고 `hovered`를 안 지워, 드롭다운이 사라진 뒤 셀 ring 강조가 박제된다(확인창 취소 후에도) | `setHovered(NO_HOVER)` 1줄 추가 |
| `MenuItem` 라벨이 줄바꿈돼 §3.2가 전제한 한 줄 31.5px가 깨진다(PaneMenu·ChipMenu의 하드코딩 클램프도 같은 전제) | 공용 `MenuItem` 라벨 span을 `min-w-0 flex-1 truncate`로 |
| e2e의 `menuN === chipN`은 **둘 다 같은 `cells.length`**라 항상 참인 동어반복 | 기대값을 스토어에서 계산(탭 레이아웃 리프 재귀 + 독립 브라우저 탭)해 함께 단언 |
| e2e가 닫기 성공 여부와 무관하게 `tabClosed`를 세우고 `tabId`를 갈아 끼워, 실패 시 살아 있는 픽스처 탭을 finally가 못 닫는다 | `leftTabs === 0`일 때만 플래그·재할당 |

**반박으로 기각된 지적**: "닫기가 `projName` 기준이라 동명 프로젝트를 함께 닫는다" — 드롭다운의 묶음 자체가
`projName` 기준(`:754`)이라 **보이는 것과 닫히는 것이 일치**한다(설계 §3.1 그대로).

**미검증(§5.2 실기)**: 별도 창에서 셀 N개를 닫을 때 `terminals://cmd` N개의 **순서 보존**(어긋나면 §6의 C안),
4-pane 분할 탭의 마지막 pane → `closeTab` 전환, 확인 문구의 프로세스 개수, 드롭다운 지연 닫기와 확인창 경합.
