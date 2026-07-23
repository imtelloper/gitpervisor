//! Claude 사용량(rate_limits) — 좌측 하단 상태바의 usage 바.
//!
//! 사용률(%)은 Claude Code가 statusline 스크립트 stdin으로만 넘겨주는 값이라 직접 읽을 API·파일이
//! 없다. 그래서 사용자의 `~/.claude/statusline.js`가 매 갱신 시 rate_limits를
//! `~/.claude/gitpervisor-usage.json`으로 떨궈두고(그 다리는 statusline.js에 있음), 여기서 그 파일을
//! 읽어 파싱해 돌려준다. 파일이 없거나(다리 미설치·Claude Code 미사용) 파싱 실패면 None.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 한 사용량 창(5시간·주간·모델별 등) — 사용률%와 리셋 시각(epoch초).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// 원본 키 (five_hour / seven_day / seven_day_opus …) — 프론트가 라벨 매핑에 사용.
    pub key: String,
    pub used_percentage: f32,
    /// 리셋까지 남은 시간 계산용 epoch초. 없으면 시간 대신 키 라벨을 보인다.
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    pub windows: Vec<UsageWindow>,
    /// 파일이 마지막으로 갱신된 epoch초 — 프론트가 오래된 데이터를 숨기는 데 쓴다.
    pub updated_at: i64,
}

#[derive(Deserialize)]
struct WindowJson {
    used_percentage: Option<f32>,
    resets_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageFile {
    #[serde(default)]
    rate_limits: HashMap<String, WindowJson>,
    #[serde(default)]
    updated_at: i64,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// 표시 순서 — 세션(5h) → 주간(7d) → 모델별, 그 외는 뒤로.
const ORDER: &[&str] = &["five_hour", "seven_day", "seven_day_opus", "seven_day_oauth"];

/// 좌측 하단 usage 바가 폴링하는 커맨드. 파일 없음·파싱 실패면 None(바를 숨긴다).
#[tauri::command]
pub fn claude_usage() -> Option<ClaudeUsage> {
    let path = home_dir()?.join(".claude").join("gitpervisor-usage.json");
    let data = std::fs::read_to_string(&path).ok()?;
    let file: UsageFile = serde_json::from_str(&data).ok()?;

    let mut windows: Vec<UsageWindow> = file
        .rate_limits
        .into_iter()
        .filter_map(|(key, w)| {
            w.used_percentage.map(|p| UsageWindow {
                key,
                used_percentage: p,
                resets_at: w.resets_at,
            })
        })
        .collect();
    windows.sort_by_key(|w| ORDER.iter().position(|k| *k == w.key).unwrap_or(usize::MAX));
    Some(ClaudeUsage {
        windows,
        updated_at: file.updated_at,
    })
}
