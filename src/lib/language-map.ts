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
]);

/** 이미지로 렌더할 파일인지 (확장자 기준). svg도 이미지로 본다. */
export function isImage(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXT.has(base.slice(dot + 1).toLowerCase());
}
