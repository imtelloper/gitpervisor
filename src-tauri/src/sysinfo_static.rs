//! 시스템 정보(OS·하드웨어 사양) 1회 수집 — DOCS/task/31-sysmon-system-info.md.
//!
//! 전략(§3.1): **sysinfo 공통 + 플랫폼별 일회성 명령 1개**. 신규 크레이트 0.
//! - Windows: `powershell.exe` 1회로 CIM 클래스 6개 + 레지스트리 VRAM을 한 JSON으로.
//! - Linux: `/proc`·`/sys` 파일 + `lspci`/`nvidia-smi`(있을 때만).
//! - macOS: `sysctl` + `system_profiler ... -json` 1회.
//!
//! 못 구한 항목은 **그 항목만** None이고 이유는 [`SystemInfo::notes`]에 남는다 — 탭 전체가
//! 죽지 않는다(§1). `Monitor`의 sysinfo 인스턴스는 건드리지 않고 지역 `System::new()`를 쓴다
//! (수 초짜리 수집이 2초 폴링의 뮤텍스를 잡으면 안 된다 — §6).

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{DiskKind, Disks, System};
use tauri::AppHandle;
use tokio::process::Command;

use crate::error::IpcError;

// ─────────────────────────── 데이터 계약 (§3.2, 프론트와 camelCase 1:1) ───────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    pub name: String,
    pub version: String,
    /// Windows 빌드 번호(CIM) / macOS 빌드(kern.osversion). Linux는 빈 값.
    pub build: String,
    pub kernel: String,
    pub arch: String,
    pub host_name: String,
    pub boot_time_ms: u64,
    pub uptime_secs: u64,
    pub install_date: Option<String>,
    pub user_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub brand: String,
    pub vendor: String,
    pub physical_cores: Option<u32>,
    pub logical_cores: u32,
    /// 명판 기본 클럭. Windows는 CIM `MaxClockSpeed`(= 부스트가 아닌 base), macOS는
    /// `hw.cpufrequency`. Linux는 노출이 제각각이라 None으로 둔다.
    pub base_mhz: Option<u64>,
    /// 부스트 상한. Linux `cpuinfo_max_freq`, macOS `hw.cpufrequency_max`.
    pub max_mhz: Option<u64>,
    /// 지금 이 순간의 코어 평균(sysinfo). 0이면 측정 불가로 보고 None.
    pub current_mhz_avg: Option<u64>,
    pub cache_l1_kb: Option<u64>,
    pub cache_l2_kb: Option<u64>,
    pub cache_l3_kb: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryModule {
    pub slot: String,
    pub capacity_bytes: u64,
    pub speed_mhz: Option<u32>,
    pub manufacturer: Option<String>,
    pub part_number: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub swap_total_bytes: u64,
    /// 슬롯별 물리 모듈 — Windows(CIM)·Intel macOS(SPMemoryDataType)만. Linux는 `dmidecode`가
    /// 루트를 요구해 제외했다(§3.1) — 총량·스왑만 채운다.
    pub modules: Vec<MemoryModule>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub driver_version: Option<String>,
    pub driver_date: Option<String>,
    pub vram_bytes: Option<u64>,
    /// 외장/내장 구분. 확실히 알 수 있는 경로(nvidia-smi 등)에서만 채우고, 이름 추측은 하지 않는다.
    pub is_discrete: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardInfo {
    pub manufacturer: String,
    pub product: String,
    pub bios_vendor: String,
    pub bios_version: String,
    pub bios_date: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub name: String,
    pub mount: String,
    pub fs: String,
    /// "ssd" | "hdd" | "unknown"
    pub kind: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub removable: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub tauri_version: String,
    pub webview_version: String,
    /// "debug" | "release"
    pub build_profile: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub collected_at_ms: u64,
    pub os: OsInfo,
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
    pub gpus: Vec<GpuInfo>,
    pub board: Option<BoardInfo>,
    pub volumes: Vec<VolumeInfo>,
    pub app: AppInfo,
    /// 수집 실패 항목 사유("CIM: 시간 초과" 등) — UI가 "정보 없음" 툴팁에 쓴다.
    pub notes: Vec<String>,
}

// ─────────────────────────── 커맨드 ───────────────────────────

/// 수집 결과 캐시. 하드웨어는 부팅 중에 바뀌지 않으므로 창을 다시 열어도 재수집하지 않는다.
/// 수집 중 동시 호출은 서로 기다리지 않고 각자 수집한다 — 모니터 창은 하나뿐이라 실질 1회다(§3.2).
static CACHE: Mutex<Option<SystemInfo>> = Mutex::new(None);

/// 시스템 정보 1회 수집(캐시). `force`면 캐시를 무시하고 다시 훑는다.
///
/// `Result`지만 실제로 Err를 내지는 않는다 — 플랫폼 명령 실패는 항목 단위 None + `notes`로
/// 흡수하는 게 이 화면의 계약이다(§1). 반환형은 프론트 계약(§4)에 맞춰 유지한다.
#[tauri::command(async)]
pub async fn sys_info_static(app: AppHandle, force: bool) -> Result<SystemInfo, IpcError> {
    if !force {
        // 락 가드를 await 너머로 들고 가지 않도록 값만 꺼내 온다.
        let cached = CACHE.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(info) = cached {
            return Ok(info);
        }
    }
    let info = collect(&app).await;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.clone());
    Ok(info)
}

async fn collect(app: &AppHandle) -> SystemInfo {
    #[allow(unused_mut)] // 지원 플랫폼(win/linux/mac) 밖에서는 아무도 채우지 않는다
    let mut notes: Vec<String> = Vec::new();

    // 공통(sysinfo) — Monitor와 별개 인스턴스.
    let mut sys = System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpus = sys.cpus();
    let current_mhz_avg = if cpus.is_empty() {
        None
    } else {
        let sum: u64 = cpus.iter().map(|c| c.frequency()).sum();
        let avg = sum / cpus.len() as u64;
        (avg > 0).then_some(avg)
    };

    let mut info = SystemInfo {
        collected_at_ms: now_ms(),
        os: OsInfo {
            name: System::long_os_version()
                .or_else(System::name)
                .unwrap_or_default(),
            version: System::os_version().unwrap_or_default(),
            build: String::new(),
            kernel: System::kernel_version().unwrap_or_default(),
            arch: System::cpu_arch(),
            host_name: System::host_name().unwrap_or_default(),
            boot_time_ms: System::boot_time().saturating_mul(1000),
            uptime_secs: System::uptime(),
            install_date: None,
            user_name: std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .ok()
                .filter(|s| !s.is_empty()),
        },
        cpu: CpuInfo {
            brand: cpus
                .first()
                .map(|c| c.brand().trim().to_string())
                .unwrap_or_default(),
            vendor: cpus
                .first()
                .map(|c| c.vendor_id().trim().to_string())
                .unwrap_or_default(),
            physical_cores: sys.physical_core_count().map(|n| n as u32),
            logical_cores: cpus.len() as u32,
            base_mhz: None,
            max_mhz: None,
            current_mhz_avg,
            cache_l1_kb: None,
            cache_l2_kb: None,
            cache_l3_kb: None,
        },
        memory: MemoryInfo {
            total_bytes: sys.total_memory(),
            swap_total_bytes: sys.total_swap(),
            modules: Vec::new(),
        },
        gpus: Vec::new(),
        board: None,
        volumes: volumes(),
        app: app_info(app),
        notes: Vec::new(),
    };

    #[cfg(windows)]
    fill_windows(&mut info, &mut notes).await;
    #[cfg(target_os = "linux")]
    fill_linux(&mut info, &mut notes).await;
    #[cfg(target_os = "macos")]
    fill_macos(&mut info, &mut notes).await;

    info.notes = notes;
    info
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn volumes() -> Vec<VolumeInfo> {
    Disks::new_with_refreshed_list()
        .list()
        .iter()
        .map(|d| VolumeInfo {
            name: d.name().to_string_lossy().into_owned(),
            mount: d.mount_point().to_string_lossy().into_owned(),
            fs: d.file_system().to_string_lossy().into_owned(),
            kind: match d.kind() {
                DiskKind::SSD => "ssd",
                DiskKind::HDD => "hdd",
                DiskKind::Unknown(_) => "unknown",
            }
            .to_string(),
            total_bytes: d.total_space(),
            available_bytes: d.available_space(),
            removable: d.is_removable(),
        })
        .collect()
}

fn app_info(app: &AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview_version: tauri::webview_version().unwrap_or_default(),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
        .to_string(),
    }
}

// ─────────────────────────── 외부 명령 (git/runner.rs 규약) ───────────────────────────

/// 출력을 읽는 외부 실행의 단일 관문 — `git/runner.rs:118-177`과 같은 규약:
/// args 배열(셸 문자열 조합 없음), stdin null, kill_on_drop, CREATE_NO_WINDOW,
/// unix 새 프로세스 그룹, `tokio::time::timeout` + killpg.
///
/// **종료 코드는 보지 않는다.** `sysctl`은 없는 키 하나에 1로 끝나면서도 나머지는 정상 출력하고,
/// `lspci`도 장치 종류에 따라 경고와 함께 끝난다 — 호출자가 내용으로 판단한다(빈 출력 = 실패).
async fn run_capture(program: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: 콘솔 창 깜빡임 방지
    #[cfg(unix)]
    cmd.process_group(0); // 새 프로세스 그룹 리더 — 타임아웃 시 손자까지 killpg로 정리

    let child = cmd
        .spawn()
        .map_err(|e| crate::i18n::text_system::sysinfo_program_spawn_failed(program, e))?;
    let pid = child.id();

    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait_with_output())
        .await
        .map_err(|_| {
            kill_group(pid);
            crate::i18n::text_system::sysinfo_program_timed_out(program, timeout_secs)
        })?
        .map_err(|e| crate::i18n::text_system::sysinfo_program_output_failed(program, e))?;

    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if stdout.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let head: String = err.trim().chars().take(160).collect();
        return Err(crate::i18n::text_system::sysinfo_program_no_output(program, &head));
    }
    Ok(stdout)
}

/// 타임아웃으로 future가 drop될 때 kill_on_drop이 못 거두는 손자까지 정리한다
/// (`git/runner.rs`의 동명 함수와 같은 구현 — 그쪽이 private이라 여기 둔다).
#[cfg_attr(not(unix), allow(unused_variables))]
fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        if pid > 1 {
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
        }
    }
}

// (`creation_flags`/`process_group`는 tokio::process::Command의 고유 메서드다 — runner.rs와
//  마찬가지로 별도 확장 트레이트를 import하지 않는다.)

// ─────────────────────────── 공용 파싱 도우미 ───────────────────────────

/// ConvertTo-Json이 숫자를 문자열로 낼 수도(속성 타입·PS 버전차) 있어 양쪽을 받는다.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum Num {
    U(u64),
    F(f64),
    S(String),
}

impl Num {
    fn as_u64(&self) -> Option<u64> {
        match self {
            Num::U(v) => Some(*v),
            Num::F(v) if *v >= 0.0 => Some(*v as u64),
            Num::F(_) => None,
            Num::S(s) => s.trim().parse::<u64>().ok(),
        }
    }
}

fn num(v: &Option<Num>) -> Option<u64> {
    v.as_ref().and_then(Num::as_u64)
}

/// 비어 있지 않은 문자열만 통과시킨다(CIM은 빈 문자열을 자주 준다).
fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// CIM/`system_profiler` 날짜 → `YYYY-MM-DD`.
///
/// PowerShell 5.1의 `ConvertTo-Json`은 DateTime을 `/Date(밀리초)/`로 내보낸다. 스크립트에서
/// `.ToString('o')`로 ISO 8601을 강제하지만(§6), 어느 경로로든 옛 형식이 올 수 있어 둘 다 받는다.
fn norm_date(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix("/Date(") {
        let digits: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        let ms: i64 = digits.parse().ok()?;
        return chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
            .map(|d| d.format("%Y-%m-%d").to_string());
    }
    // ISO 8601("2024-05-01T09:12:33.0000000+09:00") — 날짜 부분만 취한다.
    let head: String = s.chars().take(10).collect();
    let looks_like_date = {
        let b = head.as_bytes();
        b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b[0].is_ascii_digit()
    };
    looks_like_date.then_some(head)
}

// ─────────────────────────── Windows: PowerShell CIM 1회 ───────────────────────────

/// CIM 클래스 6개 + GPU 레지스트리를 **한 번의 PowerShell 기동**으로 받는다(개별 기동 × 1.5s 회피).
///
/// **클래스마다 독립 try**로 감싼다 — 하나가 멈춰도 나머지는 살아 돌아오고, 사유는 `errors`에
/// 담겨 `notes`가 된다. 한 덩어리로 묶으면 느린 클래스 하나가 수집 전체를 시한에 끌고 죽는다.
///
/// **GPU는 WMI를 쓰지 않는다.** `Win32_VideoController`가 이 머신에서 WMI 레벨로 무응답이라
/// (>10분, `-OperationTimeoutSec`으로도 못 끊는다) 표시 어댑터 드라이버 키
/// `Class\{4d36e968-…}\00NN`을 직접 읽는다. `DriverDesc`가 이름, VRAM은
/// `HardwareInformation.qwMemorySize`(REG_QWORD)가 정답이고 없으면 `MemorySize`(DWORD, 4GB 캡)다.
/// 두 값 모두 드라이버에 따라 REG_BINARY로 오므로 스크립트에서 정수로 편다.
///
/// 출력은 UTF-8로 고정한다 — 기본은 콘솔 코드페이지(한국어 949)라 `OSArchitecture`("64비트")가
/// 깨진 바이트로 온다.
#[cfg(windows)]
const CIM_SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$d = [ordered]@{}
$d.errors = [ordered]@{}
$cim = {
  param($key, $cls, $props, $one)
  try {
    $r = @(Get-CimInstance $cls -OperationTimeoutSec 8 -ErrorAction Stop | Select-Object $props)
    # 대입은 반드시 분기 **안에서** 한다. `$d[$key] = if (..) {..} else { $r }`로 쓰면 if 문의 i18n-ok: PowerShell 주석
    # 출력이 파이프라인을 타면서 **원소 1개짜리 배열이 스칼라로 풀려** JSON이 [..] 대신 {..}가 i18n-ok: PowerShell 주석
    # 되고, Rust 쪽 Vec 역직렬화가 통째로 실패한다(메모리 모듈 1개·소켓 1개 머신에서 실측). i18n-ok: PowerShell 주석
    if ($one) { $d[$key] = $r[0] } else { $d[$key] = $r }
  } catch { $d.errors["CIM $cls"] = $_.Exception.Message }
}
& $cim 'os' 'Win32_OperatingSystem' @('Caption','Version','BuildNumber','OSArchitecture',@{n='InstallDate';e={ if ($_.InstallDate) { $_.InstallDate.ToString('o') } }}) $true
& $cim 'cpu' 'Win32_Processor' @('Name','Manufacturer','MaxClockSpeed','NumberOfCores','NumberOfLogicalProcessors','L2CacheSize','L3CacheSize') $false
& $cim 'cache' 'Win32_CacheMemory' @('Level','InstalledSize') $false
& $cim 'memory' 'Win32_PhysicalMemory' @('Capacity','Speed','Manufacturer','PartNumber','DeviceLocator') $false
& $cim 'board' 'Win32_BaseBoard' @('Manufacturer','Product') $true
& $cim 'bios' 'Win32_BIOS' @('Manufacturer','SMBIOSBIOSVersion',@{n='ReleaseDate';e={ if ($_.ReleaseDate) { $_.ReleaseDate.ToString('o') } }}) $true
$n = { param($v) if ($v -is [byte[]]) { if ($v.Length -ge 8) { [BitConverter]::ToUInt64($v,0) } elseif ($v.Length -ge 4) { [BitConverter]::ToUInt32($v,0) } } else { $v } }
$d.gpu = @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' |
  Where-Object { $_.PSChildName -match '^\d{4}$' } | ForEach-Object {
    $p = Get-ItemProperty -LiteralPath $_.PSPath
    if ($p.DriverDesc) {
      [pscustomobject]@{
        Desc = $p.DriverDesc
        DriverVersion = $p.DriverVersion
        DriverDate = if ($p.DriverDate) { try { [datetime]::Parse($p.DriverDate, [Globalization.CultureInfo]::InvariantCulture).ToString('yyyy-MM-dd') } catch { $p.DriverDate } } else { $null }
        Provider = $p.ProviderName
        Qw = (& $n $p.'HardwareInformation.qwMemorySize')
        Mem = (& $n $p.'HardwareInformation.MemorySize')
      }
    }
  })
if ($d.gpu.Count -eq 0) { $d.errors['GPU 레지스트리'] = '표시 어댑터 항목 없음(접근 거부 가능)' } # i18n-ok: PowerShell 스크립트가 만드는 사유(외부 프로그램 문자열)
$d | ConvertTo-Json -Compress -Depth 4
"#;

#[cfg(windows)]
async fn fill_windows(info: &mut SystemInfo, notes: &mut Vec<String>) {
    // -EncodedCommand(UTF-16LE base64) — 여러 줄·따옴표·중괄호가 섞인 스크립트를 커맨드라인
    // 인용 규칙에 맡기지 않는다. pwsh가 아니라 모든 Win10/11에 있는 powershell.exe를 쓴다(§3.1).
    use base64::Engine as _;
    let utf16: Vec<u8> = CIM_SCRIPT
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);

    let raw = match run_capture(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ],
        // 클래스 6개 × 8s 최악 + PowerShell 기동. 정상은 3s 안쪽이다.
        30,
    )
    .await
    {
        Ok(s) => s,
        Err(e) => {
            notes.push(format!("CIM: {e}"));
            return;
        }
    };

    match serde_json::from_str::<CimRoot>(&raw) {
        Ok(cim) => apply_cim(info, &cim, notes),
        Err(e) => notes.push(crate::i18n::text_system::sysinfo_json_parse_failed("CIM", e)),
    }
}

// CIM 응답 구조. **cfg(windows) 밖에서도 컴파일**되게 둔다 — 파서 유닛테스트가 모든 타깃에서
// 돌아야 하기 때문이다(CI는 Linux/macOS도 돈다).
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
struct CimRoot {
    os: Option<CimOs>,
    /// `Win32_Processor`는 **소켓마다 한 인스턴스**다. 이름·코어수는 첫 소켓 것을 쓰고
    /// L3만 전 소켓 합을 쓴다([`apply_cim`]).
    #[serde(default)]
    cpu: Vec<CimCpu>,
    #[serde(default)]
    cache: Vec<CimCache>,
    #[serde(default)]
    memory: Vec<CimMem>,
    /// 표시 어댑터 드라이버 키에서 온 GPU 목록(WMI 아님 — [`CIM_SCRIPT`] 주석).
    #[serde(default)]
    gpu: Vec<RegGpu>,
    board: Option<CimBoard>,
    bios: Option<CimBios>,
    /// 실패한 항목의 사유("CIM Win32_BIOS" → 메시지). 나머지 항목은 그대로 채워져 온다.
    #[serde(default)]
    errors: BTreeMap<String, String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimOs {
    caption: Option<String>,
    version: Option<String>,
    build_number: Option<String>,
    #[serde(rename = "OSArchitecture")]
    os_architecture: Option<String>,
    install_date: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimCpu {
    name: Option<String>,
    manufacturer: Option<String>,
    max_clock_speed: Option<Num>,
    number_of_cores: Option<Num>,
    number_of_logical_processors: Option<Num>,
    #[serde(rename = "L2CacheSize")]
    l2_cache_size: Option<Num>,
    #[serde(rename = "L3CacheSize")]
    l3_cache_size: Option<Num>,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimCache {
    /// Win32_CacheMemory의 Level은 3=L1, 4=L2, 5=L3 (L1은 Win32_Processor에 없다 — §3.1).
    level: Option<Num>,
    installed_size: Option<Num>,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimMem {
    capacity: Option<Num>,
    speed: Option<Num>,
    manufacturer: Option<String>,
    part_number: Option<String>,
    device_locator: Option<String>,
}

/// 표시 어댑터 드라이버 키(`…\Class\{4d36e968-…}\00NN`) 한 항목. 스크립트가 함께 싣는
/// `Provider`(ProviderName)는 [`GpuInfo`]에 대응 필드가 없어 읽지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RegGpu {
    /// `DriverDesc` — 장치 이름.
    desc: Option<String>,
    driver_version: Option<String>,
    driver_date: Option<String>,
    /// `HardwareInformation.qwMemorySize`(QWORD).
    qw: Option<Num>,
    /// `HardwareInformation.MemorySize`(DWORD) 폴백 — 4GB에서 잘린다.
    mem: Option<Num>,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimBoard {
    manufacturer: Option<String>,
    product: Option<String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CimBios {
    manufacturer: Option<String>,
    #[serde(rename = "SMBIOSBIOSVersion")]
    smbios_bios_version: Option<String>,
    release_date: Option<String>,
}

/// CIM 응답을 SystemInfo에 얹는다. 없는 필드는 sysinfo가 채운 값을 그대로 둔다(순수 함수 — 테스트 대상).
#[cfg_attr(not(windows), allow(dead_code))]
fn apply_cim(info: &mut SystemInfo, cim: &CimRoot, notes: &mut Vec<String>) {
    // 실패한 클래스만 비고 나머지는 살린다 — 사유는 UI의 "정보 없음" 툴팁으로 간다.
    for (key, msg) in &cim.errors {
        let head: String = msg.trim().chars().take(160).collect();
        notes.push(format!("{key}: {head}"));
    }

    if let Some(os) = &cim.os {
        if let Some(v) = non_empty(os.caption.clone()) {
            info.os.name = v;
        }
        if let Some(v) = non_empty(os.version.clone()) {
            info.os.version = v;
        }
        if let Some(v) = non_empty(os.build_number.clone()) {
            info.os.build = v;
        }
        if let Some(v) = non_empty(os.os_architecture.clone()) {
            info.os.arch = v;
        }
        info.os.install_date = os.install_date.as_deref().and_then(norm_date);
    }

    // 이름·클럭·코어수·L2 폴백은 **첫 소켓** 값을 쓴다(소켓마다 다른 모델을 꽂는 구성은 없다).
    if let Some(cpu) = cim.cpu.first() {
        if let Some(v) = non_empty(cpu.name.clone()) {
            info.cpu.brand = v;
        }
        if let Some(v) = non_empty(cpu.manufacturer.clone()) {
            info.cpu.vendor = v;
        }
        info.cpu.base_mhz = num(&cpu.max_clock_speed).filter(|v| *v > 0);
        if let Some(v) = num(&cpu.number_of_cores).filter(|v| *v > 0) {
            info.cpu.physical_cores = Some(v as u32);
        }
        if let Some(v) = num(&cpu.number_of_logical_processors).filter(|v| *v > 0) {
            info.cpu.logical_cores = v as u32;
        }
        // Win32_CacheMemory가 비어 있는 환경(가상머신 등)의 폴백 — 단위는 둘 다 KB.
        info.cpu.cache_l2_kb = num(&cpu.l2_cache_size).filter(|v| *v > 0);
    }

    // L3는 `Win32_Processor.L3CacheSize`(소켓마다 한 인스턴스 = 소켓별 L3)의 합을 **우선**한다.
    // `Win32_CacheMemory`의 Level 5는 하이브리드 CPU(P/E 코어 클러스터)에서 **공유 L3 하나를
    // 클러스터마다 한 번씩** 보고해 합이 실제의 배수가 된다 — 이 머신은 36864 × 2 = 73728이 나오지만
    // 실제는 36MB다(31 §8.6). 다중 소켓은 소켓마다 진짜 L3가 따로 있으므로 이 합이 맞다.
    let l3_from_cpu: u64 = cim.cpu.iter().filter_map(|c| num(&c.l3_cache_size)).sum();

    // Level 3/4/5 = L1/L2/L3. 같은 레벨의 엔트리는 합산한다(코어 클러스터별로 나뉘어 온다).
    // L1·L2는 이 합이 맞다 — L1은 Win32_Processor에 아예 없고, L2는 24576+16384=40960으로
    // `L2CacheSize`와 일치한다(클러스터마다 **자기** L2를 보고하기 때문이다).
    let level_kb = |want: u64| -> Option<u64> {
        let sum: u64 = cim
            .cache
            .iter()
            .filter(|c| num(&c.level) == Some(want))
            .filter_map(|c| num(&c.installed_size))
            .sum();
        (sum > 0).then_some(sum)
    };
    if let Some(v) = level_kb(3) {
        info.cpu.cache_l1_kb = Some(v);
    }
    if let Some(v) = level_kb(4) {
        info.cpu.cache_l2_kb = Some(v);
    }
    // Level 5 합은 Win32_Processor가 L3를 안 줄 때(가상머신 등)만 쓴다.
    if l3_from_cpu > 0 {
        info.cpu.cache_l3_kb = Some(l3_from_cpu);
    } else if let Some(v) = level_kb(5) {
        info.cpu.cache_l3_kb = Some(v);
    }

    info.memory.modules = cim
        .memory
        .iter()
        .filter_map(|m| {
            let capacity_bytes = num(&m.capacity)?;
            Some(MemoryModule {
                slot: non_empty(m.device_locator.clone())
                    .unwrap_or_else(|| crate::i18n::text_system::sysinfo_memory_module_slot_fallback().to_string()),
                capacity_bytes,
                speed_mhz: num(&m.speed).map(|v| v as u32),
                manufacturer: non_empty(m.manufacturer.clone()),
                part_number: non_empty(m.part_number.clone()),
            })
        })
        .collect();

    // 같은 `DriverDesc`가 여러 키에 있으면(도크 어댑터 2개 등) 한 줄로 접는다.
    let mut gpus: Vec<GpuInfo> = Vec::new();
    for g in &cim.gpu {
        let Some(name) = non_empty(g.desc.clone()) else {
            continue;
        };
        if gpus.iter().any(|x| x.name == name) {
            continue;
        }
        gpus.push(GpuInfo {
            name,
            driver_version: non_empty(g.driver_version.clone()),
            driver_date: g.driver_date.as_deref().and_then(norm_date),
            // qwMemorySize가 정답, 없으면 MemorySize(4GB 캡). 둘 다 없으면 지어내지 않는다.
            vram_bytes: num(&g.qw).or_else(|| num(&g.mem)).filter(|b| *b > 0),
            // 레지스트리는 외장/내장을 알려주지 않는다 — 이름으로 추측하지 않고 비워 둔다.
            is_discrete: None,
        });
    }
    info.gpus = gpus;

    let board = cim.board.as_ref();
    let bios = cim.bios.as_ref();
    if board.is_some() || bios.is_some() {
        info.board = Some(BoardInfo {
            manufacturer: board
                .and_then(|b| non_empty(b.manufacturer.clone()))
                .unwrap_or_default(),
            product: board
                .and_then(|b| non_empty(b.product.clone()))
                .unwrap_or_default(),
            bios_vendor: bios
                .and_then(|b| non_empty(b.manufacturer.clone()))
                .unwrap_or_default(),
            bios_version: bios
                .and_then(|b| non_empty(b.smbios_bios_version.clone()))
                .unwrap_or_default(),
            bios_date: bios
                .and_then(|b| b.release_date.as_deref())
                .and_then(norm_date)
                .unwrap_or_default(),
        });
    }
}

// ─────────────────────────── Linux: /proc·/sys + lspci·nvidia-smi ───────────────────────────

#[cfg(target_os = "linux")]
async fn fill_linux(info: &mut SystemInfo, notes: &mut Vec<String>) {
    use std::fs::read_to_string;

    // CPU 모델명 폴백(sysinfo가 비워 두는 ARM SBC 등).
    if info.cpu.brand.is_empty() {
        if let Ok(txt) = read_to_string("/proc/cpuinfo") {
            if let Some(v) = txt
                .lines()
                .find(|l| l.starts_with("model name") || l.starts_with("Model"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string())
            {
                info.cpu.brand = v;
            }
        }
    }

    // 캐시 — cpu0의 index* 디렉터리. L1은 데이터+명령을 합산한다(CPU-Z 표기와 동일).
    let mut l1 = 0u64;
    if let Ok(dir) = std::fs::read_dir("/sys/devices/system/cpu/cpu0/cache") {
        for entry in dir.flatten() {
            let p = entry.path();
            let level = read_to_string(p.join("level"))
                .ok()
                .and_then(|s| s.trim().parse::<u64>().ok());
            let size = read_to_string(p.join("size"))
                .ok()
                .and_then(|s| parse_size_kb(s.trim()));
            match (level, size) {
                (Some(1), Some(kb)) => l1 += kb,
                (Some(2), Some(kb)) => info.cpu.cache_l2_kb = Some(kb),
                (Some(3), Some(kb)) => info.cpu.cache_l3_kb = Some(kb),
                _ => {}
            }
        }
    }
    if l1 > 0 {
        info.cpu.cache_l1_kb = Some(l1);
    }

    if let Some(khz) = read_to_string("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
    {
        info.cpu.max_mhz = Some(khz / 1000);
    }

    // 메인보드·BIOS — /sys/class/dmi/id는 무루트로 읽힌다(dmidecode는 루트 필요라 제외).
    let dmi = |k: &str| {
        read_to_string(format!("/sys/class/dmi/id/{k}"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    let board = BoardInfo {
        manufacturer: dmi("board_vendor"),
        product: dmi("board_name"),
        bios_vendor: dmi("bios_vendor"),
        bios_version: dmi("bios_version"),
        bios_date: dmi("bios_date"),
    };
    if !(board.manufacturer.is_empty() && board.product.is_empty() && board.bios_version.is_empty())
    {
        info.board = Some(board);
    } else {
        notes.push(crate::i18n::text_system::sysinfo_dmi_unreadable().to_string());
    }

    // GPU 목록 — lspci의 VGA/3D 행이 기본, nvidia-smi/amdgpu sysfs가 있으면 상세를 덧댄다.
    match run_capture("lspci", &["-mm"], 10).await {
        Ok(out) => {
            for line in out.lines() {
                let lower = line.to_ascii_lowercase();
                if !(lower.contains("vga compatible controller")
                    || lower.contains("3d controller")
                    || lower.contains("display controller"))
                {
                    continue;
                }
                // -mm 은 따옴표로 필드를 나눈다: slot "class" "vendor" "device" ...
                // '\u{22}' = 큰따옴표. 문자 그대로 쓰면 scripts/i18n-remaining-rs.py 의 문자열 추적이
                // 여기서 어긋나 파일 뒷부분 주석을 전부 문자열로 오인한다.
                let fields: Vec<&str> = line.split('\u{22}').skip(1).step_by(2).collect();
                let name = match (fields.get(1), fields.get(2)) {
                    (Some(vendor), Some(device)) => format!("{vendor} {device}"),
                    _ => continue,
                };
                info.gpus.push(GpuInfo {
                    name,
                    ..Default::default()
                });
            }
        }
        Err(e) => notes.push(format!("lspci: {e}")),
    }

    // NVIDIA는 확실한 외장이다 — 이름/드라이버/VRAM을 직접 준다.
    if let Ok(out) = run_capture(
        "nvidia-smi",
        &[
            "--query-gpu=name,driver_version,memory.total",
            "--format=csv,noheader,nounits",
        ],
        10,
    )
    .await
    {
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            let cols: Vec<&str> = line.split(',').map(str::trim).collect();
            let name = cols.first().copied().unwrap_or_default().to_string();
            if name.is_empty() {
                continue;
            }
            let gpu = GpuInfo {
                name: format!("NVIDIA {name}"),
                driver_version: cols.get(1).map(|s| s.to_string()).filter(|s| !s.is_empty()),
                driver_date: None,
                // memory.total 은 MiB(nounits)
                vram_bytes: cols
                    .get(2)
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(|mib| mib * 1024 * 1024),
                is_discrete: Some(true),
            };
            // lspci가 이미 올린 같은 장치를 덮는다(이름이 더 정확하고 VRAM이 붙는다).
            match info
                .gpus
                .iter()
                .position(|g| g.name.to_ascii_lowercase().contains("nvidia"))
            {
                Some(i) => info.gpus[i] = gpu,
                None => info.gpus.push(gpu),
            }
        }
    }

    // amdgpu VRAM — 카드 인덱스와 lspci 행을 맞추기 어려워 첫 AMD 항목에만 붙인다.
    if let Some(bytes) = glob_first_u64("/sys/class/drm", "device/mem_info_vram_total") {
        if let Some(g) = info.gpus.iter_mut().find(|g| {
            let n = g.name.to_ascii_lowercase();
            n.contains("amd") || n.contains("ati") || n.contains("radeon")
        }) {
            g.vram_bytes = Some(bytes);
        }
    }
}

/// `/sys/class/drm/card*/<rel>`의 첫 u64 값 — 표준 라이브러리만으로 하는 최소 글롭.
#[cfg(target_os = "linux")]
fn glob_first_u64(dir: &str, rel: &str) -> Option<u64> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut cards: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("card") && !n.contains('-'))
                .unwrap_or(false)
        })
        .collect();
    cards.sort();
    cards.into_iter().find_map(|p| {
        std::fs::read_to_string(p.join(rel))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
    })
}

/// "32K" / "1024K" / "8192K" / "4M" → KB.
#[cfg(target_os = "linux")]
fn parse_size_kb(s: &str) -> Option<u64> {
    let t = s.trim();
    let (digits, unit) = t.split_at(t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len()));
    let n: u64 = digits.parse().ok()?;
    Some(match unit.trim().to_ascii_uppercase().as_str() {
        "M" | "MB" | "MIB" => n * 1024,
        "G" | "GB" | "GIB" => n * 1024 * 1024,
        _ => n, // K/KB/빈 값 — /sys는 KB 단위로 준다
    })
}

// ─────────────────────────── macOS: sysctl + system_profiler ───────────────────────────

#[cfg(target_os = "macos")]
async fn fill_macos(info: &mut SystemInfo, notes: &mut Vec<String>) {
    // `-n`을 쓰지 않는다 — 없는 키(Apple Silicon의 hw.cpufrequency 등)가 줄 순서를 어긋나게 한다.
    // "key: value" 형태로 받아 키로 찾으면 누락에 영향받지 않는다.
    let keys = [
        "machdep.cpu.brand_string",
        "machdep.cpu.vendor",
        "hw.physicalcpu",
        "hw.logicalcpu",
        "hw.l1icachesize",
        "hw.l1dcachesize",
        "hw.l2cachesize",
        "hw.l3cachesize",
        "hw.cpufrequency",
        "hw.cpufrequency_max",
        "hw.model",
        "kern.osversion",
    ];
    match run_capture("sysctl", &keys, 10).await {
        Ok(out) => {
            let get = |k: &str| -> Option<String> {
                out.lines()
                    .find_map(|l| l.strip_prefix(&format!("{k}: ")))
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            };
            let get_u64 = |k: &str| get(k).and_then(|v| v.parse::<u64>().ok());

            if let Some(v) = get("machdep.cpu.brand_string") {
                info.cpu.brand = v;
            }
            if let Some(v) = get("machdep.cpu.vendor") {
                info.cpu.vendor = v;
            }
            if let Some(v) = get_u64("hw.physicalcpu") {
                info.cpu.physical_cores = Some(v as u32);
            }
            if let Some(v) = get_u64("hw.logicalcpu") {
                info.cpu.logical_cores = v as u32;
            }
            // sysctl 캐시 값은 바이트 — 계약은 KB다.
            let l1 = get_u64("hw.l1icachesize").unwrap_or(0) + get_u64("hw.l1dcachesize").unwrap_or(0);
            if l1 > 0 {
                info.cpu.cache_l1_kb = Some(l1 / 1024);
            }
            info.cpu.cache_l2_kb = get_u64("hw.l2cachesize").map(|b| b / 1024).filter(|v| *v > 0);
            info.cpu.cache_l3_kb = get_u64("hw.l3cachesize").map(|b| b / 1024).filter(|v| *v > 0);
            // Hz → MHz. Apple Silicon엔 없는 키라 그냥 비워 둔다.
            info.cpu.base_mhz = get_u64("hw.cpufrequency").map(|hz| hz / 1_000_000).filter(|v| *v > 0);
            info.cpu.max_mhz = get_u64("hw.cpufrequency_max")
                .map(|hz| hz / 1_000_000)
                .filter(|v| *v > 0);
            if let Some(v) = get("kern.osversion") {
                info.os.build = v;
            }
            if let Some(model) = get("hw.model") {
                info.board = Some(BoardInfo {
                    manufacturer: "Apple Inc.".to_string(),
                    product: model,
                    ..Default::default()
                });
            }
        }
        Err(e) => notes.push(format!("sysctl: {e}")),
    }

    // GPU·메모리 모듈 — 느리므로 한 번에 두 datatype을 받는다(§3.1).
    match run_capture(
        "system_profiler",
        &["SPDisplaysDataType", "SPMemoryDataType", "-json"],
        20,
    )
    .await
    {
        Ok(out) => match serde_json::from_str::<serde_json::Value>(&out) {
            Ok(v) => apply_system_profiler(info, &v),
            Err(e) => notes.push(crate::i18n::text_system::sysinfo_json_parse_failed("system_profiler", e)),
        },
        Err(e) => notes.push(format!("system_profiler: {e}")),
    }
}

/// `system_profiler -json` 결과에서 GPU·메모리 모듈만 골라 담는다. 키가 macOS 버전마다
/// 오락가락해 Value로 느슨하게 훑는다(없으면 그 항목만 비운다).
#[cfg(target_os = "macos")]
fn apply_system_profiler(info: &mut SystemInfo, v: &serde_json::Value) {
    if let Some(items) = v.get("SPDisplaysDataType").and_then(|d| d.as_array()) {
        for it in items {
            let name = it
                .get("sppci_model")
                .or_else(|| it.get("_name"))
                .and_then(|n| n.as_str())
                .unwrap_or_default()
                .to_string();
            if name.is_empty() {
                continue;
            }
            let vram = it
                .get("spdisplays_vram")
                .or_else(|| it.get("spdisplays_vram_shared"))
                .and_then(|n| n.as_str())
                .and_then(parse_size_bytes);
            info.gpus.push(GpuInfo {
                name,
                driver_version: None,
                driver_date: None,
                vram_bytes: vram,
                // sppci_bus == "spdisplays_pcie_device"면 외장, 내장은 "spdisplays_builtin".
                is_discrete: it
                    .get("sppci_bus")
                    .and_then(|n| n.as_str())
                    .map(|b| b.contains("pcie")),
            });
        }
    }

    if let Some(items) = v.get("SPMemoryDataType").and_then(|d| d.as_array()) {
        // Intel Mac은 "_items"에 뱅크별 목록이, Apple Silicon은 단일 항목(슬롯 없음)이 온다.
        let banks: Vec<&serde_json::Value> = items
            .iter()
            .flat_map(|it| {
                it.get("_items")
                    .and_then(|x| x.as_array())
                    .map(|a| a.iter().collect::<Vec<_>>())
                    .unwrap_or_default()
            })
            .collect();
        for b in banks {
            let s = |k: &str| b.get(k).and_then(|n| n.as_str()).map(|v| v.to_string());
            let Some(capacity_bytes) = s("dimm_size").as_deref().and_then(parse_size_bytes) else {
                continue;
            };
            info.memory.modules.push(MemoryModule {
                slot: s("_name")
                    .unwrap_or_else(|| crate::i18n::text_system::sysinfo_memory_module_slot_fallback().to_string()),
                capacity_bytes,
                speed_mhz: s("dimm_speed")
                    .and_then(|v| v.split_whitespace().next().and_then(|n| n.parse().ok())),
                manufacturer: s("dimm_manufacturer"),
                part_number: s("dimm_part_number"),
            });
        }
    }
}

/// "8 GB" / "1536 MB" → 바이트.
#[cfg(target_os = "macos")]
fn parse_size_bytes(s: &str) -> Option<u64> {
    let mut it = s.split_whitespace();
    let n: f64 = it.next()?.parse().ok()?;
    let mult = match it.next().unwrap_or("MB").to_ascii_uppercase().as_str() {
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    let bytes = n * mult;
    (bytes > 0.0).then_some(bytes as u64)
}

// ─────────────────────────── 테스트 ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 이 머신(2026-09-03)의 실제 스크립트 출력 — 값을 그대로 옮겼다. 두 번째 메모리 모듈만
    /// 숫자를 문자열로 바꿔 `Num`의 양쪽 수용을 함께 본다.
    const SAMPLE: &str = r#"{
      "errors": {},
      "os": {"Caption":"Microsoft Windows 11 Pro","Version":"10.0.26200","BuildNumber":"26200","OSArchitecture":"64비트","InstallDate":"2025-06-02T09:54:42.0000000+09:00"},
      "cpu": [{"Name":"Intel(R) Core(TM) Ultra 9 275HX","Manufacturer":"GenuineIntel","MaxClockSpeed":2700,"NumberOfCores":24,"NumberOfLogicalProcessors":24,"L2CacheSize":40960,"L3CacheSize":36864}],
      "cache": [{"Level":3,"InstalledSize":384},{"Level":3,"InstalledSize":512},{"Level":4,"InstalledSize":24576},{"Level":5,"InstalledSize":36864},{"Level":3,"InstalledSize":512},{"Level":3,"InstalledSize":1024},{"Level":4,"InstalledSize":16384},{"Level":5,"InstalledSize":36864}],
      "memory": [
        {"Capacity":34359738368,"Speed":5600,"Manufacturer":"SK Hynix","PartNumber":"HMCG88AGBSA095N     ","DeviceLocator":"Controller0-ChannelA-DIMM1"},
        {"Capacity":"34359738368","Speed":"5600","Manufacturer":"SK Hynix","PartNumber":null,"DeviceLocator":"Controller0-ChannelB-DIMM1"}
      ],
      "gpu": [
        {"Desc":"Intel(R) Graphics","DriverVersion":"32.0.101.8424","DriverDate":"2026-01-06","Provider":"Intel Corporation","Qw":null,"Mem":2147479552},
        {"Desc":"NVIDIA GeForce RTX 5070 Ti Laptop GPU","DriverVersion":"32.0.15.9613","DriverDate":"2026-04-08","Provider":"NVIDIA","Qw":12820938752,"Mem":4293918720},
        {"Desc":"DisplayLink USB Device","DriverVersion":"11.5.6380.0","DriverDate":"2024-12-18","Provider":"DisplayLink","Qw":null,"Mem":null},
        {"Desc":"DisplayLink USB Device","DriverVersion":"11.5.6380.0","DriverDate":"2024-12-18","Provider":"DisplayLink","Qw":null,"Mem":null}
      ],
      "board": {"Manufacturer":"ASUSTeK COMPUTER INC.","Product":"G815LR"},
      "bios": {"Manufacturer":"American Megatrends International, LLC.","SMBIOSBIOSVersion":"G815LR.331","ReleaseDate":"2025-11-19T09:00:00.0000000+09:00"}
    }"#;

    #[test]
    fn cim_sample_fills_system_info() {
        let cim: CimRoot = serde_json::from_str(SAMPLE).expect("샘플 JSON 파싱");
        let mut info = SystemInfo::default();
        let mut notes = Vec::new();
        apply_cim(&mut info, &cim, &mut notes);

        assert_eq!(info.os.name, "Microsoft Windows 11 Pro");
        assert_eq!(info.os.build, "26200");
        assert_eq!(info.os.arch, "64비트"); // UTF-8 고정이 아니면 여기가 깨진다
        assert_eq!(info.os.install_date.as_deref(), Some("2025-06-02"));

        assert_eq!(info.cpu.brand, "Intel(R) Core(TM) Ultra 9 275HX");
        assert_eq!(info.cpu.physical_cores, Some(24));
        assert_eq!(info.cpu.logical_cores, 24);
        assert_eq!(info.cpu.base_mhz, Some(2700));
        // L1(Level 3)·L2(Level 4)는 Win32_CacheMemory 합이 맞다. L3는 이 하이브리드 CPU가 코어
        // 클러스터마다 **공유** L3를 한 번씩 보고해 Level 5 합이 실제(36MB)의 2배(73728)가 되므로
        // Win32_Processor.L3CacheSize 쪽을 쓴다(31 §8.6).
        assert_eq!(info.cpu.cache_l1_kb, Some(2432));
        assert_eq!(info.cpu.cache_l2_kb, Some(40960));
        assert_eq!(info.cpu.cache_l3_kb, Some(36864));

        // 숫자가 문자열로 와도(두 번째 모듈) 같게 해석되어야 한다.
        assert_eq!(info.memory.modules.len(), 2);
        assert_eq!(info.memory.modules[0].slot, "Controller0-ChannelA-DIMM1");
        // CIM은 부품번호를 공백으로 채워 준다 — 잘라서 담는다.
        assert_eq!(
            info.memory.modules[0].part_number.as_deref(),
            Some("HMCG88AGBSA095N")
        );
        assert_eq!(info.memory.modules[1].capacity_bytes, 34_359_738_368);
        assert_eq!(info.memory.modules[1].speed_mhz, Some(5600));
        assert_eq!(info.memory.modules[1].part_number, None);

        assert_eq!(info.gpus.len(), 3); // DisplayLink 2개는 한 줄로

        let board = info.board.expect("board");
        assert_eq!(board.product, "G815LR");
        assert_eq!(board.bios_version, "G815LR.331");
        assert_eq!(board.bios_date, "2025-11-19");
        assert!(notes.is_empty());
    }

    /// 2소켓 서버 — `Win32_Processor`가 소켓마다 하나씩 오고 L3는 **소켓별로 진짜 따로 있다**.
    /// 첫 소켓 값만 쓰면 절반(33792)으로 새므로 합(67584)이어야 한다.
    #[test]
    fn multi_socket_sums_l3_across_processors() {
        let raw = r#"{
          "errors": {},
          "cpu": [
            {"Name":"Intel(R) Xeon(R) Gold 6248R","Manufacturer":"GenuineIntel","MaxClockSpeed":3000,"NumberOfCores":24,"NumberOfLogicalProcessors":48,"L2CacheSize":24576,"L3CacheSize":33792},
            {"Name":"Intel(R) Xeon(R) Gold 6248R","Manufacturer":"GenuineIntel","MaxClockSpeed":3000,"NumberOfCores":24,"NumberOfLogicalProcessors":48,"L2CacheSize":24576,"L3CacheSize":33792}
          ],
          "cache": [
            {"Level":3,"InstalledSize":1536},{"Level":4,"InstalledSize":24576},{"Level":5,"InstalledSize":33792},
            {"Level":3,"InstalledSize":1536},{"Level":4,"InstalledSize":24576},{"Level":5,"InstalledSize":33792}
          ]
        }"#;
        let cim: CimRoot = serde_json::from_str(raw).expect("샘플 JSON 파싱");
        let mut info = SystemInfo::default();
        let mut notes = Vec::new();
        apply_cim(&mut info, &cim, &mut notes);

        // 이름·코어수는 첫 소켓 것을 그대로 쓴다(소켓 간 합산은 하지 않는다).
        assert_eq!(info.cpu.brand, "Intel(R) Xeon(R) Gold 6248R");
        assert_eq!(info.cpu.cache_l1_kb, Some(3072));
        assert_eq!(info.cpu.cache_l2_kb, Some(49152));
        assert_eq!(info.cpu.cache_l3_kb, Some(67584));
    }

    /// `Win32_Processor`가 L3를 안 주는 환경(가상머신 등)은 `Win32_CacheMemory` Level 5 합으로 폴백.
    #[test]
    fn l3_falls_back_to_cache_memory_without_processor_value() {
        let raw = r#"{
          "cpu": [{"Name":"Common KVM processor","NumberOfCores":8}],
          "cache": [{"Level":4,"InstalledSize":4096},{"Level":5,"InstalledSize":16384}]
        }"#;
        let cim: CimRoot = serde_json::from_str(raw).expect("샘플 JSON 파싱");
        let mut info = SystemInfo::default();
        let mut notes = Vec::new();
        apply_cim(&mut info, &cim, &mut notes);

        assert_eq!(info.cpu.cache_l2_kb, Some(4096));
        assert_eq!(info.cpu.cache_l3_kb, Some(16384));
    }

    /// 표시 어댑터 키 파서 — 같은 이름 접기, qwMemorySize 우선, 이름 없는 항목 건너뛰기.
    #[test]
    fn gpu_registry_dedups_and_prefers_qw_memory() {
        let cim: CimRoot = serde_json::from_str(SAMPLE).expect("샘플 JSON 파싱");
        let mut info = SystemInfo::default();
        let mut notes = Vec::new();
        apply_cim(&mut info, &cim, &mut notes);

        let names: Vec<&str> = info.gpus.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Intel(R) Graphics",
                "NVIDIA GeForce RTX 5070 Ti Laptop GPU",
                "DisplayLink USB Device"
            ]
        );
        // qwMemorySize(11.9GiB)가 MemorySize(4GB 캡)를 이긴다.
        assert_eq!(info.gpus[1].vram_bytes, Some(12_820_938_752));
        // qw가 없으면 MemorySize로 폴백(iGPU 공유량).
        assert_eq!(info.gpus[0].vram_bytes, Some(2_147_479_552));
        // 둘 다 없으면 None — 0을 지어내지 않는다.
        assert_eq!(info.gpus[2].vram_bytes, None);
        assert_eq!(info.gpus[1].driver_version.as_deref(), Some("32.0.15.9613"));
        assert_eq!(info.gpus[1].driver_date.as_deref(), Some("2026-04-08"));
        assert_eq!(info.gpus[1].is_discrete, None);
    }

    /// 클래스 하나가 죽어도 나머지는 채워지고, 사유만 notes로 간다(독립 실행 계약).
    #[test]
    fn class_errors_become_notes_without_losing_others() {
        let raw = r#"{
          "errors": {"CIM Win32_PhysicalMemory":"시간이 초과되었습니다.","GPU 레지스트리":"표시 어댑터 항목 없음(접근 거부 가능)"},
          "cpu": [{"Name":"Intel(R) Core(TM) Ultra 9 275HX","NumberOfCores":24}]
        }"#;
        let cim: CimRoot = serde_json::from_str(raw).expect("샘플 JSON 파싱");
        let mut info = SystemInfo::default();
        let mut notes = Vec::new();
        apply_cim(&mut info, &cim, &mut notes);

        assert_eq!(info.cpu.brand, "Intel(R) Core(TM) Ultra 9 275HX");
        assert_eq!(info.cpu.physical_cores, Some(24));
        assert!(info.memory.modules.is_empty());
        assert!(info.gpus.is_empty());
        assert_eq!(
            notes,
            [
                "CIM Win32_PhysicalMemory: 시간이 초과되었습니다.",
                "GPU 레지스트리: 표시 어댑터 항목 없음(접근 거부 가능)",
            ]
        );
    }

    #[test]
    fn cim_tolerates_missing_fields() {
        let cim: CimRoot = serde_json::from_str("{}").expect("빈 객체도 파싱돼야 한다");
        let mut info = SystemInfo::default();
        let mut notes = Vec::new();
        info.cpu.brand = "sysinfo가 채운 값".to_string();
        apply_cim(&mut info, &cim, &mut notes);
        assert_eq!(info.cpu.brand, "sysinfo가 채운 값"); // CIM이 없으면 덮지 않는다
        assert!(info.board.is_none());
        assert!(info.gpus.is_empty());
        assert!(notes.is_empty());
    }

    #[test]
    fn dates_are_normalized() {
        // ConvertTo-Json 기본 형식(PS 5.1) — UTC 밀리초
        assert_eq!(norm_date("/Date(1714521600000)/").as_deref(), Some("2024-05-01"));
        // 스크립트가 강제하는 ISO 8601
        assert_eq!(
            norm_date("2024-05-01T09:12:33.0000000+09:00").as_deref(),
            Some("2024-05-01")
        );
        // DMI가 주는 미국식 날짜는 우리 형식이 아니다 — 지어내지 않고 None
        assert_eq!(norm_date("08/13/2024"), None);
        assert_eq!(norm_date(""), None);
        assert_eq!(norm_date("   "), None);
        assert_eq!(norm_date("Unknown"), None);
    }
}
