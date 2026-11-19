//! 터미널마다 지금 도는 Claude 의 모델·effort — 칸 헤더 칩(사용자 요청 2026-11-17: 상태줄을 꺼도 세션마다 보이게).
//! 어느 터미널의 어느 세션인지는 `claude_resume` 의 프로세스 계보 매핑을 그대로 쓰고, 모델·effort 는 전사 끝쪽
//! assistant 줄(`message.model`·`effort`)에서 읽는다. ultracode 는 전사의 전환 마커(없으면 settings 시드)로 effort 와 따로 판정한다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::claude_usage::{claude_config_dir, scan_lines_from_end};
use crate::error::IpcError;
use crate::state::AppState;

/// ultracode 마커를 찾는 창(상태줄과 같다). ponytail: 이보다 앞의 전환 마커는 놓치고 설정 시드를 쓴다 — 문제 되면 넓혀라.
const TAIL_BYTES: usize = 256 * 1024;
/// 모델(assistant 줄)을 찾는 창은 더 넓다 — 압축(compact) 직후엔 다음 응답 전까지 skill·도구 목록·파일 첨부가
/// 수백 KB 붙어 마지막 assistant 줄이 256KB 밖으로 밀린다(2026-11-19 robomand 실측 271KB → 칩이 통째로 사라졌다).
/// 평소엔 assistant 줄이 끝 근처라 몇 블록만 읽고 멈춘다 — 이 끝까지 읽는 건 그런 칸뿐이다.
const MODEL_TAIL_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeTermModel {
    /// `Opus 5.5` 꼴.
    pub model: String,
    pub model_id: String,
    /// `low`…`max` — 전사에 적힌 그대로. 옛 Claude 는 전사에 안 적는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// effort 와 따로 — ultracode 는 effort 가 high 여도 켜져 있다(2026-11-19 사용자 지적: 예전엔 xhigh 일 때만 effort 자리에
    /// `ultracode` 로 바꿔 써서 high 세션은 ultracode 가 안 보였고, xhigh 세션은 effort 가 안 보였다).
    pub ultracode: bool,
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
        ((found.is_some() && (ultra.is_some() || seen > TAIL_BYTES)) || seen > MODEL_TAIL_BYTES).then_some(())
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

fn term_model(model_id: String, effort: Option<String>, ultracode: bool) -> ClaudeTermModel {
    ClaudeTermModel { model: display_model(&model_id), model_id, effort, ultracode }
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
        assert_eq!((m.model.as_str(), m.effort.as_deref(), m.ultracode), ("Opus 5.5", Some("xhigh"), true));
        // 마커가 없으면 시드 — effort 가 high 여도 ultracode 는 따로 켜져 보인다.
        std::fs::write(&p, format!("{}\n", lines[0])).unwrap();
        let m = read_tail(&p, true).unwrap();
        assert_eq!((m.effort.as_deref(), m.ultracode), (Some("high"), true));
        assert!(!read_tail(&p, false).unwrap().ultracode);
    }

    #[test]
    fn claude_term_model_survives_post_compact_attachments() {
        // 압축 직후 꼴: assistant 줄 뒤로 첨부만 256KB 넘게 쌓이고 아직 다음 응답이 없다.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let pad = format!(r#"{{"type":"attachment","attachment":{{"type":"skill_listing","content":"{}"}}}}"#, "x".repeat(60_000));
        let mut lines = vec![r#"{"type":"assistant","message":{"model":"claude-fable-5-2"},"effort":"xhigh"}"#.to_string()];
        lines.extend(std::iter::repeat(pad).take(6));
        lines.push(r#"{"type":"user","message":{"content":"다음 질문"}}"#.to_string());
        std::fs::write(&p, lines.join("
") + "
").unwrap();
        let m = read_tail(&p, false).expect("압축 뒤 첨부 360KB 너머의 assistant 줄을 찾아야 칩이 뜬다");
        assert_eq!((m.model.as_str(), m.effort.as_deref()), ("Fable 5.2", Some("xhigh")));
    }

    #[test]
    fn claude_term_model_rejects_path_like_session_ids() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(transcript_path(dir.path(), "../x"), None);
        assert_eq!(transcript_path(dir.path(), ""), None);
    }
}
