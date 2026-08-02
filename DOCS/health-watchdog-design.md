<!-- 2026-08-01 systemd-oomd 강제 종료 사건 조사 결과.
     14개 에이전트 병렬 정독 + 적대적 검증 (37건 발견 / 35건 검증 통과). -->

실측 검증을 마쳤다. 아래가 설계 문서다.

---

# "갑자기 꺼짐" 조기경보 시스템 설계

## 0. 요약 — 왜 지금은 못 막고, 무엇을 보면 막을 수 있나

**현재 앱은 자기가 죽기 직전이라는 걸 알 방법이 구조적으로 없다.** `App.tsx:74-88`에 이미 "이전 실행 오류 감지" 배너가 있지만, 그 트리거는 `getLogStatus().lastCrashAt` = **panic.log의 mtime**이다. systemd-oomd의 SIGKILL은 패닉이 아니라 외부 종료라 panic.log를 만들지 않는다 → **이 경로는 이번 사건에서 한 번도 발화하지 않았고, 앞으로도 발화하지 않는다.** 이것이 1순위로 메워야 할 구멍이다.

이 머신에서 `oomctl`로 **사망 규칙을 실측 확정**했다(추측 아님):

```
Swap Used Limit: 90.00%
Default Memory Pressure Limit: 60.00%
Default Memory Pressure Duration: 20s
Memory Pressure Monitored CGroups:
    Path: /user.slice/user-1000.slice/user@1000.service
        Memory Pressure Limit: 50.00%
        Pgscan: 37894984   Last Pgscan: 37894984
```
`/usr/lib/systemd/system/user@.service.d/10-oomd-user-service-defaults.conf` → `ManagedOOMMemoryPressure=kill`, `ManagedOOMMemoryPressureLimit=50%`

즉 사망 조건은 정확히 **3단 논리**다:

1. **발화**: `user@1000.service`의 `memory.pressure` avg10이 **50%를 20초간 초과**.
2. **희생자 선정**: oomd가 그 하위 cgroup들을 **pgscan(페이지 회수) 증가율**로 정렬해 1위를 죽인다 (oomctl의 `Pgscan/Last Pgscan` 필드가 이 방식임을 확증).
3. **집행**: 선정된 scope의 `cgroup.procs`를 순회하며 전원 SIGKILL → 저널의 `killed 387 process(es)`.

**설계의 핵심 통찰**: 앱은 (1) oomd가 보는 바로 그 파일(`user@1000.service/memory.pressure`)을 **똑같이 읽을 수 있고**, (2) `memory.stat`의 `pgscan`으로 **자기가 희생자 1순위인지까지 계산할 수 있다**. 둘 다 실측으로 읽기 성공했고 비용은 마이크로초 단위다. 즉 이 경보 시스템은 추정이 아니라 **oomd와 동일한 입력을 공유하는 미러링**이다.

---

## 1. 감지 — 신호별 가용성·정확도·비용 (전부 이 머신 실측)

### 1.1 실측 결과

| 신호 | 경로 | 가용 | 비용/read | 실측값 |
|---|---|---|---|---|
| **앵커 압박** ★핵심 | `<user@N.service>/memory.pressure` | ✅ | 9.2 µs | `some/full avg10` |
| **앵커 pgscan** ★핵심 | `<user@N.service>/memory.stat` | ✅ | 21.8 µs | `pgscan 38276394` |
| **자기 scope 압박** | `<own scope>/memory.pressure` | ✅ | 9.2 µs | 106 B |
| **자기 scope pgscan** ★희생자 판정 | `<own scope>/memory.stat` | ✅ | 21.8 µs | `pgscan 4303944` |
| **자기 scope 총 메모리** | `<own scope>/memory.current` | ✅ | 7.9 µs | 5,035,884,544 |
| **자기 scope 최대치** | `<own scope>/memory.peak` | ✅ | ~8 µs | 6,592,557,056 |
| **자기 scope 프로세스 수** ★387의 직접 지표 | `<own scope>/cgroup.procs` | ✅ | 10.7 µs (14개), ~30 µs (400개 추정) | 14줄 |
| **커널 OOM 발생 이력** | `<own scope>/memory.events` | ✅ | ~8 µs | `oom 0 / oom_kill 0` |
| 시스템 PSI | `/proc/pressure/memory` | ✅ | 7.8 µs | some/full avg10/60/300 |
| 시스템 메모리·스왑 | `/proc/meminfo` | ✅ | 9.1 µs | MemAvailable, SwapFree |
| 스레드 수 | `/proc/self/status` | ✅ | ~8 µs | Threads |

### 1.2 채택/기각 판단

**★ 채택: 앵커(`user@1000.service`) `memory.pressure`** — oomd가 실제로 읽는 **바로 그 파일**이다. 다른 어떤 지표보다 정확하다. 앵커 경로는 `/proc/self/cgroup`을 파싱해 `user@<uid>.service` 세그먼트까지 잘라 얻는다(실측 성공):
```
own   : /user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-....scope
anchor: /user.slice/user-1000.slice/user@1000.service
```

> **주의**: oomd 249 소스(`oomd_pressure_above()`)는 `PRESSURE_TYPE_FULL`의 avg10을 임계와 비교한다. 이 부분만은 이 머신에서 직접 확인하지 못했다(oomctl 출력은 어느 줄인지 구분해주지 않는다). 다만 **항상 `some ≥ full`** 이므로, 설계는 **`some`을 조기경보용, `full`을 사망근접 판정용으로 둘 다** 읽는다 — 어느 쪽이 진짜 입력이든 우리가 더 일찍 경보한다. 안전한 방향의 불확실성이다.

**★ 채택: pgscan 비율 = "내가 희생자 1순위인가"** — 이게 이 설계의 차별점이다. oomd의 선정 기준을 그대로 계산한다:
```
victim_share = Δ(own scope pgscan) / Δ(anchor pgscan)
```
0.5를 넘으면 **이 시스템에서 회수 압박의 절반 이상을 우리가 만들고 있다** = 압박이 임계를 넘는 순간 죽는 건 우리다. 압박이 아직 낮아도 이 값이 높으면 "지금은 안전하지만 다음 압박 때 1순위"라는 예고가 된다.

**★ 채택: `cgroup.procs` 줄 수** — 387의 직접 지표. **`pids.current`는 쓰면 안 된다**: 실측에서 `pids.current=98` vs `cgroup.procs=14줄`이었다. `pids.current`는 **스레드**를 센다. oomd가 센 387은 `cgroup.procs` 기준이므로 반드시 줄 수를 써야 한다.

**⚠ 기각: `memory.max` 기반 판정** — 실측 `memory.max = max`, `memory.high = max`. **앱 scope에는 메모리 한도가 아예 없다.** 따라서 "한도 대비 몇 %" 식 계산은 불가능하다. 분모는 반드시 `MemTotal`(시스템 전체)을 써야 한다. 이 함정을 모르고 `memory.current/memory.max`를 쓰면 항상 0으로 나온다.

**⚠ 부분 기각: 스왑** — oomd의 `Swap Used Limit: 90%`는 살아있지만 실측 `Swap Monitored CGroups:` 목록이 **비어 있다**(현재 이 사용자에겐 스왑 경로로는 안 죽는다). 게다가 스왑이 2GB뿐이라 32GB RAM 대비 완충 역할이 거의 없다. **보조 신호로만** 쓴다.

**⚠ 좀비 카운트**: 좀비는 `cgroup.procs`에 없다(선행 조사에서 실측 확인됨). 세려면 `/proc/*/status`에서 `PPid == 우리 pid && State == Z`를 전수 스캔해야 하고 ~8 ms 든다. **5분 주기 느린 티어에서만** 수집한다(0.003% 부하).

### 1.3 샘플링 비용 총계

| 티어 | 주기 | 읽는 것 | 비용 |
|---|---|---|---|
| 빠름 | 2초 (경고 이상 시 **500 ms**) | 앵커 pressure + 앵커/자기 memory.stat + 자기 memory.current + meminfo | **~70 µs** |
| 느림 | 30초 | cgroup.procs, memory.peak, memory.events, /proc/self/status | ~60 µs |
| 진단 | 5분 | 좀비 전수 스캔 + 헬스 로그 1줄 + 하트비트 기록 | ~8 ms |

2초 티어 기준 **CPU 점유 0.0035%**. 요구사항("500 ms 폴링에 얹을 수 있는 저비용")을 만족하고도 남아, **위험 단계에서 500 ms로 가속**해도 0.014%다. 적응형 주기를 채택한다.

---

## 2. 경보 단계 — 임계값과 상태 머신

### 2.1 임계 표 (근거: oomd 실측 임계 50%/20s, 스왑 90%)

| 신호 | 🟡 주의 | 🟠 경고 | 🔴 위험 | 근거 |
|---|---|---|---|---|
| 앵커 `full avg10` | ≥ 8% | ≥ 20% | **≥ 35%** | oomd 사망선 50% 대비 70% 지점 |
| 앵커 `some avg10` | ≥ 15% | ≥ 30% | ≥ 45% | full의 선행 지표 |
| **victim_share** (pgscan) | ≥ 0.35 | ≥ 0.5 **AND** full≥10% | ≥ 0.5 **AND** full≥20% | 선정 규칙 미러 |
| 자기 scope `memory.current` / MemTotal | ≥ 25% | ≥ 40% | ≥ 55% | 32 GB 기준 8/12.8/17.6 GB |
| **자기 scope 프로세스 수** | ≥ 60 | ≥ 120 | ≥ 200 | 정상 4~6, 사망 시 387 |
| 1시간 프로세스 증가량 | +15 | +40 | — | 누수 진단 전용 |
| MemAvailable / MemTotal | ≤ 15% | ≤ 8% | ≤ 4% | 실측 여유 18.7 GB |
| 스왑 사용률 | ≥ 60% | ≥ 75% | ≥ 85% | oomd 90% 대비 여유 |

**최종 레벨 = 전 신호 레벨의 최댓값.**

프로세스 수 임계를 60/120/200으로 잡은 이유: LSP 12레포 + 터미널 8개(각 dev 서버 2~3 프로세스) + 브라우저면 정상적으로 40~50까지 간다. 60 미만에서 울리면 늑대소년이 된다. 반대로 200이면 387의 절반이라 충분한 여유가 있다.

### 2.2 승격/강등 (플래핑 방지)

- **승격 조건(dwell)**: 주의 3틱, 경고 5틱(=10초), 위험 3틱(=6초, 500 ms 가속 시 1.5초) 연속 충족.
  - 위험의 dwell을 짧게 잡은 이유: oomd는 **20초** 유지에서 죽인다. 6초 안에 판정해야 사용자에게 저장할 시간이 남는다.
- **강등 조건**: 한 단계 아래 임계 밑으로 **60초 연속** 유지. 즉시 강등하지 않는다.
- **프로세스 수 신호는 강등하지 않는다** — 누수는 저절로 낫지 않는다. 정리 액션이 실제로 수를 줄였을 때만 재평가한다.

### 2.3 단계별 동작

| | 🟡 주의 | 🟠 경고 | 🔴 위험 |
|---|---|---|---|
| OS 토스트 | ✗ (늑대소년 방지) | ✓ 1회, 10분 쿨다운 | ✓ 즉시 + 재알림 3분 |
| 인앱 배너 | ✗ (상태바 칩만) | ✓ 닫기 가능 | ✓ **레벨 하락 전엔 안 닫힘** |
| 상태바 칩 | 앰버 | 주황 + 수치 | 적색 점멸 |
| 초안 강제 저장 | ✗ | ✓ (`health://flush-drafts`) | ✓ + 동기 flush |
| 자동 방어 | 좀비 리핑만 | 1단계 (아래 §4) | 2단계 (아래 §4) |
| 샘플링 주기 | 2초 | **500 ms** | **500 ms** |
| 로그 | `info` | `warn` | `error` + 전체 스냅샷 덤프 |

---

## 3. 알림 UX — 실제 문구

원칙: **원인 → 결과 → 지금 할 일**을 한 화면에. "메모리 부족"만 띄우면 사용자는 아무것도 못 한다.

### 3.1 OS 토스트

**🟠 경고 — 메모리 압박형**
> **제목**: Gitpervisor — 강제 종료 위험
> **본문**: 시스템 메모리 압박이 높습니다(47%). 이 상태가 계속되면 OS가 앱을 예고 없이 종료합니다. 작업을 저장하고 앱 창에서 [정리하기]를 눌러 주세요.

**🟠 경고 — 프로세스 누수형** (프로세스 수 신호가 최고 레벨일 때 문구 분기)
> **제목**: Gitpervisor — 백그라운드 프로세스 과다
> **본문**: 앱에 딸린 프로세스가 143개로 늘었습니다(정상 5~40개). 닫은 터미널·언어 서버가 남아 있을 수 있습니다. 앱 창의 [정리하기]로 회수하세요.

**🔴 위험**
> **제목**: Gitpervisor — 곧 강제 종료됩니다
> **본문**: 지금 저장하세요. 메모리 압박 41%(한계 50%)로 OS가 수십 초 내 앱을 종료할 수 있습니다. 작성 중인 커밋 메시지와 메모는 자동 저장했습니다.

### 3.2 인앱 배너 (`HealthBanner`)

App.tsx 최상단, TitleBar 바로 아래 고정. 위험 단계 예:

```
┌────────────────────────────────────────────────────────────────────────┐
│ 🔴  곧 강제 종료될 수 있습니다                                          │
│                                                                        │
│  시스템 메모리 압박  41%  ▓▓▓▓▓▓▓▓▓░  (OS 종료 기준 50%)               │
│  이 앱이 쓰는 메모리  14.2 GB / 31.2 GB                                 │
│  앱에 딸린 프로세스   212개  (정상 5~40개, 1시간 새 +38)                │
│  이 앱이 만든 메모리 회수 부담  63%  ← 종료 대상 1순위입니다            │
│                                                                        │
│  작성 중이던 커밋 메시지·메모는 방금 자동 저장했습니다.                 │
│                                                                        │
│  [ 정리하기 (212 → 예상 24개) ]  [ 리소스 모니터 ]  [ 안전하게 재시작 ] │
└────────────────────────────────────────────────────────────────────────┘
```

문구 설계 근거:
- **"OS 종료 기준 50%"** — 실측한 진짜 숫자를 보여준다. 사용자가 게이지를 읽고 스스로 판단할 수 있다.
- **"종료 대상 1순위입니다"** — victim_share가 알려주는 정보. 시스템이 압박받아도 다른 앱이 죽을 수도 있다는 걸 구분해 준다.
- **"212 → 예상 24개"** — 정리 버튼이 무엇을 할지 미리 알려준다. 파괴적 액션의 불확실성 제거.
- **"방금 자동 저장했습니다"** — 사용자의 1순위 불안(작업 유실)을 먼저 해소한다.

주의 단계는 배너 없이 **상태바 칩**만:
> `⚠ 프로세스 68` — 클릭 시 배너 펼침

### 3.3 정리 확인 모달 (기존 `useUi.askConfirm` 재사용)

```
제목: 백그라운드 프로세스 정리
본문: 앱이 회수할 수 있는 항목만 정리합니다. 실행 중인 터미널과 그 안의
      명령(dev 서버 등)은 건드리지 않습니다.
상세:
      좀비 프로세스           41개  → 회수
      유휴 언어 서버(10분+)    9개  → 종료 (파일 열면 자동 재시작)
      로컬 프리뷰 서버         3개  → 종료 (다시 열면 재생성)
      닫힌 터미널의 잔류 셸    6개  → 종료
      ─────────────────────────────
      건드리지 않음: 터미널 8개, 그 안의 프로세스 47개
[정리하기]  [취소]
```

---

## 4. 자동 방어

**대원칙: 사용자 소유 프로세스는 동의 없이 절대 죽이지 않는다.** 터미널의 `npm run dev`를 앱이 멋대로 죽이면 그게 더 큰 사고다. 자동 방어는 **앱이 만들었고, 재생성 가능하며, 사용자에게 안 보이는 것**에만 적용한다.

### 4.1 상시 (레벨 무관)
- **좀비 리퍼 스레드**: 30초마다 `waitpid(-1, WNOHANG)` 루프가 아니라 — 그건 git/tools/PTY의 `.wait()`를 ECHILD로 깨뜨린다(선행 조사 경고). 대신 **각 spawn 지점에서 `reap_detached(child)`** 로 회수하는 게 정답이고, 헬스 시스템은 **좀비 수를 세어 경보만** 한다. 좀비가 계속 늘면 그건 코드 결함이니 로그로 잡아내는 게 목적이다.

### 4.2 🟠 경고 — 1단계 (무해·자동, 사용자 확인 없음)
1. **유휴 LSP 종료**: `lsp.rs` 리퍼의 유휴 기준을 10분 → **3분으로 임시 단축**. 파일을 다시 열면 자동 재기동되므로 손실 0.
2. **스테일 프리뷰 엔트리 청소**: `reg.ports.retain(|_, e| e.alive.load(...))`.
3. **배경 fetch 일시 중지**: `fetch_scheduler`에 `PAUSED: AtomicBool`. 12레포 × HTTPS 헬퍼 체인이 압박 중에 도는 걸 막는다. 강등 시 자동 해제.
4. **sysmon 폴링 감속**: 리소스 모니터가 열려 있으면 2초 → 5초. 압박 상황에서 `/proc` 전수 스캔이 압박을 키우는 역설을 끊는다.
5. `health://flush-drafts` 발행.

### 4.3 🔴 위험 — 2단계 (자동 + 강한 안내)
6. **전 LSP 종료** (`lsp_kill_all` + wait). node 계열은 개당 200 MB~1 GB라 가장 큰 즉효.
7. **비활성 브라우저 자식 webview 종료**: 현재 보이지 않는 임베디드 브라우저 탭.
8. **신규 spawn 게이트**: `HealthGate::allow_spawn()` — 위험 단계에서 새 LSP/프리뷰/브라우저 생성을 거절하고 "메모리 압박으로 일시 제한됨" 토스트. **터미널 열기와 git 작업은 막지 않는다**(사용자의 핵심 작업이라 막으면 앱이 고장난 것처럼 보인다).
9. **[안전하게 재시작] 버튼 제공** — 누르면 정리 → 초안 flush → 세션 상태 저장 → `relaunch()`. **자동으로 재시작하지는 않는다.** 사용자 동의 없는 재시작은 그 자체가 작업 유실이다.

### 4.4 하지 않는 것 (명시)
- ❌ 터미널 PTY·그 자손 자동 종료
- ❌ 자동 재시작
- ❌ `memory.high` 자기 설정 — scope에 쓰기 권한이 없고, 있어도 자기 스로틀링은 앱을 먹통으로 만든다
- ❌ 전역 `signal(SIGCHLD, SIG_IGN)` — 다른 서브시스템의 `.wait()`가 ECHILD로 깨진다

---

## 5. 작업 유실 방지

### 5.1 현황 실측

| 데이터 | 저장 방식 | 유실 위험 |
|---|---|---|
| **커밋 메시지** | `CommitForm.tsx:18` `useState("")` | 🔴 **전량 유실** — 디스크에 안 남음 |
| 메모 | `notes.rs`: `add/update/delete_memo` 전부 `persist()` → `save_notes()` 즉시 디스크 | 🟢 안전 |
| 프로젝트 목록 | `projects.json` 즉시 저장 | 🟢 안전 |
| 터미널 레이아웃 | `localStorage["gp:terminals"]` | 🟢 안전 |
| 뷰어 탭 | `ui.ts` localStorage 영속 | 🟢 안전 |

**결론: 유일한 실질 유실 지점은 커밋 메시지다.** 긴 커밋 메시지를 작성 중 죽으면 그대로 사라진다. 메모는 이미 완벽하니 손대지 않는다(다만 `update_memo`가 키 입력마다 전체 맵을 직렬화하므로 프론트 300 ms 디바운스 권장 — 유실 문제가 아니라 I/O 위생 이슈).

### 5.2 조치

**(a) 커밋 메시지 초안 영속** — 가장 작고 가장 가치 있는 수정.
```ts
// CommitForm.tsx
const DRAFT_KEY = (pid: string) => `gp:commit-draft:${pid}`;
const [message, setMessage] = useState(
  () => localStorage.getItem(DRAFT_KEY(projectId)) ?? "",
);
// 300ms 디바운스로 기록, 커밋 성공 시 removeItem
useEffect(() => {
  const t = setTimeout(() => {
    try {
      if (message) localStorage.setItem(DRAFT_KEY(projectId), message);
      else localStorage.removeItem(DRAFT_KEY(projectId));
    } catch { /* 무시 */ }
  }, 300);
  return () => clearTimeout(t);
}, [message, projectId]);
```
> localStorage는 WebKitGTK가 자체 타이밍으로 flush하므로 SIGKILL 직전 300 ms는 이론상 유실 가능하다. 그래서 위험 단계에서는 **백엔드 파일 저장으로 이중화**한다(아래 b).

**(b) `health://flush-drafts` 프로토콜** — 경고 진입 시 백엔드가 이벤트 발행 → 미저장 상태를 가진 컴포넌트가 즉시 flush. 커밋 폼은 디바운스를 건너뛰고 `ipc.saveDraft(projectId, message)`로 **백엔드 `drafts.json`에 동기 기록**한다. 재시작 시 복원하며 "이전에 작성 중이던 커밋 메시지를 복원했습니다" 토스트.

**(c) 복원 UX** — 초안이 있으면 커밋 폼 상단에 옅은 힌트: `작성 중이던 내용을 복원했습니다 · [지우기]`

---

## 6. 크래시 사후 진단 + 로그 문제

### 6.1 하트비트 센티널 — oomd 사망을 확실히 잡는 유일한 방법

앱이 SIGKILL로 죽으면 **어떤 종료 훅도 안 돈다.** 유일한 해법은 **살아있는 동안 미리 기록**해 두고, 다음 부팅에서 "깨끗하게 끝났다는 표시가 없다"를 근거로 역추론하는 것이다.

`~/.local/share/com.greathoon.gitpervisor/logs/session.json`:
```json
{
  "pid": 3074382,
  "version": "0.3.2",
  "started_at": "2026-07-22T13:52:10+09:00",
  "updated_at": "2026-08-01T15:39:45+09:00",
  "clean_exit": false,
  "last": {
    "level": "danger",
    "scope_procs": 371,
    "scope_mem_bytes": 15234891776,
    "scope_mem_peak": 16112973824,
    "anchor_pressure_full_avg10": 44.3,
    "anchor_pressure_some_avg10": 61.0,
    "victim_share": 0.71,
    "mem_available_pct": 3.4,
    "swap_used_pct": 88.0,
    "zombies": 46,
    "terminals": 11, "lsp": 9, "browsers": 2, "threads": 84,
    "cgroup_oom_kill": 0
  },
  "top_procs": [
    { "name": "node", "count": 46, "rss": 6871947673 },
    { "name": "chrome", "count": 118, "rss": 4294967296 }
  ]
}
```

- **30초마다** 원자적 갱신(`session.json.tmp` 쓰기 → `rename`). 부분 쓰기로 파일이 깨질 일이 없다.
- **정상 종료**(`RunEvent::Exit` / 메인 창 Destroyed) 시 `clean_exit: true`.
- **다음 시작 시**: `clean_exit == false` → **비정상 종료 확정**. `session.prev.json`으로 이름을 바꿔 보관하고 사용자에게 알린다.

이 파일 하나면 이번 사건이 **1초 만에 진단**됐을 것이다: 프로세스 371개, 앱 메모리 15 GB, victim_share 0.71.

### 6.2 재시작 시 안내 (기존 크래시 배너를 확장)

`App.tsx:74-88`의 기존 로직을 `health_prev_session()` 통합 판정으로 교체한다. 이유는 §0 — panic.log만 보면 oomd 사망을 영원히 놓친다.

```
┌────────────────────────────────────────────────────────────────────┐
│ ⚠  지난 실행이 비정상 종료되었습니다                                │
│                                                                    │
│  2026-08-01 15:39 (마지막 기록) · 패닉 로그 없음                    │
│  → OS의 메모리 부족 강제 종료로 보입니다.                           │
│                                                                    │
│  종료 직전 상태:                                                    │
│    앱에 딸린 프로세스   371개  (정상 5~40개)                        │
│    앱이 쓰던 메모리     15.2 GB / 31.2 GB                           │
│    메모리 압박          44%  (OS 종료 기준 50%)                     │
│                                                                    │
│  프로세스가 비정상적으로 많았습니다. 터미널에서 실행한 dev 서버나   │
│  외부 브라우저가 앱에 딸려 남아 있었을 가능성이 큽니다.             │
│                                                                    │
│  작성 중이던 커밋 메시지 1건을 복원했습니다.                        │
│                                                                    │
│  [ 자세히 (진단/로그) ]   [ 닫기 ]                                  │
└────────────────────────────────────────────────────────────────────┘
```

판정 분기:
| prev 상태 | 진단 문구 |
|---|---|
| `clean_exit=false` + panic.log mtime 근접 | "앱 내부 오류(패닉)로 종료" |
| `clean_exit=false` + `last.level` ∈ {warn,danger} | "OS 메모리 부족 강제 종료로 보입니다" |
| `clean_exit=false` + `cgroup_oom_kill > 0` | "커널 OOM Killer가 하위 프로세스를 종료" |
| `clean_exit=false` + 지표 정상 | "원인 불명(전원/세션 종료 등)" — 과잉 단정 금지 |

**(선택) 저널 조회**: `journalctl --user -b -q -g oomd` 로 확정할 수 있지만 (a) 권한이 필요하고 (b) 자식 프로세스를 또 띄우는 아이러니가 있다. **자동 실행하지 않고** 진단 화면의 [저널에서 확인] 버튼으로만 제공하되, 반드시 `.output()`(wait 포함)으로 회수한다.

### 6.3 로그 문제 해결 (5주 160줄 → 유의미한 기록)

실측 문제: 총 160줄 중 zbus 노이즈 84줄(52%), 앱 자신은 9줄(전부 "시작 v0.x"). **387개가 쌓이는 5주간 신호가 0줄이었다.**

**(a) 노이즈 차단** — `lib.rs:212`
```rust
tauri_plugin_log::Builder::new()
    .level(log::LevelFilter::Info)
    .level_for("zbus", log::LevelFilter::Warn)
    .level_for("tracing", log::LevelFilter::Warn)
    .level_for("hyper", log::LevelFilter::Warn)
    .level_for("reqwest", log::LevelFilter::Warn)
    .level_for("rustls", log::LevelFilter::Warn)
    .level_for("notify", log::LevelFilter::Warn)
```
이것만으로 로그의 52%가 사라진다.

**(b) 5분 헬스 라인** (평시에도 남는 유일한 정기 기록)
```
[health] lv=ok procs=23 mem=2.1GB(6.7%) peak=2.4GB press_full10=0.0% \
         press_some10=0.4% victim=0.08 avail=58% swap=2% zombies=0 \
         term=4 lsp=3 br=1 thr=41
```
10일이면 2,880줄. 프로세스가 23 → 100 → 250으로 가는 궤적이 **그대로 보인다.** 이번 사건 진단이 사후 포렌식이 아니라 로그 grep 한 번이 됐을 것이다.

**(c) 레벨 전이 로그** — `warn`/`error`로 원인 신호까지 명시
```
[health] 레벨 상승 ok→warn 원인=procs(127>=120), mem_share(41%>=40%)
[health] 자동정리 실행: lsp 9종료, preview 3종료, zombie 41회수 → procs 127→68
```

**(d) 자식 프로세스 생명주기 로그** — 다른 조사에서 나온 spawn/reap 결함들과 공유하는 규약
```rust
log::info!("spawn {kind} pid={pid} ctx={ctx}");
log::info!("reap  {kind} pid={pid} status={status}");
```

**(e) 로그 예산 재확인** — `diagnostics.rs`의 `LOG_DIR_BUDGET` 100 MB / `KeepSome(8)`는 이미 올바르다. 위 추가분(2,880줄/10일 ≈ 300 KB)은 예산에 영향이 없다. **`prune_logs`가 `session.prev.json`을 지우지 않도록 보존 목록에 추가**해야 한다(현재는 `panic.log`/`panic.log.1`만 보존).

---

## 7. 구현 스케치

### 7.1 신규/수정 파일

```
src-tauri/src/health/
├── mod.rs        헬스 감시 스레드, 3단계 상태 머신, 승격/강등, Tauri 커맨드
├── probe.rs      플랫폼별 신호 수집 (Linux cgroup v2/PSI, mac/win 폴백)
├── session.rs    하트비트 센티널 쓰기 + 직전 세션 비정상 종료 판정
└── relieve.rs    자동 방어 액션 (좀비 집계, LSP/프리뷰/브라우저 회수)

수정:
src-tauri/src/lib.rs             health::spawn_watchdog(), 로그 필터, RunEvent::Exit 훅
src-tauri/src/commands/mod.rs    재노출
src-tauri/src/fetch_scheduler.rs PAUSED: AtomicBool
src-tauri/src/commands/lsp.rs    유휴 기준을 AtomicU64로 (경고 시 3분 단축)
src-tauri/src/commands/preview.rs 스테일 엔트리 retain

src/stores/health.ts                    zustand — 레벨/스냅샷/배너 상태
src/components/common/HealthBanner.tsx  인앱 배너 (App.tsx에 마운트)
src/components/common/PrevSessionDialog.tsx  재시작 시 비정상 종료 안내
src/lib/health-notify.ts                OS 토스트 (레벨 전이 시)
src/lib/os-notify.ts                    agent-notify.ts의 fire() 추출·공용화
수정: src/App.tsx (배너 마운트, 기존 크래시 배너 → PrevSession으로 교체)
수정: src/components/StatusBar.tsx (헬스 칩)
수정: src/components/changes/CommitForm.tsx (초안 영속)
수정: src/components/settings/sections/MaintenanceSection.tsx (지난 세션 패널)
```

> `notification:default`는 `capabilities/default.json:20`에 **이미 부여돼 있다.** 권한 변경 불필요. OS 토스트는 `agent-notify.ts`의 `fire()`(Windows는 `ipc.notifyOs`, 그 외는 플러그인 `sendNotification`)를 그대로 재사용한다.

### 7.2 커맨드 / 이벤트

| 이름 | 종류 | 설명 |
|---|---|---|
| `health_snapshot` | `async` 커맨드 | 현재 스냅샷(배너·모니터가 조회) |
| `health_prev_session` | 커맨드 | 직전 세션 비정상 종료 판정 + 마지막 스냅샷 |
| `health_relieve` | `async` 커맨드 | 수동 정리. `RelieveOutcome { before, after, detail[] }` |
| `health_ack` | 커맨드 | 사용자가 해당 레벨 배너를 확인함(재알림 억제) |
| `health_save_draft` / `health_load_draft` | 커맨드 | 위험 단계 초안 이중화 |
| `health://level` | 이벤트 | **전이 시에만** 발행 `{ level, prev, snapshot, reasons[] }` |
| `health://flush-drafts` | 이벤트 | 경고 진입 시 |

**모든 커맨드는 `async fn`으로 선언한다.** 선행 조사에서 확인된 대로 `#[tauri::command]`의 동기 함수는 `ExecutionContext::Blocking` = **메인 GTK 스레드 실행**이다. 헬스 커맨드가 메인 스레드를 막으면 압박 상황에서 UI가 얼어붙는 최악의 시나리오가 된다.

**이벤트는 전이 시에만 발행한다.** 2초마다 IPC를 쏘면 그 자체가 압박 기여자가 된다(sysmon의 실수를 반복하지 않는다).

### 7.3 감시 스레드 골격

```rust
// health/mod.rs
pub fn spawn_watchdog(app: AppHandle) {
    std::thread::Builder::new()
        .name("health-watchdog".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut st = Machine::new(probe::anchor_paths());
            let mut slow = Instant::now();
            let mut diag = Instant::now();
            session::begin(&app, &st);
            loop {
                // 위험할수록 자주 본다 — 평시 2s, 경고 이상 500ms
                let tick = if st.level >= Level::Warn { 500 } else { 2000 };
                std::thread::sleep(Duration::from_millis(tick));

                st.sample_fast();                                   // ~70us
                if slow.elapsed() > Duration::from_secs(30) {
                    slow = Instant::now();
                    st.sample_slow();                               // ~60us
                    session::heartbeat(&app, &st);                  // 원자적 rename
                }
                if diag.elapsed() > Duration::from_secs(300) {
                    diag = Instant::now();
                    st.sample_zombies();                            // ~8ms
                    log::info!("{}", st.health_line());
                }
                if let Some(t) = st.evaluate() {                    // dwell·히스테리시스
                    log::warn!("레벨 {}→{} 원인={:?}", t.prev, t.level, t.reasons);
                    relieve::on_level(&app, t.level);               // 자동 방어
                    let _ = app.emit("health://level", &t);
                    if t.level >= Level::Warn {
                        let _ = app.emit("health://flush-drafts", ());
                    }
                }
            }
        })
        .ok();
}
```

### 7.4 probe.rs 핵심 (Linux)

```rust
/// /proc/self/cgroup → (자기 scope 경로, user@N.service 앵커 경로). 실측 검증됨.
pub fn anchor_paths() -> Option<(PathBuf, PathBuf)> {
    let line = fs::read_to_string("/proc/self/cgroup").ok()?;
    let rel = line.trim().split("::").nth(1)?;              // "0::/user.slice/..."
    let own = PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/'));
    let idx = rel.split('/')
        .position(|s| s.starts_with("user@") && s.ends_with(".service"))?;
    let anchor_rel: Vec<&str> = rel.split('/').take(idx + 1).collect();
    let anchor = PathBuf::from("/sys/fs/cgroup")
        .join(anchor_rel.join("/").trim_start_matches('/'));
    Some((own, anchor))
}

/// memory.pressure 의 some/full avg10. oomd 와 동일 입력.
fn pressure_avg10(dir: &Path) -> Option<(f32, f32)> { /* 2줄 파싱 */ }

/// oomd 의 희생자 선정 기준(pgscan 증가율)을 미러 — 우리 몫의 회수 부담 비율.
fn victim_share(own_d: u64, anchor_d: u64) -> f32 {
    if anchor_d == 0 { 0.0 } else { own_d as f32 / anchor_d as f32 }
}

/// ★ pids.current 를 쓰면 안 된다 — 실측 98(스레드) vs 14(프로세스).
/// oomd 가 센 387 은 cgroup.procs 기준이다.
fn scope_procs(own: &Path) -> Option<usize> {
    Some(fs::read_to_string(own.join("cgroup.procs")).ok()?.lines().count())
}
```

**폴백 처리**: cgroup v2가 없거나(v1·비systemd·컨테이너) 경로 파싱 실패 시 `/proc/pressure/memory` + `/proc/meminfo`만으로 축소 동작하고, 프로세스 수는 `/proc` 스캔(PPid 추적)으로 대체한다. 어느 것도 없으면 헬스 시스템은 조용히 비활성(레벨 항상 ok) — 앱 동작에 영향 없음.

**macOS/Windows**: PSI·cgroup 없음. `sysinfo`(이미 있는 `Monitor`)의 시스템 메모리 %와 자기 프로세스 트리 RSS/개수로 같은 3단계 머신을 돌린다. 임계만 다르게(메모리 사용률 75/85/93%). 상태 머신·UI·센티널은 100% 공유한다.

### 7.5 기존 `Monitor` 재사용 판단

**재사용하지 않는다.** 이유:
1. `Monitor`는 **프론트가 폴링할 때만** 갱신된다(`sys_metrics`/`sys_process_snapshot` 진입 시). 창이 비포커스거나 sysmon이 닫혀 있으면 아예 안 돈다 — **위험이 자라는 바로 그 시간에 눈을 감는다.**
2. `refresh_processes_specifics(All)`은 시스템 전체 `/proc` 스캔이라 프로세스 800개면 수천 회 파일 오픈이다. 헬스 감시가 쓰기엔 3~4자릿수 과하다(70 µs vs 수십 ms).
3. `Mutex<Monitor>`를 공유하면 헬스 스레드가 sysmon 폴링과 락 경합한다.

대신 **단방향 연결**만 만든다: 헬스 배너의 [리소스 모니터] 버튼이 기존 `open_sysmon_window`를 열고, 진단 5분 티어에서만 상위 프로세스 요약(`top_procs`)을 얻기 위해 `Monitor`를 `try_lock()`으로 **비차단 조회**한다(락이 잡혀 있으면 그냥 건너뛴다).

---

## 8. 비용·리스크 총정리

| 항목 | 값 |
|---|---|
| 평시 CPU | **0.0035%** (2초 × 70 µs) |
| 경고/위험 시 CPU | 0.014% (500 ms × 70 µs) |
| 메모리 | ~40 KB (256 KB 스택 예약 + 60개 링버퍼) |
| 디스크 쓰기 | 30초당 ~1 KB (session.json), 5분당 1줄 로그 |
| 추가 프로세스 | **0개** — 전부 파일 read. 이 앱의 병이 프로세스 과다인데 진단기가 프로세스를 만들면 안 된다 |
| 신규 권한 | **없음** (`notification:default` 이미 부여됨) |

**남는 한계 (정직하게)**
- oomd가 `full`이 아니라 `some`을 본다면 우리 경보가 예상보다 **일찍** 울린다(과경보 방향 — 안전).
- 압박이 20초가 아니라 순간적으로 폭증하면(거대 할당 한 방) 위험 dwell 6초 안에 죽을 수 있다. 이 경우 경보는 못 하지만 **센티널이 사후 진단은 보장**한다.
- 커널 OOM Killer(oomd가 아닌)가 자식 하나만 죽이는 경우는 `memory.events.oom_kill`로 감지되나 앱은 살아있다 → 경고 레벨로만 처리.
- 이 시스템은 **증상 경보이지 치료가 아니다.** 근본 원인(open.rs 터미널 cgroup 편입, git 손자 고아, watcher 16만 inotify, LSP 좀비)은 각 발견의 수정으로 고쳐야 한다. 다만 사용자의 요구("꺼질 염려가 생기면 알려주기라도")는 이것으로 완전히 충족되고, **수정 이후에도 회귀 감지망으로 계속 값을 한다.**

**구현 우선순위** — 가치/노력 비율 순:
1. **센티널 + 비정상 종료 안내**(§6.1-6.2) — 가장 작고, 다음 사고를 즉시 진단 가능하게 만든다
2. **로그 필터 + 5분 헬스 라인**(§6.3) — 5줄 수정, 관측 불능 상태를 끝낸다
3. **커밋 메시지 초안 영속**(§5.2a) — 10줄, 유일한 실질 작업 유실을 없앤다
4. **감시 스레드 + 3단계 + 배너/토스트**(§1-3)
5. **자동 방어**(§4)