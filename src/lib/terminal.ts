import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { warn as logWarn } from "@tauri-apps/plugin-log";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

import { currentMessages } from "../i18n/ui-language";
import { useUi } from "../stores/ui";
import { copyFailMessage, copyText, readClipboardText } from "./clipboard";
import { errorMessage } from "./ipc";
import { isMac } from "./platform";
import { forgetPtyInput } from "./prompt-capture";
import { noteTerminalOutput } from "./terminal-perf-log";

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
  /** 이 PTY가 win32-input-mode(DECSET 9001)를 요청했는가 — ConPTY가 시작 시 `\x1b[?9001h`를
   *  보낸다. 엔진이 CSI 핸들러로 갱신하며, Shift/Alt+Enter 인코딩 선택에 쓴다. */
  win32Input: boolean;
  /** 마우스 추적 모드에서 **마지막으로 사용자가 만든 선택**. 그 모드에선 xterm 선택이 마우스
   *  리포트 한 번에 지워져 우클릭 메뉴가 열릴 땐 항상 비어 있다(기전은 엔진의 `onSelectionChange`
   *  등록부 주석). 엔진이 채우고 `snapshotSelection`이 읽는다. 마우스 모드가 켜지거나 꺼질 때
   *  비운다 — 한 TUI 에피소드 밖으로는 새지 않는다. */
  lastSelection: string;
  /** 이 인스턴스가 PTY 출력을 받는 채널 — 재연결(reattachAllTerminals)에 다시 쓴다.
   *  PTY의 출력 소비자는 하나뿐이라(term_attach가 sink를 교체) 다른 창이 가져갔다 돌려줄 때
   *  같은 채널로 붙여야 기존 xterm이 그대로 이어진다. 엔진이 생성 직후 채운다. */
  channel?: Channel<ArrayBuffer>;
  /** WebGL 렌더러 획득/반납 — **보이는 터미널만** 컨텍스트를 쥐게 한다(태스크 69 §3).
   *  `attachTerminal`이 acquire, `unmountTerminalView`가 1.5초 뒤 release 한다. 둘 다 멱등이고,
   *  WebKitGTK(Linux)에서는 no-op이다(그쪽은 WebGL을 아예 쓰지 않는다 — 엔진 주석). */
  acquireWebglRenderer: () => void;
  releaseWebglRenderer: () => void;
}

/** 살아 있는 터미널 인스턴스 레지스트리 — 엔진이 등록하고, 코어/스캐너가 조회한다. */
export const registry = new Map<string, TermInstance>();

/**
 * PTY 출력 채널을 **새로 만들어** 인스턴스에 꽂는다. `term_open`/`term_attach`에 넘길 것.
 *
 * ## 같은 Channel 객체를 두 번 넘기면 안 된다 — 출력이 영구히 멎는다
 *
 * Tauri v2의 `Channel`은 순서 보장을 위해 **양쪽에 인덱스 카운터**를 둔다. JS 쪽은
 * `nextMessageIndex`를 세면서 그 번호가 아닌 메시지는 `pendingMessages`에 쌓아 두고
 * (`@tauri-apps/api/core.js` Channel 클래스), Rust 쪽은 `__CHANNEL__:<id>` 를 역직렬화할 때마다
 * **카운터가 0인 새 Channel을 만든다.**
 *
 * 그래서 이미 N개를 받은 채널을 `term_attach`에 다시 넘기면, 이후 도착하는 메시지의 인덱스는
 * 0,1,2… 인데 JS는 N을 기다린다 → 전부 `pendingMessages`로 들어가 **한 줄도 그려지지 않는다.**
 * 예외도 로그도 없다. 터미널이 그냥 멈춘 화면이 된다.
 *
 * 2026-08-28 실사례: 모아보기 별도 창을 닫으면 메인 창 터미널이 이 상태가 됐다 — 출력이 죽은 채
 * 옛 화면만 남고, PTY 크기도 저쪽 창 것으로 남아 글자가 왼쪽 일부에만 그려져 있었다.
 *
 * 페이로드는 `ArrayBuffer`다 — Rust가 `Channel<tauri::ipc::Response>`(= Raw)로 보내므로
 * JSON 숫자 배열을 거치지 않는다(태스크 63 §4 P0). 인덱스 카운터 계약은 그대로다.
 */
export function attachOutputChannel(inst: TermInstance): Channel<ArrayBuffer> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (bytes) => {
    try {
      // 파싱 완료 콜백은 **에코 측정이 대기 중일 때만** 돌아온다 — 평소엔 콜백 없는 기존
      // 호출 그대로다(메시지마다 클로저를 만들면 여기가 출력 경로에서 가장 뜨겁다).
      const onParsed = noteTerminalOutput(inst.id, bytes.byteLength);
      const data = new Uint8Array(bytes);
      if (onParsed) inst.term.write(data, onParsed);
      else inst.term.write(data);
    } catch (e) {
      warnOutputWriteFailure(inst, e);
    }
  };
  inst.channel = ch;
  return ch;
}

/** 이미 알린 터미널 — 50MB 초과는 청크마다 다시 던지므로 그대로 두면 로그가 그 한 줄로 찬다. */
const writeFailureWarned = new Set<string>();

/**
 * 출력 쓰기 실패를 **말한다**. 예전엔 빈 catch 하나라 xterm이 50MB 워터마크에서 던지는
 * `write data discarded, use flow control to avoid losing data`(WriteBuffer.ts)까지 삼켜져,
 * 출력이 조용히 사라지는데 로그에 아무 흔적도 없었다(태스크 69 §5).
 *
 * dispose/detach 직후의 짧은 공백은 정상이라 그대로 무시한다 — 그 두 경로는 `term.dispose()`
 * **전에** 레지스트리에서 인스턴스를 빼므로, 레지스트리에 없으면 "이미 거둔 터미널"이다.
 */
function warnOutputWriteFailure(inst: TermInstance, e: unknown): void {
  if (registry.get(inst.id) !== inst) return;
  if (writeFailureWarned.has(inst.id)) return;
  writeFailureWarned.add(inst.id);
  void logWarn(
    `[term-perf] 출력 쓰기 실패 term=${inst.id.slice(0, 8)}: ${errorMessage(e)}`, // i18n-ok: 로그
  ).catch(() => {
    // 로그 전송까지 실패하면 남길 곳이 콘솔뿐이다(여기서 또 던지면 출력 경로가 막힌다).
    console.warn("[term-perf] 출력 쓰기 실패(로그 전송도 실패):", e);
  });
}

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

/** 새 터미널이 뜨자마자 PTY에 넣을 입력 — 지금은 Claude Code 세션 띄우기 하나뿐.
 *  `\r`이 Enter다(키 입력과 같은 경로라 셸 종류를 안 탄다). */
export const CLAUDE_LAUNCH = "claude\r";

/** 예약된 초기 입력 — `paneId → {명령, 예약시각}`.
 *
 *  **localStorage에 두는 이유**: 모아보기 별도 창에서 새 터미널을 요청하면 `openTerminal`은
 *  메인에 위임되고, 같은 pane을 두 창이 그리므로 `term_open`을 어느 창이 잡을지는 마운트
 *  순서가 정한다. 예약이 요청한 창의 메모리에만 있으면 다른 창이 spawn한 경우 명령이 사라진다
 *  → 창 간 전달 관례(`gp:doc-windows` 등)를 따라 스토리지에 두고 **open을 수행한 창이 소비**한다.
 *
 *  60초 만료: 소비되지 않고 남은 예약은 다음 부팅의 세션 복구가 같은 paneId를 **새 open**으로
 *  되살릴 때(attach가 아니다 — commands/terminal.rs) 다시 소비돼, 재시작할 때마다 그 탭이
 *  claude를 또 띄운다. 예약 시각으로 그 부수효과를 잘라낸다. */
const INITIAL_KEY = "gp:term-initial-input";
const INITIAL_TTL_MS = 60_000;
type InitialInputs = Record<string, { data: string; at: number }>;

function readInitialInputs(): InitialInputs {
  try {
    return (JSON.parse(localStorage.getItem(INITIAL_KEY) || "{}") ??
      {}) as InitialInputs;
  } catch {
    return {}; // 손상 값은 없는 것으로
  }
}

function writeInitialInputs(all: InitialInputs): void {
  try {
    localStorage.setItem(INITIAL_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 불가 환경 — 예약 없이 그냥 빈 터미널이 뜬다 */
  }
}

/** paneId가 처음 열릴 때 PTY에 보낼 입력을 예약한다. `openTerminal` 직후 같은 틱에 부른다
 *  (pane 마운트는 다음 커밋이라 예약이 항상 먼저 저장된다). */
export function queueInitialInput(paneId: string, data: string): void {
  const now = Date.now();
  // 소비되지 않은 만료 예약은 함께 버린다 — 위임 실패 등으로 영영 안 열리는 pane의 항목이
  // 쌓이지 않게(이 함수 말고는 남의 키를 지울 사람이 없다).
  const all: InitialInputs = Object.fromEntries(
    Object.entries(readInitialInputs()).filter(
      ([, v]) => now - v.at < INITIAL_TTL_MS,
    ),
  );
  all[paneId] = { data, at: now };
  writeInitialInputs(all);
}

/** 예약을 꺼내며 지운다(1회성). 만료됐으면 지우기만 하고 null. */
export function takeInitialInput(paneId: string): string | null {
  const all = readInitialInputs();
  const item = all[paneId];
  if (!item) return null;
  delete all[paneId];
  writeInitialInputs(all);
  return Date.now() - item.at < INITIAL_TTL_MS ? item.data : null;
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
  const live = [...registry.values()].filter(
    (i) => i.status === "live" && i.channel,
  );
  if (live.length === 0) return;
  for (const inst of live) {
    // **채널을 새로 만든다.** 쓰던 것을 다시 넘기면 인덱스가 어긋나 출력이 통째로 멎는다
    // (attachOutputChannel 주석 — 이 함수의 원래 구현이 정확히 그 버그였다).
    void invoke("term_attach", {
      termId: inst.id,
      onData: attachOutputChannel(inst),
    }).catch(() => {});
  }
  // **크기도 되돌려야 한다.** 저쪽 창은 자기 셀 크기로 PTY를 줄여 놓았는데, 이쪽 xterm은 내내
  // 큰 상태였으므로 `fit()`이 아무것도 바꾸지 않아 `onResize`가 안 뜬다 → PTY가 작은 채로 남아
  // TUI가 화면 왼쪽 일부에만 그려진다(2026-08-28 실사례). 값이 같아도 강제로 다시 보낸다.
  //
  // 한 프레임 미루는 이유: 저 창이 떠 있는 동안 메인 창 크기가 바뀌었을 수 있어, pane의
  // attach→fit이 먼저 돌게 두고 그 결과 크기를 보낸다. fit이 보낸 것과 이것이 겹쳐도
  // 엔진의 리사이즈 체인이 순서를 지켜 마지막 값이 남는다.
  requestAnimationFrame(() => {
    void import("./terminal-engine").then((m) => {
      for (const inst of live) m.resyncTerminalSizeImpl(inst.id);
    });
  });
}

/** WebGL 반납 예약(termId → 타이머) — `unmountTerminalView`가 잡고 `attachTerminal`·종료 경로가
 *  취소한다. 예약이 남은 채 인스턴스가 사라지면 나중에 엉뚱한 재생성분을 반납하므로 반드시 짝을 맞춘다. */
const pendingWebglRelease = new Map<string, number>();
/** 탭 왕복·모아보기 이동처럼 곧 되돌아오는 경우에 컨텍스트를 재생성하지 않기 위한 유예. */
const WEBGL_RELEASE_DELAY_MS = 1500;

function cancelWebglRelease(id: string): void {
  const timer = pendingWebglRelease.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingWebglRelease.delete(id);
}

/**
 * 뷰(터미널 탭 pane · 모아보기 셀)가 사라질 때 — xterm과 PTY는 그대로 두고 **WebGL 컨텍스트만**
 * 1.5초 뒤 반납한다.
 *
 * Chromium(WebView2)은 WebGL 컨텍스트를 16개까지만 살려 두는데, xterm 인스턴스는 탭이 닫히기
 * 전까지 레지스트리에 남는다(host만 DOM에서 떨어진다) — 그래서 예전엔 "한 번이라도 본 터미널"
 * 수만큼 컨텍스트가 쌓여 17개째부터 서로 밀어내는 생성↔손실 핑퐁이 돌았다(태스크 69 §1·§3).
 *
 * **host가 아직 그 container에 붙어 있을 때만** 예약한다 — 다른 뷰가 이미 가져갔으면 그쪽이
 * 보이는 중이라 건드리면 안 된다.
 */
export function unmountTerminalView(id: string, container: HTMLElement): void {
  const inst = registry.get(id);
  if (!inst || inst.host.parentElement !== container) return;
  cancelWebglRelease(id);
  pendingWebglRelease.set(
    id,
    window.setTimeout(() => {
      pendingWebglRelease.delete(id);
      // 그 사이 dispose됐으면 레지스트리에 없다 — 그쪽이 이미 반납했다.
      registry.get(id)?.releaseWebglRenderer();
    }, WEBGL_RELEASE_DELAY_MS),
  );
}

/** host를 컨테이너에 붙이고 맞춘다. 탭 활성화 시 호출. */
export function attachTerminal(id: string, container: HTMLElement) {
  const inst = registry.get(id);
  if (!inst) return;
  if (inst.host.parentElement !== container) container.appendChild(inst.host);
  // 이제 보인다 — 반납 예약을 취소하고 컨텍스트를 확보한다(상한이면 DOM 렌더러로 돌고,
  // 영구가 아니다: 다음 attach가 곧 재시도다).
  cancelWebglRelease(id);
  inst.acquireWebglRenderer();
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
    copyTerminalText(withSel.id, sel);
  });
}

/** 스마트 붙여넣기 진행 중 플래그 — 완료 전의 ⌘V/Ctrl+V 재진입을 무시한다.
 *  macOS 페이스트보드 프라이버시 프롬프트(26+)가 떠 있는 동안 ⌘V를 연타하면, 가드 없이는
 *  호출마다 OS 읽기(=프롬프트)가 하나씩 쌓였다가 Allow 순간 쌓인 붙여넣기가 한꺼번에 발사된다
 *  (2026-08-28 실사례 — 같은 경로가 연속으로 수십 번 붙었다). */
let pasteInFlight = false;

/** 스마트 붙여넣기 — 백엔드(term_paste, 3플랫폼 실구현)가 클립보드를 판별(파일/이미지→경로,
 *  그 외 텍스트)한 텍스트를 넣는다. 플러그인 readText 폴백은 **invoke가 실패(reject)했을 때만**
 *  탄다 — 빈 문자열은 "클립보드가 비었거나 읽을 수 없음"이라는 유효한 답이고, 그때 또 읽으면
 *  macOS에선 프라이버시 프롬프트가 하나 더 뜬다(위 pasteInFlight 주석의 폭주 기전 절반이
 *  바로 이 이중 읽기였다).
 *  PTY에 직접 쓰지 않고 term.paste()를 경유한다: xterm이 개행 정규화(\n→\r)와 bracketed
 *  paste(ESC[200~) 래핑을 처리해, 멀티라인 붙여넣기가 셸에서 줄마다 즉시 실행되는 사고를 막는다
 *  (최종 전송은 어차피 onData → term_write 경로).
 *  한계: 플로팅 분리/재도킹으로 새로 만든 xterm(attach)은 이전 출력의 \x1b[?2004h를 못 봐
 *  모드 플래그가 꺼진 채 시작한다 — 그 창의 첫 멀티라인 붙여넣기는 비브래킷으로 나갈 수 있다
 *  (zsh는 다음 프롬프트에서 재설정, Claude Code류 TUI는 세션 내 지속). 근본 해결은 Rust가
 *  세션별 2004 모드를 추적해 attach 시 프론트 파서에 되살리는 것 — 후속 과제.
 *
 *  **무음 실패를 남기지 않는다**(A-K4). 예전엔 `catch { noop }` 하나에 모든 게 삼켜져
 *  "붙여넣기를 눌렀는데 아무 일도 안 일어남"이 로그조차 없이 끝났다. 이제 백엔드가 세 갈래를
 *  구분해 주므로(term_paste 주석) 각각에 말을 붙인다: 빈 클립보드=info, 못 읽음=사유 + [다시 시도]. */
export async function pasteIntoTerminal(id: string) {
  if (pasteInFlight) return;
  pasteInFlight = true;
  try {
    // `null`은 "클립보드가 비었다"는 **유효한 답**이다 — 플러그인 폴백은 invoke가 reject했을
    // 때만 탄다(위 주석: 빈 값에 또 읽으면 macOS 프롬프트가 하나 더 뜬다).
    let text: string | null;
    let failure = "";
    try {
      text = await invoke<string | null>("term_paste");
    } catch (e) {
      text = await readClipboardText();
      if (!text) failure = errorMessage(e);
    }
    const inst = getTerminal(id);
    if (text) inst?.term.paste(text);
    else if (failure) {
      useUi
        .getState()
        .pushToast("error", currentMessages().lib.terminal.pasteFailed(failure), {
          label: currentMessages().lib.toastRetry,
          run: () => void pasteIntoTerminal(id),
        });
    } else {
      useUi.getState().pushToast("info", currentMessages().lib.terminal.clipboardEmpty);
    }
    // 포커스는 **어느 갈래에서든** 돌려준다 — 안 돌려주면 다음 키 입력이 PTY로 안 간다.
    inst?.term.focus();
  } catch {
    /* noop */
  } finally {
    pasteInFlight = false;
  }
}

/** 우클릭 메뉴가 "복사할 것"을 정하는 **단일 규칙**. PaneMenu·ChipMenu가 열리는 순간 부른다.
 *
 *  평소엔 지금 선택 그대로다. **앱이 마우스를 쓰는 중일 때만** 스태시로 내려간다 — 그 모드에선
 *  우클릭의 mousedown 자체가 마우스 리포트가 되어 xterm이 선택을 이미 지운 뒤라(엔진의
 *  `onSelectionChange` 등록부 주석), 라이브 값은 **언제나** 빈 문자열이다. 마우스 모드가 아닐
 *  때까지 스태시를 쓰면 "아까 선택했던 것"이 되살아나 사용자가 지운 선택이 복사된다. */
export function snapshotSelection(id: string): string {
  const inst = registry.get(id);
  if (!inst) return "";
  if (inst.term.hasSelection()) return inst.term.getSelection();
  return inst.term.modes.mouseTrackingMode !== "none" ? inst.lastSelection : "";
}

/** 터미널 복사의 **단일 경로** — Ctrl+C·Ctrl+Shift+C·Cmd+C·전역 폴백·우클릭 메뉴가 모두 여기로
 *  온다. 성공하면 선택을 해제해 "복사됐다"를 눈으로 알리고(무음 성공이면 사용자는 다시 누른다),
 *  실패는 **사유와 함께** 토스트로 알린다(clipboard.ts의 계층 쓰기가 남긴 lastCopyFailure).
 *
 *  **텍스트를 인자로 받는 게 핵심이다.** 메뉴에서 부를 때 여기서 `getSelection()`을 다시 읽으면
 *  안 된다 — macOS는 xterm 기본값이 "우클릭 = 커서 아래 단어 선택"이라(rightClickSelectsWord),
 *  메뉴가 뜨는 사이 선택이 통째로 바뀐 뒤였다. 지금은 그 옵션도 끄고(terminal-engine.ts),
 *  메뉴는 열린 순간의 스냅샷을 넘긴다(`snapshotSelection`). */
export function copyTerminalText(id: string, text: string) {
  if (!text) return;
  void copyText(text).then((ok) => {
    if (ok) registry.get(id)?.term.clearSelection();
    else useUi.getState().pushToast("error", copyFailMessage());
  });
}

/** 플로팅 분리용 — xterm 인스턴스/host만 정리하고 PTY(term_close)는 호출하지 않는다.
 *  PTY는 살아있고, 새 OS 창이 term_attach로 출력을 이어받는다. */
export function detachTerminalKeepPty(id: string) {
  const inst = registry.get(id);
  if (!inst) return;
  registry.delete(id);
  // 입력 복원 상태만 버린다 — 세션은 살아 있고 이어받는 창이 새로 쌓는다(기록 자체는 보존).
  forgetPtyInput(id);
  // `term.dispose()`는 애드온을 **조용히** 거둔다 — 그 전에 반납해야 엔진의 살아있는 컨텍스트
  // 카운터가 정확히 내려간다. 새면 상한 기아로 이후 모든 터미널이 DOM 렌더러가 된다.
  // (예약 중이던 반납도 함께 지운다 — 인스턴스가 없어진 뒤 타이머가 깨어나면 할 일이 없다.)
  cancelWebglRelease(id);
  inst.releaseWebglRenderer();
  try {
    inst.term.dispose();
  } catch {
    /* noop */
  }
  inst.host.remove();
}

/** 세션 완전 종료 — PTY kill + xterm dispose + 레지스트리 제거. term_close 완료를 await할 수 있다. */
export function disposeTerminal(id: string): Promise<void> {
  // PTY kill은 **이 창이 그린 적 있느냐와 무관하게** 보낸다. 모아보기 별도 창이 위임으로 만든
  // 터미널은 그 창이 spawn하고 메인은 takenByWindow 동안 xterm을 만들지 않는다 — 그 pane을
  // 메인이 닫을 때(closePane 위임 수신) 레지스트리에 인스턴스가 없다는 이유로 건너뛰면 스토어에서만
  // 사라진 PTY가 고아 셸로 남는다(실측: 2026-09-02 위임 검증에서 term_project가 계속 non-null).
  // 세션이 없는 id면 백엔드가 no-op이라 무조건 보내도 해가 없다.
  const closed = invoke("term_close", { termId: id }).catch(() => {}) as Promise<void>;
  const inst = registry.get(id);
  if (!inst) return closed;
  registry.delete(id);
  // 입력 복원 상태만 버린다. **프롬프트 기록은 여기서 지우지 않는다** — 이 함수는 "프로세스가
  // 종료되었습니다 → 재시작"(TerminalPane)에서도 불리는데, 같은 패널을 되살리는 것뿐이라
  // 기록까지 날리면 방금 뭘 시켰는지 잃는다. 패널 자체가 사라질 때(stores/terminals의 닫기
  // 경로)만 기록을 지운다.
  forgetPtyInput(id);
  cancelWebglRelease(id); // 이유는 detachTerminalKeepPty 쪽 주석
  inst.releaseWebglRenderer();
  try {
    inst.term.dispose();
  } catch {
    /* noop */
  }
  inst.host.remove();
  return closed;
}
