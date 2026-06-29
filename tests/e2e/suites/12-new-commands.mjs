// 이번 세션 추가 백엔드 커맨드 — read_file_base64(#9 이미지뷰어) / reorder_projects(#8 드래그정렬) /
// term_attach·term_project(#3 플로팅 터미널 핵심). 픽스처 레포에서 invoke + 단언, 사용자 순서는 복원.
import { unlinkSync } from "node:fs";
import { join } from "node:path";

export const name =
  "신규 커맨드 (read_file_base64 / reorder_projects / term_attach / term_project)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1x1 PNG — read_file_base64는 확장자로 mime를 정하므로 내용 자체는 무관하다.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export async function run({ cdp, report: r, fix }) {
  // ── read_file_base64 (#9) ──
  const txt = await cdp.try("read_file_base64", {
    projectId: fix.projectId,
    relPath: "README.md",
  });
  r.check(
    "read_file_base64: 텍스트 파일 → {mime,base64}",
    txt.ok && typeof txt.r?.base64 === "string" && txt.r.base64.length > 0,
    txt.ok ? `mime=${txt.r.mime} len=${txt.r.base64.length}` : txt.code,
  );

  fix.writeFile("pixel.png", Buffer.from(PNG_B64, "base64"));
  const img = await cdp.try("read_file_base64", {
    projectId: fix.projectId,
    relPath: "pixel.png",
  });
  r.check(
    "read_file_base64: .png → image/png mime",
    img.ok && img.r?.mime === "image/png",
    img.ok ? img.r.mime : img.code,
  );
  try {
    unlinkSync(join(fix.repo, "pixel.png"));
  } catch {
    /* cleanup이 픽스처 통째로 지운다 */
  }

  const nof = await cdp.try("read_file_base64", {
    projectId: fix.projectId,
    relPath: "__missing__.bin",
  });
  r.check("read_file_base64: 없는 파일 → 오류", !nof.ok, nof.code || "");

  const esc = await cdp.try("read_file_base64", {
    projectId: fix.projectId,
    relPath: "../escape.txt",
  });
  r.check("read_file_base64: 레포 밖 경로(..) 차단", !esc.ok, esc.code || "");

  // ── reorder_projects (#8) — 역순 반영 후 원래 순서로 복원(사용자 순서 보존) ──
  const before = (await cdp.invoke("list_projects")).map((p) => p.id);
  if (before.length >= 2) {
    const reversed = [...before].reverse();
    await cdp.invoke("reorder_projects", { orderedIds: reversed });
    const after = (await cdp.invoke("list_projects")).map((p) => p.id);
    r.check(
      "reorder_projects: 역순 반영·영속",
      JSON.stringify(after) === JSON.stringify(reversed),
      `${after.length}개`,
    );
    await cdp.invoke("reorder_projects", { orderedIds: before });
    const restored = (await cdp.invoke("list_projects")).map((p) => p.id);
    r.check(
      "reorder_projects: 원래 순서 복원",
      JSON.stringify(restored) === JSON.stringify(before),
    );
  } else {
    r.skip("reorder_projects", "프로젝트 2개 미만 — 스킵");
  }

  // ── term_attach (#3 출력 sink 스왑) + term_project ──
  const TID = "gpv-e2e-attach";
  try {
    const ch1 = await cdp.openChannel();
    const open = await cdp.try("term_open", {
      termId: TID,
      projectId: fix.projectId,
      cols: 80,
      rows: 24,
      onData: ch1.ref,
    });
    r.check("term_open: PTY 생성", open.ok, open.code || "");
    if (open.ok) {
      const proj = await cdp.try("term_project", { termId: TID });
      r.check(
        "term_project: PTY 프로젝트 id 반환",
        proj.ok && proj.r === fix.projectId,
        proj.ok ? proj.r : proj.code,
      );

      await sleep(1000);
      await ch1.drain();
      await cdp.invoke("term_write", {
        termId: TID,
        data: "echo ATTACH_BEFORE\r",
      });
      await sleep(800);
      r.check("term_attach 전: ch1으로 출력 수신", /ATTACH_BEFORE/.test(await ch1.text()));

      const ch2 = await cdp.openChannel();
      const att = await cdp.try("term_attach", { termId: TID, onData: ch2.ref });
      r.check("term_attach: 싱크 교체 성공", att.ok, att.code || "");

      await ch1.drain();
      await cdp.invoke("term_write", {
        termId: TID,
        data: "echo ATTACH_AFTER\r",
      });
      await sleep(800);
      const newCh = await ch2.text();
      const oldCh = await ch1.text();
      r.check("term_attach 후: ch2(새 채널) 출력 수신", /ATTACH_AFTER/.test(newCh));
      r.check("term_attach 후: ch1(옛 채널) 출력 안 받음", !/ATTACH_AFTER/.test(oldCh));

      const ghost = await cdp.openChannel();
      const gat = await cdp.try("term_attach", {
        termId: "no-such-term",
        onData: ghost.ref,
      });
      r.check("term_attach: 없는 세션 → 오류", !gat.ok, gat.code || "");

      const gp = await cdp.try("term_project", { termId: "no-such-term" });
      r.check(
        "term_project: 없는 세션 → null",
        gp.ok && gp.r === null,
        gp.ok ? String(gp.r) : gp.code,
      );
    }
  } finally {
    await cdp.try("term_close", { termId: TID });
  }

  // ── 진단/로그 + 외부 알림 (읽기 전용 스모크 — 사용자 시크릿/채널은 건드리지 않는다) ──
  const logSt = await cdp.try("get_log_status", {});
  r.check(
    "get_log_status: {logDir,panicLogBytes,lastCrashAt}",
    logSt.ok &&
      typeof logSt.r?.logDir === "string" &&
      typeof logSt.r?.panicLogBytes === "number",
    logSt.ok ? logSt.r.logDir : logSt.code,
  );
  const crashLog = await cdp.try("read_crash_log", { maxBytes: 4096 });
  r.check(
    "read_crash_log: 문자열 반환",
    crashLog.ok && typeof crashLog.r === "string",
    crashLog.ok ? `len=${crashLog.r.length}` : crashLog.code,
  );

  const hasSlack = await cdp.try("notify_has_secret", { kind: "slack" });
  r.check(
    "notify_has_secret(slack): boolean",
    hasSlack.ok && typeof hasSlack.r === "boolean",
    hasSlack.ok ? String(hasSlack.r) : hasSlack.code,
  );
  const hasBad = await cdp.try("notify_has_secret", { kind: "bogus" });
  r.check("notify_has_secret: 알 수 없는 종류 → 오류", !hasBad.ok, hasBad.code || "(ok?)");

  // notify_test 는 시크릿이 없을 때만 — 설정돼 있으면 실제 전송되므로 사용자 채널 보호로 스킵.
  if (hasSlack.ok && hasSlack.r === false) {
    const t = await cdp.try("notify_test", { channel: "slack" }, { timeoutMs: 9000 });
    r.check(
      "notify_test(미설정 slack) → 설정 안내 오류",
      !t.ok && t.code !== "E2E_TIMEOUT",
      t.code || t.message?.slice(0, 40) || "(ok?)",
    );
  } else {
    r.skip("notify_test(slack)", "사용자 웹훅이 설정돼 있어 실제 전송 방지로 스킵");
  }
}
