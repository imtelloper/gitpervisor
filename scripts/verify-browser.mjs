// 런타임 검증: 실행 중인 gitpervisor(디버그 CDP)에서 browser_open을 직접 invoke해
// add_child 자식 webview가 실제로 생성·렌더되는지 확인한다. 끝나면 정리.
const PORT = process.argv[2] || "9223";
const TEST_URL = process.argv[3] || "https://example.com/";
const BID = "verify-" + Math.floor(Math.random() * 1e6);

const base = `http://127.0.0.1:${PORT}`;

async function targets() {
  const r = await fetch(`${base}/json`);
  return r.json();
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error("ws error " + (e?.message || "")));
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });
  return { ready, send, close: () => ws.close() };
}

const evalJs = async (c, expr) => {
  const r = await c.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails || r.result?.result?.subtype === "error") {
    return { error: JSON.stringify(r.result) };
  }
  return { value: r.result?.result?.value, raw: r.result };
};

(async () => {
  const list = await targets();
  const page = list.find((t) => t.type === "page" && /localhost:39090/.test(t.url || ""));
  if (!page) {
    console.log("FAIL: gitpervisor page target not found. targets:", list.map((t) => t.url));
    process.exit(1);
  }
  console.log("page:", page.url);
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");

  const probe = await evalJs(c, "typeof window.__TAURI_INTERNALS__?.invoke");
  console.log("invoke bridge:", probe.value);

  // 메인 webview 출처/스킴 — mixed-content 판단 근거 (Windows Tauri 기본은 http origin)
  const origin = await evalJs(c, "JSON.stringify({origin: location.origin, protocol: location.protocol})");
  console.log("main origin:", origin.value);

  // http://localhost iframe 로드 테스트 (vite dev 39090로) — mixed-content 차단 여부
  const iframeTest = await evalJs(
    c,
    `new Promise((res)=>{const f=document.createElement('iframe');f.style.display='none';f.src='http://localhost:39090/';let done=false;const fin=(v)=>{if(done)return;done=true;try{f.remove()}catch{};res(v)};f.onload=()=>fin('loaded');f.onerror=()=>fin('error');setTimeout(()=>fin('timeout'),3000);document.body.appendChild(f)})`,
  );
  console.log("http://localhost iframe:", iframeTest.value);

  const inv = await Promise.race([
    evalJs(
      c,
      `window.__TAURI_INTERNALS__.invoke('browser_open', { browserId:'${BID}', url:'${TEST_URL}', bounds:{x:120,y:140,width:640,height:420} }).then(()=> 'OK').catch(e=> 'ERR:'+ (e?.message||e))`,
    ),
    new Promise((r) => setTimeout(() => r({ value: "TIMEOUT(no response in 10s)" }), 10000)),
  ]);
  console.log("browser_open result:", inv.value ?? inv.error);

  await new Promise((r) => setTimeout(r, 3500));

  const after = await targets();
  const child = after.find((t) => (t.url || "").includes("example.com"));
  console.log("child webview target present:", !!child, child ? `(${child.type} ${child.url})` : "");
  console.log("all targets after open:");
  for (const t of after) console.log("  -", t.type, t.title?.slice(0, 30), t.url);

  // 정리: 검증 webview 닫기
  await evalJs(c, `window.__TAURI_INTERNALS__.invoke('browser_close', { browserId:'${BID}' }).catch(()=>{})`);
  c.close();

  console.log(child ? "\nVERIFY: PASS (add_child rendered a live webview)" : "\nVERIFY: child not seen via CDP (webview may exist but not CDP-listed)");
  process.exit(0);
})().catch((e) => {
  console.log("FAIL:", e.message);
  process.exit(1);
});
