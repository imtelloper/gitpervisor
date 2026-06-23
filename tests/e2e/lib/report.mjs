// 초경량 테스트 리포터 — suite/check/skip/info 누적 + 컬러 콘솔 + 최종 요약/종료코드.
// 외부 의존 없음(러너 의존성 0 — node 만으로 실행).

const C = process.stdout.isTTY
  ? { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" }
  : { g: "", r: "", y: "", d: "", b: "", c: "", x: "" };

export function createReport() {
  const suites = [];
  let cur = null;

  function suite(title) {
    cur = { title, checks: [] };
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
    const { pass, fail, skip } = counts();
    console.log(`\n${C.b}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.x}`);
    for (const s of suites) {
      const f = s.checks.filter((c) => c.status === "fail").length;
      const p = s.checks.filter((c) => c.status === "pass").length;
      const k = s.checks.filter((c) => c.status === "skip").length;
      const mark = f ? `${C.r}✗${C.x}` : `${C.g}✓${C.x}`;
      console.log(
        `  ${mark} ${s.title}  ${C.d}(${p} pass${f ? `, ${C.r}${f} fail${C.d}` : ""}${k ? `, ${k} skip` : ""})${C.x}`,
      );
      if (f)
        for (const c of s.checks.filter((c) => c.status === "fail"))
          console.log(`      ${C.r}↳ ${c.name}${c.detail ? ` — ${c.detail}` : ""}${C.x}`);
    }
    const verdict = fail === 0 ? `${C.g}${C.b}ALL GREEN${C.x}` : `${C.r}${C.b}${fail} FAILED${C.x}`;
    console.log(
      `${C.b}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.x}\n` +
        `  ${verdict}   ${C.g}${pass} pass${C.x} / ${C.r}${fail} fail${C.x} / ${C.y}${skip} skip${C.x}\n`,
    );
    return { pass, fail, skip };
  }

  return { suite, check, skip, info, summary, counts };
}
