import { Database, File, FileImage, FileText, FlaskConical } from "lucide-react";
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

interface FileIcon {
  Icon: IconComponent;
  color: string;
}

/** 확장자 → 언어/타입 아이콘 + 브랜드 색 (다크 배경 가독성 기준으로 조정). */
const BY_EXT: Record<string, FileIcon> = {
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
