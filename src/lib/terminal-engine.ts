import { invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { collectPanes, useTerminals } from "../stores/terminals";
import { useTermThemes } from "../stores/termThemes";
import { useUi } from "../stores/ui";
import { errorMessage } from "./ipc";
import { copyText } from "./clipboard";
import { isMod, isWindows } from "./platform";
import { capturePtyInput } from "./prompt-capture";
import { termSchemeOf } from "./term-color-schemes";
import {
  attachOutputChannel,
  ensureExitListener,
  pasteIntoTerminal,
  registry,
  takeInitialInput,
  type TermInstance,
} from "./terminal";
import { themeOf } from "./themes";

// 이 모듈은 **무거운 xterm 엔진**이다(@xterm/xterm + addon-fit + addon-webgl + addon-unicode11 + css).
// 경량 코어(./terminal)에서 첫 터미널 탭이 열릴 때만 동적 import되어, 콜드 스타트 번들에서
// xterm을 제외한다. 레지스트리·인스턴스 조작·exit 구독은 코어가 소유한다(여기선 import만).

// PTY 입력 송신 — **termId별로 순서를 보장한다.**
//
// 백엔드 `term_write`는 `#[tauri::command(async)]`라 호출마다 워커 스레드로 흩어진다. 예전엔
// 동기 커맨드여서 IPC 스레드 하나가 도착 순서대로 처리하는 것이 **암묵적** 순서 보장이었는데,
// 패닉 격리를 위해 async로 바꾸면서 그 보장이 사라졌다. 이 파일의 송신은 키 입력·IME 델타·
// 붙여넣기·xterm 자동응답까지 전부 fire-and-forget이라, 체이닝하지 않으면 빠르게 친 키가
// 뒤바뀐다("ls" → "sl"). 호출자 입장에선 여전히 fire-and-forget이다(await도 throw도 없다).
//
// **대기 중에 들어온 입력은 이어붙여 한 번에 보낸다**(태스크 63 §4 P1). 예전에는 키마다 이전
// 왕복이 끝나기를 기다린 뒤 다음을 보냈고, 그래서 **정지 1회의 비용이 대기 중인 키 개수만큼
// 곱해졌다** — IPC 펌프가 993ms 막힌 사이 8키를 치면 그 8키가 993ms 뒤부터 다시 하나씩 왕복해
// 지속 타이핑이 187 → 26 키/초로 무너졌다(실측). 지금은 1왕복으로 나간다.
//
// 순서 불변식은 그대로다: 이어붙이기는 순서를 보존하고, 한 번의 `term_write` 안에서는 Rust가
// `write_all`로 순서대로 쓴다. **대기 자체를 없앤 게 아니다** — 없애면 다시 "ls"가 "sl"이 된다.
const writeChains = new Map<string, Promise<void>>();
// 지금 나가 있는 전송이 끝나기를 기다리는 입력(termId → 이어붙인 문자열).
const pendingWrites = new Map<string, string>();
// 대기분 상한 — 거대 붙여넣기가 한 문자열로 무한히 부풀지 않게. 넘으면 더 모으지 않고
// 체인에 이어 내보낸다(순서는 그대로).
const PENDING_MAX = 1024 * 1024;

/** 실제 전송. `after`가 있으면 그 뒤에 잇는다(순서 보장). 완료 시 그동안 모인 입력을 한 번에 보낸다. */
function sendWrite(termId: string, data: string, after?: Promise<void>) {
  const next = (after ?? Promise.resolve())
    .then(() =>
      invoke("term_write", { termId, data }).then(
        () => {},
        () => {}, // 실패해도 체인을 끊지 않는다 — 한 번 실패가 이후 입력을 전부 막으면 안 된다
      ),
    )
    .then(() => {
      // 내가 마지막 전송일 때만 대기분을 넘겨받는다(그 사이 다른 전송이 걸렸으면 그쪽이 맡는다).
      if (writeChains.get(termId) === next) flushPending(termId);
    });
  writeChains.set(termId, next);
}

/** 모인 입력을 한 번에 내보낸다. 없으면 체인 항목을 지운다 —
 *  터미널을 오래 여닫아도 맵이 자라지 않고, 다음 입력이 대기 없이 즉시 나간다. */
function flushPending(termId: string) {
  const data = pendingWrites.get(termId);
  if (data === undefined) {
    writeChains.delete(termId);
    return;
  }
  pendingWrites.delete(termId);
  sendWrite(termId, data);
}

// PTY 리사이즈 송신 — 입력과 같은 이유로 **termId별 순서를 보장한다**. `term_resize`도 async
// 커맨드라 연속 리사이즈(드래그·창 전환)가 워커에서 뒤바뀌면 마지막 크기가 아니라 이전 크기가
// PTY에 남는다.
//
// 맵으로 뺀 이유는 xterm의 `onResize` 말고 **강제 재동기화**(`resyncTerminalSizeImpl`)도 같은
// 줄에 세워야 하기 때문이다. 두 경로가 별개 체인이면 재동기화가 fit이 보낸 새 크기를 옛 크기로
// 덮을 수 있다.
const resizeChains = new Map<string, Promise<void>>();

function ptyResize(termId: string, cols: number, rows: number) {
  const next = (resizeChains.get(termId) ?? Promise.resolve()).then(() =>
    invoke("term_resize", { termId, cols, rows }).then(
      () => {},
      () => {}, // 실패해도 체인을 끊지 않는다(ptyWrite와 동일)
    ),
  );
  resizeChains.set(termId, next);
  void next.then(() => {
    if (resizeChains.get(termId) === next) resizeChains.delete(termId);
  });
}

/**
 * 지금 xterm 크기를 PTY에 **다시** 알린다 — 값이 같아도 보낸다.
 *
 * 왜 필요한가: PTY 출력 소비자는 하나뿐이라 모아보기 별도 창이 터미널을 가져가면 그 창의 작은
 * 셀 크기로 `term_resize`가 나간다. 창을 닫고 메인이 이어받을 때(`reattachAllTerminals`) 출력
 * 채널은 되돌아오지만 **크기는 그대로 작게 남는다** — 메인 창의 xterm은 처음부터 큰 상태였으니
 * `fit()`이 아무것도 바꾸지 않아 `onResize`가 발화하지 않기 때문이다.
 *
 * 결과는 실사용에서 이렇게 보인다: 넓은 터미널인데 글자가 왼쪽 절반에만 그려지고 오른쪽이
 * 통째로 비어 있다(2026-08-28 실사례 — 1718px 창에 내용이 810px, 딱 모아보기 2열 셀 폭).
 * TUI(claude 등)는 PTY가 알려준 폭에 맞춰 그리므로 화면이 깨진 것처럼 보인다.
 */
export function resyncTerminalSizeImpl(id: string): void {
  const inst = registry.get(id);
  if (!inst || inst.status !== "live") return;
  ptyResize(id, inst.term.cols, inst.term.rows);
}

function ptyWrite(termId: string, data: string) {
  // 프롬프트 기록 — 키 입력·IME 확정·붙여넣기가 전부 이 함수를 지나므로 여기 한 곳에서만 캡처한다
  // (자동응답 걸러내기는 prompt-capture가 담당). 이 줄이 던지면 아래 term_write가 통째로
  // 건너뛰어져 그 키가 PTY로 안 나가므로, capturePtyInput 안에서 전부 삼킨다.
  capturePtyInput(termId, data);
  const inflight = writeChains.get(termId);
  // 나가 있는 전송이 없으면 즉시 보낸다 — 조용할 때 지연 증가는 0이다.
  if (!inflight) {
    sendWrite(termId, data);
    return;
  }
  const pending = (pendingWrites.get(termId) ?? "") + data;
  if (pending.length > PENDING_MAX) {
    pendingWrites.delete(termId);
    sendWrite(termId, pending, inflight);
    return;
  }
  pendingWrites.set(termId, pending);
}

// Shift/Alt+Enter를 win32-input-mode로 보낼 때 실을 수식 상태(ControlKeyState).
// **Shift+Enter도 이 값(LEFT_ALT_PRESSED)** 이다 — 정직하게 SHIFT(0x10)를 실으면 ConPTY→libuv
// 번역이 그냥 `\r`이 돼(libuv는 Enter의 Shift를 구분하지 않는다) Claude Code가 "제출"로 본다.
// 대가는 pwsh PSReadLine의 Shift+Enter=AddLine 상실인데, 지금도 Shift+Enter는 Enter와 같아
// AddLine이 된 적이 없다(회귀 아님). 되돌릴 자리는 이 상수 하나다
// (DOCS/task/32-terminal-enter-modifiers.md §3.1).
const ENTER_MOD_CS = 0x02;

/** win32-input-mode 키 레코드 한 쌍(down+up) — `ESC [ Vk;Sc;Uc;Kd;Cs;Rc _`.
 *  ConPTY가 이걸 받아 수식 상태가 살아 있는 INPUT_RECORD를 만들고, 클라이언트(libuv)가
 *  ALT+Enter를 `\x1b\r`로 번역한다. ESC+CR을 그냥 쓰면 ConPTY의 VT 파서가 ESC 키와 Enter 키
 *  **두 레코드**로 쪼개 취소+제출이 된다(같은 문서 §2). */
function win32Key(vk: number, sc: number, uc: number, cs: number): string {
  return `\x1b[${vk};${sc};${uc};1;${cs};1_\x1b[${vk};${sc};${uc};0;${cs};1_`;
}

// Linux 웹뷰(WebKitGTK)는 인쇄 가능한 키를 입력기(IME) textarea 경로로 흘려보내는데,
// 이 버퍼가 비워지지 않아 키마다 직전까지의 내용이 통째로 다시 전송된다(중복 누적,
// Backspace 무력화). Windows(WebView2)/macOS는 정상. 이 플랫폼에서만 우회한다.
const isWebKitGtk = /Linux/.test(navigator.userAgent);
// macOS WKWebView도 WebKit 계열이라 IME(한글 등) 조합 중 keydown으로 raw 자모가 PTY로
// 흘러나가 조합이 깨진다("이거"→"ㅇ거"). compositionend로만 확정 문자열을 송출하도록 가로챈다.
const isMacWebKit = /Mac/i.test(navigator.userAgent);

// macOS 한글 IME 입력 미러링용 순수 헬퍼 (원인·설계: DOCS/TROUBLESHOOTING.md §3).
// prev(미러) → next(목표 ta.value)로 가는 최소 PTY 델타: "코드포인트" 공통 접두 이후, prev의
// 남은 코드포인트 수만큼 \x7f(DEL) + next의 남은 접미. NFC 한글 1음절 = 1 코드포인트 = 셸
// readline의 1삭제 단위라 Array.from이 곧 음절 단위 카운트가 된다. (기존 "\x7f"+data 는 "직전
// 1자만 삭제"를 가정 → IME가 자모를 새 음절로 옮기는 빠른 타이핑에서 이미 확정된 앞 음절을
// 지웠다: 어떡하냐 → 어떡냐. 상세: DOCS/TROUBLESHOOTING.md §3)
function imeLineDelta(prev: string, next: string): string {
  const a = Array.from(prev);
  const b = Array.from(next);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return "\x7f".repeat(a.length - p) + b.slice(p).join("");
}

// data가 전부 ASCII면 xterm 기본 input 경로(검증된 영문/숫자/기호/space 처리)에 그대로 맡긴다.
function isAsciiStr(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
  return true;
}

function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  const fg = v("--color-fg", "#dfe1e5");
  const base: ITheme = {
    background: v("--color-base", "#1e1f22"),
    foreground: fg,
    cursor: fg,
    cursorAccent: v("--color-base", "#1e1f22"),
    selectionBackground: v("--color-raised", "#393b40"),
    brightBlack: v("--color-fg-dim", "#6f737a"),
    blue: v("--color-mod", "#56a8f5"),
    green: v("--color-add", "#62b543"),
    cyan: v("--color-accent", "#3574f0"),
  };
  // CSS 파생만으론 부족한 테마별 보정(라이트 ANSI 16색 등)을 레지스트리에서 병합.
  // 겹치는 키는 보정이 이긴다 — 다크 테마는 보정이 없어 기존 파생 그대로.
  const fix = themeOf(document.documentElement.dataset.theme).xterm;
  return fix ? { ...base, ...fix } : base;
}

/** 이 세션의 최종 xterm 테마 — 세션별 스킴 오버라이드가 있으면 그것, 없으면 앱 테마 파생.
 *  cssTheme(앱 테마)는 호출자가 한 번 계산해 넘긴다(readTheme는 getComputedStyle이라 비싸다). */
function themeFor(termId: string, cssTheme: ITheme): ITheme {
  const scheme = termSchemeOf(useTermThemes.getState().byTerminal[termId]);
  return scheme ? { ...scheme.theme } : { ...cssTheme };
}

/** 열린 모든 터미널에 테마 재적용 — 앱 테마 전환·세션 스킴 변경 시 코어가 호출한다.
 *  세션별 스킴이 선택된 터미널은 앱 테마 전환에도 자기 스킴을 유지한다(오버라이드 우선).
 *  xterm 6은 options.theme 참조 비교로 리렌더를 판단하므로 "새 객체" 대입이 필수. */
export function refreshTerminalThemesImpl(): void {
  const cssTheme = readTheme();
  for (const inst of registry.values()) {
    // 인스턴스 간 객체 공유는 무해(xterm이 내부 복사) — 참조만 새 것이면 된다.
    inst.term.options.theme = themeFor(inst.id, cssTheme);
  }
}

/** xterm 인스턴스를 만들고 PTY를 띄운다. 이미 있으면 기존 것을 반환(멱등).
 *  attach=true면 새 PTY를 spawn하지 않고 살아있는 세션에 출력만 재연결(term_attach) —
 *  플로팅(별도 OS 창)에서 메인 창이 만든 세션을 이어받을 때 쓴다. */
export function createTerminalImpl(opts: {
  id: string;
  projectId: string;
  fontSize: number;
  attach?: boolean;
}): TermInstance {
  ensureExitListener();
  const existing = registry.get(opts.id);
  if (existing) return existing;

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";

  const term = new Terminal({
    fontSize: opts.fontSize,
    // 한글은 반드시 "고정폭" CJK 폰트로 렌더해야 칸(2셀)에 맞아 커서가 안 어긋난다.
    // generic monospace 폴백은 한글을 프로포셔널 폰트(Noto Sans CJK)로 대체해 깨져 보인다.
    // → 고정폭 한글(Noto Sans Mono CJK KR / D2Coding)을 명시적으로 끼워넣는다.
    fontFamily:
      '"Cascadia Code", Consolas, "D2Coding", "Noto Sans Mono CJK KR", "Nanum Gothic Coding", monospace',
    cursorBlink: true,
    scrollback: 5000,
    // Unicode11Addon(아래 :223)이 `term.unicode`를 건드리는데 그게 proposed API다 — 이 플래그가
    // 없으면 `loadAddon`이 "You must set the allowProposedApi option to true"로 **던지고**,
    // createTerminalImpl이 통째로 중단돼 **터미널이 하나도 안 뜬다**(0036d06 이후 실측).
    allowProposedApi: true,
    // Windows 백엔드는 ConPTY(portable_pty native) — xterm에 이를 알려 ConPTY 전용 워크어라운드를
    // 켠다: ① 행 증가 시 스크롤백을 뷰포트로 끌어오지 않고 빈 행 처리(ConPTY 실제 동작) ② 리플로우
    // 비활성 + "마지막 문자가 공백 아니면 wrap" 휴리스틱. 이걸 안 켜면 리사이즈 시 ConPTY 재방출과
    // xterm 기본 리플로우가 충돌해 TUI(Claude Code 등) 출력이 우측에 유령 텍스트로 깨진다.
    ...(isWindows ? { windowsPty: { backend: "conpty" as const } } : {}),
    // 세션별 스킴이 있으면 그것으로 시작 — 재시작·창 이동(attach) 후에도 같은 색을 복원한다.
    theme: themeFor(opts.id, readTheme()),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  // xterm 코어에는 Unicode v6 폭 표만 들어있어 astral emoji(U+1F300~U+1FAFF)를 **1칸**으로 센다.
  // Claude Code 같은 TUI는 Unicode 9+ 기준(2칸)으로 폭을 재고 그 폭에 맞춰 잘라 보내므로,
  // 그대로 두면 한 줄에 emoji 개수만큼 열이 어긋나고 WebGL 렌더러가 emoji에 대해서는
  // rescaling을 건너뛰기 때문에(allowRescaling의 !isEmoji 가드) 글자 위로 번진다.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  // 인스턴스는 여기서 만든다(레지스트리 등록은 아래 open 직전) — 아래 CSI/키 핸들러가
  // `win32Input`을 읽고 쓰려면 클로저에 인스턴스가 이미 있어야 한다.
  const inst: TermInstance = {
    id: opts.id,
    projectId: opts.projectId,
    term,
    fit,
    host,
    status: "live",
    win32Input: false,
  };

  // win32-input-mode(DECSET 9001) 감지 — ConPTY가 시작 시 `\x1b[?9001h`를 보낸다(portable-pty가
  // PSEUDOCONSOLE_WIN32_INPUT_MODE로 무조건 연다). xterm 6은 이 모드를 조용히 무시하므로
  // 여기서만 관측한다. `return false`로 기본 경로도 계속 타게 둔다(무시라서 무해).
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(9001)) inst.win32Input = true;
    return false;
  });
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(9001)) inst.win32Input = false;
    return false;
  });

  // 마우스 프로토콜을 켠 TUI(Claude Code 등) 위에서는 휠이 PTY로 전달되고 뷰포트 스크롤이
  // 꺼진다 — Shift+휠을 뷰포트 스크롤 탈출구로 남긴다(Windows Terminal·VS Code와 동일).
  // 대체화면(alt 버퍼)은 스크롤백이 없으므로 기본 동작(↑/↓ 변환)에 맡긴다.
  term.attachCustomWheelEventHandler((ev) => {
    if (
      ev.shiftKey &&
      term.modes.mouseTrackingMode !== "none" &&
      term.buffer.active.type === "normal"
    ) {
      term.scrollLines(Math.sign(ev.deltaY) * 3);
      return false;
    }
    return true;
  });

  // macOS WKWebView 한글 IME 미러 상태(인스턴스별). imeSent = 지금 셸 입력 라인에서 "이번 한글
  // 조합 런"이 반영해 둔 꼬리 문자열(마지막으로 diff한 ta.value). ASCII/Enter/방향키 등 조합 런
  // 밖의 입력에서 리셋되어 다음 조합이 실제 라인 끝에서 새로 시작한다. keydown 핸들러가 아래에서
  // resetImeMirror를 참조하므로 attachCustomKeyEventHandler 앞에 선언한다. macOS에서만 실사용.
  let imeSent = "";
  const resetImeMirror = () => {
    imeSent = "";
    // macOS에서만 호출된다 — Linux ta.value를 지우면 WebKitGTK composition 경로가 깨진다.
    if (term.textarea) term.textarea.value = "";
  };

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();

    // Tab/Shift+Tab은 물리 키(e.code)로 IME 가드보다 "먼저" 잡는다. WebKitGTK가 Shift+Tab의
    // e.key를 "Unidentified"로 보고하면 아래 IME 가드에 걸려 핸들러가 우회되고 웹뷰 포커스가
    // 다른 요소로 튄다. e.code는 IME 무관 물리 키라 항상 "Tab". preventDefault로 포커스 이동을
    // 막고 Tab→\t / Shift+Tab→\x1b[Z 를 PTY로 보낸다(xterm은 Shift+Tab에 cancel을 안 거는 버그).
    if (e.code === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (isMacWebKit) resetImeMirror(); // 탭 완성/백탭이 라인을 다시 쓰므로 IME 미러 리셋
      ptyWrite(opts.id, e.shiftKey ? "\x1b[Z" : "\t");
      return false;
    }

    // IME 조합 중 keydown은 PTY로 흘리지 않는다 — 한글 첫 자모(ㅇ 등)만 raw로 송출되면
    // 조합이 깨진다. composition 종료 시 아래 compositionend 핸들러가 확정 문자열을 보낸다.
    // - keyCode 229: Chromium/WebKit이 IME 조합 중 keydown에 부여
    // - "Process"/"Unidentified": Safari/WKWebView가 일부 케이스에서 부여
    // - isComposing: compositionstart 이후의 keydown
    if (
      e.isComposing ||
      e.keyCode === 229 ||
      e.key === "Process" ||
      e.key === "Unidentified"
    ) {
      return false;
    }
    // Shift+Enter / Alt+Enter = 줄바꿈(Claude Code 등 TUI). xterm 기본은 Shift를 무시해 그냥
    // `\r`(=제출)을 보내고, Alt는 `\x1b\r`을 보내지만 Windows ConPTY가 그 ESC+CR을 ESC 키와
    // Enter 키 두 레코드로 쪼개 역시 줄바꿈이 안 된다. 그래서 ConPTY(9001 수신)에서는
    // win32-input-mode 레코드로, 그 외에는 VS Code·iTerm2와 같은 `\x1b\r`로 보낸다.
    if (
      e.key === "Enter" &&
      (e.shiftKey || e.altKey) &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      if (isMacWebKit) resetImeMirror(); // 줄이 바뀌므로 IME 미러 리셋(Tab 분기와 동일)
      ptyWrite(
        opts.id,
        isWindows && inst.win32Input
          ? win32Key(13, 28, 13, ENTER_MOD_CS) // VK_RETURN, 스캔코드 28, U+000D
          : "\x1b\r",
      );
      return false;
    }

    // macOS WKWebView 안전망: IME가 첫 keydown의 keyCode를 정상 키로 보내고 e.key에 자모를
    // 그대로 끼워주는 케이스 — 단일 비-ASCII 인쇄 문자(한글 자모/CJK 등)는 xterm으로 보내지
    // 말고 textarea(=composition 경로)에 맡긴다.
    if (
      isMacWebKit &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      e.key.length === 1 &&
      e.key.charCodeAt(0) > 0x7f
    ) {
      return false;
    }

    // macOS IME(§3): 여기 도달한 keydown은 조합키(kc229/Process/Unidentified, 위에서 return)도
    // 단일 비-ASCII IME 라우팅(바로 위 return)도 아니다. 그중 "조합 런 밖에서 라인을 바꾸거나
    // 소비/커서이동하는 키"에서만 미러를 리셋한다. 맨수식키(Shift/Ctrl/Alt/Meta 단독)와 평범한
    // 인쇄 ASCII는 제외 — 후자는 input(insertText) 경로에서 리셋되고, 전자를 리셋하면 Shift+ㄱ(ㄲ)
    // 조합 도중 미러가 지워진다.
    if (isMacWebKit) {
      const rk =
        e.key === "Enter" ||
        e.key === "Backspace" ||
        e.key === "Delete" ||
        e.key === "Escape" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key.startsWith("Arrow") ||
        ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1);
      if (rk) resetImeMirror();
    }

    // 앱 단축키(터미널 토글 Ctrl+`, 분할 Ctrl+Shift+D/E, 닫기 Ctrl+Shift+W)는
    // PTY로 보내지 않고 window 핸들러로 흘려보낸다.
    if (e.ctrlKey && e.key === "`") return false;
    if (e.ctrlKey && e.shiftKey && ["d", "e", "w"].includes(k)) return false;
    // 프로젝트 위/아래 이동(Ctrl+Shift+↑/↓)도 PTY로 보내지 않고 window 핸들러로 흘려보낸다.
    if (e.ctrlKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
      return false;
    // 모아보기 토글(mod+Shift+A) — 모아보기 그리드는 전부 터미널이라 이 통과가 닫기 경로에 필수.
    if (isMod(e) && e.shiftKey && k === "a") return false;
    // Go to Symbol(mod+Alt+N) — 터미널 포커스 중에도 window 핸들러로 흘려보낸다.
    if (isMod(e) && e.altKey && k === "n") return false;
    // Find in Files(mod+Shift+F) — 터미널 포커스 중에도 window로 버블.
    if (isMod(e) && e.shiftKey && k === "f") return false;
    // Ctrl+W: 포커스된(=이 키를 받은) 이 터미널 패널을 닫는다(Shift 없이 — Ctrl+Shift+W는
    // 기존대로 활성 패널 닫기). dispose를 키 이벤트 도중 하지 않도록 마이크로태스크로 미뤄,
    // 처리 중인 xterm을 그 자리에서 파괴하는 걸 피한다.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && k === "w") {
      e.preventDefault();
      const id = opts.id;
      queueMicrotask(() => {
        const ts = useTerminals.getState();
        const tab = ts.terminals.find((t) => collectPanes(t.layout).includes(id));
        if (tab) ts.closePane(tab.id, id);
      });
      return false;
    }

    // 복사: Ctrl+Shift+C, 또는 선택영역이 있을 때 Ctrl+C (없으면 통과 → SIGINT)
    // 성공 시에만 선택을 해제한다 — 실패 시 선택을 유지하고 토스트로 알린다(무음+선택 해제면
    // 사용자는 복사가 된 줄 알고, SIGINT도 안 나가서 "복사가 안 된다"로만 체감된다).
    if (e.ctrlKey && k === "c" && (e.shiftKey || term.hasSelection())) {
      const sel = term.getSelection();
      if (sel)
        void copyText(sel).then((ok) =>
          ok
            ? term.clearSelection()
            : useUi.getState().pushToast("error", "복사에 실패했습니다"),
        );
      e.preventDefault();
      return false;
    }
    // 붙여넣기: Ctrl+V / Ctrl+Shift+V — 스마트(파일·이미지→경로) 붙여넣기로 대체.
    // term_paste는 세 플랫폼 모두 실구현이다(win: clipboard-win, unix: arboard —
    // DOCS/TROUBLESHOOTING.md §6).
    if (e.ctrlKey && k === "v") {
      e.preventDefault();
      void pasteIntoTerminal(opts.id);
      return false;
    }
    // macOS Cmd+C/Cmd+V: WKWebView 네이티브 copy/paste 커맨드의 클립보드 "쓰기"가 비-ASCII
    // (한글)를 UTF-8→MacRoman 이중인코딩으로 깨뜨린다(§7) — 가로채서 네이티브 플러그인
    // 경로(clipboard.ts)로 보낸다. Cmd+V도 잡는 이유: 읽기까지 네이티브로 통일 + 스마트
    // 붙여넣기(이미지→PNG 경로)가 macOS에서도 동작하게. Cmd+C는 선택 있을 때만(없으면 통과 —
    // 터미널에선 무해). preventDefault가 웹뷰 기본 커맨드(=깨지는 경로) 실행을 차단한다.
    if (isMacWebKit && e.metaKey && !e.ctrlKey && !e.altKey) {
      if (k === "c" && term.hasSelection()) {
        const sel = term.getSelection();
        if (sel)
          void copyText(sel).then((ok) =>
            ok
              ? term.clearSelection()
              : useUi.getState().pushToast("error", "복사에 실패했습니다"),
          );
        e.preventDefault();
        return false;
      }
      if (k === "v") {
        e.preventDefault();
        void pasteIntoTerminal(opts.id);
        return false;
      }
    }

    // WebKitGTK IME 누적 버그 우회(영문/비조합): 조합 중이 아닌 단일 인쇄 문자는 깨진
    // textarea 경로를 거치지 않고 PTY로 직접 보낸다. preventDefault로 textarea 입력 자체를
    // 막아 누적을 차단한다. Enter·Backspace·방향키 등(key.length>1)은 xterm 기본 경로로,
    // 조합 키(한글 등, isComposing)는 아래 compositionend 핸들러가 처리한다.
    if (
      isWebKitGtk &&
      !e.isComposing &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      e.key.length === 1
    ) {
      e.preventDefault();
      ptyWrite(opts.id, e.key);
      return false;
    }
    return true;
  });
  term.open(host); // 분리된 host에 먼저 연다 — 실제 fit은 attach 시점에 (DOM 렌더러는 0크기 허용)

  // GPU 가속 렌더러(WebGL) — 대량 출력에서 DOM 렌더러 대비 CPU·잔상을 줄인다(VS Code 내장
  // 터미널과 동일 엔진). 단 WebKitGTK(Linux)에서는 GPU/드라이버 조합(특히 NVIDIA 프로프라이어터리
  // 드라이버·소프트웨어 GL)에 따라 WebGL 컨텍스트가 웹뷰 렌더러 프로세스를 크래시시켜 화면 전체가
  // 까맣게 먹통된다(분할로 터미널을 여럿 띄우면 더 잘 터짐 — 컨텍스트 다수). 그래서 WebGL이
  // 안정적인 WebView2(Windows)/WKWebView(macOS)에서만 켜고, WebKitGTK에서는 안정적인 기본 DOM
  // 렌더러를 쓴다. loadAddon은 반드시 open() 이후라야 한다.
  // 컨텍스트 손실 복구: 장시간 방치·절전 복귀·GPU 드라이버 리셋 시 WebView2가 WebGL 컨텍스트를
  // 회수하면 글리프 아틀라스 잔해(색 블록·흩어진 글자)만 화면에 남는다. dispose만 하고 끝내면
  // 복구가 없으므로 애드온을 재생성해 새 컨텍스트로 살리고, 60초 내 반복 손실이면(살아있는
  // 터미널 누적으로 Chromium 컨텍스트 상한 ~16개 초과 → 서로 밀어내는 캐스케이드) DOM 렌더러로
  // 확정한다 — VS Code 내장 터미널과 동일 전략.
  if (!isWebKitGtk) {
    let lostAt: number[] = [];
    const loadWebgl = () => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          const now = Date.now();
          lostAt = [...lostAt.filter((t) => now - t < 60_000), now];
          if (lostAt.length <= 3) setTimeout(loadWebgl, 300);
          else term.refresh(0, term.rows - 1); // DOM 렌더러로 잔상 지우기
        });
        term.loadAddon(webgl);
        term.refresh(0, term.rows - 1);
      } catch {
        /* WebGL 불가 — xterm 기본 DOM 렌더러로 동작 */
      }
    };
    loadWebgl();
  }

  // WebKit 계열(Linux WebKitGTK / macOS WKWebView) 한글(IME 조합) 입력 우회.
  // 두 플랫폼이 같은 WebKit이지만 IME 이벤트 모델이 다르다(진단: DOCS/TROUBLESHOOTING.md §3).
  //  - Linux WebKitGTK: 표준 composition* 발화 → compositionend 확정 문자열만 송출(기존 방식 유지).
  //  - macOS WKWebView: 한글 IME가 composition* 을 발화하지 않고 textarea input 이벤트
  //    (insertText=새 음절 / insertReplacementText=현재 음절 갱신)로만 상태를 흘린다. 이벤트별
  //    "\x7f"+data(직전 1자 삭제 가정)는 빠른 타이핑에서 이미 확정된 앞 음절을 지운다(어떡하냐→
  //    어떡냐). 근본 해결: 캡처 단계에서 읽는 ta.value(=누적된 전체 조합 라인)를 미러(imeSent)와
  //    grapheme-diff 하여 "정확한 백스페이스 수 + 추가분"만 보낸다. 음절 경계를 추측하지 않으므로
  //    IME 재분할에도 정확. ASCII는 xterm 기본 경로에 그대로 맡겨(영문 회귀 위험 최소화) 미러만 리셋.
  if ((isWebKitGtk || isMacWebKit) && term.textarea) {
    const ta = term.textarea;
    // Linux WebKitGTK: composition* 이벤트로 조합이 들어온다 — 기본 처리를 가로채고 확정
    // 문자(compositionend.data)만 PTY로 보낸다. macOS는 이 이벤트를 발화하지 않으므로 no-op.
    ta.addEventListener("compositionstart", (e) => e.stopImmediatePropagation(), true);
    ta.addEventListener("compositionupdate", (e) => e.stopImmediatePropagation(), true);
    ta.addEventListener(
      "compositionend",
      (e) => {
        e.stopImmediatePropagation();
        const data = (e as CompositionEvent).data;
        if (data) ptyWrite(opts.id, data);
        ta.value = "";
      },
      true,
    );
    // Linux WebKitGTK: 조합 input은 위 compositionend가 확정 처리 → 여기서 차단(누적 방지).
    // (macOS 처리는 아래 host 캡처 리스너 — 이 textarea 리스너는 xterm 것보다 늦게 등록돼
    //  같은 타깃에서 등록 순서상 xterm 뒤에 실행되므로, macOS 가로채기에 쓰면 xterm의 자체
    //  insertText 전송을 못 막아 한글이 이중 전송된다: ㅇ→"ㅇㅇ", 이어 \x7f야→"ㅇ야".)
    ta.addEventListener(
      "input",
      (e) => {
        const ie = e as InputEvent;
        if (ie.isComposing || ie.inputType === "insertCompositionText") {
          e.stopImmediatePropagation();
          ta.value = "";
        }
      },
      true,
    );

    // ── macOS WKWebView 한글 IME (compositionstart/update/end 미발화) ──
    // 반드시 host(조상) "캡처" 리스너로 가로챈다: 조상의 캡처 리스너는 타깃(textarea)의 어떤
    // 리스너보다도 항상 먼저 실행됨이 스펙으로 보장된다(등록 순서 무관). 여기서 stopPropagation
    // 하면 xterm의 textarea input 핸들러가 아예 호출되지 않아, xterm 가드
    // (!e.composed||!_keyDownSeen)를 통과하는 한글 insertText의 자체 전송(이중 전송 원인)을
    // 원천 차단한다.
    if (isMacWebKit) {
      host.addEventListener(
        "input",
        (e) => {
          const ie = e as InputEvent;
          if (ie.target !== term.textarea) return;
          // 진짜 composition 이벤트를 쓰는 IME(일본어 등) 안전망 — 한글은 여기 안 옴(§3).
          if (ie.isComposing || ie.inputType === "insertCompositionText") {
            e.stopPropagation();
            if (term.textarea) term.textarea.value = "";
            imeSent = "";
            return;
          }
          // ASCII(영문·숫자·기호·space)는 stop하지 않아 xterm 기본 경로가 ev.data를 보낸다.
          // 단 xterm 6은 일반 ASCII insertText에서 textarea를 비우지 않으므로(blur/Enter/Ctrl-C만)
          // resetImeMirror로 ta.value+imeSent를 함께 비워 diff 기준선을 맞춘다 — 안 하면 다음
          // 한글이 직전 런을 통째로 재전송한다("이거 실행"→"이거 이거 실행"). xterm _inputEvent는
          // ev.data를 읽으므로 ta.value를 비워도 이 ASCII 문자는 정상 전달된다.
          if (ie.inputType === "insertText" && ie.data && isAsciiStr(ie.data)) {
            resetImeMirror();
            return;
          }
          // 한글(비-ASCII) 새 음절(insertText) 또는 현재 음절 갱신(insertReplacementText):
          // stopPropagation으로 xterm 도달을 차단(이중 전송·textarea 클리어 방지) → ta.value가
          // 조합 런 전체를 누적 → 미러와 diff해 정확한 델타만 PTY로 보낸다(data가 null/""인
          // decommit이어도 ta.value로 판단하므로 안전).
          if (
            ie.inputType === "insertText" ||
            ie.inputType === "insertReplacementText"
          ) {
            e.stopPropagation();
            const next = (ie.target as HTMLTextAreaElement).value;
            const delta = imeLineDelta(imeSent, next);
            imeSent = next;
            if (delta) ptyWrite(opts.id, delta);
          }
        },
        true,
      );
      // 포커스 상실 시 조합 문맥이 사라지므로 미러 리셋(다음 포커스+입력이 깨끗이 시작).
      ta.addEventListener("blur", () => resetImeMirror(), true);

      // Cmd+C/V 키다운 가로채기의 보조 안전망 — 메뉴(Edit→복사/붙여넣기) 등 키다운을 거치지
      // 않는 경로도 copy/paste "이벤트"는 발화한다. 조상(host) 캡처는 타깃(xterm textarea)의
      // 리스너·웹뷰 기본 동작보다 먼저 개입이 보장되므로, 여기서 깨지는 WebKit 클립보드 경로를
      // 차단하고 네이티브 플러그인 경로로 대체한다.
      host.addEventListener(
        "copy",
        (e) => {
          const sel = term.getSelection();
          if (!sel) return; // 선택 없으면 기본 동작(사실상 no-op)에 맡긴다
          e.preventDefault();
          e.stopPropagation();
          void copyText(sel);
        },
        true,
      );
      host.addEventListener(
        "paste",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          void pasteIntoTerminal(opts.id);
        },
        true,
      );
    }
  }

  registry.set(opts.id, inst);

  // 출력: Channel(raw bytes) → xterm. 멀티바이트 경계 안전을 위해 바이트 그대로 write.
  // 채널 생성은 코어의 attachOutputChannel 한 곳에서만 한다 — 재연결도 같은 함수를 쓴다.
  // **채널 재사용 금지**의 이유가 그 함수 주석에 있다(재사용하면 출력이 영구히 멎는다).
  const channel = attachOutputChannel(inst);

  // attach=새 창이 살아있는 PTY 출력만 이어받음(term_attach), 아니면 새 PTY spawn(term_open).
  const startCmd = opts.attach
    ? invoke("term_attach", { termId: opts.id, onData: channel })
    : invoke("term_open", {
        termId: opts.id,
        projectId: opts.projectId,
        cols: term.cols || 80,
        rows: term.rows || 24,
        onData: channel,
      });
  void startCmd.catch((e: unknown) => {
    inst.status = "exited";
    // errorMessage는 IpcError({code,message,...})까지 푼다 — String(e)로는 "[object Object]"가
    // 찍혀 원인이 통째로 가려진다(실제로 겪음: term_attach의 "세션을 찾을 수 없습니다"가 묻혔다).
    term.writeln(`\r\n\x1b[31m[터미널 연결 실패] ${errorMessage(e)}\x1b[0m`);
  });

  // 입력·리사이즈는 **open 완료 뒤부터** 보낸다. term_open은 셸 spawn이 끝나야 세션을
  // 등록하는데(Windows ConPTY+PowerShell은 수백 ms), xterm은 분리된 host에서 80x24로 시작하고
  // fit은 attach 후 다음 프레임에 돌아서 첫 term_resize가 거의 항상 이긴다 — 세션이 없어
  // "세션을 찾을 수 없습니다"로 조용히 버려지고 재시도가 없어 **PTY가 80x24로 박제**됐다.
  // 셸 프롬프트는 멀쩡해 보여 못 알아채다가, TUI(claude 등)를 띄우는 순간 화면 좌상단
  // 80x24 영역에 UI가 통째로 구겨져 그려진다(실사례). 실패(스폰 불가)는 무해 no-op으로 흘린다.
  const opened = startCmd.then(
    () => {},
    () => {},
  );
  // 첫 키 입력도 같은 레이스가 가능하므로 쓰기 체인을 open으로 시드한다. open이 끝나면 그동안
  // 모인 입력을 한 번에 내보낸다(없으면 항목을 지운다 — ptyWrite의 정리 규칙과 동일).
  writeChains.set(opts.id, opened);
  void opened.then(() => {
    if (writeChains.get(opts.id) === opened) flushPending(opts.id);
  });

  // 예약된 초기 입력("Claude Code 세션으로 새 터미널" — lib/terminal.ts queueInitialInput)을
  // 이 창이 소비한다. attach는 남의 세션을 이어받는 것뿐이라 소비하지 않는다 — open한 창이 보낸다.
  const initial = opts.attach ? null : takeInitialInput(opts.id);
  if (initial) {
    // **셸이 프롬프트를 찍은 뒤에** 보낸다. 프롬프트 전에 쓰면 셸 초기화가 삼킬 수 있다
    // (pwsh PSReadLine). 단 `onWriteParsed` 첫 발화 = 셸 출력이 아니다 — Windows ConPTY는
    // spawn 직후 `\x1b[?9001h`를 무조건 보낸다(:238-243). 그 발화에 보내면 우리가 피하려던
    // 극초기 구간 그대로다. 그래서 **화면에 글자가 생겼는지**로 판정한다.
    let off: { dispose: () => void } | null = null;
    let timer = 0;
    const send = () => {
      off?.dispose();
      off = null;
      clearTimeout(timer);
      // 실패한 open에는 보내지 않는다 — 세션이 없어 쓰기는 버려지고 프롬프트 기록에 유령
      // 항목만 남는다(실패 배너 writeln 자체가 파싱을 유발해 여기까지 온다).
      void startCmd.then(
        () => ptyWrite(opts.id, initial),
        () => {},
      );
    };
    const hasGlyph = () => {
      const b = term.buffer.active;
      const end = b.baseY + term.rows;
      for (let i = 0; i <= end; i++) {
        if (b.getLine(i)?.translateToString(true).trim()) return true;
      }
      return false;
    };
    off = term.onWriteParsed(() => {
      if (hasGlyph()) send();
    });
    // 끝내 아무 글자도 안 찍는 셸(조용한 초기화)에서도 명령을 잃지 않게 상한을 둔다.
    timer = window.setTimeout(send, 3000);
  }

  // 입력 → PTY stdin
  // 주의: 여기서 IME 미러를 리셋하면 안 된다 — onData에는 키 입력만 아니라 xterm의 "자동응답"
  // (커서위치 \x1b[?..R, DA, 포커스 \x1b[I/O, 마우스 리포트)이 상시 흐른다(TUI/프롬프트가 초당
  // 수십 회 질의). 제어바이트 매칭으로 리셋하면 한글 조합 도중 미러+textarea가 계속 지워져
  // 입력이 깨진다(자모 파편·중복). 리셋은 keydown 목록/ASCII input/blur가 담당한다.
  term.onData((data) => ptyWrite(opts.id, data));
  // 리사이즈 → ConPTY. 체인을 open으로 시드해 **term_open 완료 뒤부터** 나가게 한다(위 주석의
  // "PTY가 80x24로 박제" 레이스). 순서 보장·정리 규칙은 ptyResize가 맡는다.
  resizeChains.set(opts.id, opened);
  void opened.then(() => {
    if (resizeChains.get(opts.id) === opened) resizeChains.delete(opts.id);
  });
  term.onResize(({ cols, rows }) => ptyResize(opts.id, cols, rows));

  return inst;
}
