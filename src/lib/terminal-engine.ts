import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { collectPanes, useTerminals } from "../stores/terminals";
import {
  ensureExitListener,
  pasteIntoTerminal,
  registry,
  type TermInstance,
} from "./terminal";

// 이 모듈은 **무거운 xterm 엔진**이다(@xterm/xterm + addon-fit + addon-webgl + css ≈ 441kB).
// 경량 코어(./terminal)에서 첫 터미널 탭이 열릴 때만 동적 import되어, 콜드 스타트 번들에서
// xterm을 제외한다. 레지스트리·인스턴스 조작·exit 구독은 코어가 소유한다(여기선 import만).

// Linux 웹뷰(WebKitGTK)는 인쇄 가능한 키를 입력기(IME) textarea 경로로 흘려보내는데,
// 이 버퍼가 비워지지 않아 키마다 직전까지의 내용이 통째로 다시 전송된다(중복 누적,
// Backspace 무력화). Windows(WebView2)/macOS는 정상. 이 플랫폼에서만 우회한다.
const isWebKitGtk = /Linux/.test(navigator.userAgent);
// macOS WKWebView도 WebKit 계열이라 IME(한글 등) 조합 중 keydown으로 raw 자모가 PTY로
// 흘러나가 조합이 깨진다("이거"→"ㅇ거"). compositionend로만 확정 문자열을 송출하도록 가로챈다.
const isMacWebKit = /Mac/i.test(navigator.userAgent);

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
    theme: readTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const k = e.key.toLowerCase();

    // Tab/Shift+Tab은 물리 키(e.code)로 IME 가드보다 "먼저" 잡는다. WebKitGTK가 Shift+Tab의
    // e.key를 "Unidentified"로 보고하면 아래 IME 가드에 걸려 핸들러가 우회되고 웹뷰 포커스가
    // 다른 요소로 튄다. e.code는 IME 무관 물리 키라 항상 "Tab". preventDefault로 포커스 이동을
    // 막고 Tab→\t / Shift+Tab→\x1b[Z 를 PTY로 보낸다(xterm은 Shift+Tab에 cancel을 안 거는 버그).
    if (e.code === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      void invoke("term_write", {
        termId: opts.id,
        data: e.shiftKey ? "\x1b[Z" : "\t",
      }).catch(() => {});
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
    // 프로젝트 위/아래 이동(Ctrl+Shift+↑/↓)도 PTY로 보내지 않고 window 핸들러로 흘려보낸다.
    if (e.ctrlKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
      return false;
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

  // GPU 가속 렌더러(WebGL) — 대량 출력에서 DOM 렌더러 대비 CPU·잔상을 줄인다(VS Code 내장
  // 터미널과 동일 엔진). 단 WebKitGTK(Linux)에서는 GPU/드라이버 조합(특히 NVIDIA 프로프라이어터리
  // 드라이버·소프트웨어 GL)에 따라 WebGL 컨텍스트가 웹뷰 렌더러 프로세스를 크래시시켜 화면 전체가
  // 까맣게 먹통된다(분할로 터미널을 여럿 띄우면 더 잘 터짐 — 컨텍스트 다수). 그래서 WebGL이
  // 안정적인 WebView2(Windows)/WKWebView(macOS)에서만 켜고, WebKitGTK에서는 안정적인 기본 DOM
  // 렌더러를 쓴다. loadAddon은 반드시 open() 이후라야 한다.
  if (!isWebKitGtk) {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* WebGL 불가 — xterm 기본 DOM 렌더러로 동작 */
    }
  }

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
  // 플로팅 분리 중(detach 후 term_attach 전)엔 Rust가 잠깐 옛 채널로 보낼 수 있어, 이미 dispose된
  // xterm에 write가 떨어질 수 있다 — try/catch로 그 짧은 공백의 예외를 무시한다.
  const channel = new Channel<number[]>();
  channel.onmessage = (bytes) => {
    try {
      term.write(new Uint8Array(bytes));
    } catch {
      /* dispose/detach 직후 — 무시 */
    }
  };

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
    const msg = e instanceof Error ? e.message : String(e);
    term.writeln(`\r\n\x1b[31m[터미널 연결 실패] ${msg}\x1b[0m`);
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
