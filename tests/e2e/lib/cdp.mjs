// 공유 CDP 클라이언트 — 실행 중인 gitpervisor 디버그 빌드(원격 디버깅 포트)에 붙어
// window.__TAURI_INTERNALS__.invoke 로 Tauri 커맨드를 직접 구동한다. (메모리: CDP UI 검증)
//
// 디버그 빌드만 9222 포트를 연다(lib.rs: --remote-debugging-port=9222 는 debug_assertions 전용).
// release 빌드/미실행이면 connect() 가 명확한 안내와 함께 throw 한다.

// gitpervisor 메인 창은 타이틀 "Gitpervisor" 로 식별한다(lib.rs: .title("Gitpervisor")).
// 9222 가 다른 Tauri 앱에 점유될 수 있으므로(사용자는 여러 Tauri 앱을 띄움) 포트 범위를 스캔해
// gitpervisor 페이지를 찾는다. GPV_E2E_PORT 가 지정되면 그 포트만 본다.
const SCAN_PORTS = [29222, 9222, 9223, 9224, 9225, 9226, 9333];
const TITLE = /gitpervisor/i;

async function listTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) });
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function locate(explicitPort) {
  const ports = explicitPort ? [explicitPort] : SCAN_PORTS;
  const seen = [];
  for (const port of ports) {
    const list = await listTargets(port);
    if (!list) continue;
    const pages = list.filter((t) => t.type === "page");
    for (const p of pages) seen.push(`  - 포트 ${port}: "${p.title || ""}" ${p.url}`);
    const page = pages.find((t) => TITLE.test(t.title || ""));
    if (page) return { page, port };
  }
  const hint = seen.length
    ? `발견된 다른 앱/타겟:\n${seen.join("\n")}\n\n` +
      `gitpervisor 디버그 포트(src-tauri/src/lib.rs 의 --remote-debugging-port)가 스캔 범위\n` +
      `[${SCAN_PORTS.join(", ")}] 안에 있어야 합니다. 다른 Tauri 앱과 충돌하면 lib.rs 의 포트를\n` +
      `비충돌 값으로 바꾸거나, GPV_E2E_PORT=<포트> 로 직접 지정하세요.`
    : "열린 CDP 포트가 없습니다.";
  throw new Error(
    `gitpervisor 디버그 창(title "Gitpervisor")을 찾지 못했습니다.\n` +
      `  'npm run tauri dev' 로 gitpervisor 를 먼저 띄우세요(디버그 빌드만 CDP 포트를 엽니다).\n${hint}`,
  );
}

class Cdp {
  constructor(ws) {
    this._ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._chanSeq = 0;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this._pending.has(msg.id)) {
        this._pending.get(msg.id)(msg);
        this._pending.delete(msg.id);
      }
    };
  }

  _send(method, params) {
    return new Promise((res) => {
      const mid = ++this._id;
      this._pending.set(mid, res);
      this._ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  /** 페이지 컨텍스트에서 표현식을 평가하고 값을 그대로(by value) 돌려준다. JS 예외는 throw. */
  async eval(expression) {
    const r = await this._send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`page eval 예외: ${d.exception?.description || d.text || JSON.stringify(d)}`);
    }
    return r.result?.result?.value;
  }

  /**
   * Tauri 커맨드 invoke. 성공 시 결과를, 실패(reject) 시 IpcError 형태로 throw.
   * 페이지 측에서 타임아웃 레이스를 걸어 응답 유실(WebView2 §10)에도 항상 settle 한다.
   */
  async invoke(cmd, args = {}, { timeoutMs = 30000 } = {}) {
    const res = await this.try(cmd, args, { timeoutMs });
    if (!res.ok) {
      const err = new Error(`invoke ${cmd} 실패: ${res.code || ""} ${res.message || ""}`.trim());
      err.code = res.code;
      err.ipc = res;
      throw err;
    }
    return res.r;
  }

  /** invoke 의 비throw 버전 — { ok, r } 또는 { ok:false, code, message, stderr }. */
  async try(cmd, args = {}, { timeoutMs = 30000 } = {}) {
    const expr = `(()=>{
      const inv = window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});
      const to = new Promise((_,rej)=>setTimeout(()=>rej({__e2eTimeout:true}), ${timeoutMs}));
      return Promise.race([inv, to])
        .then((r)=>({ ok:true, r }))
        .catch((e)=>({ ok:false,
          code: (e&&e.code) || (e&&e.__e2eTimeout ? 'E2E_TIMEOUT' : null),
          message: (e&&e.message) || (e&&e.__e2eTimeout ? 'invoke 응답 시간 초과' : (typeof e==='string'? e : JSON.stringify(e))),
          stderr: (e&&e.stderr) || null }));
    })()`;
    return this.eval(expr);
  }

  /**
   * term_open 용 Tauri Channel<Vec<u8>> 인자를 만든다. ref 를 onData 로 넘기고,
   * drain() 으로 누적된 PTY 출력 바이트(평탄화)를 가져온다. text()는 UTF-8 디코딩.
   */
  async openChannel() {
    const slot = `__gpvChan_${++this._chanSeq}`;
    const rid = await this.eval(
      `(()=>{ const k=${JSON.stringify(slot)}; window[k]=[];
         return window.__TAURI_INTERNALS__.transformCallback((m)=>{ try{ const b=m&&m.message; if(b&&b.length) window[k].push(...b); }catch(_){} }); })()`,
    );
    const drainBytes = async () =>
      this.eval(`(()=>{ const k=${JSON.stringify(slot)}; const a=window[k]||[]; window[k]=[]; return a; })()`);
    return {
      ref: `__CHANNEL__:${rid}`,
      drain: drainBytes,
      text: async () => Buffer.from(await drainBytes()).toString("utf8"),
    };
  }

  close() {
    try {
      this._ws.close();
    } catch (_) {
      /* noop */
    }
  }
}

export async function connect({ port } = {}) {
  const explicit = port || Number(process.env.GPV_E2E_PORT) || null;
  const { page, port: cdpPort } = await locate(explicit);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("CDP WebSocket 오류: " + (e?.message || "")));
  });
  const cdp = new Cdp(ws);
  await cdp._send("Runtime.enable");
  const bridge = await cdp.eval("typeof window.__TAURI_INTERNALS__?.invoke");
  if (bridge !== "function") {
    cdp.close();
    throw new Error("Tauri invoke 브리지를 찾지 못했습니다(window.__TAURI_INTERNALS__.invoke).");
  }
  // gitpervisor 정체성 재확인 — 타이틀이 맞아도 잘못된 빌드면 명확히 알린다.
  const probe = await cdp.try("check_git", {}, { timeoutMs: 5000 });
  if (!probe.ok && /not found/i.test(probe.message || "")) {
    cdp.close();
    throw new Error(`연결된 앱이 gitpervisor 가 아닙니다(check_git 미존재): ${page.title} @ ${page.url}`);
  }
  cdp.pageUrl = page.url;
  cdp.cdpPort = cdpPort;
  // 앱 자신의 vite dev 서버 포트(scan_dev_ports 테스트가 "리스닝 중인 알려진 포트"로 사용)
  cdp.devPort = Number(new URL(page.url).port) || null;
  return cdp;
}
