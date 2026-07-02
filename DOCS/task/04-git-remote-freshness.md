# 태스크 04 — 프로젝트별 원격 git 최신상태 자동 반영 (pull 필요 감지)

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속) · 근거: 코드 실측 2026-07-02

## 1. 요구사항

사용자 원문: "각 프로젝트마다 알아서 새로운 git pull 받아야 할 게 있는지 최신 git 상태 반영도 해줘."

- 각 등록 프로젝트에 대해 **주기적으로 원격을 확인(fetch)** 해 "pull 받을 커밋이 있는지"(behind N)를 사이드바에 자동 반영한다.
- **자격증명 프롬프트 절대 금지** — 터미널 프롬프트는 물론 Windows Credential Manager GUI 팝업도 배경 fetch에서 뜨면 안 된다. 실패는 조용히 상태 배지로만 표면화.
- 사용자 작업(커밋/스테이지/터미널의 AI 에이전트)과 간섭하지 않는다.

## 2. 현황(근거)

**ahead/behind는 이미 계산되지만, 로컬 refs 기준이라 fetch 없이는 낡은 값** — 이것이 이 태스크의 핵심 공백이다.

- git 접근은 **git2 크레이트가 아니라 git CLI 프로세스 호출**이다. 모든 실행은 단일 관문 `run_git`을 지난다(`src-tauri/src/git/runner.rs:107-128`). 이미 `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`가 전 호출에 걸려 있다(`runner.rs:122-124`, stdin 변형 `:176-178`, 스트리밍 변형 `:240-242`).
- 상태 조회는 배치 커맨드 `get_statuses` 1개다(`src-tauri/src/commands/status.rs:15-47` — "요청 1개 = 응답 1개"로 WebView2 동시 invoke 유실 회피가 주석에 명시). 내부는 `git status --porcelain=v2 --branch --untracked-files=all -z`(`status.rs:120`)이고, `# branch.ab +A -B` 헤더를 파싱해 `RepoStatus.ahead/behind`를 채운다(`src-tauri/src/git/parse_status.rs:59-66`, `src-tauri/src/git/types.rs:51-52`). 이 값은 **로컬 remote-tracking ref(refs/remotes/…) 대비**라서 fetch가 돌지 않으면 원격의 새 커밋을 반영하지 못한다.
- **UI는 이미 ↓N/↑N 배지를 렌더한다**: `src/components/sidebar/ProjectItem.tsx:147-158` (ahead=초록 `text-add` ↑, behind=파랑 `text-mod` ↓). 변경 우선 정렬도 ahead/behind를 2등급으로 반영한다(`src/components/sidebar/ProjectList.tsx:99`). 즉 **표시 계층은 완성 — 값의 신선도만 문제**.
- fetch 커맨드는 존재한다: `src-tauri/src/commands/sync.rs:49-56` (`git fetch --progress`, stderr 스트리밍 → `repo://op-progress`/`repo://op-finished` 이벤트). 실행 전 `try_begin_op` 락을 잡는다(`sync.rs:68`). 이 락은 commit/stage/discard 등과 공유된다(`src-tauri/src/state.rs:56-68`, `src-tauri/src/commands/actions.rs:17,28,41,53`) — 락 보유 중 다른 작업은 `OpInProgress`로 즉시 거절.
- **자동 fetch의 반쪽 구현이 이미 있다(기본 OFF)**: 설정 `auto_fetch_minutes`(`types.rs:195`, 기본 0=끔, `types.rs:222`) + 프론트 훅 `useAutoFetch`(`src/queries/index.ts:581-596`, `src/App.tsx:44`에서 마운트). 그런데 이 구현은 `for (const p of projects) void ipc.fetch(p.id)` — **프로젝트별 개별 invoke를 동시에 남발**한다. 이 프로젝트가 배치 커맨드 패턴을 쓰는 이유(WebView2 동시 invoke 응답 유실, `status.rs:11-14`)와 정면충돌하고, 동시성 상한·백오프·오프라인 스킵이 전무하며, op 락 경합 시 조용히 실패한다(`.catch(() => {})`).
- **fetch → UI 갱신 파이프라인은 이미 완성돼 있다**: watcher가 `.git/refs/…`·`FETCH_HEAD` 변경을 통과시키고(`src-tauri/src/watcher.rs:109-127`), `repo://changed` 수신 시 프론트가 statuses를 무효화한다(`src/lib/events.ts:47-56`). `useStatuses`는 폴링이 없고(`queries/index.ts:273-292` — refetchInterval 없음) watcher 이벤트+창 포커스(focusManager 연결, `events.ts:34-43`)로 구동된다. 즉 fetch만 제대로 돌리면 ahead/behind는 자동으로 최신화된다.
- 임베디드 중첩 저장소는 합성 id `<outerId>::<rel>`로 별도 repo처럼 취급되고(`status.rs:83`), `project_path`가 이를 되풀어(`src-tauri/src/commands/projects.rs:20-25`) **기존 fetch/pull 커맨드가 중첩 repo에도 이미 동작**한다. 단, 스케줄링 대상 목록(`state.projects`)에는 최상위만 있다.
- 사이드바 컨텍스트 메뉴(`ProjectList.tsx:341-390`)에는 fetch/원격 새로고침 항목이 없다.

## 3. 설계(대안 비교 + 채택 근거)

### 3.1 주기 실행 주체 — Rust 백그라운드 스케줄러 채택

| | A. 프론트 타이머 + 배치 커맨드 | **B. Rust tokio 스케줄러 (채택)** |
|---|---|---|
| invoke 유실 | 배치 1개로 줄여도 매 주기 invoke 발생 | 주기 실행에 invoke 자체가 없음 — 원천 차단 |
| 타이머 신뢰성 | WebView2 백그라운드 스로틀·리로드 시 유실 | tokio interval, 창 상태와 무관 |
| 상태(백오프·동시성) | 프론트에 중복 보관 필요 | 백엔드 단일 소유(AppState) |
| 결과 전달 | 응답 페이로드 | 기존 watcher 경로 재사용(refs 변경 → `repo://changed`) |

- 스케줄러는 `lib.rs` setup에서 1회 spawn(기존 watcher 등록 스레드와 같은 위치, `lib.rs:218-223` 패턴). 매 사이클마다 `AppState.settings`를 읽으므로 주기 변경이 재시작 없이 반영된다.
- 프론트 역할은 둘뿐: **창 포커스 복귀 시** `refresh_remotes` 1회 트리거(백엔드가 60초 레이트리밋으로 no-op 처리), **수동** 컨텍스트 메뉴. 기존 `useAutoFetch` 루프(`queries/index.ts:581-596`)는 **제거**한다.

### 3.2 fetch 실행 방식과 자격증명 억제

- 인자: `git fetch --quiet --no-write-fetch-head`. 배경 fetch에는 진행 스트리밍(`--progress`/op 이벤트)이 불필요하고, `--no-write-fetch-head`(git ≥2.29)로 **변화 없는 사이클에서 FETCH_HEAD 쓰기 → watcher 이벤트 → 불필요한 status 재실행**을 막는다. 실제 ref 갱신이 있을 때만 `refs/remotes/…`가 바뀌어 watcher가 신호를 낸다.
- 자격증명 3중 억제(배경 fetch 전용 env — 기존 `run_git`에 추가 env 파라미터 도입):
  - `GIT_TERMINAL_PROMPT=0` — 기존 전역 적용(`runner.rs:122`).
  - `GCM_INTERACTIVE=never` + `-c credential.interactive=false` — Git Credential Manager GUI 팝업 억제 — 둘 다 건다(버전별로 env/config 어느 쪽을 읽는지는 로컬에서 확인 불가 — (검증 필요)).
  - `GIT_SSH_COMMAND=ssh -oBatchMode=yes` — passphrase 프롬프트 억제. **이미 사용자 env에 설정돼 있으면 건드리지 않는다**(사용자 커스텀 ssh 래퍼 보호).
- 사용자 수동 push/pull(`sync.rs`)에는 적용하지 않는다 — 거기서는 GCM 팝업이 오히려 정상 인증 경로일 수 있다. 배경 fetch 실패는 조용히 freshness 상태(§3.5)로만 남긴다.
- 배경 fetch 타임아웃은 **45초** — `NETWORK_TIMEOUT_SECS=120`(`runner.rs:16`)보다 짧게 잡아 락 보유 시간을 줄인다.

### 3.3 ahead/behind 계산 — 신규 계산 없음

`git rev-list --left-right --count`나 git2 `graph_ahead_behind`를 새로 도입하지 않는다. 코드베이스는 git CLI 단일 관문이고(§2), fetch가 refs를 갱신하면 watcher → statuses 무효화 → 기존 `# branch.ab` 파싱(`parse_status.rs:59-66`)이 새 값을 계산한다. 계산 경로를 하나로 유지하는 것이 정합성·유지보수 면에서 우월하다.

### 3.4 락·간섭

- fetch는 워크트리·인덱스를 건드리지 않는다(objects는 추가 전용, 갱신은 `refs/remotes/*`뿐) — **사용자 편집·커밋·AI 에이전트 작업과 파일 수준 충돌 없음**. 이것이 "몰래 fetch해도 안전"의 근거다.
- 다만 사용자 pull과 동시 실행되면 git 수준 ref 락 경합이 가능하므로, 배경 fetch도 `try_begin_op`을 **논블로킹으로 시도하고, 실패하면 그 레포는 이번 사이클을 건너뛴다**(사용자 작업 우선). 역방향 — 배경 fetch가 락 보유 중 사용자가 커밋을 누르면 `OpInProgress` 거절 — 은 45초 상한·5분 주기로 창이 작다(§6에 위험으로 기록).

### 3.5 레이트리밋·스킵 전략

| 항목 | 값 | 비고 |
|---|---|---|
| 기본 주기 | 5분 (설정 `remoteRefreshMinutes`, 0=끔) | §3.7 마이그레이션 |
| 동시 fetch 상한 | 3 (`tokio::sync::Semaphore`) | 수십 프로젝트여도 네트워크 폭주 없음 |
| 포커스 복귀 트리거 | 마지막 사이클로부터 60초 이내면 no-op | 백엔드에서 판정 |
| 원격 없는 repo | `git remote` 결과 빈 값이면 스킵, 10사이클마다 재확인 | 원격 추가 대비 |
| 연속 실패 백오프 | 레포별 2^n × 주기, 상한 30분 | 오프라인·인증 실패 폭주 방지 |
| op 락 보유 중 repo | 이번 사이클 스킵 | §3.4 |
| 거대 repo | 별도 스킵 없음 | fetch 비용은 네트워크 델타 비례 — 크기 무관 |

- 레포별 결과는 `RemoteFreshness`(마지막 확인 시각·마지막 오류·실패 연속 횟수·원격 유무)로 AppState에 보관하고, **`get_statuses`가 조인해 `RepoStatus`에 실어 보낸다**(별도 조회 invoke 신설 없음 — 배치 패턴 유지). 오류 발생/해소 전이 시에만 경량 이벤트 `repo://remote-freshness`(projectId 신호)를 emit해 statuses만 무효화한다 — refs 무변화 사이클에서 오류 배지가 갱신되게.

### 3.6 UI

- **↓N/↑N 배지: 변경 없음** — 기존 렌더(`ProjectItem.tsx:147-158`)가 그대로 신선한 값을 보여주게 된다. 툴팁만 보강: `title="원격에 새 커밋 N개 — 마지막 확인 M분 전"`.
- **배지 클릭 → pull 실행은 비채택.** pull은 merge/충돌을 유발할 수 있는 파괴적 연산이고, 충돌 처리 UX(Changes 패널)와 분리된 사이드바에서 오클릭 한 번으로 실행되면 위험하다. pull은 기존 Changes 패널 버튼(`useSyncOp`, `queries/index.ts:798-824`) 경로를 유지한다. 원클릭 pull 요구가 확인되면 후속.
- fetch 실패 시: 브랜치 줄에 작은 흐린 아이콘(lucide `CloudOff` 등) + 오류 툴팁. 토스트·모달 없음(요구사항 — 조용히).
- 컨텍스트 메뉴에 "원격 새로고침" 항목 추가(`ProjectList.tsx:341-390`의 기존 MenuItem 패턴) — 해당 repo 1개에 `refresh_remotes([id])`(레이트리밋 무시, in-flight면 no-op).

### 3.7 설정 마이그레이션

`auto_fetch_minutes`(기본 0)를 그대로 켜는 대신 **`remote_refresh_minutes` 신설(기본 5)**:
- 기존 필드의 저장값 0은 "만진 적 없음"과 "명시적 끔"이 구분 불가 — 필드를 새로 파면 기존 settings.json에 키가 없어 serde default(5)가 적용돼 "알아서" 요구를 충족한다.
- 로드 시 1회 마이그레이션: 구 `auto_fetch_minutes > 0`이면 그 값을 승계. 구 필드·`useAutoFetch`·SettingsDialog의 구 입력(`src/components/settings/SettingsDialog.tsx:410-423`)은 신 필드로 교체.

### 3.8 임베디드 중첩 저장소 — v1은 최상위만 (후속)

- 자동 fetch 대상은 `state.projects`의 최상위 프로젝트만. 중첩 repo 발견은 `get_statuses`의 부수효과(`status.rs:72-91`)라, 이를 스케줄러 입력으로 삼으면 조회 타이밍에 결합되고 삭제된 중첩 repo가 좀비 대상으로 남는다.
- **중복 fetch 문제는 없다** — 중첩 repo는 자체 `.git`과 자체 원격을 가지므로 outer fetch가 이를 대신하지 않고, 겹치지도 않는다.
- 중첩 repo의 수동 fetch/pull은 합성 id로 이미 동작한다(`projects.rs:20-25`). 자동 포함(발견 결과를 freshness 레지스트리에 캐시해 스케줄 대상에 합류)은 **후속**.

## 4. 계약(타입·커맨드·이벤트)

```rust
// src-tauri/src/fetch_scheduler.rs (신설)
pub struct RemoteFreshness {
    pub last_checked_at: Option<String>, // ISO 8601 — 마지막 fetch 성공 시각
    pub error: Option<String>,           // 마지막 실패 사유(분류 메시지). None=정상
    pub failure_streak: u32,             // 백오프 지수
    pub has_remote: Option<bool>,        // None=미확인, Some(false)=스킵 대상
}

/// setup에서 1회 spawn. interval마다: 설정 주기 확인 → 대상 선정(§3.5 스킵 규칙)
/// → Semaphore(3)로 fetch --quiet --no-write-fetch-head (45s 타임아웃, try_begin_op 논블로킹)
/// → freshness 갱신, 오류 전이 시 repo://remote-freshness emit.
pub fn spawn(app: tauri::AppHandle);

/// 수동/포커스 복귀 트리거 — 즉시 반환(백그라운드 진행).
/// project_ids 비면 전체. force=false면 마지막 사이클 60s 이내 no-op.
#[tauri::command]
pub async fn refresh_remotes(
    app: tauri::AppHandle, state: State<'_, AppState>,
    project_ids: Vec<String>, force: bool,
) -> Result<(), IpcError>;

// src-tauri/src/state.rs — AppState 확장
pub freshness: RwLock<HashMap<String, RemoteFreshness>>, // projectId → freshness

// src-tauri/src/git/runner.rs — 배경 fetch 전용 env 주입 변형 (기존 run_git 위임)
pub async fn run_git_env(
    cwd: Option<&Path>, args: &[&str],
    extra_env: &[(&str, &str)], timeout_secs: u64,
) -> Result<GitOutput, IpcError>;

// src-tauri/src/git/types.rs — RepoStatus 확장 (get_statuses가 freshness 조인)
pub struct RepoStatus {
    // ... 기존 필드 ...
    pub last_fetch_at: Option<String>, // 배경/수동 fetch 마지막 성공 시각
    pub fetch_error: Option<String>,   // 마지막 배경 fetch 실패 사유 (조용한 배지용)
}

// types.rs Settings — 필드 교체 (§3.7)
pub remote_refresh_minutes: u32, // 기본 5, 0 = 끔  (auto_fetch_minutes 대체·마이그레이션)
```

```ts
// src/lib/ipc.ts
refreshRemotes: (projectIds: string[], force = false) =>
  callMutating<void>("refresh_remotes", { projectIds, force }),
// RepoStatus에 lastFetchAt: string | null; fetchError: string | null; 추가
// Settings: autoFetchMinutes → remoteRefreshMinutes

// 이벤트 (신호 전용 — 오류 발생/해소 전이 시에만)
// "repo://remote-freshness"  payload: { projectId: string }
//   → events.ts에서 qc.invalidateQueries({ queryKey: ["statuses"] }) 만 수행

// 프론트 변경점
// - useAutoFetch(queries/index.ts:581) 삭제, App.tsx:44 호출 제거
// - App 레벨: window focus 시 ipc.refreshRemotes([], false) 1회 (throttle은 백엔드)
// - ProjectItem: fetchError 배지 + ↓N 툴팁에 lastFetchAt 상대시각
// - ProjectList 컨텍스트 메뉴: "원격 새로고침" → ipc.refreshRemotes([id], true)
```

- `lib.rs`: `fetch_scheduler::spawn(app.handle().clone())` 을 setup에 추가, `refresh_remotes` 를 invoke_handler에 등록.
- 이벤트/커맨드 신설은 위 2개뿐 — 주기 갱신의 정상 경로는 기존 `repo://changed` → statuses 무효화를 그대로 탄다.

## 5. 단계(구현 순서)

1. **백엔드 코어**: `run_git_env` 추가 → `fetch_scheduler.rs`(interval 루프·대상 선정·Semaphore·백오프·freshness map·git <2.29 폴백) → setup spawn. 유닛테스트: 스킵 규칙(원격 없음/백오프/락 점유), 백오프 계산.
2. **상태 조인**: `RepoStatus`에 `last_fetch_at`/`fetch_error` 추가, `get_statuses`에서 freshness 조인, `repo://remote-freshness` emit. ipc.ts 타입 반영.
3. **트리거 경로**: `refresh_remotes` 커맨드 + 등록, 프론트 포커스 트리거, `useAutoFetch` 제거.
4. **설정**: `remote_refresh_minutes` 신설 + 1회 마이그레이션 + SettingsDialog 입력 교체(문구: "0 = 끔 · 기본 5분").
5. **UI**: ProjectItem 오류 배지·툴팁, ProjectList 컨텍스트 메뉴 항목.
6. **E2E**(`tests/e2e/` 하네스): 로컬 bare repo를 `file://` 원격으로 사용(자격증명 불요·오프라인 가능) — 원격에 커밋 추가 → `refresh_remotes` → 사이드바 ↓N 표시 검증, 원격 제거 후 오류 배지 검증.

규모: **M** — 백엔드 신설 모듈 ~200 LOC + 기존 파일 소폭 수정 + 프론트 ~60 LOC.

## 6. 위험과 완화

| 위험 | 완화 |
|---|---|
| GCM/자격증명 팝업 억제 불완전 — credential helper 구성(GCM 버전, wincred, 사내 helper)에 따라 GUI가 뜰 수 있음 | `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` + `credential.interactive=false` 3중. 잔여 케이스는 발생 시 helper별 env 추가. 인증 실패 repo는 백오프로 시도 빈도 자체가 급감 |
| 배경 fetch가 op 락 보유 중(최대 45초) 사용자 커밋/스테이지가 `OpInProgress`로 거절 | 45s 타임아웃 + 5분 주기로 충돌 창 ≈1.5% 이하. 배경 fetch는 락 경합 시 스킵(사용자 우선). 후속: 사용자 작업 진입 시 배경 fetch 취소 |
| `--no-write-fetch-head` 미지원(git <2.29) | "unknown option" 실패 시 플래그 제거 재시도(1회 감지 후 캐시), 또는 기존 `check_git` 버전으로 사전 판별 |
| SSH passphrase 키(agent 미등록) 사용자는 배경 fetch 상시 실패 | BatchMode 실패는 fetch_error 배지로만 표면화 + 백오프. `GIT_SSH_COMMAND` 기설정 시 미개입 |
| 원격 새 커밋이 잦은 팀 repo에서 5분마다 refs 갱신 → watcher → status 재실행 비용 | 의도된 동작(그게 이 기능). 변화 없는 사이클은 `--no-write-fetch-head`로 워처 이벤트 0회 |
| 마이그레이션이 기존 "명시적 끔(0)" 사용자를 자동 ON으로 전환 | 요구사항 자체가 자동화 요청. 설정에서 0으로 재차 끄면 신 필드에 영속 — 이후 재전환 없음 |
