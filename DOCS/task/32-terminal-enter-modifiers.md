# 태스크 32 — 터미널 Shift+Enter / Alt+Enter 줄바꿈(Claude Code) — 모든 OS

> 상태: **구현 완료 · 검증 통과(2026-09-03, 미커밋)** — 결과는 §8·§9 · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-03(xterm 6.0.0 소스·portable-pty 0.8.1 소스 포함) · 짝 태스크: `33-windows-conpty-bundle.md`

## 1. 요구사항

터미널에서 Claude Code를 쓸 때 **Shift+Enter, Alt+Enter가 줄바꿈**으로 동작해야 한다(Windows 10에서 Alt+Enter가 안 됐다). 모든 OS.

받아들이는 조건:
- Claude Code 입력창에서 Shift+Enter·Alt+Enter → 줄바꿈(제출 아님). Enter는 그대로 제출.
- Windows(10·11)·Linux·macOS 동일. 한글 IME 조합 중 Enter는 기존대로 조합 확정.
- 다른 TUI/셸에서 일반 Enter 동작이 바뀌지 않는다.

## 2. 현황(근거)

- **xterm의 Enter 처리** — `node_modules/@xterm/xterm/src/common/input/Keyboard.ts:100-104`:
  ```ts
  case 13: result.key = ev.altKey ? C0.ESC + C0.CR : C0.CR; result.cancel = true; break;
  ```
  **Shift는 참조되지 않는다**(Shift+Enter = `\r`). Alt+Enter = `\x1b\r`(ESC CR). 앱에는 Enter를 다루는 코드가 없다(`terminal-engine.ts:212-364`
  `attachCustomKeyEventHandler`가 Tab·IME 가드·Ctrl 조합·복사/붙여넣기만 가로챔). Enter는 전부 xterm 기본 경로 → `onData` →
  `ptyWrite` → `term_write`(바이트 무변환, `terminal.rs:246-261`).
- **Claude Code가 줄바꿈으로 받는 입력**: `\x1b\r`(ESC CR = meta+return). iTerm2 Option+Enter, VS Code `/terminal-setup`의
  Shift+Enter 키바인딩(`sendSequence "\u001b\r"`)이 전부 이 바이트다. 즉 **Shift+Enter를 Alt+Enter와 같은 바이트로 보내면** 된다.
- **Windows에서 `\x1b\r`이 안 먹는 이유(가설 → §7에서 실측)**: ConPTY는 PTY 입력을 VT 파서로 INPUT_RECORD로 바꾸는데, ESC 뒤에
  C0(`\r`)이 오면 ESC 키·Enter 키 **두 개의 레코드**로 쪼갠다(Alt 수식이 아니라). 클라이언트(Node/libuv → Claude Code)는 Escape 후
  Enter로 본다 → 줄바꿈 대신 취소/제출. Windows Terminal이 되는 이유는 **win32-input-mode**(`ESC [ Vk;Sc;Uc;Kd;Cs;Rc _`)로 키를
  보내 ConPTY가 수식 상태(ALT)를 정확히 받고, libuv가 ALT+Enter 레코드를 `\x1b\r`로 번역하기 때문이다.
- **우리 PTY는 이미 win32-input-mode를 요청받고 있다**: `portable-pty-0.8.1/src/win/psuedocon.rs:86` `CreatePseudoConsole(…,
  PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE, …)` — 플래그 0x6 무조건. 그래서 ConPTY가 시작 시 `\x1b[?9001h`를
  보낸다(이 세션의 훅 출력에도 그 바이트가 그대로 찍혀 있다). xterm 6은 DECSET 9001을 **조용히 무시**(`InputHandler.ts:1877-` case 없음,
  default 없음). 앱은 `registerCsiHandler` 사용처 0건.
- 키 가로채기 자리: `terminal-engine.ts:212-364`. IME 가드(`:232-239`, composing/229/Process/Unidentified → `return false`)가 먼저 있다.
  `ptyWrite`(`:78-94`)는 termId별 프라미스 체인으로 순서 보장.
- 관련 기존 항목: `DOCS/TROUBLESHOOTING.md` §4 "Shift+Tab이 포커스를 옮긴다" — Tab을 커스텀 핸들러에서 직접 `\x1b[Z`로 쓰는 선례.

## 3. 설계

### 3.1 인코딩 결정

| 상황 | 보내는 바이트 | 근거 |
|---|---|---|
| **Windows, PTY가 `?9001h`를 보냈음**(= ConPTY) | Enter+Shift / Enter+Alt → win32-input-mode 키 레코드 2개(down/up): `ESC [ 13 ; 28 ; 13 ; 1 ; 2 ; 1 _` · `ESC [ 13 ; 28 ; 13 ; 0 ; 2 ; 1 _` (Vk=VK_RETURN 13, Sc=28, Uc=13, Cs=**LEFT_ALT_PRESSED 0x02**) | ConPTY가 ALT+Enter INPUT_RECORD를 만들고 libuv가 `\x1b\r`로 번역 → Claude 줄바꿈. Shift도 **ALT로 보낸다**(아래 트레이드오프) |
| 그 외(Linux·macOS, 또는 9001 미수신) | Enter+Shift / Enter+Alt → `\x1b\r` | VS Code·iTerm2와 동일 바이트. Alt는 xterm 기본과 같고 Shift만 새로 매핑 |
| Enter 단독 / Ctrl+Enter / IME 조합 중 | 기존 그대로(xterm 기본) | 변경 없음 |

**Shift+Enter를 ALT로 보내는 트레이드오프**: win32 레코드에 SHIFT(0x10)를 정직하게 넣으면 ConPTY→libuv 번역이 `\r`(구분 없음)이 돼
Claude Code는 제출로 본다(libuv는 Enter의 Shift를 구분하지 않는다). 반대로 PSReadLine(pwsh)은 Shift+Enter=AddLine을 잃고
Alt+Enter(미바인딩 → 무동작)를 받는다. **현재도** 앱에서 Shift+Enter는 Enter와 같아 AddLine이 된 적이 없으므로 회귀는 "제출 →
무동작"뿐. 요구가 Claude Code 명시이므로 ALT를 채택한다. 되돌릴 자리는 상수 1개(§4 `ENTER_MOD_CS`).

### 3.2 9001 감지

`term.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => { if (params.includes(9001)) inst.win32Input = true; return false; })`
— `return false`로 xterm 기본 처리도 계속 타게(무시라서 무해). `l`(reset)도 같은 방식으로 false 복귀. 인스턴스별 플래그(터미널마다
PTY가 다르다). ConPTY가 항상 켜므로 사실상 Windows=true지만, **감지 기반**이어야 사이드로드/구버전/비Windows에서 안전하다.

### 3.3 커스텀 키 핸들러 분기(IME 가드 **뒤**)

```ts
if (e.type === "keydown" && e.key === "Enter" && (e.shiftKey || e.altKey) && !e.ctrlKey && !e.metaKey) {
  e.preventDefault();
  ptyWrite(opts.id, inst.win32Input && isWindows ? win32Key(13, 28, 13, ENTER_MOD_CS) : "\x1b\r");
  return false;               // xterm 기본 경로(\r 또는 ESC CR) 차단
}
```
`win32Key(vk, sc, uc, cs)` = down + up 두 시퀀스 문자열. `keyup`은 xterm 핸들러에도 오지만 Enter keyup은 기본 경로가 아무 것도
안 보내므로 별도 처리 불필요(`e.type === "keydown"`만 잡는다).

### 3.4 만들지 않는 것

- 전체 키의 win32-input-mode 인코딩(Windows Terminal 방식) — 효과가 크지만 오타 하나로 입력 전체가 깨진다. Enter+수식만.
- 설정 토글 — 되돌릴 근거가 생기면 그때(상수 1개로 충분).
- 백슬래시+Enter(`\`+Enter) — Claude Code가 이미 지원.

## 4. 계약

```ts
// src/lib/terminal-engine.ts
const ENTER_MOD_CS = 0x02;                       // LEFT_ALT_PRESSED — Shift+Enter도 이 값(§3.1 트레이드오프)
function win32Key(vk: number, sc: number, uc: number, cs: number): string;  // "\x1b[vk;sc;uc;1;cs;1_" + "\x1b[vk;sc;uc;0;cs;1_"
interface TermInstance { …; win32Input: boolean }  // registerCsiHandler(?h/?l 9001)로 갱신
```
DEV: `__gpv.term = { get: getTerminal }`(xterm 인스턴스·`win32Input` 플래그를 e2e가 읽게).

## 5. 단계

1. `terminal-engine.ts`: 9001 감지 핸들러 + Enter 분기 + `win32Key` + DEV 노출. `tsc`.
2. **실측(디버그 앱, 조율 신호 후)** — §7 프로토콜. 결과에 따라 Cs·시퀀스 조정.
3. e2e 06(터미널)에 케이스 추가: Windows면 `__gpv.term.get(id).win32Input === true`(ConPTY 요청 수신), CDP `Input.dispatchKeyEvent`로
   Shift+Enter/Alt+Enter → PTY 안 Node 키 에코가 `"\u001b\r"`(비Windows) 또는 ALT 레코드 번역 결과 `"\u001b\r"`(Windows, libuv 번역)를 받는지.
4. `DOCS/TROUBLESHOOTING.md`에 항목 추가(§7 실측 결과 포함).

규모: **S** — ~60 LOC + e2e ~40 LOC. Rust 0.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| ConPTY가 win32 레코드를 다르게 해석 | Sc/Uc 값·keyup 필요 여부 | §7 키 에코 실측으로 확정. Windows Terminal이 보내는 값과 동일(Sc 28) |
| 9001 미수신 환경(사이드로드 ConPTY·구버전) | 플래그 false → `\x1b\r` 폴백(현재 동작) | 33 번들 뒤에도 9001은 온다(같은 플래그) — 실측에 포함 |
| 다른 TUI의 Shift+Enter | vim/htop 등은 Shift+Enter를 안 쓴다. pwsh AddLine 손실(§3.1) | 문서화 + 상수 |
| IME | 조합 중 Enter | 가드가 앞에 있어 분기에 안 들어온다 |

## 7. 검증(실측 프로토콜)

1. 앱 터미널(pwsh)에서 키 에코 실행:
   `node -e "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write(JSON.stringify(d.toString('latin1'))+'\n'))"`
2. CDP `Input.dispatchKeyEvent`(xterm textarea 포커스)로 Enter / Shift+Enter / Alt+Enter 각각 → PTY 출력에서 에코 문자열 기록.
   기대: Enter `"\r"`, Shift+Enter·Alt+Enter `"\u001b\r"`. **Windows에서 수정 전**엔 Alt+Enter가 `"\u001b"`+`"\r"` 분리(또는 다른 값)로
   나오는지 먼저 찍어 원인을 확정한다(가설 검증).
3. `claude`를 띄워 텍스트 입력 후 Shift+Enter → 입력창 두 줄(xterm 버퍼 `translateToString`으로 확인) → Enter 제출은 그대로.
4. Ctrl+C로 종료, 한글 조합 중 Enter 확정 확인, Linux/macOS는 릴리스 전 1회.

## 8. 구현 중 메모(2026-09-03)

- macWebKit 경로에서 Enter 분기가 조기 return하므로 기존 IME 미러 리셋 목록(`e.key === "Enter"`)을 건너뛴다 → Tab 분기 선례대로 분기 안에서
  `resetImeMirror()` 1줄 호출(설계 의사코드에 없던 줄).
- 두 인코딩(win32 레코드·`\x1b\r`) 모두 `prompt-capture`의 `escEnd` 스킵 규칙에 걸려 프롬프트 기록을 오염시키지 않는다(코드 확인).
- e2e 06에는 우선 `__gpv.term.get(paneId).win32Input`(Windows=true) 단언만 — 키 에코 단언은 §7 실측으로 바이트를 확정한 뒤 추가.

## 9. 실측 결과(2026-09-03)

환경: Windows 11 26200 · 디버그 dev 앱 · 번들 ConPTY 1.24.2607.10001(`term_open` 응답 `{"conpty":"bundled"}`) ·
pwsh · xterm 92x47 · `win32Input=true`(첫 PTY 출력 23B `\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h`).

### 9.1 키 에코(§7-1·7-2)

PTY 안에 raw 모드 node 에코(받은 바이트를 `JSON.stringify`로 되돌려 준다)를 띄우고 CDP
`Input.dispatchKeyEvent`(VK 13 / code Enter / modifiers Shift=8·Alt=1)로 **실제 키**를 넣었다.

| 키 | 클라이언트(node)가 받은 바이트 |
|---|---|
| Enter | `"\r"` |
| Shift+Enter | `"\u001b\r"` |
| Alt+Enter | `"\u001b\r"` |

§7의 기대와 **정확히 일치**한다 — ConPTY가 win32 레코드에서 ALT+Enter INPUT_RECORD를 만들고 libuv가
ESC CR로 번역한다. 기대와 같았으므로 `ENTER_MOD_CS` 0x10(SHIFT) 대조군은 돌리지 않았다
(§3.1의 트레이드오프는 **미실증**으로 남는다).

### 9.2 대조군 — 생 ESC CR을 PTY에 직접 써 보면(§2 가설)

`term_write`로 `\x1b\r` 두 바이트를 그대로 밀어 넣어도 node는 **한 덩어리 `"\u001b\r"`** 로 받았다.
즉 이 머신의 ConPTY(번들 1.24)는 §2가 가정한 "ESC 뒤 C0를 ESC 키·Enter 키 **두 레코드**로 분해"를
**재현하지 않는다**. 두 인코딩 경로(win32 레코드 / 생 ESC CR)가 여기서는 결과가 같으므로, 분기의 실효는
**Windows 10 내장 ConPTY에서만 판정 가능**하다(이 머신에 없다 — 사용자 검증 항목). 반대로 말하면
win32 레코드 경로가 최신 ConPTY에서 **회귀를 만들지 않는다**는 것은 확인됐다.

### 9.3 Claude Code 프로브(§7-3)

Claude Code v2.1.258를 앱 터미널에서 띄워(폴더 신뢰 프롬프트는 ↓+Enter로 통과) 확인:

- `abc` 입력 → **Shift+Enter** → 제출되지 않고 커서가 입력 상자 둘째 행으로 내려간다. 이어 `def`를 치면
  상자가 `❯ abc` / `  def` **두 행**이 된다.
- **Alt+Enter** → 같은 방식으로 셋째 행이 열린다.
- 종료(Esc → Ctrl+C ×2) 뒤 `claude.exe`/`node.exe` 잔존 0(픽스처 경로를 명령줄에 가진 프로세스 CIM 조회 0건).

### 9.4 e2e 06

`win32-input-mode` 단언에 키 에코 3건(Enter / Shift+Enter / Alt+Enter)을 더해 격리 실행 **13 pass, 2회 연속**.
그 과정에서 스위트 쪽 결함 두 개를 고쳤다(엔진 코드는 손대지 않았다):

- 픽스처가 `["projects"]` 쿼리에 들어오기 **전에** `selectProject` 하면 워크스페이스가 빈 채로 렌더돼
  xterm이 아예 마운트되지 않는다 → `win32Input=null`로 실패. 22/23과 같은 캐시 무효화 + 반영 대기를 넣었다.
- 부하가 걸린 머신에서는 pwsh 프롬프트까지 십수 초가 걸려 9s 예산이 `win32Input=false`로 흘렀다.
  플래그·에코 대기를 각각 30s로 늘렸다.
