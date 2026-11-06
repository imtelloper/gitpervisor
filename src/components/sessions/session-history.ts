// 세션 기록 대화상자의 순수 계산 — 범위·검색·묶음·정렬·이어서 명령. UI·IPC 와 떼어 둔다(CLAUDE.md 검증 가능하게).

import type { ClaudeSession, Project } from "../../lib/ipc";
import { isWindows } from "../../lib/platform";

export type SessionScope = "project" | "registered" | "all";
export type SessionSort = "updated" | "started" | "messages";
export type ResumeTarget = "newTab" | "thisTerminal";

/** 경로 비교 키 — 구분자·끝 슬래시를 맞춘다. Windows 는 대소문자를 가리지 않는다(드라이브 글자 `f:`/`F:` 포함). */
export function pathKey(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindows ? s.toLowerCase() : s;
}

function isUnder(childKey: string, parentKey: string): boolean {
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

export interface ProjectKey {
  project: Project;
  key: string;
}

export function projectKeys(projects: readonly Project[]): ProjectKey[] {
  return projects.map((project) => ({ project, key: pathKey(project.path) }));
}

/** 세션 하나에 대한 범위·묶음 판정 — 목록이 바뀔 때만 계산하고 검색어가 바뀔 때는 재사용한다. */
export interface AnnotatedSession {
  s: ClaudeSession;
  /** cwd 를 품은 등록 프로젝트(중첩이면 가장 깊은 것). */
  home: Project | null;
  /** home 아래 하위 폴더에서 연 세션이면 그 상대 경로(`/` 구분). */
  subdir: string | null;
  inOpener: boolean;
  haystack: string;
}

export function annotateSessions(
  sessions: readonly ClaudeSession[],
  projects: readonly ProjectKey[],
  openerProjectId: string,
): AnnotatedSession[] {
  const opener = projects.find((p) => p.project.id === openerProjectId);
  return sessions.map((s) => {
    const cwdKey = s.cwd ? pathKey(s.cwd) : null;
    let home: ProjectKey | null = null;
    if (cwdKey)
      for (const p of projects)
        if (isUnder(cwdKey, p.key) && (!home || p.key.length > home.key.length)) home = p;
    const subdir =
      home && cwdKey && cwdKey !== home.key && s.cwd
        ? s.cwd.replace(/\\/g, "/").slice(home.key.length + 1)
        : null;
    return {
      s,
      home: home?.project ?? null,
      subdir,
      inOpener: !!(cwdKey && opener && isUnder(cwdKey, opener.key)),
      haystack: [s.title, s.firstPrompt, s.lastPrompt, s.lastAgentText, s.gitBranch, s.cwd, s.id]
        .filter(Boolean)
        .join("\n")
        .toLowerCase(),
    };
  });
}

/** 공백으로 나눈 낱말 전부를 포함해야 일치(AND) — 한 낱말 검색보다 좁히기 쉽다. */
export function queryTokens(q: string): string[] {
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesTokens(a: AnnotatedSession, tokens: readonly string[]): boolean {
  return tokens.every((t) => a.haystack.includes(t));
}

export function inScope(a: AnnotatedSession, scope: SessionScope): boolean {
  if (scope === "all") return true;
  if (scope === "project") return a.inOpener;
  return a.home !== null;
}

/** 처음 열 때의 범위 — 이 프로젝트에 세션이 없으면 등록된 프로젝트, 그것도 없으면 전체. */
export function defaultScope(all: readonly AnnotatedSession[]): SessionScope {
  if (all.some((a) => a.inOpener)) return "project";
  if (all.some((a) => a.home)) return "registered";
  return "all";
}

function sortValue(s: ClaudeSession, sort: SessionSort): number {
  if (sort === "messages") return s.messageCount;
  if (sort === "started") return s.startedAtMs ?? s.updatedAtMs;
  return s.updatedAtMs;
}

export interface SessionGroup {
  key: string;
  project: Project | null;
  /** 프로젝트 이름, 아니면 작업 폴더 이름. 둘 다 없으면 빈 문자열(호출부가 "작업 경로 모름"). */
  label: string;
  path: string;
  items: AnnotatedSession[];
}

/** 등록 프로젝트(하위 폴더 포함)별로, 없으면 작업 경로별로 묶는다. 버튼을 누른 프로젝트 묶음이 맨 위. */
export function groupSessions(
  items: readonly AnnotatedSession[],
  sort: SessionSort,
  openerProjectId: string,
): SessionGroup[] {
  const byKey = new Map<string, SessionGroup>();
  for (const a of items) {
    const cwd = a.s.cwd ?? "";
    const key = a.home ? `p:${a.home.id}` : cwd ? `c:${pathKey(cwd)}` : `d:${a.s.projectDir}`;
    let g = byKey.get(key);
    if (!g) {
      g = a.home
        ? { key, project: a.home, label: a.home.name, path: a.home.path, items: [] }
        : {
            key,
            project: null,
            label: cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "",
            path: cwd,
            items: [],
          };
      byKey.set(key, g);
    }
    g.items.push(a);
  }
  const cmp = (x: ClaudeSession, y: ClaudeSession) =>
    sortValue(y, sort) - sortValue(x, sort) || y.updatedAtMs - x.updatedAtMs;
  const groups = [...byKey.values()];
  groups.forEach((g) => g.items.sort((x, y) => cmp(x.s, y.s)));
  return groups.sort((a, b) => {
    const ao = a.project?.id === openerProjectId ? 0 : 1;
    const bo = b.project?.id === openerProjectId ? 0 : 1;
    return ao - bo || cmp(a.items[0].s, b.items[0].s);
  });
}

export function rowTitle(s: ClaudeSession): string | null {
  return s.title?.trim() || s.firstPrompt?.trim().split("\n")[0] || null;
}

/** 행 미리보기 — 마지막 에이전트 응답, 없으면 마지막 프롬프트. */
export function rowPreview(s: ClaudeSession): string {
  return s.lastAgentText || s.lastPrompt || "";
}

/** 제목·미리보기에 안 보이는 낱말이 다른 칸에서 맞았으면 그 언저리를 보여 준다 — "이게 왜 걸렸지?"에 답한다. */
export function matchSnippet(a: AnnotatedSession, tokens: readonly string[]): string | null {
  const shown = `${rowTitle(a.s) ?? ""}\n${rowPreview(a.s)}`.toLowerCase();
  const hidden = tokens.filter((t) => !shown.includes(t));
  if (!hidden.length) return null;
  for (const f of [a.s.firstPrompt, a.s.lastPrompt, a.s.gitBranch, a.s.cwd, a.s.id]) {
    const i = f ? f.toLowerCase().indexOf(hidden[0]) : -1;
    if (!f || i < 0) continue;
    const start = Math.max(0, i - 30);
    return `${start > 0 ? "…" : ""}${f.slice(start, start + 160).replace(/\s+/g, " ")}`;
  }
  return null;
}

export function modelLabel(model: string | null | undefined): string | null {
  // `<synthetic>` — Claude Code 가 스스로 끼운 줄의 모델 표시라 사용자에게 의미가 없다.
  if (!model || model.startsWith("<")) return null;
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// cwd 는 셸 한 줄에 큰따옴표로 들어간다 — 큰따옴표·백틱·$(pwsh·bash 확장)·!(bash 히스토리)·%(cmd 변수)·제어 문자는
// 따옴표로 막을 수 없다. 이런 경로는 드물어서 고치지 않고 거절한다. 정규식에 따옴표 글자를 직접 쓰지 않는 건
// 다국어 가드 스캐너(e2e 66)가 그것을 문자열 시작으로 읽기 때문이다.
const SHELL_UNSAFE = /[\x22\x60$%!\x00-\x1f\x7f]/;

export type ResumePlan =
  | { kind: "ok"; projectId: string; input: string; cd: boolean }
  | { kind: "badId" }
  | { kind: "unsafeCwd" };

/**
 * 이어서 열 터미널의 프로젝트와 입력 줄. `claude --resume` 은 **지금 폴더의** 기록에서만 세션을 찾으므로 셸이
 * 세션 cwd 에 있어야 한다: 같은 경로의 등록 프로젝트가 있으면 거기 새 터미널(이미 그 폴더), 없으면 버튼을 누른
 * 프로젝트에 열고 `cd` 를 먼저 보낸다. 지금 터미널은 셸 위치를 모르니 cwd 가 있으면 언제나 `cd` 한다.
 */
export function planResume(
  session: Pick<ClaudeSession, "id" | "cwd">,
  target: ResumeTarget,
  openerProjectId: string,
  projects: readonly Project[],
): ResumePlan {
  if (!SESSION_ID.test(session.id)) return { kind: "badId" };
  const resume = `claude --resume ${session.id}\r`;
  const cwd = session.cwd || null;
  if (target === "newTab" && cwd) {
    const key = pathKey(cwd);
    const exact = projects.find((p) => pathKey(p.path) === key);
    if (exact) return { kind: "ok", projectId: exact.id, input: resume, cd: false };
  }
  if (!cwd) return { kind: "ok", projectId: openerProjectId, input: resume, cd: false };
  if (SHELL_UNSAFE.test(cwd)) return { kind: "unsafeCwd" };
  return { kind: "ok", projectId: openerProjectId, input: `cd "${cwd}"\r${resume}`, cd: true };
}
