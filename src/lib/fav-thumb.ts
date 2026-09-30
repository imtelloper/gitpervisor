import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { ipc, type FavEntry } from "./ipc";

/**
 * 즐겨찾기·폴더 창 썸네일 URL — 썸네일 전용 스킴 `gpvthumb`(commands/thumb_protocol.rs).
 *
 * `<img src>` 로 바로 받는다. 예전에는 `fav_thumb` IPC 가 base64 data URL 을 돌려줘서, 3천 장 폴더에서
 * 썸네일이 `call` 의 앱 공유 동시 슬롯을 다 먹고(다른 IPC 가 줄을 섰다) 응답마다 React 상태를 복사했다.
 * 이제 로딩·디코딩·동시성은 브라우저 몫이다.
 */

/** 스킴 토큰은 프로세스마다 하나라 창마다 한 번만 묻는다. 실패하면 다음 마운트가 다시 묻는다. */
let tokenOnce: Promise<string> | null = null;

/** 토큰이 오기 전(첫 렌더)은 null — 그동안 칸은 아이콘이다. */
export function useFavThumbToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    tokenOnce ??= ipc.favThumbToken();
    tokenOnce.then(
      (t) => {
        if (!dead) setToken(t);
      },
      (e: unknown) => {
        tokenOnce = null;
        console.error("썸네일 토큰을 받지 못했습니다 — 썸네일 없이 아이콘만 보입니다:", e);
      },
    );
    return () => {
      dead = true;
    };
  }, []);
  return token;
}

/** 썸네일 한 변 — 백엔드가 **이 셋만** 받는다(캐시 폭주 방지). */
export type ThumbEdge = 128 | 192 | 320;

/** URL 에 파일 스탬프(mtime·크기)가 들어간다 — 같은 이름으로 다시 쓴 파일은 URL 이 바뀌어 새로 받고,
 *  그래서 백엔드가 `immutable` 로 캐시시켜도 안전하다. 백엔드 디스크 캐시 키도 같은 셋이다. */
export function favThumbUrl(path: string, e: FavEntry, edge: ThumbEdge, token: string): string {
  return `${convertFileSrc(path, "gpvthumb")}?e=${edge}&t=${token}&v=${e.mtimeMs}-${e.size}`;
}

// ---- 받은 썸네일 기억 · 미리 받기 (폴더 창 그리드) ---------------------------------------------
//
// 가상 그리드는 스크롤할 때마다 칸을 새로 마운트한다. 칸이 늘 "로딩 중"으로 시작하면 캐시에 있는 그림도
// `onLoad` 까지 한 프레임 이상 아이콘이 비치고, 아직 안 받은 칸은 화면에 들어온 **뒤에야** 요청이 나갔다 —
// 스크롤을 내리고 올릴 때마다 "새로 불러오는" 체감이 그것이었다. 그래서 칸은 요청하지 않고 여기 상태만 읽는다:
// 받는 일은 미리 받기 한 곳이 보는 위치에서 가까운 순서로 하고, 받은 URL 은 처음부터 그림으로 그린다.

/** 한 번 뜬 썸네일 URL. ponytail: 창이 떠 있는 동안 URL 문자열만 쌓인다(장당 ~200B — 10만 장에 ~20MB).
 *  넘치면 이것도 LRU 로. */
const thumbLoaded = new Set<string>();
/** 못 만드는 형식(svg·손상 → 4xx). URL 에 파일 스탬프가 들어 있어 다시 쓴 파일은 새 URL 로 다시 시도된다. */
const thumbFailed = new Set<string>();
/** 받은 `Image` 를 쥐고 있는 LRU(삽입 순서 = 오래된 순). 쥐고 있는 동안은 브라우저 메모리 캐시에 남아, 같은 URL 의
 *  새 `<img>` 가 그 자리에서 `complete` 다 — 놓으면 다시 읽는 한 박자가 빈 칸으로 비친다(아이콘은 아니다).
 *
 *  상한은 **장수**로 둔다. 2026-09-30 실측(WebView2 154, 670×1610 JPEG 3천 장, 렌더러 private bytes): 받은 `Image`
 *  3천 장을 쥐면 192 에서 +38MB·320 에서 +41MB(장당 ~13KB — 인코딩된 JPEG 와 부속 객체), 놓고 GC 하면 그만큼
 *  돌아온다(= 쥐지 않으면 브라우저도 안 쥔다). `decode()` 를 불러도 늘지 않았다 — 디코드된 픽셀은 크로뮴이 자기
 *  예산으로 버리는 캐시에 들어, 여기서 쥘 수도 없고 쥘 필요도 없다(칸의 `decoding="sync"` 가 그리는 프레임에
 *  다시 푼다). 그래서 6,500장 ≈ 85MB 가 최악이다. 미리 받기 창(2 × PREFETCH_SPAN + 한 화면)보다 커야 한 폴더에서
 *  받은 것을 스스로 밀어내지 않는다. */
const thumbKept = new Map<string, HTMLImageElement>();
const THUMB_KEEP_MAX = 6500;
const thumbListeners = new Map<string, Set<() => void>>();

export type FavThumbState = "wait" | "ok" | "fail";
const thumbStateOf = (url: string | undefined): FavThumbState =>
  url === undefined ? "wait" : thumbLoaded.has(url) ? "ok" : thumbFailed.has(url) ? "fail" : "wait";

/** 칸 하나의 썸네일 상태 — 미리 받기가 그 URL 을 끝내면 다시 그린다. `undefined`(토큰 전·폴더·이미지 아님)는 "wait". */
export function useFavThumbState(url: string | undefined): FavThumbState {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (url === undefined) return () => {};
      let set = thumbListeners.get(url);
      if (!set) thumbListeners.set(url, (set = new Set()));
      set.add(cb);
      return () => {
        set.delete(cb);
        if (!set.size) thumbListeners.delete(url);
      };
    },
    [url],
  );
  return useSyncExternalStore(subscribe, () => thumbStateOf(url));
}

/** 화면에 그린 썸네일을 LRU 맨 뒤로 — 보고 있는 것이 먼저 밀려나지 않게. */
export function touchFavThumb(url: string): void {
  const img = thumbKept.get(url);
  if (img) {
    thumbKept.delete(url);
    thumbKept.set(url, img);
  }
}

/** 동시에 받는 수 = 백엔드 작은 이미지 디코드 슬롯의 상한(commands/favorites.rs `small_slot_count`, 최대 8).
 *  더 보내 봐야 백엔드 세마포어 줄에 서고, 그 줄은 스크롤을 옮겨도 순서가 안 바뀐다. */
const PREFETCH_SLOTS = 8;
/** ponytail: 보이는 범위에서 위아래로 이만큼까지만 미리 받는다 — 3천 장 폴더는 어디를 보든 통째로 든다. 그보다 큰
 *  폴더는 멀리 있는 칸이 가까워진 뒤에 받는다(여전히 가까운 순서로). 올리려면 THUMB_KEEP_MAX 도 함께 — 2 × 이 값
 *  + 한 화면 이상이어야 받은 것을 쥐고 있고, 장당 ~13KB 가 든다(위 실측). */
const PREFETCH_SPAN = 3000;

let prefetchUrls: readonly (string | undefined)[] = [];
let prefetchOrder: number[] = [];
let prefetchPos = 0;
const prefetchInflight = new Map<string, HTMLImageElement>();

/**
 * 폴더 창 그리드가 목록과 지금 보이는 칸 범위(`first`~`last`, 목록 인덱스)를 알린다 — 보이는 칸부터 위아래로
 * 번갈아 받는다. 스크롤해서 다시 부르면 순서를 새 위치 기준으로 다시 짠다. `urls` 가 바뀌면(폴더·크기·목록 갱신)
 * 새 목록에 없는 진행 중 요청은 끊는다 — 옛 폴더 요청이 새 폴더 앞을 막지 않게. 빈 배열 = 멈춤.
 */
export function prefetchFavThumbs(urls: readonly (string | undefined)[], first: number, last: number): void {
  if (urls !== prefetchUrls) {
    prefetchUrls = urls;
    const keep = new Set(urls);
    for (const [url, img] of prefetchInflight) {
      if (keep.has(url)) continue;
      img.onload = img.onerror = null;
      img.src = "";
      prefetchInflight.delete(url);
    }
  }
  prefetchOrder = nearFirst(urls.length, first, last, PREFETCH_SPAN);
  prefetchPos = 0;
  pumpPrefetch();
}

/** 보이는 범위 먼저, 그다음 아래·위로 한 칸씩 번갈아 — 범위에서 `span` 칸까지. */
function nearFirst(n: number, first: number, last: number, span: number): number[] {
  const lo = Math.max(0, first);
  const hi = Math.min(n - 1, last);
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  for (let d = 1; d <= span && (hi + d < n || lo - d >= 0); d++) {
    if (hi + d < n) out.push(hi + d);
    if (lo - d >= 0) out.push(lo - d);
  }
  return out;
}

function pumpPrefetch(): void {
  while (prefetchInflight.size < PREFETCH_SLOTS && prefetchPos < prefetchOrder.length) {
    const url = prefetchUrls[prefetchOrder[prefetchPos++]];
    if (url === undefined || thumbLoaded.has(url) || thumbFailed.has(url) || prefetchInflight.has(url)) continue;
    const img = new Image();
    prefetchInflight.set(url, img);
    img.onload = () => settleThumb(url, img, true);
    // 실패 사유는 여기서 못 읽는다(`<img>` 는 상태 코드를 주지 않는다) — 백엔드가 못 만드는 형식을 415 로 알리는 것이
    // 전부라(thumb_protocol.rs `serve`) 칸이 아이콘으로 남는 것이 곧 그 보고다. 콘솔에 적으면 svg 폴더에서 장마다 찍힌다.
    img.onerror = () => settleThumb(url, img, false);
    img.src = url;
  }
}

function settleThumb(url: string, img: HTMLImageElement, ok: boolean): void {
  prefetchInflight.delete(url);
  if (ok) {
    thumbLoaded.add(url);
    thumbKept.set(url, img);
    if (thumbKept.size > THUMB_KEEP_MAX) {
      const oldest = thumbKept.keys().next();
      if (!oldest.done) thumbKept.delete(oldest.value);
    }
  } else {
    thumbFailed.add(url);
  }
  thumbListeners.get(url)?.forEach((cb) => cb());
  pumpPrefetch();
}

if (import.meta.env.DEV) {
  // e2e 60 이 "화면 밖 칸도 미리 받아 두었다"를 잰다. 모듈을 import 해서 보면 vite 가 HMR 뒤 붙이는 `?t=` 때문에
  // 이 창이 쓰는 것과 다른 사본을 볼 수 있다 — 창에 걸어 둔 이 참조가 그 창의 상태다.
  (window as unknown as { __gpvThumbs?: unknown }).__gpvThumbs = {
    loaded: (url: string) => thumbLoaded.has(url),
    kept: () => thumbKept.size,
  };
}
