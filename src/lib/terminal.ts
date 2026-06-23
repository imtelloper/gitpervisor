import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

// PTY 세션은 Rust가 수명의 단일 진실 — xterm 인스턴스/스크롤백은 dispose 전까지 살려둔다.
// 탭/프로젝트 전환은 host(div)를 컨테이너에 붙였다 떼는 것뿐 (설계 §16.5).
export interface TermInstance {
  id: string;
  projectId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  status: "live" | "exited";
}

const registry = new Map<string, TermInstance>();

// Linux 웹뷰(WebKitGTK)는 인쇄 가능한 키를 입력기(IME) textarea 경로로 흘려보내는데,
// 이 버퍼가 비워지지 않아 키마다 직전까지의 내용이 통째로 다시 전송된다(중복 누적,
// Backspace 무력화). Windows(WebView2)/macOS는 정상. 이 플랫폼에서만 우회한다.
const isWebKitGtk = /Linux/.test(navigator.userAgent);
// macOS WKWebView도 WebKit 계열이라 IME(한글 등) 조합 중 keydown으로 raw 자모가 PTY로
// 흘러나가 조합이 깨진다("이거"→"ㅇ거"). compositionend로만 확정 문자열을 송출하도록 가로챈다.
const isMacWebKit = /Mac/i.test(navigator.userAgent);

type ExitListener = (id: string, code: number) => void;
const exitListeners = new Set<ExitListener>();

// term://exit 전역 구독은 1회만 등록한다.
let exitListenerReady = false;
function ensureExitListener() {
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

function readTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  const fg = v("--color-fg", "#dfe1e5");
  return {
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
}

/** xterm 인스턴스를 만들고 PTY를 띄운다. 이미 있으면 기존 것을 반환(멱등). */
export function createTerminal(opts: {
  id: string;
  projectId: string;
  fontSize: number;
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
    theme: readTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();

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

    // 앱 단축키(터미널 토글 Ctrl+`, 분할 Ctrl+Shift+D/E, 닫기 Ctrl+Shift+W)는
    // PTY로 보내지 않고 window 핸들러로 흘려보낸다.
    if (e.ctrlKey && e.key === "`") return false;
    if (e.ctrlKey && e.shiftKey && ["d", "e", "w"].includes(k)) return false;

    // 복사: Ctrl+Shift+C, 또는 선택영역이 있을 때 Ctrl+C (없으면 통과 → SIGINT)
    if (e.ctrlKey && k === "c" && (e.shiftKey || term.hasSelection())) {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    // 붙여넣기: Ctrl+V / Ctrl+Shift+V — 스마트(파일·이미지→경로) 붙여넣기로 대체
    if (e.ctrlKey && k === "v") {
      e.preventDefault();
      void pasteIntoTerminal(opts.id);
      return false;
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
      void invoke("term_write", { termId: opts.id, data: e.key }).catch(() => {});
      return false;
    }
    return true;
  });
  term.open(host); // 분리된 host에 먼저 연다 — 실제 fit은 attach 시점에 (DOM 렌더러는 0크기 허용)

  // WebKit 계열(Linux WebKitGTK / macOS WKWebView) 한글(IME 조합) 입력 우회.
  // 두 플랫폼이 같은 WebKit이지만 IME 이벤트 모델이 다르다 — 둘 다 케이스별로 처리한다.
  // (자세한 진단/원인은 DOCS/TROUBLESHOOTING.md §3 참고)
  if ((isWebKitGtk || isMacWebKit) && term.textarea) {
    const ta = term.textarea;
    // Linux WebKitGTK: composition* 이벤트로 들어옴 — xterm 기본 처리를 가로채고
    // 확정 문자(compositionend.data)만 PTY로 보낸다(매 자모마다 누적 송출되는 버그 우회).
    ta.addEventListener("compositionstart", (e) => e.stopImmediatePropagation(), true);
    ta.addEventListener("compositionupdate", (e) => e.stopImmediatePropagation(), true);
    ta.addEventListener(
      "compositionend",
      (e) => {
        e.stopImmediatePropagation();
        const data = (e as CompositionEvent).data;
        if (data) void invoke("term_write", { termId: opts.id, data }).catch(() => {});
        ta.value = "";
      },
      true,
    );
    // input 이벤트 처리:
    // - Linux WebKitGTK: 조합 중/insertCompositionText는 위 compositionend가 처리하므로 차단.
    // - macOS WKWebView: 한글 IME가 compositionstart/end를 발화하지 않고, 음절이 바뀔 때마다
    //   inputType=insertReplacementText로 textarea 내용을 갈아끼운다. xterm 기본 핸들러는
    //   insertText만 PTY로 보내므로 insertReplacementText는 누락 → 첫 자모만 PTY에 남고 나머지 손실
    //   ("이거 실행해봐" → "ㅇ거 ㅅ해ㅎ보"). 해결: insertReplacementText를 가로채서
    //   "직전 1자 삭제(\x7f) + 새 데이터"를 PTY로 보낸다 — 셸 readline이 \x7f를 받으면
    //   입력 라인의 직전 한 글자(한글 1음절 포함)를 지운다.
    ta.addEventListener(
      "input",
      (e) => {
        const ie = e as InputEvent;
        if (ie.isComposing || ie.inputType === "insertCompositionText") {
          e.stopImmediatePropagation();
          ta.value = "";
          return;
        }
        if (isMacWebKit && ie.inputType === "insertReplacementText") {
          e.stopImmediatePropagation();
          const data = ie.data ?? "";
          void invoke("term_write", {
            termId: opts.id,
            data: "\x7f" + data,
          }).catch(() => {});
        }
      },
      true,
    );
  }

  const inst: TermInstance = {
    id: opts.id,
    projectId: opts.projectId,
    term,
    fit,
    host,
    status: "live",
  };
  registry.set(opts.id, inst);

  // 출력: Channel(raw bytes) → xterm. 멀티바이트 경계 안전을 위해 바이트 그대로 write.
  const channel = new Channel<number[]>();
  channel.onmessage = (bytes) => term.write(new Uint8Array(bytes));

  void invoke("term_open", {
    termId: opts.id,
    projectId: opts.projectId,
    cols: term.cols || 80,
    rows: term.rows || 24,
    onData: channel,
  }).catch((e: unknown) => {
    inst.status = "exited";
    const msg = e instanceof Error ? e.message : String(e);
    term.writeln(`\r\n\x1b[31m[터미널 시작 실패] ${msg}\x1b[0m`);
  });

  // 입력 → PTY stdin
  term.onData((data) => {
    void invoke("term_write", { termId: opts.id, data }).catch(() => {});
  });
  // 리사이즈 → ConPTY
  term.onResize(({ cols, rows }) => {
    void invoke("term_resize", { termId: opts.id, cols, rows }).catch(() => {});
  });

  return inst;
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
