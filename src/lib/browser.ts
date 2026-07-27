import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useBrowsers } from "../stores/browser";
import { collectByContent, useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";

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

// id별 마지막으로 알려진 URL — open/navigate 요청과 browser://nav 실적으로 갱신한다.
// BrowserPane 컴포넌트의 ref는 리마운트(모아보기 여닫기·그리드 재배치)에 증발하므로,
// 모듈 레벨에 둬야 리마운트 시 같은 URL을 재탐색(=전체 페이지 리로드)하지 않는다.
const lastUrl = new Map<string, string>();
export function lastKnownUrl(id: string): string | undefined {
  return lastUrl.get(id);
}

/** 자식 webview 보장 — 없으면 생성, 있으면 navigate(백엔드가 멱등). */
export async function openBrowser(id: string, url: string, bounds: Bounds): Promise<void> {
  created.add(id);
  lastUrl.set(id, url);
  try {
    await invoke("browser_open", { browserId: id, url, bounds });
  } catch {
    created.delete(id); // 생성 실패 시 다음 시도에서 재생성
    lastUrl.delete(id);
  }
}

export function navigate(id: string, url: string): void {
  lastUrl.set(id, url);
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
  lastUrl.delete(id);
  boundsFlight.delete(id);
  visSeq.delete(id);
  try {
    await invoke("browser_close", { browserId: id });
  } catch {
    /* 무시 */
  }
}

/** 이 브라우저 id가 아직 어딘가(독립 탭 또는 분할 트리의 browser leaf)에서 쓰이는가. */
export function isBrowserReferenced(id: string): boolean {
  if (useBrowsers.getState().tabIds.includes(id)) return true;
  return useTerminals
    .getState()
    .terminals.some((t) => collectByContent(t.layout, "browser").includes(id));
}

/**
 * 패널 언마운트 시 호출 — 여전히 참조되면 hide(탭 전환), 아니면 dispose(닫힘/터미널 전환).
 * 표준 탭/패널 양쪽에서 동일하게 동작.
 */
export function releaseBrowser(id: string): void {
  if (isBrowserReferenced(id)) {
    void setVisible(id, false);
  } else {
    void disposeBrowser(id);
    useBrowsers.getState().removePane(id);
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

// id별 setVisible 세대 — 진행 중인 hide 재시도(최대 4회×400ms)가 그 사이 도착한 show를
// 뒤늦게 덮어써 webview가 숨김으로 고착되는 경합을 막는다(최신 요청만 재시도를 계속한다).
// 세대값은 전역 단조 증가 — id별로 1부터 리셋하면 dispose 후 재사용된 id(웹→터미널→웹
// 전환)에서 낡은 hide 루프의 seq에 새 show가 다시 도달해 가드가 뚫린다. 전역 단조면 한 번
// 쓴 seq는 두 번 나오지 않아 visSeq.delete(재사용 정리)가 있어도 안전하다.
let visCounter = 0;
const visSeq = new Map<string, number>();

/**
 * 표시/숨김. hide는 모달 위 "끼임"(정합성 버그)을 막기 위해 per-attempt 타임아웃으로
 * 끊긴(hung) invoke를 차단하고 재시도한다(메모리: 동시 invoke 응답 유실).
 */
export async function setVisible(
  id: string,
  visible: boolean,
  bounds?: Bounds,
): Promise<void> {
  const seq = ++visCounter;
  visSeq.set(id, seq);
  const attempts = visible ? 1 : 4;
  for (let i = 0; i < attempts; i++) {
    if (visSeq.get(id) !== seq) return; // 더 새로운 요청이 대체 — 낡은 재시도 중단
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

/**
 * 브라우저 프로필(쿠키/로그인 세션/사이트 데이터) 전체 삭제 — 북마크·방문기록 store는 별개라
 * 유지된다. 설정의 명시적 액션이므로 실패를 삼키지 않고 throw(호출부가 토스트로 표면화).
 */
export async function clearBrowserData(): Promise<void> {
  await invoke("browser_clear_data");
}

// ---- 백엔드 이벤트 → 스토어 (events.ts 철학: 이벤트는 신호, 스토어가 갱신) ----
let eventsReady = false;
export function ensureBrowserEvents(): void {
  if (eventsReady) return;
  eventsReady = true;
  void listen<{ browserId: string; url: string; loading: boolean }>("browser://nav", (e) => {
    // 페이지가 스스로 이동한 실적도 기록 — 리마운트 시 재탐색 여부 판정의 기준.
    if (e.payload.url) lastUrl.set(e.payload.browserId, e.payload.url);
    useBrowsers.getState().applyNav(e.payload.browserId, {
      url: e.payload.url,
      loading: e.payload.loading,
    });
  });
  void listen<{ browserId: string; title: string }>("browser://title", (e) => {
    useBrowsers.getState().setTitle(e.payload.browserId, e.payload.title);
  });
  // 다운로드는 인앱에서 받지 않고 OS 브라우저로 위임 — 사용자에게 알린다.
  void listen<{ url: string; delegated: boolean }>("browser://download", (e) => {
    useUi
      .getState()
      .pushToast(
        e.payload.delegated ? "info" : "error",
        e.payload.delegated
          ? "다운로드를 외부 브라우저에서 엽니다"
          : "이 다운로드는 지원되지 않습니다",
      );
  });
}
