// git 변경·로그 경로 벤치 (품질 배치 설계 D장 0단계).
//
// 실행 중인 **디버그 빌드**에 CDP 로 붙어 `get_statuses`·`get_log`·`get_branches`·`get_commit_detail`
// 만 구동한다. UI 는 건드리지 않는다 — 사용자의 프로젝트 목록을 그대로 읽어 재고, 아무것도 안 바꾼다.
//
//   사용법:  node tests/bench/git-speed.mjs                 (앱이 떠 있어야 함)
//            GPV_E2E_PORT=29223 node tests/bench/git-speed.mjs
//            GPV_BENCH_N=5 node tests/bench/git-speed.mjs    (회차 수, 기본 10)
//
// 재는 것:
//   a) get_statuses 전체 배치 — p50/p90/max
//   b) get_statuses 프로젝트 1개 — p50/p90 (배치가 선형인지, 고정비가 지배하는지)
//   c) get_log 첫 페이지(200) — p50/p90
//   d) get_branches — p50/p90
//   e) get_commit_detail 1건 — p50/p90
//
// **측정 루프는 페이지 안에서 돈다** — CDP 왕복(≈3ms)이 섞이지 않게(터미널 벤치와 같은 이유).
// 워밍업 1회를 버리고 재며, 회차 사이 200ms 를 쉰다. 앱의 워처·배경 fetch 가 도는 중이면
// 편차가 커지므로 조용할 때 재라(설정 › 원격 갱신 주기를 0으로 두면 더 안정적이다).
//
// Rust 쪽 분해는 `GPV_GIT_TIMING=1` 로 앱을 띄우면 `[git] <ms> <args>` 로그가 남는다 —
// "어느 하위 명령이 느린가"는 그쪽을, "사용자가 몇 초 기다리나"는 이 벤치를 본다.
import { connect } from "../e2e/lib/cdp.mjs";

const N = Number(process.env.GPV_BENCH_N || 10);
const J = JSON.stringify;

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]) : 0;
};
const row = (name, xs, extra = "") =>
  console.log(
    `  ${name.padEnd(34)} p50 ${String(pct(xs, 0.5)).padStart(6)}ms   p90 ${String(pct(xs, 0.9)).padStart(6)}ms   max ${String(Math.round(Math.max(...xs))).padStart(6)}ms  ${extra}`,
  );

/** 페이지 안에서 invoke 를 N회 돌려 각 회차 ms 를 돌려준다(워밍업 1회 제외). */
const bench = (cdp, cmd, args, n = N) =>
  cdp.eval(
    `(async () => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const args = ${J(args)};
      await inv(${J(cmd)}, args).catch(() => null);          // 워밍업(캐시·콜드 스폰 제거)
      const out = [];
      for (let i = 0; i < ${n}; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const t = performance.now();
        try { await inv(${J(cmd)}, args); } catch (e) { out.push(-1); continue; }
        out.push(performance.now() - t);
      }
      return out;
    })()`,
    { timeoutMs: 15 * 60 * 1000 },
  );

const cdp = await connect({ port: Number(process.env.GPV_E2E_PORT) || undefined });
try {
  const projects = await cdp.invoke("list_projects", {}, { timeoutMs: 30000 });
  const ids = projects.map((p) => p.id);
  if (!ids.length) {
    console.log("등록된 프로젝트가 없다 — 잴 것이 없다.");
    process.exit(0);
  }
  console.log(`\ngit 속도 벤치 — 프로젝트 ${ids.length}개 · 회차 ${N} (워밍업 1회 제외)\n`);

  row(`a) get_statuses 전체(${ids.length}개)`, await bench(cdp, "get_statuses", { projectIds: ids }));
  row("b) get_statuses 1개", await bench(cdp, "get_statuses", { projectIds: ids.slice(0, 1) }));

  const pid = ids[0];
  row("c) get_log 첫 페이지(200)", await bench(cdp, "get_log", { projectId: pid, limit: 200, skip: 0 }));
  row("d) get_branches", await bench(cdp, "get_branches", { projectId: pid }));

  const log = await cdp.invoke("get_log", { projectId: pid, limit: 1, skip: 0 }, { timeoutMs: 30000 });
  const sha = log?.[0]?.sha;
  if (sha) row("e) get_commit_detail 1건", await bench(cdp, "get_commit_detail", { projectId: pid, sha }));
  else console.log("  e) get_commit_detail — 커밋이 없어 건너뜀");

  console.log(
    `\n  (−1 이 섞여 있으면 그 회차는 실패다. 목표치는 DOCS/quality-batch-2026-09-design.md D.3)\n`,
  );
} finally {
  cdp.close();
  setTimeout(() => process.exit(0), 100);
}
