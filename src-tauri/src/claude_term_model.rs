//! 터미널마다 지금 도는 Claude 의 모델·effort — 칸 헤더 칩(사용자 요청 2026-11-17: 상태줄을 꺼도 세션마다 보이게).
//! 어느 터미널의 어느 세션인지는 `claude_resume` 의 프로세스 계보 매핑을 그대로 쓰고, 모델·effort 는 전사 끝쪽
//! assistant 줄(`message.model`·`effort`)에서 읽는다. ultracode 판정은 `~/.claude/statusline.js` 와 같은 규칙이다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::claude_usage::{claude_config_dir, scan_lines_from_end};
use crate::error::IpcError;
use crate::state::AppState;

/// 상태줄과 같은 창. ponytail: 이보다 앞의 ultracode 전환 마커는 놓치고 설정 시드를 쓴다 — 문제 되면 넓혀라.
const TAIL_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTermModel {
    /// `Opus 5.5` 꼴.
    pub model: String,
    pub model_id: String,
    /// `low`…`max`, ultracode 가 켜져 실효가 xhigh 면 `ultracode`. 옛 Claude 는 전사에 안 적는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// termId → 그 터미널에서 지금 도는 Claude 의 모델. Claude 가 없거나 아직 응답 전이면 키가 없다.
#[tauri::command(async)]
pub fn claude_term_models(state: State<'_, AppState>) -> Result<BTreeMap<String, ClaudeTermModel>, IpcError> {
    let live = crate::claude_resume::live_claude_by_term(&crate::commands::term_shell_pids(state.inner()));
    let Some(root) = claude_config_dir().filter(|_| !live.is_empty()) else { return Ok(BTreeMap::new()) };
    let seed = ultracode_seed(&root);
    let projects = root.join("projects");
    Ok(live
        .into_iter()
        .filter_map(|(term, rec)| Some((term, read_tail(&transcript_path(&projects, &rec.session_id)?, seed)?)))
        .collect())
}

/// 전사는 `projects/<인코딩된 cwd>/<id>.jsonl` — 인코딩 규칙을 흉내 내지 않고 폴더를 훑는다(수십 개, stat 만).
fn transcript_path(projects: &Path, session_id: &str) -> Option<PathBuf> {
    // 레지스트리 파일에서 온 값이다 — 경로 조각이 섞여 있으면 폴더 밖을 가리킨다.
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    std::fs::read_dir(projects).ok()?.flatten().map(|d| d.path().join(&file)).find(|p| p.is_file())
}

/// settings 의 `"ultracode": true` 는 세션 시작 시드다 — 전사에 전환 마커가 없을 때만 쓴다.
fn ultracode_seed(root: &Path) -> bool {
    std::fs::read(root.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["ultracode"] == Value::Bool(true))
}

fn read_tail(path: &Path, seed: bool) -> Option<ClaudeTermModel> {
    let (mut seen, mut found, mut ultra) = (0usize, None, None);
    scan_lines_from_end(path, |line| {
        seen += line.len() + 1;
        if found.is_none() {
            found = assistant_model(line);
        }
        if ultra.is_none() {
            ultra = ultra_marker(line);
        }
        ((found.is_some() && ultra.is_some()) || seen > TAIL_BYTES).then_some(())
    });
    let (model_id, effort) = found?;
    Some(term_model(model_id, effort, ultra.unwrap_or(seed)))
}

/// 맨 따옴표 `"type":"assistant"` 는 JSON 구조에만 나온다(문자열 안의 따옴표는 `\"`) — 그런 줄만 파싱한다.
fn assistant_model(line: &str) -> Option<(String, Option<String>)> {
    if !line.contains(r#""type":"assistant""#) {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    // `<synthetic>` 은 API 오류 등으로 Claude Code 가 지어낸 줄이다.
    let model = v["message"]["model"].as_str().filter(|m| !m.starts_with('<'))?;
    Some((model.to_string(), v["effort"].as_str().map(str::to_string)))
}

fn ultra_marker(line: &str) -> Option<bool> {
    if line.contains(r#""type":"ultra_effort_enter""#) {
        Some(true)
    } else if line.contains(r#""type":"ultra_effort_exit""#) {
        Some(false)
    } else {
        None
    }
}

/// ultracode 는 실효 effort 가 xhigh 일 때만 켜진다(상태줄 주석: CC 의 판정이 flag && xhigh).
fn term_model(model_id: String, effort: Option<String>, ultra: bool) -> ClaudeTermModel {
    let effort = effort.map(|e| if ultra && e == "xhigh" { "ultracode".to_string() } else { e });
    ClaudeTermModel { model: display_model(&model_id), model_id, effort }
}

/// `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`. 모르는 꼴은 id 그대로.
fn display_model(id: &str) -> String {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let parts: Vec<&str> = id.strip_prefix("claude-").unwrap_or(id).split('-').collect();
    match parts.as_slice() {
        [family, major, rest @ ..] if !family.is_empty() && family.bytes().all(|b| b.is_ascii_alphabetic()) && digits(major) => {
            let mut name = family[..1].to_ascii_uppercase() + &family[1..];
            name.push(' ');
            name.push_str(major);
            // 8자리는 날짜 꼬리다.
            if let Some(minor) = rest.first().filter(|m| digits(m) && m.len() <= 2) {
                name.push('.');
                name.push_str(minor);
            }
            name
        }
        _ => id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_term_model_display_names() {
        assert_eq!(display_model("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(display_model("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(display_model("claude-opus-4-20250514"), "Opus 4");
        assert_eq!(display_model("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022");
    }

    #[test]
    fn claude_term_model_reads_last_assistant_and_ultracode() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let lines = [
            r#"{"type":"assistant","message":{"model":"claude-sonnet-4-5"},"effort":"high"}"#,
            r#"{"type":"attachment","attachment":{"type":"ultra_effort_enter"}}"#,
            r#"{"type":"assistant","message":{"model":"claude-opus-5-5"},"effort":"xhigh"}"#,
            r#"{"type":"assistant","message":{"model":"<synthetic>"}}"#,
            // 도구 출력 안에 든 마커 글자는 이스케이프돼 있어 세지 않는다.
            r#"{"type":"user","message":{"content":"{\"type\":\"ultra_effort_exit\"}"}}"#,
        ];
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let m = read_tail(&p, false).unwrap();
        assert_eq!((m.model.as_str(), m.effort.as_deref()), ("Opus 5.5", Some("ultracode")));
        // 마커가 없으면 시드, xhigh 가 아니면 ultracode 가 아니다.
        std::fs::write(&p, format!("{}\n", lines[0])).unwrap();
        assert_eq!(read_tail(&p, true).unwrap().effort.as_deref(), Some("high"));
    }

    #[test]
    fn claude_term_model_rejects_path_like_session_ids() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(transcript_path(dir.path(), "../x"), None);
        assert_eq!(transcript_path(dir.path(), ""), None);
    }
}
