# 태스크 65 — 터미널 텍스트 복사, 어디서나·어느 OS에서나 확실히

> 상태: **구현 완료 · e2e 52 11/11 (전체 회차에서도 확인, 2026-09-10) → 리뷰 후속 수정 후 13/13 (2026-09-11)** · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-09(워킹트리 기준) + CDP 실기(dev 빌드, Windows 11 / WebView2) ·
> 선행: dc21cae(네이티브 클립보드 일원화), fe57b45·ab21f8e(mac 인터셉터·전역 폴백), 태스크 61(메뉴 선택
> 스냅샷) · **Rust 변경 0**

## 1. 요구사항

터미널 출력(Claude 대화 등)을 **드래그 → 우클릭 → [복사]** 하면 그 텍스트가 클립보드에 들어간다.
메인 pane·모아보기 셀·플로팅 창·별도 모아보기 창 어디서든, Windows·macOS·Linux 어디서든 같다.

받아들이는 조건:
- 실패는 무음이 아니다 — 이유가 토스트에 보이고 로그에 남는다. 성공도 체감된다.
- 선택이 없으면 [복사]가 아니라 "왜 없는지"가 보인다.
- Ctrl+C / Ctrl+Shift+C / Cmd+C / 전역 폴백도 같은 쓰기 함수를 타므로 함께 튼튼해진다.

## 2. 현황(근거) — "어떤 PC에서는 안 된다"의 실제 구멍 5개

하나의 원인이 아니다. **장소·OS마다 다른 구멍이 하나씩** 있어서 PC별로 다르게 보인다.

| # | 어디 | 무엇 | 근거 |
|---|---|---|---|
| 1 | 모아보기 셀 | 우클릭 메뉴에 **복사/붙여넣기 항목이 없다** | `AggregateTerminals.tsx:703-708` 우클릭 → `ChipMenu`(`:1020-1075`) 항목은 숨기기·확대·프롬프트·번역·새 터미널·Float·닫기뿐 |
| 2 | Windows | **클립보드 경합** — 다른 프로세스가 `OpenClipboard`를 쥔 수십 ms 동안 쓰기 실패 | 텍스트 쓰기 = 플러그인 → arboard → `clipboard_win::Clipboard::new()` **5회×5ms = 25ms**(`arboard-3.6.1/src/platform/windows.rs:533,559`). 그 위 `copyText`(`clipboard.ts:19`)는 재시도 0회. 같은 앱의 이미지 캡처는 이미 이 함정을 겪고 8회·40~110ms 백오프로 고쳤다(`capture.rs:524-548` "첫 시도가 그대로 깨졌다(e2e가 잡았다)") |
| 3 | Linux | **영구 실패** — 플러그인이 `arboard::Clipboard::new()`를 앱 시작 시 1회만 만들고 실패하면 계속 Err | `tauri-plugin-clipboard-manager-2.3.2/src/desktop.rs:17`. arboard는 `wayland-data-control` 피처가 꺼져 있어 항상 X11(`linux/mod.rs:128-146`) — GNOME 메뉴/systemd로 떠서 `DISPLAY`가 없거나 XWayland가 꺼진 세션이면 그 뒤 모든 writeText가 죽는다. WebKitGTK의 `navigator.clipboard`는 GTK 경유라 멀쩡한데 폴백이 없다(CLAUDE.md "dev는 되는데 설치본만 이상하다 = 런치 환경변수" 유형) |
| 4 | macOS | 우클릭이 **선택을 바꾼다** — 드래그 영역 밖에서 우클릭하면 xterm이 커서 아래 단어로 선택을 교체 | xterm `rightClickSelectsWord` 기본값 = isMac(`xterm.mjs`: `rightClickSelectsWord:Zt`, `Zt=["Macintosh"…]`). 옵션 미설정(`terminal-engine.ts:242-260`). [복사]는 클릭 시점에 `getSelection()`을 다시 읽는다(`terminal.ts:342-348`) |
| 5 | 전부 | **무음 no-op·피드백 없음** | `copyTerminalSelection`은 선택이 비면 아무것도 안 하는데 메뉴는 [복사]를 항상 그린다(`TerminalPane.tsx:221-225`). 마우스 추적 모드 앱(vim·lazygit·htop·tmux)은 드래그를 삼켜 선택이 안 생기고(Shift+드래그 필요) 안내가 없다. host `copy` 캡처(`terminal-engine.ts:625-633`)는 `void copyText(sel)`로 결과를 버린다. 메뉴 복사는 성공해도 아무 변화가 없다(Ctrl+C는 선택 해제로 알린다 — `:436-446`) |

경합(#2)이 "PC마다 다르다"의 1순위다: 클립보드 히스토리(Win+V)·기기 간 동기화, Ditto·PowerToys,
**RDP(rdpclip)**, KVM 공유 도구가 있는 PC에서만 첫 쓰기가 깨진다. 현재는 그 순간 토스트 "복사에
실패했습니다"만 뜨고 끝이다.

## 3. 설계

### 3.1 `lib/clipboard.ts` — 계층 쓰기 + 재시도 + 사유

```ts
export async function copyText(text: string): Promise<boolean>; // 시그니처 유지 — 호출 8곳·3창 무변경
export function lastCopyFailure(): string;                       // 마지막 실패 사유(토스트용)
```

쓰기 순서(앞이 성공하면 끝):

1. **네이티브 플러그인** `writeText` — 최대 6회, 대기 `40 + i*10`ms(capture.rs와 같은 곡선, 최악 ≈ 0.4s).
   mac의 "다음 틱 재쓰기"는 그대로.
2. **`navigator.clipboard.writeText`** — 단 **macOS에서 비-ASCII가 있으면 건너뛴다**(MacRoman 이중인코딩,
   dc21cae — 깨진 텍스트가 실패보다 나쁘다). Linux Wayland 구멍(#3)을 이 단계가 막는다.
3. **`document.execCommand("copy")`** — 화면 밖 textarea. mac 조건 동일. WebView2·WebKitGTK 모두 동작하는
   마지막 그물.
4. 전부 실패 → `lastCopyFailure`에 `플랫폼 · 단계별 에러` 기록, `@tauri-apps/plugin-log`의 `warn(
   "[clipboard] …")`(로그 파일에 남아 다음 "어떤 PC" 진단의 근거가 된다) → `false`.

사유 문구: 에러 문자열에 Windows `OpenClipboard` 계열(`open`·`another`·`held`)이 보이면
"다른 프로그램이 클립보드를 쓰고 있습니다 — 다시 시도하세요"(capture.rs와 같은 문구), 그 외는 원문 축약.
토스트 호출부 5곳(`terminal.ts:297,346` · `terminal-engine.ts:441,466` · host copy `:631`)은
`"복사에 실패했습니다 — " + lastCopyFailure()`로 통일하고, host copy 캡처도 결과를 본다.

**읽기(`readClipboardText`)는 손대지 않는다.** 되읽기 검증도 하지 않는다 — macOS 26 페이스트보드 프라이버시
프롬프트가 읽기마다 뜬다(`terminal.ts:300-306`).

### 3.2 xterm 옵션 — `rightClickSelectsWord: false` · `macOptionClickForcesSelection: true`

`terminal-engine.ts`의 `new Terminal({...})`에 넣는다. 세 OS 동일: 우클릭은 선택을 건드리지 않는다.

**(2026-09-11 추가)** mac에서 마우스 추적 모드 앱(vim `mouse=a`·htop·lazygit·tmux) 위의 드래그는 앱으로 간다.
xterm 6은 mac에서 Shift가 아니라 **Option+드래그**만 강제 선택으로 받고, 그것도 `macOptionClickForcesSelection`
(기본 false)이 켜져 있을 때만이다. 두 값은 `XTERM_OVERRIDES` 상수 하나에 모아 옵션에 펼치고, DEV에서는
`window.__gpvXterm.overrides`로 노출한다(e2e 52 ②가 선언을 직접 잰다 — 효과값만 재면 Mac이 아닌 러너에서는
`rightClickSelectsWord`의 기본값이 이미 false라 아무것도 증명하지 못한다).

### 3.3 메뉴 항목 공용화 — `components/workspace/TermClipboardItems.tsx` (신규 ~40줄)

```tsx
<TermClipboardItems termId={id} selection={selection} run={run} />
```

- `selection`은 **메뉴가 열린 순간의 스냅샷** — `PaneMenu`가 번역용으로 이미 뜨는 값(`TerminalPane.tsx:183-186`).
  [복사]는 `copyText(selection)`이다. 클릭 시점 재조회 없음(#4).
- 성공 시 `term.clearSelection()`(Ctrl+C와 같은 피드백 규약), 실패 시 §3.1 토스트.
- 선택이 없으면 [복사] 대신 비활성 안내 한 줄: 기본 "선택한 텍스트가 없습니다",
  `term.modes.mouseTrackingMode !== "none"`(xterm 공개 API)이면 "앱이 마우스를 쓰는 중 — Shift+드래그로
  선택하세요". **mac은 "Option+드래그"** 다(§3.2 — mac xterm은 Shift를 강제 선택으로 받지 않는다).
- [붙여넣기]는 `pasteIntoTerminal(termId)` 그대로.

사용처 2곳:
- `PaneMenu`(`TerminalPane.tsx:221-230`) — 두 항목을 이것으로 교체. 플로팅 창도 PaneMenu라 자동 적용
  (`FloatingTerminal.tsx:240` 주석).
- `ChipMenu`(`AggregateTerminals.tsx:1020`) — **터미널 셀일 때만** 맨 위에 삽입. 선택 스냅샷은 `:903`
  `onTranslate`가 쓰는 판정(`getTerminal(cell.id)`)과 같은 값. 높이 클램프 상수(`:1013` 주석의 규칙)에
  2항목분(+64)을 더한다.

### 3.4 스코프 밖

되읽기 검증, 외부 클립보드 매니저 우회, 마우스 모드 앱에서 Shift 없이 강제 선택(xterm 미지원), tmux 설정.

## 4. 검증

TS 단위 러너가 없다(vitest 없음) → e2e. 실패 주입은 DEV 한정 `__gpv.clipboard.fail(["plugin"])`
(모듈 플래그, `main.tsx:68`의 `__gpv` 노출 패턴).

- **e2e 52(신규)**:
  1. 메인 pane: `echo`로 한글+영문 3줄 → CDP 드래그 선택 → 우클릭 → [복사] 있음 → 클릭 → `term_paste`로
     되읽어 일치, 선택 해제됨.
  2. **모아보기 셀**에서 1 반복 — 현재는 항목이 없어 실패하는 케이스. 이 태스크의 핵심 회귀 방지.
  3. `fail(["plugin"])` 후 1 반복 → 여전히 일치(폴백 증명). `fail(["plugin","navigator","exec"])` → 토스트에
     사유 포함, 선택은 유지.
  4. 선택 없이 우클릭 → [복사] 없음·안내 있음. `\e[?1000h`로 마우스 모드 → 플랫폼 수식키 안내 문구
     (Windows·Linux "Shift+드래그", mac "Option+드래그"), `\e[?1000l` 원복. 구현(⑦)은 PTY 대신 xterm에
     직접 쓰고 합성 `contextmenu`로 연다 — 실제 마우스 누름은 마우스 모드에서 셸에 보고로 들어간다.
  5. mac 러너: 선택 **밖** 우클릭 → [복사] → 드래그 텍스트 그대로(§3.2).
- **회귀**: Ctrl+C(선택 있음)=복사·(없음)=SIGINT, Ctrl+Shift+C, 번역 항목, Monaco 인터셉터(`clipboard.ts:60`)
  무변경, 붙여넣기 `pasteInFlight` 가드.

## 5. 하지 말 것

- `copyText` 시그니처를 바꾸지 마라 — 호출 8곳, 3창.
- mac에서 비-ASCII를 DOM 경로로 보내지 마라 — dc21cae의 깨짐이 되살아난다.
- 되읽기로 성공을 판정하지 마라 — mac 26 프라이버시 프롬프트 폭주(`terminal.ts:300-306`).
- 메뉴 [복사]에서 클릭 시점의 `getSelection()`을 다시 읽지 마라(#4).
- Rust로 옮기지 마라 — 플러그인이 이미 arboard다. 문제는 그 위의 재시도·폴백·피드백이다.

## 6. 구현 결과 (2026-09-09)

`f6f0b23` 이후 워킹트리. **Rust 변경 0**, 새 의존성 0.

| 무엇 | 어디 | 설계 대비 |
|---|---|---|
| 계층 쓰기 + 사유 | `lib/clipboard.ts` — `copyText`(네이티브 6회 → `navigator.clipboard` → `execCommand`), `lastCopyFailure()`, `copyFailMessage()` | §3.1 그대로 |
| 복사 단일 경로 | `lib/terminal.ts` — `copyTerminalText(id, text)` 신설 | §3.1 + 아래 ⓐ |
| 우클릭 선택 고정 | `lib/terminal-engine.ts` — `XTERM_OVERRIDES`(`rightClickSelectsWord: false` · `macOptionClickForcesSelection: true` — 후자는 2026-09-11) | §3.2 |
| 메뉴 두 줄 공용 | `workspace/TerminalPane.tsx` — `TermClipboardItems` export | §3.3 + 아래 ⓑ |
| 모아보기 셀 | `AggregateTerminals.tsx` — `ChipMenu`에 삽입, 클램프 +72px | §3.3 그대로 |

설계에서 **바꾼 것 둘**:

- **ⓐ `copyTerminalSelection(id)`를 삭제했다.** 호출부가 `TerminalPane` 한 곳뿐이었고 그 자리가
  `TermClipboardItems`로 바뀌면서 아무도 부르지 않게 됐다. 터미널 복사는 이제 전부
  `copyTerminalText(id, text)` 하나로 들어온다 — Ctrl+C·Ctrl+Shift+C·Cmd+C·전역 폴백·host copy
  캡처·두 메뉴. 성공 시 선택 해제, 실패 시 사유 토스트가 한 곳에만 있다.
- **ⓑ 새 파일을 만들지 않고 `TerminalPane.tsx`에 넣었다.** 설계는 별도 파일이었지만 `MenuItem`이
  거기 있고 `AggregateTerminals`가 이미 그 모듈에서 가져간다 — 별도 파일이면 순환 import가 된다.
- 실패 주입 훅은 `main.tsx`의 `__gpv`가 아니라 `clipboard.ts`가 직접 다는 `window.__gpvClipboard`다.
  `main.tsx`는 저장 시 vite 풀 리로드라, 같은 워킹트리에서 도는 다른 세션의 e2e 회차를 깬다.

### e2e 52 결과 — 11/11

`GPV_E2E_ONLY=52` 단독으로 11/11, 이후 **전체 회차(1181 pass / 1 fail / 11 skip)에서도 11/11**이다
(2026-09-10, 다른 세션이 돌린 회차 — 셀 준비 판정을 클래스 결합에서 가시성 측정으로 바꾼 뒤의 확인).

`GPV_E2E_ONLY=52 node tests/e2e/run.mjs`. 재현 가능한 실측 셋:

- 폴백: `__gpvClipboard.fail(["plugin"])` → 네이티브가 죽어도 **복사 성공**(브라우저 경로).
- 무음 아님: 세 단계 전부 실패 → 클립보드 **불변**(센티널 유지), 토스트
  `복사에 실패했습니다 — plugin: … | navigator: … | exec: …`, **선택 유지**(다시 시도 가능).
- 모아보기 셀 우클릭 메뉴 항목: `["복사","붙여넣기","그리드에서 숨기기",…]` — 이 두 줄이 §2 #1이
  말한, 원래 **없던** 항목이다.
- 선택 없음: `["붙여넣기", …]` + 본문에 "선택한 텍스트가 없습니다".
- `rightClickSelectsWord === false`. (2026-09-11부터 ②는 효과값 대신 `XTERM_OVERRIDES` **선언**과
  `macOptionClickForcesSelection` 효과값을 잰다 — 아래 "리뷰 후속 수정".)

### 실제 고장이 드러낸 여섯째 구멍 — 거짓 성공 (2026-09-10)

이 머신의 Windows 클립보드가 통째로 고장 난 상태가 우연히 생겼다. **§2 가 표로 정리한 다섯 구멍이
가정이 아니라 실제였음을 확인해 준 동시에, 표에 없던 여섯째를 드러냈다.**

각 단계를 앱 안에서 직접 재 봤다:

| 단계 | 이 고장 상태에서의 반응 |
|---|---|
| ① 네이티브(arboard) | **정직하게 던짐** — `The native clipboard is not accessible due to being held by another party.` |
| ② `navigator.clipboard` | **정직하게 던짐** — `Document is not focused.` |
| ③ `execCommand("copy")` | **`true` 를 반환** — 그런데 클립보드는 비어 있다 |

`execCommand` 의 `true` 는 **"명령을 보냈다"이지 "클립보드에 들어갔다"가 아니다.** 그대로 두면
`copyText` 가 성공을 보고하고, 호출부(`copyTerminalText`)는 그 신호로 **선택을 해제한다** — 사용자는
복사된 줄 알고 붙여넣으면 아무것도 안 나온다. 이 태스크가 없애려던 "무음 실패"의 쌍둥이인
**거짓 성공**이고, 무음 실패보다 나쁘다(발각이 붙여넣기 시점까지 미뤄진다).

**수정**: ③ 단계만 되읽어 확인한다(`readText()`). 값이 다르거나 되읽기가 실패하면 실패로 본다.
**macOS 는 제외** — 읽기마다 페이스트보드 프라이버시 프롬프트가 뜨고(§3.1 의 그 이유), 거기서 이
단계는 어차피 ASCII 전용이다. ①②는 정직하게 던지므로 검증이 필요 없다 — **거짓말하는 단계만** 잰다.

거짓 실패(토스트가 떴는데 실은 복사됨)는 감수한다. 사용자가 다시 누르면 그만이고, 선택도 유지된다.

실측 결과(고장 상태에서):

```
copyText  → { ok: false, reason: "다른 프로그램이 클립보드를 쓰고 있습니다 — 다시 시도하세요" }
클립보드  → ""
```

수정 전이면 `ok: true` 에 선택 해제였다. 사유 문구도 이 상황에 정확하다 — ① 의 `held by another
party` 가 `humanize` 의 Windows 경합 분기에 걸린다.

**남은 것**: 이 동작의 e2e 단언. 지금은 못 넣는다 — 그 검사의 셋업(센티널을 클립보드에 심기)이
멀쩡한 클립보드를 요구하는데 이 머신이 그 상태가 아니다. 클립보드가 복구되면 `fail(["verify"])`
같은 강제 단계를 하나 더 두고 "③ 이 true 여도 되읽기가 어긋나면 실패"를 고정한다.
**진단 훅은 이미 있다**: `__gpvClipboard.copy(text)` 가 `{ ok, reason }` 을 돌려준다(DEV 전용).

### 스위트를 짜며 걸린 함정 셋 (다음 사람 몫)

1. **메뉴 버튼의 `textContent`는 라벨과 단축키가 붙어 나온다** — `"복사Ctrl+Shift+C"`. 라벨만
   읽으려면 `span.min-w-0`을 집어야 한다.
2. **모아보기에서 "보이는 첫 `.xterm`"을 잡으면 안 된다.** 사용자의 터미널이 전부 한 화면에 뜨므로
   남의 셀이 잡히고, 그 셀엔 선택이 없어 "[복사] 항목이 없다"로 오판한다. `term.get(id).host`를 쓴다.
   단 host는 **붙어 있고 보이는지**까지 확인해야 한다(`isConnected && getBoundingClientRect().width > 0`)
   — 칩으로 숨겨진 셀이면 DOM에서 떨어져 있어 이벤트가 아무 핸들러에도 안 닿고, 그러면 실패 모드만
   "메뉴가 안 뜬다"로 갈아탄 채 간헐이 남는다. 조상 클래스(`.closest('.absolute')`)로 재면 안 된다:
   그건 셀 래퍼가 지금 우연히 가진 유틸리티라 배치를 바꾸면 **통과하면서 아무것도 안 거른다.**
3. **항목을 클릭한 직후 곧바로 우클릭하면 새 메뉴가 이전 메뉴의 정리 경로에 함께 닫힌다**
   (스위트 14 #11a가 기록한 함정). 닫힘을 먼저 확인하고 원하는 항목이 보일 때까지 다시 연다.
4. **`clickMenu` 의 반환을 버리지 마라.** 항목을 못 눌렀을 때의 상태(클립보드 불변·선택 유지·
   토스트 없음)가 "실패했지만 조용하지 않았다"는 **성공 조건과 세 항목 중 둘이 겹친다.**
   2026-09-10 회차에서 토스트만 비어 실패했는데 원인은 제품이 아니라 눌리지 않은 클릭이었다.
   눌렀는지를 따로 들고 있어야 그 둘이 구분된다(`openAndClick` 이 그 일을 한다).

### 리뷰 후속 수정 (2026-09-11)

병합 전 반박 검증 리뷰가 잡은 두 건을 고쳤다(브랜치 `fix/review-65-66`).

- **mac 안내가 틀렸다.** 마우스 추적 모드에서 "Shift+드래그로 선택하세요"라고 했지만, mac의 xterm 6은
  Shift+드래그를 앱으로 넘기고 Option+드래그도 `macOptionClickForcesSelection`이 꺼져 있어 선택을 만들지
  않았다 — mac에서는 **어느 제스처로도** 복사할 수 없었다. 옵션을 켜고(§3.2) 안내를 플랫폼별로 갈랐다
  (`TerminalPane.tsx` `noSelectionHint`). 대가: mac 마우스 모드에서 짧은 Option+클릭도 앱 대신 선택 경로를 탄다.
- **e2e 52 ②가 Windows·Linux에서 실패할 수 없었다.** 효과값 `term.options.rightClickSelectsWord`를 쟀는데
  xterm 기본값이 이미 "Mac이 아니면 false"라 옵션 줄을 지워도 초록이었다. 이제 ②는 DEV 브리지
  `__gpvXterm.overrides`의 **선언**(키가 빠지면 모든 OS에서 빨강)과 `macOptionClickForcesSelection`의
  **효과값**(기본이 모든 OS에서 false라 펼치기가 빠지면 빨강)을 함께 잰다.
- **⑦ 신설** — 마우스 모드 안내 문구(§4의 4). `finally`에서 마우스 모드를 반드시 끈다.

**남은 한계**: 안내의 `isMac` 분기만 되돌리면 Windows·Linux 러너에서는 초록이다 — 그 분기는 mac 러너만 잡는다.

**e2e(2026-09-11, `F:\gp-fix` dev 빌드 · 셸을 `powershell.exe` 5.1 로 둔 회차)**: 52 **13/13**(새 ②·⑦ 포함),
60 18/18, 14 67 pass / 2 skip. 14 는 첫 회차에서 "Claude 항목 → 셸에 `claude` 입력(에코)" 1건이 18초 대기 안에
에코를 못 봐 실패했고 단독 재실행에서 통과했다 — 이 PC 는 Store pwsh 별칭이 깨져 있어 셸을 5.1 로 바꿔 돌린 회차다.

---

## 후속 (2026-09-16) — 마우스 추적 중에는 [복사]가 **원리적으로** 뜰 수 없었다

Claude Code 세션에서 "드래그해서 선택하고 우클릭했는데 [복사]가 없다"는 신고로 다시 팠다.
§2 #5 는 원인을 "마우스 추적 모드 앱은 드래그를 삼켜 선택이 안 생긴다"로 적었는데, **절반만
맞았다.** 선택을 만들어도(Shift+드래그) 메뉴에는 끝내 [복사]가 안 뜬다.

### 사슬

1. **Claude Code 는 마우스 추적을 셋 다 켠다** — `?1000h ?1002h ?1003h ?1006h`.
   바이너리(2.1.272)에 `_ = iD(MOUSE_NORMAL)+iD(MOUSE_BUTTON)+iD(MOUSE_ANY)+iD(MOUSE_SGR)`,
   `EXe(E){case"full":return _; case"scroll":return t; case"off":return ""}`, 기본값 `vO() = "full"`.
   → xterm `modes.mouseTrackingMode === "any"`, 인코딩 SGR.
2. **SGR 인코딩이면 마우스 리포트가 "사용자 입력"으로 나간다** — `CoreMouseService.ts:328-331`
   `this._activeEncoding === 'DEFAULT' ? triggerBinaryEvent : triggerDataEvent(report, true)`.
3. `wasUserInput` 이 `CoreService.ts:74-76` 에서 `_onUserInput.fire()` 를 때리고(주석부터가
   "eg. clear selection"), `SelectionService.ts:139-143` 이 거기 걸려 **선택을 지운다.**
4. **우클릭의 mousedown 이 곧 그 리포트다.** SelectionService 는 `button === 2 && hasSelection`
   이면 컨텍스트 메뉴를 위해 보존하려 하지만(`:451-455`), 같은 element 에 걸린 두 번째 mousedown
   리스너가 버튼을 안 가리고 쏜다(`CoreBrowserTerminal.ts:779-790`). `stopPropagation()` 은 같은
   element 의 다른 리스너를 못 막는다 — xterm 6 자체의 자기모순이다.
5. `?1003`(ANY)이면 그 전에 **버튼 없이 마우스를 움직이기만 해도** 이미 지워진다
   (`CoreBrowserTerminal.ts:720-724`).

즉 §4의 4 가 심은 안내("Shift+드래그로 선택하세요")는 **그대로 해도 복사에 도달하지 못했다.**

### 수정

- **선택 스태시** — `TermInstance.lastSelection`. 엔진이 `term.onSelectionChange` 에서 비어 있지 않은
  선택만 남기고, 마우스 추적 DECSET(1000/1002/1003)이 **켜지거나 꺼질 때** 비운다(기존 9001 감지
  CSI 핸들러에 얹었다 — 한 TUI 에피소드 밖으로 새면 사용자가 지운 선택이 되살아난다).
- **`snapshotSelection(id)`** (`terminal.ts`) — 메뉴가 "복사할 것"을 정하는 단일 규칙. 평소엔 라이브
  선택, **마우스 추적 중일 때만** 스태시. PaneMenu·ChipMenu·모아보기 번역 항목이 전부 이걸 쓴다
  (한 곳만 `hasSelection()` 으로 남으면 [복사]는 있는데 번역만 없는 상태가 된다).
- **안내 문구**는 실제로 되는 경로를 말한다 — `Shift+드래그로 선택 후 Ctrl+Shift+C`
  (mac: `Option+드래그로 선택 후 ⌘C`). 키 경로는 마우스 리포트를 안 내므로 선택이 살아 있다.
- **OSC 52 수신** — `term.parser.registerOscHandler(52, …)`. xterm 6 은 52 를 **등록조차 안 해**
  (`InputHandler` 는 0·1·2·4·8·10~12·104·110~112) 지금까지 통째로 증발했다: SSH 너머의 TUI·vim `"+y`·
  tmux·helix 의 복사가 이 앱에서만 무음으로 실패했다. 읽기 요청(`?`)에는 **응답하지 않는다**(터미널에
  뜬 아무 프로그램이나 클립보드를 훔쳐 가는 통로다). 쓰기 실패는 토스트로 알린다.

### e2e 52 가 이걸 못 잡고 있었다

①~⑦ 은 선택을 `t.selectLines()` 로 만들고 메뉴를 **합성 `contextmenu` 하나**로 연다 — mousedown 이
없으니 3~4번 사슬이 통째로 빠져 **결함이 있어도 초록이었다.** ⑦ 은 안내 **문자열**만 보고, 기대값을
`/^Mac/.test(navigator.platform)` 로 계산해 앱과 같은 분기를 양쪽에서 계산·비교한다.
설계(§5)는 원래 CDP 드래그 선택을 하려 했는데 구현에서 `selectLines` 로 바뀌며 드래그 경로가 빠졌다.

**⑧ 신설**: Claude Code 시퀀스 그대로 켜고 → 선택 → **진짜 `mousedown`(button 2)** → 선택이 지워짐을
단언(전제) → 그다음 메뉴를 열어 [복사]가 뜨고 **드래그했던 텍스트**가 클립보드에 들어가는지 본다.
모드 해제 후 스태시가 비워지는지도 함께 본다.

### 우회 (코드 수정 없이)

`CLAUDE_CODE_DISABLE_MOUSE=1` 이면 `EXe("off")` 가 빈 문자열이라 시퀀스가 0바이트 — 드래그 선택이
평소처럼 된다. `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` 은 **소용없다**(`"scroll"` = 여전히 `?1000h ?1006h`,
내부에서 좌클릭만 폐기). 참고로 Claude Code 는 자체 선택 + copy-on-select(기본 켜짐)로 드래그 직후
네이티브 클립보드에 이미 넣는다 — 사용자가 본 하이라이트는 xterm 것이 아니라 그쪽이다.
