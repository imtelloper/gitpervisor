use std::path::{Component, Path};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use crate::error::{ErrorCode, IpcError};
use crate::git::runner;
use crate::git::types::{DiffTarget, FileDiff};
use crate::state::AppState;

/// 한쪽이 이 크기를 넘으면 내용 전송을 생략한다 (뷰어 멈춤 방지).
const MAX_DIFF_BYTES: usize = 1_572_864; // 1.5MB

/// 한 번의 배치 프리페치에서 읽는 최대 파일 수 — 거대 변경 목록의 spawn 폭주 방지
const MAX_BATCH_FILES: usize = 30;

#[tauri::command]
pub async fn get_file_diff(
    state: State<'_, AppState>,
    project_id: String,
    target: DiffTarget,
) -> Result<FileDiff, IpcError> {
    let repo = project_path(&state, &project_id)?;
    match target {
        DiffTarget::Worktree { path } => worktree_diff(&repo, path).await,
        DiffTarget::Index { path } => index_diff(&repo, path).await,
        DiffTarget::Commit { sha, path } => commit_diff(&repo, sha, path).await,
        DiffTarget::File { path } => file_content(&repo, path).await,
    }
}

/// 워크트리 파일 읽기 결과.
enum Blob {
    /// 파일이 없다 — 워크트리에서 삭제됐거나 아직 없다.
    Missing,
    /// 상한 초과 — **내용을 읽지 않았다.**
    TooLarge,
    Bytes(Vec<u8>),
}

/// 워크트리 파일을 읽되 **크기를 먼저 확인한다.**
///
/// 예전엔 `tokio::fs::read`로 전량을 읽은 뒤 `build_diff`에서 상한을 적용했다. 초과분은 곧바로
/// `too_large` 판정으로 버려지므로 그 읽기는 통째로 낭비였고, 프리페치(`usePrefetchDiffs`)가
/// status 갱신마다 untracked까지 포함해 자동으로 던지기 때문에 **레포에 큰 파일을 복사해 넣기만
/// 해도** 클릭 한 번 없이 수 GB를 읽었다. metadata로 먼저 걸러 아예 읽지 않는다.
///
/// metadata와 read 사이에 파일이 커질 수 있지만, `build_diff`의 길이 검사가 그대로 남아 있어
/// 최종 판정은 어차피 정확하다 — 여기서 막는 것은 "확실히 큰 것"의 낭비다.
async fn read_capped(path: &Path) -> Result<Blob, IpcError> {
    match tokio::fs::metadata(path).await {
        Ok(m) if m.len() > MAX_DIFF_BYTES as u64 => return Ok(Blob::TooLarge),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Blob::Missing),
        Err(e) => {
            return Err(IpcError::new(
                ErrorCode::Io,
                format!("파일 정보 조회 실패: {e}"),
            ))
        }
    }
    match tokio::fs::read(path).await {
        Ok(b) => Ok(Blob::Bytes(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Blob::Missing),
        Err(e) => Err(IpcError::new(ErrorCode::Io, format!("파일 읽기 실패: {e}"))),
    }
}

/// 내용 없이 "너무 큼"만 알리는 응답 — 뷰어가 안내 문구를 띄운다.
fn too_large_diff(path: String) -> FileDiff {
    FileDiff {
        path,
        old_content: None,
        new_content: None,
        is_binary: false,
        too_large: true,
    }
}

/// 단일 파일 보기 — 워크트리 내용만 new_content로 반환(old=None). 트리 클릭용.
async fn file_content(repo: &Path, path: String) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;
    match read_capped(&repo.join(&path)).await? {
        Blob::TooLarge => Ok(too_large_diff(path)),
        Blob::Missing => Ok(build_diff(path, None, None)),
        Blob::Bytes(b) => Ok(build_diff(path, None, Some(b))),
    }
}

/// diff 프리페치용 배치 — 단일 invoke로 여러 파일을 백엔드 병렬 조회 (§10 패턴).
/// 실패한 항목은 조용히 건너뛴다 — 클릭 시 단건 경로가 오류를 표면화한다.
#[tauri::command]
pub async fn get_file_diffs(
    state: State<'_, AppState>,
    project_id: String,
    paths: Vec<String>,
) -> Result<Vec<FileDiff>, IpcError> {
    let repo = project_path(&state, &project_id)?;

    // 동시 실행은 제한하지 않는다(원래대로). status.rs에서 같은 제한을 실측해 봤더니 편차에
    // 묻혀 이득이 확인되지 않았고(그쪽 주석에 수치), 여기는 위의 크기 사전 게이트가 큰 파일에
    // 대해 `git show` 자체를 없애 herd를 이미 줄여 놓았다. 근거 없이 동작을 바꾸지 않는다.
    let futures = paths.into_iter().take(MAX_BATCH_FILES).map(|path| {
        let repo = repo.clone();
        async move { worktree_diff(&repo, path).await.ok() }
    });
    let results = futures::future::join_all(futures).await;

    // 단일 IPC 응답 크기 예산 — 초과하는 큰 파일은 제외하고 클릭 시 단건 조회에 맡긴다
    const BATCH_BYTE_BUDGET: usize = 4 * 1024 * 1024;
    let mut budget = BATCH_BYTE_BUDGET;
    let mut out = Vec::new();
    for diff in results.into_iter().flatten() {
        let size = diff.old_content.as_ref().map_or(0, String::len)
            + diff.new_content.as_ref().map_or(0, String::len);
        if size > budget {
            continue;
        }
        budget -= size;
        out.push(diff);
    }
    Ok(out)
}

/// old = 인덱스 버전(`git show :<path>`, 없으면 None) / new = 워크트리 파일.
async fn worktree_diff(repo: &Path, path: String) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;

    // 워크트리 쪽을 **먼저** 판정한다 — 초과면 인덱스 버전을 뜨는 `git show` 자식 프로세스도
    // 띄우지 않는다(프리페치가 배치로 던지므로 이 절약이 그대로 곱해진다).
    let new = read_capped(&repo.join(&path)).await?;
    if matches!(new, Blob::TooLarge) {
        return Ok(too_large_diff(path));
    }

    let old_bytes = content_at(repo, &format!(":{path}")).await?;
    let new_bytes = match new {
        Blob::Bytes(b) => Some(b),
        _ => None, // 워크트리에서 삭제됨
    };

    Ok(build_diff(path, old_bytes, new_bytes))
}

/// staged 변경 검토: HEAD 버전 ↔ 인덱스 버전. (설계 §7 index 모드)
async fn index_diff(repo: &Path, path: String) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;
    let old_bytes = content_at(repo, &format!("HEAD:{path}")).await?;
    let new_bytes = content_at(repo, &format!(":{path}")).await?;
    Ok(build_diff(path, old_bytes, new_bytes))
}

/// 커밋 기준 diff: 첫 부모 버전 ↔ 해당 커밋 버전. root 커밋은 부모가 없어 old = None.
async fn commit_diff(repo: &Path, sha: String, path: String) -> Result<FileDiff, IpcError> {
    validate_rel_path(&path)?;
    if !runner::is_valid_sha(&sha) {
        return Err(IpcError::new(ErrorCode::GitError, "잘못된 커밋 해시입니다"));
    }
    let old_bytes = content_at(repo, &format!("{sha}^:{path}")).await?;
    let new_bytes = content_at(repo, &format!("{sha}:{path}")).await?;
    Ok(build_diff(path, old_bytes, new_bytes))
}

/// `git show <spec>` 내용 — 존재하지 않으면(없는 경로/없는 부모) None으로 added/deleted를 표현.
async fn content_at(repo: &Path, spec: &str) -> Result<Option<Vec<u8>>, IpcError> {
    match runner::run_git(Some(repo), &["show", spec], runner::READ_TIMEOUT_SECS).await {
        Ok(out) if out.code == 0 => Ok(Some(out.stdout)),
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 양쪽 바이트에서 바이너리/크기 가드를 적용해 FileDiff를 만든다 (모든 diff 모드 공용).
fn build_diff(path: String, old_bytes: Option<Vec<u8>>, new_bytes: Option<Vec<u8>>) -> FileDiff {
    let too_large = [&old_bytes, &new_bytes]
        .iter()
        .any(|b| b.as_ref().is_some_and(|b| b.len() > MAX_DIFF_BYTES));
    let is_binary = !too_large
        && [&old_bytes, &new_bytes]
            .iter()
            .any(|b| b.as_ref().is_some_and(|b| looks_binary(b)));

    if too_large || is_binary {
        return FileDiff {
            path,
            old_content: None,
            new_content: None,
            is_binary,
            too_large,
        };
    }

    FileDiff {
        path,
        old_content: old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        new_content: new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        is_binary: false,
        too_large: false,
    }
}

/// 경로는 항상 우리 status 출력에서 오지만, 방어적으로 레포 밖 접근을 차단한다.
/// Prefix(`C:`)·RootDir(`\`)는 join 시 레포 루트를 통째로 대체한다 — 윈도우에서 `\Windows\...`는
/// is_absolute()==false지만 드라이브 루트로 튀므로 반드시 함께 거부한다(tree.rs의 쓰기 게이트와 동일).
fn validate_rel_path(path: &str) -> Result<(), IpcError> {
    let p = Path::new(path);
    if p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(IpcError::new(ErrorCode::Io, "잘못된 파일 경로입니다"));
    }
    Ok(())
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// 이미지 뷰어용 파일 한도 — base64로 IPC 전송하므로 과대 파일을 막는다.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024; // 25MB

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBytes {
    pub mime: String,
    pub base64: String,
}

/// 워크트리의 파일을 그대로 읽어 (mime, base64)로 반환 — 이미지(png/jpg/webp/svg…) 미리보기용.
#[tauri::command]
pub async fn read_file_base64(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<FileBytes, IpcError> {
    let repo = project_path(&state, &project_id)?;
    validate_rel_path(&rel_path)?;
    let full = repo.join(&rel_path);
    // 크기를 먼저 본다 — 읽고 나서 거절하면 25GB 파일도 일단 메모리에 올렸다가 버린다
    // (read_capped와 같은 이유). 아래 길이 검사는 metadata 이후 커진 경우의 백스톱으로 남긴다.
    if let Ok(m) = tokio::fs::metadata(&full).await {
        if m.len() > MAX_IMAGE_BYTES as u64 {
            return Err(IpcError::new(
                ErrorCode::Io,
                "파일이 너무 큽니다 (25MB 초과)",
            ));
        }
    }
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|e| IpcError::new(ErrorCode::Io, format!("파일 읽기 실패: {e}")))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            "파일이 너무 큽니다 (25MB 초과)",
        ));
    }
    Ok(FileBytes {
        mime: mime_of(&rel_path),
        base64: B64.encode(&bytes),
    })
}

fn mime_of(path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 상한 초과 파일은 **읽지 않고** 걸러야 한다.
    ///
    /// 이 게이트가 없으면 프리페치가 status 갱신마다 자동으로(클릭 한 번 없이) 거대 파일을
    /// 전량 읽고, 읽은 내용은 too_large 판정으로 통째로 버려진다.
    #[tokio::test]
    async fn oversized_file_is_gated_before_read() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.bin");
        // 스파스 파일 — 실제로 채우지 않고 길이만 늘려 metadata만 크게 만든다.
        std::fs::File::create(&big)
            .unwrap()
            .set_len(MAX_DIFF_BYTES as u64 + 1)
            .unwrap();
        assert!(matches!(
            read_capped(&big).await.unwrap(),
            Blob::TooLarge
        ));
    }

    /// 상한 이하는 그대로 읽고, 없는 파일은 Missing(삭제된 파일의 diff 표현).
    #[tokio::test]
    async fn small_reads_and_absent_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("s.txt");
        std::fs::write(&small, b"hello").unwrap();
        match read_capped(&small).await.unwrap() {
            Blob::Bytes(b) => assert_eq!(b, b"hello".to_vec()),
            _ => panic!("Bytes를 기대했다"),
        }
        assert!(matches!(
            read_capped(&dir.path().join("nope")).await.unwrap(),
            Blob::Missing
        ));
    }
}
