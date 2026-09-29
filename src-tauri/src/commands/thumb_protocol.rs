//! 썸네일 전용 URI 스킴 `gpvthumb` — 폴더 창 그리드·즐겨찾기 미리보기가 `<img src>` 로 썸네일을
//! 직접 받는다.
//!
//! 전에는 `fav_thumb` IPC 가 base64 data URL 을 돌려줬다. 3천 장 폴더에서 그게 병목이었다 — 응답마다
//! 문자열이 IPC 를 타고, 프론트 `call` 의 앱 공유 동시 8 슬롯을 썸네일이 다 먹어 다른 IPC 가 막히고,
//! 디코드 대기가 8초를 넘으면 같은 요청이 재시도돼 일을 두 번 했다. `<img>` 면 로딩·디코딩·동시성을
//! 브라우저가 맡고 React 상태가 필요 없다. 캐시·디코드는 `favorites::thumb_jpeg` 한 곳이다.
//!
//! URL 은 프론트가 `convertFileSrc(절대경로, "gpvthumb")` 로 만든다(OS 마다 모양이 다른 것을 그게 흡수한다):
//!   Windows `http://gpvthumb.localhost/<경로 %인코딩>?e=<edge>&t=<토큰>&v=<mtime ms>-<크기>`
//!   macOS·Linux `gpvthumb://localhost/<경로 %인코딩>?…`
//! URL 에 스탬프(`v`)가 있어 파일이 바뀌면 URL 도 바뀐다 — 그래서 응답은 `immutable` 로 캐시시킨다.
//!
//! ## 보안 경계
//! 스킴은 **이 프로세스의 모든 웹뷰**에 등록된다 — 인앱 브라우저(네이티브 자식 웹뷰)에 뜬 외부 페이지도
//! `<img src="http://gpvthumb.localhost/…">` 를 만들 수 있다. 그래서 셋을 다 통과해야 한다:
//! 1. 프로세스마다 새로 뽑은 토큰(`thumb_token`, 122비트 난수)이 URL 에 있어야 한다 — 틀리면 403.
//!    토큰은 `fav_thumb_token` IPC 로만 나가고, 외부 origin 은 IPC 를 부를 수 없다(capabilities 가 앱
//!    origin 만 허용한다).
//! 2. 경로는 다른 `fav_*` 와 **같은 `allowed`** 를 지난다(허용 루트·canonicalize — `..`·정션·드라이브
//!    전환·UNC 는 canonicalize 뒤 루트 비교에서 떨어진다).
//! 3. edge 는 `EDGES` 셋뿐이다(캐시 폭주 방지).
//! 실패는 바디 없는 4xx 다 — 프론트는 `onError` 로 아이콘을 남긴다(이유를 보여 줄 자리가 없다).

use std::sync::OnceLock;

use tauri::http::{header, HeaderValue, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder, Wry};

use super::favorites::{allowed, thumb_jpeg, FileStamp, EDGES};
use crate::error::{ErrorCode, IpcError};
use crate::state::AppState;

/// 스킴 이름 — 프론트 `lib/fav-thumb.ts` 와 CSP(`tauri.conf.json` img-src)가 같은 이름을 쓴다.
pub const THUMB_SCHEME: &str = "gpvthumb";

fn thumb_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}

/// 앱 페이지가 썸네일 URL 에 붙일 토큰. 프로세스마다 바뀐다(창은 새로 열 때마다 묻는다).
#[tauri::command(async)]
pub fn fav_thumb_token() -> Result<String, IpcError> {
    Ok(thumb_token().to_string())
}

/// `Builder::register_asynchronous_uri_scheme_protocol` 에 넘기는 처리기.
///
/// Windows(WebView2)는 이 콜백을 **UI 스레드**에서 부른다 — 여기서 디스크를 만지면 창이 멈춘다.
/// 곧바로 async 런타임으로 넘기고, 디스크 일은 그 안에서 다시 blocking 풀로 간다.
pub fn thumb_scheme_handler(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let (path, query) = (
        request.uri().path().to_string(),
        request.uri().query().unwrap_or("").to_string(),
    );
    tauri::async_runtime::spawn(async move {
        let res = match serve(app, &path, &query).await {
            Ok(jpeg) => {
                let mut r = Response::new(jpeg);
                let h = r.headers_mut();
                h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
                h.insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("max-age=31536000, immutable"),
                );
                r
            }
            Err(status) => {
                let mut r = Response::new(Vec::new());
                *r.status_mut() = status;
                r
            }
        };
        responder.respond(res);
    });
}

async fn serve(app: AppHandle, path: &str, query: &str) -> Result<Vec<u8>, StatusCode> {
    let req = parse_thumb_request(path, query, thumb_token())?;
    let gate = app.clone();
    let target = req.path;
    let file = tauri::async_runtime::spawn_blocking(move || {
        let state = gate
            .try_state::<AppState>()
            .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
        allowed(&state, &target).map_err(|e| gate_status(&e))
    })
    .await
    .map_err(|e| {
        log::error!("[thumbs] 경로 판정 작업이 죽었습니다: {e}"); // i18n-ok: 로그
        StatusCode::INTERNAL_SERVER_ERROR
    })??;
    // 못 만드는 형식(svg·손상·한도 초과)은 흔하다(스크린샷 폴더의 svg) — 로그를 남기지 않고 415 로 알린다.
    thumb_jpeg(&app, file, req.stamp, req.edge)
        .await
        .map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)
}

/// 허용 루트 밖(미등록·`.git`)은 403, 없는 파일은 404.
fn gate_status(e: &IpcError) -> StatusCode {
    if e.code == ErrorCode::NotFound {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::FORBIDDEN
    }
}

#[derive(Debug, PartialEq)]
struct ThumbRequest {
    path: String,
    edge: u32,
    stamp: FileStamp,
}

/// URI 의 경로·쿼리를 검사해 푼다. **토큰을 먼저 본다** — 토큰이 없거나 틀리면 나머지가 무엇이든 403 이라,
/// 토큰 없는 쪽은 경로·크기 규칙을 떠볼 수도 없다.
fn parse_thumb_request(path: &str, query: &str, token: &str) -> Result<ThumbRequest, StatusCode> {
    let param = |key: &str| {
        query
            .split('&')
            .find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
    };
    if !param("t").is_some_and(|t| same_token(t, token)) {
        return Err(StatusCode::FORBIDDEN);
    }
    let edge = param("e")
        .and_then(|e| e.parse::<u32>().ok())
        .filter(|e| EDGES.contains(e))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let stamp = param("v")
        .and_then(|v| v.split_once('-'))
        .and_then(|(m, s)| Some((m.parse::<u64>().ok()?, s.parse::<u64>().ok()?)))
        .ok_or(StatusCode::BAD_REQUEST)?;
    // 경로는 첫 `/` 뒤 한 세그먼트다(`encodeURIComponent` 라 구분자까지 인코딩돼 있다).
    let enc = path.strip_prefix('/').unwrap_or(path);
    let path = percent_encoding::percent_decode_str(enc)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .into_owned();
    if path.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(ThumbRequest { path, edge, stamp })
}

/// 길이가 같으면 끝까지 다 비교한다 — 앞에서부터 맞는 글자 수가 응답 시간으로 새지 않게.
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOK: &str = "0123456789abcdef0123456789abcdef";
    /// 프론트의 `encodeURIComponent` 와 같은 결과 — 영숫자와 `-_.!~*'()` 만 남긴다.
    fn enc(p: &str) -> String {
        const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
            .remove(b'-')
            .remove(b'_')
            .remove(b'.')
            .remove(b'!')
            .remove(b'~')
            .remove(b'*')
            .remove(b'\'')
            .remove(b'(')
            .remove(b')');
        format!("/{}", percent_encoding::utf8_percent_encode(p, KEEP))
    }

    #[test]
    fn parses_a_well_formed_request() {
        let p = r"C:\Users\u\Pictures\스크린샷 1.png";
        let got = parse_thumb_request(&enc(p), &format!("e=192&t={TOK}&v=1727600000123-70"), TOK);
        assert_eq!(
            got,
            Ok(ThumbRequest { path: p.to_string(), edge: 192, stamp: (1727600000123, 70) })
        );
        // 쿼리 순서는 상관없다
        assert!(parse_thumb_request(&enc(p), &format!("v=1-2&t={TOK}&e=128"), TOK).is_ok());
    }

    /// 토큰이 없거나 틀리면 403 — 다른 필드가 틀렸어도(400 이 아니라) 403 이다.
    #[test]
    fn missing_or_wrong_token_is_forbidden() {
        let p = enc(r"C:\x\a.png");
        let forbidden = Err(StatusCode::FORBIDDEN);
        assert_eq!(parse_thumb_request(&p, "e=192&v=1-2", TOK), forbidden, "토큰 없음");
        assert_eq!(parse_thumb_request(&p, "e=192&t=&v=1-2", TOK), forbidden, "빈 토큰");
        let wrong = "0123456789abcdef0123456789abcdee";
        assert_eq!(parse_thumb_request(&p, &format!("e=192&t={wrong}&v=1-2"), TOK), forbidden);
        assert_eq!(parse_thumb_request(&p, &format!("e=192&t={TOK}0&v=1-2"), TOK), forbidden, "뒤에 덧붙임");
        assert_eq!(parse_thumb_request(&p, &format!("e=192&t={}&v=1-2", &TOK[..31]), TOK), forbidden, "앞부분만");
        assert_eq!(parse_thumb_request(&p, &format!("e=256&T={TOK}"), TOK), forbidden, "키는 소문자 t 만");
        assert_eq!(parse_thumb_request(&p, &format!("e=256&t={wrong}"), TOK), forbidden, "크기도 틀려도 403 이 먼저");
    }

    #[test]
    fn edge_outside_the_three_sizes_is_rejected() {
        let p = enc(r"C:\x\a.png");
        for e in ["256", "0", "-1", "192.0", "", "1920"] {
            assert_eq!(
                parse_thumb_request(&p, &format!("e={e}&t={TOK}&v=1-2"), TOK),
                Err(StatusCode::BAD_REQUEST),
                "e={e}"
            );
        }
        assert_eq!(parse_thumb_request(&p, &format!("t={TOK}&v=1-2"), TOK), Err(StatusCode::BAD_REQUEST));
    }

    #[test]
    fn malformed_stamp_or_path_is_rejected() {
        let ok_q = format!("e=192&t={TOK}&v=1-2");
        for v in ["", "1", "1-", "-2", "a-2", "1-b", "1_2"] {
            assert_eq!(
                parse_thumb_request(&enc("/x/a.png"), &format!("e=192&t={TOK}&v={v}"), TOK),
                Err(StatusCode::BAD_REQUEST),
                "v={v}"
            );
        }
        assert_eq!(parse_thumb_request("/", &ok_q, TOK), Err(StatusCode::BAD_REQUEST), "빈 경로");
        assert_eq!(parse_thumb_request("/%FF%FE", &ok_q, TOK), Err(StatusCode::BAD_REQUEST), "UTF-8 아님");
    }

    /// 경로 트래버설은 파서가 아니라 `allowed` 가 막는다 — 파서는 디코딩만 하고, 디코딩된 경로가
    /// canonicalize 뒤 허용 루트 밖이면 떨어진다. `..` 로 올라가기·형제 폴더·다른 드라이브·UNC 를 URL 에서
    /// 디코딩한 그대로 게이트에 넣어 확인한다(스킴 처리기와 같은 순서).
    #[test]
    fn traversal_in_the_url_path_is_stopped_by_the_gate() {
        let base = std::env::temp_dir().join(format!("gpv-thumbproto-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("in.png"), b"x").unwrap();
        std::fs::write(outside.join("secret.png"), b"x").unwrap();
        let favs = vec![root.to_string_lossy().to_string()];
        let q = format!("e=192&t={TOK}&v=1-2");
        let gate = |raw: &str| {
            let req = parse_thumb_request(&enc(raw), &q, TOK).expect("형식은 맞다");
            super::super::favorites::allowed_in(std::path::Path::new(&req.path), &favs, &[])
        };
        let sep = std::path::MAIN_SEPARATOR;
        let r = root.to_string_lossy().to_string();

        assert!(gate(&format!("{r}{sep}in.png")).is_ok(), "대조: 루트 안 파일은 통과");
        assert!(gate(&format!("{r}{sep}..{sep}outside{sep}secret.png")).is_err(), "`..` 로 루트 밖");
        assert!(gate(&format!("{r}{sep}..{sep}..{sep}..")).is_err(), "`..` 여러 번");
        assert!(gate(&outside.join("secret.png").to_string_lossy()).is_err(), "형제 폴더 절대경로");
        #[cfg(windows)]
        {
            // 드라이브 전환·UNC(관리 공유로 같은 파일을 가리켜도)·장치 경로 — 전부 루트 문자열과 접두가 다르다.
            let drive = r.chars().next().unwrap();
            let other = if drive.eq_ignore_ascii_case(&'C') { 'D' } else { 'C' };
            assert!(gate(&format!("{other}{}", &r[1..])).is_err(), "다른 드라이브의 같은 경로");
            let unc = format!(r"\\localhost\{drive}${}\..\outside\secret.png", &r[2..]);
            assert!(gate(&unc).is_err(), "UNC 로 돌아 들어가기: {unc}");
            assert!(gate(r"\\?\C:\Windows\win.ini").is_err(), "장치 경로");
        }
        #[cfg(not(windows))]
        assert!(gate("/etc/passwd").is_err(), "루트 밖 절대경로");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn token_compare_needs_exact_match() {
        assert!(same_token(TOK, TOK));
        assert!(!same_token(TOK, &TOK[..31]));
        assert!(!same_token("", TOK));
        assert_eq!(thumb_token().len(), 32, "uuid v4 simple — 122비트 난수");
        assert_eq!(thumb_token(), thumb_token(), "프로세스 안에서는 하나");
    }
}
