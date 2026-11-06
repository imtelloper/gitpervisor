import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";

/**
 * 터미널 모아보기 별도 창(label="aggregate") — 열기와 "지금 떠 있는가" 신호.
 *
 * ## 왜 소유권 이전인가
 * PTY 세션의 출력 소비자는 하나뿐이다(`term_attach`가 sink를 **교체**한다 — commands/terminal.rs).
 * 따라서 모아보기 창이 터미널에 붙으면 메인 창의 같은 터미널은 출력이 끊긴다. 두 창에서
 * 동시에 보려면 백엔드를 다중 sink로 바꿔야 하는데, 그러면 두 창의 크기가 달라 PTY cols/rows가
 * 요동친다(tmux의 그 문제). 그래서 **모아보기 창이 터미널을 가져가고, 메인은 "다른 창에서 표시
 * 중"으로 접는다** — 창을 닫으면 메인이 다시 이어받는다.
 *
 * ## 열림 상태를 어떻게 아는가
 * "켜짐"은 그 창이 마운트되며 이벤트로 알리고, "꺼짐"은 **Rust의 Destroyed 훅**이 메인에 보낸다
 * (lib.rs — 창 자신의 beforeunload는 죽는 중의 비동기 IPC라 유실됐다). 그래도 이벤트 하나에
 * 매달리지 않도록, 메인은 포커스를 얻을 때마다 실제 창 목록으로 재확인한다(아래 watchAggregateWindow).
 */
const EVENT = "aggregate-window://state";

/** `shutdown` = 앱 종료(shutdown_children)가 창을 닫은 것 — 사용자가 닫은 것과 가른다(태스크 78). */
interface AggregateWindowState {
  open: boolean;
  shutdown?: boolean;
}

/** 별도 창의 마지막 위치·크기(물리 px)와 최대화 — Rust `open_aggregate_window` 의 `geom`(camelCase). */
export interface AggregateWindowGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  maximized: boolean;
}

const GEOM_KEY = "gp:aggregate-window-geom";

function readAggregateWindowGeom(): AggregateWindowGeom | null {
  try {
    const g = JSON.parse(localStorage.getItem(GEOM_KEY) || "null") as Partial<AggregateWindowGeom> | null;
    const int = (v: unknown): v is number => Number.isInteger(v);
    if (!g || !int(g.x) || !int(g.y) || !int(g.w) || !int(g.h) || g.w <= 0 || g.h <= 0) return null;
    return { x: g.x, y: g.y, w: g.w, h: g.h, maximized: g.maximized === true };
  } catch {
    return null; // 손상 값 — 기본 위치(가운데 1100×720)로 열 뿐이다
  }
}

/** 모아보기 창을 연다(이미 떠 있으면 포커스만 — 백엔드가 싱글턴 처리). 위치는 지난번 것(있으면). */
export function openAggregateWindow(geom: AggregateWindowGeom | null = readAggregateWindowGeom()): void {
  void invokeOpen(geom).catch((e) => console.error("모아보기 창 생성 실패:", e));
}

function invokeOpen(geom: AggregateWindowGeom | null): Promise<void> {
  return invoke<void>("open_aggregate_window", { origin: window.location.origin, geom });
}

/** 모아보기 창 자신이 호출 — 열림/닫힘을 다른 창에 알린다. */
export function announceAggregateWindow(open: boolean): void {
  const payload: AggregateWindowState = { open, shutdown: false };
  void emit(EVENT, payload).catch(() => {});
}

/** 모아보기 창 자신이 호출 — 옮기거나 크기를 바꿀 때마다(500ms 디바운스) 위치를 적는다. 정리 함수를 돌려준다. */
export function persistAggregateWindowGeom(): () => void {
  const win = getCurrentWindow();
  let timer = 0;
  const save = async () => {
    // 최소화 중엔 위치가 화면 밖(-32000)으로 읽힌다 — 그 값으로 덮으면 다음엔 기본 위치로 연다.
    if (await win.isMinimized()) return;
    const maximized = await win.isMaximized();
    const prev = readAggregateWindowGeom();
    // 최대화 중엔 최대화 전 크기를 남긴다 — 다음에 열어 최대화를 풀었을 때 화면 가득 찬 창이 아니게.
    let rect = prev && maximized ? prev : null;
    // 단 최대화한 채 다른 모니터로 옮겼으면(Win+Shift+→·위쪽 가장자리 스냅) 옛 자리는 **옛 모니터**다 — 그대로 남기면 다음에
    // 엉뚱한 모니터에서 최대화된다. 지금 모니터 가운데에 같은 크기로 옮겨 적는다.
    if (rect && maximized) {
      const mon = await currentMonitor();
      if (mon) {
        const { x: mx, y: my } = mon.position;
        const { width: mw, height: mh } = mon.size;
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        if (cx < mx || cx >= mx + mw || cy < my || cy >= my + mh) {
          const w = Math.min(rect.w, mw);
          const h = Math.min(rect.h, mh);
          rect = { x: Math.round(mx + (mw - w) / 2), y: Math.round(my + (mh - h) / 2), w, h, maximized };
        }
      }
    }
    if (!rect) {
      const [pos, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
      rect = { x: pos.x, y: pos.y, w: size.width, h: size.height, maximized };
    }
    localStorage.setItem(GEOM_KEY, JSON.stringify({ ...rect, maximized }));
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      save().catch((e) => console.warn("[aggregate] 창 위치 저장 실패:", e));
    }, 500);
  };
  const offs = [win.onMoved(schedule), win.onResized(schedule)];
  return () => {
    clearTimeout(timer);
    offs.forEach((p) =>
      void p.then((f) => f()).catch((e) => console.warn("[aggregate] 창 이벤트 해제 실패:", e)),
    );
  };
}

/** 실제 창 목록으로 확인 — 이벤트를 놓쳤을 때의 진실 판정. */
async function isAggregateWindowOpen(): Promise<boolean> {
  try {
    const wins = await getAllWebviewWindows();
    return wins.some((w) => w.label === "aggregate");
  } catch {
    return false;
  }
}

// 부팅 열기(restoreAggregateWindow) 유예 끝 시각 — 그 전에는 창 목록 재확인이 "없음"이어도 믿지 않는다.
// 창 생성은 메인 스레드에 예약될 뿐이라(lib.rs open_aggregate_window) 응답 직후엔 목록에 아직 없다.
let bootOpenUntil = 0;
const BOOT_OPEN_GRACE_MS = 15_000;
// 종료가 창을 닫은 뒤로는 열림 위치를 다시 쓰지 않는다 — 그 "닫힘"을 사용자가 닫은 것으로 적으면 복원이 사라진다.
let shutdownSeen = false;

/**
 * 메인 창에서 호출 — 모아보기 창의 열림 여부를 구독한다. 정리 함수를 돌려준다.
 * 이벤트(즉시성) + 포커스 시 재확인(정합성)의 두 겹이다.
 */
export function watchAggregateWindow(onChange: (open: boolean) => void): () => void {
  let disposed = false;
  const sync = () => {
    void isAggregateWindowOpen().then((v) => {
      if (disposed || (!v && Date.now() < bootOpenUntil)) return;
      onChange(v);
    });
  };

  sync(); // 초기값 — 메인이 새로고침돼도 실제 상태를 따라간다
  const unlisten = listen<AggregateWindowState>(EVENT, (e) => {
    bootOpenUntil = 0; // 창이 스스로 알렸다 — 이제 목록이 진실이다
    if (e.payload?.shutdown) shutdownSeen = true;
    if (!disposed) onChange(!!e.payload?.open);
  });
  window.addEventListener("focus", sync);

  return () => {
    disposed = true;
    window.removeEventListener("focus", sync);
    void unlisten.then((f) => f()).catch(() => {});
  };
}

// ---- 재시작해도 하던 그대로(태스크 78 D3): 모아보기가 어디 열려 있었나 ----
export type AggregateView = "main" | "window";
const VIEW_KEY = "gp:aggregate-view";
/** 확대한 칸 — AggregateTerminals 가 읽고 쓴다. 여기 있는 건 사용자가 모아보기를 닫을 때 같이 지우기 위해서다. */
export const AGGREGATE_ZOOM_KEY = "gp:aggregate-zoom";

export function readAggregateView(): AggregateView | null {
  const v = localStorage.getItem(VIEW_KEY);
  return v === "main" || v === "window" ? v : null;
}

export function saveAggregateView(view: AggregateView | null): void {
  if (shutdownSeen) return;
  if (view) localStorage.setItem(VIEW_KEY, view);
  else {
    localStorage.removeItem(VIEW_KEY);
    // 확대는 **재시작** 복원용이다 — 사용자가 닫았다 다시 열 때까지 남기면, 그 사이 새로 연 터미널이 확대 칸 뒤(invisible)에
    // 숨어 안 보인다(새 칸이 들어오면 확대를 푸는 효과는 마운트 중에만 돈다).
    localStorage.removeItem(AGGREGATE_ZOOM_KEY);
  }
}

/**
 * 부팅 때 지난번 별도 창을 다시 연다. 호출 전에 메인이 `aggregateWindowOpen=true` 로 터미널을 접어 둬야 한다
 * (아니면 메인이 PTY 를 먼저 열어 같은 터미널을 두 창이 연다). false = 못 열었다 — 호출자가 메인으로 되돌린다.
 * 창이 유예 안에 스스로 알렸으면(이벤트) 그 이벤트가 이미 상태를 정했으니 true.
 */
export async function restoreAggregateWindow(): Promise<boolean> {
  bootOpenUntil = Date.now() + BOOT_OPEN_GRACE_MS;
  try {
    await invokeOpen(readAggregateWindowGeom());
  } catch (e) {
    bootOpenUntil = 0;
    console.error("모아보기 창 복원 실패:", e);
    return false;
  }
  await new Promise((r) => setTimeout(r, BOOT_OPEN_GRACE_MS));
  if (bootOpenUntil === 0) return true;
  bootOpenUntil = 0;
  return isAggregateWindowOpen();
}
