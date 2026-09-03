# 태스크 33 — Windows 10 터미널 스크롤 불가 · 최신 ConPTY 번들

> 상태: **구현 완료 · 검증 통과(2026-09-03, 미커밋)** — 결과는 §8·§9 · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-03(portable-pty 0.8.1 소스·xterm 6.0.0 소스·NuGet 패키지 내용) · 짝 태스크: `32-terminal-enter-modifiers.md`

## 1. 요구사항

Windows 10에서 Claude Code 세션의 **스크롤이 안 돼 위 내용을 볼 수 없는** 문제(크리티컬)를 고친다.

받아들이는 조건:
- Windows 10에서도 Claude Code(ink TUI) 출력이 스크롤백에 남고 휠/스크롤바로 위로 올라간다.
- Windows 11·Linux·macOS 동작은 유지. 설치본 크기 증가 ≤ 2MB.
- 어떤 ConPTY를 쓰는지 로그로 알 수 있다.

## 2. 현황(근거)

- **PTY 백엔드**: `portable-pty = "0.8.1"`(`Cargo.toml:43`). Windows는 `native_pty_system()` → ConPTY. 앱 코드에 ConPTY 조건/플래그
  없음(`terminal.rs:102-243`).
- **사이드로드 경로가 크레이트에 내장돼 있다** — `portable-pty-0.8.1/src/win/psuedocon.rs:32-63`:
  ```rust
  fn load_conpty() -> ConPtyFuncs {
      let kernel = ConPtyFuncs::open(Path::new("kernel32.dll")).expect("…Windows 10 October 2018 or newer is required");
      // We prefer to use a sideloaded conpty.dll and openconsole.exe host deployed alongside the application.
      if let Ok(sideloaded) = ConPtyFuncs::open(Path::new("conpty.dll")) { sideloaded } else { kernel }
  }
  lazy_static! { static ref CONPTY: ConPtyFuncs = load_conpty(); }
  ```
  `open("conpty.dll")`은 `LoadLibraryW` 베어 파일명(`shared_library-0.1.9/src/dynamic_library.rs:340`) → **Windows DLL 검색 순서**(1. exe
  디렉터리 → 시스템 → … → `SetDllDirectory` 경로 → PATH). `lazy_static`이라 **첫 PTY 생성 시 1회** 결정된다. 심볼은
  `CreatePseudoConsole/ResizePseudoConsole/ClosePseudoConsole` 이름으로 찾는다(sideloaded conpty.dll도 같은 이름을 export한다 —
  NuGet `inc/conpty.h`의 `Conpty*` 접두 심볼과 **별개로** 원래 이름도 export; VS Code·WezTerm이 같은 방식으로 쓴다. §7에서 실측).
- 생성 플래그 `RESIZE_QUIRK | WIN32_INPUT_MODE`(0x6) 고정(`psuedocon.rs:86`), `PASSTHROUGH_MODE`(0x8)는 미사용 상수.
- **xterm 쪽**: `terminal-engine.ts:181-199` `new Terminal({ scrollback: 5000, windowsPty: { backend: "conpty" } })`. xterm 6.0.0에서
  `backend`만 있으면 행 증가 시 스크롤백에서 끌어오지 않고 빈 줄 push(`Buffer.ts:184`), 리플로우는 `buildNumber` 부재로 **활성**
  (`Buffer.ts:296-302`), wrap 휴리스틱은 **비활성**(`CoreTerminal.ts:253-265`). 앱에 wheel 핸들러·`attachCustomWheelEventHandler`·
  `registerCsiHandler` 사용처 없음. 휠은 xterm 내부: 마우스 프로토콜이 켜지면 PTY로 전달(`CoreBrowserTerminal.ts:727-757`) + 뷰포트
  스크롤 비활성(`Viewport.ts:65-70`); alt 버퍼면 ↑/↓ 키로 변환(`:806-840`).
- **Windows 10의 ConPTY는 OS 내장 버전(conhost)** — 2018~2022년 빌드. Windows Terminal 1.17+/Windows 11 22H2+의 ConPTY에 들어간
  수정(리플로우·스크롤백 보존·전체 재도색 축소·passthrough 준비·win32-input 개선)이 없다. VS Code는 이 문제로 **번들 conpty.dll을
  쓰는 설정**(`terminal.integrated.windowsUseConptyDll`)을 추가했고 WezTerm은 항상 사이드로드한다. 사용자 보고("Windows 10에서만
  스크롤 불가, 위 내용을 볼 수 없다")는 이 부류다 — 이 머신(Windows 11 26200)에서는 재현되지 않는다.
- **재배포 가능한 최신 ConPTY**: NuGet `Microsoft.Windows.Console.ConPTY` **1.24.260710001**(MIT, "Windows 10.0.17763.0 이상"),
  nupkg sha256 `175640566a3b59c4b132070ee96c2c77e5ab7edd2e92732a5eb3610bbf63d90e`, 내용: `runtimes/win-x64/native/conpty.dll`(110KB),
  `build/native/runtimes/x64/OpenConsole.exe`(1.07MB), arm64·x86 동일 구조. 2026-09-03 실측(scratchpad `conpty.nupkg`).
- **번들 관례**: `tauri.conf.json bundle.resources = { "resources/tools/*": "tools" }` → `resource_dir()/tools`(`tools/runner.rs:293-296`).
  다운로드는 `scripts/fetch-tools.mjs`(버전 pin·재시도·Windows `tar.exe` 추출, ruff는 `.sha256` 대조). `npm run fetch-tools`.
- 앱 로그 관례: `log::info!`(tauri-plugin-log). 설정에 터미널 관련 필드는 shell·fontSize뿐.

## 3. 설계

### 3.1 최신 ConPTY 사이드로드(Windows 전용)

| 대안 | 평가 |
|---|---|
| **A. NuGet ConPTY(conpty.dll + OpenConsole.exe)를 번들하고, 첫 PTY 전에 `SetDllDirectoryW(resource_dir/conpty/<arch>)`** (채택) | 크레이트 수정 0, 코드 ~30줄. Win10에 Win11 이상 ConPTY 제공. 실패 시 kernel32 폴백은 크레이트가 이미 한다 |
| B. exe 옆에 직접 복사(resources 매핑 `"."`) | 아키텍처별 파일을 정적 매핑으로 고를 수 없다(x64/arm64 빌드 매트릭스). 런타임 선택이 필요 |
| C. portable-pty 포크/업그레이드로 PASSTHROUGH 등 플래그 제어 | 큰 변경. 사이드로드만으로 목표 달성 |
| D. xterm 옵션만 조정 | 원인이 ConPTY 렌더링이라 프론트로는 못 고친다 |

- 파일: `src-tauri/resources/conpty/{x64,arm64}/{conpty.dll,OpenConsole.exe}` + `resources/conpty/LICENSE.txt`(MIT, © Microsoft) +
  `README.md`(출처·버전·해시·갱신 절차). `.gitignore`는 tools와 동일하게 바이너리 제외(스크립트로 재현).
- `scripts/fetch-tools.mjs`에 `conpty` 타깃: nupkg 다운로드 → **sha256 고정값 대조(불일치 throw)** → `tar.exe`로 4개 파일 추출 → 배치.
  `npm run fetch-tools`(인자 없음)가 conpty도 받게. CI(`release.yml`)의 fetch 단계가 이 스크립트를 부르는지 확인해 같이 타게 한다.
- `tauri.conf.json bundle.resources`에 `"resources/conpty/**/*": "conpty"` 추가(Windows 외 플랫폼엔 파일이 없으면 glob이 비어 무해 —
  안 되면 `tauri.windows.conf.json`으로 분리).
- Rust `lib.rs` setup(첫 커맨드보다 앞, Windows만): `resource_dir()/conpty/<x64|arm64>`(`std::env::consts::ARCH` → "x86_64"→x64,
  "aarch64"→arm64)에 `conpty.dll`과 `OpenConsole.exe`가 **둘 다** 있으면 `SetDllDirectoryW(dir)` + `log::info!("ConPTY: 번들 {ver} 사용 ({dir})")`,
  없으면 `log::info!("ConPTY: OS 내장")`. `SetDllDirectoryW`는 `windows-sys` `Win32_System_LibraryLoader` feature 추가(1개).
  conpty.dll은 자기 디렉터리의 OpenConsole.exe를 띄운다(둘을 같은 폴더에).
- **dev**: `resource_dir()`이 dev에서 어디를 가리키는지 로그로 확인(tauri-build가 `bundle.resources`를 target 디렉터리에 복사한다 —
  `tools/`가 dev에서 발견되는 것과 같은 경로). 안 되면 dev 한정으로 `CARGO_MANIFEST_DIR/resources/conpty` 폴백.
- 어떤 ConPTY가 로드됐는지 **확인 가능한 신호**: `term_open` 성공 후 1회 `GetModuleHandleW("conpty.dll")`이 non-null이면 번들
  (`log::info!("ConPTY: 사이드로드 확인")`). 실측(§7)의 근거.

### 3.2 xterm — 번들 ConPTY에 맞춘 옵션

번들 ConPTY(1.24 = Windows 11 24H2 세대)에서는 `windowsPty: { backend: "conpty", buildNumber: 26100 }`으로 xterm에 알린다 —
`_isReflowEnabled`가 conpty+buildNumber≥21376 → true, wrap 휴리스틱 off(현재와 결과 동일하지만 **의도가 옵션에 드러난다**). OS 내장
ConPTY(Win10)에서 번들이 없을 때는 지금처럼 `buildNumber` 생략. 프론트가 어느 쪽인지 알려면 `term_open` 응답에 `conpty: "bundled"|"os"|null`
을 실어 준다(Rust 1필드 추가).

### 3.3 스크롤 UX 보강(플랫폼 공통, 작음)

- `attachCustomWheelEventHandler`: 마우스 프로토콜이 켜진 TUI 위에서 **Shift+휠**은 뷰포트를 스크롤한다(`term.scrollLines(±3)`, return false)
  — Windows Terminal·VS Code와 같은 탈출구. 프로토콜이 꺼져 있거나 alt 버퍼면 기본 동작.
- **진단 프로브(구현 중 1회, §7)**: Claude Code를 앱 터미널에서 띄운 상태의 `buffer.active.type`·`modes.mouseTrackingMode`·휠 후
  `viewportY` 변화를 기록해 이 머신(Win11)에서 스크롤이 정상임을 확인하고, 마우스 프로토콜 여부를 문서에 남긴다(Win10 원인 판별의 대조군).

### 3.4 만들지 않는 것

- `PSEUDOCONSOLE_PASSTHROUGH_MODE` — 크레이트가 플래그를 고정. 번들만으로 목표 달성 여부를 먼저 본다.
- portable-pty 업그레이드(0.9.x) — API 변화·검증 범위 확대. 후속.
- Windows 10 실기 — 이 머신에 없다. CI/사용자 검증 항목으로 명시(§7).

## 4. 계약

```rust
// src-tauri/src/lib.rs (setup, cfg(windows))
fn install_bundled_conpty(app: &tauri::AppHandle) -> Option<PathBuf>;   // SetDllDirectoryW 성공 시 디렉터리
// commands/terminal.rs term_open 응답 구조체(있으면)에 `conpty: Option<&'static str>` — "bundled" | "os"
```
```ts
// src/lib/terminal-engine.ts
windowsPty: isWindows ? { backend: "conpty", ...(conpty === "bundled" ? { buildNumber: 26100 } : {}) } : undefined
term.attachCustomWheelEventHandler(ev => { if (ev.shiftKey && term.modes.mouseTrackingMode !== "none" && term.buffer.active.type === "normal") { term.scrollLines(Math.sign(ev.deltaY) * 3); return false; } return true; });
```

## 5. 단계

1. `scripts/fetch-tools.mjs` conpty 타깃 + 실행 → 파일 배치 + LICENSE/README. `.gitignore`.
2. `tauri.conf.json` resources, `Cargo.toml` feature, `lib.rs` `install_bundled_conpty` + 로그, `term_open` 응답 필드. **저장은 조율 신호 후
   (31의 Rust와 같은 재빌드).** `cargo test`.
3. `terminal-engine.ts` 옵션·Shift+휠. `tsc`.
4. 실측 §7. `DOCS/TROUBLESHOOTING.md` 항목("Windows 10에서 TUI 스크롤/줄바꿈") + `CLAUDE.md` 빌드 절에 "conpty 리소스도 fetch-tools로" 한 줄.
5. `.github/workflows/release.yml`에서 fetch 단계가 conpty를 포함하는지 확인·수정(Windows 잡만).

규모: **M** — 스크립트 ~80 LOC, Rust ~60 LOC, 프론트 ~25 LOC, 문서.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| 심볼 이름 불일치 | 번들 conpty.dll이 `CreatePseudoConsole` 원래 이름을 export 하지 않으면 크레이트가 kernel32로 폴백(무해하지만 효과 0) | §7-1에서 `dumpbin`/PowerShell로 export 목록 확인. 없으면 `Conpty*` 이름을 쓰는 로더 대체가 필요 → 그때 설계 보강 |
| OpenConsole.exe 프로세스 위생 | 터미널마다 OpenConsole.exe 1개(기존 conhost.exe와 동일 개수) | `terminate_tree`·세션 종료 경로 동일. e2e 06/28의 프로세스 누수 단언이 잡는다 |
| 서명 | OpenConsole.exe는 Microsoft 서명본, 우리 설치본은 CI Authenticode | 파일 변경 없음 — 서명 유지 |
| 크기 | +1.2MB(x64) | 허용(≤2MB) |
| dev resource_dir | dev에서 경로가 달라 번들이 안 잡히면 dev만 OS ConPTY | 로그로 확인, 폴백 경로 |
| Win10 미검증 | 이 머신 Win11 | 릴리스 노트에 "Windows 10 스크롤 문제 수정 — 확인 요청" + 로그 문자열로 사용자 확인 가능 |

## 7. 검증

1. `Get-Command`가 아니라 PowerShell로 export 확인: `(Get-Item conpty.dll)` + `dumpbin /exports`(VS 있으면) 또는 python `pefile` 대체로
   `CreatePseudoConsole`·`ConptyCreatePseudoConsole` 둘 다 있는지 기록.
2. 디버그 앱 재빌드 후 로그: `ConPTY: 번들 … 사용` + `사이드로드 확인`. 터미널 열기 → `tasklist`에 `OpenConsole.exe`가 PTY 수만큼,
   `conhost.exe`는 늘지 않음. 터미널 닫기 → 둘 다 정리.
3. 32의 키 에코 프로토콜을 **번들 ConPTY에서** 다시 실행(9001 수신·Alt/Shift+Enter 번역 확인).
4. Claude Code 프로브(§3.3): 긴 출력 후 휠 스크롤 → `viewportY` 감소, `buffer.active.type`, `mouseTrackingMode` 기록. Shift+휠 동작.
5. e2e 06/28 기존 프로세스 누수 단언 통과, 전체 러너 회귀 없음.
6. Windows 10: 사용자/CI 검증 항목으로 릴리스 노트에 남긴다(이 머신 불가).

## 8. 구현 중 결정(2026-09-03, 프론트·스크립트 단계)

- **export 확인 통과**: 번들 `conpty.dll`(x64·arm64, 파일 버전 1.24.2607.10001)이 무접두 `CreatePseudoConsole/ResizePseudoConsole/ClosePseudoConsole`
  과 `Conpty*` 접두 심볼을 **둘 다** export한다(PE export 테이블 직접 파싱, 스크래치 `pe-exports.ps1`). portable-pty 0.8.1의 사이드로드가
  kernel32 폴백 없이 먹는다 — §6 첫 행 위험 해소.
- **§3.2 `windowsPty.buildNumber`는 제거한다.** `windowsPty`는 `new Terminal()` 생성자 옵션이라 `term_open` 응답으로는 정할 수 없고
  (구조적 충돌), 현재 상태(`buildNumber` 부재)에서도 리플로우 활성·wrap 휴리스틱 비활성으로 **결과가 같다**(§2). 옵션은 그대로 둔다.
  `term_open` 응답의 `conpty: "bundled"|"os"` 필드는 **로그·e2e용으로만** 유지(프론트 동작에 안 쓴다).
- **아키텍처는 호스트 것만 번들**: `fetch-tools conpty`가 기본으로 `process.arch`(x64/arm64) 하나만 배치, `--all-arch`로 둘 다. CI는 아키텍처
  매트릭스별로 자기 것만 받는다. 설치본 증가 +1.2MB(예산 ≤2MB 준수). `bundle.resources` 글롭 `resources/conpty/**/*`는 존재하는 것만 담는다.
- **`release.yml`에는 fetch 단계가 원래 없다**(ruff/biome 번들도 릴리스에 안 들어가고 있었다 — 선행 gap, 이번 범위 밖). conpty용으로
  **Windows 잡 한정** `npm run fetch-tools -- conpty` 스텝을 빌드 전에 추가한다.
- 워처가 `src-tauri/resources/`도 감시하므로(`@tauri-apps/cli`의 ignore 규칙에 제외 패턴 없음) conpty 파일·LICENSE·README 배치도 Rust 저장과
  같은 시점에 한다(scratchpad `pending-resources/conpty/`에 준비).
- **dev는 `resource_dir()`보다 소스 폴더를 먼저 본다**(`lib.rs`의 `install_bundled_conpty`).
  `cfg!(debug_assertions)`이고 `concat!(env!("CARGO_MANIFEST_DIR"), "/resources/conpty")/<arch>`에 두
  파일이 다 있으면 그 경로를 `SetDllDirectoryW`에 넣고, 아니면 종전대로 `resource_dir()`(릴리스는 항상 이쪽).
  이유는 **잠금**이다 — 앱이 `target/debug/conpty/x64/conpty.dll`을 로드하면 그 파일이 잠겨 **다음
  빌드의 tauri-build 리소스 복사가 `os error 32`로 실패하고 재빌드가 통째로 막힌다**(dev 앱을 켜 둔 채
  개발하는 이 저장소의 기본 상황에서 매번 걸린다). 소스 폴더는 빌드가 덮어쓰지 않으니 잠겨도 무해하다.
  이미 잠긴 상태라면 그 한 번만 `conpty.dll`을 `conpty.dll.locked`로 rename하고 빌드한다.
  어느 경로를 잡았는지는 로그가 그대로 찍는다:
  `ConPTY: 번들 1.24.260710001 사용 (F:\gitpervisor\src-tauri/resources/conpty\x64)`.
  실측(2026-09-03): 이 변경 뒤 dev 재빌드 2m39s 성공, `term_open` 응답 `{"conpty":"bundled"}`,
  터미널 1개에 `OpenConsole.exe` 3→4(닫으면 3), `conhost.exe`는 늘지 않음.

## 9. 실측 결과(2026-09-03)

환경: Windows 11 26200 · 디버그 dev 앱 · 번들 ConPTY 1.24.2607.10001 · pwsh · xterm 92x47.

### 9.1 번들 판정(§7-1·7-2)

`term_open` 응답 `{"conpty":"bundled"}`, 로그 `ConPTY: 사이드로드 확인`이 **term_open마다** 한 줄.
첫 PTY 출력 23바이트는 `\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h` — 번들 ConPTY도 win32-input-mode를
그대로 켠다(§6 "9001 미수신" 위험 해소, 32 §9와 같은 관측).

### 9.2 OpenConsole 위생(§7-2)

터미널을 하나씩 3개까지 열었다가 다시 닫으며 `tasklist`(각 상태에서 두 값을 함께 측정):

| 상태 | OpenConsole.exe | conhost.exe |
|---|---|---|
| 0개(기준) | 9 | 104 |
| 1개 | 10 | 94 |
| 2개 | 11 | 103 |
| 3개 | 12 | 93 |
| 2개(닫는 중) | 11 | 91 |
| 1개 | 10 | 93 |
| 0개 | 9 | 94 |

터미널당 정확히 **+1 / −1**, 잔존 0. `conhost.exe`는 90~104 사이를 무관하게 오르내린다(머신 전체 잡음 —
우리 터미널과 상관없다). Claude Code 종료 뒤 `claude.exe`/`node.exe` 잔존도 0(32 §9.3).

### 9.3 Claude Code에서의 스크롤(§3.3 진단 프로브)

Claude Code v2.1.258 실행 중 버퍼 상태: **`buffer.active.type = "alternate"`,
`modes.mouseTrackingMode = "any"`, `viewportY = baseY = 0`, `length = 47`(= rows)**.
대체화면이라 **스크롤백이 존재하지 않는다** — 휠(−300)도 Shift+휠도 `viewportY` 변화 0.
Win11에서도 Claude Code 화면 자체는 위로 올라가지 않는다.

사용자의 Windows 10 보고와는 **축이 다르다는 점에 주의**: 여기서 확인된 것은 "alt 버퍼엔 원래 스크롤백이
없다"이고, Win10 문제는 alt 버퍼를 벗어난 뒤(종료 후·일반 출력)의 **스크롤백 보존**이다. 후자는 이 머신에서
재현되지 않는다(§2·§6의 "Win10 미검증" 그대로).

### 9.4 Shift+휠 탈출구(§3.3)

**합성 `WheelEvent`(`dispatchEvent`)로는 검증할 수 없다** — `isTrusted=false`라 Chromium이 기본 동작
(네이티브 스크롤)을 수행하지 않아 아무것도 움직이지 않는다. CDP `Input.dispatchMouseEvent(mouseWheel)`로 측정:

| 상황 | 휠 −300 | Shift+휠 −300 |
|---|---|---|
| pwsh, normal 버퍼, mouse=none, 300줄 출력 뒤 | viewportY 256 → 253 | 변화 없음(기본 경로) |
| 같은 버퍼에 `?1003h` 주입(mouse=any) | 변화 없음(휠이 PTY로 간다) | 256 → 253 → 250, +300에 253 복귀 |
| Claude Code(alternate, mouse=any) | 변화 없음 | 변화 없음 |

설계대로 동작한다. 다만 **Claude Code에는 이 탈출구가 닿지 않는다** — 핸들러가 normal 버퍼로 한정돼 있고
(§3.3), alt 버퍼엔 스크롤할 스크롤백 자체가 없다. 실제 효용은 normal 버퍼에서 마우스 추적을 켜는 TUI다.

### 9.5 휠 전달 프로브 — 사용자 증상 "위 내용을 볼 수 없다"의 실제 경로

Claude Code는 alt 버퍼 + `mouseTrackingMode=any`로 돈다(§9.3). 그래서 "위를 본다"는 것은 xterm 스크롤백이
아니라 **휠 이벤트가 SGR 마우스 보고로 PTY에 전달되고 Claude가 자기 트랜스크립트를 스크롤**하는 경로다.
번들 ConPTY 1.24.2607.10001 환경에서 그 경로가 실제로 도는지 측정했다(Claude Code v2.1.259, xterm 92x47,
CDP `Input.dispatchMouseEvent`, 스크래치 `probe33-wheel3.mjs`).

**측정 조건 주의**: 47행에서는 대화가 화면을 넘지 않아 스크롤할 것 자체가 없었다(1·2차 프로브가 "변화 없음"으로
보인 원인 — 판정 불능이지 실패가 아니다). `term.resize(92, 16)`으로 화면을 줄여 내용이 넘치게 만든 뒤 재측정했다.

관측값:

- 마우스 상태: `modes.mouseTrackingMode = "any"`, `coreMouseService.activeProtocol = "ANY"`,
  `activeEncoding = "SGR"`, `buffer.active.type = "alternate"`.
- xterm이 PTY로 실제 내보낸 바이트(`term.onData` 후킹): 휠 위 `\e[<64;47;9M`, 휠 아래 `\e[<65;47;9M` —
  노치마다 정확히 1개. `onBinary`는 0개.
- **휠 −120 ×3**: 16행 중 7행이 바뀌었다. 밀려 올라가 있던 배너가 다시 나타났다 —
  전 `1| ⚠ 1 MCP server needs authentication · run /mcp` → 후 `1| ▐▛███▛█   Claude Code v2.1.259`,
  `2| ▝▜██████▀  Fable 5.1 with xhigh effort · Claude Max`. 동시에 Claude가
  `Jump to bottom (ctrl+End) ↓`를 그렸다 — **Claude 자신이 "스크롤됨" 상태로 들어갔다는 증거**다.
- **휠 −600 ×3 추가**: 16/16 동일(트랜스크립트 맨 위라 더 갈 곳이 없다).
- **휠 +120 ×6**: 원래 화면으로 복귀(트레일링 공백만 다른 2행 제외 동일).

**판정: 이 머신(번들 ConPTY)에서 휠 전달 경로는 정상 동작한다.** 즉 §9.3의 "viewportY가 안 움직인다"는
xterm 스크롤백이 없다는 뜻일 뿐이고, 사용자가 원하는 "위 내용 보기"는 Claude 내부 스크롤로 정상 수행된다.

키보드 대안(같은 프로브): **PageUp(`\e[5~`)/PageDown(`\e[6~`)이 휠과 동등하게 동작한다** —
PageUp ×2로 맨 위, PageDown ×2로 정확히 원위치(16/16 동일). Ctrl+U(`\x15`)는 무변화(입력줄 편집용),
Ctrl+O(`\x0f`)는 스크롤이 아니라 상세 트랜스크립트 토글이다. 휠이 안 먹는 환경에서 안내할 값은 PageUp/PageDown.

Windows 10 검증 항목(이 머신에서는 재현 불가 — Win11만 있다):

1. 휠을 굴렸을 때 xterm이 `\e[<64;…M`을 내보내는가 — 이건 웹뷰/xterm 몫이라 OS와 무관하게 같아야 한다.
2. **그 바이트를 ConPTY가 자식(claude)의 stdin으로 전달하는가** — Win10 내장 ConPTY의 마우스 VT 입력
   변환이 의심 지점이고, 번들 1.24가 고칠 것으로 본 부분이다. 확인 절차는 위와 같다:
   대화를 화면보다 길게 만든 뒤 휠 위 3회 → 위쪽 줄이 나타나고 `Jump to bottom (ctrl+End) ↓`가 뜨면 정상.
3. 2가 안 되면 PageUp/PageDown이 먹는지 본다(같은 stdin 경로지만 마우스 변환을 타지 않는다).
   둘 다 안 되면 ConPTY가 아니라 stdin 전달 자체를 의심해야 한다.

부수 관측(이번 범위 밖, 고치지 않았다): 앱은 `term.onData`만 PTY로 넘긴다(`terminal-engine.ts`).
xterm은 마우스 인코딩이 SGR일 때만 `triggerDataEvent`(=`onData`)를 타고, 레거시 DEFAULT(X10) 인코딩이면
`triggerBinaryEvent`(=`onBinary`)로 보낸다(`@xterm/xterm/src/common/services/CoreMouseService.ts:325-332`).
Claude Code는 SGR이라 무관하지만, `?1006` 없이 `?1000`만 켜는 옛 TUI의 마우스 입력은 조용히 버려진다.

### 9.6 번들 ConPTY의 DA1 핸드셰이크 — 원시 PTY 소비자 주의(2026-09-03)

번들 1.24는 PTY를 열자마자 `\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h`를 내보내며 그중 **`ESC [ c`(DA1)는 응답을 기다린다.**
터미널(xterm.js)은 자동으로 `\x1b[?…c`를 회신하므로 앱에서는 아무 차이가 없지만, 회신하지 않는 소비자(e2e의 `openChannel()` 원시
채널)는 내부 시한 ~3.4s가 지나야 셸 출력이 시작된다(실측: 프롬프트까지 번들 5.0~5.3s ↔ DA1 수동 회신 시 1.7s ↔ OS 내장 1.1~1.6s).
전체 러너의 12-new-commands 2건 실패가 이것이었고(고정 800ms 대기), 스위트를 마커 폴링(15s)으로 바꿔 3/3 통과. 번들 ON/OFF 대조에서
14 #2b(PTY 폭 복구)는 양쪽 4/4 통과 — 회귀 아님(전체 러너 부하 시 기대값 스냅샷이 낡는 간헐 결함, 다른 세션 소관).
