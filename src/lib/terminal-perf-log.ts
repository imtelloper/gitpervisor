import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

import { errorMessage, ipc, type HealthLevel, type HealthTransition } from "./ipc";

/**
 * 터미널 체감 지연 측정 로그 `[term-perf]` (태스크 69 §5).
 *
 * **릴리스 빌드에서도 상시 돈다.** "터미널이 버벅인다"는 신고가 들어왔을 때 재현을 기다리지
 * 않고 그 시각의 `Gitpervisor.log`만 보고 원인 축을 가르려고 남긴다 — 같은 파일의 `[health]`
 * 줄·Rust 쪽 `[term-perf] pty-throttle` 줄과 UTC 타임스탬프로 맞춰 읽는다. 읽는 법은
 * `DOCS/task/69-terminal-lag-fixes-and-perf-log.md` 끝의 표.
 *
 * 오버헤드 예산은 **창당 250ms 타이머 하나 + longtask 옵저버 하나**다. 그래서
 *  - 뜨거운 경로(`ptyWrite`·채널 onmessage·`term_write` 왕복)에서는 상수 시간 카운팅만 하고,
 *    `term.write(data, cb)`의 콜백은 **에코 측정이 대기 중인 터미널일 때만** 만든다.
 *  - 표본 배열은 60초 창마다 비우고 상한(2000)을 둬 무한히 자라지 않는다.
 *
 * 측정이 입력·출력 경로를 막는 일은 어떤 이유로도 없어야 한다(`capturePtyInput`과 같은 규약) —
 * 진입점마다 감싸고, 한 번이라도 던지면 그 뒤로는 측정을 통째로 멈춘다.
 */

const WINDOW_MS = 60_000;
const TICK_MS = 250;
/** 창 하나가 담는 표본 상한 — 폭주 입력에서도 메모리가 늘지 않게. */
const SAMPLE_MAX = 2000;
/** 이 시간 안에 출력이 없으면 표본이 아니라 `noecho`로 센다. */
const ECHO_TIMEOUT_MS = 3000;
const SLOW_ECHO_MS = 300;
/** 파싱이 끝난 뒤 화면에 나갈 프레임까지(= paint − echo). 렌더·합성·GPU 쪽 정체만 따로 잡는다. */
const SLOW_PAINT_MS = 200;
const SLOW_LONGTASK_MS = 300;
const SLOW_LAG_MS = 500;
/** 로그 줄에 붙일 시스템 지표를 기다리는 한도 — 시스템이 멈춘 순간일수록 늦게 오므로 끊는다. */
const SYS_WAIT_MS = 1500;
/**
 * 이보다 큰 드리프트는 메인 스레드 점유가 아니라 **시계가 건너뛴 것**으로 본다(절전/최대 절전
 * 복귀 — `performance.now()`는 그 시간을 포함한다). 표본에 넣으면 `lag_max=3600000` 한 줄이
 * 그 분의 요약을 통째로 못 쓰게 만들고, 5초 쿨다운을 태워 직후의 진짜 경고까지 묻는다.
 * 60초: 사람이 손을 놓고 기다릴 수 있는 어떤 점유보다도 크다.
 */
const LAG_IMPLAUSIBLE_MS = 60_000;
/** 즉시 경고는 종류별로 이 간격에 한 줄까지 — 느려진 순간엔 임계를 연속으로 넘긴다. */
const SLOW_COOLDOWN_MS = 5000;

/** 한 창(60초)에 모으는 표본. 포맷 함수가 이것만 보고 줄을 만든다(순수). */
export interface TerminalPerfWindow {
  startedAt: number;
  /** 타이핑성 입력 횟수(`isTypingInput`). */
  keys: number;
  /** 3초 안에 출력이 오지 않은 입력 수. */
  noecho: number;
  /** 입력 → 그 뒤 첫 출력의 **파싱 완료**까지(ms). */
  echoMs: number[];
  /** 입력 → 그 뒤 첫 출력의 **도착**까지(ms). echo와의 차이가 xterm 쓰기 버퍼 적체다. */
  arriveMs: number[];
  /**
   * 입력 → 에코가 그려진 프레임 **다음** 프레임 시작까지(ms) = 사람이 화면에서 보는 지연.
   * echo는 파싱까지만이라 렌더·합성·GPU 정체를 못 본다(2026-09-21 조사에서 드러난 빈틈).
   */
  paintMs: number[];
  /** `term_write` invoke 왕복(ms). */
  writeMs: number[];
  /** 250ms 타이머 드리프트(ms) = 메인 스레드 점유. */
  lagMs: number[];
  longCount: number;
  longTotalMs: number;
  longMaxMs: number;
  outBytes: number;
  /** 터미널별 출력 바이트 — 한 터미널이 창을 혼자 먹는지 보려고 나눠 센다. */
  outByTerm: Map<string, number>;
  ticks: number;
  hiddenTicks: number;
}

/** 로그 한 줄에 함께 싣는 "지금 상태" — 60초 요약과 SLOW 줄이 같은 필드를 쓴다. */
export interface TerminalPerfState {
  win: string;
  terms: number;
  webgl: number;
  dom: number;
  ctxlost: number;
  /**
   * JS 힙(MB) — **버킷 단위 근사값이고 20분에 한 번만 갱신된다.** Chromium은 precise memory
   * info가 꺼져 있고 페이지가 cross-origin isolated가 아니면(Tauri 페이지가 그렇다)
   * `usedJSHeapSize`를 그렇게 준다. 그래서 "느려진 그 순간 힙이 튀었나"는 이 값으로 가를 수
   * 없다 — 시간대별 대략의 크기만 본다(정밀값이 필요하면 WebView2 인자에
   * `--enable-precise-memory-info`가 필요한데, 모든 창이 같은 인자를 써야 해서 별도 확인거리다).
   */
  heapMb: number | null;
  health: HealthLevel;
}

/** 설치할 때 받는 상태 출처. 엔진(`terminal-engine`)이 넘긴다 — 이 모듈이 엔진을 import 하면
 *  경량 코어(`terminal.ts`)를 통해 xterm 청크가 콜드 스타트 번들로 딸려 들어온다. */
export interface TerminalPerfSource {
  webglStats: () => { live: number; contextLost: number; domFallbackVisible: number };
  terminalCount: () => number;
}

function newWindow(now: number): TerminalPerfWindow {
  return {
    startedAt: now,
    keys: 0,
    noecho: 0,
    echoMs: [],
    arriveMs: [],
    paintMs: [],
    writeMs: [],
    lagMs: [],
    longCount: 0,
    longTotalMs: 0,
    longMaxMs: 0,
    outBytes: 0,
    outByTerm: new Map(),
    ticks: 0,
    hiddenTicks: 0,
  };
}

let win = newWindow(performance.now());
/** 에코 측정 대기 — 터미널당 하나뿐이다(대기 중엔 새 입력을 t0으로 잡지 않는다). */
const pendingEcho = new Map<string, { at: number }>();
let source: TerminalPerfSource | null = null;
let winLabel = "?";
let healthLevel: HealthLevel = "ok";
const slowLastAt = new Map<string, number>();
/** 측정이 한 번이라도 던지면 여기서 멈춘다 — 부가 기능이 입력·출력을 먹는 것보다 로그를 잃는 게 낫다. */
let perfBroken = false;
let installed = false;

function breakPerf(where: string, e: unknown): void {
  if (perfBroken) return;
  perfBroken = true;
  console.warn(`[term-perf] 측정을 멈춘다 — ${where}:`, e);
}

function push(arr: number[], v: number): void {
  if (arr.length < SAMPLE_MAX) arr.push(v);
}

/** 백분위(ms, 정수). 표본이 없으면 0 — 없다는 뜻이고, 같은 줄의 표본 수로 구분된다. */
export function percentileMs(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[i]);
}

function maxMs(values: number[]): number {
  let m = 0;
  for (const v of values) if (v > m) m = v;
  return Math.round(m);
}

/**
 * 에코 지연을 재도 되는 "타이핑성" 입력인가.
 *
 * `term.onData`에는 키 입력만이 아니라 xterm의 자동응답(커서 위치 CPR `\x1b[…R`, DA `\x1b[?…c`,
 * 포커스 `\x1b[I`/`\x1b[O`, SGR 마우스 리포트 `\x1b[<…M`)이 상시 흐른다 — TUI는 초당 수십 번
 * 질의하므로 그대로 세면 "키 142개"가 사람이 친 수와 무관해진다. 그 자동응답은 **전부 ESC로
 * 시작**하므로 한 가지로 갈린다. 한글 IME 확정 문자열은 텍스트라 여기 포함되고, 브래킷
 * 붙여넣기(`\x1b[200~`)는 ESC로 시작해 빠진다(붙여넣기는 타이핑 지연이 아니다).
 */
export function isTypingInput(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) !== 0x1b;
}

/** 60초 요약 한 줄. 필드 순서는 설계(§5) 그대로 — 로그를 grep·눈으로 세로 비교한다. */
export function formatTerminalPerfSummary(
  w: TerminalPerfWindow,
  st: TerminalPerfState,
  elapsedMs: number,
): string {
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  let outMax = 0;
  for (const bytes of w.outByTerm.values()) if (bytes > outMax) outMax = bytes;
  const kbPerSec = (bytes: number) => Math.round(bytes / 1024 / Math.max(1, elapsedMs / 1000));
  const hiddenPct = w.ticks > 0 ? Math.round((w.hiddenTicks / w.ticks) * 100) : 0;
  return (
    `[term-perf] win=${st.win} ${secs}s terms=${st.terms} webgl=${st.webgl} dom=${st.dom}` +
    ` ctxlost=${st.ctxlost} keys=${w.keys} noecho=${w.noecho}` +
    ` echo_p50=${percentileMs(w.echoMs, 50)} echo_p90=${percentileMs(w.echoMs, 90)} echo_max=${maxMs(w.echoMs)}` +
    ` arrive_p90=${percentileMs(w.arriveMs, 90)}` +
    ` paint_p90=${percentileMs(w.paintMs, 90)} paint_max=${maxMs(w.paintMs)}` +
    ` write_p50=${percentileMs(w.writeMs, 50)} write_max=${maxMs(w.writeMs)}` +
    ` lag_p99=${percentileMs(w.lagMs, 99)} lag_max=${maxMs(w.lagMs)}` +
    ` long=${w.longCount}/${Math.round(w.longTotalMs)}/${Math.round(w.longMaxMs)}` +
    (st.heapMb === null ? "" : ` heap_mb=${st.heapMb}`) +
    ` out_kb_s=${kbPerSec(w.outBytes)} out_max_kb_s=${kbPerSec(outMax)}` +
    ` health=${st.health} hidden_pct=${hiddenPct}`
  );
}

type SlowKind = "echo" | "paint" | "longtask" | "lag";

/** 임계를 넘은 순간 남기는 한 줄. 60초 요약과 같은 상태 필드를 달아 그 줄 하나로 판단할 수 있게 한다. */
export function formatTerminalPerfSlow(
  kind: SlowKind,
  ms: number,
  termId: string,
  st: TerminalPerfState,
): string {
  return (
    `[term-perf] SLOW kind=${kind} ms=${Math.round(ms)} term=${termId.slice(0, 8)}` +
    ` win=${st.win} terms=${st.terms} webgl=${st.webgl} dom=${st.dom} ctxlost=${st.ctxlost}` +
    (st.heapMb === null ? "" : ` heap_mb=${st.heapMb}`) +
    ` health=${st.health}`
  );
}

function currentState(): TerminalPerfState {
  const webgl = source?.webglStats();
  // performance.memory는 Chromium 전용 비표준이다 — WebKit(Linux/macOS)에는 없어 필드를 뺀다.
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    win: winLabel,
    terms: source?.terminalCount() ?? 0,
    webgl: webgl?.live ?? 0,
    dom: webgl?.domFallbackVisible ?? 0,
    ctxlost: webgl?.contextLost ?? 0,
    heapMb: mem ? Math.round(mem.usedJSHeapSize / 1_048_576) : null,
    health: healthLevel,
  };
}

/**
 * 줄 끝에 붙이는 그 순간의 시스템 지표(상태바와 같은 값). "터미널이 느렸다"가 앱 탓인지
 * 머신 전체가 바빴던 탓인지를 그 줄 하나로 가르려고 싣는다 — 2026-09-21 조사 때 이게 없어
 * 오전 렉의 원인 축(CPU·GPU·메모리)을 끝내 못 갈랐다.
 */
async function sysSuffix(): Promise<string> {
  try {
    const m = await Promise.race([
      ipc.sysMetrics(),
      new Promise<null>((r) => window.setTimeout(() => r(null), SYS_WAIT_MS)),
    ]);
    if (!m) return " sys=timeout";
    const gpu = m.gpu === null ? "na" : String(Math.round(m.gpu));
    return ` sys_cpu=${Math.round(m.cpu)} sys_gpu=${gpu} sys_ram=${Math.round(m.ram)}`;
  } catch (e) {
    // 지표를 못 읽어도 줄은 남긴다 — 이유만 줄에 표시한다.
    return ` sys=err(${errorMessage(e)})`;
  }
}

/** 로그 전송 실패(플러그인 미초기화·IPC 끊김)는 측정 자체를 멈출 이유가 아니다 — 1회만 알린다. */
let logFailWarned = false;
function emitLine(line: string, level: "info" | "warn"): void {
  void sysSuffix()
    .then((sys) => (level === "warn" ? logWarn(line + sys) : logInfo(line + sys)))
    .catch((e: unknown) => {
      if (logFailWarned) return;
      logFailWarned = true;
      console.warn("[term-perf] 로그 전송 실패:", e);
    });
}

function emitSlow(kind: SlowKind, ms: number, termId: string): void {
  const now = performance.now();
  const last = slowLastAt.get(kind);
  if (last !== undefined && now - last < SLOW_COOLDOWN_MS) return;
  slowLastAt.set(kind, now);
  emitLine(formatTerminalPerfSlow(kind, ms, termId, currentState()), "warn");
}

/** PTY로 나가는 입력 — `ptyWrite` 한 곳에서만 부른다(키·IME 확정·붙여넣기가 전부 그곳을 지난다). */
export function noteTypedInput(termId: string, data: string): void {
  if (perfBroken) return;
  try {
    if (!isTypingInput(data)) return;
    win.keys++;
    // 대기 중인 측정이 있으면 새로 잡지 않는다 — 빠른 연타에서 t0이 계속 밀려 지연이 0으로 보인다.
    if (!pendingEcho.has(termId)) pendingEcho.set(termId, { at: performance.now() });
  } catch (e) {
    breakPerf("입력 집계", e);
  }
}

/**
 * PTY 출력 한 청크 — 채널 `onmessage`에서 `term.write` **직전에** 부른다.
 *
 * 에코 측정이 대기 중인 터미널이면 파싱 완료 콜백을 돌려준다. 그때만 `term.write(data, cb)`로
 * 넘긴다 — 평소엔 메시지마다 클로저를 만들지 않는다(여기가 출력 경로에서 가장 뜨겁다).
 */
export function noteTerminalOutput(termId: string, bytes: number): (() => void) | undefined {
  if (perfBroken) return undefined;
  try {
    win.outBytes += bytes;
    win.outByTerm.set(termId, (win.outByTerm.get(termId) ?? 0) + bytes);
    const pending = pendingEcho.get(termId);
    if (!pending) return undefined;
    pendingEcho.delete(termId);
    push(win.arriveMs, performance.now() - pending.at);
    return () => {
      if (perfBroken) return;
      try {
        const ms = performance.now() - pending.at;
        push(win.echoMs, ms);
        if (ms >= SLOW_ECHO_MS) emitSlow("echo", ms, termId);
        // xterm은 파싱 중에 렌더를 rAF로 예약해 두었다 — 첫 rAF가 그 프레임, 두 번째 rAF가 시작되면
        // 에코가 담긴 프레임은 이미 나갔다. 숨은 창은 rAF가 멈춰 값이 부풀므로 뺀다.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (perfBroken || document.hidden) return;
            try {
              const paint = performance.now() - pending.at;
              push(win.paintMs, paint);
              if (paint - ms >= SLOW_PAINT_MS) emitSlow("paint", paint, termId);
            } catch (e) {
              breakPerf("에코 표시 콜백", e);
            }
          }),
        );
      } catch (e) {
        breakPerf("에코 파싱 콜백", e);
      }
    };
  } catch (e) {
    breakPerf("출력 집계", e);
    return undefined;
  }
}

/** `term_write` invoke 왕복 — 엔진의 `sendWrite`가 성공 시 부른다(호출 직전 시각을 넘긴다). */
export function noteWriteRoundtrip(startedAt: number): void {
  if (perfBroken) return;
  try {
    push(win.writeMs, performance.now() - startedAt);
  } catch (e) {
    breakPerf("전송 왕복 집계", e);
  }
}

/** 다음 틱이 와야 할 시각 — 실제 도착과의 차이가 메인 스레드 점유(lag)다. */
let expectedTickAt = 0;
/** 직전 틱이 숨은 상태였나 — 숨김→보임 **경계 틱**을 표본에서 빼기 위해 기억한다. */
let lastTickHidden = false;

function tick(): void {
  if (perfBroken) return;
  try {
    const now = performance.now();
    const lag = Math.max(0, now - expectedTickAt);
    expectedTickAt = now + TICK_MS;
    win.ticks++;
    const hidden = document.hidden;
    // 숨은 창은 타이머가 1Hz로 조여진다(Chromium 백그라운드 정책) — 그 드리프트는 메인 스레드
    // 점유가 아니라 브라우저 정책이라 표본에서 뺀다. 대신 얼마나 숨어 있었는지를 남긴다.
    //
    // **직전 틱이 숨은 상태였으면 이번 것도 뺀다.** 창을 복원한 직후 첫 틱은 기준 시각이
    // 1Hz로 조여진 숨은 틱에서 온 것이라 최대 750ms(그 이상도) 드리프트가 나는데, 그때는
    // 이미 `document.hidden === false`라 예전 구현은 그대로 lag로 세고 SLOW까지 냈다.
    if (hidden) win.hiddenTicks++;
    else if (!lastTickHidden && lag < LAG_IMPLAUSIBLE_MS) {
      push(win.lagMs, lag);
      if (lag >= SLOW_LAG_MS) emitSlow("lag", lag, "-");
    }
    lastTickHidden = hidden;

    // 3초가 지나도록 출력이 없는 입력은 표본이 아니라 noecho다.
    for (const [termId, pending] of pendingEcho) {
      if (now - pending.at < ECHO_TIMEOUT_MS) continue;
      pendingEcho.delete(termId);
      win.noecho++;
    }

    const elapsed = now - win.startedAt;
    if (elapsed < WINDOW_MS) return;
    // 조용한 창은 남기지 않는다 — 안 쓰는 창(플로팅·모아보기)이 로그를 분 단위로 채우면
    // 정작 느려진 구간을 찾기 어려워진다.
    if (win.keys > 0 || win.outBytes > 0 || win.longCount > 0)
      emitLine(formatTerminalPerfSummary(win, currentState(), elapsed), "info");
    win = newWindow(now);
  } catch (e) {
    breakPerf("주기 집계", e);
  }
}

/**
 * 측정을 설치한다 — **첫 터미널 생성 시 1회**(엔진의 `createTerminalImpl`). 모듈 로드 시가
 * 아닌 이유: 터미널을 한 번도 안 연 창(문서 창 등)에 타이머·옵저버를 들이지 않는다.
 * 별도 창(모아보기·플로팅)에서도 같은 모듈이 따로 돌므로 로그는 `win=`으로 갈라 읽는다.
 */
export function startTerminalPerfLog(src: TerminalPerfSource): void {
  if (installed) return;
  installed = true;
  source = src;
  try {
    winLabel = getCurrentWebviewWindow().label;
    // 창은 **설치 시점**부터 센다. 모듈 로드 시각으로 두면(정적 import라 페이지 로드 때다)
    // 첫 터미널을 10분 뒤에 연 창의 첫 요약이 "600s" 창에 표본 몇 개짜리로 나가 속도 필드가
    // 통째로 틀린다.
    win = newWindow(performance.now());
    expectedTickAt = performance.now() + TICK_MS;
    window.setInterval(tick, TICK_MS);

    // longtask는 Chromium 전용이다 — 없는 웹뷰에서는 observe가 던지고 그 필드만 0으로 남는다.
    try {
      new PerformanceObserver((list) => {
        if (perfBroken) return;
        try {
          for (const entry of list.getEntries()) {
            win.longCount++;
            win.longTotalMs += entry.duration;
            if (entry.duration > win.longMaxMs) win.longMaxMs = entry.duration;
            if (entry.duration >= SLOW_LONGTASK_MS) emitSlow("longtask", entry.duration, "-");
          }
        } catch (e) {
          breakPerf("longtask 집계", e);
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch (e) {
      console.warn("[term-perf] longtask 관측 불가 — long= 필드는 0으로 남는다:", e);
    }

    // health 레벨은 **읽기만** 한다(판정은 Rust health/mod.rs). 전이 이벤트만 구독하면 이미
    // 경보 중일 때 열린 창이 60분 내내 health=ok로 찍히므로 현재 값을 한 번 읽어 시작한다.
    void listen<HealthTransition>("health://level", (e) => {
      healthLevel = e.payload.level;
    }).catch((e: unknown) => console.warn("[term-perf] health 전이 구독 실패:", e));
    void ipc
      .healthSnapshot()
      .then((s) => {
        if (s) healthLevel = s.level;
      })
      // 시작값을 못 읽으면 첫 전이까지 ok로 남는다 — 측정을 멈출 일은 아니다.
      .catch(() => {});
  } catch (e) {
    breakPerf("설치", e);
  }
}

/** 지금까지 모인 창 — e2e(DEV 훅)가 타이핑 전후로 표본 수를 비교한다. 창은 비우지 않는다. */
export function terminalPerfSnapshot() {
  let outMaxTermBytes = 0;
  for (const bytes of win.outByTerm.values())
    if (bytes > outMaxTermBytes) outMaxTermBytes = bytes;
  return {
    elapsedMs: Math.round(performance.now() - win.startedAt),
    keys: win.keys,
    noecho: win.noecho,
    pending: pendingEcho.size,
    echoMs: [...win.echoMs],
    arriveMs: [...win.arriveMs],
    paintMs: [...win.paintMs],
    writeMs: [...win.writeMs],
    lagMs: [...win.lagMs],
    long: { count: win.longCount, totalMs: win.longTotalMs, maxMs: win.longMaxMs },
    outBytes: win.outBytes,
    outMaxTermBytes,
    ticks: win.ticks,
    hiddenTicks: win.hiddenTicks,
    broken: perfBroken,
    state: currentState(),
  };
}

if (import.meta.env.DEV) {
  // e2e가 재는 것: 타이핑 전후 표본 수 증가·에코 값의 범위·요약 한 줄의 필드·`isTypingInput`의
  // 자동응답 제외. 훅 안에서 던져도 앱 경로는 그대로여야 하므로 위 진입점들과 같은 규약으로
  // 감싼다(여기서 던지면 e2e가 그 자리에서 빨개진다 — 조용한 통과는 없다).
  (window as unknown as { __gpvTermPerf?: unknown }).__gpvTermPerf = {
    snapshot: terminalPerfSnapshot,
    formatSummaryNow: () =>
      formatTerminalPerfSummary(win, currentState(), performance.now() - win.startedAt),
    isTypingInput,
  };
}
