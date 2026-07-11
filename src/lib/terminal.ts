import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { useUi } from "../stores/ui";

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
  /** true면 새 PTY를 spawn하지 않고 살아있는 세션에 재연결(플로팅 창 — term_attach). */
  attach?: boolean;
}): Promise<TermInstance> {
  const existing = registry.get(opts.id);
  if (existing) return existing;
  const { createTerminalImpl } = await import("./terminal-engine");
  return createTerminalImpl(opts);
}

/** 열린 모든 터미널에 현재 테마(CSS 변수 + themes.ts 보정)를 재적용한다.
 *  테마는 Terminal 생성 시 1회만 적용되므로, 전환 시 App/SettingsDialog가 호출한다.
 *  레지스트리가 비면(= 엔진 미로드 포함) no-op — 엔진을 불필요하게 로드하지 않는다. */
export function refreshTerminalThemes(): void {
  if (registry.size === 0) return;
  // 레지스트리에 인스턴스가 있다 = 엔진이 이미 로드됨 → import는 모듈 캐시에서 즉시 해소.
  void import("./terminal-engine").then((m) => m.refreshTerminalThemesImpl());
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

/** 스마트 붙여넣기 — 백엔드가 클립보드를 판별(파일/이미지→경로, 그 외 텍스트)한 텍스트를 넣는다.
 *  PTY에 직접 쓰지 않고 term.paste()를 경유한다: xterm이 개행 정규화(\n→\r)와 bracketed
 *  paste(ESC[200~) 래핑을 처리해, 멀티라인 붙여넣기가 셸에서 줄마다 즉시 실행되는 사고를 막는다
 *  (최종 전송은 어차피 onData → term_write 경로). */
export async function pasteIntoTerminal(id: string) {
  try {
    const text = await invoke<string>("term_paste");
    const inst = getTerminal(id);
    if (text && inst) inst.term.paste(text);
    inst?.term.focus();
  } catch {
    /* noop */
  }
}

/** 선택 영역을 클립보드로 복사. 실패는 무음이 아니라 토스트로 알린다 —
 *  WebKitGTK/WKWebView의 클립보드 쓰기는 사용자 제스처 조건이 붙어 조용히 거부될 수 있다. */
export function copyTerminalSelection(id: string) {
  const sel = registry.get(id)?.term.getSelection();
  if (sel)
    void navigator.clipboard.writeText(sel).catch(() => {
      useUi.getState().pushToast("error", "복사에 실패했습니다");
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
