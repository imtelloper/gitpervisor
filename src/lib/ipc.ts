import { invoke } from "@tauri-apps/api/core";

export interface Project {
  id: string;
  name: string;
  path: string;
  order: number;
  addedAt: string;
}

export type ChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "typechange"
  | "conflicted"
  | "untracked";

export interface FileChange {
  path: string;
  origPath: string | null;
  kind: ChangeKind;
  staged: boolean;
}

export type RepoOpState =
  | "normal"
  | "merging"
  | "rebasing"
  | "cherry-picking"
  | "bisecting";

export interface RepoStatus {
  projectId: string;
  branch: string | null;
  detachedSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  opState: RepoOpState;
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  conflicted: FileChange[];
  error: string | null;
}

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
  tooLarge: boolean;
}

export interface GitCheck {
  found: boolean;
  version: string | null;
  path: string | null;
}

export type ErrorCode =
  | "NOT_A_REPO"
  | "GIT_NOT_FOUND"
  | "DUPLICATE_PROJECT"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "GIT_ERROR"
  | "IO";

export interface IpcError {
  code: ErrorCode;
  message: string;
  stderr: string | null;
}

export function isIpcError(e: unknown): e is IpcError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export function errorMessage(e: unknown): string {
  if (isIpcError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

class IpcTimeoutError extends Error {
  constructor(cmd: string) {
    super(`IPC 응답 시간 초과: ${cmd}`);
  }
}

// Windows WebView2에서 페이지 로드 직후 동시 invoke 응답이 드물게 유실된다
// (Rust 커맨드는 완료되지만 JS 프라미스가 영원히 settle되지 않음).
// 유실된 응답은 복구되지 않으므로: 동시성 제한 + 타임아웃 + 재시도로 방어한다.
// 주의: 읽기 전용 커맨드 전제 — M2의 commit/push 등 변경 커맨드에는 자동 재시도 금지.
const MAX_CONCURRENT = 3;
const INVOKE_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;

let active = 0;
const waiters: Array<() => void> = [];

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs = INVOKE_TIMEOUT_MS,
): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((r) => waiters.push(r));
  }
  active++;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await Promise.race([
          invoke<T>(cmd, args),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new IpcTimeoutError(cmd)), timeoutMs),
          ),
        ]);
      } catch (e) {
        if (!(e instanceof IpcTimeoutError) || attempt >= MAX_ATTEMPTS) throw e;
      }
    }
  } finally {
    active--;
    waiters.shift()?.();
  }
}

export const ipc = {
  checkGit: () => call<GitCheck>("check_git"),
  listProjects: () => call<Project[]>("list_projects"),
  addProject: (path: string) => call<Project>("add_project", { path }),
  removeProject: (id: string) => call<void>("remove_project", { id }),
  // 배치: 레포 수 × 콜드 git spawn을 고려해 타임아웃을 넉넉히 잡는다
  getStatuses: (projectIds: string[]) =>
    call<RepoStatus[]>("get_statuses", { projectIds }, 20000),
  getWorktreeDiff: (projectId: string, path: string) =>
    call<FileDiff>("get_file_diff", {
      projectId,
      target: { mode: "worktree", path },
    }),
};
