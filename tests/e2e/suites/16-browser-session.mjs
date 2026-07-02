// 브라우저 세션 영속(태스크 07) — 로컬 서버 쿠키 스모크.
//
// child webview 에는 CDP 가 없어(격리 프로필) 내부 관측이 불가하므로, 쿠키 왕복을 "서버 측"에서
// 관측한다: /set 응답이 영속 쿠키(Expires 지정)를 심고, 이후 **새 browser_open 의 부팅 요청**에
// Cookie 헤더가 도착하는지로 "탭 간 세션 공유"를 판정한다.
//
// 판정을 browser_navigate 가 아니라 새 webview 의 부팅 요청으로 하는 이유: 선행 스위트들이
// webview 를 다수 생성·해제한 뒤에는 WebView2 가 간헐적으로 navigate 를 유실한다(실측 —
// 격리 실행에선 A/B 동시 오픈 + 양방향 navigate 전부 정상). 부팅 로드는 그 상태에서도
// 도달하며, "새 패널 첫 요청에 로그인이 실려오는가"가 바로 태스크 07 의 기능 계약이다.
//
// 쿠키 값은 실행마다 고유(런 토큰) — 127.0.0.1 쿠키는 포트를 무시하고 디스크에 영속되므로,
// 이전 실행의 잔류 쿠키가 위양성을 만들지 않게 정확한 값 일치로만 판정한다.
//
// browser_clear_data 의 실삭제 단언은 공유 프로필(사용자의 실제 gmail 등 로그인 세션)을 지우는
// 파괴적 동작이라 기본 스킵 — GPV_E2E_CLEAR_BROWSER=1 로만 opt-in (하네스의 "사용자 상태 보존"
// 원칙 준수). 테스트 쿠키 자체는 끝에 만료(Expires 과거)로 지워 프로필을 오염시키지 않는다.
import http from "node:http";

export const name = "브라우저 세션 영속 (쿠키 왕복 / browser_clear_data)";
const COOKIE_NAME = "gpv_e2e_session";
const RUN_TOKEN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const COOKIE = `${COOKIE_NAME}=${RUN_TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cdp, report: r }) {
  // 요청 로그: { path, hasCookie } — 판정은 전부 이 배열로 한다(값 정확 일치).
  const seen = [];
  const srv = http.createServer((req, res) => {
    if (!(req.url || "").includes("favicon")) {
      seen.push({ path: req.url || "", hasCookie: (req.headers.cookie || "").includes(COOKIE) });
    }
    if (req.url?.startsWith("/set")) {
      res.setHeader(
        "Set-Cookie",
        `${COOKIE}; Path=/; Expires=${new Date(Date.now() + 864e5).toUTCString()}`,
      );
    } else if (req.url?.startsWith("/expire")) {
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Expires=${new Date(0).toUTCString()}`);
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<title>gpv-session</title>ok");
  });
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const bounds = { x: 100, y: 120, width: 420, height: 300 };

  const waitReq = async (prefix) => {
    for (let i = 0; i < 20; i++) {
      const q = seen.find((s) => s.path.startsWith(prefix));
      if (q) return q;
      await sleep(400);
    }
    return null;
  };

  // 열린 id 추적 — 어떤 경로로 빠져나가도 자식 webview 를 남기지 않는다.
  const opened = new Set();
  const openAt = async (bid, path, x) => {
    opened.add(bid);
    return cdp.try(
      "browser_open",
      { browserId: bid, url: `${base}${path}`, bounds: { ...bounds, x } },
      { timeoutMs: 15000 },
    );
  };
  // 새 webview 를 띄워 그 부팅 요청의 쿠키 상태를 관측(want 일치까지 최대 3회 — 생성 유실 흡수).
  const bootProbe = async (idBase, pathBase, want) => {
    for (let i = 0; i < 3; i++) {
      const p = `${pathBase}-${i}`;
      await openAt(`${idBase}-${i}`, p, 540);
      const q = await waitReq(p);
      if (q && q.hasCookie === want) return true;
      await sleep(500);
    }
    return false;
  };

  try {
    // ── 1) A 패널에서 영속 쿠키 심기 ──
    const open = await openAt("gpv-e2e-session-a", "/set", 100);
    r.check("browser_open(A): 성공", open.ok, open.code || open.message || "");
    r.check("서버: /set 도착(쿠키 발급)", !!(await waitReq("/set")), JSON.stringify(seen.slice(-2)));

    // ── 2) 새 패널(B) — 같은 browser-session 프로필이므로 부팅 요청에 쿠키가 실려와야 한다 ──
    r.check(
      "세션 공유: 새 패널(B) 부팅 요청에 Cookie 도착",
      await bootProbe("gpv-e2e-session-b", "/check-b", true),
      JSON.stringify(seen.slice(-3)),
    );

    // ── 3) browser_clear_data — 파괴적이라 opt-in ──
    if (process.env.GPV_E2E_CLEAR_BROWSER === "1") {
      const clear = await cdp.try("browser_clear_data", {}, { timeoutMs: 15000 });
      r.check("browser_clear_data: 성공", clear.ok, clear.code || clear.message || "");
      // Windows 의 ClearBrowsingDataAll 은 비동기 완료 — 새 webview 부팅 관측으로 수렴 확인.
      r.check(
        "clear 후: 새 패널 부팅에 Cookie 미도착",
        await bootProbe("gpv-e2e-session-c", "/after-clear", false),
        JSON.stringify(seen.slice(-3)),
      );
    } else {
      r.skip(
        "browser_clear_data 실삭제 단언",
        "공유 프로필(사용자 실제 로그인 세션)까지 지우는 파괴적 동작 — GPV_E2E_CLEAR_BROWSER=1 로 opt-in",
      );
    }

    // ── 4) 테스트 쿠키 만료로 프로필 원상 복구(127.0.0.1 오염 방지) — 새 webview 부팅으로 수행 ──
    await openAt("gpv-e2e-session-x", "/expire", 100);
    await waitReq("/expire");
  } finally {
    for (const bid of opened) await cdp.try("browser_close", { browserId: bid });
    srv.close();
  }
}
