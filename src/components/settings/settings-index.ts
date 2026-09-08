// 설정 카테고리 + 검색 인덱스 (태스크 18). 검색·하이라이트·완전성 가드의 단일 진실.
// 필드 추가 시 SETTINGS_INDEX에 항목 하나 추가 — E2E 29가 Settings 런타임 키 커버리지를 가드한다.
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpCircle,
  Bell,
  Code2,
  Palette,
  SlidersHorizontal,
  Sparkles,
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
  | "ai"
  | "maintenance"
  | "update";

export const CATEGORIES: { id: SettingsCategory; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "일반", icon: SlidersHorizontal },
  { id: "appearance", label: "모양", icon: Palette },
  { id: "codetools", label: "코드 도구", icon: Code2 },
  { id: "terminal", label: "터미널", icon: TerminalSquare },
  { id: "notify", label: "알림", icon: Bell },
  { id: "maintenance", label: "유지보수", icon: Wrench },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "update", label: "업데이트", icon: ArrowUpCircle },
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

// Settings 전 필드(key 지정) + 시크릿 2 + 즉시 액션(다운로드·테스트·유지보수·업데이트).
// **완전성 가드(E2E 29 ⑤)가 getSettings 런타임 키를 이 배열의 non-null key와 대조한다** —
// Settings에 필드를 더하면 여기도 한 줄 더해야 스위트가 통과한다.
export const SETTINGS_INDEX: SettingIndexEntry[] = [
  // 일반
  { category: "general", key: "remoteRefreshMinutes", label: "원격 새로고침 주기", keywords: ["remote", "fetch", "새로고침", "주기", "pull"] },
  { category: "general", key: "confirmDiscard", label: "되돌리기·삭제 확인", keywords: ["confirm", "확인", "삭제", "되돌리기", "discard"] },
  { category: "general", key: "gitPath", label: "git 실행 파일 경로", keywords: ["git", "path", "경로", "실행"] },
  // 모양
  { category: "appearance", key: "theme", label: "테마", keywords: ["theme", "테마", "다크", "라이트", "색", "color", "monokai", "dracula", "nord", "커스텀", "내 테마", "custom"] },
  { category: "appearance", key: "diffFontSize", label: "Diff 폰트 크기", keywords: ["font", "폰트", "크기", "size", "diff"] },
  // 코드 도구
  { category: "codetools", key: "formatterRuffPath", label: "ruff 경로", keywords: ["ruff", "python", "포매터", "formatter", "린터", "linter"] },
  { category: "codetools", key: "formatterBiomePath", label: "biome 경로", keywords: ["biome", "prettier", "포매터", "formatter", "ts", "js", "css"] },
  { category: "codetools", key: "formatOnSave", label: "저장 시 자동 포맷", keywords: ["format", "포맷", "저장", "save"] },
  { category: "codetools", key: "formatterProjectLocal", label: "프로젝트 로컬 바이너리", keywords: ["node_modules", "venv", "local", "로컬", "바이너리"] },
  { category: "codetools", key: "lspEnabledProjects", label: "LSP 활성 프로젝트", keywords: ["lsp", "타입", "자동완성", "completion", "언어 서버", "basedpyright", "clangd", "rust-analyzer"] },
  { category: "codetools", key: "lspWorkspaceTsserver", label: "워크스페이스 TypeScript", keywords: ["tsserver", "typescript", "workspace", "워크스페이스"] },
  { category: "codetools", key: null, id: "lspDownload", label: "언어 서버 다운로드", keywords: ["lsp", "다운로드", "download", "설치"] },
  { category: "codetools", key: "videoFfmpegPath", label: "ffmpeg 경로", keywords: ["ffmpeg", "ffprobe", "동영상", "video", "비디오", "편집", "인코딩"] },
  { category: "codetools", key: null, id: "ffmpegDownload", label: "ffmpeg 다운로드", keywords: ["ffmpeg", "다운로드", "download", "동영상", "설치"] },
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
  { category: "notify", key: null, id: "healthAlert", label: "시스템 메모리 경보 표시", keywords: ["health", "메모리", "memory", "경보", "alert", "배너", "banner", "oom", "다시 보지 않기"] },
  // AI (로컬 LLM — 태스크 59). 다운로드·테스트는 즉시 액션(key null).
  { category: "ai", key: null, id: "llmRuntimeDownload", label: "AI 런타임 다운로드", keywords: ["llama", "llama.cpp", "런타임", "runtime", "다운로드", "download", "설치", "ai"] },
  { category: "ai", key: "llmModel", label: "AI 모델", keywords: ["model", "모델", "qwen", "gguf", "ai", "llm"] },
  { category: "ai", key: null, id: "llmModelDownload", label: "AI 모델 다운로드", keywords: ["model", "모델", "다운로드", "download", "gguf", "qwen"] },
  { category: "ai", key: null, id: "llmTest", label: "AI 테스트", keywords: ["test", "테스트", "ai", "응답", "확인"] },
  { category: "ai", key: null, id: "llmDeleteModels", label: "AI 모델 삭제", keywords: ["delete", "삭제", "모델", "model", "용량", "정리"] },
  { category: "ai", key: "llmProvider", label: "AI 제공자", keywords: ["provider", "제공자", "ollama", "lm studio", "외부", "external", "managed"] },
  { category: "ai", key: "llmCustomModelPath", label: "사용자 지정 GGUF 경로", keywords: ["custom", "gguf", "경로", "path", "모델"] },
  { category: "ai", key: "llmExternalUrl", label: "외부 서버 URL", keywords: ["url", "ollama", "external", "외부", "11434", "openai"] },
  { category: "ai", key: "llmExternalModel", label: "외부 서버 모델 이름", keywords: ["external", "외부", "모델", "model", "ollama"] },
  { category: "ai", key: "llmExternalKey", label: "외부 서버 API 키", keywords: ["key", "키", "api", "external", "외부"] },
  { category: "ai", key: "llmGpuLayers", label: "GPU 레이어", keywords: ["gpu", "ngl", "레이어", "layers", "vram", "오프로드"] },
  { category: "ai", key: "llmContext", label: "컨텍스트 길이", keywords: ["context", "컨텍스트", "ctx", "토큰", "길이"] },
  { category: "ai", key: "llmLanguage", label: "AI 출력 언어", keywords: ["language", "언어", "한국어", "english", "번역", "요약"] },
  { category: "ai", key: "llmBackend", label: "AI 백엔드", keywords: ["backend", "백엔드", "vulkan", "cpu", "gpu", "폴백"] },
  // 업데이트 (즉시 액션 — key null)
  { category: "update", key: null, id: "appUpdate", label: "앱 업데이트", keywords: ["update", "업데이트", "버전", "version", "새 버전", "설치", "upgrade"] },
  { category: "update", key: null, id: "autoUpdateCheck", label: "시작 시 자동 확인", keywords: ["auto", "자동", "확인", "check", "업데이트"] },
];

/** 질의가 항목에 매칭되나 — 레이블·키워드 부분일치(대소문자 무시). */
export function matchesEntry(e: SettingIndexEntry, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (e.label.toLowerCase().includes(needle)) return true;
  return e.keywords.some((k) => k.toLowerCase().includes(needle));
}
