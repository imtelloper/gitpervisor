import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { useUi } from "../stores/ui";
import { copyText, readClipboardText } from "./clipboard";
import { isMac } from "./platform";

// PTY 세션은 Rust가 수명의 단일 진실 — xterm 인스턴스/스크롤백은 dispose 전까지 살려둔다.
// 탭/프로젝트 전환은 host(div)를 컨테이너에 붙였다 떼는 것뿐 (설계 §16.5).
//
// 이 파일은 **경량 코어**다 — 레지스트리와 인스턴스 조작만 담고, 무거운 xterm 엔진
// (@xterm/xterm + addon + css ≈ 441kB)은 import하지 않는다(타입만 import → 런타임 0).
// 실제 터미널 생성은 ./terminal-engine 의 createTerminalImpl 에 있고, 첫 터미널 탭이
// 열릴 때 createTerminal()이 동적 import한다 → 콜드 스타트 번들에서 xterm 제외.
export interface TermInstance {
  id: string;
  projectId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  status: "live" | "exited";
  /** 이 인스턴스가 PTY 출력을 받는 채널 — 재연결(reattachAllTerminals)에 다시 쓴다.
   *  PTY의 출력 소비자는 하나뿐이라(term_attach가 sink를 교체) 다른 창이 가져갔다 돌려줄 때
   *  같은 채널로 붙여야 기존 xterm이 그대로 이어진다. 엔진이 생성 직후 채운다. */
  channel?: Channel<number[]>;
}

/** 살아 있는 터미널 인스턴스 레지스트리 — 엔진이 등록하고, 코어/스캐너가 조회한다. */
export const registry = new Map<string, TermInstance>();

type ExitListener = (id: string, code: number) => void;
const exitListeners = new Set<ExitListener>();

// term://exit 전역 구독은 1회만 등록한다. (엔진의 createTerminalImpl이 첫 생성 시 호출)
let exitListenerReady = false;
export function ensureExitListener() {
  if (exitListenerReady) return;
  exitListenerReady = true;
  void listen<{ termId: string; code: number }>("term://exit", (e) => {
    const inst = registry.get(e.payload.termId);
    if (inst) inst.status = "exited";
    exitListeners.forEach((l) => l(e.payload.termId, e.payload.code));
  });
}

/** exit 알림 구독 (스토어에서 탭 상태 갱신용). 해제 함수 반환. */
export function onTermExit(listener: ExitListener): () => void {
  exitListeners.add(listener);
  return () => exitListeners.delete(listener);
}

export function getTerminal(id: string): TermInstance | undefined {
  return registry.get(id);
}

/** 현재 살아 있는 모든 터미널 인스턴스 (에이전트 활동 스캐너용). */
export function listTerminals(): TermInstance[] {
  return Array.from(registry.values());
}

/**
 * xterm 인스턴스를 만들고 PTY를 띄운다. 이미 있으면 기존 것을 반환(멱등).
 * 무거운 xterm 엔진을 동적 import하므로 async — 이미 존재하면 엔진 로드 없이 즉시 반환한다.
 */
export async function createTerminal(opts: {
  id: string;
  projectId: string;
  fontSize: number;
  /** 명시하면 그대로 따른다. 생략하면 "살아있는 세션이 있으면 attach, 없으면 open"으로 자동 판정. */
  attach?: boolean;
}): Promise<TermInstance> {
  const existing = registry.get(opts.id);
  if (existing) return existing;
  // 이 창의 레지스트리에 없다 = 여기서 처음 그린다. 이때 같은 id의 PTY가 다른 창(모아보기
  // 별도 창 등)이나 이전 렌더로 이미 살아 있을 수 있다.
  //
  // 그 경우 반드시 attach해야 한다 — term_open은 같은 id여도 **무조건 새 PTY를 만들어 세션
  // 맵을 덮어쓰므로**(commands/terminal.rs) 이전 셸이 미아 프로세스로 샌다. 반대로 세션이
  // 없는데 attach하면 "터미널 세션을 찾을 수 없습니다"로 실패한다. 그래서 호출부가 아니라
  // 여기서 한 번에 판정한다(호출부마다 분기하면 빠뜨리는 곳이 생긴다 — 실제로 겪음).
  const attach = opts.attach ?? (await sessionExists(opts.id));
  const { createTerminalImpl } = await import("./terminal-engine");
  return createTerminalImpl({ ...opts, attach });
}

/** 이 id의 PTY 세션이 백엔드에 살아 있는가 (term_project는 없으면 null을 준다). */
async function sessionExists(termId: string): Promise<boolean> {
  try {
    return (await invoke<string | null>("term_project", { termId })) != null;
  } catch {
    return false;
  }
}

/** 열린 모든 터미널에 현재 테마(CSS 변수 + themes.ts 보정)를 재적용한다.
 *  테마는 Terminal 생성 시 1회만 적용되므로, 전환 시 App/SettingsDialog가 호출한다.
 *  레지스트리가 비면(= 엔진 미로드 포함) no-op — 엔진을 불필요하게 로드하지 않는다. */
export function refreshTerminalThemes(): void {
  if (registry.size === 0) return;
  // 레지스트리에 인스턴스가 있다 = 엔진이 이미 로드됨 → import는 모듈 캐시에서 즉시 해소.
  void import("./terminal-engine").then((m) => m.refreshTerminalThemesImpl());
}

/**
 * 살아있는 모든 터미널의 PTY 출력을 이 창으로 되돌린다.
 *
 * PTY 출력 소비자는 하나뿐이라(`term_attach`가 sink를 교체) 모아보기 별도 창이 열리면 이 창의
 * 터미널은 출력이 끊긴다. 그 창이 닫힐 때 호출해 원래 채널로 다시 붙인다 — xterm 인스턴스와
 * 스크롤백은 그대로였으므로 화면 손실 없이 이어진다(끊긴 동안의 출력은 저쪽 창이 받았다).
 */
export function reattachAllTerminals(): void {
  for (const inst of registry.values()) {
    if (inst.status !== "live" || !inst.channel) continue;
    void invoke("term_attach", { termId: inst.id, onData: inst.channel }).catch(
      () => {},
    );
  }
}

/** host를 컨테이너에 붙이고 맞춘다. 탭 활성화 시 호출. */
export function attachTerminal(id: string, container: HTMLElement) {
  const inst = registry.get(id);
  if (!inst) return;
  if (inst.host.parentElement !== container) container.appendChild(inst.host);
  // 레이아웃 반영 후 fit + 포커스 (숨겨졌다 보이는 탭은 크기 측정이 늦다)
  requestAnimationFrame(() => {
    try {
      inst.fit.fit();
      inst.term.focus();
    } catch {
      /* 컨테이너가 아직 0크기일 수 있다 — 다음 ResizeObserver가 보정 */
    }
  });
}

/** 컨테이너 크기 변화 시 현재 부착된 터미널을 다시 맞춘다. */
export function fitTerminal(id: string) {
  const inst = registry.get(id);
  if (!inst) return;
  try {
    inst.fit.fit();
  } catch {
    /* noop */
  }
}

/**
 * 전역 Ctrl+C(mac=Cmd+C) 복사 폴백 — 터미널에 선택이 있는데 그 터미널 textarea에 포커스가
 * 없을 때(선택 드래그 끝점이 밖·alt-tab 복귀 등) Ctrl+C가 복사를 못 하는 문제를 메운다.
 * xterm은 WebGL 캔버스라 DOM 선택이 없어, 포커스가 터미널 밖이면 브라우저 기본 복사가 빈 값을
 * 복사한다. 포커스된 터미널은 각 인스턴스의 attachCustomKeyEventHandler가 이미 처리하므로 건너뛰고,
 * 편집 요소(input/textarea/Monaco/contenteditable)에 포커스면 그쪽 복사를 존중한다. main.tsx 1회 설치.
 */
let terminalCopyFallbackReady = false;
export function installTerminalCopyFallback(): void {
  if (terminalCopyFallbackReady) return;
  terminalCopyFallbackReady = true;
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "c" || e.altKey) return;
    if (!(isMac ? e.metaKey : e.ctrlKey)) return;
    const active = document.activeElement as HTMLElement | null;
    // 편집 요소(터미널 자신·Monaco·입력창·contenteditable)에 포커스면 그 복사 경로를 존중 → 건너뜀.
    if (
      active &&
      (active.closest(".xterm, .monaco-editor") ||
        active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable)
    )
      return;
    // 포커스가 비-편집 요소일 때: 선택이 있는 터미널을 찾아 복사.
    const withSel = listTerminals().find(
      (t) => t.status === "live" && t.term.hasSelection(),
    );
    const sel = withSel?.term.getSelection();
    if (!withSel || !sel) return;
    e.preventDefault();
    void copyText(sel).then((ok) => {
      if (ok) withSel.term.clearSelection();
      else useUi.getState().pushToast("error", "복사에 실패했습니다");
    });
  });
}

/** 스마트 붙여넣기 — 백엔드(term_paste, 3플랫폼 실구현)가 클립보드를 판별(파일/이미지→경로,
 *  그 외 텍스트)한 텍스트를 넣는다. 빈 값이면 플러그인 readText로 한 번 더 시도(보조 안전망).
 *  PTY에 직접 쓰지 않고 term.paste()를 경유한다: xterm이 개행 정규화(\n→\r)와 bracketed
 *  paste(ESC[200~) 래핑을 처리해, 멀티라인 붙여넣기가 셸에서 줄마다 즉시 실행되는 사고를 막는다
 *  (최종 전송은 어차피 onData → term_write 경로).
 *  한계: 플로팅 분리/재도킹으로 새로 만든 xterm(attach)은 이전 출력의 \x1b[?2004h를 못 봐
 *  모드 플래그가 꺼진 채 시작한다 — 그 창의 첫 멀티라인 붙여넣기는 비브래킷으로 나갈 수 있다
 *  (zsh는 다음 프롬프트에서 재설정, Claude Code류 TUI는 세션 내 지속). 근본 해결은 Rust가
 *  세션별 2004 모드를 추적해 attach 시 프론트 파서에 되살리는 것 — 후속 과제. */
export async function pasteIntoTerminal(id: string) {
  try {
    let text = await invoke<string>("term_paste");
    if (!text) text = await readClipboardText();
    const inst = getTerminal(id);
    if (text && inst) inst.term.paste(text);
    inst?.term.focus();
  } catch {
    /* noop */
  }
}

/** 선택 영역을 클립보드로 복사 — 네이티브 플러그인 경로(WKWebView의 한글 MacRoman 깨짐 회피).
 *  실패는 무음이 아니라 토스트로 알린다. */
export function copyTerminalSelection(id: string) {
  const sel = registry.get(id)?.term.getSelection();
  if (sel)
    void copyText(sel).then((ok) => {
      if (!ok) useUi.getState().pushToast("error", "복사에 실패했습니다");
    });
}

/** 플로팅 분리용 — xterm 인스턴스/host만 정리하고 PTY(term_close)는 호출하지 않는다.
 *  PTY는 살아있고, 새 OS 창이 term_attach로 출력을 이어받는다. */
export function detachTerminalKeepPty(id: string) {
  const inst = registry.get(id);
  if (!inst) return;
  registry.delete(id);
  try {
    inst.term.dispose();
  } catch {
    /* noop */
  }
  inst.host.remove();
}

/** 세션 완전 종료 — PTY kill + xterm dispose + 레지스트리 제거. term_close 완료를 await할 수 있다. */
export function disposeTerminal(id: string): Promise<void> {
  const inst = registry.get(id);
  if (!inst) return Promise.resolve();
  registry.delete(id);
  const closed = invoke("term_close", { termId: id }).catch(() => {}) as Promise<void>;
  try {
    inst.term.dispose();
  } catch {
    /* noop */
  }
  inst.host.remove();
  return closed;
}
