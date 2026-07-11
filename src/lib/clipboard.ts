import {
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

import { isMac } from "./platform";

// 네이티브 클립보드(arboard, Rust)를 거쳐 텍스트를 읽고 쓴다.
// WKWebView(macOS)의 `navigator.clipboard.writeText`는 비-ASCII(한글 등)를 UTF-8 바이트를
// MacRoman으로 재해석하는 이중인코딩으로 깨뜨린다("❯ 이제" → "‚ùØ¬†...Ïù¥Ï†ú"). 네이티브
// 경로는 UTF-8을 올바로 처리하므로 앱의 모든 텍스트 복사/붙여넣기를 여기로 일원화한다.

/** 텍스트를 클립보드에 쓴다. 성공 여부를 반환한다 — 예외를 삼켜 UI가 죽지 않게 하되,
 *  호출자가 실패 토스트 등 피드백을 줄 수 있게 한다(무음 실패 + 선택 해제면 "복사가 안 된다"로만
 *  체감된다). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 클립보드의 텍스트를 읽는다. 실패/비어있으면 "". */
export async function readClipboardText(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}

/** macOS 전역 복사 가로채기 — Cmd+C/메뉴 복사가 타는 WebKit 기본 copy 커맨드가 위의
 *  MacRoman 이중인코딩으로 한글을 깨뜨리므로 네이티브 플러그인 경로로 대체한다.
 *  main.tsx 부트스트랩에서 1회 설치. 비-macOS는 no-op(WebView2/WebKitGTK는 정상).
 *
 *  두 겹으로 처리한다:
 *  1) 캡처: 일반 DOM 선택(커밋 상세 등)과 진짜 textarea/input 내부 선택(커밋 폼 등)은
 *     텍스트를 직접 취해 preventDefault + 네이티브 기록. 단 자체 copy 로직을 가진 에디터는
 *     제외한다 — 터미널(.xterm)은 host 캡처 핸들러가 처리하고, Monaco(.monaco-editor)의
 *     숨은 textarea는 "선택"이 아니라 잘린 스크린리더 미러(긴 선택은 중간이 …로 대체,
 *     멀티커서는 첫 범위만)라 여기서 읽으면 잘린 텍스트가 복사된다 — 절대 읽지 말 것.
 *  2) 버블: Monaco처럼 자기 copy 핸들러가 e.clipboardData.setData(전체 텍스트)+preventDefault
 *     로 처리한 복사는, 버블 단계에서 그 "정확한 최종 텍스트"를 되읽어 네이티브로 재기록한다.
 *     플러그인 기록은 비동기라 WebKit의 깨진 기록 뒤에 도착 → 최종 승자가 되어 UTF-8이 복원된다.
 *     (1번이 처리한 이벤트는 stopPropagation으로 버블에 도달하지 않아 이중 기록 없음.
 *      부작용: text/html 등 부가 flavor는 plain text로 다운그레이드 — 코드/디프 중심 앱이라 수용.)
 */
export function installMacCopyInterceptor(): void {
  if (!isMac) return;
  window.addEventListener(
    "copy",
    (e) => {
      const t = e.target as Element | null;
      // 자체 copy 처리 에디터 제외: 터미널은 host 캡처가, Monaco는 아래 버블 미러가 담당.
      if (t instanceof Element && t.closest(".xterm, .monaco-editor")) return;
      let text = "";
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) {
        const { selectionStart: s, selectionEnd: end, value } = t;
        if (s != null && end != null && end > s) text = value.slice(s, end);
      } else {
        text = document.getSelection()?.toString() ?? "";
      }
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      void copyText(text);
    },
    true,
  );
  window.addEventListener("copy", (e) => {
    // 자체 핸들러(Monaco 등)가 setData+preventDefault로 확정한 복사만 대상 — 그 전체 텍스트를
    // 네이티브로 재기록해 WebKit의 MacRoman 기록을 덮는다. 멀티커서 조인·전체 선택 등 텍스트
    // 구성은 에디터 자신이 했으므로 여기선 결과만 미러링한다(추측 없음).
    if (!e.defaultPrevented) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) void copyText(text);
  });
}
