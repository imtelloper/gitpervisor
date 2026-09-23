// 공유 CDP 클라이언트 — 실행 중인 gitpervisor 디버그 빌드(원격 디버깅 포트)에 붙어
// window.__TAURI_INTERNALS__.invoke 로 Tauri 커맨드를 직접 구동한다. (메모리: CDP UI 검증)
//
// 디버그 빌드만 9222 포트를 연다(lib.rs: --remote-debugging-port=9222 는 debug_assertions 전용).
// release 빌드/미실행이면 connect() 가 명확한 안내와 함께 throw 한다.
//
// 부하가 큰 머신에서 CDP 응답이 실제로 유실된다(실측): `Runtime.evaluate` 응답에 result 가
// 통째로 없어 eval 이 조용히 undefined 를 돌려주면 호출부가 `Cannot read properties of undefined`
// 로 죽고, 응답이 아예 안 오면 _send 가 영원히 대기해 러너가 멈춘다. 그래서 _send 는 시한을
// 두고, eval 은 result 누락을 재시도 후 명시적 오류로 올리며, try() 는 그 오류를 E2E_CDP 로 감싼다.

// gitpervisor 메인 창은 타이틀 "Gitpervisor" 로 식별한다(lib.rs: .title("Gitpervisor")).
// 9222 가 다른 Tauri 앱에 점유될 수 있으므로(사용자는 여러 Tauri 앱을 띄움) 포트 범위를 스캔해
// gitpervisor 페이지를 찾는다. GPV_E2E_PORT 가 지정되면 그 포트만 본다.
//
// **타이틀만으로 고르면 안 된다.** 플로팅 터미널 프리워밍 풀 창(label `float-pool-N`)도 같은
// 타이틀·같은 URL 이라 /json 순서에 따라 첫 매칭이 풀 창일 수 있다. 그 창에 붙으면 스위트 13 이
// 풀 창을 닫는 순간 CDP 연결이 통째로 끊겨 러너가 중간에 죽는다(실제로 두 세션이 겪었다).
// 그래서 매칭 페이지마다 붙어 webview 라벨을 물어 `main` 을 고른다.
const SCAN_PORTS = [29222, 9222, 9223, 9224, 9225, 9226, 9333];
const TITLE = /gitpervisor/i;
const LABEL_EXPR = "window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label";

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
    // 타이틀 매칭을 **전부** 돌려준다 — 어느 것이 메인 창인지는 connect() 가 라벨로 가린다.
    const matched = pages.filter((t) => TITLE.test(t.title || ""));
    if (matched.length) return { pages: matched, port };
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

  _send(method, params, { timeoutMs = 60000 } = {}) {
    return new Promise((res, rej) => {
      const mid = ++this._id;
      const timer = setTimeout(() => {
        this._pending.delete(mid);
        rej(new Error(`CDP ${method} 응답 시간 초과(${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      this._pending.set(mid, (msg) => {
        clearTimeout(timer);
        res(msg);
      });
      this._ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  }

  /**
   * 페이지 컨텍스트에서 표현식을 평가하고 값을 그대로(by value) 돌려준다. JS 예외는 throw.
   *
   * `awaitPromise` 라 **페이지 안의 대기가 곧 CDP 응답 대기**다. 자체 폴링 예산이 큰 표현식
   * (14 의 #2b 는 셸에 폭을 세 번 물어 최악 ~55s)은 기본 60s 시한에 그대로 걸린다 —
   * 그런 호출부만 `{ timeoutMs }` 로 예산보다 넉넉히 잡는다.
   */
  async eval(expression, { timeoutMs = 60000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await this._send(
        "Runtime.evaluate",
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
        { timeoutMs },
      );
      if (r.error) {
        throw new Error(
          `CDP Runtime.evaluate 오류: ${r.error.message || JSON.stringify(r.error)}`,
        );
      }
      if (r.result?.exceptionDetails) {
        const d = r.result.exceptionDetails;
        throw new Error(`page eval 예외: ${d.exception?.description || d.text || JSON.stringify(d)}`);
      }
      // result 객체가 있으면 value 가 없어도(정상 `{type:"undefined"}`) 그대로 돌려준다.
      // result 자체가 없는 것만 응답 유실로 보고 재시도한다.
      if (r.result?.result) return r.result.result.value;
      if (attempt >= 2) {
        throw new Error(
          `CDP Runtime.evaluate 응답에 result 가 없습니다(재시도 2회 실패): ${expression.slice(0, 120)}`,
        );
      }
      await new Promise((res) => setTimeout(res, 150));
    }
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
    // CDP 계층 오류(응답 유실·시간 초과)는 throw 하지 않고 실패 결과로 돌려준다 —
    // invoke() 가 `.ok` 를 읽다 TypeError 로 죽지 않고 원인이 그대로 보고되게.
    try {
      return await this.eval(expr);
    } catch (e) {
      return { ok: false, code: "E2E_CDP", message: e?.message || String(e), stderr: null };
    }
  }

  /**
   * term_open 용 Tauri Channel 인자를 만든다. ref 를 onData 로 넘기고,
   * drain() 으로 누적된 PTY 출력 바이트(평탄화)를 가져온다. text()는 UTF-8 디코딩.
   *
   * 페이로드는 커맨드에 따라 **ArrayBuffer**(`Channel<tauri::ipc::Response>` = Raw — PTY 출력이
   * 그렇다, 태스크 63) 또는 숫자 배열(`Channel<Vec<u8>>`)로 온다. 양쪽을 모두 받는다.
   * `push(...arr)` 는 쓰지 않는다 — 64KB 청크면 인자 65,536개라 스택이 터진다.
   */
  async openChannel() {
    const slot = `__gpvChan_${++this._chanSeq}`;
    const rid = await this.eval(
      `(()=>{ const k=${JSON.stringify(slot)}; window[k]=[];
         return window.__TAURI_INTERNALS__.transformCallback((m)=>{ try{
           const b=m&&m.message; if(b==null) return;
           const a = b instanceof ArrayBuffer ? new Uint8Array(b) : b;
           const out = window[k]; for(let i=0;i<a.length;i++) out.push(a[i]);
         }catch(_){} }); })()`,
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

/** 한 페이지에 붙어 Runtime 을 켠 Cdp 를 돌려준다(연결 실패는 null). */
async function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = (e) => rej(new Error("CDP WebSocket 오류: " + (e?.message || "")));
    });
  } catch (_) {
    return null;
  }
  const cdp = new Cdp(ws);
  await cdp._send("Runtime.enable");
  return cdp;
}

export async function connect({ port } = {}) {
  const explicit = port || Number(process.env.GPV_E2E_PORT) || null;
  const { pages, port: cdpPort } = await locate(explicit);

  // 라벨이 `main` 인 페이지를 고른다. 라벨을 못 읽는 옛 빌드를 위해 **첫 매칭 페이지**를
  // 폴백으로 들고 있는다(기존 동작). 채택되지 않은 연결은 바로 닫는다.
  let picked = null;
  let fallback = null;
  for (const page of pages) {
    const c = await attach(page);
    if (!c) continue;
    const label = await c.eval(LABEL_EXPR).catch(() => null);
    if (label === "main") {
      picked = { cdp: c, page };
      break;
    }
    // 폴백은 **라벨을 못 읽는** 페이지만을 위한 것이다(옛 빌드, 또는 아직 로딩 중이라
    // `__TAURI_INTERNALS__.metadata` 가 없는 main). 라벨을 **적극적으로 답한** 창
    // (`aggregate`·`float-pool-*`·`doc-*`)은 후보에서 뺀다 — 예전에는 "main 이 아닌 첫 페이지"를
    // 폴백으로 잡아서, main 의 라벨 eval 이 한 번 비면 모아보기 창이 채택됐다. 그 창에도 invoke
    // 브리지가 있어 아래 `check_git` 정체성 확인까지 통과하므로 **조용히** 엉뚱한 창으로 돌고,
    // 스위트는 `window.__gpv` 미노출로 통째 skip 됐다(2026-09-08 실관측, 사용자가 모아보기를
    // 열어 둔 상태면 후보가 항상 둘이라 재현된다).
    //
    // **`=== null` 로 좁히지 마라.** eval 은 `r.result.result.value` 를 그대로 돌려주므로 라벨이
    // 없는 페이지는 `{type:"undefined"}` → **`undefined`** 다. `null` 은 eval 이 던졌을 때만
    // (`.catch(() => null)`) 나온다. 둘 다 잡아야 폴백이 산다 — 그래서 느슨한 `== null` 이다.
    if (label == null && !fallback) fallback = { cdp: c, page };
    else c.close();
  }
  if (picked && fallback) fallback.cdp.close();
  const chosen = picked ?? fallback;
  if (!chosen) {
    throw new Error(
      `gitpervisor 페이지(${pages.length}개)에 CDP WebSocket 으로 붙지 못했습니다 — 앱이 방금 종료됐을 수 있습니다.`,
    );
  }
  const { cdp, page } = chosen;

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

/**
 * **라벨로** 창을 골라 붙는다(보조 창 e2e 공용 진입점 — doc-*, sysmon, aggregate 등).
 *
 * `connect()` 와 달리 타이틀을 보지 않는다: 문서 창(`doc-<id>`)은 타이틀이 파일명이라
 * `/gitpervisor/i` 필터에 아예 걸리지 않고, 모아보기·리소스 모니터도 타이틀이 제각각이다.
 * 그래서 `/json` 의 **모든 페이지**에 붙어 라벨을 물어 정확히 일치하는 것만 채택하고 나머지
 * 연결은 즉시 닫는다(연결을 남기면 그 창이 닫힐 때 러너 쪽 WebSocket 이 요란하게 죽는다).
 *
 * 새 OS 창은 웹뷰 초기화까지 시간이 걸리므로 20회 × 500ms 재시도한다. 못 찾으면 throw —
 * 호출부가 "창을 못 찾음"과 "창에서 단언 실패"를 구분할 수 있어야 한다.
 */
export async function connectLabel(label, { port } = {}) {
  const explicit = port || Number(process.env.GPV_E2E_PORT) || null;
  const ports = explicit ? [explicit] : SCAN_PORTS;
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const p of ports) {
      const list = await listTargets(p);
      if (!list) continue;
      for (const page of list.filter((t) => t.type === "page")) {
        const c = await attach(page);
        if (!c) continue;
        if ((await c.eval(LABEL_EXPR).catch(() => null)) === label) {
          c.pageUrl = page.url;
          c.cdpPort = p;
          c.devPort = Number(new URL(page.url).port) || null;
          return c;
        }
        c.close();
      }
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(
    `라벨 "${label}" 인 창의 CDP 페이지를 찾지 못했습니다(20회 재시도, 포트 [${ports.join(", ")}]).`,
  );
}

// ── 문서 창 탐지 (태스크 73 — 프리워밍 풀) ────────────────────────────────────────
// `open_doc_window` 는 프리워밍 풀(lib.rs FLOAT_POOL)에 대기 창이 있으면 그것을 claim 해 show
// 한다. 그래서 문서 창의 라벨은 `doc-<id>` 가 **아닐 수 있고**(`float-pool-N`), 더 중요하게는
// **호출 전부터 `/json` 에 있다**(숨김 창). 예전 관용구
//   labels().find(l => l.startsWith("doc-") && !before.includes(l))
// 는 그래서 아무것도 못 찾는다 — 새 라벨로 잡히는 것은 claim 직후 채워지는 **보충 창**(숨김)뿐이다.
//
// 판정을 "새로 **보이게 된** 창"으로 바꾼다(스위트 13 openFloat 가 터미널 쪽에서 쓰는 것과 같은
// 방식). 직접 생성 경로는 새 라벨 + 보임, 풀 경로는 기존 라벨 + 새로 보임, 보충 창은 새 라벨 +
// 숨김이라 셋이 정확히 갈린다.
//
// **한계**: 같은 대기 구간에 터미널 분리(float claim)가 끼면 그 창도 "새로 보이게 된 풀 창"이라
// 후보에 든다. 문서 창 스위트는 그 둘을 같이 하지 않으므로 좁히지 않았다 — 하게 되면 라벨이
// `doc-` 인지, 또는 그 창의 DOM 을 물어 가려야 한다.

const DOC_WINDOW_LABELS_EXPR = (onlyVisible) => `(async()=>{ try{
  const m = await import("/node_modules/@tauri-apps/api/webviewWindow.js");
  const out = [];
  for (const w of await m.getAllWebviewWindows()) {
    if (!(w.label.startsWith("doc-") || w.label.startsWith("float-pool-"))) continue;
    if (${onlyVisible ? "!(await w.isVisible())" : "false"}) continue;
    out.push(w.label);
  }
  return out; }catch(e){ return []; } })()`;

const DOC_KEYS_EXPR = `(()=>{ try{ return Object.keys(JSON.parse(localStorage.getItem("gp:doc-windows")||"{}")); }catch(e){ return []; } })()`;

/**
 * 문서 창을 여는 호출 **직전**에 찍는다 — `newDocWindow()` 와 짝으로 쓴다.
 * `cdp` 는 메인 창 연결이어야 한다(`gp:doc-windows` 는 같은 origin 의 localStorage).
 */
export async function docWindowsBefore(cdp) {
  const asArr = (v) => (Array.isArray(v) ? v : []);
  return {
    all: asArr(await cdp.eval(DOC_WINDOW_LABELS_EXPR(false)).catch(() => [])),
    visible: asArr(await cdp.eval(DOC_WINDOW_LABELS_EXPR(true)).catch(() => [])),
    keys: asArr(await cdp.eval(DOC_KEYS_EXPR).catch(() => [])),
  };
}

/**
 * 방금 열린 문서 창을 찾는다. 반환 `{ label, docId, pooled }` — 못 찾으면 null.
 *
 * `docId` 는 `gp:doc-windows` 의 **새 키**다(창 정리 때 그 항목을 지우는 데 쓴다). 라벨에서
 * 잘라 쓸 수 없다: 풀 경로의 라벨은 `float-pool-N` 이다. 결정적 id 를 쓰는 창(리포트 `report`,
 * 폴더·로그 `fnv16(...)`)은 그 키가 **이미 있어서** 새 키가 없으므로 null 이 나온다 — 그 경우
 * 호출부가 자기가 아는 id 를 쓴다.
 */
export async function newDocWindow(cdp, before, { tries = 24, ms = 500 } = {}) {
  const asArr = (v) => (Array.isArray(v) ? v : []);
  for (let i = 0; i < tries; i++) {
    const vis = asArr(await cdp.eval(DOC_WINDOW_LABELS_EXPR(true)).catch(() => []));
    const label = vis.find((l) => !before.visible.includes(l));
    if (label) {
      const keys = asArr(await cdp.eval(DOC_KEYS_EXPR).catch(() => []));
      const fresh = keys.filter((k) => !before.keys.includes(k));
      return {
        label,
        docId: fresh.length === 1 ? fresh[0] : null,
        pooled: label.startsWith("float-pool-"),
      };
    }
    await new Promise((res) => setTimeout(res, ms));
  }
  return null;
}

/** 닫힌 문서 창이 `gp:doc-windows` 에 남긴 대상 기록 제거 — 이 실행분만. */
export async function forgetDocTarget(cdp, docId) {
  if (!docId) return false;
  return await cdp
    .eval(
      `(()=>{ try{ const k='gp:doc-windows'; const v=JSON.parse(localStorage.getItem(k)||'{}');
         delete v[${JSON.stringify(docId)}]; localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } })()`,
    )
    .catch(() => false);
}

/**
 * prod 번들에서 문서 창을 찾아 붙는다 — `/node_modules/@tauri-apps/api/...` 가 **없는** 창용.
 *
 * `newDocWindow()` 는 Tauri API 모듈을 동적 import 해 `isVisible()` 을 묻는데, 설치본/prod
 * 번들에는 그 경로가 서빙되지 않는다. 여기서는 `/json` 의 **모든 페이지**에 붙어
 * (a) 라벨이 문서 창 후보인지(`doc-*` 또는 풀 `float-pool-*`) (b) 그 창이 실제로 문서를 그리는지
 * (커스텀 타이틀바가 있는지 — 미claim 풀 창은 빈 바탕 `div` 뿐이다)로 가른다.
 *
 * `exclude` 에 이미 쓰고 있는 라벨을 넘긴다(창을 여러 개 띄우는 호출부). 반환은 `{ cdp, label }`,
 * 못 찾으면 null.
 */
export async function connectDocWindowProd({ port, exclude = [], tries = 40, ms = 500 } = {}) {
  const explicit = port || Number(process.env.GPV_E2E_PORT) || null;
  const ports = explicit ? [explicit] : SCAN_PORTS;
  const PROBE = `(() => { try { return JSON.stringify({
    label: ${LABEL_EXPR} || null,
    doc: !!document.querySelector('header,[class*="titlebar"]') }); } catch (e) { return null; } })()`;
  for (let attempt = 0; attempt < tries; attempt++) {
    for (const p of ports) {
      const list = await listTargets(p);
      if (!list) continue;
      for (const page of list.filter((t) => t.type === "page")) {
        const c = await attach(page);
        if (!c) continue;
        const raw = await c.eval(PROBE).catch(() => null);
        const st = raw ? JSON.parse(raw) : null;
        const label = st?.label ?? null;
        const candidate =
          !!label &&
          (label.startsWith("doc-") || label.startsWith("float-pool-")) &&
          !exclude.includes(label);
        if (candidate && st.doc) {
          c.pageUrl = page.url;
          c.cdpPort = p;
          return { cdp: c, label };
        }
        c.close();
      }
    }
    await new Promise((res) => setTimeout(res, ms));
  }
  return null;
}
