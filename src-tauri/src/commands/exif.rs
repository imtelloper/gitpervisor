//! 사진 EXIF 요약 — 폴더 창 사진 뷰어의 정보 패널(태스크 76 D6)이 쓰는 태그만 읽는 최소 파서.
//!
//! 크레이트를 들이지 않은 이유: 필요한 건 태그 열 몇 개뿐이고, JPEG(APP1)·HEIC(Exif 항목) 어느 쪽이든 파일 앞부분에
//! TIFF 헤더(`II*\0`/`MM\0*`)로 시작하는 같은 구조가 들어 있어 그것만 찾으면 된다(실측: HEIC 안 Orientation 3/6 이
//! ffprobe 회전과 일치). **깨진 EXIF 는 "없음"이지 오류가 아니다** — 오프셋·개수를 전부 범위 검사하고, 어긋나면 그
//! 태그(또는 그 후보 헤더)만 버린다. IFD 체인(다음 IFD)은 따라가지 않는다 — 순환 링크로 끝없이 돌 길이 없다.

use serde::Serialize;

/// 앞에서 이만큼만 훑는다 — JPEG 의 APP1 은 64KB 안이고, HEIC 의 Exif 항목도 실측상 앞부분에 있다.
pub(crate) const EXIF_SCAN_BYTES: u64 = 1024 * 1024;

/// TIFF 헤더 후보를 이만큼까지만 시험한다 — 압축 데이터 속 우연한 `II*\0` 가 많아도 일이 불어나지 않게.
const MAX_CANDIDATES: usize = 32;

/// 정보 패널에 보이는 태그. 없는 것은 키째 빠진다(프론트 타입이 `?:`).
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExifSummary {
    /// `YYYY-MM-DD HH:MM:SS` — 찍은 시각(DateTimeOriginal), 없으면 파일에 기록된 시각(DateTime). 시간대는 모른다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taken_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub make: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
    /// 노출 시간(초).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exposure: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f_number: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iso: Option<u32>,
    /// 초점 거리(mm).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focal_length: Option<f64>,
    /// 1~8(TIFF 규약). 그 밖의 값은 버린다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<u16>,
    /// 십진 도(남위·서경은 음수).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gps_lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gps_lon: Option<f64>,
}

/// 옮겨 심을 TIFF 블록의 상한 — JPEG APP1 세그먼트에 `Exif\0\0` 과 함께 들어가야 한다(길이 칸 16비트: 65535 − 2 − 6).
pub(crate) const MAX_EXIF_TIFF_BYTES: usize = 65_527;

/// 파일 앞부분 바이트에서 EXIF 를 찾아 요약한다. 못 찾거나 쓸 태그가 하나도 없으면 None.
pub(crate) fn parse_exif(buf: &[u8]) -> Option<ExifSummary> {
    tiff_candidates(buf).into_iter().find_map(|i| summary_at(&buf[i..]))
}

/// 원본의 EXIF TIFF 블록(`II*\0`/`MM\0*` 부터) — 다시 인코딩한 사진에 옮겨 심을 몫(태스크 76 후속: HEIC → JPEG 저장).
/// 끝은 IFD0·Exif·GPS·Interop IFD 와 그 값들이 끝나는 자리다(HEIC 의 Exif 항목은 길이를 iloc 에만 적어 두어 뒤따르는
/// 바이트로는 끝을 모른다). 썸네일 IFD1 은 넣지 않는다 — 옮겨 심는 쪽이 링크를 끊는다. 값 하나라도 밖을 가리키거나
/// 상한을 넘으면 None — 반쯤 잘린 블록을 심으면 읽는 쪽이 남의 바이트를 태그 값으로 읽는다.
pub(crate) fn exif_tiff_block(buf: &[u8]) -> Option<&[u8]> {
    tiff_candidates(buf).into_iter().find_map(|i| {
        let n = tiff_extent(&buf[i..])?;
        (n <= MAX_EXIF_TIFF_BYTES).then(|| &buf[i..i + n])
    })
}

/// TIFF 헤더 모양이 나오는 자리들, 믿을 만한 순서로 `MAX_CANDIDATES` 개까지.
fn tiff_candidates(buf: &[u8]) -> Vec<usize> {
    let mut cands: Vec<usize> = buf
        .windows(4)
        .enumerate()
        .filter(|(_, w)| *w == b"II*\0" || *w == b"MM\0*")
        .map(|(i, _)| i)
        .collect();
    // `Exif\0\0` 바로 뒤의 헤더를 먼저 본다 — APP1 과 HEIC 의 Exif 항목이 다 그 모양이고, 압축 데이터 속 우연한
    // 헤더 모양보다 훨씬 믿을 만하다. 정렬이 안정적이라 같은 부류 안에서는 앞쪽이 먼저다(원본 TIFF 는 0번).
    cands.sort_by_key(|&i| !(i >= 6 && &buf[i - 6..i] == b"Exif\0\0"));
    cands.truncate(MAX_CANDIDATES);
    cands
}

/// `d` 가 TIFF 헤더로 시작할 때 블록이 끝나는 자리(배타). 어느 IFD·값이든 `d` 밖으로 나가면 None.
fn tiff_extent(d: &[u8]) -> Option<usize> {
    let le = match d.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let t = Tiff { d, le };
    let mut end = 8;
    let mut walk = |off: usize| -> Option<Vec<Entry>> {
        let ifd = t.ifd(off)?;
        // 다음 IFD 칸(4바이트)까지 — 옮겨 심는 쪽이 IFD0 의 그 칸을 0 으로 고쳐 쓴다.
        let ifd_end = off + 2 + ifd.len() * 12 + 4;
        if ifd_end > d.len() {
            return None;
        }
        end = end.max(ifd_end);
        for e in &ifd {
            // 모르는 형식은 아무도 못 읽는다 — 크기를 모르니 끝 계산에서도 뺀다.
            let Some(unit) = type_unit(e.typ) else { continue };
            let len = usize::try_from(e.count).ok()?.checked_mul(unit)?;
            end = end.max(t.value_at(e)?.checked_add(len)?);
        }
        Some(ifd)
    };
    let ifd0 = walk(usize::try_from(t.u32_at(4)?).ok()?)?;
    let sub = |ifd: &[Entry], tag| find(ifd, tag).and_then(|e| t.uint(e)).and_then(|o| usize::try_from(o).ok());
    if let Some(o) = sub(&ifd0, 0x8769) {
        let exif = walk(o)?;
        if let Some(o) = sub(&exif, 0xA005) {
            walk(o)?;
        }
    }
    if let Some(o) = sub(&ifd0, 0x8825) {
        walk(o)?;
    }
    Some(end)
}

/// TIFF 형식 하나의 바이트 수(1~13). 그 밖은 None.
fn type_unit(typ: u16) -> Option<usize> {
    match typ {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 | 13 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

struct Tiff<'a> {
    d: &'a [u8],
    le: bool,
}

struct Entry {
    tag: u16,
    typ: u16,
    count: u32,
    /// 항목 안 4바이트 값 칸의 자리(TIFF 시작 기준).
    at: usize,
}

impl Tiff<'_> {
    fn u16_at(&self, off: usize) -> Option<u16> {
        let b: [u8; 2] = self.d.get(off..off.checked_add(2)?)?.try_into().ok()?;
        Some(if self.le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    }

    fn u32_at(&self, off: usize) -> Option<u32> {
        let b: [u8; 4] = self.d.get(off..off.checked_add(4)?)?.try_into().ok()?;
        Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }

    /// IFD 하나의 항목들. 개수만큼의 항목이 데이터 안에 다 들어 있지 않으면 IFD 째 None.
    fn ifd(&self, off: usize) -> Option<Vec<Entry>> {
        let n = usize::from(self.u16_at(off)?);
        let start = off.checked_add(2)?;
        if start.checked_add(n.checked_mul(12)?)? > self.d.len() {
            return None;
        }
        (0..n)
            .map(|k| {
                let e = start + k * 12;
                Some(Entry { tag: self.u16_at(e)?, typ: self.u16_at(e + 2)?, count: self.u32_at(e + 4)?, at: e + 8 })
            })
            .collect()
    }

    /// 값 바이트의 시작 자리 — 4바이트 이하면 항목 안, 넘으면 오프셋이 가리키는 곳. 끝까지 데이터 안이어야 한다.
    fn value_at(&self, e: &Entry) -> Option<usize> {
        let len = usize::try_from(e.count).ok()?.checked_mul(type_unit(e.typ)?)?;
        let off = if len <= 4 { e.at } else { usize::try_from(self.u32_at(e.at)?).ok()? };
        (off.checked_add(len)? <= self.d.len()).then_some(off)
    }

    fn ascii(&self, e: &Entry) -> Option<String> {
        if e.typ != 2 {
            return None;
        }
        let off = self.value_at(e)?;
        let raw = &self.d[off..off + usize::try_from(e.count).ok()?];
        let s = std::str::from_utf8(raw.split(|&c| c == 0).next()?).ok()?.trim();
        (!s.is_empty()).then(|| s.to_string())
    }

    /// SHORT/LONG 의 첫 값.
    fn uint(&self, e: &Entry) -> Option<u32> {
        if e.count == 0 {
            return None;
        }
        let off = self.value_at(e)?;
        match e.typ {
            3 => self.u16_at(off).map(u32::from),
            4 => self.u32_at(off),
            _ => None,
        }
    }

    /// RATIONAL/SRATIONAL 의 `k` 번째 값. 분모 0 은 없는 값이다.
    fn rational(&self, e: &Entry, k: usize) -> Option<f64> {
        if k >= usize::try_from(e.count).ok()? {
            return None;
        }
        let at = self.value_at(e)?.checked_add(k * 8)?;
        let (n, d) = (self.u32_at(at)?, self.u32_at(at + 4)?);
        let v = match e.typ {
            5 => f64::from(n) / f64::from(d),
            10 => f64::from(n as i32) / f64::from(d as i32),
            _ => return None,
        };
        (d != 0 && v.is_finite()).then_some(v)
    }
}

fn find(ifd: &[Entry], tag: u16) -> Option<&Entry> {
    ifd.iter().find(|e| e.tag == tag)
}

/// `d` 가 TIFF 헤더로 시작한다고 보고 요약한다. IFD0 을 못 읽으면 이 후보는 버린다.
fn summary_at(d: &[u8]) -> Option<ExifSummary> {
    let le = match d.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let t = Tiff { d, le };
    let ifd0 = t.ifd(usize::try_from(t.u32_at(4)?).ok()?)?;
    let sub = |tag| find(&ifd0, tag).and_then(|e| t.uint(e)).and_then(|o| t.ifd(usize::try_from(o).ok()?));

    let mut s = ExifSummary {
        make: find(&ifd0, 0x010F).and_then(|e| t.ascii(e)),
        model: find(&ifd0, 0x0110).and_then(|e| t.ascii(e)),
        orientation: find(&ifd0, 0x0112)
            .and_then(|e| t.uint(e))
            .filter(|o| (1..=8).contains(o))
            .and_then(|o| u16::try_from(o).ok()),
        ..ExifSummary::default()
    };
    let mut taken = None;
    if let Some(exif) = sub(0x8769) {
        taken = find(&exif, 0x9003).and_then(|e| t.ascii(e));
        s.exposure = find(&exif, 0x829A).and_then(|e| t.rational(e, 0));
        s.f_number = find(&exif, 0x829D).and_then(|e| t.rational(e, 0));
        s.iso = find(&exif, 0x8827).and_then(|e| t.uint(e));
        s.focal_length = find(&exif, 0x920A).and_then(|e| t.rational(e, 0));
        s.lens = find(&exif, 0xA434).and_then(|e| t.ascii(e));
    }
    s.taken_at = taken
        .or_else(|| find(&ifd0, 0x0132).and_then(|e| t.ascii(e)))
        .and_then(|v| exif_date(&v));
    if let Some(gps) = sub(0x8825) {
        s.gps_lat = gps_coord(&t, &gps, 2, 1, b'S', 90.0);
        s.gps_lon = gps_coord(&t, &gps, 4, 3, b'W', 180.0);
    }
    (s != ExifSummary::default()).then_some(s)
}

/// `YYYY:MM:DD HH:MM:SS` → `YYYY-MM-DD HH:MM:SS`. 비워 둔 값(`0000:00:00 …`·공백)과 모양이 다른 값은 버린다.
fn exif_date(v: &str) -> Option<String> {
    let b = v.as_bytes();
    let shaped = b.len() >= 10 && b[4] == b':' && b[7] == b':' && b[..4].iter().all(u8::is_ascii_digit);
    if !shaped || v.starts_with("0000") {
        return None;
    }
    Some(format!("{}-{}-{}", &v[..4], &v[5..7], &v[8..]))
}

/// 도·분·초 세 RATIONAL → 십진 도. 기준(`neg` = 'S'/'W')이면 음수. 범위를 넘는 값은 깨진 것으로 본다.
fn gps_coord(t: &Tiff, gps: &[Entry], tag: u16, ref_tag: u16, neg: u8, max: f64) -> Option<f64> {
    let e = find(gps, tag)?;
    let v = t.rational(e, 0)? + t.rational(e, 1)? / 60.0 + t.rational(e, 2)? / 3600.0;
    let sign = match find(gps, ref_tag).and_then(|r| t.ascii(r)) {
        Some(r) if r.as_bytes().first() == Some(&neg) => -1.0,
        _ => 1.0,
    };
    (v.abs() <= max).then_some(sign * v)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 손으로 짜는 TIFF — 엔디언만 고르고 IFD 를 차례로 붙인다. 값이 4바이트를 넘으면 뒤쪽 데이터 영역에 둔다.
    struct Builder {
        le: bool,
        buf: Vec<u8>,
    }

    /// (태그, 형식, 개수, 값 바이트 — 이미 엔디언에 맞춘 것)
    type Field = (u16, u16, u32, Vec<u8>);

    impl Builder {
        fn new(le: bool) -> Self {
            let mut buf = if le { b"II*\0".to_vec() } else { b"MM\0*".to_vec() };
            buf.extend([0; 4]); // IFD0 오프셋 — `ifd` 가 채운다
            Self { le, buf }
        }
        fn u16b(&self, v: u16) -> Vec<u8> {
            if self.le { v.to_le_bytes().to_vec() } else { v.to_be_bytes().to_vec() }
        }
        fn u32b(&self, v: u32) -> Vec<u8> {
            if self.le { v.to_le_bytes().to_vec() } else { v.to_be_bytes().to_vec() }
        }
        fn ascii(&self, tag: u16, s: &str) -> Field {
            let mut b = s.as_bytes().to_vec();
            b.push(0);
            (tag, 2, b.len() as u32, b)
        }
        fn short(&self, tag: u16, v: u16) -> Field {
            (tag, 3, 1, self.u16b(v))
        }
        fn long(&self, tag: u16, v: u32) -> Field {
            (tag, 4, 1, self.u32b(v))
        }
        fn rationals(&self, tag: u16, vs: &[(u32, u32)]) -> Field {
            let b = vs.iter().flat_map(|&(n, d)| [self.u32b(n), self.u32b(d)].concat()).collect();
            (tag, 5, vs.len() as u32, b)
        }
        /// IFD 를 지금 끝에 붙이고 그 자리를 돌려준다. 긴 값은 IFD 바로 뒤에 놓는다.
        fn ifd(&mut self, fields: &[Field]) -> u32 {
            let at = self.buf.len();
            let data_at = at + 2 + fields.len() * 12 + 4;
            let mut data: Vec<u8> = Vec::new();
            let mut out = self.u16b(fields.len() as u16);
            for (tag, typ, count, val) in fields {
                out.extend(self.u16b(*tag));
                out.extend(self.u16b(*typ));
                out.extend(self.u32b(*count));
                if val.len() <= 4 {
                    let mut v = val.clone();
                    v.resize(4, 0);
                    out.extend(v);
                } else {
                    out.extend(self.u32b((data_at + data.len()) as u32));
                    data.extend(val);
                }
            }
            out.extend([0; 4]); // 다음 IFD 없음
            self.buf.extend(out);
            self.buf.extend(data);
            at as u32
        }
        fn set_ifd0(&mut self, at: u32) {
            let b = self.u32b(at);
            self.buf[4..8].copy_from_slice(&b);
        }
    }

    /// 카메라 사진 한 장 분량 — IFD0(제조사·모델·방향·시각) → Exif IFD → GPS IFD.
    fn camera_tiff(le: bool) -> Vec<u8> {
        let mut b = Builder::new(le);
        let exif = b.ifd(&[
            b.rationals(0x829A, &[(1, 120)]),
            b.rationals(0x829D, &[(18, 10)]),
            b.short(0x8827, 50),
            b.ascii(0x9003, "2026:11:04 15:30:12"),
            b.rationals(0x920A, &[(42, 10)]),
            b.ascii(0xA434, "iPhone 13 back camera 4.2mm f/1.8"),
        ]);
        let gps = b.ifd(&[
            b.ascii(0x0001, "N"),
            b.rationals(0x0002, &[(37, 1), (30, 1), (36, 1)]),
            b.ascii(0x0003, "W"),
            b.rationals(0x0004, &[(127, 1), (0, 1), (0, 1)]),
        ]);
        let ifd0 = b.ifd(&[
            b.ascii(0x010F, "Apple"),
            b.ascii(0x0110, "iPhone 13"),
            b.short(0x0112, 6),
            b.ascii(0x0132, "2026:11:05 09:00:00"),
            b.long(0x8769, exif),
            b.long(0x8825, gps),
        ]);
        b.set_ifd0(ifd0);
        b.buf
    }

    fn approx(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-9)
    }

    #[test]
    fn exif_reads_camera_tags_in_both_byte_orders() {
        for le in [true, false] {
            // JPEG APP1 모양 — 헤더 앞에 마커·`Exif\0\0` 이 있다.
            let mut file = vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x00];
            file.extend(b"Exif\0\0");
            file.extend(camera_tiff(le));
            let s = parse_exif(&file).unwrap_or_else(|| panic!("le={le}: 못 찾았다"));
            assert_eq!(s.make.as_deref(), Some("Apple"), "le={le}");
            assert_eq!(s.model.as_deref(), Some("iPhone 13"));
            assert_eq!(s.orientation, Some(6));
            assert_eq!(s.taken_at.as_deref(), Some("2026-11-04 15:30:12"), "DateTimeOriginal 이 DateTime 보다 먼저");
            assert!(approx(s.exposure, 1.0 / 120.0));
            assert!(approx(s.f_number, 1.8));
            assert_eq!(s.iso, Some(50));
            assert!(approx(s.focal_length, 4.2));
            assert_eq!(s.lens.as_deref(), Some("iPhone 13 back camera 4.2mm f/1.8"));
            assert!(approx(s.gps_lat, 37.51), "37°30'36\"N = 37.51: {:?}", s.gps_lat);
            assert!(approx(s.gps_lon, -127.0), "서경은 음수");
        }
    }

    /// 깨진 EXIF 는 오류가 아니라 없음이다 — 어디서 잘라도 패닉 없이 None 이거나, 잘리기 전까지의 태그만 남는다.
    #[test]
    fn exif_truncated_or_corrupt_is_none_not_a_panic() {
        let full = camera_tiff(true);
        for cut in 0..full.len() {
            let _ = parse_exif(&full[..cut]); // 범위 밖 접근이 하나라도 있으면 여기서 패닉
        }
        assert_eq!(parse_exif(&full[..8]), None, "IFD0 이 없다");
        assert_eq!(parse_exif(b""), None);
        assert_eq!(parse_exif(b"not an image at all"), None);

        // IFD0 오프셋이 파일 밖 · 항목 개수가 남은 바이트보다 많다
        let mut far = full.clone();
        far[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(parse_exif(&far), None);
        let mut b = Builder::new(true);
        b.buf.extend(b.u16b(500)); // 500개라더니 바로 끝난다
        let at = 8;
        b.set_ifd0(at);
        assert_eq!(parse_exif(&b.buf), None);

        // 값 오프셋이 밖을 가리키는 긴 문자열 · 분모 0 · 범위 밖 방향 → 그 태그만 버린다
        let mut b = Builder::new(false);
        let exif = b.ifd(&[b.rationals(0x829A, &[(1, 0)]), b.long(0x8827, 400)]);
        let ifd0 = b.ifd(&[
            (0x010F, 2, 1000, vec![0, 0, 0xFF, 0xFF]),
            b.ascii(0x0110, "EOS R5"),
            b.short(0x0112, 9),
            b.long(0x8769, exif),
            b.long(0x8825, 0xFFFF_FF00), // GPS IFD 가 밖
        ]);
        b.set_ifd0(ifd0);
        let s = parse_exif(&b.buf).expect("모델은 멀쩡하다");
        assert_eq!((s.make, s.model.as_deref(), s.orientation), (None, Some("EOS R5"), None));
        assert_eq!((s.exposure, s.iso, s.gps_lat), (None, Some(400), None), "분모 0 · LONG ISO · 밖을 가리키는 GPS");
    }

    /// HEIC 처럼 앞에 다른 박스가 잔뜩 있고, 그 사이에 우연한 헤더 모양이 먼저 나와도 `Exif\0\0` 뒤의 진짜를 고른다.
    #[test]
    fn exif_prefers_header_after_exif_marker() {
        let mut file = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec();
        file.extend(b"II*\0garbage-that-looks-like-a-header");
        file.extend([0, 0, 0, 6]);
        file.extend(b"Exif\0\0");
        file.extend(camera_tiff(false));
        let s = parse_exif(&file).expect("Exif 항목");
        assert_eq!(s.make.as_deref(), Some("Apple"));
        assert_eq!(s.orientation, Some(6));
    }

    /// HEIC 처럼 TIFF 블록 뒤에 다른 바이트가 이어져도 블록만 정확히 잘라 낸다. 값 하나라도 밖을 가리키면 통째로 None.
    #[test]
    fn exif_tiff_block_cuts_exactly_and_rejects_broken() {
        for le in [true, false] {
            let tiff = camera_tiff(le);
            let mut file = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic\0\0\0\x06Exif\0\0".to_vec();
            let at = file.len();
            file.extend(&tiff);
            file.extend(b"mdat-image-bytes-follow".repeat(50));
            let block = exif_tiff_block(&file).unwrap_or_else(|| panic!("le={le}: 못 찾았다"));
            assert_eq!(block, &file[at..at + tiff.len()], "le={le}: 블록 끝 = 마지막 값의 끝");
            assert_eq!(parse_exif(block).and_then(|s| s.orientation), Some(6), "잘라 낸 블록만으로 읽힌다");
        }

        // 꼬리가 잘려 마지막 값(GPS 가 아니라 IFD0 의 긴 값)이 밖으로 나간다 → 반쯤 잘린 블록을 내주지 않는다
        let tiff = camera_tiff(true);
        assert_eq!(exif_tiff_block(&tiff[..tiff.len() - 1]), None);
        assert_eq!(exif_tiff_block(b"no exif here"), None);

        // Exif IFD 를 가리키는 값이 밖 → 부분만 옮기지 않는다
        let mut b = Builder::new(true);
        let ifd0 = b.ifd(&[b.ascii(0x010F, "Apple"), b.long(0x8769, 0xFFFF_0000)]);
        b.set_ifd0(ifd0);
        assert_eq!(exif_tiff_block(&b.buf), None);

        // JPEG APP1 에 못 들어가는 크기는 내주지 않는다
        let mut b = Builder::new(false);
        let big = "x".repeat(MAX_EXIF_TIFF_BYTES);
        let ifd0 = b.ifd(&[b.ascii(0x010E, &big)]);
        b.set_ifd0(ifd0);
        assert_eq!(exif_tiff_block(&b.buf), None);
    }

    #[test]
    fn exif_date_normalizes_and_drops_blank() {
        assert_eq!(exif_date("2024:05:01 12:34:56").as_deref(), Some("2024-05-01 12:34:56"));
        assert_eq!(exif_date("0000:00:00 00:00:00"), None);
        assert_eq!(exif_date("    :  :     :  :  "), None);
        assert_eq!(exif_date("2024"), None);
    }

    #[test]
    fn exif_summary_serializes_without_missing_keys() {
        let s = ExifSummary { make: Some("Apple".into()), f_number: Some(1.8), ..ExifSummary::default() };
        assert_eq!(serde_json::to_string(&s).unwrap(), r#"{"make":"Apple","fNumber":1.8}"#);
    }

    /// 실제 사진(사용자 다운로드 폴더 — CI·다른 머신엔 없다). `cargo test --lib exif_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn exif_real_photos() {
        use std::io::Read;
        let dir = r"C:\Users\GreatHoon\Downloads\drive-download-20261104T060517Z-1-001";
        for name in ["IMG_1475.jpeg", "IMG_1490.HEIC"] {
            let mut head = Vec::new();
            std::fs::File::open(std::path::Path::new(dir).join(name))
                .unwrap()
                .take(EXIF_SCAN_BYTES)
                .read_to_end(&mut head)
                .unwrap();
            let block = exif_tiff_block(&head).map(|b| (b.as_ptr() as usize - head.as_ptr() as usize, b.len()));
            println!("{name}: {:?} · TIFF 블록(자리, 길이) {block:?}", parse_exif(&head));
        }
    }
}
