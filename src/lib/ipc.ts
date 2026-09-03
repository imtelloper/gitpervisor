import { Channel, invoke } from "@tauri-apps/api/core";

import type { ThemeId, ThemeName } from "./themes";

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
export type { ThemeId, ThemeName };

/** AI 완료 알림 모드 — off=끔, project-inactive=프로젝트 단위·창 비활성 시만,
 *  terminal=터미널 단위 매번, always=항상. */
export type NotifyMode = "off" | "project-inactive" | "terminal" | "always";

export interface Settings {
  gitPath: string | null; // null/빈값 = PATH 자동 탐색
  remoteRefreshMinutes: number; // 원격 새로고침(배경 fetch) 주기 — 0 = 끔, 기본 5분
  diffFontSize: number;
  confirmDiscard: boolean;
  theme: ThemeId; // 내장 6종 또는 사용자 정의 `custom-…`(정의는 localStorage — 태스크 29)
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
  // 동영상 편집 (video.rs)
  videoFfmpegPath: string | null; // null/빈값 = 자동 발견(PATH → 관리 설치본). 지정 시 그것만.
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

// ---- 동영상 편집 (commands/video.rs — DOCS/video-editor-design.md) ----

/** ffmpeg 발견 상태. source: explicit(설정 경로) | path | managed(앱 내 다운로드). */
export interface VideoToolStatus {
  found: boolean;
  source: string | null;
  path: string | null;
  probeFound: boolean; // ffprobe 동반 여부 — 없으면 프로브·편집 불가
  version: string | null;
  managedSupported: boolean; // 이 플랫폼에 앱 내 다운로드가 있는가
}

export interface VideoEnsureProgress {
  name: string;
  phase: "download" | "extract" | "done" | "error";
  percent?: number | null;
  message?: string | null;
}

/** ffprobe 메타데이터. width/height는 회전 반영 **표시 기준**(크롭 좌표계와 일치). */
export interface VideoMeta {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  vcodec: string | null;
  acodec: string | null;
  bitrateKbps: number | null;
  rotation: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

/** 내보내기 스펙 — copy(무손실, 키프레임 스냅)는 배속·크롭·화질과 양립 불가. */
export interface VideoExportSpec {
  srcRel: string;
  outRel: string;
  overwrite: boolean;
  range: { startMs: number; endMs: number } | null;
  mode: "copy" | "encode";
  speed: number | null;
  crop: { x: number; y: number; w: number; h: number } | null;
  crf: number | null;
  maxHeight: number | null;
  removeAudio: boolean;
  durationMs: number; // 진행률 분모 (probe 값)
  hasAudio: boolean;
}

export interface VideoExportProgress {
  jobId: string;
  projectId: string;
  percent: number;
  outTimeMs: number;
  speed: string | null;
}

export interface VideoExportFinished {
  jobId: string;
  projectId: string;
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  outRel: string;
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
/** 전역 메모(프로젝트 무관)를 담는 예약 키 — 프로젝트 id는 UUIDv4라 절대 충돌하지 않는다. */
export const GLOBAL_NOTES_ID = "__global__";

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
  storageMount: string; // 실제 측정한 볼륨의 마운트 지점("C:\\", "/"). 못 찾으면 ""
}

// ---- 리소스 모니터 팝업 (sys_process_snapshot, 태스크 05) ----
export interface ProcessSample {
  pid: number;
  name: string; // 실행 파일명 (Windows "chrome.exe", macOS "Google Chrome Helper" 등)
  cpu: number; // 0-100 — 코어수로 나눈 전역 스케일
  ram: number; // bytes
  gpu: number | null; // Windows PDH 3D 엔진 pid 집계, 그 외/비대상 null
  groupCount: number | null; // 프로그램별 합산 행이면 묶인 프로세스 수
  exePath?: string; // exe 절대경로 — 아이콘 키·파일 위치 열기. 미해결이면 생략
  diskBps?: number; // 디스크 read+write 바이트/초. 측정 불가면 생략
  groupPids?: number[]; // 그룹 모드에서 묶인 멤버 pid 전체(작업 끝내기 대상)
}
export interface ProcessSnapshot {
  totals: SysMetrics; // 팝업 헤더 게이지 — 별도 sys_metrics 호출 불필요(배치)
  processes: ProcessSample[]; // 정렬·Top-N 절단 완료
  totalCount: number; // 절단 전 행 수 ("… 외 N개")
}
export type ProcSortKey = "cpu" | "ram" | "gpu" | "disk";

// ---- 디스크 용량 분석 (disk_scan.rs — DOCS/disk-usage-analyzer-design.md) ----
export type DiskScanPhase = "idle" | "scanning" | "done" | "cancelled" | "error";
/** disk_scan_status 응답 + 스캔 진행 Channel 메시지 공용. */
export interface DiskScanStatus {
  phase: DiskScanPhase;
  root: string | null;
  bytes: number;
  alloc: number; // 디스크 할당 크기 합(압축·스파스 실측 — §2.2)
  files: number;
  dirs: number;
  skipped: number; // 권한 거부 등으로 못 들어간 폴더 수
  elapsedMs: number;
  done: boolean; // Channel 마지막 메시지 판별
  error: string | null;
}
export interface DiskDirRow {
  name: string;
  bytes: number; // 하위 전체 합산(스캔 캐시)
  alloc: number;
  files: number;
  dirs: number;
  modified: number | null; // epoch ms
}
export interface DiskFileRow {
  name: string;
  bytes: number;
  alloc: number;
  modified: number | null;
}
/** 트리맵 노드 — 자식은 상위 24개, 나머지는 otherBytes("기타"), 직속 파일은 ownBytes. */
export interface DiskTreemapNode {
  name: string;
  rel: string; // 스캔 루트 기준 — 드릴다운·탐색기 열기
  bytes: number;
  ownBytes: number;
  ownFiles: number;
  otherBytes: number;
  children: DiskTreemapNode[];
}
export interface DiskListing {
  bytes: number; // 이 폴더 합산(부모 % 계산용)
  dirs: DiskDirRow[]; // bytes 내림차순 정렬 완료
  files: DiskFileRow[]; // live read_dir, 1000 캡
  truncatedFiles: number; // "외 N개"
}
export interface DiskTopFile {
  path: string;
  bytes: number;
  modified: number | null;
}
export interface DiskRoot {
  mount: string;
  total: number;
  available: number;
}
/** 작업 끝내기 결과 — 종료 성공 수 + 실패(권한 부족) pid + 자기보호로 건너뛴 pid. */
export interface KillOutcome {
  killed: number;
  failed: number[];
  skipped: number[]; // 앱 자신·앱 번들 안 프로세스 — 시도조차 하지 않음
}

// ---- 시스템 정보 (sys_info_static — DOCS/task/31-sysmon-system-info.md §3.2) ----
// 전 필드가 Rust 구조체와 camelCase 1:1. 못 구한 항목은 null(플랫폼별로 다르다) —
// 이유는 SystemInfo.notes에 문장으로 담기고, 뷰가 "정보 없음" 툴팁에 쓴다.
export interface OsInfo {
  name: string;
  version: string;
  build: string;
  kernel: string;
  arch: string;
  hostName: string;
  bootTimeMs: number;
  uptimeSecs: number;
  installDate: string | null;
  userName: string | null;
}
export interface CpuInfo {
  brand: string;
  vendor: string;
  physicalCores: number | null;
  logicalCores: number;
  baseMhz: number | null;
  maxMhz: number | null;
  currentMhzAvg: number | null;
  cacheL1Kb: number | null;
  cacheL2Kb: number | null;
  cacheL3Kb: number | null;
}
export interface MemoryModule {
  slot: string;
  capacityBytes: number;
  speedMhz: number | null;
  manufacturer: string | null;
  partNumber: string | null;
}
export interface MemoryInfo {
  totalBytes: number;
  swapTotalBytes: number;
  modules: MemoryModule[]; // 슬롯별 물리 모듈 — Windows(CIM)만. 그 외는 빈 배열
}
export interface GpuInfo {
  name: string;
  driverVersion: string | null;
  driverDate: string | null;
  vramBytes: number | null;
  isDiscrete: boolean | null;
}
export interface BoardInfo {
  manufacturer: string;
  product: string;
  biosVendor: string;
  biosVersion: string;
  biosDate: string;
}
export interface VolumeInfo {
  name: string;
  mount: string;
  fs: string;
  kind: "ssd" | "hdd" | "unknown";
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
}
export interface AppInfo {
  version: string;
  tauriVersion: string;
  webviewVersion: string;
  buildProfile: "debug" | "release";
}
export interface SystemInfo {
  collectedAtMs: number;
  os: OsInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpus: GpuInfo[];
  board: BoardInfo | null;
  volumes: VolumeInfo[];
  app: AppInfo;
  notes: string[]; // 수집 실패 항목 사유("CIM: 시간 초과" 등)
}

// ---- Claude 사용량(rate_limits) — 좌측 하단 usage 바 ----
export interface UsageWindow {
  key: string; // five_hour / seven_day / seven_day_opus …
  usedPercentage: number;
  resetsAt: number | null; // epoch초 — 리셋까지 시간 계산용
}
export interface ClaudeUsage {
  windows: UsageWindow[];
  updatedAt: number; // 파일 마지막 갱신 epoch초 (오래되면 숨김)
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

/** 배치 폴더 나열(commands/tree.rs list_dirs) — 확장 상태 워밍용. */
export interface DirListing {
  relPath: string;
  entries: DirEntry[];
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

// ---- 헬스 조기경보 (health/) ----
export type HealthLevel = "ok" | "notice" | "warn" | "danger";

export interface HealthSample {
  anchorFullAvg10: number; // 메모리 압박 %(oomd 판정 입력)
  anchorSomeAvg10: number;
  killThreshold: number; // OS가 강제 종료하는 압박 % (기본 50)
  victimShare: number; // 0~1, 1에 가까울수록 종료 대상 1순위
  scopeMemBytes: number;
  scopeMemPct: number;
  scopeProcs: number; // 앱에 딸린 살아있는 프로세스 수(정상 5~40)
  memAvailablePct: number;
  swapUsedPct: number;
  available: boolean; // false면 이 플랫폼에서 신호를 못 읽음 → 경보 비활성
}

// ---- 화면 캡쳐 (commands/capture.rs) ----

export interface CaptureSession {
  id: string;
  /** 프리즈 프레임의 실제 픽셀 크기(모니터 물리 해상도). 좌표 환산의 분모다. */
  width: number;
  height: number;
  /** 표시 **전용** JPEG data URL. 최종 결과물은 여기서 뜨지 않는다(원본은 Rust에 남는다). */
  preview: string;
}

/** 잘라낼 영역 — 프레임 버퍼 로컬 픽셀. 가상 데스크톱 좌표가 아니다(음수 원점·혼합 DPI 회피). */
export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HealthSnapshot {
  level: HealthLevel;
  sample: HealthSample;
  reasons: string[]; // 이 레벨이 된 이유(사용자에게 그대로 보여준다)
}

/** health://level 이벤트 페이로드 — 레벨이 바뀔 때만 발행된다. */
export interface HealthTransition extends HealthSnapshot {
  prev: HealthLevel;
}

export interface PrevSessionRecord {
  pid: number;
  version: string;
  startedAt: string;
  updatedAt: string;
  cleanExit: boolean;
  level: HealthLevel;
  last: HealthSample;
}

export interface PrevSession {
  crashed: boolean;
  verdict: "clean" | "oom" | "panic" | "unknown";
  message: string;
  record: PrevSessionRecord | null;
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
  // 로컬 .html을 내장 브라우저에서 열 루프백 URL을 만든다(파일트리 우클릭 → "브라우저로 열기").
  // 반환된 http://127.0.0.1 URL은 classifyMode가 iframe 경로로 태워 렌더한다.
  // 폴더별 포트 캐시로 멱등이라 call(타임아웃+재시도)이 안전 — 응답 유실 시 영구 대기 방지.
  previewLocalUrl: (projectId: string, relPath: string) =>
    call<string>("preview_local_url", { projectId, relPath }),
  listDir: (projectId: string, relPath: string, lane: "interactive" | "background" = "interactive") =>
    call<DirEntry[]>("list_dir", { projectId, relPath }, { lane }),
  // 여러 폴더 배치 나열 — 프로젝트 전환/시작 시 저장된 확장 상태 워밍(개별 실패는 결과에서 빠짐).
  listDirs: (projectId: string, relPaths: string[]) =>
    call<DirListing[]>("list_dirs", { projectId, relPaths }, {
      lane: "background",
      attempts: 1,
      timeoutMs: 20_000,
    }),
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
  // 이름 바꾸기 — 같은 폴더 안에서 이름만. 성공 시 새 레포-상대 경로를 돌려준다.
  renamePath: (projectId: string, relPath: string, newName: string) =>
    callMutating<string>("rename_path", { projectId, relPath, newName }),
  // 이동 — 이름 그대로 다른 폴더로(트리 드래그 앤 드롭). destDir 빈 문자열 = 루트.
  movePath: (projectId: string, relPath: string, destDir: string) =>
    callMutating<string>("move_path", { projectId, relPath, destDir }),
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
  // ---- 동영상 편집 (video.rs) ----
  // 도구 상태 — ffmpeg -version 1회 스폰이라 재시도 없음, background lane.
  videoToolStatus: () =>
    call<VideoToolStatus>("video_tool_status", {}, { attempts: 1, lane: "background", timeoutMs: 10_000 }),
  // ffmpeg 앱 내 다운로드(40~111MB) — 설정 버튼 클릭으로만("클릭이 곧 동의"). 진행률은 Channel.
  videoToolEnsure: (onProgress?: (p: VideoEnsureProgress) => void) => {
    const ch = new Channel<string>();
    if (onProgress) {
      ch.onmessage = (raw) => {
        try {
          onProgress(JSON.parse(raw) as VideoEnsureProgress);
        } catch {
          /* 형식 오류 무시 */
        }
      };
    }
    return invoke<VideoToolStatus>("video_tool_ensure", { onProgress: ch });
  },
  // ffprobe 메타데이터 — 프로세스 스폰이라 재시도 없음(이중 스폰 방지).
  videoProbe: (projectId: string, relPath: string) =>
    call<VideoMeta>("video_probe", { projectId, relPath }, { attempts: 1, timeoutMs: 20_000 }),
  // 내보내기 — 장시간 잡. 진행·종결은 video:// 이벤트가 진실이고, 이 프라미스는 보조다
  // (Windows 응답 유실 대비 — events.ts가 이벤트만으로 UI를 정리한다). 재시도 절대 금지.
  videoExport: (projectId: string, jobId: string, spec: VideoExportSpec) =>
    callMutating<void>("video_export", { projectId, jobId, spec }, 6 * 60 * 60_000),
  // 멱등 취소 — 모르는 jobId는 no-op.
  videoExportCancel: (jobId: string) =>
    callMutating<void>("video_export_cancel", { jobId }, 10_000),
  // 현재 프레임 PNG 캡처 — 캔버스 불가(루프백이 cross-origin이라 taint) → ffmpeg 경유.
  videoCaptureFrame: (
    projectId: string,
    relPath: string,
    atMs: number,
    outRel: string,
    overwrite: boolean,
  ) =>
    callMutating<void>(
      "video_capture_frame",
      { projectId, relPath, atMs, outRel, overwrite },
      60_000,
    ),
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
  // 프로세스 아이콘 배치 조회 — 캐시에 없는 exe 경로만 추출(정적이라 세션당 1회). background 레인.
  getProcessIcons: (paths: string[]) =>
    call<Record<string, string>>(
      "get_process_icons",
      { paths },
      { lane: "background", attempts: 1, timeoutMs: 6000 },
    ),
  // 작업 끝내기 — pid 목록 종료(프론트가 파괴적 확인 후 호출). 실패 pid는 결과로 안내.
  killProcesses: (pids: number[]) =>
    callMutating<KillOutcome>("kill_processes", { pids }),
  // 시스템 정보 탭 — 탭을 열 때 1회 수집하고 백엔드가 캐시한다(force로 재수집).
  // PowerShell CIM/system_profiler 기동이 수 초라 타임아웃만 길게, 나머지는 폴링 커맨드와
  // 같은 규약(background 레인, 재시도 없음 — 실패는 "수집 실패"로 보여주고 사용자가 재시도).
  sysInfoStatic: (force = false) =>
    call<SystemInfo>(
      "sys_info_static",
      { force },
      { lane: "background", attempts: 1, timeoutMs: 30_000 },
    ),
  // ---- 디스크 용량 분석 (disk_scan.rs) ----
  // 스캔 대상 후보 볼륨 — 클릭 시 1회 열거.
  diskRoots: () =>
    call<DiskRoot[]>("disk_roots", undefined, { attempts: 1, timeoutMs: 10_000 }),
  // 스캔 시작 — 장시간 잡. 진행·종결은 Channel(250ms 스로틀, 마지막 메시지 done=true).
  // 스캔마다 새 Channel을 만든다(재사용 시 출력 영구 정지 — CLAUDE.md 함정).
  diskScanStart: (path: string, onProgress: (s: DiskScanStatus) => void) => {
    const ch = new Channel<string>();
    ch.onmessage = (raw) => {
      try {
        onProgress(JSON.parse(raw) as DiskScanStatus);
      } catch {
        /* 형식 오류 무시 */
      }
    };
    return invoke<void>("disk_scan_start", { path, onProgress: ch });
  },
  diskScanCancel: () => invoke<void>("disk_scan_cancel"),
  // 창 재오픈 시 재동기화 — 진행 중이면 진행값, 완료면 결과 요약.
  diskScanStatus: () =>
    call<DiskScanStatus>("disk_scan_status", undefined, {
      lane: "background",
      attempts: 1,
      timeoutMs: 4000,
    }),
  // 스캔 결과에서 폴더 1개의 자식 목록(폴더=캐시, 파일=live). 클릭 응답 — interactive 기본 레인.
  diskChildren: (rel: string) =>
    call<DiskListing>("disk_children", { rel }, { attempts: 1, timeoutMs: 20_000 }),
  diskTopFiles: (limit: number) =>
    call<DiskTopFile[]>("disk_top_files", { limit }, { attempts: 1, timeoutMs: 10_000 }),
  // 트리맵 — rel 하위 depth 레벨(레벨당 상위 24, 예산 1500 타일)을 중첩 JSON으로.
  diskTreemap: (rel: string, depth: number) =>
    call<DiskTreemapNode>("disk_treemap", { rel, depth }, { attempts: 1, timeoutMs: 20_000 }),
  // 파일 위치 열기 — 탐색기에서 폴더 열고 그 파일 선택(리소스 모니터).
  revealPath: (path: string) => callMutating<void>("reveal_path", { path }),

  // ---- 화면 캡쳐 (commands/capture.rs · DOCS/screen-capture-design.md) ----
  // 단축키와 같은 동작을 IPC로도 연다(설정의 "지금 캡쳐"·e2e).
  captureTrigger: () => invoke<void>("capture_trigger"),
  // 오버레이가 마운트 직후 현재 세션을 당겨 간다 — 창을 **처음 만든** 순간에는 아직 리스너가
  // 없어 capture://begin 이벤트가 유실되기 때문이다(두 경로가 같은 상태로 수렴).
  captureCurrent: () => invoke<CaptureSession | null>("capture_current"),
  // 새 프레임을 실제로 그린 뒤 부른다 → 백엔드가 그때 창을 띄운다. 먼저 띄우면 첫 캡쳐엔
  // 웹뷰 로딩 중 검은 전체화면이, 두 번째부터는 직전 캡쳐 잔상이 보인다.
  captureOverlayReady: (id: string) => invoke<void>("capture_overlay_ready", { id }),
  // 확정 — 원본에서 잘라 클립보드로 직행하고 오버레이를 닫는다. 픽셀이 프론트를 거치지 않는다.
  captureToClipboard: (id: string, rect: CaptureRect) =>
    invoke<void>("capture_to_clipboard", { id, rect }),
  captureCancel: (id: string) => invoke<void>("capture_cancel", { id }),
  // Claude 사용량 — statusline.js가 떨군 ~/.claude/gitpervisor-usage.json을 읽어 반환(없으면 null).
  claudeUsage: () =>
    call<ClaudeUsage | null>(
      "claude_usage",
      {},
      { lane: "background", attempts: 1, timeoutMs: 3000 },
    ),
  // 작업 완료 알림 본문용 — 프로젝트 최신 세션 트랜스크립트의 마지막 AI 텍스트(없으면 null).
  lastAgentMessage: (projectPath: string) =>
    call<string | null>(
      "last_agent_message",
      { projectPath },
      { lane: "background", attempts: 1, timeoutMs: 3000 },
    ),

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

  // ---- 헬스 조기경보 (health/mod.rs) ----
  // 현재 메모리 압박·프로세스 수 스냅샷. 백그라운드 레인 — 압박 상황에서 UI를 막지 않는다.
  healthSnapshot: () =>
    call<HealthSnapshot | null>("health_snapshot", undefined, {
      lane: "background",
      attempts: 1,
      timeoutMs: 6000,
    }),
  // 지난 실행이 비정상 종료(OOM 강제 종료 등)였는지 + 그 시점 상태.
  healthPrevSession: () =>
    call<PrevSession>("health_prev_session", undefined, {
      lane: "background",
      attempts: 1,
      timeoutMs: 6000,
    }),

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
