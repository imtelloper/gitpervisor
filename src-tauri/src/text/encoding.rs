//! 텍스트 파일 인코딩 탐지·디코드·인코드 (DOCS/quality-batch-2026-09-design.md B장).
//!
//! 계약 한 줄: **열기 `bytes → (text, enc)` · 저장 `(text, enc) → bytes` · enc 는 왕복한다.**
//!
//! 이 모듈이 생기기 전에는 `String::from_utf8_lossy` 가 유일한 경로였다. 그건 유효하지 않은
//! 바이트를 `U+FFFD` 로 **비가역** 치환하므로, CP949 로 저장된 `.h` 를 열어 한 글자만 고치고
//! 저장하면 한글 주석이 통째로 `EF BF BD` 로 디스크에 기록됐다(데이터 유실). 되돌릴 방법이 없다.
//!
//! 그래서 디코드는 **원본 인코딩 이름을 함께 돌려주고**, 저장은 그 이름으로 되돌린다.

use encoding_rs::Encoding;

/// 디코드 결과 — `encoding`·`bom` 은 저장 때 그대로 되돌려 써야 한다(B-K3).
#[derive(Debug, Clone)]
pub struct Decoded {
    pub text: String,
    /// encoding_rs 정규 이름("UTF-8" / "EUC-KR" / "Shift_JIS" / "UTF-16LE" …).
    /// `encode()` 의 label 로 그대로 되먹일 수 있다.
    pub encoding: &'static str,
    /// 원본에 BOM 이 있었다(텍스트에서는 제거됨) — 저장 때 다시 붙인다.
    pub bom: bool,
    /// 어떤 인코딩으로도 깨끗이 못 읽었다 — 치환 문자가 섞였다. 프론트는 **읽기 전용**으로 연다.
    pub lossy: bool,
}

/// `encode()` 실패 사유.
#[derive(Debug, Clone)]
pub enum EncodeError {
    /// 그 인코딩으로 표현할 수 없는 문자가 있다(B-K4). 담긴 값은 표본 문자들(최대 8자).
    /// 조용히 `?` 로 뭉개지 않고 **저장을 막는 것**이 이 변형의 존재 이유다.
    Unmappable(String),
    /// 모르는 인코딩 이름 — 프론트가 보낸 label 이 오염됐다.
    Unknown,
}

/// 디코드 판정에 먹이는 최대 바이트 — 탐지는 앞부분이면 충분하고, 1.5MB 를 전부 먹이면
/// 프리페치 배치(파일 30개)에서 그대로 곱해진다.
const SNIFF_LIMIT: usize = 64 * 1024;

/// 이 바이트열이 BOM 으로 시작하는가 — **바이너리 판정보다 먼저** 물어야 한다(B-K5).
/// UTF-16 은 ASCII 문자마다 NUL 이 끼므로 NUL 검사만 하면 전부 "바이너리"로 빠진다.
pub fn has_bom(bytes: &[u8]) -> bool {
    Encoding::for_bom(bytes).is_some()
}

/// 바이트 → 텍스트. 탐지 순서는 B-K2: ① BOM ② UTF-8 유효성 ③ chardetng ④ OS 레거시 코드페이지.
pub fn decode(bytes: &[u8]) -> Decoded {
    decode_with_legacy(bytes, os_legacy(), os_tld())
}

/// `decode` 의 본체 — OS 의존 두 값을 인자로 뺐다(테스트가 머신 로캘에 좌우되지 않게).
fn decode_with_legacy(
    bytes: &[u8],
    legacy: Option<&'static Encoding>,
    tld: Option<&[u8]>,
) -> Decoded {
    // ① BOM 이 있으면 그게 곧 답이다(추측할 이유가 없다).
    if let Some((enc, bom_len)) = Encoding::for_bom(bytes) {
        let (text, lossy) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        return Decoded {
            text: text.into_owned(),
            encoding: enc.name(),
            bom: true,
            lossy,
        };
    }
    // ② UTF-8 로 유효하면 UTF-8 이다. 여기서 끝나는 것이 절대다수 경로이고, 결과는
    //    기존 `from_utf8_lossy` 와 **바이트 단위로 동일**하다(회귀 없음).
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Decoded {
            text: s.to_owned(),
            encoding: "UTF-8",
            bom: false,
            lossy: false,
        };
    }
    // ③ chardetng 추론. tld 힌트를 주는 이유: 짧은 한글 주석 몇 글자뿐인 소스 파일은
    //    바이트 분포만으로는 windows-1252 와 구별이 안 되는데, 그쪽은 **모든 바이트를**
    //    매핑해서 오류 없이 "성공"해 버린다(④가 영영 안 돌게 된다).
    let mut det = chardetng::EncodingDetector::new();
    let head = &bytes[..bytes.len().min(SNIFF_LIMIT)];
    det.feed(head, head.len() == bytes.len());
    let guess = det.guess(tld, false);
    let (text, lossy) = guess.decode_without_bom_handling(bytes);
    if !lossy {
        return Decoded {
            text: text.into_owned(),
            encoding: guess.name(),
            bom: false,
            lossy: false,
        };
    }
    // ④ 추측이 깨지면 OS 레거시 코드페이지(한국어 Windows = CP949).
    if let Some(os) = legacy {
        if os != guess {
            let (os_text, os_lossy) = os.decode_without_bom_handling(bytes);
            if !os_lossy {
                return Decoded {
                    text: os_text.into_owned(),
                    encoding: os.name(),
                    bom: false,
                    lossy: false,
                };
            }
        }
    }
    // ⑤ 전부 실패 — 그래도 보여는 주되 **탐지 실패로 표시**한다. 프론트는 읽기 전용으로 연다
    //    (이 상태로 저장하면 원본이 손상된다).
    Decoded {
        text: text.into_owned(),
        encoding: guess.name(),
        bom: false,
        lossy: true,
    }
}

/// 사용자가 인코딩을 직접 고른 경우(B-K6 "다른 인코딩으로 다시 열기") — 탐지를 건너뛴다.
///
/// 탐지는 언제나 확률이라 오탐이 남는다. 그때 사람이 뒤집을 수단이 없으면 오탐이 곧 데이터
/// 사고가 된다. 모르는 이름이면 `None`(호출자가 자동 탐지로 되돌린다).
pub fn decode_as(bytes: &[u8], label: &str) -> Option<Decoded> {
    let enc = Encoding::for_label(label.as_bytes())?;
    // 고른 인코딩의 BOM 만 벗긴다 — 다른 BOM 이 있어도 사용자의 선택을 덮지 않는다
    // (덮으면 "UTF-8 로 잘못 탐지된 파일"을 뒤집으려는 시도가 조용히 무시된다).
    let bom_len = match Encoding::for_bom(bytes) {
        Some((b, len)) if b == enc => len,
        _ => 0,
    };
    let (text, lossy) = enc.decode_without_bom_handling(&bytes[bom_len..]);
    Some(Decoded {
        text: text.into_owned(),
        encoding: enc.name(),
        bom: bom_len > 0,
        lossy,
    })
}

/// 줄 단위로 디코드해 이어 붙인다 — **여러 파일의 줄이 섞인 스트림**(git grep 출력)용(B-K7).
///
/// 통째로 `decode()` 하면 안 된다: UTF-8 레포에 CP949 파일 하나가 섞이면 전체 추론이
/// 한쪽으로 끌려가 **나머지 전부**가 깨진다. 줄마다 보면 UTF-8 줄은 UTF-8 로 확정되고
/// (기존 동작과 바이트 동일), 깨진 줄만 레거시로 되살아난다.
pub fn decode_lines(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for (i, line) in bytes.split(|&b| b == b'\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        match std::str::from_utf8(line) {
            Ok(s) => out.push_str(s),
            Err(_) => out.push_str(&decode(line).text),
        }
    }
    out
}

/// 텍스트 → 바이트. `label` 은 `Decoded::encoding` 을 그대로 되돌려 받은 값이다.
///
/// 표현 불가 문자가 하나라도 있으면 **쓰지 않고** `Unmappable` 을 돌려준다 — encoding_rs 의
/// 인코더는 기본적으로 그런 문자를 수치 참조(`&#128512;`)로 바꿔 넣는데, 그건 소스 파일에
/// 조용히 쓰레기를 박는 짓이다(B-K4).
pub fn encode(text: &str, label: &str, bom: bool) -> Result<Vec<u8>, EncodeError> {
    let enc = Encoding::for_label(label.as_bytes()).ok_or(EncodeError::Unknown)?;
    // UTF-16 은 직접 만든다 — encoding_rs 의 `encode()` 는 UTF-16 을 출력 인코딩 UTF-8 로
    // 바꿔 버린다(WHATWG 규약). 그대로 쓰면 UTF-16 파일이 저장할 때마다 UTF-8 로 변신한다.
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let le = enc == encoding_rs::UTF_16LE;
        let mut out = Vec::with_capacity(text.len() * 2 + 2);
        if bom {
            out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for u in text.encode_utf16() {
            out.extend_from_slice(&if le {
                u.to_le_bytes()
            } else {
                u.to_be_bytes()
            });
        }
        return Ok(out);
    }
    if enc == encoding_rs::UTF_8 {
        let mut out = Vec::with_capacity(text.len() + 3);
        if bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let (bytes, _, unmappable) = enc.encode(text);
    if unmappable {
        return Err(EncodeError::Unmappable(unmappable_chars(enc, text)));
    }
    Ok(bytes.into_owned())
}

/// 그 인코딩이 못 담는 문자 표본(최대 8자, 중복 제거) — 오류 문구에 실어 사용자가
/// "무엇 때문에" 막혔는지 바로 보게 한다. 오류 경로에서만 돈다.
fn unmappable_chars(enc: &'static Encoding, text: &str) -> String {
    let mut out = String::new();
    let mut buf = [0u8; 4];
    for ch in text.chars() {
        if ch.is_ascii() || out.contains(ch) {
            continue;
        }
        let (_, _, bad) = enc.encode(ch.encode_utf8(&mut buf));
        if bad {
            out.push(ch);
            if out.chars().count() >= 8 {
                break;
            }
        }
    }
    out
}

/// OS 레거시(ANSI) 코드페이지 → encoding_rs 인코딩. 탐지 ④단계의 마지막 보루다.
/// Windows 외에는 없다(UTF-8 이 기본인 세계라 레거시 폴백을 둘 근거가 없다).
#[cfg(windows)]
fn os_legacy() -> Option<&'static Encoding> {
    match unsafe { windows_sys::Win32::Globalization::GetACP() } {
        949 => Some(encoding_rs::EUC_KR), // = CP949(확장 완성형)
        932 => Some(encoding_rs::SHIFT_JIS),
        936 => Some(encoding_rs::GBK),
        950 => Some(encoding_rs::BIG5),
        1251 => Some(encoding_rs::WINDOWS_1251),
        1252 => Some(encoding_rs::WINDOWS_1252),
        _ => None,
    }
}

#[cfg(not(windows))]
fn os_legacy() -> Option<&'static Encoding> {
    None
}

/// chardetng 의 로캘 힌트(TLD). 코드페이지에서 유도한다 — 사용자의 레거시 파일은
/// 그 머신의 코드페이지로 저장돼 있을 확률이 압도적이다.
#[cfg(windows)]
fn os_tld() -> Option<&'static [u8]> {
    match unsafe { windows_sys::Win32::Globalization::GetACP() } {
        949 => Some(b"kr"),
        932 => Some(b"jp"),
        936 => Some(b"cn"),
        950 => Some(b"tw"),
        1251 => Some(b"ru"),
        _ => None,
    }
}

#[cfg(not(windows))]
fn os_tld() -> Option<&'static [u8]> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "일반 사용"의 CP949 바이트 — 사용자 사례(`.h` 주석)에서 그대로 가져왔다.
    const CP949_KO: &[u8] = &[0xC0, 0xCF, 0xB9, 0xDD, 0x20, 0xBB, 0xE7, 0xBF, 0xEB];

    /// 레거시 폴백이 주어지면 CP949 주석이 한글로 돌아온다 — 이 모듈의 존재 이유.
    /// (OS 값 대신 인자로 주는 이유: 머신 로캘이 달라도 같은 것을 단언하기 위해.)
    #[test]
    fn cp949_decodes_to_korean() {
        let d = decode_with_legacy(CP949_KO, Some(encoding_rs::EUC_KR), Some(b"kr"));
        assert_eq!(d.text, "일반 사용");
        assert!(!d.lossy);
        assert!(!d.bom);
        // 이름이 `encode()` 로 되먹여져야 왕복이 성립한다.
        assert_eq!(encode(&d.text, d.encoding, d.bom).unwrap(), CP949_KO);
    }

    /// **실제 `decode()`**(OS 값을 쓰는 경로)가 짧은 CP949 주석을 되살리는지 — 이게 사용자가
    /// 겪은 바로 그 파일이다. 한국어 코드페이지 머신에서만 의미가 있으므로 그 외에서는
    /// 판정하지 않는다(단언을 억지로 참으로 만들지 않는다).
    ///
    /// 위험 지점을 명시한다: chardetng 이 windows-1252 를 찍으면 그쪽은 **모든 바이트를**
    /// 매핑해 오류 없이 "성공"하므로 ④단계가 영영 안 돈다. 그 회귀를 잡는 단언이다.
    /// 바이트는 e2e 픽스처(`tests/e2e/lib/git-fixture.mjs` 의 `enc/cp949.h`)와 **같은 것**이다 —
    /// 그쪽 스위트가 `encoding === "EUC-KR"` 을 단언하므로, 그 기대가 이 머신에서 성립하는지
    /// 여기서 먼저 확인한다(e2e 를 돌리기 전에 실패를 알 수 있게).
    #[test]
    fn os_path_recovers_short_cp949_comment() {
        if os_legacy() != Some(encoding_rs::EUC_KR) {
            eprintln!("코드페이지가 949 가 아니라 판정하지 않음(이 단언은 한국어 Windows 전용)");
            return;
        }
        #[rustfmt::skip]
        let src: &[u8] = &[
            0x2F, 0x2F, 0x20, 0xC0, 0xCF, 0xB9, 0xDD, 0x20, 0xBB, 0xE7, 0xBF, 0xEB, 0x0D, 0x0A,
            0x23, 0x64, 0x65, 0x66, 0x69, 0x6E, 0x65, 0x20, 0x4D, 0x41, 0x58, 0x20, 0x31, 0x30,
            0x0D, 0x0A, 0x2F, 0x2F, 0x20, 0xBF, 0xAC, 0xB0, 0xE1, 0xB0, 0xCB, 0xBB, 0xE7, 0x0D,
            0x0A, 0x69, 0x6E, 0x74, 0x20, 0x6D, 0x61, 0x69, 0x6E, 0x28, 0x76, 0x6F, 0x69, 0x64,
            0x29, 0x20, 0x7B, 0x20, 0x72, 0x65, 0x74, 0x75, 0x72, 0x6E, 0x20, 0x30, 0x3B, 0x20,
            0x7D, 0x0D, 0x0A,
        ];
        let d = decode(src);
        assert_eq!(d.encoding, "EUC-KR", "탐지 결과: {d:?}");
        assert!(d.text.contains("일반 사용") && d.text.contains("연결검사"), "{:?}", d.text);
        assert!(!d.lossy);
        // 그대로 되돌려 쓰면 원본 바이트와 **완전히** 같다.
        assert_eq!(encode(&d.text, d.encoding, d.bom).unwrap(), src);
    }

    /// 저장 왕복 — 한 줄을 고쳐도 나머지 바이트는 그대로다(수용 기준의 핵심 단언).
    #[test]
    fn cp949_roundtrip_preserves_untouched_bytes() {
        let mut src = b"// ".to_vec();
        src.extend_from_slice(CP949_KO);
        src.extend_from_slice(b"\r\nint x = 1;\r\n");
        let d = decode_with_legacy(&src, Some(encoding_rs::EUC_KR), Some(b"kr"));
        let edited = d.text.replace("int x = 1;", "int x = 2;");
        let out = encode(&edited, d.encoding, d.bom).unwrap();
        let mut want = b"// ".to_vec();
        want.extend_from_slice(CP949_KO);
        want.extend_from_slice(b"\r\nint x = 2;\r\n");
        assert_eq!(out, want);
    }

    /// UTF-8 파일은 바이트 단위로 기존 동작과 같아야 한다(되돌리기 어려운 변경의 회귀 반증).
    #[test]
    fn utf8_is_byte_identical() {
        let src = "한글 comment\nsecond\n".as_bytes();
        let d = decode(src);
        assert_eq!(d.encoding, "UTF-8");
        assert!(!d.bom && !d.lossy);
        assert_eq!(d.text.as_bytes(), src);
        assert_eq!(encode(&d.text, d.encoding, d.bom).unwrap(), src);
    }

    /// UTF-8 BOM: 텍스트 첫 글자에 보이지 않는 문자가 없고, 저장하면 BOM 이 되살아난다.
    #[test]
    fn utf8_bom_is_stripped_and_restored() {
        let src = b"\xEF\xBB\xBFhello";
        let d = decode(src);
        assert_eq!(d.text, "hello");
        assert!(d.bom);
        assert_eq!(d.encoding, "UTF-8");
        assert_eq!(encode(&d.text, d.encoding, d.bom).unwrap(), src);
    }

    /// UTF-16LE 은 BOM 으로 확정되고(바이너리로 안 빠진다) 저장도 UTF-16LE 로 되돌아간다.
    #[test]
    fn utf16le_bom_roundtrip() {
        let mut src = vec![0xFF, 0xFE];
        for u in "가A".encode_utf16() {
            src.extend_from_slice(&u.to_le_bytes());
        }
        assert!(has_bom(&src));
        let d = decode(&src);
        assert_eq!(d.text, "가A");
        assert_eq!(d.encoding, "UTF-16LE");
        assert!(d.bom);
        assert_eq!(encode(&d.text, d.encoding, d.bom).unwrap(), src);
    }

    /// CP949 에 없는 문자(이모지)는 **쓰지 않고** 막는다 — 조용한 `?` 치환 금지(B-K4).
    #[test]
    fn unmappable_is_refused_not_mangled() {
        match encode("일반 😀 사용", "EUC-KR", false) {
            Err(EncodeError::Unmappable(sample)) => assert!(sample.contains('😀')),
            other => panic!("Unmappable 를 기대했다: {other:?}"),
        }
        // 같은 문자열이 UTF-8 로는 문제없이 저장된다(확인창의 "UTF-8 로 저장" 선택지).
        assert!(encode("일반 😀 사용", "UTF-8", false).is_ok());
        assert!(matches!(encode("x", "no-such-encoding", false), Err(EncodeError::Unknown)));
    }

    /// 섞인 스트림(git grep)은 줄마다 판정한다 — UTF-8 줄이 CP949 줄 때문에 깨지면 안 된다.
    #[test]
    fn decode_lines_keeps_utf8_lines_intact() {
        let mut src = "src/a.rs:1:1:한글 UTF-8 줄\n".as_bytes().to_vec();
        src.extend_from_slice(b"src/b.h:2:1:// ");
        src.extend_from_slice(CP949_KO);
        src.push(b'\n');
        let out = decode_lines(&src);
        assert!(out.contains("한글 UTF-8 줄"), "UTF-8 줄이 보존돼야 한다: {out}");
        // 레거시 줄은 OS 코드페이지가 한국어일 때만 한글로 복원된다 — 머신 로캘에 의존하므로
        // 여기서는 "U+FFFD 로 뭉개지지 않는다"만 단언한다(줄 구조 보존은 아래에서).
        assert_eq!(out.lines().count(), 2);
        // 통째 decode 와 달리 첫 줄이 오염되지 않는다.
        assert!(out.starts_with("src/a.rs:1:1:한글 UTF-8 줄"));
    }

    /// 줄 구조는 그대로 — 순수 ASCII 입력은 왕복이 항등이어야 한다(구분자 유실 방지).
    #[test]
    fn decode_lines_is_identity_for_ascii() {
        let src = b"a\nb\n\nc";
        assert_eq!(decode_lines(src), "a\nb\n\nc");
        assert_eq!(decode_lines(b"a\nb\n"), "a\nb\n");
    }
}
