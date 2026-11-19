//! Codex CLI의 app-server에서 ChatGPT 계정의 사용 한도를 읽는다.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::claude_usage::{AgentUsage, UsageWindow};
#[cfg(not(windows))]
use crate::tools::runner::{find_in_wellknown_dirs, find_on_path};

/// 성공하면 3분 쉰다(Claude 쪽 API_TTL 과 같다).
const TTL: Duration = Duration::from_secs(180);
/// 실패는 곧 다시 묻는다 — app-server 를 띄워야 해서 Claude 의 15초보다는 느긋하게.
const RETRY: Duration = Duration::from_secs(30);

struct Cache {
    /// 이때까지는 다시 묻지 않는다.
    next: Option<Instant>,
    /// 마지막 성공 — 한 번 실패했다고 지우지 않는다. 오래되면 프론트가 숨긴다(updated_at).
    usage: Option<AgentUsage>,
    last_err: Option<String>,
}

static CACHE: Mutex<Cache> = Mutex::const_new(Cache { next: None, usage: None, last_err: None });

/// 예전엔 실패(시간 초과·오류 응답) 한 번에 마지막 값을 None 으로 덮고 3분을 쉬어서, 상단 Codex 사용량이 가끔 통째로
/// 사라졌다(2026-11-19 사용자 지적). 지금은 마지막 성공을 들고 있고 실패는 30초 뒤 다시 묻는다.
#[tauri::command(async)]
pub async fn codex_usage() -> Option<AgentUsage> {
    let mut cache = CACHE.lock().await;
    if cache.next.is_none_or(|t| Instant::now() >= t) {
        let got = tokio::time::timeout(Duration::from_secs(10), read_usage())
            .await
            .unwrap_or_else(|_| Err("no response within 10s".into()));
        apply_fetch(&mut cache, got, Instant::now());
    }
    cache.usage.clone()
}

fn apply_fetch(cache: &mut Cache, got: Result<AgentUsage, String>, now: Instant) {
    match got {
        Ok(u) => {
            cache.usage = Some(u);
            cache.next = Some(now + TTL);
            cache.last_err = None;
        }
        Err(e) => {
            cache.next = Some(now + RETRY);
            if cache.last_err.as_deref() != Some(e.as_str()) {
                log::info!("[codex-usage] 사용량 조회 실패 — {e} (다음 조회 {}초 뒤)", RETRY.as_secs());
                cache.last_err = Some(e);
            }
        }
    }
}

fn codex_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // npm의 Windows shim도 지원한다. 현재 프로젝트에서 동명 파일을 실행하지 않는다.
        let path = std::env::var_os("PATH")?;
        return std::env::split_paths(&path)
            .filter(|dir| dir.is_absolute())
            .flat_map(|dir| [dir.join("codex.exe"), dir.join("codex.cmd")])
            .find(|file| file.is_file());
    }
    #[cfg(not(windows))]
    {
        find_on_path("codex")
            .filter(|path| path.is_absolute())
            .or_else(|| find_in_wellknown_dirs("codex"))
    }
}

async fn read_usage() -> Result<AgentUsage, String> {
    let mut command = Command::new(codex_path().ok_or("codex not found on PATH")?);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = command.spawn().map_err(|e| format!("spawn codex app-server: {e}"))?;
    let mut input = child.stdin.take().ok_or("no stdin")?;
    let mut output = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    let initialize = json!({
        "id": 1,
        "method": "initialize",
        "params": { "clientInfo": { "name": "gitpervisor", "version": env!("CARGO_PKG_VERSION") } }
    });
    input
        .write_all(format!("{initialize}\n").as_bytes())
        .await
        .map_err(|e| format!("write initialize: {e}"))?;

    while let Some(line) = output.next_line().await.map_err(|e| format!("read response: {e}"))? {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message["id"].as_u64() {
            Some(1) if message.get("result").is_some() => {
                input
                    .write_all(b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/rateLimits/read\"}\n")
                    .await
                    .map_err(|e| format!("write rateLimits request: {e}"))?;
            }
            Some(1) => return Err(format!("initialize rejected: {}", message["error"])),
            Some(2) => {
                return message
                    .get("result")
                    .and_then(parse_usage)
                    .ok_or_else(|| format!("no limits in rateLimits response: {}", message.get("error").unwrap_or(&message)));
            }
            _ => {}
        }
    }
    Err("app-server exited before responding".into())
}

fn parse_usage(result: &Value) -> Option<AgentUsage> {
    let limits = result
        .pointer("/rateLimitsByLimitId/codex")
        .or_else(|| result.get("rateLimits"))?;
    let windows: Vec<_> = ["primary", "secondary"]
        .into_iter()
        .filter_map(|name| {
            let window = limits.get(name)?;
            let key = match window["windowDurationMins"].as_u64() {
                Some(300) => "five_hour".into(),
                Some(10_080) => "seven_day".into(),
                Some(minutes) => format!("{minutes}m"),
                None => name.into(),
            };
            Some(UsageWindow {
                key,
                used_percentage: window["usedPercent"].as_f64()? as f32,
                resets_at: window["resetsAt"].as_i64(),
            })
        })
        .collect();
    (!windows.is_empty()).then(|| AgentUsage {
        windows,
        updated_at: chrono::Utc::now().timestamp(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(pct: f32) -> AgentUsage {
        AgentUsage { windows: vec![UsageWindow { key: "seven_day".into(), used_percentage: pct, resets_at: None }], updated_at: 1 }
    }

    /// 사용자 보고(2026-11-19): 한 번 실패하면 Codex 사용량이 3분 동안 사라졌다.
    #[test]
    fn codex_usage_failure_keeps_last_value_and_retries_soon() {
        let mut c = Cache { next: None, usage: None, last_err: None };
        let t0 = Instant::now();
        apply_fetch(&mut c, Ok(usage(5.0)), t0);
        assert_eq!(c.next, Some(t0 + TTL));
        let t1 = t0 + TTL;
        apply_fetch(&mut c, Err("no response within 10s".into()), t1);
        assert_eq!(c.usage.as_ref().map(|u| u.windows[0].used_percentage), Some(5.0), "실패해도 마지막 값을 보인다");
        assert_eq!(c.next, Some(t1 + RETRY), "실패는 3분이 아니라 곧 다시 묻는다");
        apply_fetch(&mut c, Ok(usage(7.0)), t1 + RETRY);
        assert_eq!(c.usage.as_ref().map(|u| u.windows[0].used_percentage), Some(7.0));
        assert!(c.last_err.is_none());
    }

    #[test]
    fn codex_usage_parses_weekly_only_plan() {
        // 2026-11-19 실측(plus): primary 만 주간, secondary null.
        let r: Value = serde_json::from_str(
            r#"{"rateLimits":{"limitId":"codex","primary":{"usedPercent":5,"windowDurationMins":10080,"resetsAt":1795529182},"secondary":null}}"#,
        )
        .unwrap();
        let u = parse_usage(&r).unwrap();
        assert_eq!(u.windows.len(), 1);
        assert_eq!((u.windows[0].key.as_str(), u.windows[0].resets_at), ("seven_day", Some(1_795_529_182)));
    }
}
