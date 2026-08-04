// LSP 클라이언트 어댑터 (태스크 17 M1) — 세션·JSON-RPC 상관관계·취소의 단일 진실.
// 서버→프론트는 Channel(순서 보장), 프론트→서버는 fire-and-forget lsp_send. id 상관관계는
// 전적으로 여기서(백엔드는 바이트만 나른다). WebView2 invoke 유실이 나도 요청 타임아웃+취소가 자기치유.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LspLang =
  | "py"
  | "ts"
  | "cpp"
  | "rust"
  | "lua"
  | "go"
  | "php"
  | "zig"
  | "ruby"
  | "csharp"
  | "java";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
  method: string;
}

interface ServerInfo {
  binary: string;
  version: string | null;
  sessionKey: string;
  rootPath: string;
  pythonPath: string | null;
  tsserverPath: string | null;
}

const REQUEST_TIMEOUT = 10_000;
/** initialize만은 따로 — 서버가 워크스페이스를 훑는 동안 응답하지 않을 수 있다(jdtls·
 *  rust-analyzer는 대형 레포에서 수십 초). 일반 요청과 같은 10초로 끊으면 멀쩡한 서버를
 *  버리고 매번 새로 띄우는 콜드 스타트 반복이 된다. */
const INITIALIZE_TIMEOUT = 60_000;
/** 열린 문서가 0이 된 뒤 서버를 내리기까지의 유예.
 *  파일 전환은 didClose→didOpen 순이라 0이 되는 순간 바로 내리면 전환할 때마다 콜드 스타트
 *  (tsserver·jdtls는 수 초)를 물게 된다. 백엔드 유휴 리퍼(10분)보다 먼저 회수해 아무 파일도
 *  안 보는 동안 언어 서버가 수백 MB를 붙들고 있는 상태를 줄인다(사후조치 P1 — 세션 상한). */
const IDLE_DISPOSE_DELAY = 120_000;

type DiagnosticsHandler = (uri: string, diags: unknown[]) => void;

/** 하나의 언어 서버 세션. projectId:lang 당 1개. */
export class LspSession {
  readonly key: string;
  readonly projectId: string;
  readonly lang: LspLang;
  rootPath = "";
  /** 탐지된 인터프리터 절대경로 — workspace/configuration python 섹션에 pythonPath로 응답(§M2). */
  pythonPath: string | null = null;
  serverCaps: Record<string, unknown> | null = null;
  /** 게이트 활성 조건(§3.6): initialize 완료 + 첫 정상 응답 이후. 인덱싱 중 휴리스틱 차단 방지. */
  ready = false;
  private starting: Promise<boolean> | null = null;
  private idSeq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly openDocs = new Set<string>(); // uri
  private disposed = false;
  /**
   * 송신 직렬화 큐.
   *
   * 백엔드 `lsp_send`는 `#[tauri::command(async)]`라 호출마다 워커 스레드로 흩어진다. 예전엔
   * 동기 커맨드라 IPC 스레드 하나에서 도착 순서대로 처리되는 것이 **암묵적** 순서 보장이었는데,
   * 그 보장이 사라졌다. 여기서 체이닝하지 않으면 `didChange`가 version 역전으로 도착해
   * (v2 → v1) 서버가 문서 상태를 잃고 진단·자동완성이 조용히 어긋난다.
   *
   * 호출자 입장에선 여전히 fire-and-forget이다(await도 throw도 없다) — 순서만 FIFO로 고정한다.
   */
  private sendChain: Promise<void> = Promise.resolve();
  /** 열린 문서 0 → 서버 정리 예약 타이머. 문서가 다시 열리면 취소된다. */
  private idleTimer: number | undefined;
  onDiagnostics: DiagnosticsHandler | null = null;

  constructor(projectId: string, lang: LspLang) {
    this.projectId = projectId;
    this.lang = lang;
    this.key = `${projectId}:${lang}`;
  }

  /** 서버 스폰 + initialize 핸드셰이크. 멱등 — 여러 번 호출해도 1회만 기동. */
  start(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.starting) return this.starting;
    this.starting = this.doStart().catch(() => {
      this.starting = null;
      return false;
    });
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    // Channel은 Tauri 런타임이 콜백 등록으로 살려둔다(terminal-engine 전례 — 필드 저장 불필요).
    const channel = new Channel<string>();
    channel.onmessage = (raw) => this.onMessage(raw);

    let info: ServerInfo;
    try {
      info = await invoke<ServerInfo>("lsp_start", {
        projectId: this.projectId,
        lang: this.lang,
        onMsg: channel,
      });
    } catch {
      return false; // 서버 미설치·스폰 실패 → 휴리스틱 유지
    }
    this.rootPath = info.rootPath;
    this.pythonPath = info.pythonPath;

    // initialize 핸드셰이크. TS는 tsserver 위치를 initializationOptions로 넘긴다(tls 5.3.0은
    // --tsserver-path 플래그가 없음 — 실측). py는 인터프리터를 workspace/configuration으로 전달.
    const initializationOptions =
      this.lang === "ts" && info.tsserverPath
        ? {
            tsserver: { path: info.tsserverPath, logVerbosity: "off" },
            hostInfo: "gitpervisor",
            // tsserver inlay hints는 기본 OFF — preferences로 켠다(노이즈 최소: 리터럴 인자
            // 파라미터명 + 함수 반환/변수 타입). tls가 tsserver에 그대로 전달.
            preferences: {
              includeInlayParameterNameHints: "literals",
              includeInlayParameterNameHintsWhenArgumentMatchesName: false,
              includeInlayFunctionParameterTypeHints: true,
              includeInlayVariableTypeHints: true,
              includeInlayVariableTypeHintsWhenTypeMatchesName: false,
              includeInlayPropertyDeclarationTypeHints: true,
              includeInlayFunctionLikeReturnTypeHints: true,
              includeInlayEnumMemberValueHints: true,
            },
          }
        : undefined;
    const rootUri = pathToUri(info.rootPath);
    const result = (await this.request(
      "initialize",
      {
        processId: null,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "workspace" }],
        initializationOptions,
        capabilities: CLIENT_CAPABILITIES,
      },
      INITIALIZE_TIMEOUT,
    ).catch(() => null)) as { capabilities?: Record<string, unknown> } | null;
    if (!result) {
      // initialize 실패/타임아웃 — **프로세스는 이미 떠 있다**. 여기서 안 내리면 아무도 쓰지
      // 않는 서버가 유휴 리퍼(10분)까지 수백 MB를 붙들고 남고, start()의 starting 프로미스가
      // false로 굳어 그 언어는 리로드 전까지 영영 재시도조차 못 한다. dispose가 레지스트리에서도
      // 빼므로 다음 사용자 조작이 새 세션으로 깨끗이 재시도한다.
      this.dispose(true);
      return false;
    }
    if (this.disposed) return false;
    this.serverCaps = result.capabilities ?? {};
    this.notify("initialized", {});
    this.ready = true;
    return true;
  }

  private onMessage(raw: string) {
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // 1) 우리 요청에 대한 응답
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id as number);
      if (p) {
        this.pending.delete(msg.id as number);
        window.clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? "lsp error"));
        else p.resolve(msg.result);
      }
      return;
    }

    // 2) 서버→클라이언트 요청(id 있고 method 있음) — 응답 필수. M1은 최소 대응.
    if (msg.id !== undefined && msg.method) {
      let result: unknown = null;
      if (msg.method === "workspace/configuration") {
        // items 순서대로 배열 응답. section "python"엔 pythonPath(절대경로)를 채워 인터프리터를
        // 지정(basedpyright venv 해석). 나머지 섹션은 null(기본값 — §M2 연구 실측).
        const items = (msg.params as { items?: { section?: string }[] })?.items ?? [];
        result = items.map((it) =>
          it.section === "python" && this.pythonPath ? { pythonPath: this.pythonPath } : null,
        );
      }
      // client/registerCapability·window/workDoneProgress/create 등은 null 응답으로 수락.
      this.reply(msg.id, result);
      return;
    }

    // 3) 알림(id 없음)
    if (msg.method === "textDocument/publishDiagnostics") {
      const p = msg.params as { uri?: string; diagnostics?: unknown[] };
      if (p?.uri) this.onDiagnostics?.(p.uri, p.diagnostics ?? []);
    }
    // window/logMessage·$/progress 등은 무시.
  }

  /** JSON-RPC 요청 — id 상관관계 + 타임아웃. */
  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("disposed"));
    const id = this.idSeq++;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        // 취소 통지 — 서버가 계산을 멈추게(무가치한 응답 방지).
        // 사용자 기점이 아니다: 원 요청이 이미 activity로 세어졌고, 우리 타임아웃이 스스로
        // 쏘는 트래픽까지 activity로 세면 유휴 판정이 흐려진다.
        this.notify("$/cancelRequest", { id }, false);
        reject(new Error(`lsp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.frameSend({ id, method, params });
    });
  }

  notify(method: string, params: unknown, userInitiated = true) {
    if (this.disposed) return;
    this.frameSend({ method, params }, userInitiated);
  }

  private reply(id: number | string, result: unknown) {
    // 서버가 먼저 건 요청에 대한 응답 — **사용자 기점이 아니다**. 이걸 activity로 세면
    // 서버가 주기적으로 말을 거는 것(workspace/configuration·$/progress 재등록 등)만으로
    // 백엔드 유휴 리퍼가 영원히 발동하지 않아 유휴 서버가 무한 상주한다(사후조치 P1).
    this.frameSend({ id, result }, false);
  }

  private frameSend(obj: Record<string, unknown>, userInitiated = true) {
    // dispose 이후 새 요청이 나가면 백엔드가 이미 내린 세션을 되살릴 수 있다(그리고 그 서버는
    // 아무도 응답을 안 받는 유령이 된다). 모든 송신의 단일 관문에서 막는다.
    if (this.disposed) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", ...obj });
    // fire-and-forget — 재시도 금지(중복 id 오염). 유실은 요청 타임아웃이 자기치유.
    // 다만 **순서는 지킨다**: 앞 송신이 끝난 뒤 다음을 보낸다(sendChain 주석 참고).
    this.sendChain = this.sendChain.then(() =>
      invoke("lsp_send", { sessionKey: this.key, msg, userInitiated }).then(
        () => {},
        () => {}, // 실패해도 체인은 끊지 않는다 — 한 번 실패가 이후 송신을 전부 막으면 안 된다
      ),
    );
  }

  // ── 문서 동기화 ──
  didOpen(uri: string, languageId: string, text: string) {
    // 문서가 다시 열렸다 — 예약된 유휴 정리 취소(파일 전환 시 didClose→didOpen 순서).
    window.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.openDocs.has(uri)) return;
    this.openDocs.add(uri);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }
  private versions = new Map<string, number>();
  didChange(uri: string, text: string) {
    if (!this.openDocs.has(uri)) return;
    const v = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, v);
    // full sync — 파일 1개라 incremental 이득 없음(§3.5).
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: v },
      contentChanges: [{ text }],
    });
  }
  didSave(uri: string, text: string) {
    if (!this.openDocs.has(uri)) return;
    this.notify("textDocument/didSave", { textDocument: { uri }, text });
  }
  didClose(uri: string) {
    if (!this.openDocs.delete(uri)) return;
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
    // 열린 문서가 0 → 서버를 붙잡아 둘 이유가 없다. 곧바로가 아니라 유예 뒤에 내린다.
    if (!this.hasOpenDocs()) this.armIdleDispose();
  }
  hasOpenDocs() {
    return this.openDocs.size > 0;
  }

  /** 열린 문서 0 상태가 IDLE_DISPOSE_DELAY 동안 이어지면 서버를 내린다(재무장 가능). */
  private armIdleDispose() {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.hasOpenDocs()) this.dispose(true);
    }, IDLE_DISPOSE_DELAY);
  }

  /** 서버 종료(lsp://exit) 또는 명시 정리. pending 전부 reject → 휴리스틱 폴백. */
  dispose(stopServer: boolean) {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer);
      p.reject(new Error("lsp session closed"));
    }
    this.pending.clear();
    this.openDocs.clear();
    // 레지스트리에서도 뺀다. 남겨 두면 ensureSession이 죽은 세션을 재사용하는데, disposed라
    // 모든 요청이 즉시 reject돼 그 언어가 영구히 휴리스틱으로 떨어진다(재기동 불가).
    if (sessions.get(this.key) === this) sessions.delete(this.key);
    if (stopServer) void invoke("lsp_stop", { sessionKey: this.key }).catch(() => {});
  }
}

// ── 세션 레지스트리 ──
const sessions = new Map<string, LspSession>();
let exitUnlisten: UnlistenFn | null = null;

async function ensureExitListener() {
  if (exitUnlisten) return;
  exitUnlisten = await listen<{ sessionKey: string }>("lsp://exit", (e) => {
    // 서버는 이미 죽음 — pending reject + 게이트 해제. 레지스트리 제거는 dispose가 한다.
    sessions.get(e.payload.sessionKey)?.dispose(false);
  });
}

/** projectId:lang 세션을 보장(없으면 기동). 실패 시 null → 휴리스틱 유지. */
export async function ensureSession(projectId: string, lang: LspLang): Promise<LspSession | null> {
  await ensureExitListener();
  let s = sessions.get(`${projectId}:${lang}`);
  if (!s) {
    s = new LspSession(projectId, lang);
    sessions.set(s.key, s);
  }
  const ok = await s.start();
  return ok ? s : null;
}

export function sessionFor(projectId: string, lang: LspLang): LspSession | undefined {
  return sessions.get(`${projectId}:${lang}`);
}

/** 휴리스틱 게이트(§3.6) — 그 언어 서버가 활성(initialize 완료)일 때만 true. */
export function lspActive(projectId: string, lang: LspLang): boolean {
  return sessions.get(`${projectId}:${lang}`)?.ready === true;
}

export function extToLang(ext: string): LspLang | null {
  const e = ext.toLowerCase();
  if (e === "py" || e === "pyi") return "py";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(e)) return "ts";
  if (["c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "hh", "inl", "ipp"].includes(e)) return "cpp";
  if (e === "rs") return "rust";
  if (e === "lua") return "lua";
  if (e === "go") return "go";
  if (e === "php") return "php";
  if (e === "zig") return "zig";
  if (e === "rb") return "ruby";
  if (e === "cs") return "csharp";
  if (e === "java") return "java";
  return null;
}

// ── URI 헬퍼(Windows 경로 ↔ file URI) ──
export function pathToUri(abs: string): string {
  let p = abs.replace(/\\/g, "/");
  // \\?\C:\ 접두 제거(정규화 경로에서 올 수 있음)
  p = p.replace(/^\/\/\?\//, "");
  if (!p.startsWith("/")) p = "/" + p; // 드라이브레터 앞에 슬래시
  // 각 세그먼트 인코딩(공백·한글 등) — 콜론·슬래시는 보존
  return "file://" + p.split("/").map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ":")).join("/");
}

export function uriToPath(uri: string): string {
  let p = uri.replace(/^file:\/\//, "");
  p = decodeURIComponent(p);
  // /C:/... → C:/...
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

/** 클라이언트 capabilities — completion/hover/definition/references/signatureHelp(M1·M3). */
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        labelDetailsSupport: true,
        resolveSupport: { properties: ["documentation", "detail"] },
      },
      contextSupport: true,
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: false },
    references: {},
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    rename: { prepareSupport: true },
    inlayHint: { dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true },
  },
  workspace: { configuration: true, workspaceFolders: true },
} as const;
