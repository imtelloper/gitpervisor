# 리소스 모니터 PC 관리(pc_care) 설계

GoClean(고클린, 2007~서비스 종료) 분석에서 고른 기능을 리소스 모니터에 넣는다. 2026-10-16.

## 0. 출처 — GoClean 분석 요약

REA + Ghidra 12.1.4로 `C:\Program Files (x86)\GoClean\GoClean.exe`(x86 MFC, sha256 `e6b08ddc…`)를 열고
문자열(CP949·UTF-16)·임포트를 봤다. 관찰(문자열·임포트)과 추정을 나눈다.

| GoClean 기능 | 관찰된 근거 | 채택 |
|---|---|---|
| 하드디스크 상태점검(S.M.A.R.T) | `CAtaSmart`·`DoIdentifyDeviceNVMe*`·NVMe 속성 문구(남은 예비 영역·수명 사용 정도·안전하지 않은 종료 횟수…), `DiskInfo-License.txt` = CrystalDiskInfo(MIT) | ✅ 디스크 건강 |
| 블루스크린 발생수·버그 코드 | `%s\Minidump`, `OpenEventLogA`, 버그 코드별 원인 문구 | ✅ 비정상 종료 이력(원인 추정 문구는 넣지 않는다) |
| CPU/그래픽카드 온도 | `cpuidsdk.dll`(CPUID 상용 SDK) | ✅ GPU 온도만 — CPU는 Windows에서 드라이버 없이 못 읽는다 |
| 시작프로그램 관리/복원 | `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`(+Wow6432Node)·`Startup Folder`·`Common Startup Folder` | ✅ 단, 삭제 대신 **사용 안 함**(되돌릴 수 있음) |
| 작업 스케줄러 관리/복원 | `%WINDIR%\System32\Tasks`·`CTaskSchedulerDlg` | ✅ 사용/사용 안 함 |
| 서비스 관리 | "기타 회사에서 제작한 서비스만 나타나게" 문구 | ✅ 시작/중지 + Microsoft 숨기기 |
| 프로그램 삭제(백신·금융보안 분류) | `CurrentVersion\Uninstall`·`UninstallString`·금융보안 제품명 목록 | ✅ 설치된 프로그램 + 분류 |
| ActiveX 삭제 | "15/30/60일 동안 사용되지 않는 ActiveX" | ✅ Windows 전용 |
| 파일 강제삭제 | `ForceDel.dll`, `SystemHandleInformation`·`NtQuerySystemInformation`·`DuplicateHandle` → 남의 핸들 강제 닫기 **추정** | ✅ **안전한 대체**: 잠근 프로세스 찾기 → 기존 "작업 끝내기" |
| 내 컴퓨터 IP | `GetAdaptersInfo`(임포트 관찰) | ✅ 네트워크 정보(공인 IP 조회는 외부 서버 호출이라 뺀다) |
| 하드디스크 최적화 | `SHEmptyRecycleBinA`, 임시·IE 캐시·Prefetch 경로 | ✅ 정리 가능 공간(임시·휴지통·크래시 덤프·개발 캐시) |
| 메모리 최적화 | `SystemMemory.dll`, 워킹셋 API 임포트 **없음** | ❌ 효과 근거 없음 |
| 윈도우즈 프로세스 초기화 | "기본 프로세스와 백신/메신저를 제외한 모든 프로세스를 종료" | ❌ 위험 |
| 레지스트리·익스플로러 최적화, 윈도우 팁, 인터넷 최적화, DNS 변조 체크, 개인정보 삭제, 종료 타이머 | XP/IE 시대 레지스트리 값(`windowtip.dat`) | ❌ 현행 OS에 무의미하거나 해롭다 |

## 1. 화면 배치

리소스 모니터 탭: `프로세스 · 디스크 · 시작프로그램 · 서비스 · 프로그램 · 건강 · 시스템 정보`.

| 탭 | 내용 | 컴포넌트 |
|---|---|---|
| 프로세스 | 헤더에 [파일 잠금 찾기] 버튼 → 대화상자 | `FileLockDialog.tsx` |
| 디스크 | 빈 상태(드라이브 선택 전) 아래 "정리 가능 공간" 패널 | `CleanupPanel.tsx` |
| 시작프로그램 | 위: 시작프로그램, 아래: 예약 작업 | `StartupView.tsx` |
| 서비스 | 서비스 목록 + 시작/중지 | `ServicesView.tsx` |
| 프로그램 | 설치된 프로그램(분류 필터) + ActiveX(Windows) | `ProgramsView.tsx` |
| 건강 | 디스크 건강 카드 · GPU 온도 · 비정상 종료 이력 | `HealthView.tsx` |
| 시스템 정보 | 기존 + 네트워크 카드 | `SystemInfoView.tsx`(기존) |

목록 화면은 기존 프로세스/디스크 탭과 같은 표 스타일(11px, `border-edge`, hover `bg-hover`)을 쓴다. 우클릭 메뉴는
SysMonitorWindow의 프로세스 메뉴와 같은 모양. 상태를 바꾸는 동작은 모두 `ConfirmHost` 확인을 거친다.

## 2. 공통 계약

- Rust 모듈: `src-tauri/src/pc_care/<기능>.rs`, 커맨드는 전부 `#[tauri::command(async)]` + `Result<T, IpcError>`.
- 문구: Rust `crate::i18n::text_pccare::*`(한 파일, 기능별 절 구분), TS `src/i18n/text-pccare-<탭>.ts` →
  `msg.pccareHealth` / `pccareStartup` / `pccareServices` / `pccarePrograms` / `pccareTools`.
- IPC 래퍼: `src/lib/ipc.ts`의 `// ── pc_care: <탭> ──` 절. 조회는 `call`(`lane: "background"`), 변경은 `callMutating`.
- 권한: 관리자 권한이 필요한데 없으면 `ErrorCode::PermissionDenied`(TS `"PERMISSION_DENIED"`). 프런트는 이 코드면
  "관리자 권한으로 다시 시도"를 보이고, 누르면 같은 커맨드를 `elevate: true`로 다시 부른다.
- **승격**은 `pc_care::elevate`만 쓴다(§3). 다른 곳에서 `runas`·`pkexec`·`osascript`를 직접 부르지 않는다.
- 외부 프로그램 출력 수집은 `sysinfo_static::run_capture`(타임아웃·창 숨김·프로세스 그룹 정리)를 `pub(crate)`로 열어 쓴다.
- 없는 OS·없는 도구는 빈 목록이 아니라 `supported: false` + 사유(`unsupportedReason`) 또는 `ToolNotFound`로 **드러낸다**
  (DOCS 원칙: 세 OS 설계, 미지원은 명시).

## 3. 승격(elevate.rs)

| OS | 방법 | 대상 프로그램 |
|---|---|---|
| Windows | `ShellExecuteExW("runas")` + 종료 대기(60초) + 종료 코드 | `%SystemRoot%\System32\`의 `sc.exe`·`schtasks.exe`·`reg.exe`·`regsvr32.exe`만 |
| Linux | `pkexec <절대경로> args…` | `/usr/bin/systemctl` 등 호출처가 넘긴 절대경로 |
| macOS | `osascript -e 'do shell script "<명령>" with administrator privileges'` | 인자는 `[A-Za-z0-9._/:@-]`만 허용(셸 문자열이라) |

- 인자에 `"`·NUL·줄바꿈이 있으면 거절한다(Windows 명령줄 따옴표 규칙을 깨는 유일한 문자). 공백은 따옴표로 감싼다.
- UAC 취소(`ERROR_CANCELLED` 1223)·pkexec 126/127 → `ErrorCode::Cancelled`. 종료 코드 ≠ 0 → `Io` + 코드.
- 단위 테스트: 명령줄 조립(공백·역슬래시 끝), 금지 문자 거절.

## 4. 기능별

### 4.1 디스크 건강 (`disk_health.rs`, `disk_health_list`)

```ts
interface DiskHealth { index: number; model: string; serial: string | null; bus: string; sizeBytes: number | null;
  kind: "nvme" | "ata" | "other"; status: "ok" | "warning" | "critical" | "unknown";
  temperatureC: number | null; percentageUsed: number | null; availableSparePct: number | null;
  availableSpareThresholdPct: number | null; powerOnHours: number | null; powerCycles: number | null;
  unsafeShutdowns: number | null; mediaErrors: number | null; errorLogEntries: number | null;
  dataReadBytes: number | null; dataWrittenBytes: number | null; criticalWarning: number | null;
  unreadableReason: string | null }
```

- **Windows**(실측 2026-10-16, 비관리자): `\\.\PhysicalDriveN`을 **접근 권한 0**으로 열고 `IOCTL_STORAGE_QUERY_PROPERTY`
  (`StorageDeviceProtocolSpecificProperty`=50, NVMe·LogPage·`NVME_LOG_PAGE_HEALTH_INFO`=2, 512B) → 내장 NVMe 값이 나온다.
  `GENERIC_READ`로 열면 5(거부). USB 브리지 디스크는 같은 호출이 1(`ERROR_INVALID_FUNCTION`)이라 `unreadableReason`으로 둔다.
  모델·버스는 `IOCTL_STORAGE_QUERY_PROPERTY`(`StorageDeviceProperty`). 드라이브 번호는 0..32를 열어 보며 2(없음)를 건너뛴다.
  SATA SMART(`SMART_RCV_DRIVE_DATA`)는 앱이 관리자로 돌 때만 되므로 1차에서는 읽지 않는다 → `unreadableReason` = "SATA는 아직 미지원(NVMe만)".
  크기는 접근 0 핸들로도 되는 `IOCTL_DISK_GET_DRIVE_GEOMETRY_EX`.
- 상태 판정(순수 함수, 테스트): critical_warning≠0 또는 spare<threshold → critical; percentageUsed≥90 또는 mediaErrors>0
  또는 temp≥70 → warning; 값이 있으면 ok, 하나도 없으면 unknown.
- **Linux/macOS**: `smartctl --json -a /dev/…` (`smartctl --scan --json`으로 장치 목록). 없으면 `ToolNotFound`
  (설치 안내: smartmontools). `-n standby`로 잠든 HDD를 깨우지 않고, 장치들을 동시에 묻는다. Linux에서 smartctl이 권한 거부면
  그 디스크의 `unreadableReason`에 메시지를 두고(전체 실패로 만들지 않는다 — 읽히는 디스크를 버리게 된다) 모델·시리얼·온도는
  `/sys/class/nvme/<컨트롤러>`에서 채운다. smartctl이 없을 때도 같은 sysfs 경로.

### 4.2 GPU 온도 (`gpu_temp.rs`, `gpu_temperatures`)

`{ supported; unsupportedReason; gpus: { name; temperatureC: number | null; source }[] }`(macOS가 빈 목록 대신 미지원을 말하도록), 5초 폴링(HealthView가 볼 때만).
- Windows: `D3DKMTEnumAdapters2` → 어댑터마다 `D3DKMTQueryAdapterInfo(KMTQAITYPE_ADAPTERPERFDATA)`의
  `Temperature`(0.1℃ 단위, 0이면 미지원) — 작업 관리자와 같은 경로라 관리자 불필요. 이름은 sysinfo_static GPU 이름과 LUID 매칭이
  어려우면 `D3DKMT_ADAPTERREGISTRYINFO`의 이름.
- Linux: `/sys/class/drm/card*/device/hwmon/hwmon*/temp1_input`(amdgpu·i915), 없으면 `nvidia-smi --query-gpu=name,temperature.gpu --format=csv,noheader,nounits`.
- macOS: 지원 안 함(`supported: false` — SMC는 비공개 API).

### 4.3 비정상 종료 이력 (`crash_history.rs`, `crash_history_list`)

`{ supported: boolean; unsupportedReason: string | null; events: { timeMs: number; kind: "bugcheck" | "unexpectedShutdown" | "kernelPanic"; code: string | null; detail: string | null }[] }`
- Windows: `wevtutil qe System /q:"*[System[(EventID=1001 and Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting']) or (EventID=41 and Provider[@Name='Microsoft-Windows-Kernel-Power']) or EventID=6008]]" /f:xml /c:100 /rd:true` (비관리자 가능).
  XML에서 `TimeCreated/@SystemTime`, 41의 `BugcheckCode`(10진→`0x%08X`), 1001의 첫 `Data`(버그체크 문자열)를 뽑는다. 합치기:
  같은 정지 코드의 1001이 10분 안에 있으면 41을 버리고(1001은 재부팅 후 덤프 처리 뒤에 써진다), 41·1001이 2분 안에 있으면 6008을 버린다.
  일치하는 이벤트가 없으면 wevtutil은 아무것도 출력하지 않는다 — 빈 목록으로 본다. 파서는 순수 함수 + 테스트(고정 XML).
  읽을 수 없는 출처(Linux `last` 없음, macOS 폴더 권한)는 `supported: true` + `unsupportedReason`에 사유 — "이력 없음"과 구분한다.
- Linux: `last -x -F reboot shutdown` 출력에서 shutdown 없이 다음 reboot가 온 구간 = unexpectedShutdown(순수 파서+테스트), `/var/lib/systemd/pstore`의 항목 = kernelPanic.
- macOS: `/Library/Logs/DiagnosticReports/*.panic`(+`Retired/`) 파일 mtime = kernelPanic.

### 4.4 시작프로그램 (`startup_items.rs`, `startup_list` / `startup_set_enabled(id, enabled, elevate)`)

`{ id: string; name: string; command: string; location: string; scope: "user" | "machine"; enabled: boolean; publisher: string | null; exePath: string | null }`
- Windows: `HKCU|HKLM\…\Run`, `HKLM\SOFTWARE\WOW6432Node\…\Run`, 사용자·공용 시작 폴더. 켜짐 여부는 작업 관리자와 같은
  `…\Explorer\StartupApproved\{Run,Run32,StartupFolder}`의 12바이트 값(첫 바이트 짝수=켜짐, 3·홀수=꺼짐 — 값 없음=켜짐).
  끄기/켜기 = StartupApproved 값 쓰기(원본 Run 값은 **건드리지 않는다**). HKLM 항목은 관리자 필요 → `PermissionDenied`, 승격은
  `reg.exe add HKLM\…\StartupApproved\Run /v <이름> /t REG_BINARY /d <hex> /f`.
- macOS: `~/Library/LaunchAgents`·`/Library/LaunchAgents`·`/Library/LaunchDaemons`의 plist(`Label`·`ProgramArguments`·`Disabled`),
  끄기 = `launchctl disable gui/<uid>/<label>`(사용자 것) / 승격 `system/<label>`.
- Linux: `~/.config/autostart/*.desktop` + `/etc/xdg/autostart/*.desktop`. 끄기 = 사용자 폴더에 같은 이름 사본을 만들고
  `Hidden=true`(XDG 규칙 — 시스템 파일은 건드리지 않는다).
- `id` = `<location>|<이름>` 그대로(조립 규칙은 Rust 한 곳, 프런트는 불투명 값으로 다룬다).

### 4.5 예약 작업 (`scheduled_tasks.rs`, `scheduled_tasks_list(includeMicrosoft)` / `scheduled_task_set_enabled(path, enabled, elevate)`)

`{ path: string; name: string; enabled: boolean; state: "ready" | "running" | "disabled" | "queued" | "unknown"; lastRunMs: number | null; nextRunMs: number | null; lastResult: number | null; author: string | null; command: string | null }`
- Windows: Task Scheduler COM(`windows` 크레이트 `ITaskService`) 재귀 열거. `\Microsoft\` 아래는 기본 숨김.
  끄기/켜기 = `IRegisteredTask::SetEnabled`; 거부(E_ACCESSDENIED)면 `PermissionDenied`, 승격은 `schtasks.exe /Change /TN <path> /DISABLE|/ENABLE`.
- Linux: `systemctl --user list-timers --all -o json` + `crontab -l`(읽기 전용, `enabled`는 timer만 토글: `systemctl --user enable|disable`).
- macOS: `crontab -l`(읽기 전용) — launchd 주기 작업은 시작프로그램 목록에 이미 나온다.

### 4.6 서비스 (`services.rs`, `services_list(includeMicrosoft)` / `service_control(name, action: "start"|"stop"|"restart", elevate)` / `service_set_start_type(name, "auto"|"manual"|"disabled", elevate)`)

`{ name: string; displayName: string; description: string | null; state: "running" | "stopped" | "startPending" | "stopPending" | "paused" | "unknown"; startType: "auto" | "autoDelayed" | "manual" | "disabled" | "boot" | "system" | "unknown"; pid: number | null; binaryPath: string | null; isMicrosoft: boolean; canStop: boolean }`
- Windows: SCM(`EnumServicesStatusExW`·`QueryServiceConfigW`·`QueryServiceConfig2W`) — 비관리자로 열거 가능. `isMicrosoft` =
  실행 파일의 VersionInfo CompanyName이 Microsoft로 시작(파일 하나 한 번 — 경로별 캐시). 제어는 먼저 직접(`OpenServiceW`+
  `ControlService`/`StartServiceW`), 거부면 `PermissionDenied`, 승격 `sc.exe start|stop <name>` / `sc.exe config <name> start= auto|demand|disabled`.
- Linux: `systemctl list-units --type=service --all -o json` + `list-unit-files`(시작 유형). 제어 `systemctl start|stop|restart`
  (polkit이 직접 묻는다 — 실패면 승격 경로로 `pkexec`). `isMicrosoft`는 항상 false, 대신 "시스템 기본" 판정 없음.
- macOS: `launchctl print system`이 무겁고 형식이 불안정해 **목록만**: `launchctl list`(사용자 도메인) — 제어는 `supported: false`.
- 이름 검증: 공통 = 비지 않음·256자 이하·제어 문자 없음. Windows 직접 경로는 그 외 제한 없음(명령줄을 만들지 않는다), 승격 경로는
  `[A-Za-z0-9_.@$()+, -]`(`Intel(R) … Service` 같은 실제 이름). Linux는 systemd 단위 문자 집합 + `.service` 접미사.
  제어 전에 Win32 서비스인지(`SERVICE_WIN32`) 확인한다 — 커널 드라이버는 목록에 없으니 제어도 거절.
- "자동"으로 바꿀 때 지연 시작 플래그도 끈다(`ChangeServiceConfig2W`, 승격 경로는 남아 있으면 `reg add … DelayedAutostart 0`).

### 4.7 설치된 프로그램 (`installed_apps.rs`, `installed_apps_list` / `installed_app_uninstall(id)`)

`{ id: string; name: string; publisher: string | null; version: string | null; installDateMs: number | null; sizeBytes: number | null; location: string | null; category: "security" | "finance" | "other"; scope: "user" | "machine"; canUninstall: boolean }`
- Windows: `HKLM`(64·32비트 뷰)·`HKCU`의 `…\Uninstall\*`. `SystemComponent=1`·`ParentKeyName` 있는 업데이트·이름 없음은 뺀다.
  분류(순수 함수+테스트): 금융보안 = GoClean 목록에서 뽑은 키워드(Veraport·AnySign·TouchEn·nProtect·INISAFE·MagicLine·
  KSign·XecureWeb·IPinside·Delfino·ASTx·CrossEx·SignKorea·UniSign·K-Defense·Wizvera·AhnLab Safe Transaction·Interezen 등),
  백신 = V3·알약·Defender 제외 등. 제거 = `UninstallString`을 **셸 없이** `CommandLineToArgvW`로 쪼개 `CreateProcess`
  (MsiExec는 `/X{GUID}`로 바꿔 대화형 제거). 제거 프로그램이 스스로 UAC를 띄운다.
- macOS: `/Applications`·`~/Applications`의 `.app`(Info.plist 이름·버전, 크기는 나중에) — 제거 = 휴지통(`trash` 크레이트, 이미 의존성).
- Linux: `dpkg-query -W -f '${Package}\t${Version}\t${Installed-Size}\n'` 또는 `rpm -qa --qf …`, flatpak `flatpak list --app --columns=…`.
  제거는 `canUninstall: false` + 명령 복사(`sudo apt remove <pkg>`) — 의존성 연쇄 삭제를 앱이 대신 결정하지 않는다.

### 4.8 ActiveX (`activex.rs`, `activex_list` / `activex_remove(clsid)`), Windows 전용

- `HKLM\SOFTWARE\Microsoft\Code Store Database\Distribution Units\{CLSID}`(+WOW6432Node): 이름(`(기본값)` 또는 CLSID의
  `HKCR\CLSID\{…}` 이름), `InstalledVersion`, `Contains\Files`의 파일, `DownloadInformation\CODEBASE`, 파일 접근 시각(마지막 사용 근사).
- 제거(항상 승격 — HKLM): `regsvr32.exe /u /s`는 **컨트롤 자신의 파일 하나**에만 — `HKCR\CLSID\{…}\InprocServer32`(같은 레지스트리 뷰)이면서
  `Contains\Files`에도 있고, `.dll`/`.ocx`이며, System32·SysWOW64 밖이고, `SharedDLLs` 카운트 ≤ 1인 파일. `Contains\Files`에는
  oleaut32 같은 공유 런타임도 들어 있어 "포함 파일마다"는 시스템을 망가뜨린다. 그다음 `reg.exe delete <DU 키> /f`. 파일 자체는 지우지 않는다.
  "마지막 사용"도 System32·SysWOW64 파일은 뺀다(공유 런타임은 늘 열려 있다).
- CLSID 형식 검증 `^\{[0-9A-Fa-f-]{36}\}$`. 다른 OS는 `supported: false`.

### 4.9 파일 잠금 찾기 (`file_locks.rs`, `file_lockers(path)`)

`{ pid: number; name: string; exePath: string | null; reason: string }[]`
- Windows: Restart Manager(`RmStartSession`→`RmRegisterResources`→`RmGetList`). 폴더면 안의 파일을 최대 2,000개 등록
  (넘으면 결과에 `truncated`) + 실행 파일·작업 폴더가 그 아래인 프로세스(monitor의 exe 경로) 추가.
- Linux: `/proc/*/fd`·`/proc/*/cwd` 심링크 대상이 경로(또는 하위)인 프로세스(읽을 수 있는 것만 — 남의 프로세스는 권한 없음을 결과에 표시).
- macOS: `lsof -F pcn -- <파일>` / 폴더면 `lsof -F pcn +D <폴더>`(타임아웃 20초).
- 결과 행의 [작업 끝내기]는 기존 `kill_processes`를 그대로 부른다(앱 자신 제외 규칙 재사용).

### 4.10 정리 가능 공간 (`cleanup.rs`, `cleanup_scan()` / `cleanup_run(ids)`)

`{ id: string; label: string; path: string | null; bytes: number; files: number; kind: "temp" | "recycleBin" | "crashDumps" | "devCache" | "thumbnail"; note: string | null }[]`
- 후보(있는 것만): 사용자 임시(`%TEMP%`/`$TMPDIR`), 휴지통, 크래시 덤프(`%LOCALAPPDATA%\CrashDumps`, WER ReportArchive/ReportQueue),
  썸네일 캐시(`%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db`, ~/.cache/thumbnails), 개발 캐시(npm `npm config get cache`
  대신 기본 경로, yarn·pnpm store, pip, cargo `registry/cache`, gradle `caches`, Go `go-build`) — 경로는 OS별 상수 + 환경변수.
- **삭제 안전 규칙(필수)**: 심링크·정션(재분석 지점)은 따라가지 않고 링크 자체만 지운다(`symlink_metadata`); 후보 루트 밖으로
  나가는 경로는 거절; 루트 디렉터리 자체는 남기고 내용만 지운다; 잠긴 파일은 건너뛰고 개수를 돌려준다; 14일(크래시 덤프 제외)
  이내 수정된 임시 파일은 건너뛴다(실행 중인 설치 프로그램 보호). 휴지통은 Windows `SHEmptyRecycleBinW(SHERB_NOCONFIRMATION|NOPROGRESSUI)`,
  macOS/Linux는 Trash 폴더 내용.
- 일반 파일만 지운다(소켓·FIFO·장치 노드는 건너뜀). "최근"은 수정·생성(Unix는 ctime) 시각 중 하나라도 14일 안이면 — 설치 프로그램이
  옛 수정 시각을 유지한 채 풀어 놓은 파일을 지키기 위해서다.
- 결과: `{ freedBytes, deletedFiles, skippedFiles }`. 테스트: 정션/심링크 밖 파일이 살아남는지(임시 폴더 픽스처).

### 4.11 네트워크 정보 (`sysinfo_static.rs` 확장)

`SystemInfo.networks: { name: string; mac: string | null; ipv4: string[]; ipv6: string[]; rxBytes: number; txBytes: number }[]` —
sysinfo `Networks`(세 OS 공통). 루프백·MAC 00:00…·IP 없음은 뺀다. 시스템 정보 탭에 "네트워크" 카드 + 요약 복사에 포함.

## 5. 검증

- 단위: 상태 판정·XML/last 파서·분류·StartupApproved 바이트 해석·명령줄 조립·정리 안전 규칙.
- 실동작(dev 앱, Windows): 각 탭이 실제 값으로 그려지는지 CDP로 확인. 상태 변경은 되돌릴 수 있는 것만 실측(사용자 시작프로그램 끄기→켜기,
  사용자 예약 작업 끄기→켜기, 임시 폴더 픽스처 정리). 서비스 중지·프로그램 제거·ActiveX 제거·HKLM 변경은 **실측하지 않는다**(UAC·되돌리기 어려움).
- 미실측: macOS·Linux 전부(같은 계약, 실기 필수).
