// 조각 MP4(fMP4) 감지 — "재생 시작·탐색이 느린 영상" 안내 띠의 근거.
//
// 프레임마다 moof+mdat 조각이 붙고 sidx·mfra 색인이 없는 파일(nqvm-vis camstation 녹화물:
// `-movflags +frag_every_frame+empty_moov+default_base_moof`)은 웹뷰 demuxer가 길이·탐색 색인을
// 만들려고 **파일 전체의 조각 헤더를 훑는다** — 11GB·조각 20만 개에서 ffprobe만 27초, 프리뷰 서버를
// 거치면 더 느리다. 판정은 그 비용을 되풀이하면 안 되므로 최상위 박스 헤더 몇 개와 꼬리 16바이트만
// 위치 지정으로 읽는다.
//
// "빠른 재생용 사본"은 기존 video_export(copy)를 그대로 쓴다 — 스트림 카피가 일반 mp4(+faststart)로
// 다시 싸면 moov 하나에 샘플 표가 다 들어간다. 길이를 모르는(probe 시간 초과) 파일의 진행률은
// 아래 바이트 기준 함수가 낸다.

use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;
use tauri::State;

use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_video;
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoContainerInfo {
    /// 최상위에 `moof`가 있다(조각 MP4).
    pub fragmented: bool,
    /// 첫 `moof` 앞의 `sidx` 또는 꼬리 `mfro`(→ `mfra`)가 있다 — 탐색 색인이 있다.
    pub indexed: bool,
}

/// 걷는 최상위 박스 상한 — 일반 mp4는 ftyp·moov·mdat(+free·uuid 몇 개)이고 조각 MP4의 첫 moof는 3번째쯤이다.
/// 상한이 없으면 moof 없는 기형 파일에서 박스 수만큼 읽기가 는다.
const MAX_TOP_BOXES: usize = 64;

/// 최상위 박스 헤더를 앞에서부터 첫 `moof`까지 걷고, 끝 16바이트에서 `mfro`를 본다. 파일 본문은 읽지 않는다.
/// 박스 크기가 EOF를 넘는(잘린) 파일도 거기서 멈출 뿐 오류가 아니다 — 읽기 자체가 실패할 때만 Err.
pub(crate) fn scan_container<R: Read + Seek>(r: &mut R) -> std::io::Result<VideoContainerInfo> {
    let none = VideoContainerInfo { fragmented: false, indexed: false };
    let len = r.seek(SeekFrom::End(0))?;
    let mut pos = 0u64;
    let mut fragmented = false;
    let mut sidx = false;
    for i in 0..MAX_TOP_BOXES {
        if len.saturating_sub(pos) < 8 {
            break;
        }
        let mut head = [0u8; 8];
        r.seek(SeekFrom::Start(pos))?;
        r.read_exact(&mut head)?;
        let typ = &head[4..8];
        // ftyp로 시작하지 않으면 mp4 계열이 아니다(mkv·avi·ftyp 없는 옛 QuickTime) — 안내하지 않는다.
        if i == 0 && typ != b"ftyp" {
            return Ok(none);
        }
        let (size, header) = match u32::from_be_bytes([head[0], head[1], head[2], head[3]]) {
            1 => {
                if len - pos < 16 {
                    break;
                }
                let mut large = [0u8; 8];
                r.read_exact(&mut large)?;
                (u64::from_be_bytes(large), 16)
            }
            0 => (len - pos, 8), // 마지막 박스가 EOF까지
            n => (u64::from(n), 8),
        };
        if typ == b"moof" {
            fragmented = true;
            break;
        }
        if typ == b"sidx" {
            sidx = true;
        }
        // 헤더보다 작은 크기는 기형이다 — 그대로 더하면 같은 자리를 맴돈다.
        if size < header {
            break;
        }
        pos = pos.saturating_add(size);
    }
    // mfra의 마지막 자식 mfro(16바이트 full box)가 파일 끝에 붙는다: size(16) · "mfro" · version/flags · mfra 크기.
    let mut mfro = false;
    if len >= 16 {
        let mut tail = [0u8; 16];
        r.seek(SeekFrom::Start(len - 16))?;
        r.read_exact(&mut tail)?;
        mfro = tail[0..4] == 16u32.to_be_bytes() && &tail[4..8] == b"mfro";
    }
    Ok(VideoContainerInfo { fragmented, indexed: sidx || mfro })
}

/// ffmpeg `-progress`의 `total_size=`(지금까지 쓴 바이트). 시작 직후의 `N/A`는 None.
pub(crate) fn parse_total_size(line: &str) -> Option<u64> {
    line.strip_prefix("total_size=")?.trim().parse().ok()
}

/// 스트림 카피 진행률(%) — 출력 크기 ≈ 입력 크기라 쓴 바이트 ÷ 원본 바이트. 원본 크기를 모르면 0.
/// 길이를 모르는(시간 기준 분모가 0인) 전체 카피에서만 쓴다 — 구간 카피는 출력이 원본보다 작아 맞지 않는다.
pub(crate) fn copy_progress_pct(written: u64, src_bytes: u64) -> f64 {
    if src_bytes == 0 {
        return 0.0;
    }
    ((written as f64) / (src_bytes as f64) * 100.0).clamp(0.0, 100.0)
}

#[tauri::command(async)]
pub fn video_container_info(
    state: State<'_, AppState>,
    project_id: String,
    rel_path: String,
) -> Result<VideoContainerInfo, IpcError> {
    let src = super::video::resolve_media(&state, &project_id, &rel_path)?;
    let fail = |e: std::io::Error| IpcError::new(ErrorCode::Io, text_video::video_container_read_failed(&src, &e));
    let mut f = std::fs::File::open(&src).map_err(fail)?;
    scan_container(&mut f).map_err(fail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// 32비트 크기 박스 — 본문은 0으로 채운다(판정은 헤더만 본다).
    fn bx(typ: &[u8; 4], body: usize) -> Vec<u8> {
        let mut v = ((8 + body) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(typ);
        v.resize(8 + body, 0);
        v
    }

    fn mfra() -> Vec<u8> {
        let mut v = bx(b"mfra", 8 + 16);
        v[8..16].copy_from_slice(&bx(b"tfra", 0));
        let mut mfro = 16u32.to_be_bytes().to_vec();
        mfro.extend_from_slice(b"mfro");
        mfro.extend_from_slice(&[0; 4]);
        mfro.extend_from_slice(&(v.len() as u32).to_be_bytes());
        v[16..32].copy_from_slice(&mfro);
        v
    }

    fn scan(parts: &[Vec<u8>]) -> VideoContainerInfo {
        scan_container(&mut Cursor::new(parts.concat())).expect("scan")
    }

    fn fragments(n: usize) -> Vec<Vec<u8>> {
        (0..n).flat_map(|_| [bx(b"moof", 40), bx(b"mdat", 100)]).collect()
    }

    const PLAIN: VideoContainerInfo = VideoContainerInfo { fragmented: false, indexed: false };

    #[test]
    fn video_container_plain_mp4_is_not_fragmented() {
        assert_eq!(scan(&[bx(b"ftyp", 16), bx(b"moov", 200), bx(b"mdat", 5000)]), PLAIN);
        // faststart 반대 배치(mdat가 먼저)도 같다
        assert_eq!(scan(&[bx(b"ftyp", 16), bx(b"free", 0), bx(b"mdat", 5000), bx(b"moov", 200)]), PLAIN);
    }

    #[test]
    fn video_container_fragmented_without_index() {
        let parts = [vec![bx(b"ftyp", 16), bx(b"moov", 700)], fragments(5)].concat();
        assert_eq!(scan(&parts), VideoContainerInfo { fragmented: true, indexed: false });
    }

    #[test]
    fn video_container_sidx_before_first_moof_is_indexed() {
        let parts = [vec![bx(b"ftyp", 16), bx(b"moov", 700), bx(b"sidx", 40)], fragments(3)].concat();
        assert_eq!(scan(&parts), VideoContainerInfo { fragmented: true, indexed: true });
    }

    #[test]
    fn video_container_trailing_mfra_is_indexed() {
        let parts = [vec![bx(b"ftyp", 16), bx(b"moov", 700)], fragments(3), vec![mfra()]].concat();
        assert_eq!(scan(&parts), VideoContainerInfo { fragmented: true, indexed: true });
        // 꼬리 16바이트가 mfro처럼 생겼어도 크기 필드가 16이 아니면 색인이 아니다
        let mut fake = bx(b"mdat", 16);
        fake[8..12].copy_from_slice(&20u32.to_be_bytes());
        fake[12..16].copy_from_slice(b"mfro");
        let parts = [vec![bx(b"ftyp", 16), bx(b"moov", 700)], fragments(2), vec![fake]].concat();
        assert_eq!(scan(&parts), VideoContainerInfo { fragmented: true, indexed: false });
    }

    #[test]
    fn video_container_largesize_and_eof_boxes_are_walked() {
        // 64비트 largesize mdat(size=1) 뒤의 moof까지 걷는다
        let mut large = 1u32.to_be_bytes().to_vec();
        large.extend_from_slice(b"mdat");
        large.extend_from_slice(&(16u64 + 32).to_be_bytes());
        large.resize(16 + 32, 0);
        let parts = [vec![bx(b"ftyp", 16), bx(b"moov", 700), large], fragments(1)].concat();
        assert_eq!(scan(&parts), VideoContainerInfo { fragmented: true, indexed: false });
        // size=0(EOF까지) mdat — 그 뒤로는 박스가 없다
        let mut eof = 0u32.to_be_bytes().to_vec();
        eof.extend_from_slice(b"mdat");
        eof.resize(300, 0);
        assert_eq!(scan(&[bx(b"ftyp", 16), bx(b"moov", 200), eof]), PLAIN);
    }

    #[test]
    fn video_container_non_mp4_is_neither() {
        // mkv(EBML) — 첫 박스가 ftyp가 아니다. 뒤에 moof처럼 생긴 바이트가 있어도 걷지 않는다.
        let mut mkv = vec![0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0];
        mkv.extend(fragments(2).concat());
        assert_eq!(scan(&[mkv]), PLAIN);
        assert_eq!(scan(&[vec![0u8; 5]]), PLAIN);
        assert_eq!(scan(&[]), PLAIN);
    }

    #[test]
    fn video_container_truncated_file_does_not_panic() {
        // moov 크기가 EOF를 넘는다 — 거기서 멈춘다(moof 판정 없음)
        let mut moov = bx(b"moov", 20);
        moov[0..4].copy_from_slice(&10_000u32.to_be_bytes());
        assert_eq!(scan(&[bx(b"ftyp", 16), moov]), PLAIN);
        // largesize 헤더가 중간에 잘렸다
        let mut cut = 1u32.to_be_bytes().to_vec();
        cut.extend_from_slice(b"mdat");
        cut.extend_from_slice(&[0, 0, 0]);
        assert_eq!(scan(&[bx(b"ftyp", 16), cut]), PLAIN);
        // 헤더보다 작은 크기(기형) — 무한 루프 없이 멈춘다
        let mut tiny = bx(b"free", 0);
        tiny[0..4].copy_from_slice(&4u32.to_be_bytes());
        assert_eq!(scan(&[bx(b"ftyp", 16), tiny, bx(b"moof", 8)]), PLAIN);
        // 잘린 조각 파일이어도 첫 moof 헤더가 보이면 조각 MP4다
        let mut moof = bx(b"moof", 0);
        moof[0..4].copy_from_slice(&9_999u32.to_be_bytes());
        let r = scan(&[bx(b"ftyp", 16), bx(b"moov", 700), moof]);
        assert_eq!(r, VideoContainerInfo { fragmented: true, indexed: false });
    }

    #[test]
    fn video_container_copy_progress_by_bytes() {
        assert_eq!(parse_total_size("total_size=1048576"), Some(1_048_576));
        assert_eq!(parse_total_size("total_size=N/A"), None);
        assert_eq!(parse_total_size("out_time_us=5"), None);
        assert_eq!(copy_progress_pct(0, 1000), 0.0);
        assert_eq!(copy_progress_pct(250, 1000), 25.0);
        // 출력이 원본보다 조금 커도(헤더 차이) 100을 넘지 않는다
        assert_eq!(copy_progress_pct(1010, 1000), 100.0);
        assert_eq!(copy_progress_pct(500, 0), 0.0);
    }
}
