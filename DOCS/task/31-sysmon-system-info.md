# 태스크 31 — 리소스 모니터에 OS·하드웨어 사양 탭(CPU-Z 식)

> 상태: **구현 완료 · 검증 통과(2026-09-03, 미커밋)** — 결과는 §8 · 대상: gitpervisor ·
> 근거: 코드 실측 2026-09-03 · 선행: `DOCS/task/05-resource-monitor-popup.md`(구현 완료)

## 1. 요구사항

리소스 모니터 창에서 **현재 PC의 OS 정보와 하드웨어 사양**을 CPU-Z처럼 볼 수 있어야 한다.

받아들이는 조건:
- 리소스 모니터에 "시스템 정보" 탭이 생기고, OS / CPU / 메모리 / GPU / 메인보드·BIOS / 저장장치 / 앱 정보를 보여준다.
- 열 때 한 번 수집하고(수 초 내), 이후엔 캐시. "새로고침"으로 재수집.
- 항목을 못 구한 플랫폼에서는 그 항목만 "정보 없음"으로 — 탭 전체가 죽지 않는다.
- 한 번에 복사할 수 있는 텍스트 요약 제공(지원 문의용).

## 2. 현황(근거)

- **창·탭**: `src/components/sysmon/SysMonitorWindow.tsx`(599줄). 탭은 리터럴 배열 `[["proc","프로세스"],["disk","디스크"]]`
  (`:371-392`)를 map — 탭 추가 지점은 여기 하나. `view === "disk"`면 `<DiskUsageView/>`(`:394`). 뷰·정렬·그룹 영속은
  `sysmon/prefs.ts`(`gp:sysmon`, `SysmonPrefs{sortBy, groupByName, view}` `:14-18`). 창 크기 `lib.rs:327` `inner_size(660, 640)`,
  최소 480×360. 창은 `AUX_WINDOW_LABELS`(`lib.rs:519`)라 메인 종료 시 함께 닫힌다.
- **폴링·캐시**: 프로세스 표는 `useProcessSnapshot`(2s, `queries/index.ts:245-271`), 디스크 뷰에서는 `enabled=false`(`:232-236`).
  백엔드 `Monitor`(`monitor.rs:122-145`, `AppState.monitor` Mutex)는 500ms 스로틀(`:109`)로 동적 지표만 수집.
- **정적 정보는 0건**: `System::name/os_version/kernel_version/host_name/boot_time`, `Cpu::brand/frequency`, `physical_core_count`,
  `Disk::kind` 전부 미사용(전 소스 grep 0). `sys.cpus()`는 길이만 쓴다(`:293`). `storage()`는 `DiskRefreshKind::nothing().with_storage()`
  로 의도적으로 모델·kind를 안 읽는다(`:229` 주석).
- **GPU**: Windows PDH만(`monitor.rs:649-879`) — `GPU Engine(*engtype_3D)` 사용률과 `GPU Adapter Memory(*)\Dedicated Usage Limit`
  (dGPU LUID 판별용, **값은 버린다** `:835`). 비Windows는 스텁(`:881-893`).
- **크레이트**: `sysinfo = "0.33"`(feature 미지정 = 기본 전부, lock 0.33.1). `windows-sys 0.59` features에
  `Win32_System_SystemInformation` 이미 포함(`Cargo.toml:119`). **WMI/COM(`windows` 크레이트) 없음**, PowerShell/wmic 실행 0건.
- **외부 명령 규약**: 출력을 읽는 실행은 `git/runner.rs:118-177` 패턴 — `tokio::process::Command`, args 배열, `Stdio::null/piped/piped`,
  `kill_on_drop(true)`, `#[cfg(windows)] creation_flags(0x0800_0000)`, `#[cfg(unix)] process_group(0)`, `tokio::time::timeout` + `kill_group`.
  `spawn_launcher`(open.rs)는 stdio가 전부 null이라 정보 수집엔 부적합.
- **IPC 관례**: `ipc.ts:1200-1217` 모니터 래퍼는 `{ lane:"background", attempts:1, timeoutMs:4000 }`. 커맨드는 `#[tauri::command(async)]`,
  락은 `unwrap_or_else(|e| e.into_inner())`(poison 전파 금지 테스트 `lib.rs:1226-1232`).
- e2e `18-sysmon.mjs`: 스냅샷 셰이프·정렬·그룹 + 창 생성/싱글턴/소멸. 설정 항목 없음.

## 3. 설계

### 3.1 수집 전략 — "sysinfo 공통 + 플랫폼별 일회성 명령 1개"

| 대안 | 평가 |
|---|---|
| **A. sysinfo(공통) + Windows는 PowerShell CIM 1회, Linux는 /sys·/proc 파일 + `lspci`/`nvidia-smi`(있으면), macOS는 `sysctl` + `system_profiler -json`** (채택) | 신규 크레이트 0. 한 번 수집·캐시라 PowerShell 1~2초 기동이 문제 안 됨. 실패는 항목 단위 None |
| B. `windows`(COM) 크레이트로 WMI 직접 | 크레이트 추가(빌드 시간↑) + COM 초기화 스레딩 규칙. 얻는 건 A와 같다 |
| C. 프론트에서 셸 명령 | 프론트에 셸 실행 경로가 없고(보안 설계), 있어서도 안 된다 |

Windows CIM 스크립트는 **한 번의 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`** 로 클래스 6개를
`ConvertTo-Json -Compress -Depth 3`으로 묶어 받는다(개별 호출 6회 × 1.5s를 피한다):
`Win32_OperatingSystem(Caption,Version,BuildNumber,OSArchitecture,InstallDate,LastBootUpTime)` ·
`Win32_Processor(Name,Manufacturer,MaxClockSpeed,NumberOfCores,NumberOfLogicalProcessors,L2CacheSize,L3CacheSize)` ·
`Win32_CacheMemory(Level,InstalledSize)`(L1 = Level 3, L2 = 4, L3 = 5 — L1은 Processor 클래스에 없다) ·
`Win32_PhysicalMemory(Capacity,Speed,Manufacturer,PartNumber,DeviceLocator)` ·
`Win32_VideoController(Name,DriverVersion,DriverDate,VideoProcessor)` + 레지스트리
`HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-…}\00NN\HardwareInformation.qwMemorySize`(QWORD — `AdapterRAM`은 uint32라 4GB에서 잘린다) ·
`Win32_BaseBoard(Manufacturer,Product,SerialNumber→제외)` · `Win32_BIOS(Manufacturer,SMBIOSBIOSVersion,ReleaseDate)`.
`pwsh`가 아니라 **`powershell.exe`(Windows PowerShell 5.1, 모든 Win10/11에 존재)** 를 쓴다. 시한 20s, 실패 시 CIM 항목만 None.

### 3.2 데이터 계약

```rust
// src-tauri/src/sysinfo_static.rs (신규)
#[derive(Serialize, Clone, Default)] #[serde(rename_all = "camelCase")]
pub struct SystemInfo {
  pub collected_at_ms: u64,
  pub os: OsInfo,            // name, version, build, kernel, arch, host_name, boot_time_ms, uptime_secs, install_date? , user_name?
  pub cpu: CpuInfo,          // brand, vendor, physical_cores, logical_cores, base_mhz, max_mhz?, current_mhz_avg, cache_l1_kb?, cache_l2_kb?, cache_l3_kb?
  pub memory: MemoryInfo,    // total_bytes, swap_total_bytes, modules: Vec<MemoryModule{slot, capacity_bytes, speed_mhz?, manufacturer?, part_number?}>
  pub gpus: Vec<GpuInfo>,    // name, driver_version?, driver_date?, vram_bytes?, is_discrete?
  pub board: Option<BoardInfo>, // manufacturer, product, bios_vendor, bios_version, bios_date
  pub volumes: Vec<VolumeInfo>, // name, mount, fs, kind("ssd"|"hdd"|"unknown"), total_bytes, available_bytes, removable
  pub app: AppInfo,          // version(tauri::PackageInfo), tauri_version, webview_version(tauri::webview_version()), build_profile("debug"|"release")
  pub notes: Vec<String>,    // 수집 실패 항목 사유("CIM: 시간 초과" 등) — UI가 "정보 없음" 툴팁에 쓴다
}
#[tauri::command(async)] pub fn sys_info_static(app: AppHandle, force: bool) -> Result<SystemInfo, IpcError>;
```
- 캐시: 모듈 `static CACHE: Mutex<Option<SystemInfo>>`. `force=false`면 캐시 반환, 없거나 `force`면 수집. 수집 중 동시 호출은
  같은 결과를 기다리지 않고 각자 수집(창 하나뿐이라 실질 1회).
- 공통(sysinfo): `System::name/os_version/long_os_version/kernel_version/host_name/cpu_arch/boot_time`, `physical_core_count`,
  `cpus()[0].brand/vendor_id/frequency`, `total_memory/total_swap`, `Disks::new_with_refreshed_list()`(kind·name·mount·fs·total·available·removable).
  **`Monitor`의 sysinfo 인스턴스와 별개로** 지역 `System::new()`를 쓴다 — 모니터 뮤텍스를 수 초간 잡지 않기 위해.
- Linux: `/proc/cpuinfo`(model name·cache size), `/sys/devices/system/cpu/cpu0/cache/index*/{level,type,size}`,
  `/sys/class/dmi/id/{board_vendor,board_name,bios_vendor,bios_version,bios_date}`(무루트 가독), GPU는 `lspci -mm`의 VGA/3D 행 +
  `nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader`(있을 때) + `/sys/class/drm/card*/device/mem_info_vram_total`(amdgpu).
  메모리 모듈은 `dmidecode`가 루트 필요라 제외(총량·스왑만).
- macOS: `sysctl -n machdep.cpu.brand_string hw.physicalcpu hw.logicalcpu hw.l1icachesize hw.l1dcachesize hw.l2cachesize hw.model hw.memsize`,
  `system_profiler SPDisplaysDataType SPMemoryDataType -json`(느리지만 1회).
- 모든 외부 명령: `runner.rs` 규약(args 배열, CREATE_NO_WINDOW, process_group, timeout+kill). 어느 명령이든 실패는 `notes`에 사유만.

### 3.3 UI — "시스템 정보" 탭

- 탭 배열에 `["info","시스템 정보"]` 추가(`SysmonPrefs.view` 유니온에 `"info"`). `view === "info"`면 프로세스 폴링 `enabled=false`(디스크 뷰와 동일).
- `src/components/sysmon/SystemInfoView.tsx`(신규): `useQuery(["sys-info"], () => ipc.sysInfoStatic(false), { staleTime: Infinity })`.
  헤더: "새로고침"(`force:true` → `setQueryData`), "요약 복사"(모든 항목을 `키: 값` 텍스트로 클립보드 — 기존 클립보드 경로
  `src/lib/clipboard.ts` 사용). 본문은 카드 7개(OS / CPU / 메모리 / GPU / 메인보드·BIOS / 저장장치 / 앱), 각 카드는 2열 key/value 표.
  값이 없으면 "정보 없음"(툴팁에 `notes`). 바이트는 기존 `formatBytes`, 클럭은 `GHz` 소수 2자리, 가동 시간은 `d h m`.
- 창 최소 크기(480×360)에서도 세로 스크롤로 읽히게 카드 스택(`overflow-y-auto`).
- 타이틀바 `SysMonitor.tsx`의 진입점은 그대로(프로세스 탭으로 열림). 설정 항목 없음.

### 3.4 만들지 않는 것

- 실시간 클럭/온도 그래프(CPU-Z의 센서 탭) — 동적 지표는 기존 프로세스 탭 몫. 온도는 sysinfo `Components`가 Windows에서 비어 있어 제외.
- 시리얼 번호(메인보드/디스크) — 개인정보. 수집하지 않는다.

## 4. 계약(프론트)

```ts
// src/lib/ipc.ts
export interface SystemInfo { collectedAtMs: number; os: OsInfo; cpu: CpuInfo; memory: MemoryInfo; gpus: GpuInfo[]; board: BoardInfo | null; volumes: VolumeInfo[]; app: AppInfo; notes: string[] }
// (필드는 §3.2 Rust 구조체와 camelCase 1:1)
sysInfoStatic: (force = false) => call<SystemInfo>("sys_info_static", { force }, { lane: "background", attempts: 1, timeoutMs: 30_000 }),
```

## 5. 단계

1. **프론트 먼저**(다른 세션의 디버그 앱 검증이 끝날 때까지 Rust 저장 보류 — 조율 사항): `ipc.ts` 타입·래퍼, `prefs.ts` view 유니온,
   `SysMonitorWindow.tsx` 탭 + 분기, `SystemInfoView.tsx`. 커맨드가 없는 동안엔 뷰가 오류 상태("수집 실패")를 보여준다.
2. **Rust**(신호 후 한 번에 저장 — 태스크 33의 ConPTY 번들과 같은 재빌드에 태워라): `sysinfo_static.rs` + `lib.rs` 등록.
   `cargo test`(기존 `hot_commands_stay_async`·`no_poison_propagating_unwraps` 테스트가 새 코드에도 걸린다).
3. e2e 18 확장: `sys_info_static` 셰이프(os.name 비어 있지 않음, cpu.logicalCores ≥ 1, memory.totalBytes > 0, volumes ≥ 1, Windows면
   gpus ≥ 1·board 존재·cpu.cacheL3Kb > 0), `force:true` 재수집 시 `collectedAtMs` 증가, 2회 호출 소요 시간(캐시 hit < 50ms).
4. 실기: 창 › 시스템 정보 탭 — 이 머신 값이 실제와 맞는지(CPU 모델·코어·RAM 모듈·GPU·VRAM·보드·BIOS·볼륨 SSD/HDD), 요약 복사.

규모: **M** — Rust ~300 LOC(플랫폼 3분기), 프론트 ~220 LOC.

## 6. 위험과 완화

| 위험 | 내용 | 완화 |
|---|---|---|
| PowerShell 기동 지연·실패 | 1~3s, 정책·손상 환경에서 실패 | 1회 캐시, 시한 20s, 실패 시 CIM 항목만 None + `notes`. 창은 sysinfo 값으로 먼저 채운다(두 단계 응답은 하지 않는다 — 단순화) |
| CIM 값 형식 | `LastBootUpTime`/`InstallDate`는 CIM 날짜 문자열(`/Date(…)/` 또는 ISO) — PowerShell 버전별 상이 | `ConvertTo-Json` 전에 `.ToString("o")`로 정규화하는 `select @{n=…;e=…}` 사용 |
| `AdapterRAM` 4GB 캡 | uint32 | 레지스트리 `qwMemorySize` 우선, 없으면 PDH `Dedicated Usage Limit`(이미 읽는 값)로 폴백 |
| Linux 권한 | `dmidecode` 루트 | 제외. `/sys/class/dmi/id` 는 무루트 |
| 모니터 뮤텍스 점유 | 수집이 수 초 | 지역 `System::new()` — `Monitor` 락 미사용 |
| 재빌드 타이밍 | 다른 세션 검증 중 저장 금지 | §5 순서. Rust 2건(31·33)을 한 번의 재빌드로 |

## 7. 검증

- `cargo test` 통과(신규 유닛: CIM JSON 파서 — 고정 샘플 JSON으로 필드 매핑, 날짜 정규화, 누락 필드 허용).
- e2e 18 확장 항목 통과. 실기 §5-4. 값 대조는 이 머신의 `systeminfo`/작업 관리자와 비교해 보고에 표로.

## 8. 구현 결과(2026-09-03)

`src-tauri/src/sysinfo_static.rs`에서 §3.1의 **Windows 수집 전략만** 두 군데 바꿨다. 근거는 이 머신
실측이고 계약(§3.2·§4)·UI(§3.3)는 그대로다.

### 8.1 GPU는 WMI를 쓰지 않는다 — 표시 어댑터 드라이버 키를 직접 읽는다

`Win32_VideoController`가 이 머신에서 **WMI 레벨로 무응답**이다(>10분, `-OperationTimeoutSec 15`로도
못 끊고 오류만 난다). 클래스를 한 덩어리로 묶어 뒀던 탓에 그 하나가 **CIM 수집 전체**를 20s 시한에
끌고 죽었다 — `notes`에 "CIM: powershell.exe 시간 초과"만 남고 OS·CPU·메모리·보드까지 전부 빈 값.

대신 `HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\00NN`을
`Get-ChildItem`+`Get-ItemProperty`로 읽는다: `DriverDesc`(이름)·`DriverVersion`·`DriverDate`·
`ProviderName`, VRAM은 `HardwareInformation.qwMemorySize`(REG_QWORD), 없으면
`HardwareInformation.MemorySize`(DWORD, 4GB 캡). **레지스트리만으로 3.0초.**

- **접근 거부는 항목 단위로 건너뛴다.** 클래스 키 아래에 열람 권한 없는 하위 키가 있어
  `Get-ChildItem -ErrorAction Stop`은 **통째로** 실패한다(실측: "요청한 레지스트리에 액세스할 수
  없습니다"). SilentlyContinue로 읽고 결과가 0개일 때만 `errors`에 사유를 남긴다.
- **같은 `DriverDesc`는 한 줄로 접는다** — 이 머신은 DisplayLink 도크가 키 2개(0002·0003)를 갖는다.
- REG_BINARY로 오는 `MemorySize`(Intel iGPU 실측 `{0,240,255,127}` = 0x7FFFF000)는 스크립트에서
  정수로 편다. JSON 배열로 오면 `Num`이 못 받아 GPU 파싱이 통째로 깨진다.
- `is_discrete`는 §3.2대로 null 유지 — 레지스트리도 외장/내장을 알려주지 않는다.
- `ProviderName`은 싣되 쓰지 않는다. `GpuInfo`에 대응 필드가 없다(계약을 늘리지 않았다).

### 8.2 CIM은 클래스별 독립 실행 + 실패 사유를 notes로

스크립트 안에서 클래스마다 `try { Get-CimInstance <cls> -OperationTimeoutSec 8 -ErrorAction Stop } catch { … }`로
감싼다. 하나가 멈춰도 나머지는 살아 돌아오고, 사유는 응답의 `errors`(클래스 → 메시지)에 담겨
`notes`의 `"CIM Win32_X: <사유>"`가 된다. 프로세스 시한은 20s → **30s**(클래스 6개 × 8s + 기동).

`AdapterRAM` 폴백과 `Win32_VideoController`가 사라졌으므로 `CimVideo`/`CimVram`은 `RegGpu` 하나로 대체.

### 8.3 출력 인코딩을 UTF-8로 고정

`[Console]::OutputEncoding = [Text.Encoding]::UTF8` 한 줄. 기본은 콘솔 코드페이지(이 머신 949)라
`OSArchitecture`("64비트")가 CP949 바이트로 와서 `from_utf8_lossy`에 깨졌다 — `os.arch`가 계속
`64<?><?>`였다는 뜻이다. 한글 오류 메시지(`errors`)도 같은 이유로 깨진다.

### 8.4 값 대조(이 머신, 2026-09-03)

| 항목 | `sys_info_static` | 실제 확인값 | 확인 방법 |
|---|---|---|---|
| os.build | `26200` | `10.0.26200 N/A Build 26200` | `systeminfo` |
| os.installDate | `2025-06-02` | `2025-06-02, 오전 9:54:42` | `systeminfo` |
| os.arch | `64비트` | 한글 그대로 | UTF-8 고정 전에는 깨졌다(§8.3) |
| cpu.brand | `Intel(R) Core(TM) Ultra 9 275HX` | 동일 | `Win32_Processor` |
| cpu 코어 | 물리 24 / 논리 24 | 24 / 24 | `Win32_Processor` |
| cpu.baseMhz | `2700` | `MaxClockSpeed 2700` | `Win32_Processor` |
| cpu.cacheL1Kb | `2432` | 384+512+512+1024 | `Win32_CacheMemory` Level 3 합 |
| cpu.cacheL2Kb | `40960` | `L2CacheSize 40960` | 24576+16384과 일치 |
| cpu.cacheL3Kb | `36864` | 36864 (36MB) | `L3CacheSize 36864` — Level 5 합 73728은 중복, §8.6 |
| memory.totalBytes | `68,030,443,520` (63.4GiB) | `64,879 MB` | `systeminfo` |
| memory.modules | Controller0-ChannelA/B-DIMM1, 각 32GiB 5600MHz SK Hynix `HMCG88AGBSA095N`/`092N` | 동일 | `Get-CimInstance Win32_PhysicalMemory` |
| gpus[0] | `Intel(R) Graphics` 2,147,479,552 · 32.0.101.8424 · 2026-01-06 | `MemorySize` 0x7FFFF000 | 레지스트리 키 0000 |
| gpus[1] | `NVIDIA GeForce RTX 5070 Ti Laptop GPU` 12,820,938,752(11.9GiB) · 32.0.15.9613 · 2026-04-08 | `qwMemorySize 12820938752` | 레지스트리 키 0001 |
| gpus[2] | `DisplayLink USB Device` vram null | 키 0002·0003 두 개 → 한 줄 | 레지스트리 |
| board | `ASUSTeK COMPUTER INC.` / `G815LR` | System Manufacturer 동일, 모델은 `ROG Strix G18 G815LR_G815LR` | `systeminfo`(보드 제품명은 `Win32_BaseBoard`) |
| BIOS | `American Megatrends International, LLC.` `G815LR.331` `2025-11-19` | `BIOS Version: … G815LR.331, 2025-11-19` | `systeminfo` |
| volumes | 4개(C:/D:/G:/F:) | 동일 | — |
| app | v0.4.2 · tauri 2.11.2 · webview 152.0.4191.53 · debug | — | — |

`notes`는 **빈 배열**. 소요는 첫 수집 **4,913ms**(목표 <10s), 캐시 hit **3ms**, `force:true` 3,321ms.

### 8.5 검증

- `cargo test` **exit 0** — 149 passed / 0 failed / 1 ignored. `sysinfo_static` 유닛 5개:
  `cim_sample_fills_system_info`(이 머신 실제 출력으로 교체) · `gpu_registry_dedups_and_prefers_qw_memory`(신규) ·
  `class_errors_become_notes_without_losing_others`(신규) · `cim_tolerates_missing_fields` · `dates_are_normalized`.
- e2e 18 격리 실행 **32 pass / 0 fail / 0 skip**(10.9s) — §5-3의 셰이프·Windows 전용(gpus/board/cacheL3Kb)·
  `force` 재수집·캐시 hit 3.7ms 포함.

### 8.6 해소(2026-09-03) — 하이브리드 CPU의 L3 합산

`Win32_CacheMemory`가 Level 5(L3)를 **코어 클러스터마다 한 번씩** 보고해(36864 × 2) §3.1의 "같은
레벨은 합산"이 73728KB(72MB)를 냈다. **`Win32_Processor.L3CacheSize` 합을 우선**하도록 고쳤다 —
소켓마다 한 인스턴스라 다중 소켓(2소켓 Xeon 33792 × 2 = 67584)에서는 합산이 그대로 맞고, 하이브리드
CPU의 클러스터 중복만 사라진다. Level 5 합은 `Win32_Processor`가 L3를 안 주는 환경(가상머신 등)의
폴백으로만 남겼다. 실측 **36864**(`sys_info_static {force:true}`), 유닛 테스트 3종(이 머신·2소켓·폴백)으로 고정.
