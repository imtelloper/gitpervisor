import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { collectPanes, useTerminals } from "../stores/terminals";
import { useUi } from "../stores/ui";
import { isMod } from "./platform";
import {
  ensureExitListener,
  pasteIntoTerminal,
  registry,
  type TermInstance,
} from "./terminal";
import { themeOf } from "./themes";

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

/** 열린 모든 터미널에 현재 CSS 변수 기반 테마 재적용 — 테마 전환 시 코어가 호출한다.
 *  xterm 6은 options.theme 참조 비교로 리렌더를 판단하므로 "새 객체" 대입이 필수
 *  (readTheme가 매번 새 객체를 반환해 충족). */
export function refreshTerminalThemesImpl(): void {
  const theme = readTheme();
  for (const inst of registry.values()) {
    // 인스턴스 간 객체 공유는 무해(xterm이 내부 복사) — 참조만 새 것이면 된다.
    inst.term.options.theme = { ...theme };
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
    theme: readTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

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
        void navigator.clipboard.writeText(sel).then(
          () => term.clearSelection(),
          () => useUi.getState().pushToast("error", "복사에 실패했습니다"),
        );
      e.preventDefault();
      return false;
    }
    // 붙여넣기: Ctrl+V / Ctrl+Shift+V — 스마트(파일·이미지→경로) 붙여넣기로 대체.
    // Cmd+V(macOS, metaKey)는 의도적으로 안 잡는다 — WKWebView 네이티브 붙여넣기 → xterm
    // 기본 paste 경로가 이미 동작한다. term_paste는 세 플랫폼 모두 실구현이다(win: clipboard-win,
    // unix: arboard — DOCS/TROUBLESHOOTING.md §6).
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
        if (data) void invoke("term_write", { termId: opts.id, data }).catch(() => {});
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
            if (delta)
              void invoke("term_write", { termId: opts.id, data: delta }).catch(() => {});
          }
        },
        true,
      );
      // 포커스 상실 시 조합 문맥이 사라지므로 미러 리셋(다음 포커스+입력이 깨끗이 시작).
      ta.addEventListener("blur", () => resetImeMirror(), true);
    }
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
  // 주의: 여기서 IME 미러를 리셋하면 안 된다 — onData에는 키 입력만 아니라 xterm의 "자동응답"
  // (커서위치 \x1b[?..R, DA, 포커스 \x1b[I/O, 마우스 리포트)이 상시 흐른다(TUI/프롬프트가 초당
  // 수십 회 질의). 제어바이트 매칭으로 리셋하면 한글 조합 도중 미러+textarea가 계속 지워져
  // 입력이 깨진다(자모 파편·중복). 리셋은 keydown 목록/ASCII input/blur가 담당한다.
  term.onData((data) => {
    void invoke("term_write", { termId: opts.id, data }).catch(() => {});
  });
  // 리사이즈 → ConPTY
  term.onResize(({ cols, rows }) => {
    void invoke("term_resize", { termId: opts.id, cols, rows }).catch(() => {});
  });

  return inst;
}
