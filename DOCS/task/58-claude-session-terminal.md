# 태스크 58 — "새 터미널" 아래 "Claude 세션으로 새 터미널" — 열자마자 `claude`를 실행하는 터미널

> 상태: **설계** (2026-09-07) · 대상: gitpervisor · 근거: 코드 실측 2026-09-07(워킹트리 기준) ·
> 선행: 태스크 02(모아보기 새 터미널), 32(Claude Code 줄바꿈 키) · **Rust 변경 0**

## 1. 요구사항

"새 터미널" 메뉴 항목 바로 아래에 **"Claude 세션으로 새 터미널"** 이 있다. 누르면 새 터미널이 열리고 셸 프롬프트에
`claude`가 입력·실행돼 바로 Claude Code 세션이 뜬다.

받아들이는 조건:
- 워크스페이스 탭 바 `+` 메뉴(`새 터미널` 아래)와 모아보기 헤더 `+` 메뉴(`새 터미널` 아래) 둘 다.
- 셸 종류(pwsh/cmd/bash/zsh)와 무관하게 동작 — 셸이 뜬 뒤 `claude⏎`를 **입력**하는 방식.
- 모아보기 **별도 창**에서 눌러도 동작(터미널을 어느 창이 spawn하든).
- `claude`가 PATH에 없으면 셸이 "command not found"를 찍는다 — 앱은 별도 처리하지 않는다(사용자가 즉시 본다).

## 2. 현황(근거)

- 진입점: 워크스페이스 `NewTabControls`(`WorkspaceTabs.tsx:279-350`, `MenuItem` "새 터미널" `:321-328` → `onNewTerminal` =
  `openTerminal(projectId)` `:159`), 모아보기 `NewCellButton`(`AggregateTerminals.tsx:1081-1199`, `kind === null`일 때
  "새 터미널"/"새 브라우저" `MenuRow` `:1164-1176` → `pickKind` → 프로젝트 선택 → `onCreateTerminal(projectId)` = `addTerminal` `:297-302`).
- `openTerminal(projectId, ids?) → {tabId, paneId}`(`stores/terminals.ts:201-204, :298-322`) — 탭·리프만 만든다. **PTY spawn은
  pane이 마운트될 때** `createTerminal`(`TerminalPane.tsx:74-76`, `AggregateCell :1269-1275`) → `createTerminalImpl`
  (`terminal-engine.ts:184`) → `term_open`(`:607-615`). 별도 창에서는 `openTerminal`이 메인에 위임되고(`:301-304`,
  paneId는 요청 창이 생성) **어느 창이 먼저 마운트하느냐**에 따라 그 창이 `term_open`, 나머지는 `term_attach`
  (`lib/terminal.ts:110-129` `sessionExists` 판정).
- `term_open`(`terminal.rs:131-140`)에 **명령·초기 입력 인자가 없다**. 셸·cwd는 서버가 정한다(`:141-147, :736-762`).
- PTY 쓰기: `term_write(term_id, data)`(`:295-310`) ← 프론트 `ptyWrite(termId, data)`(`terminal-engine.ts:79-93`, **모듈
  비공개**), `term.onData → ptyWrite`(`:645`). 쓰기 체인은 `term_open` 완료로 시드된다(`:633-638` — open 전 쓰기가 유실되던
  레이스의 수정). 유일한 외부 주입 경로는 `pasteIntoTerminal`(`lib/terminal.ts:257-275`, xterm `paste()` → bracketed paste
  래핑 — PSReadLine은 붙여넣은 개행을 **실행하지 않고 삽입**하므로 명령 실행용으로 부적합).
- xterm 6.0은 `term.onWriteParsed`(출력이 파서를 통과한 뒤 발화)를 제공한다 — "셸이 무언가 찍었다"의 신호로 쓸 수 있다.
- 기존 Claude 감지는 화면 정규식뿐(`agentActivity.ts:67`), 프로세스 감지 없음. `ai-working` 글로우가 탭·칩·셀에 붙는다.

## 3. 설계

### 3.1 명령을 넣는 방법

| 대안 | 평가 |
|---|---|
| **A. 프론트 — paneId별 "초기 입력"을 예약해 두고, `createTerminalImpl`이 `term_open` 완료 **+ 첫 출력 파싱 후** `ptyWrite(id, "claude\r")`** (채택) | Rust 0. 셸 무관(키 입력과 동일 경로). 쓰기 체인·open 레이스 수정을 그대로 탄다. 첫 출력(배너/프롬프트) 뒤에 보내므로 셸이 아직 입력을 못 받는 극초기 구간을 피한다 |
| B. `term_open`에 `initial_command` 인자 → Rust가 spawn 직후 PTY에 쓰기 | Rust 변경 + 셸이 뜨기 전 ConPTY 입력 버퍼에 쌓이는 동작이 셸·플랫폼마다 (검증 필요). A가 같은 바이트를 더 늦고 안전한 시점에 보낸다 |
| C. 셸 인자로 실행(`pwsh -NoExit -Command claude`, `bash -c "claude; exec bash"`) | 셸 4종 × 플랫폼 분기. `resolve_shell` 구조 변경 |
| D. `pasteIntoTerminal("claude\n")` | bracketed paste로 감싸여 PSReadLine·zsh가 개행을 실행하지 않는다 |

### 3.2 예약 저장소 — localStorage(창 간 공유)

별도 모아보기 창에서 누르면 `openTerminal`은 메인에 위임되고 셀은 그 창에서 마운트되지만, **메인 창의 `TerminalPane`도
같은 탭을 그리므로** 어느 창이 `term_open`을 잡을지 경합한다(§2). 예약이 한 창의 메모리에만 있으면 다른 창이 spawn한
경우 명령이 사라진다. → `gp:term-initial-input`(`Record<paneId, string>`)에 두고 **open을 수행한 창이 소비·삭제**한다
(`gp:doc-windows`·`gp:prompt-panel-open`과 같은 창 간 전달 관례).

```ts
// lib/terminal.ts
const INITIAL_KEY = "gp:term-initial-input";
export function queueInitialInput(paneId: string, data: string) { /* read-modify-write */ }
export function takeInitialInput(paneId: string): string | null { /* read, delete, write */ }
```
`term_attach` 경로(`opts.attach`)는 소비하지 않는다 — open한 창이 보낸다. 앱이 죽어 소비되지 않은 항목은 다음 부팅의
`createTerminalImpl`이 같은 paneId를 복원할 때(세션 복구는 attach가 아니라 **새 open**이다 — `terminal.rs:264-271`) 소비된다 —
"재시작 후 그 탭이 다시 claude를 띄운다"는 부수효과. 이를 막기 위해 예약에 `at: Date.now()`를 넣고 **60초 지나면 버린다**.

### 3.3 `createTerminalImpl` 훅 (`terminal-engine.ts:633-638` 뒤)

```ts
const initial = opts.attach ? null : takeInitialInput(opts.id);
if (initial) {
  // 셸이 첫 출력을 찍은 뒤에 보낸다 — 프롬프트가 아직 안 뜬 극초기에 쓰면 셸 초기화가 삼킬 수 있다(pwsh PSReadLine).
  // onWriteParsed는 출력이 xterm 파서를 통과할 때마다 발화 — 첫 발화에서 한 번만.
  const d = term.onWriteParsed(() => { d.dispose(); void opened.then(() => ptyWrite(opts.id, initial)); });
}
```
- 보낼 바이트: **`"claude\r"`** — `\r`이 Enter(키 입력과 동일, 32의 Shift/Alt+Enter와 무관).
- 첫 출력이 프롬프트가 아니라 배너(pwsh 로고는 `-NoLogo`로 꺼져 있다 `:747-762`)여도 그 뒤 입력은 ConPTY 버퍼에 남아 셸이
  준비되면 읽는다 (검증 필요 — pwsh/cmd/zsh 각 1회, §5.2).

### 3.4 메뉴

- `WorkspaceTabs.tsx:328` 뒤 `MenuItem icon={<Sparkles size={14}/>} label="Claude 세션으로 새 터미널"` → `onNewClaude` prop →
  `:159` 옆 `const { paneId } = openTerminal(projectId); queueInitialInput(paneId, "claude\r")`. **순서**: `openTerminal`이 동기로
  스토어를 갱신하고 pane 마운트는 다음 커밋이므로 예약이 먼저 저장된다(같은 틱).
- `AggregateTerminals.tsx:1164-1176` `MenuRow` "Claude 세션 터미널"(kind `"claude"`) → 프로젝트 선택 머리말 "Claude 세션 —
  프로젝트 선택" → `onCreateTerminal(projectId, { claude: true })` → `addTerminal`이 `openTerminal` 직후 `queueInitialInput`.
  별도 창에서도 `paneId`는 요청 창이 생성하므로(`:301-304`) 예약 키가 맞다.
- 라벨 어휘: 앱은 "Claude Code 작업 중…"(`ProjectItem.tsx:138-160`)처럼 "Claude Code"를 쓴다 → 항목 라벨 **"Claude Code 세션으로 새 터미널"**.
- 명령 문자열은 `lib/terminal.ts`의 `CLAUDE_LAUNCH = "claude\r"` 상수 1곳(§7 설정화 여부).

## 4. 변경 목록

| 파일 | 변경 | 규모 |
|---|---|---|
| `src/lib/terminal.ts` | `queueInitialInput`·`takeInitialInput`·`CLAUDE_LAUNCH` | ≈ +28 |
| `src/lib/terminal-engine.ts` | open 완료·첫 출력 뒤 초기 입력 1회 | ≈ +8 |
| `src/components/workspace/WorkspaceTabs.tsx` | 메뉴 항목 + `onNewClaude` | ≈ +12 |
| `src/components/AggregateTerminals.tsx` | `NewCellButton` kind 3종·`addTerminal` 옵션 | ≈ +14 |
| `tests/e2e/suites/14-frontend-dom.mjs` | `#13` 절 | ≈ +35 |

## 5. 검증

### 5.1 e2e 14 `#13`
1. `+` 버튼 → 메뉴에 "Claude Code 세션으로 새 터미널" 존재(새 터미널 **다음** 항목) → 클릭.
2. 새 탭 paneId 확보 → `localStorage["gp:term-initial-input"]`에 그 키가 **잠깐** 생겼다가 소비돼 사라짐(폴링 5s에서 부재 단언).
3. `__gpv.term.get(paneId).term` 버퍼 폴링 10s: 어느 줄에 `claude`가 에코됨(claude 미설치 머신이면 뒤이어 not found — 단언은 에코까지).
4. 모아보기 `+` → "Claude Code 세션 터미널" → 프로젝트 선택 → 같은 단언.
5. finally: 탭 닫기(claude가 실제로 떴다면 `closeTab`이 PTY 트리를 종료).

### 5.2 실기(검증 필요 항목)
- Windows pwsh 7 / Windows PowerShell 5 / cmd, Linux zsh·bash 각 1회: 새 터미널이 뜬 뒤 1초 내 Claude Code TUI 진입, 입력 에코 중복·유실 없음.
- 별도 모아보기 창에서 실행 → 메인 창이 spawn한 경우에도 명령 전달(localStorage 경유) — 두 창 중 어느 쪽이 open했는지는 `term_open` 로그로 확인.
- 앱 강제 종료 후 재시작(세션 복구) → 60초 만료로 `claude`가 다시 뜨지 않음.

## 6. 위험

- 첫 출력 시점에 셸이 아직 입력을 읽지 않는 셸이 있으면(예: 무거운 zsh 플러그인) 입력은 PTY 버퍼에서 대기 — 유실은 아니다.
  반대로 셸 초기화가 입력 버퍼를 **비우는** 경우(`stty -echo` 류 스크립트)면 유실. 실측으로 확정, 실패 시 300ms 지연 추가.
- 예약이 localStorage라 같은 identifier의 두 프로세스(CLAUDE.md의 dev 함정)는 이 키도 공유한다 — dev identifier 분리로 이미 해결.

## 7. 열린 질문

| 질문 | 기본값 |
|---|---|
| 명령을 설정으로(`claudeCommand`, 예: `claude --continue`) | 상수. 원하면 Settings 필드 1 + `SETTINGS_INDEX` 1 + `TerminalSection` 입력 1 |
| 탭 제목을 "Claude N"으로 | 그대로 "터미널 N" — `openTerminal`에 제목 인자가 없고 `ai-working` 글로우가 구분한다 |
| 툴바 터미널 버튼(Ctrl+`)에도 Claude 변형(Ctrl+Shift+`) | 없음 |

## 8. 구현 결과 (2026-09-07)

**구현 완료 · 정적 검증 통과(미커밋).** Rust 변경 0.

- `lib/terminal.ts`: `CLAUDE_LAUNCH`("claude\r") · `queueInitialInput`/`takeInitialInput`
  (`gp:term-initial-input`, `{data, at}` + 60초 만료 — 세션 복구 시 재실행 방지).
- `lib/terminal-engine.ts`: `writeChains.set` 뒤에서 예약을 소비(attach 제외), 아래 조건이 맞으면 1회 `ptyWrite`.
- `WorkspaceTabs` `+` 메뉴에 "Claude Code 세션으로 새 터미널"(새 터미널 바로 아래), 모아보기 `NewCellButton`에 종류 3종.
- e2e 14 `#13` — 두 진입점 각각 탭 생성 + `claude` 에코 + 예약 소비 확인.

**적대적 리뷰(2026-09-07)에서 확정돼 고친 것 — 설계의 핵심 가정이 틀렸다:**

| 지적 | 수정 |
|---|---|
| **§3.3의 "셸이 첫 출력을 찍은 뒤" 가드가 Windows에서 무의미하다.** ConPTY는 spawn 즉시 `\x1b[?9001h`를 보내므로(`terminal-engine.ts:238-243`에 이미 적혀 있던 사실) `onWriteParsed` 첫 발화는 **셸 출력이 아니다** → `claude\r`가 설계가 피하려던 극초기 구간에 그대로 나간다 | 판정 기준을 **"화면에 글자가 생겼는가"**(`buffer.active`의 비공백 줄)로 바꿨다. 조용한 셸을 대비해 3초 상한 폴백 |
| `term_open`이 **실패해도** 초기 입력이 나간다 — 실패 배너 `writeln` 자체가 파싱을 유발하고 `opened`는 거절을 삼킨다. 세션이 없어 쓰기는 버려지고 프롬프트 기록에 유령 "claude" 항목만 남는다 | 전송을 `startCmd`의 **성공 분기에만** 연결 |
| 별도 창에서 종류 지름길을 없앤 탓에 `+` 버튼 title이 실제 메뉴와 어긋난다 | title·주석을 "새 터미널 · Claude Code 세션 터미널"로 |
| e2e 에코 폴링 33×300(10초)이 이 스위트의 새 pane 대기 관례(60×300=18초)보다 짧다 — 체인이 더 긴데도 | 60×300으로. 더해 `ensureFixture()` 선행 + 두 탭의 `projectId === fix.projectId` 단언 추가 |

**설계와 다른 점**: `onCreateTerminal(projectId, claude?: boolean)`(옵션 객체 대신 불리언), 모아보기 라벨은
"Claude Code 세션 터미널". **알려진 부수효과**: 주입된 `claude`가 `capturePtyInput`을 거쳐 그 세션의 프롬프트
목록 첫 항목이 된다 — 실제로 그 터미널에 들어간 입력이므로 그대로 둔다.

**미검증(§5.2 실기)**: pwsh7 / Windows PowerShell 5 / cmd / zsh / bash 각각의 입력 타이밍(셸 초기화가 입력
버퍼를 비우면 유실 → 300ms 지연 추가), 별도 창이 요청하고 메인이 spawn한 경우의 localStorage 전달,
강제 종료 후 세션 복구에서 60초 만료.
