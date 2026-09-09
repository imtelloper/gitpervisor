// 인스펙터 **조정** 탭 — 이미지 전체에 걸리는 것만 모은 자리(시안 ⑦).
//
// 다른 탭이 "선택 대상"을 다루는데 여기만 이미지 전체를 다룬다. 그래서 맨 위 캡션이
// `이미지 전체에 적용` 이다 — 없으면 사용자는 도형 하나를 골라 둔 채 `오른쪽 90°` 를 눌러
// 그 도형만 돌아갈 것으로 읽는다.
//
// `변형 · 색 보정 · 출력 크기` 는 시안 ⑦ 에 **없는** 섹션이다. v1 우측 패널의 기능이라
// 빼면 그대로 후퇴이고(그리고 e2e 30 (b)(c)·`A.ready` 의 `outW>0` 이 그 위에 서 있다)
// 시안에 새로 그려진 자리도 없어서 여기에 남긴다(45 §3.3).
//
// **버튼 문구를 바꾸지 마라.** e2e 30 은 `A.btn` 이 `textContent + ' ' + title` 을 정규식으로
// 훑어 버튼을 찾는다: `/오른쪽 90/`(30:843)·`/크롭 선택/`(30:1313)·`/영역을 드래그/`(30:473).
// 뒤 둘은 이제 `cropSection` 슬롯(48 `CropInspectorSection`)이 그리지만 계약은 그대로다.
// 특히 회전은 **속성 탭이 열려 있는 상태에서** 눌린다 — 인스펙터가 네 탭을 전부 마운트하고
// 숨기기만 하는 이유가 이것이다(조건부 마운트면 그 클릭이 갈 곳이 없다).
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.3

import type { ReactNode } from "react";
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw } from "lucide-react";

import type { EditorDoc } from "../../../lib/annotate/types";
import { useImageEditorUi } from "../../../stores/imageEditor";
import { SnapSection } from "../SnapSection";

/** 이 탭이 읽는 문서 필드만. 문서 전체를 받으면 주석 하나만 바뀌어도 여기가 다시 그려진다. */
type AdjustDoc = Pick<
  EditorDoc,
  "outW" | "outH" | "brightness" | "contrast" | "saturate" | "flipH" | "flipV"
>;

export interface AdjustTabProps {
  doc: AdjustDoc;
  /** 색 보정 라이브 틱 — `patchLive`(첫 틱만 commit, 이후 replace)로 드래그 1회 = 1칸. */
  onPatch(patch: Partial<EditorDoc>, live?: boolean): void;
  onEditEnd(): void;
  /**
   * 크롭 섹션(48 `CropInspectorSection`) — **노드로 받는다.** 세션·`CropApi`·문서 전체를
   * 알아야 그릴 수 있는데, 이 탭은 셋 다 필요 없다. 소유자(ImageEditor)가 만들어 꽂는 편이
   * prop 4개를 여기로 끌고 오는 것보다 짧다(`Inspector` 의 `panes`·`footer` 와 같은 관례).
   */
  cropSection: ReactNode;
  /** 이미지 전체 회전 — v1 `rotateBy`. */
  onRotateImage(plus90: boolean): void;
  /** 이미지 전체 반전 — v1 `flipBy`. */
  onFlipImage(axis: "h" | "v"): void;
  /** 출력 폭/높이 — 비율 잠금 계산이 크롭 크기를 알아야 해서 호출자(v1 changeW/changeH)가 한다. */
  onOutW(v: number): void;
  onOutH(v: number): void;
  lockRatio: boolean;
  onLockRatio(v: boolean): void;
}

const PIXEL_PREVIEW: { v: 0 | 1 | 2; label: string }[] = [
  { v: 0, label: "끄기" },
  { v: 1, label: "1x" },
  { v: 2, label: "2x" },
];

export function AdjustTab({
  doc,
  onPatch,
  onEditEnd,
  cropSection,
  onRotateImage,
  onFlipImage,
  onOutW,
  onOutH,
  lockRatio,
  onLockRatio,
}: AdjustTabProps) {
  const pixelPreview = useImageEditorUi((s) => s.pixelPreview);
  const setPixelPreview = useImageEditorUi((s) => s.setPixelPreview);

  return (
    <div>
      <div className="mb-2 text-[11px] text-fg-dim">이미지 전체에 적용</div>

      <Section title="회전 · 반전">
        <div className="grid grid-cols-4 gap-1.5">
          <IconBtn title="왼쪽 90°" onClick={() => onRotateImage(false)}>
            <RotateCcw size={15} />
          </IconBtn>
          <IconBtn title="오른쪽 90°" onClick={() => onRotateImage(true)}>
            <RotateCw size={15} />
          </IconBtn>
          <IconBtn title="좌우 반전" active={doc.flipH} onClick={() => onFlipImage("h")}>
            <FlipHorizontal size={15} />
          </IconBtn>
          <IconBtn title="상하 반전" active={doc.flipV} onClick={() => onFlipImage("v")}>
            <FlipVertical size={15} />
          </IconBtn>
        </div>
      </Section>

      {cropSection}

      {/* 스냅·가이드(시안 ⑦) — 값은 42 스토어에 있어 상태바 토글과 한 몸이다. 제목을 스스로
          그리므로 `Section` 으로 감싸지 않는다(제목이 두 줄 된다). */}
      <div className="mb-3 border-b border-edge/60 pb-3">
        <SnapSection />
      </div>

      <Section title="픽셀 미리보기">
        <div className="grid grid-cols-3 gap-1.5">
          {PIXEL_PREVIEW.map((p) => (
            <button
              key={p.v}
              onClick={() => setPixelPreview(p.v)}
              className={`rounded px-2 py-1 text-[12px] ${
                pixelPreview === p.v
                  ? "bg-accent text-on-accent"
                  : "bg-raised text-fg-muted hover:text-fg"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="색 보정">
        <Slider
          label="밝기"
          value={doc.brightness}
          onChange={(v) => onPatch({ brightness: v }, true)}
          onEnd={onEditEnd}
        />
        <Slider
          label="대비"
          value={doc.contrast}
          onChange={(v) => onPatch({ contrast: v }, true)}
          onEnd={onEditEnd}
        />
        <Slider
          label="채도"
          value={doc.saturate}
          onChange={(v) => onPatch({ saturate: v }, true)}
          onEnd={onEditEnd}
        />
      </Section>

      <Section title="크기">
        <div className="flex items-center gap-1.5">
          <NumInput value={doc.outW} onChange={onOutW} onEnd={onEditEnd} />
          <span className="text-fg-dim">×</span>
          <NumInput value={doc.outH} onChange={onOutH} onEnd={onEditEnd} />
          <button
            onClick={() => onLockRatio(!lockRatio)}
            title="비율 고정"
            className={`rounded px-2 py-1 text-[11px] ${
              lockRatio ? "bg-accent/20 text-accent" : "bg-raised text-fg-dim hover:text-fg"
            }`}
          >
            {lockRatio ? "비율 ✓" : "비율"}
          </button>
        </div>
      </Section>
    </div>
  );
}

// ── 조각(v1 우측 패널에서 그대로 옮겨 온 모양) ───────────────────────────────

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3 border-b border-edge/60 pb-3 last:border-0">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
        {title}
      </div>
      {children}
    </div>
  );
}

function IconBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex items-center justify-center rounded py-1.5 ${
        active ? "bg-accent/20 text-accent" : "bg-raised text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 0–200% 슬라이더. `onPointerUp`/`onKeyUp` 에 `onEnd` 를 부르는 것이 히스토리 규칙이다 —
 * 빼면 드래그 한 번이 수십 칸을 쌓아 그 앞의 편집이 되돌리기 상한 밖으로 밀려난다.
 */
export function Slider({
  label,
  value,
  onChange,
  onEnd,
  min = 0,
  max = 200,
}: {
  label: string;
  value: number;
  onChange(v: number): void;
  onEnd?(): void;
  min?: number;
  max?: number;
}) {
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-[11px] text-fg-dim">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        className="w-full accent-accent"
      />
    </div>
  );
}

function NumInput({
  value,
  onChange,
  onEnd,
}: {
  value: number;
  onChange(v: number): void;
  onEnd?(): void;
}) {
  return (
    <input
      type="number"
      min={1}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      onBlur={onEnd}
      className="w-16 rounded border border-edge bg-raised px-1.5 py-1 text-center font-mono text-[12px] outline-none focus:border-accent"
    />
  );
}
