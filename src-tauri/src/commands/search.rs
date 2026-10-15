// 전역 코드 검색 (Find in Files) — git grep 기반. find_definition의 관례(입력 검증 → -e 패턴
// → -- pathspec → 캡 절단 → forward-slash)를 그대로 따른다. 리터럴은 -F(이스케이프 불필요),
// 정규식은 -P(PCRE). 결과는 파일별 그룹핑 + 3중 캡(-m 파일당 · 총 500 · 라인 240자 윈도우).

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::state::AppState;
use crate::text::encoding;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,   // 1-based
    pub column: u32, // 1-based, 문자 단위(text 윈도우 기준)
    pub text: String, // 매치 라인(매치 중심 최대 240자 윈도우, 줄 단위 인코딩 디코드)
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
/// git grep 종료 코드 판정 — 전역 검색과 코드 내비게이션(정의·심볼·참조)이 같이 쓴다.
/// exit 1 은 무매치(정상)다. 그 밖(128 = 저장소 아님, 2 = 잘못된 패턴·PCRE 없음, -1 = 신호로 죽음)은
/// 오류로 올린다 — 빈 결과로 바꾸면 "정의 없음"과 "찾지 못함"이 구분되지 않는다.
/// 프런트 console 은 로그 파일로 가지 않으므로 기록은 여기서 남긴다.
pub(crate) fn grep_output_or_error(
    repo: &std::path::Path,
    out: runner::GitOutput,
) -> Result<runner::GitOutput, IpcError> {
    if matches!(out.code, 0 | 1) {
        return Ok(out);
    }
    let stderr = out.stderr.trim();
    log::warn!("[grep] {} code={} {}", repo.display(), out.code, stderr);
    let msg = if stderr.is_empty() {
        crate::i18n::text_tools::search_failed().to_string()
    } else {
        stderr.to_string()
    };
    Err(IpcError::new(ErrorCode::GitError, msg))
}

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

    let out = grep_output_or_error(&repo, runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await?)?;
    // 줄 단위 디코드(B-K7) — 여러 파일의 줄이 섞인 스트림이라 통째 판정은 한 CP949 파일 때문에
    // 나머지 전부를 깨뜨린다. 뷰어에서는 한글이 보이는데 검색 결과만 깨지는 비대칭도 막는다.
    let stdout = encoding::decode_lines(&out.stdout);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn out(code: i32, stderr: &str) -> runner::GitOutput {
        runner::GitOutput { code, stdout: Vec::new(), stderr: stderr.into() }
    }

    #[test]
    fn grep_output_or_error_separates_no_match_from_failure() {
        let repo = std::path::Path::new("r");
        assert!(grep_output_or_error(repo, out(0, "")).is_ok());
        assert!(grep_output_or_error(repo, out(1, "")).is_ok(), "exit 1 = 무매치, 오류 아님");
        let e = grep_output_or_error(repo, out(128, "fatal: not a git repository\n")).err().unwrap();
        assert_eq!(e.code, ErrorCode::GitError);
        assert_eq!(e.message, "fatal: not a git repository");
        // 신호로 죽은 프로세스(runner 가 -1 로 만든다)는 예전엔 "매치 없음"으로 통과했다.
        assert!(grep_output_or_error(repo, out(-1, "")).is_err());
    }
}
