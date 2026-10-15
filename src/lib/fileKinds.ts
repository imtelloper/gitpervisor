// 파일 트리 아래 종류별 탭(실행 파일·PDF·엑셀 …)의 분류 — 확장자 → 탭. 백엔드(commands/file_kinds.rs)는
// 확장자 목록만 받아 걷고, 어느 탭에 들지는 여기 한 곳이 정한다.

import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from "./language-map";
import type { TreeKindFile } from "./ipc";

export type FileKindTab = "exe" | "pdf" | "sheet" | "doc" | "image" | "video" | "audio" | "archive";

export const FILE_KIND_TABS: readonly FileKindTab[] = [
  "exe",
  "pdf",
  "sheet",
  "doc",
  "image",
  "video",
  "audio",
  "archive",
];

const FILE_KIND_EXTS: Record<FileKindTab, readonly string[]> = {
  // 트리 더블클릭 실행(EXEC_EXT)보다 넓다 — 여기는 "실행·설치 파일을 찾는" 목록이다.
  exe: ["exe", "msi", "bat", "cmd", "com", "ps1", "sh", "dmg", "pkg", "appimage", "deb", "rpm", "apk", "jar"],
  pdf: ["pdf"],
  sheet: ["xlsx", "xls", "xlsm", "xlsb", "csv", "tsv", "ods"],
  doc: ["doc", "docx", "hwp", "hwpx", "odt", "rtf", "ppt", "pptx", "odp"],
  image: [...IMAGE_EXT],
  video: [...VIDEO_EXT],
  audio: [...AUDIO_EXT],
  archive: ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"],
};

const TAB_OF_EXT = new Map<string, FileKindTab>(
  FILE_KIND_TABS.flatMap((tab) => FILE_KIND_EXTS[tab].map((ext) => [ext, tab] as const)),
);

/** 백엔드에 넘길 전체 확장자 — 목록은 고른 탭만 받고 개수는 모든 탭을 같이 센다. */
export const ALL_FILE_KIND_EXTS: readonly string[] = [...TAB_OF_EXT.keys()];

export function fileKindExts(tab: FileKindTab): readonly string[] {
  return FILE_KIND_EXTS[tab];
}

/** 백엔드 확장자별 개수 → 탭별 개수. */
export function fileKindTabCounts(counts: Record<string, number>): Map<FileKindTab, number> {
  const m = new Map<FileKindTab, number>();
  for (const [ext, n] of Object.entries(counts)) {
    const tab = TAB_OF_EXT.get(ext);
    if (tab) m.set(tab, (m.get(tab) ?? 0) + n);
  }
  return m;
}

export function fileKindOf(path: string): FileKindTab | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  // ".env"처럼 점으로 시작하는 이름은 확장자가 없다(백엔드 ext_lower와 같은 규칙).
  return dot > 0 ? (TAB_OF_EXT.get(base.slice(dot + 1).toLowerCase()) ?? null) : null;
}

export type FileKindSort = "name" | "size" | "mtime";

/** 이름순은 파일 이름(경로 아님) 기준, 같으면 경로로 — 폴더가 달라도 같은 이름끼리 모인다. */
export function sortKindFiles(files: TreeKindFile[], key: FileKindSort, desc: boolean): TreeKindFile[] {
  const name = (f: TreeKindFile) => f.path.slice(f.path.lastIndexOf("/") + 1);
  const cmp = (a: TreeKindFile, b: TreeKindFile): number => {
    switch (key) {
      case "name":
        return name(a).localeCompare(name(b), undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path);
      case "size":
        return a.size - b.size || a.path.localeCompare(b.path);
      case "mtime":
        return a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path);
      default: {
        const never: never = key;
        return never;
      }
    }
  };
  return [...files].sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
}
