// 인스펙터 조정 탭의 **크롭 섹션**(시안 ⑦) — 세션 밖에서는 진입 버튼 하나, 세션 안에서는
// 각도 · W/H/X/Y · 오버레이 · 두 토글.
//
// 세션 밖 버튼 문구 `크롭 선택` 과 세션 안 `영역을 드래그` 는 **바꾸지 마라.** e2e 30 이
// `textContent + title` 을 정규식으로 훑어 이 두 문자열로 크롭 모드의 켜짐/꺼짐을 판정한다
// (`A.cropOn`, 30:473 · `click(/크롭 선택/)`, 30:1313). 세션 안 버튼이 모드 해제를 겸하는 것도
// 그 계약(누르면 토글)을 그대로 승계한 것이다.
//
// 값은 전부 `api.cropSet` 을 지난다 — 세션 문서는 `replace` 로만 갱신되므로 여기서 몇 번을
// 만져도 히스토리는 0칸이고, 커밋은 컨텍스트 바의 '적용' 한 번뿐이다(48 §3.1).
//
// 배경: DOCS/task/48-image-crop-straighten.md §3.4·§3.6 · 시안 ⑦ 조정 탭 크롭 섹션

import type { ReactNode } from "react";
import { Crop } from "lucide-react";

import {
  CROP_ASPECTS,
  CROP_OVERLAYS,
  MAX_STRAIGHTEN_DEG,
  type CropAspect,
  type CropSession,
} from "../../lib/annotate/crop";
import type { EditorDoc } from "../../lib/annotate/types";
import { NumField } from "./inspector/fields/NumField";
import { Toggle } from "./inspector/fields/Toggle";
import type { CropApi } from "./useCropSession";

/** 이 각을 넘으면 훅이 `constrainToImage` 를 강제로 켠다(crop 세션과 같은 값, §3.6). */
const FORCE_CONSTRAIN_DEG = 15;

/** `crop.ts` 의 비공개 `aspectLabelOf` 와 같은 표다 — 한쪽을 고치면 다른 쪽도 고쳐라. */
function aspectLabel(a: CropAspect): string {
  if (typeof a === "object") return `${a.w}:${a.h}`;
  return CROP_ASPECTS.find((x) => x.id === a)?.label ?? String(a);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-3 border-b border-edge/60 pb-3 last:border-0">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-dim">
        {title}
      </div>
      {children}
    </div>
  );
}

export function CropInspectorSection({
  session,
  api,
  doc,
  onEnter,
  onClear,
}: {
  session: CropSession | null;
  api: CropApi;
  doc: EditorDoc;
  /** 크롭 모드 진입(42 `setMode({kind:'crop'})`). */
  onEnter(): void;
  /** 이미 적용된 크롭 해제 — 세션과 무관한 문서 조작이라 호출자(ImageEditor)가 든다. */
  onClear(): void;
}) {
  if (!session) {
    return (
      <Section title="크롭">
        <div className="flex items-center gap-1.5">
          <button
            title="크롭 (C)"
            onClick={onEnter}
            className="flex items-center gap-1 rounded bg-raised px-2 py-1 text-fg-muted hover:text-fg"
          >
            <Crop size={14} />
            크롭 선택
          </button>
          {doc.crop && (
            <button
              onClick={onClear}
              className="rounded px-2 py-1 text-fg-dim hover:bg-raised hover:text-fg"
            >
              해제
            </button>
          )}
        </div>
        {doc.crop && (
          <div className="mt-1.5 font-mono text-[11px] text-fg-dim">
            {Math.round(doc.crop.w)} × {Math.round(doc.crop.h)} px
          </div>
        )}
      </Section>
    );
  }

  const { rect } = session;
  const forced = Math.abs(session.straighten) > FORCE_CONSTRAIN_DEG;

  return (
    <Section title="크롭">
      <div className="mb-1.5 flex items-center gap-1.5">
        <button
          title="크롭 모드 — 다시 누르면 취소"
          onClick={api.cropCancel}
          className="flex items-center gap-1 rounded bg-accent/20 px-2 py-1 text-accent"
        >
          <Crop size={14} />
          영역을 드래그
        </button>
        {/* 아직 문서에 반영되지 않았다는 표시. 이 배지가 없으면 사용자는 값을 만진 것만으로
            저장까지 된 줄 알고 창을 닫는다. */}
        <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] text-fg-dim">적용 전</span>
        <span className="text-[11px] text-fg-muted">
          {aspectLabel(session.aspect)} {rect.w >= rect.h ? "가로" : "세로"}
        </span>
      </div>

      <NumField
        label="각도"
        value={session.straighten}
        unit="°"
        min={-MAX_STRAIGHTEN_DEG}
        max={MAX_STRAIGHTEN_DEG}
        step={0.1}
        onCommit={(v) => api.cropSet({ straighten: v })}
        // 스크럽 틱마다 세션 문서를 replace 한다 — 커밋이 아니라 봉인(`onLiveEnd`)이 필요 없다.
        onLive={(v) => api.cropSet({ straighten: v })}
      />
      <div className="grid grid-cols-2 gap-x-2">
        <NumField
          label="W"
          value={rect.w}
          unit="px"
          min={1}
          onCommit={(v) => api.cropSet({ rect: { ...rect, w: v } })}
        />
        <NumField
          label="H"
          value={rect.h}
          unit="px"
          min={1}
          onCommit={(v) => api.cropSet({ rect: { ...rect, h: v } })}
        />
        <NumField
          label="X"
          value={rect.x}
          unit="px"
          onCommit={(v) => api.cropSet({ rect: { ...rect, x: v } })}
        />
        <NumField
          label="Y"
          value={rect.y}
          unit="px"
          onCommit={(v) => api.cropSet({ rect: { ...rect, y: v } })}
        />
      </div>

      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {CROP_OVERLAYS.filter((o) => o.id !== "none").map((o) => (
          <button
            key={o.id}
            aria-pressed={session.overlay === o.id}
            onClick={() =>
              api.cropSet({ overlay: session.overlay === o.id ? "none" : o.id })
            }
            className={`rounded px-1 py-1 text-[11px] ${
              session.overlay === o.id
                ? "bg-accent/20 text-accent"
                : "bg-raised text-fg-muted hover:text-fg"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <Toggle
        checked={session.deleteOutside}
        label="크롭 영역 밖 삭제"
        onChange={(v) => api.cropSet({ deleteOutside: v })}
      />
      {/* 되돌릴 수 없는 동작은 **켠 순간** 보여야 한다 — 적용하고 나서야 알면 그 커밋 하나를
          통째로 되돌리는 것 말고는 방법이 없다. */}
      {session.deleteOutside && (
        <div className="mb-1 text-[11px] text-warn">
          적용하면 크롭과 겹치지 않는 주석이 함께 지워집니다
        </div>
      )}

      <Toggle
        checked={session.constrainToImage}
        label="이미지 안으로 제한"
        onChange={(v) => api.cropSet({ constrainToImage: v })}
      />
      <div className="text-[11px] text-fg-dim">
        {forced
          ? `직선화 ${FORCE_CONSTRAIN_DEG}°를 넘으면 항상 켜집니다`
          : "끄면 이미지 밖은 투명으로 저장됩니다"}
      </div>
    </Section>
  );
}
