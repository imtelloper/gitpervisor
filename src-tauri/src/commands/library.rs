//! 이미지 편집기 스타일·컴포넌트 라이브러리 — **앱 전역** 영속 (태스크 51 §3.1).
//!
//! 사이드카(image_doc.rs)와 갈라지는 지점은 하나다: 이것은 이미지에 묶이지 않는다.
//! 브랜드 색·워터마크 컴포넌트는 이미지 한 장의 속성이 아니라 사용자의 것이라
//! `app_data_dir/image-library.json` 파일 **하나**에 산다. 그래서 저장도 projects/settings와
//! 같은 [crate::state::save_json] 을 그대로 탄다 — 같은 `SAVE_LOCK`, 같은 tmp+rename,
//! 같은 `.corrupt` 격리를 새로 쓰는 줄 없이 얻는다.
//!
//! **내용은 Rust가 모른다.** 스키마 소유자는 `src/stores/imageLibrary.ts`(`normalizeLibrary`)고,
//! 여기서는 `serde_json::Value` 로만 다룬다. 태스크 52가 내보내기 프리셋 슬라이스를 같은 파일에
//! 얹기로 돼 있는데(51 §3.1), 여기서 구조체로 받으면 그때 Rust가 같이 흔들리고 — 더 나쁘게 —
//! 모르는 키가 역직렬화에서 조용히 사라져 **다른 버전이 쓴 값을 삭제**하게 된다.

use serde::Serialize;
use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_files;

const LIBRARY_FILE: &str = "image-library.json";
const LIBRARY_KEY: &str = "library";

/// 라이브러리 1벌의 상한. 실사용은 수십 KB지만(컴포넌트 썸네일이 96px PNG dataURL ≈4KB),
/// 펜 점 수천 개짜리 컴포넌트를 계속 담으면 자란다. 상한이 없으면 이 문자열이 IPC를 통째로
/// 건너오는 순간 WebView가 문자열 하나에 멈춘다(image_doc.rs와 같은 판단).
const MAX_BYTES: usize = 8 << 20;

/// 저장 알림. 라이브러리는 앱 전역인데 zustand 스토어는 **창마다 따로**라(DocWindow),
/// 신호가 없으면 doc 창에서 만든 색 스타일이 메인 창 팝오버에 영영 나타나지 않는다.
///
/// `origin` 을 JS 인자가 아니라 **창 핸들**에서 채운다 — 프론트가 자기 라벨을 실어 보내면
/// 그 값이 틀렸을 때(복사·리팩터링) 보낸 창이 자기 이벤트를 못 걸러 방금 쓴 것을 다시 읽고,
/// 그 재로드가 다시 저장을 부르는 왕복이 된다.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryChanged {
    origin: String,
}

/// 저장 전 검사 — 상한과 JSON 유효성을 **쓰기 전에** 본다(테스트 대상인 순수 코어).
///
/// 파싱을 여기서 하는 이유가 상한보다 중요하다: 깨진 문자열을 그대로 파일에 넣으면 다음
/// 로드의 [crate::state::load_json] 이 그것을 손상으로 보고 `.corrupt` 로 격리한다 —
/// 즉 **직전까지 멀쩡하던 라이브러리가 통째로 사라진다.** 거절하면 마지막 성공본이 남는다.
fn parse_library(json: &str) -> Result<serde_json::Value, IpcError> {
    if json.len() > MAX_BYTES {
        return Err(IpcError::new(
            ErrorCode::Io,
            text_files::image_library_too_large_8mb(),
        ));
    }
    serde_json::from_str(json).map_err(|e| {
        IpcError::new(
            ErrorCode::Io,
            text_files::image_library_invalid_format(e),
        )
    })
}

/// 라이브러리를 읽는다 — 저장된 적이 없거나 손상이면 `None`(오류가 아니라 "아직 비었다"다).
/// 손상 격리와 로그는 [crate::state::load_json] 이 한다.
#[tauri::command(async)]
pub fn image_library_get(app: AppHandle) -> Option<String> {
    crate::state::load_json::<serde_json::Value>(&app, LIBRARY_FILE, LIBRARY_KEY)
        .map(|v| v.to_string())
}

/// 라이브러리를 원자적으로 저장하고 전 창에 알린다. 8MB 초과·JSON 파손은 `Io`.
#[tauri::command(async)]
pub fn image_library_set(
    app: AppHandle,
    window: WebviewWindow,
    json: String,
) -> Result<(), IpcError> {
    let value = parse_library(&json)?;
    crate::state::save_json(&app, LIBRARY_FILE, LIBRARY_KEY, &value, text_files::image_library_label())?;
    // 실패해도 저장은 이미 끝났다 — 알림 실패로 저장을 되돌리면 상태가 더 나빠진다.
    let _ = app.emit(
        "image-library://changed",
        LibraryChanged {
            origin: window.label().to_string(),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 8MB 상한 — 넘으면 파싱도 하지 않고 거절한다. 거대 문자열을 serde에 넘기면 거절할 값을
    /// 파싱하느라 메모리를 두 배로 쓴다.
    #[test]
    fn oversized_library_is_rejected() {
        let huge = format!("\"{}\"", "x".repeat(MAX_BYTES));
        assert!(huge.len() > MAX_BYTES);
        let err = parse_library(&huge).unwrap_err();
        assert_eq!(err.code, ErrorCode::Io);
        // 상한 바로 아래는 통과해야 한다 — 경계에서 조용히 저장이 죽으면 원인을 못 찾는다.
        parse_library("{\"v\":1}").unwrap();
    }

    /// 깨진 JSON은 **파일에 닿기 전에** 막는다. 통과시키면 다음 로드가 손상으로 보고
    /// `.corrupt` 로 옮겨, 직전까지 멀쩡하던 라이브러리가 통째로 사라진다
    /// (읽기 쪽 격리 자체는 state.rs `corrupt_file_is_quarantined_not_silently_dropped` 가 지킨다).
    #[test]
    fn malformed_json_is_rejected_before_write() {
        for bad in ["", "{", "{\"v\":1,}", "undefined"] {
            let err = parse_library(bad).unwrap_err();
            assert_eq!(err.code, ErrorCode::Io, "거절하지 않은 입력: {bad:?}");
        }
    }
}
