# 태스크 01 — 터미널 모아보기 토글 단축키 (mac·Windows·Ubuntu 호환)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-02 · 관련: [02-aggregate-new-terminal.md](02-aggregate-new-terminal.md)(같은 뷰의 후속 기능)

## 1. 요구사항

터미널 모아보기(AggregateTerminals)를 키보드로 열고 닫는 **토글 단축키**를 연결한다.
mac(Cmd)·Windows(Ctrl)·Ubuntu(Ctrl) 세 플랫폼에서 모두 자연스럽게 동작해야 한다.

- 토글: 닫혀 있으면 열고, 열려 있으면 닫는다.
- **프로젝트 미선택 상태·모아보기가 이미 열린 상태에서도** 동작해야 한다.
- **터미널(xterm)에 포커스가 있어도** 동작해야 한다(모아보기 그리드 안이 전부 터미널이므로 닫기 경로에 필수).

## 2. 현황(근거)

### 2.1 모아보기 진입/이탈 경로 — 현재 마우스 전용
- 상태: `src/stores/ui.ts:46` `aggregateOpen: boolean`, `:68`/`:132` `setAggregateOpen(open)`. 초기값 false(`:97`), localStorage 영속 없음(세션 상태). 토글 액션은 없고 `toggleLog`(`:66`,`:126`)가 같은 스토어의 토글 전례.
- 진입: `src/components/StatusBar.tsx:49-63` `AggregateButton` — StatusBar는 항상 마운트(`src/App.tsx:119`)이지만 버튼 자체는 `hasTerminals`일 때만 렌더(`:52-53`).
- 이탈: `src/components/AggregateTerminals.tsx:124-130` 헤더의 "닫기" 버튼뿐.
- 모아보기 뷰는 터미널 0개여도 자체 EmptyState를 갖는다(`AggregateTerminals.tsx:134-143`) — 단축키로 "빈 상태" 진입해도 UX가 깨지지 않음.

### 2.2 기존 단축키 등록 위치 — 모아보기 토글을 둘 수 없음
- `src/components/KeyboardShortcuts.tsx:12-83`: window keydown 전역 리스너 1회 등록. **`e.ctrlKey`만 검사(`:33`), metaKey 미검사 → mac에서 Cmd 미지원.**
- 마운트 조건이 문제: `src/App.tsx:97-115`에서 `aggregateOpen ? <AggregateTerminals/> : selected ? <>… <KeyboardShortcuts/> …</> : <EmptyState/>` — 즉 **모아보기가 열리면 KeyboardShortcuts가 언마운트**된다. 여기에 토글을 넣으면 "열기만 되고 닫기는 안 되는" 단축키가 된다. 프로젝트 미선택 시에도 언마운트.
- 항상-마운트 전역 리스너의 전례는 이미 있음: `src/components/sidebar/ProjectList.tsx:176-197` Ctrl+Shift+↑/↓ 프로젝트 이동(ref로 최신 상태 참조, 리스너 1회 등록 패턴).

### 2.3 xterm 포커스 시 키 전달 — 화이트리스트 필요
- `src/lib/terminal-engine.ts:76-173` `attachCustomKeyEventHandler`: 터미널 포커스 중 keydown은 기본적으로 xterm/PTY가 소비한다. 앱 단축키는 **명시적으로 `return false` 화이트리스트**를 통과해야 window 핸들러까지 버블된다 — Ctrl+\`(`:122`), Ctrl+Shift+D/E/W(`:123`), Ctrl+Shift+↑/↓(`:125-126`)가 그 방식. **신규 단축키도 여기에 한 줄 추가하지 않으면 터미널 포커스 중 무시된다.**
- 터미널이 이미 소비 중인 키(충돌 목록에 반영): Tab/Shift+Tab→PTY(`:84-91`), Ctrl+W 패널 닫기(`:130-139`), Ctrl+Shift+C·선택 시 Ctrl+C 복사(`:142-148`), Ctrl+V/Ctrl+Shift+V 붙여넣기(`:150-154`).

### 2.4 플랫폼 감지 현황
- `@tauri-apps/plugin-os` **미설치** — `package.json:23-45` 의존성에 없음.
- UA 스니핑이 이미 코드베이스 표준: `terminal-engine.ts:23` `/Linux/`, `:26` `/Mac/i`, `SettingsDialog.tsx:24`, `TitleBar.tsx:10`, `GitGate.tsx:7-10`, `agent-notify.ts:31` `/Windows/i` — 6곳에서 각자 중복 선언 중(공용 헬퍼 없음).

### 2.5 기존 단축키 전수 목록(충돌 검사 기준)
| 키 | 동작 | 근거 |
|---|---|---|
| F5 | 새로고침 | KeyboardShortcuts.tsx:28 |
| Ctrl+K / Ctrl+Shift+K | 커밋 / 푸시 | KeyboardShortcuts.tsx:58-62 |
| Ctrl+T | pull | KeyboardShortcuts.tsx:63-65 |
| Ctrl+\` | 터미널 토글 | KeyboardShortcuts.tsx:66-79 |
| Ctrl+Shift+D / E / W | 분할 행/열 / 패널 닫기 | KeyboardShortcuts.tsx:38-56 |
| Ctrl+Shift+↑/↓ | 프로젝트 위/아래 이동 | ProjectList.tsx:181-197 |
| Ctrl+W (터미널 내) | 포커스 패널 닫기 | terminal-engine.ts:130-139 |
| Ctrl(+Shift)+C / Ctrl(+Shift)+V (터미널 내) | 복사 / 붙여넣기 | terminal-engine.ts:142-154 |
| Escape | 메뉴/다이얼로그 닫기 | ProjectList.tsx:203 외 |

## 3. 설계

### 3.1 키 선택 — 후보 비교

| 후보 | 판정 | 근거 |
|---|---|---|
| **mod+Shift+A** | **채택** | Aggregate 니모닉. 앱 내 미사용(§2.5). 터미널 의미 충돌 없음(Ctrl+Shift+A는 쉘/TUI 관례 없음 — Ctrl+A 제어문자와 구분됨). WebView2 예약 아님(Chromium의 Ctrl+Shift+A "탭 검색"은 탭 없는 WebView2에 부재)(검증 필요). macOS 기본 메뉴는 Cmd+A(전체선택)만 있고 Cmd+Shift+A 없음(검증 필요). WebKitGTK 예약 없음(검증 필요). |
| mod+G | 기각 | Ctrl+G는 PTY 제어문자(BEL)로 쉘/TUI(readline 검색 취소 등)가 실사용 — 터미널에서 가로채면 안 됨. mac Cmd+G는 "다음 찾기" 관례. |
| mod+Shift+T | 기각 | 브라우저 "닫은 탭 복원" 근육기억 + Ctrl+T가 이미 pull이라 T 계열 의미 혼선. |
| mod+Shift+M | 기각 | 가능하나 mac Cmd+M(최소화) 인접이라 오타 위험, 니모닉(모아보기)이 한국어 전용. |
| Escape(닫기 보조) | 기각 | 모아보기 그리드는 터미널이 포커스를 가짐 — Esc는 Claude Code 중단 키(에이전트 감지 마커 "esc to interrupt")라 절대 가로채면 안 됨. |

**채택: `mod+Shift+A`** — mac=`Cmd+Shift+A`, Windows/Ubuntu=`Ctrl+Shift+A` 자동 매핑.

### 3.2 플랫폼 mod 키 추상화 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **`src/lib/platform.ts` 신설(UA 기반)** | **채택** | Tauri는 웹뷰가 플랫폼별 고정(WebView2="Windows NT" / WKWebView="Mac" / WebKitGTK="Linux")이라 UA 판별이 결정적. 이미 6곳에서 검증된 방식(§2.4). 의존성 0, 동기적(초기 렌더에서 즉시 사용 가능). |
| `@tauri-apps/plugin-os` 도입 | 기각 | boolean 하나를 위해 JS+Rust 플러그인·capability 설정 추가는 과잉. 기존 UA 스니핑 6곳과 이원화됨. |
| `tauri-plugin-global-shortcut` | 기각 | **OS 전역** 단축키 — 앱이 백그라운드일 때도 발동해 다른 앱의 키를 시스템 전체에서 가로챈다. in-app UI 토글에 부적합·과잉. in-app keydown은 포커스된 앱에서만 동작하는 올바른 스코프. |

### 3.3 등록 위치 — 대안 비교

| 대안 | 판정 | 근거 |
|---|---|---|
| **항상-마운트 `GlobalShortcuts` 컴포넌트(App 레벨)** | **채택** | §2.2 실측대로 KeyboardShortcuts는 모아보기 열림/프로젝트 미선택 시 언마운트 → 토글 불가. GitGate 내부(ProjectList·StatusBar와 형제)에 두면 git 부재 안내 화면에선 비활성(모아보기 자체가 없으므로 올바름). ProjectList.tsx:181-197과 동일한 "리스너 1회 등록 + 최신 상태 참조(그쪽은 ref, 여기선 getState)" 패턴 재사용. |
| 기존 KeyboardShortcuts 확장 | 기각 | 마운트 조건이 요구사항과 모순(§2.2). 마운트 조건을 App 전체로 올리는 리팩터링은 projectId 의존 단축키 전부에 null 처리가 필요해 이 태스크 범위 초과. |
| StatusBar(AggregateButton)에 등록 | 기각 | 버튼은 `hasTerminals`일 때만 렌더(§2.1) — 터미널 0개면 리스너도 사라짐. 표시 컴포넌트에 입력 정책 결합. |

### 3.4 동작 정의
- `toggleAggregate()`: `aggregateOpen`을 반전. `toggleLog`(ui.ts:126) 미러.
- 터미널 0개여도 열린다 — 뷰 자체가 EmptyState로 안내(§2.1). 버튼(터미널 있을 때만 노출)과 달리 단축키는 조건 없이 동작해 "안 먹는 것처럼 보이는" 상태를 만들지 않는다.
- 발견성: StatusBar 버튼과 모아보기 닫기 버튼의 `title`에 플랫폼별 라벨(`⌘⇧A` / `Ctrl+Shift+A`)을 병기.
- xterm 통과: terminal-engine의 화이트리스트에 `mod+Shift+A` 한 줄 추가(§2.3) — PTY로 보내지 않고 window로 버블.
- 키 매칭은 기존 관례대로 `e.key`(레이아웃 문자) 기준 — `e.key.toLowerCase() === "a"`는 Shift로 대문자가 와도 일치. `e.code`(물리 키) 전환은 기존 단축키 전체와의 일관성 문제라 비채택.

### 3.5 범위 절단 (YAGNI)
- **v1**: 모아보기 토글 1키 + platform 헬퍼 + xterm 통과 + title 병기.
- **후속**: ① 기존 단축키 전체의 mac Cmd 매핑 이행(Ctrl+K/T/\` 등 — `isMod` 헬퍼가 기반이 됨), ② 단축키 목록 도움말/치트시트 UI, ③ 사용자 정의 키 바인딩(설정 저장) — 현재 요구 없음.

## 4. 계약(타입·커맨드·이벤트)

**백엔드 변경 없음** — Tauri 커맨드/이벤트/Rust 신규 0. 전부 프론트엔드.

```ts
// src/lib/platform.ts (신설) — UA 기반 플랫폼/모디파이어 추상화.
// 기존 6곳의 중복 UA 스니핑(§2.4)의 단일 출처가 된다(기존 코드 이행은 후속).
export const isMac: boolean;                       // /Mac/i.test(navigator.userAgent)
export const isLinux: boolean;                     // /Linux/.test(navigator.userAgent)
/** 플랫폼 표준 모디파이어 — mac=metaKey(Cmd), 그 외=ctrlKey(Ctrl) */
export function isMod(e: KeyboardEvent): boolean;
/** UI 표기용 라벨 — mac="⌘", 그 외="Ctrl" (title/툴팁 병기용) */
export const modLabel: string;
```

```ts
// src/stores/ui.ts — toggleLog(:66/:126) 미러
interface UiState {
  toggleAggregate: () => void;   // set((s) => ({ aggregateOpen: !s.aggregateOpen }))
}
```

```ts
// src/components/KeyboardShortcuts.tsx — 신규 export. App.tsx에서 GitGate 내부에
// 무조건 마운트(StatusBar와 형제). window keydown 1회 등록, useUi.getState()로 최신 상태 참조.
export function GlobalShortcuts(): null;
// 핸들러 규칙: isMod(e) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "a"
//   → e.preventDefault(); useUi.getState().toggleAggregate();
```

```ts
// src/lib/terminal-engine.ts — attachCustomKeyEventHandler 화이트리스트(:120-126 블록)에 추가.
// 모아보기 토글은 PTY로 보내지 않고 window 핸들러로 흘려보낸다.
if (isMod(e) && e.shiftKey && k === "a") return false;
```

## 5. 단계(구현 순서)

1. **`src/lib/platform.ts` 신설** — `isMac`/`isLinux`/`isMod`/`modLabel`. (~10 LOC)
2. **`ui.ts`에 `toggleAggregate` 추가** — 인터페이스+구현 2줄.
3. **`GlobalShortcuts` 작성·마운트** — KeyboardShortcuts.tsx에 co-locate, App.tsx의 GitGate 내부(조건 분기 바깥)에 `<GlobalShortcuts />` 추가. (~20 LOC)
4. **xterm 통과 1줄** — terminal-engine.ts 화이트리스트 블록에 `mod+Shift+A` 추가(platform.ts의 `isMod` 사용).
5. **발견성** — StatusBar.tsx:57과 AggregateTerminals.tsx:126의 `title`에 `modLabel` 기반 단축키 병기.
6. **E2E** — `tests/e2e/suites/14-frontend-dom.mjs` 확장: 기존 합성 keydown 패턴(:70,:79)으로 `Ctrl+Shift+A` 디스패치 → 모아보기 DOM("터미널 모아보기" 헤더) 출현 확인 → 재디스패치 → 사라짐 확인. 터미널 textarea 포커스 상태에서도 1회 검증(:134의 Ctrl+W 검증 패턴 미러).

규모: **S** — 프론트 ~40 LOC + 테스트. 백엔드 0.

## 6. 위험과 완화

| 위험 | 설명 | 완화 |
|---|---|---|
| 네이티브 브라우저 패널 포커스 중 무반응 | 브라우저 탭은 별도 네이티브 child webview라 keydown이 메인 웹뷰 window에 도달하지 않음 — 그 순간엔 단축키가 안 먹는다 | 구조적 한계로 수용(기존 단축키 전부 동일 조건). 문서/title로 안내. 크로스-웹뷰 키 포워딩은 과잉(비채택) |
| mac 실기 미검증 | 채택 근거는 macOS 메뉴/WKWebView 관례 조사 기반 — Cmd+Shift+A가 WKWebView에서 keydown으로 도달하는지 실기 확인 필요(Tauri 기본 메뉴에는 해당 항목 없음이 근거) | mac 스모크 테스트 1회를 릴리스 체크리스트에 포함. 도달 실패 시 메뉴 아이템 accelerator 등록으로 폴백(후속) |
| Monaco/입력 필드 포커스 중 키 삼킴 | Monaco가 자체 keybinding으로 keydown을 소비할 가능성 — 단 Ctrl+Shift+A는 Monaco 기본 바인딩에 없음(추정) | E2E 6단계에서 뷰어 포커스 케이스 추가 검증. 문제 시 capture-phase 리스너로 전환(현 설계는 기존 패턴과 같은 bubble) |
| 기존 단축키와의 mac 비대칭 | 이번 키만 Cmd 매핑되고 기존 키(Ctrl+K 등)는 mac에서도 Ctrl 그대로 — 일시적 UX 비일관 | `isMod` 헬퍼가 이행 기반. 기존 키 Cmd 이행은 후속 태스크로 명시(§3.5) |
