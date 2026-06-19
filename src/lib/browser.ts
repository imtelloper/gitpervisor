import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useBrowsers } from "../stores/browser";

// 네이티브 자식 webview 제어는 전부 백엔드 커스텀 커맨드로만 한다(권한 표면 축소 +
// 동시 invoke 유실 대응). 위치/크기/표시는 terminal.ts처럼 "백엔드가 단일 진실"이고
// 프론트는 bounds/show-hide만 동기화한다.

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 이미 webview를 만든 탭 id (lazy 생성 멱등 추적)
const created = new Set<string>();
export function isBrowserCreated(id: string): boolean {
  return created.has(id);
}

/** 자식 webview 보장 — 없으면 생성, 있으면 navigate(백엔드가 멱등). */
export async function openBrowser(id: string, url: string, bounds: Bounds): Promise<void> {
  created.add(id);
  try {
    await invoke("browser_open", { browserId: id, url, bounds });
  } catch {
    created.delete(id); // 생성 실패 시 다음 시도에서 재생성
  }
}

export function navigate(id: string, url: string): void {
  void invoke("browser_navigate", { browserId: id, url }).catch(() => {});
}
export function back(id: string): void {
  void invoke("browser_back", { browserId: id }).catch(() => {});
}
export function forward(id: string): void {
  void invoke("browser_forward", { browserId: id }).catch(() => {});
}
export function reload(id: string): void {
  void invoke("browser_reload", { browserId: id }).catch(() => {});
}
export function stop(id: string): void {
  void invoke("browser_stop", { browserId: id }).catch(() => {});
}
export function focusBrowser(id: string): void {
  void invoke("browser_focus", { browserId: id }).catch(() => {});
}
/** 포커스를 메인 webview로 환원 — 네이티브 webview 키보드 트랩 탈출. */
export function blurBrowser(): void {
  void invoke("browser_blur").catch(() => {});
}

export async function disposeBrowser(id: string): Promise<void> {
  created.delete(id);
  boundsFlight.delete(id);
  try {
    await invoke("browser_close", { browserId: id });
  } catch {
    /* 무시 */
  }
}

// ---- bounds 동기화: single-flight (in-flight 동안의 갱신은 마지막 값만 후행 적용) ----
const boundsFlight = new Map<string, { inflight: boolean; pending: Bounds | null }>();

export function setBounds(id: string, b: Bounds): void {
  const st = boundsFlight.get(id) ?? { inflight: false, pending: null };
  boundsFlight.set(id, st);
  if (st.inflight) {
    st.pending = b;
    return;
  }
  st.inflight = true;
  void invoke("browser_set_bounds", { browserId: id, bounds: b })
    .catch(() => {})
    .finally(() => {
      st.inflight = false;
      if (st.pending) {
        const p = st.pending;
        st.pending = null;
        setBounds(id, p);
      }
    });
}

/**
 * 표시/숨김. hide는 모달 위 "끼임"(정합성 버그)을 막기 위해 per-attempt 타임아웃으로
 * 끊긴(hung) invoke를 차단하고 재시도한다(메모리: 동시 invoke 응답 유실).
 */
export async function setVisible(
  id: string,
  visible: boolean,
  bounds?: Bounds,
): Promise<void> {
  const attempts = visible ? 1 : 4;
  for (let i = 0; i < attempts; i++) {
    const ok = await Promise.race([
      invoke("browser_set_visible", { browserId: id, visible, bounds: bounds ?? null })
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), 400)),
    ]);
    if (ok) return;
  }
}

export async function scanDevPorts(): Promise<number[]> {
  try {
    return await invoke<number[]>("browser_scan_dev_ports", {});
  } catch {
    return [];
  }
}

// ---- 백엔드 이벤트 → 스토어 (events.ts 철학: 이벤트는 신호, 스토어가 갱신) ----
let eventsReady = false;
export function ensureBrowserEvents(): void {
  if (eventsReady) return;
  eventsReady = true;
  void listen<{ browserId: string; url: string; loading: boolean }>("browser://nav", (e) => {
    useBrowsers.getState().applyNav(e.payload.browserId, {
      url: e.payload.url,
      loading: e.payload.loading,
    });
  });
  void listen<{ browserId: string; title: string }>("browser://title", (e) => {
    useBrowsers.getState().setTitle(e.payload.browserId, e.payload.title);
  });
}
