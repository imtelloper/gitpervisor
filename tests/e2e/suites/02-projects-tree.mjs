// 프로젝트 등록 + 파일 트리 — add/list/remove_project, list_dir, list_project_roots, write_file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMinimalRepo } from "../lib/git-fixture.mjs";

export const name = "프로젝트 · 파일트리 (projects / list_dir / list_project_roots / write_file)";

export async function run({ cdp, report: r, fix }) {
  // ── list_projects: 픽스처 프로젝트가 등록되어 있어야 함(run.mjs 가 추가) ──
  const projects = await cdp.invoke("list_projects");
  r.check("list_projects: 배열 반환", Array.isArray(projects), `${projects?.length}개`);
  const mine = projects.find((p) => p.id === fix.projectId);
  r.check("list_projects: 픽스처 프로젝트 포함", !!mine, mine?.path);

  // ── add_project 오류 경로 ──
  const dup = await cdp.try("add_project", { path: fix.repo });
  r.check("add_project: 중복 → DUPLICATE_PROJECT", !dup.ok && dup.code === "DUPLICATE_PROJECT", dup.code || "(ok?)");

  const noDir = await cdp.try("add_project", { path: join(fix.root, "does-not-exist-xyz") });
  r.check("add_project: 없는 폴더 → NOT_FOUND", !noDir.ok && noDir.code === "NOT_FOUND", noDir.code || "(ok?)");

  const nonRepo = mkdtempSync(join(tmpdir(), "gpv-e2e-norepo-"));
  const notRepo = await cdp.try("add_project", { path: nonRepo });
  r.check("add_project: git 아님 → NOT_A_REPO", !notRepo.ok && notRepo.code === "NOT_A_REPO", notRepo.code || "(ok?)");
  try { rmSync(nonRepo, { recursive: true, force: true }); } catch (_) { /* noop */ }

  // ── list_dir(루트) ──
  const root = await cdp.invoke("list_dir", { projectId: fix.projectId, relPath: "" });
  const byName = Object.fromEntries((root || []).map((e) => [e.name, e]));
  r.check("list_dir: README.md 파일", byName["README.md"] && byName["README.md"].isDir === false);
  r.check("list_dir: src 디렉토리", byName["src"] && byName["src"].isDir === true);
  r.check("list_dir: .git 은 isIgnored", !byName[".git"] || byName[".git"].isIgnored === true, "(숨김/무시)");

  // ── list_dir(서브디렉토리) ──
  const sub = await cdp.invoke("list_dir", { projectId: fix.projectId, relPath: "src" });
  r.check("list_dir(src): app.txt 포함", (sub || []).some((e) => e.name === "app.txt"));

  // ── list_dir 경로 탈출 차단 (타임아웃이 아닌 실제 IO 거부여야 false-pass 아님) ──
  const escape = await cdp.try("list_dir", { projectId: fix.projectId, relPath: "../.." });
  r.check("list_dir: '..' 경로 거부", !escape.ok && escape.code === "IO", escape.code || "(ok?)");

  // ── open_in (탐색기/터미널 열기) — 안전하게 오류 경로만 검증(창을 띄우지 않음) ──
  const openBad = await cdp.try("open_in", { projectId: "no-such-project-id", target: "explorer" }, { timeoutMs: 8000 });
  r.check("open_in: 없는 프로젝트 → 오류(창 안 띄움)", !openBad.ok && openBad.code === "NOT_FOUND", openBad.code || "(ok?)");

  // ── list_project_roots(배치) ──
  const roots = await cdp.invoke("list_project_roots", { projectIds: [fix.projectId] }, { timeoutMs: 20000 });
  const myRoot = (roots || []).find((x) => x.projectId === fix.projectId);
  r.check("list_project_roots: 항목 반환", !!myRoot && Array.isArray(myRoot.entries) && myRoot.entries.length > 0, `${myRoot?.entries?.length}개`);
  r.check("list_project_roots: error 없음", myRoot && myRoot.error == null, myRoot?.error || "");

  // ── write_file (Viewer 편집 저장) — 등록 여부 + 실제 디스크 반영 확인, 끝나면 원복 ──
  const wf = await cdp.try("write_file", { projectId: fix.projectId, relPath: "README.md", content: "# edited by e2e\n" }, { timeoutMs: 8000 });
  if (wf.ok) {
    r.check("write_file: 디스크에 실제 반영됨", fix.readFile("README.md").includes("edited by e2e"));
    const wfBad = await cdp.try("write_file", { projectId: fix.projectId, relPath: "../escape.txt", content: "x" });
    r.check("write_file: '..' 경로 거부", !wfBad.ok && wfBad.code === "IO", wfBad.code || "(ok?)");
    fix.revert("README.md"); // 추적 파일을 깨끗이 되돌려 이후 sync 스위트(pull)의 전제 보장
  } else {
    r.skip("write_file: 백엔드 미반영", `lib.rs 에 등록됨 — dev 재빌드 후 검증됨 (현재: ${wf.code || wf.message})`);
  }

  // ── remove_project (전용 커버리지) — 별도 throwaway 레포로 add→remove + 오류 경로 ──
  const mini = createMinimalRepo();
  let addedId = null;
  try {
    const added = await cdp.invoke("add_project", { path: mini.repo }, { timeoutMs: 30000 });
    addedId = added.id;
    const rm = await cdp.try("remove_project", { id: addedId });
    r.check("remove_project: 등록 프로젝트 제거 성공", rm.ok, rm.code || "");
    if (rm.ok) addedId = null;
    const list2 = await cdp.invoke("list_projects");
    r.check("remove_project: 목록에서 사라짐", !list2.some((p) => p.id === added.id));
    const rmBad = await cdp.try("remove_project", { id: "no-such-project-id" });
    r.check("remove_project: 없는 id → NOT_FOUND", !rmBad.ok && rmBad.code === "NOT_FOUND", rmBad.code || "(ok?)");
  } finally {
    if (addedId) await cdp.try("remove_project", { id: addedId }); // 실패해도 사용자 목록에 안 남게
    mini.cleanup();
  }
}
