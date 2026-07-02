// 원격 최신상태 자동 반영(태스크 04) — refresh_remotes 강제 트리거로 배경 fetch를 구동해,
// 로컬 bare 원격(file://)의 새 커밋이 statuses의 behind/lastFetchAt/fetchError에 반영되는지 검증.
// 04-sync-history가 만든 origin/main(push -u) 위에서 동작한다 — 스위트 순서 의존은 하네스 관례.
export const name = "원격 최신상태 (refresh_remotes / freshness 조인)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statusOf(cdp, projectId) {
  const all = await cdp.invoke("get_statuses", { projectIds: [projectId] }, { timeoutMs: 50000 });
  return (all || []).find((s) => s.projectId === projectId);
}

export async function run({ cdp, report: r, fix }) {
  // ── 계약: 설정 신 키 remoteRefreshMinutes 존재 (구 autoFetchMinutes 대체, §3.7) ──
  const settings = await cdp.invoke("get_settings");
  r.check(
    "settings: remoteRefreshMinutes 존재(숫자)",
    typeof settings.remoteRefreshMinutes === "number",
    `value=${settings.remoteRefreshMinutes}`,
  );

  // ── 원격(bare)에 외부 커밋 추가 — 로컬 refs는 아직 모르는 상태 ──
  fix.pushExternalCommit("freshness.txt", "remote freshness probe\n", "ext: freshness probe");

  // ── refresh_remotes(해당 repo, force) — 즉시 반환(백그라운드 진행)이어야 한다 ──
  const t0 = Date.now();
  const res = await cdp.try("refresh_remotes", { projectIds: [fix.projectId], force: true });
  r.check("refresh_remotes(force): 성공 반환", res.ok, res.code || res.message || "");
  r.check("refresh_remotes: 즉시 반환(<5s, 백그라운드 진행)", Date.now() - t0 < 5000, `${Date.now() - t0}ms`);

  // ── 배경 fetch 완료 폴링: behind ≥ 1 + lastFetchAt 채워짐 (freshness 조인) ──
  let st = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    st = await statusOf(cdp, fix.projectId);
    if ((st?.behind || 0) >= 1 && st?.lastFetchAt) break;
    await sleep(500);
  }
  r.check("배경 fetch 후 behind≥1 (원격 새 커밋 감지)", (st?.behind || 0) >= 1, `behind=${st?.behind}`);
  r.check(
    "lastFetchAt 갱신(파싱 가능한 ISO 시각)",
    !!st?.lastFetchAt && !Number.isNaN(Date.parse(st.lastFetchAt)),
    st?.lastFetchAt || "(null)",
  );
  const ageMs = st?.lastFetchAt ? Date.now() - Date.parse(st.lastFetchAt) : Infinity;
  r.check("lastFetchAt 이 방금(<60s)", ageMs < 60000, `${Math.round(ageMs / 1000)}s 전`);
  r.check("fetchError 없음(정상 fetch)", st?.fetchError == null, st?.fetchError || "");

  // ── force=false 경로(포커스 트리거) — 60초 스로틀 no-op이어도 커맨드는 성공해야 한다 ──
  const throttled = await cdp.try("refresh_remotes", { projectIds: [fix.projectId], force: false });
  r.check("refresh_remotes(no-force): 성공(스로틀 no-op 허용)", throttled.ok, throttled.code || "");

  // ── 뒷정리: pull 로 behind 해소(다른 검증·teardown 오염 방지). 위 호출의 배경 fetch가
  //    op 락을 잠깐 쥘 수 있어 OP_IN_PROGRESS 는 짧게 재시도한다. ──
  let pull = null;
  for (let i = 0; i < 3; i++) {
    pull = await cdp.try("pull", { projectId: fix.projectId }, { timeoutMs: 60000 });
    if (pull.ok || pull.code !== "OP_IN_PROGRESS") break;
    await sleep(1000);
  }
  r.check("정리: pull 로 behind 해소", pull?.ok === true, pull?.code || pull?.message || "");
  const after = await statusOf(cdp, fix.projectId);
  r.check("정리 후 behind=0", (after?.behind || 0) === 0, `behind=${after?.behind}`);
}
