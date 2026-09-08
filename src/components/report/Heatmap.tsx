import { useMemo } from "react";

import { parseYmd, today } from "../../lib/report";

/** 하루치 값 — 두 시리즈를 합쳐 색을, 나눠서 툴팁을 만든다. */
export interface DayValue {
  commits: number;
  prompts: number;
}

/**
 * 5단계 시퀀셜 램프(0 · 1-2 · 3-5 · 6-10 · 11+). **한 색상(accent) 명도 단계**라
 * dataviz의 시퀀셜 규칙(one hue, light→dark)을 만족한다 — 무지개도, 두 번째 색상도 없다.
 *
 * 색은 `color-mix(in oklch, var(--color-accent) L%, var(--color-panel))`로 만든다:
 * 테마 6종 + 사용자 커스텀 테마가 accent·panel만 바꾸면 램프가 통째로 따라오고, 단조성
 * (0%→100%로 갈수록 배경에서 멀어짐)이 보간의 성질로 **구성상 보장**된다. 다크/라이트를
 * 각각 손으로 고르지 않아도 되는 이유다(0단계는 표면색 그대로 — 시퀀셜에서 최저값이
 * 표면으로 물러나는 것은 허용된다).
 */
const MIX = [0, 25, 50, 75, 100];

export function levelOf(total: number): number {
  if (total <= 0) return 0;
  if (total <= 2) return 1;
  if (total <= 5) return 2;
  if (total <= 10) return 3;
  return 4;
}

const CELL = 12;
const GAP = 3;
/** 요일 라벨(월요일 시작 — 한국 관례). 월·수·금만 적어 라벨이 셀을 압도하지 않게 한다. */
const WEEKDAYS = ["월", "", "수", "", "금", "", ""];

const cellColor = (level: number) =>
  `color-mix(in oklch, var(--color-accent) ${MIX[level]}%, var(--color-panel))`;

/** "9월 3일 · 커밋 4 · 프롬프트 12" — 네이티브 title이 곧 접근 가능한 이름이다. */
function cellTitle(day: string, v: DayValue): string {
  const d = parseYmd(day);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 · 커밋 ${v.commits} · 프롬프트 ${v.prompts}`;
}

/**
 * 활동 히트맵(잔디) — 열=주(월요일 시작), 행=요일. 클릭하면 그 날이 기준일이 된다.
 *
 * `days`는 오래된 → 최신 순의 `YYYY-MM-DD` 목록이다. 첫 주의 월요일부터 첫 날 전까지는
 * **자리만 채우는 빈 칸**을 그린다(`data-day` 없음) — 그래야 `[data-day]` 개수가 정확히
 * 기간 일수와 같다.
 */
export function Heatmap({
  days,
  counts,
  selected,
  onSelect,
}: {
  days: string[];
  counts: Map<string, DayValue>;
  selected: string;
  onSelect: (day: string) => void;
}) {
  const now = today();

  // 앞쪽 빈 칸 수 = 첫 날의 요일(월=0). 열 개수는 그 합을 7로 올림한 것.
  const lead = days.length ? (parseYmd(days[0]).getDay() + 6) % 7 : 0;
  const cols = Math.ceil((lead + days.length) / 7);

  // 월 라벨 — 열의 첫 칸이 달의 첫 주에 해당하면 그 열 위에 적는다.
  const months = useMemo(() => {
    const out: (string | null)[] = Array.from({ length: cols }, () => null);
    let prev = -1;
    days.forEach((day, i) => {
      const col = Math.floor((lead + i) / 7);
      const m = parseYmd(day).getMonth();
      if (m !== prev) {
        prev = m;
        if (out[col] === null) out[col] = `${m + 1}월`;
      }
    });
    return out;
  }, [days, lead, cols]);

  const track = { gap: `${GAP}px` } as const;

  return (
    <div className="overflow-x-auto">
      <div className="flex w-max gap-1.5">
        {/* 좌: 요일 라벨 */}
        <div
          className="grid pt-[14px] text-[9px] leading-none text-fg-dim"
          style={{ ...track, gridTemplateRows: `repeat(7, ${CELL}px)` }}
        >
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="flex items-center">
              {w}
            </span>
          ))}
        </div>

        <div>
          {/* 상: 월 라벨 */}
          <div
            className="grid h-[14px] text-[9px] leading-none text-fg-dim"
            style={{ ...track, gridTemplateColumns: `repeat(${cols}, ${CELL}px)` }}
          >
            {months.map((m, i) => (
              <span key={i} className="whitespace-nowrap">
                {m}
              </span>
            ))}
          </div>

          {/* 격자 — 열 방향으로 채운다(한 열 = 한 주). */}
          <div
            className="grid"
            style={{
              ...track,
              gridAutoFlow: "column",
              gridTemplateRows: `repeat(7, ${CELL}px)`,
              gridAutoColumns: `${CELL}px`,
            }}
          >
            {Array.from({ length: lead }, (_, i) => (
              <div key={`lead-${i}`} aria-hidden />
            ))}
            {days.map((day) => {
              const v = counts.get(day) ?? { commits: 0, prompts: 0 };
              const level = levelOf(v.commits + v.prompts);
              return (
                <button
                  key={day}
                  type="button"
                  data-day={day}
                  data-level={level}
                  data-selected={day === selected ? "1" : undefined}
                  title={cellTitle(day, v)}
                  onClick={() => onSelect(day)}
                  style={{ background: cellColor(level) }}
                  className={`rounded-[2px] ${
                    day === now
                      ? "ring-1 ring-accent"
                      : day === selected
                        ? "ring-1 ring-fg-muted"
                        : ""
                  }`}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* 범례 — 시퀀셜 램프는 값의 크기를 색으로만 말하므로 눈금이 반드시 함께 간다. */}
      <div className="mt-2 flex items-center gap-1 text-[10px] text-fg-dim">
        <span>적음</span>
        {MIX.map((_, i) => (
          <span
            key={i}
            style={{ background: cellColor(i), width: CELL, height: CELL }}
            className="inline-block rounded-[2px]"
          />
        ))}
        <span>많음</span>
        <span className="ml-2">칸 = 하루(커밋 + 프롬프트), 클릭하면 그 날 요약으로</span>
      </div>
    </div>
  );
}
