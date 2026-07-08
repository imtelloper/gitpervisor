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
    const result = (await this.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      initializationOptions,
      capabilities: CLIENT_CAPABILITIES,
    }).catch(() => null)) as { capabilities?: Record<string, unknown> } | null;
    if (!result || this.disposed) return false;
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
        // 취소 통지 — 서버가 계산을 멈추게(무가치한 응답 방지)
        this.notify("$/cancelRequest", { id });
        reject(new Error(`lsp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.frameSend({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (this.disposed) return;
    this.frameSend({ method, params });
  }

  private reply(id: number | string, result: unknown) {
    this.frameSend({ id, result });
  }

  private frameSend(obj: Record<string, unknown>) {
    const msg = JSON.stringify({ jsonrpc: "2.0", ...obj });
    // fire-and-forget — 재시도 금지(중복 id 오염). 유실은 요청 타임아웃이 자기치유.
    void invoke("lsp_send", { sessionKey: this.key, msg }).catch(() => {});
  }

  // ── 문서 동기화 ──
  didOpen(uri: string, languageId: string, text: string) {
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
  }
  hasOpenDocs() {
    return this.openDocs.size > 0;
  }

  /** 서버 종료(lsp://exit) 또는 명시 정리. pending 전부 reject → 휴리스틱 폴백. */
  dispose(stopServer: boolean) {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer);
      p.reject(new Error("lsp session closed"));
    }
    this.pending.clear();
    this.openDocs.clear();
    if (stopServer) void invoke("lsp_stop", { sessionKey: this.key }).catch(() => {});
  }
}

// ── 세션 레지스트리 ──
const sessions = new Map<string, LspSession>();
let exitUnlisten: UnlistenFn | null = null;

async function ensureExitListener() {
  if (exitUnlisten) return;
  exitUnlisten = await listen<{ sessionKey: string }>("lsp://exit", (e) => {
    const key = e.payload.sessionKey;
    const s = sessions.get(key);
    if (s) {
      s.dispose(false); // 서버는 이미 죽음 — pending reject + 게이트 해제
      sessions.delete(key);
    }
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
