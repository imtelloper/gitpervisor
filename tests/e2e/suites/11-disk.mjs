// 디스크/빌드 산출물 정리 — get_target_sizes / clean_target.
// 안전: clean_target 은 cargo `target/` 디렉토리를 통째로 삭제하므로 격리 픽스처에서만 수행한다.
// 픽스처에 가짜 Cargo.toml + target/ 를 만들어 측정→삭제→재측정으로 검증.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "디스크 정리 (get_target_sizes / clean_target)";

const sizeOf = (arr, pid) => (arr || []).find((s) => s.projectId === pid);

export async function run({ cdp, report: r, fix }) {
  // ── 1) 비-Rust 베이스라인 ──
  let sizes = await cdp.invoke("get_target_sizes", { projectIds: [fix.projectId] }, { timeoutMs: 60000 });
  let mine = sizeOf(sizes, fix.projectId);
  r.check("get_target_sizes: 항목 반환", !!mine, JSON.stringify(mine));
  r.check("get_target_sizes: Rust 아님 베이스라인", mine && mine.isRust === false && mine.targetCount === 0 && mine.bytes === 0, `isRust=${mine?.isRust} count=${mine?.targetCount}`);

  // ── 2) 가짜 cargo target 생성 (Cargo.toml + target/big.bin 8KB) ──
  fix.writeFile("Cargo.toml", '[package]\nname = "gpv-e2e"\nversion = "0.0.0"\n');
  const targetDir = join(fix.repo, "target");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "big.bin"), Buffer.alloc(8192, 1));

  sizes = await cdp.invoke("get_target_sizes", { projectIds: [fix.projectId] }, { timeoutMs: 60000 });
  mine = sizeOf(sizes, fix.projectId);
  r.check("get_target_sizes: Rust 감지(target 존재)", mine && mine.isRust === true && mine.targetCount >= 1, `isRust=${mine?.isRust} count=${mine?.targetCount}`);
  r.check("get_target_sizes: bytes 측정(≥8KB)", (mine?.bytes || 0) >= 8192, `bytes=${mine?.bytes}`);
  r.check("get_target_sizes: paths 에 target 경로", (mine?.paths || []).some((p) => p.replace(/\\/g, "/").endsWith("/target")), JSON.stringify(mine?.paths));

  // ── 3) clean_target → 삭제 + 회수 용량 ──
  const clean = await cdp.invoke("clean_target", { projectId: fix.projectId }, { timeoutMs: 60000 });
  r.check("clean_target: removed≥1", (clean?.removed || 0) >= 1, `removed=${clean?.removed}`);
  r.check("clean_target: freedBytes≥8KB", (clean?.freedBytes || 0) >= 8192, `freed=${clean?.freedBytes}`);
  r.check("clean_target: target 디렉토리 삭제됨(디스크)", !existsSync(targetDir));

  // ── 4) 정리 후 재측정 → targetCount 0 ──
  sizes = await cdp.invoke("get_target_sizes", { projectIds: [fix.projectId] }, { timeoutMs: 60000 });
  mine = sizeOf(sizes, fix.projectId);
  r.check("clean_target 후 targetCount 0", mine && mine.targetCount === 0, `count=${mine?.targetCount}`);

  // ── 5) 없는 프로젝트 → NOT_FOUND ──
  const bad = await cdp.try("clean_target", { projectId: "no-such-project-id" });
  r.check("clean_target: 없는 프로젝트 → NOT_FOUND", !bad.ok && bad.code === "NOT_FOUND", bad.code || "(ok?)");
}
