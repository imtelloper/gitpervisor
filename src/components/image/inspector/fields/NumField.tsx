// 인스펙터 숫자 필드 — 타이핑·라벨 스크럽·방향키가 **각각 히스토리 1칸**인 곳.
//
// 이 파일이 지키는 것은 모양이 아니라 세 상태다. `value` 가 값 하나면 그 값을, `MIXED` 면
// 빈 칸을, `undefined` 면 **필드 자체를 그리지 않는다**(그 속성을 가진 노드가 선택에 없다).
// 셋을 뭉치면 "0"·"값 없음"·"여러 값"이 같은 빈 칸이 되고, 사용자가 그 칸을 건드리는 순간
// 선택 전체가 자기가 모르던 값으로 덮인다.
//
// MIXED 에서 스크럽·방향키가 절대값이 아니라 **Δ 를 내보내는** 것도 같은 이유다. 반경 4/8 을
// 골라 두고 ↑ 를 한 번 누르면 둘 다 5 가 돼 두 값의 차이가 되돌릴 수 없이 사라진다. 타이핑만
// 절대값이다 — 숫자를 직접 적은 것은 "전부 이 값으로"라고 말한 것이다.
//
// 히스토리 규칙(45 §3.4): 타이핑은 Enter/blur 에 커밋 1칸, 스크럽은 틱마다 `onLive`·뗄 때
// `onLiveEnd` 로 드래그 전체가 1칸, 방향키는 keydown 1회가 1칸이다. `e.repeat` 를 버리는
// 이유는 성능이 아니다 — 화살표를 누르고 있으면 초당 30칸이 쌓여 그 앞의 작업이 되돌리기
// 히스토리(41 상한 200) 밖으로 밀려난다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.4

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { MIXED, type Maybe } from "../../../../lib/annotate/selection";

export interface NumFieldProps {
  label: string;
  /** `undefined` = 선택에 이 속성이 없다 → 필드를 그리지 않는다. */
  value: Maybe<number> | undefined;
  /** 표시 전용 접미. 값에 섞지 않는다 — 섞으면 되읽을 때 파싱해야 한다. */
  unit?: "px" | "%" | "°";
  min?: number;
  max?: number;
  /** 방향키 한 번·스크럽 1px 의 크기. 기본 1. */
  step?: number;
  onCommit(v: number): void;
  /** 스크럽 틱(절대값). 없으면 단일값 스크럽이 꺼진다 — 매 틱 커밋할 수는 없다. */
  onLive?(v: number): void;
  /** 스크럽 종료 — 다음 변경이 새 히스토리 칸이 된다. */
  onLiveEnd?(): void;
  /**
   * MIXED 상대 델타. `d` 는 **직전 호출 이후의 증분**이다(드래그 시작 기준 누적이 아니다) —
   * 호출자는 드래그 시작 시점 스냅샷 없이 지금 문서 값에 그대로 더하면 된다. 누적으로 주면
   * `patchLive` 가 문서를 이미 옮겨 놓은 뒤라 같은 이동이 두 번 걸린다.
   */
  onDelta?(d: number, live: boolean): void;
}

/** 부동소수 꼬리를 자른다 — 회전 뒤 각도가 `45.00000000000001` 로 보이는 것을 막는다. */
function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** `q` 격자에 맞춘 뒤 소수 셋째 자리에서 끊는다(Alt 미세 조정의 0.1 격자에서 dust 가 남는다). */
function quantize(x: number, q: number): number {
  return Math.round((Math.round(x / q) * q) * 1000) / 1000;
}

export function NumField({
  label,
  value,
  unit,
  min,
  max,
  step = 1,
  onCommit,
  onLive,
  onLiveEnd,
  onDelta,
}: NumFieldProps) {
  // 타이핑 중인 원문. `null` 이면 prop 값을 그대로 보여 준다 — 사본을 항상 들면 스크럽·
  // 되돌리기로 바깥에서 값이 바뀌어도 필드가 옛 숫자를 계속 보여 준다.
  const [draft, setDraft] = useState<string | null>(null);
  const drag = useRef<{
    x: number;
    /**
     * 드래그 **시작 시점** 값. 매 틱 `value` prop 을 다시 읽으면 안 된다 — `onLive` 로
     * 문서가 이미 그만큼 움직인 뒤라 다음 틱에서 같은 이동이 한 번 더 더해진다.
     */
    base: number;
    /** 누적 이동(단위). px 가 아니라 단위로 쌓아 Shift/Alt 배율 변경이 소급되지 않게 한다. */
    acc: number;
    /** 지금까지 내보낸 값(단일값) 또는 델타 합(MIXED). 중복 발행을 막는다. */
    emitted: number;
    sent: boolean;
  } | null>(null);

  // 훅 뒤의 조기 반환이다 — 순서는 고정이고, 필드가 사라졌다 나타나도 draft 는 유지된다.
  if (value === undefined) return null;

  const mixed = value === MIXED;
  const num = mixed ? null : (value as number);
  const clamp = (v: number) =>
    Math.min(Math.max(v, min ?? -Infinity), max ?? Infinity);

  /** 스크럽이 성립하는가 — MIXED 는 델타 콜백이, 단일값은 라이브 콜백이 있어야 한다. */
  const scrubbable = mixed ? !!onDelta : !!onLive;

  const commitDraft = () => {
    const raw = draft;
    setDraft(null);
    if (raw === null) return;
    const n = Number(raw.trim());
    // 빈 칸·문자는 **원복**이다. 0 으로 읽으면 MIXED 필드를 눌렀다 지운 것만으로 선택 전체가 0 이 된다.
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    const next = clamp(n);
    if (!mixed && next === num) return;
    onCommit(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitDraft();
      return;
    }
    if (e.key === "Escape") {
      // 편집기 Esc 계층까지 가지 않는다 — 42 캡처 리스너가 입력 포커스를 통과시키므로
      // 이 필드가 처리하지 않으면 Esc 가 아무 일도 하지 않는다.
      e.preventDefault();
      setDraft(null);
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (e.repeat) return;

    const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
    // 타이핑하던 숫자가 있으면 그 값이 기준이다 — 화면에 보이는 수와 다른 수가 오르내리면
    // 사용자는 필드가 자기 입력을 버렸다는 것을 알 수 없다.
    const typed = draft === null || draft.trim() === "" ? NaN : Number(draft);
    const base = Number.isFinite(typed) ? typed : num;
    setDraft(null);
    if (base === null) onDelta?.(d, false);
    else onCommit(clamp(base + d));
  };

  const onScrubDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0 || !scrubbable) return;
    e.preventDefault(); // 드래그 중 텍스트 선택 차단
    e.currentTarget.setPointerCapture(e.pointerId);
    const base = num ?? 0;
    drag.current = { x: e.clientX, base, acc: 0, emitted: mixed ? 0 : base, sent: false };
  };

  const onScrubMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const g = drag.current;
    if (!g) return;
    // 배율은 이번 구간에만 적용한다. 전체 이동에 곱하면 드래그 도중 Shift 를 누른 순간
    // 값이 지나온 거리만큼 튄다.
    const q = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    g.acc += (e.clientX - g.x) * q;
    g.x = e.clientX;
    if (mixed) {
      const total = quantize(g.acc, q);
      if (total === g.emitted) return;
      onDelta?.(total - g.emitted, true);
      g.emitted = total;
    } else {
      // 시작값은 그대로 두고 **이동분만** 격자에 맞춘다 — 총합을 맞추면 45.5 에서 스크럽을
      // 시작하는 순간 손이 움직인 적 없는 0.5 만큼이 먼저 튄다.
      const next = clamp(g.base + quantize(g.acc, q));
      if (next === g.emitted) return;
      onLive?.(next);
      g.emitted = next;
    }
    g.sent = true;
  };

  const onScrubUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    // 움직이지 않은 클릭에는 endLive 를 보내지 않는다 — 라이브 구간이 없었는데 봉인하면
    // 그 다음 편집이 앞 히스토리 칸에 붙는다.
    if (g.sent) onLiveEnd?.();
  };

  return (
    <div className="flex h-7 items-center gap-1.5">
      <span
        // 라벨 자체가 스크럽 손잡이다(시안 ①). 화면에 이미 보이는 글자라 입력에는
        // `aria-label` 로 같은 이름을 주고 여기는 접근성 트리에서 뺀다.
        aria-hidden
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
        className={`w-11 shrink-0 select-none truncate text-[11px] text-fg-dim ${
          scrubbable ? "cursor-ew-resize touch-none hover:text-fg" : ""
        }`}
      >
        {label}
      </span>

      <div className="relative min-w-0 flex-1">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          value={draft ?? (mixed ? "" : fmt(num as number))}
          placeholder={mixed ? "혼합" : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commitDraft}
          className={`w-full rounded border border-edge bg-raised py-1 pl-1.5 font-mono text-[12px] outline-none placeholder:text-fg-dim focus:border-accent ${
            unit ? "pr-6" : "pr-1.5"
          }`}
        />
        {unit && (
          <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-fg-dim">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
