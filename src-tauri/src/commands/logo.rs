// 프로젝트 로고 탐색 — 사이드바가 프로젝트 이름 옆에 16px로 그린다.
//
// 새로 만든 건 후보 목록뿐이고 나머지는 전부 기존 선례를 그대로 쓴다:
// - 경로 탈출 방어: tree.rs `resolve_in_repo`(상위 정규화 + 레포 컨테인먼트)
//                   + 최종 컴포넌트 심볼릭 거부(write_file과 같은 방어)
//
// GitHub 폴백은 **의도적으로 없다**. `github.com/<owner>.png`는 레포 로고가 아니라 계정
// 아바타라, 한 사람이 만든 레포 9개가 사이드바에서 똑같은 그림을 달았다(2026-09-04 실측).
// 프로젝트를 구별하려고 넣은 것이 구별을 지웠다 — 색 스트라이프가 이미 하는 일을 덮는다.

use std::path::Path;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::State;

use super::projects::project_path;
use super::tree::resolve_in_repo;
use crate::error::IpcError;
use crate::state::AppState;

/// 사이드바 로고 1건. `source`는 툴팁에 그대로 보여 줄 출처다 —
/// 레포 상대 경로(`public/logo.png`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLogo {
    pub data_uri: String,
    pub source: String,
}

/// 이보다 작으면 무시한다 — Tauri 스캐폴딩이 남기는 98바이트짜리 `icon.png` 같은
/// 빈 자리표시자가 실재한다(keywizard 실측). 통과시키면 사이드바에 보이지 않는 점이 하나 붙는다.
const MIN_BYTES: u64 = 512;
/// 아예 읽지 않는 상한 — 로고 자리에 놓인 거대 파일(4K 스크린샷 등)로 디코드를 태우지 않는다.
const READ_MAX: u64 = 4 * 1024 * 1024;
/// 이 크기 이하는 바이트 그대로 실어 보낸다 — 웹뷰가 16px `<img>`로 줄여 그리므로
/// 작은 파일의 재인코딩은 순수 낭비다(디코더를 태우고 결과는 똑같이 16px이 된다).
const PASSTHROUGH_MAX: usize = 200 * 1024;
/// 큰 래스터의 축소 목표 — 16px 표시라 HiDPI 4배를 감안해도 64px이면 남는다.
const THUMB: u32 = 64;

/// 후보 디렉토리 — `""`는 레포 루트.
const DIRS: [&str; 11] = [
    "",
    "public",
    "assets",
    "static",
    "docs",
    ".github",
    "src/assets",
    "resources",
    "img",
    "images",
    "src-tauri/icons",
];
/// 후보 이름 — 의도가 강한 순서.
const NAMES: [&str; 6] = ["logo", "icon", "app-icon", "favicon", "128x128", "512x512"];
/// 후보 확장자 — svg가 먼저(어느 배율에서도 정답), 그다음 무손실 → 손실 → 아이콘 컨테이너.
const EXTS: [&str; 6] = ["svg", "png", "webp", "jpg", "jpeg", "ico"];

/// 후보 경로를 **탐색 순서대로** 만든다 — 순수 함수(테스트 대상).
///
/// 이름을 가장 바깥에 두는 이유: 의도의 세기는 위치보다 이름이 말한다. `public/logo.png`가
/// 루트 `favicon.ico`보다 로고답다. 같은 이름 안에서는 루트 → 관례 폴더 순.
fn logo_candidates() -> Vec<String> {
    let mut out = Vec::with_capacity(NAMES.len() * DIRS.len() * EXTS.len());
    for name in NAMES {
        for dir in DIRS {
            for ext in EXTS {
                out.push(if dir.is_empty() {
                    format!("{name}.{ext}")
                } else {
                    format!("{dir}/{name}.{ext}")
                });
            }
        }
    }
    out
}

/// 확장자 → data URI MIME. 후보 6종만 다룬다(diff.rs `mime_of`는 private이고 뷰어용이라 범위가 다르다).
/// MIME이 틀리면 디코드 가능한 플랫폼에서도 브라우저가 시도조차 하지 않는다.
fn logo_mime(ext: &str) -> &'static str {
    match ext {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// 바이트 → data URI. 못 만들면 None(= 로고 없음, 오류 아님).
fn encode_logo(bytes: &[u8], rel: &str) -> Option<String> {
    let ext = rel.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    // SVG는 래스터화하지 않는다 — 벡터 그대로가 어느 배율에서도 정답이다.
    if ext == "svg" || bytes.len() <= PASSTHROUGH_MAX {
        return Some(format!(
            "data:{};base64,{}",
            logo_mime(&ext),
            B64.encode(bytes)
        ));
    }
    // 큰 래스터만 64px로 줄여 PNG로 다시 싼다 — 200KB+를 IPC로 실어 봐야 16px에서 버려진다.
    // 디코드 실패는 오류가 아니라 "로고 없음"이다(image 크레이트 피처가 png/jpeg뿐이라
    // 200KB 넘는 webp/ico는 여기서 조용히 탈락한다 — 그런 파일을 로고로 쓰는 레포는 드물다).
    let img = image::load_from_memory(bytes).ok()?.thumbnail(THUMB, THUMB);
    let mut png = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        B64.encode(png.into_inner())
    ))
}

/// 로컬 후보를 순서대로 훑어 **첫 번째로 존재하는 정규 파일**을 로고로 쓴다.
///
/// std::fs 동기 호출인 이유: 후보가 수백 개라 tokio::fs로 하면 항목마다 블로킹 풀 왕복이 생긴다
/// (tree.rs `read_dir_raw`가 같은 이유로 spawn_blocking 단일 패스다). 호출부에서 한 번 감싼다.
///
/// ponytail: 후보 전수 stat(≈400회/프로젝트). 실측상 워밍 후 한 자릿수 ms라 그냥 훑는다 —
/// 눈에 띄면 존재하는 디렉토리부터 걸러라(11번의 is_dir로 대부분이 날아간다).
fn find_local_logo(repo: &Path) -> Option<ProjectLogo> {
    for rel in logo_candidates() {
        // 존재 확인이 먼저다 — 후보 대부분은 없고, resolve_in_repo는 canonicalize 2회라 비싸다.
        let Ok(meta) = std::fs::symlink_metadata(repo.join(&rel)) else {
            continue;
        };
        // 정규 파일만. 심볼릭 링크를 따라가면 `logo.png` → `~/.ssh/id_rsa` 하나로 이 커맨드가
        // 임의 파일을 base64로 프론트에 실어 나르는 통로가 된다(write_file과 같은 방어).
        if !meta.is_file() || meta.len() < MIN_BYTES || meta.len() > READ_MAX {
            continue;
        }
        // 존재하는 후보에 대해서만 컨테인먼트를 단언한다 — 중간 경로가 레포 밖을 가리키는
        // 정션/심볼릭(`public` → C:\secrets)이면 여기서 걸린다.
        let Ok(path) = resolve_in_repo(repo, &rel) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        // 첫 히트에서 끝낸다 — 인코딩이 실패해도 다음 후보로 넘어가지 않는다.
        // 가장 의도적인 이름이 깨져 있으면 그 레포엔 쓸 로고가 없는 것으로 본다.
        return encode_logo(&bytes, &rel).map(|data_uri| ProjectLogo {
            data_uri,
            source: rel,
        });
    }
    None
}

/// **로고가 없는 건 오류가 아니다.** Ok(None)이면 프론트는 조용히 아이콘 자리를 비운다
/// (토스트 금지 — 대부분의 레포에 로고가 없다).
#[tauri::command]
pub async fn project_logo(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Option<ProjectLogo>, IpcError> {
    let repo = project_path(&state, &project_id)?;
    // 후보 전수 stat + 디코드는 블로킹 1회로 묶는다(tree.rs read_dir_raw와 같은 이유).
    Ok(tokio::task::spawn_blocking(move || find_local_logo(&repo))
        .await
        .ok()
        .flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SSH·HTTPS 양쪽에서 owner가 나와야 한다. 여기서 통과한 문자열이 그대로 캐시 파일명이
    /// 되므로, GitHub이 아닌 원격과 이상한 문자는 반드시 None이어야 한다.
    #[test]
    fn candidate_order_is_most_intentional_first() {
        let c = logo_candidates();
        let idx = |p: &str| {
            c.iter()
                .position(|x| x == p)
                .unwrap_or_else(|| panic!("{p} 후보가 빠졌다"))
        };
        assert_eq!(c[0], "logo.svg", "가장 의도가 분명한 후보가 첫 번째다");
        assert!(idx("logo.svg") < idx("public/logo.png"));
        assert!(idx("public/logo.png") < idx("src-tauri/icons/128x128.png"));
        // 중복이 있으면 같은 파일을 두 번 stat한다
        let mut uniq = c.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), c.len(), "후보에 중복이 있다");
    }

    /// 후보 확장자는 전부 MIME이 매핑돼야 한다 — 틀리면 표시가 조용히 실패한다.
    #[test]
    fn mime_covers_every_candidate_extension() {
        for ext in EXTS {
            assert_ne!(
                logo_mime(ext),
                "application/octet-stream",
                "{ext}의 MIME이 빠졌다"
            );
        }
        assert_eq!(logo_mime("svg"), "image/svg+xml");
        assert_eq!(logo_mime("png"), "image/png");
        assert_eq!(logo_mime("webp"), "image/webp");
        assert_eq!(logo_mime("jpg"), "image/jpeg");
        assert_eq!(logo_mime("jpeg"), "image/jpeg");
        assert_eq!(logo_mime("ico"), "image/x-icon");
    }

    /// SVG는 래스터화하지 않고 그대로 실어 보낸다(벡터가 어느 배율에서도 정답).
    #[test]
    fn svg_passes_through_unchanged() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'/>";
        let uri = encode_logo(svg, "logo.svg").expect("svg는 항상 인코딩된다");
        assert_eq!(
            uri,
            format!("data:image/svg+xml;base64,{}", B64.encode(svg))
        );
    }
}
