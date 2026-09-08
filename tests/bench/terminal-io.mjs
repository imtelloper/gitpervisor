// 터미널 입출력 전송로 벤치 (태스크 63 §5.1).
//
// 실행 중인 **디버그 빌드**에 CDP 로 붙어 `term_open`/`term_write`/`term_close` 만 구동한다.
// UI 는 건드리지 않는다 — 프로브 터미널은 프론트 스토어에 등록하지 않으므로 화면에 뜨지 않고,
// 끝에 전부 `term_close` 로 회수한다.
//
//   사용법:  node tests/bench/terminal-io.mjs        (앱이 'npm run dev:app' 으로 떠 있어야 함)
//            GPV_E2E_PORT=29222 node tests/bench/terminal-io.mjs
//
// 재는 것(설계 §2 와 같은 항목):
//   a) 조용할 때 term_write 직렬 60키 왕복 p50/p90/max, 지속 키/초
//   b) 옆 터미널이 쏟아내는 동안 같은 60키
//   c) 3MB 일괄 출력의 채널 메시지 수·총 바이트·청크 p50·KB/s·메시지/초
//   d) 터미널 3개 동시 출력의 총 처리량 (c 와 비교 — 줄어들면 공유 병목)
//
// **측정 루프는 전부 페이지 안에서 돈다.** CDP 왕복(수 ms)이 재려는 값과 같은 크기라
// 러너에서 키를 하나씩 보내면 그 오버헤드가 결과를 통째로 덮는다.
import { connect } from "../e2e/lib/cdp.mjs";

const KEYS = 60;
// 프롬프트가 비어 있을 때의 Backspace — ConPTY 로 실제 바이트가 나가지만 셸이 아무 것도
// 출력하지 않는다. 화면을 더럽히지 않으면서 "진짜 키 한 벌"의 왕복을 잰다.
const KEY = "\x7f";
// pwsh 로 약 3MB 를 한 번에 쏟아낸다(1000자 × 3000줄).
const BURST_3MB = "1..3000 | %{ 'x' * 1000 }\r";
// (b) 의 배경 소음 — 60키를 재는 내내 출력이 끊기지 않도록 3배로 잡는다.
const BURST_NOISE = "1..9000 | %{ 'x' * 1000 }\r";
const COLS = 120;
const ROWS = 40;

// 페이지 안에 설치하는 계측 헬퍼. Channel 은 `transformCallback` + `__CHANNEL__:<id>` 로
// 직접 만든다(프론트 코드 경로를 타지 않기 위해). Raw 경로의 payload 는 ArrayBuffer,
// JSON 경로는 숫자 배열이라 양쪽 길이를 모두 읽는다.
const INSTALL = `(() => {
  const T = window.__TAURI_INTERNALS__;
  const B = (window.__gpvBench = { T, stats: {} });
  B.chan = (id) => {
    const s = (B.stats[id] = { msgs: 0, bytes: 0, sizes: [], first: 0, last: 0 });
    const cb = T.transformCallback((raw) => {
      const m = raw && raw.message;
      if (m == null) return;                 // {end:true} — 채널 종료 알림
      const n = m.byteLength !== undefined ? m.byteLength : m.length;
      const now = performance.now();
      if (!s.first) s.first = now;
      s.last = now;
      s.msgs++; s.bytes += n; s.sizes.push(n);
    });
    return "__CHANNEL__:" + cb;
  };
  B.reset = (ids) => ids.forEach((id) => {
    const s = B.stats[id];
    s.msgs = 0; s.bytes = 0; s.sizes = []; s.first = 0; s.last = 0;
  });
  const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : 0);
  B.pct = pct;
  B.summary = (ids) => {
    const st = ids.map((id) => B.stats[id]);
    const first = Math.min(...st.map((s) => s.first || Infinity));
    const last = Math.max(...st.map((s) => s.last || 0));
    const ms = last > first ? last - first : 0;
    const bytes = st.reduce((a, s) => a + s.bytes, 0);
    const msgs = st.reduce((a, s) => a + s.msgs, 0);
    const sizes = st.flatMap((s) => s.sizes);
    return { msgs, bytes, ms, chunkP50: pct(sizes, 0.5), chunkMax: pct(sizes, 1) };
  };
  // 출력이 멎을 때까지 기다린다(quietMs 동안 새 바이트 없음). 상한을 넘기면 그냥 돌아온다.
  B.settle = async (ids, quietMs, maxMs) => {
    const t0 = performance.now();
    let seen = -1, quietFrom = performance.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const total = ids.reduce((a, id) => a + B.stats[id].bytes, 0);
      if (total !== seen) { seen = total; quietFrom = performance.now(); }
      else if (performance.now() - quietFrom >= quietMs) return true;
      if (performance.now() - t0 > maxMs) return false;
    }
  };
  // 직렬 왕복 — ptyWrite 의 체인과 같은 모양(이전 응답을 기다린 뒤 다음 키).
  B.keys = async (id, n, data) => {
    const lat = [];
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const k = performance.now();
      try { await T.invoke("term_write", { termId: id, data }); } catch (_) { /* 세션 없음 등 */ }
      lat.push(performance.now() - k);
    }
    return { p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: pct(lat, 1), perSec: (n * 1000) / (performance.now() - t0) };
  };
  return true;
})()`;

const f1 = (n) => n.toFixed(1);
const f0 = (n) => Math.round(n).toLocaleString("en-US");

async function main() {
  const cdp = await connect();
  console.log(`연결됨: ${cdp.pageUrl}  (CDP ${cdp.cdpPort})\n`);

  const projectId = await cdp.eval(
    `window.__gpv?.terminals?.getState().terminals[0]?.projectId ?? null`,
  );
  if (!projectId) throw new Error("열린 터미널이 없어 projectId 를 얻지 못했습니다 — 앱에서 터미널을 하나 여세요.");

  await cdp.eval(INSTALL);
  const ids = ["gpv-bench-0", "gpv-bench-1", "gpv-bench-2"];

  try {
    // ── 프로브 터미널 3개 기동 (pwsh 는 첫 프롬프트까지 ~6.5초) ──
    console.log(`프로브 터미널 ${ids.length}개 여는 중... (projectId ${projectId})`);
    await cdp.eval(
      `(async () => {
         const B = window.__gpvBench;
         await Promise.all(${JSON.stringify(ids)}.map((id) =>
           B.T.invoke("term_open", { termId: id, projectId: ${JSON.stringify(projectId)},
                                     cols: ${COLS}, rows: ${ROWS}, onData: B.chan(id) })));
         await new Promise((r) => setTimeout(r, 9000));   // 셸 기동 여유
         await B.settle(${JSON.stringify(ids)}, 1500, 20000);
         B.reset(${JSON.stringify(ids)});
         return true;
       })()`,
      { timeoutMs: 90000 },
    );

    // ── a) 조용할 때 키 왕복 ──
    const quiet = await cdp.eval(
      `window.__gpvBench.keys(${JSON.stringify(ids[0])}, ${KEYS}, ${JSON.stringify(KEY)})`,
      { timeoutMs: 120000 },
    );

    // ── b) 옆 터미널이 출력하는 동안 같은 키 ──
    const noisy = await cdp.eval(
      `(async () => {
         const B = window.__gpvBench;
         B.reset([${JSON.stringify(ids[1])}]);
         B.T.invoke("term_write", { termId: ${JSON.stringify(ids[1])}, data: ${JSON.stringify(BURST_NOISE)} });
         await new Promise((r) => setTimeout(r, 400));    // 출력이 실제로 흐르기 시작할 때까지
         const r = await B.keys(${JSON.stringify(ids[0])}, ${KEYS}, ${JSON.stringify(KEY)});
         const flowed = B.stats[${JSON.stringify(ids[1])}].bytes;
         await B.settle([${JSON.stringify(ids[1])}], 1500, 120000);
         return { ...r, flowed };
       })()`,
      { timeoutMs: 180000 },
    );

    // ── c) 3MB 일괄 출력(터미널 1개) ──
    const one = await cdp.eval(
      `(async () => {
         const B = window.__gpvBench;
         B.reset([${JSON.stringify(ids[1])}]);
         B.T.invoke("term_write", { termId: ${JSON.stringify(ids[1])}, data: ${JSON.stringify(BURST_3MB)} });
         await B.settle([${JSON.stringify(ids[1])}], 1500, 120000);
         return B.summary([${JSON.stringify(ids[1])}]);
       })()`,
      { timeoutMs: 180000 },
    );

    // ── d) 터미널 3개 동시 출력 ──
    const three = await cdp.eval(
      `(async () => {
         const B = window.__gpvBench;
         const ids = ${JSON.stringify(ids)};
         B.reset(ids);
         ids.forEach((id) => B.T.invoke("term_write", { termId: id, data: ${JSON.stringify(BURST_3MB)} }));
         await B.settle(ids, 1500, 180000);
         return B.summary(ids);
       })()`,
      { timeoutMs: 240000 },
    );

    const kbs = (s) => (s.ms ? s.bytes / 1024 / (s.ms / 1000) : 0);
    const mps = (s) => (s.ms ? (s.msgs * 1000) / s.ms : 0);

    console.log("\n== a/b) term_write 직렬 " + KEYS + "키 왕복 ==");
    console.log("            조용할 때    출력 중");
    console.log(`  p50       ${f1(quiet.p50).padStart(8)} ms ${f1(noisy.p50).padStart(9)} ms`);
    console.log(`  p90       ${f1(quiet.p90).padStart(8)} ms ${f1(noisy.p90).padStart(9)} ms`);
    console.log(`  max       ${f1(quiet.max).padStart(8)} ms ${f1(noisy.max).padStart(9)} ms`);
    console.log(`  키/초     ${f0(quiet.perSec).padStart(8)}    ${f0(noisy.perSec).padStart(9)}`);
    console.log(`  (측정 중 옆 터미널이 흘린 바이트: ${f0(noisy.flowed)})`);

    console.log("\n== c/d) 출력 전송로 처리량 ==");
    console.log("                     메시지      바이트   청크p50   청크max     KB/s   메시지/초");
    for (const [label, s] of [["1 터미널, 3MB", one], ["3 터미널 동시", three]]) {
      console.log(
        `  ${label.padEnd(16)}${f0(s.msgs).padStart(8)}${f0(s.bytes).padStart(12)}` +
          `${f0(s.chunkP50).padStart(10)}${f0(s.chunkMax).padStart(10)}${f0(kbs(s)).padStart(9)}${f0(mps(s)).padStart(12)}`,
      );
    }

    console.log("\n== 합격선(설계 §5.2) ==");
    const pass = (ok) => (ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m");
    console.log(`  ${pass(noisy.p90 <= 15)}  출력 중 키 p90 ≤ 15 ms        (실측 ${f1(noisy.p90)})`);
    console.log(`  ${pass(noisy.max <= 100)}  출력 중 키 max ≤ 100 ms       (실측 ${f1(noisy.max)})`);
    console.log(`  ${pass(noisy.perSec >= 120)}  출력 중 지속 ≥ 120 키/초      (실측 ${f0(noisy.perSec)})`);
    console.log(`  ${pass(one.msgs <= 400)}  3MB 출력 메시지 ≤ 400         (실측 ${f0(one.msgs)})`);
    console.log(`  ${pass(kbs(three) >= kbs(one))}  3터미널 총 처리량 ≥ 1터미널   (${f0(kbs(three))} vs ${f0(kbs(one))} KB/s)`);
  } finally {
    // **프로브는 반드시 회수한다.** 남으면 사용자 앱에 보이지 않는 pwsh 가 계속 산다.
    const closed = await cdp.eval(
      `(async () => {
         const T = window.__TAURI_INTERNALS__;
         const ids = ${JSON.stringify(ids)};
         await Promise.all(ids.map((id) => T.invoke("term_close", { termId: id }).catch(() => {})));
         await new Promise((r) => setTimeout(r, 500));
         const left = await Promise.all(ids.map((id) => T.invoke("term_project", { termId: id }).catch(() => null)));
         return left.filter(Boolean).length;
       })()`,
      { timeoutMs: 60000 },
    );
    console.log(`\n프로브 정리: ${ids.length}개 term_close, 잔존 세션 ${closed}개`);
    cdp.close();
  }
}

main().catch((e) => {
  console.error(`\n\x1b[31m벤치 실패:\x1b[0m ${e.message}\n`);
  process.exit(1);
});
