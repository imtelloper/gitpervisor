// e2e 병렬 실행 드라이버 — 앱 인스턴스 N개를 띄우고 스위트를 N등분해 동시에 돌린다.
//
//   사용법:  node tests/e2e/shard.mjs           (기본 4샤드)
//            node tests/e2e/shard.mjs 6         (6샤드)
//            GPV_E2E_KEEP=1 node tests/e2e/shard.mjs   (끝나고 앱·데이터를 남긴다 — 디버깅용)
//
// ## ⚠ 지금은 샤드 1개까지만 뜬다 — 앱 쪽에 벽이 하나 남았다
//
// 2개째부터 웹뷰 생성이 실패한다:
//
//     failed to create webview: WebView2 error: HRESULT(0x8007139F)
//     "그룹 또는 리소스가 요청된 작업을 실행할 올바른 상태에 있지 않습니다"   ← ERROR_INVALID_STATE
//
// 원인은 **WebView2 유저데이터 폴더도 `identifier` 에서 파생된다**는 것이다
// (`tauri-2.11.2/src/manager/webview.rs:534`). 인스턴스마다 `--remote-debugging-port` 가 다른데
// 폴더는 하나라, WebView2 가 "같은 폴더에 다른 환경 옵션"을 거부한다. CLAUDE.md 가
// "같은 user-data 폴더를 공유하는 웹뷰는 환경 인자가 일치하지 않으면 초기화에 실패한다"고
// 적어 둔 그 함정이다. **다른 `.dev` 앱(다른 워크트리의 dev 앱 포함)이 떠 있어도 같은 이유로 막힌다.**
//
// 풀 방법은 있다. 같은 파일 바로 위가 이렇게 말한다:
//
//     // in `windows`, we need to force a data_directory
//     // but we do respect user-specification
//     if pending.webview_attributes.data_directory.is_none() { … }
//
// 즉 **앱이 `data_directory` 를 지정하면 Tauri 는 건드리지 않는다.** 메인 창은
// `tauri.conf.json` 이 만들므로 `lib.rs` 에서 창 생성 경로에 dev 전용 오버라이드를 넣어야 한다
// (`GPV_DATA_DIR` 과 같은 패턴). 그건 **제품 코드 변경**이라 사용자 승인 후에 한다.
// 덤으로 전역 단축키도 프로세스 간 공유라 `HotKey already registered` 가 뜬다(치명적이진 않다).
//
// 그때까지 이 드라이버는 **1샤드로는 정상 동작**하고(기동·대기·실행·요약·정리 전부), 분배 자체는
// `GPV_E2E_SHARD` 로 이미 검증돼 있다(러너 쪽, 4샤드 55개 중복·누락 0).
//
// ## 왜 이게 가능한가 (전제 셋, 전부 앞선 커밋에서 깔았다)
//
// 1. **데이터 디렉터리** — `GPV_DATA_DIR`(디버그 전용, `state::data_root`). Tauri 는 데이터 경로를
//    `identifier` 하나에서 파생시키므로 원래는 identifier 마다 따로 빌드해야 했다. Windows 에선
//    `%APPDATA%` 로도 못 가른다(`dirs-sys` 가 `SHGetKnownFolderPath` 를 쓴다).
// 2. **CDP 포트** — `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<n>` 이
//    Tauri 가 넣는 29222 를 덮는다. 러너는 `GPV_E2E_PORT` 로 그 포트만 본다.
// 3. **픽스처** — 러너가 각자 `mkdtemp` 로 만들고 **소유자 PID** 를 남긴다. 그게 없으면 나중에
//    시작한 샤드의 `purgeStaleFixtures` 가 앞 샤드의 살아 있는 픽스처를 지운다(run.mjs 주석).
//
// ## 공유하는 것 / 가르는 것
//
// vite(39090)는 **하나를 공유한다** — 정적 서빙이라 인스턴스가 늘어도 상관없다.
// `app_local_data_dir`(LSP 캐시 270MB 등)도 **일부러 공유한다** — 샤드마다 받으면 그게 더 느리다.
// 갈라야 하는 것은 데이터 디렉터리·CDP 포트·픽스처 셋뿐이다.
//
// ## 출력
//
// 샤드 출력을 섞어 흘리면 읽을 수 없다. 각자 로그 파일로 받고 끝나면 샤드별 요약만 모은다.
// 실패 줄은 함께 낸다 — "어느 샤드의 어느 스위트"가 곧 재현 명령이다.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUNNER = fileURLToPath(new URL("./run.mjs", import.meta.url));
const APP_EXE = join(REPO, "src-tauri", "target", "debug", "gitpervisor.exe");
const VITE_JS = join(REPO, "node_modules", "vite", "bin", "vite.js");
const VITE_URL = "http://localhost:39090/";
/** 샤드별 CDP 포트. 29222(기본 dev 앱)·29223(다른 세션 관례)을 피해서 시작한다. */
const PORT_BASE = 29230;

const shards = Number(process.argv[2] || 4);
const keep = process.env.GPV_E2E_KEEP === "1";
if (!Number.isInteger(shards) || shards < 1 || shards > 12) {
  console.error(`샤드 수가 이상합니다: ${process.argv[2]} (1~12)`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

async function alive(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 1500);
  try {
    await fetch(url, { signal: c.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** 조건이 참이 될 때까지 기다린다. 실패는 **명시적으로** 돌려준다 — 조용히 넘어가면 다음 단계가
 *  "앱이 없다"가 아니라 "스위트가 깨졌다"로 보인다. */
async function waitFor(label, fn, tries, ms) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await sleep(ms);
  }
  console.error(`  ✗ ${label}: ${((tries * ms) / 1000).toFixed(0)}초 안에 준비되지 않음`);
  return false;
}

/** 우리가 띄운 것만 담는다 — **남의 프로세스는 건드리지 않는다**(오늘 남의 앱에 붙는 사고가 있었다). */
const spawned = [];
/** 우리가 만든 데이터 디렉터리 — 정리 대상. */
const dataDirs = [];

/** 자식을 띄우고 **출력을 파일로 남긴다.**
 *
 *  `stdio: "ignore"` 로 두면 안 된다 — 앱이 안 뜰 때 "90초 안에 준비되지 않음" 말고는 아무
 *  단서가 없어서 진단이 불가능하다(처음에 그렇게 썼다가 그대로 막혔다). 실패한 회차의 첫
 *  질문은 언제나 "그 프로세스가 뭐라고 했나" 다. */
function launch(cmd, args, env, tag) {
  const log = join(tmpdir(), `gpv-shard-${tag}.log`);
  rmSync(log, { force: true });
  const chunks = [];
  const p = spawn(cmd, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keepTail = () => {
    // 앱 로그는 길다 — 꼬리만 남긴다(뜨지 못한 이유는 언제나 끝에 있다).
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      writeFileSync(log, text.length > 200_000 ? text.slice(-200_000) : text);
    } catch {
      /* noop */
    }
  };
  p.stdout.on("data", (d) => {
    chunks.push(d);
    keepTail();
  });
  p.stderr.on("data", (d) => {
    chunks.push(d);
    keepTail();
  });
  spawned.push({ p, tag, log });
  return p;
}

/** 자식 하나를 끝까지 돌리고 stdout+stderr 를 문자열로 모은다. */
function runCollect(cmd, args, env) {
  return new Promise((resolve) => {
    const chunks = [];
    const p = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => chunks.push(d));
    p.on("exit", (code) => resolve({ code, text: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** 우리가 띄운 것만 정리한다. **여기를 건너뛰면 고아 앱·고아 vite 가 남아** 다음 실행이
 *  포트에서 막힌다(오늘 두 번 겪었다 — 39090 을 죽은 세션의 vite 가 쥐고 있었다). */
async function cleanup() {
  if (keep) {
    console.log(`\nGPV_E2E_KEEP=1 — 앱 ${spawned.length}개와 데이터 디렉터리를 남깁니다`);
    for (const d of dataDirs) console.log(`  ${d}`);
    return;
  }
  for (const { p } of spawned) {
    try {
      p.kill();
    } catch {
      /* 이미 죽음 */
    }
  }
  await sleep(1500);
  for (const d of dataDirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
}

async function main() {
  if (!existsSync(APP_EXE)) {
    console.error(`디버그 바이너리가 없습니다: ${APP_EXE}`);
    console.error("먼저 한 번 빌드하세요: npm run dev:app");
    process.exit(2);
  }

  // ── vite: 이미 떠 있으면 그걸 쓰고, **우리가 안 띄웠으면 끝나도 안 끈다** ──
  if (await alive(VITE_URL)) {
    console.log("vite 이미 실행 중 — 그대로 씁니다(끝나도 안 끕니다)");
  } else {
    console.log("vite 기동 중…");
    launch(process.execPath, [VITE_JS], {}, "vite");
    if (!(await waitFor("vite(39090)", () => alive(VITE_URL), 60, 1000))) {
      await cleanup();
      process.exit(2);
    }
  }

  // ── 샤드별 앱 인스턴스 ──
  const inst = [];
  for (let i = 1; i <= shards; i++) {
    const port = PORT_BASE + i;
    const dataDir = mkdtempSync(join(tmpdir(), `gpv-shard${i}-`));
    dataDirs.push(dataDir);
    console.log(`샤드 ${i}/${shards}: CDP ${port} · 데이터 ${dataDir}`);
    launch(
      APP_EXE,
      [],
      { GPV_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
      `app${i}`,
    );
    inst.push({ i, port, dataDir });
  }

  for (const s of inst) {
    const ok = await waitFor(
      `샤드 ${s.i} 앱(CDP ${s.port})`,
      () => alive(`http://127.0.0.1:${s.port}/json/version`),
      90,
      1000,
    );
    if (!ok) {
      // **왜 안 떴는지 그 자리에서 보여 준다** — 로그 경로만 주면 다음 사람이 또 찾아 헤맨다.
      const entry = spawned.find((x) => x.tag === `app${s.i}`);
      if (entry?.log && existsSync(entry.log)) {
        const tail = readFileSync(entry.log, "utf8").split("\n").slice(-12).join("\n");
        console.error(`  --- 샤드 ${s.i} 앱 로그 꼬리 (${entry.log}) ---\n${tail}`);
      } else {
        console.error(`  (샤드 ${s.i} 앱이 아무 출력도 남기지 않았다)`);
      }
      await cleanup();
      process.exit(2);
    }
  }
  console.log(`\n앱 ${shards}개 준비 완료 — 러너 시작\n`);

  // ── 러너 N개 동시 실행 ──
  const t0 = Date.now();
  const results = await Promise.all(
    inst.map(async (s) => {
      const r = await runCollect(process.execPath, [RUNNER], {
        GPV_E2E_SHARD: `${s.i}/${shards}`,
        GPV_E2E_PORT: String(s.port),
      });
      const log = join(tmpdir(), `gpv-shard${s.i}-run.log`);
      writeFileSync(log, strip(r.text));
      console.log(`  샤드 ${s.i}/${shards} 종료 (exit ${r.code}) — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return { ...s, ...r, log };
    }),
  );
  const wall = (Date.now() - t0) / 1000;

  // ── 요약 ──
  let pass = 0;
  let fail = 0;
  let skip = 0;
  console.log(`\n${"━".repeat(46)}`);
  for (const r of results.sort((a, b) => a.i - b.i)) {
    const t = strip(r.text);
    const m = /(\d+) pass \/ (\d+) fail \/ (\d+) skip/.exec(t);
    if (m) {
      pass += Number(m[1]);
      fail += Number(m[2]);
      skip += Number(m[3]);
      console.log(`  샤드 ${r.i}/${shards}  ${m[1]} pass / ${m[2]} fail / ${m[3]} skip   → ${r.log}`);
    } else {
      // **요약이 없으면 러너가 시작도 못 한 것이다.** 0으로 세면 "전부 통과"로 보인다.
      fail += 1;
      console.log(`  샤드 ${r.i}/${shards}  ✗ 요약 없음(exit ${r.code}) — ${r.log}`);
    }
    for (const line of t.split("\n").filter((l) => l.includes("FAIL")))
      console.log(`      ${line.trim().slice(0, 170)}`);
  }
  console.log(`${"━".repeat(46)}`);
  console.log(
    `  ${fail === 0 ? "ALL GREEN" : `${fail} FAILED`}   ${pass} pass / ${fail} fail / ${skip} skip` +
      `   벽시계 ${wall.toFixed(0)}s (${(wall / 60).toFixed(1)}분)\n`,
  );

  await cleanup();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("드라이버 오류:", e);
  await cleanup();
  process.exit(2);
});
