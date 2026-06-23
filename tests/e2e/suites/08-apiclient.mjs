// API 클라이언트(HTTP 엔진) — http_request(GET/POST), http_cancel, 스킴 차단.
// 외부 의존(postman-echo.com). 오프라인이면 네트워크 테스트는 SKIP 한다.
export const name = "API 클라이언트 (http_request / http_cancel)";

const decode = (b64) => Buffer.from(b64 || "", "base64").toString("utf8");

export async function run({ cdp, report: r }) {
  // ── file:// 차단은 네트워크 불필요 — 항상 검증 ──
  const fileScheme = await cdp.try("http_request", { requestId: "e2e-file", req: { method: "GET", url: "file:///C:/Windows/win.ini", query: [], headers: [], body: { kind: "none" } } }, { timeoutMs: 8000 });
  r.check("http_request: file:// 거부(INVALID_URL)", !fileScheme.ok && /invalid/i.test(fileScheme.code || ""), fileScheme.code || "(ok?)");

  // ── 연결성 프로브 ──
  const probe = await cdp.try("http_request", { requestId: "e2e-probe", req: { method: "GET", url: "https://postman-echo.com/get", query: [{ key: "hello", value: "world" }], headers: [{ name: "X-E2E", value: "42" }], body: { kind: "none" }, timeoutMs: 12000 } }, { timeoutMs: 20000 });
  if (!probe.ok) {
    r.skip("http_request 네트워크 테스트", `오프라인 추정 — ${probe.code || probe.message}`);
    return;
  }

  // ── GET: CORS-free 헤더/타이밍/쿼리 에코 ──
  const g = probe.r;
  const gBody = decode(g.body?.base64);
  const gHeaders = (g.headers || []).map((h) => h.name.toLowerCase());
  r.check("http_request GET: status 200", g.status === 200, `status=${g.status}`);
  r.check("http_request GET: 쿼리 hello=world 에코", /"hello"\s*:\s*"world"/.test(gBody));
  r.check("http_request GET: 커스텀 헤더 에코", /42/.test(gBody) && /x-e2e/i.test(gBody));
  r.check("http_request GET: forbidden 헤더(date) 노출", gHeaders.includes("date"), "(fetch 로는 못 봄 — 백엔드 엔진 증명)");
  r.check("http_request GET: timing.totalMs>0", (g.timing?.totalMs || 0) > 0, `${g.timing?.totalMs?.toFixed?.(1)}ms`);
  r.check("http_request GET: remoteAddr 채워짐", !!g.remoteAddr, g.remoteAddr || "");

  // ── POST JSON ──
  const post = await cdp.try("http_request", { requestId: "e2e-post", req: { method: "POST", url: "https://postman-echo.com/post", query: [], headers: [], body: { kind: "json", text: '{"name":"gitpervisor"}' } } }, { timeoutMs: 20000 });
  r.check("http_request POST: status 200", post.ok && post.r.status === 200, post.ok ? `status=${post.r.status}` : post.code);
  if (post.ok) {
    const pBody = decode(post.r.body?.base64);
    r.check("http_request POST: JSON 바디 에코", /"name"\s*:\s*"gitpervisor"/.test(pBody));
    r.check("http_request POST: Content-Type application/json 전송", /application\/json/i.test(pBody));
  }

  // ── 취소(inflight 중 http_cancel) ──
  const cancel = await cdp.eval(`(async()=>{
    const inv = window.__TAURI_INTERNALS__.invoke('http_request', { requestId:'e2e-cancel', req:{ method:'GET', url:'https://postman-echo.com/delay/5', query:[], headers:[], body:{kind:'none'} } })
      .then(()=>({ ok:true })).catch((e)=>({ ok:false, code:(e&&e.code)||null }));
    await new Promise(r=>setTimeout(r,500));
    await window.__TAURI_INTERNALS__.invoke('http_cancel', { requestId:'e2e-cancel' }).catch(()=>{});
    return await inv;
  })()`);
  r.check("http_cancel: 진행중 요청 취소(CANCELLED)", cancel && cancel.ok === false && /cancel/i.test(cancel.code || ""), cancel?.code || JSON.stringify(cancel));
}
