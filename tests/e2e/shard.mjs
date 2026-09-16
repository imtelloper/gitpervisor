// e2e 병렬 실행 드라이버 — 앱 인스턴스 N개를 띄우고 스위트를 N등분해 동시에 돌린다.
//
//   사용법:  node tests/e2e/shard.mjs           (기본 4샤드)
//            node tests/e2e/shard.mjs 6         (6샤드)
//            GPV_E2E_KEEP=1 node tests/e2e/shard.mjs   (끝나고 앱·데이터를 남긴다 — 디버깅용)
//
// ## 갈라야 하는 것 넷 (셋이 아니다 — 네 번째에서 한 번 막혔다)
//
// 1. **데이터 디렉터리** — `GPV_DATA_DIR`(`state::data_root`). Tauri 는 데이터 경로를
//    `identifier` 하나에서 파생시키므로 원래는 identifier 마다 따로 빌드해야 했다.
//    Windows 에선 `%APPDATA%` 로도 못 가른다(`dirs-sys` 가 `SHGetKnownFolderPath`).
// 2. **CDP 포트** — `GPV_E2E_CDP_PORT`(`lib.rs::browser_args`). 러너는 `GPV_E2E_PORT` 로 본다.
// 3. **픽스처** — 러너가 각자 `mkdtemp` 로 만들고 **소유자 PID** 를 남긴다. 그게 없으면
//    나중에 시작한 샤드의 `purgeStaleFixtures` 가 앞 샤드의 살아 있는 픽스처를 지운다.
// 4. **WebView2 유저데이터 폴더** — `GPV_WEBVIEW_DIR`(`lib.rs::webview_data_dir`).
//    이걸 빼먹어 2샤드에서 `HRESULT(0x8007139F)`(ERROR_INVALID_STATE)로 막혔다 — 이 폴더도
//    identifier 파생이라(`tauri/src/manager/webview.rs:534`), 인스턴스마다 포트가 다르면
//    WebView2 가 "같은 폴더에 다른 환경 옵션"을 거부한다. CLAUDE.md 가 적어 둔 바로 그 함정이고,
//    **다른 워크트리의 `.dev` 앱이 떠 있어도 같은 이유로 막힌다.**
//
// 넷 다 **디버그 빌드 전용**이다. 릴리스에 남기면 환경변수 하나로 사용자의 프로젝트 목록·
// 설정·쿠키·로그인 세션을 빈 폴더로 갈아치울 수 있다.
//
// 전역 단축키는 프로세스 간 공유라 `HotKey already registered` 가 뜨지만 치명적이진 않다.
//
// ## 공유하는 것 / 가르는 것
//
// vite(39090)는 **하나를 공유한다** — 정적 서빙이라 인스턴스가 늘어도 상관없다.
// `app_local_data_dir`(LSP 캐시 270MB 등)도 **일부러 공유한다** — 샤드마다 받으면 그게 더 느리다.
// 갈라야 하는 것은 위의 넷뿐이다.
//
// ## 샤드 배치 — 가를 수 없는 것 (`run.mjs` 의 `GLOBAL_RESOURCE`·`CHAINS`)
//
// - **머신 전역 자원**(클립보드·전역 단축키)을 쓰는 스위트는 전부 1번 샤드로 간다.
// - **앞 스위트가 만든 픽스처 상태**를 이어 쓰는 스위트(02→03→04→17)는 덩어리째 한 샤드로.
// - 순차 실행에선 앞 스위트가 뷰어를 열어 둔 덕에 통과하던 스위트가 있었다(20·21·25).
//   샤드에선 그 스위트가 **그 앱의 첫 뷰어 마운트**일 수 있다 — lazy 청크·테마·provider 가
//   아직 없다. 샤딩에서만 깨지는 실패가 나오면 먼저 "앞 스위트가 해 둔 무엇에 기대는가"를 본다.
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

/** 앱이 **정말 준비됐는가.** CDP 포트(`/json/version`)는 웹뷰가 뜨자마자 열리는데, 그때 페이지는
 *  아직 `about:blank` 다 — 그 상태로 러너를 붙이면 "디버그 창을 찾지 못했습니다"로 즉사한다
 *  (실측: 러너 4개가 1초 만에 전부 exit 1). 프론트가 실제로 로드됐는지까지 본다. */
async function appReady(port) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: c.signal });
    const list = await res.json();
    return list.some((x) => x.type === "page" && x.title && x.title !== "about:blank");
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
      {
        GPV_DATA_DIR: dataDir,
        GPV_WEBVIEW_DIR: join(dataDir, "webview"),
        GPV_E2E_CDP_PORT: String(port),
      },
      `app${i}`,
    );
    inst.push({ i, port, dataDir });
  }

  for (const s of inst) {
    const ok = await waitFor(
      `샤드 ${s.i} 앱(CDP ${s.port}) 프론트 로드`,
      () => appReady(s.port),
      120,
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
