// gitpervisor 전체 기능 E2E 러너.
//
// 실행 중인 디버그 빌드(원격 디버깅 포트 9222)에 CDP 로 붙어, 격리된 임시 git 픽스처에서
// 모든 Tauri 커맨드(~60개)를 직접 invoke 해 기능을 검증한다. 사용자의 실제 프로젝트/설정/
// DB 연결/메모는 건드리지 않으며(스냅샷 후 복원), 추가한 픽스처는 끝나면 전부 정리한다.
//
//   사용법:  npm run test:e2e          (앱이 'npm run tauri dev' 로 떠 있어야 함)
//            GPV_E2E_PORT=9222 node tests/e2e/run.mjs
//
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { connect } from "./lib/cdp.mjs";
import { createReport } from "./lib/report.mjs";
import { createFixture, FIXTURE_SEEDS, OWNER_FILE } from "./lib/git-fixture.mjs";

const SUITES = [
  "./suites/01-system.mjs",
  "./suites/02-projects-tree.mjs",
  "./suites/03-status-changes.mjs",
  "./suites/04-sync-history.mjs",
  "./suites/05-notes.mjs",
  "./suites/06-terminal.mjs",
  "./suites/07-browser.mjs",
  "./suites/08-apiclient.mjs",
  "./suites/09-db.mjs",
  "./suites/10-codenav.mjs",
  "./suites/11-disk.mjs",
  "./suites/12-new-commands.mjs",
  "./suites/13-float-window.mjs",
  "./suites/14-frontend-dom.mjs",
  "./suites/15-tree-fileops.mjs",
  "./suites/16-browser-session.mjs",
  "./suites/17-remote-freshness.mjs",
  "./suites/18-sysmon.mjs",
  "./suites/19-themes.mjs",
  "./suites/20-occurrence-highlight.mjs",
  "./suites/21-python-outline.mjs",
  "./suites/22-quick-open.mjs",
  "./suites/23-symbol-search.mjs",
  "./suites/24-find-in-files.mjs",
  "./suites/25-find-references.mjs",
  "./suites/26-formatter.mjs",
  "./suites/27-lint.mjs",
  "./suites/28-lsp.mjs",
  "./suites/29-settings-ux.mjs",
  "./suites/30-image-annotate.mjs",
  "./suites/32-disk-usage.mjs",
  "./suites/33-video-split.mjs",
  "./suites/34-image-doc-window.mjs",
  "./suites/35-image-editor-zoom.mjs",
  "./suites/36-image-layer-tree.mjs",
  "./suites/37-image-doc-persist.mjs",
  "./suites/38-image-components-styles.mjs",
  "./suites/39-image-vector-crop.mjs",
  "./suites/40-image-editor-pro-ui.mjs",
  "./suites/43-image-text.mjs",
  "./suites/53-image-pen-node.mjs",
  "./suites/42-image-doc-schema.mjs",
  "./suites/46-image-arrow-nav.mjs",
  // E2E_NET=1 일 때만 실제로 돈다(런타임 다운로드에 네트워크 필요) — 아니면 전부 skip.
  "./suites/47-llm-runtime.mjs",
  "./suites/44-project-logo.mjs",
  "./suites/45-git-dialog.mjs",
  "./suites/50-file-tree-dialog.mjs",
  "./suites/51-viewer-split.mjs",
  "./suites/52-terminal-copy.mjs",
  "./suites/60-favorite-folders.mjs",
  "./suites/61-pdf.mjs",
  "./suites/62-pdf-spike.mjs",
  // 잔디·요약. 자기 전용 레포를 따로 만들어 쓴다(공유 픽스처엔 앞선 스위트의 오늘 커밋이 쌓인다).
  "./suites/48-report.mjs",
  // 번역 본문 단언은 LLM(런타임+모델)이 준비된 경우에만 — 아니면 그 부분만 skip 한다.
  "./suites/49-translate.mjs",
  // 오버레이가 전체화면·포커스를 가져가므로 마지막에 둔다(31-capture.mjs 상단 주석).
  "./suites/31-capture.mjs",
];

/** 스위트별 소요 시간표(초) — `GPV_E2E_WRITE_TIMES=1` 로 전체 회차를 돌리면 갱신된다.
 *  샤드 분배의 **유일한 목적**은 균형이다. 표가 낡아도 회차는 정상이고 분배만 나빠진다. */
const TIMES_FILE = new URL("./suite-times.json", import.meta.url);
/** 표에 없는 스위트의 가정값(초). 새로 추가된 스위트가 한 샤드에 몰리지 않을 정도면 된다. */
const DEFAULT_SUITE_SEC = 20;

function readTimes() {
  try {
    return JSON.parse(readFileSync(TIMES_FILE, "utf8"));
  } catch {
    return {}; // 표가 없으면 전부 기본값 — 분배만 거칠어진다
  }
}

/**
 * `GPV_E2E_SHARD=i/N` → 이 프로세스가 맡을 스위트 목록.
 *
 * **라운드로빈으로 나누면 안 된다.** 편차가 커서(가장 긴 스위트 112s, 가장 짧은 것 0.3s)
 * 무거운 것 둘이 한 샤드에 몰리면 그 샤드가 전체 시간을 정한다 — 샤딩의 이득이 그만큼 사라진다.
 * 측정 시간표를 긴 것부터 **가장 한가한 샤드**에 넣는다(LPT 그리디). 실측 915s 기준 4샤드에서
 * 최장 229s, 샤드 간 편차 0s 였다.
 *
 * 바닥은 **가장 긴 스위트 하나**(112s)다 — 스위트는 쪼갤 수 없으므로 6샤드(153s)를 넘기면
 * 이득이 급격히 준다.
 */
function pickShard(all) {
  const raw = (process.env.GPV_E2E_SHARD || "").trim();
  if (!raw) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(raw);
  if (!m) throw new Error(`GPV_E2E_SHARD 형식은 "i/N" 입니다 (받은 값: ${raw})`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total)
    throw new Error(`GPV_E2E_SHARD 범위 오류: ${raw}`);

  const times = readTimes();
  const weighted = all
    .map((p) => ({ p, sec: times[p] ?? DEFAULT_SUITE_SEC }))
    .sort((a, b) => b.sec - a.sec || a.p.localeCompare(b.p)); // 동점은 이름으로 — 회차마다 같아야 한다
  const bins = Array.from({ length: total }, () => ({ sec: 0, suites: [] }));
  for (const w of weighted) {
    const bin = bins.reduce((lo, b) => (b.sec < lo.sec ? b : lo), bins[0]);
    bin.sec += w.sec;
    bin.suites.push(w.p);
  }
  const mine = bins[index - 1];
  // **원래 순서를 되돌린다.** SUITES 배열 순서에는 이유가 있다(31-capture 는 전체화면을
  // 가져가므로 마지막, 48-report 는 앞선 커밋이 쌓인 뒤 등 — 그 파일 주석 참조).
  return {
    index,
    total,
    estimate: mine.sec,
    suites: all.filter((p) => mine.suites.includes(p)),
  };
}

const report = createReport();

let cdp;
let fix;
let snapshot;

async function takeSnapshot() {
  const settings = await cdp.invoke("get_settings");
  const projects = await cdp.invoke("list_projects");
  const dbConns = await cdp.invoke("db_list_connections");
  const notes = await cdp.invoke("get_notes");
  return {
    settings,
    projectIds: projects.map((p) => p.id),
    dbConnIds: dbConns.map((c) => c.id),
    notesKeys: Object.keys(notes || {}),
  };
}

/** 이 픽스처를 **지금 쓰고 있는 러너가 살아 있는가.** 소유자 PID 파일(`OWNER_FILE`)로 본다.
 *  마커가 없으면(옛 러너가 만든 픽스처) 잔여물로 본다 — 그 시절엔 마커 자체가 없었다. */
function ownedByLiveRunner(dir) {
  let raw;
  try {
    raw = readFileSync(join(dir, OWNER_FILE), "utf8");
  } catch (e) {
    // **마커가 없는 것만** 잔여물로 본다. 여기서 모든 오류를 삼켜 false 를 돌려주면(처음엔
    // 그렇게 썼다) 권한·IO 오류는 물론 이 함수 안의 코드 버그(예: import 누락 ReferenceError)
    // 까지 "잔여물"로 읽혀 **살아 있는 픽스처를 지운다.** 파괴적인 쪽으로 기우는 실패라
    // 방향을 반대로 잡는다 — 모르겠으면 보존한다.
    if (e.code === "ENOENT") return false;
    console.log(`  소유자 확인 실패 — 안전하게 보존: ${dir} (${e.code || e.message})`);
    return true;
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 신호 0 = 존재 확인만
    return true;
  } catch (e) {
    // EPERM 은 "있는데 못 건드린다" — 살아 있다는 뜻이다. ESRCH 만 죽은 것.
    return e.code === "EPERM";
  }
}

/**
 * 이전 러너가 남긴 픽스처 디렉토리(%TEMP%\gpv-e2e-*) 정리. 앱(파일 워처·LSP)이 잡고 있으면
 * EPERM 이 나는데, 그건 이번 실행의 문제가 아니므로 로그만 남기고 진행한다(best-effort).
 *
 * **"그 시점의 gpv-e2e-* 는 전부 잔여물"이 아니다.** 예전 주석이 그렇게 단정했는데, 러너가
 * 두 개 돌면 거짓이다 — 뒤에 시작한 쪽이 앞 러너의 **살아 있는 픽스처를 통째로 지운다.**
 * 그러면 파일만 사라지고 디렉터리는 열린 핸들 때문에 남아, 앞 러너는 `ENOENT: ...\repo\src\app.txt`
 * 나 빈 파일 트리로 뒤늦게 죽는다. 원인이 자기 로그 어디에도 없어서 추적이 거의 불가능하다.
 *
 * **2026-09-16 실패 8건의 직접 원인은 이 함수가 아니었다** — 다른 세션이 회차 **한가운데**
 * (15:33, 회차는 15:25~15:39) 손으로 `rm -rf /tmp/gpv-e2e-*` 를 돌린 것이었다(그쪽 전사로 확정).
 * 그래도 이 수정은 유효하다: 러너가 둘이면 **코드가 같은 일을 한다.**
 *
 * 그 사건이 남긴 진단 교훈이 더 값지다. 45 의 ENOENT 는 `writeFileSync` 가 낸 것이라 파일이
 * 아니라 **상위 디렉터리(`repo\src`) 부재**를 뜻했고, 그 뒤 45 의 finally 가
 * `git checkout -- src/app.txt` 로 복원에 성공했으므로 `.git` 은 살아 있었다. "통삭제였다면
 * `.git` 도 갔어야 한다"는 반증이 **오히려 진짜 원인을 가리켰다** — 잠긴 것은 못 지우는
 * 외부 `rm` 의 부분 삭제 서명이었던 것이다(그쪽 출력에 `cannot remove …/repo: Device or
 * resource busy` 가 남아 있었다). 편해 보이는 자백을 그대로 받았으면 여기서 멈췄을 것이다.
 *
 * 그래서 **소유자 PID 가 살아 있는 픽스처는 건너뛴다.** 이건 위생 문제만이 아니라
 * **샤딩(여러 러너 동시 실행)의 전제 조건**이다 — 이게 없으면 샤드끼리 서로를 지운다.
 */
function purgeStaleFixtures() {
  const tmp = tmpdir();
  let removed = 0;
  let kept = 0;
  let live = 0;
  for (const entry of readdirSync(tmp).filter((n) => n.startsWith("gpv-e2e-"))) {
    const dir = join(tmp, entry);
    if (ownedByLiveRunner(dir)) {
      live++;
      console.log(`  다른 러너가 쓰는 중 — 건너뜀: ${entry}`);
      continue;
    }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      removed++;
    } catch (e) {
      kept++;
      console.log(`  잔여 픽스처 삭제 실패(무시): ${entry} — ${e.code || e.message}`);
    }
  }
  if (removed || kept || live)
    console.log(`  잔여 픽스처 정리: ${removed}개 삭제, ${kept}개 남김, ${live}개 사용중(건너뜀)`);
}

/**
 * 삭제에 실패한 픽스처에 남은 항목 목록 — 실패 메시지에 실어 다음 사람이 이 경로로 범인
 * 프로세스를 찾을 수 있게 한다(남는 건 보통 빈 디렉터리뿐이라 어느 깊이가 CWD 인지가 단서다).
 */
function listLeftover(root) {
  try {
    const names = readdirSync(root, { recursive: true });
    if (!names.length) return "(비어있음)";
    return names.length > 20 ? `${names.slice(0, 20).join(", ")} 외 ${names.length - 20}개` : names.join(", ");
  } catch (e) {
    return `목록 실패: ${e.code || e.message}`;
  }
}

async function teardown() {
  report.suite("정리 · 사용자 상태 복원 검증");
  // 1) 테스트가 만든 자원 강제 정리(방어적 — 스위트가 이미 닫았어도 무해). cdp.try 는 throw 하지 않는다.
  for (const [cmd, args] of [
    ["term_close", { termId: "gpv-e2e-term" }],
    ["browser_close", { browserId: "gpv-e2e-browser" }],
    ["db_delete_connection", { id: "gpv-e2e-conn" }],
    ["db_delete_connection", { id: "gpv-e2e-mongo" }],
  ]) {
    await cdp.try(cmd, args);
  }

  // 2) 픽스처 프로젝트 제거(메모도 함께 정리됨) + 설정 원복 — 복원 invoke 실패를 "조용히" 삼키지 않고
  //    명시적으로 표면화한다(실패해도 아래 스냅샷 대조가 한 번 더 잡는다 — 이중 방어).
  //    remove_project 를 직접 invoke 하면 UI 경로(queries/index.ts 의 removeProject)를 안 타서
  //    localStorage 의 viewerTabs/activeDiffByProject 에 죽은 픽스처 탭이 영구히 쌓인다.
  //    그 경로가 부르는 스토어 액션을 여기서 직접 호출해 준다(dev 전용 window.__gpv).
  if (fix?.projectId) {
    await cdp
      .eval(`window.__gpv?.ui?.getState().closeProjectViewerTabs(${JSON.stringify(fix.projectId)})`)
      .catch((e) => console.error("viewerTabs 정리 경고:", e.message));
  }
  const rmRes = fix?.projectId ? await cdp.try("remove_project", { id: fix.projectId }) : { ok: true };
  const setRes = snapshot?.settings ? await cdp.try("set_settings", { settings: snapshot.settings }) : { ok: true };
  report.check("teardown: remove_project(픽스처) 호출 성공", rmRes.ok, rmRes.code || rmRes.message || "");
  report.check("teardown: set_settings(원복) 호출 성공", setRes.ok, setRes.code || setRes.message || "");

  // 3) 임시 디렉토리 삭제 + **실제로 사라졌는지** 단언. 살아있는 세션 개수 같은 대리 지표가
  //    아니라 결과를 재는 이유: 다른 무엇이 디렉토리를 쥐어도 개수는 통과한다. 남아 있다면
  //    누군가 이 경로를 CWD 로 쥐고 있다는 뜻이다(프로세스 CWD 는 FILE_SHARE_DELETE 없이 열린
  //    디렉터리 핸들이라 안의 파일만 지워지고 디렉터리가 남는다). 회차마다 쌓이면 결국 WebView2
  //    메시지 큐가 터져 렌더러가 죽는다(0x80070578).
  //
  //    **즉시 재면 안 된다.** `remove_project` 는 PTY·LSP 종료를 별도 스레드로 넘기고 바로
  //    반환한다(terminal.rs `spawn_terminate` — 동기로 기다리면 세션 N개 × 300ms 만큼 앱이
  //    통째로 얼어붙는다). 그래서 커맨드가 돌아온 시점엔 셸이 아직 살아 CWD 를 쥐고 있을 수
  //    있다. 계약은 "즉시 지워진다"가 아니라 **"곧 지워진다"** 이므로 그렇게 잰다.
  //    상한을 두므로 진짜 누수(영영 안 놓는 핸들)는 그대로 잡힌다 — 경과 시간을 성공 메시지에
  //    실어 두니, 이 값이 상한에 근접하기 시작하면 종료가 느려졌다는 신호로 읽으면 된다.
  //    throw 하지 않는다 — teardown 의 나머지 복원 검증은 끝까지 돌아야 한다.
  if (fix) {
    const t0 = Date.now();
    let left = true;
    for (let i = 0; i < 24 && left; i++) {
      if (i) await new Promise((r) => setTimeout(r, 250));
      fix.cleanup(); // 실패를 삼킨다(경고만) — 판정은 아래 existsSync 로 한다
      left = existsSync(fix.root);
    }
    const ms = Date.now() - t0;
    report.check(
      "teardown: 픽스처 디렉토리 삭제됨(종료는 비동기라 최대 6초 대기)",
      !left,
      left ? `${fix.root} — ${ms}ms 후에도 남음, 남은 항목: ${listLeftover(fix.root)}` : `${ms}ms`,
    );
  }

  // 4) 복원 검증 — 사용자의 실제 상태가 그대로인지 확인
  const projects = await cdp.invoke("list_projects");
  const ids = projects.map((p) => p.id);
  report.check("프로젝트: 픽스처 제거됨", !ids.includes(fix?.projectId), fix?.projectId || "");
  report.check("프로젝트: 원래 목록 보존", snapshot.projectIds.every((id) => ids.includes(id)) && ids.length === snapshot.projectIds.length, `${ids.length} vs ${snapshot.projectIds.length}`);

  const settings = await cdp.invoke("get_settings");
  report.check("설정: 원복됨", settings.theme === snapshot.settings.theme && settings.diffFontSize === snapshot.settings.diffFontSize, `theme=${settings.theme}`);

  const dbConns = (await cdp.invoke("db_list_connections")).map((c) => c.id);
  report.check("DB 연결: 원래 목록과 동일", dbConns.length === snapshot.dbConnIds.length && snapshot.dbConnIds.every((id) => dbConns.includes(id)) && !dbConns.includes("gpv-e2e-conn"), `${dbConns.length}개`);

  const notesKeys = Object.keys((await cdp.invoke("get_notes")) || {});
  report.check("메모: 픽스처 메모 흔적 없음", !notesKeys.includes(fix?.projectId), `keys=${notesKeys.length}`);
}

async function main() {
  console.log(`\x1b[1m\x1b[36mgitpervisor E2E\x1b[0m  — gitpervisor 디버그 창 탐색 중...\n`);

  // 연결 + 스냅샷 + 픽스처 셋업
  cdp = await connect();
  console.log(`  연결됨: ${cdp.pageUrl}  (CDP ${cdp.cdpPort})`);
  snapshot = await takeSnapshot();
  console.log(`  스냅샷: 프로젝트 ${snapshot.projectIds.length} · DB연결 ${snapshot.dbConnIds.length} · 메모키 ${snapshot.notesKeys.length} · 테마 ${snapshot.settings.theme}`);

  // 러너가 도는 동안 주기 배경 fetch를 끈다. fetch_one 은 git fetch 내내 프로젝트 op 락을 쥐므로
  // (fetch_scheduler.rs / state.rs) 사용자 프로젝트 수십 개의 사이클이 스위트의 pull/commit 을
  // OP_IN_PROGRESS 로 튕기고, 세마포어(3) 대기까지 겹치면 폴링 시한을 통째로 잡아먹는다.
  // 17-remote-freshness 는 force=true 로 부르므로 0 이어도 그대로 동작한다 — 0 차단은
  // refresh_remotes 의 !force 분기에만 있고(fetch_scheduler.rs), should_attempt 도 force 면 즉시 true.
  // 원복은 teardown 의 set_settings(snapshot.settings) 가 담당한다(스냅샷은 위에서 이미 떴다).
  const offRes = await cdp.try("set_settings", { settings: { ...snapshot.settings, remoteRefreshMinutes: 0 } });
  console.log(
    `  배경 fetch: remoteRefreshMinutes ${snapshot.settings.remoteRefreshMinutes} → 0` +
      (offRes.ok ? "" : ` (실패: ${offRes.code || offRes.message})`),
  );

  // 이전 러너 잔여 픽스처 정리 — 새 픽스처를 만들기 전에(그래야 "현재 것 제외"가 자명하다).
  purgeStaleFixtures();

  /**
   * 스위트 하나가 끝날 때마다 **픽스처 시드 파일이 아직 있는지** 본다.
   *
   * 왜: 모든 스위트가 픽스처 하나를 공유하므로, 한 스위트가 시드 파일을 지우면 그 뒤 스위트들이
   * 줄줄이 죽는다. 그런데 러너는 **죽은 쪽만** 보여 주므로 원인이 보이지 않는다 — 2026-09-16
   * 회차에서 실패 8건이 났는데(44·45·50·51), 넷 다 격리 실행하면 76/0 으로 멀쩡했다.
   * `src/app.txt` 가 회차 도중 사라진 것이 진짜 사건이었고, **누가 지웠는지는 로그에 없었다.**
   * 여기서 직전 스위트 이름과 함께 빨갛게 찍으면 그 연쇄가 다음부터 한 줄로 끝난다.
   *
   * 확인 뒤 **복원한다.** 안 하면 첫 범인만 보이고 그 뒤 범인은 연쇄에 묻혀 영영 안 보인다
   * (그리고 남은 스위트 수십 개가 무의미해진다). 복원은 시드 내용 그대로다 — 원본 출처는
   * `FIXTURE_SEEDS` 하나라 검사와 생성이 어긋날 수 없다.
   */
  function checkFixture(afterSuite) {
    const missing = Object.keys(FIXTURE_SEEDS).filter(
      (rel) => !existsSync(join(fix.repo, ...rel.split("/"))),
    );
    if (!missing.length) return;
    report.check(
      "픽스처 불변식: 시드 파일이 남아 있다",
      false,
      `사라짐=[${missing.join(", ")}] · 직전 스위트="${afterSuite}" — 이 스위트가 지웠다(복원하고 계속)`,
    );
    for (const rel of missing) {
      try {
        mkdirSync(dirname(join(fix.repo, ...rel.split("/"))), { recursive: true });
        writeFileSync(join(fix.repo, ...rel.split("/")), FIXTURE_SEEDS[rel]);
      } catch (e) {
        report.check("픽스처 복원", false, `${rel}: ${e.message}`);
      }
    }
  }

  fix = createFixture();
  const project = await cdp.invoke("add_project", { path: fix.repo }, { timeoutMs: 30000 });
  fix.projectId = project.id;
  console.log(`  픽스처: ${fix.repo}  →  projectId ${fix.projectId}\n`);

  // 스위트 순차 실행(공유 앱·픽스처 → 직렬). 한 스위트가 throw 해도 다음으로 진행.
  //
  // GPV_E2E_ONLY=30,34 처럼 부분집합을 지정하면 그 스위트만 돈다. 한 기능을 고치는 동안
  // 기준선을 반복 확인하려면 전체 44 스위트를 다시 도는 비용이 너무 크다(설계 R10 "격리 실행").
  // 셋업·픽스처·teardown 은 그대로라 결과 해석 조건은 전체 실행과 같다.
  const only = (process.env.GPV_E2E_ONLY || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let suites = only.length ? SUITES.filter((p) => only.some((o) => p.includes(`/${o}-`))) : SUITES;
  if (only.length) console.log(`  부분 실행: ${suites.length}개 스위트 (GPV_E2E_ONLY=${only.join(",")})\n`);
  const shard = pickShard(suites);
  if (shard) {
    suites = shard.suites;
    console.log(
      `  샤드 ${shard.index}/${shard.total}: ${suites.length}개 스위트 · 예상 ${shard.estimate.toFixed(0)}s\n`,
    );
  }
  for (const path of suites) {
    const mod = await import(path);
    report.suite(mod.name || path);
    try {
      await mod.run({ cdp, report, fix, snapshot, port: cdp.cdpPort, devPort: cdp.devPort });
    } catch (e) {
      report.check("(스위트 실행 중 예외)", false, e.message);
    }
    checkFixture(mod.name || path);
  }
}

let exitCode = 1;
try {
  await main();
} catch (e) {
  console.error(`\n\x1b[31m치명적 오류:\x1b[0m ${e.message}\n`);
} finally {
  // 셋업이 일부라도 됐으면 항상 정리/복원 시도
  if (cdp && snapshot) {
    try {
      await teardown();
    } catch (e) {
      console.error("teardown 오류:", e.message);
    }
  }
  if (cdp) {
    const { fail } = report.summary();
    exitCode = fail === 0 ? 0 : 1;
    cdp.close();
  }
  process.exit(exitCode);
}
