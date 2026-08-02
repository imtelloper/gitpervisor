<!-- 2026-08-01 systemd-oomd 강제 종료 사건 조사 결과.
     14개 에이전트 병렬 정독 + 적대적 검증 (37건 발견 / 35건 검증 통과). -->

# Gitpervisor 프로세스 폭주 사건 — 근본원인 확정 및 수정 로드맵

## 0. 조사 중 확정된 사실 정정 (기존 브리핑 수치가 틀렸다)

먼저 산술의 기준선부터 바로잡는다. 이 정정이 이후 모든 귀속 판단을 바꾼다.

```
$ journalctl --user -b -o json | (cgroup에 'Gitpervisor-3074382' 포함된 항목의 첫/끝)
entries 14010  first 2026-07-26 16:44:46  last 2026-08-01 15:37:24  span_days 5.95
$ journalctl --user -b | grep Gitpervisor
8월 01 15:40:15 app-gnome-Gitpervisor-3074382.scope: systemd-oomd killed 387 process(es) in this unit.
8월 01 15:40:15 app-gnome-Gitpervisor-3074382.scope: Consumed 3d 23h 42min 42.082s CPU time.
```

| 항목 | 브리핑 값 | **실측 값** |
|---|---|---|
| scope 수명 | ~10일 | **5.95일 (142.9시간)** — 07-26 16:44:46 → 08-01 15:40:15 |
| 누적 CPU | 4일치 | 95.71 CPU-시간 (동일) |
| 지속 점유율 | 1코어 40% | **1코어 67%** (95.71 / 142.9) |

앱 로그의 `[2026-07-26][07:44:46] Gitpervisor 시작 v0.3.2` 는 플러그인이 UTC로 찍은 것이고 KST 16:44:46 = scope 첫 항목과 정확히 일치한다. 즉 **단일 앱 세션 5.95일 만에 387개 + 95.7 CPU시간**이다. 10일이 아니라 6일이므로 "하루 39회 클릭" 류의 산술은 전부 1.7배 더 빡빡해진다.

그리고 이미 실측으로 확인된 대로 **좀비는 `cgroup.procs`에 없다**(커널 6.8에서 재현, systemd 249의 `cg_kill_recursive`는 `cgroup.procs`를 순회해 센다). 따라서:

> **387개는 전부 살아있는 프로세스다. 모든 [*/zombie] 발견은 387에 0 기여, CPU에도 0 기여다.**

이 한 줄로 `browser.rs:168`, `open.rs:78`, `diagnostics.rs:166`, `lsp.rs:204`, `lib.rs:257` 의 좀비 발견들이 **전부 주범 후보에서 탈락**한다. 실재하는 결함이지만 이 사건의 원인은 아니다.

---

## 1. 주범 확정

### 1.1 결정적 증거 — 앱 cgroup 안에서 실제로 무엇이 돌았는가

`_SYSTEMD_CGROUP` 에 앱 scope가 찍힌 저널 항목을 전수 조사했다.

```
$ (journalctl --user -b, cgroup에 Gitpervisor 포함, _COMM별 집계)
13938  gitpervisor
   54  sudo
   18  crontab

$ 해당 항목의 cgroup 전수:
72  /user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-Gitpervisor-3074382.scope

$ sudo 메시지의 TTY / COMMAND:
6  ('?', '/usr/bin/true')
2  ('?', '/usr/sbin/ufw status')
2  ('?', '/usr/bin/crontab -l')
1  ('?', '/usr/bin/certbot certificates')
1  ('?', '/usr/sbin/iptables -L -n')
1  ('?', '/usr/bin/cat /etc/nginx/sites-enabled/dev.front.conf')
1  ('?', '/usr/bin/cat /etc/cloudflared/config.yml')
1  ('?', '/usr/bin/ls /etc/letsencrypt/live')

$ sudo 의 PWD 분포:
11  /home/generator/convizard      ← 등록 레포
 3  /home/generator/devway         ← 등록 레포
 1  /home/generator/convizard/BACKEND
 1  /home/generator/aickyway       ← 등록 레포
```

읽어야 할 것:

1. **앱 cgroup 안에 대화형 셸 워크로드가 실재했다.** `sudo`·`crontab`은 xdg-open이나 크롬이 절대 실행하지 않는다. 셸에서만 나온다.
2. **`TTY=?`** — 제어 터미널이 없는 컨텍스트에서 sudo가 불렸다. 사람이 프롬프트에 타이핑한 게 아니라 **셸이 띄운 비대화형 자식(= AI CLI 에이전트의 서브프로세스)**이 실행했다. `pam_unix(sudo:auth): conversation failed` 도 같은 얘기다.
3. **명령 성격이 devops 조사다** — `ufw status`, `iptables -L`, `certbot certificates`, `cat /etc/nginx/...`, `cat /etc/cloudflared/config.yml`, `crontab -l` / `crontab REPLACE`. 에이전트가 서버를 점검·수정하고 있었다.
4. **PWD가 전부 등록된 모니터링 레포 경로다.**
5. 기간이 07-26 ~ 08-01, 즉 **scope 수명 전체에 걸쳐** 분포한다.

### 1.2 그 셸은 어디서 왔는가 — 후보 2개 중 1개를 실측으로 제거

브리핑이 지목한 `open.rs:237` (외부 터미널 실행) 경로를 검증했다.

```
$ readlink -f /usr/bin/x-terminal-emulator  →  /usr/bin/terminator
$ ps -o lstart= -p 1046585  →  Fri Jul 24 01:17:17 2026
$ cat /proc/1046585/cgroup
0::/user.slice/.../app.slice/app-gnome-terminator-1046585.scope
```

**terminator 마스터는 앱 scope가 태어나기 이틀 전(07-24 01:17)부터 이미 떠 있었고, 자기 전용 scope에 있다.** `/usr/bin/terminator:98-117`의 DBus 분기상, 마스터가 이미 있으면 앱이 spawn한 terminator는 DBus로 요청만 던지고 `sys.exit()` 한다 — 좀비 1개만 남기고 새 창은 **앱 밖의 마스터가** fork한다.

> **판정: `open.rs:237` `open_terminal()`은 이번 사건에서 발동하지 않았다.** 마스터가 없을 때 앱이 데스크톱 터미널의 주인이 되는 구조적 지뢰인 것은 맞지만(P1로 반드시 고쳐야 한다), 387의 원인이 아니다. 브리핑의 `[critical/orphan] open.rs:237` 판정을 **하향 정정한다.**

같은 논리로 `browser.rs:167`(크롬)도 탈락한다. 저널상 크롬은 항상 `app-com.google.Chrome-*.scope` 에서만 시작됐고 앱 scope 안에서 시작된 기록이 없다 — 브리핑의 "정직한 반증"이 맞았다.

남는 경로는 하나뿐이다: **앱 내장 PTY 터미널 (`commands/terminal.rs`)**. portable_pty의 `forkpty` 는 앱 프로세스의 직계 자식으로 셸을 만들고, systemd scope 위임을 전혀 하지 않는다. 그 셸과 셸이 낳은 모든 것이 `app-gnome-Gitpervisor-3074382.scope` 에 그대로 산다.

이 비대칭을 현재 머신에서 직접 볼 수 있다:

```
$ app.slice 하위 scope별 살아있는 프로세스 수
66  app-gnome-process-manager-1516857.scope
17  vte-spawn-be291abf-....scope        ← terminator의 셸 1개가 만든 전용 scope
14  app-orca-844311.scope
```

**VTE(GNOME 터미널 계열)는 셸마다 `vte-spawn-*.scope` 를 systemd에 만들어 준다.** 그래서 terminator에서 `claude`를 돌려도 그 부담은 terminator에게 가지 않는다. Gitpervisor의 내장 터미널만 그 위임이 없다. **동일한 워크로드가 terminator에서는 무해하고 Gitpervisor에서는 치명적인 이유가 정확히 이것이다.**

### 1.3 주범 #1 — 내장 PTY 세션 트리가 앱 cgroup 안에서 고아로 영구 잔류

**위치:** `src-tauri/src/commands/terminal.rs:243` (close_session), `:252` (kill_all), `:158` (term_open 교체)

```rust
pub fn close_session(state: &AppState, term_id: &str) {
    if let Some(session) = state.terminals.lock().unwrap().remove(term_id) {
        session.closed.store(true, Ordering::Relaxed);
        let _ = session.child.lock().unwrap().kill();   // ← 셸 PID 하나뿐
    }
}
```

`portable-pty-0.8.1/src/lib.rs:329-362` 의 `ChildKiller`는 `libc::kill(self.id(), SIGHUP)` (음수 pid 아님, killpg 아님) → 50ms×4 대기 → `std::process::Child::kill()` (단일 PID SIGKILL) 이다. 그리고 `unix.rs:220`이 `setsid()` 를 하므로 셸의 각 job은 **다른 프로세스 그룹**에 있다. 즉 200ms 안에 zsh가 안 죽으면 SIGKILL로 즉사하고, **job 트리 전체가 통째로 고아**가 된다. reparent는 PID 1로 되지만 **cgroup 소속은 그대로다.**

저장소 전체 검증: `grep -rn "killpg|process_group|setsid|pre_exec|libc::kill" src-tauri/src` → **0건**. 그룹 단위로 죽이는 코드가 앱 어디에도 없다.

여기에 `terminal.rs:119-138` 리더 루프가 순환을 완성한다. 살아남은 자손이 슬레이브 fd(`unix.rs:200-202`에서 stdin/out/err로 상속)를 쥐고 있으면 마스터 read가 EIO를 못 받아 `Ok(0)` 이 안 오고, 루프가 안 끊기고, 유일한 reap 지점인 `child.lock().unwrap().wait()` (`:133`)에 도달하지 않는다. 동시에 그 스레드가 쥔 마스터 fd dup(`unix.rs:315`) 때문에 **커널의 "마지막 마스터 fd가 닫히면 전경 그룹에 SIGHUP" 안전망마저 발동하지 않는다.** 고아가 리더를 붙잡고 리더가 고아를 살려준다.

**기여 프로세스 수 추정: 250~330 / 387**

산술 근거 — 이 사용자의 실제 워크로드를 현재 머신에서 측정했다:

```
terminator 1046585 (셸 3개): descendants=15
  zsh×3, node×3, sh×2, claude×1, npm exec chrome-devtools-mcp×1,
  npm exec @playwright×1, python3×1
chrome 프로세스 총계: 27
node 프로세스 총계: 15
```

- 셸 1개당 순수 dev 잔존: 4~5개 (node + 워커)
- **브라우저 자동화 세션 1개당: 15~40개** (`chrome-devtools-mcp` / `playwright` 가 크롬을 띄우면 browser 1 + zygote 2 + gpu 1 + crashpad 2 + utility 3~4 + 렌더러 N)
- 5.95일 × 패널 닫기·재시작 5회/일 ≈ **30회 이벤트 × 평균 8개 = 240개**
- 사망 시점에 열려 있던 패널들의 살아있는 트리 (12레포를 오가며 2/4/8 분할 사용): **40~80개**
- 합계 **280~320개**

**CPU 95.7시간을 설명하는 유일한 후보이기도 하다.** 좀비는 CPU 0, git-remote-https 고아는 네트워크 read 블록으로 CPU ~0, 워처는 버스티다. 6일 내내 0.67코어를 태우려면 **계속 도는 계산 주체**가 있어야 한다 — 고아가 된 `next dev` / `vite` / `tsc --watch` / chokidar / headless Chrome / AI 에이전트가 정확히 그것이다. 상시 워처 2~3개 + 간헐적 에이전트 활동이면 0.67코어가 자연스럽게 나온다.

부수 증폭기(같은 파일):
- `terminal.rs:128` — 종료된 세션의 sink가 해제되지 않아 고아의 출력을 죽은 Channel로 계속 IPC 전송. 고아 CPU + 앱 CPU 이중 계상.
- `terminal.rs:130` — EINTR을 `Err(_) => break` 로 삼킨 뒤 살아있는 셸에 블로킹 `wait()`. `child` 뮤텍스 영구 점유 → `close_session`이 `state.terminals` **전역 락을 쥔 채**(`:240`, edition 2021에서 `if let` scrutinee guard가 본문 끝까지 생존) 영구 블록 → **메인 GTK 스레드 전체 프리즈**. 앱 로그가 마지막 기록 후 32분간 무기록이었던 정황과 부합한다.
- `terminal.rs:140` — 셸이 스스로 종료해도 맵 엔트리가 제거되지 않아 fd 2개 + 엔트리가 영구 누적. `lsp.rs`에는 60초 리퍼가 있는데 터미널에는 대응물이 없다.
- `lib.rs:425` — 플로팅 창에서 분할한 PTY는 라벨에서 유추한 시드 1개만 정리. 나머지는 `beforeunload`의 베스트에포트 IPC에 의존 → 실패 시 **어떤 UI에서도 참조 불가능한 미아**.

### 1.4 주범 #2 — 재귀 inotify가 오md에게 이 cgroup을 고르게 만들었다

**위치:** `src-tauri/src/watcher.rs:65`

```rust
if let Err(e) = debouncer.watch(path, RecursiveMode::Recursive) {
```

`IGNORED_DIRS`(`:86-105`)와 `is_relevant`(`:109-137`)는 **디바운서 콜백 안**(`:41-44`)에서 도는 사후 필터다. watch는 전부 걸린다.

전체 12개 레포를 오늘 실측했다:

```
aickyway       dirs= 126982  keep=  1566
gitpervisor    dirs=   9223  keep=    57
plateway       dirs=   9582  keep=  4114
devway         dirs=   7877  keep=   631
convizard      dirs=   6283  keep=   304
devlog         dirs=   5984  keep=   548
erdway         dirs=   5209  keep=   132
promptway      dirs=   5622  keep=   446
starot         dirs=   4230  keep=   805
freeway        dirs=   2921  keep=   251
nginx-manager  dirs=     44  keep=     5
whisko         dirs=     44  keep=    38
------------------------------------------------
TOTAL          dirs= 184001  keep=  8897   pruned=175104 (95.2%)
```

**184,001개 inotify watch. 필요한 것은 8,897개. 175,104개(95.2%)가 순수 낭비다.** aickyway 하나가 126,982개를 먹는다.

inotify watch 1개는 `inotify_inode_mark` + 고정되는 inode/dentry로 약 1KB → **약 180MB의 커널 메모리**. cgroup v2에서 커널 메모리는 `memory.current` 에 산입되므로 **systemd-oomd의 압박 판정에 그대로 들어간다.** 게다가 `fs.inotify.max_user_watches=524288` 이고 저널에 `[watcher] watch 실패` 가 **0건**이므로 — 정말로 18만 개를 다 들고 있었다.

**387 기여: 0개.** 하지만 **oomd가 다른 cgroup이 아니라 이 cgroup을 죽이기로 결정한 이유**의 최대 단일 기여자다. 고아 프로세스들의 RSS 위에 얹힌 180MB 순수 낭비. CPU에도 기여한다 — cargo build / npm install 이 `target/`·`node_modules/` 를 갈아엎을 때마다 초당 수천 이벤트가 PathBuf로 할당돼 400ms 큐에 들어갔다가 `is_relevant`에서 버려진다. 12개 워처가 동시에.

### 1.5 주범 #3 — 되살아난 배경 fetch × 고아 HTTPS 헬퍼

**위치:** `src-tauri/src/state.rs:131` + `src-tauri/src/git/runner.rs:139/196/261`

디스크 실물 확인:

```json
$ cat ~/.local/share/com.greathoon.gitpervisor/settings.json
{"settings":{"gitPath":null,"autoFetchMinutes":0,"diffFontSize":13,
 "confirmDiscard":true,"theme":"monokai","terminalShell":null,"terminalFontSize":13}}
```

`autoFetchMinutes: 0` — **사용자가 자동 fetch를 명시적으로 껐다.** `remoteRefreshMinutes` 키는 없다.

```rust
// state.rs:131-135
if value.get("remoteRefreshMinutes").is_none() {
    if let Some(old) = value.get("autoFetchMinutes").and_then(|v| v.as_u64()) {
        if old > 0 {                                   // ← 0(끔)이 여기서 탈락
            settings.remote_refresh_minutes = old as u32;
        }
    }
}
```

`Settings`는 `#[serde(rename_all = "camelCase", default)]`(`git/types.rs:194`)이라 없는 필드는 `default()`로 채워지고 `remote_refresh_minutes: 5`(`types.rs:244`)가 된다. `if old > 0` 이 0을 떨어뜨리므로 **"끔"이 "5분마다"로 뒤집힌다.** 저장도 안 하므로(`save_settings` 호출 없음) **매 부팅마다 재적용**된다. `fetch_scheduler.rs:84`의 `if minutes == 0 { continue; }` 가드는 영원히 발동하지 않는다.

볼륨: 5.95일 × 288 사이클/일 × 12레포 = **20,570회 fetch**. 12개 레포 원격이 전부 https이므로 매번 3단 헬퍼 체인:

```
git fetch --quiet origin                              ← 직계 (SIGKILL 대상)
  /usr/lib/git-core/git remote-https origin <url>     ← 손자 (생존)
    /usr/lib/git-core/git-remote-https origin <url>   ← 증손자 (생존)
```

`runner.rs:153-154`의 주석은 "타임아웃 시 future drop → kill_on_drop이 프로세스를 정리한다"고 단정하지만, tokio의 `Kill for Child`(`tokio-1.52.3/src/process/unix/mod.rs:169`)는 `std::process::Child::kill()` = **단일 PID SIGKILL**이다. 손자·증손자는 살아남아 cgroup에 남는다 (조사 중 non-routable 주소로 재현 확인).

**기여 프로세스 수 추정: 50~150 / 387.** 20,570회 중 타임아웃률 0.5%면 103회 × 2 = 206개, 0.2%면 82개. 정직하게 말하면 **타임아웃률은 관측되지 않았다**(로그가 없다). 절전/복귀·Wi-Fi 전환 1회당 12레포 동시 스톨 = 최대 24개이므로, 6일간 서스펜드 몇 회만으로도 100개대는 쉽게 나온다. **CPU 기여는 ~0** (헬퍼는 네트워크 read에 블록).

### 1.6 최종 귀속 표

| 원인 | 프로세스 기여 | CPU 기여 | 확신도 |
|---|---|---|---|
| **#1 PTY 세션 트리 고아** (`terminal.rs:243/252/158`) | **250~330** | **거의 전부 (95.7h 중 대부분)** | 높음 — 저널 직접 증거 |
| **#2 재귀 inotify** (`watcher.rs:65`) | 0 | 일부 (빌드 중 버스트) | **확정 — 184,001 실측** |
| **#3 배경 fetch 고아 헬퍼** (`state.rs:131` + `runner.rs:139/196/261`) | 50~150 | ~0 | 중간 — 메커니즘 확정, 발생률 미관측 |
| LSP 손자 (`lsp.rs:99`) | 10~30 | 낮음 | 중간 |
| 좀비 전부 (browser/open/diagnostics/lsp/terminal) | **0** | **0** | 확정 — cgroup.procs 미포함 실증 |
| `open.rs:237` 외부 터미널 | **0 (미발동)** | 0 | 확정 — terminator가 07-24부터 자기 scope 보유 |
| `browser.rs:167` 크롬 | **0 (미발동)** | 0 | 확정 — 크롬은 항상 자기 scope에서 시작 |

합계 310~510의 중앙값이 387 근처. **#1이 과반, #2가 oomd의 방아쇠, #3이 나머지 패딩.**

---

## 2. 왜 예고 없이 당했는가

### 2.1 로그가 진단이 아니라 노이즈였다

```rust
// lib.rs:212-218
tauri_plugin_log::Builder::new()
    .level(log::LevelFilter::Info)      // 전역 최대치만. level_for 없음
    .max_file_size(10_000_000)
    .rotation_strategy(RotationStrategy::KeepSome(8))
```

`.level_for(target, level)` 이 없어 zbus/tracing의 SASL 핸드셰이크가 알림 1건당 6줄씩 그대로 들어온다. 5주 160줄 중 **84줄(52.5%)이 zbus 노이즈, 앱 자신의 로그는 9줄** — 전부 `"Gitpervisor 시작 v0.x"` 뿐이다.

반대로 앱은 `log::info!` 를 `lib.rs:236` 한 곳에서만 부른다. **자식 프로세스 spawn/종료, 창 생성/파괴, 정리 훅 실행 결과, 프로세스 수, RSS — 무엇도 기록하지 않는다.** 그래서 387개가 쌓이는 6일 동안 로그에는 그 과정을 가리키는 신호가 한 줄도 없었다. 사망 직전 32분 무기록은 버그가 아니라 이 설정의 정상 동작이다.

진단에 쓸 수 있었던 유일한 신호는 "panic.log가 없다 = 패닉 아님" 이었다. 그게 전부였다.

### 2.2 리소스 모니터가 자기 자신을 볼 줄 몰랐다

`monitor.rs:230` 은 `ProcessesToUpdate::All` 로 **시스템 전체**를 훑는다. 그런데 단 한 번도 **"이 중 몇 개가 내 것인가"** 를 묻지 않는다.

앱은 그걸 알 수 있었다. `/proc/self/cgroup` → `/sys/fs/cgroup/<path>/cgroup.procs` 의 줄 수를 세면 자기 systemd scope의 실제 프로세스 수가 나온다. 한 줄이면 된다. 그 한 줄이 없어서, 사용자는 앱이 만든 387개를 **시스템 전체 목록 속에 섞인 남의 프로세스로** 보고 있었다.

더 나쁜 것은 **관측 도구가 관측 대상의 비용을 증폭했다**는 점이다:

- `sys_process_snapshot`(`monitor.rs:493`)은 `async`가 아니다 → `tauri-macros-2.6.3/src/command/wrapper.rs:264-266` 기준 `ExecutionContext::Blocking("sync")` = **메인 GTK 이벤트 루프 스레드에서 실행**된다.
- 2초 폴링(`src/queries/index.ts:257`, `refetchIntervalInBackground: true`)마다 전 PID의 `/proc/PID/{stat,statm,io}` + `readlink exe` 를 연다.
- `monitor.rs:243-266`이 프로세스마다 String 2개를 새로 할당해 Vec을 재구성하고, `monitor.rs:370`의 `self.procs.clone()` 이 그걸 다시 딥카피한다 — 200개만 필요한데 800개를 전부 복사한다.
- `sys_metrics`(`monitor.rs:164`)는 매 호출 `Disks::new_with_refreshed_list()` 로 전 마운트 statvfs를 다시 돈다.

즉 프로세스가 늘수록 UI 스레드 비용이 선형으로 커진다. **누수를 관측하려고 켠 창이 누수의 대가를 가장 크게 치르는 구조다.** 사용자 입장에서는 "앱이 느려서 모니터를 켰더니 더 느려졌고, 왜 그런지는 아무 데도 안 적혀 있었다."

### 2.3 앱이 사용자의 명시적 설정을 조용히 뒤집었다

`state.rs:131`의 `if old > 0` 때문에 사용자가 끈 자동 fetch가 5분으로 부활했고, 저장을 안 해서 **매 부팅마다 재적용**됐다. 로그도 없다. 사용자는 자기가 끈 기능이 6일간 20,570회 돌았다는 사실을 알 방법이 없었다.

---

## 3. 수정 로드맵

### P0 — 즉시 (다음 릴리스 블로커)

#### P0-1. PTY 세션을 세션 단위로 죽이고 반드시 reap
**파일:** `src-tauri/src/commands/terminal.rs:158, 239-245, 248-254`

`TerminalSession`에 `pid: i32` 를 보관하고(spawn 직후 `child.process_id()`), 세 kill 지점을 전부 세션 단위 종료로 교체한다. portable-pty가 `setsid()` 하므로 셸의 `pid == sid == pgid` 다.

```rust
fn terminate_session(pid: i32) {
    if pid <= 0 { return; }
    // /proc 훑어 같은 세션(sid) 전원 수집 — setsid로 분리된 다른 job 그룹까지
    let victims = |sid: i32| -> Vec<i32> { /* /proc/<p>/stat 의 sid 필드 == sid */ };
    unsafe { libc::kill(-pid, libc::SIGHUP); libc::kill(-pid, libc::SIGTERM); }
    for p in victims(pid) { unsafe { libc::kill(p, libc::SIGTERM); } }
    for _ in 0..15 { sleep(20ms); if waitpid(pid, WNOHANG) == pid { break; } }
    unsafe { libc::kill(-pid, libc::SIGKILL); }
    for p in victims(pid) { unsafe { libc::kill(p, libc::SIGKILL); } }
    unsafe { libc::waitpid(pid, &mut st, 0); }   // ★ 반드시 reap
}
```

**동시에 락 순서를 고친다** — 현재 `close_session`(`:240`)은 `if let Some(session) = state.terminals.lock().unwrap().remove(...)` 라 guard가 본문 끝까지 살아 최대 200ms 블록하는 kill을 전역 락 아래에서 돌린다. `let session = ...remove(); if let Some(session) = session {` 로 분리하고, kill은 별도 스레드로 던진다. `kill_all`도 drain 후 락을 놓고 병렬로.

**리스크:** `libc` 크레이트 신규 의존(현재 0건). `/proc` 순회는 리눅스 전용 — macOS는 `killpg`만, Windows는 Job Object. sid 수집 중 PID 재사용 레이스 → 수집 직후 즉시 시그널을 보내고, `/proc/<p>/stat` 재확인으로 완화.

#### P0-2. 리더 스레드가 EOF에 목매지 않게 한다
**파일:** `src-tauri/src/commands/terminal.rs:119-143`

```rust
loop {
    if closed.load(Ordering::Relaxed) { break; }          // ★ 의도적 종료면 즉시 탈출
    let mut pfd = libc::pollfd { fd: raw, events: libc::POLLIN, revents: 0 };
    if unsafe { libc::poll(&mut pfd, 1, 200) } == 0 { continue; }
    match reader.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => { if let Some(ch) = sink.lock().unwrap().as_ref() { let _ = ch.send(...); } }
        Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,   // ★ EINTR 재시도
        Err(_) => break,
    }
}
// ★ 블로킹 wait 금지 — try_wait 폴링으로 뮤텍스 영구 점유 제거
let code = loop {
    match child.lock().unwrap().try_wait() {
        Ok(Some(s)) => break s.exit_code() as i32,
        Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        Err(_) => break -1,
    }
};
// ★ 자기 엔트리 회수 (pid 비교로 term_open 교체 레이스 방지)
if let Some(state) = app.try_state::<AppState>() {
    let mut map = state.terminals.lock().unwrap();
    if map.get(&term_id).map(|s| s.pid) == Some(my_pid) { map.remove(&term_id); }
}
```

`sink`를 `Arc<Mutex<Option<Channel<_>>>>` 로 바꿔 `close_session`에서 `None`으로 비운다. 이렇게 하면 스레드가 즉시 종료 → 마스터 dup 닫힘 → **커널 SIGHUP 안전망이 되살아나** 남은 고아 상당수가 자동 정리된다. `terminal.rs:130`(EINTR 데드락), `:128`(죽은 sink 전송), `:140`(엔트리 미제거) 세 발견이 한 번에 해결된다.

**리스크:** poll 도입으로 논블로킹 전환 필요 — 부분 read 처리 확인 필수. 200ms 폴링이 유휴 스레드당 초당 5회 wakeup을 만든다(세션 20개면 100회/초, 무시 가능하지만 계측할 것).

#### P0-3. inotify watch 프루닝 — 184,001 → 8,897
**파일:** `src-tauri/src/watcher.rs:65`

```rust
fn watch_filtered(d: &mut RepoWatcher, root: &Path) -> notify::Result<()> {
    d.watch(root, RecursiveMode::NonRecursive)?;
    let g = root.join(".git");
    if g.is_dir() {
        d.watch(&g, RecursiveMode::NonRecursive)?;              // HEAD/index/MERGE_HEAD...
        let refs = g.join("refs");
        if refs.is_dir() { d.watch(&refs, RecursiveMode::Recursive)?; }
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let n = e.file_name(); let n = n.to_string_lossy();
            if n == ".git" || IGNORED_DIRS.contains(&n.as_ref()) { continue; }  // ← watch 안 검
            let p = e.path();
            d.watch(&p, RecursiveMode::NonRecursive)?;
            stack.push(p);
        }
    }
    Ok(())
}
```

**측정된 효과: 184,001 → 8,897 (95.2% 감소), 커널 메모리 180MB → 9MB.**

**리스크(중요):** NonRecursive 개별 등록은 새로 생긴 디렉토리를 자동으로 안 잡는다. 콜백에서 `EventKind::Create` + `is_dir()` 을 받으면 `IGNORED_DIRS`가 아닐 때 증분 `d.watch(..., NonRecursive)` 해야 한다. 이걸 빠뜨리면 새 폴더 안의 변경이 UI에 안 뜨는 조용한 회귀가 된다. 등록 시 순회 비용(aickyway 12.7만 디렉토리 stat)이 시작 시 수 초 → 백그라운드 스레드에서 하되(이미 `lib.rs:283-289`가 그렇다) 진행 로그를 남길 것. 더 나은 대안은 `ignore` 크레이트 `WalkBuilder`로 .gitignore를 존중해 프루닝하는 것 — 어차피 gitignore된 파일은 `git status`에 안 잡힌다.

#### P0-4. 설정 마이그레이션 — 사용자의 "끔"을 되살리지 마라
**파일:** `src-tauri/src/state.rs:131`

```rust
if value.get("remoteRefreshMinutes").is_none() {
    if let Some(old) = value.get("autoFetchMinutes").and_then(|v| v.as_u64()) {
        settings.remote_refresh_minutes = old as u32;   // ★ 0(끔)도 그대로 승계
    }
}
// ★ 마이그레이션 직후 1회 저장 — 매 부팅 재적용 중단
let _ = save_settings(app, &settings);
```

**리스크:** 최소. `autoFetchMinutes`가 0인 다른 사용자도 자동 fetch가 꺼진다 — 그게 의도된 동작이다. 릴리스 노트에 명시할 것.

#### P0-5. git 자식을 프로세스 그룹으로 묶고 타임아웃 시 그룹 kill
**파일:** `src-tauri/src/git/runner.rs:139, 196, 261`, `src-tauri/src/tools/runner.rs:207`

```rust
#[cfg(unix)]
{ use std::os::unix::process::CommandExt; cmd.process_group(0); }   // Rust 1.64+, libc 불요
#[cfg(windows)]
cmd.creation_flags(0x0800_0000 | 0x0000_0200);   // CREATE_NO_WINDOW | NEW_PROCESS_GROUP

let mut child = cmd.spawn()?;
let pid = child.id().expect("just spawned") as i32;
match tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
    Ok(r) => r.map_err(...),
    Err(_) => {
        #[cfg(unix)] unsafe { libc::killpg(pid, libc::SIGKILL); }   // 손자·증손자까지
        let _ = child.wait().await;                                 // 직계 reap
        Err(IpcError::new(ErrorCode::Timeout, ...))
    }
}
```

**애초에 타임아웃 경로로 안 가게** `fetch_scheduler.rs:246` args에 추가:

```rust
"-c", "http.lowSpeedLimit=1000",   // 1KB/s 미만이
"-c", "http.lowSpeedTime=20",      // 20초 지속되면 git이 스스로 종료
```
`:253`의 `GIT_SSH_COMMAND`도 `-oBatchMode=yes -oConnectTimeout=10 -oServerAliveInterval=10 -oServerAliveCountMax=3` 로 강화.

**리스크:** `process_group(0)` 은 자식을 새 프로세스 그룹 리더로 만든다 — git은 이미 `GIT_TERMINAL_PROMPT=0` 이라 터미널 프롬프트에 의존하지 않으므로 안전. `killpg` 대상 pid가 재사용되지 않았는지 확인 필요(직후 호출이라 실질 위험 없음). Windows에서 `CREATE_NEW_PROCESS_GROUP` 은 Ctrl+C 전파를 바꾸므로 `GenerateConsoleCtrlEvent` 대신 `TerminateJobObject` 권장.

#### P0-6. 관측 가능성 — 이번 사건을 6일 전에 알 수 있게
**파일:** `src-tauri/src/lib.rs:212`, `lib.rs` setup

```rust
tauri_plugin_log::Builder::new()
    .level(log::LevelFilter::Info)
    .level_for("zbus", log::LevelFilter::Warn)          // 로그의 52%가 사라진다
    .level_for("tracing", log::LevelFilter::Warn)
    .level_for("hyper", log::LevelFilter::Warn)
    .level_for("reqwest", log::LevelFilter::Warn)
```

**5분 헬스 틱 추가** (이 한 항목이 이번 사건의 재발을 실제로 막는다):

```rust
// /proc/self/cgroup → /sys/fs/cgroup/<path>/cgroup.procs 줄 수 = systemd scope 실제 프로세스 수
log::info!("health: cgroup_procs={n} rss={rss}MB threads={t} \
            terminals={term} lsp={lsp} browsers={br} watches={w}");
if n > 100 { log::warn!("자식 프로세스 과다: {n}개 — 누수 의심"); }
if n > 200 { /* UI 토스트 */ }
```

**spawn/reap 의무 로깅:** 모든 자식 생성 시 `log::info!("spawn {kind} pid={pid} ctx={..}")`, 회수 시 `log::info!("reap {kind} pid={pid} status={..}")`.

**리스크:** 없음. 로그 볼륨은 5분 틱 = 하루 288줄, `max_file_size(10MB)` + `KeepSome(8)` 로 충분.

---

### P1 — 다음 사이클

| 항목 | 파일:라인 | 변경 방향 | 리스크 |
|---|---|---|---|
| 종료 경로 단일화 | `lib.rs:406-429` | `.run(ctx)` → `.build(ctx)?.run(\|app, ev\| ...)`. `fn shutdown_children(app)` 추출해 `Destroyed` / `RunEvent::Exit` / `ExitRequested` 세 곳이 공유. `static DONE: AtomicBool` 로 재진입 방지. 각 단계를 개별로 감싸 하나가 패닉해도 나머지 실행 + 정리 개수 로깅 | `.build()?` 전환은 에러 처리 경로 변경 — 기존 crash log 훅 유지 확인 |
| SIGTERM/SIGHUP 핸들러 | `lib.rs` setup | `tokio::signal` 로 SIGTERM/SIGINT/SIGHUP 수신 → `shutdown_children()` → exit. **GNOME 로그아웃 시 고아를 없앨 유일한 방법** | 전역 `signal(SIGCHLD, SIG_IGN)` 은 **절대 금지** — `git/runner.rs`·`tools/runner.rs`·lsp·PTY의 `.wait()`/`.output()` 이 ECHILD로 깨진다 |
| 업데이터 relaunch | `src/stores/updater.ts:120` | `relaunch()` 직전 `shutdown_children` 커맨드 await. `tauri-2.11.2/src/app.rs:1100-1112` 의 `cleanup_before_exit()` 는 리소스 테이블만 clear하고 Destroyed를 emit하지 않음 (확인 완료) | 없음 |
| float 창 정리 | `lib.rs:416-426` | 메인 Destroyed 시 `float-*` 전 창 close 루프 추가. `TerminalSession`에 `owner: String`(웹뷰 라벨) 보관, `term_attach`가 갱신 → float 창 Destroyed 시 owner 매칭 전원 정리 | `detach↔attach` 사이 owner 공백 구간 처리 |
| LSP kill+wait | `lsp.rs:204, 213, 233, 256` | `{ let mut c = ...; let _ = c.kill(); let _ = c.wait(); }`. `reader_loop` EOF 경로도 remove 후 wait. 근본적으로 `LspSession`에 `Drop` 구현 | SIGKILL 후 wait는 즉시 반환 — 블로킹 없음 |
| LSP 손자 정리 | `lsp.rs:99` | `cmd.process_group(0)` + 종료 시 `killpg`. LSP 스펙대로 kill 전 `shutdown`→`exit` 200~500ms 유예 | jdtls(JVM)는 graceful 종료가 느림 — 타임아웃 필요 |
| LSP 세션 상한 | `src/lib/lsp/sync.ts:65`, `lsp.rs` | `lspCloseDoc`에서 `hasOpenDocs()==0` 이면 `dispose(true)`. `client.ts:238-240`의 미사용 헬퍼가 이미 있음. 백엔드 LRU 4개 상한 | 파일 재오픈 시 콜드 스타트 비용 |
| LSP 리퍼 무력화 | `lsp.rs:175`, `client.ts:200-208` | `last_activity`를 **사용자 기점 트래픽에서만** 갱신. `frameSend`에 `if (this.disposed) return;` 가드. '열린 문서 0 + 30분' 하드 캡 | `is_user_initiated` 플래그 IPC 스키마 변경 |
| 런처 공용 헬퍼 | `open.rs:78/165/230/239`, `diagnostics.rs:166`, `browser.rs:164/167` | `spawn_launcher(cmd, what)`: `Stdio::null()×3` + `process_group(0)` + `reap_detached(child)`. 리눅스는 `systemd-run --user --quiet --collect` 우선 위임 → 핸들러가 앱 cgroup 밖에서 뜬다 | `systemd-run` 부재 환경(컨테이너·비-systemd) 폴백 필수. 위임 실패 시 직접 spawn |
| 모니터 메인스레드 이탈 | `monitor.rs:493, 486, 509` | `sys_process_snapshot`/`sys_metrics`/`kill_processes` 를 `async fn` 으로. std Mutex를 await 경계 너머로 들고 가지 않게 lock 스코프 축소. `monitor.rs:370` `procs.clone()` 제거(인덱스 정렬 후 상위 limit만 클론). `Disks` 필드 승격 + 60초마다만 `refresh_list()`. `with_disk_usage()` 는 Disk 정렬일 때만 | async 전환 시 `State<'_, AppState>` 수명 — Tauri v2에서 지원됨. Mutex → tokio::sync::Mutex 전환 검토 |

---

### P2 — 위생

| 항목 | 파일:라인 | 변경 |
|---|---|---|
| 프리뷰 스테일 엔트리 | `preview.rs:167` | mint 시 `reg.ports.retain(\|_, e\| e.alive.load(Relaxed));` |
| 프리뷰 accept 자기치유 | `preview.rs:243` | `Err(e) => { log::warn!(...); t_alive.store(false, Relaxed); return; }` — 현재는 alive=true인 채 죽어 다음 mint가 **죽은 포트를 재사용**한다 |
| tools 경로 캐시 | `tools/runner.rs:122` | `OnceLock<RwLock<HashMap>>` + `sh -c` 제거하고 PATH 직접 순회. `git/runner.rs:30`의 `GIT_PATH: OnceLock` 과 대칭으로. 편집 중 500ms 디바운스마다 `sh` 스폰이 사라진다 |
| fetch 스로틀 TOCTOU | `fetch_scheduler.rs:110` | 판정·갱신을 한 락 구간에서 원자적으로. Semaphore를 사이클마다 새로 만들지 말고 전역 `OnceLock<Semaphore>` 공유 |
| proc_icons | `proc_icons.rs:16` | 비-Windows는 커맨드 자체 early-return (Linux에서는 항상 None인데 캐시만 채운다). Windows는 2000개 LRU |
| kill_processes sleep | `monitor.rs:329` | async 전환 + `tokio::time::sleep`, 락 분리 |

---

## 4. 재발 방지 — 구조적 장치

### 4.1 중앙 ChildRegistry — 모든 spawn이 통과하는 단일 관문

```rust
pub struct ChildRegistry { inner: Mutex<HashMap<i32, ChildInfo>> }

pub struct ChildInfo {
    kind: &'static str,     // "pty" | "lsp" | "git" | "launcher" | "tool"
    pid: i32,
    pgid: i32,
    owner: Option<String>,  // 웹뷰 라벨 (float-*, main) — 창 닫힘 시 일괄 정리
    spawned_at: Instant,
}

impl ChildRegistry {
    /// 유일한 spawn 경로. process_group(0) + Stdio::null + 등록 + reap 스레드를 강제한다.
    pub fn spawn(&self, kind: &'static str, cmd: Command, owner: Option<String>) -> io::Result<i32>;
    pub fn kill_tree(&self, pid: i32);                  // killpg + /proc sid 스윕 + waitpid
    pub fn kill_by_owner(&self, label: &str);           // 창 닫힘
    pub fn kill_all(&self);                             // 앱 종료
    pub fn len(&self) -> usize;                         // 헬스 틱용
}
```

**CI로 강제해야 의미가 있다.** 규약은 지켜지지 않으면 없는 것과 같다:

```toml
# clippy.toml
disallowed-methods = [
  { path = "std::process::Command::spawn", reason = "ChildRegistry::spawn 사용" },
  { path = "tokio::process::Command::spawn", reason = "ChildRegistry::spawn 사용" },
]
```

추가로 CI 스크립트: `grep -rn "Command::new" src-tauri/src | grep -v "child_registry.rs"` 결과가 비어야 통과. 현재 이 grep은 **50건 이상** 나온다.

### 4.2 cgroup 위임 원칙 — "내 것"과 "사용자 것"을 분리

이번 사건의 근본 교훈은 **소유권과 cgroup 소속이 어긋났다**는 것이다. 규칙으로 못 박는다:

| 범주 | 예 | 정책 |
|---|---|---|
| **앱이 소유** — 앱이 생명주기를 책임짐 | PTY 셸, LSP 서버, git, ruff/biome | 앱 cgroup 안. 단 **반드시** 프로세스 그룹 리더로 만들고, 종료 시 그룹 단위 kill + reap |
| **사용자가 소유** — 앱이 생명주기를 모름 | 외부 터미널, xdg-open 핸들러, 레포 안 실행 파일 | **`systemd-run --user --quiet --collect` 로 앱 cgroup 밖으로 내보낸다.** 앱이 죽어도 살고, 그게 죽어도 앱이 안 죽는다 |

VTE가 `vte-spawn-*.scope` 로 이미 하고 있는 것(실측 17프로세스 scope 확인)을 Gitpervisor도 해야 한다. 내장 터미널의 경우 선택적으로 셸을 `systemd-run --user --scope` 로 감싸는 옵션을 두면 P0-1의 killpg가 실패해도 systemd가 scope를 통째로 회수한다 — 벨트 앤 서스펜더.

### 4.3 자기 cgroup 자가 감시 (앱이 스스로를 볼 수 있게)

```rust
fn own_scope_proc_count() -> Option<usize> {
    let cg = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = cg.lines().find_map(|l| l.strip_prefix("0::"))?;
    let procs = std::fs::read_to_string(format!("/sys/fs/cgroup{path}/cgroup.procs")).ok()?;
    Some(procs.lines().count())
}
```

임계: **100 → log::warn, 200 → UI 토스트("백그라운드 프로세스 N개 — 정리하시겠습니까?"), 400 → 강제 정리 제안.** 정상 Tauri 앱은 4~6개다. 이 함수 하나가 있었으면 387은 6일 전에 잡혔다. 리소스 모니터에 "이 앱의 프로세스" 탭을 추가하고 기본 표시로 둔다.

### 4.4 종료 경로 단일화

```
shutdown_children(app)  ←  WindowEvent::Destroyed("main")
                        ←  RunEvent::Exit / ExitRequested
                        ←  SIGTERM / SIGINT / SIGHUP
                        ←  updater relaunch 전 명시 호출
```
`static SHUTDOWN_DONE: AtomicBool` 로 멱등 보장. 각 단계 개별 catch + 정리 개수 로깅.

### 4.5 PR_SET_CHILD_SUBREAPER (신중히 검토)

`prctl(PR_SET_CHILD_SUBREAPER, 1)` 을 걸면 고아가 PID 1이 아니라 **앱으로 재부모화**된다 → 앱이 고아를 볼 수 있고 종료 시 일괄 정리할 수 있다. 단 그러면 앱이 모든 손자의 종료를 reap해야 하므로 `waitpid(-1)` 루프가 필요하고, 이는 `tokio::process`·`std::process`의 개별 `wait()`와 경합한다. **P2 이후 별도 설계로.** 성급히 넣으면 git/LSP의 `.output()` 이 깨진다.

---

## 5. 회귀 테스트 — "정말 안 샌다"를 어떻게 증명하는가

### 5.1 1차 지표: cgroup.procs 계수 (가장 직접적)

oomd가 센 것과 **정확히 같은 것**을 센다. 이게 유일한 진짜 판정 기준이다.

```bash
SCOPE=$(sed -n 's/^0:://p' /proc/$APP_PID/cgroup)
PROCS=/sys/fs/cgroup$SCOPE/cgroup.procs
N0=$(wc -l < $PROCS)
# 시나리오: 터미널 패널 열기 → `npx vite dev` 실행 → 30초 대기 → 패널 닫기, ×20회
N1=$(wc -l < $PROCS)
[ $((N1-N0)) -le 6 ] || { echo "FAIL: +$((N1-N0)) 프로세스 누수"; exit 1; }
```
허용치 6 = 앱 자신 + WebKitWebProcess/NetworkProcess/GPUProcess.

**부하 변형:** 8분할 탭 만들고 각 패널에서 `next dev` 띄운 뒤 탭 통째로 닫기. `float` 창에서 8분할 후 타이틀바 X로 닫기(현재 100% 누수 경로). 이 두 개가 가장 잘 터진다.

### 5.2 좀비 계수

```bash
ps --ppid $APP_PID -o stat= | grep -c Z    # 기대: 0
```
`open.rs`/`browser.rs`/`diagnostics.rs`의 런처를 각 50회 호출 후 재측정.

### 5.3 inotify watch 계수 (P0-3 검증)

```bash
for fd in /proc/$APP_PID/fdinfo/*; do
  grep -q '^inotify' $fd && grep -c '^inotify wd:' $fd
done | paste -sd+ | bc
```
**기대: 184,001 → 9,000 미만.** 회귀 임계를 20,000으로 CI에 박는다. 부수 검증으로 `aickyway`에 새 하위 폴더를 만들고 그 안에 파일을 써서 `repo://changed` 가 오는지 확인(증분 watch 등록 회귀 방지 — P0-3의 최대 리스크).

### 5.4 fd / 스레드 누수

```bash
ls /proc/$APP_PID/fd | wc -l                        # 터미널 100회 개폐 전후 증가 0
grep Threads /proc/$APP_PID/status                  # 동일
```
현재는 세션당 fd 2개(마스터 + writer dup) + 스레드 1개가 영구 누적된다(`terminal.rs:140`).

### 5.5 git 고아 강제 재현

블랙홀 원격(`https://10.255.255.1/x.git`)을 가진 테스트 레포로 fetch 200회 실행:
```bash
pgrep -f 'git-remote-https' | wc -l    # 기대: 0
```
현재 코드로 돌리면 최대 400개가 남는다 — 수정 전/후 대비가 그대로 증거가 된다.

### 5.6 24시간 soak + 선형회귀 (핵심 검증)

5분마다 `(timestamp, cgroup_procs, rss_mb, threads, fd_count, inotify_watches)` 를 CSV로 기록하며 정상 워크플로를 24시간 돌린다. 각 계열의 **선형회귀 기울기가 0인지** 본다.

- `cgroup_procs` 기울기 > 0.5 proc/h → **실패**
- `rss_mb` 기울기 > 5 MB/h → 실패
- `threads`, `fd_count` 기울기 > 0 → 실패

이번 사건은 5.95일에 387개 = **2.7 proc/h** 였다. 24시간이면 +65개 — 하루짜리 soak으로 충분히 검출된다. **P0-6의 헬스 틱을 먼저 넣으면 이 CSV가 앱 로그에서 그냥 나온다** — 테스트 하니스가 따로 필요 없다. 관측 장치가 곧 회귀 테스트다.

### 5.7 종료 경로 검증

```bash
kill -TERM $APP_PID; sleep 3
wc -l < $PROCS        # 기대: 0 (scope 소멸)
```
SIGTERM / `systemctl --user stop` / 업데이터 relaunch / 메인 창 X / float 창만 남기고 메인 닫기 — 5개 경로 전부.

### 5.8 CI 가드

1. `clippy.toml` `disallowed-methods` 로 raw `Command::spawn` 차단
2. `grep -rn "Command::new" src-tauri/src | grep -v child_registry` 가 비어야 통과
3. 5.1/5.3/5.5 를 헤드리스 CI 잡으로 (xvfb + 스크립트 IPC)

---

## 6. 한 문단 요약

앱은 **자기 systemd scope 안에서 사용자의 전체 개발 워크로드를 실행**하면서(내장 PTY 터미널 — AI 에이전트가 `sudo ufw status`·`certbot certificates`·`crontab -l` 을 돌린 저널 기록 72건이 그 안에 남아 있다), 패널을 닫을 때 **셸 PID 하나에만 SIGKILL**을 보냈다(`terminal.rs:243`). 자손 트리는 전부 살아남아 cgroup에 영구 잔류했고, 리더 스레드가 마스터 fd를 붙잡아 커널의 SIGHUP 안전망까지 무력화했다. 여기에 **재귀 inotify가 184,001개 watch(필요량의 20배, 커널 메모리 180MB)** 를 얹었고, **사용자가 끈 배경 fetch가 마이그레이션 버그로 5분 주기 부활**해 6일간 20,570회 fetch를 돌리며 타임아웃마다 HTTPS 헬퍼 2개를 남겼다. 5.95일 뒤 387개 프로세스와 95.7 CPU시간(1코어 67% 상시)에 도달했고 systemd-oomd가 cgroup을 통째로 SIGKILL했다. 앱은 **자기 cgroup의 프로세스 수를 한 번도 세어보지 않았고**(monitor.rs는 시스템 전체를 훑으면서 "이 중 내 것"을 묻지 않는다), 로그 160줄 중 52%는 zbus 노이즈, 자기 로그는 9줄 전부 "시작" 메시지였다. **`/proc/self/cgroup` → `cgroup.procs` 줄 수를 세는 코드 한 줄이 이 사건을 6일 전에 끝냈을 것이다.**