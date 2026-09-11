//! 터미널 셸 고르기 — 후보를 순서대로 **사전 검사 → 시간 제한 spawn** 하고, 막히면 다음 후보로 내려간다.
//!
//! 2026-09 사건: Microsoft Store PowerShell이 7.6.5.0 → 7.6.6.0 으로 자동 업데이트됐는데 앱 실행 별칭
//! (`%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`)은 옛 버전 폴더를 계속 가리켰다. 그 별칭을 실행하면
//! CreateProcessW가 **20~80초 블록된 뒤** os error 1920으로 실패하고, 스스로 낫지 않는다. 예전 코드는
//! `where pwsh`가 성공하니(별칭 파일은 있다) pwsh를 골랐고, 앱을 재시작하면 모든 터미널이 1분 넘게 빈 화면이었다.
//! 그래서 (1) 별칭이 가리키는 패키지가 실제로 등록돼 있는지 프로세스 없이 먼저 보고, (2) 그래도 막히면
//! `SPAWN_TIMEOUT`에서 끊고 다음 후보로 가며, (3) 왜 내려갔는지를 터미널 안에 한 줄로 알린다.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::error::{ErrorCode, IpcError};

/// 셸 하나가 떠야 하는 시간. 정상 spawn은 수십~수백 ms다 — 넘기면 고장으로 보고 다음 후보로 간다.
const SPAWN_TIMEOUT: Duration = Duration::from_secs(10);

/// 실패 기록 수명 — 일시 장애가 풀리면 다시 시도하게 한다.
const FAILURE_TTL: Duration = Duration::from_secs(10 * 60);

/// 폴백 안내 한 줄의 최대 길이(문자 수).
const NOTICE_MAX: usize = 240;

/// 앱 실행 별칭의 재분석 태그.
const IO_REPARSE_TAG_APPEXECLINK: u32 = 0x8000_001B;

type Pty = (Box<dyn MasterPty + Send>, Box<dyn Child + Send + Sync>);

/// 띄운 셸 — `term_open`이 세션으로 감싼다.
pub(super) struct Opened {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) child: Box<dyn Child + Send + Sync>,
    /// 실제로 띄운 프로그램(경로).
    pub(super) program: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    /// 설정의 사용자 지정 셸·유닉스 셸 — 안내 인자를 붙이지 않는다.
    Plain,
    Pwsh,
    WinPs,
    Cmd,
}

#[derive(Debug)]
struct Candidate {
    program: String,
    args: Vec<String>,
    kind: Kind,
}

impl Candidate {
    fn new(program: impl AsRef<Path>, args: &[&str], kind: Kind) -> Self {
        Self {
            program: program.as_ref().to_string_lossy().into_owned(),
            args: args.iter().map(|a| a.to_string()).collect(),
            kind,
        }
    }

    /// 안내 문구에 쓰는 이름.
    fn label(&self) -> String {
        let path = Path::new(&self.program);
        let name = path
            .file_name()
            .map_or_else(|| self.program.clone(), |n| n.to_string_lossy().into_owned());
        match self.kind {
            Kind::WinPs => "Windows PowerShell 5.1".to_string(),
            // pwsh는 설치가 여럿일 수 있다(Store 별칭·MSI·scoop…). 파일명만 쓰면 Store 별칭이 깨져 MSI로 내려간
            // 경우 "pwsh.exe 를 열 수 없어 pwsh.exe 로 대신 열었습니다"가 된다 — 어느 것인지 붙인다.
            // 괄호가 아니라 대괄호: cmd 안내(`notice_args`)가 `( )`를 메타문자로 지우기 때문이다.
            Kind::Pwsh => match path.parent().filter(|d| !d.as_os_str().is_empty()) {
                Some(d) if d.to_string_lossy().to_lowercase().ends_with(r"\microsoft\windowsapps") => {
                    format!("{name} [Microsoft Store]")
                }
                Some(d) => format!("{name} [{}]", d.display()),
                None => name,
            },
            Kind::Cmd | Kind::Plain => name,
        }
    }
}

/// 셸을 띄운다 — 후보를 순서대로 사전 검사·시도해 처음 뜬 것을 돌려준다.
pub(super) fn open(configured: Option<&str>, cwd: &Path, size: PtySize) -> Result<Opened, IpcError> {
    open_first(&candidates(configured), cwd, size, &FAILURES)
}

fn candidates(configured: Option<&str>) -> Vec<Candidate> {
    let env = |k: &str| std::env::var_os(k);
    // #[cfg] 대신 cfg! — 두 조립 함수가 모든 플랫폼에서 컴파일·사용돼 한쪽 빌드에서만 드러나는
    // 깨짐·dead_code 경고가 없다(CI는 cargo test 없이 릴리스 빌드만 3플랫폼으로 돈다).
    if cfg!(windows) {
        windows_candidates(configured, &env, &is_file_entry, &list_dir)
    } else {
        unix_candidates(configured, env("SHELL"), &is_file_entry)
    }
}

/// Windows 후보 — 순수 함수(환경변수·파일 존재·디렉터리 나열을 전부 인자로 받는다).
/// 설정 셸 → PATH의 pwsh 전부 → MSI pwsh → Windows PowerShell 5.1 → cmd.
///
/// 패키지 설치 폴더(`C:\Program Files\WindowsApps\<full name>\pwsh.exe`)를 직접 실행하는 후보는
/// **넣지 않는다** — icacls상 Users:(RX)가 보여도 40초 넘게 블록된 뒤 액세스 거부로 끝난다(실측).
fn windows_candidates(
    configured: Option<&str>,
    env: &dyn Fn(&str) -> Option<OsString>,
    exists: &dyn Fn(&Path) -> bool,
    list_dir: &dyn Fn(&Path) -> Vec<String>,
) -> Vec<Candidate> {
    // 빈 항목·상대 경로 항목은 버린다 — 앱 CWD(사용자 레포일 수 있다)의 동명 파일을 셸로 띄우지 않게.
    // 펼쳐지지 않은 `%USERPROFILE%\...` 항목도 여기서 걸러진다(실제로 PATH에 그런 항목이 있는 머신이 있다).
    let dirs: Vec<PathBuf> = env("PATH")
        .map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect())
        .unwrap_or_default();
    let mut out = Vec::new();
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        // 맨 이름은 PATH(+PATHEXT)로 절대경로를 만든다 — 사전 검사(별칭 판정)가 파일을 봐야 해서다.
        // 절대경로도 확장자를 채운다: `C:\...\Git\bin\bash`처럼 .exe 없이 적은 값을 예전(portable-pty)엔 띄웠다.
        // 구분자가 든 상대경로는 그대로 둔다(앱 CWD 기준으로 찾지 않는다). 못 찾으면 그대로 둔다:
        // portable-pty가 레지스트리 PATH로 다시 찾는다.
        let exts = env("PATHEXT")
            .and_then(|e| e.into_string().ok())
            .unwrap_or_else(|| ".EXE".to_string());
        let with_ext = |base: &Path| {
            std::iter::once("")
                .chain(exts.split(';').filter(|e| !e.is_empty()))
                .map(|ext| {
                    let mut p = base.as_os_str().to_owned();
                    p.push(ext);
                    PathBuf::from(p)
                })
                .find(|p| exists(p))
        };
        let found = if Path::new(c).is_absolute() {
            with_ext(Path::new(c))
        } else if c.contains(['\\', '/']) {
            None
        } else {
            dirs.iter().find_map(|d| with_ext(&d.join(c)))
        };
        out.push(Candidate::new(found.unwrap_or_else(|| PathBuf::from(c)), &[], Kind::Plain));
    }
    // PATH의 pwsh는 첫 적중만이 아니라 **전부** 본다 — 앞의 것이 깨진 별칭이어도 뒤에 멀쩡한 설치본이 있을 수 있다.
    for d in &dirs {
        let p = d.join("pwsh.exe");
        if exists(&p) {
            out.push(Candidate::new(p, &["-NoLogo"], Kind::Pwsh));
        }
    }
    if let Some(pf) = env("ProgramFiles") {
        let root = PathBuf::from(pf).join("PowerShell");
        let mut versions = list_dir(&root);
        // 정식(`7`)을 프리뷰(`7-preview`)보다 먼저.
        versions.sort_by_key(|v| (v.contains('-'), v.clone()));
        for v in versions {
            let p = root.join(v).join("pwsh.exe");
            if exists(&p) {
                out.push(Candidate::new(p, &["-NoLogo"], Kind::Pwsh));
            }
        }
    }
    let system_root = env("SystemRoot").map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
    out.push(Candidate::new(
        system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
        &["-NoLogo"],
        Kind::WinPs,
    ));
    let cmd = env("ComSpec")
        .map(PathBuf::from)
        .filter(|p| exists(p))
        .unwrap_or_else(|| system_root.join(r"System32\cmd.exe"));
    out.push(Candidate::new(cmd, &[], Kind::Cmd));
    dedup(out)
}

/// 유닉스 후보 — [설정, $SHELL, /bin/bash, /bin/sh]. 인자는 예전처럼 없다(안내 인자도 붙이지 않는다).
/// 설정값은 존재 검사 없이 그대로 둔다: 맨 이름이면 portable-pty가 PATH에서 찾는다(예전 동작 그대로).
fn unix_candidates(
    configured: Option<&str>,
    shell: Option<OsString>,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<Candidate> {
    let configured = configured
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|c| Candidate::new(c, &[], Kind::Plain));
    let auto = shell
        .and_then(|s| s.into_string().ok())
        .into_iter()
        .chain(["/bin/bash".to_string(), "/bin/sh".to_string()])
        .filter(|p| exists(Path::new(p)))
        .map(|p| Candidate::new(p, &[], Kind::Plain));
    dedup(configured.into_iter().chain(auto).collect())
}

/// 전체 경로 기준 대소문자 무시 중복 제거 — 앞의 것이 남는다(설정 셸이 자동 후보보다 우선).
fn dedup(cands: Vec<Candidate>) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    cands
        .into_iter()
        .filter(|c| seen.insert(c.program.to_lowercase()))
        .collect()
}

/// 파일로 존재하는가 — 재분석 지점(별칭·심볼릭 링크)은 따라가지 않고 그 자체를 본다.
fn is_file_entry(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| !m.is_dir())
}

fn list_dir(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 후보를 순서대로 시도한다. 앞선 후보가 하나라도 빠졌으면 뜬 셸에게 안내 한 줄을 찍게 한다.
fn open_first(
    cands: &[Candidate],
    cwd: &Path,
    size: PtySize,
    cache: &'static FailureCache,
) -> Result<Opened, IpcError> {
    let mut failed: Vec<(&Candidate, String)> = Vec::new();
    for (i, cand) in cands.iter().enumerate() {
        let notice = (!failed.is_empty()).then(|| fallback_notice(&failed, cand));
        // 마지막 후보는 실패 기록으로 건너뛰지 않는다 — 일시 장애 한 번에 모든 후보가 기록되면
        // FAILURE_TTL 동안 터미널이 아예 안 열린다. 최소 한 번은 실제로 띄워 본다.
        let use_cache = (i + 1 < cands.len()).then_some(cache);
        let result = precheck(&cand.program, use_cache, Instant::now()).and_then(|()| {
            let mut args = cand.args.clone();
            if let Some(msg) = &notice {
                args.extend(notice_args(cand.kind, msg));
            }
            let (program, cwd) = (cand.program.clone(), cwd.to_path_buf());
            attempt(&cand.program, SPAWN_TIMEOUT, cache, move |spawning| {
                spawn_in_pty(&program, &args, &cwd, size, spawning)
            })
        });
        match result {
            Ok((master, child)) => {
                if let Some(msg) = notice {
                    log::info!("셸 폴백: {} — {msg}", cand.program);
                }
                return Ok(Opened {
                    master,
                    child,
                    program: cand.program.clone(),
                });
            }
            Err(why) => {
                log::warn!("셸 후보 제외 {}: {why}", cand.program);
                failed.push((cand, why));
            }
        }
    }
    let detail: Vec<String> = failed
        .iter()
        .map(|(c, why)| format!("{}: {why}", c.program))
        .collect();
    Err(IpcError::new(
        ErrorCode::Io,
        format!("셸 실행 실패: {}", detail.join("; ")),
    ))
}

/// 사전 검사 — 프로세스를 띄우지 않고 즉시 판정한다. `Err(사유)`면 이 후보는 건너뛴다.
/// `cache`가 None이면 실패 기록을 보지 않는다(마지막 후보 — `open_first` 참고).
fn precheck(program: &str, cache: Option<&FailureCache>, now: Instant) -> Result<(), String> {
    let path = Path::new(program);
    // 절대경로가 아닌 것은 PATH에서 못 찾은 설정값뿐이다 — portable-pty가 다시 찾으므로 그대로 시도한다.
    if path.is_absolute() {
        if !is_file_entry(path) {
            return Err("파일 없음".to_string());
        }
        if let Some(why) = alias_problem(path) {
            return Err(why);
        }
    }
    match cache.and_then(|c| c.hit(&program.to_lowercase(), &fingerprint(path), now)) {
        Some(why) => Err(format!("{why} (최근 실패)")),
        None => Ok(()),
    }
}

#[derive(Debug, PartialEq)]
enum AliasVerdict {
    Ok,
    /// 이 사용자에게 그 패밀리의 패키지가 하나도 등록돼 있지 않다.
    NotInstalled,
    /// 등록되지 않은 버전의 설치 폴더를 가리킨다 — Store 자동 업데이트 뒤 별칭이 따라오지 못한 경우.
    /// 옛 버전 폴더가 디스크에 남아 있어 "대상 파일이 있나"로는 가려지지 않는다.
    Stale { points_to: String },
}

/// 앱 실행 별칭이 **지금 실행될 수 없는** 패키지를 가리키면 그 사유.
/// 별칭이 아니거나 판단할 수 없으면 None — 시도한다(시간 제한이 안전망이다).
fn alias_problem(path: &Path) -> Option<String> {
    let (pfn, target) = parse_appexeclink(&read_reparse_data(path)?)?;
    match judge_alias(&pfn, &target, &registered_packages(&pfn)?) {
        AliasVerdict::Ok => None,
        AliasVerdict::NotInstalled => Some(format!("앱 실행 별칭의 패키지({pfn})가 설치돼 있지 않음")),
        AliasVerdict::Stale { points_to } => {
            Some(format!("앱 실행 별칭이 설치되지 않은 버전({points_to})을 가리킴"))
        }
    }
}

/// APPEXECLINK 재분석 버퍼에서 (패키지 패밀리명, 대상 exe)를 꺼낸다.
///
/// REPARSE_DATA_BUFFER = `u32 태그, u16 데이터 길이, u16 예약` + 데이터. 데이터는 `u32 버전(=3)` 뒤에
/// NUL 종료 UTF-16LE 문자열 4개(패밀리명, AUMID, 대상 exe, 앱 타입)다. 문서화된 형식이 아니라 fsutil
/// 덤프로 확인한 레이아웃이고(테스트가 실측 길이 0x148로 고정한다), 조금이라도 어긋나면 None(= 판단 불가).
fn parse_appexeclink(buf: &[u8]) -> Option<(String, String)> {
    let u32_at = |b: &[u8], i: usize| {
        b.get(i..i + 4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    };
    if u32_at(buf, 0)? != IO_REPARSE_TAG_APPEXECLINK {
        return None;
    }
    let len = u16::from_le_bytes([*buf.get(4)?, *buf.get(5)?]) as usize;
    let data = buf.get(8..8 + len)?;
    if u32_at(data, 0)? != 3 {
        return None;
    }
    let body = &data[4..];
    if body.len() % 2 != 0 {
        return None;
    }
    let wide: Vec<u16> = body
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    // 마지막 문자열까지 NUL로 끝나야 하고, 문자열이 4개 이상이어야 한다.
    let (&last, strings) = wide.split_last()?;
    if last != 0 {
        return None;
    }
    let parts: Vec<&[u16]> = strings.split(|&c| c == 0).collect();
    if parts.len() < 4 {
        return None;
    }
    let pfn = String::from_utf16(parts[0]).ok()?;
    let target = String::from_utf16(parts[2]).ok()?;
    (!pfn.is_empty() && !target.is_empty()).then_some((pfn, target))
}

/// 별칭 판정 — 순수 함수. `registered`는 이 사용자에게 등록된 그 패밀리의 full name 목록.
fn judge_alias(pfn: &str, target: &str, registered: &[String]) -> AliasVerdict {
    if registered.is_empty() {
        return AliasVerdict::NotInstalled;
    }
    let comps: Vec<&str> = target.split(['\\', '/']).collect();
    if comps
        .iter()
        .any(|c| registered.iter().any(|r| r.eq_ignore_ascii_case(c)))
    {
        return AliasVerdict::Ok;
    }
    // full name = `{Name}_{Version}_{Arch}_{ResourceId}_{PublisherId}`, 패밀리명 = `{Name}_{PublisherId}`.
    let Some((name, publisher)) = pfn.rsplit_once('_') else {
        return AliasVerdict::Ok;
    };
    let (head, tail) = (format!("{name}_"), format!("_{publisher}"));
    // 길이 조건이 없으면 패밀리명 폴더 자체(`SystemApps\{PFN}\`)도 head로 시작하고 tail로 끝나 Stale로 오판한다.
    let stale = comps.iter().find(|c| {
        let b = c.as_bytes();
        b.len() >= head.len() + tail.len()
            && b[..head.len()].eq_ignore_ascii_case(head.as_bytes())
            && b[b.len() - tail.len()..].eq_ignore_ascii_case(tail.as_bytes())
    });
    match stale {
        Some(c) => AliasVerdict::Stale {
            points_to: c.to_string(),
        },
        // SystemApps 등 판단 불가 — 시도한다.
        None => AliasVerdict::Ok,
    }
}

/// 지문 = 수정 시각 + 크기. 별칭이 다시 만들어지면(Store가 고치거나 재설치) 바뀌어 즉시 재시도된다.
type Fingerprint = Option<(Option<SystemTime>, u64)>;

fn fingerprint(path: &Path) -> Fingerprint {
    std::fs::symlink_metadata(path)
        .ok()
        .map(|m| (m.modified().ok(), m.len()))
}

/// 최근 실패 기록(후보 경로 소문자 → 기록) — 고장 난 셸을 터미널을 열 때마다 다시 기다리지 않게 한다.
#[derive(Default)]
struct FailureCache(Mutex<HashMap<String, Failure>>);

struct Failure {
    fingerprint: Fingerprint,
    at: Instant,
    reason: String,
}

static FAILURES: LazyLock<FailureCache> = LazyLock::new(FailureCache::default);

impl FailureCache {
    /// 유효한 실패 기록의 사유. 지문이 바뀌었거나 `FAILURE_TTL`이 지났으면 None.
    fn hit(&self, key: &str, fingerprint: &Fingerprint, now: Instant) -> Option<String> {
        let map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let f = map.get(key)?;
        (f.fingerprint == *fingerprint && now.duration_since(f.at) < FAILURE_TTL)
            .then(|| f.reason.clone())
    }

    fn record(&self, key: &str, fingerprint: Fingerprint, reason: &str, now: Instant) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(
            key.to_string(),
            Failure {
                fingerprint,
                at: now,
                reason: reason.to_string(),
            },
        );
    }

    fn clear(&self, key: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }
}

/// 후보 하나를 시간 제한 안에 띄운다. `work`(워커에서 도는 openpty+spawn)는 openpty를 통과하면 받은 표시를 켠다.
///
/// 실패 기록에는 **셸 실행 단계에서 막혀 시간 초과한 것만** 남긴다 — 기록이 아끼는 건 그 기다림뿐이다.
/// 빠른 실패는 다시 해도 싸고 후보 탓이 아닐 수 있다(PTY 생성 실패, 260자 넘는 프로젝트 cwd의 os error 267).
/// 그걸 셸 경로에 기록하면 멀쩡한 pwsh를 FAILURE_TTL 동안 모든 프로젝트에서 건너뛴다. openpty에서 막힌
/// 시간 초과도 같은 이유로 기록하지 않는다.
fn attempt(
    program: &str,
    timeout: Duration,
    cache: &'static FailureCache,
    work: impl FnOnce(&AtomicBool) -> Result<Pty, String> + Send + 'static,
) -> Result<Pty, String> {
    let key = program.to_lowercase();
    let late_ok = Arc::new(AtomicBool::new(false));
    let spawning = Arc::new(AtomicBool::new(false));
    let work = {
        let spawning = Arc::clone(&spawning);
        move || work(&spawning)
    };
    let late = {
        let (key, late_ok, program) = (key.clone(), Arc::clone(&late_ok), program.to_string());
        move |r: Result<Pty, String>| {
            // 느렸을 뿐 고장은 아니다 — 아무도 안 쓰는 셸은 거두고, 실패 기록을 지워 다음엔 다시 시도한다.
            if let Ok((master, mut child)) = r {
                log::warn!("셸이 시간 초과 뒤에 떴다 — 종료하고 다음부터 다시 시도한다: {program}");
                let _ = child.kill();
                let _ = child.wait();
                drop(master);
                late_ok.store(true, Ordering::SeqCst);
                cache.clear(&key);
            }
        }
    };
    let why = match with_timeout(timeout, work, late) {
        Some(Ok(pty)) => return Ok(pty),
        Some(Err(e)) => return Err(short_reason(&e)),
        None => format!("{}초 안에 시작되지 않음", timeout.as_secs()),
    };
    if spawning.load(Ordering::SeqCst) {
        cache.record(&key, fingerprint(Path::new(program)), &why, Instant::now());
        // 늦은 성공의 clear가 위 record보다 먼저 돌았을 수 있다 — 그러면 방금 쓴 기록을 여기서 되돌린다.
        if late_ok.load(Ordering::SeqCst) {
            cache.clear(&key);
        }
    }
    Err(why)
}

/// 새 PTY 쌍을 열어 셸 하나를 띄운다(워커 스레드에서 돈다).
///
/// 후보마다 **새 쌍**을 여는 이유: CreateProcessW가 블록되면 portable-pty 슬레이브 내부 뮤텍스가
/// 잡힌 채라 같은 쌍으로는 다음 후보를 띄울 수 없다. 정상 경로는 1회라 비용은 예전과 같다.
/// openpty를 통과하면 `spawning`을 켠다 — 시간 초과가 셸 탓인지 PTY 탓인지 `attempt`가 가른다.
fn spawn_in_pty(
    program: &str,
    args: &[String],
    cwd: &Path,
    size: PtySize,
    spawning: &AtomicBool,
) -> Result<Pty, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("PTY 생성 실패: {e:#}"))?;
    spawning.store(true, Ordering::SeqCst);
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(cwd);
    // 터미널 에뮬레이터는 PTY 셸의 TERM 을 직접 지정해야 한다(모든 터미널이 그렇게 한다).
    // 지정하지 않으면 앱을 GNOME 메뉴/systemd 로 띄울 때 그 환경에 TERM 이 없어
    // (터미널에서 띄울 때만 TERM=xterm-256color 를 물려받음) 셸이 빈 TERM 으로 떠서,
    // zsh-syntax-highlighting·zsh-autosuggestions 가 terminfo 능력을 잘못 판정해
    // 어긋난 커서 이동·clear escape 를 보내 입력줄이 깨진다(고스트 잔상·한글 커서 드리프트).
    // → 같은 바이너리도 "dev/터미널 실행은 정상, 메뉴 설치본은 깨짐"의 진짜 원인.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("{e:#}"))?;
    // 슬레이브를 닫아 자식 종료 시 리더가 EOF를 받도록 한다.
    drop(pair.slave);
    Ok((pair.master, child))
}

/// `work`를 워커 스레드에서 돌리고 최대 `timeout` 기다린다. 시간 안에 끝나면 Some(결과),
/// 아니면 None — 늦게 끝난 결과는 워커 스레드에서 `late`가 받는다(반환과 배타적, 정확히 한 번).
///
/// mpsc `recv_timeout`으로 하면 안 된다: Timeout을 받은 직후~수신자 drop 사이에 도착한 값이 아무도
/// 모르게 버려진다. 그 값이 막 뜬 셸이면 portable-pty `Child`의 Drop은 프로세스를 죽이지 않으므로
/// 보이지 않는 셸이 남는다. 그래서 "가져감/포기"를 한 뮤텍스 아래에서 원자적으로 정한다.
fn with_timeout<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> T + Send + 'static,
    late: impl FnOnce(T) + Send + 'static,
) -> Option<T> {
    enum Slot<T> {
        Pending,
        Done(T),
        Abandoned,
    }
    let shared = Arc::new((Mutex::new(Slot::Pending), Condvar::new()));
    let worker = Arc::clone(&shared);
    std::thread::spawn(move || {
        let out = work();
        let (lock, cv) = &*worker;
        let mut slot = lock.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*slot, Slot::Abandoned) {
            drop(slot);
            late(out);
        } else {
            *slot = Slot::Done(out);
            cv.notify_one();
        }
    });
    let (lock, cv) = &*shared;
    let slot = lock.lock().unwrap_or_else(|e| e.into_inner());
    let (mut slot, _) = cv
        .wait_timeout_while(slot, timeout, |s| matches!(s, Slot::Pending))
        .unwrap_or_else(|e| e.into_inner());
    match std::mem::replace(&mut *slot, Slot::Abandoned) {
        Slot::Done(v) => Some(v),
        _ => None,
    }
}

/// portable-pty 에러는 길다(`CreateProcessW `...` in cwd `...` failed: <os 에러>`) — 안내에는 꼬리만.
fn short_reason(e: &str) -> String {
    e.rsplit_once("failed: ")
        .map_or(e, |(_, tail)| tail)
        .trim()
        .to_string()
}

/// 폴백 안내 문구. 같은 이름·사유는 한 번만 쓰고 `NOTICE_MAX`자로 자른다.
fn fallback_notice(failed: &[(&Candidate, String)], chosen: &Candidate) -> String {
    fn uniq(items: impl Iterator<Item = String>) -> Vec<String> {
        let mut v: Vec<String> = Vec::new();
        for s in items {
            if !v.contains(&s) {
                v.push(s);
            }
        }
        v
    }
    let labels = uniq(failed.iter().map(|(c, _)| c.label()));
    let reasons = uniq(failed.iter().map(|(_, r)| r.clone()));
    let msg = format!(
        "[Gitpervisor] {} 를 열 수 없어 {} 로 대신 열었습니다 — {}",
        labels.join(", "),
        chosen.label(),
        reasons.join("; ")
    );
    if msg.chars().count() <= NOTICE_MAX {
        return msg;
    }
    msg.chars().take(NOTICE_MAX - 1).chain(['…']).collect()
}

/// 선택된 셸이 **자기 출력으로** 안내를 찍게 하는 추가 인자.
///
/// 프론트가 xterm에 먼저 쓰면 ConPTY 시작 시퀀스의 `ESC[2J`에 지워지고, PTY 출력 스트림에 끼워 넣으면
/// ConPTY 화면 모델과 어긋나 이후 커서 이동이 깨진다 — 그래서 셸이 찍는다.
/// `-EncodedCommand`는 쓰지 않는다 — 백신이 악성 지표로 본다(AhnLab V3의 설치 차단 전력이 있다).
fn notice_args(kind: Kind, msg: &str) -> Vec<String> {
    match kind {
        Kind::Pwsh | Kind::WinPs => {
            let mut quoted = String::new();
            for c in msg.chars().filter(|c| !c.is_control()) {
                match c {
                    // 작은따옴표 문자열 안의 이스케이프는 두 번 쓰기뿐이다. PowerShell은 ‘ ’ ‚ ‛ 도
                    // 작은따옴표로 친다. `"`는 portable-pty가 `\"`로 넘기는데 powershell.exe의
                    // 명령줄 해석이 그걸 믿을 수 없어 아예 작은따옴표로 바꾼다.
                    '\'' | '"' | '\u{2018}'..='\u{201B}' => quoted.push_str("''"),
                    _ => quoted.push(c),
                }
            }
            vec![
                "-NoExit".to_string(),
                "-Command".to_string(),
                format!("Write-Host '{quoted}' -ForegroundColor Yellow"),
            ]
        }
        // cmd /K는 명령줄의 첫·마지막 따옴표만 벗긴다 — 안에 `"`가 남으면 안 되고, 메타문자는 전부 뺀다.
        Kind::Cmd => {
            let text: String = msg
                .chars()
                .filter(|c| !c.is_control() && !"&|<>()@^%!\"".contains(*c))
                .collect();
            vec!["/K".to_string(), format!("echo {text}")]
        }
        Kind::Plain => Vec::new(),
    }
}

// 함수 두 개 때문에 windows-sys feature(Win32_System_IO·Win32_Storage_Packaging_Appx)를 늘리지 않고
// 직접 선언한다(alloc_guard.rs의 CreateFileW와 같은 방식). 시그니처는 windows-sys 0.59와 같다.
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn DeviceIoControl(
        device: *mut core::ffi::c_void,
        code: u32,
        in_buf: *const core::ffi::c_void,
        in_len: u32,
        out_buf: *mut core::ffi::c_void,
        out_len: u32,
        returned: *mut u32,
        overlapped: *mut core::ffi::c_void,
    ) -> i32;
    fn GetPackagesByPackageFamily(
        family: *const u16,
        count: *mut u32,
        full_names: *mut *mut u16,
        buffer_len: *mut u32,
        buffer: *mut u16,
    ) -> u32;
}

#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

/// 재분석 버퍼를 읽는다(std `read_link`와 같은 방식). 재분석 지점이 아니면 None.
#[cfg(windows)]
fn read_reparse_data(path: &Path) -> Option<Vec<u8>> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    const FSCTL_GET_REPARSE_POINT: u32 = 0x0009_00A8;
    const MAXIMUM_REPARSE_DATA_BUFFER_SIZE: usize = 16 * 1024;

    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut buf = vec![0u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE];
    let mut len = 0u32;
    // SAFETY: 핸들은 file이 쥐고 있고, 출력 버퍼와 그 길이를 그대로 넘긴다.
    let ok = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_GET_REPARSE_POINT,
            std::ptr::null(),
            0,
            buf.as_mut_ptr().cast(),
            buf.len() as u32,
            &mut len,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return None;
    }
    buf.truncate(len as usize);
    Some(buf)
}

/// 이 사용자에게 등록된 그 패밀리의 패키지 full name 목록. 조회 자체가 실패하면 None(= 판단 불가).
#[cfg(windows)]
fn registered_packages(pfn: &str) -> Option<Vec<String>> {
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

    let family: Vec<u16> = pfn.encode_utf16().chain(Some(0)).collect();
    let (mut count, mut len) = (0u32, 0u32);
    // 1회차: 개수·버퍼 길이만 받는다(등록된 게 없으면 ERROR_SUCCESS + 0개).
    // SAFETY: 크기 질의 — 출력 포인터는 null, 개수·길이는 지역 변수.
    let rc = unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            std::ptr::null_mut(),
            &mut len,
            std::ptr::null_mut(),
        )
    };
    match rc {
        ERROR_SUCCESS if count == 0 => return Some(Vec::new()),
        ERROR_INSUFFICIENT_BUFFER => {}
        _ => return None,
    }
    let mut names = vec![std::ptr::null_mut::<u16>(); count as usize];
    let mut buf = vec![0u16; len as usize];
    // SAFETY: 1회차가 알려 준 개수·길이로 잡은 버퍼를 넘긴다. 그 사이 설치가 바뀌면 에러로 돌아온다.
    let rc = unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            names.as_mut_ptr(),
            &mut len,
            buf.as_mut_ptr(),
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    // names의 포인터들은 buf 안을 가리킨다 — 포인터를 따라가는 대신 NUL 구분 버퍼를 직접 쪼갠다.
    Some(
        buf.split(|&c| c == 0)
            .filter(|s| !s.is_empty())
            .take(count as usize)
            .map(String::from_utf16_lossy)
            .collect(),
    )
}

// 재분석 지점·AppX 패키지는 Windows에만 있다 — 다른 OS에서 별칭 판정은 늘 "해당 없음"이다.
#[cfg(not(windows))]
fn read_reparse_data(_: &Path) -> Option<Vec<u8>> {
    None
}
#[cfg(not(windows))]
fn registered_packages(_: &str) -> Option<Vec<String>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PFN: &str = "Microsoft.PowerShell_8wekyb3d8bbwe";
    const AUMID: &str = "Microsoft.PowerShell_8wekyb3d8bbwe!App";
    const TARGET: &str =
        r"C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe\pwsh.exe";

    fn reparse(tag: u32, data: &[u8]) -> Vec<u8> {
        let mut b = tag.to_le_bytes().to_vec();
        b.extend((data.len() as u16).to_le_bytes());
        b.extend([0, 0]);
        b.extend(data);
        b
    }

    fn link_data(version: u32, strings: &[&str]) -> Vec<u8> {
        let mut d = version.to_le_bytes().to_vec();
        for s in strings {
            for u in s.encode_utf16().chain(Some(0)) {
                d.extend(u.to_le_bytes());
            }
        }
        d
    }

    fn programs(c: &[Candidate]) -> Vec<&str> {
        c.iter().map(|c| c.program.as_str()).collect()
    }

    /// §1 실측 레이아웃 — 조립한 데이터 길이가 fsutil 덤프의 0x148과 같아야 파서 검증이 의미가 있다.
    #[test]
    fn parses_measured_appexeclink_layout() {
        let data = link_data(3, &[PFN, AUMID, TARGET, "0"]);
        assert_eq!(data.len(), 0x148, "레이아웃이 실측(0x148)과 다르다");
        let buf = reparse(IO_REPARSE_TAG_APPEXECLINK, &data);
        assert_eq!(
            parse_appexeclink(&buf),
            Some((PFN.to_string(), TARGET.to_string()))
        );

        // 음성 — 전부 "판단 불가"여야 한다.
        let tag = IO_REPARSE_TAG_APPEXECLINK;
        assert_eq!(parse_appexeclink(&reparse(0xA000_000C, &data)), None, "심볼릭 링크 태그");
        assert_eq!(parse_appexeclink(&buf[..buf.len() - 2]), None, "잘림");
        let v2 = link_data(2, &[PFN, AUMID, TARGET, "0"]);
        assert_eq!(parse_appexeclink(&reparse(tag, &v2)), None, "버전");
        assert_eq!(
            parse_appexeclink(&reparse(tag, &data[..data.len() - 2])),
            None,
            "마지막 NUL 누락"
        );
        let merged = format!("{AUMID}{TARGET}");
        let three = link_data(3, &[PFN, &merged, "0"]);
        assert_eq!(parse_appexeclink(&reparse(tag, &three)), None, "가운데 NUL 누락");
        let mut odd = data.clone();
        odd.push(0);
        assert_eq!(parse_appexeclink(&reparse(tag, &odd)), None, "홀수 길이");
    }

    #[test]
    fn judges_alias_against_registered_packages() {
        let reg = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let stale = |p: &str| AliasVerdict::Stale {
            points_to: p.to_string(),
        };
        assert_eq!(
            judge_alias(PFN, TARGET, &reg(&["Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe"])),
            AliasVerdict::Ok
        );
        // 이번 사건: 등록은 7.6.6.0인데 별칭은 7.6.5.0 폴더를 가리킨다(그 폴더는 아직 디스크에 있다).
        assert_eq!(
            judge_alias(PFN, TARGET, &reg(&["Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe"])),
            stale("Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe")
        );
        assert_eq!(judge_alias(PFN, TARGET, &[]), AliasVerdict::NotInstalled);
        // 대소문자 무시 — 등록 쪽·경로 쪽 모두.
        assert_eq!(
            judge_alias(PFN, TARGET, &reg(&["microsoft.powershell_7.6.5.0_X64__8WEKYB3D8BBWE"])),
            AliasVerdict::Ok
        );
        assert_eq!(
            judge_alias(
                PFN,
                &TARGET.to_lowercase(),
                &reg(&["Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe"])
            ),
            stale("microsoft.powershell_7.6.5.0_x64__8wekyb3d8bbwe")
        );
        // SystemApps식: 패밀리명 폴더 자체는 full name이 아니다 → 판단 불가 → 시도(Ok).
        assert_eq!(
            judge_alias(
                "Microsoft.Windows.Search_cw5n1h2txyewy",
                r"C:\Windows\SystemApps\Microsoft.Windows.Search_cw5n1h2txyewy\SearchApp.exe",
                &reg(&["Microsoft.Windows.Search_1.14.9.19041_neutral_neutral_cw5n1h2txyewy"])
            ),
            AliasVerdict::Ok
        );
    }

    /// 후보 조립 — 이 머신이 아니라 주입한 환경으로 순서·중복·인자를 고정한다.
    /// (split_paths·경로 결합이 Windows 의미라 Windows에서만 돈다.)
    #[cfg(windows)]
    #[test]
    fn windows_candidates_order_dedup_and_args() {
        // 대소문자 무시 파일 시스템 흉내 — 소문자로 등록하고 소문자로 조회한다.
        let files = [
            r"c:\a\pwsh.exe",
            r"c:\a\mysh.exe",
            r"relative\dir\pwsh.exe",
            r"c:\program files\q\pwsh.exe",
            r"c:\b\pwsh.exe",
            r"c:\pf\powershell\7\pwsh.exe",
            r"c:\pf\powershell\7-preview\pwsh.exe",
            r"c:\tools\cmd.exe",
        ];
        let exists = |p: &Path| files.contains(&p.to_string_lossy().to_lowercase().as_str());
        let list_dir = |p: &Path| {
            if p == Path::new(r"C:\PF\PowerShell") {
                vec!["7-preview".to_string(), "7".to_string()]
            } else {
                Vec::new()
            }
        };
        let base = [
            // 빈 항목·상대 경로·따옴표 항목·대소문자만 다른 중복(`C:\A\`)이 섞여 있다.
            ("PATH", r#"C:\a;;relative\dir;"C:\Program Files\q";C:\A\;C:\b"#),
            ("PATHEXT", ".COM;.EXE"),
            ("ProgramFiles", r"C:\PF"),
            ("SystemRoot", r"C:\Win"),
            ("ComSpec", r"C:\Tools\cmd.exe"),
        ];
        let run = |configured: Option<&str>, without: &[&str]| {
            let env = |k: &str| {
                base.iter()
                    .find(|(n, _)| *n == k && !without.contains(n))
                    .map(|(_, v)| OsString::from(v))
            };
            windows_candidates(configured, &env, &exists, &list_dir)
        };
        let auto = [
            r"C:\a\pwsh.exe",
            r"C:\Program Files\q\pwsh.exe",
            r"C:\b\pwsh.exe",
            r"C:\PF\PowerShell\7\pwsh.exe",
            r"C:\PF\PowerShell\7-preview\pwsh.exe",
            r"C:\Win\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Tools\cmd.exe",
        ];

        let c = run(None, &[]);
        assert_eq!(programs(&c), auto);
        let kinds: Vec<Kind> = c.iter().map(|c| c.kind).collect();
        use Kind::*;
        assert_eq!(kinds, [Pwsh, Pwsh, Pwsh, Pwsh, Pwsh, WinPs, Cmd]);
        assert!(c[..6].iter().all(|c| c.args == ["-NoLogo"]), "{c:?}");
        assert!(c[6].args.is_empty());
        // 공백뿐인 설정은 없는 것과 같다.
        assert_eq!(programs(&run(Some("  "), &[])), auto);

        // 설정: 맨 이름은 PATH+PATHEXT로 절대경로가 되어 맨 앞, 인자 없음.
        let c = run(Some("mysh"), &[]);
        assert_eq!(c[0].program, r"C:\a\mysh.EXE");
        assert!(c[0].args.is_empty() && c[0].kind == Plain);
        assert_eq!(programs(&c[1..]), auto);
        // 못 찾으면 그대로(portable-pty가 다시 찾는다).
        assert_eq!(run(Some("nothere"), &[])[0].program, "nothere");
        // 절대경로도 .exe 없이 적으면 PATHEXT로 채운다(예전 portable-pty 동작) — 안 채우면 "파일 없음"으로 건너뛴다.
        assert_eq!(run(Some(r"C:\a\mysh"), &[])[0].program, r"C:\a\mysh.EXE");
        assert_eq!(run(Some(r"C:\gone\sh"), &[])[0].program, r"C:\gone\sh");
        // 설정이 자동 후보와 같은 파일이면 설정 쪽(안내 인자 없음)이 남는다.
        let c = run(Some(r"c:\tools\CMD.exe"), &[]);
        assert_eq!(c[0].program, r"c:\tools\CMD.exe");
        assert_eq!(c[0].kind, Plain);
        assert_eq!(programs(&c[1..]), auto[..6]);

        // ComSpec이 없으면 SystemRoot의 cmd, SystemRoot도 없으면 C:\Windows.
        let c = run(None, &["ComSpec"]);
        assert_eq!(c.last().unwrap().program, r"C:\Win\System32\cmd.exe");
        // ComSpec이 없는 파일을 가리키면(낡은 프로필) 그걸 마지막 후보로 두지 않는다 — 두면 "파일 없음"으로
        // 빠져 PowerShell까지 깨진 머신에서 최후 수단 cmd가 사라진다.
        let stale_comspec = |k: &str| match k {
            "ComSpec" => Some(OsString::from(r"C:\Gone\cmd.exe")),
            _ => base.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v)),
        };
        let c = windows_candidates(None, &stale_comspec, &exists, &list_dir);
        assert_eq!(c.last().unwrap().program, r"C:\Win\System32\cmd.exe");
        let c = run(None, &["ComSpec", "SystemRoot", "PATH", "ProgramFiles"]);
        assert_eq!(
            programs(&c),
            [
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                r"C:\Windows\System32\cmd.exe"
            ]
        );
    }

    /// 유닉스는 예전 동작 그대로 — 인자 없음, 설정 우선, 없는 기본 셸은 빠진다.
    #[test]
    fn unix_candidates_keep_old_behavior() {
        let exists = |p: &Path| p == Path::new("/bin/zsh") || p == Path::new("/bin/sh");
        let c = unix_candidates(Some(" fish "), Some("/bin/zsh".into()), &exists);
        assert_eq!(programs(&c), ["fish", "/bin/zsh", "/bin/sh"]);
        assert!(c.iter().all(|c| c.args.is_empty() && c.kind == Kind::Plain));
        let c = unix_candidates(None, Some("/bin/sh".into()), &exists);
        assert_eq!(programs(&c), ["/bin/sh"]);
    }

    #[test]
    fn with_timeout_fast_and_slow() {
        let (tx, rx) = std::sync::mpsc::channel();
        let t = tx.clone();
        let fast = with_timeout(Duration::from_secs(5), || Ok::<i32, String>(7), move |v| {
            t.send(v).unwrap()
        });
        assert_eq!(fast, Some(Ok(7)));
        let t = tx.clone();
        let fast_err = with_timeout(
            Duration::from_secs(5),
            || Err::<i32, String>("빠른 실패".into()),
            move |v| t.send(v).unwrap(),
        );
        assert_eq!(fast_err, Some(Err("빠른 실패".to_string())));

        // 느린 작업: 시간 안에 못 끝나면 None을 **바로** 돌려주고, 값은 늦은 콜백이 받는다.
        let start = Instant::now();
        let t = tx.clone();
        let slow = with_timeout(
            Duration::from_millis(50),
            || {
                std::thread::sleep(Duration::from_millis(300));
                Ok::<i32, String>(42)
            },
            move |v| t.send(v).unwrap(),
        );
        assert!(slow.is_none());
        assert!(start.elapsed() < Duration::from_millis(250), "{:?}", start.elapsed());
        // 빠른 두 건의 콜백이 불렸다면 7이 먼저 도착해 여기서 걸린다.
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(Ok(42)));
        drop(tx);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "콜백이 두 번 불렸다");
    }

    /// 경계 레이스 — 작업 시간이 타임아웃 근처일 때 모든 값이 "반환 XOR 콜백"이어야 한다(유실·중복 없음).
    /// mpsc recv_timeout 구현이면 여기서 값이 샌다 — 늦게 뜬 셸이 kill 없이 버려지는 경로다.
    /// 확률적 검출이라 반복을 경계(작업 = 타임아웃)에 몰았다. 실측(debug, 20회씩): mpsc 구현 19/20회 빨감,
    /// 현 구현 0/20회. 예전처럼 0~20ms로 고르게 60회 돌리면 mpsc를 ~10%만 잡았다.
    #[test]
    fn with_timeout_never_loses_or_duplicates_at_boundary() {
        const N: usize = 300;
        let late_vals = Arc::new(Mutex::new(Vec::new()));
        let mut returned = Vec::new();
        for i in 0..N {
            let sink = Arc::clone(&late_vals);
            // 대부분 경계(10ms = 타임아웃). 20번에 한 번씩 확실히 빠른(0ms)·늦은(30ms) 작업 — 두 경로를 다 타게.
            let work_ms = match i % 20 {
                0 => 0,
                1 => 30,
                _ => 10,
            };
            let r = with_timeout(
                Duration::from_millis(10),
                move || {
                    std::thread::sleep(Duration::from_millis(work_ms));
                    i
                },
                move |v| sink.lock().unwrap_or_else(|e| e.into_inner()).push(v),
            );
            returned.extend(r);
        }
        // 늦은 콜백은 워커에서 돈다 — 다 도착할 때까지 기다린다(유실이면 여기서 시간이 다 간다).
        let deadline = Instant::now() + Duration::from_secs(5);
        while returned.len() + late_vals.lock().unwrap_or_else(|e| e.into_inner()).len() < N && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        let late = late_vals.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut all: Vec<usize> = returned.iter().chain(&late).copied().collect();
        all.sort_unstable();
        assert_eq!(
            all,
            (0..N).collect::<Vec<_>>(),
            "유실 또는 중복 (반환 {}, 콜백 {})",
            returned.len(),
            late.len()
        );
        // 두 경로가 실제로 다 돌았어야 경계를 검증한 것이다.
        assert!(
            !returned.is_empty() && !late.is_empty(),
            "한쪽 경로만 탔다 (반환 {}, 콜백 {})",
            returned.len(),
            late.len()
        );
    }

    #[test]
    fn notice_args_quote_safely() {
        let msg = "[Gitpervisor] it's \"q\" $env:X & (a) 한글\r\n다음\u{7}줄 ‘s’";
        assert_eq!(
            notice_args(Kind::Pwsh, msg),
            [
                "-NoExit",
                "-Command",
                "Write-Host '[Gitpervisor] it''s ''q'' $env:X & (a) 한글다음줄 ''s''' -ForegroundColor Yellow",
            ]
        );
        assert_eq!(notice_args(Kind::WinPs, msg), notice_args(Kind::Pwsh, msg));
        assert_eq!(
            notice_args(Kind::Cmd, msg),
            ["/K", "echo [Gitpervisor] it's q $env:X  a 한글다음줄 ‘s’"]
        );
        assert!(notice_args(Kind::Plain, msg).is_empty());
    }

    #[test]
    fn fallback_notice_names_reasons_and_caps_length() {
        let pwsh = Candidate::new("pwsh.exe", &["-NoLogo"], Kind::Pwsh);
        let ps = Candidate::new("powershell.exe", &["-NoLogo"], Kind::WinPs);
        let stale =
            "앱 실행 별칭이 설치되지 않은 버전(Microsoft.PowerShell_7.6.5.0_x64__8wekyb3d8bbwe)을 가리킴";
        // 같은 이름·사유는 한 번만 — PATH에 같은 별칭이 두 번 걸려도 문장이 늘지 않는다.
        assert_eq!(
            fallback_notice(&[(&pwsh, stale.to_string()), (&pwsh, stale.to_string())], &ps),
            format!("[Gitpervisor] pwsh.exe 를 열 수 없어 Windows PowerShell 5.1 로 대신 열었습니다 — {stale}")
        );
        // Store 별칭이 깨져 MSI pwsh로 내려간 경우 — 둘 다 pwsh.exe라 출처를 붙여야 문장이 성립한다.
        // (백슬래시 경로는 Windows에서만 경로로 쪼개진다.)
        #[cfg(windows)]
        {
            let store = Candidate::new(
                r"C:\Users\u\AppData\Local\Microsoft\WindowsApps\pwsh.exe",
                &["-NoLogo"],
                Kind::Pwsh,
            );
            let msi = Candidate::new(r"C:\Program Files\PowerShell\7\pwsh.exe", &["-NoLogo"], Kind::Pwsh);
            assert_eq!(
                fallback_notice(&[(&store, stale.to_string())], &msi),
                format!(
                    "[Gitpervisor] pwsh.exe [Microsoft Store] 를 열 수 없어 pwsh.exe [C:\\Program Files\\PowerShell\\7] 로 대신 열었습니다 — {stale}"
                )
            );
        }
        let long = fallback_notice(&[(&pwsh, "가".repeat(500))], &ps);
        assert_eq!(long.chars().count(), NOTICE_MAX);
        assert!(long.ends_with('…'));
        assert_eq!(
            short_reason(
                "CreateProcessW `\"x\"` in cwd `Some(\"C:\\\\r\")` failed: 시스템에서 파일에 액세스할 수 없습니다. (os error 1920)"
            ),
            "시스템에서 파일에 액세스할 수 없습니다. (os error 1920)"
        );
    }

    #[test]
    fn failure_cache_respects_fingerprint_and_ttl() {
        let c = FailureCache::default();
        let t0 = Instant::now();
        let fp: Fingerprint = Some((None, 10));
        c.record("k", fp, "막힘", t0);
        assert_eq!(c.hit("k", &fp, t0 + Duration::from_secs(1)).as_deref(), Some("막힘"));
        // 별칭이 다시 만들어지면(지문 변경) 즉시 재시도.
        assert_eq!(c.hit("k", &Some((None, 11)), t0), None);
        assert_eq!(c.hit("k", &fp, t0 + FAILURE_TTL), None);
        c.clear("k");
        assert_eq!(c.hit("k", &fp, t0), None);
    }

    #[cfg(windows)]
    const SIZE: PtySize = PtySize {
        rows: 30,
        cols: 200,
        pixel_width: 0,
        pixel_height: 0,
    };

    #[cfg(windows)]
    fn system32(name: &str) -> PathBuf {
        std::env::var_os("SystemRoot")
            .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from)
            .join("System32")
            .join(name)
    }

    #[cfg(windows)]
    fn squash(s: &str) -> String {
        s.chars().filter(|c| !c.is_whitespace()).collect()
    }

    /// PTY 출력을 계속 모아, 화면에 보이는 글자만(이스케이프 시퀀스·공백·제어문자 제거) 폴링한다.
    /// 공백까지 빼는 이유: ConPTY는 공백 구간을 커서 이동으로 그리기도 한다.
    /// 창 제목(OSC)은 버린다 — 실행 중인 명령줄이 제목으로 나오므로, 그걸 출력으로 오인하면 안 된다.
    #[cfg(windows)]
    struct Screen(Arc<Mutex<Vec<u8>>>);

    #[cfg(windows)]
    impl Screen {
        fn new(master: &(dyn MasterPty + Send)) -> Self {
            use std::io::Read;
            let raw = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&raw);
            let mut reader = master.try_clone_reader().expect("PTY 리더");
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    sink.lock().unwrap_or_else(|e| e.into_inner()).extend_from_slice(&buf[..n]);
                }
            });
            Self(raw)
        }

        fn wait(&self, timeout: Duration, pred: impl Fn(&str) -> bool) -> Result<String, String> {
            let deadline = Instant::now() + timeout;
            loop {
                let text = Self::visible(&self.0.lock().unwrap_or_else(|e| e.into_inner()));
                if pred(&text) {
                    return Ok(text);
                }
                if Instant::now() > deadline {
                    return Err(text);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }

        fn visible(raw: &[u8]) -> String {
            let s = String::from_utf8_lossy(raw);
            let mut out = String::new();
            let mut it = s.chars();
            while let Some(c) = it.next() {
                match c {
                    '\x1b' => match it.next() {
                        // CSI — 종료 바이트(0x40~0x7E)까지
                        Some('[') => {
                            for c in it.by_ref() {
                                if ('\x40'..='\x7e').contains(&c) {
                                    break;
                                }
                            }
                        }
                        // OSC — BEL 또는 ST(ESC \)까지
                        Some(']') => {
                            while let Some(c) = it.next() {
                                if c == '\x07' {
                                    break;
                                }
                                if c == '\x1b' {
                                    it.next();
                                    break;
                                }
                            }
                        }
                        _ => {}
                    },
                    c if c.is_whitespace() || c.is_control() => {}
                    c => out.push(c),
                }
            }
            out
        }
    }

    /// %TEMP%(NTFS)에 가짜 패밀리 별칭을 만들어 읽기 왕복 → 판정 NotInstalled → 사전 검사가 건너뛴다.
    /// 레포가 있는 F:는 exFAT라 재분석 지점을 못 만든다 — 반드시 temp_dir 아래에 만든다.
    #[cfg(windows)]
    #[test]
    fn fake_family_alias_is_skipped() {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;

        let pfn = "Gitpervisor.Test_0123456789abc";
        let target =
            r"C:\Program Files\WindowsApps\Gitpervisor.Test_1.0.0.0_x64__0123456789abc\fake.exe";
        let buf = reparse(
            IO_REPARSE_TAG_APPEXECLINK,
            &link_data(3, &[pfn, "Gitpervisor.Test_0123456789abc!App", target, "0"]),
        );
        let path = std::env::temp_dir().join(format!("gpv-alias-{}.exe", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
                .open(&path)
                .expect("별칭 파일 생성");
            let mut ret = 0u32;
            // SAFETY: 입력 버퍼와 길이를 그대로 넘기고 출력은 없다.
            let ok = unsafe {
                DeviceIoControl(
                    file.as_raw_handle(),
                    FSCTL_SET_REPARSE_POINT,
                    buf.as_ptr().cast(),
                    buf.len() as u32,
                    std::ptr::null_mut(),
                    0,
                    &mut ret,
                    std::ptr::null_mut(),
                )
            };
            assert_ne!(ok, 0, "FSCTL_SET_REPARSE_POINT: {}", std::io::Error::last_os_error());
        }
        let read = read_reparse_data(&path);
        let registered = registered_packages(pfn);
        let pre = precheck(path.to_str().unwrap(), None, Instant::now());
        let _ = std::fs::remove_file(&path);

        assert_eq!(read.as_deref(), Some(&buf[..]), "읽기 왕복");
        assert_eq!(
            parse_appexeclink(&buf),
            Some((pfn.to_string(), target.to_string()))
        );
        assert_eq!(registered, Some(Vec::new()), "가짜 패밀리는 등록 0개여야 한다");
        let why = pre.expect_err("사전 검사가 가짜 별칭을 건너뛰지 않았다");
        assert!(why.contains("설치돼 있지 않음"), "{why}");
    }

    /// 건강한 별칭(winget)은 반드시 Ok — 이걸 오판하면 **모든 사용자가 pwsh 7을 잃는다.**
    #[cfg(windows)]
    #[test]
    fn healthy_store_alias_is_ok() {
        let Some(path) = std::env::var_os("LOCALAPPDATA")
            .map(|l| PathBuf::from(l).join(r"Microsoft\WindowsApps\winget.exe"))
            .filter(|p| is_file_entry(p))
        else {
            eprintln!("winget 별칭이 없다 — 양성 검사를 건너뛴다");
            return;
        };
        let data = read_reparse_data(&path).expect("별칭 재분석 데이터 읽기 실패");
        let (pfn, target) = parse_appexeclink(&data).expect("실제 별칭 파싱 실패 — 레이아웃 가정이 틀렸다");
        let registered = registered_packages(&pfn).expect("패키지 조회 실패");
        assert_eq!(
            judge_alias(&pfn, &target, &registered),
            AliasVerdict::Ok,
            "{pfn} → {target} / 등록 {registered:?}"
        );
        assert_eq!(precheck(path.to_str().unwrap(), None, Instant::now()), Ok(()));
    }

    /// 실제 ConPTY: 없는 후보 → cmd.exe로 내려가고, 안내가 **셸 출력으로** 찍히고, 친 명령이 실행된다.
    /// 원시 ConPTY는 DA1 회신이 없어 첫 출력이 ~3.4초 늦다 — 넉넉히 폴링한다.
    #[cfg(windows)]
    #[test]
    fn falls_back_to_cmd_with_notice() {
        use std::io::Write;
        let missing = std::env::temp_dir()
            .join(format!("gpv-missing-{}", std::process::id()))
            .join("pwsh.exe");
        let cands = [
            Candidate::new(&missing, &["-NoLogo"], Kind::Pwsh),
            Candidate::new(system32("cmd.exe"), &[], Kind::Cmd),
        ];
        let cache: &'static FailureCache = Box::leak(Box::default());
        let mut opened = open_first(&cands, &std::env::temp_dir(), SIZE, cache).expect("cmd.exe로도 못 열었다");
        assert!(opened.program.to_lowercase().ends_with(r"\cmd.exe"), "{}", opened.program);

        let screen = Screen::new(&*opened.master);
        // 실패한 pwsh 후보 이름에는 출처 폴더가 붙는다(`Candidate::label`).
        let notice = squash(&format!(
            "[Gitpervisor] pwsh.exe [{}] 를 열 수 없어 cmd.exe 로 대신 열었습니다 — 파일 없음",
            missing.parent().expect("부모 폴더").display()
        ));
        let result = (|| {
            // /K 인자가 명령으로 안 먹으면 "'echo …'은(는) 내부 또는 외부 명령…" 오류에 같은 문구가
            // 섞여 나온다 — 앞에 echo가 붙은 형태는 안내로 치지 않는다.
            screen
                .wait(Duration::from_secs(30), |t| {
                    t.contains(&notice) && !t.contains(&format!("echo{notice}"))
                })
                .map_err(|t| format!("안내가 안 보인다. 화면: {t}"))?;
            let mut w = opened.master.take_writer().map_err(|e| e.to_string())?;
            // 입력 에코("GPV_%OS%_OK")로는 충족될 수 없는 마커 — cmd가 %OS%를 실제로 펼쳐야 나온다.
            w.write_all(b"echo GPV_%OS%_OK\r").map_err(|e| e.to_string())?;
            screen
                .wait(Duration::from_secs(30), |t| t.contains("GPV_Windows_NT_OK"))
                .map_err(|t| format!("친 명령이 실행되지 않았다. 화면: {t}"))
        })();
        let _ = opened.child.kill();
        result.unwrap();
    }

    /// 실패 기록은 **셸 실행 단계에서 막힌 시간 초과만** — 빠른 실패(PTY 생성 실패·긴 cwd의 os error 267처럼
    /// 후보 탓이 아닐 수 있다)나 openpty에서 막힌 시간 초과를 셸 경로에 기록하면, 멀쩡한 셸을
    /// FAILURE_TTL 동안 모든 프로젝트에서 건너뛴다.
    #[test]
    fn attempt_records_only_spawn_stalls() {
        let cache: &'static FailureCache = Box::leak(Box::default());
        let recorded =
            |p: &str| cache.hit(&p.to_lowercase(), &fingerprint(Path::new(p)), Instant::now());

        let fast = attempt("gpv-fast", Duration::from_secs(5), cache, |spawning| {
            spawning.store(true, Ordering::SeqCst);
            Err("CreateProcessW `x` failed: 디렉터리 이름이 올바르지 않습니다. (os error 267)".to_string())
        });
        assert_eq!(fast.err().as_deref(), Some("디렉터리 이름이 올바르지 않습니다. (os error 267)"));
        assert_eq!(recorded("gpv-fast"), None, "빠른 실패가 기록됐다");

        // 워커는 문이 닫힐 때까지(= attempt가 시간 초과로 돌아온 뒤) 막혀 있다가 늦게 실패한다.
        let stall = |program: &str, past_openpty: bool| {
            let (release, gate) = std::sync::mpsc::channel::<()>();
            let r = attempt(program, Duration::from_millis(50), cache, move |spawning| {
                spawning.store(past_openpty, Ordering::SeqCst);
                let _ = gate.recv();
                Err("늦은 실패".to_string())
            });
            drop(release);
            r.err()
        };
        let timed_out = Some("0초 안에 시작되지 않음");
        assert_eq!(stall("gpv-pty-stall", false).as_deref(), timed_out);
        assert_eq!(recorded("gpv-pty-stall"), None, "openpty에서 막힌 시간 초과가 셸 탓으로 기록됐다");
        assert_eq!(stall("gpv-spawn-stall", true).as_deref(), timed_out);
        assert_eq!(
            recorded("gpv-spawn-stall").as_deref(),
            timed_out,
            "셸 실행이 막힌 시간 초과가 기록되지 않았다"
        );
    }

    /// 시간 초과 뒤에 뜬 셸은 거두고(kill) 실패 기록도 지운다 — 느렸을 뿐 고장이 아니다.
    /// kill이 빠지면 대화형 cmd는 스스로 끝나지 않아 늦은 콜백이 wait()에서 영영 멈추고 뒤의 clear도 오지
    /// 않는다 → 기록이 남는 것으로 잡힌다(보이지 않는 셸+ConPTY가 앱 수명 내내 남는 누수 경로다).
    #[cfg(windows)]
    #[test]
    fn late_spawn_is_killed_and_unrecorded() {
        let cmd = system32("cmd.exe").to_string_lossy().into_owned();
        let cache: &'static FailureCache = Box::leak(Box::default());
        let hit = || cache.hit(&cmd.to_lowercase(), &fingerprint(Path::new(&cmd)), Instant::now());
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let work = {
            let cmd = cmd.clone();
            // openpty는 지났고 CreateProcessW가 막힌 상황 — 문이 열리면(시간 초과 뒤) 실제로 셸을 띄운다.
            move |spawning: &AtomicBool| {
                spawning.store(true, Ordering::SeqCst);
                let _ = gate.recv();
                spawn_in_pty(&cmd, &[], &std::env::temp_dir(), SIZE, spawning)
            }
        };
        let r = attempt(&cmd, Duration::from_millis(50), cache, work);
        assert_eq!(r.err().as_deref(), Some("0초 안에 시작되지 않음"));
        assert!(hit().is_some(), "셸 실행이 막힌 시간 초과가 기록되지 않았다");
        drop(release);
        let deadline = Instant::now() + Duration::from_secs(30);
        while hit().is_some() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(hit(), None, "늦게 뜬 셸이 거둬지지 않았다(kill이 없으면 wait가 끝나지 않는다)");
    }

    /// 실제 빠른 spawn 실패(PE가 아닌 .exe — CreateProcessW가 즉시 거절) → 다음 후보로 내려가되 기록은 남기지 않는다.
    #[cfg(windows)]
    #[test]
    fn fast_spawn_failure_is_not_recorded() {
        let bad = std::env::temp_dir().join(format!("gpv-bad-{}.exe", std::process::id()));
        std::fs::write(&bad, "not a PE image").expect("가짜 exe 생성");
        let cands = [
            Candidate::new(&bad, &[], Kind::Plain),
            Candidate::new(system32("cmd.exe"), &[], Kind::Cmd),
        ];
        let cache: &'static FailureCache = Box::leak(Box::default());
        let opened = open_first(&cands, &std::env::temp_dir(), SIZE, cache);
        // 백신이 지웠다면 사전 검사("파일 없음")에서 빠진 것이라 spawn 실패 경로를 검증하지 못한 것이다.
        let reached_spawn = is_file_entry(&bad);
        let _ = std::fs::remove_file(&bad);
        let mut opened = opened.expect("cmd.exe로도 못 열었다");
        let _ = opened.child.kill();
        assert!(opened.program.to_lowercase().ends_with(r"\cmd.exe"), "{}", opened.program);
        assert!(reached_spawn, "가짜 exe가 사라졌다 — spawn 실패 경로를 타지 못했다");
        assert!(cache.0.lock().unwrap_or_else(|e| e.into_inner()).is_empty(), "빠른 spawn 실패가 기록됐다");
    }

    /// 정상 경로(첫 후보가 뜸)에는 안내가 없고, 마지막 후보는 실패 기록이 있어도 실제로 띄워 본다
    /// — 일시 장애로 모든 후보가 기록돼도 FAILURE_TTL 동안 터미널이 아예 안 열리는 일이 없게.
    #[cfg(windows)]
    #[test]
    fn last_candidate_ignores_cache_and_opens_without_notice() {
        use std::io::Write;
        let cmd = system32("cmd.exe");
        let cache: &'static FailureCache = Box::leak(Box::default());
        cache.record(&cmd.to_string_lossy().to_lowercase(), fingerprint(&cmd), "막힘", Instant::now());
        let cands = [Candidate::new(&cmd, &[], Kind::Cmd)];
        let mut opened = open_first(&cands, &std::env::temp_dir(), SIZE, cache)
            .expect("실패 기록이 있는 마지막 후보를 건너뛰었다");
        let screen = Screen::new(&*opened.master);
        let result = (|| {
            // 프롬프트(`…>`)가 뜬 뒤에 친다. 안내(/K echo)가 있었다면 프롬프트보다 먼저 찍혔다.
            screen
                .wait(Duration::from_secs(30), |t| t.ends_with('>'))
                .map_err(|t| format!("프롬프트가 안 보인다. 화면: {t}"))?;
            let mut w = opened.master.take_writer().map_err(|e| e.to_string())?;
            w.write_all(b"echo GPV_%OS%_OK\r").map_err(|e| e.to_string())?;
            let t = screen
                .wait(Duration::from_secs(30), |t| t.contains("GPV_Windows_NT_OK"))
                .map_err(|t| format!("친 명령이 실행되지 않았다. 화면: {t}"))?;
            if t.contains("[Gitpervisor]") {
                return Err(format!("정상 경로에 안내가 찍혔다. 화면: {t}"));
            }
            Ok(())
        })();
        let _ = opened.child.kill();
        result.unwrap();
    }

    /// 실제 ConPTY + Windows PowerShell 5.1: 까다로운 문자가 든 안내가 **그대로** 찍힌다(-Command 인용 검증).
    /// 입력 에코와 겹치지 않게 명령은 치지 않는다. 사용자 프로필 로딩 때문에 느릴 수 있다.
    #[cfg(windows)]
    #[test]
    fn powershell_prints_tricky_notice_verbatim() {
        let msg = "[Gitpervisor] 따옴표's \"쌍\" $HOME & (괄호) 끝";
        let mut args = vec!["-NoLogo".to_string()];
        args.extend(notice_args(Kind::WinPs, msg));
        let ps = system32(r"WindowsPowerShell\v1.0\powershell.exe");
        let (master, mut child) = spawn_in_pty(
            &ps.to_string_lossy(),
            &args,
            &std::env::temp_dir(),
            SIZE,
            &AtomicBool::new(false),
        )
        .expect("powershell.exe 실행 실패");
        let screen = Screen::new(&*master);
        // `"`는 `'`로 바뀌어 찍힌다. `$HOME`이 펼쳐지거나 인용이 깨지면 이 문자열이 안 나온다.
        let want = squash(&msg.replace('"', "'"));
        // 인용이 깨지면 PowerShell 파서 오류가 원본 명령줄(`Write-Host …`)을 함께 찍는다 —
        // 그 안에 섞인 문구는 안내로 치지 않는다.
        let r = screen.wait(Duration::from_secs(60), |t| {
            t.contains(&want) && !t.contains("Write-Host")
        });
        let _ = child.kill();
        r.unwrap_or_else(|t| panic!("안내가 그대로 찍히지 않았다. 화면: {t}"));
    }

    /// [수동] 이 머신 실상태 회귀 — 자동 후보로 열었을 때, 첫 후보(PATH의 첫 pwsh)의 상태에 따라:
    /// - 사전 검사가 막는 상태(2026-09 사건: Store 별칭이 설치되지 않은 버전을 가리킴)면 3초 안에 다음
    ///   후보가 뜨고 안내에 그 사유가 담긴다(사전 검사가 없으면 60초+ 뒤 os error 1920).
    /// - 멀쩡하면 그 셸이 **안내 없이** 떠서 프롬프트를 낸다 — 폴백이 정상 경로를 건드리지 않는다.
    /// 어느 상태에서 돌려도 그 상태의 올바른 동작을 단언한다(별칭이 고쳐져도 빨개지지 않는다).
    #[cfg(windows)]
    #[test]
    #[ignore = "이 머신의 셸 설치 상태에 의존하고 실제 셸(사용자 프로필 포함)을 띄운다 — cargo test -- --ignored 로 수동 실행"]
    fn machine_auto_shell_opens_fast() {
        let cands = candidates(None);
        eprintln!("후보: {:?}", programs(&cands));
        let first = cands[0].program.clone();
        let blocked = precheck(&first, None, Instant::now()).err();
        eprintln!("첫 후보 사전 검사: {}", blocked.as_deref().unwrap_or("통과"));
        let cache: &'static FailureCache = Box::leak(Box::default());
        let start = Instant::now();
        let mut opened = open_first(&cands, &std::env::temp_dir(), SIZE, cache).expect("셸을 못 열었다");
        let took = start.elapsed();
        eprintln!("선택: {} ({took:?})", opened.program);
        let screen = Screen::new(&*opened.master);
        let result = match &blocked {
            Some(why) => screen
                .wait(Duration::from_secs(60), |t| t.contains("[Gitpervisor]") && !t.contains("Write-Host"))
                .map_err(|t| format!("폴백 안내가 안 보인다({why}). 화면: {t}")),
            // 프롬프트 = 셸이 실제로 돌고 있다는 증거다(아무것도 치지 않으므로 입력 에코로 흉내 낼 수 없다).
            // 폴백 안내는 프롬프트보다 **먼저** 찍히므로, 프롬프트가 떴는데 안내가 없으면 안내가 없는 것이다.
            // 입력을 치지 않는 이유(실측): 원시 ConPTY에서 pwsh 7에 친 글자는 프롬프트가 뜬 뒤에도 에코조차
            // 안 됐다 — 터미널 질의에 답할 쪽(실제 앱은 xterm)이 없어 PSReadLine이 삼키는 것으로 추정한다.
            None => screen
                .wait(Duration::from_secs(60), |t| t.trim_end().ends_with(['>', '❯', '$', '#']))
                .map_err(|t| format!("프롬프트가 안 뜬다. 화면: {t}")),
        };
        let _ = opened.child.kill();
        let text = result.unwrap_or_else(|e| panic!("{e}"));
        match blocked {
            Some(_) => {
                assert!(took < Duration::from_secs(3), "폴백이 느리다: {took:?}");
                assert_ne!(opened.program, first, "사전 검사가 막은 후보를 띄웠다");
                let at = text.find("[Gitpervisor]").unwrap_or(0);
                eprintln!("안내(공백 제거): {}", text[at..].chars().take(160).collect::<String>());
            }
            None => {
                assert!(took < SPAWN_TIMEOUT, "첫 후보가 느리다: {took:?}");
                assert_eq!(opened.program, first, "멀쩡한 첫 후보를 두고 다른 셸을 띄웠다");
                assert!(!text.contains("[Gitpervisor]"), "정상 경로에 폴백 안내가 찍혔다: {text}");
            }
        }
    }
}
