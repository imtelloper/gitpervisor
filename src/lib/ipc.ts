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

/** 중앙 diff 뷰어가 표시할 대상 (설계 §6). */
export type DiffTarget =
  | { mode: "worktree"; path: string } // 인덱스(없으면 HEAD) ↔ 워크트리
  | { mode: "index"; path: string } // HEAD ↔ 인덱스 (staged 검토)
  | { mode: "commit"; sha: string; path: string } // 부모 ↔ 해당 커밋
  | { mode: "file"; path: string; line?: number }; // 단일 파일 보기 (line=점프 대상 줄)

/** Go-to-Definition 후보 (commands/tree.rs find_definition). */
export interface DefMatch {
  path: string; // 레포 상대 경로
  line: number; // 1-based
  column: number; // 1-based
  signature: string; // 데코레이터 + 정의줄 + 파라미터
}

// ---- M3: 히스토리 ----

export interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string; // ISO 8601
  refs: string[]; // ["HEAD -> main", "origin/main", "tag: v1.0"]
}

export interface LocalBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface RemoteBranch {
  name: string; // "origin/main" 형태
}

export interface Branches {
  head: string | null;
  local: LocalBranch[];
  remote: RemoteBranch[];
}

export interface CommitFile {
  path: string;
  origPath: string | null;
  kind: ChangeKind;
}

export interface CommitDetail {
  commit: Commit;
  files: CommitFile[];
}

export interface LogPage {
  limit?: number;
  skip?: number;
  allRefs?: boolean;
}

// ---- M4: 설정 ----
export type ThemeName = "darcula" | "monokai";

export interface Settings {
  gitPath: string | null; // null/빈값 = PATH 자동 탐색
  autoFetchMinutes: number; // 0 = 끔
  diffFontSize: number;
  confirmDiscard: boolean;
  theme: ThemeName;
  terminalShell: string | null; // null/빈값 = 자동(pwsh→powershell→cmd / $SHELL)
  terminalFontSize: number;
}

export type OpenTarget = "explorer" | "terminal";

// ---- DB 탐색기 (M6 §17) ----
export type DbEngine = "mongodb" | "postgres" | "mysql" | "sqlite" | "mssql";
export interface DbConnection {
  id: string;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  database: string | null;
  username: string;
  options: string | null;
  readOnly: boolean;
  color: string | null;
}
export interface DbColumn {
  name: string;
  typeName: string | null;
}
export interface DbResult {
  columns: DbColumn[];
  rows: unknown[][];
  rowCount: number;
}

// 오브젝트 탐색기 메타(SQL 엔진)
export interface ColumnInfo {
  name: string;
  typeName: string;
  nullable: boolean;
  pk: boolean;
  identity: boolean;
  hasDefault: boolean;
}
export interface KeyInfo {
  name: string;
  kind: string; // PRIMARY KEY | UNIQUE | FOREIGN KEY
  columns: string[];
  references: string | null;
}
export interface IndexInfo {
  name: string;
  kind: string; // CLUSTERED | NONCLUSTERED …
  unique: boolean;
  columns: string[];
}
export interface ConstraintInfo {
  name: string;
  kind: string; // CHECK | DEFAULT
  column: string | null;
  definition: string;
}
export interface TriggerInfo {
  name: string;
  events: string; // "INSERT, UPDATE"
  disabled: boolean;
}
export interface TableMeta {
  columns: ColumnInfo[];
  keys: KeyInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
}
export interface ProcParam {
  name: string;
  typeName: string;
  output: boolean;
  hasDefault: boolean;
}

// ---- 프로젝트 메모 (프로젝트당 여러 개) ----
export interface Memo {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}
export type NotesMap = Record<string, Memo[]>;

// ---- 타이틀바 시스템 모니터 ----
export interface SysMetrics {
  cpu: number; // 0-100
  gpu: number | null; // PDH 미지원 시 null
  ram: number;
  storage: number;
  ramUsed: number; // bytes
  ramTotal: number;
  storageUsed: number;
  storageTotal: number;
}

// ---- 파일 트리 ----
export interface DirEntry {
  name: string;
  isDir: boolean;
  isIgnored: boolean; // .gitignore 무시 (.git 포함)
}

export interface ProjectRoot {
  projectId: string;
  entries: DirEntry[];
  error: string | null;
}

export interface GitCheck {
  found: boolean;
  version: string | null;
  path: string | null;
  reason: string | null;
}

export type ErrorCode =
  | "NOT_A_REPO"
  | "GIT_NOT_FOUND"
  | "DUPLICATE_PROJECT"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "GIT_ERROR"
  | "OP_IN_PROGRESS"
  | "AUTH_FAILED"
  | "IO"
  // ---- API 클라이언트 (commands/http.rs §4.8) ----
  | "NETWORK"
  | "DNS_FAILURE"
  | "CONNECTION_REFUSED"
  | "TLS_ERROR"
  | "CANCELLED"
  | "INVALID_URL";

// ---- API 클라이언트 전송 계약 (commands/http.rs §4.9 / §5.1) ----
// 백엔드 HttpRequest의 camelCase serde와 1:1 정합. lib/apiclient.ts에서 조립한
// PreparedRequest를 그대로(camelCase) 실어 백엔드 BodyKind/HttpRequest로 역직렬화한다.

/** §5.1 PreparedBody — 백엔드 BodyKind(§4.A.1/§4.9)와 동형의 태그드 유니온. */
export type PreparedBody =
  | { kind: "none" }
  | { kind: "json"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "formUrlencoded"; fields: { key: string; value: string }[] }
  | { kind: "formData"; parts: PreparedMultipartPart[] }
  | { kind: "binary"; base64?: string; filePath?: string; contentType: string | null };

/** 백엔드 MultipartPart(§4.A.2) 미러 — text 파트는 value, file 파트는 filePath. */
export interface PreparedMultipartPart {
  field: string;
  value?: string;
  filePath?: string;
  fileName?: string;
  contentType?: string;
}

/** 백엔드 HttpRequest(§4.9)와 정확히 정합하는 전송 페이로드. */
export interface PreparedRequest {
  method: string; // HttpMethod | 커스텀 — reqwest from_bytes
  url: string;
  query: { key: string; value: string }[]; // 순서/중복 보존
  headers: { name: string; value: string }[]; // 순서/중복 보존
  body: PreparedBody;
  timeoutMs?: number; // 기본 30_000(백엔드)
  followRedirects?: boolean; // 기본 true(백엔드)
  maxRedirects?: number; // 기본 10(백엔드)
  verifyTls?: boolean; // 기본 true(백엔드)
  maxBodyBytes?: number; // 기본 25MB(백엔드)
  allowInsecureRedirect?: boolean; // https→http 다운그레이드 허용(기본 false — §10.3)
}

/** 백엔드 HttpTiming(§4.B.1) 프론트 미러. timingExact=false면 dns/connect/tls는 근사. */
export interface HttpTiming {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  downloadMs: number;
  totalMs: number;
  timingExact: boolean;
}

/** 백엔드 RedirectHop(§4.B.2) 프론트 미러. */
export interface RedirectHop {
  status: number;
  url: string;
  location: string | null;
}

/** 백엔드 HeaderKv 미러(응답 headers). */
export interface HttpHeaderKv {
  name: string;
  value: string;
}

/** 백엔드 SetCookie(§4.B) 미러. */
export interface HttpSetCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string | null;
  expires: string | null;
  maxAge: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
}

/** 백엔드 ResponseBody(§4.B) 미러. */
export interface HttpResponseBody {
  base64: string;
  contentType: string | null;
  size: number;
  truncated: boolean;
}

/** 백엔드 HttpResponse(§4.B) 1:1 — http_request 응답. */
export interface HttpResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HttpHeaderKv[];
  cookies: HttpSetCookie[];
  timing: HttpTiming;
  body: HttpResponseBody;
  redirects: RedirectHop[];
  remoteAddr: string | null;
  verifyTls: boolean; // 실제 사용된 verifyTls echo — "검증 꺼짐" 경고 배지용(§4.A/§10.4)
}

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
// 한도는 8 — 너무 낮으면(예: 3) 느린/유실된 커맨드가 슬롯을 잡았을 때 사용자 클릭
// (list_dir 등)이 큐에 갇혀 굶는다. 백엔드는 동시 실행에 문제없다(실측).
const MAX_CONCURRENT = 8;
const INVOKE_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;

let active = 0;
const waiters: Array<() => void> = [];

interface CallOpts {
  timeoutMs?: number;
  attempts?: number;
  /** background는 큐 맨 뒤에 선다 — 프리페치가 사용자 클릭을 막지 않게 (§12) */
  lane?: "interactive" | "background";
}

// 진행 중인 동일 (cmd+args) 읽기 호출을 1건으로 합친다(single-flight).
// 같은 쿼리가 여러 번(예: react-query 키 흔들림으로 get_statuses 다중 생성) 들어와도
// invoke·슬롯은 1개만 쓴다 — 좀비(유실 응답)가 슬롯을 독점하는 폭주를 구조적으로 차단.
const inflightByKey = new Map<string, Promise<unknown>>();

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
  opts: CallOpts = {},
): Promise<T> {
  const dedupKey = `${cmd}:${JSON.stringify(args ?? {})}`;
  const existing = inflightByKey.get(dedupKey);
  if (existing) return existing as Promise<T>;
  const p = runCall<T>(cmd, args, opts).finally(() =>
    inflightByKey.delete(dedupKey),
  );
  inflightByKey.set(dedupKey, p);
  return p;
}

async function runCall<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  opts: CallOpts,
): Promise<T> {
  const {
    timeoutMs = INVOKE_TIMEOUT_MS,
    attempts = MAX_ATTEMPTS,
    lane = "interactive",
  } = opts;

  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((r) =>
      lane === "background" ? waiters.push(r) : waiters.unshift(r),
    );
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
        if (!(e instanceof IpcTimeoutError) || attempt >= attempts) throw e;
      }
    }
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/// 변경 커맨드 전용: 자동 재시도 금지 (§10 — 중복 실행 위험).
/// 타임아웃은 응답 유실 시 UI가 영원히 멈추는 것만 막는다 — 실제 결과는 상태 재조회가 진실.
async function callMutating<T>(
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<T> {
  try {
    return await Promise.race([
      invoke<T>(cmd, args),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new IpcTimeoutError(cmd)), timeoutMs),
      ),
    ]);
  } catch (e) {
    if (e instanceof IpcTimeoutError) {
      const err: IpcError = {
        code: "TIMEOUT",
        message: `${cmd} 응답을 받지 못했습니다 — 실제 결과는 새로고침된 상태로 확인하세요`,
        stderr: null,
      };
      throw err;
    }
    throw e;
  }
}

export const ipc = {
  checkGit: () => call<GitCheck>("check_git"),
  listProjects: () => call<Project[]>("list_projects"),
  addProject: (path: string) => call<Project>("add_project", { path }),
  removeProject: (id: string) => call<void>("remove_project", { id }),
  // 배치: 레포 수 × 콜드 git spawn을 고려해 타임아웃을 넉넉히 잡는다.
  // attempts:1 — 유실돼도 재시도로 슬롯을 길게 점유하지 않는다(다음 이벤트/포커스가 재조회).
  getStatuses: (projectIds: string[]) =>
    call<RepoStatus[]>(
      "get_statuses",
      { projectIds },
      // 백엔드 status 타임아웃(45초)보다 길게 — 거대/바쁜 레포에서 status가 느려도
      // 프론트가 먼저 끊지 않게 한다.
      { timeoutMs: 50000, attempts: 2, lane: "background" },
    ),
  // 단일 diff — DiffTarget(worktree/index/commit) 어느 모드든 처리
  getDiff: (projectId: string, target: DiffTarget) =>
    call<FileDiff>("get_file_diff", { projectId, target }),
  // 프리페치 배치 (worktree 전용) — background 레인(클릭에 양보), 재시도 없음, 짧은 타임아웃
  getWorktreeDiffs: (projectId: string, paths: string[]) =>
    call<FileDiff[]>(
      "get_file_diffs",
      { projectId, paths },
      { timeoutMs: 12000, attempts: 1, lane: "background" },
    ),

  // ---- M3: 히스토리 (읽기 전용) ----
  getLog: (projectId: string, page: LogPage = {}) =>
    call<Commit[]>(
      "get_log",
      {
        projectId,
        limit: page.limit,
        skip: page.skip,
        allRefs: page.allRefs,
      },
      { timeoutMs: 15000 },
    ),
  getBranches: (projectId: string) =>
    call<Branches>("get_branches", { projectId }),
  getCommitDetail: (projectId: string, sha: string) =>
    call<CommitDetail>("get_commit_detail", { projectId, sha }),

  // ---- M4: 설정 / 열기 ----
  getSettings: () => call<Settings>("get_settings"),
  setSettings: (settings: Settings) =>
    callMutating<void>("set_settings", { settings }),
  openIn: (projectId: string, target: OpenTarget) =>
    callMutating<void>("open_in", { projectId, target }),
  listDir: (projectId: string, relPath: string) =>
    call<DirEntry[]>("list_dir", { projectId, relPath }),
  // Viewer 편집 저장 — 텍스트 파일 내용을 디스크에 쓴다(레포 상대 경로). 재시도 금지.
  writeFile: (projectId: string, relPath: string, content: string) =>
    callMutating<void>("write_file", { projectId, relPath, content }),
  // Go-to-Definition — 심볼 정의 후보를 휴리스틱 검색(ripgrep). 읽기 레인.
  findDefinition: (projectId: string, symbol: string, ext: string) =>
    call<DefMatch[]>("find_definition", { projectId, symbol, ext }),
  // 배치: 전 프로젝트 루트를 한 invoke로 병렬 읽기 (응답 유실 회피, §12).
  // background 레인 — 시작 프리페치가 사용자 폴더 클릭(list_dir)보다 슬롯을 양보한다.
  listProjectRoots: (projectIds: string[]) =>
    call<ProjectRoot[]>("list_project_roots", { projectIds }, {
      timeoutMs: 20000,
      lane: "background",
    }),
  // ---- DB 탐색기 ----
  dbListConnections: () => call<DbConnection[]>("db_list_connections"),
  dbSaveConnection: (connection: DbConnection, password: string | null) =>
    callMutating<DbConnection>("db_save_connection", {
      payload: { connection, password },
    }),
  dbDeleteConnection: (id: string) =>
    callMutating<void>("db_delete_connection", { id }),
  dbConnect: (id: string) => callMutating<void>("db_connect", { id }, 60_000),
  dbDisconnect: (id: string) => callMutating<void>("db_disconnect", { id }),
  dbDatabases: (id: string) =>
    callMutating<string[]>("db_databases", { id }, 60_000),
  dbTables: (id: string, database: string) =>
    callMutating<string[]>("db_tables", { id, database }, 60_000),
  dbQuery: (id: string, database: string, query: string, limit: number) =>
    callMutating<DbResult>("db_query", { id, database, query, limit }, 120_000),
  dbTableMeta: (id: string, database: string, table: string) =>
    callMutating<TableMeta>("db_table_meta", { id, database, table }, 60_000),
  dbExplain: (id: string, database: string, query: string) =>
    callMutating<string>("db_explain", { id, database, query }, 60_000),
  dbUpdateCell: (
    id: string,
    database: string,
    table: string,
    pk: { col: string; value: unknown }[],
    setCol: string,
    setValue: unknown,
  ) =>
    callMutating<void>(
      "db_update_cell",
      { id, database, table, pk, setCol, setValue },
      60_000,
    ),
  dbDeleteRow: (
    id: string,
    database: string,
    table: string,
    pk: { col: string; value: unknown }[],
  ) => callMutating<void>("db_delete_row", { id, database, table, pk }, 60_000),
  dbInsertRow: (
    id: string,
    database: string,
    table: string,
    values: { col: string; value: unknown }[],
  ) =>
    callMutating<void>(
      "db_insert_row",
      { id, database, table, values },
      60_000,
    ),
  dbProcedures: (id: string, database: string) =>
    callMutating<string[]>("db_procedures", { id, database }, 60_000),
  dbProcParams: (id: string, database: string, proc: string) =>
    callMutating<ProcParam[]>("db_proc_params", { id, database, proc }, 60_000),

  getNotes: () => call<NotesMap>("get_notes"),
  addMemo: (projectId: string, memoId: string) =>
    callMutating<Memo>("add_memo", { projectId, memoId }),
  updateMemo: (projectId: string, memoId: string, text: string) =>
    callMutating<Memo | null>("update_memo", { projectId, memoId, text }),
  deleteMemo: (projectId: string, memoId: string) =>
    callMutating<void>("delete_memo", { projectId, memoId }),
  // 타이틀바 폴링 — 사용자 클릭에 양보(background), 재시도 없음, 짧은 타임아웃
  sysMetrics: () =>
    call<SysMetrics>("sys_metrics", undefined, {
      lane: "background",
      attempts: 1,
      timeoutMs: 4000,
    }),

  // ---- 변경 커맨드 (재시도 없음) ----
  stageFiles: (projectId: string, paths: string[]) =>
    callMutating<void>("stage_files", { projectId, paths }),
  unstageFiles: (projectId: string, paths: string[]) =>
    callMutating<void>("unstage_files", { projectId, paths }),
  discardFiles: (projectId: string, tracked: string[], untracked: string[]) =>
    callMutating<void>("discard_files", { projectId, tracked, untracked }),
  commit: (projectId: string, message: string, amend: boolean) =>
    callMutating<void>("commit", { projectId, message, amend }),
  push: (projectId: string, setUpstream: boolean) =>
    callMutating<void>("push", { projectId, setUpstream }),
  pull: (projectId: string) => callMutating<void>("pull", { projectId }),
  fetch: (projectId: string) => callMutating<void>("fetch", { projectId }),

  // ---- API 클라이언트 (commands/http.rs) ----
  // 비멱등 네트워크 호출 — callMutating(재시도 금지). requestId는 프론트 UUID라
  // invoke 응답이 유실돼도 "아는 id"로 httpCancel 가능(고아 in-flight 방지).
  httpRequest: (reqId: string, prepared: PreparedRequest) =>
    callMutating<HttpResponse>(
      "http_request",
      { requestId: reqId, req: prepared },
      120_000,
    ),
  // 진행 중 요청 취소 — 멱등(없으면 백엔드 no-op).
  httpCancel: (reqId: string) =>
    callMutating<void>("http_cancel", { requestId: reqId }, 8_000),
};
