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

#[derive(Default)]
struct Cache {
    fetched_at: Option<Instant>,
    usage: Option<AgentUsage>,
}

static CACHE: Mutex<Cache> = Mutex::const_new(Cache {
    fetched_at: None,
    usage: None,
});

#[tauri::command(async)]
pub async fn codex_usage() -> Option<AgentUsage> {
    let mut cache = CACHE.lock().await;
    if cache
        .fetched_at
        .is_none_or(|at| at.elapsed() >= Duration::from_secs(180))
    {
        cache.usage = tokio::time::timeout(Duration::from_secs(10), read_usage())
            .await
            .ok()
            .flatten();
        cache.fetched_at = Some(Instant::now());
    }
    cache.usage.clone()
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

async fn read_usage() -> Option<AgentUsage> {
    let mut command = Command::new(codex_path()?);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = command.spawn().ok()?;
    let mut input = child.stdin.take()?;
    let mut output = BufReader::new(child.stdout.take()?).lines();
    let initialize = json!({
        "id": 1,
        "method": "initialize",
        "params": { "clientInfo": { "name": "gitpervisor", "version": env!("CARGO_PKG_VERSION") } }
    });
    input
        .write_all(format!("{initialize}\n").as_bytes())
        .await
        .ok()?;

    while let Some(line) = output.next_line().await.ok()? {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match message["id"].as_u64() {
            Some(1) if message.get("result").is_some() => {
                input
                    .write_all(b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/rateLimits/read\"}\n")
                    .await
                    .ok()?;
            }
            Some(1) => return None,
            Some(2) => return parse_usage(message.get("result")?),
            _ => {}
        }
    }
    None
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
