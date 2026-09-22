// 격리 합성용 스크래치 캔버스 풀 — 태스크 39 §3.3.
//
// 컨테이너에 불투명도·비패스스루 블렌드·효과·마스크가 있으면 자식을 먼저 따로 합성한 뒤 한 번에
// 얹어야 한다. 그 "따로"를 담는 캔버스를 노드마다 새로 만들면 GC 가 튀고, 반대로 오래 들고 있으면
// 창당 수십 MB 가 회수되지 않는다(render.ts `releaseScratch` 주석의 그 사건).
//
// **`beginLayer/endLayer`(Canvas 2D Layers)는 이 앱에 없다** — 실측 `HAS_LAYERS === false`
// (WebView2 / Chrome 152, 2026-09 dev 앱에서 확인). 그래서 39 §3.3 의 P2 경로가 기본이고,
// 이 풀이 격리 레이어를 공급한다. 있는 런타임에서는 렌더러가 P1 로 갈라져 이 풀을 배경 샘플링에만 쓴다.

/**
 * `ctx.beginLayer()` 가용 여부 — 착수 프로브(39 §3.3, 40 실측표 1행).
 * 실측: WebView2/Chrome 152 에서 **false**.
 */
export const HAS_LAYERS = "beginLayer" in CanvasRenderingContext2D.prototype;

export interface LayerPool {
  /** device px 크기의 **기본 상태**(빈 픽셀·항등 CTM·clip 없음) 스크래치를 빌린다. */
  acquire(w: number, h: number): CanvasRenderingContext2D;
  /** 빌린 스크래치를 돌려준다. 풀 밖(상한 초과)에서 온 것이면 그냥 버려진다. */
  release(ctx: CanvasRenderingContext2D): void;
  /** 전부 놓아 준다 — 편집기 언마운트. */
  releaseAll(): void;
  /** 지금 붙잡고 있는 바이트(빌려준 것 + 노는 것). */
  bytes(): number;
}

/** 캔버스 백킹 1픽셀 = RGBA 4바이트. */
const BYTES_PER_PX = 4;

/**
 * 마지막 반납 뒤 이만큼 지나면 노는 캔버스를 버린다. 프레임 간격(16ms)이나 슬라이더 드래그
 * 중의 공백보다 충분히 길어 정상 편집 중에는 재할당이 일어나지 않는다.
 */
const IDLE_MS = 5000;

/**
 * 격리 레이어 풀. **상한은 바이트다**(개수 아님 — 개수 상한은 4K 백킹 7.3MB 짜리와 아이콘 크기
 * 레이어를 같은 무게로 세어 4K 에서 44MB 까지 부풀었다, 39 §2).
 *
 * @param maxBytes 40 §3.5 의 메모리 원장 상한 = **2 × 백킹 바이트**(4K 백킹 7.3MB → 14.6MB)
 */
export function layerPool(maxBytes: number): LayerPool {
  interface Entry {
    ctx: CanvasRenderingContext2D;
    busy: boolean;
  }
  const entries: Entry[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;

  const bytesOf = (c: HTMLCanvasElement): number => c.width * c.height * BYTES_PER_PX;
  const total = (): number => entries.reduce((n, e) => n + bytesOf(e.ctx.canvas), 0);

  const cancelIdle = (): void => {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const scheduleIdle = (): void => {
    cancelIdle();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i].busy) entries.splice(i, 1);
      }
    }, IDLE_MS);
  };

  /**
   * 스크래치를 요청 크기의 **기본 상태**로 되돌린다.
   *
   * `clearRect` 로는 부족하다 — 앞 사용자가 걸어 둔 clip 은 지워지지 않아 다음 사용자를 조용히
   * 잘라낸다(save/restore 로 감싸지 않은 호출 하나면 바로 재현된다). 크기가 바뀌면 백킹 재할당이
   * 곧 초기화이고, 같으면 `reset()` 이 픽셀·CTM·clip·filter 를 한 번에 되돌린다.
   */
  const prepare = (ctx: CanvasRenderingContext2D, w: number, h: number): CanvasRenderingContext2D => {
    const c = ctx.canvas;
    // `reset()` 이 없는 구형 엔진(WebKitGTK < 2.40)에서는 같은 값을 다시 넣는다 — canvas.width
    // setter 는 값이 같아도 백킹을 새로 잡아 상태까지 초기화한다(규격).
    if (c.width !== w || c.height !== h || typeof ctx.reset !== "function") {
      c.width = w;
      c.height = h;
    } else {
      ctx.reset();
    }
    return ctx;
  };

  const makeCtx = (w: number, h: number): CanvasRenderingContext2D => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c.getContext("2d")!;
  };

  return {
    acquire(w, h) {
      const cw = Math.max(1, Math.ceil(w));
      const ch = Math.max(1, Math.ceil(h));
      cancelIdle();
      // 같은 크기가 노는 게 있으면 그걸 먼저 — 백킹 재할당 없이 reset() 만으로 끝난다.
      const exact = entries.find(
        (e) => !e.busy && e.ctx.canvas.width === cw && e.ctx.canvas.height === ch,
      );
      const pick = exact ?? entries.find((e) => !e.busy);
      let after = total() - (pick ? bytesOf(pick.ctx.canvas) : 0) + cw * ch * BYTES_PER_PX;
      if (after > maxBytes) {
        // 노는 캔버스를 먼저 버려 자리를 만든다 — 빌려준 것은 건드릴 수 없다. 작은 레이어 여러
        // 장이 놀고 있는데 큰 요청 하나가 상한에 걸리는 경우가 여기서 풀린다.
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].busy || entries[i] === pick) continue;
          after -= bytesOf(entries[i].ctx.canvas);
          entries.splice(i, 1);
        }
      }
      if (after > maxBytes) {
        // ponytail: 상한을 넘으면 **풀 밖 임시 캔버스**를 준다 — 정확성을 깎느니 그 프레임만
        // 예산을 넘긴다(release 때 GC 로 사라져 원장에는 남지 않는다). 천장: 격리 중첩이 깊으면
        // 매 프레임 새 백킹이라 GC 가 튄다. 깊이별 바이트를 40 실측표에 적고 넘으면 상한을
        // 올리거나 격리 깊이를 제한한다.
        if (!warned) {
          warned = true;
          console.warn(
            `[annotate] 격리 레이어 풀 상한 초과(${maxBytes}B) — ${cw}×${ch} 임시 할당. 40 §3.5 원장 확인`, // i18n-ok: 여러 줄 로그
          );
        }
        return makeCtx(cw, ch);
      }
      if (pick) {
        pick.busy = true;
        return prepare(pick.ctx, cw, ch);
      }
      const ctx = makeCtx(cw, ch);
      entries.push({ ctx, busy: true });
      return ctx;
    },

    release(ctx) {
      const e = entries.find((x) => x.ctx === ctx);
      if (!e) return; // 상한 초과로 풀 밖에서 만든 임시 캔버스 — 참조만 놓으면 된다
      e.busy = false;
      scheduleIdle();
    },

    releaseAll() {
      cancelIdle();
      entries.length = 0;
      warned = false;
    },

    bytes: total,
  };
}
