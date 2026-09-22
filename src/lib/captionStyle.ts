// 자막 스타일 프리셋(태스크 72 §3.5·§3.6) — 번인 ASS(Rust `stt/video_subs.rs` caption_style)와 대본 미리보기
// 오버레이가 같은 값 표를 쓴다. **이 표는 Rust 표의 거울이다**: 값을 바꾸면 Rust도 같이 바꾼다 —
// `cargo test --lib caption_style_table_matches_ts_mirror`가 행을 한 줄 문자열로 찾아 어긋남을 잡으므로 줄 모양을 유지한다.
// 오버레이 CSS는 ASS 렌더와 완전히 같지 않다(글꼴 크기 기준·테두리 그리기가 다르다, §6).
import type { CaptionDoc, CaptionStylePreset } from "./ipc";
import { isMac, isWindows } from "./platform";

/** 천분율(‰): size·outline·box·marginV = 출력 높이 기준, marginH = 폭 기준. boxOpacity는 %. box 0 = 박스 없음. */
export interface CaptionStyleRow {
  size: number;
  outline: number;
  box: number;
  boxOpacity: number;
  marginV: number;
  marginH: number;
}

export const CAPTION_STYLE_PRESETS: Record<CaptionStylePreset, CaptionStyleRow> = {
  basic: { size: 50, outline: 3, box: 0, boxOpacity: 0, marginV: 60, marginH: 50 },
  box: { size: 50, outline: 0, box: 10, boxOpacity: 70, marginV: 60, marginH: 50 },
  large: { size: 70, outline: 4, box: 0, boxOpacity: 0, marginV: 60, marginH: 30 },
};

/** 번인 글꼴(ASS Fontname — Windows · macOS · Linux 순). 오버레이는 이 목록을 font-family로 쓴다. */
export const CAPTION_FONT_FAMILIES = ["Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR"] as const;

export const CAPTION_STYLE_PRESET_IDS: readonly CaptionStylePreset[] = ["basic", "box", "large"];
export const CAPTION_STYLE_LABELS: Record<CaptionStylePreset, string> = { basic: "기본", box: "박스", large: "크게" };

export function captionStylePresetOf(doc: CaptionDoc | null): CaptionStylePreset {
  return doc?.stylePreset ?? "basic";
}

/** 문서의 자막 스타일 바꾸기(되돌리기 한 단계). 같으면 null. basic은 필드를 지운다 — 없음 = basic. */
export function setCaptionStylePreset(doc: CaptionDoc, preset: CaptionStylePreset): CaptionDoc | null {
  if (captionStylePresetOf(doc) === preset) return null;
  const next: CaptionDoc = { ...doc, stylePreset: preset };
  if (preset === "basic") delete next.stylePreset;
  return next;
}

/** 이 OS에서 번인이 쓰는 글꼴의 CAPTION_FONT_FAMILIES 번호 — Rust `caption_font()`의 거울. */
export const CAPTION_OS_FONT = isWindows ? 0 : isMac ? 1 : 2;

/**
 * CSS em ÷ ASS Fontsize(CAPTION_FONT_FAMILIES 순). libass는 Fontsize를 em이 아니라 글꼴의 OS/2 winAscent+winDescent
 * 높이에 맞춘다 — 같은 숫자를 CSS font-size로 쓰면 미리보기가 번인보다 크다(설계 9절 67). 값 = unitsPerEm ÷
 * (winAscent + winDescent), GDI+ 실측(2026-09-22): Malgun Gothic 2048/(2229+495), Noto Sans CJK KR(Noto Sans KR과
 * 같은 메트릭) 1000/(1160+288). Apple SD Gothic Neo는 미실측이라 Malgun 값을 빌린다.
 */
const CAPTION_FONT_EM_RATIO = [0.752, 0.752, 0.691] as const;

/** 아주 작은 창에서도 읽히는 글자 크기 하한(px) — 밑돌면 글자·줄 간격·테두리·박스를 같은 비율로 키운다. */
const CAPTION_MIN_FONT_PX = 12;

/** 미리보기 오버레이 배치(px). 좌표 기준은 영상 표시 영역 = 번인의 출력 프레임(PlayRes)이다. */
export interface CaptionOverlayLayout {
  fontFamily: string;
  fontSize: number;
  /** = ASS Fontsize — libass는 여러 줄을 Fontsize 간격으로 쌓는다. */
  lineHeight: number;
  /** 표시 영역 아래 → 자막 상자 아래. ASS MarginV는 글자 아래까지라 박스 여백만큼 내린다. */
  bottom: number;
  /** 좌우 여백(MarginL/R)을 뺀 글줄 폭. */
  maxWidth: number;
  /** 글자 테두리 두께, 0 = 없음. */
  outline: number;
  /** 박스 여백, 0 = 박스 없음(BorderStyle 1). */
  boxPad: number;
  /** 박스 불투명도 0~1. */
  boxOpacity: number;
}

/** 번인 ASS(Rust `build_ass`)와 같은 값 표·같은 기준으로 오버레이 CSS 값을 만든다. 크롭·해상도 축소는 반영하지 않는다
 *  — 값이 출력 크기 비율이라 해상도 축소는 결과가 같지만, 크롭하면 번인 글자는 크롭 영역 기준이라 원본 프레임 위의
 *  미리보기보다 작게 그려진다. */
export function captionOverlayLayout(
  preset: CaptionStylePreset,
  boxW: number,
  boxH: number,
  font: number = CAPTION_OS_FONT,
): CaptionOverlayLayout {
  const st = CAPTION_STYLE_PRESETS[preset];
  const pm = (v: number, of: number) => (v * of) / 1000;
  const line = pm(st.size, boxH);
  const em = line * CAPTION_FONT_EM_RATIO[font];
  const k = em > 0 && em < CAPTION_MIN_FONT_PX ? CAPTION_MIN_FONT_PX / em : 1;
  const boxPad = pm(st.box, boxH) * k;
  return {
    fontFamily: [CAPTION_FONT_FAMILIES[font], ...CAPTION_FONT_FAMILIES.filter((_, i) => i !== font)]
      .map((f) => `"${f}"`)
      .concat("sans-serif")
      .join(", "),
    fontSize: em * k,
    lineHeight: line * k,
    bottom: Math.max(0, pm(st.marginV, boxH) - boxPad),
    maxWidth: Math.max(0, boxW - 2 * pm(st.marginH, boxW)),
    outline: pm(st.outline, boxH) * k,
    boxPad,
    boxOpacity: st.boxOpacity / 100,
  };
}
