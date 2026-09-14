// gitpervisor 전체 기능 E2E 러너.
//
// 실행 중인 디버그 빌드(원격 디버깅 포트 9222)에 CDP 로 붙어, 격리된 임시 git 픽스처에서
// 모든 Tauri 커맨드(~60개)를 직접 invoke 해 기능을 검증한다. 사용자의 실제 프로젝트/설정/
// DB 연결/메모는 건드리지 않으며(스냅샷 후 복원), 추가한 픽스처는 끝나면 전부 정리한다.
//
//   사용법:  npm run test:e2e          (앱이 'npm run tauri dev' 로 떠 있어야 함)
//            GPV_E2E_PORT=9222 node tests/e2e/run.mjs
//
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * 이전 러너가 남긴 픽스처 디렉토리(%TEMP%\gpv-e2e-*) 정리 — 새 픽스처를 만들기 **전에** 부르므로
 * 그 시점의 gpv-e2e-* 는 전부 잔여물이다. 앱(파일 워처·LSP)이 잡고 있으면 EPERM 이 나는데,
 * 그건 이번 실행의 문제가 아니므로 로그만 남기고 진행한다(best-effort).
 */
function purgeStaleFixtures() {
  const tmp = tmpdir();
  let removed = 0;
  let kept = 0;
  for (const entry of readdirSync(tmp).filter((n) => n.startsWith("gpv-e2e-"))) {
    try {
      rmSync(join(tmp, entry), { recursive: true, force: true, maxRetries: 5 });
      removed++;
    } catch (e) {
      kept++;
      console.log(`  잔여 픽스처 삭제 실패(무시): ${entry} — ${e.code || e.message}`);
    }
  }
  if (removed || kept) console.log(`  잔여 픽스처 정리: ${removed}개 삭제, ${kept}개 남김`);
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
  const suites = only.length ? SUITES.filter((p) => only.some((o) => p.includes(`/${o}-`))) : SUITES;
  if (only.length) console.log(`  부분 실행: ${suites.length}개 스위트 (GPV_E2E_ONLY=${only.join(",")})\n`);
  for (const path of suites) {
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
