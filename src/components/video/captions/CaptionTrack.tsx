// 타임라인 S1 자막 트랙의 블록 층(태스크 72 §3.5) — cue 블록 + 편집본에서 빠지는 구간 빗금.
//
// Timeline은 재생 중 매 프레임 다시 그린다(time을 props로 받는다). 1시간 영상이면 cue가 1,000개쯤이라, 블록 층을
// memo로 떼어 줌·팬(vs/ve)·폭·문서가 바뀔 때만 그린다 — 플레이헤드 선은 Timeline 쪽에 둔다.
// 시각은 **플레이어 초**다: 문서 시각 → 플레이어 시각 변환은 VideoPlayer의 docToPlayer 한 곳에서 끝내고 넘긴다.
import { memo } from "react";

export interface CaptionTrackCue {
  id: string;
  /** 플레이어 초. */
  s: number;
  e: number;
  text: string;
}

export interface CaptionTrackData {
  cues: CaptionTrackCue[];
  /** 편집본에서 빠지는 구간(플레이어 초) — plan.keep의 여집합. 컷이 없으면 빈 배열. */
  cuts: Array<{ s: number; e: number }>;
}

/** 빗금 — 테마 토큰 색을 그대로 쓴다(테마마다 danger 명도가 다르다). */
const HATCH = "repeating-linear-gradient(135deg, var(--color-danger) 0 1.5px, transparent 1.5px 5px)";

export const CaptionTrackBlocks = memo(function CaptionTrackBlocks({
  vs,
  ve,
  barW,
  cues,
  cuts,
}: {
  vs: number;
  ve: number;
  barW: number;
  cues: CaptionTrackCue[];
  cuts: CaptionTrackData["cuts"];
}) {
  if (barW <= 0) return null;
  const len = Math.max(ve - vs, 1e-6);
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - vs) / len) * 100));
  // 창 밖 블록은 그리지 않는다(Timeline visible()과 같은 컬링, 구간이라 양 끝으로 판정).
  const shown = (s: number, e: number) => e >= vs && s <= ve;
  return (
    <>
      {cues.map((c) =>
        shown(c.s, c.e) ? (
          <div
            key={c.id}
            title={c.text}
            className="absolute inset-y-0.5 overflow-hidden truncate rounded-sm border border-accent/60 bg-accent/20 px-0.5 text-[9px] leading-4 text-fg"
            style={{ left: `${pct(c.s)}%`, width: `${Math.max(0, pct(c.e) - pct(c.s))}%` }}
          >
            {c.text.replace(/\n/g, " ")}
          </div>
        ) : null,
      )}
      {cuts.map((r, i) =>
        shown(r.s, r.e) ? (
          <div
            key={i}
            className="pointer-events-none absolute inset-y-0 bg-base/40 opacity-80"
            style={{
              left: `${pct(r.s)}%`,
              width: `${Math.max(0, pct(r.e) - pct(r.s))}%`,
              backgroundImage: HATCH,
            }}
          />
        ) : null,
      )}
    </>
  );
});
