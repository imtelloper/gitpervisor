# 태스크 78 — 재시작해도 하던 그대로: Claude 세션 이어서 열기 · 모아보기 복원

> 상태: **구현 완료** (2026-11-06) · 근거: 코드·`~/.claude/sessions` 실측(2026-11-06, 조사 4갈래)

## 1. 요구사항

1. Gitpervisor 를 업데이트·재시작하면 각 터미널에서 돌던 Claude Code 세션을 **그 터미널에서 자동으로 이어서 연다**
   (지금은 사용자가 터미널마다 `claude` → `/resume` 으로 하나씩 다시 찾는다 — 2026-11-06 08:55 실측: 앱 기동 40초 안에 5개를 손으로 다시 켰다).
2. 모아보기를 **작업하던 그대로** 되살린다 — 열려 있었는지(메인 안 / 별도 창), 숨긴 칩·열어 둔 칩("5/8 선택",
   `nqvm-web 0/1`), 확대한 칸, 별도 창의 위치·크기·최대화.

## 2. 실측·코드 사실

- 실행 중인 Claude 는 `<CLAUDE_CONFIG_DIR 또는 ~/.claude>/sessions/<pid>.json` 에 `{pid, sessionId, cwd(실행 위치), kind:"interactive",
  procStart, startedAt, status:"busy"|"idle", name, …}` 를 둔다. `procStart` = Windows 프로세스 생성 FILETIME(100ns, 10진 문자열) —
  `GetProcessTimes` 값과 정확히 같다. **프로세스가 죽으면 파일도 사라진다**(재시작 뒤 이전 항목 0개). Claude 안에서 `/resume`·`/clear`
  하면 같은 pid 의 `sessionId` 가 바뀐다 → 실행 시점이 아니라 **살아 있는 프로세스에서** 읽어야 한다. `.key` 파일은 읽지 않는다.
- 프로세스 계보(이 기계): `gitpervisor.exe → pwsh.exe(PTY 셸) → claude.exe`. npm 설치면 `pwsh → cmd → node`(2단), npx 는 3~4단.
- 같은 폴더(`D:\DEVELOPMENT\nqvm-vis`)에 세션 4개 — **cwd 로는 못 가른다, 프로세스 계보가 필요하다.**
- `TerminalSession.pid`(commands/terminal.rs) = 셸 pid, `AppState.terminals` 키 = termId = paneId. paneId 는 `gp:terminals` 와 함께
  영속되는 UUID 라 재시작해도 같다.
- 종료 경로는 전부 `lib.rs shutdown_children()` 하나를 지난다(창 닫기·`RunEvent::Exit`·업데이트 `prepare_relaunch`·Linux 시그널).
  거기서 PTY 가 먼저 죽는다(`kill_all`) → **대응표는 그 앞에서 찍어야 한다.** 업데이트 경로는 그 뒤 NSIS 가 `exit(0)` 한다.
- 복원된 터미널은 **화면에 붙을 때만** 셸을 띄운다(선택된 프로젝트의 활성 탭·모아보기에 보이는 칸). 셸은 항상 프로젝트 루트에서 뜬다.
  `queueInitialInput` 은 60초 TTL 이라 나중에 여는 탭의 재개를 잃는다 → 재개는 **따로, 한 번만 꺼내 쓰는 저장소**로 간다.
- 사용자는 옵션 없이 `claude` 만 띄운다(5개 전부 인자 없음). 모델·권한 모드·TUI 는 `settings.json` 에서 온다 → `claude --resume <id>` 면 충분.
  다른 폴더에서 `--resume` 하면 Claude 가 거절한다("This conversation is from a different directory") → **실행 위치로 먼저 이동**.
- 모아보기: 칩 선택(`AggregateTerminals.tsx` useState)·확대·열림 여부·별도 창 위치는 영속되지 않는다. 배치 모드·칸 크기·순서·탭 모으기·
  칸별 프롬프트 목록(`gp:prompt-panel-open`)은 이미 영속된다. 메인 안 모아보기와 별도 창은 동시에 열리지 않는다.
- 함정: 업데이트 경로에서 `shutdown_children` 이 별도 창을 닫으면 메인(JS 살아 있음)이 `aggregate-window://state {open:false}` 를 받아
  "사용자가 닫음"과 구별이 안 된다.

## 3. 설계

### D1. 백엔드 `src-tauri/src/claude_resume.rs`(신규)

**대응표 계산** `fn live_claude_by_term(state) -> HashMap<termId, ResumeRec>`
- `ResumeRec { session_id, cwd, name: Option, updated_at_ms }` (serde camelCase).
- 셸 pid 표: `state.terminals` 락 안에서 `(pid → termId)` 만 복사하고 바로 놓는다(pid 0 제외).
- `claude_config_dir()/sessions/*.json` 만 읽는다(확장자 정확히 `json`). 파싱 실패(다시 쓰는 중)는 이번 회차만 건너뛴다. `kind != "interactive"` 제외.
- 신원 확인(재사용 pid 방지): Windows = `GetProcessTimes` 생성 시각 == `procStart`. Unix = 프로세스 시작 초가 `startedAt/1000` 의 [-60, +1]초 안.
- 부모 사슬을 최대 6단 올라가 셸 pid 를 만나면 그 터미널 — 같은 터미널에 둘이면 단수가 적은 쪽. 부모 생성 시각 ≤ 자식 생성 시각(오래된 ppid 방지).
- OS 별 부모 pid: Windows `crate::health::probe::process_entries()`(Toolhelp 한 번, 실측 16ms) · Linux `/proc/<pid>/stat`(마지막 `)` 뒤
  [1]=ppid, [19]=starttime) · macOS `sysinfo`(`ProcessesToUpdate::Some(&[pid])`)나 `libc::proc_pidinfo`. tmux·ssh·WSL 은 못 잇는다 — 추측하지 말고 뺀다.
- 같은 sessionId 가 두 터미널에 잡히면 하나만 남긴다(`updatedAt` 최신).

**저장** — `<data_dir>/claude-resume.json`(`state.rs` 의 데이터 디렉터리 — e2e `GPV_DATA_DIR` 를 탄다), `{ version:1, savedAtMs, panes: {termId: ResumeRec} }`.
- 메모리 상태 `pending`(지난 실행에서 넘어와 아직 안 꺼낸 것, 부팅 때 파일에서 읽음) · `inflight`(꺼낸 지 90초 안 — 재개 명령이 도는 사이) · `live`(지금 계산).
- 스냅샷 = `live` ∪ (`inflight` 중 live 에 없는 것) ∪ (`pending` 중 PTY 가 아직 안 뜬 터미널). 단 **PTY 가 떠 있는데 Claude 가 없으면 뺀다**(사용자가 Claude 를 끄고 셸로 돌아온 것).
- 주기: 백그라운드 스레드 20초마다 계산 → **바뀌었을 때만** 원자적으로 쓴다(임시 파일 → rename). 그리고 `shutdown_children` 의 **맨 앞(kill_all 전)** 에서 한 번 더(동기, 실패해도 종료를 막지 않는다).
- `pending` 은 14일 지나면 버린다(닫힌 터미널의 찌꺼기 상한).

**커맨드**
- `claude_resume_take(term_id) -> Option<ResumeRec>` (`#[tauri::command(async)]`, 상태 변경이라 TS 는 `callMutating`): `pending` 에서 꺼내 `inflight` 로 옮기고 돌려준다. 단 다음이면 None(꺼내기는 한다):
  설정 `resume_claude_on_restart` 꺼짐 · 같은 sessionId 가 **지금 다른 Claude 프로세스에서 살아 있음**(레지스트리 + 신원 확인) · `cwd` 가 폴더가 아님.
- `claude_resume_forget(term_id)` (`callMutating`): 터미널을 영구히 닫을 때(`dropPane`) pending·inflight 에서 지운다.
- 설정: `Settings.resume_claude_on_restart: bool`, 기본 **true**(`git/types.rs`, serde default — 마이그레이션 불필요).
- 로그(UTC): 부팅 때 `pending N개`, 스냅샷 쓸 때 개수, take 결과(이어서 엶/건너뜀+이유). 사용자 문구는 없다(로그는 i18n 예외).
- 테스트(`#[cfg(test)]`, 순수 함수로 뗀다): 레지스트리 파싱·kind 거르기·신원 확인 판정·사슬 걷기(가짜 프로세스 표)·중복 sessionId·스냅샷 합치기 규칙·
  take 의 세 가지 None·파일 왕복·14일 만료.

### D2. 프론트 — 재개 입력

- `lib/terminal-engine.ts` 의 초기 입력 자리: `takeInitialInput` 이 비었고 attach 가 아니면 `ipc.claudeResumeTake(id)` 를 **바로** 부르고, 같은
  "첫 글자가 찍힌 뒤(최대 3초)" 경로로 보낸다. 예약 입력이 있으면(사용자가 방금 명시적으로 띄운 것) 그게 이기고 재개는 `forget` 한다.
- 명령 문자열은 **실제로 뜬 셸** 문법으로(`formatLaunch` 처럼) — `lib/terminal.ts` 에 순수 함수 `formatClaudeResume(rec, shell, startDir)`:
  - sessionId 가 UUID 모양이 아니면 null(아무것도 안 보냄).
  - `cwd` 가 셸 시작 폴더(프로젝트 루트)와 같으면(대소문자·구분자·끝 구분자 무시, Windows) 이동 생략.
  - pwsh/powershell: `Set-Location -LiteralPath '<cwd>'\r`(작은따옴표 안 `'`→`''`; `-LiteralPath` 라 `[ ]` 와일드카드 안전) ·
    cmd: `cd /d "<cwd>"\r`(cwd 에 `"`·`%`·`!` 있으면 null) · 그 외: `cd -- '<cwd>'\r`(`'`→`'\''`). 제어 문자 든 cwd 는 null.
  - 이어서 `claude --resume <id>\r`.
- `dropPane`(stores/terminals.ts) 에서 `ipc.claudeResumeForget(paneId)`.
- 설정 화면 터미널 섹션에 토글 "재시작하면 Claude 세션 이어서 열기"(설명: 앱을 다시 켜면 터미널마다 하던 Claude 세션을 `claude --resume` 으로 다시 엽니다).
  `text-settings.ts` ko/en + 검색 색인, `settings-index.ts`.

### D3. 프론트 — 모아보기 복원

- `gp:aggregate-hidden`: **숨긴** 칸 id 배열(선택이 아니라 숨김 — 모아보기를 닫은 사이 생긴 새 터미널은 저절로 보이게).
  마운트 때(useState 초기값) 키가 있으면 선택 = 전체 − 숨김, `initedRef=true`(기존 "Claude 활동 있는 것만" 추정은 키가 없을 때만).
  선택이 바뀔 때마다 숨김 = 지금 있는 칸 − 선택 으로 다시 쓴다.
- `gp:aggregate-zoom`: 확대한 칸 id(없으면 지움) — 마운트 때 그 칸이 있고 보이면 되살린다.
- `gp:aggregate-view`: `"main" | "window"` (닫혀 있으면 키 삭제) — **사용자 동작에서만** 쓴다: 메인 안 열기/닫기, 별도 창 열림/사용자가 닫음.
  Rust `Destroyed("aggregate")` 가 보내는 `aggregate-window://state` 에 `shutdown: bool`(종료 중이면 true) 를 더하고, 메인은 shutdown 이면 키를 건드리지 않는다.
- 부팅(메인 창): `view=="main"` → `aggregateOpen` 초기값 true. `view=="window"` → `aggregateWindowOpen` 초기값 **true**(메인 터미널이 PTY 를 먼저 열어
  별도 창과 같은 터미널을 두 번 여는 경합 방지) 로 두고 `openAggregateWindow()` — 실패하면 false 로 되돌리고 키 삭제. 부팅 열기가 끝나기 전의
  창 목록 재확인(포커스)이 false 로 덮지 않게 한다.
- `gp:aggregate-window-geom`: `{x, y, w, h(물리 px), maximized}` — 별도 창이 이동·크기 변경(디바운스 500ms)·최대화 때 쓴다.
  `open_aggregate_window(origin, geom?)` 가 받아 **어느 모니터와 100px 이상 겹칠 때만** 적용(위치·크기·최대화), 아니면 지금처럼 1100×720 가운데.
- e2e: 러너가 스위트 사이에 `gp:aggregate-hidden`·`gp:aggregate-zoom`·`gp:aggregate-view`·`gp:aggregate-window-geom` 을 지운다(앞 스위트 의존 방지).

### 범위 밖
- 떠 있는 터미널 창(`float-*`)은 지금도 재시작 때 사라진다(레이아웃에서 빠져 영속되지 않음) — 이 태스크에서 다루지 않는다.
- 모아보기의 리포트 탭은 되살리지 않는다.
- 재개된 세션에 프롬프트를 자동으로 보내지 않는다(작업 중 끊긴 세션도 대기 상태로 열린다).

## 4. 작업 분할
| 묶음 | 파일 |
|---|---|
| **BE** | `src-tauri/src/claude_resume.rs`(신규) · `lib.rs`(mod·커맨드 등록·`hot_commands_stay_async`·`shutdown_children` 맨 앞 스냅샷·스레드 시작·`open_aggregate_window` geom·`Destroyed` 의 shutdown 플래그) · `git/types.rs`(설정) · 필요하면 `health/probe.rs`·`commands/terminal.rs` 의 가시성만 |
| **FE** | `lib/terminal-engine.ts` · `lib/terminal.ts`(`formatClaudeResume`) · `lib/ipc.ts`(래퍼·Settings 필드) · `stores/terminals.ts`(dropPane) · `components/AggregateTerminals.tsx` · `stores/ui.ts` · `main.tsx`·`lib/aggregate-window.ts`(부팅 열기·geom) · `AggregateWindow.tsx`(geom 저장) · 설정 UI·`text-settings.ts`·`settings-index.ts` · `tests/e2e`(키 정리) |

## 5. 검증
cargo test(순수 함수) · tsc · `formatClaudeResume` 단언(셸 3종·이동 생략·거절) · dev 앱에서: 터미널에 Claude 세션을 띄움 → 앱 재기동 → 같은 터미널에
`claude --resume <같은 id>` 가 들어가 그 세션이 열림 · 모아보기 별도 창 + 칩 숨김 + 확대 → 재기동 → 그대로 · 설정 끔 → 재개 안 함.

## 6. 구현 결과(2026-11-06)

dev 앱 실기(설치본과 같은 조건 — Claude 환경변수 없이 띄움):
- 같은 프로젝트(gitpervisor)의 터미널 두 개에 지난 세션 두 개 실행(하나는 `Set-Location` 으로 nqvm-web 으로 옮겨서) → 20초 안에
  `claude-resume.json` 에 터미널별로 정확히 갈려 저장 → 메인 창을 닫아 정상 종료 → 재기동:
  - 별도 창이 저절로 다시 열림, 위치·크기(물리 px) 그대로, 숨긴 칩 8/9 그대로, 확대 칸 그대로.
  - P1: `claude --resume 8aa048c0…`(같은 폴더라 이동 없음), P2: `Set-Location -LiteralPath '…
qvm-web'` → `claude --resume 5ed4f734…`
    — 두 세션이 새 pid 로 레지스트리에 다시 잡힘.
  - 재개된 터미널에서 `/exit` 하면 다음 회차(6~12초)에 기록에서 빠진다.
  - 사용자가 별도 창을 닫으면 열림·확대 기록이 지워진다(종료가 닫은 것은 지우지 않는다).
- 강제 종료(taskkill)로 끝나도 마지막 주기 기록으로 별도 창이 되살아났다.

함정(실측): **Claude 세션 안에서 띄운 앱**은 셸에 `CLAUDE_CODE_CHILD_SESSION` 등이 상속돼, 그 앱의 터미널에서 연 Claude 가
"Transcript saving is off" 로 뜨고 `~/.claude/sessions` 에 **등록하지 않는다** → 대응표가 비어 재개가 안 된다. 설치본(시작 메뉴로 띄움)은
해당 없음. dev 앱으로 이 기능을 시험할 때는 `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID …` 로 띄운다.

검토(3관점 독립 검토 10건, 높음 0)에서 고친 것: 같은 세션이 두 터미널에 기록돼 다음 부팅에 둘 다 재개(스냅샷에서 세션 하나 = 터미널 하나,
꺼낼 때 다른 터미널이 방금 꺼낸 같은 세션이면 건너뜀) · 재개가 뜬 뒤에도 inflight 가 남아 사용자가 끈 세션이 되살아남 · 3초 상한을 셸이 뜬 뒤부터
세기 · fish 따옴표 주입 · 제목줄이 화면 밖인 창 위치 거부 · 최대화한 채 모니터를 옮긴 위치 · 닫았다 다시 열 때 확대가 새 터미널을 가림 ·
e2e 러너가 사용자 dev 앱의 복원 키를 지우던 것(백업 후 되돌림).

설계와 다른 점: Linux·macOS 프로세스 조회는 `/proc` 직접 파싱 대신 `sysinfo`(요청한 pid 만 갱신) 한 경로 · 14일 만료는 Claude 의 `updatedAt` 기준 ·
부팅 별도 창 열기 유예 15초(창 생성이 메인 스레드 예약이라 직후 목록에 없다) · 모아보기 열림 기록은 `useUi.subscribe` 한곳에서 쓴다.
미실측: macOS·Linux 실기(컴파일·로직 테스트만), fish 실셸.
