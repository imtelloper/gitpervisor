import { useEffect, useState } from "react";

/**
 * 사진 뷰어 큰 그림 읽기(태스크 79 B3) — **최신 것만** + 이웃 미리 읽기 + 메모리 LRU.
 *
 * 큰 그림(`fav_read`, HEIC 는 4096 해독)은 백엔드 보기 줄(동시 2)에 선다. ←/→ 를 연타할 때마다 요청을 보내면 버릴 해독이
 * 그 줄에 쌓여 마지막 장이 그만큼 늦게 뜬다 — 그래서 뷰어 하나는 **동시에 하나만** 보내고(미리 읽기 포함, 남은 한 자리는
 * 글자 인식·편집기 몫), 진행 중이면 마지막으로 원한 장만 기억했다가 끝나면 보낸다. 보낸 요청은 끊을 수 없어 결과를 버린다
 * (성공이면 LRU 에는 넣는다 — 되돌아오면 쓰인다).
 */

export interface ViewerTarget {
  path: string;
  /** 경로 + 파일 정체(mtime·크기) — 같은 이름으로 다시 쓴 파일은 새로 읽는다. */
  key: string;
}

export type ViewerRead<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** 되돌아가기·다음 장을 즉시 — HEIC 변환본 base64 가 장당 ~4.6MB 라 6장 ≈ 30MB. */
export const VIEWER_LRU_MAX = 6;
/** 무게(base64 길이) 상한 — JPEG·PNG 는 원본을 통째로(최대 25MB → base64 ≈33MB) 받아 와 6장이면 200MB 가 된다. 방금 넣은 한 장은 넘어도 남긴다. */
export const VIEWER_LRU_MAX_WEIGHT = 64 * 1024 * 1024;

export function viewerImageTarget(
  path: string,
  stamp: { mtimeMs: number; size: number } | undefined,
  version?: string,
): ViewerTarget {
  return { path, key: `${path}|${stamp ? `${stamp.mtimeMs}-${stamp.size}` : (version ?? "")}` };
}

export interface ViewerImageLoader<T> {
  /** 지금 장. LRU 에 있으면 그 자리에서 `done`. 아니면 진행 중 요청이 끝난 뒤 보낸다 — 그새 또 `show` 하면 이것은 잊는다. */
  show(t: ViewerTarget, done: (r: ViewerRead<T>) => void): void;
  /** 다음 장 미리 읽기(null = 취소). 진행 중 요청이 없고 원하는 장도 없을 때만 나간다. */
  prefetch(t: ViewerTarget | null): void;
  /** 순서를 건드리지 않고 LRU 만 본다 — 렌더 중에 읽는다. */
  peek(key: string): T | undefined;
  /** 닫힘 — 기다리던 장·미리 읽기를 잊는다. 진행 중 요청의 결과는 버린다(StrictMode 이중 마운트 뒤 다시 `show` 해도 된다). */
  dispose(): void;
}

export function createViewerImageLoader<T>(
  read: (path: string) => Promise<T>,
  cap: number = VIEWER_LRU_MAX,
  weigh: (v: T) => number = () => 0,
  maxWeight: number = VIEWER_LRU_MAX_WEIGHT,
): ViewerImageLoader<T> {
  /** 삽입 순서 = 오래된 순. */
  const lru = new Map<string, T>();
  let weight = 0;
  let inflight: string | null = null;
  let want: { t: ViewerTarget; done: (r: ViewerRead<T>) => void } | null = null;
  let ahead: ViewerTarget | null = null;

  const put = (key: string, v: T) => {
    const prev = lru.get(key);
    if (prev !== undefined) weight -= weigh(prev);
    lru.delete(key);
    lru.set(key, v);
    weight += weigh(v);
    for (const [old, ov] of lru) {
      if ((lru.size <= cap && weight <= maxWeight) || old === key) break;
      lru.delete(old);
      weight -= weigh(ov);
    }
  };

  const settle = (key: string, r: ViewerRead<T>) => {
    inflight = null;
    if (r.ok) put(key, r.value);
    if (want?.t.key === key) {
      const w = want;
      want = null;
      w.done(r);
    }
    // 아니면 미리 읽기였거나 그새 다른 장으로 갔다. 실패는 여기서 버린다 — 그 장을 실제로 열면 다시 읽어 오류를 보인다.
    pump();
  };

  const pump = () => {
    if (inflight !== null) return;
    let t: ViewerTarget;
    if (want) t = want.t;
    else if (ahead) {
      t = ahead;
      ahead = null;
      if (lru.has(t.key)) return;
    } else return;
    const key = t.key;
    inflight = key;
    read(t.path).then(
      (value) => settle(key, { ok: true, value }),
      (error: unknown) => settle(key, { ok: false, error }),
    );
  };

  return {
    show(t, done) {
      // 진행 방향·자리가 바뀌었다 — 옛 이웃은 이 장이 뜬 뒤 다시 정한다.
      ahead = null;
      const hit = lru.get(t.key);
      if (hit !== undefined) {
        want = null;
        put(t.key, hit);
        done({ ok: true, value: hit });
        return;
      }
      want = { t, done };
      pump();
    },
    prefetch(t) {
      ahead = t; // 이미 LRU 에 있으면 pump 가 건너뛴다
      pump();
    },
    peek: (key) => lru.get(key),
    dispose() {
      want = null;
      ahead = null;
    },
  };
}

/**
 * 뷰어가 쓰는 판 — `cur` 를 읽어 돌려주고, `curShown`(지금 장이 그려졌다)이 되면 `ahead` 를 미리 읽는다.
 * 결과(`fav_read` 의 mime·base64·stamp·exifTiff)는 받은 객체 그대로다.
 */
export function useViewerImage<T>(
  read: (path: string) => Promise<T>,
  cur: ViewerTarget,
  ahead: ViewerTarget | null,
  curShown: boolean,
  weigh?: (v: T) => number,
): { value: T | null; error: unknown } {
  const [loader] = useState(() => createViewerImageLoader(read, VIEWER_LRU_MAX, weigh));
  const [got, setGot] = useState<{ key: string; r: ViewerRead<T> } | null>(null);

  useEffect(() => () => loader.dispose(), [loader]);

  const { path, key } = cur;
  useEffect(() => {
    loader.show({ path, key }, (r) => setGot({ key, r }));
  }, [loader, path, key]);

  const aheadPath = ahead?.path;
  const aheadKey = ahead?.key;
  useEffect(() => {
    loader.prefetch(curShown && aheadPath !== undefined && aheadKey !== undefined ? { path: aheadPath, key: aheadKey } : null);
  }, [loader, curShown, aheadPath, aheadKey]);

  const r = got?.key === key ? got.r : undefined;
  if (r) return r.ok ? { value: r.value, error: null } : { value: null, error: r.error };
  // LRU 에 있는 장은 효과를 기다리지 않고 이번 렌더에 바로 — 한 프레임이라도 미리보기가 비치지 않게.
  return { value: loader.peek(key) ?? null, error: null };
}
