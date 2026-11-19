import { useCallback, useEffect, useSyncExternalStore } from "react";

import { ipc, type FavEntry, type OsFileType, type OsTypeKind } from "./ipc";

/**
 * 폴더 창의 OS 파일 유형(아이콘·유형 이름) — 백엔드 `fav_os_file_types`(commands/os_file_type.rs)에서 받아 창이 떠 있는
 * 동안 기억한다. 질의는 **유형 하나에 하나**다: 확장자는 그 확장자 파일 하나가 대표, 폴더는 하나. 파일마다 아이콘이 다른
 * 것(실행 파일 내장 아이콘·바로가기·아이콘 파일·macOS 앱 번들)만 파일 단위로 묻고, 그 키엔 mtime 을 넣어 바뀌면 다시 받는다.
 * 그래서 수천 장 폴더도 첫 회에 수십 개만 묻고, 창 포커스마다 목록을 다시 읽어도 새로 생긴 유형만 묻는다.
 */

export type OsIconPx = 32 | 256;

/** 파일마다 아이콘이 다른 확장자 — 나머지는 확장자가 같으면 아이콘도 같다. */
const PER_FILE_ICON_EXT = new Set(["exe", "lnk", "ico", "url", "app"]);

/** `${px}|${key}` → 받은 결과. ponytail: 창이 떠 있는 동안 쌓기만 한다 — 대부분 확장자 키(수십 개)라 작고, 파일 키는
 *  실행 파일·바로가기뿐이다. 수만 개 실행 파일 폴더를 오래 보는 일이 생기면 LRU 로. */
const found = new Map<string, OsFileType>();
/** 묻는 중인 키 — 같은 키를 두 번 보내지 않게. 실패하면 지워 다음 목록 읽기에 다시 묻는다. */
const asking = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
const getVersion = () => version;

const NONE: OsFileType = { typeName: null, icon: null };

function queryOf(path: string, e: FavEntry): { key: string; kind: OsTypeKind } {
  const dot = e.name.lastIndexOf(".");
  const ext = dot > 0 ? e.name.slice(dot + 1).toLowerCase() : "";
  if (PER_FILE_ICON_EXT.has(ext)) return { key: `file:${path}|${e.mtimeMs}`, kind: "file" };
  if (e.isDir) return { key: "dir", kind: "folder" };
  return { key: `.${ext}`, kind: "ext" };
}

/** 한 번에 보내는 질의 수 — 백엔드 상한(512)의 절반. */
const CHUNK = 256;

/**
 * `entries` 의 유형을 받아 둔다(아직 없는 것만). 돌려주는 함수는 항목의 유형을 주거나, 아직 안 왔으면 undefined —
 * 그동안 부르는 쪽은 앱 아이콘·"EXT 파일"을 그린다. `entries` 가 null 이면 묻지 않는다(목록·그리드 중 안 보이는 쪽).
 */
export function useOsFileTypes(
  entries: FavEntry[] | null,
  pathOf: (name: string) => string,
  px: OsIconPx,
): (e: FavEntry) => OsFileType | undefined {
  const v = useSyncExternalStore(subscribe, getVersion);

  useEffect(() => {
    if (!entries?.length) return;
    const need = new Map<string, { path: string; kind: OsTypeKind }>();
    for (const e of entries) {
      const path = pathOf(e.name);
      const q = queryOf(path, e);
      const k = `${px}|${q.key}`;
      if (!found.has(k) && !asking.has(k) && !need.has(k)) need.set(k, { path, kind: q.kind });
    }
    if (!need.size) return;
    const list = [...need];
    for (const [k] of list) asking.add(k);
    for (let i = 0; i < list.length; i += CHUNK) {
      const chunk = list.slice(i, i + CHUNK);
      ipc.favOsFileTypes(
        chunk.map(([, q]) => q),
        px,
      ).then(
        (res) => {
          chunk.forEach(([k], j) => {
            asking.delete(k);
            found.set(k, res[j] ?? NONE);
          });
          version++;
          listeners.forEach((fn) => fn());
        },
        (err: unknown) => {
          for (const [k] of chunk) asking.delete(k);
          console.error("OS 파일 유형을 받지 못했습니다 — 앱 아이콘으로 보입니다:", err);
        },
      );
    }
  }, [entries, pathOf, px]);

  return useCallback(
    (e: FavEntry) => found.get(`${px}|${queryOf(pathOf(e.name), e).key}`),
    // v: 새 결과가 오면 함수가 바뀌어야 쓰는 쪽(정렬 memo·행)이 다시 그린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [v, px, pathOf],
  );
}
