use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::DirEntry;
use crate::state::AppState;

/// 프로젝트 내 한 디렉토리의 항목을 나열한다 (지연 로딩 — 폴더 펼칠 때 한 단계씩).
/// `rel_path`는 레포 루트 기준 상대 경로(빈 문자열이면 루트).
#[tauri::command]
pub async fn list_dir(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<Vec<DirEntry>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    read_dir_entries(&repo, &rel_path).await
}

/// Viewer 편집 저장 — 텍스트 파일 내용을 디스크에 쓴다. `rel_path`는 레포 루트 기준 상대 경로.
/// 경로 탈출(절대경로·`..`·`.git`)을 막고, 새 디렉토리는 만들지 않는다(기존 파일 편집 전제).
#[tauri::command]
pub async fn write_file(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    content: String,
) -> Result<(), IpcError> {
    let repo = project_path(&state, &project_id)?;
    validate_rel_file(&rel_path)?;
    let target = repo.join(&rel_path);
    // 상위 디렉토리가 실제로 존재해야 한다(편집 대상의 폴더). 새 트리 생성은 하지 않는다.
    match target.parent() {
        Some(parent) if parent.is_dir() => {}
        _ => {
            return Err(IpcError::new(
                ErrorCode::NotFound,
                "상위 디렉토리를 찾을 수 없습니다",
            ))
        }
    }
    // 기존 경로가 디렉토리면 거부(파일만 쓴다).
    if target.is_dir() {
        return Err(IpcError::new(ErrorCode::Io, "디렉토리에는 쓸 수 없습니다"));
    }
    tokio::fs::write(&target, content)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 저장 실패: {e}")))
}

/// 한 프로젝트 루트의 결과(또는 오류) — 배치 프리페치용.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoot {
    pub project_id: String,
    pub entries: Vec<DirEntry>,
    pub error: Option<String>,
}

/// 여러 프로젝트의 루트 디렉토리를 **병렬로** 읽는다 (WebView2 동시 invoke 응답 유실 회피 —
/// 요청 1개로 전부 처리, 내부는 join_all 동시 실행). 프론트는 결과를 dir 캐시에 시드한다.
#[tauri::command]
pub async fn list_project_roots(
    state: State<'_, AppState>,
    project_ids: Vec<String>,
) -> Result<Vec<ProjectRoot>, IpcError> {
    // 경로 해석은 락 안에서 끝내고, 읽기는 락 밖에서 동시 실행한다.
    let targets: Vec<(String, Option<PathBuf>)> = {
        let projects = state.projects.read().unwrap();
        project_ids
            .into_iter()
            .map(|id| {
                let path = projects
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| PathBuf::from(&p.path));
                (id, path)
            })
            .collect()
    };

    // 동시성 제한(buffer_unordered) — Windows에서 git 프로세스를 한꺼번에 수십 개
    // 띄우면(Defender 스캔·프로세스 생성 폭주) 서로를 굶겨 타임아웃 난다. 소수씩 동시 실행.
    use futures::stream::StreamExt;
    const ROOT_CONCURRENCY: usize = 4;

    let results: Vec<ProjectRoot> = futures::stream::iter(targets)
        .map(|(id, path)| async move {
            let Some(p) = path else {
                return ProjectRoot {
                    project_id: id,
                    entries: Vec::new(),
                    error: Some("프로젝트 경로를 찾을 수 없습니다".to_string()),
                };
            };
            match tokio::time::timeout(Duration::from_secs(15), read_dir_entries(&p, "")).await {
                Ok(Ok(entries)) => ProjectRoot {
                    project_id: id,
                    entries,
                    error: None,
                },
                Ok(Err(e)) => ProjectRoot {
                    project_id: id,
                    entries: Vec::new(),
                    error: Some(e.message),
                },
                Err(_) => ProjectRoot {
                    project_id: id,
                    entries: Vec::new(),
                    error: Some("루트 읽기 시간 초과".to_string()),
                },
            }
        })
        .buffer_unordered(ROOT_CONCURRENCY)
        .collect()
        .await;

    Ok(results)
}

/// 한 디렉토리의 항목을 읽어 정렬한다 (list_dir·배치 프리페치 공통).
async fn read_dir_entries(repo: &Path, rel_path: &str) -> Result<Vec<DirEntry>, IpcError> {
    validate_rel_dir(rel_path)?;

    let dir = if rel_path.is_empty() {
        repo.to_path_buf()
    } else {
        repo.join(rel_path)
    };
    if !dir.is_dir() {
        return Err(IpcError::new(
            ErrorCode::NotFound,
            "디렉토리를 찾을 수 없습니다",
        ));
    }

    // 1) 디렉토리 항목 수집
    let mut read = tokio::fs::read_dir(&dir)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("디렉토리 읽기 실패: {e}")))?;
    let mut items: Vec<(String, bool)> = Vec::new(); // (name, is_dir)
    while let Ok(Some(entry)) = read.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        items.push((name, is_dir));
    }

    // 2) gitignore 판정 (git check-ignore 배치)
    let ignored = check_ignored(repo, rel_path, &items).await;

    let mut entries: Vec<DirEntry> = items
        .into_iter()
        .map(|(name, is_dir)| {
            let rel = join_rel(rel_path, &name);
            DirEntry {
                is_ignored: name == ".git" || ignored.contains(&rel),
                name,
                is_dir,
            }
        })
        .collect();

    // 3) 디렉토리 우선 + 이름순(대소문자 무시, 점 파일은 자연히 앞)
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn join_rel(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// `git check-ignore -z --stdin` 로 무시되는 경로 집합을 구한다 (추적 중인 파일은 제외됨).
async fn check_ignored(repo: &Path, rel_path: &str, items: &[(String, bool)]) -> HashSet<String> {
    if items.is_empty() {
        return HashSet::new();
    }
    let mut input = Vec::new();
    for (name, _) in items {
        input.extend_from_slice(join_rel(rel_path, name).as_bytes());
        input.push(0);
    }
    match runner::run_git_with_stdin(
        Some(repo),
        &["check-ignore", "-z", "--stdin"],
        &input,
        runner::READ_TIMEOUT_SECS,
    )
    .await
    {
        Ok(out) => out
            .stdout
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
        Err(_) => HashSet::new(),
    }
}

/// 레포 밖 접근 차단 — 절대경로·`..` 거부. 빈 문자열(루트)은 허용.
fn validate_rel_dir(rel: &str) -> Result<(), IpcError> {
    let p = Path::new(rel);
    if p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    Ok(())
}

// ===== Go-to-Definition (Viewer 심볼 점프) =====

/// 정의 후보 1건 — 휴리스틱 ripgrep 매칭.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefMatch {
    pub path: String,      // 레포 상대 경로(forward slash)
    pub line: u32,         // 1-based
    pub column: u32,       // 1-based
    pub signature: String, // 데코레이터/속성 + 정의줄 + 파라미터
}

/// 심볼의 정의 위치를 휴리스틱으로 찾는다(LSP 없이 언어별 "정의 패턴"을 ripgrep으로 검색).
/// 완벽하진 않으나 함수/클래스/타입 정의를 대부분 잡는다. .gitignore된 경로(node_modules·
/// target 등)는 ripgrep이 자동 제외한다. rg 미설치/타임아웃이면 조용히 빈 결과를 반환한다.
#[tauri::command]
pub async fn find_definition(
    state: State<'_, AppState>,
    project_id: String,
    symbol: String,
    ext: String,
) -> Result<Vec<DefMatch>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 식별자만 허용(빈/과길이/특수문자 거부 — 패턴 인젝션·과검색 방지).
    if symbol.is_empty()
        || symbol.len() > 128
        || !symbol.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
    {
        return Ok(Vec::new());
    }
    let (patterns, exts) = def_query(&ext, &symbol);
    if patterns.is_empty() {
        return Ok(Vec::new());
    }

    // git grep -P(PCRE, `\b` 지원)으로 정의 패턴 검색. ripgrep은 앱 프로세스 PATH에 없을 수
    // 있지만 git은 항상 가용(코어 의존, 설정된 경로 사용). --untracked로 추적 안 된 새 파일의
    // 정의도 포함. 매치 없으면 exit 1(정상) → run_git이 Ok+빈 stdout를 주므로 빈 결과가 된다.
    let mut args: Vec<&str> = vec![
        "grep", "-P", "-n", "--column", "--no-color", "-I", "--untracked",
    ];
    for p in &patterns {
        args.push("-e");
        args.push(p);
    }
    let out = match runner::run_git(Some(&repo), &args, runner::READ_TIMEOUT_SECS).await {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);

    let mut matches: Vec<DefMatch> = Vec::new();
    for line in stdout.lines() {
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
        // 언어별 확장자 필터(오탐 감소). exts 비면 전부 허용(제네릭 폴백).
        if !exts.is_empty() && !exts.iter().any(|e| path.ends_with(e.as_str())) {
            continue;
        }
        let rel = path.replace('\\', "/");
        let signature = extract_signature(&repo, &rel, line_no, text);
        matches.push(DefMatch {
            path: rel,
            line: line_no,
            column: col_no,
            signature,
        });
        if matches.len() >= 12 {
            break;
        }
    }
    Ok(matches)
}

/// (정규식 패턴들, 확장자들) — 확장자별 "정의" 패턴. 심볼의 `$`만 정규식 이스케이프.
fn def_query(ext: &str, symbol: &str) -> (Vec<String>, Vec<String>) {
    let s = symbol.replace('$', "\\$");
    let g = |arr: &[&str]| arr.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    match ext.to_lowercase().as_str() {
        "py" | "pyi" => (
            vec![
                format!(r"^\s*(async\s+)?def\s+{s}\b"),
                format!(r"^\s*class\s+{s}\b"),
            ],
            g(&[".py", ".pyi"]),
        ),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => (
            vec![
                format!(r"\b(export\s+)?(default\s+)?(async\s+)?function\s+{s}\b"),
                format!(r"\b(export\s+)?(const|let|var)\s+{s}\s*[=:]"),
                format!(r"\b(export\s+)?(default\s+)?(abstract\s+)?class\s+{s}\b"),
                format!(r"\b(export\s+)?interface\s+{s}\b"),
                format!(r"\b(export\s+)?type\s+{s}\b"),
                format!(r"\b(export\s+)?enum\s+{s}\b"),
            ],
            g(&[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
        ),
        "rs" => (
            vec![
                format!(r"\b(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?struct\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?enum\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?trait\s+{s}\b"),
                format!(r"\b(pub(\([^)]*\))?\s+)?(type|const|static)\s+{s}\b"),
                format!(r"macro_rules!\s+{s}\b"),
            ],
            g(&[".rs"]),
        ),
        "go" => (
            vec![
                format!(r"\bfunc\s+(\([^)]*\)\s*)?{s}\b"),
                format!(r"\btype\s+{s}\b"),
            ],
            g(&[".go"]),
        ),
        "java" | "kt" | "kts" => (
            vec![
                format!(r"\b(class|interface|enum|object)\s+{s}\b"),
                format!(r"\b(fun|void|[A-Za-z_][\w<>\[\].]*)\s+{s}\s*\("),
            ],
            g(&[".java", ".kt", ".kts"]),
        ),
        "rb" => (
            vec![
                format!(r"^\s*def\s+(self\.)?{s}\b"),
                format!(r"^\s*(class|module)\s+{s}\b"),
            ],
            g(&[".rb"]),
        ),
        // 언어 미상 — 제네릭 폴백(전 파일 검색)
        _ => (
            vec![
                format!(r"\b(function|def|fn|func|class|struct|interface|type|enum|trait)\s+{s}\b"),
                format!(r"\b(const|let|var|val)\s+{s}\s*[=:]"),
            ],
            Vec::new(),
        ),
    }
}

/// 매치 줄 주변에서 시그니처 블록을 추출한다 — 위로 데코레이터(@)/속성(#[..]) 연속,
/// 아래로 정의가 닫힐 때까지(`:`/`{`/`;`/`}` 또는 8줄). 읽기 실패 시 매치 줄 자체를 쓴다.
fn extract_signature(repo: &Path, rel: &str, line_no: u32, fallback: &str) -> String {
    let content = match std::fs::read_to_string(repo.join(rel)) {
        Ok(c) => c,
        Err(_) => return fallback.trim().to_string(),
    };
    let lines: Vec<&str> = content.lines().collect();
    let idx = (line_no as usize).saturating_sub(1);
    if idx >= lines.len() {
        return fallback.trim().to_string();
    }
    let mut out: Vec<String> = Vec::new();
    // 위로: 연속 데코레이터/속성
    let mut i = idx;
    let mut deco: Vec<String> = Vec::new();
    while i > 0 {
        let prev = lines[i - 1].trim_start();
        if prev.starts_with('@') || prev.starts_with("#[") {
            deco.push(lines[i - 1].to_string());
            i -= 1;
        } else {
            break;
        }
    }
    deco.reverse();
    out.extend(deco);
    // 정의줄 + 아래로
    let mut j = idx;
    let mut taken = 0;
    while j < lines.len() && taken < 8 {
        let l = lines[j];
        out.push(l.to_string());
        taken += 1;
        let t = l.trim_end();
        if t.ends_with(':') || t.ends_with('{') || t.ends_with(';') || t.ends_with('}') {
            break;
        }
        j += 1;
    }
    let sig = out.join("\n");
    if sig.len() > 1200 {
        format!("{}…", sig.chars().take(1200).collect::<String>())
    } else {
        sig
    }
}

/// 파일 쓰기용 경로 검증 — 빈 경로·절대경로·`..`·`.git` 진입 거부.
fn validate_rel_file(rel: &str) -> Result<(), IpcError> {
    let p = Path::new(rel);
    let first_is_git = p
        .components()
        .next()
        .map(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
        .unwrap_or(false);
    if rel.is_empty()
        || p.is_absolute()
        || p.components().any(|c| matches!(c, Component::ParentDir))
        || first_is_git
    {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 경로입니다"));
    }
    Ok(())
}
