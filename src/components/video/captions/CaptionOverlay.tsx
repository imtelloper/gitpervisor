// 자막 미리보기(태스크 72 §3.5) — 스테이지(영상 표시 영역과 1:1로 겹치는 relative 상자) 안의 absolute div.
//
// <track>·blob·data URI·캔버스를 쓰지 않는 이유: CSP media-src에 blob:/data:가 없고, 프리뷰 서버는 CORS를
// 열지 않는다(설계 결정 5). HLS는 자막 스트림을 버린다. 확대(F)는 같은 상자라 그대로 따라간다.
// 크기·위치·테두리·박스는 번인 ASS와 같은 값 표(src/lib/captionStyle.ts)에서 온다 — 완전히 같지는 않다(§6: 테두리는
// text-shadow 근사, 줄 나눔은 브라우저 규칙). 색(흰 글자·검정 테두리·박스)은 테마가 아니라 번인 결과의 색이다.
import { memo, useEffect, useRef, useState } from "react";

import { captionOverlayLayout } from "../../../lib/captionStyle";
import type { CaptionStylePreset } from "../../../lib/ipc";

/** ASS 테두리 근사 — 8방향 그림자(대각선은 반지름에 맞춰 1/√2). */
function outlineShadow(px: number): string {
  const d = px.toFixed(1);
  const g = (px * Math.SQRT1_2).toFixed(1);
  return [`${d}px 0`, `-${d}px 0`, `0 ${d}px`, `0 -${d}px`, `${g}px ${g}px`, `-${g}px ${g}px`, `${g}px -${g}px`, `-${g}px -${g}px`]
    .map((o) => `${o} 0 #000`)
    .join(", ");
}

/** memo + text·preset만 — 부모 VideoPlayer가 재생 중 매 프레임 다시 그려도 자막이 바뀔 때만 그린다. */
export const CaptionOverlay = memo(function CaptionOverlay({
  text,
  preset,
}: {
  text: string | null;
  preset: CaptionStylePreset;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const l = captionOverlayLayout(preset, box.w, box.h);
  return (
    <div
      ref={ref}
      data-gpv="caption-overlay"
      data-preset={preset}
      className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
      style={{ bottom: l.bottom }}
    >
      {text && (
        <div
          data-gpv="caption-overlay-text"
          className="whitespace-pre-line text-center text-white"
          style={{
            fontFamily: l.fontFamily,
            fontSize: l.fontSize,
            lineHeight: `${l.lineHeight}px`,
            maxWidth: l.maxWidth,
            padding: l.boxPad || undefined,
            background: l.boxPad ? `rgba(0, 0, 0, ${l.boxOpacity})` : undefined,
            textShadow: l.outline ? outlineShadow(l.outline) : undefined,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
});
