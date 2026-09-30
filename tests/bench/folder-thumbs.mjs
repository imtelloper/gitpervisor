// 폴더 창 썸네일 그리드 벤치 — 이미지 3천 장 폴더.
//
// **자기 앱을 하나 띄운다.** 사용자가 쓰는 dev 앱(29222)·설치본은 건드리지 않는다 — 샤드 드라이버
// (`tests/e2e/shard.mjs`)와 같은 방식으로 데이터·WebView2 폴더·CDP 포트를 가른 `.dev` 디버그 exe 를
// 띄우고, vite(39090)는 떠 있는 것을 공유한다. exe 는 미리 빌드돼 있어야 한다(샤드 드라이버가 빌드한다).
//
//   사용법:  node tests/bench/folder-thumbs.mjs
//            GPV_BENCH_N=1000 node tests/bench/folder-thumbs.mjs      (장 수, 기본 3000)
//            GPV_BENCH_KEEP=1 …                                      (픽스처 폴더를 남긴다 — 전/후 비교용)
//
// **썸네일 디스크 캐시(app_cache_dir/thumbs)는 dev 앱과 공유한다**(identifier 가 같다). 그래서 콜드
// 측정은 캐시를 비우지 않고 **이 벤치 픽스처의 키만** 지운다 — 키는 백엔드와 같은 식으로 계산한다
// (sha256(정규 경로|mtime ms|크기|edge), commands/favorites.rs `thumb_cache_key`). 계산이 맞는지는
// 웜 단계에서 키 파일이 실제로 생겼는지로 확인해 찍는다.
//
// 재는 것(모두 폴더 창 페이지 안에서, 그 창의 navigation 시작 기준):
//   a) 콜드 — 새로고침 → 첫 타일이 DOM 에 뜨기까지 / 첫 화면 보이는 칸의 썸네일이 전부 뜨기까지
//   b) 웜   — 같은 측정(디스크 캐시 적중)
//   c) 끝까지 한 화면씩 내려가며 매 화면을 다 띄우기(콜드 · 웜) — 총 시간. 화면 사이 60ms 휴지(사람
//      속도 흉내 — 빠른 연속 스크롤 판정에 걸리지 않게)는 합계에서 뺀다
//   d) c(콜드) 동안 메인 스레드 Long Tasks 합계·최대·개수
//   e) c(콜드) 동안 다른 IPC 왕복 — 그 창이 **실제로 쓰는** ipc 모듈의 `ipc.favPresets()`(`call` 경로라
//      동시 슬롯·큐를 같이 탄다) p50/p90/max
//   f) 빠른 연속 스크롤(16ms 마다 400px)로 끝까지 → 마지막 화면이 다 뜨기까지 · 백엔드가 만든 썸네일 수
//      (콜드) — 지나쳐 간 칸을 얼마나 헛디코드하나
//   g) 왕복(웜) — 새로고침 → 첫 화면 → 2초 둔 뒤 프레임마다 SWEEP_PX 씩 끝까지 내려갔다 맨 위로 올라온다.
//      프레임마다 **보이는 칸 중 썸네일이 안 보이는 칸**(아이콘이거나 빈 그림)을 세 합계·최대, 칸이 화면을
//      다 덮지 못한 프레임 수, 멈춘 뒤 화면이 다 차기까지(끝·맨 위 각각)
//   h) 콜드 연속 스크롤 — 이 픽스처 캐시를 비우고 새로고침 → 첫 화면이 차자마자 g 와 같은 속도로 끝까지.
//      같은 지표(내려가는 동안만)
//
// "썸네일이 떴다"(a~f) = 보이는 칸의 `<img>` 가 `complete && naturalWidth > 0`. 옛 구조(data URL)와 새 구조
// (스킴 URL) 모두 같은 판정이다. g·h 의 "보인다"는 거기에 **실제로 보이는가**(`visibility`)까지 본다 —
// 다 받아 둔 그림도 `onLoad` 전까지 숨겨 두고 아이콘을 비추는 구조가 있었다.
//
// g·h 는 스크롤 위치를 **프레임 사이(태스크)** 에서 바꾸고 다음 rAF 에서 잰다. 사용자 스크롤처럼 scroll 이벤트
// → rAF → 그리기 순서가 한 프레임 안에 들어, 잰 DOM 이 곧 그 프레임에 그려지는 DOM 이다(rAF 안에서 바꾸면
// scroll 이벤트가 다음 프레임으로 밀려 한 프레임씩 어긋난다).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { connect, connectLabel, docWindowsBefore, newDocWindow } from "../e2e/lib/cdp.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const APP_EXE = join(REPO, "src-tauri", "target", "debug", process.platform === "win32" ? "gitpervisor.exe" : "gitpervisor");
const DEV_IDENTIFIER = JSON.parse(readFileSync(join(REPO, "src-tauri", "tauri.dev.conf.json"), "utf8")).identifier;
/** 29222(사용자 dev 앱)·29223(다른 세션)·29231~(샤드)를 피한다. */
const PORT = 29250;
const N = Number(process.env.GPV_BENCH_N || 3000);
const EDGE = 192; // 폴더 창 기본 보기(grid-m)
const FIXTURE = join(tmpdir(), `gpv-bench-thumbs-${N}`);
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tauri `app_cache_dir` — Windows `%LOCALAPPDATA%\<id>`, macOS `~/Library/Caches/<id>`, Linux `~/.cache/<id>`. */
const THUMBS =
  process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), DEV_IDENTIFIER, "thumbs")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", DEV_IDENTIFIER, "thumbs")
      : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), DEV_IDENTIFIER, "thumbs");

function ensureFixture() {
  const have = existsSync(FIXTURE) ? readdirSync(FIXTURE).filter((n) => n.endsWith(".jpg")).length : 0;
  if (have === N) return;
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  console.log(`픽스처 생성: ${FIXTURE} (670×1610 JPEG ${N}장, ffmpeg testsrc2)`);
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=670x1610:rate=30", "-frames:v", String(N), "-q:v", "3", join(FIXTURE, "%06d.jpg")],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`ffmpeg 실패(exit ${r.status}) — PATH 에 ffmpeg 가 있어야 한다`);
}

/** 이 픽스처의 썸네일 캐시 파일 경로들 — 백엔드 키 계산과 같은 식. */
function fixtureKeys() {
  return readdirSync(FIXTURE)
    .filter((n) => n.endsWith(".jpg"))
    .map((n) => {
      const p = realpathSync.native(join(FIXTURE, n));
      const st = statSync(p);
      const key = createHash("sha256")
        .update(`${p}|${Math.floor(st.mtimeMs)}|${st.size}|${EDGE}`)
        .digest("hex");
      return join(THUMBS, `${key}.jpg`);
    });
}
const countCached = (keys) => keys.filter((k) => existsSync(k)).length;
function dropCached(keys) {
  for (const k of keys) {
    try {
      unlinkSync(k);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}

async function appReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const list = await res.json();
    return list.some((x) => x.type === "page" && x.title && x.title !== "about:blank");
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 이미 죽음 */
    }
  }
}

/** 폴더 창에 새 문서마다 심는 계측 — 첫 타일·첫 화면 시각, Long Tasks. */
const INSTR = `(() => {
  const B = (window.__tb = { firstTile: 0, firstScreen: 0, lt: [] });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) B.lt.push([e.startTime, e.duration]); })
      .observe({ type: "longtask", buffered: true });
  } catch (_) { /* longtask 미지원 — d 가 비어 나온다 */ }
  /** 보이는 칸 수·그중 썸네일이 뜬 칸 수. 칸은 DOM 순서 = 화면 순서라 첫 보이는 칸을 이분 탐색한다
   *  (옛 구조는 3천 칸이 전부 DOM 에 있어 매번 전부 재면 측정이 측정을 느리게 한다). */
  B.vis = () => {
    const tiles = document.querySelectorAll("button.flex-col[title]");
    if (!tiles.length) return null;
    const sc = tiles[0].closest(".overflow-auto");
    const R = sc.getBoundingClientRect();
    let lo = 0, hi = tiles.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tiles[m].getBoundingClientRect().bottom <= R.top) lo = m + 1; else hi = m; }
    let vis = 0, loaded = 0, shown = 0, firstTop = Infinity, lastBottom = -Infinity;
    for (let i = lo; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect();
      if (r.top >= R.bottom) break;
      vis++;
      firstTop = Math.min(firstTop, r.top);
      lastBottom = Math.max(lastBottom, r.bottom);
      const img = tiles[i].querySelector("img");
      if (img && img.complete && img.naturalWidth > 0) {
        loaded++;
        if (getComputedStyle(img).visibility === "visible") shown++;
      }
    }
    // 가상 그리드는 스크롤 직후 한 박자 동안 **옛 행**만 DOM 에 있다 — 그 칸들이 다 떴다고 "화면이 다 떴다"로
    // 세면 안 된다. 보이는 칸이 화면 위·아래 끝(행 사이 틈 10px 허용)까지 덮어야 한다(맨 위·맨 끝은 예외).
    const covered =
      (firstTop <= R.top + 10 || sc.scrollTop <= 20) &&
      (lastBottom >= R.bottom - 10 || sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 20);
    return { dom: tiles.length, vis, loaded, shown, covered, top: sc.scrollTop, h: sc.clientHeight, sh: sc.scrollHeight, sc };
  };
  B.frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  B.full = () => { const v = B.vis(); return !!v && v.covered && v.vis > 0 && v.loaded === v.vis; };
  B.waitFull = async (maxMs) => {
    const t0 = performance.now();
    while (!B.full()) {
      if (performance.now() - t0 > maxMs) return false;
      await new Promise((r) => setTimeout(r, 5));
    }
    return true;
  };
  /** 화면이 다 찰 때까지(g·h) — 프레임마다 본다(5ms 폴링은 그리지도 않은 상태를 잰다). ms, 초과면 -1. */
  B.waitShown = async (maxMs) => {
    const t0 = performance.now();
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const v = B.vis();
      if (v && v.covered && v.vis > 0 && v.shown === v.vis) return performance.now() - t0;
      if (performance.now() - t0 > maxMs) return -1;
    }
  };
  const tick = setInterval(() => {
    const now = performance.now();
    if (!B.firstTile && document.querySelector("button.flex-col[title]")) B.firstTile = now;
    if (B.firstTile && !B.firstScreen && B.full()) { B.firstScreen = now; clearInterval(tick); }
  }, 5);
})()`;

/** c·d·e — 한 화면씩 끝까지. 페이지 안에서 돈다(CDP 왕복이 섞이지 않게). */
const WALK = (withIpc) => `(async () => {
  const B = window.__tb;
  const v0 = B.vis(); const sc = v0.sc;
  sc.scrollTop = 0;
  await B.waitFull(60000);
  const lt0 = B.lt.length;
  const ipcLat = [];
  let walking = true;
  const ipcLoop = (async () => {
    if (!${withIpc}) return;
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => n.includes("/src/lib/ipc.ts")) || "/src/lib/ipc.ts";
    const m = await import(url);
    while (walking) {
      const t = performance.now();
      try { await m.ipc.favPresets(); ipcLat.push(performance.now() - t); } catch (_) { ipcLat.push(-1); }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const t0 = performance.now();
  let steps = 0, pauses = 0, stuck = 0;
  while (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 1) {
    sc.scrollTop += sc.clientHeight;
    steps++;
    await B.frames(); // 스크롤 이벤트 → 새 행이 그려질 때까지(옛 구조에도 똑같이 든다)
    if (!(await B.waitFull(60000))) stuck++;
    const p = performance.now(); await new Promise((r) => setTimeout(r, 60)); pauses += performance.now() - p;
  }
  const ms = performance.now() - t0 - pauses;
  walking = false;
  await ipcLoop;
  const lt = B.lt.slice(lt0).filter(([s]) => s >= t0);
  return { ms, steps, stuck, ipcLat, ltSum: lt.reduce((a, [, d]) => a + d, 0), ltMax: Math.max(0, ...lt.map(([, d]) => d)), ltN: lt.length };
})()`;

/** f — 16ms 마다 400px 씩 끝까지 연속 스크롤 → 마지막 화면이 다 뜨기까지. */
const FLING = `(async () => {
  const B = window.__tb;
  const sc = B.vis().sc;
  const t0 = performance.now();
  for (let top = 0; top < sc.scrollHeight; top += 400) {
    sc.scrollTop = top;
    await new Promise((r) => setTimeout(r, 16));
  }
  sc.scrollTop = sc.scrollHeight;
  await B.frames();
  const flung = performance.now() - t0;
  const ok = await B.waitFull(180000);
  return { flung, lastScreen: performance.now() - t0 - flung, ok };
})()`;

/** g·h 의 스크롤 속도(px/프레임) — 60fps 면 12,000px/s, 휠을 연달아 굴리는 정도. */
const SWEEP_PX = 200;
/** g·h — `dirs` 방향(1 = 끝까지, -1 = 맨 위까지)으로 차례로 쓸고, 방향마다 멈춘 뒤 화면이 다 차기까지를 잰다.
 *  빈 칸 지표는 모든 방향을 합친다. */
const SWEEP = (dirs, idleMs) => `(async () => {
  const B = window.__tb;
  const sc = B.vis().sc;
  await new Promise((r) => setTimeout(r, ${idleMs}));
  const res = { frames: 0, emptySum: 0, emptyMax: 0, gapFrames: 0, settle: [] };
  for (const dir of ${J(dirs)}) {
    const end = () => (dir > 0 ? sc.scrollHeight - sc.clientHeight : 0);
    while (dir > 0 ? sc.scrollTop < end() - 1 : sc.scrollTop > 1) {
      await new Promise((r) => setTimeout(r, 0)); // 프레임 사이로(머리 주석)
      sc.scrollTop = Math.max(0, Math.min(end(), sc.scrollTop + dir * ${SWEEP_PX}));
      await new Promise((r) => requestAnimationFrame(r));
      const v = B.vis();
      const empty = v ? v.vis - v.shown : 0;
      res.frames++;
      res.emptySum += empty;
      res.emptyMax = Math.max(res.emptyMax, empty);
      if (!v || !v.covered) res.gapFrames++;
    }
    res.settle.push(await B.waitShown(60000));
  }
  return res;
})()`;

const pct = (xs, p) => {
  const s = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]) : -1;
};

async function main() {
  if (!existsSync(APP_EXE) || !readFileSync(APP_EXE).includes(Buffer.from(DEV_IDENTIFIER))) {
    throw new Error(`${APP_EXE} 가 없거나 ${DEV_IDENTIFIER} 로 빌드되지 않았다 — 설치본 identifier 로는 띄우지 않는다`);
  }
  try {
    await fetch("http://localhost:39090/", { signal: AbortSignal.timeout(1500) });
  } catch {
    throw new Error("vite(39090)가 떠 있지 않다");
  }
  ensureFixture();
  const keys = fixtureKeys();

  const dataDir = mkdtempSync(join(tmpdir(), "gpv-bench-thumbs-app-"));
  writeFileSync(
    join(dataDir, "settings.json"),
    J({ settings: { uiLanguage: "ko", favoriteFolders: [{ path: FIXTURE, name: "bench" }] } }),
  );
  const logPath = join(dataDir, "app.log");
  const logFd = openSync(logPath, "w");
  const app = spawn(APP_EXE, [], {
    cwd: REPO,
    env: { ...process.env, GPV_DATA_DIR: dataDir, GPV_WEBVIEW_DIR: join(dataDir, "webview"), GPV_E2E_CDP_PORT: String(PORT) },
    stdio: ["ignore", logFd, logFd],
  });
  const cleanup = () => {
    killTree(app.pid);
    try {
      closeSync(logFd);
    } catch {
      /* 이미 닫힘 */
    }
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    } catch (e) {
      console.error(`⚠ 앱 데이터 폴더를 못 지웠다: ${dataDir} — ${e.code || e.message}`);
    }
    // 이 벤치가 dev 캐시에 남긴 썸네일도 거둔다 — 이 픽스처의 키만.
    dropCached(keys);
    if (process.env.GPV_BENCH_KEEP !== "1") rmSync(FIXTURE, { recursive: true, force: true });
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    let ready = false;
    for (let i = 0; i < 120 && !(ready = await appReady(PORT)); i++) await sleep(1000);
    if (!ready) throw new Error(`앱이 CDP ${PORT} 에서 준비되지 않았다 — 로그 ${logPath}`);
    const cdp = await connect({ port: PORT });

    const before = await docWindowsBefore(cdp);
    await cdp.eval(`import("/src/lib/floating.ts").then((m) => { m.openFolderWindow(${J(FIXTURE)}); return true; })`);
    const found = await newDocWindow(cdp, before);
    if (!found) throw new Error("폴더 창이 뜨지 않았다");
    const win = await connectLabel(found.label, { port: PORT });
    await win._send("Page.enable");
    await win._send("Network.enable");
    await win._send("Network.setCacheDisabled", { cacheDisabled: true });
    await win._send("Page.addScriptToEvaluateOnNewDocument", { source: INSTR });

    const reload = async () => {
      // 옛 문서에 표시를 남긴다 — 새로고침이 아직 커밋 전이면 옛 문서의 `__tb` 가 "첫 화면 다 떴다"로 읽혀,
      // 다음 측정이 곧 사라질 문서에서 돌다 "Execution context was destroyed" 로 죽었다(g·h 가 겪었다).
      await win.eval(`window.__tbStale = true`).catch(() => {});
      await win._send("Page.reload", { ignoreCache: true });
      await sleep(300);
      for (let i = 0; i < 1800; i++) {
        const s = await win.eval(`window.__tb && !window.__tbStale ? { t: __tb.firstTile, s: __tb.firstScreen } : null`).catch(() => null);
        if (s?.s) return s;
        await sleep(100);
      }
      const st = await win
        .eval(`window.__tb ? (() => { const v = __tb.vis(); if (v) delete v.sc; return { firstTile: __tb.firstTile, v, url: location.href }; })() : "계측 없음: " + location.href`)
        .catch((e) => e.message);
      throw new Error(`첫 화면이 180초 안에 다 뜨지 않았다 — ${J(st)}`);
    };
    const dom = () => win.eval(`__tb.vis() && __tb.vis().dom`);

    console.log(`\n폴더 창 썸네일 벤치 — ${N}장 · edge ${EDGE} · 앱 CDP ${PORT} · 캐시 ${THUMBS}\n`);

    // a) 콜드 첫 화면
    dropCached(keys);
    const a = await reload();
    const domTiles = await dom();
    // c·d·e) 콜드로 끝까지
    const c = await win.eval(WALK(true), { timeoutMs: 30 * 60 * 1000 });
    const cachedAfterWalk = countCached(keys);
    // b) 웜 첫 화면 + 웜 끝까지
    const b = await reload();
    const cw = await win.eval(WALK(false), { timeoutMs: 30 * 60 * 1000 });
    // f) 콜드 연속 스크롤
    dropCached(keys);
    await reload();
    const firstScreenKeys = countCached(keys);
    const f = await win.eval(FLING, { timeoutMs: 10 * 60 * 1000 });
    // 이미 나간 요청이 끝날 때까지(개수가 2초 동안 그대로) 기다린 뒤 센다.
    let made = countCached(keys);
    let still = 0;
    for (let i = 0; still < 4 && i < 240; i++) {
      await sleep(500);
      const n = countCached(keys);
      still = n === made ? still + 1 : 0;
      made = n;
    }
    const growing = still < 4; // 120초를 기다려도 아직 만들고 있다 — 센 값은 하한이다
    // g) 웜 왕복
    await reload();
    const g = await win.eval(SWEEP([1, -1], 2000), { timeoutMs: 10 * 60 * 1000 });
    // h) 콜드 연속 스크롤(첫 화면이 차자마자)
    dropCached(keys);
    await reload();
    const h = await win.eval(SWEEP([1], 0), { timeoutMs: 10 * 60 * 1000 });

    const ms = (x) => `${Math.round(x)}ms`;
    console.log(`  DOM 에 그려진 칸                     ${domTiles} / ${N}`);
    console.log(`  a) 콜드  첫 타일 ${ms(a.t)} · 첫 화면 썸네일 전부 ${ms(a.s)}`);
    console.log(`  b) 웜    첫 타일 ${ms(b.t)} · 첫 화면 썸네일 전부 ${ms(b.s)}`);
    console.log(`  c) 끝까지 한 화면씩(${c.steps}화면)  콜드 ${ms(c.ms)}${c.stuck ? ` (60초 초과 ${c.stuck}화면)` : ""} · 웜 ${ms(cw.ms)}${cw.stuck ? ` (60초 초과 ${cw.stuck}화면)` : ""}`);
    console.log(`  d) c(콜드) 중 Long Tasks  합계 ${ms(c.ltSum)} · 최대 ${ms(c.ltMax)} · ${c.ltN}개`);
    console.log(
      `  e) c(콜드) 중 ipc.favPresets 왕복  p50 ${pct(c.ipcLat, 0.5)}ms · p90 ${pct(c.ipcLat, 0.9)}ms · max ${pct(c.ipcLat, 1)}ms (n=${c.ipcLat.length}${c.ipcLat.includes(-1) ? `, 실패 ${c.ipcLat.filter((x) => x < 0).length}` : ""})`,
    );
    console.log(
      `  f) 연속 스크롤 ${ms(f.flung)} 뒤 마지막 화면까지 ${f.ok ? ms(f.lastScreen) : "180초 초과"} · 만든 썸네일 ${made - firstScreenKeys}장${growing ? "+ (120초 뒤에도 계속 만드는 중 — 하한)" : ""} (첫 화면 ${firstScreenKeys}장 제외)`,
    );
    const settle = (x) => (x < 0 ? "60초 초과" : ms(x));
    const sweepLine = (x) =>
      `${x.frames}프레임 · 빈 칸 합계 ${x.emptySum} · 프레임당 최대 ${x.emptyMax} · 화면을 다 못 덮은 프레임 ${x.gapFrames}`;
    console.log(`  g) 웜 왕복(${SWEEP_PX}px/프레임, 2초 둔 뒤)  ${sweepLine(g)} · 멈춘 뒤 다 차기까지 끝 ${settle(g.settle[0])} · 맨 위 ${settle(g.settle[1])}`);
    console.log(`  h) 콜드 연속 스크롤(${SWEEP_PX}px/프레임)  ${sweepLine(h)} · 멈춘 뒤 다 차기까지 ${settle(h.settle[0])}`);
    console.log(
      `\n  (키 계산 확인: 콜드로 끝까지 내려간 뒤 이 픽스처 키 ${cachedAfterWalk}/${N}개가 캐시에 있다 — ${N}에 못 미치면 a·f 의 "콜드"가 믿을 수 없다)\n`,
    );
    win.close();
    cdp.close();
  } finally {
    cleanup();
  }
}

main().catch((e) => {
  console.error("벤치 오류:", e);
  process.exit(1);
});
