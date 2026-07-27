import { useEffect } from "react";
import { create } from "zustand";

import { useDb } from "./db";
import { selectBlockingOverlay, useUi } from "./ui";

/**
 * 네이티브 자식 webview를 가려야 하는 오버레이의 **단일 진실**.
 *
 * 네이티브 webview는 React DOM과 z-합성되지 않고 항상 위에 그려진다(browser-feature-design §4).
 * 따라서 그 위에 무언가를 띄우려면 webview를 숨기는 수밖에 없는데, 이 판정 목록이 손으로
 * 관리되면서 이미 한 번 낡았다(prompt·quickOpen·symbolSearch·imageEditor 누락 — 모달이
 * webview 뒤에 가려 안 보이는 버그).
 *
 * 오버레이는 세 계층에 산재한다:
 *   1) 전역 useUi 모달  → ui.ts의 selectBlockingOverlay (선언과 콜로케이트)
 *   2) 타 스토어 모달   → useDb.dialog
 *   3) 컴포넌트 로컬 state 메뉴(우클릭·버튼 앵커 fixed 메뉴) → **스토어 셀렉터로는 못 잡는다**
 *
 * 3계층 때문에 "셀렉터 하나로 통일"이 성립하지 않아, 로컬 메뉴는 이 카운터에 등록(register)한다.
 * 소비자(BrowserPane)는 useWebviewBlocked() 하나만 보면 된다.
 */
interface OcclusionState {
  /** 현재 열려 있는 로컬 오버레이 수 */
  count: number;
  /** 등록 — 해제 함수를 돌려준다(이중 호출 무해) */
  acquire: () => () => void;
}

export const useOcclusion = create<OcclusionState>((set) => ({
  count: 0,
  acquire: () => {
    set((s) => ({ count: s.count + 1 }));
    let released = false;
    return () => {
      if (released) return; // StrictMode 이중 정리·중복 해제로 카운터가 음수가 되지 않게
      released = true;
      set((s) => ({ count: Math.max(0, s.count - 1) }));
    };
  },
}));

/**
 * 로컬 state 오버레이(우클릭 메뉴·드롭다운)를 점유 레지스트리에 등록한다.
 * 메뉴를 가진 컴포넌트에 한 줄만 추가하면 그 메뉴가 열린 동안 네이티브 webview가 숨는다.
 *
 *   useOccludesWebview(!!menu);
 */
export function useOccludesWebview(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return useOcclusion.getState().acquire();
  }, [active]);
}

/**
 * 네이티브 webview를 지금 숨겨야 하는가 — 세 계층을 합친 최종 판정.
 * 토스트는 **의도적으로 제외**한다: 비차단·자동소멸이라 hide 트리거에 넣으면 배경
 * fetch-에러 토스트마다 페이지가 스크롤 중 깜빡인다(browser-feature-design §4B).
 */
export function useWebviewBlocked(): boolean {
  const uiBlocked = useUi(selectBlockingOverlay);
  const dbDialog = useDb((s) => s.dialog);
  const localMenus = useOcclusion((s) => s.count);
  return uiBlocked || !!dbDialog || localMenus > 0;
}
