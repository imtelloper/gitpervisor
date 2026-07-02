// UA 기반 플랫폼/모디파이어 추상화 — Tauri는 웹뷰가 플랫폼별 고정(WebView2="Windows NT" /
// WKWebView="Mac" / WebKitGTK="Linux")이라 UA 판별이 결정적이다. 코드베이스에 흩어진
// UA 스니핑의 단일 출처가 된다(기존 코드 이행은 후속).
export const isMac = /Mac/i.test(navigator.userAgent);
export const isLinux = /Linux/.test(navigator.userAgent);

/** 플랫폼 표준 모디파이어 — mac=metaKey(Cmd), 그 외=ctrlKey(Ctrl) */
export function isMod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** UI 표기용 라벨 — mac="⌘", 그 외="Ctrl" (title/툴팁 병기용) */
export const modLabel = isMac ? "⌘" : "Ctrl";
