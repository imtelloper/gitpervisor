// 앱 밖(탐색기·바탕화면)에서 파일 트리 폴더로 끌어 놓은 파일·폴더 복사 — 내용을 조각으로 읽어 보낸다(tree_import.rs 머리 주석).
import { ipc, isIpcError, errorMessage } from "./ipc";
import { joinPath } from "./path";

/** 끌어 놓은 항목 하나 — `rel`은 놓은 폴더 기준 상대 경로, `file`이 없으면 폴더. 폴더가 그 안 항목보다 앞에 온다. */
export interface DroppedItem {
  rel: string;
  file?: File;
}

/** 조각 크기 — IPC 한 번이 너무 크면 웹뷰가 사본을 오래 붙잡고, 너무 작으면 왕복이 늘어난다. */
const CHUNK_BYTES = 8 * 1024 * 1024;

function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // readEntries 는 한 번에 일부(Chromium 100개)만 준다 — 빈 배열이 올 때까지 다시 부른다.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/**
 * 드롭 항목에서 엔트리(폴더째 걸을 수 있음)를, 없으면 파일만 뜬다. drop 이벤트 안에서 **동기로** 불러야 한다 — 이벤트가
 * 끝나면 dataTransfer 가 비워진다. `webkitGetAsEntry()`가 null 인 드롭이 있다(CDP 합성 드롭 실측) — 그때 버리면 놓아도
 * 아무 일이 없으므로 파일로라도 받는다(폴더는 이 경로로 못 받는다).
 */
export function droppedSources(dt: DataTransfer): (FileSystemEntry | File)[] {
  return Array.from(dt.items).flatMap((it): (FileSystemEntry | File)[] => {
    if (it.kind !== "file") return [];
    const entry = it.webkitGetAsEntry();
    if (entry) return [entry];
    const file = it.getAsFile();
    return file ? [file] : [];
  });
}

/** 드롭 원천 → 복사할 항목들(폴더는 재귀). */
export async function collectDropped(entries: readonly (FileSystemEntry | File)[]): Promise<DroppedItem[]> {
  const out: DroppedItem[] = [];
  const walk = async (entry: FileSystemEntry, rel: string) => {
    if (entry.isFile) out.push({ rel, file: await entryFile(entry as FileSystemFileEntry) });
    else if (entry.isDirectory) {
      out.push({ rel });
      for (const child of await readAllEntries(entry as FileSystemDirectoryEntry)) await walk(child, `${rel}/${child.name}`);
    }
  };
  for (const e of entries) {
    // 이름에 경로가 섞여 오면(구분자) 마지막 조각만 — 놓은 폴더 밖으로 새지 않게(Rust 도 경로 탈출은 막는다).
    if (e instanceof File) out.push({ rel: e.name.split(/[\\/]/).pop() || e.name, file: e });
    else await walk(e, e.name);
  }
  return out;
}

export interface ImportResult {
  copied: number;
  /** 이미 있는 이름이라 건너뛴 파일(rel) — 호출자가 덮어쓸지 묻는다. */
  conflicts: string[];
  failed: { rel: string; error: string }[];
}

async function copyOne(projectId: string, dest: string, file: File, overwrite: boolean, onBytes: (n: number) => void) {
  const id = await ipc.treeImportBegin(projectId, dest, file.size, overwrite);
  try {
    // 크기가 0이어도 한 번은 읽는다 — 원본이 그새 지워졌거나 못 읽는 파일은 size 0 으로 오는데(CDP 합성 드롭 실측), 읽지
    // 않으면 실패를 못 보고 빈 파일을 만들어 "복사됨"이라 알린다. 읽기가 실패하면 여기서 던진다.
    let off = 0;
    do {
      const bytes = new Uint8Array(await file.slice(off, off + CHUNK_BYTES).arrayBuffer());
      await ipc.treeImportChunk(id, off, bytes);
      onBytes(bytes.length);
      off += CHUNK_BYTES;
    } while (off < file.size);
    await ipc.treeImportFinish(id);
  } catch (e) {
    // 조각이나 마무리에서 실패하면 임시 파일을 거둔다(마무리 실패는 Rust 가 이미 지웠다 — 그때 abort 는 no-op).
    await ipc.treeImportAbort(id).catch((ae) => console.warn("[tree-import] abort 실패", ae));
    throw e;
  }
}

/**
 * 항목들을 `destDir`(프로젝트 상대, 루트는 "") 아래로 복사한다. 이미 있는 폴더는 합치고(그 안에 복사), 이미 있는
 * 파일은 `overwrite`가 아니면 건너뛰어 `conflicts`로 돌려준다. 한 파일의 실패가 나머지를 막지 않는다.
 */
export async function importDropped(
  projectId: string,
  destDir: string,
  items: readonly DroppedItem[],
  overwrite: boolean,
  onBytes: (n: number) => void,
): Promise<ImportResult> {
  const r: ImportResult = { copied: 0, conflicts: [], failed: [] };
  const brokenDirs: string[] = [];
  for (const it of items) {
    if (brokenDirs.some((d) => it.rel.startsWith(`${d}/`))) continue;
    const dest = joinPath(destDir, it.rel);
    try {
      if (!it.file) {
        await ipc.createDir(projectId, dest).catch((e) => {
          // 같은 이름 폴더가 이미 있으면 그 안에 합친다(탐색기와 같다). 같은 이름 **파일**이면 안쪽 복사가 실패로 잡힌다.
          if (!(isIpcError(e) && e.code === "ALREADY_EXISTS")) throw e;
        });
      } else {
        await copyOne(projectId, dest, it.file, overwrite, onBytes);
        r.copied++;
      }
    } catch (e) {
      if (it.file && isIpcError(e) && e.code === "ALREADY_EXISTS") r.conflicts.push(it.rel);
      else {
        r.failed.push({ rel: it.rel, error: errorMessage(e) });
        if (!it.file) brokenDirs.push(it.rel);
      }
    }
  }
  return r;
}
