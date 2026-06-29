// gitpervisor 전체 기능 E2E 러너.
//
// 실행 중인 디버그 빌드(원격 디버깅 포트 9222)에 CDP 로 붙어, 격리된 임시 git 픽스처에서
// 모든 Tauri 커맨드(~60개)를 직접 invoke 해 기능을 검증한다. 사용자의 실제 프로젝트/설정/
// DB 연결/메모는 건드리지 않으며(스냅샷 후 복원), 추가한 픽스처는 끝나면 전부 정리한다.
//
//   사용법:  npm run test:e2e          (앱이 'npm run tauri dev' 로 떠 있어야 함)
//            GPV_E2E_PORT=9222 node tests/e2e/run.mjs
//
import { connect } from "./lib/cdp.mjs";
import { createReport } from "./lib/report.mjs";
import { createFixture } from "./lib/git-fixture.mjs";

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
];

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
  const rmRes = fix?.projectId ? await cdp.try("remove_project", { id: fix.projectId }) : { ok: true };
  const setRes = snapshot?.settings ? await cdp.try("set_settings", { settings: snapshot.settings }) : { ok: true };
  report.check("teardown: remove_project(픽스처) 호출 성공", rmRes.ok, rmRes.code || rmRes.message || "");
  report.check("teardown: set_settings(원복) 호출 성공", setRes.ok, setRes.code || setRes.message || "");

  // 3) 임시 디렉토리 삭제
  if (fix) fix.cleanup();

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

  fix = createFixture();
  const project = await cdp.invoke("add_project", { path: fix.repo }, { timeoutMs: 30000 });
  fix.projectId = project.id;
  console.log(`  픽스처: ${fix.repo}  →  projectId ${fix.projectId}\n`);

  // 스위트 순차 실행(공유 앱·픽스처 → 직렬). 한 스위트가 throw 해도 다음으로 진행.
  for (const path of SUITES) {
    const mod = await import(path);
    report.suite(mod.name || path);
    try {
      await mod.run({ cdp, report, fix, snapshot, port: cdp.cdpPort, devPort: cdp.devPort });
    } catch (e) {
      report.check("(스위트 실행 중 예외)", false, e.message);
    }
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
