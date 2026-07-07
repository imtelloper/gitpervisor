// 포매터 통합 (태스크 15) — ruff format(py) / biome(웹). 뷰어의 dirty 내용을 stdin으로
// 도구에 넘겨 포맷 결과를 돌려받는다(파일 미저장). 결과는 프론트가 Monaco 전체범위 edit로
// 적용 → 최소 edit·undo·스크롤은 Monaco가 처리한다. 외부 도구 러너(tools::runner) 재사용.

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;
use crate::tools::runner::{self, Tool, ToolBin};

const MAX_FORMAT_BYTES: usize = 1_572_864; // 뷰어 1.5MB 상한 미러

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    pub formatted: Option<String>, // changed=false면 None(왕복 페이로드 절약)
    pub changed: bool,
    pub tool: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub tool: String,
    pub found: bool,
    pub path: Option<String>,
    pub source: Option<String>,
    pub version: Option<String>,
}

/// 확장자 → 포맷 도구. 미지원 확장자는 None.
fn tool_for_ext(ext: &str) -> Option<Tool> {
    match ext.to_ascii_lowercase().as_str() {
        "py" | "pyi" => Some(Tool::Ruff),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "json" | "jsonc" | "css" => Some(Tool::Biome),
        _ => None,
    }
}

fn explicit_path<'a>(tool: Tool, s: &'a crate::git::types::Settings) -> Option<&'a str> {
    match tool {
        Tool::Ruff => s.formatter_ruff_path.as_deref(),
        Tool::Biome => s.formatter_biome_path.as_deref(),
    }
}

#[tauri::command]
pub async fn format_source(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    content: String,
) -> Result<FormatResult, IpcError> {
    if content.len() > MAX_FORMAT_BYTES {
        return Err(IpcError::new(ErrorCode::Io, "파일이 너무 커서 포맷할 수 없습니다"));
    }
    let repo = project_path(&state, &project_id)?;
    // 경로 컨테인먼트 검증(traversal 차단) — 내용은 stdin, 경로는 도구 언어 힌트로만 쓴다.
    resolve_in_repo(&repo, &rel_path)?;
    let ext = rel_path.rsplit('.').next().unwrap_or("");
    let Some(tool) = tool_for_ext(ext) else {
        return Ok(FormatResult {
            formatted: None,
            changed: false,
            tool: String::new(),
        });
    };

    let settings = state.settings.read().unwrap().clone();
    let bundled = runner::bundled_tools_dir(&app);
    let bin = runner::discover(
        tool,
        &repo,
        explicit_path(tool, &settings),
        settings.formatter_project_local,
        bundled.as_deref(),
    )
    .ok_or_else(|| {
        let name = if tool == Tool::Ruff { "ruff" } else { "biome" };
        IpcError::new(
            ErrorCode::ToolNotFound,
            format!("{name}이(가) 설치되어 있지 않습니다 — 설정에서 경로를 지정하거나 설치하세요"),
        )
    })?;

    // 도구별 stdin 포맷 인자. 파일명은 언어·설정 판별 힌트.
    let args: Vec<String> = match tool {
        Tool::Ruff => vec![
            "format".into(),
            "--stdin-filename".into(),
            rel_path.clone(),
            "-".into(),
        ],
        Tool::Biome => vec![
            "format".into(),
            format!("--stdin-file-path={rel_path}"),
        ],
    };
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = runner::run_tool_stdin(&bin, &arg_refs, content.as_bytes(), Some(&repo), 10).await?;
    if out.code != 0 {
        let msg = if out.stderr.trim().is_empty() {
            "포맷 실패".to_string()
        } else {
            out.stderr.trim().to_string()
        };
        return Err(IpcError::new(ErrorCode::Io, msg));
    }
    let formatted = String::from_utf8_lossy(&out.stdout).into_owned();
    let tool_name = if tool == Tool::Ruff { "ruff" } else { "biome" }.to_string();
    if formatted == content {
        return Ok(FormatResult {
            formatted: None,
            changed: false,
            tool: tool_name,
        });
    }
    Ok(FormatResult {
        formatted: Some(formatted),
        changed: true,
        tool: tool_name,
    })
}

/// 포맷 도구 발견 상태 — 설정 UI "설치됨 ✓ (경로)" + E2E 게이트.
#[tauri::command]
pub async fn format_tool_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ToolStatus>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    let settings = state.settings.read().unwrap().clone();
    let bundled = runner::bundled_tools_dir(&app);
    let mut out = Vec::new();
    for (tool, name) in [(Tool::Ruff, "ruff"), (Tool::Biome, "biome")] {
        let bin = runner::discover(
            tool,
            &repo,
            explicit_path(tool, &settings),
            settings.formatter_project_local,
            bundled.as_deref(),
        );
        out.push(match bin {
            Some(b) => ToolStatus {
                tool: name.to_string(),
                found: true,
                path: Some(b.path.to_string_lossy().into_owned()),
                source: Some(b.source.as_str().to_string()),
                version: tool_version(&b).await,
            },
            None => ToolStatus {
                tool: name.to_string(),
                found: false,
                path: None,
                source: None,
                version: None,
            },
        });
    }
    Ok(out)
}

async fn tool_version(bin: &ToolBin) -> Option<String> {
    let out = runner::run_tool(bin, &["--version"], None, 5).await.ok()?;
    if out.code == 0 {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}
