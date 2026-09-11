import { ChevronDown, ChevronLeft, ChevronRight, MessageSquare, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Project } from "../../lib/ipc";
import type { ChatMsg } from "../../lib/llm";
import { NO_COLOR, useProjectColors } from "../../lib/project-color";
import type { ChatContext, Period } from "../../lib/report";
import {
  addDays,
  PERIOD_LABEL,
  periodRange,
  shiftPeriod,
  today,
} from "../../lib/report";
import { useActivities, useProjects, usePromptDumps } from "../../queries";
import { useOccludesWebview } from "../../stores/occlusion";
import { useUi } from "../../stores/ui";
import type { DayValue } from "./Heatmap";
import { Heatmap } from "./Heatmap";
import { ReportCard } from "./ReportCard";
import { ReportChat } from "./ReportChat";

const PERIODS: Period[] = ["day", "week", "month"];
/** 히트맵 기간 — 오늘 포함 365일(설계 §3.5). */
const SPAN = 365;
const MINE_KEY = "gp:report-mine";
/** 프로젝트 선택 — 창 간에 공유된다(별도 리포트 창도 같은 값을 읽는다 — 67 §3.3). */
const SCOPE_KEY = "gp:report-scope";
const CHAT_KEY = "gp:report-chat-open";

/** "전체"(등록된 프로젝트 전부, 새로 등록해도 따라온다) 또는 고른 id 목록. */
type Scope = "all" | string[];

/** 저장값 → 없으면 지금 보고 있던 프로젝트. 별도 창엔 `selectedProjectId`가 없어 "전체"가 된다. */
function initialScope(selectedProjectId: string | null): Scope {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v === "all") return "all";
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  } catch {
    /* 손상 — 기본값으로 시작한다 */
  }
  return selectedProjectId ? [selectedProjectId] : "all";
}

/**
 * 다중 선택 드롭다운(태스크 67 §3.1) — `FavoritesButton`(TitleBar)의 열림·바깥 클릭 골격 그대로.
 * fixed/absolute 팝오버라 열린 동안 네이티브 webview를 가려야 한다(useOccludesWebview).
 */
function ScopePicker({
  all,
  scope,
  onChange,
}: {
  all: Project[];
  scope: Scope;
  onChange: (next: Scope) => void;
}) {
  const [open, setOpen] = useState(false);
  useOccludesWebview(open);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 등록 해제된 id는 **여기서도** 걸러야 한다 — 안 그러면 라벨이 없는 프로젝트까지 세고
  // ("프로젝트 3개"인데 카드는 2장), 실제로 전부 골라도 길이가 안 맞아 "전체"로 접히지 않는다.
  const ids = (scope === "all" ? all.map((p) => p.id) : scope).filter((id) =>
    all.some((p) => p.id === id),
  );
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    // 전부 고르면 "전체"로 되돌린다 — 나중에 등록하는 프로젝트도 함께 따라오게.
    onChange(next.length === all.length ? "all" : next);
  };

  return (
    // 드롭다운 안의 클릭은 바깥 클릭 닫기로 새지 않게 막는다 — 체크는 여러 번 누른다.
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        data-gpv="report-scope"
        onClick={() => setOpen((v) => !v)}
        title="요약할 프로젝트를 고릅니다 — 2개 이상이면 맨 위에 종합 카드가 붙습니다"
        className={`flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 ${
          open ? "bg-raised text-fg" : "bg-panel text-fg hover:bg-raised"
        }`}
      >
        {scope === "all" ? "전체" : `프로젝트 ${ids.length}개`}
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="absolute left-0 top-6 z-50 max-h-72 min-w-52 overflow-auto rounded-md border border-edge bg-panel py-1 shadow-xl">
          <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg">
            <input
              type="checkbox"
              data-project-id="all"
              checked={scope === "all"}
              onChange={() => onChange(scope === "all" ? [] : "all")}
            />
            전체
          </label>
          <div className="my-1 border-t border-edge" />
          {all.map((p) => (
            <label
              key={p.id}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-fg-muted hover:bg-raised hover:text-fg"
            >
              <input
                type="checkbox"
                data-project-id={p.id}
                checked={ids.includes(p.id)}
                onChange={() => toggle(p.id)}
              />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 작업 리포트 전체 뷰 — 모아보기와 같은 층(모달 아님, 00-INDEX §11.3).
 *
 * 상단: 프로젝트·기간·"내 커밋만" / 중단: 잔디 / 하단: 선택 기간의 카드 / 우측: AI 채팅(67 §3.2).
 * 히트맵과 카운트는 LLM 없이도 보이고, LLM이 없으면 카드의 "요약 생성"만 막힌다.
 *
 * **prop이 없어야 한다** — 별도 리포트 창(`DocWindow`)이 이걸 그대로 그린다(67 §3.3).
 */
export function ReportView() {
  const { data: projects } = useProjects();
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const projectColorsOn = useUi((s) => s.projectColorsOn);
  const colors = useProjectColors();

  const [scope, setScope] = useState<Scope>(() => initialScope(selectedProjectId));
  const [period, setPeriod] = useState<Period>("day");
  const [anchor, setAnchor] = useState(today);
  const [mine, setMine] = useState(
    () => localStorage.getItem(MINE_KEY) !== "0",
  );
  // 배치 생성 대기열(앞이 현재 차례). 59는 한 번에 한 요청이라 직렬이다.
  const [queue, setQueue] = useState<string[] | null>(null);
  const [batchTotal, setBatchTotal] = useState(0);
  // 채팅 패널 — 컨텍스트·대화는 여기 둔다(패널을 닫았다 열어도 남아야 한다, 67 §3.2).
  const [chatOpen, setChatOpen] = useState(
    () => localStorage.getItem(CHAT_KEY) === "1",
  );
  const [chatCtx, setChatCtx] = useState<ChatContext | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);

  const all = useMemo(() => projects ?? [], [projects]);
  // 등록이 해제된 id는 여기서 걸러진다 — 저장된 선택이 낡아도 빈 카드가 생기지 않는다.
  const scoped = useMemo(
    () => (scope === "all" ? all : all.filter((p) => scope.includes(p.id))),
    [all, scope],
  );
  // 개별 카드에 넘길 1개짜리 배열 — 여기서 고정해야 한다. 렌더마다 `[p]`를 새로 만들면 카드의
  // `sources` 메모가 매번 깨져 입력 해시(SHA-1)가 렌더마다 다시 돈다(채팅 스트리밍 중에는
  // 토큰마다). 기존 `?? []` 주석이 경계하던 것과 같은 함정이다.
  const singles = useMemo(() => scoped.map((p) => [p]), [scoped]);

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

  const changeScope = (next: Scope) => {
    setScope(next);
    try {
      localStorage.setItem(SCOPE_KEY, JSON.stringify(next));
    } catch {
      /* 용량 초과 — 이번 세션에만 적용된다 */
    }
  };

  const openChat = (v: boolean) => {
    setChatOpen(v);
    try {
      localStorage.setItem(CHAT_KEY, v ? "1" : "0");
    } catch {
      /* 용량 초과 — 이번 세션에만 적용된다 */
    }
  };

  /** 카드의 [AI에게 묻기] — **다른 카드**면 대화를 초기화한다(앞의 답변이 무관해진다). */
  const ask = (ctx: ChatContext) => {
    if (chatCtx?.key !== ctx.key) setMessages([]);
    setChatCtx(ctx);
    openChat(true);
  };

  const startBatch = () => {
    const ids = scoped.map((p) => p.id);
    setBatchTotal(ids.length);
    setQueue(ids);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-auto bg-base p-4">
        {/* 상단 바 */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
          <ScopePicker all={all} scope={scope} onChange={changeScope} />

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

          <div className="ml-auto flex items-center gap-2">
            {scoped.length > 1 &&
              (queue ? (
                <button
                  onClick={() => setQueue(null)}
                  className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 hover:text-fg"
                >
                  <X size={11} /> 취소 ({batchTotal - queue.length + 1}/{batchTotal})
                </button>
              ) : (
                <button
                  onClick={startBatch}
                  className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 hover:text-fg"
                >
                  <Sparkles size={11} /> 모두 생성
                </button>
              ))}
            {/* 패널이 닫혀 있을 때만 — 타이틀바에 아이콘을 늘리지 않는다(67 §3.2). */}
            {!chatOpen && (
              <button
                data-gpv="report-chat-toggle"
                onClick={() => openChat(true)}
                title="AI 채팅 — 요약을 두고 대화하거나 그냥 물어봅니다"
                className="flex items-center gap-1 rounded bg-raised px-2 py-0.5 hover:text-fg"
              >
                <MessageSquare size={11} /> AI 채팅
              </button>
            )}
          </div>
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

        {/* 하단: 선택 기간의 카드 — 2개 이상이면 종합 카드가 맨 위에 붙는다(67 §3.1).
            종합은 "모두 생성" 배치에서 제외한다(개별 N장 뒤에 한 번 더 도는 셈이라 시간이 두 배다). */}
        <div className="mt-3 flex flex-col gap-2 pb-2">
          {scoped.length >= 2 && (
            <ReportCard
              key="combined"
              projects={scoped}
              period={period}
              since={range.since}
              until={range.until}
              mine={mine}
              stripe={NO_COLOR.stripe}
              onAsk={ask}
            />
          )}
          {scoped.map((p, i) => (
            <ReportCard
              key={p.id}
              projects={singles[i]}
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
              onAsk={ask}
            />
          ))}
          {scoped.length === 0 && (
            <div className="text-xs text-fg-dim">
              {all.length === 0
                ? "등록된 프로젝트가 없습니다"
                : "선택한 프로젝트가 없습니다"}
            </div>
          )}
        </div>
      </div>

      {/* 우측: AI 채팅. 리포트 뷰 안의 일반 레이아웃이라 점유 계약 대상이 아니다(00-INDEX §11.3). */}
      {chatOpen && (
        <ReportChat
          ctx={chatCtx}
          messages={messages}
          setMessages={setMessages}
          onClose={() => openChat(false)}
        />
      )}
    </div>
  );
}
