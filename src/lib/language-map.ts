const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  go: "go",
  rb: "ruby",
  php: "php",
  zig: "zig",
  swift: "swift",
  json: "json",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini", // production.env 등 — KEY=value + # 주석은 ini 토크나이저가 잘 처리
  properties: "ini",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
};

export function languageOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (/^dockerfile$/i.test(base)) return "dockerfile";
  // .env / .env.local / .env.production … — dotfile이라 확장자 규칙에 안 걸려 별도 처리.
  if (base === ".env" || base.startsWith(".env.")) return "ini";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

// 뷰어가 이미지로 여는 확장자.
//
// 동영상과 같은 원칙 — **확장자 목록은 "표시를 시도할 대상"이지 디코드 보장이 아니다.**
// tiff/heic는 macOS 웹뷰(WKWebView·ImageIO)에선 그려지지만 Windows(WebView2·Chromium)에선
// 디코드가 실패한다(실측). 그래도 목록에 두는 편이 낫다 — 빼면 "바이너리 파일"이라는 엉뚱한
// 안내가 나오고, 넣으면 macOS에선 제대로 보이고 Windows에선 ImageView가 형식 미지원임을
// 알리며 외부 앱으로 넘겨준다.
const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "svg",
  "tif",
  "tiff",
  "heic",
  "heif",
]);

/** 이미지로 렌더할 파일인지 (확장자 기준). svg도 이미지로 본다. */
export function isImage(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXT.has(base.slice(dot + 1).toLowerCase());
}

// 뷰어가 <video>/<audio>로 재생을 시도하는 확장자.
//
// **확장자는 컨테이너일 뿐 코덱을 보장하지 않는다.** 재생 가능 여부는 앱이 아니라 각 OS의
// 웹뷰 엔진이 정한다(macOS WKWebView는 WebM/VP9가 안 될 수 있고, Linux WebKitGTK는 설치된
// GStreamer 플러그인에 좌우된다). 그래서 이 목록은 "재생을 시도할 대상"이고, 실패는
// MediaView가 코덱 미지원으로 안내하며 외부 앱 열기로 넘긴다.
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm", "ogv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "flac", "oga", "ogg"]);

function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 뷰어에서 재생할 동영상인가. */
export function isVideo(path: string): boolean {
  return VIDEO_EXT.has(extOf(path));
}

/** 뷰어에서 재생할 오디오인가. */
export function isAudio(path: string): boolean {
  return AUDIO_EXT.has(extOf(path));
}

/** 재생 대상(동영상·오디오) 전체 — 라우팅·diff 게이팅에서 함께 쓴다. */
export function isPlayable(path: string): boolean {
  return isVideo(path) || isAudio(path);
}

// 브라우저로 렌더 가능한 HTML 문서 확장자만. languageOf(path)==="html"은 .vue/.svelte도
// 잡지만 그건 렌더 가능한 페이지가 아니라 별도로 좁게 판정한다.
const HTML_EXT = new Set(["html", "htm", "xhtml"]);

/** 내장 브라우저로 열 수 있는 HTML 문서인지 (확장자 기준). */
export function isHtml(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return HTML_EXT.has(base.slice(dot + 1).toLowerCase());
}
