# Gitpervisor — 작업 지침

멀티 레포 Git 대시보드. Tauri v2 (Rust) + React/TypeScript, Windows·macOS·Linux(x86_64/ARM64).

이 문서는 **모르면 시간을 버리거나 사고가 나는 것**만 담는다. 코드 구조는 코드가, 설계 배경은
`DOCS/*.md`가, 배포 절차는 `.claude/skills/gitpervisor-deploy/`가 설명한다.

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

**정적 검증만으로 통과시키지 마라.** 이 저장소에서 실제로 배포까지 나갈 뻔했던 결함들이
전부 "컴파일 통과·테스트 통과·CI success" 상태였다.

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

- 버전은 **4곳**을 함께 올린다: `package.json`, `src-tauri/Cargo.toml`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.lock`.
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
