// 설정 카테고리 + 검색 인덱스 (태스크 18). 검색·하이라이트·완전성 가드의 단일 진실.
// 필드 추가 시 SETTINGS_INDEX에 항목 하나 추가 — E2E 29가 Settings 런타임 키 커버리지를 가드한다.
import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Code2,
  Palette,
  SlidersHorizontal,
  TerminalSquare,
  Wrench,
} from "lucide-react";

import type { Settings } from "../../lib/ipc";

export type SettingsCategory =
  | "general"
  | "appearance"
  | "codetools"
  | "terminal"
  | "notify"
  | "maintenance";

export const CATEGORIES: { id: SettingsCategory; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "일반", icon: SlidersHorizontal },
  { id: "appearance", label: "모양", icon: Palette },
  { id: "codetools", label: "코드 도구", icon: Code2 },
  { id: "terminal", label: "터미널", icon: TerminalSquare },
  { id: "notify", label: "알림", icon: Bell },
  { id: "maintenance", label: "유지보수", icon: Wrench },
];

export interface SettingIndexEntry {
  category: SettingsCategory;
  /** 대응 Settings 필드. 즉시 액션·시크릿은 null. 완전성 가드(E2E)가 이 키 집합을 쓴다. */
  key: keyof Settings | null;
  /** key가 null인 항목(즉시 액션·시크릿)의 하이라이트 식별자. */
  id?: string;
  label: string;
  keywords: string[];
  /** 조건 렌더로 숨을 수 있는 필드의 부모 토글 — 그 토글이 꺼져 있으면 토글을 대신 하이라이트. */
  parentToggle?: keyof Settings;
}

// Settings 22필드 전부(key 지정) + 시크릿 2 + 즉시 액션 3 = 27항목.
export const SETTINGS_INDEX: SettingIndexEntry[] = [
  // 일반
  { category: "general", key: "remoteRefreshMinutes", label: "원격 새로고침 주기", keywords: ["remote", "fetch", "새로고침", "주기", "pull"] },
  { category: "general", key: "confirmDiscard", label: "되돌리기·삭제 확인", keywords: ["confirm", "확인", "삭제", "되돌리기", "discard"] },
  { category: "general", key: "gitPath", label: "git 실행 파일 경로", keywords: ["git", "path", "경로", "실행"] },
  // 모양
  { category: "appearance", key: "theme", label: "테마", keywords: ["theme", "테마", "다크", "라이트", "색", "color", "monokai", "dracula", "nord"] },
  { category: "appearance", key: "diffFontSize", label: "Diff 폰트 크기", keywords: ["font", "폰트", "크기", "size", "diff"] },
  // 코드 도구
  { category: "codetools", key: "formatterRuffPath", label: "ruff 경로", keywords: ["ruff", "python", "포매터", "formatter", "린터", "linter"] },
  { category: "codetools", key: "formatterBiomePath", label: "biome 경로", keywords: ["biome", "prettier", "포매터", "formatter", "ts", "js", "css"] },
  { category: "codetools", key: "formatOnSave", label: "저장 시 자동 포맷", keywords: ["format", "포맷", "저장", "save"] },
  { category: "codetools", key: "formatterProjectLocal", label: "프로젝트 로컬 바이너리", keywords: ["node_modules", "venv", "local", "로컬", "바이너리"] },
  { category: "codetools", key: "lspEnabledProjects", label: "LSP 활성 프로젝트", keywords: ["lsp", "타입", "자동완성", "completion", "언어 서버", "basedpyright", "clangd", "rust-analyzer"] },
  { category: "codetools", key: "lspWorkspaceTsserver", label: "워크스페이스 TypeScript", keywords: ["tsserver", "typescript", "workspace", "워크스페이스"] },
  { category: "codetools", key: null, id: "lspDownload", label: "언어 서버 다운로드", keywords: ["lsp", "다운로드", "download", "설치"] },
  // 터미널
  { category: "terminal", key: "terminalShell", label: "셸", keywords: ["shell", "셸", "pwsh", "powershell", "cmd", "bash"] },
  { category: "terminal", key: "terminalFontSize", label: "터미널 폰트 크기", keywords: ["font", "폰트", "크기", "terminal", "터미널"] },
  // 알림
  { category: "notify", key: "notifyMode", label: "AI 작업 완료 알림", keywords: ["notify", "알림", "ai", "완료", "os"] },
  { category: "notify", key: "slackEnabled", label: "Slack 알림", keywords: ["slack", "웹훅", "webhook"] },
  { category: "notify", key: null, id: "slackSecret", label: "Slack 웹훅 URL", keywords: ["slack", "url", "웹훅"], parentToggle: "slackEnabled" },
  { category: "notify", key: "emailEnabled", label: "이메일(SMTP) 알림", keywords: ["email", "이메일", "smtp", "메일"] },
  { category: "notify", key: "smtpHost", label: "SMTP 호스트", keywords: ["smtp", "host", "호스트", "메일"], parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpPort", label: "SMTP 포트", keywords: ["smtp", "port", "포트"], parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpFrom", label: "보내는 주소", keywords: ["smtp", "from", "보내는"], parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpTo", label: "받는 주소", keywords: ["smtp", "to", "받는"], parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpUsername", label: "SMTP 사용자명", keywords: ["smtp", "username", "사용자"], parentToggle: "emailEnabled" },
  { category: "notify", key: null, id: "smtpSecret", label: "SMTP 비밀번호", keywords: ["smtp", "password", "비밀번호"], parentToggle: "emailEnabled" },
  { category: "notify", key: "smtpTls", label: "TLS 암호화", keywords: ["tls", "암호화", "ssl", "smtp"], parentToggle: "emailEnabled" },
  // 유지보수 (즉시 액션 — key null)
  { category: "maintenance", key: null, id: "browserData", label: "브라우저 데이터 초기화", keywords: ["쿠키", "cookie", "로그아웃", "logout", "세션", "브라우저", "browser"] },
  { category: "maintenance", key: null, id: "crashLog", label: "진단 / 크래시 로그", keywords: ["crash", "panic", "로그", "log", "진단"] },
  { category: "maintenance", key: null, id: "quarantine", label: "macOS 격리 도구", keywords: ["quarantine", "격리", "macos", "brew"] },
];

/** 질의가 항목에 매칭되나 — 레이블·키워드 부분일치(대소문자 무시). */
export function matchesEntry(e: SettingIndexEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (e.label.toLowerCase().includes(needle)) return true;
  return e.keywords.some((k) => k.toLowerCase().includes(needle));
}
