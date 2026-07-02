# Gitpervisor — 트러블슈팅 기록

> 디버깅에 오래 걸렸던 문제와 그 근본 원인·해결을 남긴다. "dev는 되는데 설치본만 안 된다" 류는 거의 항상 **실행 환경(환경변수)** 차이다.

- 대상 플랫폼: Linux(WebKitGTK) 중심. Windows(WebView2)는 메커니즘이 다름.

---

## 1. 임베디드 터미널 입력줄이 깨진다 — "dev는 되는데 설치본만"

### 1.1 증상

설치본(GNOME 메뉴로 실행한 `.deb`)에서 임베디드 터미널에 타이핑하면 입력 줄이 깨진다.

- 한글 입력 시 커서가 어긋나 글자가 흩어지고 큰 공백이 생김 (`테   스트 123`)
- `zsh-autosuggestions` 회색 추천(고스트)이 안 지워지고 입력과 겹침
- 영문·Space·Backspace도 한글 뒤에서 이상해짐

**결정적 단서:** `npm run tauri dev` 나 터미널에서 직접 띄운 바이너리는 **정상**인데, **GNOME 메뉴로 띄운 설치본만** 깨졌다. 같은 코드/같은 바이너리인데도.

### 1.2 근본 원인 — PTY 셸의 `TERM` 미설정

터미널 에뮬레이터는 PTY 셸에게 `TERM` 환경변수를 **직접 지정**해야 한다(자신의 에스케이프 능력을 알려주는 값). gitpervisor의 `term_open`(`src-tauri/src/commands/terminal.rs`)은 이걸 안 하고 **앱 프로세스의 `TERM`을 상속**시키고만 있었다.

| 실행 방법 | 앱이 받는 `TERM` | PTY 셸의 `TERM` | 결과 |
|---|---|---|---|
| 터미널 / `tauri dev` | `xterm-256color` (터미널이 줌) | `xterm-256color` | 정상 |
| GNOME 메뉴 / systemd | **없음** (systemd user env에 `TERM` 없음) | **빈 값** | 깨짐 |

빈 `TERM`이면 terminfo 능력 조회가 실패한다. 검증:

```sh
TERM= tput el     # clear-to-end-of-line → exit 2 (실패)
TERM= tput cuf1   # cursor-forward       → exit 2 (실패)
TERM=xterm-256color tput el   # → exit 0 (정상)
```

`zsh-autosuggestions`/`zsh-syntax-highlighting`은 매 키마다 줄을 다시 그리며 `el`(줄지움)·`cuf1`(커서이동) 같은 능력을 쓰는데, 이게 실패하니 **고스트가 안 지워지고 커서가 어긋난** 것이다.

### 1.3 해결

`term_open`에서 PTY 셸을 띄울 때 `TERM`을 명시한다:

```rust
cmd.env("TERM", "xterm-256color");
cmd.env("COLORTERM", "truecolor");
```

이제 실행 방법(터미널/메뉴)과 무관하게 셸이 올바른 `TERM`을 받는다.

### 1.4 검증

메뉴 실행을 모사(`env -i …`로 `TERM` 없이 바이너리 실행)한 뒤, 앱이 띄운 PTY 셸의 환경을 `/proc/<shell>/environ`으로 확인 → `TERM=xterm-256color`가 들어감을 확인.

### 1.5 함께 적용한 보조 수정

- **IME (`src-tauri/src/lib.rs`)**: 메뉴 실행 시 `GTK_IM_MODULE` 등이 비어 WebKitGTK 한글 조합이 깨지는 것을 `run()` 초입에서 `ibus`로 보정(비어 있을 때만).
- **한글 폰트 (`src/lib/terminal.ts`)**: xterm `fontFamily`에 고정폭 한글 폰트 `Noto Sans Mono CJK KR`를 명시. generic `monospace` 폴백이 한글을 프로포셔널 `Noto Sans CJK`로 대체해(`fc-match 'monospace:lang=ko'`로 확인) 칸이 틀어지던 문제 해소.

### 1.6 교훈

- "dev는 되는데 설치본만 이상" = 거의 항상 **런치 환경변수 차이**. 비교는 `systemctl --user show-environment`(메뉴) vs 터미널 `env`로, 실제 자식 프로세스가 받은 값은 `/proc/<pid>/environ`으로 확인한다.
- IME 깨짐(`GTK_IM_MODULE`)과 셸 렌더링 깨짐(`TERM`)은 **별개 원인**이다. 하나 고쳤다고 다른 게 같이 낫지 않는다.

---

## 2. Linux 빌드가 막히던 것들 (참고)

위 문제를 빌드하려다 만난, Linux 빌드를 막던 별개 이슈들:

- **`react-markdown`/`remark-gfm` 미설치**: `package.json`엔 있는데 `node_modules`에 없어 `tsc` 실패 → `npm install`.
- **MSSQL `AuthMethod::Integrated`(Windows 전용)**: `#[cfg(windows)]` 가드 없이 써서 Linux 컴파일 실패(`src-tauri/src/db.rs`) → cfg로 가드하고 비-Windows에선 명확한 에러 반환.
- **`libssl-dev` 부재**: `tiberius`의 `native-tls`가 openssl을 요구. Linux 빌드 머신엔 `sudo apt install libssl-dev pkg-config`가 필요(또는 `OPENSSL_*` 환경변수로 헤더·lib 경로 지정).
- **`bundle.targets`가 `nsis`(Windows)뿐**: Linux에선 `tauri build -- --bundles deb,appimage`로 타깃을 오버라이드해야 deb가 나온다.

---

## 3. macOS 임베디드 터미널에서 한글 입력이 깨진다

### 3.1 증상

macOS(`Gitpervisor.app` / `tauri dev`) 터미널 패널에서 한글을 입력하면 각 음절의 첫 자모만 남고 나머지가 사라진다.

- 입력: `이거 실행해봐`
- 화면: `ㅇ거 ㅅ해ㅎ보`

영문 입력·복사·붙여넣기·Backspace는 정상. Linux 빌드는 §1 수정 이후 멀쩡(WebKitGTK는 composition 이벤트 모델). Windows(WebView2)도 정상.

### 3.2 근본 원인 — macOS WKWebView 한글 IME 이벤트 모델

진단 인스트루먼테이션(textarea의 keydown/input/composition* 전 이벤트를 stderr로 흘림)을 박고 "이거"를 타이핑한 로그:

```
keydown key="ㅇ" kc=229
input data="ㅇ" type=insertText             ta="ㅇ"
keydown key="ㅣ" kc=229
input data="이" type=insertReplacementText  ta="이"   ← ㅇ을 통째로 "이"로 교체
keydown key="ㄱ" kc=229
input data="익" type=insertReplacementText  ta="익"   ← 이→익 (IME 추정)
keydown key="ㅓ" kc=229
input data="이" type=insertReplacementText  ta="이"   ← 익→이 (decommit)
input data="거" type=insertText             ta="이거"  ← 새 음절 거 시작
```

핵심 사실:
- **macOS WKWebView 한글 IME는 `compositionstart`/`compositionupdate`/`compositionend`를 발화하지 않는다.** 음절이 바뀔 때마다 textarea의 `input` 이벤트로 `inputType=insertReplacementText`를 흘리며 textarea 내용을 통째로 갈아끼운다.
- xterm.js의 기본 input 핸들러는 `inputType=insertText`만 `onData`로 PTY에 전달한다. `insertReplacementText`는 무시 → 새 음절의 시작(insertText)만 PTY에 도착하고, 같은 음절의 갱신(insertReplacementText)은 모두 누락.
- 결과적으로 각 "음절 세션"의 첫 자모만 PTY 입력 라인에 남는다.

WebKitGTK(Linux)와 같은 WebKit 계열이지만 IME 이벤트 모델이 다르다는 점이 함정. Linux용 `compositionend` 우회만으로는 macOS는 안 고쳐진다.

### 3.3 해결

`src/lib/terminal.ts`에서 `isMacWebKit` 분기와 textarea `input` 리스너를 추가해 `insertReplacementText`를 가로챈다. **"직전 1자 삭제(`\x7f`) + 새 데이터"** 를 PTY로 보낸다 — 셸의 readline이 `\x7f`(DEL)를 받으면 입력 라인의 직전 한 글자(한글 1음절 포함)를 지운다.

```ts
const isMacWebKit = /Mac/i.test(navigator.userAgent);

ta.addEventListener("input", (e) => {
  const ie = e as InputEvent;
  if (isMacWebKit && ie.inputType === "insertReplacementText") {
    e.stopImmediatePropagation();
    const data = ie.data ?? "";
    void invoke("term_write", { termId, data: "\x7f" + data });
  }
}, true);
```

또한 IME 조합 중 raw 자모가 xterm의 keydown 경로로 새지 않도록 `attachCustomKeyEventHandler` 초반에 다음 가드를 둔다:

```ts
if (e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Unidentified") {
  return false;
}
```

### 3.4 검증

같은 로그 인스트루먼테이션으로 다시 "이거 실행해봐"를 입력:

```
>>> REPLACE handler firing: data="이" sending=\x7f+이
>>> REPLACE handler firing: data="익" sending=\x7f+익
>>> REPLACE handler firing: data="이" sending=\x7f+이
>>> REPLACE handler firing: data="거" sending=\x7f+거
...
```

화면 표시: `이거 실행해봐` ✅

### 3.5 교훈

- "같은 WebKit이니 Linux용 우회가 macOS에도 통하겠지"는 함정. **WKWebView와 WebKitGTK의 IME 이벤트 표현이 다르다** — Linux는 `composition*` 이벤트, macOS는 `input` 이벤트의 `insertReplacementText`.
- IME 디버깅은 추측보다 **textarea의 모든 keydown/input/composition* 이벤트를 backend stderr로 흘려 dev 로그에서 관측**하는 게 가장 빠르다. xterm 내부의 `onData`도 같이 찍어 "어떤 글자가 PTY에 실제로 갔는지"를 함께 보면 누락 지점이 즉시 드러난다.
- 셸 readline의 `\x7f`(DEL) 한 글자 삭제는 한글 1음절도 한 단위로 삭제한다 — IME의 replacement를 "백스페이스 + 새 데이터"로 PTY에 모사할 때 활용.

### 3.6 후속: 빠르게 치면 글자가 씹힌다 (§3.3 방식의 근본 한계 → 전체 라인 미러로 재설계)

**증상**: §3.3 수정 후에도 macOS에서 **빠르게** 한글을 치면 글자가 사라진다("글자 씹힘"). 예: `어떡하냐`를 빨리 → 화면 `어떡냐`(하 누락).

**근본 원인**: §3.3의 `"\x7f"+data`는 "insertReplacementText는 **직전 1음절**을 교체한다"고 가정한다. 느리게 치면 IME가 음절마다 확정(commit)해 맞다. 그러나 빠르게 치면 IME가 확정을 미루다가, 자모를 **새 음절로 넘길 때**(하 + ㄴㅕ → 하냐)도 `insertReplacementText "냐"`로 보고한다. 그러면 코드가 무조건 붙인 `\x7f`가 **이미 확정된 앞 음절 "하"를 지운다** → `어떡하` + `\x7f냐` = `어떡냐`.

**진단 방법**: `term_write`에 발신 순번(seq)·스레드·바이트를 실어 dev stderr로 관측. 확인된 사실:
- PTY 전송은 **단일 스레드 순서 보장**(재정렬 아님) — 순서 문제 가설 기각.
- 실측 바이트: 빠른 `어떡하냐` → `어떡하` 누적 후 `\x7f냐` → 셸에 `어떡냐`. 원인 확정.
- (부수 관측) TUI(Claude Code 등)가 커서 위치를 초당 수십~수백 번 질의 → xterm이 응답(`\x1b[?..R`)을 매번 개별 `term_write`로 쏘는 홍수가 있으나, 씹힘의 직접 원인은 아님(순서 보장됨).

**해결**: 이벤트별 `\x7f` 개수를 추측하지 않는다. **캡처 단계에서 읽는 `ta.value`(= 누적된 전체 조합 라인)를 미러(`imeSent`)와 코드포인트 diff** 하여 "정확한 백스페이스 수 + 추가분"만 보낸다(`src/lib/terminal-engine.ts`의 `imeLineDelta`). `어떡하`→`어떡하냐`면 공통 접두 `[어,떡,하]`가 보존되고 `냐`만 추가(=`\x7f` 0개) → `하`가 안 지워진다. NFC 한글 1음절 = 1 코드포인트 = 셸의 1삭제 단위라 `Array.from`이 곧 음절 단위 카운트.

- 한글(비-ASCII) `insertText`/`insertReplacementText` 가로채기는 **반드시 host(조상) 캡처 리스너**로 한다. textarea에 직접 붙이면(1차 구현 실패) xterm이 자기 input 리스너를 먼저 등록해둬서 — 같은 타깃에서는 등록 순서대로 실행 — 우리 `stopImmediatePropagation`이 xterm을 못 막는다. xterm 가드(`!e.composed||!_keyDownSeen`)가 WKWebView 한글 insertText를 통과시켜 **xterm도 보내고 우리도 보내는 이중 전송**이 된다(`ㅇ`→`ㅇㅇ`, 이어 `\x7f야`→`ㅇ야`). 조상의 캡처 리스너는 타깃의 어떤 리스너보다 먼저 실행이 스펙으로 보장되므로 `stopPropagation`으로 xterm 도달을 원천 차단할 수 있고, 그래야 xterm이 textarea를 비우지 않아 `ta.value`가 조합 런 전체를 누적한다 → 전체 라인 diff 성립.
- **ASCII(영문·숫자·기호·공백)는 xterm 기본 경로에 그대로 맡긴다**(영문 회귀 위험 최소화). 단 조합 런이 끝나므로 미러를 리셋한다 — 여기서 함정: **xterm 6은 일반 ASCII `insertText`에서 textarea를 비우지 않는다**(blur/Enter/Ctrl-C에서만). `imeSent`만 비우면 `ta.value`에 직전 한글 런이 남아, 다음 한글이 그 전체를 재전송해 **중복**된다(`이거 실행`→`이거 이거 실행`). 그래서 ASCII 분기에서 `resetImeMirror()`로 `ta.value`까지 비워 diff 기준선을 맞춘다.
- 조합 런 밖에서 라인을 바꾸는 키(Enter/Backspace/방향키/Tab/단축키)와 blur에서 미러를 리셋한다. 맨 Shift 등 수식키 단독은 제외(`가+Shift+ㄱ→가까` 조합 중 미러가 지워지지 않도록). **`term.onData`에서 제어바이트를 보고 리셋하면 절대 안 된다**(1차 구현 실패 #2): onData에는 키 입력만 아니라 xterm의 **자동응답**(커서위치 `\x1b[?..R`, DA, 포커스 `\x1b[I/O`, 마우스 리포트)이 상시 흐른다 — 프롬프트(starship/p10k)·TUI가 초당 수십 회 질의한다. 여기서 리셋하면 한글 조합 도중 미러+textarea가 계속 지워져 입력이 자모 파편·중복으로 깨진다.

**교훈**:
- 이벤트 단위 `\x7f` diffing은 IME의 **음절 경계가 흔들리는 빠른 타이핑**을 못 따라간다. 정답은 **textarea 값 자체를 셸 라인의 미러로 보고 전체를 diff** 하는 것(xterm이 Chromium에서 composition 이벤트로 하는 일을, 이벤트를 안 쏘는 WKWebView에서 손으로 재현).
- 같은 요소에 나중에 등록한 리스너로는 앞선 리스너를 못 막는다(`stopImmediatePropagation` 무효 — at-target은 등록 순서). **서드파티(xterm)가 소유한 요소의 이벤트를 가로채려면 조상 캡처**가 유일하게 순서가 보장되는 방법.
- **xterm 6은 평범한 ASCII `input`에서 textarea를 비우지 않는다**(blur/Enter/Ctrl-C만). `ta.value`를 미러로 읽으려면 리셋을 직접 해야 한다.
- `term.onData`는 "사용자 키 입력"이 아니라 "터미널이 앱에 응답하는 모든 바이트"다 — 자동응답이 상시 섞이므로 여기에 상태 리셋 같은 부수효과를 걸면 안 된다.
- (미해결/후속 여지) 커서 위치 응답 홍수는 `term_write` 배치(coalesce)로 IPC를 줄일 수 있으나 별개 과제.

> 상태: macOS 실측 검증 **완료** — 빠른 한글(`어떡하냐`, `야 이제 잘 좀 하자`), 한/영 혼합(`안a녕`), 겹자음(`가까`), 느린 입력 회귀 모두 정상.

---

## 4. 터미널에서 Shift+Tab이 포커스를 다른 요소로 옮긴다 (Claude Code 모드 전환 안 됨)

### 4.1 증상

임베디드 터미널에서 **Shift+Tab**을 누르면 터미널이 받지 못하고 웹뷰 포커스가 다른 UI 요소로 튄다. 터미널에서 Claude Code를 쓸 때 Shift+Tab(권한/모드 전환)이 안 먹힌다. 일반 Tab은 정상.

### 4.2 근본 원인 (두 겹)

1. **xterm 버그**: xterm은 일반 Tab엔 `cancel=true`(preventDefault)를 걸지만 Shift+Tab(`\x1b[Z`)엔 안 건다 — 키보드 처리부 `case 9: if(shiftKey){key=ESC+"[Z"; break}`. 그래서 웹뷰 기본 포커스 이동(Shift+Tab=이전 요소)이 안 막힌다.
2. **IME 가드에 삼켜짐**: 직접 `e.key === "Tab"`으로 잡아도, WebKitGTK가 Shift+Tab의 `e.key`를 때때로 `"Unidentified"`로 보고한다. 핸들러 상단의 IME 가드(`e.key === "Unidentified"` → return false, §3 참고)가 이를 먼저 삼켜 Tab 처리가 우회된다.

### 4.3 해결

`terminal-engine.ts`의 `attachCustomKeyEventHandler`에서 Tab/Shift+Tab을 **물리 키 `e.code === "Tab"`로, IME 가드보다 먼저** 잡는다. `e.code`는 IME/`e.key` 보고값과 무관한 물리 키라 항상 `"Tab"`이다.

```ts
if (e.code === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
  e.preventDefault();                       // 웹뷰 포커스 이동 차단
  void invoke("term_write", {
    termId: opts.id,
    data: e.shiftKey ? "\x1b[Z" : "\t",      // Shift+Tab→백탭, Tab→탭
  }).catch(() => {});
  return false;
}
```

### 4.4 교훈

- 키 이벤트는 `e.key`(논리값, IME에 흔들림)보다 **`e.code`(물리 키)** 가 안정적이다. 특수키/단축키는 `e.code`로 잡으면 IME·레이아웃에 안 흔들린다.
- IME 가드(`Unidentified`/`Process`/keyCode 229)는 광범위해서 Tab 같은 **비-IME 키도 삼킬 수 있다** — 비-IME 키 처리는 IME 가드 **앞**에 둔다.

---

## 5. 화면이 통째로 까맣게 먹통 — WebKitGTK + NVIDIA + 터미널 WebGL 렌더러

### 5.1 증상

앱을 한참 쓰다 보면(특히 분할로 터미널을 여러 개 띄운 상태) **창 전체가 갑자기 까맣게** 먹통된다. 입력도 안 되고 아무것도 안 그려진다.

### 5.2 근본 원인

WebKitGTK의 **웹뷰 렌더러 프로세스(WebKitWebProcess)가 크래시**한 것. 메인(Rust) 프로세스는 살아 있어 창틀은 떠 있지만 내용이 안 그려진다.

- 확인: `pstree -p <앱PID>`에 **WebKitWebProcess가 없고**(NetworkProcess만 남음), `/var/crash/..._WebKitWebProcess..._crash` 덤프가 먹통 시각에 남는다. 앱 로그·panic.log엔 안 남는다(네이티브 렌더러 크래시라 Rust 패닉 훅·JS 둘 다 못 잡는다).
- 원인: **NVIDIA 프로프라이어터리 드라이버 + WebKitGTK + WebGL**. 터미널이 GPU 가속 렌더러(`@xterm/addon-webgl`)를 쓰는데, 이 조합에서 WebGL 컨텍스트가 렌더러 프로세스를 죽인다. 분할로 터미널이 많으면 WebGL 컨텍스트가 여럿이라 더 잘 터진다(`card0`가 `simple-framebuffer`로 잡히는 등 GL 경로가 비정상인 환경에서 특히).

### 5.3 해결 (두 겹)

1. **터미널 WebGL을 WebKitGTK(Linux)에서 끈다** — `terminal-engine.ts`에서 `if (!isWebKitGtk)`로 감싸 WebView2(Windows)/WKWebView(macOS)에서만 WebGL을 켜고, WebKitGTK에서는 안정적인 기본 DOM 렌더러를 쓴다.
2. **WebKitGTK DMABUF 렌더러를 끈다** — `lib.rs`에서 GTK init 전에 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 설정(NVIDIA에서 웹뷰 렌더링 안정화).

### 5.4 교훈

- WebKitGTK(Linux)의 **WebGL/하드웨어 가속 렌더링은 GPU 드라이버 조합에 매우 취약**하다 — Chromium(WebView2)에서 멀쩡한 GPU 기능이 WebKitGTK에선 렌더러를 죽인다. GPU 가속 기능은 플랫폼별로 분기하라.
- "메인은 살아있는데 화면만 까맣다" = 거의 항상 **웹뷰 렌더러 프로세스 크래시**. `pstree`로 WebKitWebProcess 생존 여부 + `/var/crash`를 먼저 본다.
