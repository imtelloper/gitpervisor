import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  HardDrive,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Play,
  RefreshCw,
  Search,
  SearchX,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";

import { fmtDate, fmtDateTime } from "../../i18n/format-locale";
import { currentMessages, useMessages } from "../../i18n/ui-language";
import { copyText } from "../../lib/clipboard";
import { formatBytes, relativeTime } from "../../lib/format";
import {
  errorMessage,
  ipc,
  type ClaudeSession,
  type ClaudeSessionDetail,
  type ClaudeSessionTurn,
  type Project,
} from "../../lib/ipc";
import { isMod, modLabel } from "../../lib/platform";
import { getTerminal, queueInitialInput } from "../../lib/terminal";
import { useProjects } from "../../queries";
import { IS_AGGREGATE_WINDOW, useTerminals } from "../../stores/terminals";
import { useUi } from "../../stores/ui";
import { EmptyState } from "../common/EmptyState";
import { useReturnFocus } from "../common/PromptDialog";
import { ProjectLogo } from "../common/ProjectLogo";
import { splitHighlights } from "../search/SearchPanel";
import {
  annotateSessions,
  defaultScope,
  groupSessions,
  inScope,
  matchesTokens,
  matchSnippet,
  modelLabel,
  planResume,
  projectKeys,
  queryTokens,
  rowPreview,
  rowTitle,
  type AnnotatedSession,
  type ResumeTarget,
  type SessionScope,
  type SessionSort,
} from "./session-history";

type Opener = { termId: string; projectId: string };

const LIST_KEY = ["claude-sessions"] as const;
// 열 때마다 다시 훑되(진행 중인 세션이 자란다) 헤더 버튼 호버 프리페치 직후 연 것까지 두 번 훑지는 않는다.
const LIST_STALE_MS = 15_000;
const listQuery = {
  queryKey: LIST_KEY,
  queryFn: ipc.claudeSessionsList,
  staleTime: LIST_STALE_MS,
  // 첫 스캔은 몇 초짜리라 재시도·포커스 재조회가 그만큼을 또 태운다 — 새로 고침은 버튼으로.
  retry: false,
  refetchOnWindowFocus: false,
} as const;

/** 헤더 버튼에 포인터가 올라오면 미리 훑는다 — 첫 스캔의 몇 초를 클릭까지의 이동 시간에 숨긴다. */
export function prefetchSessionList(qc: QueryClient): void {
  void qc.prefetchQuery(listQuery);
}

const SCOPES: SessionScope[] = ["project", "registered", "all"];
const EMPTY: ClaudeSession[] = [];
const HL_OPTS = { regex: true, caseSensitive: false };
const DAY_MS = 86_400_000;

function ago(ms: number, now: number): string {
  const d = now - ms;
  if (d < DAY_MS) return relativeTime(ms, now);
  if (d < 30 * DAY_MS) return currentMessages().sessions.daysAgo(Math.floor(d / DAY_MS));
  return fmtDate(new Date(ms));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Claude Code 세션 기록(태스크 77) — 터미널 세션 헤더의 세션 기록 버튼이 연다. 상태는 창별 `useUi`라
 * 메인 창과 모아보기 별도 창이 각자 이 호스트를 마운트한다(GitDialog 와 같은 구조).
 */
export function SessionHistoryDialog() {
  const opener = useUi((s) => s.sessionHistory);
  const close = useUi((s) => s.closeSessionHistory);
  useReturnFocus(!!opener);
  // 배경 클릭 닫기 — pointerdown 과 click 이 둘 다 배경일 때만(안에서 시작한 텍스트 선택을 배경에서 놓아도 닫히지 않게, GitDialog 와 같은 함정).
  const downOnBackdrop = useRef(false);
  if (!opener) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) close();
      }}
    >
      <Body opener={opener} onClose={close} />
    </div>
  );
}

// 키에 mtime 을 넣는다 — 진행 중 세션이 자라면 새 키라 다시 읽고, 그대로면 다시 펼쳐도 캐시다.
const detailKey = (s: ClaudeSession) => ["claude-session-detail", s.projectDir, s.id, s.updatedAtMs] as const;

function Body({ opener, onClose }: { opener: Opener; onClose: () => void }) {
  const msg = useMessages();
  const t = msg.sessions;
  const pushToast = useUi((s) => s.pushToast);
  const qc = useQueryClient();
  const { data: projects } = useProjects();
  const list = useQuery(listQuery);

  const [query, setQuery] = useState("");
  // null = 사용자가 아직 고르지 않음 → 기본 범위(이 프로젝트, 비면 등록된 프로젝트, 그것도 비면 전체)를 따른다.
  const [pickedScope, setPickedScope] = useState<SessionScope | null>(null);
  const [sort, setSort] = useState<SessionSort>("updated");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projectList = projects ?? [];
  const sessions = list.data?.sessions ?? EMPTY;
  const annotated = useMemo(
    () => annotateSessions(sessions, projectKeys(projects ?? []), opener.projectId),
    [sessions, projects, opener.projectId],
  );
  const tokens = useMemo(() => queryTokens(query), [query]);
  const searching = tokens.length > 0;
  const hlRe = useMemo(() => tokens.map(escapeRe).join("|"), [tokens]);
  const matched = useMemo(
    () => (searching ? annotated.filter((a) => matchesTokens(a, tokens)) : annotated),
    [annotated, tokens, searching],
  );
  const scope = pickedScope ?? defaultScope(annotated);
  const counts: Record<SessionScope, number> = useMemo(
    () => ({
      project: matched.filter((a) => inScope(a, "project")).length,
      registered: matched.filter((a) => inScope(a, "registered")).length,
      all: matched.length,
    }),
    [matched],
  );
  const groups = useMemo(
    () => groupSessions(matched.filter((a) => inScope(a, scope)), sort, opener.projectId),
    [matched, scope, sort, opener.projectId],
  );
  // 검색 중에는 접힌 묶음도 편다 — 걸린 세션이 접힌 묶음에 숨으면 "결과 없음"처럼 보인다.
  const visible = useMemo(
    () => groups.flatMap((g) => (!searching && collapsed.has(g.key) ? [] : g.items)),
    [groups, collapsed, searching],
  );
  const active = visible.find((a) => a.s.id === activeId) ?? visible[0] ?? null;
  // 버튼을 누른 터미널이 살아 있어야 "이 터미널에서 이어서"가 입력할 곳이 있다(열려 있는 동안 바뀌는 일은 드물다).
  const termLive = getTerminal(opener.termId)?.status === "live";
  const now = Date.now();
  const scopeLabel = (sc: SessionScope) =>
    sc === "project" ? t.scopeProject : sc === "registered" ? t.scopeRegistered : t.scopeAll;
  const openerPath = projectList.find((p) => p.id === opener.projectId)?.path ?? "";

  const resume = (s: ClaudeSession, target: ResumeTarget) => {
    const plan = planResume(s, target, opener.projectId, projectList);
    if (plan.kind === "badId") return void pushToast("error", t.badSessionId(s.id));
    if (plan.kind === "unsafeCwd") return void pushToast("error", t.unsafeCwd(s.cwd ?? ""));
    // 펼쳐 본 세션만 안다(상세가 캐시에 있을 때) — Ctrl+Enter 는 펼치지 않고도 오므로 여기서도 막는다.
    if (qc.getQueryData<ClaudeSessionDetail>(detailKey(s))?.cwdExists === false)
      return void pushToast("error", t.cwdGone(s.cwd ?? ""));
    if (target === "thisTerminal") {
      const inst = getTerminal(opener.termId);
      if (inst?.status !== "live") return void pushToast("error", t.resumeHereGone);
      // 키 입력과 같은 경로(onData → ptyWrite)라 순서·프롬프트 기록이 그대로다(launchAgentInTerminal 과 같다).
      inst.term.input(plan.input);
      inst.term.focus();
      onClose();
      return;
    }
    // 예약 → 마운트 순서: openTerminal 은 스토어를 동기로 갱신하고 PTY spawn 은 다음 커밋이라 같은 틱의 예약이 먼저다.
    const { paneId } = useTerminals.getState().openTerminal(plan.projectId);
    queueInitialInput(paneId, plan.input);
    // 메인 창 작업 화면은 선택된 프로젝트의 탭만 그린다 — 다른 프로젝트에 열었으면 그리로 옮겨야 보인다.
    // 모아보기(메인 안·별도 창)는 새로 생긴 터미널을 저절로 그리드에 넣는다(AggregateTerminals 의 편입 효과).
    const ui = useUi.getState();
    if (!IS_AGGREGATE_WINDOW && !ui.aggregateOpen && ui.selectedProjectId !== plan.projectId)
      ui.selectProject(plan.projectId);
    onClose();
  };

  const scrollToRow = (id: string, block: ScrollLogicalPosition) =>
    listRef.current
      ?.querySelector(`[data-session-row="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block });

  const toggleExpand = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  const move = (d: 1 | -1) => {
    if (!visible.length) return;
    const i = active ? visible.indexOf(active) : -1;
    const next = visible[i < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, i + d))];
    setActiveId(next.s.id);
    scrollToRow(next.s.id, "nearest");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // 창 단축키(Esc 로 모아보기 닫기·Ctrl+` 등)로 새지 않게 대화상자 안의 키는 여기서 끝낸다.
    e.stopPropagation();
    // 한글 조합 중의 Enter·화살표·Esc 는 조합을 끝내는 키다.
    if (e.nativeEvent.isComposing) return;
    const tag = e.target instanceof HTMLElement ? e.target.tagName : "";
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (tag === "SELECT") return;
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && active) {
      if (isMod(e)) {
        e.preventDefault();
        resume(active.s, "newTab");
        return;
      }
      if (tag === "BUTTON" || tag === "SELECT") return; // 그 버튼 자신의 동작
      e.preventDefault();
      const id = active.s.id;
      toggleExpand(id);
      // 펼친 상세가 화면 밖으로 내려가지 않게 행을 위로 올린다(키보드로 펼칠 때만 — 클릭은 제자리가 덜 어지럽다).
      requestAnimationFrame(() => scrollToRow(id, "start"));
    }
  };

  const changeView = (fn: () => void) => {
    fn();
    listRef.current?.scrollTo({ top: 0 });
  };

  const body = (() => {
    if (list.isPending)
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
          <Loader2 size={26} className="mb-1 animate-spin text-accent" />
          <div className="font-medium text-fg-muted">{t.loadingTitle}</div>
          <div className="max-w-96 text-xs leading-5 text-fg-dim">{t.loadingDesc}</div>
        </div>
      );
    if (list.isError && !list.data)
      return (
        <EmptyState
          icon={TriangleAlert}
          title={t.loadFailed}
          desc={errorMessage(list.error)}
          action={<GhostButton onClick={() => void list.refetch()}>{t.retry}</GhostButton>}
        />
      );
    if (sessions.length === 0)
      return <EmptyState icon={MessagesSquare} title={t.emptyAllTitle} desc={t.emptyAllDesc} />;
    if (groups.length === 0) {
      // 다른 범위에 걸린 게 있으면 그리로 가는 버튼 — 범위가 좁아 못 찾는 경우가 대부분이다.
      const other = SCOPES.find((sc) => sc !== scope && counts[sc] > 0);
      return (
        <EmptyState
          icon={searching ? SearchX : MessagesSquare}
          title={searching ? t.emptySearchTitle(query.trim()) : t.emptyScopeTitle(scopeLabel(scope))}
          action={
            other && (
              <GhostButton onClick={() => changeView(() => setPickedScope(other))}>
                {t.showInScope(scopeLabel(other), counts[other])}
              </GhostButton>
            )
          }
        />
      );
    }
    return groups.map((g) => {
      const open = searching || !collapsed.has(g.key);
      return (
        <section key={g.key}>
          <button
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(g.key)) next.delete(g.key);
                else next.add(g.key);
                return next;
              })
            }
            title={t.groupToggleTitle}
            className="sticky top-0 z-[1] flex h-7 w-full items-center gap-1.5 border-b border-edge bg-panel px-3 text-left text-[11px] hover:bg-raised"
          >
            <ChevronRight
              size={12}
              className={`shrink-0 text-fg-dim transition-transform ${open ? "rotate-90" : ""}`}
            />
            {g.project ? (
              <ProjectLogo projectId={g.project.id} size={14} />
            ) : (
              <FolderOpen size={12} className="shrink-0 text-fg-dim" />
            )}
            <span className="shrink-0 font-semibold text-fg">{g.label || t.unknownCwd}</span>
            <span className="min-w-0 flex-1 truncate text-fg-dim" title={g.path}>
              {g.path}
            </span>
            <span className="shrink-0 rounded-full bg-raised px-1.5 text-[10px] leading-4 tabular-nums text-fg-muted">
              {g.items.length}
            </span>
          </button>
          {open &&
            g.items.map((a) => (
              <SessionRow
                key={a.s.id}
                a={a}
                now={now}
                hlRe={hlRe}
                tokens={tokens}
                active={a === active}
                expanded={expandedId === a.s.id}
                onClick={() => {
                  setActiveId(a.s.id);
                  toggleExpand(a.s.id);
                }}
              >
                {expandedId === a.s.id && (
                  <SessionDetail
                    s={a.s}
                    hlRe={hlRe}
                    now={now}
                    opener={opener}
                    projects={projectList}
                    termLive={termLive}
                    onResume={resume}
                  />
                )}
              </SessionRow>
            ))}
        </section>
      );
    });
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.title}
      // 안쪽 빈 곳을 눌러도 포커스가 대화상자에 남게 — body 로 빠지면 아래 키 처리가 끊긴다.
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="flex h-[min(80vh,860px)] w-[min(880px,94vw)] flex-col overflow-hidden rounded-lg border border-edge bg-panel text-[13px] shadow-xl outline-none"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <MessagesSquare size={15} className="shrink-0 text-accent" />
        <span className="shrink-0 font-semibold">{t.title}</span>
        {list.data && (
          <span
            className="min-w-0 truncate text-[11px] text-fg-dim"
            title={fmtDateTime(new Date(list.data.scannedAtMs))}
          >
            {t.summary(sessions.length, list.data.scannedFiles)} · {relativeTime(list.data.scannedAtMs, now)}
          </span>
        )}
        {list.isError && list.data && (
          <span className="shrink-0 text-[11px] text-danger" title={errorMessage(list.error)}>
            {t.refreshFailed}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => void list.refetch()}
          disabled={list.isFetching}
          title={t.refresh}
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg disabled:opacity-60"
        >
          <RefreshCw size={13} className={list.isFetching ? "animate-spin" : ""} />
        </button>
        <button
          onClick={onClose}
          title={t.close}
          className="rounded p-1 text-fg-dim hover:bg-raised hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
        <div role="tablist" className="flex shrink-0 rounded-md border border-edge bg-base p-0.5">
          {SCOPES.map((sc) => (
            <button
              key={sc}
              role="tab"
              aria-selected={scope === sc}
              onClick={() => changeView(() => setPickedScope(sc))}
              title={
                sc === "project"
                  ? t.scopeProjectTitle(openerPath)
                  : sc === "registered"
                    ? t.scopeRegisteredTitle
                    : t.scopeAllTitle
              }
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[12px] ${
                scope === sc ? "bg-raised font-medium text-fg" : "text-fg-muted hover:text-fg"
              }`}
            >
              {scopeLabel(sc)}
              {list.data && (
                <span className={`tabular-nums text-[10px] ${scope === sc ? "text-accent" : "text-fg-dim"}`}>
                  {counts[sc]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-dim"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => changeView(() => setQuery(e.target.value))}
            placeholder={t.searchPlaceholder}
            spellCheck={false}
            className="h-7 w-full rounded-md border border-edge bg-base pl-7 pr-2 text-[12px] text-fg outline-none placeholder:text-fg-dim focus:border-accent"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => changeView(() => setSort(e.target.value as SessionSort))} // DOM 경계 — 값은 아래 option 셋뿐
          title={t.sortTitle}
          className="h-7 shrink-0 rounded-md border border-edge bg-base px-1.5 text-[12px] text-fg-muted outline-none focus:border-accent"
        >
          <option value="updated">{t.sortUpdated}</option>
          <option value="started">{t.sortStarted}</option>
          <option value="messages">{t.sortMessages}</option>
        </select>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {body}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-edge px-3 text-[10px] text-fg-dim">
        <span className="flex items-center gap-1">
          <Kbd>↑↓</Kbd> {t.hintMove}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> {t.hintExpand}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>{modLabel}+Enter</Kbd> {t.hintResume}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd> {t.hintClose}
        </span>
      </div>
    </div>
  );
}

function SessionRow({
  a,
  now,
  hlRe,
  tokens,
  active,
  expanded,
  onClick,
  children,
}: {
  a: AnnotatedSession;
  now: number;
  hlRe: string;
  tokens: readonly string[];
  active: boolean;
  expanded: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const t = useMessages().sessions;
  const s = a.s;
  const title = rowTitle(s);
  const preview = rowPreview(s);
  const snippet = tokens.length ? matchSnippet(a, tokens) : null;
  const model = modelLabel(s.model);
  return (
    <div
      data-session-row={s.id}
      // 위에 붙는 묶음 머리(sticky h-7)에 가리지 않게 스크롤 여백을 둔다.
      className={`relative scroll-mt-7 border-b border-edge/50 ${expanded ? "bg-base/40" : ""}`}
    >
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <button
        onClick={onClick}
        aria-expanded={expanded}
        className={`flex w-full flex-col gap-1 py-2 pl-7 pr-3 text-left ${
          active ? "bg-selection/40" : "hover:bg-raised/50"
        }`}
      >
        <div className="flex w-full items-baseline gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${title ? "text-fg" : "text-fg-dim"}`}
          >
            {title ? <Hl text={title} re={hlRe} /> : t.untitled}
          </span>
          <span
            className="shrink-0 text-[11px] tabular-nums text-fg-dim"
            title={t.updatedTitle(fmtDateTime(new Date(s.updatedAtMs)))}
          >
            {ago(s.updatedAtMs, now)}
          </span>
        </div>
        <div className="line-clamp-2 w-full break-words text-[12px] leading-[18px] text-fg-muted">
          {preview ? <Hl text={preview} re={hlRe} /> : <span className="text-fg-dim">{t.noAgentText}</span>}
        </div>
        {snippet && (
          <div className="w-full truncate text-[11px] text-fg-dim">
            <span className="mr-1 font-medium text-fg-muted">{t.matchedIn}</span>
            <Hl text={snippet} re={hlRe} />
          </div>
        )}
        <div className="flex w-full flex-wrap items-center gap-1 text-[10px]">
          {model && (
            <Chip tone="accent" title={t.modelTitle}>
              {model}
            </Chip>
          )}
          <Chip
            icon={<MessageSquare size={10} />}
            title={t.messagesTitle(s.humanPromptCount, s.messageCount)}
          >
            {t.messages(s.messageCount)}
          </Chip>
          {s.subagentCount > 0 && <Chip icon={<Workflow size={10} />}>{t.subagents(s.subagentCount)}</Chip>}
          {s.gitBranch && (
            <Chip icon={<GitBranch size={10} />} title={t.branchTitle}>
              <Hl text={s.gitBranch} re={hlRe} />
            </Chip>
          )}
          {a.subdir && (
            <Chip icon={<FolderOpen size={10} />} title={t.subdirTitle(s.cwd ?? "")}>
              {a.subdir}
            </Chip>
          )}
          <Chip icon={<HardDrive size={10} />} title={t.sizeTitle}>
            {formatBytes(s.sizeBytes)}
          </Chip>
        </div>
      </button>
      {children}
    </div>
  );
}

function SessionDetail({
  s,
  hlRe,
  now,
  opener,
  projects,
  termLive,
  onResume,
}: {
  s: ClaudeSession;
  hlRe: string;
  now: number;
  opener: Opener;
  projects: Project[];
  termLive: boolean;
  onResume: (s: ClaudeSession, target: ResumeTarget) => void;
}) {
  const t = useMessages().sessions;
  const pushToast = useUi((st) => st.pushToast);
  const detail = useQuery({
    queryKey: detailKey(s),
    queryFn: () => ipc.claudeSessionDetail(s.projectDir, s.id),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const d = detail.data;
  const cwdGone = d?.cwdExists === false;
  const plan = planResume(s, "newTab", opener.projectId, projects);
  const planName =
    plan.kind === "ok" ? (projects.find((p) => p.id === plan.projectId)?.name ?? "") : "";
  const copy = (text: string, done: string) =>
    void copyText(text).then((ok) => pushToast(ok ? "success" : "error", ok ? done : t.copyFailed));
  const reveal = () =>
    void ipc.claudeSessionReveal(s.projectDir, s.id).catch((e) => pushToast("error", errorMessage(e)));
  // 목록의 첫 프롬프트(≤300자)를 바로 보여 주고, 상세(≤4000자)가 오면 바꾼다 — 펼치자마자 읽을 거리가 있다.
  const firstPrompt = d?.firstPrompt || s.firstPrompt || "";
  const cwd = d?.cwd || s.cwd;
  const branch = d?.gitBranch || s.gitBranch;
  const model = modelLabel(s.model);

  return (
    <div className="flex flex-col gap-3 pb-3 pl-7 pr-3 pt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => onResume(s, "newTab")}
          disabled={cwdGone}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-accent"
        >
          <Play size={11} className="fill-current" />
          {t.resumeNewTab}
          <span className="ml-0.5 rounded bg-black/15 px-1 font-mono text-[10px]">{modLabel}+↵</span>
        </button>
        <button
          onClick={() => onResume(s, "thisTerminal")}
          disabled={!termLive || cwdGone}
          title={termLive ? t.resumeHereTitle : t.resumeHereGone}
          className="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1 text-[12px] text-fg-muted hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <SquareTerminal size={12} />
          {t.resumeHere}
        </button>
        <div className="flex-1" />
        <GhostButton onClick={() => copy(s.id, t.idCopied)}>
          <Copy size={11} /> {t.copyId}
        </GhostButton>
        <GhostButton onClick={reveal}>
          <FolderOpen size={11} /> {t.reveal}
        </GhostButton>
      </div>
      {cwdGone ? (
        <div className="-mt-1.5 text-[11px] text-danger">{t.cwdGone(cwd ?? "")}</div>
      ) : plan.kind === "ok" && (
        <div className="-mt-1.5 truncate text-[11px] text-fg-dim">
          → {plan.cd ? t.planCd(planName) : t.planInProject(planName)}
          <span className="ml-1.5 font-mono text-fg-muted">claude --resume {s.id}</span>
        </div>
      )}

      {firstPrompt && (
        <DetailSection
          title={t.firstPrompt}
          action={
            <button
              onClick={() => copy(firstPrompt, t.promptCopied)}
              className="flex items-center gap-1 rounded px-1 text-[10px] text-fg-dim hover:bg-raised hover:text-fg"
            >
              <Copy size={10} /> {t.copy}
            </button>
          }
        >
          <div className="rounded-md border border-edge bg-base px-2.5 py-1.5 text-[12px] leading-[18px] text-fg">
            <ClampText text={firstPrompt} lines={6} hlRe={hlRe} />
          </div>
        </DetailSection>
      )}

      <DetailSection title={t.recent}>
        {detail.isPending ? (
          <div className="flex items-center gap-2 py-2 text-[11px] text-fg-dim">
            <Loader2 size={12} className="animate-spin" /> {t.detailLoading}
          </div>
        ) : detail.isError ? (
          <div className="flex items-center gap-2 py-1 text-[11px] text-danger">
            <TriangleAlert size={12} className="shrink-0" />
            <span className="min-w-0 truncate" title={errorMessage(detail.error)}>
              {t.detailFailed} — {errorMessage(detail.error)}
            </span>
            <GhostButton onClick={() => void detail.refetch()}>{t.retry}</GhostButton>
          </div>
        ) : d && d.recent.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {d.recent.map((turn, i) => (
              <Bubble key={i} turn={turn} hlRe={hlRe} now={now} />
            ))}
          </div>
        ) : (
          <div className="py-1 text-[11px] text-fg-dim">{t.noRecent}</div>
        )}
      </DetailSection>

      <DetailSection title={t.details}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          {cwd && <Meta label={t.cwd} value={cwd} mono />}
          {branch && <Meta label={t.branch} value={branch} mono />}
          {model && <Meta label={t.model} value={s.model ?? model} mono />}
          <Meta
            label={t.period}
            value={`${s.startedAtMs ? fmtDateTime(new Date(s.startedAtMs)) : "?"} → ${fmtDateTime(new Date(s.updatedAtMs))}`}
          />
          {d?.accountUuid && <Meta label={t.account} value={d.accountUuid} mono />}
          {s.version && <Meta label={t.version} value={s.version} mono />}
          <Meta label={t.sessionId} value={s.id} mono />
        </dl>
        {d && d.subagents.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 flex items-center gap-1 text-[11px] text-fg-muted">
              <Workflow size={11} /> {t.subagentsHeading(d.subagents.length)}
            </div>
            <ul className="max-h-32 overflow-y-auto rounded-md border border-edge bg-base py-0.5 text-[11px]">
              {d.subagents.map((sa) => (
                <li key={sa.id} className="truncate px-2 py-0.5 text-fg-muted" title={sa.id}>
                  {sa.description || <span className="font-mono text-fg-dim">{sa.id}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DetailSection>
    </div>
  );
}

function Bubble({ turn, hlRe, now }: { turn: ClaudeSessionTurn; hlRe: string; now: number }) {
  const t = useMessages().sessions;
  const user = turn.role === "user";
  return (
    <div className={`flex ${user ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] rounded-lg px-2.5 py-1.5 text-[12px] leading-[18px] text-fg ${
          user ? "rounded-br-sm bg-accent/15" : "rounded-bl-sm border border-edge bg-base"
        }`}
      >
        <div className={`mb-0.5 flex items-center gap-1.5 text-[10px] text-fg-dim ${user ? "justify-end" : ""}`}>
          <span className={`font-semibold ${user ? "text-accent" : "text-fg-muted"}`}>
            {user ? t.roleUser : t.roleAssistant}
          </span>
          {turn.timestampMs != null && (
            <span title={fmtDateTime(new Date(turn.timestampMs))}>{ago(turn.timestampMs, now)}</span>
          )}
        </div>
        <ClampText text={turn.text} lines={8} hlRe={hlRe} />
      </div>
    </div>
  );
}

/** 긴 글은 n줄에서 자르고 "더 보기" — 넘침 측정 대신 줄·글자 수로 어림한다(넘지 않는데 버튼이 뜨는 정도는 무해). */
function ClampText({ text, lines, hlRe }: { text: string; lines: number; hlRe: string }) {
  const t = useMessages().sessions;
  const [open, setOpen] = useState(false);
  const long = text.split("\n").length > lines || text.length > lines * 90;
  return (
    <>
      <div
        className="whitespace-pre-wrap break-words"
        style={
          long && !open
            ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }
            : undefined
        }
      >
        <Hl text={text} re={hlRe} />
      </div>
      {long && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-[10px] font-medium text-accent hover:underline"
        >
          {open ? t.showLess : t.showMore}
        </button>
      )}
    </>
  );
}

function Hl({ text, re }: { text: string; re: string }) {
  if (!re) return <>{text}</>;
  return (
    <>
      {splitHighlights(text, re, HL_OPTS).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-accent/35 text-fg">
            {p.s}
          </mark>
        ) : (
          <Fragment key={i}>{p.s}</Fragment>
        ),
      )}
    </>
  );
}

function DetailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-dim">{title}</span>
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-fg-dim">{label}</dt>
      <dd className={`min-w-0 truncate select-text text-fg-muted ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </dd>
    </>
  );
}

function Chip({
  icon,
  tone,
  title,
  children,
}: {
  icon?: ReactNode;
  tone?: "accent";
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-[18rem] items-center gap-1 rounded px-1.5 py-px leading-4 ${
        tone === "accent" ? "bg-accent/15 text-accent" : "bg-raised text-fg-muted"
      }`}
    >
      {icon && <span className="shrink-0 opacity-80">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}

function GhostButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-muted hover:bg-raised hover:text-fg"
    >
      {children}
    </button>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-edge bg-raised px-1 font-mono text-[10px] leading-4 text-fg-muted">
      {children}
    </kbd>
  );
}
