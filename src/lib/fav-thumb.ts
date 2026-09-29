import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

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
