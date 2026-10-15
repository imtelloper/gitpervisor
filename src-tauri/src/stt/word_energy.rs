// 어절 끝 시각을 소리 에너지로 당긴다. whisper_json.rs는 어절 끝을 "다음 어절 시작"(VAD 조각 끝 상한)으로만 줄 수
// 있어서, 조각 안의 짧은 쉼이 앞 어절에 흡수돼 gap 토큰·무음 줄이기가 그 쉼을 보지 못했다(태스크 72 부록 B.5:
// 끝 시각은 정답이 없어 재지 못했다).
//
// 알고리즘은 FilmCraft `crates/speech/src/vad.rs`의 tighten_words를 옮겼다(MIT OR Apache-2.0,
// © ArtCraft Team and the FilmCraft contributors): 10ms RMS 프레임, 문턱 = 바닥(10백분위)과 말소리(95백분위) 사이
// 30% 지점이되 바닥 +6dB 이상, 어절 최소 60ms. 원본과 달리 **시작은 건드리지 않는다** — DTW 시작은 부록 B.1에서
// 실측으로 보정했고(−190ms), 약한 첫 자음(ㅅ·ㅎ)을 잘라 먹을 위험만 늘린다. 컷 계획의 PAD_MS(200ms)가 끝 쪽 여유다.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use crate::stt::doc::SttWord;

/// 16kHz에서 10ms.
const FRAME_SAMPLES: usize = 160;
const FRAME_MS: u64 = 10;
const MIN_WORD_FRAMES: usize = 6;
/// 디지털 무음(−100dBFS 미만)은 바닥 추정에서 뺀다 — 녹음의 실제 잡음 바닥보다 한참 아래로 끌어내린다.
const DIGITAL_SILENCE_DB: f32 = -100.0;
const FALLBACK_THRESHOLD_DB: f32 = -60.0;

fn invalid(m: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, m.to_string())
}

/// 전사용 WAV(transcribe.rs `build_stt_audio_args`: 16kHz 모노 s16le) → 10ms 프레임 dBFS. 1시간 ≈ 115MB라
/// 통째로 읽지 않고 흘려 읽는다. 다른 형식이면 Err — 프레임 길이가 맞지 않으면 시각이 통째로 어긋난다.
pub fn wav_frame_db(path: &Path) -> std::io::Result<Vec<f32>> {
    let mut r = BufReader::new(File::open(path)?);
    let mut riff = [0u8; 12];
    r.read_exact(&mut riff)?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(invalid("not a RIFF/WAVE file"));
    }
    let mut fmt_ok = false;
    loop {
        let mut ch = [0u8; 8];
        r.read_exact(&mut ch)?;
        let size = u64::from(u32::from_le_bytes([ch[4], ch[5], ch[6], ch[7]]));
        match &ch[0..4] {
            b"fmt " => {
                let mut f = vec![0u8; size as usize + (size as usize & 1)];
                r.read_exact(&mut f)?;
                if f.len() < 16 {
                    return Err(invalid("fmt chunk too short"));
                }
                let tag = u16::from_le_bytes([f[0], f[1]]);
                let channels = u16::from_le_bytes([f[2], f[3]]);
                let rate = u32::from_le_bytes([f[4], f[5], f[6], f[7]]);
                let bits = u16::from_le_bytes([f[14], f[15]]);
                // 0xFFFE = WAVE_FORMAT_EXTENSIBLE(ffmpeg가 고르는 경우가 있다) — 하위 형식까지 볼 필요는 없다(우리가 만든 파일).
                fmt_ok = matches!(tag, 1 | 0xFFFE) && channels == 1 && rate == 16_000 && bits == 16;
                if !fmt_ok {
                    return Err(invalid("expected 16kHz mono s16le"));
                }
            }
            b"data" => break,
            _ => {
                std::io::copy(&mut r.by_ref().take(size + (size & 1)), &mut std::io::sink())?;
            }
        }
    }
    if !fmt_ok {
        return Err(invalid("data chunk before fmt chunk"));
    }

    // data 크기는 믿지 않고 EOF까지 — 스트리밍으로 쓴 WAV는 크기 칸이 0xFFFFFFFF다.
    let mut db = Vec::new();
    let (mut sum, mut n) = (0f64, 0usize);
    let mut lo: Option<u8> = None;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let k = r.read(&mut buf)?;
        if k == 0 {
            break;
        }
        for &b in &buf[..k] {
            let Some(l) = lo.take() else {
                lo = Some(b);
                continue;
            };
            let s = f64::from(i16::from_le_bytes([l, b])) / 32768.0;
            sum += s * s;
            n += 1;
            if n == FRAME_SAMPLES {
                db.push(frame_level(sum, n));
                (sum, n) = (0.0, 0);
            }
        }
    }
    if n > 0 {
        db.push(frame_level(sum, n));
    }
    Ok(db)
}

fn frame_level(sum: f64, n: usize) -> f32 {
    (10.0 * (sum / n as f64 + 1e-12).log10()) as f32
}

/// 말소리/쉼 문턱(dBFS).
pub fn speech_threshold_db(db: &[f32]) -> f32 {
    let mut s: Vec<f32> = db.iter().copied().filter(|v| *v > DIGITAL_SILENCE_DB).collect();
    if s.is_empty() {
        return FALLBACK_THRESHOLD_DB;
    }
    s.sort_by(f32::total_cmp);
    let q = |p: f32| s[((s.len() - 1) as f32 * p) as usize];
    let (floor, speech) = (q(0.10), q(0.95));
    (floor + 0.3 * (speech - floor)).max(floor + 6.0)
}

/// 어절 끝에서 문턱 아래 프레임을 걷어 낸다(시작은 그대로, 최소 60ms 유지). 소리가 하나도 문턱을 넘지 않는
/// 어절(속삭임·잡음 속 말)은 판정을 믿지 않고 둔다.
pub fn tighten_word_ends(words: &mut [SttWord], db: &[f32]) {
    if db.is_empty() {
        return;
    }
    let th = speech_threshold_db(db);
    for w in words {
        let a = (w.start_ms / FRAME_MS) as usize;
        let b = (w.end_ms.div_ceil(FRAME_MS) as usize).min(db.len());
        if b <= a + MIN_WORD_FRAMES || db[a..b].iter().all(|v| *v < th) {
            continue;
        }
        let mut e = b;
        while e > a + MIN_WORD_FRAMES && db[e - 1] < th {
            e -= 1;
        }
        if e < b {
            w.end_ms = (e as u64 * FRAME_MS).clamp(w.start_ms, w.end_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::tests::w;

    /// 0~0.5s 말, 0.5~1.5s 쉼(잡음 바닥), 1.5~2.0s 말 — 16kHz s16le.
    fn speech_pause_speech() -> Vec<i16> {
        (0..32_000)
            .map(|i| {
                let voiced = i < 8_000 || i >= 24_000;
                if voiced { (9_000.0 * (i as f32 * 0.07).sin()) as i16 } else if i % 2 == 0 { 3 } else { -3 }
            })
            .collect()
    }

    fn wav_bytes(samples: &[i16], extra_chunk: bool) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&16_000u32.to_le_bytes());
        b.extend_from_slice(&32_000u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        if extra_chunk {
            // ffmpeg가 넣는 LIST(INFO) — 홀수 크기는 패딩 1바이트가 붙는다.
            b.extend_from_slice(b"LIST");
            b.extend_from_slice(&3u32.to_le_bytes());
            b.extend_from_slice(b"abc\0");
        }
        b.extend_from_slice(b"data");
        b.extend_from_slice(&u32::MAX.to_le_bytes()); // 스트리밍 WAV — 크기를 믿으면 안 된다
        b.extend_from_slice(&data);
        b
    }

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gpv-word-energy-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.wav");
        std::fs::write(&p, bytes).unwrap();
        p
    }

    /// 쉼을 삼킨 어절 끝이 말소리 끝(0.5s)으로 당겨지고, 쉼 없는 어절은 그대로다.
    #[test]
    fn word_ends_shrink_to_speech_end() {
        let p = write_tmp("shrink", &wav_bytes(&speech_pause_speech(), true));
        let db = wav_frame_db(&p).unwrap();
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
        assert_eq!(db.len(), 200, "2초 = 10ms 프레임 200개");
        let mut words = vec![w(0, 1500, "하나", 0), w(1500, 2000, "둘", 0)];
        tighten_word_ends(&mut words, &db);
        assert_eq!((words[0].start_ms, words[0].end_ms), (0, 500), "시작은 그대로, 끝은 말소리 끝");
        assert_eq!((words[1].start_ms, words[1].end_ms), (1500, 2000));
    }

    /// 최소 60ms는 남기고, 문턱을 넘는 소리가 없는 어절과 짧은 어절은 건드리지 않는다.
    #[test]
    fn word_ends_keep_minimum_and_skip_unvoiced() {
        let db: Vec<f32> = (0..200).map(|i| if i < 50 || i >= 150 { -10.0 } else { -70.0 }).collect();
        let mut words = vec![
            w(480, 1400, "끝만 말", 0),   // 48~50 프레임만 말소리 → 끝 = 시작 + 60ms
            w(600, 1400, "무성", 0),      // 문턱 넘는 프레임 없음 → 그대로
            w(1450, 1500, "짧음", 0),     // 60ms 이하 → 그대로
        ];
        tighten_word_ends(&mut words, &db);
        assert_eq!(words[0].end_ms, 540);
        assert_eq!(words[1].end_ms, 1400);
        assert_eq!(words[2].end_ms, 1500);
    }

    /// 실제 ffmpeg가 전사 인자(build_stt_audio_args)로 쓴 WAV — 머리 청크 구성을 우리가 정하지 않는다 — 를 읽고,
    /// 0.5초 말 + 1초 쉼 + 0.5초 말(aac 왕복)에서 쉼을 삼킨 어절 끝이 0.5초 근처로 당겨지는지.
    /// `cargo test --lib word_energy_real_ffmpeg -- --ignored --nocapture`
    #[test]
    #[ignore = "PATH의 ffmpeg 필요"]
    fn word_energy_real_ffmpeg_wav() {
        let ffmpeg = crate::tools::runner::find_on_path("ffmpeg").expect("ffmpeg");
        let dir = std::env::temp_dir().join(format!("gpv-word-energy-real-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.m4a").display().to_string();
        let tone = "aevalsrc=if(lt(t\\,0.5)+gte(t\\,1.5)\\,0.3*sin(2*PI*300*t)\\,0.0005*sin(2*PI*60*t)):d=2:s=48000";
        let gen = ["-v", "error", "-y", "-f", "lavfi", "-i", tone, "-c:a", "aac", &src];
        assert!(std::process::Command::new(&ffmpeg).args(gen).status().unwrap().success());
        let wav = dir.join("a.wav");
        let args = crate::stt::transcribe::build_stt_audio_args(&src, &wav.display().to_string(), 0, 0);
        let out = std::process::Command::new(&ffmpeg).args(&args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let db = wav_frame_db(&wav).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        let mut words = vec![w(0, 1500, "하나", 0), w(1500, 2000, "둘", 0)];
        tighten_word_ends(&mut words, &db);
        println!("frames={} th={:.1}dB → 하나 끝 {}ms", db.len(), speech_threshold_db(&db), words[0].end_ms);
        assert!((1950..=2100).contains(&(db.len() * 10)), "길이 ≈ 2초: {}", db.len());
        assert!((480..=560).contains(&words[0].end_ms), "하나 끝 = 말소리 끝 근처: {}", words[0].end_ms);
    }

    /// 다른 형식(우리가 만든 파일이 아님)은 시각을 어긋나게 하지 않고 거절한다.
    #[test]
    fn wav_frame_db_rejects_wrong_format() {
        let mut bytes = wav_bytes(&[0, 1, 2], false);
        bytes[24..28].copy_from_slice(&44_100u32.to_le_bytes());
        let p = write_tmp("format", &bytes);
        let r = wav_frame_db(&p);
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
        assert!(r.is_err());
        assert_eq!(speech_threshold_db(&[]), FALLBACK_THRESHOLD_DB);
    }
}
