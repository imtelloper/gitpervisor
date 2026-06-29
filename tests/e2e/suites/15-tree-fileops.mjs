// 트리 파일 작업 커맨드 — create_dir(새 폴더) / delete_path(삭제) / write_file_bytes(이미지
// 변환·편집 저장). 픽스처 레포에서 invoke + 디스크 반영/경로 탈출 차단을 단언하고, 잔여는 정리한다.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const name =
  "트리 파일 작업 (create_dir / delete_path / write_file_bytes)";

// 1x1 PNG — write_file_bytes는 바이트를 그대로 쓰므로 내용 자체는 무관하다.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function run({ cdp, report: r, fix }) {
  const has = (rel) => existsSync(join(fix.repo, rel));
  const P = (relPath) => ({ projectId: fix.projectId, relPath });

  // ── create_dir ──
  const mk = await cdp.try("create_dir", P("e2e-newdir"));
  r.check(
    "create_dir: 새 폴더 생성",
    mk.ok && has("e2e-newdir"),
    mk.ok ? "(생성됨)" : mk.code,
  );

  const dup = await cdp.try("create_dir", P("e2e-newdir"));
  r.check("create_dir: 중복 → 오류", !dup.ok, dup.code || "(ok?)");

  const mkEsc = await cdp.try("create_dir", P("../escape-dir"));
  r.check(
    "create_dir: '..' 경로 거부",
    !mkEsc.ok && mkEsc.code === "IO",
    mkEsc.code || "(ok?)",
  );

  const mkGit = await cdp.try("create_dir", P(".git/evil"));
  r.check("create_dir: .git 진입 거부", !mkGit.ok, mkGit.code || "(ok?)");

  // ── 윈도우 정규화 .git 우회 차단 (CVE-2019-1352 류) ──
  const gitDot = await cdp.try("create_dir", P(".git./evil"));
  r.check(
    "create_dir: '.git.' (끝점) 우회 거부",
    !gitDot.ok && gitDot.code === "IO",
    gitDot.code || "(ok?)",
  );
  const gitAds = await cdp.try("write_file_bytes", {
    ...P(".git::$INDEX_ALLOCATION/x"),
    base64: PNG_B64,
    overwrite: true,
  });
  r.check(
    "write_file_bytes: '.git::$INDEX_ALLOCATION' 우회 거부",
    !gitAds.ok && gitAds.code === "IO",
    gitAds.code || "(ok?)",
  );

  // ── write_file_bytes (이미지 변환·편집 저장) ──
  const wb = await cdp.try(
    "write_file_bytes",
    { ...P("e2e-newdir/pixel.png"), base64: PNG_B64, overwrite: false },
    { timeoutMs: 15000 },
  );
  r.check(
    "write_file_bytes: 새 파일 기록",
    wb.ok && has("e2e-newdir/pixel.png"),
    wb.ok ? "(기록됨)" : wb.code,
  );

  // 같은 경로 재기록(overwrite=false) → ALREADY_EXISTS, overwrite=true → 성공
  const wbConflict = await cdp.try("write_file_bytes", {
    ...P("e2e-newdir/pixel.png"),
    base64: PNG_B64,
    overwrite: false,
  });
  r.check(
    "write_file_bytes: 충돌(overwrite=false) → ALREADY_EXISTS",
    !wbConflict.ok && wbConflict.code === "ALREADY_EXISTS",
    wbConflict.code || "(ok?)",
  );
  const wbOver = await cdp.try("write_file_bytes", {
    ...P("e2e-newdir/pixel.png"),
    base64: PNG_B64,
    overwrite: true,
  });
  r.check("write_file_bytes: overwrite=true → 성공", wbOver.ok, wbOver.code || "");

  const wbBad = await cdp.try("write_file_bytes", {
    ...P("e2e-newdir/x.png"),
    base64: "@@@ not-valid-base64 @@@",
    overwrite: true,
  });
  r.check(
    "write_file_bytes: 잘못된 base64 → 오류",
    !wbBad.ok,
    wbBad.code || "(ok?)",
  );

  const wbEsc = await cdp.try("write_file_bytes", {
    ...P("../escape.png"),
    base64: PNG_B64,
    overwrite: true,
  });
  r.check(
    "write_file_bytes: '..' 경로 거부",
    !wbEsc.ok && wbEsc.code === "IO",
    wbEsc.code || "(ok?)",
  );

  // ── delete_path ──
  const delFile = await cdp.try("delete_path", P("e2e-newdir/pixel.png"));
  r.check(
    "delete_path: 파일 삭제",
    delFile.ok && !has("e2e-newdir/pixel.png"),
    delFile.ok ? "(삭제됨)" : delFile.code,
  );

  const delDir = await cdp.try("delete_path", P("e2e-newdir"));
  r.check(
    "delete_path: 폴더 재귀 삭제",
    delDir.ok && !has("e2e-newdir"),
    delDir.ok ? "(삭제됨)" : delDir.code,
  );

  const delMissing = await cdp.try("delete_path", P("__missing_xyz__"));
  r.check("delete_path: 없는 대상 → 오류", !delMissing.ok, delMissing.code || "(ok?)");

  const delRoot = await cdp.try("delete_path", P(""));
  r.check("delete_path: 루트(빈 경로) 거부", !delRoot.ok, delRoot.code || "(ok?)");

  const delGit = await cdp.try("delete_path", P(".git"));
  r.check("delete_path: .git 거부", !delGit.ok, delGit.code || "(ok?)");

  // ── run_executable (오류 경로만 — 실제 프로세스는 띄우지 않는다) ──
  const runMissing = await cdp.try("run_executable", P("__nope__.exe"));
  r.check(
    "run_executable: 없는 파일 → NOT_FOUND",
    !runMissing.ok && runMissing.code === "NOT_FOUND",
    runMissing.code || "(ok?)",
  );
  const runEsc = await cdp.try("run_executable", P("../escape.exe"));
  r.check(
    "run_executable: '..' 경로 거부",
    !runEsc.ok && runEsc.code === "IO",
    runEsc.code || "(ok?)",
  );
  const runGit = await cdp.try("run_executable", P(".git/hooks/x"));
  r.check("run_executable: .git 거부", !runGit.ok, runGit.code || "(ok?)");

  // 정리 — 잔여 픽스처 디렉토리 제거(방어적, 이미 지워졌으면 무해).
  await cdp.try("delete_path", P("e2e-newdir"));
}
