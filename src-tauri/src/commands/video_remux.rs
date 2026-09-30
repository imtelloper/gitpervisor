// 조각 MP4(fMP4) → 일반 MP4 전용 리먹서 — "빠른 재생용 사본"(VideoPlayer fastStart)의 1차 경로.
//
// ffmpeg(`-c copy -movflags +faststart`)로는 느리다(2026-09-30 실측, 11GB·조각 205,619개·USB HDD): ① 색인이 없어 조각
// 헤더를 먼저 다 훑고(20만 번 시크, 그동안 진행률 0%) ② 같은 디스크에서 작은 단위로 읽기·쓰기를 오가며 ~20MB/s로 복사한 뒤
// ③ faststart로 11GB를 한 번 더 읽고 쓴다. 여기서는 원본을 시크 없이 앞에서부터 한 번 읽고 샘플 바이트만 큰 블록으로 흘려
// 쓴 뒤, 모아 둔 샘플 표로 만든 moov를 **끝에** 붙인다.
//
// faststart(moov를 앞으로)는 일부러 하지 않는다 — 다 쓴 11GB를 한 번 더 옮겨 써야 하고 그게 ffmpeg 경로 병목의 절반이다.
// 웹뷰는 로컬 파일을 범위 요청으로 읽으므로 끝의 moov도 한 번 읽으면 그만이다.
//
// 다루는 범위는 좁다(비디오 트랙 1개·암호화 없음·조각의 샘플이 바로 뒤 mdat 안에 순서대로). 조금이라도 벗어나면
// Unsupported로 멈추고(임시 파일은 지운다) 프런트가 같은 잡 id로 기존 ffmpeg 경로를 부른다 — 조용히 틀린 파일을 만드는
// 것이 가장 나쁘다. 박스 파싱·표 생성·박스 쓰기는 IO와 떼어 두었다(아래 테스트가 합성 바이트로 검증한다).

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use super::projects::project_path;
use super::video::{commit_tmp_output, ExportFinished, ExportProgress, JobGuard, VideoJob};
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_video;
use crate::state::AppState;

/// 읽기·쓰기 한 번의 크기. 같은 HDD에서 읽기와 쓰기가 헤드를 번갈아 옮기므로 한 번에 크게 옮겨 오가는 횟수를 줄인다.
/// 2026-09-30 실측(USB HDD, 1.5GB·조각 3만 개, 캐시 비운 원본): 4MiB 40.3s · 16MiB 35.6/36.8s · 64MiB 34.1/32.6s —
/// 같은 디스크의 순차 읽기만 19.1s라 읽기+쓰기 직렬 한계(~38s)에 닿았다. 블록마다 sync_data로 쓰기를 강제로 번갈게 해도
/// 빨라지지 않았다(16MiB 39.5s · 64MiB 35.3s) — OS 쓰기 캐시에 맡긴다. 잡 하나에 버퍼 둘(128MiB)은 잠깐이다.
const REMUX_BLOCK: usize = 64 << 20;

/// sample_flags의 sample_is_non_sync_sample 비트(ISO/IEC 14496-12 8.8.3.1).
const SAMPLE_NON_SYNC: u32 = 0x0001_0000;

/// trun 하나가 주장할 수 있는 샘플 수 상한 — 기형 헤더가 수십억 개를 주장해도 그만큼 메모리를 잡지 않게. 실파일은 조각당
/// 1개, 흔한 조각 MP4도 조각당 수천 개다. 넘으면 Unsupported(ffmpeg 경로).
const MAX_TRUN_SAMPLES: u32 = 1 << 20;

/// 출력 mdat 머리 — 64비트 largesize(size=1) 자리를 먼저 쓰고 끝에서 되돌아가 크기를 적는다.
const MDAT_LARGE_HEADER: [u8; 16] = [0, 0, 0, 1, b'm', b'd', b'a', b't', 0, 0, 0, 0, 0, 0, 0, 0];

#[derive(Debug)]
enum RemuxError {
    /// 이 리먹서가 다루지 않는 구조 — 문자열은 로그·진단용 이유(박스 이름 등).
    Unsupported(String),
    /// 박스가 파일 끝을 넘는다(녹화가 끊긴 파일).
    Truncated,
    Cancelled,
    Io(std::io::Error),
}

impl From<std::io::Error> for RemuxError {
    fn from(e: std::io::Error) -> Self {
        RemuxError::Io(e)
    }
}

fn unsupported<T>(why: impl Into<String>) -> Result<T, RemuxError> {
    Err(RemuxError::Unsupported(why.into()))
}

fn fourcc(t: &[u8]) -> String {
    t.iter().map(|&c| if c.is_ascii_graphic() { c as char } else { '?' }).collect()
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn be64(b: &[u8]) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[..8]);
    u64::from_be_bytes(a)
}

// ══════════════════════════ 박스 읽기 (순수) ══════════════════════════

struct Bx<'a> {
    typ: [u8; 4],
    raw: &'a [u8],
    body: &'a [u8],
}

/// 통째로 읽어 둔 버퍼 안의 박스들. 크기가 어긋나면 Unsupported — 이미 다 읽은 버퍼라 잘린 게 아니라 기형이다.
fn boxes(mut b: &[u8]) -> Result<Vec<Bx<'_>>, RemuxError> {
    let mut out = Vec::new();
    while !b.is_empty() {
        if b.len() < 8 {
            return unsupported("malformed box header");
        }
        let typ = [b[4], b[5], b[6], b[7]];
        let (size, hdr) = match be32(b) {
            1 if b.len() >= 16 => (be64(&b[8..]), 16),
            1 => return unsupported("malformed box header"),
            0 => (b.len() as u64, 8),
            n => (u64::from(n), 8),
        };
        if size < hdr as u64 || size > b.len() as u64 {
            return unsupported(format!("malformed {} box size", fourcc(&typ)));
        }
        let (raw, rest) = b.split_at(size as usize);
        out.push(Bx { typ, raw, body: &raw[hdr..] });
        b = rest;
    }
    Ok(out)
}

/// 박스 본문을 앞에서부터 읽는다 — 모자라면 Unsupported(`what` = 박스 이름).
struct Rd<'a> {
    b: &'a [u8],
    what: &'static str,
}

impl<'a> Rd<'a> {
    fn new(b: &'a [u8], what: &'static str) -> Self {
        Rd { b, what }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], RemuxError> {
        if self.b.len() < n {
            return unsupported(format!("short {} box", self.what));
        }
        let (h, t) = self.b.split_at(n);
        self.b = t;
        Ok(h)
    }

    fn u32(&mut self) -> Result<u32, RemuxError> {
        Ok(be32(self.take(4)?))
    }

    fn u64(&mut self) -> Result<u64, RemuxError> {
        Ok(be64(self.take(8)?))
    }

    /// version 1이면 64비트, 0이면 32비트 필드.
    fn uv(&mut self, v: u8) -> Result<u64, RemuxError> {
        if v == 1 { self.u64() } else { Ok(u64::from(self.u32()?)) }
    }

    /// full box 머리 (version, flags). 여기서 읽는 박스는 전부 version 0/1까지만 정의돼 있다 — 그 밖은 모르는 배치다.
    fn full(&mut self) -> Result<(u8, u32), RemuxError> {
        let v = self.u32()?;
        if v >> 24 > 1 {
            return unsupported(format!("{} version {}", self.what, v >> 24));
        }
        Ok(((v >> 24) as u8, v & 0x00FF_FFFF))
    }
}

// ══════════════════════════ init(moov) ══════════════════════════

#[derive(Debug, Clone, Copy)]
struct Trex {
    sdi: u32,
    duration: u32,
    size: u32,
    flags: u32,
}

struct Init {
    /// 원본 moov 박스 전체 — 끝에서 다시 걸으며 길이·표만 고쳐 쓴다.
    moov: Vec<u8>,
    track_id: u32,
    movie_timescale: u32,
    media_timescale: u32,
    stsd_entries: u32,
    trex: Trex,
    /// edts가 있으면 그 구간 길이 합(무비 시간 단위) — tkhd·mvhd 길이가 된다.
    edit_duration: Option<u64>,
}

fn parse_init(moov_raw: &[u8]) -> Result<Init, RemuxError> {
    let top = boxes(moov_raw)?;
    let Some(moov) = top.first() else { return unsupported("empty moov") };
    let mut movie_timescale = None;
    let mut traks = Vec::new();
    let mut trexes = Vec::new();
    for b in boxes(moov.body)? {
        match &b.typ {
            b"mvhd" => {
                let mut r = Rd::new(b.body, "mvhd");
                let (v, _) = r.full()?;
                r.take(if v == 1 { 16 } else { 8 })?;
                movie_timescale = Some(r.u32()?);
            }
            b"trak" => traks.push(b.body),
            // mvex는 통째로 버린다(일반 mp4에 남으면 플레이어가 조각을 찾는다) — 필요한 건 trex 기본값뿐이다.
            b"mvex" => {
                for c in boxes(b.body)? {
                    if &c.typ == b"trex" {
                        let mut r = Rd::new(c.body, "trex");
                        r.full()?;
                        let id = r.u32()?;
                        let t = Trex { sdi: r.u32()?, duration: r.u32()?, size: r.u32()?, flags: r.u32()? };
                        trexes.push((id, t));
                    }
                }
            }
            b"udta" | b"meta" | b"iods" => {}
            b"pssh" => return unsupported("encrypted (pssh)"),
            t => return unsupported(format!("moov/{}", fourcc(t))),
        }
    }
    if traks.len() != 1 {
        return unsupported(format!("{} tracks", traks.len()));
    }
    let trak = parse_trak(traks[0])?;
    let Some(movie_timescale) = movie_timescale.filter(|t| *t > 0) else {
        return unsupported("mvhd timescale");
    };
    let Some(&(_, trex)) = trexes.iter().find(|(id, _)| *id == trak.track_id) else {
        return unsupported("no trex for the track");
    };
    Ok(Init {
        moov: moov_raw.to_vec(),
        track_id: trak.track_id,
        movie_timescale,
        media_timescale: trak.media_timescale,
        stsd_entries: trak.stsd_entries,
        trex,
        edit_duration: trak.edit_duration,
    })
}

struct TrakInfo {
    track_id: u32,
    media_timescale: u32,
    stsd_entries: u32,
    edit_duration: Option<u64>,
}

fn parse_trak(body: &[u8]) -> Result<TrakInfo, RemuxError> {
    let mut track_id = None;
    let mut media = None;
    let mut edit_duration = None;
    for b in boxes(body)? {
        match &b.typ {
            b"tkhd" => {
                let mut r = Rd::new(b.body, "tkhd");
                let (v, _) = r.full()?;
                r.take(if v == 1 { 16 } else { 8 })?;
                track_id = Some(r.u32()?);
            }
            b"edts" => edit_duration = Some(edit_list_duration(b.body)?),
            b"mdia" => media = Some(parse_mdia(b.body)?),
            b"udta" | b"meta" => {}
            t => return unsupported(format!("trak/{}", fourcc(t))),
        }
    }
    let (Some(track_id), Some((media_timescale, stsd_entries))) = (track_id, media) else {
        return unsupported("trak without tkhd or mdia");
    };
    Ok(TrakInfo { track_id, media_timescale, stsd_entries, edit_duration })
}

fn edit_list_duration(body: &[u8]) -> Result<u64, RemuxError> {
    let mut total = 0u64;
    for b in boxes(body)? {
        if &b.typ != b"elst" {
            return unsupported(format!("edts/{}", fourcc(&b.typ)));
        }
        let mut r = Rd::new(b.body, "elst");
        let (v, _) = r.full()?;
        for _ in 0..r.u32()? {
            let dur = r.uv(v)?;
            r.take(if v == 1 { 8 } else { 4 })?; // media_time
            r.take(4)?; // media_rate
            // 조각 파일의 0은 "끝까지"라는 뜻이다(길이를 모르는 init). 일반 mp4로 옮기면 뜻이 바뀐다.
            if dur == 0 {
                return unsupported("open-ended edit list");
            }
            let Some(t) = total.checked_add(dur) else { return unsupported("edit list overflow") };
            total = t;
        }
    }
    if total == 0 {
        return unsupported("empty edit list");
    }
    Ok(total)
}

/// → (미디어 timescale, stsd 항목 수).
fn parse_mdia(body: &[u8]) -> Result<(u32, u32), RemuxError> {
    let mut timescale = None;
    let mut handler_ok = false;
    let mut entries = None;
    for b in boxes(body)? {
        match &b.typ {
            b"mdhd" => {
                let mut r = Rd::new(b.body, "mdhd");
                let (v, _) = r.full()?;
                r.take(if v == 1 { 16 } else { 8 })?;
                timescale = Some(r.u32()?);
            }
            b"hdlr" => {
                let mut r = Rd::new(b.body, "hdlr");
                r.full()?;
                r.take(4)?; // pre_defined
                let h = r.take(4)?;
                if h != b"vide" {
                    return unsupported(format!("{} track", fourcc(h)));
                }
                handler_ok = true;
            }
            b"minf" => entries = Some(parse_minf(b.body)?),
            b"elng" | b"udta" => {}
            t => return unsupported(format!("mdia/{}", fourcc(t))),
        }
    }
    match (timescale.filter(|t| *t > 0), handler_ok, entries) {
        (Some(ts), true, Some(n)) => Ok((ts, n)),
        _ => unsupported("mdia without mdhd, hdlr or minf"),
    }
}

fn parse_minf(body: &[u8]) -> Result<u32, RemuxError> {
    let mut entries = None;
    for b in boxes(body)? {
        match &b.typ {
            b"vmhd" | b"smhd" | b"nmhd" | b"hmhd" | b"sthd" => {}
            b"dinf" => {
                for d in boxes(b.body)? {
                    if &d.typ != b"dref" {
                        return unsupported(format!("dinf/{}", fourcc(&d.typ)));
                    }
                    let mut r = Rd::new(d.body, "dref");
                    r.full()?;
                    let n = r.u32()?;
                    let refs = boxes(r.b)?;
                    if refs.len() != n as usize {
                        return unsupported("dref entry count");
                    }
                    for e in refs {
                        // flags 1 = 데이터가 이 파일 안에 있다. 다른 파일을 가리키면 옮길 샘플이 여기 없다.
                        if Rd::new(e.body, "dref").full()?.1 & 1 == 0 {
                            return unsupported("external data reference");
                        }
                    }
                }
            }
            b"stbl" => entries = Some(parse_stbl(b.body)?),
            t => return unsupported(format!("minf/{}", fourcc(t))),
        }
    }
    match entries {
        Some(n) => Ok(n),
        None => unsupported("minf without stbl"),
    }
}

fn parse_stbl(body: &[u8]) -> Result<u32, RemuxError> {
    let mut entries = None;
    for b in boxes(body)? {
        match &b.typ {
            b"stsd" => {
                let mut r = Rd::new(b.body, "stsd");
                r.full()?;
                let n = r.u32()?;
                let list = boxes(r.b)?;
                if n == 0 || list.len() != n as usize {
                    return unsupported("stsd entry count");
                }
                // encv·enca… 이거나 sinf(보호 정보)를 품은 항목 — 샘플이 암호문이다. sinf 바이트가 우연히 코덱 설정에 섞여
                // 있어도 지원 밖으로 돌릴 뿐이다(ffmpeg 경로).
                if list.iter().any(|e| e.typ.starts_with(b"enc") || e.raw.windows(4).any(|w| w == b"sinf")) {
                    return unsupported("encrypted sample entry");
                }
                entries = Some(n);
            }
            // empty_moov init은 표가 비어 있다. 차 있으면 moov에도 샘플이 있는 파일이다 — 두 출처를 합치는 경우는 다루지 않는다.
            b"stts" | b"ctts" | b"stss" | b"stsc" | b"stco" | b"co64" => {
                let mut r = Rd::new(b.body, "stbl");
                r.full()?;
                if r.u32()? != 0 {
                    return unsupported("samples in moov");
                }
            }
            b"stsz" | b"stz2" => {
                let mut r = Rd::new(b.body, "stsz");
                r.full()?;
                r.take(4)?;
                if r.u32()? != 0 {
                    return unsupported("samples in moov");
                }
            }
            t => return unsupported(format!("stbl/{}", fourcc(t))),
        }
    }
    match entries {
        Some(n) => Ok(n),
        None => unsupported("stbl without stsd"),
    }
}

// ══════════════════════════ 조각(moof) ══════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Sample {
    /// 원본 파일 안 절대 위치.
    offset: u64,
    size: u32,
    duration: u32,
    flags: u32,
    cto: i32,
}

struct Fragment {
    tfdt: Option<u64>,
    sdi: u32,
    has_cto: bool,
    samples: Vec<Sample>,
}

const TFHD_KNOWN: u32 = 0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x2_0000;
const TRUN_KNOWN: u32 = 0x1 | 0x4 | 0x100 | 0x200 | 0x400 | 0x800;

/// moof 박스 전체와 그 원본 위치 → 샘플(원본 절대 위치 포함).
fn parse_moof(moof_raw: &[u8], moof_at: u64, init: &Init) -> Result<Fragment, RemuxError> {
    let top = boxes(moof_raw)?;
    let Some(moof) = top.first() else { return unsupported("empty moof") };
    let mut traf = None;
    for b in boxes(moof.body)? {
        match &b.typ {
            b"mfhd" => {}
            b"traf" if traf.is_some() => return unsupported("several traf in one moof"),
            b"traf" => traf = Some(b.body),
            b"pssh" => return unsupported("encrypted (pssh)"),
            t => return unsupported(format!("moof/{}", fourcc(t))),
        }
    }
    let Some(traf) = traf else { return unsupported("moof without traf") };
    let kids = boxes(traf)?;
    let Some(tfhd) = kids.first().filter(|b| &b.typ == b"tfhd") else {
        return unsupported("traf does not start with tfhd");
    };
    let mut r = Rd::new(tfhd.body, "tfhd");
    let (_, tf) = r.full()?;
    // 0x10000(duration-is-empty)도 여기서 걸린다 — 샘플 없는 조각의 길이만 알리는 배치라 표로 옮길 뜻이 다르다.
    if tf & !TFHD_KNOWN != 0 {
        return unsupported(format!("tfhd flags {tf:#x}"));
    }
    if r.u32()? != init.track_id {
        return unsupported("tfhd track id");
    }
    // base-data-offset이 없으면 기준은 moof 시작이다 — default-base-is-moof든 아니든 traf가 하나뿐이면 같다(8.8.7.1).
    let base = if tf & 0x1 != 0 { r.u64()? } else { moof_at };
    let sdi = if tf & 0x2 != 0 { r.u32()? } else { init.trex.sdi };
    let d_dur = if tf & 0x8 != 0 { r.u32()? } else { init.trex.duration };
    let d_size = if tf & 0x10 != 0 { r.u32()? } else { init.trex.size };
    let d_flags = if tf & 0x20 != 0 { r.u32()? } else { init.trex.flags };
    if sdi == 0 || sdi > init.stsd_entries {
        return unsupported("sample description index");
    }

    let mut frag = Fragment { tfdt: None, sdi, has_cto: false, samples: Vec::new() };
    let mut next = base;
    for b in &kids[1..] {
        match &b.typ {
            b"tfdt" if frag.tfdt.is_some() => return unsupported("two tfdt"),
            b"tfdt" => {
                let mut r = Rd::new(b.body, "tfdt");
                let (v, _) = r.full()?;
                frag.tfdt = Some(r.uv(v)?);
            }
            b"trun" => {
                let mut r = Rd::new(b.body, "trun");
                let (v, fl) = r.full()?;
                if fl & !TRUN_KNOWN != 0 {
                    return unsupported(format!("trun flags {fl:#x}"));
                }
                // 둘 다 있으면 첫 샘플 값이 어느 쪽인지 규격이 정하지 않는다.
                if fl & 0x4 != 0 && fl & 0x400 != 0 {
                    return unsupported("trun first-sample-flags with per-sample flags");
                }
                let n = r.u32()?;
                if n > MAX_TRUN_SAMPLES {
                    return unsupported(format!("{n} samples in one trun"));
                }
                let start = if fl & 0x1 != 0 {
                    let off = i64::from(r.u32()? as i32);
                    let Some(s) = base.checked_add_signed(off) else { return unsupported("trun data offset") };
                    s
                } else {
                    next
                };
                let first_flags = if fl & 0x4 != 0 { Some(r.u32()?) } else { None };
                frag.has_cto |= fl & 0x800 != 0;
                let mut at = start;
                for i in 0..n {
                    let duration = if fl & 0x100 != 0 { r.u32()? } else { d_dur };
                    let size = if fl & 0x200 != 0 { r.u32()? } else { d_size };
                    let flags = if fl & 0x400 != 0 {
                        r.u32()?
                    } else {
                        first_flags.filter(|_| i == 0).unwrap_or(d_flags)
                    };
                    let cto = if fl & 0x800 == 0 {
                        0
                    } else if v == 1 {
                        r.u32()? as i32
                    } else {
                        // version 0은 부호 없는 값이다. i32를 넘으면 ctts(어느 버전이든)에서 음수로 읽힌다.
                        let Ok(c) = i32::try_from(r.u32()?) else { return unsupported("composition offset") };
                        c
                    };
                    // 크기 0 샘플은 쓸 바이트가 없는데 표에는 남는다 — 정상 녹화물엔 없고, 있으면 기형 헤더일 공산이 크다.
                    if size == 0 {
                        return unsupported("empty sample");
                    }
                    frag.samples.push(Sample { offset: at, size, duration, flags, cto });
                    let Some(e) = at.checked_add(u64::from(size)) else { return unsupported("sample offset") };
                    at = e;
                }
                next = at;
            }
            b"senc" | b"saiz" | b"saio" => return unsupported(format!("encrypted ({})", fourcc(&b.typ))),
            b"sbgp" | b"sgpd" => return unsupported("sample groups"),
            t => return unsupported(format!("traf/{}", fourcc(t))),
        }
    }
    Ok(frag)
}

// ══════════════════════════ 샘플 표 (순수) ══════════════════════════

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Chunk {
    /// 출력 파일 안 절대 위치.
    offset: u64,
    samples: u32,
    sdi: u32,
}

#[derive(Default)]
struct Tables {
    durations: Vec<u32>,
    sizes: Vec<u32>,
    /// has_cto인 조각이 하나라도 오면 샘플마다 채운다(그 전 조각의 샘플은 0).
    ctos: Vec<i32>,
    has_cto: bool,
    /// 1부터 센 동기 샘플 번호.
    sync: Vec<u32>,
    chunks: Vec<Chunk>,
    start_dts: u64,
    next_dts: u64,
}

impl Tables {
    /// 조각 하나 = 청크 하나. 출력은 샘플 바이트만 이어 쓰므로 청크 위치는 지금 출력 위치다.
    fn push(&mut self, frag: &Fragment, out_offset: u64) -> Result<(), RemuxError> {
        if frag.samples.is_empty() {
            return Ok(());
        }
        if let Some(t) = frag.tfdt {
            let next = self.next_dts;
            match self.durations.last_mut() {
                // 첫 시각이 0이 아니어도 일반 mp4의 dts는 0에서 시작한다 — 기존 ffmpeg 경로(-avoid_negative_ts make_zero)와 같다.
                None => {
                    self.start_dts = t;
                    self.next_dts = t;
                }
                // 구멍·겹침 — 앞 샘플 길이를 늘이거나 줄여 이 조각이 원본 시각(tfdt)에서 시작하게 한다.
                Some(last) if t != next => {
                    let last_dts = next - u64::from(*last);
                    let Some(d) = t.checked_sub(last_dts).filter(|d| *d > 0).and_then(|d| u32::try_from(d).ok()) else {
                        return unsupported("tfdt goes back past the previous sample");
                    };
                    *last = d;
                    self.next_dts = t;
                }
                Some(_) => {}
            }
        }
        if frag.has_cto && !self.has_cto {
            self.has_cto = true;
            self.ctos.resize(self.sizes.len(), 0);
        }
        for s in &frag.samples {
            let Ok(number) = u32::try_from(self.sizes.len() + 1) else { return unsupported("too many samples") };
            let Some(next) = self.next_dts.checked_add(u64::from(s.duration)) else {
                return unsupported("duration overflow");
            };
            self.next_dts = next;
            self.durations.push(s.duration);
            self.sizes.push(s.size);
            if self.has_cto {
                self.ctos.push(s.cto);
            }
            if s.flags & SAMPLE_NON_SYNC == 0 {
                self.sync.push(number);
            }
        }
        self.chunks.push(Chunk { offset: out_offset, samples: frag.samples.len() as u32, sdi: frag.sdi });
        Ok(())
    }

    fn media_duration(&self) -> u64 {
        self.next_dts - self.start_dts
    }
}

/// 같은 값이 이어지는 구간 → (개수, 값). 전체 샘플 수가 u32 안이라(Tables::push) 개수도 u32에 든다.
fn runs<T: PartialEq + Copy>(v: &[T]) -> Vec<(u32, T)> {
    let mut out: Vec<(u32, T)> = Vec::new();
    for &x in v {
        match out.last_mut() {
            Some((n, y)) if *y == x => *n += 1,
            _ => out.push((1, x)),
        }
    }
    out
}

fn boxed(typ: &[u8; 4], body: &[u8]) -> Result<Vec<u8>, RemuxError> {
    let Ok(size) = u32::try_from(body.len() + 8) else {
        return unsupported(format!("{} box over 4 GiB", fourcc(typ)));
    };
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&size.to_be_bytes());
    v.extend_from_slice(typ);
    v.extend_from_slice(body);
    Ok(v)
}

fn full_box(typ: &[u8; 4], version: u8, flags: u32, content: &[u8]) -> Result<Vec<u8>, RemuxError> {
    let mut body = Vec::with_capacity(content.len() + 4);
    body.extend_from_slice(&((u32::from(version) << 24) | flags).to_be_bytes());
    body.extend_from_slice(content);
    boxed(typ, &body)
}

/// 새 샘플 표 — stts · ctts(cto가 있으면) · stss(전부 키프레임이면 생략) · stsz · stsc · co64.
fn stbl_tables(t: &Tables) -> Result<Vec<u8>, RemuxError> {
    let n = t.sizes.len() as u32;
    let mut out = Vec::new();

    let stts = runs(&t.durations);
    let mut c = Vec::with_capacity(4 + stts.len() * 8);
    c.extend_from_slice(&(stts.len() as u32).to_be_bytes());
    for (k, d) in &stts {
        c.extend_from_slice(&k.to_be_bytes());
        c.extend_from_slice(&d.to_be_bytes());
    }
    out.extend(full_box(b"stts", 0, 0, &c)?);

    if t.has_cto {
        let ctts = runs(&t.ctos);
        let mut c = Vec::with_capacity(4 + ctts.len() * 8);
        c.extend_from_slice(&(ctts.len() as u32).to_be_bytes());
        for (k, o) in &ctts {
            c.extend_from_slice(&k.to_be_bytes());
            c.extend_from_slice(&o.to_be_bytes());
        }
        let version = u8::from(t.ctos.iter().any(|o| *o < 0));
        out.extend(full_box(b"ctts", version, 0, &c)?);
    }

    // stss가 없으면 전부 동기 샘플이다(8.6.2.1).
    if t.sync.len() < t.sizes.len() {
        let mut c = Vec::with_capacity(4 + t.sync.len() * 4);
        c.extend_from_slice(&(t.sync.len() as u32).to_be_bytes());
        for s in &t.sync {
            c.extend_from_slice(&s.to_be_bytes());
        }
        out.extend(full_box(b"stss", 0, 0, &c)?);
    }

    let mut c = Vec::with_capacity(8 + t.sizes.len() * 4);
    if t.sizes.iter().all(|s| *s == t.sizes[0]) {
        c.extend_from_slice(&t.sizes[0].to_be_bytes());
        c.extend_from_slice(&n.to_be_bytes());
    } else {
        c.extend_from_slice(&0u32.to_be_bytes());
        c.extend_from_slice(&n.to_be_bytes());
        for s in &t.sizes {
            c.extend_from_slice(&s.to_be_bytes());
        }
    }
    out.extend(full_box(b"stsz", 0, 0, &c)?);

    let mut rows: Vec<(u32, u32, u32)> = Vec::new();
    for (i, ch) in t.chunks.iter().enumerate() {
        if rows.last().map(|r| (r.1, r.2)) != Some((ch.samples, ch.sdi)) {
            rows.push((i as u32 + 1, ch.samples, ch.sdi));
        }
    }
    let mut c = Vec::with_capacity(4 + rows.len() * 12);
    c.extend_from_slice(&(rows.len() as u32).to_be_bytes());
    for (first, per, sdi) in &rows {
        c.extend_from_slice(&first.to_be_bytes());
        c.extend_from_slice(&per.to_be_bytes());
        c.extend_from_slice(&sdi.to_be_bytes());
    }
    out.extend(full_box(b"stsc", 0, 0, &c)?);

    let mut c = Vec::with_capacity(4 + t.chunks.len() * 8);
    c.extend_from_slice(&(t.chunks.len() as u32).to_be_bytes());
    for ch in &t.chunks {
        c.extend_from_slice(&ch.offset.to_be_bytes());
    }
    out.extend(full_box(b"co64", 0, 0, &c)?);
    Ok(out)
}

/// mvhd·mdhd(`mid` 4 = timescale)·tkhd(`mid` 8 = track_ID + reserved)의 duration을 바꾼다. v0에 안 들어가면 v1로 올린다.
fn with_duration(b: &Bx, mid: usize, dur: u64) -> Result<Vec<u8>, RemuxError> {
    let mut r = Rd::new(b.body, "mvhd/tkhd/mdhd");
    let (v, flags) = r.full()?;
    let created = r.uv(v)?;
    let modified = r.uv(v)?;
    let mid_bytes = r.take(mid)?;
    r.uv(v)?;
    let mut c = Vec::with_capacity(b.body.len() + 12);
    let version = match u32::try_from(dur) {
        Ok(d) if v == 0 => {
            // v0에서 읽은 시각은 32비트에 든다.
            c.extend_from_slice(&(created as u32).to_be_bytes());
            c.extend_from_slice(&(modified as u32).to_be_bytes());
            c.extend_from_slice(mid_bytes);
            c.extend_from_slice(&d.to_be_bytes());
            0
        }
        _ => {
            c.extend_from_slice(&created.to_be_bytes());
            c.extend_from_slice(&modified.to_be_bytes());
            c.extend_from_slice(mid_bytes);
            c.extend_from_slice(&dur.to_be_bytes());
            1
        }
    };
    c.extend_from_slice(r.b);
    full_box(&b.typ, version, flags, &c)
}

/// 자식 박스를 차례로 옮겨 쓴다 — `f`가 Some이면 그걸로 바꾸고(빈 Vec = 버림) None이면 원본 그대로.
fn map_children(
    body: &[u8],
    f: &mut dyn FnMut(&Bx) -> Result<Option<Vec<u8>>, RemuxError>,
) -> Result<Vec<u8>, RemuxError> {
    let mut out = Vec::with_capacity(body.len());
    for b in boxes(body)? {
        match f(&b)? {
            Some(v) => out.extend(v),
            None => out.extend_from_slice(b.raw),
        }
    }
    Ok(out)
}

/// 미디어 시간 → 무비 시간(올림 — 마지막 프레임이 잘리지 않게).
fn rescale_up(v: u64, to: u32, from: u32) -> Result<u64, RemuxError> {
    let n = (u128::from(v) * u128::from(to)).div_ceil(u128::from(from));
    match u64::try_from(n) {
        Ok(d) => Ok(d),
        Err(_) => unsupported("duration overflow"),
    }
}

fn build_moov(init: &Init, t: &Tables) -> Result<Vec<u8>, RemuxError> {
    let media_dur = t.media_duration();
    let movie_dur = match init.edit_duration {
        Some(d) => d,
        None => rescale_up(media_dur, init.movie_timescale, init.media_timescale)?,
    };
    let top = boxes(&init.moov)?;
    let Some(moov) = top.first() else { return unsupported("empty moov") };
    let body = map_children(moov.body, &mut |b| match &b.typ {
        b"mvhd" => with_duration(b, 4, movie_dur).map(Some),
        b"mvex" => Ok(Some(Vec::new())),
        b"trak" => {
            let trak = map_children(b.body, &mut |b| match &b.typ {
                b"tkhd" => with_duration(b, 8, movie_dur).map(Some),
                b"mdia" => {
                    let mdia = map_children(b.body, &mut |b| match &b.typ {
                        b"mdhd" => with_duration(b, 4, media_dur).map(Some),
                        b"minf" => {
                            let minf = map_children(b.body, &mut |b| match &b.typ {
                                b"stbl" => {
                                    // stsd만 남기고 표는 새로 쓴다(원래 표는 비어 있음을 parse_stbl이 확인했다).
                                    let stsd = map_children(b.body, &mut |b| {
                                        Ok(if &b.typ == b"stsd" { None } else { Some(Vec::new()) })
                                    })?;
                                    let mut body = stsd;
                                    body.extend(stbl_tables(t)?);
                                    boxed(b"stbl", &body).map(Some)
                                }
                                _ => Ok(None),
                            })?;
                            boxed(b"minf", &minf).map(Some)
                        }
                        _ => Ok(None),
                    })?;
                    boxed(b"mdia", &mdia).map(Some)
                }
                _ => Ok(None),
            })?;
            boxed(b"trak", &trak).map(Some)
        }
        _ => Ok(None),
    })?;
    boxed(b"moov", &body)
}

// ══════════════════════════ 순차 한 패스 (IO) ══════════════════════════

/// 원본을 블록 단위로 앞에서부터만 읽는다. `abs` = buf[pos]의 파일 위치.
struct BlockReader<R> {
    r: R,
    buf: Vec<u8>,
    pos: usize,
    end: usize,
    abs: u64,
}

impl<R: Read + Seek> BlockReader<R> {
    fn avail(&self) -> usize {
        self.end - self.pos
    }

    /// `n`(≤ 블록) 바이트가 버퍼에 있게 한다 — 남은 바이트를 앞으로 당기고 블록 끝까지 한 번에 읽는다. EOF면 false.
    fn fill(&mut self, n: usize) -> std::io::Result<bool> {
        if self.avail() >= n {
            return Ok(true);
        }
        self.buf.copy_within(self.pos..self.end, 0);
        self.end -= self.pos;
        self.pos = 0;
        while self.end < n {
            match self.r.read(&mut self.buf[self.end..]) {
                Ok(0) => return Ok(false),
                Ok(k) => self.end += k,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(true)
    }

    fn consume(&mut self, n: usize) {
        self.pos += n;
        self.abs += n as u64;
    }

    /// 버퍼 안이면 당기고, 넘으면 나머지는 시크로 건너뛴다(읽지 않는다).
    fn skip(&mut self, n: u64) -> std::io::Result<()> {
        let here = (self.avail() as u64).min(n);
        self.consume(here as usize);
        let rest = n - here;
        if rest > 0 {
            let off = i64::try_from(rest).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
            self.r.seek(SeekFrom::Current(off))?;
            self.abs += rest;
        }
        Ok(())
    }
}

/// 출력을 블록 단위로 모아 쓴다. `pos` = 다음 바이트의 출력 파일 위치.
struct BlockWriter<W> {
    w: W,
    buf: Vec<u8>,
    block: usize,
    pos: u64,
}

impl<W: Write + Seek> BlockWriter<W> {
    fn put(&mut self, b: &[u8]) -> std::io::Result<()> {
        if self.buf.len() + b.len() > self.block {
            self.flush()?;
        }
        if b.len() >= self.block {
            self.w.write_all(b)?;
        } else {
            self.buf.extend_from_slice(b);
        }
        self.pos += b.len() as u64;
        Ok(())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.w.write_all(&self.buf)?;
        self.buf.clear();
        // File에는 아무 일도 안 한다. 벤치가 블록마다 디스크까지 내리는 변형을 끼워 볼 자리다.
        self.w.flush()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RemuxStats {
    samples: u64,
    fragments: u64,
    out_bytes: u64,
}

struct Pass<'a, R, W> {
    rd: BlockReader<R>,
    wr: BlockWriter<W>,
    len: u64,
    cancel: &'a AtomicBool,
    progress: &'a mut dyn FnMut(u64, u64),
}

impl<R: Read + Seek, W: Write + Seek> Pass<'_, R, W> {
    fn tick(&mut self) -> Result<(), RemuxError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(RemuxError::Cancelled);
        }
        (self.progress)(self.rd.abs, self.len);
        Ok(())
    }

    /// 박스 하나를 통째로 읽어 온다(ftyp·moov·moof — 작다). 블록보다 크면 지원 밖.
    fn whole(&mut self, size: u64, typ: &[u8; 4]) -> Result<Vec<u8>, RemuxError> {
        let Some(n) = usize::try_from(size).ok().filter(|n| *n <= self.rd.buf.len()) else {
            return unsupported(format!("{} box larger than the read block", fourcc(typ)));
        };
        if !self.rd.fill(n)? {
            return Err(RemuxError::Truncated);
        }
        let v = self.rd.buf[self.rd.pos..self.rd.pos + n].to_vec();
        self.rd.consume(n);
        Ok(v)
    }

    fn copy(&mut self, mut n: u64) -> Result<(), RemuxError> {
        while n > 0 {
            if self.rd.avail() == 0 {
                self.tick()?;
                if !self.rd.fill(1)? {
                    return Err(RemuxError::Truncated);
                }
            }
            let k = (self.rd.avail() as u64).min(n) as usize;
            self.wr.put(&self.rd.buf[self.rd.pos..self.rd.pos + k])?;
            self.rd.consume(k);
            n -= k as u64;
        }
        Ok(())
    }

    /// 바로 앞 moof의 샘플을 이 mdat(원본 [start, end))에서 옮긴다. 전부 안에·순서대로·겹침 없이 있어야 한다 — 먼저
    /// 다 확인하고 옮긴다.
    fn copy_samples(&mut self, samples: &[Sample], hdr: u64, start: u64, end: u64) -> Result<(), RemuxError> {
        let mut cur = start;
        for s in samples {
            let e = s.offset + u64::from(s.size);
            if s.offset < start || e > end {
                return unsupported("sample outside the following mdat");
            }
            if s.offset < cur {
                return unsupported("samples out of order or overlapping");
            }
            cur = e;
        }
        self.rd.skip(hdr)?;
        let mut at = start;
        for s in samples {
            self.rd.skip(s.offset - at)?;
            self.copy(u64::from(s.size))?;
            at = s.offset + u64::from(s.size);
        }
        self.rd.skip(end - at)?;
        Ok(())
    }

    fn run(&mut self) -> Result<RemuxStats, RemuxError> {
        let mut init: Option<Init> = None;
        let mut tables = Tables::default();
        // 바로 뒤 mdat에서 옮길 샘플 — moof를 읽고 mdat을 만나기 전까지만 Some.
        let mut pending: Option<Vec<Sample>> = None;
        let mut mdat_at: Option<u64> = None;
        let mut fragments = 0u64;
        while self.rd.abs < self.len {
            self.tick()?;
            let at = self.rd.abs;
            if self.len - at < 8 {
                return unsupported("trailing bytes after the last box");
            }
            if !self.rd.fill(8)? {
                return Err(RemuxError::Truncated);
            }
            let h = &self.rd.buf[self.rd.pos..self.rd.pos + 8];
            let typ = [h[4], h[5], h[6], h[7]];
            let (size, hdr) = match be32(h) {
                1 => {
                    if !self.rd.fill(16)? {
                        return Err(RemuxError::Truncated);
                    }
                    (be64(&self.rd.buf[self.rd.pos + 8..]), 16u64)
                }
                0 => (self.len - at, 8),
                n => (u64::from(n), 8),
            };
            if size < hdr {
                return unsupported(format!("malformed {} box size", fourcc(&typ)));
            }
            if size > self.len - at {
                return Err(RemuxError::Truncated);
            }
            if at == 0 && &typ != b"ftyp" {
                return unsupported("file does not start with ftyp");
            }
            match &typ {
                b"ftyp" => {
                    if at != 0 {
                        return unsupported("second ftyp");
                    }
                    let raw = self.whole(size, &typ)?;
                    self.wr.put(&raw)?;
                    mdat_at = Some(self.wr.pos);
                    self.wr.put(&MDAT_LARGE_HEADER)?;
                }
                b"moov" => {
                    if init.is_some() {
                        return unsupported("second moov");
                    }
                    let raw = self.whole(size, &typ)?;
                    init = Some(parse_init(&raw)?);
                }
                b"moof" => {
                    let Some(ini) = &init else { return unsupported("moof before moov") };
                    if pending.is_some() {
                        return unsupported("moof without its mdat");
                    }
                    let raw = self.whole(size, &typ)?;
                    let frag = parse_moof(&raw, at, ini)?;
                    tables.push(&frag, self.wr.pos)?;
                    pending = Some(frag.samples);
                    fragments += 1;
                }
                b"mdat" => match pending.take() {
                    Some(samples) => self.copy_samples(&samples, hdr, at + hdr, at + size)?,
                    // 어느 moof도 가리키지 않는 mdat(moov 앞의 빈 mdat 등) — 옮길 샘플이 없다.
                    None => self.rd.skip(size)?,
                },
                b"free" | b"skip" | b"wide" | b"styp" | b"sidx" | b"ssix" | b"mfra" | b"uuid" | b"prft" | b"emsg"
                | b"pdin" => self.rd.skip(size)?,
                t => return unsupported(format!("top-level {} box", fourcc(t))),
            }
        }
        // 마지막 moof의 mdat이 없다 — 녹화가 moof를 쓰고 끊겼다.
        if pending.is_some() {
            return Err(RemuxError::Truncated);
        }
        let (Some(init), Some(mdat_at)) = (init, mdat_at) else { return unsupported("no moov") };
        if tables.sizes.is_empty() {
            return unsupported("no samples");
        }
        let payload_end = self.wr.pos;
        let moov = build_moov(&init, &tables)?;
        self.wr.put(&moov)?;
        self.wr.flush()?;
        self.wr.w.seek(SeekFrom::Start(mdat_at + 8))?;
        self.wr.w.write_all(&(payload_end - mdat_at).to_be_bytes())?;
        Ok(RemuxStats { samples: tables.sizes.len() as u64, fragments, out_bytes: self.wr.pos })
    }
}

fn remux_fragmented<R: Read + Seek, W: Write + Seek>(
    src: R,
    src_len: u64,
    out: W,
    block: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<RemuxStats, RemuxError> {
    let mut pass = Pass {
        rd: BlockReader { r: src, buf: vec![0; block], pos: 0, end: 0, abs: 0 },
        wr: BlockWriter { w: out, buf: Vec::with_capacity(block), block, pos: 0 },
        len: src_len,
        cancel,
        progress,
    };
    pass.run()
}

/// 원본(읽기 전용) → 임시 파일. 실패·취소·지원 밖이면 이 함수가 만든 임시 파일을 지운다.
fn remux_file(
    src: &Path,
    tmp: &Path,
    block: usize,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<RemuxStats, RemuxError> {
    let input = std::fs::File::open(src)?;
    let len = input.metadata()?.len();
    // create_new — 같은 이름이 있으면 덮지 않고 실패한다(그 파일은 우리 것이 아니니 지우지도 않는다).
    let out = std::fs::OpenOptions::new().write(true).create_new(true).open(tmp)?;
    let res = remux_fragmented(input, len, &out, block, cancel, progress).and_then(|s| {
        // rename 전에 디스크까지 내린다 — 정전 뒤 꼬리가 빈 사본이 최종 이름으로 남으면 "이미 있으면 그걸 연다"
        // (VideoPlayer)가 망가진 사본을 계속 연다.
        out.sync_all()?;
        Ok(s)
    });
    drop(out);
    if res.is_err() {
        std::fs::remove_file(tmp).ok(); // 정리 실패는 원래 오류를 가리지 않는다
    }
    res
}

// ══════════════════════════ 커맨드 ══════════════════════════

/// 종결 이벤트(`video://export-finished`)는 video_export와 같은 계약이다. 빠지는 것은 둘 — AlreadyExists(프런트가 기존
/// 사본을 연다)와 Unsupported(프런트가 **같은 잡 id**로 ffmpeg 경로를 이어 부른다 — 여기서 종결하면 그 잡이 실패 토스트로
/// 먼저 끝난다). 진행(`video://export-progress`)도 같은 이벤트·같은 잡 레지스트리라 `video_export_cancel`로 취소된다.
#[tauri::command(async)]
pub async fn video_fast_start_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    job_id: String,
    rel_path: String,
    out_rel: String,
) -> Result<(), IpcError> {
    let outcome = fast_start_copy_inner(&app, &state, &project_id, &job_id, &rel_path, &out_rel).await;
    let handed_back = matches!(&outcome, Err(e) if matches!(e.code, ErrorCode::AlreadyExists | ErrorCode::Unsupported));
    if !handed_back {
        let cancelled = matches!(&outcome, Err(e) if e.code == ErrorCode::Cancelled);
        let _ = app.emit(
            "video://export-finished",
            ExportFinished {
                job_id,
                project_id,
                ok: outcome.is_ok(),
                cancelled,
                error: outcome.as_ref().err().map(|e| e.message.clone()),
                out_rel,
            },
        );
    }
    outcome
}

async fn fast_start_copy_inner(
    app: &AppHandle,
    state: &State<'_, AppState>,
    project_id: &str,
    job_id: &str,
    rel_path: &str,
    out_rel: &str,
) -> Result<(), IpcError> {
    let repo = project_path(state, project_id)?;
    let src = super::tree::resolve_in_repo(&repo, rel_path)?;
    if !src.is_file() {
        return Err(IpcError::new(ErrorCode::NotFound, text_video::video_source_not_found()));
    }
    let out = super::tree::resolve_in_repo(&repo, out_rel)?;
    // video_export_inner와 같은 자기 덮어쓰기 검사 — 대소문자 무시 파일 시스템에선 다른 PathBuf가 같은 파일이다.
    if out == src
        || (out.exists()
            && dunce::canonicalize(&out).ok().is_some_and(|o| Some(o) == dunce::canonicalize(&src).ok()))
    {
        return Err(IpcError::new(ErrorCode::Io, text_video::video_export_onto_source()));
    }
    let ext = out.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("mp4" | "m4v" | "mov")) {
        return Err(IpcError::new(
            ErrorCode::Unsupported,
            text_video::video_remux_unsupported(&src.display(), "output is not an MP4 container"),
        ));
    }
    if out.exists() {
        return Err(IpcError::new(ErrorCode::AlreadyExists, text_video::video_output_exists(out_rel)));
    }

    let jobs = {
        let reg = state.video.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(&reg.jobs)
    };
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    jobs.lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(job_id.to_string(), VideoJob { cancel: Some(cancel_tx), pid: None });
    let _guard = JobGuard { jobs: Arc::clone(&jobs), job_id: job_id.to_string() };

    // 임시 이름은 여기서 만든 uuid다(프런트가 준 job_id를 경로에 넣지 않는다). 같은 폴더라 rename 한 번으로 확정된다.
    let tmp = out.with_file_name(format!(".gpv-export-{}.tmp", uuid::Uuid::new_v4().simple()));
    let cancel = Arc::new(AtomicBool::new(false));
    let started = Instant::now();
    let mut task = {
        let (src, tmp, cancel) = (src.clone(), tmp.clone(), Arc::clone(&cancel));
        let (app, job_id, project_id) = (app.clone(), job_id.to_string(), project_id.to_string());
        tokio::task::spawn_blocking(move || {
            let mut last = -1i64;
            let mut progress = |read: u64, total: u64| {
                let pct = super::video_container::copy_progress_pct(read, total);
                if pct as i64 != last {
                    last = pct as i64;
                    let _ = app.emit(
                        "video://export-progress",
                        ExportProgress {
                            job_id: job_id.clone(),
                            project_id: project_id.clone(),
                            percent: pct,
                            out_time_ms: 0,
                            speed: None,
                        },
                    );
                }
            };
            remux_file(&src, &tmp, REMUX_BLOCK, &cancel, &mut progress)
        })
    };
    let mut cancelled = false;
    let joined = tokio::select! {
        r = &mut task => r,
        _ = &mut cancel_rx => {
            cancelled = true;
            cancel.store(true, Ordering::Relaxed);
            task.await
        }
    };
    let result = match joined {
        Ok(r) => r,
        Err(e) => {
            std::fs::remove_file(&tmp).ok(); // 정리 실패는 원래 오류를 가리지 않는다
            return Err(IpcError::new(ErrorCode::Io, text_video::video_remux_failed(&src.display(), &out.display(), &e)));
        }
    };
    if cancelled {
        // 취소와 완료가 엇갈려 다 만들어졌어도 사용자는 취소했다 — video_export와 같이 버린다.
        if result.is_ok() {
            std::fs::remove_file(&tmp).ok(); // 정리 실패는 원래 오류를 가리지 않는다
        }
        return Err(IpcError::new(ErrorCode::Cancelled, text_video::video_export_cancelled()));
    }
    match result {
        Ok(s) => {
            log::info!("[video] 빠른 재생용 사본(리먹서) {} → {} · 샘플 {} · 조각 {} · {} B · {:.1}s", src.display(), out.display(), s.samples, s.fragments, s.out_bytes, started.elapsed().as_secs_f64());
            commit_tmp_output(&tmp, &out)
        }
        Err(RemuxError::Unsupported(why)) => {
            log::info!("[video] 빠른 재생용 사본: 리먹서 지원 밖 → ffmpeg 경로 ({}): {why}", src.display());
            Err(IpcError::new(ErrorCode::Unsupported, text_video::video_remux_unsupported(&src.display(), &why)))
        }
        // 녹화가 끊긴 파일도 ffmpeg는 온전한 프레임까지 옮긴다 — 실패로 끝내지 않고 그 경로로 넘긴다.
        Err(RemuxError::Truncated) => {
            log::info!("[video] 빠른 재생용 사본: 원본이 잘림 → ffmpeg 경로 ({})", src.display());
            Err(IpcError::new(ErrorCode::Unsupported, text_video::video_remux_truncated(&src.display())))
        }
        Err(RemuxError::Cancelled) => Err(IpcError::new(ErrorCode::Cancelled, text_video::video_export_cancelled())),
        Err(RemuxError::Io(e)) => {
            Err(IpcError::new(ErrorCode::Io, text_video::video_remux_failed(&src.display(), &out.display(), &e)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const MOVIE_TS: u32 = 1000;
    const MEDIA_TS: u32 = 15360;
    const NON_SYNC: u32 = 0x0101_0000;
    const SYNC: u32 = 0x0200_0000;

    fn bx(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
        boxed(typ, body).unwrap()
    }

    fn fb(typ: &[u8; 4], v: u8, flags: u32, content: &[u8]) -> Vec<u8> {
        full_box(typ, v, flags, content).unwrap()
    }

    fn u32s(v: &[u32]) -> Vec<u8> {
        v.iter().flat_map(|x| x.to_be_bytes()).collect()
    }

    fn ftyp() -> Vec<u8> {
        bx(b"ftyp", b"iso5\0\0\x02\0iso5iso6mp41")
    }

    /// init 세그먼트(empty_moov) — ffmpeg `+empty_moov+default_base_moof`와 같은 모양.
    struct InitOpt {
        tracks: u32,
        handler: [u8; 4],
        entry: [u8; 4],
        stts_entries: u32,
        dref_flags: u32,
        edts: Option<Vec<u8>>,
        moov_extra: Vec<u8>,
    }

    impl Default for InitOpt {
        fn default() -> Self {
            InitOpt {
                tracks: 1,
                handler: *b"vide",
                entry: *b"avc1",
                stts_entries: 0,
                dref_flags: 1,
                edts: None,
                moov_extra: Vec::new(),
            }
        }
    }

    fn init_moov(o: &InitOpt) -> Vec<u8> {
        let mvhd = fb(b"mvhd", 0, 0, &[u32s(&[0, 0, MOVIE_TS, 0]), vec![0; 80]].concat());
        let mut traks = Vec::new();
        let mut trexes = Vec::new();
        for id in 1..=o.tracks {
            let tkhd = fb(b"tkhd", 0, 3, &[u32s(&[0, 0, id, 0, 0]), vec![0; 60]].concat());
            let mdhd = fb(b"mdhd", 0, 0, &[u32s(&[0, 0, MEDIA_TS, 0]), vec![0x55, 0xc4, 0, 0]].concat());
            let hdlr = fb(b"hdlr", 0, 0, &[vec![0; 4], o.handler.to_vec(), vec![0; 12], b"VideoHandler\0".to_vec()].concat());
            let dref = fb(b"dref", 0, 0, &[u32s(&[1]), fb(b"url ", 0, o.dref_flags, &[])].concat());
            let stsd = fb(b"stsd", 0, 0, &[u32s(&[1]), bx(&o.entry, &[0u8; 86])].concat());
            let stts = if o.stts_entries > 0 { u32s(&[o.stts_entries, 1, 1]) } else { u32s(&[0]) };
            let stbl = bx(
                b"stbl",
                &[
                    stsd,
                    fb(b"stts", 0, 0, &stts),
                    fb(b"stsc", 0, 0, &u32s(&[0])),
                    fb(b"stsz", 0, 0, &u32s(&[0, 0])),
                    fb(b"stco", 0, 0, &u32s(&[0])),
                ]
                .concat(),
            );
            let minf = bx(b"minf", &[fb(b"vmhd", 0, 1, &[0; 8]), bx(b"dinf", &dref), stbl].concat());
            let mdia = bx(b"mdia", &[mdhd, hdlr, minf].concat());
            let edts = o.edts.clone().unwrap_or_default();
            traks.extend(bx(b"trak", &[tkhd, edts, mdia].concat()));
            trexes.extend(fb(b"trex", 0, 0, &u32s(&[id, 1, 0, 0, 0])));
        }
        let mvex = bx(b"mvex", &trexes);
        let udta = bx(b"udta", b"\0\0\0\x0cmeta\0\0\0\0");
        bx(b"moov", &[mvhd, traks, mvex, udta, o.moov_extra.clone()].concat())
    }

    #[derive(Clone, Copy)]
    struct S {
        dur: u32,
        size: u32,
        sync: bool,
        cto: i32,
    }

    fn s(dur: u32, size: u32, sync: bool) -> S {
        S { dur, size, sync, cto: 0 }
    }

    #[derive(Clone)]
    struct F {
        tfdt: Option<u64>,
        samples: Vec<S>,
        /// camstation 모양 — tfhd 기본값(길이·크기·non-sync) + trun data-offset·first-sample-flags. 샘플 1개일 때만.
        camstation: bool,
        cto_version: Option<u8>,
        /// mdat 안 샘플 앞의 쓰레기 바이트(옮기지 않아야 한다).
        gap: usize,
        largesize_mdat: bool,
        /// tfhd base-data-offset(절대 위치) + trun data-offset 없음.
        explicit_base: bool,
        extra_traf: Vec<u8>,
        tfhd_flags_extra: u32,
        trun_flags_extra: u32,
        data_offset_shift: i64,
        /// trun을 하나 더(같은 data-offset — 겹침).
        dup_trun: bool,
    }

    fn frag(samples: Vec<S>) -> F {
        F {
            tfdt: None,
            samples,
            camstation: false,
            cto_version: None,
            gap: 0,
            largesize_mdat: false,
            explicit_base: false,
            extra_traf: Vec::new(),
            tfhd_flags_extra: 0,
            trun_flags_extra: 0,
            data_offset_shift: 0,
            dup_trun: false,
        }
    }

    /// 조각 MP4 한 벌을 조립하고, 옮겨져야 할 샘플 바이트(순서대로)를 같이 쌓는다.
    struct Builder {
        file: Vec<u8>,
        payload: Vec<u8>,
        k: u32,
        seq: u32,
    }

    impl Builder {
        fn new(moov: &[u8]) -> Self {
            Builder { file: [ftyp(), moov.to_vec()].concat(), payload: Vec::new(), k: 0, seq: 0 }
        }

        fn bare() -> Self {
            Builder { file: ftyp(), payload: Vec::new(), k: 0, seq: 0 }
        }

        fn raw(&mut self, b: &[u8]) -> &mut Self {
            self.file.extend_from_slice(b);
            self
        }

        fn moof(&self, f: &F, data_offset: i64, base: u64) -> Vec<u8> {
            let mut tfhd_c = u32s(&[1]);
            let tfhd_flags;
            let mut trun_flags = if f.explicit_base { 0 } else { 0x1 };
            if f.camstation {
                assert_eq!(f.samples.len(), 1);
                tfhd_flags = 0x20038 | f.tfhd_flags_extra;
                tfhd_c.extend(u32s(&[f.samples[0].dur, f.samples[0].size, NON_SYNC]));
                if f.samples[0].sync {
                    trun_flags |= 0x4;
                }
            } else {
                tfhd_flags = if f.explicit_base { 0x1 } else { 0x20000 } | f.tfhd_flags_extra;
                if f.explicit_base {
                    tfhd_c.extend(base.to_be_bytes());
                }
                trun_flags |= 0x100 | 0x200 | 0x400;
            }
            if f.cto_version.is_some() {
                trun_flags |= 0x800;
            }
            trun_flags |= f.trun_flags_extra;
            let mut trun_c = u32s(&[f.samples.len() as u32]);
            if trun_flags & 0x1 != 0 {
                trun_c.extend((data_offset as i32).to_be_bytes());
            }
            if trun_flags & 0x4 != 0 {
                trun_c.extend(SYNC.to_be_bytes());
            }
            for x in &f.samples {
                if !f.camstation {
                    trun_c.extend(u32s(&[x.dur, x.size, if x.sync { SYNC } else { NON_SYNC }]));
                }
                if f.cto_version.is_some() {
                    trun_c.extend(x.cto.to_be_bytes());
                }
            }
            let mut traf = fb(b"tfhd", 0, tfhd_flags, &tfhd_c);
            if let Some(t) = f.tfdt {
                traf.extend(fb(b"tfdt", 1, 0, &t.to_be_bytes()));
            }
            let trun = fb(b"trun", f.cto_version.unwrap_or(0), trun_flags, &trun_c);
            traf.extend_from_slice(&trun);
            if f.dup_trun {
                traf.extend_from_slice(&trun);
            }
            traf.extend_from_slice(&f.extra_traf);
            let mfhd = fb(b"mfhd", 0, 0, &u32s(&[self.seq]));
            bx(b"moof", &[mfhd, bx(b"traf", &traf)].concat())
        }

        fn frag(&mut self, f: &F) -> &mut Self {
            self.seq += 1;
            let moof_at = self.file.len() as u64;
            let moof_len = self.moof(f, 0, 0).len() as u64;
            let hdr = if f.largesize_mdat { 16 } else { 8 };
            let first = moof_at + moof_len + hdr + f.gap as u64;
            let moof = self.moof(f, (moof_len + hdr + f.gap as u64) as i64 + f.data_offset_shift, first);
            let mut body = vec![0xEE; f.gap];
            for x in &f.samples {
                let bytes: Vec<u8> = (0..x.size).map(|j| self.k.wrapping_mul(31).wrapping_add(j) as u8).collect();
                self.k += 1;
                body.extend_from_slice(&bytes);
                self.payload.extend_from_slice(&bytes);
            }
            let mdat = if f.largesize_mdat {
                [u32s(&[1]), b"mdat".to_vec(), (body.len() as u64 + 16).to_be_bytes().to_vec(), body].concat()
            } else {
                bx(b"mdat", &body)
            };
            self.file.extend(moof);
            self.file.extend(mdat);
            self
        }
    }

    fn remux_bytes(file: &[u8], block: usize) -> Result<(Vec<u8>, RemuxStats), RemuxError> {
        let mut out = Cursor::new(Vec::new());
        let no = AtomicBool::new(false);
        let stats = remux_fragmented(Cursor::new(file), file.len() as u64, &mut out, block, &no, &mut |_, _| {})?;
        Ok((out.into_inner(), stats))
    }

    /// 작은 블록(버퍼 경계를 샘플 한가운데서 자주 넘는다)과 큰 블록의 결과가 같아야 한다.
    fn remux_ok(file: &[u8]) -> Vec<u8> {
        let (small, s1) = remux_bytes(file, 1024).expect("remux (1 KiB block)");
        let (big, s2) = remux_bytes(file, 1 << 20).expect("remux (1 MiB block)");
        assert!(small == big, "블록 크기에 따라 출력이 달라졌다");
        assert_eq!(s1, s2);
        small
    }

    fn why(file: &[u8]) -> String {
        match remux_bytes(file, 1 << 16) {
            Err(RemuxError::Unsupported(w)) => w,
            Err(e) => panic!("Unsupported가 아니다: {e:?}"),
            Ok(_) => panic!("지원 밖이어야 하는데 성공했다"),
        }
    }

    /// 경로의 박스 본문 — 없으면 None.
    fn find<'a>(b: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
        let mut cur = b;
        for t in path {
            cur = boxes(cur).unwrap().into_iter().find(|x| &x.typ == *t)?.body;
        }
        Some(cur)
    }

    fn types(b: &[u8]) -> Vec<String> {
        boxes(b).unwrap().iter().map(|x| fourcc(&x.typ)).collect()
    }

    const STBL: [&[u8; 4]; 5] = [b"moov", b"trak", b"mdia", b"minf", b"stbl"];

    /// stbl 아래 full box → (version, version/flags 뒤를 u32로).
    fn table(out: &[u8], t: &[u8; 4]) -> Option<(u8, Vec<u32>)> {
        let mut p = STBL.to_vec();
        p.push(t);
        let b = find(out, &p)?;
        Some((b[0], b[4..].chunks(4).map(be32).collect()))
    }

    fn co64(out: &[u8]) -> Vec<u64> {
        let mut p = STBL.to_vec();
        p.push(b"co64");
        let b = find(out, &p).unwrap();
        b[8..].chunks(8).map(be64).collect()
    }

    /// v0 mvhd·mdhd(오프셋 12)·tkhd(오프셋 16)의 duration.
    fn dur(out: &[u8], path: &[&[u8; 4]], at: usize) -> u64 {
        let b = find(out, path).unwrap();
        assert_eq!(b[0], 0, "v0이어야 한다");
        u64::from(be32(&b[4 + at..]))
    }

    fn payload(out: &[u8]) -> Vec<u8> {
        let top = boxes(out).unwrap();
        let mdat = top.iter().find(|x| &x.typ == b"mdat").unwrap();
        assert_eq!(be32(mdat.raw), 1, "mdat은 largesize 헤더");
        mdat.body.to_vec()
    }

    const MDHD: [&[u8; 4]; 4] = [b"moov", b"trak", b"mdia", b"mdhd"];

    #[test]
    fn remux_fragments_become_one_moov_at_the_end() {
        let moov = init_moov(&InitOpt::default());
        let mut b = Builder::new(&moov);
        b.raw(&bx(b"sidx", &[0; 24]));
        b.frag(&F { tfdt: Some(0), ..frag(vec![s(512, 300, true), s(512, 120, false)]) });
        b.raw(&bx(b"free", &[0; 5]));
        b.frag(&F { tfdt: Some(1024), gap: 7, ..frag(vec![s(512, 90, false)]) });
        b.frag(&F { tfdt: Some(1536), ..frag(vec![s(512, 2000, true), s(1024, 50, false), s(512, 50, false)]) });
        b.raw(&bx(b"mfra", &[0; 16]));
        let out = remux_ok(&b.file);

        assert_eq!(types(&out), ["ftyp", "mdat", "moov"], "ftyp → mdat → 끝에 moov (faststart 아님)");
        assert_eq!(boxes(&out).unwrap()[0].raw, ftyp().as_slice(), "ftyp은 그대로");
        assert!(payload(&out) == b.payload, "샘플 바이트만 순서대로 — gap·다른 박스는 빠진다");
        assert_eq!(types(find(&out, &[b"moov"]).unwrap()), ["mvhd", "trak", "udta"], "mvex는 없어진다");
        assert_eq!(types(find(&out, &STBL).unwrap()), ["stsd", "stts", "stss", "stsz", "stsc", "co64"]);
        assert_eq!(table(&out, b"stts").unwrap().1, [3, 4, 512, 1, 1024, 1, 512]);
        assert_eq!(table(&out, b"stss").unwrap().1, [2, 1, 4]);
        assert_eq!(table(&out, b"stsz").unwrap().1, [0, 6, 300, 120, 90, 2000, 50, 50]);
        // 조각 하나 = 청크 하나: 2·1·3개
        assert_eq!(table(&out, b"stsc").unwrap().1, [3, 1, 2, 1, 2, 1, 1, 3, 3, 1]);
        assert!(table(&out, b"ctts").is_none(), "cto가 없으면 ctts도 없다");
        let start = ftyp().len() as u64 + 16;
        assert_eq!(co64(&out), [start, start + 420, start + 510]);
        let stsd: Vec<&[u8; 4]> = STBL.iter().copied().chain([b"stsd"]).collect();
        assert_eq!(find(&out, &stsd).unwrap(), find(&moov, &stsd).unwrap(), "stsd는 원본 그대로");
        // 길이: 미디어 3584 / 15360 → 무비(1000) 233.33… → 올림 234
        assert_eq!(dur(&out, &MDHD, 12), 3584);
        assert_eq!(dur(&out, &[b"moov", b"trak", b"tkhd"], 16), 234);
        assert_eq!(dur(&out, &[b"moov", b"mvhd"], 12), 234);
    }

    #[test]
    fn remux_camstation_shape_one_sample_per_fragment() {
        // 실파일과 같은 배치: tfhd 0x20038(기본 길이·크기·non-sync) + trun 0x1|0x4(키프레임만 first-sample-flags). 길이가 528/544로 흔들린다.
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        let durs = [528u32, 544, 528, 544, 528, 528];
        let mut t = 0u64;
        for (i, d) in durs.iter().enumerate() {
            b.frag(&F { tfdt: Some(t), camstation: true, ..frag(vec![s(*d, 100 + i as u32, i % 3 == 0)]) });
            t += u64::from(*d);
        }
        let out = remux_ok(&b.file);
        assert!(payload(&out) == b.payload);
        assert_eq!(table(&out, b"stts").unwrap().1, [5, 1, 528, 1, 544, 1, 528, 1, 544, 2, 528]);
        assert_eq!(table(&out, b"stss").unwrap().1, [2, 1, 4]);
        assert_eq!(table(&out, b"stsc").unwrap().1, [1, 1, 1, 1], "조각마다 샘플 1개 — 한 줄로 줄어든다");
        assert_eq!(co64(&out).len(), 6);
        assert_eq!(dur(&out, &MDHD, 12), t);
    }

    #[test]
    fn remux_all_keyframes_omit_stss_and_equal_sizes_collapse_stsz() {
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        b.frag(&frag(vec![s(512, 64, true), s(512, 64, true)]));
        b.frag(&frag(vec![s(512, 64, true)]));
        let out = remux_ok(&b.file);
        assert!(table(&out, b"stss").is_none(), "전부 키프레임이면 stss 생략");
        assert_eq!(table(&out, b"stsz").unwrap().1, [64, 3], "크기가 같으면 표 없이 한 값");
        // tfdt가 없으면 앞 조각에 이어 붙인다
        assert_eq!(table(&out, b"stts").unwrap().1, [1, 3, 512]);
    }

    #[test]
    fn remux_composition_offsets_become_ctts() {
        // B프레임(ffmpeg 기본: trun v0, 양수 cto)
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        let mut f1 = frag(vec![s(512, 40, true), s(512, 40, false), s(512, 40, false)]);
        f1.cto_version = Some(0);
        f1.samples[0].cto = 1024;
        f1.samples[1].cto = 2048;
        b.frag(&f1);
        let out = remux_ok(&b.file);
        assert_eq!(table(&out, b"ctts").unwrap(), (0, vec![3, 1, 1024, 1, 2048, 1, 0]));
        assert_eq!(types(find(&out, &STBL).unwrap()), ["stsd", "stts", "ctts", "stss", "stsz", "stsc", "co64"]);

        // 음수 cto(trun v1) → ctts v1. cto가 없던 앞 조각의 샘플은 0이다.
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        b.frag(&frag(vec![s(512, 40, true)]));
        let mut f2 = frag(vec![s(512, 40, false), s(512, 40, false)]);
        f2.cto_version = Some(1);
        f2.samples[0].cto = -512;
        f2.samples[1].cto = 512;
        b.frag(&f2);
        let out = remux_ok(&b.file);
        let (v, t) = table(&out, b"ctts").unwrap();
        assert_eq!(v, 1);
        assert_eq!(t, [3, 1, 0, 1, (-512i32) as u32, 1, 512]);
    }

    #[test]
    fn remux_tfdt_gap_and_overlap_adjust_previous_duration() {
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        // 첫 시각이 0이 아니면 0에서 시작하도록 민다(기존 ffmpeg 경로의 make_zero와 같다).
        b.frag(&F { tfdt: Some(90_000), ..frag(vec![s(512, 10, true), s(512, 10, false)]) });
        // 기대 91024 → 92048: 구멍 1024 → 앞 샘플 512 → 1536
        b.frag(&F { tfdt: Some(92_048), ..frag(vec![s(512, 10, false)]) });
        // 기대 92560 → 92460: 겹침 100 → 앞 샘플 512 → 412
        b.frag(&F { tfdt: Some(92_460), ..frag(vec![s(512, 10, false)]) });
        let out = remux_ok(&b.file);
        assert_eq!(table(&out, b"stts").unwrap().1, [4, 1, 512, 1, 1536, 1, 412, 1, 512]);
        assert_eq!(dur(&out, &MDHD, 12), 92_972 - 90_000);

        // 앞 샘플의 시작보다도 앞으로 돌아가면 길이로 맞출 수 없다
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        b.frag(&F { tfdt: Some(1000), ..frag(vec![s(512, 10, true)]) });
        b.frag(&F { tfdt: Some(1000), ..frag(vec![s(512, 10, false)]) });
        assert!(why(&b.file).contains("tfdt"));
    }

    #[test]
    fn remux_largesize_mdat_explicit_base_and_skipped_boxes() {
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        b.raw(&bx(b"styp", b"msdh\0\0\0\0msdh"));
        b.frag(&F { largesize_mdat: true, gap: 3, ..frag(vec![s(512, 77, true)]) });
        b.raw(&bx(b"uuid", &[1; 20]));
        // base-data-offset(절대) + trun data-offset 없음 → 샘플은 base에서 시작
        b.frag(&F { explicit_base: true, ..frag(vec![s(512, 33, false), s(512, 44, false)]) });
        // 블록(1 KiB)보다 큰 free — 버퍼 밖은 시크로 건너뛴다
        b.raw(&bx(b"free", &[0; 5000]));
        b.frag(&frag(vec![s(512, 1500, true)]));
        let out = remux_ok(&b.file);
        assert!(payload(&out) == b.payload);
        assert_eq!(table(&out, b"stsz").unwrap().1, [0, 4, 77, 33, 44, 1500]);
    }

    #[test]
    fn remux_duration_field_upgrades_to_v1_when_needed() {
        let mvhd = fb(b"mvhd", 0, 0, &[u32s(&[7, 8, MOVIE_TS, 0]), vec![9; 80]].concat());
        let top = boxes(&mvhd).unwrap();
        let small = with_duration(&top[0], 4, 1234).unwrap();
        assert_eq!(small.len(), mvhd.len());
        assert_eq!(be32(&small[8 + 16..]), 1234);
        let big = with_duration(&top[0], 4, u64::from(u32::MAX) + 5).unwrap();
        let bb = boxes(&big).unwrap();
        assert_eq!(bb[0].body[0], 1, "v1로 올린다");
        let mut r = Rd::new(&bb[0].body[4..], "mvhd");
        let got = (r.u64().unwrap(), r.u64().unwrap(), r.u32().unwrap(), r.u64().unwrap());
        assert_eq!(got, (7, 8, MOVIE_TS, u64::from(u32::MAX) + 5));
        assert_eq!(r.b, &[9u8; 80][..], "나머지 필드는 그대로");
        // tkhd(mid 8): track_ID + reserved 뒤의 자리
        let tkhd = fb(b"tkhd", 0, 3, &[u32s(&[0, 0, 1, 0, 0]), vec![0; 60]].concat());
        let t = with_duration(&boxes(&tkhd).unwrap()[0], 8, 99).unwrap();
        assert_eq!(be32(&t[8 + 20..]), 99);
        assert_eq!(be32(&t[8 + 12..]), 1, "track_ID 보존");
    }

    #[test]
    fn remux_rejects_unsupported_structures() {
        let base = || Builder::new(&init_moov(&InitOpt::default()));
        let one = || frag(vec![s(512, 40, true)]);
        let with_init = |o: InitOpt| {
            let mut b = Builder::new(&init_moov(&o));
            b.frag(&one());
            b.file
        };
        let with_frag = |f: F| {
            let mut b = base();
            b.frag(&f);
            b.file
        };
        let open_elst = bx(b"edts", &fb(b"elst", 0, 0, &u32s(&[1, 0, 0, 0x0001_0000])));
        let cases: Vec<(&str, Vec<u8>, &str)> = vec![
            ("트랙 2개(비디오+오디오)", with_init(InitOpt { tracks: 2, ..Default::default() }), "2 tracks"),
            ("오디오 트랙", with_init(InitOpt { handler: *b"soun", ..Default::default() }), "soun track"),
            ("암호화 샘플 항목(encv)", with_init(InitOpt { entry: *b"encv", ..Default::default() }), "encrypted"),
            ("moov의 pssh", with_init(InitOpt { moov_extra: bx(b"pssh", &[0; 24]), ..Default::default() }), "encrypted"),
            ("moov에도 샘플이 있다", with_init(InitOpt { stts_entries: 1, ..Default::default() }), "samples in moov"),
            ("외부 데이터 참조", with_init(InitOpt { dref_flags: 0, ..Default::default() }), "external"),
            ("끝이 열린 edit list", with_init(InitOpt { edts: Some(open_elst), ..Default::default() }), "open-ended"),
            ("traf의 senc", with_frag(F { extra_traf: fb(b"senc", 0, 0, &[0; 4]), ..one() }), "encrypted"),
            ("traf의 sbgp", with_frag(F { extra_traf: fb(b"sbgp", 0, 0, &[0; 8]), ..one() }), "sample groups"),
            ("tfhd duration-is-empty", with_frag(F { tfhd_flags_extra: 0x1_0000, ..one() }), "tfhd flags"),
            ("모르는 trun 플래그", with_frag(F { trun_flags_extra: 0x2, ..one() }), "trun flags"),
            ("샘플이 다음 mdat 밖", with_frag(F { data_offset_shift: 1, ..one() }), "outside the following mdat"),
            ("겹치는 두 trun", with_frag(F { dup_trun: true, ..one() }), "out of order or overlapping"),
            ("크기 0 샘플", with_frag(frag(vec![s(512, 0, true)])), "empty sample"),
            ("trun v0 cto가 i32를 넘는다", with_frag(F { cto_version: Some(0), samples: vec![S { cto: -1, ..s(512, 40, true) }], ..one() }), "composition offset"),
            (
                "샘플이 mdat 앞을 가리킨다(음수 오프셋)",
                {
                    let mut b = base();
                    b.frag(&one());
                    b.frag(&F { data_offset_shift: -60, ..one() });
                    b.file
                },
                "outside the following mdat",
            ),
            (
                "moov가 moof 뒤",
                {
                    let mut b = Builder::bare();
                    b.frag(&one());
                    b.raw(&init_moov(&InitOpt::default()));
                    b.file
                },
                "moof before moov",
            ),
            ("ftyp으로 시작하지 않는다", [init_moov(&InitOpt::default()), ftyp()].concat(), "ftyp"),
            (
                "moof 다음 moof(mdat 없음)",
                {
                    let mut b = base();
                    let m = b.moof(&one(), 0, 0);
                    b.raw(&m);
                    b.frag(&one());
                    b.file
                },
                "moof without its mdat",
            ),
            (
                "모르는 최상위 박스",
                {
                    let mut b = base();
                    b.frag(&one());
                    b.raw(&bx(b"abcd", &[0; 4]));
                    b.file
                },
                "top-level abcd",
            ),
            ("샘플이 하나도 없다", base().file, "no samples"),
        ];
        for (name, file, expect) in cases {
            let w = why(&file);
            assert!(w.contains(expect), "{name}: '{w}'에 '{expect}'가 없다");
        }
    }

    #[test]
    fn remux_truncated_file_is_an_error() {
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        b.frag(&frag(vec![s(512, 400, true)]));
        b.frag(&frag(vec![s(512, 400, false)]));
        let full = b.file.clone();
        // 마지막 mdat 한가운데서 끊겼다
        assert!(matches!(remux_bytes(&full[..full.len() - 100], 4096), Err(RemuxError::Truncated)));
        // moof까지만 쓰고 끊겼다(mdat 머리 8 + 샘플 400)
        let moof_end = full.len() - 408;
        assert!(matches!(remux_bytes(&full[..moof_end], 4096), Err(RemuxError::Truncated)));
        // moof 한가운데
        assert!(matches!(remux_bytes(&full[..moof_end - 20], 4096), Err(RemuxError::Truncated)));
        assert!(remux_bytes(&full, 4096).is_ok());
    }

    #[test]
    fn remux_progress_and_cancel() {
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        for _ in 0..20 {
            b.frag(&frag(vec![s(512, 3000, true)]));
        }
        let len = b.file.len() as u64;
        let mut seen = Vec::new();
        let mut out = Cursor::new(Vec::new());
        let no = AtomicBool::new(false);
        remux_fragmented(Cursor::new(&b.file), len, &mut out, 4096, &no, &mut |r, t| seen.push((r, t))).unwrap();
        assert!(seen.len() > 20, "블록·박스마다 알린다: {}", seen.len());
        assert!(seen.windows(2).all(|w| w[0].0 <= w[1].0));
        assert!(seen.iter().all(|(r, t)| *t == len && *r <= len));
        let cancel = AtomicBool::new(true);
        let r = remux_fragmented(Cursor::new(&b.file), len, Cursor::new(Vec::new()), 4096, &cancel, &mut |_, _| {});
        assert!(matches!(r, Err(RemuxError::Cancelled)));
    }

    /// 파일 경로 — 원본 불변 · 성공은 임시 파일에 · 실패·취소·지원 밖이면 임시 파일을 지운다 · 이미 있는 임시 이름은 건드리지 않는다.
    #[test]
    fn remux_file_keeps_source_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = Builder::new(&init_moov(&InitOpt::default()));
        b.frag(&frag(vec![s(512, 500, true), s(512, 200, false)]));
        let good = dir.path().join("frag.mp4");
        std::fs::write(&good, &b.file).unwrap();
        let no = AtomicBool::new(false);
        let run = |src: &Path, tmp: &Path, cancel: &AtomicBool| remux_file(src, tmp, 4096, cancel, &mut |_, _| {});

        let tmp = dir.path().join(".gpv-export-ok.tmp");
        let stats = run(&good, &tmp, &no).unwrap();
        assert!(std::fs::read(&good).unwrap() == b.file, "원본은 바뀌지 않는다");
        let out = std::fs::read(&tmp).unwrap();
        assert!(out == remux_bytes(&b.file, 4096).unwrap().0);
        assert_eq!(stats.out_bytes, out.len() as u64);
        assert_eq!(stats.samples, 2);

        // 지원 밖(오디오 트랙) — 임시 파일이 남지 않는다
        let mut a = Builder::new(&init_moov(&InitOpt { handler: *b"soun", ..Default::default() }));
        a.frag(&frag(vec![s(512, 500, true)]));
        let audio = dir.path().join("audio.mp4");
        std::fs::write(&audio, &a.file).unwrap();
        let t2 = dir.path().join(".gpv-export-unsupported.tmp");
        assert!(matches!(run(&audio, &t2, &no), Err(RemuxError::Unsupported(_))));
        assert!(!t2.exists());
        assert!(std::fs::read(&audio).unwrap() == a.file);

        // 잘린 파일 · 취소 — 역시 지운다
        let cut = dir.path().join("cut.mp4");
        std::fs::write(&cut, &b.file[..b.file.len() - 10]).unwrap();
        let t3 = dir.path().join(".gpv-export-cut.tmp");
        assert!(matches!(run(&cut, &t3, &no), Err(RemuxError::Truncated)));
        assert!(!t3.exists());
        let t4 = dir.path().join(".gpv-export-cancel.tmp");
        assert!(matches!(run(&good, &t4, &AtomicBool::new(true)), Err(RemuxError::Cancelled)));
        assert!(!t4.exists());

        // 임시 이름이 이미 있으면(우리 것이 아니다) 덮지도 지우지도 않는다
        let t5 = dir.path().join(".gpv-export-taken.tmp");
        std::fs::write(&t5, b"someone else's").unwrap();
        assert!(matches!(run(&good, &t5, &no), Err(RemuxError::Io(e)) if e.kind() == std::io::ErrorKind::AlreadyExists));
        assert_eq!(std::fs::read(&t5).unwrap(), b"someone else's");
    }

    fn ffmpeg_ok(ffmpeg: &Path, args: &[&str]) -> Vec<u8> {
        let o = std::process::Command::new(ffmpeg).args(args).output().expect("ffmpeg 실행");
        assert!(o.status.success(), "ffmpeg {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        o.stdout
    }

    /// 무손실 증명 — ffmpeg가 만든 프레임당 조각 fMP4(실파일과 같은 movflags)를 옮기고, 원본·출력의 패킷별 해시
    /// (데이터·pts·dts·duration)가 전부 같은지 본다. `cargo test --lib remux_real_ffmpeg -- --ignored --nocapture`
    #[test]
    #[ignore = "PATH의 ffmpeg 필요"]
    fn remux_real_ffmpeg_is_lossless() {
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let dir = tempfile::tempdir().unwrap();
        let flags = "+frag_every_frame+empty_moov+default_base_moof+skip_trailer";
        let cases: [(&str, &[&str]); 3] = [
            ("b-frames", &["-preset", "medium", "-bf", "3"]),
            ("no-b-frames", &["-preset", "ultrafast", "-bf", "0"]),
            // 실파일처럼 프레임 길이가 흔들리는 VFR(1/16000에서 528·544) — 세 장마다 1ms씩 밀린다. settb가 없으면 1/30 격자로 반올림돼 CFR이 된다.
            (
                "vfr",
                &["-preset", "ultrafast", "-bf", "0", "-vf", "settb=1/1000,setpts=N*33+floor(N/3)", "-fps_mode", "vfr", "-enc_time_base", "1/1000"],
            ),
        ];
        for (name, extra) in cases {
            let src = dir.path().join(format!("{name}.mp4"));
            let out = dir.path().join(format!("{name}.remuxed.mp4"));
            let s = src.display().to_string();
            let mut args = vec!["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=4:size=320x240:rate=30"];
            args.extend_from_slice(&["-c:v", "libx264", "-pix_fmt", "yuv420p"]);
            args.extend_from_slice(extra);
            args.extend_from_slice(&["-movflags", flags, &s]);
            ffmpeg_ok(&ffmpeg, &args);
            let before = std::fs::read(&src).unwrap();
            let stats = remux_file(&src, &out, REMUX_BLOCK, &AtomicBool::new(false), &mut |_, _| {}).unwrap();
            assert!(std::fs::read(&src).unwrap() == before);
            let md5 = |p: &Path| {
                let p = p.display().to_string();
                let o = ffmpeg_ok(&ffmpeg, &["-v", "error", "-i", &p, "-map", "0:v", "-c", "copy", "-f", "framemd5", "-"]);
                String::from_utf8(o).unwrap()
            };
            let (a, b) = (md5(&src), md5(&out));
            let packets = a.lines().filter(|l| !l.starts_with('#')).count();
            assert_eq!(packets as u64, stats.samples, "{name}");
            assert!(packets >= 100, "{name}: {packets}");
            let durations: std::collections::BTreeSet<&str> =
                a.lines().filter(|l| !l.starts_with('#')).filter_map(|l| l.split(',').nth(3).map(str::trim)).collect();
            assert_eq!(durations.len() > 1, name == "vfr", "{name}: 패킷 길이 {durations:?}");
            assert_eq!(a, b, "{name}: 패킷 해시·시각이 달라졌다");
            let o = std::fs::read(&out).unwrap();
            assert_eq!(types(&o), ["ftyp", "mdat", "moov"]);
            assert_eq!(table(&o, b"ctts").is_some(), name == "b-frames", "{name}: ctts");
            println!("{name}: 패킷 {packets}개 · 조각 {} · 원본 {} B → 출력 {} B · framemd5 동일", stats.fragments, before.len(), o.len());
        }
    }

    /// 쓰지 않고 버리는 출력 — 드라이런용.
    struct Discard(u64);

    impl Write for Discard {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 += b.len() as u64;
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Seek for Discard {
        fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
            if let SeekFrom::Start(n) = p {
                self.0 = n;
            }
            Ok(self.0)
        }
    }

    /// 실파일 읽기 전용 드라이런(파싱·표 생성까지, 출력은 버린다).
    /// `GPV_REMUX_DRY_RUN=<파일> cargo test --lib remux_dry_run -- --ignored --nocapture`
    #[test]
    #[ignore = "GPV_REMUX_DRY_RUN=<파일> 필요"]
    fn remux_dry_run() {
        let p = std::env::var("GPV_REMUX_DRY_RUN").expect("GPV_REMUX_DRY_RUN");
        let f = std::fs::File::open(&p).unwrap();
        let len = f.metadata().unwrap().len();
        let t = Instant::now();
        let r = remux_fragmented(f, len, Discard(0), REMUX_BLOCK, &AtomicBool::new(false), &mut |_, _| {});
        let secs = t.elapsed().as_secs_f64();
        println!("dry-run {p}: {r:?} · {secs:.1}s · {:.1} MB/s 읽기", len as f64 / secs / 1e6);
        r.unwrap();
    }

    /// 블록마다 디스크까지 내리는 변형(`GPV_REMUX_SYNC_EACH=1`) — 같은 HDD에서 읽기·쓰기를 정말로 번갈게 한다.
    struct SyncEach(std::fs::File);

    impl Write for SyncEach {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.write(b)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.0.sync_data()
        }
    }

    impl Seek for SyncEach {
        fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
            self.0.seek(p)
        }
    }

    /// 벤치 — 원본 옆에 사본을 만들어 벽시계 시간을 재고(마지막 sync_all 포함) 그 사본을 지운다.
    /// `GPV_REMUX_BENCH=<원본> [GPV_REMUX_BLOCK_MIB=16] [GPV_REMUX_SYNC_EACH=1] cargo test --lib remux_bench -- --ignored --nocapture`
    #[test]
    #[ignore = "GPV_REMUX_BENCH=<파일> 필요"]
    fn remux_bench() {
        let src = std::path::PathBuf::from(std::env::var("GPV_REMUX_BENCH").expect("GPV_REMUX_BENCH"));
        let mib: usize = std::env::var("GPV_REMUX_BLOCK_MIB").ok().map_or(REMUX_BLOCK >> 20, |v| v.parse().unwrap());
        let sync_each = std::env::var("GPV_REMUX_SYNC_EACH").is_ok_and(|v| v == "1");
        let out = src.with_file_name(format!(".gpv-bench-{}.tmp", uuid::Uuid::new_v4().simple()));
        let input = std::fs::File::open(&src).unwrap();
        let len = input.metadata().unwrap().len();
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&out).unwrap();
        let t = Instant::now();
        let no = AtomicBool::new(false);
        let r = if sync_each {
            let mut w = SyncEach(file.try_clone().unwrap());
            remux_fragmented(input, len, &mut w, mib << 20, &no, &mut |_, _| {})
        } else {
            remux_fragmented(input, len, &file, mib << 20, &no, &mut |_, _| {})
        };
        file.sync_all().unwrap();
        let secs = t.elapsed().as_secs_f64();
        drop(file);
        std::fs::remove_file(&out).unwrap();
        let s = r.unwrap();
        println!(
            "bench {} · block {mib} MiB · sync_each {sync_each}: {secs:.1}s · {:.1} MB/s(원본 기준) · 샘플 {}",
            src.display(),
            len as f64 / secs / 1e6,
            s.samples
        );
    }
}
