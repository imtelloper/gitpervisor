# 태스크 69 — 세션 다수일 때 터미널 버벅임: 수정 4건 + 측정 로그(`[term-perf]`)

진단(2026-09-18, dev 앱 실측 + 설치본 로그 + 5영역 조사/반증)에서 **근거가 단단한 것만** 고친다.
그리고 다음에 또 느려졌을 때 추측 대신 로그로 가를 수 있게 측정 로그를 남긴다.

## 1. 진단 요약 (왜 이 4건인가)

| 관측 | 근거 |
|---|---|
| health가 **프로세스 수만으로** Warn/Danger가 된다. Windows에선 Claude 세션 1개가 자손 15~35개라 세션 8개로도 164~253개. v0.5.0 이후 표본의 28.5%가 Danger, 그 96%가 procs≥200 단독 | `health/mod.rs` `T_PROCS=[60,120,200]`(리눅스 기준, Windows 분기 없음) · 설치본 로그 |
| 그 레벨이 **모든 터미널**의 PTY 예산을 8MB/s→128KB/s로 내리고(1초 창, 초과 시 최대 1초 sleep), **보이는 메인 창**에도 WebView2 메모리 목표 LOW를 건다 | `commands/terminal.rs pty_budget()` · `webview_guard.rs` · dev 앱 재현(procs 225 → 큰 출력 0.2s→120s+, 에코 max 30→190~340ms) |
| WebGL 컨텍스트는 **정확히 16개**에서 막힌다. 인스턴스는 "한 번이라도 본 터미널" 수만큼 누적되고 숨겨도 컨텍스트를 쥔다. 17개째부터 생성↔손실 핑퐁, 60초 내 4회 손실이면 DOM 렌더러로 **영구** 강등 | 실측(24개에서 생존 16, 생성 292·손실 276, longtask 50~126ms) · `terminal-engine.ts` |
| 워처 flush가 diff·log·branches·activity·commits-between을 **프로젝트 구분 없이** 무효화 | `lib/events.ts` |

**기각된 것 — 고치지 않는다**: 숨은 터미널 파싱으로 메인 스레드 포화(실제 Claude TUI 출력은 작업 중
~1KB/s·최대 11KB/s, 포화엔 합계 ~1.2MB/s 필요) · `scanAgents`(0.1~0.7ms/회) · fit 디바운스(리사이즈
재출력 실측 ~7KB) · 마우스 이동 리포트 솎기(미실측). `.ai-working` 애니메이션은 시각 디자인 변경이라
측정 로그로 크기를 본 뒤 판단한다.

## 2. 수정 A — 메모리 레벨을 분리한다 (Rust)

**원칙: 출력을 조이고 웹뷰 메모리를 줄이는 조치는 "시스템 메모리가 모자란다"는 신호에만 반응한다.**
프로세스 수·앱 트리 메모리 비율은 *앱 발자국* 신호다 — 배너로 알릴 일이지 터미널을 조일 일이 아니다.

- `assess()`가 전체 레벨과 함께 **메모리 레벨**을 낸다. 메모리 신호 = 압박 full/some, 시스템 여유 메모리,
  커밋/스왑(기존 게이트 그대로), 처형 1순위(victim). **앱 메모리 %(`T_MEM_PCT`)와 프로세스 수(`T_PROCS`)는
  메모리 레벨에 넣지 않는다.** 신호 판정 로직을 복제하지 말고 `consider`에 "메모리 신호인가"를 함께 넘긴다.
- 메모리 레벨도 전체 레벨과 **같은 dwell·쿨다운**을 탄다. `Machine::settle`의 상태(level·streak·candidate·
  calm_since)를 작은 구조체로 빼서 **두 번 쓴다**(로직 복제 금지).
- `pub fn memory_level() -> Level` — 원자값 하나(`LEVEL`과 같은 모양). 읽는 곳을 이쪽으로 옮긴다:
  `terminal.rs pty_budget()`, `lib.rs`의 플로팅 풀 게이트 2곳, `webview_guard::on_health_level`
  (메모리 레벨 **전이** 때 메모리 레벨로 호출). `health://level` 이벤트·배너·`flush-drafts`는 전체 레벨 그대로.
- 정기 `[health] lv=…` 줄에 `mem_lv=`를 붙이고, 메모리 레벨 전이는 한 줄 남긴다.
- `T_PROCS`에 Windows 분기: `[300, 600, 1000]`(같은 파일 `T_SWAP_PCT`가 본보기). 사유 문구의
  "(정상 5~40개)"는 플랫폼 무관하게 임계에서 파생한다 — 예: `앱에 딸린 프로세스 {n}개 (주의 기준 {T_PROCS[0]}개)`.
  프론트가 이 문구를 파싱하는지 grep으로 확인하고, 하면 같이 맞춘다.

### Pacer를 빚 기반으로 (같은 파일)

지금은 1초 창에서 예산을 넘기는 순간 **창의 남은 시간(최대 1초)** 을 통째로 잔다 → 1Hz 톱니.
보낸 바이트가 "갚아야 할 시간"(`bytes / budget`초)이 되게 바꾼다:

```
elapsed = now - window_start
if elapsed >= 1s { window_start = now; bytes = 0; elapsed = 0 }   // 크레딧 상한 = 1초치(지금과 같다)
bytes += n
owed = bytes / budget (초)
if owed <= elapsed + BURST(100ms) → None
else sleep = min(owed - elapsed, 1s); window_start = now + sleep; bytes = 0; Some(sleep)
```

평균 속도는 예산 그대로, 정지 단위가 ~100ms로 준다(Danger에서 64KB 청크는 0.5초 — 지금의 절반).
`take()`는 지금처럼 **시간을 인자로 받는 순수 함수**로 두고 기존 pacer 테스트 3개를 새 의미에 맞춘다
(평균 속도가 예산을 넘지 않는다 / 버스트 100ms치는 안 잔다 / 유휴 뒤 크레딧은 1초치로 막힌다).

### 스로틀 측정 (같은 펌프 스레드)

펌프가 Pacer 때문에 잔 횟수·시간을 세션별로 세고, **60초마다 0이 아니면** 한 줄:
`[term-perf] pty-throttle term=<id 앞 8자> mem_lv=warn budget_kb=1024 sleeps=12 slept_ms=5400 out_kb=61234`

## 3. 수정 B — 보이는 터미널만 WebGL을 갖는다 (TS)

- `TermInstance`에 엔진이 채우는 두 함수: `acquireWebglRenderer()` / `releaseWebglRenderer()`
  (WebKitGTK에선 no-op). 코어 `attachTerminal`이 host를 붙인 직후 acquire 한다.
- 새 코어 함수 `unmountTerminalView(id, container)` — `TerminalPane`·`AggregateCell` effect cleanup이 부른다.
  **host가 아직 그 container에 붙어 있을 때만**(다른 뷰가 이미 가져갔으면 아무것도 안 한다) release를
  **1.5초 뒤로** 예약한다. 그 사이 acquire가 오면 예약을 취소한다(탭 왕복·모아보기 이동에서 재생성 방지).
- release = `webgl.dispose()` **뒤에** 그 캔버스의 `WEBGL_lose_context.loseContext()` — GC를 기다리지 않고
  슬롯을 즉시 반납한다. dispose가 먼저여야 xterm의 손실 핸들러가 우리 재생성 로직을 건드리지 않는다.
  gl은 dispose **전에** `host.querySelectorAll("canvas")`에서 `getContext("webgl2")`로 집어 둔다(2D 캔버스는 null).
- 모듈 전역 `liveWebglCount`, 상한 `WEBGL_LIVE_MAX = 12`(Chromium 16 미만, 여유 4). 상한이면 DOM 렌더러로
  둔다 — **영구가 아니다**: 다음 attach가 곧 재시도다. `new WebglAddon()`이 던진 경우도 같다.
- 컨텍스트 손실(절전 복귀·GPU 리셋): dispose → 아직 보이면(host.isConnected) 300ms 뒤 acquire 재시도.
  손실 시각은 **모듈 전역** 60초 창으로 세고 8회를 넘으면 자동 재시도를 멈춘다(다음 attach가 재시도).
  터미널별 `lostAt` 클로저는 없앤다 — 그게 캐스케이드 감지를 무력화하던 자리다.
- 측정 로그용 카운터를 export: `terminalWebglStats(): { live, contextLost, domFallbackVisible }`.

## 4. 수정 C — 워처 무효화를 바뀐 프로젝트로 한정 (TS)

> **구현 후 축소(리뷰 반영)**: 한정하는 것은 **`diff` 하나뿐**이다. 히스토리 계열(`log`·`branches`·
> `activity`·`commits-between`)은 작업 트리가 아니라 `.git`(refs)에 달려 있고 `.git`은 등록된 프로젝트끼리
> 공유될 수 있다 — linked worktree의 커밋은 본 저장소 id로만 신호가 와서, 한정하면 워크트리 프로젝트의
> 히스토리·잔디가 조용히 낡는다. 그쪽은 로그 패널·리포트가 열려 있을 때만 재조회되므로 전역으로 둬도 싸다.
> 아래 원안은 기록으로 남긴다.

`lib/events.ts`의 `repo://changed` flush에서 `["diff"]·["log"]·["activity"]·["commits-between"]·["branches"]`
전역 무효화를 `changedProjects` 한정으로 바꾼다. 키는 `[종류, projectId, …]`이고 **중첩 저장소는 합성 id
`outer::rel`** 이므로 `key[1] === pid || String(key[1]).startsWith(pid + "::")` 와, 반대로 바뀐 id가 합성
id일 때 그 바깥 프로젝트 키도 맞아야 한다(양방향 접두). 각 쿼리 키의 실제 모양은 `queries/index.ts`에서
확인하고, projectId가 키에 없는 종류(`repo-files`는 id 목록)는 그 모양에 맞게 처리하거나 전역으로 남긴다.
순수 함수 `queryKeyTouchesProject(key, changedIds)`로 빼고 DEV 훅으로 e2e가 잰다.

## 5. 측정 로그 `[term-perf]` (TS + 위 Rust 한 줄)

**릴리스 빌드에서 상시 돈다.** 오버헤드는 터미널당 리스너 1개 + 250ms 타이머 1개 수준이어야 한다.
전송은 기존 `@tauri-apps/plugin-log`(`info`/`warn`) — 같은 `Gitpervisor.log`에 `[health]` 줄과 나란히
남아 UTC 타임스탬프로 맞춰 읽는다. 새 파일 `src/lib/terminal-perf-log.ts`.

재는 것:
- **키 에코**: 타이핑성 입력(`isTypingInput(data)`: ESC로 시작하지 않는 텍스트·`\r`·`\x7f`·`\t` — IME 확정 한글 포함,
  마우스 리포트·포커스·DA/CPR 자동응답 제외)이 `ptyWrite`를 지날 때 t0(그 터미널에 대기 중 측정이 없을 때만).
  그 터미널의 다음 출력이 **도착**한 시각과 **파싱 완료**(`term.write(data, cb)`) 시각을 잰다. 3초 안에 출력이
  없으면 표본이 아니라 `noecho`로 센다.
- **`term_write` 왕복**: `sendWrite`의 invoke 소요.
- **메인 스레드**: 250ms 타이머 드리프트(숨은 창은 타이머가 1Hz로 조여지므로 `document.hidden`이면 표본 제외),
  `longtask` PerformanceObserver(건수·합·최대).
- **출력량**: 창 전체 바이트, 터미널별 최대. **상태**: 터미널 수, `terminalWebglStats()`, JS 힙(있으면), health 레벨.

남기는 것:
- 60초마다 **활동이 있었을 때만**(키 입력·출력·longtask 중 하나라도) 한 줄:
  `[term-perf] win=main 60s terms=8 webgl=3 dom=0 ctxlost=0 keys=142 noecho=3 echo_p50=9 echo_p90=21 echo_max=340 arrive_p90=15 write_p50=4 write_max=12 lag_p99=8 lag_max=120 long=3/410/180 heap_mb=212 out_kb_s=35 out_max_kb_s=22 health=ok hidden_pct=0`
- 임계를 넘는 순간 즉시 `warn` 한 줄(종류별 5초에 1번): `[term-perf] SLOW kind=echo ms=812 term=ab12cd34 …(위 상태 필드)`.
  임계: echo ≥ 300ms · longtask ≥ 300ms · lag ≥ 500ms.
- 백분위·집계·임계 판정·한 줄 포맷은 **순수 함수**로 두고, DEV 훅 `window.__gpvTermPerf`
  (`snapshot()`·`formatSummaryNow()`)로 e2e가 잰다. 에러는 삼키지 않되 **로그 실패가 입력 경로를 막으면 안 된다**
  (`capturePtyInput`과 같은 규약 — 훅 안에서 잡고 1회만 console.warn).
- `attachOutputChannel`의 빈 catch는 xterm의 "write data discarded"(50MB 초과)까지 삼킨다 — 1회 `warn` 로그로 바꾼다.

### 다음에 느려졌을 때 읽는 법

| 로그가 이렇게 보이면 | 원인 축 |
|---|---|
| `pty-throttle` 줄이 있고 `mem_lv`≥warn | 메모리 압박에 의한 출력 조임(의도된 동작) — `[health]` 줄의 avail/커밋을 본다 |
| `echo_*` 높음 · `write_*` 낮음 · `lag_*` 낮음 · throttle 없음 | 앱 전송로가 아니다 — 터미널 안 프로그램(Claude TUI 자체)·시스템 부하 |
| `write_*` 높음 | Tauri IPC 펌프/PTY stdin 막힘(태스크 63 계열) |
| `lag_*`·`long` 높음 | 렌더러 메인 스레드 — 같은 시각의 `heap_mb`(GC)·`ctxlost`(WebGL)·`out_kb_s`(파싱)로 가른다 |
| `arrive_p90` 낮은데 `echo_p90` 높음 | xterm 쓰기 버퍼 적체(파싱 대기) |
| `dom`>0 이 오래 유지 | WebGL 상한/손실 — `ctxlost` 추이를 본다 |

## 7. 결과 (2026-09-18 실측, dev 앱)

| 항목 | 수정 전 | 수정 후 |
|---|---|---|
| 터미널 20개를 탭으로 연 뒤 살아 있는 WebGL 컨텍스트 | 16(상한)에서 생성↔손실 핑퐁 | **1**(보이는 것만) · 20초간 새 컨텍스트 0 · `dom=0` · 탭 복귀 시 재획득 |
| 자손 프로세스 600개+에서 200KB/s 재그리기 8초 | (procs 225에서 이미 danger) 최대 멈춤 243ms · 200ms+ 8회 · 24% 정지 | 전체 레벨 `warn`(사유 "프로세스 630개 (주의 기준 300개)"), **파싱 320회 · 최대 멈춤 38ms · 정지 0회**(평시와 동일) · 메모리 LOW 요청 없음 |
| 측정 로그 | 없음 | 60초 요약·`SLOW kind=longtask ms=400`이 실제 `Gitpervisor.log`에 남는 것 확인 |

리뷰가 잡아 반영한 것: 상한으로 DOM이 된 **보이는** 터미널을 슬롯 반납 때 깨우는 대기열, 동시 손실을 한 사건으로
묶기(절전 복귀로 9개가 한꺼번에 잃어도 전부 재시도), `pty-throttle` 줄이 **잔 시점**의 레벨을 찍고 유휴·EOF에서도
나오게(`span_s=`), 사후 진단 `session.rs`의 `>= 120` 하드코딩을 `T_PROCS[1]`로, 숨김→보임 경계·절전 복귀의 가짜 lag 표본 제외.

**아직 실동작으로 못 본 것**: `[term-perf] pty-throttle` 줄(메모리 압박이 실제로 있어야 돈다 — 단위 테스트만),
`heap_mb`는 WebView2가 20분 버킷으로 주는 값이라 GC 판정에는 거칠다(정밀값은 브라우저 인자
`--enable-precise-memory-info`가 필요한데, 그 인자는 모든 창이 공유해야 해서 넣지 않았다).

## 6. 검증

- Rust: `cargo test --lib health` · `cargo test --lib pacer`(이름은 실제 테스트에 맞춘다) · `cargo check`.
  기존 `no_poison_propagating_unwraps`·`hot_commands_stay_async`가 그대로 초록.
- TS: `tsc --noEmit`.
- 실동작(dev 앱): ① 터미널 24개를 열어도 살아 있는 WebGL 컨텍스트 ≤ 보이는 수, 생성/손실 핑퐁 0
  ② 자손 프로세스 225개에서 `memory_level`은 ok, 큰 출력이 끊기지 않는다 ③ 타이핑 후 `[term-perf]` 줄이 로그에 남는다.
- e2e: 터미널 스위트(14) + 새 단언, 공유 경로를 건드렸으므로 마지막에 전체 샤드 1회.
