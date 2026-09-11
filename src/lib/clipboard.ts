import {
  readText,
  writeText,
} from "@tauri-apps/plugin-clipboard-manager";
import { warn } from "@tauri-apps/plugin-log";

import { isMac, isWindows } from "./platform";

// 네이티브 클립보드(arboard, Rust)를 거쳐 텍스트를 읽고 쓴다.
// WKWebView(macOS)의 `navigator.clipboard.writeText`는 비-ASCII(한글 등)를 UTF-8 바이트를
// MacRoman으로 재해석하는 이중인코딩으로 깨뜨린다("❯ 이제" → "‚ùØ¬†...Ïù¥Ï†ú"). 네이티브
// 경로는 UTF-8을 올바로 처리하므로 앱의 모든 텍스트 복사/붙여넣기를 여기로 일원화한다.

// ---- 계층 쓰기 (태스크 65) ------------------------------------------------------------
// "어떤 PC에서는 복사가 안 된다"의 원인은 하나가 아니라 OS별로 하나씩이었다:
//  · Windows — 다른 프로세스가 `OpenClipboard`를 쥔 수십 ms 동안 쓰기가 실패한다(클립보드
//    히스토리·RDP rdpclip·Ditto 등이 복사 직후 흔히 쥔다). arboard의 자체 재시도는 5회 × 5ms
//    = 25ms뿐이다(arboard-3.6.1/src/platform/windows.rs:533,559). 같은 함정을 이미 이미지
//    캡처가 겪고 8회 백오프로 고쳤다(commands/capture.rs "첫 시도가 그대로 깨졌다").
//  · Linux — 플러그인은 앱 시작 시 `arboard::Clipboard::new()`를 **1회만** 만들고, 실패하면
//    그 뒤 모든 쓰기가 영구 Err다(tauri-plugin-clipboard-manager/src/desktop.rs:17).
//    `wayland-data-control` 피처가 꺼져 있어 항상 X11 경로이므로, GNOME 메뉴/systemd로 떠
//    `DISPLAY`가 없는 세션에서는 앱 수명 내내 복사가 죽는다. WebKitGTK의 브라우저 클립보드는
//    GTK를 직접 쓰므로 멀쩡한데 폴백이 없었다.
// 그래서 네이티브 → 브라우저 → execCommand 순으로 내려가며, 실패하면 **사유를 남긴다**.

/** 마지막 쓰기 실패 사유 — 토스트와 로그에 붙는다. 성공하면 비운다. */
let lastFailure = "";

/** 네이티브 경로가 통째로 죽은 환경(위 Linux 항)에서 매 복사마다 0.3초를 버리지 않기 위한 기억.
 *  죽은 것으로 표시돼도 **매번 1회는 시도한다** — 복구(디스플레이 연결 등)를 놓치지 않는다. */
let pluginDead = false;

/** DEV 전용 실패 주입(e2e 52) — `__gpvClipboard.fail(["plugin","navigator","exec"])`. */
const forced = new Set<string>();

const NON_ASCII = /[^\x20-\x7E\t\r\n]/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function short(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** 화면 밖 textarea + `execCommand("copy")` — 마지막 그물. WebView2·WebKitGTK 모두 지원한다.
 *  포커스를 반드시 돌려준다: 터미널 textarea를 뺏은 채로 두면 다음 키 입력이 PTY로 안 간다. */
function execCommandCopy(text: string): boolean {
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    ta.remove();
    prev?.focus?.();
  }
}

/** 텍스트를 클립보드에 쓴다. 성공 여부를 반환한다 — 예외를 삼켜 UI가 죽지 않게 하되,
 *  호출자가 실패 토스트 등 피드백을 줄 수 있게 한다(무음 실패 + 선택 해제면 "복사가 안 된다"로만
 *  체감된다). 실패 사유는 `lastCopyFailure()`로 꺼내 쓴다.
 *  macOS belt: 커스텀 메뉴로 Copy/Cut을 빼 네이티브 copy를 없앤 게 근본 수정이지만(§7), 혹시
 *  어떤 경로로든 WKWebView 네이티브 copy가 우리 쓰기 "뒤" 런루프에서 pasteboard를 덮는 경우를
 *  대비해, 다음 틱에 한 번 더 써서 arboard가 최종 writer가 되게 한다(마지막 쓰기 승리). 메뉴
 *  수정이 이미 네이티브 copy를 없앤 경로에선 같은 값의 무해한 중복 쓰기일 뿐. */
export async function copyText(text: string): Promise<boolean> {
  const errors: string[] = [];

  // ① 네이티브 플러그인(arboard) — 경합 재시도. 곡선은 capture.rs의 이미지 복사와 같다.
  const tries = pluginDead ? 1 : 6;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(40 + i * 10);
    try {
      if (forced.has("plugin")) throw new Error("forced(plugin)");
      await writeText(text);
      if (isMac) setTimeout(() => void writeText(text).catch(() => {}), 0);
      lastFailure = "";
      pluginDead = false;
      return true;
    } catch (e) {
      if (i === tries - 1) errors.push(`plugin: ${short(e)}`);
    }
  }
  pluginDead = true;

  // ②③ 웹뷰 경로 — **macOS + 비-ASCII는 건너뛴다.** WKWebView가 UTF-8을 MacRoman으로
  //     이중인코딩해 한글을 깨뜨린다(dc21cae). 깨진 텍스트는 실패보다 나쁘다.
  const domSafe = !isMac || !NON_ASCII.test(text);
  if (domSafe) {
    try {
      if (forced.has("navigator")) throw new Error("forced(navigator)");
      await navigator.clipboard.writeText(text);
      lastFailure = "";
      return true;
    } catch (e) {
      errors.push(`navigator: ${short(e)}`);
    }
    try {
      if (forced.has("exec")) throw new Error("forced(exec)");
      if (!execCommandCopy(text)) throw new Error("execCommand가 false를 반환했습니다");
      // **`execCommand` 의 true 는 "명령을 보냈다"이지 "클립보드에 들어갔다"가 아니다.**
      // 2026-09-10 이 머신에서 실측: OS 클립보드가 통째로 고장 나 앞의 두 단계가 각각
      // "held by another party"(arboard)와 "Document is not focused"(웹뷰)로 정직하게 던졌는데,
      // **이 단계만 true 를 돌려줬다.** 그대로 두면 `copyText` 가 성공을 보고하고 호출부는 선택을
      // 해제한다 — 사용자는 복사된 줄 알고 붙여넣으면 아무것도 안 나온다. 이 태스크가 없애려던
      // "무음 실패"의 쌍둥이인 **"거짓 성공"** 이다.
      //
      // 그래서 이 단계만 되읽어 확인한다. **macOS 는 제외한다** — 읽기마다 페이스트보드
      // 프라이버시 프롬프트가 뜨기 때문이고(§4), 거기서 이 단계는 어차피 ASCII 전용이다.
      // 되읽기가 실패하거나 값이 다르면 **실패로 본다**: 거짓 실패(토스트가 떴는데 실은 복사됨)는
      // 사용자가 다시 누르면 그만이지만, 거짓 성공은 붙여넣기 시점까지 발각되지 않는다.
      if (!isMac) {
        const back = await readText().catch(() => null);
        if (back !== text) {
          throw new Error(
            `클립보드에 반영되지 않았습니다(되읽기=${back === null ? "실패" : "불일치"})`,
          );
        }
      }
      lastFailure = "";
      return true;
    } catch (e) {
      errors.push(`exec: ${short(e)}`);
    }
  } else {
    errors.push("webview: macOS 비-ASCII는 인코딩이 깨져 건너뜀");
  }

  const detail = errors.join(" | ");
  // Windows 경합은 사람 말로 옮긴다 — capture.rs가 쓰는 것과 같은 문장.
  lastFailure =
    isWindows && /open|another|held|busy|access/i.test(detail)
      ? "다른 프로그램이 클립보드를 쓰고 있습니다 — 다시 시도하세요"
      : detail || "알 수 없는 오류";
  const plat = isWindows ? "win" : isMac ? "mac" : "linux";
  // 로그 파일에 남긴다 — 다음번 "어떤 PC에서는 안 된다"를 추측이 아니라 근거로 좁힌다.
  void warn(`[clipboard] 복사 실패 (${plat}, ${text.length}자): ${detail}`).catch(
    () => {},
  );
  return false;
}

/** 마지막 복사 실패 사유(사람이 읽을 문장). */
export function lastCopyFailure(): string {
  return lastFailure || "알 수 없는 오류";
}

/** 실패 토스트 문구 — 복사 호출부 전부가 같은 문장을 쓰게 한다. */
export function copyFailMessage(): string {
  return `복사에 실패했습니다 — ${lastCopyFailure()}`;
}

if (import.meta.env.DEV) {
  // e2e 52가 각 단계를 강제로 실패시켜 폴백을 증명한다. main.tsx의 `__gpv`를 건드리지 않는
  // 이유: 그 파일은 저장 시 vite 풀 리로드라 같은 트리에서 도는 다른 세션의 회차를 깬다.
  (window as unknown as { __gpvClipboard?: unknown }).__gpvClipboard = {
    fail: (stages: string[]) => {
      forced.clear();
      for (const s of stages) forced.add(s);
      pluginDead = false;
    },
    // 계층 쓰기를 UI 없이 직접 구동한다 — "이 머신에서 복사가 왜 안 되나"를 진단할 때
    // 메뉴·선택·터미널을 다 거치지 않고 이 한 줄로 사유를 볼 수 있다.
    copy: async (text: string) => ({
      ok: await copyText(text),
      reason: lastCopyFailure(),
    }),
  };
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
