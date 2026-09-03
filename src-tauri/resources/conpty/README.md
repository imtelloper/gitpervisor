# 번들 ConPTY (Windows 전용)

Windows 10의 ConPTY는 **OS 내장 conhost**(2018~2022년 세대)라 Windows Terminal 1.17+/
Windows 11 22H2+에 들어간 수정(스크롤백 보존·리플로우·재도색 축소·win32-input 개선)이 없다.
그래서 Windows 10에서 Claude Code 같은 TUI의 **출력이 스크롤백에 안 남아 위로 올라갈 수 없다**.

여기 있는 conpty.dll/OpenConsole.exe를 앱 옆에 두면 PTY 백엔드(`portable-pty`)가 이걸
**사이드로드**한다 — `psuedocon.rs`의 `load_conpty()`가 `LoadLibraryW("conpty.dll")`를 먼저
시도하고 실패할 때만 kernel32로 폴백한다. 앱은 첫 PTY 생성 전에 `SetDllDirectoryW`로 이
폴더를 DLL 검색 경로에 넣는다(`src-tauri/src/lib.rs`). conpty.dll은 **자기 디렉터리의**
OpenConsole.exe를 띄우므로 두 파일이 같은 폴더에 있어야 한다.

설계 배경: `DOCS/task/33-windows-conpty-bundle.md`.

## 버전·해시

`Microsoft.Windows.Console.ConPTY` **1.24.260710001** (MIT, © Microsoft Corporation) —
NuGet 패키지 sha256 `175640566a3b59c4b132070ee96c2c77e5ab7edd2e92732a5eb3610bbf63d90e`
(스크립트가 이 값을 **고정 대조**하고, 불일치면 중단한다).

파일 버전 1.24.2607.10001, sha256:

| 파일 | 크기 | sha256 |
|---|---|---|
| `x64/conpty.dll` | 109,920 | `39fba2713e2495117b1591ae8c32a3b904bea7aa66069cf7815e2844c76d75d8` |
| `x64/OpenConsole.exe` | 1,066,296 | `b7fd936c2668b87b9ecf7b3366dc6568afc1c6f981874cba3e955a1c35cf8160` |
| `arm64/conpty.dll` | 106,336 | `db3d173640b172bafd42d5b541b638a9aeec1c7d0e40dd636bf02822a32c912c` |
| `arm64/OpenConsole.exe` | 1,120,056 | `ed7622fd0d3bedc9ab9f122f5e58edf0def9e7999224f52dd395ba9f54edbe09` |

conpty.dll은 `CreatePseudoConsole`/`ResizePseudoConsole`/`ClosePseudoConsole`을 **접두 없는
원래 이름으로도** export한다(`Conpty*` 접두 심볼과 함께, x64·arm64 동일 — PE export 테이블
실측 2026-09-03). portable-pty가 찾는 이름이 그것이므로 사이드로드가 실제로 먹는다.

## 바이너리는 git에 커밋하지 않습니다

`.gitignore`(`src-tauri/resources/conpty/**/*.dll`·`*.exe`) — tools와 같은 관례다. 재현:

```
npm run fetch-tools -- conpty              # conpty만 — 호스트 아키텍처 하나
npm run fetch-tools -- conpty --all-arch   # x64 + arm64 둘 다
npm run fetch-tools                        # ruff + biome + conpty
```

**기본은 호스트 아키텍처 하나만** 받는다(`process.arch`). 설치본은 어차피 자기 arch의 DLL만
쓰므로 반대편까지 넣으면 +1.2MB가 그냥 늘어난다 — CI도 아키텍처 매트릭스별로 자기 것만 받는다.
위 해시 표는 두 arch를 다 적어 두었을 뿐이고, 이 폴더에는 받은 것만 있다.

Windows 호스트에서만 받는다(nupkg 추출에 Windows `tar.exe`를 쓰고, 어차피 Windows 설치본
전용 리소스다). 다른 호스트에서는 경고 한 줄 남기고 건너뛴다 → `bundle.resources` 글롭이
LICENSE·README만 잡아 Linux/macOS 번들에는 바이너리가 안 들어간다.

## 갱신 절차

1. https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY 에서 새 버전 확인.
2. `scripts/fetch-tools.mjs`의 `CONPTY_VERSION`·`CONPTY_SHA256`을 새 값으로 바꾼다
   (해시는 nupkg를 받아 `Get-FileHash -Algorithm SHA256`).
3. `npm run fetch-tools -- conpty` → 위 표의 파일 해시·크기를 갱신.
4. 앱 로그에 `ConPTY: 번들 … 사용` + `사이드로드 확인`이 찍히는지 본다(태스크 33 §7).
