// 상태/변경 작업 — get_statuses, stage/unstage, get_file_diff(index/worktree), get_file_diffs, commit, discard.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const name = "상태 · 변경작업 (status / stage / diff / commit / discard)";

const APP = "src/app.txt";
const BASE = "line1\nline2\nline3\n";
const MOD = "line1\nline2\nline3\nline4-e2e\n";

async function statusOf(cdp, projectId) {
  const all = await cdp.invoke("get_statuses", { projectIds: [projectId] }, { timeoutMs: 50000 });
  return (all || []).find((s) => s.projectId === projectId);
}
const has = (arr, p) => (arr || []).some((f) => f.path === p);

export async function run({ cdp, report: r, fix }) {
  const diskPath = join(fix.repo, "src", "app.txt");

  // ── 1) 추적 파일 수정 → unstaged 감지 ──
  fix.writeFile("src/app.txt", MOD);
  let st = await statusOf(cdp, fix.projectId);
  r.check("get_statuses: 픽스처 상태 반환", !!st && st.error == null, st?.error || "");
  r.check("get_statuses: 수정 파일이 unstaged", has(st?.unstaged, APP), `unstaged=${st?.unstaged?.length}`);

  // ── 2) stage → staged 이동 ──
  await cdp.invoke("stage_files", { projectId: fix.projectId, paths: [APP] });
  st = await statusOf(cdp, fix.projectId);
  r.check("stage_files: staged 로 이동", has(st?.staged, APP) && !has(st?.unstaged, APP));

  // ── 3) get_file_diff (index 모드 — HEAD↔인덱스) ──
  const dIndex = await cdp.invoke("get_file_diff", { projectId: fix.projectId, target: { mode: "index", path: APP } });
  r.check("get_file_diff(index): 새 내용에 변경 포함", (dIndex?.newContent || "").includes("line4-e2e"), `binary=${dIndex?.isBinary}`);
  r.check("get_file_diff(index): 옛 내용은 변경 전", (dIndex?.oldContent || "").trim().endsWith("line3"), "(HEAD 버전)");

  // ── 4) unstage → 다시 unstaged ──
  await cdp.invoke("unstage_files", { projectId: fix.projectId, paths: [APP] });
  st = await statusOf(cdp, fix.projectId);
  r.check("unstage_files: unstaged 로 환원", has(st?.unstaged, APP) && !has(st?.staged, APP));

  // ── 5) get_file_diff (worktree 모드) + get_file_diffs(배치) ──
  const dWork = await cdp.invoke("get_file_diff", { projectId: fix.projectId, target: { mode: "worktree", path: APP } });
  r.check("get_file_diff(worktree): 변경 반영", (dWork?.newContent || "").includes("line4-e2e"));
  const batch = await cdp.invoke("get_file_diffs", { projectId: fix.projectId, paths: [APP] }, { timeoutMs: 15000 });
  r.check("get_file_diffs(배치): 해당 파일 diff 반환", Array.isArray(batch) && batch.some((d) => d.path === APP && (d.newContent || "").includes("line4-e2e")));

  // ── 6) commit ──
  await cdp.invoke("stage_files", { projectId: fix.projectId, paths: [APP] });
  await cdp.invoke("commit", { projectId: fix.projectId, message: "e2e: modify app.txt", amend: false });
  st = await statusOf(cdp, fix.projectId);
  r.check("commit: app.txt 변경이 커밋됨(추적변경 사라짐)", !has(st?.staged, APP) && !has(st?.unstaged, APP));

  // ── 7) commit 빈 메시지 거부 ──
  fix.writeFile("src/app.txt", MOD + "x\n");
  await cdp.invoke("stage_files", { projectId: fix.projectId, paths: [APP] });
  const emptyCommit = await cdp.try("commit", { projectId: fix.projectId, message: "   ", amend: false });
  r.check("commit: 빈 메시지 → 오류", !emptyCommit.ok && emptyCommit.code === "GIT_ERROR", emptyCommit.code || "(ok?)");
  await cdp.invoke("unstage_files", { projectId: fix.projectId, paths: [APP] });

  // ── 8) untracked 파일 → discard(삭제) ──
  fix.writeFile("newfile.txt", "temporary\n");
  st = await statusOf(cdp, fix.projectId);
  r.check("get_statuses: untracked 감지", has(st?.untracked, "newfile.txt"));
  await cdp.invoke("discard_files", { projectId: fix.projectId, tracked: [], untracked: ["newfile.txt"] });
  r.check("discard_files(untracked): 파일 삭제됨", !existsSync(join(fix.repo, "newfile.txt")));

  // ── 9) tracked 수정 → discard(되돌림) ──
  fix.writeFile("src/app.txt", MOD + "line5-DISCARDME\n");
  await cdp.invoke("discard_files", { projectId: fix.projectId, tracked: [APP], untracked: [] });
  const after = readFileSync(diskPath, "utf8");
  r.check("discard_files(tracked): 워킹트리 되돌림", !after.includes("DISCARDME") && after.includes("line4-e2e"), `len=${after.length}`);
}
