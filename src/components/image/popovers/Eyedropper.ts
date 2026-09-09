// 스포이드 — 캔버스에서 색 한 점을 뽑아 호출자(채우기·선·효과 색)에게 돌려준다.
//
// 세 가지가 이 훅의 전부다: 일시 도구 전환 · 캔버스 포인터 **선점** · 뽑고 나서 원래 도구 복귀.
//
//   1) **선점**(`registerPointerHit`)이 아니면 안 된다. 그냥 캔버스 클릭을 기다리면 그 다운이
//      선택·그리기 제스처로 먼저 소비돼, 스포이드로 찍은 자리에 사각형이 하나 생긴다.
//      등록 해제를 빠뜨리면 반대 사고가 난다 — 색을 다 뽑은 뒤에도 캔버스 클릭이 계속 먹혀
//      "그림이 안 그려진다"가 된다. 그래서 해제 경로가 하나(`stop`)뿐이고 언마운트도 그걸 부른다.
//
//   2) **도구가 스포이드에서 벗어나면 세션도 끝난다**(스토어 구독). Esc 취소를 위해 여기서 키
//      리스너를 달지 않는다 — 42 캡처 리스너와 순서를 다투게 된다. 대신 **복귀는 `stop()` 이
//      직접 한다**: 42 Esc 계층의 `select` 복귀(4단계)는 팝오버가 열려 있으면 0단계에서 끊겨
//      영영 오지 않는다(색 피커의 스포이드 버튼으로 시작한 세션이 정확히 그 경우다).
//
//   3) **11×11 의 채널별 중앙값**을 쓴다. 한 픽셀만 읽으면 안티에일리어싱 경계나 JPEG 노이즈에
//      걸려 사용자가 보고 있다고 믿는 색과 다른 값이 나온다. 평균은 더 나쁘다 — 경계에서
//      화면 어디에도 없는 중간색을 만든다. 중앙값은 표본의 과반을 차지하는 색이 있으면 세 채널
//      모두 그 색으로 떨어져 **실제로 존재하는 색**을 돌려준다.
//
// 샘플 원본은 씬 캔버스(`canvases()[1]`)다 — 39 이후 이미지와 노드가 거기 불투명 합성돼 있어
// 화면에 보이는 색 그대로다. `ponytail:` 확대 중(40 디테일 캔버스)에는 백킹 해상도 픽셀을 본다.
// 원본 픽셀이 필요해지면 40 의 디테일 캔버스에서 샘플하도록 바꾼다.
//
// 배경: DOCS/task/45-image-inspector-popovers.md §3.8 아이드로퍼

import { useCallback, useEffect, useRef } from "react";

import { rgbToHex } from "../../../lib/color";
import { useImageEditorUi } from "../../../stores/imageEditor";
import { registerPointerHit } from "../annotation/pointer";

/** 홀수여야 한다 — 중심 픽셀이 표본의 가운데에 있어야 커서가 가리킨 색이 기준이 된다. */
const SAMPLE = 11;

export function useEyedropper(): { start(onPick: (hex: string) => void): void } {
  const stopRef = useRef<(() => void) | null>(null);

  // 팝오버가 닫히면(= 이 훅을 쓰는 컴포넌트가 사라지면) 선점 등록도 같이 사라져야 한다.
  useEffect(() => () => stopRef.current?.(), []);

  const start = useCallback((onPick: (hex: string) => void) => {
    // 이미 켜져 있으면 앞 세션을 먼저 끈다. 겹쳐 등록하면 클릭 한 번에 두 콜백이 불려
    // 문서에 같은 색이 두 번(= 히스토리 두 칸) 쓰인다.
    stopRef.current?.();

    useImageEditorUi.getState().setTool("eyedropper", { temporary: true });

    // 해제는 여러 경로에서 들어온다(클릭·도구 변경·언마운트). 전부 멱등이라 순서만 지키면 된다.
    //
    // **도구 복귀도 여기서 한다.** 뽑기 성공에만 두면 취소 경로(팝오버 Esc·X·언마운트)가
    // 도구를 스포이드에 남긴다 — 그 상태의 캔버스 클릭은 선택도 그리기도 아니라(pointer.ts 가
    // eyedropper 를 모른다) 커서만 십자인 채 아무 반응이 없다. 위 머리말이 근거로 든 "42 Esc
    // 계층이 select 로 되돌린다"는 팝오버가 없을 때 얘기다: 팝오버가 열려 있으면 Esc 는
    // 0단계(`closeTopPopover`)에서 끝나 그 계층까지 못 간다.
    const stop = () => {
      unhit();
      unsub();
      // 도구 검사는 필수다 — 구독이 "사용자가 레일에서 다른 도구를 골랐다"로도 이 함수를
      // 부르므로, 무조건 되돌리면 방금 고른 도구를 빼앗는다.
      if (useImageEditorUi.getState().tool === "eyedropper") {
        useImageEditorUi.getState().restoreTool();
      }
      if (stopRef.current === stop) stopRef.current = null;
    };

    const unhit = registerPointerHit((_pt, e) => {
      const hex = sampleAt(e);
      stop();
      // 색을 못 읽었으면(캔버스 오염·크기 0) 아무 것도 쓰지 않고 도구만 되돌린다.
      if (hex) onPick(hex);
      return true;
    });

    const unsub = useImageEditorUi.subscribe((s) => {
      if (s.tool !== "eyedropper") stop();
    });

    stopRef.current = stop;
  }, []);

  return { start };
}

/**
 * 포인터가 가리킨 씬 캔버스 픽셀의 색.
 *
 * 백킹 좌표는 클라이언트 좌표를 캔버스 rect 비율로 환산해 얻는다 — 프리뷰 배율(oriented →
 * 백킹)을 이 훅이 몰라도 되는 유일한 길이다. 배율을 짐작해서 곱하면 큰 이미지(1800 상한에
 * 걸린 것)에서만 좌표가 어긋나 재현이 안 되는 버그가 된다.
 */
function sampleAt(e: PointerEvent): string | null {
  const c = e.target as HTMLCanvasElement | null;
  // `instanceof` 는 doc 창처럼 realm 이 다르면 거짓이 된다(Popover 와 같은 이유).
  if (!c || typeof c.getContext !== "function") return null;
  const r = c.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0) || !c.width || !c.height) return null;

  const half = (SAMPLE - 1) / 2;
  const bx = Math.floor(((e.clientX - r.left) / r.width) * c.width);
  const by = Math.floor(((e.clientY - r.top) / r.height) * c.height);
  const x0 = clampInt(bx - half, 0, c.width - 1);
  const y0 = clampInt(by - half, 0, c.height - 1);
  const w = Math.min(SAMPLE, c.width - x0);
  const h = Math.min(SAMPLE, c.height - y0);

  try {
    const d = c.getContext("2d")!.getImageData(x0, y0, w, h).data;
    const ch: number[][] = [[], [], []];
    for (let i = 0; i < d.length; i += 4) {
      ch[0].push(d[i]);
      ch[1].push(d[i + 1]);
      ch[2].push(d[i + 2]);
    }
    return rgbToHex([median(ch[0]), median(ch[1]), median(ch[2])]);
  } catch {
    // 교차 출처 에셋으로 오염된 캔버스는 getImageData 가 던진다.
    return null;
  }
}

function median(v: number[]): number {
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}
