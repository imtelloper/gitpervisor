// 편집 문서 영속 — 앱 데이터 사이드카에 자동저장하고, 열 때 자동 복원한다.
//
// 저장 위치는 `app_data_dir/image-docs/<sha256(projectId \0 relPath)>.json` 이다(41 §3.1).
// 레포 안에 두면 `git status --untracked-files=all` 에 올라 "레포 오염 0" 조건이 깨지고,
// `.git/info/exclude` 로 숨기려면 모든 쓰기 커맨드의 `.git` 거부와 충돌한다.
//
// **닫기 확인창이 사라진 이유가 여기 있다**: 닫아도 잃는 것이 없으면 물어볼 이유가 없다.
// 커밋마다 1초 디바운스로 저장하고, 창을 닫기 전에 flush 한다.
//
// 배경: DOCS/task/41-image-doc-persist-history.md §3.3

import { useCallback, useEffect, useRef, useState } from "react";

import { ipc, isIpcError } from "../ipc";
import type { DocHistory, HistoryLogEntry } from "./history";
import {
  parseImageDoc,
  serializeImageDoc,
  type ImageDocEnvelope,
} from "./schema";
import type { EditorDoc } from "./types";

/** 자동저장 디바운스 — 드래그 한 번(커밋 1칸)마다 파일을 쓰지 않게 묶는다. */
const DEBOUNCE_MS = 1000;
/** 명명 스냅샷 상한(시안 ⑤ '스냅샷 저장'). 넘으면 가장 오래된 것부터 버린다. */
const SNAPSHOT_LIMIT = 20;

export type PersistState = "clean" | "dirty" | "saving" | "error";

export interface LoadResult {
  doc: EditorDoc;
  log: HistoryLogEntry[];
  /** 원본 이미지가 저장 이후 바뀌었는가(stamp·크기 불일치). 배너로 알린다. */
  imageChanged: boolean;
}

export interface SnapshotInfo {
  name: string;
  at: number;
}

interface SnapshotFile {
  v: 2;
  items: { name: string; at: number; doc: EditorDoc }[];
}

export interface ImageDocPersist {
  /** 사이드카를 읽어 문서를 복원한다. 없으면 null. */
  load: (imageStamp: string | null, imageW: number, imageH: number) => Promise<LoadResult | null>;
  /** 커밋 뒤에 부른다 — 디바운스 저장을 예약한다. */
  markDirty: () => void;
  /** 지금 즉시 저장하고 끝날 때까지 기다린다(닫기·언로드 경로). */
  flush: () => Promise<void>;
  /** 제자리 평탄화가 성공했을 때 — 레이어가 이미지에 구워졌으므로 문서를 버린다. */
  deleteDoc: () => Promise<void>;
  saveSnapshot: (name: string) => Promise<void>;
  listSnapshots: () => Promise<SnapshotInfo[]>;
  loadSnapshot: (i: number) => Promise<EditorDoc | null>;
  state: PersistState;
  /** 마지막 저장 실패 메시지(있으면 배너·툴팁에 쓴다). */
  error: string | null;
}

/**
 * 편집 문서 자동 영속.
 *
 * 저장은 **단일 비행**이다 — 저장 중에 새 커밋이 오면 플래그만 세우고, 끝난 뒤 한 번 더 쓴다.
 * 그래야 드래그가 이어질 때 파일 쓰기가 쌓이지 않는다.
 */
export function useImageDocPersist(
  projectId: string | null,
  relPath: string | null,
  hist: { current: DocHistory },
  meta: { imageStamp: string | null; imageW: number; imageH: number },
): ImageDocPersist {
  const [state, setState] = useState<PersistState>("clean");
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const againRef = useRef(false);
  /** 사이드카 파일의 stamp — 다른 창이 먼저 저장했는지 대조한다. */
  const stampRef = useRef<string | null>(null);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const targetRef = useRef({ projectId, relPath });
  targetRef.current = { projectId, relPath };

  const envelopeOf = useCallback((): ImageDocEnvelope => {
    const t = targetRef.current;
    const m = metaRef.current;
    return {
      v: 2,
      projectId: t.projectId ?? "",
      relPath: t.relPath ?? "",
      imageStamp: m.imageStamp,
      imageW: m.imageW,
      imageH: m.imageH,
      savedAt: Date.now(),
      doc: hist.current.present,
      foreign: [],
      log: hist.current.log(),
    };
  }, [hist]);

  /** 실제 쓰기 한 번. Conflict 는 호출부가 판단하도록 그대로 던진다. */
  const writeNow = useCallback(async () => {
    const t = targetRef.current;
    if (!t.projectId || !t.relPath) return;
    const json = serializeImageDoc(envelopeOf());
    const stamp = await ipc.imageDocWrite(
      t.projectId,
      t.relPath,
      "doc",
      json,
      stampRef.current ?? undefined,
    );
    stampRef.current = stamp;
  }, [envelopeOf]);

  const runSave = useCallback(async () => {
    if (inFlightRef.current) {
      againRef.current = true;
      return inFlightRef.current;
    }
    const p = (async () => {
      try {
        setState("saving");
        await writeNow();
        setError(null);
        setState(againRef.current ? "dirty" : "clean");
      } catch (e) {
        // 충돌은 "다른 창이 먼저 저장했다"는 뜻이다 — 조용히 덮지 않는다.
        const conflict = isIpcError(e) && e.code === "CONFLICT";
        setError(
          conflict
            ? "다른 창에서 이 이미지의 편집 문서를 저장했습니다."
            : (e as Error)?.message || "편집 문서 저장 실패",
        );
        setState("error");
      } finally {
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    await p;
    if (againRef.current) {
      againRef.current = false;
      await runSave();
    }
  }, [writeNow]);

  const markDirty = useCallback(() => {
    if (!targetRef.current.projectId || !targetRef.current.relPath) return;
    setState((s) => (s === "saving" ? s : "dirty"));
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runSave();
    }, DEBOUNCE_MS);
  }, [runSave]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await runSave();
  }, [runSave]);

  const load = useCallback(
    async (imageStamp: string | null, imageW: number, imageH: number): Promise<LoadResult | null> => {
      const t = targetRef.current;
      if (!t.projectId || !t.relPath) return null;
      const res = await ipc.imageDocRead(t.projectId, t.relPath, "doc");
      stampRef.current = res.stamp;
      if (!res.json) return null;
      let env: ImageDocEnvelope;
      try {
        env = parseImageDoc(res.json).env;
      } catch (e) {
        // 상위 버전·손상 — 덮어쓰지 않는다. 저장은 사용자가 편집을 시작할 때 다시 시도한다.
        setError((e as Error)?.message || "편집 문서를 읽을 수 없습니다");
        setState("error");
        return null;
      }
      const imageChanged =
        (env.imageStamp !== null && imageStamp !== null && env.imageStamp !== imageStamp) ||
        (env.imageW > 0 && env.imageW !== imageW) ||
        (env.imageH > 0 && env.imageH !== imageH);
      return { doc: env.doc, log: env.log, imageChanged };
    },
    [],
  );

  const deleteDoc = useCallback(async () => {
    const t = targetRef.current;
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!t.projectId || !t.relPath) return;
    await ipc.imageDocDelete(t.projectId, t.relPath);
    stampRef.current = null;
    setState("clean");
  }, []);

  const readSnapshots = useCallback(async (): Promise<SnapshotFile> => {
    const t = targetRef.current;
    if (!t.projectId || !t.relPath) return { v: 2, items: [] };
    const res = await ipc.imageDocRead(t.projectId, t.relPath, "snapshots");
    if (!res.json) return { v: 2, items: [] };
    try {
      const parsed = JSON.parse(res.json) as SnapshotFile;
      return Array.isArray(parsed?.items) ? { v: 2, items: parsed.items } : { v: 2, items: [] };
    } catch {
      return { v: 2, items: [] };
    }
  }, []);

  const saveSnapshot = useCallback(
    async (name: string) => {
      const t = targetRef.current;
      if (!t.projectId || !t.relPath) return;
      const file = await readSnapshots();
      // 스냅샷은 **별도 파일**이다 — 자동저장 경로에 섞이면 매 저장이 20벌을 다시 쓴다(41 §3.1).
      file.items.push({ name, at: Date.now(), doc: hist.current.present });
      if (file.items.length > SNAPSHOT_LIMIT) {
        file.items.splice(0, file.items.length - SNAPSHOT_LIMIT);
      }
      await ipc.imageDocWrite(t.projectId, t.relPath, "snapshots", JSON.stringify(file));
    },
    [hist, readSnapshots],
  );

  const listSnapshots = useCallback(
    async (): Promise<SnapshotInfo[]> =>
      (await readSnapshots()).items.map((s) => ({ name: s.name, at: s.at })),
    [readSnapshots],
  );

  const loadSnapshot = useCallback(
    async (i: number): Promise<EditorDoc | null> => {
      const file = await readSnapshots();
      return file.items[i]?.doc ?? null;
    },
    [readSnapshots],
  );

  // 창이 닫히기 전 마지막 한 번 — doc 창은 X 로 바로 사라지므로 여기서 못 쓰면 잃는다.
  useEffect(() => {
    const onHide = () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        void runSave();
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      onHide();
    };
  }, [runSave]);

  return {
    load,
    markDirty,
    flush,
    deleteDoc,
    saveSnapshot,
    listSnapshots,
    loadSnapshot,
    state,
    error,
  };
}
