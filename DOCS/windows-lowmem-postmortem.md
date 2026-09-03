# 2026-09-02 Windows 저메모리 강제 종료 — 원인과 보완

<!-- 조사: 코드 정독 4갈래(Rust 힙 / 렌더러·GPU / 종료 경로 / Windows 플랫폼 사실) +
     발견 16건 적대적 검증. 이 문서는 그 결과만 담는다. -->

## 0. 무슨 일이 있었나

NTS 머신(Windows, 물리 RAM 7.7GB)에서 설치본 v0.4.2가 **아무 예고 없이 사라졌다.**
앱이 남긴 유일한 기록은 5분 주기 health 로그다.

```
22:46~23:01  lv=notice procs=15 mem=2.0GB(26%) avail=9~11% swap=54%
23:05:51     WARN 레벨 상승 원인=["앱 메모리 2.0GB (시스템의 26%)", "시스템 여유 메모리 6%"]
23:16:18     lv=warn  procs=15 mem=2.0GB(26%) avail=7%  swap=55%   ← 마지막 기록
             (23:21 로그 없음)
01:08:05     Gitpervisor 시작 v0.4.2
01:08:05     [health] 지난 실행 비정상 종료 감지: oom
```

**이 "oom" 판정은 사인을 말하지 않는다.** `classify()`는 `clean_exit=false`이고 죽기 직전
레벨이 warn이었다는 것만 보고 oom이라 적는다. 실제로 다음 넷 중 무엇이든 똑같이 찍힌다.

| 실제 사인 | 앱이 남기는 것 | 겉보기 판정 |
|---|---|---|
| Rust 할당 실패 → `abort` | **없음** (아래 §2) | oom |
| 작업 관리자 "작업 끝내기" | 없음 | oom |
| 전원 차단·강제 재부팅 | 없음 | oom |
| WER 크래시(접근 위반 등) | 없음 | oom |

즉 **사후 진단이 유일한 안전망인 플랫폼에서, 그 안전망이 "메모리 지표가 나빴다"까지만
말하고 멈춰 있었다.**

## 1. 왜 2.0GB였나 — 앱 코어의 80%는 파일 워처다

`procs=15`는 앱 프로세스 트리 전체다. 개발기 실측(2026-09-03, 설치본 pid 2852)으로
그 2.0GB의 내역이 갈렸다.

| 프로세스 | private commit | 성격 |
|---|---|---|
| gitpervisor.exe | 554MB | **앱 자체 Rust 힙** |
| msedgewebview2 gpu | 590MB | 터미널 WebGL 컨텍스트 |
| msedgewebview2 renderer | 273MB | xterm 스크롤백·React |
| msedgewebview2 browser+utility | ~150MB | WebView2 기저 |
| pwsh/conhost 짝 | ~300MB | 사용자가 띄운 셸 |

그리고 **gitpervisor.exe 554MB 중 약 80%가 파일 워처였다.**

`watcher.rs`는 디렉터리마다 `RecursiveMode::NonRecursive` 감시를 건다. 이 전략의 근거는
**inotify 전용**이다 — 2026-08 OOM 사건에서 재귀 watch가 12개 레포에 184,001개를 걸었고
그중 95.2%가 낭비였다. 커널 watch 하나가 ~1KB를 고정하므로 약 180MB가 cgroup에 잡혔다.

**같은 코드가 Windows에서는 정반대로 작동한다.** notify의 Windows 백엔드는 감시 하나마다:

- `CreateFileW` 디렉터리 핸들 1개 + `CreateSemaphoreW` 1개
- `Box<ReadDirectoryRequest { buffer: [u8; 16384], .. }>` — **16KB 힙 버퍼가 상주**
  (`start_read`가 Box를 leak해 `ReadDirectoryChangesW`에 넘기고, 완료 때마다 회수 후 즉시 재발행)

를 만든다. 조상 중복 제거는 없다.

**개발기에서 핸들 수로 교차 검증했다.** `collect_watch_targets`를 그대로 재현해 등록된 24개
루트를 순회하니 감시 23,885개가 나왔고, 예측 핸들 47,770개에 대해 실측은
**Semaphore 23,942 + File 24,002 = 47,944**(총 49,150)였다. 오차는 DLL·로그 등 상시 핸들 몫이고
사실상 1:1이다. 버퍼는 **373MB**.

여기에 `notify-debouncer-full`의 `RecommendedCache`(=`FileIdMap`)가 얹힌다. 이건 감시 등록 시
**파일마다 `CreateFile` + `GetFileInformationByHandleEx`**를 돌려 `(PathBuf, FileId)`를
HashMap에 넣는다 — 실측 334,716 항목 × ~180B ≈ **57MB**. 앱은 rename 짝맞추기를 쓰지 않는데
(이벤트는 "이 레포 바뀜" 신호일 뿐) 그 비용을 전부 낸다. 등록이 느린 이유이기도 하다
(로그: aipervisor 5,567 디렉터리 등록에 26초).

**373 + 57 = 431MB, gitpervisor.exe private 554MB의 78%다.** 상위 루트는 aipervisor 5,567 /
germ 4,390 / Downloads 3,420 / legacy-hrcs 2,187 순이다(사용자가 `Downloads`를 프로젝트로
등록해 뒀고 그것만 54MB다).

**NTS 머신(27개 프로젝트, camstation 하나가 2,426 디렉터리)은 0.5~0.7GB로 추정된다** —
앱이 쥔 2.0GB의 25~35%, gitpervisor.exe 몫으로는 대부분.

## 2. 왜 흔적이 없었나 — Rust 할당 실패는 로그를 남기지 않는다

`main.rs`가 `#![windows_subsystem = "windows"]`라 콘솔이 없다. 이 조합이 진단을 통째로 삼킨다.

1. 할당 실패 → `handle_alloc_error` → `default_alloc_error_hook`이 **stderr**에
   `memory allocation of N bytes failed`를 쓴다.
2. stderr는 `GetStdHandle`이 NULL을 주고 `handle_ebadf`가 write를 **성공으로 위장**한다 —
   메시지가 조용히 버려진다.
3. 곧바로 `process::abort()`. std 주석이 못 박는다: *"does not call any user-defined code"* —
   **전역 패닉 훅이 돌지 않는다.** `panic.log`도 없다.
4. Windows에서 abort는 `int 0x29`(`__fastfail`, FAST_FAIL_FATAL_APP_EXIT) →
   예외 코드 **0xC0000409**로 즉사. `set_alloc_error_hook`은 nightly 전용이라 스테이블에서는
   가로챌 방법이 없다.

**앱 밖에 남는 유일한 흔적은 Windows 이벤트 로그다.** WER이 Application 로그에 Event 1000
(`Data[0]`=exe, `Data[6]`=예외 코드 hex)을 남긴다. 그런데 앱은 그걸 한 번도 읽지 않았다.

한편 **Windows는 물리 메모리가 부족하다고 프로세스를 죽이지 않는다.** OOM killer가 없다.
판정 기준은 물리 여유가 아니라 **커밋 차지 대 커밋 한도**이고, 사건 당시 커밋은 55%였다
(7.7GB RAM + 페이지파일 1.2~2.5GB ≈ 커밋 한도 9~10.5GB 중 5.0~5.8GB). 커밋 고갈이 아니었으므로
Resource-Exhaustion-Detector의 Event 2004도 발생하지 않았을 것이다. 즉 **"OS가 골라 죽였다"는
가설은 문서상 근거가 없다** — 물리 RAM 93~94% 사용은 순수 페이징 압박이고, 그 상태에서 앱이
죽는 경로는 자기 할당 실패이거나 WebView2 프로세스 크래시다.

## 3. WebView2 프로세스가 죽어도 앱은 모른다

`wry` 0.55.1과 `tauri-runtime-wry` 2.11.x 어디에도 `add_ProcessFailed` 등록이 없다.
등록된 핸들러는 PermissionRequested·WindowCloseRequested·NavigationCompleted 등뿐이다.

결과: 렌더러·GPU·브라우저 프로세스가 죽어도 tao 창(HWND)과 gitpervisor.exe는 살아 있고,
사용자는 **배경색만 칠해진 빈 창**을 본다. 그 상태에서 X를 누르면 정상 종료 경로를 타
`clean_exit=true`가 되어 **진단 흔적이 아예 남지 않는다.**

Chromium은 할당 실패 시 null을 돌려주지 않고 의도적으로 크래시하며, Windows에서는
`RaiseException(0xE0000008)`을 쓴다. 즉 msedgewebview2.exe의 Event 1000 예외 코드가
**0xE0000008이면 확정 OOM**이다 — 이것도 이벤트 로그를 봐야 알 수 있다.

## 4. 경고는 떴는데 초안은 저장되지 않았다

백엔드는 warn 이상 전이 때 `health://flush-drafts`를 emit한다. **그걸 받는 프론트 코드가
하나도 없었다.** 디바운스 저장은 정확히 세 곳이고 셋 다 이벤트에 연결돼 있지 않았다:
API 클라이언트 영속화(250ms), 메모장 본문(500ms → IPC), 커밋 메시지 초안(300ms).

---

## 보완 (이 브랜치)

### A. 워처 — 플랫폼별 전략 분리

Windows/macOS는 **루트 하나에 재귀 감시 1개**만 건다. `ReadDirectoryChangesW`는
`bWatchSubtree`로 하위 트리를 커널이 처리하므로 버퍼도 핸들도 1세트면 된다. FSEvents도 같다.
디렉터리별 NonRecursive는 **Linux(inotify) 전용**으로 남긴다 — 거기서는 그게 옳고, 2026-08
사건의 근거 주석도 그대로 유효하다.

#### `NoCache`는 최적화가 아니라 재귀 감시의 **전제조건**이다

이 둘은 반드시 같이 가야 한다. 재귀 감시만 넣고 `FileIdMap`을 남기면 **유계 431MB를 무계
누수와 바꾸는 셈**이 된다. 기전은 이렇다.

`DebounceDataInner::add_event`는 `Create` 이벤트마다, 그리고 폴백 `_` 갈래(일반 쓰기 등)에서
`cached_file_id`가 None이면 또, `self.cache.add_path(path, self.recursive_mode(path))`를 부른다.
그런데 `recursive_mode()`는 **`roots`에서 그 경로를 포함하는 루트의 모드를 그대로 돌려준다.**
루트를 재귀로 바꾸면 그 아래 모든 경로가 `Recursive`가 되고,
`FileIdMap::add_path`는 `dir_scan_depth(true) == usize::MAX`로
**`WalkDir` 전체 순회 + 엔트리마다 `get_file_id`(CreateFile syscall)** 를 돌린 뒤
`paths: HashMap<PathBuf, FileId>`에 **영구 삽입**한다. 비우는 건 `Remove` 이벤트의
`remove_path`뿐이다.

즉 `npm install`이 `node_modules/foo`를 만드는 Create 이벤트 하나가 그 하위 트리를 통째로
훑어 캐시에 넣는다. 우리 콜백의 경로 필터는 그 **뒤에** 있어 이미 들어간 것을 되돌리지
못한다. 지금 이게 안 터지는 유일한 이유는 `node_modules`를 애초에 watch하지 않아서인데,
이번 수정이 바로 그 방어를 걷어낸다.

**게다가 폭발은 이벤트를 기다리지도 않는다.** `Debouncer::add_root`는 `roots.push` 직후
**그 자리에서** `data.cache.add_path(&path, recursive_mode)`를 부른다. 루트를 재귀로 등록하는
순간 WalkDir가 depth MAX로 프로젝트 트리를 통째로 훑는다 — `node_modules`·`target` 포함이다.
지금 엔트리가 334,716개에서 멈추는 건 비재귀 등록 23,885번이 각각 depth 1이라 잘라낸
4,503개 디렉터리를 애초에 안 건드리기 때문이다. 재귀 루트 + `FileIdMap`이면 `npm install`을
기다릴 것도 없이 **앱 시작 시점에** 전 트리가 캐시에 들어온다.

그래서 `NoCache`는 "누수를 막는다"가 아니라 **"재귀 등록을 가능하게 하는 조건"** 이다.

`NoCache`는 `add_path`/`remove_path`가 빈 함수이고 `cached_file_id`가 항상 None인 완전한
no-op이라 이 경로가 통째로 죽는다. 잃는 것도 없다: **notify의 Windows 백엔드는 rename 쿠키를
아예 안 붙이고**(`set_tracker` 호출이 없다) From/To를 잇는 건 오직 `FileIdMap`인데, 콜백은
rename 쌍을 쓰지 않는다 — `is_relevant`면 `repo://changed`를 한 번 쏘는 게 전부다.

> **나중에 rename 정확도를 이유로 `FileIdMap`을 되살리지 마라.** 그 순간 위 누수가 조용히
> 부활한다. 회귀 테스트가 이를 지킨다.

**알고 갈 비용: 필터가 디바운서 뒤에 있다.** `under_ignored_dir`/`is_relevant`는 디바운스된
이벤트를 받는 콜백 안에서 돈다. 지금은 `node_modules`·`target`을 **아예 watch하지 않아**
커널에서부터 안 올라온다(개발기 순회에서 4,503개 디렉터리가 그렇게 잘렸고 aipervisor만
4,056개다). 재귀 감시로 바꾸면 그 경로들이 이벤트를 만들어 `queues: HashMap<PathBuf, Queue>`에
쌓인 뒤에야 걸러진다 — `npm install`·`cargo build` 중 CPU·메모리 스파이크가 새로 생긴다.
`notify-debouncer-full` 0.7에는 큐 앞단 필터 훅이 없다(확인함). 상주 시간은 tick(100ms)이
아니라 **timeout 400ms 전부**다 — `debounced_events`가 `queues.drain()`으로 맵을 비우긴 하지만
각 큐에서 만기(`now - event.time >= timeout`)가 안 된 첫 이벤트를 만나면 `push_front`로
되돌리고 그 큐를 `queues_remaining`에 도로 넣는다. tick은 만기 검사 주기일 뿐이다.
그래도 상주량은 400ms 분량으로 유계이고, **상시 431MB와 바꾸는 거래라 압도적으로 유리하다.**
빌드 중 스파이크가 실제로 문제가 되면 그때 raw `notify` + 자체 코얼레싱으로 내려가면 된다
(필터가 이벤트 수신 지점으로 올라간다).

**CPU는 오히려 개선일 수 있다.** `recursive_mode()`는 `roots`에 대한 **선형 스캔**이고
`add_event`가 이벤트마다 부른다. 지금 `roots`는 감시 개수만큼이라 이 머신에서 23,885개 —
이벤트 하나당 최대 2만 번의 경로 접두사 비교다. 재귀로 가면 프로젝트당 1개, 총 24개가 된다.
이벤트 유입이 늘어나는 만큼 건당 비용은 세 자릿수 배로 싸진다.

#### 알고 갈 비용 ②: Windows 오버플로는 **완전히 무성이다**

notify 8.2.0의 완료 루틴은 `bytes_written`을 `_`로 버린다. 버퍼 오버플로는 `ERROR_SUCCESS` +
0바이트로 오고, 0으로 채워진 버퍼를 파싱하면 `FileNameLength == 0`, `Action == 0`이 되어
`match cur_entry.Action`의 `_ => ()` 갈래로 떨어진다 — **이벤트가 하나도 나오지 않고**
Rescan 플래그도 서지 않는다. 리눅스 inotify의 `Q_OVERFLOW`나 macOS FSEvents의
`MustScanSubDirs`와 달리 신호 자체가 없다.

루트 재귀 감시는 16KB 버퍼 **하나**를 레포 전체가 공유하므로, 디렉터리별로 흩어져 있을 때보다
오버플로 확률이 오른다.

**유실은 무차별이다.** "어차피 `node_modules`뿐"이 아니다 — 같은 창에 브랜치 전환이나 소스
저장이 겹치면 그것도 함께 사라진다. 그리고 폭주가 계속되는 동안은 다음 창도 같이 넘칠 수
있으므로 복구 시점은 "다음 이벤트"가 아니라 **"폭주가 끝난 뒤" 또는 "포커스 복귀"** 다.
최종 안전망은 `refetchOnWindowFocus: true`(`main.tsx`)의 일괄 갱신이다.

**다만 감시 자체는 죽지 않는다.** `handle_event`는 `ERROR_SUCCESS` 갈래에서 버퍼를 파싱하기
**전에** `start_read`로 다음 요청을 먼저 건다(주석: *"Get the next request queued up as soon as
possible"*). 오버플로는 그 창 한 번의 유실이지 감시의 영구 정지가 아니다. 감시가 실제로
죽는 경우는 둘뿐이다 — 디렉터리가 사라져 `ERROR_ACCESS_DENIED`가 뜰 때와 미확인 에러일 때
(둘 다 `request.unwatch()`).

근본 해결은 notify 업스트림 수정이나 자체 Windows 워처이고 이번 범위 밖이다.

**다만 감시가 죽는 경우가 하나 남는다.** 위 "`ERROR_SUCCESS` + 0바이트"는 Win32 APC 래퍼가
커널의 `STATUS_NOTIFY_ENUM_DIR`을 0으로 넘긴다는 전제다(.NET `FileSystemWatcher`가
`errorCode == 0 && numBytes == 0`을 오버플로로 판정하므로 유력하다). 그게 아니라
`ERROR_NOTIFY_ENUM_DIR`(1022)로 들어오면 notify는 미확인 에러로 보고 `request.unwatch()` +
`log::error!`를 한다 — **그 프로젝트 감시가 영구 해제된다.** 소스만으로는 어느 쪽인지 확정할
수 없으므로 "오버플로 = 그 창의 유실"로 못 박지 마라. **Windows는 오버플로를 보고하지 않으며,
최악의 경우 해당 워처가 해제될 수 있다**가 정확한 서술이다(해제된 경우엔 로그에 error 줄이
남으므로 진단은 가능하다).

콜백에는 `need_rescan()` 처리를 함께 넣었다. Rescan 이벤트는 **paths가 비어 있어**
기존 `paths.iter().any(is_relevant)`로는 절대 통과하지 못했다 — Linux/macOS에 원래 있던
구멍이라 같이 막았다. **Windows에서는 완전히 죽은 코드다**: `Flag::Rescan`은 notify 8.2.0
전체에서 `fsevent.rs`와 `inotify.rs` 두 곳에서만 세팅되고 `windows.rs`에는 아예 없다(grep 0건).
"오버플로는 처리했다"고 읽지 마라 — Windows 쪽 보험은 여전히 `refetchOnWindowFocus`와
수동 새로고침뿐이다.

재귀 감시는 새 디렉터리를 커널이 상속하므로 **증분 등록 통로(`new_dir_tx`/`new_dir_rx` 스레드와
`MAX_INCREMENTAL_WATCHES`)는 비Linux에서 죽은 코드가 된다** — 함께 정리한다.

#### 감시 수를 줄이려고 `.git` 유무를 게이트로 걸지 마라

프로젝트 목록에는 **git 레포가 아닌 루트도 있다.** 사용자는 이미지 파일 경로를 빨리 집으려고
`C:\Users\GreatHoon\Downloads`를 일부러 등록해 뒀고, 그것 하나가 감시 3,420개(54MB)였다.
`register()`는 `path.is_dir()`만 보고 `collect_watch_targets`도 `.git`은 있을 때만 더하므로
비-git 루트가 정상 동작한다. 여기에 "git 레포만 감시" 같은 조건을 넣으면 **다운로드가 끝나도
파일트리가 갱신되지 않는다** — 비-git 루트에서도 `repo://changed`의 ignore 캐시 무효화와
트리 갱신은 계속 필요하다. 회귀 테스트에 `.git` 없는 디렉터리 케이스를 넣어 이 함정을 막는다.

이 루트는 이번 수정의 최대 수혜자다: 감시 3,420개 → 1개, 54MB → 16KB.

기대: gitpervisor.exe private 554MB → 100~150MB, 핸들 49,150 → 수백 개, 등록 26초 → 즉시.

### B. 사후 진단 — 앱 밖의 증거를 읽는다

비정상 종료를 감지한 **첫 시작에만**(창 생성 전, ≤3초) `wevtutil`로 Application(1000/1001/1002)과
System(6008/41/1074/2004) 로그를 사건 시각 주변에서 조회해 verdict를 정정한다.
XPath의 `@SystemTime`은 UTC이고 `/f:xml`은 로캘 독립이다(실측 70~300ms).

**시각 창은 이벤트마다 다르고, 이게 정확도의 전부다.** Application(1000/1001/1002)은 XPath가
−10분/+15분 양쪽을 건다. System은 다르다 — 6008/41은 사건 당시가 아니라 **다음 부팅 때**
기록되므로 XPath에 상한을 걸면 진짜 전원 사고를 놓친다. 그래서 조회는 하한만 걸고,
`winlog::narrow`가 사후에 상한을 준다: 6008/41/2004은 **−10분 ~ +48시간**, 1074는 ±15분.
상한이 아예 없으면 사건 며칠 뒤의 무관한 정전 한 번이 verdict를 `power`로 뒤집어
"앱 문제가 아닐 수 있습니다"가 뜬다 — 이 브랜치가 겨냥한 저메모리 진단이 정확히 반대로
나가고, 판정은 `begin()`이 `session.json`을 밀어내므로 **1회성이라 정정 기회도 없다.**
`narrow`는 목록을 **시각 오름차순으로 정렬**하기도 한다: `wevtutil`을 `/rd:true`(최신 우선)로
읽으므로 정렬하지 않으면 `classify`의 `find()`가 사건에서 가장 **먼** 이벤트를 집는다.

**앱 크래시(1000)는 pid로 인스턴스를 가른다.** exe 이름만 보면 dev와 설치본이 같은
`gitpervisor.exe`라 서로의 크래시를 가져간다 — 이 저장소는 둘을 나란히 띄우는 게 기본
워크플로이고(CLAUDE.md), dev는 재빌드마다 죽어 그쪽 이벤트가 훨씬 흔하다. 1000의
`Data[8]`(faulting process id, 16진)을 지난 세션 pid와 대조한다. WER 1001은 EventData에 pid가
없어 같은 방법이 없고, 실제 크래시는 1000을 항상 함께 남기므로 **판정 근거에서 뺐다**
(근거 목록에는 남아 사용자에게 보인다).

예외 코드 해석표를 문구에 넣는다: `c0000409` abort(Rust 할당 실패 포함) · `e0000008` Chromium OOM ·
`c0000005` 접근 위반 · `80000003` Chromium CHECK · `c00000fd` 스택 오버플로.

verdict 우선순위: **alloc 표식 > panic > crash > power/reboot > 지표 기반 oom > unknown.**

### C. 할당 실패 표식

`#[global_allocator]` 래퍼가 alloc/realloc이 null을 돌려주는 순간 `alloc-fail.txt`에 고정
바이트열을 쓴다. **핸들러 안에서 할당·포맷·뮤텍스·log 매크로는 전부 금지** — 미리 채워 둔
정적 UTF-16 경로 버퍼로 `CreateFileW`+`WriteFile`만 하고, 크기 숫자는 스택 버퍼에 수동 itoa,
`AtomicBool` CAS로 1회만. 그 뒤 std가 abort한다.

### D. 프로세스별 breakdown

health 스냅샷에 트리 상위 프로세스(이름·pid·private)를 담아, 경보와 사후 진단이
**"앱 자체 1.5GB, 터미널 프로그램 0.5GB"**처럼 갈라 말한다. 사용자가 띄운 claude.exe/node가
트리 총량을 부풀리는데 그걸 앱 결함으로 오독하면 엉뚱한 곳을 고치게 된다.

Toolhelp 스냅샷은 이름(`szExeFile`)을 이미 담고 있고 `PrivateUsage`도 프로세스별로 이미
따로 구하므로 **추가 syscall이 없다**(30초 캐시 그대로).

### E. 압박 시 자동 감축

`health://level`이 warn 이상이면:
- 모든 웹뷰에 `ICoreWebView2_19::SetMemoryUsageTargetLevel(LOW)` — 캐시 폐기·스왑아웃 유도.
  메인 창은 항상 보이므로 `TrySuspend`는 쓸 수 없다(IsVisible=false 필수). 복귀는 자동이
  아니므로 **warn 아래로 내려오는 즉시** NORMAL을 명시한다 — `ok`로 한정하면 안 된다.
  `Machine::settle`의 강등은 관측 목표 레벨로 곧장 내려가 warn→notice가 흔하고, 여유가 상시
  빠듯한 머신에서는 ok 60초 연속을 못 채워 LOW가 영구히 굳는다(notice는 배너도 없다).
- 플로팅 프리워밍 풀 창(상시 1개, 렌더러 40~70MB)을 닫고 프리워밍을 건너뛴다. 게이트는
  `spawn_float_pool_window` 본문에 둔다 — 호출자가 둘이고 정상 운영 중 실제로 도는 쪽은
  claim 직후 보충이다. `on_health_level`은 **전이 시점에만** 불리므로 warn이 유지되는 동안
  누가 다시 채우면 아무도 회수하지 않는다(`float_pool_ready`에서도 한 번 더 막는다).
- PTY 속도 예산을 8MB/s → 1MB/s(warn) → 128KB/s(danger)로 낮춘다. 렌더러가 압박으로 멈추면
  Channel 페이로드가 Tauri `ChannelDataIpcQueue`(Rust 힙, 원시 바이트의 ~3.5배 JSON)에
  무한 적체된다 — 유입을 줄이면 적체 상한이 내려간다.

또 `ProcessFailed`를 등록해 렌더러·GPU·브라우저 프로세스 실패를 kind/reason/exit code와 함께
로그로 남긴다. "빈 창"이 더 이상 무성 실패가 아니게 된다.

### F. 초안 flush

`health://flush-drafts` 수신부를 만들고 디바운스 저장 세 곳을 flush 레지스트리에 등록한다.
새로 연 창은 전이 이벤트를 못 받으므로 마운트 시 스냅샷이 warn 이상이면 한 번 flush한다.

---

## 남긴 것 (이번 범위 밖)

- **비활성 터미널의 WebGL 컨텍스트**: 터미널마다 컨텍스트 1개를 들고 있고 탭이 숨겨져도 유지된다.
  GPU 프로세스 590MB의 상당 부분이지만 Chromium 상한 16개에서 멈추고 시간에 따라 늘지 않는다
  (아틀라스는 터미널마다가 아니라 **공유**다 — 초기 추정이 틀렸다).
- **임베디드 브라우저 탭**: 탭마다 별도 프로필 자식 웹뷰라 첫 탭에 브라우저·GPU 프로세스가
  통째로 더 뜬다(탭 1개 250~500MB). 숨김은 렌더링만 멈출 뿐 프로세스는 산다. 사건 당시
  탭이 열려 있었다는 증거는 없다(procs=15).
- **디스크 사용량 스캔 결과**: 리소스 모니터 창이 열려 있는 한 arena(C:\ 65만 폴더 ≈ 140MB)가
  상주한다. TTL이 없다.
