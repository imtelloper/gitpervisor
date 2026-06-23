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
