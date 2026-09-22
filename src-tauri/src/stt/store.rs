// 자막 문서 저장소(태스크 72 §3.3, Q1 a) — `app_data_dir/captions/<projectId>/<hex16(sha256(rel))>.json`.
// 레포에 쓰는 것은 사용자가 누른 내보내기뿐이라 git이 더러워지지 않는다. 경로는 Rust만 계산한다.
//
// 동시성: `rev` 낙관적 검사 + 이 파일의 락. 락은 프로세스 내부지만 dev/설치본은 identifier가 달라
// 폴더가 갈리므로(CLAUDE.md 「개발 실행」) 이걸로 충분하다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::state::AppState;
use crate::stt::doc::{validate_doc, CaptionDoc, WordTiming, DOC_VERSION};
use crate::stt::plan::{caption_plan, CaptionPlan};

/// 읽기-검사-쓰기를 한 덩어리로 — 두 창이 같은 base_rev로 동시에 저장하면 한쪽만 이긴다.
static CAPTION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLoaded {
    pub doc: CaptionDoc,
    /// 원본 크기·수정 시각이 문서와 다르다 — "다시 인식" 배너(편집은 막지 않는다).
    pub stale: bool,
    pub plan: CaptionPlan,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSaved {
    pub rev: u64,
    pub plan: CaptionPlan,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionChanged {
    project_id: String,
    rel_path: String,
    rev: u64,
}

fn io(m: String) -> IpcError {
    IpcError::new(ErrorCode::Io, m)
}

pub fn normalize_rel(rel: &str) -> String {
    let s = rel.replace('\\', "/");
    let mut s = s.as_str();
    loop {
        let t = s.trim_start_matches('/').trim_start_matches("./");
        if t == s {
            return t.to_string();
        }
        s = t;
    }
}

fn hex16(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// 프로젝트 id는 보통 uuid지만 중첩 저장소는 `<outer>::<rel>`(projects.rs)이라 `:`·`/`가 섞인다 —
/// 폴더 이름으로 안전한 것만 그대로 쓰고 나머지는 해시한다.
fn project_dir_name(project_id: &str) -> String {
    let plain = !project_id.is_empty()
        && project_id.len() <= 64
        && project_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if plain {
        project_id.to_string()
    } else {
        format!("h-{}", hex16(project_id))
    }
}

/// 문서 경로(순수) — 파일 이름은 경로 해시라 `rel`이 무엇이든 `captions/<프로젝트>/` 밖으로 못 나간다.
pub fn doc_path(root: &Path, project_id: &str, rel: &str) -> PathBuf {
    root.join("captions")
        .join(project_dir_name(project_id))
        .join(format!("{}.json", hex16(&normalize_rel(rel))))
}

fn newer_version(path: &Path) -> IpcError {
    io(text_stt::caption_doc_newer_version(&path.display()))
}

fn peek_version(bytes: &[u8]) -> Option<u64> {
    serde_json::from_slice::<serde_json::Value>(bytes).ok()?.get("version")?.as_u64()
}

fn read_doc_at(path: &Path) -> Result<Option<CaptionDoc>, IpcError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(text_stt::caption_doc_read_failed(&path.display(), &e))),
    };
    // 모르는 필드는 serde가 버린다 — 더 높은 version도 모양이 맞으면 읽기 전용으로 보여 준다.
    match serde_json::from_slice::<CaptionDoc>(&bytes) {
        Ok(doc) => Ok(Some(doc)),
        Err(_) if peek_version(&bytes).is_some_and(|v| v > u64::from(DOC_VERSION)) => Err(newer_version(path)),
        Err(e) => Err(io(text_stt::caption_doc_corrupt_retranscribe(&path.display(), &e))),
    }
}

fn write_doc_at(path: &Path, doc: &CaptionDoc) -> Result<(), IpcError> {
    let bytes = serde_json::to_vec(doc).map_err(|e| io(text_stt::caption_doc_serialize_failed(&e)))?;
    crate::state::save_bytes_at(path, &bytes)
        .map_err(|e| io(text_stt::caption_doc_save_failed(&path.display(), &e)))
}

/// (크기, 수정 시각 ms). 수정 시각을 주지 않는 파일 시스템이면 0 — 그때는 크기만으로 stale을 가른다.
pub(crate) fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Some((meta.len(), mtime))
}

/// 읽기(순수 코어). `source_stamp`가 None이면 원본이 없다 = stale.
pub fn load_at(
    root: &Path,
    project_id: &str,
    rel: &str,
    source_stamp: Option<(u64, u64)>,
) -> Result<Option<CaptionLoaded>, IpcError> {
    let path = doc_path(root, project_id, rel);
    let Some(mut doc) = read_doc_at(&path)? else { return Ok(None) };
    if doc.version <= DOC_VERSION {
        validate_doc(&mut doc)
            .map_err(|e| io(text_stt::caption_doc_corrupt(&path.display(), &e.message)))?;
    }
    let stale = source_stamp != Some((doc.source.size_bytes, doc.source.mtime_ms));
    let plan = caption_plan(&doc)?;
    Ok(Some(CaptionLoaded { doc, stale, plan }))
}

/// 편집 저장(순수 코어): 검증 → 더 높은 version 거절 → `rev` 검사 → `rev+1`로 원자 쓰기.
pub fn save_at(
    root: &Path,
    project_id: &str,
    rel: &str,
    mut doc: CaptionDoc,
    base_rev: u64,
) -> Result<CaptionSaved, IpcError> {
    doc.version = DOC_VERSION;
    doc.source.rel = normalize_rel(rel);
    validate_doc(&mut doc)?;
    let _g = CAPTION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = doc_path(root, project_id, rel);
    let current = read_doc_at(&path)?;
    if current.as_ref().is_some_and(|c| c.version > DOC_VERSION) {
        return Err(newer_version(&path));
    }
    let cur_rev = current.map_or(0, |c| c.rev);
    if base_rev != cur_rev {
        return Err(IpcError::new(ErrorCode::Conflict, text_stt::caption_doc_conflict(cur_rev, base_rev)));
    }
    doc.rev = cur_rev + 1;
    let plan = caption_plan(&doc)?;
    write_doc_at(&path, &doc)?;
    Ok(CaptionSaved { rev: doc.rev, plan })
}

/// 재전사로 덮기(순수 코어): 직전 판을 `.bak` 한 세대로 남기고 `rev`는 이어서 올린다(다른 창의 미저장 편집이
/// 옛 rev로 저장하려 하면 Conflict가 난다). 손상된 직전 판도 `.bak`으로 보존하고 덮는다.
pub fn write_transcribed_at(
    root: &Path,
    project_id: &str,
    rel: &str,
    mut doc: CaptionDoc,
) -> Result<CaptionLoaded, IpcError> {
    doc.version = DOC_VERSION;
    doc.source.rel = normalize_rel(rel);
    validate_doc(&mut doc)?;
    let _g = CAPTION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = doc_path(root, project_id, rel);
    let prev_rev = match std::fs::read(&path) {
        Ok(bytes) => {
            if peek_version(&bytes).is_some_and(|v| v > u64::from(DOC_VERSION)) {
                return Err(newer_version(&path));
            }
            let bak = path.with_extension("json.bak");
            std::fs::write(&bak, &bytes)
                .map_err(|e| io(text_stt::caption_doc_backup_failed(&bak.display(), &e)))?;
            // 손상된 판이면 rev를 알 수 없다 — 0부터 이어 간다(원본은 방금 .bak으로 남겼다).
            let prev = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
            // 자막 스타일은 인식 결과와 무관한 사용자 선택이라 이어 간다(번역·컷은 cue·토큰 id가 바뀌어 못 잇는다).
            // 손상됐거나 모르는 값이면 기본 스타일로 — 직전 판은 .bak에 그대로 있다.
            doc.style_preset =
                prev.as_ref().and_then(|v| serde_json::from_value(v.get("stylePreset")?.clone()).ok());
            prev.and_then(|v| v.get("rev")?.as_u64()).unwrap_or(0)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(io(text_stt::caption_doc_read_failed(&path.display(), &e))),
    };
    doc.rev = prev_rev + 1;
    let plan = caption_plan(&doc)?;
    write_doc_at(&path, &doc)?;
    Ok(CaptionLoaded { doc, stale: false, plan })
}

fn data_root(app: &AppHandle) -> Result<PathBuf, IpcError> {
    crate::state::data_root(app).ok_or_else(|| io(text_stt::caption_app_data_dir_not_found().into()))
}

/// 다른 창에 알린다 — 받는 쪽에 미저장 편집이 없으면 다시 읽고, 있으면 충돌 배너(§3.4).
fn emit_changed(app: &AppHandle, project_id: &str, rel_path: &str, rev: u64) {
    let _ = app.emit(
        "caption://changed",
        CaptionChanged { project_id: project_id.to_string(), rel_path: rel_path.to_string(), rev },
    );
}

/// 전사 결과 저장 — transcribe.rs가 부른다.
pub(crate) fn write_transcribed(
    app: &AppHandle,
    project_id: &str,
    rel_path: &str,
    doc: CaptionDoc,
) -> Result<CaptionLoaded, IpcError> {
    let loaded = write_transcribed_at(&data_root(app)?, project_id, rel_path, doc)?;
    emit_changed(app, project_id, rel_path, loaded.doc.rev);
    Ok(loaded)
}

fn no_doc() -> IpcError {
    IpcError::new(ErrorCode::NotFound, text_stt::caption_doc_missing())
}

/// 자막 파일 내보내기(subs.rs)가 쓰는 읽기 — 없으면 NotFound.
pub(crate) fn load_required(app: &AppHandle, project_id: &str, rel_path: &str) -> Result<CaptionDoc, IpcError> {
    load_at(&data_root(app)?, project_id, rel_path, None)?.map(|l| l.doc).ok_or_else(no_doc)
}

/// 영상 내보내기(video_export — 편집본 `caption_cut`·자막 입힌 영상 `caption_subs`)가 쓰는 저장본(순수 코어).
/// 남길 구간·자막은 저장본으로만 계산한다(§3.4). 편집본(`cut`)이면 근사 단어 시각·원본이 바뀐 문서·전부 잘린 문서를
/// 거절한다: 컷 위치가 말과 어긋나 지운 말이 남거나 남긴 말이 잘린다. 자막만 싣는 원본 시각 내보내기는 자막 파일
/// 내보내기(subs.rs)와 같이 stale을 막지 않는다 — 프론트가 배너로 알린다.
pub fn export_doc_at(
    root: &Path,
    project_id: &str,
    rel: &str,
    source_stamp: Option<(u64, u64)>,
    cut: bool,
) -> Result<CaptionLoaded, IpcError> {
    let loaded = load_at(root, project_id, rel, source_stamp)?.ok_or_else(no_doc)?;
    if !cut {
        return Ok(loaded);
    }
    if loaded.doc.engine.word_timing == WordTiming::Approx {
        // 다시 인식하라고 하지 않는다 — brew 엔진은 다시 돌려도 근사값일 수 있고, macOS엔 관리형 엔진이 없다(9절 42).
        return Err(io(text_stt::caption_cut_approx_word_timing().into()));
    }
    if loaded.stale {
        return Err(io(text_stt::caption_cut_source_changed().into()));
    }
    if loaded.plan.keep.is_empty() {
        return Err(io(text_stt::caption_cut_nothing_left().into()));
    }
    Ok(loaded)
}

pub(crate) fn load_export_doc(
    app: &AppHandle,
    project_id: &str,
    rel_path: &str,
    src: &Path,
    cut: bool,
) -> Result<CaptionLoaded, IpcError> {
    export_doc_at(&data_root(app)?, project_id, rel_path, file_stamp(src), cut)
}

#[tauri::command(async)]
pub fn caption_doc_load(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<Option<CaptionLoaded>, IpcError> {
    let repo = crate::commands::project_path(&state, &project_id)?;
    // 원본이 옮겨졌거나 지워졌으면(상위 폴더째 사라지면 resolve도 실패) stale로 본다 — 문서는 그대로 연다(§3.3).
    let stamp = crate::commands::resolve_in_repo(&repo, &rel_path)
        .ok()
        .and_then(|p| file_stamp(&p));
    load_at(&data_root(&app)?, &project_id, &rel_path, stamp)
}

#[tauri::command(async)]
pub fn caption_doc_save(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
    doc: CaptionDoc,
    base_rev: u64,
) -> Result<CaptionSaved, IpcError> {
    crate::commands::project_path(&state, &project_id)?;
    let saved = save_at(&data_root(&app)?, &project_id, &rel_path, doc, base_rev)?;
    emit_changed(&app, &project_id, &rel_path, saved.rev);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::build_doc;
    use crate::stt::doc::tests::{engine, source, w};
    use crate::stt::video_subs::CaptionStylePreset;

    fn doc() -> CaptionDoc {
        build_doc(source(4000), engine("ko"), vec![w(500, 900, "하나", 0), w(1000, 1400, "둘", 0)])
    }

    /// 문서 키는 경로 탈출이 불가능하다 — `..`·절대경로·중첩 저장소 id 모두 `captions/<폴더>/<해시>.json`.
    #[test]
    fn caption_doc_key_cannot_escape() {
        let root = Path::new("/data");
        for (pid, rel) in [
            ("3b2f0c1e-aaaa-bbbb-cccc-000000000000", "../../../etc/passwd"),
            ("outer::sub/../../x", "a.mp4"),
            ("..", "/abs/clip.mp4"),
            ("C:", "clip.mp4"),
        ] {
            let p = doc_path(root, pid, rel);
            let rel_part = p.strip_prefix(root.join("captions")).expect("captions 밖");
            let comps: Vec<_> = rel_part.components().collect();
            assert_eq!(comps.len(), 2, "{pid} {rel} → {}", p.display());
            assert!(comps.iter().all(|c| matches!(c, std::path::Component::Normal(_))));
        }
        // 같은 파일의 다른 표기는 같은 키.
        assert_eq!(doc_path(root, "p", "dir\\clip.mp4"), doc_path(root, "p", "./dir/clip.mp4"));
        assert_ne!(doc_path(root, "p", "a.mp4"), doc_path(root, "p", "b.mp4"));
        assert!(doc_path(root, "p", "a.mp4").starts_with(root.join("captions").join("p")));
    }

    /// 저장 규칙: base_rev 0으로 새로 만들고, 저장마다 rev+1, 낡은 base_rev는 Conflict.
    #[test]
    fn caption_save_checks_rev() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(load_at(root, "p", "a.mp4", None).unwrap().is_none());
        let s1 = save_at(root, "p", "a.mp4", doc(), 0).unwrap();
        assert_eq!(s1.rev, 1);
        let s2 = save_at(root, "p", "a.mp4", doc(), 1).unwrap();
        assert_eq!(s2.rev, 2);
        let stale = save_at(root, "p", "a.mp4", doc(), 1).unwrap_err();
        assert_eq!(stale.code, ErrorCode::Conflict);
        let loaded = load_at(root, "p", "a.mp4", Some((10, 20))).unwrap().unwrap();
        assert_eq!(loaded.doc.rev, 2);
        assert!(!loaded.stale, "크기·시각이 같으면 stale 아님");
        assert!(load_at(root, "p", "a.mp4", Some((11, 20))).unwrap().unwrap().stale);
        assert!(load_at(root, "p", "a.mp4", None).unwrap().unwrap().stale, "원본 없음 = stale");
        // 구조가 틀린 문서는 저장 전에 막는다(디스크는 그대로).
        let mut broken = doc();
        broken.cues.clear();
        assert!(save_at(root, "p", "a.mp4", broken, 2).is_err());
        assert_eq!(load_at(root, "p", "a.mp4", None).unwrap().unwrap().doc.rev, 2);
    }

    /// 새 앱이 쓴 더 높은 version은 저장·재전사로 덮지 않는다(옛 앱이 망가뜨리지 않게). 읽기는 모양이 맞으면 된다.
    #[test]
    fn caption_rejects_saving_over_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = doc_path(root, "p", "a.mp4");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut v = serde_json::to_value(doc()).unwrap();
        v["version"] = 2.into();
        v["rev"] = 5.into();
        v["futureField"] = "x".into();
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(load_at(root, "p", "a.mp4", None).unwrap().unwrap().doc.version, 2);
        assert!(save_at(root, "p", "a.mp4", doc(), 5).unwrap_err().message.contains("새 버전"));
        assert!(write_transcribed_at(root, "p", "a.mp4", doc()).is_err());
        // 모양까지 달라 못 읽는 새 버전도 "손상"이 아니라 "새 버전"이라고 말한다.
        std::fs::write(&path, br#"{"version":3,"somethingElse":true}"#).unwrap();
        assert!(load_at(root, "p", "a.mp4", None).unwrap_err().message.contains("새 버전"));
    }

    /// 편집본의 남길 구간은 저장본의 계획 그대로 — 근사 단어 시각·원본 변경·전부 잘림·문서 없음은 거절.
    /// 자막만 싣는 원본 시각 내보내기(`cut` 아님)는 문서 없음만 거절한다.
    #[test]
    fn caption_cut_keep_rejects_approx_stale_and_empty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let stamp = Some((10, 20));
        let cut_keep_at = |stamp| export_doc_at(root, "p", "a.mp4", stamp, true).map(|l| l.plan.keep);
        assert_eq!(cut_keep_at(stamp).unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(export_doc_at(root, "p", "a.mp4", stamp, false).unwrap_err().code, ErrorCode::NotFound);

        let mut d = doc();
        d.tokens.iter_mut().find(|t| t.text == "둘").unwrap().cut = true;
        save_at(root, "p", "a.mp4", d.clone(), 0).unwrap();
        let keep = cut_keep_at(stamp).unwrap();
        assert_eq!(keep, caption_plan(&d).unwrap().keep);
        assert_eq!(keep.len(), 2, "잘린 어절 앞뒤 두 구간: {keep:?}");
        assert!(cut_keep_at(Some((11, 20))).unwrap_err().message.contains("원본 영상이 바뀌어"));
        assert!(cut_keep_at(None).is_err(), "원본 없음 = stale");

        let mut approx = d.clone();
        approx.engine.word_timing = WordTiming::Approx;
        save_at(root, "p", "a.mp4", approx, 1).unwrap();
        assert!(cut_keep_at(stamp).unwrap_err().message.contains("근사값"));

        let mut all_cut = d;
        all_cut.tokens.iter_mut().for_each(|t| t.cut = true);
        save_at(root, "p", "a.mp4", all_cut, 2).unwrap();
        assert!(cut_keep_at(stamp).unwrap_err().message.contains("남는 구간이 없습니다"));
    }

    /// 재전사: 직전 판을 .bak으로 남기고 rev를 이어 간다. 손상된 직전 판도 보존하고 덮는다.
    #[test]
    fn caption_transcribe_overwrite_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let first = write_transcribed_at(root, "p", "a.mp4", doc()).unwrap();
        assert_eq!(first.doc.rev, 1);
        assert_eq!(first.doc.style_preset, None);
        let mut styled = doc();
        styled.style_preset = Some(CaptionStylePreset::Box);
        save_at(root, "p", "a.mp4", styled, 1).unwrap();
        let again = write_transcribed_at(root, "p", "a.mp4", doc()).unwrap();
        assert_eq!(again.doc.rev, 3);
        assert_eq!(again.doc.style_preset, Some(CaptionStylePreset::Box), "재전사해도 자막 스타일은 남는다");
        let bak = doc_path(root, "p", "a.mp4").with_extension("json.bak");
        let prev: CaptionDoc = serde_json::from_slice(&std::fs::read(&bak).unwrap()).unwrap();
        assert_eq!(prev.rev, 2);

        std::fs::write(doc_path(root, "p", "a.mp4"), b"{broken").unwrap();
        assert!(load_at(root, "p", "a.mp4", None).unwrap_err().message.contains("손상"));
        let fresh = write_transcribed_at(root, "p", "a.mp4", doc()).unwrap();
        assert_eq!(fresh.doc.rev, 1);
        assert_eq!(std::fs::read(&bak).unwrap(), b"{broken");
    }
}
