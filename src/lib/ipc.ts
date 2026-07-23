import { Channel, invoke } from "@tauri-apps/api/core";

import type { ThemeName } from "./themes";

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
  /** 임베디드(중첩) 저장소면 부모 프로젝트 id — Changes 패널이 이 항목을 별도 섹션으로 렌더. */
  parentId: string | null;
  /** 임베디드 저장소의 부모 루트 기준 상대 경로(예: "APPLICATION/nexus-application"). */
  relPath: string | null;
  /** 이 프로젝트 하위 임베디드 저장소들의 변경 총합(사이드바 표시용). */
  nestedChanges: number;
  /** 배경/수동 fetch 마지막 성공 시각(ISO 8601) — behind 배지 툴팁의 "마지막 확인" 표기용. */
  lastFetchAt: string | null;
  /** 마지막 배경 fetch 실패 사유 — 조용한 CloudOff 배지용. null=정상. */
  fetchError: string | null;
}

export interface FileDiff {
  path: string;
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
  tooLarge: boolean;
}

/** 이미지 미리보기용 파일 바이트 (read_file_base64). */
export interface FileBytes {
  mime: string;
  base64: string;
}

/** 중앙 diff 뷰어가 표시할 대상 (설계 §6). */
export type DiffTarget =
  | { mode: "worktree"; path: string } // 인덱스(없으면 HEAD) ↔ 워크트리
  | { mode: "index"; path: string } // HEAD ↔ 인덱스 (staged 검토)
  | { mode: "commit"; sha: string; path: string } // 부모 ↔ 해당 커밋
  | { mode: "file"; path: string; line?: number; column?: number }; // 단일 파일 보기 (line/column=점프 도착 심볼 위치)

/** Go-to-Definition 후보 (commands/tree.rs find_definition). */
export interface DefMatch {
  path: string; // 레포 상대 경로
  line: number; // 1-based
  column: number; // 1-based
  signature: string; // 데코레이터 + 정의줄 + 파라미터
  doc?: string; // 정의 문서(py 독스트링/JSDoc/`///`) — 백엔드가 skip_serializing이라 없으면 undefined
}

/** Go to Symbol 후보 (commands/tree.rs find_symbols). */
export interface SymbolMatch {
  name: string;
  path: string;
  line: number;
  column: number;
  signature: string;
}

/** 참조 찾기 결과 (commands/tree.rs find_references). */
export interface RefMatch {
  path: string;
  line: number;
  column: number;
}
export interface RefsResult {
  matches: RefMatch[];
  truncated: boolean;
}

/** Find in Files 결과 (commands/search.rs search_in_project). */
export interface SearchMatch {
  line: number;
  column: number;
  text: string;
}
export interface SearchFileHit {
  path: string;
  matches: SearchMatch[];
}
export interface SearchResult {
  files: SearchFileHit[];
  totalMatches: number;
  truncated: boolean;
}
export interface SearchOpts {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include: string[];
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
// 테마 유니온의 원천은 themes.ts(레지스트리) — 여기선 재노출만 한다.
// (themes.ts는 ipc를 import하지 않으므로 순환 없음)
export type { ThemeName };

/** AI 완료 알림 모드 — off=끔, project-inactive=프로젝트 단위·창 비활성 시만,
 *  terminal=터미널 단위 매번, always=항상. */
export type NotifyMode = "off" | "project-inactive" | "terminal" | "always";

export interface Settings {
  gitPath: string | null; // null/빈값 = PATH 자동 탐색
  remoteRefreshMinutes: number; // 원격 새로고침(배경 fetch) 주기 — 0 = 끔, 기본 5분
  diffFontSize: number;
  confirmDiscard: boolean;
  theme: ThemeName;
  terminalShell: string | null; // null/빈값 = 자동(pwsh→powershell→cmd / $SHELL)
  terminalFontSize: number;
  notifyMode: NotifyMode;
  // ---- AI 완료 외부 알림 (Slack 웹훅 / SMTP email) ----
  // 시크릿(웹훅 URL·SMTP 비번)은 여기 두지 않고 OS 키링에 저장한다(notifySetSecret).
  slackEnabled: boolean;
  emailEnabled: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpUsername: string | null;
  smtpFrom: string | null;
  smtpTo: string | null;
  smtpTls: boolean; // true=암호화(465 implicit / 587 STARTTLS), false=평문
  // 포매터/린터 (태스크 15/16)
  formatterRuffPath: string | null;
  formatterBiomePath: string | null;
  formatterProjectLocal: boolean; // 프로젝트 로컬 바이너리 허용 — 기본 false(공급망)
  formatOnSave: boolean;
  // LSP (태스크 17)
  lspEnabledProjects: string[]; // 옵트인 프로젝트 id 목록 — 기본 빈(전부 OFF)
  lspWorkspaceTsserver: boolean; // 워크스페이스 node_modules/typescript 사용 — 기본 false(공급망)
}

/** 포맷 결과 (commands/format.rs format_source). */
export interface FormatResult {
  formatted: string | null;
  changed: boolean;
  tool: string;
}
export interface FormatToolStatus {
  tool: string;
  found: boolean;
  path: string | null;
  source: string | null;
  version: string | null;
}

/** 린트 진단 (commands/lint.rs lint_file). */
export interface LintDiag {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  code: string | null;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  url: string | null;
}
export interface LintReport {
  tool: "ruff" | "biome" | null; // null = 비대상/미설치/실패 → 프론트 no-op
  diags: LintDiag[];
  truncated: boolean;
}

/** LSP 서버 획득 결과 (commands/lsp.rs lsp_ensure). */
export interface LspEnsureResult {
  ready: boolean; // 서버 전부 설치 + node 발견
  nodeFound: boolean;
  installed: string[];
  missing: string[]; // 다운로드 실패 패키지
}
export interface LspEnsureProgress {
  name: string;
  phase: "download" | "done" | "error";
  message?: string;
}

/** 외부 알림 시크릿 종류 — 키링 계정 키. */
export type NotifySecret = "slack" | "smtp";

export type OpenTarget = "explorer" | "terminal";

// ---- DB 탐색기 (M6 §17) ----
export type DbEngine =
  | "mongodb"
  | "postgres"
  | "mysql"
  | "sqlite"
  | "mssql"
  | "redis";

/** SQL 계열 엔진 — 편집기 언어(sql)·셀 편집·테이블 메타(컬럼/키/인덱스)·실행계획 대상.
 *  mongodb/redis는 비-SQL(문서·키값) — 쿼리 콘솔만 제공. */
export const SQL_ENGINES: DbEngine[] = ["mssql", "postgres", "mysql", "sqlite"];
export function isSqlEngine(e: DbEngine | null | undefined): boolean {
  return !!e && SQL_ENGINES.includes(e);
}
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

// ---- 리소스 모니터 팝업 (sys_process_snapshot, 태스크 05) ----
export interface ProcessSample {
  pid: number;
  name: string; // 실행 파일명 (예: "chrome.exe")
  cpu: number; // 0-100 — 코어수로 나눈 전역 스케일
  ram: number; // bytes
  gpu: number | null; // Windows PDH 3D 엔진 pid 집계, 그 외/비대상 null
  groupCount: number | null; // 프로그램별 합산 행이면 묶인 프로세스 수
}
export interface ProcessSnapshot {
  totals: SysMetrics; // 팝업 헤더 게이지 — 별도 sys_metrics 호출 불필요(배치)
  processes: ProcessSample[]; // 정렬·Top-N 절단 완료
  totalCount: number; // 절단 전 행 수 ("… 외 N개")
}
export type ProcSortKey = "cpu" | "ram" | "gpu";

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

/** Quick Open 파일 목록 (commands/tree.rs list_repo_files). */
export interface RepoFileList {
  projectId: string;
  files: string[]; // 저장소 루트 기준 상대 경로(forward-slash)
  truncated: boolean;
  error: string | null;
}

export interface GitCheck {
  found: boolean;
  version: string | null;
  path: string | null;
  reason: string | null;
}

// ---- Rust target 용량 관리 (commands/disk.rs) ----
export interface TargetSize {
  projectId: string;
  isRust: boolean; // Cargo.toml 존재 → 사이드바에 용량 표시
  bytes: number; // 모든 cargo target 디렉토리 합산
  targetCount: number; // 청소 대상 디렉토리 수
  paths: string[]; // 삭제될 정확한 절대 경로 (확인 다이얼로그 표시용)
}

export interface CleanResult {
  freedBytes: number;
  removed: number;
}

/** 프로젝트 폴더 전체 용량 (commands/disk.rs get_project_sizes). */
export interface ProjectSize {
  projectId: string;
  bytes: number;
  error: string | null; // 경로 소실 등 — 있으면 배지 숨김
}

/** 로그/크래시 상태 (commands/diagnostics.rs). */
export interface LogStatus {
  logDir: string;
  panicLogBytes: number;
  lastCrashAt: string | null; // panic.log 최종 수정 시각(RFC3339)
}

// ---- macOS 격리 도구 (commands/quarantine.rs) ----
export interface QuarantinedItem {
  path: string; // 격리 속성이 박힌 실행 파일 절대경로
  name: string; // 파일명 (UI 표시용)
  cask: string; // brew cask 이름 (예: "claude-code")
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
  | "ALREADY_EXISTS"
  // ---- API 클라이언트 (commands/http.rs §4.8) ----
  | "NETWORK"
  | "DNS_FAILURE"
  | "CONNECTION_REFUSED"
  | "TLS_ERROR"
  | "CANCELLED"
  | "INVALID_URL"
  | "TOOL_NOT_FOUND";

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
  /** 부모 폴더 아래 새 프로젝트 폴더 생성(옵션 git init) → 절대경로 반환(이어서 addProject). */
  createProjectFolder: (parentDir: string, name: string, gitInit: boolean) =>
    call<string>("create_project_folder", { parentDir, name, gitInit }),
  /** 옮긴 프로젝트 폴더의 등록 경로 변경 — id·순서·메모 유지, 이름은 새 폴더명으로. */
  updateProjectPath: (id: string, path: string) =>
    call<Project>("update_project_path", { id, path }),
  removeProject: (id: string) => call<void>("remove_project", { id }),
  // 사이드바 드래그 순서 영속화 — 새 id 순서대로 order 재할당. 재시도 금지.
  reorderProjects: (orderedIds: string[]) =>
    callMutating<void>("reorder_projects", { orderedIds }),
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
  // 플로팅 창이 floated PTY의 프로젝트 id를 조회 — 새 분할 패널을 같은 프로젝트로 연다.
  termProject: (termId: string) =>
    call<string | null>("term_project", { termId }),
  // 이미지 미리보기 — 워크트리 파일을 base64로. 큰 파일 대비 타임아웃 넉넉히, 재시도 없음.
  readFileBase64: (projectId: string, relPath: string) =>
    call<FileBytes>(
      "read_file_base64",
      { projectId, relPath },
      { timeoutMs: 30_000, attempts: 1 },
    ),
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
  // 파일트리에서 실행 파일 더블클릭 → OS 기본 실행기로 띄운다(프론트가 확인 후 호출).
  runExecutable: (projectId: string, relPath: string) =>
    callMutating<void>("run_executable", { projectId, relPath }),
  listDir: (projectId: string, relPath: string) =>
    call<DirEntry[]>("list_dir", { projectId, relPath }),
  // Viewer 편집 저장 — 텍스트 파일 내용을 디스크에 쓴다(레포 상대 경로). 재시도 금지.
  writeFile: (projectId: string, relPath: string, content: string) =>
    callMutating<void>("write_file", { projectId, relPath, content }),
  // 새 폴더 생성 (트리 컨텍스트 메뉴). 재시도 금지.
  createDir: (projectId: string, relPath: string) =>
    callMutating<void>("create_dir", { projectId, relPath }),
  // 새 파일 생성 (빈 파일, 임의 확장자). 같은 이름이 있으면 ALREADY_EXISTS. 재시도 금지.
  createFile: (projectId: string, relPath: string) =>
    callMutating<void>("create_file", { projectId, relPath }),
  // 파일/폴더 삭제 — 파괴적, 프론트 확인 후 호출. 재시도 금지.
  deletePath: (projectId: string, relPath: string) =>
    callMutating<void>("delete_path", { projectId, relPath }),
  // 이미지 변환·편집 저장 — base64 바이트를 디스크에 쓴다. overwrite=false면 기존 파일 충돌 시
  // ALREADY_EXISTS 오류(프론트가 덮어쓰기 확인). 큰 이미지 대비 타임아웃 넉넉히.
  writeFileBytes: (
    projectId: string,
    relPath: string,
    base64: string,
    overwrite: boolean,
  ) =>
    callMutating<void>(
      "write_file_bytes",
      { projectId, relPath, base64, overwrite },
      60_000,
    ),
  // Go-to-Definition — 심볼 정의 후보를 휴리스틱 검색(ripgrep). 읽기 레인.
  // lane: 예열(prefetch)은 background — 사용자 클릭/호버(interactive)에 슬롯을 양보한다.
  findDefinition: (
    projectId: string,
    symbol: string,
    ext: string,
    lane: "interactive" | "background" = "interactive",
  ) => call<DefMatch[]>("find_definition", { projectId, symbol, ext }, { lane }),
  // Go to Symbol — 프로젝트 전체 심볼 부분일치. interactive 레인, 재시도 없음(낡은 쿼리
  // 재시도는 슬롯 낭비 — 다음 키 입력이 새 요청을 만들고 프론트가 seq로 무효화).
  findSymbols: (projectId: string, query: string, extHint: string | null) =>
    call<SymbolMatch[]>(
      "find_symbols",
      { projectId, query, extHint },
      { lane: "interactive", attempts: 1 },
    ),
  // 참조 찾기 — interactive 레인(Shift+F12 직결).
  findReferences: (projectId: string, symbol: string, ext: string) =>
    call<RefsResult>("find_references", { projectId, symbol, ext }, { lane: "interactive" }),
  // Find in Files — 재시도 없음(무거운 검색 자동 재실행 방지). 백엔드 10s + 여유.
  searchInProject: (projectId: string, query: string, opts: SearchOpts) =>
    call<SearchResult>(
      "search_in_project",
      { projectId, query, ...opts },
      { timeoutMs: 15_000, attempts: 1 },
    ),
  // 포맷 — 프로세스 스폰이라 재시도 없음(이중 스폰 방지), 백엔드 10s + 여유.
  formatSource: (projectId: string, relPath: string, content: string) =>
    call<FormatResult>(
      "format_source",
      { projectId, relPath, content },
      { timeoutMs: 20_000, attempts: 1 },
    ),
  formatToolStatus: (projectId: string) =>
    call<FormatToolStatus[]>("format_tool_status", { projectId }, {
      attempts: 1,
      lane: "background",
    }),
  // LSP 서버 획득(태스크 17 M2) — 없으면 다운로드+검증+설치. 진행률은 Channel 콜백으로.
  lspEnsure: (
    lang: "py" | "ts" | "cpp" | "rust" | "lua" | "go" | "php" | "zig" | "ruby" | "csharp" | "java",
    onProgress?: (msg: LspEnsureProgress) => void,
  ) => {
    const ch = new Channel<string>();
    if (onProgress) {
      ch.onmessage = (raw) => {
        try {
          onProgress(JSON.parse(raw) as LspEnsureProgress);
        } catch {
          /* 형식 오류 무시 */
        }
      };
    }
    return invoke<LspEnsureResult>("lsp_ensure", { lang, onProgress: ch });
  },
  // 린트 — 마커는 배경 장식이라 background lane, 재시도 없음(다음 트리거가 자기치유).
  // content 있으면 ruff는 stdin으로 저장 전 버퍼를 실시간 린트(on-type). biome는 디스크 파일.
  lintFile: (projectId: string, relPath: string, content?: string) =>
    call<LintReport>("lint_file", { projectId, relPath, content: content ?? null }, {
      lane: "background",
      attempts: 1,
      timeoutMs: 15_000,
    }),
  // 배치: 전 프로젝트 루트를 한 invoke로 병렬 읽기 (응답 유실 회피, §12).
  // background 레인 — 시작 프리페치가 사용자 폴더 클릭(list_dir)보다 슬롯을 양보한다.
  listProjectRoots: (projectIds: string[]) =>
    call<ProjectRoot[]>("list_project_roots", { projectIds }, {
      timeoutMs: 20000,
      lane: "background",
    }),
  // Quick Open — 저장소들의 전체 파일 목록(추적+미추적, .gitignore 제외) 배치 수집.
  // 모달 진입 경로라 interactive 레인(기본). 합성 id(임베디드) 포함 가능.
  listRepoFiles: (projectIds: string[]) =>
    call<RepoFileList[]>("list_repo_files", { projectIds }, { timeoutMs: 20000 }),
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
  // 리소스 모니터 팝업 폴링 — 틱당 커맨드 1개(totals 포함 배치, 동시 invoke 유실 회피).
  // sysMetrics와 동일 규약: background 레인, 재시도 없음(다음 틱이 자기치유), 짧은 타임아웃.
  sysProcessSnapshot: (
    sortBy: ProcSortKey,
    limit: number,
    groupByName: boolean,
  ) =>
    call<ProcessSnapshot>(
      "sys_process_snapshot",
      { sortBy, limit, groupByName },
      { lane: "background", attempts: 1, timeoutMs: 4000 },
    ),
  // 리소스 모니터 팝업 창(싱글턴 라벨 "sysmon") — origin 전달은 floating.ts 전례와 동일.
  openSysmonWindow: () =>
    invoke<void>("open_sysmon_window", { origin: window.location.origin }),

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
  // 원격 새로고침(배경 fetch) 트리거 — 백엔드가 즉시 반환하고 백그라운드로 진행한다.
  // projectIds 비면 전체, force=false면 60초 스로틀(백엔드 판정). 결과는 이벤트/statuses로.
  refreshRemotes: (projectIds: string[], force = false) =>
    callMutating<void>("refresh_remotes", { projectIds, force }),

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

  // ---- Rust target 용량 (commands/disk.rs) ----
  // 배치: 전 프로젝트의 target 용량을 한 invoke로. 거대 디렉토리 열거가 수 초 걸릴 수
  // 있어 타임아웃을 넉넉히, background 레인, 재시도 없음(다음 새로고침이 재조회).
  getTargetSizes: (projectIds: string[]) =>
    call<TargetSize[]>("get_target_sizes", { projectIds }, {
      timeoutMs: 60_000,
      attempts: 1,
      lane: "background",
    }),
  // target 디렉토리 통째 삭제(= cargo clean). 대용량 삭제는 오래 걸릴 수 있어 길게.
  cleanTarget: (projectId: string) =>
    callMutating<CleanResult>("clean_target", { projectId }, 300_000),
  // 배치: 전 프로젝트의 폴더 전체 용량. 거대 트리 워크가 수 초 걸릴 수 있어 길게,
  // background 레인, 재시도 없음(다음 새로고침이 재조회). get_target_sizes와 동형.
  getProjectSizes: (projectIds: string[]) =>
    call<ProjectSize[]>("get_project_sizes", { projectIds }, {
      timeoutMs: 120_000,
      attempts: 1,
      lane: "background",
    }),

  // ---- 진단/로그 (commands/diagnostics.rs) ----
  openLogsFolder: () => callMutating<void>("open_logs_folder", {}),
  getLogStatus: () =>
    call<LogStatus>("get_log_status", undefined, {
      lane: "background",
      attempts: 1,
      timeoutMs: 6000,
    }),
  readCrashLog: (maxBytes: number) =>
    call<string>("read_crash_log", { maxBytes }, {
      attempts: 1,
      timeoutMs: 10_000,
    }),
  clearCrashLog: () => callMutating<void>("clear_crash_log", {}),

  // ---- AI 완료 외부 알림 (commands/notify.rs) ----
  // 시크릿(웹훅 URL·SMTP 비번)을 OS 키링에 저장/제거. 빈 문자열이면 제거.
  notifySetSecret: (kind: NotifySecret, value: string) =>
    callMutating<void>("notify_set_secret", { kind, value }),
  // 시크릿 저장 여부 — UI에서 "저장됨" 표시용.
  notifyHasSecret: (kind: NotifySecret) =>
    call<boolean>("notify_has_secret", { kind }),
  // 설정된 한 채널로 테스트 알림 전송(설정 화면 "테스트").
  notifyTest: (channel: NotifySecret) =>
    callMutating<void>("notify_test", { channel }, 30_000),
  // working→done 엣지에서 활성 외부 채널(Slack/email)로 팬아웃. 실패는 호출 측이 무시한다.
  notifyExternal: (title: string, body: string) =>
    callMutating<void>("notify_external", { title, body }, 30_000),
  // Windows 전용 OS 토스트 — 앱 AUMID로 직접 띄워 gitpervisor 아이콘이 보이게 한다(플러그인은
  // dev에서 PowerShell 명의로 뜸). 비-Windows에선 호출하지 않는다.
  notifyOs: (title: string, body: string) =>
    callMutating<void>("notify_os", { title, body }, 10_000),

  // ---- macOS 격리 도구 (commands/quarantine.rs, macOS 전용) ----
  // brew cask로 깐 CLI에 박힌 com.apple.quarantine을 스캔/해제한다.
  // 비-macOS에서는 백엔드가 빈 배열을 반환한다.
  scanQuarantinedTools: () =>
    call<QuarantinedItem[]>("scan_quarantined_tools", {}, {
      timeoutMs: 30_000,
      attempts: 1,
      lane: "background",
    }),
  clearQuarantine: (paths: string[]) =>
    callMutating<void>("clear_quarantine", { paths }, 60_000),
};
