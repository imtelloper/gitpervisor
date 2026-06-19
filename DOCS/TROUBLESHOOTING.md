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
