// 초경량 테스트 리포터 — suite/check/skip/info 누적 + 컬러 콘솔 + 최종 요약/종료코드.
// 외부 의존 없음(러너 의존성 0 — node 만으로 실행).

const C = process.stdout.isTTY
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", b: "", c: "", x: "" };

export function createReport() {
  const suites = [];
  let cur = null;

  function suite(title) {
    // 직전 스위트의 경과를 닫는다 — 어느 스위트가 전체 시간을 먹는지 모르면 "e2e가 느리다"를
    // 추측으로밖에 못 고친다(정적으로 세면 poll 상한만 1990s라 쓸모가 없다).
    if (cur) cur.ms = Date.now() - cur.startedAt;
    cur = { title, checks: [], startedAt: Date.now(), ms: 0 };
    suites.push(cur);
    console.log(`\n${C.b}${C.c}▶ ${title}${C.x}`);
    return cur;
  }

  function record(status, name, detail) {
    if (!cur) suite("(unnamed)");
    cur.checks.push({ status, name, detail });
    const icon =
      status === "pass" ? `${C.g}✅ PASS${C.x}` : status === "fail" ? `${C.r}❌ FAIL${C.x}` : `${C.y}⊘ SKIP${C.x}`;
    console.log(`  ${icon}  ${name}${detail ? `  ${C.d}— ${detail}${C.x}` : ""}`);
  }

  function check(name, cond, detail) {
    record(cond ? "pass" : "fail", name, detail);
    return !!cond;
  }
  function skip(name, reason) {
    record("skip", name, reason);
  }
  function info(msg) {
    console.log(`  ${C.d}ℹ ${msg}${C.x}`);
  }

  function counts() {
    let pass = 0,
      fail = 0,
      skip = 0;
    for (const s of suites)
      for (const c of s.checks) {
        if (c.status === "pass") pass++;
        else if (c.status === "fail") fail++;
        else skip++;
      }
    return { pass, fail, skip };
  }

  function summary() {
    if (cur) cur.ms = Date.now() - cur.startedAt; // 마지막 스위트도 닫아 준다
    const { pass, fail, skip } = counts();
    console.log(`\n${C.b}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.x}`);
    for (const s of suites) {
      const f = s.checks.filter((c) => c.status === "fail").length;
      const p = s.checks.filter((c) => c.status === "pass").length;
      const k = s.checks.filter((c) => c.status === "skip").length;
      const mark = f ? `${C.r}✗${C.x}` : `${C.g}✓${C.x}`;
      console.log(
        `  ${mark} ${s.title}  ${C.d}(${p} pass${f ? `, ${C.r}${f} fail${C.d}` : ""}${k ? `, ${k} skip` : ""})` +
          ` · ${(s.ms / 1000).toFixed(1)}s${C.x}`,
      );
      if (f)
        for (const c of s.checks.filter((c) => c.status === "fail"))
          console.log(`      ${C.r}↳ ${c.name}${c.detail ? ` — ${c.detail}` : ""}${C.x}`);
    }
    const verdict = fail === 0 ? `${C.g}${C.b}ALL GREEN${C.x}` : `${C.r}${C.b}${fail} FAILED${C.x}`;
    const total = suites.reduce((a, s) => a + s.ms, 0);
    // **느린 순 상위만** 찍는다 — 55줄을 다 보면 어차피 안 본다. 전체 시간을 줄이려면
    // 병렬화보다 여기 윗줄 서넛을 먼저 보는 게 거의 항상 싸다(상위가 심하게 치우쳐 있다).
    const slow = suites
      .filter((s) => s.ms > 0)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
    if (slow.length) {
      console.log(`${C.b}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.x}`);
      console.log(`  ${C.d}느린 스위트 (전체 ${(total / 1000).toFixed(0)}s)${C.x}`);
      for (const s of slow)
        console.log(
          `    ${C.d}${((s.ms / total) * 100).toFixed(0).padStart(3)}%  ${(s.ms / 1000)
            .toFixed(1)
            .padStart(7)}s  ${s.title}${C.x}`,
        );
    }
    console.log(
      `${C.b}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.x}\n` +
        `  ${verdict}   ${C.g}${pass} pass${C.x} / ${C.r}${fail} fail${C.x} / ${C.y}${skip} skip${C.x}` +
        `   ${C.d}${(total / 1000).toFixed(0)}s${C.x}\n`,
    );
    return { pass, fail, skip };
  }

  return { suite, check, skip, info, summary, counts };
}
