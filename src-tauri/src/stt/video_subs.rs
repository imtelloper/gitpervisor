// 자막 입힌 영상(태스크 72 §3.6 4~6, P3) — `ExportSpec.caption_subs`. 번인은 libass(`subtitles` 필터)가 ASS를
// 그리고, 소프트 자막은 SRT를 mp4/mov 자막 스트림(mov_text)으로 싣는다(libass 불필요).
//
// **필터 문자열에 경로·사용자 텍스트를 넣지 않는다**: ASS는 잡마다 새 폴더 `stt/gpv-stt-burn-<uuid>/subs.ass`에 쓰고
// ffmpeg를 그 폴더에서 돌려 필터는 상수 `BURN_FILTER`다. 필터 인자의 `:`·`\`·`'`·`,` 이스케이프(Windows 드라이브
// 콜론이 대표적)와 필터 인젝션 경계가 통째로 사라진다. 입·출력은 절대 경로 argv 원소(commands/video.rs).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::commands::RangeMs;
use crate::error::{ErrorCode, IpcError};
use crate::i18n::text_stt;
use crate::stt::plan::OutCue;
use crate::stt::store::CaptionLoaded;
use crate::stt::subs::{build_srt, normalize_cues, select_sub_text, source_cues, SubText, SubTimeline};
use crate::stt::transcribe::{temp_dir, TempFiles, TEMP_PREFIX};

pub const BURN_ASS_NAME: &str = "subs.ass";
/// ffmpeg cwd = ASS 폴더라 상대 이름 하나로 끝난다(머리 주석).
pub const BURN_FILTER: &str = "subtitles=f=subs.ass";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubsMode {
    /// 화면에 그려 넣는다 — 재인코딩·libass 필요.
    Burn,
    /// 자막 스트림(mov_text)으로 싣는다 — 플레이어가 켜고 끈다. 무손실 복사와도 된다.
    Soft,
}

/// 자막 문서(`CaptionDoc.style_preset`)에도 저장된다 — 미리보기 오버레이와 번인 기본값을 영상마다 기억한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionStylePreset {
    Basic,
    Box,
    Large,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionSubs {
    pub mode: SubsMode,
    /// `Edited`는 `caption_cut`과 짝이다(편집본에는 편집본 시각만) — validate_spec이 본다.
    pub timeline: SubTimeline,
    pub text: SubText,
    #[serde(default)]
    pub lang: Option<String>,
    /// 번인에만 쓴다.
    pub preset: CaptionStylePreset,
}

/// 스타일 값 — 천분율(‰): 글자 크기·테두리·박스 여백·아래 여백은 출력 **높이** 기준, 좌우 여백은 **폭** 기준,
/// 박스 불투명도는 %. `box_pad` 0 = 박스 없음. 대본 미리보기 오버레이가 같은 표에서 CSS를 만든다 —
/// 거울은 `src/lib/captionStyle.ts`, 둘이 같은지는 `caption_style_table_matches_ts_mirror`가 단언한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptionStyle {
    pub size: u32,
    pub outline: u32,
    pub box_pad: u32,
    pub box_opacity: u32,
    pub margin_v: u32,
    pub margin_h: u32,
}

pub const fn caption_style(p: CaptionStylePreset) -> CaptionStyle {
    match p {
        CaptionStylePreset::Basic => {
            CaptionStyle { size: 50, outline: 3, box_pad: 0, box_opacity: 0, margin_v: 60, margin_h: 50 }
        }
        CaptionStylePreset::Box => {
            CaptionStyle { size: 50, outline: 0, box_pad: 10, box_opacity: 70, margin_v: 60, margin_h: 50 }
        }
        CaptionStylePreset::Large => {
            CaptionStyle { size: 70, outline: 4, box_pad: 0, box_opacity: 0, margin_v: 60, margin_h: 30 }
        }
    }
}

/// 한글 글리프가 있는 OS 기본 글꼴(Windows · macOS · Linux 순). libass가 못 찾으면 대체 글꼴로 그리는데, 그 글꼴에
/// 한글이 없으면 네모 칸이 된다(§8 Q6).
pub const CAPTION_FONTS: [&str; 3] = ["Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR"];

pub const fn caption_font() -> &'static str {
    if cfg!(windows) {
        CAPTION_FONTS[0]
    } else if cfg!(target_os = "macos") {
        CAPTION_FONTS[1]
    } else {
        CAPTION_FONTS[2]
    }
}

fn permille(v: u32, of: u32) -> u32 {
    ((u64::from(v) * u64::from(of) + 500) / 1000) as u32
}

/// ms → ASS `H:MM:SS.cc`(센티초 반올림).
fn ass_time(ms: u64) -> String {
    let cs = (ms + 5) / 10;
    format!("{}:{:02}:{:02}.{:02}", cs / 360_000, cs / 6000 % 60, cs / 100 % 60, cs % 100)
}

/// ASS가 특별히 읽는 `{ } \`는 전각으로 바꿔 그대로 보이게 한다(재정의 태그·`\N` 같은 이스케이프 규칙에 기대지
/// 않는다). 번인(ASS)과 소프트 자막(SRT → mov_text)이 같은 글자를 보이게 둘이 같이 쓴다.
fn fullwidth_markup(c: char) -> char {
    match c {
        '{' => '｛',
        '}' => '｝',
        '\\' => '＼',
        c => c,
    }
}

/// Dialogue 본문 — `{ } \`는 전각, 줄바꿈만 `\N`으로. 금지 문자는 normalize_cues가 이미 지웠다.
fn ass_text(s: &str) -> String {
    s.chars().map(fullwidth_markup).collect::<String>().replace('\n', "\\N")
}

/// 소프트 자막 SRT — ffmpeg의 SRT 디코더가 cue 글을 마크업으로 읽은 뒤 mov_text로 옮긴다(실측 gyan 8.0, 되읽은
/// 패킷): `C:\new` → `C:`+줄바꿈+`ew`, `if a<b and c>d` → `if ad`(굵게), `<file>`·`{\an8}`·`{y:b}`는 사라진다.
/// 번인과 같은 전각 치환에 `<`를 더한다. `&lt;`는 풀리지 않고 그대로 보여서(실측) 쓸 수 없다. 자막 파일(.srt)
/// 내보내기는 편집기가 읽는 원문이라 건드리지 않는다.
pub(crate) fn build_soft_srt(cues: &[OutCue]) -> String {
    let safe: Vec<OutCue> = cues
        .iter()
        .map(|c| OutCue {
            text: c.text.chars().map(|ch| if ch == '<' { '＜' } else { fullwidth_markup(ch) }).collect(),
            ..c.clone()
        })
        .collect();
    build_srt(&safe)
}

/// ASS 색 `&HAABBGGRR`(알파 00 = 불투명).
fn ass_black(opacity_pct: u32) -> String {
    format!("&H{:02X}000000", 255 - permille(opacity_pct.min(100) * 10, 255))
}

/// ASS `[Script Info]`의 주석 줄 — 여러 줄 format 문자열 안에서는 표시를 달 수 없어 상수로 뺐다.
const ASS_HEADER_COMMENT: &str = "; Gitpervisor 자막 번인"; // i18n-ok: ASS 파일 주석(데이터, libass만 읽는다)

/// 번인용 ASS. `PlayResX/Y` = 출력 프레임 크기라 스타일 값(‰)이 곧 출력 px다. cue 텍스트의 줄바꿈은 `\N`.
pub fn build_ass(cues: &[OutCue], preset: CaptionStylePreset, out_w: u32, out_h: u32) -> String {
    let st = caption_style(preset);
    let (w, h) = (out_w.max(1), out_h.max(1));
    // 박스(BorderStyle 3)는 테두리 두께가 박스 여백이다. 박스 색을 OutlineColour·BackColour 양쪽에 준다 —
    // 렌더러마다 박스를 어느 색으로 칠하는지가 갈린다(libass·VSFilter).
    let (border_style, outline, outline_colour, back_colour) = if st.box_pad > 0 {
        let c = ass_black(st.box_opacity);
        (3, permille(st.box_pad, h), c.clone(), c)
    } else {
        (1, permille(st.outline, h), ass_black(100), ass_black(50))
    };
    let mut s = format!(
        "[Script Info]\n\
         {header_comment}\n\
         ScriptType: v4.00+\n\
         PlayResX: {w}\n\
         PlayResY: {h}\n\
         WrapStyle: 0\n\
         ScaledBorderAndShadow: yes\n\
         YCbCr Matrix: None\n\
         \n\
         [V4+ Styles]\n\
         Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, \
         Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, \
         MarginR, MarginV, Encoding\n\
         Style: Default,{font},{size},&H00FFFFFF,&H00FFFFFF,{outline_colour},{back_colour},0,0,0,0,100,100,0,0,\
         {border_style},{outline},0,2,{mh},{mh},{mv},1\n\
         \n\
         [Events]\n\
         Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        header_comment = ASS_HEADER_COMMENT,
        font = caption_font(),
        size = permille(st.size, h).max(1),
        mh = permille(st.margin_h, w),
        mv = permille(st.margin_v, h),
    );
    for c in normalize_cues(cues) {
        let (a, b) = (ass_time(c.start_ms), ass_time(c.end_ms));
        // 10ms보다 짧은 cue는 센티초로 반올림하면 길이 0이 된다.
        if a != b {
            s.push_str(&format!("Dialogue: 0,{a},{b},Default,,0,0,0,,{}\n", ass_text(&c.text)));
        }
    }
    s
}

/// 자막 시각을 출력 타임라인으로 — 구간(In/Out, 입력 `-ss`)이면 시작만큼 당기고 구간 밖은 버리며 걸친 cue는 자른다.
/// `speed`로 나눈다(소프트 자막 스트림은 setpts를 타지 않는다).
pub fn shift_cues(cues: Vec<OutCue>, range: Option<RangeMs>, speed: f64) -> Vec<OutCue> {
    let (lo, hi) = range.map_or((0, u64::MAX), |r| (r.start_ms, r.end_ms));
    let speed = if speed > 0.0 { speed } else { 1.0 };
    let scale = |t: u64| ((t - lo) as f64 / speed).round() as u64;
    cues.into_iter()
        .filter_map(|c| {
            let (s, e) = (c.start_ms.max(lo), c.end_ms.min(hi));
            (e > s).then(|| OutCue { start_ms: scale(s), end_ms: scale(e), ..c })
        })
        .collect()
}

/// 자막 입힌 영상의 cue — 시간축(원본/편집본) → 자막 줄 고르기(원문·번역·2단) → 출력 타임라인(구간·배속).
/// 번인은 subtitles 필터가 setpts **앞**이라 배속 전 시각 그대로 쓴다(§3.6-2).
pub fn export_cues(
    loaded: &CaptionLoaded,
    subs: &CaptionSubs,
    range: Option<RangeMs>,
    speed: f64,
) -> Result<Vec<OutCue>, IpcError> {
    let cues = match subs.timeline {
        SubTimeline::Source => source_cues(&loaded.doc)?,
        SubTimeline::Edited => loaded.plan.out_cues.clone(),
    };
    let cues = select_sub_text(&loaded.doc, cues, subs.text, subs.lang.as_deref())?;
    let cues = shift_cues(cues, range, if subs.mode == SubsMode::Soft { speed } else { 1.0 });
    if normalize_cues(&cues).is_empty() {
        return Err(IpcError::new(ErrorCode::Io, text_stt::caption_export_no_cues()));
    }
    Ok(cues)
}

/// video_export가 ffmpeg에 넘길 자막 파일. 함께 돌려주는 가드가 잡이 어떻게 끝나든 지운다.
pub(crate) enum SubsFile {
    /// ASS 폴더 — ffmpeg cwd.
    Burn { dir: PathBuf },
    /// 입력 1번으로 붙는 SRT.
    Soft { srt: PathBuf },
}

fn io(m: String) -> IpcError {
    IpcError::new(ErrorCode::Io, m)
}

/// 잡마다 새 폴더 — 두 내보내기가 동시에 돌아도 상수 파일 이름이 겹치지 않는다. 폴더 이름은 `job_id`가 아니라 새
/// uuid다(검증 안 된 id를 경로에 넣지 않는다, 9절 32).
pub(crate) fn write_burn_ass(
    app: &AppHandle,
    cues: &[OutCue],
    preset: CaptionStylePreset,
    out_w: u32,
    out_h: u32,
) -> Result<(SubsFile, TempFiles), IpcError> {
    let dir = temp_dir(app)?.join(format!("{TEMP_PREFIX}burn-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&dir).map_err(|e| io(text_stt::caption_burn_temp_dir_failed(&dir.display(), &e)))?;
    let ass = dir.join(BURN_ASS_NAME);
    // 파일 먼저, 비워진 폴더는 그다음(TempFiles는 순서대로 지운다).
    let guard = TempFiles(vec![ass.clone(), dir.clone()]);
    std::fs::write(&ass, build_ass(cues, preset, out_w, out_h))
        .map_err(|e| io(text_stt::caption_file_write_failed(&ass.display(), &e)))?;
    Ok((SubsFile::Burn { dir }, guard))
}

pub(crate) fn write_soft_srt(app: &AppHandle, cues: &[OutCue]) -> Result<(SubsFile, TempFiles), IpcError> {
    let srt = temp_dir(app)?.join(format!("{TEMP_PREFIX}subs-{}.srt", uuid::Uuid::new_v4().simple()));
    let guard = TempFiles(vec![srt.clone()]);
    std::fs::write(&srt, build_soft_srt(cues)).map_err(|e| io(text_stt::caption_file_write_failed(&srt.display(), &e)))?;
    Ok((SubsFile::Soft { srt }, guard))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt::doc::build_doc;
    use crate::stt::doc::tests::{engine, source, w};
    use crate::stt::plan::caption_plan;
    use std::collections::BTreeMap;

    fn cue(id: &str, s: u64, e: u64, text: &str) -> OutCue {
        OutCue { cue_id: id.into(), start_ms: s, end_ms: e, text: text.into() }
    }

    fn style_line(ass: &str) -> Vec<String> {
        let l = ass.lines().find(|l| l.starts_with("Style: ")).expect("Style 줄");
        l["Style: ".len()..].split(',').map(str::to_string).collect()
    }

    fn dialogues(ass: &str) -> Vec<&str> {
        ass.lines().filter(|l| l.starts_with("Dialogue: ")).collect()
    }

    /// `{ } \`는 전각, 줄바꿈은 `\N`, 금지 문자·빈 줄 제거, 시각은 센티초. 본문이 태그·이스케이프로 읽힐 수 없다.
    #[test]
    fn build_ass_escapes_text_and_breaks_lines() {
        let ass = build_ass(
            &[
                cue("c1", 1234, 4567, "{\\b1}굵게\\N 아님\n\n둘째\u{200B} 줄\r"),
                cue("c2", 5000, 5004, "짧음"), // 센티초로 길이 0
                cue("c3", 6000, 7000, " \u{FEFF} "), // 비면 생략
            ],
            CaptionStylePreset::Basic,
            1920,
            1080,
        );
        let d = dialogues(&ass);
        assert_eq!(d, vec!["Dialogue: 0,0:00:01.23,0:00:04.57,Default,,0,0,0,,｛＼b1｝굵게＼N 아님\\N둘째 줄"]);
        let text = d[0].splitn(10, ',').nth(9).unwrap();
        assert!(!text.contains('{') && !text.contains('}'), "{text}");
        assert_eq!(text.matches('\\').count(), 1, "백슬래시는 줄바꿈 \\N 하나뿐: {text}");
        assert_eq!(ass_time(59_999), "0:01:00.00");
        assert_eq!(ass_time(3_723_456), "1:02:03.46");
        assert_eq!(ass_time(0), "0:00:00.00");
    }

    /// 소프트 자막 SRT는 ffmpeg SRT 디코더가 마크업으로 읽을 `{ } \ <`만 전각 — 번인과 같은 글자, 줄바꿈·`>`·`&`는 그대로.
    #[test]
    fn soft_srt_escapes_markup_like_burn() {
        let text = "C:\\new {\\an8}<i>x</i> {y:b}z\na<b and c>d & e";
        let srt = build_soft_srt(&[cue("c1", 0, 1000, text)]);
        assert_eq!(srt, "1\r\n00:00:00,000 --> 00:00:01,000\r\nC:＼new ｛＼an8｝＜i>x＜/i> ｛y:b｝z\r\na＜b and c>d & e\r\n\r\n");
        let burn = build_ass(&[cue("c1", 0, 1000, text)], CaptionStylePreset::Basic, 640, 360);
        assert!(dialogues(&burn)[0].ends_with(",,C:＼new ｛＼an8｝<i>x</i> ｛y:b｝z\\Na<b and c>d & e"), "{burn}");
    }

    /// PlayResX/Y = 출력 크기, 스타일 값 = 출력 px(‰), 글꼴 = OS 기본, 아래 가운데 정렬.
    #[test]
    fn build_ass_play_res_presets_and_font() {
        let at = |preset, w, h| {
            let ass = build_ass(&[cue("c1", 0, 1000, "가")], preset, w, h);
            assert!(ass.contains(&format!("\nPlayResX: {w}\nPlayResY: {h}\n")), "{ass}");
            style_line(&ass)
        };
        // Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold…, BorderStyle(15), Outline(16), Shadow(17),
        // Alignment(18), MarginL(19), MarginR(20), MarginV(21)
        let basic = at(CaptionStylePreset::Basic, 1920, 1080);
        assert_eq!(basic[1], caption_font());
        assert_eq!(basic[2], "54", "50‰ × 1080");
        assert_eq!((basic[15].as_str(), basic[16].as_str()), ("1", "3"), "테두리 3‰ × 1080 = 3.24 → 3");
        assert_eq!((basic[18].as_str(), basic[19].as_str(), basic[20].as_str(), basic[21].as_str()), ("2", "96", "96", "65"));
        let boxed = at(CaptionStylePreset::Box, 1280, 720);
        assert_eq!(boxed[15], "3", "박스 = BorderStyle 3");
        assert_eq!(boxed[16], "7", "박스 여백 10‰ × 720");
        assert_eq!(boxed[5], "&H4C000000", "70% 불투명 검정 = 알파 255−179 = 0x4C");
        assert_eq!(boxed[6], boxed[5], "박스 색은 OutlineColour·BackColour 둘 다");
        let large = at(CaptionStylePreset::Large, 1080, 1920);
        assert_eq!(large[2], "134", "세로 영상 — 높이 기준 70‰");
        assert!(large[2].parse::<u32>().unwrap() > at(CaptionStylePreset::Basic, 1080, 1920)[2].parse::<u32>().unwrap());
        // 아주 작은 출력도 글자 크기 0이 되지 않는다.
        assert_eq!(at(CaptionStylePreset::Basic, 4, 2)[2], "1");
        assert!(CAPTION_FONTS.contains(&caption_font()));
    }

    /// 구간이면 range.start만큼 당기고 밖은 버리며 걸친 cue는 자른다 · 배속은 나눈다(소프트 자막만).
    #[test]
    fn shift_cues_moves_into_range_and_speed() {
        let cues = vec![cue("a", 500, 1500, "밖·걸침"), cue("b", 2000, 3000, "안"), cue("c", 3500, 4500, "끝 걸침"), cue("d", 5000, 6000, "밖")];
        let r = Some(RangeMs { start_ms: 1000, end_ms: 4000 });
        let got: Vec<(String, u64, u64)> =
            shift_cues(cues.clone(), r, 1.0).into_iter().map(|c| (c.cue_id, c.start_ms, c.end_ms)).collect();
        assert_eq!(got, vec![("a".into(), 0, 500), ("b".into(), 1000, 2000), ("c".into(), 2500, 3000)]);
        let fast: Vec<(u64, u64)> = shift_cues(cues.clone(), None, 2.0).iter().map(|c| (c.start_ms, c.end_ms)).collect();
        assert_eq!(fast[1], (1000, 1500));
        assert_eq!(shift_cues(cues, None, 1.0).len(), 4, "구간 없음 = 그대로");
    }

    fn loaded(doc: crate::stt::doc::CaptionDoc) -> CaptionLoaded {
        let plan = caption_plan(&doc).unwrap();
        CaptionLoaded { doc, stale: false, plan }
    }

    fn subs(mode: SubsMode, timeline: SubTimeline, text: SubText, lang: Option<&str>) -> CaptionSubs {
        CaptionSubs { mode, timeline, text, lang: lang.map(str::to_string), preset: CaptionStylePreset::Basic }
    }

    /// 원문 → 원문 아래 번역 2단(ASS `\N`) · 번역만 · 번역이 빠진 cue가 있으면 거절 · 편집본 시각은 잘린 어절이 빠진 plan.
    #[test]
    fn export_cues_both_two_lines_and_timelines() {
        let mut d = build_doc(source(6000), engine("ko"), vec![w(500, 900, "안녕", 0), w(3000, 3500, "하세요", 1)]);
        let (c1, c2) = (d.cues[0].id.clone(), d.cues[1].id.clone());
        let mut en = BTreeMap::new();
        en.insert(c1.clone(), "Hello".to_string());
        d.translations = Some(BTreeMap::from([("en".to_string(), en)]));
        let l = loaded(d.clone());

        // 번역이 한 줄 빠졌다 — 원문으로 채우지 않고 거절.
        let e = export_cues(&l, &subs(SubsMode::Burn, SubTimeline::Source, SubText::Both, Some("en")), None, 1.0).unwrap_err();
        assert!(e.message.contains("1줄"), "{}", e.message);
        assert!(export_cues(&l, &subs(SubsMode::Burn, SubTimeline::Source, SubText::Both, None), None, 1.0).is_err());
        assert!(export_cues(&l, &subs(SubsMode::Burn, SubTimeline::Source, SubText::Translation, Some("ja")), None, 1.0).is_err());

        d.translations.as_mut().unwrap().get_mut("en").unwrap().insert(c2, "there".to_string());
        let l = loaded(d.clone());
        let both = export_cues(&l, &subs(SubsMode::Burn, SubTimeline::Source, SubText::Both, Some("en")), None, 1.0).unwrap();
        assert_eq!(both[0].text, "안녕\nHello");
        let ass = build_ass(&both, CaptionStylePreset::Box, 640, 360);
        assert!(dialogues(&ass)[0].ends_with(",,안녕\\NHello"), "{ass}");
        let tr = export_cues(&l, &subs(SubsMode::Soft, SubTimeline::Source, SubText::Translation, Some("en")), None, 1.0).unwrap();
        assert_eq!((tr[0].text.as_str(), tr[1].text.as_str()), ("Hello", "there"));

        // 편집본 시각 = plan.out_cues(잘린 어절은 빠지고 시각은 out(t)).
        d.tokens.iter_mut().find(|t| t.text == "안녕").unwrap().cut = true;
        let l = loaded(d);
        let edited = export_cues(&l, &subs(SubsMode::Burn, SubTimeline::Edited, SubText::Caption, None), None, 1.0).unwrap();
        assert_eq!(edited, l.plan.out_cues);
        assert!(edited.iter().all(|c| !c.text.contains("안녕")));

        // 배속은 소프트 자막만 나눈다(번인은 setpts 앞).
        let soft = export_cues(&l, &subs(SubsMode::Soft, SubTimeline::Edited, SubText::Caption, None), None, 2.0).unwrap();
        let burn = export_cues(&l, &subs(SubsMode::Burn, SubTimeline::Edited, SubText::Caption, None), None, 2.0).unwrap();
        assert_eq!(soft[0].start_ms * 2, burn[0].start_ms);

        // 구간 안에 자막이 없으면 거절.
        let none = export_cues(
            &l,
            &subs(SubsMode::Burn, SubTimeline::Source, SubText::Caption, None),
            Some(RangeMs { start_ms: 5000, end_ms: 6000 }),
            1.0,
        );
        assert!(none.unwrap_err().message.contains("내보낼 자막이 없습니다"));
    }

    /// 필터는 상수 하나 — 폴더 안 ASS 파일 이름과 짝이고, 경로 구분자·따옴표·드라이브 콜론이 없다.
    #[test]
    fn burn_filter_is_constant_relative_name() {
        assert_eq!(BURN_FILTER, format!("subtitles=f={BURN_ASS_NAME}"));
        assert!(!BURN_ASS_NAME.contains(['/', '\\', ':', '\'', ',', ';', '[', ']']));
    }

    /// 프리셋 값 표의 TS 거울(`src/lib/captionStyle.ts`) — 오버레이 미리보기가 번인과 같은 값을 쓰게. 한 줄 형식 그대로
    /// 찾으므로 거울의 줄 모양을 바꾸면 여기도 바꾼다.
    #[test]
    fn caption_style_table_matches_ts_mirror() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/captionStyle.ts");
        let ts = std::fs::read_to_string(&path).expect("src/lib/captionStyle.ts");
        let presets = [
            (CaptionStylePreset::Basic, "basic"),
            (CaptionStylePreset::Box, "box"),
            (CaptionStylePreset::Large, "large"),
        ];
        for (p, name) in presets {
            assert_eq!(serde_json::from_str::<CaptionStylePreset>(&format!("\"{name}\"")).unwrap(), p);
            let s = caption_style(p);
            let row = format!(
                "  {name}: {{ size: {}, outline: {}, box: {}, boxOpacity: {}, marginV: {}, marginH: {} }},",
                s.size, s.outline, s.box_pad, s.box_opacity, s.margin_v, s.margin_h
            );
            assert!(ts.contains(&row), "TS 거울이 Rust 표와 다르다 — 이 줄이 있어야 한다:\n{row}");
        }
        assert_eq!(ts.matches("{ size: ").count(), presets.len(), "TS 거울에 Rust에 없는 프리셋이 있다");
        for f in CAPTION_FONTS {
            assert!(ts.contains(&format!("\"{f}\"")), "TS 글꼴 목록에 {f} 없음");
        }
    }
}
