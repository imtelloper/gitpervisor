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

/// pub(crate): 작업 리포트(report.rs)가 같은 전사 경로 규약을 쓴다.
pub(crate) fn home_dir() -> Option<PathBuf> {
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

// ── 작업 완료 알림 본문: 마지막 AI 메시지 ─────────────────────────────────────

/// 프로젝트 cwd → Claude Code 트랜스크립트 디렉토리명(경로 구분자·콜론·점을 `-`로).
/// 예: `C:\Users\a\proj` → `C--Users-a-proj` (Claude Code 규약).
/// pub(crate): 작업 리포트(report.rs)의 프롬프트 수집이 같은 규약을 쓴다.
pub(crate) fn encode_project_dir(path: &str) -> String {
    path.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '.') { '-' } else { c })
        .collect()
}

/// 알림 본문용 요약 — 앞부분(약 220자)만 잘라 말줄임. 줄 끝 공백은 정리.
fn snippet(s: &str) -> String {
    let collapsed = s
        .split('\n')
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");
    let mut out: String = collapsed.chars().take(220).collect();
    if collapsed.chars().count() > 220 {
        out.push('…');
    }
    out
}

/// 프로젝트의 마지막 AI(assistant) 텍스트 메시지 — 작업 완료 알림 본문용. 최신 세션 트랜스크립트
/// (`~/.claude/projects/<encoded>/<newest>.jsonl`)의 끝에서부터 첫 assistant 텍스트를 뽑아 요약한다.
/// 트랜스크립트 없음·파싱 실패면 None(알림은 기본 문구로 폴백).
///
/// **async + 끝에서부터 읽기.** 예전엔 동기 커맨드(= UI 스레드)가 트랜스크립트를 통째로 읽었다 —
/// 파일이 11~32MB 라 에이전트가 끝날 때마다 UI 스레드가 수십 MB 를 할당·파싱했고, 메모리가 빠듯하면
/// 창 응답이 멈출 수 있었다(2026-09-17 설치본 멈춤 조사에서 후보로 꼽힘). 답은 거의 항상 마지막 몇 줄이다.
#[tauri::command(async)]
pub fn last_agent_message(project_path: String) -> Option<String> {
    let dir = home_dir()?
        .join(".claude")
        .join("projects")
        .join(encode_project_dir(&project_path));
    // 이 프로젝트의 세션 중 가장 최근에 수정된 트랜스크립트(방금 끝난 세션).
    let newest = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |x| x == "jsonl"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))?
        .path();
    scan_lines_from_end(&newest, assistant_snippet)
}

/// 트랜스크립트 한 줄이 텍스트가 있는 assistant 메시지면 그 요약.
fn assistant_snippet(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    let text = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| {
                    if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                        b.get("text").and_then(|t| t.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    let text = text.trim();
    (!text.is_empty()).then(|| snippet(text))
}

/// 파일을 **끝에서부터** 한 줄씩(뒤→앞) `f` 에 넘기고 처음 `Some` 을 돌려준다. 64KB 블록으로 거꾸로
/// 읽으므로 답이 끝 근처에 있으면 파일 크기와 무관하게 몇 블록만 읽는다. 블록 경계에 걸친 줄은 앞
/// 블록과 이어 붙인 뒤에야 넘긴다(한 줄이 수 MB 인 tool_result 도 온전히 한 줄로 본다).
fn scan_lines_from_end<T>(
    path: &std::path::Path,
    mut f: impl FnMut(&str) -> Option<T>,
) -> Option<T> {
    use std::io::{Read, Seek, SeekFrom};
    const BLOCK: u64 = 64 * 1024;
    // 이보다 긴 줄(수십 MB tool_result)은 통째로 건너뛴다 — 블록마다 이어 붙이면 복사가 줄 길이의 제곱으로
    // 늘고, 프론트 시한(3s)이 지나도 Rust 쪽은 계속 돈다. assistant 텍스트 줄은 이만큼 크지 않다.
    const MAX_LINE: usize = 8 * 1024 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let mut pos = file.metadata().ok()?.len();
    // 아직 줄머리를 못 본 조각(파일의 더 뒤쪽 바이트). 줄바꿈이 없음이 보장된다.
    let mut carry: Vec<u8> = Vec::new();
    // 너무 긴 줄의 앞부분을 버리는 중 — 그 줄의 머리(앞 줄바꿈)를 찾을 때까지 바이트를 모으지 않는다.
    let mut skipping = false;
    loop {
        let start = pos.saturating_sub(BLOCK);
        let mut buf = vec![0u8; (pos - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut buf).ok()?;
        // 줄바꿈은 새로 읽은 블록 안에만 있다(carry 에는 없다) — 거기만 훑는다.
        let mut search_end = buf.len();
        let mut end = if skipping { buf.len() } else { buf.extend_from_slice(&carry); buf.len() };
        let mut first = true;
        while let Some(nl) = buf[..search_end].iter().rposition(|&b| b == b'\n') {
            if !(skipping && first) {
                let line = std::str::from_utf8(&buf[nl + 1..end]).unwrap_or("");
                if let Some(hit) = f(line.trim_end_matches('\r')) {
                    return Some(hit);
                }
            }
            first = false;
            skipping = false;
            end = nl;
            search_end = nl;
        }
        if start == 0 {
            // 파일 첫 줄 — 앞에 줄바꿈이 없다.
            if skipping {
                return None;
            }
            let line = std::str::from_utf8(&buf[..end]).unwrap_or("");
            return f(line.trim_end_matches('\r'));
        }
        if skipping || end > MAX_LINE {
            skipping = true;
            carry.clear();
        } else {
            buf.truncate(end);
            carry = buf;
        }
        pos = start;
    }
}

#[cfg(test)]
mod tail_tests {
    use super::*;

    #[test]
    fn scan_lines_from_end_matches_whole_file_reverse_across_blocks() {
        let dir = std::env::temp_dir().join(format!("gpv-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        // 블록(64KB) 경계를 여러 번 넘도록: 긴 줄(200KB) + CRLF 줄 + 한글 + 마지막 줄 개행 없음.
        let long = "x".repeat(200_000);
        let lines = vec![
            "first".to_string(),
            long.clone(),
            "가나다\r".to_string(),
            "mid".to_string(),
            long,
            "last-no-newline".to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let mut seen = Vec::new();
        let none: Option<()> = scan_lines_from_end(&path, |l| {
            seen.push(l.to_string());
            None
        });
        assert!(none.is_none());
        let want: Vec<String> = lines.iter().rev().map(|l| l.trim_end_matches('\r').to_string()).collect();
        assert_eq!(seen, want, "전체를 뒤에서부터 한 줄씩, 경계 조각 없이");

        // 처음 Some 에서 멈춘다 — 더 앞 줄은 읽지 않는다.
        let mut visited = 0;
        let hit = scan_lines_from_end(&path, |l| {
            visited += 1;
            (l == "mid").then(|| l.to_string())
        });
        assert_eq!(hit.as_deref(), Some("mid"));
        assert_eq!(visited, 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_lines_from_end_skips_lines_longer_than_cap() {
        let dir = std::env::temp_dir().join(format!("gpv-tail-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let huge = "y".repeat(9 * 1024 * 1024); // MAX_LINE(8MB) 초과
        std::fs::write(&path, format!("before\n{huge}\nafter")).unwrap();
        let mut seen = Vec::new();
        let none: Option<()> = scan_lines_from_end(&path, |l| {
            seen.push(if l.len() > 16 { format!("<{}B>", l.len()) } else { l.to_string() });
            None
        });
        assert!(none.is_none());
        // 초대형 줄은 건너뛰고 그 앞뒤 줄은 온전히 본다.
        assert_eq!(seen, vec!["after".to_string(), "before".to_string()]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn assistant_snippet_picks_text_blocks_only() {
        let a = r#"{"type":"assistant","message":{"content":[{"type":"tool_use"},{"type":"text","text":"완료했습니다"}]}}"#;
        let u = r#"{"type":"user","message":{"content":[{"type":"text","text":"x"}]}}"#;
        let t = r#"{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}"#;
        assert_eq!(assistant_snippet(a).as_deref(), Some("완료했습니다"));
        assert_eq!(assistant_snippet(u), None);
        assert_eq!(assistant_snippet(t), None);
        assert_eq!(assistant_snippet("not json"), None);
    }
}
