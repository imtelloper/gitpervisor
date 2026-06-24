import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

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
}): Promise<TermInstance> {
  const existing = registry.get(opts.id);
  if (existing) return existing;
  const { createTerminalImpl } = await import("./terminal-engine");
  return createTerminalImpl(opts);
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

/** 스마트 붙여넣기 — 백엔드가 클립보드를 판별(파일/이미지→경로, 그 외 텍스트)해 PTY로 보낸다. */
export async function pasteIntoTerminal(id: string) {
  try {
    const text = await invoke<string>("term_paste");
    if (text) await invoke("term_write", { termId: id, data: text });
    getTerminal(id)?.term.focus();
  } catch {
    /* noop */
  }
}

/** 선택 영역을 클립보드로 복사. */
export function copyTerminalSelection(id: string) {
  const sel = registry.get(id)?.term.getSelection();
  if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
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
