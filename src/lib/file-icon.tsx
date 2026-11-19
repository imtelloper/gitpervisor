import {
  Database,
  Disc,
  File,
  FileArchive,
  FileCog,
  FileImage,
  FileMusic,
  FilePlay,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FlaskConical,
  Folder,
  FolderOpen,
  Presentation,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  SiC,
  SiCplusplus,
  SiGnubash,
  SiGo,
  SiHtml5,
  SiJavascript,
  SiJson,
  SiMarkdown,
  SiPython,
  SiReact,
  SiRust,
  SiSqlite,
  SiToml,
  SiTypescript,
  SiYaml,
} from "react-icons/si";

type IconComponent = ComponentType<{
  size?: number;
  color?: string;
  className?: string;
}>;

export interface FileIcon {
  Icon: IconComponent;
  color: string;
}

/** 폴더 아이콘 (펼침 여부에 따라). */
export function folderIcon(open: boolean): FileIcon {
  return { Icon: open ? FolderOpen : Folder, color: "#7AA7D9" };
}

const group = (exts: string[], icon: FileIcon): Record<string, FileIcon> =>
  Object.fromEntries(exts.map((e) => [e, icon]));

/** 확장자 → 언어/타입 아이콘 + 브랜드 색 (다크 배경 가독성 기준으로 조정).
 *  문서·압축·미디어·설치 파일은 다운로드 폴더 창이 종류를 한눈에 가르게 하려고 둔다(사용자 요청 2026-11-16). */
const BY_EXT: Record<string, FileIcon> = {
  ...group(["pdf"], { Icon: FileText, color: "#E5534B" }),
  ...group(["doc", "docx", "rtf", "odt", "hwp", "hwpx"], { Icon: FileText, color: "#4F8BD6" }),
  ...group(["xls", "xlsx", "xlsm", "csv", "ods"], { Icon: FileSpreadsheet, color: "#3FA36B" }),
  ...group(["ppt", "pptx", "odp", "key"], { Icon: Presentation, color: "#E07A3F" }),
  ...group(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "egg", "alz"], { Icon: FileArchive, color: "#D9A441" }),
  ...group(["mp4", "mov", "mkv", "avi", "webm", "wmv", "m4v"], { Icon: FilePlay, color: "#E06C9F" }),
  ...group(["mp3", "wav", "flac", "m4a", "ogg", "aac", "wma"], { Icon: FileMusic, color: "#5FB3B3" }),
  ...group(["exe", "msi", "dll", "apk", "dmg", "pkg", "deb", "rpm", "appimage"], { Icon: FileCog, color: "#8B9BB4" }),
  ...group(["bat", "cmd", "ps1"], { Icon: FileTerminal, color: "#5391FE" }),
  ...group(["iso", "img"], { Icon: Disc, color: "#8B9BB4" }),
  ...group(["ttf", "otf", "woff", "woff2"], { Icon: FileType, color: "#9CA3AF" }),
  ...group(["webp", "bmp", "heic", "heif", "avif", "tif", "tiff", "jfif"], { Icon: FileImage, color: "#A78BFA" }),
  ai: { Icon: FileImage, color: "#F29B38" },
  psd: { Icon: FileImage, color: "#31A8FF" },
  py: { Icon: SiPython, color: "#4B8BBE" },
  ts: { Icon: SiTypescript, color: "#3178C6" },
  tsx: { Icon: SiReact, color: "#61DAFB" },
  js: { Icon: SiJavascript, color: "#F7DF1E" },
  jsx: { Icon: SiReact, color: "#61DAFB" },
  rs: { Icon: SiRust, color: "#D5A285" },
  cpp: { Icon: SiCplusplus, color: "#5C9FD8" },
  cc: { Icon: SiCplusplus, color: "#5C9FD8" },
  cxx: { Icon: SiCplusplus, color: "#5C9FD8" },
  hpp: { Icon: SiCplusplus, color: "#5C9FD8" },
  c: { Icon: SiC, color: "#A8B9CC" },
  h: { Icon: SiC, color: "#A8B9CC" },
  go: { Icon: SiGo, color: "#00ADD8" },
  json: { Icon: SiJson, color: "#CBCB41" },
  md: { Icon: SiMarkdown, color: "#9CA3AF" },
  yml: { Icon: SiYaml, color: "#CB4B4B" },
  yaml: { Icon: SiYaml, color: "#CB4B4B" },
  toml: { Icon: SiToml, color: "#B0857A" },
  html: { Icon: SiHtml5, color: "#E34F26" },
  sh: { Icon: SiGnubash, color: "#89E051" },
  bash: { Icon: SiGnubash, color: "#89E051" },
  db: { Icon: SiSqlite, color: "#5191C9" },
  sqlite: { Icon: SiSqlite, color: "#5191C9" },
  sqlite3: { Icon: SiSqlite, color: "#5191C9" },
  txt: { Icon: FileText, color: "#9CA3AF" },
  log: { Icon: FileText, color: "#9CA3AF" },
  png: { Icon: FileImage, color: "#A78BFA" },
  jpg: { Icon: FileImage, color: "#A78BFA" },
  jpeg: { Icon: FileImage, color: "#A78BFA" },
  gif: { Icon: FileImage, color: "#A78BFA" },
  svg: { Icon: FileImage, color: "#A78BFA" },
  ico: { Icon: FileImage, color: "#A78BFA" },
};

const DB_GENERIC = new Set(["sql", "mdb"]);
// 테스트 파일: test_x.py / x_test.go / x.test.ts / x.spec.tsx 등
const TEST_RE = /(^test[._-])|([._-](test|spec)\.)|(_test\.)/i;

export function fileIcon(path: string): FileIcon {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";

  if (TEST_RE.test(base)) return { Icon: FlaskConical, color: "#62B543" };
  if (DB_GENERIC.has(ext)) return { Icon: Database, color: "#C97B5A" };
  return BY_EXT[ext] ?? { Icon: File, color: "#9CA3AF" };
}
