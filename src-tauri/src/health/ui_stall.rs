//! UI(메인) 스레드 멈춤 감시 — 메인 스레드가 [`STALL_AFTER`] 넘게 응답하지 않으면 로그를 남기고, Windows 에서는
//! 자기 프로세스의 미니덤프를 로그 폴더에 쓴다.
//!
//! 왜: 2026-10-07 설치본이 메모리 고갈 직후 UI 스레드가 약 5분 멈춰 AppHang 으로 강제 종료됐는데, WER 보고서도
//! 덤프도 남지 않아 어디서 막혔는지 알 수 없었다(2026-09-17 멈춤도 같았다). health 감시 스레드는 그동안 멀쩡히
//! 기록했다 — 멈춘 건 메인 스레드뿐이라 **그 스레드의 스택**이 유일한 단서다.
//!
//! 방법: 1초마다 메인 스레드에 빈 작업을 예약하고(`run_on_main_thread` — 이벤트 루프 큐에 넣는 것이라 메인이 막혀
//! 있으면 돌지 않는다) 그 작업이 [`STALL_AFTER`] 안에 돌았는지 본다. 예약은 한 번에 하나만 둔다 — 멈춘 동안 큐에
//! 수백 개를 쌓지 않는다.
//!
//! ponytail: 덤프는 Windows 만 쓴다(MiniDumpWriteDump). macOS·Linux 는 무응답 시각·길이만 로그에 남는다 —
//! 그쪽에서 멈춤이 보고되면 gcore/sample 로 같은 자리를 채운다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::AppHandle;

const PROBE_EVERY: Duration = Duration::from_secs(1);
/// 이만큼 응답이 없으면 멈춤으로 본다 — Windows 가 "응답 없음"을 띄우는 5초보다 길게 잡아, 잠깐 무거운 작업(큰 창
/// 생성 등)으로는 덤프가 나오지 않게 한다.
const STALL_AFTER: Duration = Duration::from_secs(10);
/// 남겨 둘 덤프 수 — 오래된 것부터 지운다(dev 앱 실측 한 개 0.9MB).
const KEEP_DUMPS: usize = 3;
const DUMP_PREFIX: &str = "ui-stall-";

/// 메인 스레드에 예약한 확인 작업이 아직 안 돌았다.
static PENDING: AtomicBool = AtomicBool::new(false);
/// 종료 중 — 이벤트 루프가 내려가며 예약이 영영 안 도는 것을 멈춤으로 세지 않는다.
static STOPPING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq)]
enum Verdict {
    Ok,
    StallBegan,
    Stalled,
    Recovered,
}

/// `waiting` = 아직 안 돈 확인 작업을 예약한 지 얼마나 됐나(없으면 None — 마지막 작업이 돌았다).
fn judge(waiting: Option<Duration>, in_stall: bool) -> Verdict {
    match (in_stall, waiting) {
        (false, Some(w)) if w >= STALL_AFTER => Verdict::StallBegan,
        (false, _) => Verdict::Ok,
        (true, None) => Verdict::Recovered,
        (true, Some(_)) => Verdict::Stalled,
    }
}

/// 종료 훅에서 부른다.
pub fn stop() {
    STOPPING.store(true, Ordering::Relaxed);
}

/// setup 에서 1회. `dump_dir` 은 로그 폴더(배너의 [로그 폴더 열기]가 여는 곳).
pub fn spawn(app: AppHandle, dump_dir: PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("ui-stall-watch".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut posted_at: Option<Instant> = None;
            let mut stall_from: Option<Instant> = None;
            loop {
                let slept_from = Instant::now();
                std::thread::sleep(PROBE_EVERY);
                if STOPPING.load(Ordering::Relaxed) {
                    return;
                }
                // 이 스레드도 제때 못 깼다 — 절전 복귀거나 시스템 전체가 멈춰 있었다. 메인을 탓할 근거가 아니니
                // 기다림을 지금부터 다시 잰다.
                if slept_from.elapsed() > PROBE_EVERY * 5 {
                    if let Some(p) = posted_at.as_mut() {
                        *p = Instant::now();
                    }
                }
                if !PENDING.load(Ordering::Acquire) {
                    posted_at = None;
                }
                match judge(posted_at.map(|p| p.elapsed()), stall_from.is_some()) {
                    Verdict::StallBegan => {
                        stall_from = posted_at;
                        // 덤프 **전에** 남긴다 — 덤프가 이 스레드까지 붙잡아도(로더 락 등) 멈춤 사실은 남는다.
                        log::warn!(
                            "[ui-stall] 메인 스레드 {}초 무응답 — 덤프를 남긴다", // i18n-ok: 로그
                            STALL_AFTER.as_secs()
                        );
                        match write_dump(&dump_dir) {
                            Ok(Some(path)) => log::warn!("[ui-stall] 덤프 {}", path.display()), // i18n-ok: 로그
                            Ok(None) => {}
                            Err(e) => log::warn!("[ui-stall] 덤프 실패: {e}"), // i18n-ok: 로그
                        }
                    }
                    Verdict::Recovered => {
                        let secs = stall_from.map(|s| s.elapsed().as_secs()).unwrap_or(0);
                        log::warn!("[ui-stall] 메인 스레드 회복 — 약 {secs}초 멈춰 있었다"); // i18n-ok: 로그
                        stall_from = None;
                    }
                    Verdict::Ok | Verdict::Stalled => {}
                }
                if posted_at.is_none() {
                    PENDING.store(true, Ordering::Release);
                    if app.run_on_main_thread(|| PENDING.store(false, Ordering::Release)).is_err() {
                        return; // 이벤트 루프가 끝났다 — 종료 중
                    }
                    posted_at = Some(Instant::now());
                }
            }
        });
    if let Err(e) = spawned {
        log::warn!("[ui-stall] 감시 스레드를 띄우지 못했다: {e}"); // i18n-ok: 로그
    }
}

/// 같은 접두의 오래된 덤프를 지우고 `keep - 1` 개만 남긴다(새로 하나 쓸 자리).
fn prune_old_dumps(dir: &Path, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return; // 폴더가 없으면 지울 것도 없다 — 쓰는 쪽이 만든다
    };
    let mut dumps: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(DUMP_PREFIX) && n.ends_with(".dmp")))
        .collect();
    dumps.sort(); // 이름이 시각이라 사전순 = 시간순
    let excess = (dumps.len() + 1).saturating_sub(keep);
    for p in dumps.into_iter().take(excess) {
        if let Err(e) = std::fs::remove_file(&p) {
            log::warn!("[ui-stall] 옛 덤프를 못 지웠다 {}: {e}", p.display()); // i18n-ok: 로그
        }
    }
}

#[cfg(windows)]
fn write_dump(dir: &Path) -> Result<Option<PathBuf>, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Diagnostics::Debug::{
        MiniDumpWithHandleData, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules, MiniDumpWriteDump,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};

    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    prune_old_dumps(dir, KEEP_DUMPS);
    let path = dir.join(format!("{DUMP_PREFIX}{}.dmp", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    let file = std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    // 스레드 스택·스레드 상태·핸들(무엇을 기다리나)·언로드된 모듈 — 힙은 뺀다(그래서 1MB 안팎이다).
    let kind = MiniDumpWithThreadInfo | MiniDumpWithHandleData | MiniDumpWithUnloadedModules;
    // SAFETY: 핸들은 모두 이 함수 안에서 살아 있다(GetCurrentProcess 는 의사 핸들이라 닫지 않는다). 다른 스레드에서
    // 자기 프로세스를 덤프하는 것은 허용된다 — 덤프하는 동안 나머지 스레드는 dbghelp 가 잠시 세운다.
    let ok = unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file.as_raw_handle() as _,
            kind,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        drop(file);
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("[ui-stall] 빈 덤프 파일을 못 지웠다 {}: {e}", path.display()); // i18n-ok: 로그
        }
        return Err(format!("MiniDumpWriteDump: {err}"));
    }
    Ok(Some(path))
}

#[cfg(not(windows))]
fn write_dump(_dir: &Path) -> Result<Option<PathBuf>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn judge_reports_a_stall_once_and_its_recovery() {
        assert_eq!(judge(None, false), Verdict::Ok);
        assert_eq!(judge(Some(Duration::from_secs(3)), false), Verdict::Ok, "잠깐 바쁜 건 멈춤이 아니다");
        assert_eq!(judge(Some(STALL_AFTER), false), Verdict::StallBegan);
        assert_eq!(judge(Some(STALL_AFTER * 30), true), Verdict::Stalled, "멈춘 동안 덤프를 또 쓰지 않는다");
        assert_eq!(judge(None, true), Verdict::Recovered);
    }

    #[test]
    fn prune_keeps_room_for_one_new_dump() {
        let dir = std::env::temp_dir().join(format!("gpv-ui-stall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in ["ui-stall-20261007-110000.dmp", "ui-stall-20261007-120000.dmp", "ui-stall-20261007-130000.dmp", "other.dmp"] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        prune_old_dumps(&dir, 3);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["other.dmp", "ui-stall-20261007-120000.dmp", "ui-stall-20261007-130000.dmp"], "가장 오래된 것 하나만, 남의 파일은 안 건드린다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 실제로 덤프가 써지는지 — 쓰고 나서 크기를 본다(빈 파일이면 dbghelp 호출이 실패한 것이다).
    #[cfg(windows)]
    #[test]
    fn writes_a_real_minidump_of_this_process() {
        let dir = std::env::temp_dir().join(format!("gpv-ui-stall-dump-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = write_dump(&dir).expect("덤프 성공").expect("Windows 는 경로를 준다");
        let len = std::fs::metadata(&path).unwrap().len();
        // 스레드가 적은 테스트 프로세스라 60KB 남짓이다(앱은 0.9MB) — 크기보다 아래 서명이 진짜 판정이다.
        assert!(len > 4 * 1024, "덤프가 너무 작다: {len}");
        let mut magic = [0u8; 4];
        use std::io::Read;
        std::fs::File::open(&path).unwrap().read_exact(&mut magic).unwrap();
        assert_eq!(&magic, b"MDMP", "미니덤프 서명");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
