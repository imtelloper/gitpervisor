// 플레이어 하단 상태 바 — 좌: 상태 점 + 라벨, 중: 라벨·값 쌍, 우: 단축키 칩, 끝: 확대율.
// 표시 전용이라 값 계산은 전부 부모 몫이다(문자열로 받는다).
import { memo } from "react";

type Tone = "ok" | "warn" | "danger";

export interface StatusItem {
  label: string;
  value: string;
  tone?: Tone;
}

export interface StatusShortcut {
  /** 칩에 그대로 찍히는 키 표기 — "Space", "I / O" 처럼 이미 조립된 문자열. */
  keys: string;
  label: string;
}

const TONE: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
};

const DOT: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
};

export const PlayerStatusBar = memo(function PlayerStatusBar({
  status,
  items,
  shortcuts,
  zoomPct,
}: {
  status: { text: string; tone: Tone };
  items: StatusItem[];
  shortcuts: StatusShortcut[];
  /** 타임라인 확대율(%) — 140 → "확대 140%". */
  zoomPct: number;
}) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-edge bg-panel px-3 text-[11px] text-fg-dim">
      <span className="flex shrink-0 items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} aria-hidden />
        <span className={TONE[status.tone]}>{status.text}</span>
      </span>

      <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        {items.map((it) => (
          <span key={it.label} className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <span>{it.label}</span>
            <span className={it.tone ? TONE[it.tone] : "text-fg-muted"}>{it.value}</span>
          </span>
        ))}
      </span>

      {shortcuts.map((s) => (
        <span key={s.keys} className="hidden shrink-0 items-center gap-1 whitespace-nowrap md:flex">
          <kbd className="rounded border border-edge bg-raised px-1 font-mono text-[10px] text-fg-muted">
            {s.keys}
          </kbd>
          <span>{s.label}</span>
        </span>
      ))}

      <span className="shrink-0 whitespace-nowrap">확대 {Math.round(zoomPct)}%</span>
    </div>
  );
});
