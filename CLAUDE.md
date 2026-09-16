# Gitpervisor — 작업 지침

멀티 레포 Git 대시보드. Tauri v2 (Rust) + React/TypeScript, Windows·macOS·Linux(x86_64/ARM64).

이 문서는 **모르면 시간을 버리거나 사고가 나는 것**만 담는다. 코드 구조는 코드가, 설계 배경은
`DOCS/*.md`가, 배포 절차는 `.claude/skills/gitpervisor-deploy/`가 설명한다.

---

## 브랜치 — `main`에서 바로 작업한다

**기능 브랜치를 만들지 마라.** 이 줄은 전역 규칙(`~/.claude/CORE.md`의 "Feature branches only")보다
우선한다 — 개발자가 한 명이고 리뷰 단계가 없어서 브랜치는 병합 왕복만 늘린다. 게다가 브랜치를
오가는 `git checkout`/`stash`는 **tauri dev를 통째로 재빌드**시킨다(회차당 ~3분).

예외 하나: **릴리스는 태그 워크트리에서 빌드한다**(`.claude/skills/gitpervisor-deploy/`).
공유 트리에서 빌드하면 검증한 물건과 실제로 나가는 물건이 달라진다.

다른 세션이 같은 트리를 동시에 고치고 있으면 그때만 별도 워크트리로 격리한다 — 두 세션이 같은
파일을 저장하면 vite HMR이 서로의 e2e 회차를 깬다.

---

## 개발 실행

```bash
npm run dev:app     # = tauri dev --config src-tauri/tauri.dev.conf.json
```

**`npm run tauri dev`를 그냥 쓰지 마라.** 사용자는 설치본(`C:\Program Files\Gitpervisor`)을
평소 작업에 계속 켜 둔 채로 개발한다 — 끄고 시작하는 게 아니라 **나란히 띄우는 게 기본**이다.
single-instance 플러그인이 없어서 맨 `tauri dev`도 뜨긴 뜬다. **그게 함정이다.**

Tauri는 `app_data_dir`/`app_local_data_dir`/`app_log_dir`/WebView2 유저데이터를 **전부
`identifier` 하나에서** 파생시킨다(`tauri-2.11.2/src/path/desktop.rs:247`,
`manager/webview.rs:534`). identifier가 같으면 두 프로세스가:

- `projects.json`·`settings.json`을 양쪽이 **파일 통째로** read-modify-write 한다 →
  나중에 저장한 쪽이 상대 변경분을 말없이 덮는다. `state.rs`의 `SAVE_LOCK`은
  **프로세스 내부** 뮤텍스라 아무 것도 막지 못한다.
- `session.json`을 공유한다 → dev가 뜨는 순간 "지난번에 비정상 종료됐습니다"를 오진한다
  (설치본이 **실행 중**이라 `clean_exit`가 당연히 false다). 반대로 dev를 끄면 설치본의
  세션 기록이 날아간다.

`src-tauri/tauri.dev.conf.json`이 `identifier`만 `com.greathoon.gitpervisor.dev`로 덮는다.
그 한 줄로 위가 전부 갈라진다. `--config` 경로는 **CWD 기준**이라 레포 루트에서 도는 npm
스크립트에 그대로 먹는다. 자동 병합 대상은 `tauri.<platform>.conf.json`뿐이므로
이 파일은 `dev:app`이 명시적으로 넘길 때만 적용된다 — **`tauri build`(릴리스)는 영향 없다.**

### 새 머신에서 한 번만

dev 데이터 디렉터리는 처음엔 비어 있다. 프로젝트 목록을 옮기고 LSP 270MB 재다운로드를 피한다:

```powershell
$dev = "$env:APPDATA\com.greathoon.gitpervisor.dev"
New-Item -ItemType Directory -Force $dev, "$env:LOCALAPPDATA\com.greathoon.gitpervisor.dev" | Out-Null
Copy-Item "$env:APPDATA\com.greathoon.gitpervisor\*.json" $dev
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\com.greathoon.gitpervisor.dev\lsp" -Target "$env:LOCALAPPDATA\com.greathoon.gitpervisor\lsp"
```

복사 이후로는 두 쪽이 독립이다. Linux/macOS도 구조는 같고 경로만 다르다
(`~/.local/share/<identifier>`, `~/Library/Application Support/<identifier>`).

### 여기 손대지 마라

- **AUMID는 설치본 것(`com.greathoon.gitpervisor`)으로 하드코딩돼 있다**(`lib.rs`의 setup).
  dev identifier에 "맞춰" 고치지 마라 — 그 AUMID로 등록된 시작메뉴 바로가기가 없어서
  **Windows 토스트가 아예 안 뜬다.** 대가로 두 창이 작업표시줄 한 그룹으로 묶이지만,
  창 제목이 `Gitpervisor (dev)`(`cfg!(debug_assertions)`)로 갈라지니 그걸로 구분한다.
- **dev는 자동 업데이트 확인을 건너뛴다**(`App.tsx`, `import.meta.env.DEV`). 이 가드를 빼면
  dev 창에서 누른 "설치"가 **지금 쓰고 있는 설치본을 passive 모드로 갈아엎는다.**
- 같은 레포를 양쪽이 감시하므로 백그라운드 remote fetch는 한쪽만 켠다
  (설정 › `remote_refresh_minutes`). 2026-08 OOM 사건의 그 노브다.
- **dev가 켜져 있으면 `target/debug/conpty/x64/conpty.dll`이 잠긴다** — 그대로 재빌드하면
  tauri-build의 리소스 복사가 `os error 32`로 실패해 빌드가 통째로 막힌다. 그래서 dev는 소스 폴더
  (`src-tauri/resources/conpty/<arch>`, 빌드가 덮어쓰지 않는다)에서 먼저 로드한다
  (`lib.rs`의 `install_bundled_conpty`). 그래도 막히면 그 DLL을 `conpty.dll.locked`로 rename하고 빌드하라.

---

## 빌드

```bash
export PATH="$HOME/.cargo/bin:$PATH"    # ← 없으면 cargo를 못 찾는다
npm run tauri build -- --bundles deb    # 로컬 검증은 deb만으로 충분
```

- **`cargo`가 기본 PATH에 없다.** rustup이 `~/.cargo/bin`에 깔았는데 셸 프로필이 PATH에 안 넣는다.
  `npm run tauri build`도 내부적으로 cargo를 부르므로 그냥 실행하면 실패한다.
  도구 호출 사이에 셸 상태가 유지되지 않는 환경이라면 **매 커맨드마다** 붙여야 한다.

- **빌드가 `exit 1`로 끝나도 실패가 아닐 수 있다.** 마지막 서명 단계는 로컬에서 항상 실패한다:
  ```
  Error A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY`
  ```
  개인키는 CI 시크릿 전용이다. 이 에러 **앞에** `Finished N bundle at: .../*.deb`가 있으면
  설치파일은 완성된 것이다. **성공 판정은 종료 코드가 아니라 번들 파일 존재로 한다.**

- **AppImage는 로컬에서 자주 깨진다** (`failed to run linuxdeploy`). CI는 정상이므로
  로컬 검증에는 `--bundles deb`를 쓴다.

- **`cargo fmt`를 실행하지 마라.** 이 저장소는 rustfmt-clean이 아니라서 전체가 재포맷되고
  무관한 파일 20여 개가 diff에 섞인다(`db.rs`만 400줄+). 실제로 한 번 겪었다.
  포맷팅이 필요하면 별도 커밋으로 분리한다.

- **Linux 빌드는 `openssl-sys`를 vendored로 고정**해 뒀다(`src-tauri/Cargo.toml`).
  native-tls(tiberius/sqlx/lettre/redis)가 시스템 openssl을 요구하는데 `libssl-dev`가 없는
  빌드 호스트에서도 통과하게 하기 위함이다. Windows/macOS는 schannel/Security.framework를
  쓰므로 Linux 타깃에만 걸려 있다 — 전역으로 옮기면 그쪽 로컬 빌드가 깨진다.

### 빌드했으면 반드시 `installers/`로 복사한다

```bash
cp src-tauri/target/release/bundle/deb/Gitpervisor_<버전>_amd64.deb installers/
rm -f installers/Gitpervisor_<이전버전>*
```

사용자는 항상 `installers/`의 deb로 설치한다. 복사를 빼먹으면 **사용자가 옛 바이너리를 설치**한
채로 "왜 안 고쳐지냐"며 엉뚱한 버전을 디버깅하게 된다. 설치를 안내하기 전에 버전을 확인하라:
`dpkg-deb -f installers/*.deb Version`

---

## 검증

### 검증 강도는 변경 크기에 맞춘다 — 기본은 **빠르게**

작은 기능 하나에 워크플로·다중 에이전트 교차검증·전체 e2e를 다는 것은 **과잉이다.**
그렇게 하면 30분이면 끝날 일이 3시간이 된다(2026-09-16 사용자 지적). 등급을 이렇게 나눈다:

| 변경 | 검증 | 하지 마라 |
|---|---|---|
| **작은 것** — 파일 1~2개, 기존 패턴 그대로, 되돌리기 쉬움(UI 문구·스타일·옵션·한 줄 가드) | `tsc --noEmit`(+ Rust면 `cargo check`) · 앱에서 그 동작만 눈으로/CDP로 한 번 | 워크플로, 조사→반증 에이전트, 전체 e2e, 변이 검증 |
| **보통** — 한 기능, 파일 3~5개, 기존 계약 안 | 위 + **관련 스위트 1~2개**(`GPV_E2E_ONLY=<n>`) | 전체 e2e |
| **큰 것** — 공유 경로(`ipc.ts`·스토어·러너·워처·IPC 커맨드), 새 서브시스템, 릴리스 | 전체 e2e · 필요하면 워크플로·반증 | — |

- **전체 e2e는 `node tests/e2e/shard.mjs`(기본 앱 3개 병렬)로 약 4.5분이다**(순차 `run.mjs` 는 13~15분).
  드라이버가 `.dev` identifier 로 직접 빌드하고 프로젝트·설정·WebView2 폴더·픽스처를 샤드마다 가른다 —
  dev 앱이 안 떠 있어도 되고 **설치본 폴더는 못 건드린다**(앱이 exit 3). 로그·session.json·캐시는 dev 앱과
  공유한다. 드라이버는 대개 **설치본 터미널 안**에서 돌므로 설치본 응답을 감시하다 무응답이면 스스로 멈춘다
  (2026-09-17 설치본 멈춤 사고). 그래도 릴리스 전, 또는 공유 경로를 건드렸을 때만 돌린다. 그 외에는 `GPV_E2E_ONLY` 로
  좁힌다(스위트 하나는 대개 10~100초 — `GPV_E2E_ONLY=25 node tests/e2e/shard.mjs 1` 이면 깨끗한 새 앱에서).
  **샤딩에서만 깨지는 실패**는 대개 "앞 스위트가 해 둔 것(뷰어 마운트·커밋·클립보드)에 기댐"이다 —
  배치 규칙과 사례는 `tests/e2e/shard.mjs` 머리 주석.
- **다중 에이전트 조사·반증 워크플로**는 (a) 원인이 정말 안 잡히거나 (b) 되돌리기 어려운 것
  (데이터 유실·보안·공개 릴리스)일 때만. "이 코드가 왜 이러지"를 5분 안에 읽어서 알 수 있으면 그냥 읽어라.
- **변이 검증**(수정을 되돌려 단언이 빨개지는지)은 **조용히 실패하던 결함**을 고칠 때만. 눈에
  보이는 UI 변경에는 필요 없다.
- 착수 30분이 넘어가면 멈추고 사용자에게 중간 보고한다 — 범위를 줄일지 물어라. 말없이 계속 파는 게 가장 비싸다.
- 사용자가 "빨리"·"간단히"라고 하면 위 등급을 **한 칸 더 내린다.** 반대로 "꼼꼼히"·"전부 확인"이면 올린다.

**그래도 아래 셋은 크기와 무관하게 지킨다**(여기서 아낀 시간이 제일 비싸게 돌아온 자리다):
파일을 쓰거나 지우는 경로 · 보안 경계(경로·스킴·셸 인자) · 릴리스 산출물.

### 통과 판정은 실제 동작으로

**정적 검증만으로 통과시키지 마라.** 이 저장소에서 실제로 배포까지 나갈 뻔했던 결함들이
전부 "컴파일 통과·테스트 통과·CI success" 상태였다. 위 표는 **얼마나 넓게** 볼지를 정하는 것이지,
"안 보고 넘긴다"는 뜻이 아니다 — 좁게 보더라도 **그 동작이 실제로 되는지는 본다.**

- 실행 중인 앱의 프로세스를 볼 때는 **cgroup 기준**으로 센다:
  ```bash
  PID=$(pgrep -x gitpervisor | head -1)
  CG=$(awk -F: '$1=="0"{print $3}' /proc/$PID/cgroup)
  wc -l < "/sys/fs/cgroup${CG}/cgroup.procs"
  ```
  - **`pids.current`를 쓰면 안 된다** — 그건 스레드를 센다(실측: 193 vs 13).
  - **셸에서 앱을 띄우면 안 된다.** 앱이 그 셸의 cgroup을 상속해 측정이 오염된다.
    반드시 GNOME 메뉴/독에서 띄워 `app-gnome-Gitpervisor-<PID>.scope`를 갖게 한다.

- **`/proc/<pid>/stat`은 공백으로 쪼개면 안 된다.** comm에 공백·괄호가 들어간다
  (`notify-rs inoti`). 반드시 **마지막 `)` 뒤부터** 파싱하라. 그 뒤 필드는
  `[0]=state [1]=ppid [2]=pgrp [3]=session`. 코드(`commands/terminal.rs`)는 이미 그렇게 하는데
  검증 스크립트에서 같은 함정에 빠지기 쉽다.

- **`pgrep -f`/`pkill -f`는 자기 자신을 매칭한다.** `pkill -f "sleep 30"`이 그 문자열을 담은
  스크립트 셸까지 죽인다. 대기 루프는 `ps -eo comm | grep -qE '^(cargo|rustc)$'` 처럼
  자기 명령줄과 겹치지 않는 조건을 쓰고, 대상 프로세스는 PID 파일로 정확히 식별하라.

- 로그 타임스탬프는 **UTC**, `session.json`은 **로컬(KST)**이다. 9시간 차를 잊고 비교하면
  "이 시각에 죽었다" 같은 결론이 통째로 어긋난다.

---

## 배포

**`/gitpervisor-deploy` 스킬을 쓴다** (`.claude/skills/gitpervisor-deploy/SKILL.md`).
절차·함정이 거기 정리돼 있다. 핵심만:

- 버전은 **5곳**을 함께 올린다: `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.lock`. 뒤의 둘은 파생 파일이라 도구로 맞춘다
  (`npm install --package-lock-only`, `cargo update -p gitpervisor --precise <버전>`).
  **`package-lock.json`이 오래 빠져 있었다** — v0.5.1 시점에 0.5.0에 멈춰 있었고,
  `npm ci`는 lock의 버전을 그대로 쓰므로 CI 산출물 메타데이터가 조용히 어긋난다.
- 릴리스는 **태그 푸시 → CI** 경로여야 한다. 서명(`.sig`)과 `latest.json`은 CI에서만 생성된다.
  로컬 deb를 릴리스에 수동 업로드하면 자동 업데이트가 깨진다.
- 사이트(gitpervisor.aickyway.com)는 코드 수정이 필요 없다 — 최신 릴리스를 런타임에 읽는다.
  다만 ISR 1시간 캐시가 있어 즉시 반영하려면 빈 커밋을 푸시해 재배포를 트리거한다.
- **릴리스 검증은 에셋 개수가 아니라 `latest.json`의 플랫폼 키로 한다.**
  ```bash
  curl -sL ".../releases/download/v<버전>/latest.json" \
    | python3 -c "import json,sys; print(sorted(json.load(sys.stdin)['platforms']))"
  ```
  darwin/linux/windows가 다 있어야 한다. v0.3.2~v0.3.4는 에셋도 다 생기고 CI도 success였지만
  **macOS만 자동 업데이트가 죽어 있었다** — macOS 매트릭스에 `app` 번들이 빠져 있었기 때문이다
  (업데이터는 `.dmg`가 아니라 `.app.tar.gz`를 쓴다). 겉으로는 아무 문제가 없어 보이는 유형이다.
- **Windows Authenticode 서명은 CI가 번들링 중에 한다** (Azure 서명 시크릿 6개 존재 시 —
  `DOCS/windows-code-signing.md`). 무서명 setup.exe는 AhnLab V3 '앱 격리 검사'·SmartScreen에
  걸려 설치가 막힌다(v0.3.5 실사례). **릴리스 에셋을 사후 서명하지 마라** — 파일이 바뀌어
  업데이터 `.sig` 검증이 통째로 깨진다. 이것도 겉으로는 멀쩡해 보이는 유형이다.

---

## 이 앱 특유의 함정

- **"dev는 되는데 설치본만 이상하다" = 거의 항상 런치 환경변수 차이다.**
  GNOME 메뉴/systemd로 띄우면 터미널에서 띄울 때 있던 환경변수가 없다.
  - `TERM` 없음 → PTY 셸의 terminfo 조회 실패 → zsh 자동완성·하이라이트가 입력줄을 깨뜨린다.
    그래서 `term_open`이 `TERM`/`COLORTERM`을 **명시 설정**한다(지우지 마라).
  - `GTK_IM_MODULE` 없음 → 한글 입력 깨짐. `lib.rs`의 `run()` 초입에서 보정한다.
  - 비교 방법: `systemctl --user show-environment` vs 터미널 `env`,
    PTY 셸이 실제 받은 값은 `/proc/<zsh>/environ`.

- **자식 프로세스는 앱의 cgroup을 상속한다.** 2026-08-01에 이것 때문에 프로세스가 387개까지
  쌓여 systemd-oomd가 앱을 통째로 SIGKILL 했다. 새로 외부 프로그램을 띄우는 코드를 쓸 때는
  기존 `spawn_launcher()`(`commands/open.rs`)를 써라 — `systemd-run --user --scope` 위임과
  좀비 회수가 들어 있다. **`--scope`를 `--service-type=exec`로 바꾸지 마라**: service 유닛은
  런처가 종료하는 순간 cgroup을 통째로 SIGTERM 해 방금 띄운 브라우저를 죽이면서
  exit 0을 돌려준다(무성 실패). 회귀 방지 단언이 테스트에 있다.

- **같은 `Channel` 객체를 두 번 `invoke`에 넘기지 마라 — 출력이 조용히 영구 정지한다.**
  Tauri v2의 Channel은 순서 보장을 위해 양쪽에 인덱스 카운터를 둔다. JS는 `nextMessageIndex`가
  아닌 메시지를 `pendingMessages`에 쌓아 두고(`@tauri-apps/api/core.js`), Rust는 `__CHANNEL__:<id>`
  를 역직렬화할 때마다 **카운터 0짜리 새 Channel**을 만든다. 이미 N개를 받은 채널을 다시 넘기면
  이후 메시지 인덱스가 0부터라 전부 대기열로 들어가 **한 줄도 그려지지 않는다.** 예외도 로그도
  없다. 2026-08-28에 `reattachAllTerminals`가 정확히 이 실수를 하고 있었다 — 모아보기 별도 창을
  닫으면 메인 터미널이 멈춘 화면이 됐다. 재연결은 반드시 `attachOutputChannel()`로 새 채널을 만든다.

- **다른 창이 터미널을 가져갔다 돌려주면 크기도 되돌려야 한다.** 저쪽 창이 자기 셀 크기로
  `term_resize`를 보냈는데, 이쪽 xterm은 내내 큰 상태라 `fit()`이 아무것도 안 바꿔 `onResize`가
  발화하지 않는다 → PTY만 작게 남아 TUI가 화면 왼쪽 일부에만 그려진다. `reattachAllTerminals`가
  값이 같아도 `resyncTerminalSizeImpl`로 강제로 다시 보낸다. 회귀 체크는 e2e 14 `#2b`
  (셸에게 `$Host.UI.RawUI.WindowSize.Width`를 직접 물어 진짜 ConPTY 폭을 확인한다).

- **PTY를 종료할 때는 셸 PID 하나만 죽이면 안 된다.** 셸의 job들은 다른 프로세스 그룹에 있고,
  `setsid`로 갈라진 자손은 killpg로도 안 닿는다. `terminate_tree()`가 세션 스캔 + ppid 폐포로
  전부 거둔다. 같은 위 사건의 주범이었다.

- **좀비는 `cgroup.procs`에 나타나지 않는다**(커널 6.8 실측). oomd가 세는 개수도 그 기준이므로,
  "프로세스가 몇 개 쌓였나"를 볼 때 좀비는 별도로 `/proc` 스캔해야 한다.

- 배경 원인·수정 내역 전체는 `DOCS/process-leak-postmortem.md`,
  조기경보 설계는 `DOCS/health-watchdog-design.md`에 있다.

---

## 문서 위치

| 무엇 | 어디 |
|---|---|
| 배포 절차·함정 | `.claude/skills/gitpervisor-deploy/SKILL.md` |
| Windows 코드서명(유료·구현완료) | `DOCS/windows-code-signing.md` |
| Windows 코드서명(무료·미구현 설계) | `DOCS/signpath-free-signing-design.md` |
| OOM 사건 원인·수정 로드맵 | `DOCS/process-leak-postmortem.md` |
| 조기경보(health) 설계 | `DOCS/health-watchdog-design.md` |
| 알려진 증상별 해결 | `DOCS/TROUBLESHOOTING.md` |
| 기능별 설계 | `DOCS/*-design.md` |
