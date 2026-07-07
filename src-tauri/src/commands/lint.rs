// 실전 린트 마커 (태스크 16) — ruff check(py) / biome lint(웹). 실파일을 도구로 린트해
// JSON을 정규화한 진단을 반환한다(프론트가 Monaco 마커로 표시). 15 러너 계약 재사용.
// 도구 미설치·파싱 실패·타임아웃은 조용히 tool:None(앱은 절대 깨지지 않는다 — find_definition 관례).

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::IpcError;
use crate::state::AppState;
use crate::tools::runner::{self, Tool};

const MAX_DIAGS: usize = 500;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LintDiag {
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub code: Option<String>,
    pub message: String,
    pub severity: String, // "error"|"warning"|"info"|"hint"
    pub url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintReport {
    pub tool: Option<String>, // None = 비대상 확장자/미설치/실패 → 프론트 no-op
    pub diags: Vec<LintDiag>,
    pub truncated: bool,
}

fn empty_report() -> LintReport {
    LintReport {
        tool: None,
        diags: Vec::new(),
        truncated: false,
    }
}

#[tauri::command]
pub async fn lint_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    // 에디터 버퍼 내용(있으면 ruff는 stdin으로 실시간 린트 — 저장 전 on-type). None이면 디스크.
    content: Option<String>,
) -> Result<LintReport, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 경로 탈출·.git 우회 차단(잘못된 경로만 Err — 나머지 실패는 조용히 tool:None).
    resolve_in_repo(&repo, &rel_path)?;
    let ext = rel_path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let tool = match ext.as_str() {
        "py" | "pyi" => Tool::Ruff,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Tool::Biome,
        _ => return Ok(empty_report()),
    };

    let settings = state.settings.read().unwrap().clone();
    let explicit = match tool {
        Tool::Ruff => settings.formatter_ruff_path.as_deref(),
        Tool::Biome => settings.formatter_biome_path.as_deref(),
    };
    let bundled = runner::bundled_tools_dir(&app);
    let Some(bin) = runner::discover(
        tool,
        &repo,
        explicit,
        settings.formatter_project_local,
        bundled.as_deref(),
    ) else {
        return Ok(empty_report()); // 미설치 — 침묵 스킵
    };

    // 경로 인자는 선행 `-` 중화(`./` 접두)로 플래그 오파싱 방지.
    let path_arg = format!("./{rel_path}");
    // ruff는 stdin(버퍼) 린트를 JSON으로 지원 → content 있으면 on-type(저장 전) 린트.
    // biome는 stdin JSON이 깨져서(내용만 에코) 디스크 파일 린트만 — 저장 후 반영.
    let out = match tool {
        Tool::Ruff => {
            if let Some(buf) = content.as_deref() {
                let args = [
                    "check",
                    "--output-format",
                    "json",
                    "--no-cache",
                    "--quiet",
                    "--stdin-filename",
                    &rel_path,
                    "-",
                ];
                runner::run_tool_stdin(&bin, &args, buf.as_bytes(), Some(&repo), 10).await
            } else {
                let args = [
                    "check",
                    "--output-format",
                    "json",
                    "--no-cache",
                    "--quiet",
                    &path_arg,
                ];
                runner::run_tool(&bin, &args, Some(&repo), 10).await
            }
        }
        Tool::Biome => {
            let args = ["lint", "--reporter=json", &path_arg];
            runner::run_tool(&bin, &args, Some(&repo), 10).await
        }
    };
    let out = match out {
        Ok(o) => o,
        Err(_) => return Ok(empty_report()), // spawn 실패·타임아웃 침묵
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let diags = match tool {
        Tool::Ruff => parse_ruff_json(&stdout),
        Tool::Biome => parse_biome_json(&stdout),
    };
    let Some(mut diags) = diags else {
        return Ok(empty_report()); // JSON 파싱 불가 침묵
    };
    let truncated = diags.len() > MAX_DIAGS;
    diags.truncate(MAX_DIAGS);
    Ok(LintReport {
        tool: Some(if tool == Tool::Ruff { "ruff" } else { "biome" }.to_string()),
        diags,
        truncated,
    })
}

/// ruff `check --output-format json` 출력 파싱. 배열 형태. 좌표는 1-based(row/column).
/// 파싱 실패면 None(침묵).
fn parse_ruff_json(s: &str) -> Option<Vec<LintDiag>> {
    let s = s.trim();
    if s.is_empty() {
        return Some(Vec::new()); // 위반 없음
    }
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        let loc = &item["location"];
        let end = &item["end_location"];
        let line = loc["row"].as_u64().unwrap_or(1) as u32;
        let column = loc["column"].as_u64().unwrap_or(1) as u32;
        let end_line = end["row"].as_u64().unwrap_or(line as u64) as u32;
        let end_column = end["column"].as_u64().unwrap_or(column as u64) as u32;
        let code = item["code"].as_str().map(|c| c.to_string());
        let message = item["message"].as_str().unwrap_or("").to_string();
        // ruff JSON은 severity 필드를 준다(구문 오류=error). 없으면 폴백: invalid-syntax/E999/null
        // → error, 그 외 → warning(스타일·버그 혼재를 전부 빨간색으로 도배하지 않게).
        let severity = match item["severity"].as_str() {
            Some("error") => "error",
            Some("warning") => "warning",
            Some("info") | Some("information") => "info",
            _ => {
                let is_syntax = matches!(code.as_deref(), None | Some("invalid-syntax") | Some("E999"));
                if is_syntax { "error" } else { "warning" }
            }
        }
        .to_string();
        out.push(LintDiag {
            line,
            column,
            end_line,
            end_column,
            code,
            message,
            severity,
            url: item["url"].as_str().map(|u| u.to_string()),
        });
    }
    Some(out)
}

/// biome `lint --reporter=json` 출력 파싱. `{ diagnostics: [{ location:{ start:{line,column},
/// end:{line,column} }, severity, category, description }] }` (실측 2.5.2 — line/column 1-based
/// 직접 제공). 스키마가 예상과 다르면 None(침묵)으로 안전 강등.
fn parse_biome_json(s: &str) -> Option<Vec<LintDiag>> {
    let s = s.trim();
    if s.is_empty() {
        return Some(Vec::new());
    }
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let arr = v["diagnostics"].as_array()?;
    let mut out = Vec::new();
    for d in arr {
        let category = d["category"].as_str().map(|c| c.to_string());
        // 메시지: description 또는 message(버전 차이 방어).
        let message = d["description"]
            .as_str()
            .or_else(|| d["message"].as_str())
            .unwrap_or("")
            .to_string();
        let severity = match d["severity"].as_str() {
            Some("fatal") | Some("error") => "error",
            Some("warning") => "warning",
            Some("information") | Some("info") => "info",
            Some("hint") => "hint",
            _ => "warning",
        }
        .to_string();
        let loc = &d["location"];
        let line = loc["start"]["line"].as_u64().unwrap_or(1) as u32;
        let column = loc["start"]["column"].as_u64().unwrap_or(1) as u32;
        let end_line = loc["end"]["line"].as_u64().unwrap_or(line as u64) as u32;
        let end_column = loc["end"]["column"].as_u64().unwrap_or(column as u64) as u32;
        out.push(LintDiag {
            line,
            column,
            end_line,
            end_column,
            code: category,
            message,
            severity,
            url: None,
        });
    }
    Some(out)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ruff_json_basic() {
        let json = r#"[
          {"code":"F401","message":"`os` imported but unused",
           "location":{"row":1,"column":8},"end_location":{"row":1,"column":10},
           "url":"https://docs.astral.sh/ruff/rules/unused-import"}
        ]"#;
        let diags = parse_ruff_json(json).unwrap();
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].line, 1);
        assert_eq!(diags[0].column, 8);
        assert_eq!(diags[0].code.as_deref(), Some("F401"));
        assert_eq!(diags[0].severity, "warning");
        assert!(diags[0].url.is_some());
    }

    #[test]
    fn ruff_json_syntax_error_is_error_severity() {
        // 구문 오류는 severity 필드가 "error" → 빨간색(Error)이어야 한다.
        let json = r#"[
          {"code":"invalid-syntax","name":"invalid-syntax","severity":"error",
           "message":"Simple statements must be separated by newlines or semicolons",
           "location":{"row":4,"column":50},"end_location":{"row":4,"column":51},"url":null}
        ]"#;
        let diags = parse_ruff_json(json).unwrap();
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].severity, "error");
        assert_eq!(diags[0].line, 4);
        assert_eq!(diags[0].column, 50);
    }

    #[test]
    fn ruff_json_empty_no_violations() {
        assert_eq!(parse_ruff_json("").unwrap().len(), 0);
        assert_eq!(parse_ruff_json("[]").unwrap().len(), 0);
    }

    #[test]
    fn ruff_json_garbage_is_none() {
        assert!(parse_ruff_json("not json").is_none());
    }

    #[test]
    fn biome_json_uses_start_end_line_column() {
        // 실측 구조: location.start/end.{line,column} (byte span 아님).
        let json = r#"{"summary":{},"diagnostics":[
          {"severity":"warning","category":"lint/correctness/noUnusedVariables",
           "description":"This variable y is unused.",
           "location":{"path":"x.ts","start":{"line":2,"column":21},"end":{"line":2,"column":22}}}
        ]}"#;
        let diags = parse_biome_json(json).unwrap();
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].line, 2);
        assert_eq!(diags[0].column, 21);
        assert_eq!(diags[0].end_column, 22);
        assert_eq!(diags[0].severity, "warning");
        assert_eq!(diags[0].code.as_deref(), Some("lint/correctness/noUnusedVariables"));
    }

    #[test]
    fn biome_json_empty_and_garbage() {
        assert_eq!(parse_biome_json(r#"{"diagnostics":[]}"#).unwrap().len(), 0);
        assert!(parse_biome_json("not json").is_none());
    }
}
