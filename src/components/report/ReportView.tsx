import { ChevronLeft, ChevronRight, Sparkles, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { NO_COLOR, useProjectColors } from "../../lib/project-color";
import type { Period } from "../../lib/report";
import {
  addDays,
  PERIOD_LABEL,
  periodRange,
  shiftPeriod,
  today,
} from "../../lib/report";
import { useActivities, useProjects, usePromptDumps } from "../../queries";
import { useUi } from "../../stores/ui";
import type { DayValue } from "./Heatmap";
import { Heatmap } from "./Heatmap";
import { ReportCard } from "./ReportCard";

const PERIODS: Period[] = ["day", "week", "month"];
/** 히트맵 기간 — 오늘 포함 365일(설계 §3.5). */
const SPAN = 365;
const MINE_KEY = "gp:report-mine";

/**
 * 작업 리포트 전체 뷰 — 모아보기와 같은 층(모달 아님, 00-INDEX §11.3).
 *
 * 상단: 프로젝트·기간·"내 커밋만" / 중단: 잔디 / 하단: 선택 기간의 프로젝트 카드.
 * 히트맵과 카운트는 LLM 없이도 보이고, LLM이 없으면 카드의 "요약 생성"만 막힌다.
 */
export function ReportView() {
  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const projectColorsOn = useUi((s) => s.projectColorsOn);
  const colors = useProjectColors();

  // 지금 보고 있던 프로젝트로 시작한다 — "전체"는 프로젝트 수만큼 쿼리를 띄우므로 옵트인.
  const [scope, setScope] = useState<string>(selectedProjectId ?? "all");
  const [period, setPeriod] = useState<Period>("day");
  const [anchor, setAnchor] = useState(today);
  const [mine, setMine] = useState(
    () => localStorage.getItem(MINE_KEY) !== "0",
  );
  // 배치 생성 대기열(앞이 현재 차례). 59는 한 번에 한 요청이라 직렬이다.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [batchTotal, setBatchTotal] = useState(0);

  const all = useMemo(() => projects ?? [], [projects]);
  const scoped = useMemo(
    () => (scope === "all" ? all : all.filter((p) => p.id === scope)),
    [all, scope],
  );

  const until = today();
  const since = addDays(until, -(SPAN - 1));
  const days = useMemo(
    () => Array.from({ length: SPAN }, (_, i) => addDays(since, i)),
    [since],
  );

  const activities = useActivities(scoped, since, until, mine);
  const dumps = usePromptDumps(scoped, since, until);

  // 두 시리즈를 날짜로 합친다("전체"면 프로젝트 합).
  const counts = useMemo(() => {
    const m = new Map<string, DayValue>();
    const bump = (date: string, key: keyof DayValue, n: number) => {
      const cur = m.get(date) ?? { commits: 0, prompts: 0 };
      cur[key] += n;
      m.set(date, cur);
    };
    for (const q of activities)
      for (const d of q.data ?? []) bump(d.date, "commits", d.count);
    for (const q of dumps)
      for (const d of q.data?.days ?? []) bump(d.date, "prompts", d.count);
    return m;
  }, [activities, dumps]);

  const range = periodRange(period, anchor);
  const advance = useCallback(
    () => setQueue((q) => (q && q.length > 1 ? q.slice(1) : null)),
    [],
  );

  const toggleMine = () => {
    const v = !mine;
    localStorage.setItem(MINE_KEY, v ? "1" : "0");
    setMine(v);
  };

  const startBatch = () => {
    const ids = scoped.map((p) => p.id);
    setBatchTotal(ids.length);
    setQueue(ids);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-base p-4">
      {/* 상단 바 */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded border border-edge bg-panel px-1.5 py-0.5 text-fg"
        >
          <option value="all">전체</option>
          {all.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <div className="flex overflow-hidden rounded border border-edge">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-2 py-0.5 ${
                period === p ? "bg-accent text-on-accent" : "bg-panel hover:bg-raised"
              }`}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer items-center gap-1">
          <input type="checkbox" checked={mine} onChange={toggleMine} />내 커밋만
        </label>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setAnchor(shiftPeriod(period, anchor, -1))}
            title="이전"
            className="rounded p-0.5 hover:bg-raised hover:text-fg"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="min-w-[84px] text-center text-fg">{range.label}</span>
          <button
            onClick={() => setAnchor(shiftPeriod(period, anchor, 1))}
            title="다음"
            className="rounded p-0.5 hover:bg-raised hover:text-fg"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {scoped.length > 1 &&
          (queue ? (
            <button
              onClick={() => setQueue(null)}
              className="ml-auto flex items-center gap-1 rounded bg-raised px-2 py-0.5 hover:text-fg"
            >
              <X size={11} /> 취소 ({batchTotal - queue.length + 1}/{batchTotal})
            </button>
          ) : (
            <button
              onClick={startBatch}
              className="ml-auto flex items-center gap-1 rounded bg-raised px-2 py-0.5 hover:text-fg"
            >
              <Sparkles size={11} /> 모두 생성
            </button>
          ))}
      </div>

      {/* 중단: 잔디 */}
      <div className="mt-3 rounded border border-edge p-3">
        <Heatmap
          days={days}
          counts={counts}
          selected={range.since}
          onSelect={setAnchor}
        />
      </div>

      {/* 하단: 선택 기간의 프로젝트 카드 */}
      <div className="mt-3 flex flex-col gap-2 pb-2">
        {scoped.map((p) => (
          <ReportCard
            key={p.id}
            project={p}
            period={period}
            since={range.since}
            until={range.until}
            mine={mine}
            stripe={
              (projectColorsOn ? colors.get(p.name) : undefined)?.stripe ??
              NO_COLOR.stripe
            }
            runNow={queue?.[0] === p.id}
            onFinish={advance}
          />
        ))}
        {scoped.length === 0 && (
          <div className="text-xs text-fg-dim">등록된 프로젝트가 없습니다</div>
        )}
      </div>
    </div>
  );
}
