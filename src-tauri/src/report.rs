//! 작업 리포트(태스크 60) — 히트맵용 날짜별 활동, 기간 커밋, Claude Code 전사의 사용자 프롬프트,
//! 그리고 생성된 요약의 사이드 테이블(`reports.json`).
//!
//! **두 소스를 같은 날짜계에 놓는 것이 이 모듈의 핵심이다.** git `%aI`는 작성자 로컬 오프셋을
//! 달고 오므로 그 오프셋의 날짜로 세고, Claude 전사 `timestamp`는 UTC(`Z`)라 **로컬로 변환한 뒤**
//! 날짜를 뽑는다. 섞으면 히트맵의 두 시리즈가 하루씩 어긋난다(CLAUDE.md의 UTC/KST 함정).

use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;

use chrono::{DateTime, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::claude_usage::{encode_project_dir, home_dir};
use crate::commands::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::parse_log::parse_log;
use crate::git::runner;
use crate::git::types::Commit;
use crate::state::{self, AppState, Reports};

/// 요약 입력으로 실을 커밋 상한 — 예산 계산은 프론트(`lib/report.ts`)가 하고, 여기선 IPC 크기를 묶는다.
const COMMIT_LIMIT: u32 = 200;
/// 프롬프트 상한(건수·건당 길이). 월간 대형 프로젝트의 전사는 수만 줄이라 그대로 실으면 IPC가 막힌다.
const PROMPT_LIMIT: usize = 2000;
const PROMPT_CHARS: usize = 500;
/// `reports.json` 항목 상한 — 넘치면 오래된 것(generatedAt)부터 버린다.
const MAX_REPORTS: usize = 3000;

/// 히트맵 한 칸 — 날짜(YYYY-MM-DD)와 그 날의 건수.
#[derive(Debug, Clone, Serialize)]
pub struct DayCount {
    pub date: String,
    pub count: u32,
}

/// 사용자 프롬프트 1건.
#[derive(Debug, Clone, Serialize)]
pub struct PromptItem {
    /// 전사의 원본 timestamp(UTC ISO 8601) — 프론트가 시각 표시·입력 해시에 쓴다.
    pub at: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptDump {
    pub items: Vec<PromptItem>,
    /// 날짜별 개수 — items는 상한에 잘리지만 이쪽은 기간 전체를 센다(히트맵 두 번째 시리즈).
    pub days: Vec<DayCount>,
}

/// 저장된 요약 1건(`reports.json`의 값). 키는 `"<projectId>|<day|week|month>|<since>"`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRecord {
    pub text: String,
    pub generated_at: String,
    /// 입력(커밋 sha + 프롬프트 시각) 해시 — 달라지면 프론트가 "다시 생성"을 제안한다.
    pub input_hash: String,
    pub model: String,
}

/// `YYYY-MM-DD`만 통과시킨다. 이 값이 그대로 git 인자가 되므로 모양에서 끊는다
/// (`--author=…` 같은 플래그 주입 차단). regex 크레이트를 새로 들이지 않으려고 바이트 검사 +
/// chrono 파싱 두 겹으로 같은 판정을 한다(`2026-9-7`은 파싱은 되지만 모양에서 탈락).
fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn check_range(since: &str, until: &str) -> Result<(), IpcError> {
    if is_ymd(since) && is_ymd(until) {
        return Ok(());
    }
    Err(IpcError::new(
        ErrorCode::GitError,
        crate::i18n::text_db::report_range_format_invalid(),
    ))
}

/// git `log`의 공통 인자 — `--since`는 그 날 00:00, `--until`은 **그 날 23:59:59**다.
/// 날짜만 주면 git이 `--until`을 00:00으로 읽어 마지막 날의 커밋이 통째로 빠진다.
///
/// **이 필터는 커미터 날짜로 거른다** — git에 작성일 필터가 없다. 그런데 이 모듈의 표시 기준은
/// `%aI`(작성 날짜)라 둘이 갈린 커밋(리베이스·amend·`GIT_AUTHOR_DATE` 조작)에서는 범위 밖 커밋이
/// 딸려 온다. 그래서 **호출부가 받은 결과를 작성 날짜로 한 번 더 거른다**(`in_range`) — 안 그러면
/// 잔디(작성일 버킷)와 카드(범위 커밋 수)가 같은 날에 다른 수를 보인다. 커미터 필터는 값싼
/// 선거름으로만 남긴다(태스크 60 §6).
fn range_args(since: &str, until: &str) -> (String, String) {
    (
        format!("--since={since}T00:00:00"),
        format!("--until={until}T23:59:59"),
    )
}

/// `mine` 필터에 쓸 이메일. 레포 안에서 부르므로 로컬 설정이 전역을 이긴다(git이 병합해 준다).
/// 설정이 없으면 None → 필터 없이 전체(설계 §3.2).
async fn user_email(repo: &Path) -> Option<String> {
    let out = runner::run_git(
        Some(repo),
        &["config", "user.email"],
        runner::READ_TIMEOUT_SECS,
    )
    .await
    .ok()?;
    let email = out.stdout_str().trim().to_string();
    (out.code == 0 && !email.is_empty()).then_some(email)
}

/// 커밋이 하나도 없는 레포는 오류가 아니라 빈 히스토리다(get_log와 같은 판정).
fn is_unborn(stderr: &str) -> bool {
    let err = stderr.to_lowercase();
    err.contains("does not have any commits") || err.contains("bad default revision")
}

/// 작성 날짜(`YYYY-MM-DD` 문자열)가 요청 범위 안인가. 문자열 비교로 충분하다 — 두 값 모두
/// 같은 형식의 로컬 날짜다(`range_args` 주석의 커미터/작성일 어긋남을 여기서 잘라낸다).
fn in_range(date: &str, since: &str, until: &str) -> bool {
    date >= since && date <= until
}

/// `%aI` 목록(줄바꿈 구분)을 날짜별 개수로 접는다 — **작성자 오프셋의 날짜**로 센다.
/// 파싱 실패 줄은 건너뛴다(빈 줄 포함). 범위 밖 작성일은 버린다(커미터 필터가 흘려보낸 것).
fn bucket_commit_dates(out: &str, since: &str, until: &str) -> Vec<DayCount> {
    let mut by_day: HashMap<String, u32> = HashMap::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(dt) = DateTime::parse_from_rfc3339(line) else {
            continue;
        };
        let date = dt.date_naive().to_string();
        if !in_range(&date, since, until) {
            continue;
        }
        *by_day.entry(date).or_insert(0) += 1;
    }
    sorted_days(by_day)
}

fn sorted_days(by_day: HashMap<String, u32>) -> Vec<DayCount> {
    let mut days: Vec<DayCount> = by_day
        .into_iter()
        .map(|(date, count)| DayCount { date, count })
        .collect();
    days.sort_by(|a, b| a.date.cmp(&b.date));
    days
}

/// 날짜별 커밋 수 — 히트맵의 첫 번째 시리즈.
#[tauri::command]
pub async fn git_activity(
    state: State<'_, AppState>,
    project_id: String,
    since: String,
    until: String,
    mine: bool,
) -> Result<Vec<DayCount>, IpcError> {
    check_range(&since, &until)?;
    let repo = project_path(&state, &project_id)?;
    let (since_arg, until_arg) = range_args(&since, &until);
    let author_arg = if mine {
        user_email(&repo).await.map(|e| format!("--author={e}"))
    } else {
        None
    };

    let mut args = vec!["log", "--format=%aI", &since_arg, &until_arg];
    if let Some(a) = &author_arg {
        args.push(a);
    }
    let out = runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await?;
    if out.code != 0 {
        if is_unborn(&out.stderr) {
            return Ok(Vec::new());
        }
        return Err(IpcError::git(crate::i18n::text_db::report_git_log_failed(), out.stderr));
    }
    Ok(bucket_commit_dates(&out.stdout_str(), &since, &until))
}

/// 기간 커밋 — 요약 입력. `get_log`에 since/until/author를 더한 것(같은 포맷·같은 파서).
#[tauri::command]
pub async fn commits_between(
    state: State<'_, AppState>,
    project_id: String,
    since: String,
    until: String,
    mine: bool,
) -> Result<Vec<Commit>, IpcError> {
    check_range(&since, &until)?;
    let repo = project_path(&state, &project_id)?;
    let (since_arg, until_arg) = range_args(&since, &until);
    let max_arg = format!("--max-count={COMMIT_LIMIT}");
    let author_arg = if mine {
        user_email(&repo).await.map(|e| format!("--author={e}"))
    } else {
        None
    };

    let mut args = vec![
        "log",
        "-z",
        crate::commands::LOG_FORMAT,
        &max_arg,
        &since_arg,
        &until_arg,
    ];
    if let Some(a) = &author_arg {
        args.push(a);
    }
    let out = runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await?;
    if out.code != 0 {
        if is_unborn(&out.stderr) {
            return Ok(Vec::new());
        }
        return Err(IpcError::git(crate::i18n::text_db::report_git_log_failed(), out.stderr));
    }
    // 커미터 필터가 흘려보낸 범위 밖 커밋을 **작성 날짜로** 잘라낸다 — 잔디(작성일 버킷)와
    // 카드(이 목록의 길이)가 같은 날에 다른 수를 보이면 안 된다.
    Ok(parse_log(&out.stdout)
        .into_iter()
        .filter(|c| {
            DateTime::parse_from_rfc3339(&c.authored_at)
                .map(|dt| in_range(&dt.date_naive().to_string(), &since, &until))
                .unwrap_or(true) // 시각을 못 읽으면 버리지 않는다(표시가 사라지는 쪽이 더 나쁘다)
        })
        .collect())
}

// ── Claude Code 전사의 사용자 프롬프트 ────────────────────────────────────────

/// UTC ISO 8601 → **로컬** 날짜. 전사 timestamp는 항상 `Z`라 이 변환 없이는 커밋과 하루가 어긋난다.
fn local_date(ts: &str) -> Option<NaiveDate> {
    Some(
        DateTime::parse_from_rfc3339(ts)
            .ok()?
            .with_timezone(&Local)
            .date_naive(),
    )
}

/// 전사 한 줄 → (timestamp, 사용자 프롬프트 텍스트). 프롬프트가 아니면 None.
///
/// 걸러내는 것: `type != "user"`, 사이드체인(서브에이전트)·메타 줄, 도구 결과만 담긴 줄
/// (`tool_result` 블록은 사용자가 쓴 글이 아니라 앱이 되돌려준 출력이다), 그리고 빈 텍스트.
/// `message.content`는 문자열이거나 블록 배열이다(이 머신의 실제 전사로 확인, 2026-09-07).
fn parse_user_prompt(line: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("user") {
        return None;
    }
    // 두 플래그는 있을 때만 의미가 있다(없는 줄이 정상 프롬프트다).
    if v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true)
        || v.get("isMeta").and_then(|b| b.as_bool()) == Some(true)
    {
        return None;
    }
    let at = v.get("timestamp").and_then(|t| t.as_str())?.to_string();
    let content = v.get("message").and_then(|m| m.get("content"))?;
    let text = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some((at, text.chars().take(PROMPT_CHARS).collect()))
}

/// 전사 디렉토리를 훑어 기간 안의 사용자 프롬프트를 모은다(동기 — 호출부가 spawn_blocking으로 감싼다).
///
/// 파일이 수백 MB일 수 있어 통째로 읽지 않고 `BufRead::lines`로 흘려 보낸다. 파일 mtime이
/// `since` 이전이면 그 안에 기간 내 줄이 있을 수 없으므로 열지 않는다.
fn collect_prompts(dir: &Path, since: NaiveDate, until: NaiveDate) -> PromptDump {
    let mut items: Vec<PromptItem> = Vec::new();
    let mut by_day: HashMap<String, u32> = HashMap::new();

    let since_start = Local
        .from_local_datetime(&since.and_hms_opt(0, 0, 0).unwrap_or_default())
        .earliest();
    let Ok(entries) = std::fs::read_dir(dir) else {
        // 전사가 없는 프로젝트(Claude Code를 안 쓰는 레포)는 오류가 아니라 0건이다.
        return PromptDump {
            items,
            days: Vec::new(),
        };
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(true, |x| x != "jsonl") {
            continue;
        }
        if let (Some(start), Ok(meta)) = (since_start, entry.metadata()) {
            if let Ok(modified) = meta.modified() {
                if DateTime::<Local>::from(modified) < start {
                    continue;
                }
            }
        }
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let Some((at, text)) = parse_user_prompt(&line) else {
                continue;
            };
            let Some(date) = local_date(&at) else {
                continue;
            };
            if date < since || date > until {
                continue;
            }
            *by_day.entry(date.to_string()).or_insert(0) += 1;
            items.push(PromptItem { at, text });
        }
    }

    items.sort_by(|a, b| a.at.cmp(&b.at));
    // 상한을 넘으면 **최근** 것을 남긴다 — 요약은 최신 작업을 설명해야 한다.
    if items.len() > PROMPT_LIMIT {
        items.drain(..items.len() - PROMPT_LIMIT);
    }
    PromptDump {
        items,
        days: sorted_days(by_day),
    }
}

/// Claude Code 전사(`~/.claude/projects/<encoded>/*.jsonl`)의 사용자 프롬프트 + 날짜별 개수.
#[tauri::command]
pub async fn claude_prompts(
    project_path: String,
    since: String,
    until: String,
) -> Result<PromptDump, IpcError> {
    check_range(&since, &until)?;
    let (Some(since_d), Some(until_d)) = (
        NaiveDate::parse_from_str(&since, "%Y-%m-%d").ok(),
        NaiveDate::parse_from_str(&until, "%Y-%m-%d").ok(),
    ) else {
        return Err(IpcError::new(ErrorCode::GitError, crate::i18n::text_db::report_range_invalid()));
    };
    let Some(dir) = home_dir().map(|h| {
        h.join(".claude")
            .join("projects")
            .join(encode_project_dir(&project_path))
    }) else {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            crate::i18n::text_db::report_home_dir_not_found(),
        ));
    };
    // 전사 전체 스캔은 수백 MB가 될 수 있다 — 블로킹 풀로 보낸다(logo.rs와 같은 이유).
    tokio::task::spawn_blocking(move || collect_prompts(&dir, since_d, until_d))
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, crate::i18n::text_db::report_transcript_scan_failed(e)))
}

// ── 요약 저장(reports.json) ───────────────────────────────────────────────────

fn persist(app: &AppHandle, state: &AppState) -> Result<(), IpcError> {
    let snapshot = state
        .reports
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    state::save_reports(app, &snapshot)
}

/// 바뀐 요약을 **모든 창에** 알린다. 창마다 QueryClient 가 별개인 데다 `["reports"]` 는
/// `staleTime: Infinity` 라(queries/index.ts), 별도 리포트 창에서 저장한 것을 메인 창은 —
/// 그 반대도 — 스스로 알 방법이 없다. `record` 는 삭제면 null 이다.
/// 저장은 이미 끝난 뒤이므로 알림 실패는 로그만 남기고 삼킨다.
fn emit_changed(app: &AppHandle, key: &str, record: Option<ReportRecord>) {
    if let Err(e) = app.emit(
        "report://changed",
        serde_json::json!({ "key": key, "record": record }),
    ) {
        log::warn!("리포트 변경 알림 실패: {e}");
    }
}

/// 저장된 요약 전체 — 리포트 뷰가 열릴 때 1회 로드해 카드가 즉시 본문을 그린다.
#[tauri::command(async)]
pub fn report_get_all(state: State<'_, AppState>) -> Reports {
    state
        .reports
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 요약 1건 저장. 상한을 넘으면 `generatedAt`이 오래된 것부터 버린다.
#[tauri::command]
pub fn report_set(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    record: ReportRecord,
) -> Result<(), IpcError> {
    let mut evicted: Vec<String> = Vec::new();
    {
        let mut reports = state.reports.write().unwrap_or_else(|e| e.into_inner());
        reports.insert(key.clone(), record.clone());
        if reports.len() > MAX_REPORTS {
            let mut keys: Vec<(String, String)> = reports
                .iter()
                .map(|(k, r)| (r.generated_at.clone(), k.clone()))
                .collect();
            keys.sort();
            for (_, k) in keys.into_iter().take(reports.len() - MAX_REPORTS) {
                reports.remove(&k);
                evicted.push(k);
            }
        }
    }
    persist(&app, &state)?;
    // 퇴거된 키도 알린다 — 알리지 않으면 각 창의 `["reports"]` 캐시(staleTime: Infinity)에
    // 디스크엔 없는 요약이 유령으로 남아 카드가 "저장된 요약"을 계속 그린다.
    for k in evicted {
        emit_changed(&app, &k, None);
    }
    emit_changed(&app, &key, Some(record));
    Ok(())
}

/// 요약 1건 삭제(사용자가 카드에서 지울 때).
#[tauri::command]
pub fn report_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<(), IpcError> {
    {
        let mut reports = state.reports.write().unwrap_or_else(|e| e.into_inner());
        reports.remove(&key);
    }
    persist(&app, &state)?;
    emit_changed(&app, &key, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 날짜가 그대로 git 인자가 된다 — 모양이 아닌 것은 전부 막아야 한다.
    #[test]
    fn only_ymd_dates_reach_git() {
        assert!(is_ymd("2026-09-07"));
        assert!(!is_ymd("2026-9-7"), "자릿수가 다르면 거절한다");
        assert!(!is_ymd("2026-13-01"), "없는 달");
        assert!(!is_ymd("--author=x"));
        assert!(!is_ymd("2026-09-07 --all"));
        assert!(!is_ymd(""));
        assert!(check_range("2026-09-01", "2026-09-07").is_ok());
        assert!(check_range("2026-09-01", "; rm -rf /").is_err());
    }

    /// `--until`은 그 날 23:59:59여야 한다. 날짜만 넘기면 git이 00:00으로 읽어
    /// **마지막 날의 커밋이 통째로 빠진다**(오늘 커밋이 히트맵에서 사라지는 증상).
    #[test]
    fn until_covers_the_whole_day() {
        let (since, until) = range_args("2026-09-01", "2026-09-07");
        assert_eq!(since, "--since=2026-09-01T00:00:00");
        assert_eq!(until, "--until=2026-09-07T23:59:59");
    }

    /// 커밋은 **작성자 오프셋의 날짜**로 센다. UTC로 환산해 세면 KST 오전 커밋이 전날로 밀린다.
    #[test]
    fn commit_dates_bucket_on_their_own_offset() {
        // 08:30+09:00 = 전날 23:30Z — UTC 날짜(09-06)를 쓰면 하루가 어긋난다.
        let out = "2026-09-07T08:30:00+09:00\n2026-09-07T23:00:00+09:00\n2026-09-05T10:00:00-07:00\n";
        let days = bucket_commit_dates(out, "2000-01-01", "2100-01-01");
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].date, "2026-09-05");
        assert_eq!(days[0].count, 1);
        assert_eq!(days[1].date, "2026-09-07");
        assert_eq!(days[1].count, 2);
    }

    /// 빈 줄·깨진 줄은 건너뛴다(커밋 0개 레포·부분 출력).
    #[test]
    fn bucket_skips_unparsable_lines() {
        let (a, b) = ("2000-01-01", "2100-01-01");
        assert!(bucket_commit_dates("", a, b).is_empty());
        assert!(bucket_commit_dates("\n쓰레기\n", a, b).is_empty());
        assert_eq!(bucket_commit_dates("2026-09-07T00:00:00Z\n", a, b).len(), 1);
    }

    /// `--since/--until`은 **커미터** 날짜로 거르므로, 작성일만 과거인 커밋(리베이스·amend·
    /// `GIT_AUTHOR_DATE` 조작)이 하루짜리 조회에도 딸려 온다. 표시 기준인 작성일로 다시 걸러야
    /// 잔디와 카드가 같은 수를 보인다(실측: 픽스처에서 잔디 1 vs 카드 3).
    #[test]
    fn out_of_range_author_dates_are_dropped() {
        let out = "2026-09-08T10:00:00+09:00\n2026-07-30T10:00:00+09:00\n2026-09-05T10:00:00+09:00\n";
        let days = bucket_commit_dates(out, "2026-09-08", "2026-09-08");
        assert_eq!(days.len(), 1, "그 날 작성된 커밋만 남는다");
        assert_eq!(days[0].date, "2026-09-08");
        assert_eq!(days[0].count, 1);
    }

    /// 경계 포함 — since·until 당일은 범위 안이다.
    #[test]
    fn range_bounds_are_inclusive() {
        assert!(in_range("2026-09-01", "2026-09-01", "2026-09-07"));
        assert!(in_range("2026-09-07", "2026-09-01", "2026-09-07"));
        assert!(!in_range("2026-08-31", "2026-09-01", "2026-09-07"));
        assert!(!in_range("2026-09-08", "2026-09-01", "2026-09-07"));
    }

    /// 전사 timestamp는 UTC(`Z`)다 — 로컬로 변환한 날짜로 버킷해야 커밋과 같은 날짜계에 놓인다.
    #[test]
    fn transcript_timestamps_bucket_on_local_date() {
        let at = "2026-09-06T23:00:00.000Z";
        let utc_naive = DateTime::parse_from_rfc3339(at).unwrap().naive_utc();
        let offset = Local.offset_from_utc_datetime(&utc_naive).local_minus_utc();
        let got = local_date(at).unwrap().to_string();
        if offset >= 3600 {
            // KST(+9) 등 — UTC 날짜(09-06)를 그대로 쓰면 하루가 어긋난다.
            assert_eq!(got, "2026-09-07");
        } else if offset <= -3600 {
            assert_eq!(got, "2026-09-06");
        }
        assert!(local_date("깨진 값").is_none());
    }

    /// 실제 전사 한 줄(이 머신 2026-09-07 형식) — 문자열 content.
    #[test]
    fn parses_plain_string_prompt() {
        let line = r#"{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"태스크 60을 구현해라"},"timestamp":"2026-09-07T00:04:47.392Z","cwd":"F:\\gitpervisor"}"#;
        let (at, text) = parse_user_prompt(line).expect("문자열 content는 프롬프트다");
        assert_eq!(at, "2026-09-07T00:04:47.392Z");
        assert_eq!(text, "태스크 60을 구현해라");
    }

    /// 블록 배열은 텍스트 블록만 이어 붙인다.
    #[test]
    fn parses_text_blocks_and_joins_them() {
        let line = r#"{"type":"user","message":{"content":[{"type":"text","text":"첫 줄"},{"type":"image","source":{}},{"type":"text","text":"둘째 줄"}]},"timestamp":"2026-09-07T01:00:00.000Z"}"#;
        let (_, text) = parse_user_prompt(line).unwrap();
        assert_eq!(text, "첫 줄\n둘째 줄");
    }

    /// **도구 결과는 프롬프트가 아니다.** 앱이 되돌려준 출력이라 요약 입력에 들어가면
    /// "사용자가 무엇을 요청했나"가 통째로 흐려진다.
    #[test]
    fn skips_tool_results_meta_sidechain_and_others() {
        let cases = [
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok","tool_use_id":"t1"}]},"timestamp":"2026-09-07T01:00:00.000Z"}"#,
            r#"{"type":"user","isMeta":true,"message":{"content":"<command-name>/clear</command-name>"},"timestamp":"2026-09-07T01:00:00.000Z"}"#,
            r#"{"type":"user","isSidechain":true,"message":{"content":"서브에이전트 지시"},"timestamp":"2026-09-07T01:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"답변"}]},"timestamp":"2026-09-07T01:00:00.000Z"}"#,
            r#"{"type":"user","message":{"content":"   "},"timestamp":"2026-09-07T01:00:00.000Z"}"#,
            r#"{"type":"user","message":{"content":"타임스탬프 없음"}}"#,
            "깨진 줄",
            "",
        ];
        for line in cases {
            assert!(
                parse_user_prompt(line).is_none(),
                "프롬프트가 아닌 줄을 통과시켰다: {line}"
            );
        }
    }

    /// 긴 프롬프트는 500자로 자른다 — **문자** 단위여야 한글이 깨지지 않는다.
    #[test]
    fn caps_prompt_text_by_chars() {
        let long = "가".repeat(600);
        let line = format!(
            r#"{{"type":"user","message":{{"content":"{long}"}},"timestamp":"2026-09-07T01:00:00.000Z"}}"#
        );
        let (_, text) = parse_user_prompt(&line).unwrap();
        assert_eq!(text.chars().count(), PROMPT_CHARS);
    }
}
