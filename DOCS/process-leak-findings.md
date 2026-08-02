# 부록 — 검증 통과 발견 전체 목록

## [high/orphan] open_external()가 OS 기본 브라우저를 앱의 systemd scope(cgroup) 안에서 띄운다 — 크롬 전체 세션이 앱 cgroup에 영구 편입
- 위치: `src-tauri/src/commands/browser.rs:167`  (서브시스템: browser-preview)
- 유발: (1) 인앱 브라우저 탭에서 파일 다운로드 클릭 → handle_download가 OS 브라우저로 위임. (2) 인앱 브라우저에서 팝업이 8개 한도를 넘거나 창 생성이 실패. (3) **메인 앱 화면(프리뷰 iframe 포함)의 target=_blank / window.open 링크 클릭** — 로컬 HTML 프리뷰 페이지 안의 외부 링크가 정확히 이 경로다. 셋 다 사용자가 하루에도 여러 번 하는 평범한 동작이다.
- 메커니즘: 1) 인앱 브라우저에서 다운로드가 발생하거나(browser.rs:177), 팝업 창 생성이 실패하거나(browser.rs:211), 메인 webview에서 target=_blank/window.open이 일어나면(lib.rs:259) open_external(url)이 호출된다.
2) 리눅스 구현은 `Command::new("xdg-open").arg(url).spawn()` — 앱 프로세스의 **직접 자식**으로 xdg-open(sh 스크립트)을 띄운다.
3) 이 머신 실측: XDG_CURRENT_DESKTOP=ubuntu:GNOME → xdg-open의 open_gnome3() 분기 → `gio open <url>` 실행(/usr/bin/xdg-open:637-644).
4) gio open → g_app_info_launch_default_for_uri → 기본 핸들러는 google-chrome.desktop(`xdg-settings get default-web-browser` 실측). 이 .desktop에는 DBusActivatable 키가 **없다** → D-Bus 활성화가 아니라 gio 프로세스가 직접 fork/exec 한다.
5) 결정적: 이 시스템의 GLib은 2.72.4-0ubuntu2.9 이고, libgio-2.0.so.0 안에 systemd transient scope 생성 코드가 **전혀 없다**(`strings | grep -iE 'transient|app-glib|\.scope'` → 0건). app.slice에 존재하는 스코프가 전부 `app-gnome-*`(=gnome-shell이 만든 것)인 것도 같은 사실을 뒷받침한다.
   → 즉 앱 안에서 띄운 크롬은 **자기 스코프를 만들지 못하고 Gitpervisor의 cgroup을 그대로 상속**한다.
6) xdg-open과 gio는 곧 종료하고 크롬은 init으로 reparent 되지만, **cgroup 소속은 reparent로 바뀌지 않는다**. 크롬은 그대로 app-gnome-Gitpervisor-<pid>.scope 안에 남는다.
7) 크롬은 싱글턴이다. 한 번 앱 안에서 콜드 스타트되면, 그 뒤 사용자가 GNOME 독에서 크롬을 눌러 여는 창·탭도 전부 이 브라우저 프로세스가 처리하고 렌더러는 같은 cgroup에서 fork 된다. 10일 내내 크롬 세션 전체가 앱 cgroup의 메모리/CPU로 계산된다.
8) systemd-oomd는 cgroup 단위로 죽인다 → 크롬이 메모리를 밀어올리면 oomd가 scope 전체(=크롬 + Gitpervisor)를 SIGKILL. 패닉 로그도 앱 로그도 없이 '갑자기 꺼짐'이 정확히 이 모양이다.

※ 정직한 반증 확인: 이번 사건의 저널(2026-07-22 부팅 전체)을 뒤져보면 크롬 브라우저 프로세스 시작 로그(extension_garbage_collector INFO)는 app-com.google.Chrome-266499.scope(7/22), app-com.google.Chrome-1047573.scope(7/24), cron.service 밖에 없고 **Gitpervisor scope 안에서 크롬이 시작된 기록은 없다**. 이번 387개가 이것 때문이었다고 단정할 수는 없다. 다만 메커니즘 자체는 1회 발동만으로 수백 개를 만들 수 있는 구조적 지뢰이며, 같은 xdg-open 패턴이 open.rs(25건)/diagnostics.rs(6건)에도 있어 크롬이 아닌 다른 핸들러(에디터·IDE 등)로도 동일하게 터진다.
- 387개 설명가능: True
- 수정: 핸들러를 **앱 cgroup 밖**으로 내보내고, 동시에 자식을 회수한다.
```rust
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_external(url: &str) {
    use std::process::{Command, Stdio};
    let url = url.to_string();
    let null = || (Stdio::null(), Stdio::null(), Stdio::null());
    // 1) transient user service 로 떼어낸다 — systemd-run 은 서비스만 띄우고 즉시 종료하며,
    //    핸들러(크롬 등)는 run-uNNN.service 자기 cgroup 에서 돈다. 앱 scope 의 메모리로
    //    계산되지 않으므로 systemd-oomd 가 앱까지 함께 죽이는 일이 사라진다.
    let (i, o, e) = null();
    let child = Command::new("systemd-run")
        .args(["--user", "--quiet", "--collect", "--", "xdg-open", &url])
        .stdin(i).stdout(o).stderr(e)
        .spawn()
        .or_else(|_| {
            let (i, o, e) = null();
            Command::new("xdg-open").arg(&url)
                .stdin(i).stdout(o).stderr(e).spawn()
        });
    // 2) 반드시 회수 — Child 를 그냥 drop 하면 <defunct> 가 호출마다 1개씩 쌓인다.
    if let Ok(mut c) = child {
        std::thread::spawn(move || { let _ = c.wait(); });
    }
}
```
같은 수정을 open.rs(78/167/230), diagnostics.rs(166)의 xdg-open 호출에도 동일하게 적용해야 한다(공용 헬퍼로 뽑는 것을 권장). macOS의 `Command::new("open")`도 회수(2번)는 똑같이 필요하다 — macOS는 LaunchServices가 별도 프로세스로 띄우므로 cgroup 문제는 없다.

## [low/zombie] spawn한 자식(xdg-open / open)을 wait 하지 않아 호출마다 좀비가 1개씩 영구 누적
- 위치: `src-tauri/src/commands/browser.rs:168`  (서브시스템: browser-preview)
- 유발: F1과 동일 — 인앱 브라우저 다운로드, 팝업 생성 실패, 메인/프리뷰 화면의 target=_blank 링크 클릭. 하루 10~40회 수준이면 10일에 100~400개의 <defunct> 가 쌓인다.
- 메커니즘: `let _ = Command::new("xdg-open").arg(url).spawn();` — 반환된 `Child`가 그 자리에서 drop 된다. Rust `Child`의 Drop은 **wait 하지 않는다**(std 문서 명시). 따라서 xdg-open 셸 스크립트가 gio 를 실행하고 종료한 순간부터 그 PID는 `<defunct>` 상태로 앱 프로세스에 매달려 있고, 앱이 죽을 때까지 절대 회수되지 않는다. macOS의 `Command::new("open")` 경로(browser.rs:164)도 동일하다. 호출 1회 = 좀비 1개, 상한 없음.

다만 387과의 관계는 **아니다**: 이 커널(6.8)에서 좀비는 cgroup.procs 에 들어있지 않다는 것을 직접 실험으로 확인했다(아래 evidence). systemd-oomd 의 "killed 387 process(es)"는 cgroup.procs 를 순회해 센 숫자이므로 좀비는 그 387에 포함될 수 없다. 좀비의 실제 피해는 PID 슬롯/커널 task_struct 소모와 RLIMIT_NPROC 압박이며, 387개 카운트의 원인은 아니다.
- 387개 설명가능: False
- 수정: F1의 수정 코드에 포함된 회수 스레드가 그대로 해법이다:
```rust
if let Ok(mut c) = child { std::thread::spawn(move || { let _ = c.wait(); }); }
```
스레드 1개도 아끼려면 double-fork 헬퍼(중간 자식이 즉시 _exit 해서 손자가 init 으로 reparent 되게)를 쓰면 되지만, 이 호출 빈도에서는 wait 스레드가 훨씬 단순하고 안전하다.

## [low/unbounded-growth] 프리뷰 서버 레지스트리(PreviewServers.ports)가 유휴 종료된 스테일 엔트리를 영원히 들고 있다
- 위치: `src-tauri/src/commands/preview.rs:167`  (서브시스템: browser-preview)
- 유발: 서로 다른 폴더의 .html을 우클릭 프리뷰할 때마다 1건. 레포 12개 × 폴더 수만큼이 상한이라 현실적으로 수십 건 수준.
- 메커니즘: start_server가 띄운 폴링 스레드는 유휴 600초가 되면 `t_alive.store(false)` 후 스스로 종료한다(preview.rs:236-241). 그런데 스레드는 의도적으로 레지스트리를 건드리지 않으므로(주석 149행) `reg.ports`의 엔트리는 그대로 남는다. preview_local_url은 alive==false 엔트리를 '없는 것'으로 보고 새 서버를 띄워 **덮어쓰지만**, 사용자가 그 폴더를 다시는 프리뷰하지 않으면 엔트리는 영원히 남는다. 서로 다른 폴더를 프리뷰할 때마다 HashMap 항목(PathBuf + 32자 토큰 String + Arc 2개)이 하나씩 누적된다. 프로세스도 스레드도 아니고 항목당 수백 바이트라 실피해는 무시할 수준이지만, '자기 치유'는 재사용 시에만 일어나므로 순수 증가 구조인 것은 사실이다.
- 387개 설명가능: False
- 수정: 폴링 스레드가 종료할 때가 아니라 mint 시점에 청소한다 — preview_local_url에서 lock을 잡은 김에 죽은 엔트리를 일괄 제거:
```rust
let mut reg = state.preview.lock().unwrap();
reg.ports.retain(|_, e| e.alive.load(Ordering::Relaxed));   // 추가
```
(스레드가 레지스트리를 직접 건드리지 않는 기존 설계를 유지하면서 무한 증가만 끊는다.)

## [low/other] 프리뷰 accept 루프가 WouldBlock 외의 모든 에러(EINTR 포함)에서 조용히 죽는다
- 위치: `src-tauri/src/commands/preview.rs:243`  (서브시스템: browser-preview)
- 유발: 자식 프로세스 대량 spawn 중 SIGCHLD 로 accept 가 EINTR 을 받거나, fd 고갈로 EMFILE 이 뜰 때. 이번 사건처럼 프로세스가 수백 개인 상황에서 특히 잘 걸린다.
- 메커니즘: accept()가 WouldBlock 이 아닌 에러를 내면 무조건 `return` 으로 스레드를 끝낸다. EINTR(시그널로 인한 중단)이나 EMFILE(프로세스 전체 fd 고갈) 같은 **일시적** 에러까지 영구 종료로 취급한다. 이 앱은 PTY/LSP/git/xdg-open 등으로 자식 프로세스를 대량 spawn 하므로 SIGCHLD 가 빈번하고, fd 고갈 상황도 현실적이다. 서버가 죽으면 alive 플래그는 true 인 채 리스너만 사라지므로, preview_local_url 은 그 엔트리를 '살아있다'고 보고 **죽은 포트를 재사용해 URL 을 내준다** → 프리뷰 탭이 조용히 '연결 거부'가 된다(remint 로도 안 낫는다. alive 가 true 라서 새 서버를 안 띄운다). 로그도 남기지 않는다. 누수는 아니지만 자기 치유가 깨지는 실제 버그다.
- 387개 설명가능: False
- 수정: 일시적 에러는 재시도하고, 진짜로 포기할 때는 alive 를 내려 자기 치유가 동작하게 한다:
```rust
Err(ref e) if matches!(e.kind(), std::io::ErrorKind::Interrupted) => continue,
Err(e) => {
    log::warn!("프리뷰 accept 실패({e}) — 서버 종료");
    t_alive.store(false, Ordering::Relaxed);   // 다음 mint 가 새로 띄우게
    return;
}
```

## [critical/orphan] open_terminal이 터미널을 앱 cgroup 안에 직계 자식으로 띄운다 — 터미널에서 돌린 모든 프로세스가 Gitpervisor scope에 누적 (387개+CPU 4일 동시 설명)
- 위치: `src-tauri/src/commands/open.rs:237`  (서브시스템: open-quarantine-diagnostics)
- 유발: 사이드바 프로젝트 우클릭 → "터미널로 열기" (src/components/sidebar/ProjectList.tsx:297-301 handleOpenIn → ipc.openIn → callMutating("open_in")). callMutating 은 재시도하지 않으므로 클릭 1회 = spawn 1회. 주기 호출은 없다(전적으로 사용자 행동).
- 메커니즘: 1) 사용자가 사이드바 프로젝트 우클릭 → "터미널로 열기" → open_in(target=Terminal) → open_terminal(). 2) `Command::new("x-terminal-emulator").current_dir(path).spawn()` — setsid/process_group 없음, systemd 위임 없음. fork/exec 된 자식은 부모의 cgroup을 그대로 상속하므로 `app-gnome-Gitpervisor-3074382.scope` 안에 들어간다. 3) 이 머신에서 x-terminal-emulator 는 `/usr/bin/terminator`(Python/GTK) 다. terminator 는 DBus 마스터 모델이다 — (a) 기존 인스턴스가 없으면 spawn 된 이 프로세스가 데스크톱 전체의 **마스터**가 되어 장수 GUI 프로세스로 남고, 이후 사용자가 GNOME 독/Activities 로 여는 터미널 창까지 전부 이 마스터가 fork 한다 → 그 셸들과 셸 안에서 돌린 모든 것(npm/node/uvicorn/cargo/claude/파일워처)이 전부 Gitpervisor scope 로 들어간다. (b) 기존 마스터가 있으면 이 자식은 DBus 로 요청만 보내고 즉시 `sys.exit()`(/usr/bin/terminator:117) → 부모가 wait 안 하므로 영구 좀비. 4) 앱은 이 자식을 죽이지도 회수하지도 않는다 — lib.rs:406 의 WindowEvent::Destroyed 정리는 kill_all(PTY)/lsp_kill_all/browser_kill_all/popup_kill_all 만 돌고 open.rs 계열은 대상 자체가 없다(핸들을 보관조차 안 함). 5) 결과: 앱 scope 의 프로세스 수와 CPU가 사용자의 실제 개발 워크로드만큼 무한 증가 → 메모리 압박 → systemd-oomd 가 cgroup 통째로 SIGKILL.
- 387개 설명가능: True
- 수정: 터미널을 앱 cgroup 밖 자체 유닛으로 위임하고, 자식은 반드시 회수한다.

```rust
#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(path: &Path) -> Result<(), IpcError> {
    use std::process::Stdio;
    // 1순위: systemd 유저 매니저에 위임 → 터미널이 app-gnome-Gitpervisor-*.scope 밖
    //        독립 transient 유닛에서 뜬다. 그 안에서 돌린 dev 서버가 앱 scope 로
    //        집계되지 않으므로 oomd 가 앱째로 죽이는 일이 없어진다.
    //        systemd-run 은 유닛 등록 후 즉시 반환하므로 status()로 동기 회수해도 싸다.
    let delegated = Command::new("systemd-run")
        .args(["--user", "--quiet", "--collect", "--same-dir", "--",
               "x-terminal-emulator"])
        .current_dir(path)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if delegated {
        return Ok(());
    }
    // 폴백: systemd-run 이 없는 환경. 최소한 프로세스 그룹은 분리하고 반드시 reap 한다.
    let mut cmd = Command::new("x-terminal-emulator");
    cmd.current_dir(path)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // Rust 1.64+, libc 의존 불필요
    }
    let child = cmd.spawn().map_err(|e| spawn_err("터미널", e))?;
    reap_detached(child);
    Ok(())
}
```

공용 회수 헬퍼(아래 finding 2 와 공유):
```rust
/// 자식을 백그라운드에서 wait 해 좀비를 남기지 않는다. 런처는 곧 끝나므로 스레드도 곧 죽는다.
pub fn reap_detached(mut child: std::process::Child) {
    let _ = std::thread::Builder::new()
        .name("child-reaper".into())
        .stack_size(64 * 1024)
        .spawn(move || { let _ = child.wait(); });
}
```

주의: 전역 `signal(SIGCHLD, SIG_IGN)` 로 일괄 해결하려 하지 마라 — git/runner.rs·tools/runner.rs·lsp·PTY 가 쓰는 `.wait()`/`.output()` 가 ECHILD 로 깨진다.

## [high/zombie] open.rs·diagnostics.rs의 모든 런처 spawn이 .wait() 없이 Child를 drop → 클릭마다 영구 좀비 (단, oomd의 387 집계에는 포함되지 않음 — 실측 검증)
- 위치: `src-tauri/src/commands/open.rs:78`  (서브시스템: open-quarantine-diagnostics)
- 유발: reveal_path: 리소스 모니터 프로세스 우클릭 → "파일 위치 열기" (src/components/sysmon/SysMonitorWindow.tsx:349-355). open_explorer: 프로젝트 우클릭 → "탐색기로 열기" (ProjectList.tsx:297). open_dir: 설정 → "로그 폴더 열기" (src/components/settings/sections/MaintenanceSection.tsx:101). 전부 사용자 클릭 1회 = spawn 1회 (callMutating 은 재시도 없음, ipc.ts:686-703).
- 메커니즘: 1) reveal()(open.rs:78-83), open_explorer()(open.rs:230-235), open_terminal()(open.rs:239-244), run_file()(open.rs:165-172), diagnostics.rs open_dir()(166-171) 이 모두 `.spawn().map(|_| ())` 로 `Child` 를 즉시 버린다. 2) Rust std 의 `Child` 는 Drop 에서 wait 하지 않는다(문서 명시). 3) 저장소 어디에도 SIGCHLD 핸들러/waitpid/전역 리퍼가 없다(grep 0건). 4) 따라서 xdg-open(=/bin/sh 스크립트, GNOME 에서는 gio→DBus 로 nautilus 를 띄우고 즉시 종료)은 실행 직후 종료되지만 부모가 회수하지 않아 **앱이 살아있는 동안 영구 좀비**로 남는다. 5) 좀비는 task_struct 와 PID 슬롯을 점유하고 cgroup 의 pids.current 에 계속 계상된다 → pids.max 도달 시 앱 전체가 fork 불가(EAGAIN)가 된다.

**다만 오케스트레이터 가설("387 = xdg-open 좀비")은 이 커널에서 반증됨**: 좀비는 do_exit 중 cgroup_exit() 으로 cgroup task 리스트에서 빠지므로 `cgroup.procs` 에 나타나지 않고, systemd-oomd 는 cgroup.procs 를 읽어 SIGKILL 한 수를 보고한다. 즉 387 에는 좀비가 들어가지 않는다. 게다가 좀비는 CPU 0을 쓰므로 3d23h CPU 도 설명 못 한다.
- 387개 설명가능: False
- 수정: 플랫폼별 spawn 지점을 공용 헬퍼로 일원화해 전부 회수한다. open.rs 상단에 두고 diagnostics.rs::open_dir 도 같은 헬퍼를 쓰게 한다.

```rust
use std::process::{Child, Command, Stdio};

/// 런처(xdg-open/open/explorer)를 띄우고 반드시 회수한다.
/// - 앱의 stdin/stdout/stderr 를 물려주지 않는다(fd·로그 오염 방지)
/// - unix 는 프로세스 그룹을 분리해 앱에 보내는 그룹 시그널이 전파되지 않게 한다
fn spawn_launcher(mut cmd: Command, what: &str) -> Result<(), IpcError> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.spawn().map_err(|e| spawn_err(what, e))?;
    reap_detached(child);
    Ok(())
}

pub fn reap_detached(mut child: Child) {
    let _ = std::thread::Builder::new()
        .name("child-reaper".into())
        .stack_size(64 * 1024)
        .spawn(move || { let _ = child.wait(); });
}
```
호출부 예 (open.rs:74-83):
```rust
fn reveal(path: &Path) -> Result<(), IpcError> {
    let dir = path.parent().unwrap_or(path);
    let mut c = Command::new("xdg-open");
    c.arg(dir);
    spawn_launcher(c, "탐색기")
}
```
open.rs:230(open_explorer), open.rs:57/66(win/mac reveal), open.rs:154/211/219(mac), open.rs:178/191/200(win), diagnostics.rs:148/157/166(open_dir) 전부 동일하게 교체.

## [medium/orphan] run_executable이 레포 안 임의 바이너리를 회수·종료 없는 직계 자식으로 실행 — 리눅스에선 프론트 게이트 때문에 도달 불가(잠재 위험)
- 위치: `src-tauri/src/commands/open.rs:161`  (서브시스템: open-quarantine-diagnostics)
- 유발: 파일트리에서 .exe/.bat/.cmd/.com/.msi 더블클릭 → 확인 다이얼로그 → ipc.runExecutable (FileTreePanel.tsx:496-512). Ubuntu 환경에서는 발화 경로 없음.
- 메커니즘: 1) 파일트리 더블클릭 → run_executable → run_file(). 2) Linux 분기는 `Command::new(target).current_dir(dir).spawn()` 으로 **레포 안 실행 파일을 앱의 직계 자식으로** 띄운다. 3) wait 없음(좀비), kill 없음, 핸들 보관 없음 → 장수 프로세스(dev 서버·데몬)라면 앱 cgroup 안에서 영원히 살며 CPU·메모리를 앱 scope 로 계상시킨다. 4) lib.rs:406 Destroyed 정리에도 대상이 없다. 5) **그러나** 프론트 게이트 EXEC_EXT 가 Windows 확장자만 담고 있어 리눅스에서는 더블클릭으로 이 경로가 절대 발화하지 않는다 → 이번 Ubuntu 장애의 원인은 아니다. Windows/macOS 사용자나 커맨드를 직접 invoke 하는 경로에서는 실재하는 결함이다.
- 387개 설명가능: False
- 수정: run_file 도 finding 2 의 `spawn_launcher` 헬퍼를 쓰고, 장수 프로세스가 앱 scope 를 오염시키지 않도록 리눅스는 systemd 위임을 우선한다.

```rust
#[cfg(all(unix, not(target_os = "macos")))]
fn run_file(target: &Path) -> Result<(), IpcError> {
    use std::process::Stdio;
    let dir = target.parent().unwrap_or(target);
    // 사용자가 띄운 프로그램이 앱 cgroup 밖에서 살도록 systemd 유저 유닛에 위임.
    if Command::new("systemd-run")
        .args(["--user", "--quiet", "--collect", "--"])
        .arg(target)
        .current_dir(dir)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let mut direct = Command::new(target);
    direct.current_dir(dir);
    if spawn_launcher(direct, "실행").is_ok() {
        return Ok(());
    }
    let mut fallback = Command::new("xdg-open");
    fallback.arg(target);
    spawn_launcher(fallback, "실행")
}
```

## [low/other] [정상] quarantine.rs — 리눅스에서 프로세스를 하나도 만들지 않으며, macOS 경로도 .output()으로 완전히 회수된다
- 위치: `src-tauri/src/commands/quarantine.rs:161`  (서브시스템: open-quarantine-diagnostics)
- 유발: src/lib/ipc.ts:1088 scanQuarantinedTools / 1094 clearQuarantine. Ubuntu 에서는 무엇을 호출해도 프로세스가 생기지 않는다.
- 메커니즘: 누수 없음. (1) 이 사용자의 Ubuntu 빌드에서는 `#[cfg(not(target_os = "macos"))]` 스텁만 컴파일된다 — scan_quarantined_tools 는 `Vec::new()` 반환(161-165), clear_quarantine 은 `Ok(())` 반환(192-196). xattr 를 부르는 코드는 애초에 바이너리에 없다. (2) macOS 경로조차 `has_quarantine`(24-29) 과 `clear_quarantine`(174-178) 이 `.output()` 을 쓴다 — `.output()` 은 내부적으로 wait 까지 수행해 자식을 완전히 회수하므로 좀비가 생기지 않는다. (3) clear_quarantine 은 받은 paths 를 순차 루프로 돌 뿐 동시 spawn 이나 무한 루프가 없고, 스캔은 순수 파일시스템 read_dir 이다. 스레드·fd 누수도 없다.
- 387개 설명가능: False
- 수정: 수정 불필요. 이 파일은 자식 프로세스 생명주기 측면에서 완전히 정상이며 이번 장애와 무관하다.

## [low/other] [대체로 정상] diagnostics.rs — 로그 관련 커맨드는 순수 파일시스템·상한 적용으로 정상이고, 누수는 open_dir의 xdg-open 좀비 1건뿐
- 위치: `src-tauri/src/commands/diagnostics.rs:102`  (서브시스템: open-quarantine-diagnostics)
- 유발: 설정 → 유지관리 → "로그 폴더 열기" (src/components/settings/sections/MaintenanceSection.tsx:101) 만이 프로세스를 만든다. prune_logs 는 lib.rs setup 에서 기동 시 1회.
- 메커니즘: 프로세스/스레드/fd 누수 없음. (1) get_log_status(49-67), read_crash_log(70-79), clear_crash_log(82-98), prune_logs(102-142) 는 전부 std::fs 호출뿐 — spawn 0회, 스레드 0개. (2) 무한 증가 방지가 오히려 잘 되어 있다: read_crash_log 는 READ_CAP 2MB 로 응답을 자르고(76-78), prune_logs 는 panic.log 4MB 초과 시 1세대만 회전(104-108), 로그 폴더 총량 100MB 상한을 오래된 파일부터 삭제로 강제한다(126-141). 루프는 files 벡터 위 유한 순회라 무한 루프 불가. (3) 유일한 spawn 은 open_dir 의 xdg-open(166-171) 이고 이건 finding 2 에서 다룬 좀비 1개짜리 문제다. (4) 사용자가 실제로 이 앱의 로그가 5주간 160줄뿐이었다고 보고한 점과 정합적 — 이 모듈은 로그를 많이 쓰지도, 리소스를 잡아먹지도 않는다.
- 387개 설명가능: False
- 수정: open_dir(diagnostics.rs:164-171)만 finding 2 의 `spawn_launcher` 헬퍼로 교체하면 된다. 나머지 로그 처리 코드는 수정 불필요 — 상한과 회전이 이미 올바르게 걸려 있다.
```rust
#[cfg(all(unix, not(target_os = "macos")))]
fn open_dir(dir: &Path) -> Result<(), IpcError> {
    let mut c = Command::new("xdg-open");
    c.arg(dir);
    crate::commands::open::spawn_launcher(c, "폴더")
}
```

## [critical/zombie] kill() 후 wait()가 전무 — 종료된 언어 서버가 전부 영구 좀비로 남는다
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/lsp.rs:204`  (서브시스템: lsp)
- 유발: LSP를 켠 프로젝트에서 소스 파일을 열 때마다 서버가 뜨고(DiffViewer.tsx:321 → lspOpenDoc → ensureSession → lsp_start), 10분 유휴 시 리퍼가 죽인다(lsp.rs:226). 즉 "파일 열기 → 10분 방치" 사이클 1회 = 좀비 1개. 앱 종료(lib.rs:413)에서도 kill만 하고 wait를 안 한다.
- 메커니즘: 1) lsp_stop/lsp_kill_all/유휴 리퍼가 `child.kill()`(=SIGKILL)만 호출한다. 2) Rust `std::process::Child`는 Drop 구현이 없다(표준 문서 명시: "There is no implementation of Drop for child processes") — 드롭돼도 kill도 wait도 하지 않는다. 3) 코드베이스 전체에 SIGCHLD 핸들러도, `signal(SIGCHLD, SIG_IGN)`도, `libc::waitpid`도 없다(`grep -rn "libc::|SIGCHLD|signal(" src-tauri/src` 결과 0건). Cargo.toml에 libc/nix 의존도 없다. tokio는 process 피처가 있지만 tokio의 OrphanQueue는 자기가 스폰한 `tokio::process::Child`만 특정 pid로 waitpid하므로 std 스폰 자식은 회수하지 않는다. 4) 결과: SIGKILL 맞은 node/clangd는 `<defunct>` 상태로 앱 프로세스가 죽을 때까지 남는다. 5) 서버가 스스로 죽는 경로(크래시·shutdown/exit)도 동일 — reader_loop가 레지스트리에서 remove만 하고 반환된 LspSession(그 안의 Child)을 그대로 드롭한다(lsp.rs:256).
- 387개 설명가능: False
- 수정: kill 직후 반드시 회수한다. lsp.rs:204/213/233 세 곳을 `{ let mut c = s.child.lock().unwrap(); let _ = c.kill(); let _ = c.wait(); }`로 바꾼다(SIGKILL은 즉시 종료되므로 wait는 블로킹하지 않는다). reader_loop(lsp.rs:255-263)에서도 `if let Some(s) = map.remove(&key) { let mut c = s.child.lock().unwrap(); let _ = c.wait(); }`로 EOF 경로를 회수한다. 근본적으로는 LspSession에 `Drop` 구현을 달아 kill+wait를 보장하는 편이 누락 방지에 낫다.

## [critical/orphan] 직계 자식만 죽인다 — tsserver·cargo/rustc 등 손자 프로세스가 앱 cgroup 안에 살아남는다
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/lsp.rs:99`  (서브시스템: lsp)
- 유발: ts/rust/java 프로젝트에서 파일을 열어 서버가 뜬 뒤, 10분 유휴 리퍼(lsp.rs:233) 또는 앱 종료(lib.rs:413)로 부모가 SIGKILL 되는 순간마다.
- 메커니즘: 1) lsp_start는 `Command::new(&resolved.program)`을 프로세스 그룹 설정 없이 스폰한다 — src-tauri/src 전체에 `process_group`·`setsid`·`pre_exec`가 0건이다(grep 확인). 2) `child.kill()`은 그 PID 하나에만 SIGKILL을 보낸다. 3) 그런데 실제 언어 서버는 손자를 만든다: typescript-language-server(cli.mjs)는 tsserver를 별도 node 프로세스로 fork하고, tsserver는 다시 syntax 전용 서버를 띄울 수 있다. rust-analyzer는 proc-macro-srv와 `cargo check`/`rustc`를 스폰한다. jdtls는 JVM을 띄운다. 4) 부모가 SIGKILL로 즉사하면 손자는 고아가 되어 systemd user 인스턴스로 reparent되지만, **cgroup 소속은 fork 시점에 상속되고 reparent로 바뀌지 않는다** — 즉 손자는 계속 `app-gnome-Gitpervisor-*.scope` 안에 살아있는 프로세스로 남아 메모리를 물고 CPU를 태운다. 5) lsp_kill_all도 레지스트리의 직계 PID만 알기 때문에 앱 종료 시에도 손자는 회수 대상이 아니다.
- 387개 설명가능: False
- 수정: 유닉스는 `use std::os::unix::process::CommandExt; cmd.process_group(0);`로 스폰해 자식을 프로세스 그룹 리더로 만들고, 종료 시 `libc::killpg(child.id() as i32, libc::SIGKILL)` 후 `child.wait()`로 그룹 전체를 죽인다(terminal.rs의 PTY 관례와 동일하게). 윈도우는 Job Object(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)에 자식을 넣는다. 병행 방어로, LSP 스펙대로 kill 전에 `shutdown`→`exit`를 보내 서버가 스스로 손자를 정리할 시간(200~500ms)을 준 뒤 SIGKILL 하는 graceful 경로를 추가한다.

## [high/unbounded-growth] 프론트가 lsp_stop을 단 한 번도 호출하지 않는다 — 회수 수단이 10분 리퍼 하나뿐
- 위치: `/home/generator/gitpervisor/src/lib/lsp/client.ts:253`  (서브시스템: lsp)
- 유발: LSP 옵트인 프로젝트에서 파일을 열면 서버가 뜬다. 그 뒤 파일을 닫든, 다른 프로젝트로 전환하든, 사이드바에서 프로젝트를 삭제하든 서버는 계속 산다. 레포 12개를 순회하며 py/ts 파일을 훑으면 그 자체로 서버 20여 개가 동시 기동된다.
- 메커니즘: 1) `dispose(stopServer)`에서 `stopServer=true`일 때만 `invoke("lsp_stop")`이 나간다(client.ts:253). 2) 그런데 코드베이스 전체에서 dispose를 호출하는 곳은 lsp://exit 리스너의 `s.dispose(false)`(client.ts:267) 단 한 곳뿐이다(`grep -rn "dispose(" src/` 확인 — 나머지는 monaco/terminal의 무관한 dispose). 즉 **lsp_stop은 프론트에서 도달 불가능한 죽은 코드**다. 3) 파일 닫기(lspCloseDoc, sync.ts:65)는 didClose 통지만 보내고 세션은 유지한다. DiffViewer 언마운트(DiffViewer.tsx:329)도 didClose만. 프로젝트 전환·프로젝트 삭제(commands/projects.rs에 lsp 참조 0건)도 서버를 죽이지 않는다. 4) 결과: 세션 키가 `{projectId}:{lang}`이므로 12개 레포 × 11개 언어 = 최대 132개 서버가 동시에 살아있을 수 있고, 유일한 정리 수단은 10분 유휴 리퍼뿐이다. 그 리퍼는 F4/F5로 무력화될 수 있다. node 계열 서버(basedpyright·tsserver)는 개당 200MB~1GB라 십수 개만 살아도 수 GB다.
- 387개 설명가능: False
- 수정: (1) sync.ts의 lspCloseDoc에서 `if (!b.session.hasOpenDocs()) { b.session.dispose(true); sessions.delete(b.session.key); }`로 열린 문서가 0이 되면 세션을 끈다. (2) 프로젝트 제거/경로 변경 시 백엔드에서 `{projectId}:` 접두 키를 전부 stop 하도록 commands/projects.rs의 remove_project/update_project_path에 훅을 넣는다. (3) 백엔드에 동시 세션 상한(예: LRU 4개)을 두고 초과분을 가장 오래된 것부터 kill+wait 한다.

## [high/unbounded-growth] 유휴 리퍼가 서버가 유발한 트래픽까지 '활동'으로 세어 영원히 안 죽을 수 있다
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/lsp.rs:175`  (서브시스템: lsp)
- 유발: 수다스러운 서버(basedpyright의 인덱싱 진행률, tsserver의 동적 capability 등록)를 한 번 띄우면 그 뒤 사용자가 앱을 방치해도 리퍼가 발동하지 않는다.
- 메커니즘: 1) 리퍼의 유일한 판정 기준은 `last_activity.elapsed() > 10분`(lsp.rs:226)이고, last_activity를 갱신하는 곳은 `lsp_send`(lsp.rs:175)와 lsp_start 재부착(lsp.rs:73)뿐이다. 2) 그런데 프론트는 **서버가 보낸 요청에 반드시 응답**한다 — onMessage에서 `msg.id !== undefined && msg.method`이면 `this.reply(msg.id, result)`(client.ts:156-168). 3) `reply()`는 `frameSend()`를 직접 부르는데, `notify()`(client.ts:196)와 달리 `disposed` 가드가 없다 → 이미 dispose된 세션도 계속 응답을 보낸다. 4) 즉 서버가 `window/workDoneProgress/create`·`client/registerCapability`·`workspace/configuration`을 자기 스케줄로 보내기만 하면, 사용자가 손도 안 댄 세션의 last_activity가 계속 갱신돼 리퍼가 영원히 안 돈다. basedpyright는 분석 패스마다 workDoneProgress/create를, tsserver 계열은 registerCapability를 보낸다. 5) F3(프론트가 stop을 안 함) + F2(손자)와 겹치면 대용량 node 서버가 무기한 생존한다.
- 387개 설명가능: False
- 수정: 활동 판정을 사용자 기점 트래픽으로 좁힌다: lsp_send에 `is_user_initiated: bool`(또는 별도 커맨드)을 두고 reply 경로에서는 last_activity를 갱신하지 않는다. 병행해서 프론트 `frameSend`에 `if (this.disposed) return;` 가드를 추가하고, 백엔드 리퍼에 '열린 문서 0 + 30분 경과'라는 절대 상한(하드 캡)을 추가한다.

## [medium/orphan] initialize 타임아웃/재부착 실패 시 세션이 영구 좌초 — 서버는 살아있는데 프론트가 재시도도 종료도 못 한다
- 위치: `/home/generator/gitpervisor/src/lib/lsp/client.ts:68`  (서브시스템: lsp)
- 유발: (a) 대형 레포에서 첫 LSP 기동 시 initialize 응답이 10초를 넘길 때. (b) ErrorBoundary의 `location.reload()`(ErrorBoundary.tsx:44)나 웹뷰 리로드 이후 같은 프로젝트의 파일을 다시 열 때.
- 메커니즘: 1) `start()`는 `this.starting`이 non-null이면 그 프로미스를 그대로 반환한다(client.ts:67). 2) `this.starting = this.doStart().catch(() => { this.starting = null; return false; })` — starting을 null로 되돌리는 건 **throw 경로뿐**인데, doStart는 invoke를 try/catch로(client.ts:87), initialize 요청을 `.catch(() => null)`로(client.ts:121) 전부 삼키므로 실제로는 throw하지 않고 false를 return한다 → starting은 false로 확정된 프로미스로 영구 고정된다. 3) 그런데 그 시점에 백엔드 자식은 이미 스폰·등록된 상태다(lsp.rs:110-151). 즉 UI는 이 언어를 영원히 휴리스틱 폴백으로 쓰면서, 살아있는 node 서버 1개는 계속 메모리를 문다. 4) 트리거 두 가지: (a) 큰 레포에서 basedpyright/tsserver의 초기 인덱싱이 REQUEST_TIMEOUT=10초를 넘겨 initialize가 타임아웃. (b) 웹뷰 리로드 후 재부착 — 재부착 경로가 `tsserver_path: None`을 돌려주는데(lsp.rs:83) 프론트는 그걸 보고 initializationOptions 없이 **이미 초기화된 서버에 initialize를 또 보낸다**(client.ts:95-121) → 서버가 InvalidRequest로 거절 → doStart false → 같은 좌초. 5) 좌초된 세션은 dispose되지 않으므로 lsp_stop도 안 나가고(F3), 서버발 요청에 대한 reply는 계속 나가 last_activity를 갱신할 수 있다(F4) → 리퍼마저 무력화된다.
- 387개 설명가능: False
- 수정: (1) doStart가 false를 반환하는 모든 경로에서 `this.starting = null`로 되돌려 재시도를 허용하고, 반환 직전에 `void invoke("lsp_stop", { sessionKey: this.key })`로 백엔드 자식을 반드시 정리한다. (2) initialize에는 REQUEST_TIMEOUT(10초) 대신 별도의 긴 타임아웃(60초 이상)을 쓴다 — 콜드 인덱싱은 정상적으로 10초를 넘는다. (3) LspServerInfo에 `reattached: bool`을 추가해 재부착 시 프론트가 initialize를 건너뛰고 기존 capabilities를 재사용하도록 한다(재부착 시 tsserver_path/serverCaps도 세션에 캐시해 돌려준다).

## [critical/orphan] 터미널 종료가 셸 PID 하나에만 SIGHUP/SIGKILL을 보낸다 — PTY 세션 전체(자손 프로세스 그룹)를 죽이지 않아 고아가 앱 cgroup에 영구 잔류
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:243`  (서브시스템: terminal-pty)
- 유발: 패널 닫기(Ctrl+Shift+W / 우클릭 "패널 닫기" / PaneControls X / 모아보기 셀 X), 탭 닫기(WorkspaceTabs onClose→closeTab), 프로젝트 제거(queries/index.ts:694 closeProjectTerminals), "재시작" 버튼(TerminalPane.tsx:91 disposeTerminal), 플로팅 창 닫기. 즉 **터미널에서 `npm run dev`/`vite`/`next dev`/`cargo watch`/`claude` 같은 장기 실행 명령을 띄운 상태로 그 패널을 닫는** 모든 경우.
- 메커니즘: 1) term_open이 portable_pty로 셸을 띄운다(terminal.rs:91-94). portable-pty의 unix pre_exec은 `libc::setsid()`를 호출해(unix.rs:220) 셸을 **세션 리더**로 만들고, 셸의 각 job은 그 세션 안의 *다른* 프로세스 그룹으로 들어간다.
2) 탭/패널을 닫으면 close_session이 `session.child.lock().unwrap().kill()` 하나만 호출한다(terminal.rs:243, kill_all은 252, term_open 교체는 158).
3) portable-pty의 `ChildKiller for std::process::Child`(lib.rs:330-362) 구현은 **`libc::kill(self.id(), SIGHUP)` — 음수 pid도 killpg도 아닌 단일 PID**다. 이어 50ms×4 = 최대 200ms만 기다린 뒤(lib.rs:347-356) `std::process::Child::kill` = **단일 PID에 SIGKILL**.
4) 200ms 안에 zsh가 죽지 않으면 SIGKILL이 날아가고, SIGKILL은 핸들러가 없으므로 zsh는 **자기 job들에게 HUP을 전파할 기회조차 없이** 죽는다 → job 트리 전체가 통째로 고아가 된다. 200ms 안에 죽더라도 setsid()로 분리된 손자(esbuild service, next-server 자식, tsserver, nohup/disown된 것)는 셸의 job 테이블 밖이라 살아남는다.
5) 고아는 PID 1로 reparent되지만 **cgroup 소속은 바뀌지 않는다** → 계속 `app-gnome-Gitpervisor-3074382.scope` 안에 남아 oomd의 387 카운트와 scope CPU 누적(3d23h)에 그대로 들어간다.
6) 결정타: 리더 스레드가 마스터 fd의 **dup**(portable-pty unix.rs:315 `try_clone_reader`)을 쥔 채 `read()`에 영구 블록되므로(발견 #2), 커널이 "마지막 마스터 fd가 닫히면 pty 전경 프로세스 그룹에 SIGHUP"을 보내는 **유일한 안전망마저 발동하지 않는다**. 고아가 리더를 붙잡고, 리더가 고아를 살려주는 순환.
- 387개 설명가능: True
- 수정: 세션(sid) 단위로 죽이고 반드시 reap한다. portable-pty가 setsid()를 하므로 셸의 pid == sid == 자기 pgid다.

```rust
// TerminalSession에 pid 보관
struct TerminalSession { /* ... */ pid: i32 }
// term_open: let pid = child.process_id().unwrap_or(0) as i32;  (Arc<Mutex>로 감싸기 전에 획득)

fn terminate_session(pid: i32) {
    if pid <= 0 { return; }
    let victims = |sid: i32| -> Vec<i32> {           // /proc 훑어 같은 세션 전원 수집
        std::fs::read_dir("/proc").into_iter().flatten().flatten()
            .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
            .filter(|&p| std::fs::read_to_string(format!("/proc/{p}/stat")).ok()
                .and_then(|s| s.rsplit(')').next()?.split_whitespace().nth(3)?.parse::<i32>().ok())
                == Some(sid))
            .collect()
    };
    unsafe { libc::kill(-pid, libc::SIGHUP); libc::kill(-pid, libc::SIGTERM); }   // 셸 자신의 pgid
    for p in victims(pid) { unsafe { libc::kill(p, libc::SIGTERM); } }             // 다른 job 그룹까지
    for _ in 0..15 {                                                               // 최대 300ms 유예
        std::thread::sleep(std::time::Duration::from_millis(20));
        let mut st = 0; if unsafe { libc::waitpid(pid, &mut st, libc::WNOHANG) } == pid { break; }
    }
    unsafe { libc::kill(-pid, libc::SIGKILL); }
    for p in victims(pid) { unsafe { libc::kill(p, libc::SIGKILL); } }
    let mut st = 0; unsafe { libc::waitpid(pid, &mut st, 0); }                      // ★ 반드시 reap
}
```
close_session / kill_all / term_open 교체 경로 셋 다 `child.kill()` 대신 `terminate_session(session.pid)`를 쓴다. 더 근본적으로는 셸마다 별도 cgroup(systemd-run --user --scope)이나 PR_SET_CHILD_SUBREAPER + 세션 스윕 중 하나를 채택할 것.

## [critical/zombie] kill 후 wait()를 안 한다 — 회수를 EOF에만 의존하는데, 자손이 슬레이브 fd를 쥐면 EOF가 영원히 안 와 셸이 영구 좀비 + 리더 스레드/fd 영구 누수
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:133`  (서브시스템: terminal-pty)
- 유발: 발견 #1과 동일 트리거(패널/탭/플로팅 창 닫기, 프로젝트 제거, 재시작 버튼) + 추가로 **사용자가 백그라운드 job(`cmd &`, `nohup`, `setsid`, tmux/pm2 기동)을 남긴 채 셸에 `exit`를 치는 경우**. 후자는 kill조차 안 거치고 곧장 좀비 + 스레드 누수로 간다.
- 메커니즘: 1) close_session/kill_all/term_open-교체는 `kill()`만 하고 **wait()를 전혀 하지 않는다**(terminal.rs:239-245, 248-254, 154-159). 회수는 전적으로 리더 스레드에 위임돼 있다.
2) 리더 스레드의 `child.wait()`(terminal.rs:133-138)는 read 루프를 `break`한 뒤에만 도달한다.
3) `break`는 `Ok(0)`(=EIO를 portable-pty가 Ok(0)으로 변환, unix.rs:86-96) 또는 `Err`일 때만 난다. 마스터 read가 EIO를 내는 조건은 **슬레이브 쪽 fd가 전부 닫혔을 때**다.
4) 그런데 살아남은 자손(발견 #1)은 spawn 시 stdin/stdout/stderr로 슬레이브를 상속받았다(portable-pty unix.rs:200-202). 그놈이 살아있는 한 슬레이브 fd는 열려 있고 → **read()가 영원히 블록** → break 없음 → `wait()` 호출 없음.
5) 결과: SIGKILL로 죽인 셸이 **영구 좀비**로 남는다. `std::process::Child`의 Drop은 wait를 하지 않고, Arc 클론을 리더 스레드가 들고 있어 Child 구조체도 살아있다. 좀비도 cgroup.procs에 계속 잡히므로 oomd의 387에 그대로 포함된다.
6) 동시에 그 std::thread는 영구 블록(스레드 누수, 스택 예약 8MB/개)이고, 그 스레드가 쥔 마스터 fd dup(unix.rs:315)도 영구 누수 — 이 fd 때문에 커널의 pty SIGHUP 안전망도 안 터진다(#1의 순환).
7) 사용자가 `exit`를 쳐서 셸이 스스로 죽은 경우에도 동일하다 — 백그라운드 job이 남아 있으면 셸은 회수되지 않고 좀비, 프론트는 exit 이벤트조차 못 받아 패널이 계속 "live"로 보인다.
- 387개 설명가능: True
- 수정: (a) 죽인 쪽이 회수하도록 바꾼다 — 발견 #1 fix의 `terminate_session()` 끝에 `libc::waitpid(pid, &mut st, 0)`을 넣고, close_session/kill_all/교체 경로 모두 그걸 호출.
(b) 리더 스레드가 반드시 빠져나올 수 있게 한다. 현재는 EOF에 목을 매고 있다 — `closed` 플래그를 폴링 가능한 구조로:
```rust
// term_open: 마스터 read fd를 논블로킹으로 열고 poll(2)로 감싼다
let raw = /* master.as_raw_fd() dup */;
loop {
    if closed.load(Ordering::Relaxed) { break; }                 // ★ 의도적 종료면 즉시 탈출
    let mut pfd = libc::pollfd { fd: raw, events: libc::POLLIN, revents: 0 };
    let r = unsafe { libc::poll(&mut pfd, 1, 200) };             // 200ms 타임아웃
    if r == 0 { continue; }
    match reader.read(&mut buf) {
        Ok(0) => break,
        Ok(n) => { /* send */ }
        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,  // 발견 #6
        Err(_) => break,
    }
}
```
이렇게 하면 close 시 스레드가 즉시 종료 → 마스터 dup이 닫힘 → **커널이 pty 전경 프로세스 그룹에 SIGHUP을 보내는 안전망이 되살아나** 남은 고아 상당수가 자동 정리된다.
(c) `Ok(0)`/`Err` 경로에서 리더 스레드가 스스로 `state.terminals`에서 자기 엔트리를 제거하도록 AppHandle로 `app.state::<AppState>()`를 잡아 remove — 발견 #3도 같이 해결.

## [high/orphan] 플로팅 창 안에서 분할해 만든 PTY는 창을 닫아도 Rust가 죽이지 않는다 — 라벨에서 유추한 시드 paneId 하나만 정리
- 위치: `/home/generator/gitpervisor/src-tauri/src/lib.rs:425`  (서브시스템: terminal-pty)
- 유발: 패널 우클릭 → "새 창으로 분리 (Float)" 로 띄운 창 안에서 Ctrl+Shift+D/E 또는 우클릭 2/4/8 분할을 쓴 뒤, 그 창을 타이틀바 X로 닫기.
- 메커니즘: 1) `floatPane`은 메인 창 트리에서 패널을 떼고(detachTerminalKeepPty) `float-<paneId>` 라벨의 OS 창을 띄운다(stores/terminals.ts:367-408, lib/floating.ts:12).
2) 그 창 안에서 사용자는 Ctrl+Shift+D/E로 분할하거나(FloatingTerminal.tsx:110-111) 우클릭 메뉴로 2/4/8 그리드를 만들 수 있다 → **paneId가 창 라벨에 없는 새 PTY가 최대 7개까지** 생긴다.
3) 창을 OS X 버튼으로 닫으면 Rust의 `Destroyed` 훅은 `label.strip_prefix("float-")`로 얻은 **시드 term_id 하나만** close_session 한다(lib.rs:422-426).
4) 나머지 분할 PTY 정리는 JS `beforeunload` 안의 비동기 `invoke("term_close")`에 전적으로 의존한다(FloatingTerminal.tsx:120-129 — 주석에 "베스트 에포트"라고 명시). 웹뷰 파괴 중에 발사된 async IPC는 WebKitGTK에서 전달 보장이 없고, `disposeTerminal`의 `.catch(() => {})`(lib/terminal.ts:200)가 실패를 조용히 삼킨다.
5) 실패하면 그 PTY 세션은 **어떤 UI에서도 참조 불가능한 상태로 state.terminals에 영구 잔류** — 프론트 레지스트리에도 없고(창이 사라짐), 메인 창 트리에도 없다(floatPane이 removePane 했다). 앱 종료 전까지 절대 못 죽인다.
6) 부수 경로: `openFloatingWindow`가 실패하면(lib/floating.ts:15 `.catch(console.error)`) 이미 메인 트리에서 제거된 PTY가 똑같이 미아가 된다 — 창이 아예 안 뜨므로 사용자는 존재조차 모른다.
- 387개 설명가능: False
- 수정: 세션의 소유 창을 Rust가 알고 있어야 한다.
```rust
pub struct TerminalSession { /* ... */ owner: String }   // 웹뷰 라벨

#[tauri::command]
pub fn term_open(webview: tauri::Webview, /* ... */) -> Result<(), IpcError> {
    let owner = webview.label().to_string();
    /* ... */ TerminalSession { /* ... */ owner }
}
// term_attach도 동일하게 owner를 새 창 라벨로 갱신(플로팅 이관 반영)

// lib.rs Destroyed 훅
} else if label.starts_with("float-") {
    let state = window.state::<AppState>();
    let ids: Vec<String> = state.terminals.lock().unwrap()
        .iter().filter(|(_, s)| s.owner == label).map(|(k, _)| k.clone()).collect();
    for id in ids { commands::close_session(state.inner(), &id); }
}
```
추가로 `openFloatingWindow`를 await 하고 실패 시 detach를 되돌리거나(패널 복구) 즉시 `term_close` 하도록 stores/terminals.ts:407을 고칠 것.

## [high/thread] 리더 루프가 EINTR을 재시도 없이 break → 살아있는 셸에 블로킹 wait()로 child 뮤텍스를 영구 점유 → close_session이 terminals 전역 락을 쥔 채 메인 스레드에서 데드락
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:130`  (서브시스템: terminal-pty)
- 유발: SA_RESTART 없이 설치된 시그널 핸들러(GLib/GTK의 SIGCHLD 처리, 디버거 어태치, 일부 플러그인)가 리더 스레드에 시그널을 배달하는 순간. 사용자 입장에서는 "터미널이 갑자기 먹통이 되고 그 뒤로 새 터미널도 안 열림" 으로 나타난다. 앱 로그가 마지막 기록 후 32분간 무기록이었던 정황과 부합한다.
- 메커니즘: 1) 마스터 fd read는 `filedescriptor` 크레이트의 **생 `libc::read`**로, EINTR을 재시도하지 않고 그대로 Err로 올린다(filedescriptor-0.8.3/src/unix.rs:208-217).
2) 리더 루프는 모든 Err를 `Err(_) => break`로 삼킨다(terminal.rs:130). 시그널 한 번에 아직 **살아있는** 셸을 두고 루프를 빠져나온다.
3) 곧바로 `child.lock().unwrap().wait()`(terminal.rs:133-138) — 블로킹 wait이므로 그 셸이 죽을 때까지 **child 뮤텍스를 무한 점유**한다.
4) 이후 사용자가 그 탭을 닫으면 close_session이 `session.child.lock()`에서 영구 블록되는데, 문제는 그 시점에 **`state.terminals`의 MutexGuard를 쥐고 있다**는 것이다 — `if let Some(session) = state.terminals.lock().unwrap().remove(term_id) {` 의 임시 guard는 edition 2021에서 `if let` 본문 끝까지 산다(Cargo.toml:6 `edition = "2021"`).
5) → `state.terminals` 전역 뮤텍스가 영구 점유 → term_open/term_write/term_resize/term_close/term_project/kill_all 전부 영구 블록. 이 커맨드들은 전부 `async`가 아닌 `#[tauri::command]`라 Tauri v2에서 **메인(GTK) 스레드**에서 실행된다 → 앱 전체 프리즈.
6) 동시에 read가 멈춘 pty 버퍼가 차면 그 안의 자식들이 write에서 영구 블록되고, 앱 종료 시 kill_all마저 데드락되므로 **PTY가 하나도 정리되지 않은 채** 앱이 남는다.
- 387개 설명가능: False
- 수정: 1) EINTR 재시도 + 살아있는 자식에 블로킹 wait 금지:
```rust
Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
Err(_) => break,
```
2) `wait()`를 뮤텍스 밖 폴링으로:
```rust
let code = loop {
    match child.lock().unwrap().try_wait() {          // 락은 매 반복 즉시 해제
        Ok(Some(s)) => break s.exit_code() as i32,
        Ok(None) => std::thread::sleep(Duration::from_millis(50)),
        Err(_) => break -1,
    }
};
```
3) close_session에서 전역 락을 kill 전에 반드시 놓는다(발견 #7 fix와 동일한 `let` 분리).

## [medium/unbounded-growth] 셸이 스스로 종료해도 TerminalSession이 state.terminals에서 절대 제거되지 않는다 — 앱 수명 내내 마스터 fd/writer/맵 엔트리 무한 누적 (lsp.rs에 있는 리퍼가 여기엔 없음)
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:140`  (서브시스템: terminal-pty)
- 유발: 터미널에서 `exit` 입력, Ctrl+D, 셸 크래시. 사용자가 "프로세스가 종료되었습니다" 오버레이를 그냥 두고 다른 탭으로 넘어가면 그대로 적립된다. 탭 레이아웃은 localStorage(`gp:terminals`)로 영속되므로 앱 재시작마다 같은 패널이 되살아나 다시 셸을 띄운다.
- 메커니즘: 1) 셸이 정상 종료하면 리더 스레드가 EOF→wait→`term://exit` 이벤트만 쏘고 끝난다(terminal.rs:140-142). **맵에서 자기 엔트리를 지우지 않는다.**
2) 프론트는 그 이벤트로 패널을 `exited`로 표시할 뿐(lib/terminal.ts:37-41, stores/terminals.ts:484) `term_close`를 부르지 않는다. 사용자가 그 패널을 닫거나 "재시작"을 눌러야만 close_session이 돈다(TerminalPane.tsx:91).
3) 그때까지 `TerminalSession`이 통째로 살아있다 → `master`(pty 마스터 fd 1개) + `writer`(마스터 dup fd 1개) + Channel + 죽은 Child 구조체가 계속 점유된다.
4) `state.terminals`를 정리하는 코드는 close_session / kill_all / term_open 교체 셋뿐이고, **주기적 리퍼가 없다** — 같은 저장소의 lsp.rs는 REAPER_INTERVAL 60초 리퍼를 갖고 있는데 터미널에는 대응물이 없다.
5) 발견 #2와 결합하면 더 나쁘다: 자손이 슬레이브를 잡고 있으면 EOF가 안 와 exit 이벤트조차 안 나가고, 프론트는 죽은 세션을 영원히 "live"로 표시한다.
- 387개 설명가능: False
- 수정: 리더 스레드가 종료 시 스스로 엔트리를 제거한다. term_open에서 `AppHandle`을 이미 갖고 있으므로:
```rust
std::thread::spawn(move || {
    /* read loop ... */
    let code = /* try_wait 폴링 */;
    if !closed.load(Ordering::Relaxed) {
        // 자기 엔트리 회수 — 단, 같은 id로 이미 새 세션이 들어왔으면 건드리면 안 된다.
        if let Some(state) = app.try_state::<AppState>() {
            let mut map = state.terminals.lock().unwrap();
            if map.get(&term_id).map(|s| s.pid) == Some(my_pid) { map.remove(&term_id); }
        }
        let _ = app.emit("term://exit", TermExit { term_id, code });
    }
});
```
(pid 비교로 term_open 교체 레이스를 막는 것이 핵심 — closed 플래그만으로는 부족하다.)

## [medium/other] 종료된 세션의 sink가 해제되지 않아, 리더 스레드가 죽은 Channel로 고아 프로세스의 출력을 계속 IPC 전송한다 (CPU 상시 소모)
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:128`  (서브시스템: terminal-pty)
- 유발: 장기 실행 명령(dev 서버, watcher, 로그 tail)이 도는 패널을 닫은 뒤 그 고아가 계속 출력을 내는 모든 경우. 발견 #1·#2가 성립한 세션마다 자동으로 따라온다.
- 메커니즘: 1) close_session은 `closed` 플래그를 세우고 kill만 한다 — **sink는 건드리지 않는다**(terminal.rs:242-243).
2) 리더 스레드는 `sink`의 Arc 클론을 들고 있으므로 세션이 맵에서 제거된 뒤에도 Channel 객체가 살아있다.
3) 발견 #2로 스레드가 살아남은 상태에서 고아 dev 서버가 pty로 계속 로그를 뿜으면, 루프는 8KB씩 읽어 `sink.lock().unwrap().send(...)`로 **Tauri IPC를 통해 웹뷰까지 계속 전달**한다(terminal.rs:128).
4) 수신 측 xterm은 이미 dispose됐고 JS 핸들러는 try/catch로 예외만 삼킨다(terminal-engine.ts:453-458) — 즉 매 청크마다 Vec<u8> 할당 + 직렬화 + 메인 스레드 JS 실행이 순수 낭비로 반복된다.
5) 주석(terminal.rs:125-127)이 "send가 실패해도 PTY는 살린다"고 명시적으로 루프를 끊지 않게 설계돼 있어, 이 낭비는 설계상 무한히 지속된다.
- 387개 설명가능: False
- 수정: 의도적 종료 시 sink를 비워 전송 경로를 끊는다.
```rust
// TerminalSession
sink: Arc<Mutex<Option<Channel<Vec<u8>>>>>,

// 리더 루프
Ok(n) => {
    if let Some(ch) = sink.lock().unwrap().as_ref() { let _ = ch.send(buf[..n].to_vec()); }
    else if closed.load(Ordering::Relaxed) { break; }   // 소비자 없음 + 의도적 종료 → 즉시 탈출
}

// close_session
session.closed.store(true, Ordering::Relaxed);
*session.sink.lock().unwrap() = None;      // ★ 추가
```
발견 #2의 poll 기반 루프 탈출과 함께 적용하면 스레드가 즉시 종료돼 이 낭비가 원천 차단된다.

## [medium/other] close_session이 state.terminals 전역 락을 쥔 채 최대 200ms 잠자는 kill()을 호출한다 — 8분할 탭 닫기/앱 종료 시 메인 스레드가 최대 1.6초~N×200ms 정지
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:240`  (서브시스템: terminal-pty)
- 유발: 8분할한 탭 닫기, 프로젝트 제거(closeProjectTerminals가 프로젝트의 전 패널을 순회), 앱 종료(kill_all). 세션이 많이 쌓여 있을수록(=발견 #3으로 exited 엔트리가 누적될수록) 종료 훅이 길어진다.
- 메커니즘: 1) `if let Some(session) = state.terminals.lock().unwrap().remove(term_id) {` — edition 2021에서 scrutinee의 임시 MutexGuard는 `if let` **본문 끝까지** 산다. 즉 kill() 전체가 전역 락 아래에서 실행된다.
2) portable-pty의 kill()은 SIGHUP 후 `sleep(50ms)` × 4 = 최대 200ms 블록한다(lib.rs:347-356).
3) `term_close`는 `async`가 아닌 `#[tauri::command]`라 Tauri v2에서 메인(GTK) 스레드에서 실행된다 → UI가 그 시간만큼 멈춘다.
4) 8분할 탭을 닫으면 프론트가 8회 `disposeTerminal`을 연달아 호출한다(stores/terminals.ts:282) → 최대 1.6초 프리즈.
5) kill_all(terminal.rs:248-254)은 더 심하다 — 락을 한 번 잡고 drain 전체를 순회하며 세션마다 최대 200ms를 잔다. 세션 20개면 창 파괴 훅에서 4초. 그 사이 OS가 창을 강제 종료하면 뒤쪽 세션은 kill조차 못 받는다.
- 387개 설명가능: False
- 수정: 락을 먼저 놓고 죽인다. 그리고 kill을 메인 스레드에서 빼낸다.
```rust
pub fn close_session(state: &AppState, term_id: &str) {
    let session = state.terminals.lock().unwrap().remove(term_id);   // ← let 문: 여기서 guard 해제
    if let Some(session) = session {
        session.closed.store(true, Ordering::Relaxed);
        *session.sink.lock().unwrap() = None;
        let pid = session.pid;
        std::thread::spawn(move || terminate_session(pid));          // 메인 스레드 비점유
    }
}

pub fn kill_all(state: &AppState) {
    let sessions: Vec<_> = state.terminals.lock().unwrap().drain().map(|(_, s)| s).collect();  // 락 즉시 해제
    let handles: Vec<_> = sessions.into_iter().map(|s| {
        s.closed.store(true, Ordering::Relaxed);
        let pid = s.pid;
        std::thread::spawn(move || terminate_session(pid))           // 병렬 — 총 대기 200ms
    }).collect();
    for h in handles { let _ = h.join(); }
}
```
또한 `term_close`를 `#[tauri::command(async)]`로 바꿔 메인 스레드에서 완전히 뺄 것.

## [low/zombie] term_open의 spawn 이후 실패 경로(try_clone_reader / take_writer)가 이미 띄운 셸을 kill·wait 없이 버린다
- 위치: `/home/generator/gitpervisor/src-tauri/src/commands/terminal.rs:98`  (서브시스템: terminal-pty)
- 유발: fd 고갈(발견 #3의 fd 누수가 진행된 뒤 RLIMIT_NOFILE 근접 시 dup 실패) 또는 dup/ioctl 실패. 정상 상황에서는 거의 발생하지 않는다.
- 메커니즘: 1) 셸은 line 91-94에서 이미 spawn됐다.
2) 그 뒤 `try_clone_reader`(98-101) 또는 `take_writer`(102-105)가 실패하면 `?`로 즉시 return Err — **child에 대한 kill도 wait도 없다**.
3) `child`(std::process::Child)가 drop되지만 Rust의 Child::drop은 wait를 하지 않는다 → 셸이 죽더라도 회수되지 않아 좀비.
4) `pair.master`가 drop되면서 마스터 fd가 닫히므로 커널이 pty 전경 그룹에 SIGHUP을 보내 셸은 대개 죽는다(그래서 프로세스 자체는 대부분 정리된다). 하지만 회수해 줄 주체가 없어 좀비 1개가 남고, 셸이 SIGHUP을 무시하면 완전한 고아가 된다.
5) `take_writer`는 "두 번 호출하면 실패"하는 구조(portable-pty unix.rs:319-321)라 재시도 상황에서 실제로 Err이 날 수 있다.
- 387개 설명가능: False
- 수정: 실패 시 정리 후 반환하는 헬퍼로 감싼다.
```rust
let mut child = pair.slave.spawn_command(cmd).map_err(...)?;
drop(pair.slave);
let pid = child.process_id().unwrap_or(0) as i32;

macro_rules! bail_kill { ($e:expr) => { match $e { Ok(v) => v, Err(err) => { terminate_session(pid); return Err(err); } } }; }
let mut reader = bail_kill!(pair.master.try_clone_reader().map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 리더 생성 실패: {e}"))));
let writer  = bail_kill!(pair.master.take_writer().map_err(|e| IpcError::new(ErrorCode::Io, format!("PTY 라이터 생성 실패: {e}"))));
```

## [critical/orphan] 타임아웃 시 kill_on_drop이 직계 git만 SIGKILL — HTTPS remote helper 손자·증손자 2개가 앱 cgroup에 영구 잔류(고아)
- 위치: `src-tauri/src/git/runner.rs:139`  (서브시스템: git-tools-scheduler)
- 유발: ① 배경 fetch 스케줄러(fetch_scheduler.rs:73-95): 12개 레포 × 5분 주기 = 288 사이클/일 × 12 = 3,456회/일. 타임아웃 FETCH_TIMEOUT_SECS=45(:24). 사용자 개입 없이 상시.
② 사용자 push/pull/fetch 버튼 → run_git_streaming(NETWORK_TIMEOUT_SECS=120).
③ 특히 치명적인 트리거: **노트북 절전/복귀, Wi-Fi 전환, VPN on/off** — 진행 중이던 fetch가 한꺼번에 스톨해 12개 레포가 동시에 45초 타임아웃 → 1회 이벤트로 최대 24개 고아.
- 메커니즘: 1) run_git_env가 `cmd.kill_on_drop(true)`(runner.rs:139)로 git을 spawn(:149).
2) `tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())`(:154)이 만료되면 future가 drop → tokio `ChildDropGuard::drop`(tokio-1.52.3/src/process/mod.rs:1122-1128) → `Kill for Child` → `std::process::Child::kill()` → `libc::kill(pid, SIGKILL)`. **직계 PID 1개에만 신호가 간다.**
3) 그런데 HTTPS 원격의 `git fetch/pull/push`는 2단 헬퍼를 fork한다. 실측 프로세스 트리:
   837386 `git fetch --quiet origin`            ← 직계(SIGKILL 대상)
   837388 `/usr/lib/git-core/git remote-https origin <url>`  ← 손자
   837389 `/usr/lib/git-core/git-remote-https origin <url>`  ← 증손자
4) 직계를 SIGKILL 하면 손자·증손자는 살아남아 ppid=1112(user systemd 서브리퍼)로 재부모화되지만 **cgroup은 그대로 유지된다** — 실측으로 kill 전후 `/proc/<pid>/cgroup`가 동일함을 확인했다. 앱의 경우 그 cgroup이 `app-gnome-Gitpervisor-3074382.scope`이고 systemd-oomd는 cgroup 단위로 죽이며 그 안의 PID를 센다. 즉 387개에 그대로 포함된다.
5) git은 HTTP에 기본 타임아웃이 없다(`http.lowSpeedLimit`/`http.lowSpeedTime` 미설정). 연결이 블랙홀이면 helper는 무한 대기한다 — 실측에서 non-routable 주소(10.255.255.1)로 건 helper 2개가 부모 SIGKILL 후에도 계속 살아 있었다.
6) tokio는 자기가 만든 직계만 orphan queue에 넣어 reap 하므로 좀비는 안 생기지만, 손자·증손자는 **회수 주체 자체가 존재하지 않는다**. 앱 코드 전체 grep 결과 `process_group`/`setsid`/`pre_exec`/`killpg` 0건 — 프로세스 그룹을 만들지 않는다.
7) 동일 결함이 run_git_with_stdin(:196), run_git_streaming(:261), tools/runner.rs:207 에도 그대로 있다(ruff/biome는 자식을 안 fork해 영향 미미).
- 387개 설명가능: True
- 수정: (1) 자식을 프로세스 그룹 리더로 만들고 타임아웃 시 그룹 전체를 kill 한 뒤 반드시 wait 한다. runner.rs의 네 spawn 지점(139/196/261)과 tools/runner.rs:207에 동일 적용:
```rust
#[cfg(unix)]
{
    use std::os::unix::process::CommandExt;
    cmd.process_group(0); // setpgid(0,0) — Rust 1.64+
}
#[cfg(windows)]
cmd.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP

let mut child = cmd.spawn().map_err(...)?;
let pid = child.id().expect("just spawned") as i32;
match tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
    Ok(r) => r.map_err(...),
    Err(_) => {
        #[cfg(unix)]
        unsafe { libc::killpg(pid, libc::SIGKILL); } // 손자·증손자까지 전부
        let _ = child.wait().await;                  // 직계 reap (좀비 방지)
        Err(IpcError::new(ErrorCode::Timeout, format!("git {} 시간 초과 ({timeout_secs}초)", args.first().unwrap_or(&""))))
    }
}
```
`kill_on_drop(true)`는 안전망으로 유지하되 주 경로는 명시적 killpg여야 한다.

(2) git 자체에도 네트워크 타임아웃을 건다 — 애초에 타임아웃 경로로 안 가게. fetch_scheduler.rs:246의 args에 추가:
```rust
let mut args: Vec<&str> = vec![
    "-c", "credential.interactive=false",
    "-c", "http.lowSpeedLimit=1000",   // 1KB/s 미만이
    "-c", "http.lowSpeedTime=20",      // 20초 지속되면 git이 스스로 종료
    "fetch", "--quiet",
];
```
SSH 원격을 쓰는 사용자를 위해 :253의 GIT_SSH_COMMAND도 `"ssh -oBatchMode=yes -oConnectTimeout=10 -oServerAliveInterval=10 -oServerAliveCountMax=3"`로 강화.

(3) (선택) 앱 시작 시 방어적 청소: 자기 cgroup 안에 남은 `git-remote-*` 고아를 부팅 시 1회 정리하는 스윕. 근본 해결은 아니지만 기존 설치본 피해를 줄인다.

## [critical/memory] 워처가 node_modules/target/.git까지 재귀 inotify watch — is_relevant는 이벤트 수신 후 필터라 watch 자체는 전부 걸린다(실측 16만+ watch)
- 위치: `src-tauri/src/watcher.rs:65`  (서브시스템: git-tools-scheduler)
- 유발: 앱 시작 시 12개 레포 등록(lib.rs:283-289의 백그라운드 스레드 → watcher::register). **사용자 행동 불필요, 상시 상주.** 이벤트 폭주는 사용자가 cargo build / npm install / AI CLI 실행 등으로 target·node_modules를 갈아엎을 때. 앱이 10일간 계속 떠 있었으므로 이 비용은 10일 내내 부과됐다.
- 메커니즘: 1) `debouncer.watch(path, RecursiveMode::Recursive)`(watcher.rs:65) — 레포 루트 아래 **모든 디렉토리**에 inotify watch를 건다. notify의 inotify 백엔드는 재귀 모드에서 디렉토리 1개당 watch 1개를 등록하고, 새 디렉토리가 생기면 watch를 추가한다.
2) `IGNORED_DIRS`(watcher.rs:86-105)와 `is_relevant`(watcher.rs:109-137)는 **디바운서 콜백 안**(watcher.rs:41-44)에서 경로 문자열을 보고 버린다. 즉 커널 watch 등록 → 이벤트 배달 → PathBuf 할당 → 디바운스 큐 삽입이 **전부 끝난 뒤에** 필터링한다. watch를 안 거는 게 아니다.
3) 실측 디렉토리 수(12개 중 7개만 셈): aickyway 126,974(그중 125,301이 무시 대상 하위), gitpervisor 9,219(9,162), devway 7,876(7,246), convizard 6,283(5,948), devlog 5,984(5,436), erdway 5,209(5,077), freeway 2,921(2,658). 합계 **164,466개 디렉토리 중 160,828개(97.8%)가 node_modules/target/.git/dist/build/.venv/.next 내부**다. 나머지 5개 레포까지 포함하면 20만~30만 watch로 추정된다.
4) 커널의 inotify watch 1개는 inotify_inode_mark + 고정되는 inode/dentry로 대략 1KB. 16만 watch ≈ 160MB+, 전체로는 200~300MB. **cgroup v2에서 커널 메모리는 memory.current에 산입**되므로 systemd-oomd의 압박 판정에 그대로 들어간다. 여기에 notify 유저스페이스의 WatchDescriptor→PathBuf 맵(수십 MB)이 더해진다.
5) CPU: cargo build / npm install / AI CLI가 target·node_modules를 갈아엎을 때마다 초당 수천 개 이벤트가 inotify 스레드 → 디바운서 스레드로 흘러 PathBuf를 할당하고 큐에 넣었다가 400ms 뒤 is_relevant에서 폐기된다. 12개 워처가 동시에 이 짓을 한다. "10일 벽시계에 CPU 4일치(1코어 40% 상시)"의 주 소모원으로 가장 유력하다.
6) 저널에 `[watcher] watch 실패` / `[watcher] 생성 실패` 가 단 한 줄도 없다 → `fs.inotify.max_user_watches=524288` 한도에 걸리지 않았다 = **정말로 그 watch를 전부 들고 있었다**는 증거다.
- 387개 설명가능: False
- 수정: 무시 대상은 **watch 자체를 걸지 않는다**. 루트 재귀 대신 IGNORED_DIRS를 prune 하며 걸어 내려가 개별 등록:
```rust
fn watch_filtered(d: &mut RepoWatcher, root: &Path) -> notify::Result<()> {
    // .git은 상태 마커만 필요 — 통짜 재귀 금지(objects/가 수만 개다)
    d.watch(root, RecursiveMode::NonRecursive)?;
    let g = root.join(".git");
    if g.is_dir() {
        d.watch(&g, RecursiveMode::NonRecursive)?;          // HEAD/index/MERGE_HEAD/ORIG_HEAD...
        let refs = g.join("refs");
        if refs.is_dir() { d.watch(&refs, RecursiveMode::Recursive)?; }
    }
    // 워크트리는 IGNORED_DIRS를 prune 하며 DFS, 각 디렉토리를 NonRecursive로 등록
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let name = e.file_name();
            let n = name.to_string_lossy();
            if n == ".git" || IGNORED_DIRS.contains(&n.as_ref()) { continue; } // ← watch 안 검
            let p = e.path();
            d.watch(&p, RecursiveMode::NonRecursive)?;
            stack.push(p);
        }
    }
    Ok(())
}
```
이것만으로 실측 164,466 → 3,638개(97.8% 감소)가 된다.
주의: NonRecursive 개별 등록은 새로 생긴 디렉토리를 자동으로 안 잡으므로, 콜백에서 `EventKind::Create(Folder)`를 받으면 그 경로가 IGNORED_DIRS가 아닐 때만 `d.watch(..., NonRecursive)`로 증분 등록해야 한다.
더 정확히 가려면 `ignore` 크레이트의 `WalkBuilder`(.gitignore 존중)로 순회해 gitignore된 디렉토리를 통째로 prune 하는 방법도 있다 — 어차피 gitignore된 파일은 git status에 안 잡히므로 감시할 이유가 없다.

## [high/unbounded-growth] 설정 마이그레이션이 사용자가 꺼둔 배경 fetch를 5분으로 되살림 — 10일간 34,560회 fetch가 위 고아 누수의 증폭기
- 위치: `src-tauri/src/state.rs:131`  (서브시스템: git-tools-scheduler)
- 유발: 앱 시작 시 설정 로드(lib.rs:134 `state::load_settings(app.handle())`). 사용자 개입 불필요 — 오히려 사용자가 끄려고 시도했는데도 켜진다. 앱이 10일간 상주했으므로 10일 내내 5분 주기로 돌았다.
- 메커니즘: 1) 디스크의 실제 설정 파일 `~/.local/share/com.greathoon.gitpervisor/settings.json` 에는 `"autoFetchMinutes": 0` 만 있고 `remoteRefreshMinutes` 키가 아예 없다 — 사용자가 자동 fetch를 **명시적으로 껐다**는 뜻이다.
2) `Settings`는 `#[serde(rename_all = "camelCase", default)]`(git/types.rs:194)이므로 없는 필드는 `Settings::default()`에서 채워진다 → `remote_refresh_minutes: 5`(git/types.rs:244).
3) state.rs:131의 마이그레이션은 `remoteRefreshMinutes`가 없을 때 `autoFetchMinutes`를 승계하는데 조건이 **`if old > 0`** 이다. 0(=끔)은 승계 대상에서 빠지고 방금 채워진 기본값 5가 그대로 남는다. 결과: 사용자의 "끔" 이 "5분마다 켬"으로 뒤집힌다.
4) 게다가 마이그레이션 후 저장을 하지 않으므로(save_settings 호출 없음) 이 뒤집힘이 **매 부팅마다 재적용**된다. 디스크의 settings.json이 아직도 구 스키마인 것이 그 증거다.
5) 그래서 fetch_scheduler.rs:84의 `if minutes == 0 { continue; }` 가드가 절대 발동하지 않고, 30초 틱이 5분마다 전체 사이클을 돌린다 → 12레포 × 288사이클/일 = **3,456 fetch/일 = 10일간 34,560회**. HTTPS 헬퍼 체인 3개씩이면 약 10만 프로세스 spawn.
6) 이 자체는 누수가 아니지만(정상 종료되면 남지 않는다) 위 F1(고아 헬퍼)의 발생 확률에 그대로 곱해지는 볼륨 증폭기다. 사용자가 끄려 했던 기능이 이 볼륨을 만들어 냈다는 점이 특히 나쁘다.
- 387개 설명가능: False
- 수정: (1) 0을 정상 값으로 승계한다:
```rust
if value.get("remoteRefreshMinutes").is_none() {
    if let Some(old) = value.get("autoFetchMinutes").and_then(|v| v.as_u64()) {
        settings.remote_refresh_minutes = old as u32;  // 0(끔)도 그대로 승계
    }
}
```
(2) 마이그레이션 직후 1회 `save_settings(app, &settings)` 를 호출해 신 스키마로 확정한다 — 지금은 매 부팅 재적용되고 있고, 저장 시점이 오기 전까지 사용자가 UI에서 본 값과 실제 동작이 어긋난다.
(3) 방어적으로 fetch_scheduler.rs:84 근처에 시작 시 1회 `log::info!("배경 fetch 주기: {minutes}분")`을 남겨, 이런 무음 뒤집힘이 다음엔 로그로 잡히게 한다(현 로그는 6/25~8/1 통틀어 160줄뿐이라 이런 상태 전이가 전혀 안 보인다).

## [medium/other] tools::runner::find_on_path — 캐시 없는 블로킹 `sh -c command -v` 를 lint/format 매 호출마다 실행(git 쪽 OnceLock 캐시와 비대칭)
- 위치: `src-tauri/src/tools/runner.rs:122`  (서브시스템: git-tools-scheduler)
- 유발: 에디터(DiffViewer 파일 뷰)에서 .py/.pyi/.ts/.tsx/.js/.jsx/.mjs/.cjs 파일을 편집할 때 타이핑 정지 500ms마다. 포맷(Shift+Alt+F / 저장 시 포맷)과 `format_tool_status` 조회에서도 같은 경로를 탄다.
- 메커니즘: 1) `discover()`(tools/runner.rs:142-191)는 설정 명시 경로가 없고 프로젝트 로컬 옵트인도 꺼져 있으면(기본) 매 호출마다 ③단계 `find_on_path(tool.exe_name())`(:169)를 탄다.
2) `find_on_path`는 **동기 `std::process::Command`** 로 `sh -c "command -v ruff"` 를 실행한다(:122-125). `.output()`이므로 내부에서 waitpid 하고, 좀비도 고아도 남지 않는다 — **누수는 아니다.**
3) 문제는 호출 문맥이다. 이 함수는 `#[tauri::command] async fn lint_file`(commands/lint.rs:70)과 `format_source`(commands/format.rs:75) 안에서 호출되므로 **tokio 워커 스레드를 fork+exec+wait 동안 통째로 블록**한다. 워커 수는 CPU 코어 수뿐이다.
4) git 쪽은 같은 일을 `static GIT_PATH: OnceLock<Option<PathBuf>>`(git/runner.rs:30)로 프로세스 수명 동안 1회만 하는데(:43 `GIT_PATH.get_or_init(find_git)`), tools 쪽만 캐시가 없다 — 명백한 비대칭이다.
5) 프론트 트리거 빈도가 높다: DiffViewer.tsx:216-218이 타이핑이 멈춘 뒤 500ms 디바운스로 `lint_file`을 쏜다. .py/.ts/.tsx/.js 파일을 편집하는 내내 초당 1~2회 `sh` + `ruff`/`biome` 프로세스가 새로 뜬다.
6) 부수적으로, 도구가 설치돼 있지 않으면(이 시스템은 ruff/biome 미설치) 매번 `sh`만 띄우고 None을 받아 조용히 스킵한다 — 순수 낭비다.
- 387개 설명가능: False
- 수정: git_path()와 동형으로 캐시하고, 애초에 `sh` spawn을 없앤다:
```rust
use std::sync::{OnceLock, RwLock};
use std::collections::HashMap;

static TOOL_PATHS: OnceLock<RwLock<HashMap<&'static str, Option<PathBuf>>>> = OnceLock::new();

fn find_on_path(name: &'static str) -> Option<PathBuf> {
    let cache = TOOL_PATHS.get_or_init(Default::default);
    if let Some(hit) = cache.read().unwrap().get(name) { return hit.clone(); }
    // sh 없이 PATH 직접 순회 — 프로세스 spawn 자체를 제거
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join(name))
            .find(|p| is_real_exe(p))
    });
    cache.write().unwrap().insert(name, found.clone());
    found
}
```
(Windows는 `PATHEXT` 순회로 `.exe`만 허용해 기존 `.cmd`/`.bat` 배제 정책을 유지.)
설정에서 도구 경로를 바꿨을 때를 위해 set_settings 시 이 캐시를 clear 하는 훅을 하나 붙인다.

## [low/other] refresh_remotes 스로틀이 TOCTOU — 포커스 연타 시 fetch 사이클이 겹쳐 동시 git 상한(3)이 무력화될 수 있음
- 위치: `src-tauri/src/fetch_scheduler.rs:110`  (서브시스템: git-tools-scheduler)
- 유발: 창 포커스 전환 연타. 특히 플로팅 터미널 창(`float-*`)·리소스 모니터 창(`sysmon`)을 오갈 때, 또는 컨텍스트 메뉴의 수동 새로고침(ProjectList.tsx:323 `refreshRemotes([project.id], true)` — force=true라 스로틀을 아예 우회하고 LAST_CYCLE도 안 건드린다).
- 메커니즘: 1) `refresh_remotes`는 LAST_CYCLE을 **읽어서만** 60초 스로틀을 판정하고(fetch_scheduler.rs:110-118), 통과하면 곧바로 `tauri::async_runtime::spawn(run_cycle(app, only, force))`(:120)로 던지고 즉시 반환한다.
2) LAST_CYCLE 갱신은 spawn된 `run_cycle` 안(:141-142)에서야 일어난다 — 판정(read)과 갱신(write)이 서로 다른 락 획득이라 비원자적이다.
3) 프론트는 창 focus 이벤트마다 `ipc.refreshRemotes([], false)`를 무조건 쏜다(src/lib/events.ts:36-40, 주석에 "스로틀은 백엔드 소관이라 여기서는 그냥 쏜다"). 메인 창 + 플로팅 터미널 창 + sysmon 창 사이를 빠르게 오가면 여러 호출이 같은 낡은 LAST_CYCLE을 보고 전부 통과할 수 있다.
4) 겹친 사이클은 각자 **새 Semaphore(3)** 를 만들므로(:176) 동시 git fetch 상한이 3 → 3N으로 늘어난다. 설계 의도("수십 프로젝트여도 네트워크 폭주 없음", :25-26)가 깨진다.
5) 다만 `fetch_one`이 진입 즉시 `state.try_begin_op(project_id)`(:199)로 레포당 1개를 강제하고 실패 시 조용히 반환하므로, 실효 중복은 대부분 흡수된다. 그래서 low로 둔다. 누수는 아니고 F1의 노출 빈도를 조금 올리는 정도다.
- 387개 설명가능: False
- 수정: 판정과 갱신을 하나의 락 구간에서 원자적으로 처리하고, 사이클 시작을 미리 예약한다:
```rust
if project_ids.is_empty() {
    let mut last = LAST_CYCLE.lock().unwrap();
    if !force && last.is_some_and(|t| t.elapsed() < Duration::from_secs(FOCUS_RATE_LIMIT_SECS)) {
        return Ok(());
    }
    *last = Some(Instant::now());   // 락을 든 채 즉시 예약 → 후속 호출은 전부 스로틀에 걸림
}
```
그러면 run_cycle 내부의 :141-142 갱신은 제거하거나 사이클 "종료" 시각 기록으로 의미를 바꾼다.
더 견고하게는 전역 `static CYCLE_RUNNING: AtomicBool` 을 두어 `compare_exchange`로 사이클을 단일화하고, Semaphore도 사이클마다 새로 만들지 말고 전역 `static SEM: OnceLock<Semaphore>` 하나를 공유해 동시 git 상한 3을 프로세스 전역으로 보장한다.

## [critical/zombie] lib.rs on_new_window이 메인 웹뷰의 모든 window.open을 상한 없이 xdg-open으로 위임 — Child를 wait하지 않아 호출마다 영구 좀비 1개
- 위치: `src-tauri/src/lib.rs:257`  (서브시스템: lifecycle-monitor)
- 유발: 메인 창 웹뷰에서 발생하는 모든 http(s) 팝업 시도. 구체적으로 (a) 로컬 .html 프리뷰(commit 7d29e84 "로컬 .html 앱 내 브라우저 프리뷰")를 iframe으로 띄운 페이지가 window.open을 호출할 때, (b) 마크다운/릴리스노트/README 렌더 안의 target=_blank 링크 클릭, (c) 업데이터 릴리스노트나 외부 링크 클릭, (d) 프리뷰 페이지의 광고·리다이렉트·분석 스크립트가 자동으로 window.open을 도는 경우(루프면 초당 수십 개도 가능). 사용자 클릭 1회당 최소 1개.
- 메커니즘: 1) 메인 웹뷰(또는 그 안의 localhost 프리뷰 iframe)에서 window.open / target=_blank / JS 리다이렉트가 발생한다. 2) wry가 lib.rs:257의 on_new_window 클로저를 호출한다. 3) 스킴이 http|https면 무조건 commands::open_external(url) 실행 후 Deny. 4) open_external의 Linux 구현(browser.rs:167-169)은 `let _ = std::process::Command::new("xdg-open").arg(url).spawn();` — 반환된 std::process::Child를 그 자리에서 drop한다. 5) std::process::Child에는 Drop 구현이 없다(표준 라이브러리 문서화된 동작: kill도 wait도 하지 않는다). 앱에 SIGCHLD 핸들러도 reaper 스레드도 없다. 6) xdg-open(=/bin/sh 스크립트)이 gio/브라우저를 띄우고 즉시 종료하면 **exit status를 회수할 부모가 영원히 없어 <defunct> 좀비로 프로세스 테이블에 남는다**. 7) 좀비는 앱 프로세스가 죽을 때까지 해제되지 않고, systemd cgroup.procs에 계속 계수된다 → oomd의 "killed N process(es)" 카운트에 그대로 포함된다.
- 387개 설명가능: True
- 수정: (1) 즉시 조치 — open_external을 회수하는 형태로 바꾼다. 가장 단순한 정답은 스폰 즉시 wait하는 detach 스레드:
  #[cfg(all(unix, not(target_os = "macos")))]
  pub(crate) fn open_external(url: &str) {
      let url = url.to_string();
      std::thread::spawn(move || {
          if let Ok(mut c) = std::process::Command::new("xdg-open")
              .arg(&url)
              .stdin(std::process::Stdio::null())
              .stdout(std::process::Stdio::null())
              .stderr(std::process::Stdio::null())
              .spawn()
          {
              let _ = c.wait(); // 좀비 회수 — 이 한 줄이 핵심
          } else {
              log::warn!("xdg-open 실행 실패: {url}");
          }
      });
  }
더 나은 대안: tauri_plugin_opener(또는 tokio::process::Command + kill_on_drop)로 교체해 회수를 런타임에 위임한다. git/runner.rs가 이미 tokio::process 방식으로 올바르게 처리하고 있으므로 같은 규약으로 통일하는 게 일관적이다.
(2) 호출 측 방어 — lib.rs:257에 브라우저와 동일한 상한/스로틀을 건다. 예: `static LAST_EXT: Mutex<Option<Instant>>` 로 1초 이내 중복 호출 무시 + `AtomicUsize` 로 세션당 상한(예: 200) 초과 시 log::warn 후 Deny만 반환. 프리뷰 iframe이 폭주해도 프로세스가 무한 증식하지 않는다.
(3) 로그 — open_external 호출 시 log::info!("외부 열기: {url}")를 남긴다. 지금 로그로는 이 경로가 몇 번 돌았는지 사후에 알 방법이 전혀 없다(발견 5 참조).

## [critical/orphan] 앱 종료 정리 훅이 '메인 창 Destroyed' 단 한 경로에만 있음 — restart/시그널 종료 시 전 자식이 고아화
- 위치: `src-tauri/src/lib.rs:406`  (서브시스템: lifecycle-monitor)
- 유발: (a) 설정 화면에서 업데이트 설치 → 자동 relaunch (updater.ts:120). (b) GNOME 로그아웃/재부팅/세션 종료 시 SIGTERM. (c) systemd-oomd·OOM killer·수동 kill. (d) 메인 창을 닫았는데 float-* 플로팅 터미널 창이 열려 있어 프로세스가 계속 사는 경우. 이번 장애는 (c)라 어떤 훅으로도 못 막지만, 이 결함 때문에 (a)(b)로 이미 만들어진 고아가 scope에 누적돼 있었을 가능성이 크다.
- 메커니즘: 1) 정리 코드는 lib.rs:406-428 `on_window_event`의 `WindowEvent::Destroyed` + `label == "main"` 조건 안에만 존재한다(kill_all/lsp_kill_all/browser_kill_all/popup_kill_all + sysmon close). 2) lib.rs:429는 `.run(tauri::generate_context!())`로 끝난다 — `.build()?.run(|app, event| ...)` 형태가 아니므로 `RunEvent::Exit`/`ExitRequested` 훅이 아예 없다. 3) SIGTERM/SIGHUP 핸들러도 없다(전역 훅은 패닉 훅 하나뿐, lib.rs:26-50). 4) 따라서 다음 경로들은 정리 없이 종료한다: (a) 업데이터 `relaunch()` → AppHandle::restart() → cleanup_before_exit() — tauri-2.11.2/src/app.rs:1100-1112에서 확인했듯 리소스 테이블만 clear하고 Destroyed를 emit하지 않는다, (b) GNOME 세션 로그아웃/재시작의 SIGTERM, (c) lib.rs:435의 std::process::exit(1), (d) 외부 kill. 5) 이때 PTY 셸·LSP 서버·브라우저 자식 웹뷰 프로세스가 전부 부모 없이 살아남는다. 6) restart 경로는 특히 나쁘다 — 새 인스턴스가 **같은 systemd scope(app-gnome-Gitpervisor-<pid>.scope)** 안에서 시작하므로 이전 세대의 고아가 같은 cgroup에 그대로 누적되고, 새 세대가 자기 자식을 또 만든다.
- 387개 설명가능: False
- 수정: (1) `.run(...)`을 `.build(tauri::generate_context!())?` + `.run(|app, event| { ... })`로 바꾸고 `RunEvent::ExitRequested`/`RunEvent::Exit`에서 동일한 정리 4종을 호출한다. 정리 로직을 `fn shutdown_children(app: &AppHandle)` 하나로 추출해 Destroyed 핸들러와 RunEvent 핸들러가 같은 함수를 부르게 하고, 재진입 방지는 `static DONE: AtomicBool`로 건다(두 경로가 모두 탈 수 있음).
(2) Unix에서 SIGTERM/SIGHUP/SIGINT 핸들러를 등록해(signal-hook 또는 tokio::signal) 같은 shutdown_children을 부른 뒤 exit한다. Linux 배포(.deb/GNOME 세션)에서 로그아웃 시 고아를 없앨 유일한 방법이다.
(3) 업데이터 경로 보강 — updater.ts:120의 `relaunch()` 직전에 명시적 정리 커맨드(예: `shutdown_children`을 노출한 tauri 커맨드)를 await한 뒤 relaunch한다. restart()가 Destroyed를 emit하지 않는 것은 tauri 쪽 사양이므로 앱이 스스로 챙겨야 한다.
(4) lib.rs:416 부근에 float-* 창도 닫는 루프를 추가한다:
  for (label, w) in window.app_handle().webview_windows() {
      if label.starts_with("float-") || label == "sysmon" { let _ = w.close(); }
  }
(5) 정리 각 단계를 개별로 감싸 하나가 패닉해도 나머지가 돌게 한다(현재는 kill_all이 Mutex poison 등으로 패닉하면 lsp_kill_all·browser_kill_all이 통째로 스킵된다). 각 단계 전후에 log::info!로 결과(정리한 개수)를 남긴다.

## [high/other] monitor.rs 프로세스 스냅샷이 메인 스레드에서 전체 /proc를 O(N) 스캔 + 전 표본 딥카피 — 프로세스가 불어날수록 비용이 커지는 악순환
- 위치: `src-tauri/src/monitor.rs:230`  (서브시스템: lifecycle-monitor)
- 유발: '리소스 모니터' 팝업 창(open_sysmon_window, lib.rs:137-162)을 열어둔 상태. 이 창은 라벨 "sysmon" 싱글턴이고 refetchIntervalInBackground:true라 **비포커스여도 계속 폴링**한다(visibilityState가 visible이기만 하면 됨 — 최소화만 멈춘다). 정확히 '앱이 이상해서 리소스를 지켜보는' 사용자 행동이 이 경로를 상시화한다.
- 메커니즘: 1) `sys_process_snapshot`은 `async`가 아닌 동기 `#[tauri::command]`다(monitor.rs:493-505). tauri-macros-2.6.3/src/command/wrapper.rs:264-266 기준 비동기가 아닌 커맨드는 ExecutionContext::Blocking(kind="sync")으로 생성돼 **IPC 핸들러(메인 이벤트 루프 스레드)에서 그대로 실행된다** — 워커 스레드로 안 넘어간다. 2) 매 틱 `refresh_processes_specifics(ProcessesToUpdate::All, true, cpu+memory+exe+disk_usage)`가 시스템의 **모든** PID에 대해 /proc/PID/stat, /proc/PID/statm, /proc/PID/io, readlink /proc/PID/exe 를 읽는다. 3) 이어서 monitor.rs:243-266이 프로세스마다 `name.to_string_lossy().into_owned()` + `exe().map(|e| e.display().to_string())` 로 **String 2개를 새로 할당**해 Vec을 통째로 재구성한다. 4) monitor.rs:370의 `self.procs.clone()`이 그 Vec을 다시 **딥카피**한다(그룹 모드가 아니어도 매 틱). 5) 정렬 후 200개로 자르고 JSON 직렬화해 IPC로 넘긴다. 6) 프론트는 2초 간격 폴링이다(src/queries/index.ts:257 refetchInterval: visible ? 2000 : false, limit=200 index.ts:237). 7) 결과: 앱이 만든 좀비/고아 때문에 시스템 PID 수 N이 커질수록 **틱당 파일 오픈 수·할당 수·정렬 비용이 선형으로 증가**하고, 그 비용이 전부 UI 스레드에 부과된다. 프로세스 800개면 틱당 대략 3~4천 회의 /proc 오픈 + 1,600회 String 할당 × 2(clone) 이 2초마다 반복된다. 누수를 관측하려고 켜 둔 창이 누수의 대가를 가장 크게 치르는 구조다.
- 387개 설명가능: False
- 수정: (1) `sys_process_snapshot`과 `sys_metrics`를 `async fn`으로 바꾼다 — tauri-macros 규약상 async면 워커/스레드풀로 나가 메인 이벤트 루프를 막지 않는다(내부 Mutex는 그대로 유지 가능하되, std Mutex를 await 넘어 들고 있지 않도록 lock 스코프를 좁힌다).
(2) `self.procs.clone()`(monitor.rs:370) 제거 — 비그룹 모드에서는 인덱스 Vec<usize>를 정렬해 상위 limit개만 클론하면 된다. 800개 중 200개만 필요한데 800개를 전부 복사할 이유가 없다.
(3) exe_path를 매 틱 재할당하지 말고 pid→Arc<str> 캐시로 둔다(sysinfo가 OnlyIfNotSet으로 이미 캐시하므로 우리 쪽 String만 줄이면 된다).
(4) `.with_disk_usage()`를 정렬 기준이 Disk일 때만 켠다 — /proc/PID/io는 프로세스당 추가 오픈이고, 다른 정렬에서는 쓰이지도 않는 값이다.
(5) 프로세스 수 상한/경보를 넣는다: 스냅샷 시 `self.sys.processes().len()`이 임계(예: 400)를 넘으면 log::warn!으로 남긴다. 이 한 줄만 있었어도 387개가 쌓이는 과정이 로그에 남았다.

## [medium/other] sys_metrics가 2초마다 Disks 목록 전체를 새로 구축 — 메인 스레드에서 전 마운트 statvfs
- 위치: `src-tauri/src/monitor.rs:164`  (서브시스템: lifecycle-monitor)
- 유발: 앱 메인 창이 포커스된 모든 시간(타이틀바 게이지). 즉 사용자가 앱을 쓰는 내내 상시.
- 메커니즘: 1) 타이틀바가 2초 간격으로 sys_metrics를 폴링한다(src/queries/index.ts:226 refetchInterval: 2000). 2) 이 역시 동기 커맨드(monitor.rs:486-489)라 메인 이벤트 루프에서 실행된다. 3) collect() 안에서 매 호출 `Disks::new_with_refreshed_list()`로 **디스크 목록 객체를 통째로 새로 만든다** — /proc/mounts 파싱 + 마운트마다 statvfs. Ubuntu/GNOME 환경은 snap loop 마운트만으로도 마운트 수십 개가 기본이다. 4) 마운트 정보는 거의 변하지 않는데도 30초에 15번, 하루 43,200번 재구축한다. 5) 더 위험한 것은 블로킹이다 — NFS/sshfs/끊긴 네트워크 마운트가 하나라도 있으면 statvfs가 수십 초 멈추고, 그동안 **메인 이벤트 루프 전체가 정지**한다(창이 '응답 없음').
- 387개 설명가능: False
- 수정: Disks 인스턴스를 Monitor 필드로 승격해 재사용하고, 목록 갱신 주기를 분리한다:
  struct Monitor { ..., disks: Disks, last_disk_list: Option<Instant> }
  // collect() 안에서:
  if self.last_disk_list.map_or(true, |t| t.elapsed() > Duration::from_secs(60)) {
      self.disks.refresh_list();          // 마운트 목록 재열거는 60초에 1번
      self.last_disk_list = Some(Instant::now());
  }
  self.disks.refresh();                   // 용량 수치만 갱신
대상 볼륨(root) 선택 결과도 함께 캐시해 매 틱 재탐색을 없앤다. 아울러 sys_metrics도 async로 전환해 메인 스레드에서 뺀다(발견 3의 (1)과 동일 조치).

## [medium/other] 로그 설정이 사후 진단을 불가능하게 함 — 전역 Info 필터로 zbus 노이즈가 52%, 앱 자신의 로그는 5주간 9줄
- 위치: `src-tauri/src/lib.rs:212`  (서브시스템: lifecycle-monitor)
- 유발: 상시(설정 문제). 관측 실패는 장애가 터진 뒤에야 드러난다.
- 메커니즘: 1) lib.rs:212-218이 `tauri_plugin_log::Builder::new().level(log::LevelFilter::Info)`로 **전역 최대 레벨만** 설정하고 `.level_for(target, level)`로 크레이트별 필터를 걸지 않는다. 2) 그 결과 zbus/tracing이 내부 SASL 핸드셰이크를 INFO 스팬으로 뱉는 것이 그대로 파일에 들어간다(알림 1건당 6줄, 바이트 배열까지 통째로). 3) 반대로 앱 자신은 log::info!를 lib.rs:236의 '시작' 한 곳에서만 호출한다 — 자식 프로세스 스폰/종료, 창 생성/파괴, 정리 훅 실행, 프로세스 수, RSS 어느 것도 기록하지 않는다. 4) 실측 결과: 총 160줄 중 zbus/tracing 84줄(52.5%), 앱 자신 9줄, 웹뷰 에러 1건(스택트레이스 66줄). 5) 따라서 387개가 쌓이는 5주 동안 로그에는 그 과정을 가리키는 신호가 **한 줄도** 없었고, 죽기 전 32분 무기록도 버그가 아니라 이 설정의 정상 동작이다. panic.log가 없다는 사실만으로 '패닉 아님'을 알 수 있었던 게 진단의 전부였다.
- 387개 설명가능: False
- 수정: (1) 서드파티 노이즈를 잘라낸다:
  tauri_plugin_log::Builder::new()
      .level(log::LevelFilter::Info)
      .level_for("zbus", log::LevelFilter::Warn)
      .level_for("tracing", log::LevelFilter::Warn)
      .level_for("zbus::connection::handshake", log::LevelFilter::Warn)
      .level_for("hyper", log::LevelFilter::Warn)
      .level_for("reqwest", log::LevelFilter::Warn)
(2) **자식 프로세스 생명주기 로그를 의무화한다.** spawn 시 `log::info!("spawn {kind} pid={pid} ctx={...}")`, 회수 시 `log::info!("reap {kind} pid={pid} status={...}")`. 이 규약이 있었다면 xdg-open 좀비 387개가 로그에서 바로 보였다.
(3) **주기 헬스 로그를 추가한다.** lib.rs setup에서 5분 간격 스레드/태스크를 띄워 `log::info!("health: procs_in_scope={} rss={}MB threads={} terminals={} lsp={} browsers={}")`를 남긴다. Linux는 /proc/self/status의 Threads, /proc/self/statm의 RSS, 그리고 자기 cgroup의 cgroup.procs 줄 수(/proc/self/cgroup → /sys/fs/cgroup/<path>/cgroup.procs)를 세면 systemd scope의 실제 프로세스 수를 앱이 스스로 관측할 수 있다. 임계(예: 100) 초과 시 log::warn! + UI 토스트.
(4) 정리 훅(lib.rs:409-421) 각 단계의 결과 개수를 log::info!로 남긴다.

## [low/other] 알림 1건마다 새 D-Bus 세션 연결 + SASL 핸드셰이크 — 다만 연결은 정상 종료됨(누수 아님)
- 위치: `src-tauri/src/notifications.rs:1`  (서브시스템: lifecycle-monitor)
- 유발: 프론트의 working→done 엣지(AI 작업 완료 알림). 로그상 5주간 14회 — 매우 드물다.
- 메커니즘: 1) 프론트가 AI 작업 완료 시 tauri_plugin_notification의 sendNotification을 호출한다(notifications.rs:84-85 주석: '비-Windows에선 프론트가 플러그인 sendNotification을 그대로 쓴다'). 2) 플러그인은 tauri-plugin-notification-2.3.3/src/desktop.rs:216-218에서 `tauri::async_runtime::spawn(async move { let _ = notification.show(); })`를 실행한다 — 블로킹 호출을 tokio 태스크 안에서 돌려 워커 스레드를 점유한다. 3) notify-rust-4.18.0/src/xdg/zbus_rs.rs:175가 호출마다 `zbus::Connection::session().await?`를 부른다. 4) zbus-5.16.0/src/connection/mod.rs:1217의 `session()`은 `Builder::session()?.build().await` — **캐시가 없어 매번 새 연결을 만들고 전체 SASL 핸드셰이크를 수행한다**. 이게 로그에 반복 등장하는 핸드셰이크의 정체다. 5) **그러나** show()가 돌려주는 ZbusNotificationHandle이 `let _ =` 로 즉시 drop되고, 그 안의 zbus::Connection도 함께 drop되어 소켓이 닫힌다(ConnectionInner에 Drop 구현 존재, zbus connection/mod.rs:85). 소켓 리더는 커넥션 자체 Executor의 Task라 커넥션과 함께 취소된다. → 연결·fd·스레드 어느 것도 누적되지 않는다.
- 387개 설명가능: False
- 수정: 기능적 버그는 아니므로 필수 수정은 없다. 선택적 개선 2가지:
(1) 로그 오염 제거 — 발견 5의 `.level_for("zbus", LevelFilter::Warn)`로 6줄/알림 노이즈를 없앤다(이것만으로 로그의 52%가 사라진다).
(2) 블로킹 최소화 — 플러그인 내부라 직접 손대긴 어렵지만, 앱이 직접 알림을 보낸다면 notify_rust의 async API(`show_async`)를 쓰거나 `tauri::async_runtime::spawn_blocking`으로 옮겨 tokio 워커 점유를 피한다.

## [low/unbounded-growth] proc_icons IconCache가 무한 성장하며 Linux에서는 전량 무의미(항상 None)
- 위치: `src-tauri/src/proc_icons.rs:16`  (서브시스템: lifecycle-monitor)
- 유발: 리소스 모니터 팝업이 새 exe 경로를 처음 볼 때마다 1회.
- 메커니즘: 1) `IconCache(Mutex<HashMap<String, Option<String>>>)`는 exe 경로를 키로 무한 축적되고 **제거·만료·상한이 전혀 없다**(proc_icons.rs:16). 2) `get_process_icons`가 요청된 경로마다 `cache.entry(path.clone()).or_insert_with(...)`로 항목을 만든다(proc_icons.rs:26-35). 3) Linux에서는 `extract_icon_data_uri`가 무조건 None을 반환하므로(proc_icons.rs:50-53) 모든 항목이 None이고 반환 맵은 항상 비어 있다 — 즉 Linux에서 이 커맨드는 **캐시를 채우는 것 외에 아무 일도 하지 않는다**. 4) 프론트는 iconReqRef로 경로당 1회만 요청하므로(SysMonitorWindow.tsx:262-278) 반복 호출 폭주는 없다. 5) 다만 프로세스가 387개로 불어나 서로 다른 exe 경로가 다양해질수록(특히 삭제된 바이너리의 '/path (deleted)' 형태) 항목 수가 계속 는다. 6) 이 커맨드도 동기 커맨드라 메인 스레드에서 Mutex를 잡는다.
- 387개 설명가능: False
- 수정: (1) Linux/macOS에서는 커맨드 자체를 early-return으로 막는다 — `#[cfg(not(windows))] return HashMap::new();` 로 캐시 항목조차 만들지 않는다. 프론트도 플랫폼 체크 후 호출을 생략하는 게 낫다.
(2) Windows 경로에는 상한을 건다(예: 2,000개 LRU) — base64 PNG가 항목당 1~4KB라 경로가 많아지면 실제 메모리가 된다.
(3) 이 커맨드도 async로 전환해 메인 스레드에서 뺀다(Windows에서는 ExtractIconExW + GetDIBits가 경로당 수 ms라 배치 요청이 UI를 막는다).

## [low/other] kill_processes가 메인 스레드에서 Mutex를 잡은 채 80ms sleep
- 위치: `src-tauri/src/monitor.rs:329`  (서브시스템: lifecycle-monitor)
- 유발: 리소스 모니터에서 '작업 끝내기' 클릭(SysMonitorWindow.tsx:283-299의 확인 모달 승인 후).
- 메커니즘: 1) `kill_processes`는 동기 커맨드(monitor.rs:509-522)라 메인 이벤트 루프에서 실행되고, 진입 즉시 `state.monitor.lock().unwrap()`으로 Monitor Mutex를 잡는다. 2) Monitor::kill 내부에서 종료 반영을 기다리려고 `std::thread::sleep(Duration::from_millis(80))`를 호출한다(monitor.rs:329). 3) 이 80ms 동안 메인 스레드가 멈추고 Monitor Mutex도 잡혀 있어 같은 시각의 sys_metrics/sys_process_snapshot 폴링도 함께 막힌다. 4) 그룹 종료로 pid가 수십~수백 개면 앞뒤 refresh 비용까지 더해져 체감 프리즈가 된다. 코드 주석은 '사용자 액션이라 드묾 — 80ms 락 점유 무해'라고 적었지만, 락 점유가 아니라 **메인 스레드 점유**라는 점이 빠져 있다.
- 387개 설명가능: False
- 수정: `kill_processes`를 `pub async fn`으로 바꾸고 sleep을 `tokio::time::sleep(...).await`로 교체한다. 이때 std Mutex를 await 경계 너머로 들고 가면 안 되므로, kill 시도 → lock drop → await → 재lock 후 생존 확인의 3단계로 쪼갠다. 부수 효과로 UI가 종료 진행 중에도 반응한다.
