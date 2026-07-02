# 태스크 05 — 프로세스별 CPU/GPU/RAM 사용 상세 팝업

> 상태: 설계(Design) · 대상: gitpervisor · 산출물 성격: 아키텍처/계약/단계/위험 (구현은 후속)
> 근거: 코드 실측 2026-07-02 · 관련: [06-browser-popup-window.md](06-browser-popup-window.md)(같은 플로팅 창 레시피 사용 — 의존은 아님)

## 1. 요구사항

타이틀바의 CPU/GPU/RAM 사용률 표시를 **클릭하면 팝업 창**이 열려, "어떤 프로그램이 많이 쓰고 있는지"를 프로세스 단위로 보여준다.

- 목록: 프로세스명 · PID · CPU% · RAM(절대량) · GPU%(가능한 범위에서) — Top-N(기본 20).
- 정렬 전환: CPU / RAM / GPU 기준. 클릭한 지표가 초기 정렬이 된다(CPU 클릭 → CPU순).
- 주기 갱신: 타이틀바와 동일한 2초 간격.
- "어떤 프로그램이"라는 원문 요구에 맞춰 **같은 이름 프로세스 합산(프로그램별) 보기 토글** 포함(chrome.exe ×20 같은 케이스).
- v1 비포함(후속): 프로세스 강제종료(kill) 버튼, macOS/Linux 프로세스별 GPU, 프로세스 트리/부모-자식 그룹화.

## 2. 현황(근거)

### 2.1 표시 계층 — CPU/GPU/RAM/SSD 4지표, 2초 폴링
- `src/components/SysMonitor.tsx:56-80` `SysMonitor` — 타이틀바에 CPU/GPU/RAM/SSD 4개 `Metric` 렌더. 컨테이너(`:60`)와 각 `Metric`(`:27`)에 `data-tauri-drag-region`이 붙어 있어 **현재 클릭하면 창 드래그가 시작된다**(클릭 핸들러 없음). 배치는 `src/components/TitleBar.tsx:59`.
- `src/queries/index.ts:216-229` `useSysMetrics` — `refetchInterval: 2000`, `refetchIntervalInBackground: false`(창 비포커스 시 폴링 중단), `staleTime: 0`, `keepPreviousData`.
- `src/lib/ipc.ts:727-732` — `call<SysMetrics>("sys_metrics", …, { lane: "background", attempts: 1, timeoutMs: 4000 })`. 타입은 `ipc.ts:257-266`(`gpu: number | null` — PDH 미지원 시 null).

### 2.2 데이터 소스 — sysinfo + Windows PDH, 프로세스 단위는 아직 없음
- `src-tauri/Cargo.toml:40` `sysinfo = "0.33"`(기본 feature → 프로세스 API 포함), `:63` `windows-sys` `Win32_System_Performance`(PDH) 이미 활성.
- `src-tauri/src/monitor.rs:24-27` `Monitor { sys: System, gpu: GpuCounter }`, `src-tauri/src/state.rs:31,48` `AppState.monitor: Mutex<Monitor>`.
- `monitor.rs:29-39` — CPU는 두 샘플 델타라 생성 시 1회 `refresh_cpu_usage()`로 기준점을 잡는 주석·코드가 이미 있음. `sample()`(`:41-75`)은 전역 CPU/RAM/디스크만 수집 — **프로세스 열거는 어디에도 없음**.
- `monitor.rs:88-90` `sys_metrics` 커맨드(동기, `state.monitor.lock()`), `lib.rs:293` 등록.
- **프로세스별 GPU의 발판이 이미 있음**: `monitor.rs:153` PDH 카운터 `"\GPU Engine(*engtype_3D)\Utilization Percentage"`는 **인스턴스가 (프로세스 × 물리 엔진)당 1개**이고 인스턴스명이 `"pid_… luid_… phys_… eng_… engtype_…"` 형식(`:203-227`, 주석 `:221`). 현재는 pid를 버리고 엔진별 합산의 최댓값만 취한다(`:229`). dGPU LUID 필터(`:216-219`, `:236-258`)도 그대로 재사용 가능. 비Windows는 `GpuCounter::read() → None`(`:303-314`).

### 2.3 플로팅 네이티브 창 인프라 — 검증된 레시피 존재
- `src-tauri/src/lib.rs:98-126` `open_float_window` — **async 커맨드 + `run_on_main_thread` + `WebviewUrl::External(origin)`**(아니면 about:blank — 메모리 노트·주석 `:95-97`, `:105-106`), `decorations(false)`, `additional_browser_args(&browser_args())`. `browser_args()`(`:80-89`)는 모든 창에서 일치해야 함(불일치 시 웹뷰 초기화 실패 — 주석 `:82-83`).
- 라벨 기반 라우팅: `src/main.tsx:29-53` — 라벨이 `float-<paneId>`면 `FloatingTerminal`만 렌더(자체 QueryClient). 쿼리스트링은 못 쓰므로 라벨이 유일한 부트 파라미터 채널(주석 `:30`). 단, 플로팅 창은 메인과 같은 origin이라 **localStorage 공유**(`src/stores/terminals.ts:7`).
- 커스텀 타이틀바 `src/components/FloatTitleBar.tsx:7-45` — 재사용 가능하나 배지 문구 "터미널"이 하드코딩(`:23-25`) → prop화 필요.
- 창 닫힘 정리: `lib.rs:315-328` `Destroyed` 핸들러는 `main`(PTY/브라우저 전체 정리)과 `float-*`(해당 PTY만 종료)만 처리 — 그 외 라벨은 no-op이라 **모니터 창은 정리 코드 불필요**.
- 호출부 전례: `src/lib/floating.ts:9-18` — `invoke("open_float_window", { paneId, origin: window.location.origin })`.

### 2.4 IPC 규약 — 배치·폴링 패턴
- `src/lib/ipc.ts:459-497` — WebView2 동시 invoke 응답 유실 대응: 동시성 8 제한 + single-flight + lane. 폴링류는 `lane:"background", attempts:1, 짧은 타임아웃`이 기존 규약(`:726-732`) — 다음 틱이 자기치유하므로 재시도 불필요.
- 인앱 모달 상태 전례: `src/stores/ui.ts:46,97,132` `aggregateOpen` 패턴(대안 (a)에서 쓰였을 경로).

### 2.5 sysinfo 0.33 프로세스 API (Cargo.lock 실버전 0.33.1 — 로컬 크레이트 소스로 검증됨)
- `System::refresh_processes_specifics(ProcessesToUpdate::All, remove_dead, ProcessRefreshKind)` — CPU/메모리만 갱신하도록 좁힐 수 있음.
- `Process::cpu_usage()`는 **코어 1개 기준 %**(멀티코어에서 100 초과 가능) → 전역 스케일로 맞추려면 `sys.cpus().len()`으로 나눠야 함(작업 관리자 방식). **두 refresh 사이 델타**라 첫 샘플은 0%, 갱신 간격은 `MINIMUM_CPU_UPDATE_INTERVAL`(200ms) 이상이어야 유효 — 2초 폴링이면 자연 충족.
- `Process::memory()`는 bytes, `Process::name()`은 `&OsStr`(Windows에선 실행 파일명).

## 3. 설계(대안 비교 + 채택 근거)

### 3.1 팝업 형태 — (b) 플로팅 네이티브 창 채택
| | (a) 인앱 팝오버/모달 | (b) 별도 플로팅 네이티브 창 ✅ |
|---|---|---|
| 구현 비용 | 최소(ui 스토어 플래그 + 컴포넌트) | 신규 커맨드 ~30 LOC + main.tsx 분기 ~10 LOC + 타이틀바 prop 1개 |
| 사용성 | 메인 창 위 오버레이 — diff/터미널을 가리고, 보는 동안 다른 작업 불가 | 다른 모니터/옆에 두고 **작업하면서 병행 관찰** 가능(모니터링 도구의 본령) |
| 위험 | 없음 | 창 생성 함정 있으나 **검증된 레시피(§2.3)를 그대로 따르면 회피** |
| 원문 부합 | "팝업창"과 거리 있음 | 사용자 원문 "팝업창으로 열려서"에 부합 |

채택: **(b)**. 인프라가 이미 실증돼 있어 한계 비용이 작고(§2.3), 리소스 모니터는 "열어두고 곁눈질"하는 물건이라 메인 창 오버레이(a)는 용도와 어긋난다. 창은 **싱글턴 라벨 `"sysmon"`** — 이미 떠 있으면 새로 만들지 않고 `set_focus()`만.

### 3.2 데이터 전달 — 폴링 커맨드 채택 (이벤트 push 비채택)
- (i) **폴링 커맨드** ✅ — 기존 `sys_metrics` 패턴 그대로(§2.1, §2.4). 창이 닫히면 폴링도 함께 사라져 생명주기 정합이 공짜. react-query 캐시·`keepPreviousData`로 깜빡임 없음.
- (ii) Rust 상주 스레드 + 이벤트 emit — 비채택: 창 닫힘 감지·스레드 정리·창 대상 라우팅이 전부 신규 코드이고, 기존 코드베이스에 전례가 없다. 폴링의 단점(유실)은 attempts:1 + 다음 틱 자기치유로 이미 관리되는 규약.

단, 메인 창의 `refetchIntervalInBackground: false`(§2.1)를 **모니터 창에는 쓰면 안 된다** — 모니터 창은 보통 비포커스 상태로 관찰되기 때문. 대신 `document.visibilityState`(최소화 시 hidden)로 게이트해 "보일 때만" 폴링한다.

### 3.3 목록 산출 위치 — Rust에서 정렬·Top-N·그룹화
- 전체 프로세스(Windows 수백 개)를 매 2초 JSON으로 보내고 프론트에서 정렬하는 안은 비채택 — 페이로드 낭비이고, "프로그램별 합산"은 어차피 전체 목록이 필요해 백엔드에서만 가능하다.
- 커맨드 파라미터로 `sortBy/limit/groupByName`을 받고 Rust가 절단해 보낸다. **totals(기존 SysMetrics)도 같은 응답에 포함** — 팝업이 커맨드 1개만 폴링하게 하는 배치 패턴(§2.4, 동시 invoke 유실 회피).

### 3.4 프로세스별 GPU — 기존 PDH 카운터 재사용 (Windows 한정)
| 방식 | 판단 |
|---|---|
| PDH `GPU Engine(pid_*)` 인스턴스명 pid 파싱 ✅ | 이미 열려 있는 카운터(§2.2)에서 **pid만 추가로 집계** — 신규 의존성 0, 수집 비용 0(같은 collect). dGPU LUID·engtype_3D 필터도 전역 지표와 동일하게 적용해 수치 일관성 유지 |
| NVML | NVIDIA 전용 — 비채택 |
| D3DKMT | 비공식·문서 빈약 — 비채택 |
| macOS/Linux | 크로스플랫폼 표준 API 없음 — **후속**. v1은 기존과 동일하게 `gpu: null` |

구현 방향: `GpuCounter::read()`를 "collect → (전역 max, pid별 max-over-engines) 동시 산출"로 확장. 프로세스별 값은 해당 pid의 3D 엔진 사용률 중 최댓값(작업 관리자 GPU 열과 같은 규약). GPU를 안 쓴 프로세스는 인스턴스 자체가 없음 → `null`.

**collect 스로틀(필수)**: `sys_metrics`(타이틀바)와 `sys_process_snapshot`(팝업)이 각각 2초 폴링하면 `PdhCollectQueryData`가 근접 호출될 수 있다. PDH도 두 샘플 델타라 간격이 너무 짧으면 값이 불안정 → Monitor에 마지막 collect `Instant`를 두고 **500ms 미만이면 직전 집계 결과를 재사용**한다. CPU/프로세스 refresh도 같은 가드를 공유(`MINIMUM_CPU_UPDATE_INTERVAL` 충족 겸용).

### 3.5 kill 버튼 — v1 비포함 (판단 근거)
- 권한: 관리자/시스템 프로세스는 사용자 권한 앱에서 종료가 실패한다 — "되다 안 되다" 하는 버튼은 UX 불신만 만든다.
- 파괴성: sysinfo가 제공하는 종료는 강제 종료뿐(Windows 구현은 `taskkill /F`, Unix 기본은 SIGKILL — 0.33.1 소스 실측) — 저장 안 된 데이터 소실, 오클릭 대참사 경로.
- 자체 상태와 충돌: gitpervisor가 관리하는 PTY 자식(§2.3 `kill_all`/`close_session`)을 이 화면에서 죽이면 터미널 스토어와 어긋난다.
- 결론: v1은 **읽기 전용 관측 도구**. 종료가 필요하면 OS 작업 관리자가 정답 — 필요 시 "작업 관리자 열기" 링크만 후속 검토.

### 3.6 초기 정렬 전달 — localStorage 핸드오프
라벨은 싱글턴 `"sysmon"` 고정이라 파라미터를 실을 수 없고, 쿼리스트링은 못 쓴다(§2.3). 창들은 같은 origin으로 localStorage를 공유하므로(§2.3, terminals.ts:7 전례) — 클릭한 지표를 `gp:sysmon`(`{ sortBy, groupByName }`)에 쓰고 열면, 창이 부팅 시 읽는다. 부수 효과로 사용자의 마지막 정렬·그룹 설정이 재오픈 시 유지된다.

## 4. 계약(타입·커맨드·이벤트)

### 4.1 Rust — monitor.rs 확장 + 창 커맨드
```rust
// monitor.rs — 신규 타입 (SysMetrics는 기존 그대로 재사용)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    pub name: String,             // 실행 파일명 (예: "chrome.exe")
    pub cpu: f32,                 // 0-100 — cpu_usage()/코어수 정규화(전역 스케일, §2.5)
    pub ram: u64,                 // bytes (Process::memory)
    pub gpu: Option<f32>,         // 0-100 — Windows PDH 3D 엔진 pid 집계, 그 외/비대상 null
    pub group_count: Option<u32>, // 프로그램별 합산 행이면 묶인 프로세스 수, 개별 모드 null
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub totals: SysMetrics,            // 팝업 헤더 게이지 — 별도 sys_metrics 호출 불필요(배치)
    pub processes: Vec<ProcessSample>, // 정렬·Top-N 절단 완료
    pub total_count: u32,              // 절단 전 전체 프로세스 수 ("… 외 312개")
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcSortKey { Cpu, Ram, Gpu } // Gpu 정렬 시 None은 항상 뒤로

/// 팝업이 2초 간격으로 폴링. sys_metrics와 같은 Monitor 뮤텍스 공유,
/// PDH collect·CPU refresh는 500ms 스로틀 캐시(§3.4)로 이중 호출 무해화.
#[tauri::command]
pub fn sys_process_snapshot(
    state: State<'_, AppState>,
    sort_by: ProcSortKey,
    limit: u32,          // UI 기본 20
    group_by_name: bool, // true: 같은 이름 합산(cpu·ram·gpu 합, gpu는 100 캡, pid=최대 기여자)
) -> ProcessSnapshot;
```
```rust
// lib.rs — open_float_window(:98-126) 미러. 검증된 레시피 준수:
// async 커맨드 + run_on_main_thread + WebviewUrl::External(origin) + browser_args() 일치.
// 싱글턴: get_webview_window("sysmon")이 있으면 set_focus()만 하고 반환.
// 라벨 "sysmon" — Destroyed 핸들러(main/float-* 전용)에 걸리지 않아 정리 코드 불필요.
#[tauri::command]
async fn open_sysmon_window(app: tauri::AppHandle, origin: String) -> Result<(), String>;
// inner_size(560, 640) · min_inner_size(420, 360) · decorations(false) · center()
```
- `lib.rs` invoke_handler에 `monitor::sys_process_snapshot`, `open_sysmon_window` 등록.
- `Monitor` 내부: `sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cpu().with_memory())` — 최소 갱신으로 비용 절감(§2.5). 첫 틱 CPU 0%는 규약상 불가피 — UI가 흡수(§5).

### 4.2 TS — ipc/queries/컴포넌트
```ts
// ipc.ts
export interface ProcessSample { pid: number; name: string; cpu: number; ram: number;
  gpu: number | null; groupCount: number | null; }
export interface ProcessSnapshot { totals: SysMetrics; processes: ProcessSample[]; totalCount: number; }
export type ProcSortKey = "cpu" | "ram" | "gpu";

sysProcessSnapshot: (sortBy: ProcSortKey, limit: number, groupByName: boolean) =>
  call<ProcessSnapshot>("sys_process_snapshot", { sortBy, limit, groupByName },
    { lane: "background", attempts: 1, timeoutMs: 4000 }), // sysMetrics(:727-732)와 동일 규약
openSysmonWindow: () => invoke("open_sysmon_window", { origin: window.location.origin }),
```
```ts
// queries/index.ts
useProcessSnapshot(sortBy, groupByName) // queryKey에 둘 다 포함, refetchInterval 2000,
// keepPreviousData. 주의: refetchIntervalInBackground: true + document.visibilityState 게이트
// (§3.2 — 비포커스 관찰이 기본 사용 자세, 최소화 시에만 중단)
```
- `src/main.tsx` — `label === "sysmon"`이면 `<SysMonitorWindow/>`만 렌더(플로팅 터미널 분기 `:42-53`와 대칭, 자체 QueryClient).
- 신규 `src/components/sysmon/SysMonitorWindow.tsx` — `FloatTitleBar`(배지 문구 prop화: "터미널"→"모니터") + 헤더 totals 게이지 + 컬럼 헤더 클릭 정렬 + "프로그램별" 토글 + 행 20개(이름·pid(×n)·CPU·RAM·GPU). 설정은 `gp:sysmon` localStorage 영속(§3.6).
- `src/components/SysMonitor.tsx` — 컨테이너·Metric의 `data-tauri-drag-region` 제거하고 버튼화(현재는 클릭=창 드래그, §2.1). 클릭한 지표를 `gp:sysmon.sortBy`에 기록 후 `openSysmonWindow()`. 타이틀바 드래그는 주변 spacer(`TitleBar.tsx:56`)가 유지.
- 신규 이벤트 없음.

## 5. 단계(구현 순서)

1. **백엔드 샘플링** — `Monitor`에 프로세스 refresh(+500ms 스로틀 캐시) 추가, `GpuCounter`를 (전역, pid별) 동시 산출로 확장, `sys_process_snapshot` 커맨드 + 등록. 이 시점에 CDP/수동 invoke로 페이로드 검증 가능(창 없이).
2. **창 배선** — `open_sysmon_window`(싱글턴) + `main.tsx` 라벨 분기 + `FloatTitleBar` 배지 prop.
3. **팝업 UI** — `SysMonitorWindow`(totals 게이지·테이블·정렬·그룹 토글·visibility 게이트 폴링). 첫 틱 CPU 0%는 `keepPreviousData`+"측정 중…" 1회 표시로 흡수.
4. **진입점** — `SysMonitor` 버튼화 + localStorage 핸드오프.
5. **E2E** — `tests/e2e/` 신규 스위트: ① `sys_process_snapshot` 셰이프·정렬·limit·그룹 합산 검증(창 불필요) ② 창 열림/싱글턴 재포커스(타이틀 스캔 — 기존 하네스 방식).

규모: 백엔드 ~150 LOC, 프론트 ~200 LOC — **M**.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| PDH/CPU 이중 수집 | 두 커맨드가 근접 폴링하면 델타 간격이 0에 수렴해 값 불안정 | Monitor에 500ms 스로틀 캐시(§3.4) — 두 커맨드가 같은 표본을 공유 |
| 프로세스별 GPU의 정직한 한계 | Windows 전용 + engtype_3D만(비디오 디코드/copy 엔진 제외, 전역 지표와 동일 필터 `:150-153`) → 일부 GPU 부하가 안 보임 | UI 컬럼명을 "GPU(3D)"로 명시, mac/Linux는 컬럼 자체를 "—" 처리. 전 엔진 집계는 후속 |
| WebView2 invoke 유실 (새 웹뷰) | 모니터 창도 자체 invoke 큐 — 유실 이슈 동일 적용 | 틱당 커맨드 1개(배치, §3.3) + attempts:1 + 4s 타임아웃 → 다음 틱 자기치유(기존 sysMetrics 규약) |
| refresh_processes 비용 | 수백 프로세스 열거가 매 2초 발생 | `ProcessRefreshKind::nothing().with_cpu().with_memory()` 최소 갱신 + 창 닫히면/최소화면 폴링 소멸. 비용이 실측상 크면 주기 완화(추정 — 1단계에서 실측) |
| 창 생성 함정 | about:blank/빈 창(메모리 노트) | 검증된 레시피 그대로: async + `run_on_main_thread` + `External(origin)` + `browser_args()` 일치(§2.3). 신규 발명 없음 |
| 그룹 합산 왜곡 | 이름 합산 GPU가 100% 초과 가능, pid 컬럼 의미 약화 | GPU 합산 100 캡 + 그룹 행은 "이름 ×n" 표기·pid는 최대 기여자(툴팁 명시) |
