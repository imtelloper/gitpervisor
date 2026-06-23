// 동기화 + 히스토리 — push(-u)/fetch/pull(로컬 bare 원격), get_branches/get_log/get_commit_detail.
export const name = "동기화 · 히스토리 (push / fetch / pull / branches / log)";

async function statusOf(cdp, projectId) {
  const all = await cdp.invoke("get_statuses", { projectIds: [projectId] }, { timeoutMs: 50000 });
  return (all || []).find((s) => s.projectId === projectId);
}

export async function run({ cdp, report: r, fix }) {
  // ── 초기 브랜치 상태(아직 push 전) ──
  let br = await cdp.invoke("get_branches", { projectId: fix.projectId });
  r.check("get_branches: HEAD=main", br?.head === "main", `head=${br?.head}`);
  r.check("get_branches: 로컬 main 존재", (br?.local || []).some((b) => b.name === "main"));
  r.check("get_branches: 업스트림 아직 없음", (br?.local || []).find((b) => b.name === "main")?.upstream == null, "(push 전)");

  // ── push -u (origin/main 생성 + 업스트림 설정) ──
  const push = await cdp.try("push", { projectId: fix.projectId, setUpstream: true }, { timeoutMs: 60000 });
  r.check("push(setUpstream): 성공", push.ok, push.code || push.message || "");
  r.check("push: 원격(bare)에 커밋 도달", fix.remoteLog() === "e2e: modify app.txt", `remote=${fix.remoteLog()}`);

  br = await cdp.invoke("get_branches", { projectId: fix.projectId });
  r.check("get_branches: 업스트림 origin/main 설정됨", (br?.local || []).find((b) => b.name === "main")?.upstream === "origin/main");
  r.check("get_branches: 원격 브랜치 origin/main 표시", (br?.remote || []).some((b) => b.name === "origin/main"));

  // ── 외부 커밋 → fetch (behind 감지) ──
  fix.pushExternalCommit("ext.txt", "from another dev\n", "ext: outside commit");
  const fetch = await cdp.try("fetch", { projectId: fix.projectId }, { timeoutMs: 60000 });
  r.check("fetch: 성공", fetch.ok, fetch.code || fetch.message || "");
  let st = await statusOf(cdp, fix.projectId);
  r.check("fetch 후 behind≥1", (st?.behind || 0) >= 1, `ahead=${st?.ahead} behind=${st?.behind}`);

  // ── pull (fast-forward) ──
  const pull = await cdp.try("pull", { projectId: fix.projectId }, { timeoutMs: 60000 });
  r.check("pull: 성공", pull.ok, pull.code || pull.message || "");
  st = await statusOf(cdp, fix.projectId);
  r.check("pull 후 behind=0", (st?.behind || 0) === 0, `behind=${st?.behind}`);

  // ── log / commit_detail ──
  const log = await cdp.invoke("get_log", { projectId: fix.projectId, limit: 50, skip: 0, allRefs: false }, { timeoutMs: 15000 });
  r.check("get_log: 3개 이상 커밋", Array.isArray(log) && log.length >= 3, `${log?.length}개`);
  const subjects = (log || []).map((c) => c.subject);
  r.check("get_log: 외부 커밋 포함", subjects.includes("ext: outside commit"));
  r.check("get_log: 초기 커밋 포함", subjects.includes("init: seed fixture"));

  const top = log?.[0];
  const detail = await cdp.invoke("get_commit_detail", { projectId: fix.projectId, sha: top.sha });
  r.check("get_commit_detail: 커밋 메타 일치", detail?.commit?.sha === top.sha && detail?.commit?.subject === top.subject);
  r.check("get_commit_detail: 변경 파일 목록", Array.isArray(detail?.files) && detail.files.length >= 1, `${detail?.files?.length}개 파일`);
}
