// 임베디드 브라우저(네이티브 자식 webview) — open/navigate/back/forward/reload/stop/
// set_bounds/set_visible/focus/blur/close/scan_dev_ports.
//
// 주의: 자식 webview 는 보안상 별도 data_directory(쿠키/세션 격리)로 떠서 메인 CDP 엔드포인트에
// 타겟으로 안 잡힐 수 있다 → 존재는 browser_open 성공으로 판정하고 CDP 타겟은 참고(info)만 한다.
// scan_dev_ports 는 백엔드가 IPv4 127.0.0.1 로 접속하므로(앱 vite 는 ::1 바인딩) 테스트용 IPv4
// 서버를 직접 띄워 "리스닝 포트 탐지"를 결정적으로 검증한다.
import net from "node:net";

export const name = "임베디드 브라우저 (browser_open / navigate / scan_dev_ports / close)";
const BID = "gpv-e2e-browser";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetSeen(port, needle) {
  for (let i = 0; i < 8; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) })).json();
      if (list.some((t) => (t.url || "").includes(needle))) return true;
    } catch (_) {
      /* retry */
    }
    await sleep(400);
  }
  return false;
}

export async function run({ cdp, report: r, port }) {
  try {
  const bounds = { x: 120, y: 140, width: 480, height: 320 };

  // ── open (네이티브 add_child) ──
  const open = await cdp.try("browser_open", { browserId: BID, url: "https://example.com/", bounds }, { timeoutMs: 15000 });
  r.check("browser_open: 자식 webview 생성 성공", open.ok, open.code || open.message || "");
  if (await targetSeen(port, "example.com")) r.info("자식 webview 가 CDP 타겟으로도 확인됨");
  else r.info("자식 webview 는 data_directory 격리로 CDP 미노출 — browser_open 성공으로 생성 확인");

  // ── navigate + 제어 커맨드들(예외 없이 Ok 면 통과) ──
  const nav = await cdp.try("browser_navigate", { browserId: BID, url: "https://example.org/" });
  r.check("browser_navigate: 성공", nav.ok, nav.code || "");
  for (const cmd of ["browser_reload", "browser_back", "browser_forward", "browser_stop", "browser_focus"]) {
    const res = await cdp.try(cmd, { browserId: BID });
    r.check(`${cmd}: 성공`, res.ok, res.code || "");
  }
  const sb = await cdp.try("browser_set_bounds", { browserId: BID, bounds: { x: 130, y: 150, width: 500, height: 340 } });
  r.check("browser_set_bounds: 성공", sb.ok, sb.code || "");
  const hide = await cdp.try("browser_set_visible", { browserId: BID, visible: false, bounds: null });
  const show = await cdp.try("browser_set_visible", { browserId: BID, visible: true, bounds });
  r.check("browser_set_visible: hide/show 성공", hide.ok && show.ok, `${hide.code || ""}${show.code || ""}`);
  const blur = await cdp.try("browser_blur");
  r.check("browser_blur: 메인 포커스 환원 성공", blur.ok, blur.code || "");

  // ── scan_dev_ports: 테스트용 IPv4 서버를 띄워 결정적으로 탐지 검증 ──
  const srv = net.createServer(() => {});
  await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const livePort = srv.address().port;
  const scan = await cdp.try("browser_scan_dev_ports", { ports: [livePort, 1] }, { timeoutMs: 8000 });
  srv.close();
  r.check(`browser_scan_dev_ports: 리스닝 포트 탐지(${livePort})`, scan.ok && Array.isArray(scan.r) && scan.r.includes(livePort) && !scan.r.includes(1), JSON.stringify(scan.r));

  // ── close ──
  const close = await cdp.try("browser_close", { browserId: BID });
  r.check("browser_close: 성공", close.ok, close.code || "");
  } finally {
    // 스위트가 도중에 throw 해도 자식 webview 를 남기지 않는다(멱등).
    await cdp.try("browser_close", { browserId: BID });
  }
}
