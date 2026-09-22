//! 타이핑 경로 프로세스의 CPU 우선순위 (Windows).
//!
//! **왜.** 백그라운드 작업(빌드·robocopy·python·llama.cpp의 CPU 스레드)이 코어를 다 채우면
//! 키 입력이 지나는 프로세스 — 앱 자신(IPC·PTY 펌프), WebView2(렌더러·GPU), ConPTY 호스트
//! (OpenConsole), 셸, 터미널 안의 에이전트 TUI(claude.exe) — 가 전부 Normal로 같은 줄에 선다.
//! 실측(2026-09-21, 24코어를 Normal 바쁜 루프 24개로 포화, dev 앱 pwsh 에코): 키→에코 파싱
//! p90 9→36ms, 키→프레임 max 52→140ms. 이 체인만 AboveNormal로 올리자 p90 8.7ms·max 42.8ms로
//! 부하 없는 기준선과 같아졌다(DOCS/task/71).
//!
//! **AboveNormal은 자식에게 상속되지 않는다**(CreateProcess는 부모가 Idle/BelowNormal일 때만
//! 우선순위 클래스를 물려준다). 그래서 셸·claude.exe가 띄운 빌드·스크립트는 그대로 Normal이다 —
//! 무거운 일은 두고 대화형 프로세스만 앞세우는 게 이 설계의 요점이다. 같은 이유로 셸의 자식은
//! [`AGENT_EXES`]에 있는 것만 올린다: 셸에서 직접 돌린 python·llama-bench까지 올리면 그게
//! 다시 우리와 같은 줄에 선다.
//!
//! **Normal인 것만 올린다.** 사용자가 작업 관리자로 일부러 바꿔 둔 값은 덮지 않는다.
//!
//! 리눅스·macOS에는 대응이 없다 — 비특권 프로세스는 nice를 낮출(우선순위를 올릴) 수 없다.

use std::collections::{HashMap, HashSet};

/// 셸의 자식 중 올릴 것 — 사람이 직접 타이핑하는 대화형 TUI만.
const AGENT_EXES: &[&str] = &["claude.exe", "codex.exe", "opencode.exe"];
/// 앱의 직계 자식 중 PTY 셸로 볼 것(`shell.rs`가 띄우는 후보들).
const SHELL_EXES: &[&str] = &[
    "pwsh.exe",
    "powershell.exe",
    "cmd.exe",
    "bash.exe",
    "wsl.exe",
    "nu.exe",
];
/// ConPTY 호스트 — 번들이면 OpenConsole, OS 폴백이면 conhost.
const CONPTY_HOSTS: &[&str] = &["openconsole.exe", "conhost.exe"];
const WEBVIEW_EXE: &str = "msedgewebview2.exe";

fn is_one_of(name: &str, list: &[&str]) -> bool {
    list.iter().any(|x| name.eq_ignore_ascii_case(x))
}

/// 올릴 PID 목록. `entries`는 시스템 전체 스냅샷 (pid, ppid, exe명).
///
/// 앱 자신 + 직계 자식 중 WebView2(브라우저 프로세스와 그 아래 렌더러·GPU 전부)·ConPTY 호스트·
/// 셸 + 셸 직계 자식 중 에이전트. 앱이 띄우는 나머지 직계 자식(llama-server·LSP·git·ffmpeg)은
/// 백그라운드 일이라 건드리지 않는다.
pub(crate) fn interactive_pids(me: u32, entries: &[(u32, u32, String)]) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<(u32, &str)>> = HashMap::new();
    for (pid, ppid, name) in entries {
        if pid != ppid {
            children.entry(*ppid).or_default().push((*pid, name.as_str()));
        }
    }
    let kids = |p: u32| children.get(&p).map(Vec::as_slice).unwrap_or(&[]);
    let mut out = vec![me];
    // PID 재사용으로 부모 사슬에 고리가 생겨도 WebView2 하위 순회가 끝나게.
    let mut seen: HashSet<u32> = HashSet::from([me]);
    for &(pid, name) in kids(me) {
        if name.eq_ignore_ascii_case(WEBVIEW_EXE) {
            let mut stack = vec![pid];
            while let Some(p) = stack.pop() {
                if !seen.insert(p) {
                    continue;
                }
                out.push(p);
                stack.extend(kids(p).iter().map(|&(k, _)| k));
            }
        } else if is_one_of(name, CONPTY_HOSTS) {
            out.push(pid);
        } else if is_one_of(name, SHELL_EXES) {
            out.push(pid);
            out.extend(
                kids(pid)
                    .iter()
                    .filter(|&&(_, n)| is_one_of(n, AGENT_EXES))
                    .map(|&(k, _)| k),
            );
        }
    }
    out
}

/// Normal인 것만 AboveNormal로. 이미 죽었거나 권한이 없는 PID는 건너뛴다 — 다음 스윕이 다시 본다.
pub(crate) fn raise(pids: &[u32]) {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
    use windows_sys::Win32::System::Threading::{
        GetPriorityClass, OpenProcess, SetPriorityClass, ABOVE_NORMAL_PRIORITY_CLASS,
        NORMAL_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    };
    static WARNED: AtomicBool = AtomicBool::new(false);
    for &pid in pids {
        // SAFETY: 실패하면 널 핸들이라 아래에서 걸러낸다. 얻은 핸들은 이 반복 안에서 닫는다.
        let h = unsafe {
            OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)
        };
        if h.is_null() {
            continue;
        }
        unsafe {
            if GetPriorityClass(h) == NORMAL_PRIORITY_CLASS
                && SetPriorityClass(h, ABOVE_NORMAL_PRIORITY_CLASS) == FALSE
                && !WARNED.swap(true, Ordering::Relaxed)
            {
                log::warn!(
                    "[priority] AboveNormal 설정 실패 pid={pid}: {}",
                    std::io::Error::last_os_error()
                );
            }
            CloseHandle(h);
        }
    }
}

/// 지금 바로 한 번 — 새 터미널이 열린 직후처럼 30초 주기 스윕을 기다리면 안 될 때.
pub(crate) fn sweep_now() {
    let entries = crate::health::probe::process_entries();
    if entries.is_empty() {
        return;
    }
    raise(&interactive_pids(std::process::id(), &entries));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(pid: u32, ppid: u32, name: &str) -> (u32, u32, String) {
        (pid, ppid, name.to_string())
    }

    /// 대화형 체인만 오르고, 셸·에이전트가 띄운 무거운 일과 앱의 백그라운드 자식은 그대로다.
    #[test]
    fn interactive_pids_picks_typing_chain_only() {
        let entries = vec![
            e(10, 1, "gitpervisor.exe"),
            e(11, 10, "msedgewebview2.exe"), // 브라우저 프로세스
            e(12, 11, "msedgewebview2.exe"), // 렌더러
            e(13, 11, "msedgewebview2.exe"), // GPU
            e(20, 10, "OpenConsole.exe"),
            e(21, 10, "pwsh.exe"),
            e(22, 21, "claude.exe"),
            e(23, 22, "bash.exe"),   // claude 의 도구 실행
            e(24, 23, "python.exe"), // 그 아래 무거운 일
            e(25, 21, "llama-bench.exe"), // 셸에서 직접 돌린 무거운 일
            e(30, 10, "llama-server.exe"), // 앱의 로컬 LLM
            e(31, 10, "git.exe"),
            e(40, 1, "msedgewebview2.exe"), // 남의 앱 웹뷰
            e(41, 1, "pwsh.exe"),           // 남의 셸
        ];
        let mut got = interactive_pids(10, &entries);
        got.sort_unstable();
        assert_eq!(got, vec![10, 11, 12, 13, 20, 21, 22]);
    }

    /// PID 재사용으로 부모 사슬에 고리가 생겨도 끝나고, 같은 PID를 두 번 내지 않는다.
    #[test]
    fn interactive_pids_survives_parent_cycle() {
        let entries = vec![
            e(10, 1, "gitpervisor.exe"),
            e(11, 10, "msedgewebview2.exe"),
            e(12, 11, "msedgewebview2.exe"),
            e(11, 12, "msedgewebview2.exe"), // 재사용된 PID가 만든 고리
        ];
        let mut got = interactive_pids(10, &entries);
        got.sort_unstable();
        assert_eq!(got, vec![10, 11, 12]);
    }
}
