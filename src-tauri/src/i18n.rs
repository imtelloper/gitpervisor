//! UI 언어(DOCS/i18n-design.md §4.1·§4.4).
//!
//! 설정 `ui_language`("system" | "ko" | "en")를 해석해 **전역 하나**로 들고, Rust가 사용자에게 보여 주는
//! 문구를 이 언어로 만든다. `"system"` 판정은 **여기 한 곳**에서만 한다 — 프런트는
//! `ui_language_resolved`로 결과만 받는다. 프런트가 `navigator.language`로 따로 판정하면, 표시 언어와
//! 지역 형식이 다른 Windows 사용자(영어 표시 · 한국 지역)에게 창 제목·오류와 화면 언어가 어긋난다.

use std::sync::atomic::{AtomicU8, Ordering};

// 도메인별 사용자 노출 문구(함수 하나 = 문구 하나). 새 도메인은 여기 한 줄.
pub mod text_db;
pub mod text_files;
pub mod text_tools;
pub mod text_system;
pub mod text_git_net;
pub mod text_video;
pub mod text_stt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ko,
    En,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::Ko => "ko",
            Lang::En => "en",
        }
    }
}

/// 0 = 한국어(판정 전 기본값 — 지금까지 모든 사용자가 본 화면), 1 = 영어.
static LANG: AtomicU8 = AtomicU8::new(0);

pub fn lang() -> Lang {
    match LANG.load(Ordering::Relaxed) {
        1 => Lang::En,
        _ => Lang::Ko,
    }
}

/// 설정값을 해석해 전역에 건다. 설정 로드 직후와 저장 직후에 부른다.
pub fn apply_setting(setting: &str) -> Lang {
    let resolved = resolve(setting, system_language_tag().as_deref());
    LANG.store(
        match resolved {
            Lang::Ko => 0,
            Lang::En => 1,
        },
        Ordering::Relaxed,
    );
    resolved
}

/// 설정값 + OS 언어 태그 → 언어. 모르는 설정값은 "system"으로 친다(옛 설정·손으로 고친 파일).
/// OS 언어를 못 읽으면 한국어 — 판정이 실패했다고 기존 사용자의 화면이 바뀌면 안 된다.
pub(crate) fn resolve(setting: &str, system_tag: Option<&str>) -> Lang {
    match setting {
        "ko" => Lang::Ko,
        "en" => Lang::En,
        _ => match system_tag {
            Some(tag) if tag.trim().to_ascii_lowercase().starts_with("ko") => Lang::Ko,
            Some(_) => Lang::En,
            None => Lang::Ko,
        },
    }
}

/// OS **표시 언어**의 첫 태그("ko-KR" · "en-US" …). 못 읽으면 None.
#[cfg(windows)]
fn system_language_tag() -> Option<String> {
    use windows_sys::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    // 지역 형식(GetUserDefaultLocaleName)이 아니라 표시 언어다 — "영어 Windows + 한국 지역" 사용자에게
    // 한국어 UI를 내밀면 안 된다.
    let mut count = 0u32;
    let mut len = 0u32;
    // SAFETY: 첫 호출은 버퍼 없이 필요한 길이(NUL 포함 u16 개수)만 받는다.
    let sized = unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, std::ptr::null_mut(), &mut len)
    };
    if sized == 0 || len == 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize];
    // SAFETY: 위에서 받은 길이만큼 할당한 버퍼와 그 길이를 넘긴다.
    let got = unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, buf.as_mut_ptr(), &mut len)
    };
    if got == 0 {
        return None;
    }
    // 이중 NUL로 끝나는 목록 — 가장 선호하는 첫 항목만 쓴다.
    let first: Vec<u16> = buf.iter().copied().take_while(|&c| c != 0).collect();
    (!first.is_empty()).then(|| String::from_utf16_lossy(&first))
}

#[cfg(target_os = "macos")]
fn system_language_tag() -> Option<String> {
    use objc2_foundation::NSLocale;
    // 시스템 설정 › 언어 및 지역의 "선호하는 언어" 첫 항목. `iter()`는 NSEnumerator 피처가 필요해
    // `to_vec`으로 받는다(commands/ocr.rs와 같은 이유). **실기 미확인** — CI의 macOS 빌드가 컴파일을 본다.
    NSLocale::preferredLanguages()
        .to_vec()
        .first()
        .map(|s| s.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn system_language_tag() -> Option<String> {
    tag_from_env(|k| std::env::var(k).ok())
}

/// gettext 순서: LANGUAGE(콜론 목록의 첫 항목) → LC_ALL → LC_MESSAGES → LANG. "C"·"POSIX"는 영어로 본다 —
/// 로캘을 안 정한 머신에 한국어를 내밀지 않는다.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
pub(crate) fn tag_from_env(get: impl Fn(&str) -> Option<String>) -> Option<String> {
    for key in ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] {
        let Some(value) = get(key) else { continue };
        let first = value.split(':').next().unwrap_or("").trim();
        if first.is_empty() {
            continue;
        }
        return Some(if first == "C" || first == "POSIX" || first.starts_with("C.") {
            "en".to_string()
        } else {
            first.to_string()
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_explicit_setting_ignores_os() {
        assert_eq!(resolve("ko", Some("en-US")), Lang::Ko);
        assert_eq!(resolve("en", Some("ko-KR")), Lang::En);
    }

    #[test]
    fn resolve_system_follows_os_and_falls_back_to_korean() {
        assert_eq!(resolve("system", Some("ko-KR")), Lang::Ko);
        assert_eq!(resolve("system", Some("ko_KR.UTF-8")), Lang::Ko);
        assert_eq!(resolve("system", Some("en-US")), Lang::En);
        assert_eq!(resolve("system", Some("ja-JP")), Lang::En);
        assert_eq!(resolve("system", None), Lang::Ko);
        // 모르는 값(옛 설정·수동 편집)은 system 으로 친다
        assert_eq!(resolve("fr", Some("en-GB")), Lang::En);
    }

    #[test]
    fn tag_from_env_follows_gettext_order() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| pairs.iter().find(|(key, _)| *key == k).map(|(_, v)| v.to_string())
        };
        assert_eq!(tag_from_env(env(&[("LANGUAGE", "ko:en"), ("LANG", "en_US.UTF-8")])), Some("ko".into()));
        assert_eq!(tag_from_env(env(&[("LANGUAGE", ""), ("LC_ALL", "ko_KR.UTF-8")])), Some("ko_KR.UTF-8".into()));
        assert_eq!(tag_from_env(env(&[("LANG", "C.UTF-8")])), Some("en".into()));
        assert_eq!(tag_from_env(env(&[("LANG", "POSIX")])), Some("en".into()));
        assert_eq!(tag_from_env(env(&[])), None);
    }

    /// 주석을 공백으로 바꾼다(줄 수 보존). 일반·바이트·원시(`r"…"`, `r#"…"#`) 문자열과 `'"'` 문자 리터럴은
    /// 그대로 건너뛴다 — 안쪽 따옴표를 문자열 끝으로 읽으면 뒤쪽 주석/문자열 판정이 통째로 뒤집힌다.
    fn strip_rust_comments(src: &str) -> String {
        let b: Vec<char> = src.chars().collect();
        let n = b.len();
        let mut out = String::with_capacity(src.len());
        let blank = |out: &mut String, s: &[char]| {
            for &c in s {
                out.push(if c == '\n' { '\n' } else { ' ' });
            }
        };
        let mut i = 0;
        while i < n {
            let c = b[i];
            if c == '/' && i + 1 < n && b[i + 1] == '/' {
                let end = (i..n).find(|&j| b[j] == '\n').unwrap_or(n);
                blank(&mut out, &b[i..end]);
                i = end;
            } else if c == '/' && i + 1 < n && b[i + 1] == '*' {
                let end = (i + 2..n.saturating_sub(1))
                    .find(|&j| b[j] == '*' && b[j + 1] == '/')
                    .map_or(n, |j| j + 2);
                blank(&mut out, &b[i..end]);
                i = end;
            } else if c == 'r' && i + 1 < n && (b[i + 1] == '"' || b[i + 1] == '#')
                && (i == 0 || !(b[i - 1].is_alphanumeric() || b[i - 1] == '_'))
            {
                // 원시 문자열: r, 해시 k개, " … " 해시 k개
                let mut j = i + 1;
                let mut hashes = 0;
                while j < n && b[j] == '#' {
                    hashes += 1;
                    j += 1;
                }
                if j < n && b[j] == '"' {
                    let mut k = j + 1;
                    let end = loop {
                        if k >= n {
                            break n;
                        }
                        if b[k] == '"' && (k + 1..=k + hashes).all(|h| h < n && b[h] == '#') {
                            break k + 1 + hashes;
                        }
                        k += 1;
                    };
                    out.extend(&b[i..end]);
                    i = end;
                } else {
                    out.push(c);
                    i += 1;
                }
            } else if c == '\'' && i + 2 < n && b[i + 1] == '"' && b[i + 2] == '\'' {
                out.extend(&b[i..i + 3]);
                i += 3;
            } else if c == '\'' && i + 3 < n && b[i + 1] == '\\' && b[i + 2] == '"' && b[i + 3] == '\'' {
                out.extend(&b[i..i + 4]);
                i += 4;
            } else if c == '"' {
                let mut j = i + 1;
                while j < n && b[j] != '"' {
                    j += if b[j] == '\\' { 2 } else { 1 };
                }
                let end = (j + 1).min(n);
                out.extend(&b[i..end]);
                i = end;
            } else {
                out.push(c);
                i += 1;
            }
        }
        out
    }

    /// 한 파일의 사용자 노출 한글 줄 수 — `#[cfg(test)]` 이후·로그 매크로·줄 끝 `// i18n-ok:`는 뺀다.
    fn user_facing_korean_lines(src: &str) -> usize {
        let body = src.find("#[cfg(test)]").map_or(src, |at| &src[..at]);
        let raw: Vec<&str> = body.lines().collect();
        strip_rust_comments(body)
            .lines()
            .enumerate()
            .filter(|(idx, line)| {
                line.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c))
                    && !["log::info!", "log::warn!", "log::error!", "log::debug!", "log::trace!", "eprintln!", "println!"]
                        .iter()
                        .any(|m| line.contains(m))
                    && !raw.get(*idx).is_some_and(|r| r.contains("i18n-ok:"))
            })
            .count()
    }

    /// 사용자에게 보이는 한국어는 `i18n/` 모듈에만 둔다(DOCS/i18n-design.md §4.4·§5.2). 아직 이관 안 된 파일은
    /// `src-tauri/i18n-legacy-rs.json` 목록 — 목록 밖 파일에 한글이 생기면, 또 한글이 사라진 파일이 목록에
    /// 남아 있으면 실패한다(목록은 줄어들기만). 프런트의 e2e 66 과 같은 규칙이다.
    #[test]
    fn user_facing_korean_lives_in_i18n_modules() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let doc: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(root.join("i18n-legacy-rs.json")).expect("i18n-legacy-rs.json"),
        )
        .expect("i18n-legacy-rs.json 파싱");
        let legacy: std::collections::BTreeSet<String> = doc["files"]
            .as_object()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();

        let mut found = std::collections::BTreeSet::new();
        let mut stack = vec![root.join("src")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src 읽기").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                    continue;
                }
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                // 문구의 집: 판정 모듈과 도메인 문구 모듈
                if rel == "src/i18n.rs" || rel.starts_with("src/i18n/") {
                    continue;
                }
                let src = std::fs::read_to_string(&path).unwrap_or_default();
                if user_facing_korean_lines(&src) > 0 {
                    found.insert(rel);
                }
            }
        }
        let added: Vec<_> = found.difference(&legacy).collect();
        let cleared: Vec<_> = legacy.difference(&found).collect();
        assert!(
            added.is_empty(),
            "사용자 노출 한국어가 i18n 모듈 밖에 새로 생겼다 — crate::i18n::text_*에 함수로 옮겨라: {added:?}"
        );
        assert!(cleared.is_empty(), "이관 끝난 파일을 i18n-legacy-rs.json 에서 지워라: {cleared:?}");
    }

    #[test]
    fn strip_rust_comments_keeps_strings_and_raw_strings() {
        let src = "let a = \"// 문자열\"; // 주석 한글\nlet b = r#\"원시 \"따옴표\" 안\"#; /* 블록 한글 */ let c = '\"';\n";
        let s = strip_rust_comments(src);
        assert!(s.contains("\"// 문자열\""));
        assert!(!s.contains("주석 한글"));
        assert!(s.contains("원시 \"따옴표\" 안"));
        assert!(!s.contains("블록 한글"));
        assert_eq!(s.lines().count(), src.lines().count());
    }
}
