// e2e 병렬 실행 드라이버 — 앱 인스턴스 N개를 띄우고 스위트를 N등분해 동시에 돌린다.
//
//   사용법:  node tests/e2e/shard.mjs           (기본 3샤드)
//            node tests/e2e/shard.mjs 4         (4샤드)
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
// ## 설치본을 건드리지 않는다 (2026-09-17 사고)
//
// 사용자는 설치본을 켜 둔 채 **그 터미널 안에서** Claude Code 를 돌린다 — 이 드라이버도 대개 설치본의
// 자식 트리에서 돈다. 샤드 회차 중 설치본(v0.5.3)이 멈추자 세션·드라이버·샤드 앱이 통째로 죽었고,
// 조사해 보니 debug exe 가 plain `cargo build` 로 **설치본 identifier** 를 달고 있어 샤드 앱들이
// 설치본의 로그·session.json·썸네일 캐시·인앱 브라우저 프로필에 쓰고 있었다. 그래서:
// - 드라이버가 **`.dev` identifier 로 직접 빌드**하고 exe 에 그 문자열이 있는지 확인한다.
//   앱도 설치본 identifier + e2e 환경변수면 뜨자마자 exit 3 (`lib.rs` e2e_env_on_installed_identifier).
// - 샤드 앱은 set_focus 로 전경을 뺏지 않고(tao 는 SendInput 으로 Alt 를 주입해 뺏는다) 전역 단축키를
//   잡지 않는다(`lib.rs` is_e2e_shard_instance). 인앱 브라우저 프로필도 자기 폴더에 둔다. 단 창 생성 시
//   활성화는 막지 못한다 — 막으면 WebView2 포커스가 죽어 스위트가 무더기로 깨진다(`lib.rs` 메인 창 주석).
// - 설치본 메인 창에 2초마다 WM_NULL 을 보내 **연속 무응답이거나 여유 메모리 8% 미만이면 회차를
//   끊는다.** 멈춘 호출은 특정하지 못했다(덤프 없음) — 원인 대신 증상으로 막는다. 끝에 감시 요약이 나온다.
// - 앱은 **트리째** 거두고(taskkill /T), 시그널(콘솔 닫힘 포함)에도 정리하며, 죽은 드라이버가 남긴
//   폴더·앱은 다음 실행이 소유자 표식으로 **자기 것만** 거둔다.
// - 설치본 health 는 터미널에서 띄운 다른 Gitpervisor 트리를 자기 것으로 세지 않는다(`health/probe.rs`
//   tree_pids) — 전에는 샤드 앱 WebView2 가 잡혀 danger → PTY 출력 128KB/s 로 조였다. **설치본에는
//   다음 릴리스부터 반영된다.**
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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUNNER = fileURLToPath(new URL("./run.mjs", import.meta.url));
const APP_EXE = join(REPO, "src-tauri", "target", "debug", "gitpervisor.exe");
const VITE_JS = join(REPO, "node_modules", "vite", "bin", "vite.js");
const VITE_URL = "http://localhost:39090/";
/** 샤드별 CDP 포트. 29222(기본 dev 앱)·29223(다른 세션 관례)을 피해서 시작한다. */
const PORT_BASE = 29230;
const DEV_CONF = join(REPO, "src-tauri", "tauri.dev.conf.json");
const DEV_IDENTIFIER = JSON.parse(readFileSync(DEV_CONF, "utf8")).identifier;
/** 데이터 디렉터리 안의 소유자 표식 — 드라이버가 죽어도 다음 실행이 **자기 것만** 거둔다. */
const OWNER_FILE = ".gpv-shard-owner.json";
/** 설치본 감시: 이만큼 연속으로 응답이 없거나 여유 메모리가 바닥이면 회차를 멈춘다. */
const WATCH_STRIKES = 2;
const MIN_AVAIL_PCT = Number(process.env.GPV_E2E_MIN_AVAIL_PCT || 8);

// 기본 3 — 벽시계의 바닥은 1번 샤드에 묶인 전역 자원 스위트 묶음(클립보드·캡처, 실측 ≈229s)이라
// 4샤드로 늘려도 안 빨라지고 앱만 하나 더 떠 설치본을 누른다(2026-09-17 suite-times 기준 예상:
// 3샤드 229/135/135s · 4샤드 229/90/90/90s). 더 줄이려면 그 묶음을 쪼개야 한다(클립보드 구간 교차 잠금).
const shards = Number(process.argv[2] || 3);
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
    runners.push(p);
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => chunks.push(d));
    p.on("exit", (code) => resolve({ code, text: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** 러너(`run.mjs`) 자식들 — 중단할 때 같이 거둔다. */
const runners = [];
/** 설치본 감시 프로세스(PowerShell). */
let watcher = null;

/** 프로세스를 **트리째** 끝낸다. `p.kill()` 은 그 PID 하나만 죽여 WebView2·PTY 셸·LSP·git 자식이
 *  고아로 남는다. */
function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 이미 죽음 */
    }
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

let cleaned = false;
/** 우리가 띄운 것만 정리한다. **여기를 건너뛰면 고아 앱·고아 vite 가 남아** 다음 실행이
 *  포트에서 막힌다(39090 을 죽은 세션의 vite 가 쥐고 있었다).
 *
 *  **동기**다 — 시그널 핸들러에서도 끝까지 돌아야 한다. 2026-09-17 에 설치본이 멈춰 그 터미널이
 *  닫히자 드라이버가 정리 없이 죽어 데이터 디렉터리 4개(270MB)가 남았다. */
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (watcher) killTree(watcher.pid);
  if (keep) {
    console.log(`\nGPV_E2E_KEEP=1 — 앱 ${spawned.length}개와 데이터 디렉터리를 남깁니다`);
    for (const d of dataDirs) console.log(`  ${d}`);
    return;
  }
  for (const r of runners) killTree(r.pid);
  for (const { p } of spawned) killTree(p.pid);
  for (const d of dataDirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

// Ctrl+C·콘솔 닫힘(설치본 터미널이 죽을 때가 이것이다)에도 정리한다. Windows 의 콘솔 닫힘은
// SIGHUP 으로 오고 약 10초 유예가 있다.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => {
    console.error(`\n${sig} — 띄운 앱·러너를 거두고 끝냅니다`);
    cleanup();
    process.exit(130);
  });
}

/** 죽은 드라이버가 남긴 샤드 디렉터리와 그 앱을 거둔다.
 *
 *  **소유자 표식이 있고 그 드라이버가 죽은 것만** 건드린다 — `gpv-shard*` 와일드카드로 지우면
 *  살아 있는 다른 세션의 회차를 깬다(2026-09-16 에 픽스처로 실제로 당했다). 앱 PID 는 재사용될 수
 *  있으므로 **실행 파일 경로가 우리 debug exe 일 때만** 죽인다 — 같은 이름의 설치본은 절대 안 건드린다. */
function sweepStale() {
  const tmp = tmpdir();
  for (const name of readdirSync(tmp)) {
    if (!/^gpv-shard\d+-/.test(name)) continue;
    const dir = join(tmp, name);
    let owner;
    try {
      owner = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8"));
    } catch {
      continue; // 표식 없음(옛 드라이버·남의 것) — 손대지 않는다
    }
    if (pidAlive(owner.driver)) continue;
    if (owner.app && pidAlive(owner.app)) {
      const r = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${Number(owner.app)} -ErrorAction SilentlyContinue).Path`],
        { encoding: "utf8" },
      );
      if ((r.stdout || "").trim().toLowerCase() === APP_EXE.toLowerCase()) killTree(owner.app);
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    console.log(`죽은 회차의 잔여물 정리: ${name}`);
  }
}

/** 실행 파일이 **dev identifier** 로 빌드됐는지 보장한다.
 *
 *  plain `cargo build` 는 `tauri.dev.conf.json` 을 안 읽어 **설치본 identifier** 를 굽는다 — 그 exe 로
 *  띄운 샤드 앱 4개가 설치본의 로그·session.json·썸네일 캐시·인앱 브라우저 프로필에 썼다
 *  (2026-09-17). 그래서 드라이버가 `TAURI_CONFIG` 를 주고 직접 빌드한다: tauri-build 가 이 환경변수를
 *  설정에 병합하고 바뀌면 다시 빌드한다(`tauri-build/src/lib.rs`). 최신이면 몇 초다.
 *  앱 쪽에도 같은 가드가 있다(`lib.rs` e2e_env_on_installed_identifier — 뜨자마자 exit 3). */
function ensureDevBinary() {
  const cargo = join(homedir(), ".cargo", "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
  const t0 = Date.now();
  console.log(`디버그 바이너리 빌드(${DEV_IDENTIFIER})…`);
  const r = spawnSync(existsSync(cargo) ? cargo : "cargo", ["build"], {
    cwd: join(REPO, "src-tauri"),
    env: { ...process.env, TAURI_CONFIG: readFileSync(DEV_CONF, "utf8") },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const built = r.status === 0;
  if (built) {
    console.log(`  완료 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } else {
    const log = join(tmpdir(), "gpv-shard-build.log");
    writeFileSync(log, `${r.stdout || ""}${r.stderr || ""}${r.error ? String(r.error) : ""}`);
    const tail = (r.stderr || "").trim().split("\n").slice(-4).join("\n  ");
    console.error(`  빌드 실패(exit ${r.status}) — ${log}\n  ${tail}`);
  }
  if (!existsSync(APP_EXE) || !readFileSync(APP_EXE).includes(Buffer.from(DEV_IDENTIFIER))) {
    console.error(`디버그 바이너리에 ${DEV_IDENTIFIER} 가 없습니다 — 설치본 identifier 로는 띄우지 않습니다.`);
    process.exit(2);
  }
  // 빌드는 실패했지만 기존 exe 는 dev 다(dev 앱이 떠 있어 exe 가 잠긴 경우) — Rust 변경이 빠졌을 수 있다.
  if (!built) console.error("  기존 dev 바이너리로 진행합니다 — 최신 Rust 변경이 반영되지 않았을 수 있습니다.");
}

/** **설치본(우리 debug exe 가 아닌 모든 Gitpervisor)이 응답하는지 2초마다 본다.**
 *
 *  테스트가 사용자의 설치본을 멈추게 하면 안 된다 — 사용자는 그 터미널 안에서 Claude Code 를 돌려서,
 *  설치본이 멈추면 이 회차를 돌리던 세션까지 같이 죽는다(2026-09-17 00:02 실제로 그랬다). 막힌 호출은
 *  끝내 특정하지 못했으므로(덤프 없음) **증상으로 막는다**: 메인 창에 WM_NULL 을
 *  SendMessageTimeout(1.5s, SMTO_ABORTIFHUNG)으로 보내 응답 시간을 재고, 연속으로 응답이 없거나 여유
 *  메모리가 바닥이면 샤드 앱을 전부 거두고 멈춘다. 측정은 PowerShell 한 프로세스가 계속 돈다. */
const WATCH_PS1 = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -Namespace Gpv -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, IntPtr l, uint f, uint t, out UIntPtr r);'
$ci = New-Object Microsoft.VisualBasic.Devices.ComputerInfo
$exclude = $args[0]
while ($true) {
  $avail = [math]::Round(100.0 * $ci.AvailablePhysicalMemory / $ci.TotalPhysicalMemory, 1)
  $apps = @()
  foreach ($p in (Get-Process -Name gitpervisor -ErrorAction SilentlyContinue)) {
    if ($p.Path -eq $exclude) { continue }
    $h = $p.MainWindowHandle
    if ($h -eq [IntPtr]::Zero) { continue }
    $r = [UIntPtr]::Zero
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ok = [Gpv.W]::SendMessageTimeout($h, 0, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1500, [ref]$r)
    $ms = if ($ok -eq [IntPtr]::Zero) { -1 } else { $sw.ElapsedMilliseconds }
    $apps += "$($p.Id):$ms"
  }
  [Console]::Out.WriteLine("avail=$avail apps=" + ($apps -join ','))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
`;

const watchStats = { samples: 0, maxMs: 0, minAvail: 100, hung: 0, watched: new Set() };

function startWatch(onAbort) {
  if (process.platform !== "win32") return;
  // 이름을 고정해 매번 덮어쓴다 — PID 를 붙이면 드라이버가 강제 종료될 때마다(exit 훅이 못 돈다) 쌓인다.
  const ps1 = join(tmpdir(), "gpv-shard-watch.ps1");
  writeFileSync(ps1, WATCH_PS1);
  watcher = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, APP_EXE], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let buf = "";
  let hungStreak = 0;
  let lowStreak = 0;
  watcher.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      const m = /^avail=([\d.]+) apps=(.*)$/.exec(line);
      if (!m) continue;
      const avail = Number(m[1]);
      const apps = m[2] ? m[2].split(",").map((x) => x.split(":").map(Number)) : [];
      const hung = apps.filter(([, ms]) => ms < 0);
      watchStats.samples++;
      watchStats.minAvail = Math.min(watchStats.minAvail, avail);
      for (const [pid, ms] of apps) {
        watchStats.watched.add(pid);
        if (ms >= 0) watchStats.maxMs = Math.max(watchStats.maxMs, ms);
      }
      if (hung.length) watchStats.hung++;
      hungStreak = hung.length ? hungStreak + 1 : 0;
      lowStreak = avail < MIN_AVAIL_PCT ? lowStreak + 1 : 0;
      const pids = hung.map(([p]) => p).join(",");
      if (hungStreak === 1) console.error(`  ⚠ 설치본(pid ${pids})이 1.5초 안에 응답하지 않음`);
      if (hungStreak >= WATCH_STRIKES) onAbort(`설치본(pid ${pids})이 ${WATCH_STRIKES}회 연속 응답하지 않습니다`);
      else if (lowStreak >= WATCH_STRIKES) onAbort(`여유 메모리 ${avail}% < ${MIN_AVAIL_PCT}% 가 ${WATCH_STRIKES}회 연속입니다`);
    }
  });
}

async function main() {
  sweepStale();
  ensureDevBinary();
  startWatch((reason) => {
    console.error(`\n⛔ 회차 중단 — ${reason}. 샤드 앱·러너를 거둡니다.`);
    cleanup();
    process.exit(3);
  });

  // ── vite: 이미 떠 있으면 그걸 쓰고, **우리가 안 띄웠으면 끝나도 안 끈다** ──
  if (await alive(VITE_URL)) {
    console.log("vite 이미 실행 중 — 그대로 씁니다(끝나도 안 끕니다)");
  } else {
    console.log("vite 기동 중…");
    launch(process.execPath, [VITE_JS], {}, "vite");
    if (!(await waitFor("vite(39090)", () => alive(VITE_URL), 60, 1000))) {
      cleanup();
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
    const app = launch(
      APP_EXE,
      [],
      {
        GPV_DATA_DIR: dataDir,
        GPV_WEBVIEW_DIR: join(dataDir, "webview"),
        GPV_E2E_CDP_PORT: String(port),
      },
      `app${i}`,
    );
    writeFileSync(join(dataDir, OWNER_FILE), JSON.stringify({ driver: process.pid, app: app.pid }));
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
      cleanup();
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
      `   벽시계 ${wall.toFixed(0)}s (${(wall / 60).toFixed(1)}분)`,
  );
  // 이 회차가 사용자의 설치본을 얼마나 눌렀는지 — "통과했다"만큼 중요한 숫자다.
  console.log(
    watchStats.samples
      ? `  설치본 감시: 표본 ${watchStats.samples} · 감시 대상 ${watchStats.watched.size}개 · 최대 응답 ${watchStats.maxMs}ms` +
          ` · 무응답 ${watchStats.hung}회 · 최소 여유 메모리 ${watchStats.minAvail}%\n`
      : "  설치본 감시: 표본 없음(PowerShell 감시가 돌지 않았다)\n",
  );

  cleanup();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("드라이버 오류:", e);
  cleanup();
  process.exit(2);
});
