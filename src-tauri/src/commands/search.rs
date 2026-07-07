// 전역 코드 검색 (Find in Files) — git grep 기반. find_definition의 관례(입력 검증 → -e 패턴
// → -- pathspec → 캡 절단 → forward-slash)를 그대로 따른다. 리터럴은 -F(이스케이프 불필요),
// 정규식은 -P(PCRE). 결과는 파일별 그룹핑 + 3중 캡(-m 파일당 · 총 500 · 라인 240자 윈도우).

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,   // 1-based
    pub column: u32, // 1-based, 문자 단위(text 윈도우 기준)
    pub text: String, // 매치 라인(매치 중심 최대 240자 윈도우, lossy UTF-8)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub path: String, // 레포 상대·forward-slash
    pub matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub files: Vec<SearchFile>,
    pub total_matches: u32,
    pub truncated: bool,
}

const MAX_TOTAL: usize = 500; // 파싱 총 매치 캡
const TEXT_WINDOW: usize = 240; // 라인 텍스트 윈도우(문자)
const MAX_INCLUDE: usize = 8;

/// git grep 기반 전역 검색. exit 1=무매치(빈 결과)·exit>1=GIT_ERROR(잘못된 정규식 등).
#[tauri::command]
pub async fn search_in_project(
    state: State<'_, AppState>,
    project_id: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
    include: Vec<String>,
) -> Result<SearchResult, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 2..=512자 — 1자는 전량 매치 유발.
    let qlen = query.chars().count();
    if qlen < 2 || qlen > 512 {
        return Ok(SearchResult {
            files: Vec::new(),
            total_matches: 0,
            truncated: false,
        });
    }
    // include 글롭 검증 — 절대경로·`..`·선행 `:`(pathspec 매직) 거부, 개수 캡.
    let globs: Vec<String> = include
        .into_iter()
        .filter(|g| {
            !g.is_empty()
                && !g.starts_with(':')
                && !g.starts_with('/')
                && !g.starts_with('\\')
                && !g.contains("..")
                && !(g.len() >= 2 && g.as_bytes()[1] == b':') // 드라이브(C:)
        })
        .take(MAX_INCLUDE)
        .collect();

    let mut args: Vec<&str> = vec!["grep", "-n", "--column", "--no-color", "-I", "--untracked"];
    args.push(if regex { "-P" } else { "-F" });
    if !case_sensitive {
        args.push("-i");
    }
    if whole_word {
        args.push("-w");
    }
    args.push("-m");
    args.push("50"); // 파일당 최대(미니파이·락파일 폭주 차단)
    args.push("-e");
    args.push(&query);
    if !globs.is_empty() {
        args.push("--");
        for g in &globs {
            args.push(g);
        }
    }

    let out = runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await?;
    // exit 1 = 무매치(정상). exit >1 = 오류(잘못된 정규식 등).
    if out.code > 1 {
        let msg = if out.stderr.trim().is_empty() {
            "검색 실패".to_string()
        } else {
            out.stderr.trim().to_string()
        };
        return Err(IpcError::new(ErrorCode::GitError, msg));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);

    let mut files: Vec<SearchFile> = Vec::new();
    let mut total: usize = 0;
    let mut truncated = false;
    for line in stdout.lines() {
        if total >= MAX_TOTAL {
            truncated = true;
            break;
        }
        // 형식: <path>:<line>:<col>:<text> (상대경로는 ':'를 안 가짐)
        let mut it = line.splitn(4, ':');
        let (Some(path), Some(ln), Some(col), Some(text)) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        let (Ok(line_no), Ok(col_no)) = (ln.parse::<u32>(), col.parse::<u32>()) else {
            continue;
        };
        let rel = path.replace('\\', "/");
        // 매치 중심 240자 윈도우 — 미니파이 1줄 수 MB가 IPC를 타지 않게. 열도 윈도우 기준 재계산.
        let (win_text, win_col) = window_line(text, col_no);
        let m = SearchMatch {
            line: line_no,
            column: win_col,
            text: win_text,
        };
        // git grep 출력은 파일 순서라 마지막 파일과 같으면 이어붙인다.
        match files.last_mut() {
            Some(f) if f.path == rel => f.matches.push(m),
            _ => files.push(SearchFile {
                path: rel,
                matches: vec![m],
            }),
        }
        total += 1;
    }

    Ok(SearchResult {
        files,
        total_matches: total as u32,
        truncated,
    })
}

/// 긴 라인을 매치 열 중심 최대 240자 윈도우로 자른다. col_no는 원본 1-based 바이트 열(grep --column).
/// 반환 (윈도우 텍스트, 윈도우 기준 1-based 문자 열).
fn window_line(text: &str, col_no: u32) -> (String, u32) {
    let chars: Vec<char> = text.chars().collect();
    // grep --column은 바이트 열 — 대략적 문자 인덱스로 환산(ASCII면 동일, 멀티바이트는 근사).
    let byte_col = (col_no.saturating_sub(1)) as usize;
    let mut char_idx = 0;
    let mut acc = 0;
    for (i, c) in chars.iter().enumerate() {
        if acc >= byte_col {
            char_idx = i;
            break;
        }
        acc += c.len_utf8();
        char_idx = i + 1;
    }
    if chars.len() <= TEXT_WINDOW {
        return (text.to_string(), char_idx as u32 + 1);
    }
    // 매치를 윈도우 안에 넣되 앞쪽 여유 40자
    let start = char_idx.saturating_sub(40);
    let end = (start + TEXT_WINDOW).min(chars.len());
    let slice: String = chars[start..end].iter().collect();
    let prefix = if start > 0 { "…" } else { "" };
    let new_col = (char_idx - start) as u32 + 1 + prefix.chars().count() as u32;
    (format!("{prefix}{slice}"), new_col)
}
