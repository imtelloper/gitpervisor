import {
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";

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
