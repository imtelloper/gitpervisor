// 런타임 검증: 실행 중인 gitpervisor(디버그 CDP)에서 http_request/http_cancel 를 직접 invoke해
// API 클라이언트 백엔드 엔진(reqwest 0.13)과 serde 계약이 실제로 동작하는지 확인한다.
// 설계: DOCS/api-client-design.md §11.3. 외부 의존은 Postman 공개 에코 서버(postman-echo.com).
const PORT = process.argv[2] || "9222";
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
  if (r.result?.exceptionDetails) return { error: JSON.stringify(r.result.exceptionDetails) };
  return { value: r.result?.result?.value };
};

// 페이지 컨텍스트에서 http_request 호출 → HttpResponse(or 'ERR:code:msg') 반환.
const invokeHttp = (c, reqId, req) =>
  evalJs(
    c,
    `window.__TAURI_INTERNALS__.invoke('http_request',{requestId:${JSON.stringify(reqId)},req:${JSON.stringify(req)}})
       .then(r=>({ok:true,r})).catch(e=>({ok:false,code:e?.code,message:e?.message||String(e)}))`,
  );

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  cond ? pass++ : fail++;
};

(async () => {
  const list = await targets();
  const page = list.find((t) => t.type === "page" && /localhost:39090/.test(t.url || ""));
  if (!page) {
    console.log("FAIL: gitpervisor page target not found:", list.map((t) => t.url));
    process.exit(1);
  }
  const c = cdp(page.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  const bridge = await evalJs(c, "typeof window.__TAURI_INTERNALS__?.invoke");
  console.log("invoke bridge:", bridge.value, "\n");

  // ── T1: GET + 쿼리 + 커스텀 헤더 (CORS-free 원본 헤더·타이밍·remoteAddr 실증) ──
  console.log("[T1] GET postman-echo.com/get  (CORS-free 헤더·타이밍)");
  const t1 = await invokeHttp(c, "cdp-t1", {
    method: "GET",
    url: "https://postman-echo.com/get",
    query: [{ key: "hello", value: "world" }],
    headers: [{ name: "X-Cdp-Test", value: "42" }],
    body: { kind: "none" },
  });
  if (t1.value?.ok) {
    const r = t1.value.r;
    const bodyText = Buffer.from(r.body.base64, "base64").toString("utf8");
    const hnames = r.headers.map((h) => h.name.toLowerCase());
    check("status 200", r.status === 200, `status=${r.status}`);
    check("forbidden 헤더(date) 확보", hnames.includes("date"), "fetch로는 못 봄");
    check("content-type 헤더 확보", hnames.includes("content-type"));
    check("쿼리 hello=world 에코됨", /"hello"\s*:\s*"world"/.test(bodyText));
    check("커스텀 헤더 X-Cdp-Test 에코됨", /42/.test(bodyText) && /x-cdp-test/i.test(bodyText));
    check("timing.totalMs > 0", r.timing.totalMs > 0, `total=${r.timing.totalMs?.toFixed(1)}ms ttfb=${r.timing.ttfbMs?.toFixed(1)}ms`);
    check("remoteAddr 채워짐", !!r.remoteAddr, r.remoteAddr || "");
    check("body.size 일치", r.body.size > 0 && !r.body.truncated, `size=${r.body.size}`);
  } else {
    check("T1 요청 성공", false, `${t1.value?.code}:${t1.value?.message || t1.error}`);
  }

  // ── T2: POST JSON 바디 (바디 종류 + Content-Type 보충) ──
  console.log("\n[T2] POST postman-echo.com/post  (JSON 바디 에코)");
  const t2 = await invokeHttp(c, "cdp-t2", {
    method: "POST",
    url: "https://postman-echo.com/post",
    headers: [],
    body: { kind: "json", text: '{"a":1,"name":"gitpervisor"}' },
  });
  if (t2.value?.ok) {
    const r = t2.value.r;
    const bodyText = Buffer.from(r.body.base64, "base64").toString("utf8");
    check("status 200", r.status === 200, `status=${r.status}`);
    check("JSON 바디 에코됨", /"name"\s*:\s*"gitpervisor"/.test(bodyText));
    check("Content-Type application/json 전송됨", /application\/json/i.test(bodyText));
  } else {
    check("T2 요청 성공", false, `${t2.value?.code}:${t2.value?.message || t2.error}`);
  }

  // ── T3: 취소 (느린 응답을 inflight 중 http_cancel) ──
  console.log("\n[T3] 취소 — delay/5 요청을 0.4s 후 http_cancel");
  const t3 = await evalJs(
    c,
    `(async()=>{
       const p = window.__TAURI_INTERNALS__.invoke('http_request',{requestId:'cdp-cancel',req:{method:'GET',url:'https://postman-echo.com/delay/5',body:{kind:'none'}}})
                   .then(()=>({ok:true})).catch(e=>({ok:false,code:e?.code,message:e?.message}));
       await new Promise(r=>setTimeout(r,400));
       await window.__TAURI_INTERNALS__.invoke('http_cancel',{requestId:'cdp-cancel'}).catch(()=>{});
       return await p;
     })()`,
  );
  check("취소되어 CANCELLED 에러 반환", t3.value && t3.value.ok === false && /cancel/i.test(t3.value.code || ""), `${t3.value?.code}:${t3.value?.message}`);

  // ── T4: scheme allowlist (file:// 거부) ──
  console.log("\n[T4] scheme 차단 — file:// 거부");
  const t4 = await invokeHttp(c, "cdp-t4", { method: "GET", url: "file:///C:/Windows/win.ini", body: { kind: "none" } });
  check("file:// 거부됨(INVALID_URL)", t4.value && t4.value.ok === false && /invalid/i.test(t4.value.code || ""), `${t4.value?.code}:${t4.value?.message}`);

  // ── T5: 연결 거부 분류 ──
  console.log("\n[T5] 에러 분류 — 127.0.0.1:1 연결 거부");
  const t5 = await invokeHttp(c, "cdp-t5", { method: "GET", url: "http://127.0.0.1:1/", body: { kind: "none" }, timeoutMs: 4000 });
  check("연결거부로 분류", t5.value && t5.value.ok === false && /refused/i.test(t5.value.code || ""), `${t5.value?.code}:${t5.value?.message}`);

  // ── T6/T7: verifyTls 토글 (자가서명 인증서) ──
  console.log("\n[T6/T7] verifyTls 토글 — self-signed.badssl.com");
  const vtOn = await invokeHttp(c, "cdp-t6", { method: "GET", url: "https://self-signed.badssl.com/", body: { kind: "none" }, verifyTls: true, timeoutMs: 12000 });
  check("verifyTls=true → TLS_ERROR", vtOn.value && vtOn.value.ok === false && /tls/i.test(vtOn.value.code || ""), `${vtOn.value?.code}`);
  const vtOff = await invokeHttp(c, "cdp-t7", { method: "GET", url: "https://self-signed.badssl.com/", body: { kind: "none" }, verifyTls: false, timeoutMs: 12000 });
  check("verifyTls=false → 200 통과", vtOff.value?.ok === true && vtOff.value?.r?.status === 200, `status=${vtOff.value?.r?.status}`);

  c.close();
  console.log(`\n===== 결과: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FAIL:", e.message);
  process.exit(1);
});
