// 컨텍스트 바 '크롭' 변형(시안 ⑧) — 비율 7 · 오버레이 4 · 직선화 · 회전/반전 · 여백 자동 제거 ·
// 취소 · 적용 ⏎.
//
// **여기에 기하는 없다.** 버튼은 전부 `api`(48 `useCropSession`)를 부르고, 그 함수들은 단축키
// 표(42)의 `enter`/`esc` 가 부르는 것과 **같은 함수**다. 이 파일이 사각형을 직접 계산하기
// 시작하면 화면에 보이는 상자와 저장되는 영역이 조용히 갈라진다(crop.ts 머리말과 같은 이유).
//
// 값 변경은 전부 `cropSet` 이고, `cropSet` 은 세션 문서를 `replace` 로만 갱신한다 — 그래서
// 직선화 슬라이더를 아무리 왕복해도 히스토리는 0칸이고, 커밋은 '적용' 한 번뿐이다.
//
// 배경: DOCS/task/48-image-crop-straighten.md §3.1·§3.6 · 시안 ⑧ '크롭' 변형

import { useState, type ReactNode } from "react";
import {
  Crop,
  FlipHorizontal,
  FlipVertical,
  RotateCcw,
  RotateCw,
  Scissors,
} from "lucide-react";

import { useMessages } from "../../i18n/ui-language";
import {
  CROP_ASPECTS,
  CROP_OVERLAYS,
  MAX_STRAIGHTEN_DEG,
  type CropAspect,
  type CropSession,
} from "../../lib/annotate/crop";
import { NumField } from "./inspector/fields/NumField";
import type { CropApi } from "./useCropSession";

const BTN =
  "flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-fg-muted hover:bg-raised hover:text-fg";
const ON = "bg-accent/15 text-accent";

function Btn({
  title,
  pressed,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
      className={`${BTN} ${pressed ? ON : ""}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-edge" />;
}

/** 비율 칩이 지금 켜져 있는가. '사용자'는 값(2:3 등)이 아니라 **객체형인지**로 가른다. */
function aspectOn(cur: CropAspect, id: CropAspect): boolean {
  return typeof id === "object" ? typeof cur === "object" : cur === id;
}

export function CropContextBar({
  session,
  api,
  maxDeg,
}: {
  session: CropSession;
  api: CropApi;
  /** 이 이미지에서 허용되는 직선화 최대각(`maxStraightenFor`). 화소 상한이 큰 이미지를 막는다. */
  maxDeg: number;
}) {
  const msg = useMessages();
  const t = msg.imageEditor.cropBar;
  // 사용자 비율의 W:H — 다른 칩으로 갔다 와도 값이 남아야 한다. 세션은 '자유'로 바뀌면
  // 그 숫자를 잊으므로 여기서 든다.
  const [custom, setCustom] = useState(() =>
    typeof session.aspect === "object" ? session.aspect : { w: 2, h: 3 },
  );
  const limited = maxDeg < MAX_STRAIGHTEN_DEG;
  const customOn = typeof session.aspect === "object";

  const setCustomAspect = (w: number, h: number) => {
    const next = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
    setCustom(next);
    api.cropSet({ aspect: next });
  };

  return (
    <>
      <Crop size={14} className="shrink-0 text-fg-dim" />
      <span className="shrink-0 text-fg-muted">{msg.imageEditor.op.crop}</span>

      <Sep />
      {CROP_ASPECTS.map((a) => (
        <Btn
          key={a.label}
          title={t.aspectTitle(a.label)}
          pressed={aspectOn(session.aspect, a.id)}
          onClick={() => api.cropSet({ aspect: typeof a.id === "object" ? custom : a.id })}
        >
          {a.label}
        </Btn>
      ))}
      {customOn && (
        <>
          <div className="w-[6.5rem] shrink-0">
            <NumField
              label="W"
              value={custom.w}
              min={1}
              onCommit={(v) => setCustomAspect(v, custom.h)}
            />
          </div>
          <div className="w-[6.5rem] shrink-0">
            <NumField
              label="H"
              value={custom.h}
              min={1}
              onCommit={(v) => setCustomAspect(custom.w, v)}
            />
          </div>
        </>
      )}

      <Sep />
      {/* '없음'은 칩으로 두지 않는다 — 켜진 칩을 다시 누르면 꺼지므로 칸 하나가 더 필요 없다. */}
      {CROP_OVERLAYS.filter((o) => o.id !== "none").map((o) => (
        <Btn
          key={o.id}
          title={t.overlayTitle(o.label)}
          pressed={session.overlay === o.id}
          onClick={() =>
            api.cropSet({ overlay: session.overlay === o.id ? "none" : o.id })
          }
        >
          {o.label}
        </Btn>
      ))}

      <Sep />
      <span className="shrink-0 text-fg-dim">{t.straighten}</span>
      <input
        type="range"
        aria-label={t.straighten}
        title={limited ? t.straightenLimited(maxDeg) : t.straighten}
        min={-maxDeg}
        max={maxDeg}
        step={0.1}
        value={session.straighten}
        disabled={maxDeg <= 0}
        // 슬라이더는 세션 문서를 replace 로만 바꾼다 — 뗄 때 커밋하는 다른 슬라이더(색 보정)와
        // 달리 여기엔 `onPointerUp` 봉인이 없다. 커밋은 '적용' 한 번뿐이다(§3.1).
        onChange={(e) => api.cropSet({ straighten: Number(e.target.value) })}
        className="h-7 w-28 shrink-0 accent-accent"
      />
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-fg-muted">
        {session.straighten.toFixed(1)}°
      </span>
      {limited && (
        <span className="shrink-0 text-[11px] text-fg-dim">{t.straightenLimited(maxDeg)}</span>
      )}

      <Sep />
      <Btn title={t.rotateLeft90} onClick={() => api.cropTransform("rotCCW")}>
        <RotateCcw size={14} />
      </Btn>
      <Btn title={t.rotateRight90} onClick={() => api.cropTransform("rotCW")}>
        <RotateCw size={14} />
      </Btn>
      <Btn title={msg.imageEditor.op.flipH} onClick={() => api.cropTransform("flipH")}>
        <FlipHorizontal size={14} />
      </Btn>
      <Btn title={msg.imageEditor.op.flipV} onClick={() => api.cropTransform("flipV")}>
        <FlipVertical size={14} />
      </Btn>

      <Sep />
      <Btn title={t.autoTrimTitle} onClick={api.cropAutoTrim}>
        <Scissors size={14} />
        {t.autoTrim}
      </Btn>

      <div className="flex-1" />
      <Btn title={t.cancelTitle} onClick={api.cropCancel}>
        {t.cancel}
      </Btn>
      <button
        type="button"
        title={t.applyTitle}
        onClick={api.cropApply}
        className="flex h-7 shrink-0 items-center gap-1 rounded bg-accent px-2 text-on-accent hover:opacity-90"
      >
        {t.apply}
      </button>
    </>
  );
}
